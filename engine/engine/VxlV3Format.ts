/**
 * VXL v3 / v4 / v5 — packed binary voxel-object format.
 *
 * Replaces v2 JSON octree (~50 bytes/leaf) with a tight binary layout
 * (8 bytes/leaf) and adds a first-class concept of pre-built fragments,
 * so high-density objects can be exploded by detaching whole fragments
 * as rigid bodies instead of recomputing per-voxel debris at runtime.
 *
 * Version 4 (additive) adds optional coarser LOD levels at the end of
 * the body. The primary fragments + palette stay at LOD 0; the trailer
 * holds additional LODs. v3 decoders silently ignore the trailer, so
 * old runtimes loading new files render at LOD 0.
 *
 * Version 5 (current encoder output) keeps the same header / palette /
 * fragment-header structure but stores each fragment's leaves COLUMNAR
 * with delta-coded gx/gy/gz (see `VXL3_VERSION_COLUMNAR`): per fragment,
 * gx[] (Δ), gy[] (Δ), gz[] (Δ), lod[], paletteIdx[] instead of interleaved
 * 8/9-byte records. The octree leaf order is spatially coherent, so the
 * deltas are tiny and the gzipped body is ~50-60% smaller on real assets.
 * `additionalLodCount` is ALWAYS written (0 = no coarser LODs). v3/v4 stay
 * readable, so existing assets keep loading; re-bake/re-save to shrink.
 *
 * Version 6 (additive) adds an optional per-color EMISSIVE palette — one byte
 * per LOD0 color (parallel to the LOD0 color palette), appended AFTER the LOD
 * trailer (see `VXL3_VERSION_EMISSIVE`). It is written ONLY when at least one
 * color is emissive; a non-emissive asset stays byte-for-byte v5. Header byte
 * 46 (formerly reserved) is the `hasEmissive` flag (1 = present). v3/v4/v5
 * readers stop at the trailer and ignore the block, so old runtimes render the
 * asset unlit.
 *
 * Version 7 (additive) turns the palette into a MATERIAL TABLE: each entry is
 * now (colorCell, slot) rather than a bare color, so two voxels of the same
 * color can belong to different materials (a steady red taillight and a
 * flashing red beacon on one ambulance). Header byte 47 (formerly reserved)
 * holds the NAMED slot count; slot 0 is the implicit base material and is
 * never listed. The slot section is appended AFTER the emissive block:
 *
 *   per named slot (slotCount entries, describing slot indices 1..slotCount):
 *     uint8   emissive 0..255 (the slot's default glow; runtime can change it)
 *     uint8   nameLength
 *     bytes   name (UTF-8, <= VOXEL_SLOT_NAME_MAX)
 *   then: paletteCount x uint8 — each LOD0 palette entry's slot index.
 *
 * Written ONLY when at least one voxel is in a named slot, so slot-free assets
 * stay byte-for-byte v5/v6. Emissive stays per palette ENTRY (not per color):
 * with slots, a color cell no longer identifies an entry uniquely, so the
 * decoder resolves both columns through the stored palette INDEX.
 * See engine/VoxelMaterialSlots.ts for what a slot is and why.
 *
 * From v7 on, "palette" is a WIRE NAME, kept because the field is still a list
 * indexed by a per-leaf index. It is NOT a colour table, and glow is not a
 * function of colour: an entry is a MATERIAL, so the identical colour in two
 * slots is two entries and emissive is stored per ENTRY. The one case where
 * colour still decides glow is a slot-0 leaf carrying legacy per-voxel emissive
 * — emissive is not part of the key, so two same-coloured slot-0 leaves with
 * different emissive values merge, first wins. Expressing glow as a MATERIAL is
 * exactly what avoids that, which is why the voxel editor assigns slots rather
 * than per-voxel values. Baked LEVEL geometry (.vwld) is a separate story: it
 * has no material concept at all and matches emissive by authored colour, see
 * engine/vxlscene/emissiveByColor.ts.
 *
 * Version 8 (additive) carries the SLOT column at EVERY LOD, and drops the legacy
 * emissive block entirely. Through v7 both sections were sized to the LOD 0 palette
 * alone, so a coarser level had no way to say a cell glows: a street lamp went dark at
 * the first LOD switch, and a slotted asset stopped being runtime-controllable at
 * exactly the distance where its lights are the only part of it still worth drawing.
 * The slot section now appends, after its LOD 0 array and in LOD order, one array per
 * coarser LOD sized to THAT LOD's own material table:
 *
 *   slot section:    slot table, then
 *                    paletteCount x uint8            (LOD 0)
 *                    lodPaletteCount[i] x uint8      (each coarser LOD, v8)
 *
 * v8 has NO emissive array. Glow is a MATERIAL property, read from the slot table, so
 * an asset that still relies on v6's colour-keyed per-leaf emissive is not
 * representable — and the encoder keeps such an asset at v7 rather than dropping the
 * user's glow to earn a version number. Everything before the per-LOD arrays is
 * byte-identical to v7, and the version is raised only when a coarser LOD actually
 * carries a material — an asset whose slots coarsen away stays v7.
 *
 * Coarsening decides a cell's material by PRESENCE, not by volume (see
 * `coarsenLeaves`): a bulb is a few voxels inside a large dark fixture and loses every
 * majority vote, which is precisely how the lights went out.
 *
 * COST: one byte per material-table ENTRY per LOD — not per voxel — plus 2 bytes and
 * the name per named slot, all gzipped with the body. Measured on real assets, putting
 * 10% of the voxels in a material costs about 0.13 bits per voxel (StreetLampPosts,
 * 3512 leaves + 2 LODs: 1024 -> 1083 B). An asset with no materials writes NOTHING:
 * both header flags stay 0 and it stays byte-identical v5. The one cliff is
 * `paletteIdxBytes`, which is 2 above 256 entries — since a colour in two materials is
 * two entries, materials can push a large palette over that line and widen the per-leaf
 * index column by a byte.
 *
 * Layout
 * ──────
 * Outer wrapper (5 B, ALWAYS plaintext so format-sniffing is cheap):
 *   off  size  field
 *   0    4     magic "VXL3" (0x56 0x58 0x4C 0x33)
 *   4    1     compressionId uint8 (0=raw, 1=gzip)
 *
 * Body — starts at offset 5. Gzipped when compressionId=1, raw when 0.
 * After decompression, the body has this layout:
 *
 * Body header (48 B):
 *   off  size  field
 *   0    4     version uint32 LE (3 = no LOD trailer, 4 = LOD trailer, 5 = columnar,
 *               6 = + emissive, 7 = + material slots, 8 = + per-LOD emissive/slot,
 *               9 = + block types, 10 = + rig, 11 = + declared sections: material
 *               classes and/or eye metadata)
 *   4    4     minVoxelSize float32         (LOD 0)
 *   8    4     maxVoxelSize float32         (LOD 0)
 *   12   4     physicsGridStep float32
 *   16   24    bounds: 6 × float32  (minX,minY,minZ, maxX,maxY,maxZ)
 *   40   1     useAtlas uint8 (0/1)
 *   41   1     paletteIdxBytes uint8 (1 or 2)               — LOD 0 palette
 *   42   2     paletteCount uint16 LE                       — LOD 0 palette
 *   44   2     fragmentCount uint16 LE                      — LOD 0 fragments
 *   46   1     v6-v10: hasEmissive uint8 (1 = legacy emissive block present, and only
 *               read for v6/v7/v8 — v8 dropped that block).
 *               v11+: SECTION BITFIELD — bit 0 legacy emissive (never set), bit 1 rig
 *               present, bit 2 material-class section present, bit 3 eye section
 *               present (a fixed 19-byte record appended LAST; engine/VxlV3Eyes.ts).
 *   47   1     slotCount uint8 (v7+: named material slots; 0 = base material only)
 *   48   palette: paletteCount × uint16 LE                  — LOD 0
 *               (v5: 12-bit RGB444 cell 0x0RGB; v3/v4: RGB565)
 *
 * Per fragment:
 *   off  size  field
 *   0    4     leafCount uint32 LE
 *   4    12   aabb (grid coords, relative to bounds.min):
 *               6 × uint16 LE = minGX, minGY, minGZ, maxGX, maxGY, maxGZ
 *               aabb max is EXCLUSIVE (one past the last cell)
 *   16   leafCount × leafBytes  (leaves)
 *
 * Per leaf (8 B when paletteIdxBytes=1, 9 B when =2):
 *   off  size  field
 *   0    2    gx uint16 LE (grid coord from bounds.min, in minVoxelSize units)
 *   2    2    gy uint16 LE
 *   4    2    gz uint16 LE
 *   6    1    lod uint8 (leaf.size = minVoxelSize × 2^lod)
 *   7    1|2  paletteIdx uint8 or uint16 (palette mode)
 *
 * Grid coords are voxel-grid integers. World-space position is
 *   worldX = bounds.minX + gx * minVoxelSize
 * Same for Y, Z. The leaf occupies a cube starting at that corner,
 * with edge length `minVoxelSize * 2^lod`.
 *
 * V4 LOD trailer (present iff version == 4, appended right after LOD 0
 * fragments inside the same gzipped body):
 *   off  size  field
 *   0    2     additionalLodCount uint16 LE
 *   2    ...   per additional LOD:
 *               float32  minVoxelSize
 *               float32  maxVoxelSize
 *               uint8    paletteIdxBytes (1 or 2)
 *               uint16   paletteCount
 *               uint16   fragmentCount
 *               palette: paletteCount × uint16 LE (v5 RGB444 cell / v3-4 RGB565)
 *               fragments: same encoding as LOD 0, each fragment's grid
 *                          coords are quantized in THIS LOD's minVoxelSize
 *                          (so a coarse LOD packs into fewer cells).
 *
 * Bounds, useAtlas, and physicsGridStep are SHARED across all LODs (one
 * source GLB, one pivot). Each LOD has its own palette because coarser
 * sampling can yield different averaged colors.
 *
 * Version 11 (additive) gives each named slot a MATERIAL CLASS — what it is made
 * of (`metal`, `wood`, `gem`), which decides whether it shades as plain Lambert,
 * gains a direct specular highlight, or reflects `scene.environment`. Appended
 * after the v10 rig section; see engine/VxlV3MaterialClass.ts for the layout.
 *
 * v11 is also where the format stops inferring its optional sections from the
 * version number. v9 and v10 could, because "a v10 file always carries every
 * section a v9 file would" held — but it cannot hold here: the section a v11 file
 * would then have to always carry is the RIG, and a rig costs one byte per leaf
 * per LOD and cannot be written empty, which would leave a non-rigged gold statue
 * with no representable version at all. So header byte 46, dead since v8 dropped
 * the legacy emissive block, becomes a SECTION BITFIELD for v11 and later. Old
 * readers reject v11 by version before reaching that byte, so its two meanings
 * can never be confused. A v11 file still always carries the block-type and
 * per-LOD material arrays, because those sit before the flagged sections.
 *
 * Version 12 (additive) declares SMART-OBJECT PARTS — a windmill's blades, a
 * ferris wheel's cabins — as names, hierarchy and motion over the v10 rig's
 * per-leaf joint column, which already carries "which voxel belongs to which
 * part" through every LOD and every editor path. Appended after the v11 eye
 * section, announced by bit 4 of the same section bitfield; see
 * engine/VxlV3Parts.ts for the layout and the reasoning.
 */

