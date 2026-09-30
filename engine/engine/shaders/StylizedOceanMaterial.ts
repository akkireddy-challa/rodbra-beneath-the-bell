/**
 * Stylized (cel-shaded / painterly) ocean surface — the Wave-Race look:
 * saturated blue posterized into a handful of flat tones, irregular darker and
 * lighter patches drifting with the swell, hard-edged white caps on the crests
 * and scattered foam flecks between them.
 *
 * Distinct from `engine/shaders/WaterMaterial.ts`, which is the SEE-THROUGH
 * coastal plane for voxel levels with a visible seafloor. This one is opaque
 * open water for boat racing: nothing is meant to be visible under it, so it
 * writes depth and sorts normally against hulls, buoys and course markers
 * instead of fighting them as a transparent overlay.
 *
 * ## What produces the painted look
 *
 * Three things, in the order they matter:
 *
 * 1. **Posterization.** A single `tone` scalar is quantized to `toneBands`
 *    steps and used to pick from a four-stop palette. Flat regions of colour
 *    with hard boundaries are the whole style; a smooth gradient here reads as
 *    generic stylised water instead.
 * 2. **Three octaves of drifting patch noise**, and they carry MORE weight in
 *    `tone` than the lighting does. Real reference art has big irregular dark
 *    and light regions that have nothing to do with the wave shape — without
 *    them the sea is one flat blue with some crests in it.
 * 3. **Two kinds of white.** Caps sit where the surface is genuinely STEEP
 *    (gradient magnitude), not merely high — a long swell crest is not
 *    breaking, a short chop crest is. Flecks are small, sparse, wind-stretched
 *    specks that exist in the troughs too, and they are what stops the flat
 *    regions reading as plastic.
 *
 * Geometry contract (see `engine/water/OceanSurface.ts`): the mesh lies in the
 * XZ plane with y = 0, is NOT rotated or scaled, and translates in XZ to
 * follow the camera. World XZ is therefore `positionLocal.xz + origin`, and
 * `length(positionLocal.xz)` is the distance from the viewer — used for both
 * the displacement fade (distant rings are hundreds of metres apart and cannot
 * resolve a wave) and the horizon haze. The waves, and the patch/foam noise
 * that rides them, are sampled in WAVE space (`engine/water/OceanWaveFrame.ts`)
 * — world XZ, unless a voyage is moving the sea past a ship that holds still.
 * Lighting always uses the true world position.
 *
 * Dual renderer paths per `game/docs/renderer-backends.md`: TSL NodeMaterial on
 * WebGPU, GLSL ShaderMaterial on WebGL. The wave sum itself is generated for
 * both from `engine/water/OceanWaveField.ts`; the shading below is the only
 * hand-written duplication, and the two halves are kept literally
 * line-for-line parallel so a change to one is obvious in the other.
 */

import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
    Fn, uniform, vec2, vec3, float, varying, normalize, mix, floor, fract, dot,
    sin, pow, reflect, smoothstep, cameraPosition, positionLocal, length,
} from 'three/tsl';
// See OceanWaveField.ts: the TSL node type only exists on its own module.
import type Node from 'three/src/nodes/core/Node.js';
import { isWebGpuActive } from 'engine/RendererType.js';
import { createOceanWaveField, type OceanWaveField } from 'engine/water/OceanWaveField.js';
import type { OceanWaveFrame } from 'engine/water/OceanWaveFrame.js';

/** The colours the posterized surface is built from. */
export interface OceanPalette {
    /** Darkest tone — shadowed wave faces and the dark patches between them. */
    deep: THREE.ColorRepresentation;
    /** Body of the water. */
    mid: THREE.ColorRepresentation;
    /** Sunlit faces. */
    bright: THREE.ColorRepresentation;
    /** Lightest tone — crest shoulders and the pale patches. */
    shallow: THREE.ColorRepresentation;
    /** White caps and foam flecks. */
    foam: THREE.ColorRepresentation;
    /** What the sea fades into at the horizon. Match this to the sky's low band. */
    horizon: THREE.ColorRepresentation;
}

