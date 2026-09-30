import * as THREE from 'three';
import { ExplosionVisual, type ExplosionStyle, type ExplosionVisualOptions } from 'engine/effects/ExplosionVisual.js';
import { explosionRecipe, type ExplosionPreset } from 'engine/effects/ExplosionPresets.js';
import { keepShaderAlive } from 'engine/effects/ShaderKeepAlive.js';
import type { EngineLike } from 'types/game.js';
import { CollisionGroup, CollisionMask } from 'engine/CollisionLayers.js';
import { spawnHitDebris } from 'engine/HitDebrisSystem.js';
import { getDecalSystem } from 'engine/VoxelDecalSystem.js';
import { getVoxelCarveSystem } from 'engine/voxelcarve/VoxelCarveSystem.js';
import { VoxelObject } from 'engine/VoxelObject.js';
import { sphereColliderDesc } from 'engine/physics/BallPhysics.js';
import type RAPIER from '@dimforge/rapier3d-compat';
import { getPhysicsHandle } from 'engine/PhysicsBodyRegistry.js';
import { getRapier } from 'engine/physics/RapierPhysics.js';
import { isPlaneLockedPhysics } from 'engine/physics/PlaneLockedPhysics.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import { getWaterBuoyancySystem } from 'engine/WaterBuoyancySystem.js';
import { getGameEventLog } from 'engine/recording/GameEventLog.js';

/**
 * Global registry of player body handles for projectile hit detection.
 * In Rapier, we use body handles (numbers) instead of pointers.
 */
const playerBodyHandles: Set<number> = new Set();

/**
 * Register a player's physics body for projectile hit detection.
 * Call this after creating the player body.
 * @param body The player's rigid body
 */
export function registerPlayerBodyForProjectiles(body: RAPIER.RigidBody): void {
    const handle = getPhysicsHandle(body);
    if (handle !== 0) {
        playerBodyHandles.add(handle);
    }
}

/**
 * Unregister a player's physics body (call on dispose).
 * @param body The player's rigid body to unregister
 */
export function unregisterPlayerBodyForProjectiles(body: RAPIER.RigidBody): void {
    const handle = getPhysicsHandle(body);
    playerBodyHandles.delete(handle);
}

/**
 * Check if a rigid body is a registered player body.
 * @param body The rigid body to check
 * @returns true if this is a player body
 */
function isPlayerBody(body: RAPIER.RigidBody): boolean {
    const handle = getPhysicsHandle(body);
    return playerBodyHandles.has(handle);
}

/**
 * The direction the shot will ACTUALLY travel in.
 *
 * On the 2D lane only the in-plane part of a shot flies, so a muzzle sitting
 * slightly off the gameplay plane (a weapon mesh on the character's flank)
 * would otherwise leave the recorded direction tilted out of it — and the mesh
 * orientation, the fallback hit normal and the carve axis all read that
 * direction. Projecting keeps it truthful. A direction with nothing in the
 * plane at all is left alone: it is a broken aim, not a tilt, and the facade
 * names it.
 */
function resolveFlightDirection(physicsWorld: EngineLike['physicsWorld'], direction: THREE.Vector3): THREE.Vector3 {
    const flight = direction.clone().normalize();
    if (!isPlaneLockedPhysics(physicsWorld)) return flight;
    const inPlane = physicsWorld.liftDir(physicsWorld.projectDir(flight));
    const projected = new THREE.Vector3(inPlane.x, inPlane.y, inPlane.z);
    return projected.lengthSq() > 1e-8 ? projected.normalize() : flight;
}

export enum ProjectileType {
    WAVE_REVEAL = 'wave_reveal',
    DESTRUCTION = 'destruction'
}

export interface ExplosionConfig {
    enabled: boolean;
    radius: number;           // Explosion visual radius
    duration: number;         // How long explosion lasts (seconds)
    color?: number;           // Explosion color (default: 0xff5a12 orange)
    damage?: number;          // Damage at center (for future NPC damage)
    damageRadius?: number;    // Radius for damage falloff (for future NPC damage)
    /** Defaults to the game art style, then voxel. */
    visualStyle?: ExplosionStyle;
    /** Optional repeatable particle layout. */
    seed?: number;
    /** Visual recipe only; damage and destruction remain unchanged. */
    preset?: ExplosionPreset;
    amount?: number;
    variance?: number;
    quality?: ExplosionVisualOptions['quality'];
    layers?: ExplosionVisualOptions['layers'];
}

export interface ProjectileVisualConfig {
    geometry?: THREE.BufferGeometry;
    material?: THREE.Material;
    customMesh?: THREE.Object3D;  // Use a custom mesh instead of geometry+material
    castShadow?: boolean;
    bloomLayer?: boolean; // Set to layer 1 for bloom effect
    /** Physics collision radius in meters (default: 0.05m = 5cm) */
    collisionRadius?: number;
    trail?: {
        enabled: boolean;
        length?: number;
        geometry?: THREE.BufferGeometry;
        material?: THREE.Material;
        opacityFalloff?: boolean;
        /** Trail tint when no custom material is given (default: 0xffaa00) */
        color?: number;
    };
    explosion?: ExplosionConfig;
    
    // ════════════════════════════════════════════════════════════════════════════════
    // BALLISTIC PHYSICS - For artillery-style projectiles that arc through the air
    // ════════════════════════════════════════════════════════════════════════════════
    
    /** 
     * Gravity scale for ballistic trajectory. Default: 0 (straight-line bullet).
     * Set to 1.0 for realistic gravity, higher for exaggerated arcs.
     * Artillery games typically use 1.0 for realistic physics.
     */
    gravityScale?: number;
    
    /**
     * Wind vector applied as continuous force (meters/second²).
     * Example: { x: 5, y: 0, z: 0 } pushes projectile in +X direction.
     * Wind is applied each physics step as an acceleration.
     */
    windVector?: { x: number; y: number; z: number };
}

/**
 * Smallest slice of viewport height a projectile's visual is allowed to cover.
 *
 * Tuned twice, both times from measurement. A 3cm sphere at third-person
 * distance drew ~5px — invisible — so a 1.5% floor went in. Then bullets
 * became slim TRACERS (createTracerMesh): the LONG axis now carries the
 * legibility, the floor measures against that axis (visualBaseRadius is the
 * bounding-sphere radius), and 1.5% + a 6× cap inflated the whole bolt into
 * a puffy ball. With a ~27cm bolt the floor only needs to rescue extreme
 * range, so it is lower and caps sooner.
 */
