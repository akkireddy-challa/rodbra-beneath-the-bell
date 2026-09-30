// Track centerline extraction: turn a road-surface trimesh (e.g. one returned
// by VxlSceneTerrainSystem.getTrimesh / getTrackCenterline) into an ordered,
// evenly-spaced, road-centered closed loop of waypoints — for AI driving lines,
// checkpoint placement, minimaps, etc.
//
// Pipeline: triangle centroids -> 3D grid-thin -> greedy nearest-neighbor walk
// (full-3D distance so layered decks stay separate, step-capped so it can't jump
// the infield where the loop nearly touches itself) -> resample to N even points
// -> closed-loop smoothing -> recenter each point to the road midpoint
// (connectivity-filtered so a parallel section can't pull the line off the road).
//
// Pure (no engine/physics state) and unit-tested. Returns [] when the mesh can't
// yield a usable loop (too sparse, or the walk dead-ends).

export type CenterlinePoint = { x: number; y: number; z: number };

/**
 * A baked level that can answer named-trimesh queries — `VxlSceneTerrainSystem` (a voxel bake)
 * or `MeshLevel` (a mesh level). Game code reaches whichever the world has through
 * `worldGenerator.getBakedLevel()`; see agent-docs/named-trimesh-query.md.
 */
export interface NamedTrimeshLevel {
    getTrimeshNames(): string[];
    getTrimesh(name: string): { vertices: Float32Array; indices: Uint32Array } | null;
    getTrackCenterline(name: string, options?: Partial<TrackCenterlineOptions>): CenterlinePoint[];
}

export interface TrackCenterlineOptions {
    /** Output waypoint count, evenly spaced around the loop. */
    waypointCount: number;
    /** 3D thinning cell size (m): one representative sample is kept per cell. */
    sampleGridSize: number;
    /** Max gap (m) bridged between SEPARATELY-MESHED road pieces (disconnected
     *  components of the welded surface graph). Never links two legs of one
     *  track — those are the same component — so it can't shortcut the infield. */
    maxStepDistance: number;
    /** Closed-loop moving-average window (odd; even values are bumped up by 1). */
    smoothingWindow: number;
    /** Run the road-center pass (move each waypoint to the road's midpoint). */
    recenter: boolean;
    /** Recenter slab: lateral search radius (m) on each side of the waypoint. */
    recenterHalfWidth: number;
    /** Recenter slab: half-thickness (m) along the driving direction. */
    recenterForwardTol: number;
    /** Recenter: vertical tolerance (m) for "same height level"; beyond this is
     *  treated as a different deck (bridge / overpass) and ignored. */
    recenterYTol: number;
    /** Recenter: lateral gap (m) that splits slab samples into runs, so a
     *  parallel track section across the infield can't drag the midpoint off-road. */
    recenterGapThreshold: number;
    /** Reverse the loop direction (applied AFTER `orientTo`). */
    reverse: boolean;
    /**
     * Racing direction the lap must run, as a world position and the heading
     * intended there — normally the player's start line and the way the grid
     * faces. Loop extraction picks one of the two directions arbitrarily, so
     * without this the lap can come out backwards (and flip between bakes).
     * With it, the array is reversed when its local travel direction at
     * `position` opposes `heading`, making the order match the designer's
     * intent every time. `VxlSceneTerrainSystem.getTrackCenterline` fills this
     * in from the `player` spawn point when the caller omits it.
     */
    orientTo?: { position: { x: number; z: number }; heading: { x: number; z: number } };
}

export const DEFAULT_TRACK_CENTERLINE_OPTIONS: TrackCenterlineOptions = {
    waypointCount: 96,
    sampleGridSize: 4,
    maxStepDistance: 12,
    smoothingWindow: 5,
    recenter: true,
    recenterHalfWidth: 15,
    recenterForwardTol: 2,
    recenterYTol: 1.5,
    recenterGapThreshold: 2.5,
    reverse: false,
};

/**
 * Build a road-centered, evenly-spaced, closed waypoint loop from a track
 * surface trimesh (world coordinates, as `getTrimesh` returns). Returns [] if
 * the mesh is too sparse or doesn't form a traversable loop.
 */
