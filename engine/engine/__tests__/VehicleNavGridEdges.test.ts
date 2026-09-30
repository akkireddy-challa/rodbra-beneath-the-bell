import {
    VehicleNavGrid,
    evaluateGridEdge,
    queryOptionsForVehicle,
    setGlobalVehicleNav,
    getGlobalVehicleNav,
    DEFAULT_VEHICLE_NAV_QUERY_OPTIONS,
    CELL_VALIDATED,
    CELL_PROP_BLOCKED,
    type VehicleNavQueryOptions,
    type VehicleNav,
    type VehicleCapabilitySource,
    type NavPoint,
    type VehicleNavPath,
} from 'engine/nav/VehicleNavGrid.js';

// isolatedModules quirk: a missing export imports as `undefined` instead of
// throwing at import time. Make the first assertion loud so a typo'd export
// name fails here, not three tests later with a confusing TypeError.
it('exports evaluateGridEdge as a function', () => {
    expect(typeof evaluateGridEdge).toBe('function');
});

/** Small flat grid: 4x4 cells, cellSize 1, min corner at world origin. */
function makeGrid(): VehicleNavGrid {
    return new VehicleNavGrid({ cellSize: 1, width: 4, height: 4, minX: 0, minZ: 0 });
}

/** Mark a cell drivable with a given ground height. */
function paveCell(grid: VehicleNavGrid, gx: number, gz: number, y: number): void {
    grid.setCost(gx, gz, 1);
    grid.setGroundY(gx, gz, y);
}

/** Mark a cell drivable AND collider-validated — the fully-baked state, which
 *  most tests below want. The lateral clearance rule deliberately does NOT
 *  require CELL_VALIDATED (see `lateralStepAt`); the provisional-window tests
 *  use bare `paveCell` to pin that. */
function paveValidatedCell(grid: VehicleNavGrid, gx: number, gz: number, y: number): void {
    paveCell(grid, gx, gz, y);
    grid.setFlags(gx, gz, CELL_VALIDATED);
}

/** Pave and validate every cell of a `makeGrid()` grid, rising `risePerCell`
 *  metres per cell along +X — so 0 gives flat ground at height 10. */
function paveXSlope(grid: VehicleNavGrid, risePerCell: number): void {
    for (let gx = 0; gx < 4; gx++) {
        for (let gz = 0; gz < 4; gz++) paveValidatedCell(grid, gx, gz, 10 + gx * risePerCell);
    }
}

const OPTS: VehicleNavQueryOptions = DEFAULT_VEHICLE_NAV_QUERY_OPTIONS;

describe('VehicleNavGrid cell API', () => {
    it('round-trips worldToCell/cellToWorld and returns null out of bounds', () => {
        const grid = new VehicleNavGrid({ cellSize: 2, width: 4, height: 4, minX: -4, minZ: -4 });
        // Cell (0,0) spans world x [-4,-2), z [-4,-2); centre is (-3,-3).
        const centre = grid.cellToWorld(0, 0);
        expect(centre).toEqual({ x: -3, z: -3 });

        const back = grid.worldToCell(centre.x, centre.z);
        expect(back).toEqual({ gx: 0, gz: 0 });

        // Cell (3,3) spans x [2,4), z [2,4); centre (3,3).
        const lastCentre = grid.cellToWorld(3, 3);
        expect(lastCentre).toEqual({ x: 3, z: 3 });
        expect(grid.worldToCell(3, 3)).toEqual({ gx: 3, gz: 3 });

        // Outside the grid on every side.
        expect(grid.worldToCell(-100, -100)).toBeNull();
        expect(grid.worldToCell(100, 100)).toBeNull();
        expect(grid.worldToCell(0, -100)).toBeNull();
    });

    it('reports inBounds correctly at the edges', () => {
        const grid = makeGrid();
        expect(grid.inBounds(0, 0)).toBe(true);
        expect(grid.inBounds(3, 3)).toBe(true);
        expect(grid.inBounds(-1, 0)).toBe(false);
        expect(grid.inBounds(4, 0)).toBe(false);
        expect(grid.inBounds(0, 4)).toBe(false);
    });

    it('starts with cost 0 (blocked) and groundY NaN (unknown) everywhere', () => {
        const grid = makeGrid();
        expect(grid.getCost(1, 1)).toBe(0);
        expect(Number.isNaN(grid.getGroundY(1, 1))).toBe(true);
        expect(grid.getFlags(1, 1)).toBe(0);
    });

    it('get/set cost, groundY and flags round-trip', () => {
        const grid = makeGrid();
        grid.setCost(2, 1, 3.5);
        grid.setGroundY(2, 1, 12.25);
        grid.setFlags(2, 1, CELL_VALIDATED | CELL_PROP_BLOCKED);
        expect(grid.getCost(2, 1)).toBe(3.5);
        expect(grid.getGroundY(2, 1)).toBe(12.25);
        expect(grid.getFlags(2, 1)).toBe(CELL_VALIDATED | CELL_PROP_BLOCKED);
    });

    it('get/set edge midpoint heights round-trip and are absent by default', () => {
        const grid = makeGrid();
        const a = grid.index(0, 0);
        const b = grid.index(1, 0);
        expect(grid.getEdgeMidpointY(a, b)).toBeNull();
        grid.setEdgeMidpointY(a, b, 10.5);
        expect(grid.getEdgeMidpointY(a, b)).toBe(10.5);
        // Order-independent: the same edge, addressed either way.
        expect(grid.getEdgeMidpointY(b, a)).toBe(10.5);
    });

    it('tracks fully-baked and revision lifecycle', () => {
        const grid = makeGrid();
        expect(grid.isFullyBaked()).toBe(false);
        expect(grid.getRevision()).toBe(1);

        grid.bumpRevision();
        expect(grid.getRevision()).toBe(2);
        expect(grid.isFullyBaked()).toBe(false);

        grid.markFullyBaked();
        expect(grid.isFullyBaked()).toBe(true);
        expect(grid.getRevision()).toBe(3);
    });
});

