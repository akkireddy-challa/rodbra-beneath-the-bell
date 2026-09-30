import {
    VEHICLE_DRIVE_COST, BAKE_PRIOR_BAND_M, BAKE_PROP_MIN_ABOVE_M, BAKE_PROP_MAX_ABOVE_M,
    BAKE_CANOPY_SKIP_LIMIT, BAKE_MIDPOINT_MIN_RISE_M, BAKE_STEP_BUDGET_MS, BAKE_OBSTRUCTION_MIN_ABOVE_M,
    BAKE_REVALIDATE_DELAY_MS,
    BAKE_WALL_MIN_ABOVE_M, BAKE_WALL_MAX_ABOVE_M,
    seedFromMask, repaintMaskRect, VehicleNavGridBakePass,
    type CastDown, type CheckObstruction, type CheckWallObstruction,
} from 'engine/nav/VehicleNavGridBake.js';
import { VehicleNavGrid, CELL_VALIDATED, CELL_PROP_BLOCKED } from 'engine/nav/VehicleNavGrid.js';
import { GROUND_MASK_HEIGHT_STEP } from 'engine/vxlscene/GroundMaskBaker.js';
import type { GroundMaskData } from 'engine/vxlscene/GroundMaskBaker.js';
import { GROUND_TYPE } from 'engine/vxlscene/GroundTypes.js';

// isolatedModules quirk: a missing export imports as `undefined` instead of
// throwing at import time. Make the first assertion loud so a typo'd export
// name fails here, not three tests later with a confusing TypeError.
it('exports seedFromMask as a function', () => {
    expect(typeof seedFromMask).toBe('function');
});

/** A 1x1-grid-cell-sized (2x2 mask cells), all-zero mask, ready for cells to be filled in. */
function makeMask(width: number, height: number): GroundMaskData {
    return {
        cellSize: 0.5,
        width,
        height,
        types: new Uint8Array(width * height),
        topY: new Uint16Array(width * height),
    };
}

function setMaskCell(mask: GroundMaskData, mx: number, mz: number, type: number, topYQ: number): void {
    const idx = mz * mask.width + mx;
    mask.types[idx] = type;
    mask.topY[idx] = topYQ;
}

function makeGrid(width: number, height: number, minX = 0, minZ = 0): VehicleNavGrid {
    return new VehicleNavGrid({ cellSize: 1, width, height, minX, minZ });
}

/** Never finds an obstruction — the common case for tests unrelated to Fix 2. */
const noObstruction: CheckObstruction = () => false;

/** Never finds a terrain-baked wall — the common case for tests unrelated to the wall query. */
const noWall: CheckWallObstruction = () => false;

/**
 * Models the WALL box the terrain wiring builds out of
 * `BAKE_WALL_MIN_ABOVE_M`/`BAKE_WALL_MAX_ABOVE_M`
 * (`VxlSceneTerrainSystem.makeCheckWallObstruction`): true iff a piece of
 * terrain geometry spanning `[obstacleMinY, obstacleMaxY]` (absolute world
 * heights) overlaps the band above the cell's ground. Lets the band's two
 * bounds — the whole point of the constants — be exercised here in a
 * Rapier-free test, exactly as the terrain wiring would compute them.
 */
function wallCheckFor(obstacleMinY: number, obstacleMaxY: number): CheckWallObstruction {
    return (_x, groundY, _z) => obstacleMaxY >= groundY + BAKE_WALL_MIN_ABOVE_M
        && obstacleMinY <= groundY + BAKE_WALL_MAX_ABOVE_M;
}

// ── seedFromMask ─────────────────────────────────────────────────────────

