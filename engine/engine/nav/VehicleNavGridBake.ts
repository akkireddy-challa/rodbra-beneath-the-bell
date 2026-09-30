import {
    type VehicleNavGrid, type GridCoord, CELL_VALIDATED, CELL_PROP_BLOCKED,
} from 'engine/nav/VehicleNavGrid.js';
import {
    type GroundMaskData, groundMaskCellIndex, GROUND_MASK_HEIGHT_STEP,
} from 'engine/vxlscene/GroundMaskBaker.js';
import { GROUND_TYPE } from 'engine/vxlscene/GroundTypes.js';

/**
 * VehicleNavGridBake — fills a `VehicleNavGrid`'s cost/groundY/flags/edge
 * midpoints from two sources, in two phases:
 *
 *  1. `seedFromMask` / `repaintMaskRect` — a SYNCHRONOUS pass over the
 *     level's already-baked `GroundMaskData` (see `GroundMaskBaker.ts`).
 *     Cheap (one small array read per grid cell) and gives the grid a
 *     provisional, pre-collider answer the moment a level loads.
 *  2. `VehicleNavGridBakePass` — a TIME-SLICED pass that raycasts every
 *     drivable cell against the real colliders, the only source of truth
 *     for whether a road is actually clear to drive (mask geometry doesn't
 *     know about parked cars, market stalls, or a bridge deck sitting over
 *     a road the mask also typed at ground level). Modelled on
 *     `RainHeightField`'s `start`/`step`/`isReady` shape.
 *
 * Jest-pure by construction: no Rapier, no THREE. The collider pass takes
 * its raycast primitive (`CastDown`) and its clock as injected callbacks;
 * Task 5 wires the real ones (`RapierVehicle`'s scene query, `performance.now`).
 */

/**
 * Drivable-material cost table (engine copy; `game/src/work/TownRoute.ts`'s
 * table is the model this mirrors). Absence from the table = not drivable.
 */
export const VEHICLE_DRIVE_COST: Readonly<Record<number, number>> = {
    [GROUND_TYPE.asphalt]: 1.0,
    [GROUND_TYPE.cobble]: 1.15,
    [GROUND_TYPE.pavers]: 1.3,
    [GROUND_TYPE.brick]: 1.4,
    [GROUND_TYPE.gravel]: 1.8,
    [GROUND_TYPE.dirt]: 2.4,
    [GROUND_TYPE.sidewalk]: 3.5,
};

export const BAKE_STEP_BUDGET_MS = 4;
export const BAKE_PRIOR_BAND_M = 2;          // hit within ±band of prior = ground
export const BAKE_PROP_MIN_ABOVE_M = 0.3;    // non-terrain hit this far above prior…
export const BAKE_PROP_MAX_ABOVE_M = 2.5;    // …up to this = prop blocking the roadway
export const BAKE_CANOPY_SKIP_LIMIT = 8;     // bounded re-casts beneath high clutter
export const BAKE_MIDPOINT_MIN_RISE_M = 0.05; // edge rise that triggers a midpoint sample
/**
 * Lower bound (m) for Fix 2's per-cell OBSTRUCTION BOX query — deliberately
 * separate from `BAKE_PROP_MIN_ABOVE_M`, which stays exactly as it was and
 * keeps doing its own job (the CENTRE-RAY prop/canopy discriminator for a
 * single ray hit: 0.3 m is comfortably above any kerb or step, so a ray
 * landing on a raised kerb edge does not misclassify as a prop).
 *
 * The obstruction BOX instead has to approximate the vehicle's actual swept
 * clearance envelope (`rideHeight ± footprint.height/2` in
 * `PhysicsWorld.probeVehiclePath`'s sweep), which for a low chassis starts
 * well under 0.3 m above the ground. A bollard, kerb-side post or low sign
 * at 0.15-0.3 m clips the real probe's sweep but sat below the old 0.3 m box
 * floor and was invisible to this check — one of the two measured "flat
 * ground, peakGrade≈0" divergence sources task 8 left as a residual. 0.15 m
 * sits just above any climbable step (`derivedStepHeight`'s usual range), so
 * it still leaves genuine kerbs and road texture out of the obstruction box
 * and only catches things tall enough to be a real obstacle, not a step the
 * wheel can mount over.
 */
