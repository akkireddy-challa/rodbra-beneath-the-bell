/**
 * Pure `.vxl` per-color emissive transforms.
 *
 * These used to back the creator's per-color emissive dialog (DECODE_VXL_PALETTE
 * / ENCODE_VXL_EMISSIVE). That dialog is gone — glow is now set per voxel
 * selection in the 3D voxel editor (game/src/editor/voxel-edit/) — but the
 * transforms below outlived it: the vehicle emissive bake and the GLB
 * voxelizer's `emissiveByColor` option both drive palette emissive through
 * them, and they remain the single definition of the palette ORDER CONTRACT.
 */
import {
    decodeVxlV3, encodeVxlV3,
    type DecodedFragment, type DecodedVxlV3, type VxlV3Data, type VxlV3Fragment,
} from 'engine/VxlV3Format.js';
import { decodedToEncodable } from 'engine/VoxelExplosionHelpers.js';
import { unpackRgb444, type OctreeLeaf } from 'engine/VoxelOctreeRenderer.js';
import { atlasCellToLinearRgb } from 'engine/vxlscene/atlasColor.js';

/**
 * Derive a decoded .vxl's LOD0 palette: the unique RGB444 color cells in
 * first-occurrence order over the LOD0 fragments/leaves, plus each color's
 * current emissive (0 when the asset has none).
 *
 * ORDER CONTRACT: first-wins over `dec.fragments[].leaves` in file order is
 * EXACTLY how `encodeVxlV3`'s `buildPalette` assigns palette indices, so this
 * reproduces the stored palette order — and a re-encode of the same leaves
 * produces it again. The emissive array the creator edits is indexed by this
 * order; both handlers MUST derive it through this one function.
 */
export function collectVxlPalette(dec: DecodedVxlV3): { colors: number[]; emissive: number[] } {
    const seen = new Set<number>();
    const colors: number[] = [];
    const emissive: number[] = [];
    for (const fragment of dec.fragments) {
        const buf = fragment.leaves;
        for (let i = 0; i < buf.count; i++) {
            const cell = buf.color[i]!;
            if (!seen.has(cell)) {
                seen.add(cell);
                colors.push(cell);
                emissive.push(buf.emiss ? buf.emiss[i]! : 0);
            }
        }
    }
    return { colors, emissive };
}

/**
 * A stored RGB444 cell → r/g/b floats that `encodeVxlV3` quantizes back to the
 * IDENTICAL cell, so a decode → re-encode round trip is color-lossless.
 *
 * - useAtlas=false: plain `unpackRgb444` — `packRgb444(round(v4/15·15))` is
 *   exact for all 4096 cells.
 * - useAtlas=true: the stored cell is sRGB-ENCODED (`rgb888ToAtlasCell` bakes
 *   the OETF in at encode time) but the encoder treats leaf floats as LINEAR
 *   and applies the OETF again — feeding the `unpackRgb444` floats straight
 *   back would double-encode and brighten every mid-tone (channel 7 → 11).
 *   Return the linear preimage of each channel's 8-bit representative (v4·17)
 *   instead: `quantize4(srgbEncode8(round(preimage·255)))` lands back on v4
 *   for all 16 channel values (buckets are 17 wide, the representative sits
 *   at bucket center).
 */
function cellToEncodableRgb(cell: number, useAtlas: boolean): { r: number; g: number; b: number } {
    if (!useAtlas) return unpackRgb444(cell);
    return atlasCellToLinearRgb(cell);
}

/**
 * Decode-form fragment → encode-form fragment (mirrors VoxelObject's
 * `decodedToEncodable`), with two deltas: colors go through the
 * cell-preserving `cellToEncodableRgb` (see above), and LOD0 leaves get their
 * emissive overridden per palette color. Pass `emissiveByCell: null` for
 * coarser LODs — emissive is LOD0-only per the v6 format.
 */
function fragmentToEncodable(
    f: DecodedFragment,
    useAtlas: boolean,
    emissiveByCell: Map<number, number> | null,
): VxlV3Fragment {
    const buf = f.leaves;
    const leaves = new Array<OctreeLeaf>(buf.count);
    for (let i = 0; i < buf.count; i++) {
        const cell = buf.color[i]!;
        const { r, g, b } = cellToEncodableRgb(cell, useAtlas);
        leaves[i] = {
            x: buf.worldX(i), y: buf.worldY(i), z: buf.worldZ(i), size: buf.worldSize(i),
            r, g, b,
            emissive: emissiveByCell ? emissiveByCell.get(cell) ?? 0 : 0,
        };
    }
    return { aabbMin: f.aabbMin, aabbMax: f.aabbMax, leaves };
}

function toExactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) {
        return bytes.buffer;
    }
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * The pure transform behind ENCODE_VXL_EMISSIVE (exported for tests): decode a
 * .vxl, override the per-palette-color emissive, re-encode. Geometry (header
 * params, bounds, fragment AABBs, leaf order/positions/sizes/colors, LOD
 * structure) is preserved exactly — only emissive changes. `emissive` values
 * (0..255) are parallel to `collectVxlPalette(...).colors`, i.e. the array
 * DECODE_VXL_PALETTE returned for this same file. An all-zero array
 * re-encodes as v5 (the encoder omits the emissive block entirely).
 */
export async function applyEmissiveToVxlBytes(vxlBytes: Uint8Array, emissive: number[]): Promise<Uint8Array> {
    const dec = await decodeVxlV3(toExactArrayBuffer(vxlBytes));
    const { colors } = collectVxlPalette(dec);
    if (emissive.length !== colors.length) {
        throw new Error(`Emissive array length ${emissive.length} does not match palette size ${colors.length}`);
    }
    const emissiveByCell = new Map<number, number>();
    for (let i = 0; i < colors.length; i++) {
        emissiveByCell.set(colors[i]!, Math.max(0, Math.min(255, Math.round(emissive[i]!))));
    }
    // `decodedToEncodable` first, so everything the file carried beyond geometry —
    // the slot table, a rig, a smart object's parts table — survives; only the
    // fragments are rebuilt, with the new emissive. Assembling the object by hand
    // here used to drop all three, which turned a placeholder windmill static the
    // moment the dungeon dresser set its emissive by colour.
    const rebuilt: VxlV3Data = {
        ...decodedToEncodable(dec),
        fragments: dec.fragments.map((f) => fragmentToEncodable(f, dec.useAtlas, emissiveByCell)),
        ...(dec.additionalLods ? {
            additionalLods: dec.additionalLods.map((l) => ({
                minVoxelSize: l.minVoxelSize,
                maxVoxelSize: l.maxVoxelSize,
                fragments: l.fragments.map((f) => fragmentToEncodable(f, dec.useAtlas, null)),
            })),
        } : {}),
    };
    return encodeVxlV3(rebuilt);
}
