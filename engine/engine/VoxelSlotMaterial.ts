/**
 * Per-slot voxel materials — one material instance per named material slot, with
 * a LIVE emissive level and its own MATERIAL CLASS.
 *
 * This is the half of the material-slot feature that makes slots worth having:
 * the geometry in a slot is its own group with its own material, so changing
 * that material's emissive changes only those voxels, at any time, with no
 * geometry work. A beacon flashes by writing a number every frame; a parked
 * car's headlights go dark by writing zero.
 *
 * The slot's `materialClass` (`engine/VoxelMaterialClass.ts`) picks which of
 * three lighting models backs it, and that choice is the whole reason a voxel
 * sword's blade can shine while its grip does not:
 *
 *   'lambert'     — `MeshLambertMaterial` / `MeshLambertNodeMaterial`. The
 *                   default (`matte`), and byte-for-byte the material this file
 *                   built before classes existed.
 *   'direct'      — `MeshPhongMaterial` / `MeshPhongNodeMaterial`. A specular
 *                   highlight from the scene's real lights, and NO image-based
 *                   light: three routes `scene.environment` exclusively to
 *                   Standard/Physical, so picking Phong is the per-material
 *                   opt-out. Its diffuse response equals Lambert's, so such a
 *                   slot cannot tonally seam against the base group beside it.
 *   'environment' — `MeshPhysicalMaterial` / `MeshPhysicalNodeMaterial`, with
 *                   real reflections of `scene.environment`. For metal, gold,
 *                   chrome, gem and glass, where the reflection IS the material.
 *
 * Dual-path for both renderer backends (game/AGENTS.md dual-renderer rule):
 *
 *   WebGPU — a node material whose `emissiveNode` is the voxel's own albedo
 *            (`diffuseColor`) x a `uniform()` node. Note the base voxel material
 *            bakes `EMISSIVE_INTENSITY` in as a CONSTANT; a constant cannot be
 *            animated, which is exactly why slots carry a uniform.
 *   WebGL  — a classic material whose `emissive`/`emissiveIntensity` pair three
 *            already re-uploads every frame, with an `onBeforeCompile` making
 *            `totalEmissiveRadiance` the voxel's albedo x that uniform.
 *
 * The explicit dual path stays even though `VoxelSurfaceFinish` gets away
 * without one for its Phong/Physical paint materials. Stock three material types
 * really do auto-convert to their node equivalents under `three/webgpu`, but that
 * covers the LOBES only — the conversion drops `onBeforeCompile`, and the live
 * emissive above depends on it. `#include <emissivemap_fragment>` exists in
 * three's Phong and Physical fragment shaders as well as Lambert's, so the one
 * GLSL patch composes verbatim across all three tiers.
 *
 * As everywhere else in the voxel renderer, the glow is TINTED BY THE VOXEL'S
 * OWN COLOUR — a red beacon glows red, an amber indicator amber — so one slot
 * can hold a multi-coloured lightbar and each cell keeps its hue. That holds on
 * the Physical tier too: `emissivemap_fragment` runs before
 * `lights_physical_fragment`, so `diffuseColor.rgb` is still the albedo there and
 * a gold beacon glows gold rather than blowing out to white.
 */
import * as THREE from 'three';
import {
    MeshLambertNodeMaterial,
    MeshPhongNodeMaterial,
    MeshPhysicalNodeMaterial,
} from 'three/webgpu';
import { diffuseColor, uniform } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { isWebGpuActive } from 'engine/RendererType.js';
import { GLOW_GAIN_GLSL, glowGainNode, type VoxelMaterialParams } from 'engine/VoxelEmissiveMaterial.js';
import type { VoxelSlot } from 'engine/VoxelMaterialSlots.js';
import {
    clampVoxelMaterialLighting,
    DEFAULT_VOXEL_MATERIAL_CLASS,
    effectiveVoxelMaterialClassName,
    resolveVoxelMaterialClass,
    type VoxelMaterialClass,
    type VoxelMaterialClassName,
} from 'engine/VoxelMaterialClass.js';
import type { MaterialQuality } from 'engine/MaterialQuality.js';

/** See `VoxelEmissiveMaterial.EmissiveNodeCapable` — three ships no .d.ts for the node fields. */
interface EmissiveNodeCapable {
    emissiveNode: Node | null;
}

/** `userData` flag marking a material built for a named slot. */
export const VOXEL_SLOT_FLAG = 'voxelSlot';

/**
 * `userData` key holding the slot's CURRENT emissive level (the 0..1 control
 * value, kept in step with `setEmissive`).
 *
 * A material has to be able to describe its own slot, because derived copies
 * are built from the material alone: the instanced env path rebuilds every
 * material through `createFadedEnvMaterial`, and on WebGPU the live level lives
 * in a TSL uniform that cannot be read back off the material. Without this a
 * faded copy had no way to know it was a slot, let alone how brightly it glowed
 * — so every placed instance of a slotted asset rendered flat and unlit.
 */
