/**
 * Walkability validation for a GENERATED column-height grid, run BEFORE the
 * heights are written as voxels.
 *
 * Procedural terrain quantizes each column to a lattice height, and nothing in
 * that per-column loop can see that a column ended up lower than every one of
 * its neighbours by more than the player's step height. The result is a pit the
 * player falls into and cannot climb out of — one cell wide, or a 2x2, or a
 * whole basin, all of which read to a player as "I am stuck". Game code that
 * patched this per column could only ever fix the one-cell case: a wider basin
 * has interior columns whose neighbours are all at the same (too low) height,
 * so no single-column test sees anything wrong.
 *
 * This module owns the connected form of the test. A basin is the set of
 * columns the player can reach from one column, where a move to a neighbour is
 * possible when it stands at most `maxStep` above the column being left
 * (dropping down is always possible, and the grid's edge is a wall — the player
 * cannot walk off the world). When that reachable set is small and does not
 * cover the grid, every exit from it is a wall taller than the player can
 * climb: a trap. Its columns are raised to the spill height its lowest rim
 * allows, which is the smallest change that makes the rim mountable.
 *
 * Opt-in and pure: it takes a height grid and returns a repaired copy plus
 * diagnostics, so a generator wires it in as one call between computing heights
 * and writing blocks, and a caller that wants only the report ignores the copy.
 */

/** Float slack so a height difference that is exactly `maxStep` still counts as climbable. */
const STEP_EPSILON = 1e-9;

/**
 * A connected basin larger than this counts as INTENDED terrain, not a trap.
 *
 * Without a cap the test flags the legitimate case it cannot distinguish from a
 * pit by shape alone: a quarry, a sunken arena, or a valley ringed by cliffs is
 * also a region whose every exit is unclimbable, and "repairing" it would fill
 * the feature in. Real generation defects are small — the pale patches that
 * motivated this were single columns and 2x2 dips — so a basin up to roughly
 * 8x8 columns is treated as a defect and anything larger as landscape. A
 * caller that generates deliberately deep bowls should lower it; one that wants
 * large depressions repaired should raise it.
 */
export const DEFAULT_MAX_TRAPPED_BASIN_COLUMNS = 64;

/** Default bound on repair passes; chained basins need more than one. */
const DEFAULT_MAX_PASSES = 8;

/**
 * The 4-connected neighbour offsets, as parallel arrays indexed by direction.
 * Diagonals are deliberately absent: a diagonal gap between two raised columns
 * is not a route a player can rely on.
 */
const NEIGHBOUR_DX = [1, -1, 0, 0] as const;
const NEIGHBOUR_DZ = [0, 0, 1, -1] as const;

export interface TerrainWalkabilityOptions {
    /**
     * Column heights, X-major: index `x * sizeZ + z`. The unit is the caller's
     * (metres or blocks) and only has to match `maxStep` and `quantum`.
     */
    heights: readonly number[];
    /** Number of columns along X. */
    sizeX: number;
    /** Number of columns along Z. */
    sizeZ: number;
    /**
     * Tallest height difference the player can climb, in the same unit as
     * `heights` — `stepHeightForWorld(blockSize)` for a voxel world.
     */
    maxStep: number;
    /**
     * Columns that are INTENDED to sit below their surroundings: pond, lava and
     * moat floors. Same layout as `heights`. Such a column is never raised, and
     * a basin containing one is reported with `intended: true` and left alone —
     * the player is meant to swim there, not walk.
     */
    excluded?: readonly boolean[];
    /** Overrides {@link DEFAULT_MAX_TRAPPED_BASIN_COLUMNS}. */
    maxBasinColumns?: number;
    /**
     * Round every raised height UP to a multiple of this, so repairs land on the
     * voxel lattice (pass the block size). Omit to keep exact spill heights.
     */
    quantum?: number;
    /** Overrides the repair-pass bound (8). */
    maxPasses?: number;
}

/** One connected basin the validator found. */
export interface TerrainBasinDiagnostic {
    /** How many columns the basin covers. */
    columns: number;
    /** Lowest column in the basin, before repair. */
    floorHeight: number;
    /** Lowest rim column around it — the cheapest way out. `Infinity` when the basin is walled in by the grid edge alone. */
    rimHeight: number;
    /** Height trapped columns were raised to, so that the rim is one step away. Equals `floorHeight` when nothing was raised. */
    spillHeight: number;
    /** Basin bounds in grid indices, for pointing a human or an agent at it. */
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
    /** The basin holds an excluded column (a pond), so it is water by design and was not touched. */
    intended: boolean;
    /** How many columns this basin's repair actually raised. */
    raisedColumns: number;
}

