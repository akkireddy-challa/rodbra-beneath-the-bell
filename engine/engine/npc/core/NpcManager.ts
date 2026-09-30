import * as THREE from 'three';
import { NpcController } from 'engine/npc/core/NpcController.js';
import type { VxlEyeLook } from 'engine/loaders/VxlCharacterEyes.js';
import { getNpcSkeletonSource } from 'engine/npc/core/NpcSkeletonSource.js';
import { createExampleEnemyCharacter } from 'engine/ExampleEnemyCharacter.js';
import type { INpcManagerBehavior } from 'engine/npc/INpcManagerBehavior.js';
import type { EngineLike } from 'types/game.js';
import { NpcEnemyManagerBehavior } from 'engine/npc/manager-behaviors/NpcEnemyManagerBehavior.js';
import type { IBlockCharacterFactory } from 'engine/IBlockCharacterFactory.js';
import type { DamageableConfig } from 'engine/IDamageable.js';
import { buildAnimationList } from 'engine/AnimationPacks.js';
import { ProjectileManager } from 'engine/ProjectileManager.js';
import { queryPhysicsFor } from 'engine/physics/PlaneLockedPhysics.js';
import { Spawner, type SpawnRelation, type RelativeSpawnOptions, type CustomPositionFn } from 'engine/Spawner.js';
import { getObjectIdService } from 'engine/ObjectIdService.js';
import { findValidatedSpawnPosition } from 'engine/npc/core/findValidatedSpawnPosition.js';
import { createPhysicsSpawnFinder } from 'engine/bakedSpawnResolver.js';
import { getGlobalLodScheduler } from 'engine/character/CharacterLodScheduler.js';
import { getGlobalCrowd } from 'engine/npc/crowd/CrowdAgents.js';
import { loadCharacterModel } from 'engine/loaders/CharacterModelLoader.js';
import { activeQualityPolicy } from 'engine/DeviceQuality.js';

/** Character dimensions returned by a character-creation function. */
type CharacterDimensions = { width: number; height: number; depth: number };

/** Either a full block-character factory or a plain function that populates the group. */
export type CharacterFactory =
    | IBlockCharacterFactory
    | ((characterGroup: THREE.Group) => CharacterDimensions);

/**
 * Options for spawning an NPC relative to an object
 */
export interface SpawnNpcRelativeOptions {
    /** ID of the object to spawn relative to (from ObjectIdService) */
    objectId: string;
    /** Spatial relation to the object (use this OR customPosition) */
    relation?: SpawnRelation;
    /** Custom position calculator function (use this OR relation) - for extensibility */
    customPosition?: CustomPositionFn;
    /** Fine-tuning offset in local coordinates */
    offset?: { x?: number; y?: number; z?: number };
    /** For BESIDE relation: which side */
    side?: 'left' | 'right';
    /** Distance from object (used for IN_FRONT/BEHIND/BESIDE, default: 2) */
    distance?: number;
    /** Optional custom character factory */
    characterFactory?: CharacterFactory;
}

/**
 * NpcManager - Generic NPC lifecycle manager using Strategy Pattern
 *
 * Manages multiple NPCs of the same type. One manager instance can handle
 * many NPCs (e.g., 100 zombies). Each spawnNpc() call ADDS a new NPC.
 *
 * @internal Engine-internal class. Templates and agents should use
 * `engine.registerNpc(name, behavior, options)` which returns an NpcHandle
 * for spawning via `handle.spawn(x, z)`.
 *
 * Key features:
 * - Spawning/despawning NPCs with automatic retry if prerequisites aren't ready
 * - Update loop and respawn timers
 * - Auto-registration with NpcRegistry
 *
 * NPC behavior is controlled by INpcBehavior (per-NPC actions) and
 * INpcManagerBehavior (manager-level configuration like respawn rules).
 *
 * @see npc/index.ts - Complete API documentation
 * @see npc/examples/ - Example behaviors and integration patterns
 */
export class NpcManager {
    private engine: EngineLike;
    
    // ════════════════════════════════════════════════════════════════════════════
    // MULTI-NPC SUPPORT: Map of all NPCs managed by this manager
    // ════════════════════════════════════════════════════════════════════════════
    private npcControllers: Map<string, NpcController> = new Map();
    /** See getRosterGeneration. */
    private rosterGeneration = 0;
    
    // Per-NPC respawn tracking
    private respawnTimers: Map<string, number> = new Map();
    private respawningNpcs: Set<string> = new Set();
    private npcSpawnPositions: Map<string, THREE.Vector3> = new Map();
    
    private managerBehavior: INpcManagerBehavior;
    private spawnRequested: boolean = false; // Track if spawnNpc() was called (used by validateSetup)
    // Queue for spawn requests deferred because prerequisites (scene/physics/GLTF) weren't ready.
    private pendingSpawnRequests: Array<{ x?: number; z?: number; y?: number; factory?: CharacterFactory }> = [];
    private lastSpawnAttemptTime: number = 0; // Track last spawn attempt for retry throttling
    private autoSpawnEnabled: boolean = true; // Enable automatic retry spawning (can be disabled)
    // Queue for spawn requests that failed because no valid voxel position was found at the
    // requested coord. We preserve the original (x, z) so the retry stays near the caller's
    // intended location instead of teleporting to a random worldwide point. `attempt` counts
    // how many times THIS request has been re-queued, so a request whose column is
    // permanently unspawnable terminates with a diagnostic instead of cycling forever.
    private pendingPositionRetries: Array<{ x?: number; z?: number; y?: number; factory?: CharacterFactory; attempt: number }> = [];
    private fallbackSpawner: Spawner | null = null;
    /** Engine-owned gridless spawn finder for baked levels (see getPhysicsSpawnFinder). */
    private physicsSpawnFinder: ((x: number, z: number, fromY?: number) => THREE.Vector3 | null) | null = null;
    private warnedPositionRetriesFull = false;
    // ⚠️ CRITICAL: Store character factory per-instance so each NPC manager has its own appearance
    private characterFactory: CharacterFactory | null = null;
    // Per-manager custom character GLB (e.g. an Asset Forger generated character via the
    // generate_character tool). When set, every NPC this manager spawns renders this GLB
    // instead of the shared default skeleton. Loaded once and cached.
    private npcCharacterUrl: string | null = null;
    private npcCharacterGLTF: unknown = null;
    private npcCharacterLoadPromise: Promise<unknown> | null = null;
    // Yaw correction (radians) for a custom character GLB authored facing the wrong way.
    // Applied to the visible skinned mesh of every NPC this manager spawns. 0 = no change.
    private npcModelRotationY = 0;
    /** Eye colours for every NPC of this type, or null for the record's own. */
    private npcEyeLook: VxlEyeLook | null = null;
    private damageableConfig: Partial<DamageableConfig> | undefined;
    
