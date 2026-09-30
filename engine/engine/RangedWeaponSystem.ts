/**
 * @fileoverview RangedWeaponSystem - Component for Ranged Weapon Combat
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * 🔫 RANGED WEAPON SYSTEM (COMPONENT)
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * A pluggable combat component that can be attached to ANY PlayerController.
 * Implements the IPlayerAttack interface for seamless integration.
 *
 * **USE THIS FOR:**
 * ✅ Pistols, revolvers, handguns (any 1-handed firearm)
 * ✅ Rifles, assault rifles, SMGs, shotguns (any 2-handed firearm)
 * ✅ Bows, crossbows (projectile weapons)
 * ✅ Bazookas, rocket launchers, grenade launchers
 * ✅ ANY weapon that fires bullets, arrows, rockets, or projectiles
 *
 * ## Installing one (start here)
 * `installRangedWeapon(playerController, 'pistol', { aim: 'cursor' })` at the
 * bottom of this file is the whole install: system construction, attack-system
 * registration, readiness-safe equip, shoot input, ticking, ammo HUD and
 * disposal. Use the class directly only when you need to interleave your own
 * steps — the manual sequence (`new RangedWeaponSystem` + `setAttackSystem` +
 * `equipWeapon` on `onCharacterReady`) has to be ordered correctly by hand.
 *
 * ## Aim Modes
 * The system adapts to the active camera (`aimMode: 'auto'`, the default):
 * first/third-person games get camera-center aiming with a reticle; top-down
 * games get cursor aiming — shots fly toward the mouse cursor's ground point,
 * no reticle. By default the character faces its movement direction and only
 * turns to the cursor while firing (`cursorFacing: 'while-firing'`); set
 * `cursorFacing: 'always'` for classic twin-stick facing.
 * Force a mode via the options parameter:
 * `new RangedWeaponSystem(engine, physicsWorld, { ...DEFAULT_RANGED_WEAPON_OPTIONS, aimMode: 'cursor' })`
 *
 * ## Features
 * - Gun-centered attachment (hands grip weapon, not weapon attached to hands)
 * - Arm attachment overrides via BlockCharacterRenderer
 * - Dual weapon support with alternating fire
 * - Weapon clearance detection (raises weapon when aim blocked)
 * - Projectile management and tracking
 * - Recoil, camera shake, and comic bubble effects
 * - Combat mode camera coordination
 * - Reticle display via HUD
 *
 * ## Related Files
 * - RangedWeaponRegistry.ts - Weapon definitions and creation
 * - ShootableComponent.ts - Projectile shooting system
 * - Projectile.ts - Projectile physics and explosion system
 * - BlockCharacterRenderer.ts - Arm attachment override system
 */

import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import type { IPlayerAttack } from 'engine/IPlayerAttack.js';
import type { PlayerController } from 'engine/PlayerController.js';
import type { PlayerLoader } from 'engine/loaders/PlayerLoader.js';
import type { ThirdPersonCamera } from 'engine/ThirdPersonCamera.js';
import type { ICameraController, CameraMode } from 'engine/ICameraController.js';
import { ShootableComponent, type ProjectileConfig } from 'engine/ShootableComponent.js';
import { calculateCameraAimPoint } from 'engine/weapons/CameraAim.js';
import { createRangedProjectileConfig } from 'engine/weapons/RangedProjectileConfig.js';
import { fireWeaponShot } from 'engine/weapons/WeaponVolley.js';
import { RANGED_WEAPON_ANIMATIONS, RANGED_MOVES, DIRECTIONAL_LOCOMOTION_ANIMATIONS, rangedMovesFor } from 'engine/AnimationPacks.js';
import { Projectile } from 'engine/Projectile.js';
import { isPlaneLockedPhysics } from 'engine/physics/PlaneLockedPhysics.js';
import { CollisionGroup, CollisionMask } from 'engine/CollisionLayers.js';
import { findBoneByCandidates } from 'engine/SkeletonAliases.js';
import { bringSkinnedDualWeaponsInward, createSkinnedRangedGrip, SKINNED_RANGED_HOLD } from 'engine/weapons/RangedWeaponGrip.js';

import {
	createRangedWeaponMesh,
	createTracerMesh,
	makeRangedWeaponVisualOnly,
	type RangedWeaponTypeId,
	type RangedWeaponPreset
} from 'engine/RangedWeaponRegistry.js';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import type { IWeaponMagazine } from 'engine/IWeaponMagazine.js';
import { WeaponMagazineComponent } from 'engine/WeaponMagazineComponent.js';
import { t } from 'engine/i18n/index.js';

// Re-export for convenience
export { RangedWeaponType, RangedWeaponRegistry, type RangedWeaponTypeId } from 'engine/RangedWeaponRegistry.js';
export type { IWeaponMagazine } from 'engine/IWeaponMagazine.js';
export { WeaponMagazineComponent, type WeaponMagazineConfig } from 'engine/WeaponMagazineComponent.js';

/** cos(20°) — a spawned shot pointing further than this off the muzzle→aim
 *  line is a bug, not spread (the engine has no ballistic spread yet). */
const STRAY_SHOT_DOT_THRESHOLD = Math.cos((20 * Math.PI) / 180);

