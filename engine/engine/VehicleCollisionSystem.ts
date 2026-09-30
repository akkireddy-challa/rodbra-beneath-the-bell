import type { Vehicle } from 'engine/Vehicle.js';
import type { PhysicsWorld, ContactInfo } from 'engine/physics/PhysicsWorld.js';
import { getGameEventLog } from 'engine/recording/GameEventLog.js';

export interface VehicleCollisionEvent {
    vehicleA: Vehicle;
    vehicleB: Vehicle;
    contactPoint: { x: number; y: number; z: number };
    impactSpeed: number;
}

export interface VehicleCollisionSystemOptions {
    minImpactSpeed: number;
    cooldownMs: number;
    onCollision: (event: VehicleCollisionEvent) => void;
}

export const DEFAULT_VEHICLE_COLLISION_OPTIONS: VehicleCollisionSystemOptions = {
    minImpactSpeed: 3.0,
    cooldownMs: 500,
    onCollision: () => {},
};

/**
 * Detects collisions between registered vehicles using physics callbacks.
 * Fires onCollision when two vehicles hit each other above the minimum impact speed.
 */
export class VehicleCollisionSystem {
    private physicsWorld: PhysicsWorld;
    private options: VehicleCollisionSystemOptions;
    private vehicles: Set<Vehicle> = new Set();
    private cooldowns: Map<string, number> = new Map();
    private callbackCleanups: Array<() => void> = [];

    constructor(physicsWorld: PhysicsWorld, options: Partial<VehicleCollisionSystemOptions> = {}) {
        this.physicsWorld = physicsWorld;
        this.options = { ...DEFAULT_VEHICLE_COLLISION_OPTIONS, ...options };
    }

    registerVehicle(vehicle: Vehicle): void {
        if (this.vehicles.has(vehicle)) return;
        this.vehicles.add(vehicle);

        const body = vehicle.getChassisBody();
        if (!body) return;

        const callback = (contact: ContactInfo) => {
            this.handleContact(vehicle, contact);
        };

        this.physicsWorld.registerCollisionCallback(body, callback);
        this.callbackCleanups.push(() => {
            const b = vehicle.getChassisBody();
            if (b) this.physicsWorld.unregisterCollisionCallback(b, callback);
        });
    }

    unregisterVehicle(vehicle: Vehicle): void {
        this.vehicles.delete(vehicle);
    }

    update(deltaTime: number): void {
        const decayMs = deltaTime * 1000;
        for (const [key, remaining] of this.cooldowns) {
            const newVal = remaining - decayMs;
            if (newVal <= 0) {
                this.cooldowns.delete(key);
            } else {
                this.cooldowns.set(key, newVal);
            }
        }
    }

    dispose(): void {
        for (const cleanup of this.callbackCleanups) {
            cleanup();
        }
        this.callbackCleanups = [];
        this.vehicles.clear();
        this.cooldowns.clear();
    }

    private handleContact(vehicle: Vehicle, contact: ContactInfo): void {
        const otherBody = contact.bodyA === vehicle.getChassisBody() ? contact.bodyB : contact.bodyA;

        let otherVehicle: Vehicle | null = null;
        for (const v of this.vehicles) {
            if (v === vehicle) continue;
            if (v.getChassisBody() === otherBody) {
                otherVehicle = v;
                break;
            }
        }

        if (!otherVehicle) return;

        const pairKey = this.getPairKey(vehicle, otherVehicle);
        if (this.cooldowns.has(pairKey)) return;

        const velA = vehicle.getLinearVelocity();
        const velB = otherVehicle.getLinearVelocity();
        const relativeSpeed = velA.clone().sub(velB).length();

        if (relativeSpeed < this.options.minImpactSpeed) return;

        this.cooldowns.set(pairKey, this.options.cooldownMs);

        const cp = contact.contactPoint;
        // Trailer timeline (reuses this system's speed gate + pair cooldown)
        getGameEventLog().logEvent({
            type: 'vehicle-collision',
            position: { x: cp.x, y: cp.y, z: cp.z },
            intensity: Math.min(1, relativeSpeed / 15),
            data: { impactSpeed: Math.round(relativeSpeed * 10) / 10 },
        });
        this.options.onCollision({
            vehicleA: vehicle,
            vehicleB: otherVehicle,
            contactPoint: { x: cp.x, y: cp.y, z: cp.z },
            impactSpeed: relativeSpeed,
        });
    }

    private getPairKey(a: Vehicle, b: Vehicle): string {
        const ha = a.getChassisBody()?.handle ?? 0;
        const hb = b.getChassisBody()?.handle ?? 0;
        return ha < hb ? `${ha}-${hb}` : `${hb}-${ha}`;
    }
}
