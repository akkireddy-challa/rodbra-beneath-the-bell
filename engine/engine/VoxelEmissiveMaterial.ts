/**
 * Voxel material factory with an optional per-vertex emissive term, dual-path
 * for both renderer backends (game/CLAUDE.md dual-renderer rule):
 *
 *   WebGPU — `MeshLambertNodeMaterial` (three/webgpu) whose `emissiveNode` is the
 *            voxel's own albedo (`diffuseColor`) × the per-vertex `emissive`
 *            float attribute × EMISSIVE_INTENSITY.
 *   WebGL  — `MeshLambertMaterial` with `onBeforeCompile` setting
 *            `totalEmissiveRadiance` to `diffuseColor.rgb` × the `emissive`
 *            attribute × EMISSIVE_INTENSITY.
 *
 * The glow is TINTED BY THE VOXEL'S OWN COLOUR (an orange flame glows orange, not
 * white). The Lambert diffuse response is identical to a non-emissive voxel —
 * emissive is purely additive and feeds the engine's existing bloom. The mesh's
 * `emissive` vertex attribute is 0..1.
 *
 * When `emissive` is false the returned material is byte-identical to the
 * plain `MeshLambertMaterial` the voxel renderer built before this feature:
 * no `onBeforeCompile`, no node graph, no emissive wiring. Non-emissive assets
 * carry no `emissive` attribute at all, so they render exactly as before.
 */
