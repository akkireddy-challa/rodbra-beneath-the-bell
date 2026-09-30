// AI editor note: This file is overridden by EVERY community template under
// /templates/<slug>/source/Game.ts — it's the one file all 6 templates
// commit a per-template version of. If you rename exports, change the
// constructor signature, or alter the GenreGameInterface this class
// implements, search every overlay for stale references and update them
// in lockstep (pnpm run check does NOT cover templates — drift lands
// silently). See ../../../../templates/README.md for the full contract.
import * as THREE from 'three';
import type { WorldProfileData, EngineLike, GameData } from 'types/game.js';
import { PlayerController } from 'engine/PlayerController.js';
import { VoxelPlayerController } from './VoxelPlayerController.js';
import { ThirdPersonCamera } from 'engine/ThirdPersonCamera.js';
import { CameraManager } from 'engine/CameraManager.js';
import { WorldGenerator } from './WorldGenerator.js';
import { SkyboxLoader } from 'engine/loaders/SkyboxLoader.js';
import { PlayerLoader } from 'engine/loaders/PlayerLoader.js';
import { AmbientLighting } from 'engine/lighting/AmbientLighting.js';
// DebugController is only available in development - handled dynamically
import { GameHUD } from './GameHUD.js';
import { bitmagicCharacterFactory, applyBitmagicModifications, updateBitmagicEyeBlink } from './BitmagicPlayerCharacter.js';
import { genreRegistry, type GenreGameInterface } from 'engine/GenreRegistry.js';
import { DEFAULT_PHYSICS } from './PhysicsConfig.js';
import { CONSTANTS } from './Constants.js';
import { VehicleManager } from 'engine/VehicleManager.js';
import { Spawner } from 'engine/Spawner.js';
import { VehicleSpawner } from 'engine/VehicleSpawner.js';
import { mergeCharacterConfig } from 'engine/CharacterConfig.js';
import { installAnimatedGlbDevTools } from 'engine/AnimatedGlbCharacter.js';

export class VoxelGame implements GenreGameInterface {
    private engine: EngineLike;
    private worldProfileData: WorldProfileData;
    private world: THREE.Object3D | null;
    private player: THREE.Object3D | null;
    private playerController: PlayerController | null;
    private cameraController: ThirdPersonCamera | null;
    private cameraManager: CameraManager | null = null;
    public worldGenerator: WorldGenerator | null = null;
    private skyboxLoader: SkyboxLoader;
    private playerLoader: PlayerLoader;
    private ambientLighting: AmbientLighting;
    private debugController: any | null = null;
    public hud: GameHUD;
    private vehicleManager: VehicleManager;
    private spawner: Spawner;
    private vehicleSpawner: VehicleSpawner;
    private gameId: string | null = null;

    private gameData: GameData | null = null;
    private elapsedTime: number = 0; // Track elapsed time for animated textures
    private hemisphereLight: THREE.HemisphereLight | null = null;

    private wasRecordingFrames: boolean = false;
    private cullingWasEnabledBeforeRecording: boolean = false;
    private envCullingWasEnabledBeforeRecording: boolean = false;

