import * as THREE from 'three';
import { clone as cloneSkinnedScene } from 'three/addons/utils/SkeletonUtils.js';
import { markSharedCharacterResources, isSharedCharacterResource } from 'engine/character/SharedCharacterResources.js';
import type { EngineLike, ProjectileLike, BaseAnimationDefinition, CustomAttackMove } from 'types/game.js';
import type { IBlockCharacterFactory } from 'engine/IBlockCharacterFactory.js';
import type { BlockCharacterRenderer } from 'engine/BlockCharacterRenderer.js';
import { CharacterAnimationController } from 'engine/CharacterAnimationController.js';
import { scaleCharacterToHeight, getSkeletonHeight, getSkinnedNpcHeight } from 'engine/CharacterConfig.js';
import { LegacyNavMesh } from 'engine/LegacyNavMesh.js';
import { getGlobalNavMesh } from 'engine/VoxelNavMesh.js';
import type { IPlayerMovement } from 'engine/IPlayerMovement.js';
import { resolveRenderSyncPosition } from 'engine/renderSyncPosition.js';
import type { PlayerController } from 'engine/PlayerController.js';
import type { SkiMovementHost } from 'engine/ski/SkiMovementHost.js';
import { NpcSkiHost } from 'engine/ski/NpcSkiHost.js';
import { BlockCharacterWardrobe, CharacterLoader } from 'engine/loaders/CharacterLoader.js';
import type { LegIkTargets } from 'engine/loaders/LegIK.js';
import { applyVxlEyeSpec, getVxlEyeSpec, setVxlCharacterEyeLook, type VxlEyeLook } from 'engine/loaders/VxlCharacterEyes.js';
import type { AnimalEyeController } from 'engine/animal/AnimalEyeController.js';
import type { INpcBehavior } from 'engine/npc/INpcBehavior.js';
import { GameState, getGameStateManager } from 'engine/GameStateManager.js';
import { scheduleGameplaySeconds } from 'engine/GameplayTimers.js';
import { playerMeleeTarget, segmentHitsTarget, type NpcMeleeTarget } from 'engine/npc/behaviors/NpcMeleeTarget.js';
import { NpcWeaponComponent, type NpcMeleeWeaponOptions } from 'engine/npc/core/NpcWeaponComponent.js';
import { NpcPoseOverrideHandle, DEFAULT_NPC_POSE_OVERRIDE_OPTIONS, type NpcPoseOverrideOptions } from 'engine/npc/core/NpcPoseOverride.js';
import type { Interactable } from 'types/interactable.js';
import type { INpcVisualSystem } from 'engine/npc/visual/INpcVisualSystem.js';
import { HumanoidVisualSystem } from 'engine/npc/visual/HumanoidVisualSystem.js';
import type { IDamageable, DamageableConfig } from 'engine/IDamageable.js';
import { CollisionGroup, CollisionMask } from 'engine/CollisionLayers.js';
import { buildAnimationList } from 'engine/AnimationPacks.js';
import { CANONICAL_BONE_NAMES, findBoneByCandidates } from 'engine/SkeletonAliases.js';
import { t } from 'engine/i18n/index.js';
import { registerPhysicsBody } from 'engine/PhysicsBodyRegistry.js';
import RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import type { ChunkManagedObject } from 'engine/ChunkPhysicsManager.js';
import { InteractableComponent } from 'engine/InteractableComponent.js';
import { HibernationComponent } from 'engine/character/HibernationComponent.js';
import { getGlobalCrowd } from 'engine/npc/crowd/CrowdAgents.js';
import { getGlobalCrowdRenderer, type CrowdSlot } from 'engine/npc/crowd/CrowdRenderer.js';
import { ensureVxlCrowdVariant, type VxlCrowdVariant } from 'engine/npc/crowd/VxlCrowdVariant.js';
import { resolveFrameRow } from 'engine/npc/crowd/CrowdAnimationBake.js';
import { SimClass, ALWAYS_FULL_LOD_STATE, getGlobalLodScheduler } from 'engine/character/CharacterLodScheduler.js';
import type { CharacterLodState, LodManagedCharacter } from 'engine/character/CharacterLodScheduler.js';
import { NpcLodComponent } from 'engine/npc/core/NpcLodComponent.js';
import { NavigationComponent } from 'engine/character/NavigationComponent.js';
import { AgentPriority } from 'engine/AgentAvoidance.js';
import { HealthComponent } from 'engine/character/HealthComponent.js';
import { BlockExplosionComponent } from 'engine/character/BlockExplosionComponent.js';
import { RagdollComponent, DEFAULT_RAGDOLL_CONFIG, buildHumanoidRagdollParts, ragdollKnockback } from 'engine/character/RagdollComponent.js';
import { isPlaneLockedPhysics } from 'engine/physics/PlaneLockedPhysics.js';
import { spawnHitDebris, DEATH_BURST } from 'engine/HitDebrisSystem.js';

/**
 * How long an NPC corpse remains before the ragdoll disposes itself.
 *
 * Shorter than the shared `DEFAULT_RAGDOLL_CONFIG` 15s: that default also serves
 * the player, whose corpse should persist until respawn.
 */
const NPC_CORPSE_LIFETIME_MS = 10_000;
import type { ICharacterContext } from 'engine/character/ICharacterContext.js';
import { createVoxelDeathEffect, createDamageVisualSystem } from 'engine/effects/VoxelEffects.js';
import type { VoxelDeathEffectConfig, DamageVisualConfig, DamageVisualController } from 'engine/effects/VoxelEffects.js';
import { shatterSkinnedVoxelCharacter, prewarmSkinnedVoxelShatter, DEFAULT_BONE_VOXEL_SHATTER } from 'engine/effects/BoneVoxelShatter.js';
import { shatterScheduler } from 'engine/effects/ShatterScheduler.js';
import type { BoneVoxelShatterOptions } from 'engine/effects/BoneVoxelShatter.js';

/**
 * NpcController - AI-controlled NPC character with physics and collision handling
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * ⚠️⚠️⚠️ CRITICAL: UPDATE REQUIREMENTS ⚠️⚠️⚠️
 * ════════════════════════════════════════════════════════════════════════════════
 * 
 * **NpcController instances MUST be updated every frame!**
 * 
 * If you create an NPC directly (not via NpcManager), you MUST:
 * 1. Store the NPC reference as a CLASS PROPERTY (not a local variable!)
 * 2. Call `npc.update(deltaTime)` EVERY FRAME in your game's update loop
 * 3. Call `npc.dispose()` when done to clean up resources
 * 
 * **RECOMMENDED: Use NpcManager for automatic updates:**
 * 
 * NpcManagers auto-register with the engine's NpcRegistry on first spawn.
 * The engine handles update() and dispose() automatically.
 * 
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * ## Architecture
 * This class handles character rendering, animations, physics, and collision responses.
 * Behavior logic (target selection, decision-making) is delegated to pluggable INpcBehavior implementations.
 *
 * ## Interaction System
 * NpcController implements the Interactable interface, allowing players to interact with NPCs via E key.
 * Interaction logic is handled by the NPC's behavior via `onPlayerInteract()` method.
 * 
 * **To make an NPC interactable:**
 * - Implement `onPlayerInteract()` in your behavior class
 * - Return `true` if interaction was handled, `false` otherwise
 * - Use `getInteractStartDisplayName()` in behavior to customize the prompt text
 *
 * ## Collision Response System
 * This class uses the Template Method pattern to allow customization of hit responses:
 *
 * ### Melee Hits
 * - `onMeleeHit(impactDirection?, impulseStrength)` - Public entry point, checks conditions
 * - `onMeleeCollision(impactDirection?, impulseStrength)` - **Override this** to customize melee response
 * - Default behavior: Apply damage and physical impact (using attacker's strength)
 * - Note: Impulse strength comes from attacker (e.g., kicks=12, punches=8)
 *
 * ### Projectile Hits
 * - `onProjectileCollision(projectile)` - **Override this** to customize projectile response
 * - Default behavior: Apply damage and trigger hit effects
 */
export class NpcController implements Interactable, IDamageable, ChunkManagedObject, ICharacterContext, LodManagedCharacter {
    /** Always the group created in the constructor — typed narrowly so the
     * CharacterLoader calls that need a Group don't have to cast. */
    private character: THREE.Group;
    private characterBody: RAPIER.RigidBody;
    private physicsWorld: PhysicsWorld;
    private engine: EngineLike;

    // Shared components
    private hibernationComp: HibernationComponent;
    // Simulation importance tier: 'hero' = full fidelity at any distance, 'crowd' = LOD-scaled.
    private importance: 'hero' | 'crowd' = 'hero';
    /** Follow the game's side-on plane lock (default); false = deliberate backdrop actor. */
    private planeLockEnabled = true;
    // Per-frame LOD bookkeeping (accumulators + transition side effects).
    private lodComp: NpcLodComponent;
    /** Stamped by the CharacterLodScheduler every evaluate() (LodManagedCharacter contract). */
    lodState: CharacterLodState = ALWAYS_FULL_LOD_STATE;
    /** Meshes that START shadow-casting; the LOD component toggles exactly this set. */
    private shadowMeshes: THREE.Mesh[] = [];
    /** Consecutive VIRTUAL AI ticks with no navmesh ground under the NPC. */
    private _virtualNullGroundTicks = 0;
    private navigationComp: NavigationComponent;
    // Repath gating (see update()): the destination we last ran findPath() for,
    // and a per-NPC cooldown so a crowd of chasers doesn't A* every frame. The
    // cooldown starts at a random phase in [0, interval) so NPCs that spawn
    // together don't all repath on the same frame (which would re-create the
    // burst at a lower frequency).
    private _lastPathedTarget: THREE.Vector3 | null = null;
    private _repathCooldownS: number = Math.random() * NpcController.REPATH_MIN_INTERVAL_S;
    /** A chase target must move at least this far (m) before it's worth a new A* pathfind. */
    private static readonly REPATH_TARGET_MOVE_SQ = 0.5 * 0.5;
    /** Minimum seconds between A* pathfinds per NPC (chasers repath at ~3 Hz, not 60 Hz). */
    private static readonly REPATH_MIN_INTERVAL_S = 0.3;
    private animationController: CharacterAnimationController | null = null;
    private characterLoader: CharacterLoader;
    // True when this NPC renders the real skinned GLB (a custom Asset Forger character) instead of
    // the procedural block character — drives updateSkinnedCharacter each frame (poses + grounds).
    private renderSkinned: boolean = false;
    private modelRotationY: number = 0;
    private boneVoxelShatterOptions: BoneVoxelShatterOptions = DEFAULT_BONE_VOXEL_SHATTER;
    /** Death-shatter caches warmed for this NPC's body (see prewarmShatter). */
    private shatterPrewarmed = false;
    /**
     * Far-tier instanced rendering for `.vxl` bodies (see VxlCrowdVariant): the
     * batch slot this NPC holds while the crowd draws it, null while its own
     * skinned body is the one on screen.
     */
    private crowdSlot: CrowdSlot | null = null;
    /** The baked batch for this NPC's body type; null until the bake lands (or forever, for GLB bodies). */
    private crowdVariant: VxlCrowdVariant | null = null;
    /** Seconds into the current baked clip while in the crowd. */
    private crowdClock = 0;
    private crowdClipIndex = 0;
    /** The scene the character group lives in; where it goes back after a detach (see syncCharacterAttachment). */
    private characterParent: THREE.Object3D | null = null;
    /** True while syncCharacterAttachment has taken the group out of the scene. */
    private characterDetached = false;
    private static readonly CROWD_UNTINTED = new THREE.Color(1, 1, 1);
    private visualSystem: INpcVisualSystem; // Visual system for this NPC
    private rootBone: THREE.Bone | null = null;
    private rootBoneInitialPosition: THREE.Vector3 = new THREE.Vector3();
    private healthComp: HealthComponent;
    private explosionComp: BlockExplosionComponent;
    private ragdollComp: RagdollComponent;

    // Animation initialization promise
    private animationInitPromise: Promise<void> | null = null;

    // Behavior system
    private behavior: INpcBehavior | null = null;

    // Voxel damage visual system (enabled via enableVoxelEffects)
    private damageVisualController: DamageVisualController | null = null;
    private damageHpRatio = 1.0;

    // Unique ID for nameplate display (scene mode only)
    private npcId: string | null = null;
    // NpcIdNameplate instance (structurally typed — the class is only imported dynamically,
    // see createIdNameplate, to avoid a circular import).
    private idNameplate: { update(): void; dispose(): void } | null = null;

    // Blinking / gaze eyes for rigged voxel characters (VxlV3 eye metadata),
    // bound to THIS NPC's own meshes in the constructor; null for a character
    // with no eyes (e.g. a GLB).
    private vxlEyes: AnimalEyeController | null = null;

    private moveSpeed: number; // Set via constructor parameter
    private navMesh: LegacyNavMesh | null = null; // Fallback nav mesh (skipped when VoxelNavMesh is available)
    private movementSystem: IPlayerMovement; // Movement system (swappable)

    // This NPC's looks — mesh sets swapped into the ONE block renderer its
    // character loader owns. Nothing here owns a renderer or a skeleton binding.
    private blockWardrobe: BlockCharacterWardrobe;

    // Held pose (a seated lean, a raised hand) — see acquirePoseOverride()
    private poseOverrideHandle: NpcPoseOverrideHandle | null = null;

    // Grounded state (checked every frame like PlayerController)
    private _isGrounded: boolean = false;

    // Physics hold state (managed by DynamicObjectManager when colliders aren't ready)
    private _savedSpawnPosition: THREE.Vector3 | null = null;
    private _originalGravityScale: number = -35.0;
    
    // Track if NPC has fallen off the world (below Y = -100)
    private _hasFallenOffWorld: boolean = false;

    // Rapier trigger sensor for interaction detection
    private interactableComponent: InteractableComponent | null = null;
    
    // Optional override for interactionEnabled() - allows templates to control when NPCs are interactable
    // (e.g., disable interaction during combat/attack mode)
    private interactionEnabledOverride: (() => boolean) | null = null;


    /**
     * Callback for custom melee hit effects (blood splatter, particles, etc.)
     * Override this to add visual effects when the NPC is struck by melee.
     */
    public onMeleeHitEffect?: (position: THREE.Vector3, direction: THREE.Vector3, damage: number) => void;

    /**
     * Callback for custom projectile hit effects (sparks, impact particles, etc.)
     * Override this to add visual effects when the NPC is struck by a projectile.
     */
    public onProjectileHitEffect?: (position: THREE.Vector3, direction: THREE.Vector3, damage: number) => void;

    /** Proxy onDamage to healthComp */
    get onDamage() { return this.healthComp.onDamage; }
    set onDamage(cb: ((damage: number, currentHealth: number, maxHealth: number, source?: string) => void) | undefined) { this.healthComp.onDamage = cb; }

    /** Proxy onDeathEffect to healthComp */
    get onDeathEffect() { return this.healthComp.onDeathEffect; }
    set onDeathEffect(cb: ((killerDirection?: THREE.Vector3) => void) | undefined) { this.healthComp.onDeathEffect = cb; }

    /**
     * Callback for melee hit handling - FULLY OVERRIDABLE!
     * 
     * By default uses `defaultMeleeHitHandler()`. Override to customize:
     * 
     */
    public onMeleeHit: (impactDirection?: THREE.Vector3, impulseStrength?: number) => void;

    /**
     * Create an NPC with async animation initialization
     *
     * Use this factory method instead of the constructor for proper animation initialization.
     * 
     * **DEPRECATED**: This method is kept for backward compatibility.
     * For new code, use `createWithVisualSystem()` to support different character types (humanoids, animals, etc.).
     *
     * ⚠️⚠️⚠️ CRITICAL: You MUST update the NPC every frame! ⚠️⚠️⚠️
     * 
     * @example
     * const npc = await NpcController.create(
     *     scene, physicsWorld, engine, spawnPos,
     *     playerGLTF, characterCreator, 2.7, 0.5, baseAnimations
     * );
     */
    static async create(
        scene: THREE.Scene,
        physicsWorld: PhysicsWorld,
        engine: EngineLike,
        spawnPosition: THREE.Vector3,
        playerGLTF: any,
        characterCreator: (characterGroup: THREE.Group) => { width: number; height: number; depth: number },
        moveSpeed: number = 2.7,
        stunDuration: number = 0.5, // Ignored — stun-on-hit was removed; kept so call sites keep compiling
        baseAnimations?: any[], // BaseAnimationDefinition[] from world profile (optional - uses core animations if not provided)
        movementSystem?: IPlayerMovement, // Optional movement system (defaults to WalkingAndJumpingMovement)
        npcId?: string, // Optional unique ID for nameplate display in scene mode
        renderSkinned: boolean = false, // When true, render the GLB skinned mesh instead of the block character
        modelRotationY: number = 0, // Yaw (radians) applied to a backward-authored custom skinned mesh
        damageableConfig?: Partial<DamageableConfig> // Health/death tuning; omitted = DEFAULT_DAMAGEABLE_CONFIG
    ): Promise<NpcController> {
        // NPCs load animations dynamically just like the player!
        // Use legacy baseAnimations if provided, otherwise load core animations via buildAnimationList()
        let animationsToUse: BaseAnimationDefinition[];
        if (baseAnimations && baseAnimations.length > 0) {
            console.log(`📦 NpcController: Using provided baseAnimations (${baseAnimations.length} animations)`);
            animationsToUse = baseAnimations;
        } else {
            console.log(`🎬 NpcController: Loading core animations dynamically (same as player)`);
            animationsToUse = buildAnimationList();
        }
        
        const humanoidSystem = new HumanoidVisualSystem(engine, playerGLTF, animationsToUse);
        
        // Convert characterCreator to IBlockCharacterFactory
        let dimensions: { width: number; height: number; depth: number } | null = null;
        const blockFactory: IBlockCharacterFactory = {
            createBlockCharacter: (characterGroup: THREE.Group) => {
                dimensions = characterCreator(characterGroup);
            },
            getCharacterDimensions: () => {
                if (!dimensions) {
                    throw new Error('getCharacterDimensions called before createBlockCharacter');
                }
                return dimensions;
            }
        };

        // Use new visual system-based creation
        return await NpcController.createWithVisualSystem(
            scene,
            physicsWorld,
            engine,
            spawnPosition,
            humanoidSystem,
            blockFactory,
            moveSpeed,
            stunDuration,
            movementSystem,
            npcId,
            renderSkinned,
            modelRotationY,
            damageableConfig
        );
    }

    /**
     * Create an NPC with a visual system (NEW - RECOMMENDED)
     *
     * Use this method to create NPCs with different visual types (humanoids, animals, etc.).
     * The visual system handles model loading, animations, movement, and block character creation.
     *
     * ════════════════════════════════════════════════════════════════════════════
     * ⚠️⚠️⚠️ CRITICAL: You MUST update the NPC every frame! ⚠️⚠️⚠️
     * ════════════════════════════════════════════════════════════════════════════
     * 
     * After creating an NPC, you MUST:
     * 1. Store the reference as a CLASS PROPERTY (not local variable!)
     * 2. Call `npc.update(deltaTime)` EVERY FRAME in your game loop
     * 
     * ════════════════════════════════════════════════════════════════════════════
     *
     * @example
     * // Humanoid NPC
     * const humanoidSystem = new HumanoidVisualSystem(engine, playerGLTF, baseAnimations);
     * this.humanoidNPC = await NpcController.createWithVisualSystem(
     *     scene, physicsWorld, engine, spawnPos, humanoidSystem, blockFactory, 2.7, 0.5
     * );
     * // Then in update(): if (this.humanoidNPC) this.humanoidNPC.update(deltaTime);
     * 
     * @example
     * // Animal NPC
     * const animalSystem = new AnimalVisualSystem(engine, 'models/wolf.glb', baseAnimations, animalBlockFactory);
     * await animalSystem.loadModel(); // Must load model first
     * this.wolfNPC = await NpcController.createWithVisualSystem(
     *     scene, physicsWorld, engine, spawnPos, animalSystem, animalBlockFactory, 3.0, 0.5
     * );
     * // Then in update(): if (this.wolfNPC) this.wolfNPC.update(deltaTime);
     */
    static async createWithVisualSystem(
        scene: THREE.Scene,
        physicsWorld: PhysicsWorld,
        engine: EngineLike,
        spawnPosition: THREE.Vector3,
        visualSystem: INpcVisualSystem,
        blockCharacterFactory: IBlockCharacterFactory,
        moveSpeed: number = 2.7,
        stunDuration: number = 0.5, // Ignored — stun-on-hit was removed; kept so call sites keep compiling
        movementSystem?: IPlayerMovement, // Optional - if not provided, visualSystem.createMovementSystem() will be used
        npcId?: string, // Optional unique ID for nameplate display in scene mode
        renderSkinned: boolean = false, // When true, render the GLB skinned mesh instead of the block character
        modelRotationY: number = 0, // Yaw (radians) applied to a backward-authored custom skinned mesh
        damageableConfig?: Partial<DamageableConfig> // Health/death tuning; omitted = DEFAULT_DAMAGEABLE_CONFIG
    ): Promise<NpcController> {
        // Ensure model is loaded
        await visualSystem.loadModel();

        // Create NPC instance using private constructor with visual system
        const npc = new NpcController(
            scene, physicsWorld, engine, spawnPosition, visualSystem,
            blockCharacterFactory, moveSpeed, stunDuration, movementSystem, npcId,
            damageableConfig, renderSkinned, modelRotationY
        );

        // Wait for animations to initialize before returning
        await npc.waitForAnimations();

        return npc;
    }

