import type { Vehicle } from 'engine/Vehicle.js';
import type { VehicleRespawnProvider } from 'engine/VehicleStuckSystem.js';

/**
 * What the engine does when the player — or the vehicle they are driving —
 * falls out of the world.
 *
 * The rescue used to be a bare `if (y < -100) respawnAtStart()` inside
 * `PlayerController`, which ejected the driver and DESTROYED their car with no
 * notification. Any game holding that `Vehicle` was left polling a dead object
 * (a race director reading stale coordinates for the rest of the session), and
 * a game that had locked the player into the car with
 * `installRacingDefaults({ lockVehicleExit: true })` got them thrown out
 * anyway. The decision now lives here, as a pure function, so games can
 * configure it, observe it, and — above all — keep their vehicle.
 */

/** The altitude below which a body counts as fallen out of the world. */
export const DEFAULT_KILL_PLANE_Y = -100;

/**
 * How far above the respawn point a rescued car is placed when the game gave
 * no respawn provider and we fall back to the player's own spawn (m). The
 * spawn Y is authored for a character's feet; dropping a chassis straight onto
 * it leaves the car interpenetrating the ground.
 */
export const DEFAULT_VEHICLE_RESPAWN_LIFT = 1.0;

export interface FallRescueOptions {
    /**
     * World Y below which the player (or their vehicle) is rescued. Lower it
     * for worlds whose terrain extends below the default, raise it to catch a
     * fall sooner.
     */
    killPlaneY: number;
    /** Lift applied when respawning a car at the player's spawn point (m). */
    vehicleRespawnLift: number;
}

export const DEFAULT_FALL_RESCUE_OPTIONS: FallRescueOptions = {
    killPlaneY: DEFAULT_KILL_PLANE_Y,
    vehicleRespawnLift: DEFAULT_VEHICLE_RESPAWN_LIFT,
};

/**
 * Where a fallen vehicle should reappear. Same shape the vehicle safety
 * systems already use, so one `setRespawnProvider()` covers both being wedged
 * on scenery and falling off the map.
 */
export type VehicleRespawnPoint = ReturnType<VehicleRespawnProvider>;

/**
 * What the engine is about to do, handed to `PlayerController.onFallRescue`
 * BEFORE it happens — so a game holding the vehicle can react while the
 * reference is still live, or return `true` from the handler to suppress the
 * engine's rescue entirely and run its own.
 *
 * - `vehicle-respawned` — the car is teleported to `position` with the player
 *   still in it. Nothing is destroyed.
 * - `vehicle-destroyed` — the player is ejected and the car removed (the old
 *   behaviour; only reached when the game neither set a respawn provider nor
 *   locked vehicle exit). Any reference the game holds is dead after this.
 * - `player-respawned` — the player fell on foot and goes back to spawn.
 */
export type FallRescueEvent =
    | { action: 'vehicle-respawned'; vehicle: Vehicle; position: { x: number; y: number; z: number }; heading: number | null }
    | { action: 'vehicle-destroyed'; vehicle: Vehicle; position: { x: number; y: number; z: number }; heading: null }
    | { action: 'player-respawned'; vehicle: null; position: { x: number; y: number; z: number }; heading: null };

export interface FallRescueInput {
    /** The vehicle the player is driving, or null when they fell on foot. */
    vehicle: Vehicle | null;
    /** What the game's respawn provider returned for that vehicle. */
    respawn: VehicleRespawnPoint;
    /** True when the game has locked the player into the vehicle. */
    vehicleExitLocked: boolean;
    /** The player's spawn point — the last-resort destination. */
    startPosition: { x: number; y: number; z: number };
    options: FallRescueOptions;
}

/**
 * Decide what to do about a fallen player. Pure — no engine state touched, so
 * the branches are testable on their own.
 *
 * A driven vehicle is kept alive whenever the game has said anything about
 * what should happen to it: a respawn provider names the spot (last checkpoint
 * in a lap race), and a locked vehicle exit means "the player does not leave
 * this car" — which the rescue must honour just as the E key does. Only a game
 * that has said neither falls through to eject-and-destroy.
 */
export function planFallRescue(input: FallRescueInput): FallRescueEvent {
    const { vehicle, respawn, vehicleExitLocked, startPosition, options } = input;

    if (!vehicle) {
        return { action: 'player-respawned', vehicle: null, position: { ...startPosition }, heading: null };
    }

    if (respawn) {
        return {
            action: 'vehicle-respawned',
            vehicle,
            position: { ...respawn.position },
            heading: respawn.heading ?? null,
        };
    }

    if (vehicleExitLocked) {
        return {
            action: 'vehicle-respawned',
            vehicle,
            position: {
                x: startPosition.x,
                y: startPosition.y + options.vehicleRespawnLift,
                z: startPosition.z,
            },
            heading: null,
        };
    }

    return { action: 'vehicle-destroyed', vehicle, position: { ...startPosition }, heading: null };
}
