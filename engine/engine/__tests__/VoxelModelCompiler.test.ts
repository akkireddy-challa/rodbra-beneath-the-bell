import { compileImportedFile } from 'engine/import/VoxelModelCompiler.js';
import { parseVox } from 'engine/import/VoxParser.js';
import { parseQb } from 'engine/import/QbParser.js';
import { packCell } from 'engine/vxlscene/SurfaceRasterizer.js';
import { buildVoxBytes, buildQbBytes } from 'engine/__tests__/helpers/voxelImportFixtures.js';

const RED: [number, number, number, number] = [255, 0, 0, 255];
const GREEN: [number, number, number, number] = [0, 255, 0, 255];

describe('compileImportedFile', () => {
    test('vox axis conversion: Z-up → Y-up preserving handedness', () => {
        // Single voxel at source (2, 1, 3) in a 3x2x4 model.
        const f = parseVox(buildVoxBytes({
            models: [{ sizeX: 3, sizeY: 2, sizeZ: 4, voxels: [[2, 1, 3, 1]] }],
            palette: [RED],
        }));
        const [model] = compileImportedFile(f, { mode: 'merge', baseName: 'test' });
        // engine = (x, z, -y): (2, 3, -1) → rebased to (0,0,0) since it is the only voxel
        expect(model!.cells.size).toBe(1);
        expect(model!.cells.get(packCell(0, 0, 0))).toBe(0xff0000);
        expect([model!.sizeX, model!.sizeY, model!.sizeZ]).toEqual([1, 1, 1]);
    });

    test('vox: two voxels keep relative engine-space offsets', () => {
        const f = parseVox(buildVoxBytes({
            models: [{ sizeX: 4, sizeY: 3, sizeZ: 2, voxels: [[0, 0, 0, 1], [3, 2, 1, 2]] }],
            palette: [RED, GREEN],
        }));
        const [model] = compileImportedFile(f, { mode: 'merge', baseName: 'test' });
        // src (0,0,0) → eng (0, 0, -0); src (3,2,1) → eng (3, 1, -2)
        // rebase z by +2: red at (0,0,2), green at (3,1,0)
        expect(model!.cells.get(packCell(0, 0, 2))).toBe(0xff0000);
        expect(model!.cells.get(packCell(3, 1, 0))).toBe(0x00ff00);
        expect([model!.sizeX, model!.sizeY, model!.sizeZ]).toEqual([4, 2, 3]);
    });

    test('merge mode applies instance translations (about floor(size/2))', () => {
        const f = parseVox(buildVoxBytes({
            models: [{ sizeX: 1, sizeY: 1, sizeZ: 1, voxels: [[0, 0, 0, 1]] }],
            palette: [RED],
            scene: [
                { model: 0, translation: [0, 0, 0] },
                { model: 0, translation: [2, 0, 0] },
            ],
        }));
        const [model] = compileImportedFile(f, { mode: 'merge', baseName: 'test' });
        expect(model!.cells.size).toBe(2);
        // both at source y=0,z=0 → engine y=0; x offsets 0 and 2 survive
        expect(model!.cells.has(packCell(0, 0, 0))).toBe(true);
        expect(model!.cells.has(packCell(2, 0, 0))).toBe(true);
    });

    test('separate mode: one model per grid, authored orientation, names', () => {
        const f = parseVox(buildVoxBytes({
            models: [
                { sizeX: 1, sizeY: 1, sizeZ: 1, voxels: [[0, 0, 0, 1]] },
                { sizeX: 1, sizeY: 1, sizeZ: 2, voxels: [[0, 0, 1, 2]] },
            ],
            palette: [RED, GREEN],
            scene: [
                { model: 0, translation: [50, 0, 0], name: 'lamp' },
                { model: 1, translation: [-50, 0, 0] },
            ],
        }));
        const models = compileImportedFile(f, { mode: 'separate', baseName: 'pack' });
        expect(models).toHaveLength(2);
        expect(models[0]!.name).toBe('lamp');
        expect(models[1]!.name).toBe('pack-2');
        // translations ignored in separate mode; grid 1's voxel at src z=1 → eng y=1, rebased alone
        expect(models[1]!.cells.get(packCell(0, 0, 0))).toBe(0x00ff00);
    });

    test('vox palette alpha < 128 becomes air', () => {
        const f = parseVox(buildVoxBytes({
            models: [{ sizeX: 2, sizeY: 1, sizeZ: 1, voxels: [[0, 0, 0, 1], [1, 0, 0, 2]] }],
            palette: [RED, [0, 0, 255, 10]],
        }));
        const [model] = compileImportedFile(f, { mode: 'merge', baseName: 't' });
        expect(model!.cells.size).toBe(1);
    });

    test('qb goes through untouched axes (Y-up already)', () => {
        const f = parseQb(buildQbBytes({
            matrices: [{
                name: 'm', sizeX: 1, sizeY: 2, sizeZ: 1, posX: 0, posY: 0, posZ: 0,
                voxels: [[0, 1, 0, 1, 2, 3, 255]],
            }],
        }));
        const [model] = compileImportedFile(f, { mode: 'merge', baseName: 't' });
        expect(model!.cells.get(packCell(0, 0, 0))).toBe(0x010203);
        expect([model!.sizeX, model!.sizeY, model!.sizeZ]).toEqual([1, 1, 1]);
    });

    test('all-air file throws', () => {
        const f = parseVox(buildVoxBytes({
            models: [{ sizeX: 1, sizeY: 1, sizeZ: 1, voxels: [[0, 0, 0, 1]] }],
            palette: [[1, 2, 3, 0]],
        }));
        expect(() => compileImportedFile(f, { mode: 'merge', baseName: 't' })).toThrow(/no solid voxels/i);
    });

    test('rotated instance flows through merge, axis conversion, and rebase', () => {
        const f = parseVox(buildVoxBytes({
            models: [{ sizeX: 2, sizeY: 1, sizeZ: 1, voxels: [[0, 0, 0, 1], [1, 0, 0, 2]] }],
            palette: [RED, GREEN],
            scene: [
                // rotation matrix [0,-1,0, 0,0,1, 1,0,0]; center (1,0,0).
                // source-world: RED (voxel 0,0,0) -> (0,0,-1); GREEN (voxel 1,0,0) -> (0,0,0)
                // engine (x,z,-y): RED -> (0,-1,0); GREEN -> (0,0,0)
                // rebase (min y = -1): RED -> (0,0,0); GREEN -> (0,1,0)
                { model: 0, rotationByte: (1 << 0) | (2 << 2) | (1 << 4) },
            ],
        }));
        const [model] = compileImportedFile(f, { mode: 'merge', baseName: 'test' });
        expect(model!.cells.size).toBe(2);
        expect(model!.cells.get(packCell(0, 0, 0))).toBe(0xff0000);
        expect(model!.cells.get(packCell(0, 1, 0))).toBe(0x00ff00);
        expect([model!.sizeX, model!.sizeY, model!.sizeZ]).toEqual([1, 2, 1]);
    });

    test('later instance wins on overlap', () => {
        const f = parseVox(buildVoxBytes({
            models: [
                { sizeX: 1, sizeY: 1, sizeZ: 1, voxels: [[0, 0, 0, 1]] },
                { sizeX: 1, sizeY: 1, sizeZ: 1, voxels: [[0, 0, 0, 2]] },
            ],
            palette: [RED, GREEN],
            scene: [
                { model: 0, translation: [0, 0, 0] },
                { model: 1, translation: [0, 0, 0] },
            ],
        }));
        const [model] = compileImportedFile(f, { mode: 'merge', baseName: 'test' });
        expect(model!.cells.size).toBe(1);
        expect(model!.cells.get(packCell(0, 0, 0))).toBe(0x00ff00);
    });

    test('qb matrices keep relative offsets end-to-end', () => {
        const f = parseQb(buildQbBytes({
            matrices: [
                { name: 'm1', sizeX: 1, sizeY: 1, sizeZ: 1, posX: 0, posY: 0, posZ: 0, voxels: [[0, 0, 0, 255, 0, 0, 255]] },
                { name: 'm2', sizeX: 1, sizeY: 1, sizeZ: 1, posX: 4, posY: 0, posZ: 0, voxels: [[0, 0, 0, 0, 255, 0, 255]] },
            ],
        }));
        const [model] = compileImportedFile(f, { mode: 'merge', baseName: 't' });
        expect(model!.cells.get(packCell(0, 0, 0))).toBe(0xff0000);
        expect(model!.cells.get(packCell(4, 0, 0))).toBe(0x00ff00);
        expect([model!.sizeX, model!.sizeY, model!.sizeZ]).toEqual([5, 1, 1]);
    });

    test('left-handed qb mirrors world z end-to-end', () => {
        const f = parseQb(buildQbBytes({
            zAxisOrientation: 0,
            matrices: [
                { name: 'm1', sizeX: 1, sizeY: 1, sizeZ: 1, posX: 0, posY: 0, posZ: 0, voxels: [[0, 0, 0, 255, 0, 0, 255]] },
                { name: 'm2', sizeX: 1, sizeY: 1, sizeZ: 1, posX: 0, posY: 0, posZ: 3, voxels: [[0, 0, 0, 0, 255, 0, 255]] },
            ],
        }));
        const [model] = compileImportedFile(f, { mode: 'merge', baseName: 't' });
        // world z: m1 -> -(0+0)=0, m2 -> -(3+0)=-3; rebase (min z=-3): m1 at z=3, m2 at z=0
        expect(model!.cells.get(packCell(0, 0, 3))).toBe(0xff0000);
        expect(model!.cells.get(packCell(0, 0, 0))).toBe(0x00ff00);
        expect([model!.sizeX, model!.sizeY, model!.sizeZ]).toEqual([1, 1, 4]);
    });

    test('stamped-voxel budget throws', () => {
        const f = parseVox(buildVoxBytes({
            models: [{
                sizeX: 2, sizeY: 2, sizeZ: 1,
                voxels: [[0, 0, 0, 1], [1, 0, 0, 1], [0, 1, 0, 1], [1, 1, 0, 1]],
            }],
            palette: [RED],
        }));
        expect(() => compileImportedFile(f, { mode: 'merge', baseName: 't', maxVoxels: 3 })).toThrow(/import limit/i);
    });

    test('oversized extent throws', () => {
        const f = parseVox(buildVoxBytes({
            models: [{ sizeX: 1, sizeY: 1, sizeZ: 1, voxels: [[0, 0, 0, 1]] }],
            palette: [RED],
            scene: [
                { model: 0, translation: [0, 0, 0] },
                { model: 0, translation: [70000, 0, 0] },
            ],
        }));
        expect(() => compileImportedFile(f, { mode: 'merge', baseName: 't' })).toThrow(/importable range/i);
    });
});
