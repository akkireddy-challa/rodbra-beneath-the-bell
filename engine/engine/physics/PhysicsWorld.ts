import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { getRapier, isRapierReady } from 'engine/physics/RapierPhysics.js';
import { CollisionGroup, CollisionMask, makeCollisionGroups } from 'engine/CollisionLayers.js';
import { getWaterBuoyancySystem } from 'engine/WaterBuoyancySystem.js';
import { installRapierReentrancyGuard } from 'engine/physics/RapierReentrancyGuard.js';
import {
    evaluateVehiclePath,
    type PathSample,
    bridgeableGapWidth,
    type VehicleFootprint,
    type VehiclePassResult,
} from 'engine/vehicleTraversability.js';

/** Ground samples are taken this far apart along a probed segment (m). */
const VEHICLE_PROBE_SPACING = 1;
/** Down-rays start this far above the interpolated reference height (m). */
const VEHICLE_PROBE_LIFT = 5;
/** A drop deeper than this is a cliff, not a road — it reads as a gap (m). */
const VEHICLE_PROBE_MAX_FALL = 25;
/**
 * Retry lift (m) for a sample whose ordinary down-ray found nothing. The
 * caller's reference height is the vehicle's own Y, so a leg onto a plateau
 * 15 m above the car starts every ray BELOW the road and the whole segment
 * reads as a gap. One extra ray from well above any map geometry tells a real
 * hole from a reference height that was simply too low.
 */
const VEHICLE_PROBE_HIGH_LIFT = 500;
/**
 * Spacing (m) used to re-sample an interval that looks like a step. Fine enough
 * that a kerb's rise lands in one sub-interval instead of being averaged into a
 * ramp across a whole metre.
 */
const VEHICLE_PROBE_STEP_REFINE_SPACING = 0.2;
/**
 * Spacing (m) used to find the real edges of a sample that found no ground.
 * Finer than the step refinement because it is measuring a WIDTH rather than
 * locating a rise: the seams this exists to recognise are centimetres across.
 */
const VEHICLE_PROBE_GAP_REFINE_SPACING = 0.05;
/**
 * How far (m) a candidate ground hit may sit from the last known ground height
 * and still BE the ground. Far larger than any kerb, ledge or road camber the
 * profile must keep; far smaller than a tree canopy, awning or building roof,
 * which is what it exists to skip.
 */
const VEHICLE_PROBE_GROUND_BAND = 3;
/** Drop this far beneath a rejected overhead hit before looking again (m). */
const VEHICLE_PROBE_OVERHEAD_STEP_DOWN = 0.05;
/** Cap on overhead layers skipped at one sample, so a ray cannot loop forever. */
const VEHICLE_PROBE_MAX_OVERHEAD_SKIPS = 8;
/**
 * Half-depth (m) of the swept clearance slab along the direction of travel.
 * Thin on purpose — see the note where the shape is built.
 */
const VEHICLE_SWEEP_SLAB_HALF_DEPTH = 0.1;

/**
 * Filter used by every character probe below (step-up, mantle, ground distance,
 * slope, platform carry/push): a PLAYER-group query against the STATIC world
 * only — solid environment plus voxel terrain (baked forged levels register
 * their surface in the ENVIRONMENT group). Dynamic props and other characters
 * are deliberately out of scope: nothing here is steppable, standable or
 * mantleable.
 */
const PLAYER_VS_STATIC_WORLD = makeCollisionGroups(
    CollisionGroup.PLAYER,
    CollisionGroup.ENVIRONMENT | CollisionGroup.TERRAIN,
);

export interface RaycastResult {
    hasHit: boolean;
    hitPoint: THREE.Vector3;
    hitNormal: THREE.Vector3;
    hitDistance: number;
    hitCollider: RAPIER.Collider | null;
    hitRigidBody: RAPIER.RigidBody | null;
}

export interface SpatialQueryResult {
    handle: number;
    userData: unknown;
    position: { x: number; y: number; z: number };
}

/**
 * Inputs for `probeVehiclePath`. No self-exclusion field: the query is filtered
 * to ENVIRONMENT / TERRAIN and every vehicle collider is CollisionGroup.VEHICLE,
 * so the probing car can never hit itself (or any other car) in the first place.
 */
export interface VehiclePathProbeOptions {
    /** The vehicle's full collision box (m), used for the clearance sweep. */
    footprint: VehicleFootprint;
    /** Steepest rise/run to treat as drivable — see `derivedClimbGrade`. */
    maxClimbGrade: number;
    /**
     * Tallest abrupt step (m) the vehicle can mount — see `derivedStepHeight`.
     * Separate from `maxClimbGrade` because force-to-weight bounds SLOPES while
     * wheel radius bounds DISCONTINUITIES, and a kerb is the second kind.
     */
    maxStepHeight: number;
    /**
     * Height (m) of the FOOTPRINT BOX CENTRE above the ground the vehicle rides
     * on. The caller supplies it because it depends on wheel and suspension
     * geometry that lives on the vehicle, not in the footprint. Get it wrong and
     * the sweep tests a band the vehicle never occupies: too high and it flies
     * over kerbs, too low and it reports the road itself as an obstacle.
     */
    rideHeight: number;
}

export interface ContactInfo {
    bodyA: RAPIER.RigidBody;
    bodyB: RAPIER.RigidBody;
    colliderA: RAPIER.Collider;
    colliderB: RAPIER.Collider;
    contactPoint: THREE.Vector3;
    contactNormal: THREE.Vector3;
    penetrationDepth: number;
    /** If true, contactNormal is already the outward surface normal (computed from geometry) */
    isGeometricNormal?: boolean;
}

export type CollisionCallback = (contact: ContactInfo) => void;

/**
 * Listener for generic sensor (trigger) intersection events. Both handles are
 * *collider* handles (use `world.getCollider(handle)` to resolve). Either
 * collider in the pair may be the sensor — listeners must filter by their own
 * sensor's known handle. End events fire when a previously-overlapping pair
 * separates.
 */
export interface SensorIntersectionListener {
    onIntersectionStart: (h1: number, h2: number) => void;
    onIntersectionEnd: (h1: number, h2: number) => void;
}

export class PhysicsWorld {
    private world: RAPIER.World;
    private eventQueue: RAPIER.EventQueue;
    /** Lazily-created shared KinematicCharacterController for all characters. See getCharacterController(). */
    private characterController: RAPIER.KinematicCharacterController | null = null;
    private collisionCallbacks: Map<number, CollisionCallback[]> = new Map();
    private handleToUserData: Map<number, any> = new Map();
    
    // Deferred removal queues - processed before physics step
    private pendingBodyRemovals: RAPIER.RigidBody[] = [];
    private pendingColliderRemovals: RAPIER.Collider[] = [];
    // Impulse joints (ragdoll articulation): deferred like bodies/colliders, but flushed FIRST so a
    // joint never references a body freed in the same pass. Joints → colliders → bodies.
    private pendingJointRemovals: RAPIER.ImpulseJoint[] = [];
    // Two-stage quarantine for bodies that went non-finite. They are sanitized to
    // a finite state in place, then disposed of only AFTER they have lived through
    // one clean world.step() — that step recomputes a FINITE broad-phase AABB, so
    // the eventual removeRigidBody() never traverses the spatial structure with a
    // NaN AABB (which would itself corrupt the broad phase and abort the next step).
    //   `quarantineSanitizedThisStep` — sanitized during the current substep,
    //      still needs its clean step before removal.
    //   `quarantineReadyForRemoval`   — already had a clean step; removed at the
    //      start of the next quarantine pass.
    // At the end of each substep the first list is promoted into the second.
    // See quarantineNonFiniteBodies() / sanitizeAndQueue() / quarantineBody().
    private quarantineSanitizedThisStep: RAPIER.RigidBody[] = [];
    private quarantineReadyForRemoval: RAPIER.RigidBody[] = [];
    private pendingCallbacks: Array<{ cb: CollisionCallback; info: ContactInfo }> = [];
    private stepping = false;

    /**
     * True once the per-frame simulation loop is driving `step()`. While active,
     * the `*Immediate` removal variants are downgraded to the deferred queue so
     * NO collider/body is ever removed from the rapier world BETWEEN steps.
     *
     * Why this matters: rapier 0.19's broad-phase / scene-query acceleration
     * structure is only rebuilt inside `world.step()`. If a collider is removed
     * between steps, the structure keeps a dangling proxy; the next spatial query
     * before the following step (most notably the vehicle wheel-suspension
     * raycast that runs in a pre-step callback) dereferences it and rapier-wasm
     * throws "recursive use of an object detected ... unsafe aliasing". That
     * panic leaves the wasm RefCell borrow flags stuck (wasm is panic=abort, so
     * the Rust Drop that releases the borrow never runs), so EVERY subsequent
     * Rapier call that frame also throws — the crash then surfaces far from its
     * cause (e.g. `playerBody.isKinematic()` in player movement).
     *
     * Deferred removals are flushed in `processPendingRemovals()` at the very
     * start of `step()`, immediately before `world.step()` rebuilds the
     * structure — so a query never sees a structure that's out of sync with the
     * collider set.
     *
     * It stays `false` during initial world generation (which runs before the
     * loop starts stepping and is NOT flushed by a step), keeping generation-time
     * teardown immediate as required.
     */
    private simulationActive = false;

    // Fixed timestep accumulator for frame-rate independent physics
    private readonly FIXED_TIMESTEP: number = 1 / 60; // 60 Hz physics
    private readonly MAX_SUBSTEPS: number = 4; // Cap substeps to prevent spiral of death
    private accumulator: number = 0;

    /**
     * How many substeps one full sweep of the FIXED bodies is spread over in
     * `quarantineNonFiniteBodies`. A fixed body is never integrated by the
     * solver, so it cannot BECOME non-finite mid-simulation — only a caller can
     * create or set one that way — yet fixed bodies dominate a level's body set
     * (1547 of 1844 in a measured city). Checking one slice per substep keeps
     * every fixed body covered within ~0.5s at 60Hz while cutting the scan's
     * steady-state wasm traffic by ~97% on that majority. Dynamic and kinematic
     * bodies — the ones the solver can actually run away with — are still
     * checked in FULL every substep.
     */
    private static readonly FIXED_QUARANTINE_SCAN_SLICES = 32;
    /** Which fixed-body slice this substep sweeps; advances once per substep. */
    private fixedQuarantineSlice = 0;

    /**
     * Substeps executed by the most recent step() call. Because the world only
     * advances in whole FIXED_TIMESTEP substeps, a rendered frame can run 0
     * substeps (nothing moves that frame) or 2+ (double-distance jump) even at
     * a rock-steady frame rate — the source of "60 fps but choppy" judder.
     * Read by the debug panel's frame-pacing meter; the engine resets it to 1
     * (neutral) on frames where the simulation is intentionally not stepped.
     */
    lastStepSubstepCount = 1;
    
    // Pre-step callbacks for systems that need to update every physics substep (e.g., vehicles)
    private preStepCallbacks: Set<(dt: number) => void> = new Set();
    
    // Post-step callbacks for systems that need notification after physics step completes
    // Used by VoxelTerrainSystem to know when newly created colliders become active
    private postStepCallbacks: Set<() => void> = new Set();

    // Reusable Ray to avoid per-frame WASM allocations
    private _reusableRay: RAPIER.Ray | null = null;

    // Permanent kill-switch. A hard WASM panic (panic=abort) leaves a rapier
    // RefCell borrow guard's Drop unrun, poisoning the borrow so EVERY later
    // rapier call throws "recursive use of an object ...". The animate loop calls
    // step() every frame, so an uncaught throw here cascades hundreds of times a
    // second and freezes the tab. Once set, step() becomes a no-op until reload.
    private physicsHalted = false;
    /**
     * Set whenever a collider is added or removed outside `world.step()`.
     *
     * Rapier rebuilds the QueryPipeline's BVH only inside `step()`. Anything that changes
     * the collider set between steps leaves that BVH describing a world that no longer
     * exists — and the next raycast walks it, dereferences a handle the collider set has
     * moved on from, and panics INSIDE WASM. `panic=abort` means the borrow guard's Drop
     * never runs, so the borrow stays locked and every rapier call afterwards throws
     * "recursive use of an object detected". Physics is then over for the session.
     *
     * Observed as: clip a traffic cone, and a quarter-lap later the race is dead. The cone
     * is a pristine dynamic prop — the contact wakes it, the post-step sweep promotes it,
     * and promotion swaps its coarse box for an exact cuboid set (clearColliders +
     * createCollider). The first thing to raycast afterwards is `updateVehicle`, in the
     * next substep's pre-step callbacks, which is exactly where the failure surfaced.
     */
    private queryPipelineDirty = false;
    /** Number of `step()` calls so far. Zero means the query BVH has never been built. */
    private stepsTaken = 0;

    /**
     * How many times this world has stepped. Scene queries (raycasts) describe the collider
     * set as of the last step — before the first one there is nothing to query, and code that
     * decides from a raycast at load (resting props, spawn checks) must wait for it.
     */
    getStepsTaken(): number {
        return this.stepsTaken;
    }
    /**
     * Callbacks that run immediately before `world.step()` — the only safe moment to ADD a
     * collider.
     *
     * Rapier 0.19 maintains its query BVH inside `step()` and exposes no way to rebuild it
     * (0.12's `queryPipeline` / `updateSceneQueries` are gone). So a collider created
     * between two steps is invisible to scene queries, and one destroyed is still described
     * by them, until the next step catches up. A raycast in that window walks a BVH that no
     * longer matches the collider set and panics INSIDE WASM — `panic=abort`, so the borrow
     * guard's Drop never runs, the borrow stays locked, and every rapier call afterwards
     * throws "recursive use of an object detected". The session's physics is over.
     *
     * Observed as: clip a traffic cone, and the race dies a quarter-lap later. The cone is a
     * pristine dynamic prop — the contact wakes it, the POST-step sweep promotes it, and
     * promotion swaps its coarse box for an exact cuboid set. The next thing to raycast is
     * `updateVehicle` in the following substep's pre-step callbacks, which is exactly where
     * the guard caught the borrow going bad.
     *
     * Running that work here instead means `step()` follows immediately, so no query ever
     * sees the gap. Removals are already safe — they are queued and flushed after the
     * pre-step callbacks — but an ADD goes into the world the moment it is made.
     */
    private preSolveCallbacks: Array<() => void> = [];

    // Set by dispose(). The creator can DISPOSE_GAME while an async load stage
    // still holds a reference to this instance (e.g. EnvironmentObjectSystem
    // captured at construction, resumed after an asset await) — stepping the
    // freed WASM world would throw and be misreported as a poisoned borrow.
    private isWorldDisposed = false;