export function buildTrackCenterline(
    trimesh: { vertices: Float32Array; indices: Uint32Array },
    options?: Partial<TrackCenterlineOptions>,
): CenterlinePoint[] {
    const opts = { ...DEFAULT_TRACK_CENTERLINE_OPTIONS, ...options };
    const verts = trimesh.vertices;
    const indices = trimesh.indices;
    if (verts.length < 9 || indices.length < 3) return [];

    // 1. Triangle centroids — one sample per face, even coverage regardless of
    //    how the surface is tessellated (raw vertex sampling is density-biased).
    const triCount = Math.floor(indices.length / 3);
    const centroids: CenterlinePoint[] = new Array(triCount);
    for (let t = 0; t < triCount; t++) {
        const i0 = (indices[t * 3] ?? 0) * 3;
        const i1 = (indices[t * 3 + 1] ?? 0) * 3;
        const i2 = (indices[t * 3 + 2] ?? 0) * 3;
        centroids[t] = {
            x: ((verts[i0] ?? 0) + (verts[i1] ?? 0) + (verts[i2] ?? 0)) / 3,
            y: ((verts[i0 + 1] ?? 0) + (verts[i1 + 1] ?? 0) + (verts[i2 + 1] ?? 0)) / 3,
            z: ((verts[i0 + 2] ?? 0) + (verts[i1 + 2] ?? 0) + (verts[i2 + 2] ?? 0)) / 3,
        };
    }

    // 2. Grid-thin into a 3D voxel grid: one representative per cell evens out
    //    density, and using Y as a third axis keeps a bridge deck and the road
    //    beneath it in separate cells so the walk can't confuse them. Each cell
    //    remembers its index so triangle connectivity can be lifted onto cells.
    const cellIndexByKey = new Map<string, number>();
    const samples: CenterlinePoint[] = [];
    const g = opts.sampleGridSize;
    const cellOfTriangle = new Int32Array(triCount);
    for (let t = 0; t < triCount; t++) {
        const c = centroids[t]!;
        const key = `${Math.floor(c.x / g)},${Math.floor(c.y / g)},${Math.floor(c.z / g)}`;
        let idx = cellIndexByKey.get(key);
        if (idx === undefined) {
            idx = samples.length;
            cellIndexByKey.set(key, idx);
            samples.push(c);
        }
        cellOfTriangle[t] = idx;
    }
    if (samples.length < 8) return [];

    // 3. Lift mesh connectivity onto the cells: two cells are neighbors when
    //    triangles inside them touch at a WELDED vertex — same position, not
    //    same index. Baked voxel meshes duplicate corner vertices per quad and
    //    per chunk, so index-based sharing sees only islands; corners still
    //    coincide on the voxel grid, so welding by quantized position (1mm)
    //    recovers the true surface graph. This is TOPOLOGY, not proximity —
    //    two road legs 20m apart across the infield touch nowhere and can
    //    never be linked however close they pass, while a sparsely-tessellated
    //    straight (triangles far bigger than any distance cap) stays
    //    connected. Distance-only walking had both failure modes: it
    //    dead-ended on sparse tessellation, and raising its step cap to
    //    compensate licensed shortcut hops across the infield.
    const weldIds = new Map<string, number>();
    const weldOfIndex = new Map<number, number>();
    const weldId = (vi: number): number => {
        const cached = weldOfIndex.get(vi);
        if (cached !== undefined) return cached;
        const o = vi * 3;
        const key = `${Math.round((verts[o] ?? 0) * 1000)},${Math.round((verts[o + 1] ?? 0) * 1000)},${Math.round((verts[o + 2] ?? 0) * 1000)}`;
        let id = weldIds.get(key);
        if (id === undefined) {
            id = weldIds.size;
            weldIds.set(key, id);
        }
        weldOfIndex.set(vi, id);
        return id;
    };
    const cellsOfVertex = new Map<number, number[]>();
    for (let t = 0; t < triCount; t++) {
        const cell = cellOfTriangle[t]!;
        for (let k = 0; k < 3; k++) {
            const v = weldId(indices[t * 3 + k] ?? 0);
            const list = cellsOfVertex.get(v);
            if (list === undefined) cellsOfVertex.set(v, [cell]);
            else if (!list.includes(cell)) list.push(cell);
        }
    }
    const neighbors: Array<Set<number>> = Array.from({ length: samples.length }, () => new Set<number>());
    for (const list of cellsOfVertex.values()) {
        for (let a = 0; a < list.length; a++) {
            for (let b2 = a + 1; b2 < list.length; b2++) {
                neighbors[list[a]!]!.add(list[b2]!);
                neighbors[list[b2]!]!.add(list[a]!);
            }
        }
    }

    // 3b. Reconnect separately-meshed road pieces: when the graph has several
    //     components, add a bridge edge between the closest cell pair of any
    //     two components that sit within `maxStepDistance` of each other. This
    //     is the ONLY place proximity creates an edge, and it never links two
    //     legs of one track (those are the same component, connected through
    //     the rest of the loop) — so it cannot create infield shortcuts.
    {
        const maxStepSq = opts.maxStepDistance * opts.maxStepDistance;
        for (;;) {
            const comp = new Int32Array(samples.length).fill(-1);
            let compCount = 0;
            for (let s = 0; s < samples.length; s++) {
                if (comp[s]! >= 0) continue;
                comp[s] = compCount;
                const queue = [s];
                while (queue.length > 0) {
                    const c = queue.pop()!;
                    for (const n of neighbors[c]!) {
                        if (comp[n]! < 0) { comp[n] = compCount; queue.push(n); }
                    }
                }
                compCount++;
            }
            if (compCount <= 1) break;
            let bestA = -1, bestB = -1, bestDistSq = maxStepSq;
            for (let a = 0; a < samples.length; a++) {
                for (let b2 = a + 1; b2 < samples.length; b2++) {
                    if (comp[a] === comp[b2]) continue;
                    const pa = samples[a]!, pb = samples[b2]!;
                    const dx = pa.x - pb.x, dy = pa.y - pb.y, dz = pa.z - pb.z;
                    const dSq = dx * dx + dy * dy + dz * dz;
                    if (dSq <= bestDistSq) { bestDistSq = dSq; bestA = a; bestB = b2; }
                }
            }
            if (bestA < 0) break; // remaining pieces are further apart than the cap
            neighbors[bestA]!.add(bestB);
            neighbors[bestB]!.add(bestA);
        }
    }

    // 4. Loop extraction by two disjoint shortest paths. A greedy walk cannot
    //    trace a ribbon that is several cells wide (it snakes laterally, and
    //    any "visited fraction" coverage test misreads a clean single-file lap
    //    as a fragment). Instead: BFS from the seed to the graph-farthest cell
    //    (~the half-lap point), take the shortest path there, block that
    //    path's corridor (path + its 1-ring), and BFS again — the second path
    //    is forced around the other side of the circuit. The two paths
    //    concatenated are the lap. If no disjoint return path exists, the
    //    surface is not a loop and no racing line can be built.
    const bfs = (start: number, blocked: Set<number> | null) => {
        const dist = new Int32Array(samples.length).fill(-1);
        const prev = new Int32Array(samples.length).fill(-1);
        dist[start] = 0;
        let frontier = [start];
        while (frontier.length > 0) {
            const next: number[] = [];
            for (const c of frontier) {
                for (const n of neighbors[c]!) {
                    if (dist[n]! >= 0 || (blocked !== null && blocked.has(n))) continue;
                    dist[n] = dist[c]! + 1;
                    prev[n] = c;
                    next.push(n);
                }
            }
            frontier = next;
        }
        return { dist, prev };
    };
    const tracePath = (prev: Int32Array, end: number): number[] => {
        const p: number[] = [];
        for (let c = end; c >= 0; c = prev[c]!) p.push(c);
        return p.reverse();
    };

    /**
     * One loop-extraction attempt on the current graph. Strict corridor first:
     * block pathA plus its 1-ring so the return route must take the genuinely
     * other side of the circuit. On a ribbon only 1-2 cells wide the 1-ring
     * seals the whole road, so fall back to blocking just pathA's own cells —
     * there the ribbon is too narrow for a same-leg sneak-past anyway. The
     * tangle gate below catches anything degenerate that still slips through.
     */
    const extractLoop = (): CenterlinePoint[] | null => {
        const out = bfs(0, null);
        let far = 0;
        for (let s = 0; s < samples.length; s++) {
            if (out.dist[s]! > out.dist[far]!) far = s;
        }
        const pathA = tracePath(out.prev, far);
        if (pathA.length < 4) return null;
        const buildBlocked = (withRing: boolean): Set<number> => {
            const blocked = new Set<number>();
            const keepOpen = new Set<number>([0, far]);
            for (const n of neighbors[0]!) keepOpen.add(n);
            for (const n of neighbors[far]!) keepOpen.add(n);
            for (const c of pathA) {
                if (c === 0 || c === far) continue;
                blocked.add(c);
                if (!withRing) continue;
                for (const n of neighbors[c]!) {
                    if (!keepOpen.has(n)) blocked.add(n);
                }
            }
            blocked.delete(0);
            blocked.delete(far);
            return blocked;
        };
        let back = bfs(0, buildBlocked(true));
        if (back.dist[far]! < 0) back = bfs(0, buildBlocked(false));
        if (back.dist[far]! < 0) return null;
        const pathB = tracePath(back.prev, far);
        return [
            ...pathA.map((c) => samples[c]!),
            ...pathB.slice(1, -1).reverse().map((c) => samples[c]!),
        ];
    };

    /**
     * When the surface is an open arc (a break in the road wider than a cell,
     * e.g. two 4m seams splitting a ring into arcs that component-bridging can
     * only chain, not close), reconnect a "loose end": the closest cell pair
     * that is spatially within `maxStepDistance` but MANY hops apart on the
     * graph. Graph-far-but-space-near is what distinguishes the two rims of a
     * genuine break from the two lanes of one road (graph-near) — and two legs
     * across the infield are farther apart than the cap, so this cannot
     * shortcut a circuit.
     */
    const bridgeLooseEnds = (): boolean => {
        const maxStepSq = opts.maxStepDistance * opts.maxStepDistance;
        let bestA = -1, bestB = -1, bestDistSq = maxStepSq;
        for (let a = 0; a < samples.length; a++) {
            const da = bfs(a, null).dist;
            for (let b2 = a + 1; b2 < samples.length; b2++) {
                const hops = da[b2]!;
                if (hops >= 0 && hops <= 8) continue; // same stretch of road
                const pa = samples[a]!, pb = samples[b2]!;
                const dx = pa.x - pb.x, dy = pa.y - pb.y, dz = pa.z - pb.z;
                const dSq = dx * dx + dy * dy + dz * dz;
                if (dSq <= bestDistSq) { bestDistSq = dSq; bestA = a; bestB = b2; }
            }
        }
        if (bestA < 0) return false;
        neighbors[bestA]!.add(bestB);
        neighbors[bestB]!.add(bestA);
        return true;
    };

    let path: CenterlinePoint[] | null = extractLoop();
    for (let attempt = 0; path === null && attempt < 4; attempt++) {
        if (!bridgeLooseEnds()) break;
        path = extractLoop();
    }
    if (path === null) {
        console.warn(
            `[TrackCenterline] The track surface has no closed loop — a lap needs two disjoint `
            + `routes between its endpoints, and only one exists (open road, or a break wider `
            + `than maxStepDistance=${opts.maxStepDistance}m). Returning [] instead of a broken racing line.`
        );
        return [];
    }
    if (path.length < 8) return [];

    // 4 + 5. Resample to N evenly-spaced points, then light closed-loop smoothing.
    const resampled = resampleClosedLoop(path, opts.waypointCount);
    const smoothed = smoothClosedLoop(resampled, opts.smoothingWindow);

    // 6. Recenter to the road midpoint. Uses the FULL centroid set (not the
    //    thinned samples) so even a narrow road has the density to resolve both
    //    edges precisely.
    const centered = opts.recenter ? recenterToRoadMidpoint(smoothed, centroids, opts) : smoothed;

    // 7. Tangle gate: in a sound lap, waypoints far apart in loop order are far
    //    apart in space. Many order-distant/space-near pairs mean the "lap" is
    //    an out-and-back or a knot — the failure mode that scattered waypoints
    //    across the infield and sent every AI car off the track. Refuse loudly
    //    rather than ship a broken racing line.
    const n2 = centered.length;
    let tangles = 0;
    for (let a = 0; a < n2; a++) {
        for (let b2 = a + 3; b2 < n2; b2++) {
            if (Math.min(b2 - a, n2 - (b2 - a)) < 8) continue;
            const pa = centered[a]!, pb = centered[b2]!;
            if (Math.hypot(pa.x - pb.x, pa.z - pb.z) < 6) tangles++;
        }
    }
    if (tangles > n2 / 8) {
        console.warn(
            `[TrackCenterline] Racing line failed the self-check: ${tangles} waypoint pairs are far `
            + `apart in lap order but nearly coincide in space — the loop doubles back on itself. `
            + `Returning [] instead of a broken racing line.`
        );
        return [];
    }

    // 8. Orient to the intended racing direction. Loop extraction picks one of
    //    the two ways round arbitrarily, so without a hint the lap can come out
    //    backwards — every AI car then races against the grid it started on.
    let oriented = centered;
    const orient = opts.orientTo;
    if (orient) {
        const m = centered.length;
        let nearest = 0;
        let nearestDistSq = Infinity;
        for (let i = 0; i < m; i++) {
            const p = centered[i]!;
            const dx = p.x - orient.position.x, dz = p.z - orient.position.z;
            const dSq = dx * dx + dz * dz;
            if (dSq < nearestDistSq) { nearestDistSq = dSq; nearest = i; }
        }
        const a = centered[nearest]!;
        const b2 = centered[(nearest + 1) % m]!;
        const tx = b2.x - a.x, tz = b2.z - a.z;
        if (tx * orient.heading.x + tz * orient.heading.z < 0) {
            oriented = centered.slice().reverse();
        }
    }

    // 9. Explicit caller flip, applied on top of the resolved direction.
    return opts.reverse ? oriented.slice().reverse() : oriented;
}

