// NetworkAnimalController: lightweight controller for remote (non-owner) animals.
// Builds block-based animal geometry using BlockAnimalBodyBuilder and drives
// procedural animations from network state via BlockAnimalAnimationController.
//
// Local animals use AnimalController (physics + AI + animation).
// Remote animals use NetworkAnimalController (visual-only, network-driven).
//
// USAGE:
//
//   // In onUnknownObject callback (when state.objectType === 'animal'):
//   const remoteAnimal = NetworkAnimalController.create({
//       engine,
//       networkId,
//       initialState: state,
//       animalType: state.animalType ?? 'Dog',
//   });
//   networkManager.registerObject(remoteAnimal.getNetworkObject());
//
//   // Every frame:
//   remoteAnimal.update(deltaTime);
//
//   // On player left:
//   remoteAnimal.dispose();

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { BlockAnimalAnimationController } from 'engine/animal/BlockAnimalAnimationController.js';
import { createAnimalBlockCharacterFactory, convertGroupToLambertLighting } from 'engine/animal/AnimalController.js';
import { createBlockAnimalFactory, type BlockAnimalBodyConfig } from 'engine/animal/BlockAnimalBodyBuilder.js';
import { CollisionGroup, makeCollisionGroups } from 'engine/CollisionLayers.js';
import { registerPhysicsBody, unregisterPhysicsBody } from 'engine/PhysicsBodyRegistry.js';
import { NetworkObject } from 'engine/networking/NetworkObject.js';
import { createNameLabelSprite } from 'engine/networking/NetworkUtils.js';
import type { StateMessage, AnimationStateReceiver } from 'engine/networking/NetworkTypes.js';
import type { EngineLike } from 'types/game.js';
import type { IBlockCharacterFactory } from 'engine/IBlockCharacterFactory.js';

/** Parameters for NetworkAnimalController.create() */
export interface NetworkAnimalCreateParams {
    /** Engine reference (for scene) */
    engine: EngineLike;
    /** Network ID from the received StateMessage */
    networkId: string;
    /** Initial state message (position, rotation, speed, animation) */
    initialState: StateMessage;
    /** Animal species type (e.g. 'Dog', 'Horse', 'Tiger') */
    animalType: string;
    /** Optional display name for the floating name label. Defaults to animalType. */
    displayName?: string;
    /** Optional block character factory. If not provided, uses the default generic animal factory. */
    blockCharacterFactory?: IBlockCharacterFactory;
    /**
     * Serialized BlockAnimalBodyConfig received from the host via state messages.
     * When provided, the remote animal is built with identical block geometry
     * (same colors, shapes, proportions) as the host's animal.
     * Falls back to generic factory when not provided.
     */
    animalConfig?: unknown;
}

/**
 * Controller for remote (non-owner) networked animals.
 *
 * Encapsulates the full animal visual pipeline:
 * - Block-based animal geometry (via BlockAnimalBodyBuilder or default factory)
 * - BlockAnimalAnimationController for procedural walk/run/idle animations
 * - NetworkObject for position/rotation/animation interpolation
 * - Floating name label sprite
 *
 * Unlike NetworkCharacterController, this does NOT use GLB skeletons or
 * CharacterLoader — animals are pure block geometry with procedural animation.
 */
export class NetworkAnimalController {
    private engine: EngineLike;
    private networkId: string = '';
    private rootGroup: THREE.Group = new THREE.Group();
    private characterGroup: THREE.Group = new THREE.Group();
    private animationController: BlockAnimalAnimationController;
    private nameLabel: THREE.Sprite | null = null;
    private networkObject: NetworkObject | null = null;
    private disposed: boolean = false;
    private animalHeight: number = 1.0;
    /** Vertical offset from rootGroup.position.y to physics body center. */
    private physicsBodyYOffset: number = 0;
    /** Kinematic physics body for projectile hit detection on remote clients. */
    private physicsBody: RAPIER.RigidBody | null = null;

    private constructor(engine: EngineLike) {
        this.engine = engine;
        this.animationController = new BlockAnimalAnimationController();
    }