export interface TerrainWalkabilityReport {
    /** Repaired copy of the input heights; the input is never mutated. */
    heights: number[];
    /** Every basin found, including intended ones, in discovery order. */
    basins: TerrainBasinDiagnostic[];
    /** Total columns raised across all passes. */
    raisedColumns: number;
    /** Passes run. More than one means basins were chained — filling one spilled into the next. */
    passes: number;
    /** Repairs were still landing when `maxPasses` ran out, so traps may remain. */
    incomplete: boolean;
}

/** Smallest multiple of `quantum` that is not below `value`. */
function ceilToMultiple(value: number, quantum: number): number {
    return Math.ceil(value / quantum - STEP_EPSILON) * quantum;
}

/**
 * Scratch buffers reused across every seed of every pass.
 *
 * Each seed runs its own flood fill, so the "is this column already in the
 * region" marker has to be cleared between seeds. Clearing it by allocating a
 * fresh `Set` per seed dominated the whole run — a 128x128 grid seeds 16384
 * searches per pass. Instead the marker holds the SEARCH NUMBER that last
 * touched a column, so a new search invalidates every mark by incrementing a
 * counter, and nothing is allocated or cleared per seed.
 */
interface BasinScratch {
    /** Search number that last claimed each column. */
    readonly visited: Int32Array;
    /** Flood-fill queue, holding column indices; reused, so `length` is tracked separately. */
    readonly queue: Int32Array;
    /**
     * Marks, with the current token, each visited column reached from the seed
     * along a path of EQUAL heights — the seed's plateau. Every move inside a
     * plateau is a zero-height step, so it is reversible: plateau members can all
     * reach each other and therefore share one reachable set. That makes them
     * interchangeable as seeds, which is what lets an abandoned search rule out
     * the whole plateau instead of only the column it started from.
     */
    readonly plateau: Int32Array;
    /** Incremented per search — the current value of a claimed mark. */
    token: number;
}

/**
 * Find the columns reachable from `seed`, giving up once the region grows past
 * `cap` — at which point the seed is not in a small enclosed basin and the rest
 * of the region does not matter.
 *
 * `abandoned` says which happened. Either way the columns visited so far are the
 * first `length` entries of `scratch.queue`, and `scratch.plateau` marks the
 * seed's equal-height component among them.
 */
function collectBasin(
    heights: readonly number[],
    sizeX: number,
    sizeZ: number,
    maxStep: number,
    seed: number,
    cap: number,
    scratch: BasinScratch,
): { length: number; rimHeight: number; abandoned: boolean } {
    const { visited, queue, plateau } = scratch;
    const token = ++scratch.token;
    let length = 0;
    queue[length++] = seed;
    visited[seed] = token;
    plateau[seed] = token;
    let rimHeight = Infinity;
    for (let head = 0; head < length; head++) {
        const index = queue[head]!;
        const x = Math.floor(index / sizeZ);
        const z = index - x * sizeZ;
        const from = heights[index]!;
        const fromPlateau = plateau[index] === token;
        for (let dir = 0; dir < 4; dir++) {
            const nx = x + NEIGHBOUR_DX[dir]!;
            const nz = z + NEIGHBOUR_DZ[dir]!;
            // Off the grid is a wall, not an exit: the world ends there.
            if (nx < 0 || nx >= sizeX || nz < 0 || nz >= sizeZ) continue;
            const neighbour = nx * sizeZ + nz;
            const to = heights[neighbour]!;
            if (to - from > maxStep + STEP_EPSILON) {
                if (to < rimHeight) rimHeight = to;
                continue;
            }
            if (fromPlateau && to === from) plateau[neighbour] = token;
            if (visited[neighbour] === token) continue;
            if (length >= cap) return { length, rimHeight, abandoned: true };
            visited[neighbour] = token;
            queue[length++] = neighbour;
        }
    }
    return { length, rimHeight, abandoned: false };
}

/**
 * Detect enclosed basins in a generated height grid and raise the unintended
 * ones to a height the player can climb out of.
 *
 * Cost is bounded by the basin cap rather than the grid: a search stops after at
 * most `maxBasinColumns` columns, and a search that is abandoned rules out its
 * whole plateau at once — so flat ground and legal slopes stay cheap, and a basin
 * that IS a trap is resolved for all its columns by the one search that found it.
 * Measured at roughly 10-200 ms for a 128x128 grid, worst on chaotic terrain.
 *
 * @throws when the grid dimensions do not match the arrays, or `maxStep` is not positive.
 */
