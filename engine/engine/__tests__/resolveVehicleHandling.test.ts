import { resolveVehicleHandling, handlingToAgentUnits, gateDriveForce, HANDLING_DEFAULTS } from 'engine/vehicleHandling.js';

const DEG2RAD = Math.PI / 180;

describe('resolveVehicleHandling', () => {
    it('uses the stock defaults at default size (sizeFactor = 1)', () => {
        const h = resolveVehicleHandling(undefined, 1);
        expect(h.topSpeed).toBeCloseTo(HANDLING_DEFAULTS.maxSpeedBase);
        expect(h.accelerationScale).toBeCloseTo(1); // min(1, 1^0.5)
        expect(h.maxSteerAngleRad).toBeCloseTo(HANDLING_DEFAULTS.maxSteerAngleRad);
        expect(h.steerSpeedRad).toBeCloseTo(HANDLING_DEFAULTS.steerSpeedRad);
        expect(h.steerReturnSpeedRad).toBeCloseTo(HANDLING_DEFAULTS.steerReturnSpeedRad);
        expect(h.steerSpeedFalloff).toBeCloseTo(HANDLING_DEFAULTS.steerSpeedFalloff);
        expect(h.minSteerAtSpeed).toBeCloseTo(HANDLING_DEFAULTS.minSteerAtSpeed);
    });

    it('scales top speed and acceleration DOWN for a smaller car', () => {
        const h = resolveVehicleHandling(undefined, 0.25);
        expect(h.topSpeed).toBeCloseTo(HANDLING_DEFAULTS.maxSpeedBase * Math.pow(0.25, 0.6));
        expect(h.accelerationScale).toBeCloseTo(Math.min(1, Math.pow(0.25, 0.5))); // 0.5
        // Steering defaults are not size-scaled (speed normalization lives in the controller).
        expect(h.maxSteerAngleRad).toBeCloseTo(HANDLING_DEFAULTS.maxSteerAngleRad);
    });

    it('never boosts acceleration for a larger car (default capped at 1)', () => {
        expect(resolveVehicleHandling(undefined, 2).accelerationScale).toBe(1);
    });

    it('lets each override win verbatim, converting degrees to radians', () => {
        const h = resolveVehicleHandling(
            { topSpeed: 30, maxSteerAngle: 45, steerSpeed: 180, accelerationScale: 2, steerSpeedFalloff: 0.3, minSteerAtSpeed: 0.1 },
            0.25, // a size that WOULD scale the defaults — overrides must ignore it
        );
        expect(h.topSpeed).toBe(30);
        expect(h.accelerationScale).toBe(2); // override is unclamped, so boosts (>1) work
        expect(h.maxSteerAngleRad).toBeCloseTo(45 * DEG2RAD);
        expect(h.steerSpeedRad).toBeCloseTo(180 * DEG2RAD);
        expect(h.steerSpeedFalloff).toBe(0.3);
        expect(h.minSteerAtSpeed).toBe(0.1);
    });

    it('merges a partial override with size-scaled defaults for the rest', () => {
        const h = resolveVehicleHandling({ topSpeed: 7 }, 0.25);
        expect(h.topSpeed).toBe(7); // overridden
        expect(h.accelerationScale).toBeCloseTo(Math.min(1, Math.pow(0.25, 0.5))); // still default-scaled
    });

    it('derives the reverse cap from the EFFECTIVE top speed, and lets it be overridden', () => {
        const derived = resolveVehicleHandling({ topSpeed: 40 }, 1);
        expect(derived.reverseTopSpeed).toBeCloseTo(40 * HANDLING_DEFAULTS.reverseSpeedFraction);
        expect(resolveVehicleHandling({ topSpeed: 40, reverseTopSpeed: 5 }, 1).reverseTopSpeed).toBe(5);
    });

    it('handlingToAgentUnits round-trips radians back to degrees', () => {
        const resolved = resolveVehicleHandling(undefined, 1);
        const agent = handlingToAgentUnits(resolved);
        expect(agent.maxSteerAngle).toBeCloseTo(HANDLING_DEFAULTS.maxSteerAngleRad / DEG2RAD);
        expect(agent.steerSpeed).toBeCloseTo(HANDLING_DEFAULTS.steerSpeedRad / DEG2RAD);
        expect(agent.topSpeed).toBeCloseTo(resolved.topSpeed);
        expect(agent.accelerationScale).toBeCloseTo(resolved.accelerationScale);
        expect(agent.reverseTopSpeed).toBeCloseTo(resolved.reverseTopSpeed);
    });
});

describe('gateDriveForce', () => {
    const h = { topSpeed: 14, reverseTopSpeed: 6 };

    it('passes drive through below both caps', () => {
        expect(gateDriveForce(2000, 5, h)).toBe(2000);
        expect(gateDriveForce(-2000, -5, h)).toBe(-2000);
    });

    it('cuts forward drive above top speed and reverse drive below the reverse cap', () => {
        expect(gateDriveForce(2000, 15, h)).toBe(0);
        expect(gateDriveForce(-2000, -7, h)).toBe(0);
    });

    // The "stuck S" regression: reversing past the FORWARD cap used to zero the
    // forward drive too, so W did nothing and the car coasted backwards.
    it('keeps full forward drive while reversing faster than the forward cap', () => {
        expect(gateDriveForce(2000, -20, h)).toBe(2000);
    });

    it('keeps full reverse drive while driving forwards faster than the reverse cap', () => {
        expect(gateDriveForce(-2000, 12, h)).toBe(-2000);
    });

    // Magnitude-based gating also cut the throttle mid-fall or on a fast slide,
    // where none of the speed is along the car's forward axis.
    it('ignores speed that is not along the forward axis', () => {
        expect(gateDriveForce(2000, 0, h)).toBe(2000);
    });
});
