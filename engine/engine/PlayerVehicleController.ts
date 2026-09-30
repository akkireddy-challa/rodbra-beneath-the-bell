import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import type { Interactable } from 'types/interactable.js';
import { VehicleManager } from 'engine/VehicleManager.js';
import { PlayerDrivingVehicleMovement } from 'engine/PlayerDrivingVehicleMovement.js';
import { VehicleCamera } from 'engine/VehicleCamera.js';
import { FirstPersonVehicleCamera } from 'engine/FirstPersonVehicleCamera.js';
import type { CameraController } from 'engine/PlayerController.js';
import type { IPlayerMovement } from 'engine/IPlayerMovement.js';
import type { Vehicle } from 'engine/Vehicle.js';
import type { CameraMode, VehicleCameraMode } from 'engine/ICameraController.js';
import type RAPIER from '@dimforge/rapier3d-compat';

/**
 * Handles vehicle entry, exit, and control for the player.
 *
 * Camera behaviour while driving depends on the VehicleCameraMode
 * (set via {@link setVehicleCameraMode}, defaults to 'auto'):
 *   - 'chase'   -> dedicated VehicleCamera (third-person chase cam with inertia)
 *   - 'cockpit' -> dedicated FirstPersonVehicleCamera (driver's-eye view)
 *   - 'keep'    -> walking camera retargeted to the vehicle chassis
 *   - 'auto'    -> resolved from the walking camera type at vehicle entry time
 */
export class PlayerVehicleController {
	private vehicleManager: VehicleManager | null = null;
	private vehicleMovement: PlayerDrivingVehicleMovement | null = null;
	private vehicleCamera: VehicleCamera | FirstPersonVehicleCamera | null = null;
	private walkingCamera: CameraController | null = null;
	private walkingMovement: IPlayerMovement | null = null;
	private isInVehicle: boolean = false;
	private engine: EngineLike | null;
	private currentInteractable: Interactable | null = null;
	private mobileControls: any = null;
	private _cameraMode: CameraMode = 'third-person';
	private _vehicleCameraMode: VehicleCameraMode = 'auto';
	/** The resolved mode actually applied when the player last entered a vehicle. */
	private _resolvedVehicleCameraMode: 'chase' | 'cockpit' | 'keep' = 'chase';

	constructor(engine: EngineLike | null) {
		this.engine = engine;
	}

	/**
	 * Set the walking camera mode — used by 'auto' vehicle camera resolution.
	 * Typically called once when the walking camera is configured.
	 */
	setCameraMode(mode: CameraMode): void {
		this._cameraMode = mode;
	}

	getCameraMode(): CameraMode {
		return this._cameraMode;
	}

	/**
	 * Override which camera is used when driving a vehicle.
	 *
	 * - 'auto'    — detect from walking camera type (default)
	 * - 'chase'   — VehicleCamera (third-person chase cam)
	 * - 'cockpit' — FirstPersonVehicleCamera (driver's-eye)
	 * - 'keep'    — retarget the walking camera to the vehicle chassis
	 */
	setVehicleCameraMode(mode: VehicleCameraMode): void {
		this._vehicleCameraMode = mode;

		// If already in a vehicle, recreate the camera with the new mode
		const activeVehicle = this.isInVehicle ? this.vehicleManager?.getActiveVehicle() : null;
		if (activeVehicle) {
			this.createVehicleCameraForMode(activeVehicle);
		}
	}

	getVehicleCameraMode(): VehicleCameraMode {
		return this._vehicleCameraMode;
	}

	/**
	 * Set the vehicle manager for this controller
	 */
	setVehicleManager(vehicleManager: VehicleManager, walkingCamera: CameraController | null): void {
		this.vehicleManager = vehicleManager;
		this.vehicleMovement = new PlayerDrivingVehicleMovement(vehicleManager);
		this.walkingCamera = walkingCamera;
	}

	setMobileControls(mobileControls: any): void {
		this.mobileControls = mobileControls;
	}

