import * as THREE from 'three';
import { RangedWeaponSystem } from 'engine/RangedWeaponSystem.js';

/**
 * A held gun must never swivel independently of the body holding it.
 *
 * In cursor (top-down) mode the body legitimately faces somewhere other than
 * the aim point — while running one way and shooting another — and writing the
 * raw aim yaw onto the weapon mesh made the pistol spin at the wrist. The mesh
 * is parented to the player, not the hand bone, so nothing else bounded it.
 *
 * The weapon now turns by the spine share of the torso twist, which is exactly
 * what the hand turns by (the arm hangs off the spine). These tests pin the
 * bound and the mode split; aim accuracy is separate (the projectile direction
 * converges muzzle→aimPoint inside ShootableComponent.shoot).
 */

type Privates = {
    weaponMesh: THREE.Object3D | null;
    player: THREE.Object3D | null;
    playerLoader: unknown;
    weaponPreset: { xOffset?: number; heightOffset?: number; hands?: number } | null;
    effectiveAimMode: 'camera' | 'cursor';
    torsoTwist: number;
    weaponHeightOffset: number;
    weaponBaseForwardOffset: number;
    weaponBaselineHeight: number;
    calculateTargetPoint(): THREE.Vector3 | null;
    getCameraMode(): string;
    getBodyPartObject(root: THREE.Object3D, part: string): THREE.Object3D | null;
    updateWeaponHeight(): void;
};

/**
 * A stand-in system with only what updateWeaponHeight touches: a player at the
 * origin facing +Z, a weapon mesh, and a target 5 m to the character's LEFT —
 * a 90° aim-vs-body split, the case that used to spin the wrist.
 */
function harness(mode: 'camera' | 'cursor', torsoTwist: number): Privates {
    const player = new THREE.Object3D();
    const shoulder = new THREE.Object3D();
    shoulder.position.set(0.2, 1.4, 0);
    player.add(shoulder);
    const weaponMesh = new THREE.Object3D();
    player.add(weaponMesh);

    const self = Object.create(RangedWeaponSystem.prototype) as Privates;
    Object.assign(self, {
        player,
        weaponMesh,
        playerLoader: null,
        weaponPreset: null,
        effectiveAimMode: mode,
        torsoTwist,
        weaponHeightOffset: 0,
        weaponBaseForwardOffset: 0,
        weaponBaselineHeight: 0,
        calculateTargetPoint: () => new THREE.Vector3(5, 1.4, 0),
        getCameraMode: () => 'third-person',
        getBodyPartObject: () => shoulder,
    });
    return self;
}

describe('cursor-mode weapon yaw', () => {
    it('does not swivel the gun at the wrist when the body faces elsewhere', () => {
        const self = harness('cursor', 0);
        self.updateWeaponHeight();
        // Aim is 90° off the body, but with no torso twist the gun stays put.
        expect(Math.abs(self.weaponMesh!.rotation.y)).toBeLessThan(1e-6);
    });

    it('turns the gun by exactly the spine share of the torso twist', () => {
        const twist = 0.8;
        const self = harness('cursor', twist);
        self.updateWeaponHeight();
        expect(self.weaponMesh!.rotation.y).toBeCloseTo(twist * 0.55, 5);
    });

    it('leaves camera-aim modes on the full aim yaw', () => {
        const self = harness('camera', 0);
        self.updateWeaponHeight();
        // Target is at local +X, i.e. atan2(5, 0) = 90°.
        expect(self.weaponMesh!.rotation.y).toBeCloseTo(Math.PI / 2, 5);
    });
});
