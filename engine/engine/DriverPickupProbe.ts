/**
 * DriverPickupProbe - keeps auto-collect working while the player drives.
 *
 * On vehicle entry the player capsule is removed from the simulation entirely —
 * colliders AND body (see PlayerVehicleController.tryEnterVehicle): a kinematic
 * capsule parked inside the chassis flips small vehicles. But collectible
 * sensors are group TRIGGER with filter `CollisionMask.TRIGGER` (= PLAYER only),
 * so with no PLAYER-group collider left in the world a driver rolled straight
 * over coins and pickups without collecting anything.
 *
 * This probe is the driver's stand-in: a sensor collider in `CollisionGroup.PLAYER`
 * attached as a CHILD COLLIDER of the chassis body, so it follows the vehicle's
 * translation and rotation for free — no per-frame sync. Two properties keep it
 * from reintroducing the problem the capsule-disable solved:
 *
 *  - it is a SENSOR, so it never produces contact forces, and
 *  - its filter is TRIGGER only, so the sole colliders it can pair with are
 *    trigger sensors (all of which are themselves sensors).
 *
 * It exists only while a player is actually driving (created in
 * `RapierVehicle.enterVehicle_INTERNAL`, disposed in `exitVehicle`/`dispose`), so
 * a driverless or AI-driven vehicle does not hoover up collectibles.
 */

import RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import { CollisionGroup, makeCollisionGroups } from 'engine/CollisionLayers.js';
import { getInteractionManager } from 'engine/InteractionManager.js';

/**
 * Metres added to each chassis half-extent when sizing the probe, so a pickup
 * just off the bumper or under the sills still registers.
 */
export const DRIVER_PICKUP_PROBE_PADDING = 0.5;

/** Half-extents of the probe box before padding — normally the chassis half-size. */
export interface DriverPickupProbeHalfExtents {
	x: number;
	y: number;
	z: number;
}

export class DriverPickupProbe {
	private physicsWorld: PhysicsWorld;
	private collider: RAPIER.Collider | null = null;

	constructor(
		physicsWorld: PhysicsWorld,
		chassisBody: RAPIER.RigidBody,
		halfExtents: DriverPickupProbeHalfExtents
	) {
		this.physicsWorld = physicsWorld;

		const desc = RAPIER.ColliderDesc.cuboid(
			halfExtents.x + DRIVER_PICKUP_PROBE_PADDING,
			halfExtents.y + DRIVER_PICKUP_PROBE_PADDING,
			halfExtents.z + DRIVER_PICKUP_PROBE_PADDING
		)
			.setSensor(true)
			// Mass 0: the probe must not change how the chassis handles.
			.setMass(0)
			.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
			.setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL)
			.setCollisionGroups(makeCollisionGroups(CollisionGroup.PLAYER, CollisionGroup.TRIGGER));

		this.collider = this.physicsWorld.createCollider(desc, chassisBody);
		getInteractionManager().registerPickupProbe(this.collider.handle);
	}

	/** Collider handle of the probe, or null once disposed. */
	getColliderHandle(): number | null {
		return this.collider ? this.collider.handle : null;
	}

	/** Remove the probe collider and unregister it from the InteractionManager. */
	dispose(): void {
		if (!this.collider) return;

		getInteractionManager().unregisterPickupProbe(this.collider.handle);
		if (this.collider.isValid()) {
			this.physicsWorld.removeCollider(this.collider);
		}
		this.collider = null;
	}
}
