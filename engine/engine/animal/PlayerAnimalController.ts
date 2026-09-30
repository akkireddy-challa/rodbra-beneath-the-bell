import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import type { AnimalController } from 'engine/animal/AnimalController.js';
import type { AnimalRegistry } from 'engine/animal/AnimalRegistry.js';
import { PlayerRidingAnimalMovement } from 'engine/animal/PlayerRidingAnimalMovement.js';
import { AnimalRidingCamera } from 'engine/animal/AnimalRidingCamera.js';
import type { CameraController } from 'engine/PlayerController.js';
import type { IPlayerMovement } from 'engine/IPlayerMovement.js';
import type RAPIER from '@dimforge/rapier3d-compat';

/**
 * Handles animal mounting, dismounting, and control for the player.
 * Similar to PlayerVehicleController but for rideable animals.
 */
export class PlayerAnimalController {
    private animalMovement: PlayerRidingAnimalMovement;
    private animalCamera: AnimalRidingCamera | null = null;
    private walkingCamera: CameraController | null = null;
    private walkingMovement: IPlayerMovement | null = null;
    private isRiding: boolean = false;
    private engine: EngineLike | null;
    private currentAnimal: AnimalController | null = null;
    
    // Stored references for force-dismount cleanup
    private playerControllerRef: any = null;
    private playerRef: THREE.Object3D | null = null;
    private playerBodyRef: RAPIER.RigidBody | null = null;
    private characterHeightRef: number = 1.75;
    private onCameraRestoredCallback: ((camera: CameraController | null) => void) | null = null;
    
    constructor(engine: EngineLike | null) {
        this.engine = engine;
        this.animalMovement = new PlayerRidingAnimalMovement();
    }
    
    /**
     * Check if the player is currently riding an animal.
     */
    isPlayerRiding(): boolean {
        return this.isRiding;
    }
    
    /**
     * Get the currently mounted animal.
     */
    getCurrentAnimal(): AnimalController | null {
        return this.currentAnimal;
    }
    
    /**
     * Get the riding movement system.
     */
    getAnimalMovement(): PlayerRidingAnimalMovement {
        return this.animalMovement;
    }
    
    /**
     * Get the riding camera.
     */
    getAnimalCamera(): AnimalRidingCamera | null {
        return this.animalCamera;
    }
    
    /**
     * Find a rideable animal near the player.
     */
    findRideableAnimal(playerPosition: THREE.Vector3, maxDistance: number = 3.0): AnimalController | null {
        const registry = this.engine?.getAnimalRegistry?.();
        if (!registry) return null;
        
        let nearestAnimal: AnimalController | null = null;
        let nearestDistance = maxDistance;
        
        registry.forEach((animal: AnimalController) => {
            if (!animal.canMount()) return;
            
            const character = animal.getCharacter();
            if (!character) return;
            
            const distance = playerPosition.distanceTo(character.position);
            if (distance < nearestDistance) {
                nearestDistance = distance;
                nearestAnimal = animal;
            }
        });
        
        return nearestAnimal;
    }
    
    /**
     * Try to mount a nearby rideable animal.
     */
    tryMountAnimal(
        player: THREE.Object3D,
        playerPosition: THREE.Vector3,
        animal: AnimalController | null,
        getCameraController: () => CameraController | null,
        playerController?: any
    ): boolean {
        if (!animal || !animal.canMount()) {
            return false;
        }
        
        // Mount the animal
        const success = animal.mountRider(player);
        
        if (success) {
            this.currentAnimal = animal;
            this.isRiding = true;
            
            // Store references for force-dismount cleanup
            this.playerRef = player;
            this.playerControllerRef = playerController;
            this.playerBodyRef = playerController?.playerBody || null;
            this.characterHeightRef = playerController?.characterHeight || 1.75;
            
            // Clear interact key to prevent immediate dismount
            if (playerController && playerController.keys) {
                playerController.keys.interact = false;
            }
            
            // Switch to riding camera first (before movement system needs it)
            const animalCharacter = animal.getCharacter();
            if (animalCharacter && this.engine && this.engine.camera) {
                this.walkingCamera = getCameraController();
                this.animalCamera = new AnimalRidingCamera(
                    this.engine.getDefaultCamera(),
                    animalCharacter,
                    this.engine.renderer?.domElement || document.body,
                    this.engine
                );
            }
            
            // Set up riding movement with camera reference
            this.animalMovement.setMountedAnimal(animal);
            this.animalMovement.setCameraController(this.animalCamera);
            
            // Switch to riding movement system
            if (playerController && playerController.getMovementSystem && playerController.setMovementSystem) {
                this.walkingMovement = playerController.getMovementSystem();
                playerController.setMovementSystem(this.animalMovement);
            }
            
            // Register force-dismount callback for when animal dies
            animal.onRiderForceDismount = (deadAnimal, rider) => {
                this.handleForceDismount(deadAnimal);
            };
            
            return true;
        }
        
        return false;
    }
    
    /**
     * Store the camera restored callback for use during force-dismount.
     */
    setOnCameraRestoredCallback(callback: (camera: CameraController | null) => void): void {
        this.onCameraRestoredCallback = callback;
    }
    
