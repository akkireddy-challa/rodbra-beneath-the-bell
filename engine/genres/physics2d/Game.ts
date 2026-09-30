import * as THREE from 'three';
import RAPIER2D from '@dimforge/rapier2d-compat';
import type { WorldProfileData, EngineLike, GameData } from 'types/game.js';
import { getRapier2D } from 'engine/physics/RapierPhysics2D.js';
import type { PhysicsWorld2D } from 'engine/physics/PhysicsWorld2D.js';
import { genreRegistry, type GenreGameInterface } from 'engine/GenreRegistry.js';
import { CharacterAnimationController } from 'engine/CharacterAnimationController.js';
import { getDefaultCharacterUrl, mergeCharacterConfig, getSkeletonHeight } from 'engine/CharacterConfig.js';
import { buildAnimationList } from 'engine/AnimationPacks.js';
import { CharacterLoader } from 'engine/loaders/CharacterLoader.js';
import { GameHUD } from './GameHUD.js';
import { WorldGenerator } from './WorldGenerator.js';
import { Physics2DPlayerController } from './Physics2DPlayerController.js';
import { Physics2DCamera } from './Physics2DCamera.js';
import { DEFAULT_PHYSICS } from './PhysicsConfig.js';
import { bitmagicCharacterFactory, BITMAGIC_CONFIG, updateBitmagicEyeBlink } from './BitmagicPlayerCharacter.js';
import { CollisionGroup, CollisionMask, makeCollisionGroups } from 'engine/CollisionLayers.js';
import { findValidSpawnPosition2D } from 'engine/SpawnHelper2D.js';

export class Physics2DGame implements GenreGameInterface {
    private engine: EngineLike;
    private worldProfileData: WorldProfileData;
    private gameData: GameData | null;
    public hud: GameHUD;

    private physicsWorld: PhysicsWorld2D | null = null;
    private worldGenerator: WorldGenerator | null = null;
    private playerController: Physics2DPlayerController | null = null;
    private cameraController: Physics2DCamera | null = null;
    private animationController: CharacterAnimationController | null = null;
    private characterLoader: CharacterLoader | null = null;
    private playerGroup: THREE.Group | null = null;
    private playerBody: RAPIER2D.RigidBody | null = null;
    private spawnX = 0;
    private spawnY = 3;

    constructor(engine: EngineLike, worldProfileData: WorldProfileData, gameData?: GameData) {
        this.engine = engine;
        this.worldProfileData = worldProfileData;
        this.gameData = gameData ?? null;

        const gameName = this.gameData?.gameName;
        if (!gameName) {
            throw new Error('[Physics2DGame] gameName is required in gameData');
        }
        this.hud = new GameHUD();
    }

    async load(gameId: string): Promise<void> {
        this.physicsWorld = this.engine.physicsWorld2D ?? null;
        if (!this.physicsWorld) {
            throw new Error('[Physics2DGame] physicsWorld2D not initialized. Ensure game.json has physicsMode: "2d"');
        }

        this.physicsWorld.setGravity({ x: 0, y: DEFAULT_PHYSICS.gravity });

        // Disable pointer lock — 2D games use free mouse
        const plm = this.engine.getPointerLockManager?.();
        if (plm) {
            plm.setFreeMouseMode(true);
        }

        this.worldGenerator = new WorldGenerator(this.physicsWorld, this.engine, this.worldProfileData, this.gameData ?? undefined);
        await this.worldGenerator.generateWorld();

        this.setupLighting();
        await this.loadCharacter();
        this.setupCamera();

        this.hud.show();

        this.hud.setCustomControls([
            { key: 'A/D', action: 'Move left/right' },
            { key: 'W/Space', action: 'Jump' },
        ]);

        console.log(`[Physics2DGame] Loaded: ${gameId}`);
    }

