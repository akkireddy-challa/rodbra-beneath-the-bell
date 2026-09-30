import * as THREE from 'three';
import { createRangedWeaponMesh } from 'engine/RangedWeaponRegistry.js';
import { resolveArmBones, solveArmGrip, type ArmGrip } from 'engine/loaders/ArmGripIK.js';
import { createSkinnedRangedGrip, fitRangedWeaponToArmReach } from 'engine/weapons/RangedWeaponGrip.js';

/** Short arms measured from the faceted rifleman in the localhost reference. */
function rig(rootScale: number, yaw: number) {
    const root = new THREE.Group();
    root.scale.setScalar(rootScale);
    root.position.set(3, 0.5, -7);
    root.rotation.y = yaw;
    for (const side of ['Left', 'Right']) {
        const sign = side === 'Left' ? 1 : -1;
        const arm = new THREE.Bone(); arm.name = `mixamorig${side}Arm`;
        arm.position.set(sign * 0.2 / rootScale, 1.05 / rootScale, 0);
        const forearm = new THREE.Bone(); forearm.name = `mixamorig${side}ForeArm`;
        forearm.position.x = sign * 0.22 / rootScale;
        const hand = new THREE.Bone(); hand.name = `mixamorig${side}Hand`;
        hand.position.x = sign * 0.26 / rootScale;
        arm.add(forearm); forearm.add(hand); root.add(arm);
    }
    root.updateMatrixWorld(true);
    return root;
}

