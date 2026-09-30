// Type checking enabled
import * as THREE from 'three';
import { PhysicsTestBox } from './PhysicsTestBox.js';
import { NpcManager } from 'engine/npc/core/NpcManager.js';
import { NpcEnemyManagerBehavior } from 'engine/npc/manager-behaviors/NpcEnemyManagerBehavior.js';
import { PlacementHelper } from 'engine/PlacementHelper.js';
import { VehicleManager } from 'engine/VehicleManager.js';
import { ExampleCannon } from 'engine/ExampleCannon.js';
import { createBloodSplatterEffect } from 'engine/effects/HitEffects.js';
import { WeaponPickupManager } from 'engine/WeaponPickupManager.js';
import { WeaponPickupSystem } from 'engine/WeaponPickupSystem.js';
import { WeaponCategory } from 'engine/WeaponPickup.js';
import { WeaponType } from 'engine/WeaponRegistry.js';
import { RangedWeaponType } from 'engine/RangedWeaponTypes.js';
import { Spawner } from 'engine/Spawner.js';
import type { PlayerController } from 'engine/PlayerController.js';
import type { NpcController } from 'engine/npc/core/NpcController.js';
import type { EngineLike } from 'types/game.js';

// Player controller proxy interface
interface PlayerControllerProxy {
    player: THREE.Object3D;
    getWeaponPickupManager?: () => WeaponPickupManager | null;
}

// Engine interface for spawn manager (uses EngineLike directly)
type SpawnManagerEngine = EngineLike & {
    scene: THREE.Scene;
    getCurrentPlayer(): PlayerControllerProxy | null;
};

/**
 * Debug enemy behavior that adds voxel death effects and progressive damage visuals
 * for testing VoxelEffects.ts via F7 spawn.
 */
class DebugVoxelEnemyBehavior extends NpcEnemyManagerBehavior {
    constructor() {
        super({ autoRespawn: true, respawnDelay: 3.0 });
    }

    override onNpcCreated(npc: NpcController, engine: EngineLike): void {
        super.onNpcCreated(npc, engine);

        // One call enables death fragments + progressive damage visuals (tint, jitter, chip-off)
        npc.enableVoxelEffects({ deathVariant: 'explosion', deathFragmentCount: 16 });

        // Blood splatter on melee hit
        const scene = (engine as SpawnManagerEngine).scene;
        npc.onMeleeHitEffect = createBloodSplatterEffect(scene);

        console.log('✅ [F7 Debug] NPC spawned with VoxelEffects (death + damage visuals)');
    }
}

/**
 * Manages debug spawning functionality for test objects
 * Includes physics test box, enemies, vehicles, cannon, and placement helper
 */
export class DebugSpawnManager {
    private engine: SpawnManagerEngine;

    // Physics test box for melee testing
    private physicsTestBox: PhysicsTestBox | null;

    // NPC manager for testing (configured as enemy with auto-respawn)
    private exampleEnemyManager: NpcManager;

    // Placement helper for testing object placement
    private placementHelper: PlacementHelper;

    // Vehicle manager for debug vehicle spawning
    private vehicleManager: VehicleManager;

    // Cannon for F7 spawning test
    private cannon: ExampleCannon | null = null;

    // Weapon pickup system for debug weapon spawning (handles equipping too)
    private weaponPickupSystem: WeaponPickupSystem | null = null;
    private weaponPickupManager: WeaponPickupManager | null = null;
    private ownsWeaponPickupSystem = false;

    constructor(engine: SpawnManagerEngine) {
        this.engine = engine;

        // Physics test box for melee testing
        this.physicsTestBox = new PhysicsTestBox(engine);

        // NPC manager for testing — uses voxel death effects and damage visuals
        this.exampleEnemyManager = new NpcManager(engine, new DebugVoxelEnemyBehavior());

        // Placement helper for testing object placement
        this.placementHelper = new PlacementHelper(engine.scene);

        // Vehicle manager for debug vehicle spawning
        this.vehicleManager = new VehicleManager(engine);
    }

