/**
 * RGB444 atlas-cell color helpers — the ONE place the 12-bit color model lives.
 *
 * The voxel texture atlas renders 4-bit-per-channel color: a 64×64 = 4096-cell region
 * where cell (r4,g4,b4) is painted (r4·17, g4·17, b4·17). Every voxel/quad color the
 * engine can show is therefore one of 4096 RGB444 cells. So the `.vwld` stores that
 * 12-bit cell DIRECTLY (2 bytes, no per-world palette) — a palette would only ever map
 * back into these 4096 cells anyway.
 *
 * Pure leaf module (no atlas import): shared by the bake encoder, the format decoder
 * (v1 → cell back-compat), and the renderer. `quantize4` MUST stay equal to
 * `VoxelTextureAtlas.quantize4` (round(v/17)); `getColorPaletteUV` re-derives the same
 * bucket from `atlasCellRepr`, so the renderer maps a cell → UV with no sRGB step
 * (the sRGB pre-encode is baked into the stored cell here, at encode time).
 */

/** Number of distinct RGB444 cells (the atlas color region: 16³ = 4096). */
export const ATLAS_CELL_COUNT = 4096;

/**
 * Linear→sRGB encode of an 8-bit channel (the standard sRGB OETF). The atlas texture
 * is sRGB, so the GPU sRGB→linear DECODES (≈2× darkens) every texel before lighting;
 * pre-encoding here keeps a stored cell at the brightness the atlas should display.
 */
export function srgbEncode8(v: number): number {
    const c = v / 255;
    const e = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(e * 255)));
}

/** 8-bit channel → 4-bit atlas bucket. MUST match VoxelTextureAtlas.quantize4. */
function quantize4(v: number): number {
    return Math.round(v / 17);
}

/**
 * Full-range (0..255) RGB → 12-bit RGB444 atlas cell `(r4<<8)|(g4<<4)|b4`, with the
 * sRGB pre-encode baked in so the cell is EXACTLY the atlas cell the renderer shows.
 */
export function rgb888ToAtlasCell(r: number, g: number, b: number): number {
    return (quantize4(srgbEncode8(r)) << 8) | (quantize4(srgbEncode8(g)) << 4) | quantize4(srgbEncode8(b));
}

/**
 * Atlas cell → a representative 0..255 RGB (`r4·17`) whose `quantize4` lands back on the
 * same cell — feed this to `VoxelTextureAtlas.getColorPaletteUV` to get the cell's UV.
 * No sRGB here: the cell already encodes it.
 */
export function atlasCellRepr(cell: number): { r: number; g: number; b: number } {
    return { r: ((cell >> 8) & 0xf) * 17, g: ((cell >> 4) & 0xf) * 17, b: (cell & 0xf) * 17 };
}

/** sRGB→linear decode of an 8-bit channel to 0..1 — the exact inverse of `srgbEncode8`. */
function srgbDecode8(v: number): number {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Atlas cell → LINEAR 0..1 RGB, undoing the sRGB OETF that `rgb888ToAtlasCell` baked in.
 *
 * For consumers that hand leaf colors BACK to the encoder (the editor re-encode path):
 * the encoder treats leaf floats as linear and encodes again, so returning the raw
 * `v4/15` fractions would apply the OETF twice and brighten every mid-tone on save.
 * Round-trips with `rgb888ToAtlasCell` up to RGB444 quantisation.
 */
export function atlasCellToLinearRgb(cell: number): { r: number; g: number; b: number } {
    const { r, g, b } = atlasCellRepr(cell);
    return { r: srgbDecode8(r), g: srgbDecode8(g), b: srgbDecode8(b) };
}
