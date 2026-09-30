/**
 * Voxel compactor (design §3.7).
 *
 * Turns a per-chunk min-cell attribute grid into compact variable-size voxels via
 * bottom-up octree merging. Uniform interior regions and coplanar/same-color surface
 * regions collapse into larger power-of-two voxels; detail, curvature, or color
 * variation stays fine.
 */

import type { CellAttr, SceneVoxel, DisplacementAxis } from 'engine/vxlscene/SceneVoxTypes.js';
import { packCell, unpackCell } from 'engine/vxlscene/SurfaceRasterizer.js';

export interface CompactCtx {
    /** Max merge level; a voxel's edge = minVoxelSize * 2^sizeLevel. */
    maxSizeLevel: number;
    /** cos of max normal deviation for surface merges (default 0.95 ≈ 18°). */
    coplanarCos: number;
    /** Max per-channel color spread (max-min) for surface merges (default 0.1). */
    colorTol: number;
}

/** Internal aggregate tracked at each level during the merge sweep. */
interface Aggregate {
    r: number; g: number; b: number;
    nx: number; ny: number; nz: number;
    interior: boolean;
    anyDisplaced: boolean;
    noCollider: boolean;
    count: number;
    /**
     * Displacement axis + offset carried from the level-0 source cell so a
     * size-0 displaced voxel can emit its `disp` vector (design §3.8). Only set
     * for level-0 aggregates (displaced cells never merge, so they only ever
     * emit at level 0); merged aggregates are non-displaced and leave these null.
     */
    displacementAxis: DisplacementAxis | null;
    dispOffset: number;
}

/** Pack a level-L coordinate (non-negative integers, smaller range than cell coords) into a key. */
function packLevelCoord(x: number, y: number, z: number): number {
    // Level coords are always non-negative and bounded by CELL_KEY_BASE/2 >> 2^maxLevel
    // Use the same scheme as packCell but without the negative-offset requirement.
    // Since they are >= 0, just encode as x*(M^2) + y*M + z with large enough M.
    const M = 131072; // same radix
    return x * M * M + y * M + z;
}

function unpackLevelCoord(key: number): [number, number, number] {
    const M = 131072;
    const z = key % M;
    const y = Math.floor(key / M) % M;
    const x = Math.floor(key / (M * M));
    return [x, y, z];
}

/**
 * Build the per-voxel displacement vector for a size-0 displaced cell (design §3.8):
 * a single nonzero int8 component on the displacement axis = round(dispOffset * 127),
 * the others 0. Returns null when the cell is not displaced.
 */
function buildDisp(
    axis: DisplacementAxis | null,
    dispOffset: number,
): { dx: number; dy: number; dz: number } | null {
    if (axis === null) return null;
    const v = Math.round(dispOffset * 127);
    return { dx: axis === 'x' ? v : 0, dy: axis === 'y' ? v : 0, dz: axis === 'z' ? v : 0 };
}

