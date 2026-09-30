/**
 * The watercraft motor: thrust, drift, and — the part that makes it a BOAT
 * rather than a car on a blue floor — riding the wave field.
 *
 * Pure state machine. It owns no mesh, no rigid body and no scene: it takes an
 * input struct and a `WaterSurfaceQuery`, and produces a desired movement delta
 * plus a pose. `engine/boat/BoatMovement.ts` wraps it for the player (feeding
 * it the keyboard and pushing the delta through the character controller so
 * islands and rivals still block), and `engine/boat/AiBoat.ts` wraps it for
 * rivals. Both get identical handling, which is the point — a rival that
 * cheats its way over a swell the player has to climb is instantly obvious.
 *
 * ## Wave riding
 *
 * The hull tracks `surfaceHeight + rideHeight` through a spring, and LEAVES the
 * water when the surface falls away faster than gravity can pull the hull down
 * — the far side of a crest at speed. That single test is what produces jumps
 * off wave tops without any scripted ramps: go faster, launch further. On the
 * way it also picks up `waveSurfAccel` along the local downhill, so running
 * down a swell is genuinely quicker than climbing one.
 *
 * Coordinate convention is the engine's gameplay one (see
 * `agent-docs/coordinate-system.md`): +Z forward, heading yaw such that forward
 * is `(sin θ, 0, cos θ)`, and positive `steer` turns LEFT — matching the sign
 * `SkiMovement` uses for the same keys.
 *
 * Usage:
 *   const motor = new BoatMotor(config);
 *   motor.setPosition(startX, startY, startZ, startHeading);
 *   // per frame, AFTER the water surface has been advanced:
 *   const delta = motor.step(dt, input, surface);
 *   const actual = collideAndSlide(delta);   // or just `delta` with no collision
 *   motor.commit(actual);
 *   motor.getPose(quaternionOut);
 */

import * as THREE from 'three';
import { type BoatConfig, quadraticDragFor } from 'engine/boat/BoatConfig.js';
import type { WaterSurfaceQuery } from 'engine/water/WaterSurfaceQuery.js';

const DEG2RAD = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);

/** One frame of control input. All values are already smoothed/clamped. */
export interface BoatInput {
    /** −1 (full astern / brake) .. +1 (full throttle). */
    throttle: number;
    /** −1 (right) .. +1 (left), matching the engine's positive-yaw-is-left rule. */
    steer: number;
    boost: boolean;
    /** True on the frame a hop is requested. The motor consumes the edge. */
    jump: boolean;
}

export const NEUTRAL_BOAT_INPUT: BoatInput = { throttle: 0, steer: 0, boost: false, jump: false };

/** Everything a HUD, a VFX emitter or an AI needs to read back per frame. */
export interface BoatState {
    /** Signed speed along the heading (m/s). Negative astern. */
    forwardSpeed: number;
    /** Magnitude of horizontal velocity (m/s), regardless of direction. */
    speed: number;
    heading: number;
    /** World velocity including vertical (m/s). Do not mutate. */
    velocity: THREE.Vector3;
    /** False while airborne off a crest. */
    onWater: boolean;
    airtimeSeconds: number;
    /** 0 = tracking straight, 1 = fully sideways. Drives spray and drift scoring. */
    drift: number;
    /** Water surface Y under the hull this frame. */
    surfaceY: number;
    /** Hull Y this frame. */
    hullY: number;
    boosting: boolean;
    /**
     * Downward speed (m/s) of the most recent splashdown, or 0 if the last
     * frame was not a landing. Watch it for landing spray and camera kicks.
     */
    landingImpact: number;
}

export class BoatMotor {
    private readonly config: BoatConfig;

    private readonly position = new THREE.Vector3();
    private heading = 0;
    /** Horizontal velocity. Y is carried separately so the spring can own it. */
    private velX = 0;
    private velZ = 0;
    private velY = 0;
    private onWater = true;
    private airtime = 0;
    private landingImpact = 0;
    private boosting = false;

    private readonly poseQuat = new THREE.Quaternion();
    private poseInitialized = false;

    // Scratch — this runs every frame for every boat in the race.
    private readonly desired = new THREE.Vector3();
    private readonly velocityOut = new THREE.Vector3();
    private readonly normal = new THREE.Vector3(0, 1, 0);
    private readonly tmpQuatA = new THREE.Quaternion();
    private readonly tmpQuatB = new THREE.Quaternion();
    private readonly tmpVec = new THREE.Vector3();
    private readonly tmpEuler = new THREE.Euler();
    private surfaceY = 0;

    constructor(config: BoatConfig) {
        this.config = config;
    }

    /** Hard placement (spawn, respawn, teleport). Zeroes all motion. */
    setPosition(x: number, y: number, z: number, heading: number): void {
        this.position.set(x, y, z);
        this.heading = heading;
        this.velX = 0;
        this.velZ = 0;
        this.velY = 0;
        this.onWater = true;
        this.airtime = 0;
        this.landingImpact = 0;
        this.poseInitialized = false;
    }

    getPosition(out: THREE.Vector3): THREE.Vector3 { return out.copy(this.position); }
    getHeading(): number { return this.heading; }
    setHeading(heading: number): void { this.heading = heading; }

