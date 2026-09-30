import * as THREE from 'three';
import type { BaseAnimationDefinition } from 'types/game.js';

/**
 * Cached GLTF data structure shared across animation systems.
 */
export interface CachedGLTF {
    scene: THREE.Group;
    animations: THREE.AnimationClip[];
}

// Module-level GLTF load cache shared across all animation controller instances.
// Prevents re-fetching and re-parsing the same animation files for multiple NPCs.
const gltfLoadCache = new Map<string, Promise<CachedGLTF>>();

export function cachedGLTFLoad(loader: { loadAsync: (url: string) => Promise<CachedGLTF> }, url: string): Promise<CachedGLTF> {
    let promise = gltfLoadCache.get(url);
    if (!promise) {
        promise = loader.loadAsync(url);
        gltfLoadCache.set(url, promise);
    }
    return promise;
}

export interface CharacterAnimationConfig {
    idleAnimationName?: string;
    walkAnimationName?: string;
    runAnimationName?: string;
    jumpAnimationName?: string;
    runSpeed?: number;
    /** Speed (m/s) at which locomotion switches from WALK to RUN.
     *  Below this, NPC/player plays the walk clip if available; above, run. */
    walkToRunThreshold?: number;
    transitionDuration?: number;
}

export enum AnimationState {
    IDLE = 'idle',
    WALK = 'walk',
    RUN = 'run',
    JUMP = 'jump',
    ATTACK = 'attack'
}

export type MixamoAnimationPlayer = import('engine/MixamoAnimationPlayer.js').MixamoAnimationPlayer;

/**
 * Shared mutable context passed to all animation subsystems.
 * Each subsystem reads/writes shared state through this object.
 */
export interface AnimationContext {
    mixer: THREE.AnimationMixer | null;
    character: THREE.Object3D | null;
    config: CharacterAnimationConfig;
    loader: { loadAsync: (url: string) => Promise<CachedGLTF> } | null;
    isInitialized: boolean;

    // Current action tracking (shared across subsystems for crossfade)
    currentAction: THREE.AnimationAction | null;

    // State machine
    currentState: AnimationState;
    previousState: AnimationState;
    animations: Map<AnimationState, THREE.AnimationAction>;
    nativeSpeedByState: Map<AnimationState, number>;

    // Root motion
    rootMotionBone: THREE.Object3D | null;
    rootMotionTargets: THREE.Object3D[];

    // Jump state
    isJumping: boolean;
    jumpStartTime: number;
    jumpDuration: number;

    // Attack state (shared so state machine can read it)
    isAttacking: boolean;
    attackStartTime: number;

    // Custom animation state (shared so state machine knows to yield)
    isPlayingCustomAnimation: boolean;
    customAnimationHeld: boolean;
    currentCustomMotionId: string | null;
    /** When true, the next isMoving=true frame stops the custom animation
     *  and lets the locomotion state machine take over. Set per-call via
     *  playCustomAnimation({ interruptOnMovement: true }). */
    customAnimationInterruptOnMovement: boolean;
    /**
     * The playing custom animation asked for `splitBodyOnRun`, but the character was standing
     * still when it started so no split was applied. Re-checked each frame: the moment the
     * character actually moves, the split goes on and the legs are handed back to locomotion.
     */
    customAnimationSplitOnMove: boolean;
    /** A split IS applied for the playing custom animation and must be cleared when it ends. */
    customAnimationSplitApplied: boolean;

    // Priority animation state
    priorityAnimationPlaying: boolean;

    // Two-track Mixamo system
    trackAMixamoPlayer: MixamoAnimationPlayer | null;
    trackBMixamoPlayer: MixamoAnimationPlayer | null;
    fadingOutTrackAPlayer: MixamoAnimationPlayer | null;
    fadingOutCrossfadeProgress: number;
    fadingOutCrossfadeDuration: number;

    // Mixamo animation player instances, keyed by motionId
    mixamoAnimationPlayers: Map<string, MixamoAnimationPlayer>;

