/**
 * Account-backed save sync: the reconcile planner's policy table and the
 * orchestrator's runtime behaviour (gate, debounce, fork, flush) with a fake
 * transport, a memory adapter, and fake timers.
 */

import { jest } from '@jest/globals';
import type { StorageAdapter } from 'engine/persistence/StorageAdapter.js';
import { GamePersistence } from 'engine/persistence/GamePersistence.js';
import type { CloudWriteResult, ServerSave, ServerSaveIndex } from 'engine/persistence/CloudSaveClient.js';
import {
    CloudSaveSync,
    DEFAULT_CLOUD_SAVE_SYNC_OPTIONS,
    emptyJournal,
    planReconcile,
    type CloudSaveTransport,
    type JournalStore,
    type SyncJournal,
} from 'engine/persistence/CloudSaveSync.js';

const GAME = 'GAME12345678';

// ════════════════════════════════════════════════════════════════════════════
// planReconcile
// ════════════════════════════════════════════════════════════════════════════

function plan(over: {
    local?: { slot: string; savedAt: number }[];
    server?: { slot: string; savedAt: number; deleted?: boolean }[];
    journal?: Partial<SyncJournal>;
    touched?: string[];
    offset?: number;
}) {
    return planReconcile({
        local: over.local ?? [],
        server: (over.server ?? []).map((s) => ({ slot: s.slot, savedAt: s.savedAt, deleted: s.deleted === true })),
        journal: { ...emptyJournal('acct'), ...over.journal },
        touched: new Set(over.touched ?? []),
        offset: over.offset ?? 0,
    });
}

const actions = (p: ReturnType<typeof plan>) => ({
    pulls: p.pulls, pushes: p.pushes, deletes: p.deletes, localRemoves: p.localRemoves, forked: p.forked,
});
const none = { pulls: [], pushes: [], deletes: [], localRemoves: [], forked: [] };

describe('planReconcile — unbound local data (first contact with an account)', () => {
    it('pushes into an empty slot', () => {
        expect(actions(plan({ local: [{ slot: 'a', savedAt: 10 }] }))).toEqual({ ...none, pushes: ['a'] });
    });

    it('cloud wins over unbound local data when the account already has a live save', () => {
        const p = plan({ local: [{ slot: 'a', savedAt: 999 }], server: [{ slot: 'a', savedAt: 5 }] });
        expect(actions(p)).toEqual({ ...none, pulls: ['a'] });
    });

    it('new content beats an old account tombstone', () => {
        const p = plan({ local: [{ slot: 'a', savedAt: 1 }], server: [{ slot: 'a', savedAt: 999, deleted: true }] });
        expect(actions(p)).toEqual({ ...none, pushes: ['a'] });
    });

    it('forks instead of pulling when the game already touched the slot', () => {
        const p = plan({ local: [{ slot: 'a', savedAt: 1 }], server: [{ slot: 'a', savedAt: 5 }], touched: ['a'] });
        expect(actions(p)).toEqual({ ...none, forked: ['a'] });
        expect(p.journal.forked).toEqual({ a: true });
    });

    it('a forked slot resolves cloud-wins on the next boot and the mark clears', () => {
        const p = plan({
            local: [{ slot: 'a', savedAt: 50 }], server: [{ slot: 'a', savedAt: 5 }],
            journal: { forked: { a: true }, synced: { a: { raw: 50, server: 50 } } },
        });
        expect(actions(p)).toEqual({ ...none, pulls: ['a'] });
        expect(p.journal.forked).toEqual({});
    });
});

