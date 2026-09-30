/**
 * GoalField — a resumable Dijkstra flood-fill cost field around a goal.
 *
 * Gives O(1) per-NPC navigation for hordes: one flood per shared goal (e.g.
 * "the player"), then every NPC samples the local downhill gradient instead of
 * running its own A*. Fields are double-buffered — the completed front buffer
 * keeps serving sampleDirection while a back buffer rebuilds after the goal
 * moves or the navmesh changes. GoalFieldManager owns the fields (LRU-capped)
 * and splits a fixed expansion budget across incomplete fields each frame;
 * CharacterLodScheduler drains it once per frame next to the path queue.
 *
 * ## Layers
 * Nodes are `(cell, layer)` pairs, keyed exactly like VoxelNavMesh's A* —
 * `localCellIndex * MAX_NAV_LAYERS + layerSlot` — so stacked floors of the
 * same column are distinct nodes, reachable from each other only through
 * cells that actually connect them (a stair, a ramp). Unlike VoxelNavMesh,
 * GoalField has no private access to a cell's real layer indices, so a
 * `layerSlot` here is GoalField's OWN per-cell numbering: the first time a
 * physical layer is discovered at a cell (via `getCellGroundY(gx, gz,
 * refHeight)`, nearest-layer semantics identical to `nearestLayerIdx`) it is
 * assigned the next free slot, and later queries that land on the exact same
 * groundY (deterministic given a fixed underlying navmesh) reuse that slot.
 * This keeps cost/groundY storage SPARSE — a `Map` keyed by node, sized to
 * the layered cells actually expanded — rather than a dense array scaled by
 * `cells x MAX_NAV_LAYERS`. On a single-layer world every cell has exactly
 * one slot, so this is bit-identical to the pre-layer implementation.
 */
import * as THREE from 'three';
import { MAX_NAV_LAYERS } from 'engine/nav/NavSerialization.js';

/** Structural interface over VoxelNavMesh's cell API (lets tests fake it). */
export interface CellNavSource {
    isReady(): boolean;
    getGridInfo(): { cols: number; rows: number; minX: number; minZ: number; cellSize: number } | null;
    /** `refY` picks the stacked layer nearest that height; without it the topmost layer answers (matches VoxelNavMesh). */
    getCellGroundY(gx: number, gz: number, refY?: number): number | null;
    /** `fromRefY` selects which stacked layer of the source cell the step originates from. */
    canStepCells(fromGx: number, fromGz: number, toGx: number, toGz: number, fromRefY?: number): boolean;
    worldToCell(x: number, z: number): { gx: number; gz: number } | null;
    cellToWorld(gx: number, gz: number): { x: number; z: number };
    getCellMutationVersion(): number;
    /** Step-height limits for local edge checks (optional; defaults are conservative). */
    getStepLimits?(): { maxClimbUp: number; maxDropDown: number };
}

/** Fallback step limits when the nav source does not expose its own. */
const DEFAULT_STEP_LIMITS = { maxClimbUp: 1.0, maxDropDown: 2.5 } as const;

export const GOAL_FIELD_DEFAULTS = {
    radiusM: 150,
    rebuildMoveCells: 2,
    rebuildMinIntervalS: 0.5,
    /** Version-only staleness (dynamic obstacle repaints) refreshes at most this often. */
    staleRebuildIntervalS: 5,
    /**
     * Shared across all fields, split by the manager. Sized so one 300x300
     * rebuild spans slightly LONGER than rebuildMinIntervalS: while a goal
     * moves continuously (car chase) the flood runs as a small constant
     * per-frame cost instead of a heavy-light 2 Hz oscillation (visible jerk).
     */
    expansionsPerFrame: 2000,
    maxActiveFields: 4,
} as const;

/** How far (in cells, Chebyshev rings) to search for a walkable flood anchor
 *  when the goal cell itself is blocked or off-mesh. */
const GOAL_ANCHOR_SEARCH_RADIUS_CELLS = 6;

/**
 * Quantized integer edge costs (Dial's bucket-queue Dijkstra): 12 per cardinal
 * step, 17 per diagonal (12 * sqrt2 = 16.97). Integer costs give exact
 * comparisons (no f32 rounding hacks), O(1) bucket push/pop instead of a
 * binary heap, and zero per-node object allocation — the heap version cost a
 * whole frame budget per 4000-pop slice.
 */
const COST_SCALE = 12;
const CARDINAL_COST_Q = 12;
const DIAGONAL_COST_Q = 17;

/**
 * Convergence epsilon for the step-limited layer search below. Real layer
 * heights are quantized (baseY + delta*voxelSize), so two genuinely distinct
 * layers are always separated by at least one quantization step — comfortably
 * larger than this.
 */
