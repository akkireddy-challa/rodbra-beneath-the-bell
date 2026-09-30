/**
 * Plane-locked physics: the Rapier **2D** world presented through the 3D
 * `PhysicsWorld` / `RAPIER.RigidBody` surface that the character pipeline
 * (PlayerLoader → PlayerController → IPlayerMovement, and later the NPC stack)
 * is written against.
 *
 * WHY A FACADE AND NOT A SECOND CONTROLLER. `PlayerController` is ~3,900 lines
 * of mobile controls, HUD wiring, animation, health, vehicles and the coding-pass
 * API — all of it lane-agnostic except for a dozen `translation()` /
 * `setNextKinematicTranslation()` / `raycast()` calls. A "2D player controller"
 * would either duplicate that file or lose those features (the Physics2D genre's
 * controller did the latter). Instead a 2D game keeps the whole 3D-typed
 * pipeline and hands it these wrappers: every call is forwarded to Rapier 2D
 * with the off-plane axis projected away, and every result gets it back.
 *
 * TWO PLANES (`engine/GameplayPlane.ts` decides which):
 *  - SIDE-ON (`'xy'`, the sidescroller): 2D (x, y) is world (X, Y); world Z is
 *    the locked gameplay plane; gravity is real.
 *  - GROUND PLANE (`'xz'`, top-down): 2D (x, y) is world (X, Z); the 2D world
 *    has no gravity, and world Y is a VIRTUAL axis every body carries
 *    (`PlaneLockedBody.offPlane`). Characters follow the terrain heightmap and
 *    fall, land, step and drop off ledges through `TopDownGround`, which also
 *    turns unclimbable height differences into one-way cliff walls — see
 *    `engine/physics/TopDownGround.ts`.
 *
 * WHAT MAY TALK TO IT. Only code that already runs on the player/character
 * path. A member the wrappers do not implement throws a *named* error on first
 * touch (see `lockSurface`) instead of the "undefined is not a function" a
 * missing shim member would otherwise produce three calls later. The list of
 * members is pinned by `__tests__/PlaneLockedPhysics.test.ts`, which scans the
 * consumer files for `playerBody.<x>(` / `physicsWorld.<x>(` and fails when a
 * new call has no counterpart here — add the member, do not widen the scan.
 *
 * WHAT IT REFUSES. `getRapierWorld()` throws: callers that reach for it build
 * 3D `RAPIER.Ray` objects, and in a single-flavour (2D) bundle the 3D package is
 * a `null` stub — such code must gate on `isPlaneLockedPhysics()` and skip
 * (posture probes, ragdoll) or use `getPhysicsWorld2D()` explicitly.
 *
 * MODULE-SCOPE RULE (PhysicsFlavorAgreement.test.ts): no top-level `RAPIER2D.x`
 * dereference — everything Rapier happens inside methods, after `initRapier2D()`.
 */
import * as THREE from 'three';
import type RAPIER2D from '@dimforge/rapier2d-compat';
import type RAPIER from '@dimforge/rapier3d-compat';
import { getRapier2D } from 'engine/physics/RapierPhysics2D.js';
import type { ContactInfo2D, PhysicsWorld2D } from 'engine/physics/PhysicsWorld2D.js';
import type { ContactInfo, PhysicsWorld, RaycastResult } from 'engine/physics/PhysicsWorld.js';
import type { PhysicsPlane, PlaneOrientation } from 'engine/GameplayPlane.js';
import { CollisionGroup, CollisionMask, makeCollisionGroups } from 'engine/CollisionLayers.js';
import { QUERY_EXCLUDE_SENSORS } from 'engine/physics/QueryFilter.js';
import type { PhysicsBox } from 'engine/VoxelOctreeRenderer.js';
import { envBoxesToGroundCuboids, envBoxesToGroundRects, envBoxesToPlaneCuboids, envSliceFor, type EnvTransform } from 'engine/physics/EnvObject2D.js';
import type { Cuboid2D } from 'engine/physics/VoxelTerrain2D.js';
import { TopDownGround, resolveVerticalMove } from 'engine/physics/TopDownGround.js';

type Vec3Like = { x: number; y: number; z: number };
type Vec3In = { x: number; y: number; z?: number };
type Vec2Like = { x: number; y: number };
type QuatLike = { x: number; y: number; z: number; w: number };

const BRAND = Symbol.for('bitmagic.planeLockedPhysics');

/** Character probes against the static world — the 3D `PLAYER_VS_STATIC_WORLD`. */
const CHARACTER_VS_STATIC_WORLD = makeCollisionGroups(CollisionGroup.PLAYER, CollisionGroup.ENVIRONMENT | CollisionGroup.TERRAIN);

/** Dynamic props on the ground plane have no floor to rub against; damping stands in for ground friction. */
const GROUND_PLANE_PROP_DAMPING = 3.0;

/** The heightmap source a terrain-registered object feeds, keyed by its body. */
function terrainSourceId(bodyHandle: number): string {
    return `terrain#${bodyHandle}`;
}

/**
 * The trigger-ball collider every 2D sensor is built from — its own fixed body
 * (`createSensorBall`) or an existing one (`attachSensorBall`).
 *
 * Collision events AND all active collision types: a sensor against the
 * kinematic character body reports NOTHING without them, the same requirement
 * the 3D `CollectibleComponent` and `InteractableComponent` meet. Mass zero for
 * the same reason they set it — a trigger must not weigh on the body it rides.
 */
function sensorBallDesc(options: { radius: number; collisionGroups: number }): RAPIER2D.ColliderDesc {
    const R = getRapier2D();
    return R.ColliderDesc.ball(options.radius)
        .setSensor(true)
        .setMass(0)
        .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS)
        .setActiveCollisionTypes(R.ActiveCollisionTypes.ALL)
        .setCollisionGroups(options.collisionGroups);
}

/**
 * Property names that runtimes, test frameworks and `await` probe on ANY object;
 * answering `undefined` for these keeps `lockSurface` from throwing on a
 * `console.log(body)` or a jest diff.
 */
const PROBED_PROPERTIES = new Set<string>([
    'then', 'toJSON', 'constructor', '$$typeof', 'nodeType', 'asymmetricMatch',
    'tagName', 'toString', 'valueOf', 'inspect', 'length', '@@__IMMUTABLE_ITERABLE__@@',
    '@@__IMMUTABLE_RECORD__@@', '_isMockFunction', 'getMockName', 'mock', 'calls',
]);

/**
 * Wrap a facade object so that reading a member it does not implement throws a
 * named error. Rapier's own objects would answer `undefined`, and the failure
 * would surface as "x is not a function" somewhere down the frame with no hint
 * that the 2D lane was involved.
 */
function lockSurface<T extends object>(target: T, kind: string): T {
    return new Proxy(target, {
        get(t, prop, receiver) {
            if (typeof prop === 'symbol' || prop in t) return Reflect.get(t, prop, receiver);
            if (PROBED_PROPERTIES.has(prop)) return undefined;
            throw new Error(
                `[PlaneLockedPhysics] ${kind}.${prop} is not implemented on the 2D lane — ` +
                `add it to engine/physics/PlaneLockedPhysics.ts (and its scan test) or gate the caller with isPlaneLockedPhysics().`,
            );
        },
    });
}

/** The 3D capsule a character was created with — what the movers read off `collider.shape` on either plane. */
export interface CharacterDims {
    radius: number;
    /** Cylinder half-height (Rapier convention: excludes the hemispheres). */
    halfHeight: number;
}

/** A Rapier 2D collider seen through the 3D collider surface. */
export class PlaneLockedCollider {
    /** Set on character capsules; shared with the body wrapper. */
    characterDims: CharacterDims | null = null;

    constructor(readonly raw: RAPIER2D.Collider, private readonly owner: PlaneLockedPhysics) {}

    get handle(): number { return this.raw.handle; }
    isValid(): boolean { return this.raw.isValid(); }
    isSensor(): boolean { return this.raw.isSensor(); }
    setSensor(sensor: boolean): void { this.raw.setSensor(sensor); }
    isEnabled(): boolean { return this.raw.isEnabled(); }
    setEnabled(enabled: boolean): void { this.raw.setEnabled(enabled); }
    /** Capsule/ball radius. */
    radius(): number { return this.characterDims ? this.characterDims.radius : this.raw.radius(); }
    setRadius(radius: number): void {
        this.raw.setRadius(radius);
        if (this.characterDims) this.characterDims.radius = radius;
    }
    /** Capsule cylinder half-height. On the ground plane the collider is a ball; the height is the virtual axis's. */
    halfHeight(): number { return this.characterDims ? this.characterDims.halfHeight : this.raw.halfHeight(); }
    setHalfHeight(halfHeight: number): void {
        if (this.characterDims) this.characterDims.halfHeight = halfHeight;
        if (this.owner.orientation === 'xy' || !this.characterDims) this.raw.setHalfHeight(halfHeight);
    }
    friction(): number { return this.raw.friction(); }
    setFriction(friction: number): void { this.raw.setFriction(friction); }
    restitution(): number { return this.raw.restitution(); }
    setRestitution(restitution: number): void { this.raw.setRestitution(restitution); }
    collisionGroups(): number { return this.raw.collisionGroups(); }
    setCollisionGroups(groups: number): void { this.raw.setCollisionGroups(groups); }
    setActiveEvents(events: number): void { this.raw.setActiveEvents(events); }
    setActiveCollisionTypes(types: number): void { this.raw.setActiveCollisionTypes(types); }
    translation(): Vec3Like {
        const p = this.raw.parent();
        return this.owner.lift(this.raw.translation(), p ? this.owner.wrapBody(p).offPlane : this.owner.defaultOffPlane());
    }
    parent(): PlaneLockedBody | null { const p = this.raw.parent(); return p ? this.owner.wrapBody(p) : null; }
    /** The shape the movers read `radius` / `halfHeight` from: the character's 3D capsule on either plane. */
    get shape(): RAPIER2D.Shape {
        const dims = this.characterDims;
        if (!dims || this.owner.orientation === 'xy') return this.raw.shape;
        return { type: this.raw.shape.type, radius: dims.radius, halfHeight: dims.halfHeight } as unknown as RAPIER2D.Shape;
    }
}

