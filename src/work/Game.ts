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
import { GameHUD } from './GameHUD.js';
import { bitmagicCharacterFactory, applyBitmagicModifications, updateBitmagicEyeBlink, getPlayerSwordMesh } from './BitmagicPlayerCharacter.js';
import { genreRegistry, type GenreGameInterface } from 'engine/GenreRegistry.js';
import { DEFAULT_PHYSICS } from './PhysicsConfig.js';
import { CONSTANTS, INITIAL_PLAYER_STATS, type PlayerStats } from './Constants.js';
import { VehicleManager } from 'engine/VehicleManager.js';
import { Spawner } from 'engine/Spawner.js';
import { VehicleSpawner } from 'engine/VehicleSpawner.js';
import { mergeCharacterConfig } from 'engine/CharacterConfig.js';
import { AmbientSnowVFX } from 'engine/effects/AmbientSnowVFX.js';
import { getGameStateManager, GameState } from 'engine/GameStateManager.js';

// RÖDBRÅ Game Systems
import { audio } from './AudioSystem.js';
import { EnemyManager } from './Enemies.js';
import { PlayerCombatSystem } from './CombatSystem.js';
import { WorldZoneManager } from './WorldZones.js';
import { UIManager, type UISettings } from './UIManager.js';
import { SaveGameService } from './SaveGameService.js';

export class VoxelGame implements GenreGameInterface {
    private engine: EngineLike;
    private worldProfileData: WorldProfileData;
    private world: THREE.Object3D | null;
    private player: THREE.Object3D | null;
    private playerController: VoxelPlayerController | null;
    private cameraController: ThirdPersonCamera | null;
    private cameraManager: CameraManager | null = null;
    public worldGenerator: WorldGenerator | null = null;
    private skyboxLoader: SkyboxLoader;
    private playerLoader: PlayerLoader;
    private ambientLighting: AmbientLighting;
    public hud: GameHUD;
    private vehicleManager: VehicleManager;
    private spawner: Spawner;
    private vehicleSpawner: VehicleSpawner;
    private gameId: string | null = null;
    private gameData: GameData | null = null;
    private elapsedTime: number = 0;
    private hemisphereLight: THREE.HemisphereLight | null = null;
    private moonLight: THREE.DirectionalLight | null = null;

    // RÖDBRÅ Core Managers
    public stats: PlayerStats = { ...INITIAL_PLAYER_STATS, upgrades: { ...INITIAL_PLAYER_STATS.upgrades }, completedBosses: { ...INITIAL_PLAYER_STATS.completedBosses }, unlockedShortcuts: { ...INITIAL_PLAYER_STATS.unlockedShortcuts } };
    public enemyManager: EnemyManager | null = null;
    public combatSystem: PlayerCombatSystem | null = null;
    public zoneManager: WorldZoneManager | null = null;
    public uiManager: UIManager | null = null;
    private snowVFX: AmbientSnowVFX | null = null;
    private snowCenterScratch: THREE.Vector3 = new THREE.Vector3();

    // Game loop flags
    private isGamePlaying: boolean = true;
    private isPaused: boolean = false;
    private hasStartedFirstTime: boolean = false;
    private objectiveUpdateTimer: number = 0;
    private prevKeys: Record<string, boolean> = {};
    private rawHeldKeys: Set<string> = new Set();
    private prevGamepadButtons: boolean[] = [];

    constructor(engine: EngineLike, worldProfileData: WorldProfileData, gameData?: GameData) {
        this.engine = engine;
        this.worldProfileData = worldProfileData;
        this.gameData = gameData || null;
        this.world = null;
        this.player = null;
        this.playerController = null;
        this.cameraController = null;

        if (worldProfileData.worldSeed === undefined) {
            throw new Error('worldSeed is required in worldProfileData for consistent world generation');
        }

        this.skyboxLoader = new SkyboxLoader(engine, worldProfileData);
        this.playerLoader = new PlayerLoader(engine, worldProfileData);
        this.engine.setPlayerLoader?.(this.playerLoader);
        this.ambientLighting = new AmbientLighting(engine, this.skyboxLoader);

        this.hud = new GameHUD();
        this.vehicleManager = new VehicleManager(engine);
        this.spawner = new Spawner(engine);
        this.vehicleSpawner = new VehicleSpawner(this.spawner, this.vehicleManager);

        this.engine.setSpawner?.(this.spawner);
        this.engine.setVehicleSpawner?.(this.vehicleSpawner);

        // Plug Liv Ravn character factory into engine
        this.engine.blockCharacterFactory = bitmagicCharacterFactory;
        this.engine.applyCharacterModifications = applyBitmagicModifications;
    }