    /**
     * Advance one frame and return the movement the boat WANTS to make, in
     * world metres. The caller may clamp it (collision) before calling
     * `commit`, which is the only thing that actually moves the boat.
     */
    step(deltaTime: number, input: BoatInput, surface: WaterSurfaceQuery): THREE.Vector3 {
        const cfg = this.config;
        const dt = Math.max(1e-4, Math.min(0.1, deltaTime));
        this.landingImpact = 0;
        this.boosting = input.boost && input.throttle > 0;

        // ---- steering ----
        // Authority peaks at turnPeakSpeed: a drifting boat has no water
        // flowing past the hull to bite on, and a boat at full chat is fighting
        // its own momentum.
        const speed = Math.hypot(this.velX, this.velZ);
        const bite = Math.min(1, speed / cfg.turnPeakSpeed);
        const fast = Math.min(1, Math.max(0, (speed - cfg.turnPeakSpeed) / Math.max(1, cfg.maxSpeed - cfg.turnPeakSpeed)));
        const turnDeg = (cfg.turnRateLowDeg + (cfg.turnRateHighDeg - cfg.turnRateLowDeg) * bite)
            * (1 - 0.35 * fast)
            * (this.onWater ? 1 : cfg.airTurnFactor);
        this.heading += input.steer * turnDeg * DEG2RAD * dt;

        const fx = Math.sin(this.heading);
        const fz = Math.cos(this.heading);

        // ---- thrust ----
        // Forward speed is measured along the CURRENT heading, so a boat that
        // has spun round mid-drift correctly reads as going backwards.
        const forwardSpeed = this.velX * fx + this.velZ * fz;
        const maxFwd = this.boosting ? cfg.boostMaxSpeed : cfg.maxSpeed;
        let thrust = 0;
        if (input.throttle > 0) {
            // Flat thrust. The top speed comes from drag cancelling it exactly
            // at cfg.maxSpeed (see quadraticDragFor) — NOT from tapering the
            // thrust as well, which would put the real ceiling somewhere below
            // the authored number and make maxSpeed a lie.
            thrust = input.throttle * (cfg.acceleration + (this.boosting ? cfg.boostAcceleration : 0));
        } else if (input.throttle < 0) {
            thrust = forwardSpeed > 0.5
                ? -cfg.brakeDecel * -input.throttle
                : -cfg.reverseAcceleration * -input.throttle
                    * Math.max(0, 1 - Math.max(0, -forwardSpeed) / cfg.reverseMaxSpeed);
        }
        // A propeller out of the water does nothing.
        if (this.onWater) {
            this.velX += fx * thrust * dt;
            this.velZ += fz * thrust * dt;
        }

        // ---- wave surfing ----
        // The heightfield normal is normalize(−∂h/∂x, 1, −∂h/∂z), so its
        // horizontal part already POINTS DOWNHILL. Push along it: down a face
        // is faster, up one is slower, with no special-casing.
        surface.normalAt(this.position.x, this.position.z, this.normal);
        if (this.onWater) {
            this.velX += this.normal.x * cfg.waveSurfAccel * dt;
            this.velZ += this.normal.z * cfg.waveSurfAccel * dt;
        }

        // ---- grip: bleed sideways velocity back into forward ----
        if (this.onWater) {
            const rx = fz;
            const rz = -fx;
            const lateral = this.velX * rx + this.velZ * rz;
            const bleed = Math.min(1, cfg.gripRate * dt);
            this.velX -= rx * lateral * bleed;
            this.velZ -= rz * lateral * bleed;
        }

        // ---- drag ----
        const sp = Math.hypot(this.velX, this.velZ);
        if (sp > 1e-5) {
            let decel = cfg.dragLinear + quadraticDragFor(cfg) * sp;
            // Boost raises the ceiling by adding thrust, so the extra speed has
            // to be given back when it ends: past the ACTIVE cap, drag climbs
            // steeply. Without this a boosted boat keeps its boost speed for
            // ever, because plain quadratic drag above maxSpeed is still small.
            if (sp > maxFwd) decel += (sp - maxFwd) * 4;
            const scale = Math.max(0, 1 - decel * dt);
            this.velX *= scale;
            this.velZ *= scale;
        }

        // ---- vertical: ride the wave, or fly off it ----
        this.surfaceY = surface.heightAt(this.position.x, this.position.z);
        const targetY = this.surfaceY + cfg.rideHeight;

        if (input.jump && this.onWater && cfg.jumpSpeed > 0) {
            this.onWater = false;
            this.velY = cfg.jumpSpeed;
        }

        let deltaY: number;
        if (this.onWater) {
            // Vertical speed the hull would need to stay glued this frame.
            const requiredVy = (targetY - this.position.y) / dt;
            // If staying glued means falling faster than gravity could pull us,
            // the water has run out from under the hull — that IS the launch.
            if (requiredVy < this.velY - cfg.gravity * dt - cfg.liftoffMargin) {
                this.onWater = false;
                // Carry the vertical speed we genuinely had. Never synthesize
                // one, or every crest becomes a trampoline.
                deltaY = this.velY * dt;
            } else {
                const settle = 1 - Math.exp(-cfg.buoyancyRate * dt);
                deltaY = (targetY - this.position.y) * settle;
                this.velY = deltaY / dt;
            }
        } else {
            deltaY = 0;
        }

        if (!this.onWater) {
            this.velY -= cfg.gravity * dt;
            deltaY = this.velY * dt;
            if (this.position.y + deltaY <= targetY) {
                deltaY = targetY - this.position.y;
                this.landingImpact = Math.max(0, -this.velY);
                // Splashdown scrubs speed in proportion to how hard it was.
                const loss = Math.min(0.6, this.landingImpact * cfg.landingSpeedLoss * 0.1);
                this.velX *= 1 - loss;
                this.velZ *= 1 - loss;
                this.velY = 0;
                this.onWater = true;
                this.airtime = 0;
            } else {
                this.airtime += dt;
            }
        } else {
            this.airtime = 0;
        }

        return this.desired.set(this.velX * dt, deltaY, this.velZ * dt);
    }

