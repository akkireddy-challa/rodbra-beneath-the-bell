import type { Vehicle } from 'engine/Vehicle.js';
import type { CenterlinePoint } from 'engine/TrackCenterline.js';
import { headingToward } from 'engine/VehicleHeading.js';

/**
 * Route-aware recovery for AI vehicles that follow a fixed line — a race
 * track centerline, a patrol loop, a rally stage.
 *
 * `VehicleStuckSystem` recovers a car IN PLACE (nudge, then a game-supplied
 * respawn point). That is the right first move, but it knows nothing about
 * where the car was supposed to be going: a rival shunted over a shortcut wall
 * lands upright, on solid ground, with a clear throttle — and drives away from
 * the track forever, because its pursuit target is still the waypoint it can no
 * longer reach. Every racing game then reimplements "put it back on the line"
 * in generated template code, usually incompletely (position without heading,
 * or heading without telling the follower its progress moved).
 *
 * This is that fallback, once, in the engine. Given a route provider it:
 *
 *   1. picks the nearest centerline point at or AHEAD of the car's own
 *      recorded progress — never behind it, so recovery can't hand back a lap
 *      or bounce the car between two points,
 *   2. places the car there with `teleportTo` (which zeroes linear and angular
 *      velocity), facing the NEXT point via `headingToward`,
 *   3. re-aims the driving component at that next point and tells the game
 *      which index the car rejoined at, so its own lap/progress bookkeeping
 *      follows instead of silently disagreeing.
 *
 * It fires from two places, both bounded: after `VehicleStuckSystem` exhausts
 * its nudges (see `VehicleSafetySystems`), and after a registered AI has been
 * outside the route corridor continuously for `offRouteGraceSeconds` — long
 * enough that cutting a corner, running wide or a spin that recovers on its own
 * never trips it.
 *
 * Registering is opt-in per vehicle: a car with no route provider behaves
 * exactly as it did before this existed.
 */

/** The route an AI vehicle is meant to be on, as the game already knows it. */
export interface VehicleRouteState {
    /**
     * Ordered centerline in travel direction — a `getTrackCenterline()` loop,
     * or a hand-authored waypoint chain. Needs at least two points.
     */
    points: ReadonlyArray<CenterlinePoint>;
    /** Index the AI is currently driving toward: its own progress along `points`. */
    targetIndex: number;
    /** `points` wraps back to 0 (a lap) rather than ending (a point-to-point stage). */
    loop: boolean;
    /**
     * How far off the centerline (m) still counts as being on the route.
     * Use the track's painted half-width — anything narrower rescues cars that
     * are merely taking a wide line.
     */
    corridorHalfWidth: number;
}

/** The route for a registered AI vehicle, or null when it has none right now. */
export type VehicleRouteProvider = (vehicle: Vehicle) => VehicleRouteState | null;

/** What a vehicle hands the engine when it opts into route recovery. */
export interface VehicleRouteRegistration {
    route: VehicleRouteProvider;
    /**
     * Told which centerline index the vehicle was put back on. Optional, but
     * a game that tracks lap/position from its own waypoint index should use
     * it — otherwise engine and game disagree about where the car is until it
     * next drifts back into range on its own.
     */
    onRejoined?: (vehicle: Vehicle, index: number) => void;
}

/** Where a vehicle should rejoin its route, and how far off it currently is. */
export interface VehicleRejoinPlan {
    /** Centerline index the car rejoins at. */
    index: number;
    /** World position to place the car at (centerline point, lifted by `dropHeight`). */
    position: { x: number; y: number; z: number };
    /** Gameplay yaw (+Z forward) facing the next centerline point. */
    heading: number;
    /** Current XZ distance from the car to `points[index]` (m). */
    distance: number;
}

export interface VehicleRouteRecoveryOptions {
    /** Seconds outside the corridor before a registered AI is put back on the line. */
    offRouteGraceSeconds: number;
    /**
     * How many centerline points ahead of the car's recorded progress the
     * rejoin search looks. A window, not the whole loop, so a car sitting near
     * the start line can't be teleported to the far side of the track.
     */
    searchAhead: number;
    /** Height above the centerline point the car is dropped from (m). */
    dropHeight: number;
    /** Log each rejoin. Off by default — this fires mid-race. */
    debugLog: boolean;
}

export const DEFAULT_VEHICLE_ROUTE_RECOVERY_OPTIONS: VehicleRouteRecoveryOptions = {
    offRouteGraceSeconds: 3,
    searchAhead: 12,
    dropHeight: 1,
    debugLog: false,
};

export class VehicleRouteRecoverySystem {
    private readonly opts: VehicleRouteRecoveryOptions;
    private readonly routes: Map<Vehicle, VehicleRouteRegistration> = new Map();
    private readonly offRouteSeconds: Map<Vehicle, number> = new Map();
    private enabled = true;

    constructor(opts: VehicleRouteRecoveryOptions) {
        this.opts = opts;
    }

    register(vehicle: Vehicle, registration: VehicleRouteRegistration): void {
        this.routes.set(vehicle, registration);
    }

    unregister(vehicle: Vehicle): void {
        this.routes.delete(vehicle);
        this.offRouteSeconds.delete(vehicle);
    }