    // Override system
    stateOverrides: Map<AnimationState, THREE.AnimationAction>;
    mixamoStateOverrides: Map<AnimationState, string>;
    pendingMixamoBaseAnimations: BaseAnimationDefinition[];

    /**
     * Which way the character is travelling RELATIVE TO ITS FACING, bucketed.
     * 'forward' is the default and the only value that existed before the
     * directional locomotion pack: WALK/RUN resolve to their normal clips.
     * The other buckets swap in Backpedal/Strafe clips — but only when those
     * players are actually loaded (see resolveLocomotionMotionId), so a
     * character without the pack behaves exactly as before.
     */
    locomotionDirection: 'forward' | 'back' | 'left' | 'right';
    /** Continuous facing-local yaw for the optional captured eight-way blend. */
    locomotionAngle?: number;
    directionalLocomotionStyle?: import('engine/animation/DirectionalLocomotion.js').DirectionalLocomotionStyle;
    directionalLocomotionEnabled?: boolean;
    /** The bucket the currently-playing locomotion clip was chosen for. */
    playingLocomotionBucket: 'forward' | 'back' | 'left' | 'right';

    /**
     * Body posture. 'stand' is the default and the only value that existed
     * before the posture pack: IDLE/WALK/RUN resolve to their normal clips.
     * Any other posture swaps IDLE to that posture's hold and WALK/RUN to its
     * move clip — but only when those players are loaded, so a character
     * without the pack behaves exactly as before. See resolveLocomotionMotionId.
     */
    posture: string;
    /** The posture the currently-playing IDLE/WALK/RUN clip was chosen for. */
    playingPosture: string;

    // Track B per-body-part blend weights (null = uniform)
    trackBlend: { upperBody: number; lowerBody: number } | null;

    // During an attack, currentState is locked to ATTACK but the player may
    // still be running/walking/jumping/idle on their feet. These mirror the
    // movement-driven locomotion state so trackA can follow it (legs animate
    // the actual movement via trackBlend) and endAttack can resume there
    // instead of snapping to IDLE.
    attackResumeState: AnimationState | null;
    attackTrackAState: AnimationState | null;

    // Custom animations map (shared between custom animation and attack systems)
    customAnimations: Map<string, THREE.AnimationAction>;

    // Character height for Mixamo skeleton scaling
    characterHeight: number;

    /**
     * Keep every bone and track in the Mixamo players this controller loads
     * (see MixamoPlayerLoadOptions.retainFullSkeleton). Set by the loader
     * BEFORE initializeWithCharacter when the pose target is a skinned mesh;
     * the block path leaves it false and keeps the pruning.
     */
    retainFullSkeleton: boolean;

    // Game data provider
    gameDataProvider: (() => { assets?: unknown[]; scene?: THREE.Scene | null } | null) | null;
}

/**
 * Defense-in-depth: keep ctx.currentAction looping at full weight so the
 * skeleton never falls to bind pose when a transition has no target. Promotes
 * one-shot actions (LoopOnce + clampWhenFinished, e.g. attacks) to a looping
 * state. Callers that re-trigger such actions (startAttack) reset loop/clamp
 * themselves, so this mutation never persists past the next trigger.
 */
export function keepCurrentActionAlive(ctx: AnimationContext): void {
    const action = ctx.currentAction;
    if (!action) return;
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.clampWhenFinished = false;
    action.enabled = true;
    action.stopFading();
    const clipDuration = action.getClip?.()?.duration ?? Infinity;
    if (action.paused || action.time >= clipDuration - 1e-3) {
        action.reset();
        action.play();
    } else if (!action.isRunning()) {
        action.play();
    }
    action.setEffectiveWeight(1);
}

/**
 * Iterate only the mixer's *active* actions (first `_nActiveActions` slots of
 * `_actions`). Inactive actions still have `enabled=true` and a default
 * `_effectiveWeight=1`, so iterating the whole array would treat unplayed clips
 * as contributing — they don't render.
 */
