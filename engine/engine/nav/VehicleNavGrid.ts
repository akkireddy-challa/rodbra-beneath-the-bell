import { evaluateVehiclePath, type VehicleFootprint, type PathSample } from 'engine/vehicleTraversability.js';
import { findVehiclePathOnGrid } from 'engine/nav/VehicleNavSearch.js';

/**
 * VehicleNavGrid — the pure data core of vehicle navigation.
 *
 * A uniform 2D grid over the drivable world, plus query-time edge evaluation
 * that reuses the tested `evaluateVehiclePath` step/slope rules. This module
 * is deliberately pure (no Rapier, no THREE, no engine singletons) so it is
 * jest-testable as plain data + math. Later tasks build on top of it:
 *   - Task 3 adds the A* search (`findVehiclePath`).
 *   - Task 4 adds the collider bake that fills `cost` / `groundY` / `flags` /
 *     edge midpoints.
 *   - Task 5 wires it to the voxel terrain system.
 */

/** A point on the XZ ground plane. */
export interface NavPoint { x: number; z: number }

export interface VehicleNavQueryOptions {
    footprint: VehicleFootprint;
    maxStepHeight: number;
    maxClimbGrade: number;
}

/** Repo options pattern: fully-required interface + exported DEFAULT_* const. */
export const DEFAULT_VEHICLE_NAV_QUERY_OPTIONS: VehicleNavQueryOptions = {
    footprint: { width: 2, height: 1.6, length: 4.2 },
    maxStepHeight: 0.14,   // derivedStepHeight(0.4) — default wheel radius
    maxClimbGrade: 0.30,
};

export interface VehicleNavPath {
    points: NavPoint[];            // dense polyline, no leg longer than MAX_LEG (25 m)
    reachedDestination: boolean;
    shortfall: number;             // metres short of the requested destination (0 when reached)
    provisional: boolean;          // true when answered before the collider bake finished
    method: string;                // human-readable diagnostic for logs
}

/** The engine-facing nav contract. A procedural-voxel backend can implement it later. */
export interface VehicleNav {
    findVehiclePath(from: NavPoint, to: NavPoint,
        opts?: VehicleNavQueryOptions): VehicleNavPath;
    isFullyBaked(): boolean;
    /** Bumped on rebuild / ground-type edits so path followers know to replan. */
    getRevision(): number;
}

/** Structural — deliberately NOT importing RapierVehicle (keeps this module pure). */
export interface VehicleCapabilitySource {
    getFootprint(): VehicleFootprint;
    getMaxClimbGrade(): number;
    getMaxStepHeight(): number;
}

export function queryOptionsForVehicle(vehicle: VehicleCapabilitySource): VehicleNavQueryOptions {
    return {
        footprint: vehicle.getFootprint(),
        maxClimbGrade: vehicle.getMaxClimbGrade(),
        maxStepHeight: vehicle.getMaxStepHeight(),
    };
}

export interface VehicleNavGridDims {
    cellSize: number;   // metres; the engine will use 1.0
    width: number;      // cells in X
    height: number;     // cells in Z
    minX: number;       // world X of the grid's min corner
    minZ: number;
}

/** A cell coordinate pair, as returned by `worldToCell`. */
export interface GridCoord { gx: number; gz: number }

/** bit 0 — the collider bake pass has resolved this cell (cost/groundY are trustworthy). */
export const CELL_VALIDATED = 1;
/** bit 1 — the collider bake pass found a prop obstructing the roadway on this cell. */
export const CELL_PROP_BLOCKED = 2;

export class VehicleNavGrid implements VehicleNav {
    readonly dims: VehicleNavGridDims;
    private readonly cellCount: number;

    /** 0 = not drivable (blocked/untyped); > 0 = material cost. */
    private readonly cost: Float32Array;
    /** World Y of the drivable surface; NaN = unknown. */
    private readonly groundY: Float32Array;
    /** Bit 0 CELL_VALIDATED, bit 1 CELL_PROP_BLOCKED. */
    private readonly flags: Uint8Array;
    /**
     * Sparse edge-midpoint heights, keyed by `edgeKey(indexA, indexB)`.
     *
     * Key scheme: `min(a,b) * cellCount + max(a,b)`. Both cell indices are
     * always `< cellCount`, so `max` alone never reaches `cellCount`, and each
     * distinct `min` occupies its own disjoint `[min*cellCount, (min+1)*cellCount)`
     * band — collision-free for any pair of valid indices, and order-independent
     * (the same key for (a,b) and (b,a)) so callers never have to think about
     * which direction they queried from.
     */
    private readonly edgeMidpointY: Map<number, number> = new Map();

