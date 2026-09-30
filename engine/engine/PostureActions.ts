/**
 * The two postures with MECHANICS attached — cover and ledge — plus the
 * one-shot posture actions (mantle, vault, get-up, slide).
 *
 * Every other posture is "swap the clip set + capsule + speed" and lives
 * entirely in PlayerPosture. These two need a little logic:
 *
 *  - COVER: while in cover, aiming/firing raises the character over the top
 *    (the peek) and releasing drops it back. That is one crossfade each way,
 *    driven by whoever knows the aim state (RangedWeaponSystem does, so it
 *    calls `setCoverPeek`; a game without guns can call it from a key).
 *
 *  - LEDGE: a ledge grab is a DETECTION — is there a wall right in front of me
 *    with a standable top within reach? — followed by a MANTLE that has to
 *    move the character up and over. The clip authors the travel; the engine
 *    commits it via applyRootMotion + onRootMotionDisplacement, moving the
 *    kinematic body along, and stands the character up on top at the end.
 *
 * Owned by PlayerController (one per player); nothing here runs per frame
 * unless a posture action is in flight.
 */
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { POSTURE_ACTIONS } from 'engine/AnimationPacks.js';
import { getRapier } from 'engine/physics/RapierPhysics.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import type { ICharacterAnimationController } from 'engine/ICharacterAnimationController.js';
import type { IPlayerMovement } from 'engine/IPlayerMovement.js';
import { AnimationState } from 'engine/animation/AnimationContext.js';
import { isPlaneLockedPhysics } from 'engine/physics/PlaneLockedPhysics.js';

export interface PostureActionHost {
	body: RAPIER.RigidBody | null;
	physicsWorld: PhysicsWorld;
	animationController: ICharacterAnimationController | null;
	/** Player's yaw (gameplay +Z-forward convention). */
	getYaw(): number;
	/** Capsule radius/height, for the ledge probes. */
	getCapsule(): { height: number; radius: number } | null;
	/** Enter/leave a posture — PlayerController.setPosture. */
	setPosture(p: string): boolean;
	getPosture(): string;
	/**
	 * Hold the body still: gravity off and the movement motor's per-frame
	 * write suppressed, so a hang or a mantle owns the capsule outright.
	 * Restored with `false` — nothing about a posture may leak past it.
	 */
	setBodyHeld(held: boolean): void;
}

/**
 * Assemble a host from PlayerController's handles. Lives here (not in the
 * controller) purely for the controller's max-lines budget; the body-hold
 * plumbing — gravity off and no stored fall speed while a posture action owns
 * the capsule — is posture business anyway.
 */
export function buildPostureActionHost(
	_owner: object,
	h: {
		body: RAPIER.RigidBody | null;
		physicsWorld: PhysicsWorld;
		animationController: ICharacterAnimationController | null;
		loader: { getCapsuleHeight(): number; getCapsuleRadius(): number } | null;
		movementSystem: IPlayerMovement;
		yaw: number;
		setPosture(p: string): boolean;
		getPosture(): string;
		setHeld(held: boolean): void;
	},
): PostureActionHost {
	return {
		body: h.body,
		physicsWorld: h.physicsWorld,
		animationController: h.animationController,
		getYaw: () => h.yaw,
		getCapsule: () => h.loader
			? { height: h.loader.getCapsuleHeight(), radius: h.loader.getCapsuleRadius() }
			: null,
		setPosture: h.setPosture,
		getPosture: h.getPosture,
		setBodyHeld: (held) => {
			h.setHeld(held);
			h.movementSystem.setGravityEnabled?.(!held);
			// No stored fall speed may survive a hold in either direction: a
			// hang must not start by continuing a fall, and landing on a ledge
			// must not resume one.
			h.movementSystem.resetVerticalVelocity?.();
		},
	};
}

/** Ledge probe result: where the top surface is and how high above the feet. */
export interface LedgeInfo {
	/** World Y of the ledge's standable top. */
	topY: number;
	/** World point on the top surface just past the edge, where the feet land. */
	landing: THREE.Vector3;
	/** How far above the feet the top is (m). */
	rise: number;
	/** Distance from the capsule CENTRE to the wall face along the facing (m). */
	wallDist: number;
}

