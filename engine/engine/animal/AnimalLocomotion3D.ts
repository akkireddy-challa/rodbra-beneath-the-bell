import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { QUERY_EXCLUDE_SENSORS } from 'engine/physics/QueryFilter.js';
import type { IPlayerMovement } from 'engine/IPlayerMovement.js';
import type { PlayerController } from 'engine/PlayerController.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';

/**
 * Options for free-volume (3D) creature movement.
 */
export interface Animal3DMovementOptions {
    /** Vertical speed cap as a fraction of horizontal moveSpeed (fish/birds climb slower than they cruise). */
    verticalSpeedRatio: number;
    /** Yaw turn rate limit in rad/s — lower values give wide, banked turns. */
    turnRate: number;
    /** Acceleration toward the desired velocity in m/s². */
    acceleration: number;
    /** Per-second velocity retention when there is no input (0.2 = lose 80% per second). */
    drag: number;
    /**
     * Gravity (m/s², negative) applied when OUT of the medium — a beached fish
     * sinks to the ground, a bird with flight disabled descends.
     */
    outOfMediumGravity: number;
    /** Terminal fall speed (m/s, positive) while out of medium. */
    outOfMediumTerminalVelocity: number;
}

/** Fish presets: tight turns, modest climb rate, sinks when beached. */
export const DEFAULT_SWIM_MOVEMENT_OPTIONS: Animal3DMovementOptions = {
    verticalSpeedRatio: 0.6,
    turnRate: 2.6,
    acceleration: 10.0,
    drag: 0.15,
    outOfMediumGravity: -20.0,
    outOfMediumTerminalVelocity: 10.0,
};

/** Bird presets: wide banked turns, strong climb, normal gravity when grounded. */
export const DEFAULT_FLIGHT_MOVEMENT_OPTIONS: Animal3DMovementOptions = {
    verticalSpeedRatio: 0.8,
    turnRate: 1.8,
    acceleration: 8.0,
    drag: 0.3,
    outOfMediumGravity: -25.0,
    outOfMediumTerminalVelocity: 20.0,
};

/**
 * Free-volume kinematic movement for swimming and flying creatures.
 *
 * Drop-in replacement for WalkingAndJumpingMovement in
 * AnimalController.runMovementSystem: same IPlayerMovement contract, but the
 * moveDirection's Y component is honored — the creature moves through a 3D
 * volume instead of along the ground.
 *
 * Like all characters, the body is kinematicPositionBased and driven through
 * the shared Rapier KinematicCharacterController (collide-and-slide), applied
 * with setNextKinematicTranslation and the same pending-target accumulation as
 * WalkingAndJumpingMovement (see that file for the 60 Hz substep rationale).
 *
 * `setInMedium(false)` switches to ballistic falling — the controller calls it
 * each frame from its medium sensor (fish out of water, flight disabled).
 */
export class Animal3DMovement implements IPlayerMovement {
    private moveSpeed: number;
    private readonly options: Animal3DMovementOptions;

    private velocity = new THREE.Vector3();
    private rotation = 0;
    private currentSpeed = 0;
    private inMedium = true;
    private fallVelocity = 0;
    private lastGroundedState = false;

    // Kinematic target tracking (see WalkingAndJumpingMovement for why):
    // physics steps at a fixed 60 Hz but this motor runs per render frame, so
    // queued movement must accumulate instead of being recomputed from an
    // unchanged body translation.
    private pendingFrom: THREE.Vector3 | null = null;
    private pendingTarget: THREE.Vector3 | null = null;

    constructor(moveSpeed: number, options: Animal3DMovementOptions) {
        this.moveSpeed = moveSpeed;
        this.options = options;
    }

    /**
     * Whether the creature is currently inside its medium (water for fish,
     * open air for birds). Outside the medium, movement input is ignored and
     * gravity takes over.
     */
    setInMedium(inMedium: boolean): void {
        if (inMedium && !this.inMedium) this.fallVelocity = 0;
        this.inMedium = inMedium;
    }

    isInMedium(): boolean {
        return this.inMedium;
    }

