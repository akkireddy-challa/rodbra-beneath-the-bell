import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import type { LegacyNavMesh } from 'engine/LegacyNavMesh.js';
import { getGlobalNavMesh } from 'engine/VoxelNavMesh.js';
import type { IPlayerMovement } from 'engine/IPlayerMovement.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import type RAPIER from '@dimforge/rapier3d-compat';
import { AgentPriority, getGlobalAgentAvoidance } from 'engine/AgentAvoidance.js';
import { getGlobalPathConflictAvoidance } from 'engine/PathConflictAvoidance.js';
import { getGlobalPathQueue } from 'engine/npc/nav/PathRequestQueue.js';
import { PathRequestTracker } from 'engine/npc/nav/PathRequestTracker.js';

/**
 * Callback interface for controller-specific movement operations.
 */
export interface NavigationCallbacks {
    /** Get the character's Object3D (for position and rotation) */
    getCharacter(): THREE.Object3D;
    /** Get the character's physics body (may be null for animals) */
    getPhysicsBody(): RAPIER.RigidBody | null;
    /** Get the physics world */
    getPhysicsWorld(): PhysicsWorld;
    /** Get the engine */
    getEngine(): EngineLike;
    /** Get the nav mesh */
    getNavMesh(): LegacyNavMesh | null;
    /** Whether the character is grounded (for step-hop) */
    isGrounded(): boolean;
    /** Run the movement system with the given direction. Returns nothing. */
    runMovementSystem(deltaTime: number, moveDirection: THREE.Vector3, shouldHop: boolean): void;
    /** Capsule radius used for agent-to-agent avoidance. */
    getAgentRadius(): number;
    /** Priority tier used by AgentAvoidance to decide who yields. */
    getAgentPriority(): AgentPriority;
}

/**
 * Optional configuration for speed ramping (used by AnimalController).
 */
export interface SpeedRampingConfig {
    /** Whether to use smooth speed ramping */
    enabled: boolean;
    /** Get the character dimensions for acceleration calculation */
    getCharacterDepth?: () => number;
}

/**
 * NavigationComponent - Handles path following, stuck detection, step-hop, and rotation.
 * Shared between NpcController and AnimalController.
 */
export class NavigationComponent {
    // Path state
    private path: THREE.Vector3[] = [];
    private currentWaypointIndex: number = 0;
    private minDistanceToWaypoint: number = 0.5;
    // Final-waypoint arrival tolerance. Intermediate waypoints always use
    // `minDistanceToWaypoint` (coarse, keeps cornering smooth), but the LAST
    // waypoint — the actual destination — uses this radius so callers can ask
    // the agent to walk right up to a precise point. Defaults to
    // `minDistanceToWaypoint` so existing behaviour is unchanged until a caller
    // opts in via setArrivalRadius().
    private arrivalRadius: number = 0.5;

    // Agent-to-agent avoidance. When false this agent still navigates normally
    // (paths, arrives, animates) but does not steer around other agents while
    // moving. Pair with the userData `avoidanceDisabled` flag (set by the
    // controller) so other agents also ignore this one. Lets scripted/queued
    // NPCs follow exact paths without yielding to each other.
    private avoidanceEnabled: boolean = true;

    // Straight-line mode. When true, setTargetPosition skips the navmesh A*
    // and heads directly to the exact target (a single-waypoint path). For
    // orchestrated NPCs on open ground where pathfinding is pure overhead.
    // Movement, arrival, locomotion animation and (optional) avoidance all
    // behave identically — only how the path is produced changes. Obstacle
    // routing is the caller's responsibility in this mode.
    private straightLinePath: boolean = false;

    // Movement speed
    private moveSpeed: number;
    private currentSpeed: number;
    private targetSpeed: number;

    // Stuck detection
    private previousPosition: THREE.Vector3 = new THREE.Vector3();
    private previousIntendedMovement: number = 0;
    private movementEpsilon: number = 0.001;
    private stuckFrameCount: number = 0;
    private stuckFrameThreshold: number = 120;
    private isIdling: boolean = false;
    private idleTimer: number = 0;
    private idleDuration: number = 1.0;

    /**
     * True when the most recent updateNoPathApproach() refused to step because
     * the next cell is a navmesh obstacle (target unreachable from here). The
     * owning controller reads this to drop the target and pick a new one
     * instead of beelining into/onto the obstacle.
     */
    private noPathApproachBlocked = false;

    /**
     * True when the agent walked its whole path but the path END is still well
     * short of the actual requested target — i.e. the target sat inside an
     * obstacle and was snapped to the obstacle's edge, so it's unreachable. The
     * owning controller reads this to drop the target and let the behaviour pick
     * a new, reachable one instead of parking at the obstacle edge forever.
     */
    private stoppedShortOfTarget_ = false;

    // Step-hop
    private _maxStepUpHeight: number = 1.0;
    private _stepHopEnabled: boolean = true;
    private _stepHopCooldown: number = 0;
    private readonly STEP_HOP_COOLDOWN_DURATION: number = 0.5;
    private readonly STUCK_FRAMES_BEFORE_HOP: number = 15;

