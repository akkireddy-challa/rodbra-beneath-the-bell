/**
 * Arcade-carve ski movement (SSX / Steep class feel) on the existing
 * kinematic player body, driven through the shared Rapier
 * KinematicCharacterController exactly like WalkingAndJumpingMovement:
 * collide-and-slide + autostep + snap-to-ground. No second rigid body,
 * no body-type swapping, no camera replacement.
 *
 * Grounded: gravity projected on the (smoothed) ground plane accelerates
 * the skier downhill; A/D carve the heading and grip redirects momentum;
 * W tucks (less drag, higher cap) or skate-pushes at low speed; S brakes.
 * Air: ballistic, gentle steering; action+left/right spins, action+forward
 * plays the ForwardFlip clip; landing assist levels rotation near touchdown.
 */

import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { getRapier } from 'engine/physics/RapierPhysics.js';
import { sphereColliderDesc } from 'engine/physics/BallPhysics.js';
import type { IPlayerMovement, PlayerMovementKeys } from 'engine/IPlayerMovement.js';
import type { SkiMovementHost } from 'engine/ski/SkiMovementHost.js';
import type { PhysicsWorld, RaycastResult } from 'engine/physics/PhysicsWorld.js';
import { CollisionGroup, CollisionMask, makeCollisionGroups } from 'engine/CollisionLayers.js';
import { type SkiConfig, DEFAULT_SKI_CONFIG, mergeSkiConfig } from 'engine/ski/SkiConfig.js';
import { VISUAL_GROUND_SINK_M } from 'engine/loaders/PlayerLoader.js';
import {
	downhillAcceleration,
	turnRateDegFor,
	carveVelocity,
	gripRateFor,
	frictionMultipliers,
	nearestSpinRest,
	landingSpinErrorDeg,
	groundFollowDy,
	wouldSeparate,
	applyDrag,
	evaluateLiftoff,
} from 'engine/ski/SkiMath.js';
import { SkiEquipment } from 'engine/ski/SkiEquipment.js';
import { SkiCameraDirector } from 'engine/ski/SkiCameraDirector.js';

const DEG2RAD = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);
/**
 * Extra downward request while grounded so contact survives small surface
 * irregularities and frame jitter. Collide-and-slide clamps at the surface,
 * so the overshoot never pushes the body into the ground.
 */
const GROUND_STICK_M = 0.06;
/** Drop from the visual feet origin (player root) down to the soles, where the
 *  board/skis ride. Relative to the actual feet, tuned by eye. */
const BOARD_SOLE_DROP = 0.3;
/** Lift the VISUAL character so it rides on the stepped voxel snow surface
 *  rather than the lower physics trimesh it actually stands on (without this
 *  the whole character-board system looks sunk into the snow). Tunable.
 *  VISUAL_GROUND_SINK_M is added back because getFeetOffsetY() now folds the
 *  generic ground-sink compensation in — ski keeps its own tuned lift, so the
 *  net visual height here is EXACTLY what it was before that change. */
const CHAR_SNOW_LIFT = 0.15 + VISUAL_GROUND_SINK_M;
/** Snowboard foot IK + deck heights, tied together so the deck stays glued under
 *  the soles instead of floating off the feet. The ankle target rides ANKLE_LIFT
 *  above the (ski) sole drop; the deck sits DECK_BELOW_ANKLE under that ankle
 *  (≈ boot height) so it tracks the feet down. Tunable. */
const SNOWBOARD_ANKLE_LIFT = 0.25;
const SNOWBOARD_DECK_BELOW_ANKLE = 0.4;
/** Spine-bone local axis the crouch bends the back forward around. The body is
 *  yawed sideways for the snowboard stance, so the down-the-hill bend is the
 *  local-Z, not local-X. (The stance wind twists around local-Y, i.e. UP.) */
const STANCE_PITCH_AXIS = new THREE.Vector3(0, 0, 1);

/** The player body's single collider, or null while it has none. */
function firstCollider(body: RAPIER.RigidBody): RAPIER.Collider | null {
	return body.numColliders() > 0 ? body.collider(0) : null;
}

/** Drop from the capsule's centre to its feet (halfHeight + radius); `fallback`
 *  covers a body whose collider isn't available. */
function capsuleHalfExtent(collider: RAPIER.Collider | null, fallback = 0.9): number {
	if (!collider) return fallback;
	const capsule = collider.shape as unknown as { halfHeight: number; radius: number };
	return capsule.halfHeight + capsule.radius;
}

export interface SkiState {
	/** Horizontal speed (m/s). */
	speed: number;
	/** Heading yaw (rad, gameplay convention: forward = (sin, 0, cos)). */
	heading: number;
	/** World-space velocity including vertical (m/s). */
	velocity: THREE.Vector3;
	/** How sideways the board/skis are to their own momentum: 0 = clean carve,
	 *  1 = fully sideways (hard skid). |momentumDir × boardForward|. This is the
	 *  same value the carve uses to scrub speed — drive snow spray / powder off it. */
	skid: number;
	grounded: boolean;
	/** World-space Y of the board deck (soles/snow contact under the player).
	 *  Spawn ground-effects (snow spray) here, not at the hips. XZ = player root XZ. */
	boardContactY: number;
	/** Seconds airborne (0 when grounded). */
	airtimeSeconds: number;
	/** Current ground slope (deg, 0 = flat). */
	slopeAngleDeg: number;
	/** Last completed trick: 'spin' | 'flip' | null. Cleared on next takeoff. */
	lastTrick: 'spin' | 'flip' | 'bail' | null;
	/**
	 * True while a crash bail owns the player (ragdoll tumble or fallback
	 * ball). Game code can watch the true-to-false transition to apply its own
	 * recovery policy, e.g. `teleport()` back to the last checkpoint.
	 */
	bailing: boolean;
}

export class SkiMovement implements IPlayerMovement {
	private config: SkiConfig;
	private equipment: SkiEquipment;

	// Motor state
	private heading: number = 0;
	/** Steering hold-ramp: seconds the current turn direction has been held, and
	 *  the last turn direction (-1/0/+1). A tap barely turns; a sustained hold
	 *  builds to the full rate. Reversing direction restarts the ramp. */
	private turnHeldSec: number = 0;
	private lastTurnDir: number = 0;
	private horizVelX: number = 0;
	private horizVelZ: number = 0;
	private verticalVelocity: number = 0;
	private grounded: boolean = false;
	private airtime: number = 0;
	/** World-space Y of the board deck (the soles/snow contact under the player).
	 *  Snow-spray VFX spawns powder here, not at the hips root; the board's XZ is
	 *  the player root XZ. */
	private boardContactY: number = 0;
	private groundNormal: THREE.Vector3 = new THREE.Vector3(0, 1, 0);
	private slopeAngleDeg: number = 0;
	private terrainFriction: number = 0.5;
	private canJump: boolean = true;
	private jumpCount: number = 0;
	// Slope-follow vertical velocity (m/s) measured last frame. Convex-rollover
	// liftoff compares its rate of change to gravity: a steady slope keeps a
	// matching follow velocity (stay glued); a slope that steepens faster than
	// gravity can bend our path down means the ground falls away — we separate.
	private prevVyFollow: number = 0;
	// The board's REAL vertical velocity (m/s) achieved last frame by the KCC
	// (mv.y/dt). + when collide-and-slide pushed it up a bump, − descending. The
	// inertia model carries THIS into a ballistic arc on separation — never a
	// synthesized value — so the board only goes up if it was already going up.
	private actualVy: number = 0;
	// Lightly-smoothed surface normal used ONLY for crest detection, so a crest is
	// not lagged by the heavier slope-acceleration normal smoothing.
	private launchNormal: THREE.Vector3 = new THREE.Vector3(0, 1, 0);
	// Camera-only "airborne framing" latch, decoupled from the physics grounded
	// flag (which now toggles on every hop). Enters after cameraAirEnterSec of air,
	// holds for cameraAirExitTailSec after landing — short hops keep grounded
	// framing so the camera doesn't strobe.
	private camAirborne: boolean = false;
	private camAirborneTail: number = 0;
	// Consecutive grounded frames; the liftoff test arms only after 2 so a
	// landing frame's transient (the airborne follow value) can't fire a pop.
	private groundedStableFrames: number = 0;
	// Forced-airborne window (s) right after a launch so a pop cannot instantly
	// re-ground on the receding surface and flicker.
	private airLockSec: number = 0;
	// One-time: the snowboard stance bone offsets are installed on the animation
	// controller once it is available; the torso quaternion is then mutated in
	// place each frame (the controller holds the map by reference).
	private stanceApplied: boolean = false;
	// Tuck/crouch (W held at speed): drag thins, a small push kicks in, and the
	// snowboard hips sink so the foot-IK bends the knees + the back leans forward.
	private tucking: boolean = false;
	private jumpCharging: boolean = false; // jump button held → deeper crouch wind-up
	private ascendPrev: boolean = false;   // jump-on-release edge detection
	private crouchDrop: number = 0;        // eased hip-sink in metres
	private readonly stanceOffsets = new Map<string, THREE.Quaternion>();
	private readonly torsoOffsetQ = new THREE.Quaternion();
	private readonly tmpQStanceA = new THREE.Quaternion();
	private readonly tmpQStanceB = new THREE.Quaternion();