    private setupLighting(): void {
        if (!this.engine.scene) return;

        const hemi = new THREE.HemisphereLight(0x87ceeb, 0x556633, 0.7);
        hemi.name = 'Physics2D_HemiLight';
        this.engine.scene.add(hemi);

        const dir = new THREE.DirectionalLight(0xfff5e0, 0.9);
        dir.name = 'Physics2D_DirectionalLight';
        dir.position.set(5, 10, 10);
        dir.castShadow = true;
        this.engine.scene.add(dir);
    }

    private async loadCharacter(): Promise<void> {
        if (!this.engine.scene || !this.physicsWorld) return;

        const wpd = this.worldProfileData as unknown as Record<string, unknown>;
        this.spawnX = typeof wpd.playerSpawnX === 'number' ? wpd.playerSpawnX : 0;
        this.spawnY = typeof wpd.playerSpawnY === 'number' ? wpd.playerSpawnY : 3;

        this.playerGroup = new THREE.Group();
        this.playerGroup.name = 'Physics2D_Player';

        const charUrl = getDefaultCharacterUrl();
        const gltf = await new Promise<any>((resolve, reject) => {
            this.engine.loader.load(charUrl, resolve, undefined, reject);
        });

        const character = gltf.scene as THREE.Object3D;

        // Scale skeleton to match Bitmagic character height
        const skeletonHeight = getSkeletonHeight();
        const targetHeight = BITMAGIC_CONFIG.targetHeight;
        const scale = targetHeight / skeletonHeight;
        character.scale.setScalar(scale);

        this.playerGroup.add(character);
        this.playerGroup.position.set(this.spawnX, this.spawnY, 0);
        this.engine.scene.add(this.playerGroup);

        // Animation controller with gameDataProvider so Mixamo animations load
        const animConfig = mergeCharacterConfig(this.worldProfileData.characterConfig);
        this.animationController = new CharacterAnimationController(animConfig);
        const baseAnimations = buildAnimationList();
        await this.animationController.initializeWithCharacter(
            character,
            gltf,
            this.engine.loader,
            baseAnimations,
            () => {
                const gd = this.engine.getGameData?.();
                return gd ? { assets: gd.assets as unknown[], scene: this.engine.scene } : null;
            },
        );

        // CharacterLoader handles skeleton adjustment, block character creation,
        // scene placement, feet offset, and Mixamo bone blending during update.
        this.characterLoader = new CharacterLoader(this.engine);
        this.characterLoader.setAnimationController(this.animationController);
        this.characterLoader.setCharacterGroup(this.playerGroup);
        this.characterLoader.adjustSkeletonPosition(character);
        this.characterLoader.createBlockCharacter(character, bitmagicCharacterFactory);
        character.visible = false;

        // Measure block character feet offset (same as CharacterLoader stores internally).
        // This is needed so the player controller can position the playerGroup correctly,
        // matching CharacterLoader.syncCharacterWithPhysics.
        const blockRenderer = this.characterLoader.getBlockCharacterRenderer()!;
        const blockRoot = blockRenderer.getRoot();
        blockRoot.updateMatrixWorld(true);
        const blockBox = new THREE.Box3().setFromObject(blockRoot);
        const blockFeetOffset = blockBox.min.y - blockRoot.position.y;
        // 2D capsule from block character dimensions
        const dims = bitmagicCharacterFactory.getCharacterDimensions();
        const capsuleHeight = dims.height;
        const capsuleRadius = Math.min(dims.width, dims.depth) / 2;
        const halfCylinder = Math.max(0, (capsuleHeight - 2 * capsuleRadius) / 2);

        const R = getRapier2D();

        // Validate spawn: raycast to find solid ground at the configured X position.
        // World colliders already exist (generateWorld ran and stepped physics).
        const validatedSpawn = findValidSpawnPosition2D(
            this.physicsWorld, this.spawnX, this.spawnY, capsuleHeight / 2,
        );
        this.spawnX = validatedSpawn.x;
        this.spawnY = validatedSpawn.y - capsuleHeight / 2;
        this.playerGroup.position.set(this.spawnX, this.spawnY, 0);

        const bodyDesc = R.RigidBodyDesc.dynamic()
            .setTranslation(validatedSpawn.x, validatedSpawn.y)
            .setCanSleep(false)
            .setCcdEnabled(true);
        bodyDesc.lockRotations();
        this.playerBody = this.physicsWorld.createRigidBody(bodyDesc);

        const colliderDesc = R.ColliderDesc.capsule(halfCylinder, capsuleRadius)
            .setFriction(0.4)
            .setRestitution(0.0)
            .setCollisionGroups(makeCollisionGroups(CollisionGroup.PLAYER, CollisionMask.PLAYER))
            .setSolverGroups(makeCollisionGroups(CollisionGroup.PLAYER, CollisionMask.PLAYER));
        this.physicsWorld.createCollider(colliderDesc, this.playerBody);

        this.playerController = new Physics2DPlayerController(
            this.playerGroup,
            this.playerBody,
            this.physicsWorld,
            capsuleHeight,
            blockFeetOffset,
        );
        this.playerController.setAnimationController(this.animationController);
    }

