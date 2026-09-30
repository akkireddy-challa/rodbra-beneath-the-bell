import type * as THREE from 'three';
import type { PlayerController } from 'engine/PlayerController.js';

/**
 * Action handler config returned by attack systems that want auto-setup
 * of the Enter key / mobile action button when setAttackSystem() is called.
 */
export interface AttackActionHandler {
    /** Action type identifier (e.g., 'melee', 'projectile') */
    actionType: string;
    /** Callback fired when the action button is pressed */
    handler: (player: THREE.Object3D, controller: PlayerController) => void;
}

/**
 * Interface for pluggable player attack systems.
 * Allows different combat behaviors (melee, projectile, magic, etc.) to be
 * swapped easily, similar to the IPlayerMovement pattern.
 */
export interface IPlayerAttack {
    /**
     * Set the controller reference.
     * Called by PlayerController.setAttackSystem() to give the attack system
     * access to the controller. This is called before setupEventListeners().
     * @param controller - The PlayerController this system is attached to
     */
    setController(controller: PlayerController): void;

    /**
     * Set up input event listeners (mouse, keyboard).
     * Called once during initialization.
     */
    setupEventListeners(): void;

    /**
     * Remove input event listeners.
     * Called during cleanup or when switching attack systems.
     */
    removeEventListeners(): void;

    /**
     * Configure mobile controls integration.
     * @param mobileControls - Mobile control system reference
     */
    setMobileControls(mobileControls: any): void;

    /**
     * Frame update for attack system logic.
     * Uses the controller reference set via setController().
     * @param deltaTime - Time since last frame in seconds
     * @returns true if player movement should be blocked (e.g., during attack animation)
     */
    update(deltaTime: number): boolean;

    /**
     * Clean up resources (geometries, materials, event listeners, physics bodies).
     * Called when attack system is no longer needed.
     */
    dispose(): void;

    /**
     * Optional: return an action handler for auto-setup when setAttackSystem() is called.
     * If provided and no action handler is already set, PlayerController will call
     * setActionHandler() with the returned config automatically.
     */
    getActionHandler?(): AttackActionHandler;
}