    // Smooth rotation
    private rotationSpeed: number = 5.0;
    // When true, the movement system owns facing — steer toward the waypoint and
    // don't auto-rotate toward travel (see setOrchestratedFacing).
    private orchestratedFacing: boolean = false;

    // Speed ramping (optional, used by AnimalController)
    private speedRampingConfig: SpeedRampingConfig;
    private lastKnownTargetPosition: THREE.Vector3 | null = null;

    // Target
    private currentTarget: THREE.Vector3 | null = null;
    /**
     * Stored maxPathLength budget for the active target — re-used by
     * `replanWithExtras` so internal replans honour the same cap the
     * caller picked. `undefined` means "use the navmesh's smart default
     * (max(20 m, linearDist × 1.3))".
     */
    private currentMaxPathLength: number | undefined = undefined;

    // Async pathfinding (global-navmesh requests go through PathRequestQueue).
    // The tracker sequences submissions so a landing result is dropped if it
    // was superseded by a newer request or cancelled meanwhile, and answers
    // isPathPending() for controllers gating their no-path fallbacks.
    private readonly pathTracker = new PathRequestTracker();
    /** Supplies hero/crowd priority + camera distance for queue ordering.
     *  Null (no provider installed) means the component pathfinds
     *  SYNCHRONOUSLY like it always did — controllers not wired to the LOD
     *  scheduler (snakes) keep the pre-LOD behavior. */
    private lodPriorityProvider: (() => { hero: boolean; distSq: number }) | null = null;
    /** Coalescing key for the path queue — controllers pass their npcId. */
    private navKey: string = 'nav-' + Math.random().toString(36).slice(2);
    private disposed = false;

    // Callbacks
    private callbacks: NavigationCallbacks;

    // Path-conflict avoidance registration state. The component lazily
    // registers itself the first time setTargetPosition() runs (by which
    // point the physics body is guaranteed to exist), and unregisters on
    // dispose() to keep the system's agent set in sync with live characters.
    private pathConflictRegisteredHandle: number | null = null;

    constructor(
        moveSpeed: number,
        callbacks: NavigationCallbacks,
        speedRampingConfig?: SpeedRampingConfig,
    ) {
        // Clamp to match setMoveSpeed(): moveSpeed is a DIVISOR in the speed-ramp
        // math (currentSpeed / moveSpeed). A 0 (or negative) speed
        // makes that 0/0 = NaN, which flows into setLinvel and sends the NPC body
        // non-finite — the source of the `type=npc bad=[linvel]` quarantine hits.
        this.moveSpeed = Math.max(0.1, moveSpeed);
        this.currentSpeed = this.moveSpeed;
        this.targetSpeed = this.moveSpeed;
        this.callbacks = callbacks;
        this.speedRampingConfig = speedRampingConfig ?? { enabled: false };
    }

    // ════════════════════════════════════════════════════════════════════════
    // Target / Path Management
    // ════════════════════════════════════════════════════════════════════════

