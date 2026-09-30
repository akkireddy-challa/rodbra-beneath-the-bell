import { compileVoxelModelToVwld, DEFAULT_VOXEL_LEVEL_IMPORT_OPTIONS } from 'engine/import/VoxelModelToLevel.js';
import type { CompiledVoxelModel } from 'engine/import/VoxelModelCompiler.js';
import { decodeVxlScene } from 'engine/vxlscene/VxlSceneFormat.js';
import { packCell } from 'engine/vxlscene/SurfaceRasterizer.js';

function model(cells: Array<[number, number, number, number]>): CompiledVoxelModel {
    const map = new Map<number, number>();
    let sx = 0, sy = 0, sz = 0;
    for (const [x, y, z, rgb] of cells) {
        map.set(packCell(x, y, z), rgb);
        sx = Math.max(sx, x + 1); sy = Math.max(sy, y + 1); sz = Math.max(sz, z + 1);
    }
    return { name: 'level', sizeX: sx, sizeY: sy, sizeZ: sz, cells: map, cellsEmissive: null };
}

describe('compileVoxelModelToVwld', () => {
    test('single cube: one chunk pair around origin, quads only, no voxels', async () => {
        const r = await compileVoxelModelToVwld(model([[0, 0, 0, 0xff8000]]), {
            ...DEFAULT_VOXEL_LEVEL_IMPORT_OPTIONS, voxelSize: 0.5, chunkSize: 8, additionalLods: [],
        });
        expect(r.nonEmptyChunkCount).toBeGreaterThanOrEqual(1);
        expect(r.totalLod0Cells).toBe(1);
        const d = await decodeVxlScene(r.vwldBytes);
        expect(d.chunkSize).toBe(8);
        expect(d.minVoxelSize).toBe(0.5);
        expect(d.lodDistances).toEqual([1e9]);
        const totalQuads = d.chunks.reduce((s, c) => s + c.lodHints[0]!.count, 0);
        expect(totalQuads).toBe(6); // a lone cube exposes 6 faces
        for (const c of d.chunks) expect(c.voxels.count).toBe(0);
    });

    test('model is XZ-centered: a 2-wide model spans chunks cx=-1 and cx=0', async () => {
        const r = await compileVoxelModelToVwld(model([[0, 0, 0, 0xffffff], [1, 0, 0, 0xffffff]]), {
            ...DEFAULT_VOXEL_LEVEL_IMPORT_OPTIONS, voxelSize: 1, chunkSize: 8, additionalLods: [],
        });
        const d = await decodeVxlScene(r.vwldBytes);
        const cxs = d.chunks.map(c => c.cx).sort((a, b) => a - b);
        expect(cxs).toEqual([-1, 0]);
        expect(r.worldBounds.minX).toBe(-8);
        expect(r.worldBounds.maxX).toBe(8);
        expect(r.worldBounds.minY).toBe(0);
    });

    test('additional LODs are emitted and clamped, distances carried', async () => {
        const cells: Array<[number, number, number, number]> = [];
        for (let x = 0; x < 8; x++) for (let z = 0; z < 8; z++) cells.push([x, 0, z, 0x808080]);
        const r = await compileVoxelModelToVwld(model(cells), {
            ...DEFAULT_VOXEL_LEVEL_IMPORT_OPTIONS, voxelSize: 1, chunkSize: 8,
            additionalLods: [{ distance: 40 }, { distance: 90 }],
        });
        const d = await decodeVxlScene(r.vwldBytes);
        expect(d.lodDistances).toEqual([40, 90, 1e9]);
        for (const c of d.chunks) expect(c.lodHints.length).toBe(3);
    });

    test('non power-of-two chunk/voxel ratio throws', async () => {
        await expect(compileVoxelModelToVwld(model([[0, 0, 0, 1]]), {
            ...DEFAULT_VOXEL_LEVEL_IMPORT_OPTIONS, voxelSize: 0.3, chunkSize: 16, additionalLods: [],
        })).rejects.toThrow(/power-of-two/i);
    });

    test('solid two-chunk slab: seam quads emitted, total LOD0 quad count locked', async () => {
        // 16x2x1 solid slab, XZ-centered -> global x in [-8,8), split into chunks
        // cx=-1 and cx=0 at chunkSize 8 / voxelSize 1. Each 8x2x1 chunk box greedy-
        // meshes to 6 quads: top, bottom, +Z, -Z, the outer X end, and the face at
        // the chunk seam — the neighbor cell lives in the OTHER chunk's grid, so
        // per-chunk meshing cannot cull it (documented accepted cost). Total = 12.
        const cells: Array<[number, number, number, number]> = [];
        for (let x = 0; x < 16; x++) for (let y = 0; y < 2; y++) cells.push([x, y, 0, 0x808080]);
        const r = await compileVoxelModelToVwld(model(cells), {
            ...DEFAULT_VOXEL_LEVEL_IMPORT_OPTIONS, voxelSize: 1, chunkSize: 8, additionalLods: [],
        });
        expect(r.totalLod0Cells).toBe(32);
        const d = await decodeVxlScene(r.vwldBytes);
        expect(d.chunks.length).toBe(2);
        expect(d.chunks.map(c => c.cx).sort((a, b) => a - b)).toEqual([-1, 0]);
        const totalQuads = d.chunks.reduce((s, c) => s + c.lodHints[0]!.count, 0);
        expect(totalQuads).toBe(12);
    });

    test('coarse LOD at negative chunk coords: origin math locked', async () => {
        // Same slab with one additional LOD. Chunk cx=-1 downsamples (2x) to a
        // 4x1x1 row at coarse x in [-4,-1], y=0. Its top face merges into ONE quad
        // (coarse origin (-4,0,0), extents z=1 x=4); localizeChunkResQuads with
        // chunkCellsPerAxis=4, f=2 maps it to local gx=0, gy=0*2+1=1 (far-face
        // adjust on the quad's own axis), w=2, h=8 -> w*h=16 min-cells.
        const cells: Array<[number, number, number, number]> = [];
        for (let x = 0; x < 16; x++) for (let y = 0; y < 2; y++) cells.push([x, y, 0, 0x808080]);
        const r = await compileVoxelModelToVwld(model(cells), {
            ...DEFAULT_VOXEL_LEVEL_IMPORT_OPTIONS, voxelSize: 1, chunkSize: 8,
            additionalLods: [{ distance: 40 }],
        });
        const d = await decodeVxlScene(r.vwldBytes);
        const chunk = d.chunks.find(c => c.cx === -1);
        expect(chunk).toBeDefined();
        const lod1 = chunk!.lodHints[1]!;
        // axisDir packing (VxlSceneFormat): axis = bits [1:0], dir sign = bit 2 (0 -> +1).
        const topFaces: number[] = [];
        for (let i = 0; i < lod1.count; i++) {
            const axis = lod1.axisDir[i]! & 3;
            const dirPositive = (lod1.axisDir[i]! & 4) === 0;
            if (axis === 1 && dirPositive) topFaces.push(i);
        }
        expect(topFaces.length).toBe(1);
        const q = topFaces[0]!;
        expect(lod1.gy[q]).toBe(1);
        expect(lod1.w[q]! * lod1.h[q]!).toBe(16);
    });
});
