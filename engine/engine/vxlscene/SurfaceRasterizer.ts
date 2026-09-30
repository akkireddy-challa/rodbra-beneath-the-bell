/**
 * Per-chunk surface rasterizer (design §3.5).
 *
 * Turns a set of triangles into a finest-wins min-cell attribute grid for one chunk.
 * Objects are sorted finest-first (smallest effective voxel size wins); the first
 * writer owns a cell and coarser objects never overwrite it.
 */

import type { RGB, ObjectControls, CellAttr } from 'engine/vxlscene/SceneVoxTypes.js';
import { DEFAULT_OBJECT_CONTROLS } from 'engine/vxlscene/SceneVoxTypes.js';
import { triBoxOverlap } from 'engine/vxlscene/triBoxOverlap.js';

export type { RGB, ObjectControls, CellAttr };

export interface RasterTriangle {
    v0: [number, number, number];
    v1: [number, number, number];
    v2: [number, number, number];
    /** Unit geometric normal. */
    normal: [number, number, number];
    /** Top-level GLB object name (key into controlsByNode). */
    nodeName: string;
    /** Color at a surface point (linear RGB). */
    sampleColor: (point: [number, number, number]) => RGB;
}

export interface RasterCtx {
    /** Chunk min-cell origin in GLOBAL min-cell coords (grid keys are global). */
    originCellX: number;
    originCellY: number;
    originCellZ: number;
    /** Number of min-cells per chunk axis = chunkSize / minVoxelSize (integer). */
    cellsPerAxis: number;
    minVoxelSize: number;
    /** Per-object controls; objects absent here use DEFAULT_OBJECT_CONTROLS. */
    controlsByNode: Record<string, ObjectControls>;
}

/**
 * Cell-key packing. Coords must lie in [-CELL_KEY_HALF, CELL_KEY_HALF) on every axis.
 * Key = (x+H)·M² + (y+H)·M + (z+H) with radix M and offset H = M/2, so each offset
 * digit (coord+H) stays in [0, M) — a clean, uniquely-decodable mixed-radix. Max key
 * < M³ = 2^51, safely under Number.MAX_SAFE_INTEGER (2^53−1).
 */
export const CELL_KEY_BASE = 131072; // 2^17 radix
export const CELL_KEY_HALF = 65536;  // 2^16 sign offset; per-axis range ±65536 cells

/** Pack a global min-cell coord into a single safe-integer key. See CELL_KEY_BASE / CELL_KEY_HALF. */
export function packCell(x: number, y: number, z: number): number {
    const M = CELL_KEY_BASE, H = CELL_KEY_HALF;
    return (x + H) * M * M + (y + H) * M + (z + H);
}

/** Recover [x, y, z] cell coords from a key produced by packCell. */
export function unpackCell(key: number): [number, number, number] {
    const M = CELL_KEY_BASE, H = CELL_KEY_HALF;
    const z = (key % M) - H;
    const y = (Math.floor(key / M) % M) - H;
    const x = Math.floor(key / (M * M)) - H;
    return [x, y, z];
}

