import * as THREE from 'three';
import type { Node } from 'three/webgpu';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
    Fn, uniform, texture, uv, float, vec2, vec3, floor, fract, dot, mix, smoothstep,
    normalize, length, exp, sin, cos, positionWorld, normalWorld, cameraViewMatrix,
    transformNormalByViewMatrix, Loop,
} from 'three/tsl';
import { isWebGpuActive } from 'engine/RendererType.js';
import { getVoxelTextureAtlas } from 'engine/VoxelTextureAtlas.js';
import { applyNodeEmissive, applyWebGlEmissive } from 'engine/VoxelEmissiveMaterial.js';

/**
 * Wet-asphalt replacement material for the baked ride surface (the
 * `smoothSurface` batch). Swapped in by `WetSurfaceController` while a game's
 * `weatherConfig` is raining, and restored when it stops.
 *
 * The response follows the industry-standard wet-BRDF treatment (Lagarde,
 * "Water drop 3b"): wetness does not change the lighting model, it changes the
 * PBR inputs —
 *   1. diffuse albedo darkens (water fills the surface pores),
 *   2. roughness collapses toward water-smooth, so the environment/sun
 *      reflections sharpen,
 *   3. puddle areas (a world-XZ noise mask, gated to near-flat surfaces)
 *      flatten the shading normal toward straight-up water and ripple with
 *      procedural expanding rain rings.
 * Two progress bands drive it: roughness/darkening react through the first
 * ~75% of wetness; puddles + ripples arrive in the last stretch, so a drying
 * track loses its mirror before it loses its damp look.
 *
 * Dual renderer paths (game/docs/renderer-backends.md): TSL nodes on a
 * `MeshStandardNodeMaterial` for WebGPU, GLSL `onBeforeCompile` on a
 * `MeshStandardMaterial` for WebGL. Standard (not Lambert like the material it
 * replaces) because the wet look IS a specular/IBL effect; `ALBEDO_MATCH`
 * compensates the brightness lift of gaining image-based lighting so the dry
 * end of the ramp still matches the surrounding Lambert terrain.
 *
 * Puddles additionally raise per-pixel METALNESS (the classic wet-surface
 * cheat: diffuse dies, the surface becomes a dark tinted mirror of the
 * environment). This doubles as the screen-space-reflection mask — the SSR
 * post pass reads metalness/roughness from the standard MRT channels, so no
 * material-level MRT is involved. (A material `mrtNode` is NOT usable here: it
 * also hijacks the shadow-map depth pass, whose target has no color
 * attachments, producing an empty WGSL output struct and an invalid pipeline.)
 * Ripple animation strength is fed separately from the CURRENT rain intensity
 * (`setRippleAmount`) so standing water goes calm when the rain stops while
 * the surface is still wet.
 */
/**
 * Runtime look dials, authored per game through `worldProfileData.weatherConfig`
 * (see WeatherConfig). These are UNIFORMS, not constants: the AI editor tunes
 * the wet look live, so nothing here may be baked into the shader.
 */
export interface WetSurfaceLook {
    /** Glossiness of the whole wet film between puddles, 0..1. */
    filmGloss: number;
    /** How much darker the asphalt goes when wet, 0..1. */
    surfaceDarkening: number;
    /** Sky/environment sheen, 0..1. */
    envSheen: number;
    /** Rain-impact ripple strength, 0..2. */
    rippleStrength: number;
}

export const DEFAULT_WET_SURFACE_LOOK: WetSurfaceLook = {
    filmGloss: 0.7,
    surfaceDarkening: 0.28,
    envSheen: 0.25,
    rippleStrength: 1,
};

