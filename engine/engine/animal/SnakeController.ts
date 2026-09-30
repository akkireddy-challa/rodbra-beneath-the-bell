/**
 * SnakeController — Legless creature with serpentine locomotion
 *
 * Built on the same component architecture as AnimalController but with:
 * - A segmented body instead of four legs
 * - SnakeAnimationController for sine-wave undulation
 * - A low, compact physics capsule
 *
 * Usage is deliberately parallel to AnimalController so that both can
 * coexist in the same game and share behaviours.
 */

import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import type { INpcBehavior } from 'engine/npc/INpcBehavior.js';
import type { IPlayerMovement } from 'engine/IPlayerMovement.js';
import { LegacyNavMesh } from 'engine/LegacyNavMesh.js';
import { getGlobalNavMesh } from 'engine/VoxelNavMesh.js';
import { WalkingAndJumpingMovement } from 'engine/WalkingAndJumpingMovement.js';
import { CharacterLoader } from 'engine/loaders/CharacterLoader.js';
import { GameState } from 'engine/GameStateManager.js';
import type { Interactable } from 'types/interactable.js';
import type { IDamageable, DamageableConfig } from 'engine/IDamageable.js';
import { CollisionGroup, CollisionMask } from 'engine/CollisionLayers.js';
import RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import type { ChunkManagedObject } from 'engine/ChunkPhysicsManager.js';
import type { AnimalEyeController } from 'engine/animal/AnimalEyeController.js';
import { InteractableComponent } from 'engine/InteractableComponent.js';
import { HibernationComponent } from 'engine/character/HibernationComponent.js';
import { NavigationComponent } from 'engine/character/NavigationComponent.js';
import { SimClass, ALWAYS_FULL_LOD_STATE, getGlobalLodScheduler } from 'engine/character/CharacterLodScheduler.js';
import type { CharacterLodState } from 'engine/character/CharacterLodScheduler.js';
import { NpcLodComponent } from 'engine/npc/core/NpcLodComponent.js';
import { AgentPriority } from 'engine/AgentAvoidance.js';
import { HealthComponent } from 'engine/character/HealthComponent.js';
import { BlockExplosionComponent } from 'engine/character/BlockExplosionComponent.js';
import { RagdollComponent, DEFAULT_RAGDOLL_CONFIG, buildAnimalRagdollParts, ragdollKnockback } from 'engine/character/RagdollComponent.js';
import type { ICharacterContext } from 'engine/character/ICharacterContext.js';
import { convertGroupToLambertLighting } from 'engine/animal/AnimalController.js';
import { SnakeAnimationController, SnakeAnimationState, type WaveParams, type SnakeBodyParts } from 'engine/animal/SnakeAnimationController.js';
import { createSnakeFactory, type SnakeConfig, type SnakeDimensions } from 'engine/animal/SnakeBodyBuilder.js';
import type { BloodSplatterConfig, DeathExplosionConfig } from 'engine/effects/HitEffects.js';
import { queryPhysicsFor } from 'engine/physics/PlaneLockedPhysics.js';

/**
 * Options for {@link createSnake} factory.
 */
export interface CreateSnakeOptions {
    /** Health and death configuration */
    damageConfig?: Partial<DamageableConfig>;
    /**
     * Simulation importance tier. 'hero' (default): full fidelity at any
     * distance. 'crowd': AI and animation cadence scale with distance.
     */
    importance?: 'hero' | 'crowd';
}

/**
 * Configuration options for the fluent {@link SnakeController.configure} API.
 */
export interface SnakeConfigOptions {
    oneHitKill?: boolean;
    maxHealth?: number;
    debrisLifetimeMs?: number;
    explodeOnDeath?: boolean;
    /** Collapse into a ragdoll instead of exploding. Snakes have no jointed skeleton,
     *  so this falls back to the explosion if no ragdoll segments can be built. */
    ragdollOnDeath?: boolean;
    bloodOnHit?: boolean;
    bloodConfig?: BloodSplatterConfig;
    explodeWithGore?: boolean;
    goreConfig?: DeathExplosionConfig;
    onDeath?: (killerDirection?: THREE.Vector3) => void;
}

export class SnakeController implements Interactable, IDamageable, ChunkManagedObject, ICharacterContext {
    private character: THREE.Object3D;
    private characterBody: RAPIER.RigidBody | null = null;
    private physicsWorld: PhysicsWorld;
    private engine: EngineLike;
    private snakeName: string;
    private snakeDimensions: SnakeDimensions;
    private animationController: SnakeAnimationController;
    private characterLoader: CharacterLoader;
    private spawnPosition: THREE.Vector3;

    private hibernationComp: HibernationComponent;
    private navigationComp: NavigationComponent;
    private healthComp: HealthComponent;
    private explosionComp: BlockExplosionComponent;
    private ragdollComp: RagdollComponent;

    private behavior: INpcBehavior | null = null;
    private moveSpeed: number;
    private currentSpeed = 0;
    private navMesh: LegacyNavMesh | null = null;
    private movementSystem: IPlayerMovement;

    private _isGrounded = false;
    isGrounded = false;

    private eyeController: AnimalEyeController | null = null;
    private interactableComponent: InteractableComponent | null = null;
    voxelBlockSize = 1.0;

    private noProgressTimer = 0;
    private forcedTargetCooldown = 0;
    private smoothedY: number | null = null;

