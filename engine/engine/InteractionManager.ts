/**
 * InteractionManager - Central registry for trigger-based interactables and collectibles
 *
 * Receives sensor intersection events from PhysicsWorld and tracks which
 * InteractableComponents the player is currently overlapping. Replaces
 * the old O(n) scene-traversal approach with efficient physics-based detection.
 *
 * Also handles CollectibleComponents: auto-fires onCollect() immediately
 * when the player enters a collectible sensor, then auto-disposes the sensor.
 *
 * Singleton accessed via getInteractionManager().
 */

import * as THREE from 'three';
import type { Interactable } from 'types/interactable.js';
import type { InteractableComponent } from 'engine/InteractableComponent.js';
import type { CollectibleComponent } from 'engine/CollectibleComponent.js';
import { getGameEventLog } from 'engine/recording/GameEventLog.js';

export interface NearestInteractableResult {
	interactable: Interactable;
	worldPosition: THREE.Vector3;
}

/** Callback signature for collection event listeners */
export type CollectionListener = (objectId: string, objectName: string, object3D: THREE.Object3D) => void;

/** Duck-typed PlayerController for carry hand attachment */
export interface CarryPlayerController {
	attachToBodyPart(object: THREE.Object3D, bodyPartName: string, rotation?: { x: number; y: number; z: number } | null): boolean;
	detachFromBodyPart(object: THREE.Object3D): void;
}

/** Interface for carryable objects that need automatic position updates */
export interface CarryableUpdatable {
	update(deltaTime: number, playerPosition: THREE.Vector3, playerQuaternion: THREE.Quaternion): void;
	onCarryAttach(controller: CarryPlayerController): void;
	onCarryDetach(controller: CarryPlayerController): void;
	isDisposed(): boolean;
	isCarried(): boolean;
}

let instance: InteractionManager | null = null;

export function getInteractionManager(): InteractionManager {
	if (!instance) {
		instance = new InteractionManager();
	}
	return instance;
}

export function resetInteractionManager(): void {
	if (instance) {
		instance.dispose();
		instance = null;
	}
}

export class InteractionManager {
	private static _worldPosTemp = new THREE.Vector3();

	/** Map from sensor collider handle to InteractableComponent */
	private registry: Map<number, InteractableComponent> = new Map();

	/** Map from sensor collider handle to CollectibleComponent */
	private collectibles: Map<number, CollectibleComponent> = new Map();

	/** Metadata for collectible sensors (objectId, name) for event emission */
	private collectibleMeta: Map<number, { objectId: string; name: string }> = new Map();

	/** Set of sensor collider handles currently overlapping the player */
	private activeOverlaps: Set<number> = new Set();

	/** Collider handles of active driver pickup probes (see DriverPickupProbe) */
	private pickupProbes: Set<number> = new Set();

	/** Listeners notified when any collectible is collected */
	private collectionListeners: CollectionListener[] = [];

	/** Carryable components that need automatic position updates each frame */
	private carryables: Set<CarryableUpdatable> = new Set();

	/** Carryables currently attached to player hand (for tracking transitions) */
	private attachedCarryables: Set<CarryableUpdatable> = new Set();

	// ---- Interactable (E-key) registration ----

	/**
	 * Register an InteractableComponent by its sensor collider handle.
	 */
	register(sensorHandle: number, component: InteractableComponent): void {
		this.registry.set(sensorHandle, component);
	}

	/**
	 * Unregister an InteractableComponent.
	 */
	unregister(sensorHandle: number): void {
		this.registry.delete(sensorHandle);
		this.activeOverlaps.delete(sensorHandle);
	}

	// ---- Collectible (auto-collect) registration ----

	/**
	 * Register a CollectibleComponent by its sensor collider handle.
	 * @param meta Optional metadata (objectId, name) for collection event callbacks
	 */
	registerCollectible(sensorHandle: number, component: CollectibleComponent, meta?: { objectId: string; name: string }): void {
		this.collectibles.set(sensorHandle, component);
		if (meta) {
			this.collectibleMeta.set(sensorHandle, meta);
		}
	}

	/**
	 * Unregister a CollectibleComponent.
	 */
	unregisterCollectible(sensorHandle: number): void {
		this.collectibles.delete(sensorHandle);
		this.collectibleMeta.delete(sensorHandle);
	}

	// ---- Driver pickup probes ----

	/**
	 * Register a driver pickup probe collider (see {@link DriverPickupProbe}).
	 *
	 * The probe stands in for the player capsule — which is disabled while
	 * driving — so collectibles still auto-collect from the driver's seat. It is
	 * deliberately a COLLECT-ONLY stand-in: intersections coming from a probe do
	 * not register E-key interactable overlaps, because E already means "exit
	 * vehicle" while seated.
	 */
	registerPickupProbe(colliderHandle: number): void {
		this.pickupProbes.add(colliderHandle);
	}