export const BAKE_OBSTRUCTION_MIN_ABOVE_M = 0.15;
/**
 * Lower bound (m) for the WALL obstruction box — the second per-cell query,
 * which (unlike the prop box above) does NOT exclude the terrain body.
 *
 * Bounded from BOTH sides by measurement, not by taste:
 *
 *  - It must be LOW enough to catch what the runtime probe catches. On the
 *    live target level every residual bake-vs-probe divergence was terrain
 *    geometry standing 0.34 m proud of the road — kerb corners intruding
 *    into the roadway BETWEEN grid cell centres. (`VehicleNavGrid`'s lateral
 *    height rule cannot see those: it compares cell-CENTRE heights, and a
 *    kerb that fouls the car's 1.83 m sweep without covering any neighbouring
 *    cell's centre column leaves every sampled height flat.) A floor of 0.35
 *    catches none of them; 0.25 catches all of them.
 *  - It must be HIGH enough that a road cannot block itself. This box spans
 *    ±0.5 m in XZ around the cell centre and its floor is measured from that
 *    ONE centre height, so on a road of grade `g` the box's far side sits
 *    `0.5 * g` above the floor's reference. At 0.25 m the query tolerates
 *    grades up to 0.5 — comfortably past `maxClimbGrade`'s 0.3 default, i.e.
 *    past anything the vehicle rules call drivable in the first place.
 *
 * Measured live (10-pair convergence harness, terrain-inclusive box, ceiling
 * 1.9): floor 0.45 → 84.7% of legs probe-passable (the divergences are all
 * below the band); 0.35 → 87.5%; 0.25 → 100%; 0.2 and 0.15 → also 100% but
 * flip ~400 more cells to blocked for no gate benefit. 0.25 is the highest —
 * therefore most conservative — floor that closes the gate.
 */
export const BAKE_WALL_MIN_ABOVE_M = 0.25;
/**
 * Upper bound (m) for the WALL obstruction box: ride height + footprint
 * height, mirroring the vertical span `PhysicsWorld.probeVehiclePath`'s swept
 * slab actually covers. Terrain geometry ABOVE that — a high arch, a bridge
 * deck, an overhanging upper storey — is something the car drives underneath,
 * and the runtime probe agrees, so catching it here would block roads the
 * probe calls clear (the exact bake-vs-probe divergence this whole fix exists
 * to remove, only in the other direction).
 */
export const BAKE_WALL_MAX_ABOVE_M = 1.9;
/**
 * Delay (ms) after the FIRST sweep drains before the revalidation sweep
 * re-checks every drivable cell — see `VehicleNavGridBakePass`'s class doc.
 * 8s is comfortably past the async prop/decoration collider registration
 * this exists to catch (measured on the live target game: colliders a fresh
 * `intersectsBox()` query found ~40s after load, that the FIRST sweep — which
 * runs early during level load — had missed).
 */
export const BAKE_REVALIDATE_DELAY_MS = 8000;

/**
 * How far above the band a TERRAIN-body hit is still trusted as a corrected
 * mask prior (see the rule-6 EXCEPT judgment call below), rather than clutter.
 * Not part of the brief's exported constant list — an internal tuning knob for
 * that one rule, not a value any caller needs to reference.
 */
const TERRAIN_ABOVE_BAND_ACCEPT_M = 5;

/** Raw downward raycast primitive supplied by the terrain wiring (real Rapier there,
 *  fakes in tests). Returns the first hit at or below fromY, or null. */
export type CastDown = (x: number, fromY: number, z: number, maxDist: number)
    => { y: number; isTerrainBody: boolean } | null;