/** Resample a closed-loop polyline to exactly `n` evenly-spaced points at
 *  constant arc-length intervals; path[last] -> path[0] is the closing edge. */
function resampleClosedLoop(path: CenterlinePoint[], n: number): CenterlinePoint[] {
    const m = path.length;
    if (m < 2 || n < 2) return path.slice();

    const cum: number[] = new Array(m + 1);
    cum[0] = 0;
    for (let i = 1; i < m; i++) {
        const a = path[i - 1]!;
        const b = path[i]!;
        cum[i] = cum[i - 1]! + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    }
    const closeA = path[m - 1]!;
    const closeB = path[0]!;
    cum[m] = cum[m - 1]! + Math.hypot(closeB.x - closeA.x, closeB.y - closeA.y, closeB.z - closeA.z);
    const total = cum[m]!;

    const step = total / n;
    const out: CenterlinePoint[] = new Array(n);
    let seg = 0;
    for (let k = 0; k < n; k++) {
        const target = k * step;
        while (seg < m && cum[seg + 1]! < target) seg++;
        const a = (seg < m ? path[seg]! : closeA);
        const b = (seg < m - 1 ? path[seg + 1]! : closeB);
        const segLen = cum[seg + 1]! - cum[seg]!;
        const t = segLen > 0 ? (target - cum[seg]!) / segLen : 0;
        out[k] = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
    }
    return out;
}

