/**
 * A held pose has to survive the thing it is layered on top of: the animation
 * re-poses every block each frame, and the loader re-aligns the whole body to
 * the ground after that. Posing parts by hand loses to both — the offset is
 * re-applied onto last frame's result and the lean deepens, the changed
 * silhouette drags the feet-align and the character sinks, and an arm posed
 * bone by bone leaves its partner behind.
 *
 * These tests pin the four properties that make the override safe to hold for
 * minutes at a time: repeated application does not drift, the height does not
 * move, an arm the pose does not own keeps animating, and release puts every
 * captured part back exactly where it was.
 */
import * as THREE from 'three';
import { BlockCharacterRenderer } from 'engine/BlockCharacterRenderer.js';
import type { IBlockCharacterFactory } from 'engine/IBlockCharacterFactory.js';
import { NpcPoseOverrideHandle, DEFAULT_NPC_POSE_OVERRIDE_OPTIONS } from 'engine/npc/core/NpcPoseOverride.js';

const PART_NAMES = [
    'head', 'neck', 'torso',
    'leftUpperArm', 'leftForearm', 'leftHand',
    'rightUpperArm', 'rightForearm', 'rightHand',
    'leftThigh', 'leftShin', 'leftFoot',
    'rightThigh', 'rightShin', 'rightFoot',
];

/** Minimal Mixamo-named rig: enough bones for every body-part binding to resolve. */
function makeSkeleton(): { root: THREE.Object3D; bones: Map<string, THREE.Bone> } {
    const bones = new Map<string, THREE.Bone>();
    const bone = (name: string, parent: THREE.Object3D, x: number, y: number, z: number): THREE.Bone => {
        const b = new THREE.Bone();
        b.name = name;
        b.position.set(x, y, z);
        parent.add(b);
        bones.set(name, b);
        return b;
    };

    const root = new THREE.Object3D();
    root.name = 'skeletonRoot';
    const hips = bone('mixamorigHips', root, 0, 1.0, 0);
    const spine = bone('mixamorigSpine', hips, 0, 0.25, 0);
    const neck = bone('mixamorigNeck', spine, 0, 0.35, 0);
    bone('mixamorigHead', neck, 0, 0.15, 0);

    for (const side of ['Left', 'Right'] as const) {
        const dir = side === 'Left' ? 1 : -1;
        const shoulder = bone(`mixamorig${side}Shoulder`, spine, 0.08 * dir, 0.3, 0);
        const arm = bone(`mixamorig${side}Arm`, shoulder, 0.12 * dir, 0, 0);
        const foreArm = bone(`mixamorig${side}ForeArm`, arm, 0, -0.28, 0);
        bone(`mixamorig${side}Hand`, foreArm, 0, -0.26, 0);

        const upLeg = bone(`mixamorig${side}UpLeg`, hips, 0.1 * dir, -0.05, 0);
        const leg = bone(`mixamorig${side}Leg`, upLeg, 0, -0.45, 0);
        bone(`mixamorig${side}Foot`, leg, 0, -0.45, 0);
    }

    root.updateMatrixWorld(true);
    return { root, bones };
}

/** Factory that drops one small box into every body-part group. */
function makeFactory(): IBlockCharacterFactory {
    return {
        createBlockCharacter(characterGroup: THREE.Group): void {
            for (const name of PART_NAMES) {
                const group = characterGroup.getObjectByName(name) as THREE.Group;
                group.add(new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.15, 0.15)));
            }
        },
        getCharacterDimensions() {
            return { width: 0.5, height: 1.7, depth: 0.3 };
        },
    };
}

interface Rig {
    renderer: BlockCharacterRenderer;
    skeleton: THREE.Object3D;
    bones: Map<string, THREE.Bone>;
    part(name: string): THREE.Group;
}

