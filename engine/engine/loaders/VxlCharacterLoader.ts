/**
 * Load a rigged VXL3 v10 `.vxl` as a character the engine can drive.
 *
 * The engine's character contract is a GLTF-shaped `{ scene, animations }` whose
 * scene holds a `mixamorig*`-named bone hierarchy plus geometry that follows it.
 * A v10 file already carries exactly that — a shared skeleton reference, the
 * body's own bind translations, and one joint per voxel — so this produces the
 * same shape rather than a parallel render path. Everything downstream
 * (`CharacterAnimationController`, the Mixamo blend stack, leg IK, weapon
 * attachment, grounding, ragdolls) then works unchanged.
 *
 * Geometry is cached per URL and SHARED across instances; only bones, sockets
 * and the mesh wrapper are per character. That is what makes an NPC crowd
 * affordable: a body is ~5 KB on the wire and one upload on the GPU no matter
 * how many of it are on screen.
 */
import * as THREE from 'three';
import { createClassedPartMaterial } from 'engine/ClassedPartMaterial.js';
import { activeMaterialQuality } from 'engine/DeviceQuality.js';
import { effectiveVoxelMaterialClassName } from 'engine/VoxelMaterialClass.js';
import { smoothSlotShadingNormals } from 'engine/VoxelSlotShading.js';
import { decodeVxlV3, type DecodedVxlV3 } from 'engine/VxlV3Format.js';
import { applyVxlEyeSpec, type VxlEyeSpec } from 'engine/loaders/VxlCharacterEyes.js';
import {
    assembleVxlJointMeshes,
    assembleVxlSkinnedMesh,
    buildVxlCharacterColumns,
    createVxlBindSkeleton,
    type BuildVxlCharacterOptions,
    type VxlCharacterColumns,
} from 'engine/VxlCharacterMesh.js';

/**
 * The first and last joint of the arm chain (`mixamorigLeftShoulder` through
 * `mixamorigRightHand`) in `mixamo-22-v1` order. Arms are excluded from the
 * capsule radius — see {@link measureVxlCharacter}.
 */
const ARM_JOINT_FIRST = 6;
const ARM_JOINT_LAST = 13;

/** Physics-capsule radius bounds, matching what the GLB character path clamps to. */
const MIN_CAPSULE_RADIUS = 0.2;
const MAX_CAPSULE_RADIUS = 0.8;

export interface VxlCharacterMeasurements {
    /** Full bind-pose height in metres. */
    height: number;
    /** Capsule radius, arms excluded. */
    radius: number;
    /** Bind-pose minimum Y — how far the feet sit below the model origin. */
    feetOffset: number;
}

export interface VxlCharacterTemplate {
    url: string;
    decoded: DecodedVxlV3;
    columns: VxlCharacterColumns;
    measurements: VxlCharacterMeasurements;
    /**
     * Bind-pose bounding box of the body, in model space, computed once per
     * template from the vertex columns. Every instance and every clone gets a
     * copy stamped on its SkinnedMesh — without it three's
     * `SkinnedMesh.computeBoundingBox` runs the full skinning transform over
     * every vertex (~110k for a library body) the first time anything calls
     * `Box3.setFromObject` on the character, which the NPC path does for each
     * of its clones (measured: ~21 ms per spawn, 10 s for a 500-strong crowd).
     */
    bindBox: THREE.Box3;
    /** Voxel level the columns were built from (see `DeviceQualityPolicy.deferred.characterBodyLod`). */
    lod: number;
    /**
     * One material per geometry group — `[0]` the base body Lambert, `[i + 1]`
     * named slot `i`'s classed material (v11 material classes). A class-free
     * body has exactly the one Lambert it always had. Shared by every
     * instance of this body, never disposed per character.
     */
    materials: THREE.Material[];
}

/** A loaded character in the shape the engine's GLB path hands back. */
export interface VxlCharacterModel {
    scene: THREE.Object3D;
    animations: THREE.AnimationClip[];
}

