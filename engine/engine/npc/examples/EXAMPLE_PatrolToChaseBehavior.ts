/**
 * 🎯 EXAMPLE: Enemy NPCs that Patrol and Switch to Chase
 * 
 * This example demonstrates how to create enemies using SEPARATE behaviors:
 * - Start with `NpcPatrolBehavior` (patrols between waypoints)
 * - Automatically switches to `NpcHostileBehavior` (chase) when player detected
 * - Uses behavior switching system - two separate behaviors, not one combined behavior
 * 
 * ## Usage in Game.ts
 *
 * ```typescript
 * import { NpcPatrolBehavior } from 'engine/npc/behaviors/NpcPatrolBehavior.js';
 * import * as THREE from 'three';
 *
 * // In your Game class:
 * export class YourGame {
 *     async load(): Promise<void> {
 *         // Register patrol enemy with the engine
 *         const handle = this.engine.registerNpc('patrolEnemy',
 *             new NpcPatrolBehavior({
 *                 waypoints: [
 *                     new THREE.Vector3(10, 0, 5),
 *                     new THREE.Vector3(20, 0, 5),
 *                     new THREE.Vector3(20, 0, 15),
 *                     new THREE.Vector3(10, 0, 15)
 *                 ],
 *                 patrolMode: 'circular',
 *                 waitTimeAtWaypoint: 2.0,
 *                 detectPlayerRange: 8.0,
 *                 chaseBehaviorConfig: {
 *                     detectionRange: 15.0,
 *                     attackRange: 2.0,
 *                     chaseSpeed: 3.5,
 *                     returnToOrigin: false
 *                 }
 *             }), { hostile: true, autoRespawnDelay: 5.0 }
 *         );
 *
 *         // Spawn enemy at position (10, 5)
 *         await handle.spawn(10, 5);
 *     }
 * }
 * ```
 * 
 * ## Behavior Flow
 * 
 * 1. **Patrol Phase**: NPC uses `NpcPatrolBehavior`, moves between waypoints
 * 2. **Detection**: When player enters `detectPlayerRange`, `NpcPatrolBehavior` calls `requestBehaviorChange()`
 * 3. **Chase Phase**: NPC switches to `NpcHostileBehavior` and chases player
 * 4. **Permanent**: Once switched, NPC stays in chase mode (doesn't return to patrol)
 * 
 * ## Key Concept: Separate Behaviors
 * 
 * - **NpcPatrolBehavior**: Handles patrol logic, detects player, switches to hostile
 * - **NpcHostileBehavior**: Handles chase logic (separate behavior class)
 * - The switching happens automatically via `requestBehaviorChange()` method
 * 
 * ## Configuration Options
 * 
 * - `waypoints`: Array of Vector3 positions to patrol between
 * - `patrolMode`: 'circular' (loops) or 'ping-pong' (back and forth)
 * - `waitTimeAtWaypoint`: Seconds to wait at each waypoint
 * - `detectPlayerRange`: Distance to detect player and switch behaviors
 * - `chaseBehaviorConfig`: Configuration for the `NpcHostileBehavior` it switches to
 */

import { NpcPatrolBehavior } from 'engine/npc/behaviors/NpcPatrolBehavior.js';
import { BaseNpcManagerBehavior } from 'engine/npc/INpcManagerBehavior.js';
import type { NpcController } from 'engine/npc/core/NpcController.js';
import type { EngineLike } from 'types/game.js';
import * as THREE from 'three';

/**
 * Example manager behavior for patrol-to-chase enemies
 * Uses SEPARATE behaviors: NpcPatrolBehavior → NpcHostileBehavior
 */
export class ExamplePatrolEnemyManagerBehavior extends BaseNpcManagerBehavior {
    constructor() {
        super('PatrolEnemy', true, 5.0); // Auto-respawn after 5 seconds
    }

    onNpcCreated(npc: NpcController, engine: EngineLike): void {
        // Define patrol waypoints in a square pattern
        const spawnPos = npc.getPosition();
        const waypoints = [
            spawnPos.clone(),
            spawnPos.clone().add(new THREE.Vector3(10, 0, 0)),
            spawnPos.clone().add(new THREE.Vector3(10, 0, 10)),
            spawnPos.clone().add(new THREE.Vector3(0, 0, 10))
        ];

        // Start with PATROL behavior - it will automatically switch to HOSTILE behavior
        npc.setBehavior(new NpcPatrolBehavior({
            waypoints: waypoints,
            patrolMode: 'circular',
            waitTimeAtWaypoint: 2.0,
            detectPlayerRange: 8.0, // Switch to chase when player within 8 units
            chaseBehaviorConfig: {
                // Configuration for the NpcHostileBehavior it switches to
                detectionRange: 15.0,
                attackRange: 2.0,
                chaseSpeed: 3.5,
                returnToOrigin: false
            }
        }));

        console.log('✅ Patrol enemy configured! Will switch to chase when player detected.');
    }

    /**
     * Example usage with the new registerNpc API:
     * ```typescript
     * async load() {
     *     const handle = this.engine.registerNpc('patrolEnemy',
     *         new ExamplePatrolEnemyManagerBehavior(), { hostile: true }
     *     );
     *     await handle.spawn(10, 5);
     * }
     * ```
     */
}

