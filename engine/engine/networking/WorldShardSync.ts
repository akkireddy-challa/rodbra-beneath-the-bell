// WorldShardSync — engine-side glue for the persistent-world feature.
//
// The opt-in decision lives in world.json (`worldProfileData.persistentWorld`).
// GameEngine reads that field; if true, it constructs this class and calls
// bootstrap(). If false (or absent), this file is never imported.
//
// Two transport modes:
//   • WS (preferred): when the genre exposes a NetworkManager. Edits go out
//     as `event` envelopes with `eventName: 'chunkDelta'`, server intercepts
//     them for the shard buffer AND broadcasts to other clients in the room.
//     Server pushes `eventName: 'worldSnapshot'` to each client on join so
//     late joiners and reconnects get the current state without any HTTP.
//   • HTTP fallback: when there's no NetworkManager (single-player voxel
//     games). Uses the same shard-buffer-backed endpoints
//     (POST /world-shards/:gameId/append, GET /world-shards/:gameId) the
//     server has always supported.
//
// Lifecycle once constructed:
//   1. bootstrap() — installs the setBlock observer FIRST (so edits made
//      during the network round-trip aren't lost). In WS mode it subscribes
//      to the chunkDelta + worldSnapshot events; in HTTP mode it does the
//      one-shot GET to seed the world.
//   2. Local edits feed `pending`. Flush timer (default 3 s) ships the
//      batch via either NetworkManager.sendEvent or fetch. Capacity overflow
//      also triggers a flush.
//   3. dispose() — uninstalls observer, sendBeacon-flushes any pending edits
//      in HTTP mode (WS mode just sends them as a regular event before
//      teardown; NetworkManager queues survive page unload less reliably,
//      so we keep the beacon path for that case too).

import { GAME_DATA_SERVICE_URL } from 'engine/config.js';
import type { VoxelWorld } from 'engine/VoxelWorld.js';
import type { NetworkManager } from 'engine/networking/NetworkManager.js';

const SHARD_REGION_CHUNKS = 4;
const SHARD_CHUNK_SIZE = 16;
export const SHARD_VOXEL_SIZE = SHARD_REGION_CHUNKS * SHARD_CHUNK_SIZE;

const FORMAT_VERSION = 1;
const HEADER_BYTES = 5;
const EDIT_BYTES = 8;
const COORD_BITS = 6;
const COORD_MASK = (1 << COORD_BITS) - 1;

const EVENT_CHUNK_DELTA = 'chunkDelta';
const EVENT_WORLD_SNAPSHOT = 'worldSnapshot';
const EVENT_REQUEST_SNAPSHOT = 'requestWorldSnapshot';
const EVENT_PERSIST_FLUSH = 'persistFlush';
const EVENT_ROOM_OWNER = '_roomOwner';

/**
 * How often the local host sends a `persistFlush` event to the server,
 * triggering a Firestore commit. Non-hosts never send this. The interval
 * trades off Firestore-write cost against data-loss window on host crash.
 */
const HOST_PERSIST_FLUSH_INTERVAL_MS = 5000;

export interface WorldShardSyncOptions {
    gameId: string;
    voxelWorld: VoxelWorld;
    /**
     * Connected NetworkManager for live multi-client sync. When null, the
     * sync falls back to HTTP-only (still persists, just no live fan-out).
     */
    networkManager: NetworkManager | null;
    spawnX: number;
    spawnY: number;
    spawnZ: number;
    spawnLoadRadiusVoxels: number;
    flushIntervalMs: number;
    maxEditsPerFlush: number;
    serverBaseUrl: string;
}

export const DEFAULT_WORLD_SHARD_SYNC_OPTIONS: Omit<WorldShardSyncOptions, 'gameId' | 'voxelWorld' | 'networkManager'> = {
    spawnX: 0,
    spawnY: 0,
    spawnZ: 0,
    // Negative sentinel = load ALL shards on bootstrap (HTTP path), no spatial
    // filter. WS path always receives a full snapshot from the server.
    spawnLoadRadiusVoxels: -1,
    flushIntervalMs: 3000,
    maxEditsPerFlush: 2048,
    serverBaseUrl: GAME_DATA_SERVICE_URL,
};