    /**
     * Create a fully initialized remote animal.
     * Builds block geometry, creates animation controller + NetworkObject + name label.
     */
    static create(params: NetworkAnimalCreateParams): NetworkAnimalController {
        const {
            engine, networkId, initialState, animalType,
        } = params;
        const displayName = params.displayName ?? animalType;

        const ctrl = new NetworkAnimalController(engine);
        ctrl.networkId = networkId;

        // 1. Create root group, position from initial state
        const rootGroup = ctrl.rootGroup;
        rootGroup.name = `NetworkAnimal_${animalType}_${networkId}`;
        rootGroup.position.set(
            initialState.position.x,
            initialState.position.y,
            initialState.position.z,
        );
        rootGroup.quaternion.set(
            initialState.quaternion.x, initialState.quaternion.y,
            initialState.quaternion.z, initialState.quaternion.w,
        );

        // 2. Build block animal mesh
        const characterGroup = ctrl.characterGroup;
        characterGroup.name = `${animalType}_BlockCharacter`;
        rootGroup.add(characterGroup);

        // Build factory: explicit > from network config > generic fallback
        let factory: IBlockCharacterFactory;
        if (params.blockCharacterFactory) {
            factory = params.blockCharacterFactory;
        } else if (params.animalConfig) {
            // Use the host's BlockAnimalBodyConfig to build identical visuals
            factory = createBlockAnimalFactory(params.animalConfig as BlockAnimalBodyConfig);
        } else {
            factory = createAnimalBlockCharacterFactory();
        }
        factory.createBlockCharacter(characterGroup);

        // Convert MeshStandardMaterial to MeshLambertMaterial for consistent lighting
        convertGroupToLambertLighting(characterGroup);

        // Measure animal dimensions and apply feet offset
        // The host's AnimalController sends character.position with feet at ground level.
        // We must offset the block mesh so its feet align with rootGroup.position.y.
        rootGroup.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(rootGroup);
        ctrl.animalHeight = box.getSize(new THREE.Vector3()).y;

        // Compute feet offset: distance from characterGroup origin to the bottom of the mesh.
        // If the mesh bottom is below origin (min.y < rootGroup.y), shift the group up.
        const feetOffsetY = box.min.y - rootGroup.position.y;
        if (Math.abs(feetOffsetY) > 0.001) {
            characterGroup.position.y -= feetOffsetY;
        }

        // 3. Create kinematic physics body for projectile hit detection.
        // Remote animals need a collider so local projectiles can detect hits.
        // Tagged as 'remoteAnimal' so Projectile.ts can distinguish from host-owned animals.
        const physicsWorld = engine.physicsWorld;
        if (physicsWorld) {
            const size = box.getSize(new THREE.Vector3());
            // Use a capsule collider matching the animal's bounding box
            const capsuleHeight = Math.max(0.3, size.y * 0.9);
            const capsuleRadius = Math.max(0.15, Math.min(Math.max(size.x, size.z) / 2 * 0.8, 0.5));
            const halfHeight = Math.max(0, (capsuleHeight - 2 * capsuleRadius) / 2);

            ctrl.physicsBodyYOffset = capsuleHeight / 2 + 0.01;
            const bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
                .setTranslation(
                    rootGroup.position.x,
                    rootGroup.position.y + ctrl.physicsBodyYOffset,
                    rootGroup.position.z,
                );
            const body = physicsWorld.createRigidBody(bodyDesc);
            body.lockRotations(true, true);

            const colliderDesc = RAPIER.ColliderDesc.capsule(halfHeight, capsuleRadius)
                .setFriction(0)
                .setRestitution(0)
                // Membership: ANIMAL (so projectiles' mask matches).
                // Filter: PROJECTILE only (we only care about bullet hits, not player/terrain/etc).
                .setCollisionGroups(makeCollisionGroups(CollisionGroup.ANIMAL, CollisionGroup.PROJECTILE))
                // Solver groups = 0: no physical response (no pushing/bouncing),
                // but Rapier still fires collision events for hit detection.
                .setSolverGroups(0);

            physicsWorld.createCollider(colliderDesc, body);
            registerPhysicsBody(body, 'remoteAnimal');
            physicsWorld.setUserData(body, {
                __type: 'remoteAnimal',
                networkId,
            });
            ctrl.physicsBody = body;
        }

        // 4. Add to scene
        if (engine.scene) {
            engine.scene.add(rootGroup);
        }

        // 5. Initialize animation controller
        void ctrl.animationController.initializeWithCharacter(characterGroup, null, null, []);

        // 6. Create AnimationStateReceiver
        const animController = ctrl.animationController;
        const animReceiver: AnimationStateReceiver = {
            applyAnimationState(animState: string, _speed: number): void {
                // Set animation state directly from network — the host already
                // computed the correct state, so we don't use updateAnimation()
                // (which would re-derive state from speed thresholds and potentially
                // override the host's authoritative state).
                animController.setState(animState);
            },
        };

        // 7. Create NetworkObject (non-owner)
        const zeroVelocity = { x: 0, y: 0, z: 0 };
        const netObj = new NetworkObject(rootGroup, networkId, false, {
            velocityGetter: () => zeroVelocity,
            animationReceiver: animReceiver,
        });
        netObj.applyState(initialState);
        ctrl.networkObject = netObj;

        // 8. Create name label
        ctrl.nameLabel = createNameLabelSprite(displayName);
        if (engine.scene) {
            engine.scene.add(ctrl.nameLabel);
        }
        ctrl.nameLabel.position.copy(rootGroup.position);
        ctrl.nameLabel.position.y += ctrl.animalHeight + 0.3;

        return ctrl;
    }