export interface StylizedOceanMaterialOptions {
    palette: OceanPalette;
    /** Wave field driving displacement AND the steepness that breaks into foam. */
    waveField: OceanWaveField;
    /**
     * Number of flat tone steps across the palette. 4-5 reads as painted; raise
     * toward 10 for a softer gradient, drop to 3 for a poster. Below 2 the
     * posterize is meaningless.
     */
    toneBands: number;
    /**
     * Where white caps start, on the combined height+steepness metric. Lower =
     * foamier sea. Around 0.55-0.7 for most sea states.
     */
    foamThreshold: number;
    /** Strength (0..1) of the sparse drifting foam flecks. */
    fleckStrength: number;
    /** Distance (m) from the viewer where wave displacement starts flattening. */
    waveFadeStart: number;
    /** Distance (m) where displacement has fully flattened. */
    waveFadeEnd: number;
    /** Distance (m) where the horizon haze starts. */
    hazeStart: number;
    /** Distance (m) where the sea has fully become `palette.horizon`. */
    hazeEnd: number;
    /**
     * Distance (m) where foam, flecks and glint start thinning out. Separate
     * from the colour haze on purpose: fine white detail has to die FAR
     * earlier than colour does, or a raised camera sees a sea of sub-pixel
     * speckle that aliases into static.
     */
    detailFadeStart: number;
    /** Distance (m) where the fine white detail is gone entirely. */
    detailFadeEnd: number;
    /** Sun direction (world, pointing FROM the surface TOWARD the sun). */
    sunDirection: THREE.Vector3;
}

/** Reference-matched open-ocean palette: deep cobalt through pale cyan. */
export const DEFAULT_OCEAN_PALETTE: OceanPalette = {
    deep: 0x0a2a80,
    mid: 0x1550c4,
    bright: 0x2f8ade,
    shallow: 0x74d2ea,
    foam: 0xf2fbff,
    horizon: 0x4f8ecb,
};

export const DEFAULT_STYLIZED_OCEAN_OPTIONS: Omit<StylizedOceanMaterialOptions, 'waveField'> = {
    palette: DEFAULT_OCEAN_PALETTE,
    toneBands: 5,
    foamThreshold: 0.60,
    fleckStrength: 0.85,
    waveFadeStart: 150,
    waveFadeEnd: 620,
    hazeStart: 520,
    hazeEnd: 3200,
    detailFadeStart: 70,
    detailFadeEnd: 300,
    sunDirection: new THREE.Vector3(0.42, 0.78, 0.46).normalize(),
};

export interface StylizedOceanMaterialHandle {
    material: THREE.Material;
    /** Animation clock, in seconds. Drive once per frame. */
    setTime(seconds: number): void;
    /** World XZ the mesh has been translated to (its wave phase origin). */
    setOrigin(x: number, z: number): void;
    /**
     * Sample the waves — and the patch, foam and fleck noise that rides them —
     * through `frame` rather than straight from world XZ, so the sea can move
     * past something that holds still. Identity until set. See
     * `engine/water/OceanWaveFrame.ts`.
     */
    setWaveFrame(frame: Readonly<OceanWaveFrame>): void;
    setSunDirection(dir: THREE.Vector3): void;
    /** Late palette tweak (level atmosphere change). Colours are read by reference. */
    setHorizonColor(color: THREE.ColorRepresentation): void;
    dispose(): void;
}

/**
 * Hash/value-noise constants, shared verbatim by both backends so the WebGL and
 * WebGPU paths produce the SAME patch layout — otherwise a screenshot taken on
 * one backend can't be compared against the other.
 */
const HASH_A = 127.1;
const HASH_B = 311.7;
const HASH_C = 43758.5453123;

/**
 * Patch-noise frequencies (1/m). Three octaves: ~150 m regions of darker and
 * lighter sea, ~36 m patches, and ~9 m mottling. The weights matter as much as
 * the frequencies — leaning too hard on the lowest octave paints whole
 * SCREENFULS of one flat tone, because 150 m is most of the near field.
 */
