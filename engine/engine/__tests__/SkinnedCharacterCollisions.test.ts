import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { CharacterLoader } from 'engine/loaders/CharacterLoader.js';
import { gatherMeleeBodyHits } from 'engine/MeleeSweepTargets.js';
import { computeCharacterBodyBox } from 'engine/character/CharacterBodyBounds.js';
import { CollisionGroup, CollisionMask, makeCollisionGroups } from 'engine/CollisionLayers.js';
import { initRapier } from 'engine/physics/RapierPhysics.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import type { EngineLike } from 'types/game.js';
import { CharacterAnimationController } from 'engine/CharacterAnimationController.js';
import { MixamoAnimationPlayer } from 'engine/MixamoAnimationPlayer.js';

/** A minimal GLB-style body, with a real skin and independently movable bones. */
function skinnedBody(scale = 1): { root: THREE.Group; mesh: THREE.SkinnedMesh; foot: THREE.Bone } {
    const root = new THREE.Group();
    const foot = new THREE.Bone();
    foot.name = 'mixamorigLeftFoot';
    const geometry = new THREE.BoxGeometry(0.5 / scale, 1.8 / scale, 0.4 / scale);
    geometry.translate(0, 0.9 / scale, 0);
    const count = geometry.getAttribute('position').count;
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(count * 4), 4));
    const weights = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) weights[i * 4] = 1;
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
    const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
    root.add(foot, mesh);
    root.updateMatrixWorld(true);
    mesh.bind(new THREE.Skeleton([foot]));
    return { root, mesh, foot };
}

/** The objects a 2 m melee sweep along +Z through (x, y, z) reports as hit. */
function sweepHits(scene: THREE.Scene, x: number, y: number, z = 0): THREE.Object3D[] {
    return gatherMeleeBodyHits(
        scene, new THREE.Vector3(x, y, z - 1), new THREE.Vector3(x, y, z + 1), 0.05,
    ).map(hit => hit.object);
}

/** World-space X of a measured body box's centre. */
function centerX(box: THREE.Box3): number {
    return box.getCenter(new THREE.Vector3()).x;
}

function addHitProxy(scene: THREE.Scene, root: THREE.Object3D): THREE.Mesh {
    const proxy = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.8, 0.4));
    proxy.visible = false;
    proxy.userData = {
        damageableController: {},
        physicsBody: { translation: () => ({ x: 0, y: 0.9, z: 0 }) },
        npcHitRoot: root,
        capsuleRadius: 0.3,
        capsuleHalfHeight: 0.6,
    };
    scene.add(root, proxy);
    return proxy;
}

describe('melee against low-poly skinned bodies', () => {
    it('hits the posed body after bone movement, without leaving a hit at the bind pose', () => {
        const scene = new THREE.Scene();
        const { root, foot } = skinnedBody();
        const proxy = addHitProxy(scene, root);
        expect(sweepHits(scene, 0, 0.9)).toEqual([proxy]);
        foot.position.x = 4;
        expect(sweepHits(scene, 4, 0.9)).toEqual([proxy]);
        expect(sweepHits(scene, 0, 0.9)).toEqual([]);
        foot.position.x = -4;
        expect(sweepHits(scene, -4, 0.9)).toEqual([proxy]);
        expect(sweepHits(scene, 4, 0.9)).toEqual([]);
    });

    it('prunes whole weapon subtrees from the hit volume', () => {
        const scene = new THREE.Scene();
        const { root, foot } = skinnedBody();
        addHitProxy(scene, root);
        const weapon = new THREE.Group();
        weapon.userData.isUserAttached = true;
        const blade = new THREE.Mesh(new THREE.BoxGeometry(12, 1, 1));
        blade.position.set(6, 0.9, 0);
        weapon.add(blade);
        foot.add(weapon);
        expect(sweepHits(scene, 6, 0.9)).toEqual([]);
    });

    it('uses the live physics capsule when the visual root has no body meshes', () => {
        const scene = new THREE.Scene();
        const proxy = addHitProxy(scene, new THREE.Group());
        expect(sweepHits(scene, 0, 0.9)).toEqual([proxy]);
    });

    it('keeps ordinary block/rigid voxel meshes hittable as they move', () => {
        const scene = new THREE.Scene();
        const root = new THREE.Group();
        const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.8, 0.4));
        body.position.y = 0.9;
        root.add(body);
        const proxy = addHitProxy(scene, root);
        root.position.set(7, 3, -2);
        expect(sweepHits(scene, 7, 3.9, -2)).toEqual([proxy]);
    });
});