    /**
     * Advance animation and update visuals. Call every frame.
     * Note: NetworkObject.updateInterpolation() is called automatically by NetworkManager.update().
     */
    update(deltaTime: number): void {
        if (this.disposed) return;

        // Advance procedural animation
        this.animationController.update(deltaTime);

        // Sync kinematic physics body with interpolated visual position
        if (this.physicsBody) {
            const pos = this.rootGroup.position;
            this.physicsBody.setNextKinematicTranslation({
                x: pos.x,
                y: pos.y + this.physicsBodyYOffset,
                z: pos.z,
            });
        }

        // Update name label position
        if (this.nameLabel) {
            this.nameLabel.position.copy(this.rootGroup.position);
            this.nameLabel.position.y += this.animalHeight + 0.3;
        }
    }

    /** Clean up all resources. Call when the remote animal disconnects. */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;

        // Destroy network object
        if (this.networkObject) {
            this.networkObject.destroy();
        }

        // Remove physics body
        if (this.physicsBody && this.engine.physicsWorld) {
            unregisterPhysicsBody(this.physicsBody);
            this.engine.physicsWorld.removeRigidBody(this.physicsBody);
            this.physicsBody = null;
        }

        // Dispose animation controller
        this.animationController.dispose();

        // Remove and dispose character geometry. Voxel-detail meshes share
        // refcounted cached geometry — release the reference instead of
        // disposing it out from under other animals using the same config.
        this.characterGroup.traverse((child: THREE.Object3D) => {
            if ((child as THREE.Mesh).isMesh) {
                const mesh = child as THREE.Mesh;
                if (mesh.userData.sharedDetailGeometry && typeof mesh.userData.releaseSharedGeometry === 'function') {
                    mesh.userData.releaseSharedGeometry();
                } else if (mesh.geometry) {
                    mesh.geometry.dispose();
                }
                const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
                materials.forEach(m => m.dispose());
            }
        });

        // Remove root group from scene
        if (this.engine.scene) {
            this.engine.scene.remove(this.rootGroup);
        }

        // Dispose name label
        if (this.nameLabel) {
            if (this.engine.scene) {
                this.engine.scene.remove(this.nameLabel);
            }
            const mat = this.nameLabel.material as THREE.SpriteMaterial;
            mat.map?.dispose();
            mat.dispose();
            this.nameLabel = null;
        }
    }

    /** Get the root Object3D (driven by NetworkObject interpolation) */
    getObject3D(): THREE.Object3D {
        return this.rootGroup;
    }

    /** Get the network ID for this remote animal */
    getNetworkId(): string {
        return this.networkId;
    }

    /** Get the NetworkObject for registering with NetworkManager */
    getNetworkObject(): NetworkObject {
        if (!this.networkObject) throw new Error('NetworkAnimalController not initialized');
        return this.networkObject;
    }
}
