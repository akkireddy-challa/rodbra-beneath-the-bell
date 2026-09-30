import * as THREE from 'three';
import { createClassedPartMaterial } from 'engine/ClassedPartMaterial.js';
import {
    DEFAULT_CHASSIS_COLOR,
    addPlatformSlab,
    createCylinderWheelMeshes,
} from 'engine/vehicle/PlatformVehicleParts.js';
import type { VehicleRenderer } from 'engine/VehicleRenderer.js';
import type { VehicleConfig, WheelConfig } from 'engine/Vehicle.js';

/**
 * PlatformVehicleRenderer - Creates the basic flat platform visual for vehicles.
 *
 * This renderer creates a simple flat platform that fills the space between
 * wheels (see `addPlatformSlab` for the silhouette). Templates are expected to
 * add body parts on top of this platform.
 *
 * The platform consists of:
 * - A flat rectangular body (the chassis)
 * - Wheels at the corners (or other positions)
 *
 * For a voxelized version of the same car, use
 * `VoxelCarBodyBuilder.createVoxelRenderer()`.
 */
export class PlatformVehicleRenderer implements VehicleRenderer {
    createChassisMesh(config: VehicleConfig, position: THREE.Vector3): THREE.Object3D {
        // Create a group to hold the platform parts
        const platformGroup = new THREE.Group();
        platformGroup.name = 'VehiclePlatform';
        platformGroup.position.copy(position);

        // Get wheel positions from new wheels[] or legacy wheelPositions[]
        const wheelPositions = config.wheels?.map(w => w.position) ?? config.wheelPositions ?? [];
        if (wheelPositions.length === 0) {
            console.warn('PlatformVehicleRenderer: No wheel positions provided');
            return platformGroup;
        }

        addPlatformSlab(platformGroup, {
            size: config.chassisSize,
            wheelZs: wheelPositions.map(p => p.z),
            // 'paint' — the same painted-bodywork class voxelized vehicles carry.
            material: createClassedPartMaterial('paint', { color: config.chassisColor ?? DEFAULT_CHASSIS_COLOR }),
        });

        return platformGroup;
    }

    createWheelMeshes(config: VehicleConfig, position: THREE.Vector3, wheelConfigs?: WheelConfig[]): THREE.Mesh[] {
        return createCylinderWheelMeshes(config, position, wheelConfigs, { name: 'PlatformWheel', segments: 16 });
    }

    updateVisuals(_deltaTime: number, _speed: number): void {
        // Platform has no special animations by default
        // Templates can override this if needed
    }
}

/**
 * @deprecated Unused — the voxel car renderer takes its voxel size from
 * `VoxelCarBodyConfig` instead. See
 * `VoxelCarBodyBuilder.createVoxelRenderer()` in
 * `engine/builders/VoxelCarBodyBuilder.ts`.
 */
export interface VoxelPlatformRendererOptions {
    /** Voxel size in world units (default: 0.25m for vehicles) */
    voxelSize?: number;
    /** Use texture atlas for rendering (default: false, uses vertex colors) */
    useAtlas?: boolean;
}