/**
 * Per-cell obstruction query supplied by the terrain wiring (real Rapier
 * shape-intersection there, fakes in tests). Returns true when any collider
 * OTHER than the terrain body intersects the cell's obstruction band — a box
 * centred at `(x, groundY + (BAKE_OBSTRUCTION_MIN_ABOVE_M + BAKE_PROP_MAX_ABOVE_M)/2, z)`
 * with half-extents `(0.5, (BAKE_PROP_MAX_ABOVE_M - BAKE_OBSTRUCTION_MIN_ABOVE_M)/2, 0.5)`.
 *
 * Why this exists alongside the centre-ray prop rule already in `classify()`:
 * that rule only sees whatever a SINGLE vertical ray through the cell centre
 * happens to pass through. A prop standing off-centre in the cell (a
 * streetlight base, a market-stall leg, a parked-car-dressing corner) can sit
 * entirely outside that one ray's path while still fouling the car's actual
 * swept footprint — measured as flat, ungraded road (`peakGrade≈0`) that the
 * runtime probe's box sweep still rejects as an obstacle. A box query over
 * the same band the centre ray checks catches those without needing to know
 * where in the cell the prop actually sits.
 */
export type CheckObstruction = (x: number, groundY: number, z: number) => boolean;

/**
 * Per-cell WALL obstruction query supplied by the terrain wiring — the same
 * 1x1 m box footprint as `CheckObstruction`, but over the band
 * `[groundY + BAKE_WALL_MIN_ABOVE_M, groundY + BAKE_WALL_MAX_ABOVE_M]` and
 * WITHOUT excluding the terrain body.
 *
 * Why a second query rather than widening the first: a baked level puts the
 * road surface, its kerbs, and the walls/ledges/arches beside it into ONE
 * static trimesh (this system's single terrain rigid body). `CheckObstruction`
 * must exclude that body by identity — otherwise the road under the box would
 * make every cell block itself — which structurally blinds it to terrain-baked
 * geometry standing in the roadway. Measured on the live target level: every
 * residual bake-vs-probe divergence was a cell where `intersectsBox` INCLUDING
 * the terrain body hit and EXCLUDING it did not. The band's floor is what
 * makes including the terrain body safe — the road surface and any grade the
 * vehicle could actually climb stay below it, so a cell cannot self-block,
 * while a kerb corner or wall standing in the lane does intersect. See
 * `BAKE_WALL_MIN_ABOVE_M` for how both ends of that window were measured.
 */
export type CheckWallObstruction = (x: number, groundY: number, z: number) => boolean;

// ── Mask aggregation (shared by seedFromMask and repaintMaskRect) ─────────

interface MaskAggregate {
    cost: number;
    /**
     * Judgment call: the brief only nails down groundY for two cases —
     * "cheapest in-table sub-cell" when the block IS drivable, and NaN when
     * ALL four sub-cells have no data at all. It leaves the third case (typed
     * sub-cells present, but none of them drivable — e.g. an all-grass block)
     * unspecified beyond "cost 0".
     *
     * We give that third case a real height anyway: the highest topY among
     * the block's typed-but-undrivable sub-cells (mirroring GroundMaskBaker's
     * own "highest typed surface wins" precedent). Reasoning: NaN groundY
     * means "unsurveyed" elsewhere in this system (evaluateGridEdge's rule 2
     * fails 'unknown', not 'blocked-cell', specifically because NaN means "no
     * data", not "not drivable" — a cost-0 material has a perfectly real
     * height). Reserving NaN for "truly no data" also makes a later
     * grass->asphalt repaintMaskRect + enqueueCell/step re-validation work
     * without a NaN prior breaking the collider pass's "prior ± band" cast:
     * a repaint only ever changes what a mask cell already had SOME topY.
     */
    groundY: number;
}

