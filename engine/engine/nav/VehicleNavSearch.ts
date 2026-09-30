import {
    type VehicleNavGrid, evaluateGridEdge, CELL_PROP_BLOCKED,
    type NavPoint, type VehicleNavQueryOptions, type VehicleNavPath, type GridCoord,
} from 'engine/nav/VehicleNavGrid.js';
// MinHeap/AStarNode reused as-is: its node shape (gx, gz, g, f, layer?) is
// exactly what this search needs. Parent/path bookkeeping never lived on the
// heap node — it is tracked separately below (cameFrom) — so there is
// nothing here to contort through the type; a second heap would just
// duplicate this one. VoxelNavMesh.ts pulls in THREE transitively, but only
// for its own mesh/debug helpers this file never touches, so importing it
// stays jest-safe.
import { MinHeap, type AStarNode } from 'engine/VoxelNavMesh.js';

export const MAX_LEG_M = 25;
export const SNAP_RADIUS_M = 16;
export const MAX_EXPANSIONS = 150_000;
/** Extra cost per entered cell adjacent to a blocked cell — keeps paths off the kerb line. */
export const CLEARANCE_PENALTY = 0.75;

function distance2D(a: NavPoint, b: NavPoint): number {
    return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * Mirrors VehicleNavGrid's private cell-drivability predicate (cost > 0, not
 * PROP_BLOCKED). Duplicated here deliberately: this is a one-line check used
 * for search-time bookkeeping (snapping, clearance-penalty neighbourhood
 * scans), not an edge-legality rule — legality itself always goes through
 * `evaluateGridEdge` below, never re-derived in this module.
 */
function isDrivableCell(grid: VehicleNavGrid, gx: number, gz: number): boolean {
    return grid.inBounds(gx, gz)
        && grid.getCost(gx, gz) > 0
        && (grid.getFlags(gx, gz) & CELL_PROP_BLOCKED) === 0;
}

/** True when any of the 8 neighbours of (gx,gz) is out of bounds or not drivable. */
function hasBlockedNeighbor(grid: VehicleNavGrid, gx: number, gz: number): boolean {
    for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dz === 0) continue;
            // isDrivableCell fails closed out of bounds, so that case is covered.
            if (!isDrivableCell(grid, gx + dx, gz + dz)) return true;
        }
    }
    return false;
}

// ── Snapping ─────────────────────────────────────────────────────────────

/** Cells at Chebyshev ring `ring` around (cx,cz); ring 0 is the centre cell itself. */
function* ringCells(cx: number, cz: number, ring: number): Generator<GridCoord> {
    if (ring === 0) {
        yield { gx: cx, gz: cz };
        return;
    }
    for (let dx = -ring; dx <= ring; dx++) {
        yield { gx: cx + dx, gz: cz - ring };
        yield { gx: cx + dx, gz: cz + ring };
    }
    for (let dz = -ring + 1; dz <= ring - 1; dz++) {
        yield { gx: cx - ring, gz: cz + dz };
        yield { gx: cx + ring, gz: cz + dz };
    }
}

/** Nearest grid cell to a world point, clamped into bounds — a projection, not a drivability claim. */
function projectedCell(grid: VehicleNavGrid, point: NavPoint): GridCoord {
    const gx = Math.floor((point.x - grid.dims.minX) / grid.dims.cellSize);
    const gz = Math.floor((point.z - grid.dims.minZ) / grid.dims.cellSize);
    return {
        gx: Math.min(Math.max(gx, 0), grid.dims.width - 1),
        gz: Math.min(Math.max(gz, 0), grid.dims.height - 1),
    };
}

/**
 * Nearest drivable cell to `point` within `radiusM` (euclidean), via an
 * expanding-ring (spiral) search anchored at the point's grid projection.
 * Returns null when nothing drivable falls within radius.
 */
function snapToDrivableCell(grid: VehicleNavGrid, point: NavPoint, radiusM: number): GridCoord | null {
    const anchor = projectedCell(grid, point);
    const maxRing = Math.max(1, Math.ceil(radiusM / grid.dims.cellSize) + 1);
    const radiusSq = radiusM * radiusM;

    let best: GridCoord | null = null;
    let bestDistSq = Infinity;

    for (let ring = 0; ring <= maxRing; ring++) {
        for (const cell of ringCells(anchor.gx, anchor.gz, ring)) {
            if (!isDrivableCell(grid, cell.gx, cell.gz)) continue;
            const centre = grid.cellToWorld(cell.gx, cell.gz);
            const dx = centre.x - point.x, dz = centre.z - point.z;
            const distSq = dx * dx + dz * dz;
            if (distSq > radiusSq) continue;
            if (distSq < bestDistSq) {
                bestDistSq = distSq;
                best = cell;
            }
        }
    }
    return best;
}

