import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { IPlayerMovement } from 'engine/IPlayerMovement.js';
import type { PlayerController } from 'engine/PlayerController.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import { CollisionGroup } from 'engine/CollisionLayers.js';
import { QUERY_EXCLUDE_SENSORS } from 'engine/physics/QueryFilter.js';
import { movesAwayFrom } from 'engine/physics/TrappedBodies.js';

/** A position the depenetration net reads or produces. */
export interface DepenPos { x: number; y: number; z: number }

/** Max distance back to a remembered free position for the revert to apply (m). */
export const DEPEN_REVERT_DIST = 1.5;
/** Total upward float allowed per embedded episode, when no revert is available (m). */
export const DEPEN_MAX_RISE = 1.5;
/** Per-frame cap on the upward float (m). */
export const DEPEN_FRAME_RISE = 0.12;

/**
 * Decide where a capsule that ended up INSIDE static geometry should go.
 *
 * The collide-and-slide never embeds a capsule itself, so the cause is always an
 * outside writer (a teleport into a wall, a legacy game's manual mover) or a
 * tunnelling frame. Two rescues, in preference order:
 *
 * 1. Put it BACK where it last stood clear, when that spot is near and still clear.
 *    That position is legal by construction, and it makes "embedded in an object"
 *    behave like walking into a wall.
 * 2. Otherwise float it upward, bounded per frame AND in total.
 *
 * Floating alone is not enough: unbounded, it climbs for as long as the capsule
 * overlaps ANYTHING, which turned walking into a tree into a 4.4 m ride up the trunk
 * that parked the player on top of the canopy. Capping the climb doesn't fix that on
 * its own either — a capsule embedded partway up a 2 m canopy still pops out the top.
 *
 * @param target - The embedded position this frame.
 * @param lastFree - Last position known clear of static geometry, or null.
 * @param lastFreeStillClear - Whether `lastFree` is STILL clear. Re-queried by the
 *   caller because the world may have changed under the capsule instead: a block
 *   placed at the player's feet makes the remembered spot solid too, and pinning them
 *   there would bury them permanently — that case needs the float.
 * @param riseUsed - Metres already floated during this embedded episode.
 * @param deltaTime - Frame time, for the rate cap.
 */
export function resolveDepenetration(
	target: Readonly<DepenPos>,
	lastFree: Readonly<DepenPos> | null,
	lastFreeStillClear: boolean,
	riseUsed: number,
	deltaTime: number,
): { pos: DepenPos; riseUsed: number; moved: boolean } {
	if (lastFree && lastFreeStillClear) {
		const dist = Math.hypot(target.x - lastFree.x, target.y - lastFree.y, target.z - lastFree.z);
		if (dist <= DEPEN_REVERT_DIST) {
			return { pos: { x: lastFree.x, y: lastFree.y, z: lastFree.z }, riseUsed, moved: true };
		}
	}
	const lift = Math.min(DEPEN_FRAME_RISE, 8 * deltaTime, Math.max(0, DEPEN_MAX_RISE - riseUsed));
	return {
		pos: { x: target.x, y: target.y + lift, z: target.z },
		riseUsed: riseUsed + lift,
		moved: lift > 0,
	};
}

/**
 * Default walking and jumping movement implementation
 * Handles ground movement, jumping, air control, and friction
 */
/** Tallest AUTHORED curb a character mounts (m) — see WalkingAndJumpingMovement.stepLimit. */
export const AUTHORED_STEP_HEIGHT_M = 0.65;
/** Ceiling on the world-derived step height (m); above it the player jumps instead. */
export const MAX_WORLD_STEP_HEIGHT_M = 1.25;
/** Quantization margin, so a block measured a hair over its nominal size still mounts. */
const STEP_HEIGHT_MARGIN_M = 0.05;

/**
 * The tallest step a character mounts in a world whose blocks are `voxelBlockSize`
 * metres, or the authored default when the world has no block size (every
 * non-block world — its profile carries no such field).
 *
 * A block world's ledges ARE its blocks, so a limit below the block size means
 * the player walks into every ledge the world is built from and can only jump
 * onto them. Bounded above so an unusually large block reads as a wall to jump,
 * not a step to levitate up.
 */
export function stepHeightForWorld(voxelBlockSize: number | undefined): number {
	const usable = typeof voxelBlockSize === 'number' && Number.isFinite(voxelBlockSize) && voxelBlockSize > 0;
	if (!usable) return AUTHORED_STEP_HEIGHT_M;
	return Math.max(
		AUTHORED_STEP_HEIGHT_M,
		Math.min(voxelBlockSize + STEP_HEIGHT_MARGIN_M, MAX_WORLD_STEP_HEIGHT_M),
	);
}

export class WalkingAndJumpingMovement implements IPlayerMovement {
	private moveSpeed: number;
	private rotation: number;
	private verticalVelocity: number;
	private jumpHorizontalVelocity: THREE.Vector2;
	private canJump: boolean;
	private maxJumps: number;
	private jumpCount: number;
	private physicsConfig: {
		gravity: number;
		terminalVelocity: number;
		jumpHeight: number;
		airControlMultiplier: number;
		groundFriction: number;
		airFriction: number;
	};
	/**
	 * Below this ground speed, a character with no movement input is snapped to a
	 * dead stop rather than left to friction's asymptotic tail.
	 *
	 * Deliberately just under PlayerController.LOCOMOTION_STOP_SPEED (0.4), which
	 * is where the walk/run animation gives way to idle — so the snap only ever
	 * removes motion the legs had already stopped portraying.
	 */
	private static readonly STOP_SNAP_SPEED = 0.35;

	private currentSpeed: number;
	private acceleration: number; // m/s² — how fast the player ramps to moveSpeed

	// KCC motor state. A kinematicPositionBased body has no linvel to read back,
	// so the motor tracks its own horizontal velocity. Gravity can be gated until
	// terrain is ready (the kinematic equivalent of the old gravityScale=0 trick).
	private horizVelX: number = 0;
	private horizVelZ: number = 0;
	private gravityEnabled: boolean = true;
	// Kinematic target tracking. The body is kinematicPositionBased and is moved
	// with setNextKinematicTranslation, which applies the controller's
	// collision-clamped movement EXACTLY (it can never overshoot the surface).
	// The motor runs once per render frame but physics steps at a fixed 60 Hz, so
	// on a frame where no substep ran the body translation is unchanged;
	// recomputing the target from it would discard the previously queued move (at
	// 120 Hz that halves the speed). pendingTarget accumulates instead.
	private pendingFrom: THREE.Vector3 | null = null;
	private pendingTarget: THREE.Vector3 | null = null;
	/** See getRenderPosition(). */
	private renderPosition: THREE.Vector3 | null = null;

	/**
	 * The collision-clamped kinematic target integrated per RENDER frame. The
	 * body itself only advances on fixed 60Hz physics substeps, so a visual
	 * synced from `body.translation()` stalls on 0-substep frames and
	 * double-jumps after catch-up frames — motion judder at a steady 60 fps.
	 * PlayerController syncs the visual from this instead (with a sanity clamp
	 * against the body position for teleports while movement is idle).
	 */
	getRenderPosition(): THREE.Vector3 | null {
		return this.renderPosition;
	}
	// Reused buffer for external per-frame displacement (committed animation root
	// motion etc.) drained from the controller and added to the desired motion.
	private readonly _externalDisplacement = new THREE.Vector3();
	/** Collider handles overlapping the capsule this frame — excluded from the solve (see the KCC block). */
	private readonly _trappedBy = new Set<number>();
	/** Last frame's solve moved far less than asked — the trigger for the overlap query. */
	private blockedLastFrame = false;


