import type { Vehicle } from 'engine/Vehicle.js';
import type { PlayerController } from 'engine/PlayerController.js';
import {
    VehicleAutoRightSystem,
    DEFAULT_VEHICLE_AUTO_RIGHT_OPTIONS,
    type VehicleAutoRightOptions,
} from 'engine/VehicleAutoRightSystem.js';
import {
    VehicleUnstuckSystem,
    DEFAULT_VEHICLE_UNSTUCK_OPTIONS,
    type VehicleUnstuckOptions,
} from 'engine/VehicleUnstuckSystem.js';
import {
    VehicleStuckSystem,
    DEFAULT_VEHICLE_STUCK_OPTIONS,
    type VehicleStuckOptions,
    type VehicleRespawnProvider,
} from 'engine/VehicleStuckSystem.js';
import {
    VehicleRouteRecoverySystem,
    DEFAULT_VEHICLE_ROUTE_RECOVERY_OPTIONS,
    type VehicleRouteRecoveryOptions,
    type VehicleRouteRegistration,
} from 'engine/VehicleRouteRecovery.js';

/**
 * The vehicle safety systems every physics-car game needs, independent of
 * genre: auto-righting a flipped car, splitting welded car-to-car pairs, and
 * freeing a car wedged on scenery.
 *
 * These used to live inside `RacingSetup`, reachable only through
 * `installRacingDefaults()` — which also locks vehicle exit and forces
 * free-mouse mode. A chauffeur, delivery or open-world driving game cannot
 * accept those input/UI defaults, so it ended up reimplementing recovery by
 * hand. `RacingSetup` now wraps this bundle and adds the racing defaults on
 * top; its public API is unchanged.
 */

export interface VehicleSafetyOptions {
    autoRight: VehicleAutoRightOptions;
    unstuck: VehicleUnstuckOptions;
    /** Frees a car wedged on scenery (throttle up, going nowhere). */
    stuck: VehicleStuckOptions;
    /**
     * Tuning for the route/centerline fallback (see `VehicleRouteRecovery`).
     * Optional so every shipped game that builds this options object by hand
     * still type-checks; omitted means `DEFAULT_VEHICLE_ROUTE_RECOVERY_OPTIONS`.
     * It stays inert until a vehicle is registered WITH a route provider.
     */
    route?: VehicleRouteRecoveryOptions;
}

export const DEFAULT_VEHICLE_SAFETY_OPTIONS: VehicleSafetyOptions = {
    autoRight: DEFAULT_VEHICLE_AUTO_RIGHT_OPTIONS,
    unstuck: DEFAULT_VEHICLE_UNSTUCK_OPTIONS,
    stuck: DEFAULT_VEHICLE_STUCK_OPTIONS,
    route: DEFAULT_VEHICLE_ROUTE_RECOVERY_OPTIONS,
};

export class VehicleSafetySystems {
    private autoRight: VehicleAutoRightSystem;
    private unstuck: VehicleUnstuckSystem;
    private stuck: VehicleStuckSystem;
    private route: VehicleRouteRecoverySystem;

    /** The game's own respawn point, behind the route fallback. See `setRespawnProvider`. */
    private gameRespawnProvider: VehicleRespawnProvider | null = null;

    /**
     * Optional so the constructor stays compatible with games that already
     * ship `new VehicleSafetySystems(opts)`. Pass it — `installVehicleSafety()`
     * and `installRacingDefaults()` do — and the respawn provider also covers
     * falling off the map, not just being wedged on scenery.
     */
    private readonly playerController: PlayerController | null;

    constructor(opts: VehicleSafetyOptions, playerController: PlayerController | null = null) {
        this.playerController = playerController;
        this.autoRight = new VehicleAutoRightSystem(opts.autoRight);
        // After a welded pair is split, tell whichever car was driving INTO the
        // other to lift for a moment. Without this the engine bump only buys a
        // second: an AI with the throttle pinned at a slower car's bumper
        // catches up and re-welds immediately — players see AI cars touring in
        // stuck pairs. A human lifts and backs off after a shunt; the AI must
        // get the same reflex. Any game-supplied onSeparated still runs.
        this.unstuck = new VehicleUnstuckSystem({
            ...opts.unstuck,
            onSeparated: (event) => {
                opts.unstuck.onSeparated?.(event);
                VehicleSafetySystems.yieldIfRamming(event.vehicleA, event.vehicleB);
                VehicleSafetySystems.yieldIfRamming(event.vehicleB, event.vehicleA);
            },
        });
        this.stuck = new VehicleStuckSystem(opts.stuck);
        this.route = new VehicleRouteRecoverySystem(opts.route ?? DEFAULT_VEHICLE_ROUTE_RECOVERY_OPTIONS);
        // Bounded local recovery first, route rejoin only once it has failed.
        // Installed unconditionally: with no route-registered vehicles this
        // resolves to exactly the game's own provider (or null), so a game that
        // never opts in sees the pre-existing behaviour.
        this.stuck.setRespawnProvider((v) => this.resolveRespawn(v));
    }

