/**
 * AnimalController - 4-Legged Animal Character Controller
 * 
 * ════════════════════════════════════════════════════════════════════════════════
 * 🐕 THIS IS FOR ANIMALS (4-LEGGED CREATURES)
 * ════════════════════════════════════════════════════════════════════════════════
 * 
 * Use this for: Dogs, wolves, cats, horses, bears, lions, tigers, foxes, etc.
 * 
 * For humans/humanoids (2-legged), use NpcController instead.
 * 
 * ════════════════════════════════════════════════════════════════════════════════
 * ⚔️ COMBAT: Implements IDamageable (see engine/IDamageable.ts)
 * ════════════════════════════════════════════════════════════════════════════════
 * 
 * Animals can be hit by melee weapons and will:
 * - Take damage (default 100 HP)
 * - Explode into physics blocks when killed
 * 
 * **How hits are detected (automatically, no code needed!):**
 * 1. WeaponMeleeSystem/UnarmedMeleeSystem casts rays (NOT physics collisions!)
 * 2. Rays hit animal mesh → finds mesh.userData.damageableController
 * 3. Calls animal.onMeleeHit(direction, impulseStrength)
 * 
 * **To customize hit/death behavior:**
 * 
 * **📚 For damage system details, see:**
 * - engine/IDamageable.ts - The damage interface
 * - engine/WeaponMeleeSystem.ts - How weapon hits work
 * - engine/animal/index.ts - More examples
 * 
 * ════════════════════════════════════════════════════════════════════════════════
 * ⚠️ CRITICAL: UPDATE REQUIREMENTS
 * ════════════════════════════════════════════════════════════════════════════════
 * 
 * AnimalController instances MUST be updated every frame!
 * 
 * Or use AnimalRegistry for automatic updates:
 * ════════════════════════════════════════════════════════════════════════════════
 */

import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import type { IBlockCharacterFactory } from 'engine/IBlockCharacterFactory.js';
import { LegacyNavMesh } from 'engine/LegacyNavMesh.js';
import { createClassedPartMaterial } from 'engine/ClassedPartMaterial.js';
import { getGameEventLog } from 'engine/recording/GameEventLog.js';
import { getGlobalNavMesh } from 'engine/VoxelNavMesh.js';
import type { IPlayerMovement } from 'engine/IPlayerMovement.js';
import { WalkingAndJumpingMovement } from 'engine/WalkingAndJumpingMovement.js';
import { CharacterLoader } from 'engine/loaders/CharacterLoader.js';
import type { INpcBehavior } from 'engine/npc/INpcBehavior.js';
import { GameState } from 'engine/GameStateManager.js';
import type { Interactable } from 'types/interactable.js';
import { GlbAnimalBody } from 'engine/animal/GlbAnimalBody.js';
import { resolveVoxelAnimal } from 'engine/animal/VoxelAnimalRegistry.js';
import { BlockAnimalAnimationController } from 'engine/animal/BlockAnimalAnimationController.js';
import type { IDamageable, DamageableConfig } from 'engine/IDamageable.js';
import type { BloodSplatterConfig, DeathExplosionConfig } from 'engine/effects/HitEffects.js';
import { CollisionGroup, CollisionMask } from 'engine/CollisionLayers.js';
import { t } from 'engine/i18n/index.js';
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
import { AnimalAvoidanceComponent } from 'engine/animal/AnimalAvoidanceComponent.js';
import { AnimalMediumSensor } from 'engine/animal/AnimalMediumSensor.js';
import { Animal3DMovement, DEFAULT_SWIM_MOVEMENT_OPTIONS, DEFAULT_FLIGHT_MOVEMENT_OPTIONS } from 'engine/animal/AnimalLocomotion3D.js';

/**
 * Configuration options for the fluent configure() API
 */
export interface AnimalConfigOptions {
    /** Enable one-hit kill (dies on first melee/projectile hit) */
    oneHitKill?: boolean;
    
    /** Enable blood splatter particles on hit */
    bloodOnHit?: boolean;
    /** Blood splatter customization */
    bloodConfig?: BloodSplatterConfig;
    
    /** Enable death explosion with gore particles */
    explodeWithGore?: boolean;
    /** Death explosion customization */
    goreConfig?: DeathExplosionConfig;
    
    /** Callback when animal dies (for quest tracking, loot, etc.) */
    onDeath?: (killerDirection?: THREE.Vector3) => void;
}

/**
 * Input state from a rider controlling the animal.
 * Movement is camera-relative, no strafing for 4-legged animals.
 */
export interface RiderInput {
    forward: boolean;
    backward: boolean;
    left: boolean;
    right: boolean;
    sprint: boolean;
    /** Target rotation in radians - animal will smoothly turn to face this direction */
    targetRotation?: number;
}

/**
 * AnimalController - AI-controlled 4-legged animal with physics and procedural animations
 * 
 * Implements IDamageable for melee/projectile hit detection.
 * Animals can be hit by weapons and will explode into blocks when killed.
 * 
 * ════════════════════════════════════════════════════════════════════════════════
 * ⚠️ WARNING: MELEE HIT DETECTION USES RAYCASTING, NOT PHYSICS COLLISIONS!
 * ════════════════════════════════════════════════════════════════════════════════
 * 
 * ❌ WRONG - Checking physics collision manifolds:
 * 
 * ✅ CORRECT - Override the onMeleeHit callback:
 * 
 * See: engine/IDamageable.ts for full documentation
 * See: engine/WeaponMeleeSystem.ts for how hit detection works
 * ════════════════════════════════════════════════════════════════════════════════
 */
export class AnimalController implements Interactable, IDamageable, ChunkManagedObject, ICharacterContext {
    private character: THREE.Object3D;
    private characterBody: RAPIER.RigidBody | null = null;
    private physicsWorld: PhysicsWorld;
    private engine: EngineLike;
    private animalType: string;
    private animalDimensions: { width: number; height: number; depth: number };
    private animationController: GlbAnimalBody | BlockAnimalAnimationController;
    private characterLoader: CharacterLoader;
    private spawnPosition: THREE.Vector3;

    // Shared components
    private hibernationComp: HibernationComponent;
    private navigationComp: NavigationComponent;

    // ── Character LOD (CharacterLodScheduler) ──
    // Simulation importance tier: 'hero' = full fidelity at any distance, 'crowd' = LOD-scaled.
    private importance: 'hero' | 'crowd' = 'hero';
    /** Per-frame LOD bookkeeping (accumulators + transition side effects). */
    private lodComp: NpcLodComponent;
    /** Stamped by the CharacterLodScheduler every evaluate() (LodManagedCharacter contract). */
    lodState: CharacterLodState = ALWAYS_FULL_LOD_STATE;
    /** Meshes that START shadow-casting — the LOD shadow toggle flips exactly this set. */
    private shadowMeshes: THREE.Mesh[] = [];
    /** Consecutive VIRTUAL AI ticks with no navmesh ground under the animal. */
    private _virtualNullGroundTicks = 0;

    // Behavior system
    private behavior: INpcBehavior | null = null;

    // Navigation (legacy fields kept for movement system and speed config)
    private moveSpeed: number;
    private currentSpeed: number;
    private navMesh: LegacyNavMesh | null = null;
    private movementSystem: IPlayerMovement;
    /** Reactive avoidance & obstacle-escape (extracted component). */
    private avoidanceComp: AnimalAvoidanceComponent;

    // ── Free-volume locomotion (fish swim, birds fly) ──
    /** How this creature traverses the world; stamped by the body builder. */
    private locomotionMode: 'ground' | 'swim' | 'fly' = 'ground';
    /** Water / terrain queries for containment (3D modes only). */
    private mediumSensor: AnimalMediumSensor | null = null;
    /** Direct 3D seek target (replaces navmesh pathing in 3D modes). */
    private _target3D: THREE.Vector3 | null = null;
    /** Last position where a swimmer was properly in its medium — a beached
     *  fish flops back toward this to recover instead of soft-locking on land. */
    private _lastInMediumPos = new THREE.Vector3();
    /** Minimum flight clearance above terrain for flying creatures (m). */
    private static readonly MIN_FLIGHT_CLEARANCE = 1.5;

    // State
    private _isGrounded: boolean = false;
    isGrounded: boolean = false;  // Public property for movement system (matches PlayerController)

    // Shared components (health + explosion)
    private healthComp: HealthComponent;
    private explosionComp: BlockExplosionComponent;
    private ragdollComp: RagdollComponent;
    
    // Carry system (CarryableComponent)
    private _isBeingCarried: boolean = false;

    // Riding system
    private _rideable: boolean = false;
    private _isBeingRidden: boolean = false;
    private _rider: THREE.Object3D | null = null;
    private _riderInput: RiderInput | null = null;
    private _mountHeight: number = 0; // Calculated from animal dimensions
    private _rideSpeed: number = 0; // Speed multiplier when ridden (default: 1.5x normal)
    
    // Eye animation system
    private eyeController: AnimalEyeController | null = null;

    // Rapier trigger sensor for interaction detection
    private interactableComponent: InteractableComponent | null = null;
    
    /**
     * Callback when rider is forcefully dismounted (e.g., animal dies).
     * Set by PlayerAnimalController to handle cleanup.
     */
    public onRiderForceDismount?: (animal: AnimalController, rider: THREE.Object3D) => void;

    /**
     * Callback for custom melee hit effects (blood splatter, particles, etc.)
     * Override this to add visual effects when the animal is struck by melee.
     * 
     * @param position - World position where hit occurred
     * @param direction - Direction of impact (from attacker toward animal)
     * @param damage - Amount of damage dealt
     */
    public onMeleeHitEffect?: (position: THREE.Vector3, direction: THREE.Vector3, damage: number) => void;

    /**
     * Callback for custom projectile hit effects (impact particles, etc.)
     * Override this to add visual effects when the animal is struck by a projectile.
     * 
     * @param position - World position where hit occurred
     * @param direction - Direction of impact (from projectile)
     * @param damage - Amount of damage dealt
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
     * This is called when the animal is struck by a melee weapon or unarmed attack.
     * By default, it uses `defaultMeleeHitHandler()` which:
     * - Applies damage (or instant kill if oneHitKill is true)
     * - Applies knockback physics
     * - Triggers hit effects
     * 
     * Override to customize ALL hit behavior:
     * 
     */
    public onMeleeHit: (impactDirection?: THREE.Vector3, impulseStrength?: number) => void;

