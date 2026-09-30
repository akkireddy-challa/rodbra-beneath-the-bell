/**
 * The ocean's wave field — ONE definition, three consumers.
 *
 * A boat racing game only works if the hull rides the water the player can see.
 * Two hand-kept copies of the same sine sum (one in the shader, one in the
 * gameplay code) drift apart the moment either is tuned, and the symptom is
 * boats hovering above crests or ploughing through them. So the bands live here
 * once and every consumer is GENERATED from them:
 *
 *   - CPU   — `heightAt()` / `normalAt()`, for buoyancy, wake spawn points,
 *             course buoys, camera framing.
 *   - GLSL  — `glslSource()` emits `bmOceanWave(vec2 p, float t)` for the
 *             WebGL `ShaderMaterial` path.
 *   - TSL   — `tslWave()` builds the same expression as nodes for the WebGPU
 *             `NodeMaterial` path.
 *
 * All three evaluate in WORLD XZ, so a surface mesh that recenters on the
 * camera (see `engine/water/OceanSurface.ts`) keeps its waves pinned to the
 * world instead of swimming along with the viewer.
 *
 * ## Why sum-of-sines and not Gerstner
 *
 * Gerstner waves displace horizontally as well as vertically, which looks
 * better but makes "what is the surface height at (x, z)?" an inverse problem —
 * the CPU would have to iterate, and the answer would only ever approximate the
 * GPU's. A vertical-only sum stays analytically invertible: the CPU height is
 * EXACTLY the GPU height, to the last float. Crest sharpness (`sharpness > 1`)
 * buys back most of the peaked silhouette Gerstner would have given, and the
 * stylized shading does the rest.
 */

import * as THREE from 'three';
import { float, vec3, sin, cos, pow } from 'three/tsl';
// The TSL node type is not on the `three/webgpu` barrel; its own module is the
// only place it is exported (type-only import, erased at build time).
import type Node from 'three/src/nodes/core/Node.js';

/** One directional wave train in the field. */
export interface OceanWaveBand {
    /** Travel direction in world XZ. Normalized by `createOceanWaveField`. */
    dirX: number;
    dirZ: number;
    /** Crest-to-crest distance (m). */
    wavelength: number;
    /** Half the peak-to-trough height (m) this band contributes. */
    amplitude: number;
    /** Phase speed (m/s) along `dir`. */
    speed: number;
    /**
     * Crest shaping exponent. 1 = pure sine. Above 1 the crests narrow and the
     * troughs broaden — the swell silhouette real oceans have and a plain sine
     * does not. Values much above ~2.5 start to look like spikes.
     */
    sharpness: number;
}

/** Tuning applied on top of a band preset. */
export interface OceanWaveFieldOptions {
    /** Multiplies every band's amplitude. 1 = the preset's own sea state. */
    amplitudeScale: number;
    /** Multiplies every band's phase speed. 1 = the preset's own pace. */
    speedScale: number;
    /**
     * Rotates the whole field, in degrees clockwise from +Z. The bands keep
     * their relative angles, so the sea state is unchanged — only which way
     * the swell rolls.
     */
    windDirectionDeg: number;
}

export const DEFAULT_OCEAN_WAVE_FIELD_OPTIONS: OceanWaveFieldOptions = {
    amplitudeScale: 1,
    speedScale: 1,
    windDirectionDeg: 0,
};

/**
 * Open-ocean swell: a long primary roll with a cross swell over it and three
 * decreasing detail bands. Peak-to-trough is about 4.6 m at
 * `amplitudeScale: 1` — big enough that a racing boat visibly climbs and
 * launches off crests, small enough that the course stays readable.
 */
export const OPEN_OCEAN_WAVE_BANDS: readonly OceanWaveBand[] = Object.freeze([
    { dirX: 0.86, dirZ: 0.51, wavelength: 64, amplitude: 1.30, speed: 6.4, sharpness: 1.7 },
    { dirX: 0.42, dirZ: -0.91, wavelength: 33, amplitude: 0.62, speed: 4.6, sharpness: 1.5 },
    { dirX: -0.71, dirZ: 0.71, wavelength: 16, amplitude: 0.24, speed: 3.3, sharpness: 1.3 },
    { dirX: 0.99, dirZ: -0.14, wavelength: 7.4, amplitude: 0.10, speed: 2.3, sharpness: 1.0 },
    { dirX: -0.26, dirZ: -0.97, wavelength: 3.6, amplitude: 0.045, speed: 1.7, sharpness: 1.0 },
]);