    constructor(gravity: THREE.Vector3 = new THREE.Vector3(0, -9.81, 0)) {
        // No-op unless `?physicsguard=1`. Wraps rapier's prototypes, so it must run before
        // the world below is used — and it reports the FIRST re-entrant call by name
        // instead of leaving a poisoned borrow to surface later as six dead vehicles.
        installRapierReentrancyGuard();
        const RAPIER = getRapier();
        this.world = new RAPIER.World({ x: gravity.x, y: gravity.y, z: gravity.z });
        this.eventQueue = new RAPIER.EventQueue(true);
    }

    /** True once physics has been permanently halted by a fatal WASM error. */
    isHalted(): boolean {
        return this.physicsHalted;
    }

    /** True once dispose() has freed the rapier world — no rapier call is valid after. */
    isDisposed(): boolean {
        return this.isWorldDisposed;
    }

    /**
     * Advance the simulation by `deltaTime` seconds using a FIXED-timestep
     * accumulator. THIS IS A STABILITY REQUIREMENT, not an optimization: Rapier's
     * ray-cast vehicle suspension is a stiff damped spring, and explicit
     * integration of a stiff spring is only stable while `damping * dt / mass < 1`.
     * Stepping once with the raw frame delta — which spikes to the 100ms cap on any
     * hitch (GC, voxel chunk generation while driving) — blows past that limit and
     * sends EVERY vehicle's chassis to Inf/NaN in a single step (the "4 vehicles
     * disabled at once" crash). So we never hand rapier more than FIXED_TIMESTEP at
     * once: the frame is split into 1/60s substeps, leftover time carries in the
     * accumulator, and MAX_SUBSTEPS caps catch-up so a long hitch degrades to
     * slow-motion instead of a spiral of death.
     *
     * Generation-time callers pass exactly 1/60, so they run exactly one substep.
     */
    step(deltaTime: number): void {
        this.stepsTaken++;
        // Once a fatal WASM error has poisoned the rapier borrow, retrying every
        // frame floods the console and freezes the tab. Halt permanently after
        // the first failure — only a page reload recovers.
        if (this.physicsHalted) return;

        // A stale reference stepping a disposed world (dispose-during-load) is a
        // no-op — the WASM world is freed, and touching it would throw.
        if (this.isWorldDisposed) return;

        try {
            this.accumulator += deltaTime;
            // Cap the backlog so a big hitch can't queue dozens of catch-up
            // substeps (spiral of death). Excess simulation time is dropped.
            const maxBacklog = this.FIXED_TIMESTEP * this.MAX_SUBSTEPS;
            if (this.accumulator > maxBacklog) this.accumulator = maxBacklog;

            this.world.timestep = this.FIXED_TIMESTEP;
            let substeps = 0;
            while (this.accumulator >= this.FIXED_TIMESTEP) {
                this.accumulator -= this.FIXED_TIMESTEP;
                this.runSubstep(this.FIXED_TIMESTEP);
                substeps++;
            }
            this.lastStepSubstepCount = substeps;
        } catch (e) {
            this.physicsHalted = true;
            console.error(
                'Physics halted — world.step() threw and the rapier WASM borrow is poisoned. ' +
                'Physics is now permanently disabled to stop the per-frame error cascade. ' +
                'Reload the page to recover.',
                e
            );
        }
    }

    /**
     * Register work that must happen immediately before `world.step()`. Use this for
     * anything that CREATES colliders outside a step — see preSolveCallbacks for why the
     * gap between a collider change and the next step is fatal.
     */
    registerPreSolveCallback(callback: () => void): void {
        this.preSolveCallbacks.push(callback);
    }

    /** Stop running a callback registered with registerPreSolveCallback. */
    unregisterPreSolveCallback(callback: () => void): void {
        const i = this.preSolveCallbacks.indexOf(callback);
        if (i >= 0) this.preSolveCallbacks.splice(i, 1);
    }

    /** One fixed-timestep physics substep. See step() for why dt is constant. */
    private runSubstep(dt: number): void {
        // Force every body finite BEFORE anything else touches the world. The pre-step
        // callbacks below include each vehicle's `updateVehicle`, which raycasts — and a
        // raycast against a body whose AABB went non-finite last step aborts inside WASM
        // and wedges the borrow permanently. See quarantineSanitizePass.
        this.quarantineSanitizePass();

        // Pre-step callbacks run before pending removals.
        // This keeps the QueryPipeline consistent for systems that do raycasts
        // (e.g. vehicle wheel ground detection). Removing colliders/bodies
        // invalidates the pipeline, and it's only rebuilt during world.step().
        for (const callback of this.preStepCallbacks) {
            callback(dt);
        }

        this.processPendingRemovals();

        // SAFETY NET (removal half only — the sanitize half already ran at the top of this
        // substep, before the callbacks above could raycast a non-finite world).
        //
        // Sanitize any body that went non-finite during the previous
        // step to a finite state BEFORE world.step() integrates it (and remove it
        // one clean step later). One NaN/Inf body makes world.step() abort with
        // `unreachable`, which sticks a WASM RefCell borrow (panic=abort) so every
        // later rapier call throws "recursive use" — the unrecoverable, tab-freezing
        // cascade. Keeping every body finite means the world is NEVER poisoned.
        this.quarantineRemovePending();

        // Last thing before the step: collider creation is safe here and nowhere else.
        for (const callback of this.preSolveCallbacks) {
            try { callback(); } catch (err) { console.error('preSolve callback failed:', err); }
        }

        this.world.step(this.eventQueue);
        this.collectCollisionEvents();

        for (const callback of this.postStepCallbacks) {
            callback();
        }

        // Promote bodies sanitized this substep: they have now lived through a
        // clean world.step() (finite broad-phase AABB), so next quarantine pass can
        // remove them without corrupting the broad phase.
        if (this.quarantineSanitizedThisStep.length > 0) {
            this.quarantineReadyForRemoval.push(...this.quarantineSanitizedThisStep);
            this.quarantineSanitizedThisStep = [];
        }
    }

    /**
     * SAFETY NET (root-cause containment): scan every rigid body for a genuinely
     * non-finite (NaN / Infinity) component in pose / velocity / mass; SANITIZE any
     * offender to a finite state before world.step() can integrate it, then remove
     * it one clean step later (see sanitizeAndQueue + the two-stage lists).
     *
     * Why this matters: Rapier's world.step() aborts with `unreachable` the moment
     * a body carries NaN/Inf. That abort is panic=abort, so the RefCell borrow
     * guard's Drop never runs — the WASM borrow stays locked and EVERY later rapier
     * call throws "recursive use of an object ...". Only a page reload clears it,
     * and meanwhile the game loop floods the console hundreds of times a second and
     * freezes the tab. Keeping every body finite before each step means world.step()
     * never sees NaN, so the borrow is never poisoned.
     *
     * Why sanitize-then-defer instead of removing immediately: removing a body whose
     * broad-phase proxy AABB is NaN (its position went non-finite) corrupts the
     * spatial structure and aborts the NEXT step anyway. So we first force the body
     * finite, let it live through one clean world.step() (which recomputes a finite
     * AABB), and only then remove it.
     *
     * A vehicle's own pre-step check (RapierVehicle.physicsUpdate) normally hands
     * its chassis to quarantineBody() before we reach here, so the common case is
     * handled with full teardown. This net closes the gaps that path can't see:
     *   - a HIBERNATING vehicle whose physicsUpdate VehicleManager skips,
     *   - a second body that caught the NaN through a contact with the bad chassis,
     *   - any non-vehicle body (prop, projectile, ragdoll, debris) that went bad.
     *
     * The player body is never removed (that would break controls and spawn its
     * own per-frame flood); it is reset to a finite state in place instead.
     *
     * NOTE: a static/fixed body legitimately has mass=0 / invMass=0 — that is NOT
     * a fault, so we only ever act on true NaN/Inf, never on `mass<=0`. We scan
     * pose+velocity+mass (not inertia/com) because a degenerate inertia surfaces
     * as a NaN/Inf velocity or pose on the very next step, which this catches.
     */
    private quarantineNonFiniteBodies(): void {
        this.quarantineRemovePending();
        this.quarantineSanitizePass();
    }

    /**
     * Phase 1: dispose of bodies sanitized on a PRIOR substep. They have now lived through
     * one clean world.step(), so their broad-phase proxy AABB is finite and
     * removeRigidBody() can traverse the spatial structure safely.
     *
     * Stays AFTER the pre-step callbacks: removing a body invalidates the QueryPipeline,
     * and the wheel raycasts in those callbacks query it.
     */
    private quarantineRemovePending(): void {
        if (this.quarantineReadyForRemoval.length > 0) {
            for (const body of this.quarantineReadyForRemoval) {
                if (!body.isValid()) continue;
                this.collisionCallbacks.delete(body.handle);
                this.handleToUserData.delete(body.handle);
                this.world.removeRigidBody(body);
            }
            this.quarantineReadyForRemoval = [];
        }

    }

    /**
     * Phase 2: scan for newly non-finite bodies and force them finite.
     *
     * Runs FIRST in a substep, before any pre-step callback. A vehicle's `updateVehicle`
     * raycasts the world from those callbacks, and a raycast that meets a body whose AABB
     * went non-finite last step aborts INSIDE WASM — `panic=abort`, so the borrow guard's
     * Drop never runs and the borrow stays locked. Every later rapier call in the session
     * then throws "recursive use of an object detected", every vehicle disables itself, and
     * physics halts for good. No JS-level re-entrancy is involved, which is why a
     * re-entrancy guard watching call nesting sees nothing before it happens.
     *
     * Sanitizing mutates poses in place and removes nothing, so unlike phase 1 it is safe
     * to run before the callbacks that query the pipeline.
     */
    private quarantineSanitizePass(): void {
        // Collect first; never mutate the body set while iterating it.
        const bad = (n: number): boolean => !Number.isFinite(n);
        const badVec = (v: { x: number; y: number; z: number }): boolean => bad(v.x) || bad(v.y) || bad(v.z);

        // Sane physical maxima. A velocity above these is not real motion — it is a
        // solver artifact (a runaway contact resolution). Left alone it compounds
        // across steps until the integrated POSITION overflows to ±Infinity; if that
        // body also has CCD enabled (all voxel debris does), the CCD sub-pass inside
        // world.step() runs its time-of-impact query on the Inf/NaN position, corrupts
        // the broad-phase BVH, and aborts the NEXT step with the unrecoverable
        // "recursive use" borrow panic. Clamping the still-finite velocity here, BEFORE
        // the step, breaks that runaway at its root while leaving CCD intact. The caps
        // sit far above any legitimate speed (vehicles ~30 m/s, projectiles ~200 m/s).
        const MAX_LINVEL = 1000;            // m/s
        const MAX_ANGVEL = 100;             // rad/s
        // Cosmetic debris (bodies tagged `__type: 'debris'`, e.g. exploded-NPC
        // chunks) gets a MUCH tighter cap. Such a body is tiny (~0.2 m) and light,
        // so when it spawns embedded in terrain/a wall the solver's penetration
        // recovery catapults it to hundreds of m/s — still under the projectile-
        // sized global cap, so the global cap never fires, and it then tunnels
        // metres per step into a deep penetration that overflows to an Inf position.
        // 40 m/s keeps displacement under ~0.7 m/step (well inside any collider it
        // could hit), so it physically cannot reach that runaway. Debris has no
        // gameplay role, so this never clips legitimate motion.
        const DEBRIS_MAX_LINVEL = 40;       // m/s
        const DEBRIS_MAX_ANGVEL = 40;       // rad/s
        // Dynamic props (furniture-scale bodies, collision group DYNAMIC_PROP) get
        // an even tighter gameplay-sanity cap. When a sleeping prop that settled
        // slightly interpenetrated (into a terrain seam, or a neighbouring prop it
        // spawned against) is woken by a touch, the solver's penetration recovery
        // can eject it at extreme speed — it visibly vanishes and sails across the
        // sky. No legitimate interaction (pushes, vehicle hits, explosions' debris
        // is a separate body type) moves a prop anywhere near this fast, so the cap
        // converts a sky-launch into a bounded hop while leaving normal physics
        // untouched.
        const PROP_MAX_LINVEL = 15;         // m/s
        const PROP_MAX_ANGVEL = 30;         // rad/s
        const PROP_MAX_LINVEL_SQ = PROP_MAX_LINVEL * PROP_MAX_LINVEL;
        const PROP_MAX_ANGVEL_SQ = PROP_MAX_ANGVEL * PROP_MAX_ANGVEL;

        const offenders: RAPIER.RigidBody[] = [];
        const clampTargets: {
            body: RAPIER.RigidBody;
            lin: { x: number; y: number; z: number } | null;
            ang: { x: number; y: number; z: number } | null;
        }[] = [];
        // Collect only — do NOT call back INTO wasm (setLinvel/setAngvel borrow the
        // RigidBodySet mutably) while forEachRigidBody still holds its borrow, or we
        // trigger the very "recursive use" panic we are guarding against.
        // Fixed bodies are amortised across substeps (see
        // FIXED_QUARANTINE_SCAN_SLICES): `isFixed()` is one wasm call, versus the
        // five below plus `isDynamic()` that the full check costs, so skipping the
        // 31/32 of them that aren't in this slice is where the saving comes from.
        const slice = this.fixedQuarantineSlice;
        let fixedSeen = 0;
        this.world.forEachRigidBody((body) => {
            if (body.isFixed() && (fixedSeen++ % PhysicsWorld.FIXED_QUARANTINE_SCAN_SLICES) !== slice) return;
            const t = body.translation();
            const r = body.rotation();
            const lv = body.linvel();
            const av = body.angvel();
            const nonFinite =
                badVec(t) ||
                bad(r.x) || bad(r.y) || bad(r.z) || bad(r.w) ||
                badVec(lv) || badVec(av) || bad(body.mass());
            if (nonFinite) {
                offenders.push(body);
                return;
            }
            // Finite but runaway? Queue a velocity clamp (dynamic bodies only;
            // kinematic/fixed velocities are author-driven, never solver artifacts).
            if (!body.isDynamic()) return;
            const lvSq = lv.x * lv.x + lv.y * lv.y + lv.z * lv.z;
            const avSq = av.x * av.x + av.y * av.y + av.z * av.z;
            // Cheap pre-gate: a body under even the TIGHTEST (prop) cap can never
            // need clamping, so skip the type lookups for the overwhelming
            // majority of slow bodies. Only bodies above the prop cap pay for the
            // checks that decide which cap actually applies.
            if (lvSq <= PROP_MAX_LINVEL_SQ && avSq <= PROP_MAX_ANGVEL_SQ) return;
            const data = this.getUserData(body) as { __type?: string } | null;
            const type = data?.__type ?? 'unknown';
            // Ragdoll limbs share debris' failure mode (small jointed bodies catapulted by
            // penetration recovery), so hold them to the same tight cap.
            const isDebris = type === 'debris' || type === 'ragdoll';
            let linCap = MAX_LINVEL;
            let angCap = MAX_ANGVEL;
            if (isDebris) {
                linCap = DEBRIS_MAX_LINVEL;
                angCap = DEBRIS_MAX_ANGVEL;
            } else if (body.numColliders() > 0 &&
                       (body.collider(0).collisionGroups() & CollisionGroup.DYNAMIC_PROP) !== 0) {
                // Membership lives in the LOW 16 bits (see makeCollisionGroups).
                linCap = PROP_MAX_LINVEL;
                angCap = PROP_MAX_ANGVEL;
            }
            const overLin = lvSq > linCap * linCap;
            const overAng = avSq > angCap * angCap;
            if (!overLin && !overAng) return;
            const lin = overLin
                ? (() => { const s = linCap / Math.sqrt(lvSq); return { x: lv.x * s, y: lv.y * s, z: lv.z * s }; })()
                : null;
            const ang = overAng
                ? (() => { const s = angCap / Math.sqrt(avSq); return { x: av.x * s, y: av.y * s, z: av.z * s }; })()
                : null;
            clampTargets.push({ body, lin, ang });
        });
        this.fixedQuarantineSlice = (slice + 1) % PhysicsWorld.FIXED_QUARANTINE_SCAN_SLICES;

        // Apply velocity clamps now that forEachRigidBody has released its borrow.
        for (const c of clampTargets) {
            if (!c.body.isValid()) continue;
            if (c.lin) c.body.setLinvel(c.lin, true);
            if (c.ang) c.body.setAngvel(c.ang, true);
        }

        if (offenders.length === 0) return;

        // Each offender is sanitized to a finite state so the upcoming world.step()
        // integrates only finite data, then queued for safe removal one clean step
        // later (except the player, which must survive — see sanitizeAndQueue). This
        // is a silent, handled recovery: world.step() never sees the NaN, so the
        // simulation keeps running and the borrow is never poisoned.
        for (const body of offenders) {
            if (!body.isValid()) continue;
            const data = this.getUserData(body) as { __type?: string } | null;
            this.sanitizeAndQueue(body, data?.__type === 'player');
        }
    }