describe('seedFromMask', () => {
    it('cost = min drivable cost over the 2x2 block; groundY = the cheapest sub-cell (road, not kerb)', () => {
        const grid = makeGrid(1, 1);
        const mask = makeMask(2, 2);
        // asphalt (cost 1.0) at topY 300 (15.00m), sidewalk (cost 3.5, kerb) at topY 307 (15.35m).
        setMaskCell(mask, 0, 0, GROUND_TYPE.asphalt, 300);
        setMaskCell(mask, 1, 0, GROUND_TYPE.sidewalk, 307);
        // (0,1) and (1,1) left at 0 = no data.

        seedFromMask(grid, mask, 0, 0);

        expect(grid.getCost(0, 0)).toBeCloseTo(VEHICLE_DRIVE_COST[GROUND_TYPE.asphalt]!);
        expect(grid.getGroundY(0, 0)).toBeCloseTo(15.0);
    });

    it('all-grass block (typed, not drivable) -> cost 0; all-empty block -> cost 0 and groundY NaN', () => {
        const grassGrid = makeGrid(1, 1);
        const grassMask = makeMask(2, 2);
        setMaskCell(grassMask, 0, 0, GROUND_TYPE.grass, 200);
        setMaskCell(grassMask, 1, 0, GROUND_TYPE.grass, 200);
        setMaskCell(grassMask, 0, 1, GROUND_TYPE.grass, 200);
        setMaskCell(grassMask, 1, 1, GROUND_TYPE.grass, 200);
        seedFromMask(grassGrid, grassMask, 0, 0);
        expect(grassGrid.getCost(0, 0)).toBe(0);

        const emptyGrid = makeGrid(1, 1);
        const emptyMask = makeMask(2, 2); // all zero: no data anywhere
        seedFromMask(emptyGrid, emptyMask, 0, 0);
        expect(emptyGrid.getCost(0, 0)).toBe(0);
        expect(Number.isNaN(emptyGrid.getGroundY(0, 0))).toBe(true);
    });

    it('mask origin need not coincide with grid origin: converts through world coordinates', () => {
        // Grid min corner sits 10m away from the mask's min corner along both axes.
        const grid = makeGrid(1, 1, 10, 10);
        const mask = makeMask(4, 4);
        // Grid cell (0,0)'s world min corner is (10,10). With the mask's own origin
        // at world (9,9), that maps to mask block cols/rows floor((10-9)/0.5)=2..3 —
        // NOT (0,0) or (2*gx,2*gz) as a same-origin assumption would compute.
        setMaskCell(mask, 2, 2, GROUND_TYPE.asphalt, 400); // 20.0m
        setMaskCell(mask, 3, 2, GROUND_TYPE.asphalt, 400);
        setMaskCell(mask, 2, 3, GROUND_TYPE.asphalt, 400);
        setMaskCell(mask, 3, 3, GROUND_TYPE.asphalt, 400);
        seedFromMask(grid, mask, 9, 9);
        expect(grid.getCost(0, 0)).toBeCloseTo(1.0);
        expect(grid.getGroundY(0, 0)).toBeCloseTo(20.0);
    });

    describe('mask-derived edge midpoints', () => {
        it('stores the intervening mask column height when the rise exceeds the threshold', () => {
            const grid = makeGrid(2, 1);
            const mask = makeMask(4, 2);
            // Cell (0,0): world [0,1)x[0,1) -> mask block cols 0-1, rows 0-1.
            setMaskCell(mask, 0, 0, GROUND_TYPE.asphalt, 300); // 15.00m, wins (cheapest, only drivable sub-cell)
            // Cell (1,0): world [1,2)x[0,1) -> mask block cols 2-3, rows 0-1.
            setMaskCell(mask, 3, 0, GROUND_TYPE.asphalt, 307); // 15.35m
            // Column (2,1) is the mask cell nearest the edge midpoint (world 1.0, 0.5)
            // AND happens to sit inside cell(1,0)'s own aggregation block; give it a
            // higher-cost type so it never wins that cell's own cost/groundY tie,
            // proving the midpoint value is read from this column directly, not
            // derived from the two neighbour cells' own heights.
            setMaskCell(mask, 2, 1, GROUND_TYPE.sidewalk, 310); // 15.50m (kerb)

            seedFromMask(grid, mask, 0, 0);

            expect(grid.getGroundY(0, 0)).toBeCloseTo(15.0);
            expect(grid.getGroundY(1, 0)).toBeCloseTo(15.35); // unaffected by the sidewalk sub-cell
            const a = grid.index(0, 0);
            const b = grid.index(1, 0);
            expect(grid.getEdgeMidpointY(a, b)).toBeCloseTo(15.5);
        });

        it('does not store a midpoint when the rise does not exceed BAKE_MIDPOINT_MIN_RISE_M', () => {
            const grid = makeGrid(2, 1);
            const mask = makeMask(4, 2);
            // Same topY on both cells (rise 0) — clear of the threshold with no
            // dependence on float-imprecise 0.05-quantization boundary math.
            setMaskCell(mask, 0, 0, GROUND_TYPE.asphalt, 300); // 15.00m
            setMaskCell(mask, 3, 0, GROUND_TYPE.asphalt, 300); // 15.00m -> rise 0, well under threshold
            setMaskCell(mask, 2, 1, GROUND_TYPE.sidewalk, 310); // data exists at the intervening column too

            seedFromMask(grid, mask, 0, 0);

            const a = grid.index(0, 0);
            const b = grid.index(1, 0);
            expect(grid.getEdgeMidpointY(a, b)).toBeNull();
        });
    });
});

// ── repaintMaskRect ──────────────────────────────────────────────────────

describe('repaintMaskRect', () => {
    it('re-runs only the cost computation for cells intersecting the rect, leaving groundY/flags/midpoints alone', () => {
        const grid = makeGrid(1, 1);
        const mask = makeMask(2, 2);
        setMaskCell(mask, 0, 0, GROUND_TYPE.grass, 240); // 12.00m, typed but not drivable
        setMaskCell(mask, 1, 0, GROUND_TYPE.grass, 240);
        setMaskCell(mask, 0, 1, GROUND_TYPE.grass, 240);
        setMaskCell(mask, 1, 1, GROUND_TYPE.grass, 240);
        seedFromMask(grid, mask, 0, 0);
        expect(grid.getCost(0, 0)).toBe(0);
        const revisionBefore = grid.getRevision();

        // Paint changes TYPE only, per the ground-mask contract — heights untouched.
        setMaskCell(mask, 0, 0, GROUND_TYPE.asphalt, 240);

        const changed = repaintMaskRect(grid, mask, 0, 0, { minX: 0, minZ: 0, maxX: 1, maxZ: 1 });

        expect(changed).toEqual([{ gx: 0, gz: 0 }]);
        expect(grid.getCost(0, 0)).toBeCloseTo(VEHICLE_DRIVE_COST[GROUND_TYPE.asphalt]!);
        expect(grid.getGroundY(0, 0)).toBeCloseTo(12.0); // untouched fallback height from the original seed
        expect(grid.getFlags(0, 0)).toBe(0); // untouched — never validated by the collider pass
        expect(grid.getRevision()).toBe(revisionBefore + 1);
    });

    it('bumps revision exactly once and reports nothing changed when the rect repaints to the same cost', () => {
        const grid = makeGrid(1, 1);
        const mask = makeMask(2, 2);
        setMaskCell(mask, 0, 0, GROUND_TYPE.asphalt, 300);
        setMaskCell(mask, 1, 0, GROUND_TYPE.asphalt, 300);
        setMaskCell(mask, 0, 1, GROUND_TYPE.asphalt, 300);
        setMaskCell(mask, 1, 1, GROUND_TYPE.asphalt, 300);
        seedFromMask(grid, mask, 0, 0);
        const revisionBefore = grid.getRevision();

        const changed = repaintMaskRect(grid, mask, 0, 0, { minX: 0, minZ: 0, maxX: 1, maxZ: 1 });

        expect(changed).toEqual([]);
        expect(grid.getRevision()).toBe(revisionBefore); // no bump when nothing changed
    });

    it('a repainted cell can be re-queued and re-validated by the collider pass', () => {
        const grid = makeGrid(1, 1);
        const mask = makeMask(2, 2);
        setMaskCell(mask, 0, 0, GROUND_TYPE.grass, 240);
        setMaskCell(mask, 1, 0, GROUND_TYPE.grass, 240);
        setMaskCell(mask, 0, 1, GROUND_TYPE.grass, 240);
        setMaskCell(mask, 1, 1, GROUND_TYPE.grass, 240);
        seedFromMask(grid, mask, 0, 0);
        setMaskCell(mask, 0, 0, GROUND_TYPE.asphalt, 240);
        const changed = repaintMaskRect(grid, mask, 0, 0, { minX: 0, minZ: 0, maxX: 1, maxZ: 1 });
        expect(changed).toEqual([{ gx: 0, gz: 0 }]);

        let clock = 0;
        const castDown: CastDown = () => {
            clock += 1;
            return { y: 12.02, isTerrainBody: true }; // close to the 12.0m fallback prior -> ground
        };
        const pass = new VehicleNavGridBakePass(grid, castDown, noObstruction, noWall, () => clock);
        for (const cell of changed) pass.enqueueCell(cell.gx, cell.gz);
        pass.step();

        expect(grid.getFlags(0, 0) & CELL_VALIDATED).toBe(CELL_VALIDATED);
        expect(grid.getGroundY(0, 0)).toBeCloseTo(12.02);
    });
});

