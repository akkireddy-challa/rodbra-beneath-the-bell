/**
 * CarryableComponent - Pick up, carry, and place objects
 *
 * Implements the "carry and place" pattern: player presses E to pick up an
 * object, carries it attached to their character, then presses E again to
 * drop it (or place it in a DropZoneComponent).
 *
 * Supports two modes:
 * - **Simple objects**: Pass an Object3D. CarryableComponent creates its own
 *   InteractableComponent sensor for E-key detection.
 * - **Entities with existing interaction** (AnimalController, NPCs): Pass an
 *   `entityAdapter` that hooks into the entity's existing Interactable.
 *   A temporary carry sensor is created during carry to follow the player.
 */

import * as THREE from 'three';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import type { Interactable } from 'types/interactable.js';
import type { INpcBehavior } from 'engine/npc/INpcBehavior.js';
import { DEFAULT_NPC_BEHAVIOR_FOCUS_OFFSET_Y, createNpcFocusTarget } from 'engine/npc/INpcBehavior.js';
import type { ICharacterContext } from 'engine/character/ICharacterContext.js';
import { InteractableComponent } from 'engine/InteractableComponent.js';
import { CollisionGroup } from 'engine/CollisionLayers.js';
import { DropZoneComponent } from 'engine/DropZoneComponent.js';
import { getInteractionManager, type CarryPlayerController } from 'engine/InteractionManager.js';

export type CarryState = 'idle' | 'carried' | 'placed';

/**
 * Adapter for entities that have their own interaction/physics systems
 * (e.g., AnimalController, NpcController). Allows CarryableComponent to
 * manage carry state without creating duplicate sensors.
 */
export interface CarryableEntityAdapter {
	/** Get the entity's visual Object3D */
	getObject3D(): THREE.Object3D;
	/** Disable the entity's physics body while carried */
	disablePhysics(): void;
	/** Re-enable the entity's physics body when dropped */
	enablePhysics(position: THREE.Vector3): void;
	/** Pause the entity's AI/behavior while carried (optional) */
	pauseBehavior?(): void;
	/** Resume the entity's AI/behavior when dropped (optional) */
	resumeBehavior?(): void;
}

export interface CarryableConfig {
	/** The Three.js object to carry (not needed if entityAdapter is provided) */
	object3D?: THREE.Object3D;
	/** Human-readable name shown in interaction prompts (e.g., "chicken") */
	displayName: string;
	/** Sensor radius for pickup detection (default: 2.5). Ignored when using entityAdapter. */
	radius?: number;
	/** Offset from player position when carried. Only used when attachToHand is null. (default: (0, 0.6, 1.0)) */
	carryOffset?: THREE.Vector3;
	/** Whether the object should match player rotation when carried (default: true) */
	rotateWithPlayer?: boolean;
	/**
	 * Body part to attach the carried object to (default: 'rightHand').
	 * When set, the object is parented to the player's hand bone and moves
	 * automatically — no offset positioning needed.
	 * Set to null to use carryOffset-based world-space positioning instead.
	 */
	attachToHand?: string | null;
	/** Called when the object is picked up */
	onPickedUp?: (component: CarryableComponent) => void;
	/** Called when the object is dropped (not in a zone) */
	onDropped?: (component: CarryableComponent) => void;
	/** Called when the object is placed in a drop zone */
	onPlacedInZone?: (component: CarryableComponent, zoneName: string) => void;
	/** Optional metadata for event tracking */
	meta?: { objectId: string; name: string };
	/**
	 * Adapter for entities with existing interaction systems.
	 * When provided, CarryableComponent does NOT create its own sensor at init.
	 * Instead, the entity's existing onInteractStart() should call carryable.onInteractStart().
	 * A temporary sensor is created during carry state to follow the player.
	 */
	entityAdapter?: CarryableEntityAdapter;
}

/** Callback signature for global carry event listeners */
export type CarryEventListener = (
	event: 'pickedUp' | 'dropped' | 'placedInZone',
	objectName: string,
	object3D: THREE.Object3D,
	zoneName?: string,
) => void;

/** Global listeners for carry events */
const carryEventListeners: CarryEventListener[] = [];

/** Register a global listener for carry events */
export function onCarryEvent(listener: CarryEventListener): void {
	carryEventListeners.push(listener);
}

/** Remove a global carry event listener */
export function removeCarryEventListener(listener: CarryEventListener): void {
	const idx = carryEventListeners.indexOf(listener);
	if (idx !== -1) carryEventListeners.splice(idx, 1);
}