/** Compact a min-cell grid into variable-size voxels (coords in min-cell units). */
export function compact(grid: Map<number, CellAttr>, ctx: CompactCtx): SceneVoxel[] {
    const { maxSizeLevel, coplanarCos, colorTol } = ctx;

    // --- Level 0: build aggregate map from input cells ---
    // Sort keys for determinism.
    const sortedKeys = Array.from(grid.keys()).sort((a, b) => a - b);

    // current maps packed level-L coord -> Aggregate
    let current = new Map<number, Aggregate>();

    for (const cellKey of sortedKeys) {
        const cell = grid.get(cellKey)!;
        const [x, y, z] = unpackCell(cellKey);
        // At level 0, level coords equal cell coords (which may be negative).
        // We shift to non-negative by using packCell-based keys to preserve
        // round-trip accuracy. However, for the octree grouping we need arithmetic
        // on coords (floor(x/2)). We store the raw coords in Aggregate and re-pack
        // at each level using packLevelCoord after shifting.
        // Since cell coords can be negative (packCell supports ±65536), we need to
        // handle negatives in the parent grouping. We'll use a coord-carrying map
        // keyed by the original packCell key at level 0, then re-key at each level.
        // For simplicity: store current as Map<number, Aggregate> where the key is
        // produced by a coord-packing appropriate to that level.
        //
        // At level 0 we use packCell (handles negatives). At higher levels coords
        // halve each time, so after log2(CELL_KEY_HALF)=16 levels negatives reach 0.
        // maxSizeLevel is typically small (4), so we just use packCell throughout.
        const levelKey = packCell(x, y, z);
        current.set(levelKey, {
            r: cell.color.r, g: cell.color.g, b: cell.color.b,
            nx: cell.nx, ny: cell.ny, nz: cell.nz,
            interior: cell.interior,
            anyDisplaced: cell.displacementAxis !== null,
            noCollider: cell.noCollider,
            count: 1,
            displacementAxis: cell.displacementAxis,
            dispOffset: cell.dispOffset,
        });
    }

    const output: SceneVoxel[] = [];

    for (let L = 0; L < maxSizeLevel; L++) {
        // Group current entries by parent coord (floor(x/2), floor(y/2), floor(z/2)).
        // Key: packed parent coord -> list of [childKey, Aggregate]
        const parentMap = new Map<number, [number, Aggregate][]>();

        // Sort keys for determinism within each parent group.
        const currentKeys = Array.from(current.keys()).sort((a, b) => a - b);

        for (const key of currentKeys) {
            const agg = current.get(key)!;
            // Recover level-L coords. At all levels we use packCell which handles negatives.
            const [cx, cy, cz] = unpackCell(key);
            const px = Math.floor(cx / 2);
            const py = Math.floor(cy / 2);
            const pz = Math.floor(cz / 2);
            const parentKey = packCell(px, py, pz);
            let children = parentMap.get(parentKey);
            if (!children) {
                children = [];
                parentMap.set(parentKey, children);
            }
            children.push([key, agg]);
        }

        const consumed = new Set<number>();
        const nextLevel = new Map<number, Aggregate>();

        // Sort parent keys for determinism.
        const parentKeys = Array.from(parentMap.keys()).sort((a, b) => a - b);

        for (const parentKey of parentKeys) {
            const children = parentMap.get(parentKey)!;

            // Must have exactly 8 children to consider merging.
            if (children.length !== 8) continue;

            const [, first] = children[0]!;

            // All must share the same interior class.
            const allSameClass = children.every(([, a]) => a.interior === first.interior);
            if (!allSameClass) continue;

            // None may be displaced.
            const anyDisplaced = children.some(([, a]) => a.anyDisplaced);
            if (anyDisplaced) continue;

            // For surface blocks, check coplanarity and color spread.
            if (!first.interior) {
                // Compute mean normal.
                let mnx = 0, mny = 0, mnz = 0;
                for (const [, a] of children) { mnx += a.nx; mny += a.ny; mnz += a.nz; }
                const mlen = Math.sqrt(mnx * mnx + mny * mny + mnz * mnz);
                if (mlen < 1e-9) continue; // degenerate
                mnx /= mlen; mny /= mlen; mnz /= mlen;

                // Check every child dot >= coplanarCos with mean normal.
                let coplanar = true;
                for (const [, a] of children) {
                    const nlen = Math.sqrt(a.nx * a.nx + a.ny * a.ny + a.nz * a.nz);
                    if (nlen < 1e-9) { coplanar = false; break; }
                    const dot = (a.nx * mnx + a.ny * mny + a.nz * mnz) / nlen;
                    if (dot < coplanarCos) { coplanar = false; break; }
                }
                if (!coplanar) continue;

                // Check per-channel color spread.
                let minR = Infinity, maxR = -Infinity;
                let minG = Infinity, maxG = -Infinity;
                let minB = Infinity, maxB = -Infinity;
                for (const [, a] of children) {
                    if (a.r < minR) minR = a.r; if (a.r > maxR) maxR = a.r;
                    if (a.g < minG) minG = a.g; if (a.g > maxG) maxG = a.g;
                    if (a.b < minB) minB = a.b; if (a.b > maxB) maxB = a.b;
                }
                if (maxR - minR > colorTol || maxG - minG > colorTol || maxB - minB > colorTol) continue;

                // Build merged surface aggregate.
                const inv8 = 1 / 8;
                let mr = 0, mg = 0, mb = 0, nx2 = 0, ny2 = 0, nz2 = 0;
                let allNoCollider = true;
                for (const [, a] of children) {
                    mr += a.r; mg += a.g; mb += a.b;
                    nx2 += a.nx; ny2 += a.ny; nz2 += a.nz;
                    if (!a.noCollider) allNoCollider = false;
                }
                const nlen2 = Math.sqrt(nx2 * nx2 + ny2 * ny2 + nz2 * nz2);
                if (nlen2 > 1e-9) { nx2 /= nlen2; ny2 /= nlen2; nz2 /= nlen2; }

                for (const [childKey] of children) consumed.add(childKey);
                nextLevel.set(parentKey, {
                    r: mr * inv8, g: mg * inv8, b: mb * inv8,
                    nx: nx2, ny: ny2, nz: nz2,
                    interior: false,
                    anyDisplaced: false,
                    noCollider: allNoCollider,
                    count: 8,
                    displacementAxis: null,
                    dispOffset: 0,
                });
            } else {
                // Interior merge: just average color, normal is zero.
                const inv8 = 1 / 8;
                let mr = 0, mg = 0, mb = 0;
                let allNoCollider = true;
                for (const [, a] of children) {
                    mr += a.r; mg += a.g; mb += a.b;
                    if (!a.noCollider) allNoCollider = false;
                }
                for (const [childKey] of children) consumed.add(childKey);
                nextLevel.set(parentKey, {
                    r: mr * inv8, g: mg * inv8, b: mb * inv8,
                    nx: 0, ny: 0, nz: 0,
                    interior: true,
                    anyDisplaced: false,
                    noCollider: allNoCollider,
                    count: 8,
                    displacementAxis: null,
                    dispOffset: 0,
                });
            }
        }

        // Emit all unconsumed current entries as voxels at sizeLevel = L.
        for (const key of currentKeys) {
            if (consumed.has(key)) continue;
            const agg = current.get(key)!;
            const [lx, ly, lz] = unpackCell(key);
            // Grid coords in min-cell units = levelCoord * 2^L
            const scale = 1 << L;
            output.push({
                gx: lx * scale,
                gy: ly * scale,
                gz: lz * scale,
                sizeLevel: L,
                color: { r: agg.r, g: agg.g, b: agg.b },
                noCollider: agg.noCollider,
                // Displaced cells never merge, so only a size-0 (L === 0) voxel can be
                // displaced; coarser unconsumed levels are always grid-aligned.
                disp: L === 0 ? buildDisp(agg.displacementAxis, agg.dispOffset) : null,
            });
        }

        current = nextLevel;
        if (current.size === 0) break;
    }

    // Emit remaining entries at maxSizeLevel.
    if (current.size > 0) {
        const remainingKeys = Array.from(current.keys()).sort((a, b) => a - b);
        for (const key of remainingKeys) {
            const agg = current.get(key)!;
            const [lx, ly, lz] = unpackCell(key);
            const scale = 1 << maxSizeLevel;
            output.push({
                gx: lx * scale,
                gy: ly * scale,
                gz: lz * scale,
                sizeLevel: maxSizeLevel,
                color: { r: agg.r, g: agg.g, b: agg.b },
                noCollider: agg.noCollider,
                disp: null,
            });
        }
    }

    return output;
}
