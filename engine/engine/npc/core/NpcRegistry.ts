import { NpcManager } from 'engine/npc/core/NpcManager.js';
import type { VxlEyeLook } from 'engine/loaders/VxlCharacterEyes.js';
import type { NpcController } from 'engine/npc/core/NpcController.js';
import { getGlobalLodScheduler, disposeGlobalLodScheduler } from 'engine/character/CharacterLodScheduler.js';
import { disposeGlobalPathQueue } from 'engine/npc/nav/PathRequestQueue.js';
import { disposeGlobalGoalFields } from 'engine/npc/nav/GoalField.js';
import { clearBlockPartCaches } from 'engine/npc/customization/blockPartCaches.js';
import type { EngineLike } from 'types/game.js';
import type { INpcManagerBehavior } from 'engine/npc/INpcManagerBehavior.js';
import type { IBlockCharacterFactory } from 'engine/IBlockCharacterFactory.js';
import type { DamageableConfig } from 'engine/IDamageable.js';
import type { SpawnRelation, CustomPositionFn } from 'engine/Spawner.js';
import { getGameEventLog } from 'engine/recording/GameEventLog.js';
import * as THREE from 'three';

/**
 * Callback signature for NPC death events
 * @param npcId - The registry ID of the NPC that died
 * @param npcType - The type/name of the NPC
 * @param position - The world position where the NPC died
 */
export type NpcDeathCallback = (npcId: string, npcType: string, position: THREE.Vector3) => void;

/**
 * Object-relative spawn configuration
 */
export interface RelativeSpawnConfig {
    /** ID of the object to spawn relative to */
    objectId: string;
    /** Spatial relation to the object (use this OR customPosition) */
    relation?: SpawnRelation;
    /** Custom position calculator function (use this OR relation) - for extensibility beyond built-in relations */
    customPosition?: CustomPositionFn;
    /** Fine-tuning offset */
    offset?: { x?: number; y?: number; z?: number };
    /** For BESIDE relation: which side */
    side?: 'left' | 'right';
    /** Distance from object */
    distance?: number;
}

/**
 * Options for engine.registerNpc() — the simplified NPC API for templates and agents.
 */
export interface RegisterNpcOptions {
    /** Character appearance factory (e.g. createWizardNpcFactory()) */
    characterFactory?: IBlockCharacterFactory | ((characterGroup: THREE.Group) => { width: number; height: number; depth: number });
    /**
     * Custom character GLB URL for every NPC of this type — a rigged voxel character from the
     * `generate_character` tool (Asset Forger). Drop-in humanoid on the standard skeleton; it
     * animates like the player. Overrides the default character for these NPCs.
     */
    characterUrl?: string;
    /**
     * Asset id of a `kind: 'character'` entry in world.json assets[] — resolved to its GLB url
     * at registration time. Preferred over characterUrl when the asset was generated under a
     * pre-minted id, so code can reference the character before generation finishes.
     * Ignored when characterUrl is also set.
     */
    characterAssetId?: string;
    /**
     * Optional yaw correction (radians) for a custom character GLB that is authored
     * facing the wrong way and renders backward. Applied to the visible skinned mesh
     * at load time (no effect on block-rendered NPCs). `Math.PI` flips a back-to-front
     * asset around. Mirrors the player's `worldProfileData.characterModelRotationY`.
     */
    characterModelRotationY?: number;
    /**
     * Eye colours for every NPC of this type — the manual override of the
     * look a rigged voxel character's eye record implies. `EVIL_VXL_EYE_LOOK`
     * (black eyes, glowing red pupils) marks a monster; build your own from
     * `DEFAULT_VXL_EYE_LOOK`. No effect on a character without eye metadata.
     */
    eyeLook?: VxlEyeLook;
    /** Whether NPC should respawn when destroyed (default: false) */
    autoRespawn?: boolean;
    /**
     * Simulation importance tier. 'crowd' (default): the engine scales AI/animation/
     * physics with distance and visibility, and hibernates far NPCs that are pursuing
     * nothing — pedestrians, fillers, hordes, ordinary enemies. 'hero': full
     * simulation fidelity at any distance — rivals, bosses, quest NPCs, escorts.
     *
     * Pick 'hero' from what the NPC IS, never from how many the game might have.
     * The tier is a hint: the scheduler may demote or promote under load anyway.
     */
    importance?: 'hero' | 'crowd';
    /** Per-NPC death callback */
    onDeath?: NpcDeathCallback;
    /**
     * Health and death tuning for every NPC of this type — `maxHealth`,
     * `canDie`, `ragdollOnDeath`, `explodeOnDeath`, `oneHitKill`, … Unset
     * fields fall back to `DEFAULT_DAMAGEABLE_CONFIG` (`engine/IDamageable.js`),
     * so `{ maxHealth: 250 }` changes only the HP.
     *
     * Applied when each NPC is constructed. To retune a live NPC afterwards use
     * `NpcController.setMaxHealth(n)`.
     */
    damageable?: Partial<DamageableConfig>;
    /**
     * Side-on 2D games lock every NPC to the gameplay plane (z = 0) by
     * default, because the engine's behaviors/pathfinding/avoidance are 3D and
     * would drift enemies off the plane the player is confined to. Set false
     * ONLY for deliberate backdrop actors that keep their authored Z (a crowd
     * behind the plane, distant walkers). Meaningless in 3D and top-down games,
     * where no plane is locked. Do NOT hand-roll plane constraints in game
     * code — the engine owns this.
     */
    planeLock?: boolean;
}

