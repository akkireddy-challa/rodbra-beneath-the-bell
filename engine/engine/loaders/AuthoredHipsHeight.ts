import * as THREE from 'three';
import type { AnimationPose } from 'engine/animation/PoseTransition.js';
import type { MixamoAnimationPlayer } from 'engine/MixamoAnimationPlayer.js';

const reference = new THREE.Vector3();
const facing = new THREE.Quaternion();
const origin = new THREE.Vector3();

/** The composed source pelvis owns vertical animation, not the current lowest
 * ankle, toe or shoe corner. Sample and rest reference must share the source
 * skeleton's origin: clips follow the render root, whose previous grounding
 * correction is not authored motion. Rest offsets are in world metres.
 * `restHips` is the rest the POSE was composed in when that is not `source`'s
 * own: a skinned rig reads every player in one reference rest, and measuring a
 * crossfade against whichever player is the source hops the body by the
 * difference between their hips heights. */
export function authoredHipsHeight(
    pose: AnimationPose | null, source: MixamoAnimationPlayer | null | undefined,
    frame: THREE.Object3D, hipsName: string | undefined,
    restHips: THREE.Vector3 | null = source?.getRestHipsOffset() ?? null,
): { position: number; offset: number } | null {
    const hips = hipsName ? pose?.get(hipsName) : null;
    if (!source || !restHips || !hips) return null;
    frame.getWorldQuaternion(facing);
    reference.copy(restHips).applyQuaternion(facing);
    reference.y += (source.getSkeletonRoot() ?? frame).getWorldPosition(origin).y;
    const offset = hips.position.y - reference.y;
    if (!Number.isFinite(offset)) return null;
    return { position: hips.position.y, offset: THREE.MathUtils.clamp(offset, -1.5, 1.5) };
}
