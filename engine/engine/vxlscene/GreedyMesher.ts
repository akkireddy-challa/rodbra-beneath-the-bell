/**
 * Greedy mesher for the GLB scene voxelizer (design §3.9).
 *
 * Builds the static render geometry hint for a chunk by greedy-meshing the
 * resolved min-cell attribute grid (NOT the variable-size compacted voxels):
 *   1. Hidden-face culling: a face is emitted only at a solid|empty boundary.
 *   2. Color-aware greedy merge: maximal SAME-COLOR coplanar rectangles are
 *      merged into one quad (Lysenko per-slice sweep).
 *
 * The result is the minimal quad set with zero coincident faces, so NO
 * polygonOffset is ever needed downstream. Displacement-flagged cells (design
 * §3.8) are EXCLUDED from the sweep — they render as a welded heightfield surface
 * mesh (SurfaceMeshBuilder) elsewhere — so every emitted greedy quad keeps `disp: 0`.
 *
 * SPARSE sweep: the grid is surface-only (a thin band through the chunk volume), so
 * the sweep iterates the grid's ACTUAL cells and buckets their exposed faces by
 * (axis, dir, slice), then merges each slice over its OWN populated sub-bounding-box.
 * The earlier implementation allocated a dense `uCount×vCount` mask per slice and did a
 * `Map.get` for every cell in the chunk bounding box (~12 M lookups per fine chunk where
 * ~16 K cells exist) — greedy-meshing was ~69% of bake time. The sparse sweep produces
 * byte-identical quads (same scan order, same merge) for a fraction of the work.
 */

import type { CellAttr, RGB, SceneQuad } from 'engine/vxlscene/SceneVoxTypes.js';
import { packCell, unpackCell } from 'engine/vxlscene/SurfaceRasterizer.js';

/** Optional meshing context. */
export interface MeshCtx {
    /**
     * Extra occupancy predicate for face culling. A neighbour min-cell counts as
     * solid (its shared face is culled) if it is in `grid` OR `isSolidExtra` returns
     * true for it — used to cull surface faces that abut the large interior bulk
     * (which is NOT in `grid`). Absent → only `grid` membership culls faces (the
     * historical behaviour for callers that pass no ctx).
     */
    isSolidExtra?: (gx: number, gy: number, gz: number) => boolean;
}

/** Quantize a channel to /255 so float colors compare exactly. */
function q255(c: number): number {
    return Math.round(c * 255);
}

/** Pack a quantized RGB into a single integer key for mask equality. */
function colorKey(c: RGB): number {
    return (q255(c.r) * 256 + q255(c.g)) * 256 + q255(c.b);
}

/** One exposed face awaiting merge: in-plane (u,v) coords, merge key, and emit attrs. */
interface Face {
    u: number;
    v: number;
    /** (colorKey << 1) | noCollider — quads never span both color and collidability. */
    key: number;
    color: RGB; // original (un-quantized) color, emitted verbatim
    nc: number; // noCollider flag (0/1)
}

/** Exposed faces of one slice (a fixed value of axis d), with their u/v sub-bbox. */
interface Slice {
    faces: Face[];
    minU: number; maxU: number;
    minV: number; maxV: number;
}

/**
 * Greedy-mesh a min-cell grid into face-culled, color-merged quads.
 * Coordinates are min-cell grid coords; every emitted quad has `disp: 0`.
 *
 * For each axis d (0=X,1=Y,2=Z) and direction dir (+1, -1) we collect the exposed
 * faces (a cell is solid and its neighbour at +dir along d is empty) and bucket them
 * by slice (the d-coordinate). On each slice we greedily merge maximal equal-color
 * rectangles in the (u,v) plane (u = (d+1)%3, v = (d+2)%3), emitting one SceneQuad each.
 */
