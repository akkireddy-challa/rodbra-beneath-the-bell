import * as THREE from 'three';
import { AnimalController, createAnimal } from 'engine/animal/AnimalController.js';
import type { IBlockCharacterFactory } from 'engine/IBlockCharacterFactory.js';
import type { EngineLike } from 'types/game.js';
import type { ChunkManagedObject } from 'engine/ChunkPhysicsManager.js';
import { AnimalMediumSensor } from 'engine/animal/AnimalMediumSensor.js';
import { getGlobalLodScheduler, type LodManagedCharacter } from 'engine/character/CharacterLodScheduler.js';
import { queryPhysicsFor } from 'engine/physics/PlaneLockedPhysics.js';

/**
 * Structural check for the CharacterLodScheduler contract. AnimalController and
 * SnakeController implement it; custom RegistrableCreature classes from shipped
 * game code may not — those simply run un-scheduled (always-full behavior).
 */
function asLodManaged(creature: object): LodManagedCharacter | null {
    const c = creature as Partial<LodManagedCharacter>;
    if (typeof c.getPosition === 'function'
        && typeof c.getImportance === 'function'
        && typeof c.isDeadOrRagdolled === 'function'
        && typeof c.hasActiveGoal === 'function'
        && c.lodState !== undefined) {
        return creature as LodManagedCharacter;
    }
    return null;
}

/** Default cruise altitude (m) above terrain for bulk-spawned flying creatures. */
const BULK_FLIGHT_SPAWN_ALTITUDE = 8;

/**
 * Minimal interface for any creature (snake, animal, etc.) that the registry
 * can auto-update each frame. Both AnimalController and SnakeController
 * satisfy this interface.
 */
export interface RegistrableCreature extends ChunkManagedObject {
    update(deltaTime: number): void;
    dispose(): void;
    isHibernating(): boolean;
    getCharacter(): THREE.Object3D;
    getPosition(): THREE.Vector3;
    voxelBlockSize: number;
    onDeathEffect?: ((killerDirection?: THREE.Vector3) => void);
}

/**
 * AnimalRegistry - Manages multiple animals with automatic updates
 * 
 * ════════════════════════════════════════════════════════════════════════════════
 * 🐕 THIS IS FOR ANIMALS (4-LEGGED CREATURES)
 * ════════════════════════════════════════════════════════════════════════════════
 * 
 * Use this to manage multiple animals and automatically update them.
 * 
 */

/**
 * Callback signature for animal death events
 * @param animalId - The registry ID of the animal that died
 * @param animalType - The type of animal (e.g., 'Buffalo', 'Wolf')
 * @param position - The world position where the animal died
 */
export type AnimalDeathCallback = (animalId: string, animalType: string, position: THREE.Vector3) => void;

export class AnimalRegistry {
    private animals: Map<string, AnimalController> = new Map();
    private creatures: Map<string, RegistrableCreature> = new Map();
    private engine: EngineLike;
    private static idCounter: number = 0;
    
    // Voxel block size for step climbing (applied to all registered animals)
    private _voxelBlockSize: number = 1.0;
    
    /**
     * Callback triggered when ANY animal in this registry dies.
     * This is the easiest way to track kills for quests, scoring, etc.
     */
    public onAnimalDeath?: AnimalDeathCallback;

    constructor(engine: EngineLike) {
        this.engine = engine;
    }

    /**
     * Wrap an animal's onDeathEffect to also trigger the registry-level callback.
     */
    private wrapDeathEffect(animal: AnimalController, id: string, animalType: string): void {
        const originalDeathEffect = animal.onDeathEffect;
        animal.onDeathEffect = (killerDirection?: THREE.Vector3) => {
            originalDeathEffect?.(killerDirection);
            if (this.onAnimalDeath) {
                const position = animal.getCharacter().position.clone();
                this.onAnimalDeath(id, animalType, position);
            }
        };
    }

    /**
     * Register an animal for automatic updates and death tracking
     *
     * When an animal is registered, its `onDeathEffect` is automatically wrapped
     * to trigger the registry's `onAnimalDeath` callback (if set).
     *
     * @param name - Unique name for this animal (e.g., 'dog', 'wolf', 'pet')
     * @param animal - The AnimalController instance
     */
    register(name: string, animal: AnimalController): void {
        if (this.animals.has(name)) {
            console.warn(`⚠️ [AnimalRegistry] Animal '${name}' already registered, replacing`);
        }

        this.wrapDeathEffect(animal, name, animal.getAnimalType());
        this.animals.set(name, animal);
        
        // Apply voxel block size for step climbing
        animal.voxelBlockSize = this._voxelBlockSize;

        // Register with DynamicObjectManager for chunk-based hibernation
        this.engine.getDynamicObjectManager?.()?.register(animal, 'animal');

        // Register with the character LOD scheduler (idempotent; the controller
        // unregisters itself in dispose()).
        getGlobalLodScheduler().registerCharacter(animal);
    }
    
