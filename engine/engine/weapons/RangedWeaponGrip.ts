import * as THREE from 'three';
import { type ArmGrip, resolveArmBones } from 'engine/loaders/ArmGripIK.js';

interface GripFit {
    lastPosition: THREE.Vector3;
    correction: THREE.Vector3;
}

// Only ranged weapons explicitly configured here participate. Other arm targets
// (tools, vehicle controls, custom poses) keep their existing attachment contract.
const fits = new WeakMap<THREE.Object3D, GripFit>();
const holdUpdaters = new WeakMap<THREE.Object3D, () => void>();

/** @internal NPC placement reads the final posed shoulder, immediately before grip IK. */
export function setRangedWeaponHoldUpdater(target: THREE.Object3D, update: () => void): void {
    holdUpdaters.set(target, update);
}
const armCache = new WeakMap<THREE.Object3D, {
    left: ReturnType<typeof resolveArmBones>;
    right: ReturnType<typeof resolveArmBones>;
}>();

// Applied at equip time and every frame. Offsets are relative to the real
// shoulder bone; the hidden block arm's center is a different reference point.
export const SKINNED_RANGED_HOLD = {
    single: { drop: 0.44, inward: 0.07, forward: 0 },
    rifle: { drop: 0.39, inward: 0.13, forward: 0.2 },
    dual: { drop: 0.34, inward: 0, forward: 0 },
} as const;

/** Bring each dual gun inward by eight centimetres without scaling its model.
 * Grip points and muzzle-bearing child roots move together. */
export function bringSkinnedDualWeaponsInward(
    scale: THREE.Vector3,
    rightWeapon: THREE.Object3D, leftWeapon: THREE.Object3D,
    rightGrip: THREE.Vector3, leftGrip: THREE.Vector3,
): void {
    for (const [weapon, grip] of [[rightWeapon, rightGrip], [leftWeapon, leftGrip]] as const) {
        const move = -Math.sign(weapon.position.x) * Math.min(0.08 / scale.x, Math.abs(weapon.position.x));
        weapon.position.x += move;
        grip.x += move;
    }
}

/** Wrist beside the grip, fingers pointing IN toward the bore (+Z forward).
 * Offsets use world metres in the weapon's rotation frame, matching ArmGripIK;
 * the weapon scale is applied here exactly once, never again by the solver. */
export function createSkinnedRangedGrip(
    target: THREE.Object3D,
    side: 'left' | 'right',
    point: THREE.Vector3,
    scale: THREE.Vector3,
    role: 'trigger' | 'support' = side === 'left' ? 'support' : 'trigger',
): ArmGrip {
    if (!fits.has(target)) {
        fits.set(target, { lastPosition: target.position.clone(), correction: new THREE.Vector3() });
    }
    const offset = point.clone().multiply(scale);
    const handRotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0,
        side === 'right' ? -Math.PI / 2 : Math.PI / 2));
    const palm = new THREE.Vector3(side === 'right' ? -0.09 : 0.09, 0, 0);
    if (role === 'support') {
        // Wrap the support palm diagonally forward around the foregrip. Rotate
        // the wrist offset AND hand together, retaining the 9 cm palm contact
        // distance. A square, sideways palm needlessly pulls the rifle back.
        const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0),
            side === 'right' ? -Math.PI / 4 : Math.PI / 4);
        palm.applyQuaternion(turn);
        palm.y = 0.02;
        handRotation.premultiply(turn);
    }
    offset.add(palm);
    return { target, offset, rotation: new THREE.Euler().setFromQuaternion(handRotation) };
}

const position = new THREE.Vector3();
const shoulder = new THREE.Vector3();
const elbow = new THREE.Vector3();
const wrist = new THREE.Vector3();
const offset = new THREE.Vector3();
const forward = new THREE.Vector3();
const desired = new THREE.Vector3();
const rotation = new THREE.Quaternion();

/** Seat a gun within every gripping arm's reach before either arm is posed.
 * Otherwise the support wrist clamps behind the foregrip, beside the trigger
 * hand, making the hands appear reversed. Slide only along the bore; retain the
 * authored height, lateral position, scale, aim, and spacing between the grips. */
export function fitRangedWeaponToArmReach(root: THREE.Object3D, grips: ReadonlyMap<'left' | 'right', ArmGrip>): void {
    const left = grips.get('left');
    const right = grips.get('right');
    if (left && right && left.target !== right.target) return;
    const target = right?.target ?? left?.target;
    if (!target) return;
    const fit = fits.get(target);
    if (!fit || !target.parent) return;

    // NPCs refresh from their final posed shoulder here; players already wrote
    // their placement. Legacy owners may leave it untouched between frames.
    // Undo only our previous correction when no fresh position was supplied.
    const updateHold = holdUpdaters.get(target);
    if (updateHold) updateHold();
    else if (target.position.distanceToSquared(fit.lastPosition) < 1e-12) target.position.sub(fit.correction);
    fit.correction.set(0, 0, 0);
    target.updateWorldMatrix(true, false);
    target.getWorldPosition(position);
    target.getWorldQuaternion(rotation);
    forward.set(0, 0, 1).applyQuaternion(rotation);

    let arms = armCache.get(root);
    if (!arms) {
        arms = { left: resolveArmBones(root, 'left'), right: resolveArmBones(root, 'right') };
        armCache.set(root, arms);
    }
    let lower = -Infinity;
    let upper = Infinity;
    for (const side of ['left', 'right'] as const) {
        const grip = grips.get(side);
        if (!grip) continue;
        const bones = arms[side];
        if (!bones) return;
        bones.upperArm.getWorldPosition(shoulder);
        bones.forearm.getWorldPosition(elbow);
        bones.hand.getWorldPosition(wrist);
        // Retain a little elbow bend without pulling a comfortable rifle hold
        // unnecessarily back toward the chest.
        const reach = shoulder.distanceTo(elbow) + elbow.distanceTo(wrist) - 0.01;
        offset.copy(grip.offset).applyQuaternion(rotation).add(position).sub(shoulder);
        const along = offset.dot(forward);
        const perpendicularSq = Math.max(0, offset.lengthSq() - along * along);
        if (reach <= 0) return;
        // If this arm cannot quite reach the bore line, use its closest point.
        // Returning to the unseated position would make a marginally short arm
        // cause the whole gun to jump forward out of both hands as aim changes.
        const span = Math.sqrt(Math.max(0, reach * reach - perpendicularSq));
        lower = Math.max(lower, -along - span);
        upper = Math.min(upper, -along + span);
    }
    // When a long/custom gun has no common interval, share the reach deficit
    // between the arms. The normal IK clamp still preserves both limb lengths.
    const slide = lower <= upper ? THREE.MathUtils.clamp(0, lower, upper) : (lower + upper) / 2;
    desired.copy(position).addScaledVector(forward, slide);
    target.parent.worldToLocal(desired);
    fit.correction.copy(desired).sub(target.position);
    target.position.copy(desired);
    fit.lastPosition.copy(target.position);
    target.updateWorldMatrix(true, false);
}
