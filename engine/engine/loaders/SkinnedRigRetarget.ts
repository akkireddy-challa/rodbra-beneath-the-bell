import * as THREE from 'three';

/**
 * Skinned-rig retarget helpers — the pure math behind the skinned render path
 * (`CharacterLoader.updateSkinnedCharacter`).
 *
 * The block character reads Mixamo bone WORLD rotations and applies them as-is,
 * which is fine for boxes that have no bind pose of their own. A skinned mesh
 * does have one: its skin was bound with every bone at a specific orientation,
 * and the mesh deforms by how far each bone has moved FROM that orientation.
 * Applying a clip's world rotation unchanged is therefore only correct when
 * the rig's bind orientations equal the clip skeleton's rest orientations —
 * true for character-forger GLBs and rigged `.vxl` bodies (both keep the
 * canonical Mixamo bind bit-identical), false for any other rig.
 *
 * Per bone the correction is a constant: with `B_rig` the rig's bind rotation
 * and `B_src` the clip skeleton's rest rotation (both in their root's frame),
 * the retargeted world rotation is `C · inv(B_src) · B_rig` for a clip world
 * rotation `C`. {@link buildRetargetDeltas} precomputes `inv(B_src) · B_rig`
 * per bone and drops the ones that are identity, so a canonical rig costs
 * nothing per frame — exactly the previous behaviour.
 *
 * `B_src` belongs to the clip skeleton actually PLAYING, and clips do not all
 * rest alike: a clip retargeted onto a character's own skeleton rests the way
 * that character does, hips height included. {@link SkinnedRetargetSpace}
 * keeps one correction per clip skeleton, applied before clips are blended.
 *
 * Vertical placement is the other block-derived habit this module softens.
 * Planting the lowest foot joint on the ground every frame also deletes the
 * clip's authored flight: a run cycle and a jump both leave the ground, and a
 * plant drags the body back down for every frame of it.
 * {@link authoredFootLift} measures how far the CLIP lifts both feet off its
 * own rest foot level, which the caller adds to the plant height. Imported
 * rest poses and toe articulation can also yield small positive values in
 * idle/walk: SkinnedGrounding classifies contact separately without throwing
 * away the displacement that cancels a running rig's tucked-leg bob.
 */

/** Bind-pose facts about a skinned rig, read once from its skin. */
export interface RigBindPose {
    /** Per bone name: bind rotation in the rig root's frame. */
    rotations: Map<string, THREE.Quaternion>;
}

/**
 * Read a rig's bind pose from the first skinned mesh under `root`.
 *
 * The bind is taken from the skin's inverse bind matrices, never from the
 * bones' current transforms: by the time the loader gets here something may
 * already have posed the bones (a grounding pass sampling a clip, a warm-up),
 * and the inverse bind matrices are the one record of the bind that nothing
 * animates. glTF defines them against the scene root, so their inverses are
 * bone transforms in the root's frame.
 *
 * Returns null when no skinned mesh with a skeleton is found.
 */
export function captureRigBindPose(root: THREE.Object3D): RigBindPose | null {
    let skinned: THREE.SkinnedMesh | null = null;
    root.traverse((o) => {
        if (skinned) return;
        const m = o as THREE.SkinnedMesh;
        if (m.isSkinnedMesh && m.skeleton) skinned = m;
    });
    if (!skinned) return null;
    const skeleton = (skinned as THREE.SkinnedMesh).skeleton;

    const rotations = new Map<string, THREE.Quaternion>();
    const bind = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3();
    for (let i = 0; i < skeleton.bones.length; i++) {
        const bone = skeleton.bones[i];
        const inverse = skeleton.boneInverses[i];
        if (!bone || !inverse) continue;
        const q = new THREE.Quaternion();
        bind.copy(inverse).invert().decompose(pos, q, scale);
        rotations.set(bone.name, q);
    }
    return { rotations };
}

