import * as THREE from 'three';
import type { CharacterAnimationController } from 'engine/CharacterAnimationController.js';
import type { MixamoAnimationPlayer } from 'engine/MixamoAnimationPlayer.js';
import { CollisionGroup } from 'engine/CollisionLayers.js';
import type { PhysicsWorld, RaycastResult } from 'engine/physics/PhysicsWorld.js';
import { isPlaneLockedPhysics } from 'engine/physics/PlaneLockedPhysics.js';
import { FootPlant } from 'engine/loaders/FootPlant.js';
import { resolveSkinnedLegBones, solveLegIK, type LegBones } from 'engine/loaders/LegIK.js';

/** How long a mask/action-lifecycle handoff takes to reach its new influence. */
const MASK_HANDOFF_SECONDS = .1;

/** An absent or very long frame (tab switch, hitch) is a discontinuity to snap
 * through, not a delta to filter with. */
function isContinuousFrame(dt: number): boolean {
    return Number.isFinite(dt) && dt <= .25;
}

/** A render-only, ground-relative height filter. Physics steps/teleports are
 * deliberately absent from its input, so it cannot lag behind the capsule.
 * Soft saturation bounds the correction without a hard clipping kink. */
export class SkinnedHeightFilter {
    private height: number | null = null;

    sample(target: number, characterHeight: number, dt: number): number {
        if (this.height === null || !isContinuousFrame(dt)
            || Math.abs(target - this.height) > characterHeight * .2) {
            this.height = target;
            return 0;
        }
        this.height += (target - this.height) * -Math.expm1(-Math.max(0, dt) / .08);
        const limit = characterHeight * .022;
        return limit * Math.tanh((this.height - target) / limit);
    }

    reset(): void { this.height = null; }
}

/** Rest-foot height is not a contact label: toe pivots and imported rest poses
 * can report centimetres of lift even in idle. Fade contact over a rig-scaled
 * band; do NOT subtract this band from the authored flight displacement. */
export function skinnedContactWeight(footLift: number, height: number): number {
    return 1 - THREE.MathUtils.smoothstep(footLift, height * .015, height * .035);
}

/** Authored body height and automatic contacts for real skins. No ray hit or
 * support-joint switch moves/tilts the authored body. Explicit bindings and
 * incomplete rigs keep legacy placement; 2D/non-standing poses opt out of damping. */
export class SkinnedGrounding {
    readonly footPlants = { left: new FootPlant(), right: new FootPlant() };
    private readonly heightFilter = new SkinnedHeightFilter();
    private dampingMask: number | null = null;
    private dampingPlayer: MixamoAnimationPlayer | null = null;
    private dampingPlayRevision = 0;
    private dampingWeight = 1;
    private maskTransitionFrom = 1;
    private maskTransitionSeconds = MASK_HANDOFF_SECONDS;
    private readonly legs = new Map<'left' | 'right', LegBones>();
    private readonly restHipsHeight: number;
    private readonly restRootScale: number;
    private readonly probe = new THREE.Vector3();
    private readonly facing = new THREE.Quaternion();
    private readonly position = new THREE.Vector3();
    private readonly hip = new THREE.Vector3();
    private readonly knee = new THREE.Vector3();
    private readonly ankle = new THREE.Vector3();
    private readonly target = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
    private readonly hit: RaycastResult = { hasHit: false, hitPoint: new THREE.Vector3(),
        hitNormal: new THREE.Vector3(), hitDistance: 0, hitCollider: null, hitRigidBody: null };
    private static readonly down = new THREE.Vector3(0, -1, 0);

    constructor(
        private readonly root: THREE.Object3D,
        private readonly hips: THREE.Object3D | null,
        private readonly feet: readonly THREE.Object3D[],
    ) {
        root.updateWorldMatrix(true, true);
        const lowest = Math.min(...feet.map(foot => foot.getWorldPosition(this.position).y));
        this.restHipsHeight = hips && Number.isFinite(lowest) ? hips.getWorldPosition(this.position).y - lowest : NaN;
        this.restRootScale = root.getWorldScale(this.position).y;
        for (const side of ['left', 'right'] as const) {
            const leg = resolveSkinnedLegBones(root, side);
            if (leg) this.legs.set(side, leg);
        }
    }

