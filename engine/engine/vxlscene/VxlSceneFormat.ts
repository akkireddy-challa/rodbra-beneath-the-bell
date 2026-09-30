/**
 * VxlScene binary container format (design §4).
 *
 * Encodes/decodes a VxlSceneWorld — chunked voxel data with greedy-mesh LOD
 * hints and optional per-chunk trimesh colliders — into a compact binary blob.
 *
 * v4 (current) stores each chunk's records as byte-aligned COLUMNS (Structure-of-
 * Arrays on disk), indexes colors through a world RGB444 palette, quantizes
 * named-trimesh verts to a seam-safe integer lattice, and DELTA-codes the gx/gy/gz
 * position columns (consecutive diff — the greedy sweep order makes these tiny;
 * w/h extents stay plain). Chunk blobs are RAW (the whole container is compressed
 * ONCE at rest/transport, so a single coherent gzip replaces v3's redundant per-chunk
 * gzip). On a real 1 km level this is ~69% smaller than the v3 layout and decodes
 * with zero per-chunk gunzips. v2/v3 (interleaved, inline colors, float32 trimesh)
 * remain READABLE; only the encoder is updated, so an existing baked world must be
 * re-baked to shrink.
 *
 * Layout overview
 * ───────────────
 * v5 adds a per-chunk SURFACE TILE (a smooth:y heightfield) and stops storing the smooth ride
 * surface as per-cell displaced voxels — one height+colour per surface column instead of the
 * whole road shell at 3 disp bytes/cell (see `DecodedSurfaceTile`). v2/v3/v4 still decode.
 *
 * v6 adds an optional WORLD-LEVEL ground-mask section right after the palette
 * block: `uint8 hasGroundMask`, then (when 1) `float32 cellSize, uint32 width,
 * uint32 height`, the ground-type byte plane (u8·width·height) and the quantized
 * top-surface-Y plane (u16 LE·width·height). Drives the runtime cobble domes and
 * grass ground cover (see GroundMaskBaker.ts / GroundDetailSystem.ts).
 *
 * v7 adds an optional WORLD-LEVEL emissive-palette section immediately after the
 * v6 ground-mask section: `uint8 hasEmissivePalette`, then (when 1) `paletteCount`
 * bytes of per-palette-entry emissive strength (0..255), parallel to the palette
 * cells written in the v4 palette block. Decoded chunks carry the resolved RGB444
 * atlas CELL (not a palette index), so decode expands this into a 4096-entry
 * cell→strength LUT (`DecodedVxlSceneWorld.emissiveByCell`); when two palette
 * entries map to the same cell, the higher strength wins. Encode omits the section
 * (writes 0) when every strength is 0 or absent, so an all-zero-emissive file is
 * byte-identical to the same content encoded without it, past the version field.
 * Drives forged glow materials — rune inlays, crystal veins, lava seams — baked
 * directly into a dungeon level container.
 *
 * File wrapper (6 bytes, always plaintext):
 *   [0..3]  VXLSCENE_MAGIC uint32 LE
 *   [4]     format version uint8 (= 7; 2/3/4/5/6 still decode)
 *   [5]     compression flag uint8 (0 = raw chunks, 1 = per-chunk gzip)
 *
 * World header (variable, after wrapper):
 *   float32  chunkSize
 *   float32  minVoxelSize
 *   6×float32 bounds (minX, minY, minZ, maxX, maxY, maxZ)
 *   uint16   lodDistances count
 *   N×float32 lodDistances
 *   uint16   trimesh name count        (v3+; absent in v2)
 *   per name: uint16 byteLen + UTF-8 bytes
 *   --- v4 palette block ---
 *   uint8    coordsBytes (1 or 2; grid-coord column width = ceil for chunkSize/minVoxelSize cells)
 *   uint8    paletteIdxBytes (1 if ≤256 distinct cells, else 2)
 *   uint16   paletteCount
 *   paletteCount × uint16 (RGB444 atlas cells, in palette-index order)
 *
 * Chunk index:
 *   uint32   chunkCount
 *   per entry: int16 cx, int16 cy, int16 cz, uint32 offset, uint32 len
 *     (offset is byte position within the payload section)
 *
 * Payload: per-chunk blobs, RAW (gzip'd only when compression='gzip').
 *
 * Per-chunk blob (v4 columnar — every field is a contiguous column; gx/gy/gz are
 * delta-coded: each stores cur-prev wrapping at the column width, prev=0 at start):
 *   uint32 voxelCount
 *   gx[coordsBytes·n Δ], gy[·n Δ], gz[·n Δ], sizeLevel[1·n],
 *   colorIdx[paletteIdxBytes·n] (palette index), flags[1·n] (bit0=noCollider, bit1=hasDisp),
 *   disp[int8 · 3·(#hasDisp)]   (dx,dy,dz per displaced voxel, in voxel order)
 *
 *   uint8  lodHints count
 *   per LOD level:
 *     uint32 quadCount
 *     gx[·n Δ], gy[·n Δ], gz[·n Δ], w[·n] (stored w-1), h[·n] (stored h-1),
 *     axisDir[1·n] (axis bits[1:0], dir bit2, lodOffset bits[5:3], noCollider bit6),
 *     colorIdx[paletteIdxBytes·n], disp[int8·n]
 *
 *   uint8  namedTrimesh count
 *   per named trimesh:
 *     uint16 nameIdx                   (index into the world-header name table)
 *     uint32 vertCount, uint32 triCount
 *     qx[uint16·v], qy[·v], qz[·v]     (verts quantized to chunkSize/65535 lattice, chunk-local)
 *     triCount×3×(uint16 or uint32) indices
 *
 *   --- v5 surface tile (absent in v2/v3/v4 blobs) ---
 *   uint32 tileColCount
 *   localGx[coordsBytes·n Δ], localGz[·n Δ], gy[coordsBytes·n Δ], dy[int8·n], colorIdx[paletteIdxBytes·n]
 *     (one entry per smooth-surface column; topY = cy·chunkSize + ((gy+1)·127 + dy)·(minVoxelSize/127).
 *      gy + dy are stored separately, NOT the (gy+1)·127+dy product, so the height cannot overflow.)
 */

import { type SceneVoxel, type SceneQuad } from 'engine/vxlscene/SceneVoxTypes.js';
import { gzip, gunzip } from 'engine/gzip.js';
import { rgb888ToAtlasCell } from 'engine/vxlscene/atlasColor.js';
import type { GroundMaskData } from 'engine/vxlscene/GroundMaskBaker.js';

// ─── Public constants & types ─────────────────────────────────────────────────

/** "VLSC" little-endian uint32. */
export const VXLSCENE_MAGIC = 0x43_53_4c_56;

// v4 is the columnar layout: Structure-of-Arrays on disk + world RGB444 palette +
// quantized trimesh verts (see the `v4 column model` section). v2/v3 (interleaved,
// inline colors) stay READABLE so existing baked worlds keep loading; only the
// encoder is updated, so a re-bake is required for an asset to shrink.
// v6 adds an optional WORLD-LEVEL ground-mask section after the palette block
// (see the layout comment above the wrapper doc): a ground-type byte + quantized
// top-surface Y per 0.5 m cell, driving the runtime cobble domes / grass cover.
// v2–v5 still decode (their `groundMask` is null).
// v7 adds an optional WORLD-LEVEL emissive-palette section right after the v6
// ground-mask section: a strength byte (0..255) per palette entry, expanded at
// decode into a 4096-entry atlas-cell LUT (`emissiveByCell`) since decoded quads
// carry the resolved cell, not a palette index. v2–v6 still decode (`emissiveByCell`
// is null).
const FORMAT_VERSION = 7;

/**
 * Version 8: v7 + a declared SURFACE STEP.
 *
 * The smooth surface is stored as one column per (gX,gZ) cell, and `buildSurfaceField`
 * treats stored columns as `step` cells apart when it welds them into a mesh. A container
 * that decimated its own surface at bake time therefore CANNOT be read as v7: the reader
 * would assume spacing 1, fail to weld neighbours that are 2 cells apart, and leave holes
 * in the drivable surface — worse than the blockiness the decimation was buying.
 *
 * So the spacing becomes part of the file. Written only when it is not 1, which means
 * every existing bake and every full-detail bake stays byte-identical v7.
 */
const FORMAT_VERSION_SURFACE_STEP = 8;

/**
 * Version 9: v8 + an optional WORLD-LEVEL material-class section, written LAST in the
 * world header (after the v8 surface-step byte, which v9 therefore ALWAYS writes — even
 * when it is 1 — so decode stays linear):
 *
 *   uint8 hasClassPalette
 *   (when 1) uint8 nameCount, per name: uint8 byteLen + UTF-8 class name;
 *            paletteCount × uint8 class index (0 = none/matte, i+1 = names[i]),
 *            parallel to the palette cells.
 *
 * The class NAMES travel in the file (like the trimesh name table) so the format is
 * independent of any engine build's class ordering; decode expands the per-palette-entry
 * indices into a 4096-entry cell→classIdx LUT exactly as the v7 emissive section does.
 * Emitted ONLY when at least one palette entry carries a class, so an unclassified bake
 * stays byte-identical v7/v8. Drives the forged terrain material classes (rock cliffs on
 * the Phong tier, metal structures on the Physical tier — see `classByColor.ts` and
 * `VxlSceneRenderer`'s per-class batches).
 */
const FORMAT_VERSION_MATERIAL_CLASS = 9;
const COMPRESSION_NONE = 0;
const COMPRESSION_GZIP = 1;

