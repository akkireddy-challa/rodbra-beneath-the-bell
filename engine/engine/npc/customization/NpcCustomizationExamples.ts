/**
 * 🎨 NPC Customization Examples - SAMPLE TEMPLATES
 * 
 * ⚠️ CRITICAL: These are EXAMPLE TEMPLATES, not a limited selection!
 * 
 * **These examples are SAMPLES that show HOW to use the customization system.**
 * You are NOT limited to these 5 examples - create ANY customization you want!
 * 
 * **This file demonstrates:**
 * - How to use clothing (shirts, pants, hats, shoes, belts)
 * - How to use accessories (glasses, jewelry, bags, protective gear)
 * - How to use features (beards, ears, horns, tails)
 * - How to configure body shapes (height, width, proportions)
 * 
 * ## How to Use These Examples
 * 
 * **Option 1: Use as-is** (if it matches what you need)
 * ```typescript
 * const npcFactory = createAdventurerNpcFactory();
 * await npcManager.spawnNpc(10, 5, npcFactory);
 * ```
 * 
 * **Option 2: Modify** (change colors, add/remove accessories)
 * ```typescript
 * const factory = createAdventurerNpcFactory();
 * // Then modify the config before using, or copy and edit the code
 * ```
 * 
 * **Option 3: Create Your Own** (use these as templates)
 * ```typescript
 * // Copy one of these examples, then modify it to create your unique character
 * const myCustomFactory = createCustomizedNpcFactory({
 *     // Your custom configuration here
 * });
 * ```
 * 
 * **Option 4: Mix & Match** (combine elements from different examples)
 * ```typescript
 * // Take accessories from one example, colors from another, etc.
 * ```
 * 
 * **REMEMBER: The customization system is FULLY FLEXIBLE!**
 * - Use ANY colors (hex values)
 * - Combine ANY accessories
 * - Create ANY body shape
 * - Mix ANY features
 * - These examples just show you HOW - you can create anything!
 * 
 * ## Available Accessories (20+ options)
 * 
 * **Head Accessories:**
 * - Hats: cap, tophat, crown, helmet, beanie, hood, bandana-hat, cowboy, beret, visor (10 types)
 * - Glasses: round, square, aviator
 * - Beard: short, medium, long, goatee, mustache, full
 * - Bandana, Mask, Earrings
 * 
 * **Body Accessories:**
 * - Belt (with buckle)
 * - Necklace (with pendant)
 * - Backpack (with straps)
 * - Cape
 * - Scarf
 * - Badge/Pin
 * 
 * **Arm Accessories:**
 * - Shoulder pads
 * - Elbow pads
 * - Gloves
 * - Bracelet
 * - Watch (left hand)
 * - Ring
 * 
 * **Leg Accessories:**
 * - Knee pads
 * - Bandage
 * 
 * **Foot Accessories:**
 * - Shoes: sneakers, boots, sandals, dress
 * - Boots (via bootsColor)
 */

import { createCustomizedNpcFactory } from 'engine/npc/customization/NpcCustomization.js';
import type { IBlockCharacterFactory } from 'engine/IBlockCharacterFactory.js';

/**
 * EXAMPLE 1: Adventurer Character (SAMPLE TEMPLATE)
 * 
 * A rugged explorer with practical gear and accessories
 * 
 * ⚠️ This is a SAMPLE - modify it or create your own following this pattern!
 */
export function createAdventurerNpcFactory(): IBlockCharacterFactory {
    return createCustomizedNpcFactory({
        skinColor: 0xF4A460, // Tan skin (outdoor adventurer)
        clothing: {
            shirtColor: 0x8B4513, // Brown shirt
            pantsColor: 0x654321, // Dark brown pants
            hatColor: 0x2F4F4F, // Dark gray hat
            hatType: 'cap',
            bootsColor: 0x000000, // Black boots
            belt: {
                color: 0x8B4513, // Brown belt
                width: 1.2 // Slightly wider
            },
            shoes: {
                color: 0x000000,
                type: 'boots' // Hiking boots
            },
            accessories: {
                backpack: 0x4A4A4A, // Gray backpack
                gloves: 0x654321, // Brown gloves
                scarf: 0xFF6347, // Red scarf
                badge: 0xFFD700 // Gold badge
            }
        },
        bodyShape: {
            height: 1.8,
            width: 0.55,
            torsoSize: 1.1
        },
        features: {
            beard: {
                type: 'medium',
                color: 0x8B4513, // Brown beard
                size: 1.0
            },
            eyeColor: 0x0000FF // Blue eyes
        }
    });
}

