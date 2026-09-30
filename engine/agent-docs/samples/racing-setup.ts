/**
 * Minimal lap-racing wiring (mechanic-racing.md): the racing preset + start
 * grid + player/AI kart spawns, plus a start-line COUNTDOWN that reliably holds
 * the player at the line until "GO". `installRacingDefaults` is REQUIRED for
 * lap-based races — it locks the player into the vehicle (no "Exit vehicle"
 * prompt / E-to-exit), keeps the mouse cursor free (no pointer lock), and owns
 * the auto-right/unstuck safety systems.
 *
 * Referenced from agent docs (read-docs name: `samples/racing-setup`).
 * Compiled against the live engine by game's `pnpm run check`.
 */
import {
    DEFAULT_RACING_CAR_CONFIG,
    BasicDrivingComponent,
    installRacingDefaults,
    DEFAULT_RACING_SETUP_OPTIONS,
    type RacingSetup,
    type Vehicle,
    type VehicleRouteRegistration,
} from 'engine/Vehicle.js';
import { VoxelCarBodyBuilder } from 'engine/builders/VoxelCarBodyBuilder.js';
import type { GameEngine } from 'engine/GameEngine.js';
import type { PlayerController } from 'engine/PlayerController.js';
import type { VehicleSpawner } from 'engine/VehicleSpawner.js';

const COLORS = [0xff3322, 0x2266ff, 0xffcc00, 0x33dd44];

/**
 * AI rivals that follow a baked track's centerline.
 *
 * `getTrackCenterline(name)` returns the whole racing line already ordered in
 * the intended direction (it orients itself to the player spawn), so the SAME
 * array drives grid placement, steering targets and lap progress — they can
 * never disagree about which way round the track runs.
 *
 * Each rival is driven by the engine's `BasicDrivingComponent`: per frame, aim
 * it at a waypoint and tick `updateAI`. Speed differences come from
 * `maxSpeed`; racing keeps the boolean throttle model (bang-bang, tuned for
 * pace over smoothness). For a driver that HOLDS a speed and eases into a
 * stop instead — a chauffeur, not a racer — see `samples/chauffeur-drive.ts`.
 *
 * Pass the `RacingSetup` to `add()` and each rival also gets the engine's
 * route-aware recovery (`routeRecovery()` below): a shunt over a shortcut wall
 * that the nudges can't undo, or a car that stays outside the track corridor,
 * puts it back on a FORWARD centerline point facing down the track — the one
 * failure mode local recovery alone cannot fix, since a car freed where it
 * landed still holds a target it can no longer reach.
 */
export class CenterlineAi {
    private readonly cars: Array<{
        vehicle: Vehicle;
        driving: BasicDrivingComponent;
        target: number;
        laps: number;
    }> = [];

    /**
     * @param lookAhead waypoints ahead of the nearest one to aim at (corner smoothing).
     * @param corridorHalfWidth how far off the centerline (m) still counts as on
     *   the track — the painted half-width. Too small and a wide line reads as
     *   off-route; too large and a car that left the track is never rescued.
     */
    constructor(
        private readonly waypoints: ReadonlyArray<{ x: number; y: number; z: number }>,
        private readonly lookAhead = 2,
        private readonly corridorHalfWidth = 8,
    ) {}

    /**
     * Register a spawned rival. `skill` ~0.85–1.0 scales its top speed.
     * Pass `racing` to also arm the engine's route recovery for this car.
     */
    add(vehicle: Vehicle, skill: number, startIndex: number, racing?: RacingSetup): void {
        const driving = new BasicDrivingComponent();
        driving.maxSpeed = 26 * skill;
        vehicle.setDrivingComponent(driving);
        vehicle.setAlwaysActive(true);
        this.cars.push({ vehicle, driving, target: startIndex, laps: 0 });
        racing?.register(vehicle, this.routeRecovery());
    }