/** Rotations closer than this to identity are treated as identity (~0.5°). */
const IDENTITY_ANGLE_EPS = 0.01;
const IDENTITY = new THREE.Quaternion();

/** `inv(from) · to`, or null when the two are the same rotation. */
function restDelta(from: THREE.Quaternion, to: THREE.Quaternion): THREE.Quaternion | null {
    const delta = from.clone().invert().multiply(to);
    return delta.angleTo(IDENTITY) < IDENTITY_ANGLE_EPS ? null : delta;
}

/**
 * Precompute `inv(B_src) · B_rig` for every rig bone that has a source
 * counterpart. `resolveSource` maps a rig bone name to the clip skeleton's bone
 * name (or null when the clip has no such bone). Bones whose delta is identity
 * are omitted, so an empty map means "this rig is canonical".
 */
export function buildRetargetDeltas(
    rigBind: Map<string, THREE.Quaternion>,
    sourceRest: Map<string, THREE.Quaternion>,
    resolveSource: (rigBoneName: string) => string | null,
): Map<string, THREE.Quaternion> {
    const deltas = new Map<string, THREE.Quaternion>();
    for (const [name, rigQ] of rigBind) {
        const srcName = resolveSource(name);
        if (!srcName) continue;
        const srcQ = sourceRest.get(srcName);
        if (!srcQ) continue;
        const delta = restDelta(srcQ, rigQ);
        if (delta) deltas.set(name, delta);
    }
    return deltas;
}

/** Hips rest positions closer than this are the same skeleton proportion (metres). */
const SAME_HIPS_REST_M = 1e-4;

/**
 * What re-expresses ONE clip skeleton in a rig's reference rest as its bones are
 * read ({@link SkinnedRetargetSpace}). Either part is null when that skeleton
 * already matches the reference there.
 */
export interface ClipRestCorrection {
    /** `inv(B_clip) · B_ref` per RIG bone name: right-multiply the bone's world rotation. */
    readonly rotations: ReadonlyMap<string, THREE.Quaternion> | null;
    /** Reference hips rest minus this skeleton's, in the skeleton root's frame and world metres: add to every bone position. */
    readonly hipsShift: THREE.Vector3 | null;
}

/**
 * One skinned rig's retarget corrections across EVERY clip skeleton that plays
 * on it.
 *
 * A frame's pose is composed from several clip skeletons — a crossfade, a body
 * mask over locomotion, a replay snapshot — then foot IK and procedural layers
 * edit it, and only then is it applied to the rig. Rotations measured from
 * different rests cannot be blended, and one correction applied after a
 * crossfade is wrong for one side of it. So the composed pose lives in ONE
 * space: the rest of the first clip skeleton the rig meets (the REFERENCE — in
 * practice the canonical idle, which every engine clip shares).
 *
 *  - Per clip skeleton, a {@link ClipRestCorrection} applied as that skeleton's
 *    bones are READ. Rotations become what the reference skeleton would hold
 *    for the same deformation (`inv(B_clip) · B_ref`). Positions move rigidly so
 *    the skeleton's rest hips sit on the reference's: a clip made on a
 *    character's own proportions rests its hips at another height, and the
 *    body's authored height is `hips − rest hips` — measured against a rest
 *    that changes player mid-crossfade, the body hops by the difference.
 *    A skeleton that matches the reference gets `null` — no work per frame.
 *  - Per rig, `inv(B_ref) · B_rig` ({@link getRigDeltas}), applied once after
 *    composition, as {@link buildRetargetDeltas} always was.
 *
 * Together `C · inv(B_clip) · B_ref · inv(B_ref) · B_rig = C · inv(B_clip) · B_rig`:
 * the exact retarget for the clip being played, whichever clip set the
 * reference. The reference only decides the space that procedural layers and
 * the hidden block body see.
 */
