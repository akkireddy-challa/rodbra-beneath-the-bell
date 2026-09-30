import * as THREE from 'three';
import {
	downhillAcceleration,
	turnRateDegFor,
	carveVelocity,
	frictionMultipliers,
	nearestSpinRest,
	landingSpinErrorDeg,
	groundFollowDy,
	skiCameraElevationDeg,
	applyDrag,
	terminalSpeed,
	gripRateFor,
	wouldSeparate,
	surfaceFollowVy,
	evaluateLiftoff,
	type LiftoffInput,
} from 'engine/ski/SkiMath.js';

describe('skiCameraElevationDeg', () => {
	it('sits at the base on flat ground and rises faster than the slope', () => {
		expect(skiCameraElevationDeg(0, 14, 1.2, 65)).toBe(14);
		// 30 deg slope -> 14 + 36 = 50 deg: well above the 30 deg uphill
		// terrain line behind the skier (factor > 1 is the load-bearing bit).
		expect(skiCameraElevationDeg(30, 14, 1.2, 65)).toBeCloseTo(50, 6);
		expect(skiCameraElevationDeg(30, 14, 1.2, 65)).toBeGreaterThan(30);
	});

	it('clamps to the ceiling and never dips below base on negative slopes', () => {
		expect(skiCameraElevationDeg(80, 14, 1.2, 65)).toBe(65);
		expect(skiCameraElevationDeg(-20, 14, 1.2, 65)).toBe(14);
	});
});

const G = 35;

describe('groundFollowDy', () => {
	const dt = 1 / 60;

	it('is zero on flat ground', () => {
		expect(groundFollowDy(new THREE.Vector3(0, 1, 0), 28, 0, dt)).toBeCloseTo(0, 9);
	});

	// 30 degree slope descending toward +x: the surface normal leans
	// DOWNHILL, i.e. (+sin30, cos30, 0) — same convention
	// downhillAcceleration uses (downhill = horizontal normal direction).
	const slope30 = new THREE.Vector3(Math.sin(Math.PI / 6), Math.cos(Math.PI / 6), 0);

	it('matches speed * tan(slope) when moving straight downhill', () => {
		const dy = groundFollowDy(slope30, 28, 0, dt);
		expect(dy).toBeCloseTo(-28 * Math.tan(Math.PI / 6) * dt, 6);
		// At ski speed under a frame drop this EXCEEDS a walking-tuned
		// 0.5m snap budget — the reason descent must be explicit.
		expect(groundFollowDy(slope30, 28, 0, 1 / 30)).toBeLessThan(-0.5);
	});

	it('never returns a positive (launching) displacement when moving uphill', () => {
		expect(groundFollowDy(slope30, -28, 0, dt)).toBe(0);
	});

	it('moving across the slope stays level', () => {
		expect(groundFollowDy(slope30, 0, 28, dt)).toBeCloseTo(0, 9);
	});
});

describe('downhillAcceleration', () => {
	it('is zero on flat ground', () => {
		const out = new THREE.Vector3();
		downhillAcceleration(new THREE.Vector3(0, 1, 0), G, 1.0, out);
		expect(out.length()).toBeCloseTo(0, 6);
	});

	it('matches g*sin*cos on a 45 degree slope and points downhill', () => {
		// Slope rising toward +Z by 45 deg: normal = (0, cos45, -sin45).
		const n = new THREE.Vector3(0, Math.SQRT1_2, -Math.SQRT1_2);
		const out = new THREE.Vector3();
		downhillAcceleration(n, G, 1.0, out);
		// Horizontal slope accel = g * sin(t) * cos(t) = g * 0.5 at 45 deg.
		expect(out.z).toBeCloseTo(-G * 0.5, 4); // downhill is -Z
		expect(out.x).toBeCloseTo(0, 6);
		expect(out.y).toBe(0);
	});

	it('scales with slopeAccelFactor', () => {
		const n = new THREE.Vector3(0, Math.SQRT1_2, -Math.SQRT1_2);
		const out = new THREE.Vector3();
		downhillAcceleration(n, G, 0.5, out);
		expect(out.z).toBeCloseTo(-G * 0.25, 4);
	});
});

describe('turnRateDegFor', () => {
	const cfg = { turnRateLowDeg: 150, turnRateHighDeg: 55, maxSpeed: 28 };
	it('gives the low rate at or below 5 m/s', () => {
		expect(turnRateDegFor(0, cfg)).toBe(150);
		expect(turnRateDegFor(5, cfg)).toBe(150);
	});
	it('gives the high rate at or above maxSpeed', () => {
		expect(turnRateDegFor(28, cfg)).toBe(55);
		expect(turnRateDegFor(50, cfg)).toBe(55);
	});
	it('interpolates between', () => {
		const mid = turnRateDegFor((5 + 28) / 2, cfg);
		expect(mid).toBeGreaterThan(55);
		expect(mid).toBeLessThan(150);
	});
});

