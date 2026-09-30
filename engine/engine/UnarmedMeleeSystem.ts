/**
 * @fileoverview Unarmed Melee Combat System (Punches, Kicks)
 *
 * Player fistfight / kick combat. For held-weapon melee (swords, axes, spears),
 * see WeaponMeleeSystem.ts.
 *
 * ## Quick start (off by default — opt in per template)
 *
 * `PlayerController.setAttackSystem()` calls `setController` / `setupEventListeners` /
 * `setMobileControls` and binds Enter / left-click / mobile-action to attack.
 *
 * Once the character is ready, the system loads the punch/kick clips on demand
 * (they are optional built-ins, not loaded at startup) and auto-registers two
 * attack moves against them:
 *   - `punch` → `mPunching01` (right hand straight, type: 'punch')
 *   - `kick`  → `mKicking01`  (front leg kick,      type: 'kick')
 * Each press of the attack button picks one at random. The one-time load happens
 * when the attack system is attached, so a game without combat never fetches
 * these clips.
 *
 * To opt out of the defaults (e.g. you want to register your own moves only),
 * construct the system with `autoRegisterDefaultMoves: false`.
 *
 * For richer combat variety, register additional `CustomAttackMove`s against
 * any extra animations you load yourself — the engine does not ship a built-in
 * pack for hooks / uppercuts / roundhouse / fighting-stance idles.
 *
 * ## Hit detection
 *
 * Uses cone raycasting from the attacker's hand/foot bone (NOT physics body
 * collisions — `dispatcher.getNumManifolds()` won't see these hits). Targets
 * must implement `IDamageable` and have:
 *   - mesh.userData.physicsBody = rigidbody
 *   - mesh.userData.mass = number > 0
 *   - mesh.userData.damageableController = IDamageable instance
 * `NpcController` and `AnimalController` set this up automatically.
 *
 * The bone (hand vs foot, left vs right) is chosen from the move's `type` /
 * `side` fields. For animations registered without a `CustomAttackMove`, the
 * system falls back to parsing the clip name ("kick"/"roundhouse" → foot,
 * "punch" → hand; "_l"/"_r"/"left"/"right" → side).
 *
 * ## Related
 * - engine/IDamageable.ts          - Interface for hittable entities
 * - engine/WeaponMeleeSystem.ts    - Weapon combat (swords, axes, spears)
 * - engine/IPlayerAttack.ts        - Attack-system interface
 * - engine/AttackVFX.ts            - Visual effects for attacks
 */

import * as THREE from 'three';
import type { EngineLike, CustomAttackMove } from 'types/game.js';
import type { ICharacterAnimationController } from 'engine/ICharacterAnimationController.js';
import type { PlayerController } from 'engine/PlayerController.js';
import type { IPlayerAttack, AttackActionHandler } from 'engine/IPlayerAttack.js';
import { AttackVFX } from 'engine/AttackVFX.js';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import { gatherMeleeBodyHits } from 'engine/MeleeSweepTargets.js';
import { GameState, getGameStateManager } from 'engine/GameStateManager.js';
import { scheduleGameplaySeconds } from 'engine/GameplayTimers.js';
import { REQUIRED_ANIMATIONS, UNARMED_COMBAT_ANIMATIONS } from 'engine/AnimationPacks.js';

/**
 * Default attack moves auto-registered by UnarmedMeleeSystem when the character
 * is ready. Both motion IDs are optional built-ins (UNARMED_COMBAT_ANIMATIONS)
 * loaded on demand when the attack system attaches — see registerDefaultAttackMoves.
 *
 * Per-move motion options are tuned for the move's body action:
 *
 * - **punch** uses `splitBodyOnRun: true` so a punch thrown while running
 *   plays only on the upper body — the legs keep cycling instead of snapping
 *   to the punch pose (no foot-sliding). `filterRootMotion: true` because the
 *   punch is in-place; physics owns the player's translation.
 * - **kick** uses `interruptOnMovement: true` so any movement input cancels
 *   the kick mid-swing and locomotion resumes (kicks are a full-body commit;
 *   the player should be able to break out by walking). `filterRootMotion`
 *   true keeps the character planted while the leg swings.
 */
