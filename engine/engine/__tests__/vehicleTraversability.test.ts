import {
    evaluateVehiclePath,
    derivedClimbGrade,
    derivedStepHeight,
    bridgeableGapWidth,
    type PathSample,
} from 'engine/vehicleTraversability.js';

/** The grade a 980 kg / 1470 N compact car can climb — see derivedClimbGrade. */
const CAR_GRADE = 0.122;
/** Tallest abrupt step this car can mount: 0.4 m wheels x 0.35. */
const CAR_STEP = 0.14;

/**
 * A profile sampled at 1 m spacing — heights in order from distance 0, `null`
 * where the down-ray found no ground. Tests that care about the SPACING (the
 * step-versus-slope group below) spell their samples out instead.
 */
const profile = (...heights: (number | null)[]): PathSample[] =>
    heights.map((height, i) => ({ distance: i, height }));

describe('evaluateVehiclePath', () => {
    it('passes a flat profile', () => {
        const result = evaluateVehiclePath(profile(10, 10, 10), CAR_GRADE, CAR_STEP, null);
        expect(result.passable).toBe(true);
        expect(result.reason).toBe('clear');
        expect(result.blockedAt).toBe(2);
        expect(result.peakGrade).toBeCloseTo(0, 5);
    });

    it('rejects a kerb the car cannot climb', () => {
        const result = evaluateVehiclePath(profile(10, 10, 10.34), CAR_GRADE, CAR_STEP, null);
        expect(result.passable).toBe(false);
        expect(result.reason).toBe('step');
        // The NEAR sample: 2 is already up on the kerb.
        expect(result.blockedAt).toBe(1);
        expect(result.peakGrade).toBeCloseTo(0.34, 5);
    });

    it('reports a step at the last sample the car can still reach', () => {
        // A caller trimming its leg to blockedAt must land in FRONT of the kerb,
        // not on top of it: the rise happens between 3 m and 4 m, so 3 is the
        // last place the car actually gets to.
        const samples = profile(10, 10, 10, 10, 10.4, 10.4);
        const result = evaluateVehiclePath(samples, CAR_GRADE, CAR_STEP, null);
        expect(result.passable).toBe(false);
        expect(result.reason).toBe('step');
        expect(result.blockedAt).toBe(3);
    });

    it('reports a hole in the ground as a gap', () => {
        const result = evaluateVehiclePath(profile(10, null, 10), CAR_GRADE, CAR_STEP, null);
        expect(result.passable).toBe(false);
        expect(result.reason).toBe('gap');
        expect(result.blockedAt).toBe(1);
    });

    it('reports the obstacle when the sweep hits before the step', () => {
        const samples = profile(10, 10, 10, 10, 10, 10.5);
        const result = evaluateVehiclePath(samples, CAR_GRADE, CAR_STEP, 3);
        expect(result.reason).toBe('obstacle');
        expect(result.blockedAt).toBe(3);
    });

    it('reports the step when it comes before the sweep hit', () => {
        const samples = profile(10, 10, 10.5, 10.5, 10.5, 10.5);
        const result = evaluateVehiclePath(samples, CAR_GRADE, CAR_STEP, 6);
        expect(result.reason).toBe('step');
        expect(result.blockedAt).toBe(1);
    });

    it('passes a steep but legal hill and reports its grade', () => {
        const result = evaluateVehiclePath(profile(10, 10.1, 10.2), CAR_GRADE, CAR_STEP, null);
        expect(result.passable).toBe(true);
        expect(result.peakGrade).toBeCloseTo(0.1, 5);
    });

    it('reports peakGrade from steeper terrain after the first failure', () => {
        const result = evaluateVehiclePath(profile(10, 10.2, 11.1), CAR_GRADE, CAR_STEP, null);
        expect(result.passable).toBe(false);
        expect(result.reason).toBe('step');
        expect(result.blockedAt).toBe(0);
        expect(result.peakGrade).toBeCloseTo(0.9, 5);
    });

    it('fails closed on an empty sample list', () => {
        // No samples means the segment was never surveyed. Every other
        // "cannot answer" path in this feature reports not-passable; this one
        // used to be the single fail-open default.
        const result = evaluateVehiclePath([], CAR_GRADE, CAR_STEP, null);
        expect(result.passable).toBe(false);
        expect(result.reason).toBe('gap');
        expect(result.blockedAt).toBe(0);
    });
});

describe('derivedClimbGrade', () => {
    it('derives the compact car grade from its force-to-weight ratio', () => {
        // 1470 N / (980 kg * 9.81) = 0.1529, derated by 0.8.
        expect(derivedClimbGrade(1470, 980)).toBeCloseTo(0.122, 3);
    });

    it('floors unusable fitment rather than reporting "cannot climb anything"', () => {
        expect(derivedClimbGrade(0, 980)).toBeCloseTo(0.05, 5);
        expect(derivedClimbGrade(1470, 0)).toBeCloseTo(0.05, 5);
    });

    it('caps a high-powered asset at the traction limit', () => {
        expect(derivedClimbGrade(60000, 980)).toBeCloseTo(0.30, 5);
    });
});