    private constructor(
        scene: THREE.Scene,
        physicsWorld: PhysicsWorld,
        engine: EngineLike,
        spawnPosition: THREE.Vector3,
        animalType: string,
        blockCharacterFactory: IBlockCharacterFactory,
        body: GlbAnimalBody | null,
        aquatic: boolean,
        moveSpeed: number = 3.0,
        stunDuration: number = 0.5, // Ignored — stun-on-hit was removed; kept so call sites keep compiling
        damageableConfig?: Partial<DamageableConfig>
    ) {
        this.moveSpeed = moveSpeed;
        this.currentSpeed = moveSpeed; // Start at full speed
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
        // DEFAULT: always-active (engine safe default; see NpcController and
        // docs/spawning-system.md "Entity Activation" for the full rationale).
        // Keeps the animal simulating and its ground chunk's colliders enabled
        // regardless of camera frustum, so it never sinks through the world.
        // GAME CODE may call setAlwaysActive(false) to hibernate non-critical
        // animals off-screen for perf.
        this.hibernationComp.setAlwaysActive(true);
        this.physicsWorld = physicsWorld;
        this.engine = engine;
        this.animalType = animalType;
        // animalDimensions will be set after createBlockCharacter() applies scaling
        this.animalDimensions = { width: 0.5, height: 0.5, depth: 0.5 }; // Temporary default
        this.spawnPosition = spawnPosition.clone();
        
        // Initialize health component
        this.healthComp = new HealthComponent({
            onPreDeath: () => {
                if (this._isBeingRidden) this.forceDismountRider();
                getGameEventLog().logEvent({
                    type: 'death',
                    position: this.character?.position ?? this.spawnPosition,
                    actor: 'animal',
                });
            },
            onExplode: () => {
                this.explosionComp.explode();
            },
            onRagdoll: (deathImpulse?: THREE.Vector3) => {
                this.ragdollComp.ragdoll(deathImpulse);
            },
        }, damageableConfig);

        // Initialize explosion component (smaller blocks and less force than humanoids)
        this.explosionComp = new BlockExplosionComponent(
            { blockSize: 0.08, forceMin: 3, forceMax: 5, debrisLifetimeMs: damageableConfig?.debrisLifetimeMs },
            {
                getEngine: () => this.engine,
                getPhysicsWorld: () => this.physicsWorld,
                getCharacter: () => this.character,
                getPhysicsBody: () => this.characterBody,
                restoreFlashImmediately: () => this.healthComp.restoreFlashImmediately(),
                collectMeshes: () => {
                    const meshes: THREE.Mesh[] = [];
                    this.character.updateMatrixWorld(true);
                    this.character.traverse((obj: THREE.Object3D) => {
                        if (obj instanceof THREE.Mesh) meshes.push(obj);
                    });
                    return meshes;
                },
                onPostExplosion: () => this.detachFromWorld(),
            },
        );

        // Ragdoll component — alternative death effect (ragdollOnDeath). Coarse jointed skeleton
        // (AnimalBody hub + head/tail/legs/wings) from the named block-animal parts.
        const animalCombat = this.engine.getGameData?.()?.worldProfileData?.combatConfig;
        this.ragdollComp = new RagdollComponent(
            {
                ...DEFAULT_RAGDOLL_CONFIG,
                corpseLifetimeMs: damageableConfig?.debrisLifetimeMs ?? DEFAULT_RAGDOLL_CONFIG.corpseLifetimeMs,
                jointLimits: animalCombat?.ragdollJointLimits ?? DEFAULT_RAGDOLL_CONFIG.jointLimits,
                selfCollision: animalCombat?.ragdollSelfCollision ?? DEFAULT_RAGDOLL_CONFIG.selfCollision,
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

        // Initialize melee hit handler to default implementation
        // Users can override this property to customize hit handling
        this.onMeleeHit = this.defaultMeleeHitHandler.bind(this);

        // Initialize character loader
        this.characterLoader = new CharacterLoader(engine);

        // Only create LegacyNavMesh if VoxelNavMesh is not available (avoids expensive raycast grid)
        if (!getGlobalNavMesh()?.isReady()) {
            this.navMesh = new LegacyNavMesh(engine);
        }

        // Initialize navigation component
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
            {
                enabled: true,
                getCharacterDepth: () => this.animalDimensions.depth,
            },
        );

        // Initialize movement system
        this.movementSystem = new WalkingAndJumpingMovement(moveSpeed, {
            gravity: -35.0,
            terminalVelocity: 53.0,
            jumpHeight: 1.0,
            airControlMultiplier: 0.5,
            groundFriction: 0.9,
            airFriction: 0.98
        });

        // Reactive avoidance & obstacle-escape recovery
        this.avoidanceComp = new AnimalAvoidanceComponent({
            getCharacter: () => this.character,
            getPhysicsBody: () => this.characterBody,
            getPhysicsWorld: () => this.physicsWorld,
            getEngine: () => this.engine,
            getCapsuleRadius: () => this.characterLoader.getCapsuleRadius(),
            getCapsuleHeight: () => this.characterLoader.getCapsuleHeight(),
            getMoveSpeed: () => this.moveSpeed,
            clearNavigation: () => {
                this.navigationComp.clearPath();
                this.navigationComp.setTargetPosition(null);
            },
            clearPath: () => this.navigationComp.clearPath(),
            runMovementSystem: (dt, dir) => this.runMovementSystem(dt, dir),
        });

        // Create character group
        this.character = new THREE.Group();
        this.character.name = `AnimalController_${animalType}`;
        this.character.position.copy(spawnPosition);
        this.navigationComp.initializePreviousPosition(spawnPosition);

        // Create the visible body. Animals with a close match in the voxel pack
        // use the voxelized skinned GLB (with its own inbuilt idle/walk/run
        // clips); everything else (fish, dragons, and any type with no close
        // voxel match) falls back to the procedural block-composed body.
        const characterGroup = new THREE.Group();
        this.character.add(characterGroup);

        let dimensions: { width: number; height: number; depth: number };
        if (body) {
            characterGroup.name = `${animalType}_VoxelCharacter`;
            characterGroup.add(body.getObject3D());
            // The GLB body is also the animation driver.
            this.animationController = body;
            // Dimensions come from the GLB body's bind-pose bounds.
            dimensions = body.getDimensions();
        } else {
            characterGroup.name = `${animalType}_BlockCharacter`;
            blockCharacterFactory.createBlockCharacter(characterGroup);

            // Grab the eye controller if the builder created one.
            if (characterGroup.userData.eyeController) {
                this.eyeController = characterGroup.userData.eyeController as AnimalEyeController;
            }

            // Procedural gait animation controller for block-based animals.
            const blockController = new BlockAnimalAnimationController();
            void blockController.initializeWithCharacter(this.character, null, null, []);
            this.animationController = blockController;

            dimensions = blockCharacterFactory.getCharacterDimensions();
        }

        // Free-volume locomotion (3D swim/fly): a voxel FISH body always swims;
        // a block body swims/flies if its builder stamped that mode on the group.
        // Swap the default ground motor for the 3D one + a medium sensor.
        const stampedMode = characterGroup.userData.locomotionMode as string | undefined;
        const swimFlyMode: 'swim' | 'fly' | null = aquatic
            ? 'swim'
            : stampedMode === 'swim' || stampedMode === 'fly'
                ? stampedMode
                : null;
        if (swimFlyMode) {
            this.locomotionMode = swimFlyMode;
            this.mediumSensor = new AnimalMediumSensor(engine);
            this.movementSystem = new Animal3DMovement(
                moveSpeed,
                swimFlyMode === 'swim' ? DEFAULT_SWIM_MOVEMENT_OPTIONS : DEFAULT_FLIGHT_MOVEMENT_OPTIONS
            );
            this._lastInMediumPos.copy(spawnPosition);
        }

        // LOD transition side effects: body disable + snap-back on VIRTUAL
        // promotion/demotion, shadow toggles on ring changes. Free-volume
        // creatures (fish/birds) clamp at COARSE — they have no navmesh path to
        // dead-reckon along, so they must never disembody (see NpcLodComponent).
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
            this.locomotionMode !== 'ground' ? SimClass.COARSE : undefined,
        );

        // Convert MeshStandardMaterial to MeshLambertMaterial so animals respond
        // to local lighting (like terrain does) instead of environment maps.
        // The voxel mesh carries per-vertex colours, which the conversion keeps.
        convertGroupToLambertLighting(characterGroup);

        // Initialize damage flash effect on the visible character group
        this.healthComp.initDamageFlash(characterGroup);

        scene.add(this.character);
        
        // Calculate proper capsule dimensions and feet offset for the animal
        // This is critical for correct ground positioning
        this.character.updateMatrixWorld(true);
        const animalBox = new THREE.Box3().setFromObject(this.character);
        this.animalDimensions = dimensions;
        
        // Set capsule dimensions based on actual animal size
        const capsuleHeight = dimensions.height * 0.9;  // Slightly smaller for padding
        const capsuleRadius = Math.max(dimensions.width, dimensions.depth) / 2 * 0.8;
        this.characterLoader.setCapsuleDimensions(capsuleHeight, Math.max(0.15, Math.min(capsuleRadius, 0.5)));
        
        // Calculate feet offset (distance from character origin to bottom of feet)
        // The animal's feet should be at the bottom of the bounding box
        const feetOffsetY = animalBox.min.y - this.character.position.y;
        this.characterLoader.setFeetOffset(feetOffsetY);
        
        console.log(`🐾 Animal "${animalType}" dimensions: height=${dimensions.height.toFixed(2)}, feetOffset=${feetOffsetY.toFixed(3)}`);
        
        // Calculate mount height for riding (top of the animal's back)
        this._mountHeight = dimensions.height * 0.9;
        // Default ride speed is 1.5x normal movement speed
        this._rideSpeed = moveSpeed * 1.5;

        // Create kinematic physics body (manual movement control)
        // Using kinematic body instead of character controller for better speed control
        this.characterBody = this.characterLoader.createPhysicsBody(
            this.spawnPosition,
            this.physicsWorld,
            -35.0,
            CollisionGroup.ANIMAL,
            CollisionMask.ANIMAL
        );

        // Register animal in physics body userData for collision identification.
        // `agentRadius` is read by AgentAvoidance when other agents query this
        // body as a neighbor.
        this.physicsWorld.setUserData(this.characterBody, {
            __type: 'animal',
            animalController: this,
            agentRadius: this.characterLoader.getCapsuleRadius(),
        });
        
        // Immediately sync visual position with physics body
        this.syncCharacterWithPhysics();

        // Create trigger sensor for interaction detection (attached to animal's physics body)
        if (this.characterBody) {
            this.interactableComponent = new InteractableComponent(this.physicsWorld, {
                interactable: this,
                object3D: this.character,
                physicsBody: this.characterBody,
                radius: 3.0,
            });
        }
        
        // Store physics body reference in all meshes for melee detection
        this.storePhysicsBodyInMeshes();

        // Shadow LOD: snapshot the meshes that START shadow-casting once —
        // NpcLodComponent toggles castShadow on exactly this set, so meshes
        // that never cast shadows stay untouched.
        const shadowCasters: THREE.Mesh[] = [];
        this.character.traverse((child: THREE.Object3D) => {
            const mesh = child as THREE.Mesh;
            if (mesh.isMesh && mesh.castShadow) shadowCasters.push(mesh);
        });
        this.shadowMeshes = shadowCasters;

        // Async pathfinding: coalesce this animal's queued path requests under
        // a stable key, ordered by hero/crowd priority + camera distance.
        this.navigationComp.setNavKey(`animal-${this.character.id}`);
        this.navigationComp.setLodPriorityProvider(() => ({
            hero: this.importance === 'hero',
            distSq: this.engine.camera
                ? this.character.position.distanceToSquared(this.engine.camera.position)
                : 0,
        }));
    }

