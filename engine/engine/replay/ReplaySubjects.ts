/**
 * Adapters that turn a live subject into a `ReplaySampleFn`.
 *
 * Subjects are described STRUCTURALLY rather than imported, so the replay layer
 * has no dependency on the vehicle or character implementations and stays
 * testable against plain objects. A `RapierVehicle` satisfies
 * `ReplayVehicleSubject` without knowing this file exists.
 *
 * Each sampler writes into the caller's array in channel order — no allocation
 * per sample, since these run inside the update loop.
 */

import type * as THREE from 'three';
import type { ReplaySampleFn } from 'engine/replay/ReplayRecorder.js';
import { VEHICLE_WHEEL_SLOTS } from 'engine/replay/ReplayChannels.js';
import type { VehicleDescriptor } from 'engine/networking/NetworkTypes.js';

/** The slice of a vehicle the motion template needs. */
export interface ReplayVehicleSubject {
    getPosition(): THREE.Vector3;
    getChassisObject(): THREE.Object3D;
    /** Signed along the car's own forward axis. */
    getForwardSpeed(): number;
    getSteeringAngle(): number;
    getWheelCount(): number;
    /** Accumulated spin angle in radians, as the solver computed it. */
    getWheelRotation(wheelIndex: number): number;
    /** Real collision extents, used to size the ghost body. */
    getFootprint(): { width: number; height: number; length: number };
    getWheelConfigs(): ReadonlyArray<{
        position: { x: number; y: number; z: number };
        radius: number;
        width: number;
        suspensionRestLength: number;
        isSteering: boolean;
        color?: number;
    }>;
}

/** Anything at or below this is the bare platform slab, not a car body. */
const PLATFORM_SLAB_HEIGHT = 0.3;

/**
 * A body box for the ghost, falling back to wheel geometry when the footprint
 * is only the platform.
 *
 * `getFootprint()` reports the union of the body's collision boxes, but returns
 * the configured chassis slab when none have been built. On the asset path that
 * slab is 15 cm — so a ghost created before the body colliders land renders as
 * a plank, which reads as "the base of the car with the chassis missing".
 *
 * Wheel positions are always available and always real, so they carry the
 * fallback: track width and wheelbase give the plan, and body height scales off
 * wheel radius. It is an approximation, and only ever visible on a ghost whose
 * asset visuals did not load.
 */
function ghostBodySize(
    footprint: { width: number; height: number; length: number },
    wheels: ReadonlyArray<{ position: { x: number; z: number }; radius: number }>,
): { width: number; height: number; length: number } {
    if (footprint.height > PLATFORM_SLAB_HEIGHT || wheels.length === 0) return footprint;

    let maxX = 0;
    let maxZ = 0;
    let radius = 0;
    for (const wheel of wheels) {
        maxX = Math.max(maxX, Math.abs(wheel.position.x));
        maxZ = Math.max(maxZ, Math.abs(wheel.position.z));
        radius = Math.max(radius, wheel.radius);
    }
    return {
        width: Math.max(footprint.width, maxX * 2),
        height: Math.max(footprint.height, radius * 3),
        length: Math.max(footprint.length, maxZ * 2),
    };
}

/**
 * Build a ghost's appearance from the live vehicle.
 *
 * Exists so a game never has to hand-write a `VehicleDescriptor` just to get a
 * ghost that looks like its car. The one thing that cannot be derived is
 * `assetId` — the vehicle does not know which asset it was spawned from — so a
 * game using asset karts should pass that through, and gets the real body and
 * wheels instead of boxes.
 */
export function describeVehicleForGhost(
    vehicle: ReplayVehicleSubject,
    assetId?: string,
): VehicleDescriptor {
    const wheels = vehicle.getWheelConfigs();
    const descriptor: VehicleDescriptor = {
        chassisSize: ghostBodySize(vehicle.getFootprint(), wheels),
        chassisColor: 0x9fb4c7,
        wheels: wheels.map((wheel) => ({
            position: { x: wheel.position.x, y: wheel.position.y, z: wheel.position.z },
            radius: wheel.radius,
            width: wheel.width,
            suspensionRestLength: wheel.suspensionRestLength,
            isSteering: wheel.isSteering,
            ...(wheel.color === undefined ? {} : { color: wheel.color }),
        })),
        // Derived ghosts carry no separate body boxes: the footprint already
        // covers the whole body, so adding parts would double it up.
        bodyParts: [],
    };
    if (assetId) descriptor.assetId = assetId;
    return descriptor;
}