describe('step versus slope', () => {
    /**
     * The regression this whole rule exists for. A 4WD car derives a climb grade
     * of 0.30, and a 0.34 m kerb sampled at 0.2 m has a grade of 1.7 — but the
     * point is that even a GENTLE-looking grade must not wave a tall step
     * through. Here the rise is spread over 1.2 m, so its grade (0.28) is inside
     * the climb limit; only the step rule can catch it, and it must not, because
     * over 1.2 m that is a ramp, not a kerb.
     */
    it('allows a tall rise when it is spread out enough to be a ramp', () => {
        const samples: PathSample[] = [
            { distance: 0, height: 10 },
            { distance: 1.2, height: 10.34 },
        ];
        const result = evaluateVehiclePath(samples, 0.30, CAR_STEP, null);
        expect(result.passable).toBe(true);
    });

    it('rejects the measured kerb once the profile is sampled finely enough to see it', () => {
        // 0.34 m over 0.2 m — the kerb from game 8I2U5V99O8EO, at the spacing
        // probeVehiclePath refines to. Both rules fire here (grade 1.7 is also
        // over the limit); the point of the test is the REFINEMENT. Sampled at
        // 1 m the same kerb reads as grade 0.34, which is why it survived a
        // 0.45 ceiling and put cars on the pavement.
        const samples: PathSample[] = [
            { distance: 0, height: 10 },
            { distance: 0.2, height: 10.34 },
            { distance: 1.2, height: 10.34 },
        ];
        const result = evaluateVehiclePath(samples, 0.30, CAR_STEP, null);
        expect(result.passable).toBe(false);
        expect(result.reason).toBe('step');
        expect(result.blockedAt).toBe(0);
    });

    it('cannot see that kerb at 1 m sampling under a permissive ceiling — hence refinement', () => {
        // The exact regression, in the units an UN-refined profile produces:
        // 0.34 m spread over a 1 m sample reads as grade 0.34. Under the old
        // 0.45 ceiling the grade rule did not fire, and the step rule cannot
        // either — over a full metre, a 0.34 m rise is a ramp as far as this
        // data can tell. Neither rule is at fault; the SAMPLING was.
        //
        // This pins both halves of the fix: the lowered ceiling catches it at
        // 1 m, and probeVehiclePath refines around it so the verdict does not
        // depend on the ceiling being low.
        const samples = profile(10, 10.34);
        expect(evaluateVehiclePath(samples, 0.30, CAR_STEP, null).passable).toBe(false);
        expect(evaluateVehiclePath(samples, 0.45, CAR_STEP, null).passable).toBe(true);
    });

    it('rejects a step even when the climb grade is absurdly permissive', () => {
        // Discriminating against a regression to grade-only: with maxClimbGrade
        // at 10 the grade rule cannot fire at all, so a pass here proves the
        // step rule is the thing doing the work.
        const samples: PathSample[] = [
            { distance: 0, height: 10 },
            { distance: 0.2, height: 10.34 },
        ];
        const result = evaluateVehiclePath(samples, 10, CAR_STEP, null);
        expect(result.passable).toBe(false);
        expect(result.reason).toBe('step');
    });
});

describe('derivedStepHeight', () => {
    it('scales with wheel radius, not engine force', () => {
        expect(derivedStepHeight(0.4)).toBeCloseTo(0.14, 5);
        expect(derivedStepHeight(0.8)).toBeCloseTo(0.28, 5);
    });

    it('floors a missing or nonsense wheel radius', () => {
        expect(derivedStepHeight(0)).toBeCloseTo(0.05, 5);
        expect(derivedStepHeight(Number.NaN)).toBeCloseTo(0.05, 5);
    });
});

describe('bridgeableGapWidth', () => {
    it('is the gap whose wheel dip equals the step that wheel could have climbed', () => {
        // Independent check of the closed form: for a wheel of radius r the
        // dip crossing a gap w is r - sqrt(r^2 - (w/2)^2), and at w =
        // bridgeableGapWidth(derivedStepHeight(r)) that dip must be the step
        // height itself.
        for (const radius of [0.3, 0.4, 0.8]) {
            const step = derivedStepHeight(radius);
            const width = bridgeableGapWidth(step);
            const dip = radius - Math.sqrt(radius * radius - (width / 2) * (width / 2));
            expect(dip).toBeCloseTo(step, 5);
        }
    });

    it('scales with the step height, so a bigger wheel bridges a wider gap', () => {
        expect(bridgeableGapWidth(0.105)).toBeCloseTo(0.4558, 3);
        expect(bridgeableGapWidth(0.14)).toBeCloseTo(0.6077, 3);
        expect(bridgeableGapWidth(0.28)).toBeCloseTo(1.2154, 3);
    });

    it('comfortably spans the measured collider seams but not a real hole', () => {
        // The three Maple Hollow seams, and a hole a wheel genuinely drops into.
        const width = bridgeableGapWidth(0.105);
        for (const seam of [0.02, 0.11, 0.22]) expect(seam).toBeLessThan(width);
        expect(1.0).toBeGreaterThan(width);
    });

    it('returns 0 for a nonsense step height rather than bridging everything', () => {
        expect(bridgeableGapWidth(0)).toBe(0);
        expect(bridgeableGapWidth(Number.NaN)).toBe(0);
        expect(bridgeableGapWidth(-1)).toBe(0);
    });
});