/** Project point P onto the plane of triangle (v0,v1,v2) and clamp to the triangle. */
function closestPointOnTriangle(
    p: [number, number, number],
    v0: [number, number, number],
    v1: [number, number, number],
    v2: [number, number, number],
): [number, number, number] {
    // Edge vectors
    const ab: [number, number, number] = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
    const ac: [number, number, number] = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];
    const ap: [number, number, number] = [p[0] - v0[0], p[1] - v0[1], p[2] - v0[2]];

    const d1 = ab[0] * ap[0] + ab[1] * ap[1] + ab[2] * ap[2];
    const d2 = ac[0] * ap[0] + ac[1] * ap[1] + ac[2] * ap[2];

    // P is in Voronoi region of v0
    if (d1 <= 0 && d2 <= 0) return [v0[0], v0[1], v0[2]];

    const bp: [number, number, number] = [p[0] - v1[0], p[1] - v1[1], p[2] - v1[2]];
    const d3 = ab[0] * bp[0] + ab[1] * bp[1] + ab[2] * bp[2];
    const d4 = ac[0] * bp[0] + ac[1] * bp[1] + ac[2] * bp[2];

    // P is in Voronoi region of v1
    if (d3 >= 0 && d4 <= d3) return [v1[0], v1[1], v1[2]];

    // P is in Voronoi region of edge AB
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        return [v0[0] + ab[0] * v, v0[1] + ab[1] * v, v0[2] + ab[2] * v];
    }

    const cp: [number, number, number] = [p[0] - v2[0], p[1] - v2[1], p[2] - v2[2]];
    const d5 = ab[0] * cp[0] + ab[1] * cp[1] + ab[2] * cp[2];
    const d6 = ac[0] * cp[0] + ac[1] * cp[1] + ac[2] * cp[2];

    // P is in Voronoi region of v2
    if (d6 >= 0 && d5 <= d6) return [v2[0], v2[1], v2[2]];

    // P is in Voronoi region of edge AC
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
        const w = d2 / (d2 - d6);
        return [v0[0] + ac[0] * w, v0[1] + ac[1] * w, v0[2] + ac[2] * w];
    }

    // P is in Voronoi region of edge BC
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
        const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        return [v1[0] + (v2[0] - v1[0]) * w, v1[1] + (v2[1] - v1[1]) * w, v1[2] + (v2[2] - v1[2]) * w];
    }

    // P is inside the triangle
    const denom = 1 / (va + vb + vc);
    const v = vb * denom;
    const w = vc * denom;
    return [
        v0[0] + ab[0] * v + ac[0] * w,
        v0[1] + ab[1] * v + ac[1] * w,
        v0[2] + ab[2] * v + ac[2] * w,
    ];
}

