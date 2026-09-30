/**
 * Tip-over guard math. Numbers mirror the platform-vehicle geometry
 * (VehiclePlatform: wheel inset z = length·0.4, connection y ≈ 0, rest length
 * 0.4, radius 0.4) and the incident configs: the forged 350 kg kart requested
 * 25 200 N total (4 driven wheels × 4200 N × 1.5 accel) and flipped on its
 * roof; the stock 1700 kg sedan requests 30 000 N and drives fine.
 */
import { maxTipSafeDriveForce, TIP_FORCE_MARGIN, type TipGeometry } from 'engine/physics/vehicleStability.js';

const SEDAN_GEOMETRY: TipGeometry = {
    minWheelZ: -1.36,
    maxWheelZ: 1.36,
    staticContactY: 0.005 - 0.4 - 0.4,
};

describe('maxTipSafeDriveForce', () => {
    it('clamps the flip-prone forged kart well below its requested total', () => {
        // Worst case (airborne fallback): COM ~0 above a fully extended contact.
        const comHeight = 0 - SEDAN_GEOMETRY.staticContactY;
        const max = maxTipSafeDriveForce(350, 9.81, comHeight, 0, SEDAN_GEOMETRY, true);
        // margin · m·g·(b/h) = 0.75 · 350 · 9.81 · 1.36/0.795 ≈ 4400 N — far
        // under the 25 200 N the config requests.
        expect(max).toBeGreaterThan(4000);
        expect(max).toBeLessThan(5000);
        expect(max).toBeLessThan(25200);
    });

    it('barely touches the stock sedan under live (compressed) contacts', () => {
        // Grounded: suspension carries the car ~half-compressed, COM ≈ 0.6 above contact.
        const max = maxTipSafeDriveForce(1700, 9.81, 0.6, 0, SEDAN_GEOMETRY, true);
        // ≈ 0.75 · 1700 · 9.81 · 1.36/0.6 ≈ 28 350 N vs 30 000 requested — a ~5% trim.
        expect(max).toBeGreaterThan(30000 * 0.9);
    });

    it('is direction-aware for an asymmetric COM', () => {
        const geometry: TipGeometry = { minWheelZ: -1.0, maxWheelZ: 2.0, staticContactY: -0.8 };
        const forward = maxTipSafeDriveForce(1000, 9.81, 0.8, 0.5, geometry, true);
        const reverse = maxTipSafeDriveForce(1000, 9.81, 0.8, 0.5, geometry, false);
        // Forward pivots on the rear axle (b = 0.5 − (−1) = 1.5); reverse on the
        // front (b = 2 − 0.5 = 1.5)… here equal; shift COM rearward and they split.
        expect(forward).toBeCloseTo(reverse, 6);
        const fwd2 = maxTipSafeDriveForce(1000, 9.81, 0.8, -0.5, geometry, true);
        const rev2 = maxTipSafeDriveForce(1000, 9.81, 0.8, -0.5, geometry, false);
        expect(fwd2).toBeLessThan(rev2); // COM near the rear axle → easier to wheelie
    });

    it('returns Infinity (no clamp) on degenerate geometry', () => {
        const g: TipGeometry = { minWheelZ: -1, maxWheelZ: 1, staticContactY: -0.8 };
        expect(maxTipSafeDriveForce(0, 9.81, 0.8, 0, g, true)).toBe(Infinity);
        expect(maxTipSafeDriveForce(1000, 9.81, 0.01, 0, g, true)).toBe(Infinity);   // COM at contact level
        expect(maxTipSafeDriveForce(1000, 9.81, 0.8, -2, g, true)).toBe(Infinity);   // COM behind the rear axle
    });

    it('scales linearly with margin, mass and gravity', () => {
        const g: TipGeometry = { minWheelZ: -1.2, maxWheelZ: 1.2, staticContactY: -0.7 };
        const base = maxTipSafeDriveForce(500, 9.81, 0.7, 0, g, true);
        expect(maxTipSafeDriveForce(1000, 9.81, 0.7, 0, g, true)).toBeCloseTo(base * 2, 6);
        expect(maxTipSafeDriveForce(500, 19.62, 0.7, 0, g, true)).toBeCloseTo(base * 2, 6);
        expect(maxTipSafeDriveForce(500, 9.81, 0.7, 0, g, true, TIP_FORCE_MARGIN / 2)).toBeCloseTo(base / 2, 6);
    });
});
