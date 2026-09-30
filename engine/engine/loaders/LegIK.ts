import * as THREE from 'three';
import { CANONICAL_BONE_NAMES, findBoneByCandidates } from 'engine/SkeletonAliases.js';

/**
 * Two-bone leg IK: plant a foot at a target (e.g. a snowboard binding) and bend
 * the knee to reach it, leaving the hip wherever the body pose put it. Adapted
 * from ArmGripIK — same hierarchy-agnostic delta-swing solve (world joint
 * directions, not bone.position), so it survives twist/roll bones and any rig.
 *
 * Solve AFTER the body/animation pose is applied so the hip sits correctly;
 * only the three leg bones of each side are overridden. This is what keeps a
 * snowboarder's feet bolted to the board while the upper body twists freely.
 */
export interface LegBones {
    thigh: THREE.Object3D; // hip → knee (UpLeg)
    shin: THREE.Object3D;  // knee → ankle (Leg)
    foot: THREE.Object3D;
}

/** A skinned leg ends at the ANKLE. The block-part aliases prefer ToeBase,
 * which turns a two-segment leg solve into an invalid three-segment solve.
 * Missing ankles or invalid chains opt out instead of borrowing a toe. */
export function resolveSkinnedLegBones(root: THREE.Object3D, side: 'left' | 'right'): LegBones | null {
    const thigh = findBoneByCandidates(root, CANONICAL_BONE_NAMES[`${side}Thigh`]!);
    const shin = findBoneByCandidates(root, CANONICAL_BONE_NAMES[`${side}Shin`]!);
    const foot = findBoneByCandidates(root, CANONICAL_BONE_NAMES[`${side}Foot`]!.filter(name => !/toe/i.test(name)));
    if (!thigh || !shin || !foot || thigh === shin || shin === foot
        || !thigh.getObjectById(shin.id) || !shin.getObjectById(foot.id)) return null;
    return { thigh, shin, foot };
}

export interface FootTarget {
    /** World position the ankle should reach (on the board). */
    position: THREE.Vector3;
    /** World orientation for the foot (flat on the board, aligned to it). */
    quaternion: THREE.Quaternion;
}

/** Both foot targets plus the character facing (biases the knee pole forward). */
export interface LegIkTargets {
    left: FootTarget;
    right: FootTarget;
    facing: THREE.Quaternion;
}

const _hip = new THREE.Vector3();
const _kneeCurr = new THREE.Vector3();
const _ankleCurr = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _planeNormal = new THREE.Vector3();
const _bendPerp = new THREE.Vector3();
const _kneePos = new THREE.Vector3();
const _seg1 = new THREE.Vector3();
const _seg2 = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _curQ = new THREE.Quaternion();
const _worldQ = new THREE.Quaternion();
const _parentQ = new THREE.Quaternion();
const _delta = new THREE.Quaternion();

/**
 * Plant one foot at its target. Mutates the three leg bones' quaternions and
 * refreshes their world matrices.
 *
 * @param facingQuat character facing (world) — biases the knee pole forward
 * @param bones      resolved thigh/shin/foot chain
 * @param target     ankle world position + foot world orientation
 * @param preserveKneePlane keep the posed knee's bend plane for small automatic corrections;
 *                          explicit bindings retain the facing-based pole by default
 */
export function solveLegIK(
    facingQuat: THREE.Quaternion,
    bones: LegBones,
    target: FootTarget,
    preserveKneePlane = false,
): void {
    const { thigh, shin, foot } = bones;

    thigh.updateWorldMatrix(true, false);
    thigh.getWorldPosition(_hip);
    shin.getWorldPosition(_kneeCurr);
    foot.getWorldPosition(_ankleCurr);

    const a = _kneeCurr.distanceTo(_hip);   // hip → knee
    const b = _ankleCurr.distanceTo(_kneeCurr); // knee → ankle
    if (a < 1e-6 || b < 1e-6) return;

    _dir.copy(target.position).sub(_hip);
    let L = _dir.length();
    if (L < 1e-6) return;
    _dir.divideScalar(L);
    L = THREE.MathUtils.clamp(L, Math.abs(a - b) + 1e-3, a + b - 1e-3);

    // Knee bend angle at the hip (law of cosines).
    const cosHip = THREE.MathUtils.clamp((a * a + L * L - b * b) / (2 * a * L), -1, 1);
    const hipAngle = Math.acos(cosHip);

    // Pole: knees bend FORWARD and down, in the character's facing frame.
    _pole.set(0, -0.4, 1).applyQuaternion(facingQuat).normalize();
    if (preserveKneePlane) {
        _bendPerp.copy(_kneeCurr).sub(_hip);
        _bendPerp.addScaledVector(_dir, -_bendPerp.dot(_dir));
        if (_bendPerp.lengthSq() > 1e-8) _pole.copy(_bendPerp).normalize();
    }

    _planeNormal.copy(_dir).cross(_pole);
    if (_planeNormal.lengthSq() < 1e-8) {
        _planeNormal.set(0, 0, 1).cross(_dir);
        if (_planeNormal.lengthSq() < 1e-8) _planeNormal.set(1, 0, 0).cross(_dir);
    }
    _planeNormal.normalize();
    _bendPerp.copy(_planeNormal).cross(_dir).normalize();
    if (_bendPerp.dot(_pole) < 0) _bendPerp.negate();

    _kneePos.copy(_dir).multiplyScalar(Math.cos(hipAngle))
        .addScaledVector(_bendPerp, Math.sin(hipAngle))
        .multiplyScalar(a)
        .add(_hip);

    _seg1.copy(_kneePos).sub(_hip).normalize();
    _seg2.copy(target.position).sub(_kneePos).normalize();

    // Thigh: swing hip→knee(current) onto hip→knee(IK).
    _aim.copy(_kneeCurr).sub(_hip).normalize();
    _delta.setFromUnitVectors(_aim, _seg1);
    thigh.getWorldQuaternion(_curQ);
    _worldQ.copy(_delta).multiply(_curQ);
    setBoneWorldQuaternion(thigh, _worldQ);
    thigh.updateWorldMatrix(true, false);

    // Shin: re-read, then swing knee→ankle(current) onto knee→ankle(IK = target).
    shin.getWorldPosition(_kneeCurr);
    foot.getWorldPosition(_ankleCurr);
    _aim.copy(_ankleCurr).sub(_kneeCurr).normalize();
    _delta.setFromUnitVectors(_aim, _seg2);
    shin.getWorldQuaternion(_curQ);
    _worldQ.copy(_delta).multiply(_curQ);
    setBoneWorldQuaternion(shin, _worldQ);
    shin.updateWorldMatrix(true, false);

    // Use the requested foot orientation: a binding frame for explicit IK,
    // or the original posed ankle rotation for automatic skin corrections.
    setBoneWorldQuaternion(foot, target.quaternion);
    foot.updateWorldMatrix(true, false);
}