describe('planReconcile — bound slots (same account, last-write-wins)', () => {
    const inSync = { synced: { a: { raw: 10, server: 10 } } };

    it('does nothing when neither side changed', () => {
        const p = plan({ local: [{ slot: 'a', savedAt: 10 }], server: [{ slot: 'a', savedAt: 10 }], journal: inSync });
        expect(actions(p)).toEqual(none);
    });

    it('pushes a local-only change', () => {
        const p = plan({ local: [{ slot: 'a', savedAt: 20 }], server: [{ slot: 'a', savedAt: 10 }], journal: inSync });
        expect(actions(p)).toEqual({ ...none, pushes: ['a'] });
    });

    it('pulls a server-only change (another device wrote)', () => {
        const p = plan({ local: [{ slot: 'a', savedAt: 10 }], server: [{ slot: 'a', savedAt: 30 }], journal: inSync });
        expect(actions(p)).toEqual({ ...none, pulls: ['a'] });
    });

    it('a device that already had the cloud version is never forked by a slow network', () => {
        const p = plan({ local: [{ slot: 'a', savedAt: 10 }], server: [{ slot: 'a', savedAt: 10 }], journal: inSync, touched: ['a'] });
        expect(actions(p)).toEqual(none);
    });

    it('resolves a two-sided change by corrected timestamps', () => {
        const localNewer = plan({ local: [{ slot: 'a', savedAt: 40 }], server: [{ slot: 'a', savedAt: 30 }], journal: inSync });
        expect(actions(localNewer)).toEqual({ ...none, pushes: ['a'] });
        const serverNewer = plan({ local: [{ slot: 'a', savedAt: 25 }], server: [{ slot: 'a', savedAt: 30 }], journal: inSync });
        expect(actions(serverNewer)).toEqual({ ...none, pulls: ['a'] });
        // A device whose clock runs 100ms behind the server still wins with offset applied.
        const skewed = plan({ local: [{ slot: 'a', savedAt: 25 }], server: [{ slot: 'a', savedAt: 30 }], journal: inSync, offset: 100 });
        expect(actions(skewed)).toEqual({ ...none, pushes: ['a'] });
    });

    it('removes the local copy when the server deleted it more recently (fork if touched)', () => {
        const p = plan({ local: [{ slot: 'a', savedAt: 10 }], server: [{ slot: 'a', savedAt: 50, deleted: true }], journal: inSync });
        expect(actions(p)).toEqual({ ...none, localRemoves: ['a'] });
        const t = plan({ local: [{ slot: 'a', savedAt: 10 }], server: [{ slot: 'a', savedAt: 50, deleted: true }], journal: inSync, touched: ['a'] });
        expect(actions(t)).toEqual({ ...none, forked: ['a'] });
    });

    it('a local save newer than the server tombstone un-deletes', () => {
        const p = plan({ local: [{ slot: 'a', savedAt: 60 }], server: [{ slot: 'a', savedAt: 50, deleted: true }], journal: inSync });
        expect(actions(p)).toEqual({ ...none, pushes: ['a'] });
    });

    it('pushes a local tombstone that is newer than the server save, pulls when it is older', () => {
        const newer = plan({ server: [{ slot: 'a', savedAt: 10 }], journal: { tombstones: { a: 20 } } });
        expect(actions(newer)).toEqual({ ...none, deletes: ['a'] });
        const older = plan({ server: [{ slot: 'a', savedAt: 30 }], journal: { tombstones: { a: 20 } } });
        expect(actions(older)).toEqual({ ...none, pulls: ['a'] });
    });

    it('drops a journal tombstone the server never needs', () => {
        const absent = plan({ journal: { tombstones: { a: 20 } } });
        expect(actions(absent)).toEqual(none);
        expect(absent.journal.tombstones).toEqual({});
        const gone = plan({ server: [{ slot: 'a', savedAt: 5, deleted: true }], journal: { tombstones: { a: 20 } } });
        expect(actions(gone)).toEqual(none);
        expect(gone.journal.tombstones).toEqual({});
    });

    it('pulls a slot that is missing locally and clears its stale synced mark', () => {
        const p = plan({ server: [{ slot: 'a', savedAt: 10 }], journal: inSync });
        expect(actions(p)).toEqual({ ...none, pulls: ['a'] });
        const tomb = plan({ server: [{ slot: 'a', savedAt: 10, deleted: true }], journal: inSync });
        expect(actions(tomb)).toEqual(none);
        expect(tomb.journal.synced).toEqual({});
    });

    it('re-pushes a recreated save even with an older timestamp (dirty by inequality)', () => {
        const p = plan({ local: [{ slot: 'a', savedAt: 5 }], server: [{ slot: 'a', savedAt: 10 }], journal: inSync });
        // local raw 5 !== synced.raw 10 → local changed; server unchanged → push.
        expect(actions(p)).toEqual({ ...none, pushes: ['a'] });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// CloudSaveSync runtime
// ════════════════════════════════════════════════════════════════════════════

function memoryAdapter(): StorageAdapter & { store: Map<string, string> } {
    const store = new Map<string, string>();
    return {
        store,
        isAvailable: () => true,
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
        hasItem: (key: string) => store.has(key),
        listKeys: (prefix?: string) => [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)),
    };
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function memoryJournal(initial: SyncJournal = emptyJournal()): JournalStore & { readonly current: SyncJournal } {
    let current = clone(initial);
    return {
        get current() { return current; },
        load: () => clone(current),
        store: (j: SyncJournal) => { current = clone(j); },
    };
}

interface FakeServer {
    accountKey: string;
    rows: Map<string, { savedAt: number; payload: string | null; deleted: boolean }>;
    serverNow: number;
    puts: { slot: string; savedAt: number; payload: string; keepalive: boolean }[];
    dels: { slot: string; deletedAt: number }[];
    listCalls: number;
    /** Per-slot overrides for the next put responses. */
    putResponse: Map<string, Partial<CloudWriteResult>>;
    /** When set, list() answers this instead of the rows (null = unreachable). */
    listResult: ServerSaveIndex | null | 'rows';
    /** When set, list() waits for this before answering (a slow index). */
    listGate: Promise<void> | null;
}

function makeServer(over: Partial<FakeServer> = {}): FakeServer {
    return {
        accountKey: 'acct-1', rows: new Map(), serverNow: 1_000_000, puts: [], dels: [], listCalls: 0,
        putResponse: new Map(), listResult: 'rows', listGate: null, ...over,
    };
}

function fakeTransport(server: FakeServer): CloudSaveTransport {
    const ok = (extra: Partial<CloudWriteResult> = {}): CloudWriteResult => ({
        status: 200, stale: false, serverSavedAt: null, serverNow: server.serverNow, retryAfterSeconds: null, ...extra,
    });
    return {
        async list(): Promise<ServerSaveIndex | null> {
            server.listCalls++;
            if (server.listGate) await server.listGate;
            if (server.listResult !== 'rows') return server.listResult;
            return {
                serverNow: server.serverNow,
                accountKey: server.accountKey,
                saves: [...server.rows.entries()].map(([slot, r]) => ({ slot, savedAt: r.savedAt, version: 1, deleted: r.deleted, size: r.payload?.length ?? 0 })),
            };
        },
        async get(_token: string, slot: string): Promise<ServerSave | 'missing' | null> {
            const r = server.rows.get(slot);
            if (!r) return 'missing';
            return { slot, savedAt: r.savedAt, version: 1, deleted: r.deleted, payload: r.payload };
        },
        async put(_token: string, slot: string, body, options): Promise<CloudWriteResult | null> {
            server.puts.push({ slot, savedAt: body.savedAt, payload: body.payload, keepalive: options.keepalive });
            const override = server.putResponse.get(slot);
            if (override) return ok(override);
            server.rows.set(slot, { savedAt: body.savedAt, payload: body.payload, deleted: false });
            return ok();
        },
        async del(_token: string, slot: string, deletedAt: number): Promise<CloudWriteResult | null> {
            server.dels.push({ slot, deletedAt });
            server.rows.set(slot, { savedAt: deletedAt, payload: null, deleted: true });
            return ok();
        },
    };
}

function envelope(slot: string, savedAt: number, data: unknown = {}, gameId = GAME): string {
    return JSON.stringify({ gameId, version: 1, savedAt, slot, data });
}

interface Harness {
    inner: ReturnType<typeof memoryAdapter>;
    journal: ReturnType<typeof memoryJournal>;
    backups: Map<string, string>;
    server: FakeServer;
    sync: CloudSaveSync;
    persistence: GamePersistence;
    token: { value: string | null };
}

function harness(over: { token?: string | null; server?: FakeServer; journal?: SyncJournal; hasBridge?: boolean; local?: Record<string, string> } = {}): Harness {
    const inner = memoryAdapter();
    for (const [slot, value] of Object.entries(over.local ?? {})) inner.store.set(`${GAME}:${slot}`, value);
    const journal = memoryJournal(over.journal);
    const backups = new Map<string, string>();
    const server = over.server ?? makeServer();
    const token = { value: over.token === undefined ? 'tok' : over.token };
    const sync = new CloudSaveSync({
        inner,
        gameId: GAME,
        client: fakeTransport(server),
        getPlayerToken: async () => token.value,
        hasBridge: over.hasBridge ?? true,
        identity: { kind: 'account' },
        journal,
        backup: { write: (slot, value) => void backups.set(slot, value) },
        now: () => Date.now(),
        options: DEFAULT_CLOUD_SAVE_SYNC_OPTIONS,
    });
    const persistence = new GamePersistence(sync.adapter, GAME, 1);
    persistence.setNotification({ enabled: false });
    return { inner, journal, backups, server, sync, persistence, token };
}

/** Advance fake timers by `ms`, flushing promise chains in between. */
const tick = (ms = 0) => jest.advanceTimersByTimeAsync(ms);

/** Await the gate while letting its cap timer run (the settle path is microtask-only, the cap is a timer). */
async function gate(sync: CloudSaveSync, capMs: number): Promise<void> {
    const p = sync.whenSettled(capMs);
    await tick(capMs + 1);
    await p;
}

const slotData = (h: Harness, slot: string): unknown => JSON.parse(h.inner.store.get(`${GAME}:${slot}`) ?? 'null');

describe('CloudSaveSync', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(1_000);
        jest.spyOn(console, 'info').mockImplementation(() => undefined);
        jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    it('guest: settles at once, never talks to the server, saves stay local', async () => {
        const h = harness({ token: null, hasBridge: false });
        h.sync.start();
        await gate(h.sync, 10);
        expect(h.sync.getStatus().mode).toBe('guest');
        h.persistence.save({ x: 1 }, 'default');
        await tick(10_000);
        expect(h.server.listCalls).toBe(0);
        expect(h.server.puts).toHaveLength(0);
        expect(h.inner.store.has(`${GAME}:default`)).toBe(true);
    });

    it('first bind into an empty account pushes the local save with a clock-corrected timestamp', async () => {
        const h = harness({ local: { default: envelope('default', 500) } });
        h.sync.start();
        await gate(h.sync, 100);
        await tick(0);
        expect(h.sync.getStatus().mode).toBe('synced');
        expect(h.server.puts).toHaveLength(1);
        // serverNow 1_000_000 − Date.now() 1_000 = +999_000 offset (≈ the time the fake clock spent).
        expect(h.server.puts[0].slot).toBe('default');
        expect(h.server.puts[0].keepalive).toBe(false);
        expect(h.server.puts[0].savedAt).toBeGreaterThanOrEqual(500 + 999_000 - 200);
        expect(h.server.puts[0].savedAt).toBeLessThanOrEqual(500 + 999_000);
        expect(h.server.puts[0].payload).toBe(envelope('default', 500));
        expect(h.journal.current.boundTo).toBe('acct-1');
        expect(h.journal.current.synced.default?.raw).toBe(500);
        expect(h.journal.current.synced.default?.server).toBe(h.server.puts[0].savedAt);
    });

    it('first bind against an existing account save: cloud wins, local copy backed up', async () => {
        const server = makeServer();
        server.rows.set('default', { savedAt: 42, payload: envelope('default', 42, { from: 'cloud' }), deleted: false });
        const h = harness({ server, local: { default: envelope('default', 99_999, { from: 'guest' }) } });
        h.sync.start();
        await gate(h.sync, 100);
        expect(h.inner.store.get(`${GAME}:default`)).toBe(envelope('default', 42, { from: 'cloud' }));
        expect(h.backups.get('default')).toBe(envelope('default', 99_999, { from: 'guest' }));
        expect(h.server.puts).toHaveLength(0);
        expect(h.persistence.load<{ from: string }>('default').data).toEqual({ from: 'cloud' });
    });

    it('a different account rebinds: the journal resets and first-bind rules apply', async () => {
        const server = makeServer({ accountKey: 'acct-2' });
        server.rows.set('default', { savedAt: 10, payload: envelope('default', 10, { who: 'B' }), deleted: false });
        const h = harness({
            server,
            local: { default: envelope('default', 500, { who: 'A' }) },
            journal: { boundTo: 'acct-1', synced: { default: { raw: 500, server: 500 } }, tombstones: {}, forked: {} },
        });
        h.sync.start();
        await gate(h.sync, 100);
        expect(h.journal.current.boundTo).toBe('acct-2');
        expect(h.inner.store.get(`${GAME}:default`)).toBe(envelope('default', 10, { who: 'B' }));
        expect(h.backups.get('default')).toBe(envelope('default', 500, { who: 'A' }));
    });

    it('a slot the game read before the plan ran is forked: no pull, no push, cloud wins next boot', async () => {
        let release: () => void = () => undefined;
        const server = makeServer({ listGate: new Promise<void>((resolve) => { release = resolve; }) });
        server.rows.set('default', { savedAt: 42, payload: envelope('default', 42, { hours: 10 }), deleted: false });
        const h = harness({ server });
        h.sync.start();
        await gate(h.sync, 50);                                  // the index is slow: the gate expires
        expect(h.persistence.load('default').data).toBeNull();  // the game reads (touched) and sees nothing…
        h.persistence.save({ hours: 0 }, 'default');             // …and starts fresh
        release();
        await tick(0);
        await tick(10_000);

        expect(h.server.puts).toHaveLength(0);                   // the 10h account save was never clobbered
        expect(slotData(h, 'default')).toMatchObject({ data: { hours: 0 } }); // and nothing was pulled under the game
        expect(h.journal.current.forked).toEqual({ default: true });
        expect(h.sync.getStatus().forked).toEqual(['default']);

        // Next boot: the forked slot resolves cloud-wins with a backup.
        const boot2 = harness({ server: makeServer({ rows: server.rows }), journal: h.journal.current, local: { default: h.inner.store.get(`${GAME}:default`)! } });
        boot2.sync.start();
        await gate(boot2.sync, 100);
        expect(slotData(boot2, 'default')).toMatchObject({ data: { hours: 10 } });
        expect(JSON.parse(boot2.backups.get('default')!)).toMatchObject({ data: { hours: 0 } });
        expect(boot2.journal.current.forked).toEqual({});
    });

    it('does not push before the plan ran, then pushes what the plan decides', async () => {
        let release: () => void = () => undefined;
        const h = harness({ server: makeServer({ listGate: new Promise<void>((resolve) => { release = resolve; }) }) });
        h.sync.start();
        await gate(h.sync, 50);
        h.persistence.save({ n: 1 }, 'early');
        await tick(3_000);
        expect(h.server.puts).toHaveLength(0);
        release();
        await tick(0);
        await tick(10_000);
        // Empty account → the early write goes up once the plan ran.
        expect(h.server.puts.map((p) => p.slot)).toEqual(['early']);
    });

    it('debounces writes after the plan and coalesces bursts into one push', async () => {
        const h = harness();
        h.sync.start();
        await gate(h.sync, 100);
        h.persistence.save({ n: 1 }, 'default');
        h.persistence.save({ n: 2 }, 'default');
        await tick(DEFAULT_CLOUD_SAVE_SYNC_OPTIONS.debounceMs - 100);
        expect(h.server.puts).toHaveLength(0);
        await tick(200);
        expect(h.server.puts).toHaveLength(1);
        expect(JSON.parse(h.server.puts[0].payload)).toMatchObject({ data: { n: 2 } });
        expect(h.sync.getStatus().dirty).toEqual([]);
    });

    it('pushes a delete as a tombstone at its own time', async () => {
        const h = harness({ local: { default: envelope('default', 5) } });
        h.sync.start();
        await gate(h.sync, 100);
        await tick(0);
        h.persistence.deleteSave('default');
        await tick(DEFAULT_CLOUD_SAVE_SYNC_OPTIONS.debounceMs + 10);
        expect(h.server.dels).toHaveLength(1);
        expect(h.server.dels[0].slot).toBe('default');
        expect(h.journal.current.tombstones).toEqual({});
    });

    it('a stale answer forks the slot instead of retrying', async () => {
        const h = harness();
        h.server.putResponse.set('default', { stale: true, serverSavedAt: 9_999_999 });
        h.sync.start();
        await gate(h.sync, 100);
        h.persistence.save({ n: 1 }, 'default');
        await tick(DEFAULT_CLOUD_SAVE_SYNC_OPTIONS.debounceMs + 10);
        expect(h.server.puts).toHaveLength(1);
        expect(h.journal.current.forked).toEqual({ default: true });
        h.persistence.save({ n: 2 }, 'default');
        await tick(DEFAULT_CLOUD_SAVE_SYNC_OPTIONS.debounceMs + 10);
        expect(h.server.puts).toHaveLength(1);
    });

    it('a 413 leaves the save local-only, a 429 retries after the hint', async () => {
        const h = harness();
        h.sync.start();
        await gate(h.sync, 100);

        h.server.putResponse.set('big', { status: 413 });
        h.persistence.save({ n: 1 }, 'big');
        await tick(DEFAULT_CLOUD_SAVE_SYNC_OPTIONS.debounceMs + 10);
        expect(h.server.puts.filter((p) => p.slot === 'big')).toHaveLength(1);
        expect(h.sync.getStatus().dirty).toEqual([]);

        h.server.putResponse.set('busy', { status: 429, retryAfterSeconds: 3 });
        h.persistence.save({ n: 1 }, 'busy');
        await tick(DEFAULT_CLOUD_SAVE_SYNC_OPTIONS.debounceMs + 10);
        expect(h.server.puts.filter((p) => p.slot === 'busy')).toHaveLength(1);
        h.server.putResponse.delete('busy');
        await tick(3_100);
        expect(h.server.puts.filter((p) => p.slot === 'busy')).toHaveLength(2);
        expect(h.sync.getStatus().dirty).toEqual([]);
    });

    it('a keepalive flush skips oversized bodies and keeps them dirty', async () => {
        const h = harness();
        h.sync.start();
        await gate(h.sync, 100);
        h.persistence.save({ blob: 'x'.repeat(DEFAULT_CLOUD_SAVE_SYNC_OPTIONS.keepaliveMaxBytes) }, 'huge');
        h.persistence.save({ n: 1 }, 'small');
        h.sync.flushNow({ keepalive: true });
        await tick(0);
        expect(h.server.puts.map((p) => p.slot)).toEqual(['small']);
        expect(h.server.puts[0].keepalive).toBe(true);
        expect(h.sync.getStatus().dirty).toEqual(['huge']);
    });

    it('never syncs ghost-* slots, even when they exist locally', async () => {
        const h = harness({ local: { 'ghost-identity': envelope('ghost-identity', 1, { verifier: 'secret' }), default: envelope('default', 1) } });
        h.sync.start();
        await gate(h.sync, 100);
        await tick(0);
        expect(h.server.puts.map((p) => p.slot)).toEqual(['default']);
    });

    it('ignores an account copy that is not a valid envelope for this game', async () => {
        const server = makeServer();
        server.rows.set('default', { savedAt: 42, payload: envelope('default', 42, {}, 'OTHERGAME000'), deleted: false });
        server.rows.set('junk', { savedAt: 42, payload: '{not json', deleted: false });
        const h = harness({ server });
        h.sync.start();
        await gate(h.sync, 100);
        expect(h.inner.store.size).toBe(0);
    });

    it('a guest who signs in mid-session starts pushing without a reload', async () => {
        const h = harness({ token: null, hasBridge: true, local: { default: envelope('default', 7) } });
        h.sync.start();
        await gate(h.sync, 10);
        expect(h.sync.getStatus().mode).toBe('guest');
        h.token.value = 'tok';
        await tick(DEFAULT_CLOUD_SAVE_SYNC_OPTIONS.guestRetryMs + 10);
        expect(h.server.listCalls).toBe(1);
        expect(h.server.puts.map((p) => p.slot)).toEqual(['default']);
    });

    it('an unreachable index leaves everything local and pushes nothing', async () => {
        const h = harness({ server: makeServer({ listResult: null }), local: { default: envelope('default', 7) } });
        h.sync.start();
        await gate(h.sync, 100);
        expect(h.sync.getStatus().mode).toBe('offline');
        h.persistence.save({ n: 2 }, 'default');
        await tick(10_000);
        expect(h.server.puts).toHaveLength(0);
    });

    it('dispose flushes dirty slots and stops timers', async () => {
        const h = harness();
        h.sync.start();
        await gate(h.sync, 100);
        h.persistence.save({ n: 1 }, 'default');
        h.sync.dispose();
        await tick(0);
        expect(h.server.puts.map((p) => p.slot)).toEqual(['default']);
        h.persistence.save({ n: 2 }, 'default');
        await tick(10_000);
        expect(h.server.puts).toHaveLength(1);
    });
});
