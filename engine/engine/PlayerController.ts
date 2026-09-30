// Type checking enabled
import * as THREE from 'three';
import { getGlobalPathConflictAvoidance } from 'engine/PathConflictAvoidance.js';
import { getGameEventLog } from 'engine/recording/GameEventLog.js';
import type { ICharacterAnimationController } from 'engine/ICharacterAnimationController.js';
import type { IPlayerMovement } from 'engine/IPlayerMovement.js';
import type { IPlayerAttack } from 'engine/IPlayerAttack.js';
import type { IGameHUD } from 'engine/IGameHUD.js';
import { WalkingAndJumpingMovement } from 'engine/WalkingAndJumpingMovement.js';
import { resolveRenderSyncPosition } from 'engine/renderSyncPosition.js';
import { SkiMovement } from 'engine/ski/SkiMovement.js';
import { BoatMovement } from 'engine/boat/BoatMovement.js';
import type { EngineLike, TerrainFrictionProvider, CameraControllerLike } from 'types/game.js';
import { SlidingVFX, type ISlidingVFX } from 'engine/SlidingVFX.js';
import type { Interactable } from 'types/interactable.js';
import { VehicleManager } from 'engine/VehicleManager.js';
import type { Vehicle } from 'engine/Vehicle.js';
import type { VehicleCameraMode } from 'engine/ICameraController.js';
import type { WeaponPickupManager } from 'engine/WeaponPickupManager.js';
import { PlayerLoader } from 'engine/loaders/PlayerLoader.js';
import { tickVxlCharacterEyesFromView } from 'engine/loaders/VxlCharacterEyes.js';
import { HealthComponent } from 'engine/character/HealthComponent.js';
import { RagdollComponent, DEFAULT_RAGDOLL_CONFIG, buildHumanoidRagdollParts } from 'engine/character/RagdollComponent.js';
import { PlayerVehicleController } from 'engine/PlayerVehicleController.js';
import { PlayerAnimalController } from 'engine/animal/PlayerAnimalController.js';
import { CollisionGroup } from 'engine/CollisionLayers.js';
import { CANONICAL_BONE_NAMES, findBoneByCandidates } from 'engine/SkeletonAliases.js';
import { MobileControls } from 'engine/MobileControls.js';
import { MobileControlsDebug } from 'engine/MobileControls.debug.js';
import { MobileButtonLayout, type MobileButtonPosition } from 'engine/MobileButtonLayout.js';
import { MobileIconRegistry, type MobileActionSpec } from 'engine/MobileActionSpec.js';
import { DesktopControls } from 'engine/DesktopControls.js';
import { computeMobileParity, computeMovementControlsAvailable, type MobileParityResult } from 'engine/MobileParity.js';
import { mergeCustomActionKeys } from 'engine/CustomActionKeys.js';
export type { MobileParityResult } from 'engine/MobileParity.js';
import { GamepadControls } from 'engine/GamepadControls.js';
import { LidSensorControls } from 'engine/LidSensorControls.js';
import { isProduction } from 'engine/environment.js';
import type { GameConstants } from 'engine/Constants.js';
import { mergeConstants } from 'engine/Constants.js';
import { GameState, getGameStateManager } from 'engine/GameStateManager.js';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { Posture } from 'engine/AnimationPacks.js';
import { PlayerPosture } from 'engine/PlayerPosture.js';
import { PostureActions, buildPostureActionHost, type PostureActionHost } from 'engine/PostureActions.js';
import { SwimmingMovement } from 'engine/SwimmingMovement.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import { getInteractionManager } from 'engine/InteractionManager.js';
import { InteractionPromptUI } from 'engine/InteractionPromptUI.js';
import { InteractionController } from 'engine/InteractionController.js';
import { FadeOverlay } from 'engine/FadeOverlay.js';
import { ActionSuppressionManager, type SuppressibleAction } from 'engine/ActionSuppressionManager.js';
import {
	planFallRescue,
	DEFAULT_FALL_RESCUE_OPTIONS,
	type FallRescueOptions,
	type FallRescueEvent,
} from 'engine/FallRescue.js';
import type { VehicleRespawnProvider } from 'engine/VehicleStuckSystem.js';
export {
	DEFAULT_FALL_RESCUE_OPTIONS,
	DEFAULT_KILL_PLANE_Y,
	DEFAULT_VEHICLE_RESPAWN_LIFT,
	type FallRescueOptions,
	type FallRescueEvent,
} from 'engine/FallRescue.js';

/**
 * The movement kit a forged level was designed to be completable with, as carried
 * on the level asset (`worldForgerMovement.effective`). See reassertMovementContract.
 */
type ForgedMovementContract = { runSpeed?: number; jumpRise?: number; multiJump?: number };

export interface CameraController {
	getForwardVector: () => THREE.Vector3;
	getRightVector: () => THREE.Vector3;
	getCamera: () => THREE.PerspectiveCamera;
	setTarget?: (target: THREE.Object3D) => void;
}

/**
 * Tuning knobs for the driving camera. Every field is optional — callers set
 * only what they want to change. Fields map differently per camera type; see
 * {@link PlayerController.configureVehicleCamera}.
 */
export interface VehicleCameraConfig {
	/** Chase: trailing distance behind the vehicle. Top-down: overhead distance (zoom). */
	distance?: number;
	/** Chase: vertical offset above the vehicle. Ignored for top-down. */
	height?: number;
	/** Chase: height on the vehicle the camera looks at. Ignored for top-down. */
	lookAtHeight?: number;
	/** Chase: how fast the camera follows the vehicle's heading. Ignored for top-down. */
	followSpeed?: number;
	/** Chase: how smoothly the camera position follows. Ignored for top-down. */
	positionSmoothness?: number;
}

/**
 * PlayerController - Main player character controller
 *
 * IMPORTANT: Character Traversal & Attachment
 * --------------------------------------------
 * The `player` object may be a hidden skeleton used only for animations.
 * The visible character (block character) is rendered separately.
 *
 * ❌ WRONG - This traverses the hidden skeleton:
 *
 * ✅ CORRECT - Use these methods instead:
 *
 * See BLOCK_CHARACTER_ARCHITECTURE.md for more details on the pattern.
 */
export class PlayerController {
	/**
	 * The player's skeleton root. **Do not write to `.visible` directly** —
	 * use `engine.getPlayerVisibility().hide()` / `show()`. Direct writes
	 * fight with first-person mode, vehicle/aircraft mounts, and the "hidden
	 * during MENU" lifecycle rule.
	 *
	 * To also freeze the physics capsule and skip the update loop (cutscene
	 * pose, board games), call `setPlayerEnabled(false)` on this controller
	 * in addition to hiding. See `PlayerVisibility.ts`.
	 */
	player: THREE.Object3D;
	playerBody: RAPIER.RigidBody;
	physicsWorld: PhysicsWorld;
	cameraController: CameraController | null;
	engine: EngineLike | null;
	maxSlope: number;
	stepHeight: number;
	// Key state struct. Built-in keys are strongly typed; the index signature lets
	// game code read custom actions registered via mobileControls.registerAction()
	// as `this.keys.<action>` without TypeScript errors. See control-system.md.
	keys: { forward: boolean; backward: boolean; left: boolean; right: boolean; ascend: boolean; interact: boolean; action: boolean; secondaryAction: boolean; descend: boolean; [customAction: string]: boolean };
	isGrounded: boolean;
	velocity: THREE.Vector3;
	moveDirection: THREE.Vector3;
	raycaster: THREE.Raycaster;
	raycastOrigin: THREE.Vector3;
	downVector: THREE.Vector3;
	characterHeight: number;
	startPosition: THREE.Vector3;
	private startRotation: number;
	fadeOverlay: FadeOverlay | null;
	animationController: ICharacterAnimationController | null;

	// Locomotion↔idle hysteresis thresholds (m/s). With no movement input we keep
	// the walk/run animation playing until the body is clearly stopped (STOP) and
	// only start it again from idle once clearly moving (START). The dead band
	// stops a noisy kinematic linvel() from flickering idle↔walk↔run while the
	// character decelerates to a standstill.
	private static readonly LOCOMOTION_STOP_SPEED = 0.4;
	private static readonly LOCOMOTION_START_SPEED = 1.2;
	// True while the locomotion (walk/run) animation should play; latched with the
	// hysteresis above so it survives single-frame dips in the speed signal.
	private locomotionActive: boolean = false;

	// When true, the engine ignores keys.ascend for animation and movement.
	// Template code can still read keys.ascend directly to implement its own jump.
	private _jumpInputSuppressed: boolean = false;

	// Tracks the previous frame's jump count from the movement system so we can
	// detect rising edges (1→2 = double jump triggers the flip animation).
	private previousJumpCount: number = 0;
	// motionId of the animation played on the second jump. Lives in
	// AnimationAssets.coreAnimations as `ForwardFlip`.
	private static readonly DOUBLE_JUMP_ANIMATION_ID = 'mForwardFlip01';

	// When true, shouldProcessInput() always returns true so keyboard works
	// without pointer lock (mobile preview from the creator).
	private mobilePreviewMode: boolean = false;

	// Lazily-loaded mouse/keyboard emulation sidecar for creator mobile preview.
	// Only instantiated when `setMobilePreviewMode(true)` is called — on real
	// mobile devices this stays null and the debug code never loads.
	private mobileControlsDebug: MobileControlsDebug | null = null;

	// Interaction state, prompt UI, and temporal action gating live in dedicated
	// components — see setInteractionsSuppressed() / suppressActionsFor() for the
	// thin delegate methods kept on PlayerController for backwards compatibility.
	private interactionPromptUI!: InteractionPromptUI;
	private interactionController!: InteractionController;
	private actionSuppression: ActionSuppressionManager = new ActionSuppressionManager();

	// Pluggable movement system
	private movementSystem: IPlayerMovement;
	/** The forged level's movement contract, when this level ships one (see reassertMovementContract). */
	private movementContract: ForgedMovementContract | null = null;

	// External XZ displacement queued by other systems (e.g. committed animation
	// root motion — a kick stepping into the ball) to be folded into the movement
	// system's collision-clamped motion this frame. Accumulated via
	// addExternalDisplacement, drained once per movement update via
	// consumeExternalDisplacement.
	private readonly _externalDisplacement = new THREE.Vector3();

	// Pluggable attack system
	protected attackSystem: IPlayerAttack | null = null;

	// Sliding VFX system - can be overridden by templates
	protected slidingVFX: ISlidingVFX | null = null;
	private currentTerrainFriction: number = 0.7; // Track current friction for VFX
	
	// When true, the player cannot exit the vehicle (for racing games etc.)
	private vehicleExitLocked: boolean = false;

	// What happens when the player falls out of the world — see FallRescue.ts.
	private fallRescue: FallRescueOptions = { ...DEFAULT_FALL_RESCUE_OPTIONS };
	private vehicleRespawnProvider: VehicleRespawnProvider | null = null;

	/**
	 * Fired just BEFORE the engine rescues a player who fell below the kill
	 * plane, so a game holding the vehicle can react while the reference is
	 * still live. The event says which of the three things is about to happen
	 * (car teleported / car destroyed / player respawned) and where.
	 *
	 * A game that owns per-run state tied to the vehicle (lap clock,
	 * checkpoints, finish line) should reset it here rather than discover the
	 * change by reading stale coordinates off a destroyed car.
	 *
	 * **Return `true` to take over.** The engine then does nothing at all — no
	 * teleport, no respawn, no destroy — and the fall is entirely the game's to
	 * handle (its own death sequence, checkpoint rewind, fade-out). Returning
	 * nothing lets the engine proceed as described by the event.
	 *
	 * A handler that takes over MUST actually move the player or change game
	 * state: the body is still below the plane, so the event fires again on the
	 * next frame, and every frame after that, until something moves it.
	 */
	onFallRescue: ((event: FallRescueEvent) => boolean | void) | null = null;

	// Player physics + update-loop gate. False = capsule frozen and the
	// update() loop short-circuits (no movement, no controls). Visibility is
	// a separate concern — owned by PlayerVisibility, not this flag.
	private playerEnabled: boolean = true;

	// Manual override for mobile movement-control visibility (joystick + jump/crouch).
	// null = auto-detect (see getMobileMovementControlsAvailable); true/false = force on/off.
	private mobileMovementOverride: boolean | null = null;


	// Capsule dimensions (set by PlayerLoader)
	capsuleRadius: number;
	
	// Voxel block size for step climbing (set from level data, default 1m)
	voxelBlockSize: number = 1.0;
	
	// Reference to PlayerLoader for character switching
	playerLoader: PlayerLoader | null = null;

	// Reference to world generator for subclasses that need world generation access
	// Can optionally implement TerrainFrictionProvider for automatic terrain friction
	protected worldGenerator: (unknown & Partial<TerrainFrictionProvider>) | null;

	// Callback to notify when player object changes (for physics sync)
	onPlayerChanged: ((newPlayer: THREE.Object3D) => void) | null = null;

	// ── Character Ready Event ──────────────────────────────────────────
	// Supports multiple listeners. Safe to call before or after character loads.
	// If character is already ready when a listener is added, fires immediately.
	private _characterReady = false;
	private _onCharacterReadyCallbacks: (() => void)[] = [];
	
	/**
	 * Callback fired when an enemy projectile hits the player.
	 * By default, this applies 10 damage to the player's health.
	 * Override to customize damage behavior.
	 */
	onEnemyProjectileHit: (() => void) | null = null;
	
	// ════════════════════════════════════════════════════════════════════════
	// PLAYER HEALTH SYSTEM
	// ════════════════════════════════════════════════════════════════════════

	private healthComp: HealthComponent = new HealthComponent(
		{ onPreDeath: () => {}, onExplode: () => {}, onRagdoll: (impulse?: THREE.Vector3) => this.triggerPlayerRagdoll(impulse) },
		{ health: 100, maxHealth: 100, canDie: true, explodeOnDeath: false, ragdollOnDeath: false }
	);

	/** Lazily-built death ragdoll (created on first ragdoll death; reused across respawns). */
	private ragdollComp: RagdollComponent | null = null;

	/** Callback fired when player health changes (for HUD updates) */
	onHealthChanged: ((current: number, max: number) => void) | null = null;

	/** Callback fired when player dies */
	onPlayerDeath: (() => void) | null = null;
	private readonly deathListeners = new Set<() => void>();

	/** Subscribe to death without replacing the game's existing callback. */
	addDeathListener(listener: () => void): () => void {
		this.deathListeners.add(listener);
		return () => { this.deathListeners.delete(listener); };
	}

	/** Default damage from enemy projectiles */
	private projectileDamage: number = 10;

	// Track which body parts have user-attached objects
	private attachedBodyParts: Set<string> = new Set();

	// Bound event handler references for proper cleanup
	// Desktop controls integration (automatically created for all platforms)
	protected desktopControls: DesktopControls;

	// Interaction state
	private interactPressed: boolean = false;

	// Action state
	private actionPressed: boolean = false;

	// Vehicle system integration - delegated to specialized controller
	private vehicleControllerHelper: PlayerVehicleController;
	// Animal riding system integration
	private animalControllerHelper: PlayerAnimalController;
	private walkingCamera: CameraController | null = null; // Store reference to walking camera

	// Interactable detection / activation lives on InteractionController; this
	// field is unused but kept (private) to avoid touching gameConstants wiring.
	private interactionRange: number;

	// Mobile controls integration (automatically created for all platforms)
	protected mobileControls: MobileControls;

	// Gamepad controls integration (automatically created, activates when a standard gamepad is connected)
	protected gamepadControls: GamepadControls;

	// Experimental MacBook-lid controller (local + dev; null in production).
	// Toggled from the creator DevTools tab or ?lidControl=1; emits alternating
	// left/right taps.
	protected lidSensorControls: LidSensorControls | null = null;

	// Tracks which input device was used most recently (for dynamic prompt labels)
	private lastActiveInput: 'keyboard' | 'gamepad' | 'mobile' = 'keyboard';

	// HUD reference for dynamic control display and reticle
	public hud: IGameHUD | null = null;

	// Track which movement system types have already shown controls in this playing session
	private shownMovementSystemControls: Set<string> = new Set();

	// Analog input (for joysticks/gamepads)
	public analogMoveX: number = 0; // -1 to 1
	public analogMoveY: number = 0; // -1 to 1
	public useAnalogMovement: boolean = false;

	// Action system - flexible callback-based design
	// Allows any action type: 'melee', 'projectile', 'dance', 'build', etc.
	public actionType: string | null = null;
	private actionHandler: ((player: THREE.Object3D, controller: PlayerController) => void) | null = null;
	private actionContinuous: boolean = false;

	// Secondary action system - for alternate actions (Q key on desktop, second button on mobile)
	public secondaryActionType: string | null = null;
	private secondaryActionHandler: ((player: THREE.Object3D, controller: PlayerController) => void) | null = null;
	private secondaryActionPressed: boolean = false;

	// Controls enabled state
	private controlsEnabled: boolean = true;

	// Optional weapon pickup system - can be enabled by calling setWeaponPickupManager()
	protected weaponPickupManager: WeaponPickupManager | null = null;
	protected static readonly WEAPON_PICKUP_RANGE = 2.5;
	// Callback for when a weapon is picked up - set by subclasses or game templates
	protected onWeaponPickedUpHandler: ((category: string, weaponType: string, pickup: import('engine/WeaponPickup.js').WeaponPickup) => void) | null = null;

