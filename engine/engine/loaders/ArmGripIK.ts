import * as THREE from 'three';
import { CANONICAL_BONE_NAMES, findBoneByCandidates } from 'engine/SkeletonAliases.js';

/**
 * Two-bone arm IK for skinned characters gripping a weapon.
 *
 * Block characters grip a gun by repositioning their visible block arm groups
 * onto the weapon grips every frame (`BlockCharacterRenderer.setArmAttachmentOverride`).
 * Skinned characters have no such groups — the visible arms are GPU-skinned from
 * the real skeleton bones — so to make a hand reach a grip we have to pose the
 * actual `upperArm → forearm → hand` bone chain with inverse kinematics.
 *
 * A grip is solved AFTER the animation pose is applied to the skeleton, so the
 * shoulder sits where the current animation puts it; only the three arm bones of
 * the gripping side are overridden. The rest of the body keeps its animation.
 */
export interface ArmGrip {
    /** Object whose world transform defines the grip frame (usually the weapon mesh). */
    target: THREE.Object3D;
    /** Wrist offset in world metres, expressed in the target's rotation frame.
     * Target scale is not applied; callers convert authored mesh coordinates once. */
    offset: THREE.Vector3;
    /** Hand orientation at the grip, relative to the target's frame. */
    rotation: THREE.Euler;
}

interface ArmBones {
    upperArm: THREE.Object3D;
    forearm: THREE.Object3D;
    hand: THREE.Object3D;
}

const _shoulderPos = new THREE.Vector3();
const _gripPos = new THREE.Vector3();
const _targetPos = new THREE.Vector3();
const _elbowPos = new THREE.Vector3();
const _dirRT = new THREE.Vector3();
const _poleDir = new THREE.Vector3();
const _planeNormal = new THREE.Vector3();
const _bendPerp = new THREE.Vector3();
const _seg1 = new THREE.Vector3();
const _seg2 = new THREE.Vector3();
const _fDir = new THREE.Vector3();
const _hDir = new THREE.Vector3();
const _elbowCurr = new THREE.Vector3();
const _wristCurr = new THREE.Vector3();
const _charQuat = new THREE.Quaternion();
const _targetQuat = new THREE.Quaternion();
const _parentQuat = new THREE.Quaternion();
const _worldQuat = new THREE.Quaternion();
const _handLocalQuat = new THREE.Quaternion();
const _curU = new THREE.Quaternion();
const _curF = new THREE.Quaternion();
const _delta = new THREE.Quaternion();

/**
 * Resolve and cache the three arm bones for a side from a skinned skeleton root.
 * Returns null if any bone is missing.
 */
export function resolveArmBones(root: THREE.Object3D, side: 'left' | 'right'): ArmBones | null {
    const upperArm = findBoneByCandidates(root, CANONICAL_BONE_NAMES[`${side}UpperArm`]!);
    const forearm = findBoneByCandidates(root, CANONICAL_BONE_NAMES[`${side}Forearm`]!);
    const hand = findBoneByCandidates(root, CANONICAL_BONE_NAMES[`${side}Hand`]!);
    if (!upperArm || !forearm || !hand) return null;
    return { upperArm, forearm, hand };
}

/**
 * Pose one arm so its hand reaches the grip. Mutates the three arm bones'
 * quaternions in place and refreshes their world matrices. Call AFTER the
 * animation pose has been applied to the rest of the skeleton.
 *
 * @param root  skinned skeleton root (provides the character's facing for the
 *              elbow pole hint and the uniform world scale for bone lengths)
 * @param side  which arm
 * @param bones resolved arm chain (see resolveArmBones)
 * @param grip  grip frame, offset and hand rotation
 */
