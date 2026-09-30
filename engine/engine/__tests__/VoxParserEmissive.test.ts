/**
 * `.vox` MATL `_type:_emit` materials → ImportedVoxelFile.paletteEmissive.
 * The emission strength comes from the `_weight` property (MagicaVoxel has no
 * `_emit` property — that string is only the `_type` value).
 * Formula: emissive = clamp255(round(_weight * EMIT_BASE * (1 + _flux))), EMIT_BASE = 160.
 * MATL ids are 1-based color indices (1..255); out-of-range ids are ignored.
 */
import { parseVox } from 'engine/import/VoxParser.js';
import { buildVoxBytes } from 'engine/__tests__/helpers/voxelImportFixtures.js';
import type { VoxFixtureMaterial, VoxFixtureModel } from 'engine/__tests__/helpers/voxelImportFixtures.js';

const ONE_VOXEL: VoxFixtureModel = { sizeX: 1, sizeY: 1, sizeZ: 1, voxels: [[0, 0, 0, 1]] };

/** Parse a one-voxel file with the given MATL entries and return paletteEmissive[colorId] (0 when null). */
function emissiveAt(materials: VoxFixtureMaterial[], colorId: number): number {
    const f = parseVox(buildVoxBytes({ models: [ONE_VOXEL], materials }));
    return f.paletteEmissive ? f.paletteEmissive[colorId]! : 0;
}

