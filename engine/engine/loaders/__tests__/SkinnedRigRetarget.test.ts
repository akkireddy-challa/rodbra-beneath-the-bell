import * as THREE from 'three';
import {
    authoredFootLift,
    authoredHipsSway,
    MAX_HIPS_SWAY_M,
    buildRetargetDeltas,
    captureRigBindPose,
    MAX_AUTHORED_FOOT_LIFT_M,
    ClipBoneReader,
    retargetedWorldRotation,
    SkinnedRetargetSpace,
} from 'engine/loaders/SkinnedRigRetarget.js';

/**
 * A two-bone rig (hips → foot) bound as a SkinnedMesh, with the hips bone
 * optionally bound at a rotation. Inverse bind matrices are computed from the
 * bones' transforms at bind time, the way GLTFLoader's data describes them.
 */
function makeSkinnedRig(opts: { hipsBindEuler?: [number, number, number]; hipsY?: number; footY?: number }) {
    const root = new THREE.Group();
    const hips = new THREE.Bone();
    hips.name = 'mixamorigHips';
    hips.position.set(0, opts.hipsY ?? 1, 0);
    if (opts.hipsBindEuler) hips.rotation.set(...opts.hipsBindEuler);
    const foot = new THREE.Bone();
    foot.name = 'mixamorigLeftFoot';
    foot.position.set(0, (opts.footY ?? 0.1) - (opts.hipsY ?? 1), 0);
    hips.add(foot);
    root.add(hips);
    root.updateMatrixWorld(true);

    const bones = [hips, foot];
    const inverses = bones.map((b) => b.matrixWorld.clone().invert());
    const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    mesh.bind(new THREE.Skeleton(bones, inverses), new THREE.Matrix4());
    root.add(mesh);
    return { root, hips, foot };
}

describe('captureRigBindPose', () => {
    it('reads bind rotations from the skin, not from the posed bones', () => {
        const { root, hips } = makeSkinnedRig({ hipsY: 1, footY: 0.1 });
        // Pose the bones AFTER binding — the capture must ignore this.
        hips.rotation.set(1, 0, 0);
        root.updateMatrixWorld(true);

        const bind = captureRigBindPose(root);
        expect(bind).not.toBeNull();
        expect(bind!.rotations.get('mixamorigHips')!.angleTo(new THREE.Quaternion())).toBeCloseTo(0, 6);
        expect(bind!.rotations.has('mixamorigLeftFoot')).toBe(true);
    });

    it('returns null for a rig with no skinned mesh', () => {
        const root = new THREE.Group();
        root.add(new THREE.Bone());
        expect(captureRigBindPose(root)).toBeNull();
    });
});

describe('buildRetargetDeltas', () => {
    const identity = new THREE.Quaternion();

    it('is empty for a canonical rig (bind equals the clip rest)', () => {
        const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 0.2, 0.1));
        const rig = new Map([['mixamorigHips', q.clone()]]);
        const src = new Map([['mixamorigHips', q.clone()]]);
        expect(buildRetargetDeltas(rig, src, (n) => n).size).toBe(0);
    });

    it('skips bones the clip skeleton does not have', () => {
        const rig = new Map([['extraBone', new THREE.Quaternion().setFromEuler(new THREE.Euler(1, 0, 0))]]);
        expect(buildRetargetDeltas(rig, new Map(), () => null).size).toBe(0);
    });

    it('a rig bound at a different orientation gets the same deformation the clip gave its own skeleton', () => {
        // Clip skeleton rest and rig bind differ by a 90° twist about Y.
        const srcRest = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 0, 0));
        const rigBind = srcRest.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0)));
        const deltas = buildRetargetDeltas(
            new Map([['b', rigBind]]),
            new Map([['b', srcRest]]),
            (n) => n,
        );
        expect(deltas.size).toBe(1);

        // The clip bends the bone 40° about X from its rest.
        const bend = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.7, 0, 0));
        const clipWorld = bend.clone().multiply(srcRest);
        const out = retargetedWorldRotation(clipWorld, deltas.get('b')!, new THREE.Quaternion());

        // Deformation = world × inv(bind) must match on both rigs.
        const clipDeform = clipWorld.clone().multiply(srcRest.clone().invert());
        const rigDeform = out.clone().multiply(rigBind.clone().invert());
        expect(rigDeform.angleTo(clipDeform)).toBeCloseTo(0, 6);
        expect(rigDeform.angleTo(identity)).toBeCloseTo(0.7, 6);
    });
});

