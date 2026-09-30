/**
 * Voxel terrain on the 2D-physics lane: Rapier **2D** terrain collision kept in
 * lockstep with a `VoxelWorld` that has NO 3D physics world.
 *
 * `VoxelWorld` still greedy-meshes every chunk into `chunk.collisionBoxes` on
 * that lane (the visual mesh reads them too) and then, instead of building 3D
 * colliders, calls the `onChunkPhysicsRebuilt` hook it was constructed with.
 * This bridge is that hook's owner. What it builds depends on the plane:
 *
 *  - SIDE-ON (the default): per chunk it retires the previous 2D colliders and
 *    rebuilds them from the fresh boxes through `buildChunkColliders2D`, so
 *    streaming rebuilds (a block mined, a chunk re-meshed near the player) stay
 *    per-chunk exactly as they are in 3D. ONE FIXED BODY AT THE ORIGIN carries
 *    every collider: `buildChunkColliders2D` subtracts the body translation to
 *    turn world-space cuboids into body-local ones, and an origin body makes
 *    that subtraction the identity — the cheapest way to be right. THE SLICE IS
 *    DERIVED, NOT ASSUMED: the gameplay plane (`planeZ`) is snapped to the voxel
 *    LAYER that contains it, using the same `floor((z - minZ) / voxelSize)`
 *    mapping `VoxelWorld.setBlock` uses. A slice centred on `planeZ` itself
 *    straddles two layers whenever the grid origin is a multiple of the voxel
 *    size, and moves with an off-grid `bounds.minZ` (the sidescroller's strip
 *    has `minZ = -1.5`) — both of which VoxelTerrain2D.test.ts documents.
 *    Snapping to the layer keeps the collision silhouette the row the camera
 *    shows, one voxel deep.
 *
 *  - GROUND PLANE (`ground` given — the top-down lane): the boxes feed the
 *    `TopDownGround` heightmap instead, which answers every vertical query and
 *    owns the cliff walls (`engine/physics/TopDownGround.ts`). No slice exists:
 *    the whole column stack is terrain the character stands ON, not a wall it
 *    walks INTO.
 *
 * Column enable/disable mirrors `VoxelWorld.setChunkCollidersEnabled` so the
 * `ChunkPhysicsManager` culls 2D colliders too; a column that is disabled when
 * a chunk rebuilds gets its new colliders disabled as well.
 */
import type RAPIER2D from '@dimforge/rapier2d-compat';
import { getRapier2D } from 'engine/physics/RapierPhysics2D.js';
import type { PhysicsWorld2D } from 'engine/physics/PhysicsWorld2D.js';
import { buildChunkColliders2D, type GameplaySlice } from 'engine/physics/VoxelTerrain2D.js';
import type { TopDownGround } from 'engine/physics/TopDownGround.js';
import { CHUNK_SIZE, type ChunkKey, type CollisionBox } from 'engine/VoxelGeometry.js';

export interface TerrainGridBounds {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
}

/** The voxel-grid facts the bridge needs; `VoxelWorld` satisfies it structurally. */
export interface TerrainGridSource {
    getBounds(): TerrainGridBounds | null;
    getVoxelSize(): number;
}

export interface VoxelTerrain2DBridgeOptions {
    world2D: PhysicsWorld2D;
    grid: TerrainGridSource;
    /** Side-on: world-space Z of the gameplay plane (`GameEngine.getGameplayPlaneZ()`, 0 when absent). */
    planeZ: number;
    /**
     * Per-material grip, the same lookup the 3D lane groups its colliders by
     * (`atlas.getBlockGrip`). Receives `undefined` for a box with no block type.
     */
    frictionForBlock: (blockType: number | undefined) => number;
    /**
     * Ground plane: the facade's `TopDownGround` (`PlaneLockedPhysics.ground`).
     * When given, chunks feed its heightmap and no sliced colliders are built.
     */
    ground?: TopDownGround | null;
}

/** Rapier's own default, and what a box with no block type gets. */
export const DEFAULT_TERRAIN_FRICTION_2D = 0.5;

/**
 * The one-voxel-deep slab of the grid layer that contains `planeZ`, in world Z.
 * Exported for the test; `VoxelTerrainSystem` never calls it directly.
 */
export function gameplaySliceFor(minZ: number, voxelSize: number, planeZ: number): GameplaySlice {
    const layer = Math.floor((planeZ - minZ + 1e-6) / voxelSize);
    return { z: minZ + (layer + 0.5) * voxelSize, halfDepth: voxelSize / 2 };
}

export function chunkColumnKey(cx: number, cz: number): string {
    return `${cx},${cz}`;
}

export class VoxelTerrain2DBridge {
    private body: RAPIER2D.RigidBody | null = null;
    private readonly byChunk = new Map<ChunkKey, RAPIER2D.Collider[]>();
    private readonly chunksByColumn = new Map<string, Set<ChunkKey>>();
    private readonly disabledColumns = new Set<string>();
    private slice: GameplaySlice | null = null;
    private sliceMinZ: number | null = null;

    constructor(private readonly options: VoxelTerrain2DBridgeOptions) {}

    /** The slice in use, or null before the first chunk (bounds unknown). */
    getSlice(): GameplaySlice | null {
        return this.slice;
    }

