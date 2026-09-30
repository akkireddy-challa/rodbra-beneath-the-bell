/**
 * Bake-time authored-color emissive matcher — shared core for both bake paths
 * that accept a forger-authored `emissiveByColor` option (keys `#RRGGBB`,
 * values 1..255 strength): the LEVEL path's v7 `.vwld` emissive palette
 * (`VxlSceneFormat.ts` / `VxlWorldVoxelizer.ts`) and the ASSET path's v6
 * `.vxl` per-color emissive block (`VxlV3Format.ts`, applied via
 * `VxlEmissiveTransforms.ts`'s existing encode/decode primitives).
 *
 * Matching is EXACT RGB444 cell equality, no tolerance: each authored hex is
 * quantized through `rgb888ToAtlasCell` — the SAME 12-bit atlas-cell
 * quantization every bake path already applies to its own voxel/quad colors
 * (see `atlasColor.ts`, "the ONE place the 12-bit color model lives") — and
 * compared verbatim against each palette entry's stored cell. The forger
 * authors palette colors directly, so a color survives quantization
 * deterministically, so no channel tolerance is needed.
 */

import { rgb888ToAtlasCell } from 'engine/vxlscene/atlasColor.js';

export interface EmissiveByColorResult {
    /** Strength (0..255) per palette entry, parallel to the input `paletteCells`. 0 = no emissive. */
    emissive: Uint8Array;
    /**
     * `emissiveByColor` keys that never matched a palette cell — a bake note, not an
     * error (surfaced as `emissiveUnmatched` in both bake-message result payloads).
     * Includes malformed (non-`#RRGGBB`) keys.
     */
    unmatched: string[];
}

/** Parse `#RRGGBB` (leading `#` optional) into 0..255 channels, or null if malformed. */
function parseHexColor(hex: string): { r: number; g: number; b: number } | null {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
    if (!m) return null;
    const v = parseInt(m[1]!, 16);
    return { r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff };
}

/** Clamp a strength value to the 0..255 byte range, rounding fractional input. */
function clampStrength(v: number): number {
    return Math.max(0, Math.min(255, Math.round(v)));
}

/**
 * Resolve a forger-authored `emissiveByColor` map against a palette's RGB444
 * atlas cells. `paletteCells[i]` is the cell of palette entry i (e.g. the
 * `colors` array `collectVxlPalette` returns for a decoded `.vxl`, or the
 * distinct cells observed during a `.vwld` level bake). Every entry whose
 * cell equals a quantized authored key gets that key's (clamped, rounded)
 * strength — multiple palette entries sharing one cell (many-to-one) all get
 * set, since RGB444 only has 4096 distinct values and a palette can quantize
 * several source colors onto the same cell.
 *
 * Pure and side-effect-free: no I/O, no knowledge of either bake path's file
 * format, so it is unit-tested directly and reused by both.
 */
export function applyEmissiveByColor(
    paletteCells: ArrayLike<number>,
    emissiveByColor: Record<string, number>,
): EmissiveByColorResult {
    const emissive = new Uint8Array(paletteCells.length);
    const unmatched: string[] = [];
    for (const [hex, rawStrength] of Object.entries(emissiveByColor)) {
        const parsed = parseHexColor(hex);
        const strength = clampStrength(rawStrength);
        let matched = false;
        if (parsed) {
            const cell = rgb888ToAtlasCell(parsed.r, parsed.g, parsed.b);
            for (let i = 0; i < paletteCells.length; i++) {
                if (paletteCells[i] === cell) {
                    emissive[i] = strength;
                    matched = true;
                }
            }
        }
        if (!matched) unmatched.push(hex);
    }
    return { emissive, unmatched };
}
