/**
 * Surface grip from the baked ground mask.
 *
 * The raycast vehicle has always modulated per-wheel friction, engine force and
 * braking by `info.grip`, but it sourced that grip from `VoxelWorld.getBlock` —
 * which only exists for procedural voxel terrain. On a baked (.vwld) level there
 * is no VoxelWorld, so the lookup was skipped and every wheel kept its 1.0
 * default: sand, grass and asphalt all drove identically. These cover the table
 * and the mask lookup that now feed it.
 */

import { bakeGroundMask, groundTypeAtPoint } from 'engine/vxlscene/GroundMaskBaker.js';
import { GROUND_TYPE, groundGrip } from 'engine/vxlscene/GroundTypes.js';
import type { RasterTriangle } from 'engine/vxlscene/SurfaceRasterizer.js';
import type { VxlWorldBounds } from 'engine/VxlWorldFormat.js';

const WHITE: RasterTriangle['sampleColor'] = () => ({ r: 1, g: 1, b: 1 });

function quad(nodeName: string, x0: number, z0: number, x1: number, z1: number, y: number): RasterTriangle[] {
    const n: [number, number, number] = [0, 1, 0];
    return [
        { v0: [x0, y, z0], v1: [x1, y, z0], v2: [x1, y, z1], normal: n, nodeName, sampleColor: WHITE },
        { v0: [x0, y, z0], v1: [x1, y, z1], v2: [x0, y, z1], normal: n, nodeName, sampleColor: WHITE },
    ];
}

const bounds: VxlWorldBounds = { minX: 0, minY: 0, minZ: 0, maxX: 16, maxY: 16, maxZ: 16 };

describe('groundGrip', () => {
    it('gives asphalt full traction and loose surfaces less', () => {
        expect(groundGrip(GROUND_TYPE.asphalt)).toBe(1.0);
        expect(groundGrip(GROUND_TYPE.gravel)).toBeLessThan(groundGrip(GROUND_TYPE.dirt));
        expect(groundGrip(GROUND_TYPE.dirt)).toBeLessThan(groundGrip(GROUND_TYPE.grass));
        expect(groundGrip(GROUND_TYPE.grass)).toBeLessThan(groundGrip(GROUND_TYPE.asphalt));
        expect(groundGrip(GROUND_TYPE.sand)).toBeLessThan(groundGrip(GROUND_TYPE.grass));
    });

    it('matches the voxel-terrain atlas on the surfaces both worlds have', () => {
        // Same surface, same handling whether the level is procedural or baked
        // (VoxelTextureAtlas registers grass 0.8, sand 0.6).
        expect(groundGrip(GROUND_TYPE.grass)).toBeCloseTo(0.8, 5);
        expect(groundGrip(GROUND_TYPE.sand)).toBeCloseTo(0.6, 5);
    });

    it('treats UNTYPED as full grip — missing data is never a penalty', () => {
        // The atlas defaults unregistered blocks to 0.5; repeating that here would
        // silently halve traction on every level baked without ground types.
        expect(groundGrip(GROUND_TYPE.none)).toBe(1.0);
        expect(groundGrip(255)).toBe(1.0);
    });

    it('keeps every type in a sane multiplier range', () => {
        for (const t of Object.values(GROUND_TYPE)) {
            const g = groundGrip(t);
            expect(g).toBeGreaterThan(0.4);
            expect(g).toBeLessThanOrEqual(1.0);
        }
    });
});

describe('grip resolved through a baked mask', () => {
    /** The exact lookup VxlSceneTerrainSystem.getGroundTypeAt delegates to. */
    function typeAt(mask: ReturnType<typeof bakeGroundMask>, x: number, y: number, z: number, tolerance = 2.0): number {
        if (!mask) return GROUND_TYPE.none;
        return groundTypeAtPoint(mask, bounds.minX, bounds.minZ, x, y, z, tolerance);
    }

    // A track down the middle with grass either side — the run-off case.
    const mask = bakeGroundMask(
        [...quad('Track', 6, 0, 10, 16, 1), ...quad('Grass', 0, 0, 6, 16, 1), ...quad('Grass', 10, 0, 16, 16, 1)],
        { Track: GROUND_TYPE.asphalt, Grass: GROUND_TYPE.grass },
        bounds,
        0.5,
    );

    it('gives a wheel on the racing line more grip than one in the run-off', () => {
        expect(groundGrip(typeAt(mask, 8, 1, 8))).toBe(1.0);
        expect(groundGrip(typeAt(mask, 3, 1, 8))).toBeCloseTo(0.8, 5);
        // Two wheels off, two on — the per-wheel lookup is what makes that read.
        expect(groundGrip(typeAt(mask, 8, 1, 8))).toBeGreaterThan(groundGrip(typeAt(mask, 12, 1, 8)));
    });

    it('ignores the surface when the wheel is far above it (bridge deck, mid-jump)', () => {
        expect(typeAt(mask, 8, 1, 8)).toBe(GROUND_TYPE.asphalt);
        expect(typeAt(mask, 8, 12, 8)).toBe(GROUND_TYPE.none);
        expect(groundGrip(typeAt(mask, 8, 12, 8))).toBe(1.0);
    });

    it('falls back to full grip outside the mask', () => {
        expect(groundGrip(typeAt(mask, -50, 1, -50))).toBe(1.0);
    });
});
