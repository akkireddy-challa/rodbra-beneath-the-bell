/**
 * @jest-environment jsdom
 */
import { encodeVxlV3, decodeVxlV3, type VxlV3Data, type VxlV3Fragment } from 'engine/VxlV3Format.js';
import type { OctreeLeaf } from 'engine/VoxelOctreeRenderer.js';

function leaf(x: number, y: number, z: number, size: number, r: number, g: number, b: number, emissive = 0): OctreeLeaf {
    return { x, y, z, size, r, g, b, emissive };
}
function frag(leaves: OctreeLeaf[]): VxlV3Fragment {
    return { aabbMin: [0, 0, 0], aabbMax: [1.6, 1.6, 1.6], leaves };
}
const base = (fragments: VxlV3Fragment[]): VxlV3Data => ({
    minVoxelSize: 0.1, maxVoxelSize: 0.4, physicsGridStep: 0.1,
    bounds: { minX: 0, minY: 0, minZ: 0, maxX: 1.6, maxY: 1.6, maxZ: 1.6 },
    useAtlas: true, fragments,
});
const roundtrip = async (d: VxlV3Data): Promise<Awaited<ReturnType<typeof decodeVxlV3>>> => {
    const enc = await encodeVxlV3(d, { compression: 'none' });
    return decodeVxlV3(enc.buffer.slice(enc.byteOffset, enc.byteOffset + enc.byteLength) as ArrayBuffer);
};

describe('VXL v6 emissive', () => {
    test('emissive is per-color: leaves sharing a color share emissive', async () => {
        // two red leaves (emissive 200) + one green leaf (emissive 0)
        const dec = await roundtrip(base([frag([
            leaf(0, 0, 0, 0.1, 1, 0, 0, 200),
            leaf(0.1, 0, 0, 0.1, 1, 0, 0, 200),
            leaf(0.2, 0, 0, 0.1, 0, 1, 0, 0),
        ])]));
        const buf = dec.fragments[0]!.leaves;
        expect(buf.emiss).not.toBeNull();
        expect(buf.emiss![0]).toBe(200);
        expect(buf.emiss![1]).toBe(200);
        expect(buf.emiss![2]).toBe(0);
    });

    test('no emissive → v5, emiss column null, byte-identical to pre-change encoder', async () => {
        const d = base([frag([leaf(0, 0, 0, 0.1, 0.5, 0.5, 0.5, 0)])]);
        const enc = await encodeVxlV3(d, { compression: 'none' });
        // version field is the first 4 bytes of the body (after the 5-byte wrapper).
        const body = new Uint8Array(enc.buffer, enc.byteOffset + 5);
        const version = new DataView(body.buffer, body.byteOffset, 4).getUint32(0, true);
        expect(version).toBe(5);
        const dec = await roundtrip(d);
        expect(dec.fragments[0]!.leaves.emiss).toBeNull();
    });

    test('emissive present → version 6', async () => {
        const d = base([frag([leaf(0, 0, 0, 0.1, 1, 1, 1, 255)])]);
        const enc = await encodeVxlV3(d, { compression: 'none' });
        const version = new DataView(enc.buffer, enc.byteOffset + 5, 4).getUint32(0, true);
        expect(version).toBe(6);
    });

    test('decode → forEach → re-encode preserves emissive (Task-6 re-save shape)', async () => {
        // Two emissive red leaves + one non-emissive green leaf, matching the first test's mix.
        const original = base([frag([
            leaf(0, 0, 0, 0.1, 1, 0, 0, 200),
            leaf(0.1, 0, 0, 0.1, 1, 0, 0, 200),
            leaf(0.2, 0, 0, 0.1, 0, 1, 0, 0),
        ])]);
        const dec = await roundtrip(original);

        // Rebuild a VxlV3Data by walking each decoded fragment's LeafBuffer via forEach into
        // OctreeLeaf[] — the same shape a decode → edit → re-save round trip produces.
        const rebuiltFragments: VxlV3Fragment[] = dec.fragments.map((f) => {
            const leaves: OctreeLeaf[] = [];
            f.leaves.forEach((l) => {
                leaves.push({ x: l.x, y: l.y, z: l.z, size: l.size, r: l.r, g: l.g, b: l.b, emissive: l.emissive });
            });
            return { aabbMin: f.aabbMin, aabbMax: f.aabbMax, leaves };
        });
        const rebuilt: VxlV3Data = {
            minVoxelSize: dec.minVoxelSize,
            maxVoxelSize: dec.maxVoxelSize,
            physicsGridStep: dec.physicsGridStep,
            bounds: dec.bounds,
            useAtlas: dec.useAtlas,
            fragments: rebuiltFragments,
        };

        const redec = await roundtrip(rebuilt);
        const buf = redec.fragments[0]!.leaves;
        expect(buf.emiss).not.toBeNull();
        expect(buf.emiss![0]).toBe(200);
        expect(buf.emiss![1]).toBe(200);
        expect(buf.emiss![2]).toBe(0);
    });
});
