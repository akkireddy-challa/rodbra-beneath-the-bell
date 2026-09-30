/**
 * NavSerialization — the on-disk format for prebuilt VoxelNavMesh data.
 *
 * A forge-time compiler emits this sidecar next to a baked level so the
 * runtime can skip the voxel scan entirely: `VoxelNavMesh.buildFromSerialized`
 * installs the decoded chunks verbatim. Every byte layout here is mirrored by
 * the agent-side writer, so the format is fixed — additions go through
 * `NAV_SIDECAR_VERSION`, never through silent field reordering.
 *
 * Layout (little-endian throughout):
 *
 *   header (NAV_HEADER_BYTES)
 *     [magic u32][version u32][cellSize f32][agentRadius f32][voxelSize f32]
 *     [chunkWorldSize f32][minX f32][minZ f32][chunkCols u32][chunkRows u32]
 *     [cellsPerChunkSide u32][maxClimbM f32][maxDropM f32][chunkCount u32]
 *
 *   per chunk
 *     [cx u16][cz u16][kind u8] then, by kind:
 *       trivial    [groundY f32]
 *       grid       [baseY f32][data u16 x cps^2]
 *       multilayer [baseY f32][layerCount u8][data u16 x cps^2 * layerCount]
 *
 * Records are packed with no alignment padding — reads go through a DataView.
 * `cellSize`, `cellsPerSide` and `voxelSize` are NOT repeated per chunk; every
 * chunk inherits them from the header.
 *
 * This module is pure data (no three.js, no engine state) so both the runtime
 * and the offline compiler can depend on it.
 */

// ── Packed cell format ──────────────────────────────────────────────────────
// Shared by grid and multilayer chunks:
//   value === VOID_SENTINEL → no walkable surface in this cell/layer
//   else                    → bit 0 = OBSTACLE_BIT (dynamic, registered)
//                             bit 1 = TERRAIN_BIT  (build-time, never cleared)
//                             bits 2-15 = groundY delta from the chunk's baseY
//                                         in voxelSize units (14 bits)

export const VOID_SENTINEL = 0xFFFF;
export const OBSTACLE_BIT = 0x0001;
export const TERRAIN_BIT = 0x0002;
export const BLOCKED_BITS = OBSTACLE_BIT | TERRAIN_BIT;
export const DELTA_SHIFT = 2;
/** 14 bits, leaving one value as sanity margin below the sentinel. */
export const DELTA_MAX = 0x3FFE;

// ── Format constants ────────────────────────────────────────────────────────

/** 'BMNV' when the u32 is written little-endian. */
export const NAV_SIDECAR_MAGIC = 0x564e4d42;
export const NAV_SIDECAR_VERSION = 1;
/** Hard cap on walkable layers per cell; also the A* node-key stride. */
export const MAX_NAV_LAYERS = 8;
export const NAV_HEADER_BYTES = 56;

const KIND_TRIVIAL = 0;
const KIND_GRID = 1;
const KIND_MULTILAYER = 2;

// ── Chunk types ─────────────────────────────────────────────────────────────

/** Trivial chunk: uniform groundY, every cell walkable, never blocked. */
export interface TrivialChunk {
    kind: 'trivial';
    cx: number;
    cz: number;
    groundY: number;
}

/** Grid chunk: one packed cell per column, indexed [lx * cellsPerSide + lz]. */
export interface GridChunk {
    kind: 'grid';
    cx: number;
    cz: number;
    /** Cell size in world meters (e.g. 1.0, 0.5, 0.25, 0.125). */
    cellSize: number;
    /** Cells per chunk per axis (chunkWorldSize / cellSize). */
    cellsPerSide: number;
    /** Reference Y; per-cell groundY = baseY + delta * voxelSize. */
    baseY: number;
    /** Delta-quantization unit in world meters. */
    voxelSize: number;
    data: Uint16Array;
}

/**
 * Multilayer chunk: several stacked walkable surfaces per column (dungeon
 * floors, bridges, balconies). Indexed [cellIndex * layerCount + layer] with
 * cellIndex = lx * cellsPerSide + lz.
 *
 * Invariant: a cell's present layers are packed from layer 0 upwards in
 * ascending groundY, and every remaining slot is VOID_SENTINEL. Readers stop
 * at the first sentinel, so holes in the middle would truncate the column.
 */
export interface MultiLayerChunk {
    kind: 'multilayer';
    cx: number;
    cz: number;
    cellSize: number;
    cellsPerSide: number;
    baseY: number;
    voxelSize: number;
    /** Slots reserved per cell, 1..MAX_NAV_LAYERS. */
    layerCount: number;
    data: Uint16Array;
}