/**
 * Options for registering an NPC manager (engine-internal)
 * @internal
 */
export interface NpcRegisterOptions {
    /** Spawn X position (for regular ground spawning) */
    x?: number;
    /** Spawn Z position (for regular ground spawning) */
    z?: number;
    /** Object-relative spawn config (alternative to x/z) - spawns relative to an object */
    relativeTo?: RelativeSpawnConfig;
}

/**
 * @internal Engine-internal NPC management. Templates and agents should use
 * `engine.registerNpc(name, behavior, options)` which returns an NpcHandle
 * for explicit spawning via `handle.spawn(x, z)`.
 *
 * The engine owns this registry — it calls updateAll/disposeAll automatically.
 */
export class NpcRegistry {
    private engine: EngineLike;
    private npcManagers: Map<string, NpcManager> = new Map();
    private spawnPositions: Map<string, { x?: number; z?: number }> = new Map();
    private relativeSpawnConfigs: Map<string, RelativeSpawnConfig> = new Map();

    // Direct NpcController instances (for createDogNPC, createAnimalNPC, etc.)
    private directControllers: Map<string, NpcController> = new Map();
    
    // Track which NPC controllers have been wired up for death callbacks
    // Key format: "managerName:npcId" to ensure uniqueness
    private wiredNpcControllers: Set<string> = new Set();
    /** Roster generation per manager at the last death-callback wiring pass. */
    private wiredGenerationByManager = new Map<string, number>();
    
    /**
     * Callback triggered when ANY NPC in this registry dies.
     * This is the easiest way to track kills for quests, scoring, etc.
     */
    public onNpcDeath?: NpcDeathCallback;

    /** Normalize a registry key to ensure case-insensitive lookups */
    private normalizeKey(name: string): string {
        return name.toLowerCase();
    }

    /**
     * Chain a registry-level death notification onto a controller's
     * onDeathEffect, preserving any handler already set. The original handler
     * runs first, then `onNpcDeath` is fired (if registered) with the NPC's
     * current position, then the optional `onAfter` cleanup runs. `getType` is
     * a thunk so the NPC type is resolved at death time, not wiring time.
     * Shared by registerController() and wireDeathCallbacksForManager().
     */
    private chainDeathNotification(
        npc: NpcController,
        npcId: string,
        getType: () => string,
        onAfter?: () => void,
    ): void {
        const originalDeathEffect = npc.onDeathEffect;
        npc.onDeathEffect = (killerDirection?: THREE.Vector3) => {
            originalDeathEffect?.(killerDirection);
            const position = npc.getCharacter()?.position?.clone() || new THREE.Vector3();
            getGameEventLog().logEvent({ type: 'death', position, actor: `npc:${getType()}` });
            if (this.onNpcDeath) {
                this.onNpcDeath(npcId, getType(), position);
            }
            onAfter?.();
        };
    }

    constructor(engine: EngineLike) {
        this.engine = engine;
        // Auto-register with the engine so NpcManager.autoRegisterWithRegistry() can find us
        if (engine.setNpcRegistry) {
            engine.setNpcRegistry(this);
        } else {
            console.warn(`⚠️ [NpcRegistry] engine.setNpcRegistry not available — NpcManagers will not auto-register and will not receive update() calls`);
        }
    }

