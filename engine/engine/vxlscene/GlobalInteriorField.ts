/**
 * Global flood-fill interior field for the GLB scene voxelizer.
 *
 * Replaces the per-chunk generalized-winding-number interior fill (the ~96% bake
 * bottleneck) with ONE coarse flood-fill over the whole world. A single coarse grid
 * at `cellSize` (~1–2 m) is built once: cells overlapping any triangle's AABB are
 * marked SURFACE; the exterior is flood-filled (6-connectivity) inward from the
 * boundary ring; whatever the flood never reaches and is not surface is ENCLOSED
 * interior. `isInterior(world)` then answers in O(1) per query.
 *
 * Trade-off vs. the winding number: this is a connectivity test, not a solid-angle
 * test. An open shell (a missing face) lets the exterior flood leak into the cavity,
 * so cells reachable through the opening classify as exterior. For the voxelizer this
 * is acceptable — interior voxels are invisible (face-culled) and only provide bulk
 * colliders; a leaking cavity simply stays hollow, exactly as a hole in the mesh
 * already implies. In return the whole interior pass is a single linear flood instead
 * of thousands of per-chunk winding lattices.
 *
 * Coarse cell states: 0 = unknown (→ enclosed interior), 1 = surface, 2 = exterior.
 * The grid spans `bounds` plus a 1-cell margin on every side, so the boundary ring is
 * guaranteed exterior (the flood always has a seed). Deterministic; bounded memory.
 *
 * `fillInteriorFromField` consumes the field per chunk: it classifies the chunk's
 * interior on a small chunk-aligned COARSE lattice (one O(1) field lookup per coarse
 * cell), octree-merges the interior occupancy into LARGE power-of-two voxels (uncapped
 * by default — a fully-enclosed chunk collapses to ONE whole-chunk voxel), and returns
 * the same `{ voxels, isSolid }` contract the old per-chunk winding fill produced, so
 * the mesher culls surface faces against the interior bulk exactly as before.
 */

import type { CellAttr, RGB, SceneVoxel } from 'engine/vxlscene/SceneVoxTypes.js';
import type { RasterCtx } from 'engine/vxlscene/SurfaceRasterizer.js';
import { unpackCell } from 'engine/vxlscene/SurfaceRasterizer.js';
import type { InteriorResult } from 'engine/vxlscene/WindingNumberFill.js';

export interface GlobalTriangle {
    v0: [number, number, number];
    v1: [number, number, number];
    v2: [number, number, number];
}

export interface GlobalInteriorBounds {
    minX: number; minY: number; minZ: number;
    maxX: number; maxY: number; maxZ: number;
}

export interface GlobalInteriorField {
    /** True iff the world point lies in an enclosed (interior) coarse cell. */
    isInterior: (wx: number, wy: number, wz: number) => boolean;
    /**
     * True iff ANY enclosed cell exists in the whole world (the flood left at least one
     * UNKNOWN cell). Open models (heightfields, terrain ridges, single surfaces) have no
     * enclosed volume → false, letting per-chunk interior fill short-circuit to nothing.
     */
    hasInterior: boolean;
    /**
     * True iff the WORLD-space AABB [minX..maxX]×… overlaps the bounding box of all
     * enclosed (interior) cells. A region outside this box provably contains no interior,
     * so per-chunk fill can skip its coarse scan entirely. When `hasInterior` is false this
     * always returns false. The bound is conservative (cell-granular) but exact-reject.
     */
    interiorAabbOverlaps: (minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number) => boolean;
    /** The coarse cell edge length actually used (may exceed opts.cellSize if capped). */
    cellSize: number;
    /** Coarse grid dimensions (including the 1-cell margin on each side). */
    nx: number; ny: number; nz: number;
}

/** Coarse cell states. */
const UNKNOWN = 0; // never reached by the exterior flood and not surface → interior
const SURFACE = 1;
const EXTERIOR = 2;

