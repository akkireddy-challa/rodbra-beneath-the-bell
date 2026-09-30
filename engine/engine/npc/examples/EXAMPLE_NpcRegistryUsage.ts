/**
 * EXAMPLE: Using engine.registerNpc() — The Only NPC API You Need
 *
 * Templates and agents use engine.registerNpc() to add NPCs.
 * No custom Game.ts methods, no manual update/dispose, no registry boilerplate.
 */

import { NpcEnemyBehavior } from 'engine/npc/behaviors/NpcEnemyBehavior.js';
import { NpcIdleBehavior } from 'engine/npc/behaviors/NpcIdleBehavior.js';
import { createWarriorNpcFactory, createWizardNpcFactory } from 'engine/npc/customization/NpcCustomizationPresets.js';
import type { EngineLike } from 'types/game.js';

/**
 * COMPLETE INTEGRATION EXAMPLE — engine.registerNpc() + handle.spawn()
 *
 * engine.registerNpc() returns an NpcHandle. Call handle.spawn(x, z) to place the NPC.
 * The engine owns the registry and handles update/dispose automatically.
 */
export const NPC_REGISTRY_INTEGRATION_EXAMPLE = `
// ============================================
// Just register, set appearance, and spawn — that's it!
// ============================================

// Example: Add a villager
const villagerHandle = engine.registerNpc('villager', new NpcIdleBehavior({
    lookAtPlayer: true,
}));
await villagerHandle.spawn(10, 5);

// Example: Add a warrior enemy with custom appearance
const warriorHandle = engine.registerNpc('warrior', new NpcEnemyBehavior(), {
    characterFactory: createWarriorNpcFactory(),
    autoRespawn: true,
});
await warriorHandle.spawn(15, 10);

// Example: Add a wizard enemy with custom appearance
const wizardHandle = engine.registerNpc('wizard', new NpcEnemyBehavior(), {
    characterFactory: createWizardNpcFactory(),
    autoRespawn: true,
});
await wizardHandle.spawn(20, 15);

// That's it! No update(), dispose(), or registry management needed.
// The engine handles everything automatically.
`;

/**
 * KEY POINTS FOR AI AGENTS:
 *
 * 1. **Use engine.registerNpc()** — returns an NpcHandle for spawning
 * 2. **Call handle.spawn(x, z)** — spawns the NPC at that position
 * 3. **No manual update() needed** — engine calls updateAll() automatically
 * 4. **No manual dispose() needed** — engine calls disposeAll() automatically
 * 5. **No registry boilerplate** — engine owns and manages the registry
 * 6. **Set appearance via options** — pass characterFactory in the options arg
 *
 * DO:
 * - engine.registerNpc('name', behavior, { characterFactory })
 * - await handle.spawn(x, z)
 *
 * DON'T:
 * - new NpcRegistry(engine)
 * - npcRegistry.register(...)
 * - npcRegistry.spawnAll()
 * - npcRegistry.updateAll(deltaTime)
 * - npcRegistry.disposeAll()
 * - manager.update(deltaTime)
 * - manager.dispose()
 */

