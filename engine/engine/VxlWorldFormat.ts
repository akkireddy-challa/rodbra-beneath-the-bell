/**
 * VWLD — Voxel World file format.
 *
 * Container for a chunked voxel world where each chunk's geometry is a
 * standalone VXL3 (v3 or v4) blob. Designed as a drop-in replacement for the
 * existing chunk-grid terrain (`VoxelTerrainSystem`): same chunk addressing
 * `(sx, sy, sz)` in fixed-meter chunks, same terrain-query semantics from the
 * outside. What changes is what's *inside* a chunk — instead of a uniform
 * `Uint16Array` of block IDs, the chunk's geometry is an octree-leaf VXL3
 * mesh with adaptive voxel sizes and optional baked LOD levels.
 *
 * LOD switching happens at chunk granularity, in the renderer, every frame.
 * Each chunk picks its own LOD based on distance to the camera; the chunk
 * itself doesn't know about LOD distances — those live in the runtime.
 *
 * Layout
 * ──────
 * Outer wrapper (5 B, ALWAYS plaintext so format-sniffing is cheap):
 *   off  size  field
 *   0    4     magic "VWLD" (0x56 0x57 0x4C 0x44)
 *   4    1     compressionId uint8 (0=raw body, 1=gzipped body)
 *
 * Body — starts at offset 5. Gzipped when compressionId=1, raw when 0.
 * In practice we write raw bodies: per-chunk VXL3 blobs do their own gzip
 * and there's almost nothing left to compress at the world level.
 *
 * Body header (32 B):
 *   off  size  field
 *   0    4     version uint32 LE (=1 or 2)
 *               v2 = chunks may carry an optional trimesh-collider blob
 *               (TMSH) alongside the VXL3 blob; index entry expands by 8 B.
 *   4    4     chunkSize float32 (meters per chunk axis, e.g. 16.0)
 *   8    24    worldBounds: 6 × float32 (minX, minY, minZ, maxX, maxY, maxZ)
 *               world bounds MUST be chunk-aligned (each axis a multiple of chunkSize)
 *
 * Chunk index header (4 B):
 *   off  size  field
 *   0    4     chunkCount uint32 LE
 *
 * Chunk index entries (v1: 16 B; v2: 24 B):
 *   off  size  field
 *   0    2     sx int16 LE (chunk X coord; signed so negative coords work)
 *   2    2     sy int16 LE
 *   4    2     sz int16 LE
 *   6    2     reserved
 *   8    4     vxlOffset uint32 LE (byte offset into payload section)
 *   12   4     vxlSize uint32 LE (length in bytes of this chunk's VXL3 blob)
 *   --- v2 only ---
 *   16   4     tcolOffset uint32 LE (offset of trimesh-collider blob, 0 if absent)
 *   20   4     tcolSize uint32 LE (length of trimesh-collider blob, 0 if absent)
 *
 * Payload (variable length):
 *   v1: concatenated standalone VXL3 files. Each chunk's payload starts with
 *       the 5-byte VXL3 wrapper followed by the chunk's body — meaning a
 *       slice of `payload[offset : offset + size]` decodes via
 *       `decodeVxlV3()` unchanged.
 *   v2: VXL3 blobs interleaved with optional TMSH (trimesh-collider) blobs.
 *       Each chunk's VXL3 blob starts at its vxlOffset; its TMSH blob (if
 *       present) starts at its tcolOffset. Layout order is implementation-
 *       defined (the encoder writes vxl-then-tcol per chunk for cache
 *       locality, but readers MUST use the index offsets, not assume).
 *
 * TMSH per-chunk blob layout (see `encodeTrimeshBlob`):
 *   0    4     magic "TMSH" (0x48 0x53 0x4D 0x54 — little-endian uint32)
 *   4    4     vertexCount uint32 LE
 *   8    4     triangleCount uint32 LE
 *   12   vertexCount × 6  vertices: 3 × uint16 LE per vertex, quantized
 *                          chunk-local — value `v` maps to `v / 65535 ×
 *                          chunkSize` (range `[0, chunkSize]`).
 *   ...  triangleCount × idxBytes × 3  indices: uint16 LE when
 *                          vertexCount ≤ 65535, else uint32 LE.
 *
 * Sparseness
 * ──────────
 * Empty chunks (no geometry intersecting their AABB) are NOT included in the
 * index. The chunk index lists only chunks that have a VXL3 blob in the
 * payload. For sparse worlds (e.g. racing tracks through a large bounding
 * box) this avoids storing tens of thousands of empty-chunk entries.
 *
 * Range-friendly
 * ──────────────
 * The header + index live at the start of the file. A streaming loader can
 * fetch the first ~(32 + 4 + chunkCount × 16) bytes to learn every chunk's
 * offset/size, then range-fetch individual chunks on demand. The format
 * doesn't force streaming, but supports it without further changes.
 */