	/** Unregister a driver pickup probe collider (on vehicle exit / disposal). */
	unregisterPickupProbe(colliderHandle: number): void {
		this.pickupProbes.delete(colliderHandle);
	}

	// ---- Collection event listeners ----

	/**
	 * Register a listener that is called whenever any collectible is collected.
	 * Useful for template code to react to collections without knowing individual objects.
	 *
	 * @param listener Callback receiving (objectId, objectName, object3D)
	 */
	onCollected(listener: CollectionListener): void {
		this.collectionListeners.push(listener);
	}

	/**
	 * Remove a previously registered collection listener.
	 */
	removeCollectionListener(listener: CollectionListener): void {
		const idx = this.collectionListeners.indexOf(listener);
		if (idx !== -1) this.collectionListeners.splice(idx, 1);
	}

	// ---- Sensor intersection events from PhysicsWorld ----

	/**
	 * Called by PhysicsWorld when a sensor intersection starts.
	 * @param sensorHandle - The sensor collider handle
	 * @param otherHandle - The other collider handle
	 */
	onIntersectionStart(sensorHandle: number, otherHandle: number): void {
		// Determine which handle is the sensor and which is the player
		const resolvedSensor = this.resolveSensorAndPlayer(sensorHandle, otherHandle);
		if (!resolvedSensor) return;

		const handle = resolvedSensor;
		// The non-sensor side: the player capsule on foot, or a driver pickup probe
		// riding the vehicle chassis while seated.
		const playerHandle = handle === sensorHandle ? otherHandle : sensorHandle;

		// Check if it's a collectible — auto-fire immediately
		const collectible = this.collectibles.get(handle);
		if (collectible && !collectible.isDisposed()) {
			collectible.getCollectible().onCollect();

			// Emit collection event to listeners
			const meta = this.collectibleMeta.get(handle);
			if (meta) {
				for (const listener of this.collectionListeners) {
					listener(meta.objectId, meta.name, collectible.getObject3D());
				}
			}

			// Trailer timeline
			getGameEventLog().logEvent({
				type: 'pickup',
				position: collectible.getObject3D()?.position,
				data: meta ? { name: meta.name } : undefined,
			});

			// Auto-dispose (one-shot collection)
			collectible.dispose();
			return;
		}

		// Otherwise it's an interactable — track overlap for E-key. A driver pickup
		// probe never opens E-key prompts: it only stands in for auto-collect, and
		// E is bound to "exit vehicle" while seated.
		if (this.pickupProbes.has(playerHandle)) return;

		if (this.registry.has(handle)) {
			this.activeOverlaps.add(handle);
		}
	}

	/**
	 * Called by PhysicsWorld when a sensor intersection ends.
	 * @param sensorHandle - The sensor collider handle
	 * @param otherHandle - The other collider handle
	 */
	onIntersectionEnd(sensorHandle: number, otherHandle: number): void {
		const resolvedSensor = this.resolveSensorAndPlayer(sensorHandle, otherHandle);
		if (!resolvedSensor) return;

		this.activeOverlaps.delete(resolvedSensor);
	}

	private isSensorHandle(handle: number): boolean {
		return this.registry.has(handle) || this.collectibles.has(handle);
	}

	/**
	 * Resolve which handle is the registered sensor and which is the player.
	 * Returns the sensor handle if valid, or null.
	 *
	 * Since CollisionMask.TRIGGER only includes PLAYER, any non-registered collider
	 * overlapping a trigger sensor is guaranteed to be in the PLAYER group by
	 * Rapier's collision filtering — the player capsule on foot, or the driver
	 * pickup probe while seated in a vehicle. No need to verify player handles
	 * explicitly.
	 */
	private resolveSensorAndPlayer(h1: number, h2: number): number | null {
		const a = this.isSensorHandle(h1);
		const b = this.isSensorHandle(h2);
		if (a === b) return null;
		return a ? h1 : h2;
	}

