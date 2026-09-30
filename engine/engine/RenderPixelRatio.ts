/**
 * The renderer's pixel ratio, capped to what the quality tier allows.
 *
 * `setPixelRatio(window.devicePixelRatio)` is the obvious line to write and the wrong
 * one on a phone. A modern iPhone reports 3, so the drawing buffer is NINE times the
 * CSS pixel count — and every render target scales with it: the post chain's HDR scene
 * pass and its MRT attachments, the bloom mip chain, the depth buffer. A 852x393 CSS
 * viewport is 3.0M device pixels at ratio 3 against 1.3M at ratio 2, and those targets
 * are allocated on the FIRST rendered frame, which is the GPU warmup — the exact point
 * a level load was dying on iOS. Ratio 2 is already past the density where the
 * difference is visible at arm's length on a phone, so the cap costs nothing a player
 * can see and takes ~55% off every target.
 *
 * The cap now comes from `DeviceQualityPolicy.live.maxPixelRatio` rather than a mobile
 * boolean, which is what lets the bottom rung go BELOW 1. That used to be forbidden here
 * ("a sub-1 ratio renders blurrier than the display and saves nothing worth having"), and
 * for a phone that is merely dense that is still true — which is why no rung between
 * `ultra` and `minimal` goes there. But for a device that cannot hold the frame rate at
 * all, resolution is the one lever that converts reliably and instantly into frame time,
 * and a blurry game that runs beats a sharp one that does not.
 *
 * ⚠ The cap is in CSS-PIXEL terms, not a fraction of the device ratio. `0.75` means 0.75
 * device pixels per CSS pixel on every display, so on a dpr-3 phone it is one SIXTEENTH of
 * the pixels of ratio 3, not 75% of them. (The old Unity build used a multiplier clamped
 * to [0.275, 0.9]; a cap composes with the arithmetic above and, unlike a multiplier, costs
 * the same on every device — which is what a rescue rung should do.)
 *
 * `?dpr=<number>` overrides the tier, so a rung can be A/B'd on a device without a
 * republish — `?dpr=3` restores the pre-cap behaviour exactly.
 */

/**
 * Ratio ceiling on mobile, regardless of rung. Not a quality setting to tune per game —
 * raising it multiplies every render target's memory by its square. Applied as a device
 * floor in `clampPolicyToDevice`, so a player pinning the top rung on a phone still gets it.
 */
export const MOBILE_MAX_PIXEL_RATIO = 2;

/**
 * Hard ceiling on any resolved ratio, `?dpr=` included. A stray `?dpr=100` would allocate
 * targets that take the tab out, which is not a failure mode a URL param should be able to
 * cause, and no shipping display reports above 4 anyway.
 */
export const MAX_RENDER_PIXEL_RATIO = 4;

/**
 * Absolute floor. Below this the drawing buffer stops being a picture rather than getting
 * usefully cheaper: the ink outline and GTAO passes alias into noise, and anything drawn
 * INTO the canvas rather than as a DOM overlay stops being readable. 0.5 on a dpr-3 phone
 * is already a 36x pixel reduction, so there is nothing below it worth having.
 */
export const MIN_RENDER_PIXEL_RATIO = 0.5;

/**
 * The pixel ratio to hand `renderer.setPixelRatio`.
 *
 * `deviceRatio` is normally `window.devicePixelRatio`; it is a parameter so the policy is
 * testable without a DOM. Values below 1 (some emulated viewports report 0) are normalised
 * to 1 BEFORE the cap applies — an unknown display is a normal display, not a licence to
 * render at a quarter resolution — so a sub-1 result can only ever come from a rung that
 * asked for one, or from an explicit `?dpr=`.
 */
export function resolveRenderPixelRatio(deviceRatio: number, maxPixelRatio: number): number {
    const override = readPixelRatioOverride();
    const device = Number.isFinite(deviceRatio) && deviceRatio > 0 ? deviceRatio : 1;
    const ratio = override ?? Math.min(device, maxPixelRatio);
    return Math.min(MAX_RENDER_PIXEL_RATIO, Math.max(MIN_RENDER_PIXEL_RATIO, ratio));
}

/** `?dpr=` as a number, or null when absent/unparseable. */
function readPixelRatioOverride(): number | null {
    try {
        const raw = new URLSearchParams(window.location.search).get('dpr');
        if (raw === null) return null;
        const n = Number.parseFloat(raw);
        // Accepted down to the floor rather than down to 1: `?dpr=0.5` used to parse and
        // then be silently discarded by a `>= 1` clamp, so the flag quietly did nothing on
        // exactly the values someone testing a low rung would reach for.
        return Number.isFinite(n) && n >= MIN_RENDER_PIXEL_RATIO ? n : null;
    } catch {
        // No window/location (tests, workers).
        return null;
    }
}