	// Moving-platform rider carry. When the character stands on a KINEMATIC body
	// (KinematicPlatform or any custom setNextKinematic* mover), the platform's
	// per-frame pose delta is replayed onto the rider: position sweeps with the
	// surface (including the tangential sweep of a rotation about Y) and facing
	// turns by the same yaw delta. The carry rides through the same collide-and-
	// slide solve as input motion, so walking, jumping and wall collisions keep
	// working while carried — game code must NEVER teleport the rider itself.
	private carryBody: RAPIER.RigidBody | null = null;
	// Previous QUEUED pose of the carry body (nextTranslation/nextRotation, not
	// the substep-quantized body pose — see the carry section in update()).
	private readonly carryBodyPrevPos = new THREE.Vector3();
	private carryBodyPrevYaw = 0;
	private carryVelX = 0;   // last frame's carry velocity — inherited on jump
	private carryVelZ = 0;
	// Horizontal speed relative to the supporting ground (world motion minus the
	// platform carry), for animation — see getGroundRelativeSpeed().
	private groundRelSpeed = 0;

	// Steep-stance: standing on ground steeper than the climb limit. Voxel worlds
	// turn every slope into a staircase of sub-step ledges, so autostep + jump-spam
	// could climb ANY face regardless of the controller's slope limit — bypassing
	// every designed obstacle. While in steep stance: uphill input is stripped, the
	// character drifts downhill, and jumping from the face is refused. Entering
	// requires a CONTINUOUS steep surface under the capsule (see groundSlopeUnder —
	// ledge edges read null and never trigger this), with enter/exit hysteresis so
	// legal ~45° slopes can't flicker the state.
	private steepStance = false;
	private steepDownX = 0;
	private steepDownZ = 0;
	private static readonly STEEP_ENTER_TAN = 1.25;  // ~51.3° (just past the KCC climb limit)
	private static readonly STEEP_EXIT_TAN = 1.0;    // 45°
	private static readonly STEEP_SLIDE_SPEED = 3.0; // downhill drift while perched (m/s)

	// Ledge mantle: while airborne near a ledge whose top is around foot height,
	// holding input toward it pulls the character up onto it. A player whose jump
	// clearly cleared a ledge but lands a hand's width short expects to get on —
	// sliding off feels broken. One assist per airborne phase; the distance from
	// capsule centre to feet is measured while grounded (shape half-heights read
	// back unreliably at runtime).
	private mantleUsed = false;
	private centerToFeet = 0.85;

	// Jump feel (see the Jump section in update()): a press just above the ground
	// buffers into a fresh ground jump; a press just after losing the ground still
	// jumps (coyote). Values match the movement contract's FEEL defaults.
	private jumpBufferTimer = 0;
	private airborneTime = 999;                       // no coyote grant at spawn
	private static readonly COYOTE_S = 0.12;
	private static readonly JUMP_BUFFER_S = 0.15;
	private static readonly JUMP_BUFFER_DIST_M = 0.55; // ground within this of the feet = "about to land"

	// Smooth manual curb step-up. Rapier's autostep can't climb a curb much
	// smaller than the 0.3 m capsule radius — on a sub-radius lip its per-frame
	// forward nudge is shorter than the capsule's rounded-edge gap, so it lands
	// back on the diagonal lip and bails. When the controller reports the
	// horizontal move was blocked while grounded, PhysicsWorld.detectStepUp()
	// looks for a low walkable lip ahead and we mount it ourselves in two phases,
	// with gravity AND snap-to-ground suppressed the whole time:
	//   1. RISE  — lift the capsule until its base clears the lip.
	//   2. FLOAT — hold that height (no drop) while normal forward motion carries
	//              the capsule the ~radius gap over the edge, until it re-grounds
	//              on top. Dropping after the rise (the naive version) just lands
	//              the capsule back on the street before it ever crossed the edge.
	private stepping = false;               // mid climb (rise → float → ground)
	private stepRise = 0;                   // target rise this climb (m, incl. clearance margin)
	private stepRisen = 0;                  // vertical climbed so far this climb (m)
	private stepTimer = 0;                  // seconds elapsed this climb (safety timeout)
	private stepBaseDist = 0;               // centre→ground distance measured on the street at climb start
	private stepDeadline = 0;               // seconds allowed for this climb (rise duration + float budget)
	private blockedFrames = 0;              // consecutive frames stuck with no autostep lift (probe gate)
	private depenRise = 0;                  // metres floated up in the current embedded episode
	private lastFreePos: THREE.Vector3 | null = null; // last target that was clear of static geometry
	private stepProbeCooldown = 0;          // seconds to wait before re-probing after a miss
	private static readonly STEP_MAX_HEIGHT = AUTHORED_STEP_HEIGHT_M;
	/**
	 * Tallest curb this motor mounts, in metres, or null to derive it from the
	 * world (the default — see {@link stepLimit}). Set a number to pin it: an NPC
	 * that must not climb onto scenery, or a game with its own feel.
	 */
	public maxStepHeight: number | null = null;
	private derivedStepHeight: number | null = null;
	private static readonly STEP_BLOCKED_FRAMES = 1; // react on the next frame (this motor owns stepping — see update())
	private static readonly STEP_MIN_SPEED = 0.5;   // only mount while actually walking into it
	/**
	 * Float-phase budget: how long a climb may hold its height waiting to re-ground
	 * once the rise is done. The RISE itself is added on top per climb (see
	 * stepDeadline) — it takes as long as the step is tall, and charging it to this
	 * budget would leave a block-height step no time to cross the edge before the
	 * climb gave up and dropped the character back onto the street.
	 */
	private static readonly STEP_TIMEOUT = 0.6;
	/** Floor on the climb's rise rate (m/s); the walker's own speed is used when faster. */
	private static readonly STEP_RISE_RATE = 2.5;
	// tan of the KCC's 50° slope-climb limit: vertical gain consistent with the
	// horizontal motion up a legal ramp ("no unearned vertical gain" check).
	private static readonly CLIMB_TAN = 1.2;
	// Head-on wall-contact slide suppression: within 25° of straight-into-the-
	// wall the lateral skate is fully removed (the player is aiming AT the
	// wall, e.g. lining up a push); beyond 40° the full slide-along is kept
	// (wall-following); linear ramp between.
	private static readonly SLIDE_STOP_COS = Math.cos(25 * Math.PI / 180);
	private static readonly SLIDE_FREE_COS = Math.cos(40 * Math.PI / 180);
	// Radial clear-out speed away from a kinematic pusher's centre (m/s) — see
	// the sweeper-push section in update().
	private static readonly PUSH_CLEAR = 3.5;

	// Manual prop pushing (replaces both the solver contact and Rapier's
	// built-in applyImpulsesToDynamicBodies, which launches light bodies).
	// Effective shove speed scales with PUSH_MASS/(PUSH_MASS+propMass) and is
	// capped, so heavy props move slowly and nothing is ever launched.
	private static readonly PUSH_MASS = 80;
	private static readonly MAX_PUSH_SPEED = 1.5; // m/s

	// Depenetration net constants and policy live in resolveDepenetration() above.

	// Camera-locked rotation (for ranged weapons)
	private cameraLockRotation: boolean = false;
	// When non-null, the player's yaw is forced to this value every frame and
	// neither movement input nor camera-lock can rotate it. For orchestrated
	// modes that strafe the player but keep it facing a fixed direction (e.g. a
	// goalie that slides left/right but always faces the field).
	private facingLock: number | null = null;
	private cameraController: { getHorizontalAngle: () => number } | null = null;

	// Step-climbing / smooth-bump / stuck-detection tuning flags. The hand-rolled
	// movement these once drove was replaced by the shared
	// KinematicCharacterController (see update()); the flags are retained as public
	// no-ops because external code and published games may still set them (e.g.
	// NPC controllers set enableStuckDetection = false).
	public enableStepClimbing: boolean = true;
	public smoothBumpHeight: number = 0.5;
	public enableStuckDetection: boolean = true; // Set to false for NPCs