const LAYER_SEARCH_EPSILON = 1e-6;

/** 8-neighbor offsets with quantized step costs. */
const NEIGHBOR_OFFSETS: ReadonlyArray<readonly [number, number, number]> = [
    [1, 0, CARDINAL_COST_Q], [-1, 0, CARDINAL_COST_Q], [0, 1, CARDINAL_COST_Q], [0, -1, CARDINAL_COST_Q],
    [1, 1, DIAGONAL_COST_Q], [1, -1, DIAGONAL_COST_Q], [-1, 1, DIAGONAL_COST_Q], [-1, -1, DIAGONAL_COST_Q],
];

/**
 * Per-cell layer registry local to one FieldBuffer. `heights[slot]` is the
 * discovered groundY of that slot (populated lazily, in discovery order —
 * NOT necessarily the mesh's own internal layer order); capped at
 * MAX_NAV_LAYERS entries, matching the mesh's own per-cell layer cap.
 */
interface CellLayerInfo {
    heights: number[];
}

/** One completed (or building) cost window centered on the goal cell. */
interface FieldBuffer {
    /**
     * Quantized cost (COST_SCALE units) per (cell,layer) node key, sparse:
     * only nodes actually reached during the flood are present. Bounded by
     * walkable layered cells actually expanded, never by
     * `windowCells * MAX_NAV_LAYERS`.
     */
    cost: Map<number, number>;
    /** Per-cell discovered layer heights, keyed by local cell index. */
    cellLayers: Map<number, CellLayerInfo>;
    /** Window origin in grid coordinates. */
    originGx: number;
    originGz: number;
    /** Window side length in cells. */
    side: number;
    /** Grid metadata captured at build start. */
    minX: number;
    minZ: number;
    cellSize: number;
    maxClimbUp: number;
    maxDropDown: number;
    goalWorld: THREE.Vector3;
    /**
     * Discretized groundY of the goal's own resolved layer at build time (the
     * same value used to anchor the flood, before any nearest-walkable-cell
     * fallback), or null if the goal cell had no layer at all. Compared
     * against the CURRENT desiredGoal's resolved layer in checkInvalidation
     * so a floor change at the same (x,z) — an elevator — triggers a rebuild
     * the same way an XZ move does; comparing this discretized value instead
     * of raw Y avoids spurious rebuilds from per-frame Y jitter.
     */
    goalLayerGroundY: number | null;
    /** Nav source + mutation version captured at build start (invalidation). */
    source: CellNavSource;
    mutationVersion: number;
    /** Manager clock time when this buffer's build started (staleness). */
    builtAtS: number;
}

interface BuildState {
    buffer: FieldBuffer;
    /** Dial's bucket queue: quantized cost -> node keys (sparse array). */
    buckets: number[][];
    /** Monotone scan cursor over buckets (Dijkstra pops are non-decreasing). */
    bucketCursor: number;
    /** Total entries currently queued across all buckets. */
    pending: number;
}

export class GoalField {
    readonly key: string;
    private readonly radiusM: number;

    private desiredGoal: THREE.Vector3 | null = null;
    /** Completed buffer serving sampleDirection/getCost. */
    private front: FieldBuffer | null = null;
    /** In-progress back-buffer flood. */
    private building: BuildState | null = null;
    /** A (re)build is wanted but has not started yet (interval-gated). */
    private buildRequested = false;

    /** Monotonic clock advanced by the manager; gates rebuild frequency. */
    private clockS = 0;
    private lastBuildStartS = -Infinity;

    constructor(key: string, radiusM: number = GOAL_FIELD_DEFAULTS.radiusM) {
        this.key = key;
        this.radiusM = radiusM;
    }

    /** Advance the internal clock (called by the manager once per frame). */
    advanceClock(deltaTime: number): void {
        this.clockS += deltaTime;
    }

    /**
     * Set/move the goal. The first call requests an immediate build; later
     * calls request a back-buffer rebuild only when the goal moved more than
     * rebuildMoveCells * cellSize (the actual start is additionally gated by
     * rebuildMinIntervalS in updateSlice; the front buffer keeps serving).
     */
    setGoal(pos: THREE.Vector3): void {
        if (this.desiredGoal) this.desiredGoal.copy(pos);
        else this.desiredGoal = pos.clone();

        const ref = this.building?.buffer ?? this.front;
        if (!ref) {
            this.buildRequested = true;
            return;
        }
        const dx = pos.x - ref.goalWorld.x;
        const dz = pos.z - ref.goalWorld.z;
        const threshold = GOAL_FIELD_DEFAULTS.rebuildMoveCells * ref.cellSize;
        if (dx * dx + dz * dz > threshold * threshold) this.buildRequested = true;
    }

