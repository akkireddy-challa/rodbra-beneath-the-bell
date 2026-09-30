import * as THREE from 'three';
import { Spawner } from 'engine/Spawner.js';
import { VehiclePlatformBuilder, type PlatformVehicleConfig, type VehiclePlatformStructure } from 'engine/VehiclePlatform.js';
import type { VehicleManager } from 'engine/VehicleManager.js';
import { Vehicle } from 'engine/Vehicle.js';
import type { VehicleRenderer } from 'engine/VehicleRenderer.js';
import type { PlayerController } from 'engine/PlayerController.js';
import { VoxelCarBodyBuilder, type VoxelCarBodyConfig } from 'engine/builders/VoxelCarBodyBuilder.js';
import { headingTangent } from 'engine/VehicleHeading.js';
import { createWheelConfig, type VehicleBodyPart, type VehicleConfig, type WheelConfig } from 'engine/Vehicle.js';
import { AssetVehicleRenderer } from 'engine/renderers/AssetVehicleRenderer.js';
import { loadVehicleAssetVisual, wheelMeshForAxleSide } from 'engine/vehicle/VehicleAssetVisual.js';

/**
 * Tuned racing-sedan physics defaults.
 *
 * Suspension tuning intent: NO pitch dive on accel/brake, but VISIBLE body roll
 * on cornering — the "leans into the corner" look real cars have.
 *
 *   - `suspensionRestLength: 0.4` (was 0.25): more travel so the spring has
 *     room to actually compress when lateral cornering force loads one side.
 *   - Front softer (28) than rear (38): rear-stiff bias resists squat on
 *     acceleration. Front isn't soft enough to nose-dive on braking — combined
 *     with the heavy damping below it stays composed.
 *   - `suspensionDamping: 1.3` (was 0.7): much higher damping kills oscillation
 *     so the car settles immediately after a pitch input — visible roll on
 *     cornering remains because cornering force is sustained, but transient
 *     pitch impulses are absorbed before they manifest.
 *   - `friction: 130` (was 110): more lateral grip → more cornering G → more
 *     visible roll into the corner. The car commits harder before it slides.
 *
 * Pair with `VoxelCarBodyBuilder.sedanBody(color)` for a matching visual body.
 */
export const DEFAULT_RACING_CAR_CONFIG: PlatformVehicleConfig = {
    width: 2.3,
    length: 3.4,
    mass: 1700,
    engineForce: 7500,
    frontWheels: { radius: 0.4, suspensionRestLength: 0.4, suspensionStiffness: 28, suspensionDamping: 1.3, friction: 130 },
    rearWheels:  { radius: 0.4, suspensionRestLength: 0.4, suspensionStiffness: 38, suspensionDamping: 1.3, friction: 130 },
};

// Re-export so `scaleVehicleConfig` is reachable next to DEFAULT_RACING_CAR_CONFIG.
export { scaleVehicleConfig } from 'engine/vehicleConfigScaling.js';

/** Options for spawnFromAsset / spawnAndEnterFromAsset. */
export interface SpawnFromAssetOptions {
    /**
     * Yaw in radians, 0 = facing +Z (gameplay forward). Always explicit —
     * RapierVehicle's own missing-rotation legacy default is π, not 0.
     */
    spawnRotation: number;
}

export const DEFAULT_SPAWN_FROM_ASSET_OPTIONS: SpawnFromAssetOptions = { spawnRotation: 0 };

/**
 * Expected suspension length under load, as a fraction of rest length.
 * Connection points are placed so that at this equilibrium the wheel centers
 * sit exactly where the asset's authored axles are — wheels centered in
 * their arches, authored ground clearance reproduced. Tuned against the
 * headless drive test; raising it lifts the body relative to the wheels.
 */
const EQ_SUSPENSION_LENGTH_FRACTION = 0.6;

/**
 * VehicleSpawner - Specialized helper for spawning platform-based vehicles
 *
 * This class provides the API for creating vehicles using the platform-based system:
 * 1. Create a flat platform (wheels + flat chassis) using width/length
 * 2. Templates add body parts on top using VoxelCarBodyBuilder or BoxCarBodyBuilder
 */