export function solveArmGrip(
    root: THREE.Object3D,
    side: 'left' | 'right',
    bones: ArmBones,
    grip: ArmGrip,
): void {
    const { upperArm, forearm, hand } = bones;

    // Read the three joints' CURRENT world positions (after the animation pose).
    // Deriving segment lengths and aim directions from world positions makes the
    // solver immune to the bone hierarchy: it doesn't matter whether forearm is a
    // direct child of upperArm or sits behind twist/roll bones. (Using
    // bone.position assumes a clean direct chain — false on many generated rigs,
    // which produced the "arms balled into the torso" collapse.)
    upperArm.updateWorldMatrix(true, false);
    upperArm.getWorldPosition(_shoulderPos);
    forearm.getWorldPosition(_elbowCurr);
    hand.getWorldPosition(_wristCurr);

    // Grip point in world space.
    grip.target.updateWorldMatrix(true, false);
    grip.target.getWorldQuaternion(_targetQuat);
    grip.target.getWorldPosition(_targetPos);
    _gripPos.copy(grip.offset).applyQuaternion(_targetQuat).add(_targetPos);

    // Bone segment lengths from the current world joint positions (pose-invariant).
    const a = _elbowCurr.distanceTo(_shoulderPos); // shoulder → elbow
    const b = _wristCurr.distanceTo(_elbowCurr);   // elbow → wrist
    if (a < 1e-6 || b < 1e-6) return;

    // Reach, clamped so the triangle is solvable (leave a hair of bend so the
    // arm never fully locks straight, which makes the elbow direction singular).
    _dirRT.copy(_gripPos).sub(_shoulderPos);
    let L = _dirRT.length();
    if (L < 1e-6) return;
    _dirRT.divideScalar(L);

    L = THREE.MathUtils.clamp(L, Math.abs(a - b) + 1e-3, a + b - 1e-3);

    // Elbow bend angle at the shoulder (law of cosines).
    const cosShoulder = THREE.MathUtils.clamp((a * a + L * L - b * b) / (2 * a * L), -1, 1);
    const shoulderAngle = Math.acos(cosShoulder);

    // Pole hint: elbows fall down, slightly back and outward. Build it in the
    // character's facing frame so it tracks rotation.
    root.getWorldQuaternion(_charQuat);
    const outward = side === 'right' ? 0.35 : -0.35;
    _poleDir.set(outward, -1, -0.45).applyQuaternion(_charQuat).normalize();

    // Bend plane: contains the shoulder→grip axis and the pole hint.
    _planeNormal.copy(_dirRT).cross(_poleDir);
    if (_planeNormal.lengthSq() < 1e-8) {
        // Pole parallel to reach axis — pick any perpendicular.
        _planeNormal.set(0, 0, 1).cross(_dirRT);
        if (_planeNormal.lengthSq() < 1e-8) _planeNormal.set(1, 0, 0).cross(_dirRT);
    }
    _planeNormal.normalize();
    // In-plane perpendicular to the reach axis, pointing toward the pole side.
    _bendPerp.copy(_planeNormal).cross(_dirRT).normalize();
    if (_bendPerp.dot(_poleDir) < 0) _bendPerp.negate();

    // Elbow position.
    _elbowPos.copy(_dirRT).multiplyScalar(Math.cos(shoulderAngle))
        .addScaledVector(_bendPerp, Math.sin(shoulderAngle))
        .multiplyScalar(a)
        .add(_shoulderPos);

    _seg1.copy(_elbowPos).sub(_shoulderPos).normalize();
    _seg2.copy(_gripPos).sub(_elbowPos).normalize();

    // Pose each bone with a DELTA swing of its CURRENT world aim onto the target
    // segment, using world joint directions (not bone.position). This preserves
    // the animation's twist/roll and is hierarchy-agnostic: rotating the upper
    // arm carries any intermediate bones + the forearm with it, so the chain
    // stays intact and the mesh doesn't wring.

    // Upper arm: swing shoulder→elbow(current) onto shoulder→elbow(IK target).
    _fDir.copy(_elbowCurr).sub(_shoulderPos).normalize();
    _delta.setFromUnitVectors(_fDir, _seg1);
    upperArm.getWorldQuaternion(_curU);
    _worldQuat.copy(_delta).multiply(_curU);
    setBoneWorldQuaternion(upperArm, _worldQuat);
    upperArm.updateWorldMatrix(true, false);

    // Forearm: re-read joints after the upper-arm swing, then swing
    // elbow→wrist(current) onto elbow→wrist(IK target = grip).
    forearm.getWorldPosition(_elbowCurr);
    hand.getWorldPosition(_wristCurr);
    _hDir.copy(_wristCurr).sub(_elbowCurr).normalize();
    _delta.setFromUnitVectors(_hDir, _seg2);
    forearm.getWorldQuaternion(_curF);
    _worldQuat.copy(_delta).multiply(_curF);
    setBoneWorldQuaternion(forearm, _worldQuat);
    forearm.updateWorldMatrix(true, false);

    // Hand: orient to the grip frame.
    _handLocalQuat.setFromEuler(grip.rotation);
    _worldQuat.copy(_targetQuat).multiply(_handLocalQuat);
    setBoneWorldQuaternion(hand, _worldQuat);
    hand.updateWorldMatrix(true, false);
}

/** Set a bone's local quaternion so its world rotation equals worldQuat. */
function setBoneWorldQuaternion(bone: THREE.Object3D, worldQuat: THREE.Quaternion): void {
    if (bone.parent) {
        bone.parent.getWorldQuaternion(_parentQuat);
        bone.quaternion.copy(_parentQuat.invert()).multiply(worldQuat);
    } else {
        bone.quaternion.copy(worldQuat);
    }
    bone.updateMatrix();
}