    private constructor(
        scene: THREE.Scene,
        physicsWorld: PhysicsWorld,
        engine: EngineLike,
        spawnPosition: THREE.Vector3,
        visualSystem: INpcVisualSystem,
        blockCharacterFactory: IBlockCharacterFactory,
        moveSpeed: number = 2.7,
        stunDuration: number = 0.5, // Ignored — stun-on-hit was removed; kept so call sites keep compiling
        movementSystem?: IPlayerMovement, // Optional - if not provided, visualSystem.createMovementSystem() will be used
        npcId?: string, // Optional unique ID for nameplate display
        damageableConfig?: Partial<DamageableConfig>,
        renderSkinned: boolean = false, // When true, render the GLB skinned mesh instead of the block character
        modelRotationY: number = 0 // Yaw (radians) applied to a backward-authored custom skinned mesh
    ) {
        this.moveSpeed = moveSpeed;
        this.renderSkinned = renderSkinned;
        this.modelRotationY = modelRotationY;
        this.hibernationComp = new HibernationComponent({
            onHibernate: () => {
                // Hide EVERY visual, not just `character`. For a block-rendered
                // NPC the GLB is already invisible (bone source only), so hiding
                // it alone froze the simulation while the block character kept
                // issuing its ~19 draw calls every frame. Measured: 30 hibernated
                // NPCs were still drawing all 570 of their meshes, about 75% of
                // the scene's main-pass draw calls — with the whole environment
                // costing 123.
                this.setAllVisualsVisible(false);
                if (this.characterBody) this.characterBody.setEnabled(false);
                if (this.interactableComponent) this.interactableComponent.setEnabled(false);
            },
            onWake: () => {
                this.setAllVisualsVisible(true);
                if (this.characterBody) {
                    this.characterBody.setEnabled(true);
                    this.characterBody.setGravityScale(this._originalGravityScale, true);
                }
                if (this.interactableComponent) this.interactableComponent.setEnabled(true);
            },
        });
        // DEFAULT: always-active (the engine's safe default for characters).
        // An always-active NPC keeps simulating AND keeps the terrain chunk
        // beneath it physics-active even when that chunk leaves the camera
        // frustum. Terrain colliders are toggled by frustum visibility and the
        // kinematic character controller treats a disabled collider as absent —
        // so a non-anchored NPC whose ground chunk falls outside the frustum
        // (common: a thin ground slab sits below the view while the NPC's body
        // still renders) finds no floor and sinks through the world. GAME CODE
        // may call setAlwaysActive(false) to let non-critical entities hibernate
        // off-screen for perf. See docs/spawning-system.md "Entity Activation".
        this.hibernationComp.setAlwaysActive(true);
        this.physicsWorld = physicsWorld;
        this.engine = engine;
        this.visualSystem = visualSystem;
        this.spawnPosition = spawnPosition.clone(); // Store for initialization

        // Initialize health component
        this.healthComp = new HealthComponent({
            onPreDeath: () => {
                this.behavior?.onNpcDeath?.();
            },
            onExplode: () => {
                this.explodeCharacter();
            },
            onRagdoll: (deathImpulse?: THREE.Vector3) => {
                const collapsed = this.ragdollComp.ragdoll(deathImpulse);
                // The burst fires either way — the NPC died regardless of whether
                // its body could be decomposed into limbs. Guarded because this
                // runs inside onRagdoll: anything thrown here would stop
                // HealthComponent marking the character ragdolled, leaving it
                // half-dead. A missing particle effect must never do that.
                try {
                    this.spawnDeathBurst(deathImpulse);
                } catch (error) {
                    console.warn('[NPC] death burst failed (ignored):', error);
                }
                if (!collapsed) {
                    console.warn(
                        `[NPC] ${this.npcId ?? 'npc'} could not ragdoll — falling back to the `
                        + 'non-ragdoll death path. Ragdolls need a block-character renderer to '
                        + 'decompose into limbs.',
                    );
                }
                return collapsed;
            },
        }, damageableConfig);

        // Initialize explosion component
        this.explosionComp = new BlockExplosionComponent(
            { blockSize: 0.1, forceMin: 4, forceMax: 6, debrisLifetimeMs: damageableConfig?.debrisLifetimeMs, onBodyCreated: (body) => registerPhysicsBody(body, 'npc') },
            {
                getEngine: () => this.engine,
                getPhysicsWorld: () => this.physicsWorld,
                getCharacter: () => this.character,
                getPhysicsBody: () => this.characterBody,
                restoreFlashImmediately: () => this.healthComp.restoreFlashImmediately(),
                collectMeshes: () => {
                    const meshes: THREE.Mesh[] = [];
                    const blockCharacterRenderer = this.characterLoader.getBlockCharacterRenderer();
                    if (blockCharacterRenderer) {
                        // Skinned NPCs never pose the block character in life, so snapshot the live
                        // pose + position into it first; else debris spawns back at the spawn point.
                        if (this.renderSkinned) this.characterLoader.updateBlockCharacter(this.character.position);
                        blockCharacterRenderer.getRoot().updateMatrixWorld(true);
                        blockCharacterRenderer.getRoot().traverse((obj: THREE.Object3D) => {
                            if (obj instanceof THREE.Mesh) meshes.push(obj);
                        });
                    }
                    return meshes;
                },
                onPostExplosion: () => this.removeCharacterAfterExplosion(),
            },
        );

        // Ragdoll component — alternative death effect (ragdollOnDeath).
        const npcCombat = this.engine.getGameData?.()?.worldProfileData?.combatConfig;
        this.ragdollComp = new RagdollComponent(
            {
                ...DEFAULT_RAGDOLL_CONFIG,
                // 10s, not the shared 15s default: a corpse that lingers past
                // the fight becomes scenery the player has to read around. An
                // explicit `debrisLifetimeMs` on the spawn still wins.
                corpseLifetimeMs: damageableConfig?.debrisLifetimeMs ?? NPC_CORPSE_LIFETIME_MS,
                jointLimits: npcCombat?.ragdollJointLimits ?? DEFAULT_RAGDOLL_CONFIG.jointLimits,
                selfCollision: npcCombat?.ragdollSelfCollision ?? DEFAULT_RAGDOLL_CONFIG.selfCollision,
                onBodyCreated: (body) => registerPhysicsBody(body, 'npc'),
            },
            {
                getEngine: () => this.engine,
                getPhysicsWorld: () => this.physicsWorld,
                getCharacter: () => this.character,
                getPhysicsBody: () => this.characterBody,
                restoreFlashImmediately: () => this.healthComp.restoreFlashImmediately(),
                collectParts: () => {
                    const renderer = this.characterLoader.getBlockCharacterRenderer();
                    if (!renderer) return [];
                    // Skinned NPCs never pose the block character in life; the ragdoll is built from
                    // it, so snapshot the live pose + position first (else the corpse spawns at spawn).
                    if (this.renderSkinned) this.characterLoader.updateBlockCharacter(this.character.position);
                    renderer.getRoot().updateMatrixWorld(true);
                    return buildHumanoidRagdollParts((name) => renderer.getBodyPart(name));
                },
                onPostRagdoll: () => {
                    NpcController.detachFromParent(this.characterLoader.getBlockCharacterRenderer()?.getRoot());
                    // Skinned NPCs KEEP the GLB — it's the corpse the ragdoll drives via its skeleton
                    // (removed later in RagdollComponent.dispose). Block NPCs remove it now.
                    //
                    // `usesSkinnedRig()`, not `renderSkinned`: the ragdoll drops to
                    // the block corpse when a skinned rig resolves no bones, and
                    // keeping the GLB in that case leaves it standing frozen beside
                    // the corpse that actually fell.
                    if (!this.ragdollComp.usesSkinnedRig()) {
                        NpcController.detachFromParent(this.character);
                    }
                    this.destroyPhysicsBody();
                },
                // Skinned NPCs (characterUrl GLB): drive the real skeleton from the ragdoll bodies
                // instead of cloning blocks, so the smooth mesh goes limp. Block NPCs return null.
                getSkinnedRig: () => {
                    if (!this.renderSkinned) return null;
                    const root = this.characterLoader.getSkinnedSkeletonRoot() ?? this.character;
                    return {
                        root,
                        resolveBone: (partName: string) => {
                            // Ragdoll's merged lower-arm part maps to the forearm bone.
                            const key = partName === 'leftLowerArm' ? 'leftForearm'
                                : partName === 'rightLowerArm' ? 'rightForearm'
                                : partName;
                            const names = CANONICAL_BONE_NAMES[key];
                            return names ? findBoneByCandidates(root, names) : null;
                        },
                    };
                },
            },
        );

        // Death effect precedence: this spawn's own setting, then the creator's
        // global combatConfig toggle, then the engine default.
        //
        // The engine default is now RAGDOLL. Previously an NPC with nothing
        // configured simply stopped — no collapse, no corpse timer — which reads
        // as the character freezing rather than dying. A game that wants the old
        // behaviour, or an explosion instead, sets `ragdollOnDeath` explicitly at
        // either level and is unaffected.
        if (damageableConfig?.ragdollOnDeath === undefined) {
            const ragdollDefault = this.engine.getGameData?.()?.worldProfileData?.combatConfig?.ragdollOnDeath;
            this.healthComp.getDamageableConfig().ragdollOnDeath = ragdollDefault ?? true;
        }

        // Initialize melee hit handler to default implementation
        this.onMeleeHit = this.defaultMeleeHitHandler.bind(this);

        // Initialize character loader
        // Visual systems may provide their own loader, but we'll use our own for consistency
        this.characterLoader = new CharacterLoader(engine);
        this.blockWardrobe = new BlockCharacterWardrobe(
            this.characterLoader,
            '[NpcController]',
            () => this.renderSkinned
                ? 'This NPC renders its skinned GLB — the block character is only a hidden pose/melee proxy, so changing its meshes has no visible effect.'
                : null,
        );

        // Only create LegacyNavMesh if VoxelNavMesh is not available (avoids expensive raycast grid)
        if (!getGlobalNavMesh()?.isReady()) {
            this.navMesh = new LegacyNavMesh(engine);
        }

        // Initialize movement system (use provided or get from visual system)
        this.movementSystem = movementSystem || visualSystem.createMovementSystem(moveSpeed);

        // Initialize navigation component (no speed ramping for humanoid NPCs)
        this.navigationComp = new NavigationComponent(
            moveSpeed,
            {
                getCharacter: () => this.character,
                getPhysicsBody: () => this.characterBody,
                getPhysicsWorld: () => this.physicsWorld,
                getEngine: () => this.engine,
                getNavMesh: () => this.navMesh!,
                isGrounded: () => this._isGrounded,
                runMovementSystem: (dt, dir, hop) => this.runMovementSystemInternal(dt, dir, hop),
                getAgentRadius: () => this.characterLoader.getCapsuleRadius(),
                getAgentPriority: () => AgentPriority.NPC,
            },
        );

        // LOD transition side effects: body disable + snap-back on VIRTUAL
        // promotion/demotion, shadow toggles on ring changes. The scheduler's
        // per-frame stamp is consumed in update() via lodComp.beginFrame().
        this.lodComp = new NpcLodComponent({
            setBodyEnabled: (enabled) => {
                if (this.characterBody && this.characterBody.isValid()) {
                    this.characterBody.setEnabled(enabled);
                }
            },
            snapBodyToVisual: () => {
                if (!this.characterBody || !this.characterBody.isValid()) return;
                const capsuleHeight = this.characterLoader.getCapsuleHeight();
                const p = this.character.position;
                this.characterBody.setTranslation({ x: p.x, y: p.y + capsuleHeight / 2, z: p.z }, true);
                this.characterBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
            },
            setShadowsEnabled: (enabled) => {
                for (const mesh of this.shadowMeshes) mesh.castShadow = enabled;
            },
        });

        // Get the model from visual system (must be loaded already)
        const gltf = visualSystem.getModel();

        // Clone the character model (including skeleton for animation). For the skinned-render
        // path use SkeletonUtils.clone: plain Object3D.clone(true) leaves the cloned SkinnedMesh
        // bound to the ORIGINAL skeleton, so posing the cloned bones never deforms the visible
        // mesh (it stays in T-pose). Block NPCs only read bone transforms, so the cheaper
        // clone(true) is fine there.
        const clonedCharacter = renderSkinned ? cloneSkinnedScene(gltf.scene) : gltf.scene.clone(true);
        // A voxel character keeps its eyes as a plain spec on the TEMPLATE
        // (SkeletonUtils.clone drops the eye meshes and userData from each
        // clone), so dress this clone from it. GLB characters have no spec.
        const eyeSpec = getVxlEyeSpec(gltf.scene);
        this.vxlEyes = eyeSpec ? applyVxlEyeSpec(clonedCharacter, eyeSpec) : null;
        // AFTER the eyes, not before. Everything this NPC now holds — the cloned body and the
        // eye layers dressed onto it — shares its geometry and materials with the rest of the
        // species by reference, so say so: without it this NPC's dispose() frees buffers its
        // living siblings are still drawing with. Marking only the body left the eyes exposed,
        // and one monster despawning destroyed the pupil geometry every other monster of that
        // species was drawing — on WebGPU that is a draw with a dead index buffer, which
        // invalidates the command buffer and throws away the whole frame, every frame, for the
        // rest of the session. See SharedCharacterResources.
        markSharedCharacterResources(clonedCharacter);
        clonedCharacter.name = `NpcController_Character_${visualSystem.getDisplayName()}`;

        // Skinned mode: show the cloned GLB skinned mesh (it shares the same
        // skeleton the block character reads, so the NPC's animation poses it
        // for free). Block mode: hide the skinned mesh and render the block
        // character instead. The block character root is added to
        // `engine.scene` as a sibling — not a descendant of clonedCharacter —
        // so hiding the skinned mesh here doesn't hide the block character.
        // Bone matrices still update via the animation mixer regardless of
        // `visible`.
        clonedCharacter.visible = renderSkinned;
        if (renderSkinned) {
            // Asset-load-time facing correction for a backward-authored custom GLB.
            // The cloned mesh sits under the NPC container (which tracks movement),
            // so a yaw here corrects its facing relative to travel — mirrors
            // PlayerLoader's characterModelRotationY handling.
            if (this.modelRotationY !== 0) {
                clonedCharacter.rotation.y = this.modelRotationY;
            }
            // Bones are posed manually, so the cached bounding volume is stale
            // and three.js would wrongly cull the mesh. Mirror
            // PlayerLoader.enableSkinnedRendering().
            clonedCharacter.traverse((o: THREE.Object3D) => {
                const mesh = o as THREE.Mesh;
                if (mesh.isMesh) {
                    mesh.frustumCulled = false;
                }
            });
        }

        // Wrap in a group first
        this.character = new THREE.Group();
        this.character.name = 'NpcController';
        this.character.position.copy(spawnPosition);
        this.navigationComp.initializePreviousPosition(spawnPosition);

        // CRITICAL: Position skeleton so feet are at y=0
        // This MUST happen BEFORE adding to character group and BEFORE creating block character!
        visualSystem.adjustSkeletonPosition(clonedCharacter);

        this.character.add(clonedCharacter);
        scene.add(this.character);
        this.characterParent = scene;

        // Create block character using the factory from visual system
        // Note: Animation controller will be initialized asynchronously after construction
        this.createBlockCharacter(clonedCharacter, gltf, blockCharacterFactory);

        // Skinned mode: the block character is still built (it provides
        // grounding/feet alignment and the boneMap the skeleton drives), but
        // only the real skinned GLB should be visible. Hide the block root.
        if (renderSkinned) {
            const blockRoot = this.characterLoader.getBlockCharacterRenderer()?.getRoot();
            if (blockRoot) blockRoot.visible = false;
            // Drive the GLB skeleton from the animation blend each frame (see poseCharacter ->
            // updateSkinnedCharacter), mirroring PlayerLoader.enableSkinnedRendering.
            this.characterLoader.setSkinnedSkeletonRoot(clonedCharacter);
            // A `.vxl` body can be drawn by the GPU-posed crowd batch once far
            // away; kick off (or join) the one bake for its body type. GLB bodies
            // carry no template url and stay articulated at every distance.
            const templateUrl: unknown = clonedCharacter.userData.vxlTemplateUrl;
            if (typeof templateUrl === 'string') {
                void ensureVxlCrowdVariant(templateUrl, engine).then((variant) => { this.crowdVariant = variant; });
            }
            // The death-shatter caches are warmed on the first hit (see takeDamage),
            // not here: a game that never damages its NPCs — a crowd of townsfolk —
            // must not parse every body it spawns for a shatter it never plays.
        }

        // Get base animations from visual system
        const baseAnimations = visualSystem.getBaseAnimations();

        // Start animation initialization (will be awaited by static factory method)
        this.animationInitPromise = this.initializeAnimations(clonedCharacter, gltf, baseAnimations);

        // Create physics body at spawn position (where block feet are now positioned)
        // Use ENEMY collision group so projectiles can hit NPCs
        this.characterBody = this.characterLoader.createPhysicsBody(
            this.spawnPosition, 
            this.physicsWorld, 
            -35.0,
            CollisionGroup.ENEMY,
            CollisionMask.ENEMY
        );

        // Store spawn position and TARGET gravity scale for potential physics hold
        // (DynamicObjectManager will call holdPhysicsUntilReady() if colliders aren't ready)
        // NOTE: Physics body starts with gravity=0, so we need the TARGET scale from CharacterLoader
        this._savedSpawnPosition = this.spawnPosition.clone();
        this._originalGravityScale = this.characterLoader.getTargetGravityScale();

        // Register NPC in physics body userData for collision identification.
        // `agentRadius` is read by AgentAvoidance when other agents query this
        // body as a neighbor — keeps avoidance accurate for capsules of
        // varying sizes (e.g. small humanoids vs. large enemies).
        this.physicsWorld.setUserData(this.characterBody, {
            __type: 'npc',
            npcController: this,
            agentRadius: this.characterLoader.getCapsuleRadius(),
        });

        // Store physics body reference in all block character meshes for melee detection
        this.storePhysicsBodyInMeshes();

        // Create trigger sensor for interaction detection (attached to NPC's physics body)
        this.interactableComponent = new InteractableComponent(this.physicsWorld, {
            interactable: this,
            object3D: this.character,
            physicsBody: this.characterBody,
            radius: 3.0,
        });

        // Store unique ID and create nameplate if ID provided
        if (npcId) {
            this.npcId = npcId;
            this.createIdNameplate();
        }

        // Async pathfinding: coalesce this NPC's queued path requests under a
        // stable key, ordered by hero/crowd priority + camera distance.
        this.navigationComp.setNavKey(npcId ?? `npc-${this.character.id}`);
        this.navigationComp.setLodPriorityProvider(() => ({
            hero: this.importance === 'hero',
            distSq: this.engine.camera
                ? this.character.position.distanceToSquared(this.engine.camera.position)
                : 0,
        }));

        // No initial target - behavior will set it
    }

    /**
     * Set or change the NPC's behavior
     * Allows runtime behavior switching (e.g., idle → hostile when player detected)
     * 
     * @param behavior - The behavior to use for this NPC
     */
    setBehavior(behavior: INpcBehavior): void {
        // Dispose of old behavior if any
        if (this.behavior) {
            this.behavior.dispose();
        }

        // Set and initialize new behavior
        this.behavior = behavior;
        this.behavior.initialize(this);

        // Direct-target behaviors (goal-field gradient steps) must bypass A*
        if (behavior.usesDirectTargets?.()) {
            this.navigationComp.setStraightLinePath(true);
        }
    }

    /**
     * Request a behavior change from within a behavior
     * 
     * This is a trap method that behaviors can call to switch to a different behavior dynamically.
     * The old behavior is automatically disposed, and the new behavior is initialized.
     * 
     * **Behavior Switching Pattern:**
     * - Behaviors should check conditions in their `update()` method
     * - When conditions are met, call `requestBehaviorChange()` with the new behavior
     * - Return `null` from `update()` to stop current behavior logic
     * - The new behavior takes over on the next frame
     * 
     * **Usage in behaviors:**
     * 
     * @param newBehavior - The new behavior to switch to (must not be null/undefined)
     */
    requestBehaviorChange(newBehavior: INpcBehavior): void {
        if (!newBehavior) {
            return;
        }

        try {
            this.setBehavior(newBehavior);
        } catch {
            // Don't throw - allow NPC to continue with current behavior to prevent crashes
        }
    }

    /**
     * Set a new target position for the NPC to move toward
     * Called by behaviors to direct NPC movement
     *
     * @param target - Target position or null to stop moving
     * @param maxPathLength - Optional path-length budget in metres. Caps how
     *   far A* will search; the default (when omitted) is
     *   `max(20 m, linearDistance × 1.3)`. Pass a larger value for routes
     *   that legitimately need long detours (cross-map errands, mazes).
     */
    setTargetPosition(target: THREE.Vector3 | null, maxPathLength?: number): void {
        // On a locked gameplay plane, project the destination onto it: a wander
        // or flee target picked off-plane would otherwise never be reachable
        // (the per-frame snap cancels all Z progress), so the NPC walks in
        // place at the target's X until the stuck detector rescues it.
        const planeZ = this.gameplayPlaneZ();
        if (target && planeZ !== null) target.z = planeZ;
        this.navigationComp.setTargetPosition(target, undefined, maxPathLength);
    }

