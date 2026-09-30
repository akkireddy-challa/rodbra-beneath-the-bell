import { compileVoxelModelToVxlAsset, DEFAULT_VOXEL_ASSET_IMPORT_OPTIONS, srgbByteToLinear } from 'engine/import/VoxelModelToAsset.js';
import type { CompiledVoxelModel } from 'engine/import/VoxelModelCompiler.js';
import { decodeVxlV3 } from 'engine/VxlV3Format.js';
import { packCell } from 'engine/vxlscene/SurfaceRasterizer.js';
import { rgb888ToAtlasCell } from 'engine/vxlscene/atlasColor.js';

function model(cells: Array<[number, number, number, number]>): CompiledVoxelModel {
    const map = new Map<number, number>();
    let sx = 0, sy = 0, sz = 0;
    for (const [x, y, z, rgb] of cells) {
        map.set(packCell(x, y, z), rgb);
        sx = Math.max(sx, x + 1); sy = Math.max(sy, y + 1); sz = Math.max(sz, z + 1);
    }
    return { name: 'test', sizeX: sx, sizeY: sy, sizeZ: sz, cells: map, cellsEmissive: null };
}

const expectedCell = (rgb: number): number => rgb888ToAtlasCell(
    Math.round(srgbByteToLinear((rgb >> 16) & 255) * 255),
    Math.round(srgbByteToLinear((rgb >> 8) & 255) * 255),
    Math.round(srgbByteToLinear(rgb & 255) * 255),
);

describe('compileVoxelModelToVxlAsset', () => {
    test('round-trip: bounds centered on XZ, ground at Y=0, positions/colors survive', async () => {
        // Asymmetric 2x1x1 model so a mirroring bug fails loudly.
        const m = model([[0, 0, 0, 0xff0000], [1, 0, 0, 0x00ff00]]);
        const r = await compileVoxelModelToVxlAsset(m, { ...DEFAULT_VOXEL_ASSET_IMPORT_OPTIONS, voxelSize: 0.5, additionalLodCount: 0 });
        expect(r.totalVoxels).toBe(2);
        expect(r.bounds).toEqual({ minX: -0.5, minY: 0, minZ: -0.25, maxX: 0.5, maxY: 0.5, maxZ: 0.25 });
        const d = await decodeVxlV3(r.vxlBytes.buffer.slice(r.vxlBytes.byteOffset, r.vxlBytes.byteOffset + r.vxlBytes.byteLength) as ArrayBuffer);
        expect(d.minVoxelSize).toBe(0.5);
        expect(d.useAtlas).toBe(true);
        expect(d.fragments).toHaveLength(1);
        // decodeVxlV3 returns fragment AABBs in world-absolute units (same space as
        // leaf coords, i.e. bounds.min added back) — must equal `bounds` here since
        // this fragment spans the model's full extent.
        expect(d.fragments[0]!.aabbMin[0]).toBeCloseTo(-0.5);
        expect(d.fragments[0]!.aabbMin[1]).toBeCloseTo(0);
        expect(d.fragments[0]!.aabbMin[2]).toBeCloseTo(-0.25);
        expect(d.fragments[0]!.aabbMax[0]).toBeCloseTo(0.5);
        expect(d.fragments[0]!.aabbMax[1]).toBeCloseTo(0.5);
        expect(d.fragments[0]!.aabbMax[2]).toBeCloseTo(0.25);
        const leaves = d.fragments[0]!.leaves;
        expect(leaves.count).toBe(2);
        const got = new Map<number, number>();
        for (let i = 0; i < leaves.count; i++) got.set(leaves.gx[i]! * 10 + leaves.gz[i]!, leaves.color[i]!);
        expect(got.get(0)).toBe(expectedCell(0xff0000)); // gx 0
        expect(got.get(10)).toBe(expectedCell(0x00ff00)); // gx 1
    });

    test('auto-generates coarser LODs by majority downsample', async () => {
        const cells: Array<[number, number, number, number]> = [];
        for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) for (let z = 0; z < 4; z++) {
            cells.push([x, y, z, 0x336699]);
        }
        const r = await compileVoxelModelToVxlAsset(model(cells), { ...DEFAULT_VOXEL_ASSET_IMPORT_OPTIONS, voxelSize: 0.25, additionalLodCount: 2 });
        expect(r.lodCount).toBe(3);
        expect(r.voxelsPerLod).toEqual([64, 8, 1]);
    });

    test('auto-coarsens over the leaf budget with a warning', async () => {
        const cells: Array<[number, number, number, number]> = [];
        for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) for (let z = 0; z < 4; z++) {
            cells.push([x, y, z, 0xffffff]);
        }
        const r = await compileVoxelModelToVxlAsset(model(cells), { voxelSize: 0.1, additionalLodCount: 0, maxLeaves: 10 });
        expect(r.warning).toMatch(/budget/i);
        expect(r.totalVoxels).toBeLessThanOrEqual(10);
        expect(r.effectiveVoxelSize).toBeCloseTo(0.2); // one 2x coarsen step: 64 → 8 leaves
    });

    test('physicsGridStep follows the GLB voxelizer formula', async () => {
        const r = await compileVoxelModelToVxlAsset(model([[0, 0, 0, 0xffffff]]), { voxelSize: 0.1, additionalLodCount: 0, maxLeaves: 1000 });
        const d = await decodeVxlV3(r.vxlBytes.buffer.slice(r.vxlBytes.byteOffset, r.vxlBytes.byteOffset + r.vxlBytes.byteLength) as ArrayBuffer);
        expect(d.physicsGridStep).toBeCloseTo(0.4); // clamp(0.1*4, 0.1, 0.5)
    });
});