// ── VehicleNavGridBakePass ───────────────────────────────────────────────

/** Seeds every cell of a flat width x height grid as drivable asphalt at the given height. */
function seedFlat(width: number, height: number, y: number): VehicleNavGrid {
    const grid = makeGrid(width, height);
    for (let gz = 0; gz < height; gz++) {
        for (let gx = 0; gx < width; gx++) {
            grid.setCost(gx, gz, 1);
            grid.setGroundY(gx, gz, y);
        }
    }
    return grid;
}

describe('VehicleNavGridBakePass budget and completion (two sweeps — see Fix A)', () => {
    it('resolves exactly BAKE_STEP_BUDGET_MS cells per step(), drains the INITIAL sweep without finishing, waits out BAKE_REVALIDATE_DELAY_MS, then finishes on the REVALIDATION sweep draining', () => {
        const grid = seedFlat(6, 1, 10); // 6 drivable cells in a row, all flat -> no extra midpoint casts (rise 0)
        let clock = 0;
        const now = () => clock;
        const castDown: CastDown = () => {
            clock += 1; // "clock advances 1ms per resolveCell": exactly one cast per flat cell here
            return { y: 10, isTerrainBody: true };
        };
        const pass = new VehicleNavGridBakePass(grid, castDown, noObstruction, noWall, now);
        pass.start();

        expect(pass.isDone).toBe(false);
        pass.step();
        expect(clock).toBe(BAKE_STEP_BUDGET_MS); // exactly 4 cells resolved
        expect(pass.isDone).toBe(false);
        expect(grid.isFullyBaked()).toBe(false);
        // The 4 resolved cells are validated; the remaining 2 are not yet.
        expect(grid.getFlags(3, 0) & CELL_VALIDATED).toBe(CELL_VALIDATED);
        expect(grid.getFlags(4, 0) & CELL_VALIDATED).toBe(0);

        pass.step(); // finishes the remaining 2 cells within budget -> INITIAL sweep drains
        // NOT fully baked yet — the revalidation sweep hasn't run.
        expect(pass.isDone).toBe(false);
        expect(grid.isFullyBaked()).toBe(false);
        for (let gx = 0; gx < 6; gx++) {
            expect(grid.getFlags(gx, 0) & CELL_VALIDATED).toBe(CELL_VALIDATED);
        }
        const castsAfterInitialSweep = clock;

        pass.step(); // called again before BAKE_REVALIDATE_DELAY_MS has elapsed: a no-op
        expect(clock).toBe(castsAfterInitialSweep); // no new casts — still waiting out the delay
        expect(pass.isDone).toBe(false);
        expect(grid.isFullyBaked()).toBe(false);

        clock += BAKE_REVALIDATE_DELAY_MS; // simulate the wait elapsing
        pass.step(); // delay elapsed: re-enqueues all 6 cells, resolves 4 within this step's budget
        expect(clock).toBe(castsAfterInitialSweep + BAKE_REVALIDATE_DELAY_MS + 4);
        expect(pass.isDone).toBe(false);
        expect(grid.isFullyBaked()).toBe(false);

        pass.step(); // resolves the remaining 2 -> REVALIDATION sweep drains -> fully baked
        expect(pass.isDone).toBe(true);
        expect(grid.isFullyBaked()).toBe(true);
    });

    it('bumps revision exactly once per changing step() call, across both sweeps', () => {
        const grid = seedFlat(6, 1, 10);
        let clock = 0;
        const castDown: CastDown = () => {
            clock += 1;
            return { y: 10, isTerrainBody: true };
        };
        const pass = new VehicleNavGridBakePass(grid, castDown, noObstruction, noWall, () => clock);
        pass.start();

        const r0 = grid.getRevision();
        pass.step(); // resolves 4 cells, initial sweep not done
        const r1 = grid.getRevision();
        expect(r1).toBe(r0 + 1);

        pass.step(); // resolves remaining 2 -> INITIAL sweep drains (moves to 'awaiting', own bump)
        const r2 = grid.getRevision();
        expect(r2).toBe(r1 + 1);

        pass.step(); // still waiting out the delay: no-op, no bump
        expect(grid.getRevision()).toBe(r2);

        clock += BAKE_REVALIDATE_DELAY_MS;
        pass.step(); // delay elapsed: revalidation sweep resolves 4 cells
        const r3 = grid.getRevision();
        expect(r3).toBe(r2 + 1);

        pass.step(); // resolves remaining 2 -> REVALIDATION sweep drains -> markFullyBaked's own single bump
        const r4 = grid.getRevision();
        expect(r4).toBe(r3 + 1);

        pass.step(); // already done: no-op, no bump
        expect(grid.getRevision()).toBe(r4);
    });

    it('a grid with no drivable cells still waits out the revalidation delay before finishing (no shortcut for an empty pass)', () => {
        const grid = makeGrid(2, 2); // never seeded: cost 0 everywhere
        let clock = 0;
        const castDown: CastDown = () => ({ y: 0, isTerrainBody: true });
        const pass = new VehicleNavGridBakePass(grid, castDown, noObstruction, noWall, () => clock);
        pass.start();
        expect(pass.isDone).toBe(false);

        pass.step(); // nothing queued: INITIAL sweep "drains" immediately -> awaiting
        expect(pass.isDone).toBe(false);
        expect(grid.isFullyBaked()).toBe(false);

        pass.step(); // still inside the delay window: no-op
        expect(pass.isDone).toBe(false);

        clock += BAKE_REVALIDATE_DELAY_MS;
        pass.step(); // delay elapsed: nothing to re-enqueue either -> REVALIDATION sweep also drains immediately
        expect(pass.isDone).toBe(true);
        expect(grid.isFullyBaked()).toBe(true);
    });
});

