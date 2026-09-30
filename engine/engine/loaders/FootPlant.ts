import * as THREE from 'three';
import type { RaycastResult } from 'engine/physics/PhysicsWorld.js';
import { solveLegIK, type LegBones } from 'engine/loaders/LegIK.js';

/** Conservative stance lock. It never raises the body or copies a terrain normal
 * to the character's facing. No contact, flight, a large step or unreachable leg
 * releases the lock rather than pulling the character toward an edge. */
export class FootPlant {
    private readonly previous = new THREE.Vector3();
    private readonly anchor = new THREE.Vector3();
    private readonly current = new THREE.Vector3();
    private readonly hip = new THREE.Vector3();
    private readonly knee = new THREE.Vector3();
    private readonly target = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
    private initialized = false;
    private locked = false;
    private weight = 0;

    solve(bones: LegBones, facing: THREE.Quaternion, hit: RaycastResult,
        groundY: number, contactY: number, grounded: boolean, height: number, dt: number, contactWeight = 1): void {
        bones.foot.getWorldPosition(this.current);
        bones.thigh.getWorldPosition(this.hip);
        bones.shin.getWorldPosition(this.knee);
        const reach = this.hip.distanceTo(this.knee) + this.knee.distanceTo(this.current);
        const speed = this.initialized && dt > 0 ? this.current.distanceTo(this.previous) / dt : Infinity;
        this.previous.copy(this.current);
        this.initialized = true;
        const stanceWeight = contactWeight * (1 - THREE.MathUtils.smoothstep(contactY - groundY, height * .012, height * .04));
        const canPlant = grounded && stanceWeight > 0 && hit.hasHit && hit.hitNormal.y >= .7
            && (!hit.hitRigidBody || hit.hitRigidBody.isFixed())
            && Math.abs(hit.hitPoint.y - groundY) <= height * .08
            && contactY >= groundY - height * .04;
        if (!canPlant || (this.locked && (this.anchor.distanceTo(this.current) > height * .10
            || this.anchor.distanceTo(this.hip) >= reach * .995))) {
            this.locked = false;
        } else if (!this.locked && speed < height * .6 && contactY - groundY <= height * .025) {
            this.anchor.copy(this.current);
            this.anchor.y += hit.hitPoint.y - contactY;
            this.locked = this.anchor.distanceTo(this.hip) < reach * .995;
        }
        // Immediate release in flight/out of reach. Blending a now-invalid
        // target even for a few frames is enough to glue a takeoff to the floor.
        if (!this.locked) { this.weight = 0; return; }
        this.weight = Math.min(1, this.weight + Math.max(0, dt) / .08);
        // Fade BEFORE the drift/reach limits release the plant. Otherwise a
        // foot can stay at its anchor until it is 10% of body height away and
        // teleport that entire distance on the next frame (especially when a
        // full-body action blends back into locomotion). Invalid ground/flight
        // still release immediately above; no invalid target is carried over.
        const driftWeight = 1 - THREE.MathUtils.smoothstep(this.anchor.distanceTo(this.current), height * .025, height * .10);
        const reachWeight = 1 - THREE.MathUtils.smoothstep(this.anchor.distanceTo(this.hip) / reach, .96, .995);
        this.target.position.lerpVectors(this.current, this.anchor,
            THREE.MathUtils.smoothstep(this.weight, 0, 1) * stanceWeight * driftWeight * reachWeight);
        // The ankle anchor was acquired with an older toe/sole offset. Keep
        // its horizontal plant, but respect the current articulated foot's
        // clearance; otherwise a rotating toe is pulled underground AFTER
        // grounding already delivered a safe pose. This never moves the hip.
        this.target.position.y = Math.max(this.target.position.y, this.current.y + hit.hitPoint.y - contactY);
        bones.foot.getWorldQuaternion(this.target.quaternion); // preserve authored heel/toe articulation
        solveLegIK(facing, bones, this.target, true);
    }

    reset(): void { this.initialized = this.locked = false; this.weight = 0; }
    get isPlanted(): boolean { return this.locked; }
}
