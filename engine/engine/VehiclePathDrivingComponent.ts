import {
    type NavPoint, type VehicleNav, type VehicleNavPath, type VehicleNavQueryOptions,
    type VehicleCapabilitySource, queryOptionsForVehicle, DEFAULT_VEHICLE_NAV_QUERY_OPTIONS,
} from 'engine/nav/VehicleNavGrid.js';
import {
    BasicDrivingComponent, SMOOTH_DRIVING_OPTIONS,
    type IVehicleDrivingComponent, type BasicDrivingOptions, type VehicleDrivingStatus,
} from 'engine/VehicleDrivingComponent.js';
// Type-only: elided at compile time, so this never pulls the real
// (Rapier-backed) Vehicle module into the jest runtime — see how
// VehicleDrivingComponent.ts and its test file do the same.
import type { Vehicle, VehiclePassResult } from 'engine/Vehicle.js';

/**
 * VehiclePathDrivingComponent — drives a polyline from `VehicleNav`, one
 * `BasicDrivingComponent` pursuit target at a time.
 *
 * This is the engine-side replacement for the game-side TownRouteDriver bug
 * where the driver called `vehicle.updateAI()` itself, double-driving the
 * frame. The contract here is the opposite: `vehicle.setDrivingComponent(
 * follower)` is the ONLY registration a caller ever does; `vehicle.updateAI(
 * dt)` calls `follower.update(dt, vehicle)`, and this class calls the INNER
 * `BasicDrivingComponent`'s `setTarget`/`setCruiseOverride`/`update` — never
 * `vehicle.updateAI` — so there is exactly one driver of the vehicle per
 * frame, always.
 *
 * Per frame while `activity === 'driving'` with a path:
 *   1. Project the car onto the polyline (arc length `s`), monotonic and
 *      windowed forward from the last projection — see `projectOntoPath`.
 *   2. Aim the inner component at a look-ahead point further along the path.
 *   3. Cap the inner's cruise speed for the corner ahead via
 *      `setCruiseOverride` (task 6's other deliverable).
 *   4. Near the path end, hand off to a FINAL target with arrival easing —
 *      the true destination when the plan reached it (or a one-time probe
 *      finds a clear line to it), otherwise the reachable PATH END, so a
 *      best-effort plan parks the car short instead of beelining unguided
 *      into whatever blocked the rest of the route — see `driveAlongPath`'s
 *      `reachedEnd` branch.
 *   5. Watch the inner's recovery status; probe before replanning so a
 *      transient wedge (another car momentarily in the way) doesn't trigger
 *      a full replan.
 *   6. Replan on: drifting off the path, a probed dead end, a provisional
 *      plan upgrading to a real one, or a post-bake nav-grid edit.
 *
 * `driveTo`'s optional third argument, `{ via }` (see `DriveToOptions`),
 * forces the route through one or more ordered points — mid-drive "turn
 * left here" redirection — planned as extra legs (`planRouteWithVias`) but
 * followed as ONE continuous path: a via's joint is an ordinary path point
 * to every step above, so it gets no special arrival/park-brake/`onArrived`
 * treatment, only the true destination does.
 *
 * Known limitation: the follower holds its VehicleNav reference across level
 * switches; a stale grid degrades to the blocked latch via the recovery probe
 * (bounded, not silent) — invalidation on level switch is future work.
 */

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests). No class state — arc-length math only.
// ---------------------------------------------------------------------------

function dist2D(a: NavPoint, b: NavPoint): number {
    return Math.hypot(a.x - b.x, a.z - b.z);
}