    // ── Character LOD (CharacterLodScheduler) ──
    // Simulation importance tier: 'hero' = full fidelity at any distance, 'crowd' = LOD-scaled.
    private importance: 'hero' | 'crowd' = 'hero';
    /** Per-frame LOD bookkeeping. Snakes clamp at COARSE — never VIRTUAL/HIBERNATED. */
    private lodComp: NpcLodComponent;
    /** Stamped by the CharacterLodScheduler every evaluate() (LodManagedCharacter contract). */
    lodState: CharacterLodState = ALWAYS_FULL_LOD_STATE;
    /** Meshes that START shadow-casting — the LOD shadow toggle flips exactly this set. */
    private shadowMeshes: THREE.Mesh[] = [];

    // ─── IDamageable proxies ────────────────────────────────────────────
    get onDamage() { return this.healthComp.onDamage; }
    set onDamage(cb: ((damage: number, currentHealth: number, maxHealth: number, source?: string) => void) | undefined) { this.healthComp.onDamage = cb; }
    get onDeathEffect() { return this.healthComp.onDeathEffect; }
    set onDeathEffect(cb: ((killerDirection?: THREE.Vector3) => void) | undefined) { this.healthComp.onDeathEffect = cb; }

    public onMeleeHitEffect?: (position: THREE.Vector3, direction: THREE.Vector3, damage: number) => void;
    public onProjectileHitEffect?: (position: THREE.Vector3, direction: THREE.Vector3, damage: number) => void;
    public onMeleeHit: (impactDirection?: THREE.Vector3, impulseStrength?: number) => void;

    // ─── CONSTRUCTOR (private — use SnakeController.create) ─────────────