    /**
     * `VehicleStuckSystem` has run out of nudges. Prefer putting a route-driven
     * AI back on its own racing line — the game's checkpoint respawn is a fine
     * position but says nothing about the follower's progress, which is exactly
     * how a rescued rival ends up driving away from the track.
     */
    private resolveRespawn(vehicle: Vehicle): ReturnType<VehicleRespawnProvider> {
        const plan = this.route.planRejoin(vehicle);
        if (plan) {
            // The stuck system does the teleport itself from what we return, so
            // only the follower resynchronisation is ours to do here.
            this.route.resumeAt(vehicle, plan);
            return { position: plan.position, heading: plan.heading };
        }
        return this.gameRespawnProvider?.(vehicle) ?? null;
    }

    /** How long the ramming car's AI coasts after a separation (s). Long enough
     *  for a genuine gap to open, short enough to read as a lift, not a stop. */
    private static readonly RAMMER_YIELD_SECONDS = 1.2;

    /** Facing the other car (forward within ~66° of the line to it) = the rammer. */
    private static readonly RAMMING_DOT_THRESHOLD = 0.4;

    /** Coast `self`'s AI briefly if it was the one driving into `other`. */
    private static yieldIfRamming(self: Vehicle, other: Vehicle): void {
        const driver = self.getDrivingComponent();
        if (!driver?.yieldThrottle) return; // player car or custom AI without the hook
        const sp = self.getPosition();
        const op = other.getPosition();
        const dx = op.x - sp.x;
        const dz = op.z - sp.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 1e-3) return;
        const fwd = self.getForwardDirection();
        const facing = (fwd.x * dx + fwd.z * dz) / dist;
        if (facing > VehicleSafetySystems.RAMMING_DOT_THRESHOLD) {
            driver.yieldThrottle(VehicleSafetySystems.RAMMER_YIELD_SECONDS);
        }
    }

    /**
     * `route` is optional and only meaningful for an AI vehicle: give it the
     * centerline the car is following and the bundle gains a route-aware
     * fallback — off the corridor for too long, or nudges exhausted, and the
     * car is put back on a forward centerline point facing down the track with
     * its driving component re-aimed. Registering without it is unchanged
     * behaviour, and re-registering without it keeps any route already set.
     */
    register(vehicle: Vehicle, route?: VehicleRouteRegistration): void {
        this.autoRight.register(vehicle);
        this.unstuck.register(vehicle);
        this.stuck.register(vehicle);
        if (route) this.route.register(vehicle, route);
    }

    unregister(vehicle: Vehicle): void {
        this.autoRight.unregister(vehicle);
        this.unstuck.unregister(vehicle);
        this.stuck.unregister(vehicle);
        this.route.unregister(vehicle);
    }

    /**
     * Suspend the stuck detectors while the game deliberately holds cars still —
     * above all a start-line countdown, where "throttle held, car not moving,
     * bumper to bumper with the car in front" is exactly what being stuck looks
     * like. Covers both the wedged-on-scenery and the car-to-car detector. Call
     * `false` for the count and `true` on GO.
     */
    setStuckDetectionEnabled(enabled: boolean): void {
        this.stuck.setEnabled(enabled);
        this.unstuck.setEnabled(enabled);
        // A starting grid sits a lane-width off the centerline on purpose, so
        // the corridor watch has to be gated by the same call.
        this.route.setEnabled(enabled);
    }

    /**
     * Where to put a car the game can't recover in place — in a lap race, the
     * last checkpoint. Covers both a car that nudging can't free (without a
     * provider the system just keeps nudging) and a car that fell off the map
     * (without a provider the player is ejected and the car destroyed).
     *
     * A vehicle registered with a route provider rejoins its centerline
     * instead; this stays the answer for every other car, and for that one too
     * whenever its route is unavailable.
     */
    setRespawnProvider(provider: VehicleRespawnProvider | null): void {
        this.gameRespawnProvider = provider;
        this.playerController?.setVehicleRespawnProvider(provider);
    }

    /** The route-recovery system, for games that want to force a rejoin themselves. */
    getRouteRecovery(): VehicleRouteRecoverySystem { return this.route; }

    update(deltaTime: number): void {
        this.autoRight.update(deltaTime);
        this.unstuck.update(deltaTime);
        this.stuck.update(deltaTime);
        this.route.update(deltaTime);
    }
}

/**
 * Create the vehicle safety bundle for a non-racing driving game. Register
 * every spawned vehicle and call `update(dt)` each frame. Racing games should
 * call `installRacingDefaults()` instead, which adds this plus the racing
 * input and UI defaults.
 *
 * Pass the `PlayerController` so `setRespawnProvider()` also covers the
 * player's car falling off the map.
 */
export function installVehicleSafety(
    options: VehicleSafetyOptions,
    playerController: PlayerController | null = null,
): VehicleSafetySystems {
    return new VehicleSafetySystems(options, playerController);
}
