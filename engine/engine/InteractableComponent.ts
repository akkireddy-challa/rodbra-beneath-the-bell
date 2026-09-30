/**
 * InteractableComponent - Rapier trigger-based interaction component
 *
 * Attach to any object to make it interactable via physics sensor triggers.
 * Creates a Rapier sensor collider that detects player proximity using the
 * TRIGGER collision group, replacing the old scene-traversal approach.
 */

import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import type { Interactable } from 'types/interactable.js';
import { CollisionGroup, CollisionMask, makeCollisionGroups } from 'engine/CollisionLayers.js';
import { getInteractionManager } from 'engine/InteractionManager.js';
import { isPlaneLockedPhysics } from 'engine/physics/PlaneLockedPhysics.js';

export interface InteractableComponentConfig {
	/** The Interactable implementation (the object handling interaction logic) */
	interactable: Interactable;
	/** Three.js object to track position from (used for syncPosition) */
	object3D: THREE.Object3D;
	/** Sensor radius for trigger detection (default: 3.0) */
	radius?: number;
	/**
	 * Optional existing physics body to parent the sensor collider to.
	 * If provided, the sensor is attached as a child collider of this body.
	 * If not provided, a new fixed rigid body is created for the sensor.
	 */
	physicsBody?: RAPIER.RigidBody;
	/** Y offset for the sensor position (default: 0.5) */
	yOffset?: number;
}

export class InteractableComponent {
	private physicsWorld: PhysicsWorld;
	private interactable: Interactable;
	private object3D: THREE.Object3D;

	// Physics sensor
	private sensorBody: RAPIER.RigidBody | null = null;
	private sensorCollider: RAPIER.Collider | null = null;
	private ownsBody: boolean = false; // Whether we created the body (and should clean it up)

	private yOffset: number;
	private _disposed: boolean = false;

	constructor(physicsWorld: PhysicsWorld, config: InteractableComponentConfig) {
		this.physicsWorld = physicsWorld;
		this.interactable = config.interactable;
		this.object3D = config.object3D;
		this.yOffset = config.yOffset ?? 0.5;

		const radius = config.radius ?? 3.0;

		this.createSensor(config.physicsBody ?? null, radius);

		// Register with the interaction manager
		if (this.sensorCollider) {
			getInteractionManager().register(this.sensorCollider.handle, this);
		}
	}

	private createSensor(existingBody: RAPIER.RigidBody | null, radius: number): void {
		const triggerGroups = makeCollisionGroups(CollisionGroup.TRIGGER, CollisionMask.TRIGGER);

		// 2D-physics lane: the same ball sensor on the plane. Everything below is
		// 3D Rapier, which a 2D-only bundle does not ship, so this branch comes
		// BEFORE the first `RAPIER.` read.
		if (isPlaneLockedPhysics(this.physicsWorld)) {
			if (existingBody) {
				this.sensorBody = existingBody;
				this.ownsBody = false;
				this.sensorCollider = this.physicsWorld.attachSensorBall(existingBody, { radius, collisionGroups: triggerGroups }) as unknown as RAPIER.Collider;
			} else {
				const pos = this.object3D.position;
				const built = this.physicsWorld.createSensorBall({
					x: pos.x, y: pos.y + this.yOffset, z: pos.z, radius, collisionGroups: triggerGroups,
				});
				this.sensorBody = built.body as unknown as RAPIER.RigidBody;
				this.ownsBody = true;
				this.sensorCollider = built.collider as unknown as RAPIER.Collider;
			}
			return;
		}

		// Sensor collider descriptor (same for both attached and standalone modes)
		const colliderDesc = RAPIER.ColliderDesc.ball(radius)
			.setSensor(true)
			.setMass(0)  // Sensor must not contribute mass/inertia
			.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
			.setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL)
			.setCollisionGroups(triggerGroups);

		if (existingBody) {
			// Attach sensor collider to existing body
			this.sensorBody = existingBody;
			this.ownsBody = false;
			this.sensorCollider = this.physicsWorld.createCollider(colliderDesc, existingBody);
		} else {
			// Create a dedicated fixed body for the sensor
			const pos = this.object3D.position;
			const bodyDesc = RAPIER.RigidBodyDesc.fixed()
				.setTranslation(pos.x, pos.y + this.yOffset, pos.z);

			this.sensorBody = this.physicsWorld.createRigidBody(bodyDesc);
			this.ownsBody = true;
			this.sensorCollider = this.physicsWorld.createCollider(colliderDesc, this.sensorBody);
		}
	}

	/**
	 * Sync the sensor position with the tracked Three.js object.
	 * Call this each frame for moving objects (NPCs, animals, vehicles).
	 * Not needed for static objects.
	 */
	syncPosition(): void {
		this.syncToWorldPosition(this.object3D.position);
	}

	/**
	 * Sync the sensor to an explicit world position.
	 * Use this instead of syncPosition() when the tracked object3D is parented
	 * to another object (e.g., hand bone) and its position is in local space.
	 */
	syncToWorldPosition(worldPos: THREE.Vector3): void {
		if (this._disposed || !this.sensorBody || !this.ownsBody) return;
		if (!this.sensorBody.isValid()) return;

		this.sensorBody.setTranslation(
			{ x: worldPos.x, y: worldPos.y + this.yOffset, z: worldPos.z },
			true
		);
	}

	/**
	 * Get the Interactable implementation
	 */
	getInteractable(): Interactable {
		return this.interactable;
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
	 * Enable or disable the sensor (for hibernation support)
	 */
	setEnabled(enabled: boolean): void {
		if (this._disposed) return;
		if (this.sensorCollider && this.sensorCollider.isValid()) {
			this.sensorCollider.setEnabled(enabled);
		}
		// For owned bodies, also enable/disable the body
		if (this.ownsBody && this.sensorBody && this.sensorBody.isValid()) {
			this.sensorBody.setEnabled(enabled);
		}
	}

	/**
	 * Clean up physics resources and unregister from InteractionManager
	 */
	dispose(): void {
		if (this._disposed) return;
		this._disposed = true;

		// Unregister from the interaction manager and remove the sensor collider
		if (this.sensorCollider) {
			getInteractionManager().unregister(this.sensorCollider.handle);
			this.physicsWorld.removeCollider(this.sensorCollider);
			this.sensorCollider = null;
		}

		// Only remove the body if we created it
		if (this.ownsBody && this.sensorBody) {
			this.physicsWorld.removeRigidBody(this.sensorBody);
		}
		this.sensorBody = null;
	}
}
