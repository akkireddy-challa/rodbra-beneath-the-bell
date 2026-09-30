/**
 * Robust interior classification via the generalized winding number (design §3.6, §8.5).
 *
 * After the surface rasterizer (SurfaceRasterizer.ts) marks surface min-cells, every
 * remaining EMPTY cell whose center lies inside the mesh must be filled solid, while
 * open exterior cells stay empty. The generalized winding number (GWN) gives a
 * leak-proof inside test that works on non-watertight artist meshes:
 *
 *   w(p) = (1 / 4π) · Σ_t Ω_t(p)
 *
 * where Ω_t is the signed solid angle that triangle t subtends at p. For a closed,
 * outward-oriented mesh w ≈ 1 inside and w ≈ 0 outside; a single missing face only
 * perturbs w by that face's solid-angle fraction, so |w| ≥ 0.5 still classifies a
 * deep interior point as inside. Classification uses |w| ≥ 0.5, so a globally flipped
 * mesh (w ≈ -1 inside) still classifies correctly.
 *
 * PERFORMANCE (design §3.6, §8.5 — Barill et al., "Fast Winding Numbers for Soups and
 * Clouds", SIGGRAPH 2018):
 *
 *   1. windingAt is accelerated by a BVH with an order-0 (dipole) far-field expansion.
 *      A node aggregates P = Σ A_i n_i (area-weighted normal sum) and an area-weighted
 *      centroid c̄. For a query point p far from the node (|p − c̄| > BETA·r, r = node
 *      radius), the node's whole solid-angle contribution is approximated by the dipole
 *      term (P · (c̄ − p)) / (4π · d³); otherwise we recurse / sum exact leaf solid
 *      angles. This is O(log n) per query for points away from the surface and falls
 *      back to the exact brute-force sum near it, so classifications match the reference.
 *
 *   2. fillInterior classifies interior on the COARSE lattice ONLY and emits LARGE
 *      interior voxels — it never evaluates winding per min-cell and never does a
 *      per-cell nearest-surface-color scan. With stride S (chosen so the coarse grid
 *      is ≤ ~16 per axis) every coarse cell with NO surface gets ONE winding query at
 *      its center; inside cells emit power-of-two interior voxels tiling the S-block
 *      with a single UNIFORM color (the average of the surface colors). This bounds
 *      winding evals to ~(cellsPerAxis/S)³ and the emitted-voxel count to ~coarse
 *      blocks, instead of the cellsPerAxis³ dense queries + O(volume) cells of the old
 *      coarse-then-refine fill. Interior is invisible unless destruction reveals it,
 *      so the uniform color and coarse (block-granular) boundary are acceptable; the
 *      tradeoff is a sub-surface "hollow band" up to one coarse block thick where a
 *      surface-straddling coarse cell is skipped entirely (it is never refined).
 *      The result is consumed alongside `compact(grid)`; the grid stays surface-only.
 */

import type { CellAttr, RGB, SceneVoxel } from 'engine/vxlscene/SceneVoxTypes.js';
import type { RasterCtx } from 'engine/vxlscene/SurfaceRasterizer.js';
import { unpackCell } from 'engine/vxlscene/SurfaceRasterizer.js';

export interface WindingTriangle {
    v0: [number, number, number];
    v1: [number, number, number];
    v2: [number, number, number];
}

export interface WindingTree {
    /** Generalized winding number at p (≈1 inside a closed outward-oriented mesh, ≈0 outside). */
    windingAt: (p: [number, number, number]) => number;
}

const FOUR_PI = 4 * Math.PI;
/** Far-field acceptance factor: use the dipole approximation when d > BETA·r. */
const BETA = 2;
/** Max triangles in a BVH leaf before splitting. */
const LEAF_SIZE = 8;

/**
 * Signed solid angle subtended by triangle (a,b,c) at the origin-relative vectors
 * A=a−p, B=b−p, C=c−p, via the Van Oosterom–Strackee formula:
 *
 *   Ω = 2 · atan2( A·(B×C), |A||B||C| + (A·B)|C| + (A·C)|B| + (B·C)|A| )
 *
 * The sign follows the triangle's winding order. atan2 keeps the result in (−2π, 2π]
 * without the quadrant ambiguity of a plain atan.
 */
function solidAngle(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
): number {
    const la = Math.sqrt(ax * ax + ay * ay + az * az);
    const lb = Math.sqrt(bx * bx + by * by + bz * bz);
    const lc = Math.sqrt(cx * cx + cy * cy + cz * cz);

    // Degenerate: p coincides with a vertex (zero-length vector) — contributes no angle.
    if (la === 0 || lb === 0 || lc === 0) return 0;

    // Triple product A·(B×C)
    const crx = by * cz - bz * cy;
    const cry = bz * cx - bx * cz;
    const crz = bx * cy - by * cx;
    const numer = ax * crx + ay * cry + az * crz;

    const ab = ax * bx + ay * by + az * bz;
    const ac = ax * cx + ay * cy + az * cz;
    const bc = bx * cx + by * cy + bz * cz;

    const denom = la * lb * lc + ab * lc + ac * lb + bc * la;

    return 2 * Math.atan2(numer, denom);
}