    /**
     * Spawn all F7 test objects (test box, enemy, vehicle, cannon)
     */
    spawnAllTestObjects(): void {
        // Get current player for position reference
        const currentPlayer = this.engine.getCurrentPlayer();
        if (!currentPlayer || !currentPlayer.player) {
            console.warn('DebugSpawnManager: No player controller available for F7 spawn');
            return;
        }

        // Get player position and rotation
        const playerPos = currentPlayer.player.position.clone();
        const playerRotation = currentPlayer.player.rotation.y;

        // Calculate perpendicular direction (90 degrees to the right of player)
        const perpRotation = playerRotation - Math.PI / 2;

        // Spawn test box at starting point plate (0, 0) - the spawn location
        this.spawnTestBox();

        // Spawn enemy 5 meters in front and 3 meters to the left of player
        const enemyX = playerPos.x + Math.sin(playerRotation) * 5.0 + Math.sin(perpRotation) * 3.0;
        const enemyZ = playerPos.z + Math.cos(playerRotation) * 5.0 + Math.cos(perpRotation) * 3.0;

        // Toggle enemy (Y position will be calculated automatically from heightmap)
        this.toggleEnemyCharacter(enemyX, enemyZ);

        // Spawn vehicle (already uses heightmap internally)
        this.spawnVehicle();

        // Spawn or despawn cannon 5 meters in front and 5 meters to the right of player
        this.toggleCannon(playerPos, playerRotation, perpRotation);

        // Spawn collectible sword and rifle near player
        this.spawnWeapons(playerPos, playerRotation, perpRotation);
    }

    /**
     * Spawn test box at origin (0, 0)
     */
    private spawnTestBox(): void {
        if (this.physicsTestBox) {
            const boxX = 0;
            const boxZ = 0;

            // Use PlacementHelper physics raycast for accurate ground height
            const groundY = this.engine.physicsWorld
                ? PlacementHelper.findGroundHeight(this.engine.physicsWorld, boxX, boxZ)
                : 0;
            const boxY = groundY + 1.25; // Center of 2.5m tall box

            const boxPosition = new THREE.Vector3(boxX, boxY, boxZ);
            this.physicsTestBox.toggle(boxPosition);
        }
    }

    /**
     * Toggle enemy character spawn/despawn
     */
    toggleEnemyCharacter(spawnX?: number, spawnZ?: number): void {
        // Fire and forget - don't block debug command execution
        this.exampleEnemyManager.toggleNpc(spawnX, spawnZ).catch((error: unknown) => {
            console.error('Failed to toggle NPC character:', error);
        });
    }

    /**
     * Spawn example enemy character
     */
    spawnEnemyCharacter(): void {
        // Fire and forget - don't block debug command execution
        this.exampleEnemyManager.spawnNpc().catch((error: unknown) => {
            console.error('Failed to spawn NPC character:', error);
        });
    }

    /**
     * Despawn example enemy character
     */
    despawnEnemyCharacter(): void {
        this.exampleEnemyManager.despawnNpc();
    }

    /**
     * Spawn a vehicle near the player
     */
    spawnVehicle(): void {
        const currentPlayer = this.engine.getCurrentPlayer();
        if (!currentPlayer || !currentPlayer.player) {
            console.warn('DebugSpawnManager: No player controller available for vehicle spawn');
            return;
        }

        // Get player position
        const playerPos = currentPlayer.player.position.clone();

        // Spawn vehicle 5 meters forward from player
        const playerRotation = currentPlayer.player.rotation.y;
        const spawnX = playerPos.x + Math.sin(playerRotation) * 5.0;
        const spawnZ = playerPos.z + Math.cos(playerRotation) * 5.0;

        // Try to use engine's VehicleSpawner first (preferred method)
        const vehicleSpawner = this.engine.getVehicleSpawner ? this.engine.getVehicleSpawner() : null;
        if (vehicleSpawner) {
            // Create platform vehicle config (width/length at top level per PlatformVehicleConfig interface)
            const carConfig = {
                width: 2,   // Platform width in meters
                length: 4,  // Platform length in meters
                color: 0xff0000 // Red
            };

            // VehicleSpawner handles ground detection and height offset automatically
            // Returns { vehicle, platform } or null
            const result = vehicleSpawner.spawnVehicle({ x: spawnX, z: spawnZ }, carConfig);

            if (result) {
                const pos = result.vehicle.getPosition();
                console.log('DebugSpawnManager: Spawned vehicle via engine VehicleSpawner at:', pos);
            } else {
                console.warn('DebugSpawnManager: Failed to spawn vehicle via VehicleSpawner (invalid position?)');
            }
            return;
        }
        console.error('DebugSpawnManager: No vehicle spawner available');
    }

