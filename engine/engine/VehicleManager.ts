import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import { Vehicle, type VehicleConfig } from 'engine/Vehicle.js';
import { CollisionMask } from 'engine/CollisionLayers.js';

/**
 * VehicleManager - Manages all vehicles in the game world.
 * 
 * Note: Vehicle creation now uses the platform-based system via VehicleSpawner.
 * Use VehicleSpawner.spawnVehicle() to create vehicles with the new API.
 * 
 * Vehicles are updated during each physics substep via registerPreStepCallback
 * to ensure proper frame-rate independent physics behavior.
 */
export class VehicleManager {
    private engine: EngineLike;
    private vehicles: Vehicle[] = [];
    private activeVehicle: Vehicle | null = null;
    private physicsStepCallback: ((dt: number) => void) | null = null;
    private postStepCaptureCallback: (() => void) | null = null;

    constructor(engine: EngineLike) {
        this.engine = engine;

        // Register callback for physics substep updates
        this.physicsStepCallback = (dt: number) => this.physicsStepUpdate(dt);
        // Post-step: snapshot each vehicle's chassis pose after every substep so
        // visualUpdate() can render it interpolated (fixed-timestep judder fix —
        // see RapierVehicle.captureInterpolationState).
        this.postStepCaptureCallback = () => this.physicsPostStep();
        if (this.engine.physicsWorld) {
            this.engine.physicsWorld.registerPreStepCallback(this.physicsStepCallback);
            this.engine.physicsWorld.registerPostStepCallback(this.postStepCaptureCallback);
        }
    }

    /**
     * Called during each physics substep - updates all vehicle physics
     */
    private physicsStepUpdate(dt: number): void {
        for (const vehicle of this.vehicles) {
            if (vehicle.isHibernating()) continue;
            vehicle.physicsUpdate(dt);
        }
    }

    /**
     * Called after each physics substep - snapshots chassis poses for render
     * interpolation (runs per substep, so the prev/cur pair brackets the two most
     * recent substeps regardless of how many ran this frame).
     */
    private physicsPostStep(): void {
        for (const vehicle of this.vehicles) {
            if (vehicle.isHibernating()) continue;
            vehicle.captureInterpolationState();
        }
    }
    
    /**
     * Create a new vehicle and add it to the world.
     * 
     * Note: For creating vehicles, use VehicleSpawner.spawnVehicle() which
     * provides the platform-based API with automatic ground detection.
     */
    public createVehicle(config: VehicleConfig): Vehicle {
        const vehicle = new Vehicle(this.engine, config);
        this.vehicles.push(vehicle);
        
        // Register with DynamicObjectManager for chunk-based hibernation
        this.engine.getDynamicObjectManager?.()?.register(vehicle, 'vehicle', 3.0);
        return vehicle;
    }
    
    /**
     * Update all vehicles (visual sync and cleanup, called once per frame)
     * Note: Physics updates happen via physicsStepUpdate during each physics substep
     */
    public update(): void {
        // Track vehicles to remove (can't modify array while iterating)
        const vehiclesToRemove: Vehicle[] = [];
        const dynamicObjMgr = this.engine.getDynamicObjectManager?.();
        
        for (const vehicle of this.vehicles) {
            if (vehicle.isHibernating()) continue;
            
            // Visual sync only - physics is handled in physicsStepUpdate
            vehicle.visualUpdate();
            
            // Update chunk registration for moving vehicles (especially the active one)
            // This prevents vehicles from hibernating when they move to new chunks
            if (dynamicObjMgr) {
                dynamicObjMgr.updatePosition(vehicle);
            }
            
            // Check if vehicle has fallen below -100 (out of world)
            const vehicleY = vehicle.getPosition().y;
            if (vehicleY < -100) {
                // Skip active vehicle - PlayerController.respawnAtStart() will handle it
                // when it detects player Y < -100 (player position is synced in Vehicle.update())
                if (vehicle !== this.activeVehicle) {
                    console.log(`[VehicleManager] Unmanned vehicle fell out of world (y=${vehicleY.toFixed(1)}), destroying...`);
                    vehiclesToRemove.push(vehicle);
                }
            }
        }
        
        // Remove fallen vehicles
        for (const vehicle of vehiclesToRemove) {
            this.removeVehicle(vehicle);
        }
    }
    