    /** True when no build is in progress and none is pending. */
    isComplete(): boolean {
        return this.building === null && !this.buildRequested;
    }

    /**
     * Run up to maxExpansions Dijkstra bucket pops on the back buffer,
     * starting a pending build first if the rebuild interval allows. When the
     * queue empties the back buffer swaps to front.
     */
    updateSlice(nav: CellNavSource, maxExpansions: number): void {
        if (!nav.isReady()) return;
        this.maybeStartBuild(nav);
        const b = this.building;
        if (!b) return;

        const { buffer, buckets } = b;
        const side = buffer.side;
        let expansions = 0;
        while (expansions < maxExpansions && b.pending > 0) {
            // Advance to the next non-empty bucket (monotone; never rewinds).
            let bucket = buckets[b.bucketCursor];
            while (!bucket || bucket.length === 0) {
                b.bucketCursor++;
                bucket = buckets[b.bucketCursor];
            }
            const curKey = bucket.pop()!;
            b.pending--;
            const costC = b.bucketCursor;
            if (buffer.cost.get(curKey) !== costC) continue; // stale entry (improved since queued)
            expansions++;

            const layerC = curKey % MAX_NAV_LAYERS;
            const localC = (curKey - layerC) / MAX_NAV_LAYERS;
            const cGx = buffer.originGx + (localC % side);
            const cGz = buffer.originGz + ((localC / side) | 0);
            const gyC = buffer.cellLayers.get(localC)?.heights[layerC];
            if (gyC === undefined) continue; // defensive: a queued node always has a known height

            for (const [dx, dz, stepCostQ] of NEIGHBOR_OFFSETS) {
                const nGx = cGx + dx;
                const nGz = cGz + dz;
                const localN = this.localIndex(buffer, nGx, nGz);
                if (localN === -1) continue;
                // Step-limited-nearest, not unconstrained-nearest: a neighbor
                // layer that's the closest BY RAW DISTANCE to gyC can still be
                // an illegal climb/drop while a farther layer is a legal one
                // (see resolveReachableLayer's doc). Using the unconstrained
                // nearest here would silently reject a genuinely reachable cell.
                const resolved = this.resolveReachableLayer(buffer, localN, nGx, nGz, gyC);
                if (!resolved) continue; // no layer of N is legally reachable from C's height
                const nKey = this.nodeKey(localN, resolved.slot);
                const nCost = costC + stepCostQ;
                const existing = buffer.cost.get(nKey);
                if (existing !== undefined && nCost >= existing) continue;
                // The NPC walks N -> C (downhill toward the goal), so the step
                // legality check is from the neighbor into this cell.
                if (!this.canStepLayered(buffer, gyC, resolved.groundY, dx, dz, cGx, cGz, nGx, nGz)) continue;
                buffer.cost.set(nKey, nCost);
                (buckets[nCost] ??= []).push(nKey);
                b.pending++;
            }
        }
        if (b.pending === 0) {
            this.front = buffer;
            this.building = null;
        }
    }

    /**
     * Normalized world-space XZ direction the NPC at (x, z, refY) should
     * walk: toward the center of the cheapest steppable 8-neighbor of its
     * cell. `refY` resolves which stacked layer the agent is standing on
     * (nearest-layer semantics identical to VoxelNavMesh's `nearestLayerIdx`);
     * omitted, it falls back to the topmost layer with recorded cost — the
     * same 2.5D convention VoxelNavMesh itself uses when refY is omitted, and
     * bit-identical to the old behavior on a single-layer world. Null when
     * outside the window, unreachable, or already at the goal.
     */
    sampleDirection(x: number, z: number, refY?: number): THREE.Vector3 | null {
        const f = this.front;
        if (!f) return null;
        const gx = Math.floor((x - f.minX) / f.cellSize);
        const gz = Math.floor((z - f.minZ) / f.cellSize);
        const local = this.localIndex(f, gx, gz);
        if (local === -1) return null;

        const here = this.resolveHere(f, local, gx, gz, refY);
        if (!here) return null;
        const hereCost = f.cost.get(this.nodeKey(local, here.slot));
        if (hereCost === undefined || hereCost === 0) return null;

        let bestGx = 0;
        let bestGz = 0;
        let bestCost = hereCost;
        let found = false;
        for (const [dx, dz] of NEIGHBOR_OFFSETS) {
            const nGx = gx + dx;
            const nGz = gz + dz;
            const localN = this.localIndex(f, nGx, nGz);
            if (localN === -1) continue;
            // "here" is the agent's own fixed height and N is the real
            // destination being resolved — the TRUE reachableLayerIdx
            // direction (resolveStepTarget), not the flood's inverted one
            // (resolveReachableLayer) which would apply the wrong-signed
            // climb/drop bounds and reject legal drops like the reviewer's.
            const resolved = this.resolveStepTarget(f, localN, nGx, nGz, here.groundY);
            if (!resolved) continue;
            const c = f.cost.get(this.nodeKey(localN, resolved.slot));
            if (c === undefined || c >= bestCost) continue;
            if (!f.source.canStepCells(gx, gz, nGx, nGz, here.groundY)) continue;
            bestGx = nGx;
            bestGz = nGz;
            bestCost = c;
            found = true;
        }
        if (!found) return null;
        const center = f.source.cellToWorld(bestGx, bestGz);
        const dir = new THREE.Vector3(center.x - x, 0, center.z - z);
        if (dir.lengthSq() < 1e-12) return null;
        return dir.normalize();
    }