type MixerInternals = { _actions?: THREE.AnimationAction[]; _nActiveActions?: number };
function forEachActiveAction(mixer: THREE.AnimationMixer, fn: (action: THREE.AnimationAction) => void): void {
    const internal = mixer as unknown as MixerInternals;
    const actions = internal._actions;
    const nActive = internal._nActiveActions ?? 0;
    if (!Array.isArray(actions)) return;
    for (let i = 0; i < nActive; i++) {
        const action = actions[i];
        if (action) fn(action);
    }
}

/**
 * Fade out every *active* action on the mixer except `keep`, all over the same
 * duration. Without this, lingering actions from earlier transitions (e.g. an
 * idle still fading from preemptive cycling when an attack starts) finish
 * their fades independently — if they hit weight 0 before the new action
 * reaches weight 1, the mixer's PropertyMixer blends in the bind pose (T-pose)
 * to fill the gap. Fading them out in sync with the new action's fade-in keeps
 * the cumulative weight at 1 throughout the transition.
 */
export function fadeOutAllOtherActions(mixer: THREE.AnimationMixer, keep: THREE.AnimationAction, duration: number): void {
    forEachActiveAction(mixer, action => {
        if (action === keep) return;
        if (!action.enabled) return;
        if (action.getEffectiveWeight() <= 1e-4) return;
        action.fadeOut(duration);
    });
}

/**
 * Sum of effective weights of *active* actions on the mixer (excluding `keep`).
 * Used to decide whether a transition has an existing contribution to crossfade
 * with — if zero, fading in from 0 would expose bind pose, so snap instead.
 */
export function totalOtherActiveWeight(mixer: THREE.AnimationMixer, keep: THREE.AnimationAction): number {
    let total = 0;
    forEachActiveAction(mixer, action => {
        if (action === keep) return;
        if (!action.enabled) return;
        total += action.getEffectiveWeight();
    });
    return total;
}

/**
 * Schedule a weight interpolation from `startWeight` to 1 over `duration`, the
 * same mechanism Three.js's `fadeIn` uses but with a configurable start. We use
 * this to make a new action's fade-in start at `1 - otherTotal` so the
 * cumulative weight on the mixer stays at exactly 1 throughout the crossfade,
 * even when the previous actions were already mid-fade (sum < 1).
 *
 * Three.js exposes the same private helper internally; we cast to reach it.
 */
type ActionInternal = { _scheduleFading: (duration: number, weightNow: number, weightThen: number) => THREE.AnimationAction };
export function fadeInFromWeight(action: THREE.AnimationAction, duration: number, startWeight: number): void {
    if (duration <= 0) {
        action.setEffectiveWeight(1);
        return;
    }
    const internal = action as unknown as Partial<ActionInternal>;
    if (typeof internal._scheduleFading === 'function') {
        internal._scheduleFading(duration, Math.max(0, Math.min(1, startWeight)), 1);
    } else {
        // Fallback: snap (shouldn't be reached with Three.js's public API)
        action.setEffectiveWeight(1);
    }
}

/**
 * Per-frame safety net. After `mixer.update`, if the sum of all active action
 * weights is below 1, Three.js's PropertyMixer will fill the gap with bind
 * pose (visible as T-pose). Boost `ctx.currentAction`'s effective weight to
 * cover the deficit so the next frame's render has cumulative ≥ 1.
 *
 * This catches cases where transitions left the mixer in a bad state — e.g.
 * an action got disabled by a stale fadeOut interpolant when it was activated,
 * or a fade-out completed before its corresponding fade-in finished.
 */
export function ensureMixerWeightCovered(ctx: AnimationContext): void {
    const mixer = ctx.mixer;
    const current = ctx.currentAction;
    if (!mixer || !current) return;
    let total = 0;
    forEachActiveAction(mixer, action => {
        if (!action.enabled) return;
        total += action.getEffectiveWeight();
    });
    if (total >= 1 - 1e-3) return;
    const deficit = 1 - total;
    const currentEffective = current.getEffectiveWeight();
    current.enabled = true;
    current.stopFading();
    current.setEffectiveWeight(currentEffective + deficit);
}

