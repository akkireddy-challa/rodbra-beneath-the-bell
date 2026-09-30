import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import type { VoxelWorld } from 'engine/VoxelWorld.js';
import { getVoxelTextureAtlas } from 'engine/VoxelTextureAtlas.js';
import { voxelObjectDebris } from 'engine/VoxelObjectDebris.js';
import { boneVoxelLimbs } from 'engine/effects/BoneVoxelShatter.js';

export interface VoxelDebris {
    body: RAPIER.RigidBody;
    collider: RAPIER.Collider;
    /** Deterministic ID for network sync. Present on debris from DeterministicDestruction. */
    id?: number;
}

/**
 * A single freeze event — one debris piece that has settled on the authority
 * and should be frozen at a specific transform on all clients.
 */
export interface DebrisFreezeEvent {
    id: number;
    px: number; py: number; pz: number;
    qx: number; qy: number; qz: number; qw: number;
}

/**
 * Options for enabling networked debris freeze sync.
 *
 * When enabled, the authority (server) queues freeze events when debris settles
 * and drains them in batches each frame via `onFreezeBatch`.  Clients skip
 * auto-settling and instead freeze debris only when `applyFreezeBatch` is called.
 */
export interface DebrisSyncOptions {
    /** Whether this instance is the authority (server). */
    isAuthority: boolean;
    /** Max freeze events drained per frame (rest are queued). */
    maxFreezesPerFrame: number;
    /** Called on the authority each frame there are queued freezes. */
    onFreezeBatch: (batch: DebrisFreezeEvent[]) => void;
}

const MAX_DEBRIS_DEFAULT = 512;
const POOL_INITIAL_CAPACITY = 128;

const _mat4 = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3(1, 1, 1);
const _color = new THREE.Color();

interface DebrisPool {
    instancedMesh: THREE.InstancedMesh;
    entries: (DebrisEntry | null)[];
    activeCount: number;
    capacity: number;
}

interface DebrisEntry {
    id: number;
    body: RAPIER.RigidBody;
    collider: RAPIER.Collider;
    physicsWorld: PhysicsWorld;
    pool: DebrisPool;
    instanceIndex: number;
    sleepStartTime: number | null;
    blockType: number;
    createdAt: number;
    isSettled: boolean;
    hasBeenFlung: boolean;
}

/**
 * Global debris manager using InstancedMesh pools for rendering.
 *
 * Each unique (blockType, voxelSize) combination gets its own InstancedMesh,
 * collapsing hundreds of individual draw calls into a handful.
 * Physics bodies are still individual (Rapier cuboids) but without CCD
 * or collision events for much lower simulation cost.
 *
 * Sleeping debris is automatically merged into terrain chunks after a
 * configurable delay, eliminating both physics and rendering overhead.
 * Merged debris becomes real terrain blocks with colliders and can be
 * re-destroyed by future explosions.
 */
class VoxelDebrisManagerImpl {
    private allDebris: Set<DebrisEntry> = new Set();
    private debrisById: Map<number, DebrisEntry> = new Map();
    private settledCount: number = 0;
    private pools: Map<string, DebrisPool> = new Map();
    private geometryCache: Map<string, THREE.BufferGeometry> = new Map();
    private sharedMaterial: THREE.Material | null = null;

    private consolidationDelay: number = 1000;
    private consolidationEnabled: boolean = true;
    private dirtyWorlds: Set<VoxelWorld> = new Set();
    private lowVelocityThreshold: number = 0.3;
    private maxDebris: number = MAX_DEBRIS_DEFAULT;
    private settleOffsetCounter: number = 0;
    private static readonly SETTLE_OFFSET_STEP = 0.002;
    private static readonly SETTLE_OFFSET_WRAP = 50;

    // ── Network sync ──
    private syncOptions: DebrisSyncOptions | null = null;
    private freezeQueue: DebrisFreezeEvent[] = [];
    /** Auto IDs for non-deterministic debris start high to avoid colliding with
     *  deterministic IDs (which are 32-bit hashes in the 0–0x7FFFFFFF range). */
    private nextAutoId: number = 0x80000000;

