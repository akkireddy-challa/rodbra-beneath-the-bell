/**
 * CloudSaveSync — mirrors a signed-in player's GamePersistence slots to the
 * account (api-server /api/play/saves) so saves survive a browser reset and
 * follow the player to another device. Guests are untouched: with no play
 * token nothing leaves the browser, exactly as before.
 *
 * Game code never sees this layer. localStorage stays the synchronous source
 * every read comes from; this class only (1) reconciles localStorage with the
 * account once at startup — before genre code runs — and (2) pushes later
 * writes in the background. Everything network-related degrades silently to
 * "localStorage only"; nothing here may ever disrupt gameplay or hold game
 * start beyond the gate cap.
 *
 * Three policies decide what players experience (see the plan in
 * docs/superpowers — summarised here because they are the whole design):
 *
 *  1. ACCOUNT BINDING. Local data that was never synced with the CURRENT
 *     account is "unbound" (a guest's saves, or a previous account's). On first
 *     contact the cloud wins wherever the account already has a live save for
 *     the slot — the displaced local copy is kept as a local backup — and
 *     unbound saves push only into empty slots. Afterwards, same-account
 *     multi-device sync is plain last-write-wins on clock-corrected times.
 *  2. NO PUSH BEFORE RECONCILE; FORKS RESOLVE CLOUD-WINS. A slot is never
 *     pushed until a reconcile plan has run this session. A slot the game
 *     touched (read or wrote) before the plan ran, where the cloud holds a
 *     version this device never had, is FORKED: nothing is pushed or pulled
 *     for it this session, and the next boot resolves it cloud-wins with a
 *     backup. A cold device that missed the gate can therefore never wipe a
 *     long cloud save with a fresh default state.
 *  3. TOMBSTONES. A delete is a write at its own timestamp; the server keeps
 *     it as a tombstone (minimum 90 days) so an offline device's older copy
 *     cannot resurrect the slot.
 *
 * Pure/impure split, like PlayerIdentity: `planReconcile` and the journal are
 * pure and unit-tested; the class wires timers, fetches and DOM events.
 */

import type { StorageAdapter } from 'engine/persistence/StorageAdapter.js';
import { CloudSyncAdapter } from 'engine/persistence/CloudSyncAdapter.js';
import type { CloudSaveClient, ServerSaveIndexEntry } from 'engine/persistence/CloudSaveClient.js';

/** The four calls the sync layer makes — CloudSaveClient, or a stand-in in tests. */
export type CloudSaveTransport = Pick<CloudSaveClient, 'list' | 'get' | 'put' | 'del'>;

// ════════════════════════════════════════════════════════════════════════════
// Options / constants
// ════════════════════════════════════════════════════════════════════════════

export interface CloudSaveSyncOptions {
    /** Longest the engine waits for the startup reconcile before genre code runs. */
    gateMs: number;
    /** Quiet time after a local write before it is pushed. */
    debounceMs: number;
    /** Bodies above this are not flushed with keepalive (browsers cap keepalive at 64KB). */
    keepaliveMaxBytes: number;
    /** How often a guest re-asks for a token (mid-session sign-in). */
    guestRetryMs: number;
    /** Cap on the index request during reconcile. */
    listTimeoutMs: number;
}

export const DEFAULT_CLOUD_SAVE_SYNC_OPTIONS: CloudSaveSyncOptions = {
    gateMs: 4_000,
    debounceMs: 2_500,
    keepaliveMaxBytes: 60 * 1024,
    guestRetryMs: 60_000,
    listTimeoutMs: 4_000,
};

/**
 * Slots that never sync. Ghost racing keeps its own GamePersistence over a bare
 * LocalStorageAdapter (installGhostRacing.ts), so its writes never reach this
 * layer's hooks — but reconcile enumerates PHYSICAL keys, which share the
 * `bm-save-<gameId>:` prefix. `ghost-identity` is a device-bound bearer
 * credential that must not cross devices, `ghost-local-runs` is replay bulk,
 * and ghosts already have their own server lane.
 */
