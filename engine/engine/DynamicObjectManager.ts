/**
 * DynamicObjectManager - Unified system for managing all dynamic objects
 * that need chunk-based hibernation (animals, NPCs, vehicles, etc.)
 * 
 * Instead of each registry having its own terrain system connection,
 * this central manager handles all dynamic object registration.
 */

import * as THREE from 'three';
import type { ChunkManagedObject } from 'engine/ChunkPhysicsManager.js';
import type { VoxelTerrainSystem } from 'engine/VoxelTerrainSystem.js';
import type { EngineLike } from 'types/game.js';
import { VoxelMiningSystem, DEFAULT_MINING_OPTIONS, type VoxelMiningOptions } from 'engine/VoxelMiningSystem.js';
import { InGameNotification } from 'engine/InGameNotification.js';

export interface DynamicObjectStats {
    total: number;
    active: number;
    hibernating: number;
    byType: Map<string, { active: number; hibernating: number }>;
}

/** World-space AABB of the main terrain (same shape for procedural and baked runtimes). */
export interface TerrainBounds {
    minX: number; minY: number; minZ: number;
    maxX: number; maxY: number; maxZ: number;
}

/**
 * The subset of a baked terrain system (`VxlSceneTerrainSystem` / `VxlChunkedTerrainSystem`)
 * the manager needs. Baked levels have no mutable `VoxelWorld` — mining/shard-sync consumers
 * keep using `getMainVoxelWorld()` (and correctly no-op) — but they ARE the level's main
 * terrain, so extent consumers must be able to reach their bounds.
 */
export interface BakedTerrainProvider {
    getBounds(): TerrainBounds | null;
}

interface TrackedObject {
    obj: ChunkManagedObject;
    type: string;
    radius: number;
}

export class DynamicObjectManager {
    private objects = new Map<ChunkManagedObject, TrackedObject>();
    private terrainSystem: VoxelTerrainSystem | null = null;
    private bakedTerrain: BakedTerrainProvider | null = null;
    private lastStatsLog = 0;
    private statsLogInterval = 5000; // Log every 5 seconds
    private _voxelBlockSize: number = 1.0; // For step climbing

    // Objects waiting for terrain colliders to become ready
    private pendingPhysicsActivation: Set<ChunkManagedObject> = new Set();
    private collidersReadyCallbackRegistered: boolean = false;

    private engine: EngineLike | null = null;
    private voxelMiningSystem: VoxelMiningSystem | null = null;
    private miningNotification: InGameNotification | null = null;

    constructor(engine?: EngineLike) {
        this.engine = engine ?? null;
    }

    /**
     * `miningOpts` overrides individual fields of `DEFAULT_MINING_OPTIONS`.
     * Pass only the fields you want to change (e.g. `{ mineableBlocks: ['stone'] }`)
     * — the defaults fill in the rest.
     */
    setTerrainSystem(terrainSystem: VoxelTerrainSystem, miningOpts?: Partial<VoxelMiningOptions>): void {
        this.terrainSystem = terrainSystem;

        // Register any objects that were added before terrain was ready
        for (const [obj, tracked] of this.objects) {
            terrainSystem.registerDynamicObject(obj, tracked.radius);
        }

        // If we have pending objects and colliders are now ready, release them
        if (this.pendingPhysicsActivation.size > 0 && this.areTerrainCollidersReady()) {
            this.releaseAllPendingPhysics();
        }

        // Auto-create the engine-level mining primitive when terrain becomes available.
        // Dispose any stale instance from a previous game load first.
        if (this.voxelMiningSystem) {
            this.voxelMiningSystem.dispose();
            this.voxelMiningSystem = null;
        }
        if (this.engine) {
            this.voxelMiningSystem = new VoxelMiningSystem(
                this.engine,
                { getVoxelWorld: () => terrainSystem.getVoxelWorld() },
                { ...DEFAULT_MINING_OPTIONS, ...miningOpts },
            );
            this.voxelMiningSystem.onBlockDestroyed = (_pos, _id, name, _color) => {
                if (!this.miningNotification) this.miningNotification = new InGameNotification();
                this.miningNotification.show(`+1 ${name}`, 800);
            };
        }
    }

    /** Called from GameEngine's update loop. */
    updateMining(deltaTime: number): void {
        this.voxelMiningSystem?.update(deltaTime);
    }

