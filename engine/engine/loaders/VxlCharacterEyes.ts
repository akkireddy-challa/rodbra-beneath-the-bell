/**
 * Runtime eyes for a rigged voxel character, drawn from the `.vxl` EYE section
 * (VxlV3Eyes) rather than baked into the mesh.
 *
 * Jani, 2026-09-01/09-02: eyes are METADATA "where eyes are, and the color and
 * shape", so the runtime draws a replaceable, blinking, gaze-aimed eye. This
 * reuses the same blink/track machinery the animals use (`AnimalEyeController`)
 * — no second eye system — and only adds the piece that was missing: turning an
 * `EyeMeta` record into a symmetric pair of eye meshes on the head bone.
 *
 * The pair is parented to the head bone, so it follows the rig for free; only
 * blink and gaze need a per-frame tick (`tickVxlCharacterEyes`).
 *
 * LOOK: the engine's voxel "googly" eye — the same border / sclera / pupil
 * stack of flat boxes the block animals get by default (`BlockAnimalBodyBuilder.
 * addEyes`, style 'square'): a black rim, a rectangular sclera `w × h` voxels,
 * a rectangular pupil that slides to track a gaze target. Never round: a round
 * eye reads as a cartoon sticker on a voxel face, and Jani, 2026-09-04: "We
 * should have rectangular googly eyes that blink and also move".
 *
 * COLOUR: `EyeMeta` today carries eye SHAPE (w/h) and a `type` (classic / dark
 * socket) but no RGB — so colour is derived from `type` here via `EYE_PRESETS`.
 * When the record grows a real colour field, only that table changes.
 */
import * as THREE from 'three';
import { AnimalEyeController } from 'engine/animal/AnimalEyeController.js';
import { createClassedPartMaterial } from 'engine/ClassedPartMaterial.js';
import type { EyeMeta } from 'engine/VxlV3Eyes.js';
import type { VxlV3Bounds } from 'engine/VxlV3Format.js';

/**
 * The COLOURS of an eye, separate from its shape (which the `.vxl` record
 * owns). A `type` in the record picks a default look; a game overrides it per
 * character with `setVxlCharacterEyeLook` or per NPC type with
 * `registerNpc(..., { eyeLook })` — the manual override for "these are evil".
 */
export interface VxlEyeLook {
    /** Sclera (the eye's background) colour. */
    sclera: number;
    /** Pupil colour — also the glow tint when `pupilGlow` > 0. */
    pupil: number;
    /**
     * Pupil emissive level in units of the voxel full-glow (`EMISSIVE_INTENSITY`);
     * 0 = no glow. A HALO needs the scene's bloom (`worldProfileData.bloomConfig`)
     * and a level that clears its threshold: at the engine's 0.98 luminance
     * threshold a red pupil only crosses it around 3, since red carries a fifth
     * of white's luminance. Without bloom, anything above ~0.3 just overexposes.
     */
    pupilGlow: number;
}

/** The record's `classic` type: white eye, near-black pupil. */
export const DEFAULT_VXL_EYE_LOOK: VxlEyeLook = { sclera: 0xffffff, pupil: 0x101014, pupilGlow: 0 };
/** The record's `dark` type: a dark socket. */
export const DARK_VXL_EYE_LOOK: VxlEyeLook = { sclera: 0x1b1b1f, pupil: 0x000000, pupilGlow: 0 };
/**
 * Black eye, glowing red pupil — the monster look. Tuned for a bloomed scene
 * (`bloomConfig` strength 0.4, radius 0.4, threshold 0.98): the pupil has to
 * clear the threshold to get its halo. With bloom off it overexposes to a
 * salmon square — use `{ ...EVIL_VXL_EYE_LOOK, pupilGlow: 0.3 }` there.
 */
export const EVIL_VXL_EYE_LOOK: VxlEyeLook = { sclera: 0x000000, pupil: 0xff1010, pupilGlow: 3 };

/** Look a record `type` implies until the record carries real RGB. */
const EYE_PRESETS: Record<EyeMeta['type'], VxlEyeLook> = {
    classic: DEFAULT_VXL_EYE_LOOK,
    dark: DARK_VXL_EYE_LOOK,
};

/**
 * Soft-gloss sclera, wet-highlight pupil (the animal eye's classes), the pupil
 * glowing in its own colour when the look asks. One pair of materials serves
 * both eyes of one character.
 */
function buildEyeMaterials(look: VxlEyeLook): { sclera: THREE.Material; pupil: THREE.Material } {
    return {
        sclera: createClassedPartMaterial('plastic', { color: look.sclera, glow: 0 }),
        pupil: createClassedPartMaterial('gem', { color: look.pupil, glow: look.pupilGlow }),
    };
}

