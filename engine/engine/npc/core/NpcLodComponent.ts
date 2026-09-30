/**
 * NpcLodComponent — per-character LOD bookkeeping for the CharacterLodScheduler.
 *
 * Owns the dt accumulators for scheduler-gated work (AI, animation, avoidance)
 * and applies transition side effects (physics body enable/disable + snap,
 * shadow toggles) when the stamped sim class or shadow flag changes. The owning
 * controller stays thin: it calls beginFrame() once per update with this
 * frame's stamped state, then consumes ticks where the scheduler granted them.
 *
 * Shared by NpcController and AnimalController — the dead-reckoned VIRTUAL
 * path following lives here as advanceAlongPath().
 */
import * as THREE from 'three';
import {
    SimClass, ALWAYS_FULL_LOD_STATE, type CharacterLodState,
} from 'engine/character/CharacterLodScheduler.js';

export interface LodBodyHooks {
    setBodyEnabled(enabled: boolean): void;
    /** Snap the physics body to the visual position on VIRTUAL -> embodied transitions. */
    snapBodyToVisual(): void;
    setShadowsEnabled(enabled: boolean): void;
}

/**
 * Minimal structural path access for advanceAlongPath. NavigationComponent
 * satisfies it (getCurrentWaypoint + advanceWaypoint) and tests fake it.
 */
export interface LodPathFollower {
    getCurrentWaypoint(): THREE.Vector3 | null;
    advanceWaypoint(): void;
}

/** Accumulators clamp here: a long-starved character catches up at most this much. */
const ACCUM_CLAMP_S = 10;

/** Per-character LOD bookkeeping: accumulators + transition side effects. */
export class NpcLodComponent {
    state: CharacterLodState = ALWAYS_FULL_LOD_STATE;
    aiDtAccum = 0;
    animDtAccum = 0;
    avoidDtAccum = 0;
    private lastSimClass: SimClass = SimClass.FULL;
    private lastCastShadow = true;
    private hooks: LodBodyHooks;
    /**
     * Optional ceiling on the stamped sim class: any stamp MORE virtual than
     * this (VIRTUAL/HIBERNATED when clamped at COARSE) is downgraded to the
     * clamp inside beginFrame. Free-volume animals (fish/birds) use this —
     * they have no navmesh path to dead-reckon along, so they must never
     * disembody.
     */
    private readonly simClassClamp: SimClass | undefined;
    /** Velocity of the last real KCC step — drives COARSE visual extrapolation. */
    readonly lastStepVelocity = new THREE.Vector3();
    // COARSE step-velocity baseline: the body translation at the previous
    // granted AI tick. Kinematic bodies apply a queued step at the NEXT physics
    // step, so within-frame position deltas are always zero — the achieved
    // velocity must be measured ACROSS ticks (see noteCoarseStep).
    private prevStepX = 0;
    private prevStepY = 0;
    private prevStepZ = 0;
    private hasPrevStep = false;

    constructor(hooks: LodBodyHooks, simClassClamp?: SimClass) {
        this.hooks = hooks;
        this.simClassClamp = simClassClamp;
    }

    /** Call at the top of every controller update. Applies transitions, accumulates dt. */
    beginFrame(deltaTime: number, state: CharacterLodState): void {
        if (this.simClassClamp !== undefined && state.simClass > this.simClassClamp) {
            // Copy-on-clamp: the stamped object is shared with the scheduler.
            state = { ...state, simClass: this.simClassClamp };
        }
        this.state = state;
        this.aiDtAccum = Math.min(this.aiDtAccum + deltaTime, ACCUM_CLAMP_S);
        this.animDtAccum = Math.min(this.animDtAccum + deltaTime, ACCUM_CLAMP_S);
        this.avoidDtAccum = Math.min(this.avoidDtAccum + deltaTime, ACCUM_CLAMP_S);
        if (state.castShadow !== this.lastCastShadow) {
            this.hooks.setShadowsEnabled(state.castShadow);
            this.lastCastShadow = state.castShadow;
        }
        if (state.simClass !== this.lastSimClass) {
            this.applySimClassTransition(this.lastSimClass, state.simClass);
            this.lastSimClass = state.simClass;
        }
    }

    /** Consume the AI accumulator if the scheduler granted an AI tick. Null = skip AI this frame. */
    consumeAiTick(): number | null {
        if (!this.state.tickAi) return null;
        const dt = this.aiDtAccum;
        this.aiDtAccum = 0;
        return dt;
    }