function makeRig(): Rig {
    const { root, bones } = makeSkeleton();
    const renderer = BlockCharacterRenderer.create(root, makeFactory());
    // The loader parks the block root at the character before posing; give it a
    // height so the root-height lock has something non-trivial to preserve.
    renderer.getRoot().position.set(0, 1.5, 0);
    renderer.update();
    return {
        renderer,
        skeleton: root,
        bones,
        part: (name: string) => renderer.getRoot().getObjectByName(name) as THREE.Group,
    };
}

function acquire(rig: Rig, parts: string[], options: { preserveRootHeight?: boolean; preserveFeet?: boolean } = {}): NpcPoseOverrideHandle {
    return new NpcPoseOverrideHandle(
        rig.renderer,
        { ...DEFAULT_NPC_POSE_OVERRIDE_OPTIONS, parts, ...options },
        () => { /* controller bookkeeping, not under test */ },
    );
}

/** Every body part's local transform, for exact before/after comparison. */
function snapshotAllParts(rig: Rig): Map<string, { position: THREE.Vector3; quaternion: THREE.Quaternion }> {
    const out = new Map<string, { position: THREE.Vector3; quaternion: THREE.Quaternion }>();
    for (const name of PART_NAMES) {
        const group = rig.part(name);
        out.set(name, { position: group.position.clone(), quaternion: group.quaternion.clone() });
    }
    return out;
}

const LEAN = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.35);

/**
 * Component-wise quaternion comparison. `angleTo` goes through acos near 1,
 * where a last-bit difference reads as ~1e-8 of angle, so it cannot tell "held
 * perfectly still" from "drifting slowly".
 */
function expectSameRotation(actual: THREE.Quaternion, expected: THREE.Quaternion): void {
    expect(actual.x).toBeCloseTo(expected.x, 12);
    expect(actual.y).toBeCloseTo(expected.y, 12);
    expect(actual.z).toBeCloseTo(expected.z, 12);
    expect(actual.w).toBeCloseTo(expected.w, 12);
}

describe('pose override — repeated application', () => {
    test('holding the same offset every frame reproduces the same pose', () => {
        const rig = makeRig();
        const upright = rig.part('torso').quaternion.clone();

        const pose = acquire(rig, ['torso', 'neck', 'head']);
        pose.setPartOffset('torso', { rotation: LEAN });
        rig.renderer.update();

        const leaned = rig.part('torso').quaternion.clone();
        // The lean must actually be visible, or "stable" would mean "does nothing".
        expect(leaned.angleTo(upright)).toBeCloseTo(0.35, 5);

        // 60 frames of the same offset: an offset composed onto the previous
        // frame instead of onto the captured base pose would be 60x deeper here.
        for (let i = 0; i < 60; i++) rig.renderer.update();
        expectSameRotation(rig.part('torso').quaternion, leaned);
        expect(rig.part('torso').quaternion.angleTo(upright)).toBeCloseTo(0.35, 5);
    });

    test('a position offset is absolute, not cumulative', () => {
        const rig = makeRig();
        const base = rig.part('head').position.clone();

        const pose = acquire(rig, ['head']);
        pose.setPartOffset('head', { position: new THREE.Vector3(0, 0, 0.12) });
        for (let i = 0; i < 30; i++) rig.renderer.update();

        expect(rig.part('head').position.distanceTo(base.clone().add(new THREE.Vector3(0, 0, 0.12)))).toBeLessThan(1e-9);
    });

    test('weight blends part-way and stays there', () => {
        const rig = makeRig();
        const upright = rig.part('torso').quaternion.clone();

        const pose = acquire(rig, ['torso']);
        pose.setPartOffset('torso', { rotation: LEAN });
        pose.setWeight(0.5);
        for (let i = 0; i < 20; i++) rig.renderer.update();

        // Half the lean, and still half after twenty frames — a blend applied to
        // its own output would have converged onto the full lean by now.
        expect(rig.part('torso').quaternion.angleTo(upright)).toBeCloseTo(0.175, 5);
    });
});

