import * as THREE from 'three';
import type { VehicleConfig, WheelConfig } from 'engine/Vehicle.js';

/**
 * Interface for pluggable vehicle visual renderers
 * Separates visual creation from physics logic, allowing templates to create custom vehicle types
 */
export interface VehicleRenderer {
    /**
     * Create the visual mesh(es) for the vehicle chassis
     * This method is responsible for creating all visual parts of the vehicle body
     * (frame, cabin, windows, lights, etc.)
     *
     * @param config - Vehicle configuration with dimensions and colors
     * @param position - Initial world position for the vehicle
     * @returns The root mesh/group for the vehicle visuals (will be synced with physics)
     */
    createChassisMesh(config: VehicleConfig, position: THREE.Vector3): THREE.Object3D;

    /**
     * Create visual meshes for wheels
     * Should create one mesh per wheel based on resolved wheel configurations.
     * 
     * New renderers should use wheelConfigs for per-wheel customization.
     * Legacy renderers can still use config.wheelPositions with global wheel settings.
     *
     * @param config - Vehicle configuration (for backward compatibility)
     * @param position - Initial world position for the vehicle
     * @param wheelConfigs - Optional: Resolved per-wheel configurations (new API)
     * @returns Array of wheel meshes (one per wheel)
     */
    createWheelMeshes(config: VehicleConfig, position: THREE.Vector3, wheelConfigs?: WheelConfig[]): THREE.Mesh[];

    /**
     * Optional: Update visual appearance each frame
     * Can be used for animations, dynamic lights, particle effects, etc.
     *
     * @param deltaTime - Time since last frame in seconds
     * @param speed - Current vehicle speed (magnitude of velocity)
     */
    updateVisuals?(deltaTime: number, speed: number): void;
}
