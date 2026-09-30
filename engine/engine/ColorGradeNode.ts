/**
 * Final-image color grading + vignette (WebGPU / TSL post-process, with a
 * classic-composer GLSL twin) — the "look" controls a creator reaches for after
 * lighting: saturation, contrast, white balance, lift/gamma/gain and darkened
 * edges.
 *
 * DISPLAY-REFERRED: both paths run AFTER tone mapping and the sRGB encode, on
 * the 0..1 values the player actually sees. That is what makes the knobs behave
 * like any photo editor's (contrast pivots on visual mid-grey, a vignette's
 * darkening is uniform across bright and dark scenes) instead of fighting the
 * tone curve. On WebGPU the pipeline switches `outputColorTransform` off and
 * applies `renderOutput` itself before this node; on WebGL the pass sits after
 * `OutputPass`.
 *
 * UNIFORMS, NOT CONSTANTS: unlike posterize, every parameter lives in a
 * {@link ColorGradeState} the engine owns for its whole life. A runtime change
 * (a low-health desaturate, a damage vignette pulse) writes the uniforms and
 * costs nothing; only switching the pass on or off rebuilds the pipeline.
 * A disabled half is written as its identity (grade) or zero intensity
 * (vignette), so one node serves "grade only", "vignette only" and both.
 *
 * Kept line-for-line parallel with the GLSL in {@link COLOR_GRADE_FRAGMENT}
 * (see `game/docs/renderer-backends.md` for the dual-path contract). three
 * ships an untyped node/TSL surface, so nodes are carried as the branded
 * `Node<T>` type (as in `PosterizeNode`).
 */
import * as THREE from 'three';
import { dot, vec2, vec3, vec4, float, mix, uniform, screenUV, screenSize, smoothstep, clamp, pow, max } from 'three/tsl';
import type Node from 'three/src/nodes/core/Node.js';
import type { ColorGradingConfig, VignetteConfig } from 'types/game.js';

type Vec4Node = Node<'vec4'>;

/** Rec. 709 luma weights — the same axis posterize quantizes. */
const LUMA_WEIGHTS: [number, number, number] = [0.2126, 0.7152, 0.0722];

/** Fully-resolved grade. Every field neutral in {@link DEFAULT_COLOR_GRADING}. */
export interface ColorGradeParams {
    brightness: number;
    contrast: number;
    saturation: number;
    temperature: number;
    tint: number;
    lift: [number, number, number];
    gamma: [number, number, number];
    gain: [number, number, number];
}

/** Fully-resolved vignette. */
export interface VignetteParams {
    intensity: number;
    radius: number;
    softness: number;
    color: string;
}

/** Identity grade — applying it leaves the image unchanged. */
export const DEFAULT_COLOR_GRADING: ColorGradeParams = {
    brightness: 0,
    contrast: 1,
    saturation: 1,
    temperature: 0,
    tint: 0,
    lift: [0, 0, 0],
    gamma: [1, 1, 1],
    gain: [1, 1, 1],
};

/** A gentle cinematic vignette: clear centre, corners darkened by half. */
export const DEFAULT_VIGNETTE: VignetteParams = {
    intensity: 0.5,
    radius: 0.55,
    softness: 0.45,
    color: '#000000',
};

/** How far ±1 temperature / tint moves the white-balance gains. */
const WHITE_BALANCE_RANGE = 0.2;

const clampRange = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const triple = (v: [number, number, number] | undefined, fallback: [number, number, number], lo: number, hi: number): [number, number, number] =>
    (v ?? fallback).map((c) => clampRange(c, lo, hi)) as [number, number, number];