describe('pose override — height and feet', () => {
    test('the held height ignores the posed silhouette and follows the ground', () => {
        const rig = makeRig();
        expect(rig.renderer.resolvePoseOverrideRootY(1.0)).toBeNull();

        const lowestBefore = new THREE.Box3().setFromObject(rig.renderer.getRoot()).min.y;

        // A seated pose: leaning forward with the feet up off the floor.
        const pose = acquire(rig, ['torso', 'leftFoot', 'rightFoot'], { preserveRootHeight: true });
        pose.setPartOffset('torso', { rotation: LEAN });
        pose.setPartOffset('leftFoot', { position: new THREE.Vector3(0, 0.18, 0.1) });
        pose.setPartOffset('rightFoot', { position: new THREE.Vector3(0, 0.18, 0.1) });
        rig.renderer.update();
        rig.renderer.getRoot().updateMatrixWorld(true);

        // The lowest block rose, so the loader's feet-alignment — which puts the
        // lowest block on the ground — would drop the whole body by that much:
        // the character visibly sinks into the stool the moment it is posed.
        const lowestAfter = new THREE.Box3().setFromObject(rig.renderer.getRoot()).min.y;
        expect(lowestAfter - lowestBefore).toBeGreaterThan(0.1);

        // Instead the root keeps the height it was installed at (1.5 over a
        // ground of 1.0) — and still tracks the ground when the character moves.
        expect(rig.renderer.resolvePoseOverrideRootY(1.0)).toBeCloseTo(1.5, 10);
        expect(rig.renderer.resolvePoseOverrideRootY(2.25)).toBeCloseTo(2.75, 10);
    });

    test('preserveRootHeight: false leaves the ordinary feet-alignment alone', () => {
        const rig = makeRig();
        const pose = acquire(rig, ['torso'], { preserveRootHeight: false });
        pose.setPartOffset('torso', { rotation: LEAN });
        rig.renderer.update();

        expect(rig.renderer.resolvePoseOverrideRootY(1.0)).toBeNull();
    });

    test('preserved feet stay put while the animation moves the leg', () => {
        const rig = makeRig();
        const plantedLeft = rig.part('leftFoot').position.clone();
        const plantedRight = rig.part('rightFoot').position.clone();

        acquire(rig, ['torso'], { preserveFeet: true });
        rig.renderer.update();

        rig.bones.get('mixamorigLeftLeg')!.position.y -= 0.3;
        rig.skeleton.updateMatrixWorld(true);
        rig.renderer.update();

        expect(rig.part('leftFoot').position.distanceTo(plantedLeft)).toBeLessThan(1e-9);
        expect(rig.part('rightFoot').position.distanceTo(plantedRight)).toBeLessThan(1e-9);
    });

    test('preserveFeet: false lets the feet follow the animation', () => {
        const rig = makeRig();
        const before = rig.part('leftFoot').position.clone();

        acquire(rig, ['torso'], { preserveFeet: false });
        rig.bones.get('mixamorigLeftLeg')!.position.y -= 0.3;
        rig.skeleton.updateMatrixWorld(true);
        rig.renderer.update();

        expect(rig.part('leftFoot').position.distanceTo(before)).toBeGreaterThan(0.2);
    });
});

