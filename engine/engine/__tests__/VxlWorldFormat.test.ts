/**
 * @jest-environment jsdom
 */
import {
    encodeVxlWorld, decodeVxlWorld, isVxlWorld, decodeChunkVxl,
    encodeTrimeshBlob, decodeTrimeshBlob,
    VWLD_VERSION, VWLD_VERSION_WITH_TRIMESH,
    type VxlWorldData, type VxlWorldChunk,
} from 'engine/VxlWorldFormat.js';
import { encodeVxlV3, type VxlV3Data, type VxlV3Fragment } from 'engine/VxlV3Format.js';
import type { OctreeLeaf } from 'engine/VoxelOctreeRenderer.js';

function makeLeaf(x: number, y: number, z: number, size: number, r: number, g: number, b: number): OctreeLeaf {
    return { x, y, z, size, r, g, b };
}

function fragmentOf(leaves: OctreeLeaf[]): VxlV3Fragment {
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const l of leaves) {
        if (l.x < min[0]) min[0] = l.x;
        if (l.y < min[1]) min[1] = l.y;
        if (l.z < min[2]) min[2] = l.z;
        if (l.x + l.size > max[0]) max[0] = l.x + l.size;
        if (l.y + l.size > max[1]) max[1] = l.y + l.size;
        if (l.z + l.size > max[2]) max[2] = l.z + l.size;
    }
    return { aabbMin: min, aabbMax: max, leaves };
}

/** Build a small standalone VXL3 file for use inside a VWLD chunk. */
async function makeChunkVxl(seedColor: { r: number; g: number; b: number }): Promise<Uint8Array> {
    const data: VxlV3Data = {
        minVoxelSize: 0.5,
        maxVoxelSize: 2.0,
        physicsGridStep: 0.5,
        bounds: { minX: 0, minY: 0, minZ: 0, maxX: 4, maxY: 4, maxZ: 4 },
        useAtlas: false,
        fragments: [
            fragmentOf([
                makeLeaf(0, 0, 0, 0.5, seedColor.r, seedColor.g, seedColor.b),
                makeLeaf(0.5, 0, 0, 0.5, seedColor.r, seedColor.g, seedColor.b),
            ]),
        ],
    };
    // 'none' compression — jsdom's Blob doesn't expose stream() for the gzip path.
    return encodeVxlV3(data, { compression: 'none' });
}

