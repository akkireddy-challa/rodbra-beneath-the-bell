import RAPIER2D from '@dimforge/rapier2d-compat';
import * as THREE from 'three';
import { getRapier2D, isRapier2DReady } from 'engine/physics/RapierPhysics2D.js';

export interface RaycastResult2D {
    hasHit: boolean;
    hitPoint: THREE.Vector2;
    hitNormal: THREE.Vector2;
    hitDistance: number;
    hitCollider: RAPIER2D.Collider | null;
    hitRigidBody: RAPIER2D.RigidBody | null;
}

export interface ContactInfo2D {
    bodyA: RAPIER2D.RigidBody;
    bodyB: RAPIER2D.RigidBody;
    colliderA: RAPIER2D.Collider;
    colliderB: RAPIER2D.Collider;
    contactPoint: THREE.Vector2;
    contactNormal: THREE.Vector2;
    penetrationDepth: number;
}

export type CollisionCallback2D = (contact: ContactInfo2D) => void;

/**
 * Sensor (trigger) overlap notifications, in COLLIDER handles — resolve with
 * `world.getCollider(handle)`. Either collider in the pair may be the sensor, so
 * a listener filters by its own sensor's known handle. End events fire when a
 * previously-overlapping pair separates.
 *
 * The 2D twin of `SensorIntersectionListener` (PhysicsWorld.ts), deliberately
 * the same shape: everything that consumes triggers — collectibles, interaction
 * zones, drop zones, water — is written against that contract, so a 2D port of
 * any of them should not need a second vocabulary.
 */
export interface SensorIntersectionListener2D {
    onIntersectionStart: (h1: number, h2: number) => void;
    onIntersectionEnd: (h1: number, h2: number) => void;
}

export class PhysicsWorld2D {
    private world: RAPIER2D.World;
    private eventQueue: RAPIER2D.EventQueue;
    private collisionCallbacks: Map<number, CollisionCallback2D[]> = new Map();
    private handleToUserData: Map<number, unknown> = new Map();

    private pendingBodyRemovals: RAPIER2D.RigidBody[] = [];
    private pendingColliderRemovals: RAPIER2D.Collider[] = [];
    private pendingCallbacks: Array<{ cb: CollisionCallback2D; info: ContactInfo2D }> = [];
    private stepping = false;

    /** Lazily-created shared KinematicCharacterController — see getCharacterController(). */
    private characterController: RAPIER2D.KinematicCharacterController | null = null;
    private sensorListeners = new Set<SensorIntersectionListener2D>();

    /**
     * Set by dispose(). The genre can be torn down while an async load stage
     * still holds this reference (Physics2DGame captures it, awaits a GLB, then
     * raycasts on it) — stepping or querying the freed WASM world throws
     * something unrecognisable ("Cannot set properties of undefined (setting
     * 'dt')"). Same guard, same cause, as PhysicsWorld's `isWorldDisposed`.
     */
    private isWorldDisposed = false;

    /** Steps completed so far — before the first one the query pipeline has no BVH (see getStepsTaken). */
    private stepsTaken = 0;

    /**
     * Solver-level contact filter, or null for none. Only colliders carrying
     * `ActiveHooks.FILTER_CONTACT_PAIRS` reach it, so a world with no such
     * collider pays nothing. The ground plane installs one so a shot passes
     * over a cliff wall it is flying above (see PlaneLockedPhysics).
     */
    private hooks: RAPIER2D.PhysicsHooks | null = null;

    private preStepCallbacks: Set<(dt: number) => void> = new Set();
    private postStepCallbacks: Set<() => void> = new Set();

    constructor(gravity: { x: number; y: number } = { x: 0, y: -30 }) {
        const R = getRapier2D();
        this.world = new R.World({ x: gravity.x, y: gravity.y });
        this.eventQueue = new R.EventQueue(true);
    }

    step(deltaTime: number): void {
        if (this.isWorldDisposed) return;
        this.processPendingRemovals();

        for (const callback of this.preStepCallbacks) {
            callback(deltaTime);
        }

        this.world.timestep = deltaTime;
        this.world.step(this.eventQueue, this.hooks ?? undefined);
        this.stepsTaken++;

        // Drain events and build ContactInfo2D data only — NO callbacks fire
        // here.  Game callbacks are dispatched later via flushCollisionCallbacks()
        // so that all Rapier world mutations (createRigidBody, createCollider,
        // setEnabled, applyImpulse, removeRigidBody) happen in a completely
        // clean context after the step has fully returned.
        this.collectCollisionEvents();

        for (const callback of this.postStepCallbacks) {
            callback();
        }
    }

