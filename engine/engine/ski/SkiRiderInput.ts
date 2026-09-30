import type * as THREE from 'three';

const DEG2RAD = Math.PI / 180;

/**
 * Synthetic control input for an AI ski/snowboard rider — the SAME `keys` shape
 * the keyboard produces for `SkiMovement`. The bot "presses" these so AI riders
 * run the player's EXACT physics; only the input is generated. Difficulty is a
 * property of how this input is produced (see {@link SkiRiderSkill}), never of a
 * separate movement model.
 */
export interface SkiRiderKeys {
    forward: boolean;
    backward: boolean;
    left: boolean;
    right: boolean;
    ascend: boolean;
    interact: boolean;
    action: boolean;
    secondaryAction: boolean;
    descend: boolean;
}

/**
 * How the AI rides — the "skill" knobs. All-equal physics means difficulty is
 * tuned here (and via the rider's target line / speed caps), not by changing the
 * movement. Required fields + an exported default per engine convention.
 */
export interface SkiRiderSkill {
    /** Don't steer while the heading error is under this (rad) — kills oscillation. */
    steerDeadzoneRad: number;
    /** Brake (instead of tuck) when |heading error| exceeds this (rad) AND the
     *  rider is above `brakeMinSpeed` — i.e. a turn too sharp to carve at speed. */
    brakeAngleRad: number;
    /** Only brake above this speed (m/s); below it, carving alone handles the turn. */
    brakeMinSpeed: number;
}

export const DEFAULT_SKI_RIDER_SKILL: SkiRiderSkill = {
    steerDeadzoneRad: 3 * DEG2RAD,
    brakeAngleRad: 60 * DEG2RAD,
    brakeMinSpeed: 16,
};

function straightTuck(): SkiRiderKeys {
    return {
        forward: true, backward: false, left: false, right: false,
        ascend: false, interact: false, action: false, secondaryAction: false, descend: false,
    };
}

/**
 * Decide the rider's `keys` for this frame.
 *
 * @param currentHeading travel yaw now (rad, gameplay convention: forward = (sin, 0, cos)) — `SkiState.heading`
 * @param speed          current horizontal speed (m/s) — `SkiState.speed`
 * @param desiredDir     horizontal direction toward the next gate/waypoint (need not be normalized)
 * @param skill          difficulty knobs
 */
export function computeSkiRiderKeys(
    currentHeading: number,
    speed: number,
    desiredDir: THREE.Vector3,
    skill: SkiRiderSkill,
): SkiRiderKeys {
    // No target (arrived / none): just hold the tuck and let gravity carry it.
    if (desiredDir.x * desiredDir.x + desiredDir.z * desiredDir.z < 1e-6) return straightTuck();

    // Heading error, normalized to [-pi, pi]. Positive = target is to the left
    // (higher yaw), which SkiMovement reaches with `left` (turnInput +1).
    const desiredHeading = Math.atan2(desiredDir.x, desiredDir.z);
    let err = desiredHeading - currentHeading;
    while (err > Math.PI) err -= 2 * Math.PI;
    while (err < -Math.PI) err += 2 * Math.PI;
    const absErr = Math.abs(err);

    const brake = absErr > skill.brakeAngleRad && speed > skill.brakeMinSpeed;
    return {
        // Tuck (or skate-push when slow) unless the turn is too sharp to take at speed.
        forward: !brake,
        backward: brake,
        // Carve toward the gate; the deadzone stops left/right chatter near-aligned.
        left: err > skill.steerDeadzoneRad,
        right: err < -skill.steerDeadzoneRad,
        ascend: false, interact: false, action: false, secondaryAction: false, descend: false,
    };
}