/** An angle folded into (-pi, pi] — the shortest way round between two yaws. */
function wrapToPi(angle: number): number {
	return ((angle + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
}

/** Skeleton bone-name candidates per block-character body part name. */
const BODY_PART_BONE_NAMES: Record<string, string[]> = {
	'rightUpperArm': ['mixamorig2RightArm', 'mixamorigRightArm', 'RightArm', 'arm_r', 'Arm_R'],
	'leftUpperArm': ['mixamorig2LeftArm', 'mixamorigLeftArm', 'LeftArm', 'arm_l', 'Arm_L'],
	'rightHand': ['mixamorig2RightHand', 'mixamorigRightHand', 'RightHand', 'hand_r', 'Hand_R'],
	'leftHand': ['mixamorig2LeftHand', 'mixamorigLeftHand', 'LeftHand', 'hand_l', 'Hand_L'],
};

/**
 * How the weapon decides where the player is aiming.
 * - 'camera': camera-center aiming (first/third person) — camera lock, combat camera, reticle.
 * - 'cursor': top-down style — shots fly toward the mouse cursor's ground point;
 *   no reticle, no camera lock. Character facing is governed by `cursorFacing`.
 *   On touch devices, fires along the player's facing.
 * - 'auto': 'cursor' when the active camera reports 'top-down', else 'camera'.
 */
export type RangedWeaponAimMode = 'auto' | 'camera' | 'cursor';

/**
 * What drives the character's yaw in cursor aim mode.
 * - 'while-firing' (default): face the movement direction while traversing;
 *   turn to the cursor only while the trigger is held, plus a short linger
 *   (CURSOR_FACING_LINGER_MS) — Hades-style. Shots fly toward the cursor
 *   regardless of facing.
 * - 'always': classic twin-stick — face the cursor at all times, movement
 *   strafes (Hotline Miami-style).
 */
export type RangedWeaponCursorFacing = 'while-firing' | 'always';

/**
 * After the trigger is released in 'while-firing' cursor facing, the character
 * keeps facing the cursor this long before movement-driven facing resumes
 * (prevents flip-flopping between bursts).
 */
export const CURSOR_FACING_LINGER_MS = 500;

export interface RangedWeaponSystemOptions {
	aimMode: RangedWeaponAimMode;
	/** Projectile + trail color override; null uses the weapon preset's color. */
	projectileColor: number | null;
	/**
	 * Cursor-aim facing behavior; absent means 'while-firing'. Optional (not
	 * required per the engine options pattern) because frozen published games
	 * construct this options object literally.
	 */
	cursorFacing?: RangedWeaponCursorFacing;
}

export const DEFAULT_RANGED_WEAPON_OPTIONS: RangedWeaponSystemOptions = {
	aimMode: 'auto',
	projectileColor: null,
	cursorFacing: 'while-firing',
};

/**
 * RangedWeaponSystem - Pluggable ranged weapon combat component
 *
 * Implements IPlayerAttack interface and can be attached to any PlayerController
 * using controller.setAttackSystem(rangedSystem).
 */
export class RangedWeaponSystem implements IPlayerAttack {
	// Core references
	private engine: EngineLike | null;
	private physicsWorld: PhysicsWorld;
	private mobileControls: unknown = null;

	// Player references (set when weapon equipped)
	private player: THREE.Object3D | null = null;
	private playerLoader: PlayerLoader | null = null;
	private controller: PlayerController | null = null;

	// Weapon state
	private weaponMesh: THREE.Group | null = null;
	private currentWeaponType: RangedWeaponTypeId | null = null;
	/** True once the ranged animation pack has been loaded for this character. */
	private rangedAnimationsLoaded = false;
	private rangedAnimationsLoading = false;
	private directionalAnimationsLoaded = false;
	private directionalAnimationsLoading = false;

	// ── Torso aim (cursor mode) ─────────────────────────────────────────
	// The torso twists toward the cursor while the LEGS keep following the
	// movement direction — a top-down shooter's upper/lower body split. Twist
	// is the clamped angle between the aim yaw and the body yaw, smoothed, and
	// written as manual bone offsets so it layers on top of whatever clip is
	// playing. When the body itself faces the cursor (twin-stick 'always', or
	// 'while-firing' inside the firing window) the delta is ~0 and this is
	// naturally inert.
	private torsoTwist = 0;
	private readonly torsoOffsets = new Map<string, THREE.Quaternion>([
		['torso', new THREE.Quaternion()],
		['neck', new THREE.Quaternion()],
		['head', new THREE.Quaternion()],
	]);
	private torsoOffsetsInstalled = false;
	private warnedFirstPerson = false;
	private static readonly TORSO_TWIST_MAX = 1.1;
	private static readonly TORSO_TWIST_SHARPNESS = 12;
	// How the twist is distributed down the chain. The arm hangs off the SPINE,
	// so the hand — and therefore the gun — turns by exactly the spine share.
	private static readonly TWIST_SHARE_SPINE = 0.55;
	private static readonly TWIST_SHARE_NECK = 0.25;
	private static readonly TWIST_SHARE_HEAD = 0.20;
	private static readonly _yAxis = new THREE.Vector3(0, 1, 0);

	// ── Aim regime ('while-firing' cursor games) ────────────────────────
	// While actively shooting, SMALL aim-vs-movement angles are covered by the
	// torso twist alone — the body keeps facing its travel direction, so the
	// legs stay on the forward cycle. Only when the cursor swings beyond what
	// a torso can reach does the BODY rotate to the cursor, which is the
	// moment the strafe/backpedal clips take over the legs. The regime signal
	// is cursor-vs-MOVEMENT direction: comparing against the body yaw would
	// oscillate, because rotating the body is exactly what the decision does.
	private torsoOnlyAim = false;
	private readonly _prevPlayerPos = new THREE.Vector3();
	private _prevPosValid = false;
	private _movementYaw = 0;
	private _movementSpeed = 0;
	private static readonly TORSO_ONLY_ENTER_RAD = Math.PI / 3;      // 60°
	private static readonly TORSO_ONLY_EXIT_RAD = (70 * Math.PI) / 180;
	private static readonly TORSO_AIM_MIN_SPEED = 0.5;
	/** Wall-clock ms of the last shot — the minigun loop's falling-edge timer. */
	private lastFireAnimMs = 0;
	private weaponPreset: RangedWeaponPreset | null = null;
	private shootableComponent: ShootableComponent | null = null;
	private weaponBaseForwardOffset: number = 0.55;
	private reticleShown: boolean = false;
	private gunXOffset: number = 0;
	private shootingEnabledTime: number = 0;
	/** Runtime cadence override (shots/s); null = the preset's fireRate. See setFireRate. */
	private fireRateOverride: number | null = null;

	// Dual weapon support
	private isDualWeapon: boolean = false;
	private rightWeaponMesh: THREE.Group | null = null;
	private leftWeaponMesh: THREE.Group | null = null;
	private rightShootableComponent: ShootableComponent | null = null;
	private leftShootableComponent: ShootableComponent | null = null;
	private lastFiredRight: boolean = false;

	// Ammunition system (pluggable magazine component)
	private magazine: IWeaponMagazine = new WeaponMagazineComponent({ magazineSize: 0 });
	private customMagazine: IWeaponMagazine | null = null;

	// Projectile management
	private projectiles: Projectile[] = [];

	/**
	 * Optional callback fired when a new projectile is created.
	 * Use this to wire up per-projectile callbacks (e.g. `setOnRemoteAnimalHit`,
	 * `setOnRemoteNpcHit`) without needing to iterate projectiles manually each frame.
	 */
	onProjectileCreated: ((projectile: Projectile) => void) | null = null;

	// Weapon clearance system
	private weaponHeightOffset: number = 0;
	private targetWeaponOffset: number = 0;
	private weaponTransitionSpeed: number = 8;
	private weaponBaselineHeight: number = 0;
	private clearanceHysteresis: number = 0.03;
	private aimBlocked: boolean = false;
	private lastTargetPoint: THREE.Vector3 = new THREE.Vector3();

	// Combat modes enabled state
	private combatModesEnabled: boolean = false;
	private reloadHandlerActive: boolean = false;

	// Aim mode (camera-center vs cursor-ground aiming)
	private options: RangedWeaponSystemOptions;
	private effectiveAimMode: 'camera' | 'cursor' = 'camera';
	private cursorClientX: number | null = null;
	private cursorClientY: number | null = null;
	private boundOnMouseMove: ((e: MouseEvent) => void) | null = null;
	private readonly cursorGroundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
	/** Side-on lane: the gameplay plane itself (z = planeZ), which the cursor aims on. */
	private readonly sideOnAimPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
	private readonly cursorRaycaster = new THREE.Raycaster();
	private cursorGroundPointThisFrame: THREE.Vector3 | null = null;
	/** Wall-clock ms of the last trigger pull in cursor mode ('while-firing' facing window). */
	private lastCursorTriggerMs = 0;

	// HUD ammo counter
	private static readonly AMMO_COUNTER_ID = 'ammo';
	private static readonly _tmpStrayWanted = new THREE.Vector3();
	private ammoCounterCreated: boolean = false;
	private ammoCounterMode: 'auto' | boolean = 'auto';

	constructor(
		engine: EngineLike | null,
		physicsWorld: PhysicsWorld,
		options: RangedWeaponSystemOptions = DEFAULT_RANGED_WEAPON_OPTIONS
	) {
		this.engine = engine;
		this.physicsWorld = physicsWorld;
		this.options = options;
	}

	// ════════════════════════════════════════════════════════════════════════════════
	// IPlayerAttack Interface Implementation
	// ════════════════════════════════════════════════════════════════════════════════

	/**
	 * Set the controller reference.
	 * Called by PlayerController.setAttackSystem() when this system is attached.
	 * If a weapon is already equipped, enables combat modes immediately.
	 */
	setController(controller: PlayerController): void {
		this.controller = controller;
		this.warnIfFirstPerson();

		// If weapon is already equipped, enable combat modes now
		if (this.weaponMesh) {
			this.enableCombatModes();
		}
	}

	/**
	 * This system parents the weapon to the player root, and CameraManager hides
	 * the player root in first person — so the gun is invisible there, and has
	 * always been. Fails silently otherwise, which reads as "the weapon didn't
	 * equip". Mirrors WeaponMeleeSystem's equivalent warning.
	 */
	private warnIfFirstPerson(): void {
		if (this.warnedFirstPerson || this.getCameraMode() !== 'first-person') return;
		this.warnedFirstPerson = true;
		console.error(
			'❌ RangedWeaponSystem: the camera is in FIRST PERSON — the weapon mesh is parented to\n' +
			'   the player root, which the engine hides in first person, so the gun will not be visible.\n' +
			'   Use FirstPersonWeaponSystem instead: a true view model with sway, bob, recoil,\n' +
			'   aim-down-sights, muzzle flash and shell ejection, rendered in front of the camera so it\n' +
			'   cannot clip into walls. See engine/FirstPersonWeaponSystem.ts.'
		);
	}

	/**
	 * Set up input event listeners.
	 * Shooting input goes through the action-handler system; the only direct
	 * listener is mouse tracking for cursor-aim mode (never fires on touch).
	 */
	setupEventListeners(): void {
		this.boundOnMouseMove = (e: MouseEvent) => {
			this.cursorClientX = e.clientX;
			this.cursorClientY = e.clientY;
		};
		window.addEventListener('mousemove', this.boundOnMouseMove);
	}

	/**
	 * Remove input event listeners.
	 */
	removeEventListeners(): void {
		if (this.boundOnMouseMove) {
			window.removeEventListener('mousemove', this.boundOnMouseMove);
			this.boundOnMouseMove = null;
		}
	}

	/**
	 * Configure mobile controls integration.
	 */
	setMobileControls(mobileControls: unknown): void {
		this.mobileControls = mobileControls;
	}

	/**
	 * Frame update for ranged weapon system.
	 * @returns true if player movement should be blocked (ranged weapons don't block movement)
	 */
	update(deltaTime: number): boolean {
		if (!this.controller) return false;

		// React to camera-mode changes (e.g. game switches third-person → top-down)
		if (this.combatModesEnabled) {
			const mode = this.resolveAimMode();
			if (mode !== this.effectiveAimMode) {
				if (mode === 'cursor') {
					this.disableCameraAim();
				} else {
					this.enableCameraAim();
				}
				this.effectiveAimMode = mode;
				console.log(`🎯 RangedWeaponSystem: Aim mode switched to ${mode}`);
			}
		}

		// Show reticle if weapon is equipped but HUD wasn't ready when enableCombatModes was called
		if (this.effectiveAimMode === 'camera' && this.weaponMesh && !this.reticleShown && this.controller.hud) {
			this.controller.hud.showReticle();
			this.controller.hud.setReticleOffset(0);
			this.reticleShown = true;
		}

		// Cache the cursor ground point once per frame (consumed by updateCursorAim
		// and calculateTargetPoint within this same update)
		// Side-on keeps this null: the cursor-facing and torso-twist drivers it
		// feeds are top-down ideas (they steer by a yaw read off the horizontal
		// plane), and on a side view the character's facing is the movement's.
		this.cursorGroundPointThisFrame = this.effectiveAimMode === 'cursor' && this.sideOnPlaneZ() === null
			? this.getCursorGroundPoint()
			: null;

		// Sample the player's travel direction from position deltas (the body's
		// velocity is not exposed here); feeds the aim-regime decision above.
		if (this.player && deltaTime > 0) {
			if (this._prevPosValid) {
				const dx = this.player.position.x - this._prevPlayerPos.x;
				const dz = this.player.position.z - this._prevPlayerPos.z;
				const speed = Math.hypot(dx, dz) / deltaTime;
				this._movementSpeed = speed;
				if (speed > 0.3) this._movementYaw = Math.atan2(dx, dz);
			}
			this._prevPlayerPos.copy(this.player.position);
			this._prevPosValid = true;
		}

		// Cursor aim: rotate the player to face the ground point under the cursor
		if (this.effectiveAimMode === 'cursor' && this.weaponMesh) {
			this.controller.animationController?.setDirectionalLocomotionEnabled?.(true);
			void this.ensureDirectionalAnimations();
			this.updateCursorAim();
		}
		this.updateTorsoAim(deltaTime);
		this.updateCoverPeek();

		// Minigun sustained-fire falling edge. The fire clip LOOPS (a minigun has
		// no per-shot kick; the shudder is the animation), and nothing else stops
		// a looping custom clip — so: if the looping fire clip is still playing
		// but no shot has landed for a couple of fire intervals, the trigger has
		// been released. Stop it and let locomotion resume.
		if (this.lastFireAnimMs > 0 && Date.now() - this.lastFireAnimMs > 250) {
			const animController = this.controller.animationController;
			const moves = this.currentWeaponType ? rangedMovesFor(this.currentWeaponType) : null;
			if (moves?.fireLoops && animController?.getCustomMotionId?.() === moves.fire) {
				animController.stopCustomAnimation?.();
			}
			this.lastFireAnimMs = 0;
		}

		// Update magazine (reload timer etc.) and detect reload completion
		const wasReloading = this.magazine.getIsReloading();
		this.magazine.update();
		if (wasReloading && !this.magazine.getIsReloading()) {
			this.updateAmmoDisplay();
		}

		// Show/hide reload button based on current ammo state
		this.updateReloadVisibility();

		// Update projectiles
		this.updateProjectiles(deltaTime);

		// Detect weapon clearance (must be before updateWeaponHeight)
		this.detectWeaponClearance(deltaTime);

		// Update gun Y to follow torso height
		this.updateWeaponHeight();

		// Ranged weapons don't block movement
		return false;
	}

	/**
	 * Clean up resources.
	 */
	dispose(): void {
		this.removeEventListeners();

		// Dispose all projectiles
		this.projectiles.forEach(p => p.dispose());
		this.projectiles = [];

		// Unequip weapon
		this.unequipWeapon();
	}

	// ════════════════════════════════════════════════════════════════════════════════
	// Weapon Management
	// ════════════════════════════════════════════════════════════════════════════════

	/**
	 * Equip a ranged weapon.
	 * @param weaponType - Type of weapon to equip
	 * @param player - Player object to attach weapon to
	 * @param playerLoader - PlayerLoader for accessing BlockCharacterRenderer
	 * @param retryCount - Internal retry counter (used for deferred equip when renderer not ready)
	 */
	equipWeapon(
		weaponType: RangedWeaponTypeId,
		player: THREE.Object3D,
		playerLoader: PlayerLoader,
		retryCount: number = 0
	): void {
		// Store references
		this.player = player;
		this.playerLoader = playerLoader;

		// Unequip current weapon if any
		this.unequipWeapon();

		console.log(`🔫 RangedWeaponSystem: Equipping ${weaponType}... (attempt ${retryCount + 1})`);

		// In skinned-render mode (custom/generated characters) the block
		// character is hidden and never updated, so its arm-grip overrides are
		// meaningless and no block renderer is required — the gun is positioned
		// from the real skeleton instead.
		const renderSkinned = playerLoader.isRenderingSkinnedMesh();

		// Headless players (world.json `hasPlayerCharacter: false` — first-person,
		// vehicle, board games) have NO character by design, so a block renderer
		// will never appear. Equip proceeds without one: every arm-grip call below
		// is optional-chained, body-part lookups fall back to fixed offsets, and
		// aiming is camera-based anyway — the weapon works, it just has no body
		// to pose. Only block-character players wait for the renderer.
		const headless = playerLoader.isHeadlessPlayer();

		// Wait for block renderer to be ready (block-character mode only)
		const blockRenderer = playerLoader.getBlockCharacterRenderer();
		if (!blockRenderer && !renderSkinned && !headless) {
			if (retryCount < 5) {
				const delay = 100 * (retryCount + 1);
				console.log(`⏳ Block renderer not ready, retrying in ${delay}ms...`);
				setTimeout(() => this.equipWeapon(weaponType, player, playerLoader, retryCount + 1), delay);
			} else {
				console.error(`❌ Failed to equip ${weaponType} - block renderer not available`);
			}
			return;
		}

		// Create weapon from preset
		const creationResult = createRangedWeaponMesh(weaponType);
		const { mesh, preset, grip = preset.gripOffset, foregrip, isDual, rightWeaponMesh, leftWeaponMesh, rightGrip, leftGrip } = creationResult;
		mesh.name = `Weapon_${weaponType}`;

		// Make weapon visual-only
		makeRangedWeaponVisualOnly(mesh);

		// Add gun to player root
		player.add(mesh);

		// Scale gun
		const scale = preset.weaponScale ?? new THREE.Vector3(3, 3, 1.5);
		mesh.scale.copy(scale);

		// Position at shoulder height
		const rightShoulder = this.getBodyPartObject(player, 'rightUpperArm');
		let rightOffset = 0.25;
		let shoulderHeight = 1.0;

		if (rightShoulder) {
			rightShoulder.updateMatrixWorld(true);
			const shoulderWorldPos = new THREE.Vector3();
			rightShoulder.getWorldPosition(shoulderWorldPos);

			player.updateMatrixWorld(true);
			const playerWorldPos = new THREE.Vector3();
			player.getWorldPosition(playerWorldPos);

			const shoulderLocal = shoulderWorldPos.clone().sub(playerWorldPos);
			const playerQuat = new THREE.Quaternion();
			player.getWorldQuaternion(playerQuat);
			shoulderLocal.applyQuaternion(playerQuat.invert());

			rightOffset = shoulderLocal.x;
			shoulderHeight = this.sanitizeShoulderHeight(shoulderLocal.y);
		}

		const heightOffset = preset.heightOffset ?? 0.2;
		const hold = renderSkinned ? SKINNED_RANGED_HOLD[isDual ? 'dual' : preset.hands === 2 ? 'rifle' : 'single'] : null;
		const xOffset = (preset.xOffset ?? 0) + (hold?.inward ?? 0);
		const forwardOffset = (preset.forwardOffset ?? 0.55) + (hold?.forward ?? 0);

		// Initial placement; updateWeaponHeight re-applies the same formula each
		// frame. All skinned hold types use their own shoulder-relative correction.
		const gunY = shoulderHeight + heightOffset - (hold?.drop ?? 0);
		if (isDual) {
			mesh.position.set(xOffset, gunY, forwardOffset);
		} else {
			mesh.position.set(rightOffset + xOffset, gunY, forwardOffset);
		}
		// No initial rotation - weapon mesh points forward naturally
		mesh.rotation.set(0, 0, 0);

		this.weaponBaseForwardOffset = forwardOffset;
		this.gunXOffset = isDual ? xOffset : (rightOffset + xOffset);

		this.weaponMesh = mesh;
		this.currentWeaponType = weaponType;
		this.controller?.animationController?.setDirectionalLocomotionStyle?.(
			rangedMovesFor(weaponType).aim === RANGED_MOVES.aimRifle ? 'rifle' : 'neutral');
		void this.ensureRangedAnimations();
		this.weaponPreset = preset;
		this.isDualWeapon = isDual ?? false;

		// Store dual weapon references
		if (isDual && rightWeaponMesh && leftWeaponMesh) {
			this.rightWeaponMesh = rightWeaponMesh;
			this.leftWeaponMesh = leftWeaponMesh;
		}

		// Set arm grip: pose the gripping arm(s) onto the weapon grips. The block
		// path repositions the visible block arm groups; the skinned path solves
		// 2-bone IK on the real arm bones (block arms are hidden in skinned mode).
		// Either way the rifle/pistol distinction is the same: the right hand
		// always grips; the left hand only grips a two-handed weapon's foregrip.
		const applyGrip = (side: 'left' | 'right', offset: THREE.Vector3, rot: THREE.Euler): void => {
			if (renderSkinned) {
				this.playerLoader?.setSkinnedArmGrip(side, mesh, offset, rot);
			} else {
				blockRenderer?.setArmAttachmentOverride(side, mesh, offset, rot);
			}
		};

		if (isDual && rightGrip && leftGrip) {
			if (renderSkinned) {
				if (rightWeaponMesh && leftWeaponMesh) {
					bringSkinnedDualWeaponsInward(scale, rightWeaponMesh, leftWeaponMesh, rightGrip, leftGrip);
				}
				// The historical mesh names use +X for "right"; an anatomical
				// right hand is on -X when the character faces gameplay +Z.
				const right = createSkinnedRangedGrip(mesh, 'right', leftGrip, scale, 'trigger');
				const left = createSkinnedRangedGrip(mesh, 'left', rightGrip, scale, 'trigger');
				applyGrip('right', right.offset, right.rotation);
				applyGrip('left', left.offset, left.rotation);
			} else {
				// DUAL WEAPONS: Each hand grips its own weapon's pistol grip
				const xScaleFactor = 1.3;

				const rightGripOffset = leftGrip.clone();
				rightGripOffset.x *= xScaleFactor;
				rightGripOffset.y *= scale.y;
				rightGripOffset.z *= scale.z;
				applyGrip('right', rightGripOffset, new THREE.Euler(-Math.PI / 2, 0, Math.PI / 2));

				const leftGripOffset = rightGrip.clone();
				leftGripOffset.x *= xScaleFactor;
				leftGripOffset.y *= scale.y;
				leftGripOffset.z *= scale.z;
				applyGrip('left', leftGripOffset, new THREE.Euler(-Math.PI / 2, 0, -Math.PI / 2));
			}
		} else if (renderSkinned) {
			// SINGLE WEAPONS: right hand on the main grip.
			const right = createSkinnedRangedGrip(mesh, 'right', grip, scale);
			applyGrip('right', right.offset, right.rotation);
			if (preset.hands === 2 && foregrip) {
				const left = createSkinnedRangedGrip(mesh, 'left', foregrip, scale);
				applyGrip('left', left.offset, left.rotation);
			}
		} else {
			const rightGripOffset = grip.clone();
			rightGripOffset.x *= scale.x;
			rightGripOffset.y *= scale.y;
			rightGripOffset.z *= scale.z;
			rightGripOffset.y -= 0.08;
			rightGripOffset.x += 0.05;
			applyGrip('right', rightGripOffset, new THREE.Euler(-Math.PI / 2, 0, Math.PI / 2));

			// Two-handed (rifle): left hand on the foregrip. One-handed (pistol):
			// left arm is left to its normal animation.
			if (preset.hands === 2 && foregrip) {
				const leftGripOffset = foregrip.clone();
				leftGripOffset.x *= scale.x;
				leftGripOffset.y *= scale.y;
				leftGripOffset.z *= scale.z;
				leftGripOffset.y -= 0.08;
				leftGripOffset.x -= 0.05;
				applyGrip('left', leftGripOffset, new THREE.Euler(-Math.PI / 2, 0, -Math.PI / 2));
			}
		}

		// Create shootable components
		if (isDual && rightWeaponMesh && leftWeaponMesh) {
			const halfFireRate = preset.fireRate / 2;
			this.rightShootableComponent = new ShootableComponent(
				preset.muzzleOffset,
				halfFireRate,
				this.createProjectileConfig(preset)
			);
			this.leftShootableComponent = new ShootableComponent(
				preset.muzzleOffset,
				halfFireRate,
				this.createProjectileConfig(preset)
			);
			this.shootableComponent = null;
			this.lastFiredRight = false;
		} else {
			this.shootableComponent = new ShootableComponent(
				preset.muzzleOffset,
				preset.fireRate,
				this.createProjectileConfig(preset)
			);
			this.rightShootableComponent = null;
			this.leftShootableComponent = null;
		}
		this.applyFireRate();

		// Initialize ammunition via magazine component
		if (this.customMagazine) {
			this.magazine = this.customMagazine;
			// Reset with the magazine's own size, not the preset's — caller configured the capacity
			this.magazine.reset(this.customMagazine.getMagazineSize(), preset.reloadDuration);
		} else {
			this.magazine = new WeaponMagazineComponent({
				magazineSize: preset.magazineSize,
				reloadDuration: preset.reloadDuration,
				autoReload: preset.autoReload,
				reloadEnabled: preset.reloadEnabled
			});
		}

		// Apply reload policy from preset (for custom magazines that were reset above)
		if (this.customMagazine) {
			if (preset.autoReload !== undefined) {
				this.magazine.setAutoReload(preset.autoReload);
			}
			if (preset.reloadEnabled !== undefined) {
				this.magazine.setReloadEnabled(preset.reloadEnabled);
			}
		}

		// Enable combat modes if controller is already set
		// (If not set yet, they'll be enabled when setController is called)
		if (this.controller) {
			this.enableCombatModes();
			// Update ammo display after equip
			this.updateAmmoDisplay();
		}

		console.log(`✅ ${preset.name} equipped${isDual ? ' (DUAL)' : ''}`);
	}

	/**
	 * Unequip current weapon.
	 */
	unequipWeapon(): void {
		// Drop the torso twist with the weapon — but never a map we don't own.
		const acTw = this.controller?.animationController;
		if (this.torsoOffsetsInstalled && acTw?.getManualBoneOffsets?.() === this.torsoOffsets) {
			acTw.setManualBoneOffsets?.(null);
		}
		this.torsoOffsetsInstalled = false;
		this.torsoTwist = 0;
		// Clear arm grips (block-arm overrides and/or skinned IK grips)
		if (this.playerLoader) {
			const blockRenderer = this.playerLoader.getBlockCharacterRenderer();
			if (blockRenderer) {
				blockRenderer.clearArmAttachmentOverride('right');
				blockRenderer.clearArmAttachmentOverride('left');
			}
			this.playerLoader.clearSkinnedArmGrip('right');
			this.playerLoader.clearSkinnedArmGrip('left');
		}

		// Remove weapon mesh
		if (this.weaponMesh && this.weaponMesh.parent) {
			this.weaponMesh.parent.remove(this.weaponMesh);
			this.weaponMesh = null;
		}

		// Clear single weapon component
		this.shootableComponent = null;
		this.weaponPreset = null;
		this.currentWeaponType = null;
		this.controller?.animationController?.setDirectionalLocomotionStyle?.('neutral');
		this.controller?.animationController?.setDirectionalLocomotionEnabled?.(false);

		// Clear dual weapon state
		this.isDualWeapon = false;
		this.rightWeaponMesh = null;
		this.leftWeaponMesh = null;
		this.rightShootableComponent = null;
		this.leftShootableComponent = null;
		this.lastFiredRight = false;

		// Reset magazine state and remove HUD counter
		this.magazine.reset(0);
		this.removeAmmoDisplay();

		// Hide reticle
		if (this.reticleShown && this.controller?.hud) {
			this.controller.hud.hideReticle();
			this.controller.hud.setReticleOffset(0);
			this.reticleShown = false;
		}
		this.gunXOffset = 0;

		// Disable combat modes
		if (this.controller && this.combatModesEnabled) {
			this.disableCombatModes();
		}
	}

	/**
	 * Get current weapon type.
	 */
	getWeaponType(): RangedWeaponTypeId | null {
		return this.currentWeaponType;
	}

	/**
	 * Check if a weapon is equipped.
	 */
	hasWeapon(): boolean {
		return this.weaponMesh !== null;
	}

	/**
	 * Get the weapon mesh group (for reading aim rotation in network sync).
	 * Returns null if no weapon is equipped.
	 */
	getWeaponMesh(): THREE.Group | null {
		return this.weaponMesh;
	}

	// ════════════════════════════════════════════════════════════════════════════════
	// Projectile Access
	// ════════════════════════════════════════════════════════════════════════════════

	/**
	 * Get all active projectiles (for NPC collision detection).
	 */
	getProjectiles(): Projectile[] {
		return this.projectiles;
	}

	/**
	 * Remove a specific projectile (called when projectile hits an NPC).
	 */
	removeProjectile(projectile: Projectile): void {
		const index = this.projectiles.indexOf(projectile);
		if (index !== -1) {
			projectile.dispose();
			this.projectiles.splice(index, 1);
		}
	}

	// ════════════════════════════════════════════════════════════════════════════════
	// State Queries
	// ════════════════════════════════════════════════════════════════════════════════

	/**
	 * Check if aim is blocked.
	 */
	isAimBlocked(): boolean {
		return this.aimBlocked;
	}

	/**
	 * Get current weapon height offset.
	 */
	getWeaponHeightOffset(): number {
		return this.weaponHeightOffset;
	}

	/**
	 * Block firing for the next `delayMs` — a one-shot gate (used after the pointer lock
	 * lands so the locking click is not also a shot). NOT the fire rate: cadence is the
	 * weapon preset's `fireRate`, changed at runtime with {@link setFireRate}.
	 */
	suppressFireFor(delayMs: number): void {
		this.shootingEnabledTime = performance.now() + delayMs;
	}

	/**
	 * @deprecated Misread as a cadence control by every reader so far — it is the one-shot
	 * gate {@link suppressFireFor}. For shots per second use {@link setFireRate}.
	 */
	setShootingDelay(delayMs: number): void {
		this.suppressFireFor(delayMs);
	}

	/**
	 * Shots per second for the equipped weapon, overriding the preset's `fireRate` (a dual
	 * weapon splits it across both hands, like the preset does). Persists across
	 * `equipWeapon`/`switchWeapon` until called again; `null` restores the preset cadence.
	 */
	setFireRate(shotsPerSecond: number | null): void {
		this.fireRateOverride = shotsPerSecond;
		this.applyFireRate();
	}

	private applyFireRate(): void {
		const preset = this.weaponPreset;
		if (!preset) return;
		const rate = this.fireRateOverride ?? preset.fireRate;
		if (this.shootableComponent) this.shootableComponent.fireRate = rate;
		if (this.rightShootableComponent) this.rightShootableComponent.fireRate = rate / 2;
		if (this.leftShootableComponent) this.leftShootableComponent.fireRate = rate / 2;
	}

	/**
	 * Get current ammunition state.
	 * @returns Object with current ammo, magazine size, and reload status
	 */
	getAmmoState(): { current: number; max: number; isReloading: boolean } {
		return this.magazine.getAmmoState();
	}

	/**
	 * Get current ammo count.
	 */
	getCurrentAmmo(): number {
		return this.magazine.getCurrentAmmo();
	}

	/**
	 * Get magazine size (max ammo).
	 */
	getMagazineSize(): number {
		return this.magazine.getMagazineSize();
	}

	/**
	 * Check if weapon is currently reloading.
	 */
	getIsReloading(): boolean {
		return this.magazine.getIsReloading();
	}

	/**
	 * Manually trigger a reload.
	 * Does nothing if reload is disabled, already reloading, or magazine is full.
	 */
	reload(): void {
		if (!this.magazine.isReloadAllowed()) return;
		this.magazine.startReload();
		this.updateAmmoDisplay();
	}

	/**
	 * Set reload duration in milliseconds.
	 * @param durationMs Reload time in milliseconds (default: 1500)
	 */
	setReloadDuration(durationMs: number): void {
		this.magazine.setReloadDuration(durationMs);
	}

	/**
	 * Set a custom magazine component.
	 * Will be used on next equipWeapon() call, or immediately if a weapon is already equipped.
	 * @param magazine - Custom IWeaponMagazine implementation
	 */
	setMagazine(magazine: IWeaponMagazine): void {
		this.customMagazine = magazine;
		// If weapon is already equipped, swap immediately (use magazine as-is, caller configured it)
		if (this.weaponPreset) {
			this.magazine = magazine;
			this.updateAmmoDisplay();
		}
	}

	/**
	 * Get the current magazine component.
	 */
	getMagazine(): IWeaponMagazine {
		return this.magazine;
	}

	/**
	 * Control whether the HUD ammo counter is displayed.
	 * - `'auto'` (default): show only when reload is enabled (finite ammo)
	 * - `true`: always show
	 * - `false`: never show
	 */
	setShowAmmoCounter(mode: 'auto' | boolean): void {
		this.ammoCounterMode = mode;
		// Apply immediately: show or hide counter based on new mode
		if (this.shouldShowAmmoCounter()) {
			this.updateAmmoDisplay();
		} else {
			this.removeAmmoDisplay();
		}
	}

	// ════════════════════════════════════════════════════════════════════════════════
	// Public Shooting Method (for action handler)
	// ════════════════════════════════════════════════════════════════════════════════

	/**
	 * Trigger a shot (called from action handler).
	 */
	triggerShoot(): void {
		if (this.effectiveAimMode === 'cursor') {
			// A trigger pull opens the 'while-firing' facing window even when no
			// shot leaves (empty magazine, reloading) — the character turning to
			// the cursor IS the feedback that the trigger registered. Face it
			// immediately so the first shot doesn't leave over the shoulder.
			this.lastCursorTriggerMs = Date.now();
			this.applyCursorFacing();
		}
		this.tryShoot();
	}

	// ════════════════════════════════════════════════════════════════════════════════
	// Private Methods
	// ════════════════════════════════════════════════════════════════════════════════

	/**
	 * Create projectile configuration from weapon preset.
	 */
	private createProjectileConfig(preset: RangedWeaponPreset): ProjectileConfig {
		// Shared with FirstPersonWeaponSystem so a weapon's bullets look and fly
		// the same in every camera mode.
		return createRangedProjectileConfig(preset, this.options.projectileColor ?? undefined);
	}

	/**
	 * Try to shoot a projectile.
	 */
	private tryShoot(): void {
		if (!this.weaponMesh || !this.engine) return;

		// Block shooting during delay period
		if (performance.now() < this.shootingEnabledTime) return;

		// Block shooting while reloading
		if (this.magazine.getIsReloading()) return;

		// Check if magazine is empty
		if (this.magazine.getCurrentAmmo() <= 0) {
			if (this.magazine.isAutoReloadEnabled()) {
				this.magazine.startReload();
				this.updateAmmoDisplay();
			}
			return;
		}

		// Handle dual weapons with alternating fire
		if (this.isDualWeapon && this.rightShootableComponent && this.leftShootableComponent &&
			this.rightWeaponMesh && this.leftWeaponMesh) {
			const shootComponent = this.lastFiredRight ? this.leftShootableComponent : this.rightShootableComponent;
			const weaponMesh = this.lastFiredRight ? this.leftWeaponMesh : this.rightWeaponMesh;
			if (this.fireShot(shootComponent, weaponMesh)) {
				this.lastFiredRight = !this.lastFiredRight;
			}
		} else if (this.shootableComponent) {
			this.fireShot(this.shootableComponent, this.weaponMesh);
		}
	}

	/**
	 * Fire a single shot from `shootComponent` using `mesh` as both the muzzle
	 * source and the recoil target, then apply the shared post-fire effects
	 * (projectile tracking, ammo consumption, recoil, camera shake, ammo HUD).
	 * @returns true if a projectile was actually spawned.
	 */
	private fireShot(shootComponent: ShootableComponent, mesh: THREE.Group): boolean {
		// The crosshair point is authoritative — shoot() converges the muzzle
		// line onto it (see ShootableComponent.shoot).
		const aimPoint = this.calculateTargetPoint();

		// One bullet, or a shotgun's pellet volley — shared with
		// FirstPersonWeaponSystem so a weapon patterns the same in either.
		const spawned = fireWeaponShot(
			shootComponent, mesh, this.physicsWorld, this.engine!, this.weaponPreset, aimPoint,
		);
		if (spawned.length === 0) return false;

		for (const projectile of spawned) {
			this.warnIfStrayShot(projectile, mesh, aimPoint);
			this.onProjectileCreated?.(projectile);
			this.projectiles.push(projectile);
		}
		this.magazine.tryConsume();

		if (this.weaponPreset?.recoilStrength) {
			this.applyRecoil(this.weaponPreset.recoilStrength, mesh);
		}

		this.applyCameraShake();
		this.updateAmmoDisplay();
		this.playFireAnimation();
		this.lastFireAnimMs = Date.now();
		return true;
	}

	/**
	 * Tripwire for stray shots. Players report the occasional bullet leaving
	 * 40°+ off the aim line during automatic fire, and four instrumented
	 * reproduction attempts (95 shots: bursts, crowds, camera wiggle, real
	 * hold-to-fire path) never caught one — so the next occurrence in ANY
	 * session must explain itself. Logs the whole aim chain at spawn; costs one
	 * dot product per shot.
	 */
	private warnIfStrayShot(
		projectile: Projectile, mesh: THREE.Group, aimPoint: THREE.Vector3 | null,
	): void {
		if (!aimPoint) return;
		const dir = projectile.getDirection();
		const spawnPos = projectile.getPosition();
		const wanted = RangedWeaponSystem._tmpStrayWanted
			.copy(aimPoint).sub(spawnPos).normalize();
		if (dir.dot(wanted) >= STRAY_SHOT_DOT_THRESHOLD) return;

		const deg = (Math.acos(Math.max(-1, Math.min(1, dir.dot(wanted)))) * 180 / Math.PI).toFixed(1);
		console.warn(
			`[RangedWeapon] STRAY SHOT ${deg}° off aim — dir(${dir.x.toFixed(2)},${dir.y.toFixed(2)},${dir.z.toFixed(2)})`
			+ ` muzzle(${spawnPos.x.toFixed(2)},${spawnPos.y.toFixed(2)},${spawnPos.z.toFixed(2)})`
			+ ` aim(${aimPoint.x.toFixed(2)},${aimPoint.y.toFixed(2)},${aimPoint.z.toFixed(2)})`
			+ ` weapon=${this.currentWeaponType} rotX=${mesh.rotation.x.toFixed(3)} rotY=${mesh.rotation.y.toFixed(3)}`,
		);
	}

	/**
	 * Load the aim/fire clip pack once per equip. Mirrors WeaponMeleeSystem's
	 * on-demand melee pack load — a game with no guns never downloads these.
	 */
	private async ensureRangedAnimations(): Promise<void> {
		const animController = this.controller?.animationController;
		if (this.rangedAnimationsLoaded || this.rangedAnimationsLoading || !animController?.loadAnimationPack) return;
		// In-flight guard, not an optimistic "loaded": a shot fired during the
		// load window used to see loaded=true with no players behind it (it
		// self-healed through playCustomAnimation's lazy path, but the flag lied).
		this.rangedAnimationsLoading = true;
		try {
			await animController.loadAnimationPack(RANGED_WEAPON_ANIMATIONS, {
				// NOT addToAttackCollection: aim/fire clips are not melee attacks
				// and must never be picked by a random startAttack() roll.
				addToAttackCollection: false,
				replaceLocomotion: false,
			});
			this.rangedAnimationsLoaded = true;
		} catch (error) {
			console.warn('[RangedWeaponSystem] failed to load ranged animation pack:', error);
		} finally {
			this.rangedAnimationsLoading = false;
		}
	}

	/**
	 * Load the strafe/backpedal pack once per aiming session. Aim modes lock
	 * the character's facing away from its travel direction — that is the
	 * moment directional locomotion starts mattering, and the first moment
	 * worth spending the download on. Until the pack arrives (or on failure)
	 * the forward clips play for every direction, exactly as before.
	 */
	private async ensureDirectionalAnimations(): Promise<void> {
		const animController = this.controller?.animationController;
		if (this.directionalAnimationsLoaded || this.directionalAnimationsLoading || !animController?.loadAnimationPack) return;
		this.directionalAnimationsLoading = true;
		try {
			await animController.loadAnimationPack(DIRECTIONAL_LOCOMOTION_ANIMATIONS, {
				addToAttackCollection: false,
				replaceLocomotion: false,
			});
			this.directionalAnimationsLoaded = true;
		} catch (error) {
			console.warn('[RangedWeaponSystem] failed to load directional locomotion pack:', error);
		} finally {
			this.directionalAnimationsLoading = false;
		}
	}

	/**
	 * Play the hold-style fire clip for the equipped weapon.
	 *
	 * Upper body only, so firing while strafing keeps the legs on the run
	 * cycle — same split WeaponMeleeSystem uses for swings. Root motion is
	 * locked by default in playCustomAnimation, so a fire clip can never move
	 * the character.
	 *
	 * The minigun's fire clip LOOPS (sustained fire has no per-shot kick worth
	 * animating); for it, a retrigger while it is already playing is a no-op and
	 * the loop is stopped on the falling edge in updateWeaponSystems (trigger
	 * released or weapon unequipped).
	 */
	private playFireAnimation(): void {
		const animController = this.controller?.animationController;
		if (!animController?.playCustomAnimation || !this.currentWeaponType) return;
		if (!this.rangedAnimationsLoaded) return;

		const moves = rangedMovesFor(this.currentWeaponType);
		if (moves.fireLoops && animController.getCustomMotionId?.() === moves.fire) return;

		animController.playCustomAnimation(moves.fire, {
			fadeInDuration: 0.04,
			fadeOutDuration: 0.10,
			splitBodyOnRun: true,
		});
	}

	/**
	 * Apply visual recoil effect to a weapon mesh.
	 */
	private applyRecoil(strength: number, mesh: THREE.Group): void {
		const originalZ = mesh.position.z;
		mesh.position.z -= strength * 0.1;

		setTimeout(() => {
			mesh.position.z = originalZ;
		}, 50);
	}

	/**
	 * Apply camera shake when firing.
	 */
	private applyCameraShake(): void {
		if (!this.controller) return;
		const camera = this.controller.getCameraController() as ThirdPersonCamera | null;
		if (!camera || !camera.applyShake) return;

		const baseIntensity = 0.03;
		const recoilMultiplier = this.weaponPreset?.recoilStrength ?? 1;
		const intensity = Math.min(baseIntensity * recoilMultiplier, 0.06);

		camera.applyShake(intensity);
	}

	/**
	 * Get the display label for the reload key (desktop only).
	 * Returns null on mobile or if desktop controls are not active.
	 */
	private getReloadKeyLabel(): string | null {
		if (!this.controller) return null;
		return this.controller.getInputLabel('secondaryAction') || null;
	}

	/**
	 * Whether the ammo counter should be visible based on current mode.
	 */
	private shouldShowAmmoCounter(): boolean {
		if (this.ammoCounterMode === true) return true;
		if (this.ammoCounterMode === false) return false;
		// 'auto': show only when reload is enabled (finite ammo)
		return this.magazine.isReloadAllowed();
	}

	/**
	 * Update the ammo display on the HUD.
	 */
	private updateAmmoDisplay(): void {
		if (!this.shouldShowAmmoCounter()) {
			this.removeAmmoDisplay();
			return;
		}

		const hud = this.controller?.hud;
		if (!hud) return;

		const ammo = this.magazine.getAmmoState();

		// Auto-create ammo counter on first use
		if (!this.ammoCounterCreated) {
			hud.createCounter(RangedWeaponSystem.AMMO_COUNTER_ID, {
				anchor: 'bottom-right',
				initialValue: Number.isFinite(ammo.current) ? ammo.current : 0,
				// Arrow function: reads live state from this.magazine on each format call
				format: (v: number) => {
					const state = this.magazine.getAmmoState();
					// Infinite magazine (size 0): no count, no reload prompt.
					if (state.max === 0) return '∞';
					if (state.isReloading) {
						return `${v}/${state.max} RELOADING`;
					}
					if (v <= 0 && this.reloadHandlerActive) {
						const keyLabel = this.getReloadKeyLabel();
						if (keyLabel) {
							const reloadText = t('game.controlsGuide.reload');
							return `${v}/${state.max} [${keyLabel}] ${reloadText}`;
						}
					}
					return `${v}/${state.max}`;
				}
			});
			this.ammoCounterCreated = true;
		}

		// Update the counter value — GameHUD re-runs the format function
		hud.updateCounter(RangedWeaponSystem.AMMO_COUNTER_ID, Number.isFinite(ammo.current) ? ammo.current : 0);
	}

	/**
	 * Remove the ammo counter from the HUD.
	 */
	private removeAmmoDisplay(): void {
		if (this.ammoCounterCreated) {
			this.controller?.hud?.removeElement(RangedWeaponSystem.AMMO_COUNTER_ID);
			this.ammoCounterCreated = false;
		}
	}

	/**
	 * Update all active projectiles.
	 */
	private updateProjectiles(deltaTime: number): void {
		this.projectiles = this.projectiles.filter(projectile => {
			projectile.update(deltaTime);

			if (projectile.isExpired()) {
				projectile.dispose();
				return false;
			}
			return true;
		});
	}

	/**
	 * Detect weapon clearance.
	 */
	private detectWeaponClearance(deltaTime: number): void {
		if (!this.weaponMesh || !this.weaponPreset) {
			this.targetWeaponOffset = 0;
			this.aimBlocked = false;
			return;
		}

		this.weaponMesh.updateMatrixWorld(true);
		const muzzleOffset = this.weaponPreset.muzzleOffset;
		const muzzleWorldPos = new THREE.Vector3();
		this.weaponMesh.localToWorld(muzzleWorldPos.copy(muzzleOffset));
		muzzleWorldPos.y -= this.weaponHeightOffset;

		const targetPoint = this.calculateTargetPoint();
		if (!targetPoint) {
			this.targetWeaponOffset = 0;
			this.aimBlocked = false;
			return;
		}
		this.lastTargetPoint.copy(targetPoint);

		const aimDirection = targetPoint.clone().sub(muzzleWorldPos).normalize();
		const distanceToTarget = muzzleWorldPos.distanceTo(targetPoint);
		const checkDistance = Math.min(3.0, distanceToTarget);

		const rayResult = this.physicsWorld.raycast(
			muzzleWorldPos,
			aimDirection,
			checkDistance,
			CollisionGroup.ENVIRONMENT
		);

		const characterHeight = this.playerLoader?.getCapsuleHeight?.() ?? 1.75;
		const eyeHeight = characterHeight * 0.85;
		const maxRaise = Math.max(0, eyeHeight - this.weaponBaselineHeight);

		if (!rayResult.hasHit) {
			if (this.targetWeaponOffset > this.clearanceHysteresis) {
				this.targetWeaponOffset = 0;
			}
			this.aimBlocked = false;
		} else {
			const neededRaise = this.findMinimumClearance(
				muzzleWorldPos,
				targetPoint,
				0,
				maxRaise,
				checkDistance
			);

			if (neededRaise < 0) {
				this.aimBlocked = true;
				this.targetWeaponOffset = maxRaise;
			} else {
				this.aimBlocked = false;
				const diff = Math.abs(neededRaise - this.targetWeaponOffset);
				if (diff > this.clearanceHysteresis) {
					this.targetWeaponOffset = neededRaise;
				}
			}
		}

		// Update reticle color (no reticle exists in cursor mode)
		if (this.effectiveAimMode === 'camera') {
			this.controller?.hud?.setReticleBlocked(this.aimBlocked);
		}

		// Smooth transition
		const transitionDelta = this.weaponTransitionSpeed * deltaTime;
		if (this.weaponHeightOffset < this.targetWeaponOffset) {
			this.weaponHeightOffset = Math.min(this.weaponHeightOffset + transitionDelta, this.targetWeaponOffset);
		} else if (this.weaponHeightOffset > this.targetWeaponOffset) {
			this.weaponHeightOffset = Math.max(this.weaponHeightOffset - transitionDelta, this.targetWeaponOffset);
		}
	}

	/**
	 * Calculate where the weapon is aiming: the camera-center convergence point
	 * in camera mode, the cursor direction in cursor mode.
	 */
	private calculateTargetPoint(): THREE.Vector3 | null {
		const sideOnZ = this.sideOnPlaneZ();
		if (sideOnZ !== null) return this.sideOnAimPoint(sideOnZ);

		if (this.effectiveAimMode === 'cursor') {
			const groundPoint = this.cursorGroundPointThisFrame;
			if (!groundPoint || !this.weaponMesh) return groundPoint;
			// Top-down shots fly horizontally: the ground point picks the yaw, but the
			// pitch target sits at muzzle height — aiming at the ground point itself
			// would tilt the gun down and plant projectiles in the ground.
			this.weaponMesh.updateMatrixWorld(true);
			const gunWorldPos = new THREE.Vector3();
			this.weaponMesh.getWorldPosition(gunWorldPos);
			const target = groundPoint.clone();
			target.y = gunWorldPos.y;
			return target;
		}

		if (!this.controller) return null;
		const cameraController = this.controller.getCameraController() as { getCamera?: () => THREE.PerspectiveCamera };
		if (!cameraController?.getCamera) return null;

		// Shared with FirstPersonWeaponSystem — see weapons/CameraAim.ts for why
		// the ray goes through the crosshair and starts past the player.
		return calculateCameraAimPoint(
			cameraController.getCamera(),
			this.player ?? this.controller.player,
			this.physicsWorld,
		);
	}

	/**
	 * Side-on lane: a shot only travels in X/Y, so the aim point must lie IN the
	 * gameplay plane — the cursor projected onto z = planeZ. That is what a
	 * sidescroller wants: aim up, down and along, at the mouse. Before the first
	 * mouse move (and on touch) null hands the shot back to the barrel
	 * direction, which is wherever the character is facing.
	 */
	private sideOnAimPoint(planeZ: number): THREE.Vector3 | null {
		this.sideOnAimPlane.constant = -planeZ;
		return this.projectCursorOntoPlane(this.sideOnAimPlane);
	}

	/**
	 * Project the cursor through the camera onto the horizontal plane at player height.
	 * Called once per frame from update() in cursor mode and stored in
	 * `cursorGroundPointThisFrame`; consumers within the same update should read
	 * that field instead of calling this method directly.
	 */
	private getCursorGroundPoint(): THREE.Vector3 | null {
		if (!this.player) return null;
		this.cursorGroundPlane.constant = -this.player.position.y;
		return this.projectCursorOntoPlane(this.cursorGroundPlane);
	}

	/**
	 * Where the cursor's camera ray meets `plane`, in world space. Null when
	 * there is no cursor yet (before the first mousemove, and on touch), no
	 * camera or renderer to project through, or the ray runs parallel to the
	 * plane. Both aim planes share this: the horizontal ground plane top-down,
	 * the gameplay plane itself side-on.
	 */
	private projectCursorOntoPlane(plane: THREE.Plane): THREE.Vector3 | null {
		if (this.cursorClientX === null || this.cursorClientY === null) return null;
		const threeCamera = (this.controller?.getCameraController() as Partial<ICameraController> | null)?.getCamera?.();
		if (!threeCamera || !this.engine?.renderer) return null;

		const rect = this.engine.renderer.domElement.getBoundingClientRect();
		const ndcX = ((this.cursorClientX - rect.left) / rect.width) * 2 - 1;
		const ndcY = -((this.cursorClientY - rect.top) / rect.height) * 2 + 1;
		this.cursorRaycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), threeCamera);

		const hit = new THREE.Vector3();
		return this.cursorRaycaster.ray.intersectPlane(plane, hit) ? hit : null;
	}

	/**
	 * Per-frame cursor-facing driver. In 'while-firing' mode (the default) the
	 * cursor only steers the character inside the firing window — while the
	 * trigger is held plus CURSOR_FACING_LINGER_MS after release; outside it,
	 * movement-driven facing stays in charge and this is a no-op. In 'always'
	 * mode the cursor steers the character every frame (classic twin-stick).
	 */
	private updateCursorAim(): void {
		const whileFiring = this.cursorFacing() === 'while-firing';
		if (whileFiring && Date.now() - this.lastCursorTriggerMs > CURSOR_FACING_LINGER_MS) {
			this.torsoOnlyAim = false;
			return;
		}

		// Inside the firing window: prefer aiming with the TORSO and leave the
		// body to its travel direction (legs keep the forward cycle). Rotate
		// the body — handing the legs to the strafe/backpedal clips — only
		// when the cursor is beyond torso reach, or the player is standing
		// still. 'always' (twin-stick) keeps the classic hard body facing.
		if (whileFiring) {
			const target = this.cursorGroundPointThisFrame;
			const moving = this._movementSpeed >= RangedWeaponSystem.TORSO_AIM_MIN_SPEED;
			if (target && this.player && moving) {
				const dx = target.x - this.player.position.x;
				const dz = target.z - this.player.position.z;
				if (dx * dx + dz * dz >= 0.25) {
					const a = Math.abs(wrapToPi(Math.atan2(dx, dz) - this._movementYaw));
					// Hysteresis so the boundary can't flap regimes per frame.
					this.torsoOnlyAim = this.torsoOnlyAim
						? a <= RangedWeaponSystem.TORSO_ONLY_EXIT_RAD
						: a <= RangedWeaponSystem.TORSO_ONLY_ENTER_RAD;
				}
			} else {
				this.torsoOnlyAim = false;
			}
			if (this.torsoOnlyAim) return; // movement owns the body; twist aims
		}
		this.applyCursorFacing();
	}

	/**
	 * In the 'cover' posture, rise over the top while aiming/firing and drop
	 * back when not. "Aiming" = trigger held or within the firing linger in
	 * cursor mode; in camera-aim mode the player is always aiming while a gun
	 * is out, so entering cover with a gun peeks and holstering drops.
	 */
	private updateCoverPeek(): void {
		const pc = this.controller;
		if (!pc?.getPosture || pc.getPosture() !== 'cover' || !pc.setCoverPeek) return;
		const aiming = !!this.weaponMesh && (
			this.effectiveAimMode === 'camera'
			|| Date.now() - this.lastCursorTriggerMs <= CURSOR_FACING_LINGER_MS
		);
		pc.setCoverPeek(aiming);
	}

	/**
	 * Twist the torso toward the cursor, independent of the legs.
	 *
	 * Target is the clamped yaw delta between the aim direction and the body;
	 * outside cursor mode (or with no cursor point) the target is 0 and the
	 * twist decays out, uninstalling its offsets at rest. Ownership rule: the
	 * manual-offset slot is shared (ski stances use it too), so this never
	 * overwrites a map another system installed — it only writes when the slot
	 * is empty or already ours.
	 */
	private updateTorsoAim(deltaTime: number): void {
		const ac = this.controller?.animationController;
		if (!ac?.setManualBoneOffsets || !ac.getManualBoneOffsets) return;

		let target = 0;
		const aimPoint = this.cursorGroundPointThisFrame;
		// "Aimed at the mouse only while actively shooting": outside the firing
		// window (trigger held + linger) the twist target is 0 and the torso
		// returns to the run. 'always' mode has no window — but there the body
		// faces the cursor anyway, so the delta (and the twist) stays ~0.
		const withinAimWindow = this.cursorFacing() !== 'while-firing'
			|| Date.now() - this.lastCursorTriggerMs <= CURSOR_FACING_LINGER_MS;
		if (withinAimWindow && this.effectiveAimMode === 'cursor' && this.weaponMesh && aimPoint && this.player) {
			const dx = aimPoint.x - this.player.position.x;
			const dz = aimPoint.z - this.player.position.z;
			if (dx * dx + dz * dz >= 0.25) {
				const delta = wrapToPi(Math.atan2(dx, dz) - this.player.rotation.y);
				target = Math.max(-RangedWeaponSystem.TORSO_TWIST_MAX,
					Math.min(RangedWeaponSystem.TORSO_TWIST_MAX, delta));
			}
		}

		this.torsoTwist += (target - this.torsoTwist)
			* Math.min(1, 1 - Math.exp(-deltaTime * RangedWeaponSystem.TORSO_TWIST_SHARPNESS));

		const installed = ac.getManualBoneOffsets();
		const slotIsOurs = installed === this.torsoOffsets;
		if (Math.abs(this.torsoTwist) < 0.015) {
			if (slotIsOurs) {
				ac.setManualBoneOffsets(null);
				this.torsoOffsetsInstalled = false;
			}
			return;
		}
		if (installed && !slotIsOurs) return; // someone else (ski stance) owns the slot

		this.torsoOffsets.get('torso')!.setFromAxisAngle(RangedWeaponSystem._yAxis, this.torsoTwist * RangedWeaponSystem.TWIST_SHARE_SPINE);
		this.torsoOffsets.get('neck')!.setFromAxisAngle(RangedWeaponSystem._yAxis, this.torsoTwist * RangedWeaponSystem.TWIST_SHARE_NECK);
		this.torsoOffsets.get('head')!.setFromAxisAngle(RangedWeaponSystem._yAxis, this.torsoTwist * RangedWeaponSystem.TWIST_SHARE_HEAD);
		if (!slotIsOurs) {
			ac.setManualBoneOffsets(this.torsoOffsets);
			this.torsoOffsetsInstalled = true;
		}
	}

	/**
	 * Rotate the player to face the ground point under the cursor.
	 * Runs inside PlayerController.update() AFTER movementSystem.update()
	 * (PlayerController.ts:2378 vs :2330), so this yaw wins over movement-driven
	 * rotation before the genre's syncPlayerPhysics applies it to the mesh.
	 * On touch devices no mousemove ever fires and this stays inert.
	 */
	private applyCursorFacing(): void {
		if (!this.player || !this.controller) return;
		const target = this.cursorGroundPointThisFrame;
		if (!target) return;

		const dx = target.x - this.player.position.x;
		const dz = target.z - this.player.position.z;
		// 0.5 m deadzone so cursor positions on top of the player don't spin them
		if (dx * dx + dz * dz < 0.25) return;

		// +Z gameplay forward convention: yaw = atan2(facing.x, facing.z)
		const yaw = Math.atan2(dx, dz);
		this.controller.getMovementSystem().setRotation?.(yaw);
		// Movement already wrote player.rotation.y this frame when moving — overwrite it
		this.player.rotation.y = yaw;
	}

	/**
	 * Binary search to find minimum weapon raise needed.
	 */
	private findMinimumClearance(
		baseMuzzlePos: THREE.Vector3,
		targetPoint: THREE.Vector3,
		lowRaise: number,
		highRaise: number,
		checkDistance: number
	): number {
		const rayOrigin = new THREE.Vector3();
		const iterations = 6;

		rayOrigin.copy(baseMuzzlePos);
		rayOrigin.y += highRaise;
		const aimDir = targetPoint.clone().sub(rayOrigin).normalize();
		const maxRaiseResult = this.physicsWorld.raycast(
			rayOrigin,
			aimDir,
			checkDistance,
			CollisionGroup.ENVIRONMENT
		);
		if (maxRaiseResult.hasHit) {
			return -1;
		}

		let low = lowRaise;
		let high = highRaise;

		for (let i = 0; i < iterations; i++) {
			const mid = (low + high) / 2;
			rayOrigin.copy(baseMuzzlePos);
			rayOrigin.y += mid;
			const direction = targetPoint.clone().sub(rayOrigin).normalize();

			const result = this.physicsWorld.raycast(
				rayOrigin,
				direction,
				checkDistance,
				CollisionGroup.ENVIRONMENT
			);

			if (result.hasHit) {
				low = mid;
			} else {
				high = mid;
			}
		}

		return high + 0.08;
	}

	/**
	 * Update weapon position to follow animated shoulder.
	 */
	private updateWeaponHeight(): void {
		if (!this.weaponMesh || !this.player) return;

		const rightShoulder = this.getBodyPartObject(this.player, 'rightUpperArm');
		if (!rightShoulder) return;

		rightShoulder.updateMatrixWorld(true);
		const shoulderWorldPos = new THREE.Vector3();
		rightShoulder.getWorldPosition(shoulderWorldPos);

		this.player.updateMatrixWorld(true);
		const playerWorldPos = new THREE.Vector3();
		this.player.getWorldPosition(playerWorldPos);
		const playerQuat = new THREE.Quaternion();
		this.player.getWorldQuaternion(playerQuat);

		const shoulderLocal = shoulderWorldPos.clone().sub(playerWorldPos);
		shoulderLocal.applyQuaternion(playerQuat.clone().invert());

		const renderSkinned = this.playerLoader?.isRenderingSkinnedMesh() === true;
		const hold = renderSkinned ? SKINNED_RANGED_HOLD[this.isDualWeapon ? 'dual' : this.weaponPreset?.hands === 2 ? 'rifle' : 'single'] : null;
		const additionalXOffset = (this.weaponPreset?.xOffset ?? 0) + (hold?.inward ?? 0);
		const xPos = this.isDualWeapon ? additionalXOffset : (shoulderLocal.x + additionalXOffset);

		// Authoritative per-frame height, using the same hold as initial equip.
		const heightOffset = this.weaponPreset?.heightOffset ?? 0.2;
		this.weaponBaselineHeight = this.sanitizeShoulderHeight(shoulderLocal.y) + heightOffset
			- (hold?.drop ?? 0);

		const isFirstPerson = this.getCameraMode() === 'first-person';
		const firstPersonHeightOffset = isFirstPerson ? 0.05 : 0;
		const yPos = this.weaponBaselineHeight + this.weaponHeightOffset + firstPersonHeightOffset;

		const firstPersonForwardOffset = isFirstPerson ? -1.0 : 0;
		const zPos = this.weaponBaseForwardOffset + firstPersonForwardOffset;

		this.weaponMesh.position.set(xPos, yPos, zPos);

		// Calculate aim rotation toward the current target point (camera center
		// in camera mode, cursor ground point in cursor mode)
		const targetPoint = this.calculateTargetPoint();
		if (!targetPoint) return;

		this.weaponMesh.updateMatrixWorld(true);
		const gunWorldPos = new THREE.Vector3();
		this.weaponMesh.getWorldPosition(gunWorldPos);

		const aimDirWorld = targetPoint.clone().sub(gunWorldPos).normalize();
		const aimDirLocal = aimDirWorld.clone().applyQuaternion(playerQuat.clone().invert());

		const yawAngle = Math.atan2(aimDirLocal.x, aimDirLocal.z);
		const horizontalDist = Math.sqrt(aimDirLocal.x * aimDirLocal.x + aimDirLocal.z * aimDirLocal.z);
		const pitchAngle = Math.atan2(aimDirLocal.y, horizontalDist);

		// A HELD gun cannot swivel independently of the body holding it — the
		// wrist has nothing like that range. The weapon mesh is parented to the
		// player, not to the hand bone, so writing the raw aim yaw here reads
		// as the pistol spinning at the wrist. That is only visible in cursor
		// mode, where the body legitimately faces somewhere other than the aim
		// point; in camera/first-person modes the body IS the aim direction and
		// this yaw is ~0 anyway.
		//
		// The gun turns by exactly what the hand turns by: the spine share of
		// the torso twist (the arm hangs off the spine). Aim accuracy is
		// unaffected — projectile direction converges muzzle→aimPoint in
		// ShootableComponent.shoot, independent of how the mesh is posed.
		this.weaponMesh.rotation.order = 'YXZ';
		this.weaponMesh.rotation.y = this.effectiveAimMode === 'cursor'
			? this.torsoTwist * RangedWeaponSystem.TWIST_SHARE_SPINE
			: yawAngle;
		this.weaponMesh.rotation.x = -pitchAngle;
	}

	/**
	 * Clamp a shoulder-derived local height to a sane humanoid band.
	 * Custom GLB character looks can make the rightUpperArm lookup return a
	 * bone whose world position is unrelated to the visible body (bind pose /
	 * hidden block rig), which would otherwise park the gun — and the bullets
	 * fired from its muzzle — underground or in the sky.
	 */
	private sanitizeShoulderHeight(localY: number): number {
		const characterHeight = this.playerLoader?.getCapsuleHeight?.() ?? 1.75;
		if (localY < 0.25 * characterHeight || localY > 1.4 * characterHeight) {
			return 0.55 * characterHeight;
		}
		return localY;
	}

	/**
	 * Get a body part object from the player.
	 */
	private getBodyPartObject(player: THREE.Object3D, bodyPartName: string): THREE.Object3D | null {
		// Try block character first. In skinned-render mode the block character
		// is hidden and frozen at the spawn pose, so its parts must not be used
		// as position references — fall through to the real skeleton bones.
		if (this.playerLoader && !this.playerLoader.isRenderingSkinnedMesh()) {
			const blockRenderer = this.playerLoader.getBlockCharacterRenderer();
			if (blockRenderer) {
				const blockRoot = blockRenderer.getRoot();
				let bodyPart: THREE.Object3D | null = null;
				blockRoot.traverse((child: THREE.Object3D) => {
					if (child.name === bodyPartName) {
						bodyPart = child;
					}
				});
				if (bodyPart) return bodyPart;
			}
		}

		// Fallback: skeleton bones. Search inside the skinned skeleton root when
		// available — the player group also holds invisible full-skeleton clones
		// with identical bone names (action layer, Mixamo track skeletons), and
		// a group-wide search can land on one of those.
		const possibleBoneNames = this.mapBodyPartNameToBoneNames(bodyPartName);
		const searchRoot = this.playerLoader?.getSkinnedSkeletonRoot() ?? player;
		return findBoneByCandidates(searchRoot, possibleBoneNames);
	}

	/**
	 * Map body part name to possible bone names.
	 */
	private mapBodyPartNameToBoneNames(bodyPartName: string): string[] {
		return BODY_PART_BONE_NAMES[bodyPartName] || [bodyPartName];
	}

	/**
	 * Camera mode of the active camera controller, or null when none is attached.
	 * Vehicle cameras don't implement ICameraController and report null (camera-aim).
	 */
	private getCameraMode(): CameraMode | null {
		const cam = this.controller?.getCameraController() as Partial<ICameraController> | null;
		return typeof cam?.getMode === 'function' ? cam.getMode() : null;
	}

	/** Resolve the configured aim mode to the effective one for this frame. */
	private resolveAimMode(): 'camera' | 'cursor' {
		// Side-on (2D lane): 'cursor', whatever was asked for. Camera aim locks
		// the player to the camera and shows a crosshair down the view axis —
		// on a side view that faces the character AT the camera and aims the
		// barrel out of the gameplay plane, where no shot can travel. Cursor
		// mode does none of that, and `sideOnAimPoint` aims it in the plane.
		if (this.sideOnPlaneZ() !== null) return 'cursor';
		if (this.options.aimMode !== 'auto') return this.options.aimMode;
		return this.getCameraMode() === 'top-down' ? 'cursor' : 'camera';
	}

	/** The configured cursor-aim facing behaviour; the option is optional, 'while-firing' is the default. */
	private cursorFacing(): RangedWeaponCursorFacing {
		return this.options.cursorFacing ?? 'while-firing';
	}

	/** The gameplay plane's Z when this game collides side-on (X/Y); null on every other lane. */
	private sideOnPlaneZ(): number | null {
		const world = this.physicsWorld;
		return isPlaneLockedPhysics(world) && world.orientation === 'xy' ? world.planeZ : null;
	}

	/**
	 * Enable combat modes. Common: shoot action handler + reload visibility.
	 * Camera-aim mode additionally locks the player to the camera, offsets the
	 * combat camera, and shows the reticle; cursor mode deliberately does none
	 * of that (the cursor-aim driver in update() handles facing).
	 * Called when both controller is set AND weapon is equipped.
	 */
	private enableCombatModes(): void {
		if (!this.controller || this.combatModesEnabled) return;

		this.effectiveAimMode = this.resolveAimMode();
		if (this.effectiveAimMode === 'camera') {
			this.enableCameraAim();
		}

		// Set up shoot action handler (continuous: hold-to-fire on both desktop and mobile)
		this.controller.setActionHandler('shoot', () => {
			this.triggerShoot();
		}, { continuous: true });

		// Show reload button only when reload is actually possible
		this.updateReloadVisibility();

		// Show controls briefly so player sees the reload key
		if (this.reloadHandlerActive) {
			this.controller.hud?.showControlsTemporarily();
		}

		this.combatModesEnabled = true;
		console.log(`🎯 RangedWeaponSystem: Combat modes enabled (${this.effectiveAimMode} aim)`);
	}

	/** Camera-center aiming: lock player to camera, combat camera offset, center reticle. */
	private enableCameraAim(): void {
		if (!this.controller) return;
		this.controller.animationController?.setDirectionalLocomotionEnabled?.(true);
		// Facing is about to lock to the camera — strafing begins here.
		void this.ensureDirectionalAnimations();
		const cameraController = this.controller.getCameraController();
		const ms = this.controller.getMovementSystem();

		// Enable camera lock rotation (player always faces camera direction)
		if (ms.setCameraLockRotation) {
			ms.setCameraLockRotation(true);
		}

		// Set camera controller reference for rotation calculation
		if (cameraController && ms.setCameraController && 'getHorizontalAngle' in cameraController) {
			ms.setCameraController(cameraController as { getHorizontalAngle: () => number });
		}

		// Enable combat mode camera (positions player lower on screen for aiming)
		const camera = cameraController as { setCombatMode?: (enabled: boolean) => void };
		camera?.setCombatMode?.(true);

		// Show reticle
		const hud = this.controller.hud;
		if (hud) {
			hud.showReticle();
			hud.setReticleOffset(0);
			this.reticleShown = true;
		}
	}

	/** Tear down camera-center aiming (used on unequip and on aim-mode transitions). */
	private disableCameraAim(): void {
		if (!this.controller) return;
		const cameraController = this.controller.getCameraController();
		const ms = this.controller.getMovementSystem();

		// Disable camera lock rotation
		if (ms.setCameraLockRotation) {
			ms.setCameraLockRotation(false);
		}

		// Disable combat mode camera
		const camera = cameraController as { setCombatMode?: (enabled: boolean) => void };
		camera?.setCombatMode?.(false);

		// Hide reticle
		if (this.reticleShown && this.controller.hud) {
			this.controller.hud.hideReticle();
			this.controller.hud.setReticleOffset(0);
			this.reticleShown = false;
		}
	}

	/**
	 * Dynamically show/hide the reload secondary action based on current ammo state.
	 * Shows reload button only when reload is allowed AND magazine is not full.
	 */
	private updateReloadVisibility(): void {
		if (!this.controller || !this.combatModesEnabled) return;

		const shouldShow = this.magazine.isReloadAllowed() &&
			this.magazine.getCurrentAmmo() < this.magazine.getMagazineSize();

		if (shouldShow && !this.reloadHandlerActive) {
			this.controller.setSecondaryActionHandler('reload', () => {
				if (!this.magazine.getIsReloading() &&
					this.magazine.getCurrentAmmo() < this.magazine.getMagazineSize()) {
					this.magazine.startReload();
					this.updateAmmoDisplay();
				}
			});
			this.reloadHandlerActive = true;
			// Refresh ammo display so format function can show reload key hint
			this.updateAmmoDisplay();
		} else if (!shouldShow && this.reloadHandlerActive) {
			this.controller.setSecondaryActionHandler(null, null);
			this.reloadHandlerActive = false;
			// Refresh ammo display to remove reload key hint
			this.updateAmmoDisplay();
		}
	}

	/**
	 * Disable all combat modes.
	 * Called when weapon is unequipped.
	 */
	private disableCombatModes(): void {
		if (!this.controller || !this.combatModesEnabled) return;

		this.disableCameraAim();

		// Clear shoot action handler
		this.controller.setActionHandler(null, null);

		// Clear reload secondary action
		this.controller.setSecondaryActionHandler(null, null);
		this.reloadHandlerActive = false;

		this.combatModesEnabled = false;
		console.log('🎯 RangedWeaponSystem: Combat modes disabled');
	}
}