/**
 * True for a URL the vxl character path should handle.
 *
 * The query string is stripped first: asset URLs routinely carry a cache-busting
 * `?v=` and matching on the raw string would send `body.vxl?v=3` down the GLB
 * loader, which fails with a parse error that says nothing about why.
 */
export function isVxlCharacterUrl(url: string): boolean {
    const path = url.split(/[?#]/, 1)[0] ?? '';
    return path.toLowerCase().endsWith('.vxl');
}

/**
 * Measure the body for the physics capsule.
 *
 * The radius deliberately IGNORES the arms. These bodies are stored in a T-pose,
 * so the full bounding box is up to 2.65 m wide and a radius taken from it puts
 * a 1.6 m-wide capsule around a 1.7 m-tall character — it would catch on every
 * doorway. The torso-and-legs extent is what the character actually occupies once
 * the arms drop into any real pose.
 */
export function measureVxlCharacter(decoded: DecodedVxlV3): VxlCharacterMeasurements {
    const buf = decoded.fragments[0]?.leaves;
    if (!decoded.rig || !buf) throw new Error('vxl character: file carries no rig');
    const size = buf.minVoxelSize;
    const bones = buf.bone;

    let minY = Infinity, maxY = -Infinity;
    let bodyMinX = Infinity, bodyMaxX = -Infinity, bodyMinZ = Infinity, bodyMaxZ = -Infinity;
    for (let i = 0; i < buf.count; i++) {
        const y = buf.worldY(i);
        if (y < minY) minY = y;
        if (y + size > maxY) maxY = y + size;
        const joint = bones?.[i] ?? 0;
        if (joint >= ARM_JOINT_FIRST && joint <= ARM_JOINT_LAST) continue;
        const x = buf.worldX(i), z = buf.worldZ(i);
        if (x < bodyMinX) bodyMinX = x;
        if (x + size > bodyMaxX) bodyMaxX = x + size;
        if (z < bodyMinZ) bodyMinZ = z;
        if (z + size > bodyMaxZ) bodyMaxZ = z + size;
    }
    // A body with no non-arm voxels is not a thing the corpus contains, but a
    // corrupt bone column could produce one; fall back to the full extent rather
    // than an Infinity that would poison the physics body.
    const width = Number.isFinite(bodyMaxX - bodyMinX) ? bodyMaxX - bodyMinX : 0;
    const depth = Number.isFinite(bodyMaxZ - bodyMinZ) ? bodyMaxZ - bodyMinZ : 0;
    const radius = THREE.MathUtils.clamp(
        Math.max(width, depth) / 2 * 1.1,
        MIN_CAPSULE_RADIUS,
        MAX_CAPSULE_RADIUS,
    );
    return { height: maxY - minY, radius, feetOffset: minY };
}

const decodedFiles = new Map<string, Promise<DecodedVxlV3>>();
const templates = new Map<string, Promise<VxlCharacterTemplate>>();

/**
 * Fetch, decode and prepare a character, once per URL and voxel level.
 *
 * The promise itself is cached, not just its result, so two NPCs spawned in the
 * same frame share one fetch instead of racing. A failed load is evicted so a
 * transient network error does not poison the URL for the session. The decode
 * is cached per URL beneath the templates, so a body used at two levels (the
 * NPC tier's body and the crowd batch's source) is fetched and decoded once.
 *
 * `lod` is the voxel level to build from (0 = full detail); a file without that
 * level yields the finest it has, and the template's `lod` says which.
 */
export function loadVxlCharacterTemplate(url: string, lod: number = 0): Promise<VxlCharacterTemplate> {
    const key = `${url}#lod${lod}`;
    const cached = templates.get(key);
    if (cached) return cached;
    const pending = buildTemplate(url, lod).catch((error: unknown) => {
        templates.delete(key);
        throw error;
    });
    templates.set(key, pending);
    return pending;
}

function loadDecodedVxl(url: string): Promise<DecodedVxlV3> {
    const cached = decodedFiles.get(url);
    if (cached) return cached;
    const pending = (async () => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`vxl character: ${url} — HTTP ${response.status}`);
        return decodeVxlV3(await response.arrayBuffer());
    })().catch((error: unknown) => {
        decodedFiles.delete(url);
        throw error;
    });
    decodedFiles.set(url, pending);
    return pending;
}