/**
 * Safety cap on total coarse cells. At 2 m over a 1024×144×1024 world this is ~19 M;
 * the cap (64 M) protects against a pathological tiny cellSize on a huge world by
 * growing cellSize until the grid fits (a logged note, not an error).
 */
const MAX_CELLS = 64_000_000;

/**
 * Build the global interior field. `tris` are WORLD-space triangles; `bounds` is the
 * world AABB (need not be chunk-snapped); `opts.cellSize` is the desired coarse edge.
 */
export function buildGlobalInterior(
    tris: GlobalTriangle[],
    bounds: GlobalInteriorBounds,
    opts: { cellSize: number },
): GlobalInteriorField {
    // --- Choose a cell size that keeps the grid under the safety cap ---
    const spanX = Math.max(0, bounds.maxX - bounds.minX);
    const spanY = Math.max(0, bounds.maxY - bounds.minY);
    const spanZ = Math.max(0, bounds.maxZ - bounds.minZ);
    let cellSize = opts.cellSize > 0 ? opts.cellSize : 1;
    // Grow cellSize (doubling) until (cells + 2-cell margin per axis) fits the cap.
    const cellsForSize = (cs: number): number => {
        const cx = Math.max(1, Math.ceil(spanX / cs)) + 2;
        const cy = Math.max(1, Math.ceil(spanY / cs)) + 2;
        const cz = Math.max(1, Math.ceil(spanZ / cs)) + 2;
        return cx * cy * cz;
    };
    while (cellsForSize(cellSize) > MAX_CELLS) cellSize *= 2;

    // --- Grid dimensions (with a 1-cell margin on every side) ---
    // Cell (ix,iy,iz) spans world [minX + (ix-1)*cellSize, …); the margin shifts the
    // origin down by one cell so index 0 and index n-1 are always outside `bounds`.
    const innerX = Math.max(1, Math.ceil(spanX / cellSize));
    const innerY = Math.max(1, Math.ceil(spanY / cellSize));
    const innerZ = Math.max(1, Math.ceil(spanZ / cellSize));
    const nx = innerX + 2;
    const ny = innerY + 2;
    const nz = innerZ + 2;
    const originX = bounds.minX - cellSize; // world coord of cell index 0's min corner
    const originY = bounds.minY - cellSize;
    const originZ = bounds.minZ - cellSize;

    const state = new Uint8Array(nx * ny * nz); // all UNKNOWN (0)

    // Row-major index (x fastest within a y,z layer keeps the exterior-flood neighbour
    // arithmetic simple; any consistent layout works since it's purely internal).
    const idx = (ix: number, iy: number, iz: number): number => (iz * ny + iy) * nx + ix;

    // World → coarse cell index per axis. Returns -1 if outside the grid.
    const cellX = (wx: number): number => Math.floor((wx - originX) / cellSize);
    const cellY = (wy: number): number => Math.floor((wy - originY) / cellSize);
    const cellZ = (wz: number): number => Math.floor((wz - originZ) / cellSize);

    // --- Mark surface cells: conservative AABB overlap per triangle ---
    // At this coarse level an exact triBoxOverlap is unnecessary — over-marking a few
    // boundary cells only thickens the surface shell by at most one coarse cell, which
    // is exactly the band we already accept as hollow.
    for (const t of tris) {
        const { v0, v1, v2 } = t;
        const tMinX = Math.min(v0[0], v1[0], v2[0]);
        const tMinY = Math.min(v0[1], v1[1], v2[1]);
        const tMinZ = Math.min(v0[2], v1[2], v2[2]);
        const tMaxX = Math.max(v0[0], v1[0], v2[0]);
        const tMaxY = Math.max(v0[1], v1[1], v2[1]);
        const tMaxZ = Math.max(v0[2], v1[2], v2[2]);

        // Clamp the cell range to the inner region [1, n-2] (margin ring stays exterior).
        const ix0 = Math.max(1, cellX(tMinX));
        const ix1 = Math.min(nx - 2, cellX(tMaxX));
        const iy0 = Math.max(1, cellY(tMinY));
        const iy1 = Math.min(ny - 2, cellY(tMaxY));
        const iz0 = Math.max(1, cellZ(tMinZ));
        const iz1 = Math.min(nz - 2, cellZ(tMaxZ));
        if (ix0 > ix1 || iy0 > iy1 || iz0 > iz1) continue;

        for (let iz = iz0; iz <= iz1; iz++) {
            for (let iy = iy0; iy <= iy1; iy++) {
                const rowBase = (iz * ny + iy) * nx;
                for (let ix = ix0; ix <= ix1; ix++) {
                    state[rowBase + ix] = SURFACE;
                }
            }
        }
    }

    // --- Flood-fill the exterior from the boundary ring (6-connectivity) ---
    // Seed every non-surface cell on the outer shell, then BFS over non-surface cells.
    // The margin guarantees the whole shell is non-surface, so the flood always starts.
    const stack: number[] = [];
    const pushIfOpen = (i: number): void => {
        if (state[i] === UNKNOWN) { state[i] = EXTERIOR; stack.push(i); }
    };
    // Seed the 6 boundary faces of the grid.
    for (let iy = 0; iy < ny; iy++) {
        for (let ix = 0; ix < nx; ix++) {
            pushIfOpen(idx(ix, iy, 0));
            pushIfOpen(idx(ix, iy, nz - 1));
        }
    }
    for (let iz = 0; iz < nz; iz++) {
        for (let ix = 0; ix < nx; ix++) {
            pushIfOpen(idx(ix, 0, iz));
            pushIfOpen(idx(ix, ny - 1, iz));
        }
    }
    for (let iz = 0; iz < nz; iz++) {
        for (let iy = 0; iy < ny; iy++) {
            pushIfOpen(idx(0, iy, iz));
            pushIfOpen(idx(nx - 1, iy, iz));
        }
    }

    // Iterative flood (explicit stack). Decode the linear index to step neighbours
    // without per-cell modulo in the hot path beyond the initial decode.
    const layer = nx * ny;
    while (stack.length > 0) {
        const i = stack.pop()!;
        const iz = Math.floor(i / layer);
        const rem = i - iz * layer;
        const iy = Math.floor(rem / nx);
        const ix = rem - iy * nx;
        if (ix > 0) pushIfOpen(i - 1);
        if (ix < nx - 1) pushIfOpen(i + 1);
        if (iy > 0) pushIfOpen(i - nx);
        if (iy < ny - 1) pushIfOpen(i + nx);
        if (iz > 0) pushIfOpen(i - layer);
        if (iz < nz - 1) pushIfOpen(i + layer);
    }

    // Any cell the flood never reached and that is not surface is enclosed interior.
    // One linear scan: set `hasInterior` and accumulate the interior cells' index AABB so
    // per-chunk fill can reject regions that provably hold no interior (and skip entirely
    // for fully-open models). Decode each linear index to (ix,iy,iz) only for UNKNOWN cells.
    let hasInterior = false;
    let iMinX = Infinity, iMinY = Infinity, iMinZ = Infinity;
    let iMaxX = -Infinity, iMaxY = -Infinity, iMaxZ = -Infinity;
    {
        const layer2 = nx * ny;
        for (let i = 0; i < state.length; i++) {
            if (state[i] !== UNKNOWN) continue;
            hasInterior = true;
            const iz = Math.floor(i / layer2);
            const rem = i - iz * layer2;
            const iy = Math.floor(rem / nx);
            const ix = rem - iy * nx;
            if (ix < iMinX) iMinX = ix; if (ix > iMaxX) iMaxX = ix;
            if (iy < iMinY) iMinY = iy; if (iy > iMaxY) iMaxY = iy;
            if (iz < iMinZ) iMinZ = iz; if (iz > iMaxZ) iMaxZ = iz;
        }
    }
    // World-space AABB of the interior cells (cell ix spans [originX + ix·cellSize, +cellSize)).
    const interiorWMinX = originX + iMinX * cellSize;
    const interiorWMinY = originY + iMinY * cellSize;
    const interiorWMinZ = originZ + iMinZ * cellSize;
    const interiorWMaxX = originX + (iMaxX + 1) * cellSize;
    const interiorWMaxY = originY + (iMaxY + 1) * cellSize;
    const interiorWMaxZ = originZ + (iMaxZ + 1) * cellSize;
    const interiorAabbOverlaps = (
        minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number,
    ): boolean => {
        if (!hasInterior) return false;
        return maxX > interiorWMinX && minX < interiorWMaxX
            && maxY > interiorWMinY && minY < interiorWMaxY
            && maxZ > interiorWMinZ && minZ < interiorWMaxZ;
    };

    const isInterior = (wx: number, wy: number, wz: number): boolean => {
        const ix = cellX(wx);
        if (ix < 0 || ix >= nx) return false;
        const iy = cellY(wy);
        if (iy < 0 || iy >= ny) return false;
        const iz = cellZ(wz);
        if (iz < 0 || iz >= nz) return false;
        // Enclosed interior ⇔ neither surface nor reached by the exterior flood.
        return state[idx(ix, iy, iz)] === UNKNOWN;
    };

    return { isInterior, hasInterior, interiorAabbOverlaps, cellSize, nx, ny, nz };
}

