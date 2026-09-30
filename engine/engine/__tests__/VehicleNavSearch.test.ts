import {
    findVehiclePathOnGrid, hasLineOfSight, supercoverLine, smoothRouteCorners,
    MAX_LEG_M, CORNER_RADIUS_M,
} from 'engine/nav/VehicleNavSearch.js';
import {
    VehicleNavGrid, DEFAULT_VEHICLE_NAV_QUERY_OPTIONS,
    type VehicleNavQueryOptions, type NavPoint,
} from 'engine/nav/VehicleNavGrid.js';

// isolatedModules quirk: a missing export imports as `undefined` instead of
// throwing at import time. Make the first assertion loud so a typo'd export
// name fails here, not several tests later with a confusing TypeError.
it('exports findVehiclePathOnGrid as a function', () => {
    expect(typeof findVehiclePathOnGrid).toBe('function');
});

const OPTS: VehicleNavQueryOptions = DEFAULT_VEHICLE_NAV_QUERY_OPTIONS;

function makeGrid(width: number, height: number, cellSize = 1): VehicleNavGrid {
    return new VehicleNavGrid({ cellSize, width, height, minX: 0, minZ: 0 });
}

/** Paves an inclusive rectangle of cells with a flat ground height and material cost. */
function paveRect(
    grid: VehicleNavGrid, gx0: number, gz0: number, gx1: number, gz1: number, cost: number, y: number,
): void {
    for (let gx = gx0; gx <= gx1; gx++) {
        for (let gz = gz0; gz <= gz1; gz++) {
            grid.setCost(gx, gz, cost);
            grid.setGroundY(gx, gz, y);
        }
    }
}

function distanceOf(a: NavPoint, b: NavPoint): number {
    return Math.hypot(a.x - b.x, a.z - b.z);
}

function legLengths(points: NavPoint[]): number[] {
    const lengths: number[] = [];
    for (let i = 1; i < points.length; i++) {
        lengths.push(distanceOf(points[i - 1]!, points[i]!));
    }
    return lengths;
}

/** No leg of a returned route may exceed the re-densify cap. */
function expectLegsWithinCap(points: NavPoint[]): void {
    for (const len of legLengths(points)) {
        expect(len).toBeLessThanOrEqual(MAX_LEG_M + 1e-6);
    }
}

/** Closest any point of `points` comes to `target`. */
function nearestDistanceTo(points: NavPoint[], target: NavPoint): number {
    return Math.min(...points.map((p) => distanceOf(p, target)));
}

/** Every emitted segment must satisfy the same rule string-pulling obeys. */
function everySegmentLegal(grid: VehicleNavGrid, points: NavPoint[]): boolean {
    for (let i = 0; i < points.length - 1; i++) {
        const a = grid.worldToCell(points[i]!.x, points[i]!.z);
        const b = grid.worldToCell(points[i + 1]!.x, points[i + 1]!.z);
        if (a === null || b === null) return false;
        if (!hasLineOfSight(grid, a, b, OPTS)) return false;
    }
    return true;
}

