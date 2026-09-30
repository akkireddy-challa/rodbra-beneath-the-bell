import * as THREE from 'three';
import { CharacterLoader } from 'engine/loaders/CharacterLoader.js';
import { bitmagicCharacterFactory } from 'genres/voxel/BitmagicPlayerCharacter.js';
import { computeCharacterBodyBox } from 'engine/character/CharacterBodyBounds.js';
import type { EngineLike } from 'types/game.js';

function fixture() {
    const scene = new THREE.Scene(), frame = new THREE.Group(), skeleton = new THREE.Group();
    frame.position.set(2, .875, -3); scene.add(frame); frame.add(skeleton);
    const bone = (parent: THREE.Object3D, name: string, x: number, y: number, z = 0) => {
        const node = new THREE.Bone(); node.name = `mixamorig${name}`; node.position.set(x, y, z); parent.add(node); return node;
    };
    const hips = bone(skeleton, 'Hips', 0, 1);
    const spine = bone(hips, 'Spine', 0, .1), spine1 = bone(spine, 'Spine1', 0, .1), spine2 = bone(spine1, 'Spine2', 0, .1);
    const neck = bone(spine2, 'Neck', 0, .1); bone(neck, 'Head', 0, .1);
    const ankles = [];
    for (const [side, x] of [['Left', -.12], ['Right', .12]] as const) {
        const thigh = bone(hips, `${side}UpLeg`, x, 0);
        const shin = bone(thigh, `${side}Leg`, 0, -.43, .15);
        const foot = bone(shin, `${side}Foot`, 0, -.43, -.15);
        bone(foot, `${side}ToeBase`, 0, -.05, .12); ankles.push(foot);
        const shoulder = bone(spine2, `${side}Shoulder`, x, 0);
        const arm = bone(shoulder, `${side}Arm`, x, 0);
        const forearm = bone(arm, `${side}ForeArm`, x * 2, 0); bone(forearm, `${side}Hand`, x * 2, 0);
    }
    frame.updateMatrixWorld(true);
    const loader = new CharacterLoader({ scene } as unknown as EngineLike);
    loader.setCharacterGroup(frame); loader.createBlockCharacter(skeleton, bitmagicCharacterFactory); loader.setFeetOffset(-.875);
    const renderer = loader.getBlockCharacterRenderer()!, root = renderer.getRoot();
    const update = () => { loader.updateBlockCharacter(frame.getWorldPosition(new THREE.Vector3())); root.updateMatrixWorld(true); };
    return { scene, frame, hips, ankles, loader, renderer, root, update };
}

const y = (node: THREE.Object3D) => node.getWorldPosition(new THREE.Vector3()).y;