export interface WetSurfaceHandle {
    material: THREE.Material;
    /** Apply the game's authored look dials (see WetSurfaceLook). */
    setLook(look: WetSurfaceLook): void;
    /** Drive with clock time (not gameplay time) so ripples animate in pause/editor. */
    setTime(seconds: number): void;
    /** Surface wetness envelope 0..1 (soaked/dried by the weather system). */
    setWetness(wetness: number): void;
    /** Puddle coverage knob 0..1 (weatherConfig.puddles). */
    setPuddles(puddles: number): void;
    /** Ripple agitation 0..1 — the CURRENT rainfall intensity, not the wetness envelope. */
    setRippleAmount(amount: number): void;
    /**
     * Mirror the scene's environment texture onto the material so
     * `envMapIntensity` damping actually applies (see WET_ENV_INTENSITY).
     * Call every frame with `scene.environment` — no-ops while unchanged.
     */
    setEnvironment(env: THREE.Texture | null): void;
    dispose(): void;
}

export interface WetSurfaceMaterialOptions {
    /** True when the world carries the v7 emissive LUT (per-vertex `emissive` attribute). */
    emissive: boolean;
}

export const DEFAULT_WET_SURFACE_OPTIONS: WetSurfaceMaterialOptions = {
    emissive: false,
};

// ── Shared response constants (both backends read these exact numbers) ────────
// Tuned so the road stays READABLE AS ASPHALT: the damp film keeps a broad
// dull sheen (never a mirror), only puddle cores approach one, and even they
// cap below full so the surface texture ghosts through the reflection.
const ROUGH_DRY = 0.95;      // matte asphalt — matches the Lambert look it replaces
/** Damp-film roughness. Sits high on the postfx SSR ramp on purpose: this is
 *  the WHOLE road surface, and it is what has to look wet — puddles are the
 *  accent, not the effect. */
/** Fallback film roughness; the live value is a UNIFORM from WetSurfaceLook.filmGloss. */
const ROUGH_DAMP = 0.3;
const ROUGH_PUDDLE = 0.15;   // standing water — reflective but not a perfect mirror
/** fbm roughness jitter that breaks the uniform glaze. Must stay narrow enough
 *  that ROUGH_DAMP ± this/2 lands well inside the postfx SSR ramp — otherwise
 *  the variation stops modulating the sheen and starts switching it off by
 *  map position (see GameEnginePostFx's ssrMask). */
const ROUGH_VARIATION = 0.18;
const WET_DARKEN = 0.72;     // diffuse × lerp(1, this, wetness) — semi-porous asphalt
const PUDDLE_DARKEN = 0.7;   // extra absorption under standing water
const ALBEDO_MATCH = 0.86;   // Standard+IBL reads brighter than Lambert; keep the dry look equal
const PUDDLE_NOISE_SCALE = 0.11; // world-XZ noise frequency → puddle features ~9 m
const PUDDLE_EDGE = 0.16;    // soft shoreline width, in noise units
/** puddles=1 pushes the noise threshold down by this much. */
const PUDDLE_MAX_COVER = 0.45;
const PUDDLE_MASK_MAX = 0.85; // even a puddle core keeps 15% asphalt response
/** Standing water only collects where it credibly COULD: normal.y ≥ ~cos(4°)
 *  is full puddle, gone entirely above ~9° grade (water runs off a hillside
 *  road). The wet film + sheen still cover slopes — only the mirror pools go. */
/**
 * ⚠ These decide how much of the road reflects AT ALL. Puddles carry a near-
 * full SSR mask while the damp film only reaches about half of it, so the
 * visible reflections are mostly puddles — tighten this gate and the road goes
 * flat. 0.997/0.988 (4°/9°) was far too strict: a track's camber and
 * undulation exceed that almost everywhere, so puddles vanished and with them
 * most of the shine. These values (16°/26°) keep standing water off genuine
 * hillsides while letting the whole running surface pool.
 */
