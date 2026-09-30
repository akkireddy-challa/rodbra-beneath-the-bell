/**
 * Classed materials for PRIMITIVE-mesh parts — the material-class vocabulary
 * (`engine/VoxelMaterialClass.ts`) applied to hand-built or imported THREE
 * geometry rather than voxels. A part says `'metal'` or `'wood'` instead of
 * hand-tuned metalness/roughness numbers, shades the way a classed voxel of the
 * same class does, and rides the MaterialQuality ladder
 * (`engine/MaterialQuality.ts`). Weapons were the first consumer
 * (`engine/WeaponPartMaterial.ts`, now a re-exporting wrapper over this core);
 * vehicle wheels and character parts followed.
 *
 * Deliberately SINGLE-PATH on both renderer backends (docs/renderer-backends.md):
 * stock three material types auto-convert to their node equivalents under
 * `three/webgpu`, and the conversion covers the lobes — what it drops is
 * `onBeforeCompile`, which this module never uses. A part's glow is a static
 * `emissive` + `emissiveIntensity` pair fixed at build time; there is no atlas,
 * no per-vertex emissive, no live level. The same reasoning `VoxelSurfaceFinish`
 * ships on, and the opposite of why `VoxelSlotMaterial` keeps its dual path.
 * This also covers SKINNED meshes: skinning is driven by the mesh type, not a
 * material flag, and imported Standard/Physical players already skin on both
 * backends through the same auto-conversion.
 *
 * Also deliberately absent, versus `VoxelSlotMaterial`:
 *  - the smoothing fallback (`effectiveVoxelMaterialClassName` / `mobileFallback`).
 *    That fallback exists because a voxel mesh has exactly six face normals, so an
 *    unsmoothed reflective class samples the environment in three directions and
 *    reads as flat paint. Primitive geometry (boxes, cylinders, spheres) carries
 *    real normals, so `chrome` on a phone should clamp to Phong chrome — a tight
 *    travelling highlight — rather than turn into plastic. A caller whose
 *    geometry IS six-normal voxels (the rigged-`.vxl` character path) resolves
 *    the fallback itself before naming the class here.
 */
import * as THREE from 'three';
import type { MaterialQuality } from 'engine/MaterialQuality.js';
import { activeMaterialQuality } from 'engine/DeviceQuality.js';
import { EMISSIVE_INTENSITY } from 'engine/VoxelEmissiveMaterial.js';
import {
    clampVoxelMaterialLighting,
    defaultGlowForVoxelMaterialClass,
    normalizeVoxelMaterialClassName,
    resolveVoxelMaterialClass,
    type VoxelMaterialClass,
} from 'engine/VoxelMaterialClass.js';

/**
 * `userData` keys — a classed part material describes itself, for the same
 * reason a slot material does (`VoxelSlotMaterial.VOXEL_SLOT_CLASS`): derived
 * copies are rebuilt from the material alone. `clampWeaponPartMaterialsToDirect`
 * reads these to rebuild an environment-tier part at the direct tier, and an
 * untagged material (an old-style hand-tuned custom) is left untouched.
 *
 * The stored STRINGS keep their original weapon-era values: frozen template
 * code in published games may read the raw keys, so the rename to neutral
 * constant names must not change what lands in `userData`.
 */
export const CLASSED_PART_CLASS = 'weaponPartClass';
/** The caller's part colour (a number), pre-`albedoScale`. */
export const CLASSED_PART_COLOR = 'weaponPartColor';
/** The resolved glow level, 0..1+ of the voxel full-glow. */
export const CLASSED_PART_GLOW = 'weaponPartGlow';

export interface ClassedPartMaterialOptions {
    /**
     * Part albedo — or, for the high-metalness classes, the reflection tint
     * that makes gold read as gold rather than yellow plastic. Required: a
     * part always picks its colour; the class only decides how it shades.
     */
    color: number;
    /**
     * Emissive level, 0..1+ of the voxel full-glow (`EMISSIVE_INTENSITY`), the
     * glow tinted by the part's own colour. The default is CLASS-DERIVED —
     * `defaultGlowForVoxelMaterialClass(className) / 255` — so naming `'neon'`
     * is enough to glow and `'metal'` never does; pass an explicit value to
     * tune it, or `0` to silence a glowing class.
     *
     * Optional-with-a-derived-default is a deliberate deviation from
     * `docs/engine-options-pattern.md`: the default depends on the OTHER
     * argument, which a `DEFAULT_*` constant cannot express.
     */
    glow?: number;
    /**
     * Bind per-vertex colours (`COLOR_0`): effective albedo = `color` ×
     * vertex colour. Character bodies carry their whole look there, so their
     * classed parts pass `true` with a white `color`. Optional-with-default
     * (false) rather than required because this interface is the shipped
     * `WeaponPartMaterialOptions`, which frozen weapon code already constructs
     * — the backward-compat rule allows only optional additions.
     */
    vertexColors?: boolean;
    /**
     * Flat (per-face) shading — the rigged-`.vxl` character look when the slot
     * was not normal-smoothed. Optional for the same shipped-interface reason
     * as `vertexColors`; default false matches every existing caller.
     */
    flatShading?: boolean;
}