function aggregateMaskBlock(
    grid: VehicleNavGrid, mask: Readonly<GroundMaskData>,
    maskMinX: number, maskMinZ: number, gx: number, gz: number,
): MaskAggregate {
    const worldMinX = grid.dims.minX + gx * grid.dims.cellSize;
    const worldMinZ = grid.dims.minZ + gz * grid.dims.cellSize;
    // Convert through world coordinates rather than assuming the grid and
    // mask origins coincide (they don't, in general — Task 5 sizes/places
    // the grid to cover the mask, not to align with it cell-for-cell).
    const mx0 = Math.floor((worldMinX - maskMinX) / mask.cellSize);
    const mz0 = Math.floor((worldMinZ - maskMinZ) / mask.cellSize);

    let bestCost = 0;
    let bestDriveTopY = 0;
    let bestAnyTopY = 0;

    for (let dz = 0; dz <= 1; dz++) {
        for (let dx = 0; dx <= 1; dx++) {
            const mx = mx0 + dx;
            const mz = mz0 + dz;
            if (mx < 0 || mz < 0 || mx >= mask.width || mz >= mask.height) continue;
            const idx = mz * mask.width + mx;
            const topYQ = mask.topY[idx] ?? 0;
            if (topYQ === 0) continue; // no data — ignored per the brief

            if (topYQ > bestAnyTopY) bestAnyTopY = topYQ;

            const type = mask.types[idx] ?? 0;
            const cost = VEHICLE_DRIVE_COST[type];
            if (cost === undefined) continue; // typed, but not a drivable material

            if (bestCost === 0 || cost < bestCost || (cost === bestCost && topYQ < bestDriveTopY)) {
                bestCost = cost;
                bestDriveTopY = topYQ;
            }
        }
    }

    const groundY = bestCost > 0
        ? bestDriveTopY * GROUND_MASK_HEIGHT_STEP
        : (bestAnyTopY > 0 ? bestAnyTopY * GROUND_MASK_HEIGHT_STEP : NaN);
    return { cost: bestCost, groundY };
}

/** Each undirected edge visited exactly once per cell scanned in raster order. */
const FORWARD_EDGE_DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
    [1, 0], [0, 1], [1, 1], [-1, 1],
];

/** All 8 neighbours — used by the collider pass's rule 7, which the brief states explicitly as "8 neighbours". */
const EIGHT_NEIGHBOR_OFFSETS: ReadonlyArray<readonly [number, number]> = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0], [1, 0],
    [-1, 1], [0, 1], [1, 1],
];

function seedMaskDerivedMidpoints(
    grid: VehicleNavGrid, mask: Readonly<GroundMaskData>, maskMinX: number, maskMinZ: number,
): void {
    for (let gz = 0; gz < grid.dims.height; gz++) {
        for (let gx = 0; gx < grid.dims.width; gx++) {
            if (grid.getCost(gx, gz) <= 0) continue;
            for (const [dx, dz] of FORWARD_EDGE_DIRECTIONS) {
                const ngx = gx + dx;
                const ngz = gz + dz;
                if (!grid.inBounds(ngx, ngz)) continue;
                if (grid.getCost(ngx, ngz) <= 0) continue;

                const yA = grid.getGroundY(gx, gz);
                const yB = grid.getGroundY(ngx, ngz);
                if (Math.abs(yA - yB) <= BAKE_MIDPOINT_MIN_RISE_M) continue;

                const a = grid.cellToWorld(gx, gz);
                const b = grid.cellToWorld(ngx, ngz);
                const midX = (a.x + b.x) / 2;
                const midZ = (a.z + b.z) / 2;
                const idx = groundMaskCellIndex(mask, midX, midZ, maskMinX, maskMinZ);
                if (idx < 0) continue;
                const topYQ = mask.topY[idx] ?? 0;
                if (topYQ === 0) continue; // no data at the intervening column

                grid.setEdgeMidpointY(grid.index(gx, gz), grid.index(ngx, ngz), topYQ * GROUND_MASK_HEIGHT_STEP);
            }
        }
    }
}

/**
 * Synchronous seed from the level's baked ground mask: fills every grid
 * cell's cost/groundY from the 2x2 mask block underneath it, then fills
 * mask-derived edge midpoints wherever two seeded-drivable neighbours
 * disagree in height by more than a kerb-sized step. Flags are untouched
 * (VALIDATED is the collider pass's job — this is a provisional answer).
 */