    /** Consume the animation accumulator if an anim tick was granted. Null = skip anim this frame. */
    consumeAnimTick(): number | null {
        if (!this.state.tickAnim) return null;
        const dt = this.animDtAccum;
        this.animDtAccum = 0;
        return dt;
    }

    /** Consume the avoidance gate; true when avoidance work may run this frame. */
    consumeAvoidanceTick(): boolean {
        if (!this.state.tickAvoidance) return false;
        this.avoidDtAccum = 0;
        return true;
    }

    /**
     * Zero all dt accumulators. Called by controllers on the legacy
     * dt-dropping early-return paths (not playing, physics held, stunned,
     * avoidance step-aside, idling): before the LOD system existed, those
     * paths returned before the behavior/movement block, so behavior never
     * saw that frame's dt. Letting it pile up in the accumulators instead
     * would hand the NEXT granted tick a lump of unsimulated time — worst
     * case a VIRTUAL NPC teleporting moveSpeed * 10 s along its path on
     * unpause. The invariant: any path that returned before the behavior
     * block pre-LOD must leave the accumulators empty. Call AFTER consuming
     * this frame's granted ticks (e.g. after tickAnimationLod) so anim time
     * also cannot jump after a pause.
     */
    dropAccumulators(): void {
        this.aiDtAccum = 0;
        this.animDtAccum = 0;
        this.avoidDtAccum = 0;
    }

    /**
     * Record the body translation at a COARSE KCC step and derive the achieved
     * velocity since the previous step (used to extrapolate the visual between
     * ticks). The magnitude is clamped to maxSpeed so a teleport between ticks
     * cannot become a runaway extrapolation. Ground characters track XZ only;
     * free-volume characters (fish/birds) pass bodyY so vertical motion
     * extrapolates too.
     */
    noteCoarseStep(bodyX: number, bodyZ: number, dt: number, maxSpeed: number, bodyY?: number): void {
        if (this.hasPrevStep && dt > 0) {
            const vy = bodyY !== undefined ? (bodyY - this.prevStepY) / dt : 0;
            this.lastStepVelocity.set((bodyX - this.prevStepX) / dt, vy, (bodyZ - this.prevStepZ) / dt);
            const speed = this.lastStepVelocity.length();
            if (speed > maxSpeed && speed > 0) {
                this.lastStepVelocity.multiplyScalar(maxSpeed / speed);
            }
        }
        this.prevStepX = bodyX;
        this.prevStepY = bodyY ?? 0;
        this.prevStepZ = bodyZ;
        this.hasPrevStep = true;
    }

    /**
     * Dead-reckon a character along its nav path (VIRTUAL sim class): walk the
     * waypoints manually with a moveSpeed * dt budget — no physics, no KCC.
     * Faces the movement direction. Shared by NPC and animal controllers.
     */
    advanceAlongPath(
        character: THREE.Object3D,
        navigationComp: LodPathFollower,
        moveSpeed: number,
        dt: number,
    ): void {
        const pos = character.position;
        let budget = moveSpeed * dt;
        let wp = navigationComp.getCurrentWaypoint();
        while (wp && budget > 0) {
            const dx = wp.x - pos.x;
            const dz = wp.z - pos.z;
            const dist = Math.hypot(dx, dz);
            if (dist <= Math.max(budget, 0.5)) {
                pos.x = wp.x;
                pos.z = wp.z;
                budget -= dist;
                navigationComp.advanceWaypoint();
                wp = navigationComp.getCurrentWaypoint();
            } else {
                pos.x += (dx / dist) * budget;
                pos.z += (dz / dist) * budget;
                budget = 0;
            }
            // Face the movement direction.
            if (dist > 0.0001) {
                character.rotation.y = Math.atan2(dx, dz);
            }
        }
    }

    private applySimClassTransition(prev: SimClass, next: SimClass): void {
        const wasEmbodied = prev === SimClass.FULL || prev === SimClass.COARSE;
        const isEmbodied = next === SimClass.FULL || next === SimClass.COARSE;
        if (wasEmbodied && !isEmbodied) {
            this.hooks.setBodyEnabled(false);
        }
        if (!wasEmbodied && isEmbodied) {
            this.hooks.snapBodyToVisual();
            this.hooks.setBodyEnabled(true);
        }
        // Any sim-class change invalidates the COARSE extrapolation baseline.
        this.hasPrevStep = false;
        this.lastStepVelocity.set(0, 0, 0);
    }
}