    private constructor(
        scene: THREE.Scene,
        physicsWorld: PhysicsWorld,
        engine: EngineLike,
        spawnPosition: THREE.Vector3,
        snakeName: string,
        config: SnakeConfig,
        moveSpeed: number,
        damageableConfig?: Partial<DamageableConfig>,
    ) {
        this.moveSpeed = moveSpeed;
        this.currentSpeed = moveSpeed;
        this.physicsWorld = physicsWorld;
        this.engine = engine;
        this.snakeName = snakeName;
        this.spawnPosition = spawnPosition.clone();

        this.hibernationComp = new HibernationComponent({
            onHibernate: () => {
                if (this.characterBody) this.characterBody.setEnabled(false);
                if (this.interactableComponent) this.interactableComponent.setEnabled(false);
                this.character.visible = false;
            },
            onWake: () => {
                if (this.characterBody) this.characterBody.setEnabled(true);
                if (this.interactableComponent) this.interactableComponent.setEnabled(true);
                this.character.visible = true;
            },
        });

        this.healthComp = new HealthComponent({
            onPreDeath: () => { /* no riding to cancel */ },
            onExplode: () => { this.explosionComp.explode(); },
            onRagdoll: (deathImpulse?: THREE.Vector3) => {
                // Segmented snakes may build no ragdoll parts → fall back to the explosion.
                this.ragdollComp.ragdoll(deathImpulse);
                if (!this.ragdollComp.hasRagdoll()) this.explosionComp.explode();
            },
        }, damageableConfig);

        this.explosionComp = new BlockExplosionComponent(
            { blockSize: 0.05, forceMin: 2, forceMax: 4, debrisLifetimeMs: damageableConfig?.debrisLifetimeMs },
            {
                getEngine: () => this.engine,
                getPhysicsWorld: () => this.physicsWorld,
                getCharacter: () => this.character,
                getPhysicsBody: () => this.characterBody,
                restoreFlashImmediately: () => this.healthComp.restoreFlashImmediately(),
                collectMeshes: () => {
                    const meshes: THREE.Mesh[] = [];
                    this.character.updateMatrixWorld(true);
                    this.character.traverse((o: THREE.Object3D) => {
                        if (o instanceof THREE.Mesh) meshes.push(o);
                    });
                    return meshes;
                },
                onPostExplosion: () => this.detachFromWorld(),
            },
        );

        const snakeCombat = this.engine.getGameData?.()?.worldProfileData?.combatConfig;
        this.ragdollComp = new RagdollComponent(
            {
                ...DEFAULT_RAGDOLL_CONFIG,
                corpseLifetimeMs: damageableConfig?.debrisLifetimeMs ?? DEFAULT_RAGDOLL_CONFIG.corpseLifetimeMs,
                jointLimits: snakeCombat?.ragdollJointLimits ?? DEFAULT_RAGDOLL_CONFIG.jointLimits,
                selfCollision: snakeCombat?.ragdollSelfCollision ?? DEFAULT_RAGDOLL_CONFIG.selfCollision,
                onBodyCreated: null,
            },
            {
                getEngine: () => this.engine,
                getPhysicsWorld: () => this.physicsWorld,
                getCharacter: () => this.character,
                getPhysicsBody: () => this.characterBody,
                restoreFlashImmediately: () => this.healthComp.restoreFlashImmediately(),
                collectParts: () => {
                    this.character.updateMatrixWorld(true);
                    return buildAnimalRagdollParts(this.character);
                },
                onPostRagdoll: () => this.detachFromWorld(),
            },
        );

        // Apply the creator's global combatConfig toggle unless this spawn set its own death effect.
        if (damageableConfig?.ragdollOnDeath === undefined) {
            const ragdollDefault = this.engine.getGameData?.()?.worldProfileData?.combatConfig?.ragdollOnDeath;
            if (ragdollDefault !== undefined) {
                this.healthComp.getDamageableConfig().ragdollOnDeath = ragdollDefault;
            }
        }

        this.onMeleeHit = this.defaultMeleeHitHandler.bind(this);

        // LOD bookkeeping. Snakes clamp at COARSE (no dead-reckoned VIRTUAL
        // path following for the segmented body), so the body enable/disable
        // transition hooks never fire in practice; shadows still ring-toggle.
        this.lodComp = new NpcLodComponent(
            {
                setBodyEnabled: (enabled) => {
                    if (this.characterBody && this.characterBody.isValid()) {
                        this.characterBody.setEnabled(enabled);
                    }
                },
                snapBodyToVisual: () => {
                    if (!this.characterBody || !this.characterBody.isValid()) return;
                    const capsuleH = this.characterLoader.getCapsuleHeight();
                    const p = this.character.position;
                    this.characterBody.setTranslation({ x: p.x, y: p.y + capsuleH / 2, z: p.z }, true);
                    this.characterBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
                },
                setShadowsEnabled: (enabled) => {
                    for (const mesh of this.shadowMeshes) mesh.castShadow = enabled;
                },
            },
            SimClass.COARSE,
        );

        this.characterLoader = new CharacterLoader(engine);

        if (!getGlobalNavMesh()?.isReady()) {
            this.navMesh = new LegacyNavMesh(engine);
        }

        // Build character
        this.character = new THREE.Group();
        this.character.name = `SnakeController_${snakeName}`;
        this.character.position.copy(spawnPosition);

        const charGroup = new THREE.Group();
        charGroup.name = `${snakeName}_BlockCharacter`;
        this.character.add(charGroup);

        const factory = createSnakeFactory(config);
        factory.createBlockCharacter(charGroup);
        this.snakeDimensions = factory.snakeDimensions ?? {
            width: 0.15, height: 0.15, depth: 1.5, segmentSpacing: 0.1, segmentCount: 12,
        };

        // Convert materials to Lambert for local lighting (shared with AnimalController)
        convertGroupToLambertLighting(charGroup);

        if (charGroup.userData.eyeController) {
            this.eyeController = charGroup.userData.eyeController as AnimalEyeController;
        }

        this.healthComp.initDamageFlash(charGroup);
        scene.add(this.character);

        // Physics capsule: low and compact for a ground-level creature
        this.character.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(this.character);
        const capsuleHeight = Math.max(0.15, this.snakeDimensions.height * 0.8);
        const capsuleRadius = Math.max(0.08, Math.min(this.snakeDimensions.width * 0.5, 0.25));
        this.characterLoader.setCapsuleDimensions(capsuleHeight, capsuleRadius);

        const feetOffsetY = box.min.y - this.character.position.y;
        this.characterLoader.setFeetOffset(feetOffsetY);

        // Navigation
        this.navigationComp = new NavigationComponent(
            moveSpeed,
            {
                getCharacter: () => this.character,
                getPhysicsBody: () => this.characterBody,
                getPhysicsWorld: () => this.physicsWorld,
                getEngine: () => this.engine,
                getNavMesh: () => this.navMesh!,
                isGrounded: () => this._isGrounded,
                runMovementSystem: (dt, dir, hop) => this.runMovementSystem(dt, dir, hop),
                getAgentRadius: () => this.characterLoader.getCapsuleRadius(),
                getAgentPriority: () => AgentPriority.ANIMAL,
            },
            { enabled: true, getCharacterDepth: () => this.snakeDimensions.depth },
        );
        this.navigationComp.initializePreviousPosition(spawnPosition);

        // Movement system (reuse walking system — gravity keeps snake on ground)
        this.movementSystem = new WalkingAndJumpingMovement(moveSpeed, {
            gravity: -35.0,
            terminalVelocity: 53.0,
            jumpHeight: 0.3,
            airControlMultiplier: 0.3,
            groundFriction: 0.92,
            airFriction: 0.98,
        });
        (this.movementSystem as WalkingAndJumpingMovement).enableStuckDetection = false;

        // Animation controller (terrain sampling for idle body + sloped trail seed)
        this.animationController = new SnakeAnimationController();
        this.animationController.setTerrainConform({
            sampleGroundY: (wx, wz) => this.sampleGroundFeetY(wx, wz),
        });
        void this.animationController.initializeWithCharacter(this.character, null, null, []);

        // Physics body
        this.characterBody = this.characterLoader.createPhysicsBody(
            this.spawnPosition, this.physicsWorld, -35.0,
            CollisionGroup.ANIMAL, CollisionMask.ANIMAL,
        );

        this.physicsWorld.setUserData(this.characterBody, {
            __type: 'snake',
            snakeController: this,
            agentRadius: this.characterLoader.getCapsuleRadius(),
        });

        this.syncCharacterWithPhysics();

        if (this.characterBody) {
            this.interactableComponent = new InteractableComponent(this.physicsWorld, {
                interactable: this,
                object3D: this.character,
                physicsBody: this.characterBody,
                radius: 2.0,
            });
        }

        this.storePhysicsBodyInMeshes();

        // Shadow LOD: snapshot the meshes that START shadow-casting once.
        const shadowCasters: THREE.Mesh[] = [];
        this.character.traverse((child: THREE.Object3D) => {
            const mesh = child as THREE.Mesh;
            if (mesh.isMesh && mesh.castShadow) shadowCasters.push(mesh);
        });
        this.shadowMeshes = shadowCasters;
    }

    // ─── STATIC FACTORY ─────────────────────────────────────────────────

