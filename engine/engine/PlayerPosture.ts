/**
 * The physical half of a body posture — what PlayerController.setPosture
 * does besides swapping animation clips.
 *
 * A posture changes three things at once, and they have to change together:
 * the ANIMATION set (hold + move clips, owned by CharacterAnimationController's
 * posture axis), the physics CAPSULE (a crouched player must fit under a low
 * ceiling; that is what makes a crouch a mechanic and not a costume), and the
 * MOVE SPEED (a crawl at run speed is a glitch). Split out of PlayerController
 * for size; PlayerController owns the entry point and hands in its handles.
 */
import type RAPIER from '@dimforge/rapier3d-compat';
import { POSTURE_ANIMATIONS, type Posture } from 'engine/AnimationPacks.js';
import { getRapier } from 'engine/physics/RapierPhysics.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import type { IPlayerMovement } from 'engine/IPlayerMovement.js';
import type { ICharacterAnimationController } from 'engine/ICharacterAnimationController.js';
import { isPlaneLockedPhysics } from 'engine/physics/PlaneLockedPhysics.js';

/** The PlayerController handles a posture change touches. */
export interface PostureHost {
	body: RAPIER.RigidBody | null;
	loader: { getCapsuleHeight(): number; getCapsuleRadius(): number; setCapsuleDimensions(h: number, r: number): void } | null;
	physicsWorld: PhysicsWorld;
	movementSystem: IPlayerMovement;
	animationController: ICharacterAnimationController | null;
}

/**
 * How much of the standing height each posture keeps for its physics
 * capsule, and how fast it may move (fraction of standing move speed). The
 * visual is the animation clip; THIS is what lets a crouched player fit under
 * a low ceiling and stops a crawl from moving at run speed.
 */
export const POSTURE_PHYSICS: Record<Posture, { height: number; speed: number }> = {
	stand: { height: 1.0, speed: 1.0 },
	crouch: { height: 0.62, speed: 0.45 },
	prone: { height: 0.36, speed: 0.22 },
	sit: { height: 0.62, speed: 0 },
	kneel: { height: 0.62, speed: 0 },
	swim: { height: 1.0, speed: 1.0 },   // SwimmingMovement owns speed
	climb: { height: 1.0, speed: 0.4 },
	supine: { height: 0.36, speed: 0 },
	sleep: { height: 0.36, speed: 0 },
	floorSit: { height: 0.5, speed: 0 },
	lean: { height: 1.0, speed: 0 },
	cover: { height: 0.62, speed: 0.45 },
	coverPeek: { height: 0.62, speed: 0.45 },   // animation-only variant of cover
	ledgeHang: { height: 1.0, speed: 0 },   // the ledge system owns position
	push: { height: 1.0, speed: 0.4 },
	carry: { height: 1.0, speed: 0.75 },
	ride: { height: 1.0, speed: 1.0 },       // the mount owns speed
};

export class PlayerPosture {
	current: Posture = 'stand';

	/**
	 * The captured standing speed belongs to ONE movement system; when the
	 * controller swaps systems it must be forgotten, or the next posture would
	 * restore the previous system's speed onto the new one.
	 */
	onMovementSystemChanged(): void { this.standingMoveSpeed = null; }
	private packLoaded = false;
	private packLoading = false;
	/** Standing move speed, restored when the posture ends. */
	private standingMoveSpeed: number | null = null;
	/** Standing capsule height (m), restored when the posture ends. */
	private standingCapsuleHeight: number | null = null;