/**
 * One interior block during the bottom-up octree merge: a power-of-two cube of coarse
 * cells. `cx,cy,cz` are coarse-cell coords at the current merge level `L` (so the block
 * spans `[cx·2^L, (cx+1)·2^L)` coarse cells per axis).
 */
function packBlockKey(cx: number, cy: number, cz: number): number {
    // Coarse coords are small non-negative integers (< ~16 per axis at level 0, fewer
    // at higher levels), so a 16-bit radix is ample and uniquely decodable.
    return (cx * 65536 + cy) * 65536 + cz;
}
function unpackBlockKey(key: number): [number, number, number] {
    const cz = key % 65536;
    const cy = Math.floor(key / 65536) % 65536;
    const cx = Math.floor(key / (65536 * 65536));
    return [cx, cy, cz];
}

/**
 * Classify a chunk's interior from the GLOBAL field and emit LARGE octree-merged
 * interior voxels (design: solid interiors everywhere, fast).
 *
 * Mirrors the old per-chunk `fillInterior` contract (`{ voxels, isSolid }`) but is
 * driven by O(1) field lookups instead of per-cell winding queries — the heavy work
 * moved to the one-time `buildGlobalInterior` flood. Does NOT mutate `grid` (it stays
 * surface-only). Interior is resolved on a small chunk-aligned COARSE lattice (stride S
 * chosen so the lattice is ≤ ~16 per axis), then octree-merged: a fully-enclosed chunk
 * collapses to ONE whole-chunk voxel; a partially-interior chunk yields a few large
 * voxels covering only the enclosed coarse blocks. Voxels carry a single uniform color
 * (the average surface color of the chunk, or `opts.defaultColor`), `noCollider:false`,
 * `disp:null`. By default voxel size is NOT capped (interior is invisible/face-culled,
 * so it is not bound by maxVoxelSize); pass `opts.maxSizeLevel` to cap it.
 *
 * Coordinates: `voxels` and `isSolid` use the SAME chunk-resolution global cell coords
 * as `grid` (the caller converts to chunk-local exactly as it does for surface voxels).
 */