	// Trick state
	private spinOffsetDeg: number = 0;
	private flipUsedThisAir: boolean = false;
	private flipRemaining: number = 0;
	private lastTrick: 'spin' | 'flip' | 'bail' | null = null;

	// Visual lean (visual only; the physics capsule never rotates)
	private visualRoll: number = 0;
	private visualPitch: number = 0;

	// Kinematic target tracking (mirrored from WalkingAndJumpingMovement:
	// the motor runs per render frame but physics substeps at 60 Hz, so a
	// frame without a substep must continue from the still-pending target
	// instead of recomputing from the unchanged body translation).
	private pendingFrom: THREE.Vector3 | null = null;
	private pendingTarget: THREE.Vector3 | null = null;

	// Camera-locked rotation (ranged weapons)
	private cameraLockRotation: boolean = false;
	private lockCameraController: { getHorizontalAngle: () => number } | null = null;
	/** Heading is adopted from the player's spawn yaw on the first update. */
	private headingInitialized: boolean = false;
	/** One-time spawn ground-snap done (see the settle step in update). */
	private spawnSettled: boolean = false;
	/**
	 * Active crash-bail. 'ragdoll' = the engine's articulated block-part
	 * ragdoll owns the player (preferred); 'ball' = fallback dynamic tumbling
	 * body for characters without a block renderer.
	 */
	private bail:
		| { mode: 'ragdoll'; recoverTimer: number; elapsed: number }
		| { mode: 'ball'; body: RAPIER.RigidBody; recoverTimer: number; elapsed: number; physicsWorld: PhysicsWorld }
		| null = null;
	private bailRng: number = 12345;
	/** Obstacle-feedback suppression window after a bail recovery (see endBail). */
	private feedbackGraceSec: number = 0;

	// Attached-controller bookkeeping
	private attachedController: SkiMovementHost | null = null;
	private cameraFollowActive: boolean = false;
	/** SSX-style chase camera state machine + smoothing (grounded/air/wipeout). */
	private cameraDirector: SkiCameraDirector;

	// Last body / physics-world refs seen in update(), used by teleport() when
	// no attached controller is available yet.
	private lastBody: RAPIER.RigidBody | null = null;
	private lastPhysicsWorld: PhysicsWorld | null = null;

