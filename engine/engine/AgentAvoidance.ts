import * as THREE from 'three';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import type { VoxelNavMesh } from 'engine/VoxelNavMesh.js';

/**
 * Engine-wide agent-to-agent steering. NavigationComponent calls
 * `AgentAvoidanceSystem.steer()` once per frame to bias each path-follower's
 * desired direction away from imminent collisions with other dynamic agents
 * (NPCs, animals, players, vehicles).
 *
 * The system combines two forces:
 *  - **Predictive** — projects each neighbor's velocity forward by
 *    `timeHorizon` seconds, detects predicted closest-approach below
 *    combined radii, and applies a perpendicular steering vector to slide
 *    around the conflict. Catches the "two agents converging at an angle"
 *    case that pure raycasts miss until they already overlap.
 *  - **Reactive** — if the neighbor is already inside the combined radius,
 *    pushes radially outward. Resolves cases where two agents start a frame
 *    overlapping (spawn collisions, post-physics jitter).
 *
 * Yielding is asymmetric: a deterministic priority order (VEHICLE > PLAYER >
 * NPC > ANIMAL) decides who steers harder. When peers share a tier, the
 * agent with the lower rigid-body handle holds course and the higher-handle
 * one yields — so two equally ranked agents never mirror-dance into each
 * other.
 */
export enum AgentPriority {
    ANIMAL = 0,
    NPC = 1,
    PLAYER = 2,
    VEHICLE = 3,
}

export interface AgentAvoidanceOptions {
    /** Radius (m) of the broad-phase query for nearby agents. */
    queryRadius: number;
    /** Look-ahead window (s) for predictive collision detection. */
    timeHorizon: number;
    /** Extra padding added to combined radii, keeping agents at arm's length. */
    safetyPadding: number;
    /** Max angular deflection from the desired direction (radians). Stops one strong push from spinning the agent around. */
    maxDeflection: number;
    /** Deflection scale when the agent is the yielding party. */
    yieldDeflectionMultiplier: number;
    /** Deflection scale when the agent holds course (other side yields). */
    holdDeflectionMultiplier: number;
    /** Minimum speed multiplier when an imminent collision is predicted and the agent is yielding. */
    yieldSpeedMultiplier: number;
    /** Time-to-collision (s) below which a yielding agent starts slowing down. */
    yieldSlowdownWindow: number;
}

export const DEFAULT_AGENT_AVOIDANCE_OPTIONS: AgentAvoidanceOptions = {
    queryRadius: 4.0,
    timeHorizon: 2.0,
    safetyPadding: 0.25,
    maxDeflection: Math.PI / 3,
    yieldDeflectionMultiplier: 1.4,
    holdDeflectionMultiplier: 0.55,
    yieldSpeedMultiplier: 0.55,
    yieldSlowdownWindow: 0.7,
};

/** Input snapshot for a single steering query. */
export interface AgentSteerInput {
    /** This agent's rigid-body handle (used to skip self in the neighbor scan). */
    bodyHandle: number;
    /** Current world-space position. Y is ignored. */
    position: THREE.Vector3;
    /** Unit-length XZ direction the agent wants to move. */
    desiredDirection: THREE.Vector3;
    /** Current target speed in m/s (used to project the agent's velocity forward). */
    targetSpeed: number;
    /** Capsule radius (m). */
    radius: number;
    /** Priority tier for yielding rules. */
    priority: AgentPriority;
}

export interface AgentSteerResult {
    /** Adjusted XZ direction (unit length). Use as the new facing target. */
    steeredDirection: THREE.Vector3;
    /** Speed multiplier in [0, 1]. Apply to the agent's move-direction length. */
    speedScale: number;
}

interface MinimalUserData {
    __type?: string;
    agentRadius?: number;
    /** When true this body opts out of avoidance — other agents ignore it. */
    avoidanceDisabled?: boolean;
}

export class AgentAvoidanceSystem {
    private options: AgentAvoidanceOptions;

    constructor(options: AgentAvoidanceOptions = DEFAULT_AGENT_AVOIDANCE_OPTIONS) {
        this.options = options;
    }

    setOptions(options: AgentAvoidanceOptions): void {
        this.options = options;
    }

    getOptions(): AgentAvoidanceOptions {
        return this.options;
    }

