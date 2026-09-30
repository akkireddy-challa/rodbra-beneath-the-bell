/**
 * Untether the active splat from its PVS data. Clears `pvsUrl` and
 * `pvsFileSize` on the env-object so reloads no longer fetch the PVS,
 * disables the runtime culler, and drops the in-memory PVS map. The
 * S3 blob itself is left intact — "delete" here means "stop using",
 * not "remove the file". A recompute on the same splat will overwrite
 * the URL on save anyway.
 *
 * Extracted from `GaussianSplatEditor` to keep that file under its
 * 2000-line lint cap.
 */
import type { VoxelPvsCuller } from './VoxelPvsCuller.js';
import type { WalkableMapVisualizer } from './WalkableMapVisualizer.js';
import { saveEnvObjectFields, saveWorldProfileField } from 'engine/CreatorPersistence.js';

export async function clearActivePvs(
    envId: string | null,
    pvsCuller: VoxelPvsCuller | null,
    walkableMap: WalkableMapVisualizer,
): Promise<boolean> {
    pvsCuller?.disable();
    pvsCuller?.clearSplatHandle();
    walkableMap.clear();
    try {
        // Per-instance (placed asset) vs scene-wide (splat-less level): clear the
        // pvsUrl wherever this bake was persisted so reloads stop fetching it.
        if (envId) {
            await saveEnvObjectFields(envId, { pvsUrl: null, pvsFileSize: null }, 'Delete PVS');
        } else {
            await saveWorldProfileField('pvsUrl', null, 'Delete scene PVS');
            await saveWorldProfileField('pvsFileSize', null, 'Delete scene PVS size');
        }
        return true;
    } catch (err) {
        console.error('[clearActivePvs] failed:', err);
        return false;
    }
}