function clampNum(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

/** Cumulative arc length at each point; `table[0] === 0`, `table[i]` is the distance travelled to reach `points[i]`. */
function buildArcLengthTable(points: NavPoint[]): number[] {
    const table = [0];
    for (let i = 1; i < points.length; i++) {
        table.push(table[i - 1]! + dist2D(points[i - 1]!, points[i]!));
    }
    return table;
}

/**
 * Multi-leg planning for `driveTo`'s optional `via` points (see
 * `DriveToOptions`). Plans `from -> via[0] -> via[1] -> ... -> destination`
 * as separate `findVehiclePath` legs, each leg AFTER THE FIRST starting
 * from the PREVIOUS leg's ACTUAL end point — a best-effort leg may end
 * short of its requested via, so the next leg chains from where the car
 * will really be, not from the via itself. Concatenates every leg's
 * `points` into one polyline, dropping the duplicated joint point each leg
 * after the first contributes (`findVehiclePathOnGrid` always starts a
 * leg's own `points` at the exact cell centre it was asked to start from,
 * which for every leg but the first IS the previous leg's own last point),
 * and records each via's ARC POSITION — the joint's cumulative arc length
 * in the combined polyline — so the follower can later tell when the car
 * has passed it (see `VehiclePathDrivingComponent`'s `consumePassedVias`).
 *
 * An EMPTY leg (`points.length === 0`, e.g. no drivable cells within
 * snapping range of its start) aborts the WHOLE via chain: falls back to
 * planning `from -> destination` DIRECTLY — dropping every via, not just
 * the one that failed, and re-querying from the ORIGINAL `from`, not the
 * failed leg's start — rather than refusing to drive at all. An
 * unreachable via degrades to best-effort; it never blocks the trip. If
 * even that direct fallback is empty, the caller sees `points.length ===
 * 0` and reports `'blocked'` exactly as it does today for the no-via case.
 *
 * `vias.length === 0` is a pure passthrough to a single `findVehiclePath`
 * call — today's exact behaviour, byte-for-byte, so every existing
 * `driveTo(nav, dest)` call site (and its pinned tests) is unaffected.
 */
export function planRouteWithVias(
    nav: VehicleNav, from: NavPoint, vias: NavPoint[], destination: NavPoint, opts: VehicleNavQueryOptions,
): { result: VehicleNavPath; viaArcs: number[] } {
    if (vias.length === 0) {
        return { result: nav.findVehiclePath(from, destination, opts), viaArcs: [] };
    }

    const legs: VehicleNavPath[] = [];
    let legStart = from;
    for (const wp of [...vias, destination]) {
        const leg = nav.findVehiclePath(legStart, wp, opts);
        if (leg.points.length === 0) {
            const direct = nav.findVehiclePath(from, destination, opts);
            return {
                result: {
                    ...direct,
                    method: `${direct.method} (via dropped: an intermediate leg found no drivable cells)`,
                },
                viaArcs: [],
            };
        }
        legs.push(leg);
        legStart = leg.points[leg.points.length - 1]!;
    }

    const points: NavPoint[] = [];
    const jointIndices: number[] = [];
    for (let i = 0; i < legs.length; i++) {
        const leg = legs[i]!;
        points.push(...(i === 0 ? leg.points : leg.points.slice(1)));
        if (i < legs.length - 1) jointIndices.push(points.length - 1);
    }
    const cumulative = buildArcLengthTable(points);
    const viaArcs = jointIndices.map((idx) => cumulative[idx]!);

    const last = legs[legs.length - 1]!;
    return {
        result: {
            points,
            reachedDestination: last.reachedDestination,
            shortfall: last.shortfall,
            provisional: legs.some((leg) => leg.provisional),
            method: legs.map((leg) => leg.method).join(' | then | '),
        },
        viaArcs,
    };
}

/**
 * Arc-length tolerance for `consumePassedVias` — a via is treated as
 * consumed once the car's path projection `s` comes within this much of
 * (or passes) the via's recorded joint arc position. Exact equality isn't
 * expected: `s` advances in per-frame increments, so this just keeps a via
 * from lingering "unconsumed" for a fraction of a metre after the car has
 * plainly already driven through it.
 */
export const VIA_CONSUMPTION_EPSILON_M = 0.5;

/**
 * Project (x,z) onto the polyline and return the arc-length position `s` of
 * the closest point plus the perpendicular distance to it.
 *
 * Forward-only and windowed: only segments whose arc-length range overlaps
 * `[lastS, lastS + windowM]` are considered, and the returned `s` is never
 * allowed below `lastS`. Two things this buys, both load-bearing for a path
 * follower rather than a one-shot nearest-point query:
 *   - Monotonic progress. A GLOBAL nearest-point search re-projects onto
 *     wherever the polyline happens to pass closest, which for a looping or
 *     doubling-back street can be BEHIND where the car already is — the car
 *     would appear to un-drive its own progress every frame.
 *   - No jumping to a parallel street. An unbounded forward search would
 *     happily snap onto a closer parallel road a block over, because in a
 *     straight-line sense it IS closer; bounding the search to a small
 *     window keeps it locked to the road actually being driven. Off-path
 *     detection itself is the caller's job (compare the returned `distance`
 *     against `offPathReplanFactor * lookAhead`) — this function only avoids
 *     silently teleporting onto the wrong road while doing so.
 *
 * `windowM` is the caller's call for how far forward (arc length) to look;
 * `VehiclePathDrivingComponent` sizes it off the current look-ahead so the
 * search widens as the car speeds up, matching how far it can plausibly have
 * travelled since the last projection.
 */
export function projectOntoPath(
    points: NavPoint[], cumulative: number[], lastS: number, x: number, z: number, windowM: number,
): { s: number; distance: number } {
    const n = points.length;
    if (n === 0) return { s: 0, distance: Infinity };
    if (n === 1) return { s: 0, distance: dist2D(points[0]!, { x, z }) };

    const maxS = cumulative[n - 1]!;
    const searchEnd = Math.min(maxS, lastS + Math.max(windowM, 0));

    let bestS = lastS;
    let bestDist = Infinity;

    for (let i = 0; i < n - 1; i++) {
        const segStart = cumulative[i]!;
        const segEnd = cumulative[i + 1]!;
        if (segEnd < lastS) continue;      // entirely behind the window: skip
        if (segStart > searchEnd) break;   // cumulative is non-decreasing: nothing further can qualify

        const ax = points[i]!.x, az = points[i]!.z;
        const bx = points[i + 1]!.x, bz = points[i + 1]!.z;
        const segDx = bx - ax, segDz = bz - az;
        const segLen = segEnd - segStart;

        let t = segLen > 1e-9 ? ((x - ax) * segDx + (z - az) * segDz) / (segLen * segLen) : 0;
        // Floor t so the global s this segment can report never dips below
        // lastS — the segment containing lastS is the only one where this
        // can bind (every later segment already starts at/after lastS).
        const tFloor = segLen > 1e-9 ? Math.max(0, (lastS - segStart) / segLen) : 0;
        t = Math.max(tFloor, Math.min(1, t));

        const px = ax + t * segDx;
        const pz = az + t * segDz;
        const d = Math.hypot(x - px, z - pz);
        if (d < bestDist) {
            bestDist = d;
            bestS = segStart + t * segLen;
        }
    }

    if (bestDist === Infinity) {
        // lastS already sits at (or past) the path end: nothing in the
        // window. Fall back to the last point so callers always get a
        // sane, honest distance rather than the lastS/Infinity placeholder.
        const last = points[n - 1]!;
        return { s: maxS, distance: dist2D(last, { x, z }) };
    }
    return { s: bestS, distance: bestDist };
}

/** The point on the polyline at arc length `s`, clamped to `[0, total length]`. Linearly interpolated within its segment. */
export function pointAtArc(points: NavPoint[], cumulative: number[], s: number): NavPoint {
    const n = points.length;
    if (n === 0) return { x: 0, z: 0 };
    if (n === 1) return { x: points[0]!.x, z: points[0]!.z };

    const clamped = clampNum(s, 0, cumulative[n - 1]!);

    // First segment that ends at or after `clamped`, falling back to the last
    // one (which `clamped` can only sit at the very end of).
    let i = 0;
    while (i < n - 2 && clamped > cumulative[i + 1]!) i++;

    const segStart = cumulative[i]!;
    const segLen = cumulative[i + 1]! - segStart;
    const t = segLen > 1e-9 ? (clamped - segStart) / segLen : 0;
    return {
        x: points[i]!.x + t * (points[i + 1]!.x - points[i]!.x),
        z: points[i]!.z + t * (points[i + 1]!.z - points[i]!.z),
    };
}

/**
 * Extra metres the pursuit target must clear the inner driver's arrive radius
 * by — see `advanceToClearArc` for what goes wrong without it.
 *
 * 1.5 m is the smallest margin that survives a frame of motion: the car closes
 * on its target at up to its own speed, and at the crawl speeds this matters
 * at (a car that has just braked to a stop in a corner) a frame moves it
 * centimetres, so anything of this order holds the target outside the radius
 * for many frames — while staying under `lookAheadMinM` (3.5 m), so on
 * ordinary road it still leaves room for the look-ahead to shrink toward
 * tight corners rather than flooring at the clearance distance. Combined with
 * the CLAMPED inner arrive radius (see `INTERMEDIATE_ARRIVE_RADIUS_M`'s doc),
 * the total pursuit-clearance floor is 1.2 + 1.5 = 2.7 m, not 6 m.
 */
export const PURSUIT_ARRIVE_CLEARANCE_M = 1.5;

/**
 * Arrive radius the INNER `BasicDrivingComponent` is actually constructed
 * with — NOT the follower's own arrival test, which keeps using the
 * configured `options.driving.arriveRadius` unchanged (see
 * `maybeCompleteArrival`, which passes that radius explicitly to
 * `inner.isNear`) — so callers of this class still see arrival at the same
 * distance they configured.
 *
 * Why the inner needs a SMALLER radius: its `dist < arriveRadius -> brake,
 * reset progress watchdog` branch (see `BasicDrivingComponent`, ~line 475) is
 * unconditional — it fires for the intermediate pursuit targets this
 * follower feeds it every frame, not just the true destination. That is
 * exactly the deadlock `advanceToClearArc` guards against, by pushing the
 * pursuit target out to `arriveRadius + PURSUIT_ARRIVE_CLEARANCE_M`. With
 * the inner built straight off `SMOOTH_DRIVING_OPTIONS.arriveRadius` (4.5 m),
 * that floor was 4.5 + 1.5 = 6 m — a lower bound the look-ahead could never
 * shrink below, so on a tight corner the pursuit target sat past the apex and
 * the resulting chord cut inside the planned path (measured 1.37-1.54 m,
 * see corner-cut-diagnosis.md). Clamping the INNER's radius to a small 1.2 m
 * (via `Math.min(options.driving.arriveRadius, INTERMEDIATE_ARRIVE_RADIUS_M)`
 * at construction) drops that floor to 1.2 + 1.5 = 2.7 m, letting the
 * look-ahead genuinely shrink for corners, while the follower's own arrival
 * detection — a separate, explicit `inner.isNear(..., options.driving.
 * arriveRadius)` call — is untouched.
 */
export const INTERMEDIATE_ARRIVE_RADIUS_M = 1.2;

/**
 * Floor on the corner-speed cruise override — see `driveAlongPath`'s
 * `cornerSpeed` computation for where this applies.
 *
 * A commanded speed near zero is indistinguishable, to this follower, from
 * arrival: the car satisfies "go 0.09 m/s" by sitting still, so the inner
 * never underperforms its command, the recovery machinery never arms (it
 * only reacts to a car falling short of what it's being asked to do), and
 * the arc-progress stall watchdog is the only thing left to notice — a real
 * live run sat wedged for 57+ s before that fired, because a near-zero
 * commanded cruise doesn't LOOK stuck by the inner's own accounting (see
 * corner-cut-diagnosis.md, Turn 3). Flooring the override at 1.5 m/s keeps
 * throttle demand alive at every curvature: a physically blocked car now
 * visibly falls short of its command, so the inner's own recovery and the
 * outer stall watchdog both engage promptly instead of the car reading as
 * "achieving" a near-zero target forever.
 */
export const MIN_CORNER_SPEED_MPS = 1.5;

/**
 * Consecutive stall windows (see `stallWindowS`) of no arc progress the
 * follower will spend trusting the inner component before it stops asking
 * the probe's permission and replans anyway.
 *
 * The stall watchdog's probe gate reads "the straight line to the pursuit
 * point is clear" as "a transient wedge, the inner will sort it out". That
 * is a good first guess and a terrible standing assumption: a car pinned
 * against a hillside 2 m off its path has a perfectly clear 4 m line ahead
 * of it, so the gate says `passable` every time, forever, and the follower
 * defers forever. Measured on game XRTDE8YIJ4GI: nine consecutive firings,
 * zero replans, `activity` still `'driving'` 90 s in with the car oscillating
 * in place — see docs/superpowers/plans/2026-08-19-vehicle-hillside-wedge.md.
 *
 * Two windows (20 s at the default) is several times over what the inner's
 * own reverse-burst recovery needs to fire and escalate, so a wedge that
 * survives it is not one the inner is going to clear.
 */
export const STALL_DEFER_LIMIT = 2;

/**
 * Consecutive stall windows of no arc progress before the follower gives up
 * and reports `'blocked'`.
 *
 * Deliberately counted in the same currency as STALL_DEFER_LIMIT (windows
 * with under `stallProgressEpsilonM` of arc progress) rather than in failed
 * replans, because a replan from a wedged spot does NOT read as a failure:
 * `replan()`'s failure test asks whether a route was FOUND, and one always
 * is — the car is sitting on a road the grid still believes in. Counting
 * windows instead asks the only question that matters to a passenger, which
 * is whether the car has moved.
 */
export const STALL_BLOCKED_LIMIT = 4;

/**
 * How often (s) a persistently `unreachable` inner may re-trigger the
 * recovery-gated probe.
 *
 * The trigger is an EDGE (`unreachable && !prevUnreachable`) so that a car
 * mid-recovery does not re-probe every frame. But `unreachable` latches true
 * and stays true, so as a one-shot edge it fires at most once per drive and
 * then never speaks again no matter how long the car sits. Re-arming on a
 * cooldown keeps the every-frame chatter away while letting a road that
 * really is blocked be noticed more than once.
 */
export const UNREACHABLE_RETRIGGER_S = 10;

/**
 * Smallest arc length `s >= startS` whose point on the polyline is at least
 * `minDistance` away IN A STRAIGHT LINE from `(x, z)`, or null when the whole
 * remaining path stays inside that radius.
 *
 * Why this exists: the pursuit target is chosen by ARC LENGTH (`lastS +
 * lookAhead`) while `BasicDrivingComponent`'s arrival test is EUCLIDEAN
 * (`dist < arriveRadius` -> brake, reset its progress watchdog, early return —
 * and that branch is unconditional, it fires for intermediate targets too).
 * The two disagree exactly where a route doubles back: measured on the live
 * target level, a car at a switchback had a pursuit point 6 m ahead along the
 * path but only 4.18 m away in a straight line, inside the 4.5 m arrive
 * radius. The inner then brake-parked forever — and because its arrival branch
 * also resets the progress watchdog every frame, its own stuck detector could
 * never arm, so no recovery fired either; the car never moved, so `lastS`
 * never advanced, so the target never moved. Advancing the target along the
 * path until it genuinely is far away breaks that loop at its only fixable
 * end: `BasicDrivingComponent`'s arrival semantics are shipped behaviour and
 * are not touched.
 *
 * Exact rather than sampled: on each segment the squared distance to `(x, z)`
 * is a quadratic in the segment parameter, so the crossing is solved directly.
 * A sampled scan would need a step fine enough not to skip a brief excursion
 * outside the radius, at a cost paid every frame.
 */
export function advanceToClearArc(
    points: NavPoint[], cumulative: number[], startS: number, x: number, z: number, minDistance: number,
): number | null {
    const n = points.length;
    if (n === 0) return null;
    if (n === 1) return dist2D(points[0]!, { x, z }) >= minDistance ? 0 : null;

    const maxS = cumulative[n - 1]!;
    const from = clampNum(startS, 0, maxS);
    const r2 = minDistance * minDistance;

    for (let i = 0; i < n - 1; i++) {
        const segStart = cumulative[i]!;
        const segEnd = cumulative[i + 1]!;
        if (segEnd < from) continue;
        const segLen = segEnd - segStart;
        if (segLen <= 1e-9) continue;

        const ax = points[i]!.x, az = points[i]!.z;
        const dx = points[i + 1]!.x - ax, dz = points[i + 1]!.z - az;
        const t0 = Math.max(0, (from - segStart) / segLen);

        // f(t) = |a + t*d - c|^2 - r^2, a quadratic with a positive leading
        // coefficient: it is >= 0 outside its two roots. So either the
        // segment already starts clear, or the crossing is the UPPER root.
        const ox = ax - x, oz = az - z;
        const A = dx * dx + dz * dz;
        const B = 2 * (ox * dx + oz * dz);
        const C = ox * ox + oz * oz - r2;

        const fAtT0 = A * t0 * t0 + B * t0 + C;
        if (fAtT0 >= 0) return segStart + t0 * segLen;

        const disc = B * B - 4 * A * C;
        // fAtT0 < 0 means the point at t0 is strictly inside the circle, so
        // the quadratic does take negative values and the discriminant is
        // positive — no no-root case to handle here.
        const tExit = (-B + Math.sqrt(disc)) / (2 * A);
        if (tExit <= 1) return segStart + tExit * segLen;
    }
    return null;
}

const CURVATURE_SAMPLE_COUNT = 8;

/**
 * Baseline (m) each heading is measured over inside `curvatureAt`.
 *
 * Curvature is a heading DERIVATIVE, and a planned route is a polyline: all
 * of a vertex's heading change happens at one point, so measuring heading
 * between two closely-spaced samples reads a kink as near-infinite curvature
 * and a gentle bend made of several small kinks as a series of tight corners.
 * Measuring each heading across a fixed 2.5 m chord instead — about half a
 * car length either side of the sample — makes the estimate depend on the
 * route's SHAPE rather than on where its vertices happen to fall, which is
 * what lets `smoothRouteCorners`' rounded corners read as the radius they
 * actually are.
 *
 * Sized against what still has to read as a corner: a genuine 90-degree
 * vertex the planner could not round still comes out at ~0.63 rad/m over
 * this chord, i.e. a ~2.5 m/s speed cap at the default 4 m/s^2 — slow, as it
 * should be, without collapsing to MIN_CORNER_SPEED_MPS.
 */
export const CURVATURE_CHORD_M = 2.5;

/**
 * Approximate curvature (rad/m) over `[s, s + spanM]`: the MAX heading change
 * per metre across `CURVATURE_SAMPLE_COUNT` evenly-spaced samples in that
 * span, not an average — a single sharp corner inside an otherwise straight
 * span must still read as a corner, not get diluted away. ~0 on a straight;
 * sharply positive across an L-corner's kink, wherever in the span the kink
 * falls.
 *
 * Each sample's heading comes from a `CURVATURE_CHORD_M` chord centred on it
 * (clamped at the path's ends), so per-vertex jitter averages out and only
 * sustained heading change reads as a corner — see that constant.
 */
export function curvatureAt(points: NavPoint[], cumulative: number[], s: number, spanM: number): number {
    const n = points.length;
    if (n < 2) return 0;
    const maxS = cumulative[n - 1]!;
    const startS = clampNum(s, 0, maxS);
    const endS = clampNum(s + Math.max(spanM, 1e-3), 0, maxS);
    if (endS - startS < 1e-3) return 0;

    const step = (endS - startS) / CURVATURE_SAMPLE_COUNT;
    const halfChord = CURVATURE_CHORD_M / 2;

    let maxRate = 0;
    let prevHeading: number | null = null;
    for (let i = 0; i <= CURVATURE_SAMPLE_COUNT; i++) {
        const sampleS = startS + step * i;
        const fromS = Math.max(0, sampleS - halfChord);
        const toS = Math.min(maxS, sampleS + halfChord);
        // A chord clipped to less than half its length by the path's ends
        // carries too little heading information to trust; break the run
        // rather than compare against a differently-scaled neighbour.
        if (toS - fromS < halfChord) {
            prevHeading = null;
            continue;
        }
        const from = pointAtArc(points, cumulative, fromS);
        const to = pointAtArc(points, cumulative, toS);
        const dx = to.x - from.x, dz = to.z - from.z;
        if (Math.hypot(dx, dz) < 1e-6) {
            prevHeading = null;
            continue;
        }
        const heading = Math.atan2(dx, dz);
        if (prevHeading !== null) {
            let dh = heading - prevHeading;
            while (dh > Math.PI) dh -= Math.PI * 2;
            while (dh < -Math.PI) dh += Math.PI * 2;
            const rate = Math.abs(dh) / step;
            if (rate > maxRate) maxRate = rate;
        }
        prevHeading = heading;
    }
    return maxRate;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface VehiclePathFollowOptions {
    /** Look-ahead distance (m) at zero speed. */
    lookAheadBaseM: number;
    /** Extra look-ahead (m) per m/s of current speed. */
    lookAheadPerSpeed: number;
    /** Floor on the computed look-ahead (m). */
    lookAheadMinM: number;
    /** Ceiling on the computed look-ahead (m). */
    lookAheadMaxM: number;
    /** Lateral acceleration (m/s^2) a corner may demand; corner speed = sqrt(this / curvature). */
    maxLateralAccelMps2: number;
    /** Replan once perpendicular off-path distance exceeds this factor times the current look-ahead. */
    offPathReplanFactor: number;
    /** Consecutive replans that fail to improve near the same spot before giving up (activity 'blocked'). */
    replanFailureLimit: number;
    /**
     * Fix B — arc-progress stall detector. Below this much forward progress
     * (metres of path arc length `s`) within `stallWindowS`, the follower
     * treats the car as stuck regardless of what the inner reports — see
     * `updateStallWatchdog`'s doc for why the inner's OWN stuck detection
     * cannot see this case.
     */
    stallProgressEpsilonM: number;
    /** Window (s) over which `stallProgressEpsilonM` of arc-length progress must occur, or the stall watchdog fires. */
    stallWindowS: number;
    /** Options for the inner BasicDrivingComponent that actually steers. */
    driving: BasicDrivingOptions;
}

/**
 * Tuning for a car that follows a `VehicleNav` route at town-driving speeds
 * (the inner component defaults to `SMOOTH_DRIVING_OPTIONS` — the same
 * "chauffeur" preset `BasicDrivingComponent` ships).
 */
export const DEFAULT_VEHICLE_PATH_FOLLOW_OPTIONS: VehiclePathFollowOptions = {
    // Re-tuned for corners (corner-cut-diagnosis.md): the old 6 m base/floor
    // never shrank near a tight apex, so the look-ahead point sat past the
    // corner and the resulting chord cut inside the planned path. Corner
    // speed already drops near corners (see cornerSpeed below), so a smaller
    // base/floor now genuinely shrinks the look-ahead there (~4 m measured)
    // instead of flooring at 6.
    lookAheadBaseM: 3,
    lookAheadPerSpeed: 0.6,
    lookAheadMinM: 3.5,
    lookAheadMaxM: 20,
    maxLateralAccelMps2: 4,
    offPathReplanFactor: 2,
    replanFailureLimit: 3,
    stallProgressEpsilonM: 2,
    stallWindowS: 10,
    driving: SMOOTH_DRIVING_OPTIONS,
};

export type VehiclePathActivity = 'idle' | 'planning' | 'driving' | 'arrived' | 'blocked';

export interface VehiclePathDrivingStatus {
    activity: VehiclePathActivity;
    /**
     * Metres remaining along the path from the current projection to the end,
     * while still following it (or straight-line, nav-less). Once handed off
     * to a final target (see the class doc's step 4), this switches to the
     * Euclidean distance from the car to the TRUE destination — deliberately
     * NOT zero even when the car has arrived and parked at a best-effort
     * plan's reachable path end short of an unreachable destination: games
     * read this to know how far short ("we're 20 m short"), which the old
     * arc-length metric (already at 0 by then) could never express.
     */
    distanceRemaining: number;
    arrived: boolean;
    /** Count of replans issued since the last `driveTo`/`stop`. */
    replans: number;
    inner: VehicleDrivingStatus;
}

// ---------------------------------------------------------------------------
// Capability feature-detection (no `as any`)
// ---------------------------------------------------------------------------

/**
 * `Vehicle` (the real RapierVehicle) always declares `getFootprint` /
 * `getMaxClimbGrade` / `getMaxStepHeight` as required members, so this is
 * NOT narrowing away an optional-per-the-type-system field — it is a runtime
 * existence check against the actual object handed in, because the fakes
 * this component is tested against are asserted to the `Vehicle` type
 * (`as unknown as Vehicle`, the same pattern `VehicleDrivingComponent.test.ts`
 * uses) without truly implementing every member. `typeof x.method ===
 * 'function'` is a plain duck-typing check the type checker is happy with —
 * no cast required.
 */
function vehicleHasNavCapabilities(vehicle: Vehicle): vehicle is Vehicle & VehicleCapabilitySource {
    return typeof vehicle.getFootprint === 'function'
        && typeof vehicle.getMaxClimbGrade === 'function'
        && typeof vehicle.getMaxStepHeight === 'function';
}

interface ProbeCapableVehicle {
    probePath(fromX: number, fromZ: number, toX: number, toZ: number): VehiclePassResult;
}

/** Same reasoning as `vehicleHasNavCapabilities`, for the recovery-gated probe. */
function vehicleSupportsProbePath(vehicle: Vehicle): vehicle is Vehicle & ProbeCapableVehicle {
    return typeof vehicle.probePath === 'function';
}

interface DirectTarget {
    x: number;
    z: number;
    isFinal: boolean;
}

/**
 * Optional third argument to `driveTo` — mid-drive "turn left here"
 * redirection. `via` is an ORDERED list of points the route must pass
 * through before `destination`, planned as extra legs (see
 * `planRouteWithVias`) and then followed as ONE continuous path: the joints
 * are ordinary path points to the follower (pursuit, corner slowdown, the
 * stall watchdog all treat them like any other bend), so there is no
 * arrival check, no park brake, and no `onArrived` firing at a via — only
 * at the true `destination`. Omitted or empty behaves exactly like today's
 * two-argument `driveTo`. Ignored when `nav` is `null`: plain point driving
 * has no route to force through anything.
 *
 * An unreachable via degrades to best-effort rather than blocking the trip
 * — see `planRouteWithVias`'s doc for the empty-leg fallback. A via already
 * passed (the car's path projection has gone by its recorded arc position)
 * is dropped before any later replan, so a replan can never route back
 * through one already behind the car — see `consumePassedVias`.
 */
export interface DriveToOptions {
    via?: NavPoint[];
}

// ---------------------------------------------------------------------------
// The component
// ---------------------------------------------------------------------------

export class VehiclePathDrivingComponent implements IVehicleDrivingComponent {
    private readonly options: VehiclePathFollowOptions;
    private readonly inner: BasicDrivingComponent;
    /** The (possibly clamped) arrive radius the inner was actually built with — see `INTERMEDIATE_ARRIVE_RADIUS_M`'s doc. */
    private readonly innerArriveRadius: number;

    private nav: VehicleNav | null = null;
    private destination: NavPoint | null = null;
    /**
     * Unconsumed via points for the current drive, in order — see
     * `DriveToOptions`. Mutated in place (front-dropped) by
     * `consumePassedVias` as the car's projection passes each one, so a
     * later replan (which reads this same array) only ever routes through
     * what's left ahead of the car.
     */
    private vias: NavPoint[] = [];
    /**
     * Arc positions (in the CURRENT plan's arc-length table) of the joints
     * in `vias`, same order, same length — recomputed by `planRouteWithVias`
     * every time `setPathFromResult` runs. `[]` whenever the current plan
     * has no via joints at all (no vias requested, or a via chain that fell
     * back to a direct plan — see `planRouteWithVias`'s empty-leg doc).
     */
    private viaArcs: number[] = [];
    /** Set only by the interface's own `setTarget` — bypasses path-following entirely. */
    private directTarget: DirectTarget | null = null;
    private onArrivedCb: (() => void) | null = null;

    private activity: VehiclePathActivity = 'idle';

    private pathPoints: NavPoint[] | null = null;
    private pathCumulative: number[] | null = null;
    private provisional = false;
    /** `nav.getRevision()` at the time the current path was (re)planned. */
    private plannedRevision = 0;
    private lastS = 0;
    /** True once the pursuit target has switched from the path to the final (destination or path-end) target. */
    private handoffDone = false;
    /**
     * Carried straight off the current plan's `VehicleNavPath` result (see
     * `setPathFromResult`): whether the planner actually reached the
     * requested destination. `true` for the nav-less (`nav === null`) case
     * too, since there is no plan to fall short there. Drives the final-
     * handoff decision in `driveAlongPath` — see that method's doc.
     */
    private planReachedDestination = true;
    /** Set once per plan the first frame `driveAlongPath` reaches its `reachedEnd` branch — whether beelining at the true destination was judged safe. See `driveAlongPath`'s `reachedEnd` branch for the one-time decision. */
    private beelineDecided = false;
    private beelineAllowed = true;
    /** The actual point the final handoff aims at — the true destination when beelining, otherwise the reachable path end. `null` until the final handoff happens. */
    private finalTarget: NavPoint | null = null;

    private replans = 0;
    private replanFailureCount = 0;
    /**
     * Vehicle positions each failing replan in the current streak started
     * from — a rolling window, not just the immediately-preceding one. A
     * single anchor misses a car oscillating between two spots >10m apart:
     * replan A starts at spot 1, replan B starts at spot 2 (>10m from A, so
     * B reads as "improved" even though the path is equally useless),
     * replan C starts back at spot 1 (>10m from B) — the streak never
     * latches. Checking against the WHOLE window catches the oscillation:
     * C's start is within 10m of A's, still in the window.
     */
    private replanFailureAnchors: NavPoint[] = [];

    /** Inner status snapshot from the previous frame, to detect NEW failures/flips rather than re-firing on a steady state. */
    private prevFailedRecoveries = 0;
    private prevUnreachable = false;

    /** Query opts computed once from the vehicle's capabilities and reused across replans. */
    private queryOpts: VehicleNavQueryOptions | null = null;
    private lastPos: NavPoint | null = null;
    /** This frame's pursuit target (the path point, or the destination past handoff) — the probe target for the recovery-gated check. */
    private lastPursuitPoint: NavPoint | null = null;

    /**
     * Fix B state: the path arc-length `s` at the start of the current
     * stall-detection window, and seconds accumulated since that window last
     * saw `stallProgressEpsilonM` of progress. See `updateStallWatchdog`.
     */
    private stallWindowAnchorS = 0;
    private stallWindowElapsedS = 0;
    /**
     * Consecutive stall windows that have elapsed without the car covering
     * `stallProgressEpsilonM` of arc. Escalates the watchdog's response from
     * "ask the probe" to "replan anyway" to "give up" — see
     * STALL_DEFER_LIMIT / STALL_BLOCKED_LIMIT. Only genuine arc progress
     * clears it; a replan does not, because a replan the car then fails to
     * drive is not progress.
     */
    private stallWindows = 0;
    /** Seconds since the recovery-gated probe last fired for a persistently `unreachable` inner. */
    private unreachableSinceTriggerS = UNREACHABLE_RETRIGGER_S;

    constructor(options: VehiclePathFollowOptions = DEFAULT_VEHICLE_PATH_FOLLOW_OPTIONS) {
        this.options = options;
        // Clamp the INNER's arrive radius — not the follower's own arrival
        // test, which keeps reading options.driving.arriveRadius unclamped
        // (see maybeCompleteArrival) — see INTERMEDIATE_ARRIVE_RADIUS_M's
        // doc for why.
        this.innerArriveRadius = Math.min(options.driving.arriveRadius, INTERMEDIATE_ARRIVE_RADIUS_M);
        this.inner = new BasicDrivingComponent({ ...options.driving, arriveRadius: this.innerArriveRadius });
    }

    /**
     * Start driving to `destination`. `nav === null` degrades to plain point
     * driving (no path, no replanning — just `inner.setTarget(dest, true)`
     * every frame; `opts.via` is ignored in that case too — see
     * `DriveToOptions`). Planning itself happens lazily on the FIRST
     * `update()`, since it needs the vehicle's current position.
     */
    driveTo(nav: VehicleNav | null, destination: NavPoint, opts?: DriveToOptions): void {
        this.resetDriveState();
        this.nav = nav;
        this.destination = { x: destination.x, z: destination.z };
        this.vias = opts?.via ? opts.via.map((p) => ({ x: p.x, z: p.z })) : [];
        this.activity = 'planning';
        this.inner.setCruiseOverride(null);
    }

    setOnArrived(cb: (() => void) | null): void {
        this.onArrivedCb = cb;
    }

    getStatus(): VehiclePathDrivingStatus {
        let distanceRemaining = 0;
        if (this.pathPoints !== null && this.pathCumulative !== null && !this.handoffDone) {
            const maxArc = this.pathCumulative[this.pathCumulative.length - 1] ?? 0;
            distanceRemaining = Math.max(0, maxArc - this.lastS);
        } else if (this.destination !== null && this.lastPos !== null) {
            // Past handoff (beelining, or parked at a best-effort plan's
            // reachable path end), or the nav-less direct-to-destination
            // case: the arc-length metric above is either unavailable or
            // already pinned at 0 by now, so report the Euclidean distance
            // to the TRUE destination instead — see the field's own doc on
            // `VehiclePathDrivingStatus` for why this must not read 0 for a
            // car parked short.
            distanceRemaining = dist2D(this.destination, this.lastPos);
        } else if (this.directTarget !== null && this.lastPos !== null) {
            distanceRemaining = dist2D(this.directTarget, this.lastPos);
        }
        return {
            activity: this.activity,
            distanceRemaining,
            arrived: this.activity === 'arrived',
            replans: this.replans,
            inner: this.inner.getDrivingStatus(),
        };
    }

    update(deltaTime: number, vehicle: Vehicle): void {
        const pos = vehicle.getPosition();
        this.lastPos = { x: pos.x, z: pos.z };

        if (this.activity === 'planning') {
            this.plan(vehicle);
        }

        // Anything other than 'driving' — idle, arrived, or the honest,
        // immediate 'blocked' plan() reports when it found no path at all —
        // aims the inner at nothing and just lets it update below.
        let replannedThisFrame = false;
        if (this.activity === 'driving') {
            if (this.pathPoints !== null) {
                replannedThisFrame = this.driveAlongPath(vehicle);
            } else if (this.destination !== null) {
                // nav === null: plain point driving straight at the destination.
                this.inner.setTarget(this.destination.x, this.destination.z, true);
                this.handoffDone = true;
            } else if (this.directTarget !== null) {
                // Interface-level setTarget() bypass — see that method's doc.
                this.inner.setTarget(this.directTarget.x, this.directTarget.z, this.directTarget.isFinal);
            }
        }

        this.inner.update(deltaTime, vehicle);

        // Deliberately AFTER inner.update(): the recovery-gated probe and the
        // provisional/revision replan checks read this.inner.getDrivingStatus(),
        // and must see what THIS frame's update() just did, not a frame-stale
        // snapshot from before it — a status change that only becomes visible
        // to a caller polling getStatus() after THIS update() call must also
        // be visible to the check that reacts to it, in the same call.
        if (this.activity === 'driving' && this.pathPoints !== null && !replannedThisFrame) {
            this.afterInnerUpdate(deltaTime, vehicle);
        }
        if (this.activity === 'driving') {
            this.maybeCompleteArrival(vehicle);
        }
    }

    /**
     * Set the current drive target directly, abandoning any path in
     * progress. This makes the component behave as a plain point-driver via
     * the inner `BasicDrivingComponent` — activity 'driving', no path, no
     * replanning, no arrival callback. Matches `IVehicleDrivingComponent`'s
     * own contract exactly, so a caller that only knows the interface (not
     * this class's richer `driveTo`) gets ordinary point-and-go behaviour.
     */
    setTarget(x: number, z: number, isFinal = true): void {
        // Narrower than resetDriveState() on purpose: this abandons the route
        // but is not a fresh drive, so the drive-level counter getStatus()
        // reports (replans) is left as it stands.
        this.nav = null;
        this.destination = null;
        this.vias = [];
        this.viaArcs = [];
        this.pathPoints = null;
        this.pathCumulative = null;
        this.directTarget = { x, z, isFinal };
        this.finalTarget = null;
        this.resetStallWindow();
        this.activity = 'driving';
        this.inner.setCruiseOverride(null);
    }

    stop(): void {
        this.inner.stop();
        this.resetDriveState();
        this.activity = 'idle';
    }

    isNear(x: number, z: number, radius: number): boolean {
        return this.inner.isNear(x, z, radius);
    }

    yieldThrottle(seconds: number): void {
        this.inner.yieldThrottle?.(seconds);
    }

    // -- internal ------------------------------------------------------

    /**
     * Clears everything about the current drive — route, plan verdicts, the
     * final-handoff decision, the replan-failure window and the watchdog
     * clock — back to its constructed default. Shared by `driveTo` (which
     * then installs the new nav/destination/vias) and `stop`, so a field
     * added to one can never be forgotten on the other.
     */
    private resetDriveState(): void {
        this.nav = null;
        this.destination = null;
        this.vias = [];
        this.viaArcs = [];
        this.directTarget = null;
        this.pathPoints = null;
        this.pathCumulative = null;
        this.provisional = false;
        this.plannedRevision = 0;
        this.lastS = 0;
        this.handoffDone = false;
        this.planReachedDestination = true;
        this.beelineDecided = false;
        this.beelineAllowed = true;
        this.finalTarget = null;
        this.replans = 0;
        this.replanFailureCount = 0;
        this.replanFailureAnchors = [];
        this.prevFailedRecoveries = 0;
        this.prevUnreachable = false;
        this.queryOpts = null;
        this.lastPursuitPoint = null;
        this.stallWindows = 0;
        this.unreachableSinceTriggerS = UNREACHABLE_RETRIGGER_S;
        this.resetStallWindow();
    }

    private capabilityOptsFor(vehicle: Vehicle): VehicleNavQueryOptions {
        return vehicleHasNavCapabilities(vehicle)
            ? queryOptionsForVehicle(vehicle)
            : DEFAULT_VEHICLE_NAV_QUERY_OPTIONS;
    }

    private plan(vehicle: Vehicle): void {
        if (!this.nav) {
            this.pathPoints = null;
            this.pathCumulative = null;
            this.handoffDone = true;
            this.activity = 'driving';
            return;
        }
        const pos = vehicle.getPosition();
        const opts = this.capabilityOptsFor(vehicle);
        this.queryOpts = opts;
        const { result, viaArcs } = planRouteWithVias(this.nav, { x: pos.x, z: pos.z }, this.vias, this.destination!, opts);
        if (result.points.length === 0) {
            // Honest failure: no fallback, no partial credit. The game reads
            // getStatus() and decides what to do about a car that cannot
            // reach its destination at all.
            this.activity = 'blocked';
            this.inner.stop();
            return;
        }
        this.setPathFromResult(result, viaArcs);
        this.activity = 'driving';
    }

    private setPathFromResult(result: VehicleNavPath, viaArcs: number[] = []): void {
        this.pathPoints = result.points;
        this.pathCumulative = buildArcLengthTable(result.points);
        this.viaArcs = viaArcs;
        this.provisional = result.provisional;
        this.plannedRevision = this.nav ? this.nav.getRevision() : 0;
        this.lastS = 0;
        this.handoffDone = false;
        // Keep the plan's own verdict on whether it reached the true
        // destination — drives the final-handoff decision in
        // `driveAlongPath`'s `reachedEnd` branch. Re-decide (not reuse) the
        // beeline-vs-park-at-path-end choice for THIS plan: a replan is a
        // fresh attempt with a fresh path, so a stale decision from a
        // previous (possibly now-irrelevant) plan must not carry over.
        this.planReachedDestination = result.reachedDestination;
        this.beelineDecided = false;
        this.beelineAllowed = true;
        this.finalTarget = null;
        this.resetStallWindow();
    }

    private maybeCompleteArrival(vehicle: Vehicle): void {
        if (!this.handoffDone || this.destination === null) return;
        // finalTarget is set by driveAlongPath's reachedEnd branch (the true
        // destination when beelining, otherwise the reachable path end); it
        // stays null for the nav-less (nav === null) case, which aims
        // straight at this.destination itself — see update()'s branch for
        // that case.
        const target = this.finalTarget ?? this.destination;
        const arriveRadius = this.options.driving.arriveRadius;
        if (this.inner.isNear(target.x, target.z, arriveRadius)) {
            this.activity = 'arrived';
            vehicle.setParkingBrake(true);
            this.onArrivedCb?.();
            this.resetStallWindow();
        }
    }

    /** Fix B: re-anchors the stall-progress window at the CURRENT `s` and zeros its elapsed timer. */
    private resetStallWindow(): void {
        this.stallWindowAnchorS = this.lastS;
        this.stallWindowElapsedS = 0;
    }

    /**
     * Shared by the recovery-gated trigger (inner-reported failure/flip) and
     * the stall watchdog (Fix B, arc-progress-based): probe toward the
     * current pursuit point. Passable means a transient wedge — return false,
     * let the inner's own recovery run its course. Not passable (missing probe
     * capability or blocked path), or no pursuit point to probe toward at all,
     * means assume blocked — replan (feeding the existing failure/blocked latch
     * in `replan()`) and return true.
     */
    private probeTowardPursuitOrReplan(vehicle: Vehicle, pos: NavPoint): boolean {
        const target = this.lastPursuitPoint;
        const passable = target !== null
            && vehicleSupportsProbePath(vehicle)
            && vehicle.probePath(pos.x, pos.z, target.x, target.z).passable;
        if (passable) return false;
        this.replan(vehicle);
        return true;
    }

    /**
     * Steps 1-4: project, replan-on-off-path, and aim the inner (pursuit
     * target + corner-slowdown cruise override). Returns true when it
     * replanned (off-path) this frame, so the caller skips `afterInnerUpdate`
     * — that replan already re-read the freshest state there is to read.
     */
    private driveAlongPath(vehicle: Vehicle): boolean {
        const points = this.pathPoints!;
        const cumulative = this.pathCumulative!;
        const pos = vehicle.getPosition();
        const speed = Math.max(0, vehicle.getSpeed());

        const lookAhead = clampNum(
            this.options.lookAheadBaseM + this.options.lookAheadPerSpeed * speed,
            this.options.lookAheadMinM,
            this.options.lookAheadMaxM,
        );

        // Window sized off offPathReplanFactor: it must stay wide enough
        // that a car right at the off-path replan threshold still finds a
        // legitimate projection (rather than falling through to the "found
        // nothing, snap to path end" fallback) — see projectOntoPath's doc
        // for why the window exists at all.
        const windowM = Math.max(lookAhead * (this.options.offPathReplanFactor + 1), this.options.lookAheadMaxM);
        const projection = projectOntoPath(points, cumulative, this.lastS, pos.x, pos.z, windowM);
        this.lastS = projection.s;
        this.consumePassedVias();

        if (projection.distance > this.options.offPathReplanFactor * lookAhead) {
            this.replan(vehicle);
            return true;
        }

        const maxArc = cumulative[cumulative.length - 1] ?? 0;
        // Arc-length look-ahead first, then pushed further along the path if
        // that point is too close in a STRAIGHT LINE for the inner to treat as
        // something to drive at — see `advanceToClearArc`. On ordinary road the
        // first candidate already clears the radius and this changes nothing.
        // Read the CLAMPED inner radius (innerArriveRadius), not
        // options.driving.arriveRadius — the inner BasicDrivingComponent was
        // actually constructed with the clamped value, and that is what its
        // unconditional arrival branch tests against. See
        // INTERMEDIATE_ARRIVE_RADIUS_M's doc.
        const clearance = this.innerArriveRadius + PURSUIT_ARRIVE_CLEARANCE_M;
        const clearedS = advanceToClearArc(
            points, cumulative, Math.min(maxArc, this.lastS + lookAhead), pos.x, pos.z, clearance,
        );
        const reachedEnd = this.lastS + lookAhead >= maxArc;

        // `clearedS === null` — no point on the rest of the path is far
        // enough away — counts as reaching the end too: either way the car is
        // effectively at the end of its route, so hand off to the final
        // target and let the inner's real arrival easing take over.
        if (reachedEnd || clearedS === null) {
            // Final-handoff decision, made ONCE per plan (see
            // beelineDecided/setPathFromResult): beelining at the TRUE
            // destination with isFinal=true is a plain straight line with NO
            // path guidance at all. That is fine when the plan actually
            // reached the destination (the gap is just the small handoff
            // shortfall a real route would cover anyway) — but for a
            // best-effort plan (planReachedDestination === false) it means
            // driving unguided straight at a point the planner already
            // couldn't route to, into whatever blocked the rest of the
            // route. Measured live: a car did exactly this and wedged
            // against real CELL_PROP_BLOCKED geometry 8 m short of the
            // destination while the path centreline itself stayed clear
            // (corner-cut-diagnosis.md's follow-up probe). A one-time
            // `probePath` gives the plan a second chance — the grid may have
            // since been baked further, or the "best-effort" verdict may
            // have been conservative — but short of either check passing,
            // the honest final target is the reachable PATH END: the car
            // parks there instead of driving into an obstruction.
            if (!this.beelineDecided) {
                this.beelineDecided = true;
                this.beelineAllowed = this.planReachedDestination
                    || (vehicleSupportsProbePath(vehicle)
                        && vehicle.probePath(pos.x, pos.z, this.destination!.x, this.destination!.z).passable);
            }
            const finalTarget = this.beelineAllowed ? this.destination! : pointAtArc(points, cumulative, maxArc);
            this.handoffDone = true;
            this.finalTarget = finalTarget;
            this.lastPursuitPoint = finalTarget;
            this.inner.setTarget(finalTarget.x, finalTarget.z, true);
            this.inner.setCruiseOverride(null);
        } else {
            const pursuitPoint = pointAtArc(points, cumulative, clearedS);
            this.lastPursuitPoint = pursuitPoint;
            this.inner.setTarget(pursuitPoint.x, pursuitPoint.z, false);

            // Plausible stopping distance at maxLateralAccel as a braking-
            // equivalent decel, floored at lookAhead so a near-stationary car
            // still samples a sane span ahead instead of curvature over a
            // near-zero window. Deliberately simple — see the class doc.
            const decel = Math.max(this.options.maxLateralAccelMps2, 1e-3);
            const stoppingDistance = Math.max(lookAhead, (speed * speed) / (2 * decel));
            const curvature = curvatureAt(points, cumulative, this.lastS, stoppingDistance);
            // Floored at MIN_CORNER_SPEED_MPS — see that constant's doc for
            // why a near-zero commanded speed is worse than no floor at all
            // (it reads as "achieved" while the car sits wedged, so neither
            // the inner's recovery nor the stall watchdog ever arms).
            const cornerSpeed = Math.max(
                Math.sqrt(this.options.maxLateralAccelMps2 / Math.max(curvature, 1e-4)),
                MIN_CORNER_SPEED_MPS,
            );
            // A straight road's curvature is ~0, so cornerSpeed comes out
            // huge — the min() inside targetSpeedFor ignores it naturally,
            // no separate "on a straight" branch needed.
            this.inner.setCruiseOverride(cornerSpeed);
        }
        return false;
    }

    /**
     * Steps 5-6, run AFTER `inner.update()` for this same frame (see the
     * call site in `update()` for why the ordering matters): the recovery-
     * gated probe, the arc-progress stall watchdog (Fix B), then the
     * provisional-upgrade and post-bake-revision replan triggers.
     */
    private afterInnerUpdate(deltaTime: number, vehicle: Vehicle): void {
        const pos = vehicle.getPosition();

        // Recovery-gated probe: only look at NEW failures/flips this frame,
        // not the steady-state "still recovering" condition, or a single
        // wedge would re-probe (and potentially re-replan) every frame.
        //
        // `unreachable` is the exception, and needs a cooldown rather than a
        // pure edge: unlike `failedRecoveries` (which keeps climbing as the
        // inner retries) it latches true and stays true, so as a one-shot it
        // fires once per drive and then goes quiet for good — measured on a
        // car that sat `unreachable` for 72 s after its single trigger. See
        // UNREACHABLE_RETRIGGER_S.
        const status = this.inner.getDrivingStatus();
        this.unreachableSinceTriggerS += deltaTime;
        const unreachableTriggered = status.unreachable
            && (!this.prevUnreachable || this.unreachableSinceTriggerS >= UNREACHABLE_RETRIGGER_S);
        if (unreachableTriggered) this.unreachableSinceTriggerS = 0;
        if (!status.unreachable) this.unreachableSinceTriggerS = UNREACHABLE_RETRIGGER_S;

        const newFailedRecovery = status.failedRecoveries > this.prevFailedRecoveries;
        const recoveryTriggered = newFailedRecovery || unreachableTriggered;
        this.prevFailedRecoveries = status.failedRecoveries;
        this.prevUnreachable = status.unreachable;

        if (recoveryTriggered && this.lastPursuitPoint) {
            if (this.probeTowardPursuitOrReplan(vehicle, pos)) return;
            // Passable: a transient wedge, not a blocked road — let the
            // inner's own reverse-burst recovery run its course. Reset the
            // stall window too, so a wedge the inner is actively working on
            // does not immediately also trip the OUTER watchdog below.
            //
            // ONLY for a new reverse burst, though. A standing `unreachable`
            // is a complaint, not work in progress: re-anchoring the window
            // for it starves the outer watchdog of the very thing it
            // measures, and since the two run on comparable cadences that
            // reliably deadlocks the escalation the watchdog exists to drive.
            if (newFailedRecovery) this.resetStallWindow();
        }

        if (this.updateStallWatchdog(deltaTime, vehicle, pos)) return;

        // Both remaining replan triggers require a finished bake. Do NOT
        // replan on a revision bump while the bake is still running — the
        // bake bumps the revision on nearly every frame it makes progress (a
        // live run reached revision 157 mid-bake), so this gate is
        // load-bearing, not a nice-to-have.
        if (!this.nav!.isFullyBaked()) return;

        // Either the plan answered before the collider bake finished (a
        // one-time upgrade: re-plan against real data now that it has), or a
        // real post-bake edit — a ground-type change, a prop moving — bumped
        // the revision out from under it.
        if (this.provisional || this.nav!.getRevision() !== this.plannedRevision) {
            this.replan(vehicle);
        }
    }

    /**
     * Fix B: arc-progress stall detector. The inner `BasicDrivingComponent`'s
     * own `failedRecoveries`/`unreachable` latch is driven by watching a
     * STABLE `setTarget()` call sit unmet over time — but `driveAlongPath`
     * re-aims the inner at a moving look-ahead point EVERY frame while
     * following a path, so from the inner's perspective the target never
     * holds still long enough for its own watchdog to trip. Measured live: a
     * car wedged dead against a kerb, invisible to the inner, with
     * `failedRecoveries` at 0 for the entire 150s of a stuck drive (see
     * task-8-fix-report.md). This tracks PATH PROGRESS instead — the one
     * signal that is honest regardless of how the pursuit target moves: if
     * the path projection `s` fails to advance by `stallProgressEpsilonM`
     * within any `stallWindowS` window, the car is stuck, full stop.
     *
     * Returns true when it replanned this frame (mirrors
     * `probeTowardPursuitOrReplan`'s own signal), so the caller can skip the
     * provisional/revision replan checks that follow — they would just be
     * reading state this same call already acted on.
     */
    private updateStallWatchdog(deltaTime: number, vehicle: Vehicle, pos: NavPoint): boolean {
        if (this.lastS - this.stallWindowAnchorS >= this.options.stallProgressEpsilonM) {
            // The only thing that clears the escalation: the car actually
            // covered ground. Note a replan deliberately does NOT — see
            // `stallWindows`.
            this.stallWindows = 0;
            this.resetStallWindow();
            return false;
        }
        this.stallWindowElapsedS += deltaTime;
        if (this.stallWindowElapsedS < this.options.stallWindowS) return false;

        this.stallWindows += 1;
        this.resetStallWindow();

        // Escalation, in windows of no arc progress at all:
        //
        //   1 .. STALL_DEFER_LIMIT      ask the probe (a wedge may be transient)
        //   .. STALL_BLOCKED_LIMIT      replan regardless of what the probe says
        //   beyond                      give up and say so
        if (this.stallWindows > STALL_BLOCKED_LIMIT) {
            // Nothing left to try: the probe was asked, replans were forced,
            // and the car has still not moved. Reporting 'blocked' is the
            // whole point — a game can tell the player, pick another
            // destination, or teleport; it cannot do any of that while the
            // follower keeps claiming to be driving.
            this.activity = 'blocked';
            this.inner.stop();
            return true;
        }
        if (this.stallWindows > STALL_DEFER_LIMIT) {
            this.replan(vehicle);
            return true;
        }

        // Reuse the exact same recovery-gated decision the inner's own
        // failure signal drives above — probe toward the current pursuit
        // point; passable means a transient wedge (trust the inner), not
        // passable (or no probe support) means replan.
        return this.probeTowardPursuitOrReplan(vehicle, pos);
    }

    /**
     * Drops any vias whose recorded arc position (`this.viaArcs`, kept
     * parallel to `this.vias`) the car's path projection has already
     * passed — see `DriveToOptions`' doc. Called every frame while
     * following a path, right after `this.lastS` is refreshed from the
     * latest projection, so `replan()` (which reads `this.vias`) always
     * plans through only what's genuinely still ahead of the car — a
     * replan can never loop back through a via already behind it. Both
     * arrays are monotonically increasing in arc position by construction
     * (`planRouteWithVias` builds `viaArcs` off the same cumulative arc
     * table as the path itself, in via order), so only the FRONT can ever
     * need dropping.
     */
    private consumePassedVias(): void {
        while (this.viaArcs.length > 0 && this.lastS + VIA_CONSUMPTION_EPSILON_M >= this.viaArcs[0]!) {
            this.viaArcs.shift();
            this.vias.shift();
        }
    }

    private replan(vehicle: Vehicle): void {
        if (!this.nav || !this.destination) {
            this.activity = 'blocked';
            this.inner.stop();
            return;
        }
        this.replans += 1;
        const pos = vehicle.getPosition();
        const startPos: NavPoint = { x: pos.x, z: pos.z };
        const opts = this.queryOpts ?? this.capabilityOptsFor(vehicle);
        const { result, viaArcs } = planRouteWithVias(this.nav, startPos, this.vias, this.destination, opts);

        // A replan "fails to improve" when it finds nothing, or when it
        // finds something but starts within ~10m of ANY anchor in the
        // current failure window — going in circles among a small set of
        // spots, not making progress by trying again. Checking the WHOLE
        // window (not just the immediately-preceding replan) matters: a car
        // oscillating between two spots >10m apart would otherwise have
        // every replan read as "improved" relative to the last one alone,
        // never latching — see replanFailureAnchors' doc.
        const failedToImprove = result.points.length === 0
            || this.replanFailureAnchors.some((anchor) => dist2D(result.points[0]!, anchor) < 10);

        if (failedToImprove) {
            this.replanFailureAnchors.push(startPos);
            if (this.replanFailureAnchors.length > this.options.replanFailureLimit) {
                this.replanFailureAnchors.shift(); // cap the window at replanFailureLimit entries
            }
            this.replanFailureCount += 1;
            if (this.replanFailureCount >= this.options.replanFailureLimit) {
                this.activity = 'blocked';
                this.inner.stop();
            }
            // Below the limit: keep the existing (stale) path/state as-is
            // and try again next frame the same trigger condition holds —
            // deliberately no separate retry timer here. Reset the stall
            // window regardless (Fix B): we just took action, so a fresh
            // full window before flagging stalled again avoids the stall
            // watchdog and this failure counter fighting over the same clock.
            this.resetStallWindow();
            return;
        }

        this.replanFailureCount = 0;
        this.replanFailureAnchors = [];
        this.setPathFromResult(result, viaArcs);
    }
}