export type NavChunk = TrivialChunk | GridChunk | MultiLayerChunk;

/** Whole-mesh parameters. One header per sidecar. */
export interface NavHeader {
    cellSize: number;
    agentRadius: number;
    /** Delta-quantization unit for packed groundY — NOT the step-limit basis. */
    voxelSize: number;
    chunkWorldSize: number;
    minX: number;
    minZ: number;
    chunkCols: number;
    chunkRows: number;
    cellsPerChunkSide: number;
    /** Step-up limit in meters, applied by the runtime's canStep. */
    maxClimbM: number;
    /** Step-down limit in meters. */
    maxDropM: number;
}

// ── Encode ──────────────────────────────────────────────────────────────────

function layerCountOf(chunk: NavChunk): number {
    return chunk.kind === 'multilayer' ? chunk.layerCount : 1;
}

function chunkPayloadBytes(chunk: NavChunk, cells: number): number {
    if (chunk.kind === 'trivial') return 4;
    if (chunk.kind === 'grid') return 4 + 2 * cells;
    return 4 + 1 + 2 * cells * chunk.layerCount;
}

function validateChunk(chunk: NavChunk, cells: number): void {
    if (chunk.kind === 'trivial') return;
    const layers = layerCountOf(chunk);
    if (layers < 1 || layers > MAX_NAV_LAYERS) {
        throw new Error(`[NavSerialization] chunk (${chunk.cx},${chunk.cz}) has layerCount ${layers}, expected 1..${MAX_NAV_LAYERS}`);
    }
    if (chunk.data.length !== cells * layers) {
        throw new Error(`[NavSerialization] chunk (${chunk.cx},${chunk.cz}) data length ${chunk.data.length}, expected ${cells * layers}`);
    }
}

/**
 * Encode a header plus chunk store into a self-contained byte buffer. Chunks
 * are written in iteration order; the decoder does not care about ordering.
 */
export function encodeNavMesh(header: NavHeader, chunks: Iterable<NavChunk>): Uint8Array {
    const list = Array.from(chunks);
    const cells = header.cellsPerChunkSide * header.cellsPerChunkSide;

    let total = NAV_HEADER_BYTES;
    for (const chunk of list) {
        validateChunk(chunk, cells);
        total += 5 + chunkPayloadBytes(chunk, cells);
    }

    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    view.setUint32(0, NAV_SIDECAR_MAGIC, true);
    view.setUint32(4, NAV_SIDECAR_VERSION, true);
    view.setFloat32(8, header.cellSize, true);
    view.setFloat32(12, header.agentRadius, true);
    view.setFloat32(16, header.voxelSize, true);
    view.setFloat32(20, header.chunkWorldSize, true);
    view.setFloat32(24, header.minX, true);
    view.setFloat32(28, header.minZ, true);
    view.setUint32(32, header.chunkCols, true);
    view.setUint32(36, header.chunkRows, true);
    view.setUint32(40, header.cellsPerChunkSide, true);
    view.setFloat32(44, header.maxClimbM, true);
    view.setFloat32(48, header.maxDropM, true);
    view.setUint32(52, list.length, true);

    let offset = NAV_HEADER_BYTES;
    for (const chunk of list) {
        view.setUint16(offset, chunk.cx, true);
        view.setUint16(offset + 2, chunk.cz, true);
        offset += 4;
        if (chunk.kind === 'trivial') {
            view.setUint8(offset, KIND_TRIVIAL);
            view.setFloat32(offset + 1, chunk.groundY, true);
            offset += 5;
            continue;
        }
        if (chunk.kind === 'grid') {
            view.setUint8(offset, KIND_GRID);
            view.setFloat32(offset + 1, chunk.baseY, true);
            offset += 5;
        } else {
            view.setUint8(offset, KIND_MULTILAYER);
            view.setFloat32(offset + 1, chunk.baseY, true);
            view.setUint8(offset + 5, chunk.layerCount);
            offset += 6;
        }
        for (let i = 0; i < chunk.data.length; i++) {
            view.setUint16(offset, chunk.data[i]!, true);
            offset += 2;
        }
    }
    return out;
}

// ── Decode ──────────────────────────────────────────────────────────────────

function requireBytes(available: number, needed: number, what: string): void {
    if (needed > available) {
        throw new Error(`[NavSerialization] truncated buffer: ${what} needs ${needed} bytes, ${available} available`);
    }
}