    /**
     * Fire all collision callbacks collected during the last step().
     * Must be called AFTER step() returns — never from inside step().
     * Game code in these callbacks is free to call any Rapier API
     * (createRigidBody, createCollider, removeRigidBody, applyImpulse, etc.)
     * without risking WASM borrow conflicts.
     */
    flushCollisionCallbacks(): void {
        if (this.pendingCallbacks.length === 0) return;
        const batch = this.pendingCallbacks;
        this.pendingCallbacks = [];

        this.stepping = true;
        try {
            for (const { cb, info } of batch) {
                cb(info);
            }
        } finally {
            this.stepping = false;
        }
    }

    /** Install (or clear) the solver-level contact filter — see the `hooks` field. */
    setPhysicsHooks(hooks: RAPIER2D.PhysicsHooks | null): void {
        this.hooks = hooks;
    }

    /** Subscribe to sensor (trigger) overlaps — see {@link SensorIntersectionListener2D}. */
    addSensorListener(listener: SensorIntersectionListener2D): void {
        this.sensorListeners.add(listener);
    }

    removeSensorListener(listener: SensorIntersectionListener2D): void {
        this.sensorListeners.delete(listener);
    }

    /**
     * The shared kinematic character controller, configured for VOXEL geometry.
     *
     * Mirrors `PhysicsWorld.getCharacterController()` with ONE deliberate
     * difference: no `setNormalNudgeFactor(0.01)`. That value is an anti-seam
     * remedy for 3D trimesh terrain, where a capsule re-penetrates the next quad
     * edge of the same greedy-meshed face mid-slide. A 2D slice is a soup of
     * CONVEX cuboids with no internal edges to catch on, and the same nudge
     * measurably fights autostep against a cuboid lip — so it is left at the
     * Rapier default here rather than copied across out of symmetry.
     *
     * Autostep is configured but deliberately NOT relied on: rapier2d's
     * controller has a dead band around a 0.40-0.55 m rise that rapier3d does
     * not, and it is not tunable away. Callers that must climb voxel curbs
     * should probe the height explicitly, exactly as the 3D lane's
     * `detectStepUp` + controlled lift does.
     */
    getCharacterController(): RAPIER2D.KinematicCharacterController {
        if (!this.characterController) {
            const c = this.world.createCharacterController(0.08);
            c.setApplyImpulsesToDynamicBodies(false);
            c.setSlideEnabled(true);
            c.enableAutostep(0.65, 0.3, false); // maxHeight, minWidth, includeDynamic
            c.enableSnapToGround(0.5);
            c.setMaxSlopeClimbAngle(50 * Math.PI / 180);
            c.setMinSlopeSlideAngle(45 * Math.PI / 180);
            this.characterController = c;
        }
        return this.characterController;
    }

    registerPreStepCallback(callback: (dt: number) => void): void {
        this.preStepCallbacks.add(callback);
    }

    unregisterPreStepCallback(callback: (dt: number) => void): void {
        this.preStepCallbacks.delete(callback);
    }

    registerPostStepCallback(callback: () => void): void {
        this.postStepCallbacks.add(callback);
    }

    unregisterPostStepCallback(callback: () => void): void {
        this.postStepCallbacks.delete(callback);
    }

    private processPendingRemovals(): void {
        for (const collider of this.pendingColliderRemovals) {
            if (collider.isValid()) {
                this.world.removeCollider(collider, true);
            }
        }
        this.pendingColliderRemovals = [];

        for (const body of this.pendingBodyRemovals) {
            if (body.isValid()) {
                this.collisionCallbacks.delete(body.handle);
                this.handleToUserData.delete(body.handle);
                this.world.removeRigidBody(body);
            }
        }
        this.pendingBodyRemovals = [];
    }

