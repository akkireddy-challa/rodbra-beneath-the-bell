import type { VoxelWorld } from 'engine/VoxelWorld.js';
import type { FoliageExclusionRect, VoxelFoliageSystem } from 'engine/VoxelFoliageSystem.js';
import { CHUNK_SIZE } from 'engine/VoxelGeometry.js';

/** Options for `VoxelTerrainSystem.placeBuildingFoundation`. */
export interface BuildingFoundationOptions {
    /** Flatten target (surface block base, as in `flattenArea`); null = derived from the ground (see `levelAt`). */
    height: number | null;
    /** Level the floor with the ground at this point (e.g. the path just outside the door); null = the most common ground level across the footprint. Ignored when `height` is set. */
    levelAt: { x: number; z: number } | null;
    /** Surface/fill block id; null = the atlas' stone block. */
    blockType: number | null;
    /** Extra meters around the footprint, flattened and kept clear too. */
    margin: number;
    /** Re-mesh the lot's chunks and regrow their foliage now (a no-op before the terrain is first built). */
    rebuildMeshes: boolean;
}

export const DEFAULT_BUILDING_FOUNDATION_OPTIONS: BuildingFoundationOptions = {
    height: null,
    levelAt: null,
    blockType: null,
    margin: 0,
    rebuildMeshes: true,
};

/** 2D chunk keys ("cx,cz") of the existing chunks overlapping `rect`. */
export function chunkKeysInRect(voxelWorld: VoxelWorld, rect: FoliageExclusionRect): string[] {
    const bounds = voxelWorld.getBounds();
    const chunkMeters = CHUNK_SIZE * voxelWorld.getVoxelSize();
    const originX = bounds?.minX ?? 0, originZ = bounds?.minZ ?? 0;
    const toChunk = (v: number, origin: number): number => Math.floor((v - origin + 1e-6) / chunkMeters);
    const wanted = new Set<string>();
    for (let cx = toChunk(rect.minX, originX); cx <= toChunk(rect.maxX, originX); cx++) {
        for (let cz = toChunk(rect.minZ, originZ); cz <= toChunk(rect.maxZ, originZ); cz++) wanted.add(`${cx},${cz}`);
    }
    return voxelWorld.get2DChunkKeys().filter(key => wanted.has(key));
}

/**
 * Register `rect` as `id`'s no-foliage zone, if a foliage system is connected at all
 * (the system takes the corners loose, not as a rect).
 */
function excludeRect(foliage: VoxelFoliageSystem | null, id: string, rect: FoliageExclusionRect): void {
    foliage?.addFoliageExclusion(id, rect.minX, rect.minZ, rect.maxX, rect.maxZ);
}

/** The `VoxelTerrainSystem` surface the registry drives (kept structural to avoid an import cycle). */
export interface FoundationTerrainHost {
    getTerrainOnlyHeight(x: number, z: number): number;
    getBlockSize(): number;
    getVoxelWorld(): VoxelWorld | null;
    flattenArea(centerX: number, centerZ: number, width: number, depth: number, height: number, blockType?: number, rebuildMeshes?: boolean, margin?: number, objectId?: string): void;
    unflattenArea(objectId: string, rebuildMeshes?: boolean): void;
    hasFlattenSnapshot(objectId: string): boolean;
    clearFlattenSnapshot(objectId: string): void;
    regenerateFoliageForChunk(key2D: string, getTerrainType: (blockType: number) => number): void;
}

/**
 * Building lots laid by `VoxelTerrainSystem.placeBuildingFoundation`, keyed by building id.
 * Each lot owns a flatten snapshot (for release) and a persistent foliage exclusion, which is
 * re-applied when a foliage system connects after the foundation was laid.
 */
export class BuildingFoundationRegistry {
    private readonly rects = new Map<string, FoliageExclusionRect>();

    constructor(
        private readonly terrain: FoundationTerrainHost,
        private readonly getFoliage: () => VoxelFoliageSystem | null,
        private readonly getTerrainTypeResolver: () => ((blockType: number) => number) | null,
    ) {}

