import * as THREE from 'three';
import { RangedWeaponSystem } from 'engine/RangedWeaponSystem.js';
import { createRangedWeaponMesh } from 'engine/RangedWeaponRegistry.js';
import { resolveArmBones, solveArmGrip, type ArmGrip } from 'engine/loaders/ArmGripIK.js';
import { createSkinnedRangedGrip, fitRangedWeaponToArmReach } from 'engine/weapons/RangedWeaponGrip.js';
import type { PlayerLoader } from 'engine/loaders/PlayerLoader.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';

describe('skinned player rifle hold', () => {
    it.each(['laser_blaster', 'laser_blaster_lowpoly', 'assault_rifle', 'assault_rifle_lowpoly'])(
        '%s clears the face and keeps the trigger hand ahead of the shoulder', type => {
            const player = new THREE.Group();
            player.position.set(4, 0.5, -6); player.rotation.y = 1.2;
            for (const side of ['Left', 'Right']) {
                const sign = side === 'Left' ? 1 : -1;
                const shoulder = new THREE.Bone(); shoulder.name = `mixamorig${side}Arm`;
                shoulder.position.set(sign * 0.2, 1.05, 0.015);
                const forearm = new THREE.Bone(); forearm.name = `mixamorig${side}ForeArm`;
                forearm.position.x = sign * 0.23;
                const hand = new THREE.Bone(); hand.name = `mixamorig${side}Hand`;
                hand.position.x = sign * 0.28;
                player.add(shoulder); shoulder.add(forearm); forearm.add(hand);
            }
            const result = createRangedWeaponMesh(type);
            const gun = result.mesh, preset = result.preset;
            const scale = preset.weaponScale ?? new THREE.Vector3(3, 3, 1.5);
            player.add(gun); gun.scale.copy(scale);
            const grips = new Map<'left' | 'right', ArmGrip>([
                ['right', createSkinnedRangedGrip(gun, 'right', result.grip!, scale)],
                ['left', createSkinnedRangedGrip(gun, 'left', result.foregrip!, scale)],
            ]);
            // Exercise the authoritative per-frame placement against real bones,
            // independently of renderer, animation downloads, input and HUD setup.
            const system = Object.assign(Object.create(RangedWeaponSystem.prototype), {
                player, weaponMesh: gun, weaponPreset: preset, isDualWeapon: false,
                weaponBaseForwardOffset: preset.forwardOffset ?? 0.55, weaponHeightOffset: 0,
                playerLoader: { isRenderingSkinnedMesh: () => true, getSkinnedSkeletonRoot: () => player,
                    getCapsuleHeight: () => 1.75 },
                getCameraMode: () => 'third-person', calculateTargetPoint: () => null,
            }) as { updateWeaponHeight(): void };
            let settled: THREE.Vector3 | undefined;
            for (let frame = 0; frame < 60; frame++) {
                system.updateWeaponHeight();
                fitRangedWeaponToArmReach(player, grips);
                for (const [side, grip] of grips) {
                    const bones = resolveArmBones(player, side)!;
                    solveArmGrip(player, side, bones, grip);
                    const target = grip.offset.clone().applyQuaternion(gun.getWorldQuaternion(new THREE.Quaternion()))
                        .add(gun.getWorldPosition(new THREE.Vector3()));
                    expect(bones.hand.getWorldPosition(new THREE.Vector3()).distanceTo(target)).toBeLessThan(1e-5);
                }
                if (settled) expect(gun.position.distanceTo(settled)).toBeLessThan(1e-5);
                settled = gun.position.clone();
            }
            const right = player.worldToLocal(resolveArmBones(player, 'right')!.hand.getWorldPosition(new THREE.Vector3()));
            const left = player.worldToLocal(resolveArmBones(player, 'left')!.hand.getWorldPosition(new THREE.Vector3()));
            const muzzle = player.worldToLocal(gun.localToWorld(preset.muzzleOffset.clone()));
            expect(right.z).toBeGreaterThan(0.06);
            // The support wrist trails its palm on the compact, scaled foregrip.
            expect(left.z).toBeGreaterThan(right.z + 0.13);
            expect(muzzle.y).toBeLessThan(1.02);
            expect(right.x).toBeGreaterThan(-0.3);
        });
});