    /**
     * Create a 4-legged animal from a block-based factory
     * 
     * @param scene - Three.js scene
     * @param physicsWorld - Rapier physics world
     * @param engine - Game engine
     * @param spawnPosition - Where to spawn the animal
     * @param animalType - Name for this animal type (for logging/identification)
     * @param moveSpeed - Movement speed (default: 1.5 for slow roaming)
     * @param factory - Block character factory from createBlockAnimalFactory()
     */
    static async create(
        scene: THREE.Scene,
        physicsWorld: PhysicsWorld,
        engine: EngineLike,
        spawnPosition: THREE.Vector3,
        animalType: string,
        moveSpeed: number,
        factory: IBlockCharacterFactory
    ): Promise<AnimalController> {
        // Use spawn position as-is - it should already be correctly positioned by findValidVoxelSpawnPosition
        // Only adjust if spawn position Y is invalid (0 or NaN)
        const adjustedSpawnPosition = spawnPosition.clone();

        // Resolve the voxel body first; null means no close match in the packs
        // (e.g. dragon, octopus) → fall back to the block-composed factory.
        // Fish resolve from the fish pack and SWIM; land animals walk.
        const resolved = resolveVoxelAnimal(animalType);
        const body = resolved ? await GlbAnimalBody.load(resolved) : null;
        const aquatic = resolved?.isFish ?? false;

        // Swimming/flying creatures spawn exactly where asked — terrain-height
        // and navmesh snapping are ground concepts (snapping would beach a fish
        // on the nearest walkable shore cell). A GLB fish is aquatic; a GLB land
        // animal walks; the block fallback follows its factory's locomotion hint.
        const isGroundCreature = body
            ? !aquatic
            : (factory.getLocomotionMode?.() ?? 'ground') === 'ground';

        if (isGroundCreature && (spawnPosition.y === 0 || isNaN(spawnPosition.y)) && engine.getWorldHeightAt) {
            // Fallback: only adjust if spawn position doesn't have a valid Y coordinate
            const groundHeight = engine.getWorldHeightAt(spawnPosition.x, spawnPosition.z);
            if (groundHeight !== undefined && groundHeight !== null && !isNaN(groundHeight)) {
                adjustedSpawnPosition.y = groundHeight;
            }
        }

        // Never spawn an animal on a navmesh obstacle — it would start stranded
        // and have to recover out immediately.
        // Snap to the nearest walkable cell. Guarded on navmesh readiness: during
        // initial world-gen the navmesh may not be built yet, in which case we
        // leave the position as-is (obstacle-escape recovery is the backstop).
        const spawnNav = getGlobalNavMesh();
        if (isGroundCreature && spawnNav && spawnNav.isReady() && !spawnNav.isWalkableAt(adjustedSpawnPosition.x, adjustedSpawnPosition.z)) {
            const safe = spawnNav.findNearestValidTarget(adjustedSpawnPosition);
            if (safe) {
                adjustedSpawnPosition.x = safe.x;
                adjustedSpawnPosition.z = safe.z;
                adjustedSpawnPosition.y = safe.y;
            }
        }

        const animal = new AnimalController(
            scene,
            physicsWorld,
            engine,
            adjustedSpawnPosition,
            animalType,
            factory,
            body,
            aquatic,
            moveSpeed,
            0.5
        );

        // No default behavior - AI should set it via dog.setBehavior()
        // Available: AnimalRoamBehavior, AnimalFollowBehavior, AnimalIdleBehavior, AnimalPatrolBehavior

        console.log(`✅ Created ${animalType} - call setBehavior() to set movement`);

        return animal;
    }

    /**
     * Update the animal - MUST be called every frame!
     */
    update(deltaTime: number): void {
        // Skip update if hibernating (chunk-based optimization)
        if (this.hibernationComp.isHibernating()) return;

        // Skip update if physics is held (waiting for terrain colliders)
        if (this.hibernationComp.isPhysicsHeld()) return;

        // Voxel grid safety net: if animal is embedded in solid terrain (e.g., chunk colliders
        // not yet built during deferred loading), push them to the terrain surface.
        // GROUND creatures only — a fish swimming near the lake bed would otherwise be
        // snapped to the terrain surface (out of the water) every frame, and a low-flying
        // bird yanked down; 3D creatures rely on their own medium containment instead.
        if (this.locomotionMode === 'ground' && this.characterBody) {
            const dynamicMgr = this.engine.getDynamicObjectManager?.();
            if (dynamicMgr) {
                const feetY = this.character.position.y;
                const correctedY = dynamicMgr.getVoxelFloorY(this.character.position.x, feetY, this.character.position.z);
                if (correctedY !== null) {
                    const capsuleH = this.characterLoader.getCapsuleHeight();
                    this.characterBody.setTranslation({ x: this.character.position.x, y: correctedY + capsuleH / 2, z: this.character.position.z }, true);
                    this.characterBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
                    this.character.position.y = correctedY;
                }
            }
        }

        // Always sync exploded blocks with physics (visual update)
        if (this.explosionComp.hasExplodedBlocks()) {
            this.explosionComp.syncExplodedBlocks();
        }

        // Sync ragdoll limbs with physics (visual update). Ring-gated on the
        // LIVE scheduler stamp (this.lodState): a corpse near the camera keeps
        // settling, a far one freezes, and sync resumes when the camera returns.
        if (this.ragdollComp.hasRagdoll() && this.lodState.ring <= 1) {
            this.ragdollComp.syncRagdoll();
        }

        // If exploded/dead, don't continue with AI logic
        if (this.healthComp.isExploded() || this.healthComp.isDead()) {
            return;
        }

        // Skip all AI/physics when being carried by CarryableComponent
        if (this._isBeingCarried) {
            return;
        }

        // Check game state
        const gameStateManager = this.engine.gameStateManager;
        const isPlaying = gameStateManager ? gameStateManager.isState(GameState.PLAYING) : true;

        // Per-frame LOD bookkeeping: adopt this frame's scheduler stamp, apply
        // transition side effects (body/shadows), accumulate dt for gated work.
        // Default-hero animals (and a disabled scheduler) always see FULL/all
        // ticks, so the flow below reduces to the legacy per-frame path.
        const scheduler = getGlobalLodScheduler();
        this.lodComp.beginFrame(deltaTime, scheduler.isEnabled() ? this.lodState : ALWAYS_FULL_LOD_STATE);
        this.hibernationComp.setSimClass(this.lodComp.state.simClass);
        if (this.lodComp.state.simClass === SimClass.VIRTUAL) {
            // Far ground crowd with a goal: dead-reckoned simulation, no
            // physics/KCC. While not playing, drop the accumulators so unpause
            // cannot hand the first tick the whole pause as one lump.
            if (isPlaying) this.updateVirtual();
            else this.lodComp.dropAccumulators();
            return;
        }

        // Handle rider control mode (player is riding this animal). Runs the
        // legacy per-frame path (the rider is at camera distance, so the stamp
        // is FULL anyway); drop accumulators for dt-parity with the pre-LOD
        // early return.
        if (this._isBeingRidden && this._riderInput) {
            this.updateRiderControl(deltaTime);
            this.lodComp.dropAccumulators();
            return;
        }

        if (!isPlaying) {
            this.updateStationaryFrame(deltaTime);
            return;
        }

        // Free-volume locomotion (fish/birds) replaces everything below:
        // navmesh pathing, obstacle escape and ground avoidance are ground
        // concepts — 3D creatures seek their targets directly with medium
        // containment instead.
        if (this.locomotionMode !== 'ground') {
            this.updateLocomotion3DLod(deltaTime);
            return;
        }

        // Avoidance trio — one shared LOD gate for the physics shape queries
        // (they are alternatives: at most one runs per frame). FULL ticks
        // avoidance every frame, preserving the legacy hero flow.
        if (this.lodComp.consumeAvoidanceTick()) {
            // Obstacle-escape recovery takes priority over idle/behavior: an animal
            // standing on a navmesh obstacle (climbed or pushed onto it) can't
            // pathfind out. Move it DIRECTLY off the obstacle
            // before any other navigation runs.
            if (this.avoidanceComp.recoverFromObstacle(deltaTime)) {
                this.updateActiveFrame(deltaTime);
                return;
            }

            // Step away from any dynamic prop / vehicle the animal is overlapping or
            // nearly touching. Animals don't solver-collide with those bodies (so they
            // can't be launched), so this AI nudge is what makes a sheep trot aside
            // when a barrel is pushed onto it or a vehicle drives through — it takes
            // priority over idle/behaviour so even a grazing animal reacts.
            if (this.avoidanceComp.avoidDynamicObstacles(deltaTime)) {
                this.updateActiveFrame(deltaTime);
                return;
            }

            // Back away (keeping facing) when the player walks into this animal.
            if (this.avoidanceComp.reactToPlayerOverlap(deltaTime)) {
                this.updateActiveFrame(deltaTime);
                return;
            }
        }

        // Handle idling state (legacy order: motor, anim, eyes, sync — with the
        // anim tick gating the animation + physics sync like NpcController)
        if (this.navigationComp.updateIdle(deltaTime)) {
            if (this.characterBody && this.characterBody.isEnabled()) {
                this.runMovementSystem(deltaTime, new THREE.Vector3(0, 0, 0));
            }
            const idleAnimDt = this.lodComp.consumeAnimTick();
            if (idleAnimDt !== null) {
                this.updateAnimation(idleAnimDt, false);
            }
            this.updateEyes(deltaTime);
            if (idleAnimDt !== null) {
                this.syncCharacterWithPhysics();
            }
            // Legacy dt-dropping path (see NpcLodComponent.dropAccumulators).
            this.lodComp.dropAccumulators();
            return;
        }

        // Check stuck state
        if (this.navigationComp.updateStuck()) {
            // Legacy dt-dropping early return (pre-LOD this frame never
            // reached the behavior block) — see NpcLodComponent.dropAccumulators.
            this.lodComp.dropAccumulators();
            return;
        }

        // Update behavior — LOD-gated. aiDt is the ACCUMULATED time since the
        // last granted AI tick (equals deltaTime when ticking every frame, i.e.
        // heroes, ring 0, and disabled scheduler).
        const aiDt = this.lodComp.consumeAiTick();
        if (aiDt !== null && this.behavior) {
            const currentTarget = this.navigationComp.getCurrentTarget();
            const newTarget = this.behavior.update(aiDt, this.character.position, currentTarget);
            if (newTarget && (!currentTarget || !newTarget.equals(currentTarget))) {
                this.setTargetPosition(newTarget);
            } else if (!newTarget && currentTarget) {
                this.setTargetPosition(null);
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
            } else if (this.navigationComp.isPathPending()) {
                // A queued async path request is still in flight (result lands
                // 1-3 frames after submit). Do NOT beeline via
                // updateNoPathApproach and do NOT clear the target on blocked —
                // clearing cancels the queued request, the behavior re-targets,
                // and the submit/cancel cycle livelocks. Hold still this frame
                // (zero-input motor keeps grounding), mirroring NpcController's
                // pathless idle.
                if (this.characterBody && this.characterBody.isEnabled()) {
                    this.runMovementSystem(deltaTime, new THREE.Vector3(0, 0, 0));
                }
            } else {
                // No path and nothing pending - smooth approach behavior for animals
                const animalRadius = Math.max(this.animalDimensions.width, this.animalDimensions.depth) / 2;
                this.navigationComp.updateNoPathApproach(deltaTime, animalRadius);
                // If the straight approach was blocked by a navmesh obstacle, the
                // target is unreachable from here — drop it so the behavior picks a
                // new, reachable target next frame instead of pushing into the obstacle.
                if (this.navigationComp.isNoPathApproachBlocked()) {
                    this.navigationComp.setTargetPosition(null);
                }
            }
        } else if (aiDt === null) {
            // COARSE between KCC steps: extrapolate the visual from the last
            // measured step velocity; the body catches up on the next AI tick.
            this.character.position.x += this.lodComp.lastStepVelocity.x * deltaTime;
            this.character.position.z += this.lodComp.lastStepVelocity.z * deltaTime;
        } else if (this.characterBody) {
            // COARSE step at the AI cadence. The kinematic body applies the
            // queued step at the NEXT physics step, so the achieved velocity is
            // measured across ticks (see NpcLodComponent.noteCoarseStep). Both
            // the path step and the no-path approach can move the body.
            const bodyPos = this.characterBody.translation();
            this.lodComp.noteCoarseStep(bodyPos.x, bodyPos.z, aiDt, this.moveSpeed);
            if (this.navigationComp.hasPath()) {
                this.navigationComp.moveTowardTarget(aiDt);
                if (this.navigationComp.hasStoppedShortOfTarget()) {
                    this.navigationComp.setTargetPosition(null);
                }
            } else if (this.navigationComp.isPathPending()) {
                // In-flight queued path request: hold still at the AI cadence
                // (see the FULL branch note — running the no-path approach or
                // clearing the target here would cancel the request and
                // livelock).
                if (this.characterBody.isEnabled()) {
                    this.runMovementSystem(aiDt, new THREE.Vector3(0, 0, 0));
                }
            } else if (this.characterBody.isEnabled()) {
                const animalRadius = Math.max(this.animalDimensions.width, this.animalDimensions.depth) / 2;
                this.navigationComp.updateNoPathApproach(aiDt, animalRadius);
                if (this.navigationComp.isNoPathApproachBlocked()) {
                    this.navigationComp.setTargetPosition(null);
                }
            }
        }

        // Update animation - animate legs whenever actually moving. LOD-gated;
        // the accumulated dt keeps gait phase and speed math consistent.
        this.currentSpeed = this.navigationComp.getCurrentSpeed();
        const actuallyMoving = this.currentSpeed > 0.1;
        const animDt = this.lodComp.consumeAnimTick();
        if (animDt !== null) {
            this.updateAnimation(animDt, actuallyMoving);
        }

        // Update eye animations (blinking + look at player) — near ring only
        this.updateEyes(deltaTime);

        // Sync with physics. Skipped on COARSE extrapolation frames — the
        // visual is dead-reckoned ahead of the not-yet-stepped body and syncing
        // would snap it back.
        if (this.lodComp.state.simClass === SimClass.FULL || aiDt !== null) {
            this.syncCharacterWithPhysics();
        }
    }
    