const MIN_PROJECTILE_SCREEN_FRACTION = 0.010;

/** Ceiling on the visual-only growth, so distant shots stay plausible. */
const MAX_PROJECTILE_VISUAL_SCALE = 3;

export class Projectile {
    private mesh: THREE.Object3D;
    private rigidBody: RAPIER.RigidBody | null = null;
    private physicsWorld: EngineLike['physicsWorld'];
    private engine: EngineLike;
    private age: number = 0; // Accumulated deltaTime
    private lifetime: number;
    private hasHitSomething: boolean = false;
    private onHitCallback: ((projectile: Projectile, hitBody?: RAPIER.RigidBody) => void) | null = null;
    private direction: THREE.Vector3;
    private speed: number;
    private trail: THREE.Mesh[] = [];
    private trailConfig: ProjectileVisualConfig['trail'] | undefined;
    private explosionConfig: ExplosionConfig | undefined;
    private projectileType: ProjectileType;
    private collisionRadius: number;
    /** Unscaled radius of the projectile's own mesh, in metres. */
    private visualBaseRadius: number = 0.05;
    private lightSphereId: number | null = null;
    private explosion: Explosion | null = null;

    private collisionMask: number;

    // Pre-allocated temp vector for lookAt calculation
    private static readonly _tempLookAt = new THREE.Vector3();
    // Shared default trail geometry/material to avoid per-projectile allocation
    private static _defaultTrailGeo: THREE.SphereGeometry | null = null;
    private static _defaultTrailMatBase: THREE.MeshBasicMaterial | null = null;
    
    /** Whether this is an enemy projectile that can damage the player */
    private isEnemyProjectile: boolean = false;
    /** Callback fired when enemy projectile hits the player */
    private onPlayerHitCallback: ((projectile: Projectile) => void) | null = null;
    /**
     * Callback fired when this projectile hits a remote (non-owned) animal.
     * Used by non-host clients to report hits to the host via network events.
     * Parameters: networkId, damage, hitPosition, hitDirection
     */
    private onRemoteAnimalHitCallback: ((
        networkId: string, damage: number,
        hitPosition: THREE.Vector3, hitDirection: THREE.Vector3,
    ) => void) | null = null;
    /** Callback fired when this projectile hits a remote (non-owned) NPC. */
    private onRemoteNpcHitCallback: ((
        networkId: string, damage: number,
        hitPosition: THREE.Vector3, hitDirection: THREE.Vector3,
    ) => void) | null = null;
    /** Callback fired when this projectile triggers an explosion (for multiplayer sync). */
    private onExplosionTriggeredCallback: ((
        position: THREE.Vector3,
        config: ExplosionConfig,
    ) => void) | null = null;
    /**
     * Callback fired for each remote player within AOE blast radius.
     * Used to broadcast PvP AOE hits via `sendHit()`.
     * Parameters: networkId (from remoteCharacters key), damage (with falloff)
     */
    private onAoePlayerHitCallback: ((
        networkId: string, damage: number,
    ) => void) | null = null;
    /** Remote character position lookup for PvP AOE — set via `setAoePlayerHitTargets()`. */
    private aoePlayerTargets: ReadonlyMap<string, { getObject3D(): THREE.Object3D }> | null = null;
    /** The rigid body that was hit (stored for checking player collision) */
    private hitBody: RAPIER.RigidBody | null = null;
    /**
     * True when this projectile struck something ALIVE (npc/animal/player).
     *
     * Debris is gated on it: a decal is the right mark for a wall, and spraying
     * red chunks off masonry would be worse than showing nothing. Debris says
     * "that thing took the shot", which only makes sense for a thing that can.
     */
    private hitDamageable = false;
    /** The controller/networkId that took the direct projectile hit (skipped during AOE to avoid double damage) */
    private directHitRef: unknown = null;
    /** Hit position for decal spawning */
    private hitPosition: THREE.Vector3 | null = null;
    /** Hit normal for decal orientation */
    private hitNormal: THREE.Vector3 | null = null;
    /** Optional decal color (undefined = use system default black) */
    private decalColor: number | undefined = undefined;
    
    /** Wind vector for ballistic projectiles (applied as acceleration each frame) */
    private windVector: { x: number; y: number; z: number } | undefined = undefined;
    /** Gravity scale (0 = no gravity/bullet, 1 = normal gravity/artillery) */
    private gravityScale: number = 0;
    /** Damage this projectile deals when hitting a target (default: 25) */
    private damage: number = 25;

    // Per-weapon "punch": speed (m/s) the corpse's torso gains along this shot's travel direction on
    // a lethal ragdoll hit. A designer value, not literal bullet momentum. 0 = gravity-only collapse.
    private knockback: number = 6;

