/**
 * Small wiring helpers extracted from `EditorManager` purely to keep that
 * file under the 2000-line ESLint cap. No behaviour change — each helper
 * is the line-for-line equivalent of what used to be inlined in the
 * manager. If you change one, change it at both call sites in
 * `EditorManager.enableEditorMode` / `disableEditorMode` /
 * `createStandaloneDebugInfo`.
 */

import type * as THREE from 'three';
import type { PointerLockManager } from 'engine/PointerLockManager.js';
import type { DebugGameInfoPanel } from '../debug/DebugGameInfoPanel.js';

/**
 * Toggle the `PointerLockManager.editorMode` flag. Called when the
 * editor enters/leaves editor mode.
 *
 * Why this matters: without flipping editor-mode on, `TransformControls`'
 * `pointerdown` handler hits an `InvalidStateError` on
 * `setPointerCapture` — the pointer-lock state is still active when the
 * gizmo tries to capture pointer events on the canvas. On `false` the
 * lock can re-acquire on the next user click into the game.
 *
 * `getPointerLockManager` is optional on `EngineLike`, so we tolerate it
 * being absent in lightweight test setups.
 */
export function setEditorModeForPointerLock(
    engine: { getPointerLockManager?: () => PointerLockManager | null },
    enabled: boolean,
): void {
    engine.getPointerLockManager?.()?.setEditorMode(enabled);
}

/** Engine accessors the navmesh path-provider reads from each frame. */
interface NavmeshAgentSource {
    getNpcRegistry?: () => { getAllControllers(): Iterable<unknown> } | null;
    getAnimalRegistry?: () => { getAll(): Iterable<unknown> } | null;
}

/** What the panel's path-provider returns to the navmesh overlay. */
interface NavmeshAgentSnapshot {
    position: THREE.Vector3;
    path: THREE.Vector3[];
    currentWaypointIndex: number;
}

/**
 * Connect the debug game-info panel's navmesh overlay to live agent
 * paths. Cyan polylines, one per active NPC/animal controller that
 * exposes `getCurrentPath` + `getCharacter` + `getCurrentWaypointIndex`.
 * `currentWaypointIndex` lets the overlay skip already-passed waypoints
 * so the line doesn't wrap backwards to the path's origin.
 */
export function wireNavmeshPathProviderToDebugPanel(
    panel: DebugGameInfoPanel,
    engine: NavmeshAgentSource,
): void {
    panel.setPathProvider(() => {
        const agents: NavmeshAgentSnapshot[] = [];
        const collect = (ctrls: Iterable<unknown>): void => {
            for (const c of ctrls) {
                const ctrl = c as {
                    getCurrentPath?: () => THREE.Vector3[];
                    getCharacter?: () => THREE.Object3D;
                    getCurrentWaypointIndex?: () => number;
                };
                if (typeof ctrl.getCurrentPath !== 'function' || typeof ctrl.getCharacter !== 'function') continue;
                const path = ctrl.getCurrentPath();
                if (path.length === 0) continue;
                const wpIdx = typeof ctrl.getCurrentWaypointIndex === 'function' ? ctrl.getCurrentWaypointIndex() : 0;
                agents.push({ position: ctrl.getCharacter().position, path, currentWaypointIndex: wpIdx });
            }
        };
        collect(engine.getNpcRegistry?.()?.getAllControllers() ?? []);
        collect(engine.getAnimalRegistry?.()?.getAll() ?? []);
        return agents;
    });
}
