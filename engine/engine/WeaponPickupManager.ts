/**
 * @fileoverview WeaponPickupManager - Manages weapon pickups in the world
 * 
 * ════════════════════════════════════════════════════════════════════════════════
 * 📦 WEAPON PICKUP MANAGER
 * ════════════════════════════════════════════════════════════════════════════════
 * 
 * Spawns and manages weapon pickups in the world. Handles:
 * - Spawning weapons at specific positions
 * - Spawning weapons randomly in an area
 * - Dropping weapons when player picks up a new one
 * - Updating all weapon animations
 */

import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import { WeaponPickup, WeaponCategory, type AnyWeaponType, type OnWeaponPickupCallback } from 'engine/WeaponPickup.js';
import { WeaponType, type WeaponTypeId } from 'engine/WeaponRegistry.js';
import { RangedWeaponType, type RangedWeaponTypeId } from 'engine/RangedWeaponRegistry.js';
import { Spawner } from 'engine/Spawner.js';

// ════════════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Configuration for spawning random weapons
 */
export interface RandomWeaponSpawnConfig {
	/** Number of weapons to spawn */
	count: number;
	/** Center position for spawn area */
	center: THREE.Vector3;
	/** Radius of spawn area */
	radius: number;
	/** Melee weapon types to include (empty = no melee) */
	meleeWeapons?: WeaponTypeId[];
	/** Ranged weapon types to include (empty = no ranged) */
	rangedWeapons?: RangedWeaponTypeId[];
	/** Minimum distance between weapons */
	minDistance?: number;
	/** Minimum distance from center (to avoid spawn point) */
	minDistanceFromCenter?: number;
}

/**
 * Callback when any weapon is picked up
 */
export type OnAnyWeaponPickupCallback = (
	category: WeaponCategory,
	weaponType: AnyWeaponType,
	pickup: WeaponPickup
) => void;

// ════════════════════════════════════════════════════════════════════════════════
// WEAPON PICKUP MANAGER
// ════════════════════════════════════════════════════════════════════════════════

/**
 * WeaponPickupManager - Manages all weapon pickups in the game world
 */
export class WeaponPickupManager {
	private engine: EngineLike;
	private physicsWorld: import('./physics/PhysicsWorld.js').PhysicsWorld;
	private spawner: Spawner;
	private pickups: WeaponPickup[] = [];
	private onPickupCallback: OnAnyWeaponPickupCallback | null = null;
	
	// Default weapon pools
	private static readonly DEFAULT_MELEE: WeaponTypeId[] = [
		WeaponType.SWORD,
		WeaponType.AXE,
		WeaponType.SPEAR,
		WeaponType.DAGGER,
		WeaponType.MACE,
		WeaponType.HAMMER,
		WeaponType.KATANA
	];
	
	private static readonly DEFAULT_RANGED: RangedWeaponTypeId[] = [
		RangedWeaponType.PISTOL,
		RangedWeaponType.ASSAULT_RIFLE,
		RangedWeaponType.BOW,
		RangedWeaponType.CROSSBOW
	];

	constructor(
		engine: EngineLike,
		physicsWorld: import('./physics/PhysicsWorld.js').PhysicsWorld,
		spawner: Spawner
	) {
		this.engine = engine;
		this.physicsWorld = physicsWorld;
		this.spawner = spawner;
		
		console.log('🗡️ WeaponPickupManager: Initialized');
	}

	// ════════════════════════════════════════════════════════════════════════════════
	// SPAWNING
	// ════════════════════════════════════════════════════════════════════════════════

	/**
	 * Spawn a specific weapon at a position
	 */
	spawnWeapon(
		category: WeaponCategory,
		weaponType: AnyWeaponType,
		position: THREE.Vector3,
		options: { rotation?: number; scale?: number } = {}
	): WeaponPickup {
		// Get ground height at position - use multiple methods for reliability
		let groundY = position.y;
		
		// Try voxel-aware spawn position first (works best for voxel worlds)
		const engine = this.spawner.getEngine();
		if (engine.findValidVoxelSpawnPosition) {
			const voxelPos = engine.findValidVoxelSpawnPosition(position.x, position.z);
			if (voxelPos) {
				groundY = voxelPos.y;
			}
		}
		
		// Fall back to spawner's ground height
		if (groundY === position.y) {
			const spawnerHeight = this.spawner.getGroundHeight(position.x, position.z);
			if (spawnerHeight !== null) {
				groundY = spawnerHeight;
			}
		}
		
		// Add extra safety margin for voxel terrain (blocks can be thick)
		const spawnPos = new THREE.Vector3(position.x, groundY, position.z);
		
		const pickup = new WeaponPickup(
			this.engine,
			this.physicsWorld,
			category,
			weaponType,
			spawnPos,
			{
				rotation: options.rotation,
				scale: options.scale,
				floatingAnimation: true,
				glowEffect: true
			}
		);
		
		// Set up pickup callback
		pickup.setOnPickupCallback((p) => {
			this.handlePickup(p);
		});
		
		this.pickups.push(pickup);
		return pickup;
	}