describe('carveVelocity', () => {
	it('converges velocity onto the heading and preserves most speed', () => {
		// Moving along +X at 10 m/s, heading +Z (yaw 0). Carve hard for 1 s total.
		let vx = 10, vz = 0;
		for (let i = 0; i < 60; i++) {
			const r = carveVelocity(vx, vz, 0, 5.5, 0.15, 1 / 60);
			vx = r.x; vz = r.z;
		}
		const speed = Math.hypot(vx, vz);
		expect(Math.abs(vx)).toBeLessThan(0.1);        // sideways gone
		expect(vz).toBeGreaterThan(7);                 // redirected forward
		expect(speed).toBeLessThan(10);                // some bleed
	});

	it('leaves aligned velocity untouched', () => {
		const r = carveVelocity(0, 12, 0, 5.5, 0.15, 1 / 60);
		expect(r.x).toBeCloseTo(0, 6);
		expect(r.z).toBeCloseTo(12, 6);
	});

	it('preserves travel direction when carving while moving backward along the heading', () => {
		// heading +Z, velocity backward (-Z) with a sideways (+X) slip
		let vx = 4, vz = -6;
		for (let i = 0; i < 60; i++) {
			const r = carveVelocity(vx, vz, 0, 5.5, 0.15, 1 / 60);
			vx = r.x; vz = r.z;
		}
		expect(Math.abs(vx)).toBeLessThan(0.1); // slip straightened out
		expect(vz).toBeLessThan(-7);            // still travelling backward, now aligned
	});
});

describe('frictionMultipliers', () => {
	it('is neutral at 0.5 (default block grip)', () => {
		const m = frictionMultipliers(0.5);
		expect(m.drag).toBeCloseTo(1.0, 6);
		expect(m.grip).toBeCloseTo(1.0, 6);
	});
	it('is slippery-fast on ice (low friction) and sluggish on grass (high)', () => {
		const ice = frictionMultipliers(0.1);
		const grass = frictionMultipliers(1.0);
		expect(ice.drag).toBeLessThan(1);
		expect(ice.grip).toBeLessThan(1);
		expect(grass.drag).toBeGreaterThan(1);
		expect(grass.grip).toBeGreaterThan(1);
	});
});

describe('spin landing helpers', () => {
	it('nearestSpinRest snaps to the closest full rotation', () => {
		expect(nearestSpinRest(20)).toBe(0);
		expect(nearestSpinRest(350)).toBe(360);
		expect(nearestSpinRest(-200)).toBe(-360);
	});
	it('landingSpinErrorDeg measures residual rotation', () => {
		expect(landingSpinErrorDeg(370)).toBeCloseTo(10, 6);
		expect(landingSpinErrorDeg(-90)).toBeCloseTo(90, 6);
		expect(landingSpinErrorDeg(720)).toBeCloseTo(0, 6);
	});
});

describe('applyDrag', () => {
	it('never reverses or overshoots through zero', () => {
		const r = applyDrag(10, 0, 0.002, 0.4, 1 / 60);
		expect(r.x).toBeGreaterThan(0);
		expect(r.x).toBeLessThan(10);
		expect(r.z).toBe(0);
	});

	it('keeps a near-zero velocity at rest', () => {
		const r = applyDrag(0, 0, 0.002, 0.4, 1 / 60);
		expect(Math.hypot(r.x, r.z)).toBeLessThan(1e-6);
	});

	it('removes more speed under stronger drag', () => {
		const light = applyDrag(10, 0, 0.001, 0.2, 1 / 60);
		const heavy = applyDrag(10, 0, 0.01, 1.0, 1 / 60);
		expect(heavy.x).toBeLessThan(light.x);
	});
});

describe('terminalSpeed', () => {
	it('rises monotonically with slope-gravity and stays finite', () => {
		const airK = 0.002, snowK = 0.4;
		const speeds = [2, 6, 10, 14].map((aG) => terminalSpeed(aG, airK, snowK));
		for (let i = 1; i < speeds.length; i++) {
			expect(speeds[i]).toBeGreaterThan(speeds[i - 1]);
			expect(Number.isFinite(speeds[i])).toBe(true);
		}
	});

	it('is zero on flat (no driving accel)', () => {
		expect(terminalSpeed(0, 0.002, 0.4)).toBeCloseTo(0, 6);
	});

	it('falls back to linear balance when air drag is negligible', () => {
		expect(terminalSpeed(8, 0, 0.4)).toBeCloseTo(20, 6);
	});
});

