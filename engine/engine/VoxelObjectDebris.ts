/**
 * Unified debris registry for *voxel-object* explosions.
 *
 * Voxel-object explosion produces two physical flavours of debris and
 * historically lived in two parallel managers (`VoxelDebrisManager` for
 * per-voxel debris, `VoxelFragmentSyncRegistry` for chunk debris). Every
 * cross-cutting feature — TTL, falloff-Y reaper, settle-freeze, max-active
 * cap, network sync, stuck-fragment splitting, push-on-blast — had to be
 * implemented twice and stayed out of sync. This module merges both into
 * one tracker that owns the full feature set.
 *
 * Flavours:
 *   - **Voxel debris** (`spawnVoxel`) — single cuboid body. Rendered via
 *     a shared InstancedMesh keyed by voxel size, with per-instance
 *     colour. Cheap for the many tiny pieces a voxel-object explosion of
 *     a non-pre-fragmented asset throws out.
 *   - **Chunk debris** (`spawnChunk`) — a standalone `VoxelObject` that
 *     was just detached from its parent. The object brings its own mesh
 *     and physics body; we only sync its `THREE.Group` transform to the
 *     body each frame. Used for pre-fragmented asset detachments.
 *
 * Behaviour applied uniformly to both flavours:
 *   - Per-frame transform sync.
 *   - Falloff-Y reaper (anything below y=-100 is removed).
 *   - Randomised 7-13 s TTL on the "individual voxel" size band (≤4
 *     leaves). Larger chunks live indefinitely.
 *   - `pushInRadius` applies a mass-scaled radial impulse to every entry
 *     in a blast.
 *
 * Voxel-flavour-only features (ported from the old VoxelDebrisManager —
 * these keep per-voxel debris cheap once it settles):
 *   - **Settle-freeze.** Once a body slows below the velocity threshold
 *     after having been flung, and stays slow for `consolidationDelay`
 *     ms, we set its body type to fixed. Rapier skips fixed bodies in
 *     the solver, so the simulation cost drops to ~zero. The matrix
 *     sync also skips settled entries.
 *   - **Max-active cap with oldest-active eviction.** Burst explosions
 *     that exceed `maxDebris` evict the oldest still-moving entry so
 *     the active-body count never spikes unbounded.
 *   - **Network sync.** Authority queues a `DebrisFreezeEvent` for every
 *     local settle; consumer drains the queue each frame. Clients can
 *     apply a batch via `applyFreezeBatch` to snap their debris to the
 *     server's authoritative resting transforms.
 *
 * Chunk-flavour-only:
 *   - **Stuck-fragment jitter-split** at 2 / 5 / 10 sim seconds. A chunk
 *     that hasn't fallen asleep by the checkpoint splits into smaller
 *     pieces (via `VoxelObject.splitInPlace`) to break out of contact-
 *     resolution deadlocks.
 *
 * Terrain debris (block-based, with consolidate-into-chunk) intentionally
 * stays in `VoxelDebrisManager` — its merge-into-terrain story is
 * terrain-specific and not part of voxel-object explosions.
 */

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import type { VoxelObject } from 'engine/VoxelObject.js';

// ─── Tunables ──────────────────────────────────────────────────────────

const POOL_INITIAL_CAPACITY = 128;
const FALL_OFF_Y = -100;

/**
 * Default sim-time TTL window for "individual voxel" debris. Randomised
 * per entry so a burst of pieces fades gradually rather than vanishing
 * in lockstep. Configurable per game via `setTtlRange`.
 */
const TTL_MIN_SEC_DEFAULT = 7;
const TTL_MAX_SEC_DEFAULT = 13;

/**
 * Default upper bound on leaf count for an entry to count as "individual
 * voxel" debris and receive the TTL. Larger chunks (real architectural
 * pieces) are intentionally permanent until a future explosion removes
 * them. Configurable per game via `setIndividualVoxelLeafThreshold` —
 * pass 0 to disable TTL entirely so all debris persists, or `Infinity`
 * to apply TTL to every entry regardless of size.
 */
const INDIVIDUAL_VOXEL_LEAF_THRESHOLD_DEFAULT = 4;

/** Stuck-chunk sim-time checkpoints (seconds after spawn). */
const STUCK_CHECK_SCHEDULE_SEC = [2, 5, 10];
/** First check: peak linspeed² above this means "still flying", skip split. */
const STUCK_FIRST_CHECK_MOVING_LINSPEED_SQ = 0.25;
const STUCK_TARGET_LEAVES_PER_PIECE = 12;
const STUCK_MAX_PIECES = 6;
const STUCK_MIN_PIECES = 2;