    constructor(
        position: THREE.Vector3,
        direction: THREE.Vector3,
        speed: number,
        physicsWorld: EngineLike['physicsWorld'],
        engine: EngineLike,
        onHitCallback?: (projectile: Projectile, hitBody?: RAPIER.RigidBody) => void,
        visualConfig?: ProjectileVisualConfig,
        projectileType: ProjectileType = ProjectileType.WAVE_REVEAL,
        /** Collision mask - use CollisionMask.ENEMY_PROJECTILE for NPC projectiles to hit player */
        customCollisionMask?: number
    ) {
        this.physicsWorld = physicsWorld;
        this.engine = engine;
        this.onHitCallback = onHitCallback || null;
        this.direction = resolveFlightDirection(physicsWorld, direction);
        this.speed = speed;
        this.lifetime = 10; // 10 seconds lifetime (physics time, not real time)
        this.trailConfig = visualConfig?.trail;
        this.explosionConfig = visualConfig?.explosion;
        this.projectileType = projectileType;
        this.collisionRadius = visualConfig?.collisionRadius ?? 0.05; // Default 5cm radius
        // Use custom collision mask if provided, otherwise default PROJECTILE mask
        this.collisionMask = customCollisionMask ?? CollisionMask.PROJECTILE;
        
        // Ballistic physics config
        this.gravityScale = visualConfig?.gravityScale ?? 0; // Default 0 = bullet (no gravity)
        this.windVector = visualConfig?.windVector;

        // Create visual representation with configurable or default appearance
        if (visualConfig?.customMesh) {
            // Use custom mesh (e.g., rocket with fins)
            this.mesh = visualConfig.customMesh.clone();
        } else {
            const geometry = visualConfig?.geometry || new THREE.SphereGeometry(0.12, 16, 16);
            const material = visualConfig?.material || new THREE.MeshStandardMaterial({
                color: 0xffff00,
                emissive: 0xffff00,
                emissiveIntensity: 3.0,
                roughness: 0.2,
                metalness: 0.0,
                toneMapped: false
            });
            
            this.mesh = new THREE.Mesh(geometry, material);
            // Every shot builds and disposes this material; keep its program
            // compiled between shots (see ShaderKeepAlive).
            if (!visualConfig?.material && engine.scene) {
                keepShaderAlive(engine.scene, 'projectile:default-body', material);
            }
        }
        this.mesh.name = `Projectile_${projectileType}`;
        this.mesh.position.copy(position);
        // Trailer timeline: the constructor is the single funnel every fired
        // projectile passes through (player weapons, turrets, NPC volleys).
        getGameEventLog().logEvent({
            type: 'shot',
            position,
            actor: this.collisionMask === CollisionMask.ENEMY_PROJECTILE ? 'npc' : 'player',
        });
        this.mesh.castShadow = visualConfig?.castShadow ?? false;
        
        // Rotate mesh to face the direction of travel
        // The mesh is assumed to point along +Z, so we rotate it to match the direction
        const targetPos = Projectile._tempLookAt.copy(position).add(this.direction);
        this.mesh.lookAt(targetPos);
        
        // Base visual radius, for the minimum-apparent-size pass below. Measured
        // off the object rather than taken from the preset's radius, because a
        // weapon may supply any mesh it likes via `createProjectileMesh` — a
        // rocket is a whole group, not a sphere.
        const visualBounds = new THREE.Box3().setFromObject(this.mesh);
        const visualSize = visualBounds.getSize(new THREE.Vector3());
        this.visualBaseRadius = Math.max(visualSize.x, visualSize.y, visualSize.z) / 2 || 0.05;

        // Optionally set bloom layer
        if (visualConfig?.bloomLayer ?? true) {
            this.mesh.layers.set(1); // Use layer 1 for bloom
        }

        // Add to scene
        if (engine.scene) {
            engine.scene.add(this.mesh);
        }
        
        // Create trail segments if enabled
        const trailCfg = this.trailConfig;
        if (trailCfg?.enabled) {
            const trailLength = trailCfg.length ?? 8;
            const trailGeometry = trailCfg.geometry || Projectile._getDefaultTrailGeo();
            const fadesOut = trailCfg.opacityFalloff !== false;
            for (let i = 0; i < trailLength; i++) {
                // With opacity falloff each segment needs its own material for its
                // own opacity; otherwise the shared default material is reused.
                const trailMaterial: THREE.Material = trailCfg.material
                    ?? (fadesOut
                        ? new THREE.MeshBasicMaterial({
                            color: trailCfg.color ?? 0xffaa00,
                            transparent: true,
                            opacity: 0.6 * (1.0 - i / trailLength),
                            depthWrite: false,
                            toneMapped: false
                        })
                        : Projectile._getDefaultTrailMat());

                const trailSegment = new THREE.Mesh(trailGeometry, trailMaterial);
                if (i === 0 && !trailCfg.material && engine.scene) {
                    keepShaderAlive(engine.scene, 'projectile:trail', trailMaterial);
                }
                trailSegment.name = `ProjectileTrail_${projectileType}_${i}`;
                trailSegment.position.copy(position);
                trailSegment.visible = false;
                if (engine.scene) {
                    engine.scene.add(trailSegment);
                }
                this.trail.push(trailSegment);
            }
        }

        // Create physics body
        this.rigidBody = this.createPhysicsBody(position, speed);

        // Add light sphere for additive lighting effect
        this.addProjectileLightSphere(position);
    }
    
    /** Get voxelWorld from engine for light sphere operations */
    private getVoxelWorld(): {
        addLightSphere(position: THREE.Vector3, radius: number, color: THREE.Color, intensity: number): number;
        updateLightSpherePosition(id: number, position: THREE.Vector3): void;
        removeLightSphere(id: number): void;
    } | null {
        const colliderEditor = this.engine.gaussianSplatRenderer?.getColliderEditor();
        if (!colliderEditor || typeof colliderEditor.getVoxelWorld !== 'function') return null;
        return colliderEditor.getVoxelWorld();
    }

    /** Add a light sphere to this projectile for additive lighting effects */
    private addProjectileLightSphere(position: THREE.Vector3): void {
        const voxelWorld = this.getVoxelWorld();
        if (!voxelWorld) return;

        const lightColor = this.projectileType === ProjectileType.DESTRUCTION
            ? new THREE.Color(1, 0.2, 0)   // Red/orange for destruction
            : new THREE.Color(1, 1, 0.5);  // Yellow/white for wave reveal

        this.lightSphereId = voxelWorld.addLightSphere(position, 1.5, lightColor, 1.0);
    }

    /** Update light sphere position to follow projectile */
    private updateProjectileLightSphere(): void {
        if (this.lightSphereId === null) return;
        const voxelWorld = this.getVoxelWorld();
        if (!voxelWorld) return;
        voxelWorld.updateLightSpherePosition(this.lightSphereId, this.getPosition());
    }

    /** Remove light sphere when projectile is destroyed */
    private removeProjectileLightSphere(): void {
        if (this.lightSphereId === null) return;
        const voxelWorld = this.getVoxelWorld();
        if (!voxelWorld) return;
        voxelWorld.removeLightSphere(this.lightSphereId);
        this.lightSphereId = null;
    }

    /** `this.direction` is the flight line (normalised, and in-plane on the 2D lane). */
    private createPhysicsBody(position: THREE.Vector3, speed: number): RAPIER.RigidBody | null {
        const physicsWorld = this.physicsWorld;
        if (!physicsWorld) return null;

        // Rapier format: lower 16 bits = membership, upper 16 bits = filter (what it collides with)
        const collisionGroups = (this.collisionMask << 16) | CollisionGroup.PROJECTILE;
        // The 2D lane has no 3D Rapier to build a descriptor with — the facade
        // owns the whole recipe there (engine/physics/PlaneLockedPhysics.ts).
        // Everything below this point is lane-agnostic.
        const body = isPlaneLockedPhysics(physicsWorld)
            ? physicsWorld.createProjectileBody({
                x: position.x, y: position.y, z: position.z,
                velocity: { x: this.direction.x * speed, y: this.direction.y * speed, z: this.direction.z * speed },
                radius: this.collisionRadius,
                collisionGroups,
                gravityScale: this.gravityScale,
            }) as unknown as RAPIER.RigidBody
            : this.createRapier3DBody(physicsWorld, position, speed, collisionGroups);

        // Mark this body as a projectile for collision detection
        physicsWorld.setUserData(body, { __type: 'projectile', projectile: this });
        
        // Register collision callback
        physicsWorld.registerCollisionCallback(body, (contact) => {
            this.onPhysicsCollision(contact);
        });

        return body;
    }