    /**
     * `VoxelWorld`'s `onChunkPhysicsRebuilt` hook. `boxes` is null when the chunk
     * became empty (the 3D lane's "no body" exit), which retires its colliders.
     */
    onChunkRebuilt(key: ChunkKey, boxes: readonly CollisionBox[] | null, cx: number, cy: number, cz: number): void {
        const ground = this.options.ground ?? null;
        if (ground) {
            if (boxes && boxes.length > 0) {
                const bounds = this.requireBounds();
                ground.setGrid(bounds.minX, bounds.minY, bounds.minZ, this.options.grid.getVoxelSize());
            } else if (!ground.getGrid()) {
                return; // nothing fed yet, nothing to retire
            }
            if (this.options.world2D.isDisposed()) return;
            ground.setChunkTops(key, cx, cy, cz, boxes);
            this.trackColumn(key, cx, cz, boxes !== null && boxes.length > 0);
            return;
        }
        this.retire(key);
        if (!boxes || boxes.length === 0) return;
        const bounds = this.requireBounds();
        const voxelSize = this.options.grid.getVoxelSize();
        const slice = this.resolveSlice(bounds.minZ, voxelSize);
        const world2D = this.options.world2D;
        if (world2D.isDisposed()) return;
        const body = this.ensureBody();
        const colliders = buildChunkColliders2D(world2D, body, boxes, {
            voxelSize,
            chunkWorldX: bounds.minX + cx * CHUNK_SIZE * voxelSize,
            chunkWorldY: bounds.minY + cy * CHUNK_SIZE * voxelSize,
            chunkWorldZ: bounds.minZ + cz * CHUNK_SIZE * voxelSize,
            slice,
            frictionForBlock: this.options.frictionForBlock,
        });
        if (colliders.length === 0) return;
        this.byChunk.set(key, colliders);
        const column = chunkColumnKey(cx, cz);
        this.trackColumn(key, cx, cz, true);
        if (this.disabledColumns.has(column)) {
            for (const collider of colliders) collider.setEnabled(false);
        }
    }

    private requireBounds(): TerrainGridBounds {
        const bounds = this.options.grid.getBounds();
        if (!bounds) {
            // Bounds are set right after construction on every terrain path; a
            // rebuild before them cannot be placed, and silently guessing an
            // origin would put the collider somewhere else than the mesh.
            throw new Error('[VoxelTerrain2DBridge] chunk rebuilt before the VoxelWorld had bounds');
        }
        return bounds;
    }

    private trackColumn(key: ChunkKey, cx: number, cz: number, present: boolean): void {
        const column = chunkColumnKey(cx, cz);
        let set = this.chunksByColumn.get(column);
        if (!present) { set?.delete(key); return; }
        if (!set) { set = new Set(); this.chunksByColumn.set(column, set); }
        set.add(key);
    }

    /** `ChunkPhysicsManager` culling, by 2D column key `"cx,cz"` — the 3D twin is `VoxelWorld.setChunkCollidersEnabled`. */
    setColumnEnabled(chunkKey2D: string, enabled: boolean): void {
        if (enabled) this.disabledColumns.delete(chunkKey2D);
        else this.disabledColumns.add(chunkKey2D);
        this.options.ground?.setStackEnabled(chunkKey2D, enabled);
        const chunks = this.chunksByColumn.get(chunkKey2D);
        if (!chunks) return;
        for (const key of chunks) {
            const colliders = this.byChunk.get(key);
            if (!colliders) continue;
            for (const collider of colliders) {
                if (collider.isValid()) collider.setEnabled(enabled);
            }
        }
    }

    /** Sliced terrain colliders side-on; cliff walls on the ground plane. */
    colliderCount(): number {
        let n = this.options.ground?.wallCount() ?? 0;
        for (const colliders of this.byChunk.values()) n += colliders.length;
        return n;
    }

    dispose(): void {
        // The ground is the facade's; the bridge only withdraws what it fed.
        this.options.ground?.clear();
        const world2D = this.options.world2D;
        if (!world2D.isDisposed()) {
            for (const colliders of this.byChunk.values()) {
                for (const collider of colliders) world2D.removeColliderImmediate(collider);
            }
            if (this.body) world2D.removeRigidBodyImmediate(this.body);
        }
        this.byChunk.clear();
        this.chunksByColumn.clear();
        this.disabledColumns.clear();
        this.body = null;
    }

    private retire(key: ChunkKey): void {
        const old = this.byChunk.get(key);
        if (!old) return;
        this.byChunk.delete(key);
        const world2D = this.options.world2D;
        if (!world2D.isDisposed()) {
            for (const collider of old) world2D.removeColliderImmediate(collider);
        }
        for (const set of this.chunksByColumn.values()) set.delete(key);
    }

    private ensureBody(): RAPIER2D.RigidBody {
        if (this.body && this.body.isValid()) return this.body;
        const R = getRapier2D();
        this.body = this.options.world2D.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, 0));
        return this.body;
    }

    private resolveSlice(minZ: number, voxelSize: number): GameplaySlice {
        if (this.slice && this.sliceMinZ === minZ) return this.slice;
        this.slice = gameplaySliceFor(minZ, voxelSize, this.options.planeZ);
        this.sliceMinZ = minZ;
        return this.slice;
    }
}
