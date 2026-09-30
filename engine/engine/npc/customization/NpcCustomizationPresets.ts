import { createCustomizedNpcFactory } from 'engine/npc/customization/NpcCustomization.js';
import type { IBlockCharacterFactory } from 'engine/IBlockCharacterFactory.js';
import type { NpcCustomizationConfig } from 'engine/npc/customization/NpcCustomization.js';

/**
 * 🎨 NPC Customization Presets - EXAMPLE TEMPLATES
 * 
 * ⚠️ IMPORTANT: These are EXAMPLE TEMPLATES, not a limited selection!
 * 
 * **These presets are SAMPLES that demonstrate how to use the customization system.**
 * You are NOT limited to these - create ANY customization you want!
 * 
 * **How to Use:**
 * 1. **Use as-is**: Copy a preset if it matches what you need
 * 2. **Modify**: Take a preset and change colors, accessories, or features
 * 3. **Create New**: Use these as examples to create completely custom NPCs
 * 4. **Mix & Match**: Combine elements from different presets
 * 
 * **The customization system is FULLY FLEXIBLE** - you can create ANY combination of:
 * - Colors (any hex color)
 * - Accessories (any combination)
 * - Body shapes (any size/proportions)
 * - Features (any combination)
 * 
 * See NpcCustomizationExamples.ts for more detailed examples showing how to create custom characters!
 */

/**
 * Create a warrior NPC preset (SAMPLE TEMPLATE)
 * 
 * ⚠️ This is a SAMPLE - modify it or create your own following this pattern!
 * 
 * Armor, helmet, weapons
 */
export function createWarriorNpcFactory(): IBlockCharacterFactory {
    return createCustomizedNpcFactory({
        skinColor: 0xFFDBB3, // Light skin
        clothing: {
            shirtColor: 0x8B4513, // Brown armor
            pantsColor: 0x654321, // Dark brown pants
            hatColor: 0x808080, // Gray helmet
            hatType: 'helmet',
            bootsColor: 0x000000 // Black boots
        },
        bodyShape: {
            height: 1.8,
            width: 0.55,
            torsoSize: 1.1
        },
        features: {
            eyeColor: 0x0000FF // Blue eyes
        }
    });
}

/**
 * Create a wizard NPC preset (SAMPLE TEMPLATE)
 * 
 * ⚠️ This is a SAMPLE - modify it or create your own following this pattern!
 * 
 * Robes, hat, magical features
 */
export function createWizardNpcFactory(): IBlockCharacterFactory {
    return createCustomizedNpcFactory({
        skinColor: 0xFFDBB3,
        clothing: {
            shirtColor: 0x4B0082, // Indigo robes
            pantsColor: 0x4B0082,
            hatColor: 0x4B0082,
            hatType: 'tophat',
            bootsColor: 0x000000
        },
        bodyShape: {
            height: 1.7,
            width: 0.45
        },
        features: {
            eyeColor: 0x9370DB, // Purple eyes
            sparkles: true // Magical sparkles
        }
    });
}

/**
 * Create an elf NPC preset (pointed ears, nature colors)
 */
export function createElfNpcFactory(): IBlockCharacterFactory {
    return createCustomizedNpcFactory({
        skinColor: 0xFFE4B5, // Pale skin
        clothing: {
            shirtColor: 0x228B22, // Forest green
            pantsColor: 0x006400, // Dark green
            bootsColor: 0x8B4513 // Brown boots
        },
        bodyShape: {
            height: 1.75,
            headSize: 0.9 // Slightly smaller head
        },
        features: {
            ears: { type: 'pointed', color: 0xFFE4B5 },
            eyeColor: 0x00FF00 // Green eyes
        }
    });
}

/**
 * Create a demon NPC preset (horns, dark colors, red eyes)
 */
