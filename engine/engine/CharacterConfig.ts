import * as THREE from 'three';
import { animationAssets } from 'engine/AnimationAssets.js';

/**
 * Centralized Character Configuration
 *
 * This file contains the default character settings used throughout the application.
 * Character model URLs are defined in animation-assets.json (single source of truth).
 */

export const CHARACTER_CONFIG = {
    /**
     * Complete character model URL (includes mesh and all animations).
     * Primary is the brotli-compressed copy (Content-Encoding: br); PlayerLoader
     * falls back to DEFAULT_CHARACTER_FALLBACK_URL after two failed attempts.
     */
    DEFAULT_CHARACTER_URL: animationAssets.characterUrls.default,

    /**
     * Uncompressed canonical rig — used if the brotli copy fails to load
     * (e.g. a client/proxy that mishandles Content-Encoding: br).
     */
    DEFAULT_CHARACTER_FALLBACK_URL: animationAssets.characterUrls.defaultFallback,

    /**
     * Standard GLB skeleton size - all character skeletons are exported at this height
     * PlayerLoader scales from this skeleton size to characterHeight from world.json
     */
    SKELETON_HEIGHT: 1.75,

    /**
     * Default visible height for SKINNED (highres Asset-Forger GLB) NPCs. This is the
     * classic pre-voxelization enemy height — noticeably taller than the 1.3m block
     * mascot player, so generated enemies read as imposing. The voxelization era
     * (commit 5a31d533) had switched skinned NPCs to the player's configured height,
     * which made them barely taller than the player and visibly "too small".
     */
    SKINNED_NPC_HEIGHT: 1.84,

    DEFAULT_RADIUS: 0.3,

    /**
     * Default animation configuration
     * Updated to match Blender export animation names
     */
    ANIMATION_CONFIG: {
        idleAnimationName: 'Idle',
        runAnimationName: 'Slow_Run',
        jumpAnimationName: 'Jump',
        runSpeed: 5.0,
        transitionDuration: 0.2
    },
} as const;

/**
 * Animation config type with merged values
 */
export interface AnimationConfig {
    idleAnimationName: string;
    runAnimationName: string;
    jumpAnimationName: string;
    runSpeed: number;
    transitionDuration: number;
}

/**
 * CharacterConfig from worldProfileData (optional speed overrides)
 */
export interface CharacterConfigOverrides {
    runSpeed?: number;
}

/**
 * Get the default character URL (brotli-compressed primary).
 */
export function getDefaultCharacterUrl(): string {
    return CHARACTER_CONFIG.DEFAULT_CHARACTER_URL;
}

/**
 * Get the uncompressed fallback character URL (used if the brotli copy fails).
 */
export function getDefaultCharacterFallbackUrl(): string {
    return CHARACTER_CONFIG.DEFAULT_CHARACTER_FALLBACK_URL;
}

/**
 * Get the standard skeleton height (always 1.75m)
 * This is the size that all GLB character skeletons are exported at
 */
export function getSkeletonHeight(): number {
    return CHARACTER_CONFIG.SKELETON_HEIGHT;
}

/**
 * Default visible height for skinned (highres Asset-Forger GLB) NPCs — the classic
 * pre-voxelization enemy height. See CHARACTER_CONFIG.SKINNED_NPC_HEIGHT.
 */
export function getSkinnedNpcHeight(): number {
    return CHARACTER_CONFIG.SKINNED_NPC_HEIGHT;
}

/**
 * Get the default animation configuration
 */
export function getDefaultAnimationConfig() {
    return CHARACTER_CONFIG.ANIMATION_CONFIG;
}

/**
 * Merge default animation config with optional overrides from worldProfileData.characterConfig
 * Only the runSpeed threshold can be overridden.
 */
export function mergeCharacterConfig(overrides?: CharacterConfigOverrides): AnimationConfig {
    return {
        ...CHARACTER_CONFIG.ANIMATION_CONFIG,
        runSpeed: overrides?.runSpeed ?? CHARACTER_CONFIG.ANIMATION_CONFIG.runSpeed,
    };
}

/**
 * Scale a character from its current height to a target height.
 *
 * Used by character modification functions (like Bitmagic) to rescale a character
 * that has already been scaled by PlayerLoader based on world.json. Returns the
 * resulting height for verification.
 */
export function scaleCharacterToHeight(
    character: THREE.Object3D,
    currentCharacterHeight: number,
    targetHeight: number,
    logPrefix: string = ''
): number {
    // Assumes uniform scaling
    const targetScale = character.scale.x * (targetHeight / currentCharacterHeight);

    character.scale.setScalar(targetScale);
    character.updateMatrixWorld(true);

    const newSize = new THREE.Box3().setFromObject(character).getSize(new THREE.Vector3());
    const newHeight = newSize.y;

    if (logPrefix) {
        console.log(`${logPrefix} Scaled ${currentCharacterHeight.toFixed(3)}m → ${newHeight.toFixed(3)}m (target ${targetHeight.toFixed(3)}m, scale ${targetScale.toFixed(3)})`);
    }

    return newHeight;
}