    place(id: string, centerX: number, centerZ: number, width: number, depth: number, options: BuildingFoundationOptions): number {
        const blockSize = this.terrain.getBlockSize();
        const halfW = width / 2 + options.margin, halfD = depth / 2 + options.margin;
        const rect: FoliageExclusionRect = { minX: centerX - halfW, minZ: centerZ - halfD, maxX: centerX + halfW, maxZ: centerZ + halfD };

        // Re-placing the same building restores its old lot first, so both the snapshot and the
        // height sample below see the original ground rather than the previous floor.
        if (this.terrain.hasFlattenSnapshot(id)) this.terrain.unflattenArea(id, false);
        // getTerrainOnlyHeight is the surface block CENTRE, which flattenArea floors to that block's base.
        const target = options.height
            ?? (options.levelAt ? this.terrain.getTerrainOnlyHeight(options.levelAt.x, options.levelAt.z) : this.prevailingGroundHeight(centerX, centerZ, width, depth));
        this.terrain.flattenArea(centerX, centerZ, width, depth, target, options.blockType ?? undefined, false, options.margin, id);

        this.rects.set(id, rect);
        excludeRect(this.getFoliage(), id, rect);
        if (options.rebuildMeshes) this.rebuild(rect);
        return Math.floor(target / blockSize) * blockSize + blockSize;
    }

    release(id: string, restoreTerrain: boolean, rebuildMeshes: boolean): boolean {
        const rect = this.rects.get(id);
        if (!rect) return false;
        this.rects.delete(id);
        this.getFoliage()?.removeFoliageExclusion(id);
        if (restoreTerrain && this.terrain.hasFlattenSnapshot(id)) this.terrain.unflattenArea(id, false);
        else this.terrain.clearFlattenSnapshot(id);
        if (rebuildMeshes) this.rebuild(rect);
        return true;
    }

    get(id: string): FoliageExclusionRect | null {
        return this.rects.get(id) ?? null;
    }

    applyExclusionsTo(foliage: VoxelFoliageSystem): void {
        for (const [id, rect] of this.rects) excludeRect(foliage, id, rect);
    }

    /**
     * The most common surface level across the footprint (lowest on a tie), so a bump or dip at
     * the centre doesn't decide the floor. Samples at most a 32 × 32 grid of block columns.
     */
    private prevailingGroundHeight(centerX: number, centerZ: number, width: number, depth: number): number {
        const blockSize = this.terrain.getBlockSize();
        const step = Math.max(blockSize, Math.max(width, depth) / 32);
        const counts = new Map<number, { height: number; count: number }>();
        for (let x = centerX - width / 2 + step / 2; x < centerX + width / 2; x += step) {
            for (let z = centerZ - depth / 2 + step / 2; z < centerZ + depth / 2; z += step) {
                const height = this.terrain.getTerrainOnlyHeight(x, z);
                const level = Math.floor(height / blockSize);
                const entry = counts.get(level);
                if (entry) entry.count++;
                else counts.set(level, { height, count: 1 });
            }
        }
        let best: { level: number; height: number; count: number } | null = null;
        for (const [level, { height, count }] of counts) {
            if (!best || count > best.count || (count === best.count && level < best.level)) best = { level, height, count };
        }
        return best?.height ?? this.terrain.getTerrainOnlyHeight(centerX, centerZ);
    }

    /** Re-mesh the chunks the lot dirtied, then regrow foliage on the chunks under `rect` (exclusions applied). */
    private rebuild(rect: FoliageExclusionRect): void {
        const voxelWorld = this.terrain.getVoxelWorld();
        if (!voxelWorld) return;
        const keys = chunkKeysInRect(voxelWorld, rect);
        // Laid before the terrain's first build (from generateWorld): that build and the foliage pass pick the lot up.
        if (!keys.some(key => voxelWorld.getChunkMeshFor2DKey(key))) return;
        // Dirty chunks only (the lot and its border neighbours), never a whole-world re-mesh.
        voxelWorld.updatePhysicsAndMeshing();
        const resolver = this.getTerrainTypeResolver();
        if (!resolver) return;
        for (const key2D of keys) this.terrain.regenerateFoliageForChunk(key2D, resolver);
    }
}
