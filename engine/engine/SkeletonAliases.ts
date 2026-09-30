/**
 * Canonical bone-name aliases for player rigs.
 *
 * Player skeletons come in several flavours — Mixamo (`mixamorigRightHand`),
 * Unreal Manny (`hand_r`), plain artist-named (`RightHand`, `right_hand`),
 * and so on. Template / gameplay code wants to write the obvious thing:
 *
 *     const hand = player.getObjectByName('rightHand');
 *
 * For that to work on every rig, we walk the skeleton after the player
 * loads and attach an empty `Object3D` child to each real bone, named with
 * the canonical name. The marker inherits the bone's world transform, so
 * anything attached to it tracks animations exactly as if it were attached
 * to the bone directly. We never rename the actual bones — animation tracks
 * reference bones by name and would break.
 *
 * Always invoke `applyCanonicalBoneAliases(playerRoot)` once after the
 * skeleton is set up.
 */

import * as THREE from 'three';

/**
 * Canonical body-part name → list of bone names to try in order. The first
 * matching bone wins; case-insensitive substring match is used as a final
 * fallback when no exact match is found.
 */
export const CANONICAL_BONE_NAMES: Record<string, string[]> = {
    head: ['mixamorig2Head', 'mixamorigHead', 'Head', 'head', 'head_bone', 'Head_Bone'],
    neck: ['mixamorig2Neck', 'mixamorigNeck', 'Neck', 'neck', 'neck_bone', 'Neck_Bone', 'neck_01', 'Neck_01'],
    torso: [
        'mixamorig2Spine', 'mixamorigSpine', 'Spine', 'spine', 'spine_bone', 'Spine_Bone',
        'mixamorig2Spine1', 'mixamorigSpine1', 'Spine1', 'spine_01', 'spine_02', 'spine_03',
        'Spine_01', 'Spine_02', 'Spine_03',
    ],
    leftHand: ['mixamorig2LeftHand', 'mixamorigLeftHand', 'LeftHand', 'left_hand', 'Left_Hand', 'Hand_L', 'hand_l'],
    rightHand: ['mixamorig2RightHand', 'mixamorigRightHand', 'RightHand', 'right_hand', 'Right_Hand', 'Hand_R', 'hand_r'],
    leftFoot: [
        'mixamorig2LeftFoot', 'mixamorig2LeftToeBase', 'mixamorigLeftFoot', 'mixamorigLeftToeBase',
        'LeftFoot', 'LeftToeBase', 'left_foot', 'Left_Foot', 'Foot_L', 'foot_l',
    ],
    rightFoot: [
        'mixamorig2RightFoot', 'mixamorig2RightToeBase', 'mixamorigRightFoot', 'mixamorigRightToeBase',
        'RightFoot', 'RightToeBase', 'right_foot', 'Right_Foot', 'Foot_R', 'foot_r',
    ],
    leftUpperArm: [
        'mixamorig2LeftArm', 'mixamorigLeftArm', 'LeftArm', 'left_arm', 'Left_Arm', 'Arm_L', 'arm_l',
        'upperarm_l', 'UpperArm_L',
    ],
    leftForearm: [
        'mixamorig2LeftForeArm', 'mixamorigLeftForeArm', 'LeftForeArm', 'LeftForearm', 'left_forearm',
        'Left_Forearm', 'ForeArm_L', 'forearm_l', 'lowerarm_l', 'LowerArm_L',
    ],
    rightUpperArm: [
        'mixamorig2RightArm', 'mixamorigRightArm', 'RightArm', 'right_arm', 'Right_Arm', 'Arm_R', 'arm_r',
        'upperarm_r', 'UpperArm_R',
    ],
    rightForearm: [
        'mixamorig2RightForeArm', 'mixamorigRightForeArm', 'RightForeArm', 'RightForearm', 'right_forearm',
        'Right_Forearm', 'ForeArm_R', 'forearm_r', 'lowerarm_r', 'LowerArm_R',
    ],
    leftThigh: [
        'mixamorig2LeftUpLeg', 'mixamorigLeftUpLeg', 'LeftUpLeg', 'LeftThigh', 'left_thigh', 'Left_Thigh',
        'Thigh_L', 'thigh_l', 'LeftLeg', 'left_leg',
    ],
    leftShin: [
        'mixamorig2LeftLeg', 'mixamorigLeftLeg', 'LeftLeg', 'LeftShin', 'left_shin', 'Left_Shin',
        'Shin_L', 'shin_l', 'LeftLowerLeg', 'left_lower_leg', 'calf_l', 'Calf_L',
    ],
    rightThigh: [
        'mixamorig2RightUpLeg', 'mixamorigRightUpLeg', 'RightUpLeg', 'RightThigh', 'right_thigh', 'Right_Thigh',
        'Thigh_R', 'thigh_r', 'RightLeg', 'right_leg',
    ],
    rightShin: [
        'mixamorig2RightLeg', 'mixamorigRightLeg', 'RightLeg', 'RightShin', 'right_shin', 'Right_Shin',
        'Shin_R', 'shin_r', 'RightLowerLeg', 'right_lower_leg', 'calf_r', 'Calf_R',
    ],
};

/**
 * Find the first bone under `root` matching any of `candidates`. Tries
 * exact match first, then case-insensitive substring match.
 */
export function findBoneByCandidates(
    root: THREE.Object3D,
    candidates: readonly string[],
): THREE.Object3D | null {
    let found: THREE.Object3D | null = null;
    for (const name of candidates) {
        root.traverse((child) => {
            if (found) return;
            if ((child as THREE.Bone).isBone && child.name === name) found = child;
        });
        if (found) return found;
    }
    const lower = candidates.map(n => n.toLowerCase());
    root.traverse((child) => {
        if (found) return;
        if (!(child as THREE.Bone).isBone) return;
        const childName = child.name.toLowerCase();
        for (const search of lower) {
            if (childName.includes(search) || search.includes(childName)) {
                found = child;
                return;
            }
        }
    });
    return found;
}

/**
 * After the skeleton is loaded, attach an empty `Object3D` named with each
 * canonical body-part name (e.g. `'rightHand'`) under the matching real
 * bone. Skips bones that already have a child with that canonical name so
 * repeat calls are idempotent.
 *
 * Returns the number of aliases that were newly added — useful for logging.
 */
export function applyCanonicalBoneAliases(playerRoot: THREE.Object3D): number {
    let added = 0;
    for (const canonical of Object.keys(CANONICAL_BONE_NAMES)) {
        const candidates = CANONICAL_BONE_NAMES[canonical]!;
        const bone = findBoneByCandidates(playerRoot, candidates);
        if (!bone) continue;
        const existing = bone.children.find(c => c.name === canonical);
        if (existing) continue;
        const alias = new THREE.Object3D();
        alias.name = canonical;
        bone.add(alias);
        added++;
    }
    return added;
}