describe('evaluateGridEdge', () => {
    it('passes a flat road (same groundY, both cells drivable)', () => {
        const grid = makeGrid();
        paveCell(grid, 0, 0, 10);
        paveCell(grid, 1, 0, 10);
        const result = evaluateGridEdge(grid, 0, 0, 1, 0, OPTS);
        expect(result).toEqual({ passable: true, reason: 'clear' });
    });

    it('kerb blocks both ways: a stored midpoint reveals a step a smoothed edge would hide', () => {
        const grid = makeGrid();
        paveCell(grid, 0, 0, 10);
        paveCell(grid, 1, 0, 10.34);
        const a = grid.index(0, 0);
        const b = grid.index(1, 0);
        // Full 0.34 m rise concentrated in the first half of the edge — a kerb
        // profile, not a ramp.
        grid.setEdgeMidpointY(a, b, 10.34);

        const forward = evaluateGridEdge(grid, 0, 0, 1, 0, OPTS);
        expect(forward.passable).toBe(false);
        expect(forward.reason).toBe('step');

        const backward = evaluateGridEdge(grid, 1, 0, 0, 0, OPTS);
        expect(backward.passable).toBe(false);
        expect(backward.reason).toBe('step');
    });

    it('ramp passes without a midpoint; the SAME endpoints with a kerb-profile midpoint fail', () => {
        const grid = makeGrid();
        paveCell(grid, 0, 0, 10);
        paveCell(grid, 1, 0, 10.25);

        // No midpoint: grade 0.25 over 1 m is under the 0.30 cap.
        const smooth = evaluateGridEdge(grid, 0, 0, 1, 0, OPTS);
        expect(smooth).toEqual({ passable: true, reason: 'clear' });

        // Same endpoints, but a midpoint says the full 0.25 m rise happens in
        // the first 0.5 m: rise 0.25 > maxStepHeight 0.14 over run 0.5 — step
        // rule fires even though the overall grade is unchanged.
        const a = grid.index(0, 0);
        const b = grid.index(1, 0);
        grid.setEdgeMidpointY(a, b, 10.25);
        const kerbed = evaluateGridEdge(grid, 0, 0, 1, 0, OPTS);
        expect(kerbed.passable).toBe(false);
        expect(kerbed.reason).toBe('step');
    });

    it('blocked cell (cost 0) fails as blocked-cell', () => {
        const grid = makeGrid();
        paveCell(grid, 0, 0, 10);
        // (1,0) left at cost 0 (never paved).
        grid.setGroundY(1, 0, 10);
        const result = evaluateGridEdge(grid, 0, 0, 1, 0, OPTS);
        expect(result).toEqual({ passable: false, reason: 'blocked-cell' });
    });

    it('PROP_BLOCKED flag fails as blocked-cell even with valid cost/groundY', () => {
        const grid = makeGrid();
        paveCell(grid, 0, 0, 10);
        paveCell(grid, 1, 0, 10);
        grid.setFlags(1, 0, CELL_PROP_BLOCKED);
        const result = evaluateGridEdge(grid, 0, 0, 1, 0, OPTS);
        expect(result).toEqual({ passable: false, reason: 'blocked-cell' });
    });

    it('unknown height (NaN groundY) fails closed as unknown', () => {
        const grid = makeGrid();
        // Paved (cost set) but never surveyed (groundY left NaN).
        grid.setCost(0, 0, 1);
        grid.setCost(1, 0, 1);
        grid.setGroundY(0, 0, 10);
        // (1,0).groundY stays NaN.
        const result = evaluateGridEdge(grid, 0, 0, 1, 0, OPTS);
        expect(result).toEqual({ passable: false, reason: 'unknown' });
    });

    it('diagonal corner-cut: both orthogonal corners must be drivable', () => {
        const grid = makeGrid();
        // Diagonal from (0,0) to (1,1). Orthogonal corners are (1,0) and (0,1).
        paveCell(grid, 0, 0, 10);
        paveCell(grid, 1, 1, 10);
        paveCell(grid, 0, 1, 10);
        // (1,0) left blocked (cost 0) — the car cannot cut this corner.
        const result = evaluateGridEdge(grid, 0, 0, 1, 1, OPTS);
        expect(result).toEqual({ passable: false, reason: 'blocked-cell' });
    });

    it('diagonal corner-cut: a PROP_BLOCKED corner also blocks the cut', () => {
        const grid = makeGrid();
        paveCell(grid, 0, 0, 10);
        paveCell(grid, 1, 1, 10);
        paveCell(grid, 0, 1, 10);
        paveCell(grid, 1, 0, 10);
        grid.setFlags(1, 0, CELL_PROP_BLOCKED);
        const result = evaluateGridEdge(grid, 0, 0, 1, 1, OPTS);
        expect(result).toEqual({ passable: false, reason: 'blocked-cell' });
    });

    it('diagonal edge with an unsurveyed primary cell reports unknown, even with a blocked corner', () => {
        // Ordering regression: rule 2 (NaN -> 'unknown') must run BEFORE rule 4
        // (diagonal corner -> 'blocked-cell'). 'unknown' means "not surveyed
        // yet, may open once the bake finishes"; 'blocked-cell' means
        // "permanently excluded" — the A* search treats them differently, so
        // an unsurveyed primary cell must win over a blocked corner.
        const grid = makeGrid();
        grid.setCost(0, 0, 1);
        grid.setGroundY(0, 0, 10);
        // (1,1) is paved (cost set) but never surveyed: groundY stays NaN.
        grid.setCost(1, 1, 1);
        paveCell(grid, 0, 1, 10);
        // (1,0) left blocked (cost 0) — would fail the corner-cut rule too,
        // but the NaN check must win first.
        const result = evaluateGridEdge(grid, 0, 0, 1, 1, OPTS);
        expect(result).toEqual({ passable: false, reason: 'unknown' });
    });

    it('diagonal edge passes when both cells and both orthogonal corners are clear', () => {
        const grid = makeGrid();
        paveCell(grid, 0, 0, 10);
        paveCell(grid, 1, 1, 10);
        paveCell(grid, 0, 1, 10);
        paveCell(grid, 1, 0, 10);
        const result = evaluateGridEdge(grid, 0, 0, 1, 1, OPTS);
        expect(result).toEqual({ passable: true, reason: 'clear' });
    });

    it('per-vehicle opts change the verdict without a rebake: same kerb, different maxStepHeight', () => {
        const grid = makeGrid();
        paveCell(grid, 0, 0, 10);
        paveCell(grid, 1, 0, 10.2);
        const a = grid.index(0, 0);
        const b = grid.index(1, 0);
        grid.setEdgeMidpointY(a, b, 10.2);

        // maxClimbGrade pinned permissive on both, mirroring
        // vehicleTraversability.test.ts's "rejects a step even when the climb
        // grade is absurdly permissive": with a 0.2 m rise over the 0.5 m
        // midpoint half-run the raw grade is 0.4, which would itself exceed
        // the DEFAULT 0.30 climb cap regardless of wheel size. Pinning the
        // grade cap high isolates the one thing this test is about — that
        // maxStepHeight alone flips the verdict.
        const carOpts: VehicleNavQueryOptions = {
            ...DEFAULT_VEHICLE_NAV_QUERY_OPTIONS, maxClimbGrade: 10, maxStepHeight: 0.14,
        };
        const monsterTruckOpts: VehicleNavQueryOptions = {
            ...DEFAULT_VEHICLE_NAV_QUERY_OPTIONS, maxClimbGrade: 10, maxStepHeight: 0.28,
        };

        const carResult = evaluateGridEdge(grid, 0, 0, 1, 0, carOpts);
        expect(carResult.passable).toBe(false);
        expect(carResult.reason).toBe('step');

        const truckResult = evaluateGridEdge(grid, 0, 0, 1, 0, monsterTruckOpts);
        expect(truckResult).toEqual({ passable: true, reason: 'clear' });
    });

    it('either cell out of bounds fails as blocked-cell', () => {
        const grid = makeGrid();
        paveCell(grid, 0, 0, 10);
        const result = evaluateGridEdge(grid, 0, 0, 10, 10, OPTS);
        expect(result).toEqual({ passable: false, reason: 'blocked-cell' });
    });
});