const PUDDLE_FLAT_MIN = 0.96;
const PUDDLE_FLAT_SOFT = 0.90;
const RIPPLE_CELLS_PER_M = 2.6;
const RIPPLE_RATE = 1.1;     // ripple cycles per second per cell
const RIPPLE_RING_FREQ = 9.0;
const RIPPLE_STRENGTH = 0.5; // XZ slope of the ripple normal at full agitation
/**
 * Metalness is kept NEAR ZERO on purpose. Metalness turns puddles into
 * full-strength environment mirrors, and on the WebGPU node pipeline that
 * CANNOT be damped per-material: the env intensity node resolves to
 * `material.envMap ? material.envMapIntensity : scene.environmentIntensity`,
 * so a material without its own envMap ignores `envMapIntensity` entirely —
 * the "road looks like a bright blue river" bug. Scene reflections instead
 * come from the SSR pass, whose mask keys off ROUGHNESS (GameEnginePostFx),
 * not metalness. The small residual metalness just deepens puddle cores.
 */
const WET_METAL_PUDDLE = 0.3;  // standing water: stronger streaks + modest env
/**
 * Damp-film metalness. Doubles as the SSR pass's "this surface is wet" flag —
 * and it is the ONLY thing keeping the reflection alive through transparent
 * weather VFX: rain and mist are drawn into the same pass as the scene, so
 * they blend their own (zero) metalness into this channel over every pixel
 * they cover, pulling the road's value down. The postfx gate is therefore set
 * far below this value; see `ssrMask` in GameEnginePostFx.
 *
 * Do NOT try to fix that dilution by having the particles write "neutral"
 * G-buffer values: neutrality depends on what is underneath, so writing
 * road-like normals/metalness turns sky, cars and grass into phantom mirrors
 * (reflections detach and stretch — tried, reverted 2026-08-05).
 */
const WET_METAL_FILM = 0.12;  //  enough to flag the SSR pass and add a
                               // faint env sheen — the broad "sky sheet" lives
                               // here, so keep it LOW; the wet identity comes
                               // from the streaked, luminance-shaped SSR
/**
 * Environment response of the wet road. The blue-river look is plain
 * DIELECTRIC FRESNEL: at driving angles the whole road sits at grazing
 * incidence, where any smooth surface reflects the environment at full
 * strength — metalness is irrelevant. The only damping the node pipeline
 * honors is `material.envMapIntensity`, and ONLY when the material carries
 * its OWN `envMap` (`material.envMap ? material.envMapIntensity :
 * scene.environmentIntensity`) — hence `setEnvironment()` mirrors the scene's
 * PMREM onto the material every frame so this factor actually applies.
 */
const WET_ENV_INTENSITY = 0.25;

export function createWetSurfaceMaterial(opts: WetSurfaceMaterialOptions): WetSurfaceHandle {
    if (isWebGpuActive()) {
        return createNodeWetSurface(opts);
    }
    return createWebGlWetSurface(opts);
}

// ═════════════════════════════════════ WebGPU (TSL) ═════════════════════════

/** TSL node handles — the helpers below only care about vector arity, which is
 *  what `Node<T>` carries. Deriving these from `ReturnType<typeof vec2>` instead
 *  pins them to the concrete class that one builder happens to return
 *  (`JoinNode`, `ConvertNode`), which no other node in a chain satisfies. */
type FloatNode = Node<'float'>;
type Vec2Node = Node<'vec2'>;

/** Sine-free 2D→1D hash (standard fract/dot construction). */
function tslHash1(p: Vec2Node): FloatNode {
    const q = fract(vec3(p.x, p.y, p.x).mul(vec3(0.1091, 0.1103, 0.0973)));
    const q2 = q.add(dot(q, q.zyx.add(33.33)));
    return fract(q2.x.add(q2.y).mul(q2.z));
}