describe('pose override — one arm only', () => {
    test('the targeted hand reaches while the other arm keeps animating', () => {
        const rig = makeRig();
        const leftHandBefore = rig.part('leftHand').position.clone();
        const rightHandBefore = rig.part('rightHand').getWorldPosition(new THREE.Vector3());

        const target = new THREE.Vector3(-0.1, 1.55, 0.35); // beside the mouth
        const pose = acquire(rig, ['torso', 'neck', 'head']);
        pose.setHandTarget('right', target);
        rig.renderer.update();

        // The right hand travelled most of the way to the target (the chain puts
        // the hand block at 90% of the shoulder→target line).
        const rightHandAfter = rig.part('rightHand').getWorldPosition(new THREE.Vector3());
        expect(rightHandAfter.distanceTo(target)).toBeLessThan(rightHandBefore.distanceTo(target) * 0.25);

        // The left arm was never claimed: it still follows its bones.
        expect(rig.part('leftHand').position.distanceTo(leftHandBefore)).toBeLessThan(1e-9);
        rig.bones.get('mixamorigLeftForeArm')!.position.x += 0.4;
        rig.skeleton.updateMatrixWorld(true);
        rig.renderer.update();
        expect(rig.part('leftHand').position.distanceTo(leftHandBefore)).toBeGreaterThan(0.2);

        // …and the reaching hand did not drift while the other arm moved.
        expect(rig.part('rightHand').getWorldPosition(new THREE.Vector3()).distanceTo(rightHandAfter)).toBeLessThan(1e-9);
    });

    test('clearing the hand target hands the arm back to the animation', () => {
        const rig = makeRig();
        const restingHand = rig.part('rightHand').position.clone();

        const pose = acquire(rig, ['torso']);
        pose.setHandTarget('right', new THREE.Vector3(-0.1, 1.55, 0.35));
        rig.renderer.update();
        expect(rig.part('rightHand').position.distanceTo(restingHand)).toBeGreaterThan(0.1);

        pose.clearHandTarget();
        rig.renderer.update();
        expect(rig.part('rightHand').position.distanceTo(restingHand)).toBeLessThan(1e-9);
    });
});

describe('pose override — release', () => {
    test('release restores every captured part exactly and drops the height lock', () => {
        const rig = makeRig();
        const before = snapshotAllParts(rig);

        const pose = acquire(rig, ['torso', 'neck', 'head']);
        pose.setPartOffset('torso', { rotation: LEAN });
        pose.setPartOffset('head', { position: new THREE.Vector3(0, 0, 0.2) });
        pose.setHandTarget('right', new THREE.Vector3(-0.1, 1.55, 0.35));
        for (let i = 0; i < 5; i++) rig.renderer.update();

        pose.release();

        for (const [name, base] of before) {
            const group = rig.part(name);
            expect(group.position.distanceTo(base.position)).toBeLessThan(1e-9);
            expect(group.quaternion.angleTo(base.quaternion)).toBeLessThan(1e-9);
        }
        expect(rig.renderer.hasPoseOverride()).toBe(false);
        expect(rig.renderer.resolvePoseOverrideRootY(1.0)).toBeNull();
        expect(pose.isActive()).toBe(false);

        // And the animation owns the parts again from the next frame.
        rig.bones.get('mixamorigSpine')!.position.x += 0.3;
        rig.skeleton.updateMatrixWorld(true);
        rig.renderer.update();
        expect(rig.part('torso').position.distanceTo(before.get('torso')!.position)).toBeGreaterThan(0.2);
    });

    test('release is idempotent and a released handle refuses further posing', () => {
        const rig = makeRig();
        const pose = acquire(rig, ['torso']);
        rig.renderer.update();

        pose.release();
        pose.release();

        expect(() => pose.setPartOffset('torso', { rotation: LEAN })).toThrow(/released/);
        expect(() => pose.setWeight(0.5)).toThrow(/released/);
    });

    test('disposing the renderer releases the pose', () => {
        const rig = makeRig();
        acquire(rig, ['torso']);
        rig.renderer.update();

        rig.renderer.dispose();
        expect(rig.renderer.hasPoseOverride()).toBe(false);
    });

    test('offsetting a part the override does not own is a hard error', () => {
        const rig = makeRig();
        const pose = acquire(rig, ['torso']);
        // Silently ignoring this would leave the caller staring at an NPC whose
        // arm never moved, with nothing to grep for.
        expect(() => pose.setPartOffset('leftHand', { rotation: LEAN })).toThrow(/not owned/);
    });
});