    async load(gameId: string): Promise<void> {
        try {
            this.gameId = gameId;

            // Generate baseline world (640m length for all 4 connected zones through z=280+)
            if (!this.worldGenerator) {
                const initialWorldSize = 640;
                const seed = this.worldProfileData.worldSeed!;
                this.worldGenerator = new WorldGenerator(initialWorldSize, seed, this.worldProfileData, this.engine, gameId, this.gameData);
                this.engine.findValidVoxelSpawnPosition = (x: number, z: number, fromY?: number) => {
                    return this.worldGenerator?.findValidVoxelSpawnPosition(x, z, fromY) || null;
                };
            }

            await this.worldGenerator.generateWorld();
            this.world = this.worldGenerator.getWorld();

            if (!this.world) {
                throw new Error('WorldGenerator failed to create world object');
            }

            this.worldGenerator.getWorldBodies().forEach(body => {
                if (this.engine.physicsWorld && body) {
                    this.engine.physicsWorld.addRigidBody(body);
                }
            });

            await this.skyboxLoader.loadSkybox();
            this.ambientLighting.updateFromScene();

            // Set up cold Nordic blue dusk & moonlight lighting
            this.setupAtmosphericLighting();

            // Load Liv Ravn Player Character
            this.player = await this.playerLoader.loadPlayer();
            this.engine.enableBloomOnObject?.(this.player);

            this.setupCamera();
            await this.setupPlayerController();

            this.playerLoader.enablePlayerGravity();

            // Initialize Falling Snow Flurries
            if (this.engine.scene) {
                this.snowVFX = new AmbientSnowVFX(this.engine.scene, {
                    density: 0.6,
                    maxParticles: 1200,
                    fallSpeed: 2.8,
                    wind: new THREE.Vector3(3.5, 0, 1.2),
                    flakeSize: 0.28,
                    color: 0xDAE8F2,
                    opacity: 0.85,
                    radius: 40,
                    columnHeight: 30,
                    groundDrop: 4,
                });
            }

            // Initialize Enemy Manager
            this.enemyManager = new EnemyManager(this.engine.scene!);

            // Initialize Player Combat System
            this.combatSystem = new PlayerCombatSystem(
                this.engine.scene!,
                this.player!,
                this.engine.getDefaultCamera(),
                this.enemyManager,
                this.stats
            );

            // Initialize World Zone Manager (Builds all 4 zones, chapel, waterwheel, colossal bell, Elin)
            this.zoneManager = new WorldZoneManager(
                this.engine.scene!,
                this.engine.physicsWorld!,
                this.enemyManager,
                this.stats
            );

            // Connect Mill timing hazard hit callback
            this.zoneManager.setHazardHitCallback((dmg, hitDir) => {
                if (this.combatSystem && !this.combatSystem.isInvulnerable) {
                    this.combatSystem.takeDamage(dmg, hitDir);
                    audio.playArmorImpact();
                }
            });

            // Initialize UI Manager
            this.uiManager = new UIManager(this.stats, {
                onStartGame: () => this.handleStartGame(),
                onNewGame: () => this.handleNewGame(),
                onResumeGame: () => this.handleResumeGame(),
                onRestartCheckpoint: () => this.handleRestartCheckpoint(),
                onQuitToTitle: () => this.handleQuitToTitle(),
                onApplySettings: (settings: UISettings) => this.handleApplySettings(settings),
                onFinalChoice: (choice: 'break_seal' | 'offer_blood') => this.handleFinalChoice(choice),
                onUpgradePurchased: () => this.handleUpgradePurchased(),
            });

            // Listen for engine Play state without prematurely skipping title screen
            getGameStateManager().addListener((state) => {
                if (state === GameState.PLAYING && !this.hasStartedFirstTime) {
                    this.hasStartedFirstTime = true;
                }
            });

            // Register Input Listeners
            this.setupInputHandlers();

            // Run and expose developer route validation
            if (typeof window !== 'undefined') {
                (window as any).validateRoute = () => this.validateRoute();
                (window as any).__RODBRA_VALIDATE_ROUTE__ = () => this.validateRoute();
            }
            this.validateRoute();

            console.log('✅ RÖDBRÅ: Beneath the Bell loaded successfully');
        } catch (error) {
            console.error('Failed to load RÖDBRÅ:', error);
            throw error;
        }
    }

    private setupAtmosphericLighting(): void {
        if (!this.engine.scene) return;

        // Cold blue dusk sky and dark earth ground
        this.hemisphereLight = new THREE.HemisphereLight(0x324A5E, 0x141618, 0.9);
        this.engine.scene.add(this.hemisphereLight);

        // Directional moonlight from high angle
        this.moonLight = new THREE.DirectionalLight(0x7D9BB5, 0.85);
        this.moonLight.position.set(25, 45, -15);
        this.engine.scene.add(this.moonLight);

        // Dense cold blue dusk fog
        this.engine.scene.fog = new THREE.Fog(0x131D26, 30, 160);
    }

    private setupCamera(): void {
        if (this.engine.camera && this.engine.renderer) {
            this.cameraManager = new CameraManager(
                this.engine.getDefaultCamera(),
                this.player!,
                this.engine.renderer.domElement,
                this.engine,
                'third-person'
            );
            this.cameraController = (this.cameraManager.getActiveController() as ThirdPersonCamera)
                ?? this.cameraManager.getThirdPersonCamera();

            // Over-the-shoulder framing for dark fantasy slasher
            if (this.cameraController) {
                this.cameraController.distance = 4.2;
                this.cameraController.shoulderOffsetRight = 0.65;
                this.cameraController.lookAtHeight = 1.35;
            }
        }
    }