/** Bilinear value noise on the hash lattice. */
function tslVnoise(p: Vec2Node): FloatNode {
    const i = floor(p);
    const f = fract(p);
    const u = f.mul(f).mul(vec2(3.0, 3.0).sub(f.mul(2.0)));
    const a = tslHash1(i);
    const b = tslHash1(i.add(vec2(1, 0)));
    const c = tslHash1(i.add(vec2(0, 1)));
    const d = tslHash1(i.add(vec2(1, 1)));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

/** 3-octave fbm — the puddle placement field. */
function tslFbm(p: Vec2Node): FloatNode {
    return tslVnoise(p).mul(0.55)
        .add(tslVnoise(p.mul(2.17).add(11.8)).mul(0.28))
        .add(tslVnoise(p.mul(4.31).add(27.4)).mul(0.17));
}

function createNodeWetSurface(opts: WetSurfaceMaterialOptions): WetSurfaceHandle {
    const timeU = uniform(0);
    const wetnessU = uniform(0);
    const puddlesU = uniform(0.5);
    const rippleU = uniform(0);
    // Look dials — uniforms so the AI editor can tune the wet look live.
    const filmRoughU = uniform(1 - DEFAULT_WET_SURFACE_LOOK.filmGloss);
    const darkenU = uniform(1 - DEFAULT_WET_SURFACE_LOOK.surfaceDarkening);
    const rippleScaleU = uniform(DEFAULT_WET_SURFACE_LOOK.rippleStrength);

    const material = new MeshStandardNodeMaterial({
        side: THREE.FrontSide,
        flatShading: false,
        roughness: ROUGH_DRY,
        metalness: 0,
        envMapIntensity: DEFAULT_WET_SURFACE_LOOK.envSheen,
    });

    // Shared node DAG — every output node below references these same
    // instances, so the compiler evaluates each once per fragment.
    const worldXZ = positionWorld.xz;
    const roughnessProgress = smoothstep(0.0, 0.75, wetnessU);
    const puddleProgress = smoothstep(0.55, 1.0, wetnessU);
    const upMask = smoothstep(PUDDLE_FLAT_SOFT, PUDDLE_FLAT_MIN, normalWorld.y);
    const noise = tslFbm(worldXZ.mul(PUDDLE_NOISE_SCALE));
    const threshold = float(1.0).sub(puddlesU.mul(PUDDLE_MAX_COVER));
    const puddleMask = smoothstep(threshold, threshold.add(PUDDLE_EDGE), noise)
        .mul(puddleProgress).mul(upMask).mul(PUDDLE_MASK_MAX);

    // Procedural expanding rain rings: jittered cell grid, each cell emits a
    // damped ring whose analytic radial derivative accumulates into an XZ
    // slope. Imperative (Loop), so it lives in an immediately-invoked Fn.
    const rippleGrad = Fn(() => {
        const p = worldXZ.mul(RIPPLE_CELLS_PER_M).toVar();
        const cell = floor(p).toVar();
        const grad = vec2(0).toVar();
        Loop(
            { start: -1, end: 1, type: 'int', condition: '<=' },
            { start: -1, end: 1, type: 'int', condition: '<=' },
            ({ i, j }) => {
                const c = cell.add(vec2(i, j)).toVar();
                const seed = tslHash1(c).toVar();
                const jitter = vec2(seed, tslHash1(c.add(seed).add(7.13))).toVar();
                const center = c.add(jitter);
                const t = fract(timeU.mul(RIPPLE_RATE).add(seed.mul(11.0))).toVar();
                const v = p.sub(center).toVar();
                const d = length(v).add(1e-4).toVar();
                const r = t.mul(1.4);
                // Ring window: only near the expanding front, fading with age
                // and with distance (rings die before reaching neighbours).
                const win = smoothstep(0.35, 0.0, d.sub(r).abs())
                    .mul(float(1.0).sub(t).mul(float(1.0).sub(t)))
                    .mul(smoothstep(1.6, 0.4, d));
                const slope = cos(d.sub(r).mul(RIPPLE_RING_FREQ)).mul(win);
                grad.addAssign(v.div(d).mul(slope));
            },
        );
        return grad.mul(1.0 / 9.0);
    })();

    const rippleScaled = rippleGrad.mul(rippleU.mul(rippleScaleU).mul(RIPPLE_STRENGTH));
    const waterNormal = normalize(vec3(rippleScaled.x, 1.0, rippleScaled.y));
    const wetWorldNormal = normalize(mix(normalWorld, waterNormal, puddleMask));

    const atlasTex = getVoxelTextureAtlas().getTexture();
    const albedo = texture(atlasTex, uv());
    const darken = mix(float(1.0), darkenU, roughnessProgress)
        .mul(mix(1.0, PUDDLE_DARKEN, puddleMask))
        .mul(ALBEDO_MATCH);

    material.colorNode = albedo.rgb.mul(darken);
    // Film roughness carries fbm variation so the sheen shifts across the
    // surface instead of glazing the whole road uniformly.
    const filmRough = mix(float(ROUGH_DRY), filmRoughU, roughnessProgress)
        .add(noise.sub(0.5).mul(ROUGH_VARIATION).mul(roughnessProgress));
    material.roughnessNode = mix(filmRough, float(ROUGH_PUDDLE), puddleMask).clamp(0.05, 1.0);
    // Wet metalness: dark tinted mirror in puddles, a whisper on the damp
    // film. Doubles as the SSR mask through the standard metalness MRT.
    material.metalnessNode = puddleMask.mul(WET_METAL_PUDDLE)
        .add(float(1.0).sub(puddleMask).mul(roughnessProgress).mul(WET_METAL_FILM));
    // `wetWorldNormal` is already WORLD space, so the world→view step is the plain
    // view matrix. NOT `transformNormalToView`: that one takes a LOCAL normal and
    // pre-multiplies `modelNormalMatrix`, so feeding it a world normal transforms
    // by the model matrix a second time. Silent today only because the terrain
    // group sits at identity — it breaks the moment a batch carries a rotation or
    // non-uniform scale. (The WebGL path already does this correctly with
    // `mat3(viewMatrix)`; this brings the node path in line.)
    material.normalNode = transformNormalByViewMatrix(wetWorldNormal, cameraViewMatrix);

    if (opts.emissive) {
        applyNodeEmissive(material);
    }

    return {
        material,
        setTime: (t) => { timeU.value = t; },
        setWetness: (w) => { wetnessU.value = THREE.MathUtils.clamp(w, 0, 1); },
        setPuddles: (p) => { puddlesU.value = THREE.MathUtils.clamp(p, 0, 1); },
        setRippleAmount: (a) => { rippleU.value = THREE.MathUtils.clamp(a, 0, 1); },
        setLook: (look) => {
            filmRoughU.value = THREE.MathUtils.clamp(1 - look.filmGloss, 0.02, 1);
            darkenU.value = THREE.MathUtils.clamp(1 - look.surfaceDarkening, 0, 1);
            rippleScaleU.value = Math.max(0, look.rippleStrength);
            const env = THREE.MathUtils.clamp(look.envSheen, 0, 1);
            if (material.envMapIntensity !== env) material.envMapIntensity = env;
        },
        setEnvironment: (env) => {
            if (material.envMap !== env) {
                material.envMap = env;
                material.needsUpdate = true;
            }
        },
        dispose: () => { material.dispose(); },
    };
}

// ═════════════════════════════════════ WebGL (GLSL) ═════════════════════════

const GLSL_WET_FUNCTIONS = /* glsl */ `
uniform float uWxTime;
uniform float uWxWetness;
uniform float uWxPuddles;
uniform float uWxRipple;
uniform float uWxFilmRough;
uniform float uWxDarken;
uniform float uWxRippleScale;
varying vec3 vWxWorldPos;

float wxHash1(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * vec3(0.1091, 0.1103, 0.0973));
    q += dot(q, q.zyx + 33.33);
    return fract((q.x + q.y) * q.z);
}

float wxVnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = wxHash1(i);
    float b = wxHash1(i + vec2(1.0, 0.0));
    float c = wxHash1(i + vec2(0.0, 1.0));
    float d = wxHash1(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float wxFbm(vec2 p) {
    return wxVnoise(p) * 0.55
        + wxVnoise(p * 2.17 + 11.8) * 0.28
        + wxVnoise(p * 4.31 + 27.4) * 0.17;
}

// Expanding rain rings: jittered cell grid, analytic radial slope. Single
// 3x3 neighbourhood — the WebGL fallback runs the same recipe as WebGPU.
vec2 wxRippleGrad(vec2 worldXZ) {
    vec2 p = worldXZ * ${RIPPLE_CELLS_PER_M.toFixed(2)};
    vec2 cell = floor(p);
    vec2 grad = vec2(0.0);
    for (int j = -1; j <= 1; j++) {
        for (int i = -1; i <= 1; i++) {
            vec2 c = cell + vec2(float(i), float(j));
            float seed = wxHash1(c);
            vec2 jitter = vec2(seed, wxHash1(c + seed + 7.13));
            vec2 center = c + jitter;
            float t = fract(uWxTime * ${RIPPLE_RATE.toFixed(2)} + seed * 11.0);
            vec2 v = p - center;
            float d = length(v) + 1e-4;
            float r = t * 1.4;
            float win = smoothstep(0.35, 0.0, abs(d - r))
                * (1.0 - t) * (1.0 - t)
                * smoothstep(1.6, 0.4, d);
            grad += (v / d) * cos((d - r) * ${RIPPLE_RING_FREQ.toFixed(1)}) * win;
        }
    }
    return grad * (1.0 / 9.0);
}
`;

function createWebGlWetSurface(opts: WetSurfaceMaterialOptions): WetSurfaceHandle {
    const uniforms = {
        uWxTime: { value: 0 },
        uWxWetness: { value: 0 },
        uWxPuddles: { value: 0.5 },
        uWxRipple: { value: 0 },
        // Look dials — see WetSurfaceLook (must not be baked into the shader).
        uWxFilmRough: { value: 1 - DEFAULT_WET_SURFACE_LOOK.filmGloss },
        uWxDarken: { value: 1 - DEFAULT_WET_SURFACE_LOOK.surfaceDarkening },
        uWxRippleScale: { value: DEFAULT_WET_SURFACE_LOOK.rippleStrength },
    };

    const material = new THREE.MeshStandardMaterial({
        map: getVoxelTextureAtlas().getTexture(),
        side: THREE.FrontSide,
        flatShading: false,
        roughness: ROUGH_DRY,
        metalness: 0,
        envMapIntensity: WET_ENV_INTENSITY,
    });

    material.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, uniforms);
        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vWxWorldPos;')
            .replace(
                '#include <project_vertex>',
                `#include <project_vertex>
                vec4 wxWp = vec4( transformed, 1.0 );
                #ifdef USE_BATCHING
                wxWp = batchingMatrix * wxWp;
                #endif
                vWxWorldPos = ( modelMatrix * wxWp ).xyz;`,
            );
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', '#include <common>\n' + GLSL_WET_FUNCTIONS)
            .replace(
                '#include <map_fragment>',
                `#include <map_fragment>
                float wxRoughProgress = smoothstep(0.0, 0.75, uWxWetness);
                float wxPuddleProgress = smoothstep(0.55, 1.0, uWxWetness);
                // Geometric world normal from position derivatives — works in
                // every shader variant (vNormal is absent under FLAT_SHADED).
                vec3 wxGeomN = normalize(cross(dFdx(vWxWorldPos), dFdy(vWxWorldPos)));
                float wxUp = smoothstep(${PUDDLE_FLAT_SOFT.toFixed(3)}, ${PUDDLE_FLAT_MIN.toFixed(3)}, wxGeomN.y);
                float wxNoise = wxFbm(vWxWorldPos.xz * ${PUDDLE_NOISE_SCALE.toFixed(2)});
                float wxThreshold = 1.0 - uWxPuddles * ${PUDDLE_MAX_COVER.toFixed(2)};
                float wxPuddleMask = smoothstep(wxThreshold, wxThreshold + ${PUDDLE_EDGE.toFixed(2)}, wxNoise)
                    * wxPuddleProgress * wxUp * ${PUDDLE_MASK_MAX.toFixed(2)};
                float wxDarken = mix(1.0, uWxDarken, wxRoughProgress)
                    * mix(1.0, ${PUDDLE_DARKEN.toFixed(2)}, wxPuddleMask)
                    * ${ALBEDO_MATCH.toFixed(2)};
                diffuseColor.rgb *= wxDarken;`,
            )
            .replace(
                '#include <roughnessmap_fragment>',
                `#include <roughnessmap_fragment>
                float wxFilmRough = mix(${ROUGH_DRY.toFixed(2)}, uWxFilmRough, wxRoughProgress)
                    + (wxNoise - 0.5) * ${ROUGH_VARIATION.toFixed(2)} * wxRoughProgress;
                roughnessFactor = clamp(mix(wxFilmRough, ${ROUGH_PUDDLE.toFixed(2)}, wxPuddleMask), 0.05, 1.0);`,
            )
            .replace(
                '#include <metalnessmap_fragment>',
                `#include <metalnessmap_fragment>
                metalnessFactor = wxPuddleMask * ${WET_METAL_PUDDLE.toFixed(2)}
                    + (1.0 - wxPuddleMask) * wxRoughProgress * ${WET_METAL_FILM.toFixed(2)};`,
            )
            .replace(
                '#include <normal_fragment_maps>',
                `#include <normal_fragment_maps>
                vec2 wxGrad = wxRippleGrad(vWxWorldPos.xz) * (uWxRipple * uWxRippleScale * ${RIPPLE_STRENGTH.toFixed(2)});
                vec3 wxWaterN = normalize(mat3(viewMatrix) * normalize(vec3(wxGrad.x, 1.0, wxGrad.y)));
                normal = normalize(mix(normal, wxWaterN, wxPuddleMask));`,
            );
    };
    material.customProgramCacheKey = () => `weather-wet-surface-v1-${opts.emissive ? 'e' : 'p'}`;

    if (opts.emissive) {
        // Same injection contract as the Lambert variant: it only touches
        // onBeforeCompile (composing with ours) + the emissive uniforms, both
        // of which MeshStandardMaterial shares.
        applyWebGlEmissive(material as unknown as THREE.MeshLambertMaterial);
    }

    return {
        material,
        setTime: (t) => { uniforms.uWxTime.value = t; },
        setWetness: (w) => { uniforms.uWxWetness.value = THREE.MathUtils.clamp(w, 0, 1); },
        setPuddles: (p) => { uniforms.uWxPuddles.value = THREE.MathUtils.clamp(p, 0, 1); },
        setRippleAmount: (a) => { uniforms.uWxRipple.value = THREE.MathUtils.clamp(a, 0, 1); },
        setLook: (look) => {
            uniforms.uWxFilmRough.value = THREE.MathUtils.clamp(1 - look.filmGloss, 0.02, 1);
            uniforms.uWxDarken.value = THREE.MathUtils.clamp(1 - look.surfaceDarkening, 0, 1);
            uniforms.uWxRippleScale.value = Math.max(0, look.rippleStrength);
            material.envMapIntensity = THREE.MathUtils.clamp(look.envSheen, 0, 1);
        },
        setEnvironment: (env) => {
            if (material.envMap !== env) {
                material.envMap = env;
                material.needsUpdate = true;
            }
        },
        dispose: () => { material.dispose(); },
    };
}
