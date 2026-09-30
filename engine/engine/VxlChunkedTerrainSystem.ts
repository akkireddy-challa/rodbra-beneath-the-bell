/**
 * VxlChunkedTerrainSystem — runtime for VWLD (chunked voxel-world) terrain.
 *
 * Drop-in alternative to `VoxelTerrainSystem` for baked GLB-derived levels
 * (racing tracks, hand-modelled environments, etc.). Where the chunk-grid
 * terrain system generates uniform-voxel chunks procedurally and rebuilds
 * meshes/colliders as the world mutates, this system loads a pre-baked
 * `VWLD` file where each chunk's geometry is a standalone VXL3 v4 octree
 * with adaptive voxel sizes and baked LOD levels.
 *
 * Per chunk:
 *   - One `VoxelObject` materialized at the chunk's world origin.
 *   - LOD 0 mesh + LOD-0 trimesh collider built immediately and resident
 *     for the lifetime of the system.
 *   - LOD k>0 meshes built lazily on first use, also kept resident.
 *   - Per-frame LOD selection: distance from camera → bucket → pick which
 *     LOD mesh is visible. Colliders never change LOD — physics always
 *     hits LOD 0.
 *
 * Terrain query API (`getHeightAt`, etc.) mirrors `VoxelTerrainSystem`'s
 * read-only surface so walkable-map / spawn / NPC pathing systems work
 * unchanged when this system replaces the chunk-grid one. Mutation
 * operations (destroyBlockAt, explodeTerrainSphere, flattenArea, …)
 * intentionally aren't part of this system — baked-GLB levels are static.
 */

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { EngineLike } from 'types/game.js';
import { VoxelObject, type VoxelObjectBounds } from 'engine/VoxelObject.js';
import { decodeVxlWorld, decodeTrimeshBlob, type VxlWorldData, type VxlWorldChunk, type VxlWorldBounds } from 'engine/VxlWorldFormat.js';
import { CollisionGroup, CollisionMask, makeCollisionGroups } from 'engine/CollisionLayers.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import { syncGroundWorldSizeToBakedLevel } from 'engine/syncGroundWorldSizeToBakedLevel.js';

export interface VxlChunkedTerrainConfig {
    /**
     * Distance thresholds in meters for per-chunk LOD switching, measured
     * from the camera to the chunk's world-space center. A chunk with
     * camera-distance d picks LOD level k where:
     *
     *   k = 0                if d <  lodDistances[0]
     *   k = 1                if lodDistances[0] <= d < lodDistances[1]
     *   k = lodDistances.length         if d >= lodDistances[last]
     *
     * Picked LOD is clamped to the chunk's available `getLodCount()-1`, so
     * chunks baked without extra LODs always render their LOD 0.
     */
    lodDistances: number[];
    /**
     * Optional hard render cutoff in meters. Chunks further than this from
     * the camera are hidden entirely. `null` = unlimited (always render).
     */
    maxRenderDistance: number | null;
    /** Whether each chunk's `VoxelObject` casts/receives shadows. */
    shadows: boolean;
}

export const DEFAULT_VXL_CHUNKED_TERRAIN_CONFIG: VxlChunkedTerrainConfig = {
    // Aligned with the level-voxelize dialog's defaults and with the
    // per-asset distance schedule used elsewhere in the engine
    // (`EnvironmentObjectSystem.DEFAULT_LOD_DISTANCES_M = [0, 70, 120,
    // 180, 240]`, dropping the always-zero LOD-0 slot). One source of
    // truth: when a user accepts dialog defaults, the runtime falls
    // back to the same numbers if the asset record is missing per-LOD
    // distances. The previous `[24, 48, 96]` was too aggressive — LOD
    // popped 1.5 chunks from the camera at chunkSize=16.
    lodDistances: [70, 120, 180, 240],
    maxRenderDistance: null,
    shadows: true,
};

/** Per-chunk state held by the system. */
interface ChunkEntry {
    sx: number; sy: number; sz: number;
    /** World-space position of the chunk's center (used for LOD distance). */
    center: THREE.Vector3;
    /** The renderable + collidable VoxelObject anchored at the chunk's center. */
    voxelObject: VoxelObject;
    /**
     * `lodMeshes[k]` is the renderable mesh for LOD `k` once it's been
     * built. LOD 0 is `voxelObject.getMesh()` and is always present. LOD
     * k>0 entries are lazily filled by `ensureLodMeshBuilt(entry, k)`.
     */
    lodMeshes: (THREE.Mesh | null)[];
    /**
     * LOD indices whose build threw (typically `RangeError` from an
     * over-large `Float32Array` allocation when leaf count blows up).
     * `ensureLodMeshBuilt` early-returns null for these so we don't
     * keep retrying every frame and don't crash the render loop —
     * the chunk just stays invisible at that LOD.
     */
    lodBuildFailed: Set<number>;
    /** Which LOD index is currently visible, or -1 if the chunk is hidden. */
    activeLod: number;
    /** Cached `getLodCount()` so we don't call into VoxelObject per-frame. */
    lodCount: number;
}

