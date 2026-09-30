import { bakeGroundMask, groundMaskCellIndex, GROUND_MASK_HEIGHT_STEP } from 'engine/vxlscene/GroundMaskBaker.js';
import { GROUND_TYPE } from 'engine/vxlscene/GroundTypes.js';
import type { RasterTriangle } from 'engine/vxlscene/SurfaceRasterizer.js';
import type { VxlWorldBounds } from 'engine/VxlWorldFormat.js';

const WHITE: RasterTriangle['sampleColor'] = () => ({ r: 1, g: 1, b: 1 });

/** An axis-aligned horizontal quad (two triangles) at height y. */
function quad(nodeName: string, x0: number, z0: number, x1: number, z1: number, y: number): RasterTriangle[] {
    const n: [number, number, number] = [0, 1, 0];
    return [
        { v0: [x0, y, z0], v1: [x1, y, z0], v2: [x1, y, z1], normal: n, nodeName, sampleColor: WHITE },
        { v0: [x0, y, z0], v1: [x1, y, z1], v2: [x0, y, z1], normal: n, nodeName, sampleColor: WHITE },
    ];
}

const bounds: VxlWorldBounds = { minX: 0, minY: 0, minZ: 0, maxX: 16, maxY: 16, maxZ: 16 };

describe('bakeGroundMask', () => {
    it('returns null when nothing is typed', () => {
        expect(bakeGroundMask(quad('Grass', 0, 0, 8, 8, 1), {}, bounds)).toBeNull();
        expect(bakeGroundMask(quad('Grass', 0, 0, 8, 8, 1), { Grass: 0 }, bounds)).toBeNull();
    });

    it('types cells inside a grass quad and leaves the rest untyped', () => {
        const mask = bakeGroundMask(quad('Grass', 0, 0, 8, 8, 1), { Grass: GROUND_TYPE.grass }, bounds, 0.5)!;
        expect(mask).not.toBeNull();
        expect(mask.width).toBe(32);
        expect(mask.height).toBe(32);
        // Inside.
        const inIdx = groundMaskCellIndex(mask, 4, 4, bounds.minX, bounds.minZ);
        expect(mask.types[inIdx]).toBe(GROUND_TYPE.grass);
        expect(mask.topY[inIdx]! * GROUND_MASK_HEIGHT_STEP).toBeCloseTo(1, 1);
        // Outside.
        const outIdx = groundMaskCellIndex(mask, 12, 12, bounds.minX, bounds.minZ);
        expect(mask.types[outIdx]).toBe(GROUND_TYPE.none);
        expect(mask.topY[outIdx]).toBe(0);
    });

    it('the HIGHEST typed surface wins where typed surfaces overlap', () => {
        const tris = [
            ...quad('Grass', 0, 0, 8, 8, 1),
            ...quad('RoadsCobble', 2, 2, 6, 6, 1.4), // road above the grass
        ];
        const types = { Grass: GROUND_TYPE.grass, RoadsCobble: GROUND_TYPE.cobble };
        const mask = bakeGroundMask(tris, types, bounds, 0.5)!;
        const onRoad = groundMaskCellIndex(mask, 4, 4, bounds.minX, bounds.minZ);
        const onGrass = groundMaskCellIndex(mask, 1, 1, bounds.minX, bounds.minZ);
        expect(mask.types[onRoad]).toBe(GROUND_TYPE.cobble);
        expect(mask.topY[onRoad]! * GROUND_MASK_HEIGHT_STEP).toBeCloseTo(1.4, 1);
        expect(mask.types[onGrass]).toBe(GROUND_TYPE.grass);
    });

    it('near-vertical (wall) triangles never type cells', () => {
        const wall: RasterTriangle[] = [{
            v0: [0, 0, 4], v1: [8, 0, 4], v2: [8, 5, 4],
            normal: [0, 0, 1], nodeName: 'Kerb', sampleColor: WHITE,
        }];
        expect(bakeGroundMask(wall, { Kerb: GROUND_TYPE.cobble }, bounds, 0.5)).toBeNull();
    });

    it('untyped nodes (buildings) never override a typed ground below', () => {
        const tris = [
            ...quad('Grass', 0, 0, 8, 8, 1),
            ...quad('BuildingRoof', 2, 2, 6, 6, 12), // roof high above, untyped
        ];
        const mask = bakeGroundMask(tris, { Grass: GROUND_TYPE.grass }, bounds, 0.5)!;
        const under = groundMaskCellIndex(mask, 4, 4, bounds.minX, bounds.minZ);
        expect(mask.types[under]).toBe(GROUND_TYPE.grass);
        expect(mask.topY[under]! * GROUND_MASK_HEIGHT_STEP).toBeCloseTo(1, 1); // grass height, not roof
    });

    it('y=0 surfaces still record a non-zero heightQ (0 is reserved for "no data")', () => {
        const mask = bakeGroundMask(quad('Grass', 0, 0, 8, 8, 0), { Grass: GROUND_TYPE.grass }, bounds, 0.5)!;
        const idx = groundMaskCellIndex(mask, 4, 4, bounds.minX, bounds.minZ);
        expect(mask.types[idx]).toBe(GROUND_TYPE.grass);
        expect(mask.topY[idx]).toBeGreaterThan(0);
    });
});
