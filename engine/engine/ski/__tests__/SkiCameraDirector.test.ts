import { SkiCameraDirector, type SkiDriveableCamera } from 'engine/ski/SkiCameraDirector.js';
import { DEFAULT_SKI_CONFIG } from 'engine/ski/SkiConfig.js';

function makeFakeCam() {
	const calls = {
		orbit: [] as Array<{ theta: number; phi: number; radius?: number; snap?: boolean }>,
		damping: [] as Array<{ horizontal: number; vertical: number; orbit: number } | null>,
		collideEnv: [] as boolean[],
		fov: [] as number[],
		shake: [] as number[],
		clearedFov: 0,
	};
	const cam: SkiDriveableCamera = {
		driveOrbit(theta, phi, radius, snap) { calls.orbit.push({ theta, phi, radius, snap }); },
		setChaseDamping(opts) { calls.damping.push(opts); },
		setCollideWithEnvironment(enabled) { calls.collideEnv.push(enabled); },
		setFovOffset(d) { calls.fov.push(d); },
		clearFovOffset() { calls.clearedFov++; },
		applyShake(i) { calls.shake.push(i); },
	};
	return { cam, calls };
}

const DT = 1 / 60;

describe('SkiCameraDirector', () => {
	it('snaps behind travel on the first frame, then eases', () => {
		const d = new SkiCameraDirector({ ...DEFAULT_SKI_CONFIG });
		const { cam, calls } = makeFakeCam();
		d.drive(cam, DT, { mode: 'grounded', velX: 0, velZ: 10, heading: 0, slopeAngleDeg: 0 });
		expect(calls.orbit[0].snap).toBe(true);
		expect(calls.orbit[0].theta).toBeCloseTo(Math.PI, 6); // behind +Z travel
		d.drive(cam, DT, { mode: 'grounded', velX: 0, velZ: 10, heading: 0, slopeAngleDeg: 0 });
		expect(calls.orbit[1].snap).toBe(false);
	});

	it('grounded damps vertical hard; airborne damps vertical responsively', () => {
		const d = new SkiCameraDirector({ ...DEFAULT_SKI_CONFIG });
		const { cam, calls } = makeFakeCam();
		d.drive(cam, DT, { mode: 'grounded', velX: 0, velZ: 10, heading: 0, slopeAngleDeg: 0 });
		expect(calls.damping.at(-1)!.vertical).toBe(DEFAULT_SKI_CONFIG.cameraGroundSmoothTime);
		expect(calls.damping.at(-1)!.horizontal).toBe(DEFAULT_SKI_CONFIG.cameraHorizontalSmoothTime);
		d.drive(cam, DT, { mode: 'airborne', velX: 0, velZ: 10, heading: 0, slopeAngleDeg: 0 });
		expect(calls.damping.at(-1)!.vertical).toBe(DEFAULT_SKI_CONFIG.cameraAirSmoothTime);
	});

	it('wipeout loosens the follow: yaw frozen + loose damping on all axes', () => {
		const d = new SkiCameraDirector({ ...DEFAULT_SKI_CONFIG });
		const { cam, calls } = makeFakeCam();
		d.drive(cam, DT, { mode: 'grounded', velX: 0, velZ: 10, heading: 0, slopeAngleDeg: 0 });
		const established = calls.orbit.at(-1)!.theta;
		d.drive(cam, DT, { mode: 'wipeout', velX: 0, velZ: -10, heading: 0, slopeAngleDeg: 0 });
		expect(calls.orbit.at(-1)!.theta).toBeCloseTo(established, 6); // not chased
		const damp = calls.damping.at(-1)!;
		expect(damp.vertical).toBe(DEFAULT_SKI_CONFIG.cameraWipeoutSmoothTime);
		expect(damp.horizontal).toBe(DEFAULT_SKI_CONFIG.cameraWipeoutSmoothTime);
		expect(damp.orbit).toBe(DEFAULT_SKI_CONFIG.cameraWipeoutSmoothTime);
	});

	it('feeds a speed FOV offset', () => {
		const d = new SkiCameraDirector({ ...DEFAULT_SKI_CONFIG });
		const { cam, calls } = makeFakeCam();
		d.drive(cam, DT, {
			mode: 'grounded', velX: 0, velZ: DEFAULT_SKI_CONFIG.tuckMaxSpeed, heading: 0, slopeAngleDeg: 0,
		});
		expect(calls.fov.at(-1)).toBeCloseTo(DEFAULT_SKI_CONFIG.cameraFovSpeedGainDeg, 6);
	});

	it('activate configures collision (env off by default) and arms a snap', () => {
		const d = new SkiCameraDirector({ ...DEFAULT_SKI_CONFIG });
		const { cam, calls } = makeFakeCam();
		d.activate(cam);
		expect(calls.collideEnv.at(-1)).toBe(false); // no tree/rock snapping
		d.drive(cam, DT, { mode: 'grounded', velX: 0, velZ: 10, heading: 0, slopeAngleDeg: 0 });
		expect(calls.orbit.at(-1)!.snap).toBe(true);
	});

	it('registers an impact kick, applied once on the next drive', () => {
		const d = new SkiCameraDirector({ ...DEFAULT_SKI_CONFIG });
		const { cam, calls } = makeFakeCam();
		d.registerImpact(0.15);
		d.drive(cam, DT, { mode: 'grounded', velX: 0, velZ: 10, heading: 0, slopeAngleDeg: 0 });
		expect(calls.shake).toEqual([0.15]);
		// Not re-applied on the following frame.
		d.drive(cam, DT, { mode: 'grounded', velX: 0, velZ: 10, heading: 0, slopeAngleDeg: 0 });
		expect(calls.shake).toEqual([0.15]);
	});

	it('deactivate restores camera defaults', () => {
		const d = new SkiCameraDirector({ ...DEFAULT_SKI_CONFIG });
		const { cam, calls } = makeFakeCam();
		d.deactivate(cam);
		expect(calls.clearedFov).toBe(1);
		expect(calls.damping.at(-1)).toBeNull();
		expect(calls.collideEnv.at(-1)).toBe(true);
	});

	it('reset forces the next frame to snap again', () => {
		const d = new SkiCameraDirector({ ...DEFAULT_SKI_CONFIG });
		const { cam, calls } = makeFakeCam();
		d.drive(cam, DT, { mode: 'grounded', velX: 0, velZ: 10, heading: 0, slopeAngleDeg: 0 });
		d.reset();
		d.drive(cam, DT, { mode: 'grounded', velX: 0, velZ: 10, heading: 0, slopeAngleDeg: 0 });
		expect(calls.orbit.at(-1)!.snap).toBe(true);
	});
});