    constructor(engine: EngineLike, worldProfileData: WorldProfileData, gameData?: GameData) {
        this.engine = engine;
        this.worldProfileData = worldProfileData;
        this.gameData = gameData || null;
        this.world = null;
        this.player = null;
        this.playerController = null;
        this.cameraController = null;

        // Require seed from worldProfileData - throw error if not found
        if (worldProfileData.worldSeed === undefined) {
            throw new Error('worldSeed is required in worldProfileData for consistent world generation');
        }

        try {
            console.log('Creating SkyboxLoader...', { engine: !!engine, worldProfileData: !!worldProfileData });
            this.skyboxLoader = new SkyboxLoader(engine, worldProfileData);
            console.log('SkyboxLoader created successfully:', !!this.skyboxLoader);
        } catch (error) {
            console.error('Failed to create SkyboxLoader:', error);
            throw error;
        }

        this.playerLoader = new PlayerLoader(engine, worldProfileData);

        // Expose playerLoader on engine for debug tools
        this.engine.setPlayerLoader?.(this.playerLoader);

        this.ambientLighting = new AmbientLighting(engine, this.skyboxLoader);
        // DebugController will be initialized lazily in load() method if available
        // gameName is required and must come from game.json (now at top level of gameData)
        const gameName = this.gameData?.gameName;
        if (!gameName) {
            console.error('[VoxelGame] gameData:', this.gameData);
            throw new Error('[VoxelGame] gameName is required in gameData but was not provided. Ensure game.json is loaded and merged correctly.');
        }
        this.hud = new GameHUD();
        this.vehicleManager = new VehicleManager(engine);
        this.spawner = new Spawner(engine);
        this.vehicleSpawner = new VehicleSpawner(this.spawner, this.vehicleManager);

        // Expose Spawner and VehicleSpawner on engine for easy access from templates
        this.engine.setSpawner?.(this.spawner);
        this.engine.setVehicleSpawner?.(this.vehicleSpawner);

        // Provide block character factory using new interface-based approach
        this.engine.blockCharacterFactory = bitmagicCharacterFactory;

        // Provide Bitmagic modifications callback for post-creation scaling/physics
        this.engine.applyCharacterModifications = applyBitmagicModifications;

        // Experimental dev tool: window.__bmSpawnAnimGlb('<glb-url>') to load a
        // rigged GLB and play its own clips by name (decoupled from locomotion).
        installAnimatedGlbDevTools(this.engine);
    }

    async load(gameId: string): Promise<void> {
        try {
            // Store gameId for WorldGenerator
            this.gameId = gameId;

            // Bloom is now configured automatically from world.json in GameEngine.loadGame()

            // Create WorldGenerator now that we have gameId
            if (!this.worldGenerator) {
                // Determine initial world size from ground type settings if available, otherwise default to 128
                const initialWorldSize = this.worldProfileData.groundWorldSizeX
                    ? Math.max(this.worldProfileData.groundWorldSizeX, this.worldProfileData.groundWorldSizeZ || 128)
                    : 128;

                // worldSeed is already validated in constructor, so we know it's defined
                const seed = this.worldProfileData.worldSeed!;

                // Pass gameId and gameData to WorldGenerator so it can load saved heightmaps and pass data to systems
                this.worldGenerator = new WorldGenerator(initialWorldSize, seed, this.worldProfileData, this.engine, gameId, this.gameData);

                // Expose findValidVoxelSpawnPosition for proper animal/NPC spawning in voxel
                // terrain. fromY (optional) makes the spawn interior-aware — the floor is
                // found by scanning down from that height, so NPCs can spawn inside roofed
                // rooms instead of on the roof (see NpcHandle.spawn(x, z, y)).
                this.engine.findValidVoxelSpawnPosition = (x: number, z: number, fromY?: number) => {
                    return this.worldGenerator?.findValidVoxelSpawnPosition(x, z, fromY) || null;
                };
            }

            // Kick off the skybox fetch in parallel with terrain generation —
            // they're independent. Awaited below before lighting setup (which
            // reads the skybox). The detached catch prevents an unhandled
            // rejection if terrain generation throws before we reach the await;
            // the await itself still surfaces a real skybox failure.
            const skyboxPromise = this.skyboxLoader.loadSkybox();
            void skyboxPromise.catch(() => {});

            // Always generate full world in Voxel mode
            await this.worldGenerator.generateWorld();
            this.world = this.worldGenerator.getWorld();

            if (!this.world) {
                throw new Error('WorldGenerator failed to create world object');
            }

            // Ground physics is now created automatically with visual chunks via generateGroundChunks()
            // which properly tracks both visual mesh and physics body together.
            // Physics bodies are added to physics world during chunk generation.

            // Add all other physics bodies (scenery, etc.) to physics world
            this.worldGenerator.getWorldBodies().forEach(body => {
                if (this.engine.physicsWorld && body) {
                    this.engine.physicsWorld.addRigidBody(body);
                }
            });


            await skyboxPromise;
            this.ambientLighting.updateFromScene();

            // Set up warm sunset lighting for the voxel art style (skipped for low-poly mesh-level worlds)
            this.setupVoxelLighting();

            // Physics step for terrain colliders is now done in WorldGenerator.generateWorld()
            // after finalizeTerrain(), so all physics bodies created afterward work correctly

            // Connect terrain system to DynamicObjectManager for chunk-based hibernation
            const voxelTerrain = this.worldGenerator.getVoxelTerrainSystem();
            if (voxelTerrain && this.engine.getDynamicObjectManager) {
                this.engine.getDynamicObjectManager().setTerrainSystem(voxelTerrain);
            }

            // Warm the animation cache so locomotion clips download alongside the
            // character rig (loadPlayer) instead of strictly after it.
            this.playerLoader.prefetchPlayerAnimations();
            this.player = await this.playerLoader.loadPlayer();

            // Enable bloom effect on player if configured
            this.engine.enableBloomOnObject?.(this.player);

            this.setupCamera();

            // Initialize DebugController if available (development only) - before setupPlayerController
            try {
                const { DebugController } = await import('engine/DebugController.js');
                this.debugController = new DebugController(this.engine);
            } catch (error) {
                // DebugController not available - this is fine for production builds
                console.log('DebugController not available (expected in production)');
            }

            await this.setupPlayerController();

            // Enable player gravity NOW that terrain is fully loaded
            // Physics won't actually step until GameState becomes PLAYING (on Play button click)
            this.playerLoader.enablePlayerGravity();

            console.log('✅ Game loaded - waiting for Play button');

            // Show the HUD
            this.hud.show();

            // Load custom animations in the background (non-blocking)
            this.loadCustomAnimations().catch(error => {
                console.error('Failed to load custom animations:', error);
            });

            console.log('Voxel game loaded successfully');
        } catch (error) {
            console.error('Failed to load Voxel game:', error);
            throw error;
        }
    }