    /** Front-buffer cost at a world position (`refY` selects the layer, as in sampleDirection), or null if outside/unreachable. */
    getCost(x: number, z: number, refY?: number): number | null {
        const f = this.front;
        if (!f) return null;
        const gx = Math.floor((x - f.minX) / f.cellSize);
        const gz = Math.floor((z - f.minZ) / f.cellSize);
        const local = this.localIndex(f, gx, gz);
        if (local === -1) return null;
        const here = this.resolveHere(f, local, gx, gz, refY);
        if (!here) return null;
        const c = f.cost.get(this.nodeKey(local, here.slot));
        return c === undefined ? null : c / COST_SCALE;
    }

    /**
     * Number of distinct (cell, layer) nodes discovered by the completed
     * front buffer. Sparse and bounded by walkable layered cells actually
     * expanded — never by `windowCells * MAX_NAV_LAYERS` — since cost and
     * per-cell layer heights are keyed maps, not dense arrays sized for the
     * worst case. Test/diagnostic support.
     */
    getExpandedNodeCount(): number {
        return this.front?.cost.size ?? 0;
    }

    /**
     * Request a rebuild when the navmesh the front buffer was built from is
     * stale. Two triggers with very different urgency:
     * - The global instance was SWAPPED (terrain rebuild): rebuild promptly.
     * - Only the cell MUTATION VERSION changed: that counter is bumped by
     *   dynamic-obstacle repaints — including the player's own vehicle, which
     *   repaints its footprint every time it moves a cell. Rebuilding on every
     *   bump made the flood run continuously while driving (the 2 Hz stall).
     *   Moving obstacles barely matter to a horde-scale field (NPCs resolve
     *   them locally), so version-only staleness refreshes lazily.
     * The front keeps serving until the rebuild completes; the actual start
     * additionally respects rebuildMinIntervalS.
     */
    checkInvalidation(nav: CellNavSource): void {
        if (!this.front || !this.desiredGoal) return;
        if (this.building) {
            const bb = this.building.buffer;
            if (bb.source === nav) return; // an up-to-date-enough rebuild is already in flight
        }
        if (nav !== this.front.source) {
            this.buildRequested = true;
            return;
        }
        if (
            nav.getCellMutationVersion() !== this.front.mutationVersion
            && this.clockS - this.front.builtAtS >= GOAL_FIELD_DEFAULTS.staleRebuildIntervalS
        ) {
            this.buildRequested = true;
            return;
        }
        // Floor change at the same (x,z) — an elevator/shaft — moves the goal
        // by zero in XZ, so setGoal's move-threshold never fires. Compare the
        // DISCRETIZED (actual layer) groundY, not the raw Y, so per-frame
        // jitter around the same floor never trips this.
        const goalCell = nav.worldToCell(this.desiredGoal.x, this.desiredGoal.z);
        if (goalCell) {
            const currentGoalLayerY = nav.getCellGroundY(goalCell.gx, goalCell.gz, this.desiredGoal.y);
            if (currentGoalLayerY !== this.front.goalLayerGroundY) {
                this.buildRequested = true;
            }
        }
    }

