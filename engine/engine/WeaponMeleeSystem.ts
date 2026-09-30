/**
 * @fileoverview Weapon-based Melee Combat System (Component)
 *
 * This file handles melee combat for WEAPONS (swords, axes, spears, etc).
 * For unarmed combat (punches, kicks), see UnarmedMeleeSystem.ts
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * 🗡️ WEAPON MELEE SYSTEM (COMPONENT)
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * A pluggable combat component that can be attached to ANY PlayerController.
 * Implements the IPlayerAttack interface for seamless integration.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * ⚠️ HOW WEAPON HIT DETECTION WORKS (AI AGENTS: READ THIS!)
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * Weapons use **RAYCASTING** (blade sweep), NOT physics body collisions!
 *
 * ❌ WRONG - Physics manifolds (`dispatcher.getNumManifolds()`) will NOT detect
 * weapon hits; they only see body-to-body collisions.
 *
 * ✅ CORRECT - Hits are detected automatically via IDamageable interface:
 * 1. This system casts rays along weapon blade each frame (blade sweep)
 * 2. Rays hit mesh → checks mesh.userData.damageableController
 * 3. Calls damageableController.onMeleeHit(direction, impulseStrength)
 * 4. Target (NPC/Animal) handles damage, death, explosion
 *
 * To make an entity hittable, it must have on ALL its meshes:
 * - mesh.userData.physicsBody = rigidbody
 * - mesh.userData.mass = number > 0
 * - mesh.userData.damageableController = IDamageable instance
 *
 * NpcController and AnimalController already set this up automatically!
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * 📚 RELATED FILES
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * - engine/IDamageable.ts - Interface for hittable entities (health, damage, death)
 * - engine/UnarmedMeleeSystem.ts - Unarmed combat (punches, kicks)
 * - engine/WeaponRegistry.ts - Weapon type definitions and mesh creation
 * - engine/AnimationPacks.ts - Melee weapon animations
 * - engine/animal/index.ts - Animals implement IDamageable
 * - engine/npc/index.ts - NPCs implement IDamageable
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * 🗡️ BLADE SWEEP HIT DETECTION
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * Unlike unarmed combat (cone raycasting), weapon combat uses "blade sweeping":
 * - Tracks weapon tip/hilt positions each frame
 * - Casts rays from previous frame to current frame
 * - Catches fast swings without missing hits
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * ⚠️ CRITICAL: Weapons Must Be Visual-Only
 * ════════════════════════════════════════════════════════════════════════════════
 *
 * Weapon meshes must NOT have physics collisions to avoid pushing player upward.
 * Use layer 2 (visual-only) and mark userData.noPhysics = true.
 */

import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import type { ICharacterAnimationController } from 'engine/ICharacterAnimationController.js';
import { AnimationState } from 'engine/animation/AnimationContext.js';
import type { IPlayerAttack, AttackActionHandler } from 'engine/IPlayerAttack.js';
import type { PlayerController } from 'engine/PlayerController.js';
import { AttackVFX } from 'engine/AttackVFX.js';
import { WeaponSwishSound, voiceForWeapon } from 'engine/WeaponSwishSound.js';
import { WeaponSlashArcs } from 'engine/WeaponSlashArc.js';
import { createWeaponMesh, makeWeaponVisualOnly, type WeaponTypeId, type WeaponPreset } from 'engine/WeaponRegistry.js';
import { gatherMeleeSweepCandidates, gatherMeleeBodyHits } from 'engine/MeleeSweepTargets.js';
import { orientBladeYawFramed, alignBladeToArm, seatGripTowardFingers, rollEdgeToLead, BLADE_IDLE_FORWARD } from 'engine/MeleeWeaponOrientation.js';
import { MELEE_WEAPON_ANIMATIONS, REQUIRED_ANIMATIONS, WEAPON_MOVES } from 'engine/AnimationPacks.js';
import { registerWeaponAttackMoves, unregisterWeaponAttackMoves } from 'engine/MeleeWeaponMoves.js';
import { GameState, getGameStateManager } from 'engine/GameStateManager.js';
import { scheduleGameplaySeconds } from 'engine/GameplayTimers.js';
import { spawnHitDebris } from 'engine/HitDebrisSystem.js';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';

// Re-export for convenience
export { WeaponType, WeaponRegistry, type WeaponTypeId } from 'engine/WeaponRegistry.js';

/**
 * Configuration for a melee weapon
 */
export interface WeaponConfig {
	/** Weapon name for identification */
	name: string;
	/** The visual weapon mesh */
	weaponMesh: THREE.Object3D;
	/** Damage multiplier for this weapon */
	damage: number;
	/** Force multiplier for physics impacts */
	impactForce: number;
	/** Impulse strength applied to enemies on hit */
	impulseStrength: number;
	
	/** Hit detection geometry - offset from weapon mesh origin to hilt/handle */
	hiltOffset: THREE.Vector3;
	/** Hit detection geometry - offset from weapon mesh origin to tip/end */
	tipOffset: THREE.Vector3;
	/** Radius for hit detection (thickness of the blade) */
	bladeRadius: number;
	
	/** Maximum range for attack detection (in units) */
	attackRange: number;
	/** Animation prefix for this weapon type (e.g., "Sword_", "Axe_") */
	animationPrefix: string;
}

/**
 * Configuration for weapon melee combat system
 */
export interface WeaponMeleeConfig {
	/** Maximum range for attack detection (in units) - overrides weapon config if set */
	attackRange?: number;
	/** Angle spread for cone detection (in degrees, e.g., 30 means ±15°) */
	coneAngle?: number;
}

