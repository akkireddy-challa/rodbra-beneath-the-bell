import { resolveThrottle, resolveBraking, THROTTLE_PARKING_BRAKE_EPSILON } from 'engine/vehicleHandling.js';

/**
 * Analog throttle/brake must be a pure superset of the boolean controls that
 * shipped games send: with the analog fields absent, every one of the eight
 * boolean combinations has to resolve to exactly what applyThrottleAndBrake
 * produced before analog existed. That equivalence is the whole backward-
 * compatibility promise of the change, so it is asserted exhaustively.
 */
describe('resolveThrottle', () => {
    it('reproduces the boolean model when no analog value is given', () => {
        expect(resolveThrottle(undefined, false, false)).toBe(0);
        expect(resolveThrottle(undefined, true, false)).toBe(1);
        expect(resolveThrottle(undefined, false, true)).toBe(-1);
        // forward wins over backward, matching the original if/else-if chain.
        expect(resolveThrottle(undefined, true, true)).toBe(1);
    });

    it('uses the analog value when given, ignoring the booleans', () => {
        expect(resolveThrottle(0.5, false, false)).toBe(0.5);
        expect(resolveThrottle(-0.25, true, false)).toBe(-0.25);
        expect(resolveThrottle(0, true, false)).toBe(0);
    });

    it('clamps the analog value to [-1, 1]', () => {
        expect(resolveThrottle(4, false, false)).toBe(1);
        expect(resolveThrottle(-4, false, false)).toBe(-1);
    });
});

describe('resolveBraking', () => {
    it('reproduces the boolean model when no analog value is given', () => {
        expect(resolveBraking(undefined, false)).toBe(0);
        expect(resolveBraking(undefined, true)).toBe(1);
    });

    it('uses the analog value when given, ignoring the boolean', () => {
        expect(resolveBraking(0.25, true)).toBe(0.25);
        expect(resolveBraking(0, true)).toBe(0);
    });

    it('clamps the analog value to [0, 1]', () => {
        expect(resolveBraking(2, false)).toBe(1);
        expect(resolveBraking(-1, false)).toBe(0);
    });
});

describe('THROTTLE_PARKING_BRAKE_EPSILON', () => {
    it('is small enough that a real throttle request always clears it', () => {
        expect(THROTTLE_PARKING_BRAKE_EPSILON).toBeGreaterThan(0);
        expect(THROTTLE_PARKING_BRAKE_EPSILON).toBeLessThan(0.05);
    });
});