    setConsolidationEnabled(enabled: boolean): void {
        this.consolidationEnabled = enabled;
        voxelObjectDebris.setConsolidationEnabled(enabled);
    }

    setConsolidationDelay(delayMs: number): void {
        this.consolidationDelay = delayMs;
        voxelObjectDebris.setConsolidationDelay(delayMs);
    }

    setLowVelocityThreshold(threshold: number): void {
        this.lowVelocityThreshold = threshold;
        voxelObjectDebris.setLowVelocityThreshold(threshold);
    }

    setMaxDebris(max: number): void {
        this.maxDebris = max;
        voxelObjectDebris.setMaxDebris(max);
    }

    /**
     * Spawn a debris piece. The manager owns the visual representation via
     * InstancedMesh — callers must NOT create meshes for debris.
     *
     * @param debrisId Optional deterministic ID for network sync. When omitted,
     *   an auto-incrementing local ID is assigned.
     */
    spawnDebris(
        body: RAPIER.RigidBody,
        collider: RAPIER.Collider,
        physicsWorld: PhysicsWorld,
        blockType: number,
        voxelSize: number,
        parentGroup: THREE.Object3D,
        debrisId?: number,
    ): void {
        while (this.allDebris.size - this.settledCount >= this.maxDebris) {
            this.removeOldestActive();
        }

        const pool = this.getOrCreatePool(blockType, voxelSize, parentGroup);
        if (pool.activeCount >= pool.capacity) {
            this.growPool(pool);
        }

        const idx = pool.activeCount;
        const pos = body.translation();
        const rot = body.rotation();
        _pos.set(pos.x, pos.y, pos.z);
        _quat.set(rot.x, rot.y, rot.z, rot.w);
        _mat4.compose(_pos, _quat, _scale);
        pool.instancedMesh.setMatrixAt(idx, _mat4);

        const id = debrisId ?? this.nextAutoId++;

        const entry: DebrisEntry = {
            id, body, collider, physicsWorld,
            pool, instanceIndex: idx,
            sleepStartTime: null,
            blockType,
            createdAt: performance.now(),
            isSettled: false,
            hasBeenFlung: false,
        };

        pool.entries[idx] = entry;
        pool.activeCount++;
        pool.instancedMesh.count = pool.activeCount;
        pool.instancedMesh.instanceMatrix.needsUpdate = true;

        this.allDebris.add(entry);
        this.debrisById.set(id, entry);
    }

    /**
     * Spawn a colored debris piece (for octree V2 objects with per-leaf RGB colors).
     * Uses per-instance color on the InstancedMesh instead of atlas UVs.
     * Colors are in 0–1 float range.
     *
     * @param debrisId Optional deterministic ID for network sync.
     */
    spawnColoredDebris(
        body: RAPIER.RigidBody,
        collider: RAPIER.Collider,
        physicsWorld: PhysicsWorld,
        r: number, g: number, b: number,
        voxelSize: number,
        parentGroup: THREE.Object3D,
        debrisId?: number,
    ): void {
        // All voxel-object debris (per-leaf RGB) lives in the unified
        // `voxelObjectDebris` registry, so it shares TTL / push-on-blast /
        // network sync / stuck checks with every other voxel-object
        // explosion path. This method stays as the published API for
        // external callers — they don't need to switch import sites.
        voxelObjectDebris.spawnVoxel(body, collider, physicsWorld, r, g, b, voxelSize, parentGroup, debrisId);
    }

