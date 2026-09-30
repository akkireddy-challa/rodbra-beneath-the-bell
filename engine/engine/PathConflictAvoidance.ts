import * as THREE from 'three';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';

/**
 * Engine-wide system that prevents NPC-vs-NPC path conflicts by injecting
 * other agents into the path planner as virtual obstacles when their bodies
 * sit on someone else's chosen route.
 *
 * The complement to `AgentAvoidanceSystem` (reactive, per-frame steering):
 * this one looks **ahead** along an agent's planned path, asks "are any of my
 * peers standing in the next few meters of my path?", and if so re-plans
 * around them. Reactive avoidance still kicks in for last-moment dodges, but
 * the path-conflict step prevents two NPCs from picking head-on routes in
 * the first place.
 *
 * ## Design
 *
 * Mutating the global navmesh with one circle per active agent has a fatal
 * flaw: the agent then blocks **its own** path. Instead, we pipe a
 * per-query `extras` list through `VoxelNavMesh.findPath()` — every plan
 * sees all currently flagged peers as virtual obstacles **except the
 * planning agent itself**. No global mutation, no self-blocking.
 *
 * ## Scheduling
 *
 * Scanning a path is cheap individually but expensive in aggregate (every
 * agent × every sample × physics radius query per tick). So we round-robin:
 * **one agent per tick**, in registration order. With 30 NPCs at 60 fps,
 * each agent gets re-scanned ~twice per second — plenty fast for human-walk
 * gameplay where directions change on multi-second cadences.
 *
 * ## TTL
 *
 * A flagged obstacle stays in the set for `obstacleTtlSeconds`. The flag is
 * refreshed every time another scan re-spots the same peer, so a slow
 * conversation-pair-NPC keeps blocking its peers as long as anyone is
 * routing past it. Once nobody is heading toward it for `obstacleTtlSeconds`,
 * it falls out of the obstacle set and is no longer planned around.
 *
 * ## Self-exclusion
 *
 * `collectExtrasForAgent(selfHandle)` always strips the planner's own
 * handle from the extras list, both for path-conflict-driven replans and
 * for the initial `NavigationComponent.setTargetPosition()` plan (which
 * pulls extras via `getActiveExtrasForAgent`).
 */

export interface PathConflictAvoidanceOptions {
    /** Window of motion (s) along the path to scan ahead. */
    scanLookaheadSeconds: number;
    /** Hard cap on scan distance (m), independent of speed. */
    maxScanDistance: number;
    /** Minimum scan distance (m), even for stationary or slow agents. */
    minScanDistance: number;
    /** Sample-spacing (m) when walking the path. Smaller = more accurate, more work. */
    sampleSpacing: number;
    /** TTL (s) for a flagged temp obstacle. Refreshed each time we re-flag. */
    obstacleTtlSeconds: number;
    /** Distance padding (m) added on top of combined radii to flag a conflict. */
    safetyPadding: number;
    /** Max agents to scan per tick. Distributes work across frames. */
    agentsScannedPerTick: number;
    /**
     * A flagged peer is considered "stable" until it drifts more than this
     * many metres from where it was when first flagged. While stable, scans
     * that re-detect the same peer just refresh its TTL — no replan. This is
     * the throttle that stops A* from running on every scan; without it the
     * cost of replanning at fine cell sizes (0.125 m → 3.2 M-iteration cap)
     * stacks up across frames and produces multi-second stalls.
     */
    replanMovementThreshold: number;
}

export const DEFAULT_PATH_CONFLICT_OPTIONS: PathConflictAvoidanceOptions = {
    scanLookaheadSeconds: 2.0,
    maxScanDistance: 8.0,
    minScanDistance: 1.0,
    sampleSpacing: 0.3,
    obstacleTtlSeconds: 2.0,
    safetyPadding: 0.1,
    agentsScannedPerTick: 1,
    // 1.0 m of peer drift before re-flagging — at 2 m/s walk speed this
    // throttles re-plans for an ongoing close encounter to ~0.5 s
    // intervals. The animation system preserves the walk-cycle phase
    // across replan-driven transitions (see MixamoAnimationPlayer's
    // `preservedLoopTime`), so this can stay relatively responsive
    // without producing visible "walk reset" twitches.
    replanMovementThreshold: 1.0,
};