/** A ledge is grabbable when its top is between these heights above the feet. */
export const LEDGE_MIN_RISE = 0.9;
export const LEDGE_MAX_RISE = 2.3;
/** A vaultable obstacle is lower than a ledge and thin enough to clear. */
export const VAULT_MAX_RISE = 1.2;
export const VAULT_MAX_DEPTH = 1.4;

export class PostureActions {
	private peeking = false;
	private actionInFlight = false;

	// ── Cover ────────────────────────────────────────────────────────────

	/**
	 * Raise over cover (true) or drop back behind it (false). Only meaningful
	 * while in the 'cover' posture; a no-op otherwise. RangedWeaponSystem
	 * calls this from its aim state, so a game gets peek-to-shoot for free by
	 * entering cover; games without guns can drive it from a key.
	 */
	setCoverPeek(peek: boolean, host: PostureActionHost): void {
		if (host.getPosture() !== 'cover' || peek === this.peeking) return;
		this.peeking = peek;
		// The peek is a POSTURE-LEVEL animation state ('coverPeek' in
		// POSTURE_MOVES): the resolver picks it over the cover hold, and the
		// posture retrigger crossfades both ways. NOT an IDLE override — the
		// resolver consults posture before overrides (so an override never
		// showed), and clearing the IDLE override deletes the character's
		// base idle under the Mixamo-only contract (measured: T-pose for the
		// rest of the session after leaving cover). The physical posture
		// (capsule/speed) stays 'cover' throughout — only the clip set moves.
		host.animationController?.setPosture?.(peek ? 'coverPeek' : 'cover');
	}

	/** Called by setPosture when leaving cover, so the peek can't outlive it. */
	onLeaveCover(): void {
		this.peeking = false;
	}

	isPeeking(): boolean { return this.peeking; }

	// ── Ledge ────────────────────────────────────────────────────────────

	/**
	 * Is there a grabbable ledge directly ahead? Two casts: forward at chest
	 * height to find a wall face, then down from above the wall to find its
	 * standable top. Returns null when there is no wall, the top is out of the
	 * grab band, or nothing standable is found.
	 */
	probeLedge(host: PostureActionHost, minRise = LEDGE_MIN_RISE, maxRise = LEDGE_MAX_RISE): LedgeInfo | null {
		const body = host.body;
		const cap = host.getCapsule();
		if (!body || !cap) return null;
		// The probes below are 3D rays against the raw Rapier world; the 2D lane
		// has no ledges to grab in its plane and no rapier3d in its bundle.
		if (isPlaneLockedPhysics(host.physicsWorld)) return null;
		const RAPIER = getRapier();
		const world = host.physicsWorld.getRapierWorld();
		const t = body.translation();
		const feetY = t.y - Math.max(cap.height / 2, cap.radius);
		const yaw = host.getYaw();
		const fx = Math.sin(yaw), fz = Math.cos(yaw);

		// 1) Wall ahead. Probed just under the LOWEST grabbable top, so an
		//    obstacle whose top is at minRise is still hit — a chest-height
		//    probe passed clean over every vault-height rail (measured: the
		//    0.5-1.05 m band was undetectable).
		const probeY = feetY + Math.max(0.25, minRise - 0.15);
		const wallHit = world.castRay(
			new RAPIER.Ray({ x: t.x, y: probeY, z: t.z }, { x: fx, y: 0, z: fz }),
			cap.radius + 0.6, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, body,
		);
		if (!wallHit) return null;
		const wallDist = wallHit.timeOfImpact;

		// 2) Standable top: cast down from above the max grab height, JUST past
		//    the wall face — far enough to miss the lip, near enough that a thin
		//    rail still catches the ray (a 45 cm offset fell behind every rail).
		const over = wallDist + 0.08;
		const from = { x: t.x + fx * over, y: feetY + maxRise + 0.5, z: t.z + fz * over };
		const topHit = world.castRay(
			new RAPIER.Ray(from, { x: 0, y: -1, z: 0 }),
			maxRise + 0.5 - minRise, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, body,
		);
		if (!topHit) return null;
		const topY = from.y - topHit.timeOfImpact;
		const rise = topY - feetY;
		if (rise < minRise || rise > maxRise) return null;

		// 3) Headroom on top: room to stand where we would land.
		const standProbe = world.castRay(
			new RAPIER.Ray({ x: from.x, y: topY + 0.1, z: from.z }, { x: 0, y: 1, z: 0 }),
			cap.height, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, body,
		);
		if (standProbe) return null;

		// Land the FEET a capsule-radius past the edge, on the top surface.
		const landOver = wallDist + cap.radius + 0.15;
		return {
			topY, rise, wallDist,
			landing: new THREE.Vector3(t.x + fx * landOver, topY, t.z + fz * landOver),
		};
	}

