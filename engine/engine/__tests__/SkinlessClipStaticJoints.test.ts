import * as THREE from 'three';
import { CharacterAnimationController } from 'engine/CharacterAnimationController.js';
import { MixamoAnimationPlayer } from 'engine/MixamoAnimationPlayer.js';
import { CharacterLoader } from 'engine/loaders/CharacterLoader.js';
import type { AnimationContext } from 'engine/animation/AnimationContext.js';
import type { EngineLike } from 'types/game.js';

/**
 * A clip GLB without a skin gives its nodes no bone flag, and an exporter that drops constant
 * tracks (Uthana does) gives a joint the motion never turns no track either. Such a joint used
 * to be missing from the clip skeleton, so the character's bone of that name fell through to
 * CharacterLoader.resolveMixamoBone's substring rule and took ANOTHER bone's pose. Measured on a
 * skinned hero, 2026-09-18: Uthana's walk never turns `Spine2`; the rig's `mixamorigSpine2`
 * matched the clip's `mixamorigSpine`, and the chest bent 5.7 degrees back against Spine1 on
 * every stride while the neck made up the difference.
 */

const q = (x = 0, y = 0, z = 0) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z));
const IDENTITY = new THREE.Quaternion();
/** Degrees between two rotations, from the relative rotation's vector part (acos near 1 has a 0.02° floor on float32 keys). */
function degreesBetween(a: THREE.Quaternion, b: THREE.Quaternion): number {
    const relative = a.clone().normalize().invert().multiply(b.clone().normalize());
    return THREE.MathUtils.radToDeg(2 * Math.asin(Math.min(1, Math.hypot(relative.x, relative.y, relative.z))));
}

/** MIXAMO_DEFAULT_HEIGHT, so a player loads at scale 1. */
const HEIGHT = 1.75;
type Joint = { name: string; parent: string | null; at: [number, number, number] };
const legs = (['Left', 'Right'] as const).flatMap((side): Joint[] => {
    const x = side === 'Left' ? 0.09 : -0.09;
    return [
        { name: `${side}UpLeg`, parent: 'Hips', at: [x, 0.94, 0] },
        { name: `${side}Leg`, parent: `${side}UpLeg`, at: [x, 0.5, 0] },
        { name: `${side}Foot`, parent: `${side}Leg`, at: [x, 0.08, 0] },
    ];
});
/** World rest positions in metres; every joint rests at the world axes, as the canonical skeleton's rotations are irrelevant here. */
const LAYOUT: Joint[] = [
    { name: 'Hips', parent: null, at: [0, 1, 0] },
    { name: 'Spine', parent: 'Hips', at: [0, 1.1, 0] },
    { name: 'Spine1', parent: 'Spine', at: [0, 1.22, 0] },
    { name: 'Spine2', parent: 'Spine1', at: [0, 1.34, 0] },
    { name: 'Neck', parent: 'Spine2', at: [0, 1.5, 0] },
    { name: 'Head', parent: 'Neck', at: [0, 1.58, 0] },
    { name: 'HeadTop_End', parent: 'Head', at: [0, 1.75, 0] },
    { name: 'LeftArm', parent: 'Spine2', at: [0.16, 1.46, 0] },
    { name: 'LeftHand', parent: 'LeftArm', at: [0.7, 1.46, 0] },
    { name: 'LeftHandIndex1', parent: 'LeftHand', at: [0.78, 1.46, 0] },
    { name: 'LeftHandIndex2', parent: 'LeftHandIndex1', at: [0.81, 1.46, 0] },
    ...legs,
];
/** The joints Uthana-style export leaves without a track: the chest, and limbs the motion never poses. */
const UNTRACKED = new Set(['Spine2', 'HeadTop_End', 'LeftHandIndex1', 'LeftHandIndex2']);

/** How far each joint is turned from rest, in the character's frame. `lean` separates the two clips. */
function motion(joint: string, t: number, lean: number): THREE.Quaternion {
    const s = Math.sin(t * Math.PI * 2);
    switch (joint) {
        case 'Spine': return q(lean * 0.3, 0.1 * s, 0);
        // The chest and everything above ride Spine1: a joint without a track adds nothing of its own.
        case 'Spine1': case 'Spine2': return q(lean * 0.3, 0.1 * s, 0).multiply(q(lean * 0.4 + 0.12 * s, 0.25 * s, 0));
        case 'Neck': case 'Head': case 'HeadTop_End':
            return q(lean * 0.3, 0.1 * s, 0).multiply(q(lean * 0.4 + 0.12 * s, 0.25 * s, 0)).multiply(q(0.2, -0.3 * s, 0));
        case 'LeftArm': return q(0, 0, -1.1).multiply(q(0.5 * s + lean, 0, 0));
        case 'LeftHand': case 'LeftHandIndex1': case 'LeftHandIndex2': return q(0, 0, -1.1).multiply(q(0.5 * s + lean, 0.4, 0));
        default: return IDENTITY.clone();
    }
}