import type { OctreeLeaf } from 'engine/VoxelOctreeRenderer.js';
import { LeafBuffer, packRgb444 } from 'engine/VoxelOctreeRenderer.js';
import { rgb888ToAtlasCell } from 'engine/vxlscene/atlasColor.js';
import { gzip, gunzip } from 'engine/gzip.js';
import { MAX_VOXEL_SLOTS, VOXEL_SLOT_NAME_MAX, type VoxelSlot } from 'engine/VoxelMaterialSlots.js';
import {
    readRigSection, rigSectionBytes, writeRigSection,
    type VxlV3Rig,
} from 'engine/VxlV3Rig.js';
import {
    applyMaterialClassNames, materialClassNames, materialClassSectionBytes,
    readMaterialClassSection, writeMaterialClassSection,
    VXL3_SECTION_LEGACY_EMISSIVE, VXL3_SECTION_MATERIAL_CLASS, VXL3_SECTION_RIG,
} from 'engine/VxlV3MaterialClass.js';
import {
    readEyeSection, writeEyeSection,
    EYE_SECTION_BYTES, VXL3_SECTION_EYES, type EyeMeta,
} from 'engine/VxlV3Eyes.js';
import {
    PARTS_SKELETON_REF, VXL3_SECTION_PARTS,
    partsSectionBytes, readPartsSection, validateParts, writePartsSection,
    type VxlV3Part,
} from 'engine/VxlV3Parts.js';

/**
 * A leaf color → its 12-bit RGB444 cell. Two color spaces, picked by `useAtlas` (the
 * object's render path):
 *  - useAtlas (atlas-rendered objects): the sRGB-encoded cell `rgb888ToAtlasCell` — the
 *    EXACT cell vwld stores, since the atlas is an sRGB texture, so the object renders
 *    identically to terrain.
 *  - vertex-color objects: the linear `packRgb444` cell, used directly as a linear
 *    vertex color.
 * Both produce the same `(r4<<8)|(g4<<4)|b4` bit layout; only the quantization space
 * differs. The decoder stores the cell verbatim in `buf.color`; the renderer interprets
 * it per the header's `useAtlas`.
 */
export function colorToCell(r: number, g: number, b: number, useAtlas: boolean): number {
    if (useAtlas) {
        const c8 = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));
        return rgb888ToAtlasCell(c8(r), c8(g), c8(b));
    }
    return packRgb444(r, g, b);
}

export const VXL3_MAGIC = 0x33_4c_58_56; // "VXL3" little-endian uint32

/** Version 3 layout: no LOD trailer. Written when `additionalLods` is empty/undefined. */
export const VXL3_VERSION = 3;

/** Version 4 layout: same body + LOD trailer. Written when at least one additional LOD is present. */
export const VXL3_VERSION_WITH_LODS = 4;

/**
 * Version 5 layout (current encoder output): byte-aligned COLUMNAR leaves with
 * delta-coded gx/gy/gz, instead of v3/v4's interleaved 8/9-byte leaf records.
 * Per fragment the leaves are stored as separate columns — gx[] (Δ), gy[] (Δ),
 * gz[] (Δ), lod[], paletteIdx[] — so the gzipped body shrinks ~50% (the octree
 * leaf order is spatially coherent, making the deltas tiny and the columns highly
 * compressible). The trailer's `additionalLodCount` is ALWAYS written (0 when there
 * are no coarser LODs), so a single version covers both cases. v3/v4 stay readable.
 */
export const VXL3_VERSION_COLUMNAR = 5;

/** Version 6: v5 columnar body + optional per-color emissive palette trailer. */
export const VXL3_VERSION_EMISSIVE = 6;

/** Version 7: v6 + a material-slot table, making the palette a (color, slot) material table. */
export const VXL3_VERSION_SLOTS = 7;

/**
 * Version 8: v7, with the emissive and slot columns carried at EVERY LOD instead
 * of LOD 0 alone.
 *
 * Through v7 both sections were sized to the LOD 0 palette, so a coarser LOD had
 * no way to say a cell glows — a street lamp went dark the moment the renderer
 * switched away from LOD 0, and a slotted asset stopped being controllable at
 * exactly the distance where its lights are the only thing still legible.
 *
 * The per-LOD arrays are appended AFTER the v7 ones, each sized to that LOD's own
 * palette (built with the same `(cell, slot)` keying), and read in LOD order.
 * Everything before them is byte-identical to v7, so the version is only raised
 * when there is per-LOD material data to write.
 */
export const VXL3_VERSION_LOD_MATERIALS = 8;

/**
 * Version 9: v8 + a per-palette-entry BLOCK TYPE column, at every LOD.
 *
 * Textured Minecraft-style blocks index the shared atlas per FACE, which colour alone
 * cannot express — so before this, a block-typed asset had no VXL3 representation at
 * all and had to be written in the old JSON form (hundreds of KB, no LOD trailer, a
 * slow parse). The column makes the palette a full `(colour, slot, blockType)` material
 * table.
 *
 * Carried at EVERY LOD from the outset, for the reason v8 exists: a textured block that
 * reverted to flat colour at the first LOD switch would be a worse artefact than the one
 * v8 fixed. Appended AFTER the v8 slot arrays, so everything before it is byte-identical
 * to v8 and the version is raised only when an asset actually uses block types.
 */
export const VXL3_VERSION_BLOCK_TYPES = 9;

/**
 * Version 10: v9 + an optional RIGGED CHARACTER section.
 *
 * A rigged character is an optional capability of a `.vxl`, not a second format — one
 * loader, one extension, and the file says for itself whether it carries a rig. The
 * section is appended AFTER the v9 block types, so everything before it is
 * byte-identical to the version the asset would otherwise have been, and the version is
 * raised only when an asset actually carries a rig.
 *
 * Unlike every section before it, the bone is a per-LEAF column rather than a per-palette
 * one. Slot and block type are MATERIAL properties, so they ride on the palette entry;
 * a bone is spatial. The same red appears on both arms and has to move with different
 * bones, so folding the bone into the palette key would multiply the table by the bone
 * count and push `paletteIdxBytes` to 2 on assets nowhere near the 256-entry cliff.
 *
 * Ownership is ONE bone per voxel with no weights — what the generator actually emits,
 * and what makes a voxel transform rigidly instead of shearing. See engine/VxlV3Rig.ts
 * for the layout and for why the bind positions are stored while the skeleton is only
 * referenced.
 */
export const VXL3_VERSION_RIG = 10;

/**
 * Version 11: v10 + a per-slot MATERIAL CLASS, and the first version whose optional
 * sections are DECLARED rather than inferred from the version number.
 *
 * A material slot has carried a name and a glow level since v7. This adds what it is
 * made of — `metal`, `wood`, `gem` — which is what lets a voxel sword's blade reflect
 * the sky while its leather grip does not. Stored as a NAME so the render parameters
 * stay tunable without re-baking any asset and an unknown name degrades to the default
 * instead of throwing.
 *
 * The version is raised only when a slot actually names a non-default class, so every
 * class-free asset — which is every asset written before this — stays byte-identical to
 * the version it would otherwise have been.
 *
 * Unlike v9 and v10, v11 cannot announce its sections by version alone: doing so would
 * require a v11 file to always carry the RIG section, which costs one byte per leaf per
 * LOD and cannot be written empty, leaving a non-rigged gold statue with no representable
 * version. So header byte 46 — dead since v8 dropped the legacy emissive block — becomes
 * a section bitfield. See engine/VxlV3MaterialClass.ts for the layout and the flags.
 */
export const VXL3_VERSION_MATERIAL_CLASS = 11;

/**
 * Version 12: the smart-object parts section (bit 4 of the section bitfield). A
 * distinct version rather than a new bit under v11 so that a v11 reader rejects
 * the file by version instead of decoding it and silently dropping the parts on
 * its next save — the same reason v11 is not "v10 with a flag".
 */
export const VXL3_VERSION_PARTS = 12;

/** Versions whose body carries the v5 LOD trailer (count may be 0). */
const VERSIONS_WITH_TRAILER: readonly number[] = [
    VXL3_VERSION_WITH_LODS, VXL3_VERSION_COLUMNAR, VXL3_VERSION_EMISSIVE,
    VXL3_VERSION_SLOTS, VXL3_VERSION_LOD_MATERIALS, VXL3_VERSION_BLOCK_TYPES,
    VXL3_VERSION_RIG, VXL3_VERSION_MATERIAL_CLASS, VXL3_VERSION_PARTS,
];

