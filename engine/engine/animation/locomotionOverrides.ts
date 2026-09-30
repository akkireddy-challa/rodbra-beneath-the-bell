import { AnimationState } from 'engine/animation/AnimationContext.js';

/** The `assets[].locomotionState` values a clip can be pinned to. */
export type LocomotionOverrideState = 'idle' | 'walk' | 'run';

const STATE_BY_VALUE: Record<LocomotionOverrideState, AnimationState> = {
    idle: AnimationState.IDLE,
    walk: AnimationState.WALK,
    run: AnimationState.RUN,
};

function isLocomotionOverrideState(value: unknown): value is LocomotionOverrideState {
    return value === 'idle' || value === 'walk' || value === 'run';
}

/**
 * Read the persisted `locomotionState` assignments off animation assets.
 * Returns state → motionId; when several assets claim one state the last
 * one in `assets` order wins, matching "the most recently added clip is the
 * one the creator meant".
 */
export function collectLocomotionOverrides(assets: readonly unknown[]): Map<AnimationState, string> {
    const overrides = new Map<AnimationState, string>();
    for (const asset of assets) {
        if (!asset || typeof asset !== 'object') continue;
        const rec = asset as Record<string, unknown>;
        if (rec.type !== 'animation') continue;
        if (!isLocomotionOverrideState(rec.locomotionState)) continue;
        const id = rec.id ?? rec.motionId;
        if (typeof id !== 'string' || !id) continue;
        overrides.set(STATE_BY_VALUE[rec.locomotionState], id);
    }
    return overrides;
}