/**
 * Build the columns from the coarsest level at or below `requestedLod` that the
 * file can actually produce, and report which level that was.
 *
 * A file may declare fewer levels than asked for, or carry a coarse level
 * without a bone column — neither can drive a rig, so both step down one level
 * at a time. LOD 0 always exists, so its failure is the file's failure and the
 * error propagates.
 */
export function buildVxlColumnsAtLod(
    decoded: DecodedVxlV3,
    requestedLod: number,
    options: Omit<BuildVxlCharacterOptions, 'lod'> = {},
): { columns: VxlCharacterColumns; lod: number } {
    const available = decoded.additionalLods?.length ?? 0;
    let lod = Math.max(0, Math.min(Math.floor(requestedLod), available));
    for (;;) {
        try {
            return { columns: buildVxlCharacterColumns(decoded, { ...options, lod }), lod };
        } catch (error) {
            if (lod === 0) throw error;
            lod--;
        }
    }
}

async function buildTemplate(url: string, requestedLod: number): Promise<VxlCharacterTemplate> {
    const decoded = await loadDecodedVxl(url);
    if (!decoded.rig) {
        throw new Error(`vxl character: ${url} carries no rig — it is a static voxel asset, not a v10 character`);
    }
    const { columns, lod } = buildVxlColumnsAtLod(decoded, requestedLod);

    // Quality resolved once per TEMPLATE (bodies are shared across instances),
    // the `EnvDistanceFade` precedent — a mid-session quality change reaches
    // the next body loaded, not ones already on screen.
    const quality = activeMaterialQuality();
    const slots = decoded.slots ?? [];

    // Shading-normal smoothing for slots whose class wants it (a voxel body has
    // six face normals; unsmoothed metal reads as six flat tones). Runs once
    // per template, only when classed slots exist — a class-free body's
    // normals are untouched, byte for byte.
    const smoothed: boolean[] = slots.length === 0 ? [] : smoothSlotShadingNormals({
        positions: columns.position,
        normals: columns.normal,
        indices: columns.index,
        slots,
        groups: columns.groups,
        voxelSize: decoded.fragments[0]!.leaves.minVoxelSize,
        materialQuality: quality,
    }).smoothed;

    // Base body: Lambert rather than the engine's voxel NodeMaterial — this has
    // to skin on both the WebGL and WebGPU backends, and three's own materials
    // are the ones that do. Vertex colours carry the whole look. Classed slots
    // ride `createClassedPartMaterial` (stock classic materials, the same
    // both-backend reasoning), with the smoothing fallback applied when their
    // pass did not run, and STATIC glow from the slot's shipped emissive —
    // live `setSlotEmissive` has no machinery on the character path.
    const materials: THREE.Material[] = [
        new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
        ...slots.map((slot, i) => {
            const isSmoothed = smoothed[i] === true;
            return createClassedPartMaterial(
                effectiveVoxelMaterialClassName(slot.materialClass, isSmoothed),
                {
                    color: 0xffffff,
                    glow: slot.emissive / 255,
                    vertexColors: true,
                    flatShading: !isSmoothed,
                },
                quality,
            );
        }),
    ];
    return {
        url,
        decoded,
        columns,
        measurements: measureVxlCharacter(decoded),
        // Bind-pose bounds straight from the vertex columns: at bind every
        // joint's `matrixWorld * boneInverse` is the identity, so the skinned
        // position IS the column position — a plain min/max, no bone math.
        bindBox: new THREE.Box3().setFromArray(columns.position),
        lod,
        materials,
    };
}

