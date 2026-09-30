// Type checking enabled
import * as THREE from 'three';
import { DebugCameraController } from './DebugCameraController.js';
import type { CameraControllerLike } from 'types/game.js';

// Player controller with optional control methods (duck-typed at runtime)
interface PlayerWithControls {
    setControlsEnabled?(enabled: boolean): void;
    setEnabled?(enabled: boolean): void;
    getCameraController?(): CameraControllerLike | null;
}

// Saved camera state for restoring after debug mode
interface SavedCameraState {
    position: THREE.Vector3;
    rotation: THREE.Euler;
    quaternion: THREE.Quaternion;
}

// Engine interface for camera management
interface CameraManagerEngine {
    camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
    getDefaultCamera(): THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer & { domElement: HTMLCanvasElement };
    genreModule: {
        cameraController?: CameraControllerLike;
    } | null;
}

/**
 * Manages debug camera functionality including free camera mode
 */
export class DebugCameraManager {
    private engine: CameraManagerEngine;
    private getPlayerController: () => unknown;

    // Camera state
    private debugCamera: DebugCameraController | null = null;
    private originalCameraController: CameraControllerLike | null = null;
    private savedCameraState: SavedCameraState | null = null;

    // Free camera mode (for Splats tab - camera controls without debug UI)
    private freeCameraEnabled: boolean = false;
    private boundOnFreeCameraMouseDown: ((event: MouseEvent) => void) | null = null;
    private boundOnFreeCameraMouseMove: ((event: MouseEvent) => void) | null = null;
    private boundOnFreeCameraMouseUp: ((event: MouseEvent) => void) | null = null;
    
    // Track player's camera controller (e.g., VehicleCamera) that was disabled
    private playerCameraController: CameraControllerLike | null = null;

    constructor(
        engine: CameraManagerEngine,
        getPlayerController: () => unknown
    ) {
        this.engine = engine;
        this.getPlayerController = getPlayerController;
    }

    /**
     * Get the debug camera controller
     */
    getDebugCamera(): DebugCameraController | null {
        return this.debugCamera;
    }

    /**
     * Check if free camera mode is enabled
     */
    isFreeCameraEnabled(): boolean {
        return this.freeCameraEnabled;
    }

    /**
     * Save current camera state
     */
    saveCameraState(): void {
        // Try to get the current camera controller from the game
        if (this.engine.genreModule && this.engine.genreModule.cameraController) {
            this.originalCameraController = this.engine.genreModule.cameraController;
            this.savedCameraState = {
                position: this.engine.camera.position.clone(),
                rotation: this.engine.camera.rotation.clone(),
                quaternion: this.engine.camera.quaternion.clone()
            };
        }
    }

    /**
     * Switch to debug camera
     */
    switchToDebugCamera(): void {
        if (!this.debugCamera) {
            this.debugCamera = new DebugCameraController(this.engine.getDefaultCamera(), this.engine.renderer.domElement);
        }

        // Activate debug camera with current camera state
        this.debugCamera.activate(this.engine.getDefaultCamera());

        // Disable original camera controller if it exists
        if (this.originalCameraController && this.originalCameraController.setEnabled) {
            this.originalCameraController.setEnabled(false);
        }
    }

    /**
     * Hand the camera over to something else for a while (the object voxel
     * edit session's orbit controls).
     *
     * `setEnabled(false)` is not enough: the controller's mousedown/mousemove/
     * wheel listeners sit on the same canvas as the borrowing controls, and
     * several of them only check `isActive`. Left attached, every orbit drag
     * was immediately overwritten by the debug camera's own yaw/pitch and the
     * wheel never reached the orbit zoom. Detaching is the only clean split.
     *
     * Returns whether a resume is owed, so callers can restore exactly what
     * they suspended.
     */
    suspendDebugCamera(): boolean {
        if (!this.debugCamera?.isActive) return false;
        this.debugCamera.deactivate();
        return true;
    }

    /** Re-attach after `suspendDebugCamera`, adopting wherever the camera ended up. */
    resumeDebugCamera(): void {
        this.debugCamera?.activate(this.engine.getDefaultCamera());
    }

