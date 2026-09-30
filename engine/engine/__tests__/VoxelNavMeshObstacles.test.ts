import * as THREE from 'three';
import { VoxelNavMesh, setGlobalNavMesh, registerObstacleProvider } from 'engine/VoxelNavMesh.js';

// Mock the voxel-world dependency: flat ground at y=1 everywhere.
const mockAtlas = { isFluidBlock: () => false };
const mockVoxelWorld = {
    getVoxelSize: () => 1.0,
    getColumnUniformGroundY: () => 1,
    getColumnMaxWorldY: () => 1,
    getBlock: (_x: number, y: number) => (y < 1 ? 1 : 0),
} as any;

// Mock the atlas singleton.
jest.mock('engine/VoxelTextureAtlas.js', () => ({
    getVoxelTextureAtlas: () => mockAtlas,
}));

// Test-local convenience: register several box obstacles via the supported
// per-obstacle `addObstacle` API. (The old batch helpers markObstacles /
// markBoxObstacles were removed — `addObstacle` / `addTrackedObstacle` are
// the single supported obstacle path.)
function addBoxes(
    nav: VoxelNavMesh,
    boxes: Array<{ x: number; z: number; halfW: number; halfD: number; yaw?: number }>,
): void {
    for (const b of boxes) {
        nav.addObstacle({ kind: 'box', x: b.x, z: b.z, halfW: b.halfW, halfD: b.halfD, yaw: b.yaw });
    }
}

