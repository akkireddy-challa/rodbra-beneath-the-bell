import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { IPlayerMovement } from 'engine/IPlayerMovement.js';
import type { PlayerController } from 'engine/PlayerController.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import { VehicleManager } from 'engine/VehicleManager.js';
import { isMobileRuntime } from 'engine/isMobileRuntime.js';
import type { VehicleControlsExtension, VehicleKeyState } from 'types/vehicle-extension.js';

/**
 * Should an extension callback fire this frame? 'tap' fires on the rising edge
 * only, 'continuous' fires for as long as the key is held.
 */
function triggers(behavior: 'tap' | 'continuous', isDown: boolean, wasDown: boolean): boolean {
	return behavior === 'tap' ? isDown && !wasDown : isDown;
}

/**
 * Vehicle driving movement implementation
 * Replaces VehicleController with IPlayerMovement-based approach
 * Activated when player enters a vehicle, deactivated when they exit
 * 
 * Supports custom extensions via VehicleControlsExtension interface.
 * Templates can provide their own extension to add jump, boost, etc.
 */
export class PlayerDrivingVehicleMovement implements IPlayerMovement {
	private vehicleManager: VehicleManager;
	private rotation: number = 0;
	private extension: VehicleControlsExtension | null = null;
	
	// Track key states for tap vs continuous behavior
	private prevAscendState: boolean = false;
	private prevDescendState: boolean = false;
	private prevActionState: boolean = false;

	constructor(vehicleManager: VehicleManager, extension?: VehicleControlsExtension) {
		this.vehicleManager = vehicleManager;
		this.extension = extension ?? null;
	}

	public setExtension(extension: VehicleControlsExtension | null): void {
		this.extension = extension;
	}

	public getExtension(): VehicleControlsExtension | null {
		return this.extension;
	}

	update(
		deltaTime: number,
		playerController: PlayerController,
		keys: { forward: boolean; backward: boolean; left: boolean; right: boolean; ascend: boolean; interact: boolean; action: boolean; secondaryAction?: boolean; descend: boolean },
		isGrounded: boolean,
		moveDirection: THREE.Vector3,
		playerBody: RAPIER.RigidBody,
		physicsWorld: PhysicsWorld
	): void {
		const activeVehicle = this.vehicleManager.getActiveVehicle();
		
		// CRITICAL: Sync BOTH player visual AND physics body to vehicle position!
		// This ensures ALL systems get the correct position:
		// - Chunk visibility (uses player.position)
		// - Shadow camera (uses player.position via GameEngine.updateShadowCameraPosition)
		// - Lazy chunk generation (uses player.position)
		// - Template syncPlayerPhysics() reads from playerBody.translation()
		// Without this, the physics body stays at the vehicle entry point and
		// syncPlayerPhysics() overwrites player.position back to the stale location.
		// Never touch rapier once physics has been halted by a fatal WASM error —
		// every call would throw "recursive use" and, since this runs from the
		// game-update loop (not the physics step), it would flood the console
		// every frame and freeze the tab.
		if (physicsWorld.isHalted()) return;

		if (activeVehicle) {
			const vehiclePos = activeVehicle.getPosition();
			// CRITICAL: only sync FINITE positions. If the vehicle chassis went
			// NaN/Inf, getPosition() returns that — and writing it into playerBody
			// via setTranslation poisons a SECOND physics body, so the next
			// world.step() aborts and sticks the WASM borrow world-wide. Skipping
			// the sync contains the failure to the (self-disabling) vehicle.
			const finite = vehiclePos &&
				Number.isFinite(vehiclePos.x) && Number.isFinite(vehiclePos.y) && Number.isFinite(vehiclePos.z);
			if (finite) {
				// Sync visual player position
				if (playerController.player) {
					playerController.player.position.set(vehiclePos.x, vehiclePos.y, vehiclePos.z);
				}
				// Passenger capsule rides along on the car each frame — keep its colliders
				// disabled so it can't collide with and flip a small vehicle.
				playerController.setCapsuleCollidersEnabled(false);
			}
		}
		
		// Get the active extension - prefer vehicle's extension (can be set after entering)
		// Fall back to movement system's extension for backward compatibility
		const activeExtension = this.getActiveExtension();
		
		// Handle custom extension callbacks
		let useDefaultBrake = true;
		
		if (activeExtension && activeVehicle) {
			const ascendBehavior = activeExtension.ascendBehavior || 'continuous';

			// Handle ascend (Space) - custom action or default brake
			if (activeExtension.onAscendPressed) {
				if (triggers(ascendBehavior, keys.ascend, this.prevAscendState)) {
					if (activeExtension.onAscendPressed(activeVehicle, deltaTime)) {
						useDefaultBrake = false;
					}
				} else if (ascendBehavior === 'tap') {
					// A tap-behavior ascend belongs entirely to the extension —
					// don't fall back to braking on the frames it doesn't fire.
					useDefaultBrake = false;
				}
			}

			// Handle descend (Ctrl/Shift) - custom action
			if (activeExtension.onDescendPressed
				&& triggers(activeExtension.descendBehavior || 'continuous', keys.descend, this.prevDescendState)) {
				activeExtension.onDescendPressed(activeVehicle, deltaTime);
			}

			// Handle action (F key) - custom action
			if (activeExtension.onActionPressed
				&& triggers(activeExtension.actionBehavior || 'tap', keys.action, this.prevActionState)) {
				activeExtension.onActionPressed(activeVehicle, deltaTime);
			}

			this.prevAscendState = keys.ascend;
			this.prevDescendState = keys.descend;
			this.prevActionState = keys.action;
		}
		
		// Map keys to vehicle controls.
		// action/secondaryAction are OR-merged so gamepad triggers (RT/LT) and
		// face buttons (A/B when aliased) also drive the vehicle.
		//
		// Steering prefers the ANALOG axis when the active input has one (touch
		// steering pill, gamepad stick). PlayerController thresholds that axis into
		// keys.left/right at 0.1 for every movement system, and on the keyboard-style
		// boolean path a held key ramps the wheel to full lock — so a small touch
		// deflection used to wind up at maximum steering. Passing the axis through
		// makes the wheel positional: a little left stays a little left.
		// analogMoveX is +right / -left; `steer` is +left, hence the negation.
		const analogSteer = playerController.useAnalogMovement ? -playerController.analogMoveX : 0;
		this.vehicleManager.updateVehicleControls({
			forward: keys.forward || keys.action,
			backward: keys.backward || (keys.secondaryAction ?? false),
			left: keys.left,
			right: keys.right,
			brake: useDefaultBrake && keys.ascend,
			steer: analogSteer
		}, deltaTime);

		// Get vehicle rotation for animation sync
		const chassisObject = activeVehicle?.getChassisObject?.();
		if (chassisObject) {
			this.rotation = chassisObject.rotation.y;
		}
		
		// Call extension update callback for per-frame logic
		if (activeExtension?.onUpdate && activeVehicle) {
			const keyState: VehicleKeyState = {
				forward: keys.forward,
				backward: keys.backward,
				left: keys.left,
				right: keys.right,
				ascend: keys.ascend,
				descend: keys.descend,
				action: keys.action
			};
			activeExtension.onUpdate(activeVehicle, deltaTime, keyState);
		}
	}