/**
 * A clip as GLTFLoader yields it from a GLB WITHOUT a skin — plain Object3D nodes under an
 * armature node — whose clip carries tracks for `tracked` joints only. `skinned: true` builds
 * the same skeleton out of Bones, as a clip GLB with a skin loads.
 */
function clipPlayer(character: THREE.Object3D, opts: { lean: number; untracked?: ReadonlySet<string>; skinned?: boolean }): MixamoAnimationPlayer {
    const untracked = opts.untracked ?? new Set<string>();
    const scene = new THREE.Group();
    const armature = new THREE.Object3D();
    armature.name = 'Armature';
    scene.add(armature);
    const nodes = new Map<string, THREE.Object3D>();
    for (const joint of LAYOUT) {
        const node = opts.skinned ? new THREE.Bone() : new THREE.Object3D();
        node.name = `mixamorig${joint.name}`;
        const parent = joint.parent ? LAYOUT.find(j => j.name === joint.parent)! : null;
        node.position.set(...joint.at).sub(new THREE.Vector3(...(parent?.at ?? [0, 0, 0]))).multiplyScalar(100);
        (joint.parent ? nodes.get(joint.parent)! : armature).add(node);
        nodes.set(joint.name, node);
    }
    const keys = 8;
    const times = Array.from({ length: keys + 1 }, (_, k) => k / keys);
    const tracks = LAYOUT.filter(joint => !untracked.has(joint.name)).map((joint) => {
        const values = times.flatMap((t) => {
            const parent = joint.parent ? motion(joint.parent, t, opts.lean) : IDENTITY;
            return parent.clone().invert().multiply(motion(joint.name, t, opts.lean)).toArray();
        });
        return new THREE.QuaternionKeyframeTrack(`mixamorig${joint.name}.quaternion`, times, values);
    });
    const player = new MixamoAnimationPlayer();
    expect(player.loadFromGLTF(scene, [new THREE.AnimationClip('motion', 1, tracks)], new THREE.Scene(), character, HEIGHT,
        { retainFullSkeleton: true })).toBe(true);
    player.setLoop(true);
    player.play(undefined, 0, 0);
    return player;
}

function poseAt(player: MixamoAnimationPlayer, t: number): void {
    player.setTime(t);
    player.syncSkeletonToPlayer();
}

/** A skinned rig bound in the clips' own rest pose, with one joint no clip has (a face joint under the head). */
function skinnedRig(): { root: THREE.Group; bones: Map<string, THREE.Bone> } {
    const root = new THREE.Group();
    const bones = new Map<string, THREE.Bone>();
    for (const joint of [...LAYOUT, { name: 'FaceJaw', parent: 'Head', at: [0, 1.6, 0.08] } as Joint]) {
        const bone = new THREE.Bone();
        bone.name = joint.name === 'FaceJaw' ? 'FaceFit_jaw' : `mixamorig${joint.name}`;
        const parent = joint.parent ? LAYOUT.find(j => j.name === joint.parent)! : null;
        bone.position.set(...joint.at).sub(new THREE.Vector3(...(parent?.at ?? [0, 0, 0])));
        (joint.parent ? bones.get(joint.parent)! : root).add(bone);
        bones.set(joint.name, bone);
    }
    root.updateMatrixWorld(true);
    const ordered = [...bones.values()];
    const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    mesh.bind(new THREE.Skeleton(ordered, ordered.map(b => b.matrixWorld.clone().invert())), new THREE.Matrix4());
    root.add(mesh);
    return { root, bones };
}

class TestLoader extends CharacterLoader {
    constructor(controller: CharacterAnimationController, character: THREE.Group, rig: THREE.Group) {
        super({ scene: new THREE.Scene() } as unknown as EngineLike);
        this.setCharacterGroup(character);
        this.setSkinnedSkeletonRoot(rig);
        this.setAnimationController(controller);
    }
}

function stage() {
    const character = new THREE.Group();
    character.position.set(-3, 1, 5);
    character.rotation.y = -0.6;
    const rig = skinnedRig();
    character.add(rig.root);
    character.updateMatrixWorld(true);
    const controller = new CharacterAnimationController();
    const ctx = (controller as unknown as { ctx: AnimationContext }).ctx;
    const loader = new TestLoader(controller, character, rig.root);
    const facing = character.getWorldQuaternion(new THREE.Quaternion());
    const pose = (frames = 1) => { for (let i = 0; i < frames; i++) loader.updateSkinnedCharacter(character.position); };
    /** Degrees the rig's `joint` is turned away from its bind rotation RELATIVE TO ITS PARENT. */
    const bend = (joint: string) => degreesBetween(IDENTITY, rig.bones.get(joint)!.quaternion);
    /** Degrees between the rig's `joint` and where `motion` puts it. */
    const off = (joint: string, t: number, lean: number) => degreesBetween(
        rig.bones.get(joint)!.getWorldQuaternion(new THREE.Quaternion()), facing.clone().multiply(motion(joint, t, lean)));
    return { character, ctx, controller, pose, bend, off };
}