/** Voxel-flavour cap: above this many *active* entries, evict oldest-active on new spawns. */
const MAX_DEBRIS_DEFAULT = 512;
/** Default time (ms, wall clock) below the velocity threshold before settle. */
const CONSOLIDATION_DELAY_MS_DEFAULT = 1000;
/** Default low-velocity threshold for settle detection (m/s and rad/s). */
const LOW_VELOCITY_THRESHOLD_DEFAULT = 0.3;
/** Z-fighting offset applied at settle time so stacked debris doesn't z-fight. */
const SETTLE_OFFSET_STEP = 0.002;
const SETTLE_OFFSET_WRAP = 50;

// ─── Working temporaries (avoid allocating in hot loops) ───────────────

const _mat4 = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3(1, 1, 1);
const _color = new THREE.Color();

// ─── Public types ─────────────────────────────────────────────────────

/** Authoritative freeze: settled debris at a specific transform on all clients. */
export interface DebrisFreezeEvent {
    id: number;
    px: number; py: number; pz: number;
    qx: number; qy: number; qz: number; qw: number;
}

/** Network-sync configuration. See `enableSync`. */
export interface DebrisSyncOptions {
    /** Whether this instance is the authority (server). */
    isAuthority: boolean;
    /** Max freeze events drained per frame on the authority (rest queued). */
    maxFreezesPerFrame: number;
    /** Authority-side callback invoked each frame there are queued freezes. */
    onFreezeBatch: (batch: DebrisFreezeEvent[]) => void;
}

// ─── Internal types ───────────────────────────────────────────────────

interface InstancedPool {
    voxelSize: number;
    instancedMesh: THREE.InstancedMesh;
    capacity: number;
    activeCount: number;
    entries: (Entry | null)[];
}

/**
 * One tracked debris piece. Exactly one of `voxelObject` / `pool` is set:
 *   - `voxelObject` set → chunk debris (multi-leaf, owns its own mesh)
 *   - `pool` set → voxel debris (single voxel rendered via InstancedMesh)
 */
interface Entry {
    id: number;
    body: RAPIER.RigidBody;
    /**
     * Collider tracked for explicit teardown on dispose. Set for voxel-
     * flavour entries (where this registry created the body). For chunk
     * entries the VoxelObject owns its colliders and we leave them.
     */
    collider: RAPIER.Collider | null;
    physicsWorld: PhysicsWorld;
    /** Voxel count. 1 for `spawnVoxel`, N for `spawnChunk`. */
    leafCount: number;
    /** performance.now() at spawn — used for oldest-active eviction priority. */
    createdAt: number;
    /** Sim seconds elapsed since spawn. Advanced each frame in `update`. */
    simElapsedSec: number;
    /** Sim-time threshold at which this entry is despawned. `Infinity` = permanent. */
    despawnAtSec: number;

    voxelObject: VoxelObject | null;
    pool: InstancedPool | null;
    instanceIndex: number; // valid when pool !== null

    // ── Voxel-flavour settle-freeze state ────────────────────────────
    /**
     * Once a voxel-flavour body has been moving above 1 m/s for at least
     * one frame we set this. Only after that can it transition to settled
     * — a body that never moved was probably spawned static-ish and
     * shouldn't settle. (Matches old VoxelDebrisManager behaviour.)
     */
    hasBeenFlung: boolean;
    /** performance.now() of the first slow frame, or null if currently fast. */
    sleepStartTime: number | null;
    /** True once frozen via setBodyType(fixed). Skips matrix sync from then on. */
    isSettled: boolean;

    // ── Stuck-chunk check state (chunks only) ────────────────────────
    stuckChecksDone: number;
    stuckMaxLinSqSinceCheck: number;
}

// ─── Registry ─────────────────────────────────────────────────────────

class VoxelObjectDebrisImpl {
    private entries: Set<Entry> = new Set();
    private entriesById: Map<number, Entry> = new Map();
    private pools: Map<number, InstancedPool> = new Map();
    private coloredMaterial: THREE.Material | null = null;

    /**
     * Auto IDs for non-deterministic debris start high to avoid colliding
     * with deterministic IDs (DeterministicDestruction uses 32-bit hashes
     * in the 0–0x7FFFFFFF range).
     */
    private nextAutoId: number = 0x80000000;

