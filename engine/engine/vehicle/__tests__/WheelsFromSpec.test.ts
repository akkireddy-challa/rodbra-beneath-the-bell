/**
 * A forge-built kart rebuilds its wheels instead of downloading them.
 *
 * The forge builds wheels parametrically from the axles (`wheel-mesh.ts`), bakes them into
 * the GLB as BM_wheel_* nodes, and the runtime downloaded that GLB to get them back — on a
 * published circuit, ~200 KB per kart to accompany a 3 KB voxel chassis, 1.14 MB across six
 * karts. The two builders are the same implementation ported: same style vocabulary, same
 * constants (RIM_SILVER #b9bdc4, CHROME #d9dde2, HUB_DARK #43464c), same proportions. So
 * the download recovers meshes the engine can reproduce exactly.
 *
 * `wheelsFromSpec` is the permission to do that, and its DEFAULT MATTERS: a hand-authored
 * Blender kart's wheels are arbitrary art that no parameter set reproduces, and an asset
 * imported before this field existed cannot answer the question. Both must keep fetching,
 * so absent has to mean "download", never "assume".
 */
import { deriveVehicleFitment } from 'engine/vehicle/BmVehicleFitment.js';

const bodyBounds = {
    min: { x: -0.6, y: 0, z: -1 },
    max: { x: 0.6, y: 0.8, z: 1 },
} as never;

/** The bmVehicle extras a GLB carries, with or without the forge's spec. */
function extras(opts: { spec?: unknown } = {}): unknown {
    return {
        bmVehicle: {
            version: 1,
            axles: [
                { z: 0.7, y: 0.25, radius: 0.25, width: 0.2, track: 1.0, steering: true, driven: false, wheelStyle: 'alloy5' },
                { z: -0.7, y: 0.25, radius: 0.25, width: 0.2, track: 1.0, steering: false, driven: true, wheelStyle: 'alloy5' },
            ],
            collisionBoxes: [],
            ...(opts.spec !== undefined ? { spec: opts.spec } : {}),
        },
    };
}

const derive = (e: unknown) => deriveVehicleFitment(e, { bodyBounds, hasWheelNodes: true, appliedScale: 1 });

describe('wheelsFromSpec', () => {
    it('is set when the GLB carries a forge spec', () => {
        const d = derive(extras({ spec: { body: {} } }));
        expect(d?.fitment.wheelsFromSpec).toBe(true);
    });

    it('is ABSENT for a hand-authored GLB, so its custom wheels still load', () => {
        // The failure this prevents is silent and ugly: a Blender kart's sculpted wheels
        // would be replaced by generic parametric ones, and only a human looking at the
        // car would ever notice.
        const d = derive(extras());
        expect(d?.fitment.wheelsFromSpec).toBeUndefined();
    });

    it('carries a tire colour only when the paint overrides the default', () => {
        // The forge's DEFAULT_RUBBER_COLOR and the engine's TIRE_COLOR are both #16181c.
        // Storing the default would imply a decision nobody made.
        const plain = derive(extras({ spec: { paint: { rubber: '#16181c' } } }));
        expect(plain?.fitment.tireColor).toBeUndefined();

        const painted = derive(extras({ spec: { paint: { rubber: '#8b0000' } } }));
        expect(painted?.fitment.tireColor).toBe('#8b0000');
    });

    it('ignores a default written in different case', () => {
        const d = derive(extras({ spec: { paint: { rubber: '#16181C' } } }));
        expect(d?.fitment.tireColor).toBeUndefined();
    });

    it('survives a spec with no paint at all', () => {
        const d = derive(extras({ spec: { body: { width: 1 } } }));
        expect(d?.fitment.wheelsFromSpec).toBe(true);
        expect(d?.fitment.tireColor).toBeUndefined();
    });

    it('keeps every axle parameter the rebuild depends on', () => {
        // Rebuilding is only exact while these survive derivation — style above all, since
        // a wrong style is a different-looking wheel of the right size.
        const axle = derive(extras({ spec: {} }))?.fitment.axles[0];
        expect(axle?.wheelStyle).toBe('alloy5');
        expect(axle?.radius).toBeCloseTo(0.25);
        expect(axle?.width).toBeCloseTo(0.2);
    });
});