	/**
	 * The step limit for this world, resolved once from the world profile.
	 *
	 * 0.65 m is tuned for AUTHORED geometry — a 0.6 m slab reads as ~0.6+ once
	 * voxel quantization is done with it. A BLOCK world is different in kind:
	 * its ledges are whole blocks, so with a limit below the block size the
	 * player walks into every ledge the world is made of and can only ever jump
	 * onto them. Take the block size instead when it is larger, plus the same
	 * quantization margin, and never above the ceiling.
	 *
	 * `voxelBlockSize` is absent from a non-block world's profile, so those keep
	 * the authored limit exactly. Nothing is cached until the world profile is
	 * actually readable, so a first frame that runs before game data is wired
	 * does not pin the default forever.
	 */
	private stepLimit(playerController: PlayerController): number {
		if (this.maxStepHeight !== null) return this.maxStepHeight;
		if (this.derivedStepHeight !== null) return this.derivedStepHeight;
		const profile = playerController.engine?.getGameData?.()?.worldProfileData;
		if (!profile) return WalkingAndJumpingMovement.STEP_MAX_HEIGHT;
		this.derivedStepHeight = stepHeightForWorld(profile.voxelBlockSize);
		return this.derivedStepHeight;
	}

	constructor(
		moveSpeed: number = 5,
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
		maxJumps: number = 1
	) {
		this.moveSpeed = moveSpeed;
		this.acceleration = moveSpeed * 2; // Reach full speed in ~0.5s
		this.physicsConfig = physicsConfig;
		this.maxJumps = maxJumps;
		this.rotation = 0;
		this.verticalVelocity = 0;
		this.jumpHorizontalVelocity = new THREE.Vector2(0, 0);
		this.canJump = true;
		this.jumpCount = 0;
		this.currentSpeed = 0;
		this.depenRise = 0;
		this.lastFreePos = null;
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
		void isGrounded; // grounded is determined by the KCC each frame, not the caller's hint
		if (!playerBody) return; // body may be freed/nulled (e.g. dead NPC still updating)
		if (deltaTime <= 0) return;
		const isMoving = moveDirection.length() > 0;

		// All characters are kinematicPositionBased and driven through the shared
		// Rapier KinematicCharacterController. Its collide-and-slide + autostep +
		// snap-to-ground replace the old hand-rolled ground-detection, step-climb,
		// bump-lift, stuck-escape and wall-push-out. The body never enters the
		// dynamic solver, so it cannot be catapulted, cannot go runaway-Inf, and
		// never shoves dynamic props/vehicles.
		const collider = playerBody.numColliders() > 0 ? playerBody.collider(0) : null;
		if (!collider) return;

		// Grounded state from the PREVIOUS frame's KCC result; refined at the end.
		const grounded = this.lastGroundedState;

		// ---- Moving-platform rider carry ----
		// Replay the supporting kinematic body's pose delta since last frame onto
		// the rider: expected = platformNow + R_y(dYaw)·(riderPrev − platformPrev).
		// The displacement is applied OUTSIDE the collide-and-slide (see the
		// desired-motion note below); the yaw delta turns the rider's facing with
		// the platform.
		//
		// The pose is read from the QUEUED next pose (nextTranslation/nextRotation
		// — what the platform's driver sets with setNextKinematic* every render
		// frame), NOT from translation()/rotation(), which only advance on fixed
		// 60 Hz physics substeps. The platform's mesh follows the queued trajectory
		// smoothly per render frame, and so does the rider's visual (see
		// getRenderPosition), so a carry measured from the substep-quantized body
		// pose arrives in 0×/2× bursts whenever the render clock aliases against
		// the physics accumulator — the rider visibly twitched a few centimeters
		// against the platform 1-2× per second. Next-pose deltas ARE the
		// per-render-frame trajectory deltas, so rider and platform stay glued at
		// any frame rate. (setTranslation() updates the next pose too, so
		// teleport-style movers carry identically.)
		let carryX = 0, carryY = 0, carryZ = 0, carryYaw = 0;
		if (this.carryBody && this.carryBody.isValid()) {
			const cur = this.carryBody.nextTranslation();
			const curYaw = WalkingAndJumpingMovement.yawOf(this.carryBody.nextRotation());
			carryYaw = WalkingAndJumpingMovement.wrapAngle(curYaw - this.carryBodyPrevYaw);
			const t0 = playerBody.translation();
			const rx = t0.x - this.carryBodyPrevPos.x;
			const rz = t0.z - this.carryBodyPrevPos.z;
			const cos = Math.cos(carryYaw), sin = Math.sin(carryYaw);
			carryX = cur.x + (rx * cos + rz * sin) - t0.x;
			carryZ = cur.z + (-rx * sin + rz * cos) - t0.z;
			carryY = cur.y - this.carryBodyPrevPos.y;
			// Conveyor belts: a PARKED kinematic body can declare a surface
			// velocity (userData.conveyorVel) that transports riders — the
			// belt's pose never changes, the carry adds the drift instead.
			// Jump-off inherits it via carryVelX/Z like any platform ride.
			const cv = (this.carryBody.userData as { conveyorVel?: { x?: number; z?: number } } | null | undefined)?.conveyorVel;
			if (cv) {
				carryX += (typeof cv.x === 'number' ? cv.x : 0) * deltaTime;
				carryZ += (typeof cv.z === 'number' ? cv.z : 0) * deltaTime;
			}
			this.carryVelX = carryX / deltaTime;
			this.carryVelZ = carryZ / deltaTime;
		} else {
			this.carryVelX = 0;
			this.carryVelZ = 0;
		}

		// ---- Kinematic sweeper push ----
		// A kinematic mover INTERSECTING the capsule (spinner arm, sweeping bar,
		// platform side, closing door) pushes the character along the mover's own
		// surface motion at the capsule position — one frame of cur→queued-next
		// pose, the same math as the carry. Without this a sweeper passes
		// straight through a standing player: kinematic pairs make no contacts
		// and the KCC only resolves collisions when the character itself moves.
		// The push joins `desired`, so it goes through the collide-and-slide — a
		// sweeper shoves the character but can never force it through a wall.
		// Horizontal only: vertical crushers are the solve/gravity's business.
		// On top of the sweep transport, PUSH_CLEAR drives the character
		// radially AWAY from the pusher's centre: tangential overspeed can't
		// escape a spinner (its own leading face clamps exactly that direction),
		// but sliding outward along the arm exits past the tip — a spinner
		// flings the character off instead of shepherding it in circles forever.
		let pushX = 0, pushZ = 0;
		const pusher = physicsWorld.kinematicBodyOverlapping(collider, this.carryBody);
		if (pusher) {
			const cur = pusher.translation();
			const nxt = pusher.nextTranslation();
			const dYaw = WalkingAndJumpingMovement.wrapAngle(
				WalkingAndJumpingMovement.yawOf(pusher.nextRotation())
				- WalkingAndJumpingMovement.yawOf(pusher.rotation()),
			);
			const t0 = playerBody.translation();
			const rx = t0.x - cur.x;
			const rz = t0.z - cur.z;
			const cos = Math.cos(dYaw), sin = Math.sin(dYaw);
			pushX = nxt.x + (rx * cos + rz * sin) - t0.x;
			pushZ = nxt.z + (-rx * sin + rz * cos) - t0.z;
			const away = Math.hypot(rx, rz);
			if (away > 0.2) {
				const clear = WalkingAndJumpingMovement.PUSH_CLEAR * deltaTime / away;
				pushX += rx * clear;
				pushZ += rz * clear;
			} else {
				// Directly under the mover's centre (a crusher slamming straight
				// down): the radial direction is degenerate — squeeze out along
				// the character's own facing instead of being enveloped in place.
				pushX += Math.sin(this.rotation) * WalkingAndJumpingMovement.PUSH_CLEAR * deltaTime;
				pushZ += Math.cos(this.rotation) * WalkingAndJumpingMovement.PUSH_CLEAR * deltaTime;
			}
		}

		// ---- Steep-stance detection (see field docs) ----
		if (grounded) {
			const slope = physicsWorld.groundSlopeUnder(collider);
			if (slope === null) {
				// Ledge edge / discontinuity — never steep here (jumping off ledges is the game).
				this.steepStance = false;
			} else if (slope.tan > WalkingAndJumpingMovement.STEEP_ENTER_TAN
				|| (this.steepStance && slope.tan > WalkingAndJumpingMovement.STEEP_EXIT_TAN)) {
				this.steepStance = true;
				this.steepDownX = slope.downX;
				this.steepDownZ = slope.downZ;
			} else {
				this.steepStance = false;
			}
		} else {
			this.steepStance = false;
		}

		// ---- Horizontal velocity (preserves the player's accel/friction feel) ----
		// Tracked internally; the body's linvel is the post-collision output, not
		// the input state (and may have been adopted from an external impulse above).
		let velX = this.horizVelX;
		let velZ = this.horizVelZ;
		if (isMoving) {
			const targetRotation = Math.atan2(moveDirection.x, moveDirection.z);
			this.currentSpeed = this.currentSpeed < this.moveSpeed
				? Math.min(this.moveSpeed, this.currentSpeed + this.acceleration * deltaTime)
				: this.moveSpeed;
			const targetVelX = moveDirection.x * this.currentSpeed;
			const targetVelZ = moveDirection.z * this.currentSpeed;
			if (grounded) {
				const blendRate = Math.min(1.0, this.physicsConfig.groundFriction * 1.5 * deltaTime * 60);
				velX += (targetVelX - velX) * blendRate;
				velZ += (targetVelZ - velZ) * blendRate;
				let rotationDiff = targetRotation - this.rotation;
				if (rotationDiff > Math.PI) rotationDiff -= Math.PI * 2;
				if (rotationDiff < -Math.PI) rotationDiff += Math.PI * 2;
				this.rotation += rotationDiff * blendRate;
			} else {
				this.rotation = targetRotation;
				const airControl = this.physicsConfig.airControlMultiplier;
				velX = this.jumpHorizontalVelocity.x * (1 - airControl) + targetVelX * airControl;
				velZ = this.jumpHorizontalVelocity.y * (1 - airControl) + targetVelZ * airControl;
			}
			if (this.facingLock === null && !this.cameraLockRotation && playerController.player) {
				playerController.player.rotation.y = this.rotation;
			}
		} else {
			if (this.currentSpeed > 0) {
				this.currentSpeed = Math.max(0, this.currentSpeed - this.acceleration * 2 * deltaTime);
			}
			if (grounded) {
				const velocityRetention = 1 - (this.physicsConfig.groundFriction * 0.1);
				const frictionFactor = Math.pow(velocityRetention, deltaTime * 60);
				velX *= frictionFactor;
				velZ *= frictionFactor;

				// Kill the last of the velocity instead of decaying it forever.
				//
				// This friction is exponential, so it approaches zero and never
				// arrives: at the default groundFriction of 0.9 the half-life is
				// ~0.12 s. Meanwhile the locomotion animation cuts to idle at
				// PlayerController.LOCOMOTION_STOP_SPEED, so the character spends
				// that whole remaining tail — roughly 7 cm — gliding forward with
				// its legs already still. That mismatch is what reads as sliding
				// after you stop running.
				//
				// Snapping just under the animation's own cutoff loses nothing
				// visible: by definition the legs have already stopped at this
				// speed. This is the no-input, grounded branch only, so knockback,
				// slope slides and moving platforms are unaffected.
				const snap = WalkingAndJumpingMovement.STOP_SNAP_SPEED;
				if (velX * velX + velZ * velZ < snap * snap) {
					velX = 0;
					velZ = 0;
				}
			} else {
				velX = this.jumpHorizontalVelocity.x;
				velZ = this.jumpHorizontalVelocity.y;
			}
		}
		// ---- Ledge mantle assist ----
		// Airborne, not rising fast, holding input toward a ledge whose standable top
		// is around foot height: pull the character up onto it (through the KCC, so a
		// ceiling or wall still clamps it). Covers the two feels players expect: a
		// jump that "clearly made it" but landed a hand short, and jumping straight up
		// at a low wall while pressing toward it.
		// Speed window: near-apex or a short post-apex drop. Plunging past -9
		// is a real FALL — assisting there turned the mantle into a mid-air
		// parachute over plain ground (see the ledge gate below too).
		if (!grounded && !this.stepping && isMoving && !this.mantleUsed
			&& this.verticalVelocity <= 2.5 && this.verticalVelocity >= -9) {
			const mLen = Math.hypot(moveDirection.x, moveDirection.z) || 1;
			const mdx = moveDirection.x / mLen, mdz = moveDirection.z / mLen;
			// Grabbable window: top between (feet − 0.45) and (feet + 0.4).
			const minBelow = this.centerToFeet - 0.4;
			const maxBelow = this.centerToFeet + 0.45;
			const top = physicsWorld.ledgeForMantle(collider, mdx, mdz, minBelow, maxBelow);
			if (top !== null) {
				const t = playerBody.translation();
				const feetNow = t.y - this.centerToFeet;
				// The target must be a LEDGE — clearly raised above whatever floor
				// is straight below — not the continuous ground ahead. Without
				// this, falling over flat ground with input held read the floor
				// itself as a "ledge at foot height" and zeroed the fall velocity
				// mid-air (a parachute), softening every landing. No floor within
				// reach below = a lip over a drop, the classic mantle case.
				const floorDist = physicsWorld.groundDistBelowCenter(collider, this.centerToFeet + 2.0);
				const isLedge = !Number.isFinite(floorDist) || top - (t.y - floorDist) > 0.35;
				if (isLedge) {
					// Run the mantle through the step-climb machinery (RISE to the
					// lip, then FLOAT while held input carries the capsule over,
					// gravity and snap suppressed, 0.6 s bail-out). A one-shot
					// up-and-forward displacement doesn't work: the diagonal sweep
					// slides up the wall face and sheds its forward component, and
					// the crest then stalls on the lip corner and slides back off.
					this.stepping = true;
					this.stepRise = (top - feetNow) + 0.1;
					this.stepRisen = 0;
					this.stepTimer = 0;
					// Climb ends when the centre is over the raised surface: ground
					// directly below reads ~standing distance again.
					this.stepBaseDist = this.centerToFeet + 0.05;
					this.verticalVelocity = 0;
					this.mantleUsed = true;
				}
			}
		}

		// Too-steep ground refuses to be climbed: remove the uphill component of the
		// motion and drift downhill, so voxel sub-ledges can't be stair-stepped up a
		// face the slope limit forbids. (The drift joins `desired` below, collision-
		// clamped like everything else.)
		let slideX = 0, slideZ = 0;
		if (this.steepStance) {
			const upDot = velX * -this.steepDownX + velZ * -this.steepDownZ;
			if (upDot > 0) {
				velX += this.steepDownX * upDot;
				velZ += this.steepDownZ * upDot;
			}
			slideX = this.steepDownX * WalkingAndJumpingMovement.STEEP_SLIDE_SPEED * deltaTime;
			slideZ = this.steepDownZ * WalkingAndJumpingMovement.STEEP_SLIDE_SPEED * deltaTime;
		}
		this.horizVelX = velX;
		this.horizVelZ = velZ;

		// A rotating platform turns the rider's facing with it (input steering
		// above still applies on top). Locked facing modes win as usual.
		if (carryYaw !== 0) {
			this.rotation = WalkingAndJumpingMovement.wrapAngle(this.rotation + carryYaw);
			if (this.facingLock === null && !this.cameraLockRotation && playerController.player) {
				playerController.player.rotation.y = this.rotation;
			}
		}

		// ---- Jump (with jump BUFFER + COYOTE time, per the movement contract) ----
		// A press while falling JUST ABOVE the ground is intent for a fresh ground
		// jump — it must never be spent on the remaining air-jump slot (that burned
		// the double jump a player needed right after landing on a crumbling block).
		// Such a press is BUFFERED and fires as a full ground jump on landing.
		// Coyote: a press just AFTER losing the ground (ledge walk-off, a platform
		// crumbling underfoot) still counts as a ground jump for a short window.
		// Buffered fire first (grounded is last frame's state, so this runs on the
		// first frame after touchdown; checked before the timer decays so the buffer
		// survives one frame at ANY frame rate).
		if (this.jumpBufferTimer > 0 && grounded && this.jumpCount === 0 && this.verticalVelocity <= 0 && !this.steepStance) {
			this.fireJump(isMoving, moveDirection);
			this.jumpBufferTimer = 0;
		}
		this.jumpBufferTimer = Math.max(0, this.jumpBufferTimer - deltaTime);
		// No launching off a too-steep face (jump-spam would climb it ledge by ledge).
		const coyoteOk = grounded || this.airborneTime <= WalkingAndJumpingMovement.COYOTE_S;
		const canPerformJump = this.jumpCount === 0 ? (coyoteOk && !this.steepStance) : true;
		const pressEdge = keys.ascend && this.canJump && this.verticalVelocity <= 0;
		const nearGroundFalling = (): boolean => !grounded
			&& physicsWorld.groundDistBelowCenter(collider, this.centerToFeet + WalkingAndJumpingMovement.JUMP_BUFFER_DIST_M)
				<= this.centerToFeet + WalkingAndJumpingMovement.JUMP_BUFFER_DIST_M;
		if (pressEdge && this.jumpCount < this.maxJumps && canPerformJump) {
			if (this.jumpCount > 0 && nearGroundFalling()) {
				// About to land: buffer a fresh ground jump instead of burning the air slot.
				this.jumpBufferTimer = WalkingAndJumpingMovement.JUMP_BUFFER_S;
				this.canJump = false;
			} else {
				this.fireJump(isMoving, moveDirection);
			}
		} else if (pressEdge && this.jumpCount === 0 && !coyoteOk && nearGroundFalling()) {
			// Fell too long for coyote but the ground is right there: buffer the press.
			this.jumpBufferTimer = WalkingAndJumpingMovement.JUMP_BUFFER_S;
			this.canJump = false;
		}
		if (!keys.ascend) this.canJump = true;

		// One limit for the whole frame: the probe that starts a climb, the
		// unearned-lift check and the climb's own ground cast must agree.
		const stepMax = this.stepLimit(playerController);

		// ---- Smooth curb step-up (see stepping docs) ----
		// When last frame's collide-and-slide was blocked horizontally while
		// grounded, walking into it, and not jumping, probe for a low walkable lip
		// just ahead and, if found, begin the rise→float climb the block below runs.
		this.stepProbeCooldown -= deltaTime;
		const stepSpeed = Math.hypot(velX, velZ);
		if (!this.stepping && this.blockedFrames >= WalkingAndJumpingMovement.STEP_BLOCKED_FRAMES && grounded
			&& !this.steepStance
			&& this.stepProbeCooldown <= 0 && this.verticalVelocity <= 0.01
			&& stepSpeed >= WalkingAndJumpingMovement.STEP_MIN_SPEED) {
			const rise = physicsWorld.detectStepUp(collider, velX, velZ, stepMax);
			if (rise > 0) {
				this.stepping = true;
				this.stepRise = rise + 0.03; // small overshoot so the base clears the lip
				this.stepRisen = 0;
				this.stepTimer = 0;
				this.stepDeadline = WalkingAndJumpingMovement.STEP_TIMEOUT
					+ this.stepRise / WalkingAndJumpingMovement.STEP_RISE_RATE;
				// Centre→street distance now (we're still on the street): the climb
				// is done when the centre is again this close to the ground below —
				// i.e. it has crossed onto the raised surface, not just touched it.
				const d = physicsWorld.groundDistBelowCenter(collider, 4.0);
				this.stepBaseDist = Number.isFinite(d) ? d : 0.9;
			} else {
				this.stepProbeCooldown = 0.2; // wall ahead — back off probing for 200 ms
			}
		}

		// ---- Vertical motion: curb climb overrides gravity, else gravity ----
		// While stepping, gravity is suppressed. RISE phase: lift at ≥ walking pace
		// until the base clears the lip. FLOAT phase (risen reached): hold height
		// (stepDy = 0) so the unchanged forward velocity carries the capsule over
		// the edge to re-ground on top (snap-to-ground is suppressed below too, so
		// the held height isn't yanked back down to the street).
		let stepDy = 0;
		if (this.stepping) {
			this.stepTimer += deltaTime;
			if (this.stepRisen < this.stepRise) {
				const rate = Math.max(WalkingAndJumpingMovement.STEP_RISE_RATE, Math.hypot(velX, velZ));
				stepDy = Math.min(this.stepRise - this.stepRisen, rate * deltaTime);
				this.stepRisen += stepDy;
			}
			this.verticalVelocity = 0;
		} else if (this.gravityEnabled) {
			// ---- Gravity (integrated manually, fed to the controller as Y motion) ----
			if (!grounded || this.verticalVelocity > 0) {
				this.verticalVelocity += this.physicsConfig.gravity * deltaTime;
				const term = Math.abs(this.physicsConfig.terminalVelocity);
				if (this.verticalVelocity < -term) this.verticalVelocity = -term;
			} else {
				// Grounded: no forced downward velocity. The controller's
				// snap-to-ground keeps the capsule glued to the floor on slopes
				// and tiny drops. (A forced downward push would, combined with any
				// movement, drive the capsule into the thin trimesh ground.)
				this.verticalVelocity = 0;
			}
		} else {
			this.verticalVelocity = 0;
		}

		// ---- Collide-and-slide via the shared KinematicCharacterController ----
		// External XZ displacement (e.g. committed animation root motion — a kick
		// stepping into the ball) rides along with input motion through the same
		// collision-clamped solve, so it never tunnels through walls. It's a
		// player-only feature: other movement hosts (animals, NPCs, snakes) pass
		// themselves as the controller and don't implement it, so treat the method
		// as optional and default to zero displacement when it's absent.
		const consume = (playerController as Partial<Pick<PlayerController, 'consumeExternalDisplacement'>>).consumeExternalDisplacement;
		const ext = consume ? consume.call(playerController, this._externalDisplacement) : this._externalDisplacement.set(0, 0, 0);
		// The platform CARRY is deliberately NOT part of the KCC's desired motion.
		// It is a rigid-frame transport added to the applied target after the solve
		// (below): feeding it through collide-and-slide made the solver stall the
		// lateral carry whenever the platform had just moved from under the capsule
		// (a descending leg of an inclined run — the rider twitched, walked in
		// place, and slid off, direction-dependently). Colliding the carry was for
		// wall safety; the solver's initial-penetration recovery on the NEXT frame
		// covers the rare carried-into-an-obstacle case instead.
		const desired = {
			x: velX * deltaTime + ext.x + slideX + pushX,
			y: stepDy > 0 ? stepDy : this.verticalVelocity * deltaTime,
			z: velZ * deltaTime + ext.z + slideZ + pushZ,
		};
		const controller = physicsWorld.getCharacterController();
		// Filter with the capsule's own collision groups, PLUS the dynamic-prop,
		// enemy and animal bits in the filter half. Whether a given body actually
		// blocks the player is decided by that body's own mask: props, NPCs and
		// animals all include PLAYER (see CollisionLayers), so the player's
		// collide-and-slide treats all three as solid obstacles — it walks against
		// / stands on props and can't pass through enemies or animals. The pairing
		// is one-sided (the PLAYER mask omits ENEMY/ANIMAL/DYNAMIC_PROP) so those
		// bodies are never blocked by, or solver-shoved by, the player; NPCs/animals
		// are path-driven and reach the player regardless. Sensors are excluded —
		// they observe, never block. No body here is solver-paired with the player,
		// so none can be launched by penetration recovery.
		const kccFilter = collider.collisionGroups()
			| ((CollisionGroup.DYNAMIC_PROP | CollisionGroup.ENEMY | CollisionGroup.ANIMAL) << 16);
		// While mounting a curb, suppress snap-to-ground for the WHOLE climb (rise
		// and float): the held height sits above the street within the 0.5 m snap
		// distance, so snap would yank the capsule straight back down before the
		// forward float crosses the edge. Restored immediately after so other
		// characters and later frames keep their ground-stick.
		if (this.stepping) controller.disableSnapToGround();
		// Rapier's autostep is OFF for this motor: its width check is capsule
		// clearance, not tread depth, so it happily mounts one-voxel slivers on the
		// face of a taller wall (lift → no support → fall → repeat, the "bob loop").
		// The manual step-up below owns ALL stepping for this motor — it verifies a
		// real standable tread before lifting. Restored after the solve because the
		// controller is shared and other characters still rely on autostep.
		controller.disableAutostep();
		// A body ALREADY inside the capsule must never keep the character in —
		// but it stays solid for any move INTO it. Other characters are solid to
		// this motor yet not blocked by it, so one can end up penetrating the
		// capsule; Rapier then refuses every move that goes deeper, and from an
		// awkward angle that can be every move. So after a blocked frame, a body
		// overlapping the capsule is ignored for moves away from it (and only
		// those — see engine/physics/TrappedBodies.ts): you step out of it, you
		// never walk through it. Free movement never runs the query.
		const trapped = this._trappedBy;
		trapped.clear();
		if (this.blockedLastFrame) {
			const shape = collider.shape as RAPIER.Capsule;
			physicsWorld.overlappingColliderHandles(
				playerBody.translation(), shape.radius, shape.halfHeight,
				CollisionGroup.ENEMY | CollisionGroup.ANIMAL | CollisionGroup.DYNAMIC_PROP, trapped,
			);
		}
		const selfPos = playerBody.translation();
		controller.computeColliderMovement(
			collider,
			desired,
			QUERY_EXCLUDE_SENSORS, // lane-agnostic: no rapier3d value read (2D bundles stub it)
			kccFilter,
			(other) => other.handle !== collider.handle
				&& !(trapped.has(other.handle) && movesAwayFrom(desired, selfPos, other.translation())),
		);
		const mv = controller.computedMovement();
		const wantXZ = Math.hypot(desired.x, desired.z);
		this.blockedLastFrame = wantXZ > 1e-4 && Math.hypot(mv.x, mv.z) < wantXZ * 0.25;
		const groundedNow = controller.computedGrounded();
		controller.enableAutostep(0.65, 0.3, false);
		if (this.stepping) controller.enableSnapToGround(0.5);

		// ---- No unearned vertical gain ----
		// A positive vertical output nothing asked for must be JUSTIFIED. The KCC
		// can inch-worm up ANY voxel face — even a vertical cliff — a few mm per
		// frame while still reporting grounded: every sub-radius mini-tread
		// contact is flat, so the slope limit never sees the macro face (and the
		// steep-stance probe reads null once its forward sample sits inside the
		// rock). Allowed lifts: slope-consistent redirection of the horizontal
		// motion (walking up a ≤50° ramp) or a verified mountable step ahead
		// (stairs). Anything else is a wall/cliff crawl — strip it, so the
		// character stays footed at the base (jump keeps working) instead of
		// hovering slowly up a face it was never meant to climb.
		// Grounded frames only: the crawl loop IS a grounded phenomenon (the
		// mini-treads read as floor), while airborne lip contacts are how a
		// mantle crests over an edge — stripping those made the mantle stall on
		// the lip and slide back off.
		let mvY = mv.y;
		if (!this.stepping && grounded && desired.y <= 1e-9 && mvY > 1e-4) {
			const mvH = Math.hypot(mv.x, mv.z);
			if (mvY > mvH * WalkingAndJumpingMovement.CLIMB_TAN + 1e-3
				&& physicsWorld.detectStepUp(collider, velX, velZ, stepMax) <= 0) {
				mvY = 0;
			}
		}

		// ---- Head-on wall contact: no lateral skate ----
		// The collide-and-slide projects blocked motion onto the wall plane, so
		// walking into a wall even slightly off-perpendicular skates the
		// character sideways at nearly full speed — lining up a push (or simply
		// standing at a wall) becomes fiddly. When the intended motion is nearly
		// head-on into a wall contact the player is aiming AT the wall: suppress
		// the lateral component and keep only motion along the intended
		// direction. At shallower angles wall-following is what players want, so
		// the full slide is restored beyond SLIDE_FREE, with a ramp between.
		let mvX = mv.x, mvZ = mv.z;
		if (!this.stepping) {
			const wantH = Math.hypot(desired.x, desired.z);
			if (wantH > 1e-4) {
				const dxN = desired.x / wantH, dzN = desired.z / wantH;
				let headOn = 0, wallNx = 0, wallNz = 0;
				const nColl = controller.numComputedCollisions();
				for (let i = 0; i < nColl; i++) {
					const hit = controller.computedCollision(i);
					if (!hit) continue;
					const n = hit.normal1;                      // points out of the obstacle
					if (Math.abs(n.y) > 0.6) continue;          // walls only, never the ground
					const nl = Math.hypot(n.x, n.z);
					if (nl < 1e-6) continue;
					const ca = -(dxN * (n.x / nl) + dzN * (n.z / nl));
					if (ca > headOn) { headOn = ca; wallNx = n.x / nl; wallNz = n.z / nl; }
				}
				if (headOn > WalkingAndJumpingMovement.SLIDE_FREE_COS) {
					const t = Math.min(1, (headOn - WalkingAndJumpingMovement.SLIDE_FREE_COS)
						/ (WalkingAndJumpingMovement.SLIDE_STOP_COS - WalkingAndJumpingMovement.SLIDE_FREE_COS));
					// Split the solve's output at the wall into its wall-normal part
					// (the approach/recovery pressing equilibrium — keep it EXACTLY,
					// it's what holds the contact) and the wall-tangential part (the
					// sideways skate) — and scale only the skate. Re-projecting the
					// whole movement onto the intended direction instead re-injects
					// the (large) approach magnitude as lateral drift.
					const intoN = mvX * wallNx + mvZ * wallNz;
					const tanX = mvX - wallNx * intoN;
					const tanZ = mvZ - wallNz * intoN;
					const keep = 1 - t;
					mvX = wallNx * intoN + tanX * keep;
					mvZ = wallNz * intoN + tanZ * keep;
				}
			}
		}

		// Motion in the GROUND's frame: this frame's collision-clamped movement
		// (after the head-on adjustment), per render frame — consistent regardless
		// of the render/physics rate ratio (unlike the body's substep linvel).
		// Carry is not inside mv, so this IS the solve's own motion.
		this.groundRelSpeed = Math.hypot(mvX, mvZ) / deltaTime;

		// End the climb only when the capsule CENTRE is over the raised surface —
		// the ground straight below the centre sits ~at the lifted base height. The
		// controller's grounded flag trips earlier (when the front edge first
		// touches the lip, centre still a radius behind), and snap-to-ground then
		// drags the capsule back to the street. Bail on the safety timeout (walker
		// stopped, or the lip vanished) so gravity resumes instead of hovering.
		if (this.stepping) {
			const groundBelow = physicsWorld.groundDistBelowCenter(
				collider, this.stepBaseDist + stepMax + 0.5,
			);
			const centerOverLip = groundBelow <= this.stepBaseDist + 0.06;
			const risenEnough = this.stepRisen >= this.stepRise - 1e-4;
			if ((risenEnough && centerOverLip) || this.stepTimer > this.stepDeadline) {
				this.stepping = false;
			}
		}

		// Count consecutive frames we're genuinely STUCK — horizontal motion lost
		// AND the controller didn't lift us. The mv.y guard is the important part:
		// Rapier's autostep climbs a block by raising the capsule (mv.y > 0) while
		// that frame's horizontal motion drops, so without it we'd misread autostep's
		// own climb as a block and barge in, shadowing the engine's native step-up.
		// The gate only fires after several stuck frames, so autostep is always the
		// first responder and our manual step-up stays a last resort (sub-radius lips
		// with a diagonal contact, which autostep can't climb). Reset while mid-climb.
		if (!this.stepping) {
			const wantH = Math.hypot(desired.x, desired.z);
			const gotH = Math.hypot(mvX, mvZ);
			const stuck = wantH > 1e-4 && gotH < wantH * 0.6 && mvY <= 0.02;
			this.blockedFrames = stuck ? this.blockedFrames + 1 : 0;
		}

		// Apply the collision-clamped movement EXACTLY via setNextKinematicTranslation.
		// This is the only application that cannot overshoot: the body lands on the
		// precise non-penetrating position the controller computed, so a capsule can
		// never punch through the thin (hollow-underneath) trimesh ground. Driving
		// the body by velocity instead lets the fixed-60Hz substep integrate further
		// than `mv` at high refresh rates, sinking the capsule below the surface.
		//
		// Because the motor runs per render frame but physics steps at 60Hz, on a
		// frame where no substep ran the body translation is unchanged. Continue
		// from the still-pending target in that case so queued movement accumulates
		// rather than being recomputed-and-discarded (the high-fps slowdown). A
		// translation matching neither the pending origin nor target means an
		// external teleport — restart from the actual body position.
		const t = playerBody.translation();
		let baseX = t.x, baseY = t.y, baseZ = t.z;
		if (this.pendingFrom && this.pendingTarget) {
			const f = this.pendingFrom, p = this.pendingTarget;
			const df = (t.x - f.x) ** 2 + (t.y - f.y) ** 2 + (t.z - f.z) ** 2;
			const dp = (t.x - p.x) ** 2 + (t.y - p.y) ** 2 + (t.z - p.z) ** 2;
			if (df < 1e-12 && dp >= 1e-12) { baseX = p.x; baseY = p.y; baseZ = p.z; }
		}
		// Apply the collision-clamped own motion PLUS the rigid platform carry (see the
		// desired-motion note above for why the carry bypasses the solve).
		let tgtX = baseX + mvX + carryX;
		let tgtY = baseY + mvY + carryY;
		let tgtZ = baseZ + mvZ + carryZ;
		// The carry bypasses the solve, so it must never push the capsule inside
		// the static world: a descending platform under a rider straddling solid
		// ground would drag it into the terrain (permanently wedged — an embedded
		// capsule blocks in every direction and the KCC won't dig it out), and a
		// mover can sweep a rider against a wall. If the carried target overlaps,
		// drop the carry for this frame: the platform slides on underneath and
		// the character keeps its solid footing.
		if ((carryX !== 0 || carryY !== 0 || carryZ !== 0)
			&& physicsWorld.capsuleOverlapsStatic(collider, { x: tgtX, y: tgtY, z: tgtZ })) {
			tgtX -= carryX; tgtY -= carryY; tgtZ -= carryZ;
		}
		// Depenetration net: if the capsule is STILL inside static geometry (a
		// teleport into a wall, a legacy game's manual mover, any writer this motor
		// doesn't know about), rescue it rather than leave the player buried —
		// back to the last clear spot where possible, otherwise a bounded float
		// upward. See resolveDepenetration() for the policy and why it is not
		// simply "float up".
		if (physicsWorld.capsuleOverlapsStatic(collider, { x: tgtX, y: tgtY, z: tgtZ })) {
			const free = this.lastFreePos;
			const stillClear = free !== null
				&& !physicsWorld.capsuleOverlapsStatic(collider, { x: free.x, y: free.y, z: free.z });
			const rescue = resolveDepenetration(
				{ x: tgtX, y: tgtY, z: tgtZ }, free, stillClear, this.depenRise, deltaTime,
			);
			tgtX = rescue.pos.x; tgtY = rescue.pos.y; tgtZ = rescue.pos.z;
			this.depenRise = rescue.riseUsed;
			if (rescue.moved && this.verticalVelocity < 0) this.verticalVelocity = 0;
		} else {
			// Clear of geometry: remember this spot and give the next burial a fresh budget.
			this.lastFreePos = (this.lastFreePos ?? new THREE.Vector3()).set(tgtX, tgtY, tgtZ);
			this.depenRise = 0;
		}
		playerBody.setNextKinematicTranslation({ x: tgtX, y: tgtY, z: tgtZ });
		this.pendingFrom = (this.pendingFrom ?? new THREE.Vector3()).set(t.x, t.y, t.z);
		this.pendingTarget = (this.pendingTarget ?? new THREE.Vector3()).set(tgtX, tgtY, tgtZ);
		this.renderPosition = (this.renderPosition ?? new THREE.Vector3()).copy(this.pendingTarget);

		// ---- Manual capped prop push ----
		// For dynamic bodies the controller blocked on (props, vehicles), apply a
		// small impulse so walking into them shoves them slowly. Mass-scaled and
		// speed-capped: heavy objects barely move, light ones never launch.
		const numCollisions = controller.numComputedCollisions();
		for (let i = 0; i < numCollisions; i++) {
			const hit = controller.computedCollision(i);
			if (!hit) continue;
			const otherBody = hit.collider?.parent();
			if (!otherBody || !otherBody.isDynamic()) continue;
			// Push direction: opposite of the obstacle's outward contact normal,
			// projected on the horizontal plane.
			let px = -hit.normal1.x;
			let pz = -hit.normal1.z;
			const len = Math.hypot(px, pz);
			if (len < 1e-3) continue; // standing on top — no horizontal push
			px /= len;
			pz /= len;
			const intoSpeed = velX * px + velZ * pz; // attempted speed into the obstacle
			if (intoSpeed <= 0.01) continue;
			const mass = otherBody.mass();
			if (!(mass > 0)) continue;
			const massFactor = WalkingAndJumpingMovement.PUSH_MASS / (WalkingAndJumpingMovement.PUSH_MASS + mass);
			const targetSpeed = Math.min(intoSpeed, WalkingAndJumpingMovement.MAX_PUSH_SPEED) * massFactor;
			const olv = otherBody.linvel();
			const currentAlong = olv.x * px + olv.z * pz;
			if (currentAlong >= targetSpeed) continue; // already moving away fast enough
			const impulse = mass * (targetSpeed - currentAlong);
			otherBody.applyImpulse({ x: px * impulse, y: 0, z: pz * impulse }, true);
		}

		// ---- Grounded bookkeeping ----
		this.lastGroundedState = groundedNow;
		this.airborneTime = groundedNow ? 0 : this.airborneTime + deltaTime;
		if (groundedNow) {
			if (this.verticalVelocity < 0) this.verticalVelocity = 0;
			this.jumpCount = 0;
			this.jumpHorizontalVelocity.set(0, 0);
			this.mantleUsed = false;
			// Measure centre→feet on real ground (shape half-heights are unreliable);
			// the mantle window derives from it.
			const d = physicsWorld.groundDistBelowCenter(collider, 2.0);
			if (Number.isFinite(d) && d > 0.3 && d < 1.6) this.centerToFeet = d;
		}

		// Record the kinematic body under the rider (if any) and its queued next
		// pose, so the next frame can replay the platform's motion onto the rider.
		// The platform's driver requeues the next pose once per render frame
		// (after this update), so next frame's read minus this one is exactly one
		// render frame of platform trajectory — smooth at any frame rate (see the
		// carry section above). Not gated on the grounded flag: a transient
		// one-frame bounce (autostep lift, landing wobble) must not break the
		// carry chain — each broken frame silently loses one frame of platform
		// motion. Instead the ray itself decides: carry whenever the character is
		// not ascending and a kinematic surface is right below. Jumping
		// (verticalVelocity > 0) drops the carry — the inherited jump velocity
		// takes over mid-air.
		this.carryBody = this.verticalVelocity <= 0.01
			? physicsWorld.kinematicBodyBelowCenter(collider, 1.6)
			: null;
		if (this.carryBody) {
			const bt = this.carryBody.nextTranslation();
			this.carryBodyPrevPos.set(bt.x, bt.y, bt.z);
			this.carryBodyPrevYaw = WalkingAndJumpingMovement.yawOf(this.carryBody.nextRotation());
		}

		// Forced facing lock (orchestrated modes) wins over both movement- and
		// camera-driven rotation. Applied here, at the end of the movement update,
		// so it is the final yaw written before the character is posed/rendered.
		if (this.facingLock !== null && playerController.player) {
			this.rotation = this.facingLock;
			playerController.player.rotation.y = this.facingLock;
		} else if (this.cameraLockRotation && this.cameraController && playerController.player) {
			// Camera-locked rotation (ranged weapons): always face the camera.
			this.rotation = this.cameraController.getHorizontalAngle() + Math.PI;
			playerController.player.rotation.y = this.rotation;
		}
	}