    /** Total *active* (not-yet-settled) voxel-flavour entries — for cap. */
    private voxelActiveCount: number = 0;
    /** Total settled voxel-flavour entries — included in InstancedMesh but skipped in solver/sync. */
    private voxelSettledCount: number = 0;

    /** Tunables (exposed via setters below). */
    private maxDebris: number = MAX_DEBRIS_DEFAULT;
    private consolidationEnabled: boolean = true;
    private consolidationDelayMs: number = CONSOLIDATION_DELAY_MS_DEFAULT;
    private lowVelocityThreshold: number = LOW_VELOCITY_THRESHOLD_DEFAULT;
    private ttlMinSec: number = TTL_MIN_SEC_DEFAULT;
    private ttlMaxSec: number = TTL_MAX_SEC_DEFAULT;
    private individualVoxelLeafThreshold: number = INDIVIDUAL_VOXEL_LEAF_THRESHOLD_DEFAULT;

    /** Rolling counter for the z-fighting offset applied at settle time. */
    private settleOffsetCounter: number = 0;

    /** Network sync state. */
    private syncOptions: DebrisSyncOptions | null = null;
    private freezeQueue: DebrisFreezeEvent[] = [];

    // ── Tunables API ──────────────────────────────────────────────

    setMaxDebris(max: number): void { this.maxDebris = max; }
    setConsolidationEnabled(enabled: boolean): void { this.consolidationEnabled = enabled; }
    setConsolidationDelay(ms: number): void { this.consolidationDelayMs = ms; }
    setLowVelocityThreshold(threshold: number): void { this.lowVelocityThreshold = threshold; }

    /**
     * Configure the randomised TTL window applied to "individual voxel"
     * debris (entries at or below `individualVoxelLeafThreshold` leaves).
     * `maxSec` is clamped so it can't fall below `minSec`. Set both to a
     * very large value to keep small debris around longer; set both to 0
     * to despawn instantly on spawn (only useful with the threshold
     * lowered enough that nothing qualifies anyway).
     */
    setTtlRange(minSec: number, maxSec: number): void {
        this.ttlMinSec = minSec;
        this.ttlMaxSec = Math.max(minSec, maxSec);
    }

    /**
     * Configure which entries get the randomised TTL. An entry receives a
     * TTL when `leafCount > 0 && leafCount <= maxLeaves`. Defaults to 4,
     * so by default only chunks the size of 1-4 voxels fade out and any
     * larger chunk persists indefinitely.
     *
     * - Pass `0` to disable TTL entirely (every entry persists until
     *   removed by an explosion, falling off the world, or `clearForWorld`).
     * - Pass `Infinity` to apply TTL to every entry regardless of size.
     */
    setIndividualVoxelLeafThreshold(maxLeaves: number): void {
        this.individualVoxelLeafThreshold = maxLeaves;
    }

    // ── Network sync API ──────────────────────────────────────────

    /**
     * Enable networked debris freeze sync.
     *
     * - **Authority** (server): debris settles locally as normal and freeze
     *   events are queued. Each frame, up to `maxFreezesPerFrame` events
     *   are drained and passed to `onFreezeBatch`.
     * - **Client**: local settle-freeze is suppressed; the client must
     *   call `applyFreezeBatch` with events received from the server.
     */
    enableSync(options: DebrisSyncOptions): void { this.syncOptions = options; }

    disableSync(): void { this.syncOptions = null; this.freezeQueue.length = 0; }

    isSyncEnabled(): boolean { return this.syncOptions !== null; }

    /**
     * Apply a batch of authoritative freeze events. For each event, the
     * matching local debris is snapped to the supplied transform and
     * frozen. Unknown IDs are silently ignored (debris may have already
     * been removed locally, e.g. it fell off the world).
     */
    applyFreezeBatch(events: DebrisFreezeEvent[]): void {
        for (const evt of events) {
            const entry = this.entriesById.get(evt.id);
            if (!entry || entry.isSettled || !entry.body.isValid()) continue;
            entry.body.setTranslation({ x: evt.px, y: evt.py, z: evt.pz }, true);
            entry.body.setRotation({ x: evt.qx, y: evt.qy, z: evt.qz, w: evt.qw }, true);
            entry.body.setBodyType(1, true);

            if (entry.pool && entry.instanceIndex >= 0) {
                _pos.set(evt.px, evt.py, evt.pz);
                _quat.set(evt.qx, evt.qy, evt.qz, evt.qw);
                _mat4.compose(_pos, _quat, _scale);
                entry.pool.instancedMesh.setMatrixAt(entry.instanceIndex, _mat4);
                entry.pool.instancedMesh.instanceMatrix.needsUpdate = true;
            }

            // The early-continue above already filtered out settled entries.
            entry.isSettled = true;
            if (entry.pool) {
                this.voxelActiveCount--;
                this.voxelSettledCount++;
            }
        }
    }