    /**
     * Get the NPC's current planned path as a list of world-space waypoints
     * (after smoothing). Returns an empty array if no path is active. Used
     * by the debug navmesh overlay to render where this NPC intends to go.
     */
    getCurrentPath(): THREE.Vector3[] {
        return this.getPath();
    }

    /**
     * Get reference to engine (for behaviors to query world state)
     */
    getEngine(): EngineLike {
        return this.engine;
    }

    /**
     * Get reference to physics world (ICharacterContext)
     */
    getPhysicsWorld(): PhysicsWorld {
        return this.physicsWorld;
    }

    /**
     * Get reference to NavMesh (for behaviors that need custom pathfinding)
     */
    getNavMesh(): LegacyNavMesh | null {
        return this.navMesh;
    }

    // ════════════════════════════════════════════════════════════════════════
    // Step-Hop Configuration
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Set the maximum height the NPC can hop up when stuck against a step.
     * Default is 1.0 meters (1 voxel block).
     * Set to 0 to disable step-hopping entirely.
     * 
     * @param height Maximum step height in meters
     */
    setMaxStepUpHeight(height: number): void {
        this.navigationComp.setMaxStepUpHeight(height);
    }

    /**
     * Get the current maximum step-up height.
     */
    getMaxStepUpHeight(): number {
        return this.navigationComp.getMaxStepUpHeight();
    }

    /**
     * Enable or disable the step-hop behavior.
     * When enabled, NPCs will automatically hop up small steps when stuck.
     */
    setStepHopEnabled(enabled: boolean): void {
        this.navigationComp.setStepHopEnabled(enabled);
    }

    /**
     * Check if step-hop behavior is enabled.
     */
    isStepHopEnabled(): boolean {
        return this.navigationComp.isStepHopEnabled();
    }

    // ════════════════════════════════════════════════════════════════════════
    // Rotation Speed Configuration
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Set the turning speed for the NPC in radians per second.
     * Default is 5.0 rad/s (~286°/s) which is appropriate for humanoid NPCs.
     * 
     * @param radiansPerSecond Turning speed in radians per second
     */
    setRotationSpeed(radiansPerSecond: number): void {
        this.navigationComp.setRotationSpeed(radiansPerSecond);
    }

    /** Get the current rotation speed in radians per second. */
    getRotationSpeed(): number {
        return this.navigationComp.getRotationSpeed();
    }

    // ════════════════════════════════════════════════════════════════════════
    // Movement Speed Configuration
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Set the movement speed for the NPC in meters per second.
     * Default is 2.7 m/s. Player typically moves at 5.0 m/s.
     * 
     * @param speed Movement speed in meters per second
     */
    setMoveSpeed(speed: number): void {
        this.moveSpeed = Math.max(0.1, speed);
        this.navigationComp.setMoveSpeed(this.moveSpeed);
        // Also update the movement system's speed (setMoveSpeed is part of IPlayerMovement).
        this.movementSystem.setMoveSpeed(this.moveSpeed);
    }

    /** Get the current movement speed in meters per second. */
    getMoveSpeed(): number {
        return this.moveSpeed;
    }

    /**
     * Build a {@link SkiMovementHost} view of this NPC so an AI rider can run the
     * player's EXACT `SkiMovement` physics (see {@link NpcSkiHost}) rather than a
     * parallel model. Construct once and reuse — the host just maps this NPC's
     * character/body/renderer onto the interface SkiMovement drives.
     */
    buildSkiHost(): SkiMovementHost {
        return new NpcSkiHost(
            this.character,
            this.characterBody,
            this.physicsWorld,
            this.animationController,
            this.characterLoader,
        );
    }

    /**
     * Swap the NPC's movement system (e.g. install `NpcSkiMovement` so a path-
     * following NPC slides downhill in a snowboard stance instead of walking).
     * Mirrors {@link PlayerController.setMovementSystem}: the outgoing system gets
     * `onDetached`, the incoming one `onAttached`. The movement receives this
     * controller as its host (NpcController stands in for PlayerController for
     * NPCs — see runMovementSystemInternal), so it must only use members both
     * expose. Pass `null`/omit to keep the current system.
     */
    setMovementSystem(movementSystem: IPlayerMovement): void {
        const previous = this.movementSystem;
        if (previous && previous !== movementSystem) {
            previous.onDetached?.(this as unknown as PlayerController);
        }
        this.movementSystem = movementSystem;
        if (previous !== movementSystem) {
            movementSystem.onAttached?.(this as unknown as PlayerController);
        }
        // Movements that suppress the walk cycle (e.g. NpcSkiMovement) also own
        // the body facing, so navigation must steer toward the waypoint rather
        // than "move where you face" (a sideways stance would otherwise pin the
        // NPC, since its facing·travel alignment is ~0).
        this.navigationComp.setOrchestratedFacing(
            movementSystem.shouldPlayLocomotionAnimation?.() === false,
        );
    }

    // ════════════════════════════════════════════════════════════════════════
    // Arrival Configuration
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Set how close this NPC must get to its FINAL navigation destination
     * before it stops, in meters. Default 0.5 m. Use a smaller value (e.g. 0.2)
     * when the NPC must walk right up to an exact spot — the engine eases the
     * agent onto the point so it doesn't overshoot and jitter. Intermediate
     * path waypoints are unaffected, so cornering stays smooth.
     *
     * @param radius Arrival tolerance in meters (clamped to a small positive floor)
     */
    setArrivalRadius(radius: number): void {
        this.navigationComp.setArrivalRadius(radius);
    }

    /** Get the current final-destination arrival tolerance in meters. */
    getArrivalRadius(): number {
        return this.navigationComp.getArrivalRadius();
    }

    /**
     * Toggle agent-to-agent avoidance for this NPC. When disabled the NPC keeps
     * navigating normally — it still follows paths, arrives, faces its heading
     * and plays the correct walk/run locomotion — but it no longer steers around
     * other agents, and other agents stop treating it as an obstacle. Intended
     * for scripted / orchestrated NPCs that must follow exact paths without
     * yielding to each other (e.g. a queue of actors taking turns). Avoidance is
     * enabled by default.
     */
    setAvoidanceEnabled(enabled: boolean): void {
        this.navigationComp.setAvoidanceEnabled(enabled);
        // Flip the userData flag in place so OTHER agents' neighbor scans skip
        // (or re-include) this body. getUserData returns the live reference the
        // avoidance system reads, so mutating it is enough.
        const ud = this.physicsWorld.getUserData(this.characterBody) as { avoidanceDisabled?: boolean } | undefined;
        if (ud) ud.avoidanceDisabled = !enabled;
    }

    /** Whether agent-to-agent avoidance is currently active for this NPC. */
    isAvoidanceEnabled(): boolean {
        return this.navigationComp.isAvoidanceEnabled();
    }

    /**
     * Make this NPC head in a STRAIGHT LINE to its setTargetPosition target,
     * skipping the navmesh A* pathfinder entirely. The NPC still moves, arrives,
     * faces its heading and plays the correct walk/run animation — only the
     * route changes: a direct line instead of a planned path. Use for
     * orchestrated NPCs on open ground (e.g. actors walking to scripted marks)
     * where pathfinding is pure overhead and a periodic per-move cost. Obstacle
     * routing is the caller's responsibility in this mode. Disabled by default;
     * takes effect on the next setTargetPosition call.
     */
    setStraightLinePath(enabled: boolean): void {
        this.navigationComp.setStraightLinePath(enabled);
    }

    /** Whether this NPC is in straight-line (no-pathfinding) movement mode. */
    isStraightLinePath(): boolean {
        return this.navigationComp.isStraightLinePath();
    }

    /**
     * Current movement speed in m/s, after speed ramping. Use for locomotion
     * blending, chase/flee tuning or HUD readouts.
     */
    getCurrentSpeed(): number {
        return this.navigationComp.getCurrentSpeed();
    }

    /**
     * Set how long explosion debris persists, in milliseconds.
     * 0 = permanent (until level unload). Default is 10000 (10 seconds).
     * Applies to the block explosion only — bone-voxel shatter debris
     * (custom voxelized characters) lives in the shared voxel debris
     * registry with its own TTL.
     */
    setDebrisLifetime(ms: number): void {
        this.explosionComp.setDebrisLifetimeMs(ms);
    }

    /**
     * Tune the bone-voxel shatter used when this NPC renders a custom
     * voxelized GLB character (see explodeCharacter). Merged over
     * DEFAULT_BONE_VOXEL_SHATTER.
     */
    setBoneVoxelShatterOptions(options: Partial<BoneVoxelShatterOptions>): void {
        this.boneVoxelShatterOptions = { ...this.boneVoxelShatterOptions, ...options };
    }

    /**
     * Shatter this NPC into bone-grouped voxels right now — no death effect,
     * no block explosion, just the character's actual voxels flying apart
     * from its current pose. Removes the character visuals + physics body
     * and marks the NPC exploded (pair with NpcManager.despawnNpc to fully
     * remove it).
     *
     * Returns false (leaving the NPC intact) when the NPC doesn't render a
     * voxelized skinned GLB — e.g. block-character NPCs or textured fallback
     * variants without vertex colors.
     */
    shatterIntoVoxels(): boolean {
        if (this.healthComp.isExploded()) return false;
        this.leaveCrowd();
        if (!this.renderSkinned || !this.engine.scene) return false;
        // Bone-voxel shatter builds 3D debris bodies; on the 2D lane the caller
        // takes the plain removal path instead.
        if (isPlaneLockedPhysics(this.physicsWorld)) return false;
        this.healthComp.restoreFlashImmediately();
        const scene = this.engine.scene;
        // The NPC is dead NOW — no AI, no capsule — whether or not the shatter
        // runs this frame. A rocket kills a pack in one hit callback, and the
        // shatters of the second kill onward are spread over the next frames
        // (ShatterScheduler); until its turn the corpse stands frozen in its
        // death pose, then bursts. Only the shatter and the visual removal wait.
        this.healthComp.markExploded();
        this.destroyPhysicsBody();
        shatterScheduler.runOrDefer(() => {
            if (this.disposed) return;   // despawned before its turn: nothing left to burst
            shatterSkinnedVoxelCharacter(this.character, this.physicsWorld, scene, this.boneVoxelShatterOptions);
            this.removeCharacterAfterExplosion();
        });
        return true;
    }

    /**
     * Death explosion entry point. NPCs rendering a voxelized skinned GLB
     * (Asset Forger characters) shatter by bone into their actual voxels at
     * the death pose — no explosion visual of any kind. Block-character
     * NPCs toss their body-part meshes via BlockExplosionComponent.
     *
     * Skinned NPCs never fall back to the block explosion: the hidden block
     * proxy is unposed (parked at the world origin) and looks nothing like
     * the custom character, so when the GLB has no parseable voxel geometry
     * (e.g. a textured variant without vertex colors) the character is
     * simply removed.
     */
    /**
     * The spray of body-coloured debris a kill throws off.
     *
     * Colour is sampled from the NPC's own mesh rather than being a fixed red:
     * a game's enemies are as likely to be stone, metal or slime as flesh, and a
     * red spray off a rock golem looks like a bug. `HitDebrisSystem` does the
     * sampling, so this stays correct for whatever the creator spawned.
     *
     * Thrown along the killing blow where there was one — a shot from the left
     * sprays right — and straight up when the kill had no direction (falling,
     * scripted death, damage-over-time).
     */
    private spawnDeathBurst(deathImpulse?: THREE.Vector3): void {
        const character = this.character;
        if (!character) return;

        const origin = character.getWorldPosition(new THREE.Vector3());
        // Chest height rather than the feet, which is where the model's origin
        // sits — a burst at ground level reads as dust, not a wound.
        origin.y += 0.9;

        // Accept any {x,y,z}, not just a THREE.Vector3. The signature says
        // Vector3, but JS callers and published template code are not bound by
        // it — and an exception thrown here happens INSIDE onRagdoll, which
        // stops HealthComponent from ever marking the character ragdolled and
        // leaves it half-dead.
        const impulse = deathImpulse
            ? new THREE.Vector3(deathImpulse.x ?? 0, deathImpulse.y ?? 0, deathImpulse.z ?? 0)
            : null;
        const direction = impulse && impulse.lengthSq() > 1e-6
            ? impulse.normalize()
            : new THREE.Vector3(0, 1, 0);

        // Colour comes from the BLOCK character's torso, not `this.character`.
        //
        // `getCharacter()` is the skinned GLB — for these NPCs a UE5 Manny whose
        // single SkinnedMesh carries a plain white material, and whose "torso" is
        // an empty bone-attachment Object3D with no material at all. Sampling it
        // produced white debris regardless of how the enemy actually looks. The
        // visible colour lives on the block character the renderer drives, where
        // `torso` is a real mesh carrying the body's own colour.
        const renderer = this.characterLoader.getBlockCharacterRenderer();
        const colorSource = renderer?.getBodyPart('torso') ?? renderer?.getRoot() ?? character;
        spawnHitDebris(origin, direction, colorSource, DEATH_BURST);
    }

    private explodeCharacter(): void {
        if (this.healthComp.isExploded()) return;
        if (this.renderSkinned) {
            if (!this.shatterIntoVoxels()) {
                this.healthComp.restoreFlashImmediately();
                this.removeCharacterAfterExplosion();
                this.healthComp.markExploded();
            }
            return;
        }
        this.explosionComp.explode();
    }

    /** Remove the character visuals + capsule body after a death explosion. */
    private removeCharacterAfterExplosion(): void {
        this.leaveCrowd();
        NpcController.detachFromParent(this.characterLoader.getBlockCharacterRenderer()?.getRoot());
        NpcController.detachFromParent(this.character);
        this.destroyPhysicsBody();
    }

    /**
     * Remove the capsule body from the physics world and null the field, so
     * update()/hibernate()/wake() bail out instead of touching a freed body.
     * The field is declared non-nullable (published game code reads it via
     * getPhysicsBody()), hence the cast.
     */
    private destroyPhysicsBody(): void {
        if (this.characterBody) {
            this.physicsWorld.removeRigidBody(this.characterBody);
            (this as unknown as { characterBody: RAPIER.RigidBody | null }).characterBody = null;
        }
    }

    /**
     * Snapshot of debris pieces currently in-flight after this NPC's death
     * explosion. Returns mesh + rapier body for each piece; caller can read
     * positions, push them around with velocities/impulses, or move the mesh
     * directly. Empty array before death or after all debris has been removed.
     * Block explosion only — bone-voxel shatter debris (custom voxelized
     * characters) is self-managing and never returned here.
     */
    getExplodedDebris(): { mesh: THREE.Mesh; body: RAPIER.RigidBody }[] {
        return this.explosionComp.getDebrisPieces();
    }

    /**
     * Remove one debris piece (cleans up the mesh + physics body). Pair with
     * `setDebrisLifetime(0)` to take over lifetime management — fly the pieces
     * up to the sky over N seconds and call this for each as it reaches the
     * top. Returns true if the piece was found. Block explosion only — does
     * not apply to bone-voxel shatter debris.
     */
    removeDebrisPiece(mesh: THREE.Mesh): boolean {
        return this.explosionComp.removeDebrisPiece(mesh);
    }

    // ════════════════════════════════════════════════════════════════════════
    // Path Access (for debugging/visualization)
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Get the current navigation path as an array of waypoints.
     * Returns a copy of the path array to prevent external modification.
     * Useful for debugging and visualizing the NPC's planned route.
     */
    getPath(): THREE.Vector3[] {
        return this.navigationComp.getPath();
    }

    /**
     * Get the index of the current waypoint the NPC is moving toward.
     */
    getCurrentWaypointIndex(): number {
        return this.navigationComp.getCurrentWaypointIndex();
    }

    /**
     * Get the current target waypoint, or null if no path or reached end.
     */
    getCurrentWaypoint(): THREE.Vector3 | null {
        return this.navigationComp.getCurrentWaypoint();
    }

    /**
     * Pose the visible character each frame: the real skinned GLB (a custom Asset Forger
     * character) when renderSkinned — which also plants the lowest foot on the ground — else
     * the procedural block character.
     */
    private poseCharacter(): void {
        // The crowd batch is drawing this NPC: its skeleton is hidden and frozen,
        // so posing it would be the full price for nothing. poseDirty stays set,
        // and the first frame back in the articulated tier poses once.
        if (this.crowdSlot) return;
        // Posing recomposes the whole skeleton AND the whole block hierarchy with
        // updateMatrixWorld(true) — a forced, dirty-flag-ignoring recursion over
        // ~65 bones and 19 part groups, three times over between here and
        // CharacterLoader. Measured at ~1.8 ms per NPC.
        //
        // Nothing about that output changes unless the SKELETON moved (only on a
        // granted animation tick) or the BODY moved. On a frame where the
        // scheduler grants no animation ticks — the common case for a crowd —
        // re-posing reproduces the identical transforms at full price.
        if (!this.poseDirty && !this.hasMovedSincePose()) return;
        this.poseDirty = false;
        this.lastPosedPosition.copy(this.character.position);
        const _poseT0 = performance.now();
        try {
            this.poseCharacterInner();
        } finally {
            NpcController.poseMs += performance.now() - _poseT0;
        }
    }

    /**
     * Whether the character root has moved far enough since the last pose to be
     * worth re-posing. The threshold is sub-millimetre: this exists to skip
     * float noise on a standing NPC, not to introduce visible lag.
     */
    private hasMovedSincePose(): boolean {
        return this.lastPosedPosition.distanceToSquared(this.character.position)
            > NpcController.POSE_MOVE_EPSILON_SQ;
    }

    /** Force the next poseCharacter() to run — call whenever the skeleton changes. */
    private markPoseDirty(): void {
        this.poseDirty = true;
    }

    /** @see poseCharacter — split so the timing wrapper stays one line. */
    private poseCharacterInner(): void {
        // Skinned (Asset Forger) NPCs pose the real GLB skeleton, which also plants the lowest foot.
        if (this.renderSkinned) {
            this.characterLoader.updateSkinnedCharacter(this.character.position);
        }
        // Always keep the block character live: it's the visible body for procedural NPCs, and for
        // skinned NPCs the hidden melee-sweep raycast proxy (carries hit userData, raycasts cheaply,
        // tracks the same skeleton). Without it a moved skinned NPC's proxy stays frozen at spawn and
        // melee swings miss. Runs AFTER updateSkinnedCharacter so it reads the already-posed skeleton.
        this.characterLoader.updateBlockCharacter(this.character.position);
        // Seat the held weapon against the hand bone this pose just moved. Rides the pose
        // rather than update() so it costs nothing on the frames posing is skipped — and
        // those are exactly the frames where the hand did not move.
        this.weaponComp.updateHold(this.animationController?.getIsAttacking() ?? false);
        this.behavior?.onPoseUpdated?.();
    }

    /**
     * True while the NPC is still following an active path toward its
     * `setTargetPosition()` destination; false once it has arrived (or has no
     * path). This is the correct signal for "has the NPC reached its target?" —
     * use `!isFollowingPath()` rather than inspecting `getPath().length`.
     *
     * IMPORTANT: `getPath()` returns the planned waypoint list, which is NOT
     * emptied on arrival — the engine signals arrival by advancing past the
     * final waypoint, not by clearing the array. Checking `getPath().length === 0`
     * therefore never becomes true on a clean arrival; it only flips when the
     * stuck-detector eventually wipes the path (~2 s of standing still), which
     * looks like a long unexplained pause before the NPC reacts. Use this method
     * instead.
     */
    isFollowingPath(): boolean {
        return this.navigationComp.hasPath();
    }

    /**
     * True once the NPC has finished its path and is at (or within the arrival
     * radius of) its destination. Convenience inverse of `isFollowingPath()`.
     * Returns true when there is no active path at all.
     */
    hasReachedDestination(): boolean {
        return !this.isFollowingPath();
    }

