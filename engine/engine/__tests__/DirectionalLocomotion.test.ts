import { resolveLocomotionMotionId } from 'engine/animation/AnimationOverrideSystem.js';
import { AnimationState, type AnimationContext } from 'engine/animation/AnimationContext.js';
import { CharacterAnimationController } from 'engine/CharacterAnimationController.js';
import { DIRECTIONAL_MOVES } from 'engine/AnimationPacks.js';

/**
 * Direction-aware locomotion selection: WALK/RUN swap to strafe/backpedal
 * clips by travel direction — but ONLY when those players are loaded, so a
 * character without the directional pack behaves exactly as before.
 *
 * Contexts are stand-ins carrying just the fields the resolver reads; the
 * hysteresis test drives the real setter on a facade (the same prototype
 * trick CorpseFacadeDelegation uses), so no controller construction.
 */

function ctxWith(overrides: Partial<AnimationContext>): AnimationContext {
    return {
        mixamoStateOverrides: new Map([
            [AnimationState.WALK, 'mWalkDefault01'],
            [AnimationState.RUN, 'mRunDefault01'],
        ]),
        mixamoAnimationPlayers: new Map(),
        locomotionDirection: 'forward',
        playingLocomotionBucket: 'forward',
        ...overrides,
    } as unknown as AnimationContext;
}

const loadedPack = () => new Map(
    Object.values(DIRECTIONAL_MOVES).map((id) => [id, {} as never]),
);

describe('resolveLocomotionMotionId', () => {
    it('forward resolves to the plain state override', () => {
        const ctx = ctxWith({ mixamoAnimationPlayers: loadedPack() });
        expect(resolveLocomotionMotionId(ctx, AnimationState.WALK)).toBe('mWalkDefault01');
        expect(resolveLocomotionMotionId(ctx, AnimationState.RUN)).toBe('mRunDefault01');
    });

    it('swaps direction buckets to the pack clips when loaded', () => {
        const ctx = ctxWith({ mixamoAnimationPlayers: loadedPack() });
        ctx.locomotionDirection = 'back';
        expect(resolveLocomotionMotionId(ctx, AnimationState.WALK)).toBe(DIRECTIONAL_MOVES.backpedal);
        expect(resolveLocomotionMotionId(ctx, AnimationState.RUN)).toBe(DIRECTIONAL_MOVES.backpedalFast);
        ctx.locomotionDirection = 'left';
        expect(resolveLocomotionMotionId(ctx, AnimationState.WALK)).toBe(DIRECTIONAL_MOVES.strafeLeft);
        ctx.locomotionDirection = 'right';
        expect(resolveLocomotionMotionId(ctx, AnimationState.RUN)).toBe(DIRECTIONAL_MOVES.strafeRight);
    });

    it('falls back to the forward clip when the pack is not loaded', () => {
        const ctx = ctxWith({});
        ctx.locomotionDirection = 'back';
        expect(resolveLocomotionMotionId(ctx, AnimationState.WALK)).toBe('mWalkDefault01');
    });

    it('never redirects non-locomotion states', () => {
        const ctx = ctxWith({
            mixamoAnimationPlayers: loadedPack(),
            mixamoStateOverrides: new Map([[AnimationState.IDLE, 'mIdleDefault01']]),
        });
        ctx.locomotionDirection = 'left';
        expect(resolveLocomotionMotionId(ctx, AnimationState.IDLE)).toBe('mIdleDefault01');
    });
});

describe('setLocomotionDirection bucketing', () => {
    interface DirectionFacade {
        setLocomotionDirection(x: number, z: number): void;
    }

    function facade(): { self: DirectionFacade; ctx: { locomotionDirection: string } } {
        const ctx = { locomotionDirection: 'forward' };
        const self = Object.assign(
            Object.create(CharacterAnimationController.prototype),
            { ctx },
        ) as DirectionFacade;
        return { self, ctx };
    }

    it('buckets the four cardinal directions (+Z fwd, +X left)', () => {
        const { self, ctx } = facade();
        self.setLocomotionDirection(0, 1);
        expect(ctx.locomotionDirection).toBe('forward');
        self.setLocomotionDirection(0, -1);
        expect(ctx.locomotionDirection).toBe('back');
        self.setLocomotionDirection(1, 0);
        expect(ctx.locomotionDirection).toBe('left');
        self.setLocomotionDirection(-1, 0);
        expect(ctx.locomotionDirection).toBe('right');
    });

    it('is sticky across the forward boundary (hysteresis)', () => {
        const { self, ctx } = facade();
        self.setLocomotionDirection(0, 1);
        // 50° off forward: inside the widened 55° forward edge — stays forward.
        const a50 = (50 * Math.PI) / 180;
        self.setLocomotionDirection(Math.sin(a50), Math.cos(a50));
        expect(ctx.locomotionDirection).toBe('forward');
        // From a strafe, the same 50° is past the normal 45° edge — stays left.
        ctx.locomotionDirection = 'left';
        self.setLocomotionDirection(Math.sin(a50), Math.cos(a50));
        expect(ctx.locomotionDirection).toBe('left');
    });

    it('keeps the previous bucket while nearly stationary', () => {
        const { self, ctx } = facade();
        self.setLocomotionDirection(-1, 0);
        expect(ctx.locomotionDirection).toBe('right');
        self.setLocomotionDirection(0.01, 0.01);
        expect(ctx.locomotionDirection).toBe('right');
    });
});