    /**
     * The route this AI is on, for `racing.register(vehicle, ...)`. The engine
     * reads `targetIndex` so a rejoin can only ever move a car FORWARD, and
     * `onRejoined` writes the new index back here so lap counting follows the
     * rescue instead of quietly disagreeing with it.
     */
    routeRecovery(): VehicleRouteRegistration {
        return {
            route: (v) => {
                const car = this.cars.find((c) => c.vehicle === v);
                if (!car) return null;
                return {
                    points: this.waypoints,
                    targetIndex: car.target,
                    loop: true,
                    corridorHalfWidth: this.corridorHalfWidth,
                };
            },
            onRejoined: (v, index) => {
                const car = this.cars.find((c) => c.vehicle === v);
                if (!car) return;
                const n = this.waypoints.length;
                // Same wrap rule as update(): a rejoin that jumps past the line
                // still completes the lap it was on.
                if (index < car.target && car.target - index > n / 2) car.laps++;
                car.target = index;
            },
        };
    }

    /** Laps completed by a registered rival, in `add()` order. */
    lapsCompleted(index: number): number {
        return this.cars[index]?.laps ?? 0;
    }

    /** Call every frame. */
    update(deltaTime: number): void {
        const n = this.waypoints.length;
        if (n === 0) return;
        for (const car of this.cars) {
            const pos = car.vehicle.getPosition();

            // Re-acquire against the waypoints NEAR the current target rather than
            // only advancing on proximity: a car pushed off line (or spun round)
            // then rejoins the lap instead of chasing a waypoint it can no longer
            // reach. Searching a window, not the whole loop, keeps a car that has
            // just crossed the line from snapping onto the far side of the track.
            let best = car.target;
            let bestDistSq = Infinity;
            for (let offset = -4; offset <= 12; offset++) {
                const i = (((car.target + offset) % n) + n) % n;
                const w = this.waypoints[i]!;
                const dx = w.x - pos.x, dz = w.z - pos.z;
                const dSq = dx * dx + dz * dz;
                if (dSq < bestDistSq) { bestDistSq = dSq; best = i; }
            }
            if (best < car.target - n / 2) car.laps++; // wrapped past the start
            else if (best < car.target && car.target - best > n / 2) car.laps++;
            car.target = best;

            const aim = this.waypoints[(best + this.lookAhead) % n]!;
            car.driving.setTarget(aim.x, aim.z);
            car.vehicle.updateAI(deltaTime);
        }
    }
}

/**
 * Spawn a full starting grid on a circular track loop and enter the player into
 * pole position. Returns the `RacingSetup` (call `racing.update(dt)` each frame)
 * and the player's vehicle (hand it to a `RaceCountdown`, below).
 */
export function setupRace(
    engine: GameEngine,
    playerController: PlayerController,
    spawner: VehicleSpawner,
    trackLoopCenter: { x: number; z: number },
    trackRadius: number,
    numAi: number,
): { racing: RacingSetup; playerVehicle: Vehicle | null } {
    // REQUIRED for any racing game — exit lock + free mouse + safety systems.
    const racing = installRacingDefaults(engine, playerController, DEFAULT_RACING_SETUP_OPTIONS);

    // Once your game tracks checkpoints, hand them back here:
    //   racing.setRespawnProvider((v) => ({ position: lastCheckpointFor(v), heading }));
    // One call covers a car wedged on scenery AND a car that falls off the map
    // (the kill plane then teleports it back with the driver still in it).
    // Until then the racing exit lock keeps the player in the car and puts it
    // back at their spawn — nothing is destroyed either way.

    // Grid slots ON the loop, each heading tangent to the loop at its own
    // position — never a single shared yaw constant.
    const grid = spawner.layoutGridOnLoop({
        center: trackLoopCenter,
        radius: trackRadius,
        travel: 'ccw',
        startAngle: -Math.PI / 2,
        slots: 1 + numAi,
        laneOffset: 1.5,
        slotSpacing: 4,
    });

    let playerVehicle: Vehicle | null = null;
    const pole = grid[0];
    if (pole) {
        const playerSpawn = spawner.spawnAndEnter(
            pole.position,
            DEFAULT_RACING_CAR_CONFIG,
            VoxelCarBodyBuilder.sedanBody(COLORS[0] ?? 0xff3322),
            playerController,
            pole.heading,
        );
        if (playerSpawn) {
            racing.register(playerSpawn.vehicle);
            playerVehicle = playerSpawn.vehicle;
        }
    }

    for (let i = 1; i < grid.length; i++) {
        const slot = grid[i];
        if (!slot) continue;
        const r = spawner.spawnVehicle(slot.position, DEFAULT_RACING_CAR_CONFIG, undefined, slot.heading);
        if (!r) continue;
        VoxelCarBodyBuilder.addVoxelBody(r.vehicle, r.platform, VoxelCarBodyBuilder.sedanBody(COLORS[i % COLORS.length] ?? 0x2266ff));
        const driving = new BasicDrivingComponent();
        driving.maxSpeed = 13 + Math.random() * 3; // jitter so AI doesn't drive in lockstep
        r.vehicle.setDrivingComponent(driving);
        r.vehicle.setAlwaysActive(true);
        racing.register(r.vehicle);
    }

    return { racing, playerVehicle };
}

