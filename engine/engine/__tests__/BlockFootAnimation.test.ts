import * as THREE from 'three';
import { BLOCK_BODY_PART_NAMES, BlockCharacterRenderer, type BlockFootPose } from 'engine/BlockCharacterRenderer.js';
import { CharacterLoader } from 'engine/loaders/CharacterLoader.js';
import { CharacterAnimationController } from 'engine/CharacterAnimationController.js';
import { MixamoAnimationPlayer } from 'engine/MixamoAnimationPlayer.js';
import type { EngineLike } from 'types/game.js';

const rotation = (x = 0, y = 0, z = 0) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z));
const flat = rotation(-Math.PI / 2);
const poseOptions = (overrides: Partial<BlockFootPose> = {}): BlockFootPose => ({
    grounded: true, bound: false, authoredFootLift: 0, characterHeight: 1.75, deltaSeconds: 1 / 60, restRotations: null, ...overrides,
});

function fixture(rest = rotation(.7, .2, -.3)) {
    const skeleton = new THREE.Group();
    const bones = new Map<string, THREE.Bone>();
    for (const part of BLOCK_BODY_PART_NAMES) {
        const name = BlockCharacterRenderer.boneNamesForPart(part).find(n => !n.includes('Toe'))!;
        const bone = new THREE.Bone(); bone.name = name;
        bone.position.set(part.startsWith('left') ? .1 : -.1, part.endsWith('Foot') ? .1 : 1, 0);
        if (part.endsWith('Foot')) bone.quaternion.copy(rest);
        skeleton.add(bone); bones.set(part, bone);
    }
    skeleton.updateMatrixWorld(true);
    const renderer = BlockCharacterRenderer.create(skeleton, {
        createBlockCharacter(root) {
            for (const part of BLOCK_BODY_PART_NAMES) {
                const mesh = new THREE.Mesh(new THREE.BoxGeometry(.1, .2, .1));
                if (part.endsWith('Foot')) mesh.position.y = -.08;
                root.getObjectByName(part)!.add(mesh);
            }
        },
        getCharacterDimensions: () => ({ width: .5, height: 1.75, depth: .3 }),
    });
    const foot = (side: string) => renderer.getBodyPart(`${side}Foot`)!;
    const orient = (side: string) => foot(side).getWorldQuaternion(new THREE.Quaternion());
    return { skeleton, renderer, bones, foot, orient, rest };
}

const expectRotation = (actual: THREE.Quaternion, expected: THREE.Quaternion) => {
    expect(actual.angleTo(expected)).toBeLessThan(1e-6);
    expect(actual.length()).toBeCloseTo(1, 10);
};

