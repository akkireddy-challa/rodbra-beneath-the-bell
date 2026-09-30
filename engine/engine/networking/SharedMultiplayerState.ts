// SharedMultiplayerState — generic, transport-agnostic multiplayer state sync
// that any multiplayer game can use to keep its state alive across sessions.
//
// Contract:
//   - You supply three callbacks: applyDelta, serializeSnapshot, applySnapshot.
//   - emit(delta) — game calls this on every local mutation. The system applies
//     it locally (optimistic), broadcasts it to other clients (live sync), and
//     when the local player is the host, the periodic save tick captures the
//     full state via serializeSnapshot() and writes one entry to GameDataService.
//   - On construction, the system reads the latest snapshot from GameDataService
//     and calls applySnapshot — so reloads pick up where the last host left off.
//   - On construction, the system also broadcasts a `<name>.snapshotRequest`
//     event; the current host responds with the live snapshot so non-hosts
//     catch up to any deltas that happened between the last save and now.
//
// What's deliberately NOT here:
//   - Server-side intercept of events. The system uses NetworkManager.sendEvent
//     and GameDataService.create directly from each client's browser. The server
//     is just a relay (for live broadcast) and a storage proxy (for writes via
//     /v1/{gameId}/userdata/{category}). No new server code is required.
//   - Per-delta persistence. Each save tick writes the FULL snapshot, not the
//     delta. Trade-off: faster reads (one entry vs. replay-N-events), simpler
//     mental model, but the snapshot must fit GameDataService's 1 MB data cap.
//     For state volumes that exceed that (large voxel worlds, etc.), the game
//     needs to split state into multiple instances of this helper, each with
//     its own `name` and bounded snapshot — sharded persistence is a v2 helper.
//   - Host migration on top of NetworkRoomOwnership. The system polls
//     `isHost()` each save tick — if you became host since last tick, the next
//     save writes your current state; if you lost host, your save is skipped.

import type { NetworkManager } from 'engine/networking/NetworkManager.js';
import type { GameDataService } from 'engine/gamedata/GameDataService.js';

export interface SharedMultiplayerStateOptions<TDelta, TSnapshot> {
    /**
     * Short string identifying this state stream. Used as the GameDataService
     * category for persistence AND the prefix for WS event names. Must be
     * unique per state-stream within a game (e.g. `'canvas'`, `'voxel-world'`).
     */
    name: string;
    networkManager: NetworkManager;
    gameDataService: GameDataService;
    /**
     * Returns whether the local player is currently the room host. Polled at
     * each save tick. The system doesn't track host status internally — it
     * trusts whatever this returns. Most games using BlancoMultiplayerSetup
     * or MultiplayerSetup can pass `() => this.multiplayer.isRoomHost`.
     */
    isHost: () => boolean;
    /**
     * Apply an incoming delta to the game's local state. Called for every
     * delta the system observes — local optimistic, remote broadcast, AND
     * deltas replayed from a snapshot (the snapshot path goes through
     * applySnapshot, not applyDelta). Idempotent re-application is encouraged.
     */
    applyDelta: (delta: TDelta, senderId: string) => void;
    /**
     * Serialize the game's current state into a snapshot. Called by the save
     * tick (host only) and by snapshotRequest handler (also host only).
     * Result is the value persisted to GameDataService.data, so it must fit
     * 1 MB JSON-encoded and be valid JSON.
     */
    serializeSnapshot: () => TSnapshot;
    /**
     * Apply a full snapshot (overwriting the game's current state). Called
     * when a peer's snapshot arrives via the snapshot event, and when the
     * latest snapshot is loaded from GameDataService at construction.
     */
    applySnapshot: (snapshot: TSnapshot) => void;
    /**
     * How often the host serializes + writes a snapshot to GameDataService.
     * Default 5000 ms. Lower = less data loss on host crash, more write cost.
     */
    persistFlushIntervalMs?: number;
}

