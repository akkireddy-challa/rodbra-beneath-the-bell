import * as THREE from 'three';
import type { VehicleConfig, WheelConfig } from 'engine/Vehicle.js';
import { createWheelConfig } from 'engine/Vehicle.js';
import type { VehicleHandlingConfig } from 'engine/vehicleHandling.js';
import type { VehicleRenderer } from 'engine/VehicleRenderer.js';

/**
 * Per-wheel configuration for platform vehicles.
 * Use this for monster trucks, tractors, or vehicles with different wheel sizes.
 */
export interface PlatformWheelConfig {
    /** Wheel radius in meters */
    radius: number;
    /** Wheel width in meters */
    width?: number;
    /** Suspension rest length in meters (default 0.6) */
    suspensionRestLength?: number;
    /** Suspension stiffness (10-40 range, default 15) */
    suspensionStiffness?: number;
    /** Suspension damping (0.1-0.5 range, default 0.4) */
    suspensionDamping?: number;
    /** Tire friction (50-150 range, default 100) */
    friction?: number;
    /** Whether this wheel receives engine power (default: true) */
    isDriven?: boolean;
    /** Torque multiplier (default: 1.0) */
    torqueRatio?: number;
    /** Wheel color (uses vehicle default if not set) */
    color?: number;
}

/**
 * One axle's fully resolved wheel settings: everything `createWheelConfig`
 * accepts except the position and the steering flag, which differ per wheel.
 * Both wheels on an axle share the rest, so each wheel is built from
 * `{ ...axle, isSteering }`.
 */
type ResolvedAxleWheels = Omit<WheelConfig, 'position' | 'isSteering' | 'sideFrictionStiffness'>;

/**
 * Configuration for a platform-based vehicle.
 * The platform is always a flat base (wheels + flat chassis between them).
 * Templates add body parts on top to create the actual vehicle shape.
 */
export interface PlatformVehicleConfig {
    /** Platform width in meters */
    width: number;
    /** Platform length in meters */
    length: number;
    
    // Per-axle wheel configuration (NEW - use these for monster trucks, tractors, etc.)
    /** Front wheels configuration (both front-left and front-right) */
    frontWheels?: PlatformWheelConfig;
    /** Rear wheels configuration (both rear-left and rear-right) */
    rearWheels?: PlatformWheelConfig;
    /** Middle wheels configuration (for 6-wheel vehicles) */
    middleWheels?: PlatformWheelConfig;
    
    // Legacy global wheel settings (used if frontWheels/rearWheels not provided)
    /** @deprecated Use frontWheels/rearWheels for per-axle configuration */
    wheelRadius?: number;
    /** @deprecated Use frontWheels/rearWheels for per-axle configuration */
    wheelWidth?: number;
    /** @deprecated Use frontWheels/rearWheels for per-axle configuration */
    suspensionStiffness?: number;
    /** @deprecated Use frontWheels/rearWheels for per-axle configuration */
    suspensionDamping?: number;
    /** @deprecated Use frontWheels/rearWheels for per-axle configuration */
    friction?: number;
    
    /** Optional: Number of wheels (default: 4) */
    wheelCount?: number;
    /** Optional: Platform body color */
    color?: number;
    /** Optional: Wheel color */
    wheelColor?: number;
    /** Optional: Vehicle mass in kg (auto-calculated if not provided) */
    mass?: number;
    /** Optional: Engine force in Newtons (auto-calculated if not provided) */
    engineForce?: number;
    /** Optional: handling overrides (top speed, steering feel, acceleration). Any field
     *  omitted uses a size-scaled default. See engine/vehicleHandling.ts. */
    handling?: VehicleHandlingConfig;
}

/**
 * Represents the flat platform structure that forms the base of a vehicle.
 * This is returned by VehiclePlatformBuilder and can be extended by templates.
 */
export interface VehiclePlatformStructure {
    /** The complete vehicle configuration to pass to Vehicle constructor */
    vehicleConfig: VehicleConfig;
    /** Platform dimensions for templates to build upon */
    platformWidth: number;
    platformLength: number;
    platformHeight: number; // The flat body thickness
    /** Per-wheel configurations (NEW) */
    wheelConfigs: WheelConfig[];
    /** Wheel positions for templates (derived from wheelConfigs) */
    wheelPositions: THREE.Vector3[];
    /** Largest wheel radius (for height calculations) */
    maxWheelRadius: number;
    /** Helper to get the top surface Y position (where templates should add body parts) */
    topSurfaceY: number;
    
    // Legacy compatibility (use wheelConfigs for new code)
    /** @deprecated Use wheelConfigs[0].radius or maxWheelRadius */
    wheelRadius: number;
    /** @deprecated Use wheelConfigs[0].width */
    wheelWidth: number;
}

