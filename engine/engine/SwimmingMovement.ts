import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { IPlayerMovement } from 'engine/IPlayerMovement.js';
import type { PlayerController } from 'engine/PlayerController.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import { CollisionGroup } from 'engine/CollisionLayers.js';

/**
 * Swimming movement implementation for underwater/diving gameplay
 * 
 * Features:
 * - Character always in horizontal position (rotated 90 degrees around X axis)
 * - Character head always faces camera look direction
 * - W to swim forward, camera rotation controls swim direction
 * - A and D control Up/Down swimming with smooth orientation transitions
 */
export class SwimmingMovement implements IPlayerMovement {
	private moveSpeed: number;
	private rotation: number;
	private pitchRotation: number;
	private verticalVelocity: number;
	private horizontalVelocity: THREE.Vector3;
	private currentSpeed: number;
	private swimAcceleration: number;
	private swimFriction: number;
	private maxVerticalSpeed: number;
	private pitchTransitionSpeed: number;
	private horizontalWrapper: THREE.Group | null = null;

	constructor(
		moveSpeed: number = 4.0,
		swimAcceleration: number = 15.0,
		swimFriction: number = 0.85,
		maxVerticalSpeed: number = 6.0,
		pitchTransitionSpeed: number = 5.0
	) {
		this.moveSpeed = moveSpeed;
		this.rotation = 0;
		this.pitchRotation = Math.PI / 2;
		this.verticalVelocity = 0;
		this.horizontalVelocity = new THREE.Vector3(0, 0, 0);
		this.currentSpeed = 0;
		this.swimAcceleration = swimAcceleration;
		this.swimFriction = swimFriction;
		this.maxVerticalSpeed = maxVerticalSpeed;
		this.pitchTransitionSpeed = pitchTransitionSpeed;
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
		if (!playerBody) return; // body may be freed/nulled (e.g. dead NPC still updating)

		// Setup horizontal wrapper on first update if not already created
		if (!this.horizontalWrapper && playerController.player) {
			this.setupHorizontalWrapper(playerController.player);
		}

		const velocity = playerBody.linvel();
		let velX = velocity.x;
		let velY = velocity.y;
		let velZ = velocity.z;
		this.currentSpeed = 0;

		// Get camera controller for direction calculations
		const cameraController = playerController.getCameraController();
		let cameraForward: THREE.Vector3 | null = null;
		let cameraHorizontalAngle: number | null = null;

		if (cameraController) {
			if ((cameraController as any).spherical) {
				const spherical = (cameraController as any).spherical as THREE.Spherical;
				cameraHorizontalAngle = spherical.theta;
				
				cameraForward = new THREE.Vector3(
					Math.sin(cameraHorizontalAngle),
					0,
					Math.cos(cameraHorizontalAngle)
				);
			} else {
				const camera = (cameraController as any).camera as THREE.PerspectiveCamera | undefined;
				if (camera) {
					cameraForward = new THREE.Vector3();
					camera.getWorldDirection(cameraForward);
					cameraForward.y = 0;
					if (cameraForward.length() > 0.001) {
						cameraForward.normalize();
					} else {
						cameraForward = null;
					}
				}
			}
		}

		// Handle vertical movement (A = up, D = down)
		const isSwimmingUp = keys.left;
		const isSwimmingDown = keys.right;

		if (isSwimmingUp) {
			this.verticalVelocity = Math.min(this.verticalVelocity + this.swimAcceleration * deltaTime, this.maxVerticalSpeed);
		} else if (isSwimmingDown) {
			this.verticalVelocity = Math.max(this.verticalVelocity - this.swimAcceleration * deltaTime, -this.maxVerticalSpeed);
		} else {
			this.verticalVelocity *= Math.pow(this.swimFriction, deltaTime * 60);
		}

		if (Math.abs(this.verticalVelocity) > this.maxVerticalSpeed) {
			this.verticalVelocity = Math.sign(this.verticalVelocity) * this.maxVerticalSpeed;
		}

		velY = this.verticalVelocity;

		// Character head always faces camera look direction
		if (cameraHorizontalAngle !== null) {
			this.rotation = cameraHorizontalAngle + Math.PI;
		} else if (cameraForward && cameraForward.length() > 0.001) {
			this.rotation = Math.atan2(cameraForward.x, cameraForward.z) + Math.PI;
		} else {
			if (moveDirection.length() > 0.001) {
				this.rotation = Math.atan2(moveDirection.x, moveDirection.z) + Math.PI;
			}
		}

		// Handle forward movement
		if (keys.forward) {
			if (cameraForward) {
				const horizontalForward = new THREE.Vector3(-cameraForward.x, 0, -cameraForward.z);
				if (horizontalForward.length() > 0.001) {
					horizontalForward.normalize();
					const targetVelX = horizontalForward.x * this.moveSpeed;
					const targetVelZ = horizontalForward.z * this.moveSpeed;
					
					const accelFactor = this.swimAcceleration * deltaTime;
					this.horizontalVelocity.x += (targetVelX - this.horizontalVelocity.x) * accelFactor;
					this.horizontalVelocity.z += (targetVelZ - this.horizontalVelocity.z) * accelFactor;
					
					velX = this.horizontalVelocity.x;
					velZ = this.horizontalVelocity.z;
					
					this.currentSpeed = this.moveSpeed;
				}
			} else {
				const targetVelX = -moveDirection.x * this.moveSpeed;
				const targetVelZ = -moveDirection.z * this.moveSpeed;
				const accelFactor = this.swimAcceleration * deltaTime;
				this.horizontalVelocity.x += (targetVelX - this.horizontalVelocity.x) * accelFactor;
				this.horizontalVelocity.z += (targetVelZ - this.horizontalVelocity.z) * accelFactor;
				velX = this.horizontalVelocity.x;
				velZ = this.horizontalVelocity.z;
				this.currentSpeed = this.moveSpeed;
			}
		} else {
			const frictionFactor = Math.pow(this.swimFriction, deltaTime * 60);
			this.horizontalVelocity.x *= frictionFactor;
			this.horizontalVelocity.z *= frictionFactor;
			velX = this.horizontalVelocity.x;
			velZ = this.horizontalVelocity.z;
		}

		// Update pitch rotation based on vertical movement
		const targetPitch = isSwimmingUp || isSwimmingDown 
			? (isSwimmingUp ? 0 : Math.PI)
			: Math.PI / 2;

		const pitchDiff = targetPitch - this.pitchRotation;
		const pitchStep = Math.sign(pitchDiff) * Math.min(Math.abs(pitchDiff), this.pitchTransitionSpeed * deltaTime);
		this.pitchRotation += pitchStep;

		// Apply rotations
		if (playerController.player) {
			playerController.player.rotation.y = this.rotation;
			playerController.player.rotation.x = 0;
			playerController.player.rotation.z = 0;
			
			if (this.horizontalWrapper) {
				this.horizontalWrapper.rotation.x = this.pitchRotation;
				this.horizontalWrapper.rotation.y = 0;
				this.horizontalWrapper.rotation.z = 0;
			}
		}

		// The body is kinematicPositionBased: run the desired motion through the
		// shared character controller (collide-and-slide against the solid world,
		// props included via the augmented filter — see WalkingAndJumpingMovement),
		// then apply the clamped movement EXACTLY via setNextKinematicTranslation.
		// (Driving it as a velocity lets the fixed-60Hz substep overshoot the
		// clamped movement at high refresh rates and clip the swimmer through walls
		// / the ground — see CharacterLoader for the full rationale.)
		const collider = playerBody.numColliders() > 0 ? playerBody.collider(0) : null;
		if (collider && deltaTime > 0) {
			const controller = physicsWorld.getCharacterController();
			const kccFilter = collider.collisionGroups() | (CollisionGroup.DYNAMIC_PROP << 16);
			controller.computeColliderMovement(
				collider,
				{ x: velX * deltaTime, y: velY * deltaTime, z: velZ * deltaTime },
				RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
				kccFilter,
				(other) => other.handle !== collider.handle,
			);
			const mv = controller.computedMovement();
			const t = playerBody.translation();
			playerBody.setNextKinematicTranslation({ x: t.x + mv.x, y: t.y + mv.y, z: t.z + mv.z });
		}
	}

