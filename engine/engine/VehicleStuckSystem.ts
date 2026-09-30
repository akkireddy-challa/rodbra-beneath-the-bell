import * as THREE from 'three';
import type { Vehicle } from 'engine/Vehicle.js';

/** Where to put a vehicle that can't free itself. Return null to keep nudging. */
export type VehicleRespawnProvider = (vehicle: Vehicle) => {
    position: { x: number; y: number; z: number };
    /** Gameplay yaw (+Z forward). Omit to keep the vehicle's current heading. */
    heading?: number;
} | null;

export interface VehicleStuckOptions {
    /** At or below this speed (m/s) the vehicle counts as not moving. */
    stuckSpeedThreshold: number;
    /**
     * Fraction of max engine force the driver must be asking for before a
     * standstill counts as "stuck". Keeps a parked car from being nudged.
     */
    throttleFraction: number;
    /** How long the stuck condition must hold before the first nudge (ms). */
    stuckDurationMs: number;
    /** Backwards + upward nudge distance, scaled by vehicle size (m). */
    nudgeMeters: number;
    /** Separation speed (m/s) given to the nudge so the car drives clear. */
    nudgeSpeed: number;
    /** Nudges tried before falling back to `respawnProvider` (if any). */
    maxNudgeAttempts: number;
    /** Log each recovery. Off by default — this fires mid-race. */
    debugLog: boolean;
}

export const DEFAULT_VEHICLE_STUCK_OPTIONS: VehicleStuckOptions = {
    stuckSpeedThreshold: 0.7,
    throttleFraction: 0.15,
    stuckDurationMs: 1200,
    nudgeMeters: 0.8,
    nudgeSpeed: 4,
    maxNudgeAttempts: 3,
    debugLog: false,
};

/**
 * Frees vehicles that have wedged against scenery — the classic case being a
 * car beached on a tree or rock with its wheels off the ground, engine roaring
 * and nothing happening.
 *
 * Detection is entirely PASSIVE (reads speed, throttle and wheel contact; never
 * touches the simulation until it acts), so it can't perturb normal collisions:
 *
 *   throttle applied  +  not moving  →  for `stuckDurationMs`  →  recover
 *
 * A standstill with NO wheel touching the ground is treated as stuck even with
 * the throttle shut, since a high-centred car can't recover on its own.
 *
 * Recovery escalates, cheapest first: lift-and-back-off nudges, and only after
 * `maxNudgeAttempts` failures the `respawnProvider` (a racing game hands back
 * the last checkpoint). Without a provider it keeps nudging.
 *
 * IMPORTANT — gate it while movement is intentionally locked. A start-line
 * countdown that holds the car still while the player leans on the throttle is
 * exactly the detector's signature; call `setEnabled(false)` for the count and
 * `setEnabled(true)` on GO (see samples/racing-setup `RaceCountdown`).
 *
 * Usage:
 *   const stuck = new VehicleStuckSystem(DEFAULT_VEHICLE_STUCK_OPTIONS);
 *   stuck.register(playerVehicle);
 *   // in update loop:
 *   stuck.update(deltaTime);
 */
export class VehicleStuckSystem {
    /** Car length the absolute metre defaults are tuned for (m). */
    private static readonly REFERENCE_FOOTPRINT = 3.4;

    private opts: VehicleStuckOptions;
    private vehicles: Set<Vehicle> = new Set();
    private stuckMs: Map<Vehicle, number> = new Map();
    private attempts: Map<Vehicle, number> = new Map();
    private enabled = true;
    private respawnProvider: VehicleRespawnProvider | null = null;

    constructor(opts: VehicleStuckOptions) {
        this.opts = opts;
    }

    register(vehicle: Vehicle): void {
        this.vehicles.add(vehicle);
    }

    unregister(vehicle: Vehicle): void {
        this.vehicles.delete(vehicle);
        this.stuckMs.delete(vehicle);
        this.attempts.delete(vehicle);
    }