/**
 * Handles weapon-based melee combat system including:
 * - Attack input (mouse and mobile)
 * - Attack animations and VFX
 * - Blade sweep hit detection (follows weapon motion)
 * - Movement blocking during attacks
 * - Weapon lifecycle (equip by type, attach to hand, load animations)
 *
 * This system uses "blade sweeping" for hit detection:
 * - Tracks weapon tip/hilt positions each frame
 * - Casts rays from previous frame to current frame
 * - Catches fast swings without missing hits
 * - Works for any weapon length (daggers to spears)
 *
 * Implements IPlayerAttack interface and can be attached to any PlayerController.
 *
 * NOT FOR MINING. WeaponMeleeSystem damages IDamageable entities (enemies/NPCs)
 * only — it does NOT break voxel blocks, and its action handler competes with
 * the mining key. For voxel mining:
 *   - Block-breaking is handled by VoxelMiningSystem, auto-wired by
 *     DynamicObjectManager.setTerrainSystem (see engine/VoxelMiningSystem.ts).
 *   - To show a tool (axe/pickaxe) in the player's hand with a swing animation,
 *     use PlayerToolSystem (see engine/PlayerToolSystem.ts). Never wire
 *     WeaponMeleeSystem as a "mining axe".
 */
export class WeaponMeleeSystem implements IPlayerAttack {
	private attackVFX: AttackVFX | null = null;
	/**
	 * The air-cutting sound for every swing. Synthesised, so there is no asset to
	 * load and it exists for custom weapons too — see WeaponSwishSound.
	 */
	private swishSound: WeaponSwishSound | null = null;
	/**
	 * The white arc swept by the blade — the swing's hit area, drawn.
	 * Separate from `attackVFX`, whose trail follows a limb bone, not the weapon.
	 */
	private slashArcs: WeaponSlashArcs | null = null;
	/** Preset of the equipped weapon, kept for the swish's per-weapon voice. */
	private equippedPreset: WeaponPreset | null = null;
	/**
	 * The move a plain attack input plays — the weapon's horizontal swipe.
	 * Null when no moves are registered, in which case we fall back to the
	 * ATTACK state override via `startAttack()`.
	 */
	private primaryMoveName: string | null = null;
	private attackPressed: boolean = false;
	private mouseDownTime: number = 0;
	private readonly TAP_MAX_DURATION = 200; // milliseconds - maximum duration for a tap
	private boundOnMouseDown: ((event: MouseEvent) => void) | null = null;
	private boundOnMouseUp: ((event: MouseEvent) => void) | null = null;
	private mobileControls: unknown = null;
	private engine: EngineLike | null;
	private physicsWorld: PhysicsWorld;

	// Configurable melee parameters
	private config: Required<WeaponMeleeConfig>;

	// Equipped weapon
	private equippedWeapon: WeaponConfig | null = null;

	// Weapon type tracking (for equipWeaponByType)
	private currentWeaponType: WeaponTypeId | null = null;
	/** Names of the `weapon:*` attack moves we registered for the current weapon. */
	private registeredMoveNames: string[] = [];
	private weaponMesh: THREE.Object3D | null = null;
	private meleeAnimationsLoaded: boolean = false;

	// Player/controller references (set when weapon equipped via equipWeaponByType)
	private player: THREE.Object3D | null = null;
	private controller: PlayerController | null = null;

	// Blade sweep tracking - previous frame positions
	private prevTipPos: THREE.Vector3 = new THREE.Vector3();
	private prevHiltPos: THREE.Vector3 = new THREE.Vector3();
	private isFirstFrame: boolean = true; // Skip first frame (no previous position)

	// Once-only guard for the missing-animation-controller error.
	private warnedNoAnimationController: boolean = false;

	// Weapon orientation stabilization. While the player is running (and not
	// attacking) we override the sword's world rotation to a fixed character-
	// relative pose (charYaw × 30° forward pitch) so wrist yaw/roll from the
	// run cycle doesn't make the blade swing wildly.
	private weaponNaturalLocalQ: THREE.Quaternion | null = null;
	private unregisterStabilizeHook: (() => void) | null = null;