/**
 * Self-describing interface an NPC/animal/vehicle registers with the
 * system. The agent exposes its live state (position, path, speed) and a
 * callback the system uses to ask for a fresh plan that avoids the supplied
 * virtual obstacles.
 */
export interface PathScannerAgent {
    /** Stable physics body handle. Used as the registry key and to skip self in radius queries. */
    bodyHandle: number;
    /** Live position object (read every scan). Y is ignored. */
    position: THREE.Vector3;
    /** Capsule radius (m). */
    radius: number;
    /** Return current path waypoints (world-space). Empty array = idle. */
    getPath(): ReadonlyArray<THREE.Vector3>;
    /** Index into getPath() the agent is heading toward right now. */
    getCurrentWaypointIndex(): number;
    /** Top speed used to scope the scan window. */
    getMoveSpeed(): number;
    /**
     * Recompute path with the supplied list inserted as virtual blocked
     * circles. The agent should call `findPath(start, end, extras)` and
     * replace its current path with the result.
     */
    replanWithExtras(extras: ReadonlyArray<{ x: number; z: number; radius: number }>): void;
}

interface TempObstacle {
    handle: number;
    agent: PathScannerAgent;
    /** Engine-clock timestamp (s) at which this flag falls off. */
    expiresAt: number;
    /** Blocker's XZ position the last time we (re-)flagged. Drives the movement-threshold throttle. */
    lastFlaggedX: number;
    lastFlaggedZ: number;
}

/** Debug-visualization snapshot of one active temp obstacle. */
export interface VirtualObstacleDebugInfo {
    handle: number;
    x: number;
    y: number;
    z: number;
    radius: number;
    remainingFraction: number;
}

const EMPTY_PATH: ReadonlyArray<THREE.Vector3> = [];

export class PathConflictAvoidanceSystem {
    private options: PathConflictAvoidanceOptions;
    private agents: Map<number, PathScannerAgent> = new Map();
    /** Iteration order for round-robin scans. Mirrors `agents`. */
    private agentOrder: number[] = [];
    private nextScanIdx = 0;
    private tempObstacles: Map<number, TempObstacle> = new Map();
    /** Monotonic clock (s) used for obstacle TTL. Driven from `tick(deltaTime)`. */
    private clock = 0;

    constructor(options: PathConflictAvoidanceOptions = DEFAULT_PATH_CONFLICT_OPTIONS) {
        this.options = options;
    }

    setOptions(options: PathConflictAvoidanceOptions): void {
        this.options = options;
    }

    getOptions(): PathConflictAvoidanceOptions {
        return this.options;
    }

    /** Register an agent for path-conflict scanning. Idempotent on `bodyHandle`. */
    register(agent: PathScannerAgent): void {
        if (this.agents.has(agent.bodyHandle)) return;
        this.agents.set(agent.bodyHandle, agent);
        this.agentOrder.push(agent.bodyHandle);
    }

    /** Unregister and drop any temp-obstacle flag this agent had. */
    unregister(bodyHandle: number): void {
        if (!this.agents.delete(bodyHandle)) return;
        const idx = this.agentOrder.indexOf(bodyHandle);
        if (idx >= 0) {
            this.agentOrder.splice(idx, 1);
            // Keep nextScanIdx in bounds — splicing before our cursor would
            // skip an agent this tick, after our cursor is fine. (idx >= 0
            // and idx < nextScanIdx together imply nextScanIdx > 0.)
            if (idx < this.nextScanIdx) this.nextScanIdx--;
        }
        this.tempObstacles.delete(bodyHandle);
    }

    /**
     * Register an "obstacle-only" agent — something other peers should
     * route around but that doesn't path through the navmesh itself
     * (currently: the local player; future candidates: parked vehicles,
     * dropped weapons, story props).
     *
     * Internally builds a `PathScannerAgent` whose `getPath()` returns an
     * empty array, which makes `scanAgent()` early-return for this entry
     * — so it's never scanned, but it IS visible to other agents' scans
     * via `physicsWorld.queryEntitiesInRadius` → `agents.get(handle)`,
     * and will be flagged as a virtual obstacle when their path crosses
     * its position.
     *
     * `livePosition` should be the live `THREE.Vector3` reference whose
     * components mutate each frame (e.g. `player.position`). `getRadius`
     * is a getter so callers whose radius can change after registration
     * (e.g. `PlayerController.setCapsuleDimensions`) don't need to
     * re-register.
     */
    registerStaticBlocker(bodyHandle: number, livePosition: THREE.Vector3, getRadius: () => number): void {
        if (this.agents.has(bodyHandle)) return;
        const blocker: PathScannerAgent = {
            bodyHandle,
            position: livePosition,
            get radius() { return getRadius(); },
            getPath: () => EMPTY_PATH,
            getCurrentWaypointIndex: () => 0,
            getMoveSpeed: () => 0,
            replanWithExtras: () => { /* never called: getPath() is empty so scanAgent returns early */ },
        };
        this.register(blocker);
    }

