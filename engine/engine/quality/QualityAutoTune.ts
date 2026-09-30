/**
 * Decide, from a stream of `FrameWindow`s, whether the device should drop a quality rung.
 *
 * A pure function over (state, window) — no DOM, no clock, no storage, no engine. That is
 * deliberate and it is the whole reason this file exists separately from the controller:
 * hysteresis, grace periods and cooldowns are exactly the kind of logic that is impossible
 * to reason about by reading, and trivial to pin once a fabricated frame stream can be fed
 * through it. The test that matters most feeds a HEALTHY 60 Hz stream — including the frame
 * cap's own occasional 33 ms gaps — and asserts zero downgrades.
 *
 * IT IS A RATCHET. It can only ever lower the tier, never raise it. There is no honest
 * evidence for the opposite direction: under a 60 fps cap a device rendering in 4 ms and
 * one rendering in 16 ms report identical frame times, so "it looks fine" is the absence of
 * a measurement rather than a measurement. Upward movement happens in exactly two places,
 * both outside this loop — the player picking a rung, and the stored conclusion expiring so
 * the next boot starts from the static guess again. A useful
 * side effect: oscillation is not merely damped here, it is structurally impossible.
 *
 * WHAT IT REFUSES TO JUDGE. A slow window is only evidence about the device if nothing else
 * explains it. Three things routinely do, and all three are discarded rather than blamed:
 * a shader compiled (the renderer's program count moved), content streamed in (geometry or
 * texture counts moved), or something the game did (a level load, a resize, a respawn — or
 * a change this tuner itself just applied, which is why the controller reports one). A
 * discarded window does not advance the bad streak AND does not reset it: it is not
 * evidence either way, and treating it as "good" would let a device that is struggling
 * during continuous streaming never accumulate three consecutive bad windows.
 */

import type { FrameWindow } from 'engine/quality/FrameBudgetSampler.js';

/** What the tuner is allowed to decide. */
export type AutoTuneDecision =
    | { kind: 'none' }
    | { kind: 'discard'; why: DiscardReason }
    | { kind: 'downgrade'; why: string };

/** Why a window was not counted as evidence in either direction. */
export type DiscardReason = 'grace' | 'compile' | 'streaming' | 'disturbed' | 'short' | 'cooldown';

/** The tuner's carried state. Immutable — `evaluateWindow` returns the next one. */
export interface AutoTuneState {
    /** Windows in a row that were bad. Reset by a good window, untouched by a discard. */
    consecutiveBad: number;
    /** No window ending before this is evidence. Extended by grace, re-grace and cooldown. */
    quietUntilMs: number;
    /** Tier steps already spent this session on sustained gameplay measurements. */
    downgradesUsed: number;
}

export interface AutoTuneConfig {
    /** Window length the sampler emits at. */
    windowMs: number;
    /** Below this fraction of the target frame rate, a window is bad. */
    badFpsFraction: number;
    /** Or: above this fraction of frames dropped, a window is bad even if the mean holds. */
    badDroppedRatio: number;
    /** Consecutive bad windows before acting. */
    consecutiveBadWindows: number;
    /** Quiet period after the first frame, while the scene settles. */
    graceMs: number;
    /** Quiet period after any disturbance. */
    regraceMs: number;
    /** Quiet period after a downgrade, so the loop measures the result of its own action. */
    cooldownMs: number;
    /** Hard cap on automatic gameplay tier steps per session. */
    maxDowngradesPerSession: number;
    /** A window with fewer rendered frames than this is not evidence. */
    minWindowFrames: number;
    /** Geometry/texture count movement beyond this reads as streaming, not as the device. */
    streamingDelta: number;
}

/**
 * Every field required with one exported default, per `docs/engine-options-pattern.md`.
 *
 * The numbers are chosen so the WORST case a player can experience is bounded and small:
 * three consecutive bad windows at 2 s each is ~6 s of poor frames before anything happens,
 * a 15 s cooldown separates changes, and two tier steps is the session's budget. The
 * load-time probe is diagnostic only and cannot spend any of this budget.
 */
export const DEFAULT_AUTO_TUNE: AutoTuneConfig = {
    windowMs: 2000,
    // 0.75 of 60 is 45 fps. A healthy 60 Hz desktop measures 57-60 even with the frame
    // cap's epsilon, so this sits far below anything a working machine produces.
    badFpsFraction: 0.75,
    badDroppedRatio: 0.15,
    consecutiveBadWindows: 3,
    graceMs: 5000,
    regraceMs: 3000,
    cooldownMs: 15000,
    // Two, matching `LevelDetail`'s DOWNGRADE_STEPS thinking: the budget is small enough
    // that a mis-measured session cannot ratchet a good device to the floor.
    maxDowngradesPerSession: 2,
    minWindowFrames: 20,
    streamingDelta: 4,
};