/** Pupil size as a fraction of the sclera (width, height). */
const PUPIL_FRACTION_W = 0.45;
const PUPIL_FRACTION_H = 0.55;
/** Black rim around the sclera, in voxels — the "googly" outline. */
const BORDER_VOXELS = 0.15;
/**
 * Fraction of eye width the pupil can slide when tracking a gaze target — the
 * full slack that keeps the pupil inside the sclera at its widest offset.
 */
const PUPIL_TRACK_FRACTION = (1 - PUPIL_FRACTION_W) * 0.5;
/**
 * Per-frame blink + gaze for a character with a gaze DIRECTION rather than a
 * thing to watch — the player, whose eyes follow the aim (the camera's view
 * direction). No-op for a body without eyes.
 */
export function tickVxlCharacterEyesAlong(root: THREE.Object3D, deltaTime: number, direction: THREE.Vector3): void {
    getVxlEyeController(root)?.updateAlong(deltaTime, direction);
}

const viewDir = new THREE.Vector3();
/**
 * Per-frame blink + gaze for the PLAYER: its eyes follow the aim, i.e. the
 * camera's view direction. Before a camera exists (boot) blink still runs and
 * the pupils rest centred. No-op for a body without eyes.
 */
export function tickVxlCharacterEyesFromView(root: THREE.Object3D, deltaTime: number, camera: THREE.Camera | null): void {
    const controller = getVxlEyeController(root);
    if (!controller) return;
    if (camera) controller.updateAlong(deltaTime, camera.getWorldDirection(viewDir));
    else controller.update(deltaTime, viewDir.set(0, 0, 0), null);
}
/** Push the eye plane this many voxels proud of the face so it never sinks. */
const SURFACE_PROUD_VOXELS = 0.5;

/**
 * Object names the builder gives the pair, and the only handle a REBIND has:
 * a SkeletonUtils clone arrives with the meshes but no controller, so these
 * names are the contract between `attachVxlCharacterEyes` and
 * `reconnectVxlCharacterEyes`. Each group holds a `${name}Border` /
 * `${name}Sclera` / `${name}Pupil` (the border is decoration only; the
 * controller never touches it, so a rebind does not need it).
 */
const EYE_GROUP_NAMES = ['VxlEyeLeft', 'VxlEyeRight'] as const;

interface BuiltEye {
    group: THREE.Group;
    sclera: THREE.Mesh;
    pupil: THREE.Mesh;
}

/** The min corner is all the placement math reads from the file's bounds. */
export type VxlEyeBoundsMin = Pick<VxlV3Bounds, 'minX' | 'minY' | 'minZ'>;

/**
 * Everything needed to (re)build a character's eyes, as PLAIN DATA.
 *
 * SkeletonUtils.clone — how an NPC crowd is built from one loaded template —
 * keeps only bones and skinned meshes: it drops the eye meshes parented to the
 * head bone AND drops `userData`. So a clone cannot carry its eyes or a
 * controller across. The loader stashes this spec on the TEMPLATE's scene
 * (`userData.vxlEyeSpec`, which the template keeps since it is never itself
 * cloned), and the cloning site applies it to each clone with
 * `applyVxlEyeSpec`.
 */
export interface VxlEyeSpec {
    eyes: EyeMeta;
    bounds: VxlEyeBoundsMin;
    minVoxelSize: number;
}

/** The spec a loaded vxl character carries, or null for a body without eyes. */
export function getVxlEyeSpec(root: THREE.Object3D): VxlEyeSpec | null {
    const s = root.userData.vxlEyeSpec;
    return s && typeof s === 'object' && 'eyes' in s ? (s as VxlEyeSpec) : null;
}

/**
 * The head bone of a decoded vxl character — `mixamorigHead` (joint 5 of
 * MIXAMO_22_JOINTS), found by name so it works on a clone too. Null for a
 * character with no such bone (a GLB, or a body decoded without a rig).
 */
function findVxlHeadBone(root: THREE.Object3D): THREE.Object3D | null {
    return root.getObjectByName('mixamorigHead') ?? null;
}

/**
 * Build the eye pair from an `EyeMeta` record and attach it to `headBone`,
 * returning the controller that blinks and tracks. `headBone.matrixWorld` must
 * be current (`applyVxlEyeSpec` runs `updateMatrixWorld(true)` before this).
 *
 * `bounds`/`minVoxelSize` come from the decoded file: eye coordinates are grid
 * cells relative to `bounds.min` in `minVoxelSize` units — the same lattice the
 * leaves use — so model space is `bounds.min + grid * minVoxelSize`.
 */
