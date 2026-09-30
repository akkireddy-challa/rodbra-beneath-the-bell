/**
 * @jest-environment jsdom
 */
import * as zlib from 'zlib';
import { encodeVxlV3, decodeVxlV3, type VxlV3Data, type VxlV3Fragment, VXL3_VERSION_COLUMNAR } from 'engine/VxlV3Format.js';
import { packRgb444, type OctreeLeaf } from 'engine/VoxelOctreeRenderer.js';
import { rgb888ToAtlasCell } from 'engine/vxlscene/atlasColor.js';

function makeLeaf(x: number, y: number, z: number, size: number, r: number, g: number, b: number): OctreeLeaf {
    return { x, y, z, size, r, g, b };
}

function makeFragment(leaves: OctreeLeaf[]): VxlV3Fragment {
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

describe('VxlV3 LOD trailer round-trip', () => {
    const baseData: VxlV3Data = {
        minVoxelSize: 0.1,
        maxVoxelSize: 0.4,
        physicsGridStep: 0.1,
        bounds: { minX: 0, minY: 0, minZ: 0, maxX: 1.6, maxY: 1.6, maxZ: 1.6 },
        useAtlas: false,
        fragments: [
            makeFragment([
                makeLeaf(0.0, 0.0, 0.0, 0.1, 1.0, 0.0, 0.0),
                makeLeaf(0.1, 0.0, 0.0, 0.1, 0.0, 1.0, 0.0),
                makeLeaf(0.0, 0.1, 0.0, 0.2, 0.0, 0.0, 1.0),
            ]),
        ],
    };

    it('encodes as v5 with empty trailer when additionalLods is omitted', async () => {
        const encoded = await encodeVxlV3(baseData, { compression: 'none' });
        const decoded = await decodeVxlV3(encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer);
        expect(decoded.fragments.length).toBe(1);
        expect(decoded.fragments[0]!.leaves.count).toBe(3);
        expect(decoded.additionalLods).toBeUndefined();
        // v5 columnar layout (the LOD-or-not distinction now lives in the trailer count).
        const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
        expect(view.getUint32(5, true)).toBe(VXL3_VERSION_COLUMNAR); // skip 5-byte wrapper
    });

    it('encodes as v5 with trailer when additionalLods has entries', async () => {
        const withLods: VxlV3Data = {
            ...baseData,
            additionalLods: [
                {
                    minVoxelSize: 0.2,
                    maxVoxelSize: 0.8,
                    fragments: [
                        makeFragment([
                            makeLeaf(0.0, 0.0, 0.0, 0.2, 0.5, 0.5, 0.0),
                            makeLeaf(0.2, 0.0, 0.0, 0.2, 0.0, 0.5, 0.5),
                        ]),
                    ],
                },
                {
                    minVoxelSize: 0.4,
                    maxVoxelSize: 1.6,
                    fragments: [
                        makeFragment([
                            makeLeaf(0.0, 0.0, 0.0, 0.4, 0.3, 0.3, 0.3),
                        ]),
                    ],
                },
            ],
        };
        const encoded = await encodeVxlV3(withLods, { compression: 'none' });
        const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
        expect(view.getUint32(5, true)).toBe(VXL3_VERSION_COLUMNAR);

        const decoded = await decodeVxlV3(encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer);
        expect(decoded.fragments[0]!.leaves.count).toBe(3);
        expect(decoded.additionalLods).toBeDefined();
        expect(decoded.additionalLods!.length).toBe(2);
        expect(decoded.additionalLods![0]!.minVoxelSize).toBeCloseTo(0.2, 5);
        expect(decoded.additionalLods![0]!.maxVoxelSize).toBeCloseTo(0.8, 5);
        expect(decoded.additionalLods![0]!.fragments[0]!.leaves.count).toBe(2);
        expect(decoded.additionalLods![1]!.minVoxelSize).toBeCloseTo(0.4, 5);
        expect(decoded.additionalLods![1]!.fragments[0]!.leaves.count).toBe(1);
    });

    // Gzip-compression round-trip is exercised at runtime; jsdom's Blob lacks
    // `.stream()`, so we only test the body layout here. The trailer bytes
    // live inside the same gzip stream as the rest of the body, so a layout
    // round-trip is sufficient evidence the compression path stays consistent.

    it('preserves leaf geometry through round-trip', async () => {
        const withLods: VxlV3Data = {
            ...baseData,
            additionalLods: [{
                minVoxelSize: 0.2,
                maxVoxelSize: 0.8,
                fragments: [makeFragment([
                    makeLeaf(0.4, 0.6, 0.8, 0.4, 0.7, 0.2, 0.9),
                ])],
            }],
        };
        const encoded = await encodeVxlV3(withLods, { compression: 'none' });
        const decoded = await decodeVxlV3(encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer);
        const leaf = decoded.additionalLods![0]!.fragments[0]!.leaves.toArray()[0]!;
        expect(leaf.x).toBeCloseTo(0.4, 5);
        expect(leaf.y).toBeCloseTo(0.6, 5);
        expect(leaf.z).toBeCloseTo(0.8, 5);
        expect(leaf.size).toBeCloseTo(0.4, 5);
        // Colour goes RGB565 (palette) then RGB444 (LeafBuffer); ~4 bits/channel, loose tolerance.
        expect(leaf.r).toBeCloseTo(0.7, 1);
        expect(leaf.g).toBeCloseTo(0.2, 1);
        expect(leaf.b).toBeCloseTo(0.9, 1);
    });
});

describe('VxlV3 v5 columnar + delta leaves', () => {
    // A v3 file captured from the PRE-columnar encoder (compression:'none', 3 leaves:
    // (0,0,0) sz1 red, (1,0,0) sz1 green, (1,2,3) sz2 blue; minVoxel=1, bounds 0..16).
    const V3_FIXTURE_B64 = 'VlhMMwADAAAAAACAPwAAAEAAAIA/AAAAAAAAAAAAAAAAAACAQQAAgEEAAIBBAAEDAAEAAAAA+OAHHwADAAAAAAAAAAAABAAEAAQAAAAAAAAAAAABAAAAAAAAAQEAAgADAAEC';

    it('still decodes a legacy v3 file (back-compat)', async () => {
        const bytes = Uint8Array.from(Buffer.from(V3_FIXTURE_B64, 'base64'));
        const decoded = await decodeVxlV3(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
        const buf = decoded.fragments[0]!.leaves;
        expect(buf.count).toBe(3);
        expect([buf.gx[0], buf.gx[1], buf.gx[2]]).toEqual([0, 1, 1]);
        expect([buf.gy[0], buf.gy[1], buf.gy[2]]).toEqual([0, 0, 2]);
        expect([buf.gz[0], buf.gz[1], buf.gz[2]]).toEqual([0, 0, 3]);
        expect([buf.lod[0], buf.lod[2]]).toEqual([0, 1]); // size 1 → lod 0, size 2 → lod 1
        // RGB565 palette is converted to the same RGB444 cell the old decoder produced:
        // red, green, blue → 0xF00, 0x0F0, 0x00F.
        expect([buf.color[0], buf.color[1], buf.color[2]]).toEqual([0xF00, 0x0F0, 0x00F]);
    });

    it('encodes colors as 12-bit RGB444 cells (collapses sub-444 distinctions)', async () => {
        // 0.50 and 0.55 are DIFFERENT in RGB565 but the SAME in RGB444 (round(·*15)=8),
        // so they must share one palette entry — proof of 4-bit/channel quantization.
        const leaves: OctreeLeaf[] = [makeLeaf(0, 0, 0, 1, 0.50, 0.3, 0.3), makeLeaf(1, 0, 0, 1, 0.55, 0.3, 0.3)];
        const data: VxlV3Data = {
            minVoxelSize: 1, maxVoxelSize: 1, physicsGridStep: 1,
            bounds: { minX: 0, minY: 0, minZ: 0, maxX: 16, maxY: 16, maxZ: 16 },
            useAtlas: false, fragments: [{ aabbMin: [0, 0, 0], aabbMax: [2, 1, 1], leaves }],
        };
        const encoded = await encodeVxlV3(data, { compression: 'none' });
        const buf = (await decodeVxlV3(encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer)).fragments[0]!.leaves;
        expect(buf.color[0]).toBe(buf.color[1]);   // collapsed in RGB444
        expect(buf.color[0]! & ~0xFFF).toBe(0);     // a valid 12-bit cell (no high bits)
        expect(buf.color[0]).toBe((8 << 8) | (5 << 4) | 5); // r4=8 (0.5·15≈8), g4=b4=5 (0.3·15≈5)
    });

    it('atlas-mode assets store the sRGB atlas cell; vertex-mode stores the linear cell', async () => {
        // 0.5 grey: sRGB-encoded quantizes to r4=11, linear to r4=8 — so the stored cell
        // differs by render path. Atlas mode = the exact cell vwld stores (renders identical).
        const mk = (useAtlas: boolean): VxlV3Data => ({
            minVoxelSize: 1, maxVoxelSize: 1, physicsGridStep: 1,
            bounds: { minX: 0, minY: 0, minZ: 0, maxX: 16, maxY: 16, maxZ: 16 },
            useAtlas, fragments: [{ aabbMin: [0, 0, 0], aabbMax: [1, 1, 1], leaves: [makeLeaf(0, 0, 0, 1, 0.5, 0.5, 0.5)] }],
        });
        const cellOf = async (useAtlas: boolean): Promise<number> => {
            const e = await encodeVxlV3(mk(useAtlas), { compression: 'none' });
            return (await decodeVxlV3(e.buffer.slice(e.byteOffset, e.byteOffset + e.byteLength) as ArrayBuffer)).fragments[0]!.leaves.color[0]!;
        };
        expect(await cellOf(true)).toBe(rgb888ToAtlasCell(128, 128, 128)); // sRGB cell, == vwld
        expect(await cellOf(false)).toBe(packRgb444(0.5, 0.5, 0.5));        // linear cell
        expect(await cellOf(true)).not.toBe(await cellOf(false));          // sRGB pre-encode applied
    });

    it('round-trips coords exactly through delta (incl. decreasing / wrapping jumps)', async () => {
        // Coords that jump up and down stress the wrapping prefix-sum.
        const seq = [10, 9000, 5, 60000, 1, 32000, 7, 100];
        const leaves: OctreeLeaf[] = seq.map((g, i) => makeLeaf(g, seq[(i + 3) % seq.length]!, seq[(i + 5) % seq.length]!, 1, 1, 0, 0));
        const data: VxlV3Data = {
            minVoxelSize: 1, maxVoxelSize: 1, physicsGridStep: 1,
            bounds: { minX: 0, minY: 0, minZ: 0, maxX: 65536, maxY: 65536, maxZ: 65536 },
            useAtlas: false, fragments: [{ aabbMin: [0, 0, 0], aabbMax: [65536, 65536, 65536], leaves }],
        };
        const encoded = await encodeVxlV3(data, { compression: 'none' });
        const decoded = await decodeVxlV3(encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer);
        const buf = decoded.fragments[0]!.leaves;
        seq.forEach((g, i) => {
            expect(buf.gx[i]).toBe(g);
            expect(buf.gy[i]).toBe(seq[(i + 3) % seq.length]!);
            expect(buf.gz[i]).toBe(seq[(i + 5) % seq.length]!);
        });
    });

    it('columnar + delta makes octree-ordered leaves gzip far smaller than shuffled', async () => {
        // A spatially-coherent leaf walk (octree order) vs the same leaves shuffled.
        // Columnar + delta crush the ordered one; without it the two gzip ~the same.
        let s = 98765;
        const rnd = (): number => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s; };
        let x = 200, y = 200, z = 200;
        const step = (v: number): number => Math.max(0, Math.min(511, v + (rnd() % 7) - 3));
        const base: OctreeLeaf[] = [];
        for (let i = 0; i < 20000; i++) { x = step(x); y = step(y); z = step(z); base.push(makeLeaf(x, y, z, 1, (rnd() % 8) / 8, 0, 0)); }
        const shuffled = [...base];
        for (let i = shuffled.length - 1; i > 0; i--) { const j = rnd() % (i + 1); [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]; }
        const mk = (leaves: OctreeLeaf[]): VxlV3Data => ({
            minVoxelSize: 1, maxVoxelSize: 1, physicsGridStep: 1,
            bounds: { minX: 0, minY: 0, minZ: 0, maxX: 512, maxY: 512, maxZ: 512 },
            useAtlas: false, fragments: [{ aabbMin: [0, 0, 0], aabbMax: [512, 512, 512], leaves }],
        });
        const gzOrdered = zlib.gzipSync(Buffer.from(await encodeVxlV3(mk(base), { compression: 'none' }))).length;
        const gzShuffled = zlib.gzipSync(Buffer.from(await encodeVxlV3(mk(shuffled), { compression: 'none' }))).length;
        expect(gzOrdered).toBeLessThan(gzShuffled * 0.7);
    });
});
