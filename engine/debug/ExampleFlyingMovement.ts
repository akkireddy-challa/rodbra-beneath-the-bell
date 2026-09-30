import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { IPlayerMovement } from 'engine/IPlayerMovement.js';
import type { PlayerController } from 'engine/PlayerController.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';

/**
 * Example flying movement implementation for debugging
 * Allows free movement in 3D space without gravity
 * Press Space to ascend, Ctrl to descend
 */
export class ExampleFlyingMovement implements IPlayerMovement {
	private moveSpeed: number;
	private verticalSpeed: number;
	private rotation: number;
	private currentSpeed: number;

	constructor(moveSpeed: number = 8, verticalSpeed: number = 5) {
		this.moveSpeed = moveSpeed;
		this.verticalSpeed = verticalSpeed;
		this.rotation = 0;
		this.currentSpeed = 0;
	}

	update(
		deltaTime: number,
		playerController: PlayerController,
		keys: { forward: boolean; backward: boolean; left: boolean; right: boolean; ascend: boolean; interact: boolean; action: boolean; descend: boolean },
		isGrounded: boolean,
		moveDirection: THREE.Vector3,
		playerBody: RAPIER.RigidBody,
		physicsWorld: PhysicsWorld
	): void {
		const velocity = playerBody.linvel();
		const isMoving = moveDirection.length() > 0;
		this.currentSpeed = 0;

		let velX = 0;
		let velY = 0;
		let velZ = 0;

		// Horizontal movement
		if (isMoving) {
			this.rotation = Math.atan2(moveDirection.x, moveDirection.z);

			velX = moveDirection.x * this.moveSpeed;
			velZ = moveDirection.z * this.moveSpeed;

			this.currentSpeed = this.moveSpeed;

			// Face movement direction
			if (playerController.player) {
				playerController.player.rotation.y = this.rotation;
			}
		}

		// Vertical movement (Space to go up, Ctrl to go down)
		if (keys.ascend) {
			velY = this.verticalSpeed;
		}
		if (keys.descend) {
			velY = -this.verticalSpeed;
		}

		playerBody.setLinvel({ x: velX, y: velY, z: velZ }, true);

		// Prevent rotation
		playerBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
	}

	getCurrentSpeed(): number {
		return this.currentSpeed;
	}

	isInAir(): boolean {
		// Always in air when flying
		return true;
	}

	getRotation(): number {
		return this.rotation;
	}

	setRotation(rotation: number): void {
		this.rotation = rotation;
	}

	reset(): void {
		this.currentSpeed = 0;
	}

	getMoveSpeed(): number {
		return this.moveSpeed;
	}

	setMoveSpeed(speed: number): void {
		this.moveSpeed = speed;
	}

	getVerticalSpeed(): number {
		return this.verticalSpeed;
	}

	setVerticalSpeed(speed: number): void {
		this.verticalSpeed = speed;
	}

	getAscendDisplayName(): string {
		return 'Ascend';
	}

	getDescendDisplayName(): string {
		return 'Descend';
	}

	getSupportedKeys(): { ascend: boolean; descend: boolean } {
		return {
			ascend: true,
			descend: true
		};
	}

	getKeyBehavior(): { ascend: 'tap' | 'continuous'; descend: 'tap' | 'continuous' } {
		return {
			ascend: 'continuous',
			descend: 'continuous'
		};
	}

	shouldShowPlayer(): boolean {
		return true;
	}
}