function attachVxlCharacterEyes(
    headBone: THREE.Object3D,
    eyes: EyeMeta,
    bounds: VxlEyeBoundsMin,
    minVoxelSize: number,
): AnimalEyeController {
    const preset = EYE_PRESETS[eyes.type];
    const eyeW = Math.max(1, eyes.w) * minVoxelSize;
    const eyeH = Math.max(1, eyes.h) * minVoxelSize;

    // Grid → model space, then into the head bone's local frame.
    const toModel = (gx: number, gy: number, gz: number): THREE.Vector3 =>
        new THREE.Vector3(
            bounds.minX + gx * minVoxelSize,
            bounds.minY + gy * minVoxelSize,
            bounds.minZ + gz * minVoxelSize,
        );
    const toBoneLocal = new THREE.Matrix4().copy(headBone.matrixWorld).invert();
    // Orient each eye group to MODEL axes (face +Z, up +Y) regardless of the
    // head bone's own bind rotation, so blink (scales local Y) and gaze (slides
    // local X/Y) stay vertical/horizontal on the face.
    const modelAlign = headBone.getWorldQuaternion(new THREE.Quaternion()).invert();

    // Sizes baked into the GEOMETRY, never the mesh scale: AnimalEyeController's
    // blink sets `.scale.y` absolutely, so a mesh sized by scale would spring
    // back to full height mid-blink. The pair shares the geometries and the
    // materials — the eyes are identical, and only their group transforms and
    // per-mesh scale/position (blink, gaze) ever differ.
    //
    // Flat boxes, not circles: the square voxel eye (border / sclera / pupil)
    // every block animal gets by default. Each layer is a sliver deep so the
    // stack stays flush with the face; the border sits BEHIND the sclera and
    // stays full height through a blink, so a closed eye reads as a dark slit.
    const border = minVoxelSize * BORDER_VOXELS;
    const layerDepth = minVoxelSize * 0.1;
    const borderGeo = new THREE.BoxGeometry(eyeW + border * 2, eyeH + border * 2, layerDepth);
    const scleraGeo = new THREE.BoxGeometry(eyeW, eyeH, layerDepth);
    const pupilGeo = new THREE.BoxGeometry(eyeW * PUPIL_FRACTION_W, eyeH * PUPIL_FRACTION_H, layerDepth);
    // Matte rim, then the look's sclera/pupil pair.
    const borderMat = createClassedPartMaterial('matte', { color: 0x000000 });
    const { sclera: scleraMat, pupil: pupilMat } = buildEyeMaterials(preset);

    const proud = minVoxelSize * SURFACE_PROUD_VOXELS;
    const buildEye = (name: string, gx: number): BuiltEye => {
        const group = new THREE.Group();
        group.name = name;
        group.position.copy(toModel(gx, eyes.y, eyes.z)).applyMatrix4(toBoneLocal);
        group.quaternion.copy(modelAlign);
        const rim = new THREE.Mesh(borderGeo, borderMat);
        rim.name = `${name}Border`;
        rim.position.z = proud;
        rim.frustumCulled = false;
        const sclera = new THREE.Mesh(scleraGeo, scleraMat);
        sclera.name = `${name}Sclera`;
        sclera.position.z = proud + layerDepth;
        sclera.frustumCulled = false;
        const pupil = new THREE.Mesh(pupilGeo, pupilMat);
        pupil.name = `${name}Pupil`;
        pupil.position.z = proud + layerDepth * 2;
        pupil.frustumCulled = false;
        group.add(rim, sclera, pupil);
        return { group, sclera, pupil };
    };

    const [leftName, rightName] = EYE_GROUP_NAMES;
    const left = buildEye(leftName, eyes.centreX - eyes.halfGap);
    const right = buildEye(rightName, eyes.centreX + eyes.halfGap);
    headBone.add(left.group, right.group);

    const controller = new AnimalEyeController({ placement: 'front' });
    controller.setEyeReferences(
        headBone,
        left.group,
        right.group,
        left.pupil,
        right.pupil,
        left.sclera,
        right.sclera,
        eyeW * PUPIL_TRACK_FRACTION,
    );
    return controller;
}

/**
 * Dress a character with the eyes its spec describes — used by the loader on a
 * fresh instance and by every cloning consumer on a SkeletonUtils clone, which
 * arrives with bones but no eye meshes (see `VxlEyeSpec`). Returns null when
 * the character has no head bone. Idempotent: a root that already has a live
 * controller is returned as-is.
 */
export function applyVxlEyeSpec(root: THREE.Object3D, spec: VxlEyeSpec): AnimalEyeController | null {
    const existing = getVxlEyeController(root);
    if (existing) return existing;
    // If eye meshes already exist on this root (a clone that happened to keep
    // them), rebind to THEM rather than attaching a second pair on top.
    if (root.getObjectByName(EYE_GROUP_NAMES[0])) return reconnectVxlCharacterEyes(root);
    const head = findVxlHeadBone(root);
    if (!head) return null;
    root.updateMatrixWorld(true);   // placement reads head.matrixWorld
    const controller = attachVxlCharacterEyes(head, spec.eyes, spec.bounds, spec.minVoxelSize);
    root.userData.eyeController = controller;
    return controller;
}

