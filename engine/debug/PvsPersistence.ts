// PVS / walkable-map persistence — S3 upload + write-back of the resulting
// URLs. Two destinations:
//
//  - Per-instance (`*ToS3`) — writes `walkableUrl`/`pvsUrl` onto one
//    `environmentObjects[]` entry (the path a gaussian splat uses; the splat
//    is one env-object among many).
//  - Scene-wide (`*ToWorldProfile`) — writes onto `worldProfileData` for
//    splat-less voxel/GLB scenes where the PVS belongs to the whole level,
//    not a single placed asset.
//
// This module has NO gaussian-splat dependency — it is the persistence half
// of the geometry-agnostic PVS subsystem.
import { saveEnvObjectFields, saveWorldProfileField } from 'engine/CreatorPersistence.js';
import { getAgentUrl } from 'engine/agentUrl.js';
import type { GameData } from 'types/game.js';

/** Upload a file to the shared collider-file endpoint; returns the S3 URL or null. */
async function uploadColliderFile(filename: string, content: string, isBase64: boolean): Promise<string | null> {
    const resp = await fetch(`${getAgentUrl()}/api/save-collider-file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, content, isBase64 }),
    });
    if (!resp.ok) {
        console.error(`[PVS-persist] Upload failed: ${resp.status} ${await resp.text()}`);
        return null;
    }
    const result = await resp.json();
    if (!result.success || !result.s3Url) {
        console.error('[PVS-persist] Upload returned no s3Url');
        return null;
    }
    return result.s3Url as string;
}

/** base64-encode a binary buffer in chunks (avoids the call-stack limit on huge buffers). */
function toBase64(buffer: Uint8Array): string {
    const chunkSize = 8192;
    let binaryString = '';
    for (let i = 0; i < buffer.length; i += chunkSize) {
        binaryString += String.fromCharCode.apply(null, Array.from(buffer.subarray(i, i + chunkSize)));
    }
    return btoa(binaryString);
}

// ---- Per-instance (env-object) — splat or any placed asset ----

/**
 * Persist a walkable-map JSON for the given env-object. Writes `walkableUrl`
 * onto the env-object so the next reload restores it automatically. Returns
 * the S3 URL on success or null on failure.
 */
export async function saveWalkableMapToS3(walkableData: unknown, gameData: GameData | null, envObjectId: string): Promise<string | null> {
    const gameId = gameData?.gameId;
    if (!gameId) { console.error('[WalkableMap] No gameId in gameData'); return null; }
    if (!envObjectId) { console.error('[WalkableMap] No envObjectId'); return null; }
    const filename = `${gameId}-walkable-${Date.now()}.json`;
    const jsonString = JSON.stringify(walkableData);
    console.log(`[WalkableMap] Saving ${(jsonString.length / 1024).toFixed(1)} KB JSON to ${filename}`);
    const s3Url = await uploadColliderFile(filename, jsonString, false);
    if (!s3Url) return null;
    await saveEnvObjectFields(envObjectId, { walkableUrl: s3Url, walkableFileSize: jsonString.length }, 'Save walkable map');
    console.log(`[WalkableMap] Saved: ${s3Url}`);
    return s3Url;
}

/**
 * Persist the PVS (potentially-visible-set) buffer for the given env-object.
 * The buffer is `WalkableMapVisualizer.encodePvs()` output — far smaller than
 * the equivalent JSON. Writes `pvsUrl` onto the env-object.
 */
export async function savePvsToS3(pvsBuffer: Uint8Array, gameData: GameData | null, envObjectId: string): Promise<string | null> {
    const gameId = gameData?.gameId;
    if (!gameId) { console.error('[PVS] No gameId'); return null; }
    if (!envObjectId) { console.error('[PVS] No envObjectId'); return null; }
    const filename = `${gameId}-pvs-${Date.now()}.bin`;
    console.log(`[PVS] Saving ${(pvsBuffer.length / 1024 / 1024).toFixed(1)} MB binary to ${filename}`);
    const s3Url = await uploadColliderFile(filename, toBase64(pvsBuffer), true);
    if (!s3Url) return null;
    await saveEnvObjectFields(envObjectId, { pvsUrl: s3Url, pvsFileSize: pvsBuffer.byteLength }, 'Save visibility data');
    console.log(`[PVS] Saved: ${s3Url}`);
    return s3Url;
}

// ---- Scene-wide (worldProfile) — splat-less voxel/GLB levels ----

/** Persist a walkable-map JSON scene-wide (onto `worldProfileData.walkableUrl`). */
export async function saveWalkableMapToWorldProfile(walkableData: unknown, gameData: GameData | null): Promise<string | null> {
    const gameId = gameData?.gameId;
    if (!gameId) { console.error('[WalkableMap] No gameId in gameData'); return null; }
    const filename = `${gameId}-walkable-${Date.now()}.json`;
    const jsonString = JSON.stringify(walkableData);
    const s3Url = await uploadColliderFile(filename, jsonString, false);
    if (!s3Url) return null;
    await saveWorldProfileField('walkableUrl', s3Url, 'Save scene walkable map');
    await saveWorldProfileField('walkableFileSize', jsonString.length, 'Save scene walkable-map size');
    return s3Url;
}

/** Persist a PVS buffer scene-wide (onto `worldProfileData.pvsUrl`). */
export async function savePvsToWorldProfile(pvsBuffer: Uint8Array, gameData: GameData | null): Promise<string | null> {
    const gameId = gameData?.gameId;
    if (!gameId) { console.error('[PVS] No gameId'); return null; }
    const filename = `${gameId}-pvs-${Date.now()}.bin`;
    const s3Url = await uploadColliderFile(filename, toBase64(pvsBuffer), true);
    if (!s3Url) return null;
    await saveWorldProfileField('pvsUrl', s3Url, 'Save scene visibility data');
    await saveWorldProfileField('pvsFileSize', pvsBuffer.byteLength, 'Save scene visibility size');
    return s3Url;
}