    setTargetPosition(
        target: THREE.Vector3 | null,
        extraObstacles?: ReadonlyArray<{ x: number; z: number; radius: number }>,
        maxPathLength?: number,
    ): void {
        // Lazy-register with the path-conflict system on first call —
        // physics body & character object are guaranteed live by now.
        this.ensureRegisteredWithPathConflict();

        // Fresh target → clear the "parked short of target" flag.
        this.stoppedShortOfTarget_ = false;

        this.currentMaxPathLength = maxPathLength;
        if (!target) {
            // Drop any in-flight queued request so a stale result can't land
            // after the caller explicitly cleared the target.
            this.pathTracker.cancelAll();
            getGlobalPathQueue().cancel(this.navKey);
            this.currentTarget = null;
            this.path = [];
            this.currentWaypointIndex = 0;
            this.stopMovement();
            return;
        }
        this.currentTarget = target.clone();
        this.lastKnownTargetPosition = target.clone();

        // Straight-line mode: skip the navmesh entirely. A single-waypoint path
        // straight to the exact target — no A*, no obstacle routing, no cost.
        if (this.straightLinePath) {
            this.path = [target.clone()];
            this.currentWaypointIndex = 0;
            return;
        }

        const currentPos = this.callbacks.getCharacter().position.clone();
        const globalNav = getGlobalNavMesh();
        if (globalNav && globalNav.isReady()) {
            // If the requested target lands on a blocked cell (e.g. inside a
            // building or other static obstacle), findPath() falls back to a
            // straight line that walks the character right into the obstacle.
            // Snap the target to the nearest walkable cell first so the path
            // routes AROUND the obstacle and ends at its edge instead.
            const navTarget = this.snapToValidTarget(globalNav, target);
            // If caller didn't pass explicit extras (typical case), pull the
            // currently active set from the path-conflict system so this
            // first plan also routes around already-flagged peers.
            let finalExtras = extraObstacles;
            if (!finalExtras) {
                const pcs = getGlobalPathConflictAvoidance();
                const body = this.callbacks.getPhysicsBody();
                if (pcs && body) {
                    const active = pcs.getActiveExtrasForAgent(body.handle);
                    if (active.length > 0) finalExtras = active;
                }
            }
            // No LOD priority provider installed (snakes, or any controller
            // that hasn't opted in): keep the original synchronous pathfind.
            // Installing a provider (NpcController, AnimalController) opts
            // into the async queue below. Async callers whose no-path logic
            // reacts within a frame (AnimalController's beeline approach)
            // must gate that logic on isPathPending() — the result lands 1-3
            // frames later, and clearing the target meanwhile would cancel
            // the queued request and livelock.
            if (!this.lodPriorityProvider) {
                this.path = globalNav.findPath(currentPos, navTarget, finalExtras, maxPathLength);
                this.currentWaypointIndex = 0;
                return;
            }
            // Route through the frame-budgeted path queue asynchronously. The
            // result lands 1-3 frames later; until then the agent keeps
            // following its existing path (do NOT clear this.path here).
            const seq = this.pathTracker.submit();
            const prio = this.lodPriorityProvider();
            getGlobalPathQueue().submit({
                key: this.navKey,
                start: currentPos, goal: navTarget,
                extraObstacles: finalExtras, maxPathLength,
                hero: prio.hero, distSq: prio.distSq,
                onResult: (path) => {
                    // Land FIRST — even an empty (unreachable) result must
                    // clear isPathPending(), or the owning controller would
                    // hold its no-path fallback forever.
                    const current = this.pathTracker.isCurrent(seq);
                    this.pathTracker.land(seq);
                    if (!current || this.disposed) return; // superseded/cancelled
                    this.path = path;
                    this.currentWaypointIndex = 0;
                },
            });
            return;
        } else {
            const legacyNav = this.callbacks.getNavMesh();
            this.path = legacyNav ? legacyNav.findPath(currentPos, target) : [target];
        }
        this.currentWaypointIndex = 0;
    }

    /**
     * Install the hero/crowd priority provider used to order queued path
     * requests. Installing a provider is ALSO the opt-in to async queued
     * pathfinding: without one, setTargetPosition pathfinds synchronously
     * (original behavior — snakes stay on it). NpcController and
     * AnimalController both install a provider. Contract for async callers:
     * while isPathPending() is true a submitted request has not been served
     * yet, so no-path fallback logic (beeline approach, clearing the target
     * because the approach is blocked) must NOT run — clearing the target
     * cancels the queued request and the submit/cancel cycle livelocks.
     */
    setLodPriorityProvider(provider: (() => { hero: boolean; distSq: number }) | null): void {
        this.lodPriorityProvider = provider;
    }

    /**
     * True while an async path request submitted to the PathRequestQueue has
     * not yet landed. Empty (unreachable) results and cancels both clear the
     * pending state. Owning controllers hold their no-path fallbacks
     * (AnimalController's updateNoPathApproach / blocked-target clearing)
     * while this is true and run a stationary frame instead.
     */
    isPathPending(): boolean {
        return this.pathTracker.isPending();
    }

    /** Set the path-queue coalescing key (controllers pass their npcId). */
    setNavKey(key: string): void {
        this.navKey = key;
    }

    /**
     * Attempt to register this navigator with the global path-conflict
     * avoidance system. Idempotent — no-op if already registered, if the
     * system isn't installed, or if the physics body doesn't exist yet.
     */
    private ensureRegisteredWithPathConflict(): void {
        if (this.pathConflictRegisteredHandle !== null) return;
        const pcs = getGlobalPathConflictAvoidance();
        if (!pcs) return;
        const body = this.callbacks.getPhysicsBody();
        if (!body) return;
        const character = this.callbacks.getCharacter();
        const handle = body.handle;
        pcs.register({
            bodyHandle: handle,
            position: character.position,
            radius: this.callbacks.getAgentRadius(),
            getPath: () => this.path,
            getCurrentWaypointIndex: () => this.currentWaypointIndex,
            getMoveSpeed: () => this.moveSpeed,
            replanWithExtras: (extras) => this.replanWithExtras(extras),
        });
        this.pathConflictRegisteredHandle = handle;
    }