export const CLOUD_SYNC_EXCLUDED_SLOT_PREFIXES: readonly string[] = ['ghost-'];

export function isCloudSyncedSlot(slot: string): boolean {
    return !CLOUD_SYNC_EXCLUDED_SLOT_PREFIXES.some((p) => slot.startsWith(p));
}

// ════════════════════════════════════════════════════════════════════════════
// Journal (pure)
// ════════════════════════════════════════════════════════════════════════════

/** What this device last agreed with the server about a slot. */
export interface SyncedMark {
    /** The envelope's own savedAt (this device's raw clock, or the origin device's for a pulled copy). */
    raw: number;
    /** The server's saved_at for that same version. */
    server: number;
}

export interface SyncJournal {
    /** accountKey the entries below belong to; null until the first contact. */
    boundTo: string | null;
    synced: Record<string, SyncedMark>;
    /** Local deletions (raw deletedAt) not yet confirmed by the server. */
    tombstones: Record<string, number>;
    /** Slots deferred to the next boot (policy 2). */
    forked: Record<string, true>;
}

export interface JournalStore {
    load(): SyncJournal;
    store(journal: SyncJournal): void;
}

export function emptyJournal(boundTo: string | null = null): SyncJournal {
    return { boundTo, synced: {}, tombstones: {}, forked: {} };
}

function isJournal(value: unknown): value is SyncJournal {
    if (!value || typeof value !== 'object') return false;
    const j = value as Record<string, unknown>;
    return (j.boundTo === null || typeof j.boundTo === 'string')
        && typeof j.synced === 'object' && j.synced !== null
        && typeof j.tombstones === 'object' && j.tombstones !== null
        && typeof j.forked === 'object' && j.forked !== null;
}

export const JOURNAL_KEY_PREFIX = 'bm-cloudsync-';
export const BACKUP_KEY_PREFIX = 'bm-cloudsync-backup-';

/** Journal persisted in raw localStorage, outside the `bm-save-` scan. */
export function createLocalStorageJournalStore(gameId: string): JournalStore {
    const key = JOURNAL_KEY_PREFIX + gameId;
    return {
        load(): SyncJournal {
            try {
                const raw = localStorage.getItem(key);
                if (raw === null) return emptyJournal();
                const parsed: unknown = JSON.parse(raw);
                return isJournal(parsed) ? parsed : emptyJournal();
            } catch {
                return emptyJournal();
            }
        },
        store(journal: SyncJournal): void {
            try {
                localStorage.setItem(key, JSON.stringify(journal));
            } catch {
                // Journal loss only costs a redundant push later.
            }
        },
    };
}

/** Where a displaced local envelope goes when the cloud wins. Never synced, never listed. */
export interface BackupStore {
    write(slot: string, value: string): void;
}

export function createLocalStorageBackupStore(gameId: string): BackupStore {
    return {
        write(slot: string, value: string): void {
            try {
                localStorage.setItem(`${BACKUP_KEY_PREFIX}${gameId}:${slot}`, value);
            } catch {
                // Best effort.
            }
        },
    };
}

// ════════════════════════════════════════════════════════════════════════════
// Reconcile planner (pure)
// ════════════════════════════════════════════════════════════════════════════

export interface LocalSlotState {
    slot: string;
    /** The envelope's savedAt (raw device clock). */
    savedAt: number;
}

export interface ServerSlotState {
    slot: string;
    savedAt: number;
    deleted: boolean;
}

export interface ReconcileInput {
    local: LocalSlotState[];
    server: ServerSlotState[];
    journal: SyncJournal;
    /** Slots the game has already read or written this session. */
    touched: ReadonlySet<string>;
    /** serverNow − Date.now(); added to raw local times before comparing with server times. */
    offset: number;
}