export const VOXEL_SLOT_LEVEL = 'voxelSlotLevel';

/**
 * `userData` key holding the slot's STORED material class name.
 *
 * Present for exactly the reason `VOXEL_SLOT_LEVEL` is: `createFadedEnvMaterial`
 * rebuilds a slot material from the material alone, so without the class there
 * every PLACED instance of a gold asset comes back matte while the unplaced
 * original shines — the same failure mode that lost the glow before the level
 * was recorded here.
 *
 * The STORED name, not the effective one, so a rebuild re-derives the same
 * fallback from the same inputs rather than baking one decision in twice.
 */
export const VOXEL_SLOT_CLASS = 'voxelSlotClass';

/**
 * `userData` key recording whether this slot's shading-normal pass actually ran.
 *
 * Part of the rebuild contract above: it decides both the flat-vs-smooth shading
 * of the material and whether a reflection-only class falls back, so a faded copy
 * that guessed would shade differently from the original.
 */
export const VOXEL_SLOT_SMOOTHED = 'voxelSlotSmoothed';

/** What a slot material can say about itself — everything needed to rebuild it. */
export interface VoxelSlotInfo {
    name: string;
    /** Current emissive level, 0..1 (the `setEmissive` control value). */
    level: number;
    /** The STORED class name; `matte` when the material carries none. */
    materialClass: VoxelMaterialClassName | string;
    /** Whether this material's vertices got smoothed shading normals. */
    smoothed: boolean;
}

/** The slot a material belongs to, or null for an ordinary material. */
export function slotInfoFromMaterial(material: THREE.Material): VoxelSlotInfo | null {
    const name = material.userData?.[VOXEL_SLOT_FLAG];
    if (typeof name !== 'string') return null;
    const level = material.userData?.[VOXEL_SLOT_LEVEL];
    const materialClass = material.userData?.[VOXEL_SLOT_CLASS];
    return {
        name,
        level: typeof level === 'number' ? level : 0,
        materialClass: typeof materialClass === 'string' ? materialClass : DEFAULT_VOXEL_MATERIAL_CLASS,
        smoothed: material.userData?.[VOXEL_SLOT_SMOOTHED] === true,
    };
}

/**
 * A slot's material plus the one control it exists to provide. `setEmissive`
 * takes 0..1, where 1 is the same full-strength glow a baked-emissive voxel
 * has (`EMISSIVE_INTENSITY`), and values above 1 are allowed — an emergency
 * strobe reads better with a brief overdrive above the bloom threshold.
 */
export interface VoxelSlotMaterialHandle {
    readonly name: string;
    readonly material: THREE.Material;
    setEmissive(intensity: number): void;
    getEmissive(): number;
}

/**
 * Build the material for one named slot, starting at the slot's stored default
 * emissive (0..255 in the file, normalised to the 0..1 control range here) and
 * shaded by its material class.
 *
 * `smoothed` is whether this slot's vertices actually received smoothed shading
 * normals. It is required rather than assumed because it changes the look twice
 * over: an unsmoothed mesh keeps flat shading, and a class whose entire identity
 * is a mirror image (`chrome`) falls back rather than rendering as the six flat
 * reflection tones a voxel's six face normals produce.
 *
 * `quality` (`resolveMaterialQuality`) may clamp the class's lighting TIER at
 * construction — Physical down to Phong on 'medium', everything to Lambert on
 * 'low' — while the stored class name stays untouched, so a higher-quality load
 * of the same asset shines again with no re-bake.
 */
export function createVoxelSlotMaterial(
    params: VoxelMaterialParams,
    slot: VoxelSlot,
    smoothed: boolean,
    quality: MaterialQuality,
): VoxelSlotMaterialHandle {
    const initial = Math.max(0, slot.emissive) / 255;
    return buildSlotMaterial(params, {
        name: slot.name,
        level: initial,
        materialClass: slot.materialClass ?? DEFAULT_VOXEL_MATERIAL_CLASS,
        smoothed,
    }, quality);
}

/**
 * Rebuild a slot material from what an existing one said about itself — the
 * `createFadedEnvMaterial` path. Separate from {@link createVoxelSlotMaterial}
 * only because the level arrives already normalised to 0..1 rather than as a
 * stored 0..255 byte.
 */
export function createVoxelSlotMaterialFromInfo(
    params: VoxelMaterialParams,
    info: VoxelSlotInfo,
    quality: MaterialQuality,
): VoxelSlotMaterialHandle {
    return buildSlotMaterial(params, info, quality);
}