export function repairTerrainWalkability(options: TerrainWalkabilityOptions): TerrainWalkabilityReport {
    const { heights: input, sizeX, sizeZ, maxStep, excluded, quantum } = options;
    const total = sizeX * sizeZ;
    if (!Number.isInteger(sizeX) || !Number.isInteger(sizeZ) || sizeX <= 0 || sizeZ <= 0) {
        throw new Error(`[TerrainWalkability] sizeX/sizeZ must be positive integers, got ${sizeX}x${sizeZ}`);
    }
    if (input.length !== total) {
        throw new Error(`[TerrainWalkability] heights has ${input.length} entries, expected ${total} for a ${sizeX}x${sizeZ} grid`);
    }
    if (excluded && excluded.length !== total) {
        throw new Error(`[TerrainWalkability] excluded has ${excluded.length} entries, expected ${total}`);
    }
    if (!(maxStep > 0) || !Number.isFinite(maxStep)) {
        throw new Error(`[TerrainWalkability] maxStep must be a positive finite height, got ${maxStep}`);
    }

    const heights = Array.from(input);
    const cap = Math.max(1, options.maxBasinColumns ?? DEFAULT_MAX_TRAPPED_BASIN_COLUMNS);
    const maxPasses = Math.max(1, options.maxPasses ?? DEFAULT_MAX_PASSES);
    const basins: TerrainBasinDiagnostic[] = [];
    // A basin is identified by its lowest column index, so an intended (never
    // repaired) one is not re-reported by every later pass.
    const reported = new Set<number>();
    let raisedColumns = 0;
    let passes = 0;
    let changed = false;
    const scratch: BasinScratch = {
        visited: new Int32Array(total),
        // A search stops the moment it would exceed the cap, so it never holds
        // more than `cap` columns — but never smaller than a 1-column grid.
        queue: new Int32Array(Math.min(total, cap) + 1),
        plateau: new Int32Array(total),
        token: 0,
    };
    const settled = new Uint8Array(total);

    do {
        changed = false;
        passes++;
        settled.fill(0);
        for (let seed = 0; seed < total; seed++) {
            if (settled[seed]) continue;
            settled[seed] = 1;
            const { length, rimHeight, abandoned } = collectBasin(heights, sizeX, sizeZ, maxStep, seed, cap, scratch);
            const region = scratch.queue;
            // Region too large to be a defect, or the whole grid — the player is
            // not trapped, they are simply somewhere in the world. Settle the
            // seed's PLATEAU too: those columns reach each other freely, so they
            // share this reachable set and would each re-run the same search.
            // That is what keeps flat ground and gentle terrain cheap.
            if (abandoned || length >= total) {
                for (let i = 0; i < length; i++) {
                    const index = region[i]!;
                    if (scratch.plateau[index] === scratch.token) settled[index] = 1;
                }
                continue;
            }

            let floorHeight = Infinity;
            let minX = sizeX;
            let maxX = -1;
            let minZ = sizeZ;
            let maxZ = -1;
            let intended = false;
            let id = total;
            for (let i = 0; i < length; i++) {
                const index = region[i]!;
                settled[index] = 1;
                const x = Math.floor(index / sizeZ);
                const z = index - x * sizeZ;
                if (heights[index]! < floorHeight) floorHeight = heights[index]!;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (z < minZ) minZ = z;
                if (z > maxZ) maxZ = z;
                if (index < id) id = index;
                if (excluded?.[index]) intended = true;
            }

            // A rim of Infinity means the grid edge is the only boundary, so
            // there is no height to spill over and nothing to raise to.
            const repairable = !intended && Number.isFinite(rimHeight);
            // One step below the rim is all it takes to make the rim mountable;
            // `quantum` then snaps that onto the voxel lattice. Clamped to the rim
            // itself because a coarse quantum could otherwise round the spill
            // height past the wall and turn the pit into a mound.
            const spillTarget = rimHeight - maxStep;
            const spillHeight = repairable
                ? Math.min(rimHeight, quantum !== undefined ? ceilToMultiple(spillTarget, quantum) : spillTarget)
                : floorHeight;
            let basinRaised = 0;
            if (repairable) {
                for (let i = 0; i < length; i++) {
                    const index = region[i]!;
                    if (excluded?.[index] || heights[index]! >= spillHeight) continue;
                    heights[index] = spillHeight;
                    basinRaised++;
                }
            }
            raisedColumns += basinRaised;
            if (basinRaised > 0) changed = true;

            if (!reported.has(id)) {
                reported.add(id);
                basins.push({
                    columns: length,
                    floorHeight,
                    rimHeight,
                    spillHeight,
                    minX, maxX, minZ, maxZ,
                    intended,
                    raisedColumns: basinRaised,
                });
            }
        }
    } while (changed && passes < maxPasses);

    return { heights, basins, raisedColumns, passes, incomplete: changed };
}