/** Per-triangle precomputed geometry used by the BVH (area-weighted normal + centroid). */
interface TriData {
    tri: WindingTriangle;
    /** Centroid. */
    cx: number; cy: number; cz: number;
    /** Area-weighted normal A·n (i.e. 0.5·(e1×e2); its length is the triangle area). */
    px: number; py: number; pz: number;
    /** AABB. */
    minX: number; minY: number; minZ: number;
    maxX: number; maxY: number; maxZ: number;
}

/** A BVH node: either an internal node with two children, or a leaf with a triangle slice. */
interface BvhNode {
    // AABB
    minX: number; minY: number; minZ: number;
    maxX: number; maxY: number; maxZ: number;
    // Aggregate dipole: P = Σ A_i n_i, area-weighted centroid c̄, and far-field radius r.
    pX: number; pY: number; pZ: number;
    cBarX: number; cBarY: number; cBarZ: number;
    radius: number;
    // Internal node children (null for leaves).
    left: BvhNode | null;
    right: BvhNode | null;
    // Leaf triangle range into the ordered TriData array [start, end).
    start: number;
    end: number;
}

function buildTriData(t: WindingTriangle): TriData {
    const { v0, v1, v2 } = t;
    const e1x = v1[0] - v0[0], e1y = v1[1] - v0[1], e1z = v1[2] - v0[2];
    const e2x = v2[0] - v0[0], e2y = v2[1] - v0[1], e2z = v2[2] - v0[2];
    // cross(e1, e2) has magnitude 2·area; half of it is the area-weighted normal A·n.
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    return {
        tri: t,
        cx: (v0[0] + v1[0] + v2[0]) / 3,
        cy: (v0[1] + v1[1] + v2[1]) / 3,
        cz: (v0[2] + v1[2] + v2[2]) / 3,
        px: 0.5 * nx, py: 0.5 * ny, pz: 0.5 * nz,
        minX: Math.min(v0[0], v1[0], v2[0]),
        minY: Math.min(v0[1], v1[1], v2[1]),
        minZ: Math.min(v0[2], v1[2], v2[2]),
        maxX: Math.max(v0[0], v1[0], v2[0]),
        maxY: Math.max(v0[1], v1[1], v2[1]),
        maxZ: Math.max(v0[2], v1[2], v2[2]),
    };
}

/**
 * Build one BVH node over data[start..end). Splits at the MEDIAN along the longest AABB
 * axis; ties resolve by triangle index, so the build is fully deterministic. Leaf when
 * the slice has ≤ LEAF_SIZE triangles. Aggregates the dipole (P, c̄, r) for the slice.
 */
function buildNode(data: TriData[], order: number[], start: number, end: number): BvhNode {
    // --- AABB + dipole aggregates over the slice ---
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let pX = 0, pY = 0, pZ = 0;
    let sumA = 0, caX = 0, caY = 0, caZ = 0; // area-weighted centroid accumulators
    for (let i = start; i < end; i++) {
        const d = data[order[i]!]!;
        if (d.minX < minX) minX = d.minX;
        if (d.minY < minY) minY = d.minY;
        if (d.minZ < minZ) minZ = d.minZ;
        if (d.maxX > maxX) maxX = d.maxX;
        if (d.maxY > maxY) maxY = d.maxY;
        if (d.maxZ > maxZ) maxZ = d.maxZ;
        pX += d.px; pY += d.py; pZ += d.pz;
        const area = Math.sqrt(d.px * d.px + d.py * d.py + d.pz * d.pz);
        sumA += area;
        caX += area * d.cx; caY += area * d.cy; caZ += area * d.cz;
    }
    // Area-weighted centroid; degenerate (zero-area) slices fall back to the AABB center.
    let cBarX: number, cBarY: number, cBarZ: number;
    if (sumA > 0) {
        cBarX = caX / sumA; cBarY = caY / sumA; cBarZ = caZ / sumA;
    } else {
        cBarX = (minX + maxX) / 2; cBarY = (minY + maxY) / 2; cBarZ = (minZ + maxZ) / 2;
    }
    // Far-field radius: max distance from c̄ to any contained triangle VERTEX.
    let r2 = 0;
    for (let i = start; i < end; i++) {
        const d = data[order[i]!]!;
        for (const v of [d.tri.v0, d.tri.v1, d.tri.v2]) {
            const dx = v[0] - cBarX, dy = v[1] - cBarY, dz = v[2] - cBarZ;
            const dd = dx * dx + dy * dy + dz * dz;
            if (dd > r2) r2 = dd;
        }
    }
    const node: BvhNode = {
        minX, minY, minZ, maxX, maxY, maxZ,
        pX, pY, pZ, cBarX, cBarY, cBarZ, radius: Math.sqrt(r2),
        left: null, right: null, start, end,
    };

    const count = end - start;
    if (count <= LEAF_SIZE) return node; // leaf

    // --- Median split along the longest AABB axis (deterministic) ---
    const ex = maxX - minX, ey = maxY - minY, ez = maxZ - minZ;
    const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
    const centroidOf = (idx: number): number => {
        const d = data[idx]!;
        return axis === 0 ? d.cx : axis === 1 ? d.cy : d.cz;
    };
    // Sort the slice of `order` by centroid on the chosen axis; tie-break by triangle
    // index so equal centroids keep a stable, reproducible order.
    const slice = order.slice(start, end);
    slice.sort((a, b) => {
        const ca = centroidOf(a), cb = centroidOf(b);
        if (ca !== cb) return ca - cb;
        return a - b;
    });
    for (let i = 0; i < slice.length; i++) order[start + i] = slice[i]!;

    const mid = start + (count >> 1);
    // Guard against a degenerate split (all centroids identical): force a non-empty split.
    const splitAt = mid > start && mid < end ? mid : start + 1;
    node.left = buildNode(data, order, start, splitAt);
    node.right = buildNode(data, order, splitAt, end);
    node.start = 0;
    node.end = 0;
    return node;
}