// ── Supercover line-of-sight (for string-pull) ──────────────────────────

/**
 * Every grid cell the infinite-thin segment between two cell CENTRES
 * geometrically touches, in order from (x0,z0) to (x1,z1) — including cells
 * it only grazes at a lattice corner. Plain Bresenham silently picks one of
 * the two corner cells at an exact 45-degree crossing and would let the
 * string-pull cut through the other one undetected; this "supercover"
 * variant (ported from the reference supercover-line algorithm, E. Dedu)
 * always visits both.
 */
export function supercoverLine(x0: number, z0: number, x1: number, z1: number): GridCoord[] {
    const cells: GridCoord[] = [{ gx: x0, gz: z0 }];
    let x = x0, z = z0;
    let dx = x1 - x0;
    let dz = z1 - z0;
    const xStep = dx < 0 ? -1 : 1;
    const zStep = dz < 0 ? -1 : 1;
    dx = Math.abs(dx);
    dz = Math.abs(dz);
    const ddx = 2 * dx;
    const ddz = 2 * dz;

    if (ddx >= ddz) {
        let error = dx;
        let errorPrev = dx;
        for (let i = 0; i < dx; i++) {
            x += xStep;
            error += ddz;
            if (error > ddx) {
                z += zStep;
                error -= ddx;
                if (error + errorPrev < ddx) {
                    cells.push({ gx: x, gz: z - zStep });
                } else if (error + errorPrev > ddx) {
                    cells.push({ gx: x - xStep, gz: z });
                } else {
                    cells.push({ gx: x, gz: z - zStep });
                    cells.push({ gx: x - xStep, gz: z });
                }
            }
            cells.push({ gx: x, gz: z });
            errorPrev = error;
        }
    } else {
        let error = dz;
        let errorPrev = dz;
        for (let i = 0; i < dz; i++) {
            z += zStep;
            error += ddx;
            if (error > ddz) {
                x += xStep;
                error -= ddz;
                if (error + errorPrev < ddz) {
                    cells.push({ gx: x - xStep, gz: z });
                } else if (error + errorPrev > ddz) {
                    cells.push({ gx: x, gz: z - zStep });
                } else {
                    cells.push({ gx: x - xStep, gz: z });
                    cells.push({ gx: x, gz: z - zStep });
                }
            }
            cells.push({ gx: x, gz: z });
            errorPrev = error;
        }
    }
    return cells;
}

/**
 * Grid line-of-sight between two cells: legal only if every cell the
 * supercover line touches is drivable AND every consecutive crossed pair
 * passes `evaluateGridEdge`. Safe precisely because the grid IS the collider
 * truth — there is no geometry this line can cross that the grid does not
 * already know about.
 */
export function hasLineOfSight(
    grid: VehicleNavGrid, a: GridCoord, b: GridCoord, opts: VehicleNavQueryOptions,
): boolean {
    const cells = supercoverLine(a.gx, a.gz, b.gx, b.gz);
    for (let i = 0; i < cells.length; i++) {
        const to = cells[i]!;
        if (!isDrivableCell(grid, to.gx, to.gz)) return false;
        if (i === 0) continue;
        const from = cells[i - 1]!;
        if (from.gx === to.gx && from.gz === to.gz) continue;
        if (!evaluateGridEdge(grid, from.gx, from.gz, to.gx, to.gz, opts).passable) return false;
    }
    return true;
}

// ── String-pull + re-densify ─────────────────────────────────────────────

/** Greedy string-pull: collapse a raw cell path to the fewest LOS-legal chords. */
function stringPull(grid: VehicleNavGrid, cellPath: GridCoord[], opts: VehicleNavQueryOptions): GridCoord[] {
    if (cellPath.length <= 2) return cellPath.slice();
    const pulled: GridCoord[] = [cellPath[0]!];
    let anchor = 0;
    while (anchor < cellPath.length - 1) {
        let farthest = anchor + 1;
        for (let candidate = cellPath.length - 1; candidate > anchor + 1; candidate--) {
            if (hasLineOfSight(grid, cellPath[anchor]!, cellPath[candidate]!, opts)) {
                farthest = candidate;
                break;
            }
        }
        pulled.push(cellPath[farthest]!);
        anchor = farthest;
    }
    return pulled;
}

