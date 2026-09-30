/**
 * EXAMPLE: How to Create Interactable NPCs with Speech Bubbles
 *
 * NPCs are automatically interactable if their behavior implements onPlayerInteract().
 * No additional setup needed — just implement the method in your behavior!
 *
 * ## Quick Start: Interactable Villager
 *
 * ```typescript
 * import { NpcVillagerBehavior } from 'engine/npc/behaviors/NpcVillagerBehavior.js';
 * import { createVillagerNpcFactory } from 'engine/npc/customization/NpcCustomizationPresets.js';
 *
 * const handle = engine.registerNpc('villager', new NpcVillagerBehavior({
 *     greetingMessages: ['Hello!', 'Welcome!', 'Nice day!']
 * }), {
 *     characterFactory: createVillagerNpcFactory(),
 * });
 * await handle.spawn(10, 5);
 * // Player can now press E near the villager to see speech bubble!
 * ```
 *
 * ## How It Works
 *
 * 1. **NpcController automatically implements Interactable interface**
 *    - Creates a Rapier trigger sensor via InteractableComponent when created
 *    - PlayerController detects NPCs via physics-based trigger overlap (3.0 unit radius)
 *
 * 2. **Behavior handles interaction via onPlayerInteract()**
 *    - Called when player presses E key near NPC
 *    - Return true if interaction was handled
 *    - Use NpcSpeechBubble to show messages above NPC
 *
 * 3. **Speech bubbles automatically position and fade**
 *    - Positioned above NPC head
 *    - Follow NPC movement
 *    - Auto-fade after duration
 *
 * ## Example 1: Simple Villager with Speech Bubble
 */

import { NpcVillagerBehavior } from 'engine/npc/behaviors/NpcVillagerBehavior.js';
import { createVillagerNpcFactory } from 'engine/npc/customization/NpcCustomizationPresets.js';
import type { EngineLike } from 'types/game.js';

export const EXAMPLE_SIMPLE_INTERACTABLE_VILLAGER = `
// Simple interactable villager
const handle = engine.registerNpc('villager', new NpcVillagerBehavior({
    greetingMessages: ['Hello!', 'How can I help you?']
}), {
    characterFactory: createVillagerNpcFactory(),
});
await handle.spawn(10, 5);
`;

/**
 * ## Example 2: Custom Behavior with Speech Bubble
 */

import { NpcIdleBehavior } from 'engine/npc/behaviors/NpcIdleBehavior.js';
import { NpcSpeechBubble } from 'engine/npc/utils/NpcSpeechBubble.js';
import type { NpcController } from 'engine/npc/core/NpcController.js';

export const EXAMPLE_CUSTOM_INTERACTABLE_BEHAVIOR = `
// Custom behavior with speech bubble
import { NpcIdleBehavior } from 'engine/npc/behaviors/NpcIdleBehavior.js';
import { NpcSpeechBubble } from 'engine/npc/utils/NpcSpeechBubble.js';

class MyInteractableBehavior extends NpcIdleBehavior {
    onPlayerInteract(): boolean {
        if (!this.controller) return false;

        // Show speech bubble above NPC
        const engine = this.controller.getEngine();
        const character = this.controller.getCharacter();
        new NpcSpeechBubble(
            character,
            engine,
            'Hello! How can I help you?',
            3000 // Show for 3 seconds
        );

        return true; // Interaction handled
    }
}

const handle = engine.registerNpc('customNpc', new MyInteractableBehavior());
await handle.spawn(10, 5);
`;

/**
 * ## Example 3: Multiple Random Messages
 */

export const EXAMPLE_MULTIPLE_MESSAGES = `
// Villager with multiple random messages
const handle = engine.registerNpc('villager', new NpcVillagerBehavior({
    greetingMessages: [
        'Hello there!',
        'Welcome to our village!',
        'Nice day, isn\\'t it?',
        'How can I help you?',
        'Good to see you!',
        'What brings you here?'
    ]
}), {
    characterFactory: createVillagerNpcFactory(),
});
await handle.spawn(10, 5);
`;

/**
 * ## Example 4: Shopkeeper with Custom Interaction
 */

import { NpcShopkeeperBehavior } from 'engine/npc/behaviors/NpcShopkeeperBehavior.js';

export const EXAMPLE_SHOPKEEPER_INTERACTION = `
// Shopkeeper with custom interaction callback
const handle = engine.registerNpc('shopkeeper', new NpcShopkeeperBehavior({
    shopPosition: new THREE.Vector3(10, 0, 5),
    greetingRange: 5.0,
    onPlayerInteract: () => {
        console.log('Opening shop UI...');
    }
}));
await handle.spawn(10, 5);
`;

/**
 * Key Points for AI Agents
 *
 * 1. **NPCs are automatically interactable** — just implement onPlayerInteract() in behavior
 * 2. **Use NpcSpeechBubble for messages**: new NpcSpeechBubble(character, engine, 'Hello!', 3000)
 * 3. **Get NPC character**: this.controller.getCharacter()
 * 4. **Get engine reference**: this.controller.getEngine()
 * 5. **Return true from onPlayerInteract()** to indicate interaction was handled
 *
 * Common Mistakes:
 * - WRONG: Manually setting userData.interactable (NpcController does it automatically)
 * - WRONG: Not implementing onPlayerInteract() (NPC won't respond to E key)
 * - CORRECT: Implement onPlayerInteract() in behavior and return true
 */

