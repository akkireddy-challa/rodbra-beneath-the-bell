/**
 * CrowdAnimationBake — sample animation clips into a flat bone-matrix table the
 * GPU can index, so a crowd never evaluates a skeleton on the CPU.
 *
 * Today every NPC runs its own AnimationMixer and then rebuilds its part
 * hierarchy from the posed bones — measured at ~1.8 ms per NPC per frame, which
 * is what caps crowd size long before triangles or draw calls do. Baking the
 * clips once per character variant turns that into a texture fetch: the vertex
 * shader reads `bone[clip][frame][boneIndex]` and multiplies, and no CPU work
 * happens per NPC at all.
 *
 * The table pairs with CrowdMeshBake: that bakes vertices into PART-LOCAL space
 * (bind inverse already applied), so posing is one multiply with the matrices
 * stored here, with no per-part inverse-bind multiply at runtime.
 *
 * ## Requirements on the caller
 *
 * Sample with the character at IDENTITY transform. The matrices stored are the
 * sampled nodes' world matrices, which equal model-space matrices only when the
 * root is untransformed; baking a translated character bakes that translation
 * into every instance. CrowdMeshBake has the same requirement for the same reason.
 *
 * What gets sampled is the body-part GROUPS, not skeleton bones — a block
 * character's parts are derived from joint pairs and a shoulder-line torso basis
 * rather than copied from bone matrices, so the rig must run per frame via
 * `onFrame`. See PartBinding in CrowdMeshBake.
 *
 * ## Layout
 *
 * Column-major 4x4 (`Matrix4.toArray` order) per part, laid out clip-major then
 * frame-major then part — four consecutive texels are the four COLUMNS, which is
 * what lets both shaders rebuild it as `mat4(c0, c1, c2, c3)`:
 *
 *     index(clip, frame, bone) = (((clipOffset[clip] + frame) * boneCount) + bone) * 16
 *
 * A 4x4 rather than the 3x4 that skinning textures often use: the extra row
 * costs a third more memory on a table measured in tens of kilobytes, and
 * keeping it square means the shader indexes it without a repack step. At 20
 * bones, 6 clips and 60 frames each that is 20 * 360 * 16 floats — about 460 KB.
 */
import * as THREE from 'three';

/** One clip's slice of the table. */
export interface BakedClipRange {
    name: string;
    /** First frame row of this clip within the table. */
    frameOffset: number;
    frameCount: number;
    /** Source clip duration in seconds; frameCount/fps may round up past it. */
    duration: number;
    /** Whether sampling should wrap (looping clips) or clamp (one-shots). */
    loop: boolean;
}

export interface BakedAnimationTable {
    /** Flat matrix data — see the layout note in the module header. */
    data: Float32Array;
    clips: BakedClipRange[];
    boneCount: number;
    /** Total frame rows across all clips. */
    frameCount: number;
    fps: number;
}

export interface BakeAnimationOptions {
    /** Sample rate. 30 is ample for crowd characters seen at a distance. */
    fps: number;
    /** Clips that should wrap rather than clamp when sampled past the end. */
    loopingClipNames?: ReadonlyArray<string>;
    /**
     * Run the rig for the frame the mixer has just been advanced to, before the
     * node matrices are read.
     *
     * A block character MUST pose here (`BlockCharacterRenderer.update()`, then
     * `updateMatrixWorld` on the block root), because its parts are not placed by
     * bone matrices — limbs come from joint pairs, the torso from a shoulder-line
     * basis, the head from the cached torso rotation. Skipping this bakes the
     * skeleton instead of the rig: measured against the CPU renderer that agrees
     * at bind pose and then falls apart under rotation (silhouette IoU 0.46 vs
     * 0.80), which reads as the crowd animating differently from the articulated
     * NPC beside it.
     */
    onFrame: () => void;
}

export const DEFAULT_BAKE_ANIMATION_OPTIONS: BakeAnimationOptions = { fps: 30, onFrame: () => {} };

/**
 * Sample `clips` over `nodes` into one table.
 *
 * `nodes` are the objects whose world matrices ARE the pose — for a block
 * character, the body-part groups the merge was built from, NOT skeleton bones
 * (see PartBinding in CrowdMeshBake for why). They must be in the SAME order as
 * the merged mesh's `boneNames`, because the shader indexes this table with the
 * vertex's `boneIndex` attribute. A differently-ordered array silently renders a
 * scrambled character rather than failing, so derive it from the merge result.
 */