    /**
     * Switch back to original camera
     */
    switchToOriginalCamera(): void {
        if (this.debugCamera) {
            this.debugCamera.deactivate();
        }

        // Restore camera state
        if (this.savedCameraState) {
            this.engine.camera.position.copy(this.savedCameraState.position);
            this.engine.camera.rotation.copy(this.savedCameraState.rotation);
            this.engine.camera.quaternion.copy(this.savedCameraState.quaternion);
        }

        // Re-enable original camera controller
        if (this.originalCameraController && this.originalCameraController.setEnabled) {
            this.originalCameraController.setEnabled(true);
        }
    }

    /**
     * Handle mouse down for free camera mode
     */
    private onFreeCameraMouseDown(event: MouseEvent): void {
        if (!this.freeCameraEnabled || !this.debugCamera || !this.debugCamera.isActive) return;
        this.debugCamera.onMouseDown(event);
    }

    /**
     * Handle mouse move for free camera mode
     */
    private onFreeCameraMouseMove(event: MouseEvent): void {
        if (!this.freeCameraEnabled || !this.debugCamera || !this.debugCamera.isActive) return;
        this.debugCamera.onMouseMove(event);
    }

    /**
     * Handle mouse up for free camera mode
     */
    private onFreeCameraMouseUp(event: MouseEvent): void {
        if (!this.freeCameraEnabled || !this.debugCamera || !this.debugCamera.isActive) return;
        this.debugCamera.onMouseUp(event);
    }

    /**
     * Setup free camera mouse listeners
     */
    private setupFreeCameraMouseListeners(): void {
        if (!this.engine.renderer) return;

        // Bind handlers and store references for removal
        this.boundOnFreeCameraMouseDown = this.onFreeCameraMouseDown.bind(this);
        this.boundOnFreeCameraMouseMove = this.onFreeCameraMouseMove.bind(this);
        this.boundOnFreeCameraMouseUp = this.onFreeCameraMouseUp.bind(this);

        this.engine.renderer.domElement.addEventListener('mousedown', this.boundOnFreeCameraMouseDown);
        this.engine.renderer.domElement.addEventListener('mousemove', this.boundOnFreeCameraMouseMove);
        this.engine.renderer.domElement.addEventListener('mouseup', this.boundOnFreeCameraMouseUp);
    }

    /**
     * Remove free camera mouse listeners
     */
    private removeFreeCameraMouseListeners(): void {
        if (!this.engine.renderer) return;

        if (this.boundOnFreeCameraMouseDown) {
            this.engine.renderer.domElement.removeEventListener('mousedown', this.boundOnFreeCameraMouseDown);
        }
        if (this.boundOnFreeCameraMouseMove) {
            this.engine.renderer.domElement.removeEventListener('mousemove', this.boundOnFreeCameraMouseMove);
        }
        if (this.boundOnFreeCameraMouseUp) {
            this.engine.renderer.domElement.removeEventListener('mouseup', this.boundOnFreeCameraMouseUp);
        }

        this.boundOnFreeCameraMouseDown = null;
        this.boundOnFreeCameraMouseMove = null;
        this.boundOnFreeCameraMouseUp = null;
    }

    /**
     * Enable or disable player controls, duck-typing whichever toggle method
     * the player controller exposes. Shared by the public enable/disable wrappers.
     */
    private setPlayerControls(enabled: boolean): void {
        const verb = enabled ? 'enabled' : 'disabled';
        const action = enabled ? 'enable' : 'disable';
        const rawController = this.getPlayerController();
        if (!rawController) {
            console.log(`[editor] No player controller - skipping control ${action}`);
            return;
        }
        const playerController = rawController as PlayerWithControls;
        if (typeof playerController.setControlsEnabled === 'function') {
            playerController.setControlsEnabled(enabled);
            console.log(`[editor] Player controls ${verb} via setControlsEnabled(${enabled})`);
        } else if (typeof playerController.setEnabled === 'function') {
            playerController.setEnabled(enabled);
            console.log(`[editor] Player controls ${verb} via setEnabled(${enabled})`);
        } else {
            console.warn(`[editor] Player controller found but no ${action} method available`);
        }
    }

    /**
     * Disable player controls (public for use by EditorManager)
     */
    disablePlayerControls(): void {
        this.setPlayerControls(false);
    }

    /**
     * Restore player controls (public for use by EditorManager)
     */
    restorePlayerControls(): void {
        this.setPlayerControls(true);
    }