/** The union a classed part can be built as — one material per lighting tier. */
export type ClassedPartMaterial =
    | THREE.MeshLambertMaterial
    | THREE.MeshPhongMaterial
    | THREE.MeshPhysicalMaterial;

/**
 * The sheen parameters for the 'environment' tier — same three fields as
 * `VoxelSlotMaterial.sheenParameters`, and the same reasoning: `sheen` is 0 for
 * every class but `fur`, and 0 is three's own default, so the reflective classes
 * construct exactly the material they would without the spread (`material.sheen
 * > 0` is a feature three's program cache already keys on).
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

/**
 * Build one part material for `className`. With `quality` OMITTED the tier
 * this call resolves at runtime applies (`?matq=` → stored choice → platform
 * default), resolved per call — the `EnvDistanceFade` precedent, so
 * `setMaterialQuality` reaches the next thing built with no cache to
 * invalidate. Pass `quality` explicitly for tests and one-shot clamps
 * (`clampWeaponPartMaterialsToDirect`). Unknown class names resolve to `matte`
 * and never throw (`resolveVoxelMaterialClass`'s own contract), which matters
 * here more than anywhere: this call sits in LLM-generated weapon code, and a
 * hallucinated class name must degrade to a matte part, not break the weapon.
 *
 * Always returns a FRESH material instance. Every consumer assumes it owns
 * what its creator built — the first-person systems dispose material and
 * geometry on unequip, `NpcWeaponComponent` disposes built-ins — so nothing
 * here may be shared behind the caller's back. A caller that WANTS one
 * material across parts calls this once and reuses the return value (the
 * block-character shared cache does exactly that, and flags its instances so
 * mutators clone first).
 */
export function createClassedPartMaterial(
    className: string,
    options: ClassedPartMaterialOptions,
    quality?: MaterialQuality,
): ClassedPartMaterial {
    const cls = resolveVoxelMaterialClass(className);
    const lighting = clampVoxelMaterialLighting(cls.lighting, quality ?? activeMaterialQuality());

    // The caller owns the albedo; the class modulates it. `albedoScale` is the
    // same tonal compensation classed voxels apply (1 for the metals, where the
    // colour is a reflection tint and scaling it just makes the metal dingy).
    const shared = {
        color: new THREE.Color(options.color).multiplyScalar(cls.albedoScale),
        vertexColors: options.vertexColors ?? false,
        flatShading: options.flatShading ?? false,
    };

    let mat: ClassedPartMaterial;
    if (lighting === 'environment') {
        mat = new THREE.MeshPhysicalMaterial({
            ...shared,
            metalness: cls.metalness,
            roughness: cls.roughness,
            clearcoat: cls.clearcoat,
            clearcoatRoughness: cls.clearcoatRoughness,
            envMapIntensity: cls.envMapIntensity,
            ...sheenParameters(cls),
        });
    } else if (lighting === 'direct') {
        mat = new THREE.MeshPhongMaterial({
            ...shared,
            specular: new THREE.Color().setScalar(cls.specular),
            shininess: cls.shininess,
        });
    } else {
        mat = new THREE.MeshLambertMaterial(shared);
    }

    const glow = options.glow ?? defaultGlowForVoxelMaterialClass(className) / 255;
    if (glow > 0) {
        // Tinted by the part's own colour — a red power cell glows red — the
        // same semantics every classed voxel carries.
        mat.emissive = new THREE.Color(options.color);
        mat.emissiveIntensity = glow * EMISSIVE_INTENSITY;
    }

    mat.userData[CLASSED_PART_CLASS] = normalizeVoxelMaterialClassName(className);
    mat.userData[CLASSED_PART_COLOR] = options.color;
    mat.userData[CLASSED_PART_GLOW] = glow;
    return mat;
}

/**
 * True when `mat` was built by {@link createClassedPartMaterial} (reads the
 * `CLASSED_PART_CLASS` tag). The guards that leave classed materials alone —
 * the glTF matte flattener, the per-frame bloom-tint neutralizer — key on
 * this, so a classed gold pauldron keeps its metalness while an ordinary
 * import is still flattened.
 */
export function isClassedPartMaterial(mat: THREE.Material): boolean {
    return typeof mat.userData[CLASSED_PART_CLASS] === 'string';
}