    /**
     * Set the voxel block size for step climbing on all animals
     * Call this after setting up the world generator to use the level's voxel size
     */
    setVoxelBlockSize(size: number): void {
        this._voxelBlockSize = size;
        for (const animal of this.animals.values()) {
            animal.voxelBlockSize = size;
        }
        for (const creature of this.creatures.values()) {
            creature.voxelBlockSize = size;
        }
    }
    
    /**
     * Register any creature (snake, custom controller, etc.) for automatic updates.
     * The creature must implement RegistrableCreature (update, dispose, isHibernating, etc.).
     *
     * This is used by createSnake() to auto-register snakes with the engine.
     */
    registerCreature(name: string, creature: RegistrableCreature): void {
        if (this.creatures.has(name)) {
            console.warn(`⚠️ [AnimalRegistry] Creature '${name}' already registered, replacing`);
        }
        this.creatures.set(name, creature);
        creature.voxelBlockSize = this._voxelBlockSize;
        this.engine.getDynamicObjectManager?.()?.register(creature, 'creature');

        // Register with the character LOD scheduler when the creature satisfies
        // the contract (SnakeController does; custom creatures may not).
        const lodManaged = asLodManaged(creature);
        if (lodManaged) {
            getGlobalLodScheduler().registerCharacter(lodManaged);
        }
    }

    /**
     * Spawn multiple animals at once
     * 
     * @param animalType - Name for this animal type (for logging/identification)
     * @param count - Number of animals to spawn
     * @param factory - Block character factory from createBlockAnimalFactory()
     * @param positions - Optional array of {x, z} positions. Random if not provided.
     * @returns Array of spawned animal IDs
     */
    async spawnMany(
        animalType: string,
        count: number,
        factory: IBlockCharacterFactory,
        positions?: Array<{ x: number; z: number }>
    ): Promise<string[]> {
        const physicsWorld = queryPhysicsFor(this.engine);
        if (!this.engine.scene || !physicsWorld) {
            console.error('❌ [AnimalRegistry] Cannot spawn - scene or physics not ready');
            return [];
        }
        
        const ids: string[] = [];
        console.log(`🐾 [AnimalRegistry] Spawning ${count} ${animalType}s...`);

        // Get world size from game data (fallback to 100x100 if not available)
        const gameData = this.engine.getGameData?.();
        const worldSizeX = gameData?.worldProfileData?.groundWorldSizeX ?? 100;
        const worldSizeZ = gameData?.worldProfileData?.groundWorldSizeZ ?? 100;
        const halfWorldX = worldSizeX / 2;
        const halfWorldZ = worldSizeZ / 2;

        // Fish/birds aren't ground creatures: ground-snapping (or skipping a
        // water/air cell as "no valid position") would beach them. Resolve a
        // medium-correct Y instead — a submerged point for swimmers, an
        // altitude band above terrain for fliers.
        const locomotionMode = factory.getLocomotionMode?.() ?? 'ground';
        const mediumSensor = locomotionMode === 'ground' ? null : new AnimalMediumSensor(this.engine);

        for (let i = 0; i < count; i++) {
            const pos = positions?.[i];
            const rawX = pos?.x ?? (Math.random() * worldSizeX - halfWorldX);
            const rawZ = pos?.z ?? (Math.random() * worldSizeZ - halfWorldZ);

            let spawnPos: THREE.Vector3;
            if (locomotionMode === 'swim') {
                // Spawn at mid-depth of the water column here, or skip if dry.
                const submergedY = mediumSensor!.findSubmergedY(rawX, rawZ);
                if (submergedY === null) {
                    console.warn(`⚠️ [AnimalRegistry] Skipping ${animalType} spawn at (${rawX.toFixed(1)}, ${rawZ.toFixed(1)}) - no water there`);
                    continue;
                }
                spawnPos = new THREE.Vector3(rawX, submergedY, rawZ);
            } else if (locomotionMode === 'fly') {
                // Spawn in the air, a cruise altitude above the terrain.
                const groundY = mediumSensor!.getTerrainHeightAt(rawX, rawZ)
                    ?? this.engine.getWorldHeightAt?.(rawX, rawZ) ?? 0;
                spawnPos = new THREE.Vector3(rawX, groundY + BULK_FLIGHT_SPAWN_ALTITUDE, rawZ);
            } else if (this.engine.findValidVoxelSpawnPosition) {
                // Ground creatures: voxel-aware snapping and validation.
                const validPos = this.engine.findValidVoxelSpawnPosition(rawX, rawZ)
                    ?? this.findBakedGroundPosition(rawX, rawZ);
                if (validPos) {
                    spawnPos = validPos;
                } else {
                    // Position invalid (blocked, out of bounds, etc.) - skip this spawn
                    console.warn(`⚠️ [AnimalRegistry] Skipping spawn at (${rawX.toFixed(1)}, ${rawZ.toFixed(1)}) - no valid position found`);
                    continue;
                }
            } else if (this.engine.getWorldHeightAt) {
                spawnPos = new THREE.Vector3(rawX, this.engine.getWorldHeightAt(rawX, rawZ), rawZ);
            } else {
                spawnPos = new THREE.Vector3(rawX, 0, rawZ);
            }

            try {
                const animal = await createAnimal(
                    this.engine.scene,
                    physicsWorld,
                    this.engine,
                    spawnPos,
                    animalType,
                    3.0,
                    factory
                );
                
                const id = `${animalType}_${AnimalRegistry.idCounter++}`;
                this.wrapDeathEffect(animal, id, animalType);
                this.animals.set(id, animal);
                ids.push(id);

                // Register with DynamicObjectManager for chunk-based hibernation
                this.engine.getDynamicObjectManager?.()?.register(animal, 'animal');

                // Register with the character LOD scheduler (idempotent —
                // createAnimal's auto-registration may already have done it).
                getGlobalLodScheduler().registerCharacter(animal);
            } catch (error) {
                console.error(`❌ [AnimalRegistry] Failed to spawn ${animalType} #${i}:`, error);
            }
        }
        
        console.log(`✅ [AnimalRegistry] Spawned ${ids.length}/${count} ${animalType}s`);
        return ids;
    }

