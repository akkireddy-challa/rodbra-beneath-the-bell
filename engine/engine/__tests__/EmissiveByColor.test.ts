import { applyEmissiveByColor } from 'engine/vxlscene/emissiveByColor.js';
import { rgb888ToAtlasCell } from 'engine/vxlscene/atlasColor.js';
import { collectChunkCells } from 'engine/VxlWorldVoxelizer.js';
import { createVxlSceneEncoder, decodeVxlScene, type VxlSceneChunk } from 'engine/vxlscene/VxlSceneFormat.js';
import type { SceneVoxel, SceneQuad } from 'engine/vxlscene/SceneVoxTypes.js';

// A mid-tone red that quantizes cleanly through rgb888ToAtlasCell (sRGB encode +
// round(v/17)) — used as the "authored" color in several cases below.
const RED_HEX = '#C81414';
const redCell = rgb888ToAtlasCell(0xc8, 0x14, 0x14);

// A color far enough from RED_HEX that it quantizes to a DIFFERENT RGB444 cell —
// proves matching is exact, not tolerant of near-misses (unlike the vehicle
// auto-emissive matcher, which uses a channel tolerance).
const NEAR_MISS_HEX = '#C83030';
const nearMissCell = rgb888ToAtlasCell(0xc8, 0x30, 0x30);

describe('applyEmissiveByColor', () => {
    it('sets strength on the palette entry whose cell exactly matches an authored color', () => {
        const paletteCells = [redCell, 0, 1];
        const { emissive, unmatched } = applyEmissiveByColor(paletteCells, { [RED_HEX]: 200 });
        expect(emissive[0]).toBe(200);
        expect(emissive[1]).toBe(0);
        expect(emissive[2]).toBe(0);
        expect(unmatched).toEqual([]);
    });

    it('does not match a near-miss color that quantizes to a different cell', () => {
        expect(nearMissCell).not.toBe(redCell); // sanity: the fixture actually differs
        const paletteCells = [redCell];
        const { emissive, unmatched } = applyEmissiveByColor(paletteCells, { [NEAR_MISS_HEX]: 150 });
        expect(emissive[0]).toBe(0);
        expect(unmatched).toEqual([NEAR_MISS_HEX]);
    });

    it('sets every palette entry that shares the same cell (many-to-one)', () => {
        const paletteCells = [redCell, 7, redCell, redCell];
        const { emissive, unmatched } = applyEmissiveByColor(paletteCells, { [RED_HEX]: 90 });
        expect(Array.from(emissive)).toEqual([90, 0, 90, 90]);
        expect(unmatched).toEqual([]);
    });

    it('reports keys with no matching palette cell, and malformed hex strings, as unmatched', () => {
        const paletteCells = [redCell];
        const { emissive, unmatched } = applyEmissiveByColor(paletteCells, {
            [NEAR_MISS_HEX]: 100,
            'not-a-color': 50,
        });
        expect(Array.from(emissive)).toEqual([0]);
        expect(unmatched.sort()).toEqual([NEAR_MISS_HEX, 'not-a-color'].sort());
    });

    it('clamps strength to 0..255 and rounds fractional input', () => {
        const paletteCells = [redCell, 1, 2];
        const { emissive } = applyEmissiveByColor(paletteCells, {
            [RED_HEX]: 300, // clamp down to 255
        });
        expect(emissive[0]).toBe(255);

        const darkCell = rgb888ToAtlasCell(1, 1, 1);
        const { emissive: negEmissive } = applyEmissiveByColor([darkCell], {
            '#010101': -50, // clamp up to 0
        });
        expect(negEmissive[0]).toBe(0);

        const { emissive: roundEmissive } = applyEmissiveByColor([redCell], {
            [RED_HEX]: 100.6,
        });
        expect(roundEmissive[0]).toBe(101);
    });

    it('returns an all-zero emissive array and empty unmatched for an empty emissiveByColor map', () => {
        const paletteCells = [redCell, 1, 2];
        const { emissive, unmatched } = applyEmissiveByColor(paletteCells, {});
        expect(Array.from(emissive)).toEqual([0, 0, 0]);
        expect(unmatched).toEqual([]);
    });
});

