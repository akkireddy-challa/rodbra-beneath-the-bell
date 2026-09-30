import { aabbsShareFace, findUnsupportedFragments, groundPlaneY, type FragmentAabb } from 'engine/FragmentConnectivity.js';

/** Unit-cube AABB at grid position (x, y, z), edge length `s`. */
const box = (x: number, y: number, z: number, s = 1): FragmentAabb => ({
    min: [x, y, z],
    max: [x + s, y + s, z + s],
});

describe('aabbsShareFace', () => {
    it('detects face contact on each axis', () => {
        expect(aabbsShareFace(box(0, 0, 0), box(1, 0, 0))).toBe(true);
        expect(aabbsShareFace(box(0, 0, 0), box(0, 1, 0))).toBe(true);
        expect(aabbsShareFace(box(0, 0, 0), box(0, 0, 1))).toBe(true);
    });

    it('rejects diagonal (edge/corner) contact', () => {
        expect(aabbsShareFace(box(0, 0, 0), box(1, 1, 0))).toBe(false);
        expect(aabbsShareFace(box(0, 0, 0), box(1, 1, 1))).toBe(false);
    });

    it('rejects separated boxes', () => {
        expect(aabbsShareFace(box(0, 0, 0), box(2.5, 0, 0))).toBe(false);
    });

    it('accepts differently-sized touching fragments (octree LOD mix)', () => {
        // 2×2×2 fragment sitting beside four 1³ voxels worth of column.
        expect(aabbsShareFace(box(0, 0, 0, 2), box(2, 0.5, 0.5, 1))).toBe(true);
    });
});

describe('groundPlaneY', () => {
    it('is the minimum Y of the full fragment set', () => {
        expect(groundPlaneY([box(0, 3, 0), box(0, 0, 0), box(1, 7, 0)])).toBe(0);
    });
});

describe('findUnsupportedFragments', () => {
    // Cactus silhouette used across the cases below: trunk stack at x=0 from
    // y=0..3 plus a two-fragment arm off the side at y=2..3.
    const CACTUS: FragmentAabb[] = [
        box(0, 0, 0),   // 0 base
        box(0, 1, 0),   // 1 trunk
        box(0, 2, 0),   // 2 trunk
        box(0, 3, 0),   // 3 trunk top
        box(1, 2, 0),   // 4 arm elbow
        box(1, 3, 0),   // 5 arm tip
    ];
    const GROUND = groundPlaneY(CACTUS);

    it('returns nothing while the object is intact', () => {
        expect(findUnsupportedFragments(CACTUS, GROUND)).toEqual([]);
    });

    it('finds the floating remnant when a MIDDLE fragment is removed', () => {
        const survivors = CACTUS.filter((_, i) => i !== 1);
        // Everything above the gap (old indices 2..5) is now unsupported.
        expect(findUnsupportedFragments(survivors, GROUND)).toEqual([1, 2, 3, 4]);
    });

    it('finds the floating remnant when the BASE is blown away', () => {
        // The reported bug: deriving ground from the survivors made the
        // remnant its own ground layer, so the cactus top hung in mid-air.
        const survivors = CACTUS.filter((_, i) => i !== 0);
        expect(findUnsupportedFragments(survivors, GROUND)).toEqual([0, 1, 2, 3, 4]);
    });

    it('reports every fragment when the whole base layer is gone', () => {
        const survivors = [box(0, 5, 0), box(0, 6, 0)];
        expect(findUnsupportedFragments(survivors, GROUND)).toEqual([0, 1]);
    });

    it('keeps a side arm that is still connected through the trunk', () => {
        expect(findUnsupportedFragments([box(0, 0, 0), box(0, 1, 0), box(1, 1, 0)], 0)).toEqual([]);
    });

    it('keeps a multi-footed structure standing on one remaining leg', () => {
        const arch = [
            box(0, 0, 0), box(0, 1, 0),               // left pillar
            box(2, 0, 0), box(2, 1, 0),               // right pillar
            box(0, 2, 0), box(1, 2, 0), box(2, 2, 0), // lintel
        ];
        const g = groundPlaneY(arch);
        expect(findUnsupportedFragments(arch, g)).toEqual([]);
        // Right pillar gone: the lintel still hangs off the left pillar.
        const oneLegged = [box(0, 0, 0), box(0, 1, 0), box(0, 2, 0), box(1, 2, 0), box(2, 2, 0)];
        expect(findUnsupportedFragments(oneLegged, g)).toEqual([]);
        // Both pillar TOPS gone: the lintel falls, the footings stay.
        const noLegs = [box(0, 0, 0), box(2, 0, 0), box(0, 2, 0), box(1, 2, 0), box(2, 2, 0)];
        expect(findUnsupportedFragments(noLegs, g)).toEqual([2, 3, 4]);
    });

    it('is safe on degenerate inputs', () => {
        expect(findUnsupportedFragments([], 0)).toEqual([]);
        expect(findUnsupportedFragments([box(0, 0, 0)], 0)).toEqual([]);
    });
});
