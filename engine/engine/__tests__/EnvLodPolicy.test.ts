import {
    BUILDING_LOD_MAX_DIM_M, BUILDING_LOD_DISTANCES_M, PROP_LOD_DISTANCES_M,
    BUILDING_ADDITIONAL_LODS, PROP_ADDITIONAL_LODS,
    isBuildingSized, additionalLodsForSize, additionalLodsForBake,
} from 'engine/EnvLodPolicy.js';

describe('EnvLodPolicy', () => {
    it('building schedule is the wide 100/200/300, prop schedule is the tight default', () => {
        expect(BUILDING_LOD_DISTANCES_M).toEqual([0, 100, 200, 300]);
        expect(PROP_LOD_DISTANCES_M).toEqual([0, 70, 120, 180, 240]);
    });

    it('classifies real forged assets correctly (buildings >= ~14.7m, props <= ~7.5m)', () => {
        // Buildings / landmarks from the real Mini-NYC forge.
        for (const maxDim of [14.7, 17, 33.1, 48, 66, 49, 89.1]) expect(isBuildingSized(maxDim)).toBe(true);
        // Props from the same forge.
        for (const maxDim of [7.5, 7.2, 6, 4.5, 3.8, 2.8, 2, 1.5, 1.2]) expect(isBuildingSized(maxDim)).toBe(false);
    });

    it('threshold sits in the gap between the largest prop and smallest building', () => {
        expect(BUILDING_LOD_MAX_DIM_M).toBeGreaterThan(7.5);
        expect(BUILDING_LOD_MAX_DIM_M).toBeLessThanOrEqual(14.7);
    });

    it('buildings bake an extra (4th) LOD; props keep 3 total', () => {
        expect(additionalLodsForSize(50)).toBe(BUILDING_ADDITIONAL_LODS);
        expect(additionalLodsForSize(3)).toBe(PROP_ADDITIONAL_LODS);
        expect(BUILDING_ADDITIONAL_LODS).toBe(3); // LOD0..3 → LOD3 @ 300
        expect(PROP_ADDITIONAL_LODS).toBe(2);      // LOD0..2 → unchanged
    });

    describe('additionalLodsForBake', () => {
        it('reads the fitBox on its longest axis, not just its height', () => {
            // A low, wide landmark: 20 m across, only 5 m tall. The runtime classifies it
            // from its rendered bbox, which is 20 m — so the bake has to agree.
            expect(additionalLodsForBake({ x: 20, z: 8, height: 5 }, 0)).toBe(BUILDING_ADDITIONAL_LODS);
            expect(additionalLodsForBake({ x: 4, z: 3, height: 2.5 }, 0)).toBe(PROP_ADDITIONAL_LODS);
        });

        it('falls back to the caller-supplied max dimension when there is no fitBox', () => {
            expect(additionalLodsForBake(undefined, 30)).toBe(BUILDING_ADDITIONAL_LODS);
            expect(additionalLodsForBake(undefined, 2)).toBe(PROP_ADDITIONAL_LODS);
            // No box, no size signal at all: a prop ladder, never a building's.
            expect(additionalLodsForBake(undefined, 0)).toBe(PROP_ADDITIONAL_LODS);
        });

        it('gives the GLB and voxel-master bakes the same ladder for one asset', () => {
            // The regression this guards: the master path hardcoded 2, so a CLI-generated
            // building baked 3 levels where the Creator's mesh path baked 4 — and the
            // runtime then applied the 4-level building schedule to it either way.
            const fitBox = { x: 18, z: 14, height: 40 };
            // GLB path signal (pre-voxelization): fitBox, else the requested targetHeight.
            const fromGlb = additionalLodsForBake(fitBox, 40);
            // Master path signal (post-resample): fitBox, else the true span in metres.
            const fromMaster = additionalLodsForBake(fitBox, 256 * 0.16);
            expect(fromGlb).toBe(fromMaster);
            expect(fromMaster).toBe(BUILDING_ADDITIONAL_LODS);
        });
    });

    it('a 4-LOD building maps to [0,100,200,300]; a 3-LOD building drops the unused 300', () => {
        // Mirror deriveLodConfig's fill: lodDistances[k] = schedule[k] ?? last.
        const fill = (schedule: number[], lodCount: number): number[] =>
            Array.from({ length: lodCount }, (_, k) => (k === 0 ? 0 : (schedule[k] ?? schedule[schedule.length - 1]!)));
        expect(fill(BUILDING_LOD_DISTANCES_M, 4)).toEqual([0, 100, 200, 300]);
        expect(fill(BUILDING_LOD_DISTANCES_M, 3)).toEqual([0, 100, 200]);
        expect(fill(PROP_LOD_DISTANCES_M, 3)).toEqual([0, 70, 120]);
    });
});
