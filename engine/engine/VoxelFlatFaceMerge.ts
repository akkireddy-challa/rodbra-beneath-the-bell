/**
 * Greedy 2D merge of coplanar flat voxel faces.
 *
 * The rounded-edge mesh path emits one face polygon per octree leaf, even
 * across perfectly flat walls. Mixed-size coplanar leaves then meet at
 * T-junctions (a large face's edge passing through a smaller face's vertex),
 * which rasterize with intermittent hairline cracks. This module merges the
 * flat interior faces of one axis-plane slice — squares on a uniform min-cell
 * lattice — into maximal same-color rectangles, so flat regions render as a
 * handful of lattice-aligned quads instead of hundreds of per-leaf polygons.
 */

/** One leaf face projected onto its slice plane, in min-cell coordinates. */
export interface FlatFaceSquare {
    /** Min corner along the slice's two in-plane axes (cell coords). */
    u0: number;
    v0: number;
    /** Edge length in cells (the leaf's lattice size L). */
    size: number;
    /** Opaque merge key — squares merge only when equal (e.g. packed rgb24). Non-negative. */
    color: number;
}

/** A merged rectangle in the same cell coordinates. Max corner is exclusive. */
export interface FlatFaceRect {
    u0: number;
    v0: number;
    u1: number;
    v1: number;
    color: number;
}

/**
 * Merge non-overlapping same-color squares into maximal rectangles.
 * Output rectangles are disjoint and cover exactly the input cells.
 */
export function mergeFlatFaceSquares(squares: readonly FlatFaceSquare[]): FlatFaceRect[] {
    if (squares.length === 0) return [];

    let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
    for (const s of squares) {
        if (s.u0 < minU) minU = s.u0;
        if (s.v0 < minV) minV = s.v0;
        if (s.u0 + s.size > maxU) maxU = s.u0 + s.size;
        if (s.v0 + s.size > maxV) maxV = s.v0 + s.size;
    }
    const nu = maxU - minU;
    const nv = maxV - minV;

    // Dense color grid over the populated bbox; -1 = empty.
    const grid = new Int32Array(nu * nv).fill(-1);
    for (const s of squares) {
        for (let v = s.v0 - minV; v < s.v0 - minV + s.size; v++) {
            const row = v * nu;
            for (let u = s.u0 - minU; u < s.u0 - minU + s.size; u++) grid[row + u] = s.color;
        }
    }

    // Row-major greedy: grow each unvisited cell right along u, then down along v.
    const rects: FlatFaceRect[] = [];
    for (let v = 0; v < nv; v++) {
        for (let u = 0; u < nu; u++) {
            const color = grid[v * nu + u]!;
            if (color < 0) continue;
            let u1 = u + 1;
            while (u1 < nu && grid[v * nu + u1] === color) u1++;
            let v1 = v + 1;
            grow: while (v1 < nv) {
                const row = v1 * nu;
                for (let x = u; x < u1; x++) if (grid[row + x] !== color) break grow;
                v1++;
            }
            for (let y = v; y < v1; y++) {
                const row = y * nu;
                for (let x = u; x < u1; x++) grid[row + x] = -1;
            }
            rects.push({ u0: u + minU, v0: v + minV, u1: u1 + minU, v1: v1 + minV, color });
        }
    }
    return rects;
}