describe('evaluateGridEdge lateral clearance rule (kerb inside the footprint)', () => {
    // Edge (1,1)->(2,1): a horizontal (X) edge, so the perpendicular lateral
    // cells are the Z-neighbours of each endpoint: (1,0)/(1,2) for the FROM
    // cell (1,1), and (2,0)/(2,2) for the TO cell (2,1).
    it('a kerb-top lateral cell (+0.3 m) blocks the edge with `narrow` in both directions', () => {
        const grid = makeGrid();
        paveValidatedCell(grid, 1, 1, 10);
        paveValidatedCell(grid, 2, 1, 10);
        // One lateral cell, one side of the FROM endpoint, is a 0.3 m kerb —
        // above DEFAULT_VEHICLE_NAV_QUERY_OPTIONS.maxStepHeight (0.14).
        paveValidatedCell(grid, 1, 2, 10.3);

        const forward = evaluateGridEdge(grid, 1, 1, 2, 1, OPTS);
        expect(forward).toEqual({ passable: false, reason: 'narrow' });

        const backward = evaluateGridEdge(grid, 2, 1, 1, 1, OPTS);
        expect(backward).toEqual({ passable: false, reason: 'narrow' });
    });

    it('a flat lateral cell (same height) passes', () => {
        const grid = makeGrid();
        paveValidatedCell(grid, 1, 1, 10);
        paveValidatedCell(grid, 2, 1, 10);
        paveValidatedCell(grid, 1, 0, 10);
        paveValidatedCell(grid, 1, 2, 10);
        paveValidatedCell(grid, 2, 0, 10);
        paveValidatedCell(grid, 2, 2, 10);

        const result = evaluateGridEdge(grid, 1, 1, 2, 1, OPTS);
        expect(result).toEqual({ passable: true, reason: 'clear' });
    });

    it('a NaN-height lateral cell (validated but resolved closed) is ignored, not treated as a step', () => {
        const grid = makeGrid();
        paveValidatedCell(grid, 1, 1, 10);
        paveValidatedCell(grid, 2, 1, 10);
        // A validated but non-drivable ('closed') cell: cost 0, groundY NaN.
        grid.setCost(1, 2, 0);
        grid.setGroundY(1, 2, NaN);
        grid.setFlags(1, 2, CELL_VALIDATED);

        const result = evaluateGridEdge(grid, 1, 1, 2, 1, OPTS);
        expect(result).toEqual({ passable: true, reason: 'clear' });
    });

    it('an UNVALIDATED lateral cell with a mask-seeded kerb height still blocks (provisional grid)', () => {
        // Regression for the (152.5, 166-176) corridor: a route planned
        // BEFORE the collider bake finishes must see the same lateral kerb a
        // fully-baked grid would — the lateral rule reads groundY, which
        // seedFromMask already fills in for every cell, not CELL_VALIDATED,
        // which only the (much later) collider pass sets.
        const grid = makeGrid();
        paveCell(grid, 1, 1, 10); // endpoints are also unvalidated here —
        paveCell(grid, 2, 1, 10); // realistic for a pre-bake provisional query
        // Kerb height present, no CELL_VALIDATED flag anywhere — exactly what
        // seedFromMask alone produces before the collider pass ever runs.
        paveCell(grid, 1, 2, 10.3);

        const result = evaluateGridEdge(grid, 1, 1, 2, 1, OPTS);
        expect(result).toEqual({ passable: false, reason: 'narrow' });
    });

    it('a NaN-height lateral cell is still ignored even when unvalidated (no data beats no verdict)', () => {
        const grid = makeGrid();
        paveValidatedCell(grid, 1, 1, 10);
        paveValidatedCell(grid, 2, 1, 10);
        // Never seeded, never baked: cost 0, groundY NaN, flags 0 — the
        // grid's true "no data at all" state, not "not yet validated".
        const result = evaluateGridEdge(grid, 1, 1, 2, 1, OPTS);
        expect(result).toEqual({ passable: true, reason: 'clear' });
    });

    it('a PROP_BLOCKED lateral cell blocks the edge regardless of its (diagnostic) height matching', () => {
        const grid = makeGrid();
        paveValidatedCell(grid, 1, 1, 10);
        paveValidatedCell(grid, 2, 1, 10);
        // Same height as the endpoints (10) — a pure height comparison would
        // wave this through — but PROP_BLOCKED means a real collider (e.g. a
        // streetlight base) sits in this lateral cell's obstruction band, per
        // Fix 2's per-cell obstruction query.
        grid.setCost(1, 2, 1);
        grid.setGroundY(1, 2, 10);
        grid.setFlags(1, 2, CELL_VALIDATED | CELL_PROP_BLOCKED);

        const forward = evaluateGridEdge(grid, 1, 1, 2, 1, OPTS);
        expect(forward).toEqual({ passable: false, reason: 'narrow' });

        const backward = evaluateGridEdge(grid, 2, 1, 1, 1, OPTS);
        expect(backward).toEqual({ passable: false, reason: 'narrow' });
    });

    it('an UNVALIDATED PROP_BLOCKED-flagged lateral cell still blocks (flag alone is sufficient)', () => {
        // PROP_BLOCKED is only ever set by the collider pass in practice, but
        // the rule itself checks the flag bit directly, not VALIDATED — this
        // pins that the two flags are independent gates.
        const grid = makeGrid();
        paveValidatedCell(grid, 1, 1, 10);
        paveValidatedCell(grid, 2, 1, 10);
        grid.setCost(1, 2, 1);
        grid.setGroundY(1, 2, 10);
        grid.setFlags(1, 2, CELL_PROP_BLOCKED); // no CELL_VALIDATED bit

        const result = evaluateGridEdge(grid, 1, 1, 2, 1, OPTS);
        expect(result).toEqual({ passable: false, reason: 'narrow' });
    });

    // The Maple Hollow hillside (game XRTDE8YIJ4GI): a car tacked diagonally
    // up a slope whose fall line ran along X, every edge passing this rule,
    // and wedged. The rule used to collapse a diagonal onto a "dominant axis"
    // and offset along the other one — 45 degrees away from the direction the
    // footprint actually spans — so on that slope it sampled ALONG the contour
    // and measured exactly 0.000 m on all fourteen legs the car could not
    // drive. See docs/superpowers/plans/2026-08-19-vehicle-hillside-wedge.md.
    describe('the perpendicular on DIAGONAL edges', () => {
        it('a cross-slope steeper than maxStepHeight blocks a diagonal edge that climbs it', () => {
            const grid = makeGrid();
            // 0.3 m per cell along X — over the 0.14 m step cap. A diagonal
            // edge across this spans the slope sideways, so the footprint
            // straddles 0.3 m of rise however the edge is oriented.
            paveXSlope(grid, 0.3);

            expect(evaluateGridEdge(grid, 1, 1, 2, 2, OPTS)).toEqual({ passable: false, reason: 'narrow' });
            expect(evaluateGridEdge(grid, 2, 2, 1, 1, OPTS)).toEqual({ passable: false, reason: 'narrow' });
            expect(evaluateGridEdge(grid, 1, 2, 2, 1, OPTS)).toEqual({ passable: false, reason: 'narrow' });
        });

        it('a gentle cross-slope still passes, so the rule has not simply become "no diagonals on a hill"', () => {
            const grid = makeGrid();
            paveXSlope(grid, 0.05); // well under the 0.14 m step cap

            expect(evaluateGridEdge(grid, 1, 1, 2, 2, OPTS)).toEqual({ passable: true, reason: 'clear' });
        });

        it('samples the true perpendicular, not the dominant axis: a kerb on the diagonal normal blocks', () => {
            const grid = makeGrid();
            paveXSlope(grid, 0); // flat everywhere
            // Edge (1,1)->(2,2). Its true normal is the OTHER diagonal, so the
            // lateral cells are (2,1) and (0,3) from the FROM endpoint and
            // (3,1)/(1,3) from the TO endpoint. The old dominant-axis rule
            // looked at (1,0)/(1,2) and (2,1)/(2,3) instead — note it would
            // have caught (2,1) here by luck, so the kerb goes on (1,3), which
            // ONLY the true normal reaches.
            paveValidatedCell(grid, 1, 3, 10.3);

            expect(evaluateGridEdge(grid, 1, 1, 2, 2, OPTS)).toEqual({ passable: false, reason: 'narrow' });
        });

        it('leaves straight edges exactly as they were: the normal IS the axis the old rule picked', () => {
            const grid = makeGrid();
            paveXSlope(grid, 0); // flat everywhere
            // An X edge's normal is Z, a Z edge's normal is X — the same cells
            // the dominant-axis form chose, so a kerb on either still blocks
            // and flat ground still passes.
            expect(evaluateGridEdge(grid, 1, 1, 2, 1, OPTS)).toEqual({ passable: true, reason: 'clear' });
            paveValidatedCell(grid, 1, 2, 10.3);
            expect(evaluateGridEdge(grid, 1, 1, 2, 1, OPTS)).toEqual({ passable: false, reason: 'narrow' });

            const grid2 = makeGrid();
            paveXSlope(grid2, 0);
            expect(evaluateGridEdge(grid2, 1, 1, 1, 2, OPTS)).toEqual({ passable: true, reason: 'clear' });
            paveValidatedCell(grid2, 2, 1, 10.3);
            expect(evaluateGridEdge(grid2, 1, 1, 1, 2, OPTS)).toEqual({ passable: false, reason: 'narrow' });
        });
    });

    it('a 1-cell-wide road walled by +0.3 m kerbs on both sides is fully blocked (footprint does not fit)', () => {
        const grid = makeGrid();
        paveValidatedCell(grid, 1, 1, 10);
        paveValidatedCell(grid, 2, 1, 10);
        paveValidatedCell(grid, 1, 0, 10.3);
        paveValidatedCell(grid, 1, 2, 10.3);
        paveValidatedCell(grid, 2, 0, 10.3);
        paveValidatedCell(grid, 2, 2, 10.3);

        const result = evaluateGridEdge(grid, 1, 1, 2, 1, OPTS);
        expect(result).toEqual({ passable: false, reason: 'narrow' });
    });

    it('a larger maxStepHeight (monster truck) readmits the same kerb-walled edge', () => {
        const grid = makeGrid();
        paveValidatedCell(grid, 1, 1, 10);
        paveValidatedCell(grid, 2, 1, 10);
        paveValidatedCell(grid, 1, 2, 10.3);

        const monsterTruckOpts: VehicleNavQueryOptions = {
            ...DEFAULT_VEHICLE_NAV_QUERY_OPTIONS, maxStepHeight: 0.35,
        };
        const result = evaluateGridEdge(grid, 1, 1, 2, 1, monsterTruckOpts);
        expect(result).toEqual({ passable: true, reason: 'clear' });
    });
});