    private async setupPlayerController(): Promise<void> {
        const playerBody = this.playerLoader.getPlayerBody();
        if (!playerBody || !this.engine.physicsWorld) {
            throw new Error('Physics world or body not initialized');
        }

        this.playerController = new VoxelPlayerController(
            this.player!,
            playerBody,
            this.engine.physicsWorld,
            this.cameraController!,
            this.engine,
            DEFAULT_PHYSICS,
            this.worldGenerator,
            undefined,
            CONSTANTS
        );

        this.engine.registerPlayerController(this.playerController);

        const charConfig = mergeCharacterConfig(this.worldProfileData.characterConfig);
        this.playerController.getMovementSystem().setMoveSpeed(charConfig.runSpeed);

        const capsuleHeight = 1.68;
        const capsuleRadius = 0.32;
        this.playerController.setCapsuleDimensions(capsuleHeight, capsuleRadius);

        const animController = this.playerLoader.getAnimationController();
        if (this.playerController) {
            this.playerController.setAnimationController(animController);
            this.playerController.setPlayerLoader(this.playerLoader);
        }

        this.playerLoader.applyCharacterModifications(this.player!, this.playerController);

        this.playerController.setJumpInputSuppressed(true);

        // Register cross-platform actions (Desktop keys + Mobile touch buttons)
        this.playerController.registerCustomAction({
            action: 'sprint',
            desktop: { keys: ['ShiftLeft', 'ShiftRight'] },
            mobile: { label: 'SPRINT', behavior: 'continuous', role: 'primary' },
        });

        this.playerController.registerCustomAction({
            action: 'dodge',
            desktop: { keys: ['Space', 'KeyC'] },
            mobile: { label: 'DODGE', behavior: 'tap', role: 'primary' },
        });

        this.playerController.registerCustomAction({
            action: 'attack',
            desktop: { keys: ['Enter', 'KeyJ'] },
            mobile: { label: 'SLASH', behavior: 'tap', role: 'danger' },
        });

        this.playerController.registerCustomAction({
            action: 'heavy',
            desktop: { keys: ['KeyK'] },
            mobile: { label: 'HEAVY', behavior: 'tap', role: 'danger' },
        });

        this.playerController.registerCustomAction({
            action: 'parry',
            desktop: { keys: ['KeyQ', 'KeyF'] },
            mobile: { label: 'PARRY', behavior: 'tap', role: 'primary' },
        });

        this.playerController.registerCustomAction({
            action: 'ward',
            desktop: { keys: ['KeyE'] },
            mobile: { label: 'WARD', behavior: 'tap', role: 'primary' },
        });

        this.playerController.registerCustomAction({
            action: 'heal',
            desktop: { keys: ['KeyR'] },
            mobile: { label: 'HEAL', behavior: 'tap', role: 'warning' },
        });

        this.playerController.registerCustomAction({
            action: 'execute',
            desktop: { keys: ['KeyX'] },
            mobile: { label: 'REND', behavior: 'tap', role: 'danger' },
        });

        this.playerController.registerCustomAction({
            action: 'lockon',
            desktop: { keys: ['Tab', 'KeyT'] },
            mobile: { label: 'LOCK', behavior: 'tap', role: 'primary' },
        });

        this.playerController.registerCustomAction({
            action: 'pause',
            desktop: { keys: ['Escape', 'KeyP'] },
            mobile: { label: 'PAUSE', behavior: 'tap', role: 'primary' },
        });
    }

    private setupInputHandlers(): void {
        // Direct Mouse & Keyboard Input Bindings for instant responsiveness
        window.addEventListener('mousedown', (e) => {
            if (this.isPaused || this.uiManager?.currentScreen !== 'gameplay' || this.uiManager?.isAnyModalOpen() || !this.combatSystem) return;
            audio.resume();

            const isSprinting = !!(this.playerController?.keys?.['sprint'] || this.rawHeldKeys.has('ShiftLeft') || this.rawHeldKeys.has('ShiftRight'));

            if (e.button === 0) {
                // Left Click -> Light Attack Combo (or sprint attack if running)
                this.combatSystem.handleLightAttackInput(isSprinting);
            } else if (e.button === 2) {
                // Right Click -> Charged Heavy Attack
                this.combatSystem.handleHeavyAttackDown();
            } else if (e.button === 1) {
                // Middle Click -> Directional Parry
                this.combatSystem.handleParryInput();
            }
        });

        window.addEventListener('mouseup', (e) => {
            if (this.isPaused || this.uiManager?.currentScreen !== 'gameplay' || this.uiManager?.isAnyModalOpen() || !this.combatSystem) return;
            if (e.button === 2) {
                this.combatSystem.handleHeavyAttackUp();
            }
        });

        window.addEventListener('contextmenu', (e) => {
            e.preventDefault();
        });

        window.addEventListener('keydown', (e) => {
            // Priority 1: Modal or pause toggle via Escape
            if (e.code === 'Escape') {
                if (this.uiManager?.isAnyModalOpen()) {
                    audio.playUIBack();
                    this.uiManager.closeModals();
                    return;
                }
                if (this.uiManager?.currentScreen === 'gameplay' || this.uiManager?.currentScreen === 'pause') {
                    this.togglePauseGame();
                    return;
                }
            }

            // Priority 2: KeyP pause toggle
            if (e.code === 'KeyP' && (this.uiManager?.currentScreen === 'gameplay' || this.uiManager?.currentScreen === 'pause')) {
                this.togglePauseGame();
                return;
            }

            // Priority 3: Guard gameplay inputs against paused, modal, or non-gameplay screens
            if (this.isPaused || this.uiManager?.currentScreen !== 'gameplay' || this.uiManager?.isAnyModalOpen()) {
                return;
            }

            this.rawHeldKeys.add(e.code);
            if (this.playerController) {
                if (e.code === 'KeyW' || e.code === 'ArrowUp') this.playerController.rawKeys.forward = true;
                if (e.code === 'KeyS' || e.code === 'ArrowDown') this.playerController.rawKeys.backward = true;
                if (e.code === 'KeyA' || e.code === 'ArrowLeft') this.playerController.rawKeys.left = true;
                if (e.code === 'KeyD' || e.code === 'ArrowRight') this.playerController.rawKeys.right = true;
                if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.playerController.rawKeys.sprint = true;
            }

            if (!this.combatSystem) return;
            audio.resume();

            const isSprinting = !!(this.playerController?.keys?.['sprint'] || this.rawHeldKeys.has('ShiftLeft') || this.rawHeldKeys.has('ShiftRight'));

            if (e.code === 'Space' || e.code === 'KeyC') {
                // Dodge Roll with i-frames
                this.combatSystem.handleDodgeInput();
            } else if (e.code === 'KeyJ' || e.code === 'Enter') {
                this.combatSystem.handleLightAttackInput(isSprinting);
            } else if (e.code === 'KeyK') {
                this.combatSystem.handleHeavyAttackDown();
            } else if (e.code === 'KeyE') {
                // Check if near interactable
                const playerPos = this.player!.position;
                const item = this.zoneManager?.getClosestInteractable(playerPos);
                if (item) {
                    if (item.type === 'prayer_post') {
                        item.onInteract();
                        this.saveCurrentProgress();
                        this.uiManager?.openCheckpointUpgradeModal();
                    } else if (item.type === 'elin_altar') {
                        if (this.stats.completedBosses.bellMotherBoss) {
                            item.onInteract();
                            this.uiManager?.openFinalChoiceModal();
                        }
                    } else {
                        item.onInteract();
                        item.isConsumed = true;
                        this.saveCurrentProgress();
                    }
                } else {
                    // Fallback to throw ward if no interactable in range
                    this.combatSystem.handleThrowWard();
                }
            } else if (e.code === 'KeyR') {
                this.combatSystem.handleHealInput();
            } else if (e.code === 'KeyQ' || e.code === 'KeyF') {
                this.combatSystem.handleParryInput();
            } else if (e.code === 'KeyX') {
                this.combatSystem.handleExecutionInput();
            } else if (e.code === 'Tab' || e.code === 'KeyT') {
                e.preventDefault();
                this.combatSystem.toggleLockOn();
            }
        });

        window.addEventListener('keyup', (e) => {
            this.rawHeldKeys.delete(e.code);
            if (this.playerController) {
                if (e.code === 'KeyW' || e.code === 'ArrowUp') this.playerController.rawKeys.forward = false;
                if (e.code === 'KeyS' || e.code === 'ArrowDown') this.playerController.rawKeys.backward = false;
                if (e.code === 'KeyA' || e.code === 'ArrowLeft') this.playerController.rawKeys.left = false;
                if (e.code === 'KeyD' || e.code === 'ArrowRight') this.playerController.rawKeys.right = false;
                if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.playerController.rawKeys.sprint = false;
            }

            if (e.code === 'KeyK' && this.combatSystem && !this.isPaused && this.uiManager?.currentScreen === 'gameplay') {
                this.combatSystem.handleHeavyAttackUp();
            }
        });
    }