    // When true, spawnNpc skips the automatic loadAllAnimationAssets() call.
    // Use when template code loads only the specific animations each NPC needs.
    private _skipAutoAnimationLoading: boolean = false;
    
    // Frame-idempotent update: prevents double-updating when both manual and registry updates coexist
    private lastUpdateFrame: number = -1;
    private static globalFrameCounter: number = 0;
    
    // Auto-registration: tracks whether this manager has been registered with the engine's NpcRegistry
    private autoRegistered: boolean = false;
    
    // Simulation importance tier for every NPC this manager spawns.
    // Unset resolves to 'crowd' (see getImportance) — unmarked means cheap.
    private importance: 'hero' | 'crowd' | undefined;
    /**
     * Side-on 2D games keep NPCs on the gameplay plane (see engine/GameplayPlane.ts
     * and NpcController.applyGameplayPlaneLock). Off by request only — a deliberate
     * backdrop actor registered with `{ planeLock: false }`.
     */
    private planeLockEnabled = true;

    // Voxel block size for step climbing (applied to all NPCs)
    private _voxelBlockSize: number = 1.0;
    
    // Unique ID generation system
    private static idCounters: Map<string, number> = new Map();

    /**
     * Create a new NPC manager with specified behavior
     * 
     * @param engine - Game engine reference
     * @param managerBehavior - Behavior that controls how this NPC is managed
     *                          (e.g., NpcEnemyManagerBehavior, NpcShopkeeperManagerBehavior)
     */
    constructor(engine: EngineLike, managerBehavior: INpcManagerBehavior) {
        this.engine = engine;
        this.managerBehavior = managerBehavior;
    }

    /**
     * ⚡ QUICK START: Create an enemy manager (most common use case)
     * 
     * This is the SIMPLEST way to add enemies to your game!
     * The manager auto-registers with NpcRegistry on first spawn, so updates
     * and disposal are handled automatically by the engine.
     * 
     * @param engine - Game engine reference
     * @param config - Optional enemy configuration
     * @param characterFactory - Optional custom character factory for appearance customization
     * @returns NpcManager configured for enemies (auto-respawn, projectile collision)
     */
    static createEnemy(
        engine: EngineLike,
        config?: {
            worldBounds?: number;
            retargetInterval?: number;
            autoRespawn?: boolean;
            respawnDelay?: number;
        },
        characterFactory?: CharacterFactory
    ): NpcManager {
        const manager = new NpcManager(engine, new NpcEnemyManagerBehavior(config));
        if (characterFactory) {
            manager.setCharacterFactory(characterFactory);
        }
        return manager;
    }

    /**
     * Spawn a NEW NPC character at specified position (ADDS to existing NPCs!)
     * 
     * ⚠️ Each call ADDS a new NPC - does NOT replace existing ones!
     * 
     * @param spawnX - Optional X coordinate (random if not provided)
     * @param spawnZ - Optional Z coordinate (random if not provided)
     * @param characterFactory - Optional custom character factory for appearance
     * @param retryCount - Internal retry counter (don't pass this manually)
     * @param spawnY - Optional interior spawn height (see NpcHandle.spawn)
     * @param positionAttempt - Internal counter of how many times this request has already
     *                          been re-queued for a position search (don't pass this manually)
     * @returns The unique ID of the spawned NPC
     */
    async spawnNpc(
        spawnX?: number,
        spawnZ?: number,
        characterFactory?: CharacterFactory,
        retryCount: number = 0,
        spawnY?: number,
        positionAttempt: number = 0
    ): Promise<string | null> {
        // Maximum retries: 20 attempts over 2 seconds (100ms intervals)
        const MAX_RETRIES = 20;
        const RETRY_DELAY_MS = 100;

        // Auto-register with the engine's NpcRegistry early so update() runs
        // even if prerequisites aren't ready yet (enables pendingSpawnRequests retry)
        this.autoRegisterWithRegistry();

        // Ensure a source skeleton is (being) loaded — for headless players this
        // is the only thing that ever makes the GLTF prerequisite become ready.
        this.requestNpcSkeleton();

        // Validate prerequisites with detailed error messages
        const validation = this.validateSpawnPrerequisites();
        if (!validation.ready) {
            this.spawnRequested = true; // Mark that spawn was requested

            if (retryCount < MAX_RETRIES) {
                // Retry inline after a delay — prerequisites might not be ready yet.
                //
                // CRITICAL: do NOT register this request in pendingSpawnRequests while
                // retrying inline. update() concurrently drains that queue every frame
                // (autoSpawnEnabled is on by default), so a request that lived there during
                // the sleep below could be spawned by update() AND again by this inline
                // recursion — two NPCs at the identical position, stacked on top of each
                // other. The request stays owned solely by this async chain until the
                // inline retries are exhausted.
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
                return this.spawnNpc(spawnX, spawnZ, characterFactory, retryCount + 1, spawnY, positionAttempt);
            }

            // Max inline retries reached — log diagnostics, then fall through to hand the
            // request off to update()'s auto-retry queue (just below). Don't throw.
            console.warn(
                `⚠️ [NpcManager] ${this.managerBehavior.getName()} spawn failed after ${MAX_RETRIES} attempts: ${validation.reason}\n` +
                `   Prerequisites required:\n` +
                `   - engine.scene must be initialized\n` +
                `   - engine.physicsWorld must be initialized\n` +
                `   - an NPC skeleton GLTF must be available (the player's own GLTF when one is\n` +
                `     loaded; otherwise a shared default rig loads on demand — no PlayerLoader needed)\n` +
                `   Will keep retrying automatically in update() loop until prerequisites are ready.\n` +
                `   Make sure you call spawnNpc() AFTER the game has fully loaded (in load() method, not constructor).`
            );

            // Inline retries exhausted — hand the request off to update()'s auto-retry
            // queue exactly once. Don't throw; the spawn will complete when prerequisites
            // become ready.
            this.pendingSpawnRequests.push({ x: spawnX, z: spawnZ, y: spawnY, factory: characterFactory });
            return null;
        }

        // Find valid spawn position
        const { position: spawnPosition, reason } = this.findSpawnPosition(spawnX, spawnZ, spawnY);
        if (!spawnPosition) {
            // Queue for retry next frame — findSpawnPosition drifts around the requested
            // coord, and on a freshly-loaded baked level the map colliders may not be
            // enabled yet (VoxelTerrainSystem enables them a few frames in), so a column
            // that fails now can succeed shortly.
            //
            // Two independent bounds, both needed:
            //  - queue length (100), so a wave spawn cannot grow the queue without limit;
            //  - per-request attempts, so a request aimed at a PERMANENTLY unspawnable
            //    column (a solid wall, a coord with no floor under spawnY) terminates with
            //    a diagnostic instead of cycling forever. Before this, such a request
            //    silently re-queued itself for the rest of the session and the NPC simply
            //    never appeared — the failure mode this whole path exists to make visible.
            const factoryToStore = characterFactory || this.characterFactory || undefined;
            if (positionAttempt >= NpcManager.MAX_POSITION_ATTEMPTS) {
                this.warnSpawnPositionUnresolvable(spawnX, spawnZ, spawnY, reason, `${NpcManager.MAX_POSITION_ATTEMPTS} attempts`);
            } else if (this.pendingPositionRetries.length < 100) {
                this.pendingPositionRetries.push({ x: spawnX, z: spawnZ, y: spawnY, factory: factoryToStore, attempt: positionAttempt + 1 });
            } else if (!this.warnedPositionRetriesFull) {
                // A full retry queue means position finding is failing persistently,
                // not transiently — without this warning the failure is invisible
                // (spawnNpc resolves null and nothing ever appears).
                this.warnedPositionRetriesFull = true;
                this.warnSpawnPositionUnresolvable(spawnX, spawnZ, spawnY, reason, 'a full (100-entry) retry queue');
            }
            return null;
        }

        // Create NPC at the validated position
        return this.createNpcAtPosition(spawnPosition, characterFactory);
    }

