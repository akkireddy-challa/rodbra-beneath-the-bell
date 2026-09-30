/**
 * Remember where the editor camera was looking across a game reload.
 *
 * Background work (a finished high-quality asset generation) reloads the level so the new
 * mesh appears. That used to drop the user back at the default view — brutal on a large
 * level, where the object they were working on can be a minute's flight away at the far end
 * of a track.
 *
 * Stored in `sessionStorage` rather than a module variable because both reload paths have
 * to be covered: the in-page `reloadCurrentGame` (same JS context) and `RELOAD_GAME`'s
 * `window.location.reload()` (fresh context). It is keyed by game id and stamped, so a
 * stale entry can never hijack the camera of a different game or a later session.
 */

import * as THREE from 'three';

const KEY = 'bm-editor-view';
/** Beyond this the entry is treated as stale — a reload takes seconds, not minutes. */
const MAX_AGE_MS = 120_000;

interface StoredView {
    gameId: string;
    at: number;
    pos: [number, number, number];
    quat: [number, number, number, number];
}

export function saveEditorView(gameId: string | null, camera: THREE.Camera | null): void {
    if (!gameId || !camera) return;
    try {
        const view: StoredView = {
            gameId,
            at: Date.now(),
            pos: [camera.position.x, camera.position.y, camera.position.z],
            quat: [camera.quaternion.x, camera.quaternion.y, camera.quaternion.z, camera.quaternion.w],
        };
        sessionStorage.setItem(KEY, JSON.stringify(view));
    } catch {
        // sessionStorage can be unavailable (private mode, quota) — losing the view is
        // cosmetic, so never let it break a reload.
    }
}

/**
 * Apply a saved view to the camera, if one matches this game and is recent. Consumed on
 * use (a single reload) so a later manual navigation is never overridden.
 *
 * Call this AFTER the level has loaded but BEFORE the editor activates its debug camera:
 * `DebugCameraController.activate(fromCamera)` derives its orbit state from whatever the
 * camera's transform is at that moment, so seeding the camera is enough — no controller
 * internals to poke.
 */
export function restoreEditorView(gameId: string | null, camera: THREE.Camera | null): boolean {
    if (!gameId || !camera) return false;
    try {
        const raw = sessionStorage.getItem(KEY);
        if (!raw) return false;
        sessionStorage.removeItem(KEY);
        const view = JSON.parse(raw) as StoredView;
        if (view.gameId !== gameId) return false;
        if (!Number.isFinite(view.at) || Date.now() - view.at > MAX_AGE_MS) return false;
        camera.position.set(view.pos[0], view.pos[1], view.pos[2]);
        camera.quaternion.set(view.quat[0], view.quat[1], view.quat[2], view.quat[3]);
        camera.updateMatrixWorld();
        return true;
    } catch {
        return false;
    }
}
