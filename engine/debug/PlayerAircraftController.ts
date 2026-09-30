import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import type { Interactable } from 'types/interactable.js';
import { AircraftManager } from 'debug/AircraftManager.js';
import { AircraftController } from 'debug/AircraftController.js';
import { VehicleCamera } from 'engine/VehicleCamera.js';
import { ThirdPersonCamera } from 'engine/ThirdPersonCamera.js';
import type { CameraController } from 'engine/PlayerController.js';
import type RAPIER from '@dimforge/rapier3d-compat';

/**
 * HUD Controller interface for aircraft controls display
 */
export interface HUDController {
	hideControls?: () => void;
	showAirplaneControls?: () => void;
	showHelicopterControls?: () => void;
	showBalloonControls?: () => void;
}

/**
 * Handles aircraft entry, exit, and control for the player
 */
export class PlayerAircraftController {
	private aircraftManager: AircraftManager | null = null;
	private aircraftController: AircraftController | null = null;
	private vehicleCamera: VehicleCamera | null = null;
	private walkingCamera: CameraController | null = null;
	private isFlying: boolean = false;
	private engine: EngineLike | null;
	private hud: HUDController | null = null;
	private currentInteractable: Interactable | null = null;
	private mobileControls: any = null;

	constructor(engine: EngineLike | null) {
		this.engine = engine;
	}

	/**
	 * Set the aircraft manager for this controller
	 */
	setAircraftManager(aircraftManager: AircraftManager, walkingCamera: CameraController | null): void {
		this.aircraftManager = aircraftManager;
		if (this.engine) {
			this.aircraftController = new AircraftController(this.engine, aircraftManager);
		}
		this.walkingCamera = walkingCamera;
	}

	setHUD(hud: HUDController): void {
		this.hud = hud;
	}

	setMobileControls(mobileControls: any): void {
		this.mobileControls = mobileControls;
	}

	/**
	 * Try to enter a nearby aircraft
	 */
	tryEnterAircraft(
		player: THREE.Object3D,
		playerPosition: THREE.Vector3,
		interactable: Interactable | null,
		getCameraController: () => CameraController | null
	): boolean {
		if (!this.aircraftManager || !this.aircraftController) return false;

		const success = this.aircraftManager.tryEnterAircraft(player, playerPosition);

		if (success) {
			this.isFlying = true;
			this.aircraftController.activate();
			this.currentInteractable = interactable;

			// Hide player visually — route through PlayerVisibility so we
			// compose with other hide reasons (first-person mode, etc.) instead
			// of stomping `visible` directly.
			this.engine?.getPlayerVisibility().setHideReason('aircraft-mode', true);

			// Switch camera based on aircraft type
			const activeAircraft = this.aircraftManager.getActiveAircraft();
			if (activeAircraft && this.engine && this.engine.camera && this.engine.renderer) {
				const aircraftType = activeAircraft.getAircraftType();

				if (aircraftType === 'helicopter' || aircraftType === 'balloon') {
					// Use ThirdPersonCamera for free camera rotation
					const thirdPersonCamera = new ThirdPersonCamera(
						this.engine.getDefaultCamera(),
						activeAircraft.getBodyObject(),
						this.engine.renderer.domElement,
						this.engine
					);
					thirdPersonCamera.distance = 20;
					thirdPersonCamera.height = 7;
					thirdPersonCamera.spherical.radius = 20;
					thirdPersonCamera.targetSpherical.radius = 20;
					console.log('PlayerAircraftController: Switched to free third-person camera for', aircraftType, 'with distance:', thirdPersonCamera.distance);
				} else {
					// Use VehicleCamera for airplanes (auto-follows direction)
					this.vehicleCamera = new VehicleCamera(
						this.engine.getDefaultCamera(),
						activeAircraft.getBodyObject(),
						this.engine.renderer.domElement,
						this.engine
					);
					this.vehicleCamera.setCameraSettings(12, 6, 0.02);
					console.log('PlayerAircraftController: Switched to vehicle camera for', aircraftType);
				}
			}

			// Show appropriate aircraft controls in HUD
			if (this.hud && activeAircraft) {
				const aircraftType = activeAircraft.getAircraftType();
				switch (aircraftType) {
					case 'airplane':
						if (this.hud.showAirplaneControls) this.hud.showAirplaneControls();
						break;
					case 'helicopter':
						if (this.hud.showHelicopterControls) this.hud.showHelicopterControls();
						break;
					case 'balloon':
						if (this.hud.showBalloonControls) this.hud.showBalloonControls();
						break;
				}
			}

			console.log('PlayerAircraftController: Entered aircraft');
		}

		return success;
	}