    private createBlockCharacter(
        clonedCharacter: THREE.Object3D,
        gltf: any,
        blockCharacterFactory: IBlockCharacterFactory
    ): void {
        // Use CharacterLoader to create block character with auto-detected armature rotation.
        // NPC uses the same Mixamo model and atan2(x,z) rotation as the player,
        // so default modelForward (-Z) is correct.
        this.characterLoader.createBlockCharacter(clonedCharacter, blockCharacterFactory);

        // Scale skeleton to match the character's intended height from getCharacterDimensions()
        // This ensures NPCs with different heights (e.g., 1.5m monkey vs 2.1m Sandy) appear correctly
        const dimensions = blockCharacterFactory.getCharacterDimensions();
        // Skinned (highres AF GLB) NPCs use the classic enemy height — NOT the block proxy's
        // dimensions.height (1.3, sized for the visible block mascot) and NOT the player's
        // configured height (the voxelization-era rule; it left enemies barely taller than the
        // 1.3m block player and visibly "too small"). 1.84m is the pre-voxelization enemy
        // height the combat capsule was originally tuned against.
        const targetHeight = this.renderSkinned ? getSkinnedNpcHeight() : dimensions.height;
        // Measure the character's ACTUAL height instead of assuming the default skeleton's export
        // height — custom characters (e.g. Asset Forger voxels) have different native sizes, so a
        // fixed 1.75 assumption mis-scales them. Mirrors PlayerLoader, which Box3-measures the GLB
        // and scales from that. Falls back to the skeleton height if the bbox is degenerate.
        // Every world-space read below must see the SAME parent chain. Box3.setFromObject
        // refreshes each object only from its parent's CURRENT matrixWorld — stale identity
        // for a group that was just added to the scene — while getWorldPosition() on a bone
        // refreshes the whole chain and so includes the spawn position. Mixing the two made
        // "mesh top minus lowest bone" come out as 1.75 m minus a foot at y≈1: a 0.76 m
        // reading, a 2.4× scale, and a 4.3 m townsperson (the "library bodies render huge"
        // bug games have been counter-scaling). One refresh first, and both agree.
        this.character.updateWorldMatrix(true, true);
        const meshBox = new THREE.Box3().setFromObject(clonedCharacter);
        // A rigged .vxl body already knows its own height exactly (the loader measured
        // the voxels); no box or bone arithmetic can improve on it.
        const vxlMeasurements = clonedCharacter.userData.vxlMeasurements as { height?: number } | undefined;
        const vxlHeight = typeof vxlMeasurements?.height === 'number' && vxlMeasurements.height > 0.001
            ? vxlMeasurements.height * clonedCharacter.scale.y
            : null;
        let measuredHeight = meshBox.getSize(new THREE.Vector3()).y;
        if (vxlHeight !== null) {
            measuredHeight = vxlHeight;
        } else if (this.renderSkinned) {
            // SKINNED (custom AF GLB) NPCs: measure from the lowest SKELETON BONE (≈ the feet) up
            // to the top of the mesh, NOT the full mesh bbox. Loose geometry that hangs BELOW the
            // feet — a cape pooling on the ground, a long robe — otherwise inflates the bbox, so
            // scaling it to targetHeight shrinks the actual body well below it (caped villains
            // render far too short). Bones never extend into the cape, so the lowest bone is a
            // reliable feet reference. Block NPCs have no such hanging geometry, so they keep the
            // simple full-bbox measure.
            clonedCharacter.updateMatrixWorld(true);
            const boneWorld = new THREE.Vector3();
            let lowestBoneY = Infinity;
            clonedCharacter.traverse((o) => {
                if ((o as { isBone?: boolean }).isBone) {
                    o.getWorldPosition(boneWorld);
                    if (boneWorld.y < lowestBoneY) lowestBoneY = boneWorld.y;
                }
            });
            if (lowestBoneY !== Infinity) {
                const bodyHeight = meshBox.max.y - lowestBoneY;
                if (bodyHeight > 0.001) measuredHeight = bodyHeight;
            }
        }
        const currentHeight = measuredHeight > 0.001 ? measuredHeight : getSkeletonHeight();

        if (Math.abs(targetHeight - currentHeight) > 0.01) {
            // Scale the character (skeleton) to match the intended height
            scaleCharacterToHeight(this.character, currentHeight, targetHeight, '👤');
        }

        // createBlockCharacter() above sized the physics capsule from the block factory's
        // getCharacterDimensions().height. For skinned (custom Asset Forger) NPCs the
        // VISIBLE mesh is instead scaled to `targetHeight` (the player's configured
        // height), which differs from that block-body height — so the capsule (and the
        // hidden block rig the melee raycast rides on) no longer matches the rendered
        // character, and shots/melee miss. Re-derive the capsule to the height the visible
        // mesh actually uses, preserving the block body's height:radius proportion.
        // Procedural voxel NPCs set targetHeight === dimensions.height, so this is a no-op
        // for them.
        if (this.renderSkinned && dimensions.height > 0.001) {
            const ratio = targetHeight / dimensions.height;
            // Re-clamp the radius to the engine's character-capsule bounds [0.2, 0.8]
            // (CharacterLoader/PlayerLoader use the same range); scaling the already-clamped
            // radius by `ratio` would otherwise blow past it for tall NPCs.
            const radius = Math.max(0.2, Math.min(0.8, this.characterLoader.getCapsuleRadius() * ratio));
            this.characterLoader.setCapsuleDimensions(
                this.characterLoader.getCapsuleHeight() * ratio,
                radius,
            );
        }

        // Enable layer 1 for collider editor exclusion while keeping layer 0 for melee detection
        // Using enable() instead of set() keeps the mesh on both layer 0 (melee) and layer 1 (editor)
        const blockRoot = this.characterLoader.getBlockCharacterRenderer()?.getRoot();
        if (blockRoot) {
            blockRoot.traverse((child: THREE.Object3D) => {
                if ((child as THREE.Mesh).isMesh) {
                    child.layers.enable(1); // Add layer 1, keep layer 0
                }
            });
        }

        // Shadow LOD: snapshot the meshes that START shadow-casting (block body
        // root is a scene-level sibling of the character group, so traverse
        // both). NpcLodComponent toggles castShadow on exactly this set —
        // meshes that never cast shadows stay untouched.
        const shadowCasters = new Set<THREE.Mesh>();
        const collectShadowCasters = (root: THREE.Object3D | null | undefined): void => {
            root?.traverse((child: THREE.Object3D) => {
                const mesh = child as THREE.Mesh;
                if (mesh.isMesh && mesh.castShadow) shadowCasters.add(mesh);
            });
        };
        collectShadowCasters(this.character);
        collectShadowCasters(blockRoot);
        this.shadowMeshes = Array.from(shadowCasters);

        // Set character group reference for updateBlockCharacter
        this.characterLoader.setCharacterGroup(this.character);

        // Initialize damage flash effect on the visible block character (not hidden skeleton)
        if (blockRoot) {
            this.healthComp.initDamageFlash(blockRoot);
        }

        // Create animation controller from visual system
        this.animationController = this.visualSystem.createAnimationController();
        if (this.animationController) {
            this.characterLoader.setAnimationController(this.animationController);
            // Set character height for Mixamo animation scaling (same as PlayerLoader does)
            this.animationController.setCharacterHeight(targetHeight);
            // A skinned NPC's skin may reach fingers and toes the block body prunes.
            this.animationController.setRetainFullSkeleton(this.renderSkinned);
            this.wireStrikeHitRegistration(this.animationController);
        }

        // Find root bone using visual system's root bone names
        // IMPORTANT: Capture root bone position AFTER skeleton adjustment
        const rootBoneNames = this.visualSystem.getRootBoneName();
        const namesArray = Array.isArray(rootBoneNames) ? rootBoneNames : [rootBoneNames];
        
        const availableBones: string[] = [];
        clonedCharacter.traverse((child: THREE.Object3D) => {
            if ((child as THREE.Bone).isBone) {
                if (namesArray.includes(child.name)) {
                    this.rootBone = child as THREE.Bone;
                    // Capture the initial position after all adjustments are done
                    this.rootBoneInitialPosition.copy(this.rootBone.position);
                } else {
                    availableBones.push(child.name);
                }
            }
        });

        if (!this.rootBone && availableBones.length > 0) {
            console.warn(`⚠️ NpcController: Could not find root bone with names: ${namesArray.join(', ')}. Available bones: ${availableBones.slice(0, 5).join(', ')}${availableBones.length > 5 ? '...' : ''}`);
        }
    }

    /**
     * Wait for animations to finish initializing
     * Called by the static factory method before returning the NPC
     */
    private async waitForAnimations(): Promise<void> {
        await this.animationInitPromise;
    }

    /**
     * Initialize animations asynchronously (called from constructor)
     * This allows baseAnimations to load without blocking NPC creation
     */
    private async initializeAnimations(
        clonedCharacter: THREE.Object3D,
        gltf: any,
        baseAnimations: BaseAnimationDefinition[]
    ): Promise<void> {
        if (!this.animationController) return;

        try {
            // Use visual system to initialize animations
            await this.visualSystem.initializeAnimations(
                clonedCharacter,
                gltf,
                this.engine.loader,
                baseAnimations
            );
            console.log(`✅ NpcController: Animations initialized for ${this.visualSystem.getDisplayName()}`);
        } catch (error) {
            console.error('❌ NpcController: Failed to initialize animations:', error);
            throw error; // Propagate so callers can detect the failure
        }
    }


    /**
     * The physics capsule in the form Rapier's queries want it: the radius plus the
     * HALF-height of the cylindrical mid-section (total height minus the two
     * hemispherical caps), floored at 0 for a capsule wider than it is tall.
     */
    private getCapsuleDimensions(): { radius: number; halfHeight: number } {
        const radius = this.characterLoader.getCapsuleRadius();
        return {
            radius,
            halfHeight: Math.max(0, (this.characterLoader.getCapsuleHeight() - 2 * radius) / 2),
        };
    }

    /**
     * Store physics body reference in all block character meshes for melee detection
     * This enables weapons to detect and damage this NPC via IDamageable interface.
     */
    private storePhysicsBodyInMeshes(): void {
        if (!this.characterBody) return;

        const mass = 70; // Same mass as physics body

        // Fallback capsule dimensions for the body melee test (gatherMeleeBodyHits) when the
        // visible-body AABB can't be measured. The primary path measures the actual rendered
        // mesh each swing so the hit volume matches the graphics — see npcHitRoot below.
        const { radius: capsuleRadius, halfHeight: capsuleHalfHeight } = this.getCapsuleDimensions();

        // Visible-body root: the actual rendered character whose world AABB the melee sweep
        // measures to build a body-covering hit volume. For skinned (Asset Forger) NPCs the
        // derived capsule is often thinner/shorter than the real graphics, so swings glanced
        // off — measuring the GLB instead makes the hitbox track the body. Excludes the
        // nameplate/sensors (which live on this.character) by using the pure mesh root.
        const hitRoot: THREE.Object3D | null | undefined = this.renderSkinned
            ? this.characterLoader.getSkinnedSkeletonRoot()
            : this.characterLoader.getBlockCharacterRenderer()?.getRoot();

        // Store physics body reference and NPC controller in every mesh of a root so the
        // melee sweep (MeleeSweepTargets / WeaponMeleeSystem) can resolve a hit back to this
        // controller, its dynamic body, and its body hit volume.
        const tag = (root: THREE.Object3D | null | undefined): void => {
            root?.traverse((child: THREE.Object3D) => {
                if (!(child as THREE.Mesh).isMesh) return;
                const mesh = child as THREE.Mesh;
                mesh.userData.physicsBody = this.characterBody;
                mesh.userData.mass = mass;
                mesh.userData.damageableController = this; // Generic IDamageable interface
                mesh.userData.npcController = this; // Store reference to this controller
                mesh.userData.enemyController = this; // Keep backward compatibility
                mesh.userData.capsuleRadius = capsuleRadius;
                mesh.userData.capsuleHalfHeight = capsuleHalfHeight;
                mesh.userData.npcHitRoot = hitRoot ?? null;
            });
        };

        // Tag the block character meshes — the visible body for procedural voxel/block
        // NPCs, and the (hidden but kept-live, see poseCharacter) raycast proxy for skinned
        // NPCs. These are cheap box/voxel meshes; raycasting the skinned GLB instead is the
        // expensive, unreliable path MeleeSweepTargets deliberately avoids.
        tag(this.characterLoader.getBlockCharacterRenderer()?.getRoot());
    }

    update(deltaTime: number): void {
        // ── Death visuals FIRST, before the live-body guard ────────────────
        //
        // These two syncs are the corpse: they copy each physics limb/block
        // transform onto the meshes the player actually sees, and the ragdoll's
        // auto-dispose timer lives inside syncRagdoll().
        //
        // They must run when `characterBody` is NULL, because that is exactly
        // the state a corpse is in — `onPostRagdoll` calls `destroyPhysicsBody()`.
        // They used to sit BELOW the guard, marked "always sync", which meant
        // they never ran again from the first frame after death: the limb bodies
        // fell and tumbled in the physics world while their meshes stayed frozen
        // in the death pose, and the corpse never disposed itself. That is the
        // "ragdoll does nothing" bug — the ragdoll was always built correctly,
        // it was only ever the per-frame sync that was unreachable.
        //
        // Unconditional, not ring-gated: freezing a far corpse would also freeze
        // the auto-dispose timer inside syncRagdoll(), so it would never clean up.
        if (this.explosionComp.hasExplodedBlocks()) {
            this.explosionComp.syncExplodedBlocks();
        }
        if (this.ragdollComp.hasRagdoll()) {
            this.ragdollComp.syncRagdoll();
        }

        // The body is nulled on death/dispose (see destroyPhysicsBody), but this
        // update() can still be invoked for that NPC one or more frames later. Every movement
        // system dereferences the body immediately (playerBody.numColliders()), so bail out
        // before any path can reach movementSystem.update() with a freed/null body.
        if (!this.characterBody || !this.characterBody.isValid()) return;

        // Side-on 2D games: snap back onto the locked gameplay plane BEFORE any
        // of this frame's reads. Behaviors, pathfinding, crowd avoidance and the
        // movement system are all 3D and drift the NPC off the plane every
        // frame; correcting at the top means everything downstream reasons from
        // an on-plane position, and at most one frame of drift (centimetres)
        // ever renders. Corpses are exempt by construction — the guard above
        // already returned for them, and ragdolls/explosions are physical death
        // visuals that may leave the plane.
        this.applyGameplayPlaneLock();

        // Check game state - only run AI logic when game is PLAYING
        const gameStateManager = this.engine.gameStateManager;
        const isPlaying = gameStateManager ? gameStateManager.isState(GameState.PLAYING) : true;

        // If exploded or ragdolled, the original character/body is gone — stop AI logic.
        // (The death visuals for both already synced above.)
        if (this.healthComp.isExploded() || this.healthComp.isRagdolled()) {
            this.leaveCrowd();
            return;
        }

        // Per-frame LOD bookkeeping: adopt this frame's scheduler stamp, apply
        // transition side effects (body/shadows), accumulate dt for gated work.
        const scheduler = getGlobalLodScheduler();
        this.lodComp.beginFrame(deltaTime, scheduler.isEnabled() ? this.lodState : ALWAYS_FULL_LOD_STATE);
        this.hibernationComp.setSimClass(this.lodComp.state.simClass);
        this.syncCrowdMembership(deltaTime);
        if (this.lodComp.state.simClass === SimClass.VIRTUAL) {
            // Far crowd with a goal: dead-reckoned simulation, no physics/KCC.
            // Respect pause semantics the same way the full path does. While
            // not playing, drop the accumulators — otherwise the first AI tick
            // after unpause would receive the whole pause as one lump and
            // teleport the NPC up to moveSpeed * 10 s along its path.
            if (isPlaying) this.updateVirtual();
            else this.lodComp.dropAccumulators();
            return;
        }

        // Update voxel damage visuals (tint, jitter, chip-off) — near ring only
        if (this.damageVisualController && this.lodComp.state.ring === 0) {
            this.damageVisualController.update(this.damageHpRatio, deltaTime);
        }

        // Check if NPC has fallen below the kill plane (-100)
        // Mark as dead so NpcManager can respawn or destroy it
        const currentY = this.character.position.y;
        if (currentY < -100) {
            this._hasFallenOffWorld = true;
        }

        // Voxel grid safety net: if NPC is embedded in solid terrain (e.g., chunk colliders
        // not yet built during deferred loading), push them to the terrain surface
        const dynamicMgr = this.engine.getDynamicObjectManager?.();
        if (dynamicMgr) {
            const capsuleHeight = this.characterLoader.getCapsuleHeight();
            const correctedY = dynamicMgr.getVoxelFloorY(this.character.position.x, currentY, this.character.position.z);
            if (correctedY !== null) {
                const physicsY = correctedY + capsuleHeight / 2;
                this.characterBody.setTranslation({ x: this.character.position.x, y: physicsY, z: this.character.position.z }, true);
                this.characterBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
                this.character.position.y = correctedY;
            }
        }

        // If physics is held (waiting for terrain colliders), skip physics simulation
        // DynamicObjectManager will call releasePhysics() when colliders are ready
        if (this.hibernationComp.isPhysicsHeld()) {
            this.characterBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
            if (this.tickAnimationLod() !== null) {
                this.poseCharacter();
            }
            // Legacy dt-dropping path: pre-LOD, behavior/movement never saw
            // this frame's dt — keep the accumulators empty so it can't pile
            // into the next granted tick (see NpcLodComponent.dropAccumulators).
            this.lodComp.dropAccumulators();
            return;
        }

        // If game is not in PLAYING state, skip all AI/behavior logic
        // This prevents NPCs from moving/acting during menu, loading, or paused states
        if (!isPlaying) {
            // The body is kinematicPositionBased — it only moves when the motor
            // calls setNextKinematicTranslation, which we skip here, so it simply
            // holds position. (setLinvel is a no-op safety reset.)
            this.characterBody.setLinvel({ x: 0, y: 0, z: 0 }, true);

            // Still update animations for visual consistency (LOD-gated); the
            // pose/physics sync only runs on granted anim ticks (S4 — idle
            // crowds skip the full pose cost on skipped frames).
            const notPlayingAnimDt = this.tickAnimationLod();

            // Update ID nameplate even when not playing (for scene mode)
            if (this.lodComp.state.ring === 0) {
                this.updateNameplate();
            }

            if (notPlayingAnimDt !== null) {
                this.syncVisualsInPlace();
            }
            // Legacy dt-dropping path: pre-LOD, behavior/movement never saw
            // paused-frame dt — keep the accumulators empty so unpause cannot
            // hand the next AI/anim tick the whole pause as one lump.
            this.lodComp.dropAccumulators();
            return; // Skip all behavior and movement logic
        }

        // Avoidance pair — one shared LOD gate for both physics shape queries
        // (they are alternatives: at most one runs per frame).
        if (this.lodComp.consumeAvoidanceTick()) {
            // Step away from any dynamic prop / vehicle the NPC is overlapping or
            // nearly touching. NPCs don't solver-collide with those bodies (so they
            // can't be launched), so this AI nudge is what makes an NPC move aside
            // when a prop is pushed onto it or a vehicle drives through. Takes
            // priority over idle/behaviour so even a standing NPC reacts.
            //
            // Both calls below are PHYSICS SCENE QUERIES — each allocates a wasm
            // capsule and sweeps the whole collider set. That is why the scheduler
            // caps avoidance grants per frame, and why this is timed separately:
            // folded into the controller update it looks like AI cost, when it is
            // really the broad phase.
            const _avoidT0 = performance.now();
            const avoided = this.avoidDynamicObstacles(deltaTime);
            const reacted = avoided ? false : this.reactToPlayerOverlap(deltaTime);
            NpcController.avoidanceMs += performance.now() - _avoidT0;
            if (avoided || reacted) {
                this.updateStationaryFrame(deltaTime, false);
                return;
            }
        }

        // Handle idling state (still run movement system for ground checking)
        if (this.navigationComp.updateIdle(deltaTime)) {
            this.updateStationaryFrame(deltaTime, true);
            return;
        }

        // Check stuck state
        if (this.navigationComp.updateStuck()) {
            // Legacy dt-dropping early return (pre-LOD this frame never
            // reached the behavior block) — see NpcLodComponent.dropAccumulators.
            this.lodComp.dropAccumulators();
            return;
        }

        // Far, disengaged crowd NPC: park it so it can HIBERNATE.
        //
        // Clearing the isHostile() clause out of hasActiveGoal() is not enough on
        // its own — an idle enemy still WANDERS, and a wander target is a nav
        // target, which keeps hasActiveGoal() true and the NPC pinned to VIRTUAL
        // forever. So at the far ring, with nothing being pursued, we drop the
        // target and stop ticking the behaviour that would pick a new one. The
        // NPC then reports no goal and the scheduler hibernates it.
        //
        // Safe to stop ticking: at ring 2 the NPC is beyond r1 (60 m by default)
        // from BOTH camera and player, while detection ranges are metres, so it
        // could not have noticed anything anyway. Approach re-evaluates the ring
        // (every farEvalStaggerFrames at distance) and the behaviour resumes.
        if (this.shouldParkForHibernation()) {
            this.navigationComp.setTargetPosition(null);
            this.updateStationaryFrame(deltaTime, true);
            return;
        }

        // Update behavior — LOD-gated. aiDt is the ACCUMULATED time since the
        // last granted AI tick (equals deltaTime when ticking every frame, i.e.
        // heroes, ring 0, and disabled scheduler).
        const aiDt = this.lodComp.consumeAiTick();
        if (aiDt !== null && this.behavior) {
            const currentTarget = this.navigationComp.getCurrentTarget();
            const newTarget = this.behavior.update(aiDt, this.character.position, currentTarget);
            // Re-read direct-target mode every AI tick, not just at install: a
            // behaviour can alternate between goal-field steps (short, direct,
            // must not invoke A*) and pathfound targets (a wander point metres
            // away through city geometry, which a straight line would walk
            // through walls to reach). Behaviours returning a constant here are
            // unaffected — they just re-assert the same value.
            this.navigationComp.setStraightLinePath(this.behavior.usesDirectTargets?.() ?? false);
            if (this._repathCooldownS > 0) this._repathCooldownS -= aiDt;
            if (newTarget) {
                // Repath ONLY when the destination has moved meaningfully AND the
                // per-NPC cooldown has elapsed (or we have no path yet) — NOT every
                // frame. Chase behaviours return a fresh clone of the player's
                // position each frame, and the player micro-jitters (physics
                // settle, float drift), so the old exact-equality gate
                // (`!newTarget.equals(currentTarget)`) fired a full A* pathfind
                // EVERY frame per NPC. With a crowd of enemies that pins the main
                // thread (findPath is pure CPU) and tanks the frame rate while the
                // GPU sits idle. Distance-threshold + cooldown collapses it to a
                // few pathfinds per second per NPC with no visible loss of chase
                // responsiveness (the movement system still steers continuously
                // along the current path toward the moving target between repaths).
                const movedEnough = !this._lastPathedTarget
                    || newTarget.distanceToSquared(this._lastPathedTarget) > NpcController.REPATH_TARGET_MOVE_SQ;
                const needPath = !this.navigationComp.hasPath();
                if ((movedEnough || needPath) && this._repathCooldownS <= 0) {
                    this.setTargetPosition(newTarget);
                    (this._lastPathedTarget ??= new THREE.Vector3()).copy(newTarget);
                    this._repathCooldownS = NpcController.REPATH_MIN_INTERVAL_S;
                }
            } else if (currentTarget) {
                this.setTargetPosition(null);
                this._lastPathedTarget = null;
            }
        }

        // Move along path. FULL keeps the exact pre-LOD per-frame stepping;
        // COARSE steps the KCC only on granted AI ticks (with the accumulated
        // dt) and dead-reckons the visual in between.
        if (this.lodComp.state.simClass === SimClass.FULL) {
            if (this.navigationComp.hasPath()) {
                this.navigationComp.moveTowardTarget(deltaTime);
                // Target was unreachable (snapped to an obstacle edge) — abandon it so
                // the behaviour picks a new, reachable one instead of parking here.
                if (this.navigationComp.hasStoppedShortOfTarget()) {
                    this.navigationComp.setTargetPosition(null);
                }
            } else {
                // NPC has no path - still run movement system for ground checking
                this.runMovementSystemInternal(deltaTime, new THREE.Vector3(0, 0, 0), false);
            }
        } else if (aiDt === null) {
            // COARSE between KCC steps: extrapolate the visual from the last
            // measured step velocity; the body catches up on the next AI tick.
            this.character.position.x += this.lodComp.lastStepVelocity.x * deltaTime;
            this.character.position.z += this.lodComp.lastStepVelocity.z * deltaTime;
        } else if (this.navigationComp.hasPath()) {
            // COARSE KCC step. The kinematic body applies the queued step at the
            // NEXT physics step, so the achieved velocity is measured across
            // ticks from the body translation (see NpcLodComponent.noteCoarseStep).
            const bodyPos = this.characterBody.translation();
            this.lodComp.noteCoarseStep(bodyPos.x, bodyPos.z, aiDt, this.moveSpeed);
            this.navigationComp.moveTowardTarget(aiDt);
            if (this.navigationComp.hasStoppedShortOfTarget()) {
                this.navigationComp.setTargetPosition(null);
            }
        } else {
            // COARSE idle tick: no path — stop extrapolating and run the motor
            // for ground checking (skipped while the body is LOD-disabled,
            // e.g. the HIBERNATED sim class before chunk hibernation kicks in).
            this.lodComp.lastStepVelocity.set(0, 0, 0);
            if (this.characterBody.isEnabled()) {
                this.runMovementSystemInternal(aiDt, new THREE.Vector3(0, 0, 0), false);
            }
        }

        // Orchestrated movement systems (e.g. NpcSkiMovement) own the body facing:
        // apply their rotation over the navigation component's travel-facing so a
        // rider stands sideways across the board while the feet/board stay downhill.
        // Default (walking) movements leave shouldPlayLocomotionAnimation undefined,
        // so this is skipped and facing stays exactly as before.
        // …unless the movement writes the full body rotation itself (ski lean +
        // stance via player.quaternion), in which case a yaw-only set here would
        // flatten the lean.
        if (
            this.movementSystem.shouldPlayLocomotionAnimation?.() === false &&
            this.movementSystem.controlsBodyRotation?.() !== true
        ) {
            this.character.rotation.y = this.movementSystem.getRotation();
        }

        // Update animation — LOD-gated; the accumulated dt keeps mixer time and
        // the position-delta speed math correct across skipped frames.
        const animDt = this.tickAnimationLod();

        // Update ID nameplate if it exists — near ring only
        if (this.lodComp.state.ring === 0) {
            this.updateNameplate();
        }

        // Root motion handling:
        // - Standard mixer custom animations: sync physics body to follow root bone XZ
        // - Mixamo animations: skip — the Mixamo skeleton handles its own positioning
        //   and the game skeleton's root bone is not driven by the Mixamo player
        const isPlayingStandardCustom = this.animationController?.isPlayingCustom?.()
            && !this.animationController?.getTrackBMixamoPlayer?.();

        if (this.rootBone) {
            if (isPlayingStandardCustom) {
                this.syncPhysicsToRootMotion();
            }
            this.rootBone.position.y = this.rootBoneInitialPosition.y;
        }

        // Update block character using CharacterLoader — only on anim ticks
        if (animDt !== null) {
            this.poseCharacter();
        }

        // Sync character visual with physics body AFTER animation. Skipped on
        // COARSE extrapolation frames — the visual is dead-reckoned ahead of
        // the not-yet-stepped body and syncing would snap it back.
        if (this.lodComp.state.simClass === SimClass.FULL || aiDt !== null) {
            this.syncCharacterWithPhysics();
        }
    }