    /**
     * LOD wrapper for the free-volume path. FULL (heroes, ring 0, disabled
     * scheduler) runs the legacy per-frame updateLocomotion3D with the raw
     * deltaTime. COARSE (the only demoted class — free-volume clamps at
     * COARSE, never VIRTUAL/HIBERNATED) runs the full 3D step only on granted
     * AI ticks with the accumulated dt and extrapolates the visual by the last
     * measured body velocity (including Y — birds dive, fish sound) in between.
     */
    private updateLocomotion3DLod(deltaTime: number): void {
        if (this.lodComp.state.simClass === SimClass.FULL) {
            this.updateLocomotion3D(deltaTime);
            // The 3D path handles movement AND animation per-frame with the
            // raw deltaTime (applyLocomotion3DStep) — none of the gated
            // accumulators are consumed here. Drop them so a later demotion
            // to COARSE cannot hand the first granted tick an up-to-10s lump
            // (teleport / fast-forwarded animation).
            this.lodComp.dropAccumulators();
            return;
        }
        const aiDt = this.lodComp.consumeAiTick();
        if (aiDt === null) {
            const v = this.lodComp.lastStepVelocity;
            this.character.position.x += v.x * deltaTime;
            this.character.position.y += v.y * deltaTime;
            this.character.position.z += v.z * deltaTime;
            return;
        }
        if (this.characterBody) {
            const bodyPos = this.characterBody.translation();
            this.lodComp.noteCoarseStep(bodyPos.x, bodyPos.z, aiDt, this.moveSpeed, bodyPos.y);
        }
        this.updateLocomotion3D(aiDt);
        // updateLocomotion3D just simulated AND animated the whole accumulated
        // aiDt span (its animation runs inside applyLocomotion3DStep, not via
        // consumeAnimTick). Drop the remaining accumulators — mirroring how
        // the ground path consumes the anim accumulator after moving — so a
        // crowd fish crossing into ring 1 (or a pause) cannot replay the same
        // span as an animation/AI lump later.
        this.lodComp.dropAccumulators();
    }

    /**
     * VIRTUAL sim class frame (far ground crowd with a goal): dead-reckon along
     * the nav path at the LOD AI cadence — no physics, no KCC, no avoidance.
     * The physics body is disabled (NpcLodComponent transition) and snaps back
     * to the visual on promotion. Mirrors NpcController.updateVirtual.
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
            // ticks clear the path/target so the animal idles (and becomes
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
        const animDt = this.lodComp.consumeAnimTick();
        if (animDt !== null) {
            this.updateAnimation(animDt, this.navigationComp.hasPath());
        }
    }

    /**
     * One frame of free-volume locomotion (fish swimming / birds flying).
     *
     * Replaces the navmesh pipeline: the behavior still proposes targets via
     * the same INpcBehavior contract, but the animal seeks them directly
     * through the volume. Containment clamps keep fish inside water (no
     * breaching) and birds above terrain; a fish out of water loses its medium
     * and sinks under gravity until water returns.
     */
    private updateLocomotion3D(deltaTime: number): void {
        const movement = this.movementSystem instanceof Animal3DMovement ? this.movementSystem : null;
        if (!movement) return;

        const pos = this.character.position;
        const midY = pos.y + this.animalDimensions.height / 2;

        // Medium check at body center: fish must be in water; birds always fly
        const inMedium = this.locomotionMode === 'swim'
            ? (this.mediumSensor?.isWaterAt(pos.x, midY, pos.z) ?? false)
            : true;
        movement.setInMedium(inMedium);

        // Remember the last spot we were properly submerged, so a fish that
        // washes onto land can flop back to it instead of soft-locking.
        if (inMedium) this._lastInMediumPos.copy(pos);

        const moveDir = new THREE.Vector3();

        // Recovery: a beached swimmer steers back toward the last submerged
        // point. The 3D motor allows slow grounded flopping while out of
        // medium, giving the fish traction to work its way back to water.
        if (this.locomotionMode === 'swim' && !inMedium) {
            moveDir.subVectors(this._lastInMediumPos, pos);
            moveDir.y = 0; // gravity owns vertical out of water; flop horizontally
            if (moveDir.lengthSq() > 1e-6) moveDir.normalize(); else moveDir.set(0, 0, 0);
            this.applyLocomotion3DStep(deltaTime, movement, moveDir);
            return;
        }

        // Behavior proposes targets (same contract as ground animals). Targets
        // are sanitized into the medium so follow/patrol behaviors — which hand
        // out ground-level positions — don't send a bird diving to the player's
        // feet or a fish chasing a point on dry land.
        if (this.behavior) {
            const newTarget = this.behavior.update(deltaTime, pos, this._target3D);
            if (newTarget) {
                if (!this._target3D || !newTarget.equals(this._target3D)) {
                    this._target3D = this.sanitizeMediumTarget(newTarget);
                }
            } else {
                this._target3D = null;
            }
        }

        // Direct 3D seek with per-frame containment clamps
        if (this._target3D && inMedium) {
            moveDir.subVectors(this._target3D, pos);
            const arriveRadius = Math.max(0.6, this.animalDimensions.depth * 0.5);
            if (moveDir.length() < arriveRadius) {
                this._target3D = null;
                this.behavior?.onTargetReached?.();
                moveDir.set(0, 0, 0);
            } else {
                moveDir.normalize();
                if (this.locomotionMode === 'swim') {
                    // Don't chase a target up through the surface: if the voxel
                    // just above the fish's own head is air, kill upward motion.
                    const headTopY = pos.y + this.animalDimensions.height;
                    if (moveDir.y > 0 && this.mediumSensor
                        && !this.mediumSensor.isWaterAt(pos.x, headTopY, pos.z)) {
                        moveDir.y = 0;
                        if (moveDir.lengthSq() < 1e-6) {
                            this._target3D = null; // target is out of the water — drop it
                        } else {
                            moveDir.normalize();
                        }
                    }
                } else {
                    // Flying: climb away when scraping the terrain
                    const terrainY = this.mediumSensor?.getTerrainHeightAt(pos.x, pos.z) ?? null;
                    if (terrainY !== null
                        && pos.y < terrainY + AnimalController.MIN_FLIGHT_CLEARANCE
                        && moveDir.y < 0.2) {
                        moveDir.y = 0.6;
                        moveDir.normalize();
                    }
                }
            }
        }

        this.applyLocomotion3DStep(deltaTime, movement, moveDir);
    }