const PATCH_FREQ_LO = 0.0065;
const PATCH_FREQ_MID = 0.028;
const PATCH_FREQ_HI = 0.11;
const PATCH_W_LO = 0.32;
const PATCH_W_MID = 0.40;
const PATCH_W_HI = 0.28;

/** Foam-break noise: fine, so caps land in patches along a crest, not in stripes. */
const FOAM_FREQ_LO = 0.14;
const FOAM_FREQ_HI = 0.5;

/** Fleck noise, stretched along the wind into short spray streaks. */
const FLECK_FREQ_ALONG = 1.05;
const FLECK_FREQ_ACROSS = 2.4;
const FLECK_CUT_LO = 0.872;
const FLECK_CUT_HI = 0.898;

/**
 * How `tone` is mixed, around a base that flat water sits at. The lighting term
 * is RELATIVE to flat water (see the fragment code), so its weight is larger
 * than the others without swamping them.
 */
const TONE_BASE = 0.44;
const TONE_W_HEIGHT = 0.72;
const TONE_W_LIGHT = 1.30;
const TONE_W_PATCH = 0.72;

/** Steepness (|∇h|) contribution to breaking. Clamped: a spike is not more foam. */
const FOAM_STEEP_CLAMP = 1.1;
const FOAM_W_HEIGHT = 0.46;
const FOAM_W_STEEP = 0.52;
const FOAM_W_NOISE = 0.42;
const FOAM_BIAS = -0.14;
/** Width of the cap ramp. Narrow on purpose: a soft ramp paints pale-blue
 *  lozenges where the style wants hard white. */
const FOAM_EDGE = 0.025;

const GLSL_NOISE = `
float bmHash(vec2 p) {
    return fract(sin(dot(p, vec2(${HASH_A}, ${HASH_B}))) * ${HASH_C});
}
float bmNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 w = f * f * (3.0 - 2.0 * f);
    float a = bmHash(i);
    float b = bmHash(i + vec2(1.0, 0.0));
    float c = bmHash(i + vec2(0.0, 1.0));
    float d = bmHash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}
`;

type Vec2Node = Node<'vec2'>;
type FloatNode = Node<'float'>;

/**
 * `varying()` is typed as `VaryingNode<unknown>`, which drops every chained
 * operator. The value it carries is exactly the node handed in, so re-assert
 * that type rather than losing `.mul()`/`.x` on everything downstream.
 */
function asVarying<T>(node: unknown): T {
    return node as T;
}

/** TSL twin of `bmHash` above. */
function tslHash(p: Vec2Node): FloatNode {
    return fract(sin(dot(p, vec2(HASH_A, HASH_B))).mul(HASH_C));
}

/** TSL twin of `bmNoise` above. */
function tslNoise(p: Vec2Node): FloatNode {
    const i = floor(p);
    const f = fract(p);
    const w = f.mul(f).mul(vec2(3, 3).sub(f.mul(2)));
    const a = tslHash(i);
    const b = tslHash(i.add(vec2(1, 0)));
    const c = tslHash(i.add(vec2(0, 1)));
    const d = tslHash(i.add(vec2(1, 1)));
    return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}

/** The swell's dominant travel direction, used to drift the patch noise with it. */
function flowDirection(field: OceanWaveField): THREE.Vector2 {
    const primary = field.bands[0];
    if (!primary) return new THREE.Vector2(1, 0);
    return new THREE.Vector2(primary.dirX, primary.dirZ);
}

interface Derived {
    cDeep: THREE.Color;
    cMid: THREE.Color;
    cBright: THREE.Color;
    cShallow: THREE.Color;
    cFoam: THREE.Color;
    cHorizon: THREE.Color;
    invMaxAmp: number;
    bands: number;
}