function asArrayBuffer(u8: Uint8Array): ArrayBuffer {
    return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

describe('VWLD format round-trip', () => {
    it('isVxlWorld detects the magic', async () => {
        const chunkA = await makeChunkVxl({ r: 1, g: 0, b: 0 });
        const world: VxlWorldData = {
            chunkSize: 16,
            bounds: { minX: 0, minY: 0, minZ: 0, maxX: 16, maxY: 16, maxZ: 16 },
            chunks: [{ sx: 0, sy: 0, sz: 0, vxlBytes: chunkA }],
        };
        const encoded = await encodeVxlWorld(world, { compression: 'none' });
        expect(isVxlWorld(asArrayBuffer(encoded))).toBe(true);

        const bogus = new Uint8Array([0x56, 0x58, 0x4c, 0x33]); // VXL3, not VWLD
        expect(isVxlWorld(asArrayBuffer(bogus))).toBe(false);
    });

    it('round-trips header + bounds + version', async () => {
        const chunkA = await makeChunkVxl({ r: 0.2, g: 0.4, b: 0.8 });
        const world: VxlWorldData = {
            chunkSize: 16,
            bounds: { minX: -32, minY: 0, minZ: -16, maxX: 48, maxY: 16, maxZ: 32 },
            chunks: [{ sx: -2, sy: 0, sz: -1, vxlBytes: chunkA }],
        };
        const encoded = await encodeVxlWorld(world, { compression: 'none' });
        const decoded = await decodeVxlWorld(asArrayBuffer(encoded));
        expect(decoded.chunkSize).toBeCloseTo(16, 5);
        expect(decoded.bounds.minX).toBeCloseTo(-32, 5);
        expect(decoded.bounds.maxX).toBeCloseTo(48, 5);
        expect(decoded.bounds.minZ).toBeCloseTo(-16, 5);
        expect(decoded.bounds.maxZ).toBeCloseTo(32, 5);
        // Version stored at body offset 0 (post-wrapper).
        const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
        expect(view.getUint32(5, true)).toBe(VWLD_VERSION);
    });

    it('round-trips multiple sparse chunks with mixed coords', async () => {
        const chunks: VxlWorldChunk[] = [
            { sx: 0, sy: 0, sz: 0, vxlBytes: await makeChunkVxl({ r: 1, g: 0, b: 0 }) },
            { sx: -3, sy: 1, sz: 2, vxlBytes: await makeChunkVxl({ r: 0, g: 1, b: 0 }) },
            { sx: 5, sy: 0, sz: -4, vxlBytes: await makeChunkVxl({ r: 0, g: 0, b: 1 }) },
        ];
        const world: VxlWorldData = {
            chunkSize: 16,
            bounds: { minX: -64, minY: 0, minZ: -80, maxX: 96, maxY: 32, maxZ: 48 },
            chunks,
        };
        const encoded = await encodeVxlWorld(world, { compression: 'none' });
        const decoded = await decodeVxlWorld(asArrayBuffer(encoded));

        expect(decoded.chunks.length).toBe(3);
        for (let i = 0; i < 3; i++) {
            expect(decoded.chunks[i]!.sx).toBe(chunks[i]!.sx);
            expect(decoded.chunks[i]!.sy).toBe(chunks[i]!.sy);
            expect(decoded.chunks[i]!.sz).toBe(chunks[i]!.sz);
            expect(decoded.chunks[i]!.vxlBytes.byteLength).toBe(chunks[i]!.vxlBytes.byteLength);
            // Bytes match exactly — the chunk's payload is the same standalone VXL3 file.
            for (let b = 0; b < chunks[i]!.vxlBytes.byteLength; b++) {
                expect(decoded.chunks[i]!.vxlBytes[b]).toBe(chunks[i]!.vxlBytes[b]);
            }
        }
    });

    it('sparse — supports zero chunks (empty world)', async () => {
        const world: VxlWorldData = {
            chunkSize: 16,
            bounds: { minX: 0, minY: 0, minZ: 0, maxX: 16, maxY: 16, maxZ: 16 },
            chunks: [],
        };
        const encoded = await encodeVxlWorld(world, { compression: 'none' });
        const decoded = await decodeVxlWorld(asArrayBuffer(encoded));
        expect(decoded.chunks.length).toBe(0);
        expect(decoded.chunkSize).toBe(16);
    });

    it('decodeChunkVxl unpacks a chunk into a full DecodedVxlV3', async () => {
        const chunkA = await makeChunkVxl({ r: 0.5, g: 0.5, b: 0.5 });
        const world: VxlWorldData = {
            chunkSize: 16,
            bounds: { minX: 0, minY: 0, minZ: 0, maxX: 16, maxY: 16, maxZ: 16 },
            chunks: [{ sx: 0, sy: 0, sz: 0, vxlBytes: chunkA }],
        };
        const encoded = await encodeVxlWorld(world, { compression: 'none' });
        const decoded = await decodeVxlWorld(asArrayBuffer(encoded));
        const chunkData = await decodeChunkVxl(decoded.chunks[0]!);
        expect(chunkData.fragments.length).toBe(1);
        expect(chunkData.fragments[0]!.leaves.count).toBe(2);
    });

    it('rejects bounds that are not chunk-aligned', async () => {
        const world: VxlWorldData = {
            chunkSize: 16,
            // 17 - 0 = 17, not a multiple of 16.
            bounds: { minX: 0, minY: 0, minZ: 0, maxX: 17, maxY: 16, maxZ: 16 },
            chunks: [],
        };
        await expect(encodeVxlWorld(world, { compression: 'none' })).rejects.toThrow(/not chunk-aligned/);
    });

    it('rejects chunk coords outside int16 range', async () => {
        const chunkA = await makeChunkVxl({ r: 1, g: 1, b: 1 });
        const world: VxlWorldData = {
            chunkSize: 16,
            bounds: { minX: 0, minY: 0, minZ: 0, maxX: 16, maxY: 16, maxZ: 16 },
            chunks: [{ sx: 50000, sy: 0, sz: 0, vxlBytes: chunkA }],
        };
        await expect(encodeVxlWorld(world, { compression: 'none' })).rejects.toThrow(/int16 range/);
    });

    it('rejects bad magic', async () => {
        const bogus = new Uint8Array(64);
        // Wrong magic bytes.
        bogus[0] = 0xAB; bogus[1] = 0xCD; bogus[2] = 0xEF; bogus[3] = 0x01;
        await expect(decodeVxlWorld(asArrayBuffer(bogus))).rejects.toThrow(/magic mismatch/);
    });
});

describe('VWLD v2 + TMSH trimesh-collider round-trip', () => {
    it('stays on v1 when no chunk carries tcolBytes', async () => {
        const chunkA = await makeChunkVxl({ r: 1, g: 1, b: 1 });
        const world: VxlWorldData = {
            chunkSize: 16,
            bounds: { minX: 0, minY: 0, minZ: 0, maxX: 16, maxY: 16, maxZ: 16 },
            chunks: [{ sx: 0, sy: 0, sz: 0, vxlBytes: chunkA }],
        };
        const encoded = await encodeVxlWorld(world, { compression: 'none' });
        // Body starts at byte 5; version is the first uint32 of the body.
        const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
        expect(view.getUint32(5, true)).toBe(VWLD_VERSION);
    });

    it('bumps to v2 and round-trips tcolBytes when at least one chunk has it', async () => {
        const chunkA = await makeChunkVxl({ r: 1, g: 0, b: 0 });
        const chunkB = await makeChunkVxl({ r: 0, g: 1, b: 0 });
        // Two triangles, three shared vertices — exercises dedupe + index path.
        const verts = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]);
        const indices = new Uint32Array([0, 1, 2, 1, 3, 2]);
        const tcol = encodeTrimeshBlob(verts, indices, 16);
        const world: VxlWorldData = {
            chunkSize: 16,
            bounds: { minX: 0, minY: 0, minZ: 0, maxX: 32, maxY: 16, maxZ: 16 },
            chunks: [
                { sx: 0, sy: 0, sz: 0, vxlBytes: chunkA, tcolBytes: tcol },
                { sx: 1, sy: 0, sz: 0, vxlBytes: chunkB }, // no trimesh on this chunk
            ],
        };
        const encoded = await encodeVxlWorld(world, { compression: 'none' });
        const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
        expect(view.getUint32(5, true)).toBe(VWLD_VERSION_WITH_TRIMESH);

        const decoded = await decodeVxlWorld(asArrayBuffer(encoded));
        expect(decoded.chunks.length).toBe(2);
        expect(decoded.chunks[0]!.tcolBytes).toBeDefined();
        expect(decoded.chunks[1]!.tcolBytes).toBeUndefined();

        const tcolDecoded = decodeTrimeshBlob(decoded.chunks[0]!.tcolBytes!, 16);
        expect(tcolDecoded.vertices.length).toBe(verts.length);
        expect(tcolDecoded.indices.length).toBe(indices.length);
        // Quantization tolerance: chunkSize/65535 ≈ 0.00024 per axis for chunkSize=16.
        for (let i = 0; i < verts.length; i++) {
            expect(tcolDecoded.vertices[i]).toBeCloseTo(verts[i]!, 3);
        }
        for (let i = 0; i < indices.length; i++) {
            expect(tcolDecoded.indices[i]).toBe(indices[i]);
        }
    });

    it('TMSH blob with > 65535 vertices uses uint32 indices', async () => {
        const vertCount = 70000;
        const verts = new Float32Array(vertCount * 3);
        // Just spread points across the chunk so quantization stays in-range.
        for (let i = 0; i < vertCount; i++) {
            verts[i * 3 + 0] = (i % 100) * 0.1;
            verts[i * 3 + 1] = ((i / 100) % 100) * 0.1;
            verts[i * 3 + 2] = (i / 10000) * 0.1;
        }
        const indices = new Uint32Array([0, 1, 2, vertCount - 1, vertCount - 2, vertCount - 3]);
        const bytes = encodeTrimeshBlob(verts, indices, 16);
        const decoded = decodeTrimeshBlob(bytes, 16);
        expect(decoded.vertices.length).toBe(verts.length);
        expect(decoded.indices.length).toBe(indices.length);
        expect(decoded.indices[3]).toBe(vertCount - 1);
        expect(decoded.indices[4]).toBe(vertCount - 2);
        expect(decoded.indices[5]).toBe(vertCount - 3);
    });
});
