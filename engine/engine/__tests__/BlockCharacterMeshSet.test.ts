/**
 * A block character changes clothes by swapping the MESHES inside its
 * bone-bound body-part groups — the groups, the bindings and the pose stay put.
 *
 * The bug these tests pin: variants used to be a second BlockCharacterRenderer
 * that was update()d outside the window where CharacterLoader installs the
 * frame's blended bone pose, so a changed outfit rendered the bind pose forever
 * while the original animated. Nothing threw and nothing warned. Test 1 is that
 * regression: meshes swapped in mid-frame must be posed by the same overrides
 * as the ones they replaced.
 */
import * as THREE from 'three';
import type { IBlockCharacterFactory } from 'engine/IBlockCharacterFactory.js';
import { BLOCK_BODY_PART_NAMES, BlockCharacterRenderer } from 'engine/BlockCharacterRenderer.js';

/** Bones the renderer resolves body parts to, at distinct positions. */
const BONE_LAYOUT: Array<[string, [number, number, number]]> = [
    ['mixamorigHips', [0, 1.0, 0]],
    ['mixamorigSpine', [0, 1.2, 0]],
    ['mixamorigNeck', [0, 1.5, 0]],
    ['mixamorigHead', [0, 1.65, 0]],
    ['mixamorigLeftShoulder', [-0.15, 1.45, 0]],
    ['mixamorigRightShoulder', [0.15, 1.45, 0]],
    ['mixamorigLeftArm', [-0.3, 1.4, 0]],
    ['mixamorigLeftForeArm', [-0.5, 1.1, 0]],
    ['mixamorigLeftHand', [-0.6, 0.9, 0]],
    ['mixamorigRightArm', [0.3, 1.4, 0]],
    ['mixamorigRightForeArm', [0.5, 1.1, 0]],
    ['mixamorigRightHand', [0.6, 0.9, 0]],
    ['mixamorigLeftUpLeg', [-0.12, 0.95, 0]],
    ['mixamorigLeftLeg', [-0.12, 0.5, 0]],
    ['mixamorigLeftFoot', [-0.12, 0.1, 0]],
    ['mixamorigLeftToeBase', [-0.12, 0.05, 0.1]],
    ['mixamorigRightUpLeg', [0.12, 0.95, 0]],
    ['mixamorigRightLeg', [0.12, 0.5, 0]],
    ['mixamorigRightFoot', [0.12, 0.1, 0]],
    ['mixamorigRightToeBase', [0.12, 0.05, 0.1]],
];

function makeSkeleton(): THREE.Object3D {
    const root = new THREE.Object3D();
    root.name = 'Armature';
    for (const [name, [x, y, z]] of BONE_LAYOUT) {
        const bone = new THREE.Bone();
        bone.name = name;
        bone.position.set(x, y, z);
        root.add(bone);
    }
    root.updateMatrixWorld(true);
    return root;
}

/** A factory that drops one named box into every standard body-part group. */
function makeFactory(look: string, material?: THREE.Material, geometry?: THREE.BufferGeometry): IBlockCharacterFactory {
    return {
        createBlockCharacter(characterGroup: THREE.Group): void {
            for (const partName of BLOCK_BODY_PART_NAMES) {
                const group = characterGroup.getObjectByName(partName) as THREE.Group;
                const mesh = new THREE.Mesh(
                    geometry ?? new THREE.BoxGeometry(0.1, 0.1, 0.1),
                    material ?? new THREE.MeshStandardMaterial()
                );
                mesh.name = `${look}:${partName}`;
                group.add(mesh);
            }
        },
        getCharacterDimensions: () => ({ width: 0.5, height: 1.8, depth: 0.3 }),
    };
}

/** A renderer wearing the 'original' look, over its own skeleton. */
function makeCharacter(): { skeleton: THREE.Object3D; renderer: BlockCharacterRenderer } {
    const skeleton = makeSkeleton();
    return { skeleton, renderer: BlockCharacterRenderer.create(skeleton, makeFactory('original')) };
}

/**
 * Every bone's world transform shifted uniformly along +X. A uniform
 * translation moves every body part by exactly the same amount whichever
 * internal path poses it (single bone, joint-pair midpoint, torso basis), so
 * the expected result stays trivial to state.
 */
const POSE_SHIFT = new THREE.Vector3(7, 0, 0);

function shiftedPose(skeleton: THREE.Object3D): Map<string, { position: THREE.Vector3; rotation: THREE.Quaternion }> {
    const pose = new Map<string, { position: THREE.Vector3; rotation: THREE.Quaternion }>();
    skeleton.traverse(child => {
        const bone = child as THREE.Bone;
        if (!bone.isBone) return;
        const position = new THREE.Vector3();
        const rotation = new THREE.Quaternion();
        bone.getWorldPosition(position);
        bone.getWorldQuaternion(rotation);
        pose.set(bone.name, { position: position.add(POSE_SHIFT), rotation });
    });
    return pose;
}

function partWorldPosition(renderer: BlockCharacterRenderer, partName: string): THREE.Vector3 {
    const part = renderer.getBodyPart(partName);
    if (!part) throw new Error(`missing body part ${partName}`);
    return part.getWorldPosition(new THREE.Vector3());
}

function meshNames(renderer: BlockCharacterRenderer, partName: string): string[] {
    const part = renderer.getBodyPart(partName);
    return part ? part.children.map(child => child.name) : [];
}