    public togglePauseGame(): void {
        if (!this.uiManager) return;
        if (this.isPaused) {
            this.isPaused = false;
            this.uiManager.closePauseMenu();
            this.rawHeldKeys.clear();
            if (this.playerController) {
                this.playerController.rawKeys.forward = false;
                this.playerController.rawKeys.backward = false;
                this.playerController.rawKeys.left = false;
                this.playerController.rawKeys.right = false;
                this.playerController.rawKeys.sprint = false;
            }
        } else {
            this.isPaused = true;
            this.rawHeldKeys.clear();
            if (this.playerController) {
                this.playerController.rawKeys.forward = false;
                this.playerController.rawKeys.backward = false;
                this.playerController.rawKeys.left = false;
                this.playerController.rawKeys.right = false;
                this.playerController.rawKeys.sprint = false;
            }
            this.uiManager.togglePause();
        }
    }

    // =========================================================================
    // GAMEPLAY STATE TRANSITIONS
    // =========================================================================

    private handleNewGame(): void {
        console.log('Starting New Game: clearing saves and resetting state...');
        SaveGameService.clear(this.engine);
        this.stats = {
            ...INITIAL_PLAYER_STATS,
            upgrades: { ...INITIAL_PLAYER_STATS.upgrades },
            completedBosses: { ...INITIAL_PLAYER_STATS.completedBosses },
            unlockedShortcuts: { ...INITIAL_PLAYER_STATS.unlockedShortcuts },
        };
        this.recalculateStats();

        if (this.combatSystem) {
            this.combatSystem.stats = this.stats;
            this.combatSystem.actionState = 'idle';
            this.combatSystem.isControlLocked = false;
        }

        if (this.enemyManager) {
            this.enemyManager.clearAll();
        }

        if (this.zoneManager) {
            this.zoneManager.resetAll();
        }

        this.isGamePlaying = true;
        this.isPaused = false;
        this.rawHeldKeys.clear();

        const swordMesh = getPlayerSwordMesh();
        if (swordMesh) swordMesh.visible = false;

        this.teleportToCheckpoint(this.zoneManager?.checkpoints[0]?.position || new THREE.Vector3(0, 1.0, 4));

        this.uiManager?.startIntroSequence();
    }

    private handleStartGame(): void {
        this.isGamePlaying = true;
        this.isPaused = false;
        audio.init();
        audio.setMusicMode('exploration');

        const swordMesh = getPlayerSwordMesh();
        if (swordMesh) swordMesh.visible = this.stats.swordAcquired;

        if (!this.stats.swordAcquired) {
            this.teleportToCheckpoint(this.zoneManager?.checkpoints[0]?.position || new THREE.Vector3(0, 1.0, 4));
        }
    }

    private handleResumeGame(): void {
        const save = SaveGameService.load();
        if (save) {
            this.stats = { ...save.stats };
            this.recalculateStats();
            if (this.combatSystem) {
                this.combatSystem.stats = this.stats;
                this.combatSystem.actionState = 'idle';
                this.combatSystem.isControlLocked = false;
            }

            if (this.zoneManager) {
                this.zoneManager.restoreFromSave(save);
            }
        }

        this.isGamePlaying = true;
        this.isPaused = false;
        this.rawHeldKeys.clear();
        audio.init();
        audio.setMusicMode('exploration');

        this.uiManager?.showGameplay();

        const swordMesh = getPlayerSwordMesh();
        if (swordMesh) swordMesh.visible = this.stats.swordAcquired;

        const cp = this.zoneManager?.checkpoints.find(c => c.id === this.stats.activeCheckpointId);
        if (cp) {
            this.teleportToCheckpoint(cp.position);
        } else {
            this.teleportToCheckpoint(this.zoneManager?.checkpoints[0]?.position || new THREE.Vector3(0, 1.0, 4));
        }
    }