/**
 * One trimesh-collider surface tagged with the source GLB object's node name.
 * Verts are CHUNK-LOCAL world coords (chunk-origin subtracted), same as the old
 * single per-chunk trimesh; the runtime adds the chunk origin back to recover
 * world space. Multiple per chunk when several flagged objects overlap a chunk.
 */
export interface NamedTrimesh {
    /** Source GLB node name (the key used in `objectTrimeshColliders`). */
    name: string;
    verts: Float32Array;
    indices: Uint32Array;
}

export interface VxlSceneChunk {
    cx: number; cy: number; cz: number;
    voxels: SceneVoxel[];
    lodHints: SceneQuad[][];
    /** Trimesh-collider surfaces grouped by source object name (empty = none). */
    namedTrimeshes: NamedTrimesh[];
}

// ─── Decoded (runtime) Structure-of-Arrays world ────────────────────────────
//
// `decodeVxlScene` returns these SoA types, NOT the object-based `VxlSceneChunk`
// above (which stays the BAKE/ENCODE side: produced by the bake, consumed by the
// encoder). A full world can hold tens of millions of voxels; one JS object per
// voxel (≈110 bytes incl. the nested `color` object) OOMs the tab at ~34M voxels
// (~3.8 GB). The SoA form is parallel typed arrays (~10 bytes/voxel, ~340 MB) with
// each color held inline as a 12-bit RGB444 atlas cell, decoding in tight loops.

/** Per-chunk voxel columns (one parallel array per field). */
export interface DecodedChunkVoxels {
    /** Number of voxels (valid prefix length of every column below). */
    count: number;
    /** Min-cell grid coords (min-cell units). */
    gx: Uint16Array; gy: Uint16Array; gz: Uint16Array;
    /** Edge length = minVoxelSize · 2^sizeLevel. */
    sizeLevel: Uint8Array;
    /** 12-bit RGB444 atlas cell = the displayed color (see atlasColor.ts); 0..4095. */
    colorIdx: Uint16Array;
    /** Bit0 = noCollider, bit1 = hasDisp. */
    flags: Uint8Array;
    /**
     * Sub-cell displacement, length `count*3` (dx,dy,dz per voxel) when ANY voxel
     * has bit1 set; otherwise null. Voxels without displacement read as (0,0,0).
     */
    disp: Int8Array | null;
}

/** One LOD level's greedy-quad columns. */
export interface DecodedChunkQuads {
    /** Number of quads. */
    count: number;
    /** Origin corner in min-cell grid coords. */
    gx: Uint16Array; gy: Uint16Array; gz: Uint16Array;
    /** Extents (≥1) along the two in-plane axes. */
    w: Uint16Array; h: Uint16Array;
    /** Packed: axis in bits [1:0], dir sign in bit 2 (0 ⇒ +1, 1 ⇒ −1), source object's lodOffset in bits [5:3], noCollider in bit 6. */
    axisDir: Uint8Array;
    /** 12-bit RGB444 atlas cell = the displayed color (see atlasColor.ts); 0..4095. */
    colorIdx: Uint16Array;
    /** Per-quad displacement along `axis` in min-cell units. */
    disp: Int8Array;
}

/**
 * Per-chunk smooth-surface heightfield (v5+). The smooth (smooth:y) ride surface used to be
 * stored as per-cell displaced voxels (the whole road shell — top + underside + walls — at 3
 * disp bytes each, of which only the topmost cell per column was ever rendered). It is now a
 * compact heightfield: ONE entry per surface column, carrying only the drivable-top height and
 * colour. `topY = cy*chunkSize + heightQ * (minVoxelSize / 127)`; `heightQ = (gy+1)*127 + dy`.
 */
export interface DecodedSurfaceTile {
    count: number;
    /** Chunk-local cell coords (0..cells-1). */
    localGx: Uint16Array; localGz: Uint16Array;
    /** Chunk-local cell index of the drivable-top cell (0..cells-1) and its sub-cell offset (-127..127).
     *  Together: topY = cy*chunkSize + ((gy+1)*127 + dy) * (minVoxelSize/127). Stored as gy + dy
     *  (NOT the (gy+1)*127+dy product) so it cannot overflow uint16 at large cells-per-chunk. */
    gy: Uint16Array; dy: Int8Array;
    /** 12-bit RGB444 atlas cell (resolved through the palette), like voxels/quads. */
    colorIdx: Uint16Array;
}

export interface DecodedChunk {
    cx: number; cy: number; cz: number;
    voxels: DecodedChunkVoxels;
    lodHints: DecodedChunkQuads[];
    /** Trimesh-collider surfaces grouped by source object name (empty = none). */
    namedTrimeshes: NamedTrimesh[];
    /**
     * Smooth-surface heightfield (v5+ bakes). Null/absent for v2/v3/v4, where the smooth
     * surface lives in `voxels` as displaced cells. Optional so hand-built chunks (tests) and
     * older decode paths need not set it; consumers treat absent the same as null.
     */
    surfaceTile?: DecodedSurfaceTile | null;
}

export interface DecodedVxlSceneWorld {
    chunkSize: number;
    minVoxelSize: number;
    bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
    lodDistances: number[];
    chunks: DecodedChunk[];
    /**
     * Spacing, in min-cells, between the surface columns this container actually stores
     * (v8; 1 for every older file, which stores every column).
     *
     * The surface mesh builder MUST weld at this pitch or coarser — a pre-decimated
     * container read at pitch 1 leaves its columns unconnected, which is holes in the
     * drivable surface rather than a coarser one.
     */
    surfaceStep: number;
    /**
     * World-level ground-type mask (v6+; null/absent for older files or bakes
     * without typed ground objects). Grid origin is (bounds.minX, bounds.minZ).
     */
    groundMask?: GroundMaskData | null;
    /**
     * World-level emissive-strength LUT (v7+; null/absent for older files or bakes
     * with no emissive palette). Indexed by the 12-bit RGB444 atlas CELL — the same
     * value stored inline in every `colorIdx`/`cells` column below — so a renderer
     * resolves a voxel/quad's emissive strength with one array lookup, no palette-
     * index bookkeeping. Length is always 4096 (every possible RGB444 cell) when set.
     */
    emissiveByCell?: Uint8Array | null;
    /**
     * World-level material-class LUT (v9+; null/absent for older files or unclassified
     * bakes). Indexed by the RGB444 atlas cell like `emissiveByCell`; the value is
     * 0 for matte/none, or i+1 for `materialClassNames[i]`. Always length 4096 when set.
     */
    materialClassByCell?: Uint8Array | null;
    /** The class names `materialClassByCell` indexes into (v9+; set together with it). */
    materialClassNames?: string[] | null;
}

/**
 * Per-bake aggregate counts. Populated by `bakeSceneFromTriangles` so callers can
 * fill their result stats WITHOUT iterating a `chunks` array — essential for the
 * streaming bake, whose `chunks` is empty (every chunk was streamed out and dropped).
 */
export interface VxlSceneTotals {
    /** Number of non-empty chunks emitted (= chunk index entries in the encoded file). */
    nonEmptyChunkCount: number;
    /** Total voxel count summed across all chunks (LOD0 leaves). */
    totalVoxels: number;
    /** Total LOD0 greedy-quad count summed across all chunks. */
    totalLod0Quads: number;
    /** Total trimesh-collider triangles baked across all chunks. */
    totalTrimeshTris: number;
    /** Approximate total bytes of trimesh data across all chunks (verts float32 + indices). */
    totalTrimeshBytes: number;
    /**
     * Diagnostic histogram: number of NON-EMPTY chunks baked at each LOD offset
     * (key = the chunk's finest-overlapping-object offset; 0 = finest/minVoxelSize).
     * Lets the entry log the adaptive-resolution distribution so per-chunk behaviour
     * is observable in the live bake instead of inferred.
     */
    chunksByOffset: Record<number, number>;
    /** Diagnostic histogram: total voxels emitted by chunks at each LOD offset. */
    voxelsByOffset: Record<number, number>;
}

export interface VxlSceneWorld {
    chunkSize: number;
    minVoxelSize: number;
    bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
    lodDistances: number[];
    chunks: VxlSceneChunk[];
    /**
     * Per-bake aggregates. Always set by `bakeSceneFromTriangles`. Optional on the
     * type so hand-built worlds (tests, fixtures) need not provide it; the encoder
     * never reads it (it re-derives everything it needs from the chunk stream).
     */
    totals?: VxlSceneTotals;
    /** Optional v6 ground mask (see DecodedVxlSceneWorld.groundMask). */
    groundMask?: GroundMaskData | null;
    /**
     * Optional v7 emissive strengths (0..255), keyed by RGB444 atlas CELL value —
     * NOT palette index, since the encoder's palette-index assignment isn't fixed
     * until `finish()` (colors register into the palette as chunks stream in). The
     * encoder resolves this map against the final palette order at `finish()`; a
     * bake typically derives cell keys from its own emissive colors via
     * `rgb888ToAtlasCell`. Entries for cells absent from this world's content are
     * simply unused. See `DecodedVxlSceneWorld.emissiveByCell` for the decode-side
     * 4096-entry cell→strength LUT this collapses into.
     */
    emissiveByCell?: Map<number, number> | null;
    /**
     * Optional v9 material-class names keyed by RGB444 atlas CELL (same keying and
     * same finish()-time palette resolution as `emissiveByCell`; a bake derives it
     * from `classByColor.ts`'s `applyClassByColor`). Entries for cells absent from
     * this world's content are unused; an empty/absent map keeps the file v7/v8.
     */
    materialClassByCell?: Map<number, string> | null;
}

