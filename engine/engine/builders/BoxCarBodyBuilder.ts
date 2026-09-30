import * as THREE from 'three';
import { createClassedPartMaterial } from 'engine/ClassedPartMaterial.js';
import {
    DEFAULT_CHASSIS_COLOR,
    DEFAULT_WINDOW_OPACITY,
    addPlatformSlab,
    addSolidPartsPhysics,
    createBodyPartMaterial,
    createCylinderWheelMeshes,
} from 'engine/vehicle/PlatformVehicleParts.js';
import type { Vehicle, VehicleConfig, WheelConfig } from 'engine/Vehicle.js';
import type { VehiclePlatformStructure } from 'engine/VehiclePlatform.js';
import type { VehicleRenderer } from 'engine/VehicleRenderer.js';

/**
 * Configuration for a box part of the car body.
 */
export interface BoxPartConfig {
    /** Position relative to platform center (in meters) */
    position: { x: number; y: number; z: number };
    /** Size of the box (in meters) */
    size: { width: number; height: number; length: number };
    /** Box color */
    color: number;
    /** Is this a window? (transparent) */
    isWindow?: boolean;
}

/**
 * Configuration for building a box-based car body.
 */
export interface BoxCarBodyConfig {
    /** Array of box parts that make up the car body */
    parts: BoxPartConfig[];
    /** Window opacity (0-1, default: `DEFAULT_WINDOW_OPACITY`) */
    windowOpacity?: number;
}

/**
 * Add one mesh per body part, each lifted by `yOffset` — the platform's top
 * surface for a body bolted onto an existing vehicle, half the slab thickness
 * for a body built as part of the chassis group.
 */
function addPartMeshes(group: THREE.Group, parts: BoxPartConfig[], windowOpacity: number, yOffset: number): void {
    for (const part of parts) {
        const mesh = new THREE.Mesh(
            new THREE.BoxGeometry(part.size.width, part.size.height, part.size.length),
            createBodyPartMaterial(part, windowOpacity),
        );
        mesh.position.set(part.position.x, part.position.y + yOffset, part.position.z);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);
    }
}

/**
 * BoxCarBodyBuilder creates car bodies using THREE.js boxes.
 *
 * The AI agent builds the car shape by specifying individual box parts.
 * Each part has position, size, color, and optional window flag.
 *
 * The AI should design the car shape creatively by placing boxes.
 */
export class BoxCarBodyBuilder {
    /**
     * Add a box-based body to an existing vehicle.
     *
     * @param vehicle - The vehicle to add body to
     * @param platform - The platform structure
     * @param config - Body configuration with box parts
     */
    static addBoxBody(
        vehicle: Vehicle,
        platform: VehiclePlatformStructure,
        config: BoxCarBodyConfig
    ): THREE.Group {
        const bodyGroup = new THREE.Group();
        bodyGroup.name = 'BoxCarBody';
        addPartMeshes(bodyGroup, config.parts, config.windowOpacity ?? DEFAULT_WINDOW_OPACITY, 0);

        // Position the body on top of the platform
        bodyGroup.position.y = platform.topSurfaceY;
        vehicle.addBodyVisual(bodyGroup);

        addSolidPartsPhysics(vehicle, platform, config.parts);

        return bodyGroup;
    }

    /**
     * Create a VehicleRenderer that builds the car with boxes.
     *
     * @param platform - The platform structure
     * @param config - Body configuration with box parts
     */
    static createBoxRenderer(platform: VehiclePlatformStructure, config: BoxCarBodyConfig): VehicleRenderer {
        return new BoxCarRenderer(platform, config);
    }
}

/**
 * BoxCarRenderer - VehicleRenderer that creates box-based vehicles.
 */
class BoxCarRenderer implements VehicleRenderer {
    constructor(
        private readonly platform: VehiclePlatformStructure,
        private readonly config: BoxCarBodyConfig,
    ) {}

    createChassisMesh(vehicleConfig: VehicleConfig, position: THREE.Vector3): THREE.Object3D {
        const group = new THREE.Group();
        group.name = 'BoxVehicle';
        group.position.copy(position);

        const { platformWidth, platformLength, platformHeight, wheelPositions } = this.platform;

        addPlatformSlab(group, {
            size: { width: platformWidth, height: platformHeight, length: platformLength },
            wheelZs: wheelPositions.map(p => p.z),
            material: createClassedPartMaterial('paint', { color: vehicleConfig.chassisColor ?? DEFAULT_CHASSIS_COLOR }),
        });

        // Body parts sit on the slab's top surface, which is half a slab above
        // the chassis origin.
        addPartMeshes(group, this.config.parts, this.config.windowOpacity ?? DEFAULT_WINDOW_OPACITY, platformHeight / 2);

        return group;
    }

    createWheelMeshes(config: VehicleConfig, position: THREE.Vector3, wheelConfigs?: WheelConfig[]): THREE.Mesh[] {
        return createCylinderWheelMeshes(config, position, wheelConfigs, { name: 'BoxWheel', segments: 16 });
    }

    updateVisuals(_deltaTime: number, _speed: number): void {
        // No animations
    }
}

export { BoxCarRenderer };