	getCurrentSpeed(): number {
		return 0;
	}

	isInAir(): boolean {
		return false;
	}

	getRotation(): number {
		return this.rotation;
	}

	// NB: rotation is re-derived from the chassis every frame — this write is transient.
	setRotation(rotation: number): void {
		this.rotation = rotation;
	}

	reset(): void {
		this.rotation = 0;
	}

	/**
	 * Get the active extension - prefers vehicle's extension (can be set after entering),
	 * falls back to movement system's extension for backward compatibility.
	 */
	private getActiveExtension(): VehicleControlsExtension | null {
		const activeVehicle = this.vehicleManager.getActiveVehicle();
		return (activeVehicle?.getControlsExtension?.() as VehicleControlsExtension | null) ?? this.extension;
	}

	getAscendDisplayName(): string {
		return this.getActiveExtension()?.ascendDisplayName ?? 'Brake';
	}

	getDescendDisplayName(): string {
		return this.getActiveExtension()?.descendDisplayName ?? 'Descend';
	}

	getSupportedKeys(): { ascend: boolean; descend: boolean } {
		const ext = this.getActiveExtension();
		return {
			// On touch there is NO default brake button — the driving layout is
			// steer + gas, and a game that wants a brake adds it as an action
			// button. Vehicles WITH a controls extension keep their buttons
			// (Boost etc. rely on the historical default-true), and the desktop
			// HUD still hints Space/Brake, which keeps working regardless.
			ascend: ext ? (ext.showAscend ?? true) : !isMobileRuntime(),
			descend: ext?.showDescend ?? false
		};
	}

	getKeyBehavior(): { ascend: 'tap' | 'continuous'; descend: 'tap' | 'continuous' } {
		const ext = this.getActiveExtension();
		return {
			ascend: ext?.ascendBehavior ?? 'continuous',
			descend: ext?.descendBehavior ?? 'continuous'
		};
	}

	shouldShowPlayer(): boolean {
		return false;
	}

	handlesPlayerPositionSync(): boolean {
		// Vehicle movement syncs player position itself - template must not overwrite it
		return true;
	}

	getMoveSpeed(): number {
		// Vehicle speed is controlled by the vehicle itself, not player movement speed
		return 0;
	}

	setMoveSpeed(_speed: number): void {
		// Vehicle speed is controlled by the vehicle itself, not player movement speed
		// This is a no-op for vehicle movement
	}

	getVehicleManager(): VehicleManager {
		return this.vehicleManager;
	}

	notifyVehicleEntered(): void {
		const activeVehicle = this.vehicleManager.getActiveVehicle();
		if (activeVehicle) this.getActiveExtension()?.onEnterVehicle?.(activeVehicle);
	}

	notifyVehicleExited(): void {
		const activeVehicle = this.vehicleManager.getActiveVehicle();
		if (activeVehicle) this.getActiveExtension()?.onExitVehicle?.(activeVehicle);
	}
}
