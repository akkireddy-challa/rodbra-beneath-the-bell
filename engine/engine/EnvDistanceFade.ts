/**
 * Distance-based dither fade for instanced ENVIRONMENT OBJECTS (forged-city
 * buildings, landmarks, props — the VXL LOD-mesh path).
 *
 * The problem it solves: env objects are hard-culled with no fade at the fog-far
 * distance. Linear fog makes them 100% fog COLOR there, but the sky is a textured
 * skybox (fog:false), so a fully-fogged building is a flat-colored silhouette
 * against the real sky — then it blinks out when culled. Matching fog to a single
 * sky color can't fix a gradient/photographic skybox.
 *
 * The fix: over a band ending just before the cull distance, ramp each fragment's
 * alpha 1 → 0 and let `alphaHash` (order-independent screen-door dithering,
 * implemented on BOTH the WebGL and WebGPU backends) discard the thinning pixels.
 * The object DISSOLVES into whatever is actually behind it — the per-pixel sky —
 * and is fully gone before the hard cull, so there is no pop and no transparency
 * sorting (dither, not blending, so overlapping instanced buildings never sort-fight).
 *
 * The fade uses the fragment's radial camera distance (a shader built-in), so there
 * is NO per-frame CPU work; only the band edges are uniforms, refreshed when the
 * render distance changes. Because culling guarantees a building's NEAREST fragment
 * is already past `maxRenderDistance` at the moment it is culled, ending the fade at
 * `maxRenderDistance − margin` makes the dissolve complete before cull for a building
 * of any size.
 */