    static async create(
        scene: THREE.Scene,
        physicsWorld: PhysicsWorld,
        engine: EngineLike,
        spawnPosition: THREE.Vector3,
        snakeName: string,
        config: SnakeConfig,
        options?: CreateSnakeOptions,
    ): Promise<SnakeController> {
        const adjusted = spawnPosition.clone();
        if ((spawnPosition.y === 0 || isNaN(spawnPosition.y)) && engine.getWorldHeightAt) {
            const h = engine.getWorldHeightAt(spawnPosition.x, spawnPosition.z);
            if (h !== undefined && h !== null && !isNaN(h)) adjusted.y = h;
        }
        const speed = config.moveSpeed ?? 2.0;
        return new SnakeController(scene, physicsWorld, engine, adjusted, snakeName, config, speed, options?.damageConfig);
    }

    // ─── UPDATE ─────────────────────────────────────────────────────────

    update(deltaTime: number): void {
        if (this.hibernationComp.isHibernating() || this.hibernationComp.isPhysicsHeld()) return;

        if (this.explosionComp.hasExplodedBlocks()) this.explosionComp.syncExplodedBlocks();
        // Ragdoll sync ring-gated on the LIVE scheduler stamp: near corpses
        // keep settling, far ones freeze until the camera returns.
        if (this.ragdollComp.hasRagdoll() && this.lodState.ring <= 1) this.ragdollComp.syncRagdoll();
        if (this.healthComp.isExploded() || this.healthComp.isDead()) return;

        // Per-frame LOD bookkeeping: adopt this frame's scheduler stamp (COARSE
        // clamp — snakes never disembody), accumulate dt for gated work.
        const scheduler = getGlobalLodScheduler();
        this.lodComp.beginFrame(deltaTime, scheduler.isEnabled() ? this.lodState : ALWAYS_FULL_LOD_STATE);
        this.hibernationComp.setSimClass(this.lodComp.state.simClass);

        const gsMgr = this.engine.gameStateManager;
        const isPlaying = gsMgr ? gsMgr.isState(GameState.PLAYING) : true;

        if (!isPlaying) {
            this.updateStationaryFrame(deltaTime);
            return;
        }

        if (this.navigationComp.updateIdle(deltaTime)) {
            this.updateStationaryFrame(deltaTime);
            return;
        }

        if (this.navigationComp.updateStuck()) {
            // Legacy dt-dropping early return (pre-LOD this frame never
            // reached the behavior block) — see NpcLodComponent.dropAccumulators.
            this.lodComp.dropAccumulators();
            return;
        }

        // Behavior at the LOD AI cadence (aiDt = accumulated time since the
        // last granted tick; equals deltaTime for FULL, i.e. heroes/ring 0).
        const aiDt = this.lodComp.consumeAiTick();
        if (this.forcedTargetCooldown > 0) {
            this.forcedTargetCooldown -= deltaTime;
        } else if (aiDt !== null && this.behavior) {
            const cur = this.navigationComp.getCurrentTarget();
            const next = this.behavior.update(aiDt, this.character.position, cur);
            if (next && (!cur || !next.equals(cur))) this.setTargetPosition(next);
            else if (!next && cur) this.setTargetPosition(null);
        }

        // Movement stays per-frame (snakes are rare — minimal LOD scope).
        if (this.navigationComp.hasPath()) {
            this.navigationComp.moveTowardTarget(deltaTime);
        } else {
            const r = Math.max(this.snakeDimensions.width, this.snakeDimensions.depth) / 2;
            this.navigationComp.updateNoPathApproach(deltaTime, r);
        }

        this.currentSpeed = this.navigationComp.getCurrentSpeed();

        if (this.currentSpeed < 0.1) {
            this.noProgressTimer += deltaTime;
            if (this.noProgressTimer > 8.0) {
                this.noProgressTimer = 0;
                this.forcedTargetCooldown = 3.0;
                const angle = Math.random() * Math.PI * 2;
                const dist = 3 + Math.random() * 8;
                this.setTargetPosition(new THREE.Vector3(
                    this.spawnPosition.x + Math.cos(angle) * dist,
                    this.character.position.y,
                    this.spawnPosition.z + Math.sin(angle) * dist,
                ));
            }
        } else {
            this.noProgressTimer = 0;
        }

        // Animation at the LOD anim cadence (accumulated dt keeps the wave
        // phase and Y-smoothing consistent across skipped frames).
        const animDt = this.lodComp.consumeAnimTick();
        if (animDt !== null) {
            this.updateAnimation(animDt, this.currentSpeed > 0.1);
        }
        this.updateEyes(deltaTime);
    }

    /**
     * Run a single frame where the snake holds still (not playing /
     * idling): zero-input movement, idle animation (anim-tick gated), and eye
     * update. Ends by dropping the dt accumulators — legacy dt-dropping path
     * (see NpcLodComponent.dropAccumulators).
     */
    private updateStationaryFrame(deltaTime: number): void {
        this.runMovementSystem(deltaTime, new THREE.Vector3());
        const animDt = this.lodComp.consumeAnimTick();
        if (animDt !== null) {
            this.updateAnimation(animDt, false);
        }
        this.updateEyes(deltaTime);
        this.lodComp.dropAccumulators();
    }

