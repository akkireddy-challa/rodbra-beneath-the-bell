import * as THREE from 'three';
import { MeleeNpcBehavior } from 'engine/npc/examples/EXAMPLE_MeleeNpcBehavior.js';
import { NpcController } from 'engine/npc/core/NpcController.js';
import { createWeaponMesh } from 'engine/WeaponRegistry.js';
import type { ICharacterContext } from 'engine/character/ICharacterContext.js';

function fixture(type: string, yaw: number) {
    const character = new THREE.Group();
    character.position.set(3, 0.5, -4);
    character.rotation.y = yaw;
    const hand = new THREE.Group();
    hand.position.set(-0.3, 0.9, 0.12);
    character.add(hand);
    const behavior = new MeleeNpcBehavior({ createWeaponMesh: () => createWeaponMesh(type).mesh });
    const context = {
        getCharacter: () => character, getPosition: () => character.position,
        getAnimationController: () => null, isRenderingSkinnedMesh: () => false,
        attachToBodyPart: (mesh: THREE.Object3D) => {
            hand.add(mesh); mesh.rotation.x = Math.PI / 2; return true;
        },
        detachFromBodyPart: (mesh: THREE.Object3D) => { mesh.removeFromParent(); },
    } as unknown as ICharacterContext;
    behavior.initialize(context);
    const weapon = hand.children[0]!;
    const attachedPosition = weapon.position.clone();
    let wristPose = new THREE.Euler(0.4, -0.7, 1.2);
    // The actual controller pose entry point must call the behavior AFTER the
    // block renderer writes its live hand frame, even without another AI tick.
    const controller = Object.assign(Object.create(NpcController.prototype), {
        character, behavior, renderSkinned: false,
        characterLoader: { updateBlockCharacter: () => { hand.rotation.copy(wristPose); character.updateMatrixWorld(true); } },
        weaponComp: { updateHold: () => undefined }, animationController: null,
    }) as { poseCharacterInner(): void };
    return {
        behavior, weapon, hand, attachedPosition,
        pose: (rotation: THREE.Euler) => { wristPose = rotation; controller.poseCharacterInner(); },
        direction: () => new THREE.Vector3(0, 1, 0).applyQuaternion(weapon.getWorldQuaternion(new THREE.Quaternion()))
            .applyQuaternion(character.getWorldQuaternion(new THREE.Quaternion()).invert()),
    };
}

describe('block NPC example melee hold after posing', () => {
    it.each(['sword', 'sword_lowpoly', 'axe', 'axe_lowpoly', 'spear', 'spear_lowpoly'].flatMap(type =>
        [0, 1.2, Math.PI].map(yaw => ({ type, yaw }))))(
        '$type follows facing at yaw $yaw through changing wrist poses', ({ type, yaw }) => {
            const f = fixture(type, yaw);
            try {
                for (const rotation of [new THREE.Euler(0.4, -0.7, 1.2), new THREE.Euler(-1, 0.5, -2), new THREE.Euler(0, 0, Math.PI / 2)]) {
                    f.pose(rotation);
                    const direction = f.direction();
                    expect(Math.abs(direction.x)).toBeLessThan(1e-6);
                    expect(direction.z).toBeGreaterThan(0.95);
                    expect(direction.y).toBeGreaterThan(0.2);
                    expect(f.weapon.position.distanceTo(f.attachedPosition)).toBeLessThan(1e-8);
                    expect(f.weapon.parent).toBe(f.hand);
                }
            } finally { f.behavior.dispose(); }
        });

    it('raises, chops forward/down and recovers without a sideways arc or a stale wrist rotation', () => {
        const f = fixture('sword_lowpoly', 1.2);
        const clock = jest.spyOn(performance, 'now').mockReturnValue(1000);
        const state = f.behavior as unknown as { startSwing(): void };
        try {
            f.pose(new THREE.Euler(0.4, -0.7, 1.2));
            state.startSwing();
            for (const [elapsed, expected] of [[80, 'raised'], [280, 'chop'], [400, 'ready']] as const) {
                clock.mockReturnValue(1000 + elapsed);
                f.pose(new THREE.Euler(elapsed / 500, -0.8, elapsed / 100));
                const direction = f.direction();
                expect(Math.abs(direction.x)).toBeLessThan(1e-6);
                if (expected === 'raised') expect(direction.y).toBeGreaterThan(0.85);
                else if (expected === 'chop') {
                    expect(direction.z).toBeGreaterThan(0.6);
                    expect(direction.y).toBeLessThan(-0.7);
                } else {
                    expect(direction.z).toBeGreaterThan(0.95);
                    expect(direction.y).toBeGreaterThan(0.2);
                }
            }
        } finally { clock.mockRestore(); f.behavior.dispose(); }
    });
});