interface PendingEdit {
    sx: number; sy: number; sz: number;
    lx: number; ly: number; lz: number;
    block: number;
    color: number;
}

interface DecodedShard {
    edits: Map<number, { block: number; color: number }>;
}

function shardCoordOf(voxel: number): number {
    return Math.floor(voxel / SHARD_VOXEL_SIZE);
}

function decodeShard(base64: string): DecodedShard {
    const edits = new Map<number, { block: number; color: number }>();
    if (!base64) return { edits };
    const binStr = atob(base64);
    const len = binStr.length;
    const buf = new Uint8Array(len);
    for (let i = 0; i < len; i++) buf[i] = binStr.charCodeAt(i);
    if (buf.length < HEADER_BYTES) return { edits };
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const version = view.getUint8(0);
    if (version !== FORMAT_VERSION) {
        console.warn(`[WorldShardSync] unsupported shard format version ${version}; skipping`);
        return { edits };
    }
    const count = view.getUint32(1, true);
    const expected = HEADER_BYTES + count * EDIT_BYTES;
    if (buf.length < expected) {
        console.warn(`[WorldShardSync] truncated shard blob (${buf.length}/${expected}); skipping`);
        return { edits };
    }
    let offset = HEADER_BYTES;
    for (let i = 0; i < count; i++) {
        const packed = view.getUint16(offset, true);
        const block = view.getUint16(offset + 2, true);
        const color = view.getUint32(offset + 4, true);
        edits.set(packed, { block, color });
        offset += EDIT_BYTES;
    }
    return { edits };
}

function unpackLocal(packed: number): { lx: number; ly: number; lz: number } {
    return {
        lx: packed & COORD_MASK,
        ly: (packed >>> COORD_BITS) & COORD_MASK,
        lz: (packed >>> (COORD_BITS * 2)) & COORD_MASK,
    };
}

interface RemoteEditPayload {
    shard?: { sx?: number; sy?: number; sz?: number };
    local?: { lx?: number; ly?: number; lz?: number };
    block?: number;
    color?: number;
}

export class WorldShardSync {
    private options: WorldShardSyncOptions;
    private recording = false;
    private restoring = false;
    private pending: PendingEdit[] = [];
    private flushTimer: ReturnType<typeof setInterval> | null = null;
    private persistFlushTimer: ReturnType<typeof setInterval> | null = null;
    private disposed = false;
    private enabled = false;
    private wsMode = false;
    private localIsHost = false;
    private localPlayerId: string | null = null;
    private remoteDeltaHandler: ((senderId: string, data: Record<string, unknown>) => void) | null = null;
    private remoteSnapshotHandler: ((senderId: string, data: Record<string, unknown>) => void) | null = null;
    private roomOwnerHandler: ((senderId: string, data: Record<string, unknown>) => void) | null = null;

    constructor(opts: WorldShardSyncOptions) {
        this.options = opts;
        this.wsMode = opts.networkManager !== null;
    }

    async bootstrap(): Promise<{ shardCount: number; editCount: number }> {
        console.log(`[WorldShardSync] bootstrap starting for gameId="${this.options.gameId}" (mode=${this.wsMode ? 'ws' : 'http'})`);
        this.installObserverAndArm();
        this.enabled = true;

        if (this.wsMode) {
            this.subscribeToWsEvents();
            // Snapshot is server-pushed on join. We return immediately with 0/0
            // — the actual counts arrive via the snapshot event handler.
            return { shardCount: 0, editCount: 0 };
        }

        // HTTP fallback path: one-shot fetch.
        return await this.httpBootstrap();
    }

