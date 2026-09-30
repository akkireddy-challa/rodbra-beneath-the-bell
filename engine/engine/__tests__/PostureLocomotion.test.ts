import { resolveLocomotionMotionId } from 'engine/animation/AnimationOverrideSystem.js';
import { AnimationState, type AnimationContext } from 'engine/animation/AnimationContext.js';
import { POSTURE_MOVES, DIRECTIONAL_MOVES } from 'engine/AnimationPacks.js';
import { POSTURE_PHYSICS } from 'engine/PlayerPosture.js';

/**
 * The posture axis: IDLE swaps to the posture's hold, WALK/RUN to its move
 * clip — only when those players are loaded, and posture beats direction
 * (a crouch has no strafe clip; the crouch step covers every direction).
 * Postures with no move clip freeze locomotion to the hold.
 */

function ctxWith(overrides: Partial<AnimationContext>): AnimationContext {
    return {
        mixamoStateOverrides: new Map([
            [AnimationState.IDLE, 'mIdleDefault01'],
            [AnimationState.WALK, 'mWalkDefault01'],
            [AnimationState.RUN, 'mRunDefault01'],
        ]),
        mixamoAnimationPlayers: new Map(),
        locomotionDirection: 'forward',
        playingLocomotionBucket: 'forward',
        posture: 'stand',
        playingPosture: 'stand',
        ...overrides,
    } as unknown as AnimationContext;
}

const loaded = (ids: string[]) => new Map(ids.map((id) => [id, {} as never]));

describe('posture-aware locomotion selection', () => {
    it('stand resolves to the plain overrides (pre-posture behavior)', () => {
        const ctx = ctxWith({ mixamoAnimationPlayers: loaded([POSTURE_MOVES.crouch.hold, POSTURE_MOVES.crouch.move]) });
        expect(resolveLocomotionMotionId(ctx, AnimationState.IDLE)).toBe('mIdleDefault01');
        expect(resolveLocomotionMotionId(ctx, AnimationState.WALK)).toBe('mWalkDefault01');
    });

    it('crouch swaps idle to the hold and walk/run to the step', () => {
        const ctx = ctxWith({ mixamoAnimationPlayers: loaded([POSTURE_MOVES.crouch.hold, POSTURE_MOVES.crouch.move]) });
        ctx.posture = 'crouch';
        expect(resolveLocomotionMotionId(ctx, AnimationState.IDLE)).toBe(POSTURE_MOVES.crouch.hold);
        expect(resolveLocomotionMotionId(ctx, AnimationState.WALK)).toBe(POSTURE_MOVES.crouch.move);
        expect(resolveLocomotionMotionId(ctx, AnimationState.RUN)).toBe(POSTURE_MOVES.crouch.move);
    });

    it('posture beats travel direction', () => {
        const ctx = ctxWith({
            mixamoAnimationPlayers: loaded([POSTURE_MOVES.crouch.move, DIRECTIONAL_MOVES.strafeLeft]),
        });
        ctx.posture = 'crouch';
        ctx.locomotionDirection = 'left';
        expect(resolveLocomotionMotionId(ctx, AnimationState.WALK)).toBe(POSTURE_MOVES.crouch.move);
    });

    it('a posture without a move clip freezes locomotion to its hold', () => {
        const ctx = ctxWith({ mixamoAnimationPlayers: loaded([POSTURE_MOVES.sit.hold]) });
        ctx.posture = 'sit';
        expect(resolveLocomotionMotionId(ctx, AnimationState.WALK)).toBe(POSTURE_MOVES.sit.hold);
    });

    it('falls back to standing clips when the pack is not loaded', () => {
        const ctx = ctxWith({});
        ctx.posture = 'prone';
        expect(resolveLocomotionMotionId(ctx, AnimationState.IDLE)).toBe('mIdleDefault01');
        expect(resolveLocomotionMotionId(ctx, AnimationState.WALK)).toBe('mWalkDefault01');
    });

    it('never touches non-locomotion states', () => {
        const ctx = ctxWith({
            mixamoAnimationPlayers: loaded([POSTURE_MOVES.crouch.hold]),
            mixamoStateOverrides: new Map([[AnimationState.ATTACK, 'mAttack01']]),
        });
        ctx.posture = 'crouch';
        expect(resolveLocomotionMotionId(ctx, AnimationState.ATTACK)).toBe('mAttack01');
    });
});

describe('posture physics table', () => {
    it('every posture in POSTURE_MOVES has physics, plus stand', () => {
        for (const key of [...Object.keys(POSTURE_MOVES), 'stand']) {
            expect(POSTURE_PHYSICS[key as keyof typeof POSTURE_PHYSICS]).toBeDefined();
        }
    });

    it('lowers the capsule for crouch and prone, and stops motion for sit/kneel', () => {
        expect(POSTURE_PHYSICS.crouch.height).toBeLessThan(POSTURE_PHYSICS.stand.height);
        expect(POSTURE_PHYSICS.prone.height).toBeLessThan(POSTURE_PHYSICS.crouch.height);
        expect(POSTURE_PHYSICS.sit.speed).toBe(0);
        expect(POSTURE_PHYSICS.kneel.speed).toBe(0);
    });
});