    private setupCamera(): void {
        if (this.engine.camera && this.engine.renderer) {
            // Read camera mode from configuration, default to third-person
            const cameraMode = this.worldProfileData.cameraMode || 'third-person';
            
            // Create CameraManager with configured camera mode. Controllers
            // always own the default perspective camera; the engine swaps in an
            // orthographic camera itself for top-down fit-world mode.
            this.cameraManager = new CameraManager(
                this.engine.getDefaultCamera(),
                this.player!,
                this.engine.renderer.domElement,
                this.engine,
                cameraMode
            );

            // Top-down "fit whole world" mode: fixed orthographic view sized so
            // the entire world is visible with no borders (opt-in via world.json).
            if (cameraMode === 'top-down' && this.worldProfileData.topDownFitWorld) {
                const topDownCamera = this.cameraManager.getTopDownCamera();
                topDownCamera.setFitWorld({
                    sizeX: this.worldProfileData.groundWorldSizeX ?? 64,
                    sizeZ: this.worldProfileData.groundWorldSizeZ ?? 64,
                    margin: this.worldProfileData.topDownFitWorldMargin ?? 1.0,
                    region: this.worldProfileData.topDownFitWorldRegion ?? {},
                    background: this.worldProfileData.topDownFitWorldBackground ?? 'auto',
                });
            }

            // Get reference to the active camera controller (could be ThirdPerson, FirstPerson, or TopDown)
            // Fall back to ThirdPersonCamera for backward compatibility if no active controller
            this.cameraController = (this.cameraManager.getActiveController() as ThirdPersonCamera)
                ?? this.cameraManager.getThirdPersonCamera();
        }
    }

    /**
     * Set up warm sunset lighting for the voxel art style.
     * Adds HemisphereLight for soft ambient lighting. A low-poly game whose mesh level
     * lights itself as an interior (a MeshLevel built in game code, or a declared
     * `meshLevel` with `lighting: 'interior'`) skips it: the level brings its own
     * hemisphere light, and the two stacked wash out an interior. Exterior mesh levels
     * (the default for a declared one) and voxel terrain keep it.
     */
    private setupVoxelLighting(): void {
        if (!this.engine.scene) return;
        const wpd = this.gameData?.worldProfileData;
        const meshLevelLightsItself = wpd?.terrain?.shape === 'none' && (!wpd.meshLevel || wpd.meshLevel.lighting === 'interior');
        if (this.gameData?.artStyle === 'low-poly' && meshLevelLightsItself) return;

        // HemisphereLight: warm sky color, cool ground color for soft ambient
        // Sky: warm sunset orange-yellow, Ground: dark blue-ish for contrast
        this.hemisphereLight = new THREE.HemisphereLight(
            0xffeeb1,  // Sky color - warm golden
            0x080820,  // Ground color - dark blue
            1.0        // Intensity
        );
        this.engine.scene.add(this.hemisphereLight);

        console.log('✨ Voxel lighting setup complete');
    }