    /**
     * Path-conflict-avoidance-driven replan. Computes a fresh route from
     * the agent's current position to `currentTarget` with the supplied
     * virtual obstacles included, and replaces the active path with the
     * new one whenever findPath returns something walkable.
     *
     * Crucially this does NOT delegate to `setTargetPosition`: that
     * method clobbers `this.path` to `[]` on findPath failure (no route
     * through the obstacles), which makes the update loop call
     * `stopMovement()` and the animation system switch to idle for a
     * frame — the visible "walking animation often interrupted" symptom.
     * Preserving the existing path on failure lets the agent continue
     * along its previous route while waiting for the conflict to clear.
     *
     * Earlier this method also had a "skip if the new initial heading
     * matches the old within 15°" filter to avoid animation twitches.
     * That filter rejected legitimate replans whose detour around the
     * peer started in the same direction the agent was already walking
     * (typical for a mid-path obstacle), so virtual obstacles silently
     * stopped having any effect. The walk-cycle preservation in
     * `MixamoAnimationPlayer.preservedLoopTime` is the right fix for the
     * twitch; this method just trusts the planner.
     */
    private replanWithExtras(extras: ReadonlyArray<{ x: number; z: number; radius: number }>): void {
        // Stays synchronous on purpose: replans are rare, conflict-driven, and fail soft.
        if (!this.currentTarget) return;
        const globalNav = getGlobalNavMesh();
        if (!globalNav || !globalNav.isReady()) return;

        const currentPos = this.callbacks.getCharacter().position;
        const navTarget = this.snapToValidTarget(globalNav, this.currentTarget);
        const newPath = globalNav.findPath(currentPos, navTarget, extras, this.currentMaxPathLength);
        if (newPath.length === 0) {
            // No route through the current obstacle set — keep walking the
            // existing path. The scanner will re-flag and retry as
            // peers move; meanwhile reactive AgentAvoidance handles the
            // last-metre dodge.
            return;
        }
        this.path = newPath;
        this.currentWaypointIndex = 0;
    }

    /**
     * Release path-conflict registration. Owning controllers must call
     * this from their dispose() to keep the system's agent set in sync.
     */
    dispose(): void {
        this.disposed = true;
        this.pathTracker.cancelAll();
        getGlobalPathQueue().cancel(this.navKey);
        if (this.pathConflictRegisteredHandle !== null) {
            const pcs = getGlobalPathConflictAvoidance();
            if (pcs) pcs.unregister(this.pathConflictRegisteredHandle);
            this.pathConflictRegisteredHandle = null;
        }
    }

    getCurrentTarget(): THREE.Vector3 | null {
        return this.currentTarget;
    }

    getPath(): THREE.Vector3[] {
        return this.path.map(p => p.clone());
    }

    getCurrentWaypointIndex(): number {
        return this.currentWaypointIndex;
    }

    getCurrentWaypoint(): THREE.Vector3 | null {
        if (this.path.length === 0 || this.currentWaypointIndex >= this.path.length) {
            return null;
        }
        return this.path[this.currentWaypointIndex]?.clone() ?? null;
    }

    /**
     * Advance to the next waypoint without moving the physics body. Used by the
     * dead-reckoned VIRTUAL path following (NpcLodComponent.advanceAlongPath).
     */
    advanceWaypoint(): void {
        this.currentWaypointIndex++;
    }

    hasPath(): boolean {
        return this.path.length > 0 && this.currentWaypointIndex < this.path.length;
    }

    getStuckFrameCount(): number {
        return this.stuckFrameCount;
    }

    // ════════════════════════════════════════════════════════════════════════
    // Speed Configuration
    // ════════════════════════════════════════════════════════════════════════

    setMoveSpeed(speed: number): void {
        this.moveSpeed = Math.max(0.1, speed);
    }

    getMoveSpeed(): number {
        return this.moveSpeed;
    }

    getCurrentSpeed(): number {
        return this.currentSpeed;
    }

    // ════════════════════════════════════════════════════════════════════════
    // Arrival Configuration
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Set how close the agent must get to its FINAL destination waypoint before
     * it considers itself arrived and stops. Smaller = walks closer to the exact
     * point. Intermediate waypoints are unaffected (they keep using the coarse
     * `minDistanceToWaypoint` so cornering stays smooth).
     *
     * Clamped to a small positive floor to avoid the agent never registering
     * arrival (which would leave it micro-stepping on top of the target). When
     * the radius is tighter than the default waypoint tolerance, a final-approach
     * deceleration band kicks in so the agent eases onto the point instead of
     * overshooting and jittering.
     */
    setArrivalRadius(radius: number): void {
        this.arrivalRadius = Math.max(0.05, radius);
    }

    getArrivalRadius(): number {
        return this.arrivalRadius;
    }

    /**
     * Enable/disable agent-to-agent avoidance for this agent. Disabling keeps
     * normal path-following (so locomotion animation, facing and arrival all
     * still work) but the agent no longer steers around other agents.
     */
    setAvoidanceEnabled(enabled: boolean): void {
        this.avoidanceEnabled = enabled;
    }

    isAvoidanceEnabled(): boolean {
        return this.avoidanceEnabled;
    }

    /**
     * Enable/disable straight-line movement. When enabled, setTargetPosition
     * heads directly to the target without running the navmesh A* (the path
     * becomes a single waypoint at the exact target). Use on open ground where
     * pathfinding is unnecessary; the caller is responsible for obstacle
     * avoidance. Takes effect on the next setTargetPosition call.
     */
    setStraightLinePath(enabled: boolean): void {
        this.straightLinePath = enabled;
    }