/** A Rapier 2D rigid body seen through the 3D rigid-body surface. */
export class PlaneLockedBody {
    /**
     * The coordinate the 2D world does not simulate: world Z on the side-on
     * plane (always the gameplay plane), the VIRTUAL world Y on the ground plane
     * (set by every translation write; followed to the terrain for characters).
     */
    offPlane: number;
    /** Character capsules only (shared with the collider wrapper). */
    characterDims: CharacterDims | null = null;
    /** Ground plane: the last vertical solve's grounded flag (feeds snap-to-ground). */
    grounded = false;

    constructor(readonly raw: RAPIER2D.RigidBody, private readonly owner: PlaneLockedPhysics, offPlane: number) {
        this.offPlane = offPlane;
    }

    get handle(): number { return this.raw.handle; }
    get userData(): unknown { return this.raw.userData; }
    set userData(value: unknown) { this.raw.userData = value; }
    isValid(): boolean { return this.raw.isValid(); }

    translation(): Vec3Like { return this.owner.lift(this.raw.translation(), this.offPlane); }
    setTranslation(p: Vec3In, wakeUp: boolean = true): void {
        this.raw.setTranslation(this.owner.project(p), wakeUp);
        this.owner.storeOffPlane(this, p);
    }
    setNextKinematicTranslation(p: Vec3In): void {
        this.raw.setNextKinematicTranslation(this.owner.project(p));
        this.owner.storeOffPlane(this, p);
    }
    nextTranslation(): Vec3Like { return this.owner.lift(this.raw.nextTranslation(), this.offPlane); }

    linvel(): Vec3Like { return this.owner.liftDir(this.raw.linvel()); }
    setLinvel(v: Vec3In, wakeUp: boolean = true): void {
        this.raw.setLinvel(this.owner.projectDir(v), wakeUp);
    }
    /** 2D spin is a scalar about the plane normal; reported on that axis (Z side-on, Y on the ground plane). */
    angvel(): Vec3Like { return this.owner.spinToAngvel(this.raw.angvel()); }
    setAngvel(v: { x?: number; y?: number; z?: number }, wakeUp: boolean = true): void {
        this.raw.setAngvel(this.owner.angvelToSpin(v), wakeUp);
    }
    rotation(): QuatLike { return this.owner.spinToQuat(this.raw.rotation()); }
    setRotation(q: QuatLike, wakeUp: boolean = true): void {
        this.raw.setRotation(this.owner.quatToSpin(q), wakeUp);
    }
    setNextKinematicRotation(q: QuatLike): void {
        this.raw.setNextKinematicRotation(this.owner.quatToSpin(q));
    }
    nextRotation(): QuatLike { return this.owner.spinToQuat(this.raw.nextRotation()); }

    gravityScale(): number { return this.raw.gravityScale(); }
    setGravityScale(scale: number, wakeUp: boolean = true): void { this.raw.setGravityScale(scale, wakeUp); }
    mass(): number { return this.raw.mass(); }
    wakeUp(): void { this.raw.wakeUp(); }
    sleep(): void { this.raw.sleep(); }
    isSleeping(): boolean { return this.raw.isSleeping(); }
    isMoving(): boolean { return this.raw.isMoving(); }
    setEnabled(enabled: boolean): void { this.raw.setEnabled(enabled); }
    isEnabled(): boolean { return this.raw.isEnabled(); }
    bodyType(): number { return this.raw.bodyType(); }
    isKinematic(): boolean { return this.raw.isKinematic(); }
    isDynamic(): boolean { return this.raw.isDynamic(); }
    isFixed(): boolean { return this.raw.isFixed(); }
    numColliders(): number { return this.raw.numColliders(); }
    collider(i: number): PlaneLockedCollider { return this.owner.wrapCollider(this.raw.collider(i)); }
    lockRotations(locked: boolean, wakeUp: boolean = true): void { this.raw.lockRotations(locked, wakeUp); }
    lockTranslations(locked: boolean, wakeUp: boolean = true): void { this.raw.lockTranslations(locked, wakeUp); }
    applyImpulse(v: Vec3In, wakeUp: boolean = true): void {
        this.raw.applyImpulse(this.owner.projectDir(v), wakeUp);
    }
    addForce(v: Vec3In, wakeUp: boolean = true): void {
        this.raw.addForce(this.owner.projectDir(v), wakeUp);
    }
    resetForces(wakeUp: boolean = true): void { this.raw.resetForces(wakeUp); }
    resetTorques(wakeUp: boolean = true): void { this.raw.resetTorques(wakeUp); }
    linearDamping(): number { return this.raw.linearDamping(); }
    setLinearDamping(damping: number): void { this.raw.setLinearDamping(damping); }
}

export interface CharacterCapsule2DOptions {
    /** Capsule CENTRE, in world space (the off-plane coordinate is kept, not simulated). */
    x: number;
    y: number;
    z: number;
    radius: number;
    /** Cylinder half-height (Rapier convention: excludes the hemispheres). */
    halfHeight: number;
    collisionGroup: number;
    collisionMask: number;
    friction: number;
}

export const DEFAULT_CHARACTER_CAPSULE_2D: Omit<CharacterCapsule2DOptions, 'x' | 'y' | 'z' | 'radius' | 'halfHeight'> = {
    collisionGroup: CollisionGroup.PLAYER,
    collisionMask: CollisionMask.PLAYER,
    friction: 0.4,
};

export interface EnvironmentColliders2DOptions {
    /** The object's greedy-meshed boxes in its LOCAL frame (`VoxelObject.getPhysicsBoxes()`). */
    boxes: readonly PhysicsBox[];
    /** Where the object sits in the world; the boxes are transformed by it before slicing. */
    transform: EnvTransform;
    /** Packed Rapier groups (`makeCollisionGroups`). */
    collisionGroups: number;
    friction: number;
    restitution: number;
}

export interface EnvironmentBody2DOptions extends EnvironmentColliders2DOptions {
    /** `'fixed'` for placed props; a dynamic prop carries its target mass. */
    kind: 'fixed' | { dynamic: { mass: number } };
    /** Stored through `setUserData` (the env-instance/voxelObject record hit tracing reads). */
    userData?: unknown;
    /**
     * The object IS terrain (`VoxelObject.createPhysicsBody({ asTerrain: true })`, a
     * baked level map). On the ground plane its boxes feed the heightmap as
     * floor instead of becoming an obstacle band; side-on it is sliced like any
     * other object.
     */
    terrain?: boolean;
}

export interface SensorBall2DOptions {
    /** World-space centre. */
    x: number;
    y: number;
    z: number;
    radius: number;
    collisionGroups: number;
}

/** A shot in flight — see {@link PlaneLockedPhysics.createProjectileBody}. */
export interface ProjectileBody2DOptions {
    /** Muzzle position in world space; off-plane it fixes the height the shot flies at. */
    x: number;
    y: number;
    z: number;
    /** World-space velocity (direction x speed); only its in-plane part flies. */
    velocity: Vec3In;
    radius: number;
    /** Packed Rapier groups (`makeCollisionGroups`). */
    collisionGroups: number;
    /** Side-on only; the ground plane's 2D world has no gravity (see createProjectileBody). */
    gravityScale: number;
}

/** One collision reported by the character controller, in the 3D shape the movers read. */
export interface PlaneLockedCharacterCollision {
    collider: PlaneLockedCollider | null;
    translationDeltaApplied: Vec3Like;
    translationDeltaRemaining: Vec3Like;
    toi: number;
    witness1: Vec3Like;
    witness2: Vec3Like;
    normal1: Vec3Like;
    normal2: Vec3Like;
}

/**
 * The shared Rapier 2D `KinematicCharacterController` behind the 3D surface the
 * character movers drive (`WalkingAndJumpingMovement`, `AnimalLocomotion3D`):
 * desired translations lose the off-plane axis, computed movement and contact
 * normals get it back.
 *
 * On the ground plane the vertical part of every solve is answered here, not
 * by Rapier: the desired Y motion (the mover's integrated gravity, or a jump)
 * meets the terrain rest height under the destination (`resolveVerticalMove`),
 * and cliff walls the character stands above are filtered out of the
 * collide-and-slide so a ledge can be walked off but not walked into.
 */
export class PlaneLockedCharacterController {
    private lastVertical = 0;
    private lastGrounded = false;

    constructor(readonly raw: RAPIER2D.KinematicCharacterController, private readonly owner: PlaneLockedPhysics) {}

