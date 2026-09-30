import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import type { ICameraController, CameraMode } from 'engine/ICameraController.js';
import { ThirdPersonCamera } from 'engine/ThirdPersonCamera.js';
import { FirstPersonCamera } from 'engine/FirstPersonCamera.js';
import { TopDownCamera } from 'engine/TopDownCamera.js';

export class CameraManager {
    private camera: THREE.PerspectiveCamera;
    private target: THREE.Object3D;
    private domElement: HTMLElement;
    private engine: EngineLike;
    
    private thirdPersonCamera: ThirdPersonCamera | null = null;
    private firstPersonCamera: FirstPersonCamera | null = null;
    private topDownCamera: TopDownCamera | null = null;
    
    private currentMode: CameraMode = 'third-person';
    private activeController: ICameraController | null = null;
    
    private onModeChangeCallbacks: Array<(mode: CameraMode) => void> = [];
    
    private eyeHeightRatio: number = 0.85;
    
    constructor(
        camera: THREE.PerspectiveCamera | THREE.OrthographicCamera | null,
        target: THREE.Object3D,
        domElement: HTMLElement,
        engine: EngineLike,
        initialMode: CameraMode = 'third-person'
    ) {
        // Backward compat: games created before the orthographic top-down camera
        // landed construct this with `engine.camera`, which has since been widened
        // to `PerspectiveCamera | OrthographicCamera | null`. Accept that full type
        // so those games still type-check when reopened against the current engine.
        // The controllers require the perspective camera, and at construction
        // `engine.camera` is always the perspective default (the orthographic camera
        // is only swapped in later for top-down fit-world mode), so resolve to the
        // perspective camera for anything that isn't already one.
        this.camera = camera instanceof THREE.PerspectiveCamera ? camera : engine.getDefaultCamera();
        this.target = target;
        this.domElement = domElement;
        this.engine = engine;
        
        this.setMode(initialMode);
    }
    
    private getCharacterHeight(): number {
        const playerLoader = this.engine.getPlayerLoader?.();
        if (playerLoader) {
            return playerLoader.getCapsuleHeight();
        }
        return 1.75;
    }
    
    private setCharacterVisible(visible: boolean): void {
        // First-person mode contributes through two channels on
        // PlayerVisibility, so the right thing happens whether the player has
        // a block character or just a skeleton/headless capsule:
        //
        //   1. Root hide reason — covers the headless/skeleton-only path
        //      where the block root doesn't exist.
        //   2. Body-part selector ('all') — covers the block-character path.
        //      Templates that want hands-only first-person override this
        //      reason with a specific part list (see PlayerVisibility docs)
        //      and also clear the root hide via setHideReason(..., false).
        const playerVis = this.engine.getPlayerVisibility();
        playerVis.setHideReason('first-person-mode', !visible);
        playerVis.setHiddenBodyParts('first-person-mode', visible ? null : 'all');
    }
    
