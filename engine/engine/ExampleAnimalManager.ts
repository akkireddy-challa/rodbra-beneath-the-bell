/**
 * ════════════════════════════════════════════════════════════════════════════════
 * EXAMPLE ANIMAL MANAGER - Copy and modify for your game!
 * ════════════════════════════════════════════════════════════════════════════════
 * 
 * This template demonstrates best practices for:
 * - Creating animals from block configurations
 * - Spawning animals with customization
 * - Blood/gore effects on hit and death
 * - Quest tracking integration
 * - Proper lifecycle management (update, dispose)
 * 
 * @see BlockAnimalBodyBuilder.ts for BlockAnimalBodyConfig interface
 * 
 * ════════════════════════════════════════════════════════════════════════════════
 */

import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import { createAnimal, AnimalRegistry, createBlockAnimalFactory, type BlockAnimalBodyConfig } from 'engine/animal/index.js';
import { Spawner } from 'engine/Spawner.js';
import type { AnimalController } from 'engine/animal/AnimalController.js';
import type { IBlockCharacterFactory } from 'engine/IBlockCharacterFactory.js';

/**
 * Example block configuration for a dog
 * Customize colors, sizes, and proportions as needed
 */
const DOG_CONFIG: BlockAnimalBodyConfig = {
    bodyBlocks: [
        { position: { x: 0, y: 0, z: 0 }, size: { width: 0.3, height: 0.25, depth: 0.5 }, color: 0x8B4513 },
    ],
    headBlocks: [
        { position: { x: 0, y: 0, z: 0 }, size: { width: 0.2, height: 0.18, depth: 0.2 }, color: 0xA0522D },
        // Ears
        { position: { x: -0.08, y: 0.1, z: 0 }, size: { width: 0.04, height: 0.08, depth: 0.03 }, color: 0x8B4513 },
        { position: { x: 0.08, y: 0.1, z: 0 }, size: { width: 0.04, height: 0.08, depth: 0.03 }, color: 0x8B4513 },
    ],
    // headAttachment, tailAttachment, legAttachments are now auto-calculated!
    tailBlocks: [
        { position: { x: 0, y: 0, z: -0.1 }, size: { width: 0.04, height: 0.04, depth: 0.2 }, color: 0x8B4513 },
    ],
    frontLeftLegBlocks: [{ position: { x: 0, y: -0.1, z: 0 }, size: { width: 0.06, height: 0.2, depth: 0.06 }, color: 0x8B4513 }],
    frontRightLegBlocks: [{ position: { x: 0, y: -0.1, z: 0 }, size: { width: 0.06, height: 0.2, depth: 0.06 }, color: 0x8B4513 }],
    backLeftLegBlocks: [{ position: { x: 0, y: -0.1, z: 0 }, size: { width: 0.06, height: 0.2, depth: 0.06 }, color: 0x8B4513 }],
    backRightLegBlocks: [{ position: { x: 0, y: -0.1, z: 0 }, size: { width: 0.06, height: 0.2, depth: 0.06 }, color: 0x8B4513 }],
};

/**
 * Example block configuration for a cow
 */
const COW_CONFIG: BlockAnimalBodyConfig = {
    bodyBlocks: [
        { position: { x: 0, y: 0, z: 0 }, size: { width: 0.5, height: 0.4, depth: 0.8 }, color: 0x111111 },
        // White spots
        { position: { x: 0.15, y: 0.1, z: 0.1 }, size: { width: 0.15, height: 0.15, depth: 0.2 }, color: 0xFFFFFF },
        { position: { x: -0.1, y: 0.05, z: -0.15 }, size: { width: 0.12, height: 0.12, depth: 0.15 }, color: 0xFFFFFF },
    ],
    headBlocks: [
        { position: { x: 0, y: 0, z: 0 }, size: { width: 0.25, height: 0.22, depth: 0.25 }, color: 0xFFFFFF },
        // Horns
        { position: { x: -0.12, y: 0.12, z: 0 }, size: { width: 0.04, height: 0.1, depth: 0.04 }, color: 0xD2B48C },
        { position: { x: 0.12, y: 0.12, z: 0 }, size: { width: 0.04, height: 0.1, depth: 0.04 }, color: 0xD2B48C },
    ],
    // headAttachment, tailAttachment, legAttachments are now auto-calculated!
    tailBlocks: [
        { position: { x: 0, y: 0, z: -0.15 }, size: { width: 0.03, height: 0.03, depth: 0.3 }, color: 0x111111 },
    ],
    frontLeftLegBlocks: [{ position: { x: 0, y: -0.15, z: 0 }, size: { width: 0.08, height: 0.3, depth: 0.08 }, color: 0x111111 }],
    frontRightLegBlocks: [{ position: { x: 0, y: -0.15, z: 0 }, size: { width: 0.08, height: 0.3, depth: 0.08 }, color: 0x111111 }],
    backLeftLegBlocks: [{ position: { x: 0, y: -0.15, z: 0 }, size: { width: 0.08, height: 0.3, depth: 0.08 }, color: 0x111111 }],
    backRightLegBlocks: [{ position: { x: 0, y: -0.15, z: 0 }, size: { width: 0.08, height: 0.3, depth: 0.08 }, color: 0x111111 }],
};