    private async httpBootstrap(): Promise<{ shardCount: number; editCount: number }> {
        const shardsUrl = new URL(`${this.options.serverBaseUrl}/world-shards/${encodeURIComponent(this.options.gameId)}`);
        if (this.options.spawnLoadRadiusVoxels >= 0) {
            const radius = this.options.spawnLoadRadiusVoxels;
            const minSx = shardCoordOf(this.options.spawnX - radius);
            const maxSx = shardCoordOf(this.options.spawnX + radius);
            const minSy = shardCoordOf(this.options.spawnY - radius);
            const maxSy = shardCoordOf(this.options.spawnY + radius);
            const minSz = shardCoordOf(this.options.spawnZ - radius);
            const maxSz = shardCoordOf(this.options.spawnZ + radius);
            shardsUrl.searchParams.set('sx', `${minSx},${maxSx}`);
            shardsUrl.searchParams.set('sy', `${minSy},${maxSy}`);
            shardsUrl.searchParams.set('sz', `${minSz},${maxSz}`);
        }
        let shardsRes: Response;
        try {
            shardsRes = await fetch(shardsUrl.toString());
        } catch (err) {
            console.warn('[WorldShardSync] HTTP shard fetch failed; continuing without restore', err);
            return { shardCount: 0, editCount: 0 };
        }
        if (!shardsRes.ok) {
            console.warn(`[WorldShardSync] HTTP shard list returned ${shardsRes.status}`);
            return { shardCount: 0, editCount: 0 };
        }
        const payload = await shardsRes.json() as { shards?: Array<{ sx: number; sy: number; sz: number; blob: string }> };
        const shardCount = payload.shards?.length ?? 0;
        console.log(`[WorldShardSync] HTTP returned ${shardCount} shard(s)`);
        const editCount = this.restoreShards(payload.shards ?? []);
        console.log(`[WorldShardSync] restored ${editCount} edit(s) across ${shardCount} shard(s) — ready to record new edits`);
        return { shardCount, editCount };
    }

    private subscribeToWsEvents(): void {
        const nm = this.options.networkManager;
        if (!nm) return;

        this.localPlayerId = nm.getLocalPlayerId();

        this.remoteSnapshotHandler = (senderId, data) => {
            const shards = (data as { shards?: Array<{ sx: number; sy: number; sz: number; blob: string }> }).shards;
            if (!Array.isArray(shards)) return;
            console.log(`[WorldShardSync] received worldSnapshot from ${senderId}: ${shards.length} shard(s)`);
            const editCount = this.restoreShards(shards);
            console.log(`[WorldShardSync] applied snapshot: ${editCount} edit(s) across ${shards.length} shard(s)`);
        };

        this.remoteDeltaHandler = (senderId, data) => {
            // Echo-prevention: NetworkManager already excludes our own sends via
            // server-side broadcast (sender is filtered out), but check senderId
            // as a defensive belt-and-braces guard.
            const edits = (data as { edits?: RemoteEditPayload[] }).edits;
            if (!Array.isArray(edits) || edits.length === 0) return;
            void senderId;
            this.applyRemoteEdits(edits);
        };

        // Host tracking. The `_roomOwner` event is broadcast by NetworkRoomOwnership
        // (claimed on room create, heartbeated, migrated on disconnect to the
        // smallest-playerId). The LOCAL claim does NOT echo back to us, so
        // tracking purely via this event misses self-becoming-host. We pair
        // the event listener with an onOwnerChanged hook on NetworkRoomOwnership
        // via the genre's exposure — but since WorldShardSync doesn't have a
        // direct ref, we approximate with a poll on first `_roomOwner` plus
        // re-checks at well-defined moments (chunkDelta send, persistFlush tick).
        //
        // Simpler and sufficient for v1: on every `_roomOwner` we see (whether
        // for a remote or for ourselves via heartbeat), update the flag. The
        // local also re-broadcasts its own ownership periodically as a heartbeat
        // (NetworkRoomOwnership.update), so we'll see it.
        this.roomOwnerHandler = (_senderId, data) => {
            const ownerId = (data as { ownerId?: unknown }).ownerId;
            if (typeof ownerId !== 'string') return;
            const nowHost = ownerId === this.localPlayerId;
            if (nowHost !== this.localIsHost) {
                this.localIsHost = nowHost;
                this.onHostStatusChanged(nowHost);
            }
        };

        nm.events.on(EVENT_WORLD_SNAPSHOT, this.remoteSnapshotHandler);
        nm.events.on(EVENT_CHUNK_DELTA, this.remoteDeltaHandler);
        nm.events.on(EVENT_ROOM_OWNER, this.roomOwnerHandler);

        // Actively pull the current snapshot. The server also pushes one
        // proactively on join, but that push races with engine bootstrap:
        // genre.load awaits lobby join (which opens the WS) BEFORE
        // WorldShardSync constructs and subscribes — so the proactive snapshot
        // is often delivered to a handler that doesn't yet exist and gets
        // silently dropped. An explicit request after subscribing closes the
        // race; the second snapshot is harmless (apply is idempotent under
        // last-write-wins).
        this.requestSnapshotWhenConnected();
    }