    /**
     * Find the nearest vehicle to a given position
     */
    public findNearestVehicle(position: THREE.Vector3, maxDistance: number = 5.0): Vehicle | null {
        let nearestVehicle: Vehicle | null = null;
        let nearestDistance = maxDistance;
        
        for (const vehicle of this.vehicles) {
            const distance = vehicle.getPosition().distanceTo(position);
            if (distance < nearestDistance) {
                nearestDistance = distance;
                nearestVehicle = vehicle;
            }
        }
        
        return nearestVehicle;
    }
    
    /**
     * Check if player can interact with any vehicle at their current position
     */
    public findInteractableVehicle(playerPosition: THREE.Vector3): Vehicle | null {
        return this.findNearestVehicle(playerPosition, 3.0);
    }
    
    /**
     * INTERNAL: Attempt to enter a vehicle - updates VehicleManager state only.
     * Called by PlayerVehicleController - do not call directly from game code.
     * Use playerController.enterVehicle(vehicle) instead.
     * @internal
     */
    public tryEnterVehicle_INTERNAL(player: unknown, playerPosition: THREE.Vector3): boolean {
        const vehicle = this.findInteractableVehicle(playerPosition);
        
        if (vehicle && vehicle.canPlayerEnter()) {
            const success = vehicle.enterVehicle_INTERNAL(player);
            if (success) {
                this.activeVehicle = vehicle;
                return true;
            }
        }
        
        return false;
    }
    
    /**
     * Exit the currently active vehicle
     */
    public exitCurrentVehicle(): unknown {
        if (this.activeVehicle) {
            const driver = this.activeVehicle.exitVehicle();
            this.activeVehicle = null;
            return driver;
        }
        return null;
    }
    
    /**
     * Get the vehicle the player is currently driving
     */
    public getActiveVehicle(): Vehicle | null {
        return this.activeVehicle;
    }

    /**
     * INTERNAL: Set the active vehicle tracking.
     * Called by PlayerVehicleController - do not call directly from game code.
     * Use playerController.enterVehicle(vehicle) instead.
     * @internal
     */
    public setActiveVehicle_INTERNAL(vehicle: Vehicle): void {
        this.activeVehicle = vehicle;
    }
    
    /**
     * Check if player is currently driving a vehicle
     */
    public isPlayerInVehicle(): boolean {
        return this.activeVehicle?.isPlayerInVehicle() ?? false;
    }
    
    /**
     * Update vehicle controls based on player input.
     *
     * `steer` is the analog steering axis (+1 full left … -1 full right) from a
     * touch pill or gamepad stick; when non-zero it positions the wheel directly
     * instead of ramping the boolean left/right (see VehicleControls.steer).
     */
    public updateVehicleControls(controls: {
        forward: boolean;
        backward: boolean;
        left: boolean;
        right: boolean;
        brake: boolean;
        steer?: number;
    }, deltaTime: number = 0.016): void {
        if (this.activeVehicle) {
            this.activeVehicle.updateControls(controls, deltaTime);
        }
    }
    
    /**
     * Get all vehicles in the world
     */
    public getAllVehicles(): Vehicle[] {
        return [...this.vehicles];
    }
    