    /**
     * Force a body back to a fully finite state so the next world.step() can never
     * integrate NaN/Inf, then (unless it's the player) queue it for safe removal
     * one clean step later.
     *
     * Why this order matters: a NaN VELOCITY zeroed here can never become a NaN
     * position on the next step. A NaN POSITION is unrecoverable, so the body is
     * teleported out of play — far below the world for ordinary bodies, a safe
     * height for the player (which is never removed). Either way the body now has
     * a finite broad-phase AABB, so both the world.step() and the eventual removal
     * operate on valid spatial data instead of corrupting the broad phase.
     *
     * `wake=true` on every setter is REQUIRED, not optional: a sleeping body keeps
     * its cached broad-phase proxy AABB and is skipped by the AABB-update pass, so
     * a `wake=false` setTranslation would leave the STALE NaN AABB in the BVH even
     * after we wrote a finite translation. Waking the body forces the proxy AABB to
     * be recomputed from the finite pose on the upcoming step — without that, the
     * sanitize is cosmetic and the next world.step() still corrupts/aborts on the
     * stale NaN AABB. We accept re-waking the island; the body is removed one clean
     * step later anyway.
     */
    private sanitizeAndQueue(body: RAPIER.RigidBody, isPlayer: boolean): void {
        const bad = (n: number): boolean => !Number.isFinite(n);
        const t = body.translation();
        const r = body.rotation();

        if (bad(r.x) || bad(r.y) || bad(r.z) || bad(r.w)) {
            body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
        }
        if (bad(t.x) || bad(t.y) || bad(t.z)) {
            body.setTranslation(isPlayer ? { x: 0, y: 100, z: 0 } : { x: 0, y: -100000, z: 0 }, true);
        }
        body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        body.setAngvel({ x: 0, y: 0, z: 0 }, true);

        // Defer removal by one full substep: the body must survive the upcoming
        // world.step() (which gives it a finite broad-phase AABB) before it can be
        // safely removed. The end-of-substep promotion in runSubstep moves it into
        // quarantineReadyForRemoval. The player is never removed.
        if (!isPlayer &&
            !this.quarantineSanitizedThisStep.includes(body) &&
            !this.quarantineReadyForRemoval.includes(body)) {
            this.quarantineSanitizedThisStep.push(body);
        }
    }

    /**
     * Public entry point for owners (e.g. a vehicle disabling its exploded chassis)
     * to dispose of a body that may be non-finite WITHOUT risking the broad-phase
     * corruption a direct removeRigidBody() would cause on a NaN-AABB body. The
     * body is sanitized now and removed after one clean step. Safe to call with an
     * already-removed body.
     */
    quarantineBody(body: RAPIER.RigidBody): void {
        if (!body.isValid()) return;
        const data = this.getUserData(body) as { __type?: string } | null;
        this.sanitizeAndQueue(body, data?.__type === 'player');
    }

    /**
     * Fire all collision callbacks collected during the last step().
     * Must be called AFTER step() returns — never from inside step().
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
    
    /**
     * Register a callback to be called before each physics substep.
     * Use this for systems that need fixed timestep updates (e.g., vehicles).
     * @param callback Function called with the fixed timestep before each physics step
     */
    registerPreStepCallback(callback: (dt: number) => void): void {
        this.preStepCallbacks.add(callback);
    }
    
    /**
     * Unregister a pre-step callback.
     */
    unregisterPreStepCallback(callback: (dt: number) => void): void {
        this.preStepCallbacks.delete(callback);
    }
    
    /**
     * Register a callback to be called after each physics step completes.
     * Used by VoxelTerrainSystem to know when newly created colliders become queryable.
     */
    registerPostStepCallback(callback: () => void): void {
        this.postStepCallbacks.add(callback);
    }
    
    /**
     * Unregister a post-step callback.
     */
    unregisterPostStepCallback(callback: () => void): void {
        this.postStepCallbacks.delete(callback);
    }

    /**
     * Apply `f` to every rigid body the solver currently considers ACTIVE — i.e.
     * awake. Rapier's island manager maintains that set, so a level full of
     * resting props costs nothing here and only what actually moves is visited.
     *
     * Use this instead of walking your own list of dynamic objects when the work
     * is only meaningful for a body that moved: a sleeping body's transform is
     * unchanged by definition, so re-reading it every substep is pure waste.
     */
    forEachActiveRigidBody(f: (body: RAPIER.RigidBody) => void): void {
        if (this.isWorldDisposed || this.physicsHalted) return;
        // Collect first, call `f` after — rapier's own forEachActiveRigidBody holds a
        // borrow of the world for the whole iteration, so ANY rapier mutation from inside
        // `f` is re-entrant. Rapier rejects that with "recursive use of an object detected
        // which would lead to unsafe aliasing in rust", and because the rejection unwinds
        // out through WASM the borrow is never released: every later rapier call in the
        // session throws, every vehicle disables itself, and physics halts for good. Only
        // a page reload recovers.
        //
        // It happened for real — the pristine-dynamic wake sweep called `promote()` from
        // in here, which creates a collider. A prop struck hard enough to wake, a minute
        // into a race, ended the session. Nothing in the resulting log named the cause.
        //
        // Callers cannot be expected to know which of their transitive calls touch rapier,
        // so the safety belongs here rather than in each of them. Iterating a snapshot
        // costs one array per call and makes the whole class of failure impossible.
        const active: RAPIER.RigidBody[] = [];
        this.world.forEachActiveRigidBody((body) => { active.push(body); });
        for (const body of active) f(body);
    }
    
    /**
     * Get the fixed timestep used for physics simulation.
     */
    getFixedTimestep(): number {
        return this.FIXED_TIMESTEP;
    }

    /**
     * Fraction (0..1) of a FIXED_TIMESTEP that has accumulated but not yet been
     * simulated. Because step() drains the accumulator in whole substeps, this is
     * always < 1 after a step. Render code interpolates dynamic bodies between
     * their previous and current substep pose by this alpha to hide fixed-timestep
     * judder — a rendered frame runs 0/1/2 substeps, so reading the raw
     * substep-quantized body pose every frame twitches. See
     * RapierVehicle.visualUpdate() / captureInterpolationState().
     */
    getInterpolationAlpha(): number {
        return this.accumulator / this.FIXED_TIMESTEP;
    }
    
    private processPendingRemovals(): void {
        // Remove joints FIRST — before the colliders/bodies they couple — so the
        // island solver never touches a freed body through a still-live joint.
        for (const joint of this.pendingJointRemovals) {
            if (joint.isValid()) {
                this.world.removeImpulseJoint(joint, true);
            }
        }
        this.pendingJointRemovals = [];

        // Remove colliders next
        for (const collider of this.pendingColliderRemovals) {
            if (collider.isValid()) {
                this.world.removeCollider(collider, true);
            }
        }
        this.pendingColliderRemovals = [];

        // Then remove rigid bodies
        for (const body of this.pendingBodyRemovals) {
            if (body.isValid()) {
                this.collisionCallbacks.delete(body.handle);
                this.handleToUserData.delete(body.handle);
                this.world.removeRigidBody(body);
            }
        }
        this.pendingBodyRemovals = [];
    }
    
    // Lazy-loaded WaterBuoyancySystem for intersection events
    private waterBuoyancyRef: { onIntersectionStart: (h1: number, h2: number) => void; onIntersectionEnd: (h1: number, h2: number) => void } | null = null;
    private waterBuoyancyLoaded = false;

    // Lazy-loaded InteractionManager for trigger-based interactable detection
    private interactionManagerRef: { onIntersectionStart: (h1: number, h2: number) => void; onIntersectionEnd: (h1: number, h2: number) => void } | null = null;
    private interactionManagerLoaded = false;

    /**
     * Generic sensor-intersection listeners. Anything that owns a sensor collider
     * and needs to react when something enters/leaves it can register here instead
     * of bolting another hardcoded ref into `collectCollisionEvents`. The listener
     * receives the *collider handles* (not body handles) of both colliders in the
     * intersection — same handle convention used by waterBuoyancyRef / interactionManagerRef.
     */
    private sensorListeners = new Set<SensorIntersectionListener>();

    private loadWaterBuoyancy(): void {
        if (!this.waterBuoyancyLoaded) {
            this.waterBuoyancyLoaded = true;
            import('engine/WaterBuoyancySystem.js').then(({ getWaterBuoyancySystem }) => {
                this.waterBuoyancyRef = getWaterBuoyancySystem();
            }).catch(() => {});
        }
    }

    private loadInteractionManager(): void {
        if (!this.interactionManagerLoaded) {
            this.interactionManagerLoaded = true;
            import('engine/InteractionManager.js').then(({ getInteractionManager }) => {
                this.interactionManagerRef = getInteractionManager();
            }).catch(() => {});
        }
    }
    