	constructor(
		player: THREE.Object3D,
		playerBody: RAPIER.RigidBody,
		physicsWorld: PhysicsWorld,
		cameraController: CameraController,
		engine: EngineLike | null = null,
		physicsConfig: {
			gravity: number;
			terminalVelocity: number;
			jumpHeight: number;
			airControlMultiplier: number;
			groundFriction: number;
			airFriction: number;
		} = {
			gravity: -35.0,
			terminalVelocity: 53.0,
			jumpHeight: 2.2,
			airControlMultiplier: 0.5,
			groundFriction: 0.9,
			airFriction: 0.98
		},
		worldGenerator: (unknown & Partial<TerrainFrictionProvider>) | null = null,
		movementSystem?: IPlayerMovement,
		constants?: Partial<GameConstants>
	) {
		if (!playerBody) {
			throw new Error('Player body is null or undefined');
		}
		if (!physicsWorld) {
			throw new Error('Physics world is null or undefined');
		}

		this.player = player;
		this.playerBody = playerBody;
		this.physicsWorld = physicsWorld;
		this.cameraController = cameraController;
		this.engine = engine;
		this.engine?.getPlayerVisibility().setSkeletonRoot(player);
		this.worldGenerator = worldGenerator;
		this.maxSlope = 0.7;
		this.stepHeight = 0.4;
		this.keys = PlayerController.buildEmptyKeys();
		this.isGrounded = false;
		
		// Merge constants with defaults
		const gameConstants = mergeConstants(constants);
		this.interactionRange = gameConstants.interactionRange;
		this.velocity = new THREE.Vector3();
		this.moveDirection = new THREE.Vector3();
		this.raycaster = new THREE.Raycaster();
		this.raycastOrigin = new THREE.Vector3();
		this.downVector = new THREE.Vector3(0, -1, 0);
		this.characterHeight = 1.75; // Default, will be updated from world profile

		// Initialize pluggable movement system (defaults to walking/jumping with double-jump)
		// World-profile movement mode: lets world.json install skiing at spawn
		// with zero genre-code edits. An explicitly passed movementSystem
		// always wins over the flag.
		const gameData = this.engine?.getGameData?.();
		const profileMovement = gameData?.worldProfileData?.playerMovement;
		// Platformer MOVEMENT CONTRACT: a forged platformer level carries, on its level asset, the
		// movement kit it was designed to be completable with (jump apex, double-jump, run speed).
		// Adopt it so the character can actually clear what the forger built — without this the
		// default 2.2 m jump cannot climb a platformer level. See world-forger platformer/movement.ts.
		const contract = (gameData as { assets?: Array<{ worldForgerMovement?: { effective?: ForgedMovementContract } }> } | undefined)
			?.assets?.map((a) => a.worldForgerMovement?.effective).find((e): e is ForgedMovementContract => typeof e?.jumpRise === 'number');
		if (movementSystem) {
			this.movementSystem = movementSystem;
		} else if (profileMovement?.mode === 'ski') {
			this.movementSystem = new SkiMovement(profileMovement.ski);
		} else if (profileMovement?.mode === 'boat') {
			this.movementSystem = new BoatMovement(profileMovement.boat);
		} else if (contract) {
			this.movementContract = contract;
			this.movementSystem = new WalkingAndJumpingMovement(
				typeof contract.runSpeed === 'number' ? contract.runSpeed : 5,
				{ ...physicsConfig, jumpHeight: PlayerController.contractJumpHeight(contract, physicsConfig.jumpHeight) },
				typeof contract.multiJump === 'number' ? contract.multiJump : 2,
			);
		} else {
			this.movementSystem = new WalkingAndJumpingMovement(5, physicsConfig, 2);
		}
		this.movementSystem.onAttached?.(this);

		// Capture the initial position and rotation as the start state
		this.startPosition = new THREE.Vector3();
		this.startRotation = 0;
		if (this.player && this.player.position) {
			this.startPosition.copy(this.player.position);
			this.startRotation = this.player.rotation.y;
		}

		// Push initial rotation into the movement system so the player faces
		// the configured spawn direction from the first frame
		if (this.startRotation !== 0) {
			this.movementSystem.setRotation?.(this.startRotation);
		}

		// Initialize fade overlay
		this.fadeOverlay = new FadeOverlay();

		// Initialize animation controller reference
		this.animationController = null;

		// Initialize sliding VFX if engine has a scene
		// Templates can override this by setting slidingVFX to a custom implementation or null
		if (engine?.scene) {
			this.slidingVFX = this.createSlidingVFX(engine.scene);
		}

		// Initialize capsule radius (will be set by PlayerLoader)
		this.capsuleRadius = 0.3;

		// Action system initialized via setActionHandler() method
		this.actionType = null;
		this.actionHandler = null;

		// Secondary action system initialized via setSecondaryActionHandler() method
		this.secondaryActionType = null;
		this.secondaryActionHandler = null;

		// Initialize mobile controls (works on all platforms, auto-detects touch support)
		this.mobileControls = new MobileControls({
			joystickSize: 100,
			joystickDeadzone: 0.15,
			cameraSensitivity: 0.05
		});

		// Initialize vehicle controller
		this.vehicleControllerHelper = new PlayerVehicleController(engine);

		// Pass mobile controls to vehicle controller
		this.vehicleControllerHelper.setMobileControls(this.mobileControls);
		
		// Initialize animal riding controller
		this.animalControllerHelper = new PlayerAnimalController(engine);

		// Listen to game state changes to reset movement system control tracking
		// Reset tracking when entering PLAYING state (new session)
		const gameStateManager = getGameStateManager();
		gameStateManager.addListener((newState, oldState) => {
			if (newState === GameState.PLAYING && oldState !== GameState.PLAYING) {
				// Reset tracking when starting a new playing session
				this.shownMovementSystemControls.clear();
				// Reveal the character now that the player has pressed Play
				this.updatePlayerVisibility();
			}
		});

		// Apply the initial hidden state to the player skeleton. The block
		// character (if any) is hidden later in setPlayerLoader().
		this.updatePlayerVisibility();

		// Initialize desktop controls (works on all platforms, auto-detects non-touch devices)
		this.desktopControls = new DesktopControls();
		// Pass shouldProcessInput as input gate so desktop controls respect focus/editor state
		this.desktopControls.setInputGate(() => this.shouldProcessInput());

		// Initialize gamepad controls (activates when a standard gamepad is connected)
		this.gamepadControls = new GamepadControls();

		// Experimental lid controller — available on local + dev (incl. published-to-beta
		// games), off in production. Reads its own enabled flag (?lidControl=1 or
		// game-origin localStorage) and connects on demand.
		if (!isProduction()) {
			this.lidSensorControls = new LidSensorControls();
		}

		// Interaction UI + controller (extracted from PlayerController so it no
		// longer owns DOM or the interactable-activation logic). InteractionPromptUI
		// renders the floating "[E] Open door" prompt; InteractionController drives
		// it via nearest-interactable detection and the E-key / mobile-tap flow.
		this.interactionPromptUI = new InteractionPromptUI({
			getCamera: () => this.cameraController?.getCamera() ?? null,
			mobileControls: this.mobileControls,
			getInputLabel: () => this.getInputLabel('interact'),
			onMobileTap: () => { this.mobileControls.interactPressed = true; },
		});
		this.interactionController = new InteractionController({
			playerController: this,
			promptUI: this.interactionPromptUI,
			vehicleControllerHelper: this.vehicleControllerHelper,
			animalControllerHelper: this.animalControllerHelper,
			mobileControls: this.mobileControls,
			getWeaponPickupManager: () => this.weaponPickupManager,
			getCameraController: () => this.cameraController,
			setCameraController: (camera) => { this.cameraController = camera; },
			getEngine: () => this.engine,
			retargetCamera: this.retargetCamera,
			weaponPickupRange: PlayerController.WEAPON_PICKUP_RANGE,
		});

		// Update mobile control button labels from movement system
		this.updateMobileControlLabels();
		
		// Auto-connect enemy projectile hit to damage system
		// Templates can override onEnemyProjectileHit for custom behavior
		this.onEnemyProjectileHit = () => {
			this.takeDamage(this.projectileDamage, 'projectile');
		};

		// Wire HealthComponent callbacks to player-specific callbacks
		this.healthComp.onDamage = (_damage, currentHealth, maxHealth, source) => {
			console.log(`🩸 Player took ${_damage} damage from ${source || 'unknown'}. Health: ${currentHealth}/${maxHealth}`);
			this.onHealthChanged?.(currentHealth, maxHealth);
		};
		this.healthComp.onDeathEffect = () => {
			console.log('💀 Player died!');
			getGameEventLog().logEvent({ type: 'player-death', position: this.getPosition(), actor: 'player' });
			for (const listener of this.deathListeners) listener();
			this.onPlayerDeath?.();
		};

		// Apply creator-set combat config (world.json `combatConfig`, set via the AI editor).
		const combat = this.engine?.getGameData?.()?.worldProfileData?.combatConfig;
		if (combat?.ragdollOnDeath !== undefined) {
			this.healthComp.getDamageableConfig().ragdollOnDeath = combat.ragdollOnDeath;
		}

		// Initial registration of the player as a peer body (userData) and
		// a path-conflict virtual obstacle. See `syncPlayerBodyRegistration`
		// for why this also runs per-frame: BitmagicPlayerCharacter and
		// DonaldDuckExampleCharacter reassign `playerController.playerBody`
		// AFTER this constructor finishes, swapping in a fresh body whose
		// handle, userData, and path-conflict registration must be re-done.
		this.syncPlayerBodyRegistration();
	}

	/**
	 * Per-frame bookkeeping that keeps the player's physics body discoverable
	 * by NPC / animal proximity scans:
	 *
	 *   1. `PhysicsWorld.queryEntitiesInRadius` filters out any body whose
	 *      handle isn't in `handleToUserData`, so the player needs userData
	 *      with `__type: 'player'` (AgentAvoidance priority tier) and
	 *      `agentRadius` (other agents' combined-radius math).
	 *
	 *   2. `PathConflictAvoidanceSystem` keeps an `agents` Map keyed by
	 *      body handle. The player must be registered as a static blocker
	 *      (no path, no scan) so other agents' forward-path scans flag
	 *      the player as a virtual obstacle and re-plan around them.
	 *
	 * Both need re-doing every time `this.playerBody` changes — and it DOES
	 * change in normal game startup: `BitmagicPlayerCharacter.ts` and
	 * `DonaldDuckExampleCharacter.ts` call `playerLoader.recreatePhysicsBody`
	 * then assign `playerController.playerBody = newBody`, which destroys
	 * the old body (clearing its userData) and installs a fresh body whose
	 * handle, userData, and registration are all unset. Without this
	 * per-frame check the player is silently invisible to all proximity
	 * scans even though physical collision still works (NPCs walk into and
	 * push the player instead of routing around).
	 *
	 * Cheap: compares one handle each frame; only does work on actual swaps.
	 */
	private lastRegisteredPlayerHandle: number | null = null;
	private syncPlayerBodyRegistration(): void {
		if (!this.playerBody) return;
		const handle = this.playerBody.handle;
		if (handle === this.lastRegisteredPlayerHandle) {
			// Body unchanged — userData / registration already in place.
			return;
		}
		const pcs = getGlobalPathConflictAvoidance();
		// Tear down old-handle bookkeeping. (handleToUserData for the old
		// body was cleared by `removeRigidBody` when the body was replaced.)
		if (this.lastRegisteredPlayerHandle !== null) {
			pcs?.unregister(this.lastRegisteredPlayerHandle);
		}
		// Install fresh-body bookkeeping.
		this.physicsWorld.setUserData(this.playerBody, {
			__type: 'player',
			agentRadius: this.capsuleRadius,
		});
		pcs?.registerStaticBlocker(handle, this.player.position, () => this.capsuleRadius);
		this.lastRegisteredPlayerHandle = handle;
	}

	/**
	 * Update mobile control button labels, visibility, and behavior based on current movement system
	 */
	private updateMobileControlLabels(): void {
		if (!this.mobileControls.isEnabled()) return;

		this.applyMobileMovementAvailability();
		const supportedKeys = this.movementSystem.getSupportedKeys();
		// When jump input is suppressed the mobile jump button would be dead, so hide it.
		if (this._jumpInputSuppressed) supportedKeys.ascend = false;
		this.mobileControls.updateMovementButtons(
			this.movementSystem.getAscendDisplayName(),
			this.movementSystem.getDescendDisplayName(),
			supportedKeys,
			this.movementSystem.getKeyBehavior(),
		);
	}

	/**
	 * Whether this game has a player for the movement keys and the mobile joystick
	 * (+ jump/crouch) to drive: the override if one was set, otherwise auto-detected
	 * from `worldProfileData` — false only when the game has no player character AND
	 * isn't first-person AND the player isn't driving a vehicle, i.e. there is
	 * genuinely nothing to move (a board or strategy game played by tapping the
	 * scene). See `computeMovementControlsAvailable` for the contract.
	 *
	 * Public because `bitmagic verify --platform mobile` reads it from the running
	 * game (through `window.gameTemplate`) to tell a pointer-driven game's missing
	 * touch controls from a real gap. Renaming it breaks that probe.
	 */
	public getMobileMovementControlsAvailable(): boolean {
		const profile = this.engine?.getGameData?.()?.worldProfileData;
		return computeMovementControlsAvailable(profile, !!this.getActiveVehicle(), this.mobileMovementOverride);
	}

	/**
	 * Force the mobile movement controls (joystick + jump/crouch) on or off.
	 * Pass `true`/`false` to override, or `null` to restore auto-detection
	 * (see getMobileMovementControlsAvailable). Reachable from genre code via the
	 * player controller or GameEngine.getPlayerController().
	 */
	public setMobileMovementControlsAvailable(value: boolean | null): void {
		this.mobileMovementOverride = value;
		this.applyMobileMovementAvailability();
	}

	/** Push the effective movement-control availability to MobileControls. */
	private applyMobileMovementAvailability(): void {
		this.mobileControls.setMovementControlsAvailable(this.getMobileMovementControlsAvailable());
	}

	/**
	 * Set the vehicle manager for this player controller
	 */
	setVehicleManager(vehicleManager: VehicleManager): void {
		// Store reference to walking camera
		this.walkingCamera = this.cameraController;
		this.vehicleControllerHelper.setVehicleManager(vehicleManager, this.walkingCamera);
		this.detectAndSetCameraMode();
	}

	/**
	 * Restore the walking camera and re-target it at the player. Used as the
	 * `onCameraRestore` callback by vehicle/animal exit + dismount flows.
	 * Bound arrow form lets call sites pass `this.retargetCamera` directly.
	 */
	private retargetCamera = (camera: CameraController | null): void => {
		this.cameraController = camera;
		this.cameraController?.setTarget?.(this.player);
	};

	/**
	 * Detect the CameraMode of the current walking camera via duck-typing
	 * and forward it to the vehicle controller so it picks the right
	 * vehicle camera variant.
	 */
	private detectAndSetCameraMode(): void {
		const cam = this.walkingCamera as Record<string, unknown> | null;
		if (cam && typeof cam.setHeight === 'function' && typeof cam.setTarget === 'function') {
			this.vehicleControllerHelper.setCameraMode('top-down');
		} else if (cam && typeof cam.setEyeHeight === 'function') {
			this.vehicleControllerHelper.setCameraMode('first-person');
		} else {
			this.vehicleControllerHelper.setCameraMode('third-person');
		}
	}

	/**
	 * Override which camera is used when the player drives a vehicle.
	 *
	 * - 'auto'    — detect from walking camera type (default)
	 * - 'chase'   — VehicleCamera (third-person chase cam)
	 * - 'cockpit' — FirstPersonVehicleCamera (driver's-eye)
	 * - 'keep'    — retarget the walking camera to the vehicle chassis so
	 *               any custom follow camera keeps working while driving
	 *
	 * Call this after {@link setVehicleManager} if you want a non-default mode.
	 */
	setVehicleCameraMode(mode: VehicleCameraMode): void {
		this.vehicleControllerHelper.setVehicleCameraMode(mode);
		const vc = this.vehicleControllerHelper.getVehicleCamera();
		if (vc) this.cameraController = vc;
		this.applyVehicleCameraConfig();
	}

	/**
	 * Set the weapon pickup manager for this player controller
	 * Enables picking up weapons from the ground with E key
	 */
	setWeaponPickupManager(manager: WeaponPickupManager): void {
		this.weaponPickupManager = manager;
		
		// Set up pickup callback to forward to handler
		manager.setOnPickupCallback((category, weaponType, pickup) => {
			if (this.onWeaponPickedUpHandler) {
				this.onWeaponPickedUpHandler(category, weaponType, pickup);
			} else {
				console.warn('🗡️ PlayerController: Weapon picked up but no handler set! Use setOnWeaponPickedUp() to handle weapon equipping.');
			}
		});
		
		console.log('🗡️ PlayerController: Weapon pickup system enabled');
	}

	/**
	 * Set callback for when a weapon is picked up
	 * Use this to implement weapon equipping in your game
	 * 
	 * @example
	 * playerController.setOnWeaponPickedUp((category, weaponType, pickup) => {
	 *     console.log(`Picked up ${pickup.getWeaponName()}`);
	 *     // Implement your equipping logic here
	 * });
	 */
	setOnWeaponPickedUp(handler: (category: string, weaponType: string, pickup: import('engine/WeaponPickup.js').WeaponPickup) => void): void {
		this.onWeaponPickedUpHandler = handler;
	}

	/**
	 * Get the weapon pickup manager (if set)
	 */
	getWeaponPickupManager(): WeaponPickupManager | null {
		return this.weaponPickupManager;
	}

	/**
	 * Set weapon pickup manager reference for interaction detection only.
	 * Unlike setWeaponPickupManager(), this does NOT set up a callback.
	 * Use this when the callback is managed by an external system (e.g., WeaponPickupSystem).
	 */
	setWeaponPickupManagerReference(manager: WeaponPickupManager | null): void {
		this.weaponPickupManager = manager;
	}

	/**
	 * Register a callback for when the character is fully loaded and ready for attachments.
	 * Safe to call at any time — if the character is already ready, fires immediately.
	 * Multiple listeners are supported.
	 *
	 * @example
	 * controller.onCharacterReady(() => {
	 *     controller.attachToBodyPart(sword, 'rightHand');
	 * });
	 */
	onCharacterReady(callback: () => void): void {
		if (this._characterReady) {
			callback();
		} else {
			this._onCharacterReadyCallbacks.push(callback);
		}
	}

	/**
	 * Called by PlayerLoader when character is fully loaded.
	 * Fires all registered onCharacterReady callbacks.
	 * @internal — do not call from template code.
	 */
	fireCharacterReady(): void {
		this._characterReady = true;
		for (const cb of this._onCharacterReadyCallbacks) {
			cb();
		}
		this._onCharacterReadyCallbacks = [];
	}

	/**
	 * Queue an external world-space XZ displacement to be applied to the player
	 * this frame, on top of input-driven movement. The accumulated vector is
	 * drained by the movement system (via {@link consumeExternalDisplacement})
	 * and routed through its collision-clamped motion, so it never tunnels
	 * through walls. Y is ignored — gravity owns the vertical axis. Used to
	 * commit animation root motion (e.g. a kick stepping into the ball).
	 */
	addExternalDisplacement(delta: THREE.Vector3): void {
		this._externalDisplacement.x += delta.x;
		this._externalDisplacement.z += delta.z;
	}

	/**
	 * Drain the accumulated external displacement into `out` (XZ; Y = 0) and
	 * clear it. Called once per movement update. Returns `out`.
	 */
	consumeExternalDisplacement(out: THREE.Vector3): THREE.Vector3 {
		out.set(this._externalDisplacement.x, 0, this._externalDisplacement.z);
		this._externalDisplacement.set(0, 0, 0);
		return out;
	}

	/**
	 * Set the action handler for the Enter key
	 * This is the primary way to implement player actions in game templates
	 *
	 * Automatically syncs with mobile controls (created in base class constructor)
	 *
	 * @param actionType - Type of action (e.g., 'melee', 'projectile', 'dance', 'build')
	 * @param handler - Callback function that executes when Enter is pressed
	 *
	 * @example
	 * // Melee attack with priority animation (prevents idle animation interruption)
	 * playerController.setActionHandler('melee', (player, controller) => {
	 *     const animController = controller.animationController;
	 *     if (animController && animController.playPriorityAnimation) {
	 *         // Play a priority animation that blocks idle/movement animations
	 *         const result = animController.playPriorityAnimation('Punch_1', {
	 *             fadeInDuration: 0.1,
	 *             fadeOutDuration: 0.2,
	 *             onFinished: () => {
	 *                 console.log('Attack animation finished');
	 *             }
	 *         });
	 *         if (result.success) {
	 *             // Animation is now playing and won't be interrupted by idle
	 *         }
	 *     }
	 * });
	 *
	 * @example
	 * // Dance action (non-combat game)
	 * playerController.setActionHandler('dance', (player, controller) => {
	 *     // Play dance animation
	 * });
	 */
	setActionHandler(
		actionType: string | null,
		handler: ((player: THREE.Object3D, controller: PlayerController) => void) | null,
		options?: { continuous?: boolean }
	): void {
		this.actionType = actionType;
		this.actionHandler = handler;
		this.actionContinuous = options?.continuous ?? false;

		// Auto-sync action type to mobile controls (automatically created in constructor)
		this.mobileControls.setActionType(actionType);
		this.mobileControls.setActionBehavior(this.actionContinuous ? 'continuous' : 'tap');
	}

	/**
	 * Set the secondary action handler (Q key on desktop, second button on mobile).
	 * Use this for alternate actions like aim-down-sights, block, or alternate fire.
	 *
	 * @param actionType - Type identifier (e.g., 'aim', 'block', 'altfire', 'special')
	 * @param handler - Callback when secondary action is triggered
	 */
	setSecondaryActionHandler(actionType: string | null, handler: ((player: THREE.Object3D, controller: PlayerController) => void) | null): void {
		this.secondaryActionType = actionType;
		this.secondaryActionHandler = handler;

		// Auto-sync action type to mobile controls
		this.mobileControls.setSecondaryActionType(actionType);
	}

