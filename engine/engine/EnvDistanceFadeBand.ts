/**
 * Pure fade-band math for `EnvDistanceFade` — kept free of `three/webgpu` /
 * `three/tsl` imports so it can be unit-tested under ts-jest (those are ESM-only
 * and fail to load in the test sandbox).
 */

export interface EnvFadeBand {
    /** Radial camera distance (m) where the dissolve begins (fully opaque nearer). */
    start: number;
    /** Radial camera distance (m) where the object is fully dithered away. */
    end: number;
}

/** Fraction of the render distance spent dissolving, clamped to a sane metre range. */
const FADE_WIDTH_FRACTION = 0.2;
const FADE_WIDTH_MIN_M = 40;
const FADE_WIDTH_MAX_M = 120;
/** End the dissolve this many metres before the hard cull so there is always a
 *  fully-transparent margin — fading and culling at the exact same distance can
 *  still flicker at the boundary. */
const FADE_END_MARGIN_M = 3;

/** Band pushed to infinity → smoothstep 0 → opacity 1 everywhere (fade disabled). */
export const DISABLED_FADE_BAND: EnvFadeBand = { start: 1e9, end: 1e9 + 1 };

/**
 * Derive the fade band from the env-object render (cull) distance. `end` sits just
 * inside the cull; `start` is one fade-width nearer, never past the halfway point of
 * the render distance (so mid-scene objects stay solid). A non-positive/NaN render
 * distance disables the fade.
 */
export function computeEnvFadeBand(maxRenderDistance: number): EnvFadeBand {
    if (!(maxRenderDistance > 0) || !isFinite(maxRenderDistance)) return { ...DISABLED_FADE_BAND };
    const width = Math.min(FADE_WIDTH_MAX_M, Math.max(FADE_WIDTH_MIN_M, maxRenderDistance * FADE_WIDTH_FRACTION));
    const end = maxRenderDistance - FADE_END_MARGIN_M;
    const start = Math.max(maxRenderDistance * 0.5, end - width);
    return { start, end };
}