// ─── collectChunkCells (VxlWorldVoxelizer.ts) ──────────────────────────────
//
// The level path's `emissiveUnmatched` mechanism: tracks every RGB444 cell a
// bake produces (bounded ≤4096) so `applyEmissiveByColor` can be run against
// it after the fact, without a second decode pass. Mirrors the SAME
// `rgb888ToAtlasCell(toR8(...))` quantization `VxlSceneFormat.ts`'s
// `chunkToColumns` applies when it registers the encoder's palette.

const toR8 = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));
const cellOf = (c: { r: number; g: number; b: number }): number => rgb888ToAtlasCell(toR8(c.r), toR8(c.g), toR8(c.b));

const colorA = { r: 0.9, g: 0.9, b: 0.95 }; // "tile" voxel (disp dx=dz=0)
const colorB = { r: 0.3, g: 0.5, b: 0.8 };  // "plain" displaced voxel (disp dx≠0)
const colorC = { r: 0.1, g: 0.6, b: 0.2 };  // non-displaced voxel — dropped before the encoder ever sees it
const colorD = { r: 0.7, g: 0.2, b: 0.4 };  // LOD-hint level 0 quad
const colorE = { r: 0.05, g: 0.05, b: 0.9 }; // LOD-hint level 1 quad

function makeVoxel(gx: number, color: { r: number; g: number; b: number }, disp: SceneVoxel['disp']): SceneVoxel {
    return { gx, gy: 1, gz: gx, sizeLevel: 0, color, noCollider: false, disp };
}
function makeQuad(color: { r: number; g: number; b: number }): SceneQuad {
    return { gx: 0, gy: 0, gz: 0, w: 1, h: 1, axis: 1, dir: 1, color, disp: 0 };
}