    /**
     * Toggle cannon spawn/despawn
     */
    toggleCannon(playerPos: THREE.Vector3, playerRotation: number, perpRotation: number): void {
        if (this.cannon) {
            // Despawn cannon
            this.cannon.dispose();
            this.cannon = null;
            console.log('DebugSpawnManager: Despawned cannon');
        } else {
            // Spawn cannon 5 meters in front and 5 meters to the right of player
            const cannonX = playerPos.x + Math.sin(playerRotation) * 5.0 - Math.sin(perpRotation) * 5.0;
            const cannonZ = playerPos.z + Math.cos(playerRotation) * 5.0 - Math.cos(perpRotation) * 5.0;

            // Use PlacementHelper physics raycast for accurate ground height
            const groundY = this.engine.physicsWorld
                ? PlacementHelper.findGroundHeight(this.engine.physicsWorld, cannonX, cannonZ)
                : playerPos.y;
            const cannonY = groundY + 0.5; // Place on ground (0.5m above for base)

            // Create cannon
            this.cannon = new ExampleCannon(this.engine);
            this.cannon.setPosition(cannonX, cannonY, cannonZ);

            // Aim the cannon at the test box (at origin 0, 0)
            const testBoxPos = new THREE.Vector3(0, cannonY, 0);
            this.cannon.aimAt(testBoxPos);

            console.log('DebugSpawnManager: Spawned interactive cannon at position:', new THREE.Vector3(cannonX, cannonY, cannonZ));
            console.log('   Press E near the cannon to fire at the test box!');
        }
    }

    /**
     * Spawn a collectible sword and rifle near the player for testing combat
     */
    private spawnWeapons(playerPos: THREE.Vector3, playerRotation: number, perpRotation: number): void {
        // Use the player's existing WeaponPickupManager, or create a full
        // WeaponPickupSystem (manager + melee/ranged systems + equip handling)
        if (!this.weaponPickupManager) {
            const currentPlayer = this.engine.getCurrentPlayer();
            const existingManager = currentPlayer?.getWeaponPickupManager?.() as WeaponPickupManager | null;
            if (existingManager) {
                this.weaponPickupManager = existingManager;
            } else {
                const spawner = this.engine.getSpawner?.();
                if (!spawner || !this.engine.physicsWorld) {
                    console.warn('DebugSpawnManager: No spawner or physics world — skipping weapon spawn');
                    return;
                }
                this.weaponPickupManager = new WeaponPickupManager(this.engine, this.engine.physicsWorld, spawner);
                this.weaponPickupSystem = new WeaponPickupSystem(this.engine, this.engine.physicsWorld, this.weaponPickupManager);
                this.ownsWeaponPickupSystem = true;
                // Attach to the player so it can detect pickups and equip weapons
                if (currentPlayer) {
                    this.weaponPickupSystem.attach(currentPlayer as PlayerController);
                }
            }
        }

        // Sword: 2m to the right of player
        const swordX = playerPos.x - Math.sin(perpRotation) * 2.0;
        const swordZ = playerPos.z - Math.cos(perpRotation) * 2.0;
        this.weaponPickupManager.spawnWeapon(
            WeaponCategory.MELEE,
            WeaponType.SWORD,
            new THREE.Vector3(swordX, playerPos.y, swordZ),
        );

        // Assault rifle: 3m to the right of player
        const rifleX = playerPos.x - Math.sin(perpRotation) * 3.5;
        const rifleZ = playerPos.z - Math.cos(perpRotation) * 3.5;
        this.weaponPickupManager.spawnWeapon(
            WeaponCategory.RANGED,
            RangedWeaponType.ASSAULT_RIFLE,
            new THREE.Vector3(rifleX, playerPos.y, rifleZ),
        );

        console.log('🗡️ [F7 Debug] Spawned sword and assault rifle near player');
    }