describe('VehicleNavGridBakePass revalidation sweep (Fix A: late-registering colliders)', () => {
    it('does not mark fully baked when the initial sweep drains — waits for the revalidation sweep to also drain', () => {
        const grid = makeGrid(1, 1);
        grid.setCost(0, 0, 1);
        grid.setGroundY(0, 0, 10);
        let clock = 0;
        const castDown: CastDown = () => ({ y: 10, isTerrainBody: true });
        const pass = new VehicleNavGridBakePass(grid, castDown, noObstruction, noWall, () => clock);
        pass.start();
        pass.step(); // the only cell resolves; initial sweep drains
        expect(pass.isDone).toBe(false);
        expect(grid.isFullyBaked()).toBe(false);

        clock += BAKE_REVALIDATE_DELAY_MS;
        pass.step(); // revalidation sweep re-resolves the same cell and drains
        expect(pass.isDone).toBe(true);
        expect(grid.isFullyBaked()).toBe(true);
    });

    it('re-enqueues every still-drivable cell for the revalidation sweep, but never a cell that resolved closed', () => {
        const grid = seedFlat(3, 1, 10);
        let clock = 0;
        const castCountByGx = new Map<number, number>();
        const castDown: CastDown = (x) => {
            const cell = grid.worldToCell(x, 0.5)!;
            castCountByGx.set(cell.gx, (castCountByGx.get(cell.gx) ?? 0) + 1);
            if (cell.gx === 1) return null; // (1,0) has no ground under it — always closes
            return { y: 10, isTerrainBody: true };
        };
        const pass = new VehicleNavGridBakePass(grid, castDown, noObstruction, noWall, () => clock);
        pass.start();
        pass.step(); // static clock never advances the budget check -> all 3 cells resolve this call
        expect(grid.getCost(1, 0)).toBe(0); // closed
        expect(grid.getCost(0, 0)).toBe(1);
        expect(grid.getCost(2, 0)).toBe(1);

        clock += BAKE_REVALIDATE_DELAY_MS;
        pass.step(); // revalidation sweep: only (0,0) and (2,0) are still cost>0 -> re-queued; (1,0) is not
        expect(pass.isDone).toBe(true);
        expect(castCountByGx.get(1)).toBe(1); // (1,0) was cast exactly once, ever — never re-enqueued
        expect(castCountByGx.get(0)).toBe(2); // (0,0) was cast on BOTH sweeps
        expect(castCountByGx.get(2)).toBe(2); // (2,0) was cast on BOTH sweeps
    });

    it('a checkObstruction that only starts reporting true on the SECOND sweep produces PROP_BLOCKED and a revision bump — the whole point of the revalidation sweep', () => {
        // Simulates an async-loaded prop collider that was not yet registered
        // during the FIRST sweep (checkObstruction sees nothing) but IS live
        // by the time the revalidation sweep runs BAKE_REVALIDATE_DELAY_MS
        // later — the exact failure mode measured live (task-8-fix-report.md):
        // 6 cells whose stored bake flag read clean but a FRESH re-query of
        // the same box found a real obstruction.
        const grid = makeGrid(1, 1);
        grid.setCost(0, 0, 1);
        grid.setGroundY(0, 0, 10);
        let clock = 0;
        let sweep = 1;
        const castDown: CastDown = () => ({ y: 10.05, isTerrainBody: true }); // clean ground hit, both sweeps
        const checkObstruction: CheckObstruction = () => sweep === 2;

        const pass = new VehicleNavGridBakePass(grid, castDown, checkObstruction, noWall, () => clock);
        pass.start();
        pass.step(); // first sweep: checkObstruction returns false -> clean ground
        expect(grid.getFlags(0, 0)).toBe(CELL_VALIDATED);
        expect(grid.getGroundY(0, 0)).toBeCloseTo(10.05);
        const revisionAfterFirstSweep = grid.getRevision();

        sweep = 2;
        clock += BAKE_REVALIDATE_DELAY_MS;
        pass.step(); // revalidation sweep: checkObstruction now returns true -> PROP_BLOCKED
        expect(grid.getFlags(0, 0)).toBe(CELL_VALIDATED | CELL_PROP_BLOCKED);
        expect(grid.getGroundY(0, 0)).toBeCloseTo(10.05); // left as seeded on THIS resolution, per the prop rule
        expect(grid.getRevision()).toBeGreaterThan(revisionAfterFirstSweep);
        expect(pass.isDone).toBe(true);
    });
});