	/**
	 * Try to enter a nearby vehicle
	 * Switches from walking movement to vehicle driving movement
	 */
	tryEnterVehicle(
		player: THREE.Object3D,
		playerPosition: THREE.Vector3,
		interactable: Interactable | null,
		getCameraController: () => CameraController | null,
		playerController?: any // PlayerController reference for movement system swapping
	): boolean {
		if (!this.vehicleManager || !this.vehicleMovement || !interactable) {
			return false;
		}

		// Cast interactable to Vehicle (we know it's a vehicle from the scene traversal)
		const vehicle = interactable as Vehicle;

		// Try to enter the vehicle directly (using internal method)
		const success = vehicle.enterVehicle_INTERNAL && vehicle.enterVehicle_INTERNAL(player);

		if (success) {
			// Register vehicle as active in the manager (using internal method)
			this.vehicleManager.setActiveVehicle_INTERNAL(vehicle);
			this.isInVehicle = true;
			this.currentInteractable = interactable;

			// Clear interact key to prevent immediate exit
			if (playerController?.keys) {
				playerController.keys.interact = false;
			}

			// Apply the vehicle's controls extension (if any) to the movement system
			// This enables custom behaviors like jump, boost, etc. that templates define
			this.vehicleMovement.setExtension(vehicle.getControlsExtension?.() ?? null);

			// Notify extension that player entered
			this.vehicleMovement.notifyVehicleEntered();

			// Switch to vehicle movement system (automatically handles player visibility)
			if (playerController?.getMovementSystem && playerController.setMovementSystem) {
				this.walkingMovement = playerController.getMovementSystem();
				playerController.setMovementSystem(this.vehicleMovement);
			}

			// Disable the capsule colliders while driving so they don't flip small
			// vehicles — and the capsule BODY too: colliders-off alone still leaves a
			// kinematic body parked inside the chassis, which the step pushes the
			// vehicle out of, leaving the kart hovering wheels-up and undrivable.
			// Both are restored on exit.
			playerController?.setCapsuleCollidersEnabled?.(false);
			playerController?.setCapsuleBodyEnabled?.(false);

			// Gamepad: disable stick-Y so left stick only steers; triggers handle accel/brake
			playerController?.getGamepadControls?.().setMoveYEnabled(false);

			// Touch: switch to the driving layout — horizontal steering slider +
			// bottom-right gas zone + raised action buttons (see MobileControls).
			this.mobileControls?.setDrivingMode?.(true);

			// Create or retarget camera based on camera mode
			const activeVehicle = this.vehicleManager.getActiveVehicle();
			if (activeVehicle) {
				this.createVehicleCameraForMode(activeVehicle);
			}
		}

		return success;
	}

	/**
	 * Resolve `_vehicleCameraMode` ('auto' → concrete mode) from the walking
	 * camera type.  Called once per vehicle entry.
	 */
	private resolveVehicleCameraMode(): 'chase' | 'cockpit' | 'keep' {
		if (this._vehicleCameraMode !== 'auto') {
			return this._vehicleCameraMode;
		}
		switch (this._cameraMode) {
			case 'top-down':
				return 'keep';
			case 'first-person':
				return 'cockpit';
			case 'third-person':
			default:
				return 'chase';
		}
	}

	/**
	 * Create a dedicated vehicle camera, or retarget the walking camera to the
	 * vehicle chassis, depending on the resolved vehicle camera mode.
	 */
	private createVehicleCameraForMode(activeVehicle: Vehicle): void {
		const chassis = activeVehicle.getChassisObject();
		this._resolvedVehicleCameraMode = this.resolveVehicleCameraMode();

		if (this._resolvedVehicleCameraMode === 'keep') {
			this.walkingCamera?.setTarget?.(chassis);
			this.vehicleCamera = null;
			return;
		}

		if (!this.engine?.camera || !this.engine.renderer) return;

		const cam = this.engine.getDefaultCamera();
		const dom = this.engine.renderer.domElement;
		// Smaller vehicles get a closer, lower chase camera (see RapierVehicle.getSizeFactor).
		const camSizeScale = Math.max(0.25, Math.min(1, activeVehicle.getSizeFactor()));
		this.vehicleCamera = this._resolvedVehicleCameraMode === 'cockpit'
			? new FirstPersonVehicleCamera(cam, chassis, dom, this.engine)
			: new VehicleCamera(cam, chassis, dom, this.engine, camSizeScale);
	}

	/** Tear down the dedicated vehicle camera, if one was created ('keep' mode has none). */
	private disposeVehicleCamera(): void {
		this.vehicleCamera?.dispose();
		this.vehicleCamera = null;
	}

	/**
	 * Hand control back to the on-foot state: clear the driving flag and the
	 * vehicle's controls extension, restore the saved walking movement system,
	 * and swap the touch UI back to the walking layout. Shared by exitVehicle()
	 * and switchVehicle()'s failed-entry teardown.
	 */
	private restoreWalkingMovement(playerController?: any): void {
		this.isInVehicle = false;
		this.vehicleMovement?.setExtension(null);
		if (playerController?.setMovementSystem && this.walkingMovement) {
			playerController.setMovementSystem(this.walkingMovement);
			this.walkingMovement = null;
		}
		// Touch: back to the walking layout (2-axis joystick, default buttons)
		this.mobileControls?.setDrivingMode?.(false);
	}