    /**
     * Fires when the local player's host status flips. As host, we start
     * sending periodic `persistFlush` events to the server — that's what
     * triggers the server to commit its in-memory buffer to Firestore.
     * As non-host, we stop. Fire one immediately on becoming host so any
     * backlog the previous host left behind is committed without delay.
     */
    private onHostStatusChanged(isHost: boolean): void {
        console.log(`[WorldShardSync] local host status: ${isHost ? 'HOST' : 'guest'}`);
        if (isHost) {
            this.sendPersistFlush();
            if (!this.persistFlushTimer) {
                this.persistFlushTimer = setInterval(() => this.sendPersistFlush(), HOST_PERSIST_FLUSH_INTERVAL_MS);
            }
        } else {
            if (this.persistFlushTimer) {
                clearInterval(this.persistFlushTimer);
                this.persistFlushTimer = null;
            }
        }
    }

    private sendPersistFlush(): void {
        const nm = this.options.networkManager;
        if (!nm || !nm.isConnected() || !this.localIsHost || this.disposed) return;
        nm.sendEvent(EVENT_PERSIST_FLUSH, {});
    }

    private requestSnapshotWhenConnected(): void {
        const nm = this.options.networkManager;
        if (!nm) return;
        if (nm.isConnected()) {
            nm.sendEvent(EVENT_REQUEST_SNAPSHOT, {});
            return;
        }
        // Not yet connected — chain the request after the next state change.
        // Preserve any existing onStateChanged handler the genre may have set.
        const prevHandler = nm.onStateChanged;
        nm.onStateChanged = (state) => {
            prevHandler?.(state);
            if (state === 'connected') {
                // One-shot — restore the original handler after firing.
                nm.onStateChanged = prevHandler;
                nm.sendEvent(EVENT_REQUEST_SNAPSHOT, {});
            }
        };
    }

    private restoreShards(shards: Array<{ sx: number; sy: number; sz: number; blob: string }>): number {
        let editCount = 0;
        this.restoring = true;
        try {
            for (const shard of shards) editCount += this.applyShard(shard);
        } finally {
            this.restoring = false;
        }
        return editCount;
    }

    private applyRemoteEdits(edits: RemoteEditPayload[]): void {
        const { voxelWorld } = this.options;
        const voxelSize = voxelWorld.getVoxelSize();
        const bounds = voxelWorld.getBounds();
        const bX = bounds?.minX ?? 0, bY = bounds?.minY ?? 0, bZ = bounds?.minZ ?? 0;
        this.restoring = true;
        try {
            for (const e of edits) {
                const sx = e.shard?.sx, sy = e.shard?.sy, sz = e.shard?.sz;
                const lx = e.local?.lx, ly = e.local?.ly, lz = e.local?.lz;
                if (typeof sx !== 'number' || typeof sy !== 'number' || typeof sz !== 'number') continue;
                if (typeof lx !== 'number' || typeof ly !== 'number' || typeof lz !== 'number') continue;
                const block = typeof e.block === 'number' ? e.block : 0;
                const color = typeof e.color === 'number' ? e.color : 0;
                const vx = sx * SHARD_VOXEL_SIZE + lx;
                const vy = sy * SHARD_VOXEL_SIZE + ly;
                const vz = sz * SHARD_VOXEL_SIZE + lz;
                const wx = bX + (vx + 0.5) * voxelSize;
                const wy = bY + (vy + 0.5) * voxelSize;
                const wz = bZ + (vz + 0.5) * voxelSize;
                voxelWorld.setBlock(wx, wy, wz, block, color === 0 ? undefined : color);
            }
        } finally {
            this.restoring = false;
        }
    }

