/**
 * VxlCrowdVariant — a rigged `.vxl` body as a GPU-posed crowd batch.
 *
 * A `.vxl` v10 character is the ideal crowd member: every voxel belongs to
 * exactly ONE joint and there is no weight blending, so `CrowdSkinnedMaterial`'s
 * single-fetch pose is lossless for it — the same property CrowdMeshBake relies
 * on for block characters, but here it comes straight from the file format
 * (`columns.joint`) instead of from a part-group merge. All bodies also share
 * one vertex-colour Lambert look, so a whole body TYPE is one geometry, one
 * material, one instanced draw, and zero CPU posing per NPC.
 *
 * What the articulated path costs instead, measured with 494 wandering
 * townsfolk: ~27 ms a frame of scene-graph matrix updates (21,900 bones) plus
 * ~14 ms of `blendBoneTransforms` posing, with every 109k–480k-vertex body
 * submitted every frame because posed skinned meshes cannot be frustum culled.
 *
 * ## The two bakes, once per body type
 *
 * - GEOMETRY (`buildVxlCrowdGeometry`): the file's own coarser voxel LOD when it
 *   has one (a crowd member is by definition beyond the ring-1 distance), with
 *   each vertex moved into its joint's BIND-LOCAL space — the bind inverse baked
 *   in once, so the vertex shader does one matrix fetch and one multiply. The
 *   named-slot material classes (v11 metal, glow) are flattened onto the base
 *   Lambert here: a crowd body is a distant silhouette, and one material is what
 *   makes it one draw.
 * - ANIMATION (`bakeVxlCrowdTable`): the required locomotion clips sampled at
 *   30 Hz into the same column-major bone table CrowdAnimationBake produces,
 *   posed through the SAME Mixamo players and the SAME rotation retarget the
 *   articulated skeleton uses (`CharacterLoader.applyPoseRotations`), with the
 *   lowest foot planted at y = 0 per frame exactly as `updateSkinnedCharacter`
 *   plants it. That is what makes the swap between the two tiers seamless: a
 *   townsperson crossing the ring boundary changes draw path, not pose.
 *
 * ## Who swaps
 *
 * NpcController owns membership. A crowd-tier NPC whose DISTANCE ring is 2
 * acquires a slot, hides its skinned body and freezes that subtree's matrix
 * updates; when it comes nearer (or dies, arms itself, takes a pose override,
 * hibernates) it releases the slot and the articulated body takes over with its
 * last pose intact. Distance ring rather than the frustum-forced effective ring:
 * the LOD-1 mesh differs slightly from the LOD-0 body, and that pop belongs
 * 60 m away, not at the screen edge 5 m from the camera.
 */
import * as THREE from 'three';
import type { EngineLike, BaseAnimationDefinition } from 'types/game.js';
import type { DecodedVxlV3 } from 'engine/VxlV3Format.js';
import { createVxlBindSkeleton, type VxlBindSkeleton } from 'engine/VxlCharacterMesh.js';
import { buildVxlColumnsAtLod, loadVxlCharacterTemplate } from 'engine/loaders/VxlCharacterLoader.js';
import { CharacterLoader } from 'engine/loaders/CharacterLoader.js';
import { cachedGLTFLoad, type CachedGLTF } from 'engine/animation/AnimationContext.js';
import { buildAnimationList } from 'engine/AnimationPacks.js';
import {
    packAnimationTexture,
    type BakedAnimationTable,
    type BakedClipRange,
} from 'engine/npc/crowd/CrowdAnimationBake.js';
import { createCrowdSkinnedMaterial, CROWD_BONE_INDEX_ATTRIBUTE } from 'engine/npc/crowd/CrowdSkinnedMaterial.js';
import { getGlobalCrowdRenderer } from 'engine/npc/crowd/CrowdRenderer.js';

/** One body type, registered with the global CrowdRenderer under `key`. */
export interface VxlCrowdVariant {
    /** CrowdRenderer variant name — `vxl:` + the template url. */
    key: string;
    geometry: THREE.BufferGeometry;
    material: THREE.Material;
    table: BakedAnimationTable;
    /** Clip row per locomotion motionId (see buildAnimationList). */
    clipIndexByMotionId: Map<string, number>;
    /** The clip a member falls back to when its state has no baked clip. */
    idleClipIndex: number;
    /** Voxel LOD the geometry was built from (0 = full detail). */
    lod: number;
}