    /**
     * Run a single frame where the NPC holds still (idling or stepping
     * aside): optionally run the movement motor with zero input so gravity and
     * ground checking still apply, then update animation and sync visuals in place.
     */
    private updateStationaryFrame(deltaTime: number, runMotor: boolean): void {
        // Never drive the motor while the body is LOD-disabled (e.g. the
        // HIBERNATED sim class before chunk hibernation kicks in) — mirrors
        // the COARSE idle branch in update().
        if (runMotor && this.characterBody.isEnabled()) {
            this.runMovementSystemInternal(deltaTime, new THREE.Vector3(0, 0, 0), false);
        }
        // Pose + physics sync only on granted anim ticks: idle crowd NPCs no
        // longer pay the full poseCharacter cost every frame. FULL ring-0
        // characters tick anim every frame, so hero/near behavior is unchanged.
        if (this.tickAnimationLod() !== null) {
            this.syncVisualsInPlace();
        }
        // Legacy dt-dropping path (stunned, avoidance step-aside, idling):
        // pre-LOD, behavior/movement never saw dt spent on these frames — keep
        // the accumulators empty (see NpcLodComponent.dropAccumulators).
        this.lodComp.dropAccumulators();
    }

    /**
     * LOD-gated animation advance: run updateAnimation with the ACCUMULATED dt
     * when the scheduler granted an anim tick this frame. Returns the consumed
     * dt (callers gate poseCharacter on it), or null when the tick was skipped.
     */
    private tickAnimationLod(): number | null {
        const animDt = this.lodComp.consumeAnimTick();
        if (animDt !== null) {
            this.updateAnimation(animDt);
        }
        return animDt;
    }

    /**
     * VIRTUAL sim class frame: dead-reckon along the nav path at the LOD AI
     * cadence — no physics, no KCC, no avoidance. The physics body is disabled
     * (NpcLodComponent transition) and snaps back to the visual on promotion.
     */
    private updateVirtual(): void {
        const aiDt = this.lodComp.consumeAiTick();
        if (aiDt !== null) {
            const pos = this.character.position;
            // Follow the nav path waypoints manually (dead reckoning).
            this.lodComp.advanceAlongPath(this.character, this.navigationComp, this.moveSpeed, aiDt);
            // Behavior still proposes targets at the VIRTUAL cadence (repaths go
            // through the async path queue).
            const newTarget = this.behavior?.update(aiDt, pos, this.navigationComp.getCurrentTarget()) ?? null;
            if (newTarget && !this.navigationComp.hasPath()) {
                this.setTargetPosition(newTarget);
            }
            // Terrain-edit safety: revalidate the floor every tick. A vanished
            // cell (null ground) leaves Y unchanged; after 3 consecutive null
            // ticks clear the path/target so the NPC idles (and becomes
            // HIBERNATED-eligible) instead of walking through edited terrain.
            const nav = getGlobalNavMesh();
            if (nav && nav.isReady()) {
                const groundY = nav.getGroundHeight(pos.x, pos.z);
                if (groundY !== null && groundY !== undefined) {
                    pos.y = groundY;
                    this._virtualNullGroundTicks = 0;
                } else if (++this._virtualNullGroundTicks >= 3) {
                    this._virtualNullGroundTicks = 0;
                    this.navigationComp.clearPath();
                    this.navigationComp.setTargetPosition(null);
                }
            }
        }
        if (this.tickAnimationLod() !== null) {
            this.poseCharacter();
        }
    }

    private syncCharacterWithPhysics(): void {
        // Prefer the motor's per-render-frame target over the substep-quantized
        // body translation (same fix as PlayerController.syncPlayerWithPhysics):
        // the body only advances on fixed 60Hz substeps, so syncing from it
        // stalls on 0-substep frames and double-jumps after catch-up frames.
        // The clamp falls back to the body after teleports/respawns; motors
        // without getRenderPosition keep the body path.
        const pos = resolveRenderSyncPosition(this.movementSystem.getRenderPosition?.(), this.characterBody.translation());
        this.characterLoader.syncCharacterWithPhysics(this.character, this.characterBody, pos);
    }

    /**
     * Reset the root bone to its rest pose, then render the block character in
     * place and sync it with the physics body. Shared by the early-return
     * branches of update() (not-playing, idling) that skip AI and
     * movement but still need the character drawn at its current position.
     */
    private syncVisualsInPlace(): void {
        if (this.rootBone) {
            this.rootBone.position.copy(this.rootBoneInitialPosition);
        }
        this.poseCharacter();
        this.syncCharacterWithPhysics();
    }

    /**
     * Sync physics body to follow root bone XZ during root motion animations.
     * This keeps the collider aligned with the visual during attack lunges.
     */
    private syncPhysicsToRootMotion(): void {
        if (!this.rootBone || !this.characterBody) return;

        // Flush the animation's writes to the bone before reading off it.
        this.rootBone.updateMatrixWorld(true);

        // Get current physics body position
        const currentPos = this.characterBody.translation();

        // Calculate the XZ displacement from root bone's initial world position
        // The root bone initial position is in local space, so we need the character's world position
        const charWorldPos = new THREE.Vector3();
        this.character.getWorldPosition(charWorldPos);
        
        // The displacement is the difference between root bone world pos and character group world pos
        // (accounting for the initial local offset of the root bone)
        const rootLocalXZ = new THREE.Vector3(
            this.rootBone.position.x - this.rootBoneInitialPosition.x,
            0,
            this.rootBone.position.z - this.rootBoneInitialPosition.z
        );
        
        // Transform to world space (apply character rotation)
        rootLocalXZ.applyQuaternion(this.character.quaternion);

        // Move physics body to follow root motion
        const targetX = charWorldPos.x + rootLocalXZ.x;
        const targetZ = charWorldPos.z + rootLocalXZ.z;

        // Only update XZ, keep Y from physics simulation
        this.characterBody.setTranslation(
            { x: targetX, y: currentPos.y, z: targetZ },
            true
        );
    }

    /** Horizontal reach beyond the capsule at which the NPC STARTS stepping away
     *  from a dynamic prop / vehicle (reacts just before contact). */
    private static readonly DYNAMIC_AVOID_MARGIN = 0.3;
    /** Once avoiding, keep going until this much clearance — hysteresis, so the
     *  NPC can't jitter back and forth across the entry boundary. */
    private static readonly DYNAMIC_AVOID_EXIT_MARGIN = 0.7;
    /** Ignore props/vehicles moving slower than this (m/s) — a stationary object
     *  is a navmesh obstacle to route around, not a threat to flee. */
    private static readonly DYNAMIC_AVOID_MIN_SPEED = 0.25;
    /** Hero resistance to crowd separation: it yields a quarter as much as an
     *  ordinary crowd agent, so a boss is not shoved around by its own escort. */
    private static readonly HERO_CROWD_MOBILITY = 0.25;
    /**
     * CPU ms spent in avoidance PHYSICS QUERIES across all NPCs since the last
     * read. Accumulated statically because the cost is a property of the whole
     * crowd, not of one controller, and GameEngine reports it as its own frame
     * span — see takeAvoidanceMs.
     */
    static avoidanceMs = 0;
    /** CPU ms in poseCharacter across all NPCs since the last read. */
    static poseMs = 0;
    /** Squared distance (m^2) the root must move before a re-pose is worthwhile. */
    private static readonly POSE_MOVE_EPSILON_SQ = 1e-8;
    /** Set whenever the skeleton changes (an animation tick); cleared on pose. */
    private poseDirty = true;
    private readonly lastPosedPosition = new THREE.Vector3(Infinity, Infinity, Infinity);
    /** CPU ms in the KCC movement system (a physics shape cast per NPC) since the last read. */
    static moveMs = 0;

    /** Read and reset the shared avoidance accumulator (once per frame). */
    static takeAvoidanceMs(): number {
        const ms = NpcController.avoidanceMs;
        NpcController.avoidanceMs = 0;
        return ms;
    }

    /** Read and reset the shared pose accumulator (once per frame). */
    static takePoseMs(): number {
        const ms = NpcController.poseMs;
        NpcController.poseMs = 0;
        return ms;
    }

    /** Read and reset the shared movement accumulator (once per frame). */
    static takeMoveMs(): number {
        const ms = NpcController.moveMs;
        NpcController.moveMs = 0;
        return ms;
    }

    /** Committed escape direction (unit XZ) while fleeing a prop/vehicle. */
    private _avoidDir: THREE.Vector2 | null = null;

    /** Reach at which an NPC reacts to the player OVERLAPPING it — contact only,
     *  so it does NOT move when the player is merely nearby. */
    private static readonly PLAYER_OVERLAP_MARGIN = 0.05;
    /** Don't react to the player unless they're moving at least this fast (m/s) —
     *  a standing player is routed around, never fled. */
    private static readonly PLAYER_MOVE_MIN_SPEED = 0.5;
    /** Whether this NPC backs away when the player overlaps it (default true,
     *  the social "back off but keep watching" reaction). Hostile NPCs set this
     *  false via setRetreatFromPlayerOverlap() and handle the player themselves. */
    private _retreatFromPlayerOverlap = true;

    /**
     * Walk away from any DYNAMIC_PROP / VEHICLE collider overlapping (or within
     * DYNAMIC_AVOID_MARGIN of) the NPC's capsule. Returns true while avoiding.
     *
     * The escape direction is COMMITTED on first detection and held until clear —
     * re-deriving it every frame whips it around when the NPC is near the
     * obstacle's centre, and the motor (which faces the move direction instantly
     * on the ground) then spins the nose. We do NOT rotate here; the motor faces
     * the now-stable committed direction.
     */
    private avoidDynamicObstacles(deltaTime: number): boolean {
        if (!this.characterBody) return false;
        const c = this.characterBody.translation();
        const { radius, halfHeight } = this.getCapsuleDimensions();
        const margin = this._avoidDir
            ? NpcController.DYNAMIC_AVOID_EXIT_MARGIN
            : NpcController.DYNAMIC_AVOID_MARGIN;
        const away = this.physicsWorld.computeGroupAvoidance(
            { x: c.x, y: c.y, z: c.z },
            radius,
            halfHeight,
            margin,
            CollisionGroup.DYNAMIC_PROP | CollisionGroup.VEHICLE,
            NpcController.DYNAMIC_AVOID_MIN_SPEED,
        );
        if (!away) { this._avoidDir = null; return false; } // clear of obstacles
        if (!this._avoidDir) this._avoidDir = new THREE.Vector2(away.x, away.z);
        // Abandon any path/target that pointed into the obstacle so navigation
        // doesn't immediately tug the NPC back into it (otherwise the avoidance
        // push and nav pull fight at the boundary — jitter in place, path line
        // flickering every other frame). The behaviour picks a fresh, reachable
        // target once the NPC is clear (past the exit margin).
        this.navigationComp.clearPath();
        this.navigationComp.setTargetPosition(null);
        this.runMovementSystemInternal(deltaTime, new THREE.Vector3(this._avoidDir.x, 0, this._avoidDir.y), false);
        return true;
    }

    /**
     * Override the default player-overlap reaction. Hostile / aggressive NPCs
     * call this with `false` so they do NOT back away from the player (their
     * behaviour pushes back or attacks instead). Default is `true` (the social
     * back-away). See docs/spawning-system.md "Entity Activation"/NPC notes.
     */
    setRetreatFromPlayerOverlap(retreat: boolean): void {
        this._retreatFromPlayerOverlap = retreat;
    }

    /**
     * Step straight back when the player capsule OVERLAPS this NPC, WITHOUT
     * turning — the nose stays where it was (the "back off but keep watching you"
     * reaction). Contact-only: nothing happens when the player is merely near.
     * Returns true while reacting. The player re-plans its OWN path around NPCs
     * (PathConflictAvoidance) so this only fires when the player walks straight
     * into a standing NPC. Disabled per-NPC via setRetreatFromPlayerOverlap.
     */
    private reactToPlayerOverlap(deltaTime: number): boolean {
        if (!this._retreatFromPlayerOverlap || !this.characterBody) return false;
        // Only react to a MOVING player walking into us. A stationary player is
        // routed around by PathConflictAvoidance, not fled (otherwise the NPC
        // approaches, backs off, and re-approaches forever).
        const playerSpeed = this.engine.getPlayerController?.()?.getCurrentSpeed?.() ?? 0;
        if (playerSpeed < NpcController.PLAYER_MOVE_MIN_SPEED) return false;
        const c = this.characterBody.translation();
        const { radius, halfHeight } = this.getCapsuleDimensions();
        const away = this.physicsWorld.computeGroupAvoidance(
            { x: c.x, y: c.y, z: c.z },
            radius,
            halfHeight,
            NpcController.PLAYER_OVERLAP_MARGIN,
            CollisionGroup.PLAYER,
        );
        if (!away) return false;
        // Direct displacement (NOT runMovementSystem) so the motor never rotates
        // the body toward the move direction — facing is preserved.
        const stepDist = Math.max(this.moveSpeed, 3.0) * deltaTime;
        this.characterBody.setTranslation(
            { x: c.x + away.x * stepDist, y: c.y, z: c.z + away.z * stepDist },
            true,
        );
        return true;
    }

    /**
     * Internal movement system runner - wraps movement system call with NPC-specific keys format.
     * Called by NavigationComponent via callback.
     */
    private runMovementSystemInternal(deltaTime: number, moveDirection: THREE.Vector3, shouldHop: boolean): void {
        const _moveT0 = performance.now();
        try {
            this.runMovementSystemInner(deltaTime, moveDirection, shouldHop);
        } finally {
            NpcController.moveMs += performance.now() - _moveT0;
        }
    }

    /** @see runMovementSystemInternal — split so the timing wrapper stays one line. */
    private runMovementSystemInner(deltaTime: number, moveDirection: THREE.Vector3, shouldHop: boolean): void {
        const keys = {
            forward: moveDirection.length() > 0,
            backward: false,
            left: false,
            right: false,
            ascend: shouldHop,
            interact: false,
            action: false,
            descend: false
        };

        this.movementSystem.update(
            deltaTime,
            // NpcController stands in for PlayerController for NPCs (see setMovementSystem).
            this as unknown as PlayerController,
            keys,
            true,
            moveDirection,
            this.characterBody,
            this.physicsWorld
        );

        // Update isGrounded based on movement system's ground check
        if (this.movementSystem.wasGroundedLastUpdate) {
            this._isGrounded = this.movementSystem.wasGroundedLastUpdate();
        }

        this.motorRanSinceAnimTick = true;
    }

    private spawnPosition: THREE.Vector3; // Store for reference during initialization

    /**
     * NPC XZ position at the previous animation update. Used to detect whether
     * the NPC is actually translating, rather than just intending to. Null
     * until the first updateAnimation() call.
     */
    private prevAnimPosition: THREE.Vector3 | null = null;

    /**
     * Asymmetrically smoothed actual XZ speed (m/s). The walk animation
     * needs **instant attack** so the NPC doesn't visibly slide for half a
     * second before the legs start cycling, but a **slow release** so a
     * single-frame translation dip (rotation lag on turns, avoidance
     * sidesteps, step-hop cooldowns) doesn't twitch the animation back to
     * idle mid-stride. When the raw speed jumps up the smoothed value snaps
     * to match it; when it drops the smoothed value decays with τ = 0.3s,
     * so a genuine stop still flips to idle inside ~0.5s.
     */
    private smoothedAnimSpeed: number = 0;
    private readonly ANIM_SPEED_RELEASE_TIME_CONSTANT: number = 0.3;