    /**
     * Resolve the (cell,layer) slot nearest `refHeight`. If `refHeight`
     * exactly matches an already-discovered slot's groundY, that slot is
     * returned without a nav query — heights are quantized/deterministic, so
     * an exact match is provably the nearest (distance zero). Otherwise a
     * fresh `getCellGroundY(gx, gz, refHeight)` query resolves it, and either
     * reuses a matching existing slot or assigns the next free one (capped at
     * MAX_NAV_LAYERS, matching the mesh's own per-cell layer cap). This keeps
     * per-cell nav queries down to one per DISTINCT height ever asked at that
     * cell — for a flat single-layer run every caller asks the same height,
     * so this is exactly the old "one query per cell, ever" behavior; for a
     * genuinely layered cell (e.g. a stair) it degrades gracefully to one
     * query per distinct incoming height, still far below the naive
     * one-per-edge count the comment on the old groundY cache warned about.
     */
    private resolveLayer(
        buffer: FieldBuffer,
        localCell: number,
        gx: number,
        gz: number,
        refHeight: number,
    ): { slot: number; groundY: number } | null {
        let info = buffer.cellLayers.get(localCell);
        if (info) {
            const known = info.heights.indexOf(refHeight);
            if (known !== -1) return { slot: known, groundY: refHeight };
        }
        const gy = buffer.source.getCellGroundY(gx, gz, refHeight);
        if (gy === null) return null;
        if (!info) {
            info = { heights: [] };
            buffer.cellLayers.set(localCell, info);
        }
        let slot = info.heights.indexOf(gy);
        if (slot === -1) {
            if (info.heights.length >= MAX_NAV_LAYERS) {
                // Should never happen (the mesh caps at MAX_NAV_LAYERS layers
                // per cell); fall back to the closest known slot rather than
                // growing unbounded.
                slot = 0;
                let bestDist = Math.abs(info.heights[0]! - gy);
                for (let i = 1; i < info.heights.length; i++) {
                    const dist = Math.abs(info.heights[i]! - gy);
                    if (dist < bestDist) { bestDist = dist; slot = i; }
                }
            } else {
                info.heights.push(gy);
                slot = info.heights.length - 1;
            }
        }
        return { slot, groundY: gy };
    }

    /**
     * Shared step-limited search: the (cell,layer) slot of (gx,gz) nearest to
     * `refHeight` among layers whose groundY falls within `[lo, hi]`. Plain
     * `resolveLayer` is NOT equivalent to a legality-filtered search: it is
     * nearest by raw distance regardless of `[lo, hi]`, so it can pick a
     * nearby-but-out-of-range layer and make callers reject the whole edge
     * even when a farther, in-range layer exists (see resolveReachableLayer's
     * doc for the reviewer's exact scenario). When the unconstrained-nearest
     * layer already satisfies `[lo, hi]` it is trivially also the closest
     * IN-RANGE one (nothing is closer), so this only does extra work in the
     * violation case, and there is no enumerate-all-layers API to fall back
     * on — this is a bounded bisection search against the same nearest-by-
     * distance primitive instead (see smallestLayerAbove/largestLayerBelow).
     */
    private nearestLayerInRange(
        buffer: FieldBuffer,
        localCell: number,
        gx: number,
        gz: number,
        refHeight: number,
        lo: number,
        hi: number,
    ): { slot: number; groundY: number } | null {
        const nearest = this.resolveLayer(buffer, localCell, gx, gz, refHeight);
        if (!nearest) return null;
        if (nearest.groundY >= lo && nearest.groundY <= hi) return nearest;
        // The globally-nearest layer is out of range. Nothing can sit
        // strictly between it and refHeight (it would have won the
        // unconstrained query instead), so any in-range candidate must be on
        // the OTHER side of refHeight.
        const found = nearest.groundY < lo
            ? this.smallestLayerAbove(buffer, localCell, gx, gz, refHeight, hi)
            : this.largestLayerBelow(buffer, localCell, gx, gz, refHeight, lo);
        if (!found || found.groundY < lo || found.groundY > hi) return null;
        return found;
    }

    /**
     * Resolve the (cell,layer) slot of (gx,gz) a neighbor legally steps INTO
     * given a FIXED destination height `toHeight` (the flood's already-known
     * C node) — i.e. solve for a legal "from" given a fixed "to", the inverse
     * of VoxelNavMesh's `reachableLayerIdx` (which fixes "from" and searches
     * "to"; see resolveStepTarget for that direction). Bounds:
     * `gyFrom in [toHeight - maxClimbUp, toHeight + maxDropDown]` — from
     * `heightDiff = toHeight - gyFrom` staying within `[-maxDropDown,
     * maxClimbUp]`. Used only where a neighbor's layer is being resolved
     * against an already-fixed destination height during flood expansion.
     *
     * Concrete case this fixes over plain `resolveLayer`: from height 2 with
     * maxClimbUp=1/maxDropDown=2, a neighbor with layers at 0.9 (nearest by
     * raw distance, but a 1.1 m over-limit climb) and 3.5 (farther, but a
     * legal 1.5 m drop) must resolve to 3.5, not reject the cell.
     */
    private resolveReachableLayer(
        buffer: FieldBuffer,
        localCell: number,
        gx: number,
        gz: number,
        toHeight: number,
    ): { slot: number; groundY: number } | null {
        return this.nearestLayerInRange(
            buffer, localCell, gx, gz, toHeight,
            toHeight - buffer.maxClimbUp, toHeight + buffer.maxDropDown,
        );
    }