/**
 * Same solve, but on a world-space pose MAP (boneName -> {position, rotation})
 * — the form the block-character renderer consumes when a Mixamo/action
 * override is active. The map is flat world transforms, so there's no hierarchy
 * to propagate: we just rewrite the thigh/shin/foot entries. Read everything
 * from the originals before writing.
 */
export function solveLegIKMap(
    map: Map<string, { position: THREE.Vector3; rotation: THREE.Quaternion }>,
    keys: { thigh: string; shin: string; foot: string },
    facingQuat: THREE.Quaternion,
    target: FootTarget,
    preserveKneePlane = false,
): void {
    const thigh = map.get(keys.thigh);
    const shin = map.get(keys.shin);
    const foot = map.get(keys.foot);
    if (!thigh || !shin || !foot) return;

    _hip.copy(thigh.position);
    const a = shin.position.distanceTo(_hip);
    const b = foot.position.distanceTo(shin.position);
    if (a < 1e-6 || b < 1e-6) return;

    _dir.copy(target.position).sub(_hip);
    let L = _dir.length();
    if (L < 1e-6) return;
    _dir.divideScalar(L);
    L = THREE.MathUtils.clamp(L, Math.abs(a - b) + 1e-3, a + b - 1e-3);

    const hipAngle = Math.acos(THREE.MathUtils.clamp((a * a + L * L - b * b) / (2 * a * L), -1, 1));
    _pole.set(0, -0.4, 1).applyQuaternion(facingQuat).normalize();
    if (preserveKneePlane) {
        _bendPerp.copy(shin.position).sub(_hip);
        _bendPerp.addScaledVector(_dir, -_bendPerp.dot(_dir));
        if (_bendPerp.lengthSq() > 1e-8) _pole.copy(_bendPerp).normalize();
    }
    _planeNormal.copy(_dir).cross(_pole);
    if (_planeNormal.lengthSq() < 1e-8) {
        _planeNormal.set(0, 0, 1).cross(_dir);
        if (_planeNormal.lengthSq() < 1e-8) _planeNormal.set(1, 0, 0).cross(_dir);
    }
    _planeNormal.normalize();
    _bendPerp.copy(_planeNormal).cross(_dir).normalize();
    if (_bendPerp.dot(_pole) < 0) _bendPerp.negate();

    _kneePos.copy(_dir).multiplyScalar(Math.cos(hipAngle))
        .addScaledVector(_bendPerp, Math.sin(hipAngle))
        .multiplyScalar(a)
        .add(_hip);

    // Thigh: swing hip→knee(current) onto hip→knee(IK). (World rotations in the map.)
    _seg1.copy(shin.position).sub(_hip).normalize();
    _aim.copy(_kneePos).sub(_hip).normalize();
    _delta.setFromUnitVectors(_seg1, _aim);
    thigh.rotation.premultiply(_delta);

    // Shin: swing knee→ankle(current) onto knee→ankle(IK = target).
    _seg2.copy(foot.position).sub(shin.position).normalize();
    _aim.copy(target.position).sub(_kneePos).normalize();
    _delta.setFromUnitVectors(_seg2, _aim);
    shin.rotation.premultiply(_delta);

    // Plant the joints + flatten the foot onto the board.
    shin.position.copy(_kneePos);
    foot.position.copy(target.position);
    foot.rotation.copy(target.quaternion);
}

/** Set a bone's local quaternion so its world rotation equals worldQuat. */
function setBoneWorldQuaternion(bone: THREE.Object3D, worldQuat: THREE.Quaternion): void {
    if (bone.parent) {
        bone.parent.getWorldQuaternion(_parentQ);
        bone.quaternion.copy(_parentQ.invert()).multiply(worldQuat);
    } else {
        bone.quaternion.copy(worldQuat);
    }
    bone.updateMatrix();
}