/** What the geometry bake needs from a template — narrow so tests can hand it a fixture. */
export type VxlCrowdGeometrySource = { decoded: DecodedVxlV3; bindBox: THREE.Box3 };

/** A clip to bake, and whether sampling wraps past its end. */
export interface VxlCrowdClip {
    motionId: string;
    /** Seconds; frames are `ceil(duration * fps)`, at least one. */
    duration: number;
    loop: boolean;
}

/** Sample rate of the bone table. 30 Hz is ample for bodies beyond 60 m. */
export const VXL_CROWD_TABLE_FPS = 30;

/**
 * Pose margin added to the bind-box half-diagonal for the batch's bounding
 * sphere: swinging arms and a jump reach further than any bind pose does, and
 * an InstancedMesh with a too-small sphere frustum-culls the whole crowd at
 * the screen edge.
 */
const POSE_MARGIN_M = 0.35;

/**
 * Build the crowd geometry for a body: the coarsest voxel level the file
 * carries (capped at `preferredLod`), vertices in bind-local joint space, one
 * `boneIndex` per vertex.
 *
 * `buildVxlColumnsAtLod` falls back level by level to LOD 0 when a coarser level
 * is missing or lacks a bone column — an older file is still a valid crowd body,
 * just a denser one.
 */
export function buildVxlCrowdGeometry(
    template: VxlCrowdGeometrySource,
    preferredLod = 1,
): { geometry: THREE.BufferGeometry; boneCount: number; lod: number } {
    const rig = template.decoded.rig;
    if (!rig) throw new Error('vxl crowd: template carries no rig');
    // Fillers are LOD-0 joint-wedge detail; a crowd body is drawn from beyond
    // ring 1, where a hairline gap at a bent elbow is sub-pixel.
    const { columns, lod } = buildVxlColumnsAtLod(template.decoded, preferredLod, { includeFillers: false });

    const skeleton = createVxlBindSkeleton(rig);
    const boneCount = skeleton.bones.length;
    const invBind = skeleton.bones.map((b) => b.matrixWorld.clone().invert());
    const invBindNormal = invBind.map((m) => new THREE.Matrix3().getNormalMatrix(m));

    const vertexCount = columns.joint.length;
    const position = new Float32Array(vertexCount * 3);
    const normal = new Float32Array(vertexCount * 3);
    const boneIndex = new Float32Array(vertexCount);
    const v = new THREE.Vector3();
    for (let i = 0; i < vertexCount; i++) {
        const joint = columns.joint[i]!;
        v.fromArray(columns.position, i * 3).applyMatrix4(invBind[joint]!);
        v.toArray(position, i * 3);
        v.fromArray(columns.normal, i * 3).applyMatrix3(invBindNormal[joint]!).normalize();
        v.toArray(normal, i * 3);
        boneIndex[i] = joint;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(columns.color.slice(), 3));
    // Float rather than the file's Uint8: the shaders declare the attribute as
    // float on both backends, and 4 bytes a vertex is nothing next to the rest.
    geometry.setAttribute(CROWD_BONE_INDEX_ATTRIBUTE, new THREE.BufferAttribute(boneIndex, 1));
    geometry.setIndex(new THREE.BufferAttribute(
        vertexCount > 65535 ? columns.index.slice() : Uint16Array.from(columns.index),
        1,
    ));
    // Bind-local positions cluster around each joint, so three's own sphere
    // from them would be far too small for the posed body. Size it from the
    // model-space bind box plus a pose margin instead.
    const center = template.bindBox.getCenter(new THREE.Vector3());
    const radius = template.bindBox.getSize(new THREE.Vector3()).length() / 2 + POSE_MARGIN_M;
    geometry.boundingSphere = new THREE.Sphere(center, radius);
    geometry.boundingBox = template.bindBox.clone().expandByScalar(POSE_MARGIN_M);
    return { geometry, boneCount, lod };
}

