/**
 * @fileoverview WeaponPickup - Interactable weapon item that can be picked up from the ground
 * 
 * ════════════════════════════════════════════════════════════════════════════════
 * 📦 WEAPON PICKUP SYSTEM
 * ════════════════════════════════════════════════════════════════════════════════
 * 
 * Weapons can be dropped on the ground and picked up by the player.
 * When a player picks up a weapon while holding another, the held weapon is dropped.
 *
 * ## Integration with Weapon Systems
 *
 * Use WeaponPickupSystem with WeaponMeleeSystem or RangedWeaponSystem:
 */

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { EngineLike } from 'types/game.js';
import type { Interactable } from 'types/interactable.js';
import { createWeaponMesh, type WeaponTypeId } from 'engine/WeaponRegistry.js';
import { createRangedWeaponMesh, type RangedWeaponTypeId } from 'engine/RangedWeaponRegistry.js';
import { t } from 'engine/i18n/index.js';
import { isPlaneLockedPhysics } from 'engine/physics/PlaneLockedPhysics.js';
import { CollisionGroup, CollisionMask, makeCollisionGroups } from 'engine/CollisionLayers.js';

// ════════════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Weapon category - determines which weapon system is used
 */
export enum WeaponCategory {
	MELEE = 'melee',
	RANGED = 'ranged'
}

/**
 * Combined weapon type - can be melee or ranged
 */
export type AnyWeaponType = WeaponTypeId | RangedWeaponTypeId;

/**
 * Weapon pickup configuration
 */
export interface WeaponPickupConfig {
	/** Weapon category (melee or ranged) */
	category: WeaponCategory;
	/** Specific weapon type */
	weaponType: AnyWeaponType;
	/** World position for the pickup */
	position: THREE.Vector3;
	/** Optional Y rotation for the weapon */
	rotation?: number;
	/** Optional scale multiplier */
	scale?: number;
	/** Enable floating animation */
	floatingAnimation?: boolean;
	/** Enable glow effect */
	glowEffect?: boolean;
}

/**
 * Callback when weapon is picked up
 */
export type OnWeaponPickupCallback = (pickup: WeaponPickup) => void;

/**
 * Vertical lift (world units) for the interaction prompt above a pickup's
 * position. Small because getPosition() already includes HOVER_HEIGHT —
 * the default prompt offset (tuned for ground-level anchors) places the
 * label far above the floating weapon, especially on mobile viewports.
 */
export const WEAPON_PICKUP_PROMPT_Y_OFFSET = 0.5;

// ════════════════════════════════════════════════════════════════════════════════
// WEAPON PICKUP CLASS
// ════════════════════════════════════════════════════════════════════════════════

/**
 * WeaponPickup - An interactable weapon on the ground
 * 
 * Features:
 * - Visual weapon mesh floating above ground
 * - Physics body for collision detection
 * - Glow/highlight effect
 * - Floating bob animation
 * - Implements Interactable for player interaction
 */
export class WeaponPickup implements Interactable {
	// Core references
	private engine: EngineLike;
	private physicsWorld: import('./physics/PhysicsWorld.js').PhysicsWorld;
	
	// Weapon info
	private category: WeaponCategory;
	private weaponType: AnyWeaponType;
	private weaponName: string;
	
	// Visual
	private weaponMesh: THREE.Group;
	private containerGroup: THREE.Group; // Parent for positioning
	private glowMesh: THREE.Mesh | null = null;
	private baseY: number;
	private floatingEnabled: boolean;
	private glowEnabled: boolean;
	
	// Physics
	private sensorBody: import('@dimforge/rapier3d-compat').RigidBody | null = null;
	private sensorCollider: import('@dimforge/rapier3d-compat').Collider | null = null;
	
	// State
	private isPickedUp: boolean = false;
	private animationTime: number = 0;
	private onPickupCallback: OnWeaponPickupCallback | null = null;
	
	// Animation constants
	private static readonly BOB_SPEED = 2.0;
	private static readonly BOB_AMPLITUDE = 0.15;
	private static readonly ROTATION_SPEED = 1.0;
	private static readonly PICKUP_RADIUS = 2.0;
	private static readonly HOVER_HEIGHT = 1.0; // Higher hover for voxel terrain compatibility

