/**
 * CollectibleComponent - Rapier trigger-based auto-collect component
 *
 * Creates a Rapier sensor collider that fires onCollect() automatically
 * when the player enters the trigger radius. Unlike InteractableComponent,
 * this does NOT wait for the E key — it fires immediately on overlap.
 *
 * After collection the sensor is disposed so it only fires once.
 */

import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import { isPlaneLockedPhysics } from 'engine/physics/PlaneLockedPhysics.js';
import type { Collectible } from 'types/collectible.js';
import { CollisionGroup, CollisionMask, makeCollisionGroups } from 'engine/CollisionLayers.js';
import { getInteractionManager } from 'engine/InteractionManager.js';

export interface CollectibleComponentConfig {
	/** The Collectible implementation (the object handling collection logic) */
	collectible: Collectible;
	/** Three.js object to track position from */
	object3D: THREE.Object3D;
	/** Sensor radius for trigger detection (default: 2.0) */
	radius?: number;
	/** Y offset for the sensor position (default: 0.5) */
	yOffset?: number;
	/** Optional metadata for collection event callbacks (objectId, name) */
	meta?: { objectId: string; name: string };
}

export class CollectibleComponent {
	private physicsWorld: PhysicsWorld;
	private collectible: Collectible;
	private object3D: THREE.Object3D;

	// Physics sensor
	private sensorBody: RAPIER.RigidBody | null = null;
	private sensorCollider: RAPIER.Collider | null = null;

	private _disposed: boolean = false;

	constructor(physicsWorld: PhysicsWorld, config: CollectibleComponentConfig) {
		this.physicsWorld = physicsWorld;
		this.collectible = config.collectible;
		this.object3D = config.object3D;

		const radius = config.radius ?? 2.0;
		const yOffset = config.yOffset ?? 0.5;

		this.createSensor(radius, yOffset);

		// Register with the interaction manager as a collectible
		if (this.sensorCollider) {
			getInteractionManager().registerCollectible(this.sensorCollider.handle, this, config.meta);
		}
	}

	private createSensor(radius: number, yOffset: number): void {
		const pos = this.object3D.position;

		// 2D-physics lane: the same trigger, as a 2D sensor ball on the plane. The
		// engine wires the InteractionManager to the 2D world's sensor events at
		// boot, so collection resolves exactly as it does in 3D.
		if (isPlaneLockedPhysics(this.physicsWorld)) {
			const built = this.physicsWorld.createSensorBall({
				x: pos.x, y: pos.y + yOffset, z: pos.z, radius,
				collisionGroups: makeCollisionGroups(CollisionGroup.TRIGGER, CollisionMask.TRIGGER),
			});
			this.sensorBody = built.body as unknown as RAPIER.RigidBody;
			this.sensorCollider = built.collider as unknown as RAPIER.Collider;
			return;
		}

		// Create a dedicated fixed body for the sensor
		const bodyDesc = RAPIER.RigidBodyDesc.fixed()
			.setTranslation(pos.x, pos.y + yOffset, pos.z);

		this.sensorBody = this.physicsWorld.createRigidBody(bodyDesc);

		const colliderDesc = RAPIER.ColliderDesc.ball(radius)
			.setSensor(true)
			.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
			.setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL)
			.setCollisionGroups(makeCollisionGroups(CollisionGroup.TRIGGER, CollisionMask.TRIGGER));

		this.sensorCollider = this.physicsWorld.createCollider(colliderDesc, this.sensorBody);
	}

	/**
	 * Get the Collectible implementation
	 */
	getCollectible(): Collectible {
		return this.collectible;
	}

	/**
	 * Get the tracked Three.js object
	 */
	getObject3D(): THREE.Object3D {
		return this.object3D;
	}

	/**
	 * Get the sensor collider handle (for lookup)
	 */
	getSensorHandle(): number | null {
		return this.sensorCollider ? this.sensorCollider.handle : null;
	}

	/**
	 * Check if this component has been disposed
	 */
	isDisposed(): boolean {
		return this._disposed;
	}

	/**
	 * Clean up physics resources and unregister from InteractionManager
	 */
	dispose(): void {
		if (this._disposed) return;
		this._disposed = true;

		// Unregister from the interaction manager and remove the sensor collider
		if (this.sensorCollider) {
			getInteractionManager().unregisterCollectible(this.sensorCollider.handle);
			this.physicsWorld.removeCollider(this.sensorCollider);
			this.sensorCollider = null;
		}

		// Remove the body (we always own it)
		if (this.sensorBody) {
			this.physicsWorld.removeRigidBody(this.sensorBody);
			this.sensorBody = null;
		}
	}
}