/** Clear all carry event listeners (called on game cleanup) */
export function clearCarryEventListeners(): void {
	carryEventListeners.length = 0;
}

/** Duck-typed AnimalController interface (avoids circular imports) */
export interface CarryableAnimalLike {
	getCharacter(): THREE.Object3D;
	getPhysicsBody(): import('@dimforge/rapier3d-compat').RigidBody | null;
	setTargetPosition(target: THREE.Vector3 | null, maxPathLength?: number): void;
	setBeingCarried(carried: boolean): void;
	setBehavior(behavior: INpcBehavior): void;
	detachBehavior(): INpcBehavior | null;
}

/** Create a CarryableEntityAdapter from an AnimalController. */
export function createAnimalAdapter(animal: CarryableAnimalLike): CarryableEntityAdapter {
	let savedParent: THREE.Object3D | null = null;

	return {
		getObject3D: () => animal.getCharacter(),
		disablePhysics: () => {
			const body = animal.getPhysicsBody();
			if (body && body.isValid()) body.setEnabled(false);
			savedParent = animal.getCharacter().parent;
			animal.setBeingCarried(true);
		},
		enablePhysics: (position: THREE.Vector3) => {
			const body = animal.getPhysicsBody();
			const character = animal.getCharacter();
			animal.setBeingCarried(false);
			if (body && body.isValid()) {
				body.setTranslation({ x: position.x, y: position.y + 0.5, z: position.z }, true);
				body.setLinvel({ x: 0, y: 0, z: 0 }, true);
				body.setEnabled(true);
			}
			// Re-parent to original parent (usually scene)
			if (savedParent && character.parent !== savedParent) {
				savedParent.add(character);
			}
		},
		pauseBehavior: () => {
			animal.setTargetPosition(null);
		},
		resumeBehavior: () => {
			// Behavior resumes naturally on next update cycle
		},
	};
}

/**
 * Behavior wrapper that adds carry interaction to any existing animal behavior.
 * Installed automatically by CarryableComponent.fromAnimal().
 * Delegates roaming/AI to the wrapped behavior while adding onPlayerInteract
 * for pickup/drop via the linked CarryableComponent.
 */
class CarryableAnimalBehavior implements INpcBehavior {
	public focusOffsetY: number;
	private wrappedBehavior: INpcBehavior | null;
	private carryable: CarryableComponent;

	constructor(carryable: CarryableComponent, existingBehavior: INpcBehavior | null) {
		this.carryable = carryable;
		this.wrappedBehavior = existingBehavior;
		this.focusOffsetY = existingBehavior?.focusOffsetY ?? DEFAULT_NPC_BEHAVIOR_FOCUS_OFFSET_Y;
	}

	getFocusTarget(npcPosition: THREE.Vector3): THREE.Vector3 {
		return this.wrappedBehavior?.getFocusTarget(npcPosition)
			?? createNpcFocusTarget(npcPosition, this.focusOffsetY);
	}

	initialize(controller: ICharacterContext): void {
		this.wrappedBehavior?.initialize(controller);
	}

	update(
		deltaTime: number,
		currentPosition: THREE.Vector3,
		currentTarget: THREE.Vector3 | null,
	): THREE.Vector3 | null {
		// While carried or placed, don't roam
		if (this.carryable.state !== 'idle') {
			return null;
		}
		return this.wrappedBehavior?.update(deltaTime, currentPosition, currentTarget) ?? null;
	}

	onTargetReached(): void {
		this.wrappedBehavior?.onTargetReached?.();
	}

	onPlayerInteract(): boolean {
		return this.carryable.onInteractStart();
	}

	getInteractDisplayName(): string {
		return this.carryable.getInteractStartDisplayName();
	}

	getName(): string {
		return 'CarryableAnimal';
	}

	isHostile(): boolean {
		return this.wrappedBehavior?.isHostile() ?? false;
	}

	onNpcDeath(): void {
		// Force-drop the carried object when the animal dies
		this.carryable.forceDrop();
		this.wrappedBehavior?.onNpcDeath?.();
	}

	dispose(): void {
		this.wrappedBehavior?.dispose();
	}
}

export class CarryableComponent implements Interactable {
	private physicsWorld: PhysicsWorld;
	private object3D: THREE.Object3D;
	private _displayName: string;
	private carryOffset: THREE.Vector3;
	private rotateWithPlayer: boolean;
	private attachToHand: string | null;

	// State
	private _state: CarryState = 'idle';
	private lastPlayerPosition: THREE.Vector3 = new THREE.Vector3();