/**
 * EXAMPLE 2: Cyberpunk Character (SAMPLE TEMPLATE)
 * 
 * A futuristic character with tech accessories and modern style
 * 
 * ⚠️ This is a SAMPLE - modify it or create your own following this pattern!
 */
export function createCyberpunkNpcFactory(): IBlockCharacterFactory {
    return createCustomizedNpcFactory({
        skinColor: 0xFFDBB3, // Light skin
        clothing: {
            shirtColor: 0x1A1A2E, // Dark blue/black shirt
            pantsColor: 0x16213E, // Darker blue pants
            hatColor: 0x0F3460, // Dark blue hood
            hatType: 'hood',
            bootsColor: 0x000000, // Black boots
            belt: {
                color: 0x00FFFF, // Cyan belt (glowing effect)
                width: 1.0
            },
            shoes: {
                color: 0x000000,
                type: 'sneakers' // Futuristic sneakers
            },
            accessories: {
                glasses: {
                    type: 'aviator',
                    color: 0x00FFFF, // Cyan frames
                    lensColor: 0x0000FF // Blue tinted lenses
                },
                mask: 0x1A1A2E, // Dark mask
                gloves: 0x0F3460, // Dark blue gloves
                backpack: 0x16213E, // Dark backpack
                badge: 0x00FFFF, // Cyan badge
                watch: 0x00FFFF, // Cyan watch
                ring: 0x00FFFF // Cyan ring
            }
        },
        bodyShape: {
            height: 1.75,
            width: 0.5,
            headSize: 1.0
        },
        features: {
            eyeColor: 0x00FFFF // Cyan eyes (cyberpunk style)
        }
    });
}

/**
 * EXAMPLE 3: Noble Knight Character (SAMPLE TEMPLATE)
 * 
 * A regal warrior with armor, crown, and royal accessories
 * 
 * ⚠️ This is a SAMPLE - modify it or create your own following this pattern!
 */
export function createNobleKnightNpcFactory(): IBlockCharacterFactory {
    return createCustomizedNpcFactory({
        skinColor: 0xFFDBB3, // Light skin
        clothing: {
            shirtColor: 0xFFD700, // Gold shirt (royal)
            pantsColor: 0x8B4513, // Brown pants
            hatColor: 0xFFD700, // Gold crown
            hatType: 'crown',
            bootsColor: 0x000000, // Black boots
            belt: {
                color: 0xFFD700, // Gold belt
                width: 1.5 // Wide royal belt
            },
            shoes: {
                color: 0x000000,
                type: 'dress' // Shiny dress shoes
            },
            accessories: {
                cape: 0x8B0000, // Red cape
                necklace: 0xFFD700, // Gold necklace
                bracelet: 0xFFD700, // Gold bracelet
                ring: 0xFFD700, // Gold ring
                badge: 0xFFD700, // Gold badge
                shoulderPads: 0xFFD700, // Gold shoulder pads
                elbowPads: 0xFFD700, // Gold elbow pads
                kneePads: 0xFFD700 // Gold knee pads
            }
        },
        bodyShape: {
            height: 1.85,
            width: 0.6,
            torsoSize: 1.2,
            headSize: 1.0
        },
        features: {
            beard: {
                type: 'full',
                color: 0x8B4513, // Brown full beard
                size: 1.2
            },
            eyeColor: 0x0000FF, // Blue eyes
            sparkles: true // Royal sparkles
        }
    });
}

/**
 * EXAMPLE 4: Casual Urban Character (SAMPLE TEMPLATE)
 * 
 * A modern city dweller with casual style and everyday accessories
 * 
 * ⚠️ This is a SAMPLE - modify it or create your own following this pattern!
 */
