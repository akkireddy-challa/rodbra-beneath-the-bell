import * as THREE from 'three';
import { VoxelNavMesh } from 'engine/VoxelNavMesh.js';
import { TWO_FLOOR, buildLayeredNav, buildTwoFloorNav, toArrayBuffer } from 'engine/__tests__/helpers/buildTwoFloorNav.js';
import type { VoxelWorld } from 'engine/VoxelWorld.js';

const mockAtlas = { isFluidBlock: () => false };
jest.mock('engine/VoxelTextureAtlas.js', () => ({
    getVoxelTextureAtlas: () => mockAtlas,
}));

// Flat ground at y=1. `getColumnUniformGroundY` returns null so every chunk
// takes the per-cell path and is promoted to a single-layer Grid chunk.
const mockVoxelWorld = {
    getVoxelSize: () => 1.0,
    getColumnUniformGroundY: () => null,
    getColumnMaxWorldY: () => 0,
    getBlock: (_x: number, y: number) => (y < 1 ? 1 : 0),
} as unknown as VoxelWorld;

const LOWER = new THREE.Vector3(6.5, TWO_FLOOR.lowerY, 6.5);
const UPPER = new THREE.Vector3(6.5, TWO_FLOOR.upperY, 1.5);

// Most cross-floor tests pin an explicit budget so they exercise the layered
// search, not the budget heuristic. One test below covers the default.
const BUDGET_M = 60;

/**
 * Reviewer's line-of-sight fixture: an 8x8 m ground floor at y=0 with a
 * walkway at y=1.5 over row lz=0, joined by a SINGLE ramp cell (7,1) at
 * y=0.75. The walkway sits directly above the ground floor, so a straight
 * line from the floor to a walkway waypoint has an unobstructed XZ sightline
 * — the case where string-pulling must not collapse the detour to the ramp
 * into a vertical jump.
 */
const RAMP_CELL = new THREE.Vector3(7.5, 0.75, 1.5);
const RAMP_START = new THREE.Vector3(0.5, 0, 5.5);
const RAMP_END = new THREE.Vector3(0.5, 1.5, 0.5);

function buildWalkwayNav(options: { ramp?: boolean } = {}): VoxelNavMesh {
    const withRamp = options.ramp ?? true;
    return buildLayeredNav((lx, lz) => {
        if (lx > 7 || lz > 7) return [];
        const heights = [0];
        if (lz === 0) heights.push(1.5);
        if (withRamp && lx === 7 && lz === 1) heights.push(0.75);
        return heights;
    });
}