	getCurrentSpeed(): number {
		return this.currentSpeed;
	}

	/** Retained for API compatibility. Step interpolation now lives in the shared
	 *  KinematicCharacterController, so this is always false. */
	isStepClimbing(): boolean {
		return false;
	}

	isInAir(): boolean {
		return this.verticalVelocity > 0.1;
	}

	private lastGroundedState: boolean = false;

	wasGroundedLastUpdate(): boolean {
		return this.lastGroundedState;
	}

	/**
	 * Horizontal speed relative to the ground being stood on (m/s): the frame's
	 * collision-clamped movement minus the platform carry, over the frame time.
	 * Animation reads this to judge movement in the ground's frame — a body
	 * carried by a moving platform is standing still and must not step in place.
	 */
	getGroundRelativeSpeed(): number {
		return this.groundRelSpeed;
	}

	isGravityEnabled(): boolean {
		return this.gravityEnabled;
	}

	resetVerticalVelocity(): void {
		this.verticalVelocity = 0;
	}

	getRotation(): number {
		return this.rotation;
	}

	setRotation(rotation: number): void {
		this.rotation = rotation;
	}

	reset(): void {
		this.verticalVelocity = 0;
		this.jumpHorizontalVelocity.set(0, 0);
		this.canJump = true;
		this.jumpCount = 0;
		this.currentSpeed = 0;
		this.horizVelX = 0;
		this.horizVelZ = 0;
		this.pendingFrom = null;
		this.pendingTarget = null;
		this.lastGroundedState = false;
		this.carryBody = null;
		this.carryVelX = 0;
		this.carryVelZ = 0;
		this.steepStance = false;
		this.jumpBufferTimer = 0;
		this.airborneTime = 999;
	}