    /** @internal Called by engine.registerNpc(). */
    register(
        name: string,
        manager: NpcManager,
        options?: NpcRegisterOptions
    ): void {
        const key = this.normalizeKey(name);
        const existing = this.npcManagers.get(key);
        if (existing) {
            if (existing === manager) {
                return;
            }
            console.warn(`⚠️ [NpcRegistry] NPC '${name}' already registered, replacing existing manager`);
        }

        this.npcManagers.set(key, manager);

        if (options?.relativeTo) {
            this.relativeSpawnConfigs.set(key, options.relativeTo);
            console.log(`✅ [NpcRegistry] Registered NPC: ${name} (relative to ${options.relativeTo.objectId})`);
        } else {
            if (options?.x !== undefined || options?.z !== undefined) {
                this.spawnPositions.set(key, { x: options?.x, z: options?.z });
            }
            console.log(`✅ [NpcRegistry] Registered NPC: ${name}`);
        }
    }

    /** Register a direct NpcController (for animal NPCs created via createAnimalNPC). */
    registerController(name: string, controller: NpcController): void {
        const key = this.normalizeKey(name);
        if (this.directControllers.has(key)) {
            console.warn(`⚠️ [NpcRegistry] Controller '${name}' already registered, replacing existing`);
        }

        // Wrap the controller's onDeathEffect to also trigger registry-level callback
        this.chainDeathNotification(controller, name, () => 'NPC');

        this.directControllers.set(key, controller);

        // Register with DynamicObjectManager for chunk-based hibernation
        this.engine.getDynamicObjectManager?.()?.register(controller, 'npc');

        // Register with the character LOD scheduler (stamps lodState per frame)
        getGlobalLodScheduler().registerCharacter(controller);

        // Load custom animation assets (same as player gets)
        const animController = controller.getAnimationController();
        if (animController?.loadAllAnimationAssets) {
            animController.loadAllAnimationAssets({ normalizeRootMotion: true, loop: false })
                .then(() => {
                    console.log(`🎬 [NpcRegistry] Loaded animation assets for controller: ${name}`);
                })
                .catch((error: unknown) => {
                    console.error(`❌ [NpcRegistry] Failed to load animation assets for controller '${name}':`, error);
                });
        }

        console.log(`✅ [NpcRegistry] Registered direct controller: ${name}`);
    }

    /**
     * Get a direct NpcController by name
     * 
     * @param name - Controller name
     * @returns NpcController instance or null if not found
     */
    getController(name: string): NpcController | null {
        return this.directControllers.get(this.normalizeKey(name)) || null;
    }

    /**
     * Remove a direct NpcController from the registry
     * 
     * @param name - Controller name
     * @param dispose - If true, also disposes the controller (default: true)
     */
    unregisterController(name: string, dispose: boolean = true): void {
        const key = this.normalizeKey(name);
        const controller = this.directControllers.get(key);
        if (controller) {
            this.engine.getDynamicObjectManager?.()?.unregister(controller);
            // Explicit for the dispose=false case (dispose() also unregisters).
            getGlobalLodScheduler().unregisterCharacter(controller);
            if (dispose) {
                controller.dispose();
            } else {
                // The controller lives on but nothing stamps its lodState
                // anymore — restore FULL simulation (re-embodying a
                // VIRTUAL/HIBERNATED body) so it isn't frozen in a demoted
                // LOD state.
                controller.resetLodToFull();
            }
            this.directControllers.delete(key);
            console.log(`✅ [NpcRegistry] Unregistered controller: ${name}`);
        }
    }

    /**
     * Set spawn position for a registered NPC
     * 
     * @param name - NPC name
     * @param spawnX - X coordinate
     * @param spawnZ - Z coordinate
     */
    setSpawnPosition(name: string, spawnX: number, spawnZ: number): void {
        const key = this.normalizeKey(name);
        if (!this.npcManagers.has(key)) {
            console.warn(`⚠️ [NpcRegistry] Cannot set spawn position - NPC '${name}' not registered`);
            return;
        }

        this.spawnPositions.set(key, { x: spawnX, z: spawnZ });
    }

    /**
     * Get an NPC manager by name
     * 
     * @param name - NPC name
     * @returns NpcManager instance or null if not found
     */
    get(name: string): NpcManager | null {
        return this.npcManagers.get(this.normalizeKey(name)) || null;
    }