    /**
     * Resolve the (cell,layer) slot of (gx,gz) legally steppable from a FIXED
     * standing height `fromHeight` — VoxelNavMesh's `reachableLayerIdx`
     * proper (what `canStep`/`canStepCells` use to pick a step's destination
     * layer). Bounds: `candidate in [fromHeight - maxDropDown, fromHeight +
     * maxClimbUp]` — from `heightDiff = candidate - fromHeight` staying
     * within `[-maxDropDown, maxClimbUp]`. Used wherever an agent's own
     * height is fixed and a real destination is being resolved: sampling a
     * neighbor's cost from the agent's current cell, and the diagonal
     * corner checks in canStepLayered (both resolved relative to the cell
     * whose height is already pinned, not the one being searched for).
     */
    private resolveStepTarget(
        buffer: FieldBuffer,
        localCell: number,
        gx: number,
        gz: number,
        fromHeight: number,
    ): { slot: number; groundY: number } | null {
        return this.nearestLayerInRange(
            buffer, localCell, gx, gz, fromHeight,
            fromHeight - buffer.maxDropDown, fromHeight + buffer.maxClimbUp,
        );
    }

    /**
     * Smallest discovered layer of (gx,gz) strictly greater than `x`, found
     * by bisection against the nearest-by-distance primitive (there is no
     * enumerate-layers API). Terminates in at most MAX_NAV_LAYERS iterations:
     * for any two values A<B where A is not itself a member of the layer set,
     * a hidden layer strictly between them is provably nearer to their
     * midpoint than either A or B (or anything outside [A,B]) is — so
     * querying the midpoint either finds a strictly-closer genuine layer
     * (tightening the bracket) or proves none exists (nearest-to-midpoint
     * comes back unchanged). There are at most MAX_NAV_LAYERS distinct layers
     * total, so the tightening step can only happen that many times.
     */
    private smallestLayerAbove(
        buffer: FieldBuffer,
        localCell: number,
        gx: number,
        gz: number,
        x: number,
        upperBound: number,
    ): { slot: number; groundY: number } | null {
        let best = this.resolveLayer(buffer, localCell, gx, gz, upperBound);
        if (!best || best.groundY <= x) return null;
        for (let i = 0; i < MAX_NAV_LAYERS; i++) {
            if (best.groundY - x < LAYER_SEARCH_EPSILON) break;
            const mid = (x + best.groundY) / 2;
            const probe = this.resolveLayer(buffer, localCell, gx, gz, mid);
            if (!probe || probe.groundY === best.groundY) break;
            best = probe;
        }
        return best;
    }

    /** Mirror of smallestLayerAbove: the largest discovered layer strictly less than `x`. */
    private largestLayerBelow(
        buffer: FieldBuffer,
        localCell: number,
        gx: number,
        gz: number,
        x: number,
        lowerBound: number,
    ): { slot: number; groundY: number } | null {
        let best = this.resolveLayer(buffer, localCell, gx, gz, lowerBound);
        if (!best || best.groundY >= x) return null;
        for (let i = 0; i < MAX_NAV_LAYERS; i++) {
            if (x - best.groundY < LAYER_SEARCH_EPSILON) break;
            const mid = (x + best.groundY) / 2;
            const probe = this.resolveLayer(buffer, localCell, gx, gz, mid);
            if (!probe || probe.groundY === best.groundY) break;
            best = probe;
        }
        return best;
    }

    /**
     * Resolve the layer sampleDirection/getCost should read at (gx, gz):
     * nearest to `refY` when given, else the topmost DISCOVERED layer that
     * still has a recorded cost (mirrors VoxelNavMesh's own "topmost when
     * refY is omitted" convention for the completed, fully-expanded front
     * buffer). On a single-layer cell there is at most one candidate either
     * way, so this is bit-identical to the pre-layer implementation.
     */
    private resolveHere(
        buffer: FieldBuffer,
        localCell: number,
        gx: number,
        gz: number,
        refY?: number,
    ): { slot: number; groundY: number } | null {
        if (refY !== undefined) return this.resolveLayer(buffer, localCell, gx, gz, refY);
        const info = buffer.cellLayers.get(localCell);
        if (!info) return null;
        let bestSlot = -1;
        let bestGy = -Infinity;
        for (let slot = 0; slot < info.heights.length; slot++) {
            if (buffer.cost.get(this.nodeKey(localCell, slot)) === undefined) continue;
            const gy = info.heights[slot]!;
            if (gy > bestGy) {
                bestGy = gy;
                bestSlot = slot;
            }
        }
        return bestSlot === -1 ? null : { slot: bestSlot, groundY: bestGy };
    }

