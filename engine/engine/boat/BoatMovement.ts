/**
 * Player movement system for watercraft: the rider stands on a procedural hull
 * that rides the ocean's wave field.
 *
 * Installed like any other movement system — either from world.json
 * (`worldProfileData.playerMovement = { mode: 'boat' }`) or in code
 * (`playerController.setMovementSystem(new BoatMovement(...))`). The handling
 * itself lives in `engine/boat/BoatMotor.ts`, which AI rivals share, so this
 * class is only the wiring: keys in, kinematic body moved, hull and spray
 * placed, camera fed.
 *
 * ## The water reference
 *
 * A boat is meaningless without water to ride, and the water it rides MUST be
 * the water on screen. It finds that water ITSELF: every frame, until it has
 * one, it asks the engine for the open-water ocean
 * (`worldProfileData.openWater`). Games that build their own surface can
 * override with `setWaterSurface()`, but nobody has to.
 *
 * The first version required the hand-off, and the failure was silent — a boat
 * with no surface floats on a flat plane at y = 0, under or above the visible
 * sea, which reads as "the ocean is missing". The fallback plane is still there
 * for a game with no ocean at all, but it is no longer something you can end up
 * on by forgetting a call.
 *
 * ## Collision
 *
 * Horizontal motion goes through the shared Rapier
 * `KinematicCharacterController`, exactly like walking and skiing, so islands,
 * jetties and rival hulls still block. Vertical motion does NOT: the wave
 * surface is a shader displacement with no collider, so height comes from the
 * wave field and is applied directly.
 */

import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { getRapier } from 'engine/physics/RapierPhysics.js';
import type { IPlayerMovement, PlayerMovementKeys } from 'engine/IPlayerMovement.js';
import type { PlayerController } from 'engine/PlayerController.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import { CollisionGroup } from 'engine/CollisionLayers.js';
import type { WaterSurfaceQuery } from 'engine/water/WaterSurfaceQuery.js';
import { flatWaterSurface } from 'engine/water/FlatWaterSurface.js';
import { BoatMotor, type BoatInput, type BoatState } from 'engine/boat/BoatMotor.js';
import { BoatHull } from 'engine/boat/BoatHull.js';
import { BoatWakeVFX } from 'engine/boat/BoatWakeVFX.js';
import { type BoatConfig, DEFAULT_BOAT_CONFIG, mergeBoatConfig } from 'engine/boat/BoatConfig.js';

/** Height of the rider's feet above the hull's waterline origin (m). */
const DECK_HEIGHT = 0.42;

export class BoatMovement implements IPlayerMovement {
    private readonly config: BoatConfig;
    private readonly motor: BoatMotor;
    private readonly hull: BoatHull;
    private wake: BoatWakeVFX | null = null;

    private surface: WaterSurfaceQuery;
    /** True once a caller has named a surface; stops the engine-ocean auto-bind. */
    private surfaceExplicit = false;
    private attached: PlayerController | null = null;
    private initialized = false;
    private ascendPrev = false;
    /** Body translation this system wrote last frame, to spot external moves. */
    private readonly lastWritten = new THREE.Vector3();
    private hasWritten = false;

    private readonly input: BoatInput = { throttle: 0, steer: 0, boost: false, jump: false };
    private readonly poseQuat = new THREE.Quaternion();
    private readonly hullPos = new THREE.Vector3();
    private readonly desiredScratch = new THREE.Vector3();
    private readonly appliedScratch = new THREE.Vector3();

    constructor(config?: Partial<BoatConfig> | Record<string, unknown>) {
        this.config = mergeBoatConfig(config);
        this.motor = new BoatMotor(this.config);
        this.hull = new BoatHull(this.config);
        this.surface = flatWaterSurface(0);
    }

    /**
     * Point the boat at the live water. Pass the same `OceanSurface` the scene
     * renders — anything implementing `WaterSurfaceQuery` works.
     */
    setWaterSurface(surface: WaterSurfaceQuery): void {
        this.surfaceExplicit = true;
        this.adoptSurface(surface);
    }

    /** Shared by the explicit setter and the engine-ocean auto-bind. */
    private adoptSurface(surface: WaterSurfaceQuery): void {
        this.surface = surface;
        // The wake holds its own reference (it is built before the ocean
        // exists), so re-point it too or the trail stays on flat water.
        this.wake?.setSurface(surface);
        // Re-seat on the first frame against the new surface, rather than
        // leaving the hull at whatever height the old one implied.
        this.initialized = false;
    }