	// Reusable temporaries
	private tmpAccel: THREE.Vector3 = new THREE.Vector3();
	private tmpRayOrigin: THREE.Vector3 = new THREE.Vector3();
	private tmpRayDir: THREE.Vector3 = new THREE.Vector3(0, -1, 0);
	private tmpForward: THREE.Vector3 = new THREE.Vector3();
	private tmpProbe: THREE.Vector3 = new THREE.Vector3();
	private tmpRampDir: THREE.Vector3 = new THREE.Vector3();
	private tmpQLean: THREE.Quaternion = new THREE.Quaternion();
	private tmpQPitch: THREE.Quaternion = new THREE.Quaternion();
	private tmpQTilt: THREE.Quaternion = new THREE.Quaternion();
	private tmpQYaw: THREE.Quaternion = new THREE.Quaternion();
	private tmpQBoard: THREE.Quaternion = new THREE.Quaternion();
	private tmpAxisH: THREE.Vector3 = new THREE.Vector3();
	private tmpAxisR: THREE.Vector3 = new THREE.Vector3();
	private tmpBoardPos: THREE.Vector3 = new THREE.Vector3();
	/** Reused foot-IK targets (ankle world pos + foot world quat per side, plus
	 *  the facing for the knee pole) the leg IK plants the feet onto. */
	private footIkTargets = {
		left: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() },
		right: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() },
		facing: new THREE.Quaternion(),
	};

	constructor(config?: Partial<SkiConfig> | Record<string, unknown>) {
		this.config = mergeSkiConfig(config);
		this.equipment = new SkiEquipment(this.config);
		// Shares this.config by reference; updateConfig mutates it in place, so
		// the director always reads current values without a setter.
		this.cameraDirector = new SkiCameraDirector(this.config);
	}

	// Lifecycle (called by SkiMovementHost.setMovementSystem / constructor after Task 5;
	// also self-invoked from update() as a robustness path)

	onAttached(playerController: SkiMovementHost): void {
		this.attachedController = playerController;
		// Re-arm the one-time spawn ground-snap for this attach (a fresh run /
		// movement-system swap should settle onto the surface on its next frame).
		this.spawnSettled = false;
		this.stanceApplied = false;
		this.equipment.attach(playerController);
		if (this.config.cameraAutoFollow) {
			const cam = playerController.getCameraController();
			if (cam && typeof cam.setExternalOrbitDrive === 'function' && typeof cam.driveOrbit === 'function') {
				// Ski owns the camera completely: manual orbit is disabled
				// and the orbit is driven every frame (yaw behind the travel
				// direction, elevation scaling with slope, distance with
				// speed). Snaps behind the skier on the first frame.
				cam.setExternalOrbitDrive(true);
				this.cameraDirector.activate(cam);
				this.cameraFollowActive = true;
			} else if (cam && typeof cam.setAutoFollow === 'function') {
				// Legacy camera without drive support.
				cam.setAutoFollow(true, this.config.cameraFollowResponse);
				this.cameraFollowActive = true;
			}
		}
	}

	onDetached(playerController: SkiMovementHost): void {
		this.cleanupBail();
		playerController.animationController?.setManualBoneOffsets?.(null);
		playerController.animationController?.setFootIkTargets?.(null);
		this.stanceApplied = false;
		this.equipment.detach(playerController);
		const cam = playerController.getCameraController();
		if (this.cameraFollowActive && cam) {
			cam.setExternalOrbitDrive?.(false);
			cam.setTargetForwardDirection?.(null);
			cam.setAutoFollow?.(false);
			this.cameraDirector.deactivate(cam);
		}
		this.cameraFollowActive = false;
		// Clear visual-only rotation so walking starts upright.
		if (playerController.player) {
			playerController.player.rotation.x = 0;
			playerController.player.rotation.z = 0;
		}
		this.attachedController = null;
	}

	update(
		deltaTime: number,
		playerController: SkiMovementHost,
		keys: PlayerMovementKeys,
		isGrounded: boolean,
		moveDirection: THREE.Vector3,
		playerBody: RAPIER.RigidBody,
		physicsWorld: PhysicsWorld,
	): void {
		void isGrounded;     // grounded comes from the KCC + ground ray below
		void moveDirection;  // ski steering is heading-relative, not camera-relative
		if (!playerBody) return; // body may be freed/nulled (e.g. dead NPC still updating)
		if (deltaTime <= 0) return;

		this.lastBody = playerBody;
		this.lastPhysicsWorld = physicsWorld;

		// Robustness: if installed without setMovementSystem (direct field
		// assignment), self-attach on first update.
		if (this.attachedController !== playerController) {
			this.onAttached(playerController);
		}

		// Adopt the spawn yaw (worldProfileData.playerSpawnRotationY lands on
		// the player object) the first time we run — otherwise every run
		// starts facing +Z with the chase cam snapped the wrong way.
		if (!this.headingInitialized) {
			if (playerController.player) this.heading = playerController.player.rotation.y;
			this.headingInitialized = true;
			this.cameraDirector.reset();
		}

		// Crash bail: a dynamic body owns the player until it settles.
		if (this.bail) {
			this.updateBail(deltaTime, playerController, playerBody);
			return;
		}

		const RAPIERMOD = getRapier();
		const collider = firstCollider(playerBody);
		if (!collider) return;
		const capsuleHalf = capsuleHalfExtent(collider);

		// Hold the snowboard crouch as manual bone offsets, once the animation
		// controller exists (a posture without an animation clip).
		if (this.config.equipmentStyle === 'snowboard' && !this.stanceApplied) {
			const ac = playerController.animationController;
			if (ac?.setManualBoneOffsets) {
				this.stanceOffsets.set('torso', this.torsoOffsetQ);
				this.refreshStanceOffsets(); // initial pose (crouchDrop = 0)
				ac.setManualBoneOffsets(this.stanceOffsets);
				this.stanceApplied = true;
			}
		}

		// ---- One-time spawn settle ----
		// World spawn points sit a small clearance above the surface so nothing
		// spawns embedded. A walking player absorbs that gap; a skier would
		// free-fall it as a dead pause before the slope engages ("press Play,
		// nothing happens for ~half a second, then it goes"). If the ground is
		// within spawnSettleMaxDrop below the feet on our first frame, drop the
		// capsule straight onto it so the run starts grounded. Only ever snaps
		// DOWN and only over a short gap, so intentional air-drop starts (a long
		// fall onto the piste) are untouched.
		if (!this.spawnSettled) {
			this.spawnSettled = true;
			if (this.config.spawnSettleMaxDrop > 0) {
				const tt = playerBody.translation();
				this.tmpRayOrigin.set(tt.x, tt.y, tt.z);
				const hit = physicsWorld.raycast(
					this.tmpRayOrigin, this.tmpRayDir,
					capsuleHalf + this.config.spawnSettleMaxDrop, CollisionMask.GROUND_CHECK,
				);
				const targetY = hit.hasHit ? hit.hitPoint.y + capsuleHalf + 0.02 : tt.y;
				if (hit.hasHit && targetY < tt.y) {
					playerBody.setTranslation({ x: tt.x, y: targetY, z: tt.z }, true);
					this.pendingFrom = null;
					this.pendingTarget = null;
				}
			}
		}

		// ---- Ground sampling (ray + smoothed normal) ----
		const t0 = playerBody.translation();
		this.tmpRayOrigin.set(t0.x, t0.y, t0.z);
		// When airborne and falling, extend the ray so it reaches the full
		// landing-assist window at the current fall speed (the old fixed
		// capsuleHalf + 0.5 range-clamped the configured window before it could
		// ever apply at real fall speeds).
		const fallSpeed = Math.max(0, -this.verticalVelocity);
		const rayLength = this.grounded
			? capsuleHalf + 0.5
			: capsuleHalf + Math.max(0.5, fallSpeed * this.config.landingAssistTime + 0.3);
		const ray: RaycastResult = physicsWorld.raycast(
			this.tmpRayOrigin,
			this.tmpRayDir,
			rayLength,
			CollisionMask.GROUND_CHECK,
		);
		if (ray.hasHit && ray.hitNormal.y > 0.2) {
			const k = 1 - Math.exp(-deltaTime / this.config.normalSmoothTime);
			this.groundNormal.lerp(ray.hitNormal, k).normalize();
			// Crest-detection normal: barely smoothed so a crest isn't lagged.
			const lk = 1 - Math.exp(-deltaTime / Math.max(1e-4, this.config.launchNormalSmoothTime));
			this.launchNormal.lerp(ray.hitNormal, lk).normalize();
		} else if (!this.grounded) {
			// Airborne with no ground nearby: relax toward flat.
			const k = 1 - Math.exp(-deltaTime / (this.config.normalSmoothTime * 3));
			this.groundNormal.lerp(UP, k).normalize();
			this.launchNormal.copy(this.groundNormal);
		}
		this.slopeAngleDeg = Math.acos(Math.min(1, Math.max(-1, this.groundNormal.y))) / DEG2RAD;

		const speed = Math.hypot(this.horizVelX, this.horizVelZ);
		const fric = frictionMultipliers(this.terrainFriction);

		// Camera-locked rotation (ranged weapons): heading follows the camera.
		// Applied before the carve dispatch so it affects the SAME frame's
		// physics, and keeps this state mutation out of updateVisuals.
		if (this.cameraLockRotation && this.lockCameraController) {
			this.heading = this.lockCameraController.getHorizontalAngle() + Math.PI;
		}

		if (this.grounded) {
			this.updateGrounded(deltaTime, keys, speed, fric);
		} else {
			this.updateAirborne(deltaTime, keys, ray, capsuleHalf);
		}

		// ---- Apply via the shared KCC (collide-and-slide + autostep + snap) ----
		// Vertical: ballistic by default (jump take-off and airborne both set
		// verticalVelocity and fall through here). Grounded and not jumping, we
		// glue to the measured plane — UNLESS a fast convex rollover means the
		// feet would have to drop FASTER than free-fall to stay on it. The ground
		// can only push, never pull, so there we separate and catch air, carrying
		// the slope velocity we had. groundFollowDy is the glued descent; we
		// compare it against what gravity actually delivers this frame (built from
		// last frame's slope-follow velocity). The 2-frame arm skips the landing
		// transient, where prevVyFollow is still the airborne value.
		let separatedThisFrame = false;
		const cfg = this.config;
		const g = cfg.gravity;
		const followDy = groundFollowDy(this.groundNormal, this.horizVelX, this.horizVelZ, deltaTime);
		let desiredY = this.verticalVelocity * deltaTime;
		if (this.grounded && this.verticalVelocity <= 0) {
			if (cfg.ballisticLiftoff) {
				// INERTIA MODEL: the board keeps its ACTUAL velocity; the ground only
				// stops penetration — it never adds upward speed and never pulls down.
				// So the board leaves the surface exactly when staying glued would need
				// it to drop FASTER than gravity can pull its current velocity down (a
				// convex rollover / the ground falling away from the rider's inertia).
				// On separation it CONTINUES WITH ITS REAL VELOCITY (actualVy) — never a
				// synthesized pop, so the snow is never bouncy: it only goes up if it was
				// already going up (rode up a ramp). followDescent uses the lightly
				// smoothed launchNormal so a crest isn't lagged by slope-accel smoothing.
				const followDescent = Math.max(
					0, -groundFollowDy(this.launchNormal, this.horizVelX, this.horizVelZ, deltaTime),
				);
				const lift = evaluateLiftoff({
					followDescent,
					actualVy: this.actualVy,
					gravity: g,
					dt: deltaTime,
					stable: this.groundedStableFrames >= 2,
					margin: cfg.liftoffStickMargin,
					launchVyMax: cfg.launchVyMax,
					terminalVelocity: cfg.terminalVelocity,
				});
				if (lift.separate) {
					this.verticalVelocity = lift.launchVy;
					// Clear the KCC snap band only for a genuine UPWARD continuation so
					// collide-and-slide + snap-to-ground don't eat it. A descent detach
					// (already going down) needs no lift.
					desiredY = lift.launchVy * deltaTime + (lift.launchVy > 0 ? GROUND_STICK_M : 0);
					separatedThisFrame = true;
					this.airLockSec = 0.12;
				} else {
					desiredY = followDy - GROUND_STICK_M;
					this.verticalVelocity = 0;
				}
			} else {
				// LEGACY (ballisticLiftoff off): glue to the plane, separate only on a
				// convex rollover steeper than free-fall. Unchanged from before.
				const followDescent = -followDy;
				const freeFallDescent = Math.max(
					0, (-this.prevVyFollow + g * deltaTime) * deltaTime,
				);
				if (this.groundedStableFrames >= 2
					&& wouldSeparate(followDescent, freeFallDescent, cfg.liftoffStickMargin)) {
					this.verticalVelocity = this.prevVyFollow - g * deltaTime;
					desiredY = this.verticalVelocity * deltaTime;
					separatedThisFrame = true;
					this.airLockSec = 0.12;
				} else {
					desiredY = followDy - GROUND_STICK_M;
					this.verticalVelocity = 0;
				}
			}
		}
		this.prevVyFollow = followDy / deltaTime;
		const desired = {
			x: this.horizVelX * deltaTime,
			y: desiredY,
			z: this.horizVelZ * deltaTime,
		};
		const controller = physicsWorld.getCharacterController();
		const kccFilter = collider.collisionGroups() | (CollisionGroup.DYNAMIC_PROP << 16);
		controller.computeColliderMovement(
			collider,
			desired,
			RAPIERMOD.QueryFilterFlags.EXCLUDE_SENSORS,
			kccFilter,
			(other) => other.handle !== collider.handle,
		);
		const mv = controller.computedMovement();
		const groundedNow = controller.computedGrounded();
		// The board's REAL vertical velocity this frame (what collide-and-slide
		// actually achieved — riding up a bump pushes it up, the slope/landing
		// absorbs downward). This is the inertia the liftoff test carries next
		// frame; it is never synthesized, so a launch can only be as fast as the
		// board was genuinely already moving.
		this.actualVy = mv.y / deltaTime;

		// Robust grounding (see probeFeet): accept the KCC's verdict, OR any foot
		// point in contact, OR — when nearly still — ground within coyote range,
		// so a ledge can never strand the player with no skate-push or jump. A
		// rising body (a jump) and the brief air-lock after a launch stay airborne
		// so neither re-grounds on the spot.
		const probe = this.probeFeet(t0, capsuleHalf, ray, physicsWorld);
		let groundedRobust = groundedNow || probe.anyContact
			|| (speed < 0.5 && probe.minFeetDistance < this.config.coyoteGroundDistance);
		if (separatedThisFrame || this.airLockSec > 0 || this.verticalVelocity > 0.01) {
			groundedRobust = false;
		}
		if (this.airLockSec > 0) this.airLockSec -= deltaTime;

		// ---- Obstacle velocity feedback (elastic, never a spring) ----
		// The KCC blocks MOVEMENT but knows nothing about our stored velocity:
		// without feedback, pressing against a tree banks full speed that
		// releases the instant the player turns away (and, airborne, has no
		// cap). When the slide is SLOWED, keep what it achieved and REFLECT a
		// fraction of the blocked component (elastic bump); bail on hard hits.
		//
		// Gate on actual speed LOSS, never gain. The KCC also produces MORE
		// horizontal motion than our stored velocity wanted — gravity redirects
		// a fall down the slope on the landing frame, or depenetrates the
		// capsule out of geometry. Treating that gain as a "blocked obstacle"
		// and reflecting it PUMPS speed: it banked the landing redirect into a
		// sudden burst (the player rocketing off a beat after Play). An obstacle
		// response must only ever remove speed.
		//
		// Also suppressed for a short grace after a bail recovery: the capsule
		// can stand up overlapping the very obstacle that caused the crash.
		if (this.feedbackGraceSec > 0) {
			this.feedbackGraceSec -= deltaTime;
		} else {
			const speedBefore = Math.hypot(this.horizVelX, this.horizVelZ);
			const achievedVx = mv.x / deltaTime;
			const achievedVz = mv.z / deltaTime;
			const achievedSpeed = Math.hypot(achievedVx, achievedVz);
			// Only genuine blocking: the slide lost more than slide-friction
			// noise (>1 m/s). A speed-up is gravity/depenetration, not a hit.
			if (speedBefore - achievedSpeed > 1) {
				const blockedVx = this.horizVelX - achievedVx;
				const blockedVz = this.horizVelZ - achievedVz;
				const preVx = this.horizVelX;
				const preVz = this.horizVelZ;
				this.horizVelX = achievedVx - blockedVx * this.config.obstacleBounciness;
				this.horizVelZ = achievedVz - blockedVz * this.config.obstacleBounciness;
				// Hard guarantee: an obstacle bump never returns more speed than
				// came in (a near-perpendicular redirect could otherwise nudge the
				// magnitude up through the reflected cross component).
				const after = Math.hypot(this.horizVelX, this.horizVelZ);
				if (after > speedBefore && after > 1e-6) {
					const s = speedBefore / after;
					this.horizVelX *= s;
					this.horizVelZ *= s;
				}
				const lost = speedBefore - Math.hypot(this.horizVelX, this.horizVelZ);
				// Don't crash on a rideable up-ramp. A probe in the travel
				// direction that hits a surface tilted UP (not a near-vertical
				// wall) means we can ride it: collide-and-slide climbs it and a
				// convex lip then launches us. Only walls/trees still bail.
				let rampAhead = false;
				const preSpeed = Math.hypot(preVx, preVz);
				if (preSpeed > 1) {
					const inv = 1 / preSpeed;
					this.tmpRampDir.set(preVx * inv, 0, preVz * inv);
					this.tmpRayOrigin.set(t0.x, t0.y, t0.z);
					const fwd = physicsWorld.raycast(
						this.tmpRayOrigin, this.tmpRampDir, capsuleHalf + 1.0, CollisionMask.GROUND_CHECK,
					);
					rampAhead = fwd.hasHit && fwd.hitNormal.y > 0.5;
				}
				if (!rampAhead && lost > this.config.crashSpeedLoss && speedBefore > this.config.crashMinSpeed) {
					this.startBail(physicsWorld, playerBody, preVx, preVz);
				} else if (!rampAhead && lost > 2 && this.config.cameraImpactKickScale > 0) {
					// Non-crash obstacle bump: a quick camera kick scaled by the hit
					// (clamped so a near-crash doesn't over-shake before the bail).
					this.cameraDirector.registerImpact(Math.min(0.18, lost * this.config.cameraImpactKickScale));
				}
			}
		}

		// Pending-target accumulation (see WalkingAndJumpingMovement for the
		// full rationale: never recompute from an unchanged body translation).
		const t = playerBody.translation();
		let baseX = t.x, baseY = t.y, baseZ = t.z;
		if (this.pendingFrom && this.pendingTarget) {
			const f = this.pendingFrom, p = this.pendingTarget;
			const df = (t.x - f.x) ** 2 + (t.y - f.y) ** 2 + (t.z - f.z) ** 2;
			const dp = (t.x - p.x) ** 2 + (t.y - p.y) ** 2 + (t.z - p.z) ** 2;
			if (df < 1e-12 && dp >= 1e-12) { baseX = p.x; baseY = p.y; baseZ = p.z; }
		}
		playerBody.setNextKinematicTranslation({ x: baseX + mv.x, y: baseY + mv.y, z: baseZ + mv.z });
		this.pendingFrom = (this.pendingFrom ?? new THREE.Vector3()).set(t.x, t.y, t.z);
		this.pendingTarget = (this.pendingTarget ?? new THREE.Vector3()).set(baseX + mv.x, baseY + mv.y, baseZ + mv.z);

		// Ski owns the visual transform (handlesPlayerPositionSync), so the
		// template no longer positions the player. Place the visual root at the
		// FEET: body center y minus the capsule half-height, minus the
		// root-to-feet gap (nonzero only for block characters) — same two terms
		// the template's syncPlayerPhysics subtracts. updateVisuals below only
		// handles rotation.
		if (playerController.player) {
			const feetOffsetY = playerController.playerLoader?.getFeetOffsetY() ?? 0;
			playerController.player.position.set(
				baseX + mv.x,
				baseY + mv.y - capsuleHalf - feetOffsetY + CHAR_SNOW_LIFT,
				baseZ + mv.z,
			);
		}

		// ---- Grounded transition bookkeeping ----
		if (groundedRobust && !this.grounded) this.onLanded();
		if (!groundedRobust && this.grounded) this.onTakeoff();
		this.grounded = groundedRobust;
		if (groundedRobust) {
			if (this.verticalVelocity < 0) this.verticalVelocity = 0;
			this.airtime = 0;
			this.jumpCount = 0;
			this.groundedStableFrames++;
		} else {
			this.airtime += deltaTime;
			this.groundedStableFrames = 0;
		}

		// ---- Camera "airborne framing" latch (decoupled from the physics grounded
		// flag, which now toggles on every ballistic hop). Only real airs switch the
		// camera framing; short hops stay grounded-framed and the follow-point
		// SmoothDamp absorbs them, so the camera never strobes. ----
		if (!this.grounded) {
			if (this.airtime > this.config.cameraAirEnterSec) {
				this.camAirborne = true;
				this.camAirborneTail = this.config.cameraAirExitTailSec;
			}
		} else if (this.camAirborne) {
			this.camAirborneTail -= deltaTime;
			if (this.camAirborneTail <= 0) this.camAirborne = false;
		}

		// ---- Visual presentation ----
		this.updateVisuals(deltaTime, playerController, keys, speed);
		// Track the jump button once per frame (grounded or air) for the
		// jump-on-release edge detection in updateGrounded.
		this.ascendPrev = keys.ascend;

		// ---- Camera (driven SSX chase cam) ----
		if (this.cameraFollowActive && !this.cameraLockRotation) {
			const cam = playerController.getCameraController();
			if (cam && typeof cam.driveOrbit === 'function') {
				this.cameraDirector.drive(cam, deltaTime, {
					mode: this.camAirborne ? 'airborne' : 'grounded',
					velX: this.horizVelX,
					velZ: this.horizVelZ,
					heading: this.heading,
					slopeAngleDeg: this.slopeAngleDeg,
				});
			} else if (cam && typeof cam.setTargetForwardDirection === 'function') {
				// Legacy fallback: feed the travel direction to auto-follow.
				const camSpeed = Math.hypot(this.horizVelX, this.horizVelZ);
				if (camSpeed > 1.5) {
					const n = this.groundNormal;
					const vy = this.grounded
						? -((n.x * this.horizVelX + n.z * this.horizVelZ) / Math.max(n.y, 0.2))
						: this.verticalVelocity * 0.3;
					this.tmpForward.set(this.horizVelX, vy, this.horizVelZ).normalize();
				} else {
					this.tmpForward.set(Math.sin(this.heading), 0, Math.cos(this.heading));
				}
				cam.setTargetForwardDirection(this.tmpForward);
			}
		}
	}

	/**
	 * Crash bail: hand the player to a tumbling physics body that carries the
	 * pre-impact velocity, bounces off the world for real, and returns control
	 * once it settles. Preferred form is the engine's articulated block-part
	 * ragdoll (flailing limbs); when no block character renderer exists we fall
	 * back to a single dynamic ball. Either way the kinematic player body
	 * follows the tumble every frame, so cameras, HUDs and gameplay systems
	 * keep tracking the player.
	 */
	private startBail(physicsWorld: PhysicsWorld, playerBody: RAPIER.RigidBody, preVx: number, preVz: number): void {
		// Firm camera kick at the moment of the crash (the wipeout cam then
		// loosens and watches the tumble for the duration of the bail).
		this.cameraDirector.registerImpact(0.22);
		// The kinematic capsule's linvel is always zero, so the hub seed is the
		// ONLY motion the ragdoll inherits: pre-impact travel (slightly damped)
		// plus a small upward pop so the body launches over what it hit.
		this.tmpForward.set(preVx * 0.85, Math.max(this.verticalVelocity, 0) + 3, preVz * 0.85);
		if (this.attachedController?.enterTemporaryRagdoll(this.tmpForward)) {
			this.bail = { mode: 'ragdoll', recoverTimer: 0, elapsed: 0 };
		} else {
			const RAPIERMOD = getRapier();
			const t = playerBody.translation();
			// Deterministic-ish tumble spin (no Math.random in engine code).
			this.bailRng = (this.bailRng * 1103515245 + 12345) & 0x7fffffff;
			const spin = ((this.bailRng % 1000) / 1000 - 0.5) * 12;
			const bodyDesc = RAPIERMOD.RigidBodyDesc.dynamic()
				.setTranslation(t.x, t.y, t.z)
				.setLinvel(preVx * 0.85, Math.max(this.verticalVelocity, 0) + 3, preVz * 0.85)
				.setAngvel({ x: spin, y: spin * 0.7, z: -spin })
				.setLinearDamping(0.3)
				.setAngularDamping(0.8)
				.setCcdEnabled(true);
			const body = physicsWorld.createRigidBody(bodyDesc);
			// A zero-length capsule, not a Ball shape: the bail tumbles into
			// voxel rocks at speed, exactly what crashes Rapier's ball-vs-Voxels
			// path (see sphereColliderDesc).
			const colliderDesc = sphereColliderDesc(0.45)
				.setFriction(0.7)
				.setRestitution(this.config.bailRestitution)
				.setCollisionGroups(makeCollisionGroups(
					CollisionGroup.DEBRIS,
					CollisionGroup.TERRAIN | CollisionGroup.ENVIRONMENT,
				));
			physicsWorld.createCollider(colliderDesc, body);
			this.bail = { mode: 'ball', body, recoverTimer: 0, elapsed: 0, physicsWorld };
		}

		this.horizVelX = 0;
		this.horizVelZ = 0;
		this.verticalVelocity = 0;
		this.lastTrick = 'bail';
	}

	private updateBail(deltaTime: number, playerController: SkiMovementHost, playerBody: RAPIER.RigidBody): void {
		const bail = this.bail;
		if (!bail) return;
		bail.elapsed += deltaTime;

		let tumbleX: number, tumbleY: number, tumbleZ: number;
		let speed: number;

		if (bail.mode === 'ragdoll') {
			const state = playerController.getTemporaryRagdollState();
			if (!state) {
				// Ragdoll torn down externally (death respawn, teleport) — drop
				// the bail without moving the body; whoever tore it down placed
				// us. The tumble velocity written by earlier frames must not
				// leak into normal skiing.
				this.bail = null;
				this.horizVelX = 0;
				this.horizVelZ = 0;
				this.verticalVelocity = 0;
				this.spinOffsetDeg = 0;
				this.cameraDirector.reset();
				return;
			}
			tumbleX = state.position.x;
			tumbleY = state.position.y;
			tumbleZ = state.position.z;
			speed = state.speed;
			this.horizVelX = state.velocity.x;
			this.horizVelZ = state.velocity.z;
			// The ragdoll's cloned parts ARE the visuals (live root is hidden), so
			// only the root position tags along — don't touch its pose.
			if (playerController.player) {
				playerController.player.position.set(tumbleX, tumbleY - 0.9, tumbleZ);
			}
		} else {
			const t = bail.body.translation();
			const v = bail.body.linvel();
			const rot = bail.body.rotation();
			tumbleX = t.x;
			tumbleY = t.y;
			tumbleZ = t.z;
			speed = Math.hypot(v.x, v.y, v.z);
			this.horizVelX = v.x;
			this.horizVelZ = v.z;

			// Visual root tags along (feet at the ball bottom).
			if (playerController.player) {
				playerController.player.position.set(t.x, t.y - 0.45, t.z);
				playerController.player.quaternion.set(rot.x, rot.y, rot.z, rot.w);
			}
		}

		// Kinematic body follows the tumble either way, so cameras, HUDs and
		// gameplay systems keep tracking the player.
		playerBody.setNextKinematicTranslation({ x: tumbleX, y: tumbleY, z: tumbleZ });
		this.pendingFrom = null;
		this.pendingTarget = null;

		// Keep the chase cam on the tumble (speed readouts stay live too). Wipeout
		// mode loosens the follow: the yaw freezes and the camera watches the body
		// drift past instead of snapping behind its travel.
		if (this.cameraFollowActive && !this.cameraLockRotation) {
			const cam = playerController.getCameraController();
			if (cam && typeof cam.driveOrbit === 'function') {
				this.cameraDirector.drive(cam, deltaTime, {
					mode: 'wipeout',
					velX: this.horizVelX,
					velZ: this.horizVelZ,
					heading: this.heading,
					slopeAngleDeg: this.slopeAngleDeg,
				});
			}
		}

		// Recover when settled (or after the hard cap).
		bail.recoverTimer = speed < this.config.bailRecoverySpeed ? bail.recoverTimer + deltaTime : 0;
		if (bail.recoverTimer >= this.config.bailRecoveryDelaySec || bail.elapsed >= this.config.bailMaxDurationSec) {
			this.endBail(playerController, playerBody);
		}
	}

	private endBail(playerController: SkiMovementHost, playerBody: RAPIER.RigidBody): void {
		const bail = this.bail;
		if (!bail) return;
		this.bail = null;

		// Stand the player up where the tumble ended; the next update's
		// ground ray and KCC settle the exact contact.
		const capsuleHalf = capsuleHalfExtent(firstCollider(playerBody));

		if (bail.mode === 'ragdoll') {
			// exitTemporaryRagdoll restores the live character + capsule and
			// returns the hub (torso) rest position. The hub often settles
			// AGAINST the obstacle that caused the crash, so don't trust it as
			// a capsule position directly — raycast for the surface under it
			// and stand on that. Hits above the hub are canopy/overhangs from
			// the obstacle itself; fall back to hub + capsuleHalf (inside the
			// KCC's 0.5 m snap-down range for a body lying on open ground).
			const rest = playerController.exitTemporaryRagdoll();
			const t = playerBody.translation();
			const x = rest?.x ?? t.x;
			const z = rest?.z ?? t.z;
			let y = (rest?.y ?? t.y) + capsuleHalf;
			const physicsWorld = playerController.physicsWorld;
			if (rest && physicsWorld) {
				this.tmpRayOrigin.set(x, rest.y + 2, z);
				const ray = physicsWorld.raycast(this.tmpRayOrigin, this.tmpRayDir, 30, CollisionMask.GROUND_CHECK);
				if (ray.hasHit && ray.hitPoint.y <= rest.y + 0.5) {
					y = ray.hitPoint.y + capsuleHalf + 0.05;
				}
			}
			playerBody.setNextKinematicTranslation({ x, y, z });
		} else {
			const t = bail.body.translation();
			bail.physicsWorld.removeRigidBody(bail.body);
			playerBody.setNextKinematicTranslation({ x: t.x, y: t.y - 0.45 + capsuleHalf + 0.05, z: t.z });
		}
		this.pendingFrom = null;
		this.pendingTarget = null;

		this.horizVelX = 0;
		this.horizVelZ = 0;
		this.verticalVelocity = 0;
		this.spinOffsetDeg = 0;
		this.jumpCount = 0;
		this.airtime = 0;
		// The stand-up frames may still depenetrate from the crash obstacle —
		// keep the obstacle feedback from banking that push as velocity.
		this.feedbackGraceSec = 0.35;
		if (playerController.player) {
			playerController.player.rotation.set(0, this.heading, 0);
		}
		// Re-pin the snowboard head down the hill the instant we recover, so the
		// restored character never shows the ragdoll's last (often uphill) head
		// orientation in the frame before updateVisuals runs again.
		if (this.config.equipmentStyle === 'snowboard') {
			playerController.playerLoader?.getBlockCharacterRenderer?.()?.setHeadWorldYaw?.(this.heading + Math.PI);
		}
		this.cameraDirector.reset(); // hard cut behind the recovered skier
	}

	/**
	 * Multi-point ground probe under the ski footprint. A single centre ray
	 * reads "air" when the body straddles a ledge — trapping the player off the
	 * grounded branch (no skate-push, no jump). Sampling the front and back of
	 * the skis as well means a ledge under one point still grounds the skier.
	 * Returns the nearest foot-to-ground distance and whether any point is in
	 * contact; the caller also uses minFeetDistance for coyote skate/jump.
	 */
	private probeFeet(
		t0: { x: number; y: number; z: number },
		capsuleHalf: number,
		centerRay: RaycastResult,
		physicsWorld: PhysicsWorld,
	): { anyContact: boolean; minFeetDistance: number } {
		const reach = this.config.footProbeReach;
		const fx = Math.sin(this.heading) * reach;
		const fz = Math.cos(this.heading) * reach;
		const range = capsuleHalf + Math.max(0.5, this.config.coyoteGroundDistance);
		let minFeet = centerRay.hasHit ? centerRay.hitDistance - capsuleHalf : Infinity;
		this.tmpProbe.set(t0.x + fx, t0.y, t0.z + fz);
		const front = physicsWorld.raycast(this.tmpProbe, this.tmpRayDir, range, CollisionMask.GROUND_CHECK);
		if (front.hasHit) minFeet = Math.min(minFeet, front.hitDistance - capsuleHalf);
		this.tmpProbe.set(t0.x - fx, t0.y, t0.z - fz);
		const back = physicsWorld.raycast(this.tmpProbe, this.tmpRayDir, range, CollisionMask.GROUND_CHECK);
		if (back.hasHit) minFeet = Math.min(minFeet, back.hitDistance - capsuleHalf);
		return { anyContact: minFeet < 0.12, minFeetDistance: minFeet };
	}

	private updateGrounded(
		deltaTime: number,
		keys: { forward: boolean; backward: boolean; left: boolean; right: boolean; ascend: boolean },
		speed: number,
		fric: { drag: number; grip: number },
	): void {
		const cfg = this.config;

		// Steering: positive yaw turns left (gameplay convention). Ramp the turn
		// rate up the longer the key is held — a tap barely turns, a sustained hold
		// builds to the full (sharp) rate; reversing restarts the ramp.
		const turnInput = (keys.left ? 1 : 0) + (keys.right ? -1 : 0);
		if (turnInput !== 0) {
			if (turnInput !== this.lastTurnDir) this.turnHeldSec = 0;
			this.turnHeldSec += deltaTime;
			const ramp = cfg.turnTapFactor + (1 - cfg.turnTapFactor) * Math.min(1, this.turnHeldSec / cfg.turnRampSec);
			this.heading += turnInput * turnRateDegFor(speed, cfg) * ramp * DEG2RAD * deltaTime;
			this.lastTurnDir = turnInput;
		} else {
			this.turnHeldSec = 0;
			this.lastTurnDir = 0;
		}

		// Slope acceleration.
		downhillAcceleration(this.groundNormal, cfg.gravity, cfg.slopeAccelFactor, this.tmpAccel);
		this.horizVelX += this.tmpAccel.x * deltaTime;
		this.horizVelZ += this.tmpAccel.z * deltaTime;

		// Skate push (low speed) / tuck (at speed). Tuck thins drag below AND adds
		// a small forward kick here; the visual crouch pose follows in updateVisuals.
		const tucking = keys.forward && speed >= cfg.skatePushMaxSpeed;
		this.tucking = tucking;
		if (keys.forward) {
			const pushAccel = tucking ? cfg.tuckPushAccel : cfg.skatePushAccel;
			this.horizVelX += Math.sin(this.heading) * pushAccel * deltaTime;
			this.horizVelZ += Math.cos(this.heading) * pushAccel * deltaTime;
		}

		// Brake.
		if (keys.backward && speed > 0.01) {
			const newSpeed = Math.max(0, speed - cfg.brakeDecel * deltaTime);
			const s = speed > 0 ? newSpeed / speed : 0;
			this.horizVelX *= s;
			this.horizVelZ *= s;
		}

		// Carve grip: redirect momentum into the heading. Speed-scaled so fast
		// carves loosen and drift instead of railing; braking still firms grip.
		const baseGrip = gripRateFor(speed, {
			gripRateLow: cfg.gripRateLow, gripRateHigh: cfg.gripRateHigh, maxSpeed: cfg.maxSpeed,
		});
		const grip = (keys.backward ? cfg.brakeGripRate : baseGrip) * fric.grip;
		const carved = carveVelocity(
			this.horizVelX, this.horizVelZ, this.heading, grip, cfg.carveSpeedBleed, deltaTime, cfg.carveSkidBleed,
		);
		this.horizVelX = carved.x;
		this.horizVelZ = carved.z;

		// Speed limiter is DRAG, not a cap: air (quadratic) + snow (linear).
		// Each slope has its own terminal speed where slope-gravity balances
		// drag, so steepness sets how fast you ride. Tuck thins both drags
		// (faster); terrain friction modulates the snow term only (ice fast,
		// grass slow) — air resistance is terrain-independent.
		const tuckScale = tucking ? cfg.tuckDragScale : 1;
		const airK = cfg.airDragK * tuckScale;
		const snowK = cfg.snowDragK * tuckScale * fric.drag;
		const dragged = applyDrag(this.horizVelX, this.horizVelZ, airK, snowK, deltaTime);
		this.horizVelX = dragged.x;
		this.horizVelZ = dragged.z;
		// Safety clamp only (guards a bug, never the everyday feel limiter).
		const sp = Math.hypot(this.horizVelX, this.horizVelZ);
		if (sp > cfg.maxSpeedClamp) {
			const s = cfg.maxSpeedClamp / sp;
			this.horizVelX *= s;
			this.horizVelZ *= s;
		}

		// Grounded: vertical handled by KCC snap-to-ground (no forced push).
		this.verticalVelocity = 0;

		// Charge jump: holding ascend winds up a deeper crouch (see updateVisuals)
		// and the jump fires on RELEASE. canJump gates one jump per press/landing;
		// ascendPrev is updated once per frame in update() for the edge detection.
		const armedToJump = this.canJump && this.jumpCount < 1;
		this.jumpCharging = keys.ascend && armedToJump;
		if (this.ascendPrev && !keys.ascend && armedToJump) {
			this.verticalVelocity = cfg.jumpSpeed;
			this.jumpCount++;
			this.canJump = false;
		}
		if (!keys.ascend) this.canJump = true;
	}

	private updateAirborne(
		deltaTime: number,
		keys: { forward: boolean; backward: boolean; left: boolean; right: boolean; action: boolean },
		ray: RaycastResult,
		capsuleHalf: number,
	): void {
		const cfg = this.config;

		// Gravity + terminal velocity.
		this.verticalVelocity -= cfg.gravity * deltaTime;
		if (this.verticalVelocity < -cfg.terminalVelocity) {
			this.verticalVelocity = -cfg.terminalVelocity;
		}

		// Tiny horizontal air drag.
		const keep = Math.exp(-cfg.airDrag * deltaTime);
		this.horizVelX *= keep;
		this.horizVelZ *= keep;

		// Landing-assist window: feet close enough to touch within the
		// configured time at the current fall speed. The ray hit distance is
		// measured from the body CENTER, so subtract the capsule half-height to
		// get the distance from the FEET.
		const fallSpeed = Math.max(0.1, -this.verticalVelocity);
		const feetDistance = ray.hasHit ? Math.max(0, ray.hitDistance - capsuleHalf) : Infinity;
		const groundClose = feetDistance < fallSpeed * cfg.landingAssistTime + 0.2;

		const steerInput = (keys.left ? 1 : 0) + (keys.right ? -1 : 0);
		if (keys.action && steerInput !== 0 && !groundClose) {
			// Trick spin (visual rotation only).
			this.spinOffsetDeg += steerInput * cfg.spinRateDeg * deltaTime;
			if (Math.abs(this.spinOffsetDeg) > 90) this.lastTrick = 'spin';
		} else if (steerInput !== 0) {
			// Gentle air steering of the actual heading.
			this.heading += steerInput * cfg.airSteerRateDeg * DEG2RAD * deltaTime;
		}

		// Front flip: action+forward, once per air, via the CORE Mixamo clip.
		if (keys.action && keys.forward && !this.flipUsedThisAir && !groundClose) {
			this.flipUsedThisAir = true;
			this.lastTrick = 'flip';
			const result = this.attachedController?.animationController?.playCustomAnimation?.(
				'mForwardFlip01',
				{ fadeInDuration: 0.1, fadeOutDuration: 0.15, speed: 1.6, filterRootMotion: true },
			);
			this.flipRemaining = result && result.success ? result.duration / 1.6 : 0;
		}
		if (this.flipRemaining > 0) this.flipRemaining -= deltaTime;

		// Landing assist: damp spin toward the nearest full rotation.
		if (groundClose && this.spinOffsetDeg !== 0) {
			const rest = nearestSpinRest(this.spinOffsetDeg);
			const k = 1 - Math.exp(-12 * deltaTime);
			this.spinOffsetDeg += (rest - this.spinOffsetDeg) * k;
		}
	}

	private onTakeoff(): void {
		this.flipUsedThisAir = false;
		this.lastTrick = null;
	}

	private onLanded(): void {
		// Bad landing: meaningful residual spin or a flip still in progress.
		const spinErr = landingSpinErrorDeg(this.spinOffsetDeg);
		if (spinErr > this.config.badLandingAngleDeg || this.flipRemaining > 0.15) {
			this.horizVelX *= this.config.badLandingSpeedKeep;
			this.horizVelZ *= this.config.badLandingSpeedKeep;
		}
		this.spinOffsetDeg = 0;
		this.flipRemaining = 0;
	}

	/**
	 * Snowboard crouch as local bone-rotation offsets (body-part keyed), applied
	 * over the idle pose by the animation controller. A squat: thighs swing
	 * forward, shins fold back at the knees. Tuned by kneeBendDeg; axes/signs are
	 * dialled by eye against the Mixamo leg-bone frame.
	 */
	private refreshStanceOffsets(): void {
		// Legs are planted by foot IK — only the upper body is posed here, as two
		// local-frame torso rotations mutated in place each frame:
		//  - WIND (local-Y twist): turn the spine toward the fall line. (The chest's
		//    front/back facing is a character-gen issue — the block body faces the
		//    wrong way — so don't flip it here; that swings the arms too.)
		//  - CROUCH (local-Z pitch): bend the back forward as the hips sink, scaled
		//    by how deep the current hip-sink is (crouchDrop / jumpChargeDrop).
		const stanceSign = this.config.stance === 'goofy' ? -1 : 1;
		const wind = -stanceSign * this.config.torsoWindDeg * DEG2RAD;
		const crouchFrac = this.config.jumpChargeDrop > 0 ? this.crouchDrop / this.config.jumpChargeDrop : 0;
		const pitch = crouchFrac * this.config.crouchTorsoPitchDeg * DEG2RAD;
		this.tmpQStanceA.setFromAxisAngle(UP, wind);
		this.tmpQStanceB.setFromAxisAngle(STANCE_PITCH_AXIS, pitch);
		this.torsoOffsetQ.copy(this.tmpQStanceA).multiply(this.tmpQStanceB);
	}

	private updateVisuals(
		deltaTime: number,
		playerController: SkiMovementHost,
		keys: { left: boolean; right: boolean; action: boolean },
		speed: number,
	): void {
		const player = playerController.player;
		if (!player) return;
		const cfg = this.config;

		// Carve lean (roll) — lean INTO the turn, like a real skier/boarder
		// edging toward the turn centre. turnInput is +1 left / -1 right, and a
		// left turn curves the body toward its own left (+X world at heading 0).
		// Under the engine's forward=+Z, right=forward×up convention a POSITIVE
		// rotation.z tilts the body the OTHER way (toward −X), so it must be
		// NEGATED to lean inside — without the minus the rider banked outward.
		const turnInput = (keys.left ? 1 : 0) + (keys.right ? -1 : 0);
		const carving = this.grounded && (!keys.action) ? turnInput : 0;
		const targetRoll = -carving * cfg.carveLeanMaxDeg * DEG2RAD * Math.min(1, speed / 10);

		// Pitch INTO the descent (nose down going downhill, like a real rider
		// driving forward). The runtime ground normal leans DOWNHILL — toward
		// the travel direction — which is the same convention groundFollowDy
		// relies on (n·v > 0 when descending). So the forward-lean term is
		// +(n·heading)/n.y; the earlier minus pitched the rider nose-UP, making
		// them lean BACK on every slope (worse the steeper/faster it got).
		const hx = Math.sin(this.heading), hz = Math.cos(this.heading);
		const n = this.groundNormal;
		const slopeAhead = n.y > 0.05 ? (n.x * hx + n.z * hz) / n.y : 0;
		const targetPitch = this.grounded ? Math.atan(slopeAhead) * 0.6 : 0;

		const k = 1 - Math.exp(-10 * deltaTime);
		this.visualRoll += (targetRoll - this.visualRoll) * k;
		this.visualPitch += (targetPitch - this.visualPitch) * k;

		// Snowboard stance: the rider stands SIDEWAYS across the board, so the
		// body yaws ~90 deg off the travel heading (regular = lead left, goofy =
		// lead right). Skis ride straight, body facing travel.
		const stanceSign = cfg.stance === 'goofy' ? -1 : 1;
		const stanceYaw = cfg.equipmentStyle === 'snowboard'
			? stanceSign * cfg.boardYawDeg * DEG2RAD
			: 0;
		const spin = this.spinOffsetDeg * DEG2RAD;

		// Crouch pose: ease the hip-sink (metres) toward the active depth — deeper
		// while charging a jump, shallower for a plain tuck, 0 in the air. Drives the
		// forward torso bend (now) and the hip-sink (in the foot-IK block below).
		const dropTarget = this.grounded
			? (this.jumpCharging ? cfg.jumpChargeDrop : this.tucking ? cfg.crouchDropMax : 0)
			: 0;
		this.crouchDrop += (dropTarget - this.crouchDrop) * (1 - Math.exp(-deltaTime / cfg.crouchRampSec));
		if (cfg.equipmentStyle === 'snowboard') this.refreshStanceOffsets();

		// Carve lean and slope pitch are applied around WORLD axes — lean around
		// the travel heading (rolls a board onto its toe/heel edge; rolls a skier
		// into the turn), pitch around the cross axis (nose down the hill). World
		// axes keep both correct however the body is yawed: a sideways
		// snowboarder leans fore/aft onto an edge, not side to side.
		this.tmpAxisH.set(Math.sin(this.heading), 0, Math.cos(this.heading));
		this.tmpAxisR.set(Math.cos(this.heading), 0, -Math.sin(this.heading));
		this.tmpQLean.setFromAxisAngle(this.tmpAxisH, this.visualRoll);
		this.tmpQPitch.setFromAxisAngle(this.tmpAxisR, this.visualPitch);
		this.tmpQTilt.copy(this.tmpQPitch).multiply(this.tmpQLean);

		// Body = tilt * yaw(heading + stance). tilt is world-frame (premultiply),
		// so it bends the already-yawed body around the travel axes.
		this.tmpQYaw.setFromAxisAngle(UP, this.heading + stanceYaw + spin);
		player.quaternion.copy(this.tmpQTilt).multiply(this.tmpQYaw);

		// Board/skis anchor to the ACTUAL feet: yaw from the line between the two
		// foot bones so the board lies along the stance (both feet ON it), and
		// ride at the soles (player-root Y, current — so they stay glued through
		// jumps with no lag, the bug from anchoring to the ground). Tilt edges
		// them with the carve.
		const renderer = playerController.playerLoader?.getBlockCharacterRenderer?.();
		// Board deck Y under the soles. Snowboard deck tracks the IK foot soles (so
		// it can't float off the feet); skis keep the fixed sole drop. Computed
		// every frame (even with equipment hidden) so snow spray spawns exactly at
		// the board — its XZ is the player root XZ.
		const deckY = this.config.equipmentStyle === 'snowboard'
			? player.position.y - BOARD_SOLE_DROP + SNOWBOARD_ANKLE_LIFT - SNOWBOARD_DECK_BELOW_ANKLE
			: player.position.y - BOARD_SOLE_DROP;
		this.boardContactY = deckY;
		if (this.config.showEquipment) {
			// Board points straight down the hill (travel heading), NOT along the
			// feet line — the rider stands across it, but the board tracks travel.
			this.tmpQYaw.setFromAxisAngle(UP, this.heading + spin);
			this.tmpQBoard.copy(this.tmpQTilt).multiply(this.tmpQYaw);
			this.tmpBoardPos.set(player.position.x, deckY, player.position.z);
			this.equipment.syncTransform(playerController, this.tmpBoardPos, this.tmpQBoard);
		}

		// A snowboarder looks down the hill: pin the head yaw to the heading,
		// independent of the wound torso. Skis keep the head following the torso.
		if (renderer?.setHeadWorldYaw) {
			// + PI cancels the renderer's built-in 180 head flip so the head looks
			// DOWN the hill (heading), not up it.
			renderer.setHeadWorldYaw(this.config.equipmentStyle === 'snowboard' ? this.heading + spin + Math.PI : null);
		}

		// Foot IK: bolt the ankles to the board (knees solve to reach them) so
		// the feet stay ON it however the body twists. Bindings spread along the
		// board's length (travel heading); feet lie along the board (tmpQBoard).
		// The body is sideways, so feet and legs don't fully agree — known limit.
		const ac = playerController.animationController;
		if (ac?.setFootIkTargets) {
			if (this.config.equipmentStyle === 'snowboard') {
				const fwdX = Math.sin(this.heading), fwdZ = Math.cos(this.heading);
				const bindHalf = 0.28, ankleLift = SNOWBOARD_ANKLE_LIFT;
				const by = player.position.y - BOARD_SOLE_DROP + ankleLift;
				// Left foot = back (tail-side) binding, right foot = front (nose-side);
				// the back foot sits a few cm further toward the tail.
				const leftBind = bindHalf + 0.05;
				this.footIkTargets.left.position.set(player.position.x - leftBind * fwdX, by, player.position.z - leftBind * fwdZ);
				this.footIkTargets.right.position.set(player.position.x + bindHalf * fwdX, by, player.position.z + bindHalf * fwdZ);
				this.footIkTargets.left.quaternion.copy(this.tmpQBoard);
				this.footIkTargets.right.quaternion.copy(this.tmpQBoard);
				this.footIkTargets.facing.setFromAxisAngle(UP, this.heading + stanceYaw + spin);
				ac.setFootIkTargets(this.footIkTargets);
				// Crouch: sink the hips (root) below the snow-anchored feet/board so
				// the foot IK bends the knees to take up the drop.
				player.position.y -= this.crouchDrop;
			} else {
				ac.setFootIkTargets(null);
			}
		}
	}

	getCurrentSpeed(): number {
		return Math.hypot(this.horizVelX, this.horizVelZ);
	}

	isInAir(): boolean {
		return !this.grounded;
	}

	wasGroundedLastUpdate(): boolean {
		return this.grounded;
	}

	getRotation(): number {
		return this.heading;
	}

	reset(): void {
		this.cleanupBail();
		this.horizVelX = 0;
		this.horizVelZ = 0;
		this.verticalVelocity = 0;
		this.actualVy = 0;
		this.spinOffsetDeg = 0;
		this.flipRemaining = 0;
		this.flipUsedThisAir = false;
		this.lastTrick = null;
		this.airtime = 0;
		this.camAirborne = false;
		this.camAirborneTail = 0;
		this.feedbackGraceSec = 0;
		this.pendingFrom = null;
		this.pendingTarget = null;
	}

	/** Tear down an active bail without recovery placement (resets, detach). */
	private cleanupBail(): void {
		if (!this.bail) return;
		if (this.bail.mode === 'ball') {
			this.bail.physicsWorld.removeRigidBody(this.bail.body);
		} else {
			this.attachedController?.exitTemporaryRagdoll();
		}
		this.bail = null;
	}

	getAscendDisplayName(): string {
		return 'Jump';
	}

	getDescendDisplayName(): string {
		return 'Brake';
	}

	getSupportedKeys(): { ascend: boolean; descend: boolean } {
		return { ascend: true, descend: false };
	}

	getKeyBehavior(): { ascend: 'tap' | 'continuous'; descend: 'tap' | 'continuous' } {
		// ascend is now hold-to-charge (crouch wind-up) + jump on release, so it
		// must be delivered continuously while held, not edge-triggered.
		return { ascend: 'continuous', descend: 'continuous' };
	}

	handlesPlayerPositionSync(): boolean {
		// Ski owns the full player transform: position from the body, plus
		// pitch/roll lean and trick-spin yaw that the template's
		// syncPlayerPhysics (position + heading-only yaw) would drop.
		return true;
	}

	shouldShowPlayer(): boolean {
		return true;
	}

	shouldPlayLocomotionAnimation(): boolean {
		return false;
	}

	controlsBodyRotation(): boolean {
		// updateVisuals writes the full body quaternion (heading + sideways stance
		// + carve lean/pitch). An orchestrating NpcController must not overwrite it
		// with a yaw-only getRotation().
		return true;
	}

	getJumpCount(): number {
		return this.jumpCount;
	}

	setGroundFriction(friction: number): void {
		this.terrainFriction = friction;
	}

	/** Ski always applies gravity — the voxel-floor safety net may engage. */
	isGravityEnabled(): boolean {
		return true;
	}

	/** Called by the floor safety net after snapping the player up. */
	resetVerticalVelocity(): void {
		this.verticalVelocity = 0;
		this.actualVy = 0;
	}

	setCameraLockRotation(enabled: boolean): void {
		this.cameraLockRotation = enabled;
		// Ranged-weapon aiming needs the mouse: hand the orbit back while
		// locked, reclaim it (with a snap behind the skier) on unlock.
		const cam = this.attachedController?.getCameraController();
		if (cam && typeof cam.setExternalOrbitDrive === 'function' && this.cameraFollowActive) {
			cam.setExternalOrbitDrive(!enabled);
			if (!enabled) this.cameraDirector.reset();
		}
	}

	setCameraController(camera: { getHorizontalAngle: () => number } | null): void {
		this.lockCameraController = camera;
	}

	getMoveSpeed(): number {
		return this.config.maxSpeed;
	}

	setMoveSpeed(speed: number): void {
		const ratio = DEFAULT_SKI_CONFIG.tuckMaxSpeed / DEFAULT_SKI_CONFIG.maxSpeed;
		this.config.maxSpeed = speed;
		this.config.tuckMaxSpeed = speed * ratio;
	}

	// Ski-specific API (game code / agent)

	/** Current ski state for HUDs, timers, and scoring (poll per frame). */
	getSkiState(): SkiState {
		const sp = this.getCurrentSpeed();
		// Skid = sin of the angle between momentum and board forward (the same
		// value the carve uses to scrub speed): 0 carving, 1 fully sideways.
		const bx = Math.sin(this.heading), bz = Math.cos(this.heading);
		const skid = sp > 1e-6
			? Math.min(1, Math.abs((this.horizVelX / sp) * bz - (this.horizVelZ / sp) * bx))
			: 0;
		return {
			speed: sp,
			heading: this.heading,
			velocity: new THREE.Vector3(this.horizVelX, this.verticalVelocity, this.horizVelZ),
			skid,
			grounded: this.grounded,
			boardContactY: this.boardContactY,
			airtimeSeconds: this.airtime,
			slopeAngleDeg: this.slopeAngleDeg,
			lastTrick: this.lastTrick,
			bailing: this.bail !== null,
		};
	}

	/**
	 * Teleport for race resets: places the capsule so the feet touch the
	 * surface under `position` (snapped via raycast), zeroes velocity, and
	 * optionally sets the heading yaw.
	 */
	teleport(position: THREE.Vector3, yaw?: number): void {
		const body = this.attachedController?.playerBody ?? this.lastBody;
		const physicsWorld = this.attachedController?.physicsWorld ?? this.lastPhysicsWorld;
		if (!body || !physicsWorld) return;

		const capsuleHalf = capsuleHalfExtent(firstCollider(body));

		this.tmpRayOrigin.set(position.x, position.y + 5, position.z);
		const ray = physicsWorld.raycast(
			this.tmpRayOrigin,
			this.tmpRayDir,
			60,
			CollisionMask.GROUND_CHECK,
		);
		const y = ray.hasHit
			? ray.hitPoint.y + capsuleHalf + 0.05
			: position.y + capsuleHalf + 0.05;

		body.setTranslation({ x: position.x, y, z: position.z }, true);
		this.reset();
		if (yaw !== undefined) this.heading = yaw;
		// Hard-cut the chase cam behind the (possibly new) heading — a race
		// reset must never start with the camera mid-swing.
		this.cameraDirector.reset();
	}

	/**
	 * Merge new config values at runtime (validating, like the constructor).
	 * Note: equipment geometry/colors are built once at attach time, so changing
	 * skiColor/skiLength etc. here does not restyle already-attached equipment.
	 */
	updateConfig(partial: Partial<SkiConfig> | Record<string, unknown>): void {
		// Preserve this.config's object identity — SkiEquipment holds the same
		// reference, so replacing the object would let the two diverge.
		const merged = mergeSkiConfig({ ...this.config, ...(partial as Partial<SkiConfig>) });
		Object.assign(this.config, merged);
	}
}