describe('VoxParser emissive MATL', () => {
    test('_emit material populates paletteEmissive at the color index', () => {
        const buf = buildVoxBytes({
            models: [{ sizeX: 1, sizeY: 1, sizeZ: 1, voxels: [[0, 0, 0, 1]] }],
            palette: [[255, 0, 0, 255]],
            materials: [{ id: 1, type: '_emit', weight: 1.0, flux: 2 }],
        });
        const f = parseVox(buf);
        expect(f.paletteEmissive).not.toBeNull();
        expect(f.paletteEmissive![1]).toBeGreaterThan(0); // color 1 glows
    });

    test('diffuse-only file → paletteEmissive null', () => {
        const buf = buildVoxBytes({ models: [{ sizeX: 1, sizeY: 1, sizeZ: 1, voxels: [[0, 0, 0, 1]] }], palette: [[255, 0, 0, 255]] });
        expect(parseVox(buf).paletteEmissive).toBeNull();
    });

    test('formula: weight * 160 * (1 + flux), rounded and clamped to 255', () => {
        expect(emissiveAt([{ id: 1, type: '_emit', weight: 1, flux: 0 }], 1)).toBe(160);
        expect(emissiveAt([{ id: 1, type: '_emit', weight: 0.5, flux: 0 }], 1)).toBe(80);
        expect(emissiveAt([{ id: 1, type: '_emit', weight: 1, flux: 2 }], 1)).toBe(255); // 480 clamps
    });

    test('_flux amplifies the emissive value', () => {
        const without = emissiveAt([{ id: 1, type: '_emit', weight: 0.5, flux: 0 }], 1);
        const withFlux = emissiveAt([{ id: 1, type: '_emit', weight: 0.5, flux: 1 }], 1);
        expect(withFlux).toBeGreaterThan(without);
        expect(withFlux).toBe(160); // 0.5 * 160 * 2
    });

    test('missing _flux behaves as flux 0', () => {
        expect(emissiveAt([{ id: 1, type: '_emit', weight: 1 }], 1)).toBe(160);
    });

    test('emissive lands at the MATL id, other colors stay 0', () => {
        const f = parseVox(buildVoxBytes({
            models: [ONE_VOXEL],
            materials: [{ id: 7, type: '_emit', weight: 1, flux: 0 }],
        }));
        expect(f.paletteEmissive).not.toBeNull();
        expect(f.paletteEmissive!.length).toBe(256);
        expect(f.paletteEmissive![7]).toBe(160);
        expect(f.paletteEmissive![1]).toBe(0);
        expect(f.paletteEmissive![8]).toBe(0);
    });

    test('_emit type without a _weight property → no glow, paletteEmissive null', () => {
        const f = parseVox(buildVoxBytes({ models: [ONE_VOXEL], materials: [{ id: 1, type: '_emit' }] }));
        expect(f.paletteEmissive).toBeNull();
    });

    test('non-emit material types never set emissive', () => {
        const f = parseVox(buildVoxBytes({
            models: [ONE_VOXEL],
            materials: [{ id: 1, type: '_metal', weight: 1, flux: 4 }, { id: 2, type: '_diffuse' }],
        }));
        expect(f.paletteEmissive).toBeNull();
    });

    test('hostile emit values: negative and NaN are ignored, huge clamps to 255', () => {
        expect(emissiveAt([{ id: 1, type: '_emit', weight: -5, flux: 1 }], 1)).toBe(0);
        expect(emissiveAt([{ id: 1, type: '_emit', weight: Number.NaN, flux: 1 }], 1)).toBe(0);
        expect(parseVox(buildVoxBytes({
            models: [ONE_VOXEL],
            materials: [{ id: 1, type: '_emit', weight: -5 }, { id: 2, type: '_emit', weight: Number.NaN }],
        })).paletteEmissive).toBeNull();
        expect(emissiveAt([{ id: 1, type: '_emit', weight: 1e9, flux: 0 }], 1)).toBe(255);
    });

    test('hostile flux values: NaN treated as 0, huge clamps, negative floors to no-glow', () => {
        expect(emissiveAt([{ id: 1, type: '_emit', weight: 1, flux: Number.NaN }], 1)).toBe(160);
        expect(emissiveAt([{ id: 1, type: '_emit', weight: 1, flux: 1e9 }], 1)).toBe(255);
        const f = parseVox(buildVoxBytes({
            models: [ONE_VOXEL],
            materials: [{ id: 1, type: '_emit', weight: 1, flux: -5 }],
        }));
        expect(f.paletteEmissive).toBeNull();
    });

    test('out-of-range MATL ids (0, 256, 300) are ignored without throwing', () => {
        const f = parseVox(buildVoxBytes({
            models: [ONE_VOXEL],
            materials: [
                { id: 0, type: '_emit', weight: 1 },
                { id: 256, type: '_emit', weight: 1 },
                { id: 300, type: '_emit', weight: 1 },
            ],
        }));
        expect(f.paletteEmissive).toBeNull();
    });

    test('valid MATL id still parses alongside out-of-range ids', () => {
        const f = parseVox(buildVoxBytes({
            models: [ONE_VOXEL],
            materials: [
                { id: 0, type: '_emit', weight: 1 },
                { id: 2, type: '_emit', weight: 1, flux: 0 },
                { id: 300, type: '_emit', weight: 1 },
            ],
        }));
        expect(f.paletteEmissive).not.toBeNull();
        expect(f.paletteEmissive![0]).toBe(0);
        expect(f.paletteEmissive![2]).toBe(160);
    });

    test('paletteEmissive entries are always finite bytes', () => {
        const f = parseVox(buildVoxBytes({
            models: [ONE_VOXEL],
            materials: [
                { id: 1, type: '_emit', weight: 1e9, flux: 1e9 },
                { id: 2, type: '_emit', weight: 0.25, flux: 3 },
            ],
        }));
        expect(f.paletteEmissive).not.toBeNull();
        for (const v of f.paletteEmissive!) {
            expect(Number.isFinite(v)).toBe(true);
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(255);
        }
    });

    test('note reports the emissive color count', () => {
        const f = parseVox(buildVoxBytes({
            models: [ONE_VOXEL],
            materials: [
                { id: 1, type: '_emit', weight: 1, flux: 0 },
                { id: 3, type: '_emit', weight: 0.5, flux: 1 },
            ],
        }));
        expect(f.notes).toContain('2 emissive color(s) imported');
    });

    test('note reports non-emit materials as unsupported', () => {
        const f = parseVox(buildVoxBytes({
            models: [ONE_VOXEL],
            materials: [{ id: 1, type: '_metal' }, { id: 2, type: '_glass' }],
        }));
        expect(f.notes).toContain('2 color(s) use metal/glass materials — imported as solid colors (unsupported)');
        expect(f.paletteEmissive).toBeNull();
    });

    // Regression: real MagicaVoxel emit materials carry a full noise-key dict and
    // store emission in `_weight`, with NO `_emit` property. An earlier version read
    // a nonexistent `_emit` key, so every real emit material was silently dropped and
    // models imported as plain non-emissive. `realShape: true` mirrors the exact
    // DualStriker.vox MATL layout (weights 1.0 / 0.28, flux 1..4).
    test('real-format emit materials (full noise-key dict, _weight) glow', () => {
        const f = parseVox(buildVoxBytes({
            models: [ONE_VOXEL],
            materials: [
                { id: 169, type: '_emit', weight: 1, flux: 1, realShape: true },
                { id: 172, type: '_emit', weight: 1, flux: 2, realShape: true },
                { id: 174, type: '_emit', weight: 0.28, flux: 4, realShape: true },
                { id: 200, type: '_diffuse', weight: 1, realShape: true },
            ],
        }));
        expect(f.paletteEmissive).not.toBeNull();
        expect(f.paletteEmissive![169]).toBe(255); // 1 * 160 * (1+1) = 320 → clamp 255
        expect(f.paletteEmissive![172]).toBe(255); // 1 * 160 * (1+2) = 480 → clamp 255
        expect(f.paletteEmissive![174]).toBe(224); // 0.28 * 160 * (1+4) = 224
        expect(f.paletteEmissive![200]).toBe(0);   // diffuse never glows
        expect(f.notes).toContain('3 emissive color(s) imported');
    });
});