/**
 * Replaces (or runs alongside) `VoxelTerrainSystem` for baked-VXL levels.
 *
 * Construction is cheap — no I/O happens until `loadVxlWorld()` runs.
 * Callers (genres / world-generators) do:
 *
 *   const terrain = new VxlChunkedTerrainSystem(engine, { ...DEFAULT_…, … });
 *   await terrain.loadVxlWorld(vwldBuffer);
 *   // every-frame: terrain.updateVisibility(camera);
 */
export class VxlChunkedTerrainSystem {
    private engine: EngineLike;
    private config: VxlChunkedTerrainConfig;
    /** Top-level container in the scene. One child per loaded chunk. */
    private rootGroup: THREE.Group;
    private chunks: ChunkEntry[] = [];
    private worldData: VxlWorldData | null = null;
    /** True after `loadVxlWorld` finishes and every chunk's collider is wired up. */
    private collidersReady: boolean = false;
    /** Scratch vector to avoid allocating per chunk per frame. */
    private readonly _scratchCamPos = new THREE.Vector3();
    /** World-space box outside which no chunk is drawn (`setRenderRegion`); null draws all. */
    private renderRegion: THREE.Box3 | null = null;
    private readonly chunkBoxScratch = new THREE.Box3();

    constructor(engine: EngineLike, config: VxlChunkedTerrainConfig) {
        this.engine = engine;
        this.config = config;
        this.rootGroup = new THREE.Group();
        this.rootGroup.name = 'VxlChunkedTerrain';
    }