export function createStylizedOceanMaterial(
    options: Partial<StylizedOceanMaterialOptions> = {},
): StylizedOceanMaterialHandle {
    const opts: StylizedOceanMaterialOptions = {
        ...DEFAULT_STYLIZED_OCEAN_OPTIONS,
        waveField: options.waveField ?? createOceanWaveField(),
        ...options,
        palette: { ...DEFAULT_OCEAN_PALETTE, ...(options.palette ?? {}) },
    };
    const field = opts.waveField;
    const flow = flowDirection(field);
    const p = opts.palette;
    const derived: Derived = {
        cDeep: new THREE.Color(p.deep),
        cMid: new THREE.Color(p.mid),
        cBright: new THREE.Color(p.bright),
        cShallow: new THREE.Color(p.shallow),
        cFoam: new THREE.Color(p.foam),
        cHorizon: new THREE.Color(p.horizon),
        // maxAmplitude is 0 for a dead-flat preset; never divide by it directly.
        invMaxAmp: 1 / Math.max(1e-3, field.maxAmplitude),
        bands: Math.max(2, Math.round(opts.toneBands)),
    };

    return isWebGpuActive()
        ? buildNodeMaterial(opts, field, flow, derived)
        : buildShaderMaterial(opts, field, flow, derived);
}