describe('SkinnedRetargetSpace', () => {
    const euler = (x: number, y: number, z: number) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z));
    const rigBind = new Map([['arm', euler(0.3, 1.2, -0.4)], ['hand', euler(0.1, 0, 0.2)]]);
    const canonicalRest = new Map([['arm', euler(0, 0, 0.1)]]);
    const ownRest = new Map([['arm', euler(Math.PI / 2, 0, -0.2)], ['hand', euler(0.5, 0.5, 0)]]);
    const same = (name: string) => name;

    it('takes the first clip skeleton as the space and corrects the rig against it', () => {
        const space = new SkinnedRetargetSpace(rigBind);
        expect(space.hasReference()).toBe(false);
        expect(space.addClip({}, canonicalRest, null, rigBind.keys(), same)).toBeNull();
        expect(space.hasReference()).toBe(true);
        const expected = canonicalRest.get('arm')!.clone().invert().multiply(rigBind.get('arm')!);
        expect(space.getRigDeltas().get('arm')!.angleTo(expected)).toBeCloseTo(0, 6);
    });

    it('gives a clip that rests like the reference no correction, and remembers that', () => {
        const space = new SkinnedRetargetSpace(rigBind);
        space.addClip({}, canonicalRest, new THREE.Vector3(0, 1.04, 0), rigBind.keys(), same);
        const walk = {};
        expect(space.getClipCorrection(walk)).toBeUndefined();
        expect(space.addClip(walk, new Map([['arm', canonicalRest.get('arm')!.clone()]]), new THREE.Vector3(0, 1.04, 0), rigBind.keys(), same)).toBeNull();
        expect(space.getClipCorrection(walk)).toBeNull();
    });

    it('lands a clip that rests differently exactly where its own rest says', () => {
        const space = new SkinnedRetargetSpace(rigBind);
        space.addClip({}, canonicalRest, null, rigBind.keys(), same);
        const deltas = space.addClip({}, ownRest, null, rigBind.keys(), same)!.rotations!;
        // The clip turns the arm 40° about X from ITS rest.
        const turn = euler(0.7, 0, 0);
        const clipWorld = turn.clone().multiply(ownRest.get('arm')!);
        const shown = retargetedWorldRotation(clipWorld.multiply(deltas.get('arm')!), space.getRigDeltas().get('arm')!, new THREE.Quaternion());
        expect(shown.multiply(rigBind.get('arm')!.clone().invert()).angleTo(turn)).toBeCloseTo(0, 6);
    });

    it('lets a later skeleton define a bone no earlier one carried', () => {
        const space = new SkinnedRetargetSpace(rigBind);
        space.addClip({}, canonicalRest, null, rigBind.keys(), same);
        const deltas = space.addClip({}, ownRest, null, rigBind.keys(), same)!.rotations!;
        expect(deltas.has('hand')).toBe(false);
        expect(space.getReferenceRest().get('hand')!.angleTo(ownRest.get('hand')!)).toBeCloseTo(0, 6);
        const expected = ownRest.get('hand')!.clone().invert().multiply(rigBind.get('hand')!);
        expect(space.getRigDeltas().get('hand')!.angleTo(expected)).toBeCloseTo(0, 6);
    });

    it('does not remember a skeleton that has not loaded yet', () => {
        const space = new SkinnedRetargetSpace(rigBind);
        const pending = {};
        expect(space.addClip(pending, new Map(), new THREE.Vector3(0, 1, 0), rigBind.keys(), same)).toBeNull();
        expect(space.getClipCorrection(pending)).toBeUndefined();
        expect(space.hasReference()).toBe(false);
    });

    it('seats a skeleton whose hips rest elsewhere on the reference hips', () => {
        const space = new SkinnedRetargetSpace(rigBind);
        space.addClip({}, canonicalRest, new THREE.Vector3(0, 1.04, 0), rigBind.keys(), same);
        const short = space.addClip({}, canonicalRest, new THREE.Vector3(0, 0.89, -0.025), rigBind.keys(), same)!;
        expect(short.rotations).toBeNull();
        expect(short.hipsShift!.toArray()).toEqual([0, expect.closeTo(0.15, 9), expect.closeTo(0.025, 9)]);
        expect(space.getReferenceHipsRest()!.toArray()).toEqual([0, 1.04, 0]);

        // Read through the correction, the short skeleton's rest hips ARE the reference's,
        // wherever the character faces.
        const facing = euler(0, 1.1, 0);
        const bone = new THREE.Object3D();
        bone.position.copy(new THREE.Vector3(0, 0.89, -0.025).applyQuaternion(facing));
        bone.updateMatrixWorld(true);
        const read = new ClipBoneReader().begin(short, facing).position(bone, new THREE.Vector3());
        expect(read.distanceTo(new THREE.Vector3(0, 1.04, 0).applyQuaternion(facing))).toBeCloseTo(0, 9);
        // A skeleton that matches passes its transforms through untouched.
        expect(new ClipBoneReader().begin(null, facing).position(bone, new THREE.Vector3()).distanceTo(bone.position)).toBe(0);
    });
});

