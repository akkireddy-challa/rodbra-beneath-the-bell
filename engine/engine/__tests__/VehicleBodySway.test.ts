import {
    VehicleBodySway,
    DEFAULT_VEHICLE_BODY_SWAY,
    type VehicleBodySwayOptions,
} from 'engine/vehicle/VehicleBodySway.js';

/**
 * The body leans AWAY from the force the tyres apply: out of a corner, nose-down
 * under braking, nose-up under power. Sign conventions are the easy thing to get
 * backwards, so they are asserted explicitly (body frame: +Z forward, positive
 * roll raises the +X side, positive pitch drops the nose).
 */

const DT = 1 / 60;
const G = 9.81;
const RAD2DEG = 180 / Math.PI;

/** Hold a steady cornering state until the spring settles. */
function corner(sway: VehicleBodySway, forwardSpeed: number, yawRate: number, seconds = 4) {
    let out = sway.getAngles();
    for (let t = 0; t < seconds; t += DT) out = sway.update(DT, { forwardSpeed, yawRate });
    return out;
}

/** Accelerate at a constant rate (m/s²) from rest and settle. */
function accelerate(sway: VehicleBodySway, rate: number, seconds = 4) {
    let speed = 0;
    let out = sway.getAngles();
    for (let t = 0; t < seconds; t += DT) {
        speed += rate * DT;
        out = sway.update(DT, { forwardSpeed: speed, yawRate: 0 });
    }
    return out;
}

describe('VehicleBodySway direction', () => {
    it('leans OUT of a corner — turning toward +X raises the +X side', () => {
        const { rollRad } = corner(new VehicleBodySway(), 20, 0.4);
        expect(rollRad).toBeGreaterThan(0);
    });

    it('mirrors the lean when the turn reverses', () => {
        const left = corner(new VehicleBodySway(), 20, 0.4).rollRad;
        const right = corner(new VehicleBodySway(), 20, -0.4).rollRad;
        expect(right).toBeLessThan(0);
        expect(right).toBeCloseTo(-left, 6);
    });

    it('dives (nose down) under braking and squats (nose up) under power', () => {
        expect(accelerate(new VehicleBodySway(), -5).pitchRad).toBeGreaterThan(0); // braking
        expect(accelerate(new VehicleBodySway(), 5).pitchRad).toBeLessThan(0);     // power
    });

    it('stays level in a straight line at constant speed', () => {
        const sway = new VehicleBodySway();
        let out = sway.getAngles();
        for (let t = 0; t < 3; t += DT) out = sway.update(DT, { forwardSpeed: 25, yawRate: 0 });
        expect(Math.abs(out.rollRad)).toBeLessThan(1e-6);
        expect(Math.abs(out.pitchRad)).toBeLessThan(1e-3);
    });
});

describe('VehicleBodySway is calibrated in degrees per g', () => {
    it('settles at rollDegPerG × the corner load', () => {
        // 20 m/s at 0.4 rad/s → 8 m/s² lateral ≈ 0.815 g (under the 8° cap).
        const { rollRad } = corner(new VehicleBodySway(), 20, 0.4);
        const expectedDeg = DEFAULT_VEHICLE_BODY_SWAY.rollDegPerG * ((20 * 0.4) / G);
        expect(rollRad * RAD2DEG).toBeCloseTo(expectedDeg, 1);
    });

    it('is size-agnostic — same load, same lean, whatever the vehicle', () => {
        // A slow tight corner and a fast wide one at equal lateral g must match.
        const tight = corner(new VehicleBodySway(), 8, 1.0).rollRad;   // 8 m/s²
        const wide = corner(new VehicleBodySway(), 40, 0.2).rollRad;   // 8 m/s²
        expect(tight).toBeCloseTo(wide, 6);
    });

    it('caps roll and pitch however hard it is driven', () => {
        const max = DEFAULT_VEHICLE_BODY_SWAY.maxRollDeg / RAD2DEG;
        const { rollRad } = corner(new VehicleBodySway(), 60, 2.0); // ~12 g
        expect(Math.abs(rollRad)).toBeLessThanOrEqual(max + 1e-6);

        const maxPitch = DEFAULT_VEHICLE_BODY_SWAY.maxPitchDeg / RAD2DEG;
        const { pitchRad } = accelerate(new VehicleBodySway(), -40);
        expect(Math.abs(pitchRad)).toBeLessThanOrEqual(maxPitch + 1e-6);
    });
});

describe('VehicleBodySway has inertia', () => {
    it('rolls in over time rather than snapping to the target', () => {
        const sway = new VehicleBodySway();
        const settled = DEFAULT_VEHICLE_BODY_SWAY.rollDegPerG * ((20 * 0.4) / G) / RAD2DEG;
        // One frame of a hard corner must not deliver the whole lean.
        const first = sway.update(DT, { forwardSpeed: 20, yawRate: 0.4 }).rollRad;
        expect(Math.abs(first)).toBeLessThan(Math.abs(settled) * 0.2);
    });

    it('returns to level once the corner is over', () => {
        const sway = new VehicleBodySway();
        const leaned = corner(sway, 20, 0.4).rollRad;
        expect(Math.abs(leaned)).toBeGreaterThan(0.01);
        let out = sway.getAngles();
        for (let t = 0; t < 4; t += DT) out = sway.update(DT, { forwardSpeed: 20, yawRate: 0 });
        expect(Math.abs(out.rollRad)).toBeLessThan(Math.abs(leaned) * 0.05);
    });

    it('survives a frame-time spike without flinging the body', () => {
        const sway = new VehicleBodySway();
        const { rollRad } = sway.update(3.0, { forwardSpeed: 30, yawRate: 1.5 }); // 3s stall
        const max = DEFAULT_VEHICLE_BODY_SWAY.maxRollDeg / RAD2DEG;
        expect(Number.isFinite(rollRad)).toBe(true);
        expect(Math.abs(rollRad)).toBeLessThanOrEqual(max + 1e-6);
    });

    it('reset() clears the lean and the speed history', () => {
        const sway = new VehicleBodySway();
        corner(sway, 20, 0.4);
        sway.reset();
        expect(sway.getAngles()).toEqual({ rollRad: 0, pitchRad: 0 });
        // No phantom acceleration from the pre-reset speed on the next frame.
        const { pitchRad } = sway.update(DT, { forwardSpeed: 20, yawRate: 0 });
        expect(Math.abs(pitchRad)).toBeLessThan(1e-9);
    });

    it('honours per-vehicle overrides', () => {
        // A light corner (10 m/s at 0.4 rad/s ≈ 0.41 g) so doubling the roll
        // gradient stays clear of maxRollDeg — the cap has its own test.
        const soft: Partial<VehicleBodySwayOptions> = { rollDegPerG: 12 };
        const stock = corner(new VehicleBodySway(), 10, 0.4).rollRad;
        const leany = corner(new VehicleBodySway({ ...DEFAULT_VEHICLE_BODY_SWAY, ...soft }), 10, 0.4).rollRad;
        expect(Math.abs(leany) * RAD2DEG).toBeLessThan(DEFAULT_VEHICLE_BODY_SWAY.maxRollDeg);
        expect(leany).toBeCloseTo(stock * 2, 3);
    });
});