export function greedyMesh(grid: Map<number, CellAttr>, ctx?: MeshCtx): SceneQuad[] {
    const isSolidExtra = ctx?.isSolidExtra;
    const quads: SceneQuad[] = [];
    if (grid.size === 0) return quads;

    /** Grid lookup that treats displaced cells as empty (excluded from the sweep). */
    const at = (x: number, y: number, z: number): CellAttr | undefined => {
        const c = grid.get(packCell(x, y, z));
        return c && c.displacementAxis === null ? c : undefined;
    };
    /**
     * Is the neighbour at (x,y,z) solid for face-culling? A grid-aligned cell counts,
     * as does any cell the extra occupancy predicate marks solid (the interior bulk,
     * which is not in `grid`). Displaced cells are excluded (matches `at`).
     */
    const neighborSolid = (x: number, y: number, z: number): boolean =>
        at(x, y, z) !== undefined || (isSolidExtra?.(x, y, z) ?? false);

    /** Assemble a coord vector from per-axis values for axes d/u/v (all distinct). */
    const compose = (
        d: number, u: number, v: number, dv: number, uv: number, vv: number,
    ): [number, number, number] => {
        const comp = (j: number): number => (j === d ? dv : j === u ? uv : vv);
        return [comp(0), comp(1), comp(2)];
    };

    // Iterate axes and directions in a fixed, deterministic order.
    for (let d = 0; d < 3; d++) {
        const u = (d + 1) % 3;
        const v = (d + 2) % 3;

        for (const dir of [-1, 1] as const) {
            // ── Collect exposed faces, bucketed by slice (the d-coordinate). One pass over
            //    the SPARSE grid cells — no dense per-cell lookup over the chunk volume. ──
            const slices = new Map<number, Slice>();
            for (const [key, cell] of grid) {
                if (cell.displacementAxis !== null) continue; // displaced -> not in sweep
                const [x, y, z] = unpackCell(key);
                // Neighbour along +dir on axis d (only the d-component changes).
                const nx = x + (d === 0 ? dir : 0);
                const ny = y + (d === 1 ? dir : 0);
                const nz = z + (d === 2 ? dir : 0);
                if (neighborSolid(nx, ny, nz)) continue; // face hidden
                const sVal = d === 0 ? x : d === 1 ? y : z;
                const uVal = u === 0 ? x : u === 1 ? y : z;
                const vVal = v === 0 ? x : v === 1 ? y : z;
                let slice = slices.get(sVal);
                if (!slice) {
                    slice = { faces: [], minU: Infinity, maxU: -Infinity, minV: Infinity, maxV: -Infinity };
                    slices.set(sVal, slice);
                }
                const nc0 = cell.noCollider ? 1 : 0;
                // colorKey ≤ 0xFFFFFF; shift up one bit for the collidability flag.
                slice.faces.push({ u: uVal, v: vVal, key: (colorKey(cell.color) << 1) | nc0, color: cell.color, nc: nc0 });
                if (uVal < slice.minU) slice.minU = uVal;
                if (uVal > slice.maxU) slice.maxU = uVal;
                if (vVal < slice.minV) slice.minV = vVal;
                if (vVal > slice.maxV) slice.maxV = vVal;
            }

            // Sweep slices in ascending d-order (deterministic — matches the old dMin..dMax loop).
            const sliceVals = Array.from(slices.keys()).sort((a, b) => a - b);
            for (const s of sliceVals) {
                const slice = slices.get(s)!;
                const uMin = slice.minU, vMin = slice.minV;
                const uCount = slice.maxU - uMin + 1;
                const vCount = slice.maxV - vMin + 1;

                // Mask over the slice's OWN (u,v) sub-bbox; -1 = no face, else the merge key.
                const mask = new Int32Array(uCount * vCount).fill(-1);
                const maskColor: (RGB | null)[] = new Array(uCount * vCount).fill(null);
                const maskNoCollider = new Uint8Array(uCount * vCount);
                for (const f of slice.faces) {
                    const idx = (f.u - uMin) * vCount + (f.v - vMin);
                    mask[idx] = f.key;
                    maskColor[idx] = f.color;
                    maskNoCollider[idx] = f.nc;
                }

                // Greedy-merge equal-color rectangles in the mask (identical to the dense sweep,
                // just over the slice's sub-bbox; rectangle origins are absolute u/v coords).
                const m = (i: number): number => mask[i] ?? -1;
                for (let iu = 0; iu < uCount; iu++) {
                    for (let iv = 0; iv < vCount; iv++) {
                        const start = iu * vCount + iv;
                        const ck = m(start);
                        if (ck < 0) continue;

                        // Extend width along v (contiguous run on this u row).
                        let w = 1;
                        while (iv + w < vCount && m(iu * vCount + (iv + w)) === ck) w++;

                        // Extend height along u while every cell of the run matches.
                        let h = 1;
                        let extend = true;
                        while (iu + h < uCount && extend) {
                            for (let k = 0; k < w; k++) {
                                if (m((iu + h) * vCount + (iv + k)) !== ck) { extend = false; break; }
                            }
                            if (extend) h++;
                        }

                        // Mark the rectangle consumed.
                        for (let du = 0; du < h; du++) {
                            for (let dv = 0; dv < w; dv++) {
                                mask[(iu + du) * vCount + (iv + dv)] = -1;
                            }
                        }

                        // Emit. Origin corner is the min-cell of the rectangle origin.
                        const origin = compose(d, u, v, s, uMin + iu, vMin + iv);
                        const color = maskColor[start];
                        if (!color) continue; // unreachable (ck>=0 implies color set)
                        quads.push({
                            gx: origin[0], gy: origin[1], gz: origin[2],
                            // w = extent along axis u, h = extent along axis v.
                            w: h, h: w,
                            axis: d as 0 | 1 | 2,
                            dir,
                            color: { r: color.r, g: color.g, b: color.b },
                            disp: 0,
                            noCollider: maskNoCollider[start] === 1,
                        });
                    }
                }
            }
        }
    }

    return quads;
}
