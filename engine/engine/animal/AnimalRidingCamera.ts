import * as THREE from 'three';
import type { CameraController } from 'engine/PlayerController.js';
import type { EngineLike } from 'types/game.js';

/**
 * Camera controller for when the player is riding an animal.
 * Works like ThirdPersonCamera - supports pointer lock and click-and-drag.
 */
export class AnimalRidingCamera implements CameraController {
    private camera: THREE.PerspectiveCamera;
    private target: THREE.Object3D;
    private domElement: HTMLElement;
    private engine: EngineLike | null;

    private distance: number = 6;
    private minDistance: number = 3;
    private maxDistance: number = 12;
    private height: number = 2.5;
    private lookAtHeight: number = 1.2;
    
    private smoothness: number = 0.1;
    private rotationSpeed: number = 0.006;
    
    // Spherical coordinates for camera orbit
    private spherical: THREE.Spherical;
    private targetSpherical: THREE.Spherical;
    
    private offset: THREE.Vector3 = new THREE.Vector3();
    private lookAtPosition: THREE.Vector3 = new THREE.Vector3();
    
    private enabled: boolean = true;
    private isMouseDown: boolean = false;
    private mouseX: number = 0;
    private mouseY: number = 0;
    
    // Pointer lock state (read from document, not managed by this camera)
    private get pointerLocked(): boolean {
        return document.pointerLockElement !== null;
    }
    
    // Bound event handlers
    private boundOnMouseDown: (event: MouseEvent) => void;
    private boundOnMouseUp: (event: MouseEvent) => void;
    private boundOnMouseMove: (event: MouseEvent) => void;
    private boundOnDocumentMouseMove: (event: MouseEvent) => void;
    private boundOnWheel: (event: WheelEvent) => void;
    private boundOnContextMenu: (event: Event) => void;

    constructor(camera: THREE.PerspectiveCamera, target: THREE.Object3D, domElement: HTMLElement, engine: EngineLike | null = null) {
        this.camera = camera;
        this.target = target;
        this.domElement = domElement;
        this.engine = engine;
        
        // Initialize spherical coordinates (behind the target)
        this.spherical = new THREE.Spherical(this.distance, Math.PI / 2.3, 0);
        this.targetSpherical = new THREE.Spherical(this.distance, Math.PI / 2.3, 0);
        
        // Bind event handlers
        this.boundOnMouseDown = this.onMouseDown.bind(this);
        this.boundOnMouseUp = this.onMouseUp.bind(this);
        this.boundOnMouseMove = this.onMouseMove.bind(this);
        this.boundOnDocumentMouseMove = this.onDocumentMouseMove.bind(this);
        this.boundOnWheel = this.onWheel.bind(this);
        this.boundOnContextMenu = (e: Event) => e.preventDefault();
        
        this.setupEventListeners();
        this.initializeCameraPosition();
    }

    private setupEventListeners(): void {
        this.domElement.addEventListener('mousedown', this.boundOnMouseDown);
        this.domElement.addEventListener('mouseup', this.boundOnMouseUp);
        this.domElement.addEventListener('mousemove', this.boundOnMouseMove);
        this.domElement.addEventListener('wheel', this.boundOnWheel);
        this.domElement.addEventListener('contextmenu', this.boundOnContextMenu);
        
        // Listen on document for pointer lock mouse events
        document.addEventListener('mousemove', this.boundOnDocumentMouseMove);
    }

    private initializeCameraPosition(): void {
        // Get initial position behind the target
        const targetPos = new THREE.Vector3();
        this.target.getWorldPosition(targetPos);
        
        // Set initial spherical to be behind the animal
        const direction = new THREE.Vector3();
        this.target.getWorldDirection(direction);
        this.targetSpherical.theta = Math.atan2(direction.x, direction.z) + Math.PI;
        this.spherical.theta = this.targetSpherical.theta;
        
        this.updateCameraPosition();
    }
    
    private shouldProcessInput(): boolean {
        // If pointer lock is active, always allow input
        if (this.pointerLocked) return true;
        
        // Check engine focus state
        if (this.engine && !this.engine.isWindowFocused) return false;
        if (this.engine && this.engine.editorManager && this.engine.editorManager.isEditorMode) return false;
        
        return true;
    }

    private onMouseDown(event: MouseEvent): void {
        if (!this.enabled) return;
        if (!this.shouldProcessInput()) return;
        
        // In pointer lock mode, mouse down is not needed for camera rotation
        if (this.pointerLocked) return;
        
        if (event.button === 0) {
            this.isMouseDown = true;
            this.mouseX = event.clientX;
            this.mouseY = event.clientY;
            (this.domElement as HTMLElement).style.cursor = 'grabbing';
        }
    }