export const VXL3_COMPRESSION_NONE = 0;
export const VXL3_COMPRESSION_GZIP = 1;

/** Outer wrapper is 5 bytes; body header is 48 bytes. Smallest possible file: wrapper + raw 48B body. */
export const VXL3_MIN_FILE_SIZE = 5 + 48;
const BODY_HEADER_SIZE = 48;

export interface VxlV3Bounds {
    minX: number; minY: number; minZ: number;
    maxX: number; maxY: number; maxZ: number;
}

/**
 * One fragment in the file. `leaves` are in object-local world units (same
 * units as the source octree leaves) — the encoder takes care of converting
 * to grid coords on write, and the decoder converts back on read.
 */
export interface VxlV3Fragment {
    /** AABB in object-local world units — the SAME space as `leaves` (bounds-absolute; the
     *  encoder re-bases to bounds.min on write, the decoder adds it back on read).
     *  Inclusive-min, exclusive-max. */
    aabbMin: [number, number, number];
    aabbMax: [number, number, number];
    leaves: OctreeLeaf[];
}

/**
 * One coarser LOD level. Shares bounds + useAtlas with LOD 0; carries
 * its own voxel-size budget, palette (implicit in `fragments[].leaves`
 * via the encoder), and fragment list.
 */
export interface VxlV3LodLevel {
    minVoxelSize: number;
    maxVoxelSize: number;
    fragments: VxlV3Fragment[];
}

export interface VxlV3Data {
    minVoxelSize: number;
    maxVoxelSize: number;
    physicsGridStep: number;
    bounds: VxlV3Bounds;
    useAtlas: boolean;
    fragments: VxlV3Fragment[];
    /**
     * Optional coarser LODs ordered finest-to-coarsest. When present the file
     * is encoded as version 4 (additive trailer); when absent or empty the
     * file is encoded as version 3 (byte-identical to pre-LOD output).
     */
    additionalLods?: VxlV3LodLevel[];
    /**
     * Named material slots, describing slot indices 1..N (slot 0 is the
     * implicit base material and is never listed). Leaves reference these
     * through `OctreeLeaf.slot`. Omit — or pass empty — for a slot-free asset,
     * which encodes byte-identically to v5/v6.
     */
    slots?: VoxelSlot[];
    /**
     * Optional rigged character. Present ⇒ the file is written as v10 and every
     * leaf carries an owning joint (`OctreeLeaf.bone`). Absent ⇒ nothing changes
     * and the asset encodes exactly as it would have without this field.
     */
    rig?: VxlV3RigInput;
    /**
     * Optional eye METADATA (v11 eye section). Present ⇒ the header's eye section
     * bit is set and a fixed 19-byte record is appended; absent ⇒ the file carries
     * no eyes. Eyes are never baked as voxel cells — see VxlV3Eyes.ts.
     */
    eyes?: EyeMeta;
    /**
     * Optional smart-object parts (v12). Requires a `rig` whose `skeletonRef` is
     * `PARTS_SKELETON_REF` with exactly `parts.length + 1` joints: joint 0 is the
     * body, joint i + 1 is `parts[i]`, and each leaf's `bone` says which it is.
     * See VxlV3Parts.ts.
     */
    parts?: VxlV3Part[];
}

/**
 * Rig as handed to the ENCODER. The per-leaf bone column is not passed here — it
 * is read off `OctreeLeaf.bone` in leaf order, so the encoder's own ordering
 * stays the single source of truth and no caller can hand in a mismatched column.
 */
export interface VxlV3RigInput {
    skeletonRef: string;
    bindPositions: Float32Array;
    fillers: VxlV3Rig['fillers'];
    sockets: VxlV3Rig['sockets'];
}

// ─── Decoded (runtime) form ─────────────────────────────────────────────────
// DECODE produces LeafBuffer-backed fragments (compact typed-array columns, see
// engine/VoxelOctreeRenderer.ts); ENCODE input stays on OctreeLeaf[] (VxlV3Data
// above) so the voxelizer / bake path is unaffected.
export interface DecodedFragment {
    aabbMin: [number, number, number];
    aabbMax: [number, number, number];
    leaves: LeafBuffer;
}
export interface DecodedLodLevel {
    minVoxelSize: number;
    maxVoxelSize: number;
    fragments: DecodedFragment[];
}
export interface DecodedVxlV3 {
    minVoxelSize: number;
    maxVoxelSize: number;
    physicsGridStep: number;
    bounds: VxlV3Bounds;
    useAtlas: boolean;
    fragments: DecodedFragment[];
    additionalLods?: DecodedLodLevel[];
    /** LOD0 per-entry emissive palette (v6+). Parallel to the LOD0 palette; absent
     *  for v3/v4/v5. The per-leaf `emiss` column on each LOD0 fragment is already resolved. */
    paletteEmissive?: Uint8Array;
    /** Named material slots (v7), describing slot indices 1..N. Absent when the asset uses
     *  only the base material. The per-leaf `slot` column on each LOD0 fragment is already
     *  resolved, so renderers never need to touch this to build geometry — it is what names
     *  the slots for runtime lookup. */
    slots?: VoxelSlot[];
    /** Eye metadata (v11 eye section), or absent when the file carries no eyes. Runtime
     *  decoration only — never voxel geometry. See VxlV3Eyes.ts. */
    eyes?: EyeMeta;
    /** The rigged character (v10), or absent when the file carries no rig. The per-leaf
     *  `bone` column on each fragment is already resolved onto its LeafBuffer. */
    rig?: VxlV3Rig;
    /** Smart-object parts (v12), in joint order: `parts[i]` is joint i + 1 of `rig`. */
    parts?: VxlV3Part[];
}

export interface EncodeVxlV3Options {
    /** Default: gzip. Pass 'none' to skip compression (debugging / hex inspection). */
    compression?: 'gzip' | 'none';
}

/** Check whether a buffer's first bytes match the v3 magic. Cheap, synchronous, no copy. */
export function isVxlV3(buffer: ArrayBuffer): boolean {
    if (buffer.byteLength < 4) return false;
    const view = new DataView(buffer, 0, 4);
    return view.getUint32(0, true) === VXL3_MAGIC;
}

// ─── Encode ───────────────────────────────────────────────────────────────

/**
 * Encode to a packed binary buffer (v5 layout, gzipped body by default).
 *
 * The encoder builds a color palette from the unique colors across all leaves,
 * quantized to 12-bit RGB444 cells (`packRgb444`) — the exact 4096-color space the
 * runtime renders, so storing more (the old RGB565) was wasted precision. Fewer
 * distinct colors also means a smaller palette and more 1-byte indices.
 *
 * paletteIdxBytes auto-selects 1 (palette ≤ 256 colors) or 2 (up to 4096).
 */
export async function encodeVxlV3(data: VxlV3Data, options: EncodeVxlV3Options = {}): Promise<Uint8Array> {
    const body = encodeBody(data);
    const compression = options.compression ?? 'gzip';
    const compressionId = compression === 'gzip' ? VXL3_COMPRESSION_GZIP : VXL3_COMPRESSION_NONE;
    const payload = compressionId === VXL3_COMPRESSION_GZIP ? await gzip(body) : body;

    const out = new Uint8Array(5 + payload.byteLength);
    const outView = new DataView(out.buffer, out.byteOffset, out.byteLength);
    outView.setUint32(0, VXL3_MAGIC, true);
    out[4] = compressionId;
    out.set(payload, 5);
    return out;
}

/**
 * The palette lookup key for one leaf: its 12-bit RGB444 color cell in the low
 * 16 bits, its material slot above. This is what makes the palette a MATERIAL
 * table rather than a color table — same color + different slot = two entries,
 * so a steady taillight and a flashing beacon can share a red without sharing
 * a material. Slot-free assets pass slot 0 and key exactly on the cell, which
 * is why they still encode byte-identically to v5/v6.
 */
function paletteKey(cell: number, slot: number, blockType: number): number {
    // cell is 12 bits and slot is capped at MAX_VOXEL_SLOTS, so shifting the block type
    // above both keeps every combination distinct and well inside Number.MAX_SAFE_INTEGER.
    const base = slot === 0 ? cell : cell + slot * 0x10000;
    return blockType === 0 ? base : base + blockType * 0x1000000;
}

/**
 * Build a palette over a set of fragments. Returns the unique (color, slot)
 * entry list — colors as 12-bit RGB444 cells (v5; the runtime renders 4
 * bits/channel anyway, so 565 was wasted precision) — a lookup map, and the
 * chosen index width.
 */
function buildPalette(fragments: VxlV3Fragment[], useAtlas: boolean): {
    palette: number[];
    paletteMap: Map<number, number>;
    paletteIdxBytes: 1 | 2;
    emissive: number[];
    hasEmissive: boolean;
    slots: number[];
    hasSlots: boolean;
    blockTypes: number[];
    hasBlockTypes: boolean;
} {
    const paletteMap = new Map<number, number>();
    const palette: number[] = [];
    // Emissive and slot are parallel to `palette`, one byte per unique ENTRY — first-wins
    // per entry, exactly mirroring how the color palette itself is derived.
    const emissive: number[] = [];
    const slots: number[] = [];
    const blockTypes: number[] = [];
    let hasEmissive = false;
    let hasSlots = false;
    let hasBlockTypes = false;
    for (const fragment of fragments) {
        for (const leaf of fragment.leaves) {
            const cell = colorToCell(leaf.r, leaf.g, leaf.b, useAtlas);
            const slot = clampSlot(leaf.slot);
            const blockType = clampBlockType(leaf.blockType);
            const key = paletteKey(cell, slot, blockType);
            if (!paletteMap.has(key)) {
                paletteMap.set(key, palette.length);
                palette.push(cell);
                slots.push(slot);
                blockTypes.push(blockType);
                if (slot > 0) hasSlots = true;
                if (blockType > 0) hasBlockTypes = true;
                // Emissive is derived per ENTRY, not per source color: only the first leaf to
                // hit this (new) entry contributes its emissive value. A later leaf that
                // quantizes to the same (cell, slot) but carries a different emissive is
                // silently merged away — first leaf wins, same as color already does. Voxels
                // that need to differ now have the slot to differ BY.
                const e = Math.max(0, Math.min(255, Math.round(leaf.emissive ?? 0)));
                emissive.push(e);
                if (e > 0) hasEmissive = true;
            }
        }
    }
    // RGB444 caps at 4096 distinct cells x 16 slots, so this can't realistically trip.
    if (palette.length > 65536) {
        throw new Error(`VXL3 palette overflow: ${palette.length} unique (color, slot) entries (max 65536). Quantize before encoding.`);
    }
    return {
        palette, paletteMap, paletteIdxBytes: palette.length <= 256 ? 1 : 2,
        emissive, hasEmissive, slots, hasSlots, blockTypes, hasBlockTypes,
    };
}

