// Size-scaling for vehicle configs. Pure (type-only imports), unit-testable in isolation.
import type { PlatformVehicleConfig, PlatformWheelConfig } from 'engine/VehiclePlatform.js';

/**
 * Return a dynamically-consistent size-scaled copy of a vehicle config.
 * Power laws: geometry ∝ s, mass + engine force ∝ s³, suspension stiffness/damping + friction unchanged.
 * Suspension spring constants are NOT rescaled — Rapier's mass-tracking max-force holds ride height across sizes.
 *
 * @param base  a known-good config (e.g. `DEFAULT_RACING_CAR_CONFIG`)
 * @param scale linear scale factor (0.25 = quarter-size RC car, 2 = double-size)
 */
export function scaleVehicleConfig(base: PlatformVehicleConfig, scale: number): PlatformVehicleConfig {
    const s = scale;
    const s3 = s * s * s;

    const scaleWheel = (w: PlatformWheelConfig | undefined): PlatformWheelConfig | undefined => {
        if (!w) return undefined;
        return {
            ...w, // stiffness, damping, friction, isDriven, torqueRatio, color: kept as-is
            radius: w.radius * s,
            ...(w.width !== undefined ? { width: w.width * s } : {}),
            ...(w.suspensionRestLength !== undefined ? { suspensionRestLength: w.suspensionRestLength * s } : {}),
        };
    };

    return {
        ...base, // suspensionStiffness/Damping, friction, wheelCount, colors: kept as-is
        width: base.width * s,
        length: base.length * s,
        ...(base.frontWheels ? { frontWheels: scaleWheel(base.frontWheels) } : {}),
        ...(base.rearWheels ? { rearWheels: scaleWheel(base.rearWheels) } : {}),
        ...(base.middleWheels ? { middleWheels: scaleWheel(base.middleWheels) } : {}),
        ...(base.wheelRadius !== undefined ? { wheelRadius: base.wheelRadius * s } : {}),
        ...(base.wheelWidth !== undefined ? { wheelWidth: base.wheelWidth * s } : {}),
        ...(base.mass !== undefined ? { mass: base.mass * s3 } : {}),
        ...(base.engineForce !== undefined ? { engineForce: base.engineForce * s3 } : {}),
    };
}
