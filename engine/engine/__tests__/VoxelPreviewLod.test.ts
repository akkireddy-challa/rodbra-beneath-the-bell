/**
 * Which baked LOD an asset thumbnail is drawn from.
 *
 * The preview renderer used to take the COARSEST level unconditionally, to keep the
 * Assets tab from stalling the game while it backfills previews. For a big asset that is
 * free; for a small one it is destructive, because coarsening halves the resolution per
 * level — the default 7-voxel rocks came out as a single cube and the 92-voxel trees as
 * nine. Both halves are pinned here: small assets must keep their detail, and an asset
 * whose LOD0 blows the budget must still be coarsened.
 */
import { pickPreviewLod, PREVIEW_LEAF_BUDGET } from 'engine/VoxelPreviewRenderer.js';
import { LeafBuffer } from 'engine/VoxelOctreeRenderer.js';
import type { DecodedFragment, DecodedLodLevel, DecodedVxlV3 } from 'engine/VxlV3Format.js';

/** A fragment carrying `count` leaves — only `leaves.count` is read. */
function fragment(count: number): DecodedFragment {
    return {
        aabbMin: [0, 0, 0],
        aabbMax: [1, 1, 1],
        leaves: new LeafBuffer(count, 1, 0, 0, 0),
    };
}

function decoded(lod0: number, ...coarser: number[]): DecodedVxlV3 {
    const lods: DecodedLodLevel[] = coarser.map((count, i) => ({
        minVoxelSize: 1 << (i + 1),
        maxVoxelSize: 1 << (i + 1),
        fragments: [fragment(count)],
    }));
    return {
        minVoxelSize: 1,
        maxVoxelSize: 1,
        physicsGridStep: 0.5,
        bounds: { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 },
        useAtlas: false,
        fragments: [fragment(lod0)],
        ...(lods.length > 0 ? { additionalLods: lods } : {}),
    };
}

const leafCount = (level: readonly DecodedFragment[]): number =>
    level.reduce((total, f) => total + f.leaves.count, 0);

describe('pickPreviewLod', () => {
    it('keeps LOD0 for a small asset rather than coarsening it to a blob', () => {
        // The real default rock: 7 leaves, coarsening to 3 then 1.
        expect(leafCount(pickPreviewLod(decoded(7, 3, 1)))).toBe(7);
        // The real default tree: 92 leaves, coarsening to 27 then 9.
        expect(leafCount(pickPreviewLod(decoded(92, 27, 9)))).toBe(92);
    });

    it('coarsens an asset whose LOD0 exceeds the budget', () => {
        const big = PREVIEW_LEAF_BUDGET * 8;
        expect(leafCount(pickPreviewLod(decoded(big, big / 8, big / 64)))).toBe(big / 8);
    });

    it('takes the finest level that fits, not merely the first that is smaller', () => {
        // LOD1 fits, so LOD2 must not be chosen even though it is cheaper still.
        const over = PREVIEW_LEAF_BUDGET + 1;
        expect(leafCount(pickPreviewLod(decoded(over, PREVIEW_LEAF_BUDGET, 10)))).toBe(PREVIEW_LEAF_BUDGET);
    });

    it('falls back to the coarsest level when nothing fits', () => {
        const huge = PREVIEW_LEAF_BUDGET * 10;
        expect(leafCount(pickPreviewLod(decoded(huge, huge, huge - 1)))).toBe(huge - 1);
    });

    it('uses LOD0 when the asset carries no LOD trailer at all', () => {
        expect(leafCount(pickPreviewLod(decoded(42)))).toBe(42);
    });
});