function buildNodeMaterial(
    opts: StylizedOceanMaterialOptions,
    field: OceanWaveField,
    flow: THREE.Vector2,
    d: Derived,
): StylizedOceanMaterialHandle {
    const uTime = uniform(0);
    const uOrigin = uniform(new THREE.Vector2(0, 0));
    // OceanWaveFrame: (cos, sin) of the world→wave rotation, then the shift.
    const uWaveRot = uniform(new THREE.Vector2(1, 0));
    const uWaveShift = uniform(new THREE.Vector2(0, 0));
    const uSun = uniform(opts.sunDirection.clone().normalize());
    const uHorizon = uniform(d.cHorizon);
    const material = new MeshBasicNodeMaterial({ side: THREE.FrontSide });
    material.name = 'StylizedOcean';

    // ---- vertex ----
    // Distance from the viewer is the LOCAL radius: the mesh origin tracks the
    // camera in XZ (OceanSurface), so no camera uniform is needed here.
    const localDist = length(vec2(positionLocal.x, positionLocal.z));
    const fade = float(1).sub(smoothstep(opts.waveFadeStart, opts.waveFadeEnd, localDist));
    const worldXZ = vec2(positionLocal.x.add(uOrigin.x), positionLocal.z.add(uOrigin.y));
    const waveXZ = vec2(
        uWaveRot.x.mul(worldXZ.x).sub(uWaveRot.y.mul(worldXZ.y)).add(uWaveShift.x),
        uWaveRot.y.mul(worldXZ.x).add(uWaveRot.x.mul(worldXZ.y)).add(uWaveShift.y),
    );
    const wave = field.tslWave(waveXZ.x, waveXZ.y, uTime);
    const displacedY = wave.x.mul(fade);
    material.positionNode = vec3(positionLocal.x, displacedY, positionLocal.z);

    // The field's gradient is in wave space; take it back to world (Aᵀ · g).
    const worldGrad = vec2(
        uWaveRot.x.mul(wave.y).add(uWaveRot.y.mul(wave.z)),
        uWaveRot.x.mul(wave.z).sub(uWaveRot.y.mul(wave.y)),
    );
    const vWorldXZ = asVarying<Vec2Node>(varying(worldXZ));
    const vWaveXZ = asVarying<Vec2Node>(varying(waveXZ));
    const vH = asVarying<FloatNode>(varying(wave.x.mul(d.invMaxAmp)));
    const vGrad = asVarying<Vec2Node>(varying(worldGrad.mul(fade)));
    const vDist = asVarying<FloatNode>(varying(localDist));
    const vWorldY = asVarying<FloatNode>(varying(displacedY));

    // ---- fragment ----
    material.colorNode = Fn(() => {
        const N = normalize(vec3(vGrad.x.negate(), 1, vGrad.y.negate()));
        const L = normalize(uSun);
        const worldPos = vec3(vWorldXZ.x, vWorldY, vWorldXZ.y);
        const V = normalize(cameraPosition.sub(worldPos));

        // Lighting RELATIVE to flat water: dot(N, L) minus what a flat surface
        // would give (which is just L.y). Absolute lambert is biased by the sun
        // height — under a high sun every gentle swell reads ~0.9 and the whole
        // near field collapses onto one bright palette step, whatever the noise
        // does. Relative, flat water sits mid-palette and only the faces that
        // are genuinely turned toward or away from the sun move off it.
        const lamRel = dot(N, L).sub(L.y);
        const h01 = vH.mul(0.5).add(0.5).clamp(0, 1);
        const steep = length(vGrad).min(FOAM_STEEP_CLAMP);

        const drift = vec2(flow.x, flow.y).mul(uTime);
        const q = vWaveXZ;
        const patch = tslNoise(q.mul(PATCH_FREQ_LO).add(drift.mul(0.012))).mul(PATCH_W_LO)
            .add(tslNoise(q.mul(PATCH_FREQ_MID).add(drift.mul(0.05))).mul(PATCH_W_MID))
            .add(tslNoise(q.mul(PATCH_FREQ_HI).sub(drift.mul(0.10))).mul(PATCH_W_HI));

        const tone = float(TONE_BASE)
            .add(h01.sub(0.5).mul(TONE_W_HEIGHT))
            .add(lamRel.mul(TONE_W_LIGHT))
            .add(patch.sub(0.5).mul(TONE_W_PATCH))
            .clamp(0, 1);
        // Posterize. floor(tone*bands) lands in 0..bands-1; dividing by
        // bands-1 stretches that back over the full palette so the top step
        // reaches `shallow` instead of stopping short of it.
        const toneStep = floor(tone.mul(d.bands)).min(d.bands - 1).div(d.bands - 1);

        const t3 = toneStep.mul(3);
        let col = mix(vec3(d.cDeep.r, d.cDeep.g, d.cDeep.b), vec3(d.cMid.r, d.cMid.g, d.cMid.b), t3.clamp(0, 1));
        col = mix(col, vec3(d.cBright.r, d.cBright.g, d.cBright.b), t3.sub(1).clamp(0, 1));
        col = mix(col, vec3(d.cShallow.r, d.cShallow.g, d.cShallow.b), t3.sub(2).clamp(0, 1));

        // White caps break where the surface is STEEP, not merely high.
        const foamNoise = tslNoise(q.mul(FOAM_FREQ_LO).add(drift.mul(0.05))).mul(0.55)
            .add(tslNoise(q.mul(FOAM_FREQ_HI).sub(drift.mul(0.09))).mul(0.45));
        const foamRaw = h01.mul(FOAM_W_HEIGHT)
            .add(steep.mul(FOAM_W_STEEP))
            .add(foamNoise.mul(FOAM_W_NOISE))
            .add(FOAM_BIAS);
        let foam = smoothstep(opts.foamThreshold, opts.foamThreshold + FOAM_EDGE, foamRaw);

        // Wind-stretched flecks: sparse specks of spray that exist off the
        // crests too, which is what stops the flat tone regions reading as
        // plastic. Sampled in a frame aligned to the swell so they streak.
        const along = dot(q, vec2(flow.x, flow.y));
        const across = dot(q, vec2(-flow.y, flow.x));
        const fleckP = vec2(along.mul(FLECK_FREQ_ALONG).add(uTime.mul(0.35)), across.mul(FLECK_FREQ_ACROSS));
        const flecks = smoothstep(FLECK_CUT_LO, FLECK_CUT_HI, tslNoise(fleckP)).mul(opts.fleckStrength);
        foam = foam.max(flecks);

        // Toon glitter: a hard-edged specular patch rather than a smooth lobe.
        const spec = pow(dot(reflect(L.negate(), N), V).max(0), 26);
        const glint = smoothstep(0.25, 0.45, spec);

        const haze = smoothstep(opts.hazeStart, opts.hazeEnd, vDist);
        // Fine detail dies well before the colour does: past a few hundred
        // metres a fleck is sub-pixel and only aliases.
        const detail = float(1).sub(smoothstep(opts.detailFadeStart, opts.detailFadeEnd, vDist));
        col = mix(col, vec3(d.cFoam.r, d.cFoam.g, d.cFoam.b), foam.mul(detail));
        col = mix(col, vec3(1, 1, 1), glint.mul(0.5).mul(detail));
        return mix(col, uHorizon, haze);
    })();

    return {
        material,
        setTime: (t) => { uTime.value = t; },
        setOrigin: (x, z) => { (uOrigin.value as THREE.Vector2).set(x, z); },
        setWaveFrame: (frame) => {
            (uWaveRot.value as THREE.Vector2).set(frame.cos, frame.sin);
            (uWaveShift.value as THREE.Vector2).set(frame.shiftX, frame.shiftZ);
        },
        setSunDirection: (dir) => { (uSun.value as THREE.Vector3).copy(dir).normalize(); },
        setHorizonColor: (c) => { (uHorizon.value as THREE.Color).set(c); },
        dispose: () => material.dispose(),
    };
}

