/**
 * Batch material factory for baked VxlScene worlds, with an optional per-vertex emissive
 * term and an optional MATERIAL CLASS.
 *
 * `VxlSceneRenderer` draws the whole terrain through a handful of shared atlas materials
 * (one per (depth-bias step, class) pair, plus the smooth-surface ones). When the world
 * carries a v7 emissive LUT every batch geometry gains an `emissive` float attribute, and
 * these materials become the emissive variant — reusing `VoxelEmissiveMaterial`'s
 * dual-backend wiring verbatim (game/docs/renderer-backends.md):
 *
 *   WebGPU — a node material whose `emissiveNode` is albedo × the attribute.
 *   WebGL  — a classic material whose `onBeforeCompile` sets `totalEmissiveRadiance`.
 *
 * When the world carries a v9 class LUT, a classed batch shades on the class's lighting
 * tier — the same three-tier model the asset slots use (`VoxelSlotMaterial.ts`):
 * Phong for 'direct' (stone, wood — a specular lobe from the scene's real lights, no
 * IBL, no tonal seam against the matte batches beside it), Physical for 'environment'
 * (metal, glass — real reflections of `scene.environment`). Two standing decisions carry
 * over from the slot path:
 *
 *  - Terrain never runs the shading-normal smoothing pass (it is O(vertices) CPU work
 *    the asset path already refuses at scale), so the class resolves through
 *    `effectiveVoxelMaterialClassName(name, smoothed=false)` — a reflection-only class
 *    (`chrome`) falls back to something that survives six flat face normals.
 *  - The resolved tier is then CLAMPED by the load's `MaterialQuality`: 'medium' builds
 *    every 'environment' class as Phong with the class's own numbers, 'low' never
 *    reaches this factory with a class at all (the renderer skips the class split).
 *
 * The class-free result is exactly what the renderer built before classes existed: a
 * plain `getVoxelTextureAtlas().createMaterial()` with the same flatShading /
 * polygonOffset fields on BOTH backends (a classic Lambert material is what
 * WebGPURenderer auto-converts today), or the hand-built emissive Lambert variant.
 */

import * as THREE from 'three';
import {
    MeshLambertNodeMaterial,
    MeshPhongNodeMaterial,
    MeshPhysicalNodeMaterial,
} from 'three/webgpu';
import { isWebGpuActive } from 'engine/RendererType.js';
import { applyNodeEmissive, applyWebGlEmissive } from 'engine/VoxelEmissiveMaterial.js';
import { getVoxelTextureAtlas } from 'engine/VoxelTextureAtlas.js';
import {
    clampVoxelMaterialLighting,
    effectiveVoxelMaterialClassName,
    resolveVoxelMaterialClass,
    type VoxelMaterialClass,
} from 'engine/VoxelMaterialClass.js';
import type { MaterialQuality } from 'engine/MaterialQuality.js';

/** The per-batch visual fields the renderer varies; everything else is the shared atlas setup. */
export interface VxlSceneMaterialParams {
    /** Per-voxel-face faceting (true) or the welded surface's smooth normals (false). */
    flatShading: boolean;
    /** Depth-test bias for near-coplanar surfaces of different coarseness. */
    polygonOffset: boolean;
    polygonOffsetFactor: number;
    polygonOffsetUnits: number;
    /**
     * The quality tier this load resolved to (`resolveMaterialQuality` at the renderer's
     * construction site). Clamps a classed batch's lighting tier at construction; the
     * class-free batches ignore it entirely.
     */
    materialQuality: MaterialQuality;
}

/**
 * The shared atlas material for one batch. When `emissive` the material additionally glows
 * per-vertex from the geometry's 0..1 `emissive` attribute, tinted by the voxel's own albedo.
 * `className` (a v9 world's class for this batch's cells) lifts the batch onto that class's
 * lighting tier; undefined/matte — and every pre-v9 world — builds the identical material
 * this factory built before classes existed.
 */