describe('VehicleNavGridBakePass classification', () => {
    function singleCellPass(priorY: number, castDown: CastDown): { grid: VehicleNavGrid; pass: VehicleNavGridBakePass } {
        const grid = makeGrid(1, 1);
        grid.setCost(0, 0, 1);
        grid.setGroundY(0, 0, priorY);
        const pass = new VehicleNavGridBakePass(grid, castDown, noObstruction, noWall, () => 0);
        return { grid, pass };
    }

    it('ground within band: stored groundY is replaced by the cast height', () => {
        const { grid, pass } = singleCellPass(10, () => ({ y: 10.1, isTerrainBody: true }));
        pass.start();
        pass.step();
        expect(grid.getGroundY(0, 0)).toBeCloseTo(10.1);
        expect(grid.getFlags(0, 0)).toBe(CELL_VALIDATED);
    });

    it('non-terrain hit between PROP_MIN and PROP_MAX above prior -> PROP_BLOCKED, cost/groundY kept', () => {
        const { grid, pass } = singleCellPass(10, () => ({ y: 10 + 1.2, isTerrainBody: false }));
        pass.start();
        pass.step();
        expect(grid.getFlags(0, 0)).toBe(CELL_VALIDATED | CELL_PROP_BLOCKED);
        expect(grid.getCost(0, 0)).toBe(1); // diagnostic value kept
        expect(grid.getGroundY(0, 0)).toBeCloseTo(10); // untouched
    });

    it('no hit -> fail closed: cost 0, groundY NaN, VALIDATED', () => {
        const { grid, pass } = singleCellPass(10, () => null);
        pass.start();
        pass.step();
        expect(grid.getCost(0, 0)).toBe(0);
        expect(Number.isNaN(grid.getGroundY(0, 0))).toBe(true);
        expect(grid.getFlags(0, 0)).toBe(CELL_VALIDATED);
    });

    it('hit more than BAKE_PRIOR_BAND_M below prior -> fail closed', () => {
        const { grid, pass } = singleCellPass(10, () => ({ y: 10 - (BAKE_PRIOR_BAND_M + 1), isTerrainBody: true }));
        pass.start();
        pass.step();
        expect(grid.getCost(0, 0)).toBe(0);
        expect(Number.isNaN(grid.getGroundY(0, 0))).toBe(true);
    });

    it('rejects the boundary as clutter, not ground: a hit exactly at BAKE_PROP_MAX_ABOVE_M + epsilon triggers a canopy re-cast', () => {
        let calls = 0;
        const castDown: CastDown = () => {
            calls += 1;
            if (calls === 1) return { y: 10 + BAKE_PROP_MAX_ABOVE_M + 0.01, isTerrainBody: false };
            return { y: 10.0, isTerrainBody: true };
        };
        const { grid, pass } = singleCellPass(10, castDown);
        pass.start();
        pass.step();
        expect(calls).toBe(2);
        expect(grid.getGroundY(0, 0)).toBeCloseTo(10.0);
    });
});

describe('VehicleNavGridBakePass canopy re-cast (rule 6)', () => {
    it('a non-terrain hit far above prior triggers a re-cast; the second cast (road height) resolves to ground', () => {
        let calls = 0;
        const castDown: CastDown = (_x, fromY) => {
            calls += 1;
            if (calls === 1) {
                expect(fromY).toBeCloseTo(10 + 20); // first cast from prior+20
                return { y: 10 + 6, isTerrainBody: false }; // +6m, non-terrain: clutter
            }
            expect(fromY).toBeCloseTo(10 + 6 - 0.05); // re-cast from just beneath the clutter hit
            return { y: 10.05, isTerrainBody: true }; // road height, within band
        };
        const grid = makeGrid(1, 1);
        grid.setCost(0, 0, 1);
        grid.setGroundY(0, 0, 10);
        const pass = new VehicleNavGridBakePass(grid, castDown, noObstruction, noWall, () => 0);
        pass.start();
        pass.step();

        expect(calls).toBe(2);
        expect(grid.getGroundY(0, 0)).toBeCloseTo(10.05);
        expect(grid.getFlags(0, 0)).toBe(CELL_VALIDATED);
    });

    it('exhausting BAKE_CANOPY_SKIP_LIMIT re-casts fails closed', () => {
        let calls = 0;
        const castDown: CastDown = () => {
            calls += 1;
            return { y: 10 + 10, isTerrainBody: false }; // always clutter, never resolves
        };
        const grid = makeGrid(1, 1);
        grid.setCost(0, 0, 1);
        grid.setGroundY(0, 0, 10);
        const pass = new VehicleNavGridBakePass(grid, castDown, noObstruction, noWall, () => 0);
        pass.start();
        pass.step();

        expect(calls).toBe(1 + BAKE_CANOPY_SKIP_LIMIT); // 1 initial + the bounded re-casts
        expect(grid.getCost(0, 0)).toBe(0);
        expect(Number.isNaN(grid.getGroundY(0, 0))).toBe(true);
        expect(grid.getFlags(0, 0)).toBe(CELL_VALIDATED);
    });

    it('a terrain-body hit above the band on the FIRST cast, within 5m, is accepted as ground (stale mask prior)', () => {
        const castDown: CastDown = () => ({ y: 10 + 3, isTerrainBody: true }); // +3m > band(2), terrain, first hit
        const grid = makeGrid(1, 1);
        grid.setCost(0, 0, 1);
        grid.setGroundY(0, 0, 10);
        const pass = new VehicleNavGridBakePass(grid, castDown, noObstruction, noWall, () => 0);
        pass.start();
        pass.step();
        expect(grid.getGroundY(0, 0)).toBeCloseTo(13);
        expect(grid.getFlags(0, 0)).toBe(CELL_VALIDATED);
    });

    it('a terrain-body hit above the band beyond 5m is treated as clutter, not a stale-prior correction', () => {
        let calls = 0;
        const castDown: CastDown = () => {
            calls += 1;
            if (calls === 1) return { y: 10 + 6, isTerrainBody: true }; // +6m > 5m grace: clutter, not a correction
            return { y: 10.1, isTerrainBody: true };
        };
        const grid = makeGrid(1, 1);
        grid.setCost(0, 0, 1);
        grid.setGroundY(0, 0, 10);
        const pass = new VehicleNavGridBakePass(grid, castDown, noObstruction, noWall, () => 0);
        pass.start();
        pass.step();
        expect(calls).toBe(2);
        expect(grid.getGroundY(0, 0)).toBeCloseTo(10.1);
    });

    it('a terrain-body hit above the band within 5m on a RE-CAST (not the first hit) is still clutter', () => {
        let calls = 0;
        const castDown: CastDown = () => {
            calls += 1;
            if (calls === 1) return { y: 10 + 6, isTerrainBody: false }; // clutter -> forces a re-cast
            if (calls === 2) return { y: 10 + 3, isTerrainBody: true }; // above band, within 5m, but NOT the first cast
            return { y: 10.1, isTerrainBody: true }; // third cast resolves normally
        };
        const grid = makeGrid(1, 1);
        grid.setCost(0, 0, 1);
        grid.setGroundY(0, 0, 10);
        const pass = new VehicleNavGridBakePass(grid, castDown, noObstruction, noWall, () => 0);
        pass.start();
        pass.step();
        expect(calls).toBe(3); // the second hit did NOT short-circuit as an accepted correction
        expect(grid.getGroundY(0, 0)).toBeCloseTo(10.1);
    });
});