    /**
     * Compute a steered direction and speed scale for one agent. Caller passes
     * its own desired direction and the system folds in avoidance forces from
     * nearby agents. Returns the original direction unchanged when the path is
     * clear.
     *
     * When `navMesh` is supplied, the side-selection step rejects perpendicular
     * directions that lead onto a blocked navmesh cell (table, wall, etc.) —
     * so NPCs sidestepping each other don't accidentally walk onto static
     * obstacles. If both sides are blocked, the perpendicular contribution
     * for that neighbour is dropped and the agent slows to a crawl instead;
     * physics then settles the NPC-vs-NPC contact without anyone climbing a
     * table.
     */
    steer(physicsWorld: PhysicsWorld, agent: AgentSteerInput, navMesh?: VoxelNavMesh | null): AgentSteerResult {
        const opts = this.options;
        const desired = agent.desiredDirection;
        const desiredLenSq = desired.x * desired.x + desired.z * desired.z;
        if (desiredLenSq < 1e-6) {
            return { steeredDirection: desired.clone(), speedScale: 1.0 };
        }
        const desiredLen = Math.sqrt(desiredLenSq);
        const dirX = desired.x / desiredLen;
        const dirZ = desired.z / desiredLen;

        const ax = agent.position.x;
        const az = agent.position.z;

        const neighbors = physicsWorld.queryEntitiesInRadius(
            { x: ax, y: agent.position.y, z: az },
            opts.queryRadius,
        );

        let steerX = 0;
        let steerZ = 0;
        let speedScale = 1.0;

        for (const n of neighbors) {
            if (n.handle === agent.bodyHandle) continue;
            const otherPriority = readNeighborPriority(n.userData);
            if (otherPriority === null) continue;

            const dx = n.position.x - ax;
            const dz = n.position.z - az;
            const distSq = dx * dx + dz * dz;
            if (distSq < 1e-6) continue;
            const dist = Math.sqrt(distSq);

            const otherRadius = readNeighborRadius(n.userData) ?? 0.5;
            const combined = agent.radius + otherRadius + opts.safetyPadding;

            // Decide yielding role. Priority-equal peers use handle as a
            // deterministic tiebreak: lower handle holds, higher yields.
            let yielding: boolean;
            if (agent.priority > otherPriority) yielding = false;
            else if (agent.priority < otherPriority) yielding = true;
            else yielding = agent.bodyHandle > n.handle;
            const roleMul = yielding ? opts.yieldDeflectionMultiplier : opts.holdDeflectionMultiplier;

            // Reactive: already inside the combined radius → push radially out.
            // This handles spawn overlap and physics jitter where predictive
            // steering alone can't separate two pinned agents.
            if (dist < combined) {
                const overlap = 1.0 - dist / combined;
                const invDist = 1.0 / dist;
                steerX += -dx * invDist * overlap * roleMul;
                steerZ += -dz * invDist * overlap * roleMul;
            }

            // Predictive: project both velocities forward, find time of
            // closest approach, apply a perpendicular bias if it dips below
            // the combined radius within the time horizon.
            const vB = physicsWorld.getBodyLinvel(n.handle) ?? { x: 0, y: 0, z: 0 };
            const vAx = dirX * agent.targetSpeed;
            const vAz = dirZ * agent.targetSpeed;
            const rvx = vAx - vB.x;
            const rvz = vAz - vB.z;
            const rvSq = rvx * rvx + rvz * rvz;
            if (rvSq < 1e-6) continue;

            // Separation at time t: dp - relVel*t. tCA minimizes |sep|^2.
            const tCA = (dx * rvx + dz * rvz) / rvSq;
            if (tCA < 0 || tCA > opts.timeHorizon) continue;

            const sepX = dx - rvx * tCA;
            const sepZ = dz - rvz * tCA;
            const missSq = sepX * sepX + sepZ * sepZ;
            const combinedSq = combined * combined;
            if (missSq >= combinedSq) continue;

            const miss = Math.sqrt(missSq);
            const closenessFactor = 1.0 - miss / combined;
            const urgencyFactor = 1.0 - tCA / opts.timeHorizon;
            const weight = closenessFactor * urgencyFactor;
            if (weight <= 0) continue;

            // Side selection. Naive ideal: pick the perpendicular that
            // points away from the neighbour (cross > 0 ⇒ neighbour on the
            // left ⇒ steer right). Near-zero cross is head-on, so we use a
            // handle tiebreak so both agents don't mirror-dance.
            //
            // BUT: the naive side might lead onto a static obstacle (table,
            // wall). The navmesh knows where those are. So when navMesh is
            // available, probe both sides and prefer the one that's
            // walkable. If both sides are blocked, drop this neighbour's
            // perpendicular contribution entirely and crank speedScale
            // toward zero — physics then settles the NPC-NPC contact
            // without anyone climbing onto a chair to escape.
            const leftPerpX = -dirZ, leftPerpZ = dirX;
            const rightPerpX = dirZ, rightPerpZ = -dirX;

            let leftClear = true;
            let rightClear = true;
            if (navMesh && navMesh.isReady()) {
                // Probe one body-radius ahead in each candidate direction.
                // Far enough that the agent's body wouldn't fit if blocked,
                // close enough that distant obstacles don't veto an escape
                // they're actually clear of.
                const probe = agent.radius + 0.1;
                leftClear  = navMesh.isWalkableAt(ax + leftPerpX  * probe, az + leftPerpZ  * probe);
                rightClear = navMesh.isWalkableAt(ax + rightPerpX * probe, az + rightPerpZ * probe);
            }

            let perpX: number;
            let perpZ: number;
            if (!leftClear && !rightClear) {
                // No escape route on either side — give up steering, slow
                // hard so physics has time to resolve the conflict.
                perpX = 0; perpZ = 0;
                if (speedScale > 0.15) speedScale = 0.15;
            } else if (leftClear && !rightClear) {
                perpX = leftPerpX; perpZ = leftPerpZ;
            } else if (!leftClear && rightClear) {
                perpX = rightPerpX; perpZ = rightPerpZ;
            } else {
                // Both sides walkable — use the original geometry-aware pick.
                const crossNorm = (dirX * dz - dirZ * dx) / dist;
                if (Math.abs(crossNorm) < 0.1) {
                    if (agent.bodyHandle < n.handle) {
                        perpX = rightPerpX; perpZ = rightPerpZ;
                    } else {
                        perpX = leftPerpX; perpZ = leftPerpZ;
                    }
                } else if (crossNorm > 0) {
                    perpX = rightPerpX; perpZ = rightPerpZ;
                } else {
                    perpX = leftPerpX; perpZ = leftPerpZ;
                }
            }

            const contribution = weight * roleMul;
            steerX += perpX * contribution;
            steerZ += perpZ * contribution;

            if (yielding && tCA < opts.yieldSlowdownWindow) {
                const t = tCA / opts.yieldSlowdownWindow;
                const candidate = opts.yieldSpeedMultiplier + (1 - opts.yieldSpeedMultiplier) * t;
                if (candidate < speedScale) speedScale = candidate;
            }
        }

        // Blend desired direction with steering contributions.
        const blendedX = dirX + steerX;
        const blendedZ = dirZ + steerZ;
        const blendedLen = Math.sqrt(blendedX * blendedX + blendedZ * blendedZ);
        let outX: number;
        let outZ: number;
        if (blendedLen < 1e-6) {
            outX = dirX; outZ = dirZ;
        } else {
            outX = blendedX / blendedLen;
            outZ = blendedZ / blendedLen;
        }

        // Cap angular deflection so one frame can't whip the agent around.
        const dot = dirX * outX + dirZ * outZ;
        const clampedDot = Math.max(-1, Math.min(1, dot));
        const angle = Math.acos(clampedDot);
        if (angle > opts.maxDeflection) {
            const t = opts.maxDeflection / angle;
            const lx = dirX * (1 - t) + outX * t;
            const lz = dirZ * (1 - t) + outZ * t;
            const ll = Math.sqrt(lx * lx + lz * lz);
            if (ll > 1e-6) {
                outX = lx / ll;
                outZ = lz / ll;
            }
        }

        return {
            steeredDirection: new THREE.Vector3(outX, 0, outZ),
            speedScale,
        };
    }
}