    /**
     * Common tail for a free-volume locomotion frame: drive the 3D motor with
     * the seek direction, then read back speed and refresh animation, eyes and
     * physics sync. Shared by the normal seek path and the beached-swimmer
     * recovery path.
     */
    private applyLocomotion3DStep(deltaTime: number, movement: Animal3DMovement, moveDir: THREE.Vector3): void {
        this.runMovementSystem(deltaTime, moveDir);
        this.currentSpeed = movement.getCurrentSpeed();
        this.updateAnimation(deltaTime, this.currentSpeed > 0.1);
        this.updateEyes(deltaTime);
        this.syncCharacterWithPhysics();
    }

    /**
     * Adjust a behavior-provided target into this creature's medium.
     *
     * Follow/patrol behaviors hand out ground-level positions (e.g. the
     * player's feet). Without this a flying bird would seek straight down to
     * the player's feet and a fish would chase a point on dry land:
     * - fly: never seek below a safe cruise clearance above the terrain.
     * - swim: an out-of-water target is re-projected to the water column at its
     *   XZ, or dropped (null → idle) when there is no water there.
     */
    private sanitizeMediumTarget(target: THREE.Vector3): THREE.Vector3 | null {
        if (!this.mediumSensor) return target.clone();

        if (this.locomotionMode === 'fly') {
            const out = target.clone();
            const terrainY = this.mediumSensor.getTerrainHeightAt(target.x, target.z);
            if (terrainY !== null) {
                out.y = Math.max(out.y, terrainY + AnimalController.MIN_FLIGHT_CLEARANCE);
            }
            return out;
        }

        // swim
        if (this.mediumSensor.isWaterAt(target.x, target.y, target.z)) {
            return target.clone();
        }
        const submergedY = this.mediumSensor.findSubmergedY(target.x, target.z);
        return submergedY === null ? null : new THREE.Vector3(target.x, submergedY, target.z);
    }

    /**
     * Run a single frame where the animal holds still (not playing):
     * idle animation, zero-input movement, eye update, and physics sync.
     * Animation + physics sync run only on granted anim ticks (FULL ring-0
     * characters tick every frame, so hero/near behavior is unchanged); the
     * motor keeps its per-frame dt for gravity/ground checking. Ends by
     * dropping the dt accumulators — this is a legacy dt-dropping early-return
     * path (see NpcLodComponent.dropAccumulators).
     */
    private updateStationaryFrame(deltaTime: number): void {
        const animDt = this.lodComp.consumeAnimTick();
        if (animDt !== null) {
            this.updateAnimation(animDt, false);
        }
        if (this.characterBody && this.characterBody.isEnabled()) {
            this.runMovementSystem(deltaTime, new THREE.Vector3(0, 0, 0));
        }
        this.updateEyes(deltaTime);
        if (animDt !== null) {
            this.syncCharacterWithPhysics();
        }
        this.lodComp.dropAccumulators();
    }

    /**
     * Run a single frame after the animal was moved this tick via a direct body
     * displacement (obstacle escape / dynamic-obstacle or player avoidance):
     * animate as moving, update eyes, and sync visuals with physics. Anim +
     * sync are anim-tick gated; accumulators drop for legacy dt parity.
     */
    private updateActiveFrame(deltaTime: number): void {
        const animDt = this.lodComp.consumeAnimTick();
        if (animDt !== null) {
            this.updateAnimation(animDt, true);
        }
        this.updateEyes(deltaTime);
        if (animDt !== null) {
            this.syncCharacterWithPhysics();
        }
        this.lodComp.dropAccumulators();
    }

    private updateEyes(deltaTime: number): void {
        if (!this.eyeController) return;
        // Eye micro-animation is a near-camera detail: ring 0 only (cosmetic
        // LOD applies to heroes too, like shadows/nameplates on NPCs).
        if (this.lodComp.state.ring !== 0) return;

        // Get player position if available
        let playerPos: THREE.Vector3 | null = null;
        const playerController = this.engine.getPlayerController?.();
        if (playerController?.getPosition) {
            playerPos = playerController.getPosition();
        }
        
        this.eyeController.update(deltaTime, this.character.position, playerPos);
    }
    
    /**
     * Update animal when being controlled by a rider.
     * Uses camera direction for movement - animal smoothly turns to face movement direction.
     * No strafing for 4-legged animals.
     */
    private updateRiderControl(deltaTime: number): void {
        if (!this._riderInput) return;
        
        const input = this._riderInput;
        const moveDir = new THREE.Vector3();
        
        // Get the animal's current forward direction
        const forward = new THREE.Vector3();
        this.character.getWorldDirection(forward);
        forward.y = 0;
        forward.normalize();
        
        // Check if we have movement intent (forward or backward pressed)
        const hasForwardIntent = input.forward || input.backward;
        
        // If target rotation is provided and we're moving, smoothly turn toward it
        if (input.targetRotation !== undefined && hasForwardIntent) {
            const turnSpeed = 5.0; // Radians per second - fast turning for responsive feel
            const currentRotation = this.character.rotation.y;
            
            // Calculate angle difference, handling wrap-around
            let angleDiff = input.targetRotation - currentRotation;
            while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
            while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
            
            // Smooth rotation toward target
            const maxTurn = turnSpeed * deltaTime;
            if (Math.abs(angleDiff) < maxTurn) {
                this.character.rotation.y = input.targetRotation;
            } else {
                this.character.rotation.y += Math.sign(angleDiff) * maxTurn;
            }
            
            // Normalize rotation to [-PI, PI]
            while (this.character.rotation.y > Math.PI) this.character.rotation.y -= Math.PI * 2;
            while (this.character.rotation.y < -Math.PI) this.character.rotation.y += Math.PI * 2;
            
            // Update forward direction after rotation
            this.character.getWorldDirection(forward);
            forward.y = 0;
            forward.normalize();
        }
        
        // Movement is always in the animal's facing direction
        if (input.forward) {
            moveDir.add(forward);
        }
        if (input.backward) {
            moveDir.sub(forward);
        }
        
        // Apply speed (sprint or normal)
        if (moveDir.lengthSq() > 0) {
            moveDir.normalize();
            const speed = input.sprint ? this._rideSpeed : this.moveSpeed;
            this.currentSpeed = speed;
            moveDir.multiplyScalar(speed / this.moveSpeed);
        } else {
            this.currentSpeed = 0;
        }
        
        // Run movement system and animation
        this.runMovementSystem(deltaTime, moveDir);
        const isMoving = moveDir.lengthSq() > 0.01;
        this.updateAnimation(deltaTime, isMoving);
        this.updateEyes(deltaTime);
        this.syncCharacterWithPhysics();
    }