    private collectCollisionEvents(): void {
        // Triples, not pairs, and BOTH phases: a sensor that only reports
        // `started` can say "the player entered" but never "the player left", so
        // every trigger built on it latches on first contact. The 3D twin
        // collects the same triple for the same reason.
        const handles: number[] = [];
        this.eventQueue.drainCollisionEvents((handle1, handle2, started) => {
            handles.push(handle1, handle2, started ? 1 : 0);
        });

        // ── Sensor overlaps: dispatched, never dropped. ──
        // Collectibles, interaction zones and water are all sensors; discarding
        // these events is why a 2D game scores nothing when it picks a coin up.
        // Dispatched inside the `stepping` guard so a listener that removes a
        // body (a collected coin does exactly that) is deferred rather than
        // mutating the world mid-borrow.
        if (this.sensorListeners.size > 0) {
            this.stepping = true;
            try {
                for (let i = 0; i < handles.length; i += 3) {
                    const c1 = this.world.getCollider(handles[i]!);
                    const c2 = this.world.getCollider(handles[i + 1]!);
                    if (!c1 || !c2) continue;
                    if (!c1.isSensor() && !c2.isSensor()) continue;
                    const started = handles[i + 2] === 1;
                    // Each listener is isolated. One throwing handler must not
                    // swallow the others, nor escape `step()` — in 2D everything
                    // after the physics call, INCLUDING render(), is skipped, so
                    // an exception here freezes the picture every frame with no
                    // message telling the player to reload. A buggy trigger
                    // handler is exactly the code this API exists to run.
                    for (const listener of this.sensorListeners) {
                        try {
                            if (started) listener.onIntersectionStart(c1.handle, c2.handle);
                            else listener.onIntersectionEnd(c1.handle, c2.handle);
                        } catch (error) {
                            console.error('[PhysicsWorld2D] sensor listener threw; continuing', error);
                        }
                    }
                }
            } finally {
                this.stepping = false;
            }
        }

        for (let i = 0; i < handles.length; i += 3) {
            const h1 = handles[i]!;
            const h2 = handles[i + 1]!;
            if (handles[i + 2] !== 1) continue; // contacts are a start-only concern

            const collider1 = this.world.getCollider(h1);
            const collider2 = this.world.getCollider(h2);
            if (!collider1 || !collider2) continue;
            if (collider1.isSensor() || collider2.isSensor()) continue;

            const body1 = collider1.parent();
            const body2 = collider2.parent();
            if (!body1 || !body2) continue;

            const body1Handle = body1.handle;
            const body2Handle = body2.handle;

            const contactInfo: ContactInfo2D = {
                bodyA: body1,
                bodyB: body2,
                colliderA: collider1,
                colliderB: collider2,
                contactPoint: new THREE.Vector2(),
                contactNormal: new THREE.Vector2(),
                penetrationDepth: 0,
            };
            const otherContactPoint = new THREE.Vector2();

            this.world.contactPair(collider1, collider2, (manifold, flipped) => {
                const normal = manifold.normal();
                contactInfo.contactNormal.set(
                    flipped ? -normal.x : normal.x,
                    flipped ? -normal.y : normal.y,
                );

                const numPoints = manifold.numSolverContacts();
                if (numPoints > 0) {
                    const point = manifold.solverContactPoint(0);
                    if (point) {
                        contactInfo.contactPoint.set(point.x, point.y);
                    }
                    contactInfo.penetrationDepth = manifold.solverContactDist(0) ?? 0;
                }
                otherContactPoint.copy(contactInfo.contactPoint);
                // Speculative CCD solver points lie midway across an OPEN
                // gap. Decals/impacts need the other collider's surface, not
                // a floating midpoint. Local witnesses also preserve the
                // correct point for the callback with the bodies reversed.
                if (manifold.numContacts() > 0) {
                    const onA = flipped ? manifold.localContactPoint2(0) : manifold.localContactPoint1(0);
                    const onB = flipped ? manifold.localContactPoint1(0) : manifold.localContactPoint2(0);
                    const worldPoint = (local: RAPIER2D.Vector, collider: RAPIER2D.Collider, out: THREE.Vector2) => {
                        const angle = collider.rotation(), at = collider.translation();
                        out.set(local.x * Math.cos(angle) - local.y * Math.sin(angle) + at.x,
                            local.x * Math.sin(angle) + local.y * Math.cos(angle) + at.y);
                    };
                    if (onB) worldPoint(onB, collider2, contactInfo.contactPoint);
                    if (onA) worldPoint(onA, collider1, otherContactPoint);
                }
            });

            const callbacks1 = this.collisionCallbacks.get(body1Handle);
            const callbacks2 = this.collisionCallbacks.get(body2Handle);

            if (callbacks1) {
                for (const cb of callbacks1) this.pendingCallbacks.push({ cb, info: contactInfo });
            }
            if (callbacks2) {
                const flipped: ContactInfo2D = {
                    bodyA: body2,
                    bodyB: body1,
                    colliderA: collider2,
                    colliderB: collider1,
                    contactPoint: otherContactPoint,
                    contactNormal: contactInfo.contactNormal.clone().negate(),
                    penetrationDepth: contactInfo.penetrationDepth,
                };
                for (const cb of callbacks2) this.pendingCallbacks.push({ cb, info: flipped });
            }
        }
    }