/**
 * Block definition for platform body parts.
 * Used to define the flat chassis blocks between and around wheels.
 */
export interface PlatformBlock {
    /** Position relative to platform center */
    position: THREE.Vector3;
    /** Block dimensions */
    size: { width: number; height: number; length: number };
    /** Block color */
    color: number;
}

/**
 * VehiclePlatformBuilder creates flat vehicle platforms.
 * 
 * The platform consists of:
 * - Wheels at the corners
 * - Flat body filling the space between wheels
 * - The body is made of simple blocks (middle section + front/back sections)
 * 
 * Templates can then add body parts on top to create the actual vehicle shape.
 */
export class VehiclePlatformBuilder {
    /** Default platform body height (very flat) */
    static readonly PLATFORM_HEIGHT = 0.15; // 15cm flat platform

    /**
     * Create a vehicle platform configuration.
     * This generates the base flat platform that templates can build upon.
     * 
     * Supports per-axle wheel configuration for monster trucks, tractors, etc.
     * 
     * @param position - Initial world position for the vehicle
     * @param config - Platform configuration (width, length, wheel configs, etc.)
     * @returns Platform structure with vehicle config and building helpers
     */
    static createPlatform(position: THREE.Vector3, config: PlatformVehicleConfig): VehiclePlatformStructure {
        const {
            width,
            length,
            color = 0x444444,
            wheelColor = 0x222222,
            mass,
            engineForce,
        } = config;

        // Platform height is fixed and very flat
        const platformHeight = VehiclePlatformBuilder.PLATFORM_HEIGHT;

        // Resolve wheel configurations
        const wheelConfigs = VehiclePlatformBuilder.createWheelConfigs(config, platformHeight);
        
        // Extract wheel positions for backward compatibility
        const wheelPositions = wheelConfigs.map(w => w.position.clone());
        
        // Find max wheel radius for height calculations
        const maxWheelRadius = Math.max(...wheelConfigs.map(w => w.radius));
        
        // Use first wheel's values for legacy compatibility
        const firstWheel = wheelConfigs[0];
        const legacyWheelRadius = firstWheel?.radius ?? 0.4;
        const legacyWheelWidth = firstWheel?.width ?? 0.3;

        // Calculate mass based on platform area
        const finalMass = mass ?? (width * length * 50);

        // Calculate engine force
        const finalEngineForce = engineForce ?? (finalMass * 1.5);

        // Create the vehicle config with per-wheel configuration
        const vehicleConfig: VehicleConfig = {
            chassisSize: { width, height: platformHeight, length },
            mass: finalMass,
            engineForce: finalEngineForce,
            centerOfMassOffset: 0.4,
            wheels: wheelConfigs, // NEW: per-wheel configuration
            position: position.clone(),
            chassisColor: color,
            wheelColor,
            handling: config.handling,
        };

        // Calculate top surface Y position
        const topSurfaceY = platformHeight * 0.5;

        return {
            vehicleConfig,
            platformWidth: width,
            platformLength: length,
            platformHeight,
            wheelConfigs,
            wheelPositions,
            maxWheelRadius,
            topSurfaceY,
            // Legacy compatibility
            wheelRadius: legacyWheelRadius,
            wheelWidth: legacyWheelWidth,
        };
    }
    