import { decodeVxlV3, type DecodedVxlV3 } from 'engine/VxlV3Format.js';
import { gzip, gunzip } from 'engine/gzip.js';

export const VWLD_MAGIC = 0x44_4c_57_56; // "VWLD" little-endian uint32
export const VWLD_VERSION = 1;
/**
 * v2 layout: per-chunk index entry grows from 16 to 24 bytes with an
 * additional (tcolOffset, tcolSize) pair, and chunks may carry a TMSH
 * trimesh-collider blob alongside the VXL3 blob. Encoder bumps to v2
 * only when at least one chunk has trimesh data; pure-voxel worlds
 * stay on v1 (byte-identical to pre-trimesh output).
 */
export const VWLD_VERSION_WITH_TRIMESH = 2;
/** Magic for per-chunk trimesh blob: "TMSH" little-endian. */
export const TMSH_MAGIC = 0x48_53_4d_54;

export const VWLD_COMPRESSION_NONE = 0;
export const VWLD_COMPRESSION_GZIP = 1;

const BODY_HEADER_SIZE = 32;
const CHUNK_COUNT_SIZE = 4;
const CHUNK_INDEX_ENTRY_SIZE_V1 = 16;
const CHUNK_INDEX_ENTRY_SIZE_V2 = 24;
/** Smallest possible file: wrapper + body header + chunkCount=0 + no chunks. */
export const VWLD_MIN_FILE_SIZE = 5 + BODY_HEADER_SIZE + CHUNK_COUNT_SIZE;

export interface VxlWorldBounds {
    minX: number; minY: number; minZ: number;
    maxX: number; maxY: number; maxZ: number;
}

/**
 * One chunk in the file. `vxlBytes` is the *standalone* VXL3 blob (starts
 * with the 5-byte VXL3 wrapper) — passable directly to `decodeVxlV3()`.
 */
export interface VxlWorldChunk {
    sx: number;
    sy: number;
    sz: number;
    vxlBytes: Uint8Array;
    /**
     * Optional per-chunk Rapier trimesh collider blob. When set, the
     * runtime builds a `RAPIER.ColliderDesc.trimesh(...)` from this in
     * addition to the voxel-greedy-mesh collider derived from
     * non-`nc`-tagged leaves. Absence (or empty) means the chunk relies
     * entirely on its voxel collider. Encode/decode via
     * `encodeTrimeshBlob` / `decodeTrimeshBlob`. Forces VWLD v2.
     */
    tcolBytes?: Uint8Array;
}

export interface VxlWorldData {
    /** Meters per chunk axis (e.g. 16.0). */
    chunkSize: number;
    /** Chunk-aligned world bounds. */
    bounds: VxlWorldBounds;
    /** Sparse list — only chunks with geometry are present. */
    chunks: VxlWorldChunk[];
}

export interface EncodeVxlWorldOptions {
    /**
     * Default: 'none'. Per-chunk VXL3 blobs gzip themselves; a second pass
     * here usually doesn't help. Pass 'gzip' explicitly when you have a
     * particular reason (e.g. transport with no inline compression).
     */
    compression?: 'gzip' | 'none';
}