    isStraightLinePath(): boolean {
        return this.straightLinePath;
    }

    // ════════════════════════════════════════════════════════════════════════
    // Step-Hop Configuration
    // ════════════════════════════════════════════════════════════════════════

    setMaxStepUpHeight(height: number): void {
        this._maxStepUpHeight = Math.max(0, height);
    }

    getMaxStepUpHeight(): number {
        return this._maxStepUpHeight;
    }

    setStepHopEnabled(enabled: boolean): void {
        this._stepHopEnabled = enabled;
    }

    isStepHopEnabled(): boolean {
        return this._stepHopEnabled;
    }

    // ════════════════════════════════════════════════════════════════════════
    // Rotation Configuration
    // ════════════════════════════════════════════════════════════════════════

    setRotationSpeed(radiansPerSecond: number): void {
        this.rotationSpeed = Math.max(0.1, radiansPerSecond);
    }

    getRotationSpeed(): number {
        return this.rotationSpeed;
    }

    /**
     * When true, the movement system owns the body facing (e.g. NpcSkiMovement
     * turns the rider sideways into a snowboard stance). Navigation then steers
     * straight toward the waypoint instead of "moving where the body faces", and
     * stops auto-rotating the character toward travel. Default false (walk
     * behaviour unchanged). Set by NpcController.setMovementSystem.
     */
    setOrchestratedFacing(enabled: boolean): void {
        this.orchestratedFacing = enabled;
    }

    // ════════════════════════════════════════════════════════════════════════
    // Update (called from controller's update)
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Process the idle state. Returns true if currently idling (caller should skip movement).
     */
    updateIdle(deltaTime: number): boolean {
        if (!this.isIdling) return false;
        this.idleTimer += deltaTime;
        if (this.idleTimer >= this.idleDuration) {
            this.isIdling = false;
            this.idleTimer = 0;
        }
        return this.isIdling;
    }

    /**
     * Check stuck state. Returns true if stuck was handled (caller should return early).
     */
    updateStuck(): boolean {
        if (this.previousIntendedMovement > 0) {
            const currentPos = this.callbacks.getCharacter().position;
            const isStuck = Math.abs(currentPos.x - this.previousPosition.x) < this.movementEpsilon &&
                           Math.abs(currentPos.y - this.previousPosition.y) < this.movementEpsilon &&
                           Math.abs(currentPos.z - this.previousPosition.z) < this.movementEpsilon;

            if (isStuck) {
                this.stuckFrameCount++;
                if (this.stuckFrameCount >= this.stuckFrameThreshold) {
                    this.handleStuck();
                    this.stuckFrameCount = 0;
                    this.previousPosition.copy(currentPos);
                    this.previousIntendedMovement = 0;
                    return true;
                }
            } else {
                this.stuckFrameCount = 0;
            }
        } else {
            this.stuckFrameCount = 0;
        }

        this.previousPosition.copy(this.callbacks.getCharacter().position);
        this.previousIntendedMovement = 0;
        return false;
    }