const DEFAULT_PERSIST_FLUSH_INTERVAL_MS = 5000;

type CustomEventHandler = (senderId: string, data: Record<string, unknown>) => void;

export class SharedMultiplayerState<TDelta, TSnapshot> {
    private readonly opts: SharedMultiplayerStateOptions<TDelta, TSnapshot>;
    private readonly category: string;
    private readonly eventDelta: string;
    private readonly eventSnapshotReq: string;
    private readonly eventSnapshot: string;
    private saveTimer: ReturnType<typeof setInterval> | null = null;
    private disposed = false;
    private started = false;
    private remoteDeltaHandler: CustomEventHandler | null = null;
    private snapshotRequestHandler: CustomEventHandler | null = null;
    private snapshotHandler: CustomEventHandler | null = null;

    constructor(opts: SharedMultiplayerStateOptions<TDelta, TSnapshot>) {
        this.opts = opts;
        this.category = opts.name;
        this.eventDelta = `${opts.name}.delta`;
        this.eventSnapshotReq = `${opts.name}.snapshotRequest`;
        this.eventSnapshot = `${opts.name}.snapshot`;
    }

    /**
     * Subscribe to network events, load latest persisted snapshot, ask peers
     * for live snapshot, and start the host save timer. Call once after
     * NetworkManager is constructed (does NOT have to be connected — events
     * subscribe immediately and outbound sends queue until connect).
     */
    async start(): Promise<void> {
        if (this.started || this.disposed) return;
        this.started = true;

        // Remote-delta handler: every other client's local mutation arrives here.
        this.remoteDeltaHandler = (senderId, data) => {
            this.opts.applyDelta(data as unknown as TDelta, senderId);
        };
        this.opts.networkManager.events.on(this.eventDelta, this.remoteDeltaHandler);

        // Snapshot-request handler: respond if we're host. The request is broadcast,
        // every client receives it, but only the host serializes + sends a response.
        this.snapshotRequestHandler = (_senderId, _data) => {
            if (!this.opts.isHost()) return;
            const snapshot = this.opts.serializeSnapshot();
            this.opts.networkManager.sendEvent(this.eventSnapshot, snapshot as unknown as Record<string, unknown>);
        };
        this.opts.networkManager.events.on(this.eventSnapshotReq, this.snapshotRequestHandler);

        // Snapshot handler: a peer (or the host) sent us the current state.
        this.snapshotHandler = (_senderId, data) => {
            this.opts.applySnapshot(data as unknown as TSnapshot);
        };
        this.opts.networkManager.events.on(this.eventSnapshot, this.snapshotHandler);

        // Pull the latest persisted snapshot. Best-effort — if the gamedata
        // service is misconfigured or empty (first session ever), we just
        // continue with whatever the game's initial state is.
        await this.loadLatestSnapshot();

        // Ask the current host (if any) for the live snapshot. Catches up to
        // any deltas applied since the last save tick. No-op if we're the
        // sole player (no host to respond).
        this.opts.networkManager.sendEvent(this.eventSnapshotReq, {});

        // Start the save tick. Always runs; the `isHost()` check inside runSave
        // gates whether each tick actually writes. Games that want fully
        // explicit save control can pass `persistFlushIntervalMs: 0` to disable
        // the tick entirely (the user has to call `save()` manually then).
        const interval = this.opts.persistFlushIntervalMs ?? DEFAULT_PERSIST_FLUSH_INTERVAL_MS;
        if (interval > 0) {
            this.saveTimer = setInterval(() => { void this.runSave('tick'); }, interval);
            console.log(`[SharedMultiplayerState:${this.opts.name}] save tick every ${interval}ms (host-gated)`);
        } else {
            console.log(`[SharedMultiplayerState:${this.opts.name}] save tick disabled — call save() explicitly`);
        }
    }