export class SkinnedRetargetSpace {
    private readonly referenceRest = new Map<string, THREE.Quaternion>();
    private referenceHipsRest: THREE.Vector3 | null = null;
    private readonly rigDeltas = new Map<string, THREE.Quaternion>();
    private readonly corrections = new WeakMap<object, ClipRestCorrection | null>();

    /** @param rigBind the rig's bind rotations ({@link captureRigBindPose}), keyed by rig bone name. */
    constructor(private readonly rigBind: ReadonlyMap<string, THREE.Quaternion>) {}

    /** False until a clip skeleton has been added; the pose is applied uncorrected until then. */
    hasReference(): boolean {
        return this.referenceRest.size > 0;
    }

    /** The rest rotations the composed pose is measured from, keyed by RIG bone name. */
    getReferenceRest(): ReadonlyMap<string, THREE.Quaternion> {
        return this.referenceRest;
    }

    /**
     * Where the composed pose's hips rest, relative to a clip skeleton's root and
     * in its frame (`MixamoAnimationPlayer.getRestHipsOffset` of the reference).
     * Null until a skeleton with hips has been added.
     */
    getReferenceHipsRest(): THREE.Vector3 | null {
        return this.referenceHipsRest;
    }

    /** `inv(B_ref) · B_rig` per rig bone; empty for a rig bound like the reference. */
    getRigDeltas(): ReadonlyMap<string, THREE.Quaternion> {
        return this.rigDeltas;
    }

    /**
     * A clip skeleton's correction: null when it matches the reference,
     * undefined when {@link addClip} has not seen it yet.
     */
    getClipCorrection(clip: object): ClipRestCorrection | null | undefined {
        return this.corrections.get(clip);
    }

    /**
     * Measure a clip skeleton against the reference and remember the result
     * under `clip` (any object that identifies the skeleton; held weakly).
     * `resolveSource` maps a rig bone name to the clip skeleton's bone name. A
     * bone no earlier skeleton carried takes this one's rest as its reference,
     * so the first skeleton added defines the space and later ones complete it.
     */
    addClip(
        clip: object,
        clipRest: ReadonlyMap<string, THREE.Quaternion>,
        clipHipsRest: THREE.Vector3 | null,
        rigBoneNames: Iterable<string>,
        resolveSource: (rigBoneName: string) => string | null,
    ): ClipRestCorrection | null {
        // A skeleton that has not loaded yet has nothing to measure; ask again later.
        if (clipRest.size === 0) return null;
        let rotations: Map<string, THREE.Quaternion> | null = null;
        for (const name of rigBoneNames) {
            const srcName = resolveSource(name);
            const srcQ = srcName ? clipRest.get(srcName) : undefined;
            if (!srcQ) continue;
            const reference = this.referenceRest.get(name);
            if (!reference) {
                this.referenceRest.set(name, srcQ.clone());
                const rigQ = this.rigBind.get(name);
                const rigDelta = rigQ && restDelta(srcQ, rigQ);
                if (rigDelta) this.rigDeltas.set(name, rigDelta);
                continue;
            }
            const delta = restDelta(srcQ, reference);
            if (delta) (rotations ??= new Map()).set(name, delta);
        }
        let hipsShift: THREE.Vector3 | null = null;
        if (clipHipsRest && !this.referenceHipsRest) this.referenceHipsRest = clipHipsRest.clone();
        else if (clipHipsRest && this.referenceHipsRest
            && clipHipsRest.distanceTo(this.referenceHipsRest) > SAME_HIPS_REST_M) {
            hipsShift = this.referenceHipsRest.clone().sub(clipHipsRest);
        }
        const correction = rotations || hipsShift ? { rotations, hipsShift } : null;
        this.corrections.set(clip, correction);
        return correction;
    }
}

/**
 * Reads one clip skeleton's bones in a rig's reference rest for a frame: world
 * transforms as they are, with the skeleton's {@link ClipRestCorrection} on top.
 * Reused across frames; {@link begin} re-aims it.
 */
