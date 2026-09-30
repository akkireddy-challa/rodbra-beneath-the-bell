import {
    MAX_NAV_LAYERS,
    NAV_HEADER_BYTES,
    NAV_SIDECAR_MAGIC,
    NAV_SIDECAR_VERSION,
    VOID_SENTINEL,
    decodeNavMesh,
    encodeNavMesh,
} from 'engine/nav/NavSerialization.js';
import type { GridChunk, MultiLayerChunk, NavChunk, NavHeader, TrivialChunk } from 'engine/nav/NavSerialization.js';

// Every float here is exactly representable in f32, so the roundtrip can be
// asserted bit-exactly instead of with tolerances.
const HEADER: NavHeader = {
    cellSize: 1,
    agentRadius: 0.25,
    voxelSize: 0.125,
    chunkWorldSize: 4,
    minX: -16,
    minZ: 32,
    chunkCols: 3,
    chunkRows: 4,
    cellsPerChunkSide: 4,
    maxClimbM: 1,
    maxDropM: 2.5,
};

const CELLS = HEADER.cellsPerChunkSide * HEADER.cellsPerChunkSide;

function buildGridData(): Uint16Array {
    const data = new Uint16Array(CELLS);
    for (let i = 0; i < CELLS; i++) data[i] = (i * 3) << 2;
    data[5] = VOID_SENTINEL;      // void cell
    data[7] = (12 << 2) | 0x0003; // both blocked bits set
    return data;
}

function buildLayerData(layerCount: number): Uint16Array {
    const data = new Uint16Array(CELLS * layerCount).fill(VOID_SENTINEL);
    for (let c = 0; c < CELLS; c++) {
        data[c * layerCount] = c << 2;
        if (layerCount > 1) data[c * layerCount + 1] = ((c + 40) << 2) | 0x0002;
    }
    return data;
}

const TRIVIAL: TrivialChunk = { kind: 'trivial', cx: 0, cz: 1, groundY: 12.5 };
const GRID: GridChunk = {
    kind: 'grid',
    cx: 1, cz: 2,
    cellSize: HEADER.cellSize,
    cellsPerSide: HEADER.cellsPerChunkSide,
    baseY: -3.5,
    voxelSize: HEADER.voxelSize,
    data: buildGridData(),
};
const MULTILAYER: MultiLayerChunk = {
    kind: 'multilayer',
    cx: 2, cz: 3,
    cellSize: HEADER.cellSize,
    cellsPerSide: HEADER.cellsPerChunkSide,
    baseY: 0.25,
    voxelSize: HEADER.voxelSize,
    layerCount: 3,
    data: buildLayerData(3),
};
const CHUNKS: NavChunk[] = [TRIVIAL, GRID, MULTILAYER];

/** Copy into a standalone ArrayBuffer — decodeNavMesh takes an ArrayBuffer. */
function bufferOf(bytes: Uint8Array): ArrayBuffer {
    const out = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(out).set(bytes);
    return out;
}

