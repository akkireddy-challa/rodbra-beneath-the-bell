/**
 * EXAMPLE: How to create NPCs
 *
 * SIMPLEST METHOD: Use engine.registerNpc() — no manager or behavior class needed!
 *
 * ```typescript
 * import { NpcIdleBehavior } from 'engine/npc/behaviors/NpcIdleBehavior.js';
 *
 * // In Game.ts load():
 * const handle = this.engine.registerNpc('villager', new NpcIdleBehavior({
 *     lookAtPlayer: true,
 * }));
 * await handle.spawn(10, 5);
 * ```
 *
 * ADVANCED METHOD: Only use a manager behavior class if you need custom collision/respawn logic.
 * This file shows how to create a manager behavior for advanced cases.
 */

import { BaseNpcManagerBehavior } from 'engine/npc/INpcManagerBehavior.js';
import type { NpcController } from 'engine/npc/core/NpcController.js';
import type { EngineLike } from 'types/game.js';
import { NpcIdleBehavior } from 'engine/npc/behaviors/NpcIdleBehavior.js';

/**
 * Example: Villager Manager Behavior
 *
 * Simple friendly NPC that:
 * - Stays in place (idle behavior)
 * - Doesn't respawn when destroyed
 * - No special update logic needed
 */
export class VillagerManagerBehavior extends BaseNpcManagerBehavior {
    constructor() {
        // name, autoRespawn=false, respawnDelay=0
        super('Villager', false, 0);
    }

    /**
     * Configure NPC when it's created
     */
    onNpcCreated(npc: NpcController, engine: EngineLike): void {
        // Set the NPC's behavior (how it acts)
        npc.setBehavior(new NpcIdleBehavior({
            lookAtPlayer: true,
            lookAtRange: 5.0
        }));
    }

    /**
     * Update logic (called every frame)
     * Return true if NPC should respawn
     */
    onNpcUpdated(npc: NpcController, deltaTime: number, engine: EngineLike): boolean {
        // Villagers don't need special update logic
        // Return false = no respawn needed
        return false;
    }

    // onNpcDestroyed is optional - BaseNpcManagerBehavior provides default (no cleanup)
    // getName, getRespawnDelay, shouldAutoRespawn are handled by base class
}

/**
 * COMPLETE USAGE — engine.registerNpc() handles everything.
 *
 * ```typescript
 * import { NpcIdleBehavior } from 'engine/npc/behaviors/NpcIdleBehavior.js';
 * import { createVillagerNpcFactory } from 'engine/npc/customization/NpcCustomizationPresets.js';
 *
 * export class MyGame {
 *     private engine: EngineLike;
 *
 *     constructor(engine: EngineLike) {
 *         this.engine = engine;
 *     }
 *
 *     async load() {
 *         // Register and spawn — engine handles update and dispose automatically
 *         const handle = this.engine.registerNpc('villager', new NpcIdleBehavior({
 *             lookAtPlayer: true,
 *             lookAtRange: 5.0,
 *         }), {
 *             characterFactory: createVillagerNpcFactory(),
 *         });
 *         await handle.spawn(10, 5);
 *     }
 * }
 * ```
 *
 * REMEMBER:
 * - engine.registerNpc() returns an NpcHandle — call handle.spawn(x, z) to place the NPC
 * - No update() or dispose() calls needed — engine handles both automatically
 * - Call handle.spawn() AFTER player has loaded (system retries automatically if not ready)
 * - See EXAMPLE_CompleteNPCIntegration.ts for more patterns
 */