    /**
     * Create per-wheel configurations based on platform config.
     * Handles both new per-axle config and legacy global settings.
     */
    private static createWheelConfigs(config: PlatformVehicleConfig, platformHeight: number): WheelConfig[] {
        const { width, length, wheelCount = 4, wheelColor = 0x222222 } = config;
        
        // Determine wheel settings for each axle
        const defaultRadius = config.wheelRadius ?? Math.min(width, length) * 0.15;
        const defaultSuspensionStiffness = config.suspensionStiffness ?? 15;
        const defaultSuspensionDamping = config.suspensionDamping ?? 0.4;
        const defaultFriction = config.friction ?? 100;
        
        // Suspension rest length - the distance from connection point to wheel center at rest.
        // A reasonable default (0.5-0.7m typical for cars) is used when not overridden.
        const calcSuspensionLength = (override?: number) => override ?? 0.6;

        // Front wheel settings (from frontWheels or defaults)
        const frontRadius = config.frontWheels?.radius ?? defaultRadius;
        const frontWidth = config.frontWheels?.width ?? config.wheelWidth ?? frontRadius * 0.75;
        const frontSuspensionLength = calcSuspensionLength(config.frontWheels?.suspensionRestLength);
        const frontStiffness = config.frontWheels?.suspensionStiffness ?? defaultSuspensionStiffness;
        const frontDamping = config.frontWheels?.suspensionDamping ?? defaultSuspensionDamping;
        const frontFriction = config.frontWheels?.friction ?? defaultFriction;
        const frontIsDriven = config.frontWheels?.isDriven ?? true;
        const frontTorqueRatio = config.frontWheels?.torqueRatio ?? 1.0;
        const frontColor = config.frontWheels?.color ?? wheelColor;
        
        // Rear wheel settings (from rearWheels or defaults)
        const rearRadius = config.rearWheels?.radius ?? defaultRadius;
        const rearWidth = config.rearWheels?.width ?? config.wheelWidth ?? rearRadius * 0.75;
        const rearSuspensionLength = calcSuspensionLength(config.rearWheels?.suspensionRestLength);
        const rearStiffness = config.rearWheels?.suspensionStiffness ?? defaultSuspensionStiffness;
        const rearDamping = config.rearWheels?.suspensionDamping ?? defaultSuspensionDamping;
        const rearFriction = config.rearWheels?.friction ?? defaultFriction;
        const rearIsDriven = config.rearWheels?.isDriven ?? true;
        const rearTorqueRatio = config.rearWheels?.torqueRatio ?? 1.0;
        const rearColor = config.rearWheels?.color ?? wheelColor;
        
        // Middle wheel settings (for 6-wheel vehicles)
        const midRadius = config.middleWheels?.radius ?? rearRadius;
        const midWidth = config.middleWheels?.width ?? rearWidth;
        const midSuspensionLength = calcSuspensionLength(config.middleWheels?.suspensionRestLength);
        const midStiffness = config.middleWheels?.suspensionStiffness ?? rearStiffness;
        const midDamping = config.middleWheels?.suspensionDamping ?? rearDamping;
        const midFriction = config.middleWheels?.friction ?? rearFriction;
        const midIsDriven = config.middleWheels?.isDriven ?? rearIsDriven;
        const midTorqueRatio = config.middleWheels?.torqueRatio ?? rearTorqueRatio;
        const midColor = config.middleWheels?.color ?? rearColor;

        // Bundle each axle's resolved settings once; the per-wheel calls below
        // only add the position and whether that wheel steers.
        const frontAxle: ResolvedAxleWheels = {
            radius: frontRadius, width: frontWidth, suspensionRestLength: frontSuspensionLength,
            suspensionStiffness: frontStiffness, suspensionDamping: frontDamping, friction: frontFriction,
            isDriven: frontIsDriven, torqueRatio: frontTorqueRatio, color: frontColor
        };
        const rearAxle: ResolvedAxleWheels = {
            radius: rearRadius, width: rearWidth, suspensionRestLength: rearSuspensionLength,
            suspensionStiffness: rearStiffness, suspensionDamping: rearDamping, friction: rearFriction,
            isDriven: rearIsDriven, torqueRatio: rearTorqueRatio, color: rearColor
        };
        const midAxle: ResolvedAxleWheels = {
            radius: midRadius, width: midWidth, suspensionRestLength: midSuspensionLength,
            suspensionStiffness: midStiffness, suspensionDamping: midDamping, friction: midFriction,
            isDriven: midIsDriven, torqueRatio: midTorqueRatio, color: midColor
        };

        const wheelConfigs: WheelConfig[] = [];

        // Calculate per-wheel Y positions based on each wheel's radius
        // Each wheel needs to be positioned so that when suspension is at rest,
        // the chassis sits at a consistent height above the ground
        const frontWheelY = -(platformHeight * 0.5) + (frontRadius * 0.2);
        const rearWheelY = -(platformHeight * 0.5) + (rearRadius * 0.2);
        const midWheelY = -(platformHeight * 0.5) + (midRadius * 0.2);
        
        if (wheelCount === 2) {
            // Two wheels (motorcycle-style)
            const wheelInsetZ = length * 0.4;
            wheelConfigs.push(
                createWheelConfig(new THREE.Vector3(0, frontWheelY, wheelInsetZ), { ...frontAxle, isSteering: true }),
                createWheelConfig(new THREE.Vector3(0, rearWheelY, -wheelInsetZ), { ...rearAxle, isSteering: false })
            );
        } else if (wheelCount === 4) {
            // Standard 4-wheel configuration
            const wheelInsetX = width * 0.45;
            const wheelInsetZ = length * 0.4;
            
            // Front wheels (steering)
            wheelConfigs.push(
                createWheelConfig(new THREE.Vector3(-wheelInsetX, frontWheelY, wheelInsetZ), { ...frontAxle, isSteering: true }),
                createWheelConfig(new THREE.Vector3(wheelInsetX, frontWheelY, wheelInsetZ), { ...frontAxle, isSteering: true })
            );

            // Rear wheels (non-steering)
            wheelConfigs.push(
                createWheelConfig(new THREE.Vector3(-wheelInsetX, rearWheelY, -wheelInsetZ), { ...rearAxle, isSteering: false }),
                createWheelConfig(new THREE.Vector3(wheelInsetX, rearWheelY, -wheelInsetZ), { ...rearAxle, isSteering: false })
            );
        } else if (wheelCount === 6) {
            // Six wheels (truck-style)
            const wheelInsetX = width * 0.45;
            const frontZ = length * 0.4;
            const midZ = 0;
            const rearZ = -length * 0.4;
            
            // Front wheels
            wheelConfigs.push(
                createWheelConfig(new THREE.Vector3(-wheelInsetX, frontWheelY, frontZ), { ...frontAxle, isSteering: true }),
                createWheelConfig(new THREE.Vector3(wheelInsetX, frontWheelY, frontZ), { ...frontAxle, isSteering: true })
            );

            // Middle wheels
            wheelConfigs.push(
                createWheelConfig(new THREE.Vector3(-wheelInsetX, midWheelY, midZ), { ...midAxle, isSteering: false }),
                createWheelConfig(new THREE.Vector3(wheelInsetX, midWheelY, midZ), { ...midAxle, isSteering: false })
            );

            // Rear wheels
            wheelConfigs.push(
                createWheelConfig(new THREE.Vector3(-wheelInsetX, rearWheelY, rearZ), { ...rearAxle, isSteering: false }),
                createWheelConfig(new THREE.Vector3(wheelInsetX, rearWheelY, rearZ), { ...rearAxle, isSteering: false })
            );
        } else {
            // Generic distribution for any wheel count (uses front/rear settings alternating)
            const wheelInsetX = width * 0.45;
            const segments = Math.ceil(wheelCount / 2);
            const spacing = (length * 0.8) / Math.max(segments - 1, 1);
            const startZ = length * 0.4;

            for (let i = 0; i < segments; i++) {
                const z = startZ - (spacing * i);
                const isFront = i === 0;
                const isRear = i === segments - 1;

                const axle = isFront ? frontAxle : (isRear ? rearAxle : midAxle);
                const wheelY = isFront ? frontWheelY : (isRear ? rearWheelY : midWheelY);

                wheelConfigs.push(createWheelConfig(new THREE.Vector3(-wheelInsetX, wheelY, z), { ...axle, isSteering: isFront }));

                if (wheelConfigs.length < wheelCount) {
                    wheelConfigs.push(createWheelConfig(new THREE.Vector3(wheelInsetX, wheelY, z), { ...axle, isSteering: isFront }));
                }
            }
        }
        
        return wheelConfigs;
    }