import * as THREE from 'three';
import { MeshLambertNodeMaterial } from 'three/webgpu';
import { attribute, diffuseColor, dot, float, max, vec3 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { isWebGpuActive } from 'engine/RendererType.js';

/**
 * `MeshLambertNodeMaterial` inherits `emissiveNode` from `NodeMaterial` (set to
 * `null` in the base constructor), but three ships no `.d.ts` and TypeScript's
 * inference of the Lambert subclass does not surface the inherited node fields
 * (unlike `MeshStandardNodeMaterial`, whose type does expose them). This is the
 * runtime field — see NodeMaterial's constructor — reached through a narrow view
 * so we keep Lambert lighting parity with non-emissive voxels instead of falling
 * back to a Standard (PBR) material for emissive-only voxels.
 */
interface EmissiveNodeCapable {
    emissiveNode: Node | null;
}

/**
 * Multiplier applied to (voxel albedo × the 0..1 vertex emissive) so a
 * full-emissive voxel crosses the engine's bloom threshold (~0.9). The glow keeps
 * the voxel's hue; brighter albedos bloom harder. Lower this if emissive voxels
 * read too hot / desaturate toward white under ACES tone mapping.
 */
export const EMISSIVE_INTENSITY = 3.0;

/**
 * Rec. 709 luma weights — what a bloom threshold actually tests.
 */
export const LUMA_WEIGHTS: readonly [number, number, number] = [0.2126, 0.7152, 0.0722];

/**
 * Luminance floor for the glow normalisation below. A voxel dimmer than this
 * keeps scaling down instead of being hauled up to full brightness, so black
 * still cannot glow (a glow is albedo-tinted; black has no hue to tint) and a
 * nearly-black voxel does not detonate into a vivid one.
 */
export const MIN_GLOW_LUMINANCE = 0.05;

/**
 * Gain that takes a voxel's albedo to a HUE-PRESERVING full-strength glow.
 *
 * A flat `albedo × EMISSIVE_INTENSITY` made "100% glow" mean something
 * different for every colour, because luma is 71% green: white reached 3.0 and
 * bloomed, while a saturated magenta (#FF00CB, luma 0.256) reached 0.767 and
 * sat just under a typical 0.87 bloom threshold. Same slider, same 100%, and
 * one colour glowed while the other only got brighter — with nothing in the
 * editor to explain which was which. Normalising by luma makes the setting mean
 * "this voxel glows", and the hue is carried by the albedo tint as before.
 *
 * White is unchanged (luma 1 → gain 3), so existing white and near-white lights
 * look exactly as they did; saturated colours are what move.
 */
export function glowGainForLuminance(luminance: number): number {
    return EMISSIVE_INTENSITY / Math.max(luminance, MIN_GLOW_LUMINANCE);
}

/**
 * The shader expression for {@link glowGainForLuminance}, shared verbatim by
 * every GLSL emissive path so they cannot drift apart.
 */
export const GLOW_GAIN_GLSL =
    `(${EMISSIVE_INTENSITY.toFixed(1)} / max(dot(diffuseColor.rgb, vec3(${LUMA_WEIGHTS[0]}, ${LUMA_WEIGHTS[1]}, ${LUMA_WEIGHTS[2]})), ${MIN_GLOW_LUMINANCE}))`;

/**
 * Visual parameters shared by both voxel material shapes (atlas-mapped and
 * vertex-coloured). Mirrors exactly what `assembleVoxelMesh` set on its two
 * inline `MeshLambertMaterial` branches so the non-emissive result is unchanged.
 */
export interface VoxelMaterialParams {
    /** Atlas texture for the UV-mapped path; null for the vertex-colour path. */
    map: THREE.Texture | null;
    /** true for the vertex-colour path (no atlas UVs). */
    vertexColors: boolean;
    /** Flat face shading (false only for rounded-edge geometry's curved normals). */
    flatShading: boolean;
    /** Z-fighting polygon offset factor (from the ZFightingRegistry). */
    polygonOffsetFactor: number;
    /** Z-fighting polygon offset units (from the ZFightingRegistry). */
    polygonOffsetUnits: number;
}

/** `userData` flag stamped on emissive voxel materials so downstream material
 *  derivations (e.g. the distance-fade env material) can re-apply the emissive
 *  term instead of silently dropping it when they rebuild the material. */
export const VOXEL_EMISSIVE_FLAG = 'voxelEmissive';

/** True if `createVoxelMaterial(..., true)` produced this material. */
export function isVoxelEmissiveMaterial(material: THREE.Material): boolean {
    return material.userData?.[VOXEL_EMISSIVE_FLAG] === true;
}

/**
 * Wire the per-vertex emissive term onto a WebGL `MeshLambertMaterial`. Sets the
 * `emissive` uniform to a neutral white × EMISSIVE_INTENSITY, then (composing with
 * any existing `onBeforeCompile`, so it layers under the distance-fade patch)
 * makes `totalEmissiveRadiance` the voxel's own albedo (`diffuseColor.rgb`, which
 * carries the atlas texel / vertex colour by this point) × the per-vertex 0..1
 * `emissive` attribute × that uniform — the glow keeps the voxel's hue instead of
 * washing out to white. Reused by the faded env material so instanced/reloaded
 * env objects glow identically to freshly-added ones.
 */
export function applyWebGlEmissive(
    // Every LIT classic material carries `#include <emissivemap_fragment>` and the
    // emissive/emissiveIntensity pair, so the one patch composes across all three
    // tiers the voxel renderers build (the same fact `VoxelSlotMaterial`'s header
    // records) — hence the union rather than Lambert alone: the classed terrain
    // batches (`VxlSceneEmissiveMaterial.ts`) glow on Phong and Physical too.
    mat: THREE.MeshLambertMaterial | THREE.MeshPhongMaterial | THREE.MeshPhysicalMaterial,
): void {
    mat.emissive = new THREE.Color(0xffffff);
    // The uniform carries only the 0..1 control; the hue-preserving gain is
    // computed per fragment from that fragment's own albedo (see GLOW_GAIN_GLSL).
    mat.emissiveIntensity = 1;
    mat.userData[VOXEL_EMISSIVE_FLAG] = true;
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader, renderer) => {
        if (prev) prev.call(mat, shader, renderer);
        shader.vertexShader =
            'attribute float emissive;\nvarying float vEmissive;\n' +
            shader.vertexShader.replace(
                'void main() {',
                'void main() {\n  vEmissive = emissive;',
            );
        shader.fragmentShader =
            'varying float vEmissive;\n' +
            shader.fragmentShader.replace(
                '#include <emissivemap_fragment>',
                `#include <emissivemap_fragment>\n  totalEmissiveRadiance = diffuseColor.rgb * vEmissive * emissive * ${GLOW_GAIN_GLSL};`,
            );
    };
}