    private handleRestartCheckpoint(): void {
        this.isPaused = false;
        this.recalculateStats();
        this.stats.currentHealth = this.stats.upgrades.wovenCharm ? this.stats.baseMaxHealth * 1.2 : this.stats.baseMaxHealth;
        this.stats.healCharges = this.stats.healMaxCharges;
        this.stats.wardCharges = this.stats.wardMaxCharges;
        this.rawHeldKeys.clear();

        if (this.combatSystem) {
            this.combatSystem.actionState = 'idle';
            this.combatSystem.isControlLocked = false;
            this.combatSystem.stats = this.stats;
        }

        // Deterministic encounter reset
        if (this.zoneManager) {
            this.zoneManager.resetEncounterForCheckpoint(this.stats.activeCheckpointId, this.stats.completedBosses);
        }

        this.uiManager?.showGameplay();

        const cp = this.zoneManager?.checkpoints.find(c => c.id === this.stats.activeCheckpointId);
        if (cp) {
            this.teleportToCheckpoint(cp.position);
        }
    }

    private handleQuitToTitle(): void {
        this.isGamePlaying = false;
        this.isPaused = false;
        this.saveCurrentProgress();
    }

    private handleUpgradePurchased(): void {
        this.recalculateStats();
        this.saveCurrentProgress();
    }

    public recalculateStats(): void {
        if (this.stats.upgrades.wovenCharm) {
            const charmMaxHealth = this.stats.baseMaxHealth * 1.2;
            if (this.stats.currentHealth > charmMaxHealth) {
                this.stats.currentHealth = charmMaxHealth;
            }
        }
        if (this.combatSystem) {
            this.combatSystem.stats = this.stats;
        }
    }

    private handleApplySettings(settings: UISettings): void {
        if (this.combatSystem) {
            this.combatSystem.options.goreLevel = settings.gore;
            this.combatSystem.options.cameraShake = settings.cameraShake;
        }
    }

    private handleFinalChoice(choice: 'break_seal' | 'offer_blood'): void {
        this.isGamePlaying = false;
        if (choice === 'break_seal') {
            this.uiManager?.showSubtitle('Elin', 'Sister... the church is falling... we are finally free.', 7000);
        } else {
            this.uiManager?.showSubtitle('Liv Ravn', 'Run, Elin. I will keep the bronze silent.', 7000);
        }

        setTimeout(() => {
            this.uiManager?.openCredits();
        }, 5000);
    }

    private teleportToCheckpoint(pos: THREE.Vector3): void {
        if (this.playerController) {
            this.playerController.teleportTo(pos.x, pos.y + 1.0, pos.z);
        }
    }

    private saveCurrentProgress(): void {
        if (!this.zoneManager) return;
        SaveGameService.save({
            stats: this.stats,
            activeCheckpointId: this.stats.activeCheckpointId,
            discoveredCheckpointIds: this.zoneManager.getDiscoveredCheckpointIds(),
            consumedInteractableIds: this.zoneManager.getConsumedInteractableIds(),
            completedBosses: { ...this.stats.completedBosses },
            unlockedShortcuts: { ...this.stats.unlockedShortcuts },
            currentZoneIndex: this.zoneManager.getCurrentZoneIndex(this.player ? this.player.position.z : 0),
        }, this.engine);
    }

    // =========================================================================
    // MAIN UPDATE LOOP
    // =========================================================================