    /**
     * Disable the player's current camera controller (e.g., VehicleCamera when driving)
     * This prevents it from interfering with the debug camera
     */
    private disablePlayerCameraController(): void {
        const rawController = this.getPlayerController();
        if (rawController) {
            const playerController = rawController as PlayerWithControls;
            if (typeof playerController.getCameraController === 'function') {
                const cameraController = playerController.getCameraController();
                if (cameraController && cameraController !== this.originalCameraController) {
                    // This is a different camera (e.g., VehicleCamera)
                    this.playerCameraController = cameraController;
                    if (typeof cameraController.setEnabled === 'function') {
                        cameraController.setEnabled(false);
                        console.log('[editor] Player camera controller disabled (was driving)');
                    }
                }
            }
        }
    }

    /**
     * Restore the player's camera controller that was disabled
     */
    private restorePlayerCameraController(): void {
        if (this.playerCameraController && typeof this.playerCameraController.setEnabled === 'function') {
            this.playerCameraController.setEnabled(true);
            console.log('[editor] Player camera controller restored');
        }
        this.playerCameraController = null;
    }

    /**
     * Enable free camera controls without debug UI (for Splats tab)
     */
    enableFreeCamera(): void {
        if (this.freeCameraEnabled) {
            console.log('[editor] Free camera already enabled, skipping');
            return;
        }

        console.log('[editor] Enabling free camera (editor mode)');
        this.freeCameraEnabled = true;

        // Save current camera state
        this.saveCameraState();

        // Disable player controls (WASD should control camera, not player)
        console.log('[editor] Disabling player controls - WASD will control camera');
        this.disablePlayerControls();
        
        // Also disable the player's current camera controller (e.g., VehicleCamera if driving)
        this.disablePlayerCameraController();

        // Use the same camera switching logic as debug mode (ensures correct initialization)
        this.switchToDebugCamera();

        // Setup mouse listeners for camera rotation
        this.setupFreeCameraMouseListeners();

        // Focus window and renderer for keyboard input
        window.focus();
        if (this.engine.renderer && this.engine.renderer.domElement) {
            this.engine.renderer.domElement.focus();
        }

        console.log('[editor] Free camera enabled - camera mode: EDITOR, controls: EDITOR');
    }

    /**
     * Disable free camera controls
     */
    disableFreeCamera(): void {
        if (!this.freeCameraEnabled) {
            console.log('[editor] Free camera already disabled, skipping');
            return;
        }

        console.log('[editor] Disabling free camera (switching to game mode)');
        this.freeCameraEnabled = false;

        // Remove mouse listeners
        this.removeFreeCameraMouseListeners();

        if (this.debugCamera) {
            this.debugCamera.deactivate();
        }

        // Switch back to original camera (third-person camera that follows player)
        this.switchToOriginalCamera();

        // Restore player controls (WASD controls player, camera follows)
        console.log('[editor] Enabling player controls - WASD will control player');
        this.restorePlayerControls();
        
        // Restore player's camera controller (e.g., VehicleCamera if was driving)
        this.restorePlayerCameraController();

        console.log('[editor] Free camera disabled - camera mode: GAME, controls: PLAYER');
    }

    /**
     * Re-sync the debug camera with the current camera position
     * Used after voxel object edit mode exits to restore WASD controls
     */
    reSyncDebugCamera(): void {
        if (!this.debugCamera || !this.freeCameraEnabled) {
            console.log('[editor] reSyncDebugCamera: skipping - debugCamera or freeCameraEnabled not set');
            return;
        }

        console.log('[editor] Re-syncing debug camera with current camera position');
        
        // Re-activate the debug camera with the current camera state
        // This will re-add the keyboard listeners and update the internal position/rotation state
        this.debugCamera.activate(this.engine.getDefaultCamera());
        
        // Focus the renderer for keyboard input
        window.focus();
        if (this.engine.renderer && this.engine.renderer.domElement) {
            this.engine.renderer.domElement.focus();
        }
        
        console.log('[editor] Debug camera re-synced - WASD controls should work');
    }

    /**
     * Update the camera manager (called each frame)
     */
    update(deltaTime: number, isDebugMode: boolean): void {
        // Update debug camera if in debug mode OR free camera mode
        if ((isDebugMode || this.freeCameraEnabled) && this.debugCamera) {
            this.debugCamera.update(deltaTime);
        }
    }

    /**
     * Dispose of the camera manager
     */
    dispose(): void {
        this.removeFreeCameraMouseListeners();

        if (this.debugCamera) {
            this.debugCamera.dispose();
            this.debugCamera = null;
        }
    }
}