    /**
     * Per-request cap on position-search retries. update() drains one retry per frame, so a
     * lone request gets ~2s of wall clock — long enough for a baked level's map colliders to
     * come online — before we declare the requested column unspawnable.
     */
    private static readonly MAX_POSITION_ATTEMPTS = 120;

    /**
     * Terminal diagnostic for a spawn whose position search never succeeded. Names the
     * requested coordinates (including the interior `spawnY`, whose absence is itself a
     * common cause on roofed levels) and the rejection reason, so the failure is
     * actionable from the console alone rather than "the NPC just never appeared".
     */
    private warnSpawnPositionUnresolvable(
        spawnX: number | undefined,
        spawnZ: number | undefined,
        spawnY: number | undefined,
        reason: string,
        limit: string,
    ): void {
        const at = `(x=${spawnX?.toFixed(1) ?? 'random'}, z=${spawnZ?.toFixed(1) ?? 'random'}, ` +
            `y=${spawnY !== undefined ? spawnY.toFixed(1) : 'none — resolved top-down'})`;
        console.warn(
            `⚠️ [NpcManager] ${this.managerBehavior.getName()}: giving up on spawn at ${at} after ${limit}. ` +
            `Rejection reason: ${reason}. ` +
            `For an INDOOR spawn pass the room's walk height as y (handle.spawn(x, z, y)) so the floor is ` +
            `probed downward from inside the room; without it the topmost surface — the roof — wins. ` +
            `Otherwise the column is solid or has no standing room: try a coord nearer the room's centre.`
        );
    }
    
    /**
     * Auto-register this manager with the engine's NpcRegistry (if not already registered).
     * Uses the manager behavior name as the registry key.
     * This ensures all NpcManagers are discoverable by combat systems, health bars, etc.
     */
    private autoRegisterWithRegistry(): void {
        if (this.autoRegistered) return;
        
        const registry = this.engine.getNpcRegistry?.();
        if (!registry) return;
        
        const name = this.managerBehavior.getName().toLowerCase().replace(/\s+/g, '_');
        if (!registry.has(name)) {
            registry.register(name, this);
        }
        this.autoRegistered = true;
    }

    /**
     * Spawn multiple NPCs at once
     * 
     * @param count - Number of NPCs to spawn
     * @param positions - Optional array of {x, z} positions. If fewer than count, remaining use random positions.
     * @param characterFactory - Optional custom character factory for all spawned NPCs
     * @returns Array of spawned NPC IDs
     */
    async spawnMany(
        count: number,
        positions?: Array<{ x: number; z: number }>,
        characterFactory?: CharacterFactory
    ): Promise<string[]> {
        const promises: Promise<string | null>[] = [];
        for (let i = 0; i < count; i++) {
            const pos = positions?.[i];
            promises.push(this.spawnNpc(pos?.x, pos?.z, characterFactory));
        }
        const results = await Promise.all(promises);
        return results.filter((id): id is string => id !== null);
    }

    /**
     * Ensure at least one NPC is spawned - keeps trying until successful
     * 
     * @param spawnX - Optional X coordinate
     * @param spawnZ - Optional Z coordinate
     * @param characterFactory - Optional custom character factory
     */
    async ensureSpawned(
        spawnX?: number,
        spawnZ?: number,
        characterFactory?: CharacterFactory
    ): Promise<void> {
        // If we already have NPCs, we're done
        if (this.npcControllers.size > 0) {
            return;
        }

        // Try spawning immediately
        try {
            await this.spawnNpc(spawnX, spawnZ, characterFactory);
        } catch {
            // Spawn queued — update() retries automatically when prerequisites are ready.
        }
    }

    /**
     * Disable automatic retry spawning
     */
    setAutoSpawnEnabled(enabled: boolean): void {
        this.autoSpawnEnabled = enabled;
        if (!enabled) {
            this.pendingSpawnRequests = [];
        }
    }

    /**
     * Validate that all prerequisites for spawning are met
     */
    private validateSpawnPrerequisites(): { ready: boolean; reason: string } {
        if (!this.engine.scene) {
            return { ready: false, reason: 'engine.scene is not initialized' };
        }
        if (!queryPhysicsFor(this.engine)) {
            return { ready: false, reason: 'engine.physicsWorld is not initialized' };
        }
        const skeletonGLTF = this.getNpcSkeletonGLTF();
        if (!skeletonGLTF) {
            // Games without a loaded player GLTF (hasPlayerCharacter:false, or a
            // game that never constructs a PlayerLoader at all) rely on the
            // engine's NpcSkeletonSource: requestNpcSkeleton() lazily loads a
            // shared default skeleton, so this resolves on a later retry instead
            // of blocking NPC spawns forever.
            return { ready: false, reason: 'NPC skeleton GLTF not yet loaded' };
        }
        return { ready: true, reason: 'All prerequisites met' };
    }