export function createCasualUrbanNpcFactory(): IBlockCharacterFactory {
    return createCustomizedNpcFactory({
        skinColor: 0xFFDBB3, // Light skin
        clothing: {
            shirtColor: 0x4169E1, // Royal blue shirt
            pantsColor: 0x2F4F4F, // Dark gray pants
            hatColor: 0x000000, // Black beanie
            hatType: 'beanie',
            bootsColor: 0xFFFFFF, // White sneakers
            belt: {
                color: 0x000000, // Black belt
                width: 1.0
            },
            shoes: {
                color: 0xFFFFFF,
                type: 'sneakers' // White sneakers
            },
            accessories: {
                glasses: {
                    type: 'round',
                    color: 0x000000, // Black frames
                    lensColor: 0x87CEEB // Light blue tint
                },
                backpack: 0x808080, // Gray backpack
                watch: 0xC0C0C0, // Silver watch
                bracelet: 0xC0C0C0, // Silver bracelet
                earrings: 0xC0C0C0 // Silver earrings
            }
        },
        bodyShape: {
            height: 1.75,
            width: 0.5,
            headSize: 1.0
        },
        features: {
            beard: {
                type: 'goatee',
                color: 0x654321, // Dark brown goatee
                size: 1.0
            },
            eyeColor: 0x000000 // Black eyes
        }
    });
}

/**
 * EXAMPLE 5: Post-Apocalyptic Survivor Character (SAMPLE TEMPLATE)
 * 
 * A rugged survivor with protective gear and makeshift accessories
 * 
 * ⚠️ This is a SAMPLE - modify it or create your own following this pattern!
 */
export function createSurvivorNpcFactory(): IBlockCharacterFactory {
    return createCustomizedNpcFactory({
        skinColor: 0xD2B48C, // Tan/dirty skin
        clothing: {
            shirtColor: 0x556B2F, // Olive green shirt (military surplus)
            pantsColor: 0x2F4F2F, // Dark green pants
            hatColor: 0x2F2F2F, // Dark gray bandana
            hatType: 'bandana-hat',
            bootsColor: 0x000000, // Black boots
            belt: {
                color: 0x8B4513, // Brown belt
                width: 1.3 // Wide utility belt
            },
            shoes: {
                color: 0x000000,
                type: 'boots' // Heavy boots
            },
            accessories: {
                mask: 0x2F2F2F, // Dark mask
                bandana: 0x8B0000, // Red bandana
                backpack: 0x2F2F2F, // Dark backpack
                gloves: 0x2F2F2F, // Dark gloves
                shoulderPads: 0x556B2F, // Green shoulder pads
                elbowPads: 0x556B2F, // Green elbow pads
                kneePads: 0x556B2F, // Green knee pads
                bandage: 0xFFFFFF, // White bandage (wounded)
                badge: 0xFF0000 // Red badge (warning)
            }
        },
        bodyShape: {
            height: 1.8,
            width: 0.58,
            torsoSize: 1.15
        },
        features: {
            beard: {
                type: 'long',
                color: 0x654321, // Brown long beard
                size: 1.1
            },
            eyeColor: 0xFF4500 // Orange/amber eyes (alert)
        }
    });
}

