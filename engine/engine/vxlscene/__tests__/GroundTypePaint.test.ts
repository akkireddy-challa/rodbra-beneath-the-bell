/**
 * Runtime ground-type editing on a baked level — the mowing contract.
 *
 * A game reads the material under its mower, converts long grass to short, and
 * scores the area it cleared. The engine owns the consequence: cells that changed
 * get their ground cover re-planned, so the tufts visibly disappear.
 *
 * `paintGroundTypeInMask` is the pure core `VxlSceneTerrainSystem.setGroundTypeIn*`
 * wraps; the wrapper only forwards the mask and hands the returned box to
 * `GroundDetailSystem.invalidateRegion`.
 */

import { paintGroundTypeInMask, groundTypeAtPoint, type GroundMaskData } from 'engine/vxlscene/GroundMaskBaker.js';
import { GROUND_MASK_HEIGHT_STEP } from 'engine/vxlscene/GroundMaskBaker.js';
import { GROUND_TYPE, groundFoliageType, grassDensity } from 'engine/vxlscene/GroundTypes.js';
import { FoliageType } from 'engine/TerrainTypes.js';

const CELL = 0.5;
const SURF_Q = Math.round(2.0 / GROUND_MASK_HEIGHT_STEP);

/** A 16x16 m field of long grass, origin at (0,0), with an untyped strip at cz 0. */
function field(fill: (cx: number, cz: number) => number = () => GROUND_TYPE.grassLush): GroundMaskData {
    const width = 32, height = 32;
    const types = new Uint8Array(width * height);
    const topY = new Uint16Array(width * height);
    for (let cz = 0; cz < height; cz++) {
        for (let cx = 0; cx < width; cx++) {
            const t = fill(cx, cz);
            if (t === 0) continue;          // leave topY 0 = "no surface data"
            types[cz * width + cx] = t;
            topY[cz * width + cx] = SURF_Q;
        }
    }
    return { cellSize: CELL, width, height, types, topY };
}

const circle = (x: number, z: number, r: number) =>
    (cx: number, cz: number): boolean => (cx - x) ** 2 + (cz - z) ** 2 <= r * r;

describe('paintGroundTypeInMask', () => {
    it('cuts long grass to short under the mower and reports the area cleared', () => {
        const mask = field();
        const box = { minX: 8 - 1, minZ: 8 - 1, maxX: 8 + 1, maxZ: 8 + 1 };

        const hit = paintGroundTypeInMask(mask, 0, 0, box, GROUND_TYPE.grassDry, undefined, circle(8, 8, 1));

        // A 1 m radius over 0.5 m cells ≈ 12 cells → 3 m² at 0.25 m² each.
        expect(hit.changed).toBeGreaterThan(8);
        expect(hit.changed * CELL * CELL).toBeCloseTo(hit.changed * 0.25, 10);
        expect(groundTypeAtPoint(mask, 0, 0, 8, 2.0, 8, 2.0)).toBe(GROUND_TYPE.grassDry);
        // Outside the mower's reach is untouched.
        expect(groundTypeAtPoint(mask, 0, 0, 12, 2.0, 12, 2.0)).toBe(GROUND_TYPE.grassLush);
    });

    it('scores nothing the second time over the same patch', () => {
        const mask = field();
        const box = { minX: 7, minZ: 7, maxX: 9, maxZ: 9 };

        const first = paintGroundTypeInMask(mask, 0, 0, box, GROUND_TYPE.grassDry, undefined, circle(8, 8, 1));
        const second = paintGroundTypeInMask(mask, 0, 0, box, GROUND_TYPE.grassDry, undefined, circle(8, 8, 1));

        expect(first.changed).toBeGreaterThan(0);
        expect(second.changed).toBe(0);
    });

    it('onlyReplacing cuts the long grass and leaves the sand and path alone', () => {
        // Left half long grass, right half sand.
        const mask = field((cx) => (cx < 16 ? GROUND_TYPE.grassLush : GROUND_TYPE.sand));
        const box = { minX: 0, minZ: 0, maxX: 16, maxZ: 16 };

        const hit = paintGroundTypeInMask(mask, 0, 0, box, GROUND_TYPE.grassDry, GROUND_TYPE.grassLush, null);

        expect(hit.changed).toBe(16 * 32);                                     // the grass half only
        expect(groundTypeAtPoint(mask, 0, 0, 12, 2.0, 8, 2.0)).toBe(GROUND_TYPE.sand);
        expect(groundTypeAtPoint(mask, 0, 0, 4, 2.0, 8, 2.0)).toBe(GROUND_TYPE.grassDry);
    });

    it('never invents ground where the bake found no surface', () => {
        // Row cz 0 has no baked surface; the box covers it and the typed row behind it.
        const mask = field((_cx, cz) => (cz === 0 ? 0 : GROUND_TYPE.grassLush));

        const hit = paintGroundTypeInMask(
            mask, 0, 0, { minX: 0, minZ: 0, maxX: 16, maxZ: 1.9 * CELL }, GROUND_TYPE.grassDry, undefined, null,
        );

        // Only the typed row was painted — the untyped one stays untyped, not "dry grass".
        expect(hit.changed).toBe(32);
        expect(mask.types[0]).toBe(GROUND_TYPE.none);
        expect(mask.topY[0]).toBe(0);
        expect(mask.types[32]).toBe(GROUND_TYPE.grassDry);
    });

    it('reports a refresh box that covers every changed cell', () => {
        const mask = field();
        const hit = paintGroundTypeInMask(
            mask, 0, 0, { minX: 4, minZ: 4, maxX: 6, maxZ: 6 }, GROUND_TYPE.grassDry, undefined, circle(5, 5, 1),
        );

        expect(hit.changed).toBeGreaterThan(0);
        // The box is the changed cells' full extent (centres ± half a cell), inside
        // the requested footprint — GroundDetailSystem repaints exactly these columns.
        expect(hit.minX).toBeGreaterThanOrEqual(4);
        expect(hit.maxX).toBeLessThanOrEqual(6);
        expect(hit.maxX - hit.minX).toBeGreaterThan(1.5);
        expect(hit.maxZ - hit.minZ).toBeGreaterThan(1.5);
    });

    it('clips to the mask instead of running off the edge', () => {
        const mask = field();
        const hit = paintGroundTypeInMask(
            mask, 0, 0, { minX: -100, minZ: -100, maxX: 100, maxZ: 100 }, GROUND_TYPE.dirt, undefined, null,
        );
        expect(hit.changed).toBe(32 * 32);
    });
});

describe('cut grass changes what grows there', () => {
    it('drops the cover density, which is what makes mowing visible', () => {
        expect(grassDensity(GROUND_TYPE.grassLush)).toBeGreaterThan(grassDensity(GROUND_TYPE.grassDry));
        expect(grassDensity(GROUND_TYPE.dirt)).toBe(0);
    });

    it('classifies cover in the same vocabulary as procedural voxel terrain', () => {
        // Same question, same answer type, whichever world the game is built on.
        expect(groundFoliageType(GROUND_TYPE.grassLush)).toBe(FoliageType.MEADOW);
        expect(groundFoliageType(GROUND_TYPE.grassDry)).toBe(FoliageType.FIELD);
        expect(groundFoliageType(GROUND_TYPE.sand)).toBe(FoliageType.BEACH);
        expect(groundFoliageType(GROUND_TYPE.asphalt)).toBe(FoliageType.NONE);
    });
});