// ── Corner smoothing ─────────────────────────────────────────────────────

/**
 * Target radius (m) for a rounded corner. Chosen from the follower's own
 * corner law rather than by eye: `VehiclePathDrivingComponent` caps corner
 * speed at `sqrt(maxLateralAccel / curvature)`, so a constant-radius corner
 * is driveable at `sqrt(maxLateralAccel * radius)` — 5.7 m/s at the default
 * 4 m/s^2 over 8 m, comfortably above the 4 m/s town-driving target. A
 * string-pulled polyline has ZERO radius at every vertex, which is why an
 * ordinary 45-degree street corner used to read as infinite curvature and
 * pin the car at MIN_CORNER_SPEED_MPS.
 */
export const CORNER_RADIUS_M = 8;

/**
 * Radii actually attempted, as fractions of whatever radius fits between the
 * neighbouring vertices, largest first. Each smaller entry hugs the original
 * vertex more closely (the arc's inward offset is `r * (sec(turn/2) - 1)`),
 * so the ladder degrades gracefully toward the unsmoothed corner instead of
 * failing outright when a street is too narrow for the ideal arc.
 */
const CORNER_RADIUS_SCALES: readonly number[] = [1, 0.65, 0.42, 0.27];

/** Below this the arc is indistinguishable from the sharp vertex — not worth the points. */
const MIN_CORNER_RADIUS_M = 1.5;

/**
 * Spacing (m) of the samples an arc is emitted as. A metre is fine and not
 * arbitrary: the follower measures curvature over a 2.5 m baseline
 * (`CURVATURE_CHORD_M`), so vertices well inside that read as the arc they
 * trace, and the chord's sagitta at the target radius is under 2 cm. Finer
 * sampling measurably changes nothing and triples the point count.
 */
const CORNER_SAMPLE_M = 1;

/** Turns gentler than this are already fast to drive; the tangent length also blows up as turn -> 0. */
const MIN_SMOOTHED_TURN_RAD = 8 * Math.PI / 180;

/** Near-reversals (switchbacks) have no inscribed arc worth the name — left sharp. */
const MAX_SMOOTHED_TURN_RAD = 170 * Math.PI / 180;

/**
 * Legality of a straight segment between two arbitrary WORLD points, judged
 * by exactly the rule string-pulling obeys: the supercover cells between the
 * two containing cells must all be drivable and every crossed pair must pass
 * `evaluateGridEdge`. Points outside the grid fail closed.
 *
 * This is what keeps smoothing honest. A rounded corner necessarily moves the
 * route toward the inside of the bend, i.e. toward the kerb; running every
 * emitted segment back through the grid means an arc can only survive where
 * the planner would have been allowed to drive a straight chord anyway.
 */
function worldSegmentLegal(
    grid: VehicleNavGrid, a: NavPoint, b: NavPoint, opts: VehicleNavQueryOptions,
): boolean {
    const cellA = grid.worldToCell(a.x, a.z);
    const cellB = grid.worldToCell(b.x, b.z);
    if (cellA === null || cellB === null) return false;
    return hasLineOfSight(grid, cellA, cellB, opts);
}

/**
 * The circular arc of radius `radius` inscribed in the corner at `vertex`,
 * sampled from its entry tangent point to its exit tangent point inclusive.
 * `u1`/`u2` are unit vectors from the vertex BACK along the incoming leg and
 * FORWARD along the outgoing one; `turn` is the deviation angle between the
 * legs (0 = straight through).
 */
function inscribedArc(
    vertex: NavPoint, u1: NavPoint, u2: NavPoint, radius: number, turn: number,
): NavPoint[] {
    const halfTurn = turn / 2;
    const tangent = radius * Math.tan(halfTurn);
    const bisX = u1.x + u2.x, bisZ = u1.z + u2.z;
    const bisLen = Math.hypot(bisX, bisZ);
    // The centre sits along the corner's bisector at radius / cos(turn/2);
    // bisLen is only ~0 for the straight-through and full-reversal cases the
    // caller already excluded by turn angle.
    const centreDist = radius / Math.cos(halfTurn);
    const cx = vertex.x + (bisX / bisLen) * centreDist;
    const cz = vertex.z + (bisZ / bisLen) * centreDist;

    const start = { x: vertex.x + u1.x * tangent, z: vertex.z + u1.z * tangent };
    const end = { x: vertex.x + u2.x * tangent, z: vertex.z + u2.z * tangent };
    const startAngle = Math.atan2(start.z - cz, start.x - cx);
    const endAngle = Math.atan2(end.z - cz, end.x - cx);
    let sweep = endAngle - startAngle;
    while (sweep > Math.PI) sweep -= Math.PI * 2;
    while (sweep < -Math.PI) sweep += Math.PI * 2;

    const steps = Math.max(2, Math.ceil(Math.abs(sweep) * radius / CORNER_SAMPLE_M));
    const arc: NavPoint[] = [];
    for (let i = 0; i <= steps; i++) {
        const angle = startAngle + sweep * (i / steps);
        arc.push({ x: cx + Math.cos(angle) * radius, z: cz + Math.sin(angle) * radius });
    }
    return arc;
}