    /**
     * Whether the movement motor ran since the last animation tick. Gates the
     * use of getGroundRelativeSpeed(): the motor's speed is only meaningful for
     * the frame it just solved — on COARSE extrapolation, VIRTUAL, and paused
     * frames a stale value would walk-in-place forever (stale positive) or
     * freeze the cycle while dead-reckoning moves the visual (stale zero).
     */
    private motorRanSinceAnimTick = false;

    private updateAnimation(deltaTime: number): void {
        if (!this.animationController) return;
        const motorWasFresh = this.motorRanSinceAnimTick;
        this.motorRanSinceAnimTick = false;
        // The mixer is about to advance the skeleton, so the cached pose is
        // stale from here on. This is the ONLY thing that moves the bones, so
        // it is the only place that needs to invalidate.
        this.markPoseDirty();

        // Walking-in-place guard: an NPC blocked by an obstacle still "has a
        // path" (it still wants to move), so hasPath() alone keeps the walk
        // cycle running while the NPC is stuck. Measure how far the NPC has
        // actually translated on the XZ plane since the last update and only
        // play the walk animation when it is making real progress.
        const pos = this.character.position;
        let instantaneousSpeed = 0;
        if (this.prevAnimPosition && deltaTime > 0) {
            const dx = pos.x - this.prevAnimPosition.x;
            const dz = pos.z - this.prevAnimPosition.z;
            instantaneousSpeed = Math.hypot(dx, dz) / deltaTime;
            this.prevAnimPosition.copy(pos);
        } else {
            this.prevAnimPosition = pos.clone();
        }

        // Prefer the motor's collision-clamped per-render-frame solve speed
        // (what PlayerController uses): the position delta above differences a
        // substep-quantized signal, so at render rates that alias against the
        // 60Hz physics step it reads 0× and 2× the true speed on alternating
        // frames — and the snap-up envelope below passes the 2× spikes straight
        // into playback rate. A wall-pinned NPC still reads ~0 here (the solve
        // is clamped), so the walking-in-place guard keeps working. The delta
        // remains the fallback for motors without the method and stale frames.
        if (motorWasFresh) {
            instantaneousSpeed = this.movementSystem.getGroundRelativeSpeed?.() ?? instantaneousSpeed;
        }

        // Asymmetric envelope: snap up, decay down. Rising edges pass through
        // unfiltered so the walk cycle starts on the first frame of real
        // motion; falling edges are low-passed with τ = 0.3s so transient
        // dips (single-frame zeros during sharp turns, sidesteps, hops)
        // don't make it through to the animation controller.
        if (instantaneousSpeed >= this.smoothedAnimSpeed) {
            this.smoothedAnimSpeed = instantaneousSpeed;
        } else {
            const alpha = deltaTime > 0 ? Math.min(1, deltaTime / this.ANIM_SPEED_RELEASE_TIME_CONSTANT) : 1;
            this.smoothedAnimSpeed = this.smoothedAnimSpeed * (1 - alpha) + instantaneousSpeed * alpha;
        }

        // Threshold scales with move speed so it works for fast and slow NPCs
        // alike: genuine locomotion clears it; physics jitter or being pinned
        // against an obstacle does not.
        // Movement systems like NpcSkiMovement replace the walk cycle with a held
        // pose (the snowboard stance), so they return false here — mirror what
        // PlayerController does and skip locomotion so the arms/legs stop running.
        const shouldPlayLoco = this.movementSystem.shouldPlayLocomotionAnimation?.() ?? true;
        const movingThreshold = this.moveSpeed * 0.2;
        const isMoving = shouldPlayLoco && this.navigationComp.hasPath() && this.smoothedAnimSpeed > movingThreshold;
        const speed = isMoving ? this.smoothedAnimSpeed : 0;

        this.animationController.updateAnimation(isMoving, speed, true, false);
        // In the crowd only the STATE machine runs (it picks the baked clip);
        // advancing the Mixamo players is the per-NPC skeleton work the batch
        // exists to skip, and the eyes below sit on a hidden body.
        if (this.crowdSlot) return;
        this.animationController.update(deltaTime);

        // Blink + gaze for voxel characters carrying eye metadata; no-op for GLB
        // NPCs. Gaze's costly path only runs when the player is within the
        // controller's tracking distance, so this stays cheap for a distant crowd.
        if (this.vxlEyes) {
            const player = this.engine.getPlayerController?.()?.getPosition?.() ?? null;
            this.vxlEyes.update(deltaTime, this.getPosition(), player);
        }
    }

    /**
     * Interactable interface implementation
     * Bridges PlayerController interaction to NPC behavior's onPlayerInteract() method
     */
    onInteractStart(): boolean {
        // Delegate to behavior's onPlayerInteract() method; default: interaction not handled
        return this.behavior?.onPlayerInteract?.() ?? false;
    }

    getInteractStartDisplayName(): string {
        // Check if behavior has custom display name method (AI agents should implement this).
        // Not part of INpcBehavior, so probe for it structurally.
        // The `typeof` checks below are deliberate: these are duck-typed probes on
        // objects authored outside the engine, which may expose the name as a
        // non-function property. Optional-call syntax would throw on those.
        const namedBehavior = this.behavior as (INpcBehavior & { getInteractDisplayName?: () => string }) | null;
        if (typeof namedBehavior?.getInteractDisplayName === 'function') {
            return namedBehavior.getInteractDisplayName();
        }

        // Fallback: use behavior name with appropriate verb based on canTalkToPlayer
        if (this.behavior) {
            const behaviorName = this.behavior.getName();
            // Check canTalkToPlayer() if implemented, otherwise fall back to !isHostile()
            const canTalk = typeof this.behavior.canTalkToPlayer === 'function'
                ? this.behavior.canTalkToPlayer()
                : !this.behavior.isHostile();

            if (canTalk) {
                return t('game.interaction.talkTo', { name: behaviorName });
            }
            return t('game.interaction.interactWith', { name: behaviorName });
        }
        return t('game.interaction.talkToNpc');
    }

    interactionEnabled(): boolean {
        // Check override first (allows templates to disable interaction during combat/attack mode)
        if (this.interactionEnabledOverride) {
            return this.interactionEnabledOverride();
        }
        // Default: NPCs are interactable if they have a behavior with onPlayerInteract
        return this.behavior !== null && typeof this.behavior.onPlayerInteract === 'function';
    }
    