export interface VxlSceneEncodeOptions {
    compression?: 'none' | 'gzip';
}

/**
 * Options for `decodeVxlScene`. All fields optional and default to a full,
 * lossless decode — so existing callers and the on-disk format are unchanged.
 */
export interface VxlSceneDecodeOptions {
    /**
     * Memory-bounded "lite" decode for oversized baked worlds. When > 0, the
     * decoder drops the first `skipLodLevels` (finest) LOD-HINT levels, keeping only
     * the coarser levels re-indexed so the old level `skipLodLevels` becomes
     * `lodHints[0]`; the world's `lodDistances` is shifted to stay parallel with the
     * kept levels. The per-voxel columns are ALWAYS decoded — they carry the
     * displaced (smooth:y) ride surface the renderer pins at every distance, so
     * dropping them would silently flatten smooth roads/pistes into voxel steps.
     *
     * This avoids decoding the densest greedy-mesh LOD for very large levels that
     * would otherwise OOM the tab. The first `skipLodLevels` LOD-hint byte ranges
     * are PARSED but never allocated.
     *
     * 0 / undefined ⇒ full decode of every LOD level.
     */
    skipLodLevels?: number;
}

/** World-level metadata the streaming encoder needs before any chunk arrives. */
export interface VxlSceneHeaderInfo {
    chunkSize: number;
    minVoxelSize: number;
    bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
    lodDistances: number[];
    /** Optional v6 ground mask, written into the world header when present. */
    groundMask?: GroundMaskData | null;
    /** Optional v7 emissive-strength-by-cell map (see `VxlSceneWorld.emissiveByCell`). */
    emissiveByCell?: Map<number, number> | null;
    /** Optional v9 material-class-by-cell map (see `VxlSceneWorld.materialClassByCell`). */
    materialClassByCell?: Map<number, string> | null;
    /**
     * Spacing, in min-cells, between the surface columns this container stores (v8).
     * 1 = every column, the normal bake. A coarser value is what a pre-decimated mobile
     * variant declares so the reader welds its columns at the right pitch.
     */
    surfaceStep?: number;
}

/**
 * Incremental, memory-bounded VxlScene encoder. Encodes + gzips each chunk's blob
 * on arrival and retains only the COMPACT (gzipped) bytes — never the chunk's JS
 * objects (colors are inline RGB444, so there is no palette). Peak memory is therefore
 * bounded by the final file size (the compact blobs), not by the live chunk count, which is what
 * lets a 1024 m / 0.0625 m bake stream-encode without accumulating tens of millions
 * of voxel/quad objects in the heap.
 */