    /**
     * World-space feet height at (x,z). Same layers as GameEngine.getWorldHeightAt.
     */
    private sampleGroundFeetY(x: number, z: number): number | null {
        const pw = queryPhysicsFor(this.engine);
        if (!pw) return null;
        const startY = this.character.position.y + 1.0;
        const result = pw.raycast(
            new THREE.Vector3(x, startY, z),
            new THREE.Vector3(0, -1, 0),
            3.0,
            CollisionGroup.TERRAIN | CollisionGroup.ENVIRONMENT,
        );
        return result.hasHit ? result.hitPoint.y : null;
    }

    private updateAnimation(deltaTime: number, isMoving: boolean): void {
        this.syncCharacterWithPhysics();

        // Smooth vertical movement so the head doesn't teleport on terrain edges.
        // The physics body may snap up (step climb) or fall fast (gravity),
        // but the visual character moves at roughly horizontal speed vertically.
        const targetY = this.character.position.y;
        const maxDelta = this.moveSpeed * 1.5 * deltaTime;
        const prevY = this.smoothedY ?? targetY;
        this.smoothedY = prevY + THREE.MathUtils.clamp(targetY - prevY, -maxDelta, maxDelta);
        this.character.position.y = this.smoothedY;

        this.animationController.updateAnimation(isMoving, isMoving ? this.currentSpeed : 0, this._isGrounded, false);
        this.animationController.update(deltaTime);
    }

    // ─── MOVEMENT ───────────────────────────────────────────────────────

    private runMovementSystem(deltaTime: number, dir: THREE.Vector3, shouldHop = false): void {
        if (!this.characterBody) return;
        const keys = {
            forward: dir.length() > 0, backward: false, left: false, right: false,
            ascend: shouldHop, interact: false, action: false, descend: false,
        };
        this.movementSystem.update(deltaTime, this as any, keys, true, dir, this.characterBody, this.physicsWorld);
        if (this.movementSystem.wasGroundedLastUpdate) {
            this._isGrounded = this.movementSystem.wasGroundedLastUpdate();
            this.isGrounded = this._isGrounded;
        }
    }

    private syncCharacterWithPhysics(): void {
        if (this.characterBody) {
            this.characterLoader.syncCharacterWithPhysics(this.character as THREE.Group, this.characterBody);
        }
    }

    /**
     * Remove the visible character from the scene and tear down its physics
     * body. Shared by the death-explosion and ragdoll teardown callbacks.
     */
    private detachFromWorld(): void {
        if (this.character.parent) this.character.parent.remove(this.character);
        if (this.characterBody) {
            this.physicsWorld.removeRigidBody(this.characterBody);
            this.characterBody = null;
        }
    }

    private updateEyes(deltaTime: number): void {
        if (!this.eyeController) return;
        // Eye micro-animation is a near-camera detail: ring 0 only.
        if (this.lodComp.state.ring !== 0) return;
        let playerPos: THREE.Vector3 | null = null;
        const pc = this.engine.getPlayerController?.();
        if (pc?.getPosition) playerPos = pc.getPosition();
        this.eyeController.update(deltaTime, this.character.position, playerPos);
    }

    // ─── BEHAVIOUR ──────────────────────────────────────────────────────

    setBehavior(b: INpcBehavior): void {
        if (this.behavior) this.behavior.dispose();
        this.behavior = b;
        // SnakeController implements ICharacterContext — no cast needed.
        this.behavior.initialize(this);
    }

    requestBehaviorChange(b: INpcBehavior): void {
        if (!b) { console.error('⚠️ [SnakeController] null behavior'); return; }
        this.setBehavior(b);
    }

    /** Snakes are procedural segment meshes, never voxelized skinned GLBs. */
    shatterIntoVoxels(): boolean {
        return false;
    }

    setTargetPosition(t: THREE.Vector3 | null, maxPathLength?: number): void {
        this.navigationComp.setTargetPosition(t, undefined, maxPathLength);
    }

    // ─── GETTERS (ICharacterContext) ────────────────────────────────────

    getEngine(): EngineLike { return this.engine; }
    getNavMesh(): LegacyNavMesh | null { return this.navMesh; }
    getPosition(): THREE.Vector3 { return this.character.position; }
    getCharacter(): THREE.Object3D { return this.character; }
    getPhysicsWorld(): PhysicsWorld { return this.physicsWorld; }
    getPhysicsBody(): RAPIER.RigidBody | null { return this.characterBody; }
    getSnakeName(): string { return this.snakeName; }
    /** Always false — stun-on-hit was removed; kept for ICharacterContext and shipped game code. */
    isStunned(): boolean { return false; }
    getMoveSpeed(): number { return this.moveSpeed; }

    /** Current movement speed in m/s, sampled from navigation each update. */
    getCurrentSpeed(): number { return this.currentSpeed; }

    /** The planned route, as a copy. Empty when no path is active. */
    getPath(): THREE.Vector3[] { return this.navigationComp.getPath(); }
    /** Index of the waypoint the snake is currently heading for. */
    getCurrentWaypointIndex(): number { return this.navigationComp.getCurrentWaypointIndex(); }
    /** The waypoint being headed for, or null with no path / at the end. */
    getCurrentWaypoint(): THREE.Vector3 | null { return this.navigationComp.getCurrentWaypoint(); }

    /**
     * True while still walking a planned route. Prefer this over
     * `getPath().length === 0` — arrival advances the waypoint index past the
     * final waypoint rather than clearing the array, so the length only drops to
     * zero once the stuck-detector wipes the path (~2 s), which reads as a long
     * unexplained pause.
     */
    isFollowingPath(): boolean { return this.navigationComp.hasPath(); }
    /** Inverse of `isFollowingPath()`; true when there is no active path at all. */
    hasReachedDestination(): boolean { return !this.navigationComp.hasPath(); }