    /**
     * Apply the movement that actually happened. Pass `step`'s return value
     * unchanged when nothing can block the boat; pass the collision-clamped
     * result otherwise, and the motor will shed the velocity it did not get to
     * use — without that, pushing into a rock banks speed that releases the
     * instant the boat turns away.
     */
    commit(actual: THREE.Vector3, deltaTime: number): void {
        const dt = Math.max(1e-4, Math.min(0.1, deltaTime));
        const wantedX = this.velX * dt;
        const wantedZ = this.velZ * dt;
        this.position.add(actual);
        // Only ever REMOVE speed: collide-and-slide legitimately produces more
        // motion than we asked for (depenetration, sliding along a face), and
        // treating that as a gain would pump the boat forward.
        const gotX = actual.x;
        const gotZ = actual.z;
        if (Math.abs(gotX) < Math.abs(wantedX)) this.velX = gotX / dt;
        if (Math.abs(gotZ) < Math.abs(wantedZ)) this.velZ = gotZ / dt;
    }

    /**
     * The hull's orientation for this frame: heading, plus a partial match to
     * the water's tilt, plus roll into the turn and bow lift under power.
     * Smoothed, so a chop does not make the boat vibrate.
     */
    getPose(deltaTime: number, input: BoatInput, out: THREE.Quaternion): THREE.Quaternion {
        const cfg = this.config;
        const speedRatio = Math.min(1, Math.hypot(this.velX, this.velZ) / Math.max(1, cfg.maxSpeed));

        // Heading first, then tilt the whole thing onto the wave normal.
        this.tmpQuatA.setFromAxisAngle(UP, this.heading);
        // Airborne, relax toward level — matching a wave you are not touching
        // looks like the boat is magnetized to it.
        const alignAmount = this.onWater ? cfg.waveAlign : cfg.waveAlign * 0.25;
        this.tmpVec.copy(UP).lerp(this.normal, alignAmount).normalize();
        this.tmpQuatB.setFromUnitVectors(UP, this.tmpVec);
        this.tmpQuatB.multiply(this.tmpQuatA);

        // Roll into the turn and lift the bow under thrust, in the BOAT's own
        // frame — so they stay correct however the wave has tilted it.
        const lean = -input.steer * cfg.turnLeanDeg * DEG2RAD * speedRatio;
        const pitch = -Math.max(0, input.throttle) * cfg.bowLiftDeg * DEG2RAD * (1 - speedRatio * 0.5);
        this.tmpEuler.set(pitch, 0, lean, 'XYZ');
        this.tmpQuatA.setFromEuler(this.tmpEuler);
        this.tmpQuatB.multiply(this.tmpQuatA);

        if (!this.poseInitialized) {
            this.poseQuat.copy(this.tmpQuatB);
            this.poseInitialized = true;
        } else {
            this.poseQuat.slerp(this.tmpQuatB, Math.min(1, cfg.poseRate * deltaTime));
        }
        return out.copy(this.poseQuat);
    }

    /** Per-frame readback for HUDs, VFX and AI. The vector is reused — copy it. */
    getState(): BoatState {
        const fx = Math.sin(this.heading);
        const fz = Math.cos(this.heading);
        const speed = Math.hypot(this.velX, this.velZ);
        // Drift = |sin| of the angle between travel and where the bow points.
        const drift = speed > 1e-4
            ? Math.min(1, Math.abs((this.velX / speed) * fz - (this.velZ / speed) * fx))
            : 0;
        return {
            forwardSpeed: this.velX * fx + this.velZ * fz,
            speed,
            heading: this.heading,
            velocity: this.velocityOut.set(this.velX, this.velY, this.velZ),
            onWater: this.onWater,
            airtimeSeconds: this.airtime,
            drift,
            surfaceY: this.surfaceY,
            hullY: this.position.y,
            boosting: this.boosting,
            landingImpact: this.landingImpact,
        };
    }

    /** Water surface normal sampled this frame. Do not mutate. */
    getSurfaceNormal(): THREE.Vector3 { return this.normal; }
}
