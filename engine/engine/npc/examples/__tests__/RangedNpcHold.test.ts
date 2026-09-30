import * as THREE from 'three';
import { BlockCharacterRenderer, BLOCK_BODY_PART_NAMES } from 'engine/BlockCharacterRenderer.js';
import { CharacterLoader } from 'engine/loaders/CharacterLoader.js';
import type { ArmGrip } from 'engine/loaders/ArmGripIK.js';
import { createRangedWeaponMesh } from 'engine/RangedWeaponRegistry.js';
import { RangedNpcBehavior } from 'engine/npc/examples/EXAMPLE_RangedNpcBehavior.js';
import type { NpcRangedWeaponHold } from 'engine/npc/examples/NpcRangedWeaponHold.js';
import { NpcController } from 'engine/npc/core/NpcController.js';
import type { EngineLike } from 'types/game.js';

function fixture(skinned: boolean, scale: number) {
    const scene = new THREE.Scene();
    const character = new THREE.Group(); character.scale.setScalar(scale); scene.add(character);
    const rig = new THREE.Group(); rig.scale.setScalar(1 / scale); character.add(rig);
    for (const [name, y] of [['Hips', .6], ['Spine', .8], ['Neck', 1.15], ['Head', 1.3]] as const) {
        const bone = new THREE.Bone(); bone.name = `mixamorig${name}`; bone.position.y = y; rig.add(bone);
    }
    for (const side of ['Left', 'Right']) {
        const sign = side === 'Left' ? 1 : -1;
        const clavicle = new THREE.Bone(); clavicle.name = `mixamorig${side}Shoulder`;
        clavicle.position.set(sign * .15, 1.05, .015); rig.add(clavicle);
        const shoulder = new THREE.Bone(); shoulder.name = `mixamorig${side}Arm`;
        shoulder.position.set(sign * .2, 1.05, .015); rig.add(shoulder);
        const forearm = new THREE.Bone(); forearm.name = `mixamorig${side}ForeArm`;
        forearm.position.x = sign * .23; shoulder.add(forearm);
        const hand = new THREE.Bone(); hand.name = `mixamorig${side}Hand`;
        hand.position.x = sign * .28; forearm.add(hand);
        for (const [name, y] of [['UpLeg', .5], ['Leg', .15], ['Foot', -.2], ['ToeBase', -.25]] as const) {
            const bone = new THREE.Bone(); bone.name = `mixamorig${side}${name}`;
            bone.position.set(sign * .12, y, name === 'ToeBase' ? .1 : 0); rig.add(bone);
        }
    }
    rig.updateWorldMatrix(true, true);
    const rest: Array<[THREE.Object3D, THREE.Quaternion]> = [];
    rig.traverse(o => { if (o instanceof THREE.Bone) rest.push([o, o.quaternion.clone()]); });
    const loader = new CharacterLoader({ scene, physicsWorld: null } as unknown as EngineLike);
    loader.createBlockCharacter(rig, {
        getCharacterDimensions: () => ({ height: 1.75, width: .5, depth: .3 }),
        createBlockCharacter: root => {
            for (const name of BLOCK_BODY_PART_NAMES) {
                root.getObjectByName(name)!.add(new THREE.Mesh(new THREE.BoxGeometry(.1, .1, .1), new THREE.MeshBasicMaterial()));
            }
        },
    });
    loader.setCharacterGroup(character);
    if (skinned) loader.setSkinnedSkeletonRoot(rig);
    const controller = Object.assign(Object.create(NpcController.prototype), {
        character, characterLoader: loader, renderSkinned: skinned, animationController: null,
        weaponComp: { updateHold: () => {} }, isDead: () => false,
    }) as NpcController;
    const block = loader.getBlockCharacterRenderer()!;
    const pose = (frame: number) => {
        for (const [bone, q] of rest) bone.quaternion.copy(q);
        character.position.set(4 + Math.sin(frame * .05), .3, -6);
        character.rotation.y = .8 + frame * .02;
        rig.position.x = Math.sin(frame * .05) * .02 / scale;
        (controller as unknown as { poseCharacterInner(): void }).poseCharacterInner();
    };
    pose(0);
    return { character, loader, controller, block, pose };
}