export class VehicleSpawner {
    private spawner: Spawner;
    private vehicleManager: VehicleManager;

    constructor(spawner: Spawner, vehicleManager: VehicleManager) {
        this.spawner = spawner;
        this.vehicleManager = vehicleManager;
    }

    /**
     * Chassis lift at spawn so that NO axle starts embedded in the ground.
     * The chassis must sit high enough that every wheel — at its own radius,
     * suspension rest length and mounting offset — just reaches the ground at
     * rest. Using only wheelConfigs[0] (the front wheel) buried the larger
     * rear wheels of mixed-axle vehicles (larger rear radius than front); the
     * over-compressed rear suspension then violently extended the instant the
     * vehicle started updating. Take the MAX requirement across all wheels instead.
     * Per wheel: required chassis height above ground = radius + suspension
     * rest length − wheel mounting Y (a higher mount needs less chassis lift).
     *
     * @param fallbackReach - chassis lift AND wheel reach to assume when there
     *   are no wheel configs at all (a platform falls back to its nominal wheel
     *   radius plus suspension; an asset-built vehicle has no nominal wheel, so
     *   it passes 0 and spawns flush with the ground).
     */
    private static spawnHeightOffset(wheelConfigs: WheelConfig[], fallbackReach: number): number {
        let heightOffset = 0;
        let maxWheelReach = 0; // radius + suspension of the tallest-reaching wheel
        if (wheelConfigs.length > 0) {
            for (const wc of wheelConfigs) {
                const susp = wc.suspensionRestLength ?? 0.6;
                const req = wc.radius + susp - wc.position.y;
                if (req > heightOffset) heightOffset = req;
                const reach = wc.radius + susp;
                if (reach > maxWheelReach) maxWheelReach = reach;
            }
        } else {
            heightOffset = fallbackReach;
            maxWheelReach = fallbackReach;
        }
        // Settle margin scales with wheel reach (from upstream) so small cars
        // don't free-fall far enough to tip before a wheel touches, while
        // big-wheeled vehicles get proportionally more clearance.
        return heightOffset + maxWheelReach * 0.25;
    }

    /**
     * Spawn a platform-based vehicle at a specific X/Z position.
     *
     * This creates a flat platform (wheels + flat chassis) that templates
     * can then add body parts to using VoxelCarBodyBuilder or BoxCarBodyBuilder.
     *
     * The vehicle spawns EXACTLY at the requested X/Z (only the ground height
     * is resolved) — the spawn position is never adjusted, so grid slots and
     * designer-placed spawn points are honored as-is. Slopes are safe: every
     * vehicle spawns with the parking brake engaged and stays put until the
     * first gas/reverse input (player or AI) releases it.
     *
     * @param xz - The X and Z coordinates where to spawn
     * @param config - Platform configuration (width, length - no height!)
     * @param renderer - Optional custom renderer for the vehicle
     * @returns Object containing vehicle and platform structure, or null if failed
     */
    public spawnVehicle(
        xz: { x: number; z: number },
        config: PlatformVehicleConfig,
        renderer?: VehicleRenderer,
        spawnRotation?: number
    ): { vehicle: Vehicle; platform: VehiclePlatformStructure } | null {
        const engine = this.spawner.getEngine();
        if (!engine.physicsWorld) {
            console.error(`VehicleSpawner: Cannot spawn vehicle - no physics world`);
            return null;
        }

        // Build the platform structure (position is reassigned below from spawnPosition)
        const platform = VehiclePlatformBuilder.createPlatform(new THREE.Vector3(), config);
        
        // If custom renderer provided, use it
        if (renderer) {
            platform.vehicleConfig.renderer = renderer;
        }

        const heightOffset = VehicleSpawner.spawnHeightOffset(platform.wheelConfigs, platform.wheelRadius + 0.6);
        const spawnPosition = this.spawner.calculateSpawnPosition(xz, heightOffset);

        if (!spawnPosition) {
            console.error(`VehicleSpawner: Cannot spawn vehicle at (${xz.x}, ${xz.z}) - no ground found`);
            return null;
        }

        // Update vehicle config position and rotation
        platform.vehicleConfig.position = spawnPosition;
        if (spawnRotation !== undefined) {
            platform.vehicleConfig.spawnRotation = spawnRotation;
        }

        console.log(`VehicleSpawner: Spawning platform vehicle at (${spawnPosition.x.toFixed(2)}, ${spawnPosition.y.toFixed(2)}, ${spawnPosition.z.toFixed(2)})${spawnRotation !== undefined ? ` rot=${(spawnRotation * 180 / Math.PI).toFixed(0)}°` : ''}`);
        console.log(`  Platform: ${config.width.toFixed(2)}m x ${config.length.toFixed(2)}m`);

        try {
            const vehicle = this.vehicleManager.createVehicle(platform.vehicleConfig);
            console.log('✅ Platform vehicle spawned successfully');
            return { vehicle, platform };
        } catch (error) {
            console.error('VehicleSpawner: Failed to spawn vehicle:', error);
            return null;
        }
    }