    computeColliderMovement(
        collider: unknown,
        desired: Vec3Like,
        filterFlags?: number,
        filterGroups?: number,
        filterPredicate?: (collider: PlaneLockedCollider) => boolean,
    ): void {
        const raw = this.owner.unwrapCollider(collider);
        const flags = filterFlags as RAPIER2D.QueryFilterFlags | undefined;
        if (this.owner.orientation === 'xy') {
            this.raw.computeColliderMovement(
                raw, { x: desired.x, y: desired.y }, flags, filterGroups,
                filterPredicate ? (c) => filterPredicate(this.owner.wrapCollider(c)) : undefined,
            );
            return;
        }
        const ground = this.owner.ground!;
        const parent = raw.parent();
        const body = parent ? this.owner.wrapBody(parent) : null;
        const dims = this.owner.wrapCollider(raw).characterDims ?? body?.characterDims ?? null;
        const centerToFeet = dims ? dims.halfHeight + dims.radius : 0;
        const centerY = body ? body.offPlane : 0;
        const feetY = centerY - centerToFeet;
        this.raw.computeColliderMovement(
            raw, { x: desired.x, y: desired.z }, flags, filterGroups,
            (c) => ground.ledgeBlocks(c.handle, feetY) && (!filterPredicate || filterPredicate(this.owner.wrapCollider(c))),
        );
        const m = this.raw.computedMovement();
        const p = raw.translation();
        const floor = ground.heightAt(p.x + m.x, p.y + m.y);
        const restY = floor === null ? null : floor + centerToFeet + this.raw.offset();
        const move = resolveVerticalMove(centerY, desired.y, restY, body ? body.grounded : false);
        this.lastVertical = move.dy;
        this.lastGrounded = move.grounded;
        if (body) body.grounded = move.grounded;
    }
    computedMovement(): Vec3Like {
        const m = this.raw.computedMovement();
        if (this.owner.orientation === 'xy') return { x: m.x, y: m.y, z: 0 };
        return { x: m.x, y: this.lastVertical, z: m.y };
    }
    computedGrounded(): boolean { return this.owner.orientation === 'xy' ? this.raw.computedGrounded() : this.lastGrounded; }
    numComputedCollisions(): number { return this.raw.numComputedCollisions(); }
    computedCollision(i: number): PlaneLockedCharacterCollision | null {
        const c = this.raw.computedCollision(i);
        if (!c) return null;
        const v = (p: Vec2Like): Vec3Like => this.owner.liftDir(p);
        return {
            collider: c.collider ? this.owner.wrapCollider(c.collider) : null,
            translationDeltaApplied: v(c.translationDeltaApplied),
            translationDeltaRemaining: v(c.translationDeltaRemaining),
            toi: c.toi,
            witness1: v(c.witness1),
            witness2: v(c.witness2),
            normal1: v(c.normal1),
            normal2: v(c.normal2),
        };
    }
    // Autostep, snap-to-ground and the slope limits are vertical-axis features.
    // On the ground plane the vertical axis is virtual, so the raw controller is
    // pinned to "slide along everything" once (see getCharacterController) and
    // the movers' per-frame toggles are accepted and ignored.
    enableAutostep(maxHeight: number, minWidth: number, includeDynamicBodies: boolean): void {
        if (this.owner.orientation === 'xy') this.raw.enableAutostep(maxHeight, minWidth, includeDynamicBodies);
    }
    disableAutostep(): void { this.raw.disableAutostep(); }
    autostepEnabled(): boolean { return this.raw.autostepEnabled(); }
    enableSnapToGround(distance: number): void {
        if (this.owner.orientation === 'xy') this.raw.enableSnapToGround(distance);
    }
    disableSnapToGround(): void { this.raw.disableSnapToGround(); }
    snapToGroundEnabled(): boolean { return this.raw.snapToGroundEnabled(); }
    setSlideEnabled(enabled: boolean): void { this.raw.setSlideEnabled(enabled); }
    slideEnabled(): boolean { return this.raw.slideEnabled(); }
    setApplyImpulsesToDynamicBodies(enabled: boolean): void { this.raw.setApplyImpulsesToDynamicBodies(enabled); }
    setCharacterMass(mass: number): void { this.raw.setCharacterMass(mass); }
    setMaxSlopeClimbAngle(angle: number): void {
        if (this.owner.orientation === 'xy') this.raw.setMaxSlopeClimbAngle(angle);
    }
    setMinSlopeSlideAngle(angle: number): void {
        if (this.owner.orientation === 'xy') this.raw.setMinSlopeSlideAngle(angle);
    }
    setNormalNudgeFactor(factor: number): void { this.raw.setNormalNudgeFactor(factor); }
    offset(): number { return this.raw.offset(); }
    setOffset(value: number): void { this.raw.setOffset(value); }
}

/** One candidate hit of a 3D ray on this lane, before the nearest is chosen. */
interface RayCandidate {
    t: number;
    normal: Vec3Like;
    collider: RAPIER2D.Collider | null;
}

/**
 * The 3D `PhysicsWorld` surface over a `PhysicsWorld2D`. Construct through
 * `createPlaneLockedPhysics` so unknown members throw by name.
 */
export class PlaneLockedPhysics {
    readonly [BRAND] = true;
    readonly lane = '2d' as const;
    readonly orientation: PlaneOrientation;
    /** Side-on: the world Z every body reports. Ground plane: 0. */
    readonly planeZ: number;
    /** Ground plane only: the terrain heightmap + cliff walls the vertical axis is answered from. */
    readonly ground: TopDownGround | null;
    // Private members are named so they never collide with PhysicsWorld's: a
    // `isPlaneLockedPhysics()` narrowing of a PhysicsWorld-typed value forms the
    // intersection of both classes, and TypeScript reduces it to `never` when
    // the two declare a private of the same name.
    private readonly planeBodies = new Map<number, PlaneLockedBody>();
    private readonly planeColliders = new Map<number, PlaneLockedCollider>();
    private planeCharacterController: PlaneLockedCharacterController | null = null;
    private readonly planeColliderUserData = new Map<number, unknown>();
    /** Ground plane: world-Y top of each placed-object cuboid (what a vertical probe over it reports). */
    private readonly planeColliderTops = new Map<number, number>();
    /** Ground plane: bodies of the shots in the air, whose flight height the contact filter judges walls against. */
    private readonly planeShots = new Set<number>();
    /**
     * Per body, the translating wrapper each caller's contact callback was
     * registered with — so it can be unregistered, and so a body's entries go
     * when the body does (a shooter registers one per shot fired).
     */
    private readonly planeContactCallbacks = new Map<number, Map<(contact: ContactInfo) => void, (contact: ContactInfo2D) => void>>();
    /** Ground plane: the gravity the 3D readers see; the 2D world itself has none. */
    private readonly planeVirtualGravity = new THREE.Vector3(0, -9.81, 0);
    /** Parity with `PhysicsWorld.lastStepSubstepCount` (GameEngine writes it each idle frame). */
    lastStepSubstepCount = 1;

    constructor(readonly world2D: PhysicsWorld2D, plane: PhysicsPlane) {
        this.orientation = plane.orientation;
        this.planeZ = plane.orientation === 'xy' ? plane.planeZ : 0;
        this.ground = plane.orientation === 'xz' ? new TopDownGround(world2D) : null;
        if (this.ground) world2D.setPhysicsHooks(this.shotContactFilter());
    }

    /**
     * The ground plane's one-way rule, in the solver: a shot never collides with
     * a cliff wall whose top it is flying OVER — that wall is a ledge under it,
     * exactly as `ledgePredicate` sees it from a query. Filtering here rather
     * than dropping the contact event afterwards is what lets the shot fly ON:
     * an event the facade merely ignores still leaves the wall standing in the
     * bullet's way, and the bullet parked against it.
     *
     * Only shot colliders carry `ActiveHooks.FILTER_CONTACT_PAIRS`
     * (`createProjectileBody`), so every other pair in the world skips this.
     */
    private shotContactFilter(): RAPIER2D.PhysicsHooks {
        return {
            filterContactPair: (collider1, collider2, body1, body2): RAPIER2D.SolverFlags | null => {
                const solve = getRapier2D().SolverFlags.COMPUTE_IMPULSE;
                const ground = this.ground;
                if (!ground) return solve;
                if (this.planeShots.has(body1) && !ground.ledgeBlocks(collider2, this.shotHeight(body1), 0)) return null;
                if (this.planeShots.has(body2) && !ground.ledgeBlocks(collider1, this.shotHeight(body2), 0)) return null;
                return solve;
            },
            filterIntersectionPair: (): boolean => true,
        };
    }

    /** The height a shot is flying at (its virtual Y); 0 for a body this lane has forgotten. */
    private shotHeight(bodyHandle: number): number {
        return this.planeBodies.get(bodyHandle)?.offPlane ?? 0;
    }

    getPhysicsWorld2D(): PhysicsWorld2D { return this.world2D; }

    // ---- the projection ---------------------------------------------------------

