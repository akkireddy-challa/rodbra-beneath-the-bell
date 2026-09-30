/**
 * Save/load orchestration for the walkable-map + PVS bake. The visualizer
 * owns the data; this module wires it to the S3-backed save endpoints
 * and the editor's env-object pointer so the data survives reload.
 *
 * Split out from `GaussianSplatEditor.ts` to keep that file under its
 * 2000-line lint cap — the editor still exposes thin wrappers that
 * delegate here.
 */
import { saveWalkableMapToS3, savePvsToS3, saveWalkableMapToWorldProfile, savePvsToWorldProfile } from './PvsPersistence.js';
import { safePostMessageToCreator } from 'engine/CreatorMode.js';
import type { WalkableMapVisualizer } from './WalkableMapVisualizer.js';
import type { VoxelWorld } from 'engine/VoxelWorld.js';
import type { GameData } from 'types/game.js';

/**
 * Background-persist a freshly-built walkable map. Fire-and-forget — the
 * UI doesn't block on the upload. On failure the visualization still
 * works for the current session; only the next reload would miss it.
 */
export function persistWalkableMapInBackground(
    walkable: WalkableMapVisualizer,
    envObjectId: string | null,
    gameData: GameData | null,
): void {
    const data = walkable.toJSON();
    if (!data) return;
    // Per-instance when a placed asset (e.g. a splat) owns the bake; scene-wide
    // on `worldProfileData` for a splat-less voxel/GLB level.
    const save = envObjectId
        ? saveWalkableMapToS3(data, gameData, envObjectId)
        : saveWalkableMapToWorldProfile(data, gameData);
    save.catch((err) => {
        console.error('[WalkableMap] Background save failed (visualization unaffected):', err);
    });
}

/**
 * Restore a previously-saved walkable map from its S3 URL and notify the
 * creator panel so the "Walkable" checkbox can flip enabled. Mesh is
 * created hidden — V cycle / per-row checkbox controls visibility.
 */
export async function loadWalkableMapFromUrl(
    walkable: WalkableMapVisualizer,
    world: VoxelWorld | null,
    url: string,
): Promise<{ cellCount: number }> {
    if (!world) {
        console.warn('[WalkableMap] Load: no voxel world available yet — skipping');
        return { cellCount: 0 };
    }
    try {
        const resp = await fetch(url);
        if (!resp.ok) {
            console.warn(`[WalkableMap] Load failed: ${resp.status} ${url}`);
            return { cellCount: 0 };
        }
        const data = await resp.json();
        const result = walkable.loadFromData(data, world);
        walkable.setVisible(false);
        safePostMessageToCreator({ type: 'WALKABLE_MAP_LOADED', cellCount: result.cellCount });
        return result;
    } catch (err) {
        console.error('[WalkableMap] Load failed:', err);
        return { cellCount: 0 };
    }
}

/**
 * Persist a freshly-computed PVS bake (binary). Returns the saved URL
 * so callers can keep their progress UI open until the upload lands —
 * the buffer is 5–15 MB for CyberPunk-scale scenes and the user can
 * easily reload while it's still in flight if the save was fired-and-
 * forgotten.
 */
export async function persistPvs(
    walkable: WalkableMapVisualizer,
    envObjectId: string | null,
    gameData: GameData | null,
): Promise<{ url: string | null; bytes: number }> {
    const buffer = walkable.encodePvs();
    if (!buffer) return { url: null, bytes: 0 };
    try {
        // Per-instance when a placed asset owns the bake; scene-wide otherwise.
        const url = envObjectId
            ? await savePvsToS3(buffer, gameData, envObjectId)
            : await savePvsToWorldProfile(buffer, gameData);
        return { url, bytes: buffer.byteLength };
    } catch (err) {
        console.error('[PVS] Save failed:', err);
        return { url: null, bytes: buffer.byteLength };
    }
}

/** Restore a previously-saved PVS file. Requires the walkable map to have already been loaded. */
export async function loadPvsFromUrl(
    walkable: WalkableMapVisualizer,
    url: string,
): Promise<{ cellCount: number; totalEntries: number } | null> {
    try {
        const resp = await fetch(url);
        if (!resp.ok) {
            console.warn(`[PVS] Load failed: ${resp.status} ${url}`);
            return null;
        }
        const buffer = await resp.arrayBuffer();
        const result = walkable.decodePvs(buffer);
        safePostMessageToCreator({
            type: 'WALKABLE_VISIBILITY_LOADED',
            cellCount: result.cellCount,
            totalEntries: result.totalEntries,
        });
        return result;
    } catch (err) {
        console.error('[PVS] Load failed:', err);
        return null;
    }
}