    /**
     * Ground fallback for baked (.vwld) levels, where findValidVoxelSpawnPosition has no
     * voxel grid to query and returns null for EVERY column — without this, bulk animal
     * spawns are skipped wholesale on World-Forger levels. Resolves ground with the
     * Spawner's physics finding instead (raycast + isOpenArea keeps animals out of
     * building/wall pockets). Gated on a baked level (voxelUrl) so procedural worlds
     * still honour a genuine "no valid position" verdict from the voxel finder.
     * Mirrors the NPC-side fallback in NpcManager.findSpawnPosition.
     */
    private findBakedGroundPosition(x: number, z: number): THREE.Vector3 | null {
        if (!this.engine.getGameData?.()?.worldProfileData?.voxelUrl) return null;
        const spawner = this.engine.getSpawner?.();
        if (!spawner || !spawner.isOpenArea(x, z)) return null;
        const groundY = spawner.getGroundHeight(x, z);
        return groundY !== null ? new THREE.Vector3(x, groundY, z) : null;
    }


    /**
     * Iterate over all animals (for custom operations)
     */
    forEach(callback: (animal: AnimalController, id: string) => void): void {
        for (const [id, animal] of this.animals.entries()) {
            callback(animal, id);
        }
    }
    
    /**
     * Get all animals as an array
     */
    getAll(): AnimalController[] {
        return Array.from(this.animals.values());
    }

    /**
     * Unregister an animal (does NOT dispose it)
     * 
     * @param name - Name of the animal to unregister
     */
    unregister(name: string): void {
        const animal = this.animals.get(name);
        if (animal) {
            this.engine.getDynamicObjectManager?.()?.unregister(animal);
            this.animals.delete(name);
        }
    }

    /**
     * Get a registered animal by name
     * 
     * @param name - Name of the animal
     * @returns The AnimalController or undefined if not found
     */
    get(name: string): AnimalController | undefined {
        return this.animals.get(name);
    }

    /**
     * Check if an animal is registered
     * 
     * @param name - Name of the animal
     */
    has(name: string): boolean {
        return this.animals.has(name);
    }

    /**
     * Get all registered animal names
     */
    getNames(): string[] {
        return Array.from(this.animals.keys());
    }

    /**
     * Get the count of registered animals
     */
    get count(): number {
        return this.animals.size + this.creatures.size;
    }

    /**
     * Update all registered animals - call this every frame!
     * 
     * Automatically checks projectile collisions after updating.
     * 
     * @param deltaTime - Time since last frame
     */
    updateAll(deltaTime: number): void {
        const dynamicObjMgr = this.engine.getDynamicObjectManager?.();
        const updateOne = (kind: string, name: string, obj: RegistrableCreature): void => {
            if (obj.isHibernating()) return;
            try {
                obj.update(deltaTime);
                dynamicObjMgr?.updatePosition(obj);
            } catch (error) {
                console.error(`❌ [AnimalRegistry] Error updating ${kind} '${name}':`, error);
            }
        };
        for (const [name, animal] of this.animals.entries()) updateOne('animal', name, animal);
        for (const [name, creature] of this.creatures.entries()) updateOne('creature', name, creature);
    }

    /**
     * Dispose all registered animals and clear the registry
     */
    disposeAll(): void {
        const dynamicObjMgr = this.engine.getDynamicObjectManager?.();
        const disposeOne = (kind: string, name: string, obj: RegistrableCreature): void => {
            try {
                dynamicObjMgr?.unregister(obj);
                obj.dispose();
            } catch (error) {
                console.error(`❌ [AnimalRegistry] Error disposing ${kind} '${name}':`, error);
            }
        };
        for (const [name, animal] of this.animals.entries()) disposeOne('animal', name, animal);
        this.animals.clear();
        for (const [name, creature] of this.creatures.entries()) disposeOne('creature', name, creature);
        this.creatures.clear();
    }
}

