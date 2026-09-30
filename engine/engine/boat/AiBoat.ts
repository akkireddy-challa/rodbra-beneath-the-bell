/**
 * A rival watercraft: the same `BoatMotor` the player drives, steered by a
 * look-ahead pursuit of the course centreline instead of by the keyboard.
 *
 * Sharing the motor is the whole point. A rival with its own bespoke movement
 * either glides over swells the player has to climb, or corners on rails the
 * player cannot match — and either way the race stops being a race. Here the AI
 * only produces a `BoatInput`; everything after that is identical to the
 * player's boat, wave launches included.
 *
 * Skill is expressed as speed limit + look-ahead + steering gain, not as a
 * cheat multiplier, so a slower rival is slower for reasons the player can see:
 * it takes wider lines and lifts earlier for corners.
 *
 * Usage:
 *   const rival = new AiBoat(scene, ocean, { waypoints: course.centerline });
 *   // per frame, after the ocean has been advanced:
 *   rival.update(deltaTime);
 */

import * as THREE from 'three';
import type { WaterSurfaceQuery } from 'engine/water/WaterSurfaceQuery.js';
import { BoatMotor, type BoatInput, type BoatState } from 'engine/boat/BoatMotor.js';
import { BoatHull } from 'engine/boat/BoatHull.js';
import { BoatWakeVFX } from 'engine/boat/BoatWakeVFX.js';
import { type BoatConfig, mergeBoatConfig } from 'engine/boat/BoatConfig.js';

export interface AiBoatOptions {
    /** Closed racing line to follow — `BoatRaceCourse.centerline` fits directly. */
    waypoints: readonly THREE.Vector3[];
    /** Handling. Lower `maxSpeed` here to make a rival genuinely slower. */
    config: Partial<BoatConfig>;
    /**
     * How far down the line the AI aims (m). Short = twitchy and tight; long =
     * smooth and wide. Scaled by speed at runtime.
     */
    lookAhead: number;
    /** Steering response. Above ~4 the boat starts weaving. */
    steerGain: number;
    /**
     * Lateral offset from the centreline (m). Give each rival its own so the
     * pack races in lanes instead of stacking into one conga line.
     */
    laneOffset: number;
    /** Draw wake and spray for this rival. Off for distant pack filler. */
    showWake: boolean;
    /** Start position along the line, as a waypoint index. */
    startIndex: number;
}

export const DEFAULT_AI_BOAT_OPTIONS: Omit<AiBoatOptions, 'waypoints'> = {
    config: {},
    lookAhead: 32,
    steerGain: 1.5,
    laneOffset: 0,
    showWake: true,
    startIndex: 0,
};

export class AiBoat {
    private readonly motor: BoatMotor;
    private readonly hull: BoatHull;
    private readonly wake: BoatWakeVFX | null;
    private readonly surface: WaterSurfaceQuery;
    private readonly waypoints: readonly THREE.Vector3[];
    private readonly opts: AiBoatOptions;
    private readonly scene: THREE.Object3D;

    /** Index of the waypoint currently being chased. */
    private target = 0;
    /** Laps completed, counted by wrapping past the last waypoint. */
    private laps = 0;

    private readonly input: BoatInput = { throttle: 1, steer: 0, boost: false, jump: false };
    private readonly position = new THREE.Vector3();
    private readonly poseQuat = new THREE.Quaternion();
    private readonly aim = new THREE.Vector3();
    private readonly scratch = new THREE.Vector3();

    constructor(
        scene: THREE.Object3D,
        surface: WaterSurfaceQuery,
        options: Partial<AiBoatOptions> & Pick<AiBoatOptions, 'waypoints'>,
    ) {
        this.opts = { ...DEFAULT_AI_BOAT_OPTIONS, ...options };
        this.scene = scene;
        this.surface = surface;
        this.waypoints = this.opts.waypoints;
        // A rival with no rider reads as an abandoned prop; the player's own
        // character rides their boat, so only AI opts in by default.
        const config = mergeBoatConfig({ showRider: true, ...this.opts.config });
        this.motor = new BoatMotor(config);
        this.hull = new BoatHull(config);
        this.wake = this.opts.showWake && config.showWake ? new BoatWakeVFX(scene, surface) : null;

        const n = this.waypoints.length;
        this.target = n > 0 ? (this.opts.startIndex + 1) % n : 0;
        const start = this.waypoints[this.opts.startIndex % Math.max(1, n)];
        const next = this.waypoints[this.target];
        const heading = start && next
            ? Math.atan2(next.x - start.x, next.z - start.z)
            : 0;
        const sx = start?.x ?? 0;
        const sz = start?.z ?? 0;
        this.motor.setPosition(sx, surface.heightAt(sx, sz) + config.rideHeight, sz, heading);
    }

    /** Advance the rival one frame. Call after the water surface has been advanced. */
    update(deltaTime: number): void {
        const n = this.waypoints.length;
        if (n < 2) return;
        this.motor.getPosition(this.position);
        const state = this.motor.getState();

        // ---- pick the aim point ----
        // Advance the target while it is behind us, so a rival that overshoots
        // a gate on a wave does not turn round and go back for it.
        const lookAhead = this.opts.lookAhead * (0.6 + 0.4 * Math.min(1, state.speed / 20));
        let guard = 0;
        while (guard++ < n) {
            const wp = this.waypoints[this.target]!;
            if (this.position.distanceTo(wp) > lookAhead) break;
            const next = (this.target + 1) % n;
            if (next === 0) this.laps++;
            this.target = next;
        }
        const wp = this.waypoints[this.target]!;
        // Offset the aim sideways into this rival's lane.
        const prev = this.waypoints[(this.target - 1 + n) % n]!;
        this.scratch.set(wp.x - prev.x, 0, wp.z - prev.z);
        if (this.scratch.lengthSq() > 1e-6) this.scratch.normalize();
        this.aim.set(
            wp.x + this.scratch.z * this.opts.laneOffset,
            0,
            wp.z - this.scratch.x * this.opts.laneOffset,
        );

        // ---- steer toward it ----
        const desiredHeading = Math.atan2(this.aim.x - this.position.x, this.aim.z - this.position.z);
        let error = desiredHeading - state.heading;
        // Shortest way round: without this the boat takes the long way through
        // a ±π wrap and spins on the spot.
        while (error > Math.PI) error -= Math.PI * 2;
        while (error < -Math.PI) error += Math.PI * 2;
        this.input.steer = Math.max(-1, Math.min(1, error * this.opts.steerGain));
        // Lift for corners: full lock at speed just washes the bow out.
        this.input.throttle = 1 - Math.min(0.4, Math.abs(this.input.steer) * 0.4);
        this.input.jump = false;
        this.input.boost = false;

        // ---- step (no collision: rivals race in open water) ----
        const delta = this.motor.step(deltaTime, this.input, this.surface);
        this.motor.commit(delta, deltaTime);
        this.motor.getPosition(this.position);
        this.motor.getPose(deltaTime, this.input, this.poseQuat);
        this.hull.syncTransform(this.scene, this.position, this.poseQuat);
        this.wake?.update(deltaTime, this.motor.getState(), this.position);
    }

    getState(): BoatState { return this.motor.getState(); }
    getPosition(out: THREE.Vector3): THREE.Vector3 { return this.motor.getPosition(out); }
    /** Laps completed since spawn — feed a standings HUD. */
    getLaps(): number { return this.laps; }
    /** Index of the centreline point being chased — a cheap progress metric. */
    getTargetIndex(): number { return this.target; }

    dispose(): void {
        this.hull.detach();
        this.wake?.dispose();
    }
}