import * as THREE from 'three';
import { MeshLambertNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu';
import { positionView, smoothstep, oneMinus, uniform } from 'three/tsl';
import { isWebGpuActive } from 'engine/RendererType.js';
import { computeEnvFadeBand, DISABLED_FADE_BAND, type EnvFadeBand } from 'engine/EnvDistanceFadeBand.js';
import { isVoxelEmissiveMaterial, applyWebGlEmissive, applyNodeEmissive, type VoxelMaterialParams } from 'engine/VoxelEmissiveMaterial.js';
import { createVoxelSlotMaterialFromInfo, slotInfoFromMaterial } from 'engine/VoxelSlotMaterial.js';
import { activeMaterialQuality } from 'engine/DeviceQuality.js';

export { computeEnvFadeBand };
export type { EnvFadeBand };

// ── Shared band state ───────────────────────────────────────────────────────
// Start disabled (band at infinity → smoothstep 0 → opacity 1 everywhere), until
// the env system sets it from the real render distance. The snapshot is the one
// source of truth for BOTH backends: the band is normally set long before the
// first faded material is built (the env system sets it from the render distance
// at construction), so a material must be born already carrying it.
const currentBand: EnvFadeBand = { start: DISABLED_FADE_BAND.start, end: DISABLED_FADE_BAND.end };

// WebGL: the uniform slots of every compiled faded shader, kept in sync so a band
// change updates all of them.
const glUniformSlots: Array<{ s: { value: number }; e: { value: number } }> = [];

/** A faded WebGPU material's OWN band uniforms. Inferred return type on purpose:
 *  TSL's operator methods are typed per node kind, so widening these to `Node`
 *  makes the `smoothstep()` below fail to type-check. */
function createFadeUniforms() {
    return { start: uniform(currentBand.start), end: uniform(currentBand.end) };
}
type NodeFadeUniforms = ReturnType<typeof createFadeUniforms>;

// WebGPU: each faded node material owns its OWN uniforms and its OWN opacity node
// graph; only the uniform HANDLES are shared state, so a band change still reaches
// every live material. The nodes themselves MUST NOT be shared — a TSL node holds
// builder-stack state for the graph currently being compiled, so a node reached by
// two material builds throws "THREE.TSL: TypeError: Cannot read properties of
// undefined (reading 'addToStack')". A dense forest builds hundreds of faded
// scenery materials, which is exactly when that collides.
// Keyed by material (not a bare array) so a disposed material's handles go with it
// rather than accumulating for the life of the page.
const nodeUniformSlots: Map<THREE.Material, NodeFadeUniforms> = new Map();

/** Update the shared fade band for every faded env material (both backends). */
export function setEnvFadeBand(band: EnvFadeBand): void {
    currentBand.start = band.start;
    currentBand.end = band.end;
    for (const u of nodeUniformSlots.values()) { u.start.value = band.start; u.end.value = band.end; }
    for (const u of glUniformSlots) { u.s.value = band.start; u.e.value = band.end; }
}

// ── Material construction ────────────────────────────────────────────────────

/** WebGPU per-fragment opacity node over the material's own uniforms: 1 near,
 *  ramping to 0 across the band. */
function nodeFadeOpacity(u: NodeFadeUniforms) {
    return oneMinus(smoothstep(u.start, u.end, positionView.length()));
}

/** Give a WebGPU material the dither fade: fresh uniforms, a fresh opacity graph
 *  built over them, and a registry entry that `setEnvFadeBand()` updates until the
 *  material is disposed. */
function applyNodeFade(material: THREE.Material): void {
    material.alphaHash = true;
    const u = createFadeUniforms();
    nodeUniformSlots.set(material, u);
    material.addEventListener('dispose', () => { nodeUniformSlots.delete(material); });
    (material as THREE.Material & { opacityNode: unknown }).opacityNode = nodeFadeOpacity(u);
}

/** Inject the fade + alphaHash into a classic (WebGL) material's shader. When the
 *  material already carries the emissive `onBeforeCompile` (emissive env objects),
 *  it composes under this patch and the cache key is distinct so the two shaders
 *  never share a compiled program. */
function patchWebGlFade(material: THREE.Material, emissive: boolean): void {
    material.alphaHash = true;
    const prev = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
        if (prev) prev.call(material, shader, renderer);
        shader.uniforms.envFadeStart = { value: currentBand.start };
        shader.uniforms.envFadeEnd = { value: currentBand.end };
        glUniformSlots.push({ s: shader.uniforms.envFadeStart, e: shader.uniforms.envFadeEnd });
        // Radial camera distance as a varying (mvPosition.xyz is the view-space
        // position; the camera sits at the origin, so its length is the radial
        // distance — matching how culling measures).
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nvarying float vEnvFadeDepth;')
            .replace('#include <project_vertex>', '#include <project_vertex>\nvEnvFadeDepth = length(mvPosition.xyz);');
        // Thin the alpha before the alphaHash discard: fragments where the faded
        // alpha falls below the per-pixel hash threshold are dropped (dissolve).
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', '#include <common>\nuniform float envFadeStart;\nuniform float envFadeEnd;\nvarying float vEnvFadeDepth;')
            .replace('#include <alphahash_fragment>', 'diffuseColor.a *= 1.0 - smoothstep(envFadeStart, envFadeEnd, vEnvFadeDepth);\n#include <alphahash_fragment>');
    };
    // Faded materials share one program, distinct from any non-faded look-alike and
    // between the emissive / non-emissive shapes (different injected shaders).
    material.customProgramCacheKey = () => (emissive ? 'envDistanceFadeEmissive' : 'envDistanceFade');
}

/**
 * Build a distance-fading equivalent of an env object's LOD material. The source
 * is a classic voxel-atlas `MeshLambertMaterial` (or, rarely, a `MeshStandardMaterial`);
 * we read its texture/tint and construct a faded material of the matching kind for
 * the active backend rather than mutate the source (which the atlas may share).
 */