    /**
     * Spawn a vehicle at an offset from a reference position
     *
     * @param referencePos - Reference position (e.g., player spawn position)
     * @param offset - Offset from reference position {x, z}
     * @param config - Platform configuration
     * @param renderer - Optional custom renderer
     * @returns Object containing vehicle and platform structure, or null if failed
     */
    public spawnVehicleRelativeTo(
        referencePos: { x: number; z: number },
        offset: { x: number; z: number },
        config: PlatformVehicleConfig,
        renderer?: VehicleRenderer
    ): { vehicle: Vehicle; platform: VehiclePlatformStructure } | null {
        const targetX = referencePos.x + offset.x;
        const targetZ = referencePos.z + offset.z;

        return this.spawnVehicle({ x: targetX, z: targetZ }, config, renderer);
    }

    /**
     * Spawn a vehicle with automatic fallback to nearby valid position
     *
     * @param xz - Desired spawn position {x, z}
     * @param config - Platform configuration
     * @param renderer - Optional custom renderer
     * @param searchRadius - Maximum search radius for fallback position (default: 20)
     * @returns Object containing vehicle and platform structure, or null if no valid position found
     */
    public spawnVehicleWithFallback(
        xz: { x: number; z: number },
        config: PlatformVehicleConfig,
        renderer?: VehicleRenderer,
        searchRadius: number = 20,
        spawnRotation?: number
    ): { vehicle: Vehicle; platform: VehiclePlatformStructure } | null {
        // Try original position first
        const result = this.spawnVehicle(xz, config, renderer, spawnRotation);
        if (result) {
            return result;
        }

        // Find nearby valid position
        console.log(`VehicleSpawner: Target position (${xz.x}, ${xz.z}) invalid, searching for nearby position...`);
        const fallbackXZ = this.spawner.findNearbyValidPosition(xz, searchRadius);

        if (fallbackXZ) {
            console.log(`VehicleSpawner: Found valid fallback position at (${fallbackXZ.x}, ${fallbackXZ.z})`);
            return this.spawnVehicle(fallbackXZ, config, renderer, spawnRotation);
        }

        return null;
    }

    /**
     * Spawn a vehicle with a pre-built renderer that includes the body.
     * This is a convenience method for when you want to use a VehicleRenderer
     * that already creates both platform and body visuals.
     * 
     * @param xz - The X and Z coordinates where to spawn
     * @param config - Platform configuration
     * @param renderer - Renderer that creates the complete vehicle visual
     * @returns The spawned vehicle, or null if failed
     */
    public spawnVehicleWithRenderer(
        xz: { x: number; z: number },
        config: PlatformVehicleConfig,
        renderer: VehicleRenderer
    ): Vehicle | null {
        return this.spawnVehicle(xz, config, renderer)?.vehicle ?? null;
    }

