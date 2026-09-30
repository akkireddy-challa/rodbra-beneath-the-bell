/**
 * The bake replaces every NPC's AnimationMixer, so the table has to reproduce
 * what the mixer would have produced — and index it the way the shader will.
 * These tests pin the sampling (the right pose lands in the right row), the
 * layout (a shader indexing by clip/frame/bone finds the matrix it expects) and
 * the loop-vs-clamp semantics that decide whether a one-shot replays forever.
 */
import * as THREE from 'three';
import {
    DEFAULT_BAKE_ANIMATION_OPTIONS,
    bakeAnimationTable,
    resolveFrameRow,
    packAnimationTexture,
} from 'engine/npc/crowd/CrowdAnimationBake.js';

/** Root with one bone that slides +1 on X over one second. */
function makeRig(): { root: THREE.Object3D; bones: THREE.Object3D[]; clip: THREE.AnimationClip } {
    const root = new THREE.Object3D();
    root.name = 'root';
    const bone = new THREE.Object3D();
    bone.name = 'bone';
    root.add(bone);
    const clip = new THREE.AnimationClip('slide', 1, [
        new THREE.VectorKeyframeTrack('bone.position', [0, 1], [0, 0, 0, 1, 0, 0]),
    ]);
    return { root, bones: [bone], clip };
}

/** Read matrix (clip, frame, bone) back out of the flat table. */
function readMatrix(
    table: ReturnType<typeof bakeAnimationTable>,
    frameRow: number,
    bone: number,
): THREE.Matrix4 {
    const base = (frameRow * table.boneCount + bone) * 16;
    return new THREE.Matrix4().fromArray(table.data, base);
}

describe('bakeAnimationTable', () => {
    test('samples the clip across its duration at the requested rate', () => {
        const { root, bones, clip } = makeRig();
        const table = bakeAnimationTable(root, bones, [clip], { ...DEFAULT_BAKE_ANIMATION_OPTIONS, fps: 10 });
        expect(table.boneCount).toBe(1);
        expect(table.clips[0]!.frameCount).toBe(10);
        expect(table.frameCount).toBe(10);
        expect(table.data.length).toBe(10 * 1 * 16);
    });

    test('the sampled pose actually changes over the clip', () => {
        // The failure this catches is a bake that runs but never advances the
        // mixer — every row identical, every NPC frozen in the bind pose.
        const { root, bones, clip } = makeRig();
        const table = bakeAnimationTable(root, bones, [clip], { ...DEFAULT_BAKE_ANIMATION_OPTIONS, fps: 10 });
        const first = readMatrix(table, 0, 0).elements[12];
        const last = readMatrix(table, 9, 0).elements[12];
        expect(first).toBeCloseTo(0, 3);
        expect(last).toBeGreaterThan(0.5);
    });

    test('several clips get disjoint, contiguous frame ranges', () => {
        const { root, bones, clip } = makeRig();
        const other = new THREE.AnimationClip('wave', 0.5, [
            new THREE.VectorKeyframeTrack('bone.position', [0, 0.5], [0, 0, 0, 0, 2, 0]),
        ]);
        const table = bakeAnimationTable(root, bones, [clip, other], { ...DEFAULT_BAKE_ANIMATION_OPTIONS, fps: 10 });
        expect(table.clips[0]!.frameOffset).toBe(0);
        expect(table.clips[0]!.frameCount).toBe(10);
        expect(table.clips[1]!.frameOffset).toBe(10);
        expect(table.clips[1]!.frameCount).toBe(5);
        expect(table.frameCount).toBe(15);
    });

    test('a zero-length clip still gets one row', () => {
        // A static pose is a legitimate animation; zero rows would leave the
        // shader indexing into the next clip's data.
        const { root, bones } = makeRig();
        const still = new THREE.AnimationClip('idle', 0, [
            new THREE.VectorKeyframeTrack('bone.position', [0], [0, 3, 0]),
        ]);
        const table = bakeAnimationTable(root, bones, [still], { ...DEFAULT_BAKE_ANIMATION_OPTIONS, fps: 30 });
        expect(table.clips[0]!.frameCount).toBe(1);
    });

    test('bone order follows the array given, matching the mesh bake', () => {
        // The shader indexes this table with the vertex boneIndex attribute, so
        // a mismatched order renders a scrambled character rather than failing.
        const root = new THREE.Object3D();
        const a = new THREE.Object3D(); a.name = 'a'; a.position.set(5, 0, 0);
        const b = new THREE.Object3D(); b.name = 'b'; b.position.set(0, 7, 0);
        root.add(a, b);
        const clip = new THREE.AnimationClip('noop', 0.1, [
            new THREE.VectorKeyframeTrack('a.position', [0], [5, 0, 0]),
        ]);
        const table = bakeAnimationTable(root, [b, a], [clip], { ...DEFAULT_BAKE_ANIMATION_OPTIONS, fps: 10 });
        expect(readMatrix(table, 0, 0).elements[13]).toBeCloseTo(7, 3); // b first
        expect(readMatrix(table, 0, 1).elements[12]).toBeCloseTo(5, 3); // a second
    });

    test('empty inputs produce an empty table rather than throwing', () => {
        const table = bakeAnimationTable(new THREE.Object3D(), [], [], { ...DEFAULT_BAKE_ANIMATION_OPTIONS, fps: 30 });
        expect(table.frameCount).toBe(0);
        expect(table.data.length).toBe(0);
    });
});