    private runMovementSystem(deltaTime: number, moveDirection: THREE.Vector3, shouldHop: boolean = false): void {
        if (!this.characterBody) return;

        const keys = {
            forward: moveDirection.length() > 0,
            backward: false,
            left: false,
            right: false,
            ascend: shouldHop, // Hop when stuck against a step
            interact: false,
            action: false,
            descend: false
        };

        this.movementSystem.update(
            deltaTime,
            this as any,
            keys,
            true,
            moveDirection,
            this.characterBody,
            this.physicsWorld
        );

        // Update isGrounded based on movement system's ground check
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

    /**
     * Override the default player-overlap reaction. Default `true` (back away).
     */
    setRetreatFromPlayerOverlap(retreat: boolean): void {
        this.avoidanceComp.setRetreatFromPlayerOverlap(retreat);
    }

    private updateAnimation(deltaTime: number, isMoving: boolean): void {
        // Use actual current speed for animation, not max speed
        const speed = isMoving ? this.currentSpeed : 0;
        // First set the animation state based on movement
        this.animationController.updateAnimation(isMoving, speed, true, false);
        // Then update the animation
        this.animationController.update(deltaTime);
    }

    /**
     * Set the animal's behavior
     */
    setBehavior(behavior: INpcBehavior): void {
        if (this.behavior) {
            this.behavior.dispose();
        }
        this.behavior = behavior;
        this.behavior.initialize(this);
    }

    /**
     * Get the current behavior.
     */
    getBehavior(): INpcBehavior | null {
        return this.behavior;
    }

    /**
     * Detach the current behavior without disposing it.
     * Used by CarryableComponent.fromAnimal() to extract the behavior
     * for wrapping before installing the carry wrapper.
     */
    detachBehavior(): INpcBehavior | null {
        const behavior = this.behavior;
        this.behavior = null;
        return behavior;
    }

    /**
     * Request a behavior change
     */
    requestBehaviorChange(newBehavior: INpcBehavior): void {
        if (!newBehavior) {
            console.error('⚠️ [AnimalController] Cannot switch to null/undefined behavior');
            return;
        }
        this.setBehavior(newBehavior);
    }

    /** Animals are procedural block meshes, never voxelized skinned GLBs. */
    shatterIntoVoxels(): boolean {
        return false;
    }

    /**
     * Get the animal's current planned path as a list of world-space
     * waypoints. Empty when not moving. Surfaced for the debug navmesh
     * overlay.
     */
    getCurrentPath(): THREE.Vector3[] {
        return this.getPath();
    }

    setTargetPosition(target: THREE.Vector3 | null, maxPathLength?: number): void {
        // 3D creatures seek directly — no navmesh path to plan
        if (this.locomotionMode !== 'ground') {
            this._target3D = target ? target.clone() : null;
            return;
        }
        this.navigationComp.setTargetPosition(target, undefined, maxPathLength);
    }

    /** How this creature traverses the world ('ground' | 'swim' | 'fly'). */
    getLocomotionMode(): 'ground' | 'swim' | 'fly' {
        return this.locomotionMode;
    }

    /** Medium sensor for water/terrain queries (3D creatures only). */
    getMediumSensor(): AnimalMediumSensor | null {
        return this.mediumSensor;
    }

    // Getters (ICharacterContext + controller-specific)
    getEngine(): EngineLike { return this.engine; }
    getNavMesh(): LegacyNavMesh | null { return this.navMesh; }
    getPosition(): THREE.Vector3 { return this.character.position; }
    getCharacter(): THREE.Object3D { return this.character; }
    getPhysicsWorld(): PhysicsWorld { return this.physicsWorld; }
    getAnimalType(): string { return this.animalType; }
    /** Always false — stun-on-hit was removed; kept for ICharacterContext and shipped game code. */
    isStunned(): boolean { return false; }
    getPhysicsBody(): RAPIER.RigidBody | null {
        return this.characterBody;
    }

    // ════════════════════════════════════════════════════════════════════════
    // Step-Hop Configuration
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Set the maximum height the animal can hop up when stuck against a step.
     * Default is 1.0 meters (1 voxel block).
     * Set to 0 to disable step-hopping entirely.
     */
    setMaxStepUpHeight(height: number): void {
        this.navigationComp.setMaxStepUpHeight(height);
    }

    getMaxStepUpHeight(): number {
        return this.navigationComp.getMaxStepUpHeight();
    }

    setStepHopEnabled(enabled: boolean): void {
        this.navigationComp.setStepHopEnabled(enabled);
    }

    isStepHopEnabled(): boolean {
        return this.navigationComp.isStepHopEnabled();
    }

    /**
     * Set how close this animal must get to its FINAL navigation destination
     * before it stops, in meters. Default 0.5 m. Intermediate path waypoints are
     * unaffected, so cornering stays smooth.
     */
    setArrivalRadius(radius: number): void {
        this.navigationComp.setArrivalRadius(radius);
    }

    /** Get the current final-destination arrival tolerance in meters. */
    getArrivalRadius(): number {
        return this.navigationComp.getArrivalRadius();
    }

    /**
     * Toggle agent-to-agent avoidance for this animal. When disabled it keeps
     * navigating normally — paths, arrival, facing and locomotion all still
     * work — but it no longer steers around other agents, and other agents stop
     * treating it as an obstacle. Enabled by default.
     */
    setAvoidanceEnabled(enabled: boolean): void {
        this.navigationComp.setAvoidanceEnabled(enabled);
        // No body before spawn — the navigation flag above still holds, and the
        // body picks up its userData when it is created.
        if (!this.characterBody) return;
        // Flip the userData flag in place so OTHER agents' neighbor scans skip
        // (or re-include) this body — getUserData returns the live reference the
        // avoidance system reads, so mutating it is enough.
        const ud = this.physicsWorld.getUserData(this.characterBody) as { avoidanceDisabled?: boolean } | undefined;
        if (ud) ud.avoidanceDisabled = !enabled;
    }

    /** Whether agent-to-agent avoidance is currently active for this animal. */
    isAvoidanceEnabled(): boolean {
        return this.navigationComp.isAvoidanceEnabled();
    }

    /**
     * Make this animal head in a STRAIGHT LINE to its target, skipping the
     * navmesh A* pathfinder. Obstacle routing becomes the caller's
     * responsibility. Disabled by default; takes effect on the next
     * setTargetPosition call.
     */
    setStraightLinePath(enabled: boolean): void {
        this.navigationComp.setStraightLinePath(enabled);
    }

    /** Whether this animal is in straight-line (no-pathfinding) movement mode. */
    isStraightLinePath(): boolean {
        return this.navigationComp.isStraightLinePath();
    }

    setRotationSpeed(radiansPerSecond: number): void {
        this.navigationComp.setRotationSpeed(radiansPerSecond);
    }

    getRotationSpeed(): number {
        return this.navigationComp.getRotationSpeed();
    }

    setMoveSpeed(speed: number): void {
        this.moveSpeed = Math.max(0.1, speed);
        this.navigationComp.setMoveSpeed(this.moveSpeed);
        this.movementSystem.setMoveSpeed(this.moveSpeed);
        this._rideSpeed = this.moveSpeed * 1.5;
    }

    getMoveSpeed(): number {
        return this.moveSpeed;
    }

    /**
     * Set how long explosion debris persists, in milliseconds.
     * 0 = permanent (until level unload). Default is 10000 (10 seconds).
     */
    setDebrisLifetime(ms: number): void {
        this.explosionComp.setDebrisLifetimeMs(ms);
    }

    /**
     * Snapshot of debris pieces currently in-flight after this animal's death
     * explosion. Returns mesh + rapier body for each piece; caller can read
     * positions, push them around with velocities/impulses, or move the mesh
     * directly. Empty array before death or after all debris has been removed.
     */
    getExplodedDebris(): { mesh: THREE.Mesh; body: RAPIER.RigidBody }[] {
        return this.explosionComp.getDebrisPieces();
    }

    /**
     * Remove one debris piece (cleans up the mesh + physics body). Pair with
     * `setDebrisLifetime(0)` to take over lifetime management — fly the pieces
     * up to the sky over N seconds and call this for each as it reaches the
     * top. Returns true if the piece was found.
     */
    removeDebrisPiece(mesh: THREE.Mesh): boolean {
        return this.explosionComp.removeDebrisPiece(mesh);
    }

    getPath(): THREE.Vector3[] {
        return this.navigationComp.getPath();
    }

    getCurrentWaypointIndex(): number {
        return this.navigationComp.getCurrentWaypointIndex();
    }

    getCurrentWaypoint(): THREE.Vector3 | null {
        return this.navigationComp.getCurrentWaypoint();
    }

    /**
     * True while the animal is still walking a planned route. Prefer this over
     * `getPath().length === 0` — arrival advances the waypoint index past the
     * final waypoint rather than clearing the array, so the length only drops to
     * zero when the stuck-detector eventually wipes the path (~2 s of standing
     * still), which reads as a long unexplained pause.
     */
    isFollowingPath(): boolean {
        return this.navigationComp.hasPath();
    }

    /**
     * True once the animal has finished its path and is at (or within the
     * arrival radius of) its destination. Convenience inverse of
     * `isFollowingPath()`. Returns true when there is no active path at all.
     */
    hasReachedDestination(): boolean {
        return !this.navigationComp.hasPath();
    }

    /**
     * Get the animation controller for network sync.
     * Used by MultiplayerSetup.registerAnimal() to read animation state.
     */
    getAnimationController(): GlbAnimalBody | BlockAnimalAnimationController {
        return this.animationController;
    }

    getVelocity(): THREE.Vector3 {
        if (this.characterBody) {
            const velocity = this.characterBody.linvel();
            return new THREE.Vector3(velocity.x, velocity.y, velocity.z);
        }
        return new THREE.Vector3(0, 0, 0);
    }

    getRotation(): THREE.Quaternion {
        const quaternion = new THREE.Quaternion();
        this.character.getWorldQuaternion(quaternion);
        return quaternion;
    }

    // For movement system compatibility
    get player(): THREE.Object3D { return this.character; }
    get characterHeight(): number { return this.characterLoader.getCapsuleHeight(); }
    get capsuleRadius(): number { return this.characterLoader.getCapsuleRadius(); }
    
    // Voxel block size for step climbing (set from level data, default 1m)
    voxelBlockSize: number = 1.0;
    
    // ChunkManagedObject interface - for chunk-based hibernation
    holdPhysicsUntilReady(): void {
        this.hibernationComp.holdPhysicsUntilReady();
    }

    releasePhysics(): void {
        this.hibernationComp.releasePhysics();
    }

    setAlwaysActive(active: boolean): void {
        this.hibernationComp.setAlwaysActive(active);
    }

    /**
     * ChunkPhysicsManager anchor test. Game-code setAlwaysActive(false) is
     * always respected (unchanged legacy behavior). Heroes keep the legacy
     * always-active default; crowd animals only anchor their terrain chunk
     * while embodied (FULL/COARSE). Free-volume animals clamp at COARSE, so
     * they always stay embodied.
     */
    isAlwaysActive(): boolean {
        if (!this.hibernationComp.isAlwaysActive()) return false;
        // Dead/exploded crowd animals never anchor — a carcass must not pin
        // its terrain chunk active forever on procedural maps.
        if (this.importance === 'crowd' && this.isDeadOrRagdolled()) return false;
        if (this.importance === 'hero') return true;
        const sc = this.hibernationComp.getSimClass();
        return sc === SimClass.FULL || sc === SimClass.COARSE;
    }

    /**
     * ChunkPhysicsManager hint: only idle (goal-less) crowd animals may
     * chunk-hibernate. Never a carcass: hibernation hides the character group
     * but death debris (exploded blocks) lives outside it and would stay
     * visible frozen.
     */
    canHibernate(): boolean {
        if (this.isDeadOrRagdolled()) return false;
        return this.importance === 'crowd' && !this.hasActiveGoal();
    }

    // ════════════════════════════════════════════════════════════════════════
    // Character LOD (LodManagedCharacter contract — getPosition and lodState
    // are defined elsewhere in this class)
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Simulation importance tier. 'hero' (default): full fidelity at any
     * distance. 'crowd': the engine scales AI/animation/physics with distance
     * and visibility — herds, flocks, schools, ambient wildlife.
     */
    setImportance(importance: 'hero' | 'crowd'): void {
        this.importance = importance;
    }

    getImportance(): 'hero' | 'crowd' {
        return this.importance;
    }

    /**
     * True when this animal is going somewhere or is hostile — keeps it
     * VIRTUAL (progressing) instead of HIBERNATED in the far ring. Free-volume
     * creatures (fish/birds) always report an active goal: their wander is
     * continuous and they must never scheduler-hibernate mid-water/mid-air.
     */
    hasActiveGoal(): boolean {
        if (this.locomotionMode !== 'ground') return true;
        return this.navigationComp.hasPath()
            || this.navigationComp.getCurrentTarget() !== null
            || (this.behavior?.isHostile() ?? false);
    }

    /** Dead/exploded animals are exempt from LOD demotion (stamped FULL). */
    isDeadOrRagdolled(): boolean {
        return this.healthComp.isExploded() || this.healthComp.isDead();
    }

    hibernate(): void {
        this.hibernationComp.hibernate();
    }

    wake(): void {
        this.hibernationComp.wake();
    }

    isHibernating(): boolean {
        return this.hibernationComp.isHibernating();
    }

    // Interactable interface
    onInteractStart(): boolean {
        // Rideable animals: mounting takes priority
        if (this._rideable && !this._isBeingRidden) {
            return true; // Signal that interaction should proceed (mounting handled by PlayerController)
        }
        
        return this.behavior?.onPlayerInteract?.() ?? false;
    }

    getInteractStartDisplayName(): string {
        // Rideable animals show "Ride" prompt
        if (this._rideable && !this._isBeingRidden) {
            return t('game.interaction.ride', { animal: this.animalType });
        }
        
        // Not part of INpcBehavior — a behavior may opt in to its own prompt label.
        const behavior = this.behavior as (INpcBehavior & { getInteractDisplayName?: () => string }) | null;
        if (behavior && typeof behavior.getInteractDisplayName === 'function') {
            return behavior.getInteractDisplayName();
        }
        return t('game.interaction.pet', { animal: this.animalType.toLowerCase() });
    }

    interactionEnabled(): boolean {
        // Rideable animals are always interactable (when not already being ridden)
        if (this._rideable && !this._isBeingRidden) {
            return true;
        }
        return this.behavior !== null && typeof this.behavior.onPlayerInteract === 'function';
    }

    // ════════════════════════════════════════════════════════════════════════════════
    // Carry System (used by CarryableComponent)
    // ════════════════════════════════════════════════════════════════════════════════

    /**
     * Set whether this animal is currently being carried.
     * When true, the animal's AI, physics sync, and movement are all paused
     * so CarryableComponent can control the position directly.
     */
    setBeingCarried(carried: boolean): void {
        this._isBeingCarried = carried;
    }

    isBeingCarried(): boolean {
        return this._isBeingCarried;
    }

    // ════════════════════════════════════════════════════════════════════════════════
    // Riding System
    // ════════════════════════════════════════════════════════════════════════════════
    
    /**
     * Set whether this animal can be ridden by the player.
     * 
     * @param rideable - true to allow riding, false to disable
     */
    setRideable(rideable: boolean): void {
        this._rideable = rideable;
    }
    
    /**
     * Check if this animal can be ridden.
     */
    isRideable(): boolean {
        return this._rideable;
    }
    
    /**
     * Check if this animal is currently being ridden.
     */
    isBeingRidden(): boolean {
        return this._isBeingRidden;
    }
    
    /**
     * Get the height above ground where the rider should be positioned.
     */
    getMountHeight(): number {
        return this._mountHeight;
    }
    
    /**
     * Set rider input for controlling the animal while mounted.
     * Called by PlayerRidingAnimalMovement each frame.
     * Pass null when rider dismounts.
     */
    setRiderInput(input: RiderInput | null): void {
        this._riderInput = input;
    }
    
    /**
     * Get current movement speed (takes into account whether being ridden).
     */
    getCurrentSpeed(): number {
        return this.currentSpeed;
    }
    
    /**
     * Mount a rider onto this animal.
     * @param rider - The player object to mount
     * @returns true if mounting succeeded
     */
    mountRider(rider: THREE.Object3D): boolean {
        if (!this._rideable || this._isBeingRidden || this.healthComp.isDead()) {
            return false;
        }
        
        this._rider = rider;
        this._isBeingRidden = true;
        
        // Clear any existing behavior/path while being ridden
        this.navigationComp.clearPath();
        
        console.log(`🏇 Player mounted ${this.animalType}`);
        return true;
    }
    
    /**
     * Dismount the current rider from this animal.
     * @returns The dismounted rider, or null if none
     */
    dismountRider(): THREE.Object3D | null {
        if (!this._isBeingRidden) {
            return null;
        }
        
        const rider = this._rider;
        this._rider = null;
        this._isBeingRidden = false;
        this._riderInput = null;
        
        console.log(`🚶 Player dismounted ${this.animalType}`);
        return rider;
    }
    
    /**
     * Check if a rider can mount this animal.
     */
    canMount(): boolean {
        return this._rideable && !this._isBeingRidden && !this.healthComp.isDead() && !this.healthComp.isExploded();
    }
    
    /**
     * Get a safe dismount position next to the animal.
     */
    getDismountPosition(): THREE.Vector3 {
        const pos = this.character.position.clone();
        // Dismount to the left side of the animal
        const direction = new THREE.Vector3();
        this.character.getWorldDirection(direction);
        const rightVector = new THREE.Vector3(-direction.z, 0, direction.x).normalize();
        pos.add(rightVector.multiplyScalar(this.animalDimensions.width + 0.5));
        return pos;
    }
    
    /**
     * Force dismount the rider (e.g., when animal dies).
     * Triggers the onRiderForceDismount callback if set.
     */
    forceDismountRider(): void {
        if (!this._isBeingRidden || !this._rider) return;
        
        const rider = this._rider;
        
        // Clear riding state
        this._rider = null;
        this._isBeingRidden = false;
        this._riderInput = null;
        
        console.log(`⚠️ Force dismounting rider from ${this.animalType}`);
        
        // Notify the controller to handle cleanup
        if (this.onRiderForceDismount) {
            this.onRiderForceDismount(this, rider);
        }
    }

    // ════════════════════════════════════════════════════════════════════════════════
    // IDamageable Implementation
    // ════════════════════════════════════════════════════════════════════════════════

    /**
     * Store physics body reference in all block character meshes for melee detection.
     * This enables weapons to detect and damage this animal.
     */
    private storePhysicsBodyInMeshes(): void {
        const mass = 50; // Smaller mass than humanoid NPCs
        
        // Traverse all meshes in the character and store references
        this.character.traverse((child: THREE.Object3D) => {
            if ((child as THREE.Mesh).isMesh) {
                const mesh = child as THREE.Mesh;
                mesh.userData.physicsBody = this.characterBody;
                mesh.userData.mass = mass;
                mesh.userData.damageableController = this; // Generic interface
                mesh.userData.animalController = this;     // Specific reference
                // Keep backward compatibility with enemyController pattern
                mesh.userData.enemyController = this;
                // Store collision info for Object Inspector
                mesh.userData.collisionGroup = CollisionGroup.ANIMAL;
                mesh.userData.collisionMask = CollisionMask.ANIMAL;
            }
        });
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

        // Let behavior handle hit first
        if (this.behavior?.onHit?.(impactDirection)) return;

        // Apply damage - one-hit kill or normal damage calculation
        const config = this.healthComp.getDamageableConfig();
        const damage = config.oneHitKill ? this.healthComp.getMaxHealth() + 1 : impulseStrength * 2;
        const meleeImpulse = impactDirection ? ragdollKnockback(impactDirection, impulseStrength) : undefined;
        this.takeDamage(damage, 'melee', meleeImpulse);

        // Apply physical impact (non-lethal hits only — a lethal hit nulls characterBody via ragdoll/explode)
        if (impactDirection && this.characterBody) {
            this.characterBody.applyImpulse({
                x: impactDirection.x * impulseStrength,
                y: 2,
                z: impactDirection.z * impulseStrength
            }, true);
        }

        // Trigger melee hit effect callback
        if (this.onMeleeHitEffect && impactDirection) {
            const hitPos = this.character.position.clone();
            hitPos.y += 0.5;
            this.onMeleeHitEffect(hitPos, impactDirection, damage);
        }

    }

    public onProjectileCollision(projectile: { getDamage?: () => number; getDirection?: () => THREE.Vector3; getKnockback?: () => number }): void {
        if (this.healthComp.isExploded() || this.healthComp.isDead()) return;

        const damage = projectile.getDamage?.() ?? 25;
        const travelDir = projectile.getDirection?.()?.clone() ?? new THREE.Vector3(0, 0, 1);
        const hitDirection = travelDir.clone().negate();

        // Knock the corpse back along the bullet's travel direction on a lethal ragdoll death.
        const deathImpulse = ragdollKnockback(travelDir, projectile.getKnockback?.() ?? 6);
        this.takeDamage(damage, 'projectile', deathImpulse);

        if (this.onProjectileHitEffect) {
            const hitPos = this.character.position.clone();
            hitPos.y += 0.5;
            this.onProjectileHitEffect(hitPos, hitDirection, damage);
        }
    }

    isExploded(): boolean {
        return this.healthComp.isExploded();
    }

    isDead(): boolean {
        return this.healthComp.isDead();
    }

    /**
     * True when death actually collapsed the animal into a ragdoll. A death
     * with `ragdollOnDeath` off — or one where the collapse could not be built —
     * leaves `isDead()` true and this false.
     */
    isRagdolled(): boolean {
        return this.healthComp.isRagdolled();
    }

    /**
     * True while the articulated ragdoll body still exists. Goes false once the
     * corpse is torn down — see `setCorpseLifetimeMs` — or on dispose.
     */
    hasRagdoll(): boolean {
        return this.ragdollComp.hasRagdoll();
    }

    getHealth(): number {
        return this.healthComp.getHealth();
    }

    getMaxHealth(): number {
        return this.healthComp.getMaxHealth();
    }

    setDamageFlashEnabled(enabled: boolean): void {
        this.healthComp.setDamageFlashEnabled(enabled);
    }

    getDamageFlash(): import('engine/effects/DamageFlash.js').DamageFlash | null {
        return this.healthComp.getDamageFlash();
    }

    /**
     * Fluent configuration API - set multiple options at once
     * 
     * This method allows chaining configuration after createAnimal():
     * 
     * @param options Configuration options
     * @returns this (for chaining)
     */
    configure(options: AnimalConfigOptions): this {
        // One-hit kill setting
        if (options.oneHitKill !== undefined) {
            this.healthComp.getDamageableConfig().oneHitKill = options.oneHitKill;
        }

        // Blood splatter on hit
        if (options.bloodOnHit && this.engine.scene) {
            // Dynamically import to avoid circular dependency
            import('engine/effects/HitEffects.js').then(({ createBloodSplatterEffect }) => {
                this.onMeleeHitEffect = createBloodSplatterEffect(this.engine.scene!, options.bloodConfig);
            });
        }

        // Death explosion with gore
        if (options.explodeWithGore && this.engine.scene) {
            // Capture existing onDeathEffect BEFORE the async import
            const existingEffect = this.onDeathEffect;
            
            import('engine/effects/HitEffects.js').then(({ createDeathExplosionEffect }) => {
                const explosionEffect = createDeathExplosionEffect(this.engine.scene!, options.goreConfig);
                
                // Compose with existing effect AND new onDeath callback
                const userOnDeath = options.onDeath;
                this.onDeathEffect = (killerDirection?: THREE.Vector3) => {
                    // Get position before explosion destroys character
                    const position = this.character.position.clone();
                    explosionEffect(position, killerDirection);
                    // Call existing death effect (e.g., kill tracking, quest progress)
                    existingEffect?.(killerDirection);
                    userOnDeath?.(killerDirection);
                };
            });
        } else if (options.onDeath) {
            // Just add the onDeath callback without explosion effects
            const existingEffect = this.onDeathEffect;
            this.onDeathEffect = (killerDirection?: THREE.Vector3) => {
                existingEffect?.(killerDirection);
                options.onDeath!(killerDirection);
            };
        }

        return this;
    }

    takeDamage(amount: number, source?: string, deathImpulse?: THREE.Vector3): void {
        this.healthComp.takeDamage(amount, source, deathImpulse);
    }

    /**
     * Retune this animal's max health at runtime (difficulty scaling, buffs).
     * Also restores current health to the new max and revives a dead animal —
     * see HealthComponent.setMaxHealth.
     */
    setMaxHealth(maxHealth: number): void {
        this.healthComp.setMaxHealth(maxHealth);
    }

    /**
     * Heal by `amount`, capped at max health. Returns whether health actually
     * moved — false if the animal is already full or dead. `onDamage` does NOT
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
     * No-op. Stun-on-hit was removed from the engine — hits never freeze
     * animals — but shipped game code still calls this, so the method stays.
     */
    setStunDuration(seconds: number): void {
        void seconds;
    }

    /**
     * How long the corpse lingers after a ragdoll death, in milliseconds.
     * `<= 0` keeps it until `dispose()`. Takes effect immediately, so it also
     * extends or cuts short a body already on the ground.
     *
     * Note: at spawn this value comes from `damageable.debrisLifetimeMs`, which
     * also governs explosion-debris lifetime — this setter is the only way to
     * control the corpse independently of the debris.
     */
    setCorpseLifetimeMs(ms: number): void {
        this.ragdollComp.setCorpseLifetimeMs(ms);
    }

    /**
     * Dispose and clean up
     */
    dispose(): void {
        // Drop out of the character LOD scheduler (covers every teardown path:
        // registry disposeAll, direct dispose, engine dispose).
        getGlobalLodScheduler().unregisterCharacter(this);

        // Dispose interactable trigger sensor
        if (this.interactableComponent) {
            this.interactableComponent.dispose();
            this.interactableComponent = null;
        }

        // Dispose damage flash effect
        this.healthComp.disposeDamageFlash();

        if (this.behavior) {
            this.behavior.dispose();
            this.behavior = null;
        }

        if (this.eyeController) {
            this.eyeController.dispose();
            this.eyeController = null;
        }

        // Release path-conflict avoidance registration so a dead animal
        // stops counting as a planning obstacle for live agents.
        this.navigationComp.dispose();

        // Clean up exploded blocks
        this.explosionComp.dispose(this.physicsWorld);
        this.ragdollComp.dispose(this.physicsWorld);

        if (this.character.parent) this.character.parent.remove(this.character);

        this.characterLoader.dispose();

        // Clean up physics body
        if (this.characterBody) {
            this.physicsWorld.removeRigidBody(this.characterBody);
            this.characterBody = null;
        }

        this.character.traverse((obj: THREE.Object3D) => {
            const mesh = obj as THREE.Mesh;
            if (mesh.isMesh) {
                // Voxel GLB bodies share geometry across every clone of the same
                // species (SkeletonUtils.clone) — never dispose it from one death.
                if (mesh.userData.sharedGlbGeometry) {
                    // shared, owned by the GLTF cache — leave geometry alone
                } else if (mesh.userData.sharedDetailGeometry && typeof mesh.userData.releaseSharedGeometry === 'function') {
                    // Voxel-detail meshes share refcounted cached geometry —
                    // release the reference instead of disposing it out from
                    // under other animals built from the same config.
                    mesh.userData.releaseSharedGeometry();
                } else if (mesh.geometry) {
                    mesh.geometry.dispose();
                }
                // Materials are per-instance (Lambert clones), safe to dispose.
                if (mesh.material) {
                    if (Array.isArray(mesh.material)) {
                        mesh.material.forEach(m => m.dispose());
                    } else {
                        mesh.material.dispose();
                    }
                }
            }
        });

        // Stop the animation mixer and release its binding to the cloned skeleton.
        this.animationController.dispose();
    }
}

/**
 * Convert every MeshStandardMaterial in an animal body to MeshLambertMaterial so
 * animals respond to local lighting (like terrain does) instead of environment
 * maps. Per-vertex colours and base maps are preserved — the voxel GLB bodies
 * carry their colour as vertex colours. The source material is NOT disposed
 * because SkeletonUtils-cloned voxel bodies share it across instances; it is
 * never rendered (replaced before first draw) so it holds no GPU resources.
 * Shared by the local AnimalController and the remote NetworkAnimalController.
 *
 * This is the `matte` material-class outcome written out by hand: a GLB animal
 * body carries no class signal (no `BM_slot_*` materials), so the class ladder
 * has nothing further to say — matte IS Lambert on every quality tier.
 */
export function convertGroupToLambertLighting(group: THREE.Object3D): void {
    const toLambert = (mat: THREE.Material): THREE.Material => {
        if (mat instanceof THREE.MeshStandardMaterial) {
            return new THREE.MeshLambertMaterial({
                color: mat.color,
                map: mat.map,
                vertexColors: mat.vertexColors,
                emissive: mat.emissive,
                emissiveIntensity: mat.emissiveIntensity,
                transparent: mat.transparent,
                opacity: mat.opacity,
                side: mat.side,
            });
        }
        return mat;
    };
    group.traverse((child: THREE.Object3D) => {
        if (!(child instanceof THREE.Mesh)) return;
        child.material = Array.isArray(child.material)
            ? child.material.map(toLambert)
            : toLambert(child.material);
    });
}

/**
 * Create a 4-legged animal block character factory
 */
export function createAnimalBlockCharacterFactory(): IBlockCharacterFactory {
    let dimensions: { width: number; height: number; depth: number } | null = null;

    /** Every box that makes up the default body, in the order it is added. */
    const PARTS: Array<{
        name: string;
        size: [number, number, number];
        position: [number, number, number];
        color: number;
    }> = [
        { name: 'AnimalBody', size: [1.2, 0.6, 1.8], position: [0, 0.3, 0], color: 0x8B4513 },
        { name: 'AnimalHead', size: [0.6, 0.5, 0.6], position: [0, 0.5, 0.9], color: 0x654321 },
        { name: 'FrontLeftLeg', size: [0.4, 0.5, 0.4], position: [-0.4, -0.2, 0.5], color: 0x8B4513 },
        { name: 'FrontRightLeg', size: [0.4, 0.5, 0.4], position: [0.4, -0.2, 0.5], color: 0x8B4513 },
        { name: 'BackLeftLeg', size: [0.4, 0.6, 0.4], position: [-0.4, -0.3, -0.5], color: 0x8B4513 },
        { name: 'BackRightLeg', size: [0.4, 0.6, 0.4], position: [0.4, -0.3, -0.5], color: 0x8B4513 },
        { name: 'AnimalTail', size: [0.2, 0.2, 0.8], position: [0, 0.2, -1.0], color: 0x8B4513 },
    ];

    const factory: IBlockCharacterFactory & { isAnimalFactory: true } = {
        isAnimalFactory: true,
        createBlockCharacter: (characterGroup: THREE.Group) => {
            for (const part of PARTS) {
                const mesh = new THREE.Mesh(
                    new THREE.BoxGeometry(...part.size),
                    createClassedPartMaterial('fur', { color: part.color }),
                );
                mesh.position.set(...part.position);
                mesh.name = part.name;
                characterGroup.add(mesh);
            }

            // Calculate dimensions
            const box = new THREE.Box3().setFromObject(characterGroup);
            dimensions = {
                width: box.max.x - box.min.x,
                height: box.max.y - box.min.y,
                depth: box.max.z - box.min.z
            };
        },
        getCharacterDimensions: () => {
            if (!dimensions) {
                throw new Error('getCharacterDimensions called before createBlockCharacter');
            }
            return dimensions;
        }
    };

    return factory;
}

/**
 * Create a 4-legged animal with species-specific appearance
 * 
 * ════════════════════════════════════════════════════════════════════════════════
 * 🐕 SUPPORTED ANIMAL TYPES (each has unique proportions and colors):
 * ════════════════════════════════════════════════════════════════════════════════
 * 
 * Dogs: 'dog', 'puppy', 'husky', 'germanshepherd', 'goldenretriever'
 * Wild Canines: 'wolf', 'fox', 'coyote'
 * Cats: 'cat', 'kitten', 'blackcat'
 * Big Cats: 'lion', 'tiger', 'leopard', 'panther', 'cheetah'
 * Horses: 'horse', 'pony', 'zebra', 'donkey', 'unicorn'
 * Bears: 'bear', 'polarbear', 'panda'
 * Small Animals: 'rabbit', 'bunny', 'squirrel'
 * Deer: 'deer', 'fawn'
 * Farm: 'pig', 'cow', 'sheep', 'goat'
 * Large: 'elephant', 'giraffe', 'hippo', 'rhino', 'camel'
 * Misc: 'raccoon', 'skunk', 'otter', 'beaver'
 * Fantasy: 'dragon', 'griffin'
 * 
 * ════════════════════════════════════════════════════════════════════════════════
 * 
 * @see BlockAnimalBodyBuilder.ts for full BlockAnimalBodyConfig interface and examples
 */
/**
 * Options for creating an animal
 */
export interface CreateAnimalOptions {
    /** Movement speed (default: varies by animal type) */
    moveSpeed?: number;
    /** Block character factory for creating the animal's appearance */
    factory?: IBlockCharacterFactory;
    /** Whether this animal can be ridden by the player (default: false) */
    rideable?: boolean;
    /**
     * Simulation importance tier. 'hero' (default): full fidelity at any
     * distance — pets, mounts, quest animals. 'crowd': the engine scales
     * AI/animation/physics with distance and visibility — herds, flocks,
     * schools, ambient wildlife.
     */
    importance?: 'hero' | 'crowd';
}

/** Counter to ensure unique registry keys when spawning multiple animals in the same millisecond */
let createAnimalCounter = 0;

export async function createAnimal(
    scene: THREE.Scene,
    physicsWorld: PhysicsWorld,
    engine: EngineLike,
    spawnPosition: THREE.Vector3,
    animalType: string,
    moveSpeed: number,
    factory: IBlockCharacterFactory,
    options?: { rideable?: boolean; importance?: 'hero' | 'crowd' }
): Promise<AnimalController> {
    const animal = await AnimalController.create(scene, physicsWorld, engine, spawnPosition, animalType, moveSpeed, factory);

    // Apply rideable option if specified
    if (options?.rideable) {
        animal.setRideable(true);
    }

    // Simulation importance tier (default hero — full fidelity at any distance)
    if (options?.importance) {
        animal.setImportance(options.importance);
    }

    // Auto-register with engine's animal registry for automatic updates
    const registry = engine.getAnimalRegistry?.();
    if (registry) {
        registry.register(`${animalType}_${Date.now()}_${createAnimalCounter++}`, animal);
    }
    
    return animal;
}