describe('findVehiclePathOnGrid', () => {
    it('1. straight flat road: reaches destination, shortfall 0, few points, no leg over MAX_LEG_M', () => {
        const grid = makeGrid(30, 5);
        paveRect(grid, 0, 2, 29, 2, 1, 0);
        const from = grid.cellToWorld(0, 2);
        const to = grid.cellToWorld(29, 2);

        const result = findVehiclePathOnGrid(grid, from, to, OPTS);

        expect(result.reachedDestination).toBe(true);
        expect(result.shortfall).toBe(0);
        expect(result.points.length).toBeLessThanOrEqual(5);
        expectLegsWithinCap(result.points);
    });

    it('2. wall with a gap: path passes near the gap', () => {
        const grid = makeGrid(10, 5);
        // Full field, minus a wall row at gz=2 that is entirely blocked except
        // for a single paved gap cell at gx=5.
        paveRect(grid, 0, 0, 9, 1, 1, 0);
        paveRect(grid, 0, 3, 9, 4, 1, 0);
        grid.setCost(5, 2, 1);
        grid.setGroundY(5, 2, 0);

        const from = grid.cellToWorld(0, 0);
        const to = grid.cellToWorld(9, 4);
        const result = findVehiclePathOnGrid(grid, from, to, OPTS);

        expect(result.reachedDestination).toBe(true);
        const gap = grid.cellToWorld(5, 2);
        const nearGap = result.points.some((p) => Math.abs(p.x - gap.x) < 1.5 && Math.abs(p.z - gap.z) < 1.5);
        expect(nearGap).toBe(true);
    });

    it('3. kerb across a road mid-corridor: detours via the ramp row without the midpoint', () => {
        const grid = makeGrid(10, 5);
        paveRect(grid, 0, 0, 9, 4, 1, 0);
        const KERB_Y = 5; // far above maxStepHeight; guarantees a 'step' verdict regardless of grade cap
        // Kerb across the col4/col5 boundary for rows 0-3 (both the straight
        // and diagonal edges), leaving row 4 as the only smooth crossing.
        for (let gz = 0; gz <= 3; gz++) {
            grid.setEdgeMidpointY(grid.index(4, gz), grid.index(5, gz), KERB_Y);
        }
        for (let gz = 0; gz <= 2; gz++) {
            grid.setEdgeMidpointY(grid.index(4, gz), grid.index(5, gz + 1), KERB_Y);
            grid.setEdgeMidpointY(grid.index(4, gz + 1), grid.index(5, gz), KERB_Y);
        }

        const from = grid.cellToWorld(0, 1);
        const to = grid.cellToWorld(9, 1);
        const result = findVehiclePathOnGrid(grid, from, to, OPTS);

        expect(result.reachedDestination).toBe(true);
        // A straight run would stay at row1's world z the whole way; a real
        // detour must visit a point substantially closer to row4 (the opening).
        const rampZ = grid.cellToWorld(0, 4).z;
        const visitedRamp = result.points.some((p) => Math.abs(p.z - rampZ) < 1.5);
        expect(visitedRamp).toBe(true);
    });

    it('4. cost preference: prefers the asphalt lane over a costlier parallel sidewalk', () => {
        const grid = makeGrid(10, 3);
        paveRect(grid, 0, 0, 9, 0, 1, 0);     // asphalt lane, row 0
        paveRect(grid, 0, 2, 9, 2, 3.5, 0);   // sidewalk lane, row 2
        // Row 1 is a buffer, paved only at the two junction columns.
        grid.setCost(0, 1, 1); grid.setGroundY(0, 1, 0);
        grid.setCost(9, 1, 1); grid.setGroundY(9, 1, 0);

        const from = grid.cellToWorld(0, 1);
        const to = grid.cellToWorld(9, 1);
        const result = findVehiclePathOnGrid(grid, from, to, OPTS);

        expect(result.reachedDestination).toBe(true);
        const asphaltZ = grid.cellToWorld(0, 0).z;
        const midPoints = result.points.slice(1, -1);
        expect(midPoints.length).toBeGreaterThan(0);
        for (const p of midPoints) {
            expect(Math.abs(p.z - asphaltZ)).toBeLessThan(0.5);
        }
    });

    it('5. clearance: a 3-cell-wide road with blocked borders keeps mid-path points on the centre row', () => {
        const grid = makeGrid(12, 3);
        paveRect(grid, 0, 0, 11, 2, 1, 0);
        // Rows 0 and 2 are adjacent to out-of-bounds rows (-1 and 3); row 1 is not.

        const from = grid.cellToWorld(0, 1);
        const to = grid.cellToWorld(11, 1);
        const result = findVehiclePathOnGrid(grid, from, to, OPTS);

        expect(result.reachedDestination).toBe(true);
        const centreZ = grid.cellToWorld(0, 1).z;
        for (const p of result.points) {
            expect(Math.abs(p.z - centreZ)).toBeLessThan(0.5);
        }
    });

    it('6. unreachable island destination: closest-reachable approach, positive shortfall', () => {
        const grid = makeGrid(10, 3);
        paveRect(grid, 0, 0, 3, 2, 1, 0);  // main region
        paveRect(grid, 6, 0, 9, 2, 1, 0);  // island — cols 4-5 are an unpaved gap, wider than one diagonal step
        const from = grid.cellToWorld(0, 1);
        const to = grid.cellToWorld(9, 1);

        const result = findVehiclePathOnGrid(grid, from, to, OPTS);

        expect(result.reachedDestination).toBe(false);
        expect(result.shortfall).toBeGreaterThan(0);
        expect(result.points.length).toBeGreaterThan(0);
        const last = result.points[result.points.length - 1]!;
        // Closest approach should be on the main region's near edge (gx <= 3).
        expect(last.x).toBeLessThanOrEqual(grid.cellToWorld(3, 1).x + 0.5);
    });

    it('7. string-pull legality: no leg of an L-shaped corridor crosses the blocked block', () => {
        const grid = makeGrid(8, 8);
        paveRect(grid, 0, 0, 7, 1, 1, 0); // bottom horizontal corridor
        paveRect(grid, 6, 0, 7, 7, 1, 0); // right vertical corridor
        // Interior (cols 2-5, rows 2-7) stays unpaved/blocked.

        const from = grid.cellToWorld(0, 0);
        const to = grid.cellToWorld(7, 7);
        const result = findVehiclePathOnGrid(grid, from, to, OPTS);

        expect(result.reachedDestination).toBe(true);
        expect(everySegmentLegal(grid, result.points)).toBe(true);
    });

    it('8. long straight road (>60m): no leg exceeds MAX_LEG_M', () => {
        const grid = makeGrid(65, 1);
        paveRect(grid, 0, 0, 64, 0, 1, 0);
        const from = grid.cellToWorld(0, 0);
        const to = grid.cellToWorld(64, 0);

        const result = findVehiclePathOnGrid(grid, from, to, OPTS);

        expect(result.reachedDestination).toBe(true);
        expect(distanceOf(from, to)).toBeGreaterThan(60);
        expectLegsWithinCap(result.points);
    });

    it('9. start on a blocked cell adjacent to road: snaps and succeeds', () => {
        const grid = makeGrid(8, 3);
        paveRect(grid, 0, 1, 7, 1, 1, 0); // road on row 1 only; rows 0 and 2 stay blocked
        const from = grid.cellToWorld(2, 0); // blocked cell, adjacent to the road
        const to = grid.cellToWorld(6, 1);

        const result = findVehiclePathOnGrid(grid, from, to, OPTS);

        expect(result.reachedDestination).toBe(true);
        expect(result.points.length).toBeGreaterThan(0);
    });

    it('10. start deep inside a fully blocked region (beyond SNAP_RADIUS_M): empty, unreached', () => {
        const grid = makeGrid(40, 40);
        paveRect(grid, 0, 0, 2, 2, 1, 0); // tiny paved patch in the corner
        const from = grid.cellToWorld(35, 35); // far from any drivable cell
        const to = grid.cellToWorld(1, 1);

        const result = findVehiclePathOnGrid(grid, from, to, OPTS);

        expect(result.points).toEqual([]);
        expect(result.reachedDestination).toBe(false);
        expect(result.method).toBe('no drivable cell within 16m of start');
        expect(result.shortfall).toBeCloseTo(distanceOf(from, to), 5);
    });

    it('11. grid.findVehiclePath delegates, defaults opts, and provisional tracks bake status', () => {
        const grid = makeGrid(5, 5);
        paveRect(grid, 0, 0, 4, 4, 1, 0);
        const from = grid.cellToWorld(0, 0);
        const to = grid.cellToWorld(4, 4);

        const before = grid.findVehiclePath(from, to);
        expect(before.provisional).toBe(true);
        expect(before.method.length).toBeGreaterThan(0);

        grid.markFullyBaked();
        const after = grid.findVehiclePath(from, to);
        expect(after.provisional).toBe(false);
    });

    it('12. MAX_EXPANSIONS cap / unreachable goal on a tiny grid terminates without hanging', () => {
        const grid = makeGrid(4, 3);
        paveRect(grid, 0, 0, 0, 2, 1, 0); // isolated start column
        paveRect(grid, 3, 0, 3, 2, 1, 0); // isolated goal column — cols 1-2 stay unpaved
        const from = grid.cellToWorld(0, 1);
        const to = grid.cellToWorld(3, 1);

        const result = findVehiclePathOnGrid(grid, from, to, OPTS);

        expect(result.reachedDestination).toBe(false);
        expect(result.points.length).toBeGreaterThan(0);
    });
});