    private fullyBaked = false;
    private revision = 1;

    constructor(dims: VehicleNavGridDims) {
        this.dims = dims;
        this.cellCount = dims.width * dims.height;
        this.cost = new Float32Array(this.cellCount);
        this.groundY = new Float32Array(this.cellCount).fill(NaN);
        this.flags = new Uint8Array(this.cellCount);
    }

    index(gx: number, gz: number): number {
        return gz * this.dims.width + gx;
    }

    inBounds(gx: number, gz: number): boolean {
        return gx >= 0 && gx < this.dims.width && gz >= 0 && gz < this.dims.height;
    }

    /** World (x,z) -> cell coords, or null if outside the grid. */
    worldToCell(x: number, z: number): GridCoord | null {
        const gx = Math.floor((x - this.dims.minX) / this.dims.cellSize);
        const gz = Math.floor((z - this.dims.minZ) / this.dims.cellSize);
        if (!this.inBounds(gx, gz)) return null;
        return { gx, gz };
    }

    /** Cell coords -> world (x,z) at the cell CENTRE. */
    cellToWorld(gx: number, gz: number): NavPoint {
        return {
            x: this.dims.minX + (gx + 0.5) * this.dims.cellSize,
            z: this.dims.minZ + (gz + 0.5) * this.dims.cellSize,
        };
    }

    private requireIndex(gx: number, gz: number): number {
        if (!this.inBounds(gx, gz)) {
            throw new Error(`[VehicleNavGrid] cell (${gx},${gz}) is out of bounds `
                + `(${this.dims.width}x${this.dims.height})`);
        }
        return this.index(gx, gz);
    }

    getCost(gx: number, gz: number): number {
        return this.cost[this.requireIndex(gx, gz)]!;
    }

    setCost(gx: number, gz: number, cost: number): void {
        this.cost[this.requireIndex(gx, gz)] = cost;
    }

    getGroundY(gx: number, gz: number): number {
        return this.groundY[this.requireIndex(gx, gz)]!;
    }

    setGroundY(gx: number, gz: number, y: number): void {
        this.groundY[this.requireIndex(gx, gz)] = y;
    }

    getFlags(gx: number, gz: number): number {
        return this.flags[this.requireIndex(gx, gz)]!;
    }

    setFlags(gx: number, gz: number, flags: number): void {
        this.flags[this.requireIndex(gx, gz)] = flags;
    }

    /** See `edgeMidpointY` doc for the key scheme. */
    private edgeKey(indexA: number, indexB: number): number {
        const min = Math.min(indexA, indexB);
        const max = Math.max(indexA, indexB);
        return min * this.cellCount + max;
    }

    setEdgeMidpointY(indexA: number, indexB: number, y: number): void {
        this.edgeMidpointY.set(this.edgeKey(indexA, indexB), y);
    }

    /** null when no midpoint is stored for this edge (the common case). */
    getEdgeMidpointY(indexA: number, indexB: number): number | null {
        return this.edgeMidpointY.get(this.edgeKey(indexA, indexB)) ?? null;
    }

    isFullyBaked(): boolean {
        return this.fullyBaked;
    }

    markFullyBaked(): void {
        this.fullyBaked = true;
        this.bumpRevision();
    }

    getRevision(): number {
        return this.revision;
    }

    bumpRevision(): void {
        this.revision += 1;
    }

    findVehiclePath(
        from: NavPoint, to: NavPoint, opts: VehicleNavQueryOptions = DEFAULT_VEHICLE_NAV_QUERY_OPTIONS,
    ): VehicleNavPath {
        return findVehiclePathOnGrid(this, from, to, opts);
    }
}

export type EdgeVerdict = { passable: boolean; reason: 'clear' | 'step' | 'blocked-cell' | 'unknown' | 'narrow' };

/** A cell is drivable when it has a positive cost and no prop obstructing it. */
function cellIsDrivable(grid: VehicleNavGrid, gx: number, gz: number): boolean {
    return grid.inBounds(gx, gz)
        && grid.getCost(gx, gz) > 0
        && (grid.getFlags(gx, gz) & CELL_PROP_BLOCKED) === 0;
}

