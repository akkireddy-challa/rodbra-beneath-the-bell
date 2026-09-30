import type * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import type { ICharacterAnimationController } from 'engine/ICharacterAnimationController.js';
import type { PlayerLoader } from 'engine/loaders/PlayerLoader.js';

/**
 * Character access `SkiMovement` needs: the block-character renderer (for the
 * board / foot-IK / visual) and the feet offset (spawn height). `PlayerLoader`
 * satisfies this directly; an NPC supplies the same two methods.
 */
export type SkiMovementCharacter = Pick<PlayerLoader, 'getBlockCharacterRenderer' | 'getFeetOffsetY'>;

/**
 * The controller `SkiMovement` drives. `PlayerController` satisfies this directly;
 * an NPC controller can satisfy it too so AI riders share the player's EXACT ski
 * physics (rather than a parallel model). The camera and crash-ragdoll hooks are
 * player-only — an NPC returns `null` (camera) / `null` (ragdoll state) and the
 * movement feature-detects them.
 *
 * `playerBody` and the active `physicsWorld` are passed into `update()` directly,
 * so they are not part of this interface.
 */
export interface SkiMovementHost {
    /** Visual root the movement positions/rotates (≈ hips). */
    readonly player: THREE.Object3D;
    /** Kinematic capsule body the movement drives (read for teleport/crash; the
     *  active body is also passed into `update()`). */
    readonly playerBody: RAPIER.RigidBody;
    /** Physics world (used outside the per-frame `update()` path, e.g. crash). */
    readonly physicsWorld: PhysicsWorld;
    /** Drives the tuck/lean/foot-IK pose; null if the host has no character yet. */
    readonly animationController: ICharacterAnimationController | null;
    /** Block-character access for the board / foot-IK / spawn height. */
    readonly playerLoader: SkiMovementCharacter | null;
    /** Active chase camera to feed, or null (e.g. NPCs). Methods are feature-detected. */
    getCameraController(): any;
    /** Hand the body to a crash ragdoll; returns true if one was started. */
    enterTemporaryRagdoll(hubVelocity?: THREE.Vector3): boolean;
    /** Active crash-ragdoll transform while bailing, else null. */
    getTemporaryRagdollState(): { position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number }; speed: number } | null;
    /** End the crash ragdoll; returns the stand-up position, else null. */
    exitTemporaryRagdoll(): { x: number; y: number; z: number } | null;
}
