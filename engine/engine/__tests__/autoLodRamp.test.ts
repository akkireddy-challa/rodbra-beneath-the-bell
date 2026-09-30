import {
    buildAutoLodRamp,
    AUTO_LOD_LEVELS,
    AUTO_LOD_MIN_MAX,
    AUTO_LOD_MAX_BOUND,
} from 'engine/autoLodRamp.js';

describe('buildAutoLodRamp', () => {
    it('doubles min/max voxel size each level, AUTO_LOD_LEVELS deep by default', () => {
        const ramp = buildAutoLodRamp(0.1, 0.5);
        expect(ramp).toEqual([
            { minVoxelSize: 0.2, maxVoxelSize: 1.0 },
            { minVoxelSize: 0.4, maxVoxelSize: 2.0 },
        ]);
        expect(ramp.length).toBe(AUTO_LOD_LEVELS);
    });

    it('returns an empty ramp when zero levels are requested (→ v3, no trailer)', () => {
        expect(buildAutoLodRamp(0.1, 0.5, 0)).toEqual([]);
    });

    it('clamps min and max to their bounds', () => {
        // Base already near the ceiling: one double saturates both bounds.
        const ramp = buildAutoLodRamp(0.6, 3.0, 3);
        for (const lod of ramp) {
            expect(lod.minVoxelSize).toBeLessThanOrEqual(AUTO_LOD_MIN_MAX);
            expect(lod.maxVoxelSize).toBeLessThanOrEqual(AUTO_LOD_MAX_BOUND);
            // max is never below min after clamping.
            expect(lod.maxVoxelSize).toBeGreaterThanOrEqual(lod.minVoxelSize);
        }
    });

    it('stops early once a level can no longer get coarser (both bounds saturated)', () => {
        // Already at the ceiling: every "doubled" level would equal the previous
        // one, so no LODs should be emitted at all.
        const ramp = buildAutoLodRamp(AUTO_LOD_MIN_MAX, AUTO_LOD_MAX_BOUND, 4);
        expect(ramp).toEqual([]);
    });

    it('emits no duplicate consecutive levels', () => {
        const ramp = buildAutoLodRamp(0.5, 2.5, 5);
        for (let i = 1; i < ramp.length; i++) {
            const prev = ramp[i - 1]!;
            const cur = ramp[i]!;
            expect(cur.minVoxelSize === prev.minVoxelSize && cur.maxVoxelSize === prev.maxVoxelSize)
                .toBe(false);
        }
    });
});