export function bakeAnimationTable(
    root: THREE.Object3D,
    nodes: ReadonlyArray<THREE.Object3D>,
    clips: ReadonlyArray<THREE.AnimationClip>,
    options: BakeAnimationOptions = DEFAULT_BAKE_ANIMATION_OPTIONS,
): BakedAnimationTable {
    const fps = Math.max(1, options.fps);
    const looping = new Set(options.loopingClipNames ?? []);
    const boneCount = nodes.length;

    // Frame counts first, so the output is one allocation.
    const ranges: BakedClipRange[] = [];
    let frameCursor = 0;
    for (const clip of clips) {
        // At least one frame even for a zero-length clip: a static pose is a
        // legitimate "animation" and the shader must be able to index it.
        const frameCount = Math.max(1, Math.ceil(clip.duration * fps));
        ranges.push({
            name: clip.name,
            frameOffset: frameCursor,
            frameCount,
            duration: clip.duration,
            loop: looping.has(clip.name),
        });
        frameCursor += frameCount;
    }

    const data = new Float32Array(frameCursor * boneCount * 16);
    if (boneCount === 0 || clips.length === 0) {
        return { data, clips: ranges, boneCount, frameCount: frameCursor, fps };
    }

    const mixer = new THREE.AnimationMixer(root);
    for (let c = 0; c < clips.length; c++) {
        const clip = clips[c]!;
        const range = ranges[c]!;
        const action = mixer.clipAction(clip);
        action.reset();
        action.play();

        for (let f = 0; f < range.frameCount; f++) {
            // setTime drives the mixer deterministically from a time value; the
            // usual update(delta) path would accumulate rounding across a bake
            // and drift the later frames of long clips.
            mixer.setTime(f / fps);
            root.updateMatrixWorld(true);
            // The rig runs BETWEEN the mixer advancing and the read: for a block
            // character the part groups only reach this frame's pose once
            // BlockCharacterRenderer.update() has derived them.
            options.onFrame();
            const base = (range.frameOffset + f) * boneCount * 16;
            for (let b = 0; b < boneCount; b++) {
                nodes[b]!.matrixWorld.toArray(data, base + b * 16);
            }
        }

        action.stop();
        mixer.uncacheAction(clip);
    }
    mixer.stopAllAction();

    return { data, clips: ranges, boneCount, frameCount: frameCursor, fps };
}

/**
 * Resolve a clip name and a playback time to a frame row.
 *
 * Kept here rather than in the renderer so the CPU-side instance writer and any
 * shader-side equivalent agree on rounding: an off-by-one here shows up as a
 * one-frame animation offset that is very hard to spot and impossible to
 * attribute.
 */
export function resolveFrameRow(table: BakedAnimationTable, clipIndex: number, timeSeconds: number): number {
    const range = table.clips[clipIndex];
    if (!range) return 0;
    const raw = Math.floor(timeSeconds * table.fps);
    const local = range.loop
        ? ((raw % range.frameCount) + range.frameCount) % range.frameCount
        : Math.min(Math.max(raw, 0), range.frameCount - 1);
    return range.frameOffset + local;
}

/**
 * Pack the table into an RGBA float texture: one texel per matrix ROW, four
 * texels per bone, `boneCount * 4` texels per row of the image.
 *
 * A texture rather than a uniform array because a uniform block cannot hold a
 * table this size, and because the WebGL2 fallback path has no storage buffers —
 * the same data feeds a storage buffer on WebGPU, so both backends share one
 * bake (see docs/renderer-backends.md for the dual-path rule).
 */
export function packAnimationTexture(table: BakedAnimationTable): THREE.DataTexture {
    const width = Math.max(1, table.boneCount * 4);
    const height = Math.max(1, table.frameCount);
    // The bake already lays matrices out row-major and contiguous per frame, so
    // the buffer IS the texture; no repack, and the same Float32Array can be
    // handed to a storage buffer unchanged.
    const texture = new THREE.DataTexture(table.data, width, height, THREE.RGBAFormat, THREE.FloatType);
    texture.needsUpdate = true;
    // Nearest: frames are discrete samples. Linear would blend between two poses
    // per fetch and, worse, blend across a bone boundary at the row edges.
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.generateMipmaps = false;
    return texture;
}
