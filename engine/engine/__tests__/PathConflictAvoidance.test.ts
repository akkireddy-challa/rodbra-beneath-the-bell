import * as THREE from 'three';
import { PathConflictAvoidanceSystem, DEFAULT_PATH_CONFLICT_OPTIONS, type PathScannerAgent } from 'engine/PathConflictAvoidance.js';
import type { PhysicsWorld, SpatialQueryResult } from 'engine/physics/PhysicsWorld.js';

/**
 * Minimal PhysicsWorld stub for path-conflict scans. Holds a flat list of
 * (handle, position) tuples and answers `queryEntitiesInRadius` by linear
 * scan. Anything not exercised by PathConflictAvoidance is undefined — the
 * cast through `unknown` makes that explicit at call sites.
 */
function makeMockPhysicsWorld(entities: { handle: number; position: THREE.Vector3 }[]): PhysicsWorld {
    const stub = {
        queryEntitiesInRadius(center: { x: number; y: number; z: number }, radius: number): SpatialQueryResult[] {
            const r2 = radius * radius;
            const out: SpatialQueryResult[] = [];
            for (const e of entities) {
                const dx = e.position.x - center.x;
                const dy = e.position.y - center.y;
                const dz = e.position.z - center.z;
                if (dx * dx + dy * dy + dz * dz <= r2) {
                    out.push({ handle: e.handle, userData: { __type: 'npc' }, position: { x: e.position.x, y: e.position.y, z: e.position.z } });
                }
            }
            return out;
        },
    };
    return stub as unknown as PhysicsWorld;
}

/** Build a `PathScannerAgent` whose replan callback records the extras seen. */
function makeAgent(handle: number, position: THREE.Vector3, path: THREE.Vector3[]): {
    agent: PathScannerAgent;
    replans: Array<ReadonlyArray<{ x: number; z: number; radius: number }>>;
} {
    const replans: Array<ReadonlyArray<{ x: number; z: number; radius: number }>> = [];
    const agent: PathScannerAgent = {
        bodyHandle: handle,
        position,
        radius: 0.3,
        getPath: () => path,
        getCurrentWaypointIndex: () => 0,
        getMoveSpeed: () => 2.0,
        replanWithExtras: (extras) => { replans.push(extras); },
    };
    return { agent, replans };
}