	/**
	 * Impulse-like velocity change for the kinematic motor — knockback from
	 * hazards, explosions, enemy hits. The player body is kinematicPositionBased,
	 * so `body.setLinvel()` / `body.applyImpulse()` are SILENT NO-OPS; game code
	 * must call this instead (via PlayerController.applyKnockback). Horizontal
	 * velocity is added to the motor and persists through the air; a positive Y
	 * launches the character off the ground.
	 */
	applyImpulse(velocity: { x: number; y?: number; z: number }): void {
		this.horizVelX += velocity.x;
		this.horizVelZ += velocity.z;
		this.jumpHorizontalVelocity.set(this.horizVelX, this.horizVelZ);
		const vy = velocity.y ?? 0;
		if (vy > 0) this.verticalVelocity = Math.max(this.verticalVelocity, 0) + vy;
		this.stepping = false; // abort any in-progress step-climb
	}

	/** Launch a jump: full impulse, moving-platform velocity inherited, slot consumed. */
	private fireJump(isMoving: boolean, moveDirection: THREE.Vector3): void {
		this.verticalVelocity = Math.sqrt(this.physicsConfig.jumpHeight * -1.5 * this.physicsConfig.gravity);
		// Jumping off a moving platform inherits its velocity so the arc continues
		// with the surface the rider left (and a spinner can be escaped with a
		// plain jump instead of being swept along mid-air).
		this.jumpHorizontalVelocity.set(
			(isMoving ? moveDirection.x * this.currentSpeed : 0) + this.carryVelX,
			(isMoving ? moveDirection.z * this.currentSpeed : 0) + this.carryVelZ,
		);
		this.jumpCount++;
		this.canJump = false;
	}