describe('ranged grip seating', () => {
    it.each(['left', 'right'] as const)('keeps the %s support palm on its handle when angled forward', side => {
        const gun = new THREE.Group();
        const handle = new THREE.Vector3(0, -0.02, 0.07);
        const scale = new THREE.Vector3(3, 3, 1.5);
        const grip = createSkinnedRangedGrip(gun, side, handle, scale, 'support');
        const wristToHandle = handle.clone().multiply(scale).sub(grip.offset);
        // Local +Y runs from wrist toward fingers. The hand must rotate with
        // its wrist offset, otherwise moving the wrist just misses the handle.
        const fingers = new THREE.Vector3(0, 1, 0).applyEuler(grip.rotation);
        wristToHandle.y = 0;
        expect(wristToHandle.length()).toBeCloseTo(0.09, 8);
        expect(fingers.dot(wristToHandle.normalize())).toBeCloseTo(1, 8);
        expect(fingers.z).toBeGreaterThan(0.7);
        const trigger = createSkinnedRangedGrip(gun, side, handle, scale, 'trigger');
        expect(trigger.offset.z).toBeCloseTo(handle.z * scale.z, 8);
    });

    it.each(['assault_rifle', 'shotgun', 'crossbow', 'bazooka', 'laser_blaster', 'pistol', 'laser_pistol'])(
        '%s exposes the same authored rear grip in both styles', id => {
            const block = createRangedWeaponMesh(id);
            const lowpoly = createRangedWeaponMesh(`${id}_lowpoly`);
            expect(block.grip).toBeDefined();
            expect(lowpoly.grip!.distanceTo(block.grip!)).toBe(0);
            expect(block.grip!.y).toBeLessThan(block.preset.muzzleOffset.y);
            if (block.foregrip) expect(block.grip!.z).toBeLessThan(block.foregrip.z);
        });

    it.each([1, 1.063, 58].flatMap(scale => [0, Math.PI / 2, -2.4].flatMap(yaw =>
        ['assault_rifle', 'assault_rifle_lowpoly'].map(type => ({ scale, yaw, type })))))(
        'both wrists reach in correct order: $type, root scale $scale, yaw $yaw', ({ scale, yaw, type }) => {
            const root = rig(scale, yaw);
            const result = createRangedWeaponMesh(type);
            const gun = result.mesh;
            const gunScale = new THREE.Vector3(3, 3, 1.5);
            root.add(gun);
            gun.scale.copy(gunScale).divideScalar(scale);
            gun.position.set(-0.1 / scale, 0.84 / scale, 0.55 / scale);
            const grips = new Map<'left' | 'right', ArmGrip>([
                ['right', createSkinnedRangedGrip(gun, 'right', result.grip!, gunScale)],
                ['left', createSkinnedRangedGrip(gun, 'left', result.foregrip!, gunScale)],
            ]);
            root.updateMatrixWorld(true);
            const before = gun.position.clone();
            fitRangedWeaponToArmReach(root, grips);
            expect(gun.position.z).toBeLessThan(before.z);
            expect(gun.position.x).toBeCloseTo(before.x, 8);
            expect(gun.position.y).toBeCloseTo(before.y, 8);
            for (const [side, grip] of grips) {
                const bones = resolveArmBones(root, side)!;
                solveArmGrip(root, side, bones, grip);
                const target = grip.offset.clone().applyQuaternion(gun.getWorldQuaternion(new THREE.Quaternion()))
                    .add(gun.getWorldPosition(new THREE.Vector3()));
                expect(bones.hand.getWorldPosition(new THREE.Vector3()).distanceTo(target)).toBeLessThan(1e-5);
            }
            const localHand = (side: 'left' | 'right') => gun.worldToLocal(
                resolveArmBones(root, side)!.hand.getWorldPosition(new THREE.Vector3()));
            // Wrist spacing is shorter than palm/handle spacing because the
            // support hand wraps forward. Compare in world metres.
            expect((localHand('left').z - localHand('right').z) * gunScale.z).toBeGreaterThan(0.18);
            expect(localHand('left').x).toBeGreaterThan(0);
            expect(localHand('right').x).toBeLessThan(0);
            const seated = gun.position.clone();
            for (let i = 0; i < 60; i++) fitRangedWeaponToArmReach(root, grips);
            expect(gun.position.distanceTo(seated) * scale).toBeLessThan(1e-6);
            // Player placement is re-authored each frame; that must not accumulate
            // the NPC's previous correction or change the fitted result.
            gun.position.copy(before);
            fitRangedWeaponToArmReach(root, grips);
            expect(gun.position.distanceTo(seated) * scale).toBeLessThan(1e-6);
        });

    it('leaves unregistered custom targets in place but seats an opted-in one-handed gun', () => {
        const root = rig(1, 0);
        const target = new THREE.Group(); root.add(target); target.position.set(-0.2, 1, 2);
        const grip: ArmGrip = { target, offset: new THREE.Vector3(), rotation: new THREE.Euler() };
        fitRangedWeaponToArmReach(root, new Map([['left', grip], ['right', grip]]));
        expect(target.position.z).toBe(2);
        const right = createSkinnedRangedGrip(target, 'right', new THREE.Vector3(), new THREE.Vector3(1, 1, 1));
        fitRangedWeaponToArmReach(root, new Map([['right', right]]));
        expect(target.position.z).toBeLessThan(0.5);
        const bones = resolveArmBones(root, 'right')!;
        solveArmGrip(root, 'right', bones, right);
        const wristTarget = target.getWorldPosition(new THREE.Vector3()).add(right.offset);
        expect(bones.hand.getWorldPosition(new THREE.Vector3()).distanceTo(wristTarget)).toBeLessThan(1e-5);
    });

    it('keeps seating at the closest bore point when the elbow margin cannot fit', () => {
        const root = rig(1, 0);
        const gun = new THREE.Group(); root.add(gun); gun.position.set(-0.2, 0.585, 0.8);
        const right = createSkinnedRangedGrip(gun, 'right', new THREE.Vector3(), new THREE.Vector3(1, 1, 1));
        const grips = new Map([['right' as const, right]]);
        fitRangedWeaponToArmReach(root, grips);
        // The line is inside the arm's full length but outside its preferred
        // elbow-bend margin. It must not revert to the distant authored origin.
        expect(gun.position.z).toBeCloseTo(0, 8);
        const seated = gun.position.clone();
        for (let frame = 0; frame < 60; frame++) fitRangedWeaponToArmReach(root, grips);
        expect(gun.position.distanceTo(seated)).toBeLessThan(1e-6);
        const bones = resolveArmBones(root, 'right')!;
        solveArmGrip(root, 'right', bones, right);
        const target = gun.getWorldPosition(new THREE.Vector3()).add(right.offset);
        expect(bones.hand.getWorldPosition(new THREE.Vector3()).distanceTo(target)).toBeLessThan(1e-5);
    });
});