	/**
	 * Register a cross-platform custom action in a single call. Use this whenever
	 * you need a new action beyond the 6 built-ins (action, secondaryAction,
	 * interact, ascend, descend, exit). The API *always requires* a mobile button
	 * definition so that feature parity is impossible to forget: every desktop key
	 * you bind here is guaranteed to have a mobile counterpart.
	 *
	 * The desktop side is the one deliberate exception. Omitting `desktop` (or
	 * passing an empty `keys` array) registers a **mobile-only** action: the button
	 * is created, no key is bound, and a `console.warn` fires. Desktop players
	 * cannot trigger it at all — `MobileControls` stays disabled outside a mobile
	 * runtime — so only do this for genuinely touch-only gestures. Forgetting a key
	 * by accident is the common case, and it degrades silently. Prefer
	 * `declareMobileActions()`, which requires `desktopKeys` and cannot express this.
	 *
	 * After registration, read state as `this.keys.<action>` — works identically
	 * for keyboard, mobile tap, and gamepad (if you wire gamepad separately).
	 *
	 * @example
	 * // Reload action — R on desktop, themed button on mobile
	 * this.registerCustomAction({
	 *     action: 'reload',
	 *     desktop: { keys: ['KeyR'] },
	 *     mobile: {
	 *         label: 'LOAD',
	 *         behavior: 'tap',
	 *         // Optional: 'primary' (default) | 'danger' | 'warning' picks which
	 *         // theme color paints the button.
	 *         role: 'warning',
	 *         position: {
	 *             bottom: 'min(290px, 60vh)', right: '20px',
	 *             width: '70px', height: '70px',
	 *             borderRadius: '50%', fontSize: '14px',
	 *         },
	 *     },
	 * });
	 *
	 * // Read in update():
	 * if (this.keys.reload) { this.weapon.reload(); this.keys.reload = false; }
	 *
	 * @param def.action   Unique action name (e.g. 'reload'). Used as the key in `this.keys`.
	 * @param def.desktop  Desktop binding: { keys: string[] } — array of KeyboardEvent.code values.
	 *                     Optional; omit or pass `keys: []` for a mobile-only action (see above).
	 * @param def.mobile   Mobile button config (label, optional theme role, tap/continuous, optional position).
	 */
	registerCustomAction(def: {
		action: string;
		/** Desktop binding. Omit (or pass an empty `keys` array) for a mobile-only action. */
		desktop?: { keys: string[] };
		mobile: {
			label: string;
			/** Optional image URL drawn instead of the label (which stays the accessible name). */
			imageUrl?: string;
			/** Optional theme role selecting the button color. Defaults to 'primary'. */
			role?: 'primary' | 'danger' | 'warning';
			/** @deprecated Ignored — mobile buttons follow the UI theme via `role`. */
			baseColor?: string;
			/** @deprecated Ignored — mobile buttons follow the UI theme via `role`. */
			pressedColor?: string;
			behavior: 'tap' | 'continuous';
			position?: MobileButtonPosition;
			initiallyHidden?: boolean;
		};
	}): void {
		if (!def.action || def.action.trim().length === 0) {
			throw new Error('registerCustomAction: action name is required');
		}
		const desktopKeys = def.desktop?.keys ?? [];
		const hasDesktopKeys = desktopKeys.length > 0;
		if (!hasDesktopKeys && !def.mobile) {
			throw new Error(`registerCustomAction('${def.action}'): unusable action — provide at least one desktop key (e.g. ['KeyR']) ` +
				'or a mobile button config (for a mobile-only action).');
		}
		if (!def.mobile) {
			throw new Error(`registerCustomAction('${def.action}'): mobile button config is required — every desktop key MUST have a mobile button. ` +
				'See control-system.md → "Adding Custom Actions".');
		}
		if (!hasDesktopKeys) {
			// Mobile-only action: no desktop key binding, but the mobile button is
			// still registered below. Warn (don't throw) so the game keeps loading.
			console.warn(`registerCustomAction('${def.action}'): no desktop key — registering a mobile-only action. ` +
				'Desktop players will not be able to trigger it.');
		}

		// Desktop side — bind each key to toggle this.keys[action]
		for (const keyCode of desktopKeys) {
			this.desktopControls.registerKeyHandler(
				keyCode,
				(pressed: boolean) => {
					this.keys[def.action] = pressed;
				},
				{ source: `registerCustomAction:${def.action}`, pairedWithMobile: true },
			);
		}

		// Mobile side — register the button + state slot. Color is theme-driven via
		// the button's role (defaults to 'primary'); no per-button color is passed.
		this.mobileControls.registerAction(
			{
				action: def.action,
				label: def.mobile.label,
				imageUrl: def.mobile.imageUrl,
				role: def.mobile.role,
				behavior: def.mobile.behavior,
			},
			def.mobile.position,
			def.mobile.initiallyHidden ?? false,
		);

		// Track the full desktop-key ↔ action mapping so verifyMobileParity()
		// can do an exact data-driven check. Mobile-only actions map to an empty
		// key list so parity stays consistent.
		this._customActionToKeys.set(def.action, [...desktopKeys]);
	}

	/** action name → list of desktop key codes that trigger it */
	private _customActionToKeys: Map<string, string[]> = new Map();

	/** Continuous custom actions currently held via their mobile button (see mergeCustomActionKeys). */
	private _mobileHeldCustomActions: Set<string> = new Set();

	/** Layout manager that hands out non-overlapping mobile button slots. */
	private _layout = new MobileButtonLayout();

	/**
	 * Declare every mobile action this game needs BEFORE systems initialize.
	 * GameTemplate calls this with the spec returned from Game.declareMobileActions().
	 * Each spec produces a desktop key binding + a mobile button in one slot.
	 *
	 * Handlers are wired later when systems call setActionHandler /
	 * setSecondaryActionHandler or directly toggle this.keys[action];
	 * declareMobileActions only allocates the UI + key bindings.
	 */
	declareMobileActions(specs: MobileActionSpec[]): void {
		for (const spec of specs) {
			const icon = MobileIconRegistry.get(spec.iconKey);
			// Prefer the registry's text label; fall back to the spec's own label.
			// A URL icon draws the image and keeps the spec label as its name.
			const label = icon?.kind === 'text' ? icon.value : spec.label;
			const imageUrl = icon?.kind === 'url' ? icon.value : undefined;
			const position = this._layout.assign(spec.action, spec.preferredSlot ?? 'primary');

			this.registerCustomAction({
				action: spec.action,
				desktop: { keys: spec.desktopKeys },
				mobile: {
					label,
					imageUrl,
					behavior: spec.behavior,
					position,
					initiallyHidden: spec.initiallyVisible === false,
				},
			});
		}
	}

	/**
	 * Verify that every desktop custom key handler has a corresponding mobile
	 * button, and vice-versa. Logs a console.error listing any gaps so the
	 * creator/tester sees them during preview — mobile players can't perform
	 * desktop-only actions, and orphan mobile buttons do nothing.
	 *
	 * Called automatically by GameTemplate on game start; you can also call it
	 * yourself after registering any late bindings.
	 *
	 * @returns a MobileParityResult describing any gaps; check `.ok`.
	 */
	verifyMobileParity(): MobileParityResult {
		const desktopKeys = this.desktopControls.getRegisteredCustomKeys();
		const mobileActions = this.mobileControls.getRegisteredActionNames();
		const result = computeMobileParity(desktopKeys, mobileActions, this._customActionToKeys);

		if (!result.ok) {
			// Decorate unpaired desktop keys with the source that registered them,
			// so the engineer can jump straight to the call site. Keys registered
			// via registerCustomAction are filtered out (pairedWithMobile: true);
			// what remains is the subset of result.unpairedDesktopKeys that came
			// in via raw registerKeyHandler calls.
			const unpairedSources = new Map<string, string>();
			for (const { key, source } of this.desktopControls.getUnpairedRawKeys()) {
				unpairedSources.set(key, source);
			}
			const desktopList = result.unpairedDesktopKeys.length > 0
				? result.unpairedDesktopKeys
					.map((k) => `${k}(${unpairedSources.get(k) ?? '(anonymous)'})`)
					.join(', ')
				: '(none)';

			console.error(
				`[mobile-parity] gaps found. ` +
				`Desktop keys with no mobile button: ${desktopList}. ` +
				`Mobile actions with no desktop key: ${result.unpairedMobileActions.join(', ') || '(none)'}. ` +
				`Use playerController.registerCustomAction({...}) to bind desktop + mobile together.`,
			);
		}
		return result;
	}

	setCharacterHeight(height: number): void {
		this.characterHeight = height;
	}

	setCapsuleDimensions(height: number, radius: number): void {
		this.characterHeight = height;
		this.capsuleRadius = radius;
		// Refresh the physics body's userData.agentRadius so other agents'
		// reactive AgentAvoidance scans use the new combined-radius. The
		// path-conflict registration already reads radius through a live
		// getter, so no work needed there. We don't touch
		// `lastRegisteredPlayerHandle` because the BODY hasn't changed —
		// only its capsule dimensions did.
		if (this.playerBody) {
			this.physicsWorld.setUserData(this.playerBody, {
				__type: 'player',
				agentRadius: radius,
			});
		}
	}

	setAnimationController(animationController: ICharacterAnimationController | null): void {
		this.animationController = animationController;
		
		// Set up callback to check for hand attachments if the controller supports it
		if (animationController && typeof animationController.setHasObjectAttachedToHandCallback === 'function') {
			animationController.setHasObjectAttachedToHandCallback(() => this.hasObjectAttachedToHand());
		}
	}

	setPlayerLoader(playerLoader: PlayerLoader): void {
		this.playerLoader = playerLoader;
		// Register the block character root with PlayerVisibility so hide/show
		// requests target it instead of the (always-hidden) skeleton. In skinned
		// mode the block character is just the hidden pose source — the visible
		// thing is the skeleton root — so we leave blockRoot null and let
		// PlayerVisibility manage the skeleton root (via setSkeletonRoot).
		this.engine?.getPlayerVisibility().setBlockRoot(
			playerLoader.isRenderingSkinnedMesh()
				? null
				: (playerLoader.getBlockCharacterRenderer()?.getRoot() ?? null)
		);
		this.updatePlayerVisibility();
	}

	setOnPlayerChangedCallback(callback: (newPlayer: THREE.Object3D) => void): void {
		this.onPlayerChanged = callback;
	}

	getWorldGenerator(): any | null {
		return this.worldGenerator;
	}

	/**
	 * Sync the visual player with the physics body position.
	 *
	 * Prefers the movement system's per-RENDER-frame kinematic target over
	 * `body.translation()`: the body only advances on fixed 60Hz substeps, so
	 * a visual synced from it stalls on 0-substep frames and double-jumps
	 * after catch-up frames — judder at a rock-steady 60 fps. The target is
	 * the same collision-clamped position the body will step to; using it
	 * makes player (and camera-follow) motion smooth at any refresh rate.
	 */
	private syncPlayerWithPhysics(): void {
		if (!this.playerBody || !this.player) return;

		// resolveRenderSyncPosition sanity-clamps: if the smooth target is far from
		// the body (teleport / respawn while movement updates were idle), the body wins.
		const pos = resolveRenderSyncPosition(this.movementSystem.getRenderPosition?.(), this.playerBody.translation());

		// Position the visual player so its feet sit at the bottom of the capsule.
		this.player.position.set(pos.x, pos.y - this.characterHeight / 2, pos.z);
	}

	shouldProcessInput(): boolean {
		// A spectator may keep pointer lock for orbiting. Focus never overrides
		// the explicit gameplay-input gate (including mobile preview).
		if (!this.controlsEnabled) return false;
		// Mobile preview mode: always process input so keyboard works without
		// pointer lock (creator sends SET_MOBILE_PREVIEW to enable this)
		if (this.mobilePreviewMode) return true;
		// If pointer lock is active, always allow input - this is the most reliable check
		// Pointer lock means the game is focused and actively receiving input
		if (document.pointerLockElement) return true;

		// Otherwise, check the various disable flags
		if (this.engine && !this.engine.isWindowFocused) return false;
		const editorManager = this.engine?.editorManager;
		if (editorManager && (editorManager.isEditorMode || editorManager.heightmapEditorEnabled)) return false;
		return true;
	}

	/**
	 * Enable or disable player controls (both desktop and mobile)
	 */
	public setControlsEnabled(enabled: boolean): void {
		this.controlsEnabled = enabled;

		// Propagate to every input source
		this.desktopControls.setControlsEnabled(enabled);
		this.mobileControls.setControlsEnabled(enabled);
		this.gamepadControls.setControlsEnabled(enabled);

		// Hide/show mobile controls UI. Decide movement-control (joystick +
		// jump/crouch) availability before showing, so a game with nothing to
		// move never flashes the joystick.
		if (enabled) this.applyMobileMovementAvailability();
		this.mobileControls.setVisible(enabled);

		// Reset all key states when disabling controls
		if (!enabled) {
			this.resetAllKeys();
		}
	}

	/** Build a fresh keys object with every built-in input cleared. */
	private static buildEmptyKeys(): PlayerController['keys'] {
		return { forward: false, backward: false, left: false, right: false, ascend: false, interact: false, action: false, secondaryAction: false, descend: false };
	}

	/**
	 * Clear every key (built-in AND custom) in place. The identity of
	 * `this.keys` is load-bearing: game code routinely captures the object
	 * in closures at load time (`const keys = pc.keys`), so reassigning it
	 * would leave those writers mutating a dead object while the engine
	 * reads the new one.
	 */
	private resetAllKeys(): void {
		for (const key of Object.keys(this.keys)) {
			this.keys[key] = false;
		}
		this._mobileHeldCustomActions.clear();
	}

	/**
	 * Lower every custom action key the mobile merge is currently holding true.
	 * Used where the merge stops running mid-hold (mobile controls disabled), which
	 * would otherwise leave the key latched with no touchend ever arriving.
	 */
	private releaseHeldCustomActionKeys(): void {
		for (const action of this._mobileHeldCustomActions) {
			this.keys[action] = false;
		}
		this._mobileHeldCustomActions.clear();
	}

	/**
	 * Clear every built-in input on the existing keys object in place, leaving
	 * any custom (registered) action keys untouched. Use this — rather than
	 * reassigning `buildEmptyKeys()` — when stale built-in state must be wiped
	 * without dropping custom actions, and because the identity of `this.keys`
	 * is load-bearing (see resetAllKeys).
	 */
	private clearBuiltInKeys(): void {
		Object.assign(this.keys, PlayerController.buildEmptyKeys());
	}

	/**
	 * Check if controls are currently enabled
	 */
	public getControlsEnabled(): boolean {
		return this.controlsEnabled;
	}

	/**
	 * Get desktop controls instance (for component-based systems)
	 */
	public getDesktopControls(): DesktopControls {
		return this.desktopControls;
	}

	/**
	 * Get mobile controls instance (for component-based systems)
	 */
	public getMobileControls(): MobileControls {
		return this.mobileControls;
	}

	public getGamepadControls(): GamepadControls {
		return this.gamepadControls;
	}

	/**
	 * Enable/disable the experimental MacBook-lid controller (localhost only).
	 * No-op off localhost (the controls are never instantiated there).
	 */
	public setLidControlEnabled(enabled: boolean): void {
		this.lidSensorControls?.setEnabled(enabled);
	}

	/**
	 * Set mobile preview mode from creator. Force-enables or disables
	 * mobile controls regardless of device detection.
	 */
	public setMobilePreviewMode(enabled: boolean, config?: Record<string, unknown>): void {
		this.mobilePreviewMode = enabled;
		if (enabled) {
			// Lazily wire the debug sidecar the first time preview mode is
			// turned on. The sidecar owns all mouse+keyboard emulation so
			// that code never runs on real mobile devices.
			this.mobileControlsDebug ??= new MobileControlsDebug(this.mobileControls, () => {
				// Preview interaction re-focuses the game window so isWindowFocused
				// (which gates camera/look input) recovers after the iframe blurred
				// to the surrounding creator UI. window.focus() also restores real
				// DOM focus so keyboard emulation keeps working.
				if (this.engine) this.engine.isWindowFocused = true;
				window.focus();
			});
			this.mobileControlsDebug.forceEnable(config as Partial<import('engine/MobileControls.js').MobileControlsConfig> | undefined);
			// Keep desktop controls enabled — keyboard (Space, WASD, etc.) works
			// natively. Mouse is handled by MobileControls emulation instead.
			// Sync button labels/visibility from the current movement system.
			this.updateMobileControlLabels();

			// Re-apply action handlers to the freshly-created buttons. The game
			// may have called setActionHandler('shoot') BEFORE mobile preview was
			// enabled — at that time `getButton('action')` returned null so the
			// visibility/icon update silently no-oped. Now that the buttons exist,
			// re-sync them.
			this.mobileControls.setActionType(this.actionType);
			this.mobileControls.setActionBehavior(this.actionContinuous ? 'continuous' : 'tap');
			this.mobileControls.setSecondaryActionType(this.secondaryActionType);
		} else {
			// Note: mobileControlsDebug instance is retained across enable/disable cycles.
			// forceEnable re-registers listeners and clears transient state (mouseIsDown,
			// emulatedKeys) on each call, so reuse is safe and avoids re-allocating DOM hooks.
			this.mobileControls.forceDisable();
			// Reset all key states to prevent stuck inputs
			this.clearBuiltInKeys();
			// A continuous custom action still held via a preview button gets no
			// touchend and the merge stops running once mobile controls are off,
			// so release what the merge raised here.
			this.releaseHeldCustomActionKeys();
		}
	}

	/**
	 * Whether the creator's mobile simulation preview is currently active.
	 * True only when running inside the creator with mobile preview toggled on
	 * (never on real devices). Used to skip desktop-only gameplay-start behaviour
	 * such as the fullscreen request.
	 */
	public getMobilePreviewMode(): boolean {
		return this.mobilePreviewMode;
	}

	/**
	 * Get which input device was used most recently.
	 * Use this to decide whether to show keyboard or gamepad labels in UI.
	 */
	public getLastActiveInput(): 'keyboard' | 'gamepad' | 'mobile' {
		return this.lastActiveInput;
	}

	/**
	 * Get the display label for a game action based on the currently active input device.
	 * Returns the keyboard key or gamepad button name appropriate for the user's last input.
	 * Returns empty string for mobile (mobile uses contextual buttons, not labels).
	 */
	public getInputLabel(action: 'interact' | 'action' | 'secondaryAction' | 'ascend' | 'descend' | 'exit'): string {
		if (this.lastActiveInput === 'mobile') return '';

		if (this.lastActiveInput === 'gamepad' && this.gamepadControls) {
			switch (action) {
				case 'interact': return this.gamepadControls.getInteractButtonLabel();
				case 'action': return this.gamepadControls.getActionButtonLabel();
				case 'secondaryAction': return this.gamepadControls.getSecondaryActionButtonLabel();
				case 'ascend': return this.gamepadControls.getAscendButtonLabel();
				case 'descend': return this.gamepadControls.getDescendButtonLabel();
				case 'exit': return this.gamepadControls.getExitButtonLabel();
			}
		}

		// Keyboard labels
		switch (action) {
			case 'interact': return this.desktopControls.getInteractKeyLabel();
			case 'action': return this.desktopControls.getActionKeyLabel();
			case 'secondaryAction': return this.desktopControls.getSecondaryActionKeyLabel();
			case 'ascend': return this.desktopControls.getAscendKeyLabel();
			case 'descend': return this.desktopControls.getDescendKeyLabel();
			case 'exit': return this.desktopControls.getInteractKeyLabel();
		}
	}

	/**
	 * The engine's jump-launch formula (`v = √(jumpHeight · 1.5 · |g|)`) yields a real apex of
	 * 0.75 × jumpHeight, for any gravity. The movement CONTRACT promises `jumpRise` as the real
	 * apex, so compensate: pass jumpRise × 4/3 as the engine jumpHeight.
	 */
	private static contractJumpHeight(contract: { jumpRise?: number }, fallback: number): number {
		return typeof contract.jumpRise === 'number' ? contract.jumpRise * (4 / 3) : fallback;
	}