/**
 * A leaf's block type, normalised for the palette. `BlockType.COLOR` is the sentinel a
 * chunk grid uses for "this voxel is coloured", which is what 0 already means here — so
 * it collapses to 0 rather than becoming a texture id nothing can resolve.
 */
function clampBlockType(blockType: number | undefined): number {
    if (!blockType || !Number.isFinite(blockType)) return 0;
    const i = Math.round(blockType);
    if (i === COLOR_BLOCK_SENTINEL || i <= 0) return 0;
    return i > 0xFFFF ? 0 : i;
}

/** `BlockType.COLOR` — imported as a literal to keep this module free of engine deps. */
const COLOR_BLOCK_SENTINEL = 255;

/** A leaf's slot, clamped to what the slot table can address (0 = base material). */
function clampSlot(slot: number | undefined): number {
    if (!slot || !Number.isFinite(slot)) return 0;
    const i = Math.round(slot);
    return i > 0 && i <= MAX_VOXEL_SLOTS ? i : 0;
}

/**
 * Byte size of the encoded fragment section for one LOD (header + leaves).
 * Does NOT include the palette itself.
 */
function fragmentSectionBytes(fragments: VxlV3Fragment[], paletteIdxBytes: 1 | 2): number {
    const leafBytes = 7 + paletteIdxBytes;
    let total = 0;
    for (const fragment of fragments) {
        total += 16 + fragment.leaves.length * leafBytes;
    }
    return total;
}

/**
 * Write all fragments for one LOD at the current cursor position. Uses
 * the LOD's own `minVoxelSize` for grid quantization so the same writer
 * works for LOD 0 and the trailer entries.
 */
function writeFragments(
    view: DataView,
    bytes: Uint8Array,
    cursorStart: number,
    fragments: VxlV3Fragment[],
    bounds: VxlV3Bounds,
    minVoxelSize: number,
    paletteMap: Map<number, number>,
    paletteIdxBytes: 1 | 2,
    useAtlas: boolean,
): number {
    const leafBytes = 7 + paletteIdxBytes;
    const inv = 1 / minVoxelSize;
    const baseX = bounds.minX;
    const baseY = bounds.minY;
    const baseZ = bounds.minZ;
    let cursor = cursorStart;
    for (const fragment of fragments) {
        view.setUint32(cursor, fragment.leaves.length, true);
        cursor += 4;
        view.setUint16(cursor + 0, Math.round((fragment.aabbMin[0] - baseX) * inv), true);
        view.setUint16(cursor + 2, Math.round((fragment.aabbMin[1] - baseY) * inv), true);
        view.setUint16(cursor + 4, Math.round((fragment.aabbMin[2] - baseZ) * inv), true);
        view.setUint16(cursor + 6, Math.round((fragment.aabbMax[0] - baseX) * inv), true);
        view.setUint16(cursor + 8, Math.round((fragment.aabbMax[1] - baseY) * inv), true);
        view.setUint16(cursor + 10, Math.round((fragment.aabbMax[2] - baseZ) * inv), true);
        cursor += 12;
        // Columnar leaves (v5): gx[] Δ, gy[] Δ, gz[] Δ, lod[], paletteIdx[]. Delta resets
        // per fragment (prev=0). Same byte budget as the old interleaved layout, but it
        // lets gzip collapse the (now tiny, spatially-coherent) per-column delta streams.
        const n = fragment.leaves.length;
        const gxBase = cursor, gyBase = cursor + n * 2, gzBase = cursor + n * 4;
        const lodBase = cursor + n * 6, idxBase = cursor + n * 7;
        let prevX = 0, prevY = 0, prevZ = 0, i = 0;
        for (const leaf of fragment.leaves) {
            const gx = Math.round((leaf.x - baseX) * inv);
            const gy = Math.round((leaf.y - baseY) * inv);
            const gz = Math.round((leaf.z - baseZ) * inv);
            const lod = Math.round(Math.log2(leaf.size * inv));
            if (gx < 0 || gy < 0 || gz < 0) {
                // A negative coordinate is not an overflow and saying "max 65535"
                // sends the reader hunting for an enormous object. It means this
                // leaf lies OUTSIDE the bounds it is being written against —
                // always a caller bug, and the grids are named so the caller
                // knows which one drifted.
                throw new Error(
                    `VXL3 leaf below bounds: grid (${gx}, ${gy}, ${gz}) from leaf `
                    + `(${leaf.x}, ${leaf.y}, ${leaf.z}) against bounds min `
                    + `(${baseX}, ${baseY}, ${baseZ}) at cell size ${1 / inv}. `
                    + `Every leaf, at every LOD, must sit at or above bounds.min.`,
                );
            }
            if (gx > 0xFFFF || gy > 0xFFFF || gz > 0xFFFF) {
                throw new Error(`VXL3 grid coord overflow: (${gx}, ${gy}, ${gz}). Max 65535 cells per axis.`);
            }
            if (lod < 0 || lod > 255) {
                throw new Error(`VXL3 lod overflow: ${lod}`);
            }
            const palIdx = paletteMap.get(
                paletteKey(colorToCell(leaf.r, leaf.g, leaf.b, useAtlas), clampSlot(leaf.slot), clampBlockType(leaf.blockType)),
            )!;
            view.setUint16(gxBase + i * 2, (gx - prevX) & 0xFFFF, true); prevX = gx;
            view.setUint16(gyBase + i * 2, (gy - prevY) & 0xFFFF, true); prevY = gy;
            view.setUint16(gzBase + i * 2, (gz - prevZ) & 0xFFFF, true); prevZ = gz;
            bytes[lodBase + i] = lod;
            if (paletteIdxBytes === 1) {
                bytes[idxBase + i] = palIdx;
            } else {
                view.setUint16(idxBase + i * 2, palIdx, true);
            }
            i++;
        }
        cursor += n * leafBytes;
    }
    return cursor;
}