    /** A 3D point → its 2D image. */
    project(v: Vec3In): Vec2Like {
        return this.orientation === 'xy' ? { x: v.x, y: v.y } : { x: v.x, y: v.z ?? 0 };
    }
    /** A 3D direction / velocity → its in-plane part. */
    projectDir(v: Vec3In): Vec2Like {
        return this.orientation === 'xy' ? { x: v.x, y: v.y } : { x: v.x, y: v.z ?? 0 };
    }
    /** A 2D point + the off-plane coordinate → 3D. */
    lift(p: Vec2Like, offPlane: number): Vec3Like {
        return this.orientation === 'xy' ? { x: p.x, y: p.y, z: this.planeZ } : { x: p.x, y: offPlane, z: p.y };
    }
    /** A 2D direction → 3D with a zero off-plane component. */
    liftDir(p: Vec2Like): Vec3Like {
        return this.orientation === 'xy' ? { x: p.x, y: p.y, z: 0 } : { x: p.x, y: 0, z: p.y };
    }
    /** What a body wrapped from a query (not created here) reports off-plane. */
    defaultOffPlane(): number { return this.orientation === 'xy' ? this.planeZ : 0; }
    /** A translation write carries the virtual Y on the ground plane; side-on the plane Z is fixed. */
    storeOffPlane(body: PlaneLockedBody, p: Vec3In): void {
        if (this.orientation === 'xz') body.offPlane = p.y;
    }
    /** 2D rotation angle → a quaternion about the plane normal (+Z side-on; the 2D basis (X, Z) spins about −Y). */
    spinToQuat(a: number): QuatLike {
        const s = Math.sin(a / 2), c = Math.cos(a / 2);
        return this.orientation === 'xy' ? { x: 0, y: 0, z: s, w: c } : { x: 0, y: -s, z: 0, w: c };
    }
    quatToSpin(q: QuatLike): number {
        return this.orientation === 'xy' ? 2 * Math.atan2(q.z, q.w) : -2 * Math.atan2(q.y, q.w);
    }
    spinToAngvel(a: number): Vec3Like {
        return this.orientation === 'xy' ? { x: 0, y: 0, z: a } : { x: 0, y: -a, z: 0 };
    }
    angvelToSpin(v: { x?: number; y?: number; z?: number }): number {
        return this.orientation === 'xy' ? (v.z ?? 0) : -(v.y ?? 0);
    }

    // ---- wrapping -------------------------------------------------------------

    /** Stable wrapper per handle, so `hit.hitRigidBody === playerBody` identity holds. */
    wrapBody(raw: RAPIER2D.RigidBody, offPlane: number = this.defaultOffPlane()): PlaneLockedBody {
        const existing = this.planeBodies.get(raw.handle);
        if (existing && existing.raw === raw) return existing;
        const wrapped = lockSurface(new PlaneLockedBody(raw, this, offPlane), 'RigidBody');
        this.planeBodies.set(raw.handle, wrapped);
        return wrapped;
    }

    wrapCollider(raw: RAPIER2D.Collider): PlaneLockedCollider {
        const existing = this.planeColliders.get(raw.handle);
        if (existing && existing.raw === raw) return existing;
        const wrapped = lockSurface(new PlaneLockedCollider(raw, this), 'Collider');
        this.planeColliders.set(raw.handle, wrapped);
        return wrapped;
    }

    /** Accept a wrapper or a raw 2D body (both flow through the 3D-typed pipeline). */
    unwrapBody(body: unknown): RAPIER2D.RigidBody {
        if (body instanceof PlaneLockedBody) return body.raw;
        const maybe = body as { raw?: RAPIER2D.RigidBody } | null;
        if (maybe && maybe.raw && typeof maybe.raw.handle === 'number') return maybe.raw;
        return body as RAPIER2D.RigidBody;
    }

    unwrapCollider(collider: unknown): RAPIER2D.Collider {
        if (collider instanceof PlaneLockedCollider) return collider.raw;
        const maybe = collider as { raw?: RAPIER2D.Collider } | null;
        if (maybe && maybe.raw && typeof maybe.raw.handle === 'number') return maybe.raw;
        return collider as RAPIER2D.Collider;
    }

    /**
     * A query predicate that skips the cliff walls something at height `y`
     * passes over (ground plane only): a character's feet with a step of
     * allowance, or a ray with none. See `TopDownGround.ledgeBlocks`.
     */
    private ledgePredicate(y: number, also?: (c: RAPIER2D.Collider) => boolean, allowance?: number): ((c: RAPIER2D.Collider) => boolean) | undefined {
        const ground = this.ground;
        if (!ground) return also;
        return (c) => ground.ledgeBlocks(c.handle, y, allowance) && (!also || also(c));
    }

    // ---- bodies ---------------------------------------------------------------

    /**
     * The character body of this lane: a kinematic position-based body, the
     * same body kind every 3D character uses (see CharacterLoader.createPhysicsBody
     * for why kinematic-position is load-bearing). Side-on it carries the
     * capsule itself; on the ground plane its footprint is a ball of the
     * capsule's radius, and the capsule's height lives on the virtual axis.
     */
    createCharacterCapsule(options: CharacterCapsule2DOptions): PlaneLockedBody {
        const R = getRapier2D();
        const at = this.project(options);
        const bodyDesc = R.RigidBodyDesc.kinematicPositionBased().setTranslation(at.x, at.y);
        const body = this.world2D.createRigidBody(bodyDesc);
        body.lockRotations(true, true);
        const groups = (options.collisionMask << 16) | options.collisionGroup;
        const shape = this.orientation === 'xy'
            ? R.ColliderDesc.capsule(options.halfHeight, options.radius)
            : R.ColliderDesc.ball(options.radius);
        const colliderDesc = shape.setFriction(options.friction).setRestitution(0).setCollisionGroups(groups);
        const dims: CharacterDims = { radius: options.radius, halfHeight: options.halfHeight };
        const collider = this.wrapCollider(this.world2D.createCollider(colliderDesc, body));
        collider.characterDims = dims;
        const wrapped = this.wrapBody(body, this.orientation === 'xy' ? this.planeZ : options.y);
        wrapped.characterDims = dims;
        return wrapped;
    }

    /**
     * A placed object's body: its local boxes carried through the instance
     * transform, sliced to the plane's slab and attached as 2D cuboids. The body
     * sits at the object's projected position with zero rotation — rotation is
     * baked into the cuboids (see EnvObject2D.ts), so a dynamic body still spins
     * correctly about its own origin.
     */
    createEnvironmentBody(options: EnvironmentBody2DOptions): { body: PlaneLockedBody; colliders: PlaneLockedCollider[] } {
        const R = getRapier2D();
        const t = options.transform.translation;
        const at = this.project(t);
        const damping = this.orientation === 'xy' ? 0.1 : GROUND_PLANE_PROP_DAMPING;
        const desc = options.kind === 'fixed'
            ? R.RigidBodyDesc.fixed().setTranslation(at.x, at.y)
            : R.RigidBodyDesc.dynamic().setTranslation(at.x, at.y).setLinearDamping(damping).setAngularDamping(damping);
        const raw = this.world2D.createRigidBody(desc);
        if (options.userData !== undefined) this.world2D.setUserData(raw, options.userData);
        const body = this.wrapBody(raw, this.orientation === 'xy' ? this.planeZ : t.y);
        if (options.terrain && this.ground && options.kind === 'fixed') {
            // Floor, not obstacle: the heightmap (and the cliff walls it derives)
            // is this object's whole collision on the ground plane.
            this.ground.setSourceRects(terrainSourceId(raw.handle), envBoxesToGroundRects(options.boxes, options.transform));
            return { body, colliders: [] };
        }
        const colliders = this.attachEnvironmentColliders(body, options, options.kind === 'fixed' ? null : options.kind.dynamic.mass);
        return { body, colliders };
    }