	/**
	 * Re-apply the forged level's movement contract AFTER the genre module finished building.
	 * Game templates configure the player from `characterConfig` during build (e.g.
	 * `setMoveSpeed(charConfig.runSpeed)` with the 5 m/s default), silently clobbering the
	 * contract values adopted at construction — the level then physically cannot be completed
	 * (its platform spacing was solved for the contract kit). Called by the engine at the end of
	 * loadGame; later runtime edits (user prompts) still win because they run after this.
	 */
	reassertMovementContract(): void {
		const contract = this.movementContract;
		if (!contract) return;
		const ms = this.movementSystem;
		if (typeof contract.runSpeed === 'number') ms.setMoveSpeed(contract.runSpeed);
		if (typeof contract.jumpRise === 'number' && ms.getPhysicsConfig && ms.setPhysicsConfig) {
			ms.setPhysicsConfig({ ...ms.getPhysicsConfig(), jumpHeight: PlayerController.contractJumpHeight(contract, contract.jumpRise) });
		}
	}

	/**
	 * Knock the player back (spinning hazards, explosions, enemy hits). The player
	 * body is KINEMATIC, so `body.setLinvel()` / `body.applyImpulse()` do nothing —
	 * this is the supported way to shove the player. Velocities in m/s; a positive
	 * `upwardVelocity` pops the character off the ground so the shove carries.
	 * Example: knock away from a hazard at 9 m/s with a small hop:
	 * `pc.applyKnockback(dir.x * 9, dir.z * 9, 4.5)`.
	 */
	public applyKnockback(velocityX: number, velocityZ: number, upwardVelocity: number = 0): void {
		this.movementSystem.applyImpulse?.({ x: velocityX, y: upwardVelocity, z: velocityZ });
	}

	/**
	 * Set the movement system (e.g., WalkingAndJumpingMovement, SwimmingMovement, etc.)
	 */
	setMovementSystem(movementSystem: IPlayerMovement): void {
		const previous = this.movementSystem;
		if (previous && previous !== movementSystem) {
			previous.onDetached?.(this);
		}
		this.movementSystem = movementSystem;
		if (previous !== movementSystem) {
			movementSystem.onAttached?.(this);
			// The posture's captured "standing speed" belonged to the old system.
			this.postureState.onMovementSystemChanged();
		}
		// Swimming is a posture the movement mode implies: entering water puts
		// the character on the tread/stroke clips, leaving it stands back up.
		// Games never have to wire this. Other postures are explicit
		// (setPosture) because only the game knows when to crouch or sit.
		if (movementSystem instanceof SwimmingMovement) {
			this.setPosture('swim');
		} else if (this.postureState.current === 'swim') {
			this.setPosture('stand');
		}
		// Update mobile control button labels when movement system changes
		this.updateMobileControlLabels();
		// Update player visibility based on movement system
		this.updatePlayerVisibility();

		// Show controls temporarily when movement system changes (e.g., entering/exiting vehicle)
		// Only show if game is in PLAYING state and this movement system hasn't shown controls yet
		const gameStateManager = getGameStateManager();
		if (gameStateManager && gameStateManager.isState(GameState.PLAYING)) {
			// Get unique identifier for this movement system type (constructor name)
			const movementSystemType = movementSystem.constructor.name;
			
			// Only show controls if this movement system type hasn't been shown yet in this session
			if (!this.shownMovementSystemControls.has(movementSystemType) && this.hud) {
				this.hud.showControlsTemporarily();
				this.shownMovementSystemControls.add(movementSystemType);
			}
		}
	}

	/**
	 * Mark the current movement system as having shown controls
	 * Called by HUD when controls are shown externally (e.g., on game start)
	 */
	markCurrentMovementSystemControlsAsShown(): void {
		if (this.movementSystem) {
			const movementSystemType = this.movementSystem.constructor.name;
			this.shownMovementSystemControls.add(movementSystemType);
		}
	}

	/**
	 * Push the player's capsule out of any NPC capsule it overlaps.
	 *
	 * ENGINE-OWNED, MOTOR-AGNOSTIC character separation. Player↔NPC physics is
	 * deliberately one-sided (kinematic characters share no solver contact), so
	 * whether the player can walk through an enemy has historically depended on
	 * the active movement system remembering to treat NPCs as obstacles. The
	 * engine's own motor does; game-authored motors (sidescrollers that probe
	 * walls with terrain-only raycasts and call setNextKinematicTranslation
	 * directly) reliably don't — and every such game shipped a player who could
	 * push straight through enemies.
	 *
	 * Running AFTER all character updates, on the bodies themselves, makes the
	 * guarantee independent of who moved them. Only the PLAYER is displaced:
	 * NPC positions belong to navigation, and shoving them creates rubber-band
	 * fights with the pathfinder.
	 */
	enforceCharacterSeparation(): void {
		const body = this.playerBody;
		const registry = this.engine?.getNpcRegistry?.();
		if (!body || !registry || !this.playerLoader) return;
		if (!this.playerEnabled) return;

		const rPlayer = this.playerLoader.getCapsuleRadius?.() ?? 0.4;
		const hPlayer = this.playerLoader.getCapsuleHeight?.() ?? 1.8;
		let t = body.translation();

		for (const npc of registry.getAllControllers()) {
			if (npc.isDead() || npc.isHibernating()) continue;
			const npcPos = npc.getPosition();
			const minSep = rPlayer + npc.capsuleRadius;
			const dx = t.x - npcPos.x;
			const dz = t.z - npcPos.z;
			const d2 = dx * dx + dz * dz;
			if (d2 >= minSep * minSep) continue;
			// No vertical overlap → standing above/below (on a head, on a ledge).
			if (Math.abs(t.y - npcPos.y) > (hPlayer + npc.capsuleHeight) / 2) continue;

			const d = Math.sqrt(d2);
			// Dead-centre overlap has no separation axis; push along +X arbitrarily.
			const nx = d > 1e-4 ? dx / d : 1;
			const nz = d > 1e-4 ? dz / d : 0;
			const push = minSep - d;
			body.setTranslation({ x: t.x + nx * push, y: t.y, z: t.z + nz * push }, true);
			t = body.translation();
		}
	}

	/**
	 * Set the attack system (e.g., UnarmedMeleeSystem, ProjectileShootSystem, etc.)
	 * Attack system handles input and updates automatically in the base update loop.
	 *
	 * For melee weapons (WeaponMeleeSystem): automatically sets up the action handler
	 * so Enter key / left click / mobile action button triggers attacks. No need to
	 * call setActionHandler('melee', ...) separately.
	 */
	setAttackSystem(attackSystem: IPlayerAttack | null): void {
		// Clean up old attack system
		if (this.attackSystem) {
			this.attackSystem.removeEventListeners();
			this.attackSystem.dispose();
		}

		// Set new attack system
		this.attackSystem = attackSystem;

		// Initialize new attack system
		if (this.attackSystem) {
			// Give the attack system a reference to this controller
			this.attackSystem.setController(this);
			this.attackSystem.setupEventListeners();
			this.attackSystem.setMobileControls(this.mobileControls);

			// Auto-setup action handler if the attack system provides one and none is set.
			// This prevents the common mistake of forgetting setActionHandler('melee', ...)
			// which leaves the Enter key / mobile action button non-functional.
			if (!this.actionHandler && this.attackSystem.getActionHandler) {
				const { actionType, handler } = this.attackSystem.getActionHandler();
				this.setActionHandler(actionType, handler);
			}
		}
	}

	/**
	 * Get the current attack system
	 */
	getAttackSystem(): IPlayerAttack | null {
		return this.attackSystem;
	}

	/**
	 * Suppress the engine's internal handling of the jump (ascend) key.
	 * When suppressed, the engine won't trigger jump animations AND
	 * the movement system won't see the ascend key (no physics jump).
	 * Template code can still read keys.ascend directly to detect
	 * button press/release and implement its own jump.
	 */
	setJumpInputSuppressed(suppressed: boolean): void {
		this._jumpInputSuppressed = suppressed;
		// Refresh the mobile jump button visibility — it's hidden while suppressed,
		// and this setter is typically called after the initial mobile-label setup
		// that runs during controller construction.
		this.updateMobileControlLabels();
	}

	/** Whether the engine's internal jump (ascend) handling is currently suppressed. */
	isJumpInputSuppressed(): boolean {
		return this._jumpInputSuppressed;
	}

	/**
	 * Called when the movement system reports a new jump (rising edge of
	 * jumpCount). The second (and any subsequent) jump triggers the forward
	 * flip animation; the first uses the standard JUMP state animation.
	 *
	 * The flip plays on track B via Mixamo, with built-in fade-in/out for
	 * smooth blending. The state machine pauses during the custom animation
	 * (via isPlayingCustomAnimation) and resumes naturally afterwards.
	 */
	private onJumpTriggered(jumpNumber: number): void {
		if (jumpNumber < 2) return;
		this.animationController?.playCustomAnimation?.(
			PlayerController.DOUBLE_JUMP_ANIMATION_ID,
			{ fadeInDuration: 0.15, fadeOutDuration: 0.2, speed: 2, filterRootMotion: true },
		);
	}

	// Suppress all interaction prompts and E-key handling. Delegates to
	// InteractionController — kept on PlayerController as a stable public API
	// for templates and NPC/dialog code that doesn't reach into engine internals.
	setInteractionsSuppressed(suppressed: boolean): void {
		this.interactionController.setSuppressed(suppressed);
	}

	areInteractionsSuppressed(): boolean { return this.interactionController.isSuppressed(); }

	// Suppress the given player action(s) for `seconds`. While suppressed, the
	// engine forces `this.keys.<action>` AND the mirrored *Pressed flags on each
	// input source to false every frame — so a single physical press cannot
	// leak into multiple subsystems after a transition. Delegates to
	// ActionSuppressionManager.
	public suppressActionsFor(seconds: number, actions?: SuppressibleAction[]): void {
		this.actionSuppression.suppressFor(seconds, actions);
	}

	private applyActionSuppression(): void {
		this.actionSuppression.apply(this.keys, this.desktopControls, this.mobileControls, this.gamepadControls);
	}

	/**
	 * Create sliding VFX system - can be overridden by templates
	 * Return null to disable sliding VFX, or return a custom ISlidingVFX implementation
	 * @param scene - The Three.js scene
	 * @returns ISlidingVFX implementation or null
	 */
	protected createSlidingVFX(scene: THREE.Scene): ISlidingVFX | null {
		return new SlidingVFX(scene);
	}

	/**
	 * Set a custom sliding VFX system (or null to disable)
	 */
	setSlidingVFX(slidingVFX: ISlidingVFX | null): void {
		// Dispose old VFX
		if (this.slidingVFX) {
			this.slidingVFX.dispose();
		}
		this.slidingVFX = slidingVFX;
	}

	/**
	 * Get the current sliding VFX system
	 */
	getSlidingVFX(): ISlidingVFX | null {
		return this.slidingVFX;
	}

	/**
	 * Enable or disable the player at the physics + update-loop level. When
	 * disabled, the physics capsule is frozen (no gravity, no collisions) and
	 * `update()` short-circuits (no input, no movement). Use for board games,
	 * strategy, cutscenes, or anywhere the player should functionally not
	 * exist for a stretch.
	 *
	 * This does NOT touch visibility — pair with
	 * `engine.getPlayerVisibility().hide()` if you also want the character
	 * hidden. Splitting the concerns lets you have e.g. a frozen-but-visible
	 * cutscene pose, or a moving-but-invisible stealth ability.
	 */
	setPlayerEnabled(enabled: boolean): void {
		// No dedup on the cached flag — other code paths (e.g.
		// `setCapsuleBodyEnabled` while driving) toggle the physics body
		// directly, leaving our flag out of sync. Always re-apply so a
		// subsequent `setPlayerEnabled(true)` re-enables a body that was
		// disabled elsewhere. Rapier's setEnabled is itself idempotent.
		this.playerEnabled = enabled;
		if (this.playerBody && typeof this.playerBody.setEnabled === 'function') {
			this.playerBody.setEnabled(enabled);
		}
	}

	/** True when the player is active (physics running, update loop running). */
	isPlayerEnabled(): boolean {
		return this.playerEnabled;
	}

	/**
	 * Enable/disable the player capsule's collider(s) without freezing the body or the update loop.
	 * Disabled while driving so the full-size passenger capsule can't collide with the vehicle it's synced onto.
	 */
	setCapsuleCollidersEnabled(enabled: boolean): void {
		if (!this.playerBody) return;
		const n = this.playerBody.numColliders();
		for (let i = 0; i < n; i++) {
			this.playerBody.collider(i).setEnabled(enabled);
		}
	}

	/**
	 * Enable/disable the player capsule's rigid BODY as a whole. While seated in
	 * a vehicle the capsule must not exist for the physics world at all:
	 * disabling only the COLLIDERS is not enough — a kinematic body parked
	 * overlapping the chassis still gets the vehicle positionally pushed out of
	 * its passenger during stepping (the chassis ratchets upward a little every
	 * step with its velocity zeroed, ending as a hovering, undrivable kart with
	 * its wheels off the ground; verified: fully disabling the body restores
	 * normal fall/contact/drive). Reads and writes (translation, velocity) still
	 * work on a disabled body, so exit/respawn teleports are unaffected.
	 */
	setCapsuleBodyEnabled(enabled: boolean): void {
		if (this.playerBody && typeof this.playerBody.setEnabled === 'function') {
			this.playerBody.setEnabled(enabled);
		}
	}

	/** Enable/disable the death ragdoll (cleared + character restored on respawn). Off by default. */
	setRagdollOnDeath(enabled: boolean): void {
		this.healthComp.getDamageableConfig().ragdollOnDeath = enabled;
	}

	/** Lazily build the RagdollComponent (block renderer / engine aren't ready at field-init time). */
	private ensureRagdollComponent(): RagdollComponent {
		if (this.ragdollComp) return this.ragdollComp;
		const combat = this.engine?.getGameData?.()?.worldProfileData?.combatConfig;
		this.ragdollComp = new RagdollComponent(
			// corpseLifetimeMs 0 → the corpse persists until respawn disposes it.
			{
				...DEFAULT_RAGDOLL_CONFIG,
				corpseLifetimeMs: 0,
				jointLimits: combat?.ragdollJointLimits ?? DEFAULT_RAGDOLL_CONFIG.jointLimits,
				selfCollision: combat?.ragdollSelfCollision ?? DEFAULT_RAGDOLL_CONFIG.selfCollision,
				onBodyCreated: null,
			},
			{
				// engine is set in the constructor; the ragdoll() guard handles a null.
				getEngine: () => this.engine!,
				getPhysicsWorld: () => this.physicsWorld,
				getCharacter: () => this.player,
				getPhysicsBody: () => this.playerBody,
				restoreFlashImmediately: () => this.healthComp.restoreFlashImmediately(),
				collectParts: () => {
					const renderer = this.playerLoader?.getBlockCharacterRenderer();
					if (!renderer) return [];
					renderer.getRoot().updateMatrixWorld(true);
					return buildHumanoidRagdollParts((name) => renderer.getBodyPart(name));
				},
				onPostRagdoll: () => {
					// Player death is temporary — HIDE (don't remove) the live character so respawn can restore it.
					this.setLiveCharacterVisible(false);
				},
			},
		);
		return this.ragdollComp;
	}

	/**
	 * Collapse the player into a ragdoll on death (wired to healthComp.onRagdoll). Freezes input +
	 * capsule; the template's onPlayerDeath still fires via onDeathEffect for respawn UI.
	 */
	private triggerPlayerRagdoll(deathImpulse?: THREE.Vector3): void {
		const ragdoll = this.ensureRagdollComponent();
		if (ragdoll.hasRagdoll()) return;
		ragdoll.ragdoll(deathImpulse);
		// Only freeze the player if the ragdoll actually built (else leave normal death handling).
		if (ragdoll.hasRagdoll()) {
			this.setCapsuleCollidersEnabled(false);
			this.setPlayerEnabled(false);
		}
	}

	/**
	 * Clear an active death ragdoll and restore the live character + capsule.
	 * Called from respawnAtStart(). No-op if not ragdolling.
	 */
	private restoreFromRagdoll(): void {
		const ragdoll = this.ragdollComp;
		if (!ragdoll?.hasRagdoll()) return;
		ragdoll.dispose(this.physicsWorld);
		this.setLiveCharacterVisible(true);
		this.setCapsuleCollidersEnabled(true);
		this.setPlayerEnabled(true);
		this.healthComp.resetHealth();
	}

	/** Show or hide the live (non-ragdoll) character: block-render root + skeleton root. */
	private setLiveCharacterVisible(visible: boolean): void {
		const blockRoot = this.playerLoader?.getBlockCharacterRenderer()?.getRoot();
		if (blockRoot) blockRoot.visible = visible;
		if (this.player) this.player.visible = visible;
	}

	/**
	 * Enter a TEMPORARY (non-death) ragdoll — e.g. a ski crash bail. Unlike the death
	 * path, the player stays ENABLED so the active movement system keeps updating: it is
	 * responsible for following the tumbling body (getTemporaryRagdollState) and standing
	 * back up (exitTemporaryRagdoll). Returns false when no ragdoll could be built
	 * (no block character renderer) so callers can fall back to simpler crash handling.
	 */
	enterTemporaryRagdoll(hubVelocity?: THREE.Vector3): boolean {
		const ragdoll = this.ensureRagdollComponent();
		if (ragdoll.hasRagdoll()) return true;
		ragdoll.ragdoll(hubVelocity);
		if (!ragdoll.hasRagdoll()) return false;
		this.setCapsuleCollidersEnabled(false);
		return true;
	}

