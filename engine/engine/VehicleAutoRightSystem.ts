import * as THREE from 'three';
import type { Vehicle } from 'engine/Vehicle.js';

export interface VehicleAutoRightOptions {
    /** Upright dot product below which the vehicle counts as tilted (1 = upright, -1 = upside down). */
    tiltDotThreshold: number;
    /** How long a vehicle must stay tilted before it gets snapped upright (ms). */
    tiltDurationMs: number;
    /** Upward nudge applied after snap so the chassis doesn't clip the ground (m). */
    liftMeters: number;
}

export const DEFAULT_VEHICLE_AUTO_RIGHT_OPTIONS: VehicleAutoRightOptions = {
    tiltDotThreshold: 0.4,
    tiltDurationMs: 1500,
    liftMeters: 1.0,
};

/**
 * Auto-rights any registered vehicle that has been tilted past the threshold for too long.
 * Preserves yaw (heading), zeroes roll/pitch, and resets velocities so the snap is clean.
 *
 * Usage:
 *   const autoRight = new VehicleAutoRightSystem(DEFAULT_VEHICLE_AUTO_RIGHT_OPTIONS);
 *   autoRight.register(playerVehicle);
 *   autoRight.register(aiVehicle);
 *   // in update loop:
 *   autoRight.update(deltaTime);
 */
export class VehicleAutoRightSystem {
    /** Car length the absolute `liftMeters` default is tuned for (m). */
    private static readonly REFERENCE_FOOTPRINT = 3.4;
    private opts: VehicleAutoRightOptions;
    private vehicles: Set<Vehicle> = new Set();
    private tiltMs: Map<Vehicle, number> = new Map();

    /** Size factor relative to the ~3.4 m reference car so lift scales proportionally (not a full meter for a tiny RC car). */
    private vehicleScale(v: Vehicle): number {
        const he = v.getChassisCollider()?.halfExtents();
        if (!he) return 1;
        const footprint = Math.max(he.x, he.z) * 2;
        return footprint > 0 ? footprint / VehicleAutoRightSystem.REFERENCE_FOOTPRINT : 1;
    }

    constructor(opts: VehicleAutoRightOptions) {
        this.opts = opts;
    }

    register(vehicle: Vehicle): void {
        this.vehicles.add(vehicle);
    }

    unregister(vehicle: Vehicle): void {
        this.vehicles.delete(vehicle);
        this.tiltMs.delete(vehicle);
    }

    update(deltaTime: number): void {
        const dtMs = deltaTime * 1000;
        const up = new THREE.Vector3(0, 1, 0);
        const carUp = new THREE.Vector3();
        const tmpQuat = new THREE.Quaternion();

        for (const v of this.vehicles) {
            const body = v.getChassisBody();
            if (!body || !body.isValid()) continue;

            const r = body.rotation();
            tmpQuat.set(r.x, r.y, r.z, r.w);
            carUp.copy(up).applyQuaternion(tmpQuat);
            const tiltDot = carUp.dot(up);

            if (tiltDot >= this.opts.tiltDotThreshold) {
                this.tiltMs.delete(v);
                continue;
            }

            const t = (this.tiltMs.get(v) ?? 0) + dtMs;
            if (t < this.opts.tiltDurationMs) {
                this.tiltMs.set(v, t);
                continue;
            }

            const yaw = new THREE.Euler().setFromQuaternion(tmpQuat, 'YXZ').y;
            const yawOnly = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0, 'YXZ'));
            const pos = body.translation();
            body.setRotation({ x: yawOnly.x, y: yawOnly.y, z: yawOnly.z, w: yawOnly.w }, true);
            const lift = this.opts.liftMeters * this.vehicleScale(v);
            body.setTranslation({ x: pos.x, y: pos.y + lift, z: pos.z }, true);
            body.setLinvel({ x: 0, y: 0, z: 0 }, true);
            body.setAngvel({ x: 0, y: 0, z: 0 }, true);
            this.tiltMs.delete(v);
        }
    }
}
