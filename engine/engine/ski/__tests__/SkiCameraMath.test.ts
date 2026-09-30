import {
	skiCameraFovGain,
	skiCameraDistance,
	computeSkiCameraTargets,
	type SkiCameraConfig,
} from 'engine/ski/SkiCameraMath.js';

const CFG: SkiCameraConfig = {
	cameraDistance: 6,
	cameraDistanceSpeedGain: 0.35,
	tuckMaxSpeed: 38,
	cameraElevationBaseDeg: 14,
	cameraElevationSlopeFactor: 1.2,
	cameraElevationMaxDeg: 65,
	cameraGroundSmoothTime: 0.5,
	cameraHorizontalSmoothTime: 0.18,
	cameraOrbitSmoothTime: 0.3,
	cameraAirSmoothTime: 0.12,
	cameraFovSpeedGainDeg: 12,
	cameraAirElevationDeg: 32,
	cameraAirDistanceGain: 0.4,
	cameraWipeoutElevationDeg: 28,
	cameraWipeoutDistanceGain: 0.6,
	cameraWipeoutSmoothTime: 0.45,
};
const DEG2RAD = Math.PI / 180;

describe('skiCameraFovGain', () => {
	it('is zero at rest, full at tuck max, half at half, and disabled at 0 gain', () => {
		expect(skiCameraFovGain(0, 38, 12)).toBe(0);
		expect(skiCameraFovGain(38, 38, 12)).toBeCloseTo(12, 6);
		expect(skiCameraFovGain(76, 38, 12)).toBeCloseTo(12, 6); // clamped
		expect(skiCameraFovGain(19, 38, 12)).toBeCloseTo(6, 6);
		expect(skiCameraFovGain(38, 38, 0)).toBe(0);
	});
});

describe('skiCameraDistance', () => {
	it('grows with speed and adds the extra fraction', () => {
		expect(skiCameraDistance(6, 0.35, 0, 38, 0)).toBeCloseTo(6, 6);
		expect(skiCameraDistance(6, 0.35, 38, 38, 0)).toBeCloseTo(6 * 1.35, 6);
		expect(skiCameraDistance(6, 0.35, 0, 38, 0.4)).toBeCloseTo(6 * 1.4, 6);
	});
});

describe('computeSkiCameraTargets', () => {
	it('grounded: slope elevation, hard vertical damping, tight horizontal, no extra distance', () => {
		const t = computeSkiCameraTargets({ mode: 'grounded', speed: 0, slopeAngleDeg: 30 }, CFG);
		expect(t.elevationDeg).toBeCloseTo(50, 6); // 14 + 30*1.2
		expect(t.phi).toBeCloseTo(Math.PI / 2 - 50 * DEG2RAD, 6);
		expect(t.radius).toBeCloseTo(6, 6);
		expect(t.damping.vertical).toBe(0.5);     // bumps killed
		expect(t.damping.horizontal).toBe(0.18);  // turning responsive
		expect(t.damping.orbit).toBe(0.3);        // pitch eases, never jumps
	});

	it('airborne: fixed elevation, responsive vertical (track arc), pulled back', () => {
		const t = computeSkiCameraTargets({ mode: 'airborne', speed: 0, slopeAngleDeg: 5 }, CFG);
		expect(t.elevationDeg).toBe(32);
		expect(t.damping.vertical).toBe(0.12);    // tracks the parabola
		expect(t.damping.horizontal).toBe(0.18);
		expect(t.radius).toBeCloseTo(6 * 1.4, 6); // base + air gain at speed 0
	});

	it('wipeout: loose damping on every axis, pulled further back', () => {
		const t = computeSkiCameraTargets({ mode: 'wipeout', speed: 0, slopeAngleDeg: 5 }, CFG);
		expect(t.elevationDeg).toBe(28);
		expect(t.damping.vertical).toBe(0.45);
		expect(t.damping.horizontal).toBe(0.45);
		expect(t.damping.orbit).toBe(0.45);
		expect(t.radius).toBeCloseTo(6 * 1.6, 6);
	});

	it('fov gain rides on speed regardless of mode', () => {
		const t = computeSkiCameraTargets({ mode: 'grounded', speed: 38, slopeAngleDeg: 0 }, CFG);
		expect(t.fovGainDeg).toBeCloseTo(12, 6);
	});
});