    /**
     * Get the hemisphere light for runtime adjustments.
     * 
     * Use this to adjust ambient lighting based on location (outdoors vs dungeon):
     * ```typescript
     * const hemi = game.getHemisphereLight();
     * if (hemi) {
     *     hemi.color.setHex(0xffeeb1);      // Sky color (surfaces facing up)
     *     hemi.groundColor.setHex(0x101010); // Ground color (surfaces facing down)
     *     hemi.intensity = 0.3;              // Overall intensity
     * }
     * ```
     */
    getHemisphereLight(): THREE.HemisphereLight | null {
        return this.hemisphereLight;
    }

    private async setupPlayerController(): Promise<void> {
        const playerBody = this.playerLoader.getPlayerBody();
        if (!playerBody) {
            throw new Error('Player physics body not created');
        }

        if (!this.engine.physicsWorld) {
            throw new Error('Physics world not initialized');
        }

        console.log('🎮 VoxelGame: Using VoxelPlayerController');
        this.playerController = new VoxelPlayerController(
            this.player!,
            playerBody,
            this.engine.physicsWorld,
            this.cameraController!,
            this.engine,
            DEFAULT_PHYSICS,
            this.worldGenerator,
            undefined, // movementSystem
            CONSTANTS
        );

        // Register playerController with engine for debug systems (NpcManager projectile detection)
        this.engine.registerPlayerController(this.playerController);

        // Apply movement speed from characterConfig (runSpeed is used as the default movement speed)
        const charConfig = mergeCharacterConfig(this.worldProfileData.characterConfig);
        this.playerController.getMovementSystem().setMoveSpeed(charConfig.runSpeed);

        // Set the calculated capsule dimensions for accurate ground detection
        this.playerController.setCapsuleDimensions(
            this.playerLoader.getCapsuleHeight(),
            this.playerLoader.getCapsuleRadius(),
        );

        // Set voxel block size for step climbing (player + all dynamic objects)
        if (this.worldGenerator) {
            const voxelBlockSize = this.worldGenerator.getVoxelBlockSize();
            this.playerController.voxelBlockSize = voxelBlockSize;
            // Set for all dynamic objects (animals, NPCs) - both existing and future
            this.engine.getDynamicObjectManager?.()?.setVoxelBlockSize(voxelBlockSize);
        }

        // Connect animation controller to player controller
        this.playerController.setAnimationController(this.playerLoader.getAnimationController());

        // Connect PlayerLoader to PlayerController for character switching
        this.playerController.setPlayerLoader(this.playerLoader);

        // Connect vehicle manager to player controller
        this.playerController.setVehicleManager(this.vehicleManager);

        // Set up callback for when player object changes (for character switching)
        this.playerController.setOnPlayerChangedCallback((newPlayer: THREE.Object3D) => {
            this.player = newPlayer;

            // Enable bloom effect on new player if configured
            this.engine.enableBloomOnObject?.(newPlayer);

            // Update camera target to follow new player
            if (this.cameraController) {
                this.cameraController.setTarget(newPlayer);
            }

            console.log('VoxelGame: Player object and camera target updated for character switching');
        });

        // Connect DebugController to Game for debug features (F8 animations, etc.)
        if (this.debugController) {
            this.debugController.setGame(this);
        }

        // Apply character modifications now that PlayerController is ready
        this.playerLoader.applyCharacterModifications(this.player!, this.playerController);

        // Connect HUD to PlayerController for dynamic control display
        this.hud.setPlayerController(this.playerController);
        // Set HUD reference on PlayerController so it can show controls when movement system changes
        this.playerController.hud = this.hud;
    }