	constructor(
		engine: EngineLike,
		physicsWorld: import('./physics/PhysicsWorld.js').PhysicsWorld,
		category: WeaponCategory,
		weaponType: AnyWeaponType,
		position: THREE.Vector3,
		options: Partial<Omit<WeaponPickupConfig, 'category' | 'weaponType' | 'position'>> = {}
	) {
		this.engine = engine;
		this.physicsWorld = physicsWorld;
		this.category = category;
		this.weaponType = weaponType;
		this.floatingEnabled = options.floatingAnimation ?? true;
		this.glowEnabled = options.glowEffect ?? true;
		
		// Create container for positioning
		this.containerGroup = new THREE.Group();
		this.containerGroup.name = `WeaponPickup_${weaponType}`;
		
		// Create weapon mesh based on category
		if (category === WeaponCategory.MELEE) {
			const { mesh, preset } = createWeaponMesh(weaponType as WeaponTypeId);
			this.weaponMesh = mesh;
			this.weaponName = preset.name;
		} else {
			const { mesh, preset } = createRangedWeaponMesh(weaponType as RangedWeaponTypeId);
			this.weaponMesh = mesh;
			this.weaponName = preset.name;
		}
		
		// Scale weapon for ground display
		const scale = options.scale ?? 1.5;
		this.weaponMesh.scale.setScalar(scale);
		
		// Rotate weapon to lay horizontal (blade/barrel pointing forward)
		this.weaponMesh.rotation.x = Math.PI / 2;
		if (options.rotation !== undefined) {
			this.weaponMesh.rotation.z = options.rotation;
		}
		
		// Add to container
		this.containerGroup.add(this.weaponMesh);
		
		// Create glow effect if enabled
		if (this.glowEnabled) {
			this.createGlowEffect();
		}
		
		// Position container
		this.baseY = position.y + WeaponPickup.HOVER_HEIGHT;
		this.containerGroup.position.copy(position);
		this.containerGroup.position.y = this.baseY;
		
		// Mark meshes as weapon pickups (but NOT as generic interactables)
		// This prevents the parent's findNearbyInteractable() from finding them
		// with incorrect distance calculations. We use WeaponPickupManager instead.
		this.weaponMesh.traverse((child) => {
			if ((child as THREE.Mesh).isMesh) {
				child.userData.isWeaponPickup = true;
				// Note: We intentionally don't set userData.interactable here
				// Weapon pickups are handled by WeaponPickupManager.findNearestPickup()
			}
		});
		
		// Add to scene
		if (this.engine.scene) {
			this.engine.scene.add(this.containerGroup);
		}
		
		// Create physics trigger volume
		this.createPhysicsTrigger(position);
		
		console.log(`🗡️ WeaponPickup: Created ${this.weaponName} at (${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)})`);
	}

	/**
	 * Create glow/highlight effect around weapon
	 */
	private createGlowEffect(): void {
		// Create a subtle glow sphere around the weapon
		const glowGeometry = new THREE.SphereGeometry(0.4, 16, 16);
		const glowMaterial = new THREE.MeshBasicMaterial({
			color: this.category === WeaponCategory.MELEE ? 0x44aaff : 0xffaa44,
			transparent: true,
			opacity: 0.15,
			side: THREE.BackSide
		});
		this.glowMesh = new THREE.Mesh(glowGeometry, glowMaterial);
		this.glowMesh.position.y = 0.3; // Center on weapon
		this.containerGroup.add(this.glowMesh);
	}

	/**
	 * Create physics trigger for detecting player proximity
	 */
	private createPhysicsTrigger(position: THREE.Vector3): void {
		// 2D-physics lane: the same pickup trigger on the plane (see InteractableComponent).
		if (isPlaneLockedPhysics(this.physicsWorld)) {
			const built = this.physicsWorld.createSensorBall({
				x: position.x, y: position.y + 0.5, z: position.z,
				radius: WeaponPickup.PICKUP_RADIUS,
				collisionGroups: makeCollisionGroups(CollisionGroup.TRIGGER, CollisionMask.TRIGGER),
			});
			this.sensorBody = built.body as unknown as RAPIER.RigidBody;
			this.sensorCollider = built.collider as unknown as RAPIER.Collider;
			return;
		}

		// Create a fixed rigid body to hold the sensor collider
		const rigidBodyDesc = RAPIER.RigidBodyDesc.fixed()
			.setTranslation(position.x, position.y + 0.5, position.z);
		
		this.sensorBody = this.physicsWorld.createRigidBody(rigidBodyDesc);
		
		// Create sensor (ghost) collider for overlap detection
		const colliderDesc = RAPIER.ColliderDesc.ball(WeaponPickup.PICKUP_RADIUS)
			.setSensor(true); // Sensor = no physical response, just detection
		
		this.sensorCollider = this.physicsWorld.createCollider(colliderDesc, this.sensorBody);
	}