    /**
     * Adopt the engine's open-water ocean, unless a caller named a surface
     * explicitly. Called every frame rather than once: `applyOpenWater` runs
     * during `loadGame`, which can land AFTER this movement system is
     * installed, so a one-shot read at attach time would miss it and leave the
     * boat on the flat fallback plane for the whole session.
     */
    private resolveSurface(engine: { getOceanSurface?(): WaterSurfaceQuery | null } | null | undefined): void {
        if (this.surfaceExplicit) return;
        const ocean = engine?.getOceanSurface?.() ?? null;
        if (ocean && ocean !== this.surface) this.adoptSurface(ocean);
    }

    onAttached(playerController: PlayerController): void {
        this.attached = playerController;
        const scene = playerController.engine?.scene ?? null;
        if (scene && this.config.showWake && !this.wake) {
            this.wake = new BoatWakeVFX(scene, this.surface);
        }
    }

    onDetached(): void {
        this.hull.detach();
        this.wake?.dispose();
        this.wake = null;
        this.attached = null;
        this.initialized = false;
    }

    update(
        deltaTime: number,
        playerController: PlayerController,
        keys: PlayerMovementKeys,
        _isGrounded: boolean,
        _moveDirection: THREE.Vector3,
        playerBody: RAPIER.RigidBody,
        physicsWorld: PhysicsWorld,
    ): void {
        const collider = playerBody.numColliders() > 0 ? playerBody.collider(0) : null;
        if (!collider) return;
        const capsule = collider.shape as unknown as { halfHeight: number; radius: number };
        const capsuleHalf = capsule.halfHeight + capsule.radius;

        this.resolveSurface(playerController.engine);

        const t0 = playerBody.translation();

        // ---- one-time seat ----
        // The spawn point is authored on dry-land terms (a clearance above the
        // ground). Drop the boat straight onto the water on the first frame, or
        // the race starts with a free-fall or a sunk hull.
        if (!this.initialized) {
            this.initialized = true;
            const y = this.surface.heightAt(t0.x, t0.z) + this.config.rideHeight;
            this.motor.setPosition(t0.x, y, t0.z, playerController.player?.rotation.y ?? 0);
            playerBody.setTranslation(
                { x: t0.x, y: y + DECK_HEIGHT + capsuleHalf, z: t0.z }, true,
            );
            this.hasWritten = false;
        } else if (this.hasWritten && this.lastWritten.distanceToSquared(t0 as THREE.Vector3) > 0.25) {
            // Somebody else moved the body — engine spawn placement landing
            // after our seat, a level load, a respawn. Adopt the new position
            // instead of dragging the player back, which is what makes a boat
            // look like it is fighting the game over where the start line is.
            const y = this.surface.heightAt(t0.x, t0.z) + this.config.rideHeight;
            this.motor.setPosition(t0.x, y, t0.z, this.motor.getHeading());
            this.wake?.reset();
        }

        // ---- input ----
        this.input.throttle = (keys.forward ? 1 : 0) + (keys.backward ? -1 : 0);
        // Positive yaw is LEFT, matching SkiMovement and the engine's gameplay
        // convention — see agent-docs/coordinate-system.md.
        this.input.steer = (keys.left ? 1 : 0) + (keys.right ? -1 : 0);
        this.input.boost = keys.action === true;
        this.input.jump = keys.ascend && !this.ascendPrev;
        this.ascendPrev = keys.ascend;

        // ---- motor ----
        const desired = this.motor.step(deltaTime, this.input, this.surface);
        this.desiredScratch.copy(desired);

        // ---- horizontal collision through the shared KCC ----
        // Vertical is excluded on purpose: the water has no collider, so a KCC
        // that saw our wave-following Y would report "ungrounded" every frame
        // and clamp nothing useful.
        const RAPIERMOD = getRapier();
        const controller = physicsWorld.getCharacterController();
        const kccFilter = collider.collisionGroups() | (CollisionGroup.DYNAMIC_PROP << 16);
        controller.computeColliderMovement(
            collider,
            { x: this.desiredScratch.x, y: 0, z: this.desiredScratch.z },
            RAPIERMOD.QueryFilterFlags.EXCLUDE_SENSORS,
            kccFilter,
            (other) => other.handle !== collider.handle,
        );
        const mv = controller.computedMovement();
        this.appliedScratch.set(mv.x, this.desiredScratch.y, mv.z);
        this.motor.commit(this.appliedScratch, deltaTime);

        // ---- place the body + visuals ----
        this.motor.getPosition(this.hullPos);
        // The physics capsule rides above the deck; the hull itself sits at the
        // waterline, which is where the motor's position lives.
        const bodyY = this.hullPos.y + DECK_HEIGHT + capsuleHalf;
        playerBody.setNextKinematicTranslation({ x: this.hullPos.x, y: bodyY, z: this.hullPos.z });
        this.lastWritten.set(this.hullPos.x, bodyY, this.hullPos.z);
        this.hasWritten = true;

        this.motor.getPose(deltaTime, this.input, this.poseQuat);
        const parent = playerController.player?.parent ?? null;
        this.hull.syncTransform(parent, this.hullPos, this.poseQuat);

        if (playerController.player) {
            const feetOffsetY = playerController.playerLoader?.getFeetOffsetY() ?? 0;
            playerController.player.position.set(
                this.hullPos.x,
                this.hullPos.y + DECK_HEIGHT - feetOffsetY,
                this.hullPos.z,
            );
            // The rider leans with the hull; a yaw-only facing would leave them
            // standing bolt upright on a boat rolling through a turn.
            playerController.player.quaternion.copy(this.poseQuat);
        }

        const state = this.motor.getState();
        this.wake?.update(deltaTime, state, this.hullPos);

        // ---- camera ----
        const cam = playerController.getCameraController();
        if (cam && typeof cam.setTargetForwardDirection === 'function' && state.speed > 1.2) {
            cam.setTargetForwardDirection(
                this.desiredScratch.set(Math.sin(state.heading), 0, Math.cos(state.heading)),
            );
        }
    }