    /**
     * Live block-explosion debris — mesh + rapier body per piece. Empty before
     * death or once every piece has been removed.
     */
    getExplodedDebris(): { mesh: THREE.Mesh; body: RAPIER.RigidBody }[] {
        return this.explosionComp.getDebrisPieces();
    }

    /**
     * Remove one debris piece (mesh + physics body). Pair with
     * `setDebrisLifetime(0)` to own lifetime yourself. True if the piece existed.
     */
    removeDebrisPiece(mesh: THREE.Mesh): boolean {
        return this.explosionComp.removeDebrisPiece(mesh);
    }

    /** Arrival tolerance for the FINAL destination, in meters (default 0.5). */
    setArrivalRadius(radius: number): void { this.navigationComp.setArrivalRadius(radius); }
    getArrivalRadius(): number { return this.navigationComp.getArrivalRadius(); }

    /**
     * Toggle agent-to-agent avoidance. Disabling keeps normal path-following but
     * this snake stops steering around other agents, and they stop treating it
     * as an obstacle. Enabled by default.
     */
    setAvoidanceEnabled(enabled: boolean): void {
        this.navigationComp.setAvoidanceEnabled(enabled);
        // No body before spawn — the navigation flag above still holds.
        if (!this.characterBody) return;
        // Live userData reference — mutating it is what other agents' scans read.
        const ud = this.physicsWorld.getUserData(this.characterBody) as { avoidanceDisabled?: boolean } | undefined;
        if (ud) ud.avoidanceDisabled = !enabled;
    }
    isAvoidanceEnabled(): boolean { return this.navigationComp.isAvoidanceEnabled(); }

    /** Head straight to the target, skipping navmesh A*. Obstacle routing is the caller's. */
    setStraightLinePath(enabled: boolean): void { this.navigationComp.setStraightLinePath(enabled); }
    isStraightLinePath(): boolean { return this.navigationComp.isStraightLinePath(); }

    setMoveSpeed(speed: number): void {
        this.moveSpeed = Math.max(0.1, speed);
        this.navigationComp.setMoveSpeed(this.moveSpeed);
        this.movementSystem.setMoveSpeed(this.moveSpeed);
    }

    setMaxStepUpHeight(h: number): void { this.navigationComp.setMaxStepUpHeight(h); }
    getMaxStepUpHeight(): number { return this.navigationComp.getMaxStepUpHeight(); }
    setStepHopEnabled(e: boolean): void { this.navigationComp.setStepHopEnabled(e); }
    isStepHopEnabled(): boolean { return this.navigationComp.isStepHopEnabled(); }
    setRotationSpeed(r: number): void { this.navigationComp.setRotationSpeed(r); }
    getRotationSpeed(): number { return this.navigationComp.getRotationSpeed(); }

    get player(): THREE.Object3D { return this.character; }
    get characterHeight(): number { return this.characterLoader.getCapsuleHeight(); }
    get capsuleRadius(): number { return this.characterLoader.getCapsuleRadius(); }

    get externallyControlsVerticalFeet(): boolean { return false; }

    // ─── ChunkManagedObject ─────────────────────────────────────────────

    holdPhysicsUntilReady(): void { this.hibernationComp.holdPhysicsUntilReady(); }
    releasePhysics(): void { this.hibernationComp.releasePhysics(); }
    setAlwaysActive(a: boolean): void { this.hibernationComp.setAlwaysActive(a); }

    /**
     * ChunkPhysicsManager anchor test. Game-code setAlwaysActive is respected
     * as before; crowd snakes only anchor while embodied (always, given the
     * COARSE clamp — kept for parity with AnimalController/NpcController).
     */
    isAlwaysActive(): boolean {
        if (!this.hibernationComp.isAlwaysActive()) return false;
        if (this.importance === 'hero') return true;
        const sc = this.hibernationComp.getSimClass();
        return sc === SimClass.FULL || sc === SimClass.COARSE;
    }

    /** ChunkPhysicsManager hint: only idle (goal-less) crowd snakes may chunk-hibernate. */
    canHibernate(): boolean {
        return this.importance === 'crowd' && !this.hasActiveGoal();
    }

    hibernate(): void { this.hibernationComp.hibernate(); }
    wake(): void { this.hibernationComp.wake(); }
    isHibernating(): boolean { return this.hibernationComp.isHibernating(); }

    // ─── Character LOD (LodManagedCharacter contract) ───────────────────

    /** Simulation importance tier ('hero' default = full fidelity at any distance). */
    setImportance(importance: 'hero' | 'crowd'): void {
        this.importance = importance;
    }

    getImportance(): 'hero' | 'crowd' {
        return this.importance;
    }

    /** True when this snake is going somewhere or is hostile. */
    hasActiveGoal(): boolean {
        return this.navigationComp.hasPath()
            || this.navigationComp.getCurrentTarget() !== null
            || (this.behavior?.isHostile() ?? false);
    }

    /** Dead/exploded snakes are exempt from LOD demotion (stamped FULL). */
    isDeadOrRagdolled(): boolean {
        return this.healthComp.isExploded() || this.healthComp.isDead();
    }

    // ─── Interactable ───────────────────────────────────────────────────