    /**
     * Spawn multiple vehicles at once from a list of spawn definitions
     *
     * @param spawns - Array of spawn definitions with position and config
     * @returns Array of results (null entries for failed spawns)
     */
    public spawnMultipleVehicles(
        spawns: Array<{
            position: { x: number; z: number };
            config: PlatformVehicleConfig;
            renderer?: VehicleRenderer;
        }>
    ): Array<{ vehicle: Vehicle; platform: VehiclePlatformStructure } | null> {
        return spawns.map(spawn => this.spawnVehicle(spawn.position, spawn.config, spawn.renderer));
    }

    /**
     * Create a platform structure without spawning.
     * Useful when you need to calculate dimensions before spawning.
     * 
     * @param config - Platform configuration
     * @returns The platform structure
     */
    public createPlatformStructure(config: PlatformVehicleConfig): VehiclePlatformStructure {
        return VehiclePlatformBuilder.createPlatform(new THREE.Vector3(), config);
    }

    /**
     * Spawn a vehicle AND put the player in it - THE ONE API FOR SPAWNING PLAYER VEHICLES
     * 
     * This method handles EVERYTHING in one call:
     * - Creates the vehicle platform at the specified position
     * - Builds the voxel body (required - vehicles always need a body!)
     * - Puts the player in the vehicle
     * - Switches to vehicle movement system and camera
     * - Updates all tracking flags
     * 
     * @param xz - The X and Z coordinates where to spawn the vehicle
     * @param config - Platform configuration (width, length, mass, etc.)
     * @param bodyConfig - Voxel body configuration (parts that make up the car chassis)
     * @param playerController - The player controller to put in the vehicle
     * @returns Object containing vehicle and platform, or null if spawn failed
     */
    public spawnAndEnter(
        xz: { x: number; z: number },
        config: PlatformVehicleConfig,
        bodyConfig: VoxelCarBodyConfig,
        playerController: PlayerController,
        spawnRotation?: number
    ): { vehicle: Vehicle; platform: VehiclePlatformStructure } | null {
        // Step 1: Spawn the vehicle platform
        const result = this.spawnVehicleWithFallback(xz, config, undefined, undefined, spawnRotation);
        
        if (!result) {
            console.warn('VehicleSpawner.spawnAndEnter: Failed to spawn vehicle');
            return null;
        }
        
        // Step 2: Build the body (required - vehicles always need a body!)
        VoxelCarBodyBuilder.addVoxelBody(result.vehicle, result.platform, bodyConfig);
        
        // Step 3: Enter the vehicle using the proper PlayerController API
        const entered = playerController.enterVehicle(result.vehicle);
        
        if (!entered) {
            console.warn('VehicleSpawner.spawnAndEnter: Failed to enter vehicle');
            // Vehicle was spawned but couldn't enter - still return it so caller can handle
            return result;
        }
        
        console.log('VehicleSpawner.spawnAndEnter: Successfully spawned vehicle with body and entered');
        return result;
    }

    /**
     * Lay out a starting grid along a circular track loop. Each slot has a
     * position on the loop and a heading tangent to the loop at that position.
     *
     * Solves two common bugs at once:
     *   - Cars stacked behind a straight start line drop onto whatever terrain
     *     is south of the loop, not the asphalt ring.
     *   - A single shared yaw points every car the wrong way at every position
     *     except one — the correct tangent varies around the loop.
     *
     * Angle convention matches the typical waypoint loop:
     *     position = center + radius * (cos angle, sin angle) in XZ.
     * `travel: 'ccw'` means angle DECREASES over the lap (same convention used
     * by the example race manager). The slot at index 0 is at `startAngle`;
     * subsequent slots are offset BACKWARDS along travel so the leader is in
     * front. Even/odd slots take inner/outer lanes for a 2-wide grid.
     *
     * @example
     *     const grid = spawner.layoutGridOnLoop({
     *         center: { x: 30, z: 0 }, radius: 18, travel: 'ccw',
     *         startAngle: -Math.PI / 2,   // start point: z = -radius
     *         slots: 5, laneOffset: 1.5, slotSpacing: 4,
     *     });
     *     for (const slot of grid) {
     *         spawner.spawnVehicle(slot.position, config, undefined, slot.heading);
     *     }
     */
    public layoutGridOnLoop(opts: {
        center: { x: number; z: number };
        radius: number;
        travel: 'cw' | 'ccw';
        startAngle: number;
        slots: number;
        laneOffset: number;
        slotSpacing: number;
    }): Array<{ position: { x: number; z: number }; heading: number }> {
        const { center, radius, travel, startAngle, slots, laneOffset, slotSpacing } = opts;
        // 'ccw' travel = angle decreases over the lap, matching the standard
        // waypoint convention: position = center + radius * (cos a, sin a).
        const angularStep = (slotSpacing / radius) * (travel === 'ccw' ? -1 : 1);
        const out: Array<{ position: { x: number; z: number }; heading: number }> = [];
        for (let i = 0; i < slots; i++) {
            const row = Math.floor(i / 2);
            const lane = i % 2 === 0 ? -laneOffset : laneOffset;
            const angle = startAngle - row * angularStep; // -step: slots BEHIND leader
            const r = radius + lane;
            const position = {
                x: center.x + Math.cos(angle) * r,
                z: center.z + Math.sin(angle) * r,
            };
            out.push({ position, heading: headingTangent(center, position, travel) });
        }
        return out;
    }