// ════════════════════════════════════════════════════════════════════════════════
// ONE-STEP INSTALL (use this — see installRangedWeapon below)
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Everything a ranged-weapon install can be told, in one place.
 *
 * Every field is required so the type IS the documentation; spread
 * {@link DEFAULT_RANGED_WEAPON_INSTALL_OPTIONS} (or use the `Partial` shorthand
 * {@link installRangedWeapon} accepts) to override just what you care about.
 */
export interface RangedWeaponInstallOptions {
	/**
	 * How the weapon decides where the player is aiming.
	 * `'auto'` (default) picks cursor aiming under a top-down camera and
	 * camera-center aiming everywhere else — force `'cursor'` when the game
	 * must aim at the visible mouse pointer regardless of camera.
	 */
	aim: RangedWeaponAimMode;
	/** Cursor-aim facing behavior. Ignored while the effective aim mode is 'camera'. */
	cursorFacing: RangedWeaponCursorFacing;
	/** Projectile + trail color override; null keeps the weapon preset's color. */
	projectileColor: number | null;
	/** Rounds per magazine; null keeps the weapon preset's `magazineSize`. */
	magazineSize: number | null;
	/** Reload time in ms; null keeps the weapon preset's `reloadDuration`. */
	reloadDurationMs: number | null;
	/**
	 * Shots per second; null keeps the weapon preset's `fireRate`. This is the cadence
	 * knob — `setShootingDelay` is not (it is a one-shot suppression gate).
	 */
	fireRate: number | null;
	/**
	 * HUD ammo counter (bottom-right `current/max`). `'auto'` shows it whenever
	 * the weapon has finite ammo; `true` always shows it (including `∞`).
	 */
	showAmmoCounter: 'auto' | boolean;
}

