import * as THREE from 'three';
import { CharacterAnimationController } from 'engine/CharacterAnimationController.js';
import { MixamoAnimationPlayer } from 'engine/MixamoAnimationPlayer.js';
import { CharacterLoader } from 'engine/loaders/CharacterLoader.js';
import { SkinnedRetargetSpace } from 'engine/loaders/SkinnedRigRetarget.js';
import type { AnimationContext } from 'engine/animation/AnimationContext.js';
import type { EngineLike } from 'types/game.js';

/**
 * A skinned rig must show the same motion whichever rest pose the clip's own
 * skeleton has. The engine's library clips all rest in the canonical pose, but a
 * clip retargeted onto a character's own skeleton (the Hero Motion Bench's Uthana
 * clips, 2026-09) rests like that character: arm bones rolled 90 degrees about
 * their axis, arms drooped, spine tipped, hips 15 cm lower. Such a clip used to
 * be corrected with the FIRST clip's rest — rendered wrong by exactly the
 * rest-pose difference, and hopping by the hips difference at every crossfade.
 */

const q = (x = 0, y = 0, z = 0) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z));
const IDENTITY = new THREE.Quaternion();
/**
 * Degrees between two rotations, from the relative rotation's vector part.
 * `Quaternion.angleTo` takes acos of a dot product next to 1, which turns the
 * rounding of float32 keyframes into a 0.02° floor — more than this test allows.
 */
function degreesBetween(a: THREE.Quaternion, b: THREE.Quaternion): number {
    const relative = a.clone().normalize().invert().multiply(b.clone().normalize());
    return THREE.MathUtils.radToDeg(2 * Math.asin(Math.min(1, Math.hypot(relative.x, relative.y, relative.z))));
}

/** The height clip skeletons are authored at (MIXAMO_DEFAULT_HEIGHT), so a player loads at scale 1. */
const HEIGHT = 1.75;
/** Ankle joints rest this far above the sole; grounding plants the lowest of them on the ground. */
const ANKLE = 0.08;
type Joint = { name: string; parent: string | null; at: [number, number, number] };
/** Joint layout in metres at rest, for a body whose hips sit at `hips`. */
function layout(hips: number): Joint[] {
    const legs = (['Left', 'Right'] as const).flatMap((side): Joint[] => {
        const x = side === 'Left' ? 0.09 : -0.09;
        return [
            { name: `${side}UpLeg`, parent: 'Hips', at: [x, hips - 0.06, 0] },
            { name: `${side}Leg`, parent: `${side}UpLeg`, at: [x, (hips - 0.06 + ANKLE) / 2, 0] },
            { name: `${side}Foot`, parent: `${side}Leg`, at: [x, ANKLE, 0] },
        ];
    });
    return [
        { name: 'Hips', parent: null, at: [0, hips, 0] },
        { name: 'Spine', parent: 'Hips', at: [0, hips + 0.12, 0] },
        { name: 'Spine1', parent: 'Spine', at: [0, hips + 0.26, 0] },
        { name: 'LeftArm', parent: 'Spine1', at: [0.16, 1.5, 0] },
        { name: 'LeftForeArm', parent: 'LeftArm', at: [0.44, 1.5, 0] },
        { name: 'LeftHand', parent: 'LeftForeArm', at: [0.7, 1.5, 0] },
        ...legs,
    ];
}
/** Bones the rotation assertions read; the legs are left to the grounding solve. */
const UPPER_BODY = ['Hips', 'Spine', 'Spine1', 'LeftArm', 'LeftForeArm', 'LeftHand'];

