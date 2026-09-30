import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import { isPlaneLockedPhysics } from 'engine/physics/PlaneLockedPhysics.js';
import type { EngineLike } from 'types/game.js';
import { CollisionGroup, CollisionMask, makeCollisionGroups } from 'engine/CollisionLayers.js';

/**
 * Configuration for explosion behavior.
 */
export interface ExplosionConfig {
    /** Half-size of each exploded block's physics collider (NPC: 0.1, Animal: 0.08) */
    blockSize: number;
    /** Minimum explosion force (NPC: 4, Animal: 3) */
    forceMin: number;
    /** Maximum explosion force (NPC: 6, Animal: 5) */
    forceMax: number;
    /**
     * Time in milliseconds before debris auto-cleanup.
     * Set to 0 or negative to disable auto-cleanup (debris persists until dispose() is called).
     * Default: 3000 (3 seconds) — long enough to read the "burst into pieces" death,
     * short enough that rapid kills don't pile up hundreds of meshes + bodies.
     */
    debrisLifetimeMs?: number;
    /** Optional callback to register physics body (e.g. registerPhysicsBody) */
    onBodyCreated?: (body: RAPIER.RigidBody) => void;
}

/**
 * Callbacks for controller-specific explosion operations.
 */
export interface ExplosionCallbacks {
    getEngine(): EngineLike;
    getPhysicsWorld(): PhysicsWorld;
    getCharacter(): THREE.Object3D;
    getPhysicsBody(): RAPIER.RigidBody | null;
    /** Collect meshes to explode (NPC: from blockCharacterRenderer, Animal: from character) */
    collectMeshes(): THREE.Mesh[];
    /** Called after explosion to clean up original character and physics body */
    onPostExplosion(): void;
    /** Restore damage flash materials before cloning meshes */
    restoreFlashImmediately(): void;
}

/**
 * BlockExplosionComponent - Manages death explosion into physics blocks.
 * Shared between NpcController and AnimalController.
 */
export class BlockExplosionComponent {
    /**
     * Global ceiling on live debris pieces across EVERY exploding character.
     * Each piece is a separate mesh (draw call) + dynamic rigid body, so a big
     * fight (many deaths within the debris lifetime) would otherwise accumulate
     * an unbounded pile that drags the frame rate down until it clears. When a
     * new explosion pushes past this, the oldest debris is recycled first.
     */
    private static readonly MAX_ACTIVE_DEBRIS = 96;
    /** All live debris, oldest first — the recycle queue for the global cap. */
    private static readonly activeDebris: Array<{ owner: BlockExplosionComponent; mesh: THREE.Mesh }> = [];

    private blockPhysicsBodies: Map<THREE.Mesh, RAPIER.RigidBody> = new Map();
    private config: ExplosionConfig;
    private callbacks: ExplosionCallbacks;

    // Reusable temp vectors for sync performance
    private syncTempVec3: THREE.Vector3 = new THREE.Vector3();
    private syncTempQuat: THREE.Quaternion = new THREE.Quaternion();

    constructor(config: ExplosionConfig, callbacks: ExplosionCallbacks) {
        this.config = config;
        this.callbacks = callbacks;
    }

    setDebrisLifetimeMs(ms: number): void {
        this.config.debrisLifetimeMs = ms;
    }

    hasExplodedBlocks(): boolean {
        return this.blockPhysicsBodies.size > 0;
    }

    /**
     * Snapshot of currently-live debris pieces. Caller can read positions,
     * apply impulses / set velocities on the body, or move the mesh — and the
     * existing per-frame `syncExplodedBlocks()` keeps the mesh in step with
     * the body. Pair with `setDebrisLifetimeMs(0)` to disable auto-cleanup
     * if you want to drive lifetime yourself, then call `removeDebrisPiece`
     * when you're done with each.
     */
    getDebrisPieces(): { mesh: THREE.Mesh; body: RAPIER.RigidBody }[] {
        return Array.from(this.blockPhysicsBodies, ([mesh, body]) => ({ mesh, body }));
    }

    /**
     * Remove one debris piece: drops the rapier body, removes the mesh from
     * the scene, disposes geometry + material, and clears the map entry.
     * Returns true if the piece was tracked. Safe to call multiple times.
     */
    removeDebrisPiece(mesh: THREE.Mesh): boolean {
        const body = this.blockPhysicsBodies.get(mesh);
        if (!body) return false;
        const physicsWorld = this.callbacks.getPhysicsWorld();
        if (physicsWorld) physicsWorld.removeRigidBody(body);
        this.disposeMesh(mesh);
        this.blockPhysicsBodies.delete(mesh);
        const registry = BlockExplosionComponent.activeDebris;
        const idx = registry.findIndex(d => d.mesh === mesh);
        if (idx !== -1) registry.splice(idx, 1);
        return true;
    }