/** A fresh session's state. `firstFrameMs` starts the initial grace period. */
export function initialAutoTuneState(firstFrameMs: number, cfg: AutoTuneConfig): AutoTuneState {
    return { consecutiveBad: 0, quietUntilMs: firstFrameMs + cfg.graceMs, downgradesUsed: 0 };
}

/** Whether `win` describes a device that is not keeping up. */
function isBadWindow(win: FrameWindow, cfg: AutoTuneConfig): boolean {
    const elapsedS = (win.endMs - win.startMs) / 1000;
    if (elapsedS <= 0) return false;
    const fps = win.renderedFrames / elapsedS;
    if (fps < win.targetFps * cfg.badFpsFraction) return true;
    // Stutter that does not move the mean: a window can average acceptably and still be
    // unplayable if a sixth of its frames arrive two vsyncs late.
    return win.droppedFrames / win.renderedFrames > cfg.badDroppedRatio;
}

/** Why this window cannot be used as evidence about the device, or null if it can. */
function discardReason(win: FrameWindow, state: AutoTuneState, cfg: AutoTuneConfig): DiscardReason | null {
    // Same rule, two names: before the first downgrade the quiet period is the opening
    // grace, after one it is the cooldown. The distinction exists only so `?tierlog=1`
    // says which, because "discarded during cooldown" and "discarded during grace" send
    // someone reading the log to completely different places.
    if (win.endMs < state.quietUntilMs) return state.downgradesUsed > 0 ? 'cooldown' : 'grace';
    if (win.disturbed) return 'disturbed';
    // A compile stall is a fact about content arriving, not about the device's speed. It is
    // also exactly the spike a naive rule would fire on, because it is the largest one a
    // healthy session produces.
    if (win.programDelta !== 0) return 'compile';
    if (Math.abs(win.geometryDelta) > cfg.streamingDelta || Math.abs(win.textureDelta) > cfg.streamingDelta) {
        return 'streaming';
    }
    // Too few frames to be a rate at all: a hidden tab, or the loop on its 30 fps paused
    // interval. Judging a device on those would downgrade it for being in the background.
    if (win.renderedFrames < cfg.minWindowFrames) return 'short';
    return null;
}

/**
 * Fold one window into the tuner's state.
 *
 * Returns the next state and what should happen. The caller applies the downgrade; this
 * function neither knows nor cares what a rung is.
 */
export function evaluateWindow(
    state: AutoTuneState,
    win: FrameWindow,
    cfg: AutoTuneConfig,
): { next: AutoTuneState; decision: AutoTuneDecision } {
    if (state.downgradesUsed >= cfg.maxDowngradesPerSession) {
        return { next: state, decision: { kind: 'none' } };
    }

    const discard = discardReason(win, state, cfg);
    if (discard !== null) {
        // A disturbance extends the quiet period past the end of this window: the frames
        // right after a level load are still the load settling, not gameplay.
        const next = discard === 'disturbed'
            ? { ...state, quietUntilMs: Math.max(state.quietUntilMs, win.endMs + cfg.regraceMs) }
            : state;
        return { next, decision: { kind: 'discard', why: discard } };
    }

    if (!isBadWindow(win, cfg)) {
        return { next: { ...state, consecutiveBad: 0 }, decision: { kind: 'none' } };
    }

    const consecutiveBad = state.consecutiveBad + 1;
    if (consecutiveBad < cfg.consecutiveBadWindows) {
        return { next: { ...state, consecutiveBad }, decision: { kind: 'none' } };
    }

    const elapsedS = (win.endMs - win.startMs) / 1000;
    const fps = Math.round(win.renderedFrames / elapsedS);
    return {
        next: {
            consecutiveBad: 0,
            // The cooldown starts now, so the next thing measured is the RESULT of the
            // change rather than the frame it was applied on.
            quietUntilMs: win.endMs + cfg.cooldownMs,
            downgradesUsed: state.downgradesUsed + 1,
        },
        decision: {
            kind: 'downgrade',
            why: `${consecutiveBad} windows at ~${fps}fps against a ${win.targetFps}fps target`,
        },
    };
}