/**
 * Build a winding tree over `tris`. Constructs a BVH with per-node dipole aggregates and
 * answers windingAt via a far-field (dipole) / near-field (exact solid angle) tree walk.
 * Reproduces the brute-force generalized winding number; see the file header.
 */
export function buildWindingTree(tris: WindingTriangle[]): WindingTree {
    const data: TriData[] = tris.map(buildTriData);

    // Empty mesh: winding is 0 everywhere.
    if (data.length === 0) {
        return { windingAt: () => 0 };
    }

    // `order` indexes `data`; buildNode reorders it in place so leaves hold contiguous slices.
    const order: number[] = data.map((_, i) => i);
    const root = buildNode(data, order, 0, data.length);

    const beta2 = BETA * BETA;

    // Iterative tree walk (explicit stack) to avoid deep recursion on large meshes.
    // Everything is accumulated in "winding" units: an exact leaf adds solidAngle/4π,
    // a far-field node adds its already-normalized dipole value directly.
    const windingAt = (p: [number, number, number]): number => {
        const px = p[0], py = p[1], pz = p[2];
        let total = 0;

        // Explicit stack of nodes to visit.
        const stack: BvhNode[] = [root];
        while (stack.length > 0) {
            const node = stack.pop()!;

            // Far-field test: if p is far enough from the node centroid, use the dipole.
            const dx = node.cBarX - px, dy = node.cBarY - py, dz = node.cBarZ - pz;
            const d2 = dx * dx + dy * dy + dz * dz;
            const r = node.radius;
            if (d2 > beta2 * r * r && d2 > 0) {
                // Dipole far-field: w = (P · (c̄ − p)) / (4π · d³).
                const d = Math.sqrt(d2);
                const dot = node.pX * dx + node.pY * dy + node.pZ * dz;
                total += dot / (FOUR_PI * d * d2);
                continue;
            }

            if (node.left === null) {
                // Leaf: sum exact solid angle over its triangles.
                let sum = 0;
                for (let i = node.start; i < node.end; i++) {
                    const t = data[order[i]!]!.tri;
                    const v0 = t.v0, v1 = t.v1, v2 = t.v2;
                    sum += solidAngle(
                        v0[0] - px, v0[1] - py, v0[2] - pz,
                        v1[0] - px, v1[1] - py, v1[2] - pz,
                        v2[0] - px, v2[1] - py, v2[2] - pz,
                    );
                }
                total += sum / FOUR_PI;
            } else {
                stack.push(node.left);
                if (node.right !== null) stack.push(node.right);
            }
        }
        return total;
    };

    return { windingAt };
}

/** Result of interior classification: large interior voxels + a solidity predicate. */
export interface InteriorResult {
    /**
     * Large interior voxels in GLOBAL min-cell coords, tiling the inside coarse
     * blocks. Each voxel's edge = minVoxelSize·2^sizeLevel; sizes are clamped to
     * `maxSizeLevel`. Color is the uniform interior color; `noCollider:false`,
     * `disp:null`.
     */
    voxels: SceneVoxel[];
    /**
     * True if min-cell (gx,gy,gz) lies in a coarse block classified as filled
     * interior — used by the greedy mesher to cull surface faces that abut the
     * interior bulk. Cells outside the chunk's cell range return false.
     */
    isSolid: (gx: number, gy: number, gz: number) => boolean;
}