    private onMouseUp(event: MouseEvent): void {
        // In pointer lock mode, mouse up is not relevant
        if (this.pointerLocked) return;
        
        if (event.button === 0) {
            this.isMouseDown = false;
            (this.domElement as HTMLElement).style.cursor = 'grab';
        }
    }

    private onMouseMove(event: MouseEvent): void {
        if (!this.enabled) return;
        if (!this.shouldProcessInput()) return;
        
        // Pointer lock mode is handled by onDocumentMouseMove
        if (this.pointerLocked) return;
        
        // Fallback: click-and-drag mode
        if (!this.isMouseDown) return;
        
        const deltaX = event.clientX - this.mouseX;
        const deltaY = event.clientY - this.mouseY;
        
        this.targetSpherical.theta -= deltaX * this.rotationSpeed;
        this.targetSpherical.phi -= deltaY * this.rotationSpeed;
        this.targetSpherical.phi = Math.max(0.1, Math.min(Math.PI - 0.1, this.targetSpherical.phi));
        
        this.mouseX = event.clientX;
        this.mouseY = event.clientY;
    }

    private onDocumentMouseMove(event: MouseEvent): void {
        // Only process in pointer lock mode
        if (!this.pointerLocked) return;
        if (!this.enabled) return;
        if (!this.shouldProcessInput()) return;
        
        const deltaX = event.movementX || 0;
        const deltaY = event.movementY || 0;
        
        this.targetSpherical.theta -= deltaX * this.rotationSpeed;
        this.targetSpherical.phi -= deltaY * this.rotationSpeed;
        this.targetSpherical.phi = Math.max(0.1, Math.min(Math.PI - 0.1, this.targetSpherical.phi));
    }

    private onWheel(event: WheelEvent): void {
        if (!this.enabled) return;
        if (!this.shouldProcessInput()) return;
        
        event.preventDefault();
        const delta = event.deltaY * 0.001;
        this.targetSpherical.radius = Math.max(
            this.minDistance,
            Math.min(this.maxDistance, this.targetSpherical.radius + delta)
        );
    }

    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
        if (!enabled) {
            this.isMouseDown = false;
        }
    }

    update(deltaTime: number): void {
        if (!this.enabled || !this.target) return;

        // Smooth interpolation of spherical coordinates
        const smoothFactor = 1 - Math.exp(-this.smoothness * 60 * deltaTime);
        this.spherical.theta += (this.targetSpherical.theta - this.spherical.theta) * smoothFactor;
        this.spherical.phi += (this.targetSpherical.phi - this.spherical.phi) * smoothFactor;
        this.spherical.radius += (this.targetSpherical.radius - this.spherical.radius) * smoothFactor;

        this.updateCameraPosition();
        this.updateLookAt();
    }

    private updateCameraPosition(): void {
        const targetPos = new THREE.Vector3();
        this.target.getWorldPosition(targetPos);
        targetPos.y += this.lookAtHeight;

        // Convert spherical to Cartesian for camera position
        this.offset.setFromSpherical(this.spherical);
        this.camera.position.copy(targetPos).add(this.offset);
    }

    private updateLookAt(): void {
        const targetPos = new THREE.Vector3();
        this.target.getWorldPosition(targetPos);
        
        this.lookAtPosition.copy(targetPos);
        this.lookAtPosition.y += this.lookAtHeight;
        
        this.camera.lookAt(this.lookAtPosition);
    }

    setTarget(newTarget: THREE.Object3D): void {
        this.target = newTarget;
        this.initializeCameraPosition();
    }

    getTarget(): THREE.Object3D {
        return this.target;
    }

    setCameraSettings(distance?: number, height?: number): void {
        if (distance !== undefined) {
            this.distance = distance;
            this.targetSpherical.radius = distance;
        }
        if (height !== undefined) this.height = height;
    }

    getForwardVector(): THREE.Vector3 {
        // Get the camera's forward direction projected onto the XZ plane
        const forward = new THREE.Vector3();
        this.camera.getWorldDirection(forward);
        forward.y = 0;
        forward.normalize();
        return forward;
    }

    getRightVector(): THREE.Vector3 {
        const forward = this.getForwardVector();
        const right = new THREE.Vector3();
        right.crossVectors(forward, new THREE.Vector3(0, 1, 0));
        right.normalize();
        return right;
    }

    getCamera(): THREE.PerspectiveCamera {
        return this.camera;
    }
    
    getHorizontalAngle(): number {
        return this.spherical.theta;
    }

    dispose(): void {
        this.domElement.removeEventListener('mousedown', this.boundOnMouseDown);
        this.domElement.removeEventListener('mouseup', this.boundOnMouseUp);
        this.domElement.removeEventListener('mousemove', this.boundOnMouseMove);
        this.domElement.removeEventListener('wheel', this.boundOnWheel);
        this.domElement.removeEventListener('contextmenu', this.boundOnContextMenu);
        document.removeEventListener('mousemove', this.boundOnDocumentMouseMove);
    }
}
