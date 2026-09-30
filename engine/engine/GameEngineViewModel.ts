import * as THREE from 'three';
import type { GameEngine } from 'engine/GameEngine.js';

/**
 * GameEngineViewModel — the engine's half of the first-person view-model layer.
 *
 * A FRIEND MODULE, the same seam GameEnginePostFx uses: GameEngine.ts sits at
 * the repo's 2000-line ESLint cap, so this belongs to the class conceptually but
 * lives here and reaches private state through TypeScript's sanctioned
 * element-access escape hatch (`eng['viewModelLayer']` — typed, not `any`).
 *
 * Import-cycle note: GameEngine.ts imports these functions. The cycle is safe
 * because the GameEngine binding here is type-only — do NOT add a value import
 * of GameEngine, and do not use it outside type position.
 *
 * GameEnginePostFx imports viewModelVisible from here, so this module must NOT
 * import GameEnginePostFx back. That is why syncViewModelLayer REPORTS that a
 * node-graph rebuild is needed instead of performing one: keeping the
 * dependency one-directional means neither module's evaluation order matters.
 */

/** Byte-for-byte the predicate in GameEngine.ts, copied for the reason above. */
const isWebGpuRenderer = (r: unknown): boolean =>
    (r as { isWebGPURenderer?: boolean } | null)?.isWebGPURenderer === true;

/**
 * Whether the view model should be drawn this frame.
 *
 * Read by both render paths and by the WebGPU node-graph assembly. Every case
 * below is one where the render camera is not the player's eye, so a weapon
 * glued to it would follow the editor around the level or turn up in a
 * top-down shot.
 */
export function viewModelVisible(eng: GameEngine): boolean {
    if (!eng['viewModelLayer']?.hasContent()) return false;
    // Spectating hides the layer through the existing WebGPU composite gate
    // as well as scene visibility, without rebuilding the pass graph.
    if (!eng['viewModelLayer'].scene.visible) return false;
    // Orthographic means the top-down "fit whole world" mode is active.
    if (!(eng['camera'] instanceof THREE.PerspectiveCamera)) return false;
    const editor = eng['editorManager'];
    if (editor?.isEditorMode) return false;
    if (editor?.isFreeCameraEnabled?.()) return false;
    if (editor?.isInVoxelObjectEditMode?.()) return false;
    // Splat-export frames become training data; a weapon would bake into it.
    if (eng['gaussianSplatExporterInstance']?.isActive()) return false;
    return true;
}

/**
 * Whether the WebGPU node graph must carry the view-model composite.
 *
 * LATCHED: once a view model has ever existed, the pass stays in the graph for
 * the rest of the session. Changing the graph means building a new
 * RenderPipeline, and on WebGPU that is a SYNCHRONOUS shader compile of the
 * entire post chain — a multi-hundred-millisecond to multi-second freeze (the
 * same hazard PointLightPool documents for toggling lights). Tying that to
 * whether a weapon happens to be equipped means the game hitches when you pick
 * a weapon up and hitches again when you put it down.
 *
 * The cost of leaving it in is one composite over an empty scene, whose
 * coverage mask is zero everywhere, so it resolves to the untouched frame.
 * That is far cheaper than one recompile, let alone one per equip.
 *
 * A game that never uses a view model never pays anything: the latch only trips
 * on the first attach.
 */
export function viewModelPassRequired(eng: GameEngine): boolean {
    if (eng['viewModelPassLatched']) return true;
    if (!eng['viewModelLayer']?.hasContent()) return false;
    eng['viewModelPassLatched'] = true;
    return true;
}

/**
 * Keep the view-model projection current, and report whether the WebGPU node
 * graph now needs rebuilding.
 *
 * The projection is re-synced per frame rather than only from the engine's
 * resize handler because the screen recorder resizes the renderer directly
 * without going through it; the layer no-ops when the aspect is unchanged.
 *
 * @returns true when the caller should call rebuildComposerPasses. Because the
 * pass requirement is latched, this can fire at most once per session.
 */
export function syncViewModelLayer(eng: GameEngine): boolean {
    const layer = eng['viewModelLayer'];
    const renderer = eng['renderer'];
    if (!layer || !renderer) return false;

    layer.syncProjection(renderer);

    const required = viewModelPassRequired(eng);
    if (required === eng['viewModelWasVisible']) return false;
    eng['viewModelWasVisible'] = required;
    return isWebGpuRenderer(renderer);
}

/**
 * Draw the view model over the finished frame — CLASSIC WebGL ONLY.
 *
 * On WebGPU the view model is composited inside the node graph instead; see
 * ViewModelLayer.renderOverlay for why a second render to the canvas blanks the
 * screen there. The guard is on the renderer CLASS rather than the active
 * backend, so a WebGPURenderer that fell back to WebGL2 still takes the node
 * path — it routes through the same unified renderer either way.
 */
export function renderViewModelOverlay(eng: GameEngine): void {
    const renderer = eng['renderer'];
    if (!renderer || isWebGpuRenderer(renderer)) return;
    if (!viewModelVisible(eng)) return;
    eng['viewModelLayer']?.renderOverlay(renderer);
}