	// Physics sensor for E-key detection.
	// For simple objects: created at init, persistent.
	// For entityAdapter: null at init, temporary sensor created during carry.
	private interactableComponent: InteractableComponent | null;

	// Entity adapter for complex entities (AnimalController, etc.)
	private entityAdapter: CarryableEntityAdapter | null;

	// Parent tracking for reparenting during carry
	private savedParent: THREE.Object3D | null = null;

	// Hand attachment tracking
	private _attachedToController: boolean = false;

	// Callbacks
	private onPickedUpCallback: ((component: CarryableComponent) => void) | null;
	private onDroppedCallback: ((component: CarryableComponent) => void) | null;
	private onPlacedInZoneCallback: ((component: CarryableComponent, zoneName: string) => void) | null;
	private meta: { objectId: string; name: string } | undefined;

	// Reusable math objects
	private static _tempOffset = new THREE.Vector3();
	private static _yawQuat = new THREE.Quaternion();
	private static _euler = new THREE.Euler();

	private _disposed: boolean = false;

	constructor(physicsWorld: PhysicsWorld, config: CarryableConfig) {
		this.physicsWorld = physicsWorld;
		this.entityAdapter = config.entityAdapter ?? null;
		this.object3D = this.entityAdapter
			? this.entityAdapter.getObject3D()
			: config.object3D!;
		this._displayName = config.displayName;
		this.carryOffset = config.carryOffset?.clone() ?? new THREE.Vector3(0, 0.6, 1.0);
		this.rotateWithPlayer = config.rotateWithPlayer ?? true;
		this.attachToHand = config.attachToHand !== undefined ? config.attachToHand : 'rightHand';
		this.meta = config.meta;

		// Callbacks
		this.onPickedUpCallback = config.onPickedUp ?? null;
		this.onDroppedCallback = config.onDropped ?? null;
		this.onPlacedInZoneCallback = config.onPlacedInZone ?? null;

		// Only create our own sensor if there's no entity adapter.
		// Entities like AnimalController have their own InteractableComponent for pickup.
		// A temporary sensor is created during carry (see pickUp/drop).
		if (this.entityAdapter) {
			this.interactableComponent = null;
		} else {
			this.interactableComponent = new InteractableComponent(physicsWorld, {
				interactable: this,
				object3D: this.object3D,
				radius: config.radius ?? 2.5,
			});
		}

		// Auto-register for engine-level updates (PlayerController ticks these each frame)
		getInteractionManager().registerCarryable(this);
	}

	/**
	 * Convenience factory for wrapping an AnimalController.
	 *
	 * Automatically wraps the animal's current behavior with carry interaction
	 * support. The animal's existing Interactable handles E-key detection;
	 * the wrapped behavior delegates onPlayerInteract to the CarryableComponent.
	 *
	 * No manual behavior wiring needed — just call this after setting the
	 * animal's roaming/idle behavior.
	 */
	static fromAnimal(
		animal: CarryableAnimalLike,
		physicsWorld: PhysicsWorld,
		config: Omit<CarryableConfig, 'object3D' | 'entityAdapter'>,
	): CarryableComponent {
		const carryable = new CarryableComponent(physicsWorld, {
			...config,
			// Animals are full character models — use offset positioning, not hand bone attachment
			attachToHand: config.attachToHand !== undefined ? config.attachToHand : null,
			entityAdapter: createAnimalAdapter(animal),
		});

		// Detach the existing behavior (without disposing it) and wrap it
		// with carry interaction support. setBehavior installs the wrapper.
		const existingBehavior = animal.detachBehavior();
		animal.setBehavior(new CarryableAnimalBehavior(carryable, existingBehavior));

		return carryable;
	}

	// ---- Interactable interface ----

	onInteractStart(): boolean {
		if (this._disposed) return false;
		if (this._state === 'idle') {
			this.pickUp();
			return true;
		}
		if (this._state === 'carried') {
			this.drop();
			return true;
		}
		return false;
	}

	getInteractStartDisplayName(): string {
		if (this._state === 'carried') {
			const zone = DropZoneComponent.findZoneAtPosition(this.lastPlayerPosition);
			if (zone) {
				return `place ${this._displayName} in ${zone.displayName}`;
			}
			return `drop ${this._displayName}`;
		}
		return `pick up ${this._displayName}`;
	}

	interactionEnabled(): boolean {
		if (this._disposed || this._state === 'placed') return false;
		// The carried object is always interactable (for drop/place).
		if (this._state === 'carried') return true;
		// Block pickup when already carrying something else.
		return !getInteractionManager().isCarrying();
	}