	/**
	 * Apply a posture. Returns whether the posture is now the requested one —
	 * false only when standing up was refused for lack of headroom.
	 */
	set(posture: Posture, host: PostureHost): boolean {
		if (posture === this.current) return true;
		if (posture === 'stand' && !this.hasStandingHeadroom(host)) return false;

		void this.ensurePack(host.animationController);

		const physics = POSTURE_PHYSICS[posture];
		const ms = host.movementSystem;
		// Speed: postures at full speed (stand / swim / ride) leave the movement
		// system's own speed ALONE — a SwimmingMovement or a mount owns it, and
		// capturing "standing speed" from whichever system happened to be
		// current then imposing it on the walker permanently slowed walking to
		// the swim speed (measured). Only slowed postures scale, from a
		// standing speed captured while actually standing.
		if (physics.speed >= 1) {
			if (this.standingMoveSpeed !== null) ms.setMoveSpeed(this.standingMoveSpeed);
			this.standingMoveSpeed = null;
		} else {
			if (this.standingMoveSpeed === null) this.standingMoveSpeed = ms.getMoveSpeed();
			ms.setMoveSpeed(this.standingMoveSpeed * physics.speed);
		}
		this.applyCapsule(physics.height, host);

		this.current = posture;
		host.animationController?.setPosture?.(posture);
		return true;
	}

	/**
	 * Resize the capsule to `fraction` of standing height, keeping the FEET
	 * where they are: the capsule centre moves down by half the removed
	 * height. Rapier lets a capsule change its half-height in place, so no
	 * collider is recreated and nothing downstream (registries, filters,
	 * projectile ownership) has to be re-wired.
	 */
	private applyCapsule(fraction: number, host: PostureHost): void {
		const { loader, body } = host;
		if (!loader || !body || body.numColliders() === 0) return;
		if (this.standingCapsuleHeight === null) this.standingCapsuleHeight = loader.getCapsuleHeight();
		const standing = this.standingCapsuleHeight;
		const radius = loader.getCapsuleRadius();
		const newHeight = Math.max(2 * radius + 0.05, standing * fraction);
		const oldHeight = loader.getCapsuleHeight();
		if (Math.abs(newHeight - oldHeight) < 1e-4) return;

		const collider = body.collider(0);
		collider.setHalfHeight(Math.max(0, (newHeight - 2 * radius) / 2));

		// capsuleHalfExtent = max(height/2, radius) — the same rule
		// CharacterLoader uses to place the character group at the capsule
		// bottom, so the feet do not move when the centre does.
		const oldExtent = Math.max(oldHeight / 2, radius);
		const newExtent = Math.max(newHeight / 2, radius);
		// Rebase from the QUEUED pose, so a placement made earlier this frame
		// (a hang, a landing) is preserved rather than overwritten.
		const t = body.nextTranslation();
		const y = t.y - (oldExtent - newExtent);
		body.setTranslation({ x: t.x, y, z: t.z }, true);
		loader.setCapsuleDimensions(newHeight, radius);
	}

	/**
	 * Is there room to stand? Casts a ray straight up from the feet through
	 * the standing height (plus a small margin), ignoring the player's own
	 * body and sensors. Un-crouching into a ceiling would embed the capsule.
	 */
	private hasStandingHeadroom(host: PostureHost): boolean {
		const { loader, body } = host;
		if (!loader || !body || this.standingCapsuleHeight === null) return true;
		// 2D lane: the raw-world 3D ray below does not exist there; standing up
		// is always allowed (side-on levels have no crawl spaces yet).
		if (isPlaneLockedPhysics(host.physicsWorld)) return true;
		const RAPIER = getRapier();
		const t = body.translation();
		const radius = loader.getCapsuleRadius();
		const feetY = t.y - Math.max(loader.getCapsuleHeight() / 2, radius);
		const ray = new RAPIER.Ray({ x: t.x, y: feetY + 0.05, z: t.z }, { x: 0, y: 1, z: 0 });
		const hit = host.physicsWorld.getRapierWorld().castRay(
			ray,
			this.standingCapsuleHeight + 0.05,
			true,
			RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
			undefined,
			undefined,
			body,
		);
		return hit === null;
	}

	/** Load the posture clip pack once, on first use. */
	private async ensurePack(ac: ICharacterAnimationController | null): Promise<void> {
		if (this.packLoaded || this.packLoading || !ac?.loadAnimationPack) return;
		this.packLoading = true;
		try {
			await ac.loadAnimationPack(POSTURE_ANIMATIONS, { addToAttackCollection: false, replaceLocomotion: false });
			this.packLoaded = true;
		} catch (error) {
			console.warn('[PlayerPosture] failed to load posture animation pack:', error);
		} finally {
			this.packLoading = false;
		}
	}
}