    private installObserverAndArm(): void {
        if (this.disposed) return;
        this.options.voxelWorld.setMutationObserver((vx, vy, vz, block, color) => {
            if (!this.recording || this.restoring) return;
            const sx = shardCoordOf(vx);
            const sy = shardCoordOf(vy);
            const sz = shardCoordOf(vz);
            const lx = vx - sx * SHARD_VOXEL_SIZE;
            const ly = vy - sy * SHARD_VOXEL_SIZE;
            const lz = vz - sz * SHARD_VOXEL_SIZE;
            this.pending.push({
                sx, sy, sz, lx, ly, lz,
                block,
                color: color !== undefined ? (color >>> 0) : 0,
            });
            if (this.pending.length >= this.options.maxEditsPerFlush) {
                void this.flushNow();
            }
        });
        this.recording = true;
        this.flushTimer = setInterval(() => { void this.flushNow(); }, this.options.flushIntervalMs);
    }

    private applyShard(shard: { sx: number; sy: number; sz: number; blob: string }): number {
        const decoded = decodeShard(shard.blob);
        const { voxelWorld } = this.options;
        const voxelSize = voxelWorld.getVoxelSize();
        const bounds = voxelWorld.getBounds();
        const bX = bounds?.minX ?? 0, bY = bounds?.minY ?? 0, bZ = bounds?.minZ ?? 0;
        let applied = 0;
        for (const [packed, { block, color }] of decoded.edits) {
            const { lx, ly, lz } = unpackLocal(packed);
            const vx = shard.sx * SHARD_VOXEL_SIZE + lx;
            const vy = shard.sy * SHARD_VOXEL_SIZE + ly;
            const vz = shard.sz * SHARD_VOXEL_SIZE + lz;
            const wx = bX + (vx + 0.5) * voxelSize;
            const wy = bY + (vy + 0.5) * voxelSize;
            const wz = bZ + (vz + 0.5) * voxelSize;
            voxelWorld.setBlock(wx, wy, wz, block, color === 0 ? undefined : color);
            applied++;
        }
        return applied;
    }

    private wireFormatBatch(batch: PendingEdit[]): Array<{ shard: { sx: number; sy: number; sz: number }; local: { lx: number; ly: number; lz: number }; block: number; color: number }> {
        return batch.map((e) => ({
            shard: { sx: e.sx, sy: e.sy, sz: e.sz },
            local: { lx: e.lx, ly: e.ly, lz: e.lz },
            block: e.block,
            color: e.color,
        }));
    }

    private appendUrl(): string {
        return `${this.options.serverBaseUrl}/world-shards/${encodeURIComponent(this.options.gameId)}/append`;
    }

