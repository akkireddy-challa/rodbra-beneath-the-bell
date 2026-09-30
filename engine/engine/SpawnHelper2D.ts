import type { PhysicsWorld2D } from 'engine/physics/PhysicsWorld2D.js';
import { CollisionGroup } from 'engine/CollisionLayers.js';

/**
 * Collision mask for ground-detection raycasts in 2D spawn validation.
 * Includes terrain and environment (platforms, voxel objects).
 */
const GROUND_MASK = CollisionGroup.TERRAIN | CollisionGroup.ENVIRONMENT;

/**
 * Validate and adjust a 2D spawn position so the player lands on solid ground.
 *
 * Strategy:
 * 1. Raycast DOWN from well above the configured spawn — if it hits ground,
 *    place the player on top.
 * 2. If the downward ray misses (e.g. open air), raycast UP from below to
 *    check whether spawn is inside geometry and find the surface above.
 * 3. If both miss, return the original configured position unchanged.
 *
 * @param physicsWorld The 2D physics world (must have at least one step done)
 * @param spawnX      Configured spawn X
 * @param spawnY      Configured spawn Y
 * @param capsuleHalfHeight Half the capsule height — used to offset above surface
 * @returns Adjusted { x, y } suitable for `RigidBodyDesc.setTranslation()`
 */
export function findValidSpawnPosition2D(
    physicsWorld: PhysicsWorld2D,
    spawnX: number,
    spawnY: number,
    capsuleHalfHeight: number,
): { x: number; y: number } {
    const searchHeight = 200;
    const margin = 0.05;

    // 1. Cast down from high above spawn
    const downResult = physicsWorld.raycast(
        { x: spawnX, y: spawnY + searchHeight },
        { x: 0, y: -1 },
        searchHeight * 2,
        GROUND_MASK,
    );

    if (downResult.hasHit) {
        const surfaceY = downResult.hitPoint.y;
        return { x: spawnX, y: surfaceY + capsuleHalfHeight + margin };
    }

    // 2. Cast up from far below (in case spawn is inside geometry)
    const upResult = physicsWorld.raycast(
        { x: spawnX, y: spawnY - searchHeight },
        { x: 0, y: 1 },
        searchHeight * 2,
        GROUND_MASK,
    );

    if (upResult.hasHit) {
        const surfaceY = upResult.hitPoint.y;
        return { x: spawnX, y: surfaceY + capsuleHalfHeight + margin };
    }

    // 3. No ground found — keep configured position
    return { x: spawnX, y: spawnY };
}