    /** Call from GameEngine.dispose() and on game reload. */
    disposeMining(): void {
        this.voxelMiningSystem?.dispose();
        this.voxelMiningSystem = null;
        this.miningNotification = null;
    }

    /** Expose the mining system so templates can attach custom onBlockDestroyed handlers. */
    getVoxelMiningSystem(): VoxelMiningSystem | null {
        return this.voxelMiningSystem;
    }

    /**
     * Expose the main terrain VoxelWorld, used by WorldShardSync for persistent worlds.
     * Null on baked (.vwld) levels — those have no mutable block grid; consumers that only
     * need the level extent should use `getTerrainBounds()` instead.
     */
    getMainVoxelWorld(): import('engine/VoxelWorld.js').VoxelWorld | null {
        return this.terrainSystem?.getVoxelWorld() ?? null;
    }

    /**
     * Baked (.vwld) terrain systems (VxlScene / VxlChunked) self-register here at load — the
     * engine-side handle on the level terrain when there is no procedural VoxelWorld.
     */
    setBakedTerrain(terrain: BakedTerrainProvider | null): void {
        this.bakedTerrain = terrain;
    }

    getBakedTerrain(): BakedTerrainProvider | null {
        return this.bakedTerrain;
    }

    /**
     * World bounds of the MAIN terrain, whichever runtime backs it: the procedural
     * VoxelWorld's if present, else the registered baked (.vwld) level's.
     */
    getTerrainBounds(): TerrainBounds | null {
        return this.getMainVoxelWorld()?.getBounds() ?? this.bakedTerrain?.getBounds() ?? null;
    }

    hasTerrainSystem(): boolean {
        return this.terrainSystem !== null && this.terrainSystem.hasChunkPhysicsManager();
    }
    
    /**
     * Check if terrain colliders are ready for physics queries.
     * Returns false if terrain was recently built but physics hasn't stepped yet.
     * Used by PlayerController to hold the player in place until ground is solid.
     */
    areTerrainCollidersReady(): boolean {
        if (!this.terrainSystem) return true; // No terrain system = assume ready
        return this.terrainSystem.areCollidersReady();
    }
    
    /**
     * Force-activate terrain chunks at a world position (3x3 grid).
     * Used during respawn to ensure terrain colliders exist before the player lands.
     */
    forceActivateChunksAtPosition(x: number, z: number): void {
        if (this.terrainSystem) {
            this.terrainSystem.forceActivateChunksAtPosition(x, z);
        }
    }
    
    
    /**
     * Release all objects that were waiting for terrain colliders.
     * Called automatically when colliders become ready after a physics step.
     */
    private releaseAllPendingPhysics(): void {
        if (this.pendingPhysicsActivation.size === 0) return;
        
        console.log(`[DynamicObjectManager] Releasing physics for ${this.pendingPhysicsActivation.size} objects`);
        
        for (const obj of this.pendingPhysicsActivation) {
            if (obj.releasePhysics) {
                obj.releasePhysics();
            }
        }
        
        this.pendingPhysicsActivation.clear();
    }
    
    /**
     * Register a dynamic object for chunk-based hibernation.
     * If terrain colliders aren't ready yet, the object's physics will be held
     * until colliders become active (preventing fall-through on spawn).
     * 
     * @param obj Object implementing ChunkManagedObject interface
     * @param type Type name for stats grouping (e.g., 'animal', 'npc', 'vehicle')
     * @param radius Object radius for chunk overlap detection
     */
    register(obj: ChunkManagedObject, type: string, radius: number = 0.5): void {
        if (this.objects.has(obj)) return;
        
        this.objects.set(obj, { obj, type, radius });
        
        // Apply voxel block size for step climbing
        if ('voxelBlockSize' in obj) {
            (obj as { voxelBlockSize?: number }).voxelBlockSize = this._voxelBlockSize;
        }
        
        // FIRST: Register with chunk physics manager for hibernation
        // This must happen BEFORE enabling gravity, so objects in inactive chunks hibernate first
        if (this.terrainSystem) {
            this.terrainSystem.registerDynamicObject(obj, radius);
        }
        
        // If object is now hibernating (in inactive chunk), don't enable gravity
        // Gravity will be enabled when the chunk becomes active and wake() is called
        if (obj.isHibernating()) {
            return;
        }
        
        // Handle physics activation based on collider readiness
        // Physics bodies start with gravity=0, so we need to enable it when safe
        if (!this.areTerrainCollidersReady()) {
            // Colliders not ready - hold physics until they are
            if (obj.holdPhysicsUntilReady) {
                obj.holdPhysicsUntilReady();
                this.pendingPhysicsActivation.add(obj);
                
                // Register callback to release physics when colliders are ready (once)
                if (!this.collidersReadyCallbackRegistered && this.terrainSystem) {
                    this.collidersReadyCallbackRegistered = true;
                    this.terrainSystem.onCollidersReady(() => {
                        this.releaseAllPendingPhysics();
                        this.collidersReadyCallbackRegistered = false;
                    });
                }
            }
        } else {
            // Colliders are ready AND object is not hibernating - enable gravity
            // (physics bodies start with gravity=0, releasePhysics enables it)
            if (obj.releasePhysics) {
                obj.releasePhysics();
            }
        }
    }
    
