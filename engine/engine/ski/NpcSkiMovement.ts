import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import { SkiMovement } from 'engine/ski/SkiMovement.js';
import type { SkiMovementHost } from 'engine/ski/SkiMovementHost.js';
import { SnowSprayVFX, DEFAULT_SNOW_SPRAY_VFX_OPTIONS } from 'engine/ski/SnowSprayVFX.js';
import { computeSkiRiderKeys, DEFAULT_SKI_RIDER_SKILL, type SkiRiderSkill } from 'engine/ski/SkiRiderInput.js';
import type { PlayerMovementKeys } from 'engine/IPlayerMovement.js';

/** The NpcController surface this rider needs beyond {@link SkiMovementHost}. */
interface SkiRiderController {
  buildSkiHost(): SkiMovementHost;
  getEngine(): { scene: THREE.Scene | null };
}

/** Options for an AI ski rider. */
export interface NpcSkiOptions {
  /** Difficulty / line-following knobs — see {@link SkiRiderSkill}. */
  skill: Partial<SkiRiderSkill>;
  /** Per-rider spray particle budget (the player uses 4000; riders smaller). */
  sprayMaxParticles: number;
}

export const DEFAULT_NPC_SKI_OPTIONS: NpcSkiOptions = {
  skill: {},
  sprayMaxParticles: 1500,
};

/**
 * AI ski/snowboard rider. It runs the player's EXACT {@link SkiMovement} physics
 * by subclassing it and swapping keyboard input for synthetic input generated
 * from the NPC's path heading (see {@link computeSkiRiderKeys}). Tuck, carve
 * speed-scrub, lean, sideways stance, board and foot-IK are therefore identical
 * to the player by construction — "difficulty" lives only in how the input is
 * produced ({@link SkiRiderSkill}) and per-rider config, never in a separate
 * movement model.
 *
 * Installed by game code unchanged: `new NpcSkiMovement(rider.speed)` →
 * `NpcController.setMovementSystem(...)`. The controller feeds the path direction
 * via `moveDirection`, which the rider turns into steering + tuck/brake keys; it
 * also owns the body rotation (lean + stance), so NpcController skips its
 * yaw-only facing for this movement (`controlsBodyRotation()` → true, inherited).
 */
export class NpcSkiMovement extends SkiMovement {
  private skiHost: SkiMovementHost | null = null;
  private spray: SnowSprayVFX | null = null;
  private readonly riderSkill: SkiRiderSkill;
  private readonly sprayMaxParticles: number;

  constructor(_moveSpeed = 9, options?: Partial<NpcSkiOptions>) {
    // Same config as the player → identical physics. Per-rider speed/difficulty
    // is tuned via skill (and later per-rider config), not by diverging the
    // movement; `_moveSpeed` is accepted for the existing call site but the speed
    // now emerges from the shared physics (all riders + player equal by default).
    super({ equipmentStyle: 'snowboard' });
    const opts = { ...DEFAULT_NPC_SKI_OPTIONS, ...options };
    this.riderSkill = { ...DEFAULT_SKI_RIDER_SKILL, ...opts.skill };
    this.sprayMaxParticles = opts.sprayMaxParticles;
  }

  override onAttached(controller: SkiMovementHost): void {
    const npc = controller as unknown as SkiRiderController;
    const host = npc.buildSkiHost();
    this.skiHost = host;
    super.onAttached(host);
    const scene = npc.getEngine().scene;
    if (scene && !this.spray) {
      this.spray = new SnowSprayVFX(scene, {
        ...DEFAULT_SNOW_SPRAY_VFX_OPTIONS,
        maxParticles: this.sprayMaxParticles,
        grainSize: 0.06,
      });
    }
  }

  override onDetached(_controller: SkiMovementHost): void {
    if (this.skiHost) super.onDetached(this.skiHost);
    this.spray?.dispose();
    this.spray = null;
    this.skiHost = null;
  }

  override update(
    deltaTime: number,
    _controller: SkiMovementHost,
    _keys: PlayerMovementKeys,
    isGrounded: boolean,
    moveDirection: THREE.Vector3,
    playerBody: RAPIER.RigidBody,
    physicsWorld: PhysicsWorld,
  ): void {
    const host = this.skiHost;
    if (!host || deltaTime <= 0) return;
    // Wait for the race: ride only once the controller feeds a path heading. Before
    // GO (and after finishing) `moveDirection` is ~zero — hold position rather than
    // let SkiMovement's unconditional gravity slide the rider downhill immediately.
    // (The old kinematic NpcSkiMovement had this implicitly via its isMoving check.)
    if (moveDirection.lengthSq() <= 1e-8) return;
    // Synthesize the same keys a keyboard would, from the path direction.
    const state = this.getSkiState();
    const keys = computeSkiRiderKeys(state.heading, state.speed, moveDirection, this.riderSkill);
    super.update(deltaTime, host, keys, isGrounded, moveDirection, playerBody, physicsWorld);
    // Powder off the board — same engine VFX as the player; spawns at the deck
    // (getSkiState().boardContactY).
    this.spray?.update(deltaTime, this.getSkiState(), host.player.position);
  }
}