    // ── Spawn ─────────────────────────────────────────────────────

    /**
     * Track a single-voxel explosion piece. Caller supplies the dynamic
     * body + collider it has already created at the leaf's world transform;
     * we render it via a shared InstancedMesh pool keyed on `voxelSize`.
     *
     * Enforces the max-active cap: if `voxelActiveCount` is at `maxDebris`
     * the oldest active entry is evicted first.
     *
     * @param debrisId Optional deterministic ID (for network sync). When
     * omitted an auto-incrementing local ID is assigned.
     */
    spawnVoxel(
        body: RAPIER.RigidBody,
        collider: RAPIER.Collider,
        physicsWorld: PhysicsWorld,
        r: number, g: number, b: number,
        voxelSize: number,
        parentGroup: THREE.Object3D,
        debrisId?: number,
    ): void {
        while (this.voxelActiveCount >= this.maxDebris) {
            if (!this.removeOldestActive()) break;
        }

        const pool = this.getOrCreatePool(voxelSize, parentGroup);
        if (pool.activeCount >= pool.capacity) this.growPool(pool);

        const idx = pool.activeCount;
        const pos = body.translation();
        const rot = body.rotation();
        _pos.set(pos.x, pos.y, pos.z);
        _quat.set(rot.x, rot.y, rot.z, rot.w);
        _mat4.compose(_pos, _quat, _scale);
        pool.instancedMesh.setMatrixAt(idx, _mat4);
        pool.instancedMesh.setColorAt(idx, _color.setRGB(r, g, b));

        const id = debrisId ?? this.nextAutoId++;
        const entry: Entry = {
            id, body, collider, physicsWorld,
            leafCount: 1,
            createdAt: performance.now(),
            simElapsedSec: 0,
            despawnAtSec: this.pickDespawnAt(1),
            voxelObject: null,
            pool, instanceIndex: idx,
            hasBeenFlung: false,
            sleepStartTime: null,
            isSettled: false,
            stuckChecksDone: 0,
            stuckMaxLinSqSinceCheck: 0,
        };
        pool.entries[idx] = entry;
        pool.activeCount++;
        pool.instancedMesh.count = pool.activeCount;
        pool.instancedMesh.instanceMatrix.needsUpdate = true;
        if (pool.instancedMesh.instanceColor) pool.instancedMesh.instanceColor.needsUpdate = true;

        this.entries.add(entry);
        this.entriesById.set(id, entry);
        this.voxelActiveCount++;
    }

    /**
     * Track an already-detached `VoxelObject` (chunk debris). Caller is
     * responsible for switching the object to a dynamic body and
     * reparenting to the scene root; we just sync its visual transform
     * each frame and run the stuck-fragment check on it.
     *
     * `options.forceTtl` opts the chunk into the same timed despawn as
     * individual-voxel debris regardless of its leaf count. Used for
     * `'shatter'` props (a smashed cactus releases ~60 chunks at once), where
     * the default "large chunks are permanent" rule would otherwise let a
     * long play session pile up thousands of resting bodies. A game that
     * disables TTL outright (`setIndividualVoxelLeafThreshold(0)`) still wins:
     * the request routes through the same policy and stays permanent.
     */
    spawnChunk(voxelObject: VoxelObject, options?: { forceTtl?: boolean }): void {
        const body = voxelObject.getRigidBody();
        const physicsWorld = voxelObject.getPhysicsWorld();
        if (!body || !physicsWorld) {
            console.warn('voxelObjectDebris.spawnChunk: voxelObject missing body or physics world');
            return;
        }
        const leaves = voxelObject.getOctreeLeaves();
        const leafCount = leaves ? leaves.length : 1;
        const ttlLeafCount = options?.forceTtl ? 1 : leafCount;
        const id = this.nextAutoId++;
        const entry: Entry = {
            id, body, collider: null, physicsWorld,
            leafCount,
            createdAt: performance.now(),
            simElapsedSec: 0,
            despawnAtSec: this.pickDespawnAt(ttlLeafCount),
            voxelObject,
            pool: null,
            instanceIndex: -1,
            hasBeenFlung: false,
            sleepStartTime: null,
            isSettled: false,
            stuckChecksDone: 0,
            stuckMaxLinSqSinceCheck: 0,
        };
        this.entries.add(entry);
        this.entriesById.set(id, entry);
    }