function buildShaderMaterial(
    opts: StylizedOceanMaterialOptions,
    field: OceanWaveField,
    flow: THREE.Vector2,
    d: Derived,
): StylizedOceanMaterialHandle {
    const uniforms = {
        uTime: { value: 0 },
        uOrigin: { value: new THREE.Vector2(0, 0) },
        uWaveRot: { value: new THREE.Vector2(1, 0) },
        uWaveShift: { value: new THREE.Vector2(0, 0) },
        uSunDir: { value: opts.sunDirection.clone().normalize() },
        uDeep: { value: d.cDeep },
        uMid: { value: d.cMid },
        uBright: { value: d.cBright },
        uShallow: { value: d.cShallow },
        uFoam: { value: d.cFoam },
        uHorizon: { value: d.cHorizon },
    };
    const f = (v: number): string => v.toPrecision(9);
    const material = new THREE.ShaderMaterial({
        side: THREE.FrontSide,
        uniforms,
        vertexShader: `
            uniform float uTime;
            uniform vec2 uOrigin;
            uniform vec2 uWaveRot;
            uniform vec2 uWaveShift;
            varying vec2 vWorldXZ;
            varying vec2 vWaveXZ;
            varying float vH;
            varying vec2 vGrad;
            varying float vDist;
            varying float vWorldY;
            ${field.glslSource()}
            void main() {
                vDist = length(position.xz);
                float fade = 1.0 - smoothstep(${f(opts.waveFadeStart)}, ${f(opts.waveFadeEnd)}, vDist);
                vWorldXZ = position.xz + uOrigin;
                vWaveXZ = vec2(uWaveRot.x * vWorldXZ.x - uWaveRot.y * vWorldXZ.y,
                               uWaveRot.y * vWorldXZ.x + uWaveRot.x * vWorldXZ.y) + uWaveShift;
                vec3 w = bmOceanWave(vWaveXZ, uTime);
                vWorldY = w.x * fade;
                vH = w.x * ${f(d.invMaxAmp)};
                // The field's gradient is in wave space; take it back to world (A^T * g).
                vGrad = vec2(uWaveRot.x * w.y + uWaveRot.y * w.z,
                             uWaveRot.x * w.z - uWaveRot.y * w.y) * fade;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position.x, vWorldY, position.z, 1.0);
            }
        `,
        fragmentShader: `
            uniform float uTime;
            uniform vec3 uSunDir;
            uniform vec3 uDeep;
            uniform vec3 uMid;
            uniform vec3 uBright;
            uniform vec3 uShallow;
            uniform vec3 uFoam;
            uniform vec3 uHorizon;
            varying vec2 vWorldXZ;
            varying vec2 vWaveXZ;
            varying float vH;
            varying vec2 vGrad;
            varying float vDist;
            varying float vWorldY;
            ${GLSL_NOISE}
            void main() {
                vec3 N = normalize(vec3(-vGrad.x, 1.0, -vGrad.y));
                vec3 L = normalize(uSunDir);
                vec3 worldPos = vec3(vWorldXZ.x, vWorldY, vWorldXZ.y);
                vec3 V = normalize(cameraPosition - worldPos);

                float lamRel = dot(N, L) - L.y;
                float h01 = clamp(vH * 0.5 + 0.5, 0.0, 1.0);
                float steep = min(length(vGrad), ${f(FOAM_STEEP_CLAMP)});

                vec2 drift = vec2(${f(flow.x)}, ${f(flow.y)}) * uTime;
                vec2 q = vWaveXZ;
                // NOT named 'patch' — that is a reserved word in GLSL ES and the
                // shader silently fails to compile on the WebGL backend only.
                float patchTone = bmNoise(q * ${f(PATCH_FREQ_LO)} + drift * 0.012) * ${f(PATCH_W_LO)}
                            + bmNoise(q * ${f(PATCH_FREQ_MID)} + drift * 0.05) * ${f(PATCH_W_MID)}
                            + bmNoise(q * ${f(PATCH_FREQ_HI)} - drift * 0.10) * ${f(PATCH_W_HI)};

                float tone = clamp(${f(TONE_BASE)}
                    + (h01 - 0.5) * ${f(TONE_W_HEIGHT)}
                    + lamRel * ${f(TONE_W_LIGHT)}
                    + (patchTone - 0.5) * ${f(TONE_W_PATCH)}, 0.0, 1.0);
                float toneStep = min(floor(tone * ${f(d.bands)}), ${f(d.bands - 1)}) / ${f(d.bands - 1)};

                float t3 = toneStep * 3.0;
                vec3 col = mix(uDeep, uMid, clamp(t3, 0.0, 1.0));
                col = mix(col, uBright, clamp(t3 - 1.0, 0.0, 1.0));
                col = mix(col, uShallow, clamp(t3 - 2.0, 0.0, 1.0));

                float foamNoise = bmNoise(q * ${f(FOAM_FREQ_LO)} + drift * 0.05) * 0.55
                                + bmNoise(q * ${f(FOAM_FREQ_HI)} - drift * 0.09) * 0.45;
                float foamRaw = h01 * ${f(FOAM_W_HEIGHT)}
                              + steep * ${f(FOAM_W_STEEP)}
                              + foamNoise * ${f(FOAM_W_NOISE)}
                              + ${f(FOAM_BIAS)};
                float foam = smoothstep(${f(opts.foamThreshold)}, ${f(opts.foamThreshold + FOAM_EDGE)}, foamRaw);

                float along = dot(q, vec2(${f(flow.x)}, ${f(flow.y)}));
                float across = dot(q, vec2(${f(-flow.y)}, ${f(flow.x)}));
                vec2 fleckP = vec2(along * ${f(FLECK_FREQ_ALONG)} + uTime * 0.35, across * ${f(FLECK_FREQ_ACROSS)});
                float flecks = smoothstep(${f(FLECK_CUT_LO)}, ${f(FLECK_CUT_HI)}, bmNoise(fleckP)) * ${f(opts.fleckStrength)};
                foam = max(foam, flecks);

                vec3 R = reflect(-L, N);
                float spec = pow(max(dot(R, V), 0.0), 26.0);
                float glint = smoothstep(0.25, 0.45, spec);

                float haze = smoothstep(${f(opts.hazeStart)}, ${f(opts.hazeEnd)}, vDist);
                float detail = 1.0 - smoothstep(${f(opts.detailFadeStart)}, ${f(opts.detailFadeEnd)}, vDist);
                col = mix(col, uFoam, foam * detail);
                col = mix(col, vec3(1.0), glint * 0.5 * detail);
                col = mix(col, uHorizon, haze);
                gl_FragColor = vec4(col, 1.0);
            }
        `,
    });
    material.name = 'StylizedOcean';

    return {
        material,
        setTime: (t) => { uniforms.uTime.value = t; },
        setOrigin: (x, z) => { uniforms.uOrigin.value.set(x, z); },
        setWaveFrame: (frame) => {
            uniforms.uWaveRot.value.set(frame.cos, frame.sin);
            uniforms.uWaveShift.value.set(frame.shiftX, frame.shiftZ);
        },
        setSunDirection: (dir) => { uniforms.uSunDir.value.copy(dir).normalize(); },
        setHorizonColor: (c) => { uniforms.uHorizon.value.set(c); },
        dispose: () => material.dispose(),
    };
}