	/**
	 * Grab the ledge ahead (if any) and hang. Returns whether a ledge was
	 * grabbed. The hang is a posture; `mantle` finishes it.
	 */
	tryGrabLedge(host: PostureActionHost): boolean {
		if (this.actionInFlight) return false;
		const ledge = this.probeLedge(host);
		if (!ledge) return false;
		const body = host.body!;
		const cap = host.getCapsule()!;
		const t = body.translation();
		const halfExtent = Math.max(cap.height / 2, cap.radius);
		const feetY = t.y - halfExtent;
		// A hang needs the body to fit BELOW the ledge: capsule top just under
		// the lip, bottom above the current floor. Below that rise there is no
		// room to hang — go straight over instead.
		if (ledge.rise < cap.height + 0.1) return this.mantle(host);

		// Posture FIRST (a capsule resize rebases the body), placement second.
		host.setPosture('ledgeHang');
		host.setBodyHeld(true);
		const yaw = host.getYaw();
		const fx = Math.sin(yaw), fz = Math.cos(yaw);
		// Capsule surface a hair off the wall face — wallDist is centre→face.
		const centreFromWall = cap.radius + 0.05;
		const back = ledge.wallDist - centreFromWall;
		const y = Math.max(ledge.topY - halfExtent - 0.05, feetY + halfExtent);
		body.setTranslation({ x: t.x + fx * back, y, z: t.z + fz * back }, true);
		return true;
	}

	/**
	 * Mantle up from a hang (or straight from the ground when a ledge is
	 * ahead): plays the mantle one-shot, commits its root travel to the body
	 * frame by frame, and stands the character on top at the end. Returns
	 * whether a mantle started.
	 */
	mantle(host: PostureActionHost): boolean {
		if (this.actionInFlight) return false;
		const ledge = this.probeLedge(host);
		if (!ledge) return false;
		const ac = host.animationController;
		const body = host.body;
		if (!ac?.playCustomAnimation || !body) return false;

		const cap = host.getCapsule()!;
		const halfExtent = Math.max(cap.height / 2, cap.radius);
		if (host.getPosture() !== 'ledgeHang') host.setPosture('ledgeHang');
		this.actionInFlight = true;
		host.setBodyHeld(true);
		const start = body.translation();
		const startY = start.y;
		const targetTop = ledge.topY + halfExtent;
		const finish = (): void => {
			// Land squarely on the ledge; posture first, then place.
			this.actionInFlight = false;
			host.setBodyHeld(false);
			if (!host.setPosture('stand')) host.setPosture('crouch');
			body.setTranslation({ x: ledge.landing.x, y: targetTop + 0.02, z: ledge.landing.z }, true);
		};
		const result = ac.playCustomAnimation(POSTURE_ACTIONS.ledgeMantle, {
			applyRootMotion: true,
			onRootMotionDisplacement: (d: THREE.Vector3) => {
				// The engine delivers WORLD-space XZ per-frame displacement in
				// metres with Y hard-zeroed (RootMotion.ts) — so XZ is applied
				// as-is, and the RISE is driven from clip progress against the
				// real ledge height, since the clip's own Y never arrives.
				const t = body.nextTranslation();
				const progress = Math.min(1, ac.getCustomAnimationProgress?.() ?? 0);
				const y = startY + (targetTop - startY) * progress;
				body.setTranslation({ x: t.x + d.x, y, z: t.z + d.z }, true);
			},
			onFinished: finish,
		});
		if (!result?.success) {
			this.actionInFlight = false;
			host.setBodyHeld(false);
			host.setPosture('stand');
			return false;
		}
		// Interruption watchdog: another custom clip (a fire animation, a
		// melee swing) stops this one WITHOUT its onFinished ever firing, which
		// would leave the body held and every action refused. Land anyway
		// once the clip's duration has elapsed.
		this.armWatchdog(result.duration, finish);
		return true;
	}