    /**
     * Handle dismount request (E key while riding).
     */
    handleDismountRequest(
        player: THREE.Object3D,
        playerBody: RAPIER.RigidBody | null,
        characterHeight: number,
        onCameraRestored: (camera: CameraController | null) => void,
        playerController?: any
    ): void {
        if (!this.isRiding || !this.currentAnimal) {
            return;
        }
        
        // Store callback for potential force-dismount
        this.onCameraRestoredCallback = onCameraRestored;
        
        // Get dismount position
        const dismountPos = this.currentAnimal.getDismountPosition();
        dismountPos.y += characterHeight / 2;
        
        // Clear force-dismount callback before dismounting
        this.currentAnimal.onRiderForceDismount = undefined;
        
        // Dismount from animal
        this.currentAnimal.dismountRider();
        
        // Clear riding state
        this.animalMovement.setMountedAnimal(null);
        this.currentAnimal = null;
        this.isRiding = false;
        
        // Clear interact key to prevent immediate remount
        if (playerController && playerController.keys) {
            playerController.keys.interact = false;
        }
        
        // Teleport player to dismount position
        if (playerBody) {
            playerBody.setTranslation({ x: dismountPos.x, y: dismountPos.y, z: dismountPos.z }, true);
            playerBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
        }
        player.position.copy(dismountPos);
        
        // Switch back to walking movement system
        if (playerController && playerController.setMovementSystem && this.walkingMovement) {
            playerController.setMovementSystem(this.walkingMovement);
            this.walkingMovement = null;
        }
        
        // Clean up riding camera and restore walking camera
        if (this.animalCamera) {
            this.animalCamera.dispose();
            this.animalCamera = null;
        }
        onCameraRestored(this.walkingCamera);
        this.walkingCamera = null;
        
        // Clear stored references
        this.clearStoredReferences();
    }
    
    /**
     * Handle force-dismount when animal is destroyed (e.g., dies while being ridden).
     */
    private handleForceDismount(deadAnimal: AnimalController): void {
        if (!this.isRiding || this.currentAnimal !== deadAnimal) {
            return;
        }
        
        console.log('🐴 Force dismounting player from dead animal');
        
        // Get the last known position of the animal for dismount
        const animalCharacter = deadAnimal.getCharacter();
        const dismountPos = animalCharacter ? 
            animalCharacter.position.clone() : 
            (this.playerRef?.position.clone() || new THREE.Vector3(0, 10, 0));
        dismountPos.y += this.characterHeightRef / 2 + 1; // Extra height for safety
        
        // Clear riding state
        this.animalMovement.setMountedAnimal(null);
        this.currentAnimal = null;
        this.isRiding = false;
        
        // Restore player visibility and position
        if (this.playerRef) {
            this.playerRef.visible = true;
            this.playerRef.position.copy(dismountPos);
            
            // Unparent from dead animal
            if (this.playerRef.parent && this.playerRef.parent !== this.engine?.scene) {
                this.engine?.scene?.add(this.playerRef);
            }
        }
        
        // Teleport player physics body to dismount position
        if (this.playerBodyRef) {
            this.playerBodyRef.setTranslation({ x: dismountPos.x, y: dismountPos.y, z: dismountPos.z }, true);
            this.playerBodyRef.setLinvel({ x: 0, y: 0, z: 0 }, true);
        }
        
        // Switch back to walking movement system
        if (this.playerControllerRef && this.playerControllerRef.setMovementSystem && this.walkingMovement) {
            this.playerControllerRef.setMovementSystem(this.walkingMovement);
            this.walkingMovement = null;
        }
        
        // Clean up riding camera and restore walking camera
        if (this.animalCamera) {
            this.animalCamera.dispose();
            this.animalCamera = null;
        }
        
        if (this.onCameraRestoredCallback) {
            this.onCameraRestoredCallback(this.walkingCamera);
        } else if (this.playerControllerRef && this.walkingCamera) {
            // Fallback: set camera directly on player controller
            this.playerControllerRef.cameraController = this.walkingCamera;
            if (this.walkingCamera.setTarget && this.playerRef) {
                this.walkingCamera.setTarget(this.playerRef);
            }
        }
        this.walkingCamera = null;
        
        // Clear stored references
        this.clearStoredReferences();
    }
    
    /**
     * Clear stored references after dismount.
     */
    private clearStoredReferences(): void {
        this.playerRef = null;
        this.playerBodyRef = null;
        this.playerControllerRef = null;
        this.onCameraRestoredCallback = null;
    }
    
    /**
     * Update the riding camera (call every frame when riding).
     */
    update(deltaTime: number): void {
        if (this.isRiding && this.animalCamera) {
            this.animalCamera.update(deltaTime);
        }
    }
    
    /**
     * Force dismount the player from the current animal (e.g., for respawn).
     */
    dismountCurrentAnimal(): void {
        if (!this.isRiding || !this.currentAnimal) {
            return;
        }
        
        // Clear force-dismount callback
        this.currentAnimal.onRiderForceDismount = undefined;
        
        // Dismount from animal
        this.currentAnimal.dismountRider();
        
        // Clear riding state
        this.animalMovement.setMountedAnimal(null);
        this.currentAnimal = null;
        this.isRiding = false;
        
        // Clean up riding camera
        if (this.animalCamera) {
            this.animalCamera.dispose();
            this.animalCamera = null;
        }
        
        // Clear stored references
        this.clearStoredReferences();
    }
    
    /**
     * Check if the player is currently riding an animal.
     */
    isPlayerRidingAnimal(): boolean {
        return this.isRiding;
    }
    
    /**
     * Clean up resources.
     */
    dispose(): void {
        if (this.isRiding && this.currentAnimal) {
            this.currentAnimal.onRiderForceDismount = undefined;
        }
        
        if (this.animalCamera) {
            this.animalCamera.dispose();
            this.animalCamera = null;
        }
        
        this.currentAnimal = null;
        this.isRiding = false;
        this.walkingCamera = null;
        this.walkingMovement = null;
        this.clearStoredReferences();
    }
}