export function seedFromMask(
    grid: VehicleNavGrid, mask: Readonly<GroundMaskData>,
    maskMinX: number, maskMinZ: number,
): void {
    for (let gz = 0; gz < grid.dims.height; gz++) {
        for (let gx = 0; gx < grid.dims.width; gx++) {
            const { cost, groundY } = aggregateMaskBlock(grid, mask, maskMinX, maskMinZ, gx, gz);
            grid.setCost(gx, gz, cost);
            grid.setGroundY(gx, gz, groundY);
        }
    }
    seedMaskDerivedMidpoints(grid, mask, maskMinX, maskMinZ);
}

/**
 * Re-runs ONLY the cost computation for grid cells intersecting `rect`
 * (world coords) — ground paints change types, not heights, so groundY,
 * flags and midpoints are left exactly as they were. Bumps the grid's
 * revision once if anything changed, and returns the changed cells so the
 * caller (Task 5's wiring) can `enqueueCell` any newly-drivable ones that
 * still lack VALIDATED.
 */
export function repaintMaskRect(
    grid: VehicleNavGrid, mask: Readonly<GroundMaskData>,
    maskMinX: number, maskMinZ: number,
    rect: { minX: number; minZ: number; maxX: number; maxZ: number },
): GridCoord[] {
    const { width, height, cellSize, minX, minZ } = grid.dims;
    const gx0 = Math.max(0, Math.floor((rect.minX - minX) / cellSize));
    const gx1 = Math.min(width - 1, Math.floor((rect.maxX - minX) / cellSize));
    const gz0 = Math.max(0, Math.floor((rect.minZ - minZ) / cellSize));
    const gz1 = Math.min(height - 1, Math.floor((rect.maxZ - minZ) / cellSize));

    const changed: GridCoord[] = [];
    for (let gz = gz0; gz <= gz1; gz++) {
        for (let gx = gx0; gx <= gx1; gx++) {
            const { cost } = aggregateMaskBlock(grid, mask, maskMinX, maskMinZ, gx, gz);
            if (cost !== grid.getCost(gx, gz)) {
                grid.setCost(gx, gz, cost);
                changed.push({ gx, gz });
            }
        }
    }
    if (changed.length > 0) {
        grid.bumpRevision();
    }
    return changed;
}

// ── Collider pass ───────────────────────────────────────────────────────

type CellResolution =
    | { kind: 'ground'; y: number }
    | { kind: 'prop' }
    | { kind: 'closed' };

/**
 * `VehicleNavGridBakePass`'s progress through its two sweeps (see the class
 * doc for why there are two):
 *  - `'initial'` — the first pass over every drivable cell (`start()`'s
 *    queue). On draining, does NOT finish the pass — moves to `'awaiting'`.
 *  - `'awaiting'` — idle, watching the clock, between the two sweeps.
 *  - `'revalidating'` — the second pass, re-enqueued once the delay elapses.
 *    On draining THIS queue, the pass actually finishes.
 */
type BakeStage = 'initial' | 'awaiting' | 'revalidating';

/**
 * Time-sliced collider raycast pass: `start()` queues every drivable cell,
 * `step()` resolves cells under a per-call time budget until the queue is
 * empty. `enqueueCell` lets a repaint re-open the pass for just the cells it
 * changed (restartable).
 *
 * TWO SWEEPS, not one, before the grid is marked fully baked. Measured on the
 * live game this feature targets: `checkObstruction`'s box query missed real
 * obstructions on 6 cells whose STORED bake-time flag read clean, because a
 * FRESH re-query of the exact same box (run ~40s after load, well after the
 * bake pass — which runs early during level load — had already finished)
 * found them. Those colliders (async-loaded decorations/props, or terrain
 * colliders `VxlSceneTerrainSystem` enables partway through load — see
 * `PhysicsWorld.probeVehiclePath`'s doc on the ~15-frame collider-enable
 * delay) simply were not registered in the physics world yet when the first
 * sweep resolved that cell. A single sweep, however early or late it starts,
 * cannot out-race every async loader with certainty — but a SECOND sweep,
 * run `BAKE_REVALIDATE_DELAY_MS` after the first one drains, gives every
 * such loader a real window to finish, and needs no new raycast logic: it
 * reuses the exact same `resolveCell` (classify + checkObstruction) the
 * first sweep already runs, just re-queued via the existing `enqueueCell`
 * machinery repaints already use.
 */
