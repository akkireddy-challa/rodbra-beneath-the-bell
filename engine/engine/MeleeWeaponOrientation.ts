import * as THREE from 'three';

/**
 * Shared melee-weapon angle treatment — used by the player (WeaponMeleeSystem), melee
 * NPCs (NpcWeaponComponent) and the frozen MeleeNpcBehavior example, so every character
 * in the world holds its sword identically by construction.
 *
 * A sword rigidly parented to a hand inherits that hand's local frame, and a fixed local
 * rotation in that frame reads tilted/sideways — in an arms-down rest pose the blade axis
 * faces the character's LEFT and the sword lies across the body. `orientBladeYawFramed`
 * instead world-targets the blade in the CHARACTER's yaw frame and converts back to a
 * local quaternion via the hand's inverse world rotation.
 *
 * **This applies to block (voxel) characters as much as to skinned ones.** A block
 * character's hand looks like a clean procedural group, but BlockCharacterRenderer copies
 * its rotation straight off `mixamorigRightHand`, so it carries exactly the same messy
 * bone frame. Only the POSITION helper below is skinned-specific.
 *
 * Convention: the weapon mesh's natural blade axis is +Y (after any attach-time
 * default rotation), matching the engine's built-in sword/NPC sword meshes.
 */

/** Idle/ready: blade (+Y) points forward with a slight upward tilt (75° about char-X). */
export const BLADE_IDLE_FORWARD = new THREE.Quaternion()
    .setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI * (75 / 180));

/** Downward chop bias applied during an arm-aligned swing (negative tips up, ~30°). */
export const BLADE_SWING_TILT_RAD = -Math.PI / 6;

const _UP = new THREE.Vector3(0, 1, 0);
const _charQ = new THREE.Quaternion();
const _yaw = new THREE.Quaternion();
const _desired = new THREE.Quaternion();
const _parentQ = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _handPos = new THREE.Vector3();
const _forearmPos = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _tilt = new THREE.Quaternion();
const _worldQ = new THREE.Quaternion();
const _blade = new THREE.Vector3();
const _edge = new THREE.Vector3();
const _travel = new THREE.Vector3();
const _cross = new THREE.Vector3();
const _roll = new THREE.Quaternion();
const _target = new THREE.Quaternion();

/**
 * The weapon mesh's own local axes, as `WeaponRegistry` builds them.
 *
 * `createSword` lays the blade along +Y and gives it `BoxGeometry(0.04, 1, 0.08)`
 * — thin in X, wide in Z. A blade's width spans edge to edge, so the sharp sides
 * face ±Z and the flats face ±X. The crossguard, `Box(0.04, 0.04, 0.3)`, extends
 * along Z too: face-on you see the full blade width and the full guard together.
 */
const WEAPON_BLADE_AXIS = new THREE.Vector3(0, 1, 0);
const WEAPON_EDGE_AXIS = new THREE.Vector3(0, 0, 1);

/** Yaw-only quaternion (drop pitch/roll) so blade targeting ignores body lean. */
export function extractYawOnly(q: THREE.Quaternion, out: THREE.Quaternion): THREE.Quaternion {
    _euler.setFromQuaternion(q, 'YXZ');
    return out.setFromEuler(_euler.set(0, _euler.y, 0, 'YXZ'));
}

/**
 * Point the weapon's blade (+Y) in the character's yaw frame, offset by `offset`
 * (e.g. BLADE_IDLE_FORWARD). Writes weaponMesh.quaternion (local to its hand
 * parent). No-op if the weapon has no parent.
 */
export function orientBladeYawFramed(
    weaponMesh: THREE.Object3D,
    characterObj: THREE.Object3D,
    offset: THREE.Quaternion,
): void {
    const parent = weaponMesh.parent;
    if (!parent) return;
    characterObj.getWorldQuaternion(_charQ);
    const yaw = extractYawOnly(_charQ, _yaw);
    _desired.copy(yaw).multiply(offset);
    parent.getWorldQuaternion(_parentQ);
    weaponMesh.quaternion.copy(_parentQ.invert()).multiply(_desired);
}

const _fingerDir = new THREE.Vector3();
const _gripPoint = new THREE.Vector3();

/**
 * Seat the weapon's grip out toward the fingers: place the weapon `dist` metres
 * past the hand-bone origin along the live forearm→hand world direction (which by
 * construction points wrist→fingers, whatever the rig's bone axes are). Writes
 * weaponMesh.position in hand-local space, so it composes with the orientation
 * helpers (which only write rotation). Call each frame after orienting. Returns
 * false when the forearm bone is missing or the arm is zero-length — the caller
 * can leave the attach-time position as-is.
 *
 * SKINNED characters only: a Mixamo hand bone's origin is the wrist, so a weapon left
 * there floats off the wrist and rides up the long forearm. A block character's hand
 * group is short and already sits at the fist.
 */