    /**
     * Set an override callback for interactionEnabled().
     * Use this to disable NPC interaction during combat or attack mode.
     * 
     * @param callback - Function returning true if interaction is enabled, false to disable.
     *                   Pass null to remove the override and use default behavior.
     * 
     * @example
     * // Disable interaction when combat system is in attack mode
     * npc.setInteractionEnabledOverride(() => !combatSystem.isInAttackMode());
     */
    setInteractionEnabledOverride(callback: (() => boolean) | null): void {
        this.interactionEnabledOverride = callback;
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // ChunkManagedObject - Chunk-based hibernation for large worlds
    // ════════════════════════════════════════════════════════════════════════
    
    hibernate(): void {
        this.hibernationComp.hibernate();
    }

    wake(): void {
        this.hibernationComp.wake();
    }

    isHibernating(): boolean {
        return this.hibernationComp.isHibernating();
    }

    holdPhysicsUntilReady(): void {
        if (this.hibernationComp.isPhysicsHeld()) return;
        this.hibernationComp.holdPhysicsUntilReady();

        // Gravity is already 0 (physics bodies start disabled), just ensure velocity is zero
        if (this.characterBody) {
            this.characterBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
        }
    }

    setImportance(importance: 'hero' | 'crowd'): void {
        this.importance = importance;
    }

    /**
     * Opt this NPC out of the side-on gameplay-plane lock — for deliberate
     * backdrop actors (a crowd behind the plane, birds) that must keep their
     * authored Z. No effect in games without a locked plane.
     */
    setPlaneLockEnabled(enabled: boolean): void {
        this.planeLockEnabled = enabled;
    }

    /** The Z this NPC is locked to, or null (no plane, or opted out). */
    private gameplayPlaneZ(): number | null {
        if (!this.planeLockEnabled) return null;
        return this.engine.getGameplayPlaneZ?.() ?? null;
    }

    /**
     * Side-on 2D games: keep this NPC on the locked gameplay plane.
     *
     * The engine's NPC stack is 3D end to end — chase/strafe behaviors, A*
     * paths, the crowd separation solver, dynamic-obstacle avoidance — and each
     * of those moves the NPC in Z a little every frame. Left alone, enemies end
     * up visibly beside the plane the whole game happens on, unreachable by a
     * player who cannot leave it. Snapping position (never velocity — the body
     * is kinematic) once per frame at the top of update() keeps every
     * downstream system reasoning from an on-plane position, which also stops
     * the drift from compounding. Game code should NOT hand-roll this with
     * dead-banded teleports; register the NPC normally and the engine owns it.
     */
    private applyGameplayPlaneLock(): void {
        const planeZ = this.gameplayPlaneZ();
        if (planeZ === null) return;
        if (Math.abs(this.character.position.z - planeZ) < 1e-6) return;
        this.character.position.z = planeZ;
        if (this.characterBody && this.characterBody.isValid()) {
            const t = this.characterBody.translation();
            this.characterBody.setTranslation({ x: t.x, y: t.y, z: planeZ }, true);
        }
    }

    getImportance(): 'hero' | 'crowd' {
        return this.importance;
    }

    // LodManagedCharacter contract (CharacterLodScheduler) — getPosition,
    // getImportance and lodState are defined elsewhere in this class.

    /**
     * Restore FULL simulation after the controller is unregistered from the
     * LOD scheduler without being disposed (NpcRegistry.unregisterController
     * with dispose=false). Nothing stamps lodState anymore at that point, so
     * without this a controller left VIRTUAL/HIBERNATED would stay disembodied
     * (physics body disabled) forever. Stamps ALWAYS_FULL_LOD_STATE and pushes
     * it through the normal beginFrame transition hooks, which re-enables the
     * body (snap-to-visual + setEnabled) and restores shadows.
     */
    resetLodToFull(): void {
        this.lodState = ALWAYS_FULL_LOD_STATE;
        // dt 0: apply the FULL transition without adding accumulator time.
        this.lodComp.beginFrame(0, ALWAYS_FULL_LOD_STATE);
        this.hibernationComp.setSimClass(SimClass.FULL);
    }

    /**
     * True when this NPC is going somewhere or actively pursuing something —
     * keeps it VIRTUAL (progressing) instead of HIBERNATED in the far ring.
     *
     * This deliberately does NOT consult `isHostile()`. That flag is about hit
     * response, and reading it here made every enemy report a permanent goal:
     * HIBERNATED became unreachable for hostile NPCs at any distance, so a world
     * of enemies simulated forever and the crowd tier could never do its job.
     * Engagement (`isEngaged`) is the question that actually matters; behaviours
     * that do not implement it fall back to "engaged when holding a nav target",
     * which is the same answer for anything that only steers with a reason.
     */
    hasActiveGoal(): boolean {
        return this.navigationComp.hasPath()
            || this.navigationComp.getCurrentTarget() !== null
            || (this.behavior?.isEngaged?.() ?? false);
    }

    // ── CrowdMember ─────────────────────────────────────────────────────────
    // Ground-plane state for the crowd solver, which keeps characters from
    // standing inside one another. Nothing else in the engine did this: the two
    // computeGroupAvoidance call sites avoid PROPS/VEHICLES and the PLAYER, so
    // before this NPCs walked through each other and a horde converging on one
    // goal arrived as a single overlapping stack.

    getCrowdX(): number {
        return this.character.position.x;
    }

    getCrowdZ(): number {
        return this.character.position.z;
    }

    getCrowdRadius(): number {
        return this.getCapsuleDimensions().radius;
    }

    /**
     * How freely the solver may displace this NPC. Heroes resist being shoved so
     * a boss holds its ground while its escort yields; ordinary crowd agents are
     * fully mobile. (0 would pin completely — reserved for the player.)
     */
    getCrowdMobility(): number {
        return this.importance === 'hero' ? NpcController.HERO_CROWD_MOBILITY : 1;
    }

    /** In the solver only while alive, awake and actually simulating. */
    isCrowdActive(): boolean {
        return !this.isDeadOrRagdolled()
            && !this.isHibernating()
            && this.lodComp.state.simClass !== SimClass.HIBERNATED;
    }

    /**
     * Apply a solved separation offset. The visual always moves; the kinematic
     * body follows when there is one (a VIRTUAL agent's body is disabled, so it
     * has only a visual to move). Y is untouched — separation is a ground-plane
     * concern and the movement system owns height.
     */
    applyCrowdSeparation(dx: number, dz: number): void {
        this.character.position.x += dx;
        this.character.position.z += dz;
        const body = this.characterBody;
        if (body && body.isValid()) {
            const t = body.translation();
            body.setTranslation({ x: t.x + dx, y: t.y, z: t.z + dz }, true);
        }
    }

    // ── Crowd rendering (CrowdRenderMember) ─────────────────────────────
    //
    // A crowd-tier NPC with a `.vxl` body is drawn by the GPU-posed instanced
    // batch for its body type whenever it is outside DISTANCE ring 0 (25 m by
    // default). Distance ring, not the frustum-forced effective ring: the
    // coarser batch mesh differs slightly from the articulated body, and that
    // pop belongs 25 m away, not at the screen edge. Ring 0 is the articulated
    // tier because that is where an NPC is individual: it can be hit, talked
    // to, picked up, seen up close. Anything that makes it individual further
    // out — damage/death, a held weapon, a pose override, hibernation — hands it
    // back to its own body with its last pose intact.

    /** Instance origin: the ground the articulated pose plants its feet on. */
    getCrowdY(): number {
        return this.character.position.y + this.characterLoader.getBlockFeetOffset();
    }

    getCrowdYaw(): number {
        return this.character.rotation.y + this.modelRotationY;
    }

    getCrowdFrameRow(): number {
        const variant = this.crowdVariant;
        return variant ? resolveFrameRow(variant.table, this.crowdClipIndex, this.crowdClock) : 0;
    }

    /** `.vxl` bodies carry their palette in vertex colours; no per-instance tint. */
    getCrowdColor(): THREE.Color {
        return NpcController.CROWD_UNTINTED;
    }

    getCrowdScale(): number {
        return this.character.scale.y;
    }

    /** True while the instanced batch, not this NPC's own body, is what draws it. */
    isRenderedByCrowd(): boolean {
        return this.crowdSlot !== null;
    }

    private syncCrowdMembership(deltaTime: number): void {
        const wantCrowd = this.importance === 'crowd'
            && this.lodComp.state.distRing >= 1
            && this.lodComp.state.simClass !== SimClass.HIBERNATED
            && this.character.visible
            && !this.isDeadOrRagdolled()
            && !this.weaponComp.isArmed()
            && !this.poseOverrideHandle;
        // No variant means nothing to batch into — a GLB body, or a `.vxl` bake
        // that has not landed yet.
        const variant = this.crowdVariant;
        if (!variant || !wantCrowd) {
            this.leaveCrowd(); // no-op unless a slot is held
            return;
        }
        if (!this.crowdSlot) this.enterCrowd(variant);
        if (!this.crowdSlot) return; // the batch would not hand out a slot

        // The state machine still runs on anim ticks (see updateAnimation) and
        // names the locomotion clip through the active track-A player; the
        // batch just samples the baked copy of that clip at its own clock.
        const motionId = this.animationController?.getActiveMixamoPlayer()?.getAnimationName() ?? null;
        const clip = (motionId !== null ? variant.clipIndexByMotionId.get(motionId) : undefined) ?? variant.idleClipIndex;
        if (clip !== this.crowdClipIndex) {
            this.crowdClipIndex = clip;
            this.crowdClock = 0;
        }
        this.crowdClock += deltaTime;
    }

    private enterCrowd(variant: VxlCrowdVariant): void {
        const slot = getGlobalCrowdRenderer().acquire(variant.key, this);
        if (!slot) return;
        this.crowdSlot = slot;
        // A random phase so a crowd that joined on the same frame does not walk
        // in lockstep.
        this.crowdClock = Math.random() * 2;
        this.syncCharacterAttachment();
    }

    /**
     * Keep the character GROUP in the scene only while something draws it through
     * the graph: not while the crowd batch draws this NPC, and not while the NPC
     * is hidden (hibernated). DETACHED, not merely invisible: `visible = false`
     * still leaves the body's bones in the renderer's per-frame matrix walk, and
     * `matrixWorldAutoUpdate = false` does not help either — a parent whose
     * matrix changed forces its whole subtree, and every NPC group moves every
     * frame. Only a subtree that is not in the graph costs nothing, and that walk
     * was the largest single cost of a 500-strong crowd.
     *
     * The WHOLE group, never a child of it: `getCharacter()` is game-facing, and
     * game code walks its children — Roll City finds the voxel body there to
     * normalise oversized library bodies and to register townsfolk for pickup.
     * Removing the body from the group made every far NPC un-adoptable, and it
     * walked up as a giant. The group is root-level, so its `position` stays
     * the world position while detached.
     */
    private syncCharacterAttachment(): void {
        const parent = this.characterParent;
        if (!parent) return;
        const wantAttached = this.crowdSlot === null && this.character.visible;
        if (wantAttached) {
            if (this.characterDetached) {
                this.characterDetached = false;
                parent.add(this.character);
                this.character.updateMatrixWorld(true);
                this.markPoseDirty();
            }
        } else if (!this.characterDetached && this.character.parent === parent) {
            this.characterDetached = true;
            parent.remove(this.character);
        }
    }

    private leaveCrowd(): void {
        const slot = this.crowdSlot;
        if (!slot) return;
        getGlobalCrowdRenderer().release(slot);
        this.crowdSlot = null;
        this.syncCharacterAttachment();
        this.markPoseDirty();
    }

    /**
     * React to a simulation-tier transition (fired by CharacterLodScheduler).
     *
     * HIBERNATED has to stop the NPC DRAWING, not merely stop it thinking. The
     * tier previously only gated simulation, so 30 hibernated NPCs kept
     * submitting all 570 of their block-character meshes every frame — about 75%
     * of the scene's main-pass draw calls, against 123 for the entire
     * environment. The chunk-hibernation callback could not cover this: NPCs are
     * constructed always-active, so `hibernate()` never fires for them, and
     * `setSimClass` only records the value.
     *
     * Toggled on the TRANSITION rather than per frame so waking is a single
     * visibility flip, and so a promoted NPC is visible again before its first
     * simulated frame.
     */
    onLodChanged(prev: CharacterLodState, next: CharacterLodState): void {
        const wasHidden = prev.simClass === SimClass.HIBERNATED;
        const nowHidden = next.simClass === SimClass.HIBERNATED;
        if (wasHidden === nowHidden) return;
        // A dead/ragdolled NPC is stamped FULL and exempt from demotion, so this
        // cannot hide a corpse mid-animation.
        this.setAllVisualsVisible(!nowHidden);
    }

    /**
     * True when this NPC should stop steering entirely so it can hibernate: a
     * CROWD NPC, in the far ring, pursuing nothing. Heroes never park (they are
     * always FULL by contract), and an engaged crowd NPC keeps progressing —
     * a zombie that has locked onto the player still closes the distance from
     * across the map.
     */
    private shouldParkForHibernation(): boolean {
        if (this.importance !== 'crowd') return false;
        // The DISTANCE ring, never the frustum-clamped `ring`: the effective
        // ring stamps 2 for anything off-screen, and parking on it froze every
        // off-screen guard permanently — parked NPCs never tick their behavior,
        // so they can never engage, so they can never unpark. A troll four
        // metres behind the player was frozen solid until the camera turned.
        if (this.lodComp.state.distRing !== 2) return false;
        if (this.isDeadOrRagdolled()) return false;
        return !(this.behavior?.isEngaged?.() ?? false);
    }

    /** Dead/ragdolled/fallen NPCs are exempt from LOD demotion (stamped FULL). */
    isDeadOrRagdolled(): boolean {
        return this.healthComp.isExploded() || this.healthComp.isRagdolled() || this._hasFallenOffWorld;
    }

    /** One-line controller detail for CharacterLodScheduler.dumpStates() diagnostics. */
    getLodDebugInfo(): string {
        // characterBody is nulled via cast on death/dispose — same guard as update().
        const bodyValid = !!this.characterBody && this.characterBody.isValid();
        return `id=${this.npcId ?? '-'} vis=${this.character.visible ? 'y' : 'n'} crowd=${this.crowdSlot ? 'y' : 'n'}` +
            ` bodyValid=${bodyValid ? 'y' : 'n'}` +
            ` bodyEnabled=${bodyValid && this.characterBody.isEnabled() ? 'y' : 'n'}` +
            ` ragdoll=${this.ragdollComp.hasRagdoll() ? 'y' : 'n'}` +
            ` path=${this.navigationComp.hasPath() ? 'y' : 'n'}` +
            ` target=${this.navigationComp.getCurrentTarget() !== null ? 'y' : 'n'}` +
            ` behavior=${this.behavior ? this.behavior.constructor.name : '-'}`;
    }

    setAlwaysActive(active: boolean): void {
        this.hibernationComp.setAlwaysActive(active);
    }

    /**
     * ChunkPhysicsManager anchor test. Game-code setAlwaysActive(false) is
     * always respected (unchanged legacy behavior). Heroes keep the legacy
     * always-active default; crowd NPCs only anchor their terrain chunk while
     * embodied (FULL/COARSE), so far VIRTUAL/HIBERNATED crowds release chunks.
     * Dead/ragdolled crowd NPCs never anchor — a corpse must not pin its
     * terrain chunk active forever on procedural maps.
     */
    isAlwaysActive(): boolean {
        if (!this.hibernationComp.isAlwaysActive()) return false;
        if (this.importance === 'crowd' && this.isDeadOrRagdolled()) return false;
        if (this.importance === 'hero') return true;
        const sc = this.hibernationComp.getSimClass();
        return sc === SimClass.FULL || sc === SimClass.COARSE;
    }

    /**
     * ChunkPhysicsManager hint: only idle (goal-less) crowd NPCs may
     * chunk-hibernate. Never a corpse: hibernation hides the character group
     * but ragdoll limb meshes live outside it and would stay visible frozen.
     */
    canHibernate(): boolean {
        if (this.isDeadOrRagdolled()) return false;
        return this.importance === 'crowd' && !this.hasActiveGoal();
    }

    releasePhysics(): void {
        const wasHeld = this.hibernationComp.isPhysicsHeld();
        this.hibernationComp.releasePhysics();

        if (this.characterBody) {
            // Only teleport if we were actually held (might have drifted)
            if (wasHeld && this._savedSpawnPosition) {
                const spawn = this._savedSpawnPosition;
                this.placeBodyAtFeet(spawn.x, spawn.y, spawn.z);
            }

            // ALWAYS enable gravity (physics bodies start with gravity=0)
            this.characterBody.setGravityScale(this._originalGravityScale, true);
        }
    }

    /** Set by dispose(): a deferred shatter finding this true has nothing to burst. */
    private disposed = false;

    dispose(): void {
        this.disposed = true;
        // Release the eye controller's mesh references (the meshes themselves are
        // freed with the character group below).
        this.vxlEyes?.dispose();
        this.vxlEyes = null;
        // Drop out of the character LOD scheduler (covers every teardown path:
        // manager destroy/respawn, registry unregister, engine dispose).
        getGlobalLodScheduler().unregisterCharacter(this);
        // Same for the crowd: a disposed controller left in the registry would
        // be gathered every frame and handed separation offsets forever.
        getGlobalCrowd().remove(this);
        this.leaveCrowd();
        // Teardown below expects the group where it was created.
        if (this.characterDetached) {
            this.characterDetached = false;
            this.characterParent?.add(this.character);
        }

        // Dispose interactable trigger sensor
        if (this.interactableComponent) {
            this.interactableComponent.dispose();
            this.interactableComponent = null;
        }

        // Dispose damage flash effect
        this.healthComp.disposeDamageFlash();

        // Dispose voxel damage visuals
        if (this.damageVisualController) {
            this.damageVisualController.dispose();
            this.damageVisualController = null;
        }

        // Dispose ID nameplate
        if (this.idNameplate) {
            this.idNameplate.dispose();
            this.idNameplate = null;
        }

        // Release any held pose before the renderer goes away, so the parts it
        // captured are handed back rather than left frozen mid-lean.
        this.poseOverrideHandle?.release();

        // Dispose behavior first
        if (this.behavior) {
            this.behavior.dispose();
            this.behavior = null;
        }

        // After the behavior, which may unequip on its own way out — the second
        // call is a no-op, and a behavior that forgot still leaves nothing behind.
        this.weaponComp.unequip();

        // Release path-conflict avoidance registration so the system
        // stops scanning a dead NPC's stale path.
        this.navigationComp.dispose();

        // Clean up exploded block physics bodies
        this.explosionComp.dispose(this.physicsWorld);
        this.ragdollComp.dispose(this.physicsWorld);

        // Clean up main character objects
        NpcController.detachFromParent(this.character);

        this.blockWardrobe.disposeAll();

        // Dispose character loader resources
        this.characterLoader.dispose();

        // Clean up main physics body (only if not already destroyed during explosion)
        this.destroyPhysicsBody();

        // Clean up character geometry/materials
        NpcController.disposeMeshTree(this.character);
    }

    /** Detach an object from its parent, if it still has one. */
    private static detachFromParent(object: THREE.Object3D | null | undefined): void {
        if (object?.parent) object.parent.remove(object);
    }

    /**
     * Dispose every mesh's geometry and material(s) under `root` (inclusive) that this NPC
     * actually owns. Anything belonging to the shared character template or the block-part
     * cache is left alone — see SharedCharacterResources for why that distinction matters.
     */
    private static disposeMeshTree(root: THREE.Object3D): void {
        root.traverse((obj: THREE.Object3D) => {
            const mesh = obj as THREE.Mesh;
            if (!mesh.isMesh) return;
            // Cache-owned resources (shared block-part geometry / Lambert
            // materials, flagged __sharedLodCache) are disposed centrally by
            // clearBlockPartCaches() — never per-NPC.
            if (mesh.geometry && !isSharedCharacterResource(mesh.geometry)) {
                mesh.geometry.dispose();
            }
            const materials = Array.isArray(mesh.material)
                ? mesh.material
                : mesh.material ? [mesh.material] : [];
            for (const m of materials) {
                if (!isSharedCharacterResource(m)) m.dispose();
            }
        });
    }

    getPhysicsBody(): RAPIER.RigidBody {
        return this.characterBody;
    }

    /**
     * Get the current position of the NPC character
     */
    getPosition(): THREE.Vector3 {
        return this.character.position;
    }

    /**
     * Teleport this NPC so its FEET (the object origin) sit at the given world
     * point. `y` is the floor level. The engine handles the physics-capsule
     * offset internally — the capsule centre is placed at `y + capsuleHeight/2`
     * so the capsule BOTTOM lands on the floor. Always use this instead of
     * poking the physics body directly: putting the capsule CENTRE at the floor
     * buries the model by half its height (the "sunk to the waist" bug).
     */
    teleportTo(x: number, y: number, z: number): void {
        this.placeBodyAtFeet(x, y, z);
    }

    /**
     * Place the physics capsule and character group so the FEET (the character
     * origin) sit at world (x, y, z), and zero linear velocity. The capsule
     * centre goes to `y + capsuleHeight/2` so the capsule bottom lands on the
     * floor — see teleportTo's note on the "sunk to the waist" bug. Shared by
     * teleportTo, respawnAtSpawn, and releasePhysics.
     */
    private placeBodyAtFeet(x: number, y: number, z: number): void {
        this.character.position.set(x, y, z);
        const physicsY = y + this.characterLoader.getCapsuleHeight() / 2;
        this.characterBody.setTranslation({ x, y: physicsY, z }, true);
        this.characterBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
    }

    /**
     * Check if NPC has fallen off the world (below Y = -100)
     * NpcManager can check this to respawn or destroy the NPC
     */
    hasFallenOffWorld(): boolean {
        return this._hasFallenOffWorld;
    }

    /**
     * Respawn the NPC at its original spawn position
     * Resets the fallen-off-world flag and teleports back to spawn
     */
    respawnAtSpawn(): void {
        const spawn = this._savedSpawnPosition;
        if (!spawn || !this.characterBody) return;

        this.placeBodyAtFeet(spawn.x, spawn.y, spawn.z);
        this.characterBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
        this._hasFallenOffWorld = false;
    }

    /**
     * Get the NPC's character object (for speech bubbles, etc.)
     */
    /**
     * Show or hide EVERY visual this NPC owns — the GLB skeleton, the block
     * character root, and any block variants.
     *
     * Hiding only `character` is not enough and was the bug in the first version
     * of the NPC perf toggle: for a block-rendered NPC the GLB is ALREADY hidden
     * (it exists purely as a bone source), so hiding it again changes nothing
     * while the block character — the thing that actually issues ~19 draw calls
     * — keeps rendering. The toggle appeared to do nothing for exactly that
     * reason.
     */
    setAllVisualsVisible(visible: boolean): void {
        // A hidden NPC must leave the batch too, or it keeps drawing there.
        if (!visible) this.leaveCrowd();
        if (this.character) this.character.visible = visible;
        // One block root covers every variant: a variant is a set of meshes
        // inside this same root, not a second character.
        const blockRoot = this.characterLoader.getBlockCharacterRenderer()?.getRoot();
        if (blockRoot) blockRoot.visible = visible;
        // A hidden body still costs its bone walk; take the group out of the graph.
        this.syncCharacterAttachment();
    }

    getCharacter(): THREE.Object3D {
        return this.character;
    }

    /**
     * Recolour this NPC's eyes (a rigged voxel character with eye metadata).
     * `registerNpc({ eyeLook })` applies one look to every NPC of a type — this
     * is the per-NPC override. Returns false for a character without runtime
     * eyes — a GLB, or a `.vxl` older than v11 whose eyes are baked voxels the
     * engine cannot recolour — so the caller can say so.
     */
    setEyeLook(look: VxlEyeLook): boolean {
        return setVxlCharacterEyeLook(this.character, look);
    }

    /** True when this NPC renders the real skinned GLB (custom Asset Forger character)
     *  rather than the procedural block character. */
    isRenderingSkinnedMesh(): boolean {
        return this.renderSkinned;
    }

    /**
     * Get the NPC's unique ID (if set via constructor)
     */
    getId(): string | null {
        return this.npcId;
    }

    /**
     * Get the NPC's animation controller for loading animation packs
     * 
     * Use this to load additional animations (combat, weapons, etc.) at runtime:
     * 
     * Unarmed punch/kick combat needs no extra pack — the core `mPunching01` and
     * `mKicking01` clips ship in CORE_ANIMATIONS and are auto-registered by
     * `UnarmedMeleeSystem`.
     */
    getAnimationController(): CharacterAnimationController | null {
        return this.animationController;
    }

    /**
     * Get the NPC's block character renderer for arm attachment overrides
     * 
     * Use this to set arm attachment overrides for ranged weapons (same as player):
     */
    getBlockCharacterRenderer(): BlockCharacterRenderer | null {
        return this.characterLoader.getBlockCharacterRenderer();
    }

    /**
     * Enable voxel visual effects for this NPC:
     * - Death: cube fragments scatter outward (configurable variant)
     * - Damage: progressive tint, jitter, and optional chip-off fragments
     *
     * Call once after spawn. The NPC's update() loop drives the animations automatically.
     *
     * @param options - Optional overrides for death and damage configs
     */
    enableVoxelEffects(options?: {
        /** Death effect variant (default: 'normal') */
        deathVariant?: VoxelDeathEffectConfig['variant'];
        /** Number of death fragments (default: 12) */
        deathFragmentCount?: number;
        /** Enable chip-off fragments on damage (default: true) */
        damageChipOff?: boolean;
        /** Full death config override (takes precedence over shorthand options) */
        deathConfig?: Omit<VoxelDeathEffectConfig, 'getPosition' | 'getSourceMesh'>;
        /** Full damage config override (takes precedence over shorthand options) */
        damageConfig?: DamageVisualConfig;
    }): void {
        const scene = this.engine.scene;
        if (!scene) return;

        // Death effect
        const deathCfg: VoxelDeathEffectConfig = {
            variant: options?.deathVariant ?? 'normal',
            fragmentCount: options?.deathFragmentCount,
            ...options?.deathConfig,
            getPosition: () => this.getPosition(),
            getSourceMesh: () => this.getCharacter(),
        };
        this.onDeathEffect = createVoxelDeathEffect(scene, deathCfg);

        // Damage visuals on the block character root
        const blockRoot = this.getBlockCharacterRenderer()?.getRoot();
        if (blockRoot) {
            const damageCfg: DamageVisualConfig = {
                chipOff: options?.damageChipOff ?? true,
                ...options?.damageConfig,
            };
            this.damageVisualController = createDamageVisualSystem(scene, blockRoot, damageCfg);
            this.damageHpRatio = 1.0;

            // Chain with existing onDamage if any
            const existingOnDamage = this.onDamage;
            this.onDamage = (damage: number, currentHealth: number, maxHealth: number, source?: string) => {
                this.damageHpRatio = currentHealth / maxHealth;
                existingOnDamage?.(damage, currentHealth, maxHealth, source);
            };
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    // Block Character Variant System
    // ════════════════════════════════════════════════════════════════════════
    //
    // A variant is a LOOK, not a body: the same renderer, the same skeleton
    // binding and the same pose, with a different set of meshes inside the body
    // part groups. See game/agent-docs/character-outfits.md.

    /**
     * Load an additional block character variant that can be swapped to later.
     * The original block character is variant index 0.
     *
     * @param variantIndex - Unique index for this variant (1, 2, 3, etc.)
     * @param factory - Block character factory to create the variant
     * @returns true if variant was loaded successfully
     */
    loadBlockCharacterVariant(variantIndex: number, factory: IBlockCharacterFactory): boolean {
        return this.blockWardrobe.load(variantIndex, factory);
    }

    /**
     * Switch to a different block character variant.
     *
     * @param variantIndex - Index of the variant to switch to (0 = original)
     * @returns true if switch was successful
     */
    setActiveBlockCharacterVariant(variantIndex: number): boolean {
        // Don't change variants on dead NPCs
        if (this.healthComp.isDead()) {
            console.warn('[NpcController] Cannot switch variant - NPC is dead');
            return false;
        }
        return this.blockWardrobe.activate(variantIndex);
    }

    /**
     * Rebuild this NPC's block meshes from a new factory, keeping the skeleton
     * binding, the current pose and everything attached to a body part (a held
     * weapon, a hat). This is the one-call change of clothes; the indexed
     * variant methods above are for looks you pre-build and swap between
     * repeatedly.
     *
     * @param factory - Block character factory describing the new look
     * @returns true if the NPC was redressed
     */
    redressBlockCharacter(factory: IBlockCharacterFactory): boolean {
        return this.blockWardrobe.redress(factory);
    }

    /**
     * Get the currently active variant index.
     * @returns The active variant index (0 = original)
     */
    getActiveBlockCharacterVariant(): number {
        return this.blockWardrobe.getActiveIndex();
    }

    /**
     * Check if a variant is loaded.
     * @param variantIndex - Index to check
     * @returns true if the variant exists
     */
    hasBlockCharacterVariant(variantIndex: number): boolean {
        return this.blockWardrobe.has(variantIndex);
    }

    /**
     * Install a held stance on the NPC by layering per-bone rotation offsets on
     * top of whatever animation is currently playing (locomotion, idle, …). Each
     * offset is multiplied into the named body part's LOCAL rotation every render
     * frame, so the pose tracks the body as it moves. Pass `null` to clear.
     *
     * This is the same hook the player's SkiMovement uses for the snowboard
     * crouch — generic posing (riding, sitting, aiming), not tied to any one
     * mechanic. Combine with {@link setFootIkTargets} to plant the feet so the
     * legs stop cycling with the walk animation.
     *
     * @param offsets - Map of body-part name → local-space quaternion offset, or null to clear.
     */
    setStanceBoneOffsets(offsets: Map<string, THREE.Quaternion> | null): void {
        this.animationController?.setManualBoneOffsets(offsets);
    }

    /**
     * Plant the NPC's feet at fixed world targets, the knees solving to reach
     * them (e.g. bolting both feet onto a snowboard so they stop cycling with the
     * walk animation). Overrides the leg bones after the base pose; pass `null`
     * to release the legs back to the animation. Mirrors the player foot-IK path;
     * combine with {@link setStanceBoneOffsets}.
     *
     * @param targets - Left/right ankle world transforms + a facing quaternion for the knee pole, or null to clear.
     */
    setFootIkTargets(targets: LegIkTargets | null): void {
        this.animationController?.setFootIkTargets(targets);
    }

    /**
     * Acquire a held pose for this NPC: the parts it names are captured once and
     * then held at absolute offsets on top of whatever animation is playing, the
     * seated height and the feet are pinned, and one hand can reach a world
     * point while the other arm keeps animating. Release the handle to put every
     * captured part back exactly as it was.
     *
     * Prefer this over posing body parts by hand for anything that must HOLD —
     * a seated NPC leaning toward the bar, a hand raised beside the mouth. The
     * per-frame primitives ({@link setStanceBoneOffsets}, {@link setFootIkTargets},
     * `BlockCharacterRenderer.detachFromAnimation`) leave the caller owning the
     * base pose, the root height and both arms, which is how a lean ends up
     * deepening every frame and the body sinking with it.
     *
     * Returns null before the NPC's block character exists (spawn it first).
     * Variant switches only swap mesh sets on the same renderer, so a held pose
     * survives a change of clothes. Only ONE pose override is held at a time:
     * acquiring a second releases the first.
     *
     * @param options - Overrides on DEFAULT_NPC_POSE_OVERRIDE_OPTIONS (a seated upper-body lean).
     */
    acquirePoseOverride(options: Partial<NpcPoseOverrideOptions> = {}): NpcPoseOverrideHandle | null {
        const renderer = this.characterLoader.getBlockCharacterRenderer();
        if (!renderer) {
            console.warn('NpcController: cannot acquire a pose override — this NPC has no block character yet.');
            return null;
        }
        if (this.renderSkinned) {
            // The block character is only the hidden pose/melee proxy for a
            // highres NPC, so a pose written onto it is never drawn.
            console.warn('NpcController: a pose override has no visible effect on a highres (skinned) NPC.');
        }
        this.poseOverrideHandle?.release();
        this.poseOverrideHandle = new NpcPoseOverrideHandle(
            renderer,
            { ...DEFAULT_NPC_POSE_OVERRIDE_OPTIONS, ...options },
            () => { this.poseOverrideHandle = null; }
        );
        return this.poseOverrideHandle;
    }

    /** The pose override currently held by this NPC, or null. */
    getPoseOverride(): NpcPoseOverrideHandle | null {
        return this.poseOverrideHandle;
    }

    /**
     * Attach an object (like a weapon) to a body part of the NPC
     *
     * @param object - The THREE.Object3D to attach (e.g., weapon mesh)
     * @param bodyPartName - Name of body part: 'rightHand', 'leftHand', 'head', etc.
     * @param rotation - Optional rotation correction in degrees
     * @returns true if attachment was successful
     */
    attachToBodyPart(
        object: THREE.Object3D, 
        bodyPartName: string, 
        rotation?: THREE.Vector3 | { x: number; y: number; z: number } | null
    ): boolean {
        const bodyPart = this.getBodyPartObject(bodyPartName);
        if (!bodyPart) {
            console.warn(`NpcController: Cannot attach to '${bodyPartName}' - body part not found`);
            return false;
        }

        // Mark this object as user-attached
        object.userData ??= {};
        object.userData.isUserAttached = true;
        object.userData.attachedToBodyPart = bodyPartName;

        bodyPart.add(object);

        // Preserve the object's intended world-space size. Skinned-mode bones
        // live inside a GLB hierarchy scaled to the NPC's target height, so a
        // parented object would inherit that scale; block-character parts are
        // world-scale ~1, making this a no-op there. The original local scale
        // is stashed so detachFromBodyPart can restore it.
        const bodyPartWorldScale = bodyPart.getWorldScale(new THREE.Vector3());
        if (bodyPartWorldScale.x > 0 && bodyPartWorldScale.y > 0 && bodyPartWorldScale.z > 0) {
            object.userData.preAttachScale = object.scale.clone();
            object.scale.set(
                object.scale.x / bodyPartWorldScale.x,
                object.scale.y / bodyPartWorldScale.y,
                object.scale.z / bodyPartWorldScale.z,
            );
        }

        // Apply rotation correction
        if (rotation) {
            object.rotation.set(
                THREE.MathUtils.degToRad(rotation.x),
                THREE.MathUtils.degToRad(rotation.y),
                THREE.MathUtils.degToRad(rotation.z),
            );
            console.log(`🗡️ NpcController: Attached object to '${bodyPartName}' with rotation (${rotation.x}°, ${rotation.y}°, ${rotation.z}°)`);
        } else if (bodyPartName === 'rightHand' || bodyPartName === 'leftHand') {
            // Default rotation for hands (weapons point upward)
            object.rotation.set(THREE.MathUtils.degToRad(90), 0, 0);
            console.log(`🗡️ NpcController: Attached object to '${bodyPartName}' with default rotation`);
        } else {
            console.log(`🗡️ NpcController: Attached object to '${bodyPartName}'`);
        }

        return true;
    }

    /**
     * Get a body part object for attachment or position queries
     * 
     * @param bodyPartName - Name of body part to get
     * @returns The THREE.Object3D for the body part, or null if not found
     */
    getBodyPartObject(bodyPartName: string): THREE.Object3D | null {
        // Try block character first. In skinned-render mode the block character
        // still exists but is hidden and never updated — it is only the pose
        // source — so attachments must go to the real skeleton bones instead.
        const blockRenderer = this.characterLoader.getBlockCharacterRenderer();
        if (blockRenderer && !this.renderSkinned) {
            const blockRoot = blockRenderer.getRoot();
            let bodyPart: THREE.Object3D | null = null;
            blockRoot.traverse((child: THREE.Object3D) => {
                if (child.name === bodyPartName) {
                    bodyPart = child;
                }
            });
            if (bodyPart) return bodyPart;
        }

        // Fallback: skeleton bones, via the shared canonical alias table
        // (covers Mixamo gen-1/gen-2, Unreal Manny, and plain names, with a
        // case-insensitive fuzzy match as last resort). Search inside the
        // skinned skeleton root when available — the character group also
        // holds invisible full-skeleton clones with identical bone names
        // (action layer, Mixamo track skeletons).
        const boneNames = CANONICAL_BONE_NAMES[bodyPartName];
        if (!boneNames) return null;
        const searchRoot = this.characterLoader.getSkinnedSkeletonRoot() ?? this.character;
        return findBoneByCandidates(searchRoot, boneNames);
    }

    /** Capsule height (metres) of the NPC's physics body. */
    getCapsuleHeight(): number {
        return this.characterLoader.getCapsuleHeight();
    }

    /**
     * Register a weapon-grip IK target for one arm of a skinned (Asset Forger) NPC:
     * the real arm bones are posed each frame so the hand reaches `target`'s world
     * transform + `offset`, oriented by `rotation`. This is the skinned-render
     * counterpart of BlockCharacterRenderer.setArmAttachmentOverride — the block
     * character is hidden in skinned mode, so its arm overrides are invisible and
     * the real skeleton must be posed instead. Mirrors PlayerLoader.setSkinnedArmGrip
     * so ranged NPCs hold their guns the same way the player does.
     */
    setSkinnedArmGrip(side: 'left' | 'right', target: THREE.Object3D, offset: THREE.Vector3, rotation: THREE.Euler): void {
        this.characterLoader.setSkinnedArmGrip(side, target, offset, rotation);
    }

    /** Clear a previously set skinned arm grip (see setSkinnedArmGrip). */
    clearSkinnedArmGrip(side: 'left' | 'right'): void {
        this.characterLoader.clearSkinnedArmGrip(side);
    }

    /**
     * Detach an object from the NPC's body
     *
     * @param object - The object to detach
     */
    detachFromBodyPart(object: THREE.Object3D): void {
        if (object.parent) {
            object.parent.remove(object);

            // Undo the scale normalization applied at attach time so the object
            // keeps its original size back in the scene.
            const preAttachScale = object.userData?.preAttachScale as THREE.Vector3 | undefined;
            if (preAttachScale) {
                object.scale.copy(preAttachScale);
                delete object.userData.preAttachScale;
            }

            console.log('🗡️ NpcController: Object detached from body part');
        }
    }

    /**
     * Get the NPC's unique ID (alias of {@link getId})
     */
    getNpcId(): string | null {
        return this.getId();
    }

    /**
     * Create ID nameplate for scene mode display
     */
    private createIdNameplate(): void {
        if (!this.npcId) return;

        // Import dynamically to avoid circular dependencies
        import('engine/npc/utils/NpcIdNameplate.js').then(({ NpcIdNameplate }) => {
            this.idNameplate = new NpcIdNameplate(
                this.character,
                this.engine,
                this.npcId!
            );
        }).catch(err => {
            console.error('Failed to create NPC ID nameplate:', err);
        });
    }

    /** Refresh the scene-mode ID nameplate, if one exists. */
    private updateNameplate(): void {
        this.idNameplate?.update();
    }

    /**
     * Get the current velocity of the NPC
     */
    getVelocity(): THREE.Vector3 {
        const velocity = this.characterBody.linvel();
        return new THREE.Vector3(velocity.x, velocity.y, velocity.z);
    }

    /**
     * Always false. Stun-on-hit was removed from the engine — hits deal damage
     * and knockback but never freeze the NPC. Kept because ICharacterContext
     * and shipped game code still read it.
     */
    isStunned(): boolean {
        return false;
    }

    /**
     * Check if NPC is currently grounded
     */
    isGrounded(): boolean {
        return this._isGrounded;
    }

    /**
     * Get the player property (needed for movement system compatibility)
     * Movement system needs to access player.rotation
     */
    get player(): THREE.Object3D {
        return this.character;
    }

    // Properties needed by movement system for ground checking
    get characterHeight(): number {
        return this.getCapsuleHeight();
    }

    get capsuleRadius(): number {
        return this.characterLoader.getCapsuleRadius();
    }

    get capsuleHeight(): number {
        return this.getCapsuleHeight();
    }
    
    // Voxel block size for step climbing (set from level data, default 1m)
    voxelBlockSize: number = 1.0;

    // ─── Engine-level strike hit registration ──────────────────────────────
    //
    // When THIS NPC's animation controller starts an attack, the ENGINE
    // registers the hit: the striking thing is sampled at fixed fractions of
    // the clip, tested against the target's body capsule, and damage applied
    // once per attack. The target is the player unless a behavior aimed this
    // NPC elsewhere with setStrikeTarget() — see NpcMeleeTarget.ts.
    //
    // This exists because hit registration living in behavior code proved
    // exactly as fragile as it sounds — a behavior that forgot (or mis-wired)
    // its sweep produced NPCs that visibly punch and never connect. Behaviors
    // now only DECIDE (chase, when to attack, which move); contact is the
    // engine's job, symmetric with the player's melee systems.
    //
    // Unarmed moves ('punch'/'kick') test the fist or boot bone. Weapon moves
    // ('attack') sweep the blade — but ONLY for an NPC whose weapon the engine
    // itself holds (equipMeleeWeapon → NpcWeaponComponent). A behavior that
    // attached its own weapon mesh and runs its own sweep, as
    // EXAMPLE_MeleeNpcBehavior and the games built from it do, leaves this
    // component unarmed and keeps sole ownership of its hits — otherwise both
    // would land and every swing would deal double damage.

    /** Fractions of the strike clip at which the limb is tested — the same
     *  window the player-side hit checks use. */
    private static readonly STRIKE_CHECKPOINTS = [0.15, 0.30, 0.40, 0.50] as const;
    /** Fractions at which a weapon swing is tested. One more, and later, than the
     *  unarmed set: the player's blade sweep uses this window, and a weapon's arc
     *  carries past the point where a punch has already landed or missed. */
    private static readonly WEAPON_CHECKPOINTS = [0.15, 0.30, 0.40, 0.50, 0.60] as const;
    /** Forgiveness margin (m) around the player capsule — mirrors the armed
     *  NPC blade sweep's PLAYER_HIT_MARGIN. */
    private static readonly STRIKE_HIT_MARGIN = 0.25;
    /** Approximate fist/boot radius (m). */
    private static readonly STRIKE_LIMB_RADIUS = 0.12;
    /**
     * How far past the limb, along the NPC's facing, a strike can connect
     * when its move carries no `range` (m).
     *
     * The player-side check is a RAY of `attackRange` metres cast forward
     * from the fist bone — generous by design, because voxel characters are
     * small (a 1.3m-tall fighter's punch extends ~0.4m of world reach; honest
     * point-contact measured a best-case 0.65m gap at normal fighting
     * distance and never landed a single hit). The NPC side projects the
     * same way so both halves of a fist fight obey one rule. Behaviors pass
     * their `attackRange` through the move's `range` for exact symmetry.
     */
    private static readonly STRIKE_DEFAULT_REACH = 1.4;
    /** Target HP removed by a strike whose move carries no `damage`. */
    private static readonly STRIKE_DEFAULT_DAMAGE = 10;
    private static readonly _tmpStrikeLimb = new THREE.Vector3();
    private static readonly _tmpStrikeEnd = new THREE.Vector3();

    /** The weapon the engine holds for this NPC, and the contact it makes. Unarmed until
     *  `equipMeleeWeapon()`, which is the state every NPC that punches stays in. */
    private readonly weaponComp = new NpcWeaponComponent(this);

    /** Monotonic id so a new attack invalidates the previous one's pending checks. */
    private strikeAttackSeq = 0;

    /** Who the next strike is tested against; null means the player. */
    private strikeTarget: NpcMeleeTarget | null = null;

    /**
     * Aim this NPC's strikes at someone other than the player — another NPC in a
     * free-for-all, a faction rival. Set it BEFORE `startAttack()`: the contact checks are
     * scheduled off the swing and read the target when they fire. `null` restores the
     * default, which is the player. Applies to fists and to an engine-held weapon alike.
     *
     * `NpcMeleeAttack` calls this for you on every strike; a behavior only needs it when
     * it drives `startAttack()` itself. Build the argument with `playerMeleeTarget()` or
     * `npcMeleeTarget()` from `engine/npc/index.js`.
     */
    setStrikeTarget(target: NpcMeleeTarget | null): void {
        this.strikeTarget = target;
    }

    /**
     * Put a melee weapon in this NPC's right hand and let the engine own it: the mesh is
     * created from `WeaponRegistry`, held correctly through the swing, and its blade lands
     * the hits for any `type: 'attack'` move the NPC plays.
     *
     * This does NOT register the swing animations — an NPC armed this way still needs
     * `MELEE_WEAPON_ANIMATIONS` loaded and the weapon's moves registered, which is what
     * `NpcMeleeAttack`'s `weapon` config does end to end. Reach for this directly only in a
     * behavior that drives its own attacks.
     *
     * @returns false when the hand isn't there yet (the character is still loading).
     */
    equipMeleeWeapon(options: NpcMeleeWeaponOptions): boolean {
        return this.weaponComp.equip(options);
    }

    /** Remove the engine-held weapon. Idempotent; leaves behavior-attached meshes alone. */
    unequipMeleeWeapon(): void {
        this.weaponComp.unequip();
    }

    /** True while the engine holds a melee weapon for this NPC — i.e. while weapon swings
     *  land through `equipMeleeWeapon` rather than through a behavior's own sweep. */
    hasMeleeWeapon(): boolean {
        return this.weaponComp.isArmed();
    }

    /** Grip of the held weapon (`'one'` while unarmed) — selects its swing set through
     *  `weaponMovesFor()`. */
    getMeleeWeaponGrip(): 'one' | 'two' {
        return this.weaponComp.getGrip();
    }

    private wireStrikeHitRegistration(animCtl: CharacterAnimationController): void {
        // The ENGINE slot — the public setAttackStartedListener stays free for
        // behaviors/templates, which would otherwise silently replace this.
        animCtl.setEngineAttackStartedListener(({ moveName, duration }) => {
            const move = animCtl.getAttackMoveConfig?.(moveName);
            if (!move) return;
            if (move.type === 'punch' || move.type === 'kick') {
                this.scheduleHitChecks(animCtl.getAttackContactCheckPhases(NpcController.STRIKE_CHECKPOINTS), duration, () => this.tryLandStrike(move));
                return;
            }
            // Weapon swing — ours to land only when the engine is the one holding the
            // weapon. See the section comment above on why this is not unconditional.
            if (move.type === 'attack' && this.weaponComp.isArmed()) {
                this.weaponComp.beginSwing();
                this.scheduleHitChecks(animCtl.getAttackContactCheckPhases(NpcController.WEAPON_CHECKPOINTS), duration, () => this.tryLandWeaponHit(move));
            }
        });
    }

    /**
     * Sample `land` at each fraction of the clip until it connects. One set per attack:
     * a swing damages its target once, and a NEW attack invalidates the previous one's
     * pending samples through `strikeAttackSeq`.
     */
    private scheduleHitChecks(
        checkpoints: readonly number[],
        durationSeconds: number,
        land: () => boolean,
    ): void {
        const seq = ++this.strikeAttackSeq;
        const playback = this.animationController?.getAttackPlaybackToken();
        let landed = false;
        for (const fraction of checkpoints) {
            // Gameplay time (pause-safe) — see GameplayTimers.ts.
            scheduleGameplaySeconds(durationSeconds * fraction, () => {
                // Stale (a newer attack started), already connected, or the
                // world stopped simulating — same gating as the player side.
                if (seq !== this.strikeAttackSeq || landed) return;
                if (playback && this.animationController?.getAttackPlaybackToken() !== playback) return;
                if (getGameStateManager()?.isState(GameState.PLAYING) === false) return;
                if (this.healthComp.isDead()) return;
                if (land()) landed = true;
            });
        }
    }

    /** Sweep the held weapon against the target; apply damage on contact. */
    private tryLandWeaponHit(move: CustomAttackMove): boolean {
        const target = this.strikeTarget ?? playerMeleeTarget(this.engine.getPlayerController?.());
        if (!target || target.isDead()) return false;
        const weapon = this.weaponComp.getOptions();
        return this.weaponComp.sweep(
            target,
            move.damage ?? weapon?.damage ?? NpcController.STRIKE_DEFAULT_DAMAGE,
            move.range ?? weapon?.reach ?? NpcController.STRIKE_DEFAULT_REACH,
        );
    }

    /** Test the striking limb against the target's capsule; apply damage on contact. */
    private tryLandStrike(move: CustomAttackMove): boolean {
        const target = this.strikeTarget ?? playerMeleeTarget(this.engine.getPlayerController?.());
        if (!target || target.isDead()) return false;

        const limb = this.findStrikeLimb(move.type === 'kick', move.side ?? 'right');
        if (!limb) return false;
        const limbPos = NpcController._tmpStrikeLimb;
        limb.getWorldPosition(limbPos);

        // Segment-vs-capsule: the limb projects forward along the NPC's facing
        // for the move's reach, mirroring the player-side forward raycast from
        // the fist bone. (See STRIKE_DEFAULT_REACH for why a bare point test
        // cannot work at voxel character scale.)
        const reach = move.range ?? NpcController.STRIKE_DEFAULT_REACH;
        const ry = this.character.rotation.y;
        const strikeEnd = NpcController._tmpStrikeEnd.set(
            limbPos.x + Math.sin(ry) * reach,
            limbPos.y,
            limbPos.z + Math.cos(ry) * reach,
        );
        const padding = NpcController.STRIKE_LIMB_RADIUS + NpcController.STRIKE_HIT_MARGIN;
        if (!segmentHitsTarget(limbPos, strikeEnd, target, padding)) return false;

        target.takeDamage(move.damage ?? NpcController.STRIKE_DEFAULT_DAMAGE, 'npc_strike');
        return true;
    }

    /** Fist/foot node for a strike — same name heuristics as UnarmedMeleeSystem. */
    private findStrikeLimb(isKick: boolean, side: 'left' | 'right'): THREE.Object3D | null {
        const boneNames = isKick ? ['foot', 'toe', 'ankle'] : ['hand', 'wrist', 'finger'];
        const sideIndicators = side === 'left' ? ['left', '_l', 'l_'] : ['right', '_r', 'r_'];
        let found: THREE.Object3D | null = null;
        this.character.traverse((child) => {
            if (found) return;
            const name = child.name.toLowerCase();
            if (boneNames.some(n => name.includes(n)) && sideIndicators.some(sd => name.includes(sd))) {
                found = child;
            }
        });
        return found;
    }

    /**
     * Default melee hit handler - applies damage, knockback, and effects.
     * 
     * This is the built-in implementation that handles:
     * - State checks (dead/exploded)
     * - Behavior delegation
     * - Damage calculation (respects oneHitKill config)
     * - Physics knockback
     * - Hit effect callback
     * 
     * Call this from your custom onMeleeHit handler if you want to extend
     * rather than replace the default behavior:
     */
    public defaultMeleeHitHandler(impactDirection?: THREE.Vector3, impulseStrength: number = 8): void {
        if (this.healthComp.isExploded() || this.healthComp.isDead()) return;

        // Check if behavior wants to handle the hit
        if (this.behavior?.onHit?.(impactDirection)) return;

        // Apply damage - one-hit kill or normal damage calculation
        const config = this.healthComp.getDamageableConfig();
        const damage = config.oneHitKill ? this.healthComp.getMaxHealth() + 1 : impulseStrength * 2;
        // Knockback along the swing for a lethal ragdoll death (ignored on a non-lethal hit).
        const meleeImpulse = impactDirection ? ragdollKnockback(impactDirection, impulseStrength) : undefined;
        this.takeDamage(damage, 'melee', meleeImpulse);

        // Apply physical impact (non-lethal hits only — a lethal hit nulls characterBody via ragdoll/explode)
        if (impactDirection && this.characterBody) {
            this.characterBody.applyImpulse({
                x: impactDirection.x * impulseStrength,
                y: 2,
                z: impactDirection.z * impulseStrength
            }, true);
            this.characterBody.wakeUp();
        }

        // Trigger melee hit effect callback
        if (this.onMeleeHitEffect && impactDirection) {
            this.onMeleeHitEffect(this.hitEffectPosition(), impactDirection, damage);
        }
    }

    takeDamage(amount: number, source?: string, deathImpulse?: THREE.Vector3): void {
        // A hit makes the NPC individual: back to its own body BEFORE the health
        // component runs, so a death inside this call finds the skinned mesh to
        // shatter rather than a detached one.
        this.leaveCrowd();
        // First hit warms the death-shatter caches for this body type, so the
        // kill that follows doesn't pay the voxel parse mid-fight. Deferred to
        // here from spawn so a peaceful crowd never pays it at all; a one-shot
        // kill of an unwarmed type pays the parse once (tens of ms), exactly as
        // `shatterIntoVoxels()` on a never-hit NPC does.
        this.prewarmShatter();
        this.healthComp.takeDamage(amount, source, deathImpulse);
    }

    /**
     * Parse this NPC's voxel body for the bone-voxel shatter ahead of time, so
     * the shatter itself (a death, or `shatterIntoVoxels()`) does not pay the
     * parse — tens of ms on a detailed body — on the frame it plays. The engine
     * calls this on the first hit; call it yourself during `load()` for an NPC
     * you will detonate on cue (a cutscene, an interaction) before anything has
     * damaged it. Once per body type: every clone of a character shares the
     * parse, so a crowd costs one call. A no-op for block-character NPCs.
     */
    prewarmShatter(): void {
        if (!this.renderSkinned || this.shatterPrewarmed) return;
        this.shatterPrewarmed = true;
        prewarmSkinnedVoxelShatter(this.character);
    }

    isDead(): boolean {
        return this.healthComp.isDead();
    }

    getHealth(): number {
        return this.healthComp.getHealth();
    }

    getMaxHealth(): number {
        return this.healthComp.getMaxHealth();
    }

    /**
     * Retune this NPC's max health at runtime (difficulty scaling, buffs).
     * Also restores current health to the new max and revives a dead NPC —
     * see HealthComponent.setMaxHealth. To set health once at spawn, prefer
     * `engine.registerNpc(name, behavior, { damageable: { maxHealth } })`.
     */
    setMaxHealth(maxHealth: number): void {
        this.healthComp.setMaxHealth(maxHealth);
    }

    /**
     * Heal by `amount`, capped at max health. Returns whether health actually
     * moved — false if the NPC is already full or dead. `onDamage` does NOT
     * fire on a heal, so drive health bars from the return value.
     */
    heal(amount: number): boolean {
        return this.healthComp.heal(amount);
    }

    /** Restore to full health and revive if dead (clears ragdoll state). */
    resetHealth(): void {
        this.healthComp.resetHealth();
    }

    /**
     * No-op. Stun-on-hit was removed from the engine — hits never freeze NPCs —
     * but shipped game code still calls this, so the method stays.
     */
    setStunDuration(seconds: number): void {
        void seconds;
    }

    /**
     * How long the corpse lingers after a ragdoll death, in milliseconds.
     * `<= 0` keeps it until `dispose()`. Takes effect immediately, so it also
     * extends or cuts short a body already on the ground.
     *
     * Note: at spawn this value is taken from `damageable.debrisLifetimeMs`,
     * which also governs explosion-debris lifetime — this setter is the only way
     * to control the corpse independently of the debris.
     */
    setCorpseLifetimeMs(ms: number): void {
        this.ragdollComp.setCorpseLifetimeMs(ms);
    }

    setDamageFlashEnabled(enabled: boolean): void {
        this.healthComp.setDamageFlashEnabled(enabled);
    }

    getDamageFlash(): import('engine/effects/DamageFlash.js').DamageFlash | null {
        return this.healthComp.getDamageFlash();
    }

    /**
     * Called when the NPC is hit by projectile - instant kill + explosion
     */
    onProjectileHit(): void {
        if (this.healthComp.isExploded()) return;

        console.log('💥 NPC hit by projectile! Exploding into pieces!');
        this.behavior?.onNpcDeath?.();

        if (this.healthComp.onDeathEffect) {
            this.healthComp.onDeathEffect();
        }

        this.explodeCharacter();
        this.healthComp.markExploded();
    }

    isExploded(): boolean {
        return this.healthComp.isExploded();
    }

    /** Roughly chest-height point on the NPC where hit VFX (melee/projectile) spawn. */
    private hitEffectPosition(): THREE.Vector3 {
        const hitPos = this.character.position.clone();
        hitPos.y += 1.0;
        return hitPos;
    }

    public onProjectileCollision(projectile: ProjectileLike): void {
        // Check if behavior wants to handle the hit
        if (this.behavior?.onHit?.()) return;

        const damage = projectile.getDamage?.() ?? 25;
        const travelDir = projectile.getDirection?.()?.clone() ?? new THREE.Vector3(0, 0, 1);
        const hitDirection = travelDir.clone().negate(); // toward the shooter — used to face the hit effect

        // Knockback along the bullet's travel for a lethal ragdoll death, from the projectile's own
        // knockback (per-weapon punch). Cars/crates push via the solver instead, not this path.
        const deathImpulse = ragdollKnockback(travelDir, projectile.getKnockback?.() ?? 6);
        this.takeDamage(damage, 'projectile', deathImpulse);

        if (this.onProjectileHitEffect) {
            this.onProjectileHitEffect(this.hitEffectPosition(), hitDirection, damage);
        }
    }

}