/**
 * ⚠️ HOW TO USE THE CUSTOMIZATION SYSTEM
 * 
 * **IMPORTANT: The examples above are TEMPLATES, not a limited selection!**
 * 
 * You can create ANY customization you want - these examples just show you HOW.
 * Feel free to modify them, combine elements, or create completely new ones!
 * 
 * ## Step-by-Step Guide:
 * 
 * 1. **Import the function:**
 *    ```typescript
 *    import { createCustomizedNpcFactory } from 'engine/npc/customization/NpcCustomization.js';
 *    ```
 * 
 * 2. **Create your character configuration** (use examples above as templates):
 *    ```typescript
 *    const myCharacterFactory = createCustomizedNpcFactory({
 *         skinColor: 0xFFDBB3, // Light skin (hex color)
 *         clothing: {
 *             shirtColor: 0xFF0000, // Red shirt
 *             pantsColor: 0x0000FF, // Blue pants
 *             hatColor: 0xFFFF00, // Yellow hat
 *             hatType: 'cap', // Hat style
 *             belt: {
 *                 color: 0x000000, // Black belt
 *                 width: 1.0 // Normal width
 *             },
 *             shoes: {
 *                 color: 0xFFFFFF, // White shoes
 *                 type: 'sneakers' // Shoe style
 *             },
 *             accessories: {
 *                 glasses: {
 *                     type: 'round', // round, square, or aviator
 *                     color: 0x000000, // Black frames
 *                     lensColor: 0x87CEEB // Light blue tint (optional)
 *                 },
 *                 beard: {
 *                     type: 'medium', // short, medium, long, goatee, mustache, full
 *                     color: 0x8B4513, // Brown beard
 *                     size: 1.0 // Size multiplier
 *                 },
 *                 necklace: 0xFFD700, // Gold necklace
 *                 backpack: 0x808080, // Gray backpack
 *                 // ... add more accessories as needed
 *             }
 *         },
 *         bodyShape: {
 *             height: 1.75, // Height in meters
 *             width: 0.5, // Width
 *             headSize: 1.0 // Head size multiplier
 *         },
 *         features: {
 *             beard: {
 *                 type: 'medium',
 *                 color: 0x8B4513,
 *                 size: 1.0
 *             },
 *             eyeColor: 0x0000FF, // Blue eyes
 *             sparkles: false // No sparkles
 *         }
 *     });
 *     ```
 * 
 * 3. **Use with NpcManager:**
 *    ```typescript
 *    const npcManager = NpcManager.createEnemy(engine);
 *    await npcManager.spawnNpc(10, 5, myCharacterFactory);
 *    ```
 * 
 * ## Complete List of Available Accessories:
 * 
 * **Head:**
 * - `hatType`: 'cap', 'tophat', 'crown', 'helmet', 'beanie', 'hood', 'bandana-hat', 'cowboy', 'beret', 'visor'
 * - `glasses`: { type: 'round'|'square'|'aviator', color, lensColor? }
 * - `beard`: { type: 'short'|'medium'|'long'|'goatee'|'mustache'|'full', color, size? }
 * - `bandana`: color (number)
 * - `mask`: color (number)
 * - `earrings`: color (number)
 * 
 * **Body:**
 * - `belt`: { color, width? }
 * - `necklace`: color (number)
 * - `backpack`: color (number)
 * - `cape`: color (number)
 * - `scarf`: color (number)
 * - `badge`: color (number)
 * 
 * **Arms:**
 * - `shoulderPads`: color (number)
 * - `elbowPads`: color (number)
 * - `gloves`: color (number)
 * - `bracelet`: color (number)
 * - `watch`: color (number) - appears on left hand
 * - `ring`: color (number)
 * 
 * **Legs:**
 * - `kneePads`: color (number)
 * - `bandage`: color (number) - white bandage
 * 
 * **Feet:**
 * - `shoes`: { color, type: 'sneakers'|'boots'|'sandals'|'dress' }
 * - `bootsColor`: color (number) - alternative to shoes
 * 
 * ## Tips:
 * - Colors are hex numbers (e.g., 0xFF0000 for red, 0x0000FF for blue)
 * - All accessories are optional - only include what you want
 * - You can mix and match any accessories
 * - Size multipliers (like beard.size, belt.width) default to 1.0
 * - **The examples above are TEMPLATES - modify them or create your own!**
 * - **You are NOT limited to these examples - create ANY customization you want!**
 * - **Use these examples to learn HOW, then create your own unique characters!**
 * 
 * ## Creating Your Own Customizations
 * 
 * **Don't feel limited by the examples!** Here's how to create something completely new:
 * 
 * 1. **Start with an example** (or start from scratch)
 * 2. **Change colors** to match your vision
 * 3. **Add/remove accessories** as needed
 * 4. **Adjust body shape** for the character you want
 * 5. **Mix features** from different examples
 * 6. **Experiment!** The system is flexible - try different combinations
 * 
 * **Example: Creating a Custom Character**
 * ```typescript
 * // Want a pirate? Combine elements:
 * const pirateFactory = createCustomizedNpcFactory({
 *     skinColor: 0xD2B48C, // Tan skin
 *     clothing: {
 *         shirtColor: 0x8B4513, // Brown shirt
 *         hatType: 'bandana-hat', // Bandana
 *         hatColor: 0xFF0000, // Red bandana
 *         belt: { color: 0x000000 }, // Black belt
 *         accessories: {
 *             earrings: 0xFFD700, // Gold earrings
 *             mask: 0x000000, // Black eye patch (using mask)
 *             gloves: 0x8B4513 // Brown gloves
 *         }
 *     },
 *     features: {
 *         beard: { type: 'long', color: 0x654321 } // Long brown beard
 *     }
 * });
 * ```
 * 
 * **The possibilities are endless - create whatever you imagine!**
 */