    /**
     * GLTF used as the source skeleton when cloning humanoid NPCs: the player's
     * own GLTF when one is loaded, otherwise the engine's shared, lazily-loaded
     * default rig (see NpcSkeletonSource — no PlayerLoader required).
     */
    private getNpcSkeletonGLTF(): unknown {
        return getNpcSkeletonSource(this.engine).getSkeletonGLTF();
    }

    /**
     * Source GLTF for cloning an NPC's visual/skeleton. Uses this manager's custom
     * character GLB (npcCharacterUrl) when set — loaded once and cached — otherwise the
     * shared default skeleton. Falls back to the default if the custom load fails.
     */
    private async resolveNpcSourceGLTF(): Promise<unknown> {
        if (!this.npcCharacterUrl) {
            return this.getNpcSkeletonGLTF();
        }
        if (this.npcCharacterGLTF) {
            return this.npcCharacterGLTF;
        }
        if (!this.engine.loader) {
            return this.getNpcSkeletonGLTF();
        }
        if (!this.npcCharacterLoadPromise) {
            const url = this.npcCharacterUrl;
            const loader = this.engine.loader;
            // Routed, not loaded directly: an NPC character may be a GLB or a
            // rigged `.vxl`, and `loadCharacterModel` is the one place that knows
            // which. Both come back in the same shape, so everything downstream —
            // the SkeletonUtils clone, the block proxy, the height measure — is
            // unchanged.
            // The device tier decides how fine an NPC body is built (see
            // DeviceQualityPolicy.deferred.characterBodyLod); the player keeps full detail.
            const bodyLod = activeQualityPolicy().deferred.characterBodyLod;
            this.npcCharacterLoadPromise = loadCharacterModel(loader, url, { bodyLod })
                .then((model) => { this.npcCharacterGLTF = model; return model as unknown; })
                .catch((err: unknown) => {
                    console.error(`NpcManager: failed to load custom NPC character ${url}, using default skeleton`, err);
                    this.npcCharacterLoadPromise = null; // allow a later retry
                    return this.getNpcSkeletonGLTF();
                });
        }
        return this.npcCharacterLoadPromise;
    }

    /**
     * Ensure an NPC skeleton GLTF is (being) loaded. No-op for visible-character
     * games where the player GLTF already serves as the skeleton; triggers a
     * one-time background load of the shared default rig otherwise.
     */
    private requestNpcSkeleton(): void {
        getNpcSkeletonSource(this.engine).ensureLoaded();
    }

    /**
     * Despawn a specific NPC by ID, or ALL NPCs if no ID provided
     * 
     * @param npcId - Optional ID of NPC to despawn. If omitted, despawns ALL NPCs.
     */
    despawnNpc(npcId?: string): void {
        if (npcId) {
            this.destroyNpc(npcId);
            return;
        }
        for (const id of [...this.npcControllers.keys()]) {
            this.destroyNpc(id);
        }
    }

    /**
     * Tear down a single NPC: notify behavior, unregister from systems, dispose,
     * and clear all per-NPC bookkeeping. Returns false if the id was unknown.
     */
    private destroyNpc(npcId: string): boolean {
        const controller = this.npcControllers.get(npcId);
        if (!controller) return false;
        this.managerBehavior.onNpcDestroyed?.(controller, this.engine);
        this.engine.getDynamicObjectManager?.()?.unregister(controller);
        controller.dispose();
        this.npcControllers.delete(npcId);
        this.npcSpawnPositions.delete(npcId);
        this.respawnTimers.delete(npcId);
        this.respawningNpcs.delete(npcId);
        return true;
    }

    /**
     * Toggle spawn/despawn (spawns one if empty, despawns all if any exist)
     */
    async toggleNpc(spawnX?: number, spawnZ?: number): Promise<void> {
        if (this.npcControllers.size > 0) {
            this.despawnNpc(); // Despawn all
        } else {
            await this.spawnNpc(spawnX, spawnZ);
        }
    }

    /**
     * Advance the global frame counter. Called once per frame by NpcRegistry.updateAll().
     * This enables frame-idempotent updates so double-calling update() is harmless.
     */
    static advanceFrame(): void {
        NpcManager.globalFrameCounter++;
    }

