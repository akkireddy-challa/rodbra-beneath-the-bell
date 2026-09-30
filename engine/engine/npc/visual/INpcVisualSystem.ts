import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import type { IBlockCharacterFactory } from 'engine/IBlockCharacterFactory.js';
import type { IPlayerMovement } from 'engine/IPlayerMovement.js';
import type { BaseAnimationDefinition } from 'types/game.js';

/**
 * Interface for NPC visual systems
 * 
 * Separates visual representation (model, animations, movement, block character) from behavior logic.
 * This allows NPCs to be humanoids, animals, or any other character type without changing behavior code.
 * 
 * ## 🎬 Dynamic Animation Loading (Same as Player!)
 * 
 * NPCs now load animations dynamically, just like the player character.
 * You no longer need to provide `baseAnimations` - the system automatically uses
 * `buildAnimationList()` to load core locomotion animations.
 * 
 * ## Architecture
 * - **INpcVisualSystem**: Handles visuals (model loading, animations, movement, block character)
 * - **INpcBehavior**: Handles AI logic (target selection, decision-making)
 * 
 * ## Usage Example
 */
export interface INpcVisualSystem {
    /**
     * Load the character model (GLB file)
     * Returns a promise that resolves to the loaded GLTF object
     */
    loadModel(): Promise<any>; // Returns GLTF

    /**
     * Get the character model GLTF (must be loaded first)
     * @throws Error if model not loaded
     */
    getModel(): any; // Returns GLTF

    /**
     * Create animation controller for this character type
     * Different character types may use different animation controllers
     */
    createAnimationController(): any; // Returns animation controller instance

    /**
     * Initialize animations with the character skeleton
     * @param character - The cloned character skeleton
     * @param gltf - The GLTF object containing animations
     * @param loader - GLTFLoader instance
     * @param baseAnimations - Animation definitions from world profile
     */
    initializeAnimations(
        character: THREE.Object3D,
        gltf: any,
        loader: any,
        baseAnimations: BaseAnimationDefinition[]
    ): Promise<void>;

    /**
     * Create movement system for this character type
     * Humanoids use WalkingAndJumpingMovement, animals might use different systems
     * @param moveSpeed - Base movement speed
     */
    createMovementSystem(moveSpeed: number): IPlayerMovement;

    /**
     * Create block character factory for this character type
     * Humanoids create humanoid blocks, animals create animal-shaped blocks
     */
    createBlockCharacterFactory(): IBlockCharacterFactory;

    /**
     * Get the root bone name for this character type
     * Humanoids use 'mixamorigHips' or 'Hips', animals might use different bones
     */
    getRootBoneName(): string | string[];

    /**
     * Adjust skeleton position for this character type
     * Different character types may need different positioning logic
     * @param skeleton - The character skeleton to adjust
     */
    adjustSkeletonPosition(skeleton: THREE.Object3D): void;

    /**
     * Get display name for this visual system type (for debugging)
     */
    getDisplayName(): string;

    /**
     * Get base animations for this character type
     * Returns the animation definitions needed for initialization
     */
    getBaseAnimations(): BaseAnimationDefinition[];
}