/** Sheltered bay / lagoon: the same shape of field, a third of the sea state. */
export const CALM_LAGOON_WAVE_BANDS: readonly OceanWaveBand[] = Object.freeze(
    OPEN_OCEAN_WAVE_BANDS.map((b) => ({ ...b, amplitude: b.amplitude * 0.35, speed: b.speed * 0.8 })),
);

/** Storm: taller, sharper, faster. */
export const STORM_SEA_WAVE_BANDS: readonly OceanWaveBand[] = Object.freeze(
    OPEN_OCEAN_WAVE_BANDS.map((b) => ({
        ...b,
        amplitude: b.amplitude * 1.9,
        speed: b.speed * 1.25,
        sharpness: Math.min(2.4, b.sharpness * 1.2),
    })),
);

/** Named presets, so world.json can pick a sea state by name. */
export const OCEAN_WAVE_PRESETS = {
    calm: CALM_LAGOON_WAVE_BANDS,
    ocean: OPEN_OCEAN_WAVE_BANDS,
    storm: STORM_SEA_WAVE_BANDS,
} as const;

export type OceanWavePresetName = keyof typeof OCEAN_WAVE_PRESETS;

/** A band with its derived constants precomputed, so no consumer recomputes them. */
interface CompiledBand extends OceanWaveBand {
    /** Angular wavenumber, 2π / wavelength. */
    k: number;
    /** `dirX * k` — the x coefficient of the phase. */
    kx: number;
    /** `dirZ * k` — the z coefficient of the phase. */
    kz: number;
    /** `speed * k` — the angular frequency. */
    omega: number;
}

/**
 * The compiled wave field. Immutable: retune by building a new one (and
 * rebuilding the material, which bakes the bands into its shader).
 */
export interface OceanWaveField {
    readonly bands: readonly CompiledBand[];
    /** Sum of the band amplitudes — the theoretical crest height above mean (m). */
    readonly maxAmplitude: number;
    /** Surface Y offset from mean sea level at world (x, z) and time t. */
    heightAt(x: number, z: number, t: number): number;
    /** Surface gradient (∂h/∂x, ∂h/∂z) at world (x, z) — writes into `out`. */
    gradientAt(x: number, z: number, t: number, out: THREE.Vector2): THREE.Vector2;
    /** Unit surface normal at world (x, z) — writes into `out`. */
    normalAt(x: number, z: number, t: number, out: THREE.Vector3): THREE.Vector3;
    /**
     * GLSL source declaring `vec3 bmOceanWave(vec2 p, float t)`, returning
     * `(height, ∂h/∂x, ∂h/∂z)`. Paste into a `ShaderMaterial`'s vertex shader.
     */
    glslSource(): string;
    /**
     * The same function as TSL nodes: `(height, ∂h/∂x, ∂h/∂z)` at world
     * (`px`, `pz`) and `timeNode`.
     */
    tslWave(px: TslFloat, pz: TslFloat, timeNode: TslFloat): TslVec3;
}

export type TslFloat = Node<'float'>;
export type TslVec3 = Node<'vec3'>;

/** Guards `pow(u, s)` against u = 0 with a fractional exponent. */
const U_EPSILON = 1e-4;