describe('posed skin bounds', () => {
    it('encloses blended vertices with non-identity bind transforms and a scaled, moved parent', () => {
        const { root, mesh, foot } = skinnedBody();
        const second = new THREE.Bone();
        second.position.set(0, 1, 0);
        root.add(second);
        mesh.position.set(0.3, -0.5, 0.2);
        root.updateMatrixWorld(true);
        mesh.bind(new THREE.Skeleton([foot, second]));
        const indices = mesh.geometry.getAttribute('skinIndex');
        const weights = mesh.geometry.getAttribute('skinWeight');
        for (let i = 0; i < weights.count; i++) {
            indices.setXYZW(i, 0, 1, 0, 0);
            weights.setXYZW(i, 0.25, 0.75, 0, 0);
        }
        const parent = new THREE.Group();
        parent.add(root);
        // All matrices are deliberately stale, as they can be before rendering.
        parent.position.set(9, 4, -7);
        parent.rotation.y = 0.7;
        parent.scale.setScalar(1.4);
        foot.rotation.z = 0.4;
        second.rotation.x = -0.6;
        const bounds = computeCharacterBodyBox(root, new THREE.Box3()).expandByScalar(1e-6);
        const vertex = new THREE.Vector3();
        for (let i = 0; i < weights.count; i++) {
            mesh.getVertexPosition(i, vertex).applyMatrix4(mesh.matrixWorld);
            expect(bounds.containsPoint(vertex)).toBe(true);
        }
    });

    it('shares geometry bounds without sharing the pose between NPC clones', () => {
        const first = skinnedBody();
        const second = skinnedBody();
        second.mesh.geometry.dispose();
        second.mesh.geometry = first.mesh.geometry;
        first.foot.position.x = 4;
        second.foot.position.x = -4;
        const firstBox = computeCharacterBodyBox(first.root, new THREE.Box3());
        const secondBox = computeCharacterBodyBox(second.root, new THREE.Box3());
        expect(centerX(firstBox)).toBeCloseTo(4);
        expect(centerX(secondBox)).toBeCloseTo(-4);
        first.foot.position.x = 6;
        expect(centerX(computeCharacterBodyBox(first.root, firstBox))).toBeCloseTo(6);
        expect(centerX(computeCharacterBodyBox(second.root, secondBox))).toBeCloseTo(-4);
        // Repeated queries must not invoke per-vertex CPU skinning.
        const vertexRead = jest.spyOn(first.mesh, 'getVertexPosition');
        computeCharacterBodyBox(first.root, firstBox);
        expect(vertexRead).not.toHaveBeenCalled();
    });

    it('includes active morphs before skinning', () => {
        const { root, mesh, foot } = skinnedBody();
        const morph = mesh.geometry.getAttribute('position').clone();
        for (let i = 0; i < morph.count; i++) morph.setXYZ(i, 3, 0, 0);
        mesh.geometry.morphAttributes.position = [morph];
        mesh.geometry.morphTargetsRelative = true;
        mesh.updateMorphTargets();
        mesh.morphTargetInfluences![0] = 1;
        foot.position.x = 2;
        expect(centerX(computeCharacterBodyBox(root, new THREE.Box3()))).toBeCloseTo(5);
    });
});

class PosingLoader extends CharacterLoader {
    protected computeBlendedPose(): Map<string, { position: THREE.Vector3; rotation: THREE.Quaternion }> {
        // An active animation; leave the authored rotations alone for this fixture.
        return new Map();
    }
}

/** Container scales an NPC GLB is loaded at, from a tiny asset to an oversized one. */
const PARENT_SCALES = [0.01, 0.5, 1, 2];

