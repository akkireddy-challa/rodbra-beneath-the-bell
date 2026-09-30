/**
 * 👋 EXAMPLE: Villagers that Follow After Interaction
 * 
 * This example demonstrates how to create villagers using SEPARATE behaviors:
 * - Start with `NpcVillagerBehavior` (idle, shows speech bubbles)
 * - Automatically switches to `NpcFollowBehavior` after player interaction
 * - Uses behavior switching system - two separate behaviors, not one combined behavior
 * 
 * ## Usage in Game.ts
 *
 * ```typescript
 * import { NpcVillagerBehavior } from 'engine/npc/behaviors/NpcVillagerBehavior.js';
 * import { createVillagerNpcFactory } from 'engine/npc/customization/NpcCustomizationPresets.js';
 *
 * // In your Game class:
 * export class YourGame {
 *     async load(): Promise<void> {
 *         // Register follower villager with the engine
 *         const handle = this.engine.registerNpc('followerVillager',
 *             new NpcVillagerBehavior({
 *                 greetingMessages: [
 *                     'I\'ll follow you!',
 *                     'Let me come with you!',
 *                     'I\'m ready to help!',
 *                     'Lead the way!'
 *                 ],
 *                 followAfterInteraction: true,
 *                 followConfig: {
 *                     minDistance: 2.0,
 *                     maxDistance: 15.0,
 *                     updateInterval: 0.5
 *                 }
 *             }), {
 *                 characterFactory: createVillagerNpcFactory()
 *             }
 *         );
 *
 *         // Spawn villager at position (5, 5)
 *         await handle.spawn(5, 5);
 *     }
 * }
 * ```
 * 
 * ## Behavior Flow
 * 
 * 1. **Idle Phase**: NPC uses `NpcVillagerBehavior`, stays at spawn, shows interaction prompt
 * 2. **Interaction**: Player presses E key, villager shows greeting message
 * 3. **Switch**: `NpcVillagerBehavior` calls `requestBehaviorChange()` to switch to follow
 * 4. **Follow Phase**: NPC switches to `NpcFollowBehavior` and follows player
 * 5. **Following**: Villager maintains distance, stops if player too far
 * 
 * ## Key Concept: Separate Behaviors
 * 
 * - **NpcVillagerBehavior**: Handles idle/interaction logic, switches to follow after interaction
 * - **NpcFollowBehavior**: Handles follow logic (separate behavior class)
 * - The switching happens automatically via `requestBehaviorChange()` method
 * 
 * ## Configuration Options
 * 
 * - `greetingMessages`: Array of messages to show when interacted with
 * - `followAfterInteraction`: Enable/disable follow behavior after interaction
 * - `followConfig.minDistance`: Stop moving when this close to player
 * - `followConfig.maxDistance`: Stop following if player goes beyond this distance
 * - `followConfig.updateInterval`: How often to recalculate path
 * 
 * ## Comparison: Regular Villager vs Follower Villager
 * 
 * **Regular Villager** (no follow, uses only NpcVillagerBehavior):
 * ```typescript
 * new NpcVillagerBehavior({
 *     greetingMessages: ['Hello!'],
 *     followAfterInteraction: false // Default - stays as villager
 * })
 * ```
 * 
 * **Follower Villager** (switches to NpcFollowBehavior):
 * ```typescript
 * new NpcVillagerBehavior({
 *     greetingMessages: ['I\'ll follow you!'],
 *     followAfterInteraction: true // Switches to NpcFollowBehavior
 * })
 * ```
 */

import { NpcVillagerBehavior } from 'engine/npc/behaviors/NpcVillagerBehavior.js';
import { BaseNpcManagerBehavior } from 'engine/npc/INpcManagerBehavior.js';
import type { NpcController } from 'engine/npc/core/NpcController.js';
import type { EngineLike } from 'types/game.js';

/**
 * Example manager behavior for villagers that follow after interaction
 */
export class ExampleFollowerVillagerManagerBehavior extends BaseNpcManagerBehavior {
    constructor() {
        super('FollowerVillager', false, 0); // No auto-respawn
    }

    onNpcCreated(npc: NpcController, engine: EngineLike): void {
        // Create villager behavior with follow-after-interaction enabled
        npc.setBehavior(new NpcVillagerBehavior({
            greetingMessages: [
                'I\'ll follow you!',
                'Let me come with you!',
                'I\'m ready to help!',
                'Lead the way!'
            ],
            followAfterInteraction: true, // Enable follow after interaction
            followConfig: {
                minDistance: 2.0, // Stay 2 units away from player
                maxDistance: 15.0, // Stop following if player goes beyond 15 units
                updateInterval: 0.5 // Update path every 0.5 seconds
            }
        }));

        console.log('✅ Follower villager configured! Press E to interact and make them follow!');
    }

    /**
     * Example usage with the new registerNpc API:
     * ```typescript
     * async load() {
     *     const handle = this.engine.registerNpc('followerVillager',
     *         new NpcVillagerBehavior({ followAfterInteraction: true }),
     *         { characterFactory: createVillagerNpcFactory() }
     *     );
     *     await handle.spawn(5, 5);
     * }
     * ```
     */
}

/**
 * Example manager behavior for regular villagers (no follow)
 */
export class ExampleRegularVillagerManagerBehavior extends BaseNpcManagerBehavior {
    constructor() {
        super('RegularVillager', false, 0);
    }

    onNpcCreated(npc: NpcController, engine: EngineLike): void {
        // Regular villager - just shows messages, doesn't follow
        npc.setBehavior(new NpcVillagerBehavior({
            greetingMessages: [
                'Hello there!',
                'Welcome to our village!',
                'Nice day, isn\'t it?',
                'How can I help you?'
            ],
            followAfterInteraction: false // Default - no follow
        }));

        console.log('✅ Regular villager configured!');
    }
}