    /**
     * Spawn a specific NPC by name
     * 
     * @param name - NPC name
     * @param spawnX - Optional X coordinate (overrides stored position)
     * @param spawnZ - Optional Z coordinate (overrides stored position)
     */
    async spawn(name: string, spawnX?: number, spawnZ?: number): Promise<void> {
        const key = this.normalizeKey(name);
        const manager = this.npcManagers.get(key);
        if (!manager) {
            console.error(`❌ [NpcRegistry] Cannot spawn NPC '${name}' - not registered`);
            return;
        }

        const position = this.spawnPositions.get(key);
        const x = spawnX !== undefined ? spawnX : position?.x;
        const z = spawnZ !== undefined ? spawnZ : position?.z;

        try {
            await manager.spawnNpc(x, z);
            console.log(`✅ [NpcRegistry] Spawned NPC: ${name} at (${x ?? 'default'}, ${z ?? 'default'})`);
        } catch (error) {
            console.error(`❌ [NpcRegistry] Failed to spawn NPC '${name}':`, error);
        }
    }

    /** @internal Legacy batch spawn. Templates should use engine.registerNpc() + handle.spawn() instead. */
    async spawnAll(): Promise<void> {
        console.log(`🎮 [NpcRegistry] Spawning ${this.npcManagers.size} NPC types...`);

        const spawnPromises: Promise<void>[] = [];

        for (const [name, manager] of this.npcManagers.entries()) {
            const relativeConfig = this.relativeSpawnConfigs.get(name);
            const position = this.spawnPositions.get(name);

            // Object-relative spawning (built-in relation or custom position function)
            // when configured, otherwise regular position-based spawning.
            const spawned: Promise<unknown> = relativeConfig
                ? manager.spawnNpcRelativeTo(relativeConfig)
                : manager.spawnNpc(position?.x, position?.z);
            const relativeSuffix = relativeConfig ? ` (relative to ${relativeConfig.objectId})` : '';

            spawnPromises.push(
                spawned
                    .then(() => {
                        console.log(`✅ [NpcRegistry] Spawned: ${name}${relativeSuffix}`);
                    })
                    .catch((error: unknown) => {
                        console.error(`❌ [NpcRegistry] Failed to spawn '${name}':`, error);
                    })
            );
        }

        await Promise.all(spawnPromises);

        // NOTE: Animation assets are already loaded per-NPC in NpcManager.createNpcAtPosition()
        // No need to call loadAnimationAssetsForAllNpcs() again here.

        console.log(`✅ [NpcRegistry] Finished spawning all NPCs`);
    }

    /** @internal Called by GameEngine.update(). */
    updateAll(deltaTime: number): void {
        // Stamp every registered character's LOD state for this frame (also
        // drains the async path queue + goal-field flood budget). Runs AFTER
        // animalRegistry.updateAll in GameEngine.animate, so animals consume
        // last frame's stamp. A null camera stamps everyone FULL but still
        // drains the navigation queues (pathfinding must never freeze). The
        // player position folds into the distance metric so NPCs next to the
        // player stay full-rate even when the camera is far overhead.
        const playerPos = this.engine.getPlayerController?.()?.getPosition?.() ?? null;
        getGlobalLodScheduler().evaluate(this.engine.camera ?? null, deltaTime, playerPos);

        // Advance the global frame counter so NpcManager.update() is frame-idempotent.
        // This prevents double-updates when both registry and manual update() calls coexist.
        NpcManager.advanceFrame();
        
        // Update NpcManagers and wire up death callbacks for any new NPCs
        for (const [name, manager] of this.npcManagers.entries()) {
            try {
                // Wire up death callbacks for any NPCs that haven't been wired yet
                this.wireDeathCallbacksForManager(name, manager);
                
                manager.update(deltaTime);
            } catch (error) {
                console.error(`❌ [NpcRegistry] Error updating NPC manager '${name}':`, error);
            }
        }

        // Update direct NpcControllers (skip hibernating)
        const dynamicObjMgr = this.engine.getDynamicObjectManager?.();
        for (const [name, controller] of this.directControllers.entries()) {
            if (controller.isHibernating()) continue;
            try {
                controller.update(deltaTime);
                // Update chunk registration as NPC moves
                dynamicObjMgr?.updatePosition(controller);
            } catch (error) {
                console.error(`❌ [NpcRegistry] Error updating controller '${name}':`, error);
            }
        }
    }
    
