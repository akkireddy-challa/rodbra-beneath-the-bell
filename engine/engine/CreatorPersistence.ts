// Generic creator-bridge persistence helpers. Neutral home (engine/) so both
// the gaussian-splat save/load path and the PVS persistence path can write
// fields back through the creator's edit-world-config flow without depending
// on each other.
//
// Two sinks:
//  - `saveEnvObjectFields` — per-instance fields on one `environmentObjects[]`
//    entry (voxelUrl, floorMeshUrl, pvsUrl, walkableUrl, …). Posts the legacy
//    `SPLAT_BATCH_SAVED` message (a generic field-batch mechanism; the name is
//    retained for creator-handler compatibility, it is not splat-specific).
//  - `saveWorldProfileField` — a scene-wide field on `worldProfileData`
//    (colliderUrl, pvsUrl, walkableUrl, …). Posts `WORLD_PROFILE_FIELD_SAVED`.
//
// Both resolve once the creator confirms the disk write, so callers can await
// persistence before subsequent ops run.

/**
 * Persist one or more fields on the env-object identified by `envObjectId`
 * via the creator's edit-world-config flow. Resolves true after the creator
 * confirms persistence (so the disk write is observable before later ops run).
 */
export async function saveEnvObjectFields(envObjectId: string, fields: Record<string, unknown>, description?: string): Promise<boolean> {
    if (!window.parent || window.parent === window) {
        console.warn('[CreatorPersistence] No parent frame — cannot persist env-object fields');
        return false;
    }
    const requestId = `env-fields-${envObjectId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    return new Promise<boolean>((resolve) => {
        const timeoutId = window.setTimeout(() => {
            window.removeEventListener('message', handler);
            console.error('[CreatorPersistence] Timeout waiting for SPLAT_BATCH_SAVED_RESPONSE');
            resolve(false);
        }, 15000);
        const handler = (e: MessageEvent) => {
            if (e.data?.type === 'SPLAT_BATCH_SAVED_RESPONSE' && e.data?.requestId === requestId) {
                window.clearTimeout(timeoutId);
                window.removeEventListener('message', handler);
                if (!e.data.success) console.error('[CreatorPersistence] Failed to persist env-object fields:', e.data.error);
                resolve(!!e.data.success);
            }
        };
        window.addEventListener('message', handler);
        window.parent.postMessage({
            type: 'SPLAT_BATCH_SAVED',
            requestId,
            objects: [{ envObjectId, fields }],
            description: description || `Update env-object ${envObjectId}`,
        }, '*');
    });
}

/**
 * Persist a single scene-wide field on `worldProfileData` via the creator's
 * edit-world-config flow. Used for data that is not per-instance — manual box
 * colliders (`colliderUrl`) and scene-wide PVS (`pvsUrl`/`walkableUrl`) on
 * splat-less voxel scenes. Resolves true after the creator confirms.
 */
export async function saveWorldProfileField(field: string, value: unknown, description?: string): Promise<boolean> {
    if (!window.parent || window.parent === window) {
        console.warn('[CreatorPersistence] No parent frame — cannot persist worldProfile field');
        return false;
    }
    const requestId = `world-profile-${field}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    return new Promise<boolean>((resolve) => {
        const timeoutId = window.setTimeout(() => {
            window.removeEventListener('message', handler);
            console.error(`[CreatorPersistence] Timeout waiting for WORLD_PROFILE_FIELD_SAVED_RESPONSE for ${field}`);
            resolve(false);
        }, 15000);
        const handler = (e: MessageEvent) => {
            if (e.data?.type === 'WORLD_PROFILE_FIELD_SAVED_RESPONSE' && e.data?.requestId === requestId) {
                window.clearTimeout(timeoutId);
                window.removeEventListener('message', handler);
                if (!e.data.success) console.error(`[CreatorPersistence] Failed to persist worldProfileData.${field}:`, e.data.error);
                resolve(!!e.data.success);
            }
        };
        window.addEventListener('message', handler);
        window.parent.postMessage({
            type: 'WORLD_PROFILE_FIELD_SAVED',
            requestId,
            field,
            value,
            description: description || `Update worldProfileData.${field}`,
        }, '*');
    });
}