export const DEFAULT_UNARMED_ATTACK_MOVES: readonly CustomAttackMove[] = [
	{
		name: 'punch',
		animationMotionId: 'mPunching01',
		type: 'punch',
		side: 'right',
		speed: 1.5,
		splitBodyOnRun: true,
		filterRootMotion: true,
	},
	{
		name: 'kick',
		animationMotionId: 'mKicking01',
		type: 'kick',
		side: 'right',
		speed: 1.5,
		interruptOnMovement: true,
		filterRootMotion: true,
	},
];

/**
 * Configuration for unarmed melee combat system
 */
export interface UnarmedMeleeConfig {
	/** Maximum range for attack detection (in units) */
	attackRange?: number;
	/** Radius of sphere casting hitbox for more forgiving hit detection */
	hitboxRadius?: number;
	/**
	 * @deprecated No effect since strikes moved to the melee-weapon body-volume
	 * test (`gatherMeleeBodyHits`) — forgiveness now comes from `hitboxRadius`.
	 * Kept so shipped games passing it keep compiling.
	 */
	coneAngle?: number;
	/** Force multiplier for punches */
	punchForce?: number;
	/** Force multiplier for kicks */
	kickForce?: number;
	/** Impulse strength for punch hits on enemies */
	punchImpulse?: number;
	/** Impulse strength for kick hits on enemies */
	kickImpulse?: number;
	/**
	 * When true (default), the system loads the `mPunching01` (punch) and
	 * `mKicking01` (kick) clips on demand and registers them as `CustomAttackMove`s
	 * on the player's animation controller as soon as the character is ready. The
	 * clips are only fetched/bundled for games that actually attach combat. Set to
	 * false if the template wants to register only its own custom moves.
	 *
	 * Skipped automatically if any custom moves are already registered when
	 * the character becomes ready, so manual registration always wins.
	 */
	autoRegisterDefaultMoves?: boolean;

	/**
	 * When true (default), the unarmed pack's `FightingIdle` guard replaces the
	 * standing idle while this system is attached — staggered stance, fists up
	 * at the chin. Without it, punches launch out of the relaxed default idle
	 * and read as flailing. Set to false to keep the game's normal idle.
	 *
	 * Only applies when the default-move registration runs (it rides the same
	 * pack load); a template that registers its own moves owns its own stance.
	 */
	fightingStance?: boolean;
}

/**
 * Handles unarmed melee combat system including:
 * - Attack input (mouse and mobile)
 * - Attack animations and VFX
 * - Physics-based hit detection
 * - Movement blocking during attacks
 */
export class UnarmedMeleeSystem implements IPlayerAttack {
	private attackVFX: AttackVFX | null = null;
	private attackPressed: boolean = false;
	private mouseDownTime: number = 0;
	private readonly TAP_MAX_DURATION = 200; // milliseconds - maximum duration for a tap
	private boundOnMouseDown: ((event: MouseEvent) => void) | null = null;
	private boundOnMouseUp: ((event: MouseEvent) => void) | null = null;
	private mobileControls: any = null;
	private engine: EngineLike | null;
	private physicsWorld: PhysicsWorld;
	private controller: PlayerController | null = null;

	// Configurable melee parameters
	private config: Required<UnarmedMeleeConfig>;
	/** True while this system's FightingIdle guard is the active idle override. */
	private stanceInstalled = false;

	// Pre-allocated temps for hit detection (avoid per-frame allocations)
	private static readonly _tmpBoneWorldPos = new THREE.Vector3();
	private static readonly _tmpForward = new THREE.Vector3();
	private static readonly _tmpSweepEnd = new THREE.Vector3();
	private static readonly _tmpForceDir = new THREE.Vector3();
	private static readonly _tmpImpactNormal = new THREE.Vector3();

	constructor(
		engine: EngineLike | null,
		physicsWorld: PhysicsWorld,
		config?: UnarmedMeleeConfig
	) {
		this.engine = engine;
		this.physicsWorld = physicsWorld;

		// Set default configuration with optional overrides
		this.config = {
			attackRange: config?.attackRange ?? 2.0,
			fightingStance: config?.fightingStance ?? true,
			hitboxRadius: config?.hitboxRadius ?? 0.8,
			coneAngle: config?.coneAngle ?? 30,
			punchForce: config?.punchForce ?? 200.0,
			kickForce: config?.kickForce ?? 300.0,
			punchImpulse: config?.punchImpulse ?? 8,
			kickImpulse: config?.kickImpulse ?? 12,
			autoRegisterDefaultMoves: config?.autoRegisterDefaultMoves ?? true,
		};

		// Initialize melee attack VFX if engine has scene
		if (engine && engine.scene) {
			this.attackVFX = new AttackVFX(engine.scene);
		}
	}

