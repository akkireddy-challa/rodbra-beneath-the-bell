import * as THREE from 'three';
import type { Interactable } from 'types/interactable.js';
import type { PlayerController } from 'engine/PlayerController.js';
import type { InteractionPromptUI } from 'engine/InteractionPromptUI.js';
import type { PlayerVehicleController } from 'engine/PlayerVehicleController.js';
import type { PlayerAnimalController } from 'engine/animal/PlayerAnimalController.js';
import type { MobileControls } from 'engine/MobileControls.js';
import type { WeaponPickupManager } from 'engine/WeaponPickupManager.js';
import type { AnimalController } from 'engine/animal/AnimalController.js';
import type { CameraController } from 'engine/PlayerController.js';
import type { EngineLike } from 'types/game.js';
import { getInteractionManager, type NearestInteractableResult } from 'engine/InteractionManager.js';
import { WEAPON_PICKUP_PROMPT_Y_OFFSET } from 'engine/WeaponPickup.js';
import { GameState, getGameStateManager } from 'engine/GameStateManager.js';

export interface InteractionControllerOptions {
	playerController: PlayerController;
	promptUI: InteractionPromptUI;
	vehicleControllerHelper: PlayerVehicleController;
	animalControllerHelper: PlayerAnimalController;
	mobileControls: MobileControls;
	getWeaponPickupManager: () => WeaponPickupManager | null;
	getCameraController: () => CameraController | null;
	setCameraController: (camera: CameraController) => void;
	getEngine: () => EngineLike | null;
	retargetCamera: (camera: CameraController | null) => void;
	weaponPickupRange: number;
}

// Detects nearby interactables, drives the prompt UI, and handles the E-key /
// mobile-tap activation flow. Extracted from PlayerController so the controller
// doesn't own interactable-specific logic or UI.
export class InteractionController {
	private static readonly KEYBOARD_PICKUP_RANGE_PADDING = 0.1;

	private readonly opts: InteractionControllerOptions;

	private suppressed: boolean = false;
	private nearbyInteractable: Interactable | null = null;
	private showingWeaponPickupPrompt: boolean = false;

	constructor(opts: InteractionControllerOptions) {
		this.opts = opts;
	}

	// Suppress all interaction prompts and E-key handling. When suppressed, no
	// "[E] Interact with..." prompts are shown and the interact key is ignored.
	// Use during NPC dialogs, cutscenes, etc.
	setSuppressed(suppressed: boolean): void {
		this.suppressed = suppressed;
		if (suppressed) {
			this.opts.promptUI.hide();
		}
	}

	isSuppressed(): boolean {
		return this.suppressed;
	}

	// Per-frame update: detects nearby interactable (weapon pickup first, then
	// vehicle/NPC), drives prompt visibility, and routes mobile taps to the
	// interactable's onInteractStart().
	update(): void {
		if (this.suppressed) return;

		const gameIsPlaying = getGameStateManager()?.isState(GameState.PLAYING) ?? false;
		if (!gameIsPlaying) {
			this.opts.promptUI.hide();
			return;
		}

		const weaponPickupManager = this.opts.getWeaponPickupManager();
		if (weaponPickupManager) {
			const playerPos = this.opts.playerController.player.position;
			const nearbyPickup = weaponPickupManager.findNearestPickup(playerPos, this.opts.weaponPickupRange);

			if (nearbyPickup && nearbyPickup.interactionEnabled()) {
				const displayName = nearbyPickup.getInteractStartDisplayName();
				this.opts.promptUI.show(displayName, nearbyPickup.getPosition(), true, WEAPON_PICKUP_PROMPT_Y_OFFSET);

				if (this.opts.mobileControls?.isEnabled?.()) {
					if (this.opts.mobileControls.interactPressed) {
						nearbyPickup.onInteractStart();
						this.opts.mobileControls.resetInteractPressed();
					}
				}

				this.showingWeaponPickupPrompt = true;
				return; // Don't check other interactables
			} else {
				this.showingWeaponPickupPrompt = false;
			}
		}

		const nearbyResult = this.findNearbyInteractable();
		if (nearbyResult) {
			const nearby = nearbyResult.interactable;
			const displayName = nearby.getInteractStartDisplayName();
			// `isActionable` is optional — undefined means always actionable.
			const actionable = nearby.isActionable ? nearby.isActionable() : true;

			this.opts.promptUI.show(displayName, nearbyResult.worldPosition, actionable);

			if (this.opts.mobileControls?.isEnabled?.() && actionable && this.opts.mobileControls.interactPressed) {
				this.nearbyInteractable = nearby;
				const success = this.nearbyInteractable.onInteractStart();
				if (success) {
					this.tryEnterVehicleFromInteractable(this.nearbyInteractable);
				}
				this.opts.mobileControls.resetInteractPressed();
			}
		} else {
			this.opts.promptUI.hide();
			if (this.opts.mobileControls && this.opts.mobileControls.hideInteractButton) {
				this.opts.mobileControls.hideInteractButton();
			}
		}
	}