    private collectCollisionEvents(): void {
        this.loadWaterBuoyancy();
        this.loadInteractionManager();

        const handles: number[] = [];
        this.eventQueue.drainCollisionEvents((handle1, handle2, started) => {
            handles.push(handle1, handle2, started ? 1 : 0);
        });

        // Sensor / trigger intersection events. These handlers (water buoyancy,
        // interactable pickups, vehicle impact, and any game-registered sensor
        // listener) run while we are STILL inside world.step()'s tail and are
        // about to re-borrow the world via world.contactPair() in the loop
        // below. A handler that deletes a Rapier body/collider right here — the
        // classic "trigger fires → entity dies → delete its body" pattern —
        // would corrupt the pipeline ("recursive use of an object already
        // borrowed"). Raise the deferred-removal guard for the dispatch window
        // so removeRigidBodyImmediate / removeColliderImmediate fall back to the
        // pending-removal queue and are flushed safely before the next step.
        // (Plain removeRigidBody / removeCollider are already deferred; this
        // closes the gap for the *Immediate variants and for game/sensor code
        // that deletes from inside a trigger handler.)
        this.stepping = true;
        try {
            for (let i = 0; i < handles.length; i += 3) {
                const h1 = handles[i]!;
                const h2 = handles[i + 1]!;
                const started = handles[i + 2] === 1;

                const c1 = this.world.getCollider(h1);
                const c2 = this.world.getCollider(h2);
                if (c1 && c2 && (c1.isSensor() || c2.isSensor())) {
                    const ch1 = c1.handle;
                    const ch2 = c2.handle;
                    if (started) {
                        if (this.waterBuoyancyRef) this.waterBuoyancyRef.onIntersectionStart(ch1, ch2);
                        if (this.interactionManagerRef) this.interactionManagerRef.onIntersectionStart(ch1, ch2);
                        for (const listener of this.sensorListeners) listener.onIntersectionStart(ch1, ch2);
                    } else {
                        if (this.waterBuoyancyRef) this.waterBuoyancyRef.onIntersectionEnd(ch1, ch2);
                        if (this.interactionManagerRef) this.interactionManagerRef.onIntersectionEnd(ch1, ch2);
                        for (const listener of this.sensorListeners) listener.onIntersectionEnd(ch1, ch2);
                    }
                }
            }
        } finally {
            this.stepping = false;
        }

        for (let i = 0; i < handles.length; i += 3) {
            const h1 = handles[i]!;
            const h2 = handles[i + 1]!;
            const started = handles[i + 2] === 1;
            if (!started) continue;

            const collider1 = this.world.getCollider(h1);
            const collider2 = this.world.getCollider(h2);
            if (!collider1 || !collider2) continue;
            if (collider1.isSensor() || collider2.isSensor()) continue;
            
            const body1 = collider1.parent();
            const body2 = collider2.parent();
            if (!body1 || !body2) continue;

            const body1Handle = body1.handle;
            const body2Handle = body2.handle;
            
            // Player pushing small debris — collect as a pending callback so the
            // impulse fires in flushCollisionCallbacks, not during the step.
            const group1 = collider1.collisionGroups() & 0xFFFF;
            const group2 = collider2.collisionGroups() & 0xFFFF;
            
            if ((group1 === CollisionGroup.PLAYER && group2 === CollisionGroup.DEBRIS) ||
                (group2 === CollisionGroup.PLAYER && group1 === CollisionGroup.DEBRIS)) {
                const playerBody = group1 === CollisionGroup.PLAYER ? body1 : body2;
                const debrisBody = group1 === CollisionGroup.DEBRIS ? body1 : body2;
                const debrisHandle = debrisBody.handle;
                const playerLinvel = { x: playerBody.linvel().x, z: playerBody.linvel().z };
                
                this.pendingCallbacks.push({
                    cb: () => {
                        const db = this.world.getRigidBody(debrisHandle);
                        if (!db) return;
                        db.wakeUp();
                        const speed = Math.sqrt(playerLinvel.x * playerLinvel.x + playerLinvel.z * playerLinvel.z);
                        if (speed > 0.1) {
                            const inWater = getWaterBuoyancySystem().isBodyInWater(debrisHandle);
                            const pushStrength = inWater ? 30.0 : 150.0;
                            const liftStrength = inWater ? 0.3 : 1.0;
                            db.applyImpulse({ 
                                x: (playerLinvel.x / speed) * pushStrength, 
                                y: liftStrength,
                                z: (playerLinvel.z / speed) * pushStrength 
                            }, true);
                        }
                    },
                    info: null!,
                });
            }
            
            const contactInfo: ContactInfo = { bodyA: body1, bodyB: body2, colliderA: collider1, colliderB: collider2, contactPoint: new THREE.Vector3(), contactNormal: new THREE.Vector3(), penetrationDepth: 0 };
            
            let degenerateNormal = false;
            let subshape1 = -1;
            let subshape2 = -1;
            this.world.contactPair(collider1, collider2, (manifold, flipped) => {
                const normal = manifold.normal();
                
                contactInfo.contactNormal.set(
                    flipped ? -normal.x : normal.x,
                    flipped ? -normal.y : normal.y,
                    flipped ? -normal.z : normal.z
                );
                
                const numPoints = manifold.numSolverContacts();
                if (numPoints > 0) {
                    const point = manifold.solverContactPoint(0);
                    if (point) {
                        contactInfo.contactPoint.set(point.x, point.y, point.z);
                    }
                    contactInfo.penetrationDepth = manifold.solverContactDist(0) ?? 0;
                }
                
                // Record ONLY what the manifold can tell us. The trimesh-normal fallback
                // that used to run here is now done AFTER contactPair returns — see below.
                const normalLen = Math.sqrt(normal.x * normal.x + normal.y * normal.y + normal.z * normal.z);
                if (normalLen < 0.001) {
                    degenerateNormal = true;
                    subshape1 = manifold.subshape1();
                    subshape2 = manifold.subshape2();
                }
            });

            // Degenerate-normal fallback, OUTSIDE the contactPair callback.
            //
            // `contactPair` holds a borrow of the rapier world for the duration of its
            // callback, and `collider.shape` is a WASM accessor that takes that borrow
            // again. Reading it in there is re-entrant, and rapier's guard aborts with
            // "recursive use of an object detected which would lead to unsafe aliasing in
            // rust" — a panic=abort that leaves the borrow permanently stuck, so every
            // later rapier call in the session throws. Observed as: six vehicles disabling
            // themselves within one frame, then world.step() halting physics for good,
            // 26 seconds into a race.
            //
            // It survived so long because the branch needs a near-zero contact normal,
            // which in practice means a trimesh edge hit — common enough to happen in a
            // race, rare enough to look random. The sensor dispatch above already guards
            // its window (`this.stepping`); this path never did.
            if (degenerateNormal) {
                const candidates = [
                    { collider: collider1, triIndex: subshape1 },
                    { collider: collider2, triIndex: subshape2 }
                ];
                    
                    let bestNormal: THREE.Vector3 | null = null;
                    let bestDist = Infinity;
                    
                    for (const { collider, triIndex } of candidates) {
                        const shape = collider.shape;
                        
                        if (shape && 'vertices' in shape && 'indices' in shape) {
                            const vertices = (shape as { vertices: Float32Array }).vertices;
                            const indices = (shape as { indices: Uint32Array }).indices;
                            
                            if (triIndex >= 0 && triIndex * 3 + 2 < indices.length) {
                                const i0 = indices[triIndex * 3]!;
                                const i1 = indices[triIndex * 3 + 1]!;
                                const i2 = indices[triIndex * 3 + 2]!;
                                
                                const v0 = new THREE.Vector3(vertices[i0 * 3]!, vertices[i0 * 3 + 1]!, vertices[i0 * 3 + 2]!);
                                const v1 = new THREE.Vector3(vertices[i1 * 3]!, vertices[i1 * 3 + 1]!, vertices[i1 * 3 + 2]!);
                                const v2 = new THREE.Vector3(vertices[i2 * 3]!, vertices[i2 * 3 + 1]!, vertices[i2 * 3 + 2]!);
                                
                                const edge1 = v1.clone().sub(v0);
                                const edge2 = v2.clone().sub(v0);
                                const faceNormal = edge1.cross(edge2).normalize();
                                
                                if (faceNormal.lengthSq() > 0.001) {
                                    const toContact = contactInfo.contactPoint.clone().sub(v0);
                                    const distToPlane = Math.abs(toContact.dot(faceNormal));
                                    
                                    if (distToPlane < bestDist) {
                                        bestDist = distToPlane;
                                        bestNormal = faceNormal;
                                    }
                                }
                            }
                        }
                    }
                    
                if (bestNormal && bestDist < 2.0) {
                    contactInfo.contactNormal.copy(bestNormal);
                    contactInfo.isGeometricNormal = true;
                }
            }
            
            const callbacks1 = this.collisionCallbacks.get(body1Handle);
            const callbacks2 = this.collisionCallbacks.get(body2Handle);
            
            if (callbacks1) {
                for (const cb of callbacks1) this.pendingCallbacks.push({ cb, info: contactInfo });
            }
            if (callbacks2) {
                const flipped: ContactInfo = {
                    ...contactInfo,
                    bodyA: body2,
                    bodyB: body1,
                    colliderA: collider2,
                    colliderB: collider1,
                    contactNormal: contactInfo.contactNormal.clone().negate()
                };
                for (const cb of callbacks2) this.pendingCallbacks.push({ cb, info: flipped });
            }
        }
    }
    
    createRigidBody(desc: RAPIER.RigidBodyDesc): RAPIER.RigidBody {
        this.sanitizeBodyDesc(desc);
        return this.world.createRigidBody(desc);
    }

    createCollider(desc: RAPIER.ColliderDesc, parent: RAPIER.RigidBody): RAPIER.Collider {
        this.sanitizeColliderDesc(desc);
        this.substituteBallShape(desc, parent);
        // See queryPipelineDirty: an added collider is invisible to the QueryPipeline until
        // it is rebuilt, and raycasting the stale BVH is what kills the session.
        this.queryPipelineDirty = true;
        return this.world.createCollider(desc, parent);
    }

    /**
     * A Ball shape on a moving body becomes a zero-length capsule.
     *
     * dimforge/rapier#993: in the Rapier we ship, a Ball meeting a Voxels
     * collider's wall, edge or seam at roughly 3 m/s or more panics the WASM
     * (`RuntimeError: unreachable`) and every later physics call fails — see
     * `sphereColliderDesc` in BallPhysics.ts for the mechanism. Every static
     * voxel object is a Voxels collider. The engine's own code already builds
     * spheres through `sphereColliderDesc`; this is the same guarantee for game
     * code that reaches for `RAPIER.ColliderDesc.ball` directly, which shipped
     * games do. A capsule with no segment IS a sphere — same surface, same
     * mass, it rolls — only the contact code path differs.
     *
     * Fixed bodies keep their Ball: two static shapes never generate contacts,
     * so a fixed ball can never reach the ball-vs-voxels path, and most pickup
     * and trigger sensors are fixed balls whose shape type game code may read.
     */
    private substituteBallShape(desc: RAPIER.ColliderDesc, parent: RAPIER.RigidBody): void {
        if (desc.shape.type !== RAPIER.ShapeType.Ball) return;
        if (parent.bodyType() === RAPIER.RigidBodyType.Fixed) return;
        // ColliderDesc.shape is a plain field that intoRaw() reads at creation time.
        desc.shape = new RAPIER.Capsule(0, (desc.shape as RAPIER.Ball).radius);
    }

    /**
     * Hard choke point: reject a NaN/Inf pose BEFORE a body enters the world.
     *
     * A rigid body inserted with a non-finite translation/rotation (or a velocity
     * that integrates to one on the first step) enters Rapier's broad-phase with a
     * NaN proxy AABB. The very next world.step() then either silently corrupts the
     * BVH or aborts with `unreachable` under panic=abort — which leaves the WASM
     * RefCell borrow guard's Drop un-run and poisons EVERY later Rapier call
     * world-wide ("recursive use of an object detected..."), only clearable by a
     * page reload. The post-step quarantine cannot undo that; the sole reliable
     * cure is to never let the NaN reach the spatial structure. Every body in the
     * engine is created through here, so this is the one place to enforce it.
     *
     * If it ever fires it means an upstream caller computed a NaN pose — a real
     * bug to fix at the source — so we warn (never silently clamp). It is a warn,
     * not an error, so it never auto-opens the on-screen console panel.
     */
    private sanitizeBodyDesc(desc: RAPIER.RigidBodyDesc): void {
        const bad = (n: number): boolean => !Number.isFinite(n);
        const t = desc.translation;
        if (t && (bad(t.x) || bad(t.y) || bad(t.z))) {
            console.warn(`createRigidBody got non-finite translation (${t.x}, ${t.y}, ${t.z}) — clamping to (0,100,0)`);
            desc.setTranslation(0, 100, 0);
        }
        const r = desc.rotation;
        if (r && (bad(r.x) || bad(r.y) || bad(r.z) || bad(r.w))) {
            console.warn('createRigidBody got non-finite rotation — clamping to identity');
            desc.setRotation({ x: 0, y: 0, z: 0, w: 1 });
        }
        const lv = desc.linvel;
        if (lv && (bad(lv.x) || bad(lv.y) || bad(lv.z))) {
            console.warn('createRigidBody got non-finite linvel — zeroing');
            desc.setLinvel(0, 0, 0);
        }
        const av = desc.angvel;
        if (av && (bad(av.x) || bad(av.y) || bad(av.z))) {
            console.warn('createRigidBody got non-finite angvel — zeroing');
            desc.setAngvel({ x: 0, y: 0, z: 0 });
        }
    }

    /**
     * See sanitizeBodyDesc — same guard for a collider's offset pose, PLUS its
     * shape dimensions.
     *
     * The shape guard is the more important half. A collider whose half-extent /
     * radius / half-height is zero, negative, NaN, or Infinity is *degenerate*:
     *  - its local AABB is itself non-finite, so no amount of position-sanitizing
     *    (which only rewrites the body translation) can ever give it a finite
     *    broad-phase AABB — the quarantine safety net cannot recover such a body,
     *    and it can never survive the one clean step it needs before removal;
     *  - its contact manifold has an undefined normal, so the solver emits a NaN
     *    contact force that corrupts the VELOCITY of every body it touches (the
     *    observed `type=vehicle bad=[linvel, angvel]` cascade radiating out from a
     *    single epicenter body).
     * Clamping each bad dimension to a tiny-but-finite epsilon here keeps the
     * collider valid (and effectively point-sized) instead of poisonous. If it
     * fires it means a caller computed a bad extent — warn so the real source is
     * fixable, but as a warn (not an error) so it never auto-opens the console panel.
     */
    private sanitizeColliderDesc(desc: RAPIER.ColliderDesc): void {
        const bad = (n: number): boolean => !Number.isFinite(n);
        const t = desc.translation;
        if (t && (bad(t.x) || bad(t.y) || bad(t.z))) {
            console.warn(`createCollider got non-finite translation (${t.x}, ${t.y}, ${t.z}) — clamping to zero offset`);
            desc.setTranslation(0, 0, 0);
        }
        const r = desc.rotation;
        if (r && (bad(r.x) || bad(r.y) || bad(r.z) || bad(r.w))) {
            console.warn('createCollider got non-finite rotation — clamping to identity');
            desc.setRotation({ x: 0, y: 0, z: 0, w: 1 });
        }

        // Shape dimensions. desc.shape is the abstract Shape base; the concrete
        // subclasses expose mutable `halfExtents` (Cuboid/RoundCuboid), `radius`
        // (Ball/Capsule/Cylinder/Cone) and `halfHeight` (Capsule/Cylinder/Cone)
        // fields that intoRaw() reads at creation time, so mutating them here takes
        // effect. Feature-detect rather than switch on ShapeType to stay robust.
        const EPS = 1e-4;
        const shape = desc.shape as unknown as {
            halfExtents?: { x: number; y: number; z: number };
            radius?: number;
            halfHeight?: number;
        };
        const fixDim = (n: number, allowZero: boolean): number | null => {
            // Returns a clamped value if `n` is degenerate, else null (leave as-is).
            if (bad(n)) return EPS;
            if (n < 0) return EPS;
            if (n === 0 && !allowZero) return EPS;
            return null;
        };
        let fixedField: string | null = null;
        const he = shape.halfExtents;
        if (he) {
            const fx = fixDim(he.x, false), fy = fixDim(he.y, false), fz = fixDim(he.z, false);
            if (fx !== null) { he.x = fx; fixedField = `halfExtents.x=${he.x}`; }
            if (fy !== null) { he.y = fy; fixedField = `halfExtents.y=${he.y}`; }
            if (fz !== null) { he.z = fz; fixedField = `halfExtents.z=${he.z}`; }
        }
        if (typeof shape.radius === 'number') {
            const fr = fixDim(shape.radius, false);
            if (fr !== null) { shape.radius = fr; fixedField = `radius=${shape.radius}`; }
        }
        if (typeof shape.halfHeight === 'number') {
            // halfHeight 0 is legal (a capsule/cylinder of zero length is just a
            // ball/disc), so only reject non-finite / negative here.
            const fh = fixDim(shape.halfHeight, true);
            if (fh !== null) { shape.halfHeight = fh; fixedField = `halfHeight=${shape.halfHeight}`; }
        }
        if (fixedField) {
            console.warn(`createCollider got degenerate shape (${fixedField}) — clamped to ${EPS} (a zero/NaN collider emits NaN contact forces and an unrecoverable NaN AABB)`);
        }
    }
    
    /**
     * Add an existing rigid body to the world.
     * This is a compatibility method - in Rapier, bodies are typically created with createRigidBody.
     * Use this for compatibility where addRigidBody was a separate operation in other engines.
     * 
     * @param body The rigid body (for Rapier, this is typically already in the world after creation)
     * @param collisionGroup Optional collision group
     * @param collisionMask Optional collision mask
     */
    addRigidBody(body: RAPIER.RigidBody, collisionGroup?: number, collisionMask?: number): void {
        // In Rapier, bodies are added to the world when created via createRigidBody.
        // This method exists for compatibility and does nothing in Rapier.
        // Collision groups are set on colliders, not rigid bodies.
    }
    
    removeRigidBody(body: RAPIER.RigidBody): void {
        // Queue for deferred removal - will be processed before next physics step
        // This prevents Rapier from being modified while it's being accessed
        if (!body.isValid()) {
            return;
        }
        // Check if already queued
        if (!this.pendingBodyRemovals.includes(body)) {
            this.pendingBodyRemovals.push(body);
        }
    }
    
