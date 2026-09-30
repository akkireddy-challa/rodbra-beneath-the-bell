/**
 * @fileoverview WeaponPickupSystem - Component for Weapon Pickup/Drop Coordination
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * 📦 WEAPON PICKUP SYSTEM (COMPONENT)
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * A coordinator component that manages weapon pickup/drop mechanics and
 * delegates to the appropriate weapon system (melee or ranged).
 *
 * **Features:**
 * - Player starts unarmed
 * - Pick up weapons from the ground (melee or ranged)
 * - Drop current weapon when picking up a new one
 * - Seamless switching between melee and ranged combat systems
 * - Interaction prompts for nearby weapons
 *
 * ## Related Files
 * - WeaponPickupManager.ts - Spawns and manages weapon pickups
 * - WeaponPickup.ts - Individual pickup objects
 * - WeaponMeleeSystem.ts - Melee weapon combat
 * - RangedWeaponSystem.ts - Ranged weapon combat
 */

import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import type { PlayerController } from 'engine/PlayerController.js';
import { WeaponMeleeSystem, type WeaponTypeId } from 'engine/WeaponMeleeSystem.js';
import { RangedWeaponSystem, type RangedWeaponTypeId } from 'engine/RangedWeaponSystem.js';
import { WeaponPickupManager } from 'engine/WeaponPickupManager.js';
import { WeaponPickup, WeaponCategory, WEAPON_PICKUP_PROMPT_Y_OFFSET, type AnyWeaponType } from 'engine/WeaponPickup.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';

// Re-export for convenience
export { WeaponCategory, type AnyWeaponType } from 'engine/WeaponPickup.js';
export { WeaponPickupManager } from 'engine/WeaponPickupManager.js';

// ════════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════════════════════════════════

/** Range at which player can interact with weapon pickups */
const WEAPON_PICKUP_RANGE = 2.5;

// ════════════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Current weapon state
 */
interface WeaponState {
	category: WeaponCategory | null;
	weaponType: AnyWeaponType | null;
	weaponName: string | null;
}

// ════════════════════════════════════════════════════════════════════════════════
// WEAPON PICKUP SYSTEM
// ════════════════════════════════════════════════════════════════════════════════

/**
 * WeaponPickupSystem - Coordinates weapon pickup/drop and delegates to weapon systems
 */
export class WeaponPickupSystem {
	// Core references
	private engine: EngineLike;
	private physicsWorld: PhysicsWorld;
	private pickupManager: WeaponPickupManager;

	// Controller reference
	private controller: PlayerController | null = null;

	// Weapon systems
	private meleeSystem: WeaponMeleeSystem | null = null;
	private rangedSystem: RangedWeaponSystem | null = null;

	// Current weapon state
	private weaponState: WeaponState = {
		category: null,
		weaponType: null,
		weaponName: null
	};

	// UI state
	private showingWeaponPickupPrompt: boolean = false;

	constructor(
		engine: EngineLike,
		physicsWorld: PhysicsWorld,
		pickupManager: WeaponPickupManager
	) {
		this.engine = engine;
		this.physicsWorld = physicsWorld;
		this.pickupManager = pickupManager;

		// Set up pickup callback
		this.pickupManager.setOnPickupCallback((category, weaponType, pickup) => {
			this.handleWeaponPickup(category, weaponType, pickup);
		});

		console.log('🗡️ WeaponPickupSystem: Initialized (player starts unarmed)');
	}

	// ════════════════════════════════════════════════════════════════════════════════
	// ATTACHMENT
	// ════════════════════════════════════════════════════════════════════════════════

	/**
	 * Attach to a PlayerController.
	 * Sets up interaction handling and action handlers.
	 */
	attach(controller: PlayerController): void {
		this.controller = controller;

		// Enable weapon pickup detection in base controller's onInteract()
		// Callback is already set in our constructor, so just set the reference
		controller.setWeaponPickupManagerReference(this.pickupManager);

		// Create weapon systems (lazy - only instantiate when needed)
		this.meleeSystem = new WeaponMeleeSystem(this.engine, this.physicsWorld);
		this.rangedSystem = new RangedWeaponSystem(this.engine, this.physicsWorld);

		console.log('🗡️ WeaponPickupSystem: Attached to controller');
	}