/**
 * The largest legal inscribed arc at one corner, or null when even the
 * tightest candidate is illegal (or the corner is too gentle / too sharp to
 * round at all) — in which case the caller keeps the original sharp vertex.
 */
function roundCorner(
    grid: VehicleNavGrid, prev: NavPoint, vertex: NavPoint, next: NavPoint,
    maxTangentIn: number, maxTangentOut: number, opts: VehicleNavQueryOptions,
): NavPoint[] | null {
    const inLen = distance2D(prev, vertex);
    const outLen = distance2D(vertex, next);
    if (inLen < 1e-6 || outLen < 1e-6) return null;

    const u1 = { x: (prev.x - vertex.x) / inLen, z: (prev.z - vertex.z) / inLen };
    const u2 = { x: (next.x - vertex.x) / outLen, z: (next.z - vertex.z) / outLen };
    const dot = Math.min(1, Math.max(-1, u1.x * u2.x + u1.z * u2.z));
    const turn = Math.PI - Math.acos(dot);
    if (turn < MIN_SMOOTHED_TURN_RAD || turn > MAX_SMOOTHED_TURN_RAD) return null;

    // Longest tangent the neighbouring legs can spare, and the radius it buys.
    const tangentCap = Math.min(maxTangentIn, maxTangentOut);
    const fittingRadius = Math.min(CORNER_RADIUS_M, tangentCap / Math.tan(turn / 2));

    for (const scale of CORNER_RADIUS_SCALES) {
        const radius = fittingRadius * scale;
        if (radius < MIN_CORNER_RADIUS_M) break;
        const arc = inscribedArc(vertex, u1, u2, radius, turn);
        // `prev` and `next` bracket the arc: the joining segments run along
        // the original legs, but they are emitted polyline segments like any
        // other, so they get checked like any other.
        const chain = [prev, ...arc, next];
        const legal = chain.every((point, i) => i === 0 || worldSegmentLegal(grid, chain[i - 1]!, point, opts));
        if (legal) return arc;
    }
    return null;
}

/**
 * Replaces each sharp vertex of a string-pulled route with the largest
 * grid-legal circular arc that fits, so the follower's curvature estimate
 * sees a corner's real radius instead of a zero-radius kink.
 *
 * Straights are untouched: only vertices with a real turn are rounded, and
 * the arc's tangent points lie on the original legs, so a smoothed route is
 * the original route everywhere except within a corner's tangent length.
 *
 * Chaikin subdivision was the other candidate (and what issue #831 first
 * suggested). It was rejected because the radius it produces falls out of the
 * leg lengths rather than being chosen: on the 20 m legs a town street
 * actually string-pulls to, it rounds far more of the straight than needed,
 * and on a run of 1.4 m legs — the zigzag this exists to fix — it barely
 * rounds at all. An inscribed arc lets the radius be picked from the corner
 * speed it has to support, and shrink only where the street cannot take it.
 */
export function smoothRouteCorners(
    grid: VehicleNavGrid, points: NavPoint[], opts: VehicleNavQueryOptions,
): NavPoint[] {
    if (points.length < 3) return points.slice();

    const out: NavPoint[] = [points[0]!];
    for (let i = 1; i < points.length - 1; i++) {
        const vertex = points[i]!;
        const next = points[i + 1]!;
        // The incoming budget is measured from the last point actually
        // emitted — the previous corner's exit tangent, when there was one —
        // so two corners on a short leg cannot eat into each other. The
        // outgoing budget stops at half the leg for the same reason, except
        // on the final leg where no further corner can follow.
        const prev = out[out.length - 1]!;
        const maxTangentIn = distance2D(prev, vertex) * 0.95;
        const isLastLeg = i + 1 === points.length - 1;
        const maxTangentOut = distance2D(vertex, next) * (isLastLeg ? 0.95 : 0.5);

        const arc = roundCorner(grid, prev, vertex, next, maxTangentIn, maxTangentOut, opts);
        if (arc === null) out.push(vertex);
        else out.push(...arc);
    }
    out.push(points[points.length - 1]!);
    return out;
}