function encodeBody(data: VxlV3Data): Uint8Array {
    // LOD 0 palette (lives in the header section).
    const lod0 = buildPalette(data.fragments, data.useAtlas);
    const additionalLods = data.additionalLods ?? [];

    // Each additional LOD has its own palette (coarser sampling can pick
    // different colors). We compute these upfront so we can size the buffer.
    const lodPalettes = additionalLods.map(lod => buildPalette(lod.fragments, data.useAtlas));

    // Trailer size: v5 ALWAYS writes the 2-byte additionalLodCount (0 when no coarser
    // LODs), then per-LOD header (13B) + per-LOD palette + per-LOD fragments.
    let trailerBytes = 2; // additionalLodCount uint16 (always present)
    for (let i = 0; i < additionalLods.length; i++) {
        const pal = lodPalettes[i]!;
        // 4+4+1+2+2 = 13 B header per LOD
        trailerBytes += 13;
        trailerBytes += pal.palette.length * 2;
        trailerBytes += fragmentSectionBytes(additionalLods[i]!.fragments, pal.paletteIdxBytes);
    }

    // Emissive: the LOD0 palette drives it (v1 = LOD0-only emissive; coarse LODs render unlit).
    // Written ONLY when emissive is present, so non-emissive assets stay byte-identical v5.
    const emitEmissive = lod0.hasEmissive;

    // Slots: written ONLY when at least one voxel is in a named slot AND the caller supplied
    // the table naming them, so slot-free assets stay byte-identical v5/v6.
    const slotTable = (data.slots ?? []).slice(0, MAX_VOXEL_SLOTS);
    const emitSlots = lod0.hasSlots && slotTable.length > 0;
    const slotNameBytes = emitSlots
        ? slotTable.map((s) => new TextEncoder().encode(s.name.slice(0, VOXEL_SLOT_NAME_MAX)))
        : [];

    // v8 carries the slot column at EVERY LOD, so a light stays a light past the
    // first LOD switch. It deliberately has NO emissive array: in v8 glow is a
    // MATERIAL property and comes from the slot table alone. The legacy per-leaf
    // emissive of v6 is not representable — it keys on colour, so two same-coloured
    // voxels can never disagree about glow, which is exactly the limitation slots
    // exist to remove.
    //
    // An asset that still relies on that legacy emissive therefore stays v7 rather
    // than losing it: dropping a user's glow to gain a version number is not a
    // trade the encoder gets to make silently.
    const coarseEmissive = lodPalettes.some((p) => p.hasEmissive);
    const legacyEmissive = emitEmissive || coarseEmissive;
    const coarseSlots = emitSlots && lodPalettes.some((p) => p.hasSlots);
    // A v9 asset carries block types, which the legacy per-colour emissive block cannot
    // coexist with (v8 dropped that block entirely). Rather than silently discarding a
    // user's glow to gain block types, an asset that still relies on legacy emissive keeps
    // it and forgoes them — the same trade v8's comment refuses to make in reverse.
    const wantBlockTypes = lod0.hasBlockTypes || lodPalettes.some((p) => p.hasBlockTypes);
    // A rigged asset is written as "a v9 file, plus the rig section". The 48-byte header
    // has no spare flag left, so v10 — like v9 before it — announces its sections by
    // VERSION alone; that only works if a v10 file always carries the sections a v9 file
    // would. So a rig forces the block-type and per-LOD material arrays to be written
    // (zero-filled when unused: 2 bytes per palette ENTRY, ~36 B on a real character),
    // and the rig is then findable by having read everything before it.
    const rig = data.rig;
    const eyes = data.eyes;
    const emitEyes = eyes !== undefined;
    // Smart-object parts (v12): names, hierarchy and motion over the rig's joint
    // column. A parts table without the rig it indexes is unreadable, so the pair
    // is checked here rather than discovered as mis-animated voxels at runtime.
    const parts = data.parts;
    const emitParts = parts !== undefined && parts.length > 0;
    if (emitParts) {
        if (!rig || rig.skeletonRef !== PARTS_SKELETON_REF) {
            throw new Error(`[VXL3] parts need a rig with skeletonRef "${PARTS_SKELETON_REF}"`);
        }
        const problem = validateParts(parts, rig.bindPositions.length / 3);
        if (problem) throw new Error(`[VXL3] invalid parts table: ${problem}`);
    }
    // Material classes (v11): one class name per named slot, saying what that slot is
    // MADE OF. Written only when a slot names a non-default class, so a class-free asset
    // stays byte-identical to the version it would otherwise have been. Like a rig, a v11
    // file always carries the sections a v9 file would — see VxlV3MaterialClass.ts for why
    // it needs a header FLAG where v10 could get away with the version alone.
    const classNames = emitSlots ? materialClassNames(slotTable) : [];
    const emitMaterialClasses = classNames.some((name) => name.length > 0);
    // Everything below treats a rig and material classes alike: both are v9-plus-a-section,
    // and both force the sections that sit before them to be written.
    const forcesV9Sections = rig !== undefined || emitMaterialClasses || emitEyes || emitParts;
    // The eye section, like material classes, needs the v11 section bitfield to announce
    // itself — a v10 file has no flag byte to carry it. So eyes alone raise the file to v11.
    // Parts raise it further, to v12, so a v11 reader refuses the file outright.
    const useV11 = emitMaterialClasses || emitEyes || emitParts;
    if (forcesV9Sections && legacyEmissive) {
        // Same trade the block-type branch refuses in reverse: a rig or a material class is
        // the whole point of such a file, and the legacy per-colour emissive is the thing v8
        // already replaced.
        console.warn('[VXL3] asset uses the legacy per-colour emissive alongside a rig or a'
            + ' material class; keeping those and dropping that glow. Move it onto a material slot.');
    }
    const emitBlockTypes = forcesV9Sections ? true : (wantBlockTypes && !legacyEmissive);
    if (!forcesV9Sections && wantBlockTypes && legacyEmissive) {
        console.warn('[VXL3] asset uses BOTH block types and the legacy per-colour emissive;'
            + ' keeping emissive and dropping block types. Move the glow onto a material slot.');
    }
    // v9 always writes the per-LOD arrays when slots exist: unlike v8, its version alone
    // cannot tell a reader whether a coarse LOD happened to hold a slotted entry.
    const emitLodMaterials = additionalLods.length > 0 && (forcesV9Sections || !legacyEmissive)
        && (emitBlockTypes ? emitSlots : coarseSlots);
    // Sized to EACH LOD's own palette; zero-filled for a LOD with no slotted entry,
    // so the arrays stay positionally addressable without a per-LOD presence flag.
    const lodPaletteTotal = emitLodMaterials
        ? lodPalettes.reduce((sum, p) => sum + p.palette.length, 0)
        : 0;

    // Block types (v9): two bytes per palette ENTRY, for LOD 0 and every coarser LOD.
    // Always per-LOD — a textured block that fell back to flat colour at the first LOD
    // switch is the artefact v8 exists to prevent, and there is no reason to repeat it.
    // Written only when an asset actually uses block types, so everything else stays
    // byte-identical to the version it would otherwise have been.
    const blockTypeBytes = emitBlockTypes
        ? (lod0.palette.length + lodPalettes.reduce((sum, p) => sum + p.palette.length, 0)) * 2
        : 0;

    const emissiveBytes = (legacyEmissive && !forcesV9Sections) ? lod0.palette.length : 0;
    // Per slot: emissive uint8 + nameLength uint8 + name. Then one slot byte per
    // LOD0 entry, and (v8) one per entry of every coarser LOD.
    const slotBytes = emitSlots
        ? slotNameBytes.reduce((sum, n) => sum + 2 + n.byteLength, 0)
          + lod0.palette.length + lodPaletteTotal
        : 0;

    // v10 rig. Sized against the leaf counts it must cover, since the bone column is
    // per LEAF (not per palette entry) and is written in the encoder's own leaf order.
    const lod0LeafCount = countLeaves(data.fragments);
    const lodLeafCounts = additionalLods.map((lod) => countLeaves(lod.fragments));
    const rigBytes = rig
        ? rigSectionBytes(
            { ...rig, bones: new Uint8Array(0), lodBones: [] },
            lod0LeafCount, lodLeafCounts,
        )
        : 0;

    // v11 material classes, appended after the rig section.
    const materialClassBytes = emitMaterialClasses ? materialClassSectionBytes(classNames) : 0;
    // v11 eye section, appended after material classes.
    const eyeBytes = emitEyes ? EYE_SECTION_BYTES : 0;
    // v12 parts section, appended LAST.
    const partsBytes = emitParts ? partsSectionBytes(parts) : 0;

    const lod0FragBytes = fragmentSectionBytes(data.fragments, lod0.paletteIdxBytes);
    const totalBytes = BODY_HEADER_SIZE + lod0.palette.length * 2 + lod0FragBytes
        + trailerBytes + emissiveBytes + slotBytes + blockTypeBytes + rigBytes
        + materialClassBytes + eyeBytes + partsBytes;

    const buffer = new ArrayBuffer(totalBytes);
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);

    // Body header. Version is the LOWEST that can represent what this asset actually uses,
    // so adding the slot concept did not change the bytes of any asset that has no slots.
    const version = emitParts
        ? VXL3_VERSION_PARTS
        : useV11
        ? VXL3_VERSION_MATERIAL_CLASS
        : rig
        ? VXL3_VERSION_RIG
        : emitBlockTypes
        ? VXL3_VERSION_BLOCK_TYPES
        : emitLodMaterials
            ? VXL3_VERSION_LOD_MATERIALS
            : emitSlots
                ? VXL3_VERSION_SLOTS
                : emitEmissive ? VXL3_VERSION_EMISSIVE : VXL3_VERSION_COLUMNAR;
    view.setUint32(0, version, true);
    view.setFloat32(4, data.minVoxelSize, true);
    view.setFloat32(8, data.maxVoxelSize, true);
    view.setFloat32(12, data.physicsGridStep, true);
    view.setFloat32(16, data.bounds.minX, true);
    view.setFloat32(20, data.bounds.minY, true);
    view.setFloat32(24, data.bounds.minZ, true);
    view.setFloat32(28, data.bounds.maxX, true);
    view.setFloat32(32, data.bounds.maxY, true);
    view.setFloat32(36, data.bounds.maxZ, true);
    bytes[40] = data.useAtlas ? 1 : 0;
    bytes[41] = lod0.paletteIdxBytes;
    view.setUint16(42, lod0.palette.length, true);
    view.setUint16(44, data.fragments.length, true);
    // Byte 46 changes meaning at v11. Through v10 it marks the legacy emissive BLOCK as
    // present (and is not read at all from v8 on, which has no such block). From v11 it is
    // a SECTION BITFIELD, because a v11 file cannot announce its sections by version alone:
    // the section it would then have to always carry is the rig, which costs a byte per leaf
    // and cannot be written empty — see VxlV3MaterialClass.ts. Old readers reject v11 by
    // version before reaching this byte, so the two meanings can never be confused.
    bytes[46] = useV11
        ? ((emitMaterialClasses ? VXL3_SECTION_MATERIAL_CLASS : 0)
            | (rig ? VXL3_SECTION_RIG : 0)
            | (emitEyes ? VXL3_SECTION_EYES : 0)
            | (emitParts ? VXL3_SECTION_PARTS : 0))
        : (emitEmissive && !forcesV9Sections) ? VXL3_SECTION_LEGACY_EMISSIVE : 0;
    bytes[47] = emitSlots ? slotTable.length : 0;   // named slot count (was reserved)

    // LOD 0 palette.
    let cursor = BODY_HEADER_SIZE;
    for (let i = 0; i < lod0.palette.length; i++) {
        view.setUint16(cursor, lod0.palette[i]!, true);
        cursor += 2;
    }

    // LOD 0 fragments.
    cursor = writeFragments(view, bytes, cursor, data.fragments, data.bounds, data.minVoxelSize, lod0.paletteMap, lod0.paletteIdxBytes, data.useAtlas);

    // LOD trailer. v5 always writes the count (0 when none); the per-LOD body follows only
    // when there are coarser LODs.
    {
        view.setUint16(cursor, additionalLods.length, true);
        cursor += 2;
        for (let i = 0; i < additionalLods.length; i++) {
            const lod = additionalLods[i]!;
            const pal = lodPalettes[i]!;
            view.setFloat32(cursor + 0, lod.minVoxelSize, true);
            view.setFloat32(cursor + 4, lod.maxVoxelSize, true);
            bytes[cursor + 8] = pal.paletteIdxBytes;
            view.setUint16(cursor + 9, pal.palette.length, true);
            view.setUint16(cursor + 11, lod.fragments.length, true);
            cursor += 13;
            for (let p = 0; p < pal.palette.length; p++) {
                view.setUint16(cursor, pal.palette[p]!, true);
                cursor += 2;
            }
            cursor = writeFragments(view, bytes, cursor, lod.fragments, data.bounds, lod.minVoxelSize, pal.paletteMap, pal.paletteIdxBytes, data.useAtlas);
        }
    }

    // Legacy emissive block (v6/v7 only) — appended AFTER the LOD trailer so v3/v4/v5
    // readers, which stop at the trailer, ignore it. One byte per LOD0 entry. v8 does
    // not write this at all; there, glow belongs to the material.
    //
    // The gate must match `emissiveBytes` above EXACTLY: writing a block the byte budget
    // did not reserve shifts every section after it and overruns the buffer.
    if (emitEmissive && !forcesV9Sections) {
        for (let i = 0; i < lod0.palette.length; i++) {
            bytes[cursor] = lod0.emissive[i]!;
            cursor += 1;
        }
    }

    // Slot section (v7+) — appended LAST, after the emissive block: the named slot
    // table, then one slot byte per LOD0 palette entry, then (v8) the same for each
    // coarser LOD. Ordering matters, since each section is found by reading the
    // ones before it.
    if (emitSlots) {
        for (let i = 0; i < slotTable.length; i++) {
            const name = slotNameBytes[i]!;
            bytes[cursor] = Math.max(0, Math.min(255, Math.round(slotTable[i]!.emissive)));
            bytes[cursor + 1] = name.byteLength;
            cursor += 2;
            bytes.set(name, cursor);
            cursor += name.byteLength;
        }
        for (let i = 0; i < lod0.palette.length; i++) {
            bytes[cursor] = lod0.slots[i]!;
            cursor += 1;
        }
        if (emitLodMaterials) {
            for (const pal of lodPalettes) {
                for (let i = 0; i < pal.palette.length; i++) {
                    bytes[cursor] = pal.slots[i]!;
                    cursor += 1;
                }
            }
        }

    }

    // Block-type section (v9) — appended LAST, after the slot section, so a reader finds
    // it by having read everything before it. LOD 0 first, then each coarser LOD in order.
    if (emitBlockTypes) {
        for (let i = 0; i < lod0.palette.length; i++) {
            view.setUint16(cursor, lod0.blockTypes[i]!, true);
            cursor += 2;
        }
        for (const pal of lodPalettes) {
            for (let i = 0; i < pal.palette.length; i++) {
                view.setUint16(cursor, pal.blockTypes[i]!, true);
                cursor += 2;
            }
        }
    }

    // Rig section (v10) — after the block types. The bone column is gathered in the SAME
    // fragment/leaf order `writeFragments` used, which is what makes it positionally
    // addressable on read without repeating any counts on the wire.
    if (rig) {
        cursor = writeRigSection(
            view, bytes, cursor,
            { ...rig, bones: new Uint8Array(0), lodBones: [] },
            gatherBones(data.fragments),
            additionalLods.map((lod) => gatherBones(lod.fragments)),
        );
    }

    // Material-class section (v11) — appended LAST, after the rig. One entry per named
    // slot, in slot-table order, so it is addressed by the header's slot count alone.
    if (emitMaterialClasses) {
        cursor = writeMaterialClassSection(bytes, cursor, classNames);
    }

    // Eye section (v11) — appended LAST, after the material classes. A single fixed
    // record; eyes are metadata, never voxel cells (VxlV3Eyes.ts).
    if (emitEyes) {
        cursor = writeEyeSection(view, cursor, eyes);
    }

    // Parts section (v12) — appended LAST, after the eyes.
    if (emitParts) {
        cursor = writePartsSection(view, bytes, cursor, parts);
    }

    return bytes;
}