export function fillInteriorFromField(
    grid: Map<number, CellAttr>,
    ctx: RasterCtx,
    field: GlobalInteriorField,
    opts?: { defaultColor?: RGB; maxSizeLevel?: number },
): InteriorResult {
    const { originCellX, originCellY, originCellZ, cellsPerAxis, minVoxelSize } = ctx;

    // Fast exit: if this chunk's world AABB lies entirely outside the interior cells'
    // bounding box (and for fully-open models, always), there is provably no interior to
    // fill here — skip the coarse scan + surface-color pass. `isSolid` is constant-false.
    const chunkWMinX = originCellX * minVoxelSize;
    const chunkWMinY = originCellY * minVoxelSize;
    const chunkWMinZ = originCellZ * minVoxelSize;
    const chunkWMaxX = (originCellX + cellsPerAxis) * minVoxelSize;
    const chunkWMaxY = (originCellY + cellsPerAxis) * minVoxelSize;
    const chunkWMaxZ = (originCellZ + cellsPerAxis) * minVoxelSize;
    if (!field.interiorAabbOverlaps(chunkWMinX, chunkWMinY, chunkWMinZ, chunkWMaxX, chunkWMaxY, chunkWMaxZ)) {
        return { voxels: [], isSolid: (): boolean => false };
    }

    // Coarse stride S (power of two): grow until the coarse lattice is ≤ ~16 per axis,
    // matching the old fillInterior so the interior boundary stays block-granular. S=1
    // for small chunks (cellsPerAxis < 32). coarsePerAxis is then a power of two that
    // exactly divides cellsPerAxis, so coarse blocks octree-merge up to the whole chunk.
    let stride = 1;
    while (Math.floor(cellsPerAxis / (stride * 2)) >= 16) stride *= 2;
    const coarsePerAxis = Math.max(1, Math.round(cellsPerAxis / stride));
    const strideLevel = Math.round(Math.log2(stride));

    // Local coarse-coord packing (coords in [0, coarsePerAxis)).
    const coarseKey = (cgx: number, cgy: number, cgz: number): number =>
        (cgx * 65536 + cgy) * 65536 + cgz;

    // One pass over the (surface-only) grid: record coarse cells that contain a surface
    // min-cell (skipped — surface faces are owned by the rasterized grid, the interior
    // bulk only fills surface-free blocks) and accumulate the average surface color.
    const surfaceCoarse = new Set<number>();
    let sumR = 0, sumG = 0, sumB = 0, surfCount = 0;
    for (const [key, attr] of grid) {
        if (attr.interior) continue; // grid is surface-only, but stay defensive
        const [x, y, z] = unpackCell(key);
        surfaceCoarse.add(coarseKey(
            Math.floor((x - originCellX) / stride),
            Math.floor((y - originCellY) / stride),
            Math.floor((z - originCellZ) / stride),
        ));
        sumR += attr.color.r; sumG += attr.color.g; sumB += attr.color.b;
        surfCount++;
    }
    const interiorColor: RGB = surfCount > 0
        ? { r: sumR / surfCount, g: sumG / surfCount, b: sumB / surfCount }
        : (opts?.defaultColor ?? { r: 0.5, g: 0.5, b: 0.5 });

    // --- Classify each coarse cell: interior iff the field says so AND it is surface-free. ---
    // Deterministic order (cgx outer, cgy middle, cgz inner). One O(1) field lookup each.
    const interiorCoarse = new Set<number>();
    for (let cgx = 0; cgx < coarsePerAxis; cgx++) {
        const baseX = originCellX + cgx * stride;
        const blockEndX = Math.min(baseX + stride, originCellX + cellsPerAxis);
        for (let cgy = 0; cgy < coarsePerAxis; cgy++) {
            const baseY = originCellY + cgy * stride;
            const blockEndY = Math.min(baseY + stride, originCellY + cellsPerAxis);
            for (let cgz = 0; cgz < coarsePerAxis; cgz++) {
                if (surfaceCoarse.has(coarseKey(cgx, cgy, cgz))) continue;
                const baseZ = originCellZ + cgz * stride;
                const blockEndZ = Math.min(baseZ + stride, originCellZ + cellsPerAxis);
                // Sample the field at the (clamped) coarse-block center, in WORLD coords.
                const wx = ((baseX + blockEndX) * 0.5) * minVoxelSize;
                const wy = ((baseY + blockEndY) * 0.5) * minVoxelSize;
                const wz = ((baseZ + blockEndZ) * 0.5) * minVoxelSize;
                if (field.isInterior(wx, wy, wz)) interiorCoarse.add(coarseKey(cgx, cgy, cgz));
            }
        }
    }

    // --- isSolid: coarse-granular, used by the mesher to cull faces abutting interior. ---
    const endCellX = originCellX + cellsPerAxis;
    const endCellY = originCellY + cellsPerAxis;
    const endCellZ = originCellZ + cellsPerAxis;
    const isSolid = (gx: number, gy: number, gz: number): boolean => {
        if (gx < originCellX || gx >= endCellX) return false;
        if (gy < originCellY || gy >= endCellY) return false;
        if (gz < originCellZ || gz >= endCellZ) return false;
        return interiorCoarse.has(coarseKey(
            Math.floor((gx - originCellX) / stride),
            Math.floor((gy - originCellY) / stride),
            Math.floor((gz - originCellZ) / stride),
        ));
    };

    // --- Octree-merge the coarse interior occupancy into LARGE power-of-two voxels. ---
    // Bottom-up (like VoxelCompactor.compact): at each level group blocks by parent; a
    // parent of 8 present children promotes to the next level, leftover blocks emit as
    // voxels at the current level. O(interior coarse cells). Stride and coarsePerAxis are
    // powers of two, so all coords/extents stay grid-aligned for their sizeLevel.
    // The merge stops at maxLevel = log2(coarsePerAxis) (a whole-chunk voxel) or, when an
    // explicit cap is given, when strideLevel+L would exceed opts.maxSizeLevel.
    const maxMergeLevel = Math.round(Math.log2(coarsePerAxis)); // 0 when coarsePerAxis === 1
    const capLevel = opts?.maxSizeLevel !== undefined
        ? Math.max(0, opts.maxSizeLevel - strideLevel)   // highest merge level allowed by the cap
        : maxMergeLevel;
    const stopLevel = Math.min(maxMergeLevel, capLevel);

    const voxels: SceneVoxel[] = [];
    const emitBlock = (cx: number, cy: number, cz: number, level: number): void => {
        const blockCoarse = 1 << level;            // coarse cells per block edge
        const minCellStart = blockCoarse * stride; // chunk-res min-cells per block edge
        voxels.push({
            gx: originCellX + cx * minCellStart,
            gy: originCellY + cy * minCellStart,
            gz: originCellZ + cz * minCellStart,
            sizeLevel: strideLevel + level,
            color: interiorColor,
            noCollider: false,
            disp: null,
        });
    };

    // Level-0 blocks = the interior coarse cells.
    let current = new Set<number>(interiorCoarse);
    for (let level = 0; level < stopLevel; level++) {
        // Group present blocks by parent coord; promote full octets, defer the rest.
        const parentChildren = new Map<number, number[]>();
        for (const key of current) {
            const [cx, cy, cz] = unpackBlockKey(key);
            const pKey = packBlockKey(cx >> 1, cy >> 1, cz >> 1);
            let arr = parentChildren.get(pKey);
            if (!arr) { arr = []; parentChildren.set(pKey, arr); }
            arr.push(key);
        }
        const next = new Set<number>();
        const consumed = new Set<number>();
        // Deterministic parent order.
        const parentKeys = Array.from(parentChildren.keys()).sort((a, b) => a - b);
        for (const pKey of parentKeys) {
            const children = parentChildren.get(pKey)!;
            if (children.length === 8) {
                next.add(pKey);
                for (const c of children) consumed.add(c);
            }
        }
        // Emit every block not promoted, at this level (deterministic order).
        const curKeys = Array.from(current).sort((a, b) => a - b);
        for (const key of curKeys) {
            if (consumed.has(key)) continue;
            const [cx, cy, cz] = unpackBlockKey(key);
            emitBlock(cx, cy, cz, level);
        }
        current = next;
        if (current.size === 0) break;
    }
    // Emit whatever survived to the stop level.
    if (current.size > 0) {
        const curKeys = Array.from(current).sort((a, b) => a - b);
        for (const key of curKeys) {
            const [cx, cy, cz] = unpackBlockKey(key);
            emitBlock(cx, cy, cz, stopLevel);
        }
    }

    return { voxels, isSolid };
}