    /** Detach a debris mesh from its parent and dispose its geometry + material(s). */
    private disposeMesh(mesh: THREE.Mesh): void {
        if (mesh.parent) mesh.parent.remove(mesh);
        mesh.geometry.dispose();
        if (Array.isArray(mesh.material)) {
            mesh.material.forEach(m => m.dispose());
        } else {
            mesh.material.dispose();
        }
    }

    explode(): void {
        const engine = this.callbacks.getEngine();
        const physicsWorld = this.callbacks.getPhysicsWorld();
        if (!engine || !engine.scene || !physicsWorld) return;

        this.callbacks.restoreFlashImmediately();

        const meshes = this.callbacks.collectMeshes();
        if (meshes.length === 0) return;

        meshes.forEach((originalMesh) => {
            const geometry = originalMesh.geometry.clone();
            const material = (originalMesh.material as THREE.Material).clone();

            const blockMesh = new THREE.Mesh(geometry, material);
            blockMesh.castShadow = true;
            blockMesh.receiveShadow = true;
            blockMesh.layers.enable(1);

            const worldPos = new THREE.Vector3();
            const worldQuat = new THREE.Quaternion();
            originalMesh.getWorldPosition(worldPos);
            originalMesh.getWorldQuaternion(worldQuat);
            blockMesh.position.copy(worldPos);
            blockMesh.quaternion.copy(worldQuat);

            const explosionForce = this.config.forceMin + Math.random() * (this.config.forceMax - this.config.forceMin);
            const randomDirection = new THREE.Vector3(
                (Math.random() - 0.5) * 2,
                Math.random() * 0.5 + 0.3,
                (Math.random() - 0.5) * 2
            ).normalize();
            const initialVelocity = randomDirection.multiplyScalar(explosionForce);

            const blockBody = this.createBlockPhysicsBody(physicsWorld, worldPos, worldQuat, initialVelocity);

            engine.scene!.add(blockMesh);
            this.blockPhysicsBodies.set(blockMesh, blockBody);

            // Set auto-cleanup time if configured (0 or negative = no auto-cleanup)
            const lifetime = this.config.debrisLifetimeMs ?? 3000;
            if (lifetime > 0) {
                blockMesh.userData.disposeTime = Date.now() + lifetime;
            }

            // Track against the global cap; recycle the oldest debris once the
            // scene-wide budget is exceeded so a crowd fight can't pile up.
            const registry = BlockExplosionComponent.activeDebris;
            registry.push({ owner: this, mesh: blockMesh });
            while (registry.length > BlockExplosionComponent.MAX_ACTIVE_DEBRIS) {
                const oldest = registry[0]!;
                // removeDebrisPiece splices it out; if it's already gone (stale),
                // drop the head so the loop always makes progress.
                if (!oldest.owner.removeDebrisPiece(oldest.mesh)) registry.shift();
            }
        });

        this.callbacks.onPostExplosion();
    }

    syncExplodedBlocks(): void {
        const currentTime = Date.now();
        const physicsWorld = this.callbacks.getPhysicsWorld();

        this.blockPhysicsBodies.forEach((body, mesh) => {
            if (!mesh || !body) return;

            const disposeTime = mesh.userData.disposeTime;
            if (disposeTime && currentTime > disposeTime) {
                // Routes through removeDebrisPiece so the global registry stays
                // in sync. Deleting the current key during Map.forEach is safe.
                this.removeDebrisPiece(mesh);
                return;
            }

            const translation = body.translation();
            const rotation = body.rotation();
            this.syncTempVec3.set(translation.x, translation.y, translation.z);
            mesh.position.copy(this.syncTempVec3);
            this.syncTempQuat.set(rotation.x, rotation.y, rotation.z, rotation.w);
            mesh.quaternion.copy(this.syncTempQuat);
        });
    }

    dispose(physicsWorld: PhysicsWorld): void {
        this.blockPhysicsBodies.forEach((body, mesh) => {
            if (physicsWorld) physicsWorld.removeRigidBody(body);
            this.disposeMesh(mesh);
        });
        this.blockPhysicsBodies.clear();
        // Drop this owner's entries from the global debris registry.
        const registry = BlockExplosionComponent.activeDebris;
        for (let i = registry.length - 1; i >= 0; i--) {
            if (registry[i]!.owner === this) registry.splice(i, 1);
        }
    }