    private setupCamera(): void {
        if (!this.engine.camera) return;

        this.cameraController = new Physics2DCamera(this.engine.getDefaultCamera());
        this.cameraController.setDistance(12);
        this.cameraController.setVerticalOffset(2);
        this.cameraController.setSmoothSpeed(5);
        this.cameraController.setLookAhead(0.15);

        if (this.playerGroup) {
            this.cameraController.setTarget(this.playerGroup);
        }
    }

    update(deltaTime: number): void {
        // Respawn if fallen below -100
        if (this.playerBody && this.playerBody.isValid()) {
            const pos = this.playerBody.translation();
            if (pos.y < -100) {
                const dims = bitmagicCharacterFactory.getCharacterDimensions();
                this.playerBody.setTranslation({ x: this.spawnX, y: this.spawnY + dims.height / 2 }, true);
                this.playerBody.setLinvel({ x: 0, y: 0 }, true);
            }
        }

        if (this.playerController) {
            this.playerController.update(deltaTime);
        }

        if (this.animationController) {
            this.animationController.update(deltaTime);
        }

        updateBitmagicEyeBlink(deltaTime);

        // CharacterLoader.updateBlockCharacter handles Mixamo bone blending
        // and block root repositioning (feet alignment).
        if (this.characterLoader && this.playerGroup) {
            const worldPos = this.playerGroup.getWorldPosition(new THREE.Vector3());
            this.characterLoader.updateBlockCharacter(worldPos);
        }

        this.worldGenerator?.update();

        if (this.cameraController) {
            if (this.playerController) {
                const vel = this.playerController.getVelocity();
                this.cameraController.setTargetVelocityX(vel.x);
            }
            this.cameraController.update(deltaTime);
        }
    }

    dispose(): void {
        this.playerController?.dispose();
        this.cameraController?.dispose();
        this.worldGenerator?.dispose();

        if (this.playerBody && this.physicsWorld && this.playerBody.isValid()) {
            this.physicsWorld.removeRigidBodyImmediate(this.playerBody);
        }

        if (this.playerGroup && this.engine.scene) {
            this.engine.scene.remove(this.playerGroup);
        }

        const blockRenderer = this.characterLoader?.getBlockCharacterRenderer?.();
        if (blockRenderer && this.engine.scene) {
            this.engine.scene.remove(blockRenderer.getRoot());
        }

        this.animationController?.dispose();
        blockRenderer?.dispose();
        this.hud.dispose();
    }

    onWindowResize(): void {
        // Camera handled by Three.js automatically
    }

    getCurrentPlayer(): Physics2DPlayerController | null {
        return this.playerController;
    }
}

genreRegistry.registerGenre('Physics2D', Physics2DGame);
