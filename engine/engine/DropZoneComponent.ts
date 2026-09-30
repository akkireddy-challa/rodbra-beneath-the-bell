/**
 * DropZoneComponent - Trigger volume for depositing carried objects
 *
 * Defines an area where players can place objects they are carrying
 * (via CarryableComponent). Maintains a static registry so CarryableComponent
 * can efficiently find nearby zones when the player drops an object.
 */

import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import { CollisionGroup, CollisionMask, makeCollisionGroups } from 'engine/CollisionLayers.js';
import { isPlaneLockedPhysics } from 'engine/physics/PlaneLockedPhysics.js';

export interface DropZoneConfig {
	/** World position of the zone center */
	position: THREE.Vector3;
	/** Detection radius (default: 5.0) */
	radius?: number;
	/** Unique identifier for this zone */
	name: string;
	/** Human-readable name shown in UI prompts (e.g., "breeding pen") */
	displayName: string;
	/** Called when an object is placed in this zone */
	onObjectPlaced?: (objectName: string, object3D: THREE.Object3D) => void;
	/** Optional capacity limit (-1 = unlimited, default: -1) */
	capacity?: number;
}

export class DropZoneComponent {
	/** Global registry of all active drop zones */
	private static registry: Set<DropZoneComponent> = new Set();

	private physicsWorld: PhysicsWorld;
	private position: THREE.Vector3;
	private radius: number;
	private _name: string;
	private _displayName: string;
	private onObjectPlacedCallback: ((objectName: string, object3D: THREE.Object3D) => void) | null;
	private capacity: number;
	private placedCount: number = 0;

	// Physics sensor (for visual debug and future use)
	private sensorBody: RAPIER.RigidBody | null = null;
	private sensorCollider: RAPIER.Collider | null = null;

	private _disposed: boolean = false;

	constructor(physicsWorld: PhysicsWorld, config: DropZoneConfig) {
		this.physicsWorld = physicsWorld;
		this.position = config.position.clone();
		this.radius = config.radius ?? 5.0;
		this._name = config.name;
		this._displayName = config.displayName;
		this.onObjectPlacedCallback = config.onObjectPlaced ?? null;
		this.capacity = config.capacity ?? -1;

		this.createSensor();

		// Register in the global registry
		DropZoneComponent.registry.add(this);
	}

	private createSensor(): void {
		// 2D-physics lane: the same trigger ball on the plane (see InteractableComponent).
		if (isPlaneLockedPhysics(this.physicsWorld)) {
			const built = this.physicsWorld.createSensorBall({
				x: this.position.x, y: this.position.y, z: this.position.z,
				radius: this.radius,
				collisionGroups: makeCollisionGroups(CollisionGroup.TRIGGER, CollisionMask.TRIGGER),
			});
			this.sensorBody = built.body as unknown as RAPIER.RigidBody;
			this.sensorCollider = built.collider as unknown as RAPIER.Collider;
			return;
		}

		const bodyDesc = RAPIER.RigidBodyDesc.fixed()
			.setTranslation(this.position.x, this.position.y + 0.5, this.position.z);

		this.sensorBody = this.physicsWorld.createRigidBody(bodyDesc);

		const colliderDesc = RAPIER.ColliderDesc.ball(this.radius)
			.setSensor(true)
			.setMass(0)
			.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
			.setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL)
			.setCollisionGroups(makeCollisionGroups(CollisionGroup.TRIGGER, CollisionMask.TRIGGER));

		this.sensorCollider = this.physicsWorld.createCollider(colliderDesc, this.sensorBody);
	}

	// ---- Static registry API ----

	/**
	 * Find the nearest drop zone to a position within range.
	 * Returns null if no zone is within its own radius.
	 */
	static findZoneAtPosition(position: THREE.Vector3): DropZoneComponent | null {
		let nearest: DropZoneComponent | null = null;
		let nearestDist = Infinity;

		for (const zone of DropZoneComponent.registry) {
			if (zone._disposed || !zone.canAccept()) continue;
			const dist = position.distanceTo(zone.position);
			if (dist <= zone.radius && dist < nearestDist) {
				nearestDist = dist;
				nearest = zone;
			}
		}

		return nearest;
	}

	/**
	 * Find a drop zone by name.
	 */
	static findZoneByName(name: string): DropZoneComponent | null {
		for (const zone of DropZoneComponent.registry) {
			if (!zone._disposed && zone._name === name) return zone;
		}
		return null;
	}

	/**
	 * Clear all zones from the registry (call on game cleanup).
	 */
	static clearRegistry(): void {
		DropZoneComponent.registry.clear();
	}

	// ---- Public API ----

	get name(): string {
		return this._name;
	}

	get displayName(): string {
		return this._displayName;
	}

	/**
	 * Check if this zone can accept more objects.
	 */
	canAccept(): boolean {
		if (this.capacity === -1) return true;
		return this.placedCount < this.capacity;
	}

	/**
	 * Get the center position of this zone.
	 */
	getPosition(): THREE.Vector3 {
		return this.position.clone();
	}

	/**
	 * Get the zone radius.
	 */
	getRadius(): number {
		return this.radius;
	}

	/**
	 * Get the number of objects placed in this zone.
	 */
	getPlacedCount(): number {
		return this.placedCount;
	}

	/**
	 * Notify the zone that an object has been placed in it.
	 * Called by CarryableComponent when dropping in a zone.
	 */
	notifyObjectPlaced(objectName: string, object3D: THREE.Object3D): void {
		this.placedCount++;
		if (this.onObjectPlacedCallback) {
			this.onObjectPlacedCallback(objectName, object3D);
		}
	}

	/**
	 * Check if this component has been disposed.
	 */
	isDisposed(): boolean {
		return this._disposed;
	}

	/**
	 * Clean up physics resources and unregister from the global registry.
	 */
	dispose(): void {
		if (this._disposed) return;
		this._disposed = true;

		DropZoneComponent.registry.delete(this);

		if (this.sensorCollider) {
			this.physicsWorld.removeCollider(this.sensorCollider);
			this.sensorCollider = null;
		}

		if (this.sensorBody) {
			this.physicsWorld.removeRigidBody(this.sensorBody);
			this.sensorBody = null;
		}
	}
}
