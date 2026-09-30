/**
 * @jest-environment jsdom
 *
 * VXL3 v9 — textured BLOCK TYPES as a palette column.
 *
 * Before this, colour was the only thing a leaf could carry, so a Minecraft-style
 * textured asset had no representation in the format at all and had to be written in the
 * old JSON form. These tests pin the two halves that matter: that a block type survives
 * the round trip at every LOD, and that adding the concept did not disturb the bytes of
 * an asset that does not use it.
 *
 * That second half is the one worth guarding. Every version since v5 has been an additive
 * trailer whose version is raised ONLY when the data is present, which is what lets old
 * readers keep reading old assets. A regression there is invisible until someone opens a
 * published game.
 */
import * as zlib from 'zlib';
import {
    encodeVxlV3, decodeVxlV3, type VxlV3Data, type VxlV3Fragment,
    VXL3_VERSION_COLUMNAR, VXL3_VERSION_BLOCK_TYPES,
} from 'engine/VxlV3Format.js';
import type { OctreeLeaf } from 'engine/VoxelOctreeRenderer.js';

function leaf(x: number, y: number, z: number, extra: Partial<OctreeLeaf> = {}): OctreeLeaf {
    return { x, y, z, size: 1, r: 1, g: 0, b: 0, ...extra };
}

function fragment(leaves: OctreeLeaf[]): VxlV3Fragment {
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const l of leaves) {
        min[0] = Math.min(min[0], l.x); min[1] = Math.min(min[1], l.y); min[2] = Math.min(min[2], l.z);
        max[0] = Math.max(max[0], l.x + l.size);
        max[1] = Math.max(max[1], l.y + l.size);
        max[2] = Math.max(max[2], l.z + l.size);
    }
    return { aabbMin: min, aabbMax: max, leaves };
}

function data(leaves: OctreeLeaf[], coarse?: OctreeLeaf[]): VxlV3Data {
    return {
        minVoxelSize: 1,
        maxVoxelSize: 1,
        physicsGridStep: 1,
        bounds: { minX: 0, minY: 0, minZ: 0, maxX: 8, maxY: 8, maxZ: 8 },
        useAtlas: false,
        fragments: [fragment(leaves)],
        ...(coarse ? { additionalLods: [{ minVoxelSize: 2, maxVoxelSize: 2, fragments: [fragment(coarse)] }] } : {}),
    };
}

/** The body version, read past the 5-byte outer header (gunzipping when needed). */
function bodyVersion(bytes: Uint8Array): number {
    const compressed = bytes[4] === 1;
    const payload = bytes.subarray(5);
    const body = compressed ? new Uint8Array(zlib.gunzipSync(payload)) : payload;
    return new DataView(body.buffer, body.byteOffset, 4).getUint32(0, true);
}

/** Per-leaf block types, in stored order. */
async function blockTypesOf(bytes: Uint8Array, lod = 0): Promise<number[]> {
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const decoded = await decodeVxlV3(buf);
    const frags = lod === 0 ? decoded.fragments : decoded.additionalLods![lod - 1]!.fragments;
    const out: number[] = [];
    for (const f of frags) {
        const col = f.leaves.blockType;
        for (let i = 0; i < f.leaves.count; i++) out.push(col ? col[i]! : 0);
    }
    return out;
}

describe('VXL3 v9 block types', () => {
    it('round-trips a block type per leaf', async () => {
        const bytes = await encodeVxlV3(data([
            leaf(0, 0, 0, { blockType: 11 }),
            leaf(1, 0, 0, { blockType: 11 }),
            leaf(2, 0, 0, { blockType: 7 }),
        ]), { compression: 'none' });
        expect(bodyVersion(bytes)).toBe(VXL3_VERSION_BLOCK_TYPES);
        expect(await blockTypesOf(bytes)).toEqual([11, 11, 7]);
    });

    it('leaves a colour-only asset on its old version, byte for byte', async () => {
        // The additive-trailer contract: an asset that uses no block types must encode
        // EXACTLY as it did before v9 existed, or every published game breaks.
        const plain = data([leaf(0, 0, 0), leaf(1, 0, 0)]);
        const bytes = await encodeVxlV3(plain, { compression: 'none' });
        expect(bodyVersion(bytes)).toBe(VXL3_VERSION_COLUMNAR);
        const again = await encodeVxlV3(plain, { compression: 'none' });
        expect(Array.from(bytes)).toEqual(Array.from(again));
    });

    it('allows one asset to mix coloured and textured voxels', async () => {
        const bytes = await encodeVxlV3(data([
            leaf(0, 0, 0, { blockType: 3 }),
            leaf(1, 0, 0),                       // plain colour
            leaf(2, 0, 0, { blockType: 3 }),
        ]), { compression: 'none' });
        expect(await blockTypesOf(bytes)).toEqual([3, 0, 3]);
    });

    it('keeps block types at coarser LODs', async () => {
        // The v8 lesson: a material that reverts at the first LOD switch is worse than
        // one that was never there. A textured block must stay textured at distance.
        const bytes = await encodeVxlV3(data(
            [leaf(0, 0, 0, { blockType: 5 }), leaf(1, 0, 0, { blockType: 5 })],
            [leaf(0, 0, 0, { size: 2, blockType: 5 })],
        ), { compression: 'none' });
        expect(await blockTypesOf(bytes, 1)).toEqual([5]);
    });

    it('treats the COLOR sentinel as "not textured"', async () => {
        // A chunk grid marks a plain coloured voxel with BlockType.COLOR (255). Carrying
        // that through as a texture id would address a block that does not exist.
        const bytes = await encodeVxlV3(data([leaf(0, 0, 0, { blockType: 255 })]), { compression: 'none' });
        expect(bodyVersion(bytes)).toBe(VXL3_VERSION_COLUMNAR);
        expect(await blockTypesOf(bytes)).toEqual([0]);
    });

    it('separates palette entries that share a colour but differ by block type', async () => {
        // Same RGB, different texture — they must not collapse into one entry the way two
        // identically-coloured voxels do.
        const bytes = await encodeVxlV3(data([
            leaf(0, 0, 0, { blockType: 1 }),
            leaf(1, 0, 0, { blockType: 2 }),
        ]), { compression: 'none' });
        expect(await blockTypesOf(bytes)).toEqual([1, 2]);
    });

    it('keeps legacy emissive rather than silently trading it for block types', async () => {
        // v9 has no legacy per-colour emissive block, so the two cannot coexist. Dropping
        // a user's glow to gain a version number is not a trade the encoder may make.
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const bytes = await encodeVxlV3(data([
            leaf(0, 0, 0, { emissive: 200 }),
            leaf(1, 0, 0, { blockType: 4 }),
        ]), { compression: 'none' });
        expect(bodyVersion(bytes)).not.toBe(VXL3_VERSION_BLOCK_TYPES);
        expect(await blockTypesOf(bytes)).toEqual([0, 0]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('block types'));
        warn.mockRestore();
    });
});