/** A skeleton: how each bone is turned at rest, and where the hips rest. */
type Rest = { turn: (bone: string) => THREE.Quaternion; hips: number };
/** The canonical clip skeleton: every bone at the world axes. */
const CANONICAL: Rest = { turn: () => IDENTITY.clone(), hips: 1.04 };
/** A character's own skeleton, as the measured hero: spine tipped 8°, arm drooped 13° and rolled 90° about its length, short legs. */
const OWN: Rest = {
    hips: 0.89,
    turn: (bone) => {
        if (bone.startsWith('Spine')) return q(THREE.MathUtils.degToRad(8));
        if (/Arm|Hand/.test(bone)) return q(0, 0, THREE.MathUtils.degToRad(-13)).multiply(q(Math.PI / 2));
        if (/Leg|Foot/.test(bone)) return q(0, 0.3, 0);
        return IDENTITY.clone();
    },
};
/** The rig's bind: neither of the above, so no clip can be applied as it is. */
const RIG: Rest = { hips: OWN.hips, turn: (bone) => OWN.turn(bone).multiply(q(0.2, -0.4, 0.1)) };

/** The motion itself: how far each bone is turned from its rest, in the character's frame, at `t` (0..1). */
function motion(bone: string, t: number): THREE.Quaternion {
    const s = Math.sin(t * Math.PI * 2), c = Math.cos(t * Math.PI * 2);
    switch (bone) {
        case 'Hips': return q(0, 0.2 * s, 0);
        case 'Spine': return q(0.15 * s, 0.2 * s, 0);
        case 'Spine1': return q(0.15 * s, 0.2 * s, 0.1 * c);
        case 'LeftArm': return q(0.5 * s, 0, 0).multiply(q(0, 0, -1.2));
        case 'LeftForeArm':
        case 'LeftHand': return q(0.5 * s, 0, 0).multiply(q(0, 0, -1.2)).multiply(q(0, -0.6 - 0.3 * c, 0));
        default: return IDENTITY.clone(); // the legs stand still, so the body's height is the hips' alone
    }
}

/** A bone hierarchy resting at `rest`, laid out in `unit`s per metre (clip skeletons are centimetres). */
function skeleton(rest: Rest, unit: number): { root: THREE.Group; bones: Map<string, THREE.Bone> } {
    const root = new THREE.Group();
    const bones = new Map<string, THREE.Bone>();
    const world = new Map<string, THREE.Matrix4>();
    for (const joint of layout(rest.hips)) {
        const bone = new THREE.Bone();
        bone.name = `mixamorig${joint.name}`;
        const matrix = new THREE.Matrix4().compose(new THREE.Vector3(...joint.at).multiplyScalar(unit), rest.turn(joint.name), new THREE.Vector3(1, 1, 1));
        const parent = joint.parent ? world.get(joint.parent)! : new THREE.Matrix4();
        parent.clone().invert().multiply(matrix).decompose(bone.position, bone.quaternion, bone.scale);
        (joint.parent ? bones.get(joint.parent)! : root).add(bone);
        bones.set(joint.name, bone);
        world.set(joint.name, matrix);
    }
    root.updateMatrixWorld(true);
    return { root, bones };
}

/** A clip player whose skeleton rests at `rest` and whose one clip is {@link motion} as that skeleton carries it. */
function clipPlayer(rest: Rest, character: THREE.Object3D, keys = 8): MixamoAnimationPlayer {
    const joints = layout(rest.hips);
    const times = Array.from({ length: keys + 1 }, (_, k) => k / keys);
    const values = new Map<string, number[]>(joints.map(joint => [joint.name, []]));
    for (const t of times) {
        const world = new Map<string, THREE.Quaternion>();
        for (const joint of joints) {
            const turned = motion(joint.name, t).multiply(rest.turn(joint.name));
            world.set(joint.name, turned);
            const parent = joint.parent ? world.get(joint.parent)! : IDENTITY;
            values.get(joint.name)!.push(...parent.clone().invert().multiply(turned).toArray());
        }
    }
    const clip = new THREE.AnimationClip('motion', 1, joints.map(joint =>
        new THREE.QuaternionKeyframeTrack(`mixamorig${joint.name}.quaternion`, times, values.get(joint.name)!)));
    const player = new MixamoAnimationPlayer();
    expect(player.loadFromGLTF(skeleton(rest, 100).root, [clip], new THREE.Scene(), character, HEIGHT, { retainFullSkeleton: true })).toBe(true);
    player.setLoop(true);
    player.play(undefined, 0, 0);
    return player;
}