/** Splits any leg longer than MAX_LEG_M into equal sub-legs at or under the cap. */
function redensify(points: NavPoint[]): NavPoint[] {
    if (points.length === 0) return points;
    const out: NavPoint[] = [points[0]!];
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1]!, b = points[i]!;
        const dist = distance2D(a, b);
        const segments = Math.max(1, Math.ceil(dist / MAX_LEG_M));
        for (let s = 1; s <= segments; s++) {
            out.push({ x: a.x + (b.x - a.x) * (s / segments), z: a.z + (b.z - a.z) * (s / segments) });
        }
    }
    return out;
}

// ── A* ───────────────────────────────────────────────────────────────────

/**
 * Octile distance to the goal, scaled by the minimum possible material cost
 * (1.0). Admissible because CLEARANCE_PENALTY and any per-cell cost above
 * 1.0 only ever add to the true cost, never subtract from it.
 */
function octileHeuristic(gx: number, gz: number, goalGx: number, goalGz: number, cellSize: number): number {
    const dx = Math.abs(gx - goalGx);
    const dz = Math.abs(gz - goalGz);
    const dMin = Math.min(dx, dz);
    const dMax = Math.max(dx, dz);
    return (dMax + (Math.SQRT2 - 1) * dMin) * cellSize;
}

const NEIGHBOR_OFFSETS: ReadonlyArray<readonly [number, number]> = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0], [1, 0],
    [-1, 1], [0, 1], [1, 1],
];

interface SearchResult {
    cellPath: GridCoord[];
    reachedDestination: boolean;
    shortfall: number;
    expanded: number;
}

function decodeIndex(grid: VehicleNavGrid, index: number): GridCoord {
    const gz = Math.floor(index / grid.dims.width);
    const gx = index - gz * grid.dims.width;
    return { gx, gz };
}

function reconstructPath(grid: VehicleNavGrid, cameFrom: Map<number, number>, startIndex: number, endIndex: number): GridCoord[] {
    const indices: number[] = [endIndex];
    let cur = endIndex;
    while (cur !== startIndex) {
        const parent = cameFrom.get(cur);
        if (parent === undefined) break; // defensive only: every non-start node visited has a parent
        indices.push(parent);
        cur = parent;
    }
    indices.reverse();
    return indices.map((index) => decodeIndex(grid, index));
}

/**
 * 8-connected A* from `startCell` toward `goalCell`, tracking the expanded
 * node closest to `to` (world metres) throughout so an unreachable or
 * capped search still returns a usable best-effort path — never fabricating
 * a path to an unreachable goal, never returning nothing at all.
 */