    /**
     * (Re)attach the sliced cuboids of `options.boxes` to an existing body —
     * the rebuild-after-damage path. With `targetMass` the cuboids share one
     * density so the 2D body's mass lands on the authored value.
     */
    attachEnvironmentColliders(body: PlaneLockedBody, options: EnvironmentColliders2DOptions, targetMass: number | null = null): PlaneLockedCollider[] {
        const R = getRapier2D();
        const origin = body.raw.translation();
        const t = options.transform.translation;
        const cuboids: Array<Cuboid2D & { topY?: number }> = this.orientation === 'xy'
            ? envBoxesToPlaneCuboids(options.boxes, options.transform, envSliceFor(this.planeZ))
            : envBoxesToGroundCuboids(options.boxes, options.transform, this.ground!.heightAt(t.x, t.z));
        let density: number | null = null;
        if (targetMass !== null) {
            let area = 0;
            for (const c of cuboids) area += 4 * c.hx * c.hy;
            density = area > 0 ? targetMass / area : 1;
        }
        const colliders: PlaneLockedCollider[] = [];
        for (const c of cuboids) {
            const desc = R.ColliderDesc.cuboid(c.hx, c.hy)
                .setTranslation(c.x - origin.x, c.y - origin.y)
                .setCollisionGroups(options.collisionGroups)
                .setFriction(options.friction)
                .setRestitution(options.restitution)
                .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS);
            if (density !== null) desc.setDensity(density);
            const raw = this.world2D.createCollider(desc, body.raw);
            if (c.topY !== undefined) this.planeColliderTops.set(raw.handle, c.topY);
            colliders.push(this.wrapCollider(raw));
        }
        return colliders;
    }

    /**
     * A trigger volume (collectible / interaction zone): a fixed body of its own
     * carrying one sensor ball (see `sensorBallDesc` for why its flags matter).
     */
    createSensorBall(options: SensorBall2DOptions): { body: PlaneLockedBody; collider: PlaneLockedCollider } {
        const at = this.project(options);
        const raw = this.world2D.createRigidBody(getRapier2D().RigidBodyDesc.fixed().setTranslation(at.x, at.y));
        const collider = this.wrapCollider(this.world2D.createCollider(sensorBallDesc(options), raw));
        return { body: this.wrapBody(raw, this.orientation === 'xy' ? this.planeZ : options.y), collider };
    }

    /**
     * A trigger ball on an EXISTING body — the moving-trigger case (an NPC's
     * interaction radius rides its character body, so it needs no per-frame
     * sync). Same descriptor as `createSensorBall`, whose event flags are what
     * make a sensor on a kinematic body report at all.
     */
    attachSensorBall(body: unknown, options: { radius: number; collisionGroups: number }): PlaneLockedCollider {
        return this.wrapCollider(this.world2D.createCollider(sensorBallDesc(options), this.unwrapBody(body)));
    }

    /**
     * A shot in flight: the dynamic CCD ball `Projectile.createPhysicsBody`
     * builds in 3D, on this plane. Side-on it arcs under the world's gravity
     * scaled by `gravityScale`; on the ground plane the 2D world has NO gravity,
     * so a shot holds its muzzle height on the virtual axis — which is what a
     * top-down shot should do (a rocket's 0.05 arc must not sink it into the
     * floor it is flying over).
     *
     * Side-on keeps plain CCD: speculative contacts with a nearby floor can
     * disturb an arcing shot. The ground plane has no in-plane floor, and
     * needs a short prediction horizon too: plain Rapier 2D CCD can otherwise
     * report a fast ball only AFTER it has entered the far half of a wall.
     */
    createProjectileBody(options: ProjectileBody2DOptions): PlaneLockedBody {
        const R = getRapier2D();
        const at = this.project(options);
        const v = this.projectDir(options.velocity);
        const raw = this.world2D.createRigidBody(
            R.RigidBodyDesc.dynamic()
                .setTranslation(at.x, at.y)
                .setLinvel(v.x, v.y)
                .setGravityScale(options.gravityScale)
                .setLinearDamping(0)
                .setAngularDamping(0)
                .setCanSleep(false)
                .setCcdEnabled(true),
        );
        if (this.orientation === 'xz') raw.setSoftCcdPrediction(Math.hypot(v.x, v.y) / 30 + options.radius);
        raw.lockRotations(true, true);
        const speed = Math.hypot(options.velocity.x, options.velocity.y, options.velocity.z ?? 0);
        if (Math.hypot(v.x, v.y) < speed * 0.01) {
            // Aimed (all but) straight along the off-plane axis: almost nothing
            // of this shot points anywhere the lane can carry it, so it would
            // crawl or hang at the muzzle for its whole lifetime, which reads as
            // a broken gun. The aim is the bug; name it.
            console.warn(
                '[PlaneLockedPhysics] a shot was aimed along the off-plane axis and cannot travel on this lane — ' +
                'aim it in the gameplay plane (top-down shots fly horizontally, side-on shots in X/Y).',
            );
        }
        const colliderDesc = R.ColliderDesc.ball(options.radius)
            .setFriction(0)
            .setRestitution(0)
            .setCollisionGroups(options.collisionGroups)
            .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS);
        // The body must be registered (with its height) BEFORE the collider can
        // reach the filter — the first step after this call already consults it.
        const body = this.wrapBody(raw, this.orientation === 'xy' ? this.planeZ : options.y);
        if (this.ground) {
            this.planeShots.add(raw.handle);
            colliderDesc.setActiveHooks(R.ActiveHooks.FILTER_CONTACT_PAIRS);
        }
        this.wrapCollider(this.world2D.createCollider(colliderDesc, raw));
        return body;
    }

    /** Parity with `PhysicsWorld.addRigidBody` — a documented no-op there too. */
    addRigidBody(_body: unknown): void { /* bodies are added at creation */ }

    removeRigidBody(body: unknown): void {
        const raw = this.unwrapBody(body);
        this.forgetBody(raw);
        this.world2D.removeRigidBody(raw);
    }
    removeRigidBodyImmediate(body: unknown): void {
        const raw = this.unwrapBody(body);
        this.forgetBody(raw);
        this.world2D.removeRigidBodyImmediate(raw);
    }
    private forgetBody(raw: RAPIER2D.RigidBody): void {
        this.planeBodies.delete(raw.handle);
        this.planeShots.delete(raw.handle);
        this.planeContactCallbacks.delete(raw.handle);
        this.ground?.removeSource(terrainSourceId(raw.handle));
        if (raw.isValid()) {
            for (let i = 0; i < raw.numColliders(); i++) this.planeColliderTops.delete(raw.collider(i).handle);
        }
    }
    removeCollider(collider: unknown): void {
        this.world2D.removeCollider(this.forgetCollider(collider));
    }
    removeColliderImmediate(collider: unknown): void {
        this.world2D.removeColliderImmediate(this.forgetCollider(collider));
    }
    /** Drop a collider from this lane's registries and hand back the raw 2D collider. */
    private forgetCollider(collider: unknown): RAPIER2D.Collider {
        const raw = this.unwrapCollider(collider);
        this.planeColliders.delete(raw.handle);
        this.planeColliderTops.delete(raw.handle);
        return raw;
    }

    setUserData(body: unknown, userData: unknown): void { this.world2D.setUserData(this.unwrapBody(body), userData); }
    getUserData(body: unknown): unknown { return this.world2D.getUserData(this.unwrapBody(body)); }
    getUserDataFromHandle(handle: number): unknown { return this.world2D.getUserDataFromHandle(handle); }
    forEachUserData(callback: (handle: number, userData: unknown) => void): void { this.world2D.forEachUserData(callback); }
    getBodyTranslation(handle: number): Vec3Like | null {
        const t = this.world2D.getBodyTranslation(handle);
        return t ? this.lift(t, this.planeBodies.get(handle)?.offPlane ?? this.defaultOffPlane()) : null;
    }

    // ---- queries --------------------------------------------------------------

    /**
     * A 3D ray on this lane. Its in-plane projection is cast against the 2D
     * world and `hitDistance` stays the 3D ray parameter, so
     * `origin + direction * hitDistance` lands on the reported point. On the
     * ground plane a ray with a downward component also meets the terrain
     * heightmap and the tops of placed objects (what a height probe over a
     * building reports in 3D), and the nearest of all candidates wins; a ray
     * purely along the off-plane axis of the side-on lane can hit nothing.
     */
    raycast(
        origin: Vec3Like,
        direction: Vec3Like,
        maxDistance: number = 1000,
        collisionMask: number = 0xFFFF,
        out?: RaycastResult,
    ): RaycastResult {
        return this.castRay3D(origin, direction, maxDistance, makeCollisionGroups(0xFFFF, collisionMask), QUERY_EXCLUDE_SENSORS, null, out);
    }

    /** `raycast` with explicit membership/mask and excluded bodies (the 3D camera/ground probes' variant). */
    raycastWithFilter(
        origin: Vec3Like, direction: Vec3Like, maxDistance: number, filterGroups: number, filterMask: number,
        excludeBodies?: unknown[], out?: RaycastResult,
    ): RaycastResult {
        const excluded = excludeBodies && excludeBodies.length > 0
            ? new Set(excludeBodies.map((b) => this.unwrapBody(b).handle))
            : null;
        return this.castRay3D(origin, direction, maxDistance, makeCollisionGroups(filterGroups, filterMask), undefined, excluded, out);
    }

    private castRay3D(
        origin: Vec3Like, direction: Vec3Like, maxDistance: number, groups: number, flags: number | undefined,
        excluded: Set<number> | null, out?: RaycastResult,
    ): RaycastResult {
        const result = out ?? {
            hasHit: false,
            hitPoint: new THREE.Vector3(),
            hitNormal: new THREE.Vector3(),
            hitDistance: Infinity,
            hitCollider: null,
            hitRigidBody: null,
        };
        result.hasHit = false;
        result.hitDistance = Infinity;
        result.hitCollider = null;
        result.hitRigidBody = null;
        if (this.world2D.isDisposed()) return result;

        const dir2 = this.projectDir(direction);
        const planarLength = Math.hypot(dir2.x, dir2.y);
        let best: RayCandidate | null = null;
        const R = getRapier2D();
        const world = this.world2D.getRapierWorld();
        const skipExcluded = excluded
            ? (c: RAPIER2D.Collider) => { const p = c.parent(); return !p || !excluded.has(p.handle); }
            : undefined;
        if (planarLength > 1e-9) {
            // Ground plane: a cliff wall the ray starts above is a ledge under it, not a wall in its way.
            const predicate = this.ground ? this.ledgePredicate(origin.y, skipExcluded, 0) : skipExcluded;
            const hit = world.castRayAndGetNormal(
                new R.Ray(this.project(origin), { x: dir2.x / planarLength, y: dir2.y / planarLength }),
                maxDistance * planarLength, true, flags as RAPIER2D.QueryFilterFlags | undefined, groups, undefined, undefined, predicate,
            );
            if (hit) best = { t: hit.timeOfImpact / planarLength, normal: this.liftDir(hit.normal), collider: hit.collider };
        }
        if (this.orientation === 'xz' && direction.y < -1e-9) {
            const groundHit = this.groundRayCandidate(origin, direction, maxDistance, groups, best);
            if (groundHit) best = groundHit;
            if (planarLength <= 1e-9) {
                const topHit = this.objectTopCandidate(origin, direction, maxDistance, groups, flags, skipExcluded, best);
                if (topHit) best = topHit;
            }
        }
        if (!best) return result;
        result.hasHit = true;
        result.hitDistance = best.t;
        result.hitPoint.set(origin.x + direction.x * best.t, origin.y + direction.y * best.t, origin.z + direction.z * best.t);
        if (this.orientation === 'xy') result.hitPoint.z = this.planeZ;
        result.hitNormal.set(best.normal.x, best.normal.y, best.normal.z);
        if (best.collider) {
            result.hitCollider = this.wrapCollider(best.collider) as unknown as RAPIER.Collider;
            const parent = best.collider.parent();
            result.hitRigidBody = parent ? (this.wrapBody(parent) as unknown as RAPIER.RigidBody) : null;
        }
        return result;
    }

    /** Ground plane: where a descending ray meets the terrain heightmap (TERRAIN in the mask), if nearer than `best`. */
    private groundRayCandidate(origin: Vec3Like, direction: Vec3Like, maxDistance: number, groups: number, best: RayCandidate | null): RayCandidate | null {
        const ground = this.ground;
        if (!ground || !((groups >> 16) & CollisionGroup.TERRAIN)) return null;
        const h0 = ground.heightAt(origin.x, origin.z);
        if (h0 === null) return null;
        // One refinement: sample the column the first estimate lands in.
        const t0 = (origin.y - h0) / -direction.y;
        const h1 = ground.heightAt(origin.x + direction.x * t0, origin.z + direction.z * t0) ?? h0;
        const t = (origin.y - h1) / -direction.y;
        if (t < 0 || t > maxDistance || (best && t >= best.t)) return null;
        return { t, normal: { x: 0, y: 1, z: 0 }, collider: null };
    }

    /** Ground plane: the highest placed-object top under a vertical probe (what 3D reports over a roof). */
    private objectTopCandidate(
        origin: Vec3Like, direction: Vec3Like, maxDistance: number, groups: number, flags: number | undefined,
        skip: ((c: RAPIER2D.Collider) => boolean) | undefined, best: RayCandidate | null,
    ): RayCandidate | null {
        if (this.planeColliderTops.size === 0) return null;
        let found: RayCandidate | null = best;
        this.world2D.getRapierWorld().intersectionsWithPoint(
            { x: origin.x, y: origin.z },
            (collider) => {
                const top = this.planeColliderTops.get(collider.handle);
                if (top !== undefined && top <= origin.y) {
                    const t = (origin.y - top) / -direction.y;
                    if (t <= maxDistance && (!found || t < found.t)) found = { t, normal: { x: 0, y: 1, z: 0 }, collider };
                }
                return true;
            },
            flags as RAPIER2D.QueryFilterFlags | undefined, groups, undefined, undefined,
            (c) => !c.isSensor() && (!skip || skip(c)),
        );
        return found === best ? null : found;
    }

    capsuleOverlaps(center: Vec3Like, radius: number, halfHeight: number, collisionMask: number): boolean {
        if (this.orientation === 'xy') return this.world2D.capsuleOverlaps({ x: center.x, y: center.y }, radius, halfHeight, collisionMask);
        const R = getRapier2D();
        const hit = this.world2D.getRapierWorld().intersectionWithShape(
            this.project(center), 0, new R.Ball(radius), undefined, makeCollisionGroups(0xFFFF, collisionMask), undefined, undefined,
            this.ledgePredicate(center.y - halfHeight - radius, (c) => !c.isSensor()),
        );
        return hit !== null;
    }

    /** Handles of every non-sensor collider in `collisionMask` a vertical capsule at `center` overlaps (fills and returns `out`). */
    overlappingColliderHandles(center: Vec3Like, radius: number, halfHeight: number, collisionMask: number, out: Set<number>): Set<number> {
        out.clear();
        const R = getRapier2D();
        this.world2D.getRapierWorld().intersectionsWithShape(
            this.project(center), 0, this.characterProbe(R, radius, halfHeight),
            (collider) => { out.add(collider.handle); return true; },
            undefined, makeCollisionGroups(0xFFFF, collisionMask), undefined, undefined,
            (collider) => !collider.isSensor(),
        );
        return out;
    }

    /** The character's footprint as a 2D query shape: the capsule side-on, its radius as a ball on the ground plane. */
    private characterProbe(R: typeof RAPIER2D, radius: number, halfHeight: number): RAPIER2D.Shape {
        return this.orientation === 'xy' ? new R.Capsule(halfHeight, radius) : new R.Ball(radius);
    }

    /** Does an axis-aligned box overlap any non-sensor collider in `collisionMask`? (The off-plane extent is ignored.) */
    intersectsBox(center: Vec3Like, halfExtents: Vec3Like, collisionMask: number, excludeBody?: unknown): boolean {
        const R = getRapier2D();
        const half = this.projectDir(halfExtents);
        const hit = this.world2D.getRapierWorld().intersectionWithShape(
            this.project(center), 0, new R.Cuboid(half.x, half.y),
            QUERY_EXCLUDE_SENSORS as RAPIER2D.QueryFilterFlags, makeCollisionGroups(0xFFFF, collisionMask), undefined,
            excludeBody ? this.unwrapBody(excludeBody) : undefined,
        );
        return hit !== null;
    }

    // ---- character helpers (the 3D PhysicsWorld's, on the plane) ----------------

    /** The shared 2D character controller (collide-and-slide, autostep, snap) behind the 3D surface. */
    getCharacterController(): PlaneLockedCharacterController {
        if (!this.planeCharacterController) {
            const raw = this.world2D.getCharacterController();
            if (this.orientation === 'xz') {
                // Every 2D obstacle is a wall to slide along; the vertical axis
                // (steps, snapping, slopes) is answered by TopDownGround instead.
                raw.disableAutostep();
                raw.disableSnapToGround();
                raw.setMaxSlopeClimbAngle(Math.PI);
                raw.setMinSlopeSlideAngle(Math.PI);
            }
            this.planeCharacterController = new PlaneLockedCharacterController(raw, this);
        }
        return this.planeCharacterController;
    }

    /**
     * Velocity of a body this lane has seen (every body that came through a
     * wrapper — characters, props, and anything `queryEntitiesInRadius` returned);
     * null for an unknown handle. Rapier's own `getRigidBody` answers a wrapper
     * for ANY handle, so the facade's registry is the authoritative membership test.
     */
    getBodyLinvel(handle: number): Vec3Like | null {
        const body = this.planeBodies.get(handle);
        if (!body || !body.raw.isValid()) return null;
        return this.liftDir(body.raw.linvel());
    }

    /** Bodies with user data whose colliders intersect a ball — sensors excluded, one entry per body. */
    queryEntitiesInRadius(center: Vec3Like, radius: number): Array<{ handle: number; userData: unknown; position: Vec3Like }> {
        const R = getRapier2D();
        const results: Array<{ handle: number; userData: unknown; position: Vec3Like }> = [];
        const seen = new Set<number>();
        this.world2D.getRapierWorld().intersectionsWithShape(
            this.project(center), 0, new R.Ball(radius),
            (collider) => {
                const parent = collider.parent();
                if (!parent || seen.has(parent.handle)) return true;
                seen.add(parent.handle);
                const userData = this.world2D.getUserDataFromHandle(parent.handle);
                if (userData === undefined) return true;
                const wrapped = this.wrapBody(parent); // registers the handle for getBodyLinvel
                results.push({ handle: parent.handle, userData, position: this.lift(parent.translation(), wrapped.offPlane) });
                return true;
            },
            undefined, undefined, undefined, undefined,
            (collider) => !collider.isSensor(),
        );
        return results;
    }

    /**
     * Averaged step-away direction from overlapping (or nearly overlapping)
     * non-sensor colliders in `collisionMask`; null when clear. Side-on the
     * answer is along X only (`z` is always 0); on the ground plane it is the
     * normalised in-plane direction. Mirrors the 3D contract, including the
     * moving-body gate when `minBodySpeed > 0`.
     */
    computeGroupAvoidance(
        center: Vec3Like, radius: number, halfHeight: number, margin: number, collisionMask: number, minBodySpeed: number = 0,
    ): { x: number; z: number } | null {
        const R = getRapier2D();
        const c2 = this.project(center);
        let sx = 0;
        let sy = 0;
        let count = 0;
        this.world2D.getRapierWorld().intersectionsWithShape(
            c2, 0, this.characterProbe(R, radius + margin, halfHeight),
            (collider) => {
                const p = collider.translation();
                let dx = c2.x - p.x;
                let dy = this.orientation === 'xy' ? 0 : c2.y - p.y;
                if (minBodySpeed > 0) {
                    const body = collider.parent();
                    if (!body) return true;
                    const lv = body.linvel();
                    const speed = this.orientation === 'xy' ? Math.abs(lv.x) : Math.hypot(lv.x, lv.y);
                    if (speed < minBodySpeed) return true;
                    if (lv.x * dx + (this.orientation === 'xy' ? 0 : lv.y * dy) <= 0) return true;
                }
                if (this.orientation === 'xy') {
                    if (Math.abs(dx) < 1e-4) dx = 1;
                    sx += Math.sign(dx);
                } else {
                    const len = Math.hypot(dx, dy);
                    if (len < 1e-4) { dx = 1; dy = 0; } else { dx /= len; dy /= len; }
                    sx += dx;
                    sy += dy;
                }
                count++;
                return true;
            },
            undefined, makeCollisionGroups(0xFFFF, collisionMask), undefined, undefined,
            (collider) => !collider.isSensor(),
        );
        if (count === 0) return null;
        if (this.orientation === 'xy') return Math.abs(sx) < 1e-4 ? null : { x: Math.sign(sx), z: 0 };
        const len = Math.hypot(sx, sy);
        return len < 1e-4 ? null : { x: sx / len, z: sy / len };
    }

    private castDown(fromX: number, fromY: number, maxDist: number, solid: boolean, exclude?: RAPIER2D.Collider): RAPIER2D.RayColliderHit | null {
        const R = getRapier2D();
        return this.world2D.getRapierWorld().castRayAndGetNormal(
            new R.Ray({ x: fromX, y: fromY }, { x: 0, y: -1 }), maxDist, solid,
            QUERY_EXCLUDE_SENSORS as RAPIER2D.QueryFilterFlags, CHARACTER_VS_STATIC_WORLD, exclude,
        );
    }

    /** Ground plane: terrain height under a 2D point, or null off the terrain. */
    private floorUnder(p: Vec2Like): number | null {
        return this.ground ? this.ground.heightAt(p.x, p.y) : null;
    }

    /** Distance from the collider's centre straight down to the static world, or Infinity. */
    groundDistBelowCenter(collider: unknown, maxDist: number): number {
        const raw = this.unwrapCollider(collider);
        const p = raw.translation();
        if (this.orientation === 'xz') {
            const floor = this.floorUnder(p);
            if (floor === null) return Infinity;
            const parent = raw.parent();
            const centerY = parent ? this.wrapBody(parent).offPlane : 0;
            const d = centerY - floor;
            return d <= maxDist ? Math.max(0, d) : Infinity;
        }
        const hit = this.castDown(p.x, p.y, maxDist, true, raw);
        return hit ? hit.timeOfImpact : Infinity;
    }

    /**
     * Slope under the collider. Side-on: from two X samples (`downZ` always 0).
     * Ground plane: always flat — voxel terrain there is steps and cliffs, which
     * the heightmap and the walls answer; there is no slope to slide down.
     */
    groundSlopeUnder(collider: unknown): { tan: number; downX: number; downZ: number } | null {
        if (this.orientation === 'xz') return { tan: 0, downX: 0, downZ: 0 };
        const raw = this.unwrapCollider(collider);
        const c = raw.translation();
        const S = 0.5;
        const sample = (dx: number): number | null => {
            const hit = this.castDown(c.x + dx, c.y + 0.5, 3.0, false, raw);
            return hit ? (c.y + 0.5 - hit.timeOfImpact) : null;
        };
        const px = sample(S), nx = sample(-S);
        if (px === null || nx === null) return null;
        const gx = (px - nx) / (2 * S);
        const tan = Math.abs(gx);
        if (tan < 1e-3) return { tan: 0, downX: 0, downZ: 0 };
        return { tan, downX: -Math.sign(gx), downZ: 0 };
    }

    /** The kinematic body supporting the collider from below (a moving platform); never on the ground plane. */
    kinematicBodyBelowCenter(collider: unknown, maxDist: number): PlaneLockedBody | null {
        if (this.orientation === 'xz') return null;
        const raw = this.unwrapCollider(collider);
        const p = raw.translation();
        const hit = this.castDown(p.x, p.y, maxDist, true, raw);
        const body = hit && hit.timeOfImpact >= 0.35 ? hit.collider.parent() : null;
        return body && body.isKinematic() ? this.wrapBody(body) : null;
    }

    kinematicBodyOverlapping(collider: unknown, exclude: unknown): PlaneLockedBody | null {
        const R = getRapier2D();
        const raw = this.unwrapCollider(collider);
        if (!raw.isValid()) return null;
        const excludeRaw = exclude ? this.unwrapBody(exclude) : null;
        const shape = raw.shape as { halfHeight?: number; radius?: number };
        const probe = this.characterProbe(R, shape.radius ?? 0.3, shape.halfHeight ?? 0.4);
        const hit = this.world2D.getRapierWorld().intersectionWithShape(
            raw.translation(), 0, probe,
            QUERY_EXCLUDE_SENSORS as RAPIER2D.QueryFilterFlags, CHARACTER_VS_STATIC_WORLD, raw,
            excludeRaw && excludeRaw.isValid() ? excludeRaw : undefined,
            (c) => c.parent()?.isKinematic() === true,
        );
        const body = hit?.parent() ?? null;
        return body && body.isValid() ? this.wrapBody(body) : null;
    }

    capsuleOverlapsStatic(collider: unknown, at: Vec3Like, shrink: number = 0.05): boolean {
        const R = getRapier2D();
        const raw = this.unwrapCollider(collider);
        const dims = this.wrapCollider(raw).characterDims;
        const shape = raw.shape as { halfHeight?: number; radius?: number };
        const radius = Math.max(0.05, (dims?.radius ?? shape.radius ?? 0.3) - shrink);
        const halfHeight = Math.max(0.05, (dims?.halfHeight ?? shape.halfHeight ?? 0.4) - shrink);
        const probe = this.characterProbe(R, radius, halfHeight);
        const fixedOnly = (c: RAPIER2D.Collider): boolean => c.parent()?.isFixed() === true;
        const predicate = this.orientation === 'xz'
            ? this.ledgePredicate(at.y - (dims ? dims.halfHeight + dims.radius : 0), fixedOnly)
            : fixedOnly;
        const hit = this.world2D.getRapierWorld().intersectionWithShape(
            this.project(at), 0, probe,
            QUERY_EXCLUDE_SENSORS as RAPIER2D.QueryFilterFlags, CHARACTER_VS_STATIC_WORLD, raw, undefined, predicate,
        );
        return hit !== null;
    }

    /**
     * Height of a standable step ahead of the collider (0 = none), the 3D
     * `detectStepUp` on the plane. Side-on `dirX` alone decides the direction;
     * on the ground plane the step is read off the heightmap ahead — a rise
     * within `[minStep, maxStep]` with a level tread behind it.
     */
    detectStepUp(collider: unknown, dirX: number, dirZ: number, maxStep: number, minStep: number = 0.04): number {
        const raw = this.unwrapCollider(collider);
        const capRadius = this.wrapCollider(raw).characterDims?.radius ?? (raw.shape as { radius?: number }).radius ?? 0.3;
        const pos = raw.translation();
        if (this.orientation === 'xz') {
            const len = Math.hypot(dirX, dirZ);
            if (len < 1e-6) return 0;
            const ground = this.ground!;
            const feetY = this.floorUnder(pos);
            if (feetY === null) return 0;
            const nx = dirX / len, nz = dirZ / len;
            for (const d of [capRadius, capRadius + 0.1, capRadius + 0.2]) {
                const ahead = ground.heightAt(pos.x + nx * d, pos.y + nz * d);
                if (ahead === null) continue;
                const r = ahead - feetY;
                if (r < minStep || r > maxStep) continue;
                const tread = ground.heightAt(pos.x + nx * (d + 0.35), pos.y + nz * (d + 0.35));
                if (tread === null || Math.abs((tread - feetY) - r) > 0.25) continue;
                return r;
            }
            return 0;
        }
        if (Math.abs(dirX) < 1e-6) return 0;
        const R = getRapier2D();
        const nx = Math.sign(dirX);
        const SKIN = 0.03;
        const downHere = this.castDown(pos.x, pos.y, 4.0, true, raw);
        const feetY = downHere ? pos.y - downHere.timeOfImpact : pos.y;
        const up = this.world2D.getRapierWorld().castShape(
            pos, 0, { x: 0, y: 1 }, raw.shape, 0, maxStep + SKIN, false,
            QUERY_EXCLUDE_SENSORS as RAPIER2D.QueryFilterFlags, CHARACTER_VS_STATIC_WORLD, raw,
        );
        const lift = Math.min(up ? Math.max(0, up.time_of_impact) : maxStep + SKIN, maxStep);
        const rayY = feetY + maxStep + SKIN;
        const rayLen = maxStep + 2 * SKIN;
        const ceil = Math.min(maxStep, lift);
        for (const d of [capRadius, capRadius + 0.1, capRadius + 0.2]) {
            const hit = this.world2D.getRapierWorld().castRayAndGetNormal(
                new R.Ray({ x: pos.x + nx * d, y: rayY }, { x: 0, y: -1 }), rayLen, true,
                QUERY_EXCLUDE_SENSORS as RAPIER2D.QueryFilterFlags, CHARACTER_VS_STATIC_WORLD, raw,
            );
            if (!hit) continue;
            const r = (rayY - hit.timeOfImpact) - feetY;
            if (r < minStep || r > ceil || hit.normal.y <= 0.5) continue;
            const chit = this.world2D.getRapierWorld().castRayAndGetNormal(
                new R.Ray({ x: pos.x + nx * (d + 0.35), y: rayY }, { x: 0, y: -1 }), rayLen, false,
                QUERY_EXCLUDE_SENSORS as RAPIER2D.QueryFilterFlags, CHARACTER_VS_STATIC_WORLD, raw,
            );
            if (!chit || chit.normal.y <= 0.5) continue;
            const cr = (rayY - chit.timeOfImpact) - feetY;
            if (Math.abs(cr - r) > 0.25) continue;
            return r;
        }
        return 0;
    }

    /** Top of a grabbable ledge ahead (world Y), the 3D `ledgeForMantle` on the plane; null when none (always, on the ground plane). */
    ledgeForMantle(collider: unknown, dirX: number, _dirZ: number, minBelowCenter: number, maxBelowCenter: number): number | null {
        if (this.orientation === 'xz' || Math.abs(dirX) < 1e-6) return null;
        const R = getRapier2D();
        const raw = this.unwrapCollider(collider);
        const dir = Math.sign(dirX);
        const pos = raw.translation();
        const world = this.world2D.getRapierWorld();
        const flags = QUERY_EXCLUDE_SENSORS as RAPIER2D.QueryFilterFlags;
        const rayFromY = pos.y - minBelowCenter + 0.3;
        const rayLen = (maxBelowCenter - minBelowCenter) + 0.6;
        let top: number | null = null;
        for (const d of [0.75, 1.05]) {
            const hit = world.castRayAndGetNormal(new R.Ray({ x: pos.x + dir * d, y: rayFromY }, { x: 0, y: -1 }), rayLen, false, flags, CHARACTER_VS_STATIC_WORLD, raw);
            if (!hit || hit.normal.y <= 0.5) return null;
            const t = rayFromY - hit.timeOfImpact;
            const below = pos.y - t;
            if (below < minBelowCenter - 0.05 || below > maxBelowCenter + 0.05) return null;
            if (top === null) top = t;
            else if (Math.abs(t - top) > 0.3) return null;
        }
        if (top === null) return null;
        for (const d of [0.75, 1.05]) {
            if (world.castRay(new R.Ray({ x: pos.x + dir * d, y: top + 0.15 }, { x: 0, y: 1 }), 1.5, true, flags, CHARACTER_VS_STATIC_WORLD, raw)) return null;
        }
        return top;
    }

    // ---- stepping / lifecycle -------------------------------------------------

    step(deltaTime: number): void { this.world2D.step(deltaTime); }
    flushCollisionCallbacks(): void { this.world2D.flushCollisionCallbacks(); }
    /** The 2D world steps once per frame at the frame's dt (no accumulator); parity values for the 3D readers. */
    getFixedTimestep(): number { return 1 / 60; }
    getStepsTaken(): number { return this.world2D.getStepsTaken(); }
    getInterpolationAlpha(): number { return 1; }
    /**
     * The 3D world's contact contract on this lane: the callback is handed a
     * `ContactInfo` carrying WRAPPED bodies and colliders and `THREE.Vector3`
     * point/normal, so hit code written against the 3D world (a projectile's
     * `handleCollision`, a vehicle impact) reads it unchanged. The receiving
     * body is always `bodyA`, and the point is lifted with THAT body's own
     * off-plane coordinate — on the ground plane the height the shot is
     * travelling at, which is where its decal and its carve probe belong.
     */
    registerCollisionCallback(body: unknown, callback: (contact: ContactInfo) => void): void {
        const raw = this.unwrapBody(body);
        const lifted = (contact: ContactInfo2D): void => { callback(this.liftContact(contact)); };
        let forBody = this.planeContactCallbacks.get(raw.handle);
        if (!forBody) {
            forBody = new Map();
            this.planeContactCallbacks.set(raw.handle, forBody);
        }
        forBody.set(callback, lifted);
        this.world2D.registerCollisionCallback(raw, lifted as never);
    }
    unregisterCollisionCallback(body: unknown, callback: (contact: ContactInfo) => void): void {
        const raw = this.unwrapBody(body);
        const forBody = this.planeContactCallbacks.get(raw.handle);
        const lifted = forBody?.get(callback);
        if (!forBody || !lifted) return;
        forBody.delete(callback);
        if (forBody.size === 0) this.planeContactCallbacks.delete(raw.handle);
        this.world2D.unregisterCollisionCallback(raw, lifted as never);
    }

    /** A 2D contact as the 3D `ContactInfo`. */
    private liftContact(contact: ContactInfo2D): ContactInfo {
        const receiver = this.wrapBody(contact.bodyA);
        const y = receiver.offPlane;
        const point = this.lift(contact.contactPoint, y);
        const normal = this.liftDir(contact.contactNormal);
        return {
            bodyA: receiver as unknown as RAPIER.RigidBody,
            bodyB: this.wrapBody(contact.bodyB) as unknown as RAPIER.RigidBody,
            colliderA: this.wrapCollider(contact.colliderA) as unknown as RAPIER.Collider,
            colliderB: this.wrapCollider(contact.colliderB) as unknown as RAPIER.Collider,
            contactPoint: new THREE.Vector3(point.x, point.y, point.z),
            contactNormal: new THREE.Vector3(normal.x, normal.y, normal.z),
            penetrationDepth: contact.penetrationDepth,
        };
    }
    addSensorListener(listener: { onIntersectionStart: (h1: number, h2: number) => void; onIntersectionEnd: (h1: number, h2: number) => void }): void {
        this.world2D.addSensorListener(listener);
    }
    removeSensorListener(listener: { onIntersectionStart: (h1: number, h2: number) => void; onIntersectionEnd: (h1: number, h2: number) => void }): void {
        this.world2D.removeSensorListener(listener);
    }
    /** The 3D world's NaN quarantine has no 2D counterpart; a body that misbehaves here is left to Rapier 2D. */
    quarantineBody(_body: unknown): void { /* no quarantine on the 2D world */ }
    setColliderUserData(collider: unknown, userData: unknown): void { this.planeColliderUserData.set(this.unwrapCollider(collider).handle, userData); }
    getColliderUserData(collider: unknown): unknown { return this.planeColliderUserData.get(this.unwrapCollider(collider).handle); }
    getColliderUserDataFromHandle(handle: number): unknown { return this.planeColliderUserData.get(handle); }
    /** `GameEngine.dispose` calls this before disposing `physicsWorld2D`, which owns the WASM world. */
    dispose(): void {
        this.ground?.dispose();
        this.planeBodies.clear();
        this.planeColliders.clear();
        this.planeColliderUserData.clear();
        this.planeColliderTops.clear();
        this.planeShots.clear();
        this.planeContactCallbacks.clear();
        this.planeCharacterController = null;
    }
    /**
     * The 2D world has no pre-solve hook. The only 3D consumer is the pristine
     * dynamic-prop wake sweep, which the 2D lane never registers (props are
     * placed as plain static/dynamic bodies there) — a no-op keeps the surface.
     */
    registerPreSolveCallback(_callback: (dt: number) => void): void { /* no pre-solve stage on the 2D world */ }
    unregisterPreSolveCallback(_callback: (dt: number) => void): void { /* see registerPreSolveCallback */ }
    forEachActiveRigidBody(callback: (body: PlaneLockedBody) => void): void {
        this.world2D.getRapierWorld().forEachActiveRigidBody((raw) => callback(this.wrapBody(raw)));
    }
    registerPreStepCallback(callback: (dt: number) => void): void { this.world2D.registerPreStepCallback(callback); }
    unregisterPreStepCallback(callback: (dt: number) => void): void { this.world2D.unregisterPreStepCallback(callback); }
    registerPostStepCallback(callback: () => void): void { this.world2D.registerPostStepCallback(callback); }
    unregisterPostStepCallback(callback: () => void): void { this.world2D.unregisterPostStepCallback(callback); }
    /** Side-on: the 2D world's gravity. Ground plane: the (virtual) world gravity the 3D readers expect; the 2D world has none. */
    getGravity(): THREE.Vector3 {
        if (this.orientation === 'xz') return this.planeVirtualGravity.clone();
        const g = this.world2D.getGravity();
        return new THREE.Vector3(g.x, g.y, 0);
    }
    setGravity(gravity: Vec3Like): void {
        if (this.orientation === 'xz') { this.planeVirtualGravity.set(gravity.x, gravity.y, gravity.z); return; }
        this.world2D.setGravity({ x: gravity.x, y: gravity.y });
    }
    getStats(): { rigidBodyCount: number; colliderCount: number } { return this.world2D.getStats(); }
    isDisposed(): boolean { return this.world2D.isDisposed(); }
    /** The 2D world has no halt latch; a throwing listener escapes the frame instead. */
    isHalted(): boolean { return false; }
    setSimulationActive(_active: boolean): void { /* no deferred-removal latch on the 2D world */ }

    /**
     * Deliberately unavailable: every caller builds 3D `RAPIER.Ray`s against it,
     * which is a null-stub crash in a 2D-only bundle. Gate on
     * `isPlaneLockedPhysics()` and skip, or query `getPhysicsWorld2D()`.
     */
    getRapierWorld(): never {
        throw new Error('[PlaneLockedPhysics] getRapierWorld() is 3D-only — gate the caller with isPlaneLockedPhysics() or use getPhysicsWorld2D().getRapierWorld().');
    }
}