/**
 * How many lateral cells (each side) the car's footprint reaches at this grid
 * resolution: for the default 1.834 m-wide car at cellSize 1, half-width 0.917
 * rounds to 1 — the immediate perpendicular neighbours. A wider vehicle (a
 * monster-truck-class footprint) reaches further out.
 */
function lateralCellReach(footprintWidth: number, cellSize: number): number {
    return Math.max(1, Math.round(footprintWidth / 2 / cellSize));
}

/** The two sides of the edge's normal — left-hand, then right-hand. */
const LATERAL_SIGNS = [-1, 1] as const;

/**
 * True when a lateral neighbour of `(gx,gz)` — offset perpendicular to the
 * edge's direction of travel — sits a real step above or below the endpoint,
 * or is itself PROP_BLOCKED, meaning the car's footprint would straddle a
 * kerb or clip a prop even though the 1-cell-wide centreline the grid
 * actually surveys reads flat and clear.
 *
 * Perpendicular: the left-hand normal `(-ddz, ddx)`, which for a pure X or Z
 * edge is the other axis and for a DIAGONAL edge is the opposite diagonal.
 *
 * This used to collapse a diagonal onto a "dominant axis" instead, which was
 * documented as good enough and was not. The offset it produced is 45° away
 * from the direction the footprint actually spans, so on any slope whose fall
 * line runs along that axis it samples ALONG the contour and measures nothing
 * at all. Measured on the Maple Hollow hillside (game XRTDE8YIJ4GI): the
 * axis-aligned offset read exactly 0.000 m of lateral rise on all fourteen
 * legs a car could not physically drive, while the true perpendicular reads
 * 0.274–0.318 m against a 0.105 m step cap. The planner tacked diagonally up
 * a hillside, every edge passing this rule, and the car wedged — see
 * docs/superpowers/plans/2026-08-19-vehicle-hillside-wedge.md.
 *
 * One asymmetry the normal brings with it: on a diagonal the neighbour at
 * `k = 1` sits √2 m away rather than 1 m, so a diagonal edge is sampled at a
 * slightly longer lateral reach than a straight one. Left as is deliberately —
 * these are STEP semantics, and a kerb is a kerb whether it is 1 m or 1.4 m
 * off the centreline.
 *
 * DELIBERATELY NOT gated on CELL_VALIDATED: a cell's `groundY` is trustworthy
 * (mask-seeded, at minimum) the instant it is non-NaN — `seedFromMask` fills
 * it for every cell before the collider pass ever runs, and the PROVISIONAL
 * grid (the one the search runs against before the bake finishes) is exactly
 * this pre-VALIDATED state everywhere else in the module. Requiring VALIDATED
 * here made the lateral rule a no-op during that provisional window: a route
 * planned before the bake finished waved every width-unsafe corridor through,
 * and by the time the bake caught up and correctly marked it, a car already
 * inside it had nothing telling it to leave. Only a genuinely NaN (no data
 * at all, never seeded) lateral cell is ignored — the fail-closed net.
 * PROP_BLOCKED lateral cells, by contrast, MUST have been through the
 * collider pass already (only it sets that flag), so no provisional-window
 * gap exists there — they always participate.
 */
function lateralStepAt(
    grid: VehicleNavGrid, gx: number, gz: number, ddx: number, ddz: number, reach: number, maxStepHeight: number,
): boolean {
    // Left-hand normal to the direction of travel; `sign` covers the right.
    const perpX = -ddz;
    const perpZ = ddx;
    const endpointY = grid.getGroundY(gx, gz);
    for (let k = 1; k <= reach; k++) {
        for (const sign of LATERAL_SIGNS) {
            const lgx = gx + sign * k * perpX;
            const lgz = gz + sign * k * perpZ;
            if (!grid.inBounds(lgx, lgz)) continue;
            const lateralY = grid.getGroundY(lgx, lgz);
            if (Number.isNaN(lateralY)) continue;
            // A prop straddling the lateral cell blocks regardless of how its
            // (diagnostic, left-as-seeded) height compares — see Fix 2's
            // per-cell obstruction query, VehicleNavGridBake.ts.
            if ((grid.getFlags(lgx, lgz) & CELL_PROP_BLOCKED) !== 0) return true;
            if (Math.abs(lateralY - endpointY) > maxStepHeight) return true;
        }
    }
    return false;
}