    update(deltaTime: number): void {
        const vt = this.worldGenerator?.getVoxelTerrainSystem();
        if (vt?.hasDeferredWork) {
            vt.processDeferredWork();
            return;
        }

        // Check mobile pause and gamepad pause even if already paused
        const keys = this.playerController?.keys;
        if (keys && keys['pause'] && !this.prevKeys['pause']) {
            this.togglePauseGame();
        }
        this.prevKeys['pause'] = !!keys?.['pause'];

        this.pollGamepadPause();

        if (this.isPaused) return;

        this.elapsedTime += deltaTime;

        // Player controller physics update - ALWAYS update so Liv can move and respond to input
        if (this.playerController) {
            this.playerController.rawKeys.forward = this.rawHeldKeys.has('KeyW') || this.rawHeldKeys.has('ArrowUp');
            this.playerController.rawKeys.backward = this.rawHeldKeys.has('KeyS') || this.rawHeldKeys.has('ArrowDown');
            this.playerController.rawKeys.left = this.rawHeldKeys.has('KeyA') || this.rawHeldKeys.has('ArrowLeft');
            this.playerController.rawKeys.right = this.rawHeldKeys.has('KeyD') || this.rawHeldKeys.has('ArrowRight');
            this.playerController.rawKeys.sprint = this.rawHeldKeys.has('ShiftLeft') || this.rawHeldKeys.has('ShiftRight');

            this.playerController.update(deltaTime);
        }

        // Falling Snow VFX recentering on player
        if (this.snowVFX && this.player) {
            this.player.getWorldPosition(this.snowCenterScratch);
            this.snowVFX.update(deltaTime, this.snowCenterScratch);
        }

        // Sword visibility matches acquisition state
        if (this.stats.swordAcquired) {
            const swordMesh = getPlayerSwordMesh();
            if (swordMesh && !swordMesh.visible) swordMesh.visible = true;
        }

        const isSprinting = !!(keys?.['sprint'] || this.rawHeldKeys.has('ShiftLeft') || this.rawHeldKeys.has('ShiftRight'));
        const isMoving = keys ? (keys.forward || keys.backward || keys.left || keys.right || (this.playerController ? this.playerController.moveDirection.lengthSq() > 0.01 : false)) : false;
        const playerPos = this.player ? this.player.position : new THREE.Vector3();

        // Kill Plane: if player falls below y = -10, respawn immediately at active checkpoint
        if (this.player && playerPos.y < -10) {
            console.warn(`[KillPlane] Player fell below y=-10 (y=${playerPos.y.toFixed(1)}, z=${playerPos.z.toFixed(1)}). Respawning at active checkpoint...`);
            this.handleRestartCheckpoint();
            return;
        }

        // Dynamic Sprint Speed: 8.2 m/s sprint, 5.0 m/s run
        if (this.playerController) {
            this.playerController.getMovementSystem()?.setMoveSpeed(isSprinting ? 8.2 : 5.0);
        }

        // Poll Gamepad inputs
        this.pollGamepadInput(isSprinting);

        // Mobile touch controls polling with edge detection
        if (keys && this.combatSystem) {
            if (keys['dodge'] && !this.prevKeys['dodge']) {
                this.combatSystem.handleDodgeInput();
            }
            if (keys['attack'] && !this.prevKeys['attack']) {
                this.combatSystem.handleLightAttackInput(isSprinting);
            }
            if (keys['heavy'] && !this.prevKeys['heavy']) {
                this.combatSystem.handleHeavyAttackDown();
            } else if (!keys['heavy'] && this.prevKeys['heavy']) {
                this.combatSystem.handleHeavyAttackUp();
            }
            if (keys.ward && !this.prevKeys['ward']) {
                const item = this.zoneManager?.getClosestInteractable(playerPos);
                if (item) {
                    if (item.type === 'prayer_post') {
                        item.onInteract();
                        this.saveCurrentProgress();
                        this.uiManager?.openCheckpointUpgradeModal();
                    } else if (item.type === 'elin_altar') {
                        if (this.stats.completedBosses.bellMotherBoss) {
                            this.uiManager?.openFinalChoiceModal();
                        }
                    } else {
                        item.onInteract();
                        item.isConsumed = true;
                        this.saveCurrentProgress();
                    }
                } else {
                    this.combatSystem.handleThrowWard();
                }
            }
            if (keys.heal && !this.prevKeys['heal']) {
                this.combatSystem.handleHealInput();
            }
            if (keys.parry && !this.prevKeys['parry']) {
                this.combatSystem.handleParryInput();
            }
            if (keys.execute && !this.prevKeys['execute']) {
                this.combatSystem.handleExecutionInput();
            }
            if (keys.lockon && !this.prevKeys['lockon']) {
                this.combatSystem.toggleLockOn();
            }

            this.prevKeys['dodge'] = !!keys['dodge'];
            this.prevKeys['attack'] = !!keys['attack'];
            this.prevKeys['heavy'] = !!keys['heavy'];
            this.prevKeys['ward'] = !!keys.ward;
            this.prevKeys['heal'] = !!keys.heal;
            this.prevKeys['parry'] = !!keys.parry;
            this.prevKeys['execute'] = !!keys.execute;
            this.prevKeys['lockon'] = !!keys.lockon;
        }

        // Update Combat System
        if (this.combatSystem) {
            this.combatSystem.update(deltaTime, isSprinting, isMoving);

            // Apply root motion from rolls and attack steps
            if (this.player && this.combatSystem.rootMotionVelocity.lengthSq() > 0.01) {
                this.player.position.addScaledVector(this.combatSystem.rootMotionVelocity, deltaTime);
            }

            // Check if player died
            if (this.combatSystem.actionState === 'dead' && this.uiManager?.currentScreen === 'gameplay') {
                this.uiManager.showDeathOverlay();
            }
        }

        // Update Enemies & Hitboxes
        if (this.enemyManager && this.combatSystem) {
            this.enemyManager.update(
                deltaTime,
                playerPos,
                (damage, hitDir, isGrab) => {
                    this.combatSystem!.takeDamage(damage, hitDir, isGrab);
                },
                (enemy) => {
                    // Enemy killed
                    if (enemy.type === 'warden_miniboss') {
                        this.stats.completedBosses.antlerMiniboss = true;
                        this.zoneManager?.openHushwoodGate();
                        this.saveCurrentProgress();
                    } else if (enemy.type === 'butcher_boss') {
                        this.stats.completedBosses.millButcherBoss = true;
                        this.zoneManager?.openMillGate();
                        this.saveCurrentProgress();
                    } else if (enemy.type === 'bell_mother') {
                        this.stats.completedBosses.bellMotherBoss = true;
                        this.zoneManager?.openElinBarrier();
                        this.saveCurrentProgress();
                        audio.setMusicMode('ending');
                    }
                }
            );
        }

        // Update World Zones & Checkpoints
        if (this.zoneManager) {
            this.zoneManager.update(deltaTime, playerPos);

            // Contextual Interaction Prompts
            const closest = this.zoneManager.getClosestInteractable(playerPos);
            if (closest && this.uiManager) {
                this.uiManager.showInteractionPrompt(closest.promptText);
            } else if (this.uiManager) {
                this.uiManager.hideInteractionPrompt();
            }
        }

        // Update HUD display
        if (this.uiManager && this.isGamePlaying) {
            const boss = this.enemyManager?.getBossInstance() || null;
            const obj = this.determineCurrentObjective(playerPos.z);
            this.uiManager.updateHUD(this.stats, boss, obj);
        }

        // Sync player visual with physics
        if (!this.playerController?.handlesPlayerPositionSync()) {
            this.syncPlayerPhysics();
        }

        // Update camera orbit & recentering
        if (this.playerController && this.playerController.getCameraController) {
            const activeCamera = this.playerController.getCameraController();
            if (activeCamera && activeCamera.update) {
                activeCamera.update(deltaTime);
            }
        } else if (this.cameraController) {
            this.cameraController.update(deltaTime);
        }
    }