describe('joints a skinless clip leaves without a track', () => {
    it('are part of the clip skeleton when they sit between animated joints, and only then', () => {
        const player = clipPlayer(new THREE.Group(), { lean: 0, untracked: UNTRACKED });
        const bones = player.getBoneMap();
        expect(bones.has('mixamorigSpine2')).toBe(true);
        expect(player.getRestRotations().has('mixamorigSpine2')).toBe(true);
        // Still limbs the clip does not pose are left to resolve as they always did, and the
        // armature above the hips is no joint.
        for (const name of ['mixamorigHeadTop_End', 'mixamorigLeftHandIndex1', 'mixamorigLeftHandIndex2', 'Armature']) {
            expect(bones.has(name)).toBe(false);
        }
        expect(bones.size).toBe(LAYOUT.length - 3);
    });

    it('count as posed by the clip: held still on purpose, unlike a limb it never touches', () => {
        const skinless = clipPlayer(new THREE.Group(), { lean: 0, untracked: UNTRACKED });
        expect(skinless.getAnimatedBoneNames().has('mixamorigSpine2')).toBe(false);
        expect(skinless.getPosedBoneNames().has('mixamorigSpine2')).toBe(true);
        expect(skinless.getPosedBoneNames().size).toBe(skinless.getAnimatedBoneNames().size + 1);
        // The same holds for a clip WITH a skin, whose still bones were always registered.
        const skinned = clipPlayer(new THREE.Group(), { lean: 0, untracked: UNTRACKED, skinned: true });
        expect(skinned.getBoneMap().has('mixamorigLeftHandIndex1')).toBe(true);
        expect(skinned.getPosedBoneNames().has('mixamorigSpine2')).toBe(true);
        for (const limb of ['mixamorigHeadTop_End', 'mixamorigLeftHandIndex1', 'mixamorigLeftHandIndex2']) {
            expect(skinned.getPosedBoneNames().has(limb)).toBe(false);
        }
    });

    it.each([0, 0.125, 0.25, 0.625, 0.875])('keep their rest rotation against their parent on a skinned rig at t=%s', (t) => {
        const { character, ctx, controller, pose, bend, off } = stage();
        const walk = clipPlayer(character, { lean: 0, untracked: UNTRACKED });
        ctx.trackAMixamoPlayer = walk; poseAt(walk, t);
        pose();
        // The lower spine and the chest's parent really do turn differently at this frame...
        if (t !== 0) expect(bend('Spine1')).toBeGreaterThan(3);
        // ...and the chest adds nothing to its parent, exactly as the clip has it.
        expect(bend('Spine2')).toBeLessThan(0.01);
        for (const joint of ['Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'LeftArm', 'LeftHand']) expect(off(joint, t, 0)).toBeLessThan(0.01);
        controller.dispose();
    });

    it.each([
        // The spine ramps from the locomotion to the action, so only its top joint is all action.
        { mask: { upperBody: 1, lowerBody: 0 }, allAction: ['Spine2', 'Neck', 'Head'] },
        { mask: { upperBody: 1, lowerBody: 1 }, allAction: ['Spine', 'Spine1', 'Spine2', 'Neck', 'Head'] },
    ])('stay with their own clip under a body mask, not with the locomotion beneath it ($mask.upperBody/$mask.lowerBody)', ({ mask, allAction }) => {
        const { character, ctx, controller, pose, bend, off } = stage();
        // Locomotion animates every joint, the chest included; the action leans hard and leaves the chest still.
        const locomotion = clipPlayer(character, { lean: 0 });
        const action = clipPlayer(character, { lean: 1, untracked: UNTRACKED });
        poseAt(locomotion, 0.25); poseAt(action, 0.25);
        ctx.trackAMixamoPlayer = locomotion;
        pose();
        ctx.trackBMixamoPlayer = action; ctx.trackBlend = mask;
        pose(12);
        // Handing the chest to the locomotion would leave it upright between a leaning Spine1 and neck.
        for (const joint of allAction) expect(off(joint, 0.25, 1)).toBeLessThan(0.01);
        if (mask.lowerBody === 1) expect(bend('Spine2')).toBeLessThan(0.01);
        controller.dispose();
    });

    it('a rig joint NO clip skeleton has keeps its bind rotation under its parent, on one track and on two', () => {
        // A hero carries 80 face joints under its head that no clip knows. Two tracks used to blend
        // the standard skeleton's stand-in for both sides — the joint's REST orientation in the world
        // — so the face counter-turned whenever an action turned the head.
        const { character, ctx, controller, pose, bend } = stage();
        const locomotion = clipPlayer(character, { lean: 0 });
        const action = clipPlayer(character, { lean: 1, untracked: UNTRACKED });
        poseAt(locomotion, 0.25); poseAt(action, 0.25);
        ctx.trackAMixamoPlayer = locomotion;
        pose();
        expect(bend('FaceJaw')).toBeLessThan(0.01);
        ctx.trackBMixamoPlayer = action; ctx.trackBlend = { upperBody: 1, lowerBody: 1 };
        pose(12);
        expect(bend('FaceJaw')).toBeLessThan(0.01);
        controller.dispose();
    });
});
