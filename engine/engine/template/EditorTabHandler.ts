import type { GameEngine } from 'engine/GameEngine.js';
import type { GameRuntimeController } from 'engine/GameRuntimeController.js';
import { GameState } from 'engine/GameStateManager.js';
import { isCreatorMode } from 'engine/CreatorMode.js';

/**
 * Handles the SET_EDITOR_TAB message: updates current editor tab and
 * configures camera mode, player controls, and UI visibility accordingly.
 */
export function handleSetEditorTab(
    gameEngine: GameEngine,
    runtimeController: GameRuntimeController,
    getStateManager: () => import('engine/GameStateManager.js').GameStateManager,
    data: { tab?: string | null },
    safePostMessage: (msg: any) => void
): void {
    // Suppress unused parameter warning — reserved for future response messages
    void safePostMessage;

    const tab = data?.tab || null;
    console.log(`[editor] SET_EDITOR_TAB received: ${tab || 'null (standalone mode)'}`);
    runtimeController.setCurrentTab(tab);

    const playerController = gameEngine.getPlayerController();
    if (!playerController) {
        console.log('[editor] No player controller - deferring SET_EDITOR_TAB until game is loaded');
        return;
    }

    const pcAny = playerController as any;

    // Update attack system
    if (typeof pcAny.getAttackSystem === 'function') {
        const attackSystem = pcAny.getAttackSystem();
        if (attackSystem && typeof attackSystem.setEditorTab === 'function') {
            attackSystem.setEditorTab(tab);
            console.log(`[editor] Attack system tab set to: ${tab || 'null'}`);
        }
    }

    if (!gameEngine.editorManager) {
        console.warn('[editor] editorManager not available - cannot set camera mode');
        return;
    }

    const { editorManager } = gameEngine;

    if (!runtimeController.canSwitchToEditorTab(tab)) {
        return;
    }

    const cameraController = ('getCameraController' in playerController)
        ? pcAny.getCameraController()
        : null;

    const isEditorTab = tab !== null && tab !== 'prompt';
    const menuUI = runtimeController.getStartScreen();
    const pointerLockManager = runtimeController.getPointerLockManager();
    const isGamePlaying = getStateManager().getCurrentState() === GameState.PLAYING;

    // --- Hide ALL game UI on non-prompt (editor) tabs ---

    // Helper to toggle overlay visibility with state preservation
    const toggleOverlay = (el: HTMLElement | null) => {
        if (!el) return;
        if (isEditorTab) {
            el.dataset.preEditorDisplay = el.style.display;
            el.style.display = 'none';
        } else if (el.dataset.preEditorDisplay !== undefined) {
            el.style.display = el.dataset.preEditorDisplay;
            delete el.dataset.preEditorDisplay;
        }
    };

    toggleOverlay(document.querySelector('[data-network-lobby]') as HTMLElement | null);
    toggleOverlay(document.getElementById('matchmaking-overlay'));
    toggleOverlay(document.getElementById('pointer-lock-overlay'));

    // Menu UI
    if (menuUI && isEditorTab) {
        menuUI.hide();
    }

    // HUD
    const hud = gameEngine.genreModule?.hud;
    if (hud) {
        if (isEditorTab) {
            hud.hide();
            hud.setGameplayUIVisible(false);
        } else {
            hud.show();
        }
    }

    // HUD anchor containers
    const anchorNames = [
        'top-left', 'top-center', 'top-right',
        'middle-left', 'middle-center', 'middle-right',
        'bottom-left', 'bottom-center', 'bottom-right'
    ];
    for (const anchor of anchorNames) {
        const el = document.getElementById(`hud-anchor-${anchor}`);
        if (el) {
            el.style.display = isEditorTab ? 'none' : 'flex';
        }
    }

    // Pointer lock overlay
    if (pointerLockManager && isEditorTab) {
        pointerLockManager.hideOverlay();
    }

    runtimeController.applyEditorTabMode(tab);

    // --- Configure camera and controls per tab ---

    if (tab === 'prompt') {
        console.log(`[editor] Prompt tab: Setting camera mode to GAME (third-person)`);
        editorManager.disableFreeCamera();

        if (pointerLockManager) {
            if (!isCreatorMode) {
                pointerLockManager.setEditorMode(false);
            }
        }
        if (cameraController && typeof cameraController.setEditorModeCamera === 'function') {
            cameraController.setEditorModeCamera(false);
        }

        // Show menu/play button on Prompt tab (if game not started)
        if (menuUI && !isGamePlaying) {
            menuUI.show();
            menuUI.hideLoadingIndicator();
        }

        // Only enable player controls if game is in PLAYING state
        if ('setControlsEnabled' in playerController) {
            pcAny.setControlsEnabled(isGamePlaying);
            console.log(isGamePlaying
                ? `[editor] Player controls enabled (Prompt tab, game is playing)`
                : `[editor] Player controls disabled (Prompt tab, waiting for Play button)`);
        }
    } else if (tab) {
        console.log(`[editor] ${tab} tab: Setting camera mode to EDITOR (free camera)`);
    }
    // If tab is null (standalone mode), don't change camera or controls
}
