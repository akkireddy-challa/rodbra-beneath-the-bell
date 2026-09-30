/**
 * Pure feel math for the ski chase camera. No engine state, no allocation in
 * hot paths — everything here is unit-tested in isolation, mirroring SkiMath.ts.
 */

import { skiCameraElevationDeg } from 'engine/ski/SkiMath.js';

const DEG2RAD = Math.PI / 180;

export type SkiCameraMode = 'grounded' | 'airborne' | 'wipeout';

/** Structural config subset the camera math reads (SkiConfig satisfies it). */
export interface SkiCameraConfig {
	cameraDistance: number;
	cameraDistanceSpeedGain: number;
	tuckMaxSpeed: number;
	cameraElevationBaseDeg: number;
	cameraElevationSlopeFactor: number;
	cameraElevationMaxDeg: number;
	cameraGroundSmoothTime: number;
	cameraHorizontalSmoothTime: number;
	cameraOrbitSmoothTime: number;
	cameraAirSmoothTime: number;
	cameraFovSpeedGainDeg: number;
	cameraAirElevationDeg: number;
	cameraAirDistanceGain: number;
	cameraWipeoutElevationDeg: number;
	cameraWipeoutDistanceGain: number;
	cameraWipeoutSmoothTime: number;
}

export interface SkiCameraInput {
	mode: SkiCameraMode;
	/** Horizontal speed (m/s). */
	speed: number;
	/** Surface slope under the skier (deg); only meaningful when grounded. */
	slopeAngleDeg: number;
}

/**
 * Chase smoothing this frame (seconds). `horizontal`/`vertical` are per-axis
 * SmoothDamp times for the follow point (vertical hard = bump rejection); `orbit`
 * is the angular easing half-life for elevation/distance.
 */
export interface SkiCameraDamping {
	horizontal: number;
	vertical: number;
	orbit: number;
}

export interface SkiCameraTargets {
	/** Elevation above horizontal (deg). */
	elevationDeg: number;
	/** Spherical polar angle (rad) = PI/2 - elevation. */
	phi: number;
	/** Orbit radius (m). */
	radius: number;
	/** FOV to ADD on top of the camera's base FOV (deg). */
	fovGainDeg: number;
	/** SmoothDamp time constants for the real-camera chase this frame. */
	damping: SkiCameraDamping;
}

/** Extra FOV (deg) scaling 0..maxGain as speed rises to tuckMaxSpeed. */
export function skiCameraFovGain(speed: number, tuckMaxSpeed: number, maxGainDeg: number): number {
	if (maxGainDeg <= 0 || tuckMaxSpeed <= 0) return 0;
	const frac = Math.min(1, Math.max(0, speed / tuckMaxSpeed));
	return maxGainDeg * frac;
}

/** Chase distance: base grows with speed, plus a flat fractional gain (air/wipeout). */
export function skiCameraDistance(
	base: number,
	speedGain: number,
	speed: number,
	tuckMaxSpeed: number,
	extraGainFrac: number,
): number {
	const frac = tuckMaxSpeed > 0 ? Math.min(1, Math.max(0, speed / tuckMaxSpeed)) : 0;
	return base * (1 + speedGain * frac + extraGainFrac);
}

/** Per-frame camera targets for the current mode. Pure. */
export function computeSkiCameraTargets(input: SkiCameraInput, cfg: SkiCameraConfig): SkiCameraTargets {
	let elevationDeg: number;
	let extraDist: number;
	let damping: SkiCameraDamping;

	switch (input.mode) {
		case 'airborne':
			elevationDeg = cfg.cameraAirElevationDeg;
			extraDist = cfg.cameraAirDistanceGain;
			// Track the arc: vertical responsive, horizontal/orbit as on the ground.
			damping = {
				horizontal: cfg.cameraHorizontalSmoothTime,
				vertical: cfg.cameraAirSmoothTime,
				orbit: cfg.cameraOrbitSmoothTime,
			};
			break;
		case 'wipeout':
			elevationDeg = cfg.cameraWipeoutElevationDeg;
			extraDist = cfg.cameraWipeoutDistanceGain;
			// Loose and floaty on every axis — the camera drifts after the tumble.
			damping = {
				horizontal: cfg.cameraWipeoutSmoothTime,
				vertical: cfg.cameraWipeoutSmoothTime,
				orbit: cfg.cameraWipeoutSmoothTime,
			};
			break;
		case 'grounded':
		default:
			elevationDeg = skiCameraElevationDeg(
				input.slopeAngleDeg,
				cfg.cameraElevationBaseDeg,
				cfg.cameraElevationSlopeFactor,
				cfg.cameraElevationMaxDeg,
			);
			extraDist = 0;
			// Vertical damped hard (kill bumps); horizontal tight (responsive turn).
			damping = {
				horizontal: cfg.cameraHorizontalSmoothTime,
				vertical: cfg.cameraGroundSmoothTime,
				orbit: cfg.cameraOrbitSmoothTime,
			};
			break;
	}

	const radius = skiCameraDistance(
		cfg.cameraDistance, cfg.cameraDistanceSpeedGain, input.speed, cfg.tuckMaxSpeed, extraDist,
	);
	const fovGainDeg = skiCameraFovGain(input.speed, cfg.tuckMaxSpeed, cfg.cameraFovSpeedGainDeg);

	return {
		elevationDeg,
		phi: Math.PI / 2 - elevationDeg * DEG2RAD,
		radius,
		fovGainDeg,
		damping,
	};
}