	/** Hub (torso) state of an active ragdoll, or null when not ragdolling. */
	getTemporaryRagdollState(): { position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number }; speed: number } | null {
		return this.ragdollComp?.getHubState() ?? null;
	}

	/**
	 * End a temporary ragdoll: tear down the articulated body, restore the live character
	 * and capsule colliders, and return the hub's final world position (where the
	 * character should stand up). Null if no ragdoll was active. Does NOT touch health.
	 */
	exitTemporaryRagdoll(): { x: number; y: number; z: number } | null {
		const ragdoll = this.ragdollComp;
		if (!ragdoll?.hasRagdoll()) return null;
		const restPos = ragdoll.getHubState()?.position ?? null;
		ragdoll.dispose(this.physicsWorld);
		this.setLiveCharacterVisible(true);
		this.setCapsuleCollidersEnabled(true);
		return restPos;
	}

	/**
	 * Update player visibility based on current movement system
	 */
	private updatePlayerVisibility(): void {
		// Translate this controller's state into hide reasons on PlayerVisibility.
		// The visibility owner composes the reasons (+ contributions from
		// CameraManager etc.) and toggles the character root. Manual force-show
		// / force-hide is now done by the caller directly via
		// `engine.getPlayerVisibility().setManualOverride(...)` — this method
		// does not own that channel.
		const vis = this.engine?.getPlayerVisibility();
		if (!vis) return;

		const hasStarted = getGameStateManager()?.hasStarted() ?? true;
		vis.setHideReason('not-started', !hasStarted);
		vis.setHideReason('movement-system', !this.movementSystem.shouldShowPlayer());
	}

	/**
	 * Get the current movement system
	 */
	getMovementSystem(): IPlayerMovement {
		return this.movementSystem;
	}

	/**
	 * Force the player to keep facing a fixed yaw (radians, gameplay +Z-forward),
	 * or pass null to release. While locked the player still moves/strafes but
	 * never rotates from movement input or camera-lock. Applies the yaw to the
	 * movement system (which enforces it each frame) and to the visual immediately
	 * so the lock takes effect even on a frame where the movement update is skipped.
	 */
	// ── Posture ─────────────────────────────────────────────────────────

	private readonly postureState = new PlayerPosture();
	private readonly postureActions = new PostureActions();
	/**
	 * While a hang or a mantle/vault owns the capsule the movement motor must
	 * not write to it — gravity would drop the hang in two frames and the
	 * motor's per-frame translation would fight the root-motion placement.
	 */
	private bodyHeldByPosture = false;

	private postureActionHost(): PostureActionHost {
		return buildPostureActionHost(this, {
			body: this.playerBody, physicsWorld: this.physicsWorld, animationController: this.animationController,
			loader: this.playerLoader, movementSystem: this.movementSystem, yaw: this.player.rotation.y,
			setPosture: (p) => this.setPosture(p as Posture), getPosture: () => this.postureState.current,
			setHeld: (held) => { this.bodyHeldByPosture = held; },
		});
	}

	/** Cover peek: rise over low cover (true) / drop back (false). RangedWeaponSystem drives it from aim state. */
	setCoverPeek(peek: boolean): void { this.postureActions.setCoverPeek(peek, this.postureActionHost()); }
	/** Grab the ledge ahead and hang, if there is one within reach. */
	tryGrabLedge(): boolean { return this.postureActions.tryGrabLedge(this.postureActionHost()); }
	/** Mantle up onto the ledge ahead (from a hang or from the ground). */
	mantle(): boolean { return this.postureActions.mantle(this.postureActionHost()); }
	/** Vault the low, thin obstacle ahead, if there is one. */
	vault(): boolean { return this.postureActions.vault(this.postureActionHost()); }
	/** Recover to standing from a supine/sleep posture (knockdown recovery). */
	getUp(): boolean { return this.postureActions.getUp(this.postureActionHost()); }
	/** Knee slide one-shot. */
	slide(): boolean { return this.postureActions.slide(this.postureActionHost()); }

	/**
	 * Enter a body posture: crouch, prone (crawl), sit, kneel, climb, or back
	 * to 'stand'. Swaps the animation set (loaded on demand — until the clips
	 * arrive the standing ones play), shrinks the physics capsule so the
	 * character fits where the posture should, and scales move speed. Standing
	 * up needs headroom and is refused (returns false) under a low ceiling.
	 * 'swim' is applied automatically when a SwimmingMovement is attached.
	 * See PlayerPosture for the mechanics.
	 */
	setPosture(posture: Posture): boolean {
		if (this.postureState.current === 'cover' && posture !== 'cover') {
			this.postureActions.onLeaveCover();
		}
		return this.postureState.set(posture, {
			body: this.playerBody,
			loader: this.playerLoader,
			physicsWorld: this.physicsWorld,
			movementSystem: this.movementSystem,
			animationController: this.animationController,
		});
	}

	getPosture(): Posture { return this.postureState.current; }

	setFacingLock(yaw: number | null): void {
		this.movementSystem.setFacingLock?.(yaw);
		if (yaw !== null) this.player.rotation.y = yaw;
	}

	/**
	 * Check if the current movement system handles player position syncing.
	 * When true, templates should NOT run their own syncPlayerPhysics().
	 */
	handlesPlayerPositionSync(): boolean {
		return this.movementSystem.handlesPlayerPositionSync?.() ?? false;
	}

	/**
	 * Get the current rotation angle from the movement system
	 */
	get rotation(): number {
		return this.movementSystem.getRotation();
	}

	/**
	 * Toggle gravity on/off for this player
	 */
	toggleGravity(): void {
		// Access gravity through the movement system
		if (this.movementSystem instanceof WalkingAndJumpingMovement) {
			const config = this.movementSystem.getPhysicsConfig();
			if (config.gravity === 0) {
				config.gravity = -35.0;
				console.log('PlayerController: Gravity ON');
			} else {
				config.gravity = 0;
				console.log('PlayerController: Gravity OFF');
			}
			this.movementSystem.setPhysicsConfig(config);
		}
	}

	/**
	 * Get current gravity state
	 */
	getGravityEnabled(): boolean {
		if (this.movementSystem instanceof WalkingAndJumpingMovement) {
			return this.movementSystem.getPhysicsConfig().gravity !== 0;
		}
		return true;
	}

	/**
	 * Root of the visible character. In block-character mode this is the block
	 * renderer's root; in skinned mode (block character hidden, only a pose
	 * source) or when no block character exists, it's the glTF/skeleton root.
	 */
	private getVisibleRoot(): THREE.Object3D {
		if (this.playerLoader && !this.playerLoader.isRenderingSkinnedMesh()) {
			const blockRoot = this.playerLoader.getBlockCharacterRenderer()?.getRoot();
			if (blockRoot) return blockRoot;
		}
		return this.player;
	}

	/**
	 * Traverse the visible character meshes (blocks or original mesh)
	 *
	 * IMPORTANT: Use this method instead of player.traverse() when you want to modify
	 * the visible character appearance. The player object may be a hidden skeleton
	 * used only for animation, while the actual visible character is rendered separately.
	 *
	 * @param callback - Function to call for each object in the visible character hierarchy
	 *
	 * For RECOLORING, prefer tintBodyPart on the block character renderer — it
	 * clones materials safely instead of mutating them in place:
	 *
	 * @example
	 * // Recolor the head (preferred)
	 * playerController.playerLoader?.getBlockCharacterRenderer()?.tintBodyPart('head', 0xff0000);
	 *
	 * @example
	 * // Traverse the visible character meshes directly
	 * playerController.traverseVisibleCharacter((child) => {
	 *   const mesh = child as THREE.Mesh;
	 *   if (mesh.isMesh) mesh.visible = false;
	 * });
	 */
	traverseVisibleCharacter(callback: (child: THREE.Object3D) => void): void {
		this.getVisibleRoot().traverse(callback);
	}

	/**
	 * Get all visible meshes of the character
	 *
	 * This returns the meshes that are actually rendered on screen, not the hidden skeleton.
	 *
	 * @returns Array of visible character meshes
	 *
	 * @example
	 * // Apply bloom effect to all character meshes
	 * const meshes = playerController.getVisibleMeshes();
	 * meshes.forEach(mesh => {
	 *   mesh.layers.enable(BLOOM_LAYER);
	 * });
	 */
	getVisibleMeshes(): THREE.Mesh[] {
		const meshes: THREE.Mesh[] = [];
		this.traverseVisibleCharacter((child) => {
			if ((child as THREE.Mesh).isMesh) {
				meshes.push(child as THREE.Mesh);
			}
		});
		return meshes;
	}

	/**
	 * Get the root of the visible character
	 *
	 * Use this when you need to add accessories, particle effects, or other objects
	 * that should be attached to the visible character (not the hidden skeleton).
	 *
	 * @returns The root THREE.Object3D of the visible character
	 *
	 * @example
	 * // Attach a hat to the visible character
	 * const hat = new THREE.Mesh(hatGeometry, hatMaterial);
	 * const characterRoot = playerController.getVisibleCharacterRoot();
	 * characterRoot.add(hat);
	 */
	getVisibleCharacterRoot(): THREE.Object3D {
		return this.getVisibleRoot();
	}

	/**
	 * Get the animation skeleton (advanced use only)
	 *
	 * This returns the object that drives animations. In most cases, you should use
	 * getVisibleCharacterRoot() instead. Only use this if you need direct bone access.
	 *
	 * Note: The skeleton may be hidden (invisible) if block characters are enabled.
	 *
	 * @returns The skeleton object used for animations
	 */
	getSkeleton(): THREE.Object3D {
		return this.player;
	}

	/**
	 * Attach an object to a specific body part (hand, head, foot, etc.)
	 *
	 * This is the easiest way to attach accessories, weapons, hats, or any objects
	 * to the character. The object will automatically follow the body part during animations.
	 *
	 * ⚠️ TIMING: This method should only be called after the character is fully loaded.
	 * - In constructor: Use onCharacterReady callback
	 * - After construction: Safe to call directly
	 *
	 * 🔧 ROTATION CORRECTION:
	 * - The method applies default rotation corrections for proper orientation
	 * - For hands: Objects are rotated to be held naturally (e.g., swords point upward)
	 * - You can override defaults by setting rotation AFTER attachment, or pass custom rotation
	 * - Use the rotation parameter to provide custom orientation if defaults don't work
	 *
	 * @param object - The THREE.Object3D to attach
	 * @param bodyPartName - Name of body part: 'head', 'leftHand', 'rightHand', 'leftFoot', 'rightFoot',
	 *                       'torso', 'neck', 'leftUpperArm', 'leftForearm', 'rightUpperArm', 'rightForearm',
	 *                       'leftThigh', 'leftShin', 'rightThigh', 'rightShin'
	 * @param rotation - Optional rotation correction (degrees). Can be:
	 *                   - THREE.Vector3 with x, y, z rotation in degrees
	 *                   - Object with x, y, z properties in degrees
	 *                   - If null, applies sensible defaults for hands (90° rotation to hold items upright)
	 * @returns true if attachment was successful, false if body part not found
	 */
	attachToBodyPart(object: THREE.Object3D, bodyPartName: string, rotation?: THREE.Vector3 | { x: number; y: number; z: number } | null): boolean {
		const bodyPart = this.getBodyPartObject(bodyPartName);
		if (!bodyPart) {
			// Headless players (world.json `hasPlayerCharacter: false` — first-person,
			// vehicle, board games) have no body parts by design and never will —
			// parent to the player group at an approximate hand/head offset so
			// weapons and tools still function (melee swings, held items) instead
			// of failing every equip with retries.
			if (this.playerLoader?.isHeadlessPlayer?.()) {
				object.userData = object.userData ?? {};
				object.userData.isUserAttached = true;
				object.userData.attachedToBodyPart = bodyPartName;
				this.attachedBodyParts.add(bodyPartName);
				const side = bodyPartName.toLowerCase().startsWith('left') ? -1 : 1;
				const height = bodyPartName === 'head' ? 1.5 : 1.0;
				this.player.add(object);
				object.position.set(0.3 * side, height, 0.35);
				console.log(`PlayerController: headless player — attached '${bodyPartName}' object to the player group at a fixed offset`);
				return true;
			}
			console.warn(`PlayerController: Cannot attach to '${bodyPartName}' - body part not found`);
			return false;
		}

		// Mark this object as user-attached so we can distinguish it from block character parts
		if (!object.userData) {
			object.userData = {};
		}
		object.userData.isUserAttached = true;
		object.userData.attachedToBodyPart = bodyPartName;

		// Track that this body part has an attached object
		this.attachedBodyParts.add(bodyPartName);

		bodyPart.add(object);

		// Preserve the object's intended world-space size. Skinned-mode bones
		// live inside a GLB hierarchy that was scaled to the character's target
		// height, so a parented object would inherit that scale; block-character
		// parts are world-scale ~1, making this a no-op there. The original
		// local scale is stashed so detachFromBodyPart can restore it.
		const bodyPartWorldScale = bodyPart.getWorldScale(new THREE.Vector3());
		if (bodyPartWorldScale.x > 0 && bodyPartWorldScale.y > 0 && bodyPartWorldScale.z > 0) {
			object.userData.preAttachScale = object.scale.clone();
			object.scale.set(
				object.scale.x / bodyPartWorldScale.x,
				object.scale.y / bodyPartWorldScale.y,
				object.scale.z / bodyPartWorldScale.z,
			);
		}

		const applyRotationDegrees = (rot: { x: number; y: number; z: number }): void => {
			object.rotation.set(
				THREE.MathUtils.degToRad(rot.x),
				THREE.MathUtils.degToRad(rot.y),
				THREE.MathUtils.degToRad(rot.z),
			);
		};

		// Apply rotation correction: an explicit `rotation` wins (null disables the
		// defaults), otherwise fall back to this body part's default correction.
		const useDefault = rotation === undefined;
		const correction = useDefault ? this.getDefaultAttachmentRotation(bodyPartName) : rotation;
		if (correction) {
			applyRotationDegrees(correction);
			const kind = useDefault ? 'default rotation correction' : 'custom rotation';
			console.log(`PlayerController: Attached object to '${bodyPartName}' with ${kind} (${correction.x}°, ${correction.y}°, ${correction.z}°)`);
		} else {
			console.log(`PlayerController: Attached object to '${bodyPartName}' with no rotation correction`);
		}

		return true;
	}

	/**
	 * Get default rotation correction for attaching objects to body parts
	 *
	 * These defaults are calibrated for Mixamo skeletons to make held items
	 * appear in natural orientations (e.g., swords pointing upward in hand)
	 *
	 * @param bodyPartName - Name of the body part
	 * @returns Rotation in degrees {x, y, z}, or null if no default correction needed
	 * @private
	 */
	private getDefaultAttachmentRotation(bodyPartName: string): { x: number; y: number; z: number } | null {
		return PlayerController.DEFAULT_ATTACHMENT_ROTATIONS[bodyPartName] || null;
	}

	/**
	 * Default rotations (degrees) for Mixamo skeleton bones — these make held items
	 * appear naturally oriented. Body parts not listed (head, feet, torso, etc.)
	 * don't need a correction: their local coordinate systems are already intuitive.
	 */
	private static readonly DEFAULT_ATTACHMENT_ROTATIONS: Record<string, { x: number; y: number; z: number }> = {
		// Hands: Rotate +90° on X to point items upward (for swords, tools, etc.)
		'rightHand': { x: 90, y: 0, z: 0 },
		'leftHand': { x: 90, y: 0, z: 0 },

		// Forearms: Slightly rotated for natural tool holding
		'rightForearm': { x: 45, y: 0, z: 0 },
		'leftForearm': { x: 45, y: 0, z: 0 },
	};

	/**
	 * Detach an object from the character
	 *
	 * Removes the object from its parent body part and returns it to the scene.
	 * You can then dispose of it or move it elsewhere.
	 *
	 * @param object - The THREE.Object3D to detach
	 *
	 * @example
	 * playerController.detachFromBodyPart(sword);
	 * scene.remove(sword); // Remove from scene entirely
	 */
	detachFromBodyPart(object: THREE.Object3D): void {
		if (object.parent) {
			// Get the body part name from the object's userData if available
			const bodyPartName = object.userData?.attachedToBodyPart;
			if (bodyPartName) {
				// Check if this was the last object attached to this body part
				const bodyPart = this.getBodyPartObject(bodyPartName);
				if (bodyPart) {
					const hasOtherUserAttached = Array.from(bodyPart.children).some(child => 
						child !== object && child.userData?.isUserAttached === true
					);
					if (!hasOtherUserAttached) {
						// No other user-attached objects, remove from tracking
						this.attachedBodyParts.delete(bodyPartName);
					}
				}
			}
			
			object.parent.remove(object);

			// Undo the scale normalization applied at attach time so the object
			// keeps its original size back in the scene.
			const preAttachScale = object.userData?.preAttachScale as THREE.Vector3 | undefined;
			if (preAttachScale) {
				object.scale.copy(preAttachScale);
				delete object.userData.preAttachScale;
			}

			console.log('PlayerController: Object detached from body part');
		}
	}

	/**
	 * Get the THREE.Object3D for a specific body part
	 *
	 * Use this for advanced manipulation like getting the world position of a body part,
	 * or for attaching multiple objects. For simple attachment, use attachToBodyPart() instead.
	 *
	 * @param bodyPartName - Name of body part to get
	 * @returns The THREE.Object3D for the body part, or null if not found
	 *
	 * @example
	 * // Get hand position for spawning projectiles
	 * const hand = playerController.getBodyPartObject('rightHand');
	 * if (hand) {
	 *   const handPos = new THREE.Vector3();
	 *   hand.getWorldPosition(handPos);
	 *   spawnProjectile(handPos);
	 * }
	 */
	getBodyPartObject(bodyPartName: string): THREE.Object3D | null {
		// Try block character first (if available). In skinned-render mode the
		// block character still exists but is hidden and never updated — it is
		// only the pose source — so attachments must go to the real skeleton
		// bones instead (the fallback below).
		if (this.playerLoader && !this.playerLoader.isRenderingSkinnedMesh()) {
			const blockRenderer = this.playerLoader.getBlockCharacterRenderer();
			if (blockRenderer) {
				const blockRoot = blockRenderer.getRoot();

				// Find body part group in block character
				let bodyPart: THREE.Object3D | null = null;
				blockRoot.traverse((child: THREE.Object3D) => {
					if (child.name === bodyPartName) {
						bodyPart = child;
					}
				});

				if (bodyPart) {
					return bodyPart;
				}
			}
		}

		// Fallback: find the bone in the real character skeleton. Search inside
		// the skinned skeleton root when available — the player group also holds
		// invisible full-skeleton clones with identical bone names (action
		// layer, Mixamo track skeletons), and a group-wide search can land on
		// one of those, making attached objects invisible.
		const possibleBoneNames = this.mapBodyPartNameToBoneNames(bodyPartName);
		if (possibleBoneNames.length === 0) {
			console.warn(`PlayerController: Unknown body part '${bodyPartName}'`);
			return null;
		}

		const searchRoot = this.playerLoader?.getSkinnedSkeletonRoot() ?? this.player;
		const bone = findBoneByCandidates(searchRoot, possibleBoneNames);

		if (!bone) {
			console.warn(`PlayerController: No bone found for body part '${bodyPartName}' (tried: ${possibleBoneNames.join(', ')})`);
		}

		return bone;
	}

	/**
	 * Check if an object is attached to either hand
	 *
	 * @returns true if an object is attached to leftHand or rightHand, false otherwise
	 */
	hasObjectAttachedToHand(): boolean {
		return this.attachedBodyParts.has('leftHand') || this.attachedBodyParts.has('rightHand');
	}

	/**
	 * Map friendly body part names to skeleton bone names. Canonical name list
	 * lives in `engine/SkeletonAliases.ts` so all callers share one source of
	 * truth across rig conventions (Mixamo, Unreal Manny, simple).
	 * @private
	 */
	private mapBodyPartNameToBoneNames(bodyPartName: string): string[] {
		return CANONICAL_BONE_NAMES[bodyPartName] ?? [];
	}

	/**
	 * Re-ground the character after height changes by adjusting physics body position
	 */
	regroundCharacter(newHeight: number): void {
		if (!this.playerBody || !this.physicsWorld) {
			console.warn('Cannot reground character: missing physics body or world');
			return;
		}

		// CRITICAL: If terrain colliders aren't ready, skip regrounding entirely
		// Attempting to raycast or query height before colliders are active will fail
		// and result in incorrect positioning (player falls through ground)
		const dynamicObjMgr = this.engine?.getDynamicObjectManager?.();
		if (dynamicObjMgr && !dynamicObjMgr.areTerrainCollidersReady()) {
			return;
		}

		// Get current physics body position
		const currentPos = this.playerBody.translation();

		// Calculate the new Y position based on the new height
		// The physics body center should be at newHeight/2 above the ground
		// We need to find the ground level first
		// IMPORTANT: Filter by ENVIRONMENT to only hit terrain/buildings, not NPCs/animals
		const rayOrigin = new THREE.Vector3(currentPos.x, currentPos.y, currentPos.z);
		const rayDirection = new THREE.Vector3(0, -1, 0);
		const result = this.physicsWorld.raycast(rayOrigin, rayDirection, 10, CollisionGroup.TERRAIN | CollisionGroup.ENVIRONMENT);

		let groundY: number | null = result.hasHit ? result.hitPoint.y : null;

		// Fallback: if raycast failed, try getWorldHeightAt
		if (groundY === null && this.engine?.getWorldHeightAt) {
			groundY = this.engine.getWorldHeightAt(currentPos.x, currentPos.z);
		}
		
		// Last resort: use current position minus old half-height as ground estimate
		if (groundY === null || groundY === 0) {
			// Assume current capsule bottom is at ground (if groundY is 0, likely a bad raycast result)
			groundY = currentPos.y - this.getCapsuleHeight() / 2;
		}

		// Position the physics body so its bottom is at ground level
		const newPhysicsY = groundY + newHeight / 2;

		// Update the physics body position
		this.playerBody.setTranslation({ x: currentPos.x, y: newPhysicsY, z: currentPos.z }, true);

		// Clear vertical velocity to prevent bouncing
		const velocity = this.playerBody.linvel();
		this.playerBody.setLinvel({ x: velocity.x, y: 0, z: velocity.z }, true);

		// Wake up the body
		this.playerBody.wakeUp();
	}

	private _waitingForColliders: boolean = true;
	private _savedSpawnPosition: { x: number; y: number; z: number } | null = null;
	private _originalGravityScale: number = 1;
	private _respawnHoldFrames: number = 0;

	/**
	 * Apply mobile input to analog movement fields and camera deltas.
	 * Subclasses should call super.update() which calls this — do NOT call it directly.
	 * Kept protected so genre controllers can override if they need to pre/post-process.
	 */
	protected applyMobileInput(_deltaTime: number): void {
		if (this.mobileControls.isEnabled()) {
			this.useAnalogMovement = true;
			this.analogMoveX = this.mobileControls.moveX;
			this.analogMoveY = this.mobileControls.moveY;

			// NOTE: Jump/ascend is handled by the engine's applyMobileControlsToKeys()
			// inside super.update(). Do NOT handle it here — super.update() overwrites
			// this.keys from desktop controls before applyMobileControlsToKeys() runs,
			// which would erase any keys.ascend set here.

			const cameraLike = this.cameraController as unknown as CameraControllerLike;
			if (this.cameraController && cameraLike.applyExternalDelta) {
				cameraLike.applyExternalDelta(
					this.mobileControls.cameraDeltaX,
					this.mobileControls.cameraDeltaY,
				);
			}

			if (this.cameraController && cameraLike.setAutoFollow) {
				const autoFollowEnabled = this.mobileControls.getAutoFollowEnabled();
				const isManualControl = this.mobileControls.isManualCameraControl;
				const isMovingBackward = this.analogMoveY < -0.1;

				if (autoFollowEnabled && !isManualControl && !isMovingBackward) {
					cameraLike.setAutoFollow(true, this.mobileControls.getAutoFollowSpeed());
					const playerForward = new THREE.Vector3();
					this.player.getWorldDirection(playerForward);
					playerForward.y = 0;
					playerForward.normalize();
					cameraLike.setTargetForwardDirection?.(playerForward);
				} else {
					cameraLike.setAutoFollow(false);
				}
			}

			this.mobileControls.update();
		} else {
			this.useAnalogMovement = false;
		}
	}

	update(deltaTime: number): void {
		if (!this.playerBody) return;

		// Detect playerBody swaps (BitmagicPlayerCharacter / DonaldDuck /
		// PlayerLoader.recreatePhysicsBody) and refresh userData + the
		// PathConflictAvoidance registration accordingly. Cheap one-frame
		// handle compare; only does work on actual swaps.
		this.syncPlayerBodyRegistration();

		// Apply suppression up front so transition windows (teleport, visibility
		// override, _waitingForColliders hold) still see a clean false even
		// on frames where the full input-merge flow never executes.
		this.applyActionSuppression();

		// Drain mobile input deltas every frame BEFORE the playerEnabled
		// early-return: joystick / camera deltas accumulate in MobileControls
		// until consumed, so if the player is disabled (board game, cutscene)
		// for N frames, skipping the drain would cause a single giant camera
		// snap when the player is re-enabled.
		this.applyMobileInput(deltaTime);

		// Drive the death ragdoll before the playerEnabled gate — a ragdolling player is disabled,
		// but its limbs must keep tracking their bodies until respawn.
		if (this.ragdollComp?.hasRagdoll()) {
			this.ragdollComp.syncRagdoll();
		}

		if (!this.playerEnabled) return;

		// CRITICAL: Wait for terrain colliders to be ready before allowing physics
		// This prevents falling through ground during initial load or after respawn.
		// We hold the player frozen at the spawn position for a minimum number of frames
		// to let the camera move, frustum culling update, and terrain colliders activate.
		if (this._waitingForColliders) {
			// On first frame waiting, disable gravity and save CURRENT position (set by PlayerLoader)
			if (!this._savedSpawnPosition) {
				const physPos = this.playerBody.translation();
				const feetY = physPos.y - this.getCapsuleHeight() / 2;
				this._savedSpawnPosition = { x: physPos.x, y: feetY, z: physPos.z };
				this._originalGravityScale = this.playerBody.gravityScale();
				this._respawnHoldFrames = 0;
			}
			
			// Count frames we've been holding
			this._respawnHoldFrames++;
			
			// Force player body to stay at spawn position every frame (belt AND suspenders)
			const spawn = this._savedSpawnPosition;
			this.placeCapsuleAtFeet(spawn.x, spawn.y, spawn.z);
			this.playerBody.setGravityScale(0, true);
			this.player.position.set(spawn.x, spawn.y, spawn.z);

			// Force camera to look at spawn position every frame during hold.
			// Without this, the ThirdPersonCamera smoothly interpolates from the old
			// (fallen) position and never catches up during the hold period.
			const cam = this.cameraController as unknown as { anchor?: THREE.Vector3 } | null;
			if (cam?.anchor) {
				cam.anchor.set(spawn.x, spawn.y, spawn.z);
			}
			
			// Hold for enough frames to let the pipeline catch up:
			// camera snap → visibility culling → chunk activation → physics colliders
			const MIN_HOLD_FRAMES = 5;
			if (this._respawnHoldFrames >= MIN_HOLD_FRAMES) {
				// Release player — re-enable collider
				this._waitingForColliders = false;
				this._savedSpawnPosition = null;
				this.playerBody.setGravityScale(this._originalGravityScale, true);
				this.setCapsuleCollidersEnabled(true);
				console.log(`[PlayerController] Released after ${this._respawnHoldFrames} frames`);
			} else {
				return; // Skip movement/fall-check updates, but template still runs camera + visibility
			}
		}
		
		// Voxel-grid floor safety net: rescue the player if it has sunk into the terrain (e.g. it
		// slipped a trimesh seam between two chunk colliders) BEFORE it can fall to the kill plane.
		this.applyVoxelFloorSafetyNet();

		// Check if the player has fallen out of the world and rescue them if needed.
		// When in a vehicle, check the vehicle's position instead of player position
		let checkY = this.player.position.y;
		const fallenVehicle = this.vehicleControllerHelper.isPlayerInVehicle()
			? this.vehicleControllerHelper.getVehicleManager()?.getActiveVehicle() ?? null
			: null;
		if (fallenVehicle) {
			checkY = fallenVehicle.getPosition().y;
		}

		if (checkY < this.fallRescue.killPlaneY) {
			this.rescueAfterFall(fallenVehicle);
			return;
		}

		// Read desktop keys BEFORE vehicle check so keys are available in both modes
		// Check desktop controls for key states (only when desktop is active)
		if (this.desktopControls.isEnabled()) {
			// Update desktop controls to compute movement values
			this.desktopControls.update();

			// getKeyStates() returns exactly the built-in key slots, so this
			// overwrites each of them (including clearing released keys) and
			// leaves custom action keys alone.
			const desktopKeys = this.desktopControls.getKeyStates();
			Object.assign(this.keys, desktopKeys);

			// Track input source: if any desktop key is active, mark keyboard
			if (Object.values(desktopKeys).some(Boolean)) {
				this.lastActiveInput = 'keyboard';
			}
		} else {
			// Desktop's assignment above is the canonical "release-clears-to-false"
			// path for digital keys. When desktop input is disabled (mobile-runtime
			// devices), the OR-merges from gamepad/mobile below would otherwise leak
			// stale `true` values across frames — e.g. ascend stuck true after one
			// tap because mobile's tap-button only sets true on press and re-asserts
			// true on release for one frame, never false. The downstream symptom is
			// canJump never re-arming (WalkingAndJumpingMovement gates on `!ascend`)
			// and the animation controller thrashing the JUMP state every frame.
			this.clearBuiltInKeys();
			// Custom (registered) action keys are deliberately left alone here —
			// applyMobileControlsToKeys() owns their release, on every platform.
		}

		// Merge gamepad input (OR with desktop keys so both work simultaneously)
		if (this.gamepadControls.isEnabled()) {
			this.gamepadControls.update();

			// Left stick -> analog movement AND digital keys (like mobile joystick)
			const gpMoveX = this.gamepadControls.moveX;
			const gpMoveY = this.gamepadControls.moveY;
			const hasAnalogInput = Math.abs(gpMoveX) > 0 || Math.abs(gpMoveY) > 0;

			if (hasAnalogInput) {
				this.analogMoveX = gpMoveX;
				this.analogMoveY = gpMoveY;
				this.useAnalogMovement = true;

				// Also set digital keys from stick so all systems see movement input
				const threshold = 0.1;
				if (gpMoveY > threshold) this.keys.forward = true;
				if (gpMoveY < -threshold) this.keys.backward = true;
				if (gpMoveX > threshold) this.keys.right = true;
				if (gpMoveX < -threshold) this.keys.left = true;
			} else if (this.useAnalogMovement && !this.mobileControls.isEnabled()) {
				this.analogMoveX = 0;
				this.analogMoveY = 0;
				this.useAnalogMovement = false;
			}

			// OR-merge button states with desktop keys
			if (this.gamepadControls.ascendPressed) this.keys.ascend = true;
			if (this.gamepadControls.descendPressed) this.keys.descend = true;
			if (this.gamepadControls.interactPressed) this.keys.interact = true;
			if (this.gamepadControls.actionPressed) this.keys.action = true;
			if (this.gamepadControls.secondaryActionPressed) this.keys.secondaryAction = true;
			if (this.gamepadControls.exitPressed) this.keys.interact = true;

			// Right stick -> camera look (bypass camera's shouldProcessInput so gamepad
			// camera works without pointer lock; we still respect PlayerController-level gates)
			const gpCamX = this.gamepadControls.cameraX;
			const gpCamY = this.gamepadControls.cameraY;
			if (this.cameraController && (Math.abs(gpCamX) > 0 || Math.abs(gpCamY) > 0)) {
				const cam = this.cameraController as unknown as {
					targetSpherical?: { theta: number; phi: number };
					applyExternalDelta?: (deltaX: number, deltaY: number) => void;
				};
				const spherical = cam.targetSpherical;
				if (spherical) {
					spherical.theta -= gpCamX * deltaTime;
					spherical.phi -= gpCamY * deltaTime;
					spherical.phi = Math.max(0.1, Math.min(Math.PI - 0.1, spherical.phi));
				} else if (typeof cam.applyExternalDelta === 'function') {
					cam.applyExternalDelta(gpCamX * deltaTime, gpCamY * deltaTime);
				}
			}

			// Track input source
			if (this.gamepadControls.hadInputThisFrame) {
				this.lastActiveInput = 'gamepad';
			}

			// Reset one-shot button states after reading
			this.gamepadControls.resetAscendPressed();
			this.gamepadControls.resetInteractPressed();
			this.gamepadControls.resetExitPressed();
		}

		// Merge experimental lid-sensor input (localhost only). It emits an
		// alternating moveX as the lid is rocked; OR it into left/right like the
		// gamepad stick so the rhythmic-sprint system sees alternating tap edges.
		if (this.lidSensorControls?.isEnabled()) {
			this.lidSensorControls.update();
			const lidX = this.lidSensorControls.moveX;
			const threshold = 0.1;
			if (lidX > threshold) this.keys.right = true;
			if (lidX < -threshold) this.keys.left = true;
		}

		// Apply per-action suppression AFTER all three input sources have
		// merged into this.keys — clears both the merged keys and the
		// per-channel Pressed flags so downstream systems see a clean false.
		this.applyActionSuppression();

		// Handle vehicle updates if player is in vehicle
		if (this.vehicleControllerHelper.isPlayerInVehicle()) {
			// Only show exit prompts if exit is allowed and game is playing
			const gameIsPlaying = getGameStateManager()?.isState(GameState.PLAYING) ?? false;
			if (!this.vehicleExitLocked && gameIsPlaying) {
				this.vehicleControllerHelper.updateInteractionPrompts(
					this.showInteractionPrompt.bind(this),
					this.hideInteractionPrompt.bind(this)
				);

				// Handle E key to exit vehicle
				this.handleInteractEdge(() => this.requestVehicleExit());

				// Check if mobile exit button was pressed
				if (this.vehicleControllerHelper.checkMobileExitPressed()) {
					this.requestVehicleExit();
				}
			}

			// Apply mobile controls joystick to keys (if mobile is enabled)
			// This converts analog joystick input to digital key states for the movement system
			this.applyMobileControlsToKeys();

			// Call movement system for vehicle controls (PlayerDrivingVehicleMovement)
			this.movementSystem.update(
				deltaTime,
				this,
				this.keys,
				false, // isGrounded (not relevant for vehicles)
				new THREE.Vector3(), // moveDirection (not used for vehicles)
				this.playerBody,
				this.physicsWorld
			);

			// Action button processing is handled by applyMobileControlsToKeys() above.
			// Handle action (e.g. shooting) even when in vehicle
			this.processActionInput(this.keys.action);

			// Don't process regular player movement/animation when in vehicle
			return;
		}
		
		// Handle animal riding updates if player is riding an animal
		if (this.animalControllerHelper.isPlayerRiding()) {
			// Update animal camera
			this.animalControllerHelper.update(deltaTime);
			
			// Handle E key to dismount
			this.handleInteractEdge(() => this.animalControllerHelper.handleDismountRequest(
				this.player,
				this.playerBody,
				this.characterHeight,
				this.retargetCamera,
				this
			));

			// Apply mobile controls joystick to keys
			this.applyMobileControlsToKeys();
			
			// Call movement system for animal riding (PlayerRidingAnimalMovement)
			this.movementSystem.update(
				deltaTime,
				this,
				this.keys,
				false,
				new THREE.Vector3(),
				this.playerBody,
				this.physicsWorld
			);
			
			// Don't process regular player movement/animation when riding
			return;
		}

		// Hide exit button when on foot (mobile)
		this.mobileControls.hideExitButton();

		// Update carried objects (CarryableComponent auto-registers with InteractionManager)
		// Use the player character's yaw (not camera) so carried objects stay in front
		// of the character regardless of camera orbit.
		getInteractionManager().updateCarryables(
			deltaTime, this.player.position, this.player.quaternion, this
		);

		// Update interaction prompt based on nearby interactables
		this.interactionController.update();
		this.interactionPromptUI.updateScreenPosition();

		// Apply mobile controls joystick to keys (if mobile is enabled)
		// This converts analog joystick input to digital key states for the movement system
		this.applyMobileControlsToKeys();

		// Calculate movement direction
		this.calculateMoveDirection();

		// Delegate movement to the pluggable movement system
		// Movement system will check grounded state internally
		const savedAscend = this.keys.ascend;
		if (this._jumpInputSuppressed) {
			this.keys.ascend = false;
		}
		// A posture action (ledge hang, mantle, vault) owns the capsule: the
		// motor is skipped so it can neither drop the hang nor fight the
		// root-motion placement. Animation still updates below.
		if (!this.bodyHeldByPosture) this.movementSystem.update(
			deltaTime,
			this,
			this.keys,
			true, // Movement system will determine actual grounded state
			this.moveDirection,
			this.playerBody,
			this.physicsWorld
		);
		this.keys.ascend = savedAscend;

		// Detect a rising edge in the jump count and trigger the flip animation
		// for the second jump. The first jump uses the standard JUMP animation.
		const jumpCount = this.movementSystem.getJumpCount?.() ?? 0;
		if (jumpCount > this.previousJumpCount) {
			this.onJumpTriggered(jumpCount);
		}
		this.previousJumpCount = jumpCount;

		// Update isGrounded based on movement system's ground check
		if (this.movementSystem.wasGroundedLastUpdate) {
			this.isGrounded = this.movementSystem.wasGroundedLastUpdate();
		}

		// Auto-apply terrain friction if world generator implements TerrainFrictionProvider
		if (this.isGrounded && this.worldGenerator?.getTerrainFriction && this.movementSystem.setGroundFriction) {
			this.currentTerrainFriction = this.worldGenerator.getTerrainFriction();
			this.movementSystem.setGroundFriction(this.currentTerrainFriction);
		}

		// Update sliding VFX
		if (this.slidingVFX && this.player) {
			const velocity = this.playerBody.linvel();
			const horizontalVelocity = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);
			const isMovingInput = this.moveDirection.length() > 0;
			const isSliding = this.isGrounded && !isMovingInput && horizontalVelocity > 0.5;

			this.slidingVFX.update(
				deltaTime,
				this.player.position,
				horizontalVelocity,
				this.currentTerrainFriction,
				isSliding
			);
		}

		// Update attack system and check if movement should be blocked
		if (this.attackSystem) {
			const shouldBlockMovement = this.attackSystem.update(deltaTime);
			if (shouldBlockMovement) {
				// Block movement during attack (e.g., melee attack animation)
				this.keys.forward = false;
				this.keys.backward = false;
				this.keys.left = false;
				this.keys.right = false;
				this.keys.ascend = false;
			}
		}

		// Mobile button processing is now in applyMobileControlsToKeys() above,
		// which runs before movementSystem.update() so button presses take effect immediately.

		// Handle interaction
		this.handleInteractEdge(() => this.onInteract());

		// Handle action. `keys.action` is the built-in slot (Mouse0 / action button);
		// `keys[actionType]` covers custom actions declared via declareMobileActions
		// (e.g. a 'shoot' spec creates `keys.shoot`). Accept either so setActionHandler
		// fires when the handler's named action fires through either pipeline.
		const actionActive = this.keys.action
			|| (!!this.actionType && this.actionType !== 'action' && !!this.keys[this.actionType]);
		this.processActionInput(actionActive);

		// Handle secondary action — same dual-pipeline logic as primary.
		const secondaryActive = this.keys.secondaryAction
			|| (!!this.secondaryActionType && this.secondaryActionType !== 'secondaryAction' && !!this.keys[this.secondaryActionType]);
		if (secondaryActive && !this.secondaryActionPressed) {
			this.secondaryActionPressed = true;
			this.onSecondaryActionTriggered();
		} else if (!secondaryActive) {
			this.secondaryActionPressed = false;
		}

		// Update character animations - only walk/run when grounded and not jumping
		// Note: Priority animations (attacks, emotes) block idle/movement animations
		// Skip locomotion animations for movement systems that don't want them (e.g., skiing)
		if (this.animationController) {
			const shouldPlayLocomotion = this.movementSystem.shouldPlayLocomotionAnimation?.() ?? true;
			
			if (shouldPlayLocomotion) {
				const isInAir = this.movementSystem.isInAir();
				const hasMovementInput = this.moveDirection.length() > 0;

				// De-noised locomotion speed. Preferred source: the movement system's
				// GROUND-RELATIVE speed (its collision-clamped per-frame movement minus
				// any moving-platform carry) — a body ridden by a platform is standing
				// still in its ground's frame and must not step in place. Fallback for
				// systems without it: the body's linvel(), a collision-corrected but
				// fixed-step-quantized signal that jitters at low speed and bakes the
				// platform carry into the pose delta. max() with the smooth internal
				// currentSpeed bridges dips during the brief decel after input releases,
				// while still reflecting genuine input-less slides (slopes, knockback).
				const relSpeed = this.movementSystem.getGroundRelativeSpeed?.();
				let horizontalSpeed: number;
				if (relSpeed !== undefined) {
					horizontalSpeed = relSpeed;
				} else {
					const velocity = this.playerBody.linvel();
					horizontalSpeed = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);
				}
				// BLOCKED against an obstacle: the ground-relative speed says the body is
				// not actually moving, so the input ramp (currentSpeed) must not keep the
				// walk cycle stepping in place — a player pressing into a wall stands.
				const blocked = relSpeed !== undefined && relSpeed < 0.35 && !this.movementSystem.isInAir();
				const movementSpeed = blocked
					? relSpeed
					: Math.max(this.movementSystem.getCurrentSpeed(), horizontalSpeed);

				// Locomotion↔idle hysteresis. Holding input counts as moving unless the
				// body is blocked. With no input, keep locomotion alive until the body is
				// clearly stopped and only (re)start it from idle once clearly moving — a
				// dead band so the jittery speed signal can't flicker idle↔walk↔run while
				// decelerating to a standstill.
				if (hasMovementInput && !blocked) {
					this.locomotionActive = true;
				} else if (this.locomotionActive) {
					this.locomotionActive = movementSpeed > PlayerController.LOCOMOTION_STOP_SPEED;
				} else {
					this.locomotionActive = this.isGrounded && movementSpeed > PlayerController.LOCOMOTION_START_SPEED;
				}

				const shouldUseMovementAnimation = this.locomotionActive && !isInAir;

				// Which way the body is travelling relative to its facing, for
				// the directional locomotion clips (strafe/backpedal). Derived
				// from VELOCITY, not input: it also holds for knockback and
				// slopes, and is inert until an aim mode loads the directional
				// pack (see CharacterAnimationController.setLocomotionDirection).
				if (shouldUseMovementAnimation) {
					const v = this.playerBody.linvel();
					const yaw = this.player.rotation.y;
					const sinY = Math.sin(yaw), cosY = Math.cos(yaw);
					// Gameplay frame: forward = (sin yaw, cos yaw), left = (cos yaw, -sin yaw).
					this.animationController.setLocomotionDirection?.(
						v.x * cosY - v.z * sinY,
						v.x * sinY + v.z * cosY,
					);
				}
				// updateAnimation() respects priority animation locks (won't override attacks/emotes)
				const jumpPressed = this._jumpInputSuppressed ? false : this.keys.ascend;
				// Pass real movement INPUT separately so interrupt-on-movement fires
				// only when the player actually steers — not when a committed-root-
				// motion move (e.g. a kick stepping into the ball) slides the body.
				this.animationController.updateAnimation(shouldUseMovementAnimation, movementSpeed, !isInAir, jumpPressed, hasMovementInput);
			}
			this.animationController.update(deltaTime);
		}

		// Blink + gaze for a voxel body carrying eye metadata (no-op for the block
		// mascot and GLBs): the player's eyes follow the aim. The controller hangs
		// off the LOADED body (the `vxlCharacter` root inside this PlayerGroup).
		const eyeRoot = this.playerLoader?.getLoadedGLTF()?.scene as THREE.Object3D | undefined;
		if (eyeRoot) tickVxlCharacterEyesFromView(eyeRoot, deltaTime, this.cameraController?.getCamera() ?? null);

		// After animations, update block character renderer from current bone poses
		// Note: Block character rendering is handled by PlayerLoader.updateBlockCharacter()
		// which should be called by the game template's update loop
	}


	/**
	 * Apply mobile controls joystick input to key states
	 * Converts analog joystick values to digital key presses
	 * This ensures mobile controls work with all IPlayerMovement implementations
	 */
	private applyMobileControlsToKeys(): void {
		if (!this.mobileControls.isEnabled()) return;

		const threshold = 0.1;
		const hasMobileJoystick = Math.abs(this.mobileControls.moveX) > threshold ||
			Math.abs(this.mobileControls.moveY) > threshold;

		// OR-merge joystick with desktop keys (never overwrite to false)
		if (this.mobileControls.moveY > threshold) this.keys.forward = true;
		if (this.mobileControls.moveY < -threshold) this.keys.backward = true;
		if (this.mobileControls.moveX > threshold) this.keys.right = true;
		if (this.mobileControls.moveX < -threshold) this.keys.left = true;

		if (hasMobileJoystick) {
			this.lastActiveInput = 'mobile';
		}

		// OR-merge button states (never overwrite to false — desktop keys handle that)
		if (this.actionContinuous) {
			if (this.mobileControls.actionHeld) this.keys.action = true;
		} else if (this.mobileControls.actionPressed) {
			this.keys.action = true;
			this.mobileControls.resetActionPressed();
		}

		if (this.mobileControls.secondaryActionPressed) {
			this.keys.secondaryAction = true;
			this.mobileControls.resetSecondaryActionPressed();
		}

		const keyBehavior = this.movementSystem.getKeyBehavior();
		if (this.mobileControls.ascendPressed) {
			this.keys.ascend = true;
			if (keyBehavior.ascend === 'tap') {
				this.mobileControls.resetAscendPressed();
			}
		}

		if (this.mobileControls.descendPressed) {
			this.keys.descend = true;
			if (keyBehavior.descend === 'tap') {
				this.mobileControls.resetDescendPressed();
			}
		}

		if (this.mobileControls.interactPressed) {
			this.keys.interact = true;
		}

		// Custom (dynamically registered) actions — OR-merge their pressed state into
		// keys[<action>] so game code can read `this.keys.<action>` identically to
		// built-in keys, and release the 'continuous' ones the merge itself raised
		// (nothing else does: the keyup handler bound by registerCustomAction only
		// fires for the keyboard, so a mobile hold-button would latch true forever).
		// See mobileControls.registerAction() and control-system.md.
		mergeCustomActionKeys(
			this.keys,
			this.mobileControls.customActionEntries(),
			this._mobileHeldCustomActions,
			(action) => this.desktopControls.isAnyKeyDown(this._customActionToKeys.get(action) ?? []),
		);

		// Re-apply suppression after the mobile OR-merge so active suppressions
		// win over mobile button state for the remainder of the frame.
		this.applyActionSuppression();
	}

	/**
	 * Run `handle` on the rising edge of the interact key (E / mobile interact
	 * button), so one press fires once however long it is held. What "interact"
	 * means depends on where the player is — on foot it activates the nearest
	 * interactable, in a vehicle it exits, on an animal it dismounts — so each
	 * of those branches of update() passes its own handler.
	 */
	private handleInteractEdge(handle: () => void): void {
		if (this.keys.interact && !this.interactPressed) {
			this.interactPressed = true;
			handle();
		} else if (!this.keys.interact) {
			this.interactPressed = false;
		}
	}

	onInteract(): boolean {
		return this.interactionController.onInteract();
	}

	/**
	 * Fire the primary action handler from an already-merged `active` flag:
	 * every frame while the handler is continuous (held fire), otherwise once
	 * on the rising edge.
	 */
	private processActionInput(active: boolean): void {
		if (this.actionContinuous) {
			if (active) this.onActionTriggered();
		} else if (active && !this.actionPressed) {
			this.actionPressed = true;
			this.onActionTriggered();
		} else if (!active) {
			this.actionPressed = false;
		}
	}

	onActionTriggered(): void {
		// Call the custom action handler if set. If no handler, silently ignore —
		// held-key systems (e.g. VoxelMiningSystem, PlayerToolSystem) read
		// `keys.action` / `isMiningActive()` directly every frame and don't rely
		// on this one-shot press callback.
		if (this.actionHandler) {
			this.actionHandler(this.player, this);
		}
	}

	onSecondaryActionTriggered(): void {
		// Call the custom secondary action handler if set
		if (this.secondaryActionHandler) {
			this.secondaryActionHandler(this.player, this);
		}
		// Silent if no handler - secondary action is optional
	}

	/**
	 * Get all active projectiles (for collision detection)
	 * Templates with projectile systems should override this method
	 */
	public getProjectiles(): any[] {
		return [];
	}

	public isMiningActive(): boolean {
		// `keys.action` reflects desktop held state (mouse/keyboard) correctly.
		// On mobile / creator-preview UI, the action merge consumes
		// `mobileControls.actionPressed` after one frame, so `keys.action`
		// pulses for a single frame per tap — which breaks held-key systems
		// like VoxelMiningSystem. Fall back to `mobileControls.actionHeld`
		// which stays true for the duration of a hold.
		return this.keys.action || this.mobileControls.actionHeld;
	}

	/**
	 * Remove a projectile (called when it hits something)
	 * Templates with projectile systems should override this method
	 */
	public removeProjectile(projectile: any): void {
		// Templates should override this method
	}

	calculateMoveDirection(): void {
		this.moveDirection.set(0, 0, 0);
		if (!this.cameraController) return;

		const forward = this.cameraController.getForwardVector();
		const right = this.cameraController.getRightVector();

		if (this.useAnalogMovement) {
			// Analog input (joystick): use smooth values
			this.moveDirection.addScaledVector(forward, this.analogMoveY);
			this.moveDirection.addScaledVector(right, this.analogMoveX);

			// Don't normalize for analog - preserve magnitude for variable speed
			// But clamp to max length of 1
			if (this.moveDirection.length() > 1) {
				this.moveDirection.normalize();
			}
		} else {
			// Digital input (keyboard): 8-directional movement
			if (this.keys.forward) this.moveDirection.add(forward);
			if (this.keys.backward) this.moveDirection.sub(forward);
			if (this.keys.left) this.moveDirection.sub(right);
			if (this.keys.right) this.moveDirection.add(right);
			if (this.moveDirection.length() > 0) this.moveDirection.normalize();
		}
	}


	// Delegates kept on PlayerController so existing callers
	// (WeaponPickupSystem, PlayerVehicleController.updateInteractionPrompts)
	// keep working without changes.
	showInteractionPrompt(displayName: string, worldPosition?: THREE.Vector3, actionable: boolean = true, worldYOffset?: number): void {
		this.interactionPromptUI.show(displayName, worldPosition, actionable, worldYOffset);
	}

	hideInteractionPrompt(): void {
		this.interactionPromptUI.hide();
	}

	fadeOut(): Promise<void> {
		return this.fadeOverlay ? this.fadeOverlay.fadeOut() : Promise.resolve();
	}

	fadeIn(): Promise<void> {
		return this.fadeOverlay ? this.fadeOverlay.fadeIn() : Promise.resolve();
	}

	/**
	 * Where the player spawns — captured from the player's position at
	 * construction and used as the default respawn target. Prefer this over
	 * digging `worldProfileData.playerSpawnPosition` out of config: this is
	 * the ground-corrected position the player actually started at. Returns
	 * a copy; to move the player there, call `respawn()`.
	 */
	getSpawnPosition(): THREE.Vector3 {
		return this.startPosition.clone();
	}

	async respawn(position?: THREE.Vector3): Promise<void> {
		if (!this.playerBody || !this.player) return;

		// Use provided position or fall back to start position
		const respawnPosition = position ?? this.startPosition;

		// Perform fade transition
		await this.fadeOut();
		this.performTeleport(respawnPosition);
		await this.fadeIn();
	}

	/** Revive at a feet position, including ragdoll cleanup and the terrain-collider hold. */
	reviveAt(position: THREE.Vector3 = this.startPosition): void {
		if (!this.playerBody || !this.player) throw new Error('Cannot revive before the player has loaded');
		const gravityScale = this._waitingForColliders ? this._originalGravityScale : this.playerBody.gravityScale();
		this.restoreFromRagdoll();
		this.leaveRideForDeath();
		this.setPlayerEnabled(true);
		this.resetAllKeys();
		this.movementSystem.reset();
		this.velocity.set(0, 0, 0);
		this.teleportTo(position.x, position.y, position.z);
		// teleportTo's first hold frame normally derives these from the body;
		// revival already knows them, and must not capture its temporary zero gravity.
		this._savedSpawnPosition = { x: position.x, y: position.y, z: position.z };
		this._originalGravityScale = gravityScale;
		this.resetHealth();
	}

	/** Release held gameplay actions and rides before a spectator acquires the camera. */
	prepareForSpectating(): void {
		this.resetAllKeys();
		this.gamepadControls.consumeCurrentPresses();
		this.velocity.set(0, 0, 0);
		this.leaveRideForDeath();
	}

	/** Death must release vehicle/animal input even when normal exit is locked. */
	private leaveRideForDeath(): void {
		if (this.vehicleControllerHelper.isPlayerInVehicle()) this.requestVehicleExit();
		if (this.animalControllerHelper.isPlayerRidingAnimal()) {
			this.animalControllerHelper.handleDismountRequest(
				this.player, this.playerBody, this.characterHeight, this.retargetCamera, this,
			);
		}
	}

	performTeleport(respawnPosition: THREE.Vector3): void {
		if (!this.playerBody || !this.player) return;
		
		// Stop all movement first
		this.playerBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
		this.playerBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
		
		// Set position
		this.playerBody.setTranslation(
			{ x: respawnPosition.x, y: respawnPosition.y, z: respawnPosition.z },
			true
		);
		
		// Wake up the body
		this.playerBody.wakeUp();
		
		// Update visual position to match physics
		this.player.position.copy(respawnPosition);
		
		// Reset state
		this.isGrounded = false;
		this.resetAllKeys();
		this.movementSystem.reset();
	}

	public hasInteractablesInScene(): boolean {
		return this.interactionController.hasInteractablesInScene();
	}

	/**
	 * Check if player is currently in a vehicle
	 */
	public isPlayerInVehicle(): boolean {
		return this.vehicleControllerHelper.isPlayerInVehicle();
	}

	/**
	 * Enter a vehicle - THE PRIMARY API FOR PUTTING PLAYER IN A VEHICLE
	 * 
	 * This is the ONE method to use when you want the player to enter a vehicle.
	 * It handles ALL necessary state changes:
	 * - Switches to vehicle movement system
	 * - Switches to vehicle camera
	 * - Updates vehicle manager state
	 * - Sets internal tracking flags
	 * 
	 * The internal methods (enterVehicle_INTERNAL, setActiveVehicle_INTERNAL) are named
	 * to clearly indicate they should not be called directly from game code.
	 * 
	 * @param vehicle - The vehicle to enter (from VehicleSpawner.spawnVehicle())
	 * @returns true if successfully entered, false otherwise
	 * @see {@link switchVehicle} — use switchVehicle() instead when switching between vehicles
	 *
	 * @example
	 * // Spawn a vehicle and enter it
	 * const result = vehicleSpawner.spawnVehicle({ x: 10, z: 20 }, config);
	 * if (result) {
	 *     playerController.enterVehicle(result.vehicle);
	 * }
	 */
	public enterVehicle(vehicle: Vehicle): boolean {
		if (!vehicle) {
			console.warn('PlayerController.enterVehicle: No vehicle provided');
			return false;
		}

		if (this.isPlayerInVehicle()) {
			console.warn('PlayerController.enterVehicle: Already in a vehicle, exit first');
			return false;
		}

		// Use the vehicle controller helper which handles all state changes correctly
		const success = this.vehicleControllerHelper.tryEnterVehicle(
			this.player,
			this.player.position.clone(),
			vehicle as unknown as Interactable, // Vehicle implements Interactable
			() => this.cameraController,
			this // Pass self for movement system swapping
		);

		if (success) {
			// Update camera controller to vehicle camera
			// (in 'keep' mode the walking camera is reused, no swap needed)
			const vehicleCamera = this.vehicleControllerHelper.getVehicleCamera();
			if (vehicleCamera) {
				this.cameraController = vehicleCamera;
			}
			console.log('PlayerController.enterVehicle: Successfully entered vehicle');
			this.applyVehicleCameraConfig();
		}

		return success;
	}

	/**
	 * Exit the current vehicle - THE PRIMARY API FOR EXITING A VEHICLE
	 * 
	 * This is the ONE method to use when you want the player to exit a vehicle.
	 * It handles ALL necessary state changes:
	 * - Restores walking movement system
	 * - Restores walking camera
	 * - Positions player next to vehicle
	 * - Clears vehicle manager state
	 * 
	 * @returns true if successfully exited, false if not in a vehicle
	 * @see {@link switchVehicle} — use switchVehicle() instead when switching between vehicles
	 *
	 * @example
	 * if (playerController.isPlayerInVehicle()) {
	 *     playerController.exitVehicle();
	 * }
	 */
	public exitVehicle(): boolean {
		if (!this.isPlayerInVehicle()) {
			console.warn('PlayerController.exitVehicle: Not in a vehicle');
			return false;
		}

		this.requestVehicleExit();

		console.log('PlayerController.exitVehicle: Successfully exited vehicle');
		return true;
	}

	/**
	 * Put the player back on foot: restores the walking movement system and camera
	 * and places the character beside the vehicle. Shared by the E-key / mobile-exit
	 * paths in update(), the public exitVehicle(), and respawn.
	 */
	private requestVehicleExit(): void {
		this.vehicleControllerHelper.handleExitRequest(
			this.player,
			this.playerBody,
			this.characterHeight,
			this.retargetCamera,
			this, // Pass PlayerController for movement system swapping
		);
	}

	/**
	 * Switch from the current vehicle to a different one in a single atomic operation.
	 *
	 * This is the safe way to switch between vehicles (e.g., car → tank).
	 * It correctly handles all state transitions: exits the current vehicle,
	 * restores walking state, then enters the new vehicle.
	 *
	 * DO NOT manually call exitVehicle() + enterVehicle() for vehicle switching —
	 * use this method instead to avoid state inconsistencies.
	 *
	 * @param newVehicle - The vehicle to switch to
	 * @returns true if successfully switched, false otherwise
	 *
	 * @example
	 * // Switch player from current vehicle to a tank
	 * playerController.switchVehicle(tankVehicle);
	 */
	public switchVehicle(newVehicle: Vehicle): boolean {
		if (!newVehicle) {
			console.warn('PlayerController.switchVehicle: No vehicle provided');
			return false;
		}

		// If already in a vehicle, do a direct swap (keeps camera alive, avoids flicker)
		if (this.isPlayerInVehicle()) {
			const success = this.vehicleControllerHelper.switchVehicle(
				this.player,
				newVehicle,
				this
			);
			if (success) {
				console.log('PlayerController.switchVehicle: Switched to new vehicle');
			}
			return success;
		}

		// Not in a vehicle — just enter normally
		return this.enterVehicle(newVehicle);
	}

	/**
	 * Lock or unlock the ability to exit the vehicle.
	 * When locked, the E key and mobile exit button are disabled.
	 * Use for racing games where the player should stay in the vehicle.
	 * @param locked - true to prevent exiting, false to allow
	 */
	public setVehicleExitLocked(locked: boolean): void {
		this.vehicleExitLocked = locked;
	}

	private _vehicleCameraConfig: VehicleCameraConfig | null = null;

	/**
	 * Configure the driving camera. The fields map differently per camera type:
	 *
	 * - **chase** (`VehicleCamera`): `distance` = trailing distance, `height` =
	 *   vertical offset, plus `lookAtHeight` / `followSpeed` / `positionSmoothness`.
	 *   All fields apply.
	 * - **top-down** (`'keep'` mode reuses the walking `TopDownCamera`): the only
	 *   axis is the overhead `distance` (zoom), applied via `setDistance`. The
	 *   chase-only fields are ignored so a chase-style config can't squash the
	 *   overhead view, and the camera's height range is left intact. Omit
	 *   `distance` to leave whatever the template configured untouched.
	 * - **cockpit** (`FirstPersonVehicleCamera`): no tunable fields — a no-op.
	 *
	 * Stored and re-applied on every vehicle entry / camera-mode change.
	 */
	public configureVehicleCamera(options: VehicleCameraConfig): void {
		this._vehicleCameraConfig = options;
		this.applyVehicleCameraConfig();
	}

	private applyVehicleCameraConfig(): void {
		const c = this._vehicleCameraConfig;
		if (!c) return;

		const applySetter = (obj: Record<string, unknown>, name: string, value: number | undefined): void => {
			if (value === undefined) return;
			const fn = obj[name];
			if (typeof fn === 'function') (fn as (v: number) => void).call(obj, value);
		};

		// Dedicated chase camera (VehicleCamera): each field is a distinct axis.
		const chaseCam = this.vehicleControllerHelper.getVehicleCamera() as Record<string, unknown> | null;
		if (chaseCam && typeof chaseCam['setDistance'] === 'function') {
			applySetter(chaseCam, 'setDistance', c.distance);
			applySetter(chaseCam, 'setHeight', c.height);
			applySetter(chaseCam, 'setLookAtHeight', c.lookAtHeight);
			applySetter(chaseCam, 'setFollowSpeed', c.followSpeed);
			applySetter(chaseCam, 'setPositionSmoothness', c.positionSmoothness);
			return;
		}

		// 'keep' mode (e.g. top-down): the walking camera drives. A top-down
		// camera has a single zoom axis — its distance from the player — so only
		// `distance` applies. We never reset its height range or touch the
		// chase-only fields, so the template's framing survives untouched when
		// `distance` is omitted.
		const keptCam = this.cameraController as Record<string, unknown> | null;
		if (keptCam) {
			applySetter(keptCam, 'setDistance', c.distance);
		}
	}
	
	/**
	 * Check if vehicle exit is locked.
	 */
	public isVehicleExitLocked(): boolean {
		return this.vehicleExitLocked;
	}
	
	/**
	 * Get the current vehicle manager
	 */
	public getVehicleManager(): VehicleManager | null {
		return this.vehicleControllerHelper.getVehicleManager();
	}

	/**
	 * Get the active vehicle if player is driving
	 */
	public getActiveVehicle(): any {
		return this.vehicleControllerHelper.getActiveVehicle();
	}

	/**
	 * Get the currently active camera controller (walking or vehicle)
	 */
	public getCameraController(): any {
		return this.cameraController;
	}

	/**
	 * Set the camera controller (for switching between first/third person)
	 */
	public setCameraController(controller: CameraController): void {
		this.cameraController = controller;
		// Also update the walking camera reference for vehicle exit
		if (!this.vehicleControllerHelper.isPlayerInVehicle() && !this.animalControllerHelper.isPlayerRidingAnimal()) {
			this.walkingCamera = controller;
			this.detectAndSetCameraMode();
		}
		// Update target to follow current player
		if (controller.setTarget) {
			controller.setTarget(this.player);
		}
	}

	/**
	 * Get the current position of the player character. While riding a vehicle
	 * the walking body is parked (hidden) at the entry point and does NOT follow
	 * the ride — so this returns the vehicle position instead. Every consumer
	 * (NPC/animal behaviors, the LOD scheduler's player-distance metric) wants
	 * the player's EFFECTIVE location; chasing a parked entry point froze
	 * pursuers mid-chase whenever the player drove off.
	 */
	public getPosition(): THREE.Vector3 {
		if (this.vehicleControllerHelper.isPlayerInVehicle()) {
			const vehicle = this.vehicleControllerHelper.getVehicleManager()?.getActiveVehicle();
			if (vehicle) return vehicle.getPosition();
		}
		return this.player.position;
	}

	/** Player's current horizontal movement speed in m/s. NPC/animal avoidance
	 *  uses this to ignore a stationary player (only react when the player is
	 *  actually moving into them). */
	public getCurrentSpeed(): number {
		return this.movementSystem.getCurrentSpeed();
	}

	/**
	 * Get the ground-level (feet) position of the player, derived from the physics capsule.
	 * Use this instead of getPosition() when saving checkpoint positions for teleportTo().
	 */
	public getGroundPosition(): THREE.Vector3 {
		const pos = this.playerBody.translation();
		return new THREE.Vector3(pos.x, pos.y - this.getCapsuleHeight() / 2, pos.z);
	}

	/** Physics capsule radius (m). Used by NPC melee to size the player hit volume. */
	public getCapsuleRadius(): number {
		return this.capsuleRadius;
	}

	/** Physics capsule total height (m). Used by NPC melee to size the player hit volume. */
	public getCapsuleHeight(): number {
		return this.characterHeight || 1.75;
	}

	/**
	 * Park the physics capsule so the FEET land at (x, y, z) — the capsule center
	 * sits half a height above — and zero its velocities so it neither drifts nor
	 * bounces on the next step. Shared by teleport, respawn, and the
	 * wait-for-colliders hold, which must all place the body identically.
	 */
	private placeCapsuleAtFeet(x: number, y: number, z: number): void {
		this.playerBody.setTranslation({ x, y: y + this.getCapsuleHeight() / 2, z }, true);
		this.playerBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
		this.playerBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
	}

	/**
	 * Pose the visible character (block or skinned) onto the player where it
	 * stands now. The per-frame update does this only while the player runs, so
	 * before Play, or while the player is disabled, the visible body can sit at
	 * the skeleton's old world spot. teleportTo() and the AI editor's `look` at
	 * the player call it.
	 */
	public syncVisibleBody(): void {
		const animController = this.playerLoader?.getAnimationController();
		animController?.getTrackAMixamoPlayer()?.syncSkeletonToPlayer();
		animController?.getTrackBMixamoPlayer()?.syncSkeletonToPlayer();
		animController?.getFadingOutTrackAPlayer()?.syncSkeletonToPlayer();
		this.playerLoader?.updateBlockCharacter();
	}

	/**
	 * Teleport the player to a ground-level (feet) position, keeping the physics
	 * body, the player group, and the visible character root in agreement on the
	 * SAME frame. Safe to call while the player is disabled (e.g. a frozen intro
	 * cinematic) and safe to call every frame to animate a scripted move such as
	 * a tractor-beam descent — pass a descending Y and keep X/Z fixed.
	 * Use positions from getGroundPosition() — not getPosition() which includes visual offsets.
	 * Handles physics body, velocity reset, collider freeze, and terrain chunk activation.
	 */
	public teleportTo(x: number, y: number, z: number, rotationY?: number): void {
		// Prevent the press that triggered this teleport from also firing
		// follow-on actions (attack, shield, etc.) on the next frame when
		// users bind the same physical button to multiple subsystems.
		this.suppressActionsFor(0.4);

		this.placeCapsuleAtFeet(x, y, z);

		// Sync the visual layers to the body THIS frame so the move is correct
		// immediately — even when the player is disabled (e.g. a frozen cutscene),
		// where the per-frame syncPlayerWithPhysics() / collider-hold loop that
		// would otherwise do this is skipped. Without it, scripted code that moves
		// the player mid-cinematic sees the body move but the visible character
		// (driven by playerGroup -> block-character root) stays at its old spot.
		this.player.position.set(x, y, z);
		this.player.updateMatrixWorld(true);

		// Re-anchor the animation pose-source skeletons under the moved player.
		// MixamoAnimationPlayer.update() normally does this every frame, but it is
		// gated behind the player-enabled update loop — so a teleport while the
		// player is disabled (a frozen cutscene) would leave the visible block /
		// skinned character posed at the skeleton's old world spot (the level
		// origin), even though the body and block root moved correctly.
		this.syncVisibleBody();

		// Swallow any buttons/keys the player is still holding from the pre-teleport
		// frame so they don't re-fire as fresh edges (e.g. an NPC-triggered teleport
		// while the user is still mashing the action button).
		this.gamepadControls.consumeCurrentPresses();
		this.keys.action = false;
		this.keys.secondaryAction = false;
		this.keys.interact = false;
		this.keys.ascend = false;
		this.keys.exit = false;

		// Apply rotation if provided
		if (rotationY !== undefined) {
			this.player.rotation.y = rotationY;
			this.movementSystem.reset();
			this.movementSystem.setRotation?.(rotationY);
		}

		// Force-activate terrain chunks at new position
		const dynamicObjMgr = this.engine?.getDynamicObjectManager?.();
		if (dynamicObjMgr) {
			dynamicObjMgr.forceActivateChunksAtPosition(x, z);
		}

		// Freeze physics briefly to let colliders load at new position.
		// Don't set _savedSpawnPosition — let the hold loop derive feet Y
		// from the physics body on its first frame (same feet↔center offset as
		// placeCapsuleAtFeet).
		this._originalGravityScale = this.playerBody.gravityScale();
		this.playerBody.setGravityScale(0, true);
		this.setCapsuleCollidersEnabled(false);
		this._waitingForColliders = true;
		this._savedSpawnPosition = null;
		this._respawnHoldFrames = 0;
	}

	/**
	 * Get the player object (THREE.Object3D) for NPC following behaviors
	 * This allows NPCs to follow the player by tracking the player object directly
	 */
	public getPlayerObject(): THREE.Object3D | null {
		return this.player || null;
	}

	dispose(): void {
		this.deathListeners.clear();
		// Release the path-conflict virtual-obstacle registration first so
		// any in-flight NPC scans this frame don't try to flag a player
		// whose body is about to be removed. Use the LAST REGISTERED handle
		// (not playerBody.handle) because syncPlayerBodyRegistration may
		// have re-registered with a swapped body since construction.
		if (this.lastRegisteredPlayerHandle !== null) {
			getGlobalPathConflictAvoidance()?.unregister(this.lastRegisteredPlayerHandle);
			this.lastRegisteredPlayerHandle = null;
		}

		// Exit vehicle if currently in one
		if (this.vehicleControllerHelper.isPlayerInVehicle()) {
			this.vehicleControllerHelper.exitVehicle(
				this.player,
				this.playerBody,
				this.characterHeight,
				(camera) => {
					this.cameraController = camera;
				},
				this // Pass PlayerController for movement system swapping
			);
		}

		// Dispose vehicle controller
		this.vehicleControllerHelper.dispose();
		
		// Dispose animal controller
		this.animalControllerHelper.dispose();

		// Dispose attack system
		if (this.attackSystem) {
			this.attackSystem.removeEventListeners();
			this.attackSystem.dispose();
			this.attackSystem = null;
		}

		// Dispose sliding VFX
		if (this.slidingVFX) {
			this.slidingVFX.dispose();
			this.slidingVFX = null;
		}

		// Dispose the input sources
		this.mobileControls.dispose();
		this.desktopControls.dispose();
		this.gamepadControls.dispose();

		// Dispose experimental lid controls (closes the SSE connection if open)
		if (this.lidSensorControls) {
			this.lidSensorControls.dispose();
			this.lidSensorControls = null;
		}

		// Clean up fade overlay and interaction prompt UI
		if (this.fadeOverlay) {
			this.fadeOverlay.dispose();
			this.fadeOverlay = null;
		}
		this.interactionPromptUI?.dispose();
	}
	
	/**
	 * Per-frame voxel-grid floor safety net (mirrors NpcController's). If the player has sunk into the
	 * solid voxel column — typically after slipping a per-chunk trimesh seam — lift it back to the
	 * surface. Reads the voxel GRID (getVoxelFloorY), so it's immune to the seams that cause the slip.
	 * Skipped while flying/noclip and in a vehicle.
	 *
	 * feetY is `this.player.position.y` — the player's FEET, which sits exactly on the surface when
	 * standing (same source the NPC net uses: `this.character.position.y`). Do NOT recompute the feet
	 * from the raw capsule body each frame: that value jitters with the KCC's momentary penetration at
	 * a chunk-collider seam and false-fires there (the "twitch at chunk edges"), whereas the synced feet
	 * is stable. The rescue lifts the body AND the feet by the same delta, so the capsule keeps its
	 * normal standing offset — no float, no re-fire.
	 */
	private applyVoxelFloorSafetyNet(): void {
		if (this.vehicleControllerHelper.isPlayerInVehicle()) return;
		if (this.movementSystem.isGravityEnabled?.() === false) return; // flying/noclip
		const dyn = this.engine?.getDynamicObjectManager?.();
		if (!dyn) return;

		const feetY = this.player.position.y; // the feet — on the surface when standing
		const surfaceY = dyn.getVoxelFloorY(this.player.position.x, feetY, this.player.position.z);
		if (surfaceY === null) return; // feet are on/above the surface — nothing to rescue

		const delta = surfaceY - feetY; // how far up the feet must move to reach the surface
		const t = this.playerBody.translation();
		this.playerBody.setTranslation({ x: t.x, y: t.y + delta, z: t.z }, true);
		this.playerBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
		this.player.position.y = surfaceY;
		this.movementSystem.resetVerticalVelocity?.();
	}

	/**
	 * Tune the kill plane and the fallen-vehicle rescue.
	 *
	 * Spread the defaults and override what you need:
	 * `configureFallRescue({ ...DEFAULT_FALL_RESCUE_OPTIONS, killPlaneY: -500 })`
	 * for a world whose terrain reaches below the default -100.
	 */
	public configureFallRescue(options: FallRescueOptions): void {
		this.fallRescue = { ...options };
	}

	/** The current kill-plane / rescue settings. */
	public getFallRescueOptions(): FallRescueOptions {
		return { ...this.fallRescue };
	}

	/**
	 * Where to put the player's car when it falls out of the world — in a lap
	 * race, the last checkpoint. The car is teleported there with the player
	 * still in it, instead of being destroyed.
	 *
	 * `installRacingDefaults()` wires this for you: `racing.setRespawnProvider()`
	 * feeds the same provider to both the stuck-on-scenery recovery and this.
	 */
	public setVehicleRespawnProvider(provider: VehicleRespawnProvider | null): void {
		this.vehicleRespawnProvider = provider;
	}

	/**
	 * Put a player who fell below the kill plane back in play.
	 *
	 * Keeps the car whenever the game has said anything about it — a respawn
	 * provider, or a locked vehicle exit — and only falls back to the
	 * eject-and-destroy respawn when it hasn't. The decision itself is
	 * `planFallRescue()` in FallRescue.ts.
	 */
	private rescueAfterFall(vehicle: Vehicle | null): void {
		const event = planFallRescue({
			vehicle,
			respawn: vehicle ? this.vehicleRespawnProvider?.(vehicle) ?? null : null,
			vehicleExitLocked: this.vehicleExitLocked,
			startPosition: this.startPosition,
			options: this.fallRescue,
		});

		// Fire BEFORE acting: on the destroy path this is the game's last chance
		// to drop its reference while the vehicle is still alive. A handler that
		// returns true has taken the fall over completely — the engine keeps its
		// hands off the player and the vehicle.
		if (this.onFallRescue?.(event) === true) return;

		if (event.action === 'vehicle-respawned') {
			const p = event.position;
			// Same reason respawnAtStart() does it: a car that fell off the map is
			// nowhere near loaded terrain, and one dropped onto chunks whose
			// colliders aren't built yet falls straight back through the plane.
			this.engine?.getDynamicObjectManager?.()?.forceActivateChunksAtPosition(p.x, p.z);
			event.vehicle.teleportTo(p, event.heading ?? undefined);
			console.log(`[PlayerController] Vehicle fell below ${this.fallRescue.killPlaneY}, respawned at (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`);
			return;
		}

		console.log(`[PlayerController] Fell below ${this.fallRescue.killPlaneY}, respawning...`);
		this.respawnAtStart();
	}

	/**
	 * Send the player back to their spawn point on foot — and destroy the
	 * vehicle they were driving, if any.
	 *
	 * Only reached from the kill plane, and only for a game that set no vehicle
	 * respawn provider and left vehicle exit unlocked. Anything that wants to
	 * keep the car goes through `rescueAfterFall()` instead.
	 */
	private respawnAtStart(): void {
		// Clear any active death ragdoll and restore the live character + capsule
		// before repositioning. No-op when not ragdolling.
		this.restoreFromRagdoll();

		// If riding an animal, dismount first
		if (this.animalControllerHelper.isPlayerRidingAnimal()) {
			this.animalControllerHelper.handleDismountRequest(
				this.player,
				this.playerBody,
				this.characterHeight,
				this.retargetCamera,
				this
			);
		}
		
		// Use the exact position from initial spawn - never recalculate.
		// startPosition is captured in the constructor from player.position,
		// which PlayerLoader already set using terrain queries with correct Y.
		const spawnX = this.startPosition.x;
		const spawnY = this.startPosition.y;
		const spawnZ = this.startPosition.z;
		
		// Move player to spawn position BEFORE exiting vehicle.
		// Otherwise exitVehicle places the player at the vehicle's position (underground)
		// which corrupts shadow calculations for at least one frame.
		this.player.position.set(spawnX, spawnY, spawnZ);
		this.placeCapsuleAtFeet(spawnX, spawnY, spawnZ);

		// If in a vehicle, exit and destroy it first
		let vehicleToDestroy = null;
		if (this.vehicleControllerHelper.isPlayerInVehicle()) {
			const vehicleManager = this.vehicleControllerHelper.getVehicleManager();
			vehicleToDestroy = vehicleManager?.getActiveVehicle();

			// Exit the vehicle properly (restores camera/movement)
			this.requestVehicleExit();
		}
		
		console.log(`[SpawnHeight] respawnAtStart using startPosition: (${spawnX}, ${spawnY}, ${spawnZ})`);
		
		// Force-activate terrain chunks at spawn so colliders are ready
		const dynamicObjMgr = this.engine?.getDynamicObjectManager?.();
		if (dynamicObjMgr) {
			dynamicObjMgr.forceActivateChunksAtPosition(spawnX, spawnZ);
		}
		
		// Ensure position is set (may have been overwritten by exitVehicle) and freeze physics
		this.player.position.set(spawnX, spawnY, spawnZ);
		this.player.rotation.y = this.startRotation;
		this.placeCapsuleAtFeet(spawnX, spawnY, spawnZ);
		this._originalGravityScale = this.playerBody.gravityScale();
		this.playerBody.setGravityScale(0, true);

		// Disable player collider during spawn hold to prevent Rapier from
		// pushing the player out of solid blocks (e.g., inside map corridors)
		this.setCapsuleCollidersEnabled(false);

		// Restore initial facing direction
		this.movementSystem.reset();
		this.movementSystem.setRotation?.(this.startRotation);
		
		// Hold player frozen for a few frames while camera and terrain catch up
		this._waitingForColliders = true;
		this._savedSpawnPosition = { x: spawnX, y: spawnY, z: spawnZ };
		
		console.log(`[PlayerController] Player respawned at: (${spawnX}, ${spawnY}, ${spawnZ}), waiting for colliders...`);
		
		// Destroy the fallen vehicle
		if (vehicleToDestroy) {
			const vehicleManager = this.vehicleControllerHelper.getVehicleManager();
			vehicleManager?.removeVehicle(vehicleToDestroy);
		}
	}
	
	// ════════════════════════════════════════════════════════════════════════════
	// PLAYER HEALTH METHODS
	// ════════════════════════════════════════════════════════════════════════════

	getPlayerHealth(): number {
		return this.healthComp.getHealth();
	}

	getPlayerMaxHealth(): number {
		return this.healthComp.getMaxHealth();
	}

	isPlayerDead(): boolean {
		return this.healthComp.isDead();
	}

	/**
	 * True when the death path actually collapsed the player into a ragdoll.
	 * A death that built no ragdoll leaves `isPlayerDead()` true and this false.
	 */
	isPlayerRagdolled(): boolean {
		return this.healthComp.isRagdolled();
	}

	/**
	 * True while an articulated ragdoll body exists — the death collapse OR a
	 * temporary bail (`enterTemporaryRagdoll`), which never touches health.
	 */
	hasRagdoll(): boolean {
		return this.ragdollComp?.hasRagdoll() ?? false;
	}

	setPlayerMaxHealth(maxHealth: number): void {
		this.healthComp.setMaxHealth(maxHealth);
		this.onHealthChanged?.(this.healthComp.getHealth(), this.healthComp.getMaxHealth());
	}

	setProjectileDamage(damage: number): void {
		this.projectileDamage = Math.max(1, damage);
	}

	takeDamage(amount: number, source?: string, deathImpulse?: THREE.Vector3): void {
		this.healthComp.takeDamage(amount, source, deathImpulse);
	}

	heal(amount: number): void {
		if (this.healthComp.heal(amount)) {
			console.log(`💚 Player healed ${amount}. Health: ${this.healthComp.getHealth()}/${this.healthComp.getMaxHealth()}`);
			this.onHealthChanged?.(this.healthComp.getHealth(), this.healthComp.getMaxHealth());
		}
	}

	resetHealth(): void {
		this.healthComp.resetHealth();
		this.onHealthChanged?.(this.healthComp.getHealth(), this.healthComp.getMaxHealth());
		console.log(`💚 Player health reset to ${this.healthComp.getHealth()}/${this.healthComp.getMaxHealth()}`);
	}

	/**
	 * How long the player's corpse lingers after a ragdoll death, in ms. Defaults
	 * to 0 — persist until respawn disposes it — so set this only for a game that
	 * wants the body to fade on its own. Takes effect immediately, so it also
	 * retunes a body already on the ground. Routed through the lazy constructor so
	 * a value set before the first death is not lost.
	 */
	setCorpseLifetimeMs(ms: number): void {
		this.ensureRagdollComponent().setCorpseLifetimeMs(ms);
	}
}