    private createBlockPhysicsBody(
        physicsWorld: PhysicsWorld,
        position: THREE.Vector3,
        rotation: THREE.Quaternion,
        initialVelocity: THREE.Vector3
    ): RAPIER.RigidBody {
        const size = this.config.blockSize;

        // 2D-physics lane: the same cube as a dynamic 2D body on the plane, so
        // death debris still tumbles and settles. 3D descriptors below are not
        // constructible in a 2D-only bundle.
        if (isPlaneLockedPhysics(physicsWorld)) {
            const built = physicsWorld.createEnvironmentBody({
                boxes: [{ cx: 0, cy: 0, cz: 0, hx: size, hy: size, hz: size }],
                transform: { translation: position, rotation, scale: { x: 1, y: 1, z: 1 } },
                kind: { dynamic: { mass: 0.5 } },
                collisionGroups: makeCollisionGroups(CollisionGroup.DEBRIS, CollisionMask.DEBRIS),
                friction: 0.5, restitution: 0.3, userData: { __type: 'debris' },
            });
            const body2D = built.body as unknown as RAPIER.RigidBody;
            // The facade keeps the in-plane part of the velocity and the spin about the plane normal.
            const spin = (Math.random() - 0.5) * 10;
            body2D.setLinvel({ x: initialVelocity.x, y: initialVelocity.y, z: initialVelocity.z }, true);
            body2D.setAngvel({ x: 0, y: spin, z: spin }, true);
            return body2D;
        }

        const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(position.x, position.y, position.z)
            .setRotation({ x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w })
            .setLinearDamping(0.1)
            .setAngularDamping(0.1);

        const body = physicsWorld.createRigidBody(bodyDesc);

        const colliderDesc = RAPIER.ColliderDesc.cuboid(size, size, size)
            // Tag as DEBRIS so the solver filters this out of contacts with the
            // player, vehicles, NPCs, animals and other debris (see CollisionMask.DEBRIS).
            // Without this, Rapier's default groups (0xFFFFFFFF — member of/collides with
            // EVERYTHING) let an exploded block physically shove a passing car sideways,
            // which is exactly what vehicle/NPC interactions are supposed to avoid: those
            // are surfaced via the chassis sensor trigger, never a solver contact.
            .setCollisionGroups(makeCollisionGroups(CollisionGroup.DEBRIS, CollisionMask.DEBRIS))
            // ROOT-CAUSE STABILITY FIX (keeps the tumble). The PHYSICAL inertia of a
            // 0.2 m, 0.5 kg cube is ~0.0033 → inverse inertia ~300, so every contact
            // impulse over-corrects its ANGULAR velocity ~150×. When such a body touches
            // 2-3 faces at once (a corner, or a pile of debris) those over-corrections
            // fight and diverge to Inf *inside* one world.step() — an all-NaN body that
            // poisons the whole physics step and permanently halts Rapier (no pre-step
            // velocity clamp can stop an in-step divergence). We therefore OVERRIDE the
            // inertia to 0.2 per axis (~60× the physical value, inverse inertia ~5): the
            // angular term of the contact mass matrix (invI·r² ≈ 0.05) becomes negligible
            // next to invMass (2), so contacts barely perturb the spin and cannot diverge.
            // The body still tumbles from its initial angular velocity (set below) and
            // decays naturally via angular damping — inertia only governs how contacts
            // change the spin, not the spin we seed it with. Mass stays a light 0.5 kg.
            .setMassProperties(
                0.5,
                { x: 0, y: 0, z: 0 },
                { x: 0.2, y: 0.2, z: 0.2 },
                { x: 0, y: 0, z: 0, w: 1 },
            )
            .setFriction(0.5)
            .setRestitution(0.3);

        physicsWorld.createCollider(colliderDesc, body);

        // Classify the body as cosmetic debris. The PhysicsWorld pre-step safety
        // net reads this `__type` to hold it to a tight velocity cap (a backstop
        // against the penetration-recovery launch that spawning embedded in geometry
        // can cause) instead of the high global cap meant for projectiles.
        physicsWorld.setUserData(body, { __type: 'debris' });

        body.setLinvel({ x: initialVelocity.x, y: initialVelocity.y, z: initialVelocity.z }, true);
        // Seed a random tumble. Safe now that the inertia override (above) keeps the
        // solver from amplifying this into a divergent spin.
        body.setAngvel({
            x: (Math.random() - 0.5) * 10,
            y: (Math.random() - 0.5) * 10,
            z: (Math.random() - 0.5) * 10
        }, true);

        if (this.config.onBodyCreated) {
            this.config.onBodyCreated(body);
        }

        return body;
    }
}