export interface VxlSceneEncoder {
    /**
     * Encode + (optionally) gzip one chunk and store the compact blob + coord + size.
     * After it resolves the caller may drop the chunk so it is GC'd.
     */
    addChunk(chunk: VxlSceneChunk): Promise<void>;
    /** Assemble wrapper + header + index + concatenated blobs into one buffer. */
    finish(): Promise<Uint8Array>;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Check whether a buffer's first four bytes match the VXLSCENE magic. */
export function isVxlScene(buf: ArrayBuffer): boolean {
    if (buf.byteLength < 4) return false;
    return new DataView(buf, 0, 4).getUint32(0, true) === VXLSCENE_MAGIC;
}

// ─── v4 column model ──────────────────────────────────────────────────────────
//
// v4 stores each chunk's records as byte-aligned COLUMNS (Structure-of-Arrays on
// disk) instead of v3's interleaved records, with colors indexed into a world-level
// RGB444 palette and named-trimesh verts quantized to a seam-safe int lattice. The
// columnar layout + 1-byte palette index + 1-byte grid coords are what let DEFLATE
// collapse the now-contiguous low-entropy streams (a real .vwld shrinks ~60%), and
// the raw (un-gzipped) chunk blobs let a single transport/at-rest gzip do all the
// compression instead of the redundant per-chunk gzip v3 used.
//
// The streaming encoder converts each chunk to compact typed-array columns on
// arrival (dropping the SceneVoxel/SceneQuad objects) and registers its colors.
// The palette's final size — hence the 1-vs-2-byte index width — is only known at
// `finish`, so the per-chunk blobs are encoded there in one pass over the columns.

/** Min-cells along a chunk axis ⇒ bytes per grid coord (1 for chunks ≤256 cells/axis). */
function coordsBytesFor(chunkSize: number, minVoxelSize: number): 1 | 2 {
    const cells = Math.round(chunkSize / Math.max(minVoxelSize, 1e-9));
    return cells > 255 ? 2 : 1;
}

/**
 * Quantization step for named-trimesh verts. `chunkSize / 65535` keeps every chunk
 * origin (a multiple of chunkSize) exactly on the lattice, so a world vertex shared
 * across adjacent chunks quantizes IDENTICALLY in each — no seam cracks on the
 * ski/vehicle collision path. The collider baker clips verts to [0,chunkSize]
 * (`clipTrimeshToChunk`), so unsigned uint16 covers the full local range.
 */
function trimeshStepFor(chunkSize: number): number {
    return chunkSize / 65535;
}

function quantizeVert(local: number, step: number): number {
    const q = Math.round(local / step);
    return q < 0 ? 0 : q > 65535 ? 65535 : q;
}

interface TrimeshColumns {
    nameIdx: number; vertCount: number; triCount: number;
    qx: Uint16Array; qy: Uint16Array; qz: Uint16Array; indices: Uint32Array;
}
interface LodColumns {
    count: number;
    gx: Uint16Array; gy: Uint16Array; gz: Uint16Array; w: Uint16Array; h: Uint16Array;
    axisDir: Uint8Array; cells: Uint16Array; disp: Int8Array;
}
/** A chunk reduced to compact typed-array columns; colors held as RGB444 cells,
 *  remapped to palette indices only at `finish`. ~10 B/voxel, ~14 B/quad — bytes,
 *  not the ~110 B/record JS objects, so holding every chunk until finish is bounded
 *  by the raw file size (the cost of raw chunks enabling single-stream compression). */
interface ChunkColumns {
    cx: number; cy: number; cz: number;
    vCount: number;
    vgx: Uint16Array; vgy: Uint16Array; vgz: Uint16Array;
    vsize: Uint8Array; vcells: Uint16Array; vflags: Uint8Array; vdisp: Int8Array;
    lods: LodColumns[];
    trimeshes: TrimeshColumns[];
    /** v5 surface tile: one topmost cell per smooth:y column (cells in `tileCells`, RGB444). */
    tileCount: number;
    tileGx: Uint16Array; tileGz: Uint16Array; tileGy: Uint16Array; tileDy: Int8Array; tileCells: Uint16Array;
}

/** Convert one chunk to columns, registering its trimesh names + colors as a side effect. */
function chunkToColumns(
    chunk: VxlSceneChunk, chunkSize: number,
    nameToIdx: Map<string, number>, cellToIdx: Map<number, number>,
): ChunkColumns {
    const noteCell = (cell: number): void => { if (!cellToIdx.has(cell)) cellToIdx.set(cell, cellToIdx.size); };

    // Partition voxels: SMOOTH:Y cells (a Y-heightfield — disp present with dx=dz=0) become the
    // per-chunk SURFACE TILE, one TOPMOST cell per (gx,gz) column. This drops the road shell's
    // underside/walls (~58% of displaced cells, never rendered) and the 2 always-zero disp bytes.
    // Everything else — non-displaced voxels AND any non-Y displacement — stays in the v4 voxel
    // columns with full disp preserved (the tile is a Y-heightfield and cannot represent x/z
    // displacement). Level bakes drop non-displaced voxels upstream and use only smooth:y, so for
    // a smooth level the voxel column ends up empty and the whole ride surface lives in the tile.
    const surfCol = new Map<number, { gx: number; gz: number; gy: number; dy: number; heightQ: number; cell: number }>();
    const plain: SceneVoxel[] = [];
    for (const v of chunk.voxels) {
        if (v.disp !== null && v.disp.dx === 0 && v.disp.dz === 0) {
            // Rank columns by heightQ = (gy+1)·127 + dy (a JS number — no overflow); store gy + dy.
            const heightQ = (v.gy + 1) * 127 + v.disp.dy;
            const key = v.gx * 65536 + v.gz;
            const ex = surfCol.get(key);
            if (ex === undefined || heightQ > ex.heightQ) {
                const cell = rgb888ToAtlasCell(toR8(v.color.r), toR8(v.color.g), toR8(v.color.b));
                surfCol.set(key, { gx: v.gx, gz: v.gz, gy: v.gy, dy: v.disp.dy, heightQ, cell });
            }
        } else {
            plain.push(v);
        }
    }

    // Voxel columns (non-tile voxels — full disp preserved for any non-Y displacement).
    const vCount = plain.length;
    const vgx = new Uint16Array(vCount), vgy = new Uint16Array(vCount), vgz = new Uint16Array(vCount);
    const vsize = new Uint8Array(vCount), vcells = new Uint16Array(vCount), vflags = new Uint8Array(vCount);
    const vdispList: number[] = [];
    for (let i = 0; i < vCount; i++) {
        const v = plain[i]!;
        vgx[i] = v.gx; vgy[i] = v.gy; vgz[i] = v.gz; vsize[i] = v.sizeLevel;
        const cell = rgb888ToAtlasCell(toR8(v.color.r), toR8(v.color.g), toR8(v.color.b));
        vcells[i] = cell; noteCell(cell);
        const hasDisp = v.disp !== null ? 1 : 0;
        vflags[i] = (v.noCollider ? 1 : 0) | (hasDisp << 1);
        if (v.disp) vdispList.push(v.disp.dx, v.disp.dy, v.disp.dz);
    }

    // Surface tile columns, sorted by (gx,gz) so the delta-coded coord columns stay tiny.
    const tileEntries = [...surfCol.values()].sort((a, b) => a.gx - b.gx || a.gz - b.gz);
    const tileCount = tileEntries.length;
    const tileGx = new Uint16Array(tileCount), tileGz = new Uint16Array(tileCount);
    const tileGy = new Uint16Array(tileCount), tileDy = new Int8Array(tileCount), tileCells = new Uint16Array(tileCount);
    for (let i = 0; i < tileCount; i++) {
        const e = tileEntries[i]!;
        tileGx[i] = e.gx; tileGz[i] = e.gz; tileGy[i] = e.gy; tileDy[i] = e.dy; tileCells[i] = e.cell;
        noteCell(e.cell);
    }

    // LOD quads
    const lods: LodColumns[] = chunk.lodHints.map(level => {
        const n = level.length;
        const gx = new Uint16Array(n), gy = new Uint16Array(n), gz = new Uint16Array(n);
        const w = new Uint16Array(n), h = new Uint16Array(n);
        const axisDir = new Uint8Array(n), cells = new Uint16Array(n), disp = new Int8Array(n);
        for (let i = 0; i < n; i++) {
            const q = level[i]!;
            gx[i] = q.gx; gy[i] = q.gy; gz[i] = q.gz; w[i] = q.w; h[i] = q.h;
            axisDir[i] = (q.axis & 0x3) | ((q.dir === -1 ? 1 : 0) << 2) | (((q.offset ?? 0) & 0x7) << 3) | ((q.noCollider ? 1 : 0) << 6);
            const cell = rgb888ToAtlasCell(toR8(q.color.r), toR8(q.color.g), toR8(q.color.b));
            cells[i] = cell; noteCell(cell);
            disp[i] = q.disp;
        }
        return { count: n, gx, gy, gz, w, h, axisDir, cells, disp };
    });

    // Named trimeshes — quantize verts to the seam-safe lattice.
    const step = trimeshStepFor(chunkSize);
    const trimeshes: TrimeshColumns[] = chunk.namedTrimeshes.map(tm => {
        if (!nameToIdx.has(tm.name)) nameToIdx.set(tm.name, nameToIdx.size);
        const vertCount = tm.verts.length / 3;
        const qx = new Uint16Array(vertCount), qy = new Uint16Array(vertCount), qz = new Uint16Array(vertCount);
        for (let i = 0; i < vertCount; i++) {
            qx[i] = quantizeVert(tm.verts[i * 3]!, step);
            qy[i] = quantizeVert(tm.verts[i * 3 + 1]!, step);
            qz[i] = quantizeVert(tm.verts[i * 3 + 2]!, step);
        }
        return {
            nameIdx: nameToIdx.get(tm.name)!,
            vertCount, triCount: tm.indices.length / 3,
            qx, qy, qz, indices: Uint32Array.from(tm.indices),
        };
    });

    return {
        cx: chunk.cx, cy: chunk.cy, cz: chunk.cz,
        vCount, vgx, vgy, vgz, vsize, vcells, vflags, vdisp: Int8Array.from(vdispList),
        lods, trimeshes,
        tileCount, tileGx, tileGz, tileGy, tileDy, tileCells,
    };
}

/**
 * Create a streaming v4 encoder. Each chunk is reduced to compact columns on arrival
 * (objects dropped) and its colors registered into the growing world palette; the
 * per-chunk blobs are encoded at `finish`, once the palette size fixes the index width.
 */
export function createVxlSceneEncoder(
    header: VxlSceneHeaderInfo,
    opts?: VxlSceneEncodeOptions,
): VxlSceneEncoder {
    // v4 chunks are raw by default so a single at-rest/transport gzip compresses the
    // whole container (per-chunk gzip would defeat it). 'gzip' still per-chunk-gzips.
    const compression = opts?.compression ?? 'none';
    const compressionFlag = compression === 'gzip' ? COMPRESSION_GZIP : COMPRESSION_NONE;

    const cols: ChunkColumns[] = [];
    // Names + colors accumulate in first-encounter order; the assigned indices are
    // stable, and the ordered keys become the world-header tables at `finish`.
    const nameToIdx = new Map<string, number>();
    const cellToIdx = new Map<number, number>();

    return {
        async addChunk(chunk: VxlSceneChunk): Promise<void> {
            validateInt16(chunk.cx, 'cx');
            validateInt16(chunk.cy, 'cy');
            validateInt16(chunk.cz, 'cz');
            cols.push(chunkToColumns(chunk, header.chunkSize, nameToIdx, cellToIdx));
        },
        async finish(): Promise<Uint8Array> {
            const palette = [...cellToIdx.keys()];
            const paletteIdxBytes: 1 | 2 = palette.length <= 256 ? 1 : 2;
            const coordsBytes = coordsBytesFor(header.chunkSize, header.minVoxelSize);
            const stored: Array<{ cx: number; cy: number; cz: number; blob: Uint8Array }> = [];
            for (const c of cols) {
                const rawBlob = encodeChunkColumns(c, cellToIdx, coordsBytes, paletteIdxBytes);
                const blob = compressionFlag === COMPRESSION_GZIP ? await gzip(rawBlob) : rawBlob;
                stored.push({ cx: c.cx, cy: c.cy, cz: c.cz, blob });
            }
            // v7 emissive palette: resolve the caller's cell→strength map against the
            // FINAL palette order, which is only fixed now (after every chunk's colors
            // registered into `cellToIdx`). Left null (⇒ a lone 0 flag byte, no array)
            // when absent or every resolved strength is 0, so an all-zero-emissive file
            // stays byte-identical to the same content encoded without it past the
            // version field — see `assembleVxlScene`.
            const emissiveMap = header.emissiveByCell ?? null;
            let emissivePalette: Uint8Array | null = null;
            if (emissiveMap && emissiveMap.size > 0) {
                const bytes = new Uint8Array(palette.length);
                let anyNonZero = false;
                for (let i = 0; i < palette.length; i++) {
                    const raw = emissiveMap.get(palette[i]!) ?? 0;
                    const strength = raw < 0 ? 0 : raw > 255 ? 255 : Math.round(raw);
                    bytes[i] = strength;
                    if (strength !== 0) anyNonZero = true;
                }
                if (anyNonZero) emissivePalette = bytes;
            }
            // v9 material classes: resolve the caller's cell→className map against the
            // final palette order, same timing and same reasoning as the emissive block
            // above. Null (⇒ v7/v8 output) when absent or nothing matched a palette cell.
            const classMap = header.materialClassByCell ?? null;
            let classPalette: ClassPalette | null = null;
            if (classMap && classMap.size > 0) {
                const names: string[] = [];
                const idxOfName = new Map<string, number>();
                const idxByEntry = new Uint8Array(palette.length);
                let anyClassed = false;
                for (let i = 0; i < palette.length; i++) {
                    const name = classMap.get(palette[i]!);
                    if (name === undefined || name === '') continue;
                    let idx = idxOfName.get(name);
                    if (idx === undefined) {
                        if (names.length >= 255) continue; // uint8 index space; unreachable with the class budget
                        idx = names.length + 1;
                        names.push(name);
                        idxOfName.set(name, idx);
                    }
                    idxByEntry[i] = idx;
                    anyClassed = true;
                }
                if (anyClassed) classPalette = { names, idxByEntry };
            }
            return assembleVxlScene(header, stored, compressionFlag, [...nameToIdx.keys()], palette, paletteIdxBytes, coordsBytes, emissivePalette, classPalette);
        },
    };
}

/** Resolved v9 class section: in-file name table + one index byte per palette entry. */
interface ClassPalette {
    names: string[];
    /** Parallel to the palette: 0 = none/matte, i+1 = `names[i]`. */
    idxByEntry: Uint8Array;
}

/**
 * One-shot encoder. A thin wrapper over the streaming encoder: it feeds the whole
 * world's chunks through the same `addChunk`/`finish` path, so the output is
 * byte-identical to a streamed bake. Colors are inline RGB444 (no palette).
 */
export async function encodeVxlScene(world: VxlSceneWorld, opts?: VxlSceneEncodeOptions): Promise<Uint8Array> {
    const encoder = createVxlSceneEncoder(world, opts);
    for (const c of world.chunks) await encoder.addChunk(c);
    return encoder.finish();
}

/**
 * Assemble the final buffer from the (already-encoded, already-compressed) chunk
 * blobs + header. Shared by both the streaming and one-shot encoders so
 * the byte layout is defined in exactly one place. Memory here is the concatenated
 * compact blobs (≈ final file size) — the bounded part of stream-encoding.
 */
const GB = 2 ** 30;
/** A `.vwld` is one contiguous `Uint8Array`; past ~2 GB allocation fails outright
 *  (`Array buffer allocation failed`). Guard below that so a too-fine voxel size
 *  over a large, heavily trimesh-collided level fails with an actionable message
 *  instead of a raw OOM. A normal bake is MB-scale. */
const MAX_VXLSCENE_BUFFER_BYTES = Math.floor(1.5 * GB);

function assembleVxlScene(
    header: VxlSceneHeaderInfo,
    stored: ReadonlyArray<{ cx: number; cy: number; cz: number; blob: Uint8Array }>,
    compressionFlag: number,
    names: string[],
    palette: number[],
    paletteIdxBytes: number,
    coordsBytes: number,
    emissivePalette: Uint8Array | null,
    classPalette: ClassPalette | null,
): Uint8Array {
    // Pre-encode trimesh names to UTF-8 so the name-table byte size is known up front.
    const nameBytes = names.map(n => new TextEncoder().encode(n));
    // World header size:
    //   float32 chunkSize + float32 minVoxelSize = 8
    //   6 × float32 bounds = 24
    //   uint16 lodDistances count = 2
    //   N × float32 = N * 4
    //   uint16 name count = 2
    //   per name: uint16 byteLen (2) + UTF-8 bytes
    //   v4 palette block: uint8 coordsBytes (1) + uint8 paletteIdxBytes (1)
    //                   + uint16 paletteCount (2) + paletteCount × uint16 cells
    const lodCount = header.lodDistances.length;
    let nameTableSize = 2;
    for (const nb of nameBytes) nameTableSize += 2 + nb.byteLength;
    const paletteBlockSize = 1 + 1 + 2 + palette.length * 2;
    // v6 ground-mask section: uint8 hasGroundMask; when present, float32 cellSize +
    // uint32 width + uint32 height, then the type plane (u8·n) and topY plane (u16·n)
    // as separate SoA planes (long uniform runs — the at-rest gzip crushes them).
    const mask = header.groundMask ?? null;
    const maskCells = mask ? mask.width * mask.height : 0;
    const groundMaskSize = 1 + (mask ? 4 + 4 + 4 + maskCells + maskCells * 2 : 0);
    // v7 emissive-palette section: uint8 hasEmissivePalette; when present, one
    // strength byte per palette entry (parallel to the palette cells above).
    const emissiveSize = 1 + (emissivePalette ? emissivePalette.length : 0);
    // v8 surface-step section: one byte, present only when the surface is pre-decimated —
    // or when v9's class section follows it, since v9 ALWAYS writes the step byte so the
    // class section sits at a fixed place after it.
    const surfaceStep = Math.max(1, Math.round(header.surfaceStep ?? 1));
    const hasClasses = classPalette !== null;
    const emitSurfaceStep = surfaceStep > 1 || hasClasses;
    const surfaceStepSize = emitSurfaceStep ? 1 : 0;
    // v9 material-class section: flag + name table + one index byte per palette entry.
    const classNameBytes = classPalette ? classPalette.names.map(n => new TextEncoder().encode(n)) : [];
    let classSectionSize = 0;
    if (hasClasses) {
        classSectionSize = 1 + 1 + palette.length;
        for (const nb of classNameBytes) classSectionSize += 1 + nb.byteLength;
    }
    const worldHeaderSize = 8 + 24 + 2 + lodCount * 4 + nameTableSize + paletteBlockSize + groundMaskSize + emissiveSize + surfaceStepSize + classSectionSize;

    // Chunk index: uint32 count + count * (int16×3 + uint32×2) = count * (6+8) = count * 14
    const chunkCount = stored.length;
    const indexEntrySize = 14; // 3×int16(6) + offset uint32(4) + len uint32(4)
    const indexSize = 4 + chunkCount * indexEntrySize;

    // Payload size
    let payloadSize = 0;
    for (const s of stored) payloadSize += s.blob.byteLength;

    const bodySize = worldHeaderSize + indexSize + payloadSize;

    // Full output: 6-byte wrapper + body.
    const totalSize = 6 + bodySize;
    if (totalSize > MAX_VXLSCENE_BUFFER_BYTES) {
        throw new Error(
            `Baked .vwld would be ${(totalSize / GB).toFixed(2)} GB across ${chunkCount} chunks — ` +
            `exceeds the ${(MAX_VXLSCENE_BUFFER_BYTES / GB).toFixed(1)} GB single-buffer limit. ` +
            `Coarsen the voxel size (raise minVoxelSize) or reduce trimesh-collider coverage / object count.`,
        );
    }
    let out: Uint8Array;
    try {
        out = new Uint8Array(totalSize);
    } catch {
        throw new Error(
            `Failed to allocate ${(totalSize / GB).toFixed(2)} GB for the .vwld buffer (${chunkCount} chunks) — out of memory. ` +
            `Coarsen the voxel size (raise minVoxelSize) or reduce trimesh-collider coverage / object count.`,
        );
    }
    const view = new DataView(out.buffer);

    // Wrapper
    view.setUint32(0, VXLSCENE_MAGIC, true);
    out[4] = hasClasses ? FORMAT_VERSION_MATERIAL_CLASS
        : emitSurfaceStep ? FORMAT_VERSION_SURFACE_STEP : FORMAT_VERSION;
    out[5] = compressionFlag;

    let cur = 6;

    // World header
    view.setFloat32(cur, header.chunkSize, true); cur += 4;
    view.setFloat32(cur, header.minVoxelSize, true); cur += 4;
    view.setFloat32(cur, header.bounds.minX, true); cur += 4;
    view.setFloat32(cur, header.bounds.minY, true); cur += 4;
    view.setFloat32(cur, header.bounds.minZ, true); cur += 4;
    view.setFloat32(cur, header.bounds.maxX, true); cur += 4;
    view.setFloat32(cur, header.bounds.maxY, true); cur += 4;
    view.setFloat32(cur, header.bounds.maxZ, true); cur += 4;
    view.setUint16(cur, lodCount, true); cur += 2;
    for (const d of header.lodDistances) {
        view.setFloat32(cur, d, true); cur += 4;
    }

    // Trimesh name table
    view.setUint16(cur, nameBytes.length, true); cur += 2;
    for (const nb of nameBytes) {
        view.setUint16(cur, nb.byteLength, true); cur += 2;
        out.set(nb, cur); cur += nb.byteLength;
    }

    // v4 palette block: coordsBytes, paletteIdxBytes, then the RGB444 cells in index order.
    out[cur] = coordsBytes; cur += 1;
    out[cur] = paletteIdxBytes; cur += 1;
    view.setUint16(cur, palette.length, true); cur += 2;
    for (const cell of palette) { view.setUint16(cur, cell, true); cur += 2; }

    // v6 ground-mask section (flag + optional SoA planes).
    out[cur] = mask ? 1 : 0; cur += 1;
    if (mask) {
        view.setFloat32(cur, mask.cellSize, true); cur += 4;
        view.setUint32(cur, mask.width, true); cur += 4;
        view.setUint32(cur, mask.height, true); cur += 4;
        out.set(mask.types, cur); cur += maskCells;
        for (let i = 0; i < maskCells; i++) { view.setUint16(cur, mask.topY[i]!, true); cur += 2; }
    }

    // v7 emissive-palette section (flag + optional per-palette-entry strength
    // bytes, parallel to the palette cells written above).
    out[cur] = emissivePalette ? 1 : 0; cur += 1;
    if (emissivePalette) {
        out.set(emissivePalette, cur); cur += emissivePalette.length;
    }

    // v8 surface step — after the emissive section, so a v7 reader that stops there is
    // unaffected by its absence. v9 always writes it (see the class-section comment above).
    if (emitSurfaceStep) { out[cur] = Math.min(255, surfaceStep); cur += 1; }

    // v9 material-class section (flag + in-file name table + one index byte per palette
    // entry, parallel to the palette cells above).
    if (hasClasses) {
        out[cur] = 1; cur += 1;
        out[cur] = classNameBytes.length; cur += 1;
        for (const nb of classNameBytes) {
            out[cur] = nb.byteLength; cur += 1;
            out.set(nb, cur); cur += nb.byteLength;
        }
        out.set(classPalette!.idxByEntry, cur); cur += palette.length;
    }

    // Chunk index
    view.setUint32(cur, chunkCount, true); cur += 4;

    // First pass: write index entries (payload starts after the index)
    const payloadStart = cur + chunkCount * indexEntrySize;
    let runningOffset = 0;
    for (const s of stored) {
        view.setInt16(cur, s.cx, true); cur += 2;
        view.setInt16(cur, s.cy, true); cur += 2;
        view.setInt16(cur, s.cz, true); cur += 2;
        view.setUint32(cur, runningOffset, true); cur += 4;
        view.setUint32(cur, s.blob.byteLength, true); cur += 4;
        runningOffset += s.blob.byteLength;
    }

    // Second pass: write payloads
    let writePos = payloadStart;
    for (const s of stored) {
        out.set(s.blob, writePos);
        writePos += s.blob.byteLength;
    }

    return out;
}

export async function decodeVxlScene(
    bytes: Uint8Array,
    opts?: VxlSceneDecodeOptions,
): Promise<DecodedVxlSceneWorld> {
    if (bytes.byteLength < 6) throw new Error('VxlScene buffer too small');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    if (view.getUint32(0, true) !== VXLSCENE_MAGIC) throw new Error('VxlScene magic mismatch');
    const version = bytes[4]!;
    // v4 = columnar layout + world RGB444 palette + quantized trimesh verts. v3 adds
    // the trimesh name table + per-blob name index; v2 (single unnamed per-chunk
    // trimesh) is still read so live v2/v3 worlds keep loading — re-bake to shrink.
    if (version < 2 || version > FORMAT_VERSION_MATERIAL_CLASS) {
        throw new Error(`VxlScene unsupported version: ${version} (expected 2-${FORMAT_VERSION_MATERIAL_CLASS})`);
    }
    const compressionFlag = bytes[5];

    // Clamp to a sane non-negative integer; 0 / undefined ⇒ full decode.
    const skipLodLevels = Math.max(0, Math.floor(opts?.skipLodLevels ?? 0));

    let cur = 6;

    // World header
    const chunkSize = view.getFloat32(cur, true); cur += 4;
    const minVoxelSize = view.getFloat32(cur, true); cur += 4;
    const bounds = {
        minX: view.getFloat32(cur, true), minY: view.getFloat32(cur + 4, true), minZ: view.getFloat32(cur + 8, true),
        maxX: view.getFloat32(cur + 12, true), maxY: view.getFloat32(cur + 16, true), maxZ: view.getFloat32(cur + 20, true),
    };
    cur += 24;
    const lodCount = view.getUint16(cur, true); cur += 2;
    const lodDistancesAll: number[] = [];
    for (let i = 0; i < lodCount; i++) {
        lodDistancesAll.push(view.getFloat32(cur, true)); cur += 4;
    }
    // Keep `lodDistances` parallel to the kept LOD-hint levels: when we skip the
    // N finest LOD levels, drop the first N distance thresholds too (clamped so at
    // least one remains, mirroring the "always keep ≥1 renderable LOD" rule).
    const lodDistances = skipLodLevels > 0 && lodDistancesAll.length > 1
        ? lodDistancesAll.slice(Math.min(skipLodLevels, lodDistancesAll.length - 1))
        : lodDistancesAll;

    // Trimesh name table (v3+). v2 had no table; names stays empty and per-chunk
    // decode falls back to the single-unnamed-trimesh layout.
    const trimeshNames: string[] = [];
    if (version >= 3) {
        const nameCount = view.getUint16(cur, true); cur += 2;
        const nameDecoder = new TextDecoder();
        for (let i = 0; i < nameCount; i++) {
            const byteLen = view.getUint16(cur, true); cur += 2;
            trimeshNames.push(nameDecoder.decode(bytes.subarray(cur, cur + byteLen)));
            cur += byteLen;
        }
    }

    // v4 palette block: coordsBytes, paletteIdxBytes, then the RGB444 cells in index
    // order. v2/v3 store the cell inline per record, so they carry no palette.
    let coordsBytes = 2, paletteIdxBytes = 2;
    const palette: number[] = [];
    if (version >= 4) {
        coordsBytes = bytes[cur]!; cur += 1;
        paletteIdxBytes = bytes[cur]!; cur += 1;
        const paletteCount = view.getUint16(cur, true); cur += 2;
        for (let i = 0; i < paletteCount; i++) { palette.push(view.getUint16(cur, true)); cur += 2; }
    }

    // v6 ground-mask section (flag + optional SoA planes). Older versions: null.
    let groundMask: GroundMaskData | null = null;
    if (version >= 6) {
        const hasMask = bytes[cur]!; cur += 1;
        if (hasMask === 1) {
            const cellSize = view.getFloat32(cur, true); cur += 4;
            const width = view.getUint32(cur, true); cur += 4;
            const height = view.getUint32(cur, true); cur += 4;
            const cells = width * height;
            const types = bytes.slice(cur, cur + cells); cur += cells;
            const topY = new Uint16Array(cells);
            for (let i = 0; i < cells; i++) { topY[i] = view.getUint16(cur, true); cur += 2; }
            groundMask = { cellSize, width, height, types, topY };
        }
    }

    // v7 emissive-palette section (flag + optional per-palette-entry strength
    // bytes). Expanded here into a 4096-entry ATLAS-CELL LUT: decoded voxels/quads
    // carry the resolved RGB444 cell (see `resolve` in `decodeChunkV4`), not a
    // palette index, so the LUT must be keyed the same way for an O(1) per-voxel
    // lookup at render time. If two palette entries map to the same cell (not
    // reachable through this encoder, which registers each cell once, but not
    // disallowed by the format), the higher strength wins — deterministic
    // regardless of which entry is encountered first. Older versions: null.
    let emissiveByCell: Uint8Array | null = null;
    if (version >= 7) {
        const hasEmissivePalette = bytes[cur]!; cur += 1;
        if (hasEmissivePalette === 1) {
            const lut = new Uint8Array(4096);
            for (let i = 0; i < palette.length; i++) {
                const strength = bytes[cur + i]!;
                const cell = palette[i]!;
                if (strength > lut[cell]!) lut[cell] = strength;
            }
            cur += palette.length;
            emissiveByCell = lut;
        }
    }

    // v8 declared surface step. Older containers store every column, i.e. 1.
    let surfaceStep = 1;
    if (version >= FORMAT_VERSION_SURFACE_STEP) {
        surfaceStep = Math.max(1, bytes[cur]!); cur += 1;
    }

    // v9 material-class section: in-file name table + per-palette-entry class index,
    // expanded into a 4096-entry cell→classIdx LUT exactly as the v7 emissive section
    // is. On the unreachable duplicate-cell case the higher index wins — deterministic
    // regardless of palette order, mirroring the emissive rule. Older versions: null.
    let materialClassByCell: Uint8Array | null = null;
    let materialClassNames: string[] | null = null;
    if (version >= FORMAT_VERSION_MATERIAL_CLASS) {
        const hasClassPalette = bytes[cur]!; cur += 1;
        if (hasClassPalette === 1) {
            const nameCount = bytes[cur]!; cur += 1;
            const classDecoder = new TextDecoder();
            const classNames: string[] = [];
            for (let i = 0; i < nameCount; i++) {
                const byteLen = bytes[cur]!; cur += 1;
                classNames.push(classDecoder.decode(bytes.subarray(cur, cur + byteLen)));
                cur += byteLen;
            }
            const lut = new Uint8Array(4096);
            for (let i = 0; i < palette.length; i++) {
                const idx = bytes[cur + i]!;
                const cell = palette[i]!;
                if (idx > lut[cell]!) lut[cell] = idx;
            }
            cur += palette.length;
            materialClassByCell = lut;
            materialClassNames = classNames;
        }
    }

    // Chunk index
    const chunkCount = view.getUint32(cur, true); cur += 4;
    const indexEntrySize = 14;
    const payloadStart = cur + chunkCount * indexEntrySize;

    const indexEntries: Array<{ cx: number; cy: number; cz: number; offset: number; len: number }> = [];
    for (let i = 0; i < chunkCount; i++) {
        const cx = view.getInt16(cur, true); cur += 2;
        const cy = view.getInt16(cur, true); cur += 2;
        const cz = view.getInt16(cur, true); cur += 2;
        const offset = view.getUint32(cur, true); cur += 4;
        const len = view.getUint32(cur, true); cur += 4;
        indexEntries.push({ cx, cy, cz, offset, len });
    }

    // Decode chunks into SoA columns (no per-voxel / per-quad objects).
    const chunks: DecodedChunk[] = [];
    for (const entry of indexEntries) {
        const start = payloadStart + entry.offset;
        const end = start + entry.len;
        let chunkBytes = bytes.subarray(start, end);
        if (compressionFlag === COMPRESSION_GZIP) {
            chunkBytes = await gunzip(chunkBytes);
        }
        chunks.push(version >= 4
            ? decodeChunkV4(chunkBytes, entry.cx, entry.cy, entry.cz, skipLodLevels, trimeshNames, palette, coordsBytes, paletteIdxBytes, trimeshStepFor(chunkSize), version)
            : decodeChunkBlobSoA(chunkBytes, entry.cx, entry.cy, entry.cz, skipLodLevels, version, trimeshNames));
    }

    return {
        chunkSize, minVoxelSize, bounds, lodDistances, chunks, surfaceStep, groundMask, emissiveByCell,
        materialClassByCell, materialClassNames,
    };
}

// ─── Color helper ───────────────────────────────────────────────────────────

/** Object-color channel (0..1) → 0..255 (the input to `rgb888ToAtlasCell`). */
function toR8(v: number): number {
    return Math.max(0, Math.min(255, Math.round(v * 255)));
}

// ─── Per-chunk blob encode/decode (v4 columnar) ───────────────────────────────

/**
 * Encode one chunk's columns into the v4 byte-aligned columnar blob. Each field is
 * written as a contiguous column (all gx, then all gy, …) so DEFLATE sees the
 * low-entropy runs v3's interleaving hid. Colors are 1- or 2-byte palette indices;
 * grid coords are `coordsBytes` wide; w/h are stored as w-1/h-1; trimesh verts are
 * the pre-quantized uint16 lattice coords. Layout is read back by `decodeChunkV4`.
 */
function encodeChunkColumns(
    c: ChunkColumns, cellToIdx: Map<number, number>,
    coordsBytes: number, paletteIdxBytes: number,
): Uint8Array {
    const parts: Uint8Array[] = [];
    const scratch = new ArrayBuffer(4);
    const sv = new DataView(scratch);
    const u32 = (n: number): void => { sv.setUint32(0, n, true); parts.push(new Uint8Array(scratch, 0, 4).slice()); };
    const u8 = (n: number): void => { parts.push(new Uint8Array([n & 0xff])); };

    // A column of `n` unsigned values at `bytes` width (1 or 2), LE.
    const colU = (vals: ArrayLike<number>, n: number, bytes: number, minus = 0): void => {
        const b = new Uint8Array(n * bytes);
        if (bytes === 1) for (let i = 0; i < n; i++) b[i] = (vals[i]! - minus) & 0xff;
        else { const dv = new DataView(b.buffer); for (let i = 0; i < n; i++) dv.setUint16(i * 2, (vals[i]! - minus) & 0xffff, true); }
        parts.push(b);
    };
    // Delta-coded column (consecutive diff, wrapping at the field width). Used ONLY for
    // gx/gy/gz: greedy sweep order makes consecutive positions close, so the gzip'd delta
    // stream is ~25% smaller than raw. Extents (w/h) are NOT delta-coded — they're not
    // spatially ordered, so delta there measured ~12% LARGER. Same byte width as colU, so
    // lite-decode column striding is unchanged. Decoded by prefix-sum in `readColUDelta`.
    const colUDelta = (vals: ArrayLike<number>, n: number, bytes: number): void => {
        const b = new Uint8Array(n * bytes);
        let prev = 0;
        if (bytes === 1) for (let i = 0; i < n; i++) { const v = vals[i]!; b[i] = (v - prev) & 0xff; prev = v; }
        else { const dv = new DataView(b.buffer); for (let i = 0; i < n; i++) { const v = vals[i]!; dv.setUint16(i * 2, (v - prev) & 0xffff, true); prev = v; } }
        parts.push(b);
    };
    // Raw byte column (already-typed arrays: Uint8/Int8/Uint16).
    const colBytes = (view: Uint8Array): void => { parts.push(view.slice()); };
    const cellCol = (cells: Uint16Array, n: number): void => {
        const idx = new Uint16Array(n);
        for (let i = 0; i < n; i++) idx[i] = cellToIdx.get(cells[i]!)!;
        colU(idx, n, paletteIdxBytes);
    };

    // Voxels
    u32(c.vCount);
    colUDelta(c.vgx, c.vCount, coordsBytes);
    colUDelta(c.vgy, c.vCount, coordsBytes);
    colUDelta(c.vgz, c.vCount, coordsBytes);
    colBytes(c.vsize);
    cellCol(c.vcells, c.vCount);
    colBytes(c.vflags);
    colBytes(new Uint8Array(c.vdisp.buffer, c.vdisp.byteOffset, c.vdisp.byteLength)); // disp (3 × #hasDisp i8)

    // LOD hints
    u8(c.lods.length);
    for (const l of c.lods) {
        u32(l.count);
        colUDelta(l.gx, l.count, coordsBytes);
        colUDelta(l.gy, l.count, coordsBytes);
        colUDelta(l.gz, l.count, coordsBytes);
        colU(l.w, l.count, coordsBytes, 1); // store w-1 (extents: not delta-coded)
        colU(l.h, l.count, coordsBytes, 1); // store h-1
        colBytes(l.axisDir);
        cellCol(l.cells, l.count);
        colBytes(new Uint8Array(l.disp.buffer, l.disp.byteOffset, l.disp.byteLength));
    }

    // Named trimeshes (quantized verts, columnar x/y/z).
    u8(c.trimeshes.length);
    for (const tm of c.trimeshes) {
        sv.setUint16(0, tm.nameIdx, true); parts.push(new Uint8Array(scratch, 0, 2).slice());
        u32(tm.vertCount);
        u32(tm.triCount);
        colU(tm.qx, tm.vertCount, 2);
        colU(tm.qy, tm.vertCount, 2);
        colU(tm.qz, tm.vertCount, 2);
        // Index width follows vertCount (2 bytes unless > 65535 verts).
        if (tm.vertCount <= 0xffff) {
            colU(tm.indices, tm.indices.length, 2);
        } else {
            const b = new Uint8Array(tm.indices.length * 4);
            const dv = new DataView(b.buffer);
            for (let i = 0; i < tm.indices.length; i++) dv.setUint32(i * 4, tm.indices[i]!, true);
            parts.push(b);
        }
    }

    // v5 surface tile (one topmost cell per smooth:y column). Coords + gy delta-coded like voxels;
    // dy is a raw int8 column; colour goes through the world palette. (gy + dy, not their product,
    // so the height never overflows at large cells-per-chunk.)
    u32(c.tileCount);
    colUDelta(c.tileGx, c.tileCount, coordsBytes);
    colUDelta(c.tileGz, c.tileCount, coordsBytes);
    colUDelta(c.tileGy, c.tileCount, coordsBytes);
    colBytes(new Uint8Array(c.tileDy.buffer, c.tileDy.byteOffset, c.tileDy.byteLength));
    cellCol(c.tileCells, c.tileCount);

    let total = 0;
    for (const p of parts) total += p.byteLength;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const p of parts) { out.set(p, pos); pos += p.byteLength; }
    return out;
}

