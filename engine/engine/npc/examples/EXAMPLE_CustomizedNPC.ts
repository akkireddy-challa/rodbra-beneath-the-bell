/**
 * EXAMPLE: How to Create Customized NPCs
 *
 * The NPC customization system lets you create NPCs with different:
 * - Colors (skin, clothing, accessories)
 * - Body shapes (size, proportions)
 * - Features (ears, horns, tails, etc.)
 * - Clothing items (hats, shirts, pants, boots)
 */

import { BaseNpcManagerBehavior } from 'engine/npc/INpcManagerBehavior.js';
import type { NpcController } from 'engine/npc/core/NpcController.js';
import type { EngineLike } from 'types/game.js';
import { NpcIdleBehavior } from 'engine/npc/behaviors/NpcIdleBehavior.js';
import { createCustomizedNpcFactory } from 'engine/npc/customization/NpcCustomization.js';
import {
    createWarriorNpcFactory,
    createWizardNpcFactory,
    createElfNpcFactory,
    createRandomNpcFactory
} from 'engine/npc/customization/NpcCustomizationPresets.js';

/**
 * Example: Custom NPC Manager Behavior with Customization
 */
export class CustomizedNPCManagerBehavior extends BaseNpcManagerBehavior {
    constructor() {
        super('CustomizedNPC', false, 0);
    }

    onNpcCreated(npc: NpcController, engine: EngineLike): void {
        npc.setBehavior(new NpcIdleBehavior({
            lookAtPlayer: true,
            lookAtRange: 5.0
        }));
    }

    onNpcUpdated(npc: NpcController, deltaTime: number, engine: EngineLike): boolean {
        return false;
    }
}

/**
 * COMPLETE INTEGRATION EXAMPLE — Customized NPCs via engine.registerNpc()
 */
export const CUSTOMIZED_NPC_INTEGRATION_EXAMPLE = `
// ============================================
// METHOD 1: Using Presets (EASIEST)
// ============================================
import { NpcEnemyBehavior } from 'engine/npc/behaviors/NpcEnemyBehavior.js';
import { createWarriorNpcFactory } from 'engine/npc/customization/NpcCustomizationPresets.js';

export class YourGame {
    private engine: EngineLike;

    constructor(engine: EngineLike) {
        this.engine = engine;
    }

    async load() {
        // Register with preset appearance
        const handle = this.engine.registerNpc('warrior', new NpcEnemyBehavior(), {
            characterFactory: createWarriorNpcFactory(),
            autoRespawn: true,
        });
        await handle.spawn(10, 5);
    }
}

// ============================================
// METHOD 2: Custom Configuration (FULL CONTROL)
// ============================================
import { createCustomizedNpcFactory } from 'engine/npc/customization/NpcCustomization.js';

async load() {
    const handle = this.engine.registerNpc('custom', new NpcIdleBehavior(), {
        characterFactory: createCustomizedNpcFactory({
            skinColor: 0xFFDBB3,
            clothing: {
                shirtColor: 0xFF0000,
                pantsColor: 0x0000FF,
                hatColor: 0xFFFF00,
                hatType: 'cap',
                bootsColor: 0x000000
            },
            bodyShape: {
                height: 1.8,
                width: 0.5,
                headSize: 1.2
            },
            features: {
                ears: { type: 'pointed', color: 0xFFDBB3, size: 1.0 },
                horns: { type: 'small', color: 0x8B4513, size: 1.0 },
                tail: { type: 'medium', color: 0xFF0000, size: 1.0 },
                eyeColor: 0x00FF00,
                sparkles: true
            }
        }),
    });
    await handle.spawn(10, 5);
}

// ============================================
// METHOD 3: Multiple NPCs with Different Appearances
// ============================================
import {
    createWarriorNpcFactory,
    createWizardNpcFactory,
    createElfNpcFactory,
    createRandomNpcFactory
} from 'engine/npc/customization/NpcCustomizationPresets.js';

async load() {
    const warrior = this.engine.registerNpc('warrior', new NpcEnemyBehavior(), {
        characterFactory: createWarriorNpcFactory(),
    });
    await warrior.spawn(10, 5);

    const wizard = this.engine.registerNpc('wizard', new NpcEnemyBehavior(), {
        characterFactory: createWizardNpcFactory(),
    });
    await wizard.spawn(15, 5);

    const elf = this.engine.registerNpc('elf', new NpcEnemyBehavior(), {
        characterFactory: createElfNpcFactory(),
    });
    await elf.spawn(20, 5);

    const random = this.engine.registerNpc('random', new NpcEnemyBehavior(), {
        characterFactory: createRandomNpcFactory(),
    });
    await random.spawn(25, 5);
}

// ============================================
// METHOD 4: Simple Color Customization
// ============================================
async load() {
    const redHandle = this.engine.registerNpc('redNpc', new NpcIdleBehavior(), {
        characterFactory: createCustomizedNpcFactory({
            skinColor: 0xFFDBB3,
            clothing: { shirtColor: 0xFF0000 }
        }),
    });
    await redHandle.spawn(10, 5);

    const blueHandle = this.engine.registerNpc('blueNpc', new NpcIdleBehavior(), {
        characterFactory: createCustomizedNpcFactory({
            skinColor: 0xFFDBB3,
            clothing: { shirtColor: 0x0000FF }
        }),
    });
    await blueHandle.spawn(15, 5);
}
`;

/**
 * QUICK REFERENCE: Available Customization Options
 *
 * Colors (hex numbers, e.g., 0xFF0000 for red):
 * - skinColor: Main body color
 * - clothing.shirtColor: Shirt color
 * - clothing.pantsColor: Pants color
 * - clothing.hatColor: Hat color
 * - clothing.bootsColor: Boots color
 * - features.eyeColor: Eye color
 *
 * Body Shape:
 * - bodyShape.height: Character height (default: 1.75)
 * - bodyShape.width: Character width (default: 0.5)
 * - bodyShape.depth: Character depth (default: 0.35)
 * - bodyShape.headSize: Head size multiplier (default: 1.0)
 * - bodyShape.torsoSize: Torso size multiplier (default: 1.0)
 * - bodyShape.limbSize: Limb size multiplier (default: 1.0)
 *
 * Features:
 * - features.ears.type: 'pointed' | 'round' | 'floppy' | 'none'
 * - features.horns.type: 'small' | 'medium' | 'large' | 'curved' | 'none'
 * - features.tail.type: 'short' | 'medium' | 'long' | 'fluffy' | 'none'
 * - features.sparkles: true/false (adds decorative sparkles)
 *
 * Clothing:
 * - clothing.hatType: 'cap' | 'tophat' | 'crown' | 'helmet'
 *
 * Presets Available:
 * - createWarriorNpcFactory() - Armor, helmet, strong
 * - createWizardNpcFactory() - Robes, hat, magical
 * - createElfNpcFactory() - Pointed ears, nature colors
 * - createDemonNpcFactory() - Horns, tail, dark
 * - createCuteCreatureNpcFactory() - Floppy ears, pastel
 * - createRobotNpcFactory() - Metallic, gray
 * - createRoyalNpcFactory() - Crown, elegant
 * - createRandomNpcFactory() - Random appearance
 */