    onInteractStart(): boolean {
        return this.behavior?.onPlayerInteract?.() ?? false;
    }
    getInteractStartDisplayName(): string {
        return `Look at ${this.snakeName}`;
    }
    interactionEnabled(): boolean {
        return this.behavior !== null && typeof this.behavior.onPlayerInteract === 'function';
    }

    // ─── IDamageable ────────────────────────────────────────────────────

    private storePhysicsBodyInMeshes(): void {
        this.character.traverse((child: THREE.Object3D) => {
            if ((child as THREE.Mesh).isMesh) {
                const m = child as THREE.Mesh;
                m.userData.physicsBody = this.characterBody;
                m.userData.mass = 20;
                m.userData.damageableController = this;
                m.userData.snakeController = this;
                m.userData.enemyController = this;
                m.userData.collisionGroup = CollisionGroup.ANIMAL;
                m.userData.collisionMask = CollisionMask.ANIMAL;
            }
        });
    }

    public defaultMeleeHitHandler(impactDirection?: THREE.Vector3, impulseStrength = 6): void {
        if (this.healthComp.isExploded() || this.healthComp.isDead()) return;

        if (this.behavior?.onHit?.(impactDirection)) return;

        const cfg = this.healthComp.getDamageableConfig();
        const damage = cfg.oneHitKill ? this.healthComp.getMaxHealth() + 1 : impulseStrength * 2;
        const meleeImpulse = impactDirection ? ragdollKnockback(impactDirection, impulseStrength) : undefined;
        this.takeDamage(damage, 'melee', meleeImpulse);

        if (impactDirection && this.characterBody) {
            this.characterBody.applyImpulse({
                x: impactDirection.x * impulseStrength,
                y: 1.5,
                z: impactDirection.z * impulseStrength,
            }, true);
        }

        if (this.onMeleeHitEffect && impactDirection) {
            const p = this.character.position.clone();
            p.y += 0.2;
            this.onMeleeHitEffect(p, impactDirection, damage);
        }

    }

    public onProjectileCollision(projectile: { getDamage?: () => number; getDirection?: () => THREE.Vector3; getKnockback?: () => number }): void {
        if (this.healthComp.isExploded() || this.healthComp.isDead()) return;
        const damage = projectile.getDamage?.() ?? 25;
        const travelDir = projectile.getDirection?.()?.clone() ?? new THREE.Vector3(0, 0, 1);
        const dir = travelDir.clone().negate();
        this.takeDamage(damage, 'projectile', ragdollKnockback(travelDir, projectile.getKnockback?.() ?? 6));
        if (this.onProjectileHitEffect) {
            const p = this.character.position.clone();
            p.y += 0.2;
            this.onProjectileHitEffect(p, dir, damage);
        }
    }

    takeDamage(amount: number, source?: string, deathImpulse?: THREE.Vector3): void { this.healthComp.takeDamage(amount, source, deathImpulse); }
    isExploded(): boolean { return this.healthComp.isExploded(); }
    isDead(): boolean { return this.healthComp.isDead(); }
    /** True when death actually collapsed the snake into a ragdoll; `isDead()` can be true while this is false. */
    isRagdolled(): boolean { return this.healthComp.isRagdolled(); }
    /** True while the ragdoll corpse still exists — see `setCorpseLifetimeMs`. */
    hasRagdoll(): boolean { return this.ragdollComp.hasRagdoll(); }
    getHealth(): number { return this.healthComp.getHealth(); }
    getMaxHealth(): number { return this.healthComp.getMaxHealth(); }
    /** Retune max health at runtime; also refills to the new max and revives. */
    setMaxHealth(maxHealth: number): void { this.healthComp.setMaxHealth(maxHealth); }
    /** Heal by `amount`; returns whether health moved. `onDamage` does not fire on a heal. */
    heal(amount: number): boolean { return this.healthComp.heal(amount); }
    /** Restore to full health and revive if dead (clears ragdoll state). */
    resetHealth(): void { this.healthComp.resetHealth(); }
    setDamageFlashEnabled(e: boolean): void { this.healthComp.setDamageFlashEnabled(e); }
    getDamageFlash(): import('engine/effects/DamageFlash.js').DamageFlash | null { return this.healthComp.getDamageFlash(); }

    setDebrisLifetime(ms: number): void { this.explosionComp.setDebrisLifetimeMs(ms); }

    /** No-op — stun-on-hit was removed; kept because shipped game code still calls it. */
    setStunDuration(seconds: number): void { void seconds; }

    /**
     * How long the corpse lingers after a ragdoll death (ms); `<= 0` keeps it
     * until `dispose()`. Immediate, so it also retunes a body already down. At
     * spawn this comes from `damageable.debrisLifetimeMs`, which also drives
     * explosion-debris lifetime — this is the only independent control.
     */
    setCorpseLifetimeMs(ms: number): void { this.ragdollComp.setCorpseLifetimeMs(ms); }

    // ─── CONFIGURE (FLUENT API) ─────────────────────────────────────────