    /**
     * Update ALL NPCs managed by this manager.
     *
     * Called automatically by NpcRegistry.updateAll() — you do NOT need to call this manually.
     * If called multiple times in the same frame (e.g., by both NpcRegistry and manual code),
     * subsequent calls are silently skipped (frame-idempotent).
     *
     * @param deltaTime - Time since last frame in seconds
     */
    update(deltaTime: number): void {
        // Frame-idempotent: skip if already updated this frame (prevents double-update
        // when both NpcRegistry.updateAll() and manual update() calls coexist)
        if (this.lastUpdateFrame === NpcManager.globalFrameCounter) {
            return;
        }
        this.lastUpdateFrame = NpcManager.globalFrameCounter;

        // Handle pending spawn requests (auto-retry when prerequisites ready)
        if (this.autoSpawnEnabled && this.pendingSpawnRequests.length > 0) {
            const timeSinceLastAttempt = Date.now() - this.lastSpawnAttemptTime;
            if (timeSinceLastAttempt > 500) {
                this.lastSpawnAttemptTime = Date.now();
                const validation = this.validateSpawnPrerequisites();
                if (validation.ready) {
                    const pending = [...this.pendingSpawnRequests];
                    this.pendingSpawnRequests = [];
                    for (const req of pending) {
                        this.spawnNpc(req.x, req.z, req.factory, 0, req.y).catch(() => { /* auto-retry spawn failed */ });
                    }
                }
            }
        }

        // Handle pending position retries - try ONE per frame with new random position
        // This handles spawns that failed because no valid terrain position was found
        if (this.pendingPositionRetries.length > 0) {
            const retry = this.pendingPositionRetries.shift();
            if (retry) {
                // Retry with the originally-requested coords. findSpawnPosition drifts within a
                // bounded radius if the exact voxel is still occupied; if no coords were given
                // originally (wave spawn) it draws another worldwide random sample. `attempt`
                // rides along so the per-request cap survives the round trip through the queue.
                this.spawnNpc(retry.x, retry.z, retry.factory, 0, retry.y, retry.attempt).catch(() => { /* position retry spawn failed */ });
            }
        }

        // Update ALL NPCs
        const npcsToRemove: string[] = [];
        const dynamicObjMgr = this.engine.getDynamicObjectManager?.();
        
        for (const [npcId, controller] of this.npcControllers.entries()) {
            // Skip hibernating NPCs - they don't need updates (major performance optimization)
            if (controller.isHibernating()) continue;
            
            controller.update(deltaTime);
            
            // Update chunk registration so the NPC stays in the correct
            // chunk as it moves (prevents incorrect hibernation)
            dynamicObjMgr?.updatePosition(controller);

            // Let manager behavior handle update logic
            const shouldRespawn = this.managerBehavior.onNpcUpdated(
                controller,
                deltaTime,
                this.engine
            );

            // Check if NPC should respawn
            if (shouldRespawn && this.managerBehavior.shouldAutoRespawn() && !this.respawningNpcs.has(npcId)) {
                this.respawningNpcs.add(npcId);
                this.respawnTimers.set(npcId, this.managerBehavior.getRespawnDelay());
            }
            
            // Check if NPC fell off the world and should be destroyed (not respawned)
            if (controller.hasFallenOffWorld() && !this.managerBehavior.shouldAutoRespawn()) {
                npcsToRemove.push(npcId);
            }
        }

        // Handle respawn timers
        for (const [npcId, timer] of this.respawnTimers.entries()) {
            const newTimer = timer - deltaTime;
            if (newTimer > 0) {
                this.respawnTimers.set(npcId, newTimer);
                continue;
            }

            // Timer elapsed — replace the old NPC with a fresh one at the same position
            this.respawnTimers.delete(npcId);
            this.respawningNpcs.delete(npcId);

            const spawnPos = this.npcSpawnPositions.get(npcId);
            const oldController = this.npcControllers.get(npcId);
            if (oldController) {
                oldController.dispose();
                this.npcControllers.delete(npcId);
            }

            this.spawnNpc(spawnPos?.x, spawnPos?.z, this.characterFactory || undefined).catch(() => { /* respawn failed */ });
        }
        
        // Clean up removed NPCs (fallen off world, no respawn)
        for (const id of npcsToRemove) {
            this.destroyNpc(id);
        }
        
        // Update all projectiles via central manager (handles cleanup, continues flying even if NPC dies)
        if (ProjectileManager.hasInstance()) {
            const manager = ProjectileManager.getInstance();
            // Set physics world for batch collision detection (if available)
            const projectilePhysics = queryPhysicsFor(this.engine);
            if (projectilePhysics) {
                manager.setPhysicsWorld(projectilePhysics);
            }
            manager.update(deltaTime);
        }
    }

    /**
     * Bumped every time an NPC is added to this manager. NpcRegistry compares it
     * per frame instead of re-keying every NPC: with 500 townsfolk that scan —
     * an array, a template string and a Set probe per NPC per frame — was 1.5%
     * of the frame for nothing.
     */
    getRosterGeneration(): number {
        return this.rosterGeneration;
    }

    /**
     * Check if any NPCs are currently spawned
     */
    isActive(): boolean {
        return this.npcControllers.size > 0;
    }

    /**
     * Get a specific NPC by ID, or the first NPC if no ID provided
     * 
     * @param npcId - Optional ID of specific NPC to get
     */
    getNpc(npcId?: string): NpcController | null {
        if (npcId) {
            return this.npcControllers.get(npcId) || null;
        }
        // Return first NPC if no ID specified
        const first = this.npcControllers.values().next();
        return first.done ? null : first.value;
    }
    
    /**
     * Get ALL NPC controllers
     */
    getAllNpcs(): NpcController[] {
        return Array.from(this.npcControllers.values());
    }

    /**
     * Request respawn of an NPC after a delay.
     * Call this from onDeathEffect callback to respawn NPCs on demand.
     * 
     * @param npcId - ID of the NPC to respawn
     * @param delay - Delay in seconds before respawning (default: 5.0)
     */
    requestRespawn(npcId: string, delay: number = 5.0): void {
        if (!this.npcSpawnPositions.has(npcId)) {
            return;
        }
        if (this.respawningNpcs.has(npcId)) {
            return;
        }

        this.respawningNpcs.add(npcId);
        this.respawnTimers.set(npcId, delay);
    }
    
    /**
     * Get count of spawned NPCs
     */
    getCount(): number {
        return this.npcControllers.size;
    }
    
    /**
     * Get the name/type of NPCs managed by this manager
     */
    getName(): string {
        return this.managerBehavior.getName();
    }
    
    /**
     * Iterate over all NPCs (for custom operations)
     */
    forEach(callback: (npc: NpcController, id: string) => void): void {
        for (const [id, npc] of this.npcControllers.entries()) {
            callback(npc, id);
        }
    }

    /**
     * Change the manager behavior at runtime
     */
    setManagerBehavior(behavior: INpcManagerBehavior): void {
        this.managerBehavior = behavior;
        
        // Reconfigure all existing NPCs with new behavior
        for (const controller of this.npcControllers.values()) {
            this.managerBehavior.onNpcCreated(controller, this.engine);
        }
    }

    /**
     * Set character factory for all NPCs spawned by this manager
     */
    setCharacterFactory(factory: CharacterFactory): void {
        this.characterFactory = factory;
    }

    /**
     * Set a custom character GLB URL for every NPC this manager spawns (e.g. an Asset Forger
     * generated character from the generate_character tool). It's a drop-in humanoid GLB rigged
     * on the standard skeleton; loaded once and cached. Pass null/'' to revert to the default.
     */
    setNpcCharacterUrl(url: string | null): void {
        const next = url || null;
        if (next !== this.npcCharacterUrl) {
            this.npcCharacterUrl = next;
            this.npcCharacterGLTF = null;
            this.npcCharacterLoadPromise = null;
        }
    }

    /**
     * Yaw correction (radians) applied to the visible skinned mesh of NPCs this
     * manager spawns, for custom character GLBs authored facing the wrong way.
     */
    /** Eye colours applied to every NPC this manager spawns (`registerNpc({ eyeLook })`). */
    setNpcEyeLook(look: VxlEyeLook): void {
        this.npcEyeLook = look;
        this.npcControllers.forEach((npc) => this.applyEyeLook(npc));
    }