	/** Yaw (rotation about world Y) extracted from a rigid-body quaternion. */
	private static yawOf(q: { x: number; y: number; z: number; w: number }): number {
		return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
	}

	/** Wrap an angle to [-π, π]. */
	private static wrapAngle(a: number): number {
		while (a > Math.PI) a -= Math.PI * 2;
		while (a < -Math.PI) a += Math.PI * 2;
		return a;
	}

	/**
	 * Gate gravity on/off. With a kinematicPositionBased body there is no
	 * gravityScale to zero, so callers that previously held the body in place
	 * until terrain was ready (to avoid falling through unloaded chunks) disable
	 * gravity here and re-enable it once the ground beneath is loaded.
	 */
	setGravityEnabled(enabled: boolean): void {
		this.gravityEnabled = enabled;
		if (!enabled) this.verticalVelocity = 0;
	}

	getPhysicsConfig(): typeof this.physicsConfig {
		return this.physicsConfig;
	}

	setPhysicsConfig(config: typeof this.physicsConfig): void {
		this.physicsConfig = config;
	}

	getMoveSpeed(): number {
		return this.moveSpeed;
	}

	setMoveSpeed(speed: number): void {
		this.moveSpeed = speed;
		this.acceleration = speed * 2;
	}

	/** Number of jumps used since the last ground contact. Resets to 0 on landing. */
	getJumpCount(): number {
		return this.jumpCount;
	}

