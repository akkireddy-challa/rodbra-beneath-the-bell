/**
 * COMPLETE EXAMPLE: How to Add NPCs to Your Game
 *
 * NPCs require TWO things in Game.ts:
 * 1. engine.registerNpc() — register NPC type and get a handle
 * 2. handle.spawn(x, z) — spawn the NPC at a position
 *
 * The engine handles update and dispose automatically — no manual calls needed.
 */

import { BaseNpcManagerBehavior } from 'engine/npc/INpcManagerBehavior.js';
import type { NpcController } from 'engine/npc/core/NpcController.js';
import type { EngineLike } from 'types/game.js';
import { NpcIdleBehavior } from 'engine/npc/behaviors/NpcIdleBehavior.js';
import { NpcEnemyBehavior } from 'engine/npc/behaviors/NpcEnemyBehavior.js';

/**
 * Example: Custom NPC Manager Behavior
 *
 * This shows how to create a new NPC type with custom behavior.
 * For simple NPCs, pass a behavior directly to engine.registerNpc() instead.
 */
export class ExampleCustomNPCManagerBehavior extends BaseNpcManagerBehavior {
    constructor() {
        // Parameters: name, autoRespawn, respawnDelay
        super('CustomNPC', false, 0);
    }

    /**
     * Called when NPC is spawned - configure its behavior here
     */
    onNpcCreated(npc: NpcController, engine: EngineLike): void {
        // Set the NPC's behavior (how it acts)
        npc.setBehavior(new NpcIdleBehavior({
            lookAtPlayer: true,
            lookAtRange: 5.0
        }));

        console.log('Custom NPC configured and ready!');
    }

    /**
     * Called every frame - add custom update logic here
     * Return true if NPC should respawn
     */
    onNpcUpdated(npc: NpcController, deltaTime: number, engine: EngineLike): boolean {
        // Add custom logic here if needed
        // Return false = no respawn needed
        return false;
    }
}

/**
 * COMPLETE INTEGRATION EXAMPLE — Copy this pattern to Game.ts!
 *
 * Uses engine.registerNpc() + handle.spawn(). The engine handles update and dispose.
 */
export const COMPLETE_GAME_TS_INTEGRATION_EXAMPLE = `
// ============================================
// STEP 1: Import behavior and factory
// ============================================
import { NpcIdleBehavior } from 'engine/npc/behaviors/NpcIdleBehavior.js';
import { NpcEnemyBehavior } from 'engine/npc/behaviors/NpcEnemyBehavior.js';
import { createWarriorNpcFactory } from 'engine/npc/customization/NpcCustomizationPresets.js';

export class YourGame {
    private engine: EngineLike;

    constructor(engine: EngineLike) {
        this.engine = engine;
    }

    async load() {
        // ============================================
        // STEP 2: Register NPC and spawn
        // ============================================
        // engine.registerNpc() returns an NpcHandle
        const villagerHandle = this.engine.registerNpc('villager', new NpcIdleBehavior({
            lookAtPlayer: true
        }));
        await villagerHandle.spawn(10, 5);

        // Enemy with custom appearance and death callback
        const enemyHandle = this.engine.registerNpc('enemy', new NpcEnemyBehavior(), {
            characterFactory: createWarriorNpcFactory(),
            autoRespawn: true,
            onDeath: (npcId, npcType, pos) => {
                console.log('Enemy defeated at', pos);
            },
        });
        await enemyHandle.spawn(15, 10);

        // That's it! No update() or dispose() needed — engine handles both.
    }
}
`;

/**
 * QUICK REFERENCE: Common NPC Patterns
 *
 * Pattern 1: Enemy (auto-respawn, custom appearance)
 * \`\`\`typescript
 * const handle = engine.registerNpc('enemy', new NpcEnemyBehavior(), {
 *     characterFactory: createWarriorNpcFactory(),
 *     autoRespawn: true,
 * });
 * await handle.spawn(10, 5);
 * \`\`\`
 *
 * Pattern 2: Simple NPC (villager, shopkeeper)
 * \`\`\`typescript
 * const handle = engine.registerNpc('villager', new NpcIdleBehavior({
 *     lookAtPlayer: true,
 * }));
 * await handle.spawn(10, 5);
 * \`\`\`
 *
 * Pattern 3: Relative spawn (near an object)
 * \`\`\`typescript
 * const handle = engine.registerNpc('guard', new NpcIdleBehavior());
 * await handle.spawn({ objectId: 'tower', relation: SpawnRelation.ON_TOP });
 * \`\`\`
 */

/**
 * TROUBLESHOOTING: Common Issues
 *
 * Issue: NPCs don't appear
 * - Check you called handle.spawn() in load()
 * - Check prerequisites (player GLTF loaded, scene/physics ready)
 * - Check console for error messages
 *
 * Issue: NPCs spawn but don't move
 * - Check NPC behavior is correct (NpcIdleBehavior stays still by design)
 * - Use NpcEnemyBehavior or a patrol behavior for movement
 *
 * Issue: "Cannot spawn NPC - player GLTF not loaded"
 * - Call handle.spawn() AFTER player has loaded
 * - The system will retry automatically
 */

