import { resolveSteering } from 'engine/vehicleHandling.js';

/**
 * Regression guard for the 2026-08-11 "touch steering is over-sensitive" bug:
 * MobileControls produced an analog steering axis, PlayerController thresholded
 * it into keys.left/right at 0.1, and the vehicle then RAMPED the wheel toward
 * full lock for as long as that boolean was held — keyboard behaviour. A gentle
 * touch deflection therefore wound up at maximum steering after a few frames.
 * Analog inputs must POSITION the wheel instead.
 */
describe('resolveSteering', () => {
    const MAX = 0.6;        // effective max steering angle (radians)
    const RAMP = 0.05;      // per-frame ramp toward lock (boolean path)
    const RETURN = 0.04;    // per-frame unwind toward centre

    describe('analog (touch pill, gamepad stick)', () => {
        it('sets a partial deflection directly, and HOLDS it frame after frame', () => {
            let steering = resolveSteering(-0.25, false, true, 0, MAX, RAMP, RETURN);
            expect(steering).toBeCloseTo(-0.25 * MAX);
            // The bug: repeated frames used to creep to full lock. They must not.
            for (let i = 0; i < 100; i++) {
                steering = resolveSteering(-0.25, false, true, steering, MAX, RAMP, RETURN);
            }
            expect(steering).toBeCloseTo(-0.25 * MAX);
        });

        it('follows the axis back the other way instantly (no unwind lag)', () => {
            const locked = resolveSteering(1, true, false, 0, MAX, RAMP, RETURN);
            expect(locked).toBeCloseTo(MAX);
            // One frame later the finger has moved right of centre: the wheel is
            // already there, not RAMP radians into a slow return.
            expect(resolveSteering(-0.5, false, true, locked, MAX, RAMP, RETURN)).toBeCloseTo(-0.5 * MAX);
        });

        it('clamps out-of-range axis values to full lock', () => {
            expect(resolveSteering(3, false, false, 0, MAX, RAMP, RETURN)).toBeCloseTo(MAX);
            expect(resolveSteering(-3, false, false, 0, MAX, RAMP, RETURN)).toBeCloseTo(-MAX);
        });

        it('overrides the boolean keys the analog axis was thresholded into', () => {
            // PlayerController sets keys.right from moveX > 0.1; both arrive together.
            expect(resolveSteering(-0.2, false, true, 0, MAX, RAMP, RETURN)).toBeCloseTo(-0.2 * MAX);
        });

        it('unwinds through the return ramp when the axis drops to 0 (finger lifted)', () => {
            const held = -0.5 * MAX;
            const next = resolveSteering(0, false, false, held, MAX, RAMP, RETURN);
            expect(next).toBeCloseTo(held + RETURN);   // eased back, not snapped straight
            expect(next).toBeLessThan(0);
        });
    });

    describe('boolean keys (keyboard — unchanged)', () => {
        it('ramps toward lock while held and stops at the max angle', () => {
            let steering = 0;
            steering = resolveSteering(undefined, true, false, steering, MAX, RAMP, RETURN);
            expect(steering).toBeCloseTo(RAMP);
            for (let i = 0; i < 100; i++) {
                steering = resolveSteering(undefined, true, false, steering, MAX, RAMP, RETURN);
            }
            expect(steering).toBeCloseTo(MAX);
        });

        it('returns to centre when nothing is held, without overshooting past 0', () => {
            let steering = RETURN * 1.5;
            steering = resolveSteering(undefined, false, false, steering, MAX, RAMP, RETURN);
            expect(steering).toBeCloseTo(RETURN * 0.5);
            steering = resolveSteering(undefined, false, false, steering, MAX, RAMP, RETURN);
            expect(steering).toBe(0);
            expect(resolveSteering(undefined, false, false, 0, MAX, RAMP, RETURN)).toBe(0);
        });

        it('left wins over right when both are held', () => {
            expect(resolveSteering(undefined, true, true, 0, MAX, RAMP, RETURN)).toBeCloseTo(RAMP);
        });
    });
});
