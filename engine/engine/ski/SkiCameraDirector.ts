/**
 * Ski/snowboard chase-camera director. Owns the chase-yaw state and a 3-state
 * machine (grounded / airborne / wipeout), and drives a duck-typed camera each
 * frame. The camera runs in "chase-damping" mode: the director feeds it the
 * desired (virtual) rig — orbit angle, elevation, distance — and per-axis
 * SmoothDamp time constants, and the camera SmoothDamps the REAL camera toward
 * that rig (vertical damped hard so terrain bumps don't pump the frame). All
 * camera feel for skiing lives here; SkiMovement supplies the per-frame
 * kinematics, the current mode, and obstacle-impact magnitudes.
 */

import type { SkiConfig } from 'engine/ski/SkiConfig.js';
import { computeSkiCameraTargets, type SkiCameraMode } from 'engine/ski/SkiCameraMath.js';

/**
 * Minimal camera surface the director drives. `driveOrbit` is required; the rest
 * are optional so legacy cameras without them are simply not fed those signals
 * (feature-detected, matching the existing engine pattern).
 */
export interface SkiDriveableCamera {
	driveOrbit(theta: number, phi: number, radius?: number, snap?: boolean): void;
	setChaseDamping?(opts: { horizontal: number; vertical: number; orbit: number } | null): void;
	setCollideWithEnvironment?(enabled: boolean): void;
	setFovOffset?(deltaDeg: number): void;
	clearFovOffset?(): void;
	applyShake?(intensity: number): void;
}

/** Per-frame kinematics the director needs from the movement system. */
export interface SkiCameraFrame {
	mode: SkiCameraMode;
	/** Horizontal velocity (m/s). */
	velX: number;
	velZ: number;
	/** Gameplay yaw fallback when nearly stationary (rad). */
	heading: number;
	/** Surface slope under the skier (deg). */
	slopeAngleDeg: number;
}

export class SkiCameraDirector {
	private config: SkiConfig;
	/** Chase yaw (rad); null = snap behind travel on the next update. */
	private camTheta: number | null = null;
	/** Accumulated impact-shake intensity to apply on the next drive(). */
	private pendingKick: number = 0;

	constructor(config: SkiConfig) {
		this.config = config;
	}

	/** Configure the camera for ski chase mode (called when the rider takes over). */
	activate(cam: SkiDriveableCamera): void {
		this.camTheta = null;
		this.pendingKick = 0;
		cam.setCollideWithEnvironment?.(this.config.cameraCollideEnvironment);
		// Seed damping immediately; drive() refreshes it per mode each frame.
		cam.setChaseDamping?.({
			horizontal: this.config.cameraHorizontalSmoothTime,
			vertical: this.config.cameraGroundSmoothTime,
			orbit: this.config.cameraOrbitSmoothTime,
		});
	}

	/** Hard cut: snap behind travel on the next update (run start, bail recovery). */
	reset(): void {
		this.camTheta = null;
	}

	/** Queue an impact shake (the "kick"), scaled from a speed loss elsewhere. */
	registerImpact(intensity: number): void {
		if (intensity > this.pendingKick) this.pendingKick = intensity;
	}

	/** Restore the camera to its non-ski defaults. */
	deactivate(cam: SkiDriveableCamera): void {
		cam.clearFovOffset?.();
		cam.setChaseDamping?.(null);
		cam.setCollideWithEnvironment?.(true);
		this.camTheta = null;
		this.pendingKick = 0;
	}

	drive(cam: SkiDriveableCamera, deltaTime: number, frame: SkiCameraFrame): void {
		const cfg = this.config;
		const speed = Math.hypot(frame.velX, frame.velZ);
		const targets = computeSkiCameraTargets(
			{ mode: frame.mode, speed, slopeAngleDeg: frame.slopeAngleDeg }, cfg,
		);

		const snap = this.camTheta === null;
		const dirX = speed > 1.5 ? frame.velX / speed : Math.sin(frame.heading);
		const dirZ = speed > 1.5 ? frame.velZ / speed : Math.cos(frame.heading);
		const desiredTheta = Math.atan2(dirX, dirZ) + Math.PI; // camera BEHIND travel

		if (this.camTheta === null) {
			// First frame (or post-reset): drop straight behind travel.
			this.camTheta = desiredTheta;
		} else if (frame.mode !== 'wipeout') {
			// Soft exponential catch-up. Wipeout deliberately freezes the yaw —
			// the camera loosens its grip and just watches the tumble drift by.
			let diff = desiredTheta - this.camTheta;
			while (diff > Math.PI) diff -= 2 * Math.PI;
			while (diff < -Math.PI) diff += 2 * Math.PI;
			this.camTheta += diff * (1 - Math.exp(-cfg.cameraFollowResponse * deltaTime));
		}

		cam.driveOrbit(this.camTheta, targets.phi, targets.radius, snap);
		cam.setChaseDamping?.(targets.damping);
		cam.setFovOffset?.(targets.fovGainDeg);

		if (this.pendingKick > 0) {
			cam.applyShake?.(this.pendingKick);
			this.pendingKick = 0;
		}
	}
}