/**
 * Map a physics-body userData blob to an agent priority tier. Returns null
 * for non-agent bodies (static props, debris, projectiles) so they're
 * ignored by the steering scan.
 */
function readNeighborPriority(userData: unknown): AgentPriority | null {
    if (!userData || typeof userData !== 'object') return null;
    const ud = userData as MinimalUserData;
    // Bodies that opted out of avoidance are invisible to other agents' scans.
    if (ud.avoidanceDisabled === true) return null;
    switch (ud.__type) {
        case 'animal':
        case 'snake':
        case 'remoteAnimal':
            return AgentPriority.ANIMAL;
        case 'npc':
        case 'remoteNpc':
            return AgentPriority.NPC;
        case 'player':
            return AgentPriority.PLAYER;
        case 'vehicle':
            return AgentPriority.VEHICLE;
        default:
            return null;
    }
}

function readNeighborRadius(userData: unknown): number | null {
    if (!userData || typeof userData !== 'object') return null;
    const ud = userData as MinimalUserData;
    return typeof ud.agentRadius === 'number' ? ud.agentRadius : null;
}

let _globalSystem: AgentAvoidanceSystem | null = null;

/** @internal Called once by GameEngine during initialization. */
export function setGlobalAgentAvoidance(system: AgentAvoidanceSystem): void {
    _globalSystem = system;
}

export function getGlobalAgentAvoidance(): AgentAvoidanceSystem | null {
    return _globalSystem;
}
