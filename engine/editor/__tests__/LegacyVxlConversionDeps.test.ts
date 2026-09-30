/**
 * Converting a legacy .vxl must not depend on the environment-object system.
 *
 * In production the catalog's convert action failed with "Conversion failed: Voxel save
 * service unavailable" — not randomly, but for whole games at a time. The save service
 * was reached via `getVoxelEditor()?.getSaveService()`, and `VoxelEditor` requires an
 * `EnvironmentObjectSystem` for its OTHER responsibility, updating prefab instances. A
 * game whose world generator exposes no env-object system therefore could not convert,
 * and the error named a missing dependency that was constructible the whole time.
 *
 * The conversion now builds the service directly. That is only correct while the service
 * stays free-standing, which is exactly the property that would be quiet to break: giving
 * it a constructor dependency compiles fine and breaks conversion again, in production,
 * for the same games. So the property is asserted rather than assumed.
 */
import { VoxelObjectSaveService } from 'editor/VoxelObjectSaveService.js';

describe('legacy .vxl conversion dependencies', () => {
    it('constructs the save service with no collaborators', () => {
        // Zero declared parameters — nothing to supply, so nothing can be unavailable.
        expect(VoxelObjectSaveService.length).toBe(0);
        expect(() => new VoxelObjectSaveService()).not.toThrow();
    });

    it('takes its inputs per call, so one instance serves any game', () => {
        // The stateless shape is what lets the conversion path build its own instance
        // instead of borrowing the voxel editor's.
        const service = new VoxelObjectSaveService();
        expect(typeof service.saveVoxelObjectAsAsset).toBe('function');
        expect(service.saveVoxelObjectAsAsset.length).toBe(3); // object, prefabType, gameData
    });

    it('rejects a save with no gameId instead of throwing', async () => {
        // The real failure mode a caller must handle. Returning null (not throwing) is
        // what lets convertLegacyVxlAsset report "Upload failed" rather than surfacing a
        // raw exception to the catalog.
        const service = new VoxelObjectSaveService();
        await expect(
            service.saveVoxelObjectAsAsset({} as never, 'converted', null),
        ).resolves.toBeNull();
    });
});
