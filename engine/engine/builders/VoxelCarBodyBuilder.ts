import * as THREE from 'three';
import { VoxelObject } from 'engine/VoxelObject.js';
import { BlockType } from 'engine/VoxelTextureAtlas.js';
import {
    DEFAULT_CHASSIS_COLOR,
    SPINE_WIDTH_RATIO,
    addSolidPartsPhysics,
    createCylinderWheelMeshes,
} from 'engine/vehicle/PlatformVehicleParts.js';
import type { Vehicle, VehicleConfig, WheelConfig } from 'engine/Vehicle.js';
import type { VehiclePlatformStructure } from 'engine/VehiclePlatform.js';
import type { VehicleRenderer } from 'engine/VehicleRenderer.js';

/** Voxel edge length in world units when a body config names none. */
const DEFAULT_VOXEL_SIZE = 0.25;

/**
 * Configuration for a voxel block in the car body.
 */
export interface VoxelBlockConfig {
    /** Position relative to platform center (in voxel units) */
    x: number;
    y: number;
    z: number;
    /** Block color (RGB24) */
    color: number;
}

/**
 * Configuration for a voxel box part (fills a rectangular region with voxels).
 * Similar to BoxCarBodyBuilder's BoxPartConfig but for voxels.
 */
export interface VoxelPartConfig {
    /** Position relative to platform center (in meters) */
    position: { x: number; y: number; z: number };
    /** Size of the box (in meters) - will be converted to voxels */
    size: { width: number; height: number; length: number };
    /** Box color */
    color: number;
    /** Is this a window? (uses different block type) */
    isWindow?: boolean;
}

/**
 * Configuration for building a voxel car body.
 */
export interface VoxelCarBodyConfig {
    /** Array of voxel blocks that make up the car body (low-level) */
    blocks?: VoxelBlockConfig[];
    /** Array of box parts (high-level, like BoxCarBodyBuilder) */
    parts?: VoxelPartConfig[];
    /** Voxel size in world units (default: `DEFAULT_VOXEL_SIZE`) */
    voxelSize?: number;
}

/**
 * VoxelCarBodyBuilder creates car bodies using VoxelObjects.
 * 
 * Two ways to define car body:
 * 1. SIMPLE (recommended): Use 'parts' array - same as BoxCarBodyBuilder but renders as voxels
 * 2. DETAILED: Use 'blocks' array - specify individual voxel positions
 */
export class VoxelCarBodyBuilder {
    /** Track all car body VoxelObjects for projectile collision detection */
    private static carBodyVoxelObjects = new Set<VoxelObject>();

    /**
     * Get all car body VoxelObjects (for projectile collision detection)
     */
    static getCarBodyVoxelObjects(): Set<VoxelObject> {
        return VoxelCarBodyBuilder.carBodyVoxelObjects;
    }

    /**
     * Check if a VoxelObject is a car body part
     */
    static isCarBody(voxelObject: VoxelObject): boolean {
        return VoxelCarBodyBuilder.carBodyVoxelObjects.has(voxelObject);
    }

    /**
     * Volvo-240-silhouette voxel sedan body with tinted windshield + rear window.
     * Pair with `DEFAULT_RACING_CAR_CONFIG` from engine/VehicleSpawner.js.
     * Pass directly to `addVoxelBody()` or as the body arg to `spawnAndEnter()`.
     */
    static sedanBody(color: number): VoxelCarBodyConfig {
        const trim = Math.max(0, color - 0x222222);
        return {
            parts: [
                { position: { x: 0, y: 0.05, z:  0    }, size: { width: 1.9,  height: 0.7,  length: 3.3  }, color },
                { position: { x: 0, y: 0.7,  z: -0.05 }, size: { width: 1.7,  height: 0.6,  length: 1.4  }, color: trim },
                { position: { x: 0, y: 0.7,  z:  0.62 }, size: { width: 1.55, height: 0.45, length: 0.06 }, color: 0x1a1a44, isWindow: true },
                { position: { x: 0, y: 0.7,  z: -0.72 }, size: { width: 1.55, height: 0.45, length: 0.06 }, color: 0x1a1a44, isWindow: true },
                { position: { x: 0, y: 1.02, z: -0.05 }, size: { width: 1.72, height: 0.08, length: 1.42 }, color: trim },
            ],
        };
    }