    /**
     * Update debris positions, cleanup fallen debris, and merge sleeping debris.
     * Call from game loop, NOT from physics callbacks.
     */
    update(): void {
        this.dirtyWorlds.clear();

        const toRemove: DebrisEntry[] = [];
        const toMerge: DebrisEntry[] = [];
        const toSettle: DebrisEntry[] = [];
        const now = performance.now();
        const dirtyPools = new Set<DebrisPool>();

        // When sync is enabled and we are NOT the authority, skip colored-debris
        // auto-settle — the server will tell us when and where to freeze.
        const skipColoredSettle = this.syncOptions !== null && !this.syncOptions.isAuthority;

        for (const entry of this.allDebris) {
            try {
                if (!entry.body.isValid()) {
                    if (entry.isSettled) this.settledCount--;
                    toRemove.push(entry);
                    continue;
                }

                if (entry.isSettled) continue;

                const pos = entry.body.translation();
                const rot = entry.body.rotation();

                if (pos.y < -100) {
                    toRemove.push(entry);
                    continue;
                }

                _pos.set(pos.x, pos.y, pos.z);
                _quat.set(rot.x, rot.y, rot.z, rot.w);
                _mat4.compose(_pos, _quat, _scale);
                entry.pool.instancedMesh.setMatrixAt(entry.instanceIndex, _mat4);
                dirtyPools.add(entry.pool);

                if (this.consolidationEnabled) {
                    const linvel = entry.body.linvel();
                    const angvel = entry.body.angvel();
                    const linearSpeed = Math.sqrt(linvel.x * linvel.x + linvel.y * linvel.y + linvel.z * linvel.z);
                    const angularSpeed = Math.sqrt(angvel.x * angvel.x + angvel.y * angvel.y + angvel.z * angvel.z);

                    if (!entry.hasBeenFlung && linearSpeed > 1.0) {
                        entry.hasBeenFlung = true;
                    }

                    const isMovementSettled = entry.hasBeenFlung && (
                        entry.body.isSleeping() ||
                        (linearSpeed < this.lowVelocityThreshold && angularSpeed < this.lowVelocityThreshold)
                    );

                    if (isMovementSettled) {
                        if (entry.sleepStartTime === null) {
                            entry.sleepStartTime = now;
                        } else if (now - entry.sleepStartTime >= this.consolidationDelay) {
                            const userData = entry.physicsWorld.getUserDataFromHandle(entry.body.handle) as {
                                voxelWorld?: VoxelWorld; color?: { r: number; g: number; b: number };
                            } | null;
                            if (userData?.color) {
                                if (!skipColoredSettle) {
                                    toSettle.push(entry);
                                }
                            } else if (userData?.voxelWorld) {
                                toMerge.push(entry);
                            }
                        }
                    } else if (entry.hasBeenFlung) {
                        entry.sleepStartTime = null;
                    }
                }
            } catch {
                if (entry.isSettled) this.settledCount--;
                toRemove.push(entry);
            }
        }

        for (const pool of dirtyPools) {
            pool.instancedMesh.instanceMatrix.needsUpdate = true;
        }

        for (const entry of toMerge) {
            this.mergeIntoChunk(entry);
            this.removeEntry(entry);
        }

        for (const world of this.dirtyWorlds) world.rebuildDirtyChunks();

        for (const entry of toSettle) {
            this.settleEntry(entry);
        }

        for (const entry of toRemove) {
            this.removeEntry(entry);
        }

        // Drain freeze queue (authority only)
        if (this.syncOptions?.isAuthority && this.freezeQueue.length > 0) {
            const max = this.syncOptions.maxFreezesPerFrame;
            const batch = this.freezeQueue.splice(0, max);
            this.syncOptions.onFreezeBatch(batch);
        }
    }

    clearForWorld(physicsWorld: PhysicsWorld): void {
        const toRemove: DebrisEntry[] = [];
        for (const entry of this.allDebris) {
            if (entry.physicsWorld === physicsWorld) {
                toRemove.push(entry);
            }
        }
        for (const entry of toRemove) {
            if (entry.isSettled) this.settledCount--;
            this.removeEntry(entry);
        }
        voxelObjectDebris.clearForWorld(physicsWorld);
        boneVoxelLimbs.clearForWorld(physicsWorld);
    }

    // ── Network sync API ──────────────────────────────────────────────