    createRigidBody(desc: RAPIER2D.RigidBodyDesc): RAPIER2D.RigidBody {
        return this.world.createRigidBody(desc);
    }

    createCollider(desc: RAPIER2D.ColliderDesc, parent: RAPIER2D.RigidBody): RAPIER2D.Collider {
        return this.world.createCollider(desc, parent);
    }

    removeRigidBody(body: RAPIER2D.RigidBody): void {
        if (!body.isValid()) return;
        if (!this.pendingBodyRemovals.includes(body)) {
            this.pendingBodyRemovals.push(body);
        }
    }

    removeCollider(collider: RAPIER2D.Collider): void {
        if (!collider.isValid()) return;
        if (!this.pendingColliderRemovals.includes(collider)) {
            this.pendingColliderRemovals.push(collider);
        }
    }

    removeRigidBodyImmediate(body: RAPIER2D.RigidBody): void {
        if (!body.isValid()) return;
        if (this.stepping) {
            this.removeRigidBody(body);
            return;
        }
        this.collisionCallbacks.delete(body.handle);
        this.handleToUserData.delete(body.handle);
        this.world.removeRigidBody(body);
    }

    removeColliderImmediate(collider: RAPIER2D.Collider): void {
        if (!collider.isValid()) return;
        if (this.stepping) {
            this.removeCollider(collider);
            return;
        }
        this.world.removeCollider(collider, true);
    }

    registerCollisionCallback(body: RAPIER2D.RigidBody, callback: CollisionCallback2D): void {
        const callbacks = this.collisionCallbacks.get(body.handle);
        if (callbacks) callbacks.push(callback);
        else this.collisionCallbacks.set(body.handle, [callback]);
    }

    unregisterCollisionCallback(body: RAPIER2D.RigidBody, callback: CollisionCallback2D): void {
        const callbacks = this.collisionCallbacks.get(body.handle);
        const index = callbacks?.indexOf(callback) ?? -1;
        if (callbacks && index !== -1) callbacks.splice(index, 1);
    }

    setUserData(body: RAPIER2D.RigidBody, userData: unknown): void {
        this.handleToUserData.set(body.handle, userData);
    }

    getUserData(body: RAPIER2D.RigidBody): unknown {
        return this.handleToUserData.get(body.handle);
    }

    getUserDataFromHandle(handle: number): unknown {
        return this.handleToUserData.get(handle);
    }

    forEachUserData(callback: (handle: number, userData: unknown) => void): void {
        for (const [handle, data] of this.handleToUserData.entries()) {
            callback(handle, data);
        }
    }

    getBodyTranslation(handle: number): { x: number; y: number } | null {
        const body = this.world.getRigidBody(handle);
        if (!body) return null;
        return body.translation();
    }