/**
 * Sample clips into the crowd bone table. `poseAt(clip, t)` must leave the
 * skeleton's bones in that frame's pose (local transforms; this function
 * refreshes world matrices). Layout matches CrowdAnimationBake exactly —
 * column-major 4x4 per bone, frame-major within a clip, clips concatenated —
 * so `resolveFrameRow` and `packAnimationTexture` apply unchanged.
 *
 * Pure apart from the skeleton it drives, which is what lets a test feed it a
 * synthetic poser instead of loaded animation files.
 */
export function bakeVxlCrowdTable(
    skeleton: VxlBindSkeleton,
    clips: readonly VxlCrowdClip[],
    poseAt: (clipIndex: number, timeSeconds: number) => void,
    fps: number = VXL_CROWD_TABLE_FPS,
): BakedAnimationTable {
    const boneCount = skeleton.bones.length;
    const ranges: BakedClipRange[] = [];
    let frameCursor = 0;
    for (const clip of clips) {
        const frameCount = Math.max(1, Math.ceil(clip.duration * fps));
        ranges.push({ name: clip.motionId, frameOffset: frameCursor, frameCount, duration: clip.duration, loop: clip.loop });
        frameCursor += frameCount;
    }
    const data = new Float32Array(frameCursor * boneCount * 16);
    for (let c = 0; c < clips.length; c++) {
        const range = ranges[c]!;
        for (let f = 0; f < range.frameCount; f++) {
            poseAt(c, f / fps);
            skeleton.root.updateMatrixWorld(true);
            const base = (range.frameOffset + f) * boneCount * 16;
            for (let b = 0; b < boneCount; b++) {
                skeleton.bones[b]!.matrixWorld.toArray(data, base + b * 16);
            }
        }
    }
    return { data, clips: ranges, boneCount, frameCount: frameCursor, fps };
}

/**
 * The poser the articulated path is equivalent to: the clip's Mixamo skeleton
 * at time `t`, its world rotations retargeted onto the vxl bones with bind
 * limb lengths kept, then the lowest foot planted on y = 0.
 */
function poseSkeletonFromPlayer(
    skeleton: VxlBindSkeleton,
    player: MixamoPlayerLike,
    timeSeconds: number,
): void {
    player.setTime(timeSeconds);
    player.getSkeletonRoot()?.updateMatrixWorld(true);
    const mixamoBones = player.getBoneMap();
    const pose = new Map<string, { position: THREE.Vector3; rotation: THREE.Quaternion }>();
    for (const bone of skeleton.bones) {
        const source = CharacterLoader.resolveMixamoBone(bone.name, mixamoBones);
        if (!source) continue;
        pose.set(bone.name, {
            position: source.getWorldPosition(new THREE.Vector3()),
            rotation: source.getWorldQuaternion(new THREE.Quaternion()),
        });
    }
    const root = skeleton.root;
    root.position.set(0, 0, 0);
    root.updateMatrixWorld(true);
    CharacterLoader.applyPoseRotations(root, pose);
    root.updateMatrixWorld(true);
    let lowestFootY = Infinity;
    const foot = new THREE.Vector3();
    for (const name of CharacterLoader.FOOT_BONE_NAMES) {
        const bone = root.getObjectByName(name);
        if (!bone) continue;
        bone.getWorldPosition(foot);
        if (foot.y < lowestFootY) lowestFootY = foot.y;
    }
    if (lowestFootY !== Infinity) root.position.y = -lowestFootY;
}

/** The slice of MixamoAnimationPlayer the bake drives — kept narrow so the class stays a lazy import. */
interface MixamoPlayerLike {
    setTime(time: number): void;
    getSkeletonRoot(): THREE.Object3D | null;
    getBoneMap(): Map<string, THREE.Bone>;
    getDuration(): number;
}

/** Locomotion clips that loop; the jump clamps on its last frame. */
const LOOPING_CLIP_NAMES = new Set(['Walk', 'SlowRun', 'FastRun', 'Idle']);

const variants = new Map<string, Promise<VxlCrowdVariant | null>>();