    /**
     * Spawn a vehicle from an imported VEHICLE ASSET (a GLB carrying the
     * `bmVehicle` extension, voxelized or GLB-native). The asset's fitment
     * drives everything: platform width/length, wheel positions/radii,
     * mass, handling, collision boxes; visuals come from the asset body +
     * its BM_wheel_* nodes (or parametric wheels).
     *
     * Spawns EXACTLY at the requested X/Z (only ground height is resolved) —
     * see spawnVehicle for the placement + parking-brake contract.
     *
     * Async because the asset visual is fetched first — await before use.
     */
    public async spawnFromAsset(
        xz: { x: number; z: number },
        assetIdOrName: string,
        options: SpawnFromAssetOptions = DEFAULT_SPAWN_FROM_ASSET_OPTIONS,
    ): Promise<{ vehicle: Vehicle; platform: VehiclePlatformStructure } | null> {
        const engine = this.spawner.getEngine();
        const assets = engine.getGameData?.()?.assets;
        const asset = assets?.find((a) => a.id === assetIdOrName)
            ?? assets?.find((a) => a.name === assetIdOrName)
            ?? null;
        if (!asset) {
            console.warn(`VehicleSpawner.spawnFromAsset: no asset with id or name '${assetIdOrName}' in gameData.assets`);
            return null;
        }
        const fitment = asset.vehicleFitment;
        if (!fitment || fitment.axles.length === 0) {
            console.warn(`VehicleSpawner.spawnFromAsset: asset '${asset.name}' has no vehicleFitment — import a GLB with bmVehicle scene extras, or use spawnVehicle for platform vehicles`);
            return null;
        }
        if (!engine.physicsWorld) {
            console.error('VehicleSpawner.spawnFromAsset: no physics world');
            return null;
        }

        let visual;
        try {
            visual = await loadVehicleAssetVisual(engine, asset, fitment);
        } catch (error) {
            console.error(`VehicleSpawner.spawnFromAsset: failed to load visuals for '${asset.name}':`, error);
            return null;
        }

        // Chassis frame: the asset origin (body ground-center) sits on the
        // platform top; connection points are placed so wheels line up with
        // the authored axles at suspension equilibrium.
        const bodyMinY = fitment.bodyBounds.min[1];
        const topSurfaceY = VehiclePlatformBuilder.PLATFORM_HEIGHT / 2;
        const wheelConfigs: WheelConfig[] = [];
        const wheelMeshes: THREE.Mesh[] = [];
        for (const axle of fitment.axles) {
            const rest = Math.min(Math.max(axle.radius * 1.8, 0.2), 0.6);
            const connY = (axle.y - bodyMinY) + topSurfaceY + rest * EQ_SUSPENSION_LENGTH_FRACTION;
            for (const side of [1, -1] as const) {
                wheelConfigs.push(createWheelConfig(
                    new THREE.Vector3((side * axle.track) / 2, connY, axle.z),
                    {
                        radius: axle.radius,
                        width: axle.width,
                        suspensionRestLength: rest,
                        isDriven: axle.driven,
                        isSteering: axle.steering,
                    },
                ));
                wheelMeshes.push(wheelMeshForAxleSide(visual, axle, side));
            }
        }

        const renderer = new AssetVehicleRenderer({
            chassisObject: visual.chassisObject,
            bodyLiftY: topSurfaceY,
            wheelMeshes,
        });

        const mass = fitment.mass;
        const vehicleConfig: VehicleConfig = {
            chassisSize: {
                width: fitment.platform.width,
                height: VehiclePlatformBuilder.PLATFORM_HEIGHT,
                length: fitment.platform.length,
            },
            mass,
            engineForce: mass * 1.5, // platform default rule; tip-over guard caps it live
            centerOfMassOffset: 0.4,
            wheels: wheelConfigs,
            position: new THREE.Vector3(),
            spawnRotation: options.spawnRotation,
            renderer,
            ...(fitment.handling ? { handling: fitment.handling } : {}),
        };

        // Spawn height: no axle may start embedded (same math as spawnVehicle).
        const heightOffset = VehicleSpawner.spawnHeightOffset(wheelConfigs, 0);
        const spawnPosition = this.spawner.calculateSpawnPosition(xz, heightOffset);
        if (!spawnPosition) {
            console.error(`VehicleSpawner.spawnFromAsset: no ground at (${xz.x}, ${xz.z})`);
            return null;
        }
        vehicleConfig.position = spawnPosition;

        const vehicle = this.vehicleManager.createVehicle(vehicleConfig);

        // Collision boxes above the slab (asset frame → chassis frame). Mass
        // redistribution spreads config.mass over slab + boxes as usual.
        const bodyParts: VehicleBodyPart[] = fitment.collisionBoxes.map((box) => ({
            position: new THREE.Vector3(
                box.position.x,
                box.position.y - bodyMinY + topSurfaceY,
                box.position.z,
            ),
            size: { width: box.size.x, height: box.size.y, length: box.size.z },
        }));
        vehicle.addBodyPhysicsBatch(bodyParts);

        const platform: VehiclePlatformStructure = {
            vehicleConfig,
            platformWidth: fitment.platform.width,
            platformLength: fitment.platform.length,
            platformHeight: VehiclePlatformBuilder.PLATFORM_HEIGHT,
            wheelConfigs,
            wheelPositions: wheelConfigs.map((wc) => wc.position.clone()),
            maxWheelRadius: Math.max(...wheelConfigs.map((wc) => wc.radius)),
            topSurfaceY,
            wheelRadius: wheelConfigs[0]?.radius ?? 0.3,
            wheelWidth: wheelConfigs[0]?.width ?? 0.2,
        };
        console.log(`✅ VehicleSpawner: spawned vehicle asset '${asset.name}' (${fitment.axles.length} axles, ${mass.toFixed(0)} kg)`);
        return { vehicle, platform };
    }

    /**
     * spawnFromAsset + put the player in the driver's seat. The from-asset
     * counterpart of spawnAndEnter (no body-builder step — the asset IS the
     * body).
     */
    public async spawnAndEnterFromAsset(
        xz: { x: number; z: number },
        assetIdOrName: string,
        playerController: PlayerController,
        options: SpawnFromAssetOptions = DEFAULT_SPAWN_FROM_ASSET_OPTIONS,
    ): Promise<{ vehicle: Vehicle; platform: VehiclePlatformStructure } | null> {
        const result = await this.spawnFromAsset(xz, assetIdOrName, options);
        if (!result) return null;
        const entered = playerController.enterVehicle(result.vehicle);
        if (!entered) {
            console.warn('VehicleSpawner.spawnAndEnterFromAsset: spawned but could not enter — returning the vehicle anyway');
        }
        return result;
    }

    /**
     * Get the underlying generic Spawner for advanced usage
     */
    public getSpawner(): Spawner {
        return this.spawner;
    }

    /**
     * Get the VehicleManager instance
     */
    public getVehicleManager(): VehicleManager {
        return this.vehicleManager;
    }
}