/**
 * A 3-2-1-GO start-line countdown that RELIABLY holds the player's kart at the
 * line until GO, then releases it.
 *
 * Do NOT gate the start with `playerController.setControlsEnabled(false)`: that
 * does not reliably stop a *vehicle* — depending on timing the kart either
 * creeps off the line during the countdown, or never unlocks on GO. This freezes
 * the chassis body directly, which held keys cannot bypass and which needs no
 * fragile one-frame "release" edge — simply not freezing IS the release.
 *
 * Pass the `RacingSetup` too: holding a car still while the player leans on the
 * throttle is exactly what VehicleStuckSystem looks for, so the countdown
 * suspends that detector and re-enables it on GO.
 *
 * Usage (in your game):
 *   const { racing, playerVehicle } = setupRace(engine, pc, spawner, center, radius, 5);
 *   const countdown = playerVehicle ? new RaceCountdown(playerVehicle, 3, racing) : null;
 *   // every frame, in update(dt):
 *   racing.update(dt);
 *   const banner = countdown?.update(dt) ?? '';   // show in a center HUD element
 *   if (countdown?.racing) { ...run the lap timer + checkpoint checks... }
 */
export class RaceCountdown {
    private remaining: number;
    private goBanner = 0;

    constructor(
        private readonly playerVehicle: Vehicle,
        seconds = 3,
        private readonly racingSetup: RacingSetup | null = null,
    ) {
        this.remaining = seconds;
        // Held at the line on purpose — don't let the stuck detector "rescue" it.
        this.racingSetup?.setStuckDetectionEnabled(false);
    }

    /** True once the countdown has reached GO and the kart is free to drive. */
    get racing(): boolean {
        return this.remaining <= 0;
    }

    /**
     * Advance the countdown; call EVERY frame. Returns the banner text to show:
     * "3" | "2" | "1" while counting, "GO!" for a short beat, then "".
     */
    update(deltaTime: number): string {
        if (this.remaining > 0) {
            // Pin the kart at the line — cannot creep no matter what keys are held.
            const body = this.playerVehicle.getChassisBody();
            if (body) {
                body.setLinvel({ x: 0, y: 0, z: 0 }, true);
                body.setAngvel({ x: 0, y: 0, z: 0 }, true);
            }
            this.remaining -= deltaTime;
            if (this.remaining <= 0) {
                this.goBanner = 0.9;
                this.racingSetup?.setStuckDetectionEnabled(true); // released — watch for wedges again
                return 'GO!';
            }
            return String(Math.ceil(this.remaining));
        }
        // Racing: linger on "GO!" for a beat, then clear the banner.
        if (this.goBanner > 0) {
            this.goBanner -= deltaTime;
            return this.goBanner > 0 ? 'GO!' : '';
        }
        return '';
    }
}