export interface ReconcilePlan {
    /** Fetch the server copy and write it locally (backing up any local copy). */
    pulls: string[];
    /** Push the local envelope. */
    pushes: string[];
    /** Push a tombstone (journal.tombstones holds the raw deletedAt). */
    deletes: string[];
    /** Remove the local copy — the server deleted it more recently. */
    localRemoves: string[];
    /** Deferred to the next boot: touched here, but the cloud holds a version this device lacks. */
    forked: string[];
    /** The journal after the plan's own bookkeeping (pushes/pulls update it on completion). */
    journal: SyncJournal;
}

/**
 * Decide, per slot, what reconciles localStorage with the account. Pure:
 * takes the two indexes and the journal, returns the actions and the updated
 * journal. See the policy summary at the top of the file.
 */
export function planReconcile(input: ReconcileInput): ReconcilePlan {
    const { local, server, touched, offset } = input;
    const journal: SyncJournal = {
        boundTo: input.journal.boundTo,
        synced: { ...input.journal.synced },
        tombstones: { ...input.journal.tombstones },
        forked: { ...input.journal.forked },
    };
    const plan: ReconcilePlan = { pulls: [], pushes: [], deletes: [], localRemoves: [], forked: [], journal };

    const localBySlot = new Map(local.map((l) => [l.slot, l]));
    const serverBySlot = new Map(server.map((s) => [s.slot, s]));
    const slots = new Set<string>([
        ...localBySlot.keys(), ...serverBySlot.keys(),
        ...Object.keys(journal.synced), ...Object.keys(journal.tombstones), ...Object.keys(journal.forked),
    ]);

    /** A pull or local removal is only safe for an untouched slot; otherwise defer. */
    const pullOrFork = (slot: string, action: 'pulls' | 'localRemoves'): void => {
        if (touched.has(slot)) {
            plan.forked.push(slot);
            journal.forked[slot] = true;
            delete journal.synced[slot];
            delete journal.tombstones[slot];
        } else {
            plan[action].push(slot);
            delete journal.forked[slot];
            delete journal.tombstones[slot];
        }
    };

    for (const slot of [...slots].sort()) {
        const L = localBySlot.get(slot) ?? null;
        const S = serverBySlot.get(slot) ?? null;
        const wasForked = journal.forked[slot] === true;
        const synced = wasForked ? undefined : journal.synced[slot];
        const tombstone = wasForked ? undefined : journal.tombstones[slot];
        const bound = synced !== undefined || tombstone !== undefined;
        // A forked slot is resolved fresh this boot: treat it as unbound.
        if (wasForked) { delete journal.synced[slot]; delete journal.tombstones[slot]; }

        if (L !== null) {
            // A write after a local delete supersedes the delete.
            delete journal.tombstones[slot];
            if (S === null) {
                plan.pushes.push(slot);
                delete journal.forked[slot];
            } else if (!bound) {
                // Unbound local data: cloud wins where the account has a live save;
                // a tombstone or nothing means the local content goes up.
                if (S.deleted) { plan.pushes.push(slot); delete journal.forked[slot]; }
                else pullOrFork(slot, 'pulls');
            } else {
                const localChanged = synced === undefined || L.savedAt !== synced.raw;
                const serverChanged = synced === undefined || S.savedAt !== synced.server;
                if (!localChanged && !serverChanged) {
                    delete journal.forked[slot];
                } else if (localChanged && !serverChanged) {
                    plan.pushes.push(slot);
                } else if (!localChanged && serverChanged) {
                    pullOrFork(slot, S.deleted ? 'localRemoves' : 'pulls');
                } else if (L.savedAt + offset >= S.savedAt) {
                    plan.pushes.push(slot);
                } else {
                    pullOrFork(slot, S.deleted ? 'localRemoves' : 'pulls');
                }
            }
            continue;
        }

        // No local envelope.
        if (tombstone !== undefined) {
            if (S === null || S.deleted) {
                // Nothing (left) to delete server-side.
                delete journal.tombstones[slot];
                delete journal.synced[slot];
            } else if (tombstone + offset >= S.savedAt) {
                plan.deletes.push(slot);
            } else {
                // The server saved this slot after the local delete: it comes back.
                pullOrFork(slot, 'pulls');
            }
            continue;
        }
        delete journal.synced[slot];
        if (S !== null && !S.deleted) pullOrFork(slot, 'pulls');
        else delete journal.forked[slot];
    }

    return plan;
}