function searchAStar(
    grid: VehicleNavGrid, startCell: GridCoord, goalCell: GridCoord, to: NavPoint,
    opts: VehicleNavQueryOptions,
): SearchResult {
    const startIndex = grid.index(startCell.gx, startCell.gz);
    const goalIndex = grid.index(goalCell.gx, goalCell.gz);
    const cellSize = grid.dims.cellSize;

    const gScore = new Map<number, number>();
    const cameFrom = new Map<number, number>();
    gScore.set(startIndex, 0);

    const heap = new MinHeap();
    const startH = octileHeuristic(startCell.gx, startCell.gz, goalCell.gx, goalCell.gz, cellSize);
    heap.push({ gx: startCell.gx, gz: startCell.gz, g: 0, f: startH });

    let expanded = 0;
    let bestIndex = startIndex;
    let bestDist = distance2D(grid.cellToWorld(startCell.gx, startCell.gz), to);
    let bestG = 0;
    let reached = false;

    while (heap.size > 0 && expanded < MAX_EXPANSIONS) {
        const node = heap.pop()!;
        const index = grid.index(node.gx, node.gz);
        const knownG = gScore.get(index);
        if (knownG === undefined || node.g > knownG) continue; // stale heap entry (MinHeap has no decrease-key)

        expanded += 1;

        const worldPos = grid.cellToWorld(node.gx, node.gz);
        const dist = distance2D(worldPos, to);
        if (dist < bestDist || (dist === bestDist && node.g < bestG)) {
            bestDist = dist;
            bestG = node.g;
            bestIndex = index;
        }

        if (index === goalIndex) {
            reached = true;
            break;
        }

        for (const [dx, dz] of NEIGHBOR_OFFSETS) {
            const nGx = node.gx + dx, nGz = node.gz + dz;
            if (!grid.inBounds(nGx, nGz)) continue;

            // Edge legality only via evaluateGridEdge — never reimplement
            // step/grade rules here. Both 'blocked-cell' and 'unknown' fail
            // closed (verdict.passable === false covers both without special
            // casing): an unsurveyed cell says nothing about drivability, so
            // the search runs on whatever the grid knows right now.
            const verdict = evaluateGridEdge(grid, node.gx, node.gz, nGx, nGz, opts);
            if (!verdict.passable) continue;

            const isDiagonal = dx !== 0 && dz !== 0;
            const stepDist = isDiagonal ? cellSize * Math.SQRT2 : cellSize;
            const penalty = hasBlockedNeighbor(grid, nGx, nGz) ? CLEARANCE_PENALTY : 0;
            const moveCost = stepDist * grid.getCost(nGx, nGz) + penalty;
            const newG = node.g + moveCost;

            const nIndex = grid.index(nGx, nGz);
            const existingG = gScore.get(nIndex);
            if (existingG === undefined || newG < existingG) {
                gScore.set(nIndex, newG);
                cameFrom.set(nIndex, index);
                const h = octileHeuristic(nGx, nGz, goalCell.gx, goalCell.gz, cellSize);
                heap.push({ gx: nGx, gz: nGz, g: newG, f: newG + h });
            }
        }
    }

    const endIndex = reached ? goalIndex : bestIndex;
    const cellPath = reconstructPath(grid, cameFrom, startIndex, endIndex);

    return {
        cellPath,
        reachedDestination: reached,
        shortfall: reached ? 0 : bestDist,
        expanded,
    };
}

// ── Entry point ──────────────────────────────────────────────────────────

/**
 * Pure A* + string-pull vehicle path search over a VehicleNavGrid.
 *
 * Snaps `from`/`to` onto the drivable network within SNAP_RADIUS_M, runs
 * 8-connected A* with `evaluateGridEdge` as the sole legality authority,
 * string-pulls the raw cell path down to the fewest supercover-LOS-legal
 * chords, rounds each surviving corner to the largest grid-legal arc that
 * fits (`smoothRouteCorners`), then re-densifies any leg over MAX_LEG_M for
 * well-conditioned arc-length projection by path followers.
 */
export function findVehiclePathOnGrid(
    grid: VehicleNavGrid, from: NavPoint, to: NavPoint, opts: VehicleNavQueryOptions,
): VehicleNavPath {
    const provisional = !grid.isFullyBaked();

    const startCell = snapToDrivableCell(grid, from, SNAP_RADIUS_M);
    if (startCell === null) {
        return {
            points: [],
            reachedDestination: false,
            shortfall: distance2D(from, to),
            provisional,
            method: 'no drivable cell within 16m of start',
        };
    }

    // If the destination itself cannot be snapped, still search toward its
    // grid-projected cell using closest-reachable semantics: that cell is
    // never drivable (or A* would have snapped it), so A* can never actually
    // finalize it — the search naturally falls through to the best-effort
    // closest-reachable node instead.
    const destSnap = snapToDrivableCell(grid, to, SNAP_RADIUS_M);
    const goalCell = destSnap ?? projectedCell(grid, to);

    const search = searchAStar(grid, startCell, goalCell, to, opts);
    const pulled = stringPull(grid, search.cellPath, opts);
    const pulledPoints = pulled.map((cell) => grid.cellToWorld(cell.gx, cell.gz));
    const smoothed = smoothRouteCorners(grid, pulledPoints, opts);
    const densePoints = redensify(smoothed);

    let method = `A* over vehicle nav grid: ${search.expanded} expanded, `
        + `string-pulled ${search.cellPath.length}→${pulled.length} pts, `
        + `corner-smoothed to ${smoothed.length}, `
        + `re-densified to ${densePoints.length}`;
    if (!search.reachedDestination) {
        method += `, closest reachable — ${search.shortfall.toFixed(1)}m short`;
    }

    return {
        points: densePoints,
        reachedDestination: search.reachedDestination,
        shortfall: search.shortfall,
        provisional,
        method,
    };
}