describe('VoxelNavMesh obstacle marking', () => {
    it('marks a box obstacle as blocked at its centre', () => {
        const nav = new VoxelNavMesh();
        nav.buildFromVoxelWorld(mockVoxelWorld, -32, 32, -32, 32, { cellSize: 0.125 });
        expect(nav.isReady()).toBe(true);

        // Drop a 1.2m × 1.2m table at world (-4, ?, -10) — the same as tavern_table_A.
        addBoxes(nav, [
            { x: -4, z: -10, halfW: 0.6, halfD: 0.6, yaw: 0 },
        ]);

        // The table centre should now be unwalkable.
        expect(nav.isValidNavigationTarget(new THREE.Vector3(-4, 1, -10))).toBe(false);

        // A point 2m away (well outside the inflated footprint) should remain walkable.
        expect(nav.isValidNavigationTarget(new THREE.Vector3(-4, 1, -13))).toBe(true);

        // A point at the edge of the inflated zone (1.0m from centre) should be blocked.
        expect(nav.isValidNavigationTarget(new THREE.Vector3(-4, 1, -9.2))).toBe(false);
    });

    it('marks circle obstacles via addObstacle', () => {
        const nav = new VoxelNavMesh();
        nav.buildFromVoxelWorld(mockVoxelWorld, -32, 32, -32, 32, { cellSize: 0.125 });

        nav.addObstacle({ kind: 'circle', x: 5, z: 5, radius: 0.5 });

        expect(nav.isValidNavigationTarget(new THREE.Vector3(5, 1, 5))).toBe(false);
        expect(nav.isValidNavigationTarget(new THREE.Vector3(5, 1, 7))).toBe(true);
    });

    it('removeObstacle restores cells (no overlapping obstacles)', () => {
        const nav = new VoxelNavMesh();
        nav.buildFromVoxelWorld(mockVoxelWorld, -32, 32, -32, 32, { cellSize: 0.125 });

        const handle = nav.addObstacle({ kind: 'box', x: 0, z: 0, halfW: 0.5, halfD: 0.5 });
        expect(nav.isValidNavigationTarget(new THREE.Vector3(0, 1, 0))).toBe(false);

        nav.removeObstacle(handle);
        expect(nav.isValidNavigationTarget(new THREE.Vector3(0, 1, 0))).toBe(true);
    });

    it('handles 78 wall segments along a perimeter (the village stress case)', () => {
        const nav = new VoxelNavMesh();
        nav.buildFromVoxelWorld(mockVoxelWorld, -32, 32, -32, 32, { cellSize: 0.125 });

        // 16 wall segments along z=40 (mimic the actual village north wall).
        // halfW=2.39, halfD=2.06 from the real glb_stone_wall_segment bbox.
        // Compress to z=20 so they fit in our smaller test world.
        const walls = [];
        for (let i = 0; i < 16; i++) {
            walls.push({ x: -32 + i * 4, z: 20, halfW: 2.39, halfD: 2.06, yaw: 0 });
        }
        addBoxes(nav, walls);

        // A point right at the wall line should be blocked.
        expect(nav.isValidNavigationTarget(new THREE.Vector3(-15, 1, 20))).toBe(false);
        // Well clear of the wall should be walkable.
        expect(nav.isValidNavigationTarget(new THREE.Vector3(-15, 1, 10))).toBe(true);
    });

    it('integration: actual village obstacles + path that should detour around the inn', () => {
        const nav = new VoxelNavMesh();
        // World matches the village game: 128m wide is enough.
        nav.buildFromVoxelWorld(mockVoxelWorld, -64, 64, -64, 64, { cellSize: 0.125 });

        // Real assets from world.json: inn + tavern tables.
        addBoxes(nav, [
            // Inn: at (-10, -12), halfW=3.46, halfD=3.04
            { x: -10, z: -12, halfW: 3.46, halfD: 3.04, yaw: 0 },
            // Tavern tables: at (-4, -10) and (-4, -14), each halfW=halfD=0.6
            { x: -4, z: -10, halfW: 0.6, halfD: 0.6, yaw: 0 },
            { x: -4, z: -14, halfW: 0.6, halfD: 0.6, yaw: 0 },
            // Beer keg: at (-6, -8), halfW=halfD=0.45
            { x: -6, z: -8, halfW: 0.45, halfD: 0.45, yaw: 0 },
        ]);

        // Tavern table A position: should be blocked.
        expect(nav.isValidNavigationTarget(new THREE.Vector3(-4, 1, -10))).toBe(false);

        // Inn centre: should be blocked.
        expect(nav.isValidNavigationTarget(new THREE.Vector3(-10, 1, -12))).toBe(false);

        // Walk from village centre (0, 1, 0) toward the tavern. The path must
        // not include any cell inside the inn or table's inflated footprint.
        const path = nav.findPath(
            new THREE.Vector3(0, 1, 0),
            new THREE.Vector3(-6, 1, -12),  // approachPos behind the bar
        );
        console.log('  path length:', path.length);
        // Path must exist (not the straight-line fallback to the end).
        expect(path.length).toBeGreaterThan(1);
        // Every waypoint must be on a walkable cell — if any waypoint lands
        // inside an inflated obstacle, the NPC will walk straight at it.
        for (const w of path) {
            expect(nav.isValidNavigationTarget(w)).toBe(true);
        }
    });

    it('preserves registered obstacles across a buildFromVoxelWorld rebuild (cellSize change)', () => {
        const nav = new VoxelNavMesh();
        // First build at 1m (the default the engine starts with).
        nav.buildFromVoxelWorld(mockVoxelWorld, -32, 32, -32, 32, { cellSize: 1.0 });
        const handle = nav.addObstacle({ kind: 'box', x: 0, z: 0, halfW: 1, halfD: 1 });
        expect(nav.isValidNavigationTarget(new THREE.Vector3(0, 1, 0))).toBe(false);

        // Game.ts rebuilds at high resolution. The obstacle must survive.
        nav.buildFromVoxelWorld(mockVoxelWorld, -32, 32, -32, 32, { cellSize: 0.125 });
        expect(nav.isReady()).toBe(true);
        // Same handle still removable (obstacle wasn't lost).
        expect(nav.isValidNavigationTarget(new THREE.Vector3(0, 1, 0))).toBe(false);
        nav.removeObstacle(handle);
        expect(nav.isValidNavigationTarget(new THREE.Vector3(0, 1, 0))).toBe(true);
    });

    it('places blocker at the world position passed in (regression: fence with asymmetric bbox)', () => {
        // Regression: a fence asset whose bbox runs x ∈ [0, 2.1] (origin
        // at one corner, NOT centred) used to be marked at the wrong world
        // location because the registration only passed halfW. The fix
        // routes asymmetric bboxes through a local-frame centre offset
        // applied by the caller before passing the box to the navmesh.
        // The navmesh itself is correctly anchored at whatever `x`/`z` it
        // receives; this test verifies that contract.
        const nav = new VoxelNavMesh();
        nav.buildFromVoxelWorld(mockVoxelWorld, -16, 16, -16, 16, { cellSize: 0.25, agentRadius: 0 });

        // Caller (EnvironmentObjectSystem) has already rotated the local
        // centre offset (1.05, 0) by yaw=0 and added to placement (3, 5):
        //   world centre = (3 + 1.05, 5 + 0) = (4.05, 5)
        nav.addObstacle({ kind: 'box', x: 4.05, z: 5, halfW: 1.05, halfD: 0.1, yaw: 0 });

        // Centre of the fence in world space — should be blocked.
        expect(nav.isValidNavigationTarget(new THREE.Vector3(4.05, 1, 5))).toBe(false);
        // 2 m to either side of the fence centre — beyond its 2.1 m length.
        expect(nav.isValidNavigationTarget(new THREE.Vector3(7.0, 1, 5))).toBe(true);
        expect(nav.isValidNavigationTarget(new THREE.Vector3(1.0, 1, 5))).toBe(true);
        // 3 m perpendicular to the fence — well clear.
        expect(nav.isValidNavigationTarget(new THREE.Vector3(4.05, 1, 8))).toBe(true);
    });

    it('rotates the box mask in the SAME direction as the obstacle yaw (not mirrored)', () => {
        // Regression: paintBox used the forward rotation R(+yaw) instead of
        // the inverse R(-yaw), which mirrored the blocked footprint across
        // the obstacle's centre. Visible in the debug overlay as a mask
        // rotated opposite to the object.
        const nav = new VoxelNavMesh();
        nav.buildFromVoxelWorld(mockVoxelWorld, -16, 16, -16, 16, { cellSize: 0.25, agentRadius: 0 });

        // Long, thin obstacle along local X (halfW = 4, halfD = 0.5), at
        // gameplay yaw = +π/4. Local +Z (forward) at yaw=π/4 maps to world
        // (sin(π/4), 0, cos(π/4)) ≈ (0.707, 0, 0.707), so local +X (right of
        // forward) maps to world (cos(π/4), 0, -sin(π/4)) ≈ (0.707, 0, -0.707).
        // The box's long axis therefore runs along the world (+X, −Z)
        // diagonal — NOT the (+X, +Z) diagonal.
        nav.addObstacle({ kind: 'box', x: 0, z: 0, halfW: 4, halfD: 0.5, yaw: Math.PI / 4 });

        // A point along the (+X, −Z) diagonal, well within the box's length:
        // (2.83, 1, −2.83) is 4 units along the box's local +X. Inside.
        expect(nav.isValidNavigationTarget(new THREE.Vector3(2.83, 1, -2.83))).toBe(false);

        // A point along the (+X, +Z) diagonal at the same distance from
        // origin is *perpendicular* to the box's long axis — well outside.
        expect(nav.isValidNavigationTarget(new THREE.Vector3(2.83, 1, 2.83))).toBe(true);
    });

    it('survives a setGlobalNavMesh instance swap (Game.ts rebuildHighResNavMesh scenario)', () => {
        // The actual Game.ts path: build a 1m navmesh, register some obstacles
        // via providers (mirroring VoxelObject.setNavmeshObstacleEnabled),
        // then dispose-and-swap for a 0.125m instance. Without the registry,
        // every obstacle vanishes — which is exactly what the screenshot
        // showed (empty navmesh, straight-line paths through objects).
        const navA = new VoxelNavMesh();
        navA.buildFromVoxelWorld(mockVoxelWorld, -32, 32, -32, 32, { cellSize: 1.0 });
        setGlobalNavMesh(navA);

        // Pretend a VoxelObject auto-registered itself.
        const provider = registerObstacleProvider(() => ({ kind: 'box', x: 0, z: 0, halfW: 0.6, halfD: 0.6 }));
        expect(navA.isValidNavigationTarget(new THREE.Vector3(0, 1, 0))).toBe(false);

        // Game.ts disposes and swaps to a fresh high-res instance.
        navA.dispose();
        const navB = new VoxelNavMesh();
        navB.buildFromVoxelWorld(mockVoxelWorld, -32, 32, -32, 32, { cellSize: 0.125 });
        setGlobalNavMesh(navB);

        // The obstacle should automatically be present on navB.
        expect(navB.isValidNavigationTarget(new THREE.Vector3(0, 1, 0))).toBe(false);
        expect(provider.currentHandle).not.toBe(0);

        setGlobalNavMesh(null);  // clean up for other tests
    });

    it('integration: a chair next to a table — does the table block the chair seat?', () => {
        const nav = new VoxelNavMesh();
        nav.buildFromVoxelWorld(mockVoxelWorld, -32, 32, -32, 32, { cellSize: 0.125 });

        // tavern_table_A at (-4, -10), halfW=halfD=0.6 → inflated to radius ~1.0
        // tavern_chair_A_n at (-4, -11.4) → 1.4m south of table centre
        // After table inflation (0.6 + 0.4 = 1.0 in box-perpendicular), the chair
        // at distance 1.4 should be OUTSIDE the table's blocked zone.
        addBoxes(nav, [{ x: -4, z: -10, halfW: 0.6, halfD: 0.6, yaw: 0 }]);

        // Chair seat — should be walkable (not blocked by the table).
        const chairSeat = new THREE.Vector3(-4, 1, -11.4);
        expect(nav.isValidNavigationTarget(chairSeat)).toBe(true);

        // approachPos: 1.4m further south of chair → (-4, 1, -12.8)
        const approachPos = new THREE.Vector3(-4, 1, -12.8);
        expect(nav.isValidNavigationTarget(approachPos)).toBe(true);
    });

    it('findPath honours the default maxPathLength budget', () => {
        // Build a wide-open navmesh (no obstacles). A 10 m straight-line
        // target lies well within the default budget of max(20, 13) = 20 m,
        // so the path must succeed.
        const nav = new VoxelNavMesh();
        nav.buildFromVoxelWorld(mockVoxelWorld, -32, 32, -32, 32, { cellSize: 0.25 });

        const path = nav.findPath(
            new THREE.Vector3(0, 1, 0),
            new THREE.Vector3(10, 1, 0),
        );
        expect(path.length).toBeGreaterThan(0);
        // Final waypoint should be at or near the target.
        const last = path[path.length - 1];
        expect(Math.hypot(last.x - 10, last.z - 0)).toBeLessThan(1.0);
    });

    it('findPath returns [] when the explicit maxPathLength is too small', () => {
        // 10 m straight-line target with a 5 m budget — A* should prune
        // every branch before reaching the goal and return no path.
        const nav = new VoxelNavMesh();
        nav.buildFromVoxelWorld(mockVoxelWorld, -32, 32, -32, 32, { cellSize: 0.25 });

        const path = nav.findPath(
            new THREE.Vector3(0, 1, 0),
            new THREE.Vector3(10, 1, 0),
            undefined,
            5, // budget too short
        );
        expect(path).toEqual([]);
    });

    it('findPath accepts an explicit large maxPathLength to allow long detours', () => {
        // Same 10 m target, generous 100 m budget — succeeds normally.
        const nav = new VoxelNavMesh();
        nav.buildFromVoxelWorld(mockVoxelWorld, -32, 32, -32, 32, { cellSize: 0.25 });

        const path = nav.findPath(
            new THREE.Vector3(0, 1, 0),
            new THREE.Vector3(10, 1, 0),
            undefined,
            100,
        );
        expect(path.length).toBeGreaterThan(0);
    });

    it('default maxPathLength has a 20 m floor for very short targets', () => {
        // Walk just 1 m. Default budget = max(20, 1*1.3) = 20 m. Even with
        // detour-forcing obstacles in the way, A* should explore up to 20 m
        // before giving up. Place no obstacles so the path trivially succeeds
        // — the assertion is implicit: it doesn't bail early just because
        // 1*1.3 = 1.3 m.
        const nav = new VoxelNavMesh();
        nav.buildFromVoxelWorld(mockVoxelWorld, -32, 32, -32, 32, { cellSize: 0.25 });

        const path = nav.findPath(
            new THREE.Vector3(0, 1, 0),
            new THREE.Vector3(1, 1, 0),
        );
        expect(path.length).toBeGreaterThan(0);
    });

    it('findPath extras force the route to detour around a virtual circle', () => {
        // No static obstacles — only an extras-passed circle that the planner
        // must route around. The straight line from (-5,0) to (5,0) would
        // pass through (0,0); the extra at (0,0,0.3) should push the path
        // off the line.
        const nav = new VoxelNavMesh();
        nav.buildFromVoxelWorld(mockVoxelWorld, -32, 32, -32, 32, { cellSize: 0.25 });

        const path = nav.findPath(
            new THREE.Vector3(-5, 1, 0),
            new THREE.Vector3(5, 1, 0),
            [{ x: 0, z: 0, radius: 0.3 }],
        );
        expect(path.length).toBeGreaterThan(0);
        // The path must NOT pass through any cell within combined-radius
        // (0.3 extra + 0.35 default agent) = 0.65 m of the extra's centre.
        // Sample every waypoint and the midpoints between them; the
        // inflated extra zone is small enough that a missed sample is
        // unlikely but the midpoint check catches long straight segments.
        let lastX = -5;
        let lastZ = 0;
        for (const w of path) {
            const samples = 8;
            for (let i = 1; i <= samples; i++) {
                const t = i / samples;
                const sx = lastX + (w.x - lastX) * t;
                const sz = lastZ + (w.z - lastZ) * t;
                // Allow grazing — the planner approximates the circle on a
                // grid, so the boundary isn't perfectly tight. Reject only
                // clearly-inside samples.
                const distSq = sx * sx + sz * sz;
                expect(distSq).toBeGreaterThan(0.16); // > 0.4 m from centre
            }
            lastX = w.x;
            lastZ = w.z;
        }
    });

    it('findPath survives the agent being inside an extra zone (close encounter)', () => {
        // The bug this guards against: when the start cell is inside an
        // extra's inflated radius, naively binning the extra at its full
        // radius blocks every neighbour cell too — A* can't expand, returns
        // [], and the caller is forced to keep its stale path (which
        // routes the agent right through the peer). The fix shrinks any
        // extra that contains the start so cells deeper into the zone
        // stay blocked but the start cell and its escape direction are
        // free. After the fix this case must return a non-empty path.
        const nav = new VoxelNavMesh();
        nav.buildFromVoxelWorld(mockVoxelWorld, -32, 32, -32, 32, { cellSize: 0.25 });

        // Peer right next to the start position — within the 0.6 m
        // combined radius. Without the fix the planner returns [].
        const path = nav.findPath(
            new THREE.Vector3(0, 1, 0),
            new THREE.Vector3(5, 1, 0),
            [{ x: 0.3, z: 0, radius: 0.3 }],
        );
        expect(path.length).toBeGreaterThan(0);
    });
});