    // ── Per-frame ─────────────────────────────────────────────────

    /**
     * `deltaTime` is the *simulated* delta time in seconds (same value
     * passed to `physicsWorld.step`). Sim-time keeps TTL and stuck-frag
     * scheduling correct during frame-by-frame screen recording. Wall-
     * time is still used for the settle-after-low-velocity delay since
     * that's been working in seconds-of-real-time for a while.
     */
    update(deltaTime: number): void {
        const now = performance.now();
        const toRemove: Entry[] = [];
        const toSettle: Entry[] = [];
        const newChunks: VoxelObject[] = [];

        // Authority alone runs the local settle path; clients defer to
        // server freeze events.
        const skipLocalSettle = this.syncOptions !== null && !this.syncOptions.isAuthority;

        for (const entry of this.entries) {
            if (!entry.body.isValid()) {
                toRemove.push(entry);
                continue;
            }
            const pos = entry.body.translation();
            if (pos.y < FALL_OFF_Y) {
                toRemove.push(entry);
                continue;
            }

            // TTL: advance and check despawn for every entry, even
            // settled ones — they should still age out so the world
            // doesn't accumulate frozen chips forever.
            entry.simElapsedSec += deltaTime;
            if (entry.simElapsedSec >= entry.despawnAtSec) {
                toRemove.push(entry);
                continue;
            }

            // Once a voxel-flavour entry has been frozen via setBodyType,
            // its transform never changes — no matrix sync needed, no
            // settle re-check, no stuck check.
            if (entry.isSettled) continue;

            // Visual sync (skipped above for settled).
            if (entry.voxelObject) {
                entry.voxelObject.syncWithPhysics();
            } else if (entry.pool && entry.instanceIndex >= 0) {
                const rot = entry.body.rotation();
                _pos.set(pos.x, pos.y, pos.z);
                _quat.set(rot.x, rot.y, rot.z, rot.w);
                _mat4.compose(_pos, _quat, _scale);
                entry.pool.instancedMesh.setMatrixAt(entry.instanceIndex, _mat4);
                entry.pool.instancedMesh.instanceMatrix.needsUpdate = true;
            }

            // Settle-freeze detection (both voxels and chunk fragments).
            // Once the body has been moving fast (hasBeenFlung) then later
            // stays slow for `consolidationDelayMs`, we flip it back to a
            // Fixed rigid body so Rapier excludes it from the dynamic island
            // entirely.
            if (this.consolidationEnabled && !skipLocalSettle) {
                const lv = entry.body.linvel();
                const av = entry.body.angvel();
                const linSpeed = Math.sqrt(lv.x * lv.x + lv.y * lv.y + lv.z * lv.z);
                const angSpeed = Math.sqrt(av.x * av.x + av.y * av.y + av.z * av.z);
                if (!entry.hasBeenFlung && linSpeed > 1.0) entry.hasBeenFlung = true;

                const slow = entry.hasBeenFlung && (
                    entry.body.isSleeping() ||
                    (linSpeed < this.lowVelocityThreshold && angSpeed < this.lowVelocityThreshold)
                );
                if (slow) {
                    if (entry.sleepStartTime === null) {
                        entry.sleepStartTime = now;
                    } else if (now - entry.sleepStartTime >= this.consolidationDelayMs) {
                        toSettle.push(entry);
                    }
                } else if (entry.hasBeenFlung) {
                    entry.sleepStartTime = null;
                }
            }

            // Stuck-chunk peak-velocity tracking (only during the first
            // window, so the split decision can distinguish "still
            // flying" from "wedged in place").
            if (entry.voxelObject && entry.stuckChecksDone === 0) {
                const lv = entry.body.linvel();
                const linSq = lv.x * lv.x + lv.y * lv.y + lv.z * lv.z;
                if (linSq > entry.stuckMaxLinSqSinceCheck) entry.stuckMaxLinSqSinceCheck = linSq;
            }

            // Stuck-chunk jitter-split scheduling.
            if (entry.voxelObject && entry.stuckChecksDone < STUCK_CHECK_SCHEDULE_SEC.length) {
                const scheduledAt = STUCK_CHECK_SCHEDULE_SEC[entry.stuckChecksDone];
                if (scheduledAt !== undefined && entry.simElapsedSec >= scheduledAt) {
                    const isFirstCheck = entry.stuckChecksDone === 0;
                    entry.stuckChecksDone++;
                    if (entry.body.isSleeping()) {
                        entry.stuckChecksDone = STUCK_CHECK_SCHEDULE_SEC.length;
                    } else {
                        let shouldSplit: boolean;
                        if (isFirstCheck) {
                            shouldSplit = entry.stuckMaxLinSqSinceCheck < STUCK_FIRST_CHECK_MOVING_LINSPEED_SQ;
                            entry.stuckMaxLinSqSinceCheck = 0;
                        } else {
                            shouldSplit = true;
                        }
                        if (shouldSplit) {
                            const k = Math.max(
                                STUCK_MIN_PIECES,
                                Math.min(STUCK_MAX_PIECES, Math.ceil(entry.leafCount / STUCK_TARGET_LEAVES_PER_PIECE)),
                            );
                            const pieces = entry.voxelObject.splitInPlace(k);
                            if (pieces.length > 0) {
                                toRemove.push(entry);
                                newChunks.push(...pieces);
                            }
                        }
                    }
                }
            }
        }

        for (const entry of toSettle) this.settleEntry(entry);
        for (const entry of toRemove) this.remove(entry);
        for (const p of newChunks) this.spawnChunk(p);

        // Drain freeze queue on the authority.
        if (this.syncOptions?.isAuthority && this.freezeQueue.length > 0) {
            const max = this.syncOptions.maxFreezesPerFrame;
            const batch = this.freezeQueue.splice(0, max);
            this.syncOptions.onFreezeBatch(batch);
        }
    }