describe('gripRateFor', () => {
	const cfg = { gripRateLow: 7, gripRateHigh: 2, maxSpeed: 30 };

	it('is firm at low speed, loose at high speed, monotonic down', () => {
		expect(gripRateFor(0, cfg)).toBeCloseTo(7);
		expect(gripRateFor(30, cfg)).toBeCloseTo(2);
		expect(gripRateFor(15, cfg)).toBeLessThan(7);
		expect(gripRateFor(15, cfg)).toBeGreaterThan(2);
	});

	it('clamps above maxSpeed', () => {
		expect(gripRateFor(99, cfg)).toBeCloseTo(2);
	});
});

describe('wouldSeparate', () => {
	it('lifts off on a convex roll (must drop faster than free-fall)', () => {
		expect(wouldSeparate(0.30, 0.10, 0.02)).toBe(true);
	});

	it('stays glued when gravity covers the drop', () => {
		expect(wouldSeparate(0.05, 0.10, 0.02)).toBe(false);
	});

	it('keeps micro-bumps glued within the stick margin', () => {
		expect(wouldSeparate(0.11, 0.10, 0.02)).toBe(false);
	});
});

describe('surfaceFollowVy', () => {
	it('is zero on flat ground', () => {
		expect(surfaceFollowVy(new THREE.Vector3(0, 1, 0), 10, 5)).toBeCloseTo(0, 6);
	});
	it('is negative descending a slope, positive rising up a bump face', () => {
		// 30deg slope descending toward +X -> normal (sin30, cos30, 0); moving +X = downhill.
		const down = surfaceFollowVy(new THREE.Vector3(0.5, 0.8660254, 0), 10, 0);
		expect(down).toBeLessThan(0);
		expect(down).toBeCloseTo(-10 * Math.tan(30 * Math.PI / 180), 4);
		// 30deg face rising toward +X -> normal (-sin30, cos30, 0); moving +X = up the face.
		const up = surfaceFollowVy(new THREE.Vector3(-0.5, 0.8660254, 0), 10, 0);
		expect(up).toBeGreaterThan(0);
		expect(up).toBeCloseTo(10 * Math.tan(30 * Math.PI / 180), 4);
	});
});

describe('evaluateLiftoff (inertia model)', () => {
	const g = 15;
	const dt = 1 / 60;
	const base: LiftoffInput = {
		followDescent: 0, actualVy: 0, gravity: g, dt, stable: true,
		margin: 0.005, launchVyMax: 12, terminalVelocity: 53,
	};

	it('stays glued on a constant slope (gravity covers the descent)', () => {
		// 30deg at 30 m/s -> descent 15 m/s -> 0.25 m/frame; gravity delivers slightly more.
		expect(evaluateLiftoff({ ...base, actualVy: -15, followDescent: 15 * dt }).separate).toBe(false);
	});

	it('launches off a crest ONLY with the velocity it already had (was rising)', () => {
		const r = evaluateLiftoff({ ...base, actualVy: 3, followDescent: 0.3 });
		expect(r.separate).toBe(true);
		expect(r.launchVy).toBeCloseTo(3 - g * dt, 6); // its real rise, minus a frame of gravity
	});

	it('LAW OF INERTIA: going straight over a bump never adds upward velocity', () => {
		// actualVy ~ 0 (was going straight). The surface falls away -> separate, but
		// the carried velocity is NEVER positive: no bounce.
		const r = evaluateLiftoff({ ...base, actualVy: 0, followDescent: 0.05 });
		expect(r.launchVy).toBeLessThanOrEqual(0);
		// And for any non-rising board, the launch velocity stays non-positive.
		expect(evaluateLiftoff({ ...base, actualVy: -5, followDescent: 0.5 }).launchVy).toBeLessThanOrEqual(0);
	});

	it('detaches over a cliff carrying the (downward) real velocity', () => {
		const r = evaluateLiftoff({ ...base, actualVy: -10, followDescent: 2.0 });
		expect(r.separate).toBe(true);
		expect(r.launchVy).toBeCloseTo(-10 - g * dt, 6);
	});

	it('clamps an anomalous fast rise to launchVyMax (glitch safety net)', () => {
		const r = evaluateLiftoff({ ...base, actualVy: 20, followDescent: 3 });
		expect(r.separate).toBe(true);
		expect(r.launchVy).toBe(12);
	});

	it('never separates until grounded-stable (2-frame arm)', () => {
		expect(evaluateLiftoff({ ...base, actualVy: 3, followDescent: 0.3, stable: false }).separate).toBe(false);
	});
});
