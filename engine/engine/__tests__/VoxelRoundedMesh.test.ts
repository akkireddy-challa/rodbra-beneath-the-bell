import { mergeVoxelRoundingRadiusVoxels } from 'engine/VoxelRoundedMesh.js';

describe('mergeVoxelRoundingRadiusVoxels', () => {
    it('inherits world when block undefined', () => {
        expect(mergeVoxelRoundingRadiusVoxels(0.2, undefined)).toBe(0.2);
    });
    it('uses block override when set', () => {
        expect(mergeVoxelRoundingRadiusVoxels(0.2, 0.08)).toBe(0.08);
    });
    it('zeros when both zero', () => {
        expect(mergeVoxelRoundingRadiusVoxels(0, undefined)).toBe(0);
    });
});