    // ── Explosion push / re-blast ─────────────────────────────────

    /**
     * Apply a radial impulse to every tracked entry inside `radius` of
     * `center`. Falloff is linear and the impulse is mass-scaled so heavy
     * chunks don't accelerate away faster than light chips. Wakes settled
     * voxel-flavour entries by switching them back to dynamic — a nearby
     * explosion should be able to disturb already-resting debris.
     */
    pushInRadius(
        center: THREE.Vector3,
        radius: number,
        impulseStrength: number,
        impulseUp: number,
    ): number {
        if (radius <= 0) return 0;
        const radiusSq = radius * radius;
        let count = 0;
        for (const entry of this.entries) {
            if (!entry.body.isValid()) continue;
            const pos = entry.body.translation();
            const dx = pos.x - center.x;
            const dy = pos.y - center.y;
            const dz = pos.z - center.z;
            const distSq = dx * dx + dy * dy + dz * dz;
            if (distSq > radiusSq) continue;
            const dist = Math.sqrt(distSq);
            const falloff = 1 - dist / radius;

            // Unfreeze settled voxel-flavour entries so the impulse takes effect.
            if (entry.isSettled) {
                entry.body.setBodyType(0, true);
                entry.isSettled = false;
                entry.sleepStartTime = null;
                entry.hasBeenFlung = false;
                if (entry.pool) {
                    this.voxelSettledCount--;
                    this.voxelActiveCount++;
                }
            }

            const mass = entry.body.mass();

            let ix: number, iy: number, iz: number;
            if (dist > 0.01) {
                ix = (dx / dist) * impulseStrength;
                iy = (dy / dist) * impulseStrength + impulseUp;
                iz = (dz / dist) * impulseStrength;
            } else {
                const angle = Math.random() * Math.PI * 2;
                ix = Math.cos(angle) * impulseStrength;
                iy = impulseStrength + impulseUp;
                iz = Math.sin(angle) * impulseStrength;
            }

            entry.body.wakeUp();
            entry.body.applyImpulse(
                { x: ix * mass * falloff, y: iy * mass * falloff, z: iz * mass * falloff },
                true,
            );
            entry.body.applyTorqueImpulse({
                x: (Math.random() - 0.5) * 4 * mass * falloff,
                y: (Math.random() - 0.5) * 4 * mass * falloff,
                z: (Math.random() - 0.5) * 4 * mass * falloff,
            }, true);
            count++;
        }
        return count;
    }