    removeCollider(collider: RAPIER.Collider): void {
        // Queue for deferred removal - will be processed before next physics step
        if (!collider.isValid()) {
            return;
        }
        this.queryPipelineDirty = true;
        // Check if already queued
        if (!this.pendingColliderRemovals.includes(collider)) {
            this.pendingColliderRemovals.push(collider);
        }
    }
    
    /**
     * Create an impulse joint coupling two bodies (e.g. a ragdoll articulation). Build the descriptor
     * with `RAPIER.JointData.spherical(anchor1, anchor2)` etc. (anchors in each body's local frame).
     */
    createImpulseJoint(
        params: RAPIER.JointData,
        body1: RAPIER.RigidBody,
        body2: RAPIER.RigidBody,
    ): RAPIER.ImpulseJoint {
        return this.world.createImpulseJoint(params, body1, body2, true);
    }

    /** Queue an impulse joint for deferred removal (dropped before its bodies; see processPendingRemovals). */
    removeImpulseJoint(joint: RAPIER.ImpulseJoint): void {
        if (!joint.isValid()) {
            return;
        }
        if (!this.pendingJointRemovals.includes(joint)) {
            this.pendingJointRemovals.push(joint);
        }
    }

    removeRigidBodyImmediate(body: RAPIER.RigidBody): void {
        if (!body.isValid()) {
            return;
        }
        // During an active simulation (or mid-step), never mutate the world
        // between steps — defer so the broad-phase stays consistent for the
        // next pre-step query. Immediate removal is only allowed during initial
        // generation, before the loop starts stepping. See `simulationActive`.
        if (this.stepping || this.simulationActive) {
            this.removeRigidBody(body);
            return;
        }
        this.collisionCallbacks.delete(body.handle);
        this.handleToUserData.delete(body.handle);
        this.world.removeRigidBody(body);
    }

    removeColliderImmediate(collider: RAPIER.Collider): void {
        if (!collider.isValid()) {
            return;
        }
        // See removeRigidBodyImmediate: defer during active simulation so a
        // removed collider never leaves a dangling broad-phase proxy for a
        // between-step query (vehicle wheel raycast etc.) to crash on.
        if (this.stepping || this.simulationActive) {
            this.removeCollider(collider);
            return;
        }
        this.world.removeCollider(collider, true);
    }

    /**
     * Marks whether the per-frame simulation loop is actively stepping. The
     * GameEngine sets this true when it steps and false when gameplay is paused
     * or during pre-loop world generation. Controls whether the `*Immediate`
     * removal variants defer (active) or remove now (generation/paused).
     */
    setSimulationActive(active: boolean): void {
        this.simulationActive = active;
    }
    
    registerCollisionCallback(body: RAPIER.RigidBody, callback: CollisionCallback): void {
        const handle = body.handle;
        if (!this.collisionCallbacks.has(handle)) {
            this.collisionCallbacks.set(handle, []);
        }
        this.collisionCallbacks.get(handle)!.push(callback);
    }
    
    unregisterCollisionCallback(body: RAPIER.RigidBody, callback: CollisionCallback): void {
        const callbacks = this.collisionCallbacks.get(body.handle);
        if (callbacks) {
            const index = callbacks.indexOf(callback);
            if (index !== -1) {
                callbacks.splice(index, 1);
            }
        }
    }
    
    /**
     * Register a generic sensor-intersection listener. The listener fires for
     * every sensor↔anything intersection drained from the event queue this step.
     * The listener must filter by its own sensor's collider handle.
     */
    addSensorListener(listener: SensorIntersectionListener): void {
        this.sensorListeners.add(listener);
    }

    /** Unregister a previously-added sensor listener. Safe to call multiple times. */
    removeSensorListener(listener: SensorIntersectionListener): void {
        this.sensorListeners.delete(listener);
    }

    setUserData(body: RAPIER.RigidBody, userData: any): void {
        this.handleToUserData.set(body.handle, userData);
    }
    
    getUserData(body: RAPIER.RigidBody): any {
        return this.handleToUserData.get(body.handle);
    }
    
    getUserDataFromHandle(handle: number): any {
        return this.handleToUserData.get(handle);
    }

    /**
     * Iterate all rigid body user data entries.
     * Used by AOE systems to find entities (remote NPCs/animals) in a blast radius.
     */
    forEachUserData(callback: (handle: number, userData: any) => void): void {
        for (const [handle, data] of this.handleToUserData.entries()) {
            callback(handle, data);
        }
    }

    /**
     * Get a rigid body's world-space translation by handle.
     * Returns null if the body no longer exists.
     */
    getBodyTranslation(handle: number): { x: number; y: number; z: number } | null {
        const body = this.world.getRigidBody(handle);
        if (!body) return null;
        return body.translation();
    }

    /**
     * Get a rigid body's current linear velocity by handle.
     * Returns null if the body no longer exists.
     */
    getBodyLinvel(handle: number): { x: number; y: number; z: number } | null {
        const body = this.world.getRigidBody(handle);
        if (!body) return null;
        return body.linvel();
    }

    /**
     * Test whether an upright capsule at `center` overlaps any non-sensor
     * collider matching the collision mask. Used by spawn placement to verify
     * the configured spawn point is clear before falling back to ray-snapping
     * (so a spawn point inside an open building interior isn't lifted to the
     * roof by a ground-finding raycast).
     *
     * @param center - World-space center of the capsule (matches the player body's centre).
     * @param radius - Capsule radius.
     * @param halfHeight - Capsule cylinder half-height (excluding the hemispheres).
     * @param collisionMask - Which CollisionGroup bits to test against.
     */
    capsuleOverlaps(
        center: { x: number; y: number; z: number },
        radius: number,
        halfHeight: number,
        collisionMask: number,
    ): boolean {
        if (!isRapierReady()) return false;
        const RAPIER_MODULE = getRapier();
        const shape = new RAPIER_MODULE.Capsule(halfHeight, radius);
        const filterGroups = makeCollisionGroups(0xFFFF, collisionMask);
        let hit = false;
        this.world.intersectionsWithShape(
            center,
            { x: 0, y: 0, z: 0, w: 1 },
            shape,
            () => { hit = true; return false; }, // stop on first hit
            undefined,
            filterGroups,
            undefined,
            undefined,
            (collider) => !collider.isSensor(),
        );
        return hit;
    }

    /**
     * Handles of the non-sensor colliders in `collisionMask` groups whose shape
     * overlaps a capsule RIGHT NOW, collected into `out` (cleared first).
     *
     * For collide-and-slide: the character motor treats NPCs, animals and props
     * as solid, but none of them are blocked by the character, so any of them can
     * walk (or be pushed) INTO its capsule — and a penetration that already
     * exists when the frame starts would otherwise refuse movement in EVERY
     * direction. Measured: surrounded by six melee NPCs the player froze after
     * 1.15 m with the motor still asking for 5 m/s. The motor excludes these
     * handles from its solve, so a body already inside you can never keep you in.
     */
    overlappingColliderHandles(
        center: { x: number; y: number; z: number },
        radius: number,
        halfHeight: number,
        collisionMask: number,
        out: Set<number>,
    ): Set<number> {
        out.clear();
        if (!isRapierReady()) return out;
        const RAPIER_MODULE = getRapier();
        const shape = new RAPIER_MODULE.Capsule(halfHeight, radius);
        const filterGroups = makeCollisionGroups(0xFFFF, collisionMask);
        this.world.intersectionsWithShape(
            center,
            { x: 0, y: 0, z: 0, w: 1 },
            shape,
            (collider) => { out.add(collider.handle); return true; },
            undefined,
            filterGroups,
            undefined,
            undefined,
            (collider) => !collider.isSensor(),
        );
        return out;
    }

    /**
     * Compute a horizontal unit "step away" direction for a character capsule
     * that is overlapping — or within `margin` of — any non-sensor collider in
     * the given groups (typically `DYNAMIC_PROP | VEHICLE`).
     *
     * Characters are deliberately NOT solver-coupled to props/vehicles (a
     * kinematic character would shove a dynamic body with effectively infinite
     * mass and launch it), so nothing physically pushes the character out of the
     * way when a prop is pushed onto it or a vehicle drives through it. The AI
     * uses this to step aside instead — the sensor/behaviour half of the
     * decoupling. Returns the averaged away-from-obstacles direction, or null
     * when clear.
     *
     * @param margin - extra reach beyond the capsule radius; the character reacts
     *                 this far before actual contact ("nearly overlapping").
     * @param minBodySpeed - if > 0, ignore obstacles whose rigid body is moving
     *                 slower than this, OR moving away from the character. A
     *                 STATIONARY obstacle is not a threat — the navmesh routes
     *                 the character around it; only a body actually moving INTO
     *                 the character warrants a reactive step-aside. (Pass 0 to
     *                 react to overlap regardless of motion — used for the
     *                 player, whose kinematic body reports no linvel; the caller
     *                 gates on the player's own speed instead.)
     */
    computeGroupAvoidance(
        center: { x: number; y: number; z: number },
        radius: number,
        halfHeight: number,
        margin: number,
        collisionMask: number,
        minBodySpeed = 0,
    ): { x: number; z: number } | null {
        if (!isRapierReady()) return null;
        const RAPIER_MODULE = getRapier();
        const shape = new RAPIER_MODULE.Capsule(halfHeight, radius + margin);
        const filterGroups = makeCollisionGroups(0xFFFF, collisionMask);
        let sx = 0;
        let sz = 0;
        let count = 0;
        this.world.intersectionsWithShape(
            center,
            { x: 0, y: 0, z: 0, w: 1 },
            shape,
            (collider) => {
                const p = collider.translation();
                if (minBodySpeed > 0) {
                    const body = collider.parent();
                    if (!body) return true; // collider with no body → static, skip
                    const lv = body.linvel();
                    if (Math.hypot(lv.x, lv.z) < minBodySpeed) return true; // stationary → not a threat
                    // Only react if it is moving TOWARD the character (a body
                    // moving away or tangentially can't overlap it).
                    if (lv.x * (center.x - p.x) + lv.z * (center.z - p.z) <= 0) return true;
                }
                let dx = center.x - p.x;
                let dz = center.z - p.z;
                let d = Math.hypot(dx, dz);
                if (d < 1e-4) { dx = 1; dz = 0; d = 1; } // dead-centre: arbitrary escape
                sx += dx / d;
                sz += dz / d;
                count++;
                return true; // gather every overlapping obstacle
            },
            undefined,
            filterGroups,
            undefined,
            undefined,
            (collider) => !collider.isSensor(),
        );
        if (count === 0) return null;
        const len = Math.hypot(sx, sz);
        if (len < 1e-4) return null;
        return { x: sx / len, z: sz / len };
    }

    /**
     * Safely teleport a DYNAMIC rigid body (any pushable prop) to a new position
     * / orientation. THIS IS THE ONLY CORRECT WAY to reposition a dynamic body at
     * runtime.
     *
     * Do NOT instead: set the Three.js mesh transform directly (the physics body
     * stays behind, then snaps back), or call `setTranslation()` on its own
     * (that leaves the old velocity AND can bury the body inside its new
     * neighbours — a frame later Rapier's solver violently ejects the
     * penetrating body, the classic "the object I moved suddenly shot across the
     * map" bug).
     *
     * What this does, in order:
     *   1. Zeroes linear + angular velocity — no momentum is carried through the
     *      teleport.
     *   2. Sets the yaw rotation (about +Y) if `yaw` is given, then the position.
     *   3. Wakes the body so it settles under gravity.
     *   4. Resolves any overlap in the direction the CALLER chooses
     *      (`overlapResolution`). Overlap is detected from the body's ACTUAL
     *      colliders (not a bounding box/sphere), tested against the solid
     *      world, excluding the body itself:
     *        - `'none'` (default): place exactly where asked; do not move it.
     *          The zeroed velocity already prevents the momentum launch, and a
     *          shallow overlap depenetrates gently.
     *        - `'horizontal'`: if overlapping, search outward in X/Z for the
     *          nearest clear spot at the same height. Use for FLOOR objects that
     *          must slide aside to clear ground rather than be lifted onto
     *          whatever they overlap.
     *        - `'up'`: if overlapping, lift straight up until clear. Use for
     *          objects that belong ON a surface (rest on top of what they
     *          overlap) rather than beside it.
     *      There is intentionally no universal default direction: the right one
     *      depends on the object, so the calling code must pick it.
     *
     * If you move a prop that ALSO drives a navmesh obstacle, the obstacle
     * follows automatically (it polls the body each frame) — no extra call.
     *
     * @returns the final world position the body was placed at (may differ from
     *          `position` if overlap resolution moved it).
     */
    teleportDynamicBody(
        body: RAPIER.RigidBody,
        position: { x: number; y: number; z: number },
        yaw?: number,
        options?: {
            overlapResolution?: 'none' | 'horizontal' | 'up';
            /** Layers treated as solid for overlap resolution. Default: static world + props + vehicles. */
            collisionMask?: number;
            /** Max distance to search / lift, in metres. Default 3. */
            maxDistance?: number;
        },
    ): { x: number; y: number; z: number } {
        body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        if (yaw !== undefined) {
            const half = yaw * 0.5;
            body.setRotation({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) }, true);
        }
        const place = (px: number, py: number, pz: number): void => {
            body.setTranslation({ x: px, y: py, z: pz }, true);
        };
        place(position.x, position.y, position.z);
        body.wakeUp();

        const mode = options?.overlapResolution ?? 'none';
        if (mode === 'none' || !isRapierReady()) return { ...position };

        const mask = options?.collisionMask ?? (
            CollisionGroup.TERRAIN | CollisionGroup.ENVIRONMENT |
            CollisionGroup.DYNAMIC_PROP | CollisionGroup.VEHICLE
        );
        const filterGroups = makeCollisionGroups(0xFFFF, mask);
        const maxDistance = options?.maxDistance ?? 3.0;
        const step = 0.15;

        // Collider-based overlap test for the body at its CURRENT transform,
        // against the solid world, excluding the body's own colliders.
        const overlapsNow = (): boolean => {
            let hit = false;
            const n = body.numColliders();
            for (let i = 0; i < n; i++) {
                const col = body.collider(i);
                if (!col || col.isSensor()) continue;
                this.world.intersectionsWithShape(
                    col.translation(),
                    col.rotation(),
                    col.shape,
                    () => { hit = true; return false; }, // stop on first hit
                    undefined,
                    filterGroups,
                    undefined,
                    body, // exclude our own body
                    (other) => !other.isSensor(),
                );
                if (hit) break;
            }
            return hit;
        };

        if (!overlapsNow()) return { ...position };