    /**
     * Move along the current path toward target. Call after behavior update.
     */
    moveTowardTarget(deltaTime: number): void {
        if (this.path.length === 0 || this.currentWaypointIndex >= this.path.length) {
            this.stopMovement();
            return;
        }

        const currentWaypoint = this.path[this.currentWaypointIndex];
        if (!currentWaypoint) {
            this.stopMovement();
            return;
        }

        const character = this.callbacks.getCharacter();
        const currentPos = character.position.clone();

        // Update step-hop cooldown
        if (this._stepHopCooldown > 0) {
            this._stepHopCooldown -= deltaTime;
        }

        const distance2D = Math.hypot(
            currentWaypoint.x - currentPos.x,
            currentWaypoint.z - currentPos.z,
        );

        // The final waypoint (the actual destination) uses the configurable
        // arrival radius; intermediate waypoints stay on the coarse tolerance so
        // path cornering is unaffected.
        const isFinalWaypoint = this.currentWaypointIndex === this.path.length - 1;
        const arrivalThreshold = isFinalWaypoint
            ? this.arrivalRadius
            : this.minDistanceToWaypoint;

        if (distance2D < arrivalThreshold) {
            this.currentWaypointIndex++;
            if (this.currentWaypointIndex >= this.path.length) {
                // Reached the end of the path. If that end is still more than the
                // arrival radius from the actual requested target, the target was
                // snapped to an obstacle's edge (it sat inside the obstacle) and
                // is unreachable — flag it so the controller abandons it instead
                // of parking here.
                const finalWp = this.path[this.path.length - 1];
                if (this.currentTarget && finalWp) {
                    const ddx = this.currentTarget.x - finalWp.x;
                    const ddz = this.currentTarget.z - finalWp.z;
                    if (ddx * ddx + ddz * ddz > this.arrivalRadius * this.arrivalRadius) {
                        this.stoppedShortOfTarget_ = true;
                    }
                }
                this.stopMovement();
                return;
            }
        }

        // Get the updated waypoint after potential index change
        const targetWaypoint = this.path[this.currentWaypointIndex];
        if (!targetWaypoint) {
            this.stopMovement();
            return;
        }

        // Calculate target rotation toward waypoint
        const toWaypointX = targetWaypoint.x - currentPos.x;
        const toWaypointZ = targetWaypoint.z - currentPos.z;
        const toWaypointDist = Math.sqrt(toWaypointX * toWaypointX + toWaypointZ * toWaypointZ);

        // Apply agent-to-agent avoidance: bias the desired direction so the
        // agent steers around nearby NPCs, animals, players, and vehicles
        // before the next waypoint is reached. Speed is scaled down when
        // this agent is the yielding party in an imminent collision.
        let desiredX = toWaypointX;
        let desiredZ = toWaypointZ;
        let avoidanceSpeedScale = 1.0;
        if (toWaypointDist > 0.001) {
            const avoidance = getGlobalAgentAvoidance();
            const body = this.callbacks.getPhysicsBody();
            if (avoidance && body && this.avoidanceEnabled) {
                const desired = new THREE.Vector3(toWaypointX / toWaypointDist, 0, toWaypointZ / toWaypointDist);
                const result = avoidance.steer(this.callbacks.getPhysicsWorld(), {
                    bodyHandle: body.handle,
                    position: currentPos,
                    desiredDirection: desired,
                    targetSpeed: this.moveSpeed,
                    radius: this.callbacks.getAgentRadius(),
                    priority: this.callbacks.getAgentPriority(),
                }, getGlobalNavMesh());
                desiredX = result.steeredDirection.x;
                desiredZ = result.steeredDirection.z;
                avoidanceSpeedScale = result.speedScale;
            }
        }

        let targetRotation = character.rotation.y;
        const desiredLen = Math.sqrt(desiredX * desiredX + desiredZ * desiredZ);
        if (desiredLen > 0.001) {
            targetRotation = Math.atan2(desiredX, desiredZ);
        }

        // Build the move direction. Two modes:
        let moveDirection: THREE.Vector3;
        if (this.orchestratedFacing) {
            // Orchestrated movement systems (e.g. NpcSkiMovement) own the body
            // facing and DECOUPLE it from travel: steer straight toward the
            // waypoint, and let the movement system rotate the body itself (e.g.
            // into a sideways snowboard stance). Crucially, we must NOT rotate the
            // character toward travel here, and must NOT scale movement by the
            // facing·waypoint dot — with the body turned ~90° sideways that dot is
            // ~0, which would pin the agent in place.
            const inv = desiredLen > 0.001 ? avoidanceSpeedScale / desiredLen : 0;
            moveDirection = new THREE.Vector3(desiredX * inv, 0, desiredZ * inv);
        } else {
            // Default: rotate toward the waypoint and move where we FACE (gives
            // smooth curved paths). Movement scales by how aligned facing is with
            // the steered direction so the agent doesn't drift while pivoting.
            this.smoothRotateTowards(targetRotation, deltaTime);
            const currentFacing = character.rotation.y;
            const facingDirX = Math.sin(currentFacing);
            const facingDirZ = Math.cos(currentFacing);
            let movementScale = 1.0;
            if (desiredLen > 0.001) {
                const desNormX = desiredX / desiredLen;
                const desNormZ = desiredZ / desiredLen;
                const dot = facingDirX * desNormX + facingDirZ * desNormZ;
                movementScale = Math.max(0, dot);
            }
            movementScale *= avoidanceSpeedScale;
            moveDirection = new THREE.Vector3(
                facingDirX * movementScale,
                0,
                facingDirZ * movementScale
            );
        }

        // Speed ramping (animal-specific smooth acceleration)
        if (this.speedRampingConfig.enabled) {
            const actualTarget = this.currentTarget || this.lastKnownTargetPosition;
            if (actualTarget) {
                const distToTarget = Math.hypot(
                    actualTarget.x - currentPos.x,
                    actualTarget.z - currentPos.z,
                );
                const slowdownDistance = 3.0;
                const minSpeedFactor = 0.15;
                if (distToTarget < slowdownDistance) {
                    const targetSpeedFactor = minSpeedFactor + (1.0 - minSpeedFactor) * (distToTarget / slowdownDistance);
                    this.targetSpeed = this.moveSpeed * targetSpeedFactor;
                } else {
                    this.targetSpeed = this.moveSpeed;
                }
            } else {
                this.targetSpeed = this.moveSpeed;
            }
            this.updateSpeed(deltaTime);
            moveDirection.multiplyScalar(this.currentSpeed / this.moveSpeed);
        } else if (isFinalWaypoint && this.arrivalRadius < this.minDistanceToWaypoint) {
            // Final-approach deceleration for humanoid agents that opted into a
            // tight arrival radius. Without this, a velocity-based agent at full
            // speed overshoots a sub-0.5 m target and oscillates around it (the
            // "wobble"). Ramp speed down linearly from full at the coarse
            // tolerance to a small floor at the arrival radius so it eases on.
            // Gated on `arrivalRadius < minDistanceToWaypoint`, so default-radius
            // agents (and all existing games) are completely unaffected.
            const slowdownStart = this.minDistanceToWaypoint;
            if (toWaypointDist < slowdownStart) {
                const span = Math.max(0.001, slowdownStart - this.arrivalRadius);
                const t = Math.max(0, (toWaypointDist - this.arrivalRadius) / span);
                const minFactor = 0.2;
                const factor = minFactor + (1.0 - minFactor) * Math.min(1, t);
                moveDirection.multiplyScalar(factor);
            }
        }

        // Determine if character should hop up a step
        const shouldHop = this._stepHopEnabled &&
            this._maxStepUpHeight > 0 &&
            this.callbacks.isGrounded() &&
            this._stepHopCooldown <= 0 &&
            this.stuckFrameCount >= this.STUCK_FRAMES_BEFORE_HOP &&
            this.shouldAttemptStepHop(currentPos, targetWaypoint);

        if (shouldHop) {
            this._stepHopCooldown = this.STEP_HOP_COOLDOWN_DURATION;
            this.stuckFrameCount = 0;
        }

        this.callbacks.runMovementSystem(deltaTime, moveDirection, shouldHop);

        const body = this.callbacks.getPhysicsBody();
        if (body) {
            body.wakeUp();
        }
        this.previousIntendedMovement = this.moveSpeed * deltaTime;
    }