describe('VehicleNavGridBakePass edge midpoints (rule 7)', () => {
    it('fires one midpoint ray between two newly-validated neighbours and stores a ground hit', () => {
        const grid = makeGrid(2, 1);
        grid.setCost(0, 0, 1);
        grid.setGroundY(0, 0, 15.0);
        grid.setCost(1, 0, 1);
        grid.setGroundY(1, 0, 15.0);

        const cellACenter = grid.cellToWorld(0, 0);
        const cellBCenter = grid.cellToWorld(1, 0);
        const midX = (cellACenter.x + cellBCenter.x) / 2;
        const midZ = (cellACenter.z + cellBCenter.z) / 2;

        const castDown: CastDown = (x, _fromY, z) => {
            if (Math.abs(x - cellACenter.x) < 1e-6 && Math.abs(z - cellACenter.z) < 1e-6) {
                return { y: 15.0, isTerrainBody: true };
            }
            if (Math.abs(x - cellBCenter.x) < 1e-6 && Math.abs(z - cellBCenter.z) < 1e-6) {
                return { y: 15.34, isTerrainBody: true };
            }
            if (Math.abs(x - midX) < 1e-6 && Math.abs(z - midZ) < 1e-6) {
                return { y: 15.2, isTerrainBody: true }; // within band of the mean (15.17)
            }
            throw new Error(`unexpected cast at (${x}, ${z})`);
        };

        const pass = new VehicleNavGridBakePass(grid, castDown, noObstruction, noWall, () => 0);
        pass.start();
        pass.step();

        expect(grid.getGroundY(0, 0)).toBeCloseTo(15.0);
        expect(grid.getGroundY(1, 0)).toBeCloseTo(15.34);
        const a = grid.index(0, 0);
        const b = grid.index(1, 0);
        expect(grid.getEdgeMidpointY(a, b)).toBeCloseTo(15.2);
    });

    it('leaves a mask-seeded midpoint in place when the collider midpoint ray finds no ground within the band', () => {
        const grid = makeGrid(2, 1);
        grid.setCost(0, 0, 1);
        grid.setGroundY(0, 0, 15.0);
        grid.setCost(1, 0, 1);
        grid.setGroundY(1, 0, 15.5);
        const a = grid.index(0, 0);
        const b = grid.index(1, 0);
        grid.setEdgeMidpointY(a, b, 15.25); // pre-existing mask-seeded midpoint

        const cellACenter = grid.cellToWorld(0, 0);
        const cellBCenter = grid.cellToWorld(1, 0);
        const castDown: CastDown = (x, _fromY, z) => {
            if (Math.abs(x - cellACenter.x) < 1e-6 && Math.abs(z - cellACenter.z) < 1e-6) {
                return { y: 15.0, isTerrainBody: true };
            }
            if (Math.abs(x - cellBCenter.x) < 1e-6 && Math.abs(z - cellBCenter.z) < 1e-6) {
                return { y: 15.5, isTerrainBody: true };
            }
            return null; // the midpoint ray finds nothing
        };

        const pass = new VehicleNavGridBakePass(grid, castDown, noObstruction, noWall, () => 0);
        pass.start();
        pass.step();

        expect(grid.getEdgeMidpointY(a, b)).toBeCloseTo(15.25); // untouched, not invented
    });
});

// ── per-cell obstruction query (Fix 2: off-centre props on flat ground) ────