export function createDemonNpcFactory(): IBlockCharacterFactory {
    return createCustomizedNpcFactory({
        skinColor: 0x8B0000, // Dark red skin
        clothing: {
            shirtColor: 0x000000, // Black
            pantsColor: 0x000000,
            bootsColor: 0x000000
        },
        bodyShape: {
            height: 1.9,
            width: 0.6,
            torsoSize: 1.2
        },
        features: {
            horns: { type: 'large', color: 0x000000 },
            tail: { type: 'long', color: 0x8B0000 },
            eyeColor: 0xFF0000, // Red eyes
            sparkles: false
        }
    });
}

/**
 * Create a cute creature NPC preset (floppy ears, pastel colors)
 */
export function createCuteCreatureNpcFactory(): IBlockCharacterFactory {
    return createCustomizedNpcFactory({
        skinColor: 0xFFB6C1, // Light pink
        clothing: {
            shirtColor: 0xFFE4E1, // Misty rose
            pantsColor: 0xFFE4E1,
            hatColor: 0xFF69B4,
            hatType: 'cap'
        },
        bodyShape: {
            height: 1.5,
            width: 0.4,
            headSize: 1.2 // Big head
        },
        features: {
            ears: { type: 'floppy', color: 0xFFB6C1 },
            tail: { type: 'fluffy', color: 0xFFB6C1 },
            eyeColor: 0x000000
        }
    });
}

/**
 * Create a robot NPC preset (metallic, gray, geometric)
 */
export function createRobotNpcFactory(): IBlockCharacterFactory {
    return createCustomizedNpcFactory({
        skinColor: {
            color: 0xC0C0C0, // Silver
            roughness: 0.2,
            metalness: 0.9
        },
        clothing: {
            shirtColor: 0x808080, // Gray
            pantsColor: 0x808080,
            hatColor: 0x606060,
            hatType: 'helmet'
        },
        bodyShape: {
            height: 1.75,
            width: 0.5
        },
        features: {
            eyeColor: 0x00FFFF // Cyan eyes
        }
    });
}

/**
 * Create a royal NPC preset (crown, elegant colors)
 */
export function createRoyalNpcFactory(): IBlockCharacterFactory {
    return createCustomizedNpcFactory({
        skinColor: 0xFFDBB3,
        clothing: {
            shirtColor: 0xFFD700, // Gold
            pantsColor: 0x8B4513, // Brown
            hatColor: 0xFFD700,
            hatType: 'crown',
            bootsColor: 0x000000
        },
        bodyShape: {
            height: 1.75
        },
        features: {
            eyeColor: 0x000000,
            sparkles: true // Royal sparkles
        }
    });
}

/**
 * Create a villager NPC preset (friendly, simple clothing, neutral colors)
 */
export function createVillagerNpcFactory(): IBlockCharacterFactory {
    return createCustomizedNpcFactory({
        skinColor: 0xFFDBB3, // Light skin
        clothing: {
            shirtColor: 0x8B7355, // Brown/tan shirt
            pantsColor: 0x654321, // Dark brown pants
            bootsColor: 0x4A4A4A // Gray boots
        },
        bodyShape: {
            height: 1.75,
            width: 0.5
        },
        features: {
            eyeColor: 0x000000 // Black eyes
        }
    });
}

/**
 * Create a werewolf NPC preset (furry appearance, darker colors, wolf-like features)
 */
export function createWerewolfNpcFactory(): IBlockCharacterFactory {
    return createCustomizedNpcFactory({
        skinColor: 0x654321, // Brown fur
        clothing: {
            shirtColor: 0x3D2817, // Dark brown torn shirt
            pantsColor: 0x2F1B14, // Very dark brown pants
            bootsColor: 0x000000 // Black boots
        },
        bodyShape: {
            height: 1.9, // Taller
            width: 0.6, // Broader
            torsoSize: 1.15,
            headSize: 1.1 // Larger head
        },
        features: {
            ears: { type: 'pointed', color: 0x654321 }, // Pointed wolf ears
            tail: { type: 'medium', color: 0x654321 }, // Wolf tail
            eyeColor: 0xFF4500, // Orange/amber eyes
            sparkles: false
        }
    });
}

/**
 * Create a random NPC factory with random colors and features
 * Useful for creating varied NPC populations
 */
