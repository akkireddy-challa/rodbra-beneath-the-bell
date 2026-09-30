import { handleVoxelizeGlbAsLevel } from 'engine/template/VoxelMessageHandlers.js';
import { voxelizeGLBToVxlWorld } from 'engine/VxlWorldVoxelizer.js';
import { uploadFile } from 'engine/StorageUploadUtil.js';

jest.mock('engine/VxlWorldVoxelizer.js', () => ({
    voxelizeGLBToVxlWorld: jest.fn(),
}));
jest.mock('engine/StorageUploadUtil.js', () => ({
    uploadFile: jest.fn(),
}));
jest.mock('editor/VoxelObjectSaveService.js', () => ({
    VoxelObjectSaveService: jest.fn(),
}));

describe('handleVoxelizeGlbAsLevel settings round-trip', () => {
    it('passes collision-only nodes to the voxelizer and echoes them in the asset settings', async () => {
        const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        const collisionOnly = { DungeonCollision: true } as const;
        jest.mocked(voxelizeGLBToVxlWorld).mockResolvedValue({
            vwldBytes: new Uint8Array([1, 2, 3]),
            // The bake also emits coarser variants for mobile; none here, which is the
            // shape a level baked before variants existed still has.
            lodVariants: [],
            worldBounds: { minX: 0, minY: 0, minZ: 0, maxX: 16, maxY: 16, maxZ: 16 },
            chunkSize: 16,
            nonEmptyChunkCount: 1,
            totalLod0Leaves: 3,
            totalTrimeshTriangles: 0,
            totalTrimeshBytes: 0,
            perObjectVoxelCounts: {},
            emissiveUnmatched: [],
        });
        jest.mocked(uploadFile).mockResolvedValue('https://assets.test/level.vwld');
        const messages: Array<Record<string, unknown>> = [];
        const ctx = {
            getCurrentGameData: () => ({ gameId: 'game-test' }),
            safePostMessage: (message: Record<string, unknown>) => messages.push(message),
        };

        try {
            await handleVoxelizeGlbAsLevel(ctx as never, {
                requestId: 'request-test',
                glbData: [1, 2, 3],
                levelName: 'Dungeon',
                options: {
                    levelSizeX: 32,
                    levelSizeZ: 32,
                    chunkSize: 16,
                    minVoxelSize: 0.125,
                    maxVoxelSize: 1,
                    fillInterior: false,
                    objectCollisionOnlyNodes: collisionOnly,
                },
            });

            expect(jest.mocked(voxelizeGLBToVxlWorld).mock.calls[0]?.[1].objectCollisionOnlyNodes)
                .toEqual(collisionOnly);
            const result = messages.find((message) => message.type === 'VOXELIZE_GLB_AS_LEVEL_RESULT') as {
                assetRecord?: { levelVoxelizeSettings?: { objectCollisionOnlyNodes?: Record<string, true> } };
            };
            expect(result.assetRecord?.levelVoxelizeSettings?.objectCollisionOnlyNodes).toEqual(collisionOnly);
        } finally {
            log.mockRestore();
        }
    });
});