/** Pose a player exactly on a keyframe, under the character. */
function poseAt(player: MixamoAnimationPlayer, t: number): void {
    player.setTime(t);
    player.syncSkeletonToPlayer();
}

function skinnedRig(): { root: THREE.Group; bones: Map<string, THREE.Bone> } {
    const { root, bones } = skeleton(RIG, 1);
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
    retarget(): SkinnedRetargetSpace { return (this as unknown as { skinnedRetarget: SkinnedRetargetSpace }).skinnedRetarget; }
}

function stage() {
    const character = new THREE.Group();
    character.position.set(4, 2, -7);
    character.rotation.y = 0.9;
    const rig = skinnedRig();
    character.add(rig.root);
    character.updateMatrixWorld(true);
    const controller = new CharacterAnimationController();
    const ctx = (controller as unknown as { ctx: AnimationContext }).ctx;
    const loader = new TestLoader(controller, character, rig.root);
    const facing = character.getWorldQuaternion(new THREE.Quaternion());
    const pose = (frames = 1) => { for (let i = 0; i < frames; i++) loader.updateSkinnedCharacter(character.position); };
    /** The rig shows {@link motion} at `t`: every bone turned from its OWN bind by exactly that much. */
    const expectMotion = (t: number, frames = 1) => {
        pose(frames);
        for (const name of UPPER_BODY) {
            const expected = facing.clone().multiply(motion(name, t)).multiply(RIG.turn(name));
            const shown = rig.bones.get(name)!.getWorldQuaternion(new THREE.Quaternion());
            expect(degreesBetween(shown, expected)).toBeLessThan(0.01);
        }
    };
    const hipsHeight = () => rig.bones.get('Hips')!.getWorldPosition(new THREE.Vector3()).y - character.position.y;
    return { character, ctx, loader, controller, pose, expectMotion, hipsHeight };
}