export function createOceanWaveField(
    bands: readonly OceanWaveBand[] = OPEN_OCEAN_WAVE_BANDS,
    options: Partial<OceanWaveFieldOptions> = {},
): OceanWaveField {
    const opts = { ...DEFAULT_OCEAN_WAVE_FIELD_OPTIONS, ...options };
    const rot = -opts.windDirectionDeg * (Math.PI / 180);
    const cosR = Math.cos(rot);
    const sinR = Math.sin(rot);

    const compiled: CompiledBand[] = bands.map((b) => {
        // Rotate the direction into the requested wind heading, then normalize:
        // presets are authored with hand-rounded unit vectors that are only
        // unit to ~1e-3, and a wavenumber built off a non-unit direction makes
        // the shader and the CPU disagree about the wavelength.
        const rx = b.dirX * cosR - b.dirZ * sinR;
        const rz = b.dirX * sinR + b.dirZ * cosR;
        const len = Math.hypot(rx, rz) || 1;
        const dirX = rx / len;
        const dirZ = rz / len;
        const amplitude = b.amplitude * opts.amplitudeScale;
        const speed = b.speed * opts.speedScale;
        const k = (2 * Math.PI) / b.wavelength;
        return {
            dirX, dirZ, wavelength: b.wavelength, amplitude, speed, sharpness: b.sharpness,
            k, kx: dirX * k, kz: dirZ * k, omega: speed * k,
        };
    });

    const maxAmplitude = compiled.reduce((sum, b) => sum + b.amplitude, 0);

    const heightAt = (x: number, z: number, t: number): number => {
        let h = 0;
        for (const b of compiled) {
            const phase = x * b.kx + z * b.kz - t * b.omega;
            const u = Math.max(U_EPSILON, Math.sin(phase) * 0.5 + 0.5);
            h += b.amplitude * (2 * (b.sharpness === 1 ? u : Math.pow(u, b.sharpness)) - 1);
        }
        return h;
    };

    const gradientAt = (x: number, z: number, t: number, out: THREE.Vector2): THREE.Vector2 => {
        let dx = 0;
        let dz = 0;
        for (const b of compiled) {
            const phase = x * b.kx + z * b.kz - t * b.omega;
            const u = Math.max(U_EPSILON, Math.sin(phase) * 0.5 + 0.5);
            // d/dphase of A * (2 u^s - 1) with u = (sin+1)/2  ->  A s u^(s-1) cos(phase)
            const dh = b.amplitude * b.sharpness
                * (b.sharpness === 1 ? 1 : Math.pow(u, b.sharpness - 1))
                * Math.cos(phase);
            dx += dh * b.kx;
            dz += dh * b.kz;
        }
        return out.set(dx, dz);
    };

    const gradScratch = new THREE.Vector2();
    const normalAt = (x: number, z: number, t: number, out: THREE.Vector3): THREE.Vector3 => {
        gradientAt(x, z, t, gradScratch);
        return out.set(-gradScratch.x, 1, -gradScratch.y).normalize();
    };

    const glslSource = (): string => {
        const lines: string[] = [
            'vec3 bmOceanWave(vec2 p, float t) {',
            '    float h = 0.0; float dhx = 0.0; float dhz = 0.0;',
            '    float ph; float u; float d;',
        ];
        for (const b of compiled) {
            const f = (v: number): string => v.toPrecision(9);
            lines.push(`    ph = p.x * ${f(b.kx)} + p.y * ${f(b.kz)} - t * ${f(b.omega)};`);
            lines.push(`    u = max(${U_EPSILON.toPrecision(3)}, sin(ph) * 0.5 + 0.5);`);
            const uPow = b.sharpness === 1 ? 'u' : `pow(u, ${f(b.sharpness)})`;
            const uPowD = b.sharpness === 1 ? '1.0' : `pow(u, ${f(b.sharpness - 1)})`;
            lines.push(`    h += ${f(b.amplitude)} * (2.0 * ${uPow} - 1.0);`);
            lines.push(`    d = ${f(b.amplitude * b.sharpness)} * ${uPowD} * cos(ph);`);
            lines.push(`    dhx += d * ${f(b.kx)}; dhz += d * ${f(b.kz)};`);
        }
        lines.push('    return vec3(h, dhx, dhz);');
        lines.push('}');
        return lines.join('\n');
    };

    const tslWave = (px: TslFloat, pz: TslFloat, timeNode: TslFloat): TslVec3 => {
        let h: TslFloat = float(0);
        let dhx: TslFloat = float(0);
        let dhz: TslFloat = float(0);
        for (const b of compiled) {
            const phase = px.mul(b.kx).add(pz.mul(b.kz)).sub(timeNode.mul(b.omega));
            const u = sin(phase).mul(0.5).add(0.5).max(U_EPSILON);
            const uPow = b.sharpness === 1 ? u : pow(u, b.sharpness);
            h = h.add(uPow.mul(2 * b.amplitude).sub(b.amplitude));
            const base = cos(phase).mul(b.amplitude * b.sharpness);
            const d = b.sharpness === 1 ? base : base.mul(pow(u, b.sharpness - 1));
            dhx = dhx.add(d.mul(b.kx));
            dhz = dhz.add(d.mul(b.kz));
        }
        return vec3(h, dhx, dhz);
    };

    return {
        bands: compiled,
        maxAmplitude,
        heightAt,
        gradientAt,
        normalAt,
        glslSource,
        tslWave,
    };
}