        if (mode === 'up') {
            for (let d = step; d <= maxDistance; d += step) {
                const y = position.y + d;
                place(position.x, y, position.z);
                if (!overlapsNow()) return { x: position.x, y, z: position.z };
            }
        } else {
            // 'horizontal' — expanding ring search in X/Z at the original height.
            const ANGLES = 8;
            for (let r = step; r <= maxDistance; r += step) {
                for (let a = 0; a < ANGLES; a++) {
                    const ang = (a / ANGLES) * Math.PI * 2;
                    const px = position.x + Math.cos(ang) * r;
                    const pz = position.z + Math.sin(ang) * r;
                    place(px, position.y, pz);
                    if (!overlapsNow()) return { x: px, y: position.y, z: pz };
                }
            }
        }

        // No clear spot within range — leave it at the requested position
        // (best effort; better than flinging it far away).
        place(position.x, position.y, position.z);
        return { ...position };
    }

    /**
     * Find all rigid bodies with user data within a sphere.
     * Uses Rapier's broad-phase spatial query (intersectionsWithShape) for efficient lookups.
     * Much faster than iterating all entities when the world has many bodies.
     *
     * @param center - World-space center of the query sphere
     * @param radius - Radius of the query sphere
     * @returns Array of matching entities with their handle, userData, and position
     */
    queryEntitiesInRadius(
        center: { x: number; y: number; z: number },
        radius: number
    ): SpatialQueryResult[] {
        if (!isRapierReady()) return [];

        const RAPIER_MODULE = getRapier();
        const shape = new RAPIER_MODULE.Ball(radius);
        const shapePos = { x: center.x, y: center.y, z: center.z };
        const shapeRot = { x: 0, y: 0, z: 0, w: 1 }; // identity quaternion
        const results: SpatialQueryResult[] = [];
        const seenBodies = new Set<number>();

        this.world.intersectionsWithShape(
            shapePos,
            shapeRot,
            shape,
            (collider) => {
                const parent = collider.parent();
                if (!parent) return true; // continue
                const handle = parent.handle;
                if (seenBodies.has(handle)) return true; // skip duplicates
                seenBodies.add(handle);
                const userData = this.handleToUserData.get(handle);
                if (userData === undefined) return true; // no user data
                const translation = parent.translation();
                results.push({ handle, userData, position: { x: translation.x, y: translation.y, z: translation.z } });
                return true; // continue iterating
            },
            undefined, // filterFlags
            undefined, // filterGroups
            undefined, // filterExcludeCollider
            undefined, // filterExcludeRigidBody
            (collider) => !collider.isSensor() // exclude sensors
        );

        return results;
    }

    // Collider user data (separate from rigid body user data)
    private colliderUserData: Map<number, any> = new Map();
    
    setColliderUserData(collider: RAPIER.Collider, userData: any): void {
        this.colliderUserData.set(collider.handle, userData);
    }
    
    getColliderUserData(collider: RAPIER.Collider): any {
        return this.colliderUserData.get(collider.handle);
    }
    
    getColliderUserDataFromHandle(handle: number): any {
        return this.colliderUserData.get(handle);
    }
    
    /** Prepare or reuse the RaycastResult, resetting status fields if reusing. */
    private _prepareResult(out?: RaycastResult): RaycastResult {
        if (out) {
            out.hasHit = false;
            out.hitDistance = Infinity;
            out.hitCollider = null;
            out.hitRigidBody = null;
            return out;
        }
        return {
            hasHit: false,
            hitPoint: new THREE.Vector3(),
            hitNormal: new THREE.Vector3(),
            hitDistance: Infinity,
            hitCollider: null,
            hitRigidBody: null
        };
    }

    /** Populate a RaycastResult from a Rapier ray-cast hit (shared by raycast / raycastWithFilter). */
    private _fillRaycastHit(
        result: RaycastResult,
        hit: { collider: RAPIER.Collider; timeOfImpact: number; normal: { x: number; y: number; z: number } },
        origin: THREE.Vector3,
        direction: THREE.Vector3,
    ): void {
        result.hasHit = true;
        result.hitDistance = hit.timeOfImpact;
        result.hitCollider = hit.collider;
        result.hitRigidBody = hit.collider.parent() ?? null;
        result.hitPoint.copy(origin).addScaledVector(direction, hit.timeOfImpact);
        result.hitNormal.set(hit.normal.x, hit.normal.y, hit.normal.z);
    }

    /** Prepare or reuse the internal RAPIER.Ray with the given origin/direction. */
    private _prepareRay(origin: THREE.Vector3, direction: THREE.Vector3): RAPIER.Ray {
        if (!this._reusableRay) {
            const RAPIER_MODULE = getRapier();
            this._reusableRay = new RAPIER_MODULE.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
        }
        const ray = this._reusableRay;
        ray.origin.x = origin.x;
        ray.origin.y = origin.y;
        ray.origin.z = origin.z;
        ray.dir.x = direction.x;
        ray.dir.y = direction.y;
        ray.dir.z = direction.z;
        return ray;
    }

    raycast(
        origin: THREE.Vector3,
        direction: THREE.Vector3,
        maxDistance: number = 1000,
        collisionMask: number = CollisionMask.ALL,
        out?: RaycastResult
    ): RaycastResult {
        const result = this._prepareResult(out);

        if (!isRapierReady()) {
            return result;
        }

        const ray = this._prepareRay(origin, direction);

        // Ray is a member of all groups (0xFFFF) and collides with the requested mask.
        const filterGroups = makeCollisionGroups(0xFFFF, collisionMask);

        const hit = this.world.castRayAndGetNormal(
            ray,
            maxDistance,
            true,
            undefined,
            filterGroups,
            undefined,
            undefined,
            (collider) => !collider.isSensor() // Exclude sensor colliders (water, triggers)
        );

        if (hit) this._fillRaycastHit(result, hit, origin, direction);

        return result;
    }

    raycastWithFilter(
        origin: THREE.Vector3,
        direction: THREE.Vector3,
        maxDistance: number,
        filterGroups: number,
        filterMask: number,
        excludeBodies?: RAPIER.RigidBody[],
        out?: RaycastResult
    ): RaycastResult {
        const result = this._prepareResult(out);

        if (!isRapierReady()) {
            return result;
        }

        const ray = this._prepareRay(origin, direction);
        
        const excludeHandles = new Set(excludeBodies?.map(b => b.handle) || []);
        
        const filterPredicate = excludeHandles.size > 0 
            ? (collider: RAPIER.Collider) => {
                const parent = collider.parent();
                return !parent || !excludeHandles.has(parent.handle);
            } 
            : undefined;
        
        const collisionGroups = makeCollisionGroups(filterGroups, filterMask);
        
        const hit = this.world.castRayAndGetNormal(
            ray,
            maxDistance,
            true,
            undefined,
            collisionGroups,
            undefined,
            undefined,
            filterPredicate
        );

        if (hit) this._fillRaycastHit(result, hit, origin, direction);

        return result;
    }

    getGravity(): THREE.Vector3 {
        const g = this.world.gravity;
        return new THREE.Vector3(g.x, g.y, g.z);
    }
    
    setGravity(gravity: THREE.Vector3): void {
        this.world.gravity = { x: gravity.x, y: gravity.y, z: gravity.z };
    }
    
    /**
     * Get the underlying Rapier physics world for direct API access.
     */
    getRapierWorld(): RAPIER.World {
        return this.world;
    }

    /**
     * Shared Rapier KinematicCharacterController used by ALL characters (player,
     * NPCs, animals) for collide-and-slide movement. The controller is stateless
     * between `computeColliderMovement` calls (it takes the collider each call),
     * so one configured instance serves every character.
     *
     * Configured once: a small skin offset; autostep so characters walk up small
     * ledges/voxel steps; snap-to-ground so they stick to the floor on slopes and
     * small drops; a max climb slope; slide enabled; and crucially
     * `setApplyImpulsesToDynamicBodies(false)` — Rapier's built-in impulses stop
     * treating dynamic bodies as obstacles and launch light ones violently.
     * Dynamic bodies a character pairs with are blocking obstacles instead, and
     * the character motor applies its own small CAPPED push impulses, so heavy
     * props are shoved slowly and can be stood on.
     */
    getCharacterController(): RAPIER.KinematicCharacterController {
        if (!this.characterController) {
            // Skin width 0.08: voxel worlds are greedy-meshed trimeshes whose faces are
            // stitched from many quads — a thin 0.05 skin lets the capsule settle into
            // seam corners and sawtooth plan-steps, where collide-and-slide then jams
            // (walking diagonally into a stepped wall stopped dead instead of sliding).
            const c = this.world.createCharacterController(0.08);
            // Push the corrected motion 1 cm along the contact normal (default is
            // 0.1 mm). This is the anti-seam remedy: it keeps the capsule from
            // re-penetrating the next quad edge of the same voxel face mid-slide.
            c.setNormalNudgeFactor(0.01);
            c.setApplyImpulsesToDynamicBodies(false);
            c.setSlideEnabled(true);
            // 0.65 m: voxel quantization rounds authored 0.5-0.6 m steps (challenge
            // stage slabs are 0.6 thick) up to ~0.6+, which a 0.5 cap just refuses —
            // the character walked in place against knee-high geometry. minWidth 0.3:
            // a step must have a REAL tread — one-voxel slivers on the face of a
            // taller wall must not be mounted (bob-loop against platform sides).
            c.enableAutostep(0.65, 0.3, false); // maxHeight, minWidth, includeDynamic
            c.enableSnapToGround(0.5);         // stick to ground within 0.5 m
            // Real-slope limits. SMALL curbs/steps are handled separately and by
            // HEIGHT, not by slope angle (see detectStepUp() + WalkingAndJumping-
            // Movement's controlled step-climb): a rounded capsule on a curb far
            // smaller than its radius makes a diagonal contact that autostep and
            // these slope limits both misread, so step-over is done with an
            // explicit height probe + manual lift instead of by widening angles.
            c.setMaxSlopeClimbAngle(50 * Math.PI / 180);
            c.setMinSlopeSlideAngle(45 * Math.PI / 180);
            this.characterController = c;
        }
        return this.characterController;
    }

    /**
     * Probe for a small, walkable curb/step directly ahead of a grounded
     * character capsule and return how high it is (metres), or 0 when there is no
     * step worth taking (flat ground, a down-step, a gap with no floor ahead, or
     * an obstacle taller than `maxStep`).
     *
     * Why this exists: Rapier's built-in autostep can't climb a curb much smaller
     * than the capsule radius. On such a lip the rounded capsule contacts the
     * *top edge* well before the lip (~0.24 m for a 0.3 m-radius capsule on a
     * 0.125 m curb), but autostep only nudges forward by its per-frame motion
     * (a few cm), so after lifting it lands back on that diagonal edge — which it
     * rejects as a wall — and bails every frame. Movement code uses this probe to
     * drive a smooth manual lift instead. Three capsule shape-casts:
     *   1. UP   — headroom (don't try to mount under a low ceiling).
     *   2. FWD  — clearance at the raised height (a hit here is a real wall).
     *   3. DOWN — the walkable surface a little ahead; its height above the
     *             current footing is the step height.
     *
     * @param collider - The character's capsule collider.
     * @param dirX - Horizontal movement direction X (need not be normalised).
     * @param dirZ - Horizontal movement direction Z.
     * @param maxStep - Tallest step to treat as walkable (m).
     * @param minStep - Shortest rise that counts as a step (m); below this the
     *   ground is flat enough that the capsule rolls over it unaided.
     */
    detectStepUp(
        collider: RAPIER.Collider,
        dirX: number,
        dirZ: number,
        maxStep: number,
        minStep = 0.04,
    ): number {
        if (!isRapierReady()) return 0;
        const len = Math.hypot(dirX, dirZ);
        if (len < 1e-6) return 0;
        const nx = dirX / len, nz = dirZ / len;
        const shape = collider.shape;
        const capRadius = (shape as { radius?: number }).radius ?? 0.3;
        const SKIN = 0.03;
        const pos = collider.translation();
        const rot = { x: 0, y: 0, z: 0, w: 1 };
        const flags = RAPIER.QueryFilterFlags.EXCLUDE_SENSORS;
        const groups = PLAYER_VS_STATIC_WORLD;

        // 0) Current foot level: a ray straight down from the centre to the ground
        //    we're standing on. Derived from geometry rather than read off the
        //    capsule (collider.shape.halfHeight came back short at runtime, which
        //    put the sample rays above the ground so they hit nothing).
        const downHere = this.world.castRayAndGetNormal(new RAPIER.Ray(pos, { x: 0, y: -1, z: 0 }), 4.0, true, flags, groups, collider);
        const feetY = downHere ? pos.y - downHere.timeOfImpact : pos.y;

        // 1) Headroom: how far up can the capsule rise before a ceiling stops it?
        //    stopAtPenetration=false so the ground we're standing on (which the
        //    cast is moving away from) doesn't abort it at time-of-impact 0.
        const up = this.world.castShape(pos, rot, { x: 0, y: 1, z: 0 }, shape, 0, maxStep + SKIN, false, flags, groups, collider);
        const lift = Math.min(up ? Math.max(0, up.time_of_impact) : maxStep + SKIN, maxStep);

        // 2) Sample the ground just past the lip with thin DOWN-rays — NOT a wide
        //    capsule cast. The capsule is ~0.3 m fat, so on a sidewalk only a bit
        //    wider than the curb the cast hits the building behind and reports the
        //    curb as an un-steppable wall (time-of-impact 0). A ray ignores walls
        //    beside the sample point, so a narrow lip is measured correctly. Cast
        //    each ray from just above the highest steppable height down past the
        //    feet, and take the first walkable surface raised above the feet by a
        //    real step the character also has headroom to mount (a point inside a
        //    wall reads rise > maxStep → skip; lift caps it under a low ceiling).
        const rayY = feetY + maxStep + SKIN;
        const rayLen = maxStep + 2 * SKIN;
        const ceil = Math.min(maxStep, lift);
        let rise = 0;
        for (const d of [capRadius, capRadius + 0.1, capRadius + 0.2]) {
            const ray = new RAPIER.Ray({ x: pos.x + nx * d, y: rayY, z: pos.z + nz * d }, { x: 0, y: -1, z: 0 });
            const hit = this.world.castRayAndGetNormal(ray, rayLen, true, flags, groups, collider);
            if (!hit) continue;
            const r = (rayY - hit.timeOfImpact) - feetY;   // surface height above the feet
            if (r < minStep || r > ceil || hit.normal.y <= 0.5) continue;
            // TREAD-DEPTH confirmation: the lip must be a real standable surface, not a
            // one-voxel sliver on the face of a TALLER wall. Without this, walking into
            // a knee-high platform side made the character rise onto the sliver, fail to
            // find support, time out, fall, and repeat — a silly bob loop. A second ray
            // 0.35 m deeper must find the SAME surface height (±0.25); inside a wall it
            // reads far above the window and rejects the step.
            // solid=false: if the confirm origin sits INSIDE the wall body (the lip is a
            // sliver on a taller wall), a solid ray reports a hit AT the origin, which
            // fakes a surface at exactly the window height. Non-solid rays ignore the
            // containing shape, so an in-wall origin finds no surface and rejects.
            const confirm = new RAPIER.Ray({ x: pos.x + nx * (d + 0.35), y: rayY, z: pos.z + nz * (d + 0.35) }, { x: 0, y: -1, z: 0 });
            const chit = this.world.castRayAndGetNormal(confirm, rayLen, false, flags, groups, collider);
            if (!chit || chit.normal.y <= 0.5) continue;
            const cr = (rayY - chit.timeOfImpact) - feetY;
            if (Math.abs(cr - r) > 0.25) continue;
            rise = r;
            break;
        }
        return rise;
    }

    /**
     * The height of the SURFACE THE CAR DRIVES ON at a point, skipping whatever
     * hangs over it.
     *
     * A plain down-ray returns the first thing it meets, which on a town street
     * is a tree canopy, a lamppost head or an awning. Measured: profiles built
     * that way reported grades of 24 (a 5 m canopy across a 0.2 m sample), which
     * then placed the clearance sweep up in the branches and rejected every leg.
     * `VxlSceneTerrainSystem.getBakedSurfaceHeightAt` has the same problem and
     * solves it by re-casting beneath each hit until it reaches the one rigid
     * body it knows is the baked level — a test `PhysicsWorld` cannot make,
     * since it does not know which body that is.
     *
     * So use continuity instead: ground does not teleport. Accept the first hit
     * within `VEHICLE_PROBE_GROUND_BAND` of the last known ground height, and
     * skip past anything further away. That tracks slopes and bridge decks (the
     * surface stays continuous under the car) while rejecting canopies, and it
     * still admits kerbs and ledges, which are far smaller than the band.
     *
     * `origin.y` is the top of the ray, already lifted VEHICLE_PROBE_LIFT above
     * the reference line; the search stops VEHICLE_PROBE_MAX_FALL below that
     * line. Returns null when nothing plausible is under the point.
     */
    private castForGroundY(
        origin: { x: number; y: number; z: number },
        lastGroundY: number,
        flags: RAPIER.QueryFilterFlags,
        groups: number,
    ): number | null {
        const floorY = origin.y - VEHICLE_PROBE_LIFT - VEHICLE_PROBE_MAX_FALL;
        let fromY = origin.y;
        for (let skips = 0; skips < VEHICLE_PROBE_MAX_OVERHEAD_SKIPS; skips++) {
            const remaining = fromY - floorY;
            if (remaining <= 0) return null;
            const hit = this.world.castRayAndGetNormal(
                new RAPIER.Ray({ x: origin.x, y: fromY, z: origin.z }, { x: 0, y: -1, z: 0 }),
                remaining,
                true,
                flags,
                groups,
            );
            if (!hit) return null;
            const hitY = fromY - hit.timeOfImpact;
            if (Math.abs(hitY - lastGroundY) <= VEHICLE_PROBE_GROUND_BAND) return hitY;
            // Overhead clutter — drop just beneath it and look again.
            fromY = hitY - VEHICLE_PROBE_OVERHEAD_STEP_DOWN;
        }
        return null;
    }

    /**
     * Can a vehicle of this footprint drive the straight segment `from` → `to`?
     *
     * The vehicle counterpart to `detectStepUp`, and the only vehicle query that
     * sees STATIC props: the ground-material mask and `getBakedSurfaceHeightAt`
     * both skip prop instances, so a car planned purely off those will drive
     * into lampposts and structures. Measured on game 8I2U5V99O8EO — the NPC
     * reached the Market Gazebo's plaza and wedged against the gazebo itself.
     * DYNAMIC_PROP is deliberately NOT queried: a route planner should route
     * over a crate the car will shove aside, not around it.
     *
     * Two mechanisms, because neither alone works. Down-rays build a height
     * profile, which catches kerbs and ledges the swept box flies over (the box
     * bottom sits a wheel-radius above the ground). The swept box catches walls,
     * lampposts and structures the centreline profile misses. A horizontal sweep
     * alone cannot tell a kerb from an uphill road — both are solid geometry in
     * front of the car.
     *
     * `from.y` / `to.y` are reference heights, not exact ground: the probe lifts
     * VEHICLE_PROBE_LIFT above the interpolation and drops at most
     * VEHICLE_PROBE_MAX_FALL, and re-shoots any sample that found nothing from
     * VEHICLE_PROBE_HIGH_LIFT so ground far ABOVE the reference still registers.
     * The profile is queried against ENVIRONMENT | TERRAIN, the sweep against
     * ENVIRONMENT only (terrain shape is the grade rule's job — sweeping it too
     * makes every hill an 'obstacle'). Never VEHICLE or PLAYER, so a parked car
     * cannot make a road unroutable.
     *
     * FAILS CLOSED, and the failure is not distinguishable from a real hit:
     * when Rapier is not ready this returns `{ passable: false, reason:
     * 'obstacle', blockedAt: 0 }`, exactly what a wall right at `from` returns.
     * "Could not answer" must never read as clear road, so callers that need to
     * tell the two apart must check readiness themselves before asking.
     *
     * Collider availability is the caller's problem: baked maps create map
     * colliders disabled and enable them ~15 frames later, and voxel worlds
     * ≥64 m disable terrain/environment colliders outside `physicsDistance`.
     * Probing before colliders are live returns 'gap' for everything, and a
     * building in a culled chunk reads as CLEAR ROAD — a silent wrong pass.
     * Probe only once colliders exist and only within the physics radius.
     *
     * PLANNING-TIME ONLY. A 20 m segment costs ~20 raycasts plus ~20 shape
     * casts (up to ~40 raycasts where the reference height misses the ground and
     * every sample needs its high retry). Right for the few thousand calls a
     * route search makes at load; wrong to call every frame from a driving
     * component.
     */
    probeVehiclePath(
        from: THREE.Vector3,
        to: THREE.Vector3,
        options: VehiclePathProbeOptions,
    ): VehiclePassResult {
        const span = Math.hypot(to.x - from.x, to.z - from.z);
        if (span < 1e-6) {
            return { passable: true, blockedAt: 0, reason: 'clear', peakGrade: 0 };
        }
        if (!isRapierReady()) {
            // Fail closed: "cannot answer" must never read as "clear", or a
            // planner routes cars through walls.
            return { passable: false, blockedAt: 0, reason: 'obstacle', peakGrade: 0 };
        }

        const flags = RAPIER.QueryFilterFlags.EXCLUDE_SENSORS;
        const groundGroups = makeCollisionGroups(
            CollisionGroup.VEHICLE,
            CollisionGroup.ENVIRONMENT | CollisionGroup.TERRAIN,
        );
        // The clearance sweep (step 2) queries these SAME groups. An earlier
        // version skipped TERRAIN, trying to stop rising ground reading as a
        // wall — that was wrong twice over. A baked `.vwld` level registers its
        // surface in the ENVIRONMENT group (see the note in `detectStepUp`, and
        // VxlSceneTerrainSystem's ENVIRONMENT_COLLISION_GROUPS), so on exactly
        // the levels this feature targets, filtering TERRAIN out excluded
        // nothing and the sweep still hit the road at time_of_impact ≈ 0 on
        // every leg. Meanwhile it DID blind the sweep to procedural voxel
        // terrain. Rising ground is handled by aiming the cast along the slope
        // instead (below), which is geometry rather than filtering, and works
        // whichever group the ground happens to live in.
        const dirX = (to.x - from.x) / span;
        const dirZ = (to.z - from.z) / span;

        /**
         * Down-ray origin `distance` metres along the segment: the caller's
         * from→to line interpolated horizontally AND vertically, lifted
         * VEHICLE_PROBE_LIFT so the ray starts above the reference height.
         */
        const probeOrigin = (distance: number): { x: number; y: number; z: number } => {
            const t = distance / span;
            return {
                x: from.x + (to.x - from.x) * t,
                y: from.y + (to.y - from.y) * t + VEHICLE_PROBE_LIFT,
                z: from.z + (to.z - from.z) * t,
            };
        };
        /** Drivable-surface height `distance` along, anchored on known ground. */
        const groundAt = (distance: number, anchor: number): number | null =>
            this.castForGroundY(probeOrigin(distance), anchor, flags, groundGroups);

        // 1) Ground profile: a down-ray at each sample point, skipping anything
        //    that is not the surface the car is driving on (see castForGroundY).
        const stepCount = Math.max(1, Math.ceil(span / VEHICLE_PROBE_SPACING));
        let samples: PathSample[] = [];
        // Seeded with the caller's reference — the vehicle's own Y — then
        // follows the ground as the profile walks along.
        let lastGroundY = from.y;
        for (let i = 0; i <= stepCount; i++) {
            const distance = (i / stepCount) * span;
            const groundY = groundAt(distance, lastGroundY);
            if (groundY !== null) {
                lastGroundY = groundY;
                samples.push({ distance, height: groundY });
                continue;
            }
            // Nothing under the reference height. Before calling it a gap, look
            // again from far above: the caller's reference is the vehicle's own
            // Y and it does not know the ground height either — that is what it
            // is asking. Only a miss from up here is a real hole. The retry
            // still stops at the same floor, so a genuine cliff (a bottom more
            // than VEHICLE_PROBE_MAX_FALL below the reference) stays a gap.
            // Coming from above it can land on a roof or bridge deck over the
            // road instead of the road; that reads as a step and rejects the
            // leg, which is the safe direction to be wrong in, and it only
            // happens where the ordinary ray already found nothing.
            const origin = probeOrigin(distance);
            const retryOriginY = origin.y - VEHICLE_PROBE_LIFT + VEHICLE_PROBE_HIGH_LIFT;
            const retryHit = this.world.castRayAndGetNormal(
                new RAPIER.Ray({ x: origin.x, y: retryOriginY, z: origin.z }, { x: 0, y: -1, z: 0 }),
                VEHICLE_PROBE_HIGH_LIFT + VEHICLE_PROBE_MAX_FALL,
                true,
                flags,
                groundGroups,
            );
            samples.push({
                distance,
                height: retryHit ? retryOriginY - retryHit.timeOfImpact : null,
            });
        }

        // 1a) Resolve isolated misses. Adjacent collider meshes do not always
        //     meet exactly, and a down-ray that lands in the seam finds
        //     nothing — which, untreated, reads as a hole and refuses the
        //     whole leg. Measured on Maple Hollow: seams 0.02 m, 0.11 m and
        //     0.22 m wide, each killing a route no car would have trouble
        //     with. So measure the miss instead of assuming: walk out to
        //     either side until ground comes back, and bridge it only if the
        //     whole miss is narrower than the wheel can roll over
        //     (`bridgeableGapWidth`) AND both edges agree on a height. A
        //     genuine hole has agreeing edges too, so the WIDTH is the
        //     discriminator; the height check is the fail-closed net for a
        //     miss that straddles a cliff edge.
        const maxSeam = bridgeableGapWidth(options.maxStepHeight);
        /** First ground found stepping away from `distance`, or null within `maxSeam`. */
        const missEdge = (
            distance: number, direction: 1 | -1, anchor: number,
        ): { at: number; height: number } | null => {
            for (let step = VEHICLE_PROBE_GAP_REFINE_SPACING; step <= maxSeam; step += VEHICLE_PROBE_GAP_REFINE_SPACING) {
                const at = distance + direction * step;
                const height = groundAt(at, anchor);
                if (height !== null) return { at, height };
            }
            return null;
        };
        if (maxSeam > 0) {
            for (let i = 0; i < samples.length; i++) {
                const sample = samples[i]!;
                if (sample.height !== null) continue;
                // Anchor the scan on the nearest height already known, so
                // castForGroundY's overhead-skipping has the same reference
                // the coarse pass used rather than the vehicle's own Y.
                let anchor = from.y;
                for (let k = 1; k < samples.length; k++) {
                    const back = samples[i - k], forward = samples[i + k];
                    if (back && back.height !== null) { anchor = back.height; break; }
                    if (forward && forward.height !== null) { anchor = forward.height; break; }
                }
                const before = missEdge(sample.distance, -1, anchor);
                const after = missEdge(sample.distance, 1, anchor);
                if (!before || !after) continue;              // wider than a wheel can bridge on one side
                if (after.at - before.at > maxSeam) continue; // ...or in total
                if (Math.abs(after.height - before.height) > options.maxStepHeight) continue;
                const t = (sample.distance - before.at) / (after.at - before.at);
                sample.height = before.height + (after.height - before.height) * t;
            }
        }

        // 1b) Refine around suspected steps. At VEHICLE_PROBE_SPACING a kerb and
        //     a steep ramp are the same number: 0.34 m of rise spread over a
        //     metre reads as grade 0.34 either way, and a car can drive one and
        //     not the other. Re-sample any interval whose rise exceeds what the
        //     wheel can mount, so the profile shows WHERE the rise happens.
        //     Only fires where something looks like a step, so the common case
        //     stays at one ray per metre.
        const refined: PathSample[] = [];
        for (let i = 0; i < samples.length; i++) {
            const a = samples[i]!;
            refined.push(a);
            const b = samples[i + 1];
            if (!b || a.height === null || b.height === null) continue;
            if (Math.abs(b.height - a.height) <= options.maxStepHeight) continue;

            const gap = b.distance - a.distance;
            const subCount = Math.max(1, Math.round(gap / VEHICLE_PROBE_STEP_REFINE_SPACING));
            for (let s = 1; s < subCount; s++) {
                const d = a.distance + (gap * s) / subCount;
                // Same ground-finding as the coarse pass — a raw ray here would
                // reintroduce canopies into exactly the intervals being examined
                // most closely. Anchored on the interval's near end, which is
                // known ground.
                const subY = groundAt(d, a.height);
                // A miss inside a refinement window is not news — the coarse
                // samples on both sides already found ground — so skip it
                // rather than manufacturing a 'gap' the caller cannot act on.
                if (subY !== null) refined.push({ distance: d, height: subY });
            }
        }
        samples = refined;

        // 2) Clearance sweep, one short cast per profile interval so the box
        //    follows the ground. A single long sweep either clips a rise or
        //    floats over a dip.
        // A SLAB of the vehicle's cross-section, not its whole body. Sweeping a
        // full-length box centred on the path overhangs footprint.length/2
        // (~1.9 m) past BOTH ends of the segment, so the probe answers about
        // ~3.8 m of ground the caller never asked about — measured: a 4 m leg
        // over dead-flat road came back 'obstacle' because the box's nose
        // reached a kerb 2 m beyond the endpoint. The shorter the leg the more
        // the overhang dominates, which made short legs almost always fail.
        // Sweeping a thin slab tests the corridor the car passes THROUGH, which
        // is what a route planner is asking; the car's length matters for
        // turning room, not for straight-line traversal, and whatever lies past
        // the endpoint belongs to the next leg.
        const shape = new RAPIER.Cuboid(
            options.footprint.width / 2,
            options.footprint.height / 2,
            VEHICLE_SWEEP_SLAB_HALF_DEPTH,
        );
        const yaw = Math.atan2(dirX, dirZ);
        const rotation = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };

        let sweepHitAt: number | null = null;
        for (let i = 0; i + 1 < samples.length; i++) {
            const a = samples[i]!;
            const b = samples[i + 1]!;
            if (a.height === null || b.height === null) continue;
            const segment = b.distance - a.distance;
            if (segment <= 1e-6) continue;
            const position = {
                x: from.x + dirX * a.distance,
                y: a.height + options.rideHeight,
                z: from.z + dirZ * a.distance,
            };
            // Aim along the LOCAL SLOPE, not horizontally. The box reaches
            // length/2 (~2 m) beyond its origin, so a horizontal cast on rising
            // ground buries its front-bottom corner in the road and returns
            // time_of_impact ≈ 0 — which is what made every hill (and, on baked
            // levels, every leg) report 'obstacle'. Following the slope keeps
            // the box parallel to the surface it is driving over, so only things
            // that genuinely stand proud of the road stop it.
            const rise = b.height - a.height;
            const travel = Math.hypot(segment, rise);
            const sweepDir = {
                x: dirX * (segment / travel),
                y: rise / travel,
                z: dirZ * (segment / travel),
            };
            const hit = this.world.castShape(
                position,
                rotation,
                sweepDir,
                shape,
                0,
                travel,
                false,
                flags,
                groundGroups,
            );
            if (hit) {
                sweepHitAt = a.distance + Math.max(0, hit.time_of_impact);
                break;
            }
        }

        return evaluateVehiclePath(samples, options.maxClimbGrade, options.maxStepHeight, sweepHitAt);
    }

    /**
     * True if any non-sensor collider in `collisionMask` intersects an
     * axis-aligned box at `center` with the given half-extents, excluding
     * `excludeBody` by identity (not group/mask — the caller may want to
     * query the SAME group its excluded body lives in, e.g. a baked level's
     * own terrain body sits in ENVIRONMENT alongside the props on the road).
     *
     * Built for the vehicle-nav bake's per-cell obstruction query (a box
     * straddling the space just above the road surface, catching props/street
     * furniture the ground-only centre down-ray can miss when they stand
     * off-centre in the cell) — see `VehicleNavGridBake.ts`'s
     * `CheckObstruction`. Written generically, following the same
     * `intersectionWithShape` query family `probeVehiclePath`'s sweep already
     * uses (`castShape`), just with zero travel distance and a boolean result
     * instead of a time-of-impact.
     *
     * Fails closed like every other "cannot answer" query in this file: not
     * ready -> false (no obstruction found) would silently pass a cell that
     * might be blocked, but the bake's caller (VehicleNavGridBakePass) only
     * calls this once Rapier and colliders are already known live (the same
     * precondition `castDown` requires), so this mirrors `probeVehiclePath`'s
     * readiness guard rather than inventing a different failure mode here.
     */
    intersectsBox(
        center: THREE.Vector3,
        halfExtents: THREE.Vector3,
        collisionMask: number,
        excludeBody?: RAPIER.RigidBody,
    ): boolean {
        if (!isRapierReady()) return false;
        const shape = new RAPIER.Cuboid(halfExtents.x, halfExtents.y, halfExtents.z);
        const rotation = { x: 0, y: 0, z: 0, w: 1 };
        const flags = RAPIER.QueryFilterFlags.EXCLUDE_SENSORS;
        // The query shape is a member of all groups and filters TO collisionMask —
        // same convention `raycast()` uses (see makeCollisionGroups(0xFFFF, mask)).
        const groups = makeCollisionGroups(0xFFFF, collisionMask);
        const hit = this.world.intersectionWithShape(
            center, rotation, shape, flags, groups, undefined, excludeBody,
        );
        return hit !== null;
    }

    /**
     * Probe for a LEDGE the character can mantle onto: a standable surface just
     * ahead along (dirX, dirZ) whose top sits between `minBelowCenter` and
     * `maxBelowCenter` metres BELOW the capsule centre (i.e. roughly at foot /
     * waist height while airborne next to it). Requires a real tread (a second,
     * deeper sample at the same height) and standing headroom above the lip.
     * Returns the ledge top's world Y, or null.
     */
    ledgeForMantle(collider: RAPIER.Collider, dirX: number, dirZ: number, minBelowCenter: number, maxBelowCenter: number): number | null {
        if (!isRapierReady()) return null;
        const pos = collider.translation();
        const groups = PLAYER_VS_STATIC_WORLD;
        const flags = RAPIER.QueryFilterFlags.EXCLUDE_SENSORS;
        const rayFromY = pos.y - minBelowCenter + 0.3;             // just above the highest grabbable top
        const rayLen = (maxBelowCenter - minBelowCenter) + 0.6;
        let top: number | null = null;
        for (const d of [0.75, 1.05]) {
            // solid=false: an origin inside a TALLER wall must find nothing, not report
            // a fake surface at the origin (which would let mantle scale any wall).
            const ray = new RAPIER.Ray({ x: pos.x + dirX * d, y: rayFromY, z: pos.z + dirZ * d }, { x: 0, y: -1, z: 0 });
            const hit = this.world.castRayAndGetNormal(ray, rayLen, false, flags, groups, collider);
            if (!hit || hit.normal.y <= 0.5) return null;          // both samples must be standable
            const t = rayFromY - hit.timeOfImpact;
            // Enforce the grab window on the measured top itself.
            const below = pos.y - t;
            if (below < minBelowCenter - 0.05 || below > maxBelowCenter + 0.05) return null;
            if (top === null) top = t;
            else if (Math.abs(t - top) > 0.3) return null;         // sliver, not a tread
        }
        if (top === null) return null;
        // Standing headroom above the lip at both probe points.
        for (const d of [0.75, 1.05]) {
            const up = new RAPIER.Ray({ x: pos.x + dirX * d, y: top + 0.15, z: pos.z + dirZ * d }, { x: 0, y: 1, z: 0 });
            if (this.world.castRay(up, 1.5, true, flags, groups, collider)) return null;
        }
        return top;
    }

    /**
     * Cast a ray straight down from a character collider's centre and return the
     * distance to the nearest environment/terrain surface below it (Infinity if
     * none within `maxDist`). Used by the curb step-up to tell when the capsule
     * CENTRE — not merely its leading edge — has crossed onto the raised surface,
     * which is the only safe moment to hand control back to gravity + snap-to-
     * ground. Exiting earlier (on the controller's grounded flag, which trips when
     * the front of the capsule first touches the lip) leaves the centre a radius
     * behind the edge, and snap then drags the capsule straight back to the street.
     */
    groundDistBelowCenter(collider: RAPIER.Collider, maxDist: number): number {
        if (!isRapierReady()) return Infinity;
        const ray = new RAPIER.Ray(collider.translation(), { x: 0, y: -1, z: 0 });
        const hit = this.world.castRay(ray, maxDist, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, PLAYER_VS_STATIC_WORLD, collider);
        return hit ? hit.timeOfImpact : Infinity;
    }

    /**
     * Macro ground slope under a character capsule, from four short downward rays
     * at ±0.5 m around its centre. Returns rise-over-run plus the downhill
     * direction — or null when any sample finds no ground within the window,
     * which means a platform lip, a ledge edge, or a wall interior rather than a
     * CONTINUOUS slope. That null is load-bearing: the steep-stance movement
     * rules (no climbing/jumping up too-steep faces) must never trigger at the
     * edge of a jumpable platform.
     */
    groundSlopeUnder(collider: RAPIER.Collider): { tan: number; downX: number; downZ: number } | null {
        if (!isRapierReady()) return null;
        const c = collider.translation();
        const S = 0.5;
        // solid=false: a sample origin INSIDE a solid ahead (pressed against a
        // platform slab / wall base) must not report fake terrain at the origin
        // (solid rays return time-of-impact 0 there). That misread turned "flat
        // ground at a wall" into a steep pseudo-slope, which refused jumps and
        // shoved the character away from any platform side it walked against.
        const sample = (dx: number, dz: number): number | null => {
            const ray = new RAPIER.Ray({ x: c.x + dx, y: c.y + 0.5, z: c.z + dz }, { x: 0, y: -1, z: 0 });
            const hit = this.world.castRay(ray, 3.0, false, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, PLAYER_VS_STATIC_WORLD, collider);
            return hit ? (c.y + 0.5 - hit.timeOfImpact) : null;
        };
        const px = sample(S, 0), nx = sample(-S, 0), pz = sample(0, S), nz = sample(0, -S);
        if (px === null || nx === null || pz === null || nz === null) return null;
        const gx = (px - nx) / (2 * S);
        const gz = (pz - nz) / (2 * S);
        const tan = Math.hypot(gx, gz);
        if (tan < 1e-3) return { tan: 0, downX: 0, downZ: 0 };
        return { tan, downX: -gx / tan, downZ: -gz / tan };
    }

    /**
     * Cast a ray straight down from a character collider's centre and return the
     * KINEMATIC rigid body it is standing on, or null when the surface below is
     * static terrain, a dynamic prop, or out of reach. Used by the movement motor
     * to carry a character riding a moving/rotating platform: any kinematic body
     * (KinematicPlatform, custom setNextKinematicTranslation/Rotation movers)
     * qualifies, so game code gets rider-carry without registering anything.
     */
    kinematicBodyBelowCenter(collider: RAPIER.Collider, maxDist: number): RAPIER.RigidBody | null {
        if (!isRapierReady()) return null;
        const ray = new RAPIER.Ray(collider.translation(), { x: 0, y: -1, z: 0 });
        const hit = this.world.castRay(ray, maxDist, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, PLAYER_VS_STATIC_WORLD, collider);
        // A body only counts as RIDDEN if its surface is well below the capsule
        // centre (any real standing surface is ~centerToFeet away). A solid ray
        // whose origin is INSIDE a kinematic volume reports time-of-impact 0 —
        // that's a spinner arm sweeping through the torso, which must be a PUSH
        // (sweeper push in the movement motor), never a ride: treating it as the
        // carry made the character orbit with the arm as if standing on it.
        const body = hit && hit.timeOfImpact >= 0.35 ? hit.collider.parent() : null;
        return body && body.isKinematic() ? body : null;
    }

    /**
     * First KINEMATIC body whose collider overlaps a character capsule at its
     * current pose (moving platforms, spinner arms, closing doors), excluding
     * `exclude` (the platform being ridden — its relative motion is the
     * carry's business, not a push). Full-size probe: a sweeping arm should
     * engage the moment it touches. Kinematic-kinematic pairs generate no
     * contacts and the KCC only resolves collisions when the CHARACTER moves,
     * so without an explicit query a sweeping arm passes straight through a
     * standing player — the movement motor uses this to let kinematic movers
     * PUSH the character.
     */
    kinematicBodyOverlapping(collider: RAPIER.Collider, exclude: RAPIER.RigidBody | null): RAPIER.RigidBody | null {
        if (!isRapierReady()) return null;
        // A collider (or the excluded carry body) removed since the caller
        // cached it would reach Rapier through a stale handle — reading its
        // shape/translation traps the WASM module instead of throwing.
        if (!collider.isValid()) return null;
        const excludeBody = exclude?.isValid() ? exclude : undefined;
        const shape = collider.shape as { halfHeight?: number; radius?: number };
        const probe = new RAPIER.Capsule(shape.halfHeight ?? 0.4, shape.radius ?? 0.3);
        const hit = this.world.intersectionWithShape(
            collider.translation(), { x: 0, y: 0, z: 0, w: 1 }, probe,
            RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, PLAYER_VS_STATIC_WORLD, collider, excludeBody,
            (c) => c.parent()?.isKinematic() === true,
        );
        const body = hit?.parent() ?? null;
        return body?.isValid() ? body : null;
    }

    /**
     * True when a character capsule placed at `at` overlaps the FIXED static
     * world (environment/terrain) beyond the character controller's skin. The
     * probe capsule is shrunk by `shrink` so resting contact within the KCC's
     * offset never reads as overlap — only real penetration does. Kinematic
     * bodies (moving platforms) are deliberately ignored: a platform sweeping
     * through the character is the solve/carry's business, not depenetration's.
     * Movement code uses this to (a) refuse a platform-carry displacement that
     * would push the rider inside solid ground and (b) float a capsule that is
     * somehow already embedded back up instead of leaving it wedged forever
     * (an embedded capsule blocks in every horizontal direction, and the KCC
     * never resolves deep initial penetration on its own).
     */
    capsuleOverlapsStatic(collider: RAPIER.Collider, at: { x: number; y: number; z: number }, shrink = 0.05): boolean {
        if (!isRapierReady()) return false;
        const shape = collider.shape as { halfHeight?: number; radius?: number };
        const probe = new RAPIER.Capsule(
            Math.max(0.05, (shape.halfHeight ?? 0.4) - shrink),
            Math.max(0.05, (shape.radius ?? 0.3) - shrink),
        );
        const hit = this.world.intersectionWithShape(
            at, { x: 0, y: 0, z: 0, w: 1 }, probe,
            RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, PLAYER_VS_STATIC_WORLD, collider, undefined,
            (c) => c.parent()?.isFixed() === true,
        );
        return hit !== null;
    }

    /**
     * Vehicle action registration (no-op for Rapier).
     * Rapier vehicles use DynamicRayCastVehicleController which is updated directly
     * in the vehicle's update method, not through the physics world.
     * This method exists for API compatibility with the old AmmoJS vehicle system.
     */
    addAction(_vehicle: unknown): void {
        // No-op: Rapier vehicles are updated directly via vehicleController.updateVehicle()
    }

    /**
     * Vehicle action removal (no-op for Rapier).
     * This method exists for API compatibility with the old AmmoJS vehicle system.
     */
    removeAction(_vehicle: unknown): void {
        // No-op: Rapier vehicles are cleaned up via dispose() on the vehicle
    }

    /**
     * Get physics world statistics for performance monitoring.
     */
    getStats(): { rigidBodyCount: number; colliderCount: number } {
        return {
            rigidBodyCount: this.world.bodies.len(),
            colliderCount: this.world.colliders.len(),
        };
    }

    dispose(): void {
        this.isWorldDisposed = true;
        this.collisionCallbacks.clear();
        this.handleToUserData.clear();
        this.quarantineSanitizedThisStep = [];
        this.quarantineReadyForRemoval = [];
        this.world.free();
    }
}