    /**
     * Enable networked debris freeze sync.
     *
     * - **Authority** (server): debris settles locally as normal and freeze
     *   events are queued.  Each frame, up to `maxFreezesPerFrame` events are
     *   drained and passed to `onFreezeBatch`.
     * - **Client**: colored-debris auto-settle is disabled.  The client must
     *   call `applyFreezeBatch` with events received from the server.
     */
    enableSync(options: DebrisSyncOptions): void {
        this.syncOptions = options;
        // Mirror to the voxel-object registry so a single call enables sync
        // for both terrain debris (this manager) and voxel-object debris
        // (`voxelObjectDebris`). Both queues drain via the same callback.
        voxelObjectDebris.enableSync(options);
    }

    /** Disable networked sync and return to local-only settling. */
    disableSync(): void {
        this.syncOptions = null;
        this.freezeQueue.length = 0;
        voxelObjectDebris.disableSync();
    }

    /** Whether network sync is currently enabled. */
    isSyncEnabled(): boolean {
        return this.syncOptions !== null;
    }

    /**
     * Apply a batch of freeze events received from the server.
     * For each event, the matching local debris is snapped to the
     * authoritative position/rotation and frozen as a static collider.
     *
     * The server's position already includes the z-fighting offset,
     * so we freeze directly without adding another offset.
     *
     * Unknown IDs are silently ignored (the debris may have already been
     * removed locally, e.g. it fell below y=-100).
     */
    applyFreezeBatch(events: DebrisFreezeEvent[]): void {
        for (const evt of events) {
            const entry = this.debrisById.get(evt.id);
            if (!entry || entry.isSettled || !entry.body.isValid()) continue;

            entry.body.setTranslation({ x: evt.px, y: evt.py, z: evt.pz }, true);
            entry.body.setRotation({ x: evt.qx, y: evt.qy, z: evt.qz, w: evt.qw }, true);
            entry.body.setBodyType(1, true);

            _pos.set(evt.px, evt.py, evt.pz);
            _quat.set(evt.qx, evt.qy, evt.qz, evt.qw);
            _mat4.compose(_pos, _quat, _scale);
            entry.pool.instancedMesh.setMatrixAt(entry.instanceIndex, _mat4);
            entry.pool.instancedMesh.instanceMatrix.needsUpdate = true;

            entry.isSettled = true;
            this.settledCount++;
        }
        // Forward unrecognised IDs to the voxel-object registry. The two
        // registries use disjoint ID spaces (terrain uses 0-0x7FFFFFFF
        // deterministic hashes / its own auto IDs; voxel-object uses
        // 0x80000000+ auto IDs and the same deterministic-hash space),
        // so applying the batch to both registries is safe — each only
        // acts on events for IDs it owns.
        voxelObjectDebris.applyFreezeBatch(events);
    }

    explodeDebrisBody(
        body: RAPIER.RigidBody,
        physicsWorld: PhysicsWorld,
        explosionCenter: THREE.Vector3,
        impulseStrength: number = 5,
        impulseUp: number = 2
    ): boolean {
        const userData = physicsWorld.getUserDataFromHandle(body.handle) as { isVoxelDebris?: boolean } | null;
        if (!userData?.isVoxelDebris) return false;
        if (!body.isValid()) return false;

        const pos = body.translation();
        const dx = pos.x - explosionCenter.x;
        const dy = pos.y - explosionCenter.y;
        const dz = pos.z - explosionCenter.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

        let impulseX: number, impulseY: number, impulseZ: number;
        if (dist > 0.01) {
            impulseX = (dx / dist) * impulseStrength;
            impulseY = (dy / dist) * impulseStrength + impulseUp;
            impulseZ = (dz / dist) * impulseStrength;
        } else {
            const angle = Math.random() * Math.PI * 2;
            impulseX = Math.cos(angle) * impulseStrength;
            impulseY = impulseStrength + impulseUp;
            impulseZ = Math.sin(angle) * impulseStrength;
        }

        for (const entry of this.allDebris) {
            if (entry.body === body) {
                if (entry.isSettled) {
                    entry.isSettled = false;
                    this.settledCount--;
                    body.setBodyType(0, true);
                }
                entry.sleepStartTime = null;
                entry.hasBeenFlung = false;
                break;
            }
        }

        body.wakeUp();
        const mass = body.mass();
        body.applyImpulse({ x: impulseX * mass, y: impulseY * mass, z: impulseZ * mass }, true);
        body.applyTorqueImpulse({
            x: (Math.random() - 0.5) * 8 * mass,
            y: (Math.random() - 0.5) * 8 * mass,
            z: (Math.random() - 0.5) * 8 * mass
        }, true);

        return true;
    }