    /**
     * Add a voxel body to an existing vehicle.
     * 
     * @param vehicle - The vehicle to add body to
     * @param platform - The platform structure
     * @param config - Body configuration with parts or blocks
     */
    static addVoxelBody(
        vehicle: Vehicle,
        platform: VehiclePlatformStructure,
        config: VoxelCarBodyConfig
    ): VoxelObject {
        const voxelSize = config.voxelSize ?? DEFAULT_VOXEL_SIZE;

        const voxelBody = new VoxelObject({ voxelSize, shadows: true });
        voxelBody.name = 'VoxelCarBody';
        VoxelCarBodyBuilder.populateVoxels(voxelBody, config, voxelSize);
        voxelBody.finalize();

        // VoxelObject centers its mesh on the bounding box; compensate so the body
        // sits centered on the platform origin even if parts quantize asymmetrically.
        const bbox = new THREE.Box3().setFromObject(voxelBody);
        voxelBody.position.set(
            -(bbox.min.x + bbox.max.x) / 2,
            platform.topSurfaceY,
            -(bbox.min.z + bbox.max.z) / 2,
        );

        VoxelCarBodyBuilder.carBodyVoxelObjects.add(voxelBody);
        vehicle.addBodyVisual(voxelBody);

        // Body parts contribute collision only — mass lives on the platform.
        if (config.parts?.length) {
            addSolidPartsPhysics(vehicle, platform, config.parts);
        } else if (config.blocks?.length) {
            VoxelCarBodyBuilder.addBlockCloudPhysics(vehicle, platform, config.blocks, voxelSize);
        }

        return voxelBody;
    }

    /**
     * One collision box around a block cloud. The low-level `blocks` path has no
     * part list to derive shapes from, so the body's bounding box stands in for
     * it. Mass stays 0 — the platform carries the vehicle's weight.
     */
    private static addBlockCloudPhysics(
        vehicle: Vehicle,
        platform: VehiclePlatformStructure,
        blocks: VoxelBlockConfig[],
        voxelSize: number,
    ): void {
        if (blocks.length === 0) return;

        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;
        for (const block of blocks) {
            minX = Math.min(minX, block.x); maxX = Math.max(maxX, block.x);
            minY = Math.min(minY, block.y); maxY = Math.max(maxY, block.y);
            minZ = Math.min(minZ, block.z); maxZ = Math.max(maxZ, block.z);
        }

        vehicle.addBodyPhysics({
            position: new THREE.Vector3(
                (minX + maxX) / 2 * voxelSize,
                platform.topSurfaceY + (minY + maxY) / 2 * voxelSize,
                (minZ + maxZ) / 2 * voxelSize,
            ),
            // +1: a voxel spans a full cell, so the extent covers both end cells.
            size: {
                width: (maxX - minX + 1) * voxelSize,
                height: (maxY - minY + 1) * voxelSize,
                length: (maxZ - minZ + 1) * voxelSize,
            },
            mass: 0,
        });
    }

    /**
     * Populate a VoxelObject with the parts and/or blocks declared in a body config.
     * Shared by `addVoxelBody` and `VoxelCarRenderer.createChassisMesh`.
     */
    static populateVoxels(target: VoxelObject, config: VoxelCarBodyConfig, voxelSize: number): void {
        for (const part of config.parts ?? []) {
            VoxelCarBodyBuilder.addPartAsVoxels(target, part, voxelSize);
        }
        for (const block of config.blocks ?? []) {
            target.setVoxel(block.x, block.y, block.z, BlockType.COLOR, block.color);
        }
    }

    /**
     * Convert a box part to voxels and add to VoxelObject.
     * Public so VoxelCarRenderer can use it.
     */
    static addPartAsVoxels(
        voxelBody: VoxelObject, 
        part: VoxelPartConfig, 
        voxelSize: number
    ): void {
        const { position, size, color } = part;
        
        // Convert meters to voxel units
        const halfW = Math.floor((size.width / voxelSize) / 2);
        const halfH = Math.floor((size.height / voxelSize) / 2);
        const halfL = Math.floor((size.length / voxelSize) / 2);
        
        // Center position in voxel units
        const cx = Math.round(position.x / voxelSize);
        const cy = Math.round(position.y / voxelSize);
        const cz = Math.round(position.z / voxelSize);
        
        // Fill the box with voxels
        for (let x = cx - halfW; x <= cx + halfW; x++) {
            for (let y = cy - halfH; y <= cy + halfH; y++) {
                for (let z = cz - halfL; z <= cz + halfL; z++) {
                    // Windows could use a different block type in future
                    voxelBody.setVoxel(x, y, z, BlockType.COLOR, color);
                }
            }
        }
    }