    /**
     * Test placement helper by spawning a small box 1 meter forward from player
     */
    testPlacement(): void {
        const currentPlayer = this.engine.getCurrentPlayer();
        if (!currentPlayer || !currentPlayer.player) {
            console.warn('DebugSpawnManager: No player controller available for placement test');
            return;
        }

        // Get player position and direction
        const playerPos = currentPlayer.player.position.clone();
        const playerRotation = currentPlayer.player.rotation.y;

        // Calculate target position 1 meter forward from player
        const targetX = playerPos.x + Math.sin(playerRotation) * 1.0;
        const targetZ = playerPos.z + Math.cos(playerRotation) * 1.0;

        // Create a small test box (0.3m cube)
        const boxSize = 0.3;
        const geometry = new THREE.BoxGeometry(boxSize, boxSize, boxSize);
        const material = new THREE.MeshStandardMaterial({
            color: Math.random() * 0xffffff,
            roughness: 0.7,
            metalness: 0.3
        });
        const testBox = new THREE.Mesh(geometry, material);
        testBox.name = `PlacementTestBox_${Date.now()}`;
        testBox.castShadow = true;
        testBox.receiveShadow = true;

        // Use PlacementHelper to find valid placement
        const placementResult = this.placementHelper.findPlacement(testBox, targetX, targetZ);

        if (placementResult) {
            // Place the box at the found position
            testBox.position.copy(placementResult.position);

            // Add to scene
            this.engine.scene.add(testBox);

            console.log('Placement test successful:', {
                position: placementResult.position,
                onGround: placementResult.onGround,
                normal: placementResult.normal
            });
        } else {
            console.warn('Placement test failed: No valid placement found at target position');
        }
    }

    /**
     * Update the spawn manager (called each frame)
     */
    update(deltaTime: number): void {
        // Update physics test box
        if (this.physicsTestBox && this.physicsTestBox.isActive()) {
            this.physicsTestBox.update(deltaTime);
        }

        // Update enemy manager
        if (this.exampleEnemyManager) {
            this.exampleEnemyManager.update(deltaTime);
        }

        // Update debug vehicle manager
        if (this.vehicleManager) {
            this.vehicleManager.update();
        }

        // Update cannon
        if (this.cannon) {
            this.cannon.update(deltaTime);
        }

        // Update weapon pickup system (only if we created it)
        if (this.ownsWeaponPickupSystem) {
            if (this.weaponPickupSystem) this.weaponPickupSystem.update(deltaTime);
            if (this.weaponPickupManager) this.weaponPickupManager.update(deltaTime);
        }
    }

    /**
     * Dispose of the spawn manager
     */
    dispose(): void {
        // Dispose physics test box
        if (this.physicsTestBox) {
            this.physicsTestBox.dispose();
            this.physicsTestBox = null;
        }

        // Dispose enemy manager
        if (this.exampleEnemyManager) {
            this.exampleEnemyManager.dispose();
        }

        // Dispose vehicle manager
        if (this.vehicleManager) {
            this.vehicleManager.dispose();
        }

        // Dispose cannon
        if (this.cannon) {
            this.cannon.dispose();
            this.cannon = null;
        }

        // Dispose weapon pickup system (only if we created it)
        if (this.ownsWeaponPickupSystem) {
            if (this.weaponPickupSystem) this.weaponPickupSystem.detach();
            if (this.weaponPickupManager) this.weaponPickupManager.dispose();
        }
        this.weaponPickupSystem = null;
        this.weaponPickupManager = null;
    }
}