describe('BlockCharacterRenderer mesh sets', () => {
    test('meshes swapped in mid-frame are posed by the same bone overrides', () => {
        const { skeleton, renderer } = makeCharacter();

        // Bind pose: no overrides, blocks sit on the raw skeleton.
        renderer.update();
        const bind = partWorldPosition(renderer, 'rightForearm');

        // The pose the loader installs for one frame and clears again.
        const pose = shiftedPose(skeleton);
        renderer.setBoneTransformOverrides(pose);
        renderer.update();
        const posed = partWorldPosition(renderer, 'rightForearm');
        expect(posed.x - bind.x).toBeCloseTo(POSE_SHIFT.x, 5);

        // Change of clothes, then pose again exactly as the loader would.
        const variant = renderer.buildMeshSet(makeFactory('variant'));
        renderer.applyMeshSet(variant);
        renderer.update();
        renderer.setBoneTransformOverrides(null);

        expect(meshNames(renderer, 'rightForearm')).toEqual(['variant:rightForearm']);
        const variantMesh = renderer.getBodyPart('variant:rightForearm');
        expect(variantMesh).not.toBeNull();
        // The regression: this used to be the bind pose forever.
        const variantWorld = variantMesh!.getWorldPosition(new THREE.Vector3());
        expect(variantWorld.x).not.toBeCloseTo(bind.x, 5);
        expect(variantWorld.x).toBeCloseTo(posed.x, 5);
        expect(variantWorld.y).toBeCloseTo(posed.y, 5);
        expect(variantWorld.z).toBeCloseTo(posed.z, 5);
    });

    test('a swap keeps the pose the last frame wrote, with no bind-pose flash', () => {
        const { skeleton, renderer } = makeCharacter();
        renderer.setBoneTransformOverrides(shiftedPose(skeleton));
        renderer.update();
        renderer.setBoneTransformOverrides(null);
        const posed = partWorldPosition(renderer, 'leftShin');

        // No update() after the swap — the new meshes inherit the posed groups.
        renderer.applyMeshSet(renderer.buildMeshSet(makeFactory('variant')));
        renderer.getRoot().updateMatrixWorld(true);

        const swapped = renderer.getBodyPart('variant:leftShin')!.getWorldPosition(new THREE.Vector3());
        expect(swapped.x).toBeCloseTo(posed.x, 5);
        expect(swapped.y).toBeCloseTo(posed.y, 5);
    });

    test('game-attached objects survive a change of clothes', () => {
        const { renderer } = makeCharacter();

        const gun = new THREE.Object3D();
        gun.name = 'gun';
        (renderer.getBodyPart('rightHand') as THREE.Group).add(gun);

        const variant = renderer.buildMeshSet(makeFactory('variant'));
        renderer.applyMeshSet(variant);
        expect(meshNames(renderer, 'rightHand')).toEqual(['gun', 'variant:rightHand']);

        renderer.applyMeshSet(renderer.getOriginalMeshSet());
        expect(meshNames(renderer, 'rightHand')).toEqual(['gun', 'original:rightHand']);
        expect(gun.parent?.name).toBe('rightHand');
    });

    test('the original set can always be put back on', () => {
        const { renderer } = makeCharacter();
        const original = renderer.getOriginalMeshSet();
        expect(renderer.getAppliedMeshSet()).toBe(original);

        renderer.applyMeshSet(renderer.buildMeshSet(makeFactory('variant')));
        expect(meshNames(renderer, 'head')).toEqual(['variant:head']);

        renderer.applyMeshSet(original);
        expect(renderer.getAppliedMeshSet()).toBe(original);
        for (const partName of BLOCK_BODY_PART_NAMES) {
            expect(meshNames(renderer, partName)).toEqual([`original:${partName}`]);
        }
    });

    test('disposeMeshSet frees the set but never the shared material cache', () => {
        const { renderer } = makeCharacter();

        const shared = new THREE.MeshStandardMaterial();
        shared.userData.__sharedLodCache = true;
        const sharedDispose = jest.spyOn(shared, 'dispose');

        const variant = renderer.buildMeshSet(makeFactory('variant', shared));
        const geometry = variant.parts.get('head')![0] as THREE.Mesh;
        const geometryDispose = jest.spyOn(geometry.geometry, 'dispose');

        renderer.disposeMeshSet(variant);
        expect(geometryDispose).toHaveBeenCalled();
        expect(sharedDispose).not.toHaveBeenCalled();
    });

    test('disposeMeshSet leaves cache-owned geometry to the cache', () => {
        const { renderer } = makeCharacter();

        const shared = new THREE.BoxGeometry(0.1, 0.1, 0.1);
        shared.userData.__sharedLodCache = true;
        const sharedDispose = jest.spyOn(shared, 'dispose');

        renderer.disposeMeshSet(renderer.buildMeshSet(makeFactory('variant', undefined, shared)));
        expect(sharedDispose).not.toHaveBeenCalled();
    });

    test('disposeMeshSet refuses the set the character is wearing', () => {
        const { renderer } = makeCharacter();
        const worn = renderer.getAppliedMeshSet();
        const mesh = worn.parts.get('head')![0] as THREE.Mesh;
        const geometryDispose = jest.spyOn(mesh.geometry, 'dispose');
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        renderer.disposeMeshSet(worn);

        expect(geometryDispose).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });
});