/**
 * Decode one v4 columnar chunk blob into the SAME SoA `DecodedChunk` shape the v2/v3
 * decoder produces — `colorIdx` holds the resolved 12-bit RGB444 cell (palette index
 * mapped back through `palette`), so all downstream consumers are version-agnostic.
 * Trimesh verts are de-quantized from the uint16 lattice. Lite decode (skipLodLevels)
 * drops the voxel columns and the finest LOD levels by advancing past their columns
 * — column lengths are derivable from the per-chunk counts, except the voxel `disp`
 * column whose length is the popcount of `hasDisp` bits in the flags column.
 */
function decodeChunkV4(
    bytes: Uint8Array, cx: number, cy: number, cz: number,
    skipLodLevels: number, trimeshNames: string[],
    palette: number[], coordsBytes: number, paletteIdxBytes: number, trimeshStep: number,
    version: number,
): DecodedChunk {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let cur = 0;
    const rU32 = (): number => { const v = view.getUint32(cur, true); cur += 4; return v; };
    const rU8 = (): number => bytes[cur++]!;
    const rU16 = (): number => { const v = view.getUint16(cur, true); cur += 2; return v; };

    /** Read a column of `n` unsigned values at width `w` (1/2 B) into a Uint16Array, adding `plus`. */
    const readColU = (n: number, w: number, plus = 0): Uint16Array => {
        const out = new Uint16Array(n);
        if (w === 1) for (let i = 0; i < n; i++) out[i] = bytes[cur + i]! + plus;
        else for (let i = 0; i < n; i++) out[i] = view.getUint16(cur + i * 2, true) + plus;
        cur += n * w;
        return out;
    };
    /** Read a delta-coded column (prefix-sum, wrapping at width `w`) — inverse of `colUDelta`. */
    const readColUDelta = (n: number, w: number): Uint16Array => {
        const out = new Uint16Array(n);
        const mask = w === 1 ? 0xff : 0xffff;
        let prev = 0;
        if (w === 1) for (let i = 0; i < n; i++) { prev = (prev + bytes[cur + i]!) & mask; out[i] = prev; }
        else for (let i = 0; i < n; i++) { prev = (prev + view.getUint16(cur + i * 2, true)) & mask; out[i] = prev; }
        cur += n * w;
        return out;
    };
    const readColU8 = (n: number): Uint8Array => { const out = bytes.slice(cur, cur + n); cur += n; return out; };
    const readColI8 = (n: number): Int8Array => { const out = new Int8Array(n); for (let i = 0; i < n; i++) out[i] = view.getInt8(cur + i); cur += n; return out; };
    const resolve = (idx: Uint16Array, n: number): Uint16Array => {
        const cells = new Uint16Array(n);
        for (let i = 0; i < n; i++) cells[i] = palette[idx[i]!] ?? 0;
        return cells;
    };

    const lite = skipLodLevels > 0;

    // Voxels — ALWAYS decoded, even on the memory-bounded "lite" path. The per-voxel
    // columns ARE the displaced (smooth:y) ride surface: pinned fine detail the
    // renderer shows at EVERY distance and never LOD-toggles. Dropping them silently
    // flattened smooth roads/pistes into grid-aligned voxel steps on any world over
    // the size guard, so the lite path skips only LOD-HINT levels (below), never the
    // voxel columns. (The columns are small relative to the finest greedy-mesh LOD.)
    const voxelCount = rU32();
    let voxels: DecodedChunkVoxels;
    {
        const gx = readColUDelta(voxelCount, coordsBytes);
        const gy = readColUDelta(voxelCount, coordsBytes);
        const gz = readColUDelta(voxelCount, coordsBytes);
        const sizeLevel = readColU8(voxelCount);
        const colorIdx = resolve(readColU(voxelCount, paletteIdxBytes), voxelCount);
        const flags = readColU8(voxelCount);
        let nDisp = 0;
        for (let i = 0; i < voxelCount; i++) if (flags[i]! & 2) nDisp++;
        let disp: Int8Array | null = null;
        if (nDisp > 0) {
            disp = new Int8Array(voxelCount * 3);
            for (let i = 0, p = cur; i < voxelCount; i++) {
                if (flags[i]! & 2) { const o = i * 3; disp[o] = view.getInt8(p++); disp[o + 1] = view.getInt8(p++); disp[o + 2] = view.getInt8(p++); }
            }
        }
        cur += nDisp * 3;
        voxels = { count: voxelCount, gx, gy, gz, sizeLevel, colorIdx, flags, disp };
    }

    // LOD hints
    const lodLevelCount = rU8();
    const effectiveSkip = lite ? Math.min(skipLodLevels, Math.max(0, lodLevelCount - 1)) : 0;
    const perQuadBytes = coordsBytes * 5 + 1 + paletteIdxBytes + 1; // gx,gy,gz,w,h + axisDir + colorIdx + disp
    const lodHints: DecodedChunkQuads[] = [];
    for (let l = 0; l < lodLevelCount; l++) {
        const quadCount = rU32();
        if (l < effectiveSkip) { cur += quadCount * perQuadBytes; continue; }
        const gx = readColUDelta(quadCount, coordsBytes);
        const gy = readColUDelta(quadCount, coordsBytes);
        const gz = readColUDelta(quadCount, coordsBytes);
        const w = readColU(quadCount, coordsBytes, 1);
        const h = readColU(quadCount, coordsBytes, 1);
        const axisDir = readColU8(quadCount);
        const colorIdx = resolve(readColU(quadCount, paletteIdxBytes), quadCount);
        const disp = readColI8(quadCount);
        lodHints.push({ count: quadCount, gx, gy, gz, w, h, axisDir, colorIdx, disp });
    }

    // Named trimeshes — de-quantize verts from the uint16 lattice.
    const namedTrimeshes: NamedTrimesh[] = [];
    const tcount = rU8();
    for (let t = 0; t < tcount; t++) {
        const nameIdx = rU16();
        const vertCount = rU32();
        const triCount = rU32();
        const qx = readColU(vertCount, 2);
        const qy = readColU(vertCount, 2);
        const qz = readColU(vertCount, 2);
        const verts = new Float32Array(vertCount * 3);
        for (let i = 0; i < vertCount; i++) {
            verts[i * 3] = qx[i]! * trimeshStep;
            verts[i * 3 + 1] = qy[i]! * trimeshStep;
            verts[i * 3 + 2] = qz[i]! * trimeshStep;
        }
        const idxCount = triCount * 3;
        const indices = new Uint32Array(idxCount);
        if (vertCount <= 0xffff) for (let i = 0; i < idxCount; i++) { indices[i] = view.getUint16(cur, true); cur += 2; }
        else for (let i = 0; i < idxCount; i++) { indices[i] = view.getUint32(cur, true); cur += 4; }
        namedTrimeshes.push({ name: trimeshNames[nameIdx] ?? '', verts, indices });
    }

    // v5 surface tile (always decoded — it IS the smooth ride surface, needed at every distance).
    let surfaceTile: DecodedSurfaceTile | null = null;
    if (version >= 5) {
        const tileCount = rU32();
        const localGx = readColUDelta(tileCount, coordsBytes);
        const localGz = readColUDelta(tileCount, coordsBytes);
        const gyCol = readColUDelta(tileCount, coordsBytes);
        const dyCol = readColI8(tileCount);
        const colorIdx = resolve(readColU(tileCount, paletteIdxBytes), tileCount);
        surfaceTile = { count: tileCount, localGx, localGz, gy: gyCol, dy: dyCol, colorIdx };
    }

    return { cx, cy, cz, voxels, lodHints, namedTrimeshes, surfaceTile };
}

