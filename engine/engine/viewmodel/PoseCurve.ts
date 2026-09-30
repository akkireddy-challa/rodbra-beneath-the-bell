import * as THREE from 'three';

/**
 * View-model poses and the keyframed curves that animate them.
 *
 * A view model is authored as SCREEN-SPACE motion, not as a skeletal
 * performance: this close to the camera a shoulder-driven animation reads as
 * nothing at all, while a hand-tuned transform curve reads as weight. So every
 * motion here is a parametric curve over a position/euler pair, evaluated per
 * frame — the same approach FirstPersonMeleeSystem's swing arcs already use,
 * generalised so recoil, reloads, equips and swings share one evaluator.
 *
 * Rotations are XYZ eulers in radians, applied in three's default order. That
 * order is deliberate rather than incidental: it is what the shipped melee view
 * model already poses with, and all view-model angles are small enough that the
 * choice is invisible anyway.
 */

/** A view-model transform: offset and euler rotation, both relative to the camera. */
export interface ViewModelPose {
    /** Metres, camera space (+X right, +Y up, −Z forward). */
    position: THREE.Vector3;
    /** Radians, XYZ euler. */
    rotation: THREE.Vector3;
}

/** Normalised easing: maps 0..1 to 0..1. */
export type EaseFn = (t: number) => number;

export const linear: EaseFn = (t) => t;
export const easeInQuad: EaseFn = (t) => t * t;
export const easeOutQuad: EaseFn = (t) => 1 - (1 - t) * (1 - t);
export const easeInCubic: EaseFn = (t) => t * t * t;
export const easeOutCubic: EaseFn = (t) => 1 - Math.pow(1 - t, 3);
export const easeInOutCubic: EaseFn = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const smoothstep: EaseFn = (t) => t * t * (3 - 2 * t);

/**
 * Overshoots past the target before settling. Used on equip so the weapon
 * arrives with a little momentum instead of gliding to a mathematical stop.
 */
export const easeOutBack: EaseFn = (t) => {
    const c1 = 1.20158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

/** One keyframe of a `PoseCurve`. */
export interface PoseCurveKey {
    /** Normalised time within the curve, 0..1. Keys must be in ascending order. */
    t: number;
    /** Pose at this key, as an offset from the resting pose. */
    pose: ViewModelPose;
    /**
     * Easing applied across the segment ENDING at this key. The first key needs
     * none — nothing precedes it.
     */
    ease: EaseFn;
}

/**
 * A keyframed additive pose curve, normalised to 0..1 so one curve can be
 * played at any duration. Values are offsets from the resting pose, so a curve
 * that starts and ends at zero leaves the weapon exactly where it found it.
 */
export type PoseCurve = readonly PoseCurveKey[];

export function createPose(
    px = 0, py = 0, pz = 0, rx = 0, ry = 0, rz = 0,
): ViewModelPose {
    return { position: new THREE.Vector3(px, py, pz), rotation: new THREE.Vector3(rx, ry, rz) };
}

/** A pose with every channel at zero — the neutral element for additive blending. */
export function zeroPose(): ViewModelPose {
    return createPose();
}

export function copyPose(target: ViewModelPose, source: ViewModelPose): ViewModelPose {
    target.position.copy(source.position);
    target.rotation.copy(source.rotation);
    return target;
}

export function resetPose(target: ViewModelPose): ViewModelPose {
    target.position.set(0, 0, 0);
    target.rotation.set(0, 0, 0);
    return target;
}

/** `target += source * scale`. The summation step for additive contributions. */
export function addScaledPose(target: ViewModelPose, source: ViewModelPose, scale: number): ViewModelPose {
    target.position.addScaledVector(source.position, scale);
    target.rotation.addScaledVector(source.rotation, scale);
    return target;
}

/** `target = lerp(target, source, t)`. The blend step for exclusive base poses. */
export function mixPose(target: ViewModelPose, source: ViewModelPose, t: number): ViewModelPose {
    target.position.lerp(source.position, t);
    target.rotation.lerp(source.rotation, t);
    return target;
}

/**
 * Sample a curve at normalised time `t`, writing the offset into `out`.
 *
 * Times outside the curve clamp to its ends, which is what makes a curve safe
 * to keep evaluating for a frame or two after it logically finishes.
 */
export function evaluatePoseCurve(curve: PoseCurve, t: number, out: ViewModelPose): ViewModelPose {
    let prev: PoseCurveKey | null = null;
    for (const key of curve) {
        if (prev === null) {
            // Before the first key: hold it.
            if (t <= key.t) return copyPose(out, key.pose);
            prev = key;
            continue;
        }
        if (t > key.t) {
            prev = key;
            continue;
        }
        const span = key.t - prev.t;
        // Zero-length segments are a step change, not a division by zero.
        const local = span > 0 ? (t - prev.t) / span : 1;
        copyPose(out, prev.pose);
        return mixPose(out, key.pose, key.ease(local));
    }
    // Past the last key (or an empty curve): hold the end.
    return prev === null ? resetPose(out) : copyPose(out, prev.pose);
}

/**
 * Build the classic three-phase melee swing as a curve: rest → windup → strike
 * → rest, with a slow pull-back, a fast follow-through and an eased recovery.
 *
 * Kept here rather than in the melee system so swings, reloads and equips all
 * animate through one evaluator.
 */
export function createSwingCurve(
    windup: ViewModelPose,
    strike: ViewModelPose,
    windupEnd: number,
    strikeEnd: number,
): PoseCurve {
    return [
        { t: 0, pose: zeroPose(), ease: linear },
        { t: windupEnd, pose: windup, ease: easeOutQuad },
        { t: strikeEnd, pose: strike, ease: easeInOutCubic },
        { t: 1, pose: zeroPose(), ease: easeOutQuad },
    ];
}