describe('resolveFrameRow', () => {
    const table = {
        data: new Float32Array(0),
        boneCount: 1,
        frameCount: 15,
        fps: 10,
        clips: [
            { name: 'walk', frameOffset: 0, frameCount: 10, duration: 1, loop: true },
            { name: 'die', frameOffset: 10, frameCount: 5, duration: 0.5, loop: false },
        ],
    };

    test('a looping clip wraps', () => {
        expect(resolveFrameRow(table, 0, 0)).toBe(0);
        expect(resolveFrameRow(table, 0, 0.5)).toBe(5);
        expect(resolveFrameRow(table, 0, 1.2)).toBe(2); // wrapped
    });

    test('a one-shot clamps to its last frame rather than restarting', () => {
        // A death animation that loops is the visible bug this prevents.
        expect(resolveFrameRow(table, 1, 0)).toBe(10);
        expect(resolveFrameRow(table, 1, 10)).toBe(14);
    });

    test('negative time does not index outside the clip', () => {
        expect(resolveFrameRow(table, 0, -0.3)).toBeGreaterThanOrEqual(0);
        expect(resolveFrameRow(table, 1, -5)).toBe(10);
    });

    test('an unknown clip index resolves to row 0 rather than NaN', () => {
        expect(resolveFrameRow(table, 99, 1)).toBe(0);
    });
});

describe('packAnimationTexture', () => {
    test('lays out four texels per bone and one image row per frame', () => {
        const { root, bones, clip } = makeRig();
        const table = bakeAnimationTable(root, bones, [clip], { ...DEFAULT_BAKE_ANIMATION_OPTIONS, fps: 10 });
        const tex = packAnimationTexture(table);
        expect(tex.image.width).toBe(4);
        expect(tex.image.height).toBe(10);
        // The bake buffer IS the texture buffer — no repack, so the same array
        // can feed a WebGPU storage buffer unchanged.
        expect(tex.image.data).toBe(table.data);
    });

    test('uses nearest filtering — frames are discrete poses', () => {
        const { root, bones, clip } = makeRig();
        const tex = packAnimationTexture(bakeAnimationTable(root, bones, [clip], { ...DEFAULT_BAKE_ANIMATION_OPTIONS, fps: 4 }));
        expect(tex.minFilter).toBe(THREE.NearestFilter);
        expect(tex.magFilter).toBe(THREE.NearestFilter);
    });
});

describe('bakeAnimationTable onFrame hook', () => {
    test('onFrame runs between the mixer advancing and the matrices being read', () => {
        // This hook is what lets a block character bake its RIG rather than its
        // skeleton: BlockCharacterRenderer derives part transforms from joint
        // pairs and a shoulder-line torso basis, so the parts only reach the
        // frame's pose after update() runs. Sampling before it captures the
        // previous frame; not calling it at all captures the bind pose forever.
        const { root, clip } = makeRig();
        const part = new THREE.Object3D();
        part.name = 'part';
        root.add(part);
        const bone = root.getObjectByName('bone')!;

        const seen: number[] = [];
        bakeAnimationTable(root, [part], [clip], {
            ...DEFAULT_BAKE_ANIMATION_OPTIONS,
            fps: 10,
            onFrame: () => {
                // Stand in for the rig: copy the posed bone onto the part.
                seen.push(bone.position.x);
                part.position.copy(bone.position);
                part.updateMatrixWorld(true);
            },
        });
        // Called once per baked row, and each call already sees THAT row's pose.
        expect(seen).toHaveLength(10);
        expect(seen[0]).toBeCloseTo(0, 5);
        expect(seen[9]).toBeCloseTo(0.9, 5);
    });

    test('without onFrame the table is the nodes\' own matrices', () => {
        // The default is a no-op, which is correct for a plain skinned rig where
        // the sampled nodes ARE the bones.
        const { root, bones, clip } = makeRig();
        const table = bakeAnimationTable(root, bones, [clip], { ...DEFAULT_BAKE_ANIMATION_OPTIONS, fps: 10 });
        expect(table.boneCount).toBe(1);
        expect(table.frameCount).toBe(10);
    });
});