/** Total leaves across a fragment list — the length of that level's bone column. */
function countLeaves(fragments: readonly VxlV3Fragment[]): number {
    let n = 0;
    for (const f of fragments) n += f.leaves.length;
    return n;
}

/**
 * The owning joint of every leaf, concatenated in fragment order then leaf order —
 * byte-for-byte the order `writeFragments` emits, so the decoder can walk the column
 * alongside the leaves it decodes. A leaf with no `bone` is joint 0, the root.
 */
function gatherBones(fragments: readonly VxlV3Fragment[]): Uint8Array {
    const out = new Uint8Array(countLeaves(fragments));
    let i = 0;
    for (const f of fragments) {
        for (const leaf of f.leaves) out[i++] = leaf.bone ?? 0;
    }
    return out;
}

// ─── Decode ───────────────────────────────────────────────────────────────

/**
 * Decode a v3 binary buffer into in-memory data. Handles both raw and
 * gzipped bodies (selected by the compressionId byte at offset 4). Throws
 * on bad magic / version / overflow.
 */
export async function decodeVxlV3(buffer: ArrayBuffer): Promise<DecodedVxlV3> {
    if (buffer.byteLength < 5) {
        throw new Error(`VXL3 buffer too small: ${buffer.byteLength} bytes`);
    }
    const outerView = new DataView(buffer, 0, 5);
    if (outerView.getUint32(0, true) !== VXL3_MAGIC) {
        throw new Error('VXL3 magic mismatch');
    }
    const compressionId = outerView.getUint8(4);
    const payload = new Uint8Array(buffer, 5);

    let body: Uint8Array;
    if (compressionId === VXL3_COMPRESSION_GZIP) {
        body = await gunzip(payload);
    } else if (compressionId === VXL3_COMPRESSION_NONE) {
        body = payload;
    } else {
        throw new Error(`VXL3 unknown compressionId: ${compressionId}`);
    }

    return decodeBody(body);
}

/**
 * Read `fragmentCount` fragments starting at `cursor`. Returns the new
 * cursor and the parsed fragments. Used for both LOD 0 (after the body
 * header) and trailer LODs (after each LOD's per-level header).
 */
function readFragments(
    view: DataView,
    bytes: Uint8Array,
    cursorStart: number,
    fragmentCount: number,
    paletteCells: number[],
    paletteIdxBytes: 1 | 2,
    minVoxelSize: number,
    bounds: VxlV3Bounds,
    keepPalIdx: boolean = false,
): { cursor: number; fragments: DecodedFragment[] } {
    const leafBytes = 7 + paletteIdxBytes;
    const baseX = bounds.minX;
    const baseY = bounds.minY;
    const baseZ = bounds.minZ;
    const fragments: DecodedFragment[] = new Array(fragmentCount);
    let cursor = cursorStart;
    for (let f = 0; f < fragmentCount; f++) {
        const leafCount = view.getUint32(cursor, true);
        cursor += 4;
        const aabbMin: [number, number, number] = [
            view.getUint16(cursor + 0, true) * minVoxelSize + baseX,
            view.getUint16(cursor + 2, true) * minVoxelSize + baseY,
            view.getUint16(cursor + 4, true) * minVoxelSize + baseZ,
        ];
        const aabbMax: [number, number, number] = [
            view.getUint16(cursor + 6, true) * minVoxelSize + baseX,
            view.getUint16(cursor + 8, true) * minVoxelSize + baseY,
            view.getUint16(cursor + 10, true) * minVoxelSize + baseZ,
        ];
        cursor += 12;
        // Decode straight into compact LeafBuffer columns — no per-leaf objects.
        const buf = new LeafBuffer(leafCount, minVoxelSize, baseX, baseY, baseZ);
        if (keepPalIdx) buf.palIdx = new Uint16Array(leafCount);
        for (let i = 0; i < leafCount; i++) {
            buf.gx[i] = view.getUint16(cursor + 0, true);
            buf.gy[i] = view.getUint16(cursor + 2, true);
            buf.gz[i] = view.getUint16(cursor + 4, true);
            buf.lod[i] = bytes[cursor + 6]!;
            const palIdx = paletteIdxBytes === 1 ? bytes[cursor + 7]! : view.getUint16(cursor + 7, true);
            if (palIdx >= paletteCells.length) {
                throw new Error(`VXL3 palette index out of range: ${palIdx}/${paletteCells.length}`);
            }
            buf.color[i] = paletteCells[palIdx]!;
            if (buf.palIdx) buf.palIdx[i] = palIdx;
            cursor += leafBytes;
        }
        fragments[f] = { aabbMin, aabbMax, leaves: buf };
    }
    return { cursor, fragments };
}

/**
 * v5 columnar reader. Same fragment header (leafCount + aabb) as `readFragments`, but
 * the leaves are stored as columns — gx[] (Δ), gy[] (Δ), gz[] (Δ), lod[], paletteIdx[]
 * — so gx/gy/gz are reconstructed by a wrapping prefix-sum. Produces the identical
 * `LeafBuffer` SoA fragments, so the renderer/consumers are version-agnostic.
 */
