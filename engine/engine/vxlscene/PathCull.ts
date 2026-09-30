/**
 * PathCull — a horizontal keep-region built around a level's designed path
 * (the racing circuit / course polyline the World Forger emits as a `path`
 * gameplay feature).
 *
 * A baked level is usually a square plate: the track occupies a ribbon through
 * it and everything else is scenery that costs chunks, voxels and download
 * bytes without ever being reached. This mask lets a re-bake keep only what is
 * within `distanceM` of that polyline and drop the rest. It is a BAKE-TIME
 * filter — the source GLB is untouched, so widening the distance (or turning
 * the cull off) is just another re-voxelize.
 *
 * Two shapes of keep-region:
 *   'both'    — a corridor: the union of stadium (capsule) regions around each
 *               polyline segment. Everything farther than `distanceM` from the
 *               centerline goes, on both sides.
 *   'outside' — the corridor UNION everything the closed circuit encloses. The
 *               infield survives whatever its distance; only the outside of the
 *               loop is trimmed. Requires a closed path; an open one silently
 *               falls back to 'both' (there is no inside to keep).
 *
 * The test is purely HORIZONTAL (XZ). A bridge over the track, or a tunnel
 * under it, is kept or dropped by its ground-plan position alone — matching
 * how a player experiences "near the track".
 *
 * Two accelerators keep the per-voxel test O(1)-ish:
 *   • a uniform bucket grid of segments, each stamped into every bucket its
 *     AABB-expanded-by-`distanceM` covers, so a distance query only ever scans
 *     the segments that could possibly be in range;
 *   • for 'outside', a coarse scanline-filled inside/outside grid (even-odd
 *     crossing counts per row), so point-in-polygon is a single array read.
 *     Its cell is a fraction of `distanceM`, which is exact where it matters:
 *     every cell close enough to the polygon boundary for the coarse grid to
 *     be wrong is already within `distanceM` of the centerline, i.e. kept by
 *     the corridor rule regardless.
 */

/** One control point of the path. `y` is accepted and ignored — the cull is horizontal. */
export interface PathCullPoint {
    x: number;
    y?: number;
    z: number;
}

/**
 * 'both'    — cull everything farther than `distanceM` from the centerline.
 * 'outside' — cull only OUTSIDE the loop; whatever the circuit encloses stays.
 */
export type PathCullMode = 'both' | 'outside';

/** The caller-facing cull request (mirrored on the wire and in the asset record). */
export interface PathCullSpec {
    /** Ordered control points of the path, in the BAKED WORLD space of this bake. */
    points: PathCullPoint[];
    /** True when the last point joins back to the first (a circuit). */
    closed: boolean;
    /** Keep radius in meters, measured horizontally from the centerline. */
    distanceM: number;
    /** Which side(s) to trim. 'outside' needs `closed`. */
    mode: PathCullMode;
}

/** Whole-box verdict: every point kept, every point culled, or a mix. */
export type PathCullBoxClass = 'all' | 'none' | 'partial';

export interface PathCullMask {
    /** Keep the cell/voxel whose world XZ CENTRE is (x, z)? */
    keeps(x: number, z: number): boolean;
    /**
     * Verdict for a whole axis-aligned XZ box (a chunk column). 'none' lets the
     * bake skip the chunk without rasterizing it; 'all' lets it skip the
     * per-cell test. Conservative in the safe direction: it may answer
     * 'partial' where a perfect test would answer 'all' or 'none', never the
     * other way round.
     */
    classifyBox(minX: number, minZ: number, maxX: number, maxZ: number): PathCullBoxClass;
    /** Mode actually in force — 'both' when 'outside' was asked for on an open path. */
    readonly mode: PathCullMode;
    /** Number of polyline segments (diagnostics / logging). */
    readonly segmentCount: number;
}

/** World extent the mask is defined over (the bake's chunk-aligned bounds). */
export interface PathCullBounds {
    minX: number;
    minZ: number;
    maxX: number;
    maxZ: number;
}

/** Inside-grid cell size is a fraction of the keep distance, clamped to this band (m). */
const MIN_INSIDE_CELL_M = 0.5;
const MAX_INSIDE_CELL_M = 4;
/** Fraction of `distanceM` used as the inside-grid cell before clamping. */
const INSIDE_CELL_FRACTION = 0.25;
/** Coarsen the inside grid rather than allocate more cells than this. */
const MAX_INSIDE_CELLS = 4_000_000;
/** Segment-bucket cell size floor (m) — small buckets cost more memory than they save. */
const MIN_BUCKET_CELL_M = 8;