	isFollowingPlayer(): boolean {
		// Only the carry-drop sensor follows the player. When idle (waiting to
		// be picked up) or placed, the object is world-fixed.
		return this._state === 'carried';
	}

	// ---- Public API ----

	/**
	 * Get the current carry state.
	 */
	get state(): CarryState {
		return this._state;
	}

	/**
	 * Get the display name.
	 */
	get displayName(): string {
		return this._displayName;
	}

	/**
	 * Get the carried object.
	 */
	getObject3D(): THREE.Object3D {
		return this.object3D;
	}

	/**
	 * Check if this object is currently being carried.
	 */
	isCarried(): boolean {
		return this._state === 'carried';
	}

	/**
	 * Force-drop the carried object (e.g., when player dies, enters vehicle, or animal dies).
	 */
	forceDrop(): void {
		if (this._state === 'carried') {
			this.drop();
		}
	}

	/**
	 * Update the carried object position to follow the player.
	 * Call every frame. Only does work when state is 'carried'.
	 *
	 * @param _deltaTime - Frame delta (reserved for future animations)
	 * @param playerPosition - Current player world position
	 * @param playerQuaternion - Current player world rotation
	 */
	update(_deltaTime: number, playerPosition: THREE.Vector3, playerQuaternion: THREE.Quaternion): void {
		if (this._state !== 'carried' || this._disposed) return;

		this.lastPlayerPosition.copy(playerPosition);

		// When attached to a hand bone, the object moves automatically as a child.
		// We only need to sync the sensor.
		if (!this._attachedToController) {
			// Fallback: world-space offset positioning (when attachToHand is null)
			const euler = CarryableComponent._euler.setFromQuaternion(playerQuaternion, 'YXZ');
			const yawQuat = CarryableComponent._yawQuat.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, euler.y);

			const offset = CarryableComponent._tempOffset.copy(this.carryOffset);
			offset.applyQuaternion(yawQuat);

			this.object3D.position.copy(playerPosition).add(offset);

			if (this.rotateWithPlayer) {
				this.object3D.quaternion.copy(yawQuat);
			}
		}