    /**
     * Game's mutation pipe. Apply locally (optimistic), broadcast to all
     * other clients. Persistence is NOT triggered here — the host's save
     * tick captures all accumulated state on its next fire.
     */
    emit(delta: TDelta): void {
        if (this.disposed) return;
        // Local apply first so the local view updates without waiting for the
        // round-trip — same pattern Pixel Canvas's old code used.
        this.opts.applyDelta(delta, 'self');
        this.opts.networkManager.sendEvent(this.eventDelta, delta as unknown as Record<string, unknown>);
    }

    /**
     * Trigger an immediate save. Returns when the write completes (or fails).
     * Use this when the game has a specific moment it wants state to be
     * durable — end of a round, after a significant action, before navigating
     * away, etc. The periodic save tick continues to run alongside.
     *
     * No-op when the local player isn't the host (only the host can save).
     * Resolves immediately without writing in that case — no error thrown,
     * because "I'm not the host, the host will save soon" is the expected
     * outcome, not a failure.
     */
    async save(): Promise<void> {
        if (this.disposed) return;
        await this.runSave('explicit');
    }

    private async loadLatestSnapshot(): Promise<void> {
        try {
            // Order by `createdAt` (server-stamped on insert), NOT a custom
            // `values.*` field. The gamedata server adds a `createdAt` tiebreak
            // to any non-createdAt orderBy, which makes it a two-field composite
            // index that Firestore needs explicitly created (and on failure the
            // server may surface 500 instead of 400 because the SDK's wrapped
            // error doesn't always contain the literal word "index"). Using
            // `createdAt` skips the tiebreak entirely — single-field sort,
            // works with Firestore's auto-indexed single-field defaults.
            const res = await this.opts.gameDataService.list(this.category, {
                orderBy: 'createdAt',
                orderDir: 'desc',
                limit: 1,
                fields: 'all',
            });
            const entry = res.entries[0];
            if (!entry || !entry.data) return;
            this.opts.applySnapshot(entry.data as unknown as TSnapshot);
            console.log(`[SharedMultiplayerState:${this.opts.name}] loaded snapshot from gamedata (createdAt=${entry.meta.createdAt})`);
        } catch (err) {
            console.warn(`[SharedMultiplayerState:${this.opts.name}] loadLatestSnapshot failed`, err);
        }
    }

    /**
     * The actual save path. Used by both the periodic tick (`reason='tick'`)
     * and the public `save()` method (`reason='explicit'`). Skips when not
     * host. Logs success and skip reasons so diagnostics are easy.
     */
    private async runSave(reason: 'tick' | 'explicit'): Promise<void> {
        if (this.disposed) return;
        if (!this.opts.isHost()) {
            // Only the host writes. Silent skip on tick (normal), explicit log
            // on explicit-save (caller wanted feedback).
            if (reason === 'explicit') {
                console.log(`[SharedMultiplayerState:${this.opts.name}] save() skipped — local player is not host`);
            }
            return;
        }
        try {
            const snapshot = this.opts.serializeSnapshot();
            const t = Date.now();
            await this.opts.gameDataService.create(this.category, {
                data: snapshot as unknown as Record<string, unknown>,
                values: { t },
            });
            console.log(`[SharedMultiplayerState:${this.opts.name}] saved (${reason}, t=${t})`);
        } catch (err) {
            console.warn(`[SharedMultiplayerState:${this.opts.name}] save failed (${reason})`, err);
        }
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        if (this.saveTimer) {
            clearInterval(this.saveTimer);
            this.saveTimer = null;
        }
        if (this.remoteDeltaHandler) {
            this.opts.networkManager.events.off(this.eventDelta, this.remoteDeltaHandler);
        }
        if (this.snapshotRequestHandler) {
            this.opts.networkManager.events.off(this.eventSnapshotReq, this.snapshotRequestHandler);
        }
        if (this.snapshotHandler) {
            this.opts.networkManager.events.off(this.eventSnapshot, this.snapshotHandler);
        }
        this.remoteDeltaHandler = null;
        this.snapshotRequestHandler = null;
        this.snapshotHandler = null;
    }
}
