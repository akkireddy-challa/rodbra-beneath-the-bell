/**
 * EXAMPLE: Creating Multiple NPC Types with Different Appearances
 *
 * Each engine.registerNpc() call creates a distinct NPC type.
 * Pass a different characterFactory to each for unique appearances.
 */

import { BaseNpcManagerBehavior } from 'engine/npc/INpcManagerBehavior.js';
import type { NpcController } from 'engine/npc/core/NpcController.js';
import type { EngineLike } from 'types/game.js';
import { NpcIdleBehavior } from 'engine/npc/behaviors/NpcIdleBehavior.js';
import { NpcEnemyBehavior } from 'engine/npc/behaviors/NpcEnemyBehavior.js';
import {
    createWarriorNpcFactory,
    createWizardNpcFactory,
    createElfNpcFactory,
    createDemonNpcFactory,
    createRobotNpcFactory
} from 'engine/npc/customization/NpcCustomizationPresets.js';
import { createCustomizedNpcFactory } from 'engine/npc/customization/NpcCustomization.js';
import { NpcEnemyManagerBehavior } from 'engine/npc/manager-behaviors/NpcEnemyManagerBehavior.js';

/**
 * COMPLETE EXAMPLE: Multiple NPC Types with Different Appearances
 *
 * Each engine.registerNpc() returns its own NpcHandle with its own appearance.
 */
export const MULTIPLE_NPC_TYPES_EXAMPLE = `
// ============================================
// METHOD 1: Each registerNpc Gets Its Own Factory (RECOMMENDED)
// ============================================
import { NpcEnemyBehavior } from 'engine/npc/behaviors/NpcEnemyBehavior.js';
import {
    createWarriorNpcFactory,
    createWizardNpcFactory,
    createElfNpcFactory
} from 'engine/npc/customization/NpcCustomizationPresets.js';

export class YourGame {
    private engine: EngineLike;

    constructor(engine: EngineLike) {
        this.engine = engine;
    }

    async load() {
        // Each registerNpc call creates a distinct NPC type with its own appearance
        const warriorHandle = this.engine.registerNpc('warrior', new NpcEnemyBehavior(), {
            characterFactory: createWarriorNpcFactory(),
            autoRespawn: true,
        });
        await warriorHandle.spawn(10, 5);

        const wizardHandle = this.engine.registerNpc('wizard', new NpcEnemyBehavior(), {
            characterFactory: createWizardNpcFactory(),
            autoRespawn: true,
        });
        await wizardHandle.spawn(15, 5);

        const elfHandle = this.engine.registerNpc('elf', new NpcEnemyBehavior(), {
            characterFactory: createElfNpcFactory(),
        });
        await elfHandle.spawn(20, 5);

        // No update() or dispose() needed — engine handles both.
    }
}

// ============================================
// METHOD 2: Custom Appearance Per NPC
// ============================================
import { createCustomizedNpcFactory } from 'engine/npc/customization/NpcCustomization.js';

async load() {
    const redHandle = this.engine.registerNpc('redEnemy', new NpcEnemyBehavior(), {
        characterFactory: createCustomizedNpcFactory({
            skinColor: 0xFFDBB3,
            clothing: { shirtColor: 0xFF0000 }  // Red shirt
        }),
        autoRespawn: true,
    });
    await redHandle.spawn(10, 5);

    const blueHandle = this.engine.registerNpc('blueEnemy', new NpcEnemyBehavior(), {
        characterFactory: createCustomizedNpcFactory({
            skinColor: 0xFFDBB3,
            clothing: { shirtColor: 0x0000FF }  // Blue shirt
        }),
        autoRespawn: true,
    });
    await blueHandle.spawn(15, 5);
}
`;

/**
 * Key Points for AI Agents
 *
 * 1. **Each engine.registerNpc() = One NPC type** with its own appearance
 * 2. **Set appearance via characterFactory option** — passed at registration time
 * 3. **Appearance persists through respawns** — the factory is stored per NPC type
 * 4. **Different registrations = Different appearances** — warrior, wizard, elf each unique
 */