	getCurrentSpeed(): number {
		return this.currentSpeed;
	}

	isInAir(): boolean {
		return false;
	}

	getRotation(): number {
		return this.rotation;
	}

	setRotation(rotation: number): void {
		this.rotation = rotation;
	}

	reset(): void {
		this.verticalVelocity = 0;
		this.horizontalVelocity.set(0, 0, 0);
		this.currentSpeed = 0;
		this.pitchRotation = Math.PI / 2;
	}

	private setupHorizontalWrapper(player: THREE.Object3D): void {
		const firstChild = player.children[0];
		if (firstChild && firstChild.name === 'SwimmingHorizontalWrapper') {
			this.horizontalWrapper = firstChild as THREE.Group;
			return;
		}

		this.horizontalWrapper = new THREE.Group();
		this.horizontalWrapper.name = 'SwimmingHorizontalWrapper';
		this.horizontalWrapper.rotation.x = Math.PI / 2;
		
		const childrenToMove = [...player.children];
		childrenToMove.forEach(child => {
			player.remove(child);
			this.horizontalWrapper!.add(child);
		});
		
		player.add(this.horizontalWrapper);
		
		console.log('SwimmingMovement: Created horizontal wrapper for swimming orientation');
	}

	getAscendDisplayName(): string {
		return 'Swim Up';
	}

	getDescendDisplayName(): string {
		return 'Dive Down';
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

	getMoveSpeed(): number {
		return this.moveSpeed;
	}

	setMoveSpeed(speed: number): void {
		this.moveSpeed = speed;
	}

	getSwimAcceleration(): number {
		return this.swimAcceleration;
	}

	setSwimAcceleration(acceleration: number): void {
		this.swimAcceleration = acceleration;
	}

	getSwimFriction(): number {
		return this.swimFriction;
	}

	setSwimFriction(friction: number): void {
		this.swimFriction = friction;
	}

	getMaxVerticalSpeed(): number {
		return this.maxVerticalSpeed;
	}

	setMaxVerticalSpeed(speed: number): void {
		this.maxVerticalSpeed = speed;
	}

	getPitchRotation(): number {
		return this.pitchRotation;
	}
}