	/**
	 * Exit current vehicle
	 * Switches from vehicle driving movement back to walking movement
	 */
	exitVehicle(
		player: THREE.Object3D,
		playerBody: RAPIER.RigidBody,
		characterHeight: number,
		onCameraRestore: (camera: CameraController | null) => void,
		playerController?: any // PlayerController reference for movement system swapping
	): void {
		if (!this.vehicleManager) return;

		// Notify extension that player is exiting (before exiting)
		this.vehicleMovement?.notifyVehicleExited();

		const driver = this.vehicleManager.exitCurrentVehicle();

		if (driver) {
			this.restoreWalkingMovement(playerController);

			// Re-enable the player capsule's body + colliders now that it's back on foot.
			playerController?.setCapsuleBodyEnabled?.(true);
			playerController?.setCapsuleCollidersEnabled?.(true);

			// Gamepad: restore stick-Y for normal walking movement
			playerController?.getGamepadControls?.().setMoveYEnabled(true);

			// Update physics body position to match the exit position
			if (playerBody) {
				const exitPosition = player.position;
				// Physics body center should be at capsule center
				const physicsY = exitPosition.y + characterHeight / 2;

				// Update position with Rapier
				playerBody.setTranslation({ x: exitPosition.x, y: physicsY, z: exitPosition.z }, true);

				// Reset velocity to prevent flying away
				playerBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
				playerBody.setAngvel({ x: 0, y: 0, z: 0 }, true);

				console.log('PlayerVehicleController: Updated physics body position to:', exitPosition);
			}

			// Dispose dedicated vehicle camera (third-person or first-person)
			this.disposeVehicleCamera();

			// If the walking camera was retargeted to the vehicle, point it back at the player
			if (this._resolvedVehicleCameraMode === 'keep') {
				this.walkingCamera?.setTarget?.(player);
			}

			// Restore walking camera and re-sync its pointer lock state
			// The ThirdPersonCamera's pointerLocked flag may be stale after vehicle driving,
			// since pointer lock change events went to VehicleCamera instead.
			if (this.walkingCamera && 'setPointerLocked' in this.walkingCamera) {
				const isCurrentlyLocked = !!document.pointerLockElement;
				(this.walkingCamera as { setPointerLocked: (locked: boolean) => void }).setPointerLocked(isCurrentlyLocked);
			}
			onCameraRestore(this.walkingCamera);

			console.log('PlayerVehicleController: Exited vehicle and switched back to walking camera');
		}
	}

	/**
	 * Switch directly from one vehicle to another without full teardown.
	 * Keeps the vehicle camera and movement system alive, just retargets them.
	 * This avoids camera flickering and state inconsistencies during vehicle switching.
	 */
	switchVehicle(
		player: THREE.Object3D,
		newVehicle: Vehicle,
		playerController?: any
	): boolean {
		if (!this.vehicleManager || !this.vehicleMovement || !this.isInVehicle) {
			return false;
		}

		// Exit old vehicle physics (resets controls, positions player)
		const oldVehicle = this.vehicleManager.getActiveVehicle();
		if (oldVehicle) {
			// Notify old extension that player is exiting
			this.vehicleMovement.notifyVehicleExited();
			oldVehicle.exitVehicle();
		}

		// Enter new vehicle physics
		const success = newVehicle.enterVehicle_INTERNAL && newVehicle.enterVehicle_INTERNAL(player);
		if (!success) {
			// Failed to enter new vehicle — full teardown to walking state
			this.restoreWalkingMovement(playerController);
			this.disposeVehicleCamera();
			// Use exitCurrentVehicle to clear active vehicle cleanly
			this.vehicleManager.exitCurrentVehicle();
			return false;
		}

		// Update manager tracking to new vehicle
		this.vehicleManager.setActiveVehicle_INTERNAL(newVehicle);
		this.currentInteractable = newVehicle as unknown as Interactable;

		// Clear interact key to prevent immediate exit
		if (playerController?.keys) {
			playerController.keys.interact = false;
		}

		// Apply new vehicle's controls extension
		this.vehicleMovement.setExtension(newVehicle.getControlsExtension?.() ?? null);
		this.vehicleMovement.notifyVehicleEntered();

		// Sync the new vehicle's visual mesh from its physics body
		// so the camera reads the correct world position immediately
		if (newVehicle.visualUpdate) {
			newVehicle.visualUpdate();
		}

		// Retarget existing camera to new vehicle
		const chassis = newVehicle.getChassisObject();
		if (this._resolvedVehicleCameraMode === 'keep') {
			this.walkingCamera?.setTarget?.(chassis);
		} else {
			this.vehicleCamera?.setTarget(chassis);
		}

		return true;
	}

