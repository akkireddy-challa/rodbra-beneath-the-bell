import type * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import type { ICharacterAnimationController } from 'engine/ICharacterAnimationController.js';
import type { CharacterLoader } from 'engine/loaders/CharacterLoader.js';
import type { SkiMovementHost, SkiMovementCharacter } from 'engine/ski/SkiMovementHost.js';
import { VISUAL_GROUND_SINK_M } from 'engine/loaders/PlayerLoader.js';

/**
 * Adapts an NPC's character to {@link SkiMovementHost} so AI riders run the
 * player's EXACT `SkiMovement` physics instead of a parallel model. It maps the
 * NPC's pieces (root, capsule body, physics world, animation controller, block
 * renderer) onto the host surface; the player-only hooks are no-ops:
 *  - `getCameraController()` → null (NPCs have no chase camera; SkiMovement's
 *    camera calls are feature-detected and skipped).
 *  - the crash-ragdoll hooks → false / null, so a hard NPC impact takes
 *    SkiMovement's non-ragdoll bail path instead of building a player ragdoll.
 *
 * `getFeetOffsetY` returns VISUAL_GROUND_SINK_M — the same fold PlayerLoader
 * now applies — so SkiMovement's visual-height math nets exactly the tuned
 * pre-sink behaviour; the NPC root sits at the hips and the board height is
 * derived from the ground, so no other offset is needed.
 */
export class NpcSkiHost implements SkiMovementHost {
    readonly player: THREE.Object3D;
    readonly playerBody: RAPIER.RigidBody;
    readonly physicsWorld: PhysicsWorld;
    readonly animationController: ICharacterAnimationController | null;
    readonly playerLoader: SkiMovementCharacter;

    constructor(
        character: THREE.Object3D,
        characterBody: RAPIER.RigidBody,
        physicsWorld: PhysicsWorld,
        animationController: ICharacterAnimationController | null,
        characterLoader: CharacterLoader,
    ) {
        this.player = character;
        this.playerBody = characterBody;
        this.physicsWorld = physicsWorld;
        this.animationController = animationController;
        this.playerLoader = {
            getBlockCharacterRenderer: () => characterLoader.getBlockCharacterRenderer(),
            // Matches PlayerLoader's ground-sink fold so SkiMovement's visual
            // height math nets the same as the tuned pre-sink behaviour.
            getFeetOffsetY: () => VISUAL_GROUND_SINK_M,
        };
    }

    getCameraController(): any {
        return null;
    }

    enterTemporaryRagdoll(): boolean {
        return false;
    }

    getTemporaryRagdollState(): null {
        return null;
    }

    exitTemporaryRagdoll(): null {
        return null;
    }
}