    /** Warned once per manager: a look that cannot land is otherwise silent. */
    private eyeLookWarned = false;

    /**
     * A look that does not apply means the character has no runtime eyes — a
     * GLB, or a `.vxl` older than v11 whose eyes are baked voxels. Nothing in
     * the engine can recolour those; the asset needs re-forging. Said once.
     */
    private applyEyeLook(npc: NpcController): void {
        if (!this.npcEyeLook || npc.setEyeLook(this.npcEyeLook) || this.eyeLookWarned) return;
        this.eyeLookWarned = true;
        console.warn(`[NpcManager] "${this.managerBehavior.getName()}" has an eyeLook but its character carries no eye metadata `
            + `(a GLB, or a .vxl older than v11 with baked eye voxels) — the look cannot apply; re-forge the character.`);
    }

    setNpcModelRotationY(rotationY: number): void {
        this.npcModelRotationY = rotationY;
    }

    /**
     * Health/death tuning for every NPC this manager spawns (maxHealth, canDie,
     * ragdollOnDeath, …). Applied at construction; unset fields fall back to
     * DEFAULT_DAMAGEABLE_CONFIG. Set before the first spawn — NPCs already
     * spawned keep the config they were built with.
     */
    setDamageableConfig(config: Partial<DamageableConfig>): void {
        this.damageableConfig = config;
    }
    
    /**
     * Set the simulation importance tier for every NPC this manager spawns.
     * Propagates to already-spawned controllers so runtime re-tiering applies immediately.
     */
    setImportance(importance: 'hero' | 'crowd'): void {
        this.importance = importance;
        for (const controller of this.npcControllers.values()) {
            controller.setImportance(importance);
        }
    }

    /** Keep (or stop keeping) every NPC of this manager on the side-on gameplay plane. */
    setPlaneLockEnabled(enabled: boolean): void {
        this.planeLockEnabled = enabled;
        for (const controller of this.npcControllers.values()) {
            controller.setPlaneLockEnabled(enabled);
        }
    }

    /** Simulation importance tier for NPCs this manager spawns (default 'hero'). */
    getImportance(): 'hero' | 'crowd' {
        // Unmarked means CHEAP. The old default was 'hero' — full simulation
        // fidelity at any distance — so an author who never thought about scale
        // got the most expensive tier for every NPC, and getting the cheap one
        // required predicting how many NPCs the game would eventually have.
        // 'crowd' scales itself; 'hero' is now an explicit opt-in for the
        // gameplay-critical few (bosses, quest givers, escorts), which is a
        // question about the NPC rather than a guess about the game's future.
        return this.importance ?? 'crowd';
    }

    /**
     * Skip the automatic loadAllAnimationAssets() call during spawnNpc().
     * Use when you will load only the specific animations each NPC needs
     * (avoids loading every animation in world.json for every NPC).
     */
    setSkipAutoAnimationLoading(skip: boolean): void {
        this._skipAutoAnimationLoading = skip;
    }
    
    /**
     * Set the voxel block size for step climbing on all NPCs
     * Call this after setting up the world generator to use the level's voxel size
     */
    setVoxelBlockSize(size: number): void {
        this._voxelBlockSize = size;
        // Apply to all existing NPCs
        for (const npc of this.npcControllers.values()) {
            npc.voxelBlockSize = size;
        }
    }

    // ============================================================================
    // Object-Relative Spawning
    // ============================================================================

    /**
     * Spawn an NPC relative to an existing object using spatial relations.
     *
     * This method allows spawning NPCs at positions like "on top of tower" or
     * "in front of gate" by specifying the target object and spatial relation.
     *
     * If the target position is invalid (no surface, blocked, etc.), the system
     * will automatically find the nearest valid position.
     *
     * @param options - Spawn options including objectId and relation
     * @returns Promise resolving to NPC ID, or empty string if spawning failed
     */
    async spawnNpcRelativeTo(options: SpawnNpcRelativeOptions): Promise<string> {
        const { objectId, relation, customPosition, offset, side, distance, characterFactory } = options;

        // Get object transform from ObjectIdService
        const idService = getObjectIdService();
        const transform = idService.getObjectTransform(objectId);

        if (!transform) {
            return (await this.spawnNpc(undefined, undefined, characterFactory)) ?? '';
        }

        // Create spawner for position calculations
        const spawner = new Spawner(this.engine);

        // Calculate target position based on relation or custom function
        const relativeOptions: RelativeSpawnOptions = {
            relation,
            customPosition,
            offset,
            side,
            distance,
        };
        const targetPosition = spawner.calculateRelativePosition(transform, relativeOptions);

        // Apply ground detection for built-in relations only. Custom positions keep the
        // computed position as-is (the caller controls Y explicitly), and so does the
        // fallback case where neither relation nor customPosition was provided.
        const validPosition = relation && !customPosition
            ? spawner.validateAndAdjustPosition(targetPosition, relation)
            : targetPosition;

        if (!validPosition) {
            return (await this.spawnNpc(undefined, undefined, characterFactory)) ?? '';
        }

        // Spawn NPC at the validated position using internal spawn method
        return this.spawnNpcAtPosition(validPosition, characterFactory);
    }

    /**
     * Internal method to spawn NPC at a specific position (bypasses ground detection)
     * Used by spawnNpcRelativeTo after position has been validated
     */
    private async spawnNpcAtPosition(
        position: THREE.Vector3,
        characterFactory?: CharacterFactory
    ): Promise<string> {
        // Ensure a source skeleton is (being) loaded before validating (headless players).
        this.requestNpcSkeleton();

        // Validate prerequisites with retry
        const validationResult = this.validateSpawnPrerequisites();
        if (!validationResult.ready) {
            // Queue the spawn for retry. Keep the Y so an interior position
            // (inside a roofed room) re-resolves from the room height instead
            // of the roof when the queue drains through spawnNpc().
            this.pendingSpawnRequests.push({ x: position.x, z: position.z, y: position.y, factory: characterFactory });
            return '';
        }

        return this.createNpcAtPosition(position, characterFactory);
    }