    /**
     * Decode a VWLD buffer and materialize one VoxelObject per chunk.
     *
     * After this resolves: every chunk has its LOD 0 mesh + a static
     * trimesh collider in the physics world. LOD k>0 meshes are built on
     * demand the first time `updateVisibility` picks them.
     *
     * Calling `loadVxlWorld` twice replaces the previous world atomically.
     */
    async loadVxlWorld(vwldBuffer: ArrayBuffer): Promise<void> {
        // Drop any previous world so the system is reusable.
        if (this.chunks.length > 0) this.clearChunks();

        const totalStart = performance.now();
        console.log(`[VxlChunkedTerrain] decoding VWLD (${(vwldBuffer.byteLength / 1024 / 1024).toFixed(1)} MB)…`);
        const world = await decodeVxlWorld(vwldBuffer);
        this.worldData = world;
        // This baked level defines the real playable extent — grow groundWorldSizeX/Z to it
        // so spawn clamping and camera framing use the level size, not the tiny default plane.
        syncGroundWorldSizeToBakedLevel(this.engine, world.bounds);
        // Register as the engine's main terrain: a baked level has no procedural VoxelWorld,
        // so bounds consumers (e.g. the coastal water surface) reach the level extent through
        // DynamicObjectManager.getTerrainBounds().
        this.engine.getDynamicObjectManager?.()?.setBakedTerrain(this);
        console.log(`[VxlChunkedTerrain] decode done (${(performance.now() - totalStart).toFixed(0)} ms), ${world.chunks.length} chunks to materialize`);

        // Apply per-asset LOD distance overrides from the matching asset
        // record (set by the level-voxelize dialog). This is engine-owned
        // because it requires knowing the VWLD asset shape — keeping it
        // here means templates don't carry format-specific code.
        this.applyLevelLodDistancesFromAssetRecord();

        const scene = this.engine.scene;
        const physicsWorld = this.engine.physicsWorld;
        if (!scene) {
            throw new Error('[VxlChunkedTerrainSystem] engine.scene is null — call after GameEngine init');
        }

        if (this.rootGroup.parent !== scene) {
            scene.add(this.rootGroup);
        }

        const halfChunk = world.chunkSize / 2;
        // Yield to the event loop every YIELD_EVERY chunks so the browser
        // can repaint, service input, and run idle work between batches.
        // Without this the entire chunked load runs as one synchronous
        // microtask-chain — for a 1000+ chunk world that's tens of
        // seconds of frozen tab and a "Loading game…" screen that looks
        // exactly like a hang.
        const YIELD_EVERY = 8;
        const PROGRESS_EVERY = 32;
        const loadStart = performance.now();

        // Up-front chunk-size diagnostic so we know what we're loading.
        // Each chunk's compressed VXL3 byte count strongly correlates
        // with its leaf count (typical ratio ≈ 3-5 bytes per leaf after
        // gzip), so we can use byte size as a cheap O(1) proxy without
        // having to decode anything yet. Logs total + top-5 biggest +
        // distribution buckets so a pathological bake is visible at
        // a glance.
        const chunkSizes = world.chunks.map(c => c.vxlBytes.byteLength);
        const totalBytes = chunkSizes.reduce((a, b) => a + b, 0);
        const sortedSizes = [...chunkSizes].sort((a, b) => b - a);
        const top5 = sortedSizes.slice(0, 5).map(b => `${(b / 1024).toFixed(0)}KB`).join(', ');
        // Approximate leaf count from compressed byte size (uses the
        // typical ~4 bytes-per-leaf ratio for the gzipped VxlV3 stream).
        const estLeaves = (bytes: number): number => Math.round(bytes / 4);
        const buckets = [0, 0, 0, 0, 0]; // <50KB, <200KB, <500KB, <1MB, >=1MB
        for (const b of chunkSizes) {
            if (b < 50 * 1024) buckets[0]!++;
            else if (b < 200 * 1024) buckets[1]!++;
            else if (b < 500 * 1024) buckets[2]!++;
            else if (b < 1024 * 1024) buckets[3]!++;
            else buckets[4]!++;
        }
        console.log(
            `[VxlChunkedTerrain] chunk size profile: total=${(totalBytes / 1024 / 1024).toFixed(1)}MB, ` +
            `top5=[${top5}] (~${estLeaves(sortedSizes[0] ?? 0).toLocaleString()} leaves in biggest); ` +
            `<50KB:${buckets[0]} <200KB:${buckets[1]} <500KB:${buckets[2]} <1MB:${buckets[3]} ≥1MB:${buckets[4]}`,
        );

        // Memory-recovery circuit-breakers. The two most important ones
        // are budget-based, NOT failure-based — failures take seconds
        // each because of GC thrashing, so by the time we'd notice
        // them the tab is already unresponsive. We hard-cap on
        // cumulative compressed byte size so the load always completes
        // in bounded time, giving the user a path back to the creator
        // UI to re-voxelize after a too-fine bake.
        //
        // 20 MB compressed VWLD typically expands to ~600 MB of mesh
        // buffers — comfortably inside a normal tab's heap. For dense
        // bakes (the user's case: 59 MB compressed = ~1.8 GB geometry)
        // we load ~1/3 of the chunks and stop; the user gets a
        // partial-but-navigable world and can fix it from there.
        const MAX_CUMULATIVE_BYTES = 20 * 1024 * 1024;
        // Also hard-skip individual chunks that are stupidly large on
        // their own (a single dense column can OOM even if the rest
        // would fit).
        const MAX_CHUNK_BYTES = 1024 * 1024;
        // Failure-based safety nets (in case a chunk slips through
        // the size checks but still fails):
        //   - 3 consecutive allocation failures → heap is exhausted.
        //   - One chunk takes ≥5s wall-clock → GC thrashing.
        const MAX_CONSECUTIVE_FAILURES = 3;
        const SLOW_CHUNK_THRESHOLD_MS = 5_000;

        let skippedOversize = 0;
        let skippedErrors = 0;
        let skippedOverBudget = 0;
        let consecutiveFailures = 0;
        let cumulativeBytes = 0;
        let abortReason: string | null = null;
        for (let i = 0; i < world.chunks.length; i++) {
            const chunk = world.chunks[i]!;
            if (chunk.vxlBytes.byteLength > MAX_CHUNK_BYTES) {
                skippedOversize++;
                console.warn(
                    `[VxlChunkedTerrain] skipping oversize chunk (${chunk.sx},${chunk.sy},${chunk.sz}): ` +
                    `${(chunk.vxlBytes.byteLength / 1024).toFixed(0)}KB ≈ ${estLeaves(chunk.vxlBytes.byteLength).toLocaleString()} leaves ` +
                    `(limit ${MAX_CHUNK_BYTES / 1024}KB)`,
                );
                continue;
            }
            // Cumulative-byte budget check. Once exceeded, skip every
            // remaining chunk — don't break the loop, because we still
            // want the final summary + collidersReady=true to fire.
            if (cumulativeBytes + chunk.vxlBytes.byteLength > MAX_CUMULATIVE_BYTES) {
                if (skippedOverBudget === 0) {
                    console.warn(
                        `[VxlChunkedTerrain] cumulative chunk budget ${(MAX_CUMULATIVE_BYTES / 1024 / 1024).toFixed(0)}MB reached at chunk ${i}/${world.chunks.length} — ` +
                        `skipping remaining chunks. Re-voxelize with a coarser min voxel size to load more of the world.`,
                    );
                }
                skippedOverBudget++;
                continue;
            }
            const chunkStart = performance.now();
            try {
                await this.loadOneChunk(chunk, world, halfChunk, physicsWorld);
                cumulativeBytes += chunk.vxlBytes.byteLength;
                consecutiveFailures = 0;
            } catch (err) {
                skippedErrors++;
                consecutiveFailures++;
                console.warn(
                    `[VxlChunkedTerrain] failed to load chunk (${chunk.sx},${chunk.sy},${chunk.sz}): ` +
                    `${err instanceof Error ? err.message : String(err)} — chunk skipped`,
                );
                if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                    abortReason = `${consecutiveFailures} consecutive allocation failures — heap is likely exhausted`;
                    break;
                }
            }
            const chunkMs = performance.now() - chunkStart;
            if (chunkMs >= SLOW_CHUNK_THRESHOLD_MS) {
                abortReason = `single chunk took ${(chunkMs / 1000).toFixed(1)}s — heap is GC-thrashing`;
                break;
            }

            if ((i + 1) % PROGRESS_EVERY === 0 || i + 1 === world.chunks.length) {
                const elapsed = performance.now() - loadStart;
                const rate = (i + 1) / (elapsed / 1000);
                const remaining = (world.chunks.length - (i + 1)) / Math.max(0.1, rate);
                console.log(
                    `[VxlChunkedTerrain] ${i + 1}/${world.chunks.length} chunks ` +
                    `(${(elapsed / 1000).toFixed(1)}s elapsed, ~${remaining.toFixed(1)}s remaining)`,
                );
            }
            if ((i + 1) % YIELD_EVERY === 0) {
                await new Promise((r) => setTimeout(r, 0));
            }
        }
        if (abortReason !== null) {
            console.warn(
                `[VxlChunkedTerrain] aborting chunk load: ${abortReason}. ` +
                `${this.chunks.length}/${world.chunks.length} chunks materialized — ` +
                `world is partial. Re-voxelize with a coarser min voxel size to fix.`,
            );
        }
        if (skippedOversize > 0) {
            console.warn(`[VxlChunkedTerrain] ${skippedOversize} of ${world.chunks.length} chunks skipped as oversize (>${MAX_CHUNK_BYTES / 1024}KB)`);
        }
        if (skippedOverBudget > 0) {
            console.warn(`[VxlChunkedTerrain] ${skippedOverBudget} of ${world.chunks.length} chunks skipped to stay under the ${(MAX_CUMULATIVE_BYTES / 1024 / 1024).toFixed(0)}MB cumulative budget — re-voxelize coarser to load more`);
        }
        if (skippedErrors > 0) {
            console.warn(`[VxlChunkedTerrain] ${skippedErrors} of ${world.chunks.length} chunks were skipped due to load errors`);
        }
        this.collidersReady = true;
        console.log(`[VxlChunkedTerrain] ${this.chunks.length} chunks loaded in ${((performance.now() - loadStart) / 1000).toFixed(1)}s`);
    }

    /**
     * Materialize one chunk: build the VoxelObject, load its LOD-0 mesh,
     * attach physics colliders, register it in `this.chunks`. Throws
     * if any per-chunk allocation fails — the caller catches and skips
     * the chunk so a single bad chunk doesn't abort the whole world.
     */
    private async loadOneChunk(
        chunk: VxlWorldChunk,
        world: VxlWorldData,
        halfChunk: number,
        physicsWorld: PhysicsWorld | null,
    ): Promise<void> {
        const vo = new VoxelObject({ shadows: this.config.shadows });
        vo.name = `VxlChunk_${chunk.sx}_${chunk.sy}_${chunk.sz}`;

        // VxlWorldVoxelizer writes each chunk's bounds in chunk-local
        // coords [0, chunkSize]. With the file marking those bounds as
        // "world units" the default pivot is (chunkSize/2, 0, chunkSize/2)
        // — the chunk's local center at the floor. Placing the
        // VoxelObject at that same point in world space lines its
        // interior up with the chunk's world AABB.
        const worldOriginX = world.bounds.minX + chunk.sx * world.chunkSize;
        const worldOriginY = world.bounds.minY + chunk.sy * world.chunkSize;
        const worldOriginZ = world.bounds.minZ + chunk.sz * world.chunkSize;
        vo.position.set(
            worldOriginX + halfChunk,
            worldOriginY,
            worldOriginZ + halfChunk,
        );

        // `vxlBytes` is a standalone VXL3 blob — pass it straight in.
        // `loadFromFile` builds the LOD 0 mesh internally.
        //
        // `distinctFragmentOffsets: true` tells VoxelObject that each
        // fragment in this chunk comes from a DIFFERENT source object
        // (the bake emits one fragment per per-object bucket). Each
        // fragment gets its own polygon-offset slot so different-size
        // voxels from different objects don't z-fight at coincident
        // cells. The trade-off — a 1-pixel seam at fragment boundaries
        // — is fine here because fragments correspond to different
        // physical objects that overlap rather than tile.
        const bytes = chunk.vxlBytes;
        const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        await vo.loadFromFile(buf as ArrayBuffer, { distinctFragmentOffsets: true });

        if (physicsWorld) {
            vo.createPhysicsBody(physicsWorld);

            // Trimesh-collider augment (VWLD v2+). Chunks with
            // tcolBytes carry a TMSH blob built from the source GLB
            // triangles of objects the user marked "Trimesh collider"
            // in the level-voxelize dialog. The leaves from those
            // objects are nc-tagged so the greedy-mesh collider above
            // already excludes them — this trimesh covers their
            // physics with the original smooth geometry instead of
            // stair-stepped voxel cuboids.
            //
            // Coordinate shift: TMSH positions are chunk-local
            // [0, chunkSize]; the rigid body sits at the chunk's
            // pivot (chunkSize/2, 0, chunkSize/2 in chunk-local
            // terms), so we subtract that pivot before handing the
            // verts to Rapier.
            if (chunk.tcolBytes && chunk.tcolBytes.byteLength > 0) {
                const body = vo.getRigidBody();
                if (body) {
                    const tcol = decodeTrimeshBlob(chunk.tcolBytes, world.chunkSize);
                    const verts = tcol.vertices;
                    for (let v = 0; v < verts.length; v += 3) {
                        verts[v + 0] = verts[v + 0]! - halfChunk;
                        verts[v + 2] = verts[v + 2]! - halfChunk;
                    }
                    const groups = makeCollisionGroups(
                        CollisionGroup.ENVIRONMENT, CollisionMask.ENVIRONMENT,
                    );
                    const desc = RAPIER.ColliderDesc.trimesh(verts, tcol.indices)
                        .setCollisionGroups(groups)
                        .setFriction(0.5)
                        .setRestitution(0.0);
                    physicsWorld.createCollider(desc, body);
                }
            }
        }

        this.rootGroup.add(vo);

        const lodCount = vo.getLodCount();
        const lodMeshes: (THREE.Mesh | null)[] = new Array(lodCount).fill(null);
        // LOD-0 reference for getVoxelChunkData() consumers. NOTE: for
        // multi-fragment chunks this is a detached combined template, not
        // the rendered geometry — the rendered LOD 0 is the fragment
        // children. Visibility is therefore driven by `vo.setLod0Visible()`
        // in `setActiveLod`, NOT by toggling this reference (doing so left
        // the children visible under the LOD-k mesh → every voxel twice).
        lodMeshes[0] = vo.getMesh();

        const entry: ChunkEntry = {
            sx: chunk.sx, sy: chunk.sy, sz: chunk.sz,
            center: new THREE.Vector3(
                worldOriginX + halfChunk,
                worldOriginY + halfChunk,
                worldOriginZ + halfChunk,
            ),
            voxelObject: vo,
            lodMeshes,
            lodBuildFailed: new Set(),
            activeLod: 0,
            lodCount,
        };
        this.chunks.push(entry);
    }

    /**
     * Lazily build (and cache) the LOD `k` mesh for `entry`. Adds it to
     * the VoxelObject group as a child so its world transform follows the
     * chunk's position automatically. Returns the mesh, or null if the
     * file didn't bake LOD `k`.
     */
    private ensureLodMeshBuilt(entry: ChunkEntry, k: number): THREE.Mesh | null {
        if (k < 0 || k >= entry.lodCount) return null;
        if (entry.lodBuildFailed.has(k)) return null;
        const existing = entry.lodMeshes[k];
        if (existing) return existing;
        // For k=0 the mesh always exists (built by loadFromFile). For k>0
        // VoxelObject.getMeshForLod builds the mesh but doesn't parent it —
        // we add it under the VoxelObject ourselves, then hide it until the
        // visibility pass flips it on.
        //
        // Wrap in try/catch: a chunk with too many leaves can overflow the
        // Float32Array allocation in buildOctreeMesh (or whatever
        // intermediate buffer downstream). Failing the whole game over one
        // unrenderable chunk is too aggressive — log, mark the failure so
        // we don't retry every frame, and leave the chunk invisible at
        // this LOD. Other chunks / LODs keep working.
        let mesh: THREE.Mesh | null = null;
        try {
            mesh = entry.voxelObject.getMeshForLod(k);
        } catch (err) {
            entry.lodBuildFailed.add(k);
            console.warn(
                `[VxlChunkedTerrain] failed to build LOD ${k} mesh for chunk (${entry.sx},${entry.sy},${entry.sz}): ` +
                `${err instanceof Error ? err.message : String(err)} — chunk hidden at this LOD`,
            );
            return null;
        }
        if (!mesh) return null;
        if (k !== 0 && mesh.parent !== entry.voxelObject) {
            mesh.visible = false;
            entry.voxelObject.add(mesh);
        }
        entry.lodMeshes[k] = mesh;
        return mesh;
    }

    /**
     * Pick which LOD of each chunk's mesh is visible based on distance
     * from `camera`. Called once per frame by the engine's update loop
     * (mirroring `VoxelTerrainSystem.updateVisibility`).
     *
     * `_playerPosition` is accepted to keep the signature aligned with
     * `VoxelTerrainSystem.updateVisibility` but isn't used here — LOD is
     * camera-relative.
     */
    updateVisibility(camera: THREE.Camera, _playerPosition?: THREE.Vector3): void {
        if (this.chunks.length === 0) return;

        camera.getWorldPosition(this._scratchCamPos);
        const camPos = this._scratchCamPos;
        const distances = this.config.lodDistances;
        const maxRender = this.config.maxRenderDistance;
        const half = (this.worldData?.chunkSize ?? 0) / 2;

        for (const entry of this.chunks) {
            // Distance from camera to chunk's world-space center.
            const dx = entry.center.x - camPos.x;
            const dy = entry.center.y - camPos.y;
            const dz = entry.center.z - camPos.z;
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

            if ((maxRender !== null && dist > maxRender) || this.isOutsideRenderRegion(entry.center, half)) {
                this.setActiveLod(entry, -1);
                continue;
            }

            // Bucket by distance. Each threshold bumps the LOD index up
            // one; the last bucket maps to `distances.length`. The result
            // is clamped to the chunk's available LOD count below.
            let lod = distances.length;
            for (let i = 0; i < distances.length; i++) {
                if (dist < distances[i]!) { lod = i; break; }
            }
            if (lod >= entry.lodCount) lod = entry.lodCount - 1;
            this.setActiveLod(entry, lod);
        }
    }

    /**
     * Hide previously-active LOD mesh (if any), build + show LOD `k`. Passing
     * `k = -1` hides the whole chunk.
     */
    private setActiveLod(entry: ChunkEntry, k: number): void {
        if (entry.activeLod === k) return;
        // Hide the previously-active LOD. LOD 0 lives on the
        // VoxelObject's own mesh / fragment children (NOT lodMeshes[0],
        // which for multi-fragment chunks is a detached template), so it
        // needs the dedicated toggle — otherwise the LOD-0 geometry stays
        // visible underneath the LOD-k mesh and every voxel renders twice.
        if (entry.activeLod === 0) {
            entry.voxelObject.setLod0Visible(false);
        } else if (entry.activeLod > 0) {
            const prev = entry.lodMeshes[entry.activeLod];
            if (prev) prev.visible = false;
        }
        if (k === 0) {
            entry.voxelObject.setLod0Visible(true);
        } else if (k > 0) {
            const mesh = this.ensureLodMeshBuilt(entry, k);
            if (mesh) mesh.visible = true;
        }
        entry.activeLod = k;
    }

    /**
     * Per-frame tick. No-op for static baked terrain — kept so callers
     * can drive every terrain system through the same `update(dt)` shape.
     */
    update(_deltaTime: number): void {
        // intentionally empty
    }

    /**
     * Returns the surface height (world Y) at `(x, z)` via a downward
     * physics raycast against TERRAIN + ENVIRONMENT colliders.
     *
     * Each chunk's collider is on the ENVIRONMENT collision group (the
     * default for `VoxelObject.createPhysicsBody`), so the cast hits the
     * baked terrain regardless of which chunk owns the column. Mirrors
     * `VoxelTerrainSystem.getHeightAt` so callers don't care which
     * terrain implementation is wired up.
     */
    getHeightAt(x: number, z: number): number {
        const physicsWorld = this.engine.physicsWorld;
        if (!physicsWorld) return 0;
        const rayResult = physicsWorld.raycast(
            new THREE.Vector3(x, 500, z),
            new THREE.Vector3(0, -1, 0),
            600,
            CollisionGroup.TERRAIN | CollisionGroup.ENVIRONMENT,
        );
        if (rayResult.hasHit) return rayResult.hitPoint.y;
        // Fallback when nothing was hit: the world's floor Y, so spawn
        // logic gets a sensible value instead of 0 outside the world.
        return this.worldData?.bounds.minY ?? 0;
    }

    /** Alias — kept for parity with `VoxelTerrainSystem.getVoxelHeightAt`. */
    getVoxelHeightAt(x: number, z: number): number {
        return this.getHeightAt(x, z);
    }

    /** Alias — kept for parity with `VoxelTerrainSystem.getVoxelTerrainHeight`. */
    getVoxelTerrainHeight(x: number, z: number): number {
        return this.getHeightAt(x, z);
    }

    /** Alias — kept for parity with `VoxelTerrainSystem.getActualVoxelSurfaceHeight`. */
    getActualVoxelSurfaceHeight(x: number, z: number): number {
        return this.getHeightAt(x, z);
    }

    /**
     * Top-level scene group containing every chunk. Genre code can attach
     * additional terrain decorations under here so they get culled /
     * disposed alongside the terrain itself.
     */
    getVoxelChunkGroup(): THREE.Group {
        return this.rootGroup;
    }

    /** True once `loadVxlWorld` has finished and physics bodies are in. */
    areCollidersReady(): boolean {
        return this.collidersReady;
    }

    /** World-space chunk size in meters (e.g. 16). */
    getChunkSize(): number {
        return this.worldData?.chunkSize ?? 0;
    }

    /** The "block size" callers use as a per-cell unit. Baked terrain has
     *  no uniform block grid, so we report the chunk size — the natural
     *  per-cell unit at this level. Mirrors `VoxelTerrainSystem.getBlockSize()`
     *  for compatibility with code that wants *some* spatial scale value. */
    getBlockSize(): number {
        return this.getChunkSize();
    }

    /** Number of chunks materialized (sparse — empty chunks aren't loaded). */
    getChunkCount(): number {
        return this.chunks.length;
    }

    /**
     * Override the per-LOD distance schedule. `distances[i]` is the camera
     * distance below which LOD `i` is used (i.e. the distance at which
     * LOD `i+1` takes over). Length should match (additionalLodCount):
     * for K total LODs (1 primary + K-1 additional), distances has K-1
     * entries. The per-asset `levelVoxelizeSettings.additionalLods[k].
     * distance` map directly to entries here.
     *
     * Takes effect on the next `updateVisibility` call (every frame),
     * so a call mid-game flips the schedule live.
     */
    setLodDistances(distances: number[]): void {
        this.config = { ...this.config, lodDistances: distances };
    }

    /**
     * Match the VWLD asset by its URL to the loader's `worldProfileData.
     * voxelUrl`, pull per-LOD distances off
     * `asset.levelVoxelizeSettings.additionalLods[k].distance`, and
     * install them as `this.config.lodDistances`.
     *
     * This lives in the engine — not in templates — because the asset
     * record's shape (and the format-specific `levelVoxelizeSettings`
     * payload) is engine-owned format knowledge. Templates only need
     * to construct a `VxlChunkedTerrainSystem` and call `loadVxlWorld`;
     * the engine handles the rest.
     *
     * Per-index fallback: missing distances inherit the corresponding
     * slot from the runtime defaults, so a user who customised only LOD
     * 1 keeps sensible defaults for the deeper LODs.
     *
     * Silent no-op when the engine has no `getGameData()` hook, the
     * game-data has no matching asset, or the asset has no per-LOD
     * settings — preserves the pre-rollout default behaviour for
     * worlds that haven't been (re-)voxelized through the new dialog.
     */
    private applyLevelLodDistancesFromAssetRecord(): void {
        const gameData = this.engine.getGameData?.();
        if (!gameData) return;
        const voxelUrl = gameData.worldProfileData?.voxelUrl;
        if (!voxelUrl) return;
        const assets = (gameData.assets ?? []) as Array<{
            url?: string;
            levelVoxelizeSettings?: { additionalLods?: Array<{ distance?: number }> };
        }>;
        const asset = assets.find(a => a.url === voxelUrl);
        const lods = asset?.levelVoxelizeSettings?.additionalLods;
        if (!lods || lods.length === 0) return;

        const defaults = DEFAULT_VXL_CHUNKED_TERRAIN_CONFIG.lodDistances;
        const out: number[] = [];
        for (let k = 0; k < lods.length; k++) {
            const userDist = lods[k]?.distance;
            if (typeof userDist === 'number' && userDist > 0) {
                out.push(userDist);
            } else if (k < defaults.length) {
                out.push(defaults[k]!);
            } else {
                // Beyond the defaults' length: double the last default per
                // extra tier — matches the dialog's default extrapolation.
                const last = defaults[defaults.length - 1] ?? 96;
                out.push(last * Math.pow(2, k - (defaults.length - 1)));
            }
        }
        if (out.length === 0) return;
        this.config = { ...this.config, lodDistances: out };
    }

    /** World-space AABB of the loaded VWLD, or null if nothing's loaded. */
    getBounds(): VxlWorldBounds | null {
        return this.worldData ? { ...this.worldData.bounds } : null;
    }

    /**
     * Read-only chunk descriptors for debug / introspection. Each entry's
     * `mesh` is whichever LOD is currently active; clients should not
     * mutate it. Mirrors `VoxelTerrainSystem.getVoxelChunkData()`.
     */
    getVoxelChunkData(): Array<{
        chunkX: number; chunkZ: number;
        worldMinX: number; worldMaxX: number;
        worldMinZ: number; worldMaxZ: number;
        mesh: THREE.Mesh | null;
        physicsBody: import('@dimforge/rapier3d-compat').RigidBody | null;
    }> {
        const result: ReturnType<VxlChunkedTerrainSystem['getVoxelChunkData']> = [];
        if (!this.worldData) return result;
        const cs = this.worldData.chunkSize;
        const worldMinXBase = this.worldData.bounds.minX;
        const worldMinZBase = this.worldData.bounds.minZ;
        for (const entry of this.chunks) {
            const minX = worldMinXBase + entry.sx * cs;
            const minZ = worldMinZBase + entry.sz * cs;
            result.push({
                chunkX: entry.sx,
                chunkZ: entry.sz,
                worldMinX: minX,
                worldMaxX: minX + cs,
                worldMinZ: minZ,
                worldMaxZ: minZ + cs,
                mesh: entry.activeLod >= 0 ? entry.lodMeshes[entry.activeLod] ?? null : null,
                physicsBody: entry.voxelObject.getRigidBody(),
            });
        }
        return result;
    }

    /** Toggle the entire terrain's render visibility without disposing it. */
    setCullingEnabled(enabled: boolean): void {
        this.rootGroup.visible = enabled;
    }

    isCullingEnabled(): boolean {
        return this.rootGroup.visible;
    }

    /**
     * Override the hard render cutoff. Pass `null` to render every chunk
     * regardless of distance.
     */
    setMaxRenderDistance(distance: number | null): void {
        this.config = { ...this.config, maxRenderDistance: distance };
    }

    getMaxRenderDistance(): number | null {
        return this.config.maxRenderDistance;
    }

    /**
     * Draw only the chunks whose box touches `region` (world space); `null` draws
     * every chunk again. Render-only — colliders stay. Parity with
     * `VxlSceneTerrainSystem.setRenderRegion`; takes effect on the next
     * `updateVisibility`.
     */
    setRenderRegion(region: THREE.Box3 | null): void {
        this.renderRegion = region ? region.clone() : null;
    }

    private isOutsideRenderRegion(center: THREE.Vector3, half: number): boolean {
        if (!this.renderRegion) return false;
        this.chunkBoxScratch.min.set(center.x - half, center.y - half, center.z - half);
        this.chunkBoxScratch.max.set(center.x + half, center.y + half, center.z + half);
        return !this.renderRegion.intersectsBox(this.chunkBoxScratch);
    }

    /** Tear down every chunk + drop the root group from the scene. */
    private clearChunks(): void {
        for (const entry of this.chunks) {
            entry.voxelObject.dispose();
            this.rootGroup.remove(entry.voxelObject);
        }
        this.chunks = [];
        this.collidersReady = false;
    }

    /**
     * Drop every chunk, every collider, and detach from the scene. Safe
     * to call multiple times. After disposal the system can be re-used
     * via another `loadVxlWorld(...)` call.
     */
    dispose(): void {
        this.clearChunks();
        if (this.rootGroup.parent) {
            this.rootGroup.parent.remove(this.rootGroup);
        }
        this.worldData = null;
        // Unregister as the main terrain — but only if WE are the registered one, so tearing
        // down a stale instance never clobbers a newer system's registration.
        const dom = this.engine.getDynamicObjectManager?.();
        if (dom?.getBakedTerrain() === this) dom.setBakedTerrain(null);
    }
}

/**
 * Exposed for use sites that want a typed handle on the per-chunk bounds
 * VoxelObject computes after `loadFromFile`. The chunked terrain itself
 * doesn't surface bounds per chunk — callers usually want the
 * world-AABB from `getBounds()` instead — but the underlying type is
 * sometimes useful when introspecting individual chunks.
 */
export type VxlChunkedTerrainChunkBounds = VoxelObjectBounds;