/**
 * Rebuild a slot material as a WEBGL one regardless of which backend the engine
 * is running, for the same reason `createWebGlVoxelMaterial` exists: the
 * offscreen thumbnail renderer owns a private `THREE.WebGLRenderer` and must have
 * classic materials even while the engine renders through WebGPU.
 * See `VoxelPreviewRenderer.useWebGlMaterials`.
 */
export function createWebGlVoxelSlotMaterial(
    params: VoxelMaterialParams,
    info: VoxelSlotInfo,
    quality: MaterialQuality,
): VoxelSlotMaterialHandle {
    return createWebGlSlotMaterial(params, info, effectiveSlotClass(info, quality));
}

/**
 * The class to BUILD: the stored name resolved through the smoothing fallback,
 * then the quality tier's lighting clamp. The clamp keeps every other parameter
 * — a gold slot on 'medium' becomes a Phong material with gold's own specular
 * numbers, a closer likeness than collapsing to a different class would be.
 */
function effectiveSlotClass(info: VoxelSlotInfo, quality: MaterialQuality): VoxelMaterialClass {
    const className = effectiveVoxelMaterialClassName(info.materialClass, info.smoothed);
    const cls = resolveVoxelMaterialClass(className);
    const lighting = clampVoxelMaterialLighting(cls.lighting, quality);
    return lighting === cls.lighting ? cls : { ...cls, lighting };
}

function buildSlotMaterial(
    params: VoxelMaterialParams,
    info: VoxelSlotInfo,
    quality: MaterialQuality,
): VoxelSlotMaterialHandle {
    const cls = effectiveSlotClass(info, quality);
    return isWebGpuActive()
        ? createNodeSlotMaterial(params, info, cls)
        : createWebGlSlotMaterial(params, info, cls);
}

/**
 * The shared constructor arguments for every tier.
 *
 * `flatShading` turns OFF once the smoothing pass has run, which is the whole
 * point of that pass: with flat shading three re-derives a face normal per
 * fragment and the smoothed attribute is ignored. It stays ON otherwise, and
 * that is not merely a safe default — the voxel meshers duplicate vertices per
 * face, so an unsmoothed mesh's four corners of a quad all carry the same normal
 * and smooth interpolation would produce the identical image anyway.
 */
function commonParameters(
    params: VoxelMaterialParams,
    info: VoxelSlotInfo,
): THREE.MeshLambertMaterialParameters {
    return {
        map: params.map,
        vertexColors: params.vertexColors,
        side: THREE.FrontSide,
        flatShading: params.flatShading && !info.smoothed,
        polygonOffset: true,
        polygonOffsetFactor: params.polygonOffsetFactor,
        polygonOffsetUnits: params.polygonOffsetUnits,
    };
}

/**
 * `albedoScale` as a tint colour, matching how `VoxelSurfaceFinish` applies it.
 *
 * `color` multiplies the atlas texel or vertex colour, so a value under 1 scales
 * the albedo back down by roughly the image-based irradiance a Lambert material
 * never received — see `VoxelPaintParams.albedoScale`. Returns undefined at 1 so
 * the untinted tiers construct exactly as they did before.
 */
function albedoTint(cls: VoxelMaterialClass): THREE.Color | undefined {
    return cls.albedoScale === 1 ? undefined : new THREE.Color().setScalar(cls.albedoScale);
}

/**
 * The sheen parameters for the 'environment' tier.
 *
 * Split out because it is the same three fields on both backends, and because the
 * interesting part is what it means when `sheen` is 0 — three's own default, and
 * the value every class but `fur` carries. So the five reflective classes
 * construct exactly the material they constructed before sheen existed, down to
 * the compiled program: `material.sheen > 0` is one of the FEATURES three's
 * program cache key already keys on.
 */
function sheenParameters(cls: VoxelMaterialClass): {
    sheen: number;
    sheenRoughness: number;
    sheenColor: THREE.Color;
} {
    return {
        sheen: cls.sheen,
        sheenRoughness: cls.sheenRoughness,
        sheenColor: new THREE.Color(cls.sheenColor),
    };
}

/** Stamp the self-description every rebuild path reads back. */
function tagSlotMaterial(mat: THREE.Material, info: VoxelSlotInfo): void {
    mat.userData[VOXEL_SLOT_FLAG] = info.name;
    mat.userData[VOXEL_SLOT_LEVEL] = info.level;
    mat.userData[VOXEL_SLOT_CLASS] = info.materialClass;
    mat.userData[VOXEL_SLOT_SMOOTHED] = info.smoothed;
}

/**
 * WebGL slot material. `material.emissive x material.emissiveIntensity` is
 * uploaded to the `emissive` uniform on every material refresh, so writing
 * `emissiveIntensity` is enough to animate the glow — no recompile, no
 * per-frame allocation. Identical across all three tiers, because every one of
 * three's lit fragment shaders carries `#include <emissivemap_fragment>`.
 */