    update(
        deltaTime: number,
        playerController: PlayerController,
        _keys: { forward: boolean; backward: boolean; left: boolean; right: boolean; ascend: boolean; interact: boolean; action: boolean; secondaryAction?: boolean; descend: boolean },
        _isGrounded: boolean,
        moveDirection: THREE.Vector3,
        playerBody: RAPIER.RigidBody,
        physicsWorld: PhysicsWorld
    ): void {
        if (!playerBody) return; // body may be freed/nulled (e.g. dead NPC still updating)
        if (deltaTime <= 0) return;
        const collider = playerBody.numColliders() > 0 ? playerBody.collider(0) : null;
        if (!collider) return;

        const hasInput = moveDirection.lengthSq() > 1e-6;

        if (this.inMedium) {
            // ── Desired velocity: full 3D, vertical component capped ──
            const desired = new THREE.Vector3();
            if (hasInput) {
                desired.copy(moveDirection).normalize();
                desired.y = THREE.MathUtils.clamp(desired.y, -this.options.verticalSpeedRatio, this.options.verticalSpeedRatio);
                desired.multiplyScalar(this.moveSpeed);
            }

            // Accelerate toward the desired velocity (water/air feel: gradual)
            const maxDelta = this.options.acceleration * deltaTime;
            const deltaV = desired.sub(this.velocity);
            if (deltaV.length() > maxDelta) deltaV.setLength(maxDelta);
            this.velocity.add(deltaV);

            // Drag when coasting
            if (!hasInput) {
                const retention = Math.pow(this.options.drag, deltaTime);
                this.velocity.multiplyScalar(retention);
                if (this.velocity.lengthSq() < 1e-4) this.velocity.set(0, 0, 0);
            }

            // ── Yaw: smooth-turn toward the horizontal heading ──
            if (hasInput && (moveDirection.x !== 0 || moveDirection.z !== 0)) {
                const targetRotation = Math.atan2(moveDirection.x, moveDirection.z);
                let diff = targetRotation - this.rotation;
                if (diff > Math.PI) diff -= Math.PI * 2;
                if (diff < -Math.PI) diff += Math.PI * 2;
                const maxTurn = this.options.turnRate * deltaTime;
                this.rotation += THREE.MathUtils.clamp(diff, -maxTurn, maxTurn);
                if (this.rotation > Math.PI) this.rotation -= Math.PI * 2;
                if (this.rotation < -Math.PI) this.rotation += Math.PI * 2;
            }
            if (playerController.player) {
                playerController.player.rotation.y = this.rotation;
            }
        } else if (this.lastGroundedState) {
            // ── Out of medium, grounded (e.g. a beached fish) ──
            // Allow slow horizontal "flopping" toward the input direction so the
            // controller can steer it back to water instead of soft-locking;
            // reset fall velocity so it doesn't pre-charge to terminal while
            // resting (which would teleport-drop it off any ledge).
            const horiz = Math.hypot(moveDirection.x, moveDirection.z);
            if (hasInput && horiz > 1e-6) {
                const flopSpeed = this.moveSpeed * 0.3;
                const maxDelta = this.options.acceleration * deltaTime;
                const tx = (moveDirection.x / horiz) * flopSpeed;
                const tz = (moveDirection.z / horiz) * flopSpeed;
                this.velocity.x += THREE.MathUtils.clamp(tx - this.velocity.x, -maxDelta, maxDelta);
                this.velocity.z += THREE.MathUtils.clamp(tz - this.velocity.z, -maxDelta, maxDelta);
            } else {
                this.velocity.x *= Math.pow(0.05, deltaTime);
                this.velocity.z *= Math.pow(0.05, deltaTime);
            }
            this.fallVelocity = 0;
            this.velocity.y = 0;
        } else {
            // ── Out of medium, airborne: ballistic — horizontal dies, gravity pulls ──
            this.velocity.x *= Math.pow(0.05, deltaTime);
            this.velocity.z *= Math.pow(0.05, deltaTime);
            this.fallVelocity += this.options.outOfMediumGravity * deltaTime;
            if (this.fallVelocity < -this.options.outOfMediumTerminalVelocity) {
                this.fallVelocity = -this.options.outOfMediumTerminalVelocity;
            }
            this.velocity.y = this.fallVelocity;
        }

        this.currentSpeed = this.velocity.length();

        // ── Collide-and-slide via the shared KinematicCharacterController ──
        const desiredMove = {
            x: this.velocity.x * deltaTime,
            y: this.velocity.y * deltaTime,
            z: this.velocity.z * deltaTime,
        };
        const controller = physicsWorld.getCharacterController();
        controller.computeColliderMovement(
            collider,
            desiredMove,
            QUERY_EXCLUDE_SENSORS, // lane-agnostic: no rapier3d value read (2D bundles stub it)
            collider.collisionGroups(),
            (other) => other.handle !== collider.handle,
        );
        const mv = controller.computedMovement();
        this.lastGroundedState = controller.computedGrounded();

        // Apply EXACTLY via setNextKinematicTranslation, continuing from a
        // still-pending target when no physics substep ran this frame.
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

        // Velocity that was blocked by geometry should not accumulate — adopt
        // the clamped result so the creature slides along walls instead of
        // grinding into them.
        if (deltaTime > 0) {
            const appliedVx = mv.x / deltaTime;
            const appliedVy = mv.y / deltaTime;
            const appliedVz = mv.z / deltaTime;
            // Only adopt when meaningfully clamped (avoid jitter from tiny solver noise)
            if (Math.abs(appliedVx - this.velocity.x) > 0.5) this.velocity.x = appliedVx;
            if (Math.abs(appliedVy - this.velocity.y) > 0.5) this.velocity.y = appliedVy;
            if (Math.abs(appliedVz - this.velocity.z) > 0.5) this.velocity.z = appliedVz;
        }
    }

    getCurrentSpeed(): number {
        return this.currentSpeed;
    }

    isInAir(): boolean {
        return !this.lastGroundedState;
    }

    wasGroundedLastUpdate(): boolean {
        return this.lastGroundedState;
    }

    getRotation(): number {
        return this.rotation;
    }

    setRotation(rotation: number): void {
        this.rotation = rotation;
    }

    /** Current 3D velocity (read-only copy). */
    getVelocity(): THREE.Vector3 {
        return this.velocity.clone();
    }

    reset(): void {
        this.velocity.set(0, 0, 0);
        this.currentSpeed = 0;
        this.fallVelocity = 0;
        this.pendingFrom = null;
        this.pendingTarget = null;
        this.lastGroundedState = false;
    }

    getMoveSpeed(): number {
        return this.moveSpeed;
    }

    setMoveSpeed(speed: number): void {
        this.moveSpeed = speed;
    }

    getAscendDisplayName(): string {
        return 'Ascend';
    }

    getDescendDisplayName(): string {
        return 'Descend';
    }

    getSupportedKeys(): { ascend: boolean; descend: boolean } {
        return { ascend: true, descend: true };
    }

    getKeyBehavior(): { ascend: 'tap' | 'continuous'; descend: 'tap' | 'continuous' } {
        return { ascend: 'continuous', descend: 'continuous' };
    }

    shouldShowPlayer(): boolean {
        return true;
    }
}