    /** Smoothly rotate toward target angle with proper angle wrapping */
    smoothRotateTowards(targetRotation: number, deltaTime: number): void {
        const character = this.callbacks.getCharacter();
        let angleDiff = targetRotation - character.rotation.y;

        // Normalize to [-pi, pi] for shortest path
        while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
        while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;

        // Clamp rotation to max speed and apply
        const maxRot = this.rotationSpeed * deltaTime;
        character.rotation.y += Math.max(-maxRot, Math.min(maxRot, angleDiff));

        // Keep in [-pi, pi] range
        if (character.rotation.y > Math.PI) character.rotation.y -= Math.PI * 2;
        if (character.rotation.y < -Math.PI) character.rotation.y += Math.PI * 2;
    }

    stopMovement(): void {
        this.targetSpeed = 0;
        const body = this.callbacks.getPhysicsBody();
        if (body) {
            const velocity = body.linvel();
            body.setLinvel({ x: 0, y: velocity.y, z: 0 }, true);
        }
    }

    /** Initialize previous position (call once after physics body is created) */
    initializePreviousPosition(position: THREE.Vector3): void {
        this.previousPosition.copy(position);
        // The physics body is guaranteed to exist by this point, so this is
        // the earliest safe moment to register with the path-conflict
        // system. Doing it here instead of lazily on first setTargetPosition
        // means stationary NPCs (sitting in a tavern, idle in a market)
        // are also visible as virtual-obstacle candidates to peers planning
        // around them — otherwise a walker would route straight through
        // an unregistered idle NPC.
        this.ensureRegisteredWithPathConflict();
    }

    // ════════════════════════════════════════════════════════════════════════
    // Private Helpers
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Snap a target onto the nearest walkable cell when it lands on a blocked
     * one, so paths route around static obstacles and end at their edge.
     * Returns the original target if it's already valid or no snap point exists.
     */
    private snapToValidTarget(
        nav: NonNullable<ReturnType<typeof getGlobalNavMesh>>,
        target: THREE.Vector3,
    ): THREE.Vector3 {
        if (nav.isValidNavigationTarget(target)) return target;
        return nav.findNearestValidTarget(target) ?? target;
    }

    private handleStuck(): void {
        this.path = [];
        this.currentWaypointIndex = 0;
        this.currentTarget = null;
        this.stopMovement();
        this.isIdling = true;
        this.idleTimer = 0;
    }

    private shouldAttemptStepHop(currentPos: THREE.Vector3, waypoint: THREE.Vector3): boolean {
        const dist = Math.hypot(waypoint.x - currentPos.x, waypoint.z - currentPos.z);
        if (dist < 0.1) return false;

        const checkX = currentPos.x + (waypoint.x - currentPos.x) / dist * 0.8;
        const checkZ = currentPos.z + (waypoint.z - currentPos.z) / dist * 0.8;
        const groundAhead = this.callbacks.getEngine().getWorldHeightAt?.(checkX, checkZ);

        if (groundAhead == null) return false;
        const heightDiff = groundAhead - currentPos.y;
        return heightDiff > 0.1 && heightDiff <= this._maxStepUpHeight;
    }