/** Check whether a buffer's first bytes match the VWLD magic. Cheap, no copy. */
export function isVxlWorld(buffer: ArrayBuffer): boolean {
    if (buffer.byteLength < 4) return false;
    const view = new DataView(buffer, 0, 4);
    return view.getUint32(0, true) === VWLD_MAGIC;
}

// ─── Encode ───────────────────────────────────────────────────────────────

export async function encodeVxlWorld(data: VxlWorldData, options: EncodeVxlWorldOptions = {}): Promise<Uint8Array> {
    validateBounds(data.bounds, data.chunkSize);

    const body = encodeBody(data);
    const compression = options.compression ?? 'none';
    const compressionId = compression === 'gzip' ? VWLD_COMPRESSION_GZIP : VWLD_COMPRESSION_NONE;
    const payload = compressionId === VWLD_COMPRESSION_GZIP ? await gzip(body) : body;

    const out = new Uint8Array(5 + payload.byteLength);
    const outView = new DataView(out.buffer, out.byteOffset, out.byteLength);
    outView.setUint32(0, VWLD_MAGIC, true);
    out[4] = compressionId;
    out.set(payload, 5);
    return out;
}

function encodeBody(data: VxlWorldData): Uint8Array {
    const chunkCount = data.chunks.length;
    // v2 trigger: at least one chunk has a non-empty trimesh blob.
    // Otherwise stay on v1 so pre-trimesh consumers keep working and
    // pre-trimesh assets are byte-identical with this encoder.
    const hasAnyTrimesh = data.chunks.some(c => c.tcolBytes !== undefined && c.tcolBytes.byteLength > 0);
    const version = hasAnyTrimesh ? VWLD_VERSION_WITH_TRIMESH : VWLD_VERSION;
    const indexEntrySize = hasAnyTrimesh ? CHUNK_INDEX_ENTRY_SIZE_V2 : CHUNK_INDEX_ENTRY_SIZE_V1;

    let payloadBytes = 0;
    for (const c of data.chunks) {
        payloadBytes += c.vxlBytes.byteLength;
        if (hasAnyTrimesh && c.tcolBytes) payloadBytes += c.tcolBytes.byteLength;
    }

    const total = BODY_HEADER_SIZE + CHUNK_COUNT_SIZE + chunkCount * indexEntrySize + payloadBytes;
    const buf = new ArrayBuffer(total);
    const view = new DataView(buf);
    const bytes = new Uint8Array(buf);

    // Body header.
    view.setUint32(0, version, true);
    view.setFloat32(4, data.chunkSize, true);
    view.setFloat32(8, data.bounds.minX, true);
    view.setFloat32(12, data.bounds.minY, true);
    view.setFloat32(16, data.bounds.minZ, true);
    view.setFloat32(20, data.bounds.maxX, true);
    view.setFloat32(24, data.bounds.maxY, true);
    view.setFloat32(28, data.bounds.maxZ, true);

    // Chunk index header.
    let cursor = BODY_HEADER_SIZE;
    view.setUint32(cursor, chunkCount, true);
    cursor += CHUNK_COUNT_SIZE;

    // First pass: write the index entries. Offsets are byte positions
    // within the payload section (not the body) — the loader knows the
    // payload starts right after the index. For v2 we write vxl then
    // tcol per chunk so a chunk's pair is adjacent on disk (better
    // sequential-read locality than interleaving across all chunks).
    const payloadStart = cursor + chunkCount * indexEntrySize;
    let runningOffset = 0;
    for (const c of data.chunks) {
        if (!isInt16(c.sx) || !isInt16(c.sy) || !isInt16(c.sz)) {
            throw new Error(`VWLD chunk coord out of int16 range: (${c.sx}, ${c.sy}, ${c.sz})`);
        }
        view.setInt16(cursor + 0, c.sx, true);
        view.setInt16(cursor + 2, c.sy, true);
        view.setInt16(cursor + 4, c.sz, true);
        view.setUint16(cursor + 6, 0, true); // reserved
        view.setUint32(cursor + 8, runningOffset, true);
        view.setUint32(cursor + 12, c.vxlBytes.byteLength, true);
        runningOffset += c.vxlBytes.byteLength;
        if (hasAnyTrimesh) {
            const tcolBytes = c.tcolBytes ?? new Uint8Array(0);
            const hasTcol = tcolBytes.byteLength > 0;
            view.setUint32(cursor + 16, hasTcol ? runningOffset : 0, true);
            view.setUint32(cursor + 20, tcolBytes.byteLength, true);
            runningOffset += tcolBytes.byteLength;
        }
        cursor += indexEntrySize;
    }

    // Second pass: write the chunk payloads in declared order — vxl
    // then (if present) tcol, matching the offsets we just wrote.
    let writePos = payloadStart;
    for (const c of data.chunks) {
        bytes.set(c.vxlBytes, writePos);
        writePos += c.vxlBytes.byteLength;
        if (hasAnyTrimesh && c.tcolBytes && c.tcolBytes.byteLength > 0) {
            bytes.set(c.tcolBytes, writePos);
            writePos += c.tcolBytes.byteLength;
        }
    }

    return bytes;
}

