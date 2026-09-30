/** @jest-environment jsdom */
import {
    VoxelTextureAtlas,
    CUSTOM_BLOCK_ID_BASE,
    BlockType,
    createGrassBlockType,
    createSandBlockType,
    createIceBlockType,
    createStoneBlockType,
    createDirtBlockType,
    createAsphaltBlockType,
    createWaterBlockType,
    createLavaBlockType,
    createTrunkBlockType,
    createLeavesBlockType,
} from 'engine/VoxelTextureAtlas.js';

/** The voxel genre's built-in registration order, as WorldGenerator runs it. */
function registerVoxelGenreBlocks(atlas: VoxelTextureAtlas): Record<string, number> {
    return {
        GRASS: createGrassBlockType(atlas),
        SAND: createSandBlockType(atlas),
        ICE: createIceBlockType(atlas),
        STONE: createStoneBlockType(atlas),
        DIRT: createDirtBlockType(atlas),
        ASPHALT: createAsphaltBlockType(atlas),
        WATER: createWaterBlockType(atlas),
        LAVA: createLavaBlockType(atlas),
        TRUNK: createTrunkBlockType(atlas),
        LEAVES: createLeavesBlockType(atlas),
    };
}

/** Register a world-supplied custom block the way BlockRegistry does. */
function registerCustomBlock(atlas: VoxelTextureAtlas, name: string): number {
    const id = atlas.getNextCustomBlockId();
    atlas.registerBlockTexture({ id, name, size: 16, top: atlas.generateStoneTexture(16, 0.5, 0.5, 0.5) });
    atlas.registerBlockName(name, id);
    return id;
}

function freshAtlas(): VoxelTextureAtlas {
    const atlas = new VoxelTextureAtlas();
    atlas.initializeAtlas();
    return atlas;
}

describe('custom block id range', () => {
    it('keeps genre built-in ids stable when the world declares custom blocks first', () => {
        // GameEngine.loadGame registers worldProfileData.customBlockTypes BEFORE the
        // genre's WorldGenerator runs. Drawing both from one counter pushed every
        // built-in up by one per custom block, which made the default tree asset
        // (palette: trunk = 9, leaves = 10) render trunk→lava and leaves→trunk.
        const withCustom = freshAtlas();
        registerCustomBlock(withCustom, 'natural_rock');
        const shifted = registerVoxelGenreBlocks(withCustom);

        const baseline = registerVoxelGenreBlocks(freshAtlas());

        expect(shifted).toEqual(baseline);
        expect(baseline.GRASS).toBe(1);
        // The ids the default tree/rock .vxl palettes hard-code.
        expect(baseline.TRUNK).toBe(9);
        expect(baseline.LEAVES).toBe(10);
    });

    it('allocates custom blocks from the reserved range, below the COLOR sentinel', () => {
        const atlas = freshAtlas();
        const first = registerCustomBlock(atlas, 'natural_rock');
        const second = registerCustomBlock(atlas, 'mossy_brick');

        expect(first).toBe(CUSTOM_BLOCK_ID_BASE);
        expect(second).toBe(CUSTOM_BLOCK_ID_BASE + 1);
        expect(second).toBeLessThan(BlockType.COLOR);
    });

    it('does not let a reserved-range registration advance the built-in counter', () => {
        const atlas = freshAtlas();
        registerCustomBlock(atlas, 'natural_rock');
        expect(atlas.getNextBlockId()).toBe(1);
    });

    it('keeps custom and built-in allocation independent in either order', () => {
        const atlas = freshAtlas();
        const builtIns = registerVoxelGenreBlocks(atlas);
        const custom = registerCustomBlock(atlas, 'late_block');

        expect(builtIns.LEAVES).toBe(10);
        expect(custom).toBe(CUSTOM_BLOCK_ID_BASE);
        // Names still resolve to whatever each was assigned.
        expect(atlas.getBlockIdByName('late_block')).toBe(custom);
        expect(atlas.getBlockIdByName('leaves')).toBeUndefined(); // creators don't name-register
    });
});