    /** The 3D body: a dynamic sphere with CCD. See createProjectileBody for the 2D twin. */
    private createRapier3DBody(
        physicsWorld: PhysicsWorld, position: THREE.Vector3, speed: number, collisionGroups: number,
    ): RAPIER.RigidBody {
        const RAPIER = getRapier();

        // Create rigid body descriptor
        // gravityScale: 0 = bullet (straight line), 1 = artillery (ballistic arc)
        const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(position.x, position.y, position.z)
            .setLinvel(this.direction.x * speed, this.direction.y * speed, this.direction.z * speed)
            .setGravityScale(this.gravityScale)
            .setLinearDamping(0) // No damping
            .setAngularDamping(0)
            .setCanSleep(false)
            .setCcdEnabled(true); // Enable continuous collision detection for fast projectiles
        
        // Set soft CCD prediction distance based on speed - look ahead far enough to catch fast-moving targets
        // At 50m/s, looking 1.0m ahead catches collisions even at low framerates
        const ccdPrediction = Math.max(1.0, speed * 0.02); // At least 1.0m, or 2% of speed
        bodyDesc.setSoftCcdPrediction(ccdPrediction);
        
        const body = physicsWorld.createRigidBody(bodyDesc);
        
        // Lock rotations
        body.lockRotations(true, true);
        
        // Create sphere collider (a zero-length capsule, never a Ball shape —
        // see sphereColliderDesc for the Rapier crash it sidesteps).
        const colliderDesc = sphereColliderDesc(this.collisionRadius)
            .setFriction(0)
            .setRestitution(0)
            .setCollisionGroups(collisionGroups)
            .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS); // Enable collision events
        
        physicsWorld.createCollider(colliderDesc, body);