    /**
     * Drive the system. Call once per engine tick **before** NPC updates so
     * any replans take effect this frame.
     */
    tick(deltaTime: number, physicsWorld: PhysicsWorld): void {
        this.clock += deltaTime;

        // Evict expired temp obstacles.
        for (const [handle, obs] of this.tempObstacles) {
            if (obs.expiresAt <= this.clock) {
                this.tempObstacles.delete(handle);
            }
        }

        const order = this.agentOrder;
        if (order.length === 0) return;
        const scanCount = Math.min(order.length, Math.max(1, this.options.agentsScannedPerTick));
        for (let i = 0; i < scanCount; i++) {
            if (this.nextScanIdx >= order.length) this.nextScanIdx = 0;
            const handle = order[this.nextScanIdx]!;
            this.nextScanIdx++;
            const agent = this.agents.get(handle);
            if (!agent) continue;
            this.scanAgent(agent, physicsWorld);
        }
    }

    /**
     * Snapshot the current temp-obstacle set for a given planning agent.
     * Always excludes the planner's own handle so the agent never blocks
     * itself. Public so NavigationComponent can pull extras for the very
     * first plan after `setTargetPosition`, not just the scan-driven replan.
     */
    getActiveExtrasForAgent(selfHandle: number): { x: number; z: number; radius: number }[] {
        const extras: { x: number; z: number; radius: number }[] = [];
        for (const [handle, obs] of this.tempObstacles) {
            if (handle === selfHandle) continue;
            const pos = obs.agent.position;
            extras.push({ x: pos.x, z: pos.z, radius: obs.agent.radius });
        }
        return extras;
    }

    /**
     * Read the full active temp-obstacle set (no self-exclusion, no
     * agent-radius inflation) for debug visualization. Each entry tracks
     * the live position of the flagged agent and a TTL fraction
     * (`remainingFraction` ∈ [0, 1]) that callers can use to fade the
     * marker as it ages.
     */
    getActiveVirtualObstacles(): VirtualObstacleDebugInfo[] {
        const out: VirtualObstacleDebugInfo[] = [];
        const ttl = Math.max(1e-6, this.options.obstacleTtlSeconds);
        for (const [handle, obs] of this.tempObstacles) {
            const pos = obs.agent.position;
            const remaining = Math.max(0, Math.min(1, (obs.expiresAt - this.clock) / ttl));
            out.push({
                handle,
                x: pos.x,
                y: pos.y,
                z: pos.z,
                radius: obs.agent.radius,
                remainingFraction: remaining,
            });
        }
        return out;
    }