/** Resolve a (possibly partial) `colorGrading` config into full, clamped params. */
export function resolveColorGrading(cfg: ColorGradingConfig | null | undefined): ColorGradeParams {
    const d = DEFAULT_COLOR_GRADING;
    return {
        brightness: clampRange(cfg?.brightness ?? d.brightness, -1, 1),
        contrast: clampRange(cfg?.contrast ?? d.contrast, 0, 3),
        saturation: clampRange(cfg?.saturation ?? d.saturation, 0, 3),
        temperature: clampRange(cfg?.temperature ?? d.temperature, -1, 1),
        tint: clampRange(cfg?.tint ?? d.tint, -1, 1),
        lift: triple(cfg?.lift, d.lift, -1, 1),
        gamma: triple(cfg?.gamma, d.gamma, 0.1, 5),
        gain: triple(cfg?.gain, d.gain, 0, 4),
    };
}

/** Resolve a (possibly partial) `vignette` config into full, clamped params. */
export function resolveVignette(cfg: VignetteConfig | null | undefined): VignetteParams {
    const d = DEFAULT_VIGNETTE;
    return {
        intensity: clampRange(cfg?.intensity ?? d.intensity, 0, 1),
        radius: clampRange(cfg?.radius ?? d.radius, 0, 1.5),
        softness: clampRange(cfg?.softness ?? d.softness, 0.001, 1.5),
        color: cfg?.color ?? d.color,
    };
}

/**
 * Live grade + vignette uniforms for BOTH backends. The engine owns one for its
 * lifetime; the pipeline builders read from it and the runtime setters write
 * to it, so a value change never needs a rebuild.
 */
export class ColorGradeState {
    // TSL side (WebGPU pipeline).
    readonly brightness = uniform(0);
    readonly contrast = uniform(1);
    readonly saturation = uniform(1);
    readonly whiteBalance = uniform(new THREE.Vector3(1, 1, 1));
    readonly lift = uniform(new THREE.Vector3());
    readonly invGamma = uniform(new THREE.Vector3(1, 1, 1));
    readonly gain = uniform(new THREE.Vector3(1, 1, 1));
    readonly vignetteIntensity = uniform(0);
    readonly vignetteRadius = uniform(DEFAULT_VIGNETTE.radius);
    readonly vignetteSoftness = uniform(DEFAULT_VIGNETTE.softness);
    readonly vignetteColor = uniform(new THREE.Color(0, 0, 0));

    /** GLSL side — handed to the WebGL ShaderPass by reference (not cloned). */
    readonly glUniforms = {
        tDiffuse: { value: null as THREE.Texture | null },
        brightness: { value: 0 },
        contrast: { value: 1 },
        saturation: { value: 1 },
        whiteBalance: { value: new THREE.Vector3(1, 1, 1) },
        lift: { value: new THREE.Vector3() },
        invGamma: { value: new THREE.Vector3(1, 1, 1) },
        gain: { value: new THREE.Vector3(1, 1, 1) },
        vignetteIntensity: { value: 0 },
        vignetteRadius: { value: DEFAULT_VIGNETTE.radius },
        vignetteSoftness: { value: DEFAULT_VIGNETTE.softness },
        vignetteColor: { value: new THREE.Color(0, 0, 0) },
    };

    /** Write a resolved grade (or the identity, when `null` = disabled). */
    setGrade(p: ColorGradeParams | null): void {
        const g = p ?? DEFAULT_COLOR_GRADING;
        const wb = new THREE.Vector3(
            1 + g.temperature * WHITE_BALANCE_RANGE,
            1 - g.tint * WHITE_BALANCE_RANGE,
            1 - g.temperature * WHITE_BALANCE_RANGE,
        );
        const invGamma = new THREE.Vector3(1 / g.gamma[0], 1 / g.gamma[1], 1 / g.gamma[2]);
        const u = this.glUniforms;
        this.brightness.value = u.brightness.value = g.brightness;
        this.contrast.value = u.contrast.value = g.contrast;
        this.saturation.value = u.saturation.value = g.saturation;
        this.whiteBalance.value.copy(wb);
        u.whiteBalance.value.copy(wb);
        this.lift.value.fromArray(g.lift);
        u.lift.value.fromArray(g.lift);
        this.invGamma.value.copy(invGamma);
        u.invGamma.value.copy(invGamma);
        this.gain.value.fromArray(g.gain);
        u.gain.value.fromArray(g.gain);
    }