export class ClipBoneReader {
    private rotations: ReadonlyMap<string, THREE.Quaternion> | null = null;
    private shifted = false;
    private readonly shift = new THREE.Vector3();

    /** @param facing the clip skeleton root's world rotation, the frame the hips shift is given in. */
    begin(correction: ClipRestCorrection | null, facing: THREE.Quaternion | null): this {
        this.rotations = correction?.rotations ?? null;
        this.shifted = !!correction?.hipsShift;
        if (correction?.hipsShift) {
            this.shift.copy(correction.hipsShift);
            if (facing) this.shift.applyQuaternion(facing);
        }
        return this;
    }

    /** Writes `out` and returns it. */
    position(bone: THREE.Object3D, out: THREE.Vector3): THREE.Vector3 {
        bone.getWorldPosition(out);
        return this.shifted ? out.add(this.shift) : out;
    }

    /** `rigBoneName` is the RIG's name for the bone, which the correction is keyed by. Writes `out` and returns it. */
    rotation(bone: THREE.Object3D, rigBoneName: string, out: THREE.Quaternion): THREE.Quaternion {
        bone.getWorldQuaternion(out);
        const delta = this.rotations?.get(rigBoneName);
        return delta ? out.multiply(delta) : out;
    }
}

/**
 * The world rotation to give a rig bone so it deforms its skin the way the
 * clip bone deformed the clip skeleton. `delta` is that bone's entry from
 * {@link buildRetargetDeltas}. Writes `out` and returns it.
 */
export function retargetedWorldRotation(
    clipWorld: THREE.Quaternion,
    delta: THREE.Quaternion,
    out: THREE.Quaternion,
): THREE.Quaternion {
    return out.copy(clipWorld).multiply(delta);
}

/**
 * Ceiling on the authored lift, in metres. A clip whose feet are measured far
 * off the ground is a broken or mis-scaled asset, and without a cap the body
 * would be launched into the sky; 1.5 m is well above any jump the engine's
 * clips author. Reaching it means the asset is wrong, not the character.
 */
export const MAX_AUTHORED_FOOT_LIFT_M = 1.5;

/**
 * The clip's authored lift, sanitised for use as a render offset: negative,
 * non-finite or absurd values collapse to 0, which is an ordinary foot plant.
 * Pass the raw measurement from `MixamoAnimationPlayer.getAuthoredFootLift`.
 */
export function authoredFootLift(rawLift: number | null): number {
    if (rawLift === null || !Number.isFinite(rawLift) || rawLift <= 0) return 0;
    return Math.min(rawLift, MAX_AUTHORED_FOOT_LIFT_M);
}

/**
 * Ceiling on the clip-authored hips travel applied to a skinned rig, in metres.
 * Sway and weight shift are centimetres; a lunge is a few decimetres. Beyond
 * this the clip is carrying whole-body travel a caller forgot to filter, and
 * the body would be dragged away from its own capsule.
 */
export const MAX_HIPS_SWAY_M = 1.0;

/**
 * The clip's authored hips travel in the ground plane, ready to apply to a rig:
 * `blendedHips` is the pose map's hips world position, `restHipsWorld` where the
 * clip skeleton's hips sit at rest for the character's CURRENT position and
 * facing. Vertical is left to the foot plant, so Y is always 0. Writes `out`
 * and returns it, clamped to {@link MAX_HIPS_SWAY_M}.
 */
export function authoredHipsSway(
    blendedHips: THREE.Vector3,
    restHipsWorld: THREE.Vector3,
    out: THREE.Vector3,
): THREE.Vector3 {
    out.set(blendedHips.x - restHipsWorld.x, 0, blendedHips.z - restHipsWorld.z);
    const len = out.length();
    if (!Number.isFinite(len)) return out.set(0, 0, 0);
    if (len > MAX_HIPS_SWAY_M) out.multiplyScalar(MAX_HIPS_SWAY_M / len);
    return out;
}