describe('collectChunkCells', () => {
    it('collects cells from chunk.voxels', () => {
        const chunk: VxlSceneChunk = {
            cx: 0, cy: 0, cz: 0,
            voxels: [makeVoxel(1, colorA, { dx: 0, dy: 0, dz: 0 }), makeVoxel(2, colorB, { dx: 1, dy: 0, dz: 0 })],
            lodHints: [],
            namedTrimeshes: [],
        };
        const cells = new Map<number, number>();
        collectChunkCells(chunk, cells);
        expect(new Set(cells.keys())).toEqual(new Set([cellOf(colorA), cellOf(colorB)]));
    });

    it('counts occurrences per cell — the coverage weight the class budget ranks by', () => {
        const chunk: VxlSceneChunk = {
            cx: 0, cy: 0, cz: 0,
            voxels: [makeVoxel(1, colorA, { dx: 0, dy: 0, dz: 0 }), makeVoxel(2, colorA, { dx: 0, dy: 0, dz: 0 })],
            lodHints: [[makeQuad(colorA), makeQuad(colorD)]],
            namedTrimeshes: [],
        };
        const cells = new Map<number, number>();
        collectChunkCells(chunk, cells);
        expect(cells.get(cellOf(colorA))).toBe(3); // two voxels + one quad
        expect(cells.get(cellOf(colorD))).toBe(1);
    });

    it('collects cells from every chunk.lodHints level, not just the first', () => {
        const chunk: VxlSceneChunk = {
            cx: 0, cy: 0, cz: 0,
            voxels: [],
            lodHints: [[makeQuad(colorD)], [makeQuad(colorE)]],
            namedTrimeshes: [],
        };
        const cells = new Map<number, number>();
        collectChunkCells(chunk, cells);
        expect(new Set(cells.keys())).toEqual(new Set([cellOf(colorD), cellOf(colorE)]));
    });

    it('handles disp-filtered voxels the same way the encoder filters them upstream', () => {
        const chunk: VxlSceneChunk = {
            cx: 0, cy: 0, cz: 0,
            voxels: [
                makeVoxel(1, colorA, { dx: 0, dy: 0, dz: 0 }),
                makeVoxel(2, colorB, { dx: 1, dy: 0, dz: 0 }),
                makeVoxel(3, colorC, null),
            ],
            lodHints: [],
            namedTrimeshes: [],
        };

        // collectChunkCells itself does not filter — called on the raw chunk it
        // picks up every voxel's color, including the non-displaced one.
        const unfiltered = new Map<number, number>();
        collectChunkCells(chunk, unfiltered);
        expect(new Set(unfiltered.keys())).toEqual(new Set([cellOf(colorA), cellOf(colorB), cellOf(colorC)]));

        // The driver (VxlWorldVoxelizer's onChunkBaked) filters non-displaced
        // voxels out BEFORE calling collectChunkCells — the same filter it applies
        // before handing the chunk to encoder.addChunk. Applying that filter first
        // must exclude colorC here exactly as it excludes it from the real palette.
        const filtered: VxlSceneChunk = { ...chunk, voxels: chunk.voxels.filter(v => v.disp !== null) };
        const afterFilter = new Map<number, number>();
        collectChunkCells(filtered, afterFilter);
        expect(new Set(afterFilter.keys())).toEqual(new Set([cellOf(colorA), cellOf(colorB)]));
    });

    it('superset property: every cell the real encoder writes to the file is present in the collected set', async () => {
        const chunk: VxlSceneChunk = {
            cx: 0, cy: 0, cz: 0,
            voxels: [
                makeVoxel(1, colorA, { dx: 0, dy: 0, dz: 0 }),
                makeVoxel(2, colorB, { dx: 1, dy: 0, dz: 0 }),
                makeVoxel(3, colorC, null), // dropped by the filter below, same as production
            ],
            lodHints: [[makeQuad(colorD)]],
            namedTrimeshes: [],
        };
        // Mirror VxlWorldVoxelizer's onChunkBaked: filter, THEN collect, THEN encode
        // the SAME filtered object — collectChunkCells and encoder.addChunk must see
        // identical input for the superset property to mean anything.
        const filtered: VxlSceneChunk = { ...chunk, voxels: chunk.voxels.filter(v => v.disp !== null) };

        const predicted = new Map<number, number>();
        collectChunkCells(filtered, predicted);

        const header = { chunkSize: 16, minVoxelSize: 1, bounds: { minX: 0, minY: 0, minZ: 0, maxX: 16, maxY: 16, maxZ: 16 }, lodDistances: [1e9] };
        const encoder = createVxlSceneEncoder(header);
        await encoder.addChunk(filtered);
        const decoded = await decodeVxlScene(await encoder.finish());

        const actual = new Set<number>();
        const decodedChunk = decoded.chunks[0]!;
        for (let i = 0; i < decodedChunk.voxels.count; i++) actual.add(decodedChunk.voxels.colorIdx[i]!);
        for (const level of decodedChunk.lodHints) {
            for (let i = 0; i < level.count; i++) actual.add(level.colorIdx[i]!);
        }
        if (decodedChunk.surfaceTile) {
            for (let i = 0; i < decodedChunk.surfaceTile.count; i++) actual.add(decodedChunk.surfaceTile.colorIdx[i]!);
        }

        expect(actual.size).toBeGreaterThan(0); // sanity: the fixture actually produced palette entries
        for (const cell of actual) expect(predicted.has(cell)).toBe(true);
        // colorC was filtered before both collection and encoding, so it reaches neither.
        expect(actual.has(cellOf(colorC))).toBe(false);
        expect(predicted.has(cellOf(colorC))).toBe(false);
    });
});
