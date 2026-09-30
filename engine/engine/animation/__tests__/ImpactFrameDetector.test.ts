import { pickImpactFraction, pickImpactStrike } from 'engine/animation/ImpactFrameDetector.js';

describe('pickImpactStrike', () => {
    it('reports which limb struck and the contact fraction', () => {
        const series = new Map<string, number[]>([
            ['rightFoot', [0, 0, 0, 0, 10, 0, 0, 0, 0]],
            ['leftFoot', [0, 0, 0, 0, 0, 0, 0, 0, 0]],
            ['leftHand', [0, 0, 0, 0, 0, 0, 0, 0, 0]],
            ['rightHand', [0, 0, 0, 0, 0, 0, 0, 0, 0]],
        ]);
        const strike = pickImpactStrike(series);
        expect(strike).not.toBeNull();
        expect(strike!.part).toBe('rightFoot');
        expect(strike!.fraction).toBeCloseTo(4 / 8, 5);
    });

    it('returns null when there is no clear strike', () => {
        const series = new Map<string, number[]>([['rightFoot', [1, 1, 1, 1, 1, 1]]]);
        expect(pickImpactStrike(series)).toBeNull();
    });
});

describe('pickImpactFraction', () => {
    it('returns the spike position for a single sharp strike', () => {
        // rightFoot accelerates to a sharp peak at index 4 of 9, others idle.
        const series = new Map<string, number[]>([
            ['rightFoot', [0, 0, 0, 0, 10, 0, 0, 0, 0]],
            ['leftFoot', [0, 0, 0, 0, 0, 0, 0, 0, 0]],
            ['leftHand', [0, 0, 0, 0, 0, 0, 0, 0, 0]],
            ['rightHand', [0, 0, 0, 0, 0, 0, 0, 0, 0]],
        ]);
        const f = pickImpactFraction(series);
        expect(f).not.toBeNull();
        expect(f!).toBeCloseTo(4 / 8, 5); // index 4 of length-1 (8)
    });

    it('returns null for a flat, no-strike clip (e.g. a wave held out)', () => {
        const series = new Map<string, number[]>([
            ['rightHand', [1, 1, 1, 1, 1, 1]],
            ['leftHand', [1, 1, 1, 1, 1, 1]],
            ['rightFoot', [0, 0, 0, 0, 0, 0]],
            ['leftFoot', [0, 0, 0, 0, 0, 0]],
        ]);
        expect(pickImpactFraction(series)).toBeNull();
    });

    it('returns null for an oscillating locomotion cycle (two foot peaks)', () => {
        // Either foot series wins strikingLimbSeries; both have multiple peaks → null regardless of Map order.
        const series = new Map<string, number[]>([
            ['leftFoot', [0, 9, 0, 0, 9, 0, 0]],
            ['rightFoot', [9, 0, 0, 9, 0, 0, 9]],
            ['leftHand', [0, 0, 0, 0, 0, 0, 0]],
            ['rightHand', [0, 0, 0, 0, 0, 0, 0]],
        ]);
        expect(pickImpactFraction(series)).toBeNull();
    });

    it('returns null for empty input', () => {
        expect(pickImpactFraction(new Map())).toBeNull();
    });

    it('returns null for a too-short series', () => {
        const series = new Map<string, number[]>([['foot', [10, 0]]]);
        expect(pickImpactFraction(series)).toBeNull();
    });
});