    private async loadCustomAnimations(): Promise<void> {
        try {
            const animController = this.playerLoader.getAnimationController();
            if (!animController) {
                console.warn('No animation controller found');
                return;
            }
            await animController.loadAllAnimationAssets({ normalizeRootMotion: true, loop: false });
        } catch (error) {
            console.error('Failed to load custom animations:', error);
        }
    }

    public getAnimationController(): any {
        return this.playerLoader.getAnimationController();
    }

    update(deltaTime: number): void {
        // Process deferred terrain chunks and foliage before gameplay starts.
        // Ensures all terrain is fully built before the player can see it.
        // Comment out for games with a tunnel/corridor start where terrain
        // can build progressively in the background while the player is hidden.
        const vt = this.worldGenerator?.getVoxelTerrainSystem();
        if (vt?.hasDeferredWork) {
            vt.processDeferredWork();
            return;
        }

        // Track elapsed time for animated textures
        this.elapsedTime += deltaTime;

        if (this.playerController) {
            this.playerController.update(deltaTime);
        }

        // Update vehicles
        this.vehicleManager.update();

        // Update block character animation if present
        this.playerLoader.updateBlockCharacter();

        // Update Bitmagic eye blinking animation
        updateBitmagicEyeBlink(deltaTime);

        // Update voxel terrain animated textures (e.g., lava) and visibility culling
        if (this.worldGenerator) {
            // Disable frustum culling during recording — the recording camera has a different
            // aspect ratio than the editor camera, so the frustum doesn't match and chunks
            // outside the editor frustum (but inside the recording frustum) get hidden.
            const isRecording = this.engine.isRecordingFrames?.() ?? false;

            const voxelTerrain = this.worldGenerator.getVoxelTerrainSystem();
            if (voxelTerrain) {
                voxelTerrain.update(this.elapsedTime);

                if (isRecording && !this.wasRecordingFrames) {
                    this.cullingWasEnabledBeforeRecording = voxelTerrain.isCullingEnabled();
                    voxelTerrain.setCullingEnabled(false);
                    const envSys = this.worldGenerator.getEnvironmentObjectSystem();
                    if (envSys) {
                        this.envCullingWasEnabledBeforeRecording = envSys.isCullingEnabled();
                        envSys.setCullingEnabled(false);
                    }
                } else if (!isRecording && this.wasRecordingFrames) {
                    if (this.cullingWasEnabledBeforeRecording) {
                        voxelTerrain.setCullingEnabled(true);
                    }
                    const envSys = this.worldGenerator.getEnvironmentObjectSystem();
                    if (envSys && this.envCullingWasEnabledBeforeRecording) {
                        envSys.setCullingEnabled(true);
                    }
                }
                this.wasRecordingFrames = isRecording;

                if (this.engine.camera && !isRecording) {
                    voxelTerrain.updateVisibility(this.engine.camera, this.player?.position);
                }

                // Progressive chunk building for large worlds (lazy generation)
                // Builds 1 chunk per frame as player explores beyond initial radius
                if (this.player && !voxelTerrain.isLazyGenerationComplete()) {
                    voxelTerrain.buildPendingChunksNear(
                        this.player.position.x,
                        this.player.position.z,
                        1,  // Build 1 chunk per frame (~8ms overhead)
                        200 // Only build chunks within 200m of player
                    );
                }
            }

            // Per-frame LOD selection for baked chunked-VXL worlds. Drop-in
            // alternative to the chunk-grid `voxelTerrain` path above. Only
            // one of the two systems is non-null per world.
            const vxlChunked = this.worldGenerator.getVxlChunkedTerrain();
            if (vxlChunked) {
                vxlChunked.update(this.elapsedTime);
                if (this.engine.camera && !isRecording) {
                    vxlChunked.updateVisibility(this.engine.camera, this.player?.position);
                }
            }

            // Per-frame LOD selection for baked VxlScene (new VLSC `.vwld`)
            // worlds. Sibling of the `vxlChunked` block above for the newer
            // format. Only one terrain system is non-null per world.
            const vxlScene = this.worldGenerator.getVxlSceneTerrain();
            if (vxlScene) {
                vxlScene.update(this.elapsedTime);
                if (this.engine.camera && !isRecording) {
                    vxlScene.updateVisibility(this.engine.camera, this.player?.position);
                }
            }

            // Update foliage debris physics
            const foliageSystem = this.worldGenerator.getFoliageSystem();
            if (foliageSystem) {
                foliageSystem.updateDebris(deltaTime);
            }

            // Update environment object visibility culling (trees, rocks, buildings)
            const envSystem = this.worldGenerator.getEnvironmentObjectSystem();
            if (envSystem && this.engine.camera && !isRecording) {
                envSystem.updateVisibility(this.engine.camera);
            }
        }

        // Only sync player physics from body when the movement system doesn't handle it.
        // Ski and vehicle movement systems sync player position themselves;
        // running syncPlayerPhysics would overwrite their position causing visual twitching.
        if (!this.playerController?.handlesPlayerPositionSync()) {
            this.syncPlayerPhysics();
        }

        // Let PlayerController handle camera updates (supports vehicle camera switching)
        if (this.playerController && this.playerController.getCameraController) {
            const activeCamera = this.playerController.getCameraController();
            if (activeCamera && activeCamera.update) {
                activeCamera.update(deltaTime);
            }
        } else if (this.cameraController) {
            // Fallback to direct camera update
            this.cameraController.update(deltaTime);
        }

    }

