import * as THREE from 'three';

/**
 * Camera controller interface that both FirstPersonCamera and ThirdPersonCamera implement.
 * This allows easy switching between camera modes in templates.
 */
export interface ICameraController {
    /** The Three.js camera instance */
    camera: THREE.PerspectiveCamera;
    
    /** The target object the camera follows */
    target: THREE.Object3D;
    
    /** Whether the camera controller is enabled */
    enabled: boolean;
    
    /** Update the camera position/rotation - call every frame */
    update(deltaTime: number): void;
    
    /** Get the camera's forward direction (Y=0, normalized) for movement */
    getForwardVector(): THREE.Vector3;
    
    /** Get the camera's right direction (Y=0, normalized) for movement */
    getRightVector(): THREE.Vector3;
    
    /** Get the Three.js camera instance */
    getCamera(): THREE.PerspectiveCamera;
    
    /** Set the target object to follow */
    setTarget(target: THREE.Object3D): void;
    
    /** Enable or disable the camera controller */
    setEnabled(enabled: boolean): void;
    
    /** Set pointer lock mode (for PC gameplay) */
    setPointerLocked(locked: boolean): void;
    
    /** Get whether pointer lock is active */
    getPointerLocked(): boolean;
    
    /** Set editor mode (click-and-drag instead of pointer lock) */
    setEditorModeCamera(enabled: boolean): void;
    
    /** Apply external camera delta (e.g., from mobile controls) */
    applyExternalDelta(deltaX: number, deltaY: number): void;
    
    /** Get the horizontal angle (yaw) in radians */
    getHorizontalAngle(): number;
    
    /** Get the vertical angle (pitch) in radians */
    getVerticalAngle(): number;
    
    /** Get pitch angle relative to horizontal */
    getPitchAngle(): number;

    /** The camera mode this controller implements (drives weapon aim-mode auto-detection) */
    getMode(): CameraMode;

    /** Apply camera shake effect */
    applyShake(intensity?: number): void;
    
    /** Clean up event listeners */
    dispose(): void;
}

/**
 * Camera mode enum for easy switching
 */
export type CameraMode = 'first-person' | 'third-person' | 'top-down';

/**
 * Controls which camera is used when the player enters a vehicle.
 *
 * - 'auto'    — detect from walking camera type (default, preserves legacy behaviour)
 * - 'chase'   — dedicated VehicleCamera (third-person chase cam with inertia)
 * - 'cockpit' — dedicated FirstPersonVehicleCamera (driver's-eye view)
 * - 'keep'    — retarget the walking camera to the vehicle chassis so any
 *               custom follow camera keeps working while driving
 */
export type VehicleCameraMode = 'auto' | 'chase' | 'cockpit' | 'keep';