// ─── Decode ───────────────────────────────────────────────────────────────

export async function decodeVxlWorld(buffer: ArrayBuffer): Promise<VxlWorldData> {
    if (buffer.byteLength < 5) {
        throw new Error(`VWLD buffer too small: ${buffer.byteLength} bytes`);
    }
    const outerView = new DataView(buffer, 0, 5);
    if (outerView.getUint32(0, true) !== VWLD_MAGIC) {
        throw new Error('VWLD magic mismatch');
    }
    const compressionId = outerView.getUint8(4);
    const payload = new Uint8Array(buffer, 5);

    let body: Uint8Array;
    if (compressionId === VWLD_COMPRESSION_GZIP) {
        body = await gunzip(payload);
    } else if (compressionId === VWLD_COMPRESSION_NONE) {
        body = payload;
    } else {
        throw new Error(`VWLD unknown compressionId: ${compressionId}`);
    }

    return decodeBody(body);
}

function decodeBody(body: Uint8Array): VxlWorldData {
    if (body.byteLength < BODY_HEADER_SIZE + CHUNK_COUNT_SIZE) {
        throw new Error(`VWLD body too small: ${body.byteLength} bytes`);
    }
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);

    const version = view.getUint32(0, true);
    if (version !== VWLD_VERSION && version !== VWLD_VERSION_WITH_TRIMESH) {
        throw new Error(`VWLD unsupported version: ${version}`);
    }
    const hasTrimesh = version === VWLD_VERSION_WITH_TRIMESH;
    const indexEntrySize = hasTrimesh ? CHUNK_INDEX_ENTRY_SIZE_V2 : CHUNK_INDEX_ENTRY_SIZE_V1;
    const chunkSize = view.getFloat32(4, true);
    const bounds: VxlWorldBounds = {
        minX: view.getFloat32(8, true),
        minY: view.getFloat32(12, true),
        minZ: view.getFloat32(16, true),
        maxX: view.getFloat32(20, true),
        maxY: view.getFloat32(24, true),
        maxZ: view.getFloat32(28, true),
    };
    if (!(chunkSize > 0) || !isFinite(chunkSize)) {
        throw new Error(`VWLD invalid chunkSize: ${chunkSize}`);
    }
    validateBounds(bounds, chunkSize);

    const chunkCount = view.getUint32(BODY_HEADER_SIZE, true);
    const indexSize = chunkCount * indexEntrySize;
    const payloadStart = BODY_HEADER_SIZE + CHUNK_COUNT_SIZE + indexSize;
    if (body.byteLength < payloadStart) {
        throw new Error(`VWLD body truncated: index requires ${payloadStart} bytes, have ${body.byteLength}`);
    }

    const chunks: VxlWorldChunk[] = new Array(chunkCount);
    let cursor = BODY_HEADER_SIZE + CHUNK_COUNT_SIZE;
    for (let i = 0; i < chunkCount; i++) {
        const sx = view.getInt16(cursor + 0, true);
        const sy = view.getInt16(cursor + 2, true);
        const sz = view.getInt16(cursor + 4, true);
        const vxlOffset = view.getUint32(cursor + 8, true);
        const vxlSize = view.getUint32(cursor + 12, true);
        const vxlStart = payloadStart + vxlOffset;
        const vxlEnd = vxlStart + vxlSize;
        if (vxlEnd > body.byteLength) {
            throw new Error(`VWLD chunk ${i} VXL payload out of bounds (need ${vxlEnd}, have ${body.byteLength})`);
        }
        const vxlBytes = body.subarray(vxlStart, vxlEnd);
        const chunk: VxlWorldChunk = { sx, sy, sz, vxlBytes };
        if (hasTrimesh) {
            const tcolOffset = view.getUint32(cursor + 16, true);
            const tcolSize = view.getUint32(cursor + 20, true);
            if (tcolSize > 0) {
                const tcolStart = payloadStart + tcolOffset;
                const tcolEnd = tcolStart + tcolSize;
                if (tcolEnd > body.byteLength) {
                    throw new Error(`VWLD chunk ${i} trimesh payload out of bounds (need ${tcolEnd}, have ${body.byteLength})`);
                }
                chunk.tcolBytes = body.subarray(tcolStart, tcolEnd);
            }
        }
        chunks[i] = chunk;
        cursor += indexEntrySize;
    }

    return { chunkSize, bounds, chunks };
}