    /**
     * Shared NPC creation logic used by both spawnNpc and spawnNpcAtPosition.
     * Prerequisites must be validated before calling this method.
     */
    private async createNpcAtPosition(
        position: THREE.Vector3,
        characterFactory?: CharacterFactory
    ): Promise<string> {
        const npcTypeName = this.managerBehavior.getName();
        const scene = this.engine.scene!;
        // 3D world, or the 2D world through its plane-locked facade (validateSpawnPrerequisites checked it).
        const physicsWorld = queryPhysicsFor(this.engine)!;
        const playerGLTF = await this.resolveNpcSourceGLTF();

        // Get baseAnimations - NPCs load animations dynamically just like the player
        const baseAnimations = this.getBaseAnimations();

        // Resolve character factory
        const factoryToUse = characterFactory || this.characterFactory;
        if (factoryToUse) {
            this.characterFactory = factoryToUse;
        }
        const characterCreator = this.resolveCharacterCreator(factoryToUse);

        // Generate unique ID
        const idCounter = NpcManager.idCounters.get(npcTypeName) || 0;
        const nextId = idCounter + 1;
        NpcManager.idCounters.set(npcTypeName, nextId);
        const typeNameFormatted = npcTypeName.charAt(0).toUpperCase() + npcTypeName.slice(1).toLowerCase();
        const npcId = `${typeNameFormatted}Npc${nextId}`;

        // Create NPC controller
        const npcController = await NpcController.create(
            scene,
            physicsWorld,
            this.engine,
            position,
            playerGLTF,
            characterCreator,
            2.0, // moveSpeed
            3.0, // stunDuration (ignored — stun-on-hit was removed)
            baseAnimations,
            undefined,
            npcId,
            // Render the actual GLB skinned mesh (not the procedural blocks)
            // only when this manager has a custom Asset-Forger character URL.
            this.npcCharacterUrl != null,
            // Facing correction for a backward-authored custom character GLB.
            this.npcModelRotationY,
            // Health/death tuning from registerNpc({ damageable }); undefined = engine defaults.
            this.damageableConfig
        );

        npcController.setImportance(this.getImportance());
        npcController.setPlaneLockEnabled(this.planeLockEnabled);
        if (this.npcEyeLook) this.applyEyeLook(npcController);

        // Register NPC
        this.npcControllers.set(npcId, npcController);
        this.rosterGeneration++;
        this.npcSpawnPositions.set(npcId, position.clone());
        this.engine.getDynamicObjectManager?.()?.register(npcController, 'npc');
        // Register with the character LOD scheduler (stamps lodState per frame;
        // the controller unregisters itself in dispose()).
        getGlobalLodScheduler().registerCharacter(npcController);
        // Join the crowd so the solver keeps this NPC from standing inside its
        // neighbours. Registration is unconditional — the solver skips inactive
        // members at gather time, so a hibernating horde costs nothing.
        getGlobalCrowd().add(npcController);

        if (npcController.voxelBlockSize === 1.0) {
            npcController.voxelBlockSize = this._voxelBlockSize;
        }

        this.managerBehavior.onNpcCreated(npcController, this.engine);
        this.spawnRequested = true;

        if (!this._skipAutoAnimationLoading) {
            const animController = npcController.getAnimationController();
            if (animController?.loadAllAnimationAssets) {
                await animController.loadAllAnimationAssets({ normalizeRootMotion: true, loop: false }).catch(() => { /* animation asset load failed */ });
            }
        }

        return npcId;
    }

    /**
     * Get baseAnimations from world profile or default to core animations
     */
    private getBaseAnimations(): unknown[] {
        const genreModule = this.engine.genreModule as { worldProfile?: { baseAnimations?: unknown[] } } | null;
        const engineWithLoader = this.engine as { playerLoader?: { worldProfileData?: { baseAnimations?: unknown[] } } };

        // Both legacy routes to the world profile, in priority order.
        const fromWorldProfile = [
            genreModule?.worldProfile?.baseAnimations,
            engineWithLoader.playerLoader?.worldProfileData?.baseAnimations,
        ].find(animations => animations !== undefined && animations.length > 0);

        return fromWorldProfile ?? buildAnimationList();
    }

    /**
     * Resolve character creator function from factory
     */
    private resolveCharacterCreator(
        factory: CharacterFactory | null
    ): (characterGroup: THREE.Group) => CharacterDimensions {
        if (!factory) return createExampleEnemyCharacter;
        if (typeof factory === 'function') return factory;
        return (characterGroup: THREE.Group) => {
            factory.createBlockCharacter(characterGroup);
            return factory.getCharacterDimensions();
        };
    }

