import type * as THREE from 'three';
import type { PlayerController } from 'engine/PlayerController.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import type RAPIER from '@dimforge/rapier3d-compat';

/**
 * The per-frame input state passed to {@link IPlayerMovement.update}. This is the
 * shared `keys` shape produced by the keyboard (and synthesized for AI riders),
 * factored out so movement systems reference one type instead of re-declaring it.
 */
export interface PlayerMovementKeys {
	forward: boolean;
	backward: boolean;
	left: boolean;
	right: boolean;
	ascend: boolean;
	interact: boolean;
	action: boolean;
	secondaryAction?: boolean;
	descend: boolean;
}

/**
 * The walking physics tuning read and replaced through
 * {@link IPlayerMovement.getPhysicsConfig} / {@link IPlayerMovement.setPhysicsConfig}.
 * Structurally identical to `WalkingAndJumpingMovement`'s own config, so the two
 * stay interchangeable without importing across the interface boundary.
 */
export interface PlayerPhysicsConfig {
	gravity: number;
	terminalVelocity: number;
	jumpHeight: number;
	airControlMultiplier: number;
	groundFriction: number;
	airFriction: number;
}

/**
 * Interface for pluggable player movement systems
 * Allows different movement behaviors (walking, swimming, flying, etc.)
 */
export interface IPlayerMovement {
	/**
	 * Update the movement state based on player input and physics
	 * @param deltaTime - Time since last frame in seconds
	 * @param playerController - Reference to the player controller for accessing state
	 * @param keys - Current key state
	 * @param isGrounded - Whether the player is on the ground
	 * @param moveDirection - The calculated movement direction
	 * @param playerBody - Physics body reference
	 * @param physicsWorld - Physics world reference
	 */
	update(
		deltaTime: number,
		playerController: PlayerController,
		keys: PlayerMovementKeys,
		isGrounded: boolean,
		moveDirection: THREE.Vector3,
		playerBody: RAPIER.RigidBody,
		physicsWorld: PhysicsWorld
	): void;

	/**
	 * Get the current speed for animation purposes
	 */
	getCurrentSpeed(): number;

	/**
	 * Check if the movement system is currently in an "in-air" state
	 * Used for animation coordination
	 */
	isInAir(): boolean;

	/**
	 * Get the rotation angle for the player based on movement
	 */
	getRotation(): number;

	/**
	 * Reset the movement state (called on respawn, etc.)
	 */
	reset(): void;

	/**
	 * Get the display name for the ascend action (e.g., "Jump", "Ascend", "Swim Up")
	 * Used by mobile controls to show appropriate button labels
	 */
	getAscendDisplayName(): string;

	/**
	 * Get the display name for the descend action (e.g., "Crouch", "Descend", "Dive")
	 * Used by mobile controls to show appropriate button labels
	 */
	getDescendDisplayName(): string;

	/**
	 * Get which keys/actions are supported by this movement system
	 * Used by mobile controls to show/hide buttons appropriately
	 * @returns Object with boolean flags for each supported key
	 */
	getSupportedKeys(): {
		ascend: boolean;
		descend: boolean;
	};

	/**
	 * Get the input behavior for each key
	 * - 'tap': Single press/release (e.g., jump)
	 * - 'continuous': Hold for continuous effect (e.g., fly up while holding)
	 * Used by mobile controls to configure button behavior
	 */
	getKeyBehavior(): {
		ascend: 'tap' | 'continuous';
		descend: 'tap' | 'continuous';
	};

	/**
	 * Check if the player model should be visible during this movement mode
	 * @returns true if player should be visible, false if hidden (e.g., inside vehicle)
	 */
	shouldShowPlayer(): boolean;

	/**
	 * Optional: Return true if this movement system handles player position syncing itself.
	 * When true, the template should NOT run syncPlayerPhysics() as it would overwrite
	 * the position set by the movement system, causing visual twitching.
	 * Used by ski and vehicle movement systems.
	 */
	handlesPlayerPositionSync?(): boolean;

	/**
	 * Optional: Set the ground friction dynamically based on terrain
	 * Movement systems that support terrain-based friction should implement this
	 * @param friction - The friction multiplier (0.0 = sliding/ice, 1.0 = max friction)
	 */
	setGroundFriction?(friction: number): void;

	/**
	 * Optional: Get the grounded state from the last update
	 * Movement systems that perform their own ground checks should implement this
	 */
	wasGroundedLastUpdate?(): boolean;

	/**
	 * Optional: Lock player rotation to camera direction (for ranged weapons)
	 * When enabled, player always faces where the camera is pointing
	 * @param enabled - Whether camera-locked rotation is enabled
	 */
	setCameraLockRotation?(enabled: boolean): void;

