import * as THREE from 'three';
import type { VesselFrame } from 'engine/sailing/VesselFrame.js';
import { oceanWaveFrameForVoyage, type OceanWaveFrame } from 'engine/water/OceanWaveFrame.js';

/**
 * The frame the ship actually sails in.
 *
 * A ship that is the level cannot move: its hull is baked geometry with static
 * colliders, and translating it would leave the player's physics capsule behind.
 * So the ship holds still and the WORLD turns instead. Voyage space is that
 * world — a plain XZ plane (stored as `Vector2(x, z)`) that the ship crosses at
 * `position`, making way along `heading`.
 *
 * Anything the player can see off the deck — islands, a destination, the waves
 * themselves — lives in voyage space and is projected into the world around the
 * ship's centre every frame. That projection is the whole trick: turning the
 * helm swings the horizon by exactly the course change, and holding a course
 * walks near things down the beam and astern. Anything left at a fixed world
 * position (baked terrain, a placed prop) is welded to the view and reads as the
 * sea standing still.
 *
 * Headings follow the gameplay convention: forward is (sin h, cos h).
 */
export class SeaVoyage {
    /** Where the ship has got to, in voyage space. Starts at the origin. Read-only to callers. */
    readonly position = new THREE.Vector2(0, 0);

    private readonly frame: VesselFrame;
    private heading: number;

    constructor(frame: VesselFrame) {
        this.frame = frame;
        this.heading = frame.heading;
    }

    /** The course the ship is making, in radians. */
    getHeading(): number {
        return this.heading;
    }

    /** Make way: `speed` metres per second along `heading` for `deltaTime` seconds. */
    advance(deltaTime: number, speed: number, heading: number): void {
        this.heading = heading;
        const travelled = speed * deltaTime;
        this.position.x += Math.sin(heading) * travelled;
        this.position.y += Math.cos(heading) * travelled;
    }

    /**
     * How far the world has to swing, in radians, so the course reads true from a
     * deck whose geometry points along the frame's heading. Add it to an object's
     * own yaw and the object turns WITH the sea instead of pivoting on the spot.
     */
    swing(): number {
        return this.frame.heading - this.heading;
    }

    /**
     * Put a voyage-space point into the world at height `y`, written into `out`.
     * Returns `swing()`, for the object's yaw.
     */
    projectToWorld(point: THREE.Vector2, y: number, out: THREE.Vector3): number {
        const swing = this.swing();
        const c = Math.cos(swing);
        const s = Math.sin(swing);
        const dx = point.x - this.position.x;
        const dz = point.y - this.position.y;
        // Turn the offset's bearing (from +Z towards +X) by +swing.
        out.set(
            this.frame.centre.x + dx * c + dz * s,
            y,
            this.frame.centre.z - dx * s + dz * c,
        );
        return swing;
    }

    /** The inverse of `projectToWorld`: where world (x, z) lies in voyage space. */
    worldToVoyage(x: number, z: number, out: THREE.Vector2): THREE.Vector2 {
        const swing = this.swing();
        const c = Math.cos(swing);
        const s = Math.sin(swing);
        const dx = x - this.frame.centre.x;
        const dz = z - this.frame.centre.z;
        return out.set(this.position.x + dx * c - dz * s, this.position.y + dx * s + dz * c);
    }

    /**
     * Range (metres) and true bearing (radians, 0 = voyage +Z, clockwise towards
     * +X, in [0, 2π)) from the ship to a voyage-space point — what a HUD shows.
     * Steer off course and the range grows by itself; no rule has to punish it.
     */
    rangeAndBearingTo(point: THREE.Vector2, out: { range: number; bearing: number }): { range: number; bearing: number } {
        const dx = point.x - this.position.x;
        const dz = point.y - this.position.y;
        out.range = Math.hypot(dx, dz);
        const bearing = Math.atan2(dx, dz);
        out.bearing = bearing < 0 ? bearing + Math.PI * 2 : bearing;
        return out;
    }

    /** The ocean frame that makes the WAVES sail past too — hand it to `OceanSurface.setWaveFrame`. */
    waveFrame(out: OceanWaveFrame): OceanWaveFrame {
        return oceanWaveFrameForVoyage(
            this.frame.centre.x,
            this.frame.centre.z,
            this.position.x,
            this.position.y,
            this.swing(),
            out,
        );
    }
}