    /**
     * Walk the agent's path forward `scanLookaheadSeconds * moveSpeed`
     * meters at `sampleSpacing` intervals and flag any peer body whose
     * centre is within combined-radius of any sample. Re-plans the agent
     * with the resulting full extras set if any conflict was found.
     */
    private scanAgent(agent: PathScannerAgent, physicsWorld: PhysicsWorld): void {
        const path = agent.getPath();
        if (path.length === 0) return;
        const startIdx = agent.getCurrentWaypointIndex();
        if (startIdx >= path.length) return;

        const opts = this.options;
        const speed = Math.max(0.1, agent.getMoveSpeed());
        const scanDist = Math.min(
            opts.maxScanDistance,
            Math.max(opts.minScanDistance, speed * opts.scanLookaheadSeconds),
        );
        const step = Math.max(0.05, opts.sampleSpacing);

        const foundConflicts = new Set<number>();
        // Upper-bound the per-sample radius query: combined radii of
        // self + a generous "other" max + safety. Anything beyond this
        // can't physically conflict with this sample.
        const sampleQueryRadius = agent.radius + 1.0 + opts.safetyPadding;

        const sampleY = agent.position.y;
        const checkSample = (x: number, z: number): void => {
            const neighbors = physicsWorld.queryEntitiesInRadius(
                { x, y: sampleY, z },
                sampleQueryRadius,
            );
            for (const n of neighbors) {
                if (n.handle === agent.bodyHandle) continue;
                const otherAgent = this.agents.get(n.handle);
                if (!otherAgent) continue; // not a scanner-registered peer
                const dx = n.position.x - x;
                const dz = n.position.z - z;
                const combined = agent.radius + otherAgent.radius + opts.safetyPadding;
                if (dx * dx + dz * dz <= combined * combined) {
                    foundConflicts.add(n.handle);
                }
            }
        };

        // Sample at the agent's current position too — a peer standing
        // right in front of us still needs to be flagged before we start
        // moving.
        let traveled = 0;
        let cursorX = agent.position.x;
        let cursorZ = agent.position.z;
        checkSample(cursorX, cursorZ);
        outer: for (let wp = startIdx; wp < path.length; wp++) {
            const wpVec = path[wp]!;
            const segDx = wpVec.x - cursorX;
            const segDz = wpVec.z - cursorZ;
            const segLen = Math.sqrt(segDx * segDx + segDz * segDz);
            if (segLen < 1e-6) {
                cursorX = wpVec.x;
                cursorZ = wpVec.z;
                continue;
            }
            const dirX = segDx / segLen;
            const dirZ = segDz / segLen;
            let walked = 0;
            while (walked < segLen) {
                const advance = Math.min(step, segLen - walked);
                walked += advance;
                traveled += advance;
                cursorX += dirX * advance;
                cursorZ += dirZ * advance;
                checkSample(cursorX, cursorZ);
                if (traveled >= scanDist) break outer;
            }
        }

        if (foundConflicts.size === 0) return;

        // Refresh / install temp obstacles for every conflict found.
        // We only ask the agent to replan when the conflict set has
        // **meaningfully changed** for it — either a NEW peer was flagged,
        // or an existing peer drifted more than `replanMovementThreshold`
        // metres from where it was when we last flagged it. Without this
        // throttle the scanner triggers A* on every tick that finds a
        // conflict, which at 0.125 m cell-size spirals into multi-second
        // stalls as multiple agents replan in rapid succession.
        const newExpire = this.clock + opts.obstacleTtlSeconds;
        const moveThreshSq = opts.replanMovementThreshold * opts.replanMovementThreshold;
        let needsReplan = false;
        for (const handle of foundConflicts) {
            const other = this.agents.get(handle);
            if (!other) continue;
            const existing = this.tempObstacles.get(handle);
            if (!existing) {
                this.tempObstacles.set(handle, {
                    handle,
                    agent: other,
                    expiresAt: newExpire,
                    lastFlaggedX: other.position.x,
                    lastFlaggedZ: other.position.z,
                });
                needsReplan = true;
                continue;
            }
            // Refresh TTL unconditionally — the peer is still in the way.
            existing.expiresAt = newExpire;
            // But only replan if the peer's position drifted past the
            // threshold since its last flag. Below the threshold the
            // already-planned route around it is still valid.
            const dx = other.position.x - existing.lastFlaggedX;
            const dz = other.position.z - existing.lastFlaggedZ;
            if (dx * dx + dz * dz > moveThreshSq) {
                existing.lastFlaggedX = other.position.x;
                existing.lastFlaggedZ = other.position.z;
                needsReplan = true;
            }
        }

        if (!needsReplan) return;

        // Re-plan with the full current extras set. The planner sees every
        // active temp obstacle as a virtual blocked circle and routes
        // around them.
        const extras = this.getActiveExtrasForAgent(agent.bodyHandle);
        agent.replanWithExtras(extras);
    }
}

let _globalSystem: PathConflictAvoidanceSystem | null = null;

/** @internal Called once by GameEngine during initialization. */
export function setGlobalPathConflictAvoidance(system: PathConflictAvoidanceSystem | null): void {
    _globalSystem = system;
}

export function getGlobalPathConflictAvoidance(): PathConflictAvoidanceSystem | null {
    return _globalSystem;
}
