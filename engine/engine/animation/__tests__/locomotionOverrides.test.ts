import { AnimationState } from 'engine/animation/AnimationContext.js';
import { collectLocomotionOverrides } from 'engine/animation/locomotionOverrides.js';

describe('collectLocomotionOverrides', () => {
    it('maps locomotionState to the engine state, keyed by asset id', () => {
        const overrides = collectLocomotionOverrides([
            { id: 'mRun', type: 'animation', locomotionState: 'run' },
            { id: 'mIdle', type: 'animation', locomotionState: 'idle' },
            { id: 'mWalk', type: 'animation', locomotionState: 'walk' },
        ]);
        expect(overrides.get(AnimationState.RUN)).toBe('mRun');
        expect(overrides.get(AnimationState.IDLE)).toBe('mIdle');
        expect(overrides.get(AnimationState.WALK)).toBe('mWalk');
    });

    it('ignores non-animation assets, missing or unknown states, and ids that are not strings', () => {
        const overrides = collectLocomotionOverrides([
            { id: 'tex', type: 'image', locomotionState: 'run' },
            { id: 'mPlain', type: 'animation' },
            { id: 'mJump', type: 'animation', locomotionState: 'jump' },
            { id: 42, type: 'animation', locomotionState: 'run' },
            null,
            'nope',
        ]);
        expect(overrides.size).toBe(0);
    });

    it('lets the last asset claiming a state win, and falls back to motionId', () => {
        const overrides = collectLocomotionOverrides([
            { id: 'mFirst', type: 'animation', locomotionState: 'run' },
            { motionId: 'mSecond', type: 'animation', locomotionState: 'run' },
        ]);
        expect(overrides.get(AnimationState.RUN)).toBe('mSecond');
    });
});