    /**
     * Find a valid spawn position for an NPC.
     *
     * @param spawnY Optional interior spawn height: the floor is resolved by
     *               scanning DOWN from this height (via the voxel finder's
     *               fromY), so NPCs can spawn inside roofed rooms. Without it
     *               the topmost surface wins — the roof, for enclosed spaces.
     * @returns The position, or null with a short machine-readable `reason`
     *          describing which stage rejected the column (surfaced verbatim in
     *          the terminal warning when the retries run out).
     */
    private findSpawnPosition(spawnX?: number, spawnZ?: number, spawnY?: number): { position: THREE.Vector3 | null; reason: string } {
        const gameData = this.engine.getGameData?.();
        const worldSizeX = gameData?.worldProfileData?.groundWorldSizeX ?? 100;
        const worldSizeZ = gameData?.worldProfileData?.groundWorldSizeZ ?? 100;
        // Baked (.vwld) levels are corner-origin (content in [0, size]); procedural worlds are
        // centred on the origin. Pass origin 0 for baked levels so the spawn clamp covers the
        // real coordinate range instead of collapsing valid coords into a corner. (worldSize is
        // grown to the level footprint at load — see syncGroundWorldSizeToBakedLevel.)
        const isBakedLevel = Boolean(gameData?.worldProfileData?.voxelUrl);
        const bakedOrigin = isBakedLevel ? 0 : undefined;

        if (this.engine.findValidVoxelSpawnPosition) {
            const voxelFinder = this.engine.findValidVoxelSpawnPosition;
            const validate = spawnY !== undefined
                ? (x: number, z: number) => voxelFinder(x, z, spawnY)
                : voxelFinder;
            const voxelPos = findValidatedSpawnPosition(worldSizeX, worldSizeZ, spawnX, spawnZ, validate, bakedOrigin, bakedOrigin);
            if (voxelPos) return { position: voxelPos, reason: '' };
            // The voxel finder returns null for EVERY column on a baked (.vwld) World-Forger level —
            // it has no voxel grid to query — so NPCs would never spawn there. A genre whose
            // WorldGenerator handles baked levels won't reach this; older per-game snapshots will, so
            // this engine-level fallback (shared by every game) fixes them all without a re-create.
            // Gated on a baked level (voxelUrl) so PROCEDURAL worlds still honour a genuine
            // "no open position" found above — we must not start spawning NPCs on rooftops there.
            if (!isBakedLevel) return { position: null, reason: 'voxel-grid-rejected' };

            // Search again with the SHARED gridless finder (bakedSpawnResolver) — the same code
            // mesh levels and v2-octree maps install as findValidVoxelSpawnPosition. It raycasts
            // the baked colliders for the floor, keeps NPCs off building/prop tops, requires
            // standing room, and with spawnY probes DOWN in a bounded window so a roofed room
            // resolves to its OWN floor rather than the roof. Used directly here instead of
            // overwriting engine.findValidVoxelSpawnPosition: replacing a game's hook would
            // change spawning for every other system that reads it.
            const physicsPos = findValidatedSpawnPosition(
                worldSizeX, worldSizeZ, spawnX, spawnZ,
                (x, z) => this.getPhysicsSpawnFinder()(x, z, spawnY),
                bakedOrigin, bakedOrigin,
            );
            if (physicsPos) return { position: physicsPos, reason: '' };

            // Last resort: the Spawner's CollisionMask.ALL raycasts, which also see levels whose
            // colliders landed on neither the TERRAIN nor the ENVIRONMENT group (the only ones the
            // shared finder queries). Games that never installed a Spawner (engine.setSpawner is
            // genre/template wiring, and e.g. the no-character starter has no reason to) get an
            // engine-owned one, so this path is never hostage to optional game-side wiring.
            const spawner = this.engine.getSpawner?.() ?? this.getFallbackSpawner();
            const spawnerPos = findValidatedSpawnPosition(worldSizeX, worldSizeZ, spawnX, spawnZ, (x, z) => {
                // An explicit spawnY is an INTERIOR height — NpcHandle.spawn(x, z, y)
                // promises "the room's floor instead of the roof". The sky-down
                // getGroundHeight()/isOpenArea() pair resolves enclosed spaces to
                // their ROOF, which left dungeon enemies standing on top of the
                // building — so with spawnY, probe the storey below it instead.
                const groundY = spawnY !== undefined
                    ? spawner.getGroundHeightBelow(x, z, spawnY)
                    : spawner.getGroundHeight(x, z);
                if (groundY === null) return null;
                const open = spawnY !== undefined
                    ? spawner.isOpenAreaAtHeight(x, z, groundY)
                    : spawner.isOpenArea(x, z);
                return open ? new THREE.Vector3(x, groundY, z) : null;
            }, bakedOrigin, bakedOrigin);
            if (spawnerPos) return { position: spawnerPos, reason: '' };
            return {
                position: null,
                reason: spawnY !== undefined
                    ? 'no-interior-floor-below-spawnY'
                    : 'no-open-floor-on-baked-level',
            };
        }

        const halfWorldX = worldSizeX / 2;
        const halfWorldZ = worldSizeZ / 2;
        const rawX = spawnX ?? Math.random() * worldSizeX - halfWorldX;
        const rawZ = spawnZ ?? Math.random() * worldSizeZ - halfWorldZ;
        const snappedX = Math.floor(rawX) + 0.5;
        const snappedZ = Math.floor(rawZ) + 0.5;

        if (this.engine.getWorldHeightAt) {
            return { position: new THREE.Vector3(snappedX, this.engine.getWorldHeightAt(snappedX, snappedZ), snappedZ), reason: '' };
        }
        return { position: new THREE.Vector3(snappedX, 0, snappedZ), reason: '' };
    }

    /**
     * The shared gridless spawn finder, built once per manager against the level's
     * terrain bounds. Engine-owned: it never touches
     * `engine.findValidVoxelSpawnPosition`, so a game's own hook stays intact.
     */
    private getPhysicsSpawnFinder(): (x: number, z: number, fromY?: number) => THREE.Vector3 | null {
        this.physicsSpawnFinder ??= createPhysicsSpawnFinder(
            this.engine,
            this.engine.getDynamicObjectManager?.()?.getTerrainBounds() ?? null,
            { requireHeadroom: true },
        );
        return this.physicsSpawnFinder;
    }

    /**
     * Engine-owned Spawner for the baked-level ground search when the game never
     * called engine.setSpawner. Spawner only needs the engine (physics raycasts),
     * so a private instance is equivalent to the genre-installed one.
     */
    private getFallbackSpawner(): Spawner {
        this.fallbackSpawner ??= new Spawner(this.engine);
        return this.fallbackSpawner;
    }

    /**
     * Dispose of manager and ALL NPCs
     */
    dispose(): void {
        this.despawnNpc(); // Despawns all
        this.disposeCharacterTemplate();
        this.spawnRequested = false;
        this.characterFactory = null;
        this.pendingSpawnRequests = [];
    }

    /**
     * Free this manager's own character template.
     *
     * The NPCs cloned from it deliberately do NOT free it — they share its geometry and
     * materials by reference, so an instance that disposed them would pull the buffers out
     * from under its siblings (see SharedCharacterResources). That makes the manager the
     * owner, and this the one place the template is released: at the end of the manager's
     * life, when the last NPC built from it is already gone.
     *
     * Only a custom character (`registerNpc({ characterUrl })`) is ours to free. The default
     * skeleton is shared across every manager in the game and is never disposed here.
     */
    private disposeCharacterTemplate(): void {
        const template = this.npcCharacterGLTF as { scene?: THREE.Object3D } | null;
        this.npcCharacterGLTF = null;
        this.npcCharacterLoadPromise = null;
        if (!this.npcCharacterUrl || !template?.scene) return;
        template.scene.traverse((object: THREE.Object3D) => {
            const mesh = object as THREE.Mesh;
            if (!mesh.isMesh) return;
            mesh.geometry?.dispose();
            const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
            for (const material of materials) material.dispose();
        });
    }

    /**
     * Validation helper for debugging
     */
    validateSetup(): { valid: boolean; issues: string[] } {
        const issues: string[] = [];

        if (!this.managerBehavior) {
            issues.push('Manager behavior is missing');
        }
        if (!this.engine) {
            issues.push('Engine reference is missing');
        }
        if (this.spawnRequested) {
            const validation = this.validateSpawnPrerequisites();
            if (!validation.ready) {
                issues.push(`Spawn prerequisites not met: ${validation.reason}`);
            }
        }

        return { valid: issues.length === 0, issues };
    }
}

