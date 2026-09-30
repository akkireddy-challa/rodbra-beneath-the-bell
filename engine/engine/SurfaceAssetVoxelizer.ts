/**
 * Surface-raster asset voxelization — the vxlscene bake kernels applied to a
 * single asset (the same algorithm the World-Forger level bake uses).
 *
 * Where the legacy octree path decides sampling resolution TOP-DOWN with
 * flatness/coverage heuristics (and bakes any wrong call into the output —
 * multi-meter stairs on tilted-flat surfaces, one color smeared per merged
 * leaf), this path rasterizes every triangle into a uniform min-cell grid
 * first and only then merges bottom-up (`VoxelCompactor`): merging is a
 * representation choice bounded by coplanarity/color tolerances, never a
 * sampling decision. Surface fidelity is minVoxelSize everywhere.
 *
 * This module is deliberately small: callers (GLBVoxelizer) keep ownership of
 * GLB parsing, asset scaling (targetHeight/fitBox/cm heuristics), coordinate
 * shifting, fragmentation, LOD passes, and VXL encoding — all of which consume
 * plain `OctreeLeaf`s. Here we only run triangles → bake → flatten the baked
 * chunk voxels back into world-space leaves.
 */

import { bakeSceneFromTriangles } from 'engine/vxlscene/bakeScene.js';
import type { RasterTriangle } from 'engine/vxlscene/SurfaceRasterizer.js';
import type { OctreeLeaf } from 'engine/VoxelOctreeRenderer.js';

export interface SurfaceAssetBakeOptions {
    minVoxelSize: number;
    maxVoxelSize: number;
    fillInterior: boolean;
}

export interface SurfaceAssetBakeResult {
    /** World-space leaves in the SAME frame as the input triangles. */
    leaves: OctreeLeaf[];
}

/** Smallest power of two >= v (v >= 1). */
function nextPow2(v: number): number {
    let p = 1;
    while (p < v) p *= 2;
    return p;
}

/**
 * Rasterize + compact the given triangles into variable-size voxel leaves.
 * Leaf positions are min-corners in the triangles' own coordinate frame;
 * `size = minVoxelSize * 2^k` (octree-aligned), colors are linear RGB 0..1 —
 * exactly the shape `VxlV3Fragment` encoding consumes.
 */
export async function bakeSurfaceAssetLeaves(
    triangles: RasterTriangle[],
    options: SurfaceAssetBakeOptions,
): Promise<SurfaceAssetBakeResult> {
    const { minVoxelSize, maxVoxelSize, fillInterior } = options;

    // Chunk size must be a power-of-two multiple of the min voxel AND at least
    // the max voxel (a compacted voxel never crosses a chunk). 64 cells/axis is
    // the level-bake sweet spot: big enough for real merging, small enough that
    // per-chunk grids stay light.
    const maxCells = Math.max(1, Math.ceil(maxVoxelSize / minVoxelSize));
    const cellsPerAxis = Math.max(64, nextPow2(maxCells));
    const chunkSize = cellsPerAxis * minVoxelSize;

    // Interior-field resolution: the level default scales with maxVoxelSize,
    // which for an asset (max often derived from the model's size) can exceed
    // the model's own cavities — no interior found, and without interior
    // backing almost nothing merges. Scale with the ASSET instead: fine enough
    // to resolve its interior, coarse enough to stay a small flood grid.
    let maxDim = 0;
    for (const t of triangles) {
        for (const v of [t.v0, t.v1, t.v2]) {
            maxDim = Math.max(maxDim, Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2]));
        }
    }
    const interiorFieldCellSize = Math.max(minVoxelSize * 2, (maxDim * 2) / 128);

    const world = await bakeSceneFromTriangles(triangles, {
        chunkSize,
        minVoxelSize,
        maxVoxelSize,
        additionalLods: 0,
        lodDistances: [0],
        fillInterior,
        interiorFieldCellSize,
        controlsByNode: {},
    });

    const leaves: OctreeLeaf[] = [];
    // Chunk indices are ABSOLUTE world-grid indices (cx = floor(worldX / chunkSize)),
    // and each chunk's voxels are chunk-local min-cell coords.
    for (const chunk of world.chunks) {
        const ox = chunk.cx * chunkSize;
        const oy = chunk.cy * chunkSize;
        const oz = chunk.cz * chunkSize;
        for (const v of chunk.voxels) {
            leaves.push({
                x: ox + v.gx * minVoxelSize,
                y: oy + v.gy * minVoxelSize,
                z: oz + v.gz * minVoxelSize,
                size: minVoxelSize * (1 << v.sizeLevel),
                r: v.color.r, g: v.color.g, b: v.color.b,
            });
        }
    }
    return { leaves };
}
