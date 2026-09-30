import { AnimationState } from 'engine/animation/AnimationContext.js';

/**
 * The upper-body split for a "fire while running" clip must not be decided once and for all
 * at the moment the clip starts.
 *
 * A full-body custom animation blocks the whole locomotion update, and that is exactly what
 * keeps `currentState` pinned at idle — so a clip that began from a standstill re-decides
 * "not moving" on every retrigger and never lets the legs go. The character then slides
 * through the world in a firing pose until the trigger is released. These tests pin the
 * escape: the split is applied the moment real movement appears.
 *
 * The context is modelled directly (the controller's own update is 400 lines of state machine
 * that needs a loaded mixer); what is under test is the decision, which is these four fields.
 */
interface SplitContext {
    isPlayingCustomAnimation: boolean;
    currentState: AnimationState;
    trackBlend: { upperBody: number; lowerBody: number } | null;
    customAnimationSplitOnMove: boolean;
    customAnimationSplitApplied: boolean;
}

/** The decision made when a clip starts (CustomAnimationSystem.playMixamoAnimation). */
function startClip(ctx: SplitContext, splitBodyOnRun: boolean): void {
    const inRunContext = ctx.currentState === AnimationState.RUN || ctx.currentState === AnimationState.WALK;
    const applied = splitBodyOnRun && inRunContext && !ctx.trackBlend;
    ctx.isPlayingCustomAnimation = true;
    if (applied) {
        ctx.trackBlend = { upperBody: 1, lowerBody: 0 };
        ctx.customAnimationSplitApplied = true;
    }
    ctx.customAnimationSplitOnMove = splitBodyOnRun && !applied;
}

/** The per-frame re-check added to CharacterAnimationController.updateAnimation. */
function frame(ctx: SplitContext, moving: boolean): { locomotionRan: boolean } {
    if (ctx.isPlayingCustomAnimation && ctx.customAnimationSplitOnMove && !ctx.trackBlend && moving) {
        ctx.trackBlend = { upperBody: 1, lowerBody: 0 };
        ctx.customAnimationSplitApplied = true;
        ctx.customAnimationSplitOnMove = false;
    }
    if (ctx.isPlayingCustomAnimation && !ctx.trackBlend) return { locomotionRan: false };
    return { locomotionRan: true };
}

const fresh = (state: AnimationState): SplitContext => ({
    isPlayingCustomAnimation: false,
    currentState: state,
    trackBlend: null,
    customAnimationSplitOnMove: false,
    customAnimationSplitApplied: false,
});

describe('custom animation split-on-move', () => {
    it('splits at once when the clip starts while already running', () => {
        const ctx = fresh(AnimationState.RUN);
        startClip(ctx, true);
        expect(ctx.trackBlend).toEqual({ upperBody: 1, lowerBody: 0 });
        expect(frame(ctx, true).locomotionRan).toBe(true);
    });

    it('splits on the first moving frame when the clip started from a standstill', () => {
        const ctx = fresh(AnimationState.IDLE);
        startClip(ctx, true);
        expect(ctx.trackBlend).toBeNull();
        expect(ctx.customAnimationSplitOnMove).toBe(true);

        // Standing still: the clip owns the whole body, which is correct.
        expect(frame(ctx, false).locomotionRan).toBe(false);
        expect(ctx.trackBlend).toBeNull();

        // Walk off: the legs come back on that very frame.
        expect(frame(ctx, true).locomotionRan).toBe(true);
        expect(ctx.trackBlend).toEqual({ upperBody: 1, lowerBody: 0 });
        expect(ctx.customAnimationSplitApplied).toBe(true);
        expect(ctx.customAnimationSplitOnMove).toBe(false);
    });

    it('never frees the legs for a clip that did not ask for the split', () => {
        const ctx = fresh(AnimationState.IDLE);
        startClip(ctx, false);
        expect(frame(ctx, true).locomotionRan).toBe(false);
        expect(ctx.trackBlend).toBeNull();
    });

    it('does not re-apply once the split is on', () => {
        const ctx = fresh(AnimationState.IDLE);
        startClip(ctx, true);
        frame(ctx, true);
        const blend = ctx.trackBlend;
        frame(ctx, true);
        expect(ctx.trackBlend).toBe(blend);
    });
});
