import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import { ThirdPersonCamera } from 'engine/ThirdPersonCamera.js';

/** Minimal adapter also supported by custom game cameras. */
export interface SpectatorGameplayCamera {
    enabled: boolean;
    setEnabled(enabled: boolean): void;
}

/** Owns a separate perspective camera; the walking camera keeps its target and lens. */
export class SpectatorCamera {
    private readonly original: THREE.PerspectiveCamera | THREE.OrthographicCamera;
    private readonly wasEnabled: boolean;
    private readonly camera: THREE.PerspectiveCamera;
    private controller: ThirdPersonCamera | null = null;
    private inputEnabled = true;

    constructor(
        private readonly engine: EngineLike,
        private readonly gameplayCamera: SpectatorGameplayCamera,
        private readonly distanceInHeights: number,
    ) {
        this.original = engine.camera ?? engine.getDefaultCamera();
        this.wasEnabled = gameplayCamera.enabled;
        const source = this.original instanceof THREE.PerspectiveCamera ? this.original : engine.getDefaultCamera();
        this.camera = new THREE.PerspectiveCamera(source.fov, source.aspect, source.near, source.far);
        this.camera.position.copy(this.original.position);
        this.camera.quaternion.copy(this.original.quaternion);
        this.camera.up.copy(this.original.up);
        gameplayCamera.setEnabled(false);
        // Preserve the death view, including an orthographic projection, until a target exists.
        engine.setRenderCamera(this.original);
    }

    follow(target: THREE.Object3D, height: number): void {
        const element = this.engine.renderer?.domElement ?? this.engine.container;
        if (!this.controller) this.controller = new ThirdPersonCamera(this.camera, target, element, this.engine);
        const controller = this.controller;
        controller.setTarget(target);
        controller.minDistance = height * 0.8;
        controller.maxDistance = height * 8;
        controller.lookAtHeight = height * 0.65;
        controller.driveOrbit(controller.getHorizontalAngle(), Math.PI / 2.6, height * this.distanceInHeights, true);
        controller.resetFollow();
        controller.setEnabled(this.inputEnabled);
        this.engine.setRenderCamera(this.camera);
        controller.update(0);
    }

    /** Hold the last shot when no eligible player is alive. */
    hold(): void {
        this.controller?.setEnabled(false);
    }

    setInputEnabled(enabled: boolean, following: boolean): void {
        this.inputEnabled = enabled;
        this.controller?.setEnabled(enabled && following);
    }

    update(deltaTime: number, following: boolean): void {
        if (!following || !this.controller) return;
        if (this.gameplayCamera.enabled) {
            this.gameplayCamera.setEnabled(false);
            this.engine.setRenderCamera(this.camera);
        }
        this.controller.setPointerLocked(document.pointerLockElement !== null &&
            this.engine.container.contains(document.pointerLockElement));
        this.controller.update(deltaTime);
    }

    orbit(x: number, y: number): void { this.controller?.applyExternalDelta(x, y); }

    dispose(): void {
        this.controller?.dispose();
        this.controller = null;
        this.gameplayCamera.setEnabled(this.wasEnabled);
        this.engine.setRenderCamera(this.original);
    }
}