    place(groundY: number, footLift: number, height: number,
        controller: CharacterAnimationController | null, world: PhysicsWorld | null | undefined,
        facingObject: THREE.Object3D, authoredHipsOffset: number | null = null): void {
        const root = this.root;
        let lowest = Infinity;
        for (const foot of this.feet) lowest = Math.min(lowest, foot.getWorldPosition(this.position).y);
        if (lowest === Infinity) { this.reset(); return; }
        const dt = controller?.getPoseDeltaSeconds() ?? 1 / 60;
        // Automatic handling needs a controller in a standing, grounded, unbound
        // 3D pose; `auto` carries that controller so the checks are stated once.
        const auto = controller && (!world || !isPlaneLockedPhysics(world)) && !controller.getFootIkTargets()
            && controller.getPosture() === 'stand' && controller.getPoseGrounded() ? controller : null;
        const authored = authoredHipsOffset !== null && this.hips && this.legs.size === 2
            && Number.isFinite(this.restHipsHeight) && !controller?.getFootIkTargets();
        const rawHips = this.hips ? this.hips.getWorldPosition(this.position).y - lowest + footLift : 0;
        const desiredHips = authored ? this.restHipsHeight * root.getWorldScale(this.position).y / this.restRootScale
            + authoredHipsOffset : rawHips;
        let correction = 0;
        if (auto) correction = this.sampleCorrection(auto, desiredHips, height, dt, !authored);
        else { this.heightFilter.reset(); this.resetDampingWeight(); }
        correction += desiredHips - rawHips;

        // Ground/physics movement is immediate. Only the few-centimetre visual
        // bob correction is filtered, in WORLD metres, even for scaled NPCs.
        root.getWorldPosition(this.position);
        this.position.y += groundY + footLift - lowest + correction;
        if (root.parent) root.parent.worldToLocal(this.position);
        root.position.copy(this.position);
        root.updateMatrixWorld(true);
        facingObject.getWorldQuaternion(this.facing);

        // Preserve ankle orientation through the legs. With source pelvis data,
        // only a penetrating foot needs correction; the legacy fallback keeps
        // its exact ankle trajectories while damping the torso.
        if (correction !== 0 || authored) for (const bones of this.legs.values()) {
            bones.foot.getWorldPosition(this.target.position);
            let adjustment = -correction;
            if (authored) {
                // Never borrow the opposite foot's support correction: it
                // moves an already-clear swing leg and then drops that offset
                // abruptly when the clip-wide contact weight reaches flight.
                // Clearance reaches zero continuously as this foot lifts.
                let contactY = this.target.position.y;
                for (const joint of this.feet) if (bones.foot.getObjectById(joint.id)) {
                    contactY = Math.min(contactY, joint.getWorldPosition(this.position).y);
                }
                adjustment = controller?.getPoseGrounded() === false ? 0 : Math.max(0, groundY - contactY);
            }
            if (Math.abs(adjustment) < 1e-6) continue;
            this.target.position.y += adjustment;
            bones.foot.getWorldQuaternion(this.target.quaternion);
            solveLegIK(this.facing, bones, this.target, true);
        }

        const contactWeight = skinnedContactWeight(footLift, height);
        if (!auto || !world || contactWeight === 0) { this.resetPlants(); return; }
        for (const [side, bones] of this.legs) {
            bones.foot.getWorldPosition(this.probe);
            let contactY = this.probe.y;
            for (const joint of this.feet) {
                if (!bones.foot.getObjectById(joint.id)) continue; // the ankle itself, or one of its toes
                contactY = Math.min(contactY, joint.getWorldPosition(this.position).y);
            }
            this.probe.y = groundY + height * .10;
            world.raycast(this.probe, SkinnedGrounding.down, height * .2,
                CollisionGroup.TERRAIN | CollisionGroup.ENVIRONMENT, this.hit);
            this.footPlants[side].solve(bones, this.facing, this.hit, groundY, contactY,
                true, height, dt, contactWeight);
        }
    }

