import { parseVox, isVoxFile } from 'engine/import/VoxParser.js';
import { VOX_DEFAULT_PALETTE } from 'engine/import/VoxDefaultPalette.js';
import {
    buildVoxBytes,
    buildVoxBytesFromChunks,
    ByteWriter,
    voxChunk,
    voxDict,
    voxSingleVoxelModel,
} from 'engine/__tests__/helpers/voxelImportFixtures.js';

describe('VoxParser', () => {
    test('isVoxFile detects magic', () => {
        const buf = buildVoxBytes({ models: [{ sizeX: 1, sizeY: 1, sizeZ: 1, voxels: [[0, 0, 0, 1]] }] });
        expect(isVoxFile(buf)).toBe(true);
        expect(isVoxFile(new ArrayBuffer(4))).toBe(false);
    });

    test('single model with custom palette', () => {
        const buf = buildVoxBytes({
            models: [{ sizeX: 2, sizeY: 1, sizeZ: 3, voxels: [[0, 0, 0, 1], [1, 0, 2, 2]] }],
            palette: [[255, 0, 0, 255], [0, 255, 0, 255]], // color 1 red, color 2 green
        });
        const f = parseVox(buf);
        expect(f.format).toBe('vox');
        expect(f.grids).toHaveLength(1);
        expect(f.grids[0]!.sizeX).toBe(2);
        expect(f.grids[0]!.sizeZ).toBe(3);
        expect(Array.from(f.grids[0]!.voxels)).toEqual([0, 0, 0, 1, 1, 0, 2, 2]);
        // color index 1 → palette bytes at 1*4
        expect(Array.from(f.palette.slice(4, 8))).toEqual([255, 0, 0, 255]);
        expect(Array.from(f.palette.slice(8, 12))).toEqual([0, 255, 0, 255]);
        expect(f.instances).toHaveLength(1);
        expect(f.instances[0]!.gridIndex).toBe(0);
        expect(f.instances[0]!.rotation).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    });

    test('no RGBA chunk falls back to the canonical default palette', () => {
        const buf = buildVoxBytes({ models: [{ sizeX: 1, sizeY: 1, sizeZ: 1, voxels: [[0, 0, 0, 1]] }] });
        const f = parseVox(buf);
        expect(f.palette).toBe(VOX_DEFAULT_PALETTE);
        // canonical spot checks: index 1 = white, index 7 = (255,204,255), index 255 = (17,17,17)
        expect(Array.from(f.palette.slice(1 * 4, 1 * 4 + 4))).toEqual([255, 255, 255, 255]);
        expect(Array.from(f.palette.slice(7 * 4, 7 * 4 + 3))).toEqual([255, 204, 255]);
        expect(Array.from(f.palette.slice(255 * 4, 255 * 4 + 3))).toEqual([17, 17, 17]);
    });

    test('scene graph: translation, rotation byte, names', () => {
        const buf = buildVoxBytes({
            models: [
                { sizeX: 1, sizeY: 1, sizeZ: 1, voxels: [[0, 0, 0, 1]] },
                { sizeX: 2, sizeY: 2, sizeZ: 2, voxels: [[1, 0, 1, 2]] },
            ],
            scene: [
                { model: 0, translation: [8, -4, 2], name: 'lamp' },
                // (1<<0)|(2<<2)|(1<<4): row0 = -Y, row1 = +Z, row2 = +X
                { model: 1, rotationByte: (1 << 0) | (2 << 2) | (1 << 4) },
            ],
        });
        const f = parseVox(buf);
        expect(f.instances).toHaveLength(2);
        expect(f.instances[0]!.translation).toEqual([8, -4, 2]);
        expect(f.instances[0]!.name).toBe('lamp');
        expect(f.instances[1]!.rotation).toEqual([0, -1, 0, 0, 0, 1, 1, 0, 0]);
    });

    test('non-emit MATL chunk produces an informational note', () => {
        const buf = buildVoxBytes({
            models: [{ sizeX: 1, sizeY: 1, sizeZ: 1, voxels: [[0, 0, 0, 1]] }],
            materials: [{ id: 1, type: '_metal' }],
        });
        const f = parseVox(buf);
        expect(f.notes.some(n => n.includes('material'))).toBe(true);
    });

    test('truncated buffer throws a readable error', () => {
        const good = new Uint8Array(buildVoxBytes({ models: [{ sizeX: 1, sizeY: 1, sizeZ: 1, voxels: [[0, 0, 0, 1]] }] }));
        const truncated = good.slice(0, good.length - 6).buffer;
        expect(() => parseVox(truncated)).toThrow(/truncated|unexpected end/i);
    });

    test('non-vox buffer throws', () => {
        expect(() => parseVox(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer)).toThrow(/not a magicavoxel/i);
    });

    test('negative chunk sizes throw instead of hanging', () => {
        // Valid SIZE+XYZI for one model, then a corrupt trailing chunk whose
        // declared childBytes is negative — this used to move r.offset BACKWARD
        // and hang the MAIN-children loop forever.
        const children = new ByteWriter();
        voxSingleVoxelModel(children);
        // Fake chunk: 4CC 'ZZZZ', contentBytes 0, childBytes -12 (0xFFFFFFF4).
        children.raw(voxChunk('ZZZZ', new ByteWriter(), undefined, { contentBytes: 0, childrenBytes: -12 }).toUint8());

        const buf = buildVoxBytesFromChunks(children);
        expect(() => parseVox(buf)).toThrow(/negative chunk size/i);
    });

    test('scene-graph cycle throws instead of overflowing', () => {
        // nTRN(0) -> child 1; nGRP(1) -> children [0, 2]; nSHP(2) -> model 0.
        // Node 0 is reachable from node 1, which is reachable from node 0: a cycle.
        // Every node id is referenced by some other node, so root-detection falls
        // back to node 0, and the walk hits the cycle immediately.
        const children = new ByteWriter();
        voxSingleVoxelModel(children);

        const trn0 = new ByteWriter();
        trn0.i32(0); voxDict(trn0, {}); trn0.i32(1).i32(-1).i32(-1).i32(1); voxDict(trn0, {});
        children.raw(voxChunk('nTRN', trn0).toUint8());

        const grp1 = new ByteWriter();
        grp1.i32(1); voxDict(grp1, {}); grp1.i32(2).i32(0).i32(2);
        children.raw(voxChunk('nGRP', grp1).toUint8());

        const shp2 = new ByteWriter();
        shp2.i32(2); voxDict(shp2, {}); shp2.i32(1); shp2.i32(0); voxDict(shp2, {});
        children.raw(voxChunk('nSHP', shp2).toUint8());

        const buf = buildVoxBytesFromChunks(children);
        expect(() => parseVox(buf)).toThrow(/cycle/i);
    });

    test('malformed _t values become 0, not NaN', () => {
        const buf = buildVoxBytes({
            models: [{ sizeX: 1, sizeY: 1, sizeZ: 1, voxels: [[0, 0, 0, 1]] }],
            scene: [{ model: 0, rawTranslation: 'x y z' }],
        });
        const f = parseVox(buf);
        expect(f.instances).toHaveLength(1);
        expect(f.instances[0]!.translation).toEqual([0, 0, 0]);
        for (const v of f.instances[0]!.translation) expect(Number.isNaN(v)).toBe(false);
    });

    test('rotated child translation composes through parent rotation', () => {
        // Single-level: identity-rotation parent, translation and rotation both
        // present on the leaf placement — instance should carry them as-is.
        const rotByte = (1 << 0) | (2 << 2) | (1 << 4);
        const singleLevel = buildVoxBytes({
            models: [{ sizeX: 1, sizeY: 1, sizeZ: 1, voxels: [[0, 0, 0, 1]] }],
            scene: [{ model: 0, rotationByte: rotByte, translation: [5, 0, 0] }],
        });
        const f1 = parseVox(singleLevel);
        expect(f1.instances).toHaveLength(1);
        expect(f1.instances[0]!.rotation).toEqual([0, -1, 0, 0, 0, 1, 1, 0, 0]);
        expect(f1.instances[0]!.translation).toEqual([5, 0, 0]);

        // Two-level: root nTRN(0, t=[10,0,0], no rotation) -> nGRP(1) ->
        // nTRN(2, r=rotByte, t=[1,2,3]) -> nSHP(3, model 0).
        // Root has no rotation, so translation composes additively:
        // [10,0,0] + Identity*[1,2,3] = [11,2,3]; rotation is the leaf's alone.
        const children = new ByteWriter();
        voxSingleVoxelModel(children);

        const trn0 = new ByteWriter();
        trn0.i32(0); voxDict(trn0, {}); trn0.i32(1).i32(-1).i32(-1).i32(1);
        voxDict(trn0, { _t: '10 0 0' });
        children.raw(voxChunk('nTRN', trn0).toUint8());

        const grp1 = new ByteWriter();
        grp1.i32(1); voxDict(grp1, {}); grp1.i32(1).i32(2);
        children.raw(voxChunk('nGRP', grp1).toUint8());

        const trn2 = new ByteWriter();
        trn2.i32(2); voxDict(trn2, {}); trn2.i32(3).i32(-1).i32(-1).i32(1);
        voxDict(trn2, { _r: String(rotByte), _t: '1 2 3' });
        children.raw(voxChunk('nTRN', trn2).toUint8());

        const shp3 = new ByteWriter();
        shp3.i32(3); voxDict(shp3, {}); shp3.i32(1); shp3.i32(0); voxDict(shp3, {});
        children.raw(voxChunk('nSHP', shp3).toUint8());

        const nested = buildVoxBytesFromChunks(children);
        const f2 = parseVox(nested);
        expect(f2.instances).toHaveLength(1);
        expect(f2.instances[0]!.rotation).toEqual([0, -1, 0, 0, 0, 1, 1, 0, 0]);
        expect(f2.instances[0]!.translation).toEqual([11, 2, 3]);
    });

    test('scene-graph instance explosion is capped', () => {
        // Root nTRN(0) -> nGRP(1) whose children list is the SAME child nTRN id 2,
        // repeated 70,000 times (legal, non-cyclic DAG re-visit — each walk of node 2
        // completes and leaves the `visiting` set before the next repeat starts).
        // nTRN(2) -> nSHP(3) -> model 0. Without a cap this pushes 70,000 instances.
        const children = new ByteWriter();
        voxSingleVoxelModel(children);

        const trn0 = new ByteWriter();
        trn0.i32(0); voxDict(trn0, {}); trn0.i32(1).i32(-1).i32(-1).i32(1); voxDict(trn0, {});
        children.raw(voxChunk('nTRN', trn0).toUint8());

        const REPEAT_COUNT = 70_000;
        const grp1 = new ByteWriter();
        grp1.i32(1); voxDict(grp1, {}); grp1.i32(REPEAT_COUNT);
        for (let i = 0; i < REPEAT_COUNT; i++) grp1.i32(2);
        children.raw(voxChunk('nGRP', grp1).toUint8());

        const trn2 = new ByteWriter();
        trn2.i32(2); voxDict(trn2, {}); trn2.i32(3).i32(-1).i32(-1).i32(1); voxDict(trn2, {});
        children.raw(voxChunk('nTRN', trn2).toUint8());

        const shp3 = new ByteWriter();
        shp3.i32(3); voxDict(shp3, {}); shp3.i32(1); shp3.i32(0); voxDict(shp3, {});
        children.raw(voxChunk('nSHP', shp3).toUint8());

        const buf = buildVoxBytesFromChunks(children);
        expect(() => parseVox(buf)).toThrow(/too many instances/i);
    });
});
