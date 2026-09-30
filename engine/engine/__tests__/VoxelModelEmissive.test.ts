/**
 * End-to-end emissive flow through the import pipeline:
 * .vox MATL `_emit` → ImportedVoxelFile.paletteEmissive → CompiledVoxelModel.cellsEmissive
 * → OctreeLeaf.emissive → VXL v6 emissive trailer (decodeVxlV3 leaves.emiss).
 *
 * Non-emissive models must stay untouched: cellsEmissive null, leaves without
 * emissive, byte-identical v5 output (emiss column null). Levels (.vwld) are a
 * non-goal — level bytes must be identical with or without emissive.
 */
import { compileImportedFile } from 'engine/import/VoxelModelCompiler.js';
import { compileVoxelModelToVxlAsset, DEFAULT_VOXEL_ASSET_IMPORT_OPTIONS } from 'engine/import/VoxelModelToAsset.js';
import { compileVoxelModelToVwld, DEFAULT_VOXEL_LEVEL_IMPORT_OPTIONS } from 'engine/import/VoxelModelToLevel.js';
import { decodeVxlV3 } from 'engine/VxlV3Format.js';
import { parseVox } from 'engine/import/VoxParser.js';
import { packCell } from 'engine/vxlscene/SurfaceRasterizer.js';
import { buildVoxBytes } from 'engine/__tests__/helpers/voxelImportFixtures.js';
import type { VoxFixtureMaterial } from 'engine/__tests__/helpers/voxelImportFixtures.js';

const RED: [number, number, number, number] = [255, 0, 0, 255];
const GREEN: [number, number, number, number] = [0, 255, 0, 255];

const ASSET_OPTS = { ...DEFAULT_VOXEL_ASSET_IMPORT_OPTIONS, voxelSize: 0.1, additionalLodCount: 0 };

const decode = async (bytes: Uint8Array): ReturnType<typeof decodeVxlV3> =>
    decodeVxlV3(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);

/** Two-voxel row: color 1 at (0,0,0), color 2 at (1,0,0). */
function twoVoxelFile(materials?: VoxFixtureMaterial[]): ArrayBuffer {
    return buildVoxBytes({
        models: [{ sizeX: 2, sizeY: 1, sizeZ: 1, voxels: [[0, 0, 0, 1], [1, 0, 0, 2]] }],
        palette: [RED, GREEN],
        ...(materials ? { materials } : {}),
    });
}

