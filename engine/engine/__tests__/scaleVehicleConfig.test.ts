import { scaleVehicleConfig } from 'engine/vehicleConfigScaling.js';
import type { PlatformVehicleConfig } from 'engine/VehiclePlatform.js';

// Mirror of DEFAULT_RACING_CAR_CONFIG (kept local so the test imports only the
// pure scaling leaf module, not VehicleSpawner's heavy runtime deps).
const RACING: PlatformVehicleConfig = {
    width: 2.3,
    length: 3.4,
    mass: 1700,
    engineForce: 7500,
    frontWheels: { radius: 0.4, suspensionRestLength: 0.4, suspensionStiffness: 28, suspensionDamping: 1.3, friction: 130 },
    rearWheels: { radius: 0.4, suspensionRestLength: 0.4, suspensionStiffness: 38, suspensionDamping: 1.3, friction: 130 },
};

describe('scaleVehicleConfig', () => {
    it('scale=1 is an identity for every physics field', () => {
        const out = scaleVehicleConfig(RACING, 1);
        expect(out).toEqual(RACING);
    });

    it('applies the correct power law to each quantity at scale 0.25', () => {
        const s = 0.25;
        const out = scaleVehicleConfig(RACING, s);

        // geometry ∝ s
        expect(out.width).toBeCloseTo(2.3 * s);
        expect(out.length).toBeCloseTo(3.4 * s);
        expect(out.frontWheels!.radius).toBeCloseTo(0.4 * s);
        expect(out.frontWheels!.suspensionRestLength).toBeCloseTo(0.4 * s);

        // mass + engine force ∝ s³
        expect(out.mass).toBeCloseTo(1700 * s ** 3);
        expect(out.engineForce).toBeCloseTo(7500 * s ** 3);

        // suspension stiffness/damping + friction unchanged (rescaling sinks the car).
        expect(out.frontWheels!.suspensionStiffness).toBe(28);
        expect(out.rearWheels!.suspensionStiffness).toBe(38);
        expect(out.frontWheels!.suspensionDamping).toBe(1.3);
        expect(out.frontWheels!.friction).toBe(130);
        expect(out.rearWheels!.friction).toBe(130);
    });

    it('does not mutate the base config', () => {
        const snapshot = JSON.parse(JSON.stringify(RACING));
        scaleVehicleConfig(RACING, 0.1);
        expect(RACING).toEqual(snapshot);
    });

    it('handles configs that omit optional fields', () => {
        const minimal: PlatformVehicleConfig = { width: 2, length: 4 };
        const out = scaleVehicleConfig(minimal, 0.5);
        expect(out.width).toBeCloseTo(1);
        expect(out.length).toBeCloseTo(2);
        expect(out.mass).toBeUndefined();
        expect(out.frontWheels).toBeUndefined();
    });
});