export class VehicleNavGridBakePass {
    private readonly grid: VehicleNavGrid;
    private readonly castDown: CastDown;
    private readonly checkObstruction: CheckObstruction;
    private readonly checkWallObstruction: CheckWallObstruction;
    private readonly now: () => number;

    private queue: GridCoord[] = [];
    private readonly queuedIndices = new Set<number>();
    private done = false;
    private stage: BakeStage = 'initial';
    /** Set the instant the INITIAL sweep's queue first empties; null until then. */
    private firstDrainAt: number | null = null;

    constructor(
        grid: VehicleNavGrid,
        castDown: CastDown,
        checkObstruction: CheckObstruction,
        checkWallObstruction: CheckWallObstruction,
        now: () => number,
    ) {
        this.grid = grid;
        this.castDown = castDown;
        this.checkObstruction = checkObstruction;
        this.checkWallObstruction = checkWallObstruction;
        this.now = now;
    }

    get isDone(): boolean {
        return this.done;
    }

    /** Builds the work queue from every currently-drivable (cost > 0) cell. */
    start(): void {
        this.queue = [];
        this.queuedIndices.clear();
        this.done = false;
        this.stage = 'initial';
        this.firstDrainAt = null;
        for (let gz = 0; gz < this.grid.dims.height; gz++) {
            for (let gx = 0; gx < this.grid.dims.width; gx++) {
                if (this.grid.getCost(gx, gz) > 0) {
                    this.enqueueCellInternal(gx, gz);
                }
            }
        }
    }

    /** Repaint support: re-opens the pass (if it had finished) and queues one cell. */
    enqueueCell(gx: number, gz: number): void {
        this.done = false;
        this.enqueueCellInternal(gx, gz);
    }

    private enqueueCellInternal(gx: number, gz: number): void {
        const idx = this.grid.index(gx, gz);
        if (this.queuedIndices.has(idx)) return;
        this.queuedIndices.add(idx);
        this.queue.push({ gx, gz });
    }

    /** Re-queues every currently-drivable (cost > 0) cell — the revalidation sweep's own `start()`. */
    private enqueueAllDrivableCells(): void {
        for (let gz = 0; gz < this.grid.dims.height; gz++) {
            for (let gx = 0; gx < this.grid.dims.width; gx++) {
                if (this.grid.getCost(gx, gz) > 0) {
                    this.enqueueCellInternal(gx, gz);
                }
            }
        }
    }

    /**
     * Processes queued cells until BAKE_STEP_BUDGET_MS has elapsed or the
     * queue empties. See the class doc for the two-sweep design: draining
     * the INITIAL queue moves to `'awaiting'` (bumps revision — the first
     * sweep's results are real and usable, just not yet the final word) and
     * waits out `BAKE_REVALIDATE_DELAY_MS`; only draining the REVALIDATION
     * queue calls `markFullyBaked()`.
     */
    step(): void {
        if (this.done) return;

        if (this.stage === 'awaiting') {
            if (this.now() - (this.firstDrainAt ?? 0) < BAKE_REVALIDATE_DELAY_MS) return;
            this.stage = 'revalidating';
            this.enqueueAllDrivableCells();
            // Fall through: process this same step() call's budget against
            // the freshly-enqueued revalidation queue, same as any other step.
        }

        const t0 = this.now();
        let processedAny = false;
        while (this.queue.length > 0 && this.now() - t0 < BAKE_STEP_BUDGET_MS) {
            const cell = this.queue.shift()!;
            this.queuedIndices.delete(this.grid.index(cell.gx, cell.gz));
            this.resolveCell(cell.gx, cell.gz);
            processedAny = true;
        }

        if (this.queue.length === 0) {
            if (this.stage === 'initial') {
                // First sweep done — usable, but not final. Bump revision so
                // provisional-vs-initial-sweep consumers see the update; do
                // NOT mark fully baked yet.
                this.stage = 'awaiting';
                this.firstDrainAt = this.now();
                this.grid.bumpRevision();
                return;
            }
            // stage === 'revalidating': the SECOND sweep just drained.
            // markFullyBaked() bumps revision itself — do not ALSO bump
            // below, or the "one bump per changing step() call" contract
            // breaks on the exact call that finishes the pass.
            this.done = true;
            this.grid.markFullyBaked();
            return;
        }
        if (processedAny) {
            this.grid.bumpRevision();
        }
    }