export const DEFAULT_RANGED_WEAPON_INSTALL_OPTIONS: RangedWeaponInstallOptions = {
	aim: 'auto',
	cursorFacing: 'while-firing',
	projectileColor: null,
	magazineSize: null,
	reloadDurationMs: null,
	fireRate: null,
	showAmmoCounter: 'auto',
};

/**
 * Live handle to an installed ranged weapon, returned by {@link installRangedWeapon}.
 * Keep it if the game switches or removes weapons; otherwise ignore it — the
 * install cleans itself up with the PlayerController.
 */
export interface RangedWeaponHandle {
	/**
	 * The underlying component, for the low-level knobs the high-level options
	 * don't cover (`onProjectileCreated`, `setMagazine`, `getProjectiles`, …).
	 */
	readonly system: RangedWeaponSystem;
	/** The weapon this install holds — the pending type while the character is still loading. */
	getWeaponType(): RangedWeaponTypeId;
	/** True once the weapon mesh actually exists on the character. */
	isEquipped(): boolean;
	/** Swap weapons in place. Safe before OR after the character is ready. */
	switchWeapon(weaponType: RangedWeaponTypeId): void;
	/** Unequip, detach from the controller and dispose. Safe to call twice. */
	remove(): void;
}

/**
 * ════════════════════════════════════════════════════════════════════════════
 * 🔫 INSTALL A RANGED WEAPON — ONE CALL, NOTHING ELSE TO WIRE
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Top-down arena, pistol that fires at the visible mouse cursor with the ammo
 * count on the HUD (see @docs combat-system.md for the type-checked sample):
 *
 *     installRangedWeapon(this.playerController, 'pistol',
 *         { aim: 'cursor', showAmmoCounter: true });
 *
 * This owns the whole install invariant, which is otherwise four separate
 * things a template has to get right *and order correctly*:
 * - constructs the {@link RangedWeaponSystem} from the controller's engine +
 *   physics world with the aim/cursor/projectile options,
 * - registers it via `setAttackSystem` — which wires the controller reference,
 *   the mouse/keyboard listeners, mobile controls, the per-frame tick and the
 *   disposal path,
 * - equips the weapon **readiness-safely**: called before the character has
 *   loaded it equips on `onCharacterReady`, called after it equips at once —
 *   so the gun, the shoot action (hold-to-fire on key, click and mobile
 *   button) and the ammo counter always appear,
 * - applies the ammo options once the weapon (and therefore its magazine) exists.
 *
 * The low-level API is untouched: `new RangedWeaponSystem(...)` +
 * `equipWeapon()` + `setAttackSystem()` still work for games that need to
 * interleave their own steps. Reach for them only when this helper can't
 * express what you want — and you can always get there from `handle.system`.
 *
 * @param controller - The player's controller; hosts the install.
 * @param weaponType - Built-in id (`'pistol'`, `'assault_rifle'`, `'bow'`, …) or
 *                     a `RangedWeaponRegistry.register()`ed custom id.
 * @param options - Partial overrides of {@link DEFAULT_RANGED_WEAPON_INSTALL_OPTIONS}.
 * @returns A {@link RangedWeaponHandle} for switching or removing the weapon.
 */