    explodeDebrisInRadius(
        center: THREE.Vector3,
        radius: number,
        impulseStrength: number = 5,
        impulseUp: number = 2
    ): number {
        let count = 0;
        const radiusSq = radius * radius;
        const wakeRadiusSq = (radius * 2) * (radius * 2);

        for (const entry of this.allDebris) {
            if (!entry.body.isValid()) continue;

            const pos = entry.body.translation();
            const dx = pos.x - center.x;
            const dy = pos.y - center.y;
            const dz = pos.z - center.z;
            const distSq = dx * dx + dy * dy + dz * dz;

            if (distSq <= radiusSq) {
                if (entry.isSettled) {
                    entry.isSettled = false;
                    this.settledCount--;
                    entry.body.setBodyType(0, true);
                }
                this.explodeDebrisBody(entry.body, entry.physicsWorld, center, impulseStrength, impulseUp);
                entry.sleepStartTime = null;
                entry.hasBeenFlung = false;
                count++;
            } else if (distSq <= wakeRadiusSq && !entry.isSettled) {
                entry.body.wakeUp();
                entry.sleepStartTime = null;
            }
        }

        // Voxel-object debris lives in the unified registry — apply the
        // same blast there so external callers re-blast everything with
        // one call, same as before.
        count += voxelObjectDebris.pushInRadius(center, radius, impulseStrength, impulseUp);

        return count;
    }

    isDebrisBody(body: RAPIER.RigidBody, physicsWorld: PhysicsWorld): boolean {
        const userData = physicsWorld.getUserDataFromHandle(body.handle) as { isVoxelDebris?: boolean } | null;
        return userData?.isVoxelDebris === true;
    }

    getDebrisCount(): number {
        return this.allDebris.size + voxelObjectDebris.getStats().total;
    }

    getStats(): { total: number; active: number; settled: number; sleeping: number } {
        let active = 0, sleeping = 0;
        for (const entry of this.allDebris) {
            try {
                if (entry.isSettled) continue;
                if (entry.body.isValid()) {
                    if (entry.body.isSleeping()) sleeping++;
                    else active++;
                }
            } catch { /* ignore */ }
        }
        const objStats = voxelObjectDebris.getStats();
        return {
            total: this.allDebris.size + objStats.total,
            active: active + objStats.voxelActive,
            settled: this.settledCount + objStats.voxelSettled,
            sleeping,
        };
    }

    dispose(): void {
        for (const entry of this.allDebris) {
            this.removePhysics(entry);
        }
        this.allDebris.clear();
        this.debrisById.clear();
        this.settledCount = 0;
        this.freezeQueue.length = 0;
        this.syncOptions = null;

        for (const pool of this.pools.values()) {
            if (pool.instancedMesh.parent) {
                pool.instancedMesh.parent.remove(pool.instancedMesh);
            }
            pool.instancedMesh.dispose();
        }
        this.pools.clear();

        for (const geometry of this.geometryCache.values()) {
            geometry.dispose();
        }
        this.geometryCache.clear();

        if (this.sharedMaterial) {
            this.sharedMaterial.dispose();
            this.sharedMaterial = null;
        }
    }

    // ── Internal helpers ──────────────────────────────────────────────