describe('VoxelNavMesh multilayer chunks', () => {
    test('findPath from lower to upper floor traverses the stair', () => {
        const nav = buildTwoFloorNav();
        const path = nav.findPath(LOWER, UPPER, undefined, BUDGET_M);
        expect(path.length).toBeGreaterThan(0);

        const maxY = Math.max(...path.map(p => p.y));
        expect(maxY).toBeCloseTo(6, 0); // reached the upper layer

        // The route climbs: at least one waypoint stands on a tread between
        // the floors. (String-pulling collapses the straight stair run into
        // one segment, so consecutive waypoints are NOT one riser apart.)
        expect(path.some(p => p.y > 0.1 && p.y < 5.9)).toBe(true);

        // Every waypoint stands on a real layer of its own cell.
        for (const p of path) {
            expect(nav.getGroundHeight(p.x, p.z, p.y)).toBeCloseTo(p.y);
        }
    });

    test('the floors are unreachable from each other without the stair', () => {
        const nav = buildTwoFloorNav({ stair: false });
        expect(nav.findPath(LOWER, UPPER, undefined, BUDGET_M)).toEqual([]);

        // Each floor is still internally connected.
        const sameFloor = nav.findPath(LOWER, new THREE.Vector3(1.5, TWO_FLOOR.lowerY, 1.5), undefined, BUDGET_M);
        expect(sameFloor.length).toBeGreaterThan(0);
        expect(Math.max(...sameFloor.map(p => p.y))).toBeCloseTo(0);
    });

    test('a cross-floor path is found with the default path-length budget', () => {
        const nav = buildTwoFloorNav();
        const path = nav.findPath(LOWER, UPPER);
        expect(path.length).toBeGreaterThan(0);
        expect(Math.max(...path.map(p => p.y))).toBeCloseTo(6, 0);
    });

    test('string-pulling cannot collapse a cross-layer route into a vertical jump', () => {
        const nav = buildWalkwayNav();
        const path = nav.findPath(RAMP_START, RAMP_END, undefined, 200);
        expect(path.length).toBeGreaterThan(0);

        // The route must actually visit the ramp — it is the only connection.
        expect(path.some(p => p.distanceTo(RAMP_CELL) <= 0.3)).toBe(true);

        // With a single ramp cell there is no monotonic run to string-pull, so
        // every smoothed segment must respect the climb limit.
        for (let i = 1; i < path.length; i++) {
            expect(Math.abs(path[i]!.y - path[i - 1]!.y)).toBeLessThanOrEqual(TWO_FLOOR.maxClimbM + 1e-6);
        }
    });

    test('the walkway is unreachable once the ramp cell is removed', () => {
        expect(buildWalkwayNav({ ramp: false }).findPath(RAMP_START, RAMP_END, undefined, 200)).toEqual([]);
    });

    test('getGroundHeight snaps to the layer nearest refY', () => {
        const nav = buildTwoFloorNav();
        expect(nav.getGroundHeight(6.5, 6.5, 0.5)).toBeCloseTo(0);
        expect(nav.getGroundHeight(6.5, 6.5, 5.5)).toBeCloseTo(6);
        expect(nav.getGroundHeight(6.5, 6.5)).toBeCloseTo(6); // no refY = topmost (legacy)
    });

    test('an obstacle with y blocks only the nearest layer', () => {
        const nav = buildTwoFloorNav();
        nav.addObstacle({ kind: 'circle', x: 6.5, z: 6.5, radius: 0.5, y: 0 });
        expect(nav.isWalkableAt(6.5, 6.5, 0)).toBe(false);
        expect(nav.isWalkableAt(6.5, 6.5, 6)).toBe(true);
    });

    test('an obstacle without y blocks every layer', () => {
        const nav = buildTwoFloorNav();
        nav.addObstacle({ kind: 'circle', x: 6.5, z: 6.5, radius: 0.5 });
        expect(nav.isWalkableAt(6.5, 6.5, 0)).toBe(false);
        expect(nav.isWalkableAt(6.5, 6.5, 6)).toBe(false);
    });

    test('step limits come from the header, not the delta quantization unit', () => {
        const nav = buildTwoFloorNav();
        expect(nav.getStepLimits()).toEqual({ maxClimbUp: 1, maxDropDown: 2 });
        // A 0.75 m riser is climbable; it would not be at a 0.125 m limit.
        expect(nav.canStepCells(0, 4, 0, 3, TWO_FLOOR.lowerY)).toBe(true);
        // Two floors apart is not, in either direction.
        expect(nav.canStepCells(6, 5, 6, 4, TWO_FLOOR.lowerY)).toBe(true);
        expect(nav.getCellGroundY(6, 4, TWO_FLOOR.upperY)).toBeCloseTo(6);
        expect(nav.getCellGroundY(6, 4, TWO_FLOOR.lowerY)).toBeCloseTo(0);
    });
});

describe('VoxelNavMesh single-layer parity', () => {
    test('single-layer worlds behave exactly as before', () => {
        const built = new VoxelNavMesh();
        built.buildFromVoxelWorld(mockVoxelWorld, -16, 16, -16, 16, { cellSize: 1 });
        const restored = new VoxelNavMesh();
        restored.buildFromSerialized(toArrayBuffer(built.serialize()));

        expect(restored.isReady()).toBe(true);
        expect(restored.getGridInfo()).toEqual(built.getGridInfo());
        expect(restored.getStepLimits()).toEqual(built.getStepLimits());

        // getGroundHeight without refY is unchanged.
        expect(built.getGroundHeight(2.5, 3.5)).toBe(1);
        expect(restored.getGroundHeight(2.5, 3.5)).toBe(1);

        // Identical paths.
        const a = new THREE.Vector3(-6.5, 1, -6.5);
        const b = new THREE.Vector3(7.5, 1, 7.5);
        const expected = built.findPath(a, b);
        expect(expected.length).toBeGreaterThan(0);
        expect(restored.findPath(a, b).map(p => p.toArray())).toEqual(expected.map(p => p.toArray()));

        // Obstacles without y behave identically.
        const centre = new THREE.Vector3(0, 1, 0);
        built.addObstacle({ kind: 'circle', x: 0, z: 0, radius: 1 });
        restored.addObstacle({ kind: 'circle', x: 0, z: 0, radius: 1 });
        expect(built.isValidNavigationTarget(centre)).toBe(false);
        expect(restored.isValidNavigationTarget(centre)).toBe(false);
        expect(restored.isWalkableAt(6, 6)).toBe(true);
        expect(restored.findNearestValidTarget(centre)?.toArray()).toEqual(
            built.findNearestValidTarget(centre)?.toArray(),
        );
    });
});