/**
 * Cross-fade from current action to a new action.
 * Shared utility used by multiple subsystems.
 */
export function crossFadeToAction(ctx: AnimationContext, newAction: THREE.AnimationAction, duration: number): void {
    // Same action: never call fadeIn (would dip weight to 0 → bind-pose flash).
    // Restart paused/finished actions cleanly at full weight.
    if (ctx.currentAction === newAction) {
        const clipDuration = newAction.getClip?.()?.duration ?? Infinity;
        const isFinished = newAction.paused || newAction.time >= clipDuration - 1e-3;
        if (isFinished) {
            newAction.reset();
            newAction.play();
        } else {
            newAction.stopFading();
            newAction.enabled = true;
        }
        newAction.setEffectiveWeight(1);
        if (ctx.mixer) fadeOutAllOtherActions(ctx.mixer, newAction, duration);
        return;
    }
    // Reset zeros `time`. For looping clips (WALK / RUN / IDLE) that's the
    // wrong default when crossfading back IN — it snaps the cycle to frame 0
    // and produces a visible "walk animation restart" twitch every transition.
    // Preserve `time` for loopers, full reset for one-shots so attacks /
    // jumps always start at the wind-up frame.
    const isLooping = newAction.loop !== THREE.LoopOnce;
    if (isLooping) {
        // Match what reset() does, minus the `time = 0` line: re-enable, clear
        // pause/loop-count/start-time, stop any in-flight fade.
        const preservedTime = newAction.time;
        newAction.reset();
        newAction.time = preservedTime;
    } else {
        newAction.reset();
    }
    newAction.play();
    // The PropertyMixer blends in bind pose whenever cumulative weight < 1. To
    // hold sum at exactly 1 throughout the crossfade, start the new action at
    // (1 - otherTotal) — complementary to whatever the other actions currently
    // contribute. As they fade out their current weight → 0, this fades from
    // (1 - otherTotal) → 1, and sum stays at 1.
    const otherTotal = ctx.mixer ? Math.min(1, totalOtherActiveWeight(ctx.mixer, newAction)) : 0;
    const startWeight = 1 - otherTotal;
    fadeInFromWeight(newAction, duration, startWeight);
    if (ctx.mixer) fadeOutAllOtherActions(ctx.mixer, newAction, duration);
    ctx.currentAction = newAction;
}

function getAssetRecords(ctx: AnimationContext): Record<string, unknown>[] | null {
    const data = ctx.gameDataProvider?.();
    if (!data?.assets) return null;
    return data.assets as Record<string, unknown>[];
}

/**
 * Look up an animation asset by ID from the game data provider.
 */
export function findAnimationAsset(ctx: AnimationContext, motionId: string): Record<string, unknown> | null {
    const assets = getAssetRecords(ctx);
    return assets?.find(a => a.id === motionId || a.motionId === motionId) ?? null;
}

/**
 * Look up an animation asset by NAME from the game data provider, returning its id.
 * Used as a fallback when callers pass an asset name instead of a motion id.
 */
export function findAnimationAssetIdByName(ctx: AnimationContext, name: string): string | null {
    const assets = getAssetRecords(ctx);
    if (!assets) return null;
    const lower = name.toLowerCase();
    const asset = assets.find(a =>
        a.type === 'animation' && typeof a.name === 'string' && a.name.toLowerCase() === lower
    );
    const id = asset?.id ?? asset?.motionId;
    return typeof id === 'string' ? id : null;
}

/**
 * Safely get the AnimationClip from an action.
 */
export function getActionClip(action: THREE.AnimationAction): THREE.AnimationClip | null {
    return action.getClip?.() ?? null;
}

/**
 * Get the character's uniform world scale (assumes uniform scaling).
 */
export function getCharacterUniformWorldScale(ctx: AnimationContext): number {
    if (!ctx.character) return 1;
    const s = new THREE.Vector3();
    ctx.character.getWorldScale(s);
    return s.x || 1;
}