        return body;
    }
    
    /**
     * Handle collision event from Rapier physics engine.
     * This is called automatically when the projectile collides with something.
     */
    private onPhysicsCollision(contact: import('./physics/PhysicsWorld.js').ContactInfo): void {
        if (this.hasHitSomething) return;
        
        // Determine which body is the "other" body (not this projectile)
        // and ensure normal points AWAY from the surface (toward the projectile)
        const isProjectileBodyA = contact.bodyA.handle === this.rigidBody?.handle;
        const otherBody = isProjectileBodyA ? contact.bodyB : contact.bodyA;
        
        // Skip collision with other projectiles
        const userData = this.physicsWorld?.getUserData(otherBody);
        if (userData?.__type === 'projectile') return;
        
        // A geometric normal (computed from trimesh vertices) is already the true
        // outward surface normal. Rapier's own manifold normal points from bodyA
        // to bodyB, so it points INTO the surface when the projectile is bodyA
        // and has to be flipped back outward.
        const surfaceNormal = contact.contactNormal.clone();
        if (!contact.isGeometricNormal && isProjectileBodyA) surfaceNormal.negate();

        this.handleCollision(otherBody, contact.contactPoint, surfaceNormal);
    }

    /**
     * Get the physics body handle for batch collision detection.
     */
    getBodyHandle(): number {
        return this.getRigidBodyHandle();
    }
    
    /**
     * Check if projectile has already hit something.
     */
    hasAlreadyHit(): boolean {
        return this.hasHitSomething;
    }
    
    /**
     * Handle collision detected by Rapier physics engine.
     * Called from onPhysicsCollision when a collision event is triggered.
     */
    handleCollision(
        otherBody: RAPIER.RigidBody, 
        contactPoint: THREE.Vector3,
        contactNormal: THREE.Vector3
    ): void {
        if (this.hasHitSomething) return;
        
        // Check if collision is underwater
        const isUnderwater = getWaterBuoyancySystem().isPositionUnderwater(
            contactPoint.x, contactPoint.y, contactPoint.z
        );
        
        // Check if we hit static environment (terrain)
        const isStatic = otherBody.isFixed();
        
        // If underwater and hitting static terrain, fizzle (no explosion)
        if (isUnderwater && isStatic) {
            this.hasHitSomething = true;
            this.dispose();
            return;
        }
        
        // Store the hit body
        this.hitBody = otherBody;
        
        // Check if we hit an NPC, animal, or remote animal and deal damage.
        // Each branch also records the directly-hit entity, so an explosion's AOE
        // pass can skip it instead of damaging it a second time.
        const userData = this.physicsWorld?.getUserData(otherBody);

        if (userData?.__type === 'npc') {
            this.directHitRef = userData.npcController;
            const npc = userData.npcController as {
                onProjectileCollision?: (p: Projectile) => void;
            } | undefined;
            if (npc) {
                this.hitDamageable = true;
                npc.onProjectileCollision?.(this);
            }
        } else if (userData?.__type === 'animal') {
            this.directHitRef = userData.animalController;
            const animal = userData.animalController as {
                onProjectileCollision?: (p: Projectile | null, damageOverride?: number) => void;
            } | undefined;
            if (animal) {
                this.hitDamageable = true;
                animal.onProjectileCollision?.(this);
            }
        } else if (userData?.__type === 'remoteAnimal' || userData?.__type === 'remoteNpc') {
            // Hit a remote NPC/animal (host-owned, visual-only on this client).
            // Fire the callback so the game/MultiplayerSetup can send a hit event to the host.
            this.directHitRef = userData.networkId;
            const reportHit = userData.__type === 'remoteNpc'
                ? this.onRemoteNpcHitCallback
                : this.onRemoteAnimalHitCallback;
            if (userData.networkId && reportHit) {
                reportHit(
                    userData.networkId as string,
                    this.getDamage(),
                    contactPoint.clone(),
                    this.getDirection().clone().negate(),
                );
            }
        } else if (isPlayerBody(otherBody)) {
            this.directHitRef = otherBody.handle;
        }

        // Record the surface contact for environment hits — static bodies, and
        // DYNAMIC voxel props (crates, wrecks: sleeping dynamic bodies that are
        // still scenery to a bullet). Gating on isFixed alone left every
        // dynamic prop with no hit data at all: no carved hole, and no decal
        // either. NPCs, players and animals stay excluded — their bodies carry
        // no voxelObject, and hits on them read through debris, not marks.
        if (isStatic || !!userData?.voxelObject) {
            // Rapier's contact manifold sometimes reports a ZERO normal (an
            // early narrow-phase event with no populated manifold), and
            // normalize() leaves it zero. Everything downstream then silently
            // dies: decal corner rays have no direction, and a carve has no
            // way in. The reversed TRAVEL direction is always available and is
            // a faithful surface normal for the shallow angles bullets meet
            // scenery at — the impact spark has used it all along.
            const manifoldNormal = contactNormal.clone();
            this.hitNormal = manifoldNormal.lengthSq() > 1e-8
                ? manifoldNormal.normalize()
                : this.getDirection().clone().negate().normalize();
            
            // Use contact point directly and add tiny offset along normal for z-fighting prevention
            this.hitPosition = contactPoint.clone().add(
                this.hitNormal.clone().multiplyScalar(0.005)
            );
        }

        // Trigger hit (always, even for non-static objects)
        this.onHit();
    }

    /**
     * Update projectile without collision checking.
     * Used by ProjectileManager which does batch collision detection.
     */
    updateWithoutCollisionCheck(deltaTime: number): void {
        // Update explosion if active
        if (this.explosion) {
            this.explosion.update(deltaTime);
            return;
        }
        
        if (!this.rigidBody) return;

        // If already hit something, skip all updates
        if (this.hasHitSomething) {
            return;
        }

        // Apply wind force for ballistic projectiles (wind is acceleration, multiply by deltaTime for impulse)
        if (this.windVector) {
            const impulse = {
                x: this.windVector.x * deltaTime,
                y: this.windVector.y * deltaTime,
                z: this.windVector.z * deltaTime
            };
            this.rigidBody.applyImpulse(impulse, true);
        }

        // Check lifetime
        this.age += deltaTime;
        if (this.age > this.lifetime) {
            // An explosive projectile that reached the end of its flight without
            // touching anything detonates here rather than silently vanishing —
            // a rocket fired into the sky, over a cliff, or across open ground
            // that just blinks out reads as a broken weapon. `isExpired()`
            // already waits for `this.explosion` to finish before the owner
            // disposes it, so the blast plays out in full.
            if (this.explosionConfig?.enabled && !this.hasHitSomething) {
                this.onHit();
            }
            return;
        }

        // Sync visual mesh with physics body — the trail reads the mesh's
        // PREVIOUS position, so it shifts before the mesh moves.
        const origin = this.rigidBody.translation();

        // Update trail
        for (let i = this.trail.length - 1; i > 0; i--) {
            const segment = this.trail[i]!;
            const ahead = this.trail[i - 1]!;
            segment.position.copy(ahead.position);
            segment.visible = ahead.visible;
        }
        const head = this.trail[0];
        if (head) {
            head.position.copy(this.mesh.position);
            head.visible = true;
        }
        
        this.mesh.position.set(origin.x, origin.y, origin.z);
        this.applyMinimumApparentSize();

        // Update light sphere position
        this.updateProjectileLightSphere();
    }

    /**
     * Update projectile state each frame.
     */
    update(deltaTime: number): void {
        this.updateWithoutCollisionCheck(deltaTime);
    }

    private onHit(): void {
        if (this.hasHitSomething) {
            return;
        }

        this.hasHitSomething = true;
        
        // Stop the projectile immediately (no ricochet/bounce)
        if (this.rigidBody) {
            this.rigidBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
            this.rigidBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
            
            // Disable the body (Rapier doesn't have activation states like Ammo)
            this.rigidBody.setEnabled(false);
        }

        const hitPlayer = this.hitBody ? isPlayerBody(this.hitBody) : false;

        // Check if enemy projectile hit the player
        if (this.isEnemyProjectile && hitPlayer && this.onPlayerHitCallback) {
            this.onPlayerHitCallback(this);
        }

        // Trigger explosion if configured
        if (this.explosionConfig?.enabled) {
            this.triggerExplosion();
        } else {
            // Trailer timeline (explosive hits log 'explosion' instead)
            getGameEventLog().logEvent({ type: 'projectile-hit', position: this.hitPosition ?? this.getPosition() });
            // Both marks need a contact point and normal, which handleCollision
            // only records for a static hit.
            if (this.hitPosition && this.hitNormal) {
                // Only mark the surface for non-explosive projectiles (an
                // explosion destroys it anyway).
                if (!hitPlayer) {
                    // Prefer a REAL hole. Carving only accepts objects that own
                    // their geometry and are small enough to rebuild cheaply, so
                    // the decal remains the fallback for terrain, for shared
                    // instanced templates, and for anything oversized.
                    // The 2D lane keeps the decal: a carve detaches the cut
                    // voxel as a 3D debris body, which that world cannot build.
                    const carved = this.hitBody && this.physicsWorld && !isPlaneLockedPhysics(this.physicsWorld)
                        ? getVoxelCarveSystem()?.queueHit(
                            VoxelObject.fromRigidBody(this.hitBody, this.physicsWorld),
                            this.hitPosition,
                            undefined,
                            // The body itself, so a hit on batched scenery can be
                            // traced to the specific instance and promoted.
                            {
                                body: this.hitBody,
                                physicsWorld: this.physicsWorld,
                                normal: this.hitNormal,
                                travelDirection: this.getDirection(),
                            },
                        ) === true
                        : false;
                    if (!carved) {
                        getDecalSystem()?.spawnFromHit(this.hitPosition, this.hitNormal, this.decalColor);
                    }
                }
                // Debris off the thing that was hit. A decal marks the SURFACE, which
                // is right for a wall and says nothing when the target is an NPC that
                // just took the shot — the player needs to see the hit register on
                // the target itself. Spawns for the player too (unlike the decal):
                // being shot is exactly when you want the feedback.
                // Passing no target means the configured fallback colour is used: a
                // projectile only ever knows the physics BODY it struck, never the
                // mesh, so there is nothing here to sample a colour from. Melee does
                // sample, because a raycast hands it the actual object.
                if (this.hitDamageable || hitPlayer) {
                    spawnHitDebris(this.hitPosition, this.hitNormal, null);
                }
            }
        }

        // Call the hit callback if provided
        if (this.onHitCallback) {
            this.onHitCallback(this, this.hitBody ?? undefined);
        }
    }
    
    /**
     * Grow the projectile's VISUAL so it stays readable at camera distance.
     *
     * Physics is untouched — the collider keeps its authored radius, so this
     * changes nothing about what a shot can hit. Only the mesh and its trail
     * are scaled, and only upward: a bullet already large enough on screen (a
     * rocket, or anything close to the camera) is left exactly as authored.
     *
     * Perspective cameras only. Under the orthographic top-down camera apparent
     * size does not fall off with distance, so there is nothing to correct.
     */
    private applyMinimumApparentSize(): void {
        const camera = this.engine.camera;
        if (!camera || !(camera as THREE.PerspectiveCamera).isPerspectiveCamera) return;

        const fovRad = ((camera as THREE.PerspectiveCamera).fov * Math.PI) / 180;
        const distance = camera.position.distanceTo(this.mesh.position);
        const viewHeightAtDistance = 2 * Math.tan(fovRad / 2) * distance;
        const wantedDiameter = viewHeightAtDistance * MIN_PROJECTILE_SCREEN_FRACTION;
        const actualDiameter = this.visualBaseRadius * 2;
        if (actualDiameter <= 0) return;

        const scale = Math.min(
            MAX_PROJECTILE_VISUAL_SCALE,
            Math.max(1, wantedDiameter / actualDiameter),
        );
        this.mesh.scale.setScalar(scale);
        for (const segment of this.trail) {
            segment.scale.setScalar(scale);
        }
    }

    /**
     * Trigger explosion at current position
     */
    private triggerExplosion(): void {
        if (!this.explosionConfig || this.explosion) return;

        const position = this.getPosition();

        this.explosion = new Explosion(
            position,
            this.explosionConfig,
            this.engine
        );

        // Trailer timeline
        getGameEventLog().logEvent({
            type: 'explosion',
            position,
            data: { radius: this.explosion.getDamageRadius() },
        });

        // Notify listeners (multiplayer sync — broadcast explosion to remote clients)
        this.onExplosionTriggeredCallback?.(position, this.explosionConfig);

        // Apply AOE damage to all entities in blast radius
        this.applyAoeDamage(this.explosion);

        // Hide the projectile mesh (explosion takes over)
        this.mesh.visible = false;
        // Hide trail
        this.trail.forEach(t => t.visible = false);
    }

    /**
     * Apply AOE damage to all entities within the explosion's damage radius.
     * Skips the directly-hit entity (already damaged by the direct projectile hit).
     * Handles local NPCs, local animals, remote entities (via network callbacks), and the player.
     */
    private applyAoeDamage(explosion: Explosion): void {
        const baseDamage = explosion.getBaseDamage() || this.damage;
        const damageRadius = explosion.getDamageRadius();
        if (baseDamage <= 0 || damageRadius <= 0) return;

        const center = explosion.getPosition();

        // Helper: calculate falloff damage at a position
        const calcDamage = (pos: { x: number; y: number; z: number }): number => {
            const dx = pos.x - center.x;
            const dy = pos.y - center.y;
            const dz = pos.z - center.z;
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (dist >= damageRadius) return 0;
            return baseDamage * (1 - dist / damageRadius);
        };

        // --- Local NPCs & Animals (one damage path: both expose the same
        //     isDead/isExploded/getPosition/takeDamage surface) ---
        const npcs = this.engine.getNpcRegistry?.()?.getAllControllers() ?? [];
        const animals = this.engine.getAnimalRegistry?.()?.getAll() ?? [];
        for (const target of [...npcs, ...animals]) {
            if (target.isDead() || target.isExploded()) continue;
            if (target === this.directHitRef) continue;
            const dmg = calcDamage(target.getPosition());
            if (dmg > 0) {
                target.takeDamage(dmg, 'explosion');
            }
        }

        // --- Remote NPCs & Animals (multiplayer — report hits to host) ---
        // Uses spatial query to only check entities within the damage radius
        if (this.physicsWorld && (this.onRemoteNpcHitCallback || this.onRemoteAnimalHitCallback)) {
            const nearby = this.physicsWorld.queryEntitiesInRadius(center, damageRadius);
            for (const entity of nearby) {
                const userData = entity.userData as Record<string, unknown>;
                const networkId = userData['networkId'] as string | undefined;
                if (!networkId || networkId === this.directHitRef) continue;

                const type = userData['__type'] as string;
                if (type !== 'remoteNpc' && type !== 'remoteAnimal') continue;

                const dmg = calcDamage(entity.position);
                if (dmg <= 0) continue;

                const hitDir = this.getDirection().clone().negate();
                const hitPos = new THREE.Vector3(entity.position.x, entity.position.y, entity.position.z);

                if (type === 'remoteNpc' && this.onRemoteNpcHitCallback) {
                    this.onRemoteNpcHitCallback(networkId, dmg, hitPos, hitDir);
                } else if (type === 'remoteAnimal' && this.onRemoteAnimalHitCallback) {
                    this.onRemoteAnimalHitCallback(networkId, dmg, hitPos, hitDir);
                }
            }
        }

        // --- Remote players PvP AOE (multiplayer — broadcast hits) ---
        if (this.onAoePlayerHitCallback && this.aoePlayerTargets) {
            for (const [networkId, remoteChar] of this.aoePlayerTargets) {
                const charObj = remoteChar.getObject3D();
                const charPos = charObj?.position;
                if (!charPos) continue;
                const dmg = calcDamage(charPos);
                if (dmg > 0) {
                    this.onAoePlayerHitCallback(networkId, Math.round(dmg));
                }
            }
        }

        // --- Player damage (enemy projectile AOE) ---
        if (this.isEnemyProjectile && this.onPlayerHitCallback && this.physicsWorld) {
            for (const playerHandle of playerBodyHandles) {
                if (playerHandle === this.directHitRef) continue;
                const translation = this.physicsWorld.getBodyTranslation(playerHandle);
                if (!translation) continue;
                const dmg = calcDamage(translation);
                if (dmg > 0) {
                    // Override damage temporarily so the callback reads AOE damage
                    const originalDamage = this.damage;
                    this.damage = dmg;
                    try {
                        this.onPlayerHitCallback(this);
                    } finally {
                        this.damage = originalDamage;
                    }
                }
            }
        }
    }
    
    /**
     * Check if explosion has finished (for cleanup)
     */
    hasExplosionFinished(): boolean {
        return this.explosion?.isFinished() ?? true;
    }
    
    /**
     * Get explosion instance for external damage calculations
     */
    getExplosion(): Explosion | null {
        return this.explosion;
    }
    
    callOnHit(): void {
        this.onHit();
    }

    isExpired(): boolean {
        // If exploding, wait for explosion to finish
        if (this.explosion) {
            return this.explosion.isFinished();
        }
        // Hit something: expired right away without an explosion config, otherwise
        // stay alive until the explosion has been created and has finished
        if (this.hasHitSomething) {
            return !this.explosionConfig?.enabled;
        }
        return this.age > this.lifetime;
    }

    getPosition(): THREE.Vector3 {
        if (!this.rigidBody) return this.mesh.position.clone();

        const origin = this.rigidBody.translation();
        return new THREE.Vector3(origin.x, origin.y, origin.z);
    }

    getMesh(): THREE.Object3D {
        return this.mesh;
    }

    getRigidBody(): RAPIER.RigidBody | null {
        return this.rigidBody;
    }

    getRigidBodyHandle(): number {
        return this.rigidBody?.handle ?? 0;
    }

    /**
     * Get the direction this projectile is traveling
     */
    getDirection(): THREE.Vector3 {
        return this.direction.clone();
    }

    /**
     * Get the speed of this projectile (units per second).
     */
    getSpeed(): number {
        return this.speed;
    }

    /**
     * Get the damage this projectile deals when hitting a target
     */
    getDamage(): number {
        return this.damage;
    }

    /**
     * Set the damage this projectile deals when hitting a target
     * @param damage - Damage amount (must be positive)
     */
    setDamage(damage: number): void {
        this.damage = Math.max(0, damage);
    }

    /** Ragdoll knockback speed (m/s) on a lethal hit — per-weapon punch (default 6). */
    getKnockback(): number {
        return this.knockback;
    }

    /** Set the ragdoll knockback speed (m/s). 0 disables the shove (gravity-only collapse). */
    setKnockback(knockback: number): void {
        this.knockback = Math.max(0, knockback);
    }

    /**
     * Mark this projectile as an enemy projectile that can damage the player.
     * Call this immediately after creating the projectile.
     * @param onPlayerHit Callback fired when this projectile hits the player
     */
    setEnemyProjectile(onPlayerHit: (projectile: Projectile) => void): this {
        this.isEnemyProjectile = true;
        this.onPlayerHitCallback = onPlayerHit;
        return this;
    }

    /**
     * Set a callback for when this projectile hits a remote (non-owned) animal.
     * Used by non-host clients in multiplayer: the callback should send a hit event
     * to the host (via MultiplayerSetup.sendAnimalHit) and spawn local visual effects.
     */
    setOnRemoteAnimalHit(callback: (
        networkId: string, damage: number,
        hitPosition: THREE.Vector3, hitDirection: THREE.Vector3,
    ) => void): this {
        this.onRemoteAnimalHitCallback = callback;
        return this;
    }

    /**
     * Set a callback for when this projectile hits a remote (non-owned) NPC.
     * Used by non-host clients in multiplayer: the callback should send a hit event
     * to the host (via MultiplayerSetup.sendNpcHit) and spawn local visual effects.
     */
    setOnRemoteNpcHit(callback: (
        networkId: string, damage: number,
        hitPosition: THREE.Vector3, hitDirection: THREE.Vector3,
    ) => void): this {
        this.onRemoteNpcHitCallback = callback;
        return this;
    }

    /**
     * Set a callback for when this projectile triggers an explosion.
     * Used for multiplayer sync: the callback should broadcast the explosion
     * to remote clients (via MultiplayerSetup.sendExplosion) so they can
     * spawn the visual explosion and apply environment destruction.
     */
    setOnExplosionTriggered(callback: (
        position: THREE.Vector3,
        config: ExplosionConfig,
    ) => void): this {
        this.onExplosionTriggeredCallback = callback;
        return this;
    }

    /**
     * Register a callback for PvP AOE hits and provide the set of remote
     * player characters to scan. When an explosion triggers, the engine
     * iterates `targets`, calculates distance-based damage for each player
     * in range, and invokes `callback(networkId, damage)`.
     *
     * The template should forward these hits to `multiplayer.sendHit()`.
     */
    setOnAoePlayerHit(
        targets: ReadonlyMap<string, { getObject3D(): THREE.Object3D }>,
        callback: (networkId: string, damage: number) => void,
    ): this {
        this.aoePlayerTargets = targets;
        this.onAoePlayerHitCallback = callback;
        return this;
    }

    /**
     * Set the decal color for this projectile.
     * When the projectile hits a surface, it leaves a mark of this color.
     * @param color Hex color (e.g., 0xff0000 for red). If undefined, uses system default (black).
     */
    setDecalColor(color: number | undefined): this {
        this.decalColor = color;
        return this;
    }

    /**
     * Get the decal color for this projectile
     */
    getDecalColor(): number | undefined {
        return this.decalColor;
    }

    /**
     * Check if this is an enemy projectile
     */
    getIsEnemyProjectile(): boolean {
        return this.isEnemyProjectile;
    }

    hasHit(): boolean {
        return this.hasHitSomething;
    }

    /**
     * Exact surface contact point of the hit, or null if this projectile has
     * not struck a static surface.
     *
     * NOT the same as `getPosition()`, which is the projectile body's centre —
     * off by the projectile's own radius plus whatever it travelled in the
     * frame it landed. Anything placing geometry or effects at the impact (a
     * carved hole, a decal, a scorch) needs this one.
     */
    getHitPosition(): THREE.Vector3 | null {
        return this.hitPosition;
    }

    /** Outward surface normal at the hit, or null if it has not struck one. */
    getHitNormal(): THREE.Vector3 | null {
        return this.hitNormal;
    }

    getHitBody(): RAPIER.RigidBody | null {
        return this.hitBody;
    }

    getProjectileType(): ProjectileType {
        return this.projectileType;
    }

    /**
     * Get current velocity vector (for trajectory prediction or debugging).
     */
    getVelocity(): THREE.Vector3 {
        if (!this.rigidBody) return new THREE.Vector3();
        const vel = this.rigidBody.linvel();
        return new THREE.Vector3(vel.x, vel.y, vel.z);
    }

    /**
     * Update wind vector at runtime (e.g., wind changes between turns in artillery games).
     * @param windVector New wind acceleration vector, or undefined to disable wind
     */
    setWindVector(windVector: { x: number; y: number; z: number } | undefined): void {
        this.windVector = windVector;
    }

    /**
     * Get the current gravity scale (0 = no gravity, 1 = normal gravity).
     */
    getGravityScale(): number {
        return this.gravityScale;
    }

    private static _getDefaultTrailGeo(): THREE.SphereGeometry {
        return Projectile._defaultTrailGeo ??= new THREE.SphereGeometry(0.06, 8, 8);
    }

    private static _getDefaultTrailMat(): THREE.MeshBasicMaterial {
        return Projectile._defaultTrailMatBase ??= new THREE.MeshBasicMaterial({
            color: 0xffaa00,
            transparent: true,
            opacity: 0.6,
            depthWrite: false,
            toneMapped: false
        });
    }

    dispose(): void {
        // Dispose explosion if any
        if (this.explosion) {
            this.explosion.dispose();
            this.explosion = null;
        }
        
        // Remove light sphere
        this.removeProjectileLightSphere();
        
        // Remove from scene
        if (this.mesh.parent) {
            this.mesh.parent.remove(this.mesh);
        }
        
        // Remove trail segments (don't dispose shared/user-provided geometry/material)
        const userGeo = this.trailConfig?.geometry;
        const userMat = this.trailConfig?.material;
        this.trail.forEach(segment => {
            if (segment.parent) {
                segment.parent.remove(segment);
            }
            if (segment.geometry !== Projectile._defaultTrailGeo && segment.geometry !== userGeo) {
                segment.geometry.dispose();
            }
            if (segment.material !== Projectile._defaultTrailMatBase && segment.material !== userMat) {
                (segment.material as THREE.Material).dispose();
            }
        });
        this.trail = [];

        // Remove from physics world
        if (this.rigidBody && this.physicsWorld) {
            this.physicsWorld.removeRigidBody(this.rigidBody);
            this.rigidBody = null;
        }

        // Dispose geometry and material — handle both Mesh and Group/Object3D
        this.mesh.traverse((child) => {
            if ((child as THREE.Mesh).isMesh) {
                const mesh = child as THREE.Mesh;
                mesh.geometry?.dispose();
                if (mesh.material) {
                    if (Array.isArray(mesh.material)) {
                        mesh.material.forEach(m => m.dispose());
                    } else {
                        mesh.material.dispose();
                    }
                }
            }
        });
    }
}


