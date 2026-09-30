import { NpcManager } from 'engine/npc/core/NpcManager.js';
import { SimpleNpcManagerBehavior } from 'engine/npc/INpcManagerBehavior.js';
import type { INpcBehavior } from 'engine/npc/INpcBehavior.js';
import type { EngineLike } from 'types/game.js';

/**
 * @internal Engine-internal helper. Templates and agents should use
 * `engine.registerNpc()` instead — it returns an NpcHandle for explicit spawning.
 */
export function createNpcManager(
    engine: EngineLike,
    name: string,
    npcBehavior: INpcBehavior,
    autoRespawn: boolean = false
): NpcManager {
    const managerBehavior = new SimpleNpcManagerBehavior(name, npcBehavior, autoRespawn);
    return new NpcManager(engine, managerBehavior);
}