	/**
	 * Update vehicle interaction prompts (called every frame when in vehicle)
	 * Note: Movement is now handled by PlayerDrivingVehicleMovement via PlayerController.update()
	 */
	updateInteractionPrompts(
		showInteractionPrompt: (displayName: string) => void,
		hideInteractionPrompt: () => void
	): void {
		if (!this.isInVehicle) return;

		// No need to update vehicle controls here - the movement system handles it

		// Show exit prompt/button when in vehicle
		if (!this.currentInteractable?.getInteractEndDisplayName) return;

		const displayName = this.currentInteractable.getInteractEndDisplayName();
		if (this.mobileControls?.isEnabled?.()) {
			// Mobile: show exit button
			hideInteractionPrompt();
			this.mobileControls.showExitButton(displayName.charAt(0).toUpperCase() + displayName.slice(1));
		} else {
			// Desktop: show E key prompt
			showInteractionPrompt(displayName);
		}
	}

	/**
	 * Check if mobile exit button was pressed
	 */
	checkMobileExitPressed(): boolean {
		if (!this.mobileControls?.exitPressed) return false;
		this.mobileControls.resetExitPressed();
		return true;
	}

	/**
	 * Handle exit request (E key pressed while in vehicle)
	 * Includes interactable callback handling
	 */
	handleExitRequest(
		player: THREE.Object3D,
		playerBody: RAPIER.RigidBody,
		characterHeight: number,
		onCameraRestore: (camera: CameraController | null) => void,
		playerController?: any // PlayerController reference for movement system swapping
	): void {
		if (!this.isInVehicle) return;

		// Call onInteractEnd on current interactable
		this.currentInteractable?.onInteractEnd?.();

		// Exit vehicle (pass playerController for movement system restoration)
		this.exitVehicle(player, playerBody, characterHeight, onCameraRestore, playerController);
		this.clearInteractable();
	}

	/**
	 * Get the current dedicated vehicle camera (chase or cockpit).
	 * Returns null in 'keep' mode where the walking camera is reused.
	 */
	getVehicleCamera(): VehicleCamera | FirstPersonVehicleCamera | null {
		return this.vehicleCamera;
	}

	/**
	 * Check if player is currently in a vehicle
	 */
	isPlayerInVehicle(): boolean {
		return this.isInVehicle;
	}

	/**
	 * Get the current vehicle manager
	 */
	getVehicleManager(): VehicleManager | null {
		return this.vehicleManager;
	}

	/**
	 * Get the active vehicle if player is driving
	 */
	getActiveVehicle(): any {
		return this.vehicleManager?.getActiveVehicle() || null;
	}

	/**
	 * Get the current interactable
	 */
	getCurrentInteractable(): Interactable | null {
		return this.currentInteractable;
	}

	/**
	 * Clear the current interactable
	 */
	clearInteractable(): void {
		this.currentInteractable = null;
	}

	/**
	 * Validate internal vehicle state consistency.
	 * Logs warnings when state is inconsistent (e.g., isInVehicle=true but no active vehicle).
	 * Useful for debugging vehicle switching issues.
	 */
	validateState(playerController?: { getMovementSystem?: () => IPlayerMovement | null }): boolean {
		let valid = true;
		const activeVehicle = this.vehicleManager?.getActiveVehicle();

		if (this.isInVehicle && !activeVehicle) {
			console.warn('VehicleState: isInVehicle=true but no active vehicle in VehicleManager');
			valid = false;
		}
		if (!this.isInVehicle && activeVehicle) {
			console.warn('VehicleState: isInVehicle=false but VehicleManager has active vehicle');
			valid = false;
		}
		// In 'keep' mode vehicleCamera is intentionally null (walking camera is reused)
		if (this.isInVehicle && !this.vehicleCamera && this._resolvedVehicleCameraMode !== 'keep') {
			console.warn('VehicleState: isInVehicle=true but no vehicle camera');
			valid = false;
		}
		if (this.isInVehicle && this.walkingMovement === null) {
			console.warn('VehicleState: isInVehicle=true but walkingMovement not saved (will break exit)');
			valid = false;
		}
		if (playerController?.getMovementSystem) {
			const currentMovement = playerController.getMovementSystem();
			if (this.isInVehicle && currentMovement !== this.vehicleMovement) {
				console.warn('VehicleState: isInVehicle=true but movement system is not vehicleMovement');
				valid = false;
			}
		}

		return valid;
	}

	/**
	 * Dispose resources
	 */
	dispose(): void {
		this.disposeVehicleCamera();

		// Clear movement reference
		this.vehicleMovement = null;
		this.walkingMovement = null;
	}
}