describe('supercoverLine', () => {
    it('walks a straight axis-aligned run', () => {
        const cells = supercoverLine(0, 0, 3, 0);
        expect(cells).toEqual([{ gx: 0, gz: 0 }, { gx: 1, gz: 0 }, { gx: 2, gz: 0 }, { gx: 3, gz: 0 }]);
    });

    it('includes both corner cells on an exact 45-degree diagonal', () => {
        const cells = supercoverLine(0, 0, 2, 2);
        // A pure diagonal touches every lattice corner it crosses; the
        // supercover variant must include both orthogonal neighbours at each
        // corner, not just jump straight to the diagonal cell.
        expect(cells).toContainEqual({ gx: 1, gz: 0 });
        expect(cells).toContainEqual({ gx: 0, gz: 1 });
        expect(cells).toContainEqual({ gx: 1, gz: 1 });
        expect(cells).toContainEqual({ gx: 2, gz: 2 });
    });
});

describe('smoothRouteCorners', () => {
    /** Largest heading change (rad) at any single vertex of a polyline. */
    function sharpestVertex(points: NavPoint[]): number {
        let worst = 0;
        for (let i = 1; i < points.length - 1; i++) {
            const a = points[i - 1]!, b = points[i]!, c = points[i + 1]!;
            const h1 = Math.atan2(b.x - a.x, b.z - a.z);
            const h2 = Math.atan2(c.x - b.x, c.z - b.z);
            let dh = h2 - h1;
            while (dh > Math.PI) dh -= Math.PI * 2;
            while (dh < -Math.PI) dh += Math.PI * 2;
            worst = Math.max(worst, Math.abs(dh));
        }
        return worst;
    }

    it('leaves a straight route exactly as it found it', () => {
        const grid = makeGrid(40, 40);
        paveRect(grid, 0, 0, 39, 39, 1, 0);
        const straight = [{ x: 0.5, z: 0.5 }, { x: 0.5, z: 20.5 }, { x: 0.5, z: 39.5 }];

        expect(smoothRouteCorners(grid, straight, OPTS)).toEqual(straight);
    });

    it('rounds a right-angle corner on an open field, keeping the endpoints and every segment legal', () => {
        const grid = makeGrid(60, 60);
        paveRect(grid, 0, 0, 59, 59, 1, 0);
        const corner = [{ x: 30.5, z: 0.5 }, { x: 30.5, z: 30.5 }, { x: 59.5, z: 30.5 }];

        const smoothed = smoothRouteCorners(grid, corner, OPTS);

        expect(smoothed[0]).toEqual(corner[0]);
        expect(smoothed[smoothed.length - 1]).toEqual(corner[2]);
        expect(smoothed.length).toBeGreaterThan(corner.length);
        expect(everySegmentLegal(grid, smoothed)).toBe(true);
        // A 90 degree kink becomes an arc: no single vertex may still carry
        // anything like the whole turn.
        expect(sharpestVertex(corner)).toBeCloseTo(Math.PI / 2, 5);
        expect(sharpestVertex(smoothed)).toBeLessThan(0.3);
    });

    it('rounds to the requested radius when the field allows it', () => {
        const grid = makeGrid(60, 60);
        paveRect(grid, 0, 0, 59, 59, 1, 0);
        const corner = [{ x: 30.5, z: 0.5 }, { x: 30.5, z: 30.5 }, { x: 59.5, z: 30.5 }];

        const smoothed = smoothRouteCorners(grid, corner, OPTS);

        // The arc's closest approach to the sharp vertex is r * (sec(turn/2) - 1),
        // which for a right angle is r * (sqrt(2) - 1).
        expect(nearestDistanceTo(smoothed, corner[1]!)).toBeCloseTo(CORNER_RADIUS_M * (Math.SQRT2 - 1), 1);
    });

    it('keeps the sharp vertex rather than cutting a corner the grid does not allow', () => {
        // An L-shaped corridor exactly one cell wide: there is no room at all
        // for an arc, so the corner has to survive unrounded.
        const grid = makeGrid(40, 40);
        paveRect(grid, 20, 0, 20, 20, 1, 0);
        paveRect(grid, 20, 20, 39, 20, 1, 0);
        const corner = [
            grid.cellToWorld(20, 0), grid.cellToWorld(20, 20), grid.cellToWorld(39, 20),
        ];

        const smoothed = smoothRouteCorners(grid, corner, OPTS);

        expect(smoothed).toEqual(corner);
    });

    it('shrinks the radius instead of giving up when only a small arc fits', () => {
        // A corridor five cells wide: an 8 m arc would leave the road, a small
        // one fits. The corner must come back rounded, but by less than the
        // open-field arc would have cut.
        const grid = makeGrid(60, 60);
        paveRect(grid, 28, 0, 32, 32, 1, 0);
        paveRect(grid, 28, 28, 59, 32, 1, 0);
        const corner = [
            grid.cellToWorld(30, 0), grid.cellToWorld(30, 30), grid.cellToWorld(59, 30),
        ];

        const smoothed = smoothRouteCorners(grid, corner, OPTS);

        expect(smoothed.length).toBeGreaterThan(corner.length);
        expect(everySegmentLegal(grid, smoothed)).toBe(true);
        expect(nearestDistanceTo(smoothed, corner[1]!)).toBeLessThan(CORNER_RADIUS_M * (Math.SQRT2 - 1));
    });

    it('is what findVehiclePathOnGrid returns: an L-route comes back rounded and still capped at MAX_LEG_M', () => {
        const grid = makeGrid(60, 60);
        paveRect(grid, 0, 0, 59, 59, 1, 0);
        const from = grid.cellToWorld(30, 0);
        const to = grid.cellToWorld(59, 30);
        // A wall that forces the route around the corner rather than diagonally.
        paveRect(grid, 31, 0, 59, 29, 0, 0);

        const result = findVehiclePathOnGrid(grid, from, to, OPTS);

        expect(result.reachedDestination).toBe(true);
        expect(sharpestVertex(result.points)).toBeLessThan(0.5);
        expectLegsWithinCap(result.points);
        expect(result.method).toContain('corner-smoothed');
    });
});