    /**
     * Smoothly update current speed toward target speed (for animal speed ramping).
     */
    private updateSpeed(deltaTime: number): void {
        const animalSize = this.speedRampingConfig.getCharacterDepth?.() ?? 0.5;
        const baseAcceleration = 8.0;
        const accelerationRate = baseAcceleration / Math.max(0.3, animalSize);

        const speedDiff = this.targetSpeed - this.currentSpeed;
        const maxSpeedChange = accelerationRate * deltaTime;
        const speedChange = Math.sign(speedDiff) * Math.min(Math.abs(speedDiff), maxSpeedChange);
        this.currentSpeed = Math.max(0, this.currentSpeed + speedChange);
    }

    /**
     * Handle movement when there's no active path but there may be a target.
     * Used by AnimalController for smooth approach behavior.
     */
    updateNoPathApproach(deltaTime: number, animalRadius: number): void {
        const actualTarget = this.currentTarget || this.lastKnownTargetPosition;

        if (!actualTarget) {
            this.targetSpeed = 0;
            this.updateSpeed(deltaTime);
            this.callbacks.runMovementSystem(deltaTime, new THREE.Vector3(0, 0, 0), false);
            return;
        }

        const currentPos = this.callbacks.getCharacter().position;
        const dx = actualTarget.x - currentPos.x;
        const dz = actualTarget.z - currentPos.z;
        const distToTarget = Math.sqrt(dx * dx + dz * dz);

        const stopDistance = animalRadius + 0.5;
        const slowdownDistance = stopDistance * 3;
        const minSpeedFactor = 0.15;

        if (distToTarget < stopDistance) {
            this.targetSpeed = 0;
        } else if (distToTarget < slowdownDistance) {
            const factor = minSpeedFactor + (1.0 - minSpeedFactor) * (distToTarget / slowdownDistance);
            this.targetSpeed = this.moveSpeed * factor;
        } else {
            this.targetSpeed = this.moveSpeed;
        }

        this.updateSpeed(deltaTime);

        if (distToTarget < stopDistance) {
            this.callbacks.runMovementSystem(deltaTime, new THREE.Vector3(0, 0, 0), false);
            return;
        }

        // Steer the approach direction around nearby agents before applying
        // movement. Without this, two animals converging on the same target
        // walk straight into each other.
        let dirX = dx / distToTarget;
        let dirZ = dz / distToTarget;

        // Never beeline THROUGH a navmesh obstacle. If the next step would land
        // on a blocked cell, stop and flag the approach as blocked — the owning
        // controller drops this (unreachable) target so the behaviour picks a
        // new, reachable one, instead of walking the animal onto an obstacle.
        const navForApproach = getGlobalNavMesh();
        if (navForApproach && navForApproach.isReady()) {
            const lookahead = this.callbacks.getAgentRadius() + Math.max(0.1, this.currentSpeed * deltaTime);
            if (!navForApproach.isWalkableAt(currentPos.x + dirX * lookahead, currentPos.z + dirZ * lookahead)) {
                this.noPathApproachBlocked = true;
                this.targetSpeed = 0;
                this.updateSpeed(deltaTime);
                this.callbacks.runMovementSystem(deltaTime, new THREE.Vector3(0, 0, 0), false);
                return;
            }
        }
        this.noPathApproachBlocked = false;

        let speedFactor = this.currentSpeed / this.moveSpeed;
        const avoidance = getGlobalAgentAvoidance();
        const body = this.callbacks.getPhysicsBody();
        if (avoidance && body) {
            const result = avoidance.steer(this.callbacks.getPhysicsWorld(), {
                bodyHandle: body.handle,
                position: currentPos,
                desiredDirection: new THREE.Vector3(dirX, 0, dirZ),
                targetSpeed: this.moveSpeed,
                radius: this.callbacks.getAgentRadius(),
                priority: this.callbacks.getAgentPriority(),
            }, getGlobalNavMesh());
            dirX = result.steeredDirection.x;
            dirZ = result.steeredDirection.z;
            speedFactor *= result.speedScale;
        }

        const moveDirection = new THREE.Vector3(dirX, 0, dirZ).multiplyScalar(speedFactor);

        this.callbacks.runMovementSystem(deltaTime, moveDirection, false);
        this.previousIntendedMovement = this.moveSpeed * deltaTime;
        this.smoothRotateTowards(Math.atan2(dirX, dirZ), deltaTime);
    }

    /** True if the last no-path approach was stopped by a navmesh obstacle. */
    isNoPathApproachBlocked(): boolean {
        return this.noPathApproachBlocked;
    }

    /** True when the agent finished its path but ended well short of the actual
     *  target (target was inside an obstacle → snapped to its edge). The owning
     *  controller drops the target so the behaviour picks a new, reachable one. */
    hasStoppedShortOfTarget(): boolean {
        return this.stoppedShortOfTarget_;
    }

    /** Clear path and target (e.g., when rider mounts). Also drops any
     *  in-flight queued path request so a stale result can't land later. */
    clearPath(): void {
        this.pathTracker.cancelAll();
        getGlobalPathQueue().cancel(this.navKey);
        this.path = [];
        this.currentTarget = null;
    }
}