	private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
	private armWatchdog(durationSeconds: number, finish: () => void): void {
		if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
		this.watchdogTimer = setTimeout(() => {
			this.watchdogTimer = null;
			if (this.actionInFlight) finish();
		}, Math.max(50, durationSeconds * 1000 + 100));
	}

	/**
	 * Vault the low obstacle ahead if there is one (waist-high, thin). Plays
	 * the vault one-shot and commits its arc + forward travel. Returns whether
	 * a vault started.
	 */
	vault(host: PostureActionHost): boolean {
		if (this.actionInFlight) return false;
		const ledge = this.probeLedge(host, 0.5, VAULT_MAX_RISE);
		if (!ledge) return false;
		// Must be THIN: a floor past the far edge within VAULT_MAX_DEPTH.
		const body = host.body!;
		const cap = host.getCapsule()!;
		const RAPIER = getRapier();
		const world = host.physicsWorld.getRapierWorld();
		const yaw = host.getYaw();
		const fx = Math.sin(yaw), fz = Math.cos(yaw);
		const t = body.translation();
		const feetY = t.y - Math.max(cap.height / 2, cap.radius);
		const beyond = { x: ledge.landing.x + fx * VAULT_MAX_DEPTH, y: ledge.topY + 0.3, z: ledge.landing.z + fz * VAULT_MAX_DEPTH };
		const floorHit = world.castRay(
			new RAPIER.Ray(beyond, { x: 0, y: -1, z: 0 }),
			ledge.rise + 1.0, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, body,
		);
		if (!floorHit) return false;
		const landY = beyond.y - floorHit.timeOfImpact;
		if (landY > feetY + 0.6) return false; // not thin — that's a ledge, mantle it

		const ac = host.animationController;
		if (!ac?.playCustomAnimation) return false;
		this.actionInFlight = true;
		host.setBodyHeld(true);
		const halfExtent = Math.max(cap.height / 2, cap.radius);
		const startY = t.y;
		const apexY = ledge.topY + halfExtent + 0.15;
		const finish = (): void => {
			this.actionInFlight = false;
			host.setBodyHeld(false);
			body.setTranslation({ x: beyond.x, y: landY + halfExtent + 0.02, z: beyond.z }, true);
		};
		const result = ac.playCustomAnimation(POSTURE_ACTIONS.vault, {
			applyRootMotion: true,
			onRootMotionDisplacement: (d: THREE.Vector3) => {
				// World-space XZ delta (see mantle); the arc is driven from
				// clip progress: up to the apex over the obstacle, then down.
				const p = body.nextTranslation();
				const u = Math.min(1, ac.getCustomAnimationProgress?.() ?? 0);
				const y = startY + (apexY - startY) * Math.sin(Math.PI * u);
				body.setTranslation({ x: p.x + d.x, y, z: p.z + d.z }, true);
			},
			onFinished: finish,
		});
		if (!result?.success) { this.actionInFlight = false; host.setBodyHeld(false); return false; }
		this.armWatchdog(result.duration, finish);
		return true;
	}

	/** Knockdown recovery: play GetUp from a supine/sleep posture, then stand. */
	getUp(host: PostureActionHost): boolean {
		if (this.actionInFlight) return false;
		const ac = host.animationController;
		if (!ac?.playCustomAnimation) return false;
		this.actionInFlight = true;
		const result = ac.playCustomAnimation(POSTURE_ACTIONS.getUp, {
			onFinished: () => {
				this.actionInFlight = false;
				host.setPosture('stand');
			},
		});
		if (!result?.success) { this.actionInFlight = false; return false; }
		return true;
	}

	/** Knee slide one-shot; the movement system keeps carrying the body. */
	slide(host: PostureActionHost): boolean {
		if (this.actionInFlight) return false;
		const ac = host.animationController;
		if (!ac?.playCustomAnimation) return false;
		this.actionInFlight = true;
		const result = ac.playCustomAnimation(POSTURE_ACTIONS.slide, {
			onFinished: () => { this.actionInFlight = false; },
		});
		if (!result?.success) { this.actionInFlight = false; return false; }
		return true;
	}

	isBusy(): boolean { return this.actionInFlight; }
}