/** Rasterize triangles into a finest-wins attribute grid for one chunk. */
export function rasterizeChunk(tris: RasterTriangle[], ctx: RasterCtx): Map<number, CellAttr> {
    const { originCellX, originCellY, originCellZ, cellsPerAxis, minVoxelSize, controlsByNode } = ctx;
    const half = minVoxelSize / 2;
    const halfTriple: [number, number, number] = [half, half, half];

    // --- Step 1: group by nodeName, resolve controls, compute effective size ---
    const nodeGroups = new Map<string, RasterTriangle[]>();
    for (const t of tris) {
        let group = nodeGroups.get(t.nodeName);
        if (!group) {
            group = [];
            nodeGroups.set(t.nodeName, group);
        }
        group.push(t);
    }

    interface NodeGroup {
        nodeName: string;
        triangles: RasterTriangle[];
        controls: ObjectControls;
        effectiveSize: number;
    }

    const groups: NodeGroup[] = [];
    for (const [nodeName, triangles] of nodeGroups) {
        const controls = controlsByNode[nodeName] ?? DEFAULT_OBJECT_CONTROLS;
        const effectiveSize = minVoxelSize * Math.pow(2, controls.lodOffset);
        groups.push({ nodeName, triangles, controls, effectiveSize });
    }

    // Sort finest first (ascending effective size), tie-break by nodeName. (In the production
    // bake, bakeScene calls rasterizeChunk once per lodOffset bucket, so groups here usually share
    // one effectiveSize and this reduces to nodeName order — the displaced/blocky two-pass split
    // below, not the size term, is what resolves a road↔edge-wall seam. The size term still applies
    // to direct unit-test calls that mix offsets in one chunk.)
    groups.sort((a, b) => {
        if (a.effectiveSize !== b.effectiveSize) return a.effectiveSize - b.effectiveSize;
        return a.nodeName < b.nodeName ? -1 : a.nodeName > b.nodeName ? 1 : 0;
    });

    // --- Step 2: rasterize into grid, displaced (smooth:y) objects first ---
    //
    // Finest-wins ownership, with a smooth-surface guard. A displaced object renders TOP-ONLY:
    // SurfaceMeshBuilder welds only the TOPMOST displaced cell of each (x,z) column into the
    // drivable surface and never draws that object's sides/underside. So:
    //   • the topmost displaced cell of a column (the drivable surface) is PROTECTED — a blocky
    //     object must never take it, or the smooth surface gets a blocky/see-through hole (a
    //     non-carved road laid ~0.05 m over terrain shares a cell with it in most columns);
    //   • every OTHER cell a displaced object owns (its culled sides/underside) SHOULD yield to a
    //     fully-rendered blocky neighbour (a carved road's edge wall) so the side the road does not
    //     draw gets drawn — otherwise the seam shows through to the terrain.
    // Two passes: rasterize all displaced groups first (recording each column's topmost displaced
    // cell), then blocky groups, which take an existing displaced cell unless it is that column's
    // drivable top. Vertically separated geometry (a bridge under a road) is in different cells and
    // is untouched.
    const grid = new Map<number, CellAttr>();

    // Chunk covers global min-cells [originCellX, originCellX + cellsPerAxis) on each axis
    const maxCellX = originCellX + cellsPerAxis - 1;
    const maxCellY = originCellY + cellsPerAxis - 1;
    const maxCellZ = originCellZ + cellsPerAxis - 1;

    // Per-axis inclusive chunk cell ranges, indexed by axis (0=x,1=y,2=z) so the
    // dominant-axis-plane traversal can clamp generically without per-axis branches.
    const minCell: [number, number, number] = [originCellX, originCellY, originCellZ];
    const maxCell: [number, number, number] = [maxCellX, maxCellY, maxCellZ];

    // columnTopDisplaced[colKey(x,z)] = highest gy a displaced object owns in that column (the
    // drivable-surface cell blocky objects must not overwrite). colKey packs the (x,z) pair.
    const colKey = (cx: number, cz: number): number =>
        (cx + CELL_KEY_HALF) * CELL_KEY_BASE + (cz + CELL_KEY_HALF);
    const columnTopDisplaced = new Map<number, number>();

    // Rasterize one group's triangles. `claim(key,cx,cy,cz)` decides — before the expensive
    // overlap test — whether this group may take the cell (the caller has consulted the grid).
    const rasterizeGroup = (
        group: NodeGroup,
        claim: (key: number, cx: number, cy: number, cz: number) => boolean,
    ): void => {
        const { triangles, controls } = group;
        const groupDisplaced = controls.displacementAxis !== null;

        for (const t of triangles) {
            const { v0, v1, v2, normal } = t;

            // --- Dominant-axis-plane candidate selection (design: footprint, not box) ---
            // Pick d = the axis the triangle most faces (argmax |normal|). Over the
            // other two axes (u,v) the triangle is a function d = f(u,v) whose slope is
            // ≤ 1 in each of u,v (because |n_d| is the largest normal component), so a
            // one-cell step in u or v moves the surface by at most one cell in d. We
            // therefore visit only the triangle's (u,v) footprint × a thin d-band per
            // (u,v) cell, instead of the full 3D AABB. triBoxOverlap remains the
            // AUTHORITATIVE coverage test and rejects the band's non-overlapping cells.
            const an = Math.abs(normal[0]);
            const bn = Math.abs(normal[1]);
            const cn = Math.abs(normal[2]);
            let d: 0 | 1 | 2;
            if (an >= bn && an >= cn) d = 0;
            else if (bn >= cn) d = 1;
            else d = 2;
            const nd = normal[d];
            // Degenerate / near-perpendicular: if even the largest normal component is
            // ~0 the triangle has no usable orientation (zero-area) → nothing to mark.
            if (Math.abs(nd) < 1e-12) continue;

            const u = d === 0 ? 1 : 0;
            const v = d === 2 ? 1 : 2;

            // Triangle (u,v) extent → clamped cell rect on the plane axes.
            const triMinU = Math.min(v0[u], v1[u], v2[u]);
            const triMaxU = Math.max(v0[u], v1[u], v2[u]);
            const triMinV = Math.min(v0[v], v1[v], v2[v]);
            const triMaxV = Math.max(v0[v], v1[v], v2[v]);
            const startU = Math.max(minCell[u], Math.floor(triMinU / minVoxelSize));
            const endU = Math.min(maxCell[u], Math.ceil(triMaxU / minVoxelSize) - 1);
            const startV = Math.max(minCell[v], Math.floor(triMinV / minVoxelSize));
            const endV = Math.min(maxCell[v], Math.ceil(triMaxV / minVoxelSize) - 1);
            if (startU > endU || startV > endV) continue;

            // Plane: n·(x - v0) = 0  ⇒  d = v0_d - (n_u·(pu - v0_u) + n_v·(pv - v0_v)) / n_d.
            // Clamp the per-cell d-band not just to the chunk, but to the triangle's own
            // d-axis AABB cell range (same formula the full-AABB scan uses). The plane
            // eval + expand-by-1 band is CONSERVATIVE: at a vertex sitting exactly on a
            // cell boundary the box one cell beyond the AABB still corner-touches the
            // triangle, so triBoxOverlap would accept a cell OUTSIDE the AABB. Bounding
            // d to the triangle's AABB keeps the visited set an exact subset of the
            // full-AABB scan (no extra cells), while the band guarantees no holes.
            const triMinD = Math.min(v0[d], v1[d], v2[d]);
            const triMaxD = Math.max(v0[d], v1[d], v2[d]);
            const dMinCell = Math.max(minCell[d], Math.floor(triMinD / minVoxelSize));
            // A surface coplanar with a grid plane has triMinD === triMaxD on an exact
            // cell boundary, where `ceil(max) - 1` underflows below `floor(min)` and the
            // range goes empty — silently dropping the whole surface (e.g. a perfectly
            // flat terrain whose constant height lands on a voxel plane). Floor the raw
            // d-max to the cell the surface lies on so a zero-thickness AABB still claims
            // one cell; the chunk clamp is applied afterwards.
            const dMaxCell = Math.min(maxCell[d], Math.max(Math.floor(triMinD / minVoxelSize), Math.ceil(triMaxD / minVoxelSize) - 1));
            if (dMinCell > dMaxCell) continue;
            const center: [number, number, number] = [0, 0, 0];
            // Scratch tuple reused to scatter (u,v,d) cell indices back to (x,y,z).
            const cellTriple: [number, number, number] = [0, 0, 0];

            for (let cu = startU; cu <= endU; cu++) {
                const uLo = cu * minVoxelSize;
                const uHi = (cu + 1) * minVoxelSize;
                center[u] = (cu + 0.5) * minVoxelSize;
                for (let cv = startV; cv <= endV; cv++) {
                    const vLo = cv * minVoxelSize;
                    const vHi = (cv + 1) * minVoxelSize;

                    // Evaluate the plane's d-coordinate at the cell's 4 (u,v) corners and
                    // take the min/max. The plane is linear, so its extremes over the cell
                    // lie at the corners; the d-cells spanning [dLo,dHi], expanded by one
                    // cell each side (box reach + float safety), are the conservative band.
                    const d00 = v0[d] - (normal[u] * (uLo - v0[u]) + normal[v] * (vLo - v0[v])) / nd;
                    const d10 = v0[d] - (normal[u] * (uHi - v0[u]) + normal[v] * (vLo - v0[v])) / nd;
                    const d01 = v0[d] - (normal[u] * (uLo - v0[u]) + normal[v] * (vHi - v0[v])) / nd;
                    const d11 = v0[d] - (normal[u] * (uHi - v0[u]) + normal[v] * (vHi - v0[v])) / nd;
                    const dLo = Math.min(d00, d10, d01, d11);
                    const dHi = Math.max(d00, d10, d01, d11);

                    const startD = Math.max(dMinCell, Math.floor(dLo / minVoxelSize) - 1);
                    const endD = Math.min(dMaxCell, Math.floor(dHi / minVoxelSize) + 1);
                    if (startD > endD) continue;

                    center[v] = (cv + 0.5) * minVoxelSize;

                    for (let cd = startD; cd <= endD; cd++) {
                        // Reconstruct (cx,cy,cz) by scattering the (u,v,d) cell triple
                        // back to its axis slots (u,v,d are a permutation of 0,1,2).
                        cellTriple[u] = cu;
                        cellTriple[v] = cv;
                        cellTriple[d] = cd;
                        const cx = cellTriple[0];
                        const cy = cellTriple[1];
                        const cz = cellTriple[2];

                        const key = packCell(cx, cy, cz);

                        // Ownership decision (the two-pass drivable-top guard above).
                        if (!claim(key, cx, cy, cz)) continue;

                        center[d] = (cd + 0.5) * minVoxelSize;

                        if (!triBoxOverlap(center, halfTriple, v0, v1, v2)) continue;

                        // Project cell center onto triangle surface for color sampling
                        const surfacePoint = closestPointOnTriangle(center, v0, v1, v2);
                        const color = t.sampleColor(surfacePoint);

                        // Sub-cell displacement along the single axis (design §3.8): the
                        // signed fraction of a min-cell by which the true surface sits off
                        // this cell's center, clamped to ±1 so neighbours can't open gaps.
                        //
                        // EVERY cell of a smooth:y object is displaced (the whole road solid —
                        // top + underside + walls). This is deliberate: displaced cells are
                        // EXCLUDED from greedy meshing, so the ENTIRE road stays out of the
                        // blocky greedy mesh. The renderer (`SurfaceMeshBuilder`) then collapses
                        // each (x,z) column to its TOPMOST displaced cell and welds those into
                        // the smooth drivable surface; the underside/walls simply aren't drawn.
                        // Do NOT gate this to up-facing cells only — that leaves the rest of the
                        // road as grid-aligned voxels which the greedy mesher renders as hard
                        // cubes poking through the smooth surface (the regression that taught us
                        // this the hard way).
                        let dispOffset = 0;
                        const axis = controls.displacementAxis;
                        if (axis !== null) {
                            const axisIdx = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
                            const raw = (surfacePoint[axisIdx] - center[axisIdx]) / minVoxelSize;
                            dispOffset = raw < -1 ? -1 : raw > 1 ? 1 : raw;
                        }

                        grid.set(key, {
                            color,
                            nx: normal[0],
                            ny: normal[1],
                            nz: normal[2],
                            interior: false,
                            // trimesh objects collide via their trimesh; no-collider
                            // objects are decoration — both exclude the voxel/quad collider.
                            noCollider: controls.trimeshCollider || controls.noCollider,
                            pinned: controls.pinned,
                            displacementAxis: controls.displacementAxis,
                            dispOffset,
                        });

                        // A displaced group's write sets the column's drivable-top height so the
                        // blocky pass can protect it from being overwritten.
                        if (groupDisplaced) {
                            const ck = colKey(cx, cz);
                            const cur = columnTopDisplaced.get(ck);
                            if (cur === undefined || cy > cur) columnTopDisplaced.set(ck, cy);
                        }
                    }
                }
            }
        }
    };

    // Pass 1: displaced groups — first-writer-wins among themselves; record each column's top.
    for (const group of groups) {
        if (group.controls.displacementAxis === null) continue;
        rasterizeGroup(group, (key) => !grid.has(key));
    }
    // Pass 2: blocky groups — take an existing displaced cell only if it is NOT the column's
    // drivable top; never displace another blocky owner (first-writer-wins among blocky).
    for (const group of groups) {
        if (group.controls.displacementAxis !== null) continue;
        rasterizeGroup(group, (key, cx, cy, cz) => {
            const existing = grid.get(key);
            if (existing === undefined) return true;
            if (existing.displacementAxis !== null) {
                return columnTopDisplaced.get(colKey(cx, cz)) !== cy;
            }
            return false;
        });
    }

    return grid;
}
