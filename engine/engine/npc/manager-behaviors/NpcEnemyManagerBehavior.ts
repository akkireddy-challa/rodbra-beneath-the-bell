import { BaseNpcManagerBehavior } from 'engine/npc/INpcManagerBehavior.js';
import type { NpcController } from 'engine/npc/core/NpcController.js';
import type { EngineLike } from 'types/game.js';
import { NpcEnemyBehavior } from 'engine/npc/behaviors/NpcEnemyBehavior.js';

/**
 * NpcEnemyManagerBehavior - Management behavior for hostile enemies
 * 
 * ⚠️ CRITICAL FOR AI AGENTS: This behavior class alone does NOT spawn NPCs!
 * You MUST also create an NpcManager and call spawnNpc() in Game.ts!
 * 
 * Features:
 * - Sets NpcEnemyBehavior: roams near its spawn, chases and punches the player on sight
 * - Auto-respawn is DISABLED by default (opt-in via config)
 * - Pass any `NpcMeleeAttackConfig` field (damage, detectionRange, chaseSpeed, …) to tune
 *   the combat; `engine.getHUD().showHealth()` is what makes the damage visible
 * 
 * This extracts enemy-specific logic from the NPC manager, allowing
 * the same manager to be used for different NPC types.
 * 
 * ⚠️ COMPLETE INTEGRATION REQUIRED:
 * 
 * ## Health Bars with Respawns
 * 
 * ⚠️ CRITICAL: Set up health bars in `onNpcCreated()`, NOT in Game.ts!
 * This ensures health bars work for BOTH initial spawns AND respawns.
 * 
 * See EXAMPLE_CompleteNPCIntegration.ts for detailed examples.
 */
/** Everything `NpcEnemyBehavior` accepts — wander bounds plus the melee tuning fields. */
type NpcEnemyConfig = NonNullable<ConstructorParameters<typeof NpcEnemyBehavior>[0]>;

export class NpcEnemyManagerBehavior extends BaseNpcManagerBehavior {
    private readonly enemyConfig: NpcEnemyConfig;

    constructor(config?: NpcEnemyConfig & {
        autoRespawn?: boolean;
        respawnDelay?: number;
    }) {
        // Note: autoRespawn defaults to FALSE - opt-in, not opt-out
        super('Enemy', config?.autoRespawn ?? false, config?.respawnDelay ?? 2.0);
        this.enemyConfig = {
            ...config,
            worldBounds: config?.worldBounds ?? 15,
            retargetInterval: config?.retargetInterval ?? 5.0,
        };
    }

    onNpcCreated(npc: NpcController, engine: EngineLike): void {
        npc.setBehavior(new NpcEnemyBehavior(this.enemyConfig));

        console.log('✅ NPC spawned with NpcEnemyBehavior (roams, chases, punches)');
    }
}