    /**
     * Local replication of VoxelNavMesh.canStep for the walk N -> C, given
     * N's already-resolved groundY: both cells walkable (implied — callers
     * only reach here after a successful layer resolution), climb-up/drop-
     * down caps (asymmetric, from N's perspective), and diagonal moves
     * additionally require both cardinal neighbors of N to be steppable (no
     * corner cutting) — matching VoxelNavMesh's own diagonal check, each
     * corner resolved via `resolveStepTarget` (step-limited-nearest to N's
     * height, VoxelNavMesh's own `reachableLayerIdx` direction), not plain
     * nearest.
     */
    private canStepLayered(
        buffer: FieldBuffer,
        gyC: number,
        gyN: number,
        dx: number,
        dz: number,
        cGx: number,
        cGz: number,
        nGx: number,
        nGz: number,
    ): boolean {
        const heightDiff = gyC - gyN; // walking N -> C
        if (heightDiff > buffer.maxClimbUp) return false;
        if (heightDiff < -buffer.maxDropDown) return false;
        if (dx !== 0 && dz !== 0) {
            // Diagonal: both cardinal steps out of N (toward C) must be legal.
            // Cardinal cells relative to N are (cGx, nGz) and (nGx, cGz). N's
            // height is the FIXED "from" here (matching VoxelNavMesh's own
            // `reachableLayerIdx(fromGx+dx, fromGz, from.groundY)`), so this
            // is resolveStepTarget's direction, not resolveReachableLayer's.
            const localA = this.localIndex(buffer, cGx, nGz);
            if (localA === -1) return false;
            if (!this.resolveStepTarget(buffer, localA, cGx, nGz, gyN)) return false;
            const localB = this.localIndex(buffer, nGx, cGz);
            if (localB === -1) return false;
            if (!this.resolveStepTarget(buffer, localB, nGx, cGz, gyN)) return false;
        }
        return true;
    }

    /** Local window index for grid coords, or -1 when outside the window. */
    private localIndex(buffer: FieldBuffer, gx: number, gz: number): number {
        const lx = gx - buffer.originGx;
        const lz = gz - buffer.originGz;
        if (lx < 0 || lz < 0 || lx >= buffer.side || lz >= buffer.side) return -1;
        return lx + lz * buffer.side;
    }

    /** Node key for a (cell, layer) pair, matching A*'s `cellKey * MAX_NAV_LAYERS + layer` scheme. */
    private nodeKey(localCell: number, slot: number): number {
        return localCell * MAX_NAV_LAYERS + slot;
    }

    private maybeStartBuild(nav: CellNavSource): void {
        if (this.building || !this.buildRequested || !this.desiredGoal) return;
        // First build starts immediately; rebuilds are rate-limited.
        if (this.front && this.clockS - this.lastBuildStartS < GOAL_FIELD_DEFAULTS.rebuildMinIntervalS) return;
        const info = nav.getGridInfo();
        const goalCell = nav.worldToCell(this.desiredGoal.x, this.desiredGoal.z);
        if (!info || !goalCell) return;

        const side = Math.max(1, Math.ceil((2 * this.radiusM) / info.cellSize));
        const half = side >> 1;
        const limits = nav.getStepLimits?.() ?? DEFAULT_STEP_LIMITS;
        // When the goal cell itself is blocked/off-mesh at the goal's own
        // height (e.g. the player stands on a prop, or the goal sits on a
        // different floor than this cell's other stacked layer), anchor the
        // flood at the nearest walkable cell instead so the field still
        // routes NPCs to the goal's edge. If no walkable cell exists nearby,
        // the field completes empty and samplers return null. This same
        // discretized query is also the goal's floor fingerprint, recorded
        // below for checkInvalidation's floor-change rebuild trigger.
        const goalRefY = this.desiredGoal.y;
        const goalLayerGroundY = nav.getCellGroundY(goalCell.gx, goalCell.gz, goalRefY);
        const buffer: FieldBuffer = {
            cost: new Map(),
            cellLayers: new Map(),
            originGx: goalCell.gx - half,
            originGz: goalCell.gz - half,
            side,
            minX: info.minX,
            minZ: info.minZ,
            cellSize: info.cellSize,
            maxClimbUp: limits.maxClimbUp,
            maxDropDown: limits.maxDropDown,
            goalWorld: this.desiredGoal.clone(),
            goalLayerGroundY,
            source: nav,
            mutationVersion: nav.getCellMutationVersion(),
            builtAtS: this.clockS,
        };
        const buckets: number[][] = [];
        let pending = 0;
        const anchor = goalLayerGroundY !== null
            ? goalCell
            : this.findNearestWalkableCell(nav, goalCell.gx, goalCell.gz, GOAL_ANCHOR_SEARCH_RADIUS_CELLS, goalRefY);
        if (anchor) {
            const anchorLocal = this.localIndex(buffer, anchor.gx, anchor.gz);
            if (anchorLocal !== -1) {
                const resolved = this.resolveLayer(buffer, anchorLocal, anchor.gx, anchor.gz, goalRefY);
                if (resolved) {
                    const anchorKey = this.nodeKey(anchorLocal, resolved.slot);
                    buffer.cost.set(anchorKey, 0);
                    buckets[0] = [anchorKey];
                    pending = 1;
                }
            }
        }
        this.building = { buffer, buckets, bucketCursor: 0, pending };
        this.buildRequested = false;
        this.lastBuildStartS = this.clockS;
    }