    /**
     * Show or hide every NPC's visuals. Debug ablation only (see
     * GameEngine.setDebugDisableNpcs) — hiding rather than despawning keeps the
     * NPCs alive so the toggle is reversible mid-session and the measurement can
     * be repeated without a reload.
     */
    setAllCharactersVisible(visible: boolean): void {
        for (const controller of this.getAllControllers()) {
            controller.setAllVisualsVisible(visible);
        }
    }

    /**
     * Wire up death callbacks for all NPCs in a manager that haven't been wired yet.
     * This ensures onNpcDeath fires for NPCs spawned via NpcManager.
     */
    private wireDeathCallbacksForManager(managerName: string, manager: NpcManager): void {
        // Only when the roster grew since the last pass: the per-NPC scan below
        // is O(n) with allocations, and it ran every frame for every manager.
        const generation = manager.getRosterGeneration();
        if (this.wiredGenerationByManager.get(managerName) === generation) return;
        this.wiredGenerationByManager.set(managerName, generation);
        const npcs = manager.getAllNpcs();
        
        for (const npc of npcs) {
            // Use NPC's internal ID or generate one based on object identity
            const npcId = npc.getNpcId() || `npc_${npc.getCharacter()?.id ?? Math.random()}`;
            const wireKey = `${managerName}:${npcId}`;
            
            // Skip if already wired
            if (this.wiredNpcControllers.has(wireKey)) {
                continue;
            }

            // Wire up the death callback; drop the wiring once the NPC dies.
            this.chainDeathNotification(
                npc,
                npcId,
                () => manager.getName?.() || managerName,
                () => this.wiredNpcControllers.delete(wireKey),
            );

            this.wiredNpcControllers.add(wireKey);
        }
    }

    /** @internal Called by GameEngine.dispose(). */
    disposeAll(): void {
        const totalCount = this.npcManagers.size + this.directControllers.size;
        console.log(`🎮 [NpcRegistry] Disposing ${totalCount} NPCs...`);

        // Dispose NpcManagers
        for (const [name, manager] of this.npcManagers.entries()) {
            try {
                manager.dispose();
                console.log(`✅ [NpcRegistry] Disposed manager: ${name}`);
            } catch (error) {
                console.error(`❌ [NpcRegistry] Error disposing NPC '${name}':`, error);
            }
        }

        // Dispose direct NpcControllers
        const dynamicObjMgr = this.engine.getDynamicObjectManager?.();
        for (const [name, controller] of this.directControllers.entries()) {
            try {
                dynamicObjMgr?.unregister(controller);
                controller.dispose();
                console.log(`✅ [NpcRegistry] Disposed controller: ${name}`);
            } catch (error) {
                console.error(`❌ [NpcRegistry] Error disposing controller '${name}':`, error);
            }
        }

        this.npcManagers.clear();
        this.spawnPositions.clear();
        this.relativeSpawnConfigs.clear();
        this.directControllers.clear();
        this.wiredNpcControllers.clear();

        // Tear down the module-global LOD + navigation services with the engine.
        disposeGlobalLodScheduler();
        disposeGlobalPathQueue();
        disposeGlobalGoalFields();
        // Dispose the shared block-part render caches (all per-NPC teardown
        // above skipped cache-owned resources; this is their single owner).
        clearBlockPartCaches();
    }

    /**
     * Get count of registered NPC types (managers + controllers)
     */
    getCount(): number {
        return this.npcManagers.size + this.directControllers.size;
    }

    /**
     * Get count of registered NPC managers only
     */
    getManagerCount(): number {
        return this.npcManagers.size;
    }

    /**
     * Get count of registered direct controllers only
     */
    getControllerCount(): number {
        return this.directControllers.size;
    }

    /**
     * Get all registered NPC names (both managers and controllers)
     */
    getNames(): string[] {
        return [
            ...Array.from(this.npcManagers.keys()),
            ...Array.from(this.directControllers.keys())
        ];
    }

    /**
     * Check if an NPC (manager or controller) is registered
     */
    has(name: string): boolean {
        const key = this.normalizeKey(name);
        return this.npcManagers.has(key) || this.directControllers.has(key);
    }

    /**
     * Get ALL NpcControllers across all managers and direct controllers.
     * Used by engine systems (e.g., AOE explosion damage) that need to iterate
     * every NPC in the world regardless of how it was registered.
     */
    getAllControllers(): NpcController[] {
        const all: NpcController[] = [];
        for (const manager of this.npcManagers.values()) {
            all.push(...manager.getAllNpcs());
        }
        for (const controller of this.directControllers.values()) {
            all.push(controller);
        }
        return all;
    }
}

