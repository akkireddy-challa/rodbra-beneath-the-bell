import type * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { EngineLike } from 'types/game.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import type { LegacyNavMesh } from 'engine/LegacyNavMesh.js';
import type { INpcBehavior } from 'engine/npc/INpcBehavior.js';

/**
 * Shared context interface that both NpcController and AnimalController implement.
 * Components and behaviors receive this instead of a concrete controller type,
 * enabling both controllers to share the same component and behavior system.
 */
export interface ICharacterContext {
    getEngine(): EngineLike;
    getCharacter(): THREE.Object3D;
    getPhysicsBody(): RAPIER.RigidBody | null;
    getPhysicsWorld(): PhysicsWorld;
    getNavMesh(): LegacyNavMesh | null;
    getPosition(): THREE.Vector3;
    /** Always false — stun-on-hit was removed from the engine; kept for behavior compat. */
    isStunned(): boolean;
    isDead(): boolean;
    isExploded(): boolean;
    getMoveSpeed(): number;
    setMoveSpeed(speed: number): void;
    setTargetPosition(target: THREE.Vector3 | null, maxPathLength?: number): void;
    requestBehaviorChange(newBehavior: INpcBehavior): void;
    /**
     * Break the character apart from its current pose and remove it: limbs
     * separate as rigid pieces, then each bursts into the character's own
     * colored voxels on impact. No explosion VFX and no terrain damage — use
     * this to "explode"/"detonate"/"destroy" an NPC, NOT `Explosion` or
     * `explodeTerrainSphere` (those crater the world). Only characters
     * rendering a voxelized skinned GLB support this; returns false otherwise,
     * leaving the character intact.
     */
    shatterIntoVoxels(): boolean;
}
