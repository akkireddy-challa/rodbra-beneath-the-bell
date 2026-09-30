import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { IPlayerMovement } from 'engine/IPlayerMovement.js';
import type { PlayerController } from 'engine/PlayerController.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import type { AnimalController } from 'engine/animal/AnimalController.js';

/**
 * Movement system for when the player is riding an animal.
 * 
 * Controls work like player walking:
 * - Mouse controls camera direction (where you're looking)
 * - W/S moves forward/backward relative to camera
 * - A/D is NOT strafing - 4-legged animals don't strafe
 * - The animal smoothly turns to face the movement direction
 */
export class PlayerRidingAnimalMovement implements IPlayerMovement {
    private mountedAnimal: AnimalController | null = null;
    private rotation: number = 0;
    private cameraController: { getHorizontalAngle: () => number; getForwardVector: () => THREE.Vector3; getRightVector: () => THREE.Vector3 } | null = null;
    
    setMountedAnimal(animal: AnimalController | null): void {
        this.mountedAnimal = animal;
        if (animal) {
            const character = animal.getCharacter();
            if (character) {
                this.rotation = character.rotation.y;
            }
        }
    }
    
    getMountedAnimal(): AnimalController | null {
        return this.mountedAnimal;
    }
    
    setCameraController(camera: { getHorizontalAngle: () => number; getForwardVector: () => THREE.Vector3; getRightVector: () => THREE.Vector3 } | null): void {
        this.cameraController = camera;
    }
    
    update(
        deltaTime: number,
        playerController: PlayerController,
        keys: { forward: boolean; backward: boolean; left: boolean; right: boolean; ascend: boolean; interact: boolean; action: boolean; descend: boolean },
        isGrounded: boolean,
        moveDirection: THREE.Vector3,
        playerBody: RAPIER.RigidBody,
        physicsWorld: PhysicsWorld
    ): void {
        if (!this.mountedAnimal) return;
        
        // Calculate movement direction based on camera (like player walking)
        let moveDir = new THREE.Vector3();
        
        if (this.cameraController) {
            const forward = this.cameraController.getForwardVector();
            
            // W/S for forward/backward relative to camera
            if (keys.forward) {
                moveDir.add(forward);
            }
            if (keys.backward) {
                moveDir.sub(forward);
            }
            
            // Normalize if we have movement
            if (moveDir.lengthSq() > 0) {
                moveDir.normalize();
            }
        }
        
        // Translate movement direction to animal rider input
        // The animal will turn to face the movement direction
        const hasMovement = moveDir.lengthSq() > 0;
        
        // Calculate the target rotation from movement direction
        let targetRotation = this.rotation;
        if (hasMovement) {
            targetRotation = Math.atan2(moveDir.x, moveDir.z);
        }
        
        // Pass movement intent to the animal
        // The animal handles its own turning and physics
        this.mountedAnimal.setRiderInput({
            forward: keys.forward,
            backward: keys.backward,
            left: false, // No strafing for 4-legged animals
            right: false,
            sprint: keys.ascend,
            targetRotation: hasMovement ? targetRotation : undefined
        });
        
        // Get animal's current rotation for animation sync
        const character = this.mountedAnimal.getCharacter();
        if (character) {
            this.rotation = character.rotation.y;
            
            // Keep player positioned on the animal
            playerBody.setTranslation(
                { 
                    x: character.position.x, 
                    y: character.position.y + this.mountedAnimal.getMountHeight(), 
                    z: character.position.z 
                }, 
                true
            );
            playerBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
            
            // Sync player object rotation with animal
            (playerController as any).player.rotation.y = this.rotation;
        }
    }
    
    getCurrentSpeed(): number {
        if (!this.mountedAnimal) return 0;
        return this.mountedAnimal.getCurrentSpeed();
    }
    
    isInAir(): boolean {
        if (!this.mountedAnimal) return false;
        return !this.mountedAnimal.isGrounded;
    }
    
    getRotation(): number {
        return this.rotation;
    }

    // NB: rotation is re-derived from the mount every frame — this write is transient.
    setRotation(rotation: number): void {
        this.rotation = rotation;
    }

    reset(): void {
        this.rotation = 0;
        if (this.mountedAnimal) {
            this.mountedAnimal.setRiderInput(null);
        }
        this.mountedAnimal = null;
        this.cameraController = null;
    }
    
    getAscendDisplayName(): string {
        return 'Sprint';
    }
    
    getDescendDisplayName(): string {
        return 'Dismount';
    }
    
    getSupportedKeys(): { ascend: boolean; descend: boolean } {
        return {
            ascend: true,
            descend: false
        };
    }
    
    getKeyBehavior(): { ascend: 'tap' | 'continuous'; descend: 'tap' | 'continuous' } {
        return {
            ascend: 'continuous',
            descend: 'tap'
        };
    }
    
    shouldShowPlayer(): boolean {
        return true;
    }

    getMoveSpeed(): number {
        // Animal speed is controlled by the animal itself, not player movement speed
        return this.mountedAnimal?.getCurrentSpeed() ?? 0;
    }

    setMoveSpeed(_speed: number): void {
        // Animal speed is controlled by the animal itself, not player movement speed
        // This is a no-op for animal riding movement
    }
}