/** Explosion visual effect with unchanged damage calculation helpers. */
export class Explosion {
    private readonly position: THREE.Vector3;
    private readonly config: ExplosionConfig;
    private visual: ExplosionVisual | null = null;
    private age = 0;
    private finished = false;

    constructor(position: THREE.Vector3, config: ExplosionConfig, engine: EngineLike) {
        this.position = position.clone();
        this.config = config;
        if (engine.scene) this.visual = ExplosionVisual.acquire(engine.scene, position, {
            radius: config.radius, color: config.color ?? explosionRecipe(config.preset ?? 'blast').color,
            preset: config.preset, amount: config.amount, variance: config.variance, quality: config.quality, layers: config.layers,
            style: config.visualStyle ?? engine.getGameData?.()?.artStyle ?? 'voxel',
            seed: config.seed ?? Math.floor(Math.random() * 4294967296),
        });
    }

    update(deltaTime: number): void {
        if (this.finished) return;
        this.age += Math.max(0, deltaTime);
        const progress = this.config.duration > 0 ? this.age / this.config.duration : 1;
        this.visual?.setProgress(progress);
        if (progress >= 1) {
            this.finished = true;
            this.visual?.release();
            this.visual = null;
        }
    }

    /**
     * Check if explosion animation is finished
     */
    isFinished(): boolean {
        return this.finished;
    }
    