export function createFadedEnvMaterial(source: THREE.Material): THREE.Material {
    const src = source as THREE.MeshStandardMaterial & THREE.MeshLambertMaterial;

    // A material-slot material has to be rebuilt AS a slot material, or the
    // placed instance loses the light: the emissive lives in a uniform (WebGPU)
    // or an onBeforeCompile (WebGL) that a plain Lambert clone doesn't carry,
    // and slot materials aren't tagged with the base emissive flag checked
    // below. Rebuild at the level the source is currently at, then fade it.
    //
    // `slotInfoFromMaterial` also carries the slot's MATERIAL CLASS and whether
    // its normals were smoothed, for the same reason it carries the level: this
    // rebuild sees only the material, so anything missing from that
    // self-description is silently lost on every placed instance. Without the
    // class here a gold asset shines in the Assets tab and comes back matte the
    // moment it is placed in the world.
    const slot = slotInfoFromMaterial(source);
    if (slot) {
        const slotParams: VoxelMaterialParams = {
            map: src.map ?? null,
            vertexColors: source.vertexColors === true,
            flatShading: src.flatShading === true,
            polygonOffsetFactor: source.polygonOffsetFactor,
            polygonOffsetUnits: source.polygonOffsetUnits,
        };
        const handle = createVoxelSlotMaterialFromInfo(slotParams, slot, activeMaterialQuality());
        const faded = handle.material;
        if (isWebGpuActive()) {
            applyNodeFade(faded);
        } else {
            patchWebGlFade(faded, true);
        }
        // Distinct program per slot: two slots differ only by uniform value, but
        // sharing a cache key with the non-slot faded shaders would hand them a
        // program with no emissive term at all. The CLASS is in the key too —
        // two classes compile to genuinely different shaders (Lambert vs Phong vs
        // Physical), so sharing one program would shade one of them as the other.
        faded.customProgramCacheKey = () => `envDistanceFadeSlot:${slot.materialClass}:${slot.name}`;
        faded.side = source.side;
        if (src.color) (faded as THREE.Material & { color: THREE.Color }).color.copy(src.color);
        faded.name = `${source.name || 'Env'}_faded`;
        return faded;
    }
    // NOT a lighting-tier decision: this branch MIRRORS the source material's
    // own type so the faded copy shades like the original. Classed surfaces
    // never reach it — slot materials took the class-driven branch above, and
    // the only production caller (EnvironmentObjectSystem.fadedMaterial) feeds
    // VXL templates whose base is always the Lambert voxel material.
    const isStandard = (source as THREE.MeshStandardMaterial).isMeshStandardMaterial === true;
    const map = src.map ?? null;
    // GLB-voxelized env objects (trees) carry their color in a per-vertex `color`
    // attribute with no texture map (useAtlas:false). Drop vertexColors here and
    // the geometry's colors are ignored — every instance renders pure white.
    const vertexColors = source.vertexColors === true;
    const standardParams = { map, vertexColors, roughness: src.roughness ?? 0.8, metalness: src.metalness ?? 0.1 };
    // Emissive voxel env objects (imported .vox flames, etc.) must keep glowing
    // when packed into instanced LOD meshes — re-apply the per-vertex emissive term
    // the source carried, or reloaded objects render unlit. Only Lambert voxel
    // materials are emissive; Standard is never tagged.
    const emissive = !isStandard && isVoxelEmissiveMaterial(source);

    // Shared post-construction for both backends: match the source's side and
    // tint, then tag the clone.
    const finish = (m: THREE.Material & { color: THREE.Color }): THREE.Material => {
        m.side = source.side;
        if (src.color) m.color.copy(src.color);
        m.name = `${source.name || 'Env'}_faded`;
        return m;
    };

    if (isWebGpuActive()) {
        const m = isStandard
            ? new MeshStandardNodeMaterial(standardParams)
            : new MeshLambertNodeMaterial({ map, vertexColors });
        applyNodeFade(m);
        if (emissive) applyNodeEmissive(m);
        return finish(m);
    }

    const m = isStandard
        ? new THREE.MeshStandardMaterial(standardParams)
        : new THREE.MeshLambertMaterial({ map, vertexColors });
    // Wire emissive BEFORE the fade patch so its onBeforeCompile composes as `prev`.
    if (emissive) applyWebGlEmissive(m as THREE.MeshLambertMaterial);
    patchWebGlFade(m, emissive);
    return finish(m);
}