    /** Write a resolved vignette (or zero intensity, when `null` = disabled). */
    setVignette(p: VignetteParams | null): void {
        const u = this.glUniforms;
        this.vignetteIntensity.value = u.vignetteIntensity.value = p?.intensity ?? 0;
        if (!p) return;
        this.vignetteRadius.value = u.vignetteRadius.value = p.radius;
        this.vignetteSoftness.value = u.vignetteSoftness.value = p.softness;
        // Display-referred: keep the hex in sRGB rather than THREE.Color's
        // default conversion to the linear working space.
        this.vignetteColor.value.set(p.color).convertLinearToSRGB();
        u.vignetteColor.value.copy(this.vignetteColor.value);
    }
}

/**
 * Grade then vignette `displayColor` (already tone-mapped + sRGB-encoded).
 * Order: white balance → brightness → contrast → saturation → lift/gamma/gain
 * → clamp → vignette. Mirrors {@link COLOR_GRADE_FRAGMENT} step for step.
 */
export function applyColorGrade(displayColor: Vec4Node, s: ColorGradeState): Vec4Node {
    let c = displayColor.rgb.mul(s.whiteBalance);
    c = c.add(s.brightness);
    c = c.sub(0.5).mul(s.contrast).add(0.5);
    c = mix(vec3(dot(c, vec3(...LUMA_WEIGHTS))), c, s.saturation);
    // ASC-style: lift raises the blacks without moving white, gain scales, gamma bends the mids.
    c = c.add(s.lift.mul(float(1).sub(c))).mul(s.gain);
    c = pow(max(c, vec3(0)), s.invGamma);
    c = clamp(c, 0, 1);

    // Aspect-corrected radial distance, normalised so the corners are 1.
    const aspect = vec2(screenSize.x.div(screenSize.y), 1);
    const d = screenUV.sub(0.5).mul(2).mul(aspect).length().div(aspect.length());
    const v = smoothstep(s.vignetteRadius, s.vignetteRadius.add(s.vignetteSoftness), d).mul(s.vignetteIntensity);
    c = mix(c, s.vignetteColor, v);
    return vec4(c, displayColor.a) as unknown as Vec4Node;
}

/** GLSL twin of {@link applyColorGrade}, for a `ShaderPass` after `OutputPass`. */
export const COLOR_GRADE_FRAGMENT = /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float brightness;
    uniform float contrast;
    uniform float saturation;
    uniform vec3 whiteBalance;
    uniform vec3 lift;
    uniform vec3 invGamma;
    uniform vec3 gain;
    uniform float vignetteIntensity;
    uniform float vignetteRadius;
    uniform float vignetteSoftness;
    uniform vec3 vignetteColor;
    varying vec2 vUv;
    void main() {
        vec4 src = texture2D(tDiffuse, vUv);
        vec3 c = src.rgb * whiteBalance;
        c += brightness;
        c = (c - 0.5) * contrast + 0.5;
        c = mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, saturation);
        c = (c + lift * (1.0 - c)) * gain;
        c = pow(max(c, vec3(0.0)), invGamma);
        c = clamp(c, 0.0, 1.0);

        vec2 texSize = vec2(textureSize(tDiffuse, 0));
        vec2 aspect = vec2(texSize.x / texSize.y, 1.0);
        float d = length((vUv - 0.5) * 2.0 * aspect) / length(aspect);
        float v = smoothstep(vignetteRadius, vignetteRadius + vignetteSoftness, d) * vignetteIntensity;
        c = mix(c, vignetteColor, v);
        gl_FragColor = vec4(c, src.a);
    }
`;

export const COLOR_GRADE_VERTEX = /* glsl */`
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;