    /** Damped hip offset in world metres, or 0 (releasing the filter) for rigs
     * and states that must keep their authored height exactly.
     * Full-body actions retain their authored timing; upper-body attacks can
     * still ride the damped locomotion base, including masked fade weights. */
    private sampleCorrection(controller: CharacterAnimationController, desiredHips: number,
        height: number, dt: number, constrainReach: boolean): number {
        // ATTACK is the action lifecycle state, not the pose of the legs:
        // Track A can still be running underneath it. Keep filter history
        // through entry/completion and let B's actual lower-body fade release
        // damping, rather than dropping the correction on a state change.
        const state = controller.getCurrentState();
        const canDamp = state === 'walk' || state === 'run' || state === 'idle' || state === 'attack';
        if (!this.hips || this.legs.size !== 2 || !canDamp) {
            this.heightFilter.reset(); this.resetDampingWeight(); return 0;
        }
        const actionLayer = controller.getActionBoneMap();
        const lowerBody = controller.getCustomAnimationBodyBlend()?.lowerBody
            ?? (actionLayer ? controller.getActionBlend().lowerBody : 1);
        const actionPlayer = controller.getTrackBMixamoPlayer();
        const hasAction = !!(actionPlayer || actionLayer || controller.getIsPlayingCustomAnimation()
            || controller.getIsAttacking() || controller.isPriorityAnimationPlaying());
        const actionWeight = actionPlayer?.getBlendWeight() ?? (hasAction ? 1 : 0);
        const correction = this.heightFilter.sample(desiredHips, height, dt)
            * this.sampleDampingWeight(hasAction, lowerBody, actionWeight, actionPlayer, dt);
        // Unreachable IK targets may limit the FOOT, not snap the pelvis when
        // a straight leg briefly has no extension slack.
        return constrainReach ? this.limitExtension(correction) : correction;
    }

    /** Masks and action lifecycles can switch before any pose time advances.
     * Blend those handoffs from the displayed influence, including interruptions.
     * Ordinary action fades still supply their exact weight; an upper-body
     * action starting over locomotion never interrupts the height filter. */
    private sampleDampingWeight(hasAction: boolean, lowerBody: number, actionWeight: number,
        player: MixamoAnimationPlayer | null, dt: number): number {
        if (!isContinuousFrame(dt)) this.resetDampingWeight();
        const delta = Number.isFinite(dt) ? Math.max(0, dt) : 0;
        const mask = hasAction ? lowerBody : null;
        const revision = player?.getPlayRevision() ?? 0;
        const changed = mask !== this.dampingMask || player !== this.dampingPlayer
            || revision !== this.dampingPlayRevision;
        // Cancellation restores a target of 1; replay/replacement can reset B's
        // fade while keeping the same mask (and even the same player). Neither
        // may discard the displayed influence. First entry keeps its own fade.
        if (changed && (this.dampingMask !== null || this.maskTransitionSeconds < MASK_HANDOFF_SECONDS)) {
            this.maskTransitionFrom = this.dampingWeight;
            this.maskTransitionSeconds = 0;
        } else {
            this.maskTransitionSeconds = Math.min(MASK_HANDOFF_SECONDS, this.maskTransitionSeconds + delta);
        }
        this.dampingMask = mask;
        this.dampingPlayer = player;
        this.dampingPlayRevision = revision;
        const progress = THREE.MathUtils.smoothstep(this.maskTransitionSeconds, 0, MASK_HANDOFF_SECONDS);
        const target = hasAction ? 1 - actionWeight * lowerBody : 1;
        this.dampingWeight = THREE.MathUtils.lerp(this.maskTransitionFrom, target, progress);
        return this.dampingWeight;
    }

    private resetDampingWeight(): void {
        this.dampingMask = null; this.dampingWeight = 1;
        this.dampingPlayer = null; this.dampingPlayRevision = 0;
        this.maskTransitionFrom = 1; this.maskTransitionSeconds = MASK_HANDOFF_SECONDS;
    }

    /** Never raise a hip beyond the leg's ability to keep its authored ankle.
     * The bound uses world-space segment lengths, not skin-local bind units. */
    private limitExtension(correction: number): number {
        if (correction <= 0) return correction;
        for (const bones of this.legs.values()) {
            bones.thigh.getWorldPosition(this.hip);
            bones.shin.getWorldPosition(this.knee);
            bones.foot.getWorldPosition(this.ankle);
            const reach = Math.max(0, this.hip.distanceTo(this.knee) + this.knee.distanceTo(this.ankle) - .001);
            const dx = this.hip.x - this.ankle.x, dz = this.hip.z - this.ankle.z;
            const maxY = Math.sqrt(Math.max(0, reach * reach - dx * dx - dz * dz));
            correction = Math.min(correction, Math.max(0, maxY - (this.hip.y - this.ankle.y)));
        }
        return correction;
    }

    private resetPlants(): void { this.footPlants.left.reset(); this.footPlants.right.reset(); }
    reset(): void { this.heightFilter.reset(); this.resetDampingWeight(); this.resetPlants(); }
}
