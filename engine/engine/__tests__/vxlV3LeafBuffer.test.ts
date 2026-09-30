import { encodeVxlV3, decodeVxlV3, type VxlV3Data } from 'engine/VxlV3Format.js';
import { LeafBuffer, packRgb444, unpackRgb444, type OctreeLeaf } from 'engine/VoxelOctreeRenderer.js';

const leaf = (x: number, y: number, z: number, size: number, r: number, g: number, b: number): OctreeLeaf => ({ x, y, z, size, r, g, b });

describe('LeafBuffer', () => {
    it('packs/unpacks RGB444 within 1/15 quantisation', () => {
        for (const [r, g, b] of [[0, 0, 0], [1, 1, 1], [1, 0, 0], [0.5, 0.25, 0.75]] as const) {
            const u = unpackRgb444(packRgb444(r, g, b));
            expect(Math.abs(u.r - r)).toBeLessThanOrEqual(1 / 15 + 1e-6);
            expect(Math.abs(u.g - g)).toBeLessThanOrEqual(1 / 15 + 1e-6);
            expect(Math.abs(u.b - b)).toBeLessThanOrEqual(1 / 15 + 1e-6);
        }
    });

    it('is far smaller than the object form (~9 vs ~28+ raw bytes/leaf)', () => {
        const n = 1000;
        const buf = new LeafBuffer(n, 1, 0, 0, 0);
        const rawBytes = buf.gx.byteLength + buf.gy.byteLength + buf.gz.byteLength + buf.lod.byteLength + buf.color.byteLength;
        expect(rawBytes).toBe(n * 9); // 3×u16 + u8 + u16
    });

    it('fromArray → toArray round-trips position/size exactly, colour within RGB444', () => {
        const src = [leaf(0, 0, 0, 1, 1, 0, 0), leaf(3, 5, 7, 4, 0.5, 0.5, 0.5)];
        const round = LeafBuffer.fromArray(src, 1, 0, 0, 0).toArray();
        for (let i = 0; i < src.length; i++) {
            expect(round[i]!.x).toBeCloseTo(src[i]!.x);
            expect(round[i]!.size).toBeCloseTo(src[i]!.size);
            expect(Math.abs(round[i]!.r - src[i]!.r)).toBeLessThanOrEqual(1 / 15 + 1e-6);
        }
    });
});

describe('VxlV3 encode (OctreeLeaf[]) → decode (LeafBuffer) round-trip', () => {
    it('preserves grid position + size and colour within RGB444 precision', async () => {
        const leaves: OctreeLeaf[] = [
            leaf(0, 0, 0, 1, 1, 0, 0),
            leaf(1, 2, 3, 1, 0, 1, 0),
            leaf(5, 5, 5, 2, 0, 0, 1),
            leaf(10, 0, 10, 1, 1, 1, 1),
        ];
        const data: VxlV3Data = {
            minVoxelSize: 1, maxVoxelSize: 2, physicsGridStep: 1,
            bounds: { minX: 0, minY: 0, minZ: 0, maxX: 12, maxY: 8, maxZ: 12 },
            useAtlas: false,
            fragments: [{ aabbMin: [0, 0, 0], aabbMax: [12, 8, 12], leaves }],
        };
        const bytes = await encodeVxlV3(data);
        const decoded = await decodeVxlV3(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);

        expect(decoded.fragments.length).toBe(1);
        const buf = decoded.fragments[0]!.leaves;
        expect(buf).toBeInstanceOf(LeafBuffer);
        expect(buf.count).toBe(leaves.length);

        const round = buf.toArray();
        for (let i = 0; i < leaves.length; i++) {
            const a = leaves[i]!, b = round[i]!;
            expect(b.x).toBeCloseTo(a.x); expect(b.y).toBeCloseTo(a.y); expect(b.z).toBeCloseTo(a.z);
            expect(b.size).toBeCloseTo(a.size);
            // Colour goes RGB->565(palette)->888->444, so allow a touch over one RGB444 step.
            expect(Math.abs(b.r - a.r)).toBeLessThanOrEqual(0.12);
            expect(Math.abs(b.g - a.g)).toBeLessThanOrEqual(0.12);
            expect(Math.abs(b.b - a.b)).toBeLessThanOrEqual(0.12);
        }
    });
});
