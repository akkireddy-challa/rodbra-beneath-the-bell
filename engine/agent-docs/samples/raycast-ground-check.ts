/**
 * Ground probe + line-of-sight raycasts against the physics world.
 *
 * Referenced from agent docs (read-docs name: `samples/raycast-ground-check`).
 * Compiled against the live engine by game's `pnpm run check`
 * (tsconfig.docs-samples.json) — an engine API change breaks this file loudly.
 */
import * as THREE from 'three';
import type { GameEngine } from 'engine/GameEngine.js';
import { CollisionGroup, CollisionMask } from 'engine/CollisionLayers.js';

/**
 * Height of the ground directly under `position`, or null when nothing solid
 * is within `maxDrop` meters below (or physics isn't ready yet).
 */
export function groundHeightUnder(engine: GameEngine, position: THREE.Vector3, maxDrop = 50): number | null {
    if (!engine.physicsWorld) return null; // Rapier loads async — physics may not be up yet
    const origin = new THREE.Vector3(position.x, position.y + 0.1, position.z);
    const down = new THREE.Vector3(0, -1, 0);
    // TERRAIN | ENVIRONMENT is what "standable ground" means: voxel terrain chunks
    // plus static structures. Sensor colliders (water, triggers) never register hits.
    const hit = engine.physicsWorld.raycast(origin, down, maxDrop, CollisionGroup.TERRAIN | CollisionGroup.ENVIRONMENT);
    return hit.hasHit ? hit.hitPoint.y : null;
}

/** True when nothing solid blocks the segment from `eye` to `target`. */
export function hasLineOfSight(engine: GameEngine, eye: THREE.Vector3, target: THREE.Vector3): boolean {
    if (!engine.physicsWorld) return false;
    const direction = new THREE.Vector3().subVectors(target, eye);
    const distance = direction.length();
    if (distance < 1e-6) return true;
    direction.normalize();
    const hit = engine.physicsWorld.raycast(eye, direction, distance, CollisionMask.ALL);
    return !hit.hasHit;
}