/** Centered moving-average smoothing on a CLOSED loop (neighbour indices wrap
 *  modulo N). Window must be odd; even values are bumped up by 1. */
function smoothClosedLoop(path: CenterlinePoint[], windowSize: number): CenterlinePoint[] {
    const n = path.length;
    if (n < 3 || windowSize < 3) return path.slice();
    const w = windowSize % 2 === 0 ? windowSize + 1 : windowSize;
    const half = (w - 1) >> 1;
    const out: CenterlinePoint[] = new Array(n);
    for (let i = 0; i < n; i++) {
        let sx = 0, sy = 0, sz = 0;
        for (let k = -half; k <= half; k++) {
            const p = path[((i + k) % n + n) % n]!;
            sx += p.x; sy += p.y; sz += p.z;
        }
        out[i] = { x: sx / w, y: sy / w, z: sz / w };
    }
    return out;
}

/**
 * Move each waypoint to the road midpoint at its location. At each point: scan
 * surface samples in a thin slab perpendicular to the driving direction and at
 * roughly the same Y (so bridges don't mix in); split the slab's signed lateral
 * offsets into "runs" separated by gaps wider than `recenterGapThreshold`; keep
 * the run that contains the waypoint (so a parallel section across the infield is
 * ignored); move the waypoint to the midpoint of that run's MIN/MAX extremes.
 *
 * Extremes (not the mean) are used on purpose: a mean is biased toward whichever
 * side is more densely tessellated, which cuts the apex on the inside of a corner.
 */