	private static readonly RUN_PITCH_FORWARD = new THREE.Quaternion()
		.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 6); // 30° forward (char forward is +Z)

	// How far past the hand-bone origin (m), along the live wrist→fingers direction,
	// the skinned character's weapon grip is seated each frame — so the blade comes out
	// of the fist rather than floating at the wrist. Mirrors MeleeNpcBehavior.GRIP_TOWARD_FINGERS.
	private static readonly GRIP_TOWARD_FINGERS = 0.15;

	// Idle / arm-alignment blade targeting for skinned characters lives in the shared
	// MeleeWeaponOrientation helper (orientBladeYawFramed / alignBladeToArm), so the
	// player and melee NPCs orient their swords identically.

	// Pre-allocated temps for hit detection (avoid per-frame allocations)
	private static readonly _tmpTipPos = new THREE.Vector3();
	private static readonly _tmpHiltPos = new THREE.Vector3();
	private static readonly _tmpDir = new THREE.Vector3();
	private static readonly _tmpForceDir = new THREE.Vector3();
	private static readonly _tmpImpulse = new THREE.Vector3();
	private static readonly _tmpImpactNormal = new THREE.Vector3();
	private static readonly _raycaster = new THREE.Raycaster();
	/** Offsets (in perpendicular-plane units) for the girth ray bundle. */
	private static readonly BUNDLE_OFFSETS: ReadonlyArray<readonly [number, number]> =
		[[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
	private static readonly _tmpBundleSide = new THREE.Vector3();
	private static readonly _tmpBundleUp = new THREE.Vector3();
	private static readonly _tmpBundleOrigin = new THREE.Vector3();

	// Melee hit-volume inflation (detection only — the rendered weapon is unchanged).
	//
	// These were both 2.0, which did not "inflate" the hit volume so much as invent a
	// second, invisible weapon: REACH 2.0 puts the hit tip at TWICE the blade's length,
	// so a 2.4 m greatsword swept a 4.8 m capsule, and with a 0.95 bladeRadius the
	// doubling made it 1.9 m thick. Enemies died a full sword-length past the visible
	// blade, with the slash arc — which is drawn from the REAL tip — nowhere near them.
	//
	// Forgiveness belongs in the GIRTH, not the length. A slightly thick capsule
	// rescues glancing hits that would otherwise slip past a thin blade; extending
	// the tip instead just moves the weapon somewhere the player cannot see. Reach is
	// now a small overhang past the point rather than a second blade.
	private static readonly BLADE_REACH_SCALE = 1.1;
	private static readonly BLADE_RADIUS_SCALE = 1.5;
	// Absolute girth floor, metres. Thin weapons scaled their own thinness:
	// a dagger's 0.10 bladeRadius made a 12cm hit tube that read as "my hits
	// don't count", while an axe already swung a 31cm one. Every weapon now
	// swings AT LEAST this much forgiveness; the swept segment runs grip→tip,
	// so shafts and hafts carry it too.
	private static readonly MIN_HIT_RADIUS = 0.18;


	constructor(
		engine: EngineLike | null,
		physicsWorld: PhysicsWorld,
		config?: WeaponMeleeConfig
	) {
		this.engine = engine;
		this.physicsWorld = physicsWorld;

		// Defaults are tuned for weapon swings (longer range, wider cone than unarmed).
		this.config = {
			attackRange: config?.attackRange ?? 3.0,
			coneAngle: config?.coneAngle ?? 40,
		};

		if (engine) {
			this.swishSound = new WeaponSwishSound(engine);
			if (engine.scene) {
				this.attackVFX = new AttackVFX(engine.scene);
				this.slashArcs = new WeaponSlashArcs(engine.scene);
			}
		}
	}

	/**
	 * Update melee configuration at runtime
	 */
	updateConfig(config: Partial<WeaponMeleeConfig>): void {
		this.config = {
			...this.config,
			...config,
		};
	}

	/**
	 * Get current melee configuration
	 */
	getConfig(): Required<WeaponMeleeConfig> {
		return { ...this.config };
	}

	/**
	 * Equip a weapon for combat
	 * @param weapon - Weapon configuration
	 */
	equipWeapon(weapon: WeaponConfig): void {
		this.equippedWeapon = weapon;
		this.isFirstFrame = true; // Reset blade sweep tracking
		console.log(`WeaponMeleeSystem: Equipped ${weapon.name}`);
	}

	/**
	 * Unequip the current weapon
	 */
	unequipWeapon(): void {
		if (this.equippedWeapon) {
			console.log(`WeaponMeleeSystem: Unequipped ${this.equippedWeapon.name}`);
			this.equippedWeapon = null;
		}
	}

	/**
	 * Get the currently equipped weapon
	 */
	getEquippedWeapon(): WeaponConfig | null {
		return this.equippedWeapon;
	}

	/**
	 * Set the controller reference.
	 * Called by PlayerController.setAttackSystem() when this system is attached.
	 */
	setController(controller: PlayerController): void {
		this.controller = controller;
	}

	/**
	 * WeaponMeleeSystem is animation-driven: swings play through the character's
	 * CharacterAnimationController, so without one NOTHING can attack. That is
	 * the case for headless players (world.json `hasPlayerCharacter: false` —
	 * the standard first-person setup). Shout once instead of failing silently.
	 */
	private errorIfNoAnimationController(controller: PlayerController): void {
		if (controller.animationController || this.warnedNoAnimationController) return;
		this.warnedNoAnimationController = true;
		console.error(
			'❌ WeaponMeleeSystem: the player has NO animation controller — every attack input will be ignored.\n' +
			'   This system needs an animated character (third-person / top-down with a visible player).\n' +
			'   Headless players (hasPlayerCharacter: false) and first-person games should use\n' +
			'   FirstPersonMeleeSystem instead: a camera-attached view model with procedural swings\n' +
			'   that needs no skeleton. See engine/FirstPersonMeleeSystem.ts.'
		);
	}

	/**
	 * Setup attack event listeners for mouse input
	 */
	setupEventListeners(): void {
		// Bind mouse event handlers
		this.boundOnMouseDown = this.onMouseDown.bind(this);
		this.boundOnMouseUp = this.onMouseUp.bind(this);

		// Add mouse event listeners for left mouse button attack
		document.addEventListener('mousedown', this.boundOnMouseDown);
		document.addEventListener('mouseup', this.boundOnMouseUp);
	}

	/**
	 * Remove event listeners
	 */
	removeEventListeners(): void {
		if (this.boundOnMouseDown) document.removeEventListener('mousedown', this.boundOnMouseDown);
		if (this.boundOnMouseUp) document.removeEventListener('mouseup', this.boundOnMouseUp);
	}

	/**
	 * Set mobile controls instance
	 */
	setMobileControls(mobileControls: unknown): void {
		this.mobileControls = mobileControls;
	}

	// ════════════════════════════════════════════════════════════════════════════════
	// WEAPON LIFECYCLE (Component Approach)
	// ════════════════════════════════════════════════════════════════════════════════

	/**
	 * Equip a weapon by type. Creates the weapon mesh and attaches it to the player's hand.
	 * Also loads melee weapon animations if not already loaded.
	 *
	 * @param weaponType - Type of weapon to equip (from WeaponType constants)
	 * @param player - Player object to attach weapon to
	 * @param controller - PlayerController for body part attachment
	 * @param retryCount - Internal retry counter
	 */
	async equipWeaponByType(
		weaponType: WeaponTypeId,
		player: THREE.Object3D,
		controller: PlayerController,
		retryCount: number = 0
	): Promise<void> {
		// Store references
		this.player = player;
		this.controller = controller;

		this.errorIfNoAnimationController(controller);

		// Unequip current weapon if any
		if (this.weaponMesh) {
			await this.unequipWeaponByType();
		}

		console.log(`🗡️ WeaponMeleeSystem: Equipping ${weaponType}... (attempt ${retryCount + 1})`);

		// Load melee animations if not loaded
		if (!this.meleeAnimationsLoaded && controller.animationController?.loadAnimationPack) {
			console.log('🗡️ Loading melee weapon animations...');
			await controller.animationController.loadAnimationPack(MELEE_WEAPON_ANIMATIONS, {
				addToAttackCollection: true,
				replaceLocomotion: true
			});
			this.meleeAnimationsLoaded = true;
		}

		// Create weapon from preset
		const { mesh, config, preset } = createWeaponMesh(weaponType);

		// Make weapon visual-only (no physics collisions)
		makeWeaponVisualOnly(mesh);

		// Attach to right hand
		const attached = controller.attachToBodyPart(mesh, 'rightHand');
		if (!attached) {
			if (retryCount >= 5) {
				console.error(`❌ Failed to attach ${weaponType} to hand after 5 attempts`);
				return;
			}
			const delay = 100 * (retryCount + 1);
			console.log(`⏳ Body part not ready, retrying in ${delay}ms...`);
			await new Promise(resolve => setTimeout(resolve, delay));
			return this.equipWeaponByType(weaponType, player, controller, retryCount + 1);
		}

		this.weaponMesh = mesh;
		this.currentWeaponType = weaponType;

		// Register weapon with combat system
		this.equipWeapon({
			...config,
			weaponMesh: mesh
		});

		// Register the attack moves this weapon actually swings with. Without
		// this, every weapon fell back to the single ATTACK state override —
		// the last clip in the melee pack — so a two-handed hammer chopped
		// exactly like a one-handed sword.
		this.equippedPreset = preset;
		this.registerWeaponMoves(weaponType, preset);
		this.attachSwishToAnimator();

		// Stash the natural local rotation (post-attach default correction)
		// so we can restore it whenever the player isn't running.
		this.weaponNaturalLocalQ = mesh.quaternion.clone();
		this.registerStabilizeHook();

		console.log(`✅ ${preset.name} equipped`);
		console.log(`   - Damage: ${preset.damage}, Impact: ${preset.impactForce}, Range: ${preset.attackRange}`);
	}

	/**
	 * Register the grip-appropriate attack moves for the equipped weapon, so a
	 * hammer smashes and a sword slashes. Replaces any set from a previously
	 * equipped weapon; leaves template-registered moves (specials like
	 * whirlwind) untouched because only our own `weapon:*` names are removed.
	 */
	private registerWeaponMoves(weaponType: WeaponTypeId, preset: WeaponPreset): void {
		const animController = this.controller?.animationController;
		if (!animController?.registerCustomAttack) return;

		this.unregisterWeaponMoves();

		// Damage/knockback stay owned by this system's blade sweep — the values on the
		// moves only feed the attack system's bookkeeping. (An NPC's swings, registered
		// through this same helper, are the ones where they drive the damage.)
		const { names, primaryName } = registerWeaponAttackMoves(animController, {
			weaponType,
			grip: preset.grip,
			namePrefix: 'weapon:',
			damage: preset.damage,
			range: preset.attackRange,
			// Legs keep running under an upper-body swing instead of sliding.
			splitBodyOnRun: true,
		});
		this.registeredMoveNames.push(...names);
		this.primaryMoveName = primaryName;
	}

	/** Remove the moves registered by `registerWeaponMoves`, if any. */
	private unregisterWeaponMoves(): void {
		const animController = this.controller?.animationController;
		if (animController) unregisterWeaponAttackMoves(animController, this.registeredMoveNames);
		else this.registeredMoveNames.length = 0;
		this.primaryMoveName = null;
	}

	/**
	 * Sound every swing, wherever it was started from.
	 *
	 * Subscribes on the ANIMATION layer rather than the input handler. The swish
	 * used to fire from `performAttack`, which only runs for mouse and mobile
	 * input — so a template calling `startNamedAttack('weapon:whirlwind')`, an
	 * NPC, or a networked remote character all swung in silence. The sound
	 * belongs to the animation, not to the button.
	 *
	 * `setAttackStartedListener` is optional on the interface (published games
	 * ship frozen implementations), so a missing method simply means no swish
	 * rather than a crash.
	 */
	private attachSwishToAnimator(): void {
		const animController = this.controller?.animationController;
		if (!animController?.setAttackStartedListener || !this.swishSound) return;

		animController.setAttackStartedListener(({ moveName, duration }) => {
			// Read the weapon at FIRE time, not at subscribe time — the player
			// can swap weapons without the listener being re-registered.
			const weapon = this.equippedWeapon;
			if (!weapon || !this.swishSound) return;
			this.swishSound.play(duration, voiceForWeapon({
				bladeRadius: weapon.bladeRadius,
				attackRange: weapon.attackRange,
				grip: this.equippedPreset?.grip,
				moveName,
			}));

			// The arc rides the same hook, so it covers every swing the sound
			// does — including template-triggered specials and NPC attacks.
			if (weapon.weaponMesh) {
				this.slashArcs?.spawn(weapon.weaponMesh, weapon.hiltOffset, weapon.tipOffset, duration);
			}

			// And so does the damage. This is the whole reason the hook exists on
			// the animation layer rather than the input handler.
			this.scheduleHitChecks(duration, moveName);
		});
	}

	/**
	 * Hook stabilization into PlayerLoader's post-block-character-update phase
	 * so it runs after body-part world transforms are fresh for the frame.
	 */
	private registerStabilizeHook(): void {
		this.unregisterStabilizeHook?.();
		const playerLoader = this.controller?.playerLoader;
		if (!playerLoader) return;
		this.unregisterStabilizeHook = playerLoader.onAfterBlockCharacterUpdate(() => {
			this.stabilizeWeaponMesh();
		});
	}

	// Where the blade tip was last frame, in world space, so the swing's direction
	// of travel can be measured. Null until the first frame of a swing.
	private previousBladeTipWorld: THREE.Vector3 | null = null;
	private static readonly _tmpTipNow = new THREE.Vector3();
	private static readonly _tmpTipTravel = new THREE.Vector3();

	/**
	 * Roll the blade so its edge leads the swing, using the tip's own motion.
	 *
	 * The tip is taken from the weapon config's `tipOffset` in the mesh's local
	 * frame, so it follows whatever geometry the weapon actually has rather than
	 * assuming a sword's length.
	 */
	private rollWeaponEdgeToSwing(): void {
		if (!this.weaponMesh || !this.equippedWeapon) return;

		const tip = WeaponMeleeSystem._tmpTipNow
			.copy(this.equippedWeapon.tipOffset)
			.applyMatrix4(this.weaponMesh.matrixWorld);

		if (this.previousBladeTipWorld) {
			const travel = WeaponMeleeSystem._tmpTipTravel
				.copy(tip).sub(this.previousBladeTipWorld);
			rollEdgeToLead(this.weaponMesh, travel);
			// Re-read the tip: the roll moved it, and comparing next frame against
			// the pre-roll position would fold this frame's correction into the
			// next frame's measured travel.
			this.weaponMesh.updateMatrixWorld(true);
			tip.copy(this.equippedWeapon.tipOffset).applyMatrix4(this.weaponMesh.matrixWorld);
		}

		(this.previousBladeTipWorld ??= new THREE.Vector3()).copy(tip);
	}

	/**
	 * Stabilize the sword's WORLD rotation against wrist-driven yaw/roll during
	 * the run/jump cycle.
	 *
	 * - ATTACK: restore the natural local rotation so the attack animation
	 *   drives the blade through the wrist bone, unmodified. Critical: we
	 *   must explicitly reset (not just skip) — otherwise a leftover override
	 *   quaternion from the previous run frame would compose with the wrist's
	 *   attack pose and produce an arbitrary blade orientation.
	 * - RUN / JUMP: override to charYaw × 30° forward pitch (around char-X).
	 *   This produces a blade direction of (0, cos30, sin30) in char-yaw-only
	 *   space — pure up-and-forward, no left/right lean. Assumes the mesh's
	 *   natural blade axis is +Y after the attach default rotation correction.
	 *   Position still follows the hand via the parent transform.
	 * - IDLE / other: restore natural local so the sword follows the hand
	 *   normally.
	 */
	private stabilizeWeaponMesh(): void {
		if (!this.weaponMesh || !this.weaponMesh.parent || !this.player) return;
		if (!this.weaponNaturalLocalQ) return;
		if (!this.controller?.animationController) return;

		const animController = this.controller.animationController;
		const state = animController.getCurrentState();
		const isAttacking = animController.getIsAttacking();

		// Does an animation currently own the blade's orientation?
		//
		// `isAttacking` alone is not enough. A swing played straight through
		// `playCustomAnimation` — which is how templates trigger a specific
		// weapon move, and how the debug cycler plays them — moves the whole arm
		// with `isAttacking` false the entire time. The stabilizer would then
		// treat it as ordinary locomotion and world-lock the blade forward,
		// ignoring the hand. Swinging while moving therefore snapped the sword
		// between "follows the hand" and "pinned forward" as the flags changed,
		// which reads as the weapon teleporting to a different angle mid-swing.
		//
		// Whenever a clip is driving the arm, the clip owns the blade.
		const animationOwnsBlade = isAttacking
			|| animController.getIsPlayingCustomAnimation?.() === true;

		const isOverrideState = !animationOwnsBlade
			&& (state === AnimationState.RUN || state === AnimationState.WALK || state === AnimationState.JUMP);

		const skinned = this.controller.playerLoader?.isRenderingSkinnedMesh() === true;

		if (!isOverrideState) {
			// Skinned characters: the attach-time default rotation is calibrated
			// for the block-character hand frame and reads tilted on the raw
			// Mixamo hand bone, so idle is world-targeted too (blade down,
			// slight forward tilt). The computed local also refreshes the
			// natural-local baseline that attack swings restore, so swings start
			// from the correct grip. Block characters keep the legacy
			// attach-time local untouched.
			if (skinned && !animationOwnsBlade) {
				// World-target the blade forward + slightly up, then refresh the
				// natural-local baseline that attack swings restore.
				orientBladeYawFramed(this.weaponMesh, this.player, BLADE_IDLE_FORWARD);
				this.weaponNaturalLocalQ.copy(this.weaponMesh.quaternion);
			} else if (skinned && animationOwnsBlade && alignBladeToArm(this.weaponMesh, this.player)) {
				// Handled by alignBladeToArm(): blade extends along the arm and
				// sweeps with the swing animation (see helper). That decides where
				// the blade POINTS but leaves its roll arbitrary, so the sword swept
				// a clean arc and landed flat-on. Roll the edge into the direction
				// of travel afterwards.
				this.rollWeaponEdgeToSwing();
			} else if (!animationOwnsBlade && state === AnimationState.IDLE) {
				// Block character, idling, no clip driving the arm. The core Idle
				// clip carries no blade aim (it is shared with unarmed play), so
				// the hand bone alone decides where the sword points — and in the
				// arms-down rest pose the hand's blade axis faces the character's
				// LEFT, so the sword lay across the body instead of forward.
				// RUN/WALK/JUMP already world-target the blade; idle was the one
				// state that fell through to the bone. Use the gentler idle target
				// rather than the 30° run pitch.
				orientBladeYawFramed(this.weaponMesh, this.player, BLADE_IDLE_FORWARD);
			} else {
				// Block characters, and skinned characters attacking without a
				// usable forearm bone — fall back to the rigid idle baseline.
				this.weaponMesh.quaternion.copy(this.weaponNaturalLocalQ);
			}
		} else {
			// RUN/WALK/JUMP override: point the blade forward in the run-pitch frame.
			orientBladeYawFramed(this.weaponMesh, this.player, WeaponMeleeSystem.RUN_PITCH_FORWARD);
		}

		// Skinned (Mixamo-rigged) characters: seat the weapon grip out toward the
		// fingers each frame so the blade comes out of the fist instead of floating at
		// the wrist bone / riding up the long forearm. The orientation helpers above
		// only write rotation, so this composes cleanly; block characters keep their
		// attach-time local position (their hand frame is short and clean). Mirrors
		// MeleeNpcBehavior so the player and melee NPCs hold their weapons identically.
		if (skinned) {
			seatGripTowardFingers(this.weaponMesh, WeaponMeleeSystem.GRIP_TOWARD_FINGERS);
		}
	}

	/**
	 * Unequip the current weapon and restore default animations.
	 */
	async unequipWeaponByType(): Promise<void> {
		// Detach weapon mesh from body part
		if (this.weaponMesh && this.controller) {
			this.controller.detachFromBodyPart(this.weaponMesh);
			this.weaponMesh = null;
		}

		// This weapon's moves leave with it; unarmed/template moves remain.
		this.unregisterWeaponMoves();

		// Drop the orientation baseline; the next equip will recapture.
		this.weaponNaturalLocalQ = null;
		this.unregisterStabilizeHook?.();
		this.unregisterStabilizeHook = null;

		// Unequip from combat system
		this.unequipWeapon();
		this.currentWeaponType = null;

		// Restore default locomotion if melee animations replaced it. Only the
		// required locomotion clips are needed here — optional one-shots stay
		// on-demand.
		if (this.meleeAnimationsLoaded && this.controller?.animationController?.loadAnimationPack) {
			console.log('🎬 Restoring default locomotion animations...');
			await this.controller.animationController.loadAnimationPack(REQUIRED_ANIMATIONS, {
				addToAttackCollection: false,
				replaceLocomotion: true
			});
			this.meleeAnimationsLoaded = false;
		}
	}

	/**
	 * Get the current weapon type (if equipped via equipWeaponByType).
	 */
	getWeaponType(): WeaponTypeId | null {
		return this.currentWeaponType;
	}

	/**
	 * Check if a weapon is equipped.
	 */
	hasWeapon(): boolean {
		return this.equippedWeapon !== null;
	}

	/**
	 * Handle mouse down for attack input
	 */
	private onMouseDown(event: MouseEvent): void {
		// Only handle left mouse button
		if (event.button === 0) {
			this.mouseDownTime = Date.now();
		}
	}

	/**
	 * Handle mouse up for attack input
	 */
	private onMouseUp(event: MouseEvent): void {
		// Only handle left mouse button
		if (event.button === 0) {
			const duration = Date.now() - this.mouseDownTime;

			// If it was a quick tap/click (not a drag), trigger attack
			if (duration <= this.TAP_MAX_DURATION) {
				this.attackPressed = true;
			}

			this.mouseDownTime = 0;
		}
	}

	/**
	 * Update weapon melee attack system (called every frame)
	 * IPlayerAttack interface method.
	 *
	 * @param deltaTime - Time since last frame in seconds
	 * @returns Whether movement should be blocked (true if attacking)
	 */
	update(deltaTime: number): boolean {
		if (!this.controller) return false;

		// Get references from controller
		const player = this.controller.player;
		const animationController = this.controller.animationController;

		// Store player reference for other methods that need it
		this.player = player;

		// Update attack VFX
		this.slashArcs?.update(deltaTime);
		this.attackVFX?.update(deltaTime);

		// Handle attack input
		const isAttacking = animationController?.getIsAttacking() || false;

		// Don't block movement during melee swings. The upper body plays the
		// swing on trackB, the lower body keeps reading trackA via trackBlend,
		// and CharacterAnimationController updates trackA from the player's
		// real movement state — so running into / during / out of a swing
		// keeps the legs animated correctly instead of freezing the player.

		if (!animationController) {
			// Without an animation controller EVERY attack input below is
			// unreachable — this used to fail silently ("fire button does
			// nothing"). Say so, loudly, once.
			this.errorIfNoAnimationController(this.controller);
			return false;
		}

		// Handle attack input from mouse
		if (this.attackPressed) {
			this.performAttack(animationController, player);
			this.attackPressed = false; // Consume the attack input
		}

		// Handle attack input from mobile action button
		const mobileCtrl = this.mobileControls as { actionPressed?: boolean; resetActionPressed?: () => void } | null;
		if (mobileCtrl?.actionPressed) {
			this.performAttack(animationController, player);
			mobileCtrl.resetActionPressed?.();
		}

		return false;
	}

	/**
	 * Plays the character's attack animation and schedules blade-sweep hit checks across its duration.
	 */
	private performAttack(
		animationController: ICharacterAnimationController,
		player?: THREE.Object3D
	): void {
		if (!this.equippedWeapon || !player) {
			console.warn('WeaponMeleeSystem: Cannot attack - no weapon equipped or no player');
			return;
		}

		// Silent re-entry guard. triggerAttack() is called from the action
		// handler (Enter / mobile action button) which bypasses update()'s
		// isAttacking early-return — without this, rapid presses during an
		// in-progress swing fall through to startAttack(), which returns
		// success:false and trips the misleading "No attack animation
		// available" warning below.
		if (animationController.getIsAttacking()) {
			return;
		}

		// The horizontal swipe, not a random pick from the weapon's whole set.
		//
		// `startAttack()` rolls a random registered move, which for a sword meant
		// the same click chopped, stabbed or cut upward at random — that reads as
		// the character choosing rather than the player. The other moves stay
		// reachable by name for templates (see WEAPON_MOVES).
		//
		// Falls back to `startAttack()` when no primary is registered, which also
		// covers the ATTACK-state override path for weapons with no move set.
		const attackResult = (this.primaryMoveName && animationController.startNamedAttack)
			? animationController.startNamedAttack(this.primaryMoveName)
			: animationController.startAttack();
		if (!attackResult.success) {
			console.warn('WeaponMeleeSystem: No attack animation available');
			return;
		}

		// CustomAnimationSystem owns splitBodyOnRun. Standing swings retain
		// their hip/leg drive; movement releases the legs with a pose handoff.
		// Forcing upper-only here erased every heavy strike's anticipation.

		if (this.attackVFX && this.equippedWeapon.weaponMesh) {
			this.attackVFX.createAttackTrail(this.equippedWeapon.weaponMesh, attackResult.duration, attackResult.animationName);
		}
	}

	/**
	 * Schedule the blade-sweep hit checks for one swing.
	 *
	 * Called from the attack-started hook, NOT from the input handler. It used to
	 * live inline in `performAttack`, which meant only mouse and mobile input
	 * ever dealt damage: a template calling `startNamedAttack('weapon:whirlwind')`
	 * — the documented way to use WEAPON_MOVES — plus every NPC and networked
	 * attack, animated and sounded correctly while passing straight through the
	 * target. Collision belongs to the swing, like the sound and the arc.
	 */
	private scheduleHitChecks(durationSeconds: number, moveName: string): void {
		// One set per swing, so a single sweep cannot damage the same target twice
		// while still letting the next swing hit it again.
		const hitEnemyControllers = new Set<unknown>();
		const anim = this.controller?.animationController;
		const token = anim?.getAttackPlaybackToken?.();
		const checkPoints = anim?.getAttackContactCheckPhases?.([0.15, 0.30, 0.40, 0.50, 0.60]) ?? [0.15, 0.30, 0.40, 0.50, 0.60];
		this.isFirstFrame = true;

		for (const percentage of checkPoints) {
			// Gameplay time, not wallclock: a pause mid-swing HOLDS the remaining
			// checks and delivers them when simulation resumes, instead of firing
			// them into the PLAYING gate and losing the swing's hits. The gate
			// stays as a second fence for end-of-game states.
			scheduleGameplaySeconds(durationSeconds * percentage, () => {
				if (token !== undefined && anim?.getAttackPlaybackToken?.() !== token) return;
				if (!getGameStateManager().isState(GameState.PLAYING)) return;
				const player = this.player;
				if (player && this.equippedWeapon) {
					this.checkWeaponHit(player, this.equippedWeapon, moveName, hitEnemyControllers);
				}
			});
		}
	}

	/**
	 * Public method to perform attack (called from external sources)
	 */
	public triggerAttack(animationController: ICharacterAnimationController, player: THREE.Object3D): void {
		this.performAttack(animationController, player);
	}

	/**
	 * Returns an action handler for auto-setup by setAttackSystem().
	 */
	getActionHandler(): AttackActionHandler {
		return {
			actionType: 'melee',
			handler: (player, controller) => {
				if (controller.animationController) {
					this.triggerAttack(controller.animationController, player);
				}
			}
		};
	}

	/**
	 * Check for weapon hit using blade sweep detection
	 * @param player - Player object to get position and rotation
	 * @param weapon - Weapon configuration
	 * @param animationName - Name of the attack animation
	 * @param hitEnemyControllers - Set to track enemy controllers already hit in this attack
	 */
	private checkWeaponHit(
		player: THREE.Object3D,
		weapon: WeaponConfig,
		animationName: string,
		hitEnemyControllers: Set<unknown>
	): void {
		if (!this.physicsWorld || !this.engine || !this.engine.scene) return;

		// Get current world positions of weapon points (reuse static temps)
		const currentTipPos = WeaponMeleeSystem._tmpTipPos;
		const currentHiltPos = WeaponMeleeSystem._tmpHiltPos;
		
		weapon.weaponMesh.updateMatrixWorld(true);
		weapon.weaponMesh.localToWorld(currentTipPos.copy(weapon.tipOffset));
		weapon.weaponMesh.localToWorld(currentHiltPos.copy(weapon.hiltOffset));

		// Inflate the blade's HIT volume so swings register reliably — the thin
		// visual blade made glancing hits slip past. Tip extends slightly past
		// the point; girth is scaled AND floored (MIN_HIT_RADIUS) so thin
		// weapons stop scaling their own thinness. The rendered weapon mesh is
		// untouched; this only affects hit detection.
		currentTipPos.sub(currentHiltPos).multiplyScalar(WeaponMeleeSystem.BLADE_REACH_SCALE).add(currentHiltPos);
		const hitRadius = Math.max(weapon.bladeRadius * WeaponMeleeSystem.BLADE_RADIUS_SCALE, WeaponMeleeSystem.MIN_HIT_RADIUS);

		// Skip first frame (no previous position to compare)
		if (this.isFirstFrame) {
			this.prevTipPos.copy(currentTipPos);
			this.prevHiltPos.copy(currentHiltPos);
			this.isFirstFrame = false;
			return;
		}

		// Blade sweep detection: Cast rays from previous frame to current frame
		// This catches hits even during fast swings
		const hits: THREE.Intersection[] = [
			// Previous tip → current tip (catches motion along the blade edge)
			...this.castWeaponRay(this.prevTipPos, currentTipPos, hitRadius),
			// Hilt → tip (catches objects standing inside the blade's path)
			...this.castWeaponRay(currentHiltPos, currentTipPos, hitRadius),
			// Previous hilt → current hilt (catches motion at the handle)
			...this.castWeaponRay(this.prevHiltPos, currentHiltPos, hitRadius),
		];

		// Authoritative character hit test: sweep the blade line (hilt→tip) against each
		// character's body-covering hit volume (its visible mesh AABB, slightly enlarged).
		// Mesh raycasting misses skinned (Asset Forger) NPCs — the GLB raycasts unreliably and
		// the block proxy can be mis-aligned — whereas this volume tracks the actual graphics.
		// Dedup with mesh hits happens in processWeaponHits (per-controller hitEnemyControllers
		// set), so this only adds coverage. Uses the full blade line plus the tip's motion so
		// fast swings still land.
		hits.push(...gatherMeleeBodyHits(this.engine.scene, currentHiltPos, currentTipPos, hitRadius));
		hits.push(...gatherMeleeBodyHits(this.engine.scene, this.prevTipPos, currentTipPos, hitRadius));

		// Update previous positions for next frame
		this.prevTipPos.copy(currentTipPos);
		this.prevHiltPos.copy(currentHiltPos);

		// Process hits
		if (hits.length > 0) {
			this.processWeaponHits(hits, player, weapon, hitEnemyControllers);
		}
	}

	/**
	 * Cast a ray for weapon hit detection
	 * @param from - Start position
	 * @param to - End position
	 * @param radius - Hit detection radius
	 * @returns Array of intersections
	 */
	private castWeaponRay(from: THREE.Vector3, to: THREE.Vector3, radius: number): THREE.Intersection[] {
		if (!this.engine || !this.engine.scene) return [];

		const direction = WeaponMeleeSystem._tmpDir.subVectors(to, from);
		const distance = direction.length();

		if (distance < 0.001) return []; // Too short, skip

		direction.normalize();

		// Broad phase: only meshes that can react to a melee hit (IDamageable
		// contract / dynamic bodies) near the blade segment. Raycasting the
		// whole scene intersected terrain and every SkinnedMesh (CPU bone
		// transform per vertex) and caused multi-hundred-ms swing stalls.
		const candidates = gatherMeleeSweepCandidates(this.engine.scene, from, to, radius);
		if (candidates.length === 0) return [];

		// Reuse static raycaster
		const raycaster = WeaponMeleeSystem._raycaster;
		raycaster.near = 0;
		raycaster.far = distance;

		// Camera is required for THREE.Sprite.raycast (crashes with null camera)
		if (this.engine.camera) raycaster.camera = this.engine.camera;

		// Set raycaster to detect objects on layers 0 and 1 (default layer and editor layer)
		raycaster.layers.set(0);
		raycaster.layers.enable(1);

		// GIRTH via a ray bundle. `raycaster.params.Mesh = { threshold }` was
		// set here for years and is a NO-OP — three.js only honours threshold
		// for Points and Line targets — so against MESH targets (props,
		// destructibles; characters have their own volume test) the "blade"
		// was a zero-width line and everything not exactly on it slipped past.
		// Four extra rays offset by ±¾ radius on the two axes perpendicular to
		// the stroke give the swept tube a real cross-section, against the
		// same pre-filtered candidate set, for five narrow raycasts total.
		const side = WeaponMeleeSystem._tmpBundleSide
			.set(0, 1, 0).cross(direction);
		if (side.lengthSq() < 1e-6) side.set(1, 0, 0).cross(direction);
		side.normalize();
		const up = WeaponMeleeSystem._tmpBundleUp.copy(direction).cross(side).normalize();

		const hits: THREE.Intersection[] = [];
		const spread = radius * 0.75;
		for (const [su, sv] of WeaponMeleeSystem.BUNDLE_OFFSETS) {
			const origin = WeaponMeleeSystem._tmpBundleOrigin.copy(from)
				.addScaledVector(side, su * spread)
				.addScaledVector(up, sv * spread);
			raycaster.set(origin, direction);
			hits.push(...raycaster.intersectObjects(candidates, false));
		}
		return hits;
	}

	/**
	 * Process weapon hits and apply damage/force
	 */
	private processWeaponHits(
		intersects: THREE.Intersection[],
		player: THREE.Object3D,
		weapon: WeaponConfig,
		hitEnemyControllers: Set<unknown>
	): void {
		// Sort by distance and pick the nearest hit with a physics body.
		const hit = intersects
			.sort((a, b) => a.distance - b.distance)
			.find(h => h.object.userData?.physicsBody);
		if (!hit) return;

		const hitObject = hit.object;

		// Check for damageable controller (IDamageable interface - NPCs, animals, etc.)
		// Falls back to enemyController for backward compatibility
		const damageableController = hitObject.userData.damageableController || hitObject.userData.enemyController;

		console.log(`🎯 [WeaponMeleeSystem] Hit detected:`, {
			objectName: hitObject.name,
			hasDamageableController: !!hitObject.userData.damageableController,
			hasEnemyController: !!hitObject.userData.enemyController,
			hasPhysicsBody: !!hitObject.userData.physicsBody,
			mass: hitObject.userData.mass,
			controllerType: damageableController?.constructor?.name
		});

		// Skip if we already hit this controller in this attack
		if (damageableController && hitEnemyControllers.has(damageableController)) {
			console.log(`⏭️ [WeaponMeleeSystem] Already hit this controller this swing, skipping`);
			return;
		}

		// Only apply force to dynamic objects (mass > 0); static/zero-mass bodies ignore impulses.
		const mass = hitObject.userData.mass || 0;
		if (mass <= 0) return;

		if (damageableController) {
			hitEnemyControllers.add(damageableController);
		}

		// Force direction: player forward + slight upward lift for dramatic knockback.
		const forceDirection = WeaponMeleeSystem._tmpForceDir
			.set(0, 0, 1)
			.applyQuaternion(player.quaternion);
		forceDirection.y += 0.4;
		forceDirection.normalize();

		const rigidBody = hitObject.userData.physicsBody as RAPIER.RigidBody;
		const impulse = WeaponMeleeSystem._tmpImpulse
			.copy(forceDirection)
			.multiplyScalar(weapon.impactForce);
		rigidBody.applyImpulseAtPoint(
			{ x: impulse.x, y: impulse.y, z: impulse.z },
			{ x: hit.point.x, y: hit.point.y, z: hit.point.z },
			true // wake up
		);

		// Debris off the target, coloured from ITS material — the sparks below are
		// a fixed orange whatever you hit, so a blow landing on a living NPC read
		// the same as one landing on a wall.
		const impactNormal = WeaponMeleeSystem._tmpImpactNormal.copy(forceDirection).negate();
		spawnHitDebris(hit.point, impactNormal, hitObject);

		if (this.attackVFX) {
			this.attackVFX.createImpactEffect(hit.point, impactNormal);
		}

		if (typeof damageableController?.onMeleeHit === 'function') {
			console.log(`🔔 [WeaponMeleeSystem] Calling onMeleeHit on ${damageableController.constructor?.name || 'unknown'}`);
			damageableController.onMeleeHit(forceDirection, weapon.impulseStrength);
		} else {
			console.log(`⚠️ [WeaponMeleeSystem] No onMeleeHit method on controller:`, {
				hasController: !!damageableController,
				hasMethod: typeof damageableController?.onMeleeHit === 'function'
			});
		}

		console.log(`WeaponMeleeSystem: ${weapon.name} hit target!`);
	}

	/**
	 * Dispose resources
	 */
	dispose(): void {
		// Remove event listeners
		this.removeEventListeners();

		// Remove this weapon's registered attack moves.
		this.unregisterWeaponMoves();

		// Drop the orientation baseline.
		this.weaponNaturalLocalQ = null;
		this.unregisterStabilizeHook?.();
		this.unregisterStabilizeHook = null;

		// Dispose attack VFX
		if (this.attackVFX) {
			this.attackVFX.dispose();
			this.attackVFX = null;
		}
		if (this.swishSound) {
			// Detach first: the listener closes over `this`, so leaving it
			// registered would keep a disposed system alive and swishing.
			this.controller?.animationController?.setAttackStartedListener?.(null);
			this.swishSound.dispose();
			this.swishSound = null;
		}
		if (this.slashArcs) {
			this.slashArcs.dispose();
			this.slashArcs = null;
		}

		// Detach weapon mesh if equipped via equipWeaponByType
		if (this.weaponMesh && this.controller) {
			this.controller.detachFromBodyPart(this.weaponMesh);
			this.weaponMesh = null;
		}

		// Clear references
		this.equippedWeapon = null;
		this.currentWeaponType = null;
		this.player = null;
		this.controller = null;
	}
}