	/**
	 * Try to land aircraft
	 */
	tryLandAircraft(
		player: THREE.Object3D,
		playerBody: RAPIER.RigidBody | null,
		characterHeight: number,
		onCameraRestore: (camera: CameraController | null) => void
	): void {
		if (!this.aircraftManager || !this.aircraftController) return;

		const pilot = this.aircraftManager.exitCurrentAircraft();

		if (pilot) {
			this.isFlying = false;
			this.aircraftController.deactivate();

			// Show player visually — drop the hide reason; if another reason
			// (e.g. first-person camera) is still active the player stays hidden.
			this.engine?.getPlayerVisibility().setHideReason('aircraft-mode', false);

			// Update physics body position to match the exit position
			if (playerBody && player.position) {
				const exitPosition = player.position;
				const capsuleHeight = characterHeight;
				const physicsY = exitPosition.y + capsuleHeight / 2;

				// Set position directly with Rapier
				playerBody.setTranslation({ x: exitPosition.x, y: physicsY, z: exitPosition.z }, true);
				
				// Reset velocities
				playerBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
				playerBody.setAngvel({ x: 0, y: 0, z: 0 }, true);

				console.log('PlayerAircraftController: Updated physics body position after landing:', exitPosition);
			}

			// Switch back to walking camera
			if (this.vehicleCamera) {
				this.vehicleCamera.dispose();
				this.vehicleCamera = null;
			}

			// Restore walking camera
			onCameraRestore(this.walkingCamera);

			// Hide controls in HUD
			if (this.hud && this.hud.hideControls) {
				this.hud.hideControls();
			}

			console.log('PlayerAircraftController: Landed aircraft and switched back to walking camera');
		}
	}

	/**
	 * Update aircraft state (called every frame when flying)
	 */
	update(
		showInteractionPrompt: (displayName: string) => void,
		hideInteractionPrompt: () => void
	): void {
		if (!this.isFlying || !this.aircraftController) return;

		this.aircraftController.update();

		// Show landing prompt/button when flying
		if (this.currentInteractable && this.currentInteractable.getInteractEndDisplayName) {
			const displayName = this.currentInteractable.getInteractEndDisplayName();
			if (this.mobileControls && this.mobileControls.isEnabled && this.mobileControls.isEnabled()) {
				// Mobile: show exit button
				hideInteractionPrompt();
				const capitalizedDisplayName = displayName.charAt(0).toUpperCase() + displayName.slice(1);
				this.mobileControls.showExitButton(capitalizedDisplayName);
			} else {
				// Desktop: show E key prompt
				showInteractionPrompt(displayName);
			}
		}
	}

	/**
	 * Check if mobile exit button was pressed
	 */
	checkMobileExitPressed(): boolean {
		if (this.mobileControls && this.mobileControls.exitPressed) {
			this.mobileControls.resetExitPressed();
			return true;
		}
		return false;
	}

	/**
	 * Check if player wants to land aircraft
	 */
	shouldLandAircraft(): boolean {
		return this.aircraftController?.shouldLandAircraft() || false;
	}

	/**
	 * Handle landing request (E key pressed while flying)
	 * Includes interactable callback handling
	 */
	handleLandingRequest(
		player: THREE.Object3D,
		playerBody: RAPIER.RigidBody | null,
		characterHeight: number,
		onCameraRestore: (camera: CameraController | null) => void
	): void {
		if (!this.isFlying) return;

		// Call onInteractEnd on current interactable
		if (this.currentInteractable && this.currentInteractable.onInteractEnd) {
			this.currentInteractable.onInteractEnd();
		}

		// Land aircraft
		this.tryLandAircraft(player, playerBody, characterHeight, onCameraRestore);
		this.clearInteractable();
	}

	/**
	 * Get the current camera for the aircraft
	 */
	getAircraftCamera(): VehicleCamera | null {
		return this.vehicleCamera;
	}

	/**
	 * Check if player is currently flying
	 */
	isPlayerFlying(): boolean {
		return this.isFlying;
	}

	/**
	 * Get the current aircraft manager
	 */
	getAircraftManager(): AircraftManager | null {
		return this.aircraftManager;
	}

	/**
	 * Get the active aircraft if player is flying
	 */
	getActiveAircraft(): any {
		return this.aircraftManager?.getActiveAircraft() || null;
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
	 * Dispose resources
	 */
	dispose(): void {
		// Dispose aircraft controller
		if (this.aircraftController) {
			this.aircraftController.dispose();
			this.aircraftController = null;
		}

		// Dispose vehicle camera
		if (this.vehicleCamera) {
			this.vehicleCamera.dispose();
			this.vehicleCamera = null;
		}
	}
}