export function installRangedWeapon(
	controller: PlayerController,
	weaponType: RangedWeaponTypeId,
	options: Partial<RangedWeaponInstallOptions> = {}
): RangedWeaponHandle {
	const opts: RangedWeaponInstallOptions = { ...DEFAULT_RANGED_WEAPON_INSTALL_OPTIONS, ...options };

	const system = new RangedWeaponSystem(controller.engine, controller.physicsWorld, {
		aimMode: opts.aim,
		projectileColor: opts.projectileColor,
		cursorFacing: opts.cursorFacing,
	});

	// Magazine size is baked into the magazine component, so it has to be in
	// place BEFORE the first equip (equipWeapon resets a custom magazine to its
	// own size). Reload duration is applied after each equip instead — equip
	// stamps the preset's duration over whatever the magazine carried.
	if (opts.magazineSize !== null) {
		system.setMagazine(new WeaponMagazineComponent({
			magazineSize: opts.magazineSize,
			reloadDuration: opts.reloadDurationMs ?? undefined,
		}));
	}

	// Registration before equip: the system gets its controller, listeners,
	// mobile controls, per-frame update and disposal from this one call.
	controller.setAttackSystem(system);

	let requested: RangedWeaponTypeId = weaponType;
	let removed = false;
	let characterReady = false;

	/** False once this install has been removed or replaced by another one. */
	const stillOurs = (): boolean => !removed && controller.getAttackSystem() === system;

	const equipNow = (): void => {
		if (!stillOurs()) return;
		const playerLoader = controller.playerLoader;
		if (!playerLoader) {
			console.error(
				'❌ installRangedWeapon: the character is ready but PlayerController.playerLoader is null,\n' +
				'   so there is nothing to attach the weapon to. Install after the player has been loaded.'
			);
			return;
		}
		system.equipWeapon(requested, controller.player, playerLoader);
		if (opts.reloadDurationMs !== null) {
			system.setReloadDuration(opts.reloadDurationMs);
		}
		if (opts.fireRate !== null) {
			system.setFireRate(opts.fireRate);
		}
		system.setShowAmmoCounter(opts.showAmmoCounter);
	};

	// Exactly one readiness listener for the lifetime of the install: a
	// switchWeapon() before the character loads just changes what this equips.
	// Fires synchronously when the character is already ready.
	controller.onCharacterReady(() => {
		characterReady = true;
		equipNow();
	});

	return {
		system,
		getWeaponType: () => requested,
		isEquipped: () => stillOurs() && system.hasWeapon(),
		switchWeapon: (nextWeaponType: RangedWeaponTypeId) => {
			if (removed) return;
			requested = nextWeaponType;
			if (characterReady) equipNow();
		},
		remove: () => {
			if (removed) return;
			removed = true;
			if (controller.getAttackSystem() === system) {
				// Also removes listeners and disposes — see setAttackSystem.
				controller.setAttackSystem(null);
			} else {
				system.dispose();
			}
		},
	};
}