    /**
     * Freeze a debris entry as a static collider with a small z-fighting offset.
     * On the authority, also queues a freeze event for network broadcast.
     */
    private settleEntry(entry: DebrisEntry): void {
        const offset = (this.settleOffsetCounter % VoxelDebrisManagerImpl.SETTLE_OFFSET_WRAP)
            * VoxelDebrisManagerImpl.SETTLE_OFFSET_STEP;
        this.settleOffsetCounter++;

        const pos = entry.body.translation();
        const rot = entry.body.rotation();
        entry.body.setTranslation({ x: pos.x, y: pos.y + offset, z: pos.z }, true);
        entry.body.setBodyType(1, true);

        _pos.set(pos.x, pos.y + offset, pos.z);
        _quat.set(rot.x, rot.y, rot.z, rot.w);
        _mat4.compose(_pos, _quat, _scale);
        entry.pool.instancedMesh.setMatrixAt(entry.instanceIndex, _mat4);
        entry.pool.instancedMesh.instanceMatrix.needsUpdate = true;

        entry.isSettled = true;
        this.settledCount++;

        if (this.syncOptions?.isAuthority) {
            this.freezeQueue.push({
                id: entry.id,
                px: pos.x, py: pos.y + offset, pz: pos.z,
                qx: rot.x, qy: rot.y, qz: rot.z, qw: rot.w,
            });
        }
    }

    private getPoolKey(blockType: number, voxelSize: number): string {
        return `${blockType}_${voxelSize}`;
    }

    private getOrCreatePool(blockType: number, voxelSize: number, parentGroup: THREE.Object3D): DebrisPool {
        const key = this.getPoolKey(blockType, voxelSize);
        const existing = this.pools.get(key);
        if (existing) return existing;

        const geometry = this.getOrCreateGeometry(blockType, voxelSize);
        const material = this.getSharedMaterial();

        const instancedMesh = new THREE.InstancedMesh(geometry, material, POOL_INITIAL_CAPACITY);
        instancedMesh.count = 0;
        instancedMesh.castShadow = true;
        instancedMesh.receiveShadow = true;
        instancedMesh.frustumCulled = false;
        instancedMesh.name = `VoxelDebrisPool_${blockType}`;

        parentGroup.add(instancedMesh);

        const pool: DebrisPool = {
            instancedMesh,
            entries: new Array(POOL_INITIAL_CAPACITY).fill(null),
            activeCount: 0,
            capacity: POOL_INITIAL_CAPACITY,
        };
        this.pools.set(key, pool);
        return pool;
    }