	/**
	 * Update melee configuration at runtime
	 */
	updateConfig(config: Partial<UnarmedMeleeConfig>): void {
		this.config = {
			...this.config,
			...config,
		};
	}

	/**
	 * Get current melee configuration
	 */
	getConfig(): Required<UnarmedMeleeConfig> {
		return { ...this.config };
	}

	/**
	 * Set the controller reference.
	 * Called by PlayerController.setAttackSystem() when this system is attached.
	 *
	 * If `autoRegisterDefaultMoves` is enabled (default), schedules registration
	 * of the built-in `mPunching01` + `mKicking01` attack moves once the
	 * character is fully loaded. Existing custom moves are never overwritten.
	 */
	setController(controller: PlayerController): void {
		this.controller = controller;

		if (this.config.autoRegisterDefaultMoves) {
			controller.onCharacterReady(() => { void this.registerDefaultAttackMoves(); });
		}
	}

	/**
	 * Register the built-in punch + kick attack moves on the animation
	 * controller. The `mPunching01` / `mKicking01` clips are optional built-ins
	 * that are NOT loaded at startup, so we load them on demand here — the first
	 * time combat is attached — mirroring `WeaponMeleeSystem.equipWeaponByType`.
	 * Skipped entirely if any custom moves are already registered (template owns
	 * combat).
	 */
	private async registerDefaultAttackMoves(): Promise<void> {
		const animCtl = this.controller?.animationController;
		if (!animCtl?.registerCustomAttack) return;

		const existing = animCtl.getRegisteredAttackMoves?.() ?? [];
		if (existing.length > 0) return;

		// Load the punch/kick clips before registering the moves so the first
		// attack actually animates (registration only stores the move config —
		// playback needs the MixamoAnimationPlayer to exist).
		if (animCtl.loadAnimationPack) {
			// The pack carries the FightingIdle guard; pack name routing makes it
			// the IDLE override. `replaceLocomotion` clears the random-idle pool
			// so the guard is not fought by idle variations — but only when a
			// stance clip is actually present and wanted (under the CDN library
			// the pack has no idle clip, and clearing the pool with nothing to
			// replace it would leave the character with no idle at all).
			const pack = this.config.fightingStance
				? [...UNARMED_COMBAT_ANIMATIONS]
				: UNARMED_COMBAT_ANIMATIONS.filter(a => !a.name.toLowerCase().includes('idle'));
			const hasStance = pack.some(a => a.name.toLowerCase().includes('idle'));
			await animCtl.loadAnimationPack(pack, { replaceLocomotion: hasStance });
			this.stanceInstalled = hasStance;
		}

		// Resolve each default move's clip id from the pack that actually
		// loaded. The defaults are written with CDN ids (mPunching01), but the
		// pack carries whichever library is ACTIVE — under the generated
		// library the players are keyed mGenPunching01/mGenKicking01, and
		// registering the CDN id fails ("Mixamo player not found") leaving the
		// character with no attacks at all. Names are the cross-library key.
		const idByName = new Map(UNARMED_COMBAT_ANIMATIONS.map(a => [a.name, a.motionId]));
		for (const move of DEFAULT_UNARMED_ATTACK_MOVES) {
			const packId = move.type === 'kick' ? idByName.get('Kicking') : idByName.get('Punching');
			animCtl.registerCustomAttack({ ...move, animationMotionId: packId ?? move.animationMotionId });
		}
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
	setMobileControls(mobileControls: any): void {
		this.mobileControls = mobileControls;
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
	 * Update melee attack system (called every frame)
	 * @param deltaTime - Time since last frame in seconds
	 * @returns Whether movement should be blocked (true if attacking)
	 */
	update(deltaTime: number): boolean {
		if (!this.controller) return false;

		// Update attack VFX
		if (this.attackVFX) {
			this.attackVFX.update(deltaTime);
		}

		const player = this.controller.player;
		const animationController = this.controller.animationController;

		// During an in-progress attack, signal to block movement input.
		if (animationController?.getIsAttacking()) return true;

		if (!animationController) return false;

		// Handle attack input from mouse
		if (this.attackPressed) {
			this.performAttack(animationController, player);
			this.attackPressed = false; // Consume the attack input
		}

		// Handle attack input from mobile action button
		if (this.mobileControls?.actionPressed) {
			this.performAttack(animationController, player);
			this.mobileControls.resetActionPressed(); // Consume the attack input
		}

		return false;
	}

	/**
	 * Perform the attack animation and VFX
	 */
	private performAttack(
		animationController: ICharacterAnimationController,
		player?: THREE.Object3D
	): void {
		const attackResult = animationController.startAttack();
		if (attackResult.success) {
			// Create trail effect for the attacking limb based on animation name
			if (this.attackVFX && player) {
				this.attackVFX.createAttackTrail(player, attackResult.duration, attackResult.animationName);
			}

			// Track hit enemy controllers for this attack to avoid multiple hits on same enemy
			// Use enemyController reference instead of mesh objects since block characters have multiple meshes
			const hitEnemyControllers = new Set<any>();

			// Schedule multiple physics hit checks during attack animation
			// This catches hits whether player is very close or further away
			const token = animationController.getAttackPlaybackToken?.();
			const checkPoints = animationController.getAttackContactCheckPhases?.([0.15, 0.30, 0.40, 0.50]) ?? [0.15, 0.30, 0.40, 0.50];

			checkPoints.forEach(percentage => {
				// Gameplay time, not wallclock: a pause mid-swing HOLDS the
				// remaining checks instead of firing them into the PLAYING
				// gate and losing them. The gate stays as a second fence for
				// end-of-game states.
				scheduleGameplaySeconds(attackResult.duration * percentage, () => {
					if (token !== undefined && animationController.getAttackPlaybackToken?.() !== token) return;
					if (!getGameStateManager().isState(GameState.PLAYING)) return;
					if (player) {
						this.checkMeleeHit(player, attackResult.animationName, hitEnemyControllers, attackResult.moveConfig);
					}
				});
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
	 * Check for melee hit and apply force to physics objects
	 * @param player - Player object to get position and rotation
	 * @param animationName - Name of the attack animation
	 * @param hitEnemyControllers - Set to track enemy controllers already hit in this attack (to avoid multiple hits on same enemy)
	 * @param moveConfig - Optional custom attack move configuration with damage/range overrides
	 */
	private checkMeleeHit(player: THREE.Object3D, animationName: string, hitEnemyControllers: Set<any>, moveConfig?: CustomAttackMove): void {
		if (!this.physicsWorld || !this.engine || !this.engine.scene) return;

		const lowerName = animationName.toLowerCase();

		// Determine attack type - use moveConfig if available, otherwise infer from animation name
		// (only kick-vs-not matters below: the bone set, force and impulse all key off isKick)
		let isKick: boolean;
		let attackSide: 'left' | 'right';

		if (moveConfig) {
			isKick = moveConfig.type === 'kick';
			attackSide = moveConfig.side || 'right';
		} else {
			isKick = lowerName.includes('kick') || lowerName.includes('roundhouse');
			// Generic "attack" animations count as punches. Anything that is
			// neither a kick nor a punch has no limb to swing from.
			const isPunch = lowerName.includes('punch') || lowerName.includes('attack');
			if (!isKick && !isPunch) {
				console.warn('Unknown attack type:', animationName);
				return;
			}

			// Determine side (left/right) - default right unless animation name signals left
			attackSide = (lowerName.includes('left') || lowerName.includes('_l')) ? 'left' : 'right';
		}

		// Find the appropriate bone for this attack based on side
		let attackBone: THREE.Bone | undefined;
		const boneNames = isKick ? ['foot', 'toe', 'ankle'] : ['hand', 'wrist', 'finger'];

		// Side indicators for bone names
		const sideIndicators = attackSide === 'left' ? ['left', '_l', 'l_'] : ['right', '_r', 'r_'];

		player.traverse((child) => {
			if (attackBone || !(child instanceof THREE.Bone)) return;
			const boneName = child.name.toLowerCase();
			if (boneNames.some(n => boneName.includes(n)) && sideIndicators.some(s => boneName.includes(s))) {
				attackBone = child;
			}
		});

		if (!attackBone) {
			return;
		}

		// Get bone's world position (reuse static temp)
		const boneWorldPos = UnarmedMeleeSystem._tmpBoneWorldPos;
		attackBone.getWorldPosition(boneWorldPos);

		// Get player forward direction (reuse static temp)
		const playerForward = UnarmedMeleeSystem._tmpForward.set(0, 0, 1);
		playerForward.applyQuaternion(player.quaternion);

		const attackRange = moveConfig?.range ?? this.config.attackRange;
		const hitboxRadius = this.config.hitboxRadius;

		// SAME hit registration as melee weapons: a segment swept against the
		// engine's body HIT VOLUMES (capsules derived from each NPC/animal's
		// physics body — see gatherMeleeBodyHits, the exact call
		// WeaponMeleeSystem makes for its blade). This replaced a cone of
		// visual-mesh raycasts, which was a different, weaker mechanism than
		// weapons used and missed whenever meshes were skinned, layered, or
		// thin — reliably enough that AI-written games started hand-rolling
		// their own body-volume checks in game code.
		const sweepEnd = UnarmedMeleeSystem._tmpSweepEnd
			.copy(playerForward).multiplyScalar(attackRange).add(boneWorldPos);
		const bodyHits = gatherMeleeBodyHits(this.engine.scene, boneWorldPos, sweepEnd, hitboxRadius);
		if (bodyHits.length === 0) return;

		// Nearest target not already hit by this swing.
		bodyHits.sort((a, b) => a.distance - b.distance);
		const hit = bodyHits.find(h => {
			const c = h.object.userData?.damageableController || h.object.userData?.enemyController;
			return c && !hitEnemyControllers.has(c);
		});
		if (!hit) return;

		const hitObject = hit.object;
		const damageableController = hitObject.userData.damageableController || hitObject.userData.enemyController;
		hitEnemyControllers.add(damageableController);

		const hitBody = hitObject.userData.physicsBody as RAPIER.RigidBody;
		const mass = hitObject.userData.mass || 0;

		// Force direction: push away from player, with upward lift for drama
		const forceDirection = UnarmedMeleeSystem._tmpForceDir.copy(playerForward);
		forceDirection.y += 0.3;
		forceDirection.normalize();

		const defaultForce = isKick ? this.config.kickForce : this.config.punchForce;
		const forceMagnitude = moveConfig?.force ?? defaultForce;
		const hitPoint = hit.point;

		// Physical shove only for dynamic bodies; damage flows regardless (NPC
		// bodies are kinematic — the old `mass <= 0 return` here would have
		// silently skipped them if their meshes weren't tagged with a mass).
		if (mass > 0 && hitBody) {
			hitBody.applyImpulseAtPoint(
				{
					x: forceDirection.x * forceMagnitude,
					y: forceDirection.y * forceMagnitude,
					z: forceDirection.z * forceMagnitude
				},
				{ x: hitPoint.x, y: hitPoint.y, z: hitPoint.z },
				true // wake up
			);
		}

		if (this.attackVFX) {
			const impactNormal = UnarmedMeleeSystem._tmpImpactNormal.copy(forceDirection).negate();
			this.attackVFX.createImpactEffect(hit.point, impactNormal);
		}

		if (damageableController && typeof damageableController.onMeleeHit === 'function') {
			const defaultImpulse = isKick ? this.config.kickImpulse : this.config.punchImpulse;
			const impulseStrength = moveConfig?.damage ?? defaultImpulse;
			damageableController.onMeleeHit(forceDirection, impulseStrength);
		}
	}

	/**
	 * Dispose resources
	 */
	dispose(): void {
		// Remove event listeners
		this.removeEventListeners();

		// The system that installed the guard stance removes it. setAttackSystem
		// disposes the outgoing system, so this covers every switch path —
		// picking up a gun used to leave the character aiming from a boxing
		// stance because nothing on the ranged side owns idle at all. Reloading
		// the required pack restores the default idle/walk/run set (all cached,
		// so this is cheap) via the same route WeaponMeleeSystem's unequip uses.
		if (this.stanceInstalled) {
			this.stanceInstalled = false;
			const animCtl = this.controller?.animationController;
			if (animCtl?.loadAnimationPack) {
				// Fire-and-forget is safe against the successor system's own
				// locomotion load (unarmed → melee switch): REQUIRED clips are
				// loaded at boot, so this resolves from cache before a melee
				// pack that still has attack clips to fetch — and the melee
				// equip starts its load after this dispose returns, so it is
				// the later writer either way.
				void animCtl.loadAnimationPack([...REQUIRED_ANIMATIONS], { replaceLocomotion: true });
			}
		}

		// Dispose attack VFX
		if (this.attackVFX) {
			this.attackVFX.dispose();
			this.attackVFX = null;
		}
	}
}