/**
 * Build and register the crowd variant for a `.vxl` body, once per url. The
 * promise is cached so every NPC of the type shares one bake; a failed bake
 * resolves null (the NPC keeps rendering articulated) and is evicted so a later
 * spawn can retry after a transient load error.
 *
 * Needs `engine.scene` for the batch's parent and `engine.loader` for the clip
 * GLBs; without either it resolves null without caching.
 */
export function ensureVxlCrowdVariant(templateUrl: string, engine: EngineLike): Promise<VxlCrowdVariant | null> {
    const cached = variants.get(templateUrl);
    if (cached) return cached;
    const scene = engine.scene;
    const loader = engine.loader as { loadAsync: (url: string) => Promise<CachedGLTF> } | null | undefined;
    if (!scene || !loader) return Promise.resolve(null);
    const pending = buildVariant(templateUrl, scene, loader).catch((error: unknown) => {
        console.warn(`[VxlCrowd] variant bake failed for ${templateUrl} — NPCs of this body stay articulated:`, error);
        variants.delete(templateUrl);
        return null;
    });
    variants.set(templateUrl, pending);
    return pending;
}

async function buildVariant(
    templateUrl: string,
    scene: THREE.Scene,
    loader: { loadAsync: (url: string) => Promise<CachedGLTF> },
): Promise<VxlCrowdVariant | null> {
    const template = await loadVxlCharacterTemplate(templateUrl);
    const rig = template.decoded.rig;
    if (!rig) return null;

    const defs = buildAnimationList().filter((d): d is BaseAnimationDefinition & { animationUrl: string } => !!d.animationUrl);
    const gltfs = await Promise.all(defs.map((d) => cachedGLTFLoad(loader, d.animationUrl)));
    // Lazy, like every other importer of the player: `three/webgpu`-free modules
    // must not pull it in at load (see AnimationOverrideSystem).
    const { MixamoAnimationPlayer } = await import('engine/MixamoAnimationPlayer.js');

    const scratchScene = new THREE.Scene();
    const origin = new THREE.Object3D();
    const players: Array<InstanceType<typeof MixamoAnimationPlayer>> = [];
    const clips: VxlCrowdClip[] = [];
    const clipIndexByMotionId = new Map<string, number>();
    for (let i = 0; i < defs.length; i++) {
        const def = defs[i]!;
        const gltf = gltfs[i]!;
        const player = new MixamoAnimationPlayer();
        if (!player.loadFromGLTF(gltf.scene, gltf.animations, scratchScene, origin, template.measurements.height)) {
            player.dispose();
            continue;
        }
        player.setAnimationName(def.motionId);
        const loop = LOOPING_CLIP_NAMES.has(def.name);
        player.setLoop(loop);
        // Zero blend-in so the very first sampled frame is the clip at full weight.
        player.play(undefined, 0, 0);
        clipIndexByMotionId.set(def.motionId, clips.length);
        clips.push({ motionId: def.motionId, duration: player.getDuration(), loop });
        players.push(player);
    }
    if (clips.length === 0) return null;

    const skeleton = createVxlBindSkeleton(rig);
    const table = bakeVxlCrowdTable(skeleton, clips, (c, t) => poseSkeletonFromPlayer(skeleton, players[c]!, t));
    for (const p of players) p.dispose();

    const { geometry, boneCount, lod } = buildVxlCrowdGeometry(template);
    const material = createCrowdSkinnedMaterial({
        boneTexture: packAnimationTexture(table),
        boneCount,
        frameCount: table.frameCount,
    });
    const key = `vxl:${templateUrl}`;
    getGlobalCrowdRenderer().registerVariant(key, geometry, material, scene);

    const idleClipIndex = clipIndexByMotionId.get('mIdleDefault01') ?? 0;
    console.log(`[VxlCrowd] variant ready: ${templateUrl.split('/').pop()} — LOD ${lod}, ${geometry.index!.count / 3} tris, ${clips.length} clips, ${table.frameCount} frames`);
    return { key, geometry, material, table, clipIndexByMotionId, idleClipIndex, lod };
}

/** Test seam — forget every baked variant so a test can rebuild against fresh stubs. */
export function clearVxlCrowdVariantCache(): void {
    variants.clear();
}