// ════════════════════════════════════════════════════════════════════════════
// Orchestrator (runtime-verified; timers/fetch/DOM)
// ════════════════════════════════════════════════════════════════════════════

export interface CloudSaveSyncDeps {
    /** The raw local adapter. Pulls, backups and enumeration go straight to it. */
    inner: StorageAdapter;
    gameId: string;
    client: CloudSaveTransport;
    /** PlayerIdentity.getPlayerToken — null means guest; never rejects. */
    getPlayerToken: () => Promise<string | null>;
    /** Whether a play-auth bridge exists at all (PLAY_AUTH_URL non-empty). No bridge: no guest re-ask. */
    hasBridge: boolean;
    /**
     * Who the store belongs to: a signed-in account (api-server), or the local
     * player on localhost (LocalAccountTransport). Only labels and status differ.
     */
    identity: SyncIdentity;
    journal: JournalStore;
    backup: BackupStore;
    now: () => number;
    options: CloudSaveSyncOptions;
}

type DirtyKind = 'write' | 'delete';

interface DirtyEntry {
    kind: DirtyKind;
    /** Bumped on every local change so a completing push can tell whether it is still current. */
    generation: number;
}

/** Where saves are mirrored to. */
export type SyncIdentity =
    | { kind: 'account' }
    | { kind: 'local'; id: string };

/** Who the saves belong to, as the creator's Save Data Inspector shows it. */
export interface SyncPlayer {
    kind: 'account' | 'local' | 'guest';
    /** accountKey / local player id; null for a guest. */
    id: string | null;
}

export interface CloudSaveSyncStatus {
    settled: boolean;
    mode: 'pending' | 'guest' | 'synced' | 'offline';
    boundTo: string | null;
    offset: number;
    forked: string[];
    dirty: string[];
    player: SyncPlayer;
}

/** Structural view of a parsed SaveEnvelope — only the fields the sync layer reads. */
interface EnvelopeHead {
    gameId: string;
    slot: string;
    savedAt: number;
    version: number;
}

function parseEnvelopeHead(value: string): EnvelopeHead | null {
    try {
        const parsed: unknown = JSON.parse(value);
        if (!parsed || typeof parsed !== 'object') return null;
        const e = parsed as Record<string, unknown>;
        if (typeof e.gameId !== 'string' || typeof e.slot !== 'string' || typeof e.savedAt !== 'number' || !Number.isFinite(e.savedAt)) return null;
        return { gameId: e.gameId, slot: e.slot, savedAt: e.savedAt, version: typeof e.version === 'number' ? e.version : 1 };
    } catch {
        return null;
    }
}

function byteLength(value: string): number {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).length;
    return value.length * 2;
}

export class CloudSaveSync {
    readonly adapter: CloudSyncAdapter;

    private readonly prefix: string;
    private offset = 0;
    private settled = false;
    private mode: CloudSaveSyncStatus['mode'] = 'pending';
    private settledResolve: (() => void) | null = null;
    private readonly settledPromise: Promise<void>;
    /** Pushes are refused until a reconcile plan has been applied this session. */
    private planApplied = false;
    private readonly dirty = new Map<string, DirtyEntry>();
    private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly forkedThisSession = new Set<string>();
    private readonly oversize = new Set<string>();
    private guestTimer: ReturnType<typeof setInterval> | null = null;
    private reconciling = false;
    private stopped = false;
    private generation = 0;
    private listenersBound = false;

    constructor(private readonly deps: CloudSaveSyncDeps) {
        this.prefix = `${deps.gameId}:`;
        this.settledPromise = new Promise<void>((resolve) => { this.settledResolve = resolve; });
        this.adapter = new CloudSyncAdapter(deps.inner, deps.gameId, {
            onWrite: (slot, value) => this.onLocalWrite(slot, value),
            onDelete: (slot) => this.onLocalDelete(slot),
        });
    }