export function seatGripTowardFingers(weaponMesh: THREE.Object3D, dist: number): boolean {
    const hand = weaponMesh.parent;
    const forearm = hand?.parent;
    if (!hand || !forearm) return false;
    const handPos = hand.getWorldPosition(_handPos);
    const forearmPos = forearm.getWorldPosition(_forearmPos);
    const dir = _fingerDir.copy(handPos).sub(forearmPos);
    if (dir.lengthSq() < 1e-8) return false;
    dir.normalize();
    _gripPoint.copy(handPos).addScaledVector(dir, dist);
    weaponMesh.position.copy(hand.worldToLocal(_gripPoint));
    return true;
}

/**
 * Align the blade (+Y) along the forearm→hand line (so it leads the strike like a
 * real swing) plus a downward chop bias about the character's yaw-aligned right
 * axis. Assumes weaponMesh.parent is the hand bone and its parent is the forearm
 * (the Mixamo arrangement). Returns false — caller should fall back — when the
 * forearm bone is missing or the arm is zero-length.
 */
export function alignBladeToArm(
    weaponMesh: THREE.Object3D,
    characterObj: THREE.Object3D,
    tiltRad: number = BLADE_SWING_TILT_RAD,
): boolean {
    const hand = weaponMesh.parent;
    const forearm = hand?.parent;
    if (!hand || !forearm) return false;

    const handPos = hand.getWorldPosition(_handPos);
    const forearmPos = forearm.getWorldPosition(_forearmPos);
    const dir = _dir.copy(handPos).sub(forearmPos);
    if (dir.lengthSq() < 1e-8) return false;
    dir.normalize();

    // World rotation that points the blade (+Y) down the arm line.
    const desiredWorld = _desired.setFromUnitVectors(_UP, dir);

    // Downward chop bias about the character's yaw-aligned right axis.
    characterObj.getWorldQuaternion(_charQ);
    const yaw = extractYawOnly(_charQ, _yaw);
    const axis = _axis.set(1, 0, 0).applyQuaternion(yaw);
    desiredWorld.premultiply(_tilt.setFromAxisAngle(axis, tiltRad));

    hand.getWorldQuaternion(_parentQ);
    weaponMesh.quaternion.copy(_parentQ.invert()).multiply(desiredWorld);
    return true;
}

/**
 * Roll the blade about its own long axis so the cutting EDGE leads the swing.
 *
 * `alignBladeToArm` decides where the blade POINTS and nothing else: its
 * `setFromUnitVectors` is a shortest-arc rotation, which by construction adds no
 * twist — so it never *sets* the roll either, and the edge ends up wherever the
 * arm's orientation happens to leave it. The blade then sweeps a perfectly good
 * arc and lands flat, which is the "hitting with the side of the sword" that a
 * correct animation cannot fix, because this runs after the animation.
 *
 * Call once per frame after aiming, passing how far the tip moved since the last
 * frame. Motion ALONG the blade is dropped first — a thrust is not a cut and must
 * not drive the roll. The ±edge fold keeps the correction under 90°, since a
 * double-edged blade is symmetric and either edge leading is equally correct.
 *
 * No-ops when the weapon is barely moving: a stationary blade has no direction of
 * travel, and chasing the noise there makes the sword twitch in the grip.
 */
export function rollEdgeToLead(
    weaponMesh: THREE.Object3D,
    tipTravelWorld: THREE.Vector3,
    minTravel: number = 1e-3,
): boolean {
    const parent = weaponMesh.parent;
    if (!parent) return false;
    if (tipTravelWorld.lengthSq() < minTravel * minTravel) return false;

    weaponMesh.getWorldQuaternion(_worldQ);
    _blade.copy(WEAPON_BLADE_AXIS).applyQuaternion(_worldQ).normalize();

    _travel.copy(tipTravelWorld);
    _travel.addScaledVector(_blade, -_travel.dot(_blade));
    if (_travel.lengthSq() < 1e-10) return false;
    _travel.normalize();

    _edge.copy(WEAPON_EDGE_AXIS).applyQuaternion(_worldQ).normalize();
    _edge.addScaledVector(_blade, -_edge.dot(_blade));
    if (_edge.lengthSq() < 1e-10) return false;
    _edge.normalize();

    let angle = Math.atan2(_cross.copy(_edge).cross(_travel).dot(_blade), _edge.dot(_travel));
    if (angle > Math.PI / 2) angle -= Math.PI;
    if (angle < -Math.PI / 2) angle += Math.PI;

    _roll.setFromAxisAngle(_blade, angle);
    _target.copy(_worldQ).premultiply(_roll);

    parent.getWorldQuaternion(_parentQ);
    weaponMesh.quaternion.copy(_parentQ.invert()).multiply(_target);
    return true;
}