// ─── Per-chunk trimesh blob (TMSH) ────────────────────────────────────────

/**
 * Decoded trimesh-collider payload. Positions are in CHUNK-LOCAL world
 * units (range `[0, chunkSize]` per axis) — caller adds the chunk's
 * world origin when handing them to Rapier.
 */
export interface ChunkTrimeshData {
    /** Float32, length = vertexCount × 3. Chunk-local meters. */
    vertices: Float32Array;
    /** Uint32, length = triangleCount × 3. */
    indices: Uint32Array;
}

const TMSH_HEADER_SIZE = 12;

/**
 * Encode a per-chunk trimesh collider blob. Positions are quantized to
 * uint16 over `[0, chunkSize]` (sub-millimeter resolution for typical
 * 16-m chunks — `chunkSize / 65535` ≈ 0.24 mm). Indices are uint16 when
 * the vertex count fits, uint32 otherwise.
 */
export function encodeTrimeshBlob(
    vertices: Float32Array,
    indices: Uint32Array,
    chunkSize: number,
): Uint8Array {
    if (vertices.length % 3 !== 0) {
        throw new Error(`TMSH vertices length ${vertices.length} not divisible by 3`);
    }
    if (indices.length % 3 !== 0) {
        throw new Error(`TMSH indices length ${indices.length} not divisible by 3`);
    }
    const vertexCount = vertices.length / 3;
    const triangleCount = indices.length / 3;
    const idxBytes = vertexCount <= 0xFFFF ? 2 : 4;

    const totalBytes = TMSH_HEADER_SIZE + vertexCount * 6 + triangleCount * 3 * idxBytes;
    const buf = new ArrayBuffer(totalBytes);
    const view = new DataView(buf);
    view.setUint32(0, TMSH_MAGIC, true);
    view.setUint32(4, vertexCount, true);
    view.setUint32(8, triangleCount, true);

    const scale = chunkSize > 0 ? 65535 / chunkSize : 0;
    let cursor = TMSH_HEADER_SIZE;
    for (let i = 0; i < vertexCount; i++) {
        const x = Math.max(0, Math.min(65535, Math.round(vertices[i * 3 + 0]! * scale)));
        const y = Math.max(0, Math.min(65535, Math.round(vertices[i * 3 + 1]! * scale)));
        const z = Math.max(0, Math.min(65535, Math.round(vertices[i * 3 + 2]! * scale)));
        view.setUint16(cursor + 0, x, true);
        view.setUint16(cursor + 2, y, true);
        view.setUint16(cursor + 4, z, true);
        cursor += 6;
    }

    for (let i = 0; i < indices.length; i++) {
        const v = indices[i]!;
        if (v >= vertexCount) {
            throw new Error(`TMSH index ${v} out of range (vertexCount=${vertexCount})`);
        }
        if (idxBytes === 2) {
            view.setUint16(cursor, v, true);
            cursor += 2;
        } else {
            view.setUint32(cursor, v, true);
            cursor += 4;
        }
    }
    return new Uint8Array(buf);
}