    /**
     * Get explosion center position
     */
    getPosition(): THREE.Vector3 {
        return this.position.clone();
    }
    
    /**
     * Get damage radius (for NPC damage calculations)
     */
    getDamageRadius(): number {
        return this.config.damageRadius ?? this.config.radius;
    }
    
    /**
     * Get base damage at center (for NPC damage calculations)
     */
    getBaseDamage(): number {
        return this.config.damage ?? 0;
    }
    
    /**
     * Calculate damage at a given distance from explosion center.
     * Uses linear falloff from center to edge of damage radius.
     * 
     * @param targetPosition - Position to calculate damage for
     * @returns Damage value (0 if outside damage radius)
     * 
     * @example
     * // In NPC damage system:
     * const explosion = projectile.getExplosion();
     * if (explosion) {
     *     const damage = explosion.calculateDamageAtPosition(npc.getPosition());
     *     if (damage > 0) {
     *         npc.takeDamage(damage);
     *     }
     * }
     */
    calculateDamageAtPosition(targetPosition: THREE.Vector3): number {
        const distance = this.position.distanceTo(targetPosition);
        const damageRadius = this.getDamageRadius();
        
        if (distance >= damageRadius) {
            return 0;
        }
        
        // Linear falloff: 100% at center, 0% at edge
        const falloff = 1.0 - (distance / damageRadius);
        return this.getBaseDamage() * falloff;
    }
    
    /**
     * Get all targets within damage radius.
     * Helper for future NPC damage implementation.
     * 
     * @param potentialTargets - Array of objects with getPosition() method
     * @returns Array of { target, damage, distance } for targets in range
     */
    getTargetsInRange<T extends { getPosition(): THREE.Vector3 }>(
        potentialTargets: T[]
    ): Array<{ target: T; damage: number; distance: number }> {
        const results: Array<{ target: T; damage: number; distance: number }> = [];
        const damageRadius = this.getDamageRadius();
        
        for (const target of potentialTargets) {
            const targetPos = target.getPosition();
            const distance = this.position.distanceTo(targetPos);
            
            if (distance < damageRadius) {
                const damage = this.calculateDamageAtPosition(targetPos);
                results.push({ target, damage, distance });
            }
        }
        
        // Sort by distance (closest first)
        results.sort((a, b) => a.distance - b.distance);
        
        return results;
    }
    
    /** Return the visual's buffers to the scene pool. Damage queries remain available. */
    dispose(): void {
        this.visual?.release();
        this.visual = null;
        this.finished = true;
    }
}
