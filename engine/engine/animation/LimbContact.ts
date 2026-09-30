import * as THREE from 'three';
import type { ICharacterAnimationController } from 'engine/ICharacterAnimationController.js';

/**
 * Body-part bones LimbContact can test. These are the block-part names the
 * MixamoAnimationPlayer maps to skeleton bones (see BLOCK_PART_TO_MIXAMO_BONE).
 */
export type LimbPart = 'leftFoot' | 'rightFoot' | 'leftHand' | 'rightHand';

export interface LimbContactOptions {
    /** Body-part bones to test; the nearest one within range wins. */
    parts: LimbPart[];
    /**
     * Extra reach past the target surface that still counts as contact (m).
     * The limb bone is a joint (ankle / wrist) that sits behind the surface
     * that actually strikes, so allow that offset plus a small margin.
     */
    slack: number;
}

export const DEFAULT_LIMB_CONTACT_OPTIONS: LimbContactOptions = {
    parts: ['rightFoot', 'leftFoot'],
    slack: 0.45,
};

export interface LimbContactResult {
    /** Which body part made contact. */
    part: LimbPart;
    /** That bone's world position at the current frame. */
    point: THREE.Vector3;
    /** Distance from the bone to the target centre (m). */
    distance: number;
}

const _tmp = new THREE.Vector3();

/**
 * Test whether one of the player's body-part bones is touching a target sphere
 * at the CURRENT animation frame — the contact gate for sports / strike actions.
 *
 * Call this from an animation's `onImpact` callback (the clip's auto-detected
 * contact frame) to decide whether a swing actually connected: it returns the
 * nearest contacting limb, or `null` on a clean miss. Bone world transforms are
 * read live from the active Mixamo player (track B overlay, falling back to the
 * locomotion track), so the player's stepped-in pose at contact is what's tested.
 *
 * This is the generic primitive behind BallSportsSystem; it is sport-agnostic
 * (kick, header, volley, bump) and applies no force itself — the caller decides
 * what a hit does.
 *
 * @param animController Player animation controller (`PlayerController.animationController`).
 * @param targetCenter   World-space centre of the target (e.g. the ball body translation).
 * @param targetRadius   Target sphere radius (m).
 * @param options        Which limbs to test and the contact slack.
 */
export function detectLimbContact(
    animController: ICharacterAnimationController | null,
    targetCenter: { x: number; y: number; z: number },
    targetRadius: number,
    options?: Partial<LimbContactOptions>,
): LimbContactResult | null {
    if (!animController) return null;
    const { parts, slack } = { ...DEFAULT_LIMB_CONTACT_OPTIONS, ...options };

    const player = animController.getTrackBMixamoPlayer?.() ?? animController.getTrackAMixamoPlayer?.();
    if (!player) return null;

    // Guarantee the skeleton's world matrices are current before reading bones,
    // regardless of update ordering within the controller this frame.
    player.getSkeletonRoot()?.updateMatrixWorld(true);

    // Gate on the limb the clip actually strikes with, not the nearest limb.
    // mSoccerKick01 kicks with one foot; testing both feet would let the PLANTED
    // foot (near the ball when you stand beside it) pass on a clean miss. When
    // the clip's strike limb is one of the requested parts, test only it.
    const strikePart = player.getImpactPart();
    const testParts = strikePart && (parts as string[]).includes(strikePart)
        ? [strikePart as LimbPart]
        : parts;

    const maxDist = targetRadius + slack;
    let best: LimbContactResult | null = null;
    for (const part of testParts) {
        if (!player.getBoneWorldPosition(part, _tmp)) continue;
        const dx = _tmp.x - targetCenter.x;
        const dy = _tmp.y - targetCenter.y;
        const dz = _tmp.z - targetCenter.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist > maxDist) continue;
        if (!best || dist < best.distance) {
            best = { part, point: _tmp.clone(), distance: dist };
        }
    }
    return best;
}