	/**
	 * Get the nearest interactable that the player is currently overlapping.
	 * Returns null if no interactables are in range.
	 */
	getNearestInteractable(playerPosition: THREE.Vector3): NearestInteractableResult | null {
		// Track two candidates: the nearest world-fixed interactable and the
		// nearest player-attached follower (carry-drop). Followers are always
		// at distance ~0, so if we picked by distance alone they'd shadow any
		// real interactable the player walks up to.
		let nearestWorld: Interactable | null = null;
		let nearestWorldPos: THREE.Vector3 | null = null;
		let nearestWorldDist = Infinity;

		let nearestFollower: Interactable | null = null;
		let nearestFollowerPos: THREE.Vector3 | null = null;
		let nearestFollowerDist = Infinity;

		for (const sensorHandle of this.activeOverlaps) {
			const component = this.registry.get(sensorHandle);
			if (!component || component.isDisposed()) {
				// Stale entry, clean up
				this.activeOverlaps.delete(sensorHandle);
				continue;
			}

			const interactable = component.getInteractable();

			// Check if interaction is enabled
			const enabled = interactable.interactionEnabled ? interactable.interactionEnabled() : true;
			if (!enabled) continue;

			// Use world position for distance check (handles objects parented to bones)
			const obj = component.getObject3D();
			const worldPos = InteractionManager._worldPosTemp;
			obj.getWorldPosition(worldPos);
			const dist = playerPosition.distanceTo(worldPos);

			const isFollower = interactable.isFollowingPlayer?.() ?? false;
			if (isFollower) {
				if (dist < nearestFollowerDist) {
					nearestFollowerDist = dist;
					nearestFollower = interactable;
					nearestFollowerPos = worldPos.clone();
				}
			} else {
				if (dist < nearestWorldDist) {
					nearestWorldDist = dist;
					nearestWorld = interactable;
					nearestWorldPos = worldPos.clone();
				}
			}
		}

		// Prefer a world-fixed interactable. Only fall back to the follower
		// (carry-drop) when no world-fixed candidate is in range.
		if (nearestWorld && nearestWorldPos) {
			return { interactable: nearestWorld, worldPosition: nearestWorldPos };
		}
		if (nearestFollower && nearestFollowerPos) {
			return { interactable: nearestFollower, worldPosition: nearestFollowerPos };
		}
		return null;
	}

	/**
	 * Check if a specific interactable is currently in range of the player.
	 */
	isInRange(interactable: Interactable): boolean {
		for (const sensorHandle of this.activeOverlaps) {
			const component = this.registry.get(sensorHandle);
			if (component && !component.isDisposed() && component.getInteractable() === interactable) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Get the count of currently active overlaps (for debugging)
	 */
	getActiveOverlapCount(): number {
		return this.activeOverlaps.size;
	}

	/**
	 * Get count of registered interactables (for debugging)
	 */
	getRegisteredCount(): number {
		return this.registry.size;
	}

	/**
	 * Get count of registered collectibles (for debugging)
	 */
	getCollectibleCount(): number {
		return this.collectibles.size;
	}

	// ---- Carryable auto-update ----

	/**
	 * Check if any registered carryable is currently being carried.
	 */
	isCarrying(): boolean {
		for (const carryable of this.carryables) {
			if (!carryable.isDisposed() && carryable.isCarried()) return true;
		}
		return false;
	}

	/**
	 * Register a carryable for automatic position updates each frame.
	 * Called by CarryableComponent on construction.
	 */
	registerCarryable(carryable: CarryableUpdatable): void {
		this.carryables.add(carryable);
	}

	/**
	 * Unregister a carryable from automatic updates.
	 * Called by CarryableComponent on dispose.
	 */
	unregisterCarryable(carryable: CarryableUpdatable): void {
		this.carryables.delete(carryable);
	}

	/**
	 * Update all registered carryables. Called by PlayerController each frame.
	 * Handles hand attachment/detachment and position updates.
	 */
	updateCarryables(
		deltaTime: number,
		playerPosition: THREE.Vector3,
		playerQuaternion: THREE.Quaternion,
		controller?: CarryPlayerController,
	): void {
		for (const carryable of this.carryables) {
			if (carryable.isDisposed()) {
				this.carryables.delete(carryable);
				continue;
			}
			carryable.update(deltaTime, playerPosition, playerQuaternion);
		}

		// Handle attach/detach transitions (separate pass to avoid issues with state changes during update)
		if (controller) {
			for (const carryable of this.carryables) {
				if (carryable.isDisposed()) continue;
				const wasAttached = this.attachedCarryables.has(carryable);
				const isCarried = carryable.isCarried();

				if (isCarried && !wasAttached) {
					carryable.onCarryAttach(controller);
					this.attachedCarryables.add(carryable);
				} else if (!isCarried && wasAttached) {
					carryable.onCarryDetach(controller);
					this.attachedCarryables.delete(carryable);
				}
			}
		}
	}

	/**
	 * Clean up all state.
	 */
	dispose(): void {
		this.registry.clear();
		this.collectibles.clear();
		this.collectibleMeta.clear();
		this.activeOverlaps.clear();
		this.pickupProbes.clear();
		this.collectionListeners = [];
		this.carryables.clear();
		this.attachedCarryables.clear();
	}
}