describe('block ankle animation', () => {
    it('keeps the legacy flat sole at contact despite raw bind-axis tilt', () => {
        const f = fixture();
        f.bones.get('leftFoot')!.quaternion.premultiply(rotation(.4));
        f.renderer.update(poseOptions());
        expectRotation(f.orient('left'), flat);
        expectRotation(f.orient('right'), flat);
    });

    it.each(['left', 'right'])('releases the %s swing ankle, independently of the planted foot', side => {
        const f = fixture(); const ankle = f.bones.get(`${side}Foot`)!;
        const delta = rotation(-.9, .2, .3);
        ankle.position.y += .3; ankle.quaternion.premultiply(delta);
        f.renderer.update(poseOptions());
        expectRotation(f.orient(side), delta.clone().multiply(flat));
        expectRotation(f.orient(side === 'left' ? 'right' : 'left'), flat);
        expect(f.foot(side).getWorldPosition(new THREE.Vector3()).distanceTo(ankle.position)).toBeLessThan(1e-8);
        expectRotation(ankle.quaternion, delta.clone().multiply(f.rest));
    });

    it.each(['authored flight', 'physics airborne'])('releases BOTH ankles during %s, not just the higher one', mode => {
        const f = fixture();
        const delta = rotation(.5, -.2, .1);
        for (const side of ['left', 'right']) f.bones.get(`${side}Foot`)!.quaternion.premultiply(delta);
        f.renderer.update(poseOptions(mode === 'authored flight' ? { authoredFootLift: .2 } : { grounded: false }));
        for (const side of ['left', 'right']) expectRotation(f.orient(side), delta.clone().multiply(flat));
    });

    it('blends continuously through lift-off and landing', () => {
        const f = fixture(); const ankle = f.bones.get('leftFoot')!;
        const delta = rotation(-1.1); ankle.quaternion.premultiply(delta);
        const samples: THREE.Quaternion[] = [];
        for (let i = 0; i <= 200; i++) {
            ankle.position.y = .1 + i * .001;
            f.renderer.update(poseOptions()); samples.push(f.orient('left'));
            if (i) expect(samples[i]!.angleTo(samples[i - 1]!)).toBeLessThan(.02);
        }
        for (let i = 200; i >= 0; i--) {
            ankle.position.y = .1 + i * .001;
            const before = f.orient('left');
            f.renderer.update(poseOptions());
            expect(f.orient('left').angleTo(before)).toBeLessThan(.02);
        }
        expectRotation(samples[0]!, flat);
        expectRotation(samples[200]!, delta.clone().multiply(flat));
        for (let i = 0; i < 60; i++) f.renderer.update(poseOptions());
        expectRotation(f.orient('left'), flat);
    });

    it.each([15, 30, 60, 120, 144])('releases an abrupt contact change consistently at %s FPS', fps => {
        const f = fixture(); const ankle = f.bones.get('leftFoot')!;
        const opts = poseOptions({ deltaSeconds: 1 / fps });
        ankle.quaternion.premultiply(rotation(-1));
        f.renderer.update(opts); // planted, release = 0
        ankle.position.y += .3;
        let before = f.orient('left');
        for (let i = 0; i < fps; i++) {
            f.renderer.update(opts);
            const after = f.orient('left');
            expect(after.angleTo(before)).toBeLessThanOrEqual(1 - Math.exp(-1 / fps / .055) + 1e-6);
            const release = 1 - Math.exp(-(i + 1) / fps / .055);
            expectRotation(after, rotation(-release).multiply(flat));
            before = after;
        }
    });

    it.each([.25, 1, 3])('is height-scale independent at character scale %s', scale => {
        const f = fixture(); const ankle = f.bones.get('leftFoot')!;
        f.skeleton.scale.setScalar(scale); ankle.position.y += .07;
        ankle.quaternion.premultiply(rotation(-1));
        f.renderer.update(poseOptions({ characterHeight: 1.75 * scale }));
        const release = THREE.MathUtils.smoothstep(.07, 1.75 * .015, 1.75 * .065);
        expectRotation(f.orient('left'), flat.clone().premultiply(rotation(-release)));
    });

    it.each([0, .7, Math.PI, -2.1])('uses the ankle delta in world space at facing %s', yaw => {
        const f = fixture(); const ankle = f.bones.get('leftFoot')!;
        f.skeleton.rotation.y = yaw; f.skeleton.position.set(7, 15, -3);
        const delta = rotation(-.8, .3, .2); ankle.quaternion.premultiply(delta); ankle.position.y += .3;
        f.renderer.getRoot().position.set(7, 14, -3); f.renderer.getRoot().rotation.y = -.9;
        const rootBefore = f.renderer.getRoot().quaternion.clone();
        f.renderer.update(poseOptions());
        expectRotation(f.orient('left'), rotation(0, yaw).multiply(delta).multiply(flat));
        expectRotation(f.renderer.getRoot().quaternion, rootBefore);
        expect(f.skeleton.position.toArray()).toEqual([7, 15, -3]);
    });

    it('retains the legacy opposite model-forward basis', () => {
        const f = fixture(); f.renderer.setModelForward(new THREE.Vector3(0, 0, 1));
        const delta = rotation(-.5); f.bones.get('leftFoot')!.quaternion.premultiply(delta);
        f.renderer.update(poseOptions({ grounded: false }));
        const oppositeFlat = rotation(0, Math.PI).multiply(flat);
        expectRotation(f.orient('left'), delta.multiply(oppositeFlat));
    });

    it('uses composed overrides and their SOURCE rest, not the underlying GLTF pose', () => {
        const f = fixture(); const sourceRest = rotation(1.5, -.3, .2), delta = rotation(-.6, .1, -.2);
        const ankle = f.bones.get('leftFoot')!;
        const entry = { position: new THREE.Vector3(.1, .4, 0), rotation: delta.clone().multiply(sourceRest) };
        const saved = entry.rotation.clone();
        f.renderer.setBoneTransformOverrides(new Map([[ankle.name, entry]]));
        f.renderer.update(poseOptions({ restRotations: new Map([[ankle.name, sourceRest]]) }));
        expectRotation(f.orient('left'), delta.multiply(flat));
        expectRotation(entry.rotation, saved);
        expectRotation(ankle.quaternion, f.rest);
        expect(entry.position.toArray()).toEqual([.1, .4, 0]);
        f.renderer.setBoneTransformOverrides(null);
        for (let i = 0; i < 60; i++) f.renderer.update(poseOptions());
        expectRotation(f.orient('left'), flat);
    });

    it('the direct skeleton path also releases two equally lifted feet', () => {
        const f = fixture();
        for (const side of ['left', 'right']) {
            const ankle = f.bones.get(`${side}Foot`)!;
            ankle.position.y += .2; ankle.quaternion.premultiply(rotation(.5));
        }
        f.renderer.update();
        expectRotation(f.orient('left'), rotation(.5).multiply(flat));
        expectRotation(f.orient('right'), rotation(.5).multiply(flat));
    });

    it('keeps explicit attachment and preserved-pose feet authoritative', () => {
        const f = fixture(); f.renderer.update();
        const target = new THREE.Group(); target.position.set(3, 2, 1); target.rotation.x = .3; target.updateMatrixWorld(true);
        f.renderer.setAttachmentOverride('leftFoot', target, new THREE.Vector3(), new THREE.Euler(.2, 0, 0));
        f.renderer.update(poseOptions({ grounded: false }));
        expectRotation(f.orient('left'), rotation(.5));
        f.renderer.setPoseOverride({ parts: new Map(), weight: 1, preserveFeet: true, preserveRootHeight: true, armTarget: null });
        f.renderer.update(poseOptions({ grounded: false })); // captures the held pose on its first update
        const held = f.orient('right');
        f.bones.get('rightFoot')!.quaternion.premultiply(rotation(1));
        f.renderer.update(poseOptions({ grounded: false }));
        expectRotation(f.orient('right'), held);
    });

    it('does not release movement-system foot bindings even when airborne', () => {
        const f = fixture(); f.bones.get('leftFoot')!.quaternion.premultiply(rotation(1));
        f.renderer.update(poseOptions({ bound: true, grounded: false, authoredFootLift: .3 }));
        expectRotation(f.orient('left'), flat);
    });

    it('the loader resolves source-rest aliases just like composed pose aliases', () => {
        const f = fixture(); const ankle = f.bones.get('leftFoot')!;
        const sourceBone = new THREE.Bone(); sourceBone.name = 'mixamorig2LeftFoot';
        const sourceRest = rotation(1.5, -.2, .4), delta = rotation(-.8, .1, -.2);
        const pose = new Map([[ankle.name, { position: ankle.position.clone().add(new THREE.Vector3(0, .3, 0)),
            rotation: delta.clone().multiply(sourceRest) }]]);
        const player = new MixamoAnimationPlayer();
        jest.spyOn(player, 'getBoneMap').mockReturnValue(new Map([[sourceBone.name, sourceBone]]));
        jest.spyOn(player, 'getRestRotations').mockReturnValue(new Map([[sourceBone.name, sourceRest]]));
        const controller = new CharacterAnimationController();
        jest.spyOn(controller, 'getTrackAMixamoPlayer').mockReturnValue(player);
        jest.spyOn(controller, 'getPoseGrounded').mockReturnValue(false);
        class Loader extends CharacterLoader {
            constructor() {
                super({ scene: new THREE.Scene() } as unknown as EngineLike);
                this.blockCharacterRenderer = f.renderer;
                this.characterGroup = f.skeleton;
                this.setAnimationController(controller);
            }
            protected override computeBlendedPose() { return pose; }
        }
        const loader = new Loader();
        loader.updateBlockCharacter(new THREE.Vector3());
        expectRotation(f.orient('left'), delta.multiply(flat));
        loader.dispose(); controller.dispose(); player.dispose();
    });

    it('measures a skinned rig\'s ankle from ONE rest while clips that rest differently crossfade', () => {
        const f = fixture(); const ankle = f.bones.get('leftFoot')!;
        // Skinned mode: the block body is the hidden pose source of a real skin.
        const bones = [...f.bones.values()];
        const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
        mesh.bind(new THREE.Skeleton(bones, bones.map(b => b.matrixWorld.clone().invert())), new THREE.Matrix4());
        f.skeleton.add(mesh);
        // Both clips lift the ankle and turn it by the same `delta` from their OWN rest.
        const delta = rotation(-.8, .1, -.2);
        const clip = (rest: THREE.Quaternion) => {
            const bone = new THREE.Bone(); bone.name = ankle.name;
            bone.position.copy(ankle.position).add(new THREE.Vector3(0, .3, 0));
            bone.quaternion.copy(delta).multiply(rest); bone.updateMatrixWorld(true);
            const player = new MixamoAnimationPlayer();
            jest.spyOn(player, 'getBoneMap').mockReturnValue(new Map([[bone.name, bone]]));
            jest.spyOn(player, 'getRestRotations').mockReturnValue(new Map([[bone.name, rest]]));
            return player;
        };
        const outgoing = clip(rotation(1.5, -.2, .4)), incoming = clip(rotation(.2, .9, -.6));
        const controller = new CharacterAnimationController();
        jest.spyOn(controller, 'getTrackAMixamoPlayer').mockReturnValue(incoming);
        jest.spyOn(controller, 'getFadingOutTrackAPlayer').mockReturnValue(outgoing);
        jest.spyOn(controller, 'getFadingOutCrossfadeProgress').mockReturnValue(.5);
        jest.spyOn(controller, 'getPoseGrounded').mockReturnValue(false);
        class Loader extends CharacterLoader {
            constructor() {
                super({ scene: new THREE.Scene() } as unknown as EngineLike);
                this.blockCharacterRenderer = f.renderer;
                this.characterGroup = f.skeleton;
                this.setSkinnedSkeletonRoot(f.skeleton);
                this.setAnimationController(controller);
            }
        }
        const loader = new Loader();
        loader.updateBlockCharacter(new THREE.Vector3());
        expectRotation(f.orient('left'), delta.clone().multiply(flat));
        loader.dispose(); controller.dispose(); outgoing.dispose(); incoming.dispose();
    });
});
