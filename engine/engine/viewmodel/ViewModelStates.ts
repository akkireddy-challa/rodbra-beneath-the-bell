import * as THREE from 'three';
import {
    createPose,
    easeInCubic,
    easeInOutCubic,
    easeOutCubic,
    easeOutQuad,
    linear,
    zeroPose,
    type PoseCurve,
    type ViewModelPose,
} from 'engine/viewmodel/PoseCurve.js';

/**
 * The poses a view model holds, and how much of each applies right now.
 *
 * Two kinds, deliberately handled differently:
 *
 *   - LOCOMOTION states (idle / walk / sprint / airborne) are not events. They
 *     are continuous weights recomputed every frame from speed and ground
 *     contact, so there is no enter/exit callback to desync and no way for the
 *     weapon to be left in a sprint pose because a transition was missed.
 *
 *   - ACTION states (equip / holster / reload / inspect) are exclusive, timed
 *     curves. They take over the base pose while they run and fade back out.
 *
 * All poses here are OFFSETS from the weapon's resting pose, so a weapon can be
 * re-authored by changing one rest transform without retuning every state.
 */

export type ViewModelLocomotionState = 'idle' | 'walk' | 'sprint' | 'airborne';
export type ViewModelActionState = 'equip' | 'holster' | 'reload' | 'inspect';
export type ViewModelState = ViewModelLocomotionState | ViewModelActionState;

/**
 * Sprint carry: muzzle swung down and inboard, out of the centre of frame.
 *
 * This is the pose that tells a player, without any HUD, that they cannot shoot
 * right now — the same reason Titanfall and Call of Duty both lower the weapon
 * across the body rather than merely bobbing it harder.
 */
export const SPRINT_POSE: ViewModelPose = createPose(0.04, -0.05, 0.06, 0.10, 0.45, 0.30);

/** Airborne: the weapon hangs slightly, and the arm is not braced. */
export const AIRBORNE_POSE: ViewModelPose = createPose(0, -0.02, 0.02, -0.06, 0, 0.05);

/** Extra pitch per m/s of vertical velocity while airborne, clamped. */
export const AIRBORNE_PITCH_PER_VY = 0.006;
export const AIRBORNE_PITCH_MAX = 0.05;

/** Where the weapon starts an equip / ends a holster: below frame, tilted in. */
const STOWED_POSE: ViewModelPose = createPose(0.05, -0.35, -0.10, 0.90, 0.40, 0.25);

/**
 * Raise the weapon into frame, slightly past rest, then settle.
 *
 * The overshoot is the point: arriving exactly at rest reads as a mechanism
 * sliding into place, while a small pass-and-settle reads as a person bringing
 * something up and steadying it.
 */
export const EQUIP_CURVE: PoseCurve = [
    { t: 0, pose: STOWED_POSE, ease: linear },
    { t: 0.75, pose: createPose(-0.01, 0.02, 0.01, -0.08, -0.05, -0.03), ease: easeOutCubic },
    { t: 1, pose: zeroPose(), ease: easeOutQuad },
];

/** Put it away. No overshoot — nobody flourishes a weapon they are stowing. */
export const HOLSTER_CURVE: PoseCurve = [
    { t: 0, pose: zeroPose(), ease: linear },
    { t: 1, pose: STOWED_POSE, ease: easeInCubic },
];

/**
 * Reload: drop the weapon out of the aiming line, tug the magazine free, seat a
 * fresh one, bring it back up. The two mid keys are what make it read as a
 * two-beat mechanical action rather than a dip and a wait.
 */
export const RELOAD_CURVE: PoseCurve = [
    { t: 0, pose: zeroPose(), ease: linear },
    { t: 0.22, pose: createPose(0.02, -0.14, 0.06, 0.45, 0.30, -0.20), ease: easeOutCubic },
    { t: 0.42, pose: createPose(0.03, -0.17, 0.06, 0.50, 0.30, -0.34), ease: easeInOutCubic },
    { t: 0.60, pose: createPose(0.02, -0.12, 0.05, 0.40, 0.30, -0.10), ease: easeInOutCubic },
    { t: 0.75, pose: createPose(0.02, -0.14, 0.06, 0.45, 0.30, -0.20), ease: easeInOutCubic },
    { t: 1, pose: zeroPose(), ease: easeOutCubic },
];

/** Turn the weapon over to look at it. Opt-in only; the engine binds no key. */
export const INSPECT_CURVE: PoseCurve = [
    { t: 0, pose: zeroPose(), ease: linear },
    { t: 0.35, pose: createPose(-0.05, 0.02, 0.12, 0.15, 0.90, 0.35), ease: easeOutCubic },
    { t: 0.70, pose: createPose(-0.03, 0.03, 0.10, -0.10, 1.20, 0.15), ease: easeInOutCubic },
    { t: 1, pose: zeroPose(), ease: easeInOutCubic },
];

export const ACTION_CURVES: Record<ViewModelActionState, PoseCurve> = {
    equip: EQUIP_CURVE,
    holster: HOLSTER_CURVE,
    reload: RELOAD_CURVE,
    inspect: INSPECT_CURVE,
};

/** Fallback durations in seconds. Reload is normally driven by the magazine. */
export const ACTION_DEFAULT_DURATIONS: Record<ViewModelActionState, number> = {
    equip: 0.35,
    holster: 0.25,
    reload: 1.8,
    inspect: 1.1,
};

/**
 * Seconds an action's weight takes to fade in and out.
 *
 * Non-zero at BOTH ends so an action cancelled a few frames after it started —
 * a reload interrupted by a sprint, say — leaves continuously instead of
 * snapping the weapon back to rest.
 */
export const ACTION_FADE_SECONDS = 0.12;

/** Normalised speed at which the sprint pose starts and finishes blending in. */
export const SPRINT_BLEND_LOW = 0.82;
export const SPRINT_BLEND_HIGH = 1.0;

/** Normalised speed over which bob fades up from a standstill. */
export const BOB_GATE_LOW = 0.05;
export const BOB_GATE_HIGH = 0.25;

/** Half-lives for the continuous locomotion weights, in seconds. */
export const SPRINT_WEIGHT_HALF_LIFE = 0.09;
export const AIRBORNE_WEIGHT_HALF_LIFE = 0.10;

/**
 * How much of the sprint pose applies at this speed.
 *
 * Airborne cancels it outright: a player who jumps mid-sprint should see the
 * weapon come back up, because they can shoot again the moment they land.
 */
export function resolveSprintWeight(normalizedSpeed: number, grounded: boolean): number {
    if (!grounded) return 0;
    return THREE.MathUtils.smoothstep(normalizedSpeed, SPRINT_BLEND_LOW, SPRINT_BLEND_HIGH);
}

/** How much movement bob applies at this speed. */
export function resolveBobGate(normalizedSpeed: number): number {
    return THREE.MathUtils.smoothstep(normalizedSpeed, BOB_GATE_LOW, BOB_GATE_HIGH);
}

/** Actions that block aiming down sights until they finish. */
export const ADS_BLOCKING_ACTIONS: ReadonlySet<ViewModelActionState> = new Set<ViewModelActionState>([
    'equip', 'holster', 'reload',
]);
