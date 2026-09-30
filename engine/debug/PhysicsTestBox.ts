import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import type RAPIER from '@dimforge/rapier3d-compat';
import { getRapier } from 'engine/physics/RapierPhysics.js';
import { CollisionGroup, CollisionMask } from 'engine/CollisionLayers.js';

/**
 * Physics test box for melee attack testing
 * Spawned with F3 debug key
 */
export class PhysicsTestBox {
    private engine: EngineLike;
    private boxMesh: THREE.Mesh | null = null;
    private boxBody: RAPIER.RigidBody | null = null;
    private boxCollider: RAPIER.Collider | null = null;
    private originalPosition: THREE.Vector3 = new THREE.Vector3(0, 1.25, -5);
    private originalRotation: THREE.Quaternion = new THREE.Quaternion(0, 0, 0, 1);
    private resetTimer: number = 0;
    private needsReset: boolean = false;
    private isSpawned: boolean = false;

    constructor(engine: EngineLike) {
        this.engine = engine;
    }
    
    private getRapierWorld(): RAPIER.World | null {
        return this.engine.physicsWorld?.getRapierWorld() ?? null;
    }

    /**
     * Toggle test box visibility
     */
    toggle(spawnPosition?: THREE.Vector3): void {
        if (this.isSpawned) {
            this.despawn();
        } else {
            this.spawn(spawnPosition);
        }
    }

    /**
     * Spawn the test box
     */
    spawn(spawnPosition?: THREE.Vector3): void {
        if (this.isSpawned || !this.engine.scene || !this.engine.physicsWorld) {
            return;
        }

        const RAPIER = getRapier();
        const world = this.getRapierWorld();
        if (!world) return;

        // Use provided spawn position or default
        if (spawnPosition) {
            this.originalPosition.copy(spawnPosition);
        }

        // Create a tall red box mesh (1x2.5x1 meters) - like a punching pillar
        const boxGeometry = new THREE.BoxGeometry(1, 2.5, 1);
        const boxMaterial = new THREE.MeshStandardMaterial({
            color: 0xff0000,
            roughness: 0.5,
            metalness: 0.3
        });
        this.boxMesh = new THREE.Mesh(boxGeometry, boxMaterial);
        this.boxMesh.name = 'PhysicsTestBox';

        // Position the box with center at spawn Y (bottom at ground)
        this.boxMesh.position.copy(this.originalPosition);
        this.boxMesh.castShadow = true;
        this.boxMesh.receiveShadow = true;

        this.engine.scene.add(this.boxMesh);

        // Create physics body for the box
        const mass = 100.0; // 100kg box - heavy for realistic knockback
        
        const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(this.originalPosition.x, this.originalPosition.y, this.originalPosition.z)
            .setCanSleep(false); // Keep it always active
        
        this.boxBody = world.createRigidBody(bodyDesc);
        
        // Create collider (half extents: 0.5, 1.25, 0.5)
        // Rapier format: lower 16 bits = membership, upper 16 bits = filter (what it collides with)
        const collisionGroups = (CollisionMask.DYNAMIC_PROP << 16) | CollisionGroup.DYNAMIC_PROP;
        const colliderDesc = RAPIER.ColliderDesc.cuboid(0.5, 1.25, 0.5)
            .setMass(mass)
            .setFriction(0.5)
            .setRestitution(0.3)
            .setCollisionGroups(collisionGroups);
        
        this.boxCollider = world.createCollider(colliderDesc, this.boxBody);

        // Store rigid body reference in mesh userData for melee detection
        this.boxMesh.userData.physicsBody = this.boxBody;
        this.boxMesh.userData.mass = mass;

        this.isSpawned = true;
        console.log(`✅ [F7 Debug] Spawned physics test box at (${this.originalPosition.x.toFixed(1)}, ${this.originalPosition.y.toFixed(1)}, ${this.originalPosition.z.toFixed(1)}) - punch it to test melee physics!`);
    }

    /**
     * Despawn the test box
     */
    despawn(): void {
        if (!this.isSpawned) return;

        // Remove mesh from scene
        if (this.boxMesh && this.engine.scene) {
            this.engine.scene.remove(this.boxMesh);
            this.boxMesh.geometry.dispose();
            (this.boxMesh.material as THREE.Material).dispose();
            this.boxMesh = null;
        }

        // Remove physics body
        const world = this.getRapierWorld();
        if (this.boxBody && world) {
            world.removeRigidBody(this.boxBody);
            this.boxBody = null;
            this.boxCollider = null;
        }

        this.isSpawned = false;
        this.needsReset = false;
        console.log('❌ [F7 Debug] Despawned physics test box');
    }

    /**
     * Update test box physics and handle auto-reset
     */
    update(deltaTime: number): void {
        if (!this.isSpawned || !this.boxBody || !this.boxMesh) return;

        // Sync mesh with physics body
        const origin = this.boxBody.translation();
        const rotation = this.boxBody.rotation();

        this.boxMesh.position.set(origin.x, origin.y, origin.z);
        this.boxMesh.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);

        // Check if box has fallen over (tilted more than 30 degrees or fallen below ground level)
        const upVector = new THREE.Vector3(0, 1, 0);
        upVector.applyQuaternion(this.boxMesh.quaternion);
        const tiltAngle = Math.acos(upVector.y) * (180 / Math.PI); // Angle from vertical in degrees

        const hasFallen = tiltAngle > 30 || origin.y < 0.5;

        if (hasFallen && !this.needsReset) {
            // Box just fell, start reset timer
            this.needsReset = true;
            this.resetTimer = 2.0; // 2 second delay
            console.log('📦 Test box fell over, will reset in 2 seconds...');
        }

        // Update reset timer
        if (this.needsReset) {
            this.resetTimer -= deltaTime;

            if (this.resetTimer <= 0) {
                // Reset the box
                this.reset();
                this.needsReset = false;
            }
        }
    }

    /**
     * Reset box to original position
     */
    private reset(): void {
        if (!this.boxBody) return;

        console.log('🔄 Resetting test box to original position...');

        // Stop all movement
        this.boxBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
        this.boxBody.setAngvel({ x: 0, y: 0, z: 0 }, true);

        // Reset position and rotation
        this.boxBody.setTranslation(
            { x: this.originalPosition.x, y: this.originalPosition.y, z: this.originalPosition.z },
            true
        );
        this.boxBody.setRotation(
            { x: this.originalRotation.x, y: this.originalRotation.y, z: this.originalRotation.z, w: this.originalRotation.w },
            true
        );

        // Wake up the body
        this.boxBody.wakeUp();
    }

    /**
     * Check if test box is currently spawned
     */
    isActive(): boolean {
        return this.isSpawned;
    }

    /**
     * Clean up resources
     */
    dispose(): void {
        this.despawn();
    }
}