describe('block body/foot grounding separation', () => {
    it('ankle-only rotations do not move the torso, while shoes clear the ground through the legs', () => {
        const r = fixture();
        r.update(); const torso = r.renderer.getBodyPart('torso')!, before = y(torso), anchor = r.frame.position.clone();
        // Change the rendered ankle after normal posing, isolating the exact
        // geometric corner sweep that used to lift the whole body by 12 cm.
        const update = r.renderer.update.bind(r.renderer);
        let angle = 0;
        jest.spyOn(r.renderer, 'update').mockImplementation(pose => {
            update(pose);
            for (const side of ['left', 'right']) r.renderer.getBodyPart(`${side}Foot`)!.rotation.x = -Math.PI / 2 + angle;
        });
        for (let deg = -60; deg <= 60; deg++) {
            angle = THREE.MathUtils.degToRad(deg); r.update();
            expect(y(torso)).toBeCloseTo(before, 9);
            expect(r.frame.position).toEqual(anchor);
            for (const side of ['left', 'right']) {
                const foot = r.renderer.getBodyPart(`${side}Foot`)!;
                expect(foot.getWorldQuaternion(new THREE.Quaternion()).angleTo(new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2 + angle, 0, 0)))).toBeLessThan(1e-6);
                expect(computeCharacterBodyBox(foot, new THREE.Box3()).min.y).toBeGreaterThan(-1e-5);
            }
        }
        r.loader.dispose();
    });

    it('does not accumulate root offsets after repeated renders, and follows physical steps immediately', () => {
        const r = fixture(); r.update(); r.update();
        const before = r.root.position.y, torso = r.renderer.getBodyPart('torso')!, bodyY = y(torso);
        for (let i = 0; i < 1000; i++) r.update();
        expect(r.root.position.y).toBeCloseTo(before, 10);
        r.frame.position.y += .4; r.update();
        expect(y(torso) - bodyY).toBeCloseTo(.4, 10);
        expect(r.root.rotation.x).toBe(0); expect(r.root.rotation.z).toBe(0);
        r.loader.dispose();
    });

    it('preserves source hip movement and true flight instead of dragging tucked legs back to ground', () => {
        const r = fixture(); r.update();
        const torso = r.renderer.getBodyPart('torso')!, before = y(torso);
        r.hips.position.y += .2; r.update();
        expect(y(torso) - before).toBeCloseTo(.2, 9);
        for (const side of ['left', 'right']) expect(computeCharacterBodyBox(r.renderer.getBodyPart(`${side}Foot`)!, new THREE.Box3()).min.y).toBeGreaterThan(.19);
        r.loader.dispose();
    });

    it('ignores entire nested attachment subtrees when measuring soles or body bounds', () => {
        const r = fixture(); r.update();
        r.loader.recomputeBlockFeetOffset(); r.loader.setFeetOffset(-.875); r.update();
        const foot = r.renderer.getBodyPart('leftFoot')!, before = computeCharacterBodyBox(r.root, new THREE.Box3()).clone();
        const attachment = new THREE.Group(); attachment.userData.isUserAttached = true;
        const nested = new THREE.Group(), weapon = new THREE.Mesh(new THREE.BoxGeometry(.1, 20, .1));
        nested.add(weapon); attachment.add(nested); foot.add(attachment);
        r.loader.recomputeBlockFeetOffset(); r.loader.setFeetOffset(-.875); r.update();
        const after = computeCharacterBodyBox(r.root, new THREE.Box3());
        expect(after.min.distanceTo(before.min)).toBeLessThan(1e-8);
        expect(after.max.distanceTo(before.max)).toBeLessThan(1e-8);
        r.loader.dispose(); weapon.geometry.dispose();
    });

    it('leaves held poses and externally attached or detached legs authoritative', () => {
        const r = fixture(); r.update(); const before = r.root.position.y;
        r.renderer.setPoseOverride({ parts: new Map(), weight: 1, preserveFeet: true, preserveRootHeight: true, armTarget: null });
        for (let i = 0; i < 5; i++) r.update();
        expect(r.root.position.y).toBeCloseTo(before, 10);
        expect(r.renderer.canGroundLeg('left')).toBe(false);
        r.renderer.clearPoseOverride();
        const target = new THREE.Group(); r.scene.add(target);
        r.renderer.setAttachmentOverride('leftFoot', target, new THREE.Vector3(), new THREE.Euler());
        expect(r.renderer.canGroundLeg('left')).toBe(false);
        expect(r.renderer.canGroundLeg('right')).toBe(true);
        r.loader.dispose();
    });

    it('does not recalibrate the physics feet offset from a mid-stride pose or render-root shift', () => {
        const r = fixture(), before = r.loader.getBlockFeetOffset();
        r.hips.position.y += .25; r.update();
        for (let i = 0; i < 5; i++) { r.loader.recomputeBlockFeetOffset(); r.update(); }
        expect(r.loader.getBlockFeetOffset()).toBeCloseTo(before, 9);
        r.loader.dispose();
    });

    it('keeps a partial held pose in a bounded root frame when it does not hold root height', () => {
        const r = fixture(); r.update(); const before = r.root.position.y;
        r.renderer.setPoseOverride({ parts: new Map(), weight: 1, preserveFeet: true, preserveRootHeight: false, armTarget: null });
        r.update(); const foot = r.renderer.getBodyPart('leftFoot')!, footY = y(foot);
        for (let i = 0; i < 100; i++) r.update();
        expect(r.root.position.y).toBeCloseTo(before, 9);
        expect(y(foot)).toBeCloseTo(footY, 9);
        r.loader.dispose();
    });
});
