import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { RangedNpcBehavior } from 'engine/npc/examples/EXAMPLE_RangedNpcBehavior.js';
import { createRangedWeaponMesh } from 'engine/RangedWeaponRegistry.js';
import { RagdollComponent, DEFAULT_RAGDOLL_CONFIG } from 'engine/character/RagdollComponent.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import type { NpcController } from 'engine/npc/core/NpcController.js';
import type { EngineLike } from 'types/game.js';

function armedNpc(hand: THREE.Object3D | null, weaponMesh: THREE.Group) {
    const clearSkinnedArmGrip = jest.fn();
    const clearArmAttachmentOverride = jest.fn();
    const behavior = new RangedNpcBehavior();
    const state = { weaponMesh, weaponEquipped: true, npcController: {
        getBodyPartObject: () => hand,
        clearSkinnedArmGrip,
        getBlockCharacterRenderer: () => ({ clearArmAttachmentOverride }),
    } };
    Object.assign(behavior, state);
    return { behavior, clearSkinnedArmGrip, clearArmAttachmentOverride };
}

describe('ranged NPC weapon death transfer', () => {
    beforeAll(async () => { await RAPIER.init(); });

    it.each([1, 1.063, 58].flatMap(scale => ['block', 'skinned'].map(render => ({ scale, render }))))(
        '$render corpse carries the gun through a fall and cleanup at root scale $scale', ({ scale, render }) => {
            const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
            const bodies: RAPIER.RigidBody[] = [];
            const physics = {
                createRigidBody: (desc: RAPIER.RigidBodyDesc) => {
                    const body = world.createRigidBody(desc); bodies.push(body); return body;
                },
                createCollider: (desc: RAPIER.ColliderDesc, body: RAPIER.RigidBody) => world.createCollider(desc, body),
                removeRigidBody: (body: RAPIER.RigidBody) => world.removeRigidBody(body),
                setUserData: (body: RAPIER.RigidBody, data: unknown) => { body.userData = data; },
            } as unknown as PhysicsWorld;
            const scene = new THREE.Scene();
            const character = new THREE.Group();
            character.position.set(3, 2, -4); character.rotation.y = 1.2; character.scale.setScalar(scale);
            scene.add(character);
            const hand = new THREE.Group();
            hand.position.set(-0.2 / scale, 1 / scale, 0.2 / scale);
            hand.rotation.set(-0.6, 0.2, 0.8); character.add(hand);
            const handMesh = new THREE.Mesh(new THREE.BoxGeometry(0.1 / scale, 0.15 / scale, 0.1 / scale));
            hand.add(handMesh);
            const { mesh: gun } = createRangedWeaponMesh('assault_rifle_lowpoly');
            character.add(gun); gun.position.set(-0.1 / scale, 0.9 / scale, 0.3 / scale);
            gun.scale.set(3 / scale, 3 / scale, 1.5 / scale);
            gun.updateWorldMatrix(true, true);
            const before = gun.matrixWorld.clone();
            const gunMeshCount = gun.children.length;
            const { behavior, clearSkinnedArmGrip, clearArmAttachmentOverride } = armedNpc(hand, gun);
            const ragdoll = new RagdollComponent({ ...DEFAULT_RAGDOLL_CONFIG, corpseLifetimeMs: 1000 }, {
                getEngine: () => ({ scene }) as unknown as EngineLike,
                getPhysicsWorld: () => physics,
                getCharacter: () => character,
                getPhysicsBody: () => null,
                restoreFlashImmediately: () => {},
                collectParts: () => [{ name: 'rightLowerArm', parent: null, nodes: [hand] }],
                getSkinnedRig: () => render === 'skinned' ? { root: character, resolveBone: () => hand } : null,
                onPostRagdoll: () => { if (render === 'block') character.removeFromParent(); },
            });
            try {
                behavior.onNpcDeath();
                gun.updateWorldMatrix(true, true);
                expect(gun.parent).toBe(hand);
                expect(Math.max(...gun.matrixWorld.elements.map((v, i) => Math.abs(v - before.elements[i]!))))
                    .toBeLessThan(1e-6);
                expect(clearSkinnedArmGrip.mock.calls).toEqual([['right'], ['left']]);
                expect(clearArmAttachmentOverride.mock.calls).toEqual([['right'], ['left']]);
                expect(ragdoll.ragdoll()).toBe(true);
                const visual = render === 'skinned' ? gun : scene.children[0]!;
                if (render === 'block') expect(visual.children).toHaveLength(gunMeshCount + 1);
                const initial = visual.getWorldPosition(new THREE.Vector3());
                const rotation = visual.getWorldQuaternion(new THREE.Quaternion());
                bodies[0]!.setAngvel({ x: 1, y: 0, z: 0.5 }, true);
                for (let frame = 0; frame < 45; frame++) { world.step(); ragdoll.syncRagdoll(); }
                expect(visual.getWorldPosition(new THREE.Vector3()).y).toBeLessThan(initial.y - 0.3);
                expect(visual.getWorldQuaternion(new THREE.Quaternion()).angleTo(rotation)).toBeGreaterThan(0.1);
                const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000);
                try { ragdoll.syncRagdoll(); } finally { clock.mockRestore(); }
                expect(ragdoll.hasRagdoll()).toBe(false);
                expect(scene.children).toHaveLength(0);
                expect(world.bodies.len()).toBe(0);
            } finally {
                ragdoll.dispose(physics); world.free();
                gun.traverse(object => {
                    if (!(object instanceof THREE.Mesh)) return;
                    object.geometry.dispose();
                    for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.dispose();
                });
                handMesh.geometry.dispose();
            }
        });

    it('does not create a late weapon after an NPC dies during character loading', () => {
        const behavior = new RangedNpcBehavior();
        const controller = { isDead: () => true, isRenderingSkinnedMesh: jest.fn() };
        const internals = behavior as unknown as { equipWeapon(npc: NpcController): void };
        internals.equipWeapon(controller as unknown as NpcController);
        expect(controller.isRenderingSkinnedMesh).not.toHaveBeenCalled();
    });

    it('removes a weapon when the corpse has no hand instead of leaving it floating', () => {
        const gun = new THREE.Group(); new THREE.Group().add(gun);
        const { behavior } = armedNpc(null, gun);
        const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try { behavior.onNpcDeath(); } finally { warning.mockRestore(); }
        expect(gun.parent).toBeNull();
    });
});