	/**
	 * Detach from the controller.
	 */
	detach(): void {
		// Unequip current weapon
		this.unequipCurrentWeapon();

		// Clear weapon pickup manager reference from controller
		if (this.controller) {
			this.controller.setWeaponPickupManagerReference(null);
		}

		// Dispose weapon systems
		if (this.meleeSystem) {
			this.meleeSystem.dispose();
			this.meleeSystem = null;
		}
		if (this.rangedSystem) {
			this.rangedSystem.dispose();
			this.rangedSystem = null;
		}

		this.controller = null;
	}

	// ════════════════════════════════════════════════════════════════════════════════
	// UPDATE
	// ════════════════════════════════════════════════════════════════════════════════

	/**
	 * Update the pickup system. Should be called every frame.
	 */
	update(deltaTime: number): void {
		if (!this.controller) return;

		// Update weapon pickup interaction prompt
		this.updateWeaponPickupPrompt();
	}

	/**
	 * Update the interaction prompt for nearby weapon pickups.
	 */
	private updateWeaponPickupPrompt(): void {
		if (!this.controller) return;

		const playerPos = this.controller.player.position;
		const nearbyPickup = this.pickupManager.findNearestPickup(playerPos, WEAPON_PICKUP_RANGE);

		if (nearbyPickup && nearbyPickup.interactionEnabled()) {
			const displayName = nearbyPickup.getInteractStartDisplayName();

			// Mobile shows the weapon name capitalized; desktop shows the E key prompt as-is
			const promptText = this.controller.getMobileControls().isEnabled()
				? displayName.charAt(0).toUpperCase() + displayName.slice(1)
				: displayName;
			this.controller.showInteractionPrompt(promptText, nearbyPickup.getPosition(), true, WEAPON_PICKUP_PROMPT_Y_OFFSET);

			this.showingWeaponPickupPrompt = true;
		} else if (this.showingWeaponPickupPrompt) {
			// No weapon pickup nearby
			this.controller.hideInteractionPrompt();
			this.showingWeaponPickupPrompt = false;
		}
	}

	// ════════════════════════════════════════════════════════════════════════════════
	// INTERACTION
	// ════════════════════════════════════════════════════════════════════════════════

	/**
	 * Try to interact with a nearby weapon pickup.
	 * Should be called when the interact button is pressed.
	 * @returns true if a weapon was picked up, false otherwise
	 */
	tryPickupWeapon(): boolean {
		if (!this.controller) return false;

		const playerPos = this.controller.player.position;
		const nearbyPickup = this.pickupManager.findNearestPickup(playerPos, WEAPON_PICKUP_RANGE);

		if (nearbyPickup && nearbyPickup.interactionEnabled()) {
			nearbyPickup.onInteractStart();
			return true;
		}

		return false;
	}

	// ════════════════════════════════════════════════════════════════════════════════
	// WEAPON PICKUP/DROP
	// ════════════════════════════════════════════════════════════════════════════════

	/**
	 * Handle when player picks up a weapon.
	 */
	private async handleWeaponPickup(
		category: WeaponCategory,
		weaponType: AnyWeaponType,
		pickup: WeaponPickup
	): Promise<void> {
		if (!this.controller) return;

		console.log(`🗡️ WeaponPickupSystem: Picked up ${pickup.getWeaponName()} (${category})`);

		// Drop current weapon if holding one
		if (this.weaponState.category !== null && this.weaponState.weaponType !== null) {
			await this.dropCurrentWeapon();
		}

		// Equip new weapon
		if (category === WeaponCategory.MELEE) {
			await this.equipMeleeWeapon(weaponType as WeaponTypeId, pickup.getWeaponName());
		} else {
			await this.equipRangedWeapon(weaponType as RangedWeaponTypeId, pickup.getWeaponName());
		}
	}

	/**
	 * Drop the current weapon.
	 */
	private async dropCurrentWeapon(): Promise<void> {
		if (!this.controller || this.weaponState.category === null || this.weaponState.weaponType === null) {
			return;
		}

		console.log(`🗡️ WeaponPickupSystem: Dropping ${this.weaponState.weaponName}`);

		// Get player position and forward direction
		const playerPos = this.controller.player.position.clone();
		const forward = new THREE.Vector3();
		this.controller.player.getWorldDirection(forward);

		// Create pickup at drop location
		this.pickupManager.dropWeapon(
			this.weaponState.category,
			this.weaponState.weaponType,
			playerPos,
			forward
		);

		// Unequip current weapon
		await this.unequipCurrentWeapon();
	}

