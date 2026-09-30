import * as THREE from 'three';

/**
 * Interface for template-provided block character factory
 *
 * This interface defines the contract between the engine layer and template layer
 * for creating procedural block characters. Templates implement this to customize
 * the appearance and dimensions of block characters.
 *
 * Architecture Pattern: Animated Skeleton + Block Overlay Renderer
 *
 * The block character system uses a two-layer approach:
 * 1. Hidden animated skeleton (loaded from GLB) - provides realistic bone movements
 * 2. Block character renderer (template-defined) - reads bone transforms and renders blocks
 *
 * The skeleton acts as an "animation source" that is never visible but drives
 * the visual representation.
 */
export interface IBlockCharacterFactory {
    /**
     * Create block meshes and populate body part groups
     *
     * ⚠️ CRITICAL: This function must POPULATE the provided characterGroup, NOT create/return a new one!     
     *
     * ✅ CORRECT:
     *   function createBlockCharacter(characterGroup: THREE.Group): void {
     *     const headGroup = characterGroup.getObjectByName('head') as THREE.Group;
     *     headGroup.add(headMesh);  // CORRECT: Adding to PROVIDED group
     *   }
     *
     * The engine provides a THREE.Group with pre-created subgroups for each body part:
     * - head, neck, torso
     * - leftUpperArm, leftForearm, leftHand
     * - rightUpperArm, rightForearm, rightHand
     * - leftThigh, leftShin, leftFoot
     * - rightThigh, rightShin, rightFoot
     *
     * Templates should add meshes (boxes, custom geometry, etc.) to these groups.
     * The engine will automatically position and rotate these groups based on
     * the animated skeleton's bone transforms.
     *
     * ⚠️ FOOT POSITIONING: Feet MUST use NEGATIVE Y position to extend forward!
     *   footMesh.position.set(0, -0.1, 0);  // negative Y = forward from ankle
     *
     * @param characterGroup - Group containing body part subgroups to populate (DO NOT IGNORE THIS PARAMETER!)
     */
    createBlockCharacter(characterGroup: THREE.Group): void;

    /**
     * Get the dimensions of the block character for physics capsule calculation
     *
     * This is called after createBlockCharacter() to determine the physics body size.
     * The dimensions should match the actual visual size of the character.
     *
     * @returns Object with width, height, and depth in world units
     */
    getCharacterDimensions(): { width: number; height: number; depth: number };

    /**
     * Optional: how the creature this factory builds traverses the world.
     * Lets spawn-position logic skip ground snapping (navmesh / terrain height)
     * for swimming and flying creatures BEFORE the character is built.
     * Absent = 'ground'.
     */
    getLocomotionMode?(): 'ground' | 'swim' | 'fly';
}

/**
 * Type guard to check if an object implements IBlockCharacterFactory
 */
export function isBlockCharacterFactory(obj: unknown): obj is IBlockCharacterFactory {
    return (
        typeof obj === 'object' &&
        obj !== null &&
        typeof (obj as IBlockCharacterFactory).createBlockCharacter === 'function' &&
        typeof (obj as IBlockCharacterFactory).getCharacterDimensions === 'function'
    );
}
