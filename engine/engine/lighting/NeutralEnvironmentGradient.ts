import * as THREE from 'three';

/**
 * The image-based-light a scene gets when it has NO skybox to reflect.
 *
 * It used to be a 4x2 flat mid-grey. That is a fine *diffuse* ambient — it is
 * what keeps a PBR surface from going black — but a flat environment has no
 * structure for a specular surface to reflect, so a metal, gold or chrome voxel
 * slot (`engine/VoxelMaterialClass.ts`) rendered as a slightly darker flat tint
 * of its own colour and was indistinguishable from matte. Most games never set
 * a skybox, so the shiny tiers were effectively disabled where they were used.
 *
 * This is a small equirect gradient instead: a sky dome, a brighter horizon
 * band and a darker neutral ground. That gives every reflective surface a
 * horizon line to catch, which is what makes it read as metal at all, while
 * the row-weighted mean stays close to the old grey so the diffuse IBL every
 * Standard/Physical material in the scene already receives does not shift.
 *
 * Linear RGB — the DataTexture is fed to PMREM with no colour space, exactly
 * as the flat grey was.
 *
 * SIZE MATTERS, and it is the reason the old grey did not even work as a
 * diffuse ambient under the node renderer: PMREM derives its cube size from
 * `image.width / 4`, so a 4x2 source became a 1-texel cube whose
 * `maxMip = log2(4 * cubeSize) - 2` is 0, and `textureCubeUV` sampled nothing —
 * a mid-grey metalness-1 sphere rendered pitch black under it (measured
 * headless, WebGPURenderer on its WebGL2 backend). 256 wide gives a 64 cube and
 * six mips, the same shape a small real skybox produces. The texture is built
 * once per scene and is 128 KB; the PMREM it becomes is what a skybox costs.
 */

/** Row-weighted mean luminance of the old flat fallback (90/92/102 sRGB-ish bytes read as linear). */
const LEGACY_MEAN = 0.36;

/** Zenith colour when the scene background gives no hue: the old grey's blue tint, a touch brighter. */
const DEFAULT_SKY = new THREE.Color(0.30, 0.34, 0.46);
const HORIZON = new THREE.Color(0.62, 0.63, 0.66);
const GROUND = new THREE.Color(0.18, 0.18, 0.17);

/** PMREM cube size is `width / 4`; below 32 the cube-UV mips collapse and the IBL goes black. */
export const NEUTRAL_ENV_WIDTH = 256;
export const NEUTRAL_ENV_HEIGHT = 128;

export interface NeutralEnvironmentGradient {
    /** RGBA, `width * height * 4`, top row first. RGBA because WebGPU rejects RGB-only formats. */
    data: Uint8Array;
    width: number;
    height: number;
}

/**
 * Sky hue from the scene background when it is a colour. Luminance is
 * normalised so a very bright or very dark background does not blow the
 * ambient out or kill it: only the HUE of the background is borrowed.
 */
function skyFromBackground(background: THREE.Color | null): THREE.Color {
    if (!background) return DEFAULT_SKY.clone();
    const lum = luminance(background);
    if (lum <= 1e-4) return DEFAULT_SKY.clone();
    const target = luminance(DEFAULT_SKY);
    return background.clone().multiplyScalar(target / lum);
}

function luminance(c: THREE.Color): number {
    return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

/** Colour of an equirect row: `t` = 0 at the zenith, 0.5 at the horizon, 1 at the nadir. */
export function gradientRowColor(t: number, sky: THREE.Color): THREE.Color {
    if (t <= 0.5) {
        // Sky: ease toward the horizon band so the top stays the sky colour.
        const k = Math.pow(t / 0.5, 1.8);
        return sky.clone().lerp(HORIZON, k);
    }
    // Ground: drop off the horizon fast; the ground itself is flat.
    const k = Math.min(1, ((t - 0.5) / 0.5) * 3);
    return HORIZON.clone().lerp(GROUND, k);
}

/**
 * Build the gradient. `background` is `scene.background` when that is a
 * colour, null otherwise (a texture background is an environment already and
 * never reaches the fallback).
 */
export function neutralEnvironmentGradient(
    background: THREE.Color | null,
    width: number = NEUTRAL_ENV_WIDTH,
    height: number = NEUTRAL_ENV_HEIGHT,
): NeutralEnvironmentGradient {
    const sky = skyFromBackground(background);

    // Rows first, so the mean can be measured and the whole image scaled to
    // the legacy brightness before quantising.
    const rows: THREE.Color[] = [];
    let weighted = 0;
    let weightSum = 0;
    for (let y = 0; y < height; y++) {
        const t = (y + 0.5) / height;
        const row = gradientRowColor(t, sky);
        rows.push(row);
        // Equirect rows cover sin(polar) of the sphere's area.
        const w = Math.sin(t * Math.PI);
        weighted += luminance(row) * w;
        weightSum += w;
    }
    const scale = LEGACY_MEAN / (weighted / weightSum);

    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        const row = rows[y]!;
        const r = toByte(row.r * scale);
        const g = toByte(row.g * scale);
        const b = toByte(row.b * scale);
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            data[i] = r;
            data[i + 1] = g;
            data[i + 2] = b;
            data[i + 3] = 255;
        }
    }
    return { data, width, height };
}

function toByte(v: number): number {
    return Math.max(0, Math.min(255, Math.round(v * 255)));
}
