import type { NpcController } from 'engine/npc/core/NpcController.js';
import type { EngineLike } from 'types/game.js';
import type { INpcBehavior } from 'engine/npc/INpcBehavior.js';

/**
 * Interface for NPC manager behavior strategies
 * 
 * ⚠️ CRITICAL: All NPC logic belongs HERE, NOT in Game.ts!
 * 
 * This interface defines how NPCs are managed (spawning, collision detection, respawn logic).
 * It separates NPC lifecycle management from behavior-specific logic.
 * 
 * **What Goes in NpcManagerBehavior (NOT in Game.ts):**
 * - ✅ `onNpcCreated()` - Configure NPC when spawned (set behavior, configure properties)
 * - ✅ `onNpcUpdated()` - Update logic every frame (check collisions, detect respawn)
 * - ✅ `onNpcDestroyed()` - Cleanup when NPC destroyed
 * - ✅ Collision detection logic
 * - ✅ Respawn rules and timing
 * - ✅ Custom update logic per NPC type
 * 
 * **What Goes in Game.ts (NOT here):**
 * - ❌ Property declaration: `private enemyManager: NpcManager | null = null;`
 * - ❌ Create manager: `this.enemyManager = NpcManager.createEnemy(this.engine);`
 * - ❌ Call `spawnNpc()`: `await this.enemyManager.spawnNpc(10, 5);`
 * - ❌ Call `update()`: `this.enemyManager.update(deltaTime);`
 * - ❌ Call `dispose()`: `this.enemyManager.dispose();`
 * 
 * Allows different management behaviors for NPCs:
 * - Enemy managers: auto-respawn, projectile collision, hostile behavior
 * - Shopkeeper managers: position management, interaction tracking
 * - Companion managers: follow player, no respawn
 * 
 * Use BaseNpcManagerBehavior for default implementations of optional methods.
 */
export interface INpcManagerBehavior {
    /**
     * Called after NPC is spawned
     * Use this to set the NPC's behavior and configure it
     * 
     * @param npc - The spawned NPC controller
     * @param engine - Reference to the game engine
     */
    onNpcCreated(npc: NpcController, engine: EngineLike): void;

    /**
     * Called each frame for the NPC
     * Use this for collision checking, respawn logic, etc.
     * 
     * @param npc - The NPC controller to update
     * @param deltaTime - Time since last frame in seconds
     * @param engine - Reference to the game engine
     * @returns true if NPC should be respawned (will trigger despawn + respawn cycle)
     */
    onNpcUpdated(npc: NpcController, deltaTime: number, engine: EngineLike): boolean;

    /**
     * Called when NPC is destroyed/despawned
     * Optional - use for cleanup, tracking, etc.
     * 
     * @param npc - The NPC controller being destroyed
     * @param engine - Reference to the game engine
     */
    onNpcDestroyed?(npc: NpcController, engine: EngineLike): void;

    /**
     * Get the respawn delay in seconds
     * @returns Delay in seconds before respawning, or 0 for no respawn
     */
    getRespawnDelay(): number;

    /**
     * Check if auto-respawn is enabled for this NPC type
     * @returns true if NPC should auto-respawn when destroyed
     */
    shouldAutoRespawn(): boolean;

    /**
     * Get behavior display name (for debugging/UI)
     * @returns Human-readable name (e.g., "Enemy", "Shopkeeper")
     */
    getName(): string;
}

/**
 * Base class with default implementations for common behavior patterns
 * Extend this to reduce boilerplate when creating new manager behaviors
 * 
 * SIMPLIFIED: You can pass the NPC behavior directly in constructor for simple cases!
 * 
 */
export class BaseNpcManagerBehavior implements INpcManagerBehavior {
    protected name: string;
    protected autoRespawn: boolean;
    protected respawnDelay: number;
    protected npcBehavior: INpcBehavior | null;

    constructor(
        name: string, 
        autoRespawn: boolean = false, 
        respawnDelay: number = 0,
        npcBehavior: INpcBehavior | null = null
    ) {
        this.name = name;
        this.autoRespawn = autoRespawn;
        this.respawnDelay = respawnDelay;
        this.npcBehavior = npcBehavior;
    }

    /**
     * Sets the NPC behavior if provided in constructor, otherwise override in subclass
     * IMPORTANT: Clones the behavior if clone() is implemented to avoid sharing state!
     */
    onNpcCreated(npc: NpcController, engine: EngineLike): void {
        if (this.npcBehavior) {
            // Clone behavior if possible to avoid sharing state between NPCs
            const behaviorToUse = this.npcBehavior.clone?.() ?? this.npcBehavior;
            npc.setBehavior(behaviorToUse);
        }
        // Otherwise override in subclass
    }

    /**
     * Called every frame for each NPC. Override in subclass for custom logic.
     * Return true to signal that this NPC should respawn.
     */
    onNpcUpdated(npc: NpcController, deltaTime: number, engine: EngineLike): boolean {
        // Respawn once the NPC exploded or fell off the world (below Y = -100).
        // Without auto-respawn, NpcManager destroys fallen NPCs instead of respawning them.
        return this.autoRespawn && (npc.isExploded() || npc.hasFallenOffWorld());
    }

    /**
     * Optional - override if cleanup needed
     */
    onNpcDestroyed(npc: NpcController, engine: EngineLike): void {
        // Default: no cleanup needed
    }

    getRespawnDelay(): number {
        return this.respawnDelay;
    }

    shouldAutoRespawn(): boolean {
        return this.autoRespawn;
    }

    getName(): string {
        return this.name;
    }
}

/**
 * SIMPLIFIED: Helper class for the simplest case - just pass NPC behavior!
 * 
 * Use this when you don't need custom update logic or collision detection.
 * 
 * @param name - Display name for the NPC type
 * @param npcBehavior - The behavior to use (e.g., RangedNpcBehavior, MeleeNpcBehavior)
 * @param autoRespawn - Whether NPCs should respawn after death (default: false)
 * @param respawnDelay - Seconds before respawning (default: 5.0). Only used if autoRespawn is true.
 */
export class SimpleNpcManagerBehavior extends BaseNpcManagerBehavior {
    constructor(name: string, npcBehavior: INpcBehavior, autoRespawn: boolean = false, respawnDelay: number = 5.0) {
        super(name, autoRespawn, respawnDelay, npcBehavior);
    }
}