	// Find nearby interactable objects using Rapier trigger sensors. The
	// InteractionManager tracks which trigger sensors the player is overlapping.
	findNearbyInteractable(): NearestInteractableResult | null {
		return getInteractionManager().getNearestInteractable(this.opts.playerController.player.position);
	}

	// Called on rising edge of `keys.interact`. Returns true if any interaction
	// was handled (so callers know not to fall through to other systems).
	onInteract(): boolean {
		if (this.suppressed) return false;

		// Check for weapon pickups first (if manager is set)
		const weaponPickupManager = this.opts.getWeaponPickupManager();
		if (weaponPickupManager) {
			const playerPos = this.opts.playerController.player.position;
			const nearbyPickup = weaponPickupManager.findNearestPickup(playerPos, this.opts.weaponPickupRange);

			if (nearbyPickup) {
				nearbyPickup.onInteractStart();
				return true;
			}
		}

		return this.handleVehicleInteraction();
	}

	// Handle E-key when player is on foot, in a vehicle, or riding an animal.
	// Routes to enter/exit/mount/dismount as appropriate.
	private handleVehicleInteraction(): boolean {
		const pc = this.opts.playerController;

		// In vehicle — exit
		if (this.opts.vehicleControllerHelper.isPlayerInVehicle()) {
			this.opts.vehicleControllerHelper.handleExitRequest(
				pc.player,
				pc.playerBody,
				pc.characterHeight,
				this.opts.retargetCamera,
				pc,
			);
			return true;
		}

		// Riding animal — dismount
		if (this.opts.animalControllerHelper.isPlayerRiding()) {
			this.opts.animalControllerHelper.handleDismountRequest(
				pc.player,
				pc.playerBody,
				pc.characterHeight,
				this.opts.retargetCamera,
				pc,
			);
			return true;
		}

		// On foot — try to enter vehicle or mount animal
		const nearbyResult = this.findNearbyInteractable();
		this.nearbyInteractable = nearbyResult ? nearbyResult.interactable : null;

		if (!this.nearbyInteractable) return false;

		const enabled = this.nearbyInteractable.interactionEnabled ? this.nearbyInteractable.interactionEnabled() : true;
		if (!enabled) return false;

		// Check if this is a rideable animal
		const asAnimal = this.nearbyInteractable as unknown as AnimalController;
		if (asAnimal && typeof asAnimal.isRideable === 'function' && asAnimal.isRideable() && asAnimal.canMount()) {
			this.opts.animalControllerHelper.setOnCameraRestoredCallback(this.opts.retargetCamera);

			const mounted = this.opts.animalControllerHelper.tryMountAnimal(
				pc.player,
				pc.player.position.clone(),
				asAnimal,
				() => this.opts.getCameraController(),
				pc,
			);

			if (mounted) {
				const animalCamera = this.opts.animalControllerHelper.getAnimalCamera();
				if (animalCamera) {
					this.opts.setCameraController(animalCamera);
				}
			}
			return true;
		}

		const success = this.nearbyInteractable.onInteractStart();
		if (success) {
			this.tryEnterVehicleFromInteractable(this.nearbyInteractable);
			return true;
		}
		return false;
	}

	private tryEnterVehicleFromInteractable(interactable: Interactable): void {
		const pc = this.opts.playerController;
		const enteredVehicle = this.opts.vehicleControllerHelper.tryEnterVehicle(
			pc.player,
			pc.player.position.clone(),
			interactable,
			() => this.opts.getCameraController(),
			pc,
		);

		if (enteredVehicle) {
			// (in 'keep' mode the walking camera is reused, no swap needed)
			const vehicleCamera = this.opts.vehicleControllerHelper.getVehicleCamera();
			if (vehicleCamera) {
				this.opts.setCameraController(vehicleCamera);
			}
		}
	}

	// True if anything in the scene can currently be interacted with — used by
	// the HUD to decide whether to render the interact button.
	hasInteractablesInScene(): boolean {
		if (this.opts.getWeaponPickupManager()) return true;
		let found = false;
		this.opts.getEngine()?.scene?.traverse((obj: THREE.Object3D) => {
			if (!found && obj.userData?.interactable) found = true;
		});
		return found;
	}
}