export function createVxlSceneBatchMaterial(
    params: VxlSceneMaterialParams,
    emissive: boolean,
    className?: string,
): THREE.Material {
    // Terrain is never smoothed, so `smoothed: false` — chrome falls back here.
    const cls = resolveVoxelMaterialClass(effectiveVoxelMaterialClassName(className, false));
    const lighting = clampVoxelMaterialLighting(cls.lighting, params.materialQuality);
    if (lighting !== 'lambert') {
        return createClassedBatchMaterial(params, emissive, cls, lighting);
    }

    if (emissive && isWebGpuActive()) {
        const mat = new MeshLambertNodeMaterial({
            map: getVoxelTextureAtlas().getTexture(),
            side: THREE.FrontSide,
            flatShading: params.flatShading,
            polygonOffset: params.polygonOffset,
            polygonOffsetFactor: params.polygonOffsetFactor,
            polygonOffsetUnits: params.polygonOffsetUnits,
        });
        applyNodeEmissive(mat);
        mat.needsUpdate = true;
        return mat;
    }
    const mat = getVoxelTextureAtlas().createMaterial();
    mat.flatShading = params.flatShading;
    mat.polygonOffset = params.polygonOffset;
    mat.polygonOffsetFactor = params.polygonOffsetFactor;
    mat.polygonOffsetUnits = params.polygonOffsetUnits;
    if (emissive) applyWebGlEmissive(mat);
    mat.needsUpdate = true;
    return mat;
}

/**
 * `albedoScale` as a tint colour — the same tonal compensation the slot path applies
 * (`VoxelSlotMaterial.albedoTint`): undefined at 1 so untinted classes construct exactly
 * their stock material.
 */
function albedoTint(cls: VoxelMaterialClass): THREE.Color | undefined {
    return cls.albedoScale === 1 ? undefined : new THREE.Color().setScalar(cls.albedoScale);
}

/**
 * A Phong- or Physical-tier batch material, dual-backend. Parameter-for-parameter the
 * shape `VoxelSlotMaterial` builds for a slot of the same class, minus the live emissive
 * uniform (a terrain batch's glow is the per-vertex attribute, exactly like the Lambert
 * variant's).
 */
function createClassedBatchMaterial(
    params: VxlSceneMaterialParams,
    emissive: boolean,
    cls: VoxelMaterialClass,
    lighting: 'direct' | 'environment',
): THREE.Material {
    const common = {
        map: getVoxelTextureAtlas().getTexture(),
        side: THREE.FrontSide,
        flatShading: params.flatShading,
        polygonOffset: params.polygonOffset,
        polygonOffsetFactor: params.polygonOffsetFactor,
        polygonOffsetUnits: params.polygonOffsetUnits,
    };
    const color = albedoTint(cls);
    const environmentParams = {
        ...common,
        ...(color ? { color } : {}),
        metalness: cls.metalness,
        roughness: cls.roughness,
        clearcoat: cls.clearcoat,
        clearcoatRoughness: cls.clearcoatRoughness,
        envMapIntensity: cls.envMapIntensity,
        sheen: cls.sheen,
        sheenRoughness: cls.sheenRoughness,
        sheenColor: new THREE.Color(cls.sheenColor),
    };
    const directParams = {
        ...common,
        ...(color ? { color } : {}),
        specular: new THREE.Color().setScalar(cls.specular),
        shininess: cls.shininess,
    };

    if (isWebGpuActive()) {
        const mat = lighting === 'environment'
            ? new MeshPhysicalNodeMaterial(environmentParams)
            : new MeshPhongNodeMaterial(directParams);
        if (emissive) applyNodeEmissive(mat);
        mat.needsUpdate = true;
        return mat;
    }
    const mat = lighting === 'environment'
        ? new THREE.MeshPhysicalMaterial(environmentParams)
        : new THREE.MeshPhongMaterial(directParams);
    if (emissive) applyWebGlEmissive(mat);
    // The `VoxelSlotMaterial` cache-aliasing lesson, verbatim: a material whose look
    // comes from an `onBeforeCompile` injection must not share a compiled program with
    // an ordinary material of the same three type. The tier is in the key so the two
    // shapes this factory produces stay distinct even where their features coincide.
    mat.customProgramCacheKey = () => `vxlSceneBatch:${lighting}:${emissive ? 1 : 0}`;
    mat.needsUpdate = true;
    return mat;
}