function readFragmentsColumnar(
    view: DataView,
    bytes: Uint8Array,
    cursorStart: number,
    fragmentCount: number,
    paletteCells: number[],
    paletteIdxBytes: 1 | 2,
    minVoxelSize: number,
    bounds: VxlV3Bounds,
    keepPalIdx: boolean = false,
): { cursor: number; fragments: DecodedFragment[] } {
    const leafBytes = 7 + paletteIdxBytes;
    const baseX = bounds.minX;
    const baseY = bounds.minY;
    const baseZ = bounds.minZ;
    const fragments: DecodedFragment[] = new Array(fragmentCount);
    let cursor = cursorStart;
    for (let f = 0; f < fragmentCount; f++) {
        const leafCount = view.getUint32(cursor, true);
        cursor += 4;
        const aabbMin: [number, number, number] = [
            view.getUint16(cursor + 0, true) * minVoxelSize + baseX,
            view.getUint16(cursor + 2, true) * minVoxelSize + baseY,
            view.getUint16(cursor + 4, true) * minVoxelSize + baseZ,
        ];
        const aabbMax: [number, number, number] = [
            view.getUint16(cursor + 6, true) * minVoxelSize + baseX,
            view.getUint16(cursor + 8, true) * minVoxelSize + baseY,
            view.getUint16(cursor + 10, true) * minVoxelSize + baseZ,
        ];
        cursor += 12;
        const n = leafCount;
        const gxBase = cursor, gyBase = cursor + n * 2, gzBase = cursor + n * 4;
        const lodBase = cursor + n * 6, idxBase = cursor + n * 7;
        const buf = new LeafBuffer(leafCount, minVoxelSize, baseX, baseY, baseZ);
        if (keepPalIdx) buf.palIdx = new Uint16Array(leafCount);
        let px = 0, py = 0, pz = 0;
        for (let i = 0; i < n; i++) {
            px = (px + view.getUint16(gxBase + i * 2, true)) & 0xFFFF; buf.gx[i] = px;
            py = (py + view.getUint16(gyBase + i * 2, true)) & 0xFFFF; buf.gy[i] = py;
            pz = (pz + view.getUint16(gzBase + i * 2, true)) & 0xFFFF; buf.gz[i] = pz;
            buf.lod[i] = bytes[lodBase + i]!;
            const palIdx = paletteIdxBytes === 1 ? bytes[idxBase + i]! : view.getUint16(idxBase + i * 2, true);
            if (palIdx >= paletteCells.length) {
                throw new Error(`VXL3 palette index out of range: ${palIdx}/${paletteCells.length}`);
            }
            buf.color[i] = paletteCells[palIdx]!;
            if (buf.palIdx) buf.palIdx[i] = palIdx;
        }
        cursor += n * leafBytes;
        fragments[f] = { aabbMin, aabbMax, leaves: buf };
    }
    return { cursor, fragments };
}

function decodeBody(body: Uint8Array): DecodedVxlV3 {
    if (body.byteLength < BODY_HEADER_SIZE) {
        throw new Error(`VXL3 body too small: ${body.byteLength} bytes`);
    }
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const bytes = body;

    const version = view.getUint32(0, true);
    if (version !== VXL3_VERSION && version !== VXL3_VERSION_WITH_LODS && version !== VXL3_VERSION_COLUMNAR
        && version !== VXL3_VERSION_EMISSIVE && version !== VXL3_VERSION_SLOTS
        && version !== VXL3_VERSION_LOD_MATERIALS && version !== VXL3_VERSION_BLOCK_TYPES
        && version !== VXL3_VERSION_RIG && version !== VXL3_VERSION_MATERIAL_CLASS
        && version !== VXL3_VERSION_PARTS) {
        throw new Error(`VXL3 unsupported version: ${version}`);
    }
    // From v11 header byte 46 is a section bitfield rather than the legacy emissive flag.
    // Every earlier version reaches this decoder only through the checks above, so the two
    // meanings of the byte never overlap.
    const isSectionFlagged = version === VXL3_VERSION_MATERIAL_CLASS || version === VXL3_VERSION_PARTS;
    const sectionFlags = isSectionFlagged ? bytes[46]! : 0;
    // v5+ store leaves COLUMNAR with delta-coded gx/gy/gz; v3/v4 are interleaved. Both
    // decode to the same LeafBuffer SoA fragments. v6 is a v5 body + an emissive trailer;
    // v7 is a v6 body + a material-slot section; v8 repeats both per coarser LOD.
    const columnar = version === VXL3_VERSION_COLUMNAR || version === VXL3_VERSION_EMISSIVE
        || version === VXL3_VERSION_SLOTS || version === VXL3_VERSION_LOD_MATERIALS
        || version === VXL3_VERSION_BLOCK_TYPES || version === VXL3_VERSION_RIG
        || version === VXL3_VERSION_MATERIAL_CLASS || version === VXL3_VERSION_PARTS;
    const readFrags = columnar ? readFragmentsColumnar : readFragments;
    // hasEmissive lives in byte 46 (was reserved); meaningful for v6 and v7. From v11 that
    // byte is a section bitfield instead, and a v11 file never carries the legacy block —
    // it always carries the block types, which cannot coexist with it.
    const hasEmissive = (version === VXL3_VERSION_EMISSIVE || version === VXL3_VERSION_SLOTS
        || version === VXL3_VERSION_LOD_MATERIALS) && bytes[46] === VXL3_SECTION_LEGACY_EMISSIVE;
    // slotCount lives in byte 47 (was reserved); meaningful for v7 and up.
    const slotCount = (version === VXL3_VERSION_SLOTS || version === VXL3_VERSION_LOD_MATERIALS
        || version === VXL3_VERSION_BLOCK_TYPES || version === VXL3_VERSION_RIG
        || version === VXL3_VERSION_MATERIAL_CLASS || version === VXL3_VERSION_PARTS) ? bytes[47]! : 0;
    // v8 repeats the emissive/slot arrays for every coarser LOD, against that LOD's palette.
    // v9 is v8 plus block types, so it carries them the same way — and because the reader
    // cannot infer from the bytes alone WHETHER a coarse LOD had a slotted entry, v9 always
    // writes the arrays when slots exist (zero-filled where a LOD has none), keeping the
    // section positionally addressable exactly as v8 describes.
    //
    // v11 carries both for the same reason v10 does: they sit BEFORE the sections its
    // header flags declare, so everything up to those flags has to stay positionally
    // addressable.
    const hasLodMaterials = version === VXL3_VERSION_LOD_MATERIALS
        || version === VXL3_VERSION_BLOCK_TYPES || version === VXL3_VERSION_RIG
        || version === VXL3_VERSION_MATERIAL_CLASS || version === VXL3_VERSION_PARTS;
    const hasBlockTypes = version === VXL3_VERSION_BLOCK_TYPES || version === VXL3_VERSION_RIG
        || version === VXL3_VERSION_MATERIAL_CLASS || version === VXL3_VERSION_PARTS;
    // A v10 file always has a rig — that is what the version means. A v11 file says so,
    // because a rig costs a byte per leaf and so cannot be written empty just to keep a
    // version number's promise.
    const hasRig = version === VXL3_VERSION_RIG
        || (sectionFlags & VXL3_SECTION_RIG) !== 0;
    const hasMaterialClasses = (sectionFlags & VXL3_SECTION_MATERIAL_CLASS) !== 0;
    const hasEyes = (sectionFlags & VXL3_SECTION_EYES) !== 0;
    const hasParts = (sectionFlags & VXL3_SECTION_PARTS) !== 0;
    const minVoxelSize = view.getFloat32(4, true);
    const maxVoxelSize = view.getFloat32(8, true);
    const physicsGridStep = view.getFloat32(12, true);
    const bounds: VxlV3Bounds = {
        minX: view.getFloat32(16, true),
        minY: view.getFloat32(20, true),
        minZ: view.getFloat32(24, true),
        maxX: view.getFloat32(28, true),
        maxY: view.getFloat32(32, true),
        maxZ: view.getFloat32(36, true),
    };
    const useAtlas = bytes[40] === 1;
    const paletteIdxBytes = bytes[41]!;
    if (paletteIdxBytes !== 1 && paletteIdxBytes !== 2) {
        throw new Error(`VXL3 invalid paletteIdxBytes: ${paletteIdxBytes}`);
    }
    const paletteCount = view.getUint16(42, true);
    const fragmentCount = view.getUint16(44, true);

    // LOD 0 palette → 12-bit RGB444 cells. v5 stores the cell directly; v3/v4 store
    // RGB565, converted to the SAME cell the old decoder produced (565→888→packRgb444).
    const palette = new Array<number>(paletteCount);
    let cursor = BODY_HEADER_SIZE;
    for (let i = 0; i < paletteCount; i++) {
        const stored = view.getUint16(cursor, true);
        palette[i] = columnar ? stored : rgb565ToCell(stored);
        cursor += 2;
    }

    // LOD 0 fragments. Emissive and slot are stored per PALETTE ENTRY, and with slots a
    // colour cell no longer identifies an entry uniquely (two slots can share a colour), so
    // keep each leaf's palette index when either section follows — it is the only exact way
    // to resolve them. Dropped again the moment the columns are filled.
    // Block types resolve through the palette index exactly as emissive and slots do, so
    // an asset carrying ONLY block types still needs the column kept through the read.
    const needPalIdx = hasEmissive || slotCount > 0 || hasBlockTypes;
    const lod0 = readFrags(view, bytes, cursor, fragmentCount, palette, paletteIdxBytes as 1 | 2, minVoxelSize, bounds, needPalIdx);
    cursor = lod0.cursor;

    // LOD trailer: present for v4 (always ≥1 LOD), v5, and v6 (count may be 0).
    let additionalLods: DecodedLodLevel[] | undefined;
    let lodPaletteCounts: number[] = [];
    if (VERSIONS_WITH_TRAILER.includes(version)) {
        if (cursor + 2 > body.byteLength) {
            throw new Error('VXL4 trailer truncated (missing additionalLodCount)');
        }
        const additionalLodCount = view.getUint16(cursor, true);
        cursor += 2;
        additionalLods = new Array(additionalLodCount);
        lodPaletteCounts = new Array(additionalLodCount).fill(0);
        for (let i = 0; i < additionalLodCount; i++) {
            if (cursor + 13 > body.byteLength) {
                throw new Error(`VXL4 trailer truncated at LOD ${i + 1} header`);
            }
            const lodMin = view.getFloat32(cursor + 0, true);
            const lodMax = view.getFloat32(cursor + 4, true);
            const lodPaletteIdxBytes = bytes[cursor + 8];
            if (lodPaletteIdxBytes !== 1 && lodPaletteIdxBytes !== 2) {
                throw new Error(`VXL4 LOD ${i + 1} invalid paletteIdxBytes: ${lodPaletteIdxBytes}`);
            }
            const lodPaletteCount = view.getUint16(cursor + 9, true);
            const lodFragmentCount = view.getUint16(cursor + 11, true);
            cursor += 13;

            const lodPalette = new Array<number>(lodPaletteCount);
            for (let p = 0; p < lodPaletteCount; p++) {
                const stored = view.getUint16(cursor, true);
                lodPalette[p] = columnar ? stored : rgb565ToCell(stored);
                cursor += 2;
            }
            // v8 resolves this LOD's emissive/slot through the stored palette index,
            // exactly as LOD 0 does, so the column has to survive the read.
            const result = readFrags(view, bytes, cursor, lodFragmentCount, lodPalette, lodPaletteIdxBytes as 1 | 2, lodMin, bounds, hasLodMaterials);
            cursor = result.cursor;
            lodPaletteCounts[i] = lodPaletteCount;
            additionalLods[i] = {
                minVoxelSize: lodMin,
                maxVoxelSize: lodMax,
                fragments: result.fragments,
            };
        }
    }

    // Legacy emissive block (v6/v7): one byte per LOD0 palette entry, after the LOD trailer.
    // Each leaf's emissive resolves through its stored palette INDEX. v8 never writes one —
    // glow there is a material property, read from the slot table below.
    let paletteEmissive: Uint8Array | undefined;
    if (hasEmissive) {
        if (cursor + paletteCount > body.byteLength) {
            throw new Error('VXL6 emissive block truncated');
        }
        paletteEmissive = new Uint8Array(paletteCount);
        for (let i = 0; i < paletteCount; i++) {
            paletteEmissive[i] = bytes[cursor]!;
            cursor += 1;
        }
        for (const f of lod0.fragments) {
            const buf = f.leaves;
            const idx = buf.palIdx;
            if (!idx) continue;
            buf.emiss = new Uint8Array(buf.count);
            for (let i = 0; i < buf.count; i++) {
                buf.emiss[i] = paletteEmissive[idx[i]!] ?? 0;
            }
        }
    }

    // Slot section (v7): the named slot table, then one slot byte per LOD0 palette entry.
    // Read after the emissive block — that is the order the encoder wrote them in.
    let slots: VoxelSlot[] | undefined;
    if (slotCount > 0) {
        const table: VoxelSlot[] = [];
        for (let i = 0; i < slotCount; i++) {
            if (cursor + 2 > body.byteLength) throw new Error(`VXL7 slot table truncated at slot ${i + 1}`);
            const emissive = bytes[cursor]!;
            const nameLength = bytes[cursor + 1]!;
            cursor += 2;
            if (cursor + nameLength > body.byteLength) throw new Error(`VXL7 slot name truncated at slot ${i + 1}`);
            const name = new TextDecoder().decode(bytes.subarray(cursor, cursor + nameLength));
            cursor += nameLength;
            table.push({ name, emissive });
        }
        if (cursor + paletteCount > body.byteLength) {
            throw new Error('VXL7 palette slot block truncated');
        }
        const paletteSlots = new Uint8Array(paletteCount);
        for (let i = 0; i < paletteCount; i++) {
            paletteSlots[i] = bytes[cursor]!;
            cursor += 1;
        }
        for (const f of lod0.fragments) {
            const buf = f.leaves;
            const idx = buf.palIdx;
            if (!idx) continue;
            buf.slot = new Uint8Array(buf.count);
            for (let i = 0; i < buf.count; i++) {
                const s = paletteSlots[idx[i]!] ?? 0;
                // A slot index past the table would address a material that does not exist;
                // fall back to the base material rather than failing the whole asset.
                buf.slot[i] = s <= table.length ? s : 0;
            }
        }
        // v8: one slot array per coarser LOD, so a named material — and any light
        // riding on it — survives past the first LOD switch.
        if (hasLodMaterials && additionalLods) {
            for (let l = 0; l < additionalLods.length; l++) {
                const count = lodPaletteCounts[l] ?? 0;
                if (cursor + count > body.byteLength) {
                    throw new Error(`VXL8 palette slot block truncated at LOD ${l + 1}`);
                }
                const lodSlots = bytes.subarray(cursor, cursor + count);
                cursor += count;
                for (const f of additionalLods[l]!.fragments) {
                    const buf = f.leaves;
                    const idx = buf.palIdx;
                    if (!idx) continue;
                    buf.slot = new Uint8Array(buf.count);
                    for (let i = 0; i < buf.count; i++) {
                        const sv = lodSlots[idx[i]!] ?? 0;
                        buf.slot[i] = sv <= table.length ? sv : 0;
                    }
                }
            }
        }
        slots = table;
    }

    // Block-type section (v9) — read LAST, mirroring the write order. One uint16 per
    // palette entry for LOD 0, then for each coarser LOD against that LOD's own palette.
    if (hasBlockTypes) {
        const readInto = (fragments: DecodedFragment[], count: number, label: string): void => {
            if (cursor + count * 2 > body.byteLength) {
                throw new Error(`VXL9 palette block-type block truncated at ${label}`);
            }
            const table = new Uint16Array(count);
            for (let i = 0; i < count; i++) {
                table[i] = view.getUint16(cursor, true);
                cursor += 2;
            }
            for (const f of fragments) {
                const buf = f.leaves;
                const idx = buf.palIdx;
                if (!idx) continue;
                buf.blockType = new Uint16Array(buf.count);
                for (let i = 0; i < buf.count; i++) buf.blockType[i] = table[idx[i]!] ?? 0;
            }
        };
        readInto(lod0.fragments, paletteCount, 'LOD 0');
        if (additionalLods) {
            for (let l = 0; l < additionalLods.length; l++) {
                readInto(additionalLods[l]!.fragments, lodPaletteCounts[l] ?? 0, `LOD ${l + 1}`);
            }
        }
    }

    // Rig section (v10) — read LAST, mirroring the write order. The bone column is per
    // LEAF, so it is walked alongside the decoded fragments in the same fragment/leaf
    // order the encoder wrote, and scattered onto each LeafBuffer.
    let rig: VxlV3Rig | undefined;
    if (hasRig) {
        const lodLeafCounts = (additionalLods ?? []).map((lod) => countDecodedLeaves(lod.fragments));
        const read = readRigSection(view, bytes, cursor, countDecodedLeaves(lod0.fragments), lodLeafCounts);
        cursor = read.cursor;
        rig = read.rig;
        scatterBones(lod0.fragments, rig.bones);
        if (additionalLods) {
            for (let l = 0; l < additionalLods.length; l++) {
                const col = rig.lodBones[l];
                if (col) scatterBones(additionalLods[l]!.fragments, col);
            }
        }
    }

    // Material-class section (v11) — read LAST, mirroring the write order. One entry per
    // named slot, so it is addressed by the header's slot count and needs nothing from the
    // sections before it beyond their having been consumed.
    if (hasMaterialClasses && slots) {
        const read = readMaterialClassSection(bytes, cursor, slots.length);
        cursor = read.cursor;
        applyMaterialClassNames(slots, read.names);
    }

    // Eye section (v11) — read LAST, mirroring the write order.
    let eyes: EyeMeta | undefined;
    if (hasEyes) {
        const read = readEyeSection(view, cursor);
        cursor = read.cursor;
        eyes = read.eyes;
    }

    // Parts section (v12) — read LAST, mirroring the write order.
    let parts: VxlV3Part[] | undefined;
    if (hasParts) {
        const read = readPartsSection(view, bytes, cursor);
        cursor = read.cursor;
        parts = read.parts;
    }

    // The palette-index column existed only to resolve the two sections above.
    if (needPalIdx) {
        for (const f of lod0.fragments) f.leaves.palIdx = null;
    }

    return {
        minVoxelSize,
        maxVoxelSize,
        physicsGridStep,
        bounds,
        useAtlas,
        fragments: lod0.fragments,
        ...(additionalLods && additionalLods.length > 0 ? { additionalLods } : {}),
        ...(paletteEmissive ? { paletteEmissive } : {}),
        ...(slots && slots.length > 0 ? { slots } : {}),
        ...(rig ? { rig } : {}),
        ...(eyes ? { eyes } : {}),
        ...(parts && parts.length > 0 ? { parts } : {}),
    };
}