describe('a skinned rig under clip skeletons that rest differently', () => {
    it('the two clips really are different data for the same motion', () => {
        const character = new THREE.Group();
        const canonical = clipPlayer(CANONICAL, character), own = clipPlayer(OWN, character);
        poseAt(canonical, 0.25); poseAt(own, 0.25);
        const arm = (p: MixamoAnimationPlayer) => p.getBoneMap().get('mixamorigLeftArm')!.getWorldQuaternion(new THREE.Quaternion());
        expect(degreesBetween(arm(canonical), arm(own))).toBeGreaterThan(80);
        expect(canonical.getRestHipsOffset()!.y - own.getRestHipsOffset()!.y).toBeCloseTo(0.15, 6);
    });

    it.each([0, 0.125, 0.25, 0.5, 0.875])('shows the same motion from either clip at t=%s', (t) => {
        const { character, ctx, expectMotion, controller } = stage();
        const canonical = clipPlayer(CANONICAL, character), own = clipPlayer(OWN, character);
        ctx.trackAMixamoPlayer = canonical; poseAt(canonical, t);
        expectMotion(t);
        // The second clip to play is the one the once-only correction got wrong.
        ctx.trackAMixamoPlayer = own; poseAt(own, t);
        expectMotion(t, 12);
        controller.dispose();
    });

    it('does not depend on which clip the rig met first', () => {
        const { character, ctx, expectMotion, controller } = stage();
        const canonical = clipPlayer(CANONICAL, character), own = clipPlayer(OWN, character);
        ctx.trackAMixamoPlayer = own; poseAt(own, 0.375);
        expectMotion(0.375);
        ctx.trackAMixamoPlayer = canonical; poseAt(canonical, 0.375);
        expectMotion(0.375, 12);
        controller.dispose();
    });

    it.each([0, 0.25, 0.5, 0.75, 1])('holds the motion through a crossfade between the two at progress %s', (progress) => {
        const { character, ctx, expectMotion, controller } = stage();
        const canonical = clipPlayer(CANONICAL, character), own = clipPlayer(OWN, character);
        poseAt(canonical, 0.625); poseAt(own, 0.625);
        ctx.trackAMixamoPlayer = canonical;
        expectMotion(0.625);
        // Both sides carry the same motion, so every blend of them must too:
        // only possible when each is corrected for its own rest BEFORE the blend.
        ctx.fadingOutTrackAPlayer = canonical; ctx.trackAMixamoPlayer = own; ctx.fadingOutCrossfadeProgress = progress;
        expectMotion(0.625, 12);
        controller.dispose();
    });

    it.each([
        { upperBody: 1, lowerBody: 0 },
        { upperBody: 0.5, lowerBody: 0.5 },
        { upperBody: 1, lowerBody: 1 },
    ])('holds the motion under an action clip that rests differently (mask $upperBody/$lowerBody)', (mask) => {
        const { character, ctx, expectMotion, controller } = stage();
        const locomotion = clipPlayer(CANONICAL, character), action = clipPlayer(OWN, character);
        poseAt(locomotion, 0.125); poseAt(action, 0.125);
        ctx.trackAMixamoPlayer = locomotion;
        expectMotion(0.125);
        ctx.trackBMixamoPlayer = action; ctx.trackBlend = mask;
        expectMotion(0.125, 12);
        controller.dispose();
    });

    it('keeps the body at its height while clips whose hips rest 15 cm apart hand over', () => {
        const { character, ctx, pose, hipsHeight, controller } = stage();
        const idle = clipPlayer(CANONICAL, character), walk = clipPlayer(OWN, character);
        poseAt(idle, 0); poseAt(walk, 0);
        ctx.trackAMixamoPlayer = idle;
        pose(60);
        const standing = hipsHeight();
        expect(standing).toBeCloseTo(RIG.hips - ANKLE, 3);
        // Neither clip moves the hips, so the body must not move either — at the
        // first frame of the handover least of all, where the pose is still all
        // `idle` but the pose SOURCE has already become `walk`.
        ctx.fadingOutTrackAPlayer = idle; ctx.trackAMixamoPlayer = walk;
        for (const progress of [0, 0.1, 0.25, 0.5, 0.75, 1]) {
            ctx.fadingOutCrossfadeProgress = progress;
            pose();
            expect(hipsHeight()).toBeCloseTo(standing, 3);
        }
        ctx.fadingOutTrackAPlayer = null;
        pose(60);
        expect(hipsHeight()).toBeCloseTo(standing, 3);
        // And under a body-mask action that rests on the other skeleton.
        ctx.trackAMixamoPlayer = idle; ctx.trackBMixamoPlayer = walk; ctx.trackBlend = { upperBody: 1, lowerBody: 1 };
        pose(60);
        expect(hipsHeight()).toBeCloseTo(standing, 3);
        controller.dispose();
    });

    it('costs clips that rest alike nothing: no per-clip correction is built', () => {
        const { character, ctx, loader, expectMotion, controller } = stage();
        const idle = clipPlayer(CANONICAL, character), walk = clipPlayer(CANONICAL, character), own = clipPlayer(OWN, character);
        for (const player of [idle, walk, own]) {
            ctx.trackAMixamoPlayer = player; poseAt(player, 0.5);
            expectMotion(0.5, 12);
        }
        expect(loader.retarget().getClipCorrection(idle)).toBeNull();
        expect(loader.retarget().getClipCorrection(walk)).toBeNull();
        const correction = loader.retarget().getClipCorrection(own)!;
        expect(correction.rotations!.size).toBeGreaterThan(0);
        expect(correction.hipsShift!.y).toBeCloseTo(0.15, 6);
        // The rig's own correction is still built once, against the reference.
        expect(loader.retarget().getRigDeltas().size).toBe(layout(RIG.hips).length);
        controller.dispose();
    });
});