function registeredGrips(loader: CharacterLoader, block: BlockCharacterRenderer, skinned: boolean): Map<'left' | 'right', ArmGrip> {
    if (skinned) return (loader as unknown as { skinnedArmGrips: Map<'left' | 'right', ArmGrip> }).skinnedArmGrips;
    const overrides = (block as unknown as { attachmentOverrides: Map<string, {
        target: THREE.Object3D; localPosition: THREE.Vector3; localRotation: THREE.Euler;
    }> }).attachmentOverrides;
    return new Map((['right', 'left'] as const).flatMap(side => {
        const g = overrides.get(`${side}ArmChain`);
        return g ? [[side, { target: g.target, offset: g.localPosition, rotation: g.localRotation }] as const] : [];
    }));
}

const weapons = ['pistol', 'laser_pistol', 'dual_pistols', 'assault_rifle', 'shotgun', 'laser_blaster', 'bazooka', 'dual_assault_rifles', 'dual_bazookas'];
const cases = [false, true].flatMap(skinned => [1, 1.063, 58].flatMap(scale =>
    weapons.flatMap(id => [id, `${id}_lowpoly`].map(id => ({ skinned, scale, id })))));

it.each(cases)('$id keeps each $skinned NPC hand on its grip through movement at root scale $scale', ({ skinned, scale, id }) => {
    const f = fixture(skinned, scale);
    const weaponScale = scale === 58 ? .8 : 1;
    const behavior = new RangedNpcBehavior({ weaponType: id, weaponScale });
    Object.assign(behavior, { npcController: f.controller });
    Object.assign(f.controller, { behavior });
    (behavior as unknown as { equipWeapon(npc: NpcController): void }).equipWeapon(f.controller);
    const { weaponMesh: gun, weaponHold } = behavior as unknown as { weaponMesh: THREE.Group; weaponHold: NpcRangedWeaponHold };
    const reference = createRangedWeaponMesh(id);
    try {
        for (let frame = 0; frame < 30; frame++) {
            f.pose(frame);
            const grips = registeredGrips(f.loader, f.block, skinned);
            expect(grips.size).toBe(reference.isDual || reference.preset.hands === 2 ? 2 : 1);
            expect(gun.getWorldScale(new THREE.Vector3()).distanceTo(reference.preset.weaponScale!.clone().multiplyScalar(weaponScale))).toBeLessThan(1e-6);
            for (const [side, grip] of grips) {
                const hand = f.controller.getBodyPartObject(`${side}Hand`)!;
                const target = grip.offset.clone().applyQuaternion(gun.getWorldQuaternion(new THREE.Quaternion()))
                    .add(gun.getWorldPosition(new THREE.Vector3()));
                expect(hand.getWorldPosition(new THREE.Vector3()).distanceTo(target)).toBeLessThan(1e-5);
                if (reference.isDual) {
                    const local = f.character.worldToLocal(target).multiply(f.character.scale);
                    expect(local.x * (side === 'right' ? -1 : 1)).toBeGreaterThan(.1);
                }
            }
        }
        const before = gun.getWorldPosition(new THREE.Vector3());
        for (let repeat = 0; repeat < 10; repeat++) f.pose(29);
        expect(gun.getWorldPosition(new THREE.Vector3()).distanceTo(before)).toBeLessThan(1e-6);
        const guns = reference.isDual ? gun.children.filter(child => child instanceof THREE.Group) : [gun];
        expect(guns).toHaveLength(reference.isDual ? 2 : 1);
        const muzzlePositions = guns.map(mesh => mesh.localToWorld(reference.preset.muzzleOffset.clone()));
        const firstMuzzle = weaponHold.getNextMuzzlePosition(new THREE.Vector3());
        const secondMuzzle = weaponHold.getNextMuzzlePosition(new THREE.Vector3());
        for (const muzzle of [firstMuzzle, secondMuzzle]) {
            expect(Math.min(...muzzlePositions.map(position => position.distanceTo(muzzle)))).toBeLessThan(1e-6);
        }
        if (reference.isDual) expect(firstMuzzle.distanceTo(secondMuzzle)).toBeGreaterThan(.2);
        const transforms = guns.map(mesh => mesh.matrixWorld.clone());
        behavior.onNpcDeath();
        expect(registeredGrips(f.loader, f.block, skinned).size).toBe(0);
        for (const [index, held] of guns.entries()) {
            held.updateWorldMatrix(true, false);
            expect(Math.max(...held.matrixWorld.elements.map((value, i) => Math.abs(value - transforms[index]!.elements[i]!)))).toBeLessThan(1e-6);
            const localX = f.character.worldToLocal(held.getWorldPosition(new THREE.Vector3())).x;
            const side = reference.isDual && localX > 0 ? 'left' : 'right';
            expect(held.parent).toBe(f.controller.getBodyPartObject(`${side}Hand`));
        }
    } finally {
        behavior.dispose(); f.block.dispose();
    }
});