    private resolveCell(gx: number, gz: number): void {
        const prior = this.grid.getGroundY(gx, gz);
        const { x, z } = this.grid.cellToWorld(gx, gz);
        const result = this.classify(x, z, prior);
        // A ground hit (rule 4 or the accepted rule-6 stale-prior correction)
        // still needs the off-centre obstruction check: `classify`'s own prop
        // rule (rule 5) only sees what the single centre ray happens to pass
        // through, so a prop standing off-centre in the cell reads as clean
        // ground here. One extra box query per resolved-ground cell catches
        // it. Mirrors the existing prop rule's outcome exactly (cost/groundY
        // left as seeded, only VALIDATED | PROP_BLOCKED set) — see
        // `applyResolution`'s 'prop' case — by routing to the same branch.
        //
        // TWO obstruction queries, not one: `checkObstruction` covers separate
        // prop bodies (terrain excluded, band from 0.15 m), `checkWallObstruction`
        // covers walls/ledges baked INTO the terrain body (terrain included,
        // band from 0.25 m: above the ~0.15 m a road at max climb grade rises
        // across the box's half-width so road/kerb-adjacent geometry cannot
        // self-block; kerb corners between cell centres sit at 0.34 m and MUST
        // be caught, which is why it is below kerb height).
        // Neither can be expressed as the other — see `CheckWallObstruction`.
        const obstructed = result.kind === 'ground'
            && (this.checkObstruction(x, result.y, z) || this.checkWallObstruction(x, result.y, z));
        const resolution: CellResolution = obstructed ? { kind: 'prop' } : result;
        this.applyResolution(gx, gz, resolution);
        this.resolveMidpoints(gx, gz);
    }

    private applyResolution(gx: number, gz: number, result: CellResolution): void {
        switch (result.kind) {
            case 'closed':
                this.grid.setCost(gx, gz, 0);
                this.grid.setGroundY(gx, gz, NaN);
                this.grid.setFlags(gx, gz, CELL_VALIDATED);
                return;
            case 'ground':
                this.grid.setGroundY(gx, gz, result.y);
                this.grid.setFlags(gx, gz, CELL_VALIDATED);
                return;
            case 'prop':
                // Cost/groundY are left exactly as seeded — diagnostic value
                // (so a follower can still see what material/height it is).
                this.grid.setFlags(gx, gz, CELL_VALIDATED | CELL_PROP_BLOCKED);
                return;
        }
    }