/**
 * Recolour a character's eyes — the manual override for a look the record does
 * not carry (black eyes with glowing red pupils on a monster, say). Swaps the
 * sclera and pupil materials on both eyes of the pair under `root` (the
 * character root or any ancestor of it) and disposes the ones they had, which
 * only this pair shared. Blink and gaze are untouched. Returns false, having
 * built nothing lasting, for a root without eyes.
 */
export function setVxlCharacterEyeLook(root: THREE.Object3D, look: VxlEyeLook): boolean {
    const mats = buildEyeMaterials(look);
    const replaced = new Set<THREE.Material>();
    for (const name of EYE_GROUP_NAMES) {
        const group = root.getObjectByName(name);
        if (!group) continue;
        for (const [suffix, mat] of [['Sclera', mats.sclera], ['Pupil', mats.pupil]] as const) {
            const mesh = group.getObjectByName(`${name}${suffix}`) as THREE.Mesh | undefined;
            if (!mesh || !(mesh as { isMesh?: boolean }).isMesh) continue;
            replaced.add(mesh.material as THREE.Material);
            mesh.material = mat;
        }
    }
    if (replaced.size === 0) {
        mats.sclera.dispose();
        mats.pupil.dispose();
        return false;
    }
    for (const old of replaced) old.dispose();
    return true;
}

/**
 * The eye controller a character carries, if it was built with eyes. Stashed on
 * the scene root by the loader so any per-frame owner can tick it.
 */
export function getVxlEyeController(root: THREE.Object3D): AnimalEyeController | null {
    const c = root.userData.eyeController;
    return c instanceof AnimalEyeController ? c : null;
}

/**
 * Rebind a controller to a root's OWN eye meshes, for a clone that kept the
 * meshes but not the controller (the original's controller points at the
 * original's meshes). Finds the pair by the names the builder gave them.
 * Returns null when the character has no usable eyes — `applyVxlEyeSpec` is
 * the entry point, and it only comes here once the pair is known to exist.
 */
function reconnectVxlCharacterEyes(root: THREE.Object3D): AnimalEyeController | null {
    const existing = getVxlEyeController(root);
    if (existing) return existing;
    const head = findVxlHeadBone(root);
    const [left, right] = EYE_GROUP_NAMES.map((name) => root.getObjectByName(name));
    if (!head || !left || !right) return null;
    // Structural check, never `instanceof`: a clone made by another `three`
    // module instance (SkeletonUtils resolved separately) is a real Mesh that
    // still fails the cross-instance prototype test.
    const part = (group: THREE.Object3D, suffix: string): THREE.Mesh | null => {
        const o = group.getObjectByName(`${group.name}${suffix}`);
        return o && (o as { isMesh?: boolean }).isMesh ? (o as THREE.Mesh) : null;
    };
    const leftPupil = part(left, 'Pupil');
    const rightPupil = part(right, 'Pupil');
    const leftSclera = part(left, 'Sclera');
    const rightSclera = part(right, 'Sclera');
    if (!leftPupil || !rightPupil || !leftSclera || !rightSclera) return null;
    // Track offset from the sclera's baked width — the geometry carries the size.
    // Guarded: a malformed bounding box must degrade to a small default, never
    // throw mid-spawn and take an NPC down with it.
    leftSclera.geometry.computeBoundingBox();
    const bb = leftSclera.geometry.boundingBox;
    const width = bb ? bb.max.x - bb.min.x : NaN;
    const trackOffset = Number.isFinite(width) && width > 0 ? width * PUPIL_TRACK_FRACTION : 0.01;
    const controller = new AnimalEyeController({ placement: 'front' });
    controller.setEyeReferences(head, left, right, leftPupil, rightPupil, leftSclera, rightSclera, trackOffset);
    root.userData.eyeController = controller;
    return controller;
}

/**
 * Per-frame blink + gaze. `gazeTarget` is the world point the character is
 * looking at — the player for an NPC, the aim point for the player — and may be
 * null (blink still runs, pupils rest centred). Pupils only move while the
 * target is within the controller's tracking distance of `selfPosition`.
 */
export function tickVxlCharacterEyes(
    root: THREE.Object3D,
    deltaTime: number,
    selfPosition: THREE.Vector3,
    gazeTarget: THREE.Vector3 | null,
): void {
    getVxlEyeController(root)?.update(deltaTime, selfPosition, gazeTarget);
}