    /**
     * Fluent configuration matching AnimalController's API.
     */
    configure(options: SnakeConfigOptions): this {
        if (options.oneHitKill !== undefined) {
            this.healthComp.getDamageableConfig().oneHitKill = options.oneHitKill;
        }
        if (options.maxHealth !== undefined) {
            const cfg = this.healthComp.getDamageableConfig();
            cfg.maxHealth = options.maxHealth;
            cfg.health = options.maxHealth;
        }
        if (options.debrisLifetimeMs !== undefined) {
            this.explosionComp.setDebrisLifetimeMs(options.debrisLifetimeMs);
        }
        if (options.explodeOnDeath !== undefined) {
            this.healthComp.getDamageableConfig().explodeOnDeath = options.explodeOnDeath;
        }
        if (options.ragdollOnDeath !== undefined) {
            this.healthComp.getDamageableConfig().ragdollOnDeath = options.ragdollOnDeath;
        }
        if (options.bloodOnHit && this.engine.scene) {
            import('engine/effects/HitEffects.js').then(({ createBloodSplatterEffect }) => {
                this.onMeleeHitEffect = createBloodSplatterEffect(this.engine.scene!, options.bloodConfig);
            });
        }
        if (options.explodeWithGore && this.engine.scene) {
            const existingEffect = this.onDeathEffect;
            import('engine/effects/HitEffects.js').then(({ createDeathExplosionEffect }) => {
                const explosionEffect = createDeathExplosionEffect(this.engine.scene!, options.goreConfig);
                const userOnDeath = options.onDeath;
                this.onDeathEffect = (killerDirection?: THREE.Vector3) => {
                    const position = this.character.position.clone();
                    explosionEffect(position, killerDirection);
                    existingEffect?.(killerDirection);
                    userOnDeath?.(killerDirection);
                };
            });
        } else if (options.onDeath) {
            const existingEffect = this.onDeathEffect;
            this.onDeathEffect = (killerDirection?: THREE.Vector3) => {
                existingEffect?.(killerDirection);
                options.onDeath!(killerDirection);
            };
        }
        return this;
    }

    // ─── BODY PART ACCESS ───────────────────────────────────────────────

    /**
     * Access all body parts — attach custom meshes to segments for wings, legs, etc.
     */
    getBodyParts(): SnakeBodyParts { return this.animationController.getBodyParts(); }
    getHead(): THREE.Object3D | null { return this.animationController.getHead(); }
    getTail(): THREE.Object3D | null { return this.animationController.getTail(); }
    getTongue(): THREE.Object3D | null { return this.animationController.getTongue(); }
    getSegments(): THREE.Object3D[] { return this.animationController.getSegments(); }
    getSegment(index: number): THREE.Object3D | null { return this.animationController.getSegment(index); }
    getSegmentCount(): number { return this.animationController.getSegmentCount(); }

    // ─── RUNTIME LENGTH & ANIMATION TUNING ──────────────────────────────

    /**
     * Change total nose-to-tail length at runtime. Segment count stays the same;
     * spacing is scaled proportionally. Trail is reset so the body re-flows.
     */
    setTotalLength(length: number): void { this.animationController.setTotalLength(length); }

    /**
     * Tune undulation wave parameters per animation state.
     */
    setWaveParams(state: SnakeAnimationState, params: Partial<WaveParams>): void {
        this.animationController.setWaveParams(state, params);
    }

    getWaveParams(state: SnakeAnimationState): Readonly<WaveParams> {
        return this.animationController.getWaveParams(state);
    }

    // ─── DISPOSE ────────────────────────────────────────────────────────

    dispose(): void {
        // Drop out of the character LOD scheduler (covers every teardown path).
        getGlobalLodScheduler().unregisterCharacter(this);
        if (this.interactableComponent) { this.interactableComponent.dispose(); this.interactableComponent = null; }
        this.healthComp.disposeDamageFlash();
        if (this.behavior) { this.behavior.dispose(); this.behavior = null; }
        if (this.eyeController) { this.eyeController.dispose(); this.eyeController = null; }
        // Release path-conflict avoidance registration so a dead snake
        // stops counting as a planning obstacle for live agents.
        this.navigationComp.dispose();
        this.explosionComp.dispose(this.physicsWorld);
        this.ragdollComp.dispose(this.physicsWorld);
        if (this.character.parent) this.character.parent.remove(this.character);
        this.characterLoader.dispose();
        if (this.characterBody) { this.physicsWorld.removeRigidBody(this.characterBody); this.characterBody = null; }
        this.animationController.dispose();
        this.character.traverse((obj: THREE.Object3D) => {
            const mesh = obj as THREE.Mesh;
            if (mesh.isMesh) {
                if (mesh.geometry) mesh.geometry.dispose();
                if (mesh.material) {
                    if (Array.isArray(mesh.material)) mesh.material.forEach(m => m.dispose());
                    else mesh.material.dispose();
                }
            }
        });
    }
}

// ─── CONVENIENCE FACTORY ────────────────────────────────────────────────

/**
 * Create a snake and optionally auto-register it with the engine's animal registry.
 */
export async function createSnake(
    scene: THREE.Scene,
    physicsWorld: PhysicsWorld,
    engine: EngineLike,
    spawnPosition: THREE.Vector3,
    snakeName: string,
    config: SnakeConfig,
    options?: CreateSnakeOptions,
): Promise<SnakeController> {
    const snake = await SnakeController.create(scene, physicsWorld, engine, spawnPosition, snakeName, config, options);

    // Simulation importance tier (default hero — full fidelity at any distance)
    if (options?.importance) {
        snake.setImportance(options.importance);
    }

    // Auto-register with the engine's animal registry for automatic frame updates
    const registry = engine.getAnimalRegistry?.();
    if (registry) {
        registry.registerCreature(`snake_${snakeName}_${Date.now()}`, snake);
    }

    console.log(`✅ Created snake "${snakeName}" — call setBehavior() to set movement`);
    return snake;
}