    /**
     * Remove a vehicle from the world
     */
    public removeVehicle(vehicle: Vehicle): boolean {
        const index = this.vehicles.indexOf(vehicle);
        if (index === -1) return false;

        // If this is the active vehicle, exit it first — through the PLAYER,
        // not just our own bookkeeping. exitCurrentVehicle() alone clears
        // activeVehicle but leaves PlayerVehicleController seated: isInVehicle
        // stays true, the vehicle camera keeps targeting the chassis we are
        // about to dispose, the walking movement system is never restored and
        // the capsule body stays disabled. The next enterVehicle() then refuses
        // with "Already in a vehicle" and the camera is stranded on a dead
        // object (how a level switch used to leave the player behind).
        if (this.activeVehicle === vehicle) {
            const playerController = this.engine.getPlayerController();
            if (playerController?.isPlayerInVehicle?.()) {
                playerController.exitVehicle?.();
            }
            // Our own state must end up clear even for a controller that
            // predates exitVehicle() or reports itself as not seated.
            if (this.activeVehicle === vehicle) this.exitCurrentVehicle();
        }

        // Unregister from DynamicObjectManager
        this.engine.getDynamicObjectManager?.()?.unregister(vehicle);

        // Remove from array and dispose
        this.vehicles.splice(index, 1);
        vehicle.dispose();
        return true;
    }
    
    /**
     * Remove all vehicles and clean up
     */
    public dispose(): void {
        // Unregister physics step callbacks
        if (this.engine.physicsWorld) {
            if (this.physicsStepCallback) {
                this.engine.physicsWorld.unregisterPreStepCallback(this.physicsStepCallback);
            }
            if (this.postStepCaptureCallback) {
                this.engine.physicsWorld.unregisterPostStepCallback(this.postStepCaptureCallback);
            }
        }
        this.physicsStepCallback = null;
        this.postStepCaptureCallback = null;
        
        // Exit current vehicle if any (no-op when there is none)
        this.exitCurrentVehicle();

        // Dispose all vehicles
        const dynamicObjMgr = this.engine.getDynamicObjectManager?.();
        for (const vehicle of this.vehicles) {
            dynamicObjMgr?.unregister(vehicle);
            vehicle.dispose();
        }

        // Clear arrays
        this.vehicles = [];
        this.activeVehicle = null;
    }
    
    /**
     * Get vehicle count
     */
    public getVehicleCount(): number {
        return this.vehicles.length;
    }
    
    /**
     * Check if a position is suitable for vehicle placement (physics-based ground check)
     */
    public isValidVehiclePosition(position: THREE.Vector3): boolean {
        if (!this.engine.physicsWorld) {
            console.warn('VehicleManager: No physics world available for ground check');
            return false;
        }

        // Use physics world raycasting
        const origin = new THREE.Vector3(position.x, position.y + 2, position.z);
        const direction = new THREE.Vector3(0, -1, 0);
        const maxDistance = 4; // Check 2 units below starting point

        const result = this.engine.physicsWorld.raycast(origin, direction, maxDistance, CollisionMask.ALL);

        if (result.hasHit) {
            console.log(`VehicleManager: Found valid ground at y=${result.hitPoint.y} for position`, position);
        } else {
            console.warn(`VehicleManager: No valid ground found for position`, position);
        }

        return result.hasHit;
    }

    /**
     * Get proper ground height at a given X/Z position
     * Uses engine's getWorldHeightAt if available, otherwise uses physics raycasting
     *
     * @param x - World X coordinate
     * @param z - World Z coordinate
     * @param searchHeight - How high above to start searching (default: 100)
     * @returns Ground height Y coordinate, or null if no ground found
     */
    public getGroundHeightAt(x: number, z: number, searchHeight: number = 100): number | null {
        // Try engine's built-in method first (faster, more accurate)
        if (this.engine.getWorldHeightAt) {
            const height = this.engine.getWorldHeightAt(x, z);
            if (typeof height === 'number' && !Number.isNaN(height)) {
                return height;
            }
        }

        // Fallback to physics raycasting
        if (!this.engine.physicsWorld) {
            console.warn('VehicleManager: No physics world or getWorldHeightAt available for ground check');
            return null;
        }

        // Cast ray downward from high above the position
        const origin = new THREE.Vector3(x, searchHeight, z);
        const direction = new THREE.Vector3(0, -1, 0);
        const maxDistance = searchHeight * 2;

        const result = this.engine.physicsWorld.raycast(origin, direction, maxDistance, CollisionMask.ALL);

        if (result.hasHit) {
            return result.hitPoint.y;
        }

        return null;
    }
}
