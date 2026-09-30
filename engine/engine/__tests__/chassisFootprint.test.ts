import {
    boxFootprint,
    footprintSeparation,
    verticalOverlap,
} from 'engine/physics/chassisFootprint.js';

/**
 * Car-to-car contact must be read from real geometry. The cases below are the
 * ones a centre-distance test gets wrong: two cars side by side are CLOSER
 * centre-to-centre than two cars nose-to-tail, yet both are metres from
 * touching.
 */

/** A 1.8 m × 4.2 m car (half extents 0.9 × 0.5 × 2.1) at (x, z), yawed by `yaw`. */
function car(x: number, z: number, yaw = 0, y = 0.5) {
    const half = Math.sin(yaw / 2);
    return boxFootprint(
        { x, y, z },
        { x: 0, y: half, z: 0, w: Math.cos(yaw / 2) },
        { x: 0.9, y: 0.5, z: 2.1 },
    );
}

describe('boxFootprint', () => {
    it('reports the world vertical span of a level box', () => {
        const f = car(0, 0);
        expect(f.minY).toBeCloseTo(0, 6);
        expect(f.maxY).toBeCloseTo(1, 6);
    });

    it('keeps the vertical span when the box yaws (rotation about Y only)', () => {
        const f = car(0, 0, Math.PI / 4);
        expect(f.minY).toBeCloseTo(0, 6);
        expect(f.maxY).toBeCloseTo(1, 6);
    });

    it('grows the vertical span when the box is rolled onto its side', () => {
        const s = Math.sin(Math.PI / 4);
        const rolled = boxFootprint({ x: 0, y: 0.5, z: 0 }, { x: 0, y: 0, z: s, w: s }, { x: 0.9, y: 0.5, z: 2.1 });
        // Rolled 90°: the 0.9 half-width is now vertical.
        expect(rolled.maxY - rolled.minY).toBeCloseTo(1.8, 5);
    });
});

describe('footprintSeparation', () => {
    it('measures the real gap between two cars queued nose to tail', () => {
        // Centres 5 m apart along Z, 2.1 m of car on each side → 0.8 m gap.
        const sep = footprintSeparation(car(0, 5), car(0, 0));
        expect(sep.gap).toBeCloseTo(0.8, 6);
        expect(sep.nz).toBeCloseTo(1, 6); // push the front car forward
    });

    it('measures the real gap between two cars racing side by side', () => {
        // Centres only 2.6 m apart — CLOSER than the queued pair above — but
        // still 0.8 m of clear air between the flanks.
        const sep = footprintSeparation(car(2.6, 0), car(0, 0));
        expect(sep.gap).toBeCloseTo(0.8, 6);
        expect(sep.nx).toBeCloseTo(1, 6);
    });

    it('reports penetration depth and the shallowest way out when overlapping', () => {
        const sep = footprintSeparation(car(1.7, 0), car(0, 0));
        expect(sep.gap).toBeCloseTo(-0.1, 6); // 1.8 m of width, 1.7 m of centres
        expect(sep.nx).toBeCloseTo(1, 6);
        expect(Math.abs(sep.nz)).toBeLessThan(1e-6); // sideways out, not lengthways
    });

    it('handles a car turned across another (T-bone geometry)', () => {
        // B is yawed 90°, so its 4.2 m length now runs along X. Its flank
        // reaches to x = 2.1; A's nose reaches x = 5 - 0.9 = 4.1 → 2.0 m gap.
        const sep = footprintSeparation(car(5, 0, 0), car(0, 0, Math.PI / 2));
        expect(sep.gap).toBeCloseTo(2.0, 5);
    });

    it('is symmetric in magnitude and flips the normal with the argument order', () => {
        const ab = footprintSeparation(car(3, 0), car(0, 0));
        const ba = footprintSeparation(car(0, 0), car(3, 0));
        expect(ab.gap).toBeCloseTo(ba.gap, 6);
        expect(ab.nx).toBeCloseTo(-ba.nx, 6);
    });

    it('separates diagonally-offset cars along the shallowest axis', () => {
        // Overlapping in X by 0.1 m and in Z by 2.2 m — out sideways is shallower.
        const sep = footprintSeparation(car(1.7, 2, 0), car(0, 0));
        expect(sep.gap).toBeCloseTo(-0.1, 6);
        expect(sep.nx).toBeCloseTo(1, 6);
    });
});

describe('verticalOverlap', () => {
    it('is positive for two cars on the same road', () => {
        expect(verticalOverlap(car(0, 0), car(1.5, 0))).toBeGreaterThan(0);
    });

    it('is negative for a car on a bridge above another', () => {
        expect(verticalOverlap(car(0, 0, 0, 6), car(0, 0, 0, 0.5))).toBeLessThan(0);
    });
});