describe('single and dual equip uses the visible skinned rig', () => {
    const weapons = ['pistol', 'laser_pistol', 'dual_pistols', 'dual_assault_rifles',
        'dual_bazookas', 'bazooka', 'assault_rifle', 'laser_blaster'];

    it.each(weapons.flatMap(id => [id, `${id}_lowpoly`]))(
        '%s stays below the face, on its handles and stable through aiming and re-equip', id => {
            const player = new THREE.Group();
            player.position.set(4, 0.5, -6); player.rotation.y = 1.2;
            for (const side of ['Left', 'Right']) {
                const sign = side === 'Left' ? 1 : -1;
                const shoulder = new THREE.Bone(); shoulder.name = `mixamorig${side}Arm`;
                shoulder.position.set(sign * 0.2, 1.05, 0.015);
                const forearm = new THREE.Bone(); forearm.name = `mixamorig${side}ForeArm`;
                forearm.position.x = sign * 0.23;
                const hand = new THREE.Bone(); hand.name = `mixamorig${side}Hand`;
                hand.position.x = sign * 0.28;
                player.add(shoulder); shoulder.add(forearm); forearm.add(hand);
            }
            const grips = new Map<'left' | 'right', ArmGrip>();
            const loader = {
                isRenderingSkinnedMesh: () => true, isHeadlessPlayer: () => false,
                getBlockCharacterRenderer: () => null, getSkinnedSkeletonRoot: () => player,
                getCapsuleHeight: () => 1.75,
                setSkinnedArmGrip: (side: 'left' | 'right', target: THREE.Object3D, offset: THREE.Vector3, rotation: THREE.Euler) => {
                    grips.set(side, { target, offset, rotation });
                },
                clearSkinnedArmGrip: (side: 'left' | 'right') => { grips.delete(side); },
            } as unknown as PlayerLoader;
            const system = new RangedWeaponSystem(null, {} as PhysicsWorld);
            const state = system as unknown as {
                weaponMesh: THREE.Group; rightWeaponMesh: THREE.Group | null; leftWeaponMesh: THREE.Group | null;
                updateWeaponHeight(): void; calculateTargetPoint(): THREE.Vector3 | null;
            };
            const reference = createRangedWeaponMesh(id.replace('dual_', '').replace('pistols', 'pistol')
                .replace('assault_rifles', 'assault_rifle').replace('bazookas', 'bazooka'));
            const dual = id.startsWith('dual_');
            const twoHands = dual || reference.preset.hands === 2;
            let previousPlacement: THREE.Vector3 | undefined;
            try {
                for (let equip = 0; equip < 2; equip++) {
                    state.calculateTargetPoint = () => null;
                    system.equipWeapon(id, player, loader);
                    const gun = state.weaponMesh;
                    const atEquip = gun.position.clone();
                    state.updateWeaponHeight();
                    expect(gun.position.distanceTo(atEquip)).toBeLessThan(1e-8);
                    expect(grips.size).toBe(twoHands ? 2 : 1);
                    for (const pitch of [-0.2, 0, 0.2]) {
                        state.calculateTargetPoint = () => player.localToWorld(new THREE.Vector3(0, 1 + Math.tan(pitch) * 30, 30));
                        let settled: THREE.Vector3 | undefined;
                        for (let frame = 0; frame < 30; frame++) {
                            state.updateWeaponHeight();
                            fitRangedWeaponToArmReach(player, grips);
                            for (const [side, grip] of grips) {
                                const bones = resolveArmBones(player, side)!;
                                solveArmGrip(player, side, bones, grip);
                                const target = grip.offset.clone().applyQuaternion(gun.getWorldQuaternion(new THREE.Quaternion()))
                                    .add(gun.getWorldPosition(new THREE.Vector3()));
                                expect(bones.hand.getWorldPosition(new THREE.Vector3()).distanceTo(target)).toBeLessThan(1e-4);
                            }
                            if (settled) expect(gun.position.distanceTo(settled)).toBeLessThan(1e-5);
                            settled = gun.position.clone();
                        }
                        if (pitch !== 0) continue;
                        if (previousPlacement) expect(gun.position.distanceTo(previousPlacement)).toBeLessThan(1e-5);
                        previousPlacement = gun.position.clone();
                        const muzzle = player.worldToLocal((state.rightWeaponMesh ?? gun).localToWorld(reference.preset.muzzleOffset.clone()));
                        // Pistols/pairs sit below the rifle hold; the larger
                        // launcher tube also clears the shoulder/face band.
                        const lowHold = dual || !twoHands;
                        expect(muzzle.y).toBeLessThan(id.includes('bazooka') ? 0.94 : lowHold ? 0.82 : 0.98);
                        for (const side of twoHands ? ['right', 'left'] as const : ['right'] as const) {
                            const actual = resolveArmBones(player, side)!.hand.getWorldPosition(new THREE.Vector3());
                            const gripMesh = dual ? (side === 'right' ? state.leftWeaponMesh! : state.rightWeaponMesh!) : gun;
                            const handle = !dual && side === 'left' ? reference.foregrip! : reference.grip!;
                            const handleWorld = gripMesh.localToWorld(handle.clone());
                            // The wrist sits beside the physical handle, never in
                            // the receiver or 20 cm behind an unreachable target.
                            expect(actual.distanceTo(handleWorld)).toBeLessThan(0.095);
                        }
                        if (dual) {
                            expect(Math.abs(state.rightWeaponMesh!.position.x * gun.scale.x)).toBeLessThan(0.245);
                            expect(state.leftWeaponMesh!.position.x).toBeCloseTo(-state.rightWeaponMesh!.position.x, 8);
                        } else if (!twoHands) {
                            expect(muzzle.y).toBeLessThan(0.72);
                            expect(gun.position.x).toBeGreaterThan(-0.23);
                        } else {
                            const right = player.worldToLocal(resolveArmBones(player, 'right')!.hand.getWorldPosition(new THREE.Vector3()));
                            const left = player.worldToLocal(resolveArmBones(player, 'left')!.hand.getWorldPosition(new THREE.Vector3()));
                            expect(left.z).toBeGreaterThan(right.z + 0.13);
                            const rearHandle = gun.localToWorld(reference.grip!.clone());
                            const frontHandle = gun.localToWorld(reference.foregrip!.clone());
                            expect(frontHandle.distanceTo(rearHandle)).toBeGreaterThan(0.2);
                            // Assert the fitted result, not the nominal forward
                            // offset that arm reach can pull back again.
                            expect(gun.position.z).toBeGreaterThan(id.startsWith('assault_rifle') ? 0.35
                                : id.startsWith('bazooka') ? 0.2 : 0.27);
                        }
                    }
                    system.unequipWeapon();
                    expect(grips.size).toBe(0);
                    expect(gun.parent).toBeNull();
                }
            } finally { system.unequipWeapon(); }
        });
});