    // ── Cleanup helpers ───────────────────────────────────────────

    /** Drop every entry whose body belongs to the given physics world. */
    clearForWorld(physicsWorld: PhysicsWorld): void {
        const victims: Entry[] = [];
        for (const entry of this.entries) {
            if (entry.physicsWorld === physicsWorld) victims.push(entry);
        }
        for (const entry of victims) this.remove(entry);
    }

    /** Debug stats. */
    getStats(): { total: number; voxelActive: number; voxelSettled: number; chunks: number } {
        let chunks = 0;
        for (const e of this.entries) if (e.voxelObject) chunks++;
        return {
            total: this.entries.size,
            voxelActive: this.voxelActiveCount,
            voxelSettled: this.voxelSettledCount,
            chunks,
        };
    }

    // ── Internal ──────────────────────────────────────────────────

    /**
     * Freeze a voxel-flavour entry as a fixed body with a small z-fighting
     * offset. On the authority, also queues a freeze event for network
     * broadcast.
     */
    private settleEntry(entry: Entry): void {
        const pos = entry.body.translation();
        const rot = entry.body.rotation();

        // Per-voxel debris: apply the small Y offset that prevents stacked
        // debris cubes from z-fighting on the InstancedMesh. Chunks are
        // rendered via their own VoxelObject mesh and don't share faces with
        // siblings, so no offset is needed.
        let finalY = pos.y;
        if (entry.pool && entry.instanceIndex >= 0) {
            const offset = (this.settleOffsetCounter % SETTLE_OFFSET_WRAP) * SETTLE_OFFSET_STEP;
            this.settleOffsetCounter++;
            finalY = pos.y + offset;
            entry.body.setTranslation({ x: pos.x, y: finalY, z: pos.z }, true);

            _pos.set(pos.x, finalY, pos.z);
            _quat.set(rot.x, rot.y, rot.z, rot.w);
            _mat4.compose(_pos, _quat, _scale);
            entry.pool.instancedMesh.setMatrixAt(entry.instanceIndex, _mat4);
            entry.pool.instancedMesh.instanceMatrix.needsUpdate = true;

            this.voxelActiveCount--;
            this.voxelSettledCount++;
        }

        // Flip the body to Fixed so Rapier drops it from the dynamic island
        // and broadphase pair generation.
        entry.body.setBodyType(1, true);
        entry.isSettled = true;

        // Now that the body is Fixed, collapse the chunk's N cuboid colliders
        // (required while dynamic) into a single trimesh. Drops post-explosion
        // collider count by ~5-10× and shrinks broadphase load proportionally.
        if (entry.voxelObject) {
            entry.voxelObject.rebuildCollidersAsTrimesh();
        }

        if (this.syncOptions?.isAuthority) {
            this.freezeQueue.push({
                id: entry.id,
                px: pos.x, py: finalY, pz: pos.z,
                qx: rot.x, qy: rot.y, qz: rot.z, qw: rot.w,
            });
        }
    }

    /**
     * Evict the oldest still-active voxel-flavour entry. Returns true if
     * one was found and removed.
     */
    private removeOldestActive(): boolean {
        let oldest: Entry | null = null;
        for (const entry of this.entries) {
            if (entry.isSettled || !entry.pool) continue;
            if (!oldest || entry.createdAt < oldest.createdAt) oldest = entry;
        }
        if (!oldest) return false;
        this.remove(oldest);
        return true;
    }

    /** Tear down an entry's resources and forget it. */
    private remove(entry: Entry): void {
        this.dispose(entry);
        this.entries.delete(entry);
        this.entriesById.delete(entry.id);
    }

    private dispose(entry: Entry): void {
        if (entry.pool) {
            this.removeFromPool(entry);
            if (entry.isSettled) this.voxelSettledCount--;
            else this.voxelActiveCount--;
        }
        if (entry.collider && entry.collider.isValid()) {
            entry.physicsWorld.removeCollider(entry.collider);
        }
        if (entry.body.isValid()) entry.physicsWorld.removeRigidBody(entry.body);
        if (entry.voxelObject) {
            if (entry.voxelObject.parent) entry.voxelObject.parent.remove(entry.voxelObject);
            entry.voxelObject.dispose();
        }
    }

    // ── Pool plumbing ─────────────────────────────────────────────

