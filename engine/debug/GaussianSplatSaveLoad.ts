import { showSaveNotification } from './SaveNotifications.js';
import type { VoxelWorld } from 'engine/VoxelWorld.js';
import type { FloorMeshColliderManager } from './FloorMeshColliderManager.js';
import type { GameData } from 'types/game.js';
import { getAgentUrl } from 'engine/agentUrl.js';
import { saveEnvObjectFields, saveWorldProfileField } from 'engine/CreatorPersistence.js';

export async function saveVoxelsToS3(
    voxelWorld: VoxelWorld,
    currentVoxelSize: number,
    voxelWorldBounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } | null,
    gameData: GameData | null,
    envObjectId: string
): Promise<void> {
    const AI_AGENT_URL = getAgentUrl();

    const gameId = gameData?.gameId;
    if (!gameId) {
        console.error('❌ Cannot save: gameId not found in gameData');
        showSaveNotification('', false);
        return;
    }

    if (!envObjectId) {
        console.error('❌ Cannot save voxels: envObjectId is required (splats live on environmentObjects[])');
        showSaveNotification('', false, null, 'Missing envObjectId');
        return;
    }

    const timestamp = Date.now();
    const vxlFilename = `${gameId}-${timestamp}.vxl`;

    if (!voxelWorld || voxelWorld.getChunkCount() === 0) {
        showSaveNotification('No voxels to save', false);
        return;
    }

    try {
        const fileContent = await voxelWorld.saveToFile(vxlFilename, {
            voxelSize: currentVoxelSize,
            bounds: voxelWorldBounds || undefined,
            transform: undefined
        });

        const voxelFileSize = fileContent.length;
        const voxelCount = voxelWorld.getTotalVoxelCount();

        const chunkSize = 8192;
        let binaryString = '';
        for (let i = 0; i < fileContent.length; i += chunkSize) {
            const chunk = fileContent.slice(i, i + chunkSize);
            binaryString += String.fromCharCode.apply(null, Array.from(chunk));
        }
        const base64Content = btoa(binaryString);

        const response = await fetch(`${AI_AGENT_URL}/api/save-collider-file`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                filename: vxlFilename,
                content: base64Content,
                isBase64: true
            })
        });

        if (response.ok) {
            const result = await response.json();
            if (result.success && result.s3Url) {
                // All voxel-collider state lives per-instance on the
                // env-object — never on the asset, never on
                // worldProfileData. Combined batch save means url +
                // count + file size land in a single commit.
                await saveSplatFieldsToEnvObject(envObjectId, {
                    voxelUrl: result.s3Url,
                    voxelCount,
                    voxelFileSize,
                    voxelSize: currentVoxelSize,
                }, 'Save voxel collider for splat');
                showSaveNotification(vxlFilename, true, result.s3Url);
            } else {
                showSaveNotification(vxlFilename, false, null, 'Save returned success but no S3 URL');
            }
        } else {
            let errorData: unknown;
            try {
                errorData = await response.json();
            } catch {
                const errorText = await response.text();
                errorData = { error: errorText };
            }
            const errorMsg = (errorData as {error?: string}).error || 'Unknown error';
            showSaveNotification(vxlFilename, false, null, errorMsg);
        }
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Network error';
        showSaveNotification(vxlFilename, false, null, errorMsg);
    }
}

export async function saveFloorMeshesToS3(
    floorMeshManager: FloorMeshColliderManager,
    gameData: GameData | null,
    envObjectId: string
): Promise<void> {
    console.log('[FloorMesh] saveFloorMeshes() called');

    const gameId = gameData?.gameId;
    if (!gameId) {
        console.error('[FloorMesh] No gameId in gameData');
        return;
    }
    if (!envObjectId) {
        console.error('[FloorMesh] No envObjectId — splats live on environmentObjects[]');
        return;
    }

    console.log('[FloorMesh] Saving for gameId:', gameId);
    const s3Url = await floorMeshManager.saveToS3(gameId);

    if (s3Url) {
        await saveSplatFieldsToEnvObject(envObjectId, { floorMeshUrl: s3Url }, 'Save floor mesh for splat');
    }
}

/**
 * Persist one or more fields on the env-object identified by `envObjectId`
 * via the creator's edit-world-config flow. Splat collider data
 * (`voxelUrl`, `voxelCount`, `voxelFileSize`, `voxelSize`, `floorMeshUrl`)
 * lives exclusively on the env-object — never on the asset, never on
 * `worldProfileData`. The voxel grid is generated in world space with the
 * instance transform baked in, so each placement of the same asset gets
 * its own bake.
 *
 * Resolves true after the creator confirms persistence (so the disk write
 * is observable before subsequent ops run).
 */
export async function saveSplatFieldsToEnvObject(envObjectId: string, fields: Record<string, unknown>, description?: string): Promise<boolean> {
    // Delegates to the neutral env-object field saver (shared with PVS persistence).
    return saveEnvObjectFields(envObjectId, fields, description ?? `Update splat ${envObjectId}`);
}

/**
 * Look up a per-instance splat field on the env-object whose asset URL matches `splatUrl`.
 * Splat instance fields (voxelUrl, floorMeshUrl, radUrl)
 * live on the corresponding entry in `gameData.environmentObjects`.
 */
function findSplatEnvObject(gameData: GameData | null, splatUrl: string): Record<string, unknown> | null {
    const assets = gameData?.assets as Array<{ id: string; url: string }> | undefined;
    const envs = gameData?.environmentObjects as Array<Record<string, unknown>> | undefined;
    if (!assets || !envs) return null;
    const asset = assets.find(a => a.url === splatUrl);
    if (!asset) return null;
    return envs.find(e => e.assetId === asset.id) ?? null;
}

/**
 * Resolve the splat's per-instance voxel collider URL from the env-object.
 * Voxel colliders are world-space, generated with the instance transform
 * baked in, so they live exclusively on `environmentObjects[].voxelUrl` —
 * never on the asset, never on `worldProfileData`. The voxel-genre terrain
 * uses `worldProfileData.voxelUrl` for an unrelated purpose; do not consult
 * it here.
 */
export function getVoxelUrlFromGameData(gameData: GameData | null, splatUrl?: string): { url: string; timestamp: number } | null {
    if (!splatUrl) return null;
    const env = findSplatEnvObject(gameData, splatUrl);
    const url = env?.voxelUrl as string | undefined;
    return url ? { url, timestamp: 0 } : null;
}

export function getFloorMeshUrlFromGameData(gameData: GameData | null, splatUrl?: string): string | null {
    if (splatUrl) {
        const env = findSplatEnvObject(gameData, splatUrl);
        const url = env?.floorMeshUrl as string | undefined;
        if (url) return url;
    }
    return gameData?.worldProfileData?.floorMeshUrl || null;
}

export function getColliderUrlFromGameData(gameData: GameData | null): string | null {
    return gameData?.worldProfileData?.colliderUrl || null;
}

/**
 * Save the manual-box-collider JSON URL onto `worldProfileData.colliderUrl`.
 * This is the only legitimate use of a global URL field — manual box
 * colliders + heightmap data are scene-wide, not per-splat. Routes through
 * the creator's edit-world-config flow (canonical path), so the write lands
 * in the saved game's world.json.
 */
export async function saveColliderUrlToWorldJson(url: string): Promise<void> {
    // Delegates to the neutral world-profile field saver (shared with PVS persistence).
    await saveWorldProfileField('colliderUrl', url, 'Update worldProfileData.colliderUrl');
}