export function createRandomNpcFactory(): IBlockCharacterFactory {
    const skinColors: number[] = [0xFFDBB3, 0xFFE4B5, 0xF4A460, 0xDEB887, 0xD2B48C];
    const clothingColors: number[] = [0xFF0000, 0x0000FF, 0x00FF00, 0xFFFF00, 0xFF00FF, 0x00FFFF];
    const earTypes: Array<'pointed' | 'round' | 'floppy' | 'none'> = ['pointed', 'round', 'floppy', 'none'];
    const hatTypes: Array<'cap' | 'tophat' | 'crown' | 'helmet'> = ['cap', 'tophat', 'crown', 'helmet'];
    
    // Helper to safely get random array element
    const getRandomElement = <T>(arr: T[]): T => {
        const index = Math.floor(Math.random() * arr.length);
        const element = arr[index];
        if (element === undefined) {
            throw new Error('Array is empty');
        }
        return element;
    };
    
    const randomSkinColor: number = getRandomElement(skinColors);
    const randomEarColor: number = getRandomElement(skinColors);
    
    const config: NpcCustomizationConfig = {
        skinColor: randomSkinColor,
        clothing: {
            shirtColor: getRandomElement(clothingColors),
            pantsColor: getRandomElement(clothingColors),
            hatColor: Math.random() > 0.5 ? getRandomElement(clothingColors) : undefined,
            hatType: Math.random() > 0.5 ? getRandomElement(hatTypes) : undefined
        },
        bodyShape: {
            height: 1.6 + Math.random() * 0.3, // 1.6 to 1.9 meters
            headSize: 0.8 + Math.random() * 0.4 // 0.8 to 1.2
        },
        features: {
            ears: Math.random() > 0.5 ? {
                type: getRandomElement(earTypes) as 'pointed' | 'round' | 'floppy',
                color: randomEarColor
            } : undefined,
            eyeColor: Math.random() > 0.7 ? 0x0000FF : 0x000000,
            sparkles: Math.random() > 0.8
        }
    };

    return createCustomizedNpcFactory(config);
}

/**
 * Quick reference: All available SAMPLE PRESETS
 * 
 * ⚠️ REMEMBER: These are EXAMPLE TEMPLATES, not a limited selection!
 * Use them as-is, modify them, or create your own following their patterns!
 * 
 * **Basic Sample Presets:**
 * - createWarriorNpcFactory() - Armor, helmet, strong build (SAMPLE)
 * - createWizardNpcFactory() - Robes, hat, magical sparkles (SAMPLE)
 * - createElfNpcFactory() - Pointed ears, nature colors (SAMPLE)
 * - createDemonNpcFactory() - Horns, tail, dark colors (SAMPLE)
 * - createVillagerNpcFactory() - Friendly, simple clothing, neutral colors (SAMPLE)
 * - createWerewolfNpcFactory() - Furry, wolf-like features, darker colors (SAMPLE)
 * - createCuteCreatureNpcFactory() - Floppy ears, pastel colors (SAMPLE)
 * - createRobotNpcFactory() - Metallic, gray, geometric (SAMPLE)
 * - createRoyalNpcFactory() - Crown, elegant colors (SAMPLE)
 * - createRandomNpcFactory() - Random appearance for variety (SAMPLE)
 * 
 * **Detailed Sample Examples (with 20+ accessories):**
 * See NpcCustomizationExamples.ts for:
 * - createAdventurerNpcFactory() - Rugged explorer (SAMPLE TEMPLATE)
 * - createCyberpunkNpcFactory() - Futuristic character (SAMPLE TEMPLATE)
 * - createNobleKnightNpcFactory() - Regal warrior (SAMPLE TEMPLATE)
 * - createCasualUrbanNpcFactory() - Modern city dweller (SAMPLE TEMPLATE)
 * - createSurvivorNpcFactory() - Post-apocalyptic survivor (SAMPLE TEMPLATE)
 * 
 * **These examples demonstrate how to use ALL available accessories!**
 * **Use them as templates to create your own unique customizations!**
 */