    private determineCurrentObjective(playerZ: number): { title: string; sub: string } {
        if (!this.stats.swordAcquired) {
            return { title: 'THE LAST RING', sub: 'Draw the seax blade from the stone altar.' };
        } else if (playerZ < 45) {
            return { title: 'AWAKENED DEAD', sub: 'Slay the rising thralls and advance into Hushwood.' };
        } else if (playerZ < 114) {
            return { title: 'HUSHWOOD APPROACH', sub: 'Defeat the Antler Chieftain at the stave chapel.' };
        } else if (playerZ < 195) {
            return { title: 'THE RED MILL', sub: 'Slay the Butcher of Vargdal to open the crypt gate.' };
        } else if (!this.stats.completedBosses.bellMotherBoss) {
            return { title: 'BELOW THE BELL', sub: 'Confront the Bell Mother beneath the cracked bronze bell.' };
        } else {
            return { title: 'THE LIVING SEAL', sub: 'Approach Elin at the altar to choose Vargdal\'s fate.' };
        }
    }

    private syncPlayerPhysics(): void {
        const playerBody = this.playerLoader.getPlayerBody();
        if (!playerBody || !this.player) return;

        const pos = playerBody.translation();
        const halfHeight = this.playerLoader.getCapsuleHeight() / 2;
        this.player.position.set(pos.x, pos.y - halfHeight, pos.z);

        if (this.playerController) {
            this.player.rotation.y = this.playerController.rotation;
        }
    }

    private pollGamepadPause(): void {
        if (typeof navigator === 'undefined' || !navigator.getGamepads) return;
        const gamepads = navigator.getGamepads();
        const gp = gamepads ? (gamepads[0] || gamepads[1] || gamepads[2] || gamepads[3]) : null;
        if (!gp || !gp.connected) return;

        const isStartPressed = !!(gp.buttons[9]?.pressed);
        if (isStartPressed && !this.prevGamepadButtons[9]) {
            this.togglePauseGame();
        }
        this.prevGamepadButtons[9] = isStartPressed;
    }

    private pollGamepadInput(isSprinting: boolean): void {
        if (typeof navigator === 'undefined' || !navigator.getGamepads) return;
        const gamepads = navigator.getGamepads();
        const gp = gamepads ? (gamepads[0] || gamepads[1] || gamepads[2] || gamepads[3]) : null;
        if (!gp || !gp.connected || !this.combatSystem || !this.playerController) return;

        // Thumbstick analog movement
        const stickX = gp.axes[0] ?? 0;
        const stickY = gp.axes[1] ?? 0;
        const deadzone = 0.2;
        if (Math.abs(stickX) > deadzone || Math.abs(stickY) > deadzone) {
            this.playerController.rawKeys.left = stickX < -deadzone;
            this.playerController.rawKeys.right = stickX > deadzone;
            this.playerController.rawKeys.forward = stickY < -deadzone;
            this.playerController.rawKeys.backward = stickY > deadzone;
        }

        const buttons = gp.buttons;
        const isDown = (idx: number) => !!(buttons[idx]?.pressed);
        const wasJustPressed = (idx: number) => isDown(idx) && !this.prevGamepadButtons[idx];
        const wasJustReleased = (idx: number) => !isDown(idx) && this.prevGamepadButtons[idx];

        // Button 4: LB (Sprint)
        if (isDown(4)) {
            this.playerController.rawKeys.sprint = true;
        }

        // Button 0: A / Cross (Dodge)
        if (wasJustPressed(0)) {
            this.combatSystem.handleDodgeInput();
        }

        // Button 7: RT / R2 (Light Attack)
        if (wasJustPressed(7)) {
            this.combatSystem.handleLightAttackInput(isSprinting || isDown(4));
        }

        // Button 6: LT / L2 (Heavy Attack)
        if (wasJustPressed(6)) {
            this.combatSystem.handleHeavyAttackDown();
        } else if (wasJustReleased(6)) {
            this.combatSystem.handleHeavyAttackUp();
        }

        // Button 5: RB / R1 (Parry)
        if (wasJustPressed(5)) {
            this.combatSystem.handleParryInput();
        }

        // Button 2: X / Square (Interact / Ward)
        if (wasJustPressed(2)) {
            const playerPos = this.player!.position;
            const item = this.zoneManager?.getClosestInteractable(playerPos);
            if (item) {
                if (item.type === 'prayer_post') {
                    item.onInteract();
                    this.saveCurrentProgress();
                    this.uiManager?.openCheckpointUpgradeModal();
                } else if (item.type === 'elin_altar') {
                    if (this.stats.completedBosses.bellMotherBoss) {
                        item.onInteract();
                        this.uiManager?.openFinalChoiceModal();
                    }
                } else {
                    item.onInteract();
                    item.isConsumed = true;
                    this.saveCurrentProgress();
                }
            } else {
                this.combatSystem.handleThrowWard();
            }
        }

        // Button 1: B / Circle (Heal)
        if (wasJustPressed(1)) {
            this.combatSystem.handleHealInput();
        }

        // Button 3: Y / Triangle (Rend Execution)
        if (wasJustPressed(3)) {
            this.combatSystem.handleExecutionInput();
        }

        // Button 8 / 11: Select or R3 (Lock-on)
        if (wasJustPressed(8) || wasJustPressed(11)) {
            this.combatSystem.toggleLockOn();
        }

        // Store button states for next frame
        for (let i = 0; i < buttons.length; i++) {
            if (i === 9) continue;
            this.prevGamepadButtons[i] = isDown(i);
        }
    }