	/**
	 * Optional: Set the camera controller reference for camera-locked rotation
	 * Required when setCameraLockRotation is enabled
	 * @param camera - Reference to the camera controller (must have getHorizontalAngle method)
	 */
	setCameraController?(camera: { getHorizontalAngle: () => number } | null): void;

	/**
	 * Optional: Directly set the movement yaw (radians, gameplay +Z-forward convention).
	 * Used by cursor-aim weapons and teleports to drive player facing.
	 */
	setRotation?(rotation: number): void;

	/**
	 * Optional: Force the player's yaw to a fixed value (radians), or null to release.
	 * While locked, neither movement input nor camera-lock can rotate the player —
	 * it still moves/strafes but keeps facing the locked direction. For orchestrated
	 * modes (e.g. a goalie that slides sideways but always faces the field).
	 */
	setFacingLock?(yaw: number | null): void;

	/**
	 * Optional: Read/replace the walking physics tuning (gravity, jumpHeight, friction, …).
	 * Implemented by ground movement systems; used by the movement-contract re-assert.
	 */
	getPhysicsConfig?(): PlayerPhysicsConfig;
	setPhysicsConfig?(config: PlayerPhysicsConfig): void;

	/**
	 * Get the current movement speed
	 * @returns The movement speed in units per second
	 */
	getMoveSpeed(): number;

	/**
	 * Set the movement speed
	 * @param speed - The movement speed in units per second
	 */
	setMoveSpeed(speed: number): void;

	/**
	 * Optional: Check if locomotion animations (walk/run/idle) should play
	 * Movement systems like skiing should return false to disable walking animations
	 * @returns true if locomotion animations should play (default), false to skip them
	 */
	shouldPlayLocomotionAnimation?(): boolean;

	/**
	 * Optional: The character's horizontal speed (m/s) RELATIVE TO THE GROUND IT
	 * STANDS ON — world speed minus the velocity imparted by a moving platform
	 * being ridden. Locomotion animation must judge movement in this frame: a
	 * carried body has world velocity but is standing still, and must not step
	 * in place. Preferred over the body's linvel(), whose kinematic substep
	 * accounting also diverges from per-render-frame motion at non-60Hz rates.
	 */
	getGroundRelativeSpeed?(): number;

	/**
	 * Optional: The collision-clamped kinematic target integrated per RENDER
	 * frame. The body itself only advances on fixed 60Hz physics substeps, so a
	 * visual synced from `body.translation()` stalls on 0-substep frames and
	 * double-jumps after catch-up frames — motion judder at a steady 60 fps.
	 * Controllers sync the visual from this instead. Consumers must sanity-clamp
	 * against the body position (see resolveRenderSyncPosition) so teleports and
	 * respawns while movement updates were idle still snap to the body.
	 */
	getRenderPosition?(): THREE.Vector3 | null;

	/**
	 * Optional: Impulse-like velocity change (knockback from hazards/explosions/
	 * enemy hits). The player body is kinematic — setLinvel/applyImpulse on it are
	 * silent no-ops; game code must use this (via PlayerController.applyKnockback).
	 */
	applyImpulse?(velocity: { x: number; y?: number; z: number }): void;

	/**
	 * Optional: Return true if this movement system sets the visible body's full
	 * rotation itself (e.g. ski lean + sideways stance written to player.quaternion).
	 * When true, an orchestrating controller (NpcController) must NOT also apply
	 * `getRotation()` as a yaw-only facing — doing so would drop the lean/pitch.
	 */
	controlsBodyRotation?(): boolean;

	/**
	 * Optional: Number of jumps used since last ground contact. Used by templates
	 * (or PlayerController) to detect a multi-jump transition (e.g. trigger a
	 * flip animation on the second jump).
	 */
	getJumpCount?(): number;

	/**
	 * Optional: whether this movement applies gravity (false when flying/noclip). Used to gate the
	 * voxel-floor safety net so it never yanks a flying player up to the surface.
	 */
	isGravityEnabled?(): boolean;

	/**
	 * Optional: turn gravity on/off. Posture actions (ledge hang, mantle,
	 * vault) switch it off while they own the capsule and back on after.
	 */
	setGravityEnabled?(enabled: boolean): void;

	/**
	 * Optional: zero any accumulated vertical (fall) velocity. Called after the safety net snaps the
	 * player back onto terrain, so a leftover downward velocity can't immediately re-sink them.
	 */
	resetVerticalVelocity?(): void;

	/**
	 * Optional: called by PlayerController when this movement system is
	 * installed (setMovementSystem or initial construction). Use for
	 * one-time setup such as attaching equipment or camera follow.
	 */
	onAttached?(playerController: PlayerController): void;

	/**
	 * Optional: called by PlayerController when this movement system is
	 * replaced. Use to undo everything onAttached did.
	 */
	onDetached?(playerController: PlayerController): void;
}