describe('scaled skinned characters stay aligned with their projectile capsule', () => {
    beforeAll(async () => { await initRapier(); });

    it.each(PARENT_SCALES)('preserves authored foot lift in world metres at scale %s', (scale) => {
        // Exercise the real compositor: foot lift now follows the same blend
        // as the displayed pose rather than being read directly during grounding.
        const loader = new CharacterLoader({} as EngineLike);
        const group = new THREE.Group();
        group.scale.setScalar(scale);
        group.position.set(8, 4, -3);
        const { root, foot } = skinnedBody(scale);
        group.add(root);
        loader.setSkinnedSkeletonRoot(root);
        let lift = 0;
        const source = new MixamoAnimationPlayer();
        jest.spyOn(source, 'getBoneMap').mockReturnValue(new Map([[foot.name, foot]]));
        jest.spyOn(source, 'getRestRotations').mockReturnValue(new Map([[foot.name, new THREE.Quaternion()]]));
        jest.spyOn(source, 'getAuthoredFootLift').mockImplementation(() => lift);
        const controller = new CharacterAnimationController();
        jest.spyOn(controller, 'getTrackAMixamoPlayer').mockReturnValue(source);
        loader.setAnimationController(controller);
        for (const authoredLift of [0.25, 0.6, 0]) {
            lift = authoredLift;
            loader.updateSkinnedCharacter(group.position);
            expect(foot.getWorldPosition(new THREE.Vector3()).y).toBeCloseTo(4 + lift, 5);
        }

        // Preserve the local blended-lift change AND upstream's world-to-parent
        // conversion: a half-weight action must not plant using Track A alone.
        lift = 0.2;
        const action = new MixamoAnimationPlayer();
        jest.spyOn(action, 'getAuthoredFootLift').mockReturnValue(0.6);
        jest.spyOn(action, 'getBlendWeight').mockReturnValue(0.5);
        jest.spyOn(controller, 'getTrackBMixamoPlayer').mockReturnValue(action);
        const mask = jest.spyOn(controller, 'getCustomAnimationBodyBlend');
        for (const lowerBody of [1, 0.5, 0]) {
            mask.mockReturnValue({ upperBody: 1, lowerBody });
            for (let frame = 0; frame < 12; frame++) loader.updateSkinnedCharacter(group.position);
            expect(foot.getWorldPosition(new THREE.Vector3()).y).toBeCloseTo(4 + lift + (0.6 - lift) * 0.5 * lowerBody, 5);
        }
    });

    const targets = PARENT_SCALES.flatMap(scale => [
        { name: 'NPC', scale, group: CollisionGroup.ENEMY, mask: CollisionMask.ENEMY, shotMask: CollisionMask.PROJECTILE },
        { name: 'player', scale, group: CollisionGroup.PLAYER, mask: CollisionMask.PLAYER, shotMask: CollisionMask.ENEMY_PROJECTILE },
    ]);
    it.each(targets)('hits the visible $name body with parent scale $scale', ({ scale, group: collisionGroup, mask, shotMask }) => {
        const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
        const physics = {
            createRigidBody: (desc: RAPIER.RigidBodyDesc) => world.createRigidBody(desc),
            createCollider: (desc: RAPIER.ColliderDesc, body: RAPIER.RigidBody) => world.createCollider(desc, body),
        } as unknown as PhysicsWorld;
        const loader = new PosingLoader({} as EngineLike);
        const group = new THREE.Group();
        group.scale.setScalar(scale);
        group.rotation.y = Math.PI / 3;
        const { root, mesh, foot } = skinnedBody(scale);
        group.add(root);
        loader.setSkinnedSkeletonRoot(root);
        loader.setCapsuleDimensions(1.8, 0.3);
        const body = loader.createPhysicsBody(new THREE.Vector3(8, 4, -3), physics, -35, collisionGroup, mask);
        try {
            for (const offset of [2, -0.7, 1.1]) {
                // Movement can leave the parent's matrix stale until the pose runs.
                body.setTranslation({ x: 8 + offset, y: 4.95, z: -3 }, true);
                loader.syncCharacterWithPhysics(group, body);
                root.position.y = offset / scale;
                loader.updateSkinnedCharacter(group.position);
                expect(foot.getWorldPosition(new THREE.Vector3()).y).toBeCloseTo(4.05, 5);

                // A shot through the rendered torso must also intersect the physics body.
                mesh.computeBoundingBox();
                const center = mesh.boundingBox!.clone().applyMatrix4(mesh.matrixWorld).getCenter(new THREE.Vector3());
                world.step();
                const hit = world.castRay(new RAPIER.Ray(
                    { x: center.x, y: center.y, z: center.z - 2 }, { x: 0, y: 0, z: 1 },
                ), 4, true, undefined, makeCollisionGroups(CollisionGroup.PROJECTILE, shotMask));
                expect(hit?.collider.parent()?.handle).toBe(body.handle);

                // Exercise Rapier's actual fast-projectile contact path too (60 m/s).
                const bullet = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
                    .setTranslation(center.x, center.y, center.z - 2)
                    .setLinvel(0, 0, 60).setCcdEnabled(true));
                const bulletCollider = world.createCollider(RAPIER.ColliderDesc.ball(0.05)
                    .setCollisionGroups(makeCollisionGroups(CollisionGroup.PROJECTILE, shotMask))
                    .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS), bullet);
                const events = new RAPIER.EventQueue(true);
                let contacted = false;
                for (let frame = 0; frame < 8 && !contacted; frame++) {
                    world.step(events);
                    events.drainCollisionEvents((a, b, started) => {
                        if (started && ((a === bulletCollider.handle && b === body.collider(0).handle)
                            || (b === bulletCollider.handle && a === body.collider(0).handle))) contacted = true;
                    });
                }
                events.free();
                world.removeRigidBody(bullet);
                expect(contacted).toBe(true);
            }
        } finally {
            world.free();
        }
    });
});