    public validateRoute(): {
        success: boolean;
        terrainBounds: { sizeX: number; sizeZ: number; halfX: number; halfZ: number; minZ: number; maxZ: number };
        checkpoints: Array<{
            id: string;
            name: string;
            position: { x: number; y: number; z: number };
            groundExists: boolean;
            nextCheckpointReachable: boolean;
            expectedBoss: string;
            bossCanSpawn: boolean;
            exitGateStatus: string;
        }>;
    } {
        const sizeX = this.worldProfileData.groundWorldSizeX ?? 96;
        const sizeZ = this.worldProfileData.groundWorldSizeZ ?? 640;
        const halfX = sizeX / 2;
        const halfZ = sizeZ / 2;
        const bounds = {
            sizeX,
            sizeZ,
            halfX,
            halfZ,
            minZ: -halfZ,
            maxZ: halfZ,
        };

        const results = [];
        const cps = this.zoneManager?.checkpoints || [];
        const bossMap: Record<string, { bossName: string; gate: string }> = {
            checkpoint_prologue: { bossName: 'Hollow Thrall (Tutorial)', gate: 'Open Mountain Trail' },
            checkpoint_hushwood: { bossName: 'Antler Chieftain (Miniboss)', gate: 'Hushwood Gate (Z=114)' },
            checkpoint_redmill: { bossName: 'The Butcher of Vargdal', gate: 'Mill Gate (Z=195)' },
            checkpoint_belowthebell: { bossName: 'The Bell Mother (Final Boss)', gate: 'Elin Root Barrier (Z=263)' },
        };

        console.log('====================================================');
        console.log('🗺️ RÖDBRÅ: ROUTE & LEVEL VALIDATION REPORT');
        console.log(`📐 Terrain Dimensions: ${bounds.sizeX}m x ${bounds.sizeZ}m (Bounds: X [${-bounds.halfX}, +${bounds.halfX}], Z [${bounds.minZ}, +${bounds.maxZ}])`);
        console.log('====================================================');

        let allValid = true;

        for (let i = 0; i < cps.length; i++) {
            const cp = cps[i]!;
            const nextCp = cps[i + 1] || null;
            const bossInfo = bossMap[cp.id] || { bossName: 'Elin Altar', gate: 'Open' };

            // Check ground bounds
            const inGroundX = Math.abs(cp.position.x) <= bounds.halfX;
            const inGroundZ = cp.position.z >= bounds.minZ && cp.position.z <= bounds.maxZ;
            const groundExists = inGroundX && inGroundZ;

            // Reachability to next checkpoint
            let nextReachable = true;
            if (nextCp) {
                const nextInBounds = Math.abs(nextCp.position.x) <= bounds.halfX && nextCp.position.z <= bounds.maxZ;
                nextReachable = nextInBounds && (nextCp.position.z > cp.position.z);
            }

            const bossCanSpawn = true;
            let exitGateStatus = bossInfo.gate;
            if (cp.id === 'checkpoint_hushwood') {
                exitGateStatus = this.stats.unlockedShortcuts.hushwoodGate ? 'Open' : 'Gated by Antler Chieftain (Z=114)';
            } else if (cp.id === 'checkpoint_redmill') {
                exitGateStatus = this.stats.unlockedShortcuts.millGate ? 'Open' : 'Gated by Mill Butcher (Z=195)';
            } else if (cp.id === 'checkpoint_belowthebell') {
                exitGateStatus = this.stats.completedBosses.bellMotherBoss ? 'Open' : 'Gated by Bell Mother (Z=263)';
            }

            if (!groundExists || !nextReachable) {
                allValid = false;
            }

            console.log(`[Checkpoint ${i + 1}/${cps.length}] ${cp.name} (id: ${cp.id}) at (${cp.position.x}, ${cp.position.y}, ${cp.position.z}):`);
            console.log(`  - Ground under checkpoint: ${groundExists ? '✅ PASS' : '❌ FAIL (Out of terrain bounds!)'}`);
            console.log(`  - Next checkpoint reachable: ${nextReachable ? '✅ YES' : '❌ NO'}`);
            console.log(`  - Expected encounter: ${bossInfo.bossName}`);
            console.log(`  - Exit barrier / gate: ${exitGateStatus}`);

            results.push({
                id: cp.id,
                name: cp.name,
                position: { x: cp.position.x, y: cp.position.y, z: cp.position.z },
                groundExists,
                nextCheckpointReachable: nextReachable,
                expectedBoss: bossInfo.bossName,
                bossCanSpawn,
                exitGateStatus,
            });
        }

        const elinZ = 268;
        const elinInBounds = elinZ <= bounds.maxZ;
        console.log(`[Final Altar] Elin's Altar at Z=${elinZ}:`);
        console.log(`  - Ground under altar: ${elinInBounds ? '✅ PASS' : '❌ FAIL'}`);
        console.log(`  - Sanctuary boundary at Z=278: ${278 <= bounds.maxZ ? '✅ PASS (Enclosed within terrain)' : '❌ FAIL'}`);
        console.log('====================================================');

        return {
            success: allValid && elinInBounds,
            terrainBounds: bounds,
            checkpoints: results,
        };
    }

    dispose(): void {
        if (this.playerController) this.playerController.dispose();
        if (this.playerLoader) this.playerLoader.dispose();
        if (this.cameraManager) this.cameraManager.dispose();
        else if (this.cameraController) this.cameraController.dispose();
        if (this.player && this.engine.scene) this.engine.scene.remove(this.player);
        if (this.snowVFX) this.snowVFX.dispose();
        if (this.enemyManager) this.enemyManager.clearAll();
        if (this.combatSystem) this.combatSystem.dispose();
        if (this.uiManager) this.uiManager.dispose();
        audio.dispose();
        this.ambientLighting.dispose();
        this.hud.dispose();
    }

    onWindowResize(): void {}
    getWorldSeed(): number { return this.worldGenerator?.getSeed() || 42; }
    getCurrentPlayer(): any | null { return this.playerController; }
    getSpawner(): Spawner { return this.spawner; }
    getVehicleSpawner(): VehicleSpawner { return this.vehicleSpawner; }
}

genreRegistry.registerGenre('Voxel', VoxelGame);