/** Total leaves across decoded fragments — the length of that level's bone column. */
function countDecodedLeaves(fragments: readonly DecodedFragment[]): number {
    let n = 0;
    for (const f of fragments) n += f.leaves.count;
    return n;
}

/**
 * Spread one flat bone column across a level's fragments, in the order they were
 * written. Each LeafBuffer gets its own `bone` view so the mesh builder can group faces
 * by owning joint without touching the rig again.
 */
function scatterBones(fragments: readonly DecodedFragment[], column: Uint8Array): void {
    let offset = 0;
    for (const f of fragments) {
        const buf = f.leaves;
        buf.bone = column.subarray(offset, offset + buf.count);
        offset += buf.count;
    }
}

// ─── Color helpers ────────────────────────────────────────────────────────
//
// v5 encodes colors as 12-bit RGB444 cells (`packRgb444`) to match the runtime's
// 4096-color output; v3/v4 stored RGB565, which the decoder converts to the same
// cell (`rgb565ToCell`) so legacy files render unchanged.

function rgb565ToRgb888(rgb565: number): { r: number; g: number; b: number } {
    const ri = (rgb565 >> 11) & 0x1F;
    const gi = (rgb565 >> 5) & 0x3F;
    const bi = rgb565 & 0x1F;
    // Bit-replicate for slightly better dequantization than naive divide.
    return {
        r: ((ri << 3) | (ri >> 2)) / 255,
        g: ((gi << 2) | (gi >> 4)) / 255,
        b: ((bi << 3) | (bi >> 2)) / 255,
    };
}

/** v3/v4 back-compat: an RGB565 palette entry → the 12-bit RGB444 cell the old decoder
 *  produced (565→888→packRgb444), so legacy files render byte-identically. */
function rgb565ToCell(rgb565: number): number {
    const { r, g, b } = rgb565ToRgb888(rgb565);
    return packRgb444(r, g, b);
}