/**
 * Decode one chunk blob into Structure-of-Arrays columns. Reads the EXACT same
 * byte layout as `encodeChunkBlob` writes, but fills parallel typed arrays in
 * tight loops instead of allocating one `SceneVoxel`/`SceneQuad`/color object per
 * record. Each color is the 12-bit RGB444 atlas cell stored inline; it lands
 * verbatim in `colorIdx`, so no per-record color object is created.
 */
function decodeChunkBlobSoA(
    bytes: Uint8Array,
    cx: number, cy: number, cz: number,
    skipLodLevels: number,
    version: number,
    trimeshNames: string[],
): DecodedChunk {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let cur = 0;

    const readU8 = (): number => bytes[cur++]!;
    const readI8 = (): number => { const v = view.getInt8(cur); cur += 1; return v; };
    const readU16 = (): number => { const v = view.getUint16(cur, true); cur += 2; return v; };
    const readU32 = (): number => { const v = view.getUint32(cur, true); cur += 4; return v; };
    // Color = inline 12-bit RGB444 atlas cell (2 bytes).
    const colorBytes = 2;

    // Fixed quad-record byte width, used to ADVANCE past skipped LOD-hint levels
    // without allocating on a memory-bounded ("lite") decode.
    //   quad record = u16×5 (gx,gy,gz,w,h) + u8 axisDirPacked + color + int8 disp
    //               = 10 + 1 + colorBytes + 1.
    const quadRecordBytes = 10 + 1 + colorBytes + 1;

    const lite = skipLodLevels > 0;

    // Voxels — ALWAYS decoded, including on the memory-bounded "lite" path: the
    // per-voxel columns carry the displaced (smooth:y) ride surface the renderer
    // pins at every distance, so dropping them flattens smooth surfaces into voxel
    // steps. Allocate exact-size columns up front and fill them in one pass.
    const voxelCount = readU32();
    const gx = new Uint16Array(voxelCount);
    const gy = new Uint16Array(voxelCount);
    const gz = new Uint16Array(voxelCount);
    const sizeLevel = new Uint8Array(voxelCount);
    const colorIdx = new Uint16Array(voxelCount);
    const flagsArr = new Uint8Array(voxelCount);
    // Allocated eagerly (≈3 bytes/voxel); nulled at the end if no voxel is
    // displaced, so the SoA matches the on-disk "no displacement" shape.
    const dispArr = new Int8Array(voxelCount * 3);
    let anyDisp = false;
    for (let i = 0; i < voxelCount; i++) {
        gx[i] = readU16();
        gy[i] = readU16();
        gz[i] = readU16();
        sizeLevel[i] = readU8();
        colorIdx[i] = readU16();
        const flags = readU8();
        flagsArr[i] = flags;
        if ((flags & 2) !== 0) {
            anyDisp = true;
            const o = i * 3;
            dispArr[o] = readI8();
            dispArr[o + 1] = readI8();
            dispArr[o + 2] = readI8();
        }
    }
    const voxels: DecodedChunkVoxels = {
        count: voxelCount,
        gx, gy, gz, sizeLevel, colorIdx, flags: flagsArr,
        disp: anyDisp ? dispArr : null,
    };

    // LOD hints. In lite mode skip the `effectiveSkip` finest levels (advance past
    // their quad bytes without allocating) and keep the rest re-indexed so the old
    // level `effectiveSkip` becomes lodHints[0]. `effectiveSkip` is clamped to
    // `count - 1` so there is always ≥1 renderable LOD when count > 0.
    const lodLevelCount = readU8();
    const effectiveSkip = lite ? Math.min(skipLodLevels, Math.max(0, lodLevelCount - 1)) : 0;
    const lodHints: DecodedChunkQuads[] = [];
    for (let l = 0; l < lodLevelCount; l++) {
        const quadCount = readU32();
        if (l < effectiveSkip) {
            // Skip this level wholesale — advance past its fixed-size quad records.
            cur += quadCount * quadRecordBytes;
            continue;
        }
        const qgx = new Uint16Array(quadCount);
        const qgy = new Uint16Array(quadCount);
        const qgz = new Uint16Array(quadCount);
        const qw = new Uint16Array(quadCount);
        const qh = new Uint16Array(quadCount);
        const axisDir = new Uint8Array(quadCount);
        const qColorIdx = new Uint16Array(quadCount);
        const qDisp = new Int8Array(quadCount);
        for (let q = 0; q < quadCount; q++) {
            qgx[q] = readU16();
            qgy[q] = readU16();
            qgz[q] = readU16();
            qw[q] = readU16();
            qh[q] = readU16();
            // Packed axis+dir byte is stored verbatim (axis bits [1:0], dir bit 2).
            axisDir[q] = readU8();
            qColorIdx[q] = readU16();
            qDisp[q] = readI8();
        }
        lodHints.push({
            count: quadCount,
            gx: qgx, gy: qgy, gz: qgz, w: qw, h: qh,
            axisDir, colorIdx: qColorIdx, disp: qDisp,
        });
    }

    // Named trimeshes. v3: uint8 count, then per blob a uint16 nameIdx + geometry.
    // v2: a single uint8 presence flag + one unnamed trimesh → one nameless blob,
    // so v2 worlds keep their colliders but report no queryable names.
    const readTrimeshGeometry = (): { verts: Float32Array; indices: Uint32Array } => {
        const vertCount = readU32();
        const triCount = readU32();
        const idxBytes = vertCount <= 0xffff ? 2 : 4;
        const floatByteLen = vertCount * 3 * 4;
        const vertBytes = bytes.subarray(cur, cur + floatByteLen);
        const verts = new Float32Array(vertBytes.buffer.slice(vertBytes.byteOffset, vertBytes.byteOffset + floatByteLen));
        cur += floatByteLen;
        const indices = new Uint32Array(triCount * 3);
        for (let i = 0; i < triCount * 3; i++) {
            indices[i] = idxBytes === 2 ? readU16() : readU32();
        }
        return { verts, indices };
    };

    const namedTrimeshes: NamedTrimesh[] = [];
    if (version >= 3) {
        const count = readU8();
        for (let i = 0; i < count; i++) {
            const nameIdx = readU16();
            const { verts, indices } = readTrimeshGeometry();
            namedTrimeshes.push({ name: trimeshNames[nameIdx] ?? '', verts, indices });
        }
    } else {
        const hasTrimesh = readU8();
        if (hasTrimesh) {
            const { verts, indices } = readTrimeshGeometry();
            namedTrimeshes.push({ name: '', verts, indices });
        }
    }

    // v2/v3 have no surface tile — the smooth surface (if any) is in the voxel columns.
    return { cx, cy, cz, voxels, lodHints, namedTrimeshes, surfaceTile: null };
}

// ─── Validation helpers ───────────────────────────────────────────────────────

function validateInt16(n: number, field: string): void {
    if (!Number.isInteger(n) || n < -32768 || n > 32767) {
        throw new Error(`VxlScene chunk coord ${field}=${n} out of int16 range`);
    }
}