describe('VehicleNavGridBakePass per-cell obstruction query', () => {
    it('BAKE_OBSTRUCTION_MIN_ABOVE_M is a lower, separate floor from BAKE_PROP_MIN_ABOVE_M', () => {
        // The obstruction BOX's floor (this module's job: approximate the
        // vehicle's actual swept clearance envelope) must sit below the
        // centre-ray rule's floor (a different job: discriminate a real prop
        // hit from ground noise on a single ray) — see both constants' doc
        // comments. A regression here would silently widen or shrink the
        // obstruction band the terrain wiring builds from these exports.
        expect(BAKE_OBSTRUCTION_MIN_ABOVE_M).toBe(0.15);
        expect(BAKE_OBSTRUCTION_MIN_ABOVE_M).toBeLessThan(BAKE_PROP_MIN_ABOVE_M);
        expect(BAKE_OBSTRUCTION_MIN_ABOVE_M).toBeGreaterThan(0);
    });

    it('checkObstruction=true on a resolved-ground cell -> PROP_BLOCKED, cost/groundY kept exactly as the existing prop rule', () => {
        const grid = makeGrid(1, 1);
        grid.setCost(0, 0, 1);
        grid.setGroundY(0, 0, 10);
        const castDown: CastDown = () => ({ y: 10.05, isTerrainBody: true }); // clean ground hit, within band
        const checkObstruction: CheckObstruction = () => true; // but an off-centre prop occupies the cell

        const pass = new VehicleNavGridBakePass(grid, castDown, checkObstruction, noWall, () => 0);
        pass.start();
        pass.step();

        expect(grid.getFlags(0, 0)).toBe(CELL_VALIDATED | CELL_PROP_BLOCKED);
        expect(grid.getCost(0, 0)).toBe(1); // diagnostic value kept, exactly like the centre-ray prop rule
        expect(grid.getGroundY(0, 0)).toBeCloseTo(10); // left as seeded, NOT overwritten with the 10.05 hit
    });

    it('checkObstruction=false on a resolved-ground cell -> clean ground, groundY updated to the cast height', () => {
        const grid = makeGrid(1, 1);
        grid.setCost(0, 0, 1);
        grid.setGroundY(0, 0, 10);
        const castDown: CastDown = () => ({ y: 10.05, isTerrainBody: true });
        const checkObstruction: CheckObstruction = () => false;

        const pass = new VehicleNavGridBakePass(grid, castDown, checkObstruction, noWall, () => 0);
        pass.start();
        pass.step();

        expect(grid.getFlags(0, 0)).toBe(CELL_VALIDATED);
        expect(grid.getGroundY(0, 0)).toBeCloseTo(10.05);
    });

    it('checkObstruction is called with the resolved ground height (x, groundY, z), not the stale prior', () => {
        const grid = makeGrid(1, 1);
        grid.setCost(0, 0, 1);
        grid.setGroundY(0, 0, 10);
        const cellCenter = grid.cellToWorld(0, 0);
        const castDown: CastDown = () => ({ y: 10.4, isTerrainBody: true }); // corrected height, still within band
        const calls: Array<[number, number, number]> = [];
        const checkObstruction: CheckObstruction = (x, groundY, z) => {
            calls.push([x, groundY, z]);
            return false;
        };

        const pass = new VehicleNavGridBakePass(grid, castDown, checkObstruction, noWall, () => 0);
        pass.start();
        pass.step();

        expect(calls).toEqual([[cellCenter.x, 10.4, cellCenter.z]]);
    });

    it('checkObstruction is NOT called for a cell that resolves closed (no ground hit) or a cell that is already a centre-ray prop', () => {
        const closedCalls: number[] = [];
        const closedGrid = makeGrid(1, 1);
        closedGrid.setCost(0, 0, 1);
        closedGrid.setGroundY(0, 0, 10);
        const closedCastDown: CastDown = () => null; // rule 2: no hit -> closed
        const closedCheck: CheckObstruction = () => { closedCalls.push(1); return false; };
        const closedPass = new VehicleNavGridBakePass(closedGrid, closedCastDown, closedCheck, noWall, () => 0);
        closedPass.start();
        closedPass.step();
        expect(closedCalls).toEqual([]);
        expect(closedGrid.getFlags(0, 0)).toBe(CELL_VALIDATED);

        const propCalls: number[] = [];
        const propGrid = makeGrid(1, 1);
        propGrid.setCost(0, 0, 1);
        propGrid.setGroundY(0, 0, 10);
        // Centre-ray rule 5: a non-terrain hit within the prop band already
        // classifies as 'prop' before checkObstruction would ever run.
        const propCastDown: CastDown = () => ({ y: 10 + 1.2, isTerrainBody: false });
        const propCheck: CheckObstruction = () => { propCalls.push(1); return false; };
        const propPass = new VehicleNavGridBakePass(propGrid, propCastDown, propCheck, noWall, () => 0);
        propPass.start();
        propPass.step();
        expect(propCalls).toEqual([]);
        expect(propGrid.getFlags(0, 0)).toBe(CELL_VALIDATED | CELL_PROP_BLOCKED);
    });

    // ── Wall query (terrain-baked walls) ────────────────────────────────
    //
    // The band's two bounds carry the whole design: the floor sits above any
    // kerb so a road cell can't self-block on its own rising terrain (this
    // query, unlike the prop one, does NOT exclude the terrain body), and the
    // ceiling mirrors probeVehiclePath's swept slab so geometry the car fits
    // under stays clear in both truths.

    it('pins the wall band bounds: floor below kerb height but above any climbable grade, ceiling at the vehicle sweep height', () => {
        expect(BAKE_WALL_MIN_ABOVE_M).toBe(0.25);
        expect(BAKE_WALL_MAX_ABOVE_M).toBe(1.9);
        // Both ends of the measured window this floor has to sit inside:
        // under the 0.34 m kerbs that produced every residual divergence, and
        // over 0.5 * maxClimbGrade (0.5 m of box reach x 0.3 grade = 0.15),
        // the most a drivable road can rise across the box's own half-width.
        expect(BAKE_WALL_MIN_ABOVE_M).toBeLessThan(0.34);
        expect(BAKE_WALL_MIN_ABOVE_M).toBeGreaterThan(0.5 * 0.3);
        // Above the prop box's floor: the prop box may straddle the road
        // surface (it excludes the terrain body), the wall box may not.
        expect(BAKE_WALL_MIN_ABOVE_M).toBeGreaterThan(BAKE_OBSTRUCTION_MIN_ABOVE_M);
        expect(BAKE_WALL_MIN_ABOVE_M).toBeLessThan(BAKE_WALL_MAX_ABOVE_M);
    });

    it('a terrain-baked wall standing in the band -> PROP_BLOCKED, cost/groundY kept as seeded', () => {
        const grid = makeGrid(1, 1);
        grid.setCost(0, 0, 1);
        grid.setGroundY(0, 0, 10);
        const castDown: CastDown = () => ({ y: 10.05, isTerrainBody: true }); // clean road hit
        // A wall rising from the road surface to 3m — same rigid body as the
        // road, so checkObstruction (terrain excluded) sees nothing at all.
        const pass = new VehicleNavGridBakePass(
            grid, castDown, noObstruction, wallCheckFor(10, 13), () => 0,
        );
        pass.start();
        pass.step();

        expect(grid.getFlags(0, 0)).toBe(CELL_VALIDATED | CELL_PROP_BLOCKED);
        expect(grid.getCost(0, 0)).toBe(1);
        expect(grid.getGroundY(0, 0)).toBeCloseTo(10); // left as seeded, like every other prop path
    });

    it('a 0.34m kerb corner intruding into the cell IS a wall — it fouls the car sweep exactly like a low wall', () => {
        const grid = makeGrid(1, 1);
        grid.setCost(0, 0, 1);
        grid.setGroundY(0, 0, 10);
        const castDown: CastDown = () => ({ y: 10.05, isTerrainBody: true }); // centre column is road
        // 0.34m is the measured kerb height on the target level, and every
        // residual bake-vs-probe divergence there was exactly this: a kerb
        // corner inside the cell's box but not under any cell CENTRE, so the
        // lateral height rule (which compares centre heights) reads flat while
        // the probe's 1.83m-wide slab hits it.
        const pass = new VehicleNavGridBakePass(
            grid, castDown, noObstruction, wallCheckFor(10, 10.34), () => 0,
        );
        pass.start();
        pass.step();

        expect(grid.getFlags(0, 0)).toBe(CELL_VALIDATED | CELL_PROP_BLOCKED);
    });

    it('road rising at the steepest climbable grade across the box does NOT self-block', () => {
        const grid = makeGrid(1, 1);
        grid.setCost(0, 0, 1);
        grid.setGroundY(0, 0, 10);
        const castDown: CastDown = () => ({ y: 10, isTerrainBody: true });
        // The box reaches 0.5m from the cell centre; at maxClimbGrade 0.3 the
        // road's far side is 0.15m above the centre the floor is measured
        // from. Including the terrain body is only safe because the floor
        // clears that — this is the test that pins it.
        const pass = new VehicleNavGridBakePass(
            grid, castDown, noObstruction, wallCheckFor(9.85, 10.15), () => 0,
        );
        pass.start();
        pass.step();

        expect(grid.getFlags(0, 0)).toBe(CELL_VALIDATED);
        expect(grid.getGroundY(0, 0)).toBeCloseTo(10);
    });

    it('an arch starting 2.0m above the road is NOT a wall — the car drives under it, and so does the probe', () => {
        const grid = makeGrid(1, 1);
        grid.setCost(0, 0, 1);
        grid.setGroundY(0, 0, 10);
        const castDown: CastDown = () => ({ y: 10.05, isTerrainBody: true });
        // Arch underside at ground + 2.0, i.e. just above the band's 1.9
        // ceiling (ride height 0.3 + footprint height 1.6).
        const pass = new VehicleNavGridBakePass(
            grid, castDown, noObstruction, wallCheckFor(12, 15), () => 0,
        );
        pass.start();
        pass.step();

        expect(grid.getFlags(0, 0)).toBe(CELL_VALIDATED);
        expect(grid.getGroundY(0, 0)).toBeCloseTo(10.05);
    });

    it('the wall query receives the resolved ground height and is skipped for closed cells', () => {
        const grid = makeGrid(1, 1);
        grid.setCost(0, 0, 1);
        grid.setGroundY(0, 0, 10);
        const cellCenter = grid.cellToWorld(0, 0);
        const castDown: CastDown = () => ({ y: 10.4, isTerrainBody: true });
        const calls: Array<[number, number, number]> = [];
        const wallCheck: CheckWallObstruction = (x, groundY, z) => {
            calls.push([x, groundY, z]);
            return false;
        };
        const pass = new VehicleNavGridBakePass(grid, castDown, noObstruction, wallCheck, () => 0);
        pass.start();
        pass.step();
        expect(calls).toEqual([[cellCenter.x, 10.4, cellCenter.z]]);

        const closedCalls: Array<[number, number, number]> = [];
        const closedGrid = makeGrid(1, 1);
        closedGrid.setCost(0, 0, 1);
        closedGrid.setGroundY(0, 0, 10);
        const closedWallCheck: CheckWallObstruction = (x, groundY, z) => {
            closedCalls.push([x, groundY, z]);
            return false;
        };
        const closedPass = new VehicleNavGridBakePass(
            closedGrid, () => null, noObstruction, closedWallCheck, () => 0,
        );
        closedPass.start();
        closedPass.step();
        expect(closedCalls).toEqual([]);
    });
});