/** A plane spec, or a bare side-on plane Z (the original signature). */
export function createPlaneLockedPhysics(world2D: PhysicsWorld2D, plane: number | PhysicsPlane): PlaneLockedPhysics {
    const spec: PhysicsPlane = typeof plane === 'number' ? { orientation: 'xy', planeZ: plane } : plane;
    return lockSurface(new PlaneLockedPhysics(world2D, spec), 'PhysicsWorld');
}

export function isPlaneLockedPhysics(world: unknown): world is PlaneLockedPhysics {
    return typeof world === 'object' && world !== null && BRAND in world;
}

export function isPlaneLockedBody(body: unknown): body is PlaneLockedBody {
    return body instanceof PlaneLockedBody;
}

/** The one place the facade is cast onto the 3D type the character pipeline is written against. */
export function asPlayerPhysics(facade: PlaneLockedPhysics): PhysicsWorld {
    return facade as unknown as PhysicsWorld;
}

/**
 * Whichever physics world can answer world queries (height rays, ground
 * placement, spawn clearance) for this engine: the 3D world, else the 2D world
 * through its facade, else null (physicsMode 'none').
 */
export function queryPhysicsFor(
    engine: { physicsWorld: PhysicsWorld | null; getPlaneLockedPhysics?: () => PlaneLockedPhysics | null } | null | undefined,
): PhysicsWorld | null {
    if (!engine) return null;
    if (engine.physicsWorld) return engine.physicsWorld;
    const facade = engine.getPlaneLockedPhysics?.() ?? null;
    return facade ? asPlayerPhysics(facade) : null;
}