/** Squared distance from (px, pz) to segment (x0,z0)–(x1,z1), in the XZ plane. */
function distSqToSegment(px: number, pz: number, x0: number, z0: number, x1: number, z1: number): number {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const lenSq = dx * dx + dz * dz;
    let t = lenSq > 0 ? ((px - x0) * dx + (pz - z0) * dz) / lenSq : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const cx = x0 + t * dx;
    const cz = z0 + t * dz;
    return (px - cx) * (px - cx) + (pz - cz) * (pz - cz);
}

/**
 * Build the keep-region mask. Throws only on input that cannot describe a
 * region at all (fewer than two points, a non-positive distance) — the callers
 * validate in their UI, and a bad spec must not silently bake an empty world.
 */
export function buildPathCullMask(spec: PathCullSpec, bounds: PathCullBounds): PathCullMask {
    if (spec.points.length < 2) {
        throw new Error(`buildPathCullMask: need at least 2 path points (got ${spec.points.length})`);
    }
    if (!(spec.distanceM > 0) || !isFinite(spec.distanceM)) {
        throw new Error(`buildPathCullMask: distanceM must be a positive number (got ${spec.distanceM})`);
    }

    const d = spec.distanceM;
    const dSq = d * d;

    // ── Segments (flat x0,z0,x1,z1 quads) ──────────────────────────────────
    const pts = spec.points;
    const closed = spec.closed && pts.length >= 3;
    const segCount = closed ? pts.length : pts.length - 1;
    const seg = new Float64Array(segCount * 4);
    for (let i = 0; i < segCount; i++) {
        const a = pts[i]!;
        const b = pts[(i + 1) % pts.length]!;
        seg[i * 4] = a.x;
        seg[i * 4 + 1] = a.z;
        seg[i * 4 + 2] = b.x;
        seg[i * 4 + 3] = b.z;
    }

    // 'outside' with no loop to be outside OF is meaningless — keep the bake
    // running with the corridor rule rather than failing it (a cull that trims
    // both sides is the strictly safe reading of "trim the outside").
    const mode: PathCullMode = spec.mode === 'outside' && closed ? 'outside' : 'both';
    if (spec.mode === 'outside' && !closed) {
        console.warn('[PathCull] mode "outside" needs a closed path — falling back to "both"');
    }

    // ── Segment bucket grid (distance queries) ─────────────────────────────
    // Grid covers the world bounds expanded by d, so any point inside the world
    // that is within d of a segment lands in a bucket that segment was stamped
    // into. Queries outside the grid clamp to the edge buckets, which only ever
    // over-scans (the distance test is still exact).
    const bucketCell = Math.max(d, MIN_BUCKET_CELL_M);
    const gMinX = bounds.minX - d;
    const gMinZ = bounds.minZ - d;
    const bw = Math.max(1, Math.ceil((bounds.maxX + d - gMinX) / bucketCell));
    const bh = Math.max(1, Math.ceil((bounds.maxZ + d - gMinZ) / bucketCell));
    const buckets: (number[] | undefined)[] = new Array<number[] | undefined>(bw * bh);
    const bucketX = (x: number): number => Math.min(bw - 1, Math.max(0, Math.floor((x - gMinX) / bucketCell)));
    const bucketZ = (z: number): number => Math.min(bh - 1, Math.max(0, Math.floor((z - gMinZ) / bucketCell)));
    for (let i = 0; i < segCount; i++) {
        const x0 = seg[i * 4]!, z0 = seg[i * 4 + 1]!, x1 = seg[i * 4 + 2]!, z1 = seg[i * 4 + 3]!;
        const bx0 = bucketX(Math.min(x0, x1) - d), bx1 = bucketX(Math.max(x0, x1) + d);
        const bz0 = bucketZ(Math.min(z0, z1) - d), bz1 = bucketZ(Math.max(z0, z1) + d);
        for (let bx = bx0; bx <= bx1; bx++) {
            for (let bz = bz0; bz <= bz1; bz++) {
                const k = bz * bw + bx;
                const list = buckets[k];
                if (list) list.push(i); else buckets[k] = [i];
            }
        }
    }

    const withinCorridor = (x: number, z: number): boolean => {
        const list = buckets[bucketZ(z) * bw + bucketX(x)];
        if (!list) return false;
        for (const i of list) {
            if (distSqToSegment(x, z, seg[i * 4]!, seg[i * 4 + 1]!, seg[i * 4 + 2]!, seg[i * 4 + 3]!) <= dSq) {
                return true;
            }
        }
        return false;
    };

    // ── Inside grid (only for 'outside') ───────────────────────────────────
    // Even-odd scanline fill: for each row's centre Z, collect the X of every
    // segment crossing that line, sort, and mark the spans between successive
    // pairs as inside. Cost is rows × segments, not cells × segments.
    let insideGrid: Uint8Array | null = null;
    let insideCell = 0;
    let insideW = 0;
    let insideH = 0;
    if (mode === 'outside') {
        insideCell = Math.min(MAX_INSIDE_CELL_M, Math.max(MIN_INSIDE_CELL_M, d * INSIDE_CELL_FRACTION));
        const spanX = Math.max(insideCell, bounds.maxX - bounds.minX);
        const spanZ = Math.max(insideCell, bounds.maxZ - bounds.minZ);
        // Coarsen rather than allocate an unbounded grid on a very large world.
        while (Math.ceil(spanX / insideCell) * Math.ceil(spanZ / insideCell) > MAX_INSIDE_CELLS) {
            insideCell *= 2;
        }
        insideW = Math.ceil(spanX / insideCell);
        insideH = Math.ceil(spanZ / insideCell);
        insideGrid = new Uint8Array(insideW * insideH);

        const crossings: number[] = [];
        for (let row = 0; row < insideH; row++) {
            const z = bounds.minZ + (row + 0.5) * insideCell;
            crossings.length = 0;
            for (let i = 0; i < segCount; i++) {
                const x0 = seg[i * 4]!, z0 = seg[i * 4 + 1]!, x1 = seg[i * 4 + 2]!, z1 = seg[i * 4 + 3]!;
                // Half-open rule (z0 <= z < z1): counts each vertex once, so a
                // scanline through a control point doesn't double-count.
                if ((z0 <= z) === (z1 <= z)) continue;
                crossings.push(x0 + ((z - z0) / (z1 - z0)) * (x1 - x0));
            }
            if (crossings.length < 2) continue;
            crossings.sort((a, b) => a - b);
            const rowBase = row * insideW;
            for (let c = 0; c + 1 < crossings.length; c += 2) {
                const from = Math.max(0, Math.ceil((crossings[c]! - bounds.minX) / insideCell - 0.5));
                const to = Math.min(insideW - 1, Math.floor((crossings[c + 1]! - bounds.minX) / insideCell - 0.5));
                for (let col = from; col <= to; col++) insideGrid[rowBase + col] = 1;
            }
        }
    }

    const isInside = (x: number, z: number): boolean => {
        if (!insideGrid) return false;
        const col = Math.floor((x - bounds.minX) / insideCell);
        const row = Math.floor((z - bounds.minZ) / insideCell);
        if (col < 0 || row < 0 || col >= insideW || row >= insideH) return false;
        return insideGrid[row * insideW + col] === 1;
    };

    const keeps = (x: number, z: number): boolean => withinCorridor(x, z) || isInside(x, z);

    const classifyBox = (minX: number, minZ: number, maxX: number, maxZ: number): PathCullBoxClass => {
        let anyNear = false;
        for (let i = 0; i < segCount; i++) {
            const x0 = seg[i * 4]!, z0 = seg[i * 4 + 1]!, x1 = seg[i * 4 + 2]!, z1 = seg[i * 4 + 3]!;
            // Cheap conservative proximity: the segment's AABB grown by d must
            // overlap the box for any of the box to be within d of it.
            if (Math.min(x0, x1) - d > maxX || Math.max(x0, x1) + d < minX
                || Math.min(z0, z1) - d > maxZ || Math.max(z0, z1) + d < minZ) {
                continue;
            }
            anyNear = true;
            // A stadium is CONVEX, so all four corners within d of ONE segment
            // proves the whole box is inside that segment's stadium.
            if (distSqToSegment(minX, minZ, x0, z0, x1, z1) <= dSq
                && distSqToSegment(maxX, minZ, x0, z0, x1, z1) <= dSq
                && distSqToSegment(minX, maxZ, x0, z0, x1, z1) <= dSq
                && distSqToSegment(maxX, maxZ, x0, z0, x1, z1) <= dSq) {
                return 'all';
            }
        }
        if (!anyNear) {
            // No segment comes within d of the box ⇒ no segment CROSSES it ⇒ the
            // polygon test is uniform over the whole box, so one sample decides it.
            if (mode === 'outside') {
                return isInside((minX + maxX) / 2, (minZ + maxZ) / 2) ? 'all' : 'none';
            }
            return 'none';
        }
        return 'partial';
    };

    return { keeps, classifyBox, mode, segmentCount: segCount };
}