export interface InstantiateVxlOptions {
    /**
     * Build one rigid mesh per joint instead of a single skinned mesh. The
     * reference form `vxl-v10-character-demo.html` proved out, kept as the escape
     * hatch if skinning ever misbehaves on a backend. Costs ~28 draw calls per
     * character instead of one, and loses `BoneVoxelShatter`.
     */
    rigidJointMeshes?: boolean;
}

/**
 * Build one drivable character from a prepared template.
 *
 * Sockets become empty `Object3D`s parented to their joint, so a procedurally
 * re-added tail or a swapped head is `socket.add(mesh)` and needs no new API.
 * They are named exactly as the file names them, which is why they are added
 * BEFORE `applyCanonicalBoneAliases` runs: every corpus body carries a `head`
 * socket on `mixamorigHead` at zero offset, which is precisely the canonical
 * `head` alias, and that pass skips a name a bone already has. The two compose
 * instead of producing two objects that answer to the same `getObjectByName`.
 */
export function instantiateVxlCharacter(
    template: VxlCharacterTemplate,
    options: InstantiateVxlOptions = {},
): VxlCharacterModel {
    const rig = template.decoded.rig!;
    const skeleton = createVxlBindSkeleton(rig);

    if (options.rigidJointMeshes) {
        // The rigid escape hatch renders everything with the base material —
        // a documented limitation; classed slots need the skinned form.
        assembleVxlJointMeshes(template.columns, skeleton, template.materials[0]!);
    } else {
        const body = assembleVxlSkinnedMesh(
            template.columns,
            skeleton,
            template.materials.length > 1 ? template.materials : template.materials[0]!,
        );
        // Pre-stamped so `Box3.setFromObject` never walks the vertices; SkinnedMesh.copy
        // carries it to every SkeletonUtils clone (see `VxlCharacterTemplate.bindBox`).
        body.boundingBox = template.bindBox.clone();
        skeleton.root.add(body);
    }

    const offset = new THREE.Vector3();
    const toBoneLocal = new THREE.Matrix4();
    for (const socket of rig.sockets) {
        const bone = skeleton.bones[socket.joint];
        if (!bone) continue;
        const node = new THREE.Object3D();
        node.name = socket.name;
        // `offset` is in MODEL space, the same space as bindPositions, and the
        // bone it hangs off is not at the origin — so it has to come back through
        // that bone's bind transform to become a local position.
        offset.set(socket.offset[0], socket.offset[1], socket.offset[2])
            .applyMatrix4(toBoneLocal.copy(bone.matrixWorld).invert());
        node.position.copy(offset);
        bone.add(node);
    }
    skeleton.root.updateMatrixWorld(true);

    // Eyes are metadata (VxlV3Eyes), drawn here as a replaceable, blinking pair
    // on the head bone rather than baked into the mesh. Positional animation is
    // free (they parent to the bone); blink/gaze need a per-frame tick from the
    // owner (see tickVxlCharacterEyes).
    const { eyes, bounds, minVoxelSize } = template.decoded;
    if (eyes) {
        // Stashed as plain data so a cloning consumer (NPC crowds: SkeletonUtils
        // drops the eye meshes AND userData from each clone) can re-dress its
        // clones from the template — with the very same call that dresses this
        // instance, so there is one way to build a character's eyes.
        const spec: VxlEyeSpec = {
            eyes,
            bounds: { minX: bounds.minX, minY: bounds.minY, minZ: bounds.minZ },
            minVoxelSize,
        };
        skeleton.root.userData.vxlEyeSpec = spec;
        applyVxlEyeSpec(skeleton.root, spec);
    }

    skeleton.root.userData.isVxlCharacter = true;
    skeleton.root.userData.vxlMeasurements = template.measurements;
    // The url is the key to everything shared per body type — the crowd
    // variant (VxlCrowdVariant) looks the template back up by it.
    skeleton.root.userData.vxlTemplateUrl = template.url;
    return { scene: skeleton.root, animations: [] };
}

/** Test seam — drops every cached template so a test can re-stub `fetch`. */
export function clearVxlCharacterTemplateCache(): void {
    templates.clear();
    decodedFiles.clear();
}