/**
 * Decode a per-chunk trimesh collider blob. Returns chunk-local
 * float32 positions and uint32 indices in the shape Rapier's
 * `ColliderDesc.trimesh(vertices, indices)` expects directly.
 */
export function decodeTrimeshBlob(bytes: Uint8Array, chunkSize: number): ChunkTrimeshData {
    if (bytes.byteLength < TMSH_HEADER_SIZE) {
        throw new Error(`TMSH blob too small: ${bytes.byteLength} bytes`);
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== TMSH_MAGIC) {
        throw new Error('TMSH magic mismatch');
    }
    const vertexCount = view.getUint32(4, true);
    const triangleCount = view.getUint32(8, true);
    const idxBytes = vertexCount <= 0xFFFF ? 2 : 4;
    const expectedSize = TMSH_HEADER_SIZE + vertexCount * 6 + triangleCount * 3 * idxBytes;
    if (bytes.byteLength < expectedSize) {
        throw new Error(`TMSH blob truncated: expected ${expectedSize} bytes, have ${bytes.byteLength}`);
    }

    const vertices = new Float32Array(vertexCount * 3);
    const invScale = chunkSize / 65535;
    let cursor = TMSH_HEADER_SIZE;
    for (let i = 0; i < vertexCount; i++) {
        vertices[i * 3 + 0] = view.getUint16(cursor + 0, true) * invScale;
        vertices[i * 3 + 1] = view.getUint16(cursor + 2, true) * invScale;
        vertices[i * 3 + 2] = view.getUint16(cursor + 4, true) * invScale;
        cursor += 6;
    }

    const indices = new Uint32Array(triangleCount * 3);
    for (let i = 0; i < indices.length; i++) {
        if (idxBytes === 2) {
            indices[i] = view.getUint16(cursor, true);
            cursor += 2;
        } else {
            indices[i] = view.getUint32(cursor, true);
            cursor += 4;
        }
    }
    return { vertices, indices };
}

/**
 * Helper: decode one chunk's payload into a full `VxlV3Data` (calls
 * `decodeVxlV3` under the hood). Use when the runtime is ready to
 * materialize a chunk into geometry.
 */
export async function decodeChunkVxl(chunk: VxlWorldChunk): Promise<DecodedVxlV3> {
    const buf = chunk.vxlBytes.buffer.slice(
        chunk.vxlBytes.byteOffset,
        chunk.vxlBytes.byteOffset + chunk.vxlBytes.byteLength,
    ) as ArrayBuffer;
    return decodeVxlV3(buf);
}

// ─── Validation helpers ───────────────────────────────────────────────────

function validateBounds(bounds: VxlWorldBounds, chunkSize: number): void {
    const axes: Array<[number, number, string]> = [
        [bounds.minX, bounds.maxX, 'X'],
        [bounds.minY, bounds.maxY, 'Y'],
        [bounds.minZ, bounds.maxZ, 'Z'],
    ];
    const EPS = 1e-3;
    for (const [mn, mx, label] of axes) {
        if (!(mx >= mn)) {
            throw new Error(`VWLD bounds invalid: ${label} max ${mx} < min ${mn}`);
        }
        const span = mx - mn;
        const rem = Math.abs(((span / chunkSize) - Math.round(span / chunkSize))) * chunkSize;
        if (rem > EPS) {
            throw new Error(`VWLD bounds not chunk-aligned on ${label}: span ${span} not a multiple of chunkSize ${chunkSize}`);
        }
    }
}

function isInt16(n: number): boolean {
    return Number.isInteger(n) && n >= -32768 && n <= 32767;
}