/**
 * Map of animal types to their configurations
 */
const ANIMAL_CONFIGS: Record<string, BlockAnimalBodyConfig> = {
    'Dog': DOG_CONFIG,
    'Cow': COW_CONFIG,
};

/**
 * Configuration options for this manager
 */
export interface ExampleAnimalManagerConfig {
    /** Animal types to spawn (must have matching config in ANIMAL_CONFIGS) */
    animalTypes?: string[];
    /** Number of each animal type to spawn */
    countPerType?: number;
    /** World bounds for spawn area */
    worldBounds?: number;
    /** Whether animals die in one hit */
    oneHitKill?: boolean;
    /** Whether to show blood effects */
    bloodEffects?: boolean;
    /** Whether to show death explosion */
    deathExplosion?: boolean;
}

const DEFAULT_CONFIG: Required<ExampleAnimalManagerConfig> = {
    animalTypes: ['Dog', 'Cow'],
    countPerType: 3,
    worldBounds: 50,
    oneHitKill: false,
    bloodEffects: true,
    deathExplosion: true,
};

/**
 * Example manager that creates and manages a herd of animals.
 * Copy and customize for your game!
 */
export class ExampleAnimalManager {
    private registry: AnimalRegistry;
    private config: Required<ExampleAnimalManagerConfig>;
    private spawner: Spawner;
    private engine: EngineLike;
    private factories: Map<string, IBlockCharacterFactory> = new Map();

    constructor(engine: EngineLike, config?: ExampleAnimalManagerConfig) {
        this.engine = engine;
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.registry = new AnimalRegistry(engine);
        this.spawner = new Spawner(engine);
        
        // Pre-create factories for each animal type
        for (const type of this.config.animalTypes) {
            const animalConfig = ANIMAL_CONFIGS[type];
            if (animalConfig) {
                this.factories.set(type, createBlockAnimalFactory(animalConfig));
            } else {
                console.warn(`[ExampleAnimalManager] No config for animal type: ${type}`);
            }
        }
    }

    /**
     * Spawn all configured animals
     */
    async spawnAll(): Promise<void> {
        for (const animalType of this.config.animalTypes) {
            const factory = this.factories.get(animalType);
            if (!factory) continue;
            
            for (let i = 0; i < this.config.countPerType; i++) {
                await this.spawnSingleAnimal(animalType, factory, i);
            }
        }
        
        console.log(`✅ [ExampleAnimalManager] Spawned ${this.registry.count} animals`);
    }

    /**
     * Spawn a single animal with all configured effects
     */
    private async spawnSingleAnimal(animalType: string, factory: IBlockCharacterFactory, index: number): Promise<void> {
        try {
            const spawnPos = this.getRandomSpawnPosition();
            const moveSpeed = 3.0 + Math.random() * 2.0;

            // Create the animal using the block factory
            const animal = await createAnimal(
                this.engine.scene!,
                this.engine.physicsWorld!,
                this.engine,
                spawnPos,
                animalType,
                moveSpeed,
                factory
            );

            // Configure animal behavior
            animal.configure({
                oneHitKill: this.config.oneHitKill,
                bloodOnHit: this.config.bloodEffects,
                explodeWithGore: this.config.deathExplosion,
            });

            // Register in the registry
            const id = `${animalType}_${index}`;
            this.registry.register(id, animal);

        } catch (error) {
            console.error(`[ExampleAnimalManager] Failed to spawn ${animalType}:`, error);
        }
    }

    /**
     * Get a random spawn position within world bounds
     */
    private getRandomSpawnPosition(): THREE.Vector3 {
        const bounds = this.config.worldBounds;
        const x = (Math.random() - 0.5) * bounds * 2;
        const z = (Math.random() - 0.5) * bounds * 2;
        
        // Try to use voxel-aware spawning first
        if (this.engine.findValidVoxelSpawnPosition) {
            const validPos = this.engine.findValidVoxelSpawnPosition(x, z);
            if (validPos) return validPos;
        }
        
        // Fall back to heightmap
        const y = this.engine.getWorldHeightAt?.(x, z) ?? 0;
        return new THREE.Vector3(x, y, z);
    }

    /**
     * Update all animals - call every frame!
     */
    update(deltaTime: number): void {
        this.registry.updateAll(deltaTime);
    }

    /**
     * Clean up all animals
     */
    dispose(): void {
        this.registry.disposeAll();
    }

    /**
     * Get the underlying registry for advanced operations
     */
    getRegistry(): AnimalRegistry {
        return this.registry;
    }

    /**
     * Add a custom animal configuration
     */
    addAnimalConfig(name: string, config: BlockAnimalBodyConfig): void {
        ANIMAL_CONFIGS[name] = config;
        this.factories.set(name, createBlockAnimalFactory(config));
    }
}