    /**
     * Suspend/resume detection. Turn it OFF whenever the game deliberately holds
     * a vehicle still (start-line countdown, cutscene, results screen) —
     * otherwise "throttle held, car not moving" reads as stuck. Suspending also
     * clears accumulated stuck time, so the count restarts cleanly on resume.
     */
    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
        if (!enabled) {
            this.stuckMs.clear();
            this.attempts.clear();
        }
    }

    isEnabled(): boolean {
        return this.enabled;
    }

    /** Safe position to fall back on when nudging fails. */
    setRespawnProvider(provider: VehicleRespawnProvider | null): void {
        this.respawnProvider = provider;
    }

    /** Size relative to the ~3.4 m reference car, so a kart isn't flung a full metre. */
    private vehicleScale(v: Vehicle): number {
        const he = v.getChassisCollider()?.halfExtents();
        if (!he) return 1;
        const footprint = Math.max(he.x, he.z) * 2;
        return footprint > 0 ? footprint / VehicleStuckSystem.REFERENCE_FOOTPRINT : 1;
    }

    /** True when no wheel is touching anything — beached, or airborne. */
    private noWheelContact(v: Vehicle): boolean {
        const info = v.getWheelTerrainInfo();
        if (info.length === 0) return false;
        return !info.some((w) => w.inContact);
    }

    update(deltaTime: number): void {
        if (!this.enabled) return;

        const dtMs = deltaTime * 1000;
        const forward = new THREE.Vector3();
        const tmpQuat = new THREE.Quaternion();

        for (const v of this.vehicles) {
            const body = v.getChassisBody();
            if (!body || !body.isValid()) continue;

            const speed = Math.abs(v.getSpeed());
            const maxForce = v.getMaxEngineForce();
            const throttling = maxForce > 0
                && Math.abs(v.getEngineForce()) >= maxForce * this.opts.throttleFraction;
            const stalled = speed <= this.opts.stuckSpeedThreshold;
            // Beached (no wheel down) counts even coasting: it can't self-recover.
            const wedged = stalled && (throttling || this.noWheelContact(v));

            if (!wedged) {
                this.stuckMs.delete(v);
                this.attempts.delete(v);
                continue;
            }

            const t = (this.stuckMs.get(v) ?? 0) + dtMs;
            if (t < this.opts.stuckDurationMs) {
                this.stuckMs.set(v, t);
                continue;
            }

            // Time to act. Restart the clock so the next attempt waits again.
            this.stuckMs.set(v, 0);
            const attempt = (this.attempts.get(v) ?? 0) + 1;
            this.attempts.set(v, attempt);

            const scale = this.vehicleScale(v);
            const respawn = attempt > this.opts.maxNudgeAttempts
                ? this.respawnProvider?.(v) ?? null
                : null;

            if (respawn) {
                v.teleportTo(respawn.position, respawn.heading);
                this.attempts.delete(v);
                if (this.opts.debugLog) {
                    console.log('[VehicleStuckSystem] nudges exhausted — respawned to a safe position');
                }
                continue;
            }

            // Lift clear of whatever it is beached on and back out along its own
            // heading, which is the way it came in. Velocity does the actual
            // freeing; the teleport only breaks the existing contact.
            const r = body.rotation();
            tmpQuat.set(r.x, r.y, r.z, r.w);
            forward.set(0, 0, 1).applyQuaternion(tmpQuat);
            forward.y = 0;
            if (forward.lengthSq() < 1e-6) forward.set(0, 0, 1);
            forward.normalize();

            const nudge = this.opts.nudgeMeters * scale;
            const pos = body.translation();
            body.setTranslation({
                x: pos.x - forward.x * nudge,
                y: pos.y + nudge * 0.5,
                z: pos.z - forward.z * nudge,
            }, true);
            body.setLinvel({
                x: -forward.x * this.opts.nudgeSpeed,
                y: 0,
                z: -forward.z * this.opts.nudgeSpeed,
            }, true);
            body.setAngvel({ x: 0, y: 0, z: 0 }, true);

            if (this.opts.debugLog) {
                console.log(`[VehicleStuckSystem] stuck — nudge attempt ${attempt}`);
            }
        }
    }
}
