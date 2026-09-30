/**
 * `dynamic` env instances moved from their own standalone VoxelObject into the
 * render batch behind a pristine proxy. Re-routing must not change how a prop
 * BEHAVES once something pushes it, and mass is the one number that decides
 * that — so resolveDynamicPropMass has to reproduce the formula the old inline
 * individual path used, clamps included.
 */
import { resolveDynamicPropMass } from 'engine/PristineDynamic.js';

/** The formula as it was written inline in createInteractableObjects. */
function legacyMass(
    objDef: { mass?: number },
    bb: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } | undefined,
    scale?: { width: number; height: number; depth: number },
): number {
    const volume = bb
        ? Math.max(0.01,
            (bb.maxX - bb.minX) * (scale?.width ?? 1)
            * (bb.maxY - bb.minY) * (scale?.height ?? 1)
            * (bb.maxZ - bb.minZ) * (scale?.depth ?? 1))
        : 0;
    const authored = typeof objDef.mass === 'number' && Number.isFinite(objDef.mass) && objDef.mass > 0
        ? Math.min(3000, Math.max(0.1, objDef.mass))
        : null;
    return authored ?? (volume > 0 ? Math.min(3000, Math.max(5, volume * 120)) : 10);
}

const carWreck = { minX: -2, minY: 0, minZ: -0.8, maxX: 2, maxY: 1.5, maxZ: 0.8 };
const crate = { minX: -0.25, minY: 0, minZ: -0.25, maxX: 0.25, maxY: 0.5, maxZ: 0.25 };

describe('resolveDynamicPropMass', () => {
    test.each([
        ['car-sized wreck, estimated', {}, carWreck, undefined],
        ['crate, estimated', {}, crate, undefined],
        ['authored mass wins over the estimate', { mass: 15 }, carWreck, undefined],
        ['authored mass clamped to the 3000 ceiling', { mass: 999999 }, carWreck, undefined],
        ['authored mass clamped to the 0.1 floor', { mass: 0.0001 }, crate, undefined],
        ['non-positive authored mass falls back to the estimate', { mass: 0 }, crate, undefined],
        ['scale is folded into the volume', {}, crate, { width: 4, height: 4, depth: 4 }],
        ['no bounding box at all', {}, undefined, undefined],
    ])('matches the pre-batching formula: %s', (_label, objDef, bb, scale) => {
        expect(resolveDynamicPropMass(objDef, bb, scale)).toBe(legacyMass(objDef, bb, scale));
    });

    test('a huge prop is capped rather than handed the solver a 10-tonne body', () => {
        const stadium = { minX: -40, minY: 0, minZ: -40, maxX: 40, maxY: 20, maxZ: 40 };
        expect(resolveDynamicPropMass({}, stadium)).toBe(3000);
    });

    test('a degenerate zero-volume box still gets a usable mass', () => {
        const flat = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
        expect(resolveDynamicPropMass({}, flat)).toBeGreaterThan(0);
    });
});