describe('authoredFootLift', () => {
    it('is 0 while a foot is planted, so the plant is unchanged', () => {
        expect(authoredFootLift(0)).toBe(0);
    });

    it('passes a real lift through — a jump leaves the ground', () => {
        expect(authoredFootLift(0.42)).toBeCloseTo(0.42, 6);
    });

    it('treats a missing measurement as a plant', () => {
        expect(authoredFootLift(null)).toBe(0);
    });

    it('never lets a negative measurement sink the body', () => {
        expect(authoredFootLift(-0.3)).toBe(0);
    });

    it('caps a mis-scaled asset instead of launching the body', () => {
        expect(authoredFootLift(120)).toBe(MAX_AUTHORED_FOOT_LIFT_M);
        expect(authoredFootLift(Number.NaN)).toBe(0);
        expect(authoredFootLift(Number.POSITIVE_INFINITY)).toBe(0);
    });
});

describe('authoredHipsSway', () => {
    const out = new THREE.Vector3();

    it('is the ground-plane offset of the posed hips from their rest, never vertical', () => {
        const sway = authoredHipsSway(new THREE.Vector3(0.12, 1.3, -0.05), new THREE.Vector3(0, 1.0, 0), out);
        expect(sway.x).toBeCloseTo(0.12, 6);
        expect(sway.y).toBe(0);
        expect(sway.z).toBeCloseTo(-0.05, 6);
    });

    it('is zero at rest', () => {
        const sway = authoredHipsSway(new THREE.Vector3(3, 1, 4), new THREE.Vector3(3, 0.9, 4), out);
        expect(sway.length()).toBe(0);
    });

    it('caps whole-body travel a clip forgot to filter', () => {
        const sway = authoredHipsSway(new THREE.Vector3(0, 1, 6), new THREE.Vector3(0, 1, 0), out);
        expect(sway.length()).toBeCloseTo(MAX_HIPS_SWAY_M, 6);
        expect(sway.z).toBeGreaterThan(0);
    });

    it('collapses a non-finite reading to no sway', () => {
        expect(authoredHipsSway(new THREE.Vector3(Number.NaN, 1, 0), new THREE.Vector3(), out).length()).toBe(0);
    });
});