    // ---- IPlayerMovement ----

    getCurrentSpeed(): number { return this.motor.getState().speed; }
    isInAir(): boolean { return !this.motor.getState().onWater; }
    getRotation(): number { return this.motor.getHeading(); }
    setRotation(rotation: number): void { this.motor.setHeading(rotation); }

    reset(): void {
        const p = this.motor.getPosition(this.hullPos);
        this.motor.setPosition(p.x, p.y, p.z, this.motor.getHeading());
        this.wake?.reset();
    }

    getAscendDisplayName(): string { return 'Hop'; }
    getDescendDisplayName(): string { return 'Brake'; }
    getSupportedKeys(): { ascend: boolean; descend: boolean } {
        return { ascend: this.config.jumpSpeed > 0, descend: false };
    }
    getKeyBehavior(): { ascend: 'tap' | 'continuous'; descend: 'tap' | 'continuous' } {
        return { ascend: 'tap', descend: 'tap' };
    }
    shouldShowPlayer(): boolean { return true; }
    shouldPlayLocomotionAnimation(): boolean { return false; }

    /** The boat writes position AND full body rotation; the template must not. */
    handlesPlayerPositionSync(): boolean { return true; }
    controlsBodyRotation(): boolean { return true; }

    /** Buoyancy is not gravity — the voxel-floor safety net must stay out of it. */
    isGravityEnabled(): boolean { return false; }

    getMoveSpeed(): number { return this.config.maxSpeed; }

    /**
     * IGNORED, on purpose.
     *
     * `setMoveSpeed` carries the CHARACTER's run speed, and every genre
     * template calls it at spawn with `characterConfig.runSpeed` (~5 m/s) on
     * whatever movement system happens to be installed. An earlier version
     * honoured it by rewriting `maxSpeed`, which silently clamped a 26 m/s
     * racing boat to a walking pace — the boat looked broken, and the config
     * that said `maxSpeed: 28` sat there looking correct.
     *
     * A boat's top speed comes from its own config. Change it with
     * `updateConfig({ maxSpeed })`.
     */
    setMoveSpeed(_speed: number): void { /* see above */ }

    // ---- boat-specific API ----

    /** Poll per frame for HUD speed, drift scoring, airtime bonuses, gate logic. */
    getBoatState(): BoatState { return this.motor.getState(); }

    /** The hull's waterline position — spawn effects and gate tests use this. */
    getHullPosition(out: THREE.Vector3): THREE.Vector3 { return this.motor.getPosition(out); }

    /** Race reset: drop the boat back on the water facing `yaw`, at a standstill. */
    teleport(position: THREE.Vector3, yaw: number): void {
        const y = this.surface.heightAt(position.x, position.z) + this.config.rideHeight;
        this.motor.setPosition(position.x, y, position.z, yaw);
        this.wake?.reset();
        const body = this.attached?.playerBody;
        const collider = body && body.numColliders() > 0 ? body.collider(0) : null;
        if (body && collider) {
            const capsule = collider.shape as unknown as { halfHeight: number; radius: number };
            const capsuleHalf = capsule.halfHeight + capsule.radius;
            body.setTranslation({ x: position.x, y: y + DECK_HEIGHT + capsuleHalf, z: position.z }, true);
        }
    }

    /** Merge new tuning at runtime. Hull geometry is built once, so colours stick. */
    updateConfig(partial: Partial<BoatConfig> | Record<string, unknown>): void {
        Object.assign(this.config, mergeBoatConfig({ ...this.config, ...(partial as Partial<BoatConfig>) }));
    }
}