export function evaluateGridEdge(
    grid: VehicleNavGrid,
    fromGx: number, fromGz: number,
    toGx: number, toGz: number,
    opts: VehicleNavQueryOptions,
): EdgeVerdict {
    if (!cellIsDrivable(grid, fromGx, fromGz) || !cellIsDrivable(grid, toGx, toGz)) {
        return { passable: false, reason: 'blocked-cell' };
    }

    const ddx = toGx - fromGx;
    const ddz = toGz - fromGz;
    const isDiagonal = ddx !== 0 && ddz !== 0;

    const fromY = grid.getGroundY(fromGx, fromGz);
    const toY = grid.getGroundY(toGx, toGz);
    if (Number.isNaN(fromY) || Number.isNaN(toY)) {
        // Fail closed: an unsurveyed cell says nothing about drivability, and
        // a planner that reads that as clear road drives cars through walls.
        // Checked BEFORE the diagonal corner rule below (brief ordering):
        // 'unknown' means "not surveyed yet, may open once the bake
        // finishes" while 'blocked-cell' means "permanently excluded" — an
        // unsurveyed primary cell must report the former even if a corner
        // also happens to be blocked, since the corner check's answer is
        // moot until the primary cells are known drivable.
        return { passable: false, reason: 'unknown' };
    }

    if (isDiagonal) {
        // A car cannot cut a corner through a blocked cell: both orthogonal
        // neighbours that make up the corner must also be drivable.
        const cornerA = cellIsDrivable(grid, toGx, fromGz);
        const cornerB = cellIsDrivable(grid, fromGx, toGz);
        if (!cornerA || !cornerB) {
            return { passable: false, reason: 'blocked-cell' };
        }
    }

    // Lateral clearance: the grid's own step/grade check above only sees the
    // 1-cell-wide centreline. A kerb sitting inside the car's footprint width
    // but off that centreline — one lateral cell over — passes the centreline
    // check yet still clips the car (the divergence measured against the
    // runtime probe's full-width sweep). Applied to BOTH endpoint cells,
    // AFTER the corner-cut check (so a diagonal's own corners are already
    // known clear) and BEFORE the height/grade evaluation below, so a narrow
    // corridor never even reaches the step-vs-grade sample logic.
    const reach = lateralCellReach(opts.footprint.width, grid.dims.cellSize);
    if (lateralStepAt(grid, fromGx, fromGz, ddx, ddz, reach, opts.maxStepHeight)
        || lateralStepAt(grid, toGx, toGz, ddx, ddz, reach, opts.maxStepHeight)) {
        return { passable: false, reason: 'narrow' };
    }

    const run = isDiagonal ? grid.dims.cellSize * Math.SQRT2 : grid.dims.cellSize;
    const fromIndex = grid.index(fromGx, fromGz);
    const toIndex = grid.index(toGx, toGz);
    const midY = grid.getEdgeMidpointY(fromIndex, toIndex);

    // Why midpoints: evaluateVehiclePath's step rule only fires when
    // run <= STEP_RUN_LIMIT (0.5 m). A 0.2 m kerb across a 1 m edge reads as
    // grade 0.20 — under the 0.30 grade cap — and would pass. A stored 0.5 m
    // midpoint sample splits the edge into two 0.5 m runs so the step rule
    // can see the kerb. The bake (Task 4) stores midpoints wherever the
    // mask/collider heights disagree by more than a step; this module only
    // consumes them.
    const samples: PathSample[] = [{ distance: 0, height: fromY }];
    if (midY !== null) samples.push({ distance: run / 2, height: midY });
    samples.push({ distance: run, height: toY });

    // Symmetry: evaluateVehiclePath uses |rise| deliberately (kerbs block both
    // directions — see vehicleTraversability.ts), and the sample list above is
    // built from the ordered (from -> to) heights either way the caller asks,
    // so the verdict is identical for (a->b) and (b->a). Covered by a test.
    const result = evaluateVehiclePath(samples, opts.maxClimbGrade, opts.maxStepHeight, null);
    if (result.passable) {
        return { passable: true, reason: 'clear' };
    }
    // evaluateVehiclePath reports step/gap; heights here are always known
    // non-null (checked above), so a failure is always a step.
    return { passable: false, reason: 'step' };
}

let globalVehicleNav: VehicleNav | null = null;

export function setGlobalVehicleNav(nav: VehicleNav | null): void {
    globalVehicleNav = nav;
}

export function getGlobalVehicleNav(): VehicleNav | null {
    return globalVehicleNav;
}