function createWebGlSlotMaterial(
    params: VoxelMaterialParams,
    info: VoxelSlotInfo,
    cls: VoxelMaterialClass,
): VoxelSlotMaterialHandle {
    const common = commonParameters(params, info);
    const color = albedoTint(cls);
    const mat = cls.lighting === 'environment'
        ? new THREE.MeshPhysicalMaterial({
            ...common,
            ...(color ? { color } : {}),
            metalness: cls.metalness,
            roughness: cls.roughness,
            clearcoat: cls.clearcoat,
            clearcoatRoughness: cls.clearcoatRoughness,
            envMapIntensity: cls.envMapIntensity,
            ...sheenParameters(cls),
        })
        : cls.lighting === 'direct'
            ? new THREE.MeshPhongMaterial({
                ...common,
                ...(color ? { color } : {}),
                specular: new THREE.Color().setScalar(cls.specular),
                shininess: cls.shininess,
            })
            : new THREE.MeshLambertMaterial(common);

    mat.emissive = new THREE.Color(0xffffff);
    // Carries the 0..1 level only — the hue-preserving gain is per fragment.
    mat.emissiveIntensity = info.level;
    tagSlotMaterial(mat, info);
    mat.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <emissivemap_fragment>',
            `#include <emissivemap_fragment>\n  totalEmissiveRadiance = diffuseColor.rgb * emissive * ${GLOW_GAIN_GLSL};`,
        );
    };
    // A slot material MUST NOT share a compiled program with an ordinary material
    // of the same three type.
    //
    // three's own program cache key is built from the shaderID plus a bitmask of
    // material FEATURES (`getProgramCacheKeyBooleans`). Nothing about `emissive`
    // or `emissiveIntensity` is in it — only `emissiveMap`, which is null on both
    // — so a plain voxel `MeshLambertMaterial` and a slot one that injects
    // `totalEmissiveRadiance` above hash identically, and whichever compiles
    // first wins for both. They sit on the SAME mesh (group 0 is the plain base
    // material), so the loser is either a slot that stops glowing or a base group
    // that starts. The tier is in the key as well, so the three shapes this
    // factory can produce stay distinct even where their features coincide.
    //
    // The sheen the `fur` class carries needs nothing added here: `material.sheen
    // > 0` is one of the FEATURES three's own boolean bitmask already covers, so a
    // sheened Physical and a plain one never shared a program to begin with.
    mat.customProgramCacheKey = () => `voxelSlot:${cls.lighting}`;
    return {
        name: info.name,
        material: mat,
        setEmissive(intensity: number): void {
            const level = Math.max(0, intensity);
            mat.emissiveIntensity = level;
            mat.userData[VOXEL_SLOT_LEVEL] = level;
        },
        getEmissive(): number {
            return mat.emissiveIntensity;
        },
    };
}

/**
 * WebGPU slot material. The intensity lives in a `uniform()` node so the
 * compiled node graph never changes when the level does — only the uniform's
 * value, which is what a per-frame flash needs.
 */
function createNodeSlotMaterial(
    params: VoxelMaterialParams,
    info: VoxelSlotInfo,
    cls: VoxelMaterialClass,
): VoxelSlotMaterialHandle {
    const common = commonParameters(params, info);
    const color = albedoTint(cls);
    const mat: THREE.Material = cls.lighting === 'environment'
        ? new MeshPhysicalNodeMaterial({
            ...common,
            ...(color ? { color } : {}),
            metalness: cls.metalness,
            roughness: cls.roughness,
            clearcoat: cls.clearcoat,
            clearcoatRoughness: cls.clearcoatRoughness,
            envMapIntensity: cls.envMapIntensity,
            ...sheenParameters(cls),
        })
        : cls.lighting === 'direct'
            ? new MeshPhongNodeMaterial({
                ...common,
                ...(color ? { color } : {}),
                specular: new THREE.Color().setScalar(cls.specular),
                shininess: cls.shininess,
            })
            : new MeshLambertNodeMaterial(common);

    // The uniform is the 0..1 level; the gain that turns it into a glow is
    // derived per fragment from that fragment's albedo, so one slot holding a
    // multi-coloured lightbar lights every cell equally rather than favouring
    // whichever ones happen to be green.
    const intensityU = uniform(info.level);
    tagSlotMaterial(mat, info);
    (mat as unknown as EmissiveNodeCapable).emissiveNode =
        diffuseColor.rgb.mul(intensityU).mul(glowGainNode());
    return {
        name: info.name,
        material: mat,
        setEmissive(intensity: number): void {
            const level = Math.max(0, intensity);
            intensityU.value = level;
            mat.userData[VOXEL_SLOT_LEVEL] = level;
        },
        getEmissive(): number {
            return intensityU.value;
        },
    };
}