	/**
	 * Get the current acceleration rate (m/s²)
	 */
	getAcceleration(): number {
		return this.acceleration;
	}

	/**
	 * Set the acceleration rate (m/s²).
	 * Controls how quickly the player reaches full moveSpeed from a standstill.
	 * Default is moveSpeed * 2 (reaches full speed in ~0.5s).
	 * Set to Infinity for instant full-speed movement (no walk-before-run).
	 * @param acceleration - Acceleration in m/s², or Infinity for instant
	 */
	setAcceleration(acceleration: number): void {
		this.acceleration = acceleration;
	}

	getMaxJumps(): number {
		return this.maxJumps;
	}

	setMaxJumps(maxJumps: number): void {
		this.maxJumps = maxJumps;
		if (this.jumpCount >= this.maxJumps) {
			this.jumpCount = 0;
		}
	}

	setGroundFriction(friction: number): void {
		this.physicsConfig.groundFriction = friction;
	}

	getGroundFriction(): number {
		return this.physicsConfig.groundFriction;
	}

	getAscendDisplayName(): string {
		return 'Jump';
	}

	getDescendDisplayName(): string {
		return 'Crouch';
	}

	getSupportedKeys(): { ascend: boolean; descend: boolean } {
		return {
			ascend: true,
			descend: false
		};
	}

	getKeyBehavior(): { ascend: 'tap' | 'continuous'; descend: 'tap' | 'continuous' } {
		return {
			ascend: 'tap',
			descend: 'tap'
		};
	}

	shouldShowPlayer(): boolean {
		return true;
	}

	setCameraLockRotation(enabled: boolean): void {
		this.cameraLockRotation = enabled;
	}

	/**
	 * Force the player's yaw to a fixed value (radians), or pass null to release.
	 * While locked, movement input and camera-lock cannot rotate the player —
	 * it strafes/moves freely but keeps facing the locked direction.
	 */
	setFacingLock(yaw: number | null): void {
		this.facingLock = yaw;
		if (yaw !== null) this.rotation = yaw;
	}

	getFacingLock(): number | null {
		return this.facingLock;
	}

	setCameraController(camera: { getHorizontalAngle: () => number } | null): void {
		this.cameraController = camera;
	}

	getCameraLockRotation(): boolean {
		return this.cameraLockRotation;
	}
}