describe('queryOptionsForVehicle', () => {
    it('maps the three capability getters onto VehicleNavQueryOptions', () => {
        const footprint = { width: 2.5, height: 1.8, length: 5 };
        const vehicle: VehicleCapabilitySource = {
            getFootprint: () => footprint,
            getMaxClimbGrade: () => 0.22,
            getMaxStepHeight: () => 0.19,
        };
        expect(queryOptionsForVehicle(vehicle)).toEqual({
            footprint,
            maxClimbGrade: 0.22,
            maxStepHeight: 0.19,
        });
    });
});

describe('global vehicle nav registry', () => {
    afterEach(() => {
        setGlobalVehicleNav(null);
    });

    it('starts null, and set/get/clear round-trip', () => {
        expect(getGlobalVehicleNav()).toBeNull();

        const stubPath: VehicleNavPath = {
            points: [] as NavPoint[],
            reachedDestination: false,
            shortfall: 0,
            provisional: true,
            method: 'stub',
        };
        const stub: VehicleNav = {
            findVehiclePath: () => stubPath,
            isFullyBaked: () => false,
            getRevision: () => 1,
        };

        setGlobalVehicleNav(stub);
        expect(getGlobalVehicleNav()).toBe(stub);

        setGlobalVehicleNav(null);
        expect(getGlobalVehicleNav()).toBeNull();
    });
});