    /**
     * Cast a ray in 2D space. Origin and direction use X/Y (the gameplay plane).
     * Uses the same collision-mask pattern as the 3D PhysicsWorld: the ray is a
     * member of all groups (0xFFFF) and detects only the specified mask.
     */
    raycast(
        origin: { x: number; y: number },
        direction: { x: number; y: number },
        maxDistance: number = 1000,
        collisionMask: number = 0xFFFF,
    ): RaycastResult2D {
        const result: RaycastResult2D = {
            hasHit: false,
            hitPoint: new THREE.Vector2(),
            hitNormal: new THREE.Vector2(),
            hitDistance: Infinity,
            hitCollider: null,
            hitRigidBody: null,
        };

        if (this.isWorldDisposed || !isRapier2DReady()) return result;

        const R = getRapier2D();
        const ray = new R.Ray(
            { x: origin.x, y: origin.y },
            { x: direction.x, y: direction.y },
        );

        // Rapier filterGroups: (collidesWith << 16) | memberOf
        // Ray is member of all groups, collides with the specified mask
        const filterGroups = (collisionMask << 16) | 0xFFFF;

        // EXCLUDE_SENSORS, not a post-hoc rejection of the hit. Aborting when the
        // NEAREST hit happened to be a sensor reported "nothing there" and threw
        // away the solid geometry behind it — so a ground probe that clipped a
        // trigger (water is a sensor, and its collider is a member of every group,
        // so even a narrow GROUND_CHECK mask cannot filter it) reported airborne
        // and the character sank and stuck, unable to auto-step out because
        // auto-step needs `grounded`. The 3D twin has always filtered instead.
        const filterFlags = R.QueryFilterFlags.EXCLUDE_SENSORS;

        const hit = this.world.castRayAndGetNormal(
            ray,
            maxDistance,
            true,
            filterFlags,
            filterGroups,
        );

        if (hit) {
            result.hasHit = true;
            result.hitDistance = hit.timeOfImpact;
            result.hitCollider = hit.collider;
            result.hitRigidBody = hit.collider.parent();
            result.hitPoint.set(
                origin.x + direction.x * hit.timeOfImpact,
                origin.y + direction.y * hit.timeOfImpact,
            );
            result.hitNormal.set(hit.normal.x, hit.normal.y);
        }

        return result;
    }

    getGravity(): { x: number; y: number } {
        const g = this.world.gravity;
        return { x: g.x, y: g.y };
    }

    /** How many steps this world has taken; 0 means no query (raycast, overlap) can hit anything yet. */
    getStepsTaken(): number {
        return this.stepsTaken;
    }

    /** True once dispose() ran — the WASM world is gone and every query must short-circuit. */
    isDisposed(): boolean {
        return this.isWorldDisposed;
    }

    /**
     * Does a vertical capsule at `center` overlap any NON-sensor collider in
     * `collisionMask`? The 2D twin of `PhysicsWorld.capsuleOverlaps` (same
     * semantics: stop on first hit, sensors ignored), used for spawn clearance.
     */
    capsuleOverlaps(
        center: { x: number; y: number },
        radius: number,
        halfHeight: number,
        collisionMask: number,
    ): boolean {
        if (this.isWorldDisposed || !isRapier2DReady()) return false;
        const R = getRapier2D();
        const shape = new R.Capsule(halfHeight, radius);
        // Rapier filterGroups: (collidesWith << 16) | memberOf — member of all groups.
        const filterGroups = (collisionMask << 16) | 0xFFFF;
        let hit = false;
        this.world.intersectionsWithShape(
            center,
            0,
            shape,
            () => { hit = true; return false; },
            undefined,
            filterGroups,
            undefined,
            undefined,
            (collider) => !collider.isSensor(),
        );
        return hit;
    }

    setGravity(gravity: { x: number; y: number }): void {
        this.world.gravity = { x: gravity.x, y: gravity.y };
    }

    getRapierWorld(): RAPIER2D.World {
        return this.world;
    }

    /**
     * Body/collider counts, the same shape the 3D world reports — read by
     * `bitmagic verify`'s snapshot, which used to see only `physicsWorld` and
     * therefore reported a 2D game's physics as "not observed" rather than as
     * whatever it really was.
     */
    getStats(): { rigidBodyCount: number; colliderCount: number } {
        if (this.isWorldDisposed) return { rigidBodyCount: 0, colliderCount: 0 };
        return { rigidBodyCount: this.world.bodies.len(), colliderCount: this.world.colliders.len() };
    }

    dispose(): void {
        if (this.isWorldDisposed) return;
        this.isWorldDisposed = true;
        // Drop everything that holds a reference into the freed world, so a late
        // caller cannot resurrect a listener or replay a queued callback.
        this.sensorListeners.clear();
        this.pendingBodyRemovals = [];
        this.pendingColliderRemovals = [];
        this.pendingCallbacks = [];
        this.characterController = null;
        this.collisionCallbacks.clear();
        this.handleToUserData.clear();
        this.preStepCallbacks.clear();
        this.postStepCallbacks.clear();
        this.world.free();
    }
}