	// ════════════════════════════════════════════════════════════════════════════════
	// INTERACTABLE INTERFACE
	// ════════════════════════════════════════════════════════════════════════════════

	/**
	 * Called when player interacts with the weapon
	 * @returns true if pickup was successful
	 */
	onInteractStart(): boolean {
		if (this.isPickedUp) {
			return false;
		}
		
		console.log(`🗡️ WeaponPickup: Player picked up ${this.weaponName}`);
		this.isPickedUp = true;
		
		// Notify callback
		if (this.onPickupCallback) {
			this.onPickupCallback(this);
		}
		
		// Remove from world
		this.removeFromWorld();
		
		return true;
	}

	/**
	 * Get display text for interaction prompt
	 */
	getInteractStartDisplayName(): string {
		return t('game.interaction.pickUpWeapon', { weapon: this.weaponName });
	}

	/**
	 * Check if interaction is currently enabled
	 */
	interactionEnabled(): boolean {
		return !this.isPickedUp;
	}

	// ════════════════════════════════════════════════════════════════════════════════
	// PUBLIC API
	// ════════════════════════════════════════════════════════════════════════════════

	/**
	 * Set callback for when weapon is picked up
	 */
	setOnPickupCallback(callback: OnWeaponPickupCallback): void {
		this.onPickupCallback = callback;
	}

	/**
	 * Get the weapon category (melee or ranged)
	 */
	getCategory(): WeaponCategory {
		return this.category;
	}

	/**
	 * Get the specific weapon type
	 */
	getWeaponType(): AnyWeaponType {
		return this.weaponType;
	}

	/**
	 * Get the weapon's display name
	 */
	getWeaponName(): string {
		return this.weaponName;
	}

	/**
	 * Get the world position of this pickup
	 */
	getPosition(): THREE.Vector3 {
		return this.containerGroup.position.clone();
	}

	/**
	 * Check if this pickup has been collected
	 */
	isCollected(): boolean {
		return this.isPickedUp;
	}

	/**
	 * Get a clone of the weapon mesh for attaching to player
	 * Returns a new mesh with the same geometry/materials but independent transforms
	 */
	getWeaponMeshClone(): THREE.Object3D | null {
		const clone = this.weaponMesh.clone(true);
		
		// Reset position/rotation for attachment
		clone.position.set(0, 0, 0);
		clone.rotation.set(0, 0, 0);
		
		return clone;
	}

	/**
	 * Update animation (call each frame)
	 */
	update(deltaTime: number): void {
		if (this.isPickedUp) return;
		
		this.animationTime += deltaTime;
		
		// Floating bob animation
		if (this.floatingEnabled) {
			const bob = Math.sin(this.animationTime * WeaponPickup.BOB_SPEED) * WeaponPickup.BOB_AMPLITUDE;
			this.containerGroup.position.y = this.baseY + bob;
		}
		
		// Slow rotation
		this.containerGroup.rotation.y += WeaponPickup.ROTATION_SPEED * deltaTime;
		
		// Pulse glow effect
		if (this.glowMesh) {
			const pulse = 0.1 + Math.sin(this.animationTime * 3) * 0.05;
			(this.glowMesh.material as THREE.MeshBasicMaterial).opacity = pulse;
		}
	}

	/**
	 * Remove from world and clean up physics
	 */
	private removeFromWorld(): void {
		// Remove visual
		if (this.containerGroup.parent) {
			this.containerGroup.parent.remove(this.containerGroup);
		}
		
		// Remove physics
		if (this.sensorCollider) {
			this.physicsWorld.removeCollider(this.sensorCollider);
			this.sensorCollider = null;
		}
		
		if (this.sensorBody) {
			this.physicsWorld.removeRigidBody(this.sensorBody);
			this.sensorBody = null;
		}
	}

	/**
	 * Full cleanup - call when destroying the pickup
	 */
	dispose(): void {
		this.removeFromWorld();
		
		// Dispose geometries and materials
		this.weaponMesh.traverse((child) => {
			if ((child as THREE.Mesh).isMesh) {
				const mesh = child as THREE.Mesh;
				mesh.geometry?.dispose();
				if (Array.isArray(mesh.material)) {
					mesh.material.forEach(m => m.dispose());
				} else {
					mesh.material?.dispose();
				}
			}
		});
		
		if (this.glowMesh) {
			this.glowMesh.geometry?.dispose();
			(this.glowMesh.material as THREE.Material)?.dispose();
		}
	}
}