    /**
     * Create a VehicleRenderer that builds the car with voxels.
     * 
     * @param platform - The platform structure
     * @param config - Body configuration with voxel blocks
     */
    static createVoxelRenderer(platform: VehiclePlatformStructure, config: VoxelCarBodyConfig): VehicleRenderer {
        return new VoxelCarRenderer(platform, config);
    }
}

/**
 * VoxelCarRenderer - VehicleRenderer that creates voxel vehicles.
 */
class VoxelCarRenderer implements VehicleRenderer {
    constructor(
        private readonly platform: VehiclePlatformStructure,
        private readonly config: VoxelCarBodyConfig,
    ) {}

    createChassisMesh(vehicleConfig: VehicleConfig, position: THREE.Vector3): THREE.Object3D {
        const group = new THREE.Group();
        group.name = 'VoxelVehicle';
        group.position.copy(position);

        const voxelSize = this.config.voxelSize ?? DEFAULT_VOXEL_SIZE;
        const { platformWidth, platformLength, platformHeight, wheelPositions } = this.platform;

        // Create platform as voxels, in the same silhouette `addPlatformSlab`
        // builds out of boxes:
        //    ##      <- narrow front (ahead of front wheels)
        //  ######    <- wide middle (from front to rear wheels)
        //    ##      <- narrow rear (behind rear wheels)
        // Wheels sit in the side gaps at front/rear of middle section

        const platformVoxelObject = new VoxelObject({ voxelSize, shadows: true });
        platformVoxelObject.name = 'VoxelCarPlatform';
        const halfX = Math.floor(Math.floor(platformWidth / voxelSize) / 2);
        const halfZ = Math.floor(Math.floor(platformLength / voxelSize) / 2);
        const spineHalfWidth = Math.floor(halfX * SPINE_WIDTH_RATIO);

        // Find front and rear wheel Z positions in voxel coordinates
        const wheelZs = wheelPositions.map(p => Math.round(p.z / voxelSize));
        const frontWheelVoxelZ = Math.max(...wheelZs);
        const rearWheelVoxelZ = Math.min(...wheelZs);

        // Build platform voxels
        const platformColor = vehicleConfig.chassisColor ?? DEFAULT_CHASSIS_COLOR;
        for (let x = -halfX; x <= halfX; x++) {
            for (let z = -halfZ; z <= halfZ; z++) {
                // Wide middle section: between front and rear wheel Z positions
                const isInMiddle = z <= frontWheelVoxelZ && z >= rearWheelVoxelZ;
                // Narrow spine: only center portion, outside the wheel zone
                const isInSpine = Math.abs(x) <= spineHalfWidth;
                
                // Place voxel if: in wide middle section OR in narrow spine (front/rear)
                if (isInMiddle || isInSpine) {
                    platformVoxelObject.setVoxel(x, 0, z, BlockType.COLOR, platformColor);
                }
            }
        }
        platformVoxelObject.finalize();
        group.add(platformVoxelObject);

        // Create body as voxels
        const bodyVoxelObject = new VoxelObject({ voxelSize, shadows: true });
        bodyVoxelObject.name = 'VoxelCarBody';
        VoxelCarBodyBuilder.populateVoxels(bodyVoxelObject, this.config, voxelSize);
        bodyVoxelObject.finalize();
        bodyVoxelObject.position.y = platformHeight;
        group.add(bodyVoxelObject);

        return group;
    }

    createWheelMeshes(config: VehicleConfig, position: THREE.Vector3, wheelConfigs?: WheelConfig[]): THREE.Mesh[] {
        // The body is voxelized and classes itself; only the wheels are built
        // here, at low segment counts to keep the chunky voxel look.
        return createCylinderWheelMeshes(config, position, wheelConfigs, { name: 'VoxelWheel', segments: 8 });
    }

    updateVisuals(_deltaTime: number, _speed: number): void {
        // No animations
    }
}

export { VoxelCarRenderer };

