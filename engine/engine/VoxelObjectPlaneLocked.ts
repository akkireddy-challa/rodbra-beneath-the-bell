/**
 * The 2D-physics lane's bodies for a `VoxelObject` — kept out of VoxelObject.ts
 * only for that file's size cap. Each function is the whole of one branch
 * VoxelObject takes when `isPlaneLockedPhysics(physicsWorld)` holds: the
 * object's greedy boxes carried through its transform and sliced onto the
 * gameplay plane (engine/physics/EnvObject2D.ts) as Rapier 2D cuboids.
 */
import type RAPIER from '@dimforge/rapier3d-compat';
import type * as THREE from 'three';
import type { PhysicsBox } from 'engine/VoxelOctreeRenderer.js';
import type { PlaneLockedPhysics } from 'engine/physics/PlaneLockedPhysics.js';
import { CollisionGroup, CollisionMask, makeCollisionGroups } from 'engine/CollisionLayers.js';

export interface PlaneLockedVoxelBody {
    rigidBody: RAPIER.RigidBody;
    colliders: RAPIER.Collider[];
}

interface Transform {
    translation: { x: number; y: number; z: number };
    rotation: THREE.Quaternion | { x: number; y: number; z: number; w: number };
    scale: { x: number; y: number; z: number };
}

/**
 * A fixed body at the object's transform (`createPhysicsBody` / `createPhysicsBodyAtPosition`).
 * `terrain` marks a baked level map (`asTerrain`): on the ground plane it is floor
 * the heightmap takes, not an obstacle.
 */
export function planeLockedStaticBody(
    physicsWorld: PlaneLockedPhysics,
    boxes: readonly PhysicsBox[],
    transform: Transform,
    collisionGroups: number,
    userData: unknown,
    terrain: boolean = false,
): PlaneLockedVoxelBody {
    const built = physicsWorld.createEnvironmentBody({
        boxes, transform, kind: 'fixed', collisionGroups, friction: 0.7, restitution: 0, userData, terrain,
    });
    return {
        rigidBody: built.body as unknown as RAPIER.RigidBody,
        colliders: built.colliders as unknown as RAPIER.Collider[],
    };
}

/**
 * A dynamic prop with the sliced cuboids at one shared density, so its mass is
 * the authored one. Sphere colliders and CCD are 3D-lane options; the prop
 * still moves and rests correctly.
 */
export function planeLockedDynamicBody(
    physicsWorld: PlaneLockedPhysics,
    boxes: readonly PhysicsBox[],
    transform: Transform,
    mass: number,
    userData: unknown,
): PlaneLockedVoxelBody {
    const built = physicsWorld.createEnvironmentBody({
        boxes, transform, kind: { dynamic: { mass } },
        collisionGroups: makeCollisionGroups(CollisionGroup.DYNAMIC_PROP, CollisionMask.DYNAMIC_PROP),
        friction: 0.5, restitution: 0.3, userData,
    });
    return {
        rigidBody: built.body as unknown as RAPIER.RigidBody,
        colliders: built.colliders as unknown as RAPIER.Collider[],
    };
}
