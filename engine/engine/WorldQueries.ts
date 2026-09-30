import * as THREE from 'three';
import type { WorldProfileData } from 'types/game.js';
import { CollisionGroup } from 'engine/CollisionLayers.js';
import type { PhysicsWorld, RaycastResult } from 'engine/physics/PhysicsWorld.js';

/**
 * Stateless world-space queries extracted from GameEngine (max-lines cap).
 * GameEngine keeps thin public delegates; the scratch objects live here so
 * per-frame callers stay allocation-free.
 */

const heightRayOrigin = new THREE.Vector3();
const heightRayDir = new THREE.Vector3(0, -1, 0);
const heightRayResult: RaycastResult = {
    hasHit: false,
    hitPoint: new THREE.Vector3(),
    hitNormal: new THREE.Vector3(),
    hitDistance: Infinity,
    hitCollider: null,
    hitRigidBody: null,
};

/** Ground height at (x, z): raycast down against TERRAIN + ENVIRONMENT. 0 when nothing hit. */
export function queryWorldHeightAt(physicsWorld: PhysicsWorld | null, x: number, z: number): number {
    if (!physicsWorld) return 0;
    const origin = heightRayOrigin.set(x, 500, z);
    const maxDistance = 600; // From 500 to -100
    const result = physicsWorld.raycast(origin, heightRayDir, maxDistance, CollisionGroup.TERRAIN | CollisionGroup.ENVIRONMENT, heightRayResult);
    return result.hasHit ? result.hitPoint.y : 0;
}

/**
 * World-space centre of the active level, ground-snapped.
 *
 * Procedural voxel worlds are centred on the origin, so this returns (0, 0).
 * Baked (.vwld) levels are CORNER-origin — their content occupies [0, size] —
 * so the centre is (size/2, size/2). Use this whenever you need "the middle of
 * the world" (arena centre, enemy spawn rings, zone centre): on a baked level a
 * hardcoded (0, 0) is the CORNER, not the centre.
 */
export function queryWorldCenter(physicsWorld: PhysicsWorld | null, profile: WorldProfileData | undefined): THREE.Vector3 {
    const sizeX = profile?.groundWorldSizeX ?? 0;
    const sizeZ = profile?.groundWorldSizeZ ?? 0;
    // Baked levels start at the origin corner; procedural worlds are centred.
    const cx = profile?.voxelUrl ? sizeX / 2 : 0;
    const cz = profile?.voxelUrl ? sizeZ / 2 : 0;
    return new THREE.Vector3(cx, queryWorldHeightAt(physicsWorld, cx, cz), cz);
}