    private syncPlayerPhysics(): void {
        const playerBody = this.playerLoader.getPlayerBody();
        if (!playerBody || !this.player) return;

        // Use Rapier translation for position syncing
        const pos = playerBody.translation();

        const capsuleHeight = this.playerLoader.getCapsuleHeight();
        const halfHeight = capsuleHeight / 2;

        // Position the visual player so its feet align with the physics capsule bottom
        // Physics capsule center is at pos.y, so capsule bottom is at pos.y - halfHeight
        // For block characters, there's an offset from playerGroup origin to the actual feet
        const capsuleBottom = pos.y - halfHeight;
        const feetOffsetY = this.playerLoader.getFeetOffsetY();
        const playerGroupY = capsuleBottom - feetOffsetY;
        this.player.position.set(pos.x, playerGroupY, pos.z);

        if (this.playerController) {
            this.player.rotation.y = this.playerController.rotation;
        }
    }

    dispose(): void {
        if (this.playerController) {
            this.playerController.dispose();
        }

        if (this.playerLoader) {
            this.playerLoader.dispose();
        }

        if (this.cameraManager) {
            this.cameraManager.dispose();
        } else if (this.cameraController) {
            this.cameraController.dispose();
        }

        if (this.player && this.engine.scene) {
            this.engine.scene.remove(this.player);
        }

        this.ambientLighting.dispose();
        if (this.debugController) {
            this.debugController.dispose();
        }
        this.hud.dispose();

        const playerBody = this.playerLoader.getPlayerBody();
        if (playerBody && this.engine.physicsWorld) {
            this.engine.physicsWorld.removeRigidBody(playerBody);
        }

        if (this.engine.physicsWorld && this.worldGenerator) {
            this.worldGenerator.getWorldBodies().forEach(body => {
                this.engine.physicsWorld!.removeRigidBody(body);
            });
        }
    }

    onWindowResize(): void {
        // Handle window resize if needed
        // Camera controller doesn't have a resize method, handled automatically by THREE.js
    }

    getWorldSeed(): number {
        if (!this.worldGenerator) {
            throw new Error('WorldGenerator not initialized');
        }
        return this.worldGenerator.getSeed();
    }

    getCurrentPlayer(): any | null {
        return this.playerController;
    }

    /**
     * Get the generic Spawner instance for spawning any type of entity
     * Use this for ground height detection and positioning of non-vehicle entities
     */
    getSpawner(): Spawner {
        return this.spawner;
    }

    /**
     * Get the VehicleSpawner instance for spawning vehicles
     * This is the recommended way to spawn vehicles - it handles all vehicle-specific logic
     */
    getVehicleSpawner(): VehicleSpawner {
        return this.vehicleSpawner;
    }
}

// Register the VoxelGame with the genre registry
genreRegistry.registerGenre('Voxel', VoxelGame);