	/**
	 * Spawn random weapons in an area
	 */
	spawnRandomWeapons(config: RandomWeaponSpawnConfig): WeaponPickup[] {
		const {
			count,
			center,
			radius,
			meleeWeapons = WeaponPickupManager.DEFAULT_MELEE,
			rangedWeapons = WeaponPickupManager.DEFAULT_RANGED,
			minDistance = 5,
			minDistanceFromCenter = 10
		} = config;
		
		// Combine weapon pools
		const allWeapons: { category: WeaponCategory; type: AnyWeaponType }[] = [
			...meleeWeapons.map(type => ({ category: WeaponCategory.MELEE, type })),
			...rangedWeapons.map(type => ({ category: WeaponCategory.RANGED, type }))
		];
		
		if (allWeapons.length === 0) {
			console.warn('WeaponPickupManager: No weapons configured for random spawning');
			return [];
		}
		
		const spawned: WeaponPickup[] = [];
		const positions: THREE.Vector3[] = [];
		let attempts = 0;
		const maxAttempts = count * 20;
		
		while (spawned.length < count && attempts < maxAttempts) {
			attempts++;
			
			// Generate random position in circle
			const angle = Math.random() * Math.PI * 2;
			const dist = minDistanceFromCenter + Math.random() * (radius - minDistanceFromCenter);
			const x = center.x + Math.cos(angle) * dist;
			const z = center.z + Math.sin(angle) * dist;
			
			// Check minimum distance from other weapons
			const pos = new THREE.Vector3(x, center.y, z);
			if (positions.some(existing => pos.distanceTo(existing) < minDistance)) continue;
			
			// Pick random weapon
			const weaponIndex = Math.floor(Math.random() * allWeapons.length);
			const weapon = allWeapons[weaponIndex];
			if (!weapon) continue;
			
			// Spawn weapon
			const pickup = this.spawnWeapon(weapon.category, weapon.type, pos, {
				rotation: Math.random() * Math.PI * 2
			});
			
			spawned.push(pickup);
			positions.push(pos);
		}
		
		console.log(`🗡️ WeaponPickupManager: Spawned ${spawned.length} random weapons`);
		return spawned;
	}

	/**
	 * Drop a weapon at a position (creates a new pickup)
	 * Called when player drops their current weapon
	 */
	dropWeapon(
		category: WeaponCategory,
		weaponType: AnyWeaponType,
		position: THREE.Vector3,
		direction?: THREE.Vector3
	): WeaponPickup {
		// Calculate drop position slightly in front of player
		const dropPos = position.clone();
		if (direction) {
			dropPos.add(direction.clone().multiplyScalar(1.5));
		}
		
		// Add slight randomness to prevent stacking
		dropPos.x += (Math.random() - 0.5) * 0.5;
		dropPos.z += (Math.random() - 0.5) * 0.5;
		
		console.log(`🗡️ WeaponPickupManager: Dropped ${weaponType} at (${dropPos.x.toFixed(1)}, ${dropPos.z.toFixed(1)})`);
		
		return this.spawnWeapon(category, weaponType, dropPos, {
			rotation: Math.random() * Math.PI * 2
		});
	}

	// ════════════════════════════════════════════════════════════════════════════════
	// CALLBACKS & EVENTS
	// ════════════════════════════════════════════════════════════════════════════════

	/**
	 * Set callback for when any weapon is picked up
	 */
	setOnPickupCallback(callback: OnAnyWeaponPickupCallback): void {
		this.onPickupCallback = callback;
	}

	/**
	 * Handle weapon pickup
	 */
	private handlePickup(pickup: WeaponPickup): void {
		// Remove from active pickups
		const index = this.pickups.indexOf(pickup);
		if (index !== -1) {
			this.pickups.splice(index, 1);
		}
		
		// Notify callback
		if (this.onPickupCallback) {
			this.onPickupCallback(
				pickup.getCategory(),
				pickup.getWeaponType(),
				pickup
			);
		}
	}

	// ════════════════════════════════════════════════════════════════════════════════
	// QUERIES
	// ════════════════════════════════════════════════════════════════════════════════

	/**
	 * Find the nearest pickup to a position
	 */
	findNearestPickup(position: THREE.Vector3, maxDistance: number = 3): WeaponPickup | null {
		let nearest: WeaponPickup | null = null;
		let nearestDist = maxDistance;
		
		for (const pickup of this.pickups) {
			if (pickup.isCollected()) continue;
			
			const dist = pickup.getPosition().distanceTo(position);
			if (dist < nearestDist) {
				nearestDist = dist;
				nearest = pickup;
			}
		}
		
		return nearest;
	}

	/**
	 * Get all active (not picked up) pickups
	 */
	getActivePickups(): WeaponPickup[] {
		return this.pickups.filter(p => !p.isCollected());
	}

	/**
	 * Get count of active pickups
	 */
	getActiveCount(): number {
		return this.getActivePickups().length;
	}

	// ════════════════════════════════════════════════════════════════════════════════
	// UPDATE & CLEANUP
	// ════════════════════════════════════════════════════════════════════════════════

	/**
	 * Update all pickup animations
	 */
	update(deltaTime: number): void {
		for (const pickup of this.pickups) {
			if (!pickup.isCollected()) {
				pickup.update(deltaTime);
			}
		}
		
		// Clean up collected pickups periodically
		this.pickups = this.pickups.filter(p => !p.isCollected());
	}

	/**
	 * Remove all pickups and clean up
	 */
	dispose(): void {
		for (const pickup of this.pickups) {
			pickup.dispose();
		}
		this.pickups = [];
		
		console.log('🗡️ WeaponPickupManager: Disposed');
	}
}