    /**
     * Spiral outward (Chebyshev rings, up to maxRadius cells) from a blocked
     * goal cell and return the walkable cell (at layer nearest `refY`)
     * nearest to it by Euclidean distance, or null when none exists within
     * the search radius.
     */
    private findNearestWalkableCell(
        nav: CellNavSource,
        gx: number,
        gz: number,
        maxRadius: number,
        refY: number,
    ): { gx: number; gz: number } | null {
        for (let r = 1; r <= maxRadius; r++) {
            let best: { gx: number; gz: number } | null = null;
            let bestDistSq = Infinity;
            for (let dx = -r; dx <= r; dx++) {
                for (let dz = -r; dz <= r; dz++) {
                    if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue; // ring perimeter only
                    if (nav.getCellGroundY(gx + dx, gz + dz, refY) === null) continue;
                    const distSq = dx * dx + dz * dz;
                    if (distSq < bestDistSq) {
                        bestDistSq = distSq;
                        best = { gx: gx + dx, gz: gz + dz };
                    }
                }
            }
            if (best) return best;
        }
        return null;
    }
}

/**
 * Owns the active goal fields: LRU-capped at maxActiveFields, splits the
 * per-frame expansion budget across incomplete fields, and runs navmesh
 * invalidation checks. Map insertion order doubles as the LRU order.
 */
export class GoalFieldManager {
    private readonly fields = new Map<string, GoalField>();
    private warnedEviction = false;

    getOrCreate(key: string, radiusM: number = GOAL_FIELD_DEFAULTS.radiusM): GoalField {
        const existing = this.fields.get(key);
        if (existing) {
            this.touch(key);
            return existing;
        }
        const field = new GoalField(key, radiusM);
        this.fields.set(key, field);
        while (this.fields.size > GOAL_FIELD_DEFAULTS.maxActiveFields) {
            const lruKey = this.fields.keys().next().value;
            if (lruKey === undefined) break;
            this.fields.delete(lruKey);
            if (!this.warnedEviction) {
                this.warnedEviction = true;
                console.warn(
                    `[GoalFieldManager] more than ${GOAL_FIELD_DEFAULTS.maxActiveFields} active goal fields; ` +
                    `evicting least-recently-used ('${lruKey}'). Further evictions are silent.`,
                );
            }
        }
        return field;
    }

    get(key: string): GoalField | null {
        const field = this.fields.get(key);
        if (!field) return null;
        this.touch(key);
        return field;
    }

    /** Mark a field as recently used (moves it to the back of the LRU order). */
    touch(key: string): void {
        const field = this.fields.get(key);
        if (!field) return;
        this.fields.delete(key);
        this.fields.set(key, field);
    }

    activeCount(): number {
        return this.fields.size;
    }

    /**
     * Per-frame tick: advance field clocks, run invalidation checks, and split
     * the expansion budget across incomplete fields. Pass null when the global
     * navmesh is absent or not ready — flood work is skipped but completed
     * front buffers keep serving sampleDirection.
     */
    update(deltaTime: number, nav: CellNavSource | null): void {
        for (const field of this.fields.values()) field.advanceClock(deltaTime);
        if (!nav || !nav.isReady()) return;
        const incomplete: GoalField[] = [];
        for (const field of this.fields.values()) {
            field.checkInvalidation(nav);
            if (!field.isComplete()) incomplete.push(field);
        }
        if (incomplete.length === 0) return;
        const perField = Math.max(1, Math.floor(GOAL_FIELD_DEFAULTS.expansionsPerFrame / incomplete.length));
        for (const field of incomplete) field.updateSlice(nav, perField);
    }
}

let globalGoalFields: GoalFieldManager | null = null;

export function getGlobalGoalFields(): GoalFieldManager {
    if (!globalGoalFields) globalGoalFields = new GoalFieldManager();
    return globalGoalFields;
}

export function disposeGlobalGoalFields(): void {
    globalGoalFields = null;
}
