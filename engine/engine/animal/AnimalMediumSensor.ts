import type { EngineLike } from 'types/game.js';
import type { VoxelWorld } from 'engine/VoxelWorld.js';
import { getVoxelTextureAtlas } from 'engine/VoxelTextureAtlas.js';

/**
 * Medium queries for swimming and flying creatures.
 *
 * Thin helper over the voxel world (water = fluid voxel blocks) and the
 * engine's terrain height raycast. Used by AnimalController to keep fish
 * inside water and birds above terrain, and by the swim/fly roam behaviors to
 * validate candidate targets.
 *
 * Degrades gracefully: without a voxel world every water query returns
 * false/null (a fish in a non-voxel world just sinks to the ground and the
 * behavior idles in place).
 */
export class AnimalMediumSensor {
    constructor(private readonly engine: EngineLike) {}

    private getVoxelWorld(): VoxelWorld | null {
        return this.engine.getDynamicObjectManager?.()?.getMainVoxelWorld() ?? null;
    }

    /** True when the voxel at the world position is a fluid block (water, etc.). */
    isWaterAt(x: number, y: number, z: number): boolean {
        const voxelWorld = this.getVoxelWorld();
        if (!voxelWorld) return false;
        const blockId = voxelWorld.getBlock(x, y, z);
        if (blockId === 0) return false;
        return getVoxelTextureAtlas().isFluidBlock(blockId);
    }

    /**
     * World-Y of the water surface above a submerged point: scans upward from
     * `fromY` until the first non-fluid voxel and returns the boundary height.
     * Returns null when `fromY` itself is not in water.
     */
    findWaterSurfaceY(x: number, fromY: number, z: number): number | null {
        const voxelWorld = this.getVoxelWorld();
        if (!voxelWorld || !this.isWaterAt(x, fromY, z)) return null;
        const step = voxelWorld.getVoxelSize();
        // 256 steps bounds the scan on pathological worlds (deep oceans are fine)
        let y = fromY;
        for (let i = 0; i < 256; i++) {
            const nextY = y + step;
            if (!this.isWaterAt(x, nextY, z)) {
                // Surface sits at the top face of the current fluid voxel
                return Math.floor((nextY - this.getWorldMinY()) / step) * step + this.getWorldMinY();
            }
            y = nextY;
        }
        return y;
    }

    private getWorldMinY(): number {
        // VoxelWorld quantizes against its bounds origin internally; queries
        // here only need voxel-grid alignment, and bounds minY defaults to 0
        // for generated terrain. Using 0 keeps the scan simple and matches
        // getBlock's own EPS-based quantization closely enough for animals.
        return 0;
    }

    /**
     * Terrain/world height at XZ (colliders included), or null when the engine
     * cannot answer (no raycast provider registered).
     */
    getTerrainHeightAt(x: number, z: number): number | null {
        const h = this.engine.getWorldHeightAt?.(x, z);
        return (h === undefined || h === null || Number.isNaN(h)) ? null : h;
    }

    /**
     * Mid-depth world-Y of the water column at XZ, or null when there is no
     * water there. Scans the voxel column top-down for the water surface, then
     * descends to the column bottom and returns the midpoint — a submerged
     * point safe to spawn a fish at. Used by bulk spawners that only know XZ.
     */
    findSubmergedY(x: number, z: number): number | null {
        const voxelWorld = this.getVoxelWorld();
        const bounds = voxelWorld?.getBounds();
        if (!voxelWorld || !bounds) return null;
        const step = voxelWorld.getVoxelSize();

        // First water voxel scanning down from the top = surface
        let surfaceY: number | null = null;
        for (let y = bounds.maxY; y >= bounds.minY; y -= step) {
            if (this.isWaterAt(x, y, z)) { surfaceY = y; break; }
        }
        if (surfaceY === null) return null;

        // Descend to the bottom of this water column
        let bottomY = surfaceY;
        for (let y = surfaceY - step; y >= bounds.minY; y -= step) {
            if (!this.isWaterAt(x, y, z)) break;
            bottomY = y;
        }
        return (surfaceY + bottomY) / 2;
    }

    /** True when a voxel world exists (water queries are meaningful). */
    hasVoxelWorld(): boolean {
        return this.getVoxelWorld() !== null;
    }
}
