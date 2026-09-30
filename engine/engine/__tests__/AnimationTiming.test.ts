import { contactCheckPhases, readAnimationTiming } from 'engine/animation/AnimationTiming.js';

describe('authored animation timing', () => {
    it('retains legacy timing for assets without markers', () => {
        const fallback = [.15, .3, .4, .5];
        expect(contactCheckPhases(readAnimationTiming(undefined), fallback)).toBe(fallback);
        expect(readAnimationTiming(null).startTime).toBe(0);
    });
    it('follows retimed impact and contact windows', () => {
        const timing = readAnimationTiming({ impactPhase: .65, contactStart: .55, contactEnd: .8 });
        const phases = contactCheckPhases(timing, [.15]);
        expect(phases).toContain(.65);
        expect(Math.min(...phases)).toBe(.55);
        expect(Math.max(...phases)).toBe(.8);
    });
    it('does not accept inverted or non-finite markers', () => {
        expect(readAnimationTiming({ impactPhase: Infinity, contactStart: .8, contactEnd: .2, startTime: NaN }))
            .toEqual({ impactPhase: null, contactStart: null, contactEnd: null, startTime: 0 });
    });
});