    /**
     * Unregister a dynamic object.
     */
    unregister(obj: ChunkManagedObject): void {
        if (!this.objects.has(obj)) return;
        
        this.objects.delete(obj);
        
        if (this.terrainSystem) {
            this.terrainSystem.unregisterDynamicObject(obj);
        }
    }
    
    /**
     * Update an object's position (call when it moves).
     * This updates its chunk registrations for correct hibernation.
     */
    updatePosition(obj: ChunkManagedObject): void {
        const tracked = this.objects.get(obj);
        if (!tracked || !this.terrainSystem) return;
        
        this.terrainSystem.updateDynamicObjectPosition(obj, tracked.radius);
    }
    
    /**
     * Get current statistics about managed objects.
     */
    getStats(): DynamicObjectStats {
        const byType = new Map<string, { active: number; hibernating: number }>();
        let total = 0;
        let active = 0;
        let hibernating = 0;
        
        for (const [obj, tracked] of this.objects) {
            total++;
            const isHibernating = obj.isHibernating();
            
            if (isHibernating) {
                hibernating++;
            } else {
                active++;
            }
            
            // Group by type
            let typeStats = byType.get(tracked.type);
            if (!typeStats) {
                typeStats = { active: 0, hibernating: 0 };
                byType.set(tracked.type, typeStats);
            }
            if (isHibernating) {
                typeStats.hibernating++;
            } else {
                typeStats.active++;
            }
        }
        
        return { total, active, hibernating, byType };
    }
    
    /**
     * Throttled stats hook (call from update loop). Only advances the throttle
     * timer once the interval has elapsed and objects are tracked; callers that
     * want the numbers read them from `getStats()`.
     */
    maybeLogStats(): void {
        const now = Date.now();
        if (now - this.lastStatsLog < this.statsLogInterval) return;
        if (this.objects.size === 0) return;
        this.lastStatsLog = now;
    }
    
    /**
     * Clear all tracked objects.
     */
    clear(): void {
        if (this.terrainSystem) {
            for (const obj of this.objects.keys()) {
                this.terrainSystem.unregisterDynamicObject(obj);
            }
        }
        this.objects.clear();
    }
    
    /**
     * Get count of objects by type.
     */
    getCountByType(type: string): number {
        let count = 0;
        for (const tracked of this.objects.values()) {
            if (tracked.type === type) count++;
        }
        return count;
    }
    
    /**
     * Check if an object is registered.
     */
    isRegistered(obj: ChunkManagedObject): boolean {
        return this.objects.has(obj);
    }
    
    /**
     * Check if an entity at (x, feetY, z) is embedded in solid voxel terrain.
     * Returns the corrected Y (terrain surface) if embedded, null otherwise.
     * Used as a safety net against fall-through when chunk colliders are missing.
     */
    getVoxelFloorY(x: number, feetY: number, z: number): number | null {
        return this.terrainSystem?.getVoxelFloorY(x, feetY, z) ?? null;
    }

    /**
     * Set voxel block size for step climbing on all registered objects.
     * This is applied to objects that have a voxelBlockSize property (NPCs, animals).
     * Also stored for future registrations.
     */
    setVoxelBlockSize(size: number): void {
        this._voxelBlockSize = size;
        for (const obj of this.objects.keys()) {
            if ('voxelBlockSize' in obj) {
                (obj as { voxelBlockSize?: number }).voxelBlockSize = size;
            }
        }
    }
}