/**
 * Classify the chunk interior on the COARSE lattice and emit LARGE interior voxels.
 *
 * Does NOT mutate `grid` (the grid stays surface-only). See the file header: one
 * winding query per surface-free coarse cell decides whole S-blocks; inside blocks
 * tile into power-of-two voxels with a single uniform color (the average of all
 * surface colors, or `opts.defaultColor` when there is no surface). No per-min-cell
 * winding, no nearest-surface-color scan.
 */
export function fillInterior(
    grid: Map<number, CellAttr>,
    ctx: RasterCtx,
    tree: WindingTree,
    opts?: { defaultColor?: RGB; maxSizeLevel?: number },
): InteriorResult {
    const { originCellX, originCellY, originCellZ, cellsPerAxis, minVoxelSize } = ctx;

    // Coarse stride S (power of two): grow it until the coarse lattice is ≤ ~16 per
    // axis (same rule as before). S stays 1 for small chunks (cellsPerAxis < 32).
    let stride = 1;
    while (Math.floor(cellsPerAxis / (stride * 2)) >= 16) stride *= 2;

    // Local coarse coord packing. Local coords are in [0, cellsPerAxis/stride]
    // (< 65536 for any real chunk), so this stays a unique small integer.
    const coarseKey = (cgx: number, cgy: number, cgz: number): number =>
        (cgx * 65536 + cgy) * 65536 + cgz;

    // One pass over the (surface-only) grid: record which coarse cells contain a
    // surface min-cell, and accumulate the average surface color.
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

    // Voxel size: the whole S-block collapses to one (or a few) power-of-two voxels.
    // sizeLevel = min(log2(S), maxSizeLevel). With stride a power of two, log2 is exact.
    const strideLevel = Math.round(Math.log2(stride));
    const sizeLevel = opts?.maxSizeLevel !== undefined
        ? Math.min(strideLevel, opts.maxSizeLevel)
        : strideLevel;
    const voxStride = 1 << sizeLevel; // min-cells per emitted voxel edge (divides stride)

    const interiorCoarse = new Set<number>();
    const voxels: SceneVoxel[] = [];

    const coarsePerAxis = Math.ceil(cellsPerAxis / stride);
    const endCellX = originCellX + cellsPerAxis;
    const endCellY = originCellY + cellsPerAxis;
    const endCellZ = originCellZ + cellsPerAxis;

    // Walk the coarse lattice. Deterministic order: cgx outer, cgy middle, cgz inner.
    for (let cgx = 0; cgx < coarsePerAxis; cgx++) {
        const baseX = originCellX + cgx * stride;
        const blockEndX = Math.min(baseX + stride, endCellX);
        for (let cgy = 0; cgy < coarsePerAxis; cgy++) {
            const baseY = originCellY + cgy * stride;
            const blockEndY = Math.min(baseY + stride, endCellY);
            for (let cgz = 0; cgz < coarsePerAxis; cgz++) {
                const baseZ = originCellZ + cgz * stride;
                const blockEndZ = Math.min(baseZ + stride, endCellZ);

                // Surface-straddling coarse cells are skipped (no per-min-cell refine):
                // surface faces there are owned by the rasterized grid; the interior
                // bulk only fills surface-free blocks.
                if (surfaceCoarse.has(coarseKey(cgx, cgy, cgz))) continue;

                // ONE winding query at the (clamped) block center decides the block.
                const ccx = ((baseX + blockEndX) * 0.5) * minVoxelSize;
                const ccy = ((baseY + blockEndY) * 0.5) * minVoxelSize;
                const ccz = ((baseZ + blockEndZ) * 0.5) * minVoxelSize;
                if (Math.abs(tree.windingAt([ccx, ccy, ccz])) < 0.5) continue; // exterior

                interiorCoarse.add(coarseKey(cgx, cgy, cgz));

                // Tile the S-block with (S/voxStride)³ voxels at global coords. baseX/Y/Z
                // are multiples of stride (a power of two) and voxStride divides stride,
                // so every emitted voxel is grid-aligned for its sizeLevel.
                for (let gx = baseX; gx < blockEndX; gx += voxStride) {
                    for (let gy = baseY; gy < blockEndY; gy += voxStride) {
                        for (let gz = baseZ; gz < blockEndZ; gz += voxStride) {
                            voxels.push({
                                gx, gy, gz,
                                sizeLevel,
                                color: interiorColor,
                                noCollider: false,
                                disp: null,
                            });
                        }
                    }
                }
            }
        }
    }

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

    return { voxels, isSolid };
}