/**
 * Sampler for `VEHICLE_MOTION_CHANNELS`.
 *
 * Layout: posX, posY, posZ, rot(x,y,z,w), steer, speed, wheelW0..3 — 13 slots.
 *
 * Wheel angular velocity is DIFFERENTIATED from the solver's accumulated
 * rotation angle rather than computed from speed, because the two disagree
 * exactly where it shows: wheelspin, lockup, and airborne wheels. The sampler
 * holds the previous angles, so it is stateful and one instance belongs to one
 * recording of one vehicle.
 */
export function createVehicleMotionSampler(vehicle: ReplayVehicleSubject): ReplaySampleFn {
    const previousRotation = new Float64Array(VEHICLE_WHEEL_SLOTS);
    let seeded = false;

    return (out: number[], deltaTime: number): void => {
        const position = vehicle.getPosition();
        const quaternion = vehicle.getChassisObject().quaternion;
        out[0] = position.x;
        out[1] = position.y;
        out[2] = position.z;
        out[3] = quaternion.x;
        out[4] = quaternion.y;
        out[5] = quaternion.z;
        out[6] = quaternion.w;
        out[7] = vehicle.getSteeringAngle();
        out[8] = vehicle.getForwardSpeed();

        const wheels = Math.min(vehicle.getWheelCount(), VEHICLE_WHEEL_SLOTS);
        for (let i = 0; i < VEHICLE_WHEEL_SLOTS; i++) {
            let angularVelocity = 0;
            if (i < wheels) {
                const angle = vehicle.getWheelRotation(i);
                if (seeded && deltaTime > 0) {
                    angularVelocity = (angle - (previousRotation[i] ?? 0)) / deltaTime;
                }
                previousRotation[i] = angle;
            }
            out[9 + i] = angularVelocity;
        }
        seeded = true;
    };
}

/** One frame of character state, for `CHARACTER_MOTION_CHANNELS`. */
export interface ReplayCharacterState {
    position: THREE.Vector3;
    /** Radians, wrapped to [-PI, PI]. */
    yaw: number;
    speed: number;
    /** Index into a table the game owns; round-tripped exactly. */
    animId: number;
}

/**
 * Sampler for `CHARACTER_MOTION_CHANNELS`.
 *
 * Takes a read callback rather than a structural subject: character state is
 * assembled differently by every genre, and a callback lets the game decide
 * where yaw and animation index come from.
 *
 * Layout: posX, posY, posZ, yaw, speed, animId — 6 slots.
 */
export function createCharacterMotionSampler(read: () => ReplayCharacterState): ReplaySampleFn {
    return (out: number[]): void => {
        const state = read();
        out[0] = state.position.x;
        out[1] = state.position.y;
        out[2] = state.position.z;
        out[3] = state.yaw;
        out[4] = state.speed;
        out[5] = state.animId;
    };
}

/**
 * One poll of player input.
 *
 * `buttons` is a bitfield the game defines — jump, handbrake, boost, whatever
 * the genre has. It round-trips exactly, so bit N means the same thing coming
 * out as it did going in.
 */
export interface ReplayInputSnapshot {
    /** -1 (full left) to +1 (full right). Keyboards produce exactly -1, 0, +1. */
    steer: number;
    /** 0 to 1. */
    throttle: number;
    /** 0 to 1. */
    brake: number;
    /** Up to 8 flags. */
    buttons: number;
}

/**
 * Sampler for `INPUT_CHANNELS`.
 *
 * Layout: steer, throttle, brake, buttons — 4 slots.
 */
export function createInputSampler(read: () => ReplayInputSnapshot): ReplaySampleFn {
    return (out: number[]): void => {
        const input = read();
        out[0] = input.steer;
        out[1] = input.throttle;
        out[2] = input.brake;
        out[3] = input.buttons;
    };
}