    // ── lifecycle ──────────────────────────────────────────────────────────

    /** Kick off the token handshake + startup reconcile. Idempotent. */
    start(): void {
        if (this.stopped) return;
        this.bindPageListeners();
        void this.run();
    }

    /**
     * Resolves once the startup plan is applied locally (pulls written, removals
     * done) — NOT when pushes finish — or after `capMs`, whichever is first.
     * Never rejects.
     */
    whenSettled(capMs: number): Promise<void> {
        if (this.settled) return Promise.resolve();
        return new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                if (!this.settled) console.warn(`[CloudSave] gate expired after ${capMs}ms — starting local-only; reconcile continues in the background`);
                resolve();
            }, capMs);
            void this.settledPromise.then(() => { clearTimeout(timer); resolve(); });
        });
    }

    /** Flush dirty slots now. With keepalive the requests may outlive the page. */
    flushNow(options: { keepalive: boolean }): void {
        for (const slot of [...this.dirty.keys()]) {
            this.cancelTimer(slot);
            void this.flushSlot(slot, options.keepalive);
        }
    }

    /** Stop timers and listeners and push whatever is still dirty. Idempotent. */
    dispose(): void {
        if (this.stopped) return;
        this.stopped = true;
        if (this.guestTimer !== null) { clearInterval(this.guestTimer); this.guestTimer = null; }
        this.unbindPageListeners();
        this.flushNow({ keepalive: false });
        for (const slot of [...this.timers.keys()]) this.cancelTimer(slot);
        this.settle('offline');
    }

    getStatus(): CloudSaveSyncStatus {
        const boundTo = this.deps.journal.load().boundTo;
        const identity = this.deps.identity;
        const player: SyncPlayer = identity.kind === 'local'
            ? { kind: 'local', id: identity.id }
            : this.mode === 'synced' && boundTo !== null
                ? { kind: 'account', id: boundTo }
                : { kind: 'guest', id: null };
        return {
            settled: this.settled,
            mode: this.mode,
            boundTo,
            offset: this.offset,
            forked: [...this.forkedThisSession],
            dirty: [...this.dirty.keys()],
            player,
        };
    }

    /**
     * Stop WITHOUT flushing: timers, listeners and dirty slots are dropped on
     * the floor. For "reset the player" — the store is about to be wiped, and a
     * parting push would write the very data being erased.
     */
    abandon(): void {
        if (this.stopped) return;
        this.stopped = true;
        if (this.guestTimer !== null) { clearInterval(this.guestTimer); this.guestTimer = null; }
        this.unbindPageListeners();
        for (const slot of [...this.timers.keys()]) this.cancelTimer(slot);
        this.dirty.clear();
        this.settle('offline');
    }

    // ── startup / reconcile ────────────────────────────────────────────────

    private settle(mode: CloudSaveSyncStatus['mode']): void {
        if (this.settled) return;
        this.settled = true;
        this.mode = mode;
        this.settledResolve?.();
    }

    private async run(): Promise<void> {
        const token = await this.deps.getPlayerToken();
        if (this.stopped) return;
        if (!token) {
            this.settle('guest');
            console.info('[CloudSave] guest — saves stay in this browser');
            if (this.deps.hasBridge) this.armGuestRetry();
            return;
        }
        await this.reconcile(token, 'startup');
    }

    /** Re-ask for a token periodically so a sign-in in another tab starts syncing without a reload. */
    private armGuestRetry(): void {
        if (this.guestTimer !== null) return;
        this.guestTimer = setInterval(() => {
            void this.deps.getPlayerToken().then((token) => {
                if (!token || this.stopped || this.reconciling) return;
                if (this.guestTimer !== null) { clearInterval(this.guestTimer); this.guestTimer = null; }
                void this.reconcile(token, 'sign-in');
            });
        }, this.deps.options.guestRetryMs);
    }

    private listWithTimeout(token: string): ReturnType<CloudSaveTransport['list']> {
        return Promise.race([
            this.deps.client.list(token),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), this.deps.options.listTimeoutMs)),
        ]);
    }

    /** Local slots eligible for sync: parsed envelopes under this game's prefix, ghost slots excluded. */
    private localStates(): { states: LocalSlotState[]; values: Map<string, string> } {
        const states: LocalSlotState[] = [];
        const values = new Map<string, string>();
        for (const key of this.deps.inner.listKeys(this.prefix)) {
            const slot = key.slice(this.prefix.length);
            if (!isCloudSyncedSlot(slot)) continue;
            const value = this.deps.inner.getItem(key);
            if (value === null) continue;
            const head = parseEnvelopeHead(value);
            if (!head) continue; // Unparseable local data cannot be synced; leave it alone.
            states.push({ slot, savedAt: head.savedAt });
            values.set(slot, value);
        }
        return { states, values };
    }

    private async reconcile(token: string, reason: 'startup' | 'sign-in'): Promise<void> {
        if (this.reconciling) return;
        this.reconciling = true;
        const startedAt = this.deps.now();
        try {
            const index = await this.listWithTimeout(token);
            if (this.stopped) return;
            if (!index) {
                console.warn(`[CloudSave] ${reason}: account index unavailable — local-only until it answers`);
                this.settle('offline');
                if (this.deps.hasBridge) this.armGuestRetry();
                return;
            }
            this.offset = index.serverNow - this.deps.now();

            let journal = this.deps.journal.load();
            const rebound = journal.boundTo !== index.accountKey;
            if (rebound) journal = emptyJournal(index.accountKey);

            const { states: local, values } = this.localStates();
            const server: ServerSlotState[] = index.saves
                .filter((s: ServerSaveIndexEntry) => isCloudSyncedSlot(s.slot))
                .map((s: ServerSaveIndexEntry) => ({ slot: s.slot, savedAt: s.savedAt, deleted: s.deleted }));

            const plan = planReconcile({ local, server, journal, touched: this.adapter.touchedSlots(), offset: this.offset });
            journal = plan.journal;

            // Pulls and removals — the part the gate waits for.
            await Promise.all(plan.pulls.map((slot) => this.pullSlot(token, slot, journal, values.get(slot) ?? null)));
            for (const slot of plan.localRemoves) {
                const current = values.get(slot);
                if (current !== undefined) this.deps.backup.write(slot, current);
                try { this.deps.inner.removeItem(this.prefix + slot); } catch { /* best effort */ }
                delete journal.synced[slot];
            }
            for (const slot of plan.forked) {
                this.forkedThisSession.add(slot);
                this.dirty.delete(slot);
                this.cancelTimer(slot);
            }
            this.deps.journal.store(journal);
            this.planApplied = true;

            // Queue the uploads; they run after settle.
            for (const slot of plan.pushes) this.markDirty(slot, 'write');
            for (const slot of plan.deletes) this.markDirty(slot, 'delete');

            const ms = this.deps.now() - startedAt;
            const who = this.deps.identity.kind === 'local'
                ? `local player ${this.deps.identity.id} (saves persist in this browser; reset via the Save Data Inspector)`
                : rebound ? 'bound to account' : 'account';
            console.info(`[CloudSave] ${reason}: ${who} in ${ms}ms — pulls ${plan.pulls.length}, pushes ${plan.pushes.length}, deletes ${plan.deletes.length}, removed ${plan.localRemoves.length}${plan.forked.length ? `, FORKED ${plan.forked.join(', ')}` : ''}`);
            if (plan.forked.length) {
                console.warn(`[CloudSave] ${plan.forked.length} slot(s) were in use before the account copy arrived; they stay local this session and the account copy wins next boot (local copy backed up): ${plan.forked.join(', ')}`);
            }
            this.settle('synced');
            for (const slot of [...this.dirty.keys()]) void this.flushSlot(slot, false);
        } finally {
            this.reconciling = false;
            if (!this.settled) this.settle('offline');
        }
    }

    /** Fetch one slot and write it into localStorage verbatim (after validation), backing up any local copy. */
    private async pullSlot(token: string, slot: string, journal: SyncJournal, localValue: string | null): Promise<void> {
        const save = await this.deps.client.get(token, slot);
        if (this.stopped || !save || save === 'missing' || save.deleted || save.payload === null) return;
        const head = parseEnvelopeHead(save.payload);
        if (!head || head.gameId !== this.deps.gameId || head.slot !== slot) {
            console.warn(`[CloudSave] ignoring account copy of '${slot}': not a valid envelope for this game`);
            return;
        }
        // The game may have touched the slot while the fetch was in flight.
        if (this.adapter.hasTouched(slot)) {
            this.forkedThisSession.add(slot);
            journal.forked[slot] = true;
            return;
        }
        if (localValue !== null) this.deps.backup.write(slot, localValue);
        try {
            this.deps.inner.setItem(this.prefix + slot, save.payload);
        } catch {
            return;
        }
        journal.synced[slot] = { raw: head.savedAt, server: save.savedAt };
        delete journal.tombstones[slot];
        delete journal.forked[slot];
    }

    // ── local change hooks ─────────────────────────────────────────────────

    private onLocalWrite(slot: string, _value: string): void {
        if (!isCloudSyncedSlot(slot)) return;
        try {
            const journal = this.deps.journal.load();
            if (journal.tombstones[slot] !== undefined) {
                delete journal.tombstones[slot];
                this.deps.journal.store(journal);
            }
            this.oversize.delete(slot);
            if (this.forkedThisSession.has(slot)) return;
            this.markDirty(slot, 'write');
            this.scheduleFlush(slot);
        } catch {
            // Sync bookkeeping must never surface into game code.
        }
    }

    private onLocalDelete(slot: string): void {
        if (!isCloudSyncedSlot(slot)) return;
        try {
            const journal = this.deps.journal.load();
            journal.tombstones[slot] = this.deps.now();
            delete journal.synced[slot];
            this.deps.journal.store(journal);
            if (this.forkedThisSession.has(slot)) return;
            this.markDirty(slot, 'delete');
            this.scheduleFlush(slot);
        } catch {
            // As above.
        }
    }

    private markDirty(slot: string, kind: DirtyKind): void {
        this.dirty.set(slot, { kind, generation: ++this.generation });
    }

    private scheduleFlush(slot: string): void {
        if (!this.planApplied || this.stopped) return;
        this.cancelTimer(slot);
        this.timers.set(slot, setTimeout(() => {
            this.timers.delete(slot);
            void this.flushSlot(slot, false);
        }, this.deps.options.debounceMs));
    }

    private cancelTimer(slot: string): void {
        const timer = this.timers.get(slot);
        if (timer !== undefined) { clearTimeout(timer); this.timers.delete(slot); }
    }

    // ── push path ──────────────────────────────────────────────────────────

    private async flushSlot(slot: string, keepalive: boolean): Promise<void> {
        const entry = this.dirty.get(slot);
        if (!entry || !this.planApplied || this.forkedThisSession.has(slot)) return;
        const token = await this.deps.getPlayerToken();
        if (!token) return; // Still dirty; a later flush or the next boot will push it.
        if (this.dirty.get(slot) !== entry) return; // superseded by a newer local change while awaiting the token

        if (entry.kind === 'delete') {
            const journal = this.deps.journal.load();
            const deletedAt = journal.tombstones[slot];
            if (deletedAt === undefined) { this.clearDirty(slot, entry); return; }
            const res = await this.deps.client.del(token, slot, deletedAt + this.offset, { keepalive });
            this.afterWrite(slot, entry, res, null);
            return;
        }

        const value = this.deps.inner.getItem(this.prefix + slot);
        if (value === null) { this.clearDirty(slot, entry); return; }
        const head = parseEnvelopeHead(value);
        if (!head) { this.clearDirty(slot, entry); return; }
        if (keepalive && byteLength(value) > this.deps.options.keepaliveMaxBytes) {
            console.warn(`[CloudSave] '${slot}' is too large for a keepalive flush; it will upload on the next visit`);
            return;
        }
        const res = await this.deps.client.put(token, slot, {
            savedAt: head.savedAt + this.offset, version: head.version, payload: value,
        }, { keepalive });
        this.afterWrite(slot, entry, res, head);
    }

    private clearDirty(slot: string, entry: DirtyEntry): void {
        if (this.dirty.get(slot) === entry) this.dirty.delete(slot);
    }

    private afterWrite(
        slot: string,
        entry: DirtyEntry,
        res: Awaited<ReturnType<CloudSaveTransport['put']>>,
        head: EnvelopeHead | null,
    ): void {
        if (!res) return; // Network failure: stays dirty.
        if (res.serverNow !== null) this.offset = res.serverNow - this.deps.now();
        if (res.status === 429) {
            const retryMs = Math.max(1_000, (res.retryAfterSeconds ?? 5) * 1_000);
            console.warn(`[CloudSave] rate limited; retrying '${slot}' in ${Math.round(retryMs / 1000)}s`);
            this.cancelTimer(slot);
            this.timers.set(slot, setTimeout(() => { this.timers.delete(slot); void this.flushSlot(slot, false); }, retryMs));
            return;
        }
        if (res.status === 413) {
            if (!this.oversize.has(slot)) {
                this.oversize.add(slot);
                console.warn(`[CloudSave] '${slot}' exceeds the account save size limit and stays in this browser only`);
            }
            this.clearDirty(slot, entry);
            return;
        }
        if (res.status < 200 || res.status >= 300) {
            // 4xx we cannot fix by retrying (slot limit, bad envelope…): drop it, keep local.
            if (res.status >= 400 && res.status < 500) {
                console.warn(`[CloudSave] account refused '${slot}' (${res.status}); it stays in this browser only`);
                this.clearDirty(slot, entry);
            }
            return;
        }
        if (res.stale) {
            // Another device wrote this slot more recently. We just wrote it too,
            // so it is touched by definition: fork it, resolve next boot.
            this.forkedThisSession.add(slot);
            const journal = this.deps.journal.load();
            journal.forked[slot] = true;
            delete journal.synced[slot];
            delete journal.tombstones[slot];
            this.deps.journal.store(journal);
            this.clearDirty(slot, entry);
            console.warn(`[CloudSave] '${slot}' was saved more recently on another device; this session's copy stays local and the account copy wins next boot`);
            return;
        }
        const journal = this.deps.journal.load();
        if (head) {
            journal.synced[slot] = { raw: head.savedAt, server: head.savedAt + this.offset };
            delete journal.tombstones[slot];
        } else {
            delete journal.tombstones[slot];
            delete journal.synced[slot];
        }
        this.deps.journal.store(journal);
        this.clearDirty(slot, entry);
    }

    // ── page lifecycle ─────────────────────────────────────────────────────

    private readonly onPageHide = (): void => { this.flushNow({ keepalive: true }); };
    private readonly onVisibility = (): void => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') this.flushNow({ keepalive: true });
    };

    private bindPageListeners(): void {
        if (this.listenersBound || typeof window === 'undefined') return;
        window.addEventListener('pagehide', this.onPageHide);
        window.addEventListener('beforeunload', this.onPageHide);
        document.addEventListener('visibilitychange', this.onVisibility);
        this.listenersBound = true;
    }

    private unbindPageListeners(): void {
        if (!this.listenersBound || typeof window === 'undefined') return;
        window.removeEventListener('pagehide', this.onPageHide);
        window.removeEventListener('beforeunload', this.onPageHide);
        document.removeEventListener('visibilitychange', this.onVisibility);
        this.listenersBound = false;
    }
}