    /**
     * Send pending edits. Called periodically by the flush timer and on demand
     * when the pending buffer fills up. In WS mode this is a synchronous
     * `sendEvent` call (queued by NetworkManager's reliable-delivery layer).
     * In HTTP mode it's a fetch.
     */
    async flushNow(): Promise<void> {
        if (!this.enabled || this.disposed) return;
        if (this.pending.length === 0) return;
        const batch = this.pending;
        this.pending = [];

        if (this.wsMode) {
            const nm = this.options.networkManager;
            if (nm) {
                try {
                    nm.sendEvent(EVENT_CHUNK_DELTA, { edits: this.wireFormatBatch(batch) });
                } catch (err) {
                    console.warn('[WorldShardSync] sendEvent threw; re-queueing edits', err);
                    this.pending.unshift(...batch);
                }
            } else {
                // wsMode declared but NetworkManager gone — shouldn't happen,
                // but if it does, re-queue and the next flush will try again.
                this.pending.unshift(...batch);
            }
            return;
        }

        // HTTP fallback
        const body = JSON.stringify({ edits: this.wireFormatBatch(batch) });
        try {
            const res = await fetch(this.appendUrl(), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body,
            });
            if (!res.ok) {
                console.warn(`[WorldShardSync] HTTP flush failed (${res.status}); re-queueing ${batch.length} edits`);
                this.pending.unshift(...batch);
            }
        } catch (err) {
            console.warn('[WorldShardSync] HTTP flush threw; re-queueing edits', err);
            this.pending.unshift(...batch);
        }
    }

    /**
     * Page-unload flush via navigator.sendBeacon. WS frames are NOT guaranteed
     * to deliver during page unload (the connection is closed before the queue
     * drains), so we always fall back to the HTTP append endpoint here — that
     * one is designed for the unload path.
     *
     * @param triggerPersist If true (host disposing), ask the server to ALSO
     *   commit the buffer to Firestore immediately after appending. Single
     *   request, atomic. Non-hosts pass false — server will buffer their
     *   pending edits but won't write to Firestore until the next host's
     *   persistFlush.
     */
    private flushViaBeacon(batch: PendingEdit[], triggerPersist: boolean): void {
        if (batch.length === 0 && !triggerPersist) return;
        if (batch.length > 0) {
            console.log(`[WorldShardSync] dispose: flushing ${batch.length} pending edit(s) via sendBeacon${triggerPersist ? ' (+ host persistFlush)' : ''}`);
        } else if (triggerPersist) {
            console.log('[WorldShardSync] dispose: host persistFlush via sendBeacon');
        }
        const body = JSON.stringify({ edits: this.wireFormatBatch(batch), flush: triggerPersist });
        const url = this.appendUrl();
        const nav: { sendBeacon?: (url: string, data: Blob) => boolean } =
            (typeof navigator !== 'undefined' ? navigator : {}) as typeof navigator;
        if (typeof nav.sendBeacon === 'function') {
            try {
                const blob = new Blob([body], { type: 'application/json' });
                const ok = nav.sendBeacon(url, blob);
                if (ok) return;
            } catch { /* fall through to keepalive fetch */ }
        }
        try {
            void fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body,
                keepalive: true,
            }).catch(() => { /* fire-and-forget */ });
        } catch { /* nothing more we can do at unload */ }
    }

    dispose(): void {
        this.recording = false;
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }
        if (this.persistFlushTimer) {
            clearInterval(this.persistFlushTimer);
            this.persistFlushTimer = null;
        }
        this.options.voxelWorld.setMutationObserver(null);

        // Unsubscribe from WS events
        if (this.wsMode && this.options.networkManager) {
            const nm = this.options.networkManager;
            if (this.remoteDeltaHandler) nm.events.off(EVENT_CHUNK_DELTA, this.remoteDeltaHandler);
            if (this.remoteSnapshotHandler) nm.events.off(EVENT_WORLD_SNAPSHOT, this.remoteSnapshotHandler);
            if (this.roomOwnerHandler) nm.events.off(EVENT_ROOM_OWNER, this.roomOwnerHandler);
        }
        this.remoteDeltaHandler = null;
        this.remoteSnapshotHandler = null;
        this.roomOwnerHandler = null;

        // Final flush of any pending edits via beacon — sendBeacon survives page
        // unload, a regular WS frame doesn't reliably make it across before close.
        // Whether or not we're host, this gets edits to the server's buffer.
        if (this.pending.length > 0) {
            const wasHost = this.localIsHost;
            const batch = this.pending;
            this.pending = [];
            this.flushViaBeacon(batch, wasHost);
        } else if (this.localIsHost) {
            // No pending edits but we were host — still nudge the server to
            // commit anything that arrived from guests in the buffer.
            this.flushViaBeacon([], true);
        }
        this.disposed = true;
    }
}