/** Wire the per-vertex emissive term onto a WebGPU `MeshLambertNodeMaterial`:
 *  albedo (`diffuseColor.rgb`) × the 0..1 `emissive` attribute × EMISSIVE_INTENSITY.
 *  Reused by the faded env material (WebGPU) — see `applyWebGlEmissive`. */
export function applyNodeEmissive(mat: THREE.Material): void {
    mat.userData[VOXEL_EMISSIVE_FLAG] = true;
    (mat as unknown as EmissiveNodeCapable).emissiveNode =
        diffuseColor.rgb.mul(attribute('emissive', 'float')).mul(glowGainNode());
}

/**
 * {@link glowGainForLuminance} as a TSL node, for both WebGPU emissive paths.
 * The return type is inferred on purpose — TSL's operator methods are typed per
 * node kind, and widening this to `Node` makes every downstream `.mul()` fail.
 */
export function glowGainNode() {
    const luma = dot(diffuseColor.rgb, vec3(...LUMA_WEIGHTS));
    return float(EMISSIVE_INTENSITY).div(max(luma, float(MIN_GLOW_LUMINANCE)));
}

/**
 * The shared params as a Lambert constructor argument. Both backends build from
 * this single object so the two materials cannot drift apart; only the class and
 * the emissive wiring differ between them.
 */
function lambertParameters(params: VoxelMaterialParams): THREE.MeshLambertMaterialParameters {
    return {
        map: params.map,
        vertexColors: params.vertexColors,
        side: THREE.FrontSide,
        flatShading: params.flatShading,
        polygonOffset: true,
        polygonOffsetFactor: params.polygonOffsetFactor,
        polygonOffsetUnits: params.polygonOffsetUnits,
    };
}

/**
 * WebGL path: a `MeshLambertMaterial` with the shared params. When `emissive`,
 * `applyWebGlEmissive` wires the albedo-tinted per-vertex glow.
 *
 * Exported because `createVoxelMaterial` picks the backend from the ENGINE's
 * renderer, which is wrong for the offscreen thumbnail renderer: it owns a
 * private `THREE.WebGLRenderer` and must build WebGL materials even while the
 * engine runs WebGPU. See `VoxelPreviewRenderer.useWebGlMaterials`.
 */
export function createWebGlVoxelMaterial(params: VoxelMaterialParams, emissive: boolean): THREE.Material {
    const mat = new THREE.MeshLambertMaterial(lambertParameters(params));
    if (emissive) {
        applyWebGlEmissive(mat);
    }
    return mat;
}

/**
 * WebGPU path: a `MeshLambertNodeMaterial` with the shared params. When
 * `emissive`, `applyNodeEmissive` wires the albedo-tinted per-vertex glow.
 */
function createNodeMaterial(params: VoxelMaterialParams, emissive: boolean): THREE.Material {
    const mat = new MeshLambertNodeMaterial(lambertParameters(params));
    if (emissive) {
        applyNodeEmissive(mat);
    }
    return mat;
}

/**
 * Build the voxel material for the active renderer backend. Both paths produce
 * the same Lambert diffuse response and the same z-fighting offset; when
 * `emissive` is true they additionally glow per-vertex from the mesh's 0..1
 * `emissive` attribute, tinted by the voxel's own albedo (× EMISSIVE_INTENSITY).
 * When `emissive` is false the material is identical to the pre-feature plain
 * Lambert material.
 */
export function createVoxelMaterial(params: VoxelMaterialParams, emissive: boolean): THREE.Material {
    if (isWebGpuActive()) {
        return createNodeMaterial(params, emissive);
    }
    return createWebGlVoxelMaterial(params, emissive);
}