    /** True when this vehicle has a route provider — i.e. route recovery applies to it. */
    has(vehicle: Vehicle): boolean {
        return this.routes.has(vehicle);
    }

    /**
     * Suspend/resume the corridor watch. Turn it OFF for the same reasons as
     * the stuck detectors: a starting grid sits a lane-width off the centerline
     * on purpose, and a countdown holds it there. Suspending clears accumulated
     * off-route time so the grace period restarts cleanly.
     */
    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
        if (!enabled) this.offRouteSeconds.clear();
    }

    /**
     * Where `vehicle` should rejoin its route, or null when it has no provider,
     * no usable route, or no driving component to hand back to.
     *
     * Pure apart from calling the game's provider: nothing moves until
     * `recover()` (or `VehicleSafetySystems`' respawn fallback) acts on it.
     */
    planRejoin(vehicle: Vehicle): VehicleRejoinPlan | null {
        const registration = this.routes.get(vehicle);
        if (!registration) return null;
        const state = registration.route(vehicle);
        if (!state) return null;
        const n = state.points.length;
        if (n < 2) return null;

        const pos = vehicle.getPosition();
        const anchor = ((Math.trunc(state.targetIndex) % n) + n) % n;
        // Forward-only window: the car may be put back where it already is, or
        // further along, never behind. A backward jump would replay track the
        // car has driven and, on a lap counter keyed to this index, silently
        // undo a lap.
        const span = Math.min(Math.max(this.opts.searchAhead, 0), n - 1);
        let index = anchor;
        let bestDistSq = Infinity;
        for (let offset = 0; offset <= span; offset++) {
            const i = state.loop ? (anchor + offset) % n : Math.min(anchor + offset, n - 1);
            const p = state.points[i]!;
            const dx = p.x - pos.x;
            const dz = p.z - pos.z;
            const dSq = dx * dx + dz * dz;
            if (dSq < bestDistSq) { bestDistSq = dSq; index = i; }
        }

        const point = state.points[index]!;
        const next = state.loop ? state.points[(index + 1) % n]! : state.points[index + 1];
        // Past the last point of an open route there is no "next" to face, so
        // keep running the direction the final leg came in on.
        const heading = next
            ? headingToward(point, next)
            : headingToward(state.points[index - 1]!, point);

        return {
            index,
            position: { x: point.x, y: point.y + this.opts.dropHeight, z: point.z },
            heading,
            distance: Math.sqrt(bestDistSq),
        };
    }

    /**
     * Bring the driving component (and the game's own progress) in line with a
     * plan the car has just been PLACED at. Split out from `recover()` because
     * `VehicleStuckSystem` performs its own teleport from the respawn provider
     * — the placement happens there, the resynchronisation still happens here.
     */
    resumeAt(vehicle: Vehicle, plan: VehicleRejoinPlan): void {
        const registration = this.routes.get(vehicle);
        if (!registration) return;
        const state = registration.route(vehicle);
        if (state && state.points.length >= 2) {
            const n = state.points.length;
            const aimIndex = state.loop ? (plan.index + 1) % n : Math.min(plan.index + 1, n - 1);
            const aim = state.points[aimIndex]!;
            // `false`: an intermediate waypoint, not the destination — otherwise
            // BasicDrivingComponent eases to a crawl on every rejoin.
            vehicle.getDrivingComponent()?.setTarget(aim.x, aim.z, false);
        }
        this.offRouteSeconds.delete(vehicle);
        registration.onRejoined?.(vehicle, plan.index);
        if (this.opts.debugLog) {
            console.log(`[VehicleRouteRecovery] rejoined route at waypoint ${plan.index}`);
        }
    }

    /** Place `vehicle` back on its route and resynchronise it. False when it has no usable route. */
    recover(vehicle: Vehicle): boolean {
        const plan = this.planRejoin(vehicle);
        if (!plan) return false;
        // teleportTo zeroes linear and angular velocity, so the car arrives
        // stopped and pointing down the track rather than carrying the momentum
        // that took it off in the first place.
        vehicle.teleportTo(plan.position, plan.heading);
        this.resumeAt(vehicle, plan);
        return true;
    }

    /** Corridor watch. Call once per frame from the safety bundle. */
    update(deltaTime: number): void {
        if (!this.enabled) return;

        for (const [vehicle, registration] of this.routes) {
            const body = vehicle.getChassisBody();
            if (!body || !body.isValid()) continue;
            // AI only. A route registered against the player's car must never
            // yank them back onto the racing line for taking a wide entry.
            if (!vehicle.getDrivingComponent()) continue;

            const state = registration.route(vehicle);
            const plan = state ? this.planRejoin(vehicle) : null;
            if (!state || !plan || plan.distance <= state.corridorHalfWidth) {
                this.offRouteSeconds.delete(vehicle);
                continue;
            }

            const elapsed = (this.offRouteSeconds.get(vehicle) ?? 0) + deltaTime;
            if (elapsed < this.opts.offRouteGraceSeconds) {
                this.offRouteSeconds.set(vehicle, elapsed);
                continue;
            }

            vehicle.teleportTo(plan.position, plan.heading);
            this.resumeAt(vehicle, plan);
        }
    }
}