describe('PathConflictAvoidanceSystem', () => {
    it('flags a peer standing on the forward path and replans', () => {
        // Agent A walks from (0,0,0) to (5,0,0). Agent B stands at (3,0,0).
        const posA = new THREE.Vector3(0, 1, 0);
        const posB = new THREE.Vector3(3, 1, 0);
        const { agent: agentA, replans } = makeAgent(1, posA, [new THREE.Vector3(5, 1, 0)]);
        const { agent: agentB } = makeAgent(2, posB, []);

        const world = makeMockPhysicsWorld([
            { handle: 1, position: posA },
            { handle: 2, position: posB },
        ]);

        const sys = new PathConflictAvoidanceSystem();
        sys.register(agentA);
        sys.register(agentB);

        sys.tick(0.016, world);

        expect(replans).toHaveLength(1);
        expect(replans[0]).toHaveLength(1);
        expect(replans[0]![0]!.x).toBeCloseTo(3);
        expect(replans[0]![0]!.radius).toBe(0.3);
    });

    it('does not flag peers far off the forward path', () => {
        // Agent B is 5m perpendicular to A's path — well outside any sample.
        const posA = new THREE.Vector3(0, 1, 0);
        const posB = new THREE.Vector3(3, 1, 5);
        const { agent: agentA, replans } = makeAgent(1, posA, [new THREE.Vector3(5, 1, 0)]);
        const { agent: agentB } = makeAgent(2, posB, []);
        const world = makeMockPhysicsWorld([
            { handle: 1, position: posA },
            { handle: 2, position: posB },
        ]);
        const sys = new PathConflictAvoidanceSystem();
        sys.register(agentA);
        sys.register(agentB);

        sys.tick(0.016, world);

        expect(replans).toHaveLength(0);
    });

    it('excludes the planner itself from its own extras list', () => {
        // Trigger a replan for A by putting B on the path, then verify A's
        // own handle is never in the extras passed back to A.
        const posA = new THREE.Vector3(0, 1, 0);
        const posB = new THREE.Vector3(2, 1, 0);
        const { agent: agentA, replans } = makeAgent(1, posA, [new THREE.Vector3(5, 1, 0)]);
        const { agent: agentB } = makeAgent(2, posB, []);
        const world = makeMockPhysicsWorld([
            { handle: 1, position: posA },
            { handle: 2, position: posB },
        ]);
        const sys = new PathConflictAvoidanceSystem();
        sys.register(agentA);
        sys.register(agentB);

        sys.tick(0.016, world);

        // Extras come from temp obstacles; A should never see itself.
        expect(replans[0]!.find((e) => e.x === posA.x && e.z === posA.z)).toBeUndefined();
        // A's getActiveExtrasForAgent(self) should also exclude self.
        const extras = sys.getActiveExtrasForAgent(1);
        expect(extras.find((e) => e.x === posA.x && e.z === posA.z)).toBeUndefined();
    });

    it('drops temp obstacles after the configured TTL elapses', () => {
        const posA = new THREE.Vector3(0, 1, 0);
        const posB = new THREE.Vector3(2, 1, 0);
        const { agent: agentA } = makeAgent(1, posA, [new THREE.Vector3(5, 1, 0)]);
        const { agent: agentB } = makeAgent(2, posB, []);
        const world = makeMockPhysicsWorld([
            { handle: 1, position: posA },
            { handle: 2, position: posB },
        ]);
        const sys = new PathConflictAvoidanceSystem({
            ...DEFAULT_PATH_CONFLICT_OPTIONS,
            obstacleTtlSeconds: 0.5,
        });
        sys.register(agentA);
        sys.register(agentB);

        sys.tick(0.016, world);
        expect(sys.getActiveExtrasForAgent(1)).toHaveLength(1);

        // Move A out of the way so subsequent scans don't refresh the flag.
        agentA.position.set(50, 1, 50);
        agentB.position.set(50, 1, 60);
        // Advance past TTL via several ticks. Each tick processes 1 agent
        // round-robin, and on the eviction pass anything past expiresAt drops.
        sys.tick(0.6, world);
        expect(sys.getActiveExtrasForAgent(1)).toHaveLength(0);
    });

    it('unregister removes any pending temp obstacle for that handle', () => {
        const posA = new THREE.Vector3(0, 1, 0);
        const posB = new THREE.Vector3(2, 1, 0);
        const { agent: agentA } = makeAgent(1, posA, [new THREE.Vector3(5, 1, 0)]);
        const { agent: agentB } = makeAgent(2, posB, []);
        const world = makeMockPhysicsWorld([
            { handle: 1, position: posA },
            { handle: 2, position: posB },
        ]);
        const sys = new PathConflictAvoidanceSystem();
        sys.register(agentA);
        sys.register(agentB);
        sys.tick(0.016, world);
        expect(sys.getActiveExtrasForAgent(1)).toHaveLength(1);

        sys.unregister(2);
        expect(sys.getActiveExtrasForAgent(1)).toHaveLength(0);
    });

    it('round-robins one agent per tick', () => {
        // Two agents both planning a clear straight path — nobody on it.
        // Each tick should process exactly one agent (no replan triggered
        // because no conflicts, but we can confirm by checking that the
        // scan-index advances and never duplicates per round).
        const posA = new THREE.Vector3(0, 1, 0);
        const posB = new THREE.Vector3(10, 1, 10);
        const replanA: number[] = [];
        const replanB: number[] = [];

        // Put a peer in front of each agent so we can observe per-tick replans.
        const peerForA = new THREE.Vector3(2, 1, 0);
        const peerForB = new THREE.Vector3(12, 1, 10);
        const world = makeMockPhysicsWorld([
            { handle: 1, position: posA },
            { handle: 2, position: posB },
            { handle: 11, position: peerForA },
            { handle: 12, position: peerForB },
        ]);

        const agentA: PathScannerAgent = {
            bodyHandle: 1, position: posA, radius: 0.3,
            getPath: () => [new THREE.Vector3(5, 1, 0)],
            getCurrentWaypointIndex: () => 0,
            getMoveSpeed: () => 2.0,
            replanWithExtras: () => { replanA.push(1); },
        };
        const agentB: PathScannerAgent = {
            bodyHandle: 2, position: posB, radius: 0.3,
            getPath: () => [new THREE.Vector3(15, 1, 10)],
            getCurrentWaypointIndex: () => 0,
            getMoveSpeed: () => 2.0,
            replanWithExtras: () => { replanB.push(1); },
        };
        // Peers must also be registered so they get flagged as scanner peers.
        const peerA: PathScannerAgent = {
            bodyHandle: 11, position: peerForA, radius: 0.3,
            getPath: () => [], getCurrentWaypointIndex: () => 0, getMoveSpeed: () => 0, replanWithExtras: () => {},
        };
        const peerB: PathScannerAgent = {
            bodyHandle: 12, position: peerForB, radius: 0.3,
            getPath: () => [], getCurrentWaypointIndex: () => 0, getMoveSpeed: () => 0, replanWithExtras: () => {},
        };
        const sys = new PathConflictAvoidanceSystem();
        sys.register(agentA);
        sys.register(agentB);
        sys.register(peerA);
        sys.register(peerB);

        // Tick 1: scans A → replanA fires.
        sys.tick(0.016, world);
        expect(replanA).toHaveLength(1);
        expect(replanB).toHaveLength(0);
        // Tick 2: scans B → replanB fires.
        sys.tick(0.016, world);
        expect(replanA).toHaveLength(1);
        expect(replanB).toHaveLength(1);
    });

    it('does not flag bodies whose handle is not a registered scanner', () => {
        // A static crate (handle 99) sits on the path. It's NOT registered
        // as a PathScannerAgent, so it should be ignored — static obstacles
        // belong to the VoxelNavMesh, not the path-conflict layer.
        const posA = new THREE.Vector3(0, 1, 0);
        const crate = new THREE.Vector3(2, 1, 0);
        const { agent: agentA, replans } = makeAgent(1, posA, [new THREE.Vector3(5, 1, 0)]);
        const world = makeMockPhysicsWorld([
            { handle: 1, position: posA },
            { handle: 99, position: crate },
        ]);
        const sys = new PathConflictAvoidanceSystem();
        sys.register(agentA);

        sys.tick(0.016, world);

        expect(replans).toHaveLength(0);
        expect(sys.getActiveExtrasForAgent(1)).toHaveLength(0);
    });

    it('flags a static blocker (e.g. the player) on an agent\'s forward path', () => {
        // The player is registered via registerStaticBlocker — no path,
        // no replan, but should still cause OTHER agents to route around.
        // Agent A walks (0,0,0) → (5,0,0). Player stands at (3,0,0).
        const posA = new THREE.Vector3(0, 1, 0);
        const playerPos = new THREE.Vector3(3, 1, 0);
        const { agent: agentA, replans } = makeAgent(1, posA, [new THREE.Vector3(5, 1, 0)]);
        const world = makeMockPhysicsWorld([
            { handle: 1, position: posA },
            { handle: 42, position: playerPos },
        ]);
        const sys = new PathConflictAvoidanceSystem();
        sys.register(agentA);
        sys.registerStaticBlocker(42, playerPos, () => 0.3);

        sys.tick(0.016, world);

        // Agent A's replan should have been called with the player as a
        // virtual obstacle.
        expect(replans).toHaveLength(1);
        expect(replans[0]).toHaveLength(1);
        expect(replans[0]![0]!.x).toBeCloseTo(3);
        expect(replans[0]![0]!.radius).toBe(0.3);
    });

    it('static blocker itself is never scanned (no replan call back to it)', () => {
        // The player (static blocker) shouldn't ever have its own replan
        // invoked — its getPath() returns []. Even after we round-robin
        // through every registered agent, the player's replan callback
        // (a no-op anyway) must not have been the source of any flagging.
        const posA = new THREE.Vector3(0, 1, 0);
        const playerPos = new THREE.Vector3(3, 1, 0);
        const { agent: agentA } = makeAgent(1, posA, [new THREE.Vector3(5, 1, 0)]);
        const world = makeMockPhysicsWorld([
            { handle: 1, position: posA },
            { handle: 42, position: playerPos },
        ]);
        const sys = new PathConflictAvoidanceSystem();
        sys.register(agentA);
        sys.registerStaticBlocker(42, playerPos, () => 0.3);

        // Round-robin enough ticks to scan every agent at least once.
        sys.tick(0.016, world); // would scan agent 1
        sys.tick(0.016, world); // would scan player (handle 42) — early-returns
        sys.tick(0.016, world); // wraps back to agent 1

        // Player's TempObstacle entry is keyed by handle 42 — getActiveExtras
        // for agent 1 should include it.
        const extras = sys.getActiveExtrasForAgent(1);
        expect(extras).toHaveLength(1);
        // And asking for the player's OWN extras should exclude the player
        // (self-exclusion still applies to static blockers).
        const playerExtras = sys.getActiveExtrasForAgent(42);
        expect(playerExtras.find(e => e.x === playerPos.x && e.z === playerPos.z)).toBeUndefined();
    });

    it('static blocker uses the live radius getter (picks up post-register changes)', () => {
        // PlayerController.setCapsuleDimensions mutates capsuleRadius after
        // registration; the radius getter should reflect that.
        const posA = new THREE.Vector3(0, 1, 0);
        const playerPos = new THREE.Vector3(3, 1, 0);
        const { agent: agentA, replans } = makeAgent(1, posA, [new THREE.Vector3(5, 1, 0)]);
        const world = makeMockPhysicsWorld([
            { handle: 1, position: posA },
            { handle: 42, position: playerPos },
        ]);
        const sys = new PathConflictAvoidanceSystem();
        sys.register(agentA);

        // Radius starts at 0.3; after registration we bump it to 0.5.
        let currentRadius = 0.3;
        sys.registerStaticBlocker(42, playerPos, () => currentRadius);
        currentRadius = 0.5;

        sys.tick(0.016, world);

        // The extras passed to replan should carry the LATEST radius.
        expect(replans[0]).toHaveLength(1);
        expect(replans[0]![0]!.radius).toBe(0.5);
    });
});