    /**
     * Rules 1-6. `prior` is always a real number for any cell reaching here:
     * only cost>0 cells get queued, and seedFromMask never leaves a cost>0
     * cell with a NaN groundY (see the MaskAggregate doc comment).
     */
    private classify(x: number, z: number, prior: number): CellResolution {
        let fromY = prior + 20;
        let isFirstHit = true;

        for (let attempt = 0; attempt <= BAKE_CANOPY_SKIP_LIMIT; attempt++) {
            const hit = this.castDown(x, fromY, z, 40);
            if (hit === null) return { kind: 'closed' }; // rule 2

            const delta = hit.y - prior;
            if (delta < -BAKE_PRIOR_BAND_M) return { kind: 'closed' }; // rule 3

            if (hit.isTerrainBody && delta > BAKE_PRIOR_BAND_M) {
                // Judgment call (brief rule 6 EXCEPT — documented per the
                // brief's instruction): a TERRAIN-body hit above the band
                // means the mask's prior height itself is stale (edited
                // terrain), not clutter sitting over good road. We only
                // trust that as a correction on the very FIRST cast at this
                // cell — a terrain hit surfacing after we've already
                // skipped past one clutter layer is presumed to be
                // whatever's under that clutter, not a second "the mask is
                // wrong" signal — and only within
                // TERRAIN_ABOVE_BAND_ACCEPT_M (5m): past that, "terrain"
                // and "the road got raised/lowered a bit" stop being a
                // credible pairing (more likely a cliff face or a hill the
                // road tunnels under), so it falls through to the same
                // bounded canopy re-cast as any other clutter.
                if (isFirstHit && delta <= TERRAIN_ABOVE_BAND_ACCEPT_M) {
                    return { kind: 'ground', y: hit.y }; // accepted correction
                }
            } else if (!hit.isTerrainBody
                && delta >= BAKE_PROP_MIN_ABOVE_M && delta <= BAKE_PROP_MAX_ABOVE_M) {
                return { kind: 'prop' }; // rule 5
            } else if (delta <= BAKE_PRIOR_BAND_M) {
                return { kind: 'ground', y: hit.y }; // rule 4
            }

            // rule 6: clutter (canopy/bridge/awning, or an unaccepted terrain
            // correction above) — re-cast just beneath this hit, bounded.
            fromY = hit.y - 0.05;
            isFirstHit = false;
        }
        return { kind: 'closed' }; // BAKE_CANOPY_SKIP_LIMIT exhausted
    }

    /**
     * Rule 7: for each of the 8 neighbours already VALIDATED, if the two
     * cells' heights disagree by more than BAKE_MIDPOINT_MIN_RISE_M, fire one
     * midpoint ray (ground band only — no canopy re-cast loop, this is a
     * single sample) and store it.
     *
     * Judgment call (documented per the brief's instruction, which itself
     * talks through and discards a fancier "prop window vs the mean" design
     * in favour of this simpler one): a midpoint cast that does NOT land
     * within the band around the two cells' mean height — no hit, a prop,
     * or canopy — leaves whatever midpoint is already stored (typically the
     * mask-seeded one from `seedFromMask`) untouched. Inventing a height
     * from a failed classification would be strictly worse than the
     * provisional mask answer it would silently replace.
     */
    private resolveMidpoints(gx: number, gz: number): void {
        const y = this.grid.getGroundY(gx, gz);
        if (Number.isNaN(y)) return; // this cell isn't ground — no edges to pair

        for (const [dx, dz] of EIGHT_NEIGHBOR_OFFSETS) {
            const ngx = gx + dx;
            const ngz = gz + dz;
            if (!this.grid.inBounds(ngx, ngz)) continue;
            if ((this.grid.getFlags(ngx, ngz) & CELL_VALIDATED) === 0) continue;

            const ny = this.grid.getGroundY(ngx, ngz);
            if (Number.isNaN(ny)) continue;
            if (Math.abs(y - ny) <= BAKE_MIDPOINT_MIN_RISE_M) continue;

            const meanY = (y + ny) / 2;
            const a = this.grid.cellToWorld(gx, gz);
            const b = this.grid.cellToWorld(ngx, ngz);
            const midX = (a.x + b.x) / 2;
            const midZ = (a.z + b.z) / 2;
            const hit = this.castDown(midX, meanY + 20, midZ, 40);

            if (hit !== null && Math.abs(hit.y - meanY) <= BAKE_PRIOR_BAND_M) {
                this.grid.setEdgeMidpointY(this.grid.index(gx, gz), this.grid.index(ngx, ngz), hit.y);
            }
        }
    }
}