function recenterToRoadMidpoint(
    waypoints: CenterlinePoint[],
    samples: readonly CenterlinePoint[],
    opts: TrackCenterlineOptions,
): CenterlinePoint[] {
    const n = waypoints.length;
    if (n < 3) return waypoints.slice();

    const halfWidthSq = opts.recenterHalfWidth * opts.recenterHalfWidth;
    const forwardTol = opts.recenterForwardTol;
    const yTol = opts.recenterYTol;
    const gap = opts.recenterGapThreshold;

    const out: CenterlinePoint[] = new Array(n);
    for (let i = 0; i < n; i++) {
        const wp = waypoints[i]!;
        const prev = waypoints[(i - 1 + n) % n]!;
        const next = waypoints[(i + 1) % n]!;

        // Driving direction in XZ (Y kept level so the slab is perpendicular to
        // the road, not tilted by elevation change).
        let fx = next.x - prev.x;
        let fz = next.z - prev.z;
        const flen = Math.hypot(fx, fz);
        if (flen < 1e-6) { out[i] = wp; continue; }
        fx /= flen; fz /= flen;

        // Right-hand perpendicular in XZ.
        const rx = fz;
        const rz = -fx;

        // Signed lateral offsets of every sample inside the slab.
        const lats: number[] = [];
        for (const s of samples) {
            if (Math.abs(s.y - wp.y) > yTol) continue;            // same height level only
            const dx = s.x - wp.x;
            const dz = s.z - wp.z;
            if (dx * dx + dz * dz > halfWidthSq) continue;        // distance cull
            const fwd = dx * fx + dz * fz;
            if (fwd > forwardTol || fwd < -forwardTol) continue;  // thin transverse slab
            lats.push(dx * rx + dz * rz);
        }
        if (lats.length === 0) { out[i] = wp; continue; }

        // Connectivity filter: split sorted offsets into runs at gaps, keep the
        // run nearest lat=0 (the road the waypoint is on), ignore anything across
        // the gap (a parallel section).
        lats.sort((a, b) => a - b);
        let runMin = lats[0]!;
        let runMax = lats[0]!;
        let bestMin = runMin;
        let bestMax = runMax;
        let bestDistTo0 = Infinity;
        const considerRun = (lo: number, hi: number): void => {
            const d = lo <= 0 && hi >= 0 ? 0 : (hi < 0 ? -hi : lo);
            if (d < bestDistTo0) { bestDistTo0 = d; bestMin = lo; bestMax = hi; }
        };
        for (let k = 1; k < lats.length; k++) {
            const v = lats[k]!;
            if (v - lats[k - 1]! > gap) { considerRun(runMin, runMax); runMin = v; runMax = v; }
            else { runMax = v; }
        }
        considerRun(runMin, runMax);

        if (bestMax <= bestMin) { out[i] = wp; continue; }

        const midLat = (bestMin + bestMax) * 0.5;
        out[i] = { x: wp.x + rx * midLat, y: wp.y, z: wp.z + rz * midLat };
    }
    return out;
}