    private getOrCreatePool(voxelSize: number, parentGroup: THREE.Object3D): InstancedPool {
        const existing = this.pools.get(voxelSize);
        if (existing) return existing;

        const geometry = new THREE.BoxGeometry(voxelSize, voxelSize, voxelSize);
        if (!this.coloredMaterial) {
            this.coloredMaterial = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
        }
        const instancedMesh = new THREE.InstancedMesh(geometry, this.coloredMaterial, POOL_INITIAL_CAPACITY);
        instancedMesh.count = 0;
        instancedMesh.castShadow = true;
        instancedMesh.receiveShadow = true;
        instancedMesh.frustumCulled = false;
        instancedMesh.name = `VoxelObjectDebrisPool_${voxelSize}`;
        instancedMesh.instanceColor = new THREE.InstancedBufferAttribute(
            new Float32Array(POOL_INITIAL_CAPACITY * 3), 3,
        );
        parentGroup.add(instancedMesh);

        const pool: InstancedPool = {
            voxelSize,
            instancedMesh,
            entries: new Array(POOL_INITIAL_CAPACITY).fill(null),
            activeCount: 0,
            capacity: POOL_INITIAL_CAPACITY,
        };
        this.pools.set(voxelSize, pool);
        return pool;
    }

    private growPool(pool: InstancedPool): void {
        const newCapacity = pool.capacity * 2;
        const oldMesh = pool.instancedMesh;
        const newMesh = new THREE.InstancedMesh(oldMesh.geometry, oldMesh.material, newCapacity);
        newMesh.count = pool.activeCount;
        newMesh.castShadow = true;
        newMesh.receiveShadow = true;
        newMesh.frustumCulled = false;
        newMesh.name = oldMesh.name;
        newMesh.instanceColor = new THREE.InstancedBufferAttribute(
            new Float32Array(newCapacity * 3), 3,
        );

        for (let i = 0; i < pool.activeCount; i++) {
            oldMesh.getMatrixAt(i, _mat4);
            newMesh.setMatrixAt(i, _mat4);
            oldMesh.getColorAt(i, _color);
            newMesh.setColorAt(i, _color);
        }
        newMesh.instanceMatrix.needsUpdate = true;
        if (newMesh.instanceColor) newMesh.instanceColor.needsUpdate = true;

        if (oldMesh.parent) {
            oldMesh.parent.add(newMesh);
            oldMesh.parent.remove(oldMesh);
        }
        oldMesh.dispose();

        const newEntries: (Entry | null)[] = new Array(newCapacity).fill(null);
        for (let i = 0; i < pool.activeCount; i++) {
            newEntries[i] = pool.entries[i] ?? null;
        }

        pool.instancedMesh = newMesh;
        pool.entries = newEntries;
        pool.capacity = newCapacity;
    }

    /**
     * Swap-remove: move the last active slot into the freed slot so the
     * instance range stays a dense prefix.
     */
    private removeFromPool(entry: Entry): void {
        const pool = entry.pool;
        const idx = entry.instanceIndex;
        if (!pool || idx < 0) return;
        const lastIdx = pool.activeCount - 1;

        if (idx !== lastIdx && lastIdx >= 0) {
            const lastEntry = pool.entries[lastIdx]!;
            pool.instancedMesh.getMatrixAt(lastIdx, _mat4);
            pool.instancedMesh.setMatrixAt(idx, _mat4);
            if (pool.instancedMesh.instanceColor) {
                pool.instancedMesh.getColorAt(lastIdx, _color);
                pool.instancedMesh.setColorAt(idx, _color);
            }
            lastEntry.instanceIndex = idx;
            pool.entries[idx] = lastEntry;
        }

        pool.entries[lastIdx < 0 ? 0 : lastIdx] = null;
        pool.activeCount = Math.max(0, pool.activeCount - 1);
        pool.instancedMesh.count = pool.activeCount;
        pool.instancedMesh.instanceMatrix.needsUpdate = true;
        if (pool.instancedMesh.instanceColor) pool.instancedMesh.instanceColor.needsUpdate = true;
    }

    private pickDespawnAt(leafCount: number): number {
        if (leafCount === 0 || leafCount > this.individualVoxelLeafThreshold) return Infinity;
        return this.ttlMinSec + Math.random() * (this.ttlMaxSec - this.ttlMinSec);
    }
}

export const voxelObjectDebris = new VoxelObjectDebrisImpl();
