import type { GameEngine } from 'engine/GameEngine.js';
import type { PlayerController } from 'engine/PlayerController.js';
import type { Vehicle } from 'engine/Vehicle.js';
import { VehicleSafetySystems } from 'engine/VehicleSafetySystems.js';
import {
    DEFAULT_VEHICLE_AUTO_RIGHT_OPTIONS,
    type VehicleAutoRightOptions,
} from 'engine/VehicleAutoRightSystem.js';
import {
    DEFAULT_VEHICLE_UNSTUCK_OPTIONS,
    type VehicleUnstuckOptions,
} from 'engine/VehicleUnstuckSystem.js';
import {
    DEFAULT_VEHICLE_STUCK_OPTIONS,
    type VehicleStuckOptions,
    type VehicleRespawnProvider,
} from 'engine/VehicleStuckSystem.js';
import {
    DEFAULT_VEHICLE_ROUTE_RECOVERY_OPTIONS,
    type VehicleRouteRecoveryOptions,
    type VehicleRouteRegistration,
} from 'engine/VehicleRouteRecovery.js';

export interface RacingSetupOptions {
    /** Lock the player into their vehicle: no "Exit vehicle" prompt, E key ignored. */
    lockVehicleExit: boolean;
    /**
     * Keep the mouse cursor free (no pointer lock, no "Press ESC for menu" hint).
     * Racing cameras don't use mouse-look; the chase camera's drag-to-orbit only works
     * with a visible cursor. Set false only when the game has on-foot mouse-look segments.
     */
    freeMouse: boolean;
    autoRight: VehicleAutoRightOptions;
    unstuck: VehicleUnstuckOptions;
    /** Frees a car wedged on scenery (throttle up, going nowhere). */
    stuck: VehicleStuckOptions;
    /**
     * Tuning for the route/centerline rejoin (see `VehicleRouteRecovery`).
     * Optional — shipped racing games build this object by hand — and inert
     * until a vehicle is registered with a route provider.
     */
    route?: VehicleRouteRecoveryOptions;
}

export const DEFAULT_RACING_SETUP_OPTIONS: RacingSetupOptions = {
    lockVehicleExit: true,
    freeMouse: true,
    autoRight: DEFAULT_VEHICLE_AUTO_RIGHT_OPTIONS,
    unstuck: DEFAULT_VEHICLE_UNSTUCK_OPTIONS,
    stuck: DEFAULT_VEHICLE_STUCK_OPTIONS,
    route: DEFAULT_VEHICLE_ROUTE_RECOVERY_OPTIONS,
};

/**
 * Everything a lap-based racing game must wire up to feel right, behind one call.
 *
 * Owns the vehicle safety systems (auto-right + car-to-car unstuck + wedged-on-
 * scenery recovery) and applies the racing
 * input/UI defaults (vehicle exit locked, free mouse). Register every spawned
 * vehicle — player and AI — and drive `update(dt)` from the game loop.
 *
 * Usage:
 *   const racing = installRacingDefaults(engine, playerController, DEFAULT_RACING_SETUP_OPTIONS);
 *   racing.register(playerVehicle);
 *   racing.register(aiVehicle);
 *   // in update loop:
 *   racing.update(deltaTime);
 */
export class RacingSetup {
    private readonly safety: VehicleSafetySystems;

    /**
     * `playerController` is optional only for backward compatibility with games
     * that already ship `new RacingSetup(opts)`; `installRacingDefaults()`
     * always passes it. Without it, `setRespawnProvider()` covers cars wedged
     * on scenery but not cars that fall off the map.
     */
    constructor(opts: RacingSetupOptions, playerController: PlayerController | null = null) {
        // RacingSetupOptions already carries exactly the three safety option
        // groups, so the split needs no change to its shape — shipped racing
        // games keep passing the same object.
        this.safety = new VehicleSafetySystems({
            autoRight: opts.autoRight,
            unstuck: opts.unstuck,
            stuck: opts.stuck,
            route: opts.route ?? DEFAULT_VEHICLE_ROUTE_RECOVERY_OPTIONS,
        }, playerController);
    }

    /**
     * The underlying safety bundle, so vehicles registered outside
     * `RacingSetup` (e.g. by a non-racing subsystem sharing the same game)
     * can still be covered by the same auto-right/unstuck/stuck recovery.
     */
    getSafetySystems(): VehicleSafetySystems { return this.safety; }

    /**
     * Register a spawned vehicle. For an AI rival, also pass its `route` — the
     * centerline it follows plus its current waypoint index — and the race
     * gains a route-aware fallback: a rival that leaves the track corridor, or
     * that the nudges can't free, is put back on a FORWARD centerline point
     * facing down the track with its driving component re-aimed, instead of
     * being rescued in place and then driving off again. The player's car takes
     * no route (it is never steered back onto the line for them).
     */
    register(vehicle: Vehicle, route?: VehicleRouteRegistration): void {
        this.safety.register(vehicle, route);
    }

    unregister(vehicle: Vehicle): void { this.safety.unregister(vehicle); }

    /**
     * Suspend the stuck detectors while the game deliberately holds cars still —
     * above all a start-line countdown, where "throttle held, car not moving,
     * bumper to bumper with the car in front" is exactly what being stuck looks
     * like. Also gates the off-route corridor watch, since a starting grid sits
     * a lane-width off the centerline on purpose. Call `false` for the count
     * and `true` on GO.
     */
    setStuckDetectionEnabled(enabled: boolean): void {
        this.safety.setStuckDetectionEnabled(enabled);
    }

    /**
     * Where to put a car the game can't recover in place — in a lap race, the
     * last checkpoint. Covers a car that nudging can't free (without a provider
     * the system just keeps nudging) AND the player's car falling off the map
     * (without a provider the player is ejected and the car destroyed, unless
     * `lockVehicleExit` keeps them in it).
     *
     * An AI registered with a route rejoins its centerline instead of coming
     * here — a checkpoint is a fine position but says nothing about where the
     * follower's progress went.
     */
    setRespawnProvider(provider: VehicleRespawnProvider | null): void {
        this.safety.setRespawnProvider(provider);
    }

    update(deltaTime: number): void { this.safety.update(deltaTime); }
}

/**
 * Apply the racing-game defaults and return the vehicle safety-system bundle.
 *
 * - locks the player into their vehicle (no "Exit vehicle" prompt / E-to-exit,
 *   and the kill plane respawns the car with the player still in it rather
 *   than ejecting them)
 * - disables pointer lock so the cursor stays visible (racing has no mouse-look,
 *   and the chase camera's drag-to-orbit needs a free cursor)
 * - creates the auto-right + unstuck systems every race needs
 *
 * Call once during game setup, after the PlayerController exists. Then
 * `register()` every spawned vehicle and call `update(dt)` each frame.
 */
export function installRacingDefaults(
    engine: GameEngine,
    playerController: PlayerController,
    options: RacingSetupOptions,
): RacingSetup {
    playerController.setVehicleExitLocked(options.lockVehicleExit);
    if (options.freeMouse) {
        engine.getPointerLockManager()?.setFreeMouseMode(true);
    }
    return new RacingSetup(options, playerController);
}
