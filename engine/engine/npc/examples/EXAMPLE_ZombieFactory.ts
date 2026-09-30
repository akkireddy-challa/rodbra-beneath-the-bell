/**
 * @fileoverview EXAMPLE_ZombieFactory - Creates zombie NPC characters with green skin
 * 
 * This factory creates zombies with:
 * - Green undead skin tone
 * - Dark green clothing
 * - Red glowing eyes
 * 
 * Usage:
 * ```typescript
 * import { createZombieNpcFactory } from 'engine/npc/examples/EXAMPLE_ZombieFactory.js';
 * import { ExampleZombieBehavior } from 'engine/npc/examples/EXAMPLE_ZombieBehavior.js';
 *
 * const handle = engine.registerNpc('zombie', new ExampleZombieBehavior(), {
 *     characterFactory: createZombieNpcFactory()
 * });
 * await handle.spawn(10, 5);
 * ```
 * 
 * @see EXAMPLE_ZombieBehavior.ts - For zombie behavior with one-shot kill
 * @see NpcCustomization.ts - For creating custom NPC appearances
 */

import { createCustomizedNpcFactory } from 'engine/npc/customization/NpcCustomization.js';
import type { IBlockCharacterFactory } from 'engine/IBlockCharacterFactory.js';

/**
 * Create a zombie character factory with greenish, undead appearance
 * 
 * The factory is passed to NpcManager.setCharacterFactory() and creates
 * the visual representation of the zombie NPC.
 */
export function createZombieNpcFactory(): IBlockCharacterFactory {
    return createCustomizedNpcFactory({
        skinColor: 0x4a8f4e, // Zombie green
        clothing: {
            shirtColor: 0x2a4a2e, // Dark green shirt
            pantsColor: 0x3a5a3e, // Darker green pants
            bootsColor: 0x1a1a1a  // Black boots
        },
        features: {
            eyeColor: 0xFF0000 // Red glowing eyes
        }
    });
}

/**
 * Create a skeleton factory with pale bone-like appearance
 */
export function createSkeletonNpcFactory(): IBlockCharacterFactory {
    return createCustomizedNpcFactory({
        skinColor: 0xF0E6D3, // Bone white
        clothing: {
            shirtColor: 0x2a2a2a, // Dark rags
            pantsColor: 0x1a1a1a, // Black rags
            bootsColor: 0x0a0a0a  // Very dark boots
        },
        features: {
            eyeColor: 0x00FFFF // Cyan soul fire
        }
    });
}

/**
 * Create a ghoul factory with pale gray skin
 */
export function createGhoulNpcFactory(): IBlockCharacterFactory {
    return createCustomizedNpcFactory({
        skinColor: 0x6a6a7a, // Pale gray
        clothing: {
            shirtColor: 0x3a3a4a, // Dark gray rags
            pantsColor: 0x2a2a3a, // Darker pants
            bootsColor: 0x1a1a2a  // Almost black boots
        },
        features: {
            eyeColor: 0xFF4400 // Orange glowing eyes
        }
    });
}