/**
 * Decode a sidecar. Throws with a specific message on bad magic, an unknown
 * version, an unknown chunk kind, an over-deep layer stack, or truncation —
 * a half-read nav mesh is worse than none, so nothing is salvaged.
 */
export function decodeNavMesh(data: ArrayBuffer): { header: NavHeader; chunks: NavChunk[] } {
    requireBytes(data.byteLength, NAV_HEADER_BYTES, 'header');
    const view = new DataView(data);
    const magic = view.getUint32(0, true);
    if (magic !== NAV_SIDECAR_MAGIC) {
        throw new Error(`[NavSerialization] bad magic 0x${magic.toString(16)}, expected 0x${NAV_SIDECAR_MAGIC.toString(16)}`);
    }
    const version = view.getUint32(4, true);
    if (version !== NAV_SIDECAR_VERSION) {
        throw new Error(`[NavSerialization] unsupported version ${version}, expected ${NAV_SIDECAR_VERSION}`);
    }

    const header: NavHeader = {
        cellSize: view.getFloat32(8, true),
        agentRadius: view.getFloat32(12, true),
        voxelSize: view.getFloat32(16, true),
        chunkWorldSize: view.getFloat32(20, true),
        minX: view.getFloat32(24, true),
        minZ: view.getFloat32(28, true),
        chunkCols: view.getUint32(32, true),
        chunkRows: view.getUint32(36, true),
        cellsPerChunkSide: view.getUint32(40, true),
        maxClimbM: view.getFloat32(44, true),
        maxDropM: view.getFloat32(48, true),
    };
    const chunkCount = view.getUint32(52, true);
    const cells = header.cellsPerChunkSide * header.cellsPerChunkSide;

    const chunks: NavChunk[] = [];
    let offset = NAV_HEADER_BYTES;
    for (let i = 0; i < chunkCount; i++) {
        requireBytes(data.byteLength, offset + 5, `chunk ${i} record`);
        const cx = view.getUint16(offset, true);
        const cz = view.getUint16(offset + 2, true);
        const kind = view.getUint8(offset + 4);
        offset += 5;

        // The runtime keys chunks by `cx * chunkRows + cz`, so an out-of-grid
        // chunk does not land somewhere harmless — it ALIASES a valid key
        // ((0,5) hashes like (1,1) when chunkRows is 4) and silently replaces
        // real navigation data. Reject it here, where it is still diagnosable.
        if (cx >= header.chunkCols || cz >= header.chunkRows) {
            throw new Error(`[NavSerialization] chunk ${i} at (${cx},${cz}) is outside the ${header.chunkCols}x${header.chunkRows} chunk grid`);
        }

        if (kind === KIND_TRIVIAL) {
            requireBytes(data.byteLength, offset + 4, `chunk ${i} payload`);
            chunks.push({ kind: 'trivial', cx, cz, groundY: view.getFloat32(offset, true) });
            offset += 4;
            continue;
        }
        if (kind !== KIND_GRID && kind !== KIND_MULTILAYER) {
            throw new Error(`[NavSerialization] chunk ${i} has unknown kind ${kind}`);
        }

        requireBytes(data.byteLength, offset + 4, `chunk ${i} payload`);
        const baseY = view.getFloat32(offset, true);
        offset += 4;

        let layerCount = 1;
        if (kind === KIND_MULTILAYER) {
            requireBytes(data.byteLength, offset + 1, `chunk ${i} layerCount`);
            layerCount = view.getUint8(offset);
            offset += 1;
            if (layerCount < 1 || layerCount > MAX_NAV_LAYERS) {
                throw new Error(`[NavSerialization] chunk ${i} declares ${layerCount} layers, expected 1..${MAX_NAV_LAYERS}`);
            }
        }

        const count = cells * layerCount;
        requireBytes(data.byteLength, offset + 2 * count, `chunk ${i} cell data`);
        const cellData = new Uint16Array(count);
        for (let c = 0; c < count; c++) {
            cellData[c] = view.getUint16(offset, true);
            offset += 2;
        }

        if (kind === KIND_GRID) {
            chunks.push({
                kind: 'grid', cx, cz,
                cellSize: header.cellSize,
                cellsPerSide: header.cellsPerChunkSide,
                baseY,
                voxelSize: header.voxelSize,
                data: cellData,
            });
        } else {
            chunks.push({
                kind: 'multilayer', cx, cz,
                cellSize: header.cellSize,
                cellsPerSide: header.cellsPerChunkSide,
                baseY,
                voxelSize: header.voxelSize,
                layerCount,
                data: cellData,
            });
        }
    }

    return { header, chunks };
}