    setMode(mode: CameraMode): void {
        if (this.currentMode === mode && this.activeController) {
            return;
        }
        
        // Capture current look direction before switching
        const previousHorizontalAngle = this.activeController?.getHorizontalAngle() ?? 0;
        const previousVerticalAngle = this.activeController?.getVerticalAngle() ?? Math.PI / 2;
        
        if (this.activeController) {
            this.activeController.setEnabled(false);
        }
        
        this.currentMode = mode;
        
        if (mode === 'third-person') {
            if (!this.thirdPersonCamera) {
                this.thirdPersonCamera = new ThirdPersonCamera(
                    this.camera,
                    this.target,
                    this.domElement,
                    this.engine
                );
            }
            // Sync look direction from previous camera
            this.thirdPersonCamera.setHorizontalAngle(previousHorizontalAngle);
            this.thirdPersonCamera.setTarget(this.target);
            this.thirdPersonCamera.setEnabled(true);
            this.activeController = this.thirdPersonCamera as unknown as ICameraController;
            this.setCharacterVisible(true);
        } else if (mode === 'first-person') {
            if (!this.firstPersonCamera) {
                this.firstPersonCamera = new FirstPersonCamera(
                    this.camera,
                    this.target,
                    this.domElement,
                    this.engine
                );
            }
            const eyeHeight = this.getCharacterHeight() * this.eyeHeightRatio;
            this.firstPersonCamera.setEyeHeight(eyeHeight);
            // Sync look direction from previous camera
            this.firstPersonCamera.setHorizontalAngle(previousHorizontalAngle);
            this.firstPersonCamera.setTarget(this.target);
            this.firstPersonCamera.setEnabled(true);
            this.activeController = this.firstPersonCamera;
            this.setCharacterVisible(false);
        } else if (mode === 'top-down') {
            if (!this.topDownCamera) {
                this.topDownCamera = new TopDownCamera(
                    this.camera,
                    this.target,
                    this.domElement,
                    this.engine
                );
            }
            // Sync look direction from previous camera
            this.topDownCamera.setHorizontalAngle(previousHorizontalAngle);
            this.topDownCamera.setTarget(this.target);
            this.topDownCamera.setEnabled(true);
            this.activeController = this.topDownCamera;
            this.setCharacterVisible(true);
        }
        
        // Automatically update PlayerController's camera reference
        const playerController = this.engine.getPlayerController?.();
        if (playerController?.setCameraController && this.activeController) {
            playerController.setCameraController(this.activeController as any);
        }
        
        for (const callback of this.onModeChangeCallbacks) {
            callback(mode);
        }
        
        console.log(`📷 Camera mode changed to: ${mode}`);
    }
    
    getMode(): CameraMode {
        return this.currentMode;
    }
    
    getActiveController(): ICameraController | null {
        return this.activeController;
    }
    
    getThirdPersonCamera(): ThirdPersonCamera {
        if (!this.thirdPersonCamera) {
            this.thirdPersonCamera = new ThirdPersonCamera(
                this.camera,
                this.target,
                this.domElement,
                this.engine
            );
        }
        return this.thirdPersonCamera;
    }
    
    getFirstPersonCamera(): FirstPersonCamera {
        if (!this.firstPersonCamera) {
            this.firstPersonCamera = new FirstPersonCamera(
                this.camera,
                this.target,
                this.domElement,
                this.engine
            );
        }
        return this.firstPersonCamera;
    }
    
    getTopDownCamera(): TopDownCamera {
        if (!this.topDownCamera) {
            this.topDownCamera = new TopDownCamera(
                this.camera,
                this.target,
                this.domElement,
                this.engine
            );
        }
        return this.topDownCamera;
    }
    
    setTarget(target: THREE.Object3D): void {
        this.target = target;
        if (this.thirdPersonCamera) {
            this.thirdPersonCamera.setTarget(target);
        }
        if (this.firstPersonCamera) {
            this.firstPersonCamera.setTarget(target);
        }
        if (this.topDownCamera) {
            this.topDownCamera.setTarget(target);
        }
    }
    
    update(deltaTime: number): void {
        if (this.activeController) {
            this.activeController.update(deltaTime);
        }
    }
    
    setPointerLocked(locked: boolean): void {
        if (this.activeController) {
            this.activeController.setPointerLocked(locked);
        }
    }
    
    setEditorModeCamera(enabled: boolean): void {
        if (this.activeController) {
            this.activeController.setEditorModeCamera(enabled);
        }
    }
    
    onModeChange(callback: (mode: CameraMode) => void): void {
        this.onModeChangeCallbacks.push(callback);
    }
    
    offModeChange(callback: (mode: CameraMode) => void): void {
        const index = this.onModeChangeCallbacks.indexOf(callback);
        if (index !== -1) {
            this.onModeChangeCallbacks.splice(index, 1);
        }
    }
    
    dispose(): void {
        if (this.currentMode === 'first-person') {
            this.setCharacterVisible(true);
        }
        if (this.thirdPersonCamera) {
            this.thirdPersonCamera.dispose();
            this.thirdPersonCamera = null;
        }
        if (this.firstPersonCamera) {
            this.firstPersonCamera.dispose();
            this.firstPersonCamera = null;
        }
        if (this.topDownCamera) {
            this.topDownCamera.dispose();
            this.topDownCamera = null;
        }
        this.activeController = null;
        this.onModeChangeCallbacks = [];
    }
}