describe('voxel import emissive flow', () => {
    test('emissive flows vox → compiled → vxl leaves', async () => {
        const f = parseVox(buildVoxBytes({
            models: [{ sizeX: 2, sizeY: 1, sizeZ: 1, voxels: [[0, 0, 0, 1], [1, 0, 0, 2]] }],
            palette: [[255, 0, 0, 255], [0, 255, 0, 255]],
            materials: [{ id: 1, type: '_emit', weight: 1.0, flux: 1 }],
        }));
        const [model] = compileImportedFile(f, { mode: 'merge', baseName: 't' });
        const r = await compileVoxelModelToVxlAsset(model!, { ...DEFAULT_VOXEL_ASSET_IMPORT_OPTIONS, voxelSize: 0.1, additionalLodCount: 0 });
        const dec = await decodeVxlV3(r.vxlBytes.buffer.slice(r.vxlBytes.byteOffset, r.vxlBytes.byteOffset + r.vxlBytes.byteLength) as ArrayBuffer);
        const buf = dec.fragments[0]!.leaves;
        expect(buf.emiss).not.toBeNull();
        // the red voxel (color 1) is emissive; the green one (color 2) is not
        let sawEmissive = false, sawZero = false;
        for (let i = 0; i < buf.count; i++) { if (buf.emiss![i]! > 0) sawEmissive = true; else sawZero = true; }
        expect(sawEmissive && sawZero).toBe(true);
    });

    test('cellsEmissive shares the packCell keying of cells (axis conversion + rebase applied)', () => {
        const f = parseVox(twoVoxelFile([{ id: 1, type: '_emit', weight: 1, flux: 0 }]));
        const [model] = compileImportedFile(f, { mode: 'merge', baseName: 't' });
        // color 1 at engine (0,0,0), color 2 at engine (1,0,0)
        expect(model!.cells.get(packCell(0, 0, 0))).toBe(0xff0000);
        expect(model!.cellsEmissive).not.toBeNull();
        expect(model!.cellsEmissive!.get(packCell(0, 0, 0))).toBe(160); // weight 1 * 160 * (1 + 0)
        // non-emissive color → no entry (sparse map, absent means 0)
        expect(model!.cellsEmissive!.has(packCell(1, 0, 0))).toBe(false);
    });

    test('separate mode: emissive carried per model, glowing model → v6, plain model → v5', async () => {
        const f = parseVox(buildVoxBytes({
            models: [
                { sizeX: 1, sizeY: 1, sizeZ: 1, voxels: [[0, 0, 0, 1]] },
                { sizeX: 1, sizeY: 1, sizeZ: 1, voxels: [[0, 0, 0, 2]] },
            ],
            palette: [RED, GREEN],
            scene: [
                { model: 0, translation: [0, 0, 0], name: 'lamp' },
                { model: 1, translation: [4, 0, 0] },
            ],
            materials: [{ id: 1, type: '_emit', weight: 1, flux: 0 }],
        }));
        const models = compileImportedFile(f, { mode: 'separate', baseName: 'pack' });
        expect(models).toHaveLength(2);
        expect(models[0]!.cellsEmissive).not.toBeNull();
        expect(models[0]!.cellsEmissive!.get(packCell(0, 0, 0))).toBe(160);
        // model 2 uses only the non-emissive color → no emissive map at all
        expect(models[1]!.cellsEmissive).toBeNull();

        const glowing = await decode((await compileVoxelModelToVxlAsset(models[0]!, ASSET_OPTS)).vxlBytes);
        expect(glowing.paletteEmissive).toBeDefined();
        expect(glowing.fragments[0]!.leaves.emiss![0]).toBe(160);

        const plain = await decode((await compileVoxelModelToVxlAsset(models[1]!, ASSET_OPTS)).vxlBytes);
        expect(plain.paletteEmissive).toBeUndefined();
        expect(plain.fragments[0]!.leaves.emiss).toBeNull();
    });

    test('no MATL → cellsEmissive null → leaves without emissive → v5 output', async () => {
        const f = parseVox(twoVoxelFile());
        const [model] = compileImportedFile(f, { mode: 'merge', baseName: 't' });
        expect(model!.cellsEmissive).toBeNull();
        const dec = await decode((await compileVoxelModelToVxlAsset(model!, ASSET_OPTS)).vxlBytes);
        expect(dec.paletteEmissive).toBeUndefined();
        expect(dec.fragments[0]!.leaves.emiss).toBeNull();
    });

    test('emissive palette entry for a color no voxel uses is filtered out', async () => {
        // color 1 glows in the palette but only color 2 is placed
        const f = parseVox(buildVoxBytes({
            models: [{ sizeX: 1, sizeY: 1, sizeZ: 1, voxels: [[0, 0, 0, 2]] }],
            palette: [RED, GREEN],
            materials: [{ id: 1, type: '_emit', weight: 1, flux: 0 }],
        }));
        expect(f.paletteEmissive).not.toBeNull(); // the file DOES carry emissive
        const [model] = compileImportedFile(f, { mode: 'merge', baseName: 't' });
        expect(model!.cellsEmissive).toBeNull(); // ...but no placed cell glows
        const dec = await decode((await compileVoxelModelToVxlAsset(model!, ASSET_OPTS)).vxlBytes);
        expect(dec.paletteEmissive).toBeUndefined(); // never ghost-emitted
    });

    test('merge overlap: later instance wins for emissive exactly as for color', () => {
        const models = [
            { sizeX: 1, sizeY: 1, sizeZ: 1, voxels: [[0, 0, 0, 1]] as Array<[number, number, number, number]> },
            { sizeX: 1, sizeY: 1, sizeZ: 1, voxels: [[0, 0, 0, 2]] as Array<[number, number, number, number]> },
        ];
        const materials: VoxFixtureMaterial[] = [{ id: 1, type: '_emit', weight: 1, flux: 0 }];

        // glowing first, plain second → plain wins, glow cleared
        const plainWins = compileImportedFile(parseVox(buildVoxBytes({
            models, palette: [RED, GREEN], materials,
            scene: [{ model: 0, translation: [0, 0, 0] }, { model: 1, translation: [0, 0, 0] }],
        })), { mode: 'merge', baseName: 't' })[0]!;
        expect(plainWins.cells.get(packCell(0, 0, 0))).toBe(0x00ff00);
        expect(plainWins.cellsEmissive).toBeNull();

        // plain first, glowing second → glow wins
        const glowWins = compileImportedFile(parseVox(buildVoxBytes({
            models, palette: [RED, GREEN], materials,
            scene: [{ model: 1, translation: [0, 0, 0] }, { model: 0, translation: [0, 0, 0] }],
        })), { mode: 'merge', baseName: 't' })[0]!;
        expect(glowWins.cells.get(packCell(0, 0, 0))).toBe(0xff0000);
        expect(glowWins.cellsEmissive!.get(packCell(0, 0, 0))).toBe(160);
    });

    test('.vwld level output is byte-identical with and without emissive (levels are a non-goal)', async () => {
        const levelOpts = { ...DEFAULT_VOXEL_LEVEL_IMPORT_OPTIONS, voxelSize: 1, chunkSize: 8, additionalLods: [] };
        const plain = compileImportedFile(parseVox(twoVoxelFile()), { mode: 'merge', baseName: 't' })[0]!;
        const glowing = compileImportedFile(
            parseVox(twoVoxelFile([{ id: 1, type: '_emit', weight: 1, flux: 0 }])),
            { mode: 'merge', baseName: 't' },
        )[0]!;
        expect(glowing.cellsEmissive instanceof Map).toBe(true);
        const a = await compileVoxelModelToVwld(plain, levelOpts);
        const b = await compileVoxelModelToVwld(glowing, levelOpts);
        expect(b.vwldBytes.length).toBe(a.vwldBytes.length);
        expect(Buffer.from(b.vwldBytes).equals(Buffer.from(a.vwldBytes))).toBe(true);
    });
});