		// Keep the carry sensor near the player so E-key detection works while carrying.
		// When attached to a hand bone, object3D.position is local space (useless for sensor).
		// We sync the sensor to the player position directly instead.
		if (this.interactableComponent) {
			if (this._attachedToController) {
				this.interactableComponent.syncToWorldPosition(playerPosition);
			} else {
				this.interactableComponent.syncPosition();
			}
		}
	}

	/**
	 * Check if this component has been disposed.
	 */
	isDisposed(): boolean {
		return this._disposed;
	}

	/**
	 * Attach the carried object to the player's hand bone.
	 * Called by InteractionManager when carry state transitions to 'carried'.
	 */
	onCarryAttach(controller: CarryPlayerController): void {
		if (!this.attachToHand || this._attachedToController) return;
		// Reset local position/rotation — the hand bone provides the world transform
		this.object3D.position.set(0, 0, 0);
		this.object3D.rotation.set(0, 0, 0);
		const attached = controller.attachToBodyPart(this.object3D, this.attachToHand, null);
		this._attachedToController = attached;
	}

	/**
	 * Detach the carried object from the player's hand bone.
	 * Called by InteractionManager when carry state transitions away from 'carried'.
	 */
	onCarryDetach(controller: CarryPlayerController): void {
		if (!this._attachedToController) return;
		controller.detachFromBodyPart(this.object3D);
		this._attachedToController = false;
		// Reparent back to scene (restoreEntity handles this for entityAdapter mode)
		if (!this.entityAdapter && this.savedParent) {
			this.savedParent.add(this.object3D);
		}
	}

	/**
	 * Clean up physics resources. Force-drops the object if currently carried.
	 */
	dispose(): void {
		if (this._disposed) return;

		// Restore entity state if currently carried
		if (this._state === 'carried') {
			const pos = this._attachedToController
				? this.lastPlayerPosition.clone()
				: this.object3D.position.clone();
			this.restoreEntity(pos);
		}

		this._disposed = true;
		this.disposeCarrySensor();

		if (this.interactableComponent) {
			this.interactableComponent.dispose();
			this.interactableComponent = null;
		}

		getInteractionManager().unregisterCarryable(this);
	}

	// ---- Private methods ----

	/**
	 * Create a temporary InteractableComponent sensor that follows the carried object.
	 * Used in entityAdapter mode because the entity's own sensor is attached to its
	 * (now disabled) physics body and won't move.
	 */
	private createCarrySensor(): void {
		if (this.interactableComponent) return; // Already has a sensor
		this.interactableComponent = new InteractableComponent(this.physicsWorld, {
			interactable: this,
			object3D: this.object3D,
			radius: 1.5, // Small radius — object is right on the player
		});
	}

	/**
	 * Dispose the temporary carry sensor (entityAdapter mode only).
	 */
	private disposeCarrySensor(): void {
		if (!this.entityAdapter || !this.interactableComponent) return;
		this.interactableComponent.dispose();
		this.interactableComponent = null;
	}

	private pickUp(): void {
		this._state = 'carried';

		if (this.entityAdapter) {
			// Entity mode: disable physics and pause behavior via adapter
			this.entityAdapter.disablePhysics();
			this.entityAdapter.pauseBehavior?.();
			// Create a temporary sensor so the player can press E to drop
			// (the entity's own sensor is attached to its disabled physics body)
			this.createCarrySensor();
		} else {
			// Simple mode: disable the object's own rigid body if it has one
			const rigidBody = this.object3D.userData.rigidBody;
			if (rigidBody && this.physicsWorld) {
				this.physicsWorld.removeRigidBody(rigidBody);
				this.object3D.userData.rigidBody = null;
				this.object3D.userData.rigidBodyRemovedByCarry = true;
			}
		}

		// Save parent for reparenting on drop
		this.savedParent = this.object3D.parent;

		this.onPickedUpCallback?.(this);
		this.emitEvent('pickedUp');
	}

	private drop(): void {
		const zone = DropZoneComponent.findZoneAtPosition(this.lastPlayerPosition);

		// Compute drop position BEFORE detaching from hand.
		// For hand-attached objects, object3D.position is local (0,0,0) — use player position.
		const dropPos = this._attachedToController
			? this.lastPlayerPosition.clone()
			: this.object3D.position.clone();

		// Clear hand attachment flag so InteractionManager's onCarryDetach is a no-op.
		// We handle the reparenting ourselves in restoreEntity() below.
		this._attachedToController = false;

		// Dispose temporary carry sensor before restoring entity
		this.disposeCarrySensor();

		if (zone) {
			// Place in zone
			this._state = 'placed';

			const zonePos = zone.getPosition();
			this.restoreEntity(zonePos);
			this.object3D.position.copy(zonePos);
			this.object3D.position.y += 0.5; // Slight lift above ground

			zone.notifyObjectPlaced(this._displayName, this.object3D);

			this.onPlacedInZoneCallback?.(this, zone.name);
			this.emitEvent('placedInZone', zone.name);

			// Disable interaction after placement (simple mode only — entity mode has no persistent sensor)
			if (this.interactableComponent) {
				this.interactableComponent.setEnabled(false);
			}
		} else {
			// Drop at current position
			this._state = 'idle';

			// Snap Y to ground via physics raycast
			dropPos.y = this.getGroundHeight(dropPos.x, dropPos.z);

			this.restoreEntity(dropPos);
			this.object3D.position.copy(dropPos);

			this.onDroppedCallback?.(this);
			this.emitEvent('dropped');
		}

		// Sync sensor position to the dropped location (simple mode)
		if (this.interactableComponent) {
			this.interactableComponent.syncPosition();
		}
	}

	/**
	 * Re-enable entity physics/behavior after carrying.
	 */
	private restoreEntity(position: THREE.Vector3): void {
		if (this.entityAdapter) {
			this.entityAdapter.enablePhysics(position);
			this.entityAdapter.resumeBehavior?.();
		} else if (this.savedParent && this.object3D.parent !== this.savedParent) {
			// Re-parent to original parent if needed
			this.savedParent.add(this.object3D);
		}
		this.savedParent = null;
	}

	/** Raycast downward to find ground height at a world X/Z position. */
	private getGroundHeight(x: number, z: number): number {
		const origin = new THREE.Vector3(x, 500, z);
		const direction = new THREE.Vector3(0, -1, 0);
		const result = this.physicsWorld.raycast(origin, direction, 600, CollisionGroup.TERRAIN | CollisionGroup.ENVIRONMENT);
		return result.hasHit ? result.hitPoint.y : 0;
	}

	private emitEvent(event: 'pickedUp' | 'dropped' | 'placedInZone', zoneName?: string): void {
		const name = this.meta?.name ?? this._displayName;
		for (const listener of carryEventListeners) {
			listener(event, name, this.object3D, zoneName);
		}
	}
}