describe('NavSerialization', () => {
    test('encode/decode roundtrip preserves every chunk kind bit-exactly', () => {
        const decoded = decodeNavMesh(bufferOf(encodeNavMesh(HEADER, CHUNKS)));
        expect(decoded.header).toEqual(HEADER);
        expect(decoded.chunks).toEqual(CHUNKS);
    });

    test('the magic spells BMNV in little-endian byte order', () => {
        const bytes = encodeNavMesh(HEADER, CHUNKS);
        expect(String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!)).toBe('BMNV');
        expect(new DataView(bufferOf(bytes)).getUint32(0, true)).toBe(NAV_SIDECAR_MAGIC);
    });

    // A roundtrip alone survives ANY consistent field reorder — encode and
    // decode would drift together and stay self-consistent while the forge-side
    // writer kept emitting the old layout. This literal is the lockstep pin: the
    // identical hex (same fixture, same comments) lives in game-play-agent's
    // src/mastra/world-forger/__tests__/dungeon-nav-compile.test.ts as
    // GOLDEN_HEADER_HEX. Change one side and this test tells you.
    test('the header serializes to the byte layout the forge-side writer mirrors', () => {
        const goldenHeader: NavHeader = {
            cellSize: 0.5, agentRadius: 0.35, voxelSize: 0.125, chunkWorldSize: 8,
            minX: -16, minZ: 32, chunkCols: 3, chunkRows: 4, cellsPerChunkSide: 16,
            maxClimbM: 1, maxDropM: 2,
        };
        const goldenHex =
            '424d4e56' + '01000000'          // magic 'BMNV', version 1
            + '0000003f' + '3333b33e'        // cellSize 0.5, agentRadius 0.35
            + '0000003e' + '00000041'        // voxelSize 0.125, chunkWorldSize 8
            + '000080c1' + '00000042'        // minX -16, minZ 32
            + '03000000' + '04000000'        // chunkCols 3, chunkRows 4
            + '10000000'                     // cellsPerChunkSide 16
            + '0000803f' + '00000040'        // maxClimbM 1, maxDropM 2
            + '03000000';                    // chunkCount 3

        const cells = goldenHeader.cellsPerChunkSide * goldenHeader.cellsPerChunkSide;
        const shared = { cellSize: goldenHeader.cellSize, cellsPerSide: goldenHeader.cellsPerChunkSide, voxelSize: goldenHeader.voxelSize };
        const bytes = encodeNavMesh(goldenHeader, [
            { kind: 'trivial', cx: 0, cz: 1, groundY: 12.5 },
            { kind: 'grid', cx: 1, cz: 2, ...shared, baseY: -3.5, data: new Uint16Array(cells) },
            { kind: 'multilayer', cx: 2, cz: 3, ...shared, baseY: 0.25, layerCount: 3, data: new Uint16Array(cells * 3) },
        ]);

        const hex = Array.from(bytes.subarray(0, NAV_HEADER_BYTES), (b) => b.toString(16).padStart(2, '0')).join('');
        expect(hex).toBe(goldenHex);
        // Record sizes are part of the layout too: 5 + payload per chunk.
        expect(bytes.byteLength).toBe(NAV_HEADER_BYTES + (5 + 4) + (5 + 4 + 2 * cells) + (5 + 4 + 1 + 2 * cells * 3));
    });

    test('decode rejects bad magic and wrong version with a clear error', () => {
        const good = encodeNavMesh(HEADER, CHUNKS);

        const badMagic = bufferOf(good);
        new DataView(badMagic).setUint32(0, 0x12345678, true);
        expect(() => decodeNavMesh(badMagic)).toThrow(/magic/i);

        const badVersion = bufferOf(good);
        new DataView(badVersion).setUint32(4, NAV_SIDECAR_VERSION + 1, true);
        expect(() => decodeNavMesh(badVersion)).toThrow(/version/i);
    });

    test('layerCount > MAX_NAV_LAYERS is rejected at decode', () => {
        const bytes = encodeNavMesh(HEADER, [MULTILAYER]);
        const patched = bufferOf(bytes);
        // Chunk record: [cx u16][cz u16][kind u8][baseY f32][layerCount u8]
        new DataView(patched).setUint8(NAV_HEADER_BYTES + 9, MAX_NAV_LAYERS + 1);
        expect(() => decodeNavMesh(patched)).toThrow(/layer/i);
    });

    test('a chunk outside the header grid is rejected at decode', () => {
        // chunkKey is cx * chunkRows + cz, so an out-of-grid chunk aliases a
        // valid key ((0,5) hashes like (1,1) at chunkRows=4) and would silently
        // replace real navigation data.
        const patched = bufferOf(encodeNavMesh(HEADER, CHUNKS));
        new DataView(patched).setUint16(NAV_HEADER_BYTES, HEADER.chunkCols, true); // cx == chunkCols
        expect(() => decodeNavMesh(patched)).toThrow(/outside/i);

        const patchedZ = bufferOf(encodeNavMesh(HEADER, CHUNKS));
        new DataView(patchedZ).setUint16(NAV_HEADER_BYTES + 2, HEADER.chunkRows + 1, true);
        expect(() => decodeNavMesh(patchedZ)).toThrow(/outside/i);
    });

    test('encode rejects a multilayer chunk with too many layers', () => {
        const tooDeep: MultiLayerChunk = {
            ...MULTILAYER,
            layerCount: MAX_NAV_LAYERS + 1,
            data: buildLayerData(MAX_NAV_LAYERS + 1),
        };
        expect(() => encodeNavMesh(HEADER, [tooDeep])).toThrow(/layer/i);
    });

    test('decode rejects a truncated buffer', () => {
        const bytes = encodeNavMesh(HEADER, CHUNKS);
        expect(() => decodeNavMesh(bufferOf(bytes.subarray(0, bytes.byteLength - 4)))).toThrow(/truncated/i);
        expect(() => decodeNavMesh(new ArrayBuffer(8))).toThrow(/truncated/i);
    });
});