    private getSharedMaterial(): THREE.Material {
        if (!this.sharedMaterial) {
            const atlas = getVoxelTextureAtlas();
            this.sharedMaterial = atlas.createMaterial();
            (this.sharedMaterial as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
        }
        return this.sharedMaterial;
    }

    private getOrCreateGeometry(blockType: number, voxelSize: number): THREE.BufferGeometry {
        const key = this.getPoolKey(blockType, voxelSize);
        const cached = this.geometryCache.get(key);
        if (cached) return cached;

        const geometry = new THREE.BoxGeometry(voxelSize, voxelSize, voxelSize);
        const uvAttribute = geometry.getAttribute('uv');
        const atlas = getVoxelTextureAtlas();

        const faceTypes: ('side' | 'top' | 'bottom')[] = ['side', 'side', 'top', 'bottom', 'side', 'side'];
        for (let faceIdx = 0; faceIdx < 6; faceIdx++) {
            const faceType = faceTypes[faceIdx]!;
            const uv = atlas.getBlockUV(blockType, faceType);
            uvAttribute.setXY(faceIdx * 4 + 0, uv.u0, uv.v1);
            uvAttribute.setXY(faceIdx * 4 + 1, uv.u1, uv.v1);
            uvAttribute.setXY(faceIdx * 4 + 2, uv.u0, uv.v0);
            uvAttribute.setXY(faceIdx * 4 + 3, uv.u1, uv.v0);
        }
        uvAttribute.needsUpdate = true;

        this.geometryCache.set(key, geometry);
        return geometry;
    }

    private growPool(pool: DebrisPool): void {
        const newCapacity = pool.capacity * 2;
        const oldMesh = pool.instancedMesh;
        const hadColors = oldMesh.instanceColor !== null;

        const newMesh = new THREE.InstancedMesh(oldMesh.geometry, oldMesh.material, newCapacity);
        newMesh.count = pool.activeCount;
        newMesh.castShadow = true;
        newMesh.receiveShadow = true;
        newMesh.frustumCulled = false;
        newMesh.name = oldMesh.name;

        for (let i = 0; i < pool.activeCount; i++) {
            oldMesh.getMatrixAt(i, _mat4);
            newMesh.setMatrixAt(i, _mat4);
            if (hadColors) {
                oldMesh.getColorAt(i, _color);
                if (!newMesh.instanceColor) {
                    newMesh.instanceColor = new THREE.InstancedBufferAttribute(
                        new Float32Array(newCapacity * 3), 3,
                    );
                }
                newMesh.setColorAt(i, _color);
            }
        }
        newMesh.instanceMatrix.needsUpdate = true;
        if (newMesh.instanceColor) newMesh.instanceColor.needsUpdate = true;

        if (oldMesh.parent) {
            oldMesh.parent.add(newMesh);
            oldMesh.parent.remove(oldMesh);
        }
        oldMesh.dispose();

        const newEntries: (DebrisEntry | null)[] = new Array(newCapacity).fill(null);
        for (let i = 0; i < pool.activeCount; i++) {
            newEntries[i] = pool.entries[i] ?? null;
        }

        pool.instancedMesh = newMesh;
        pool.entries = newEntries;
        pool.capacity = newCapacity;
    }

    private removeOldestActive(): void {
        let oldest: DebrisEntry | null = null;
        for (const entry of this.allDebris) {
            if (entry.isSettled) continue;
            if (!oldest || entry.createdAt < oldest.createdAt) {
                oldest = entry;
            }
        }
        if (oldest) {
            this.removeFromPool(oldest);
            this.removePhysics(oldest);
            this.allDebris.delete(oldest);
        }
    }

    /** Fully retire an entry: free its instance slot, physics body, and tracking maps. */
    private removeEntry(entry: DebrisEntry): void {
        this.removeFromPool(entry);
        this.removePhysics(entry);
        this.allDebris.delete(entry);
        this.debrisById.delete(entry.id);
    }

    /** Swap-remove: move last active instance into the removed slot to keep range compact. */
    private removeFromPool(entry: DebrisEntry): void {
        const pool = entry.pool;
        const idx = entry.instanceIndex;
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

    private removePhysics(entry: DebrisEntry): void {
        if (entry.collider.isValid()) {
            entry.physicsWorld.removeCollider(entry.collider);
        }
        if (entry.body.isValid()) {
            entry.physicsWorld.removeRigidBody(entry.body);
        }
    }

    private mergeIntoChunk(entry: DebrisEntry): void {
        const userData = entry.physicsWorld.getUserDataFromHandle(entry.body.handle) as {
            voxelWorld?: VoxelWorld;
            blockType?: number;
            color?: { r: number; g: number; b: number };
            debrisSize?: number;
        } | null;

        if (!userData?.voxelWorld) return;

        const voxelWorld = userData.voxelWorld;
        const blockType = userData.blockType ?? 1;

        if (!entry.body.isValid()) return;

        const pos = entry.body.translation();
        const rot = entry.body.rotation();
        const position = new THREE.Vector3(pos.x, pos.y, pos.z);
        const quaternion = new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w);

        voxelWorld.mergeDebrisIntoChunk(position, quaternion, blockType, userData.debrisSize, userData.color);
        this.dirtyWorlds.add(voxelWorld);
    }
}

// Singleton instance
export const VoxelDebrisManager = new VoxelDebrisManagerImpl();