    /**
     * Generate the blocks that make up the flat platform body.
     * This is useful for templates that want to render the platform with VoxelObjects.
     * 
     * The platform is divided into sections:
     * - Center section (between wheel pairs)
     * - Front section (in front of front wheels)
     * - Rear section (behind rear wheels)
     * 
     * @param structure - The platform structure from createPlatform()
     * @returns Array of block definitions for the platform body
     */
    static getPlatformBlocks(structure: VehiclePlatformStructure): PlatformBlock[] {
        const { platformWidth, platformLength, platformHeight, vehicleConfig } = structure;
        const color = vehicleConfig.chassisColor ?? 0x444444;

        const blocks: PlatformBlock[] = [];

        // The platform is essentially one flat block filling the footprint
        // For simplicity, we create a single block that spans the entire platform
        // Templates can subdivide this into voxels if needed
        
        blocks.push({
            position: new THREE.Vector3(0, 0, 0), // Centered
            size: { width: platformWidth, height: platformHeight, length: platformLength },
            color
        });

        return blocks;
    }

    /**
     * Get sub-blocks for more detailed platform representation.
     * This divides the platform into front, middle, and rear sections
     * which is useful for voxel-based rendering.
     * 
     * @param structure - The platform structure
     * @param blockSize - Size of each sub-block (default: 0.5m for voxel alignment)
     * @returns Array of sub-blocks
     */
    static getPlatformSubBlocks(structure: VehiclePlatformStructure, blockSize: number = 0.5): PlatformBlock[] {
        const { platformWidth, platformLength, platformHeight, vehicleConfig } = structure;
        const color = vehicleConfig.chassisColor ?? 0x444444;

        const blocks: PlatformBlock[] = [];

        // Calculate how many blocks fit in each direction
        const blocksX = Math.ceil(platformWidth / blockSize);
        const blocksZ = Math.ceil(platformLength / blockSize);

        // Start position (centered)
        const startX = -(blocksX * blockSize) / 2 + blockSize / 2;
        const startZ = -(blocksZ * blockSize) / 2 + blockSize / 2;

        for (let ix = 0; ix < blocksX; ix++) {
            for (let iz = 0; iz < blocksZ; iz++) {
                blocks.push({
                    position: new THREE.Vector3(
                        startX + ix * blockSize,
                        0,
                        startZ + iz * blockSize
                    ),
                    size: { width: blockSize, height: platformHeight, length: blockSize },
                    color
                });
            }
        }

        return blocks;
    }
}