	/**
	 * Unequip and clean up current weapon.
	 */
	private async unequipCurrentWeapon(): Promise<void> {
		if (!this.controller) return;

		// Unequip from appropriate system
		if (this.weaponState.category === WeaponCategory.MELEE && this.meleeSystem) {
			await this.meleeSystem.unequipWeaponByType();
			// Remove from attack system
			this.controller.setAttackSystem(null);
		} else if (this.weaponState.category === WeaponCategory.RANGED && this.rangedSystem) {
			// unequipWeapon() calls disableCombatModes() which clears action handler,
			// camera lock, combat camera, reticle, and reload handler
			this.rangedSystem.unequipWeapon();
			// Remove from attack system
			this.controller.setAttackSystem(null);
		}

		// Reset state
		this.weaponState = {
			category: null,
			weaponType: null,
			weaponName: null
		};
	}

	/**
	 * Equip a melee weapon.
	 */
	private async equipMeleeWeapon(weaponType: WeaponTypeId, weaponName: string): Promise<void> {
		if (!this.controller || !this.meleeSystem) return;

		// Equip weapon using the system
		await this.meleeSystem.equipWeaponByType(
			weaponType,
			this.controller.player,
			this.controller
		);

		// Set as attack system
		this.controller.setAttackSystem(this.meleeSystem);

		// Set up melee action handler
		this.controller.setActionHandler('melee', (player, controller) => {
			if (controller.animationController) {
				this.meleeSystem?.triggerAttack(controller.animationController, player);
			}
		});

		// Update state
		this.weaponState = {
			category: WeaponCategory.MELEE,
			weaponType,
			weaponName
		};
	}

	/**
	 * Equip a ranged weapon.
	 */
	private async equipRangedWeapon(weaponType: RangedWeaponTypeId, weaponName: string): Promise<void> {
		if (!this.controller || !this.rangedSystem) return;

		const playerLoader = this.engine.getPlayerLoader?.();
		if (!playerLoader) {
			console.error('❌ WeaponPickupSystem: Cannot equip ranged weapon - playerLoader not available');
			return;
		}

		// Equip weapon using the system
		this.rangedSystem.equipWeapon(
			weaponType,
			this.controller.player,
			playerLoader
		);

		// Set as attack system — this calls setController() which triggers enableCombatModes()
		// enableCombatModes() sets up the shoot action handler, camera lock, and reticle
		this.controller.setAttackSystem(this.rangedSystem);

		// Update state
		this.weaponState = {
			category: WeaponCategory.RANGED,
			weaponType,
			weaponName
		};
	}

	// ════════════════════════════════════════════════════════════════════════════════
	// PUBLIC API
	// ════════════════════════════════════════════════════════════════════════════════

	/**
	 * Get current weapon state.
	 */
	getCurrentWeapon(): { category: WeaponCategory | null; type: AnyWeaponType | null; name: string | null } {
		return {
			category: this.weaponState.category,
			type: this.weaponState.weaponType,
			name: this.weaponState.weaponName
		};
	}

	/**
	 * Check if player is armed.
	 */
	isArmed(): boolean {
		return this.weaponState.category !== null;
	}

	/**
	 * Get the melee system (if attached).
	 */
	getMeleeSystem(): WeaponMeleeSystem | null {
		return this.meleeSystem;
	}

	/**
	 * Get the ranged system (if attached).
	 */
	getRangedSystem(): RangedWeaponSystem | null {
		return this.rangedSystem;
	}

	/**
	 * Get the pickup manager.
	 */
	getPickupManager(): WeaponPickupManager {
		return this.pickupManager;
	}

	/**
	 * Force drop current weapon (e.g., when dying).
	 */
	async forceDropWeapon(): Promise<void> {
		await this.dropCurrentWeapon();
	}

	/**
	 * Check if currently showing a weapon pickup prompt.
	 */
	isShowingPickupPrompt(): boolean {
		return this.showingWeaponPickupPrompt;
	}

	/**
	 * Get projectiles from the ranged system (for NPC collision detection).
	 */
	getProjectiles(): import('engine/Projectile.js').Projectile[] {
		return this.rangedSystem?.getProjectiles() ?? [];
	}

	/**
	 * Remove a specific projectile.
	 */
	removeProjectile(projectile: import('engine/Projectile.js').Projectile): void {
		this.rangedSystem?.removeProjectile(projectile);
	}

	// ════════════════════════════════════════════════════════════════════════════════
	// CLEANUP
	// ════════════════════════════════════════════════════════════════════════════════

	/**
	 * Dispose the pickup system.
	 */
	dispose(): void {
		this.detach();
	}
}
