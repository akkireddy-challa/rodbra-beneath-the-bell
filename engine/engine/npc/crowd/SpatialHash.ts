/**
 * SpatialHash — uniform 2D grid over crowd agents, rebuilt every frame.
 *
 * The crowd solver needs "which agents are near agent i" for every agent, every
 * frame. Doing that against the physics world costs a scene query per agent
 * (see PhysicsWorld.computeGroupAvoidance), which is why local avoidance was
 * historically rationed to a handful of agents per frame. Against a grid it is
 * a handful of array reads, so it can run for everyone.
 *
 * REBUILT, not incrementally updated: at these counts a full rebuild is a linear
 * counting sort over typed arrays — cheaper than tracking per-agent cell
 * transitions, and it cannot develop the stale-bucket class of bug that an
 * incremental grid does when an agent is moved by something other than the
 * solver (a promotion, a teleport, a level switch).
 *
 * Storage is CSR-style (counts prefix-summed into starts, then agent indices
 * bucketed) so there is one allocation per capacity change rather than one array
 * per occupied cell.
 *
 * Y IS IGNORED. Crowd separation is a ground-plane concern: two agents on
 * different floors of a car park should not shove each other, but resolving that
 * needs the navmesh's layer model, and the solver clamps to walkable cells
 * afterwards anyway. Callers that need vertical separation must filter in their
 * own neighbour callback.
 */

/** Grid cell size as a multiple of the largest agent radius. Two agents can only
 *  overlap if they are within 2r of each other, so a cell of 2r means a query
 *  never needs to look past the 3x3 block around an agent. */
export const CELL_SIZE_RADIUS_MULTIPLE = 2;

export class SpatialHash {
    private cellSize: number;
    private invCellSize: number;
    /** Cell key -> index into `cellStart`. Rebuilt each frame. */
    private cellIndex = new Map<number, number>();
    /** CSR: start offset of each occupied cell's slice of `agentIds`. */
    private cellStart: Int32Array = new Int32Array(0);
    /** CSR: agent indices, grouped by cell. */
    private agentIds: Int32Array = new Int32Array(0);
    /** Scratch: per-agent cell slot, reused across rebuilds. */
    private agentCell: Int32Array = new Int32Array(0);
    private xs: Float32Array = new Float32Array(0);
    private zs: Float32Array = new Float32Array(0);
    private count = 0;

    constructor(cellSize: number) {
        this.cellSize = Math.max(1e-3, cellSize);
        this.invCellSize = 1 / this.cellSize;
    }

    /** Current cell size in world units. */
    getCellSize(): number {
        return this.cellSize;
    }

    /**
     * Resize the grid. Cheap, but discards the current build — call before
     * `build`, never between `build` and a query.
     */
    setCellSize(cellSize: number): void {
        this.cellSize = Math.max(1e-3, cellSize);
        this.invCellSize = 1 / this.cellSize;
    }

    /**
     * Bucket `count` agents by their x/z. The arrays are retained by reference
     * for the lifetime of the build — the caller must not mutate them until the
     * next `build`, because `forEachNeighbor` reads positions live so a solver
     * can see the effect of pushes applied earlier in the same pass
     * (Gauss-Seidel rather than Jacobi, which converges in fewer iterations).
     */
    build(xs: Float32Array, zs: Float32Array, count: number): void {
        this.xs = xs;
        this.zs = zs;
        this.count = count;
        this.cellIndex.clear();
        if (count === 0) return;

        if (this.agentCell.length < count) this.agentCell = new Int32Array(count);
        if (this.agentIds.length < count) this.agentIds = new Int32Array(count);

        // Pass 1: assign each agent a cell slot, counting occupants per slot.
        // `cellStart` is sized to the number of OCCUPIED cells, so a sparse
        // crowd spread over a large map costs no more than a dense one.
        let slots = 0;
        const counts: number[] = [];
        for (let i = 0; i < count; i++) {
            const key = this.cellKey(xs[i]!, zs[i]!);
            let slot = this.cellIndex.get(key);
            if (slot === undefined) {
                slot = slots++;
                this.cellIndex.set(key, slot);
                counts.push(0);
            }
            this.agentCell[i] = slot;
            counts[slot]!++;
        }

        // Pass 2: prefix-sum the counts into slice starts.
        if (this.cellStart.length < slots + 1) this.cellStart = new Int32Array(slots + 1);
        let running = 0;
        for (let s = 0; s < slots; s++) {
            this.cellStart[s] = running;
            running += counts[s]!;
        }
        this.cellStart[slots] = running;

        // Pass 3: scatter agent indices into their slices. `cursor` walks each
        // slice; reusing `counts` as the cursor avoids a third allocation.
        for (let s = 0; s < slots; s++) counts[s] = this.cellStart[s]!;
        for (let i = 0; i < count; i++) {
            const slot = this.agentCell[i]!;
            this.agentIds[counts[slot]!++] = i;
        }
    }

    /**
     * Invoke `cb` for every agent whose centre lies within `radius` of agent
     * `i`, excluding `i` itself. Scans the 3x3 cell block, which is sufficient
     * whenever `radius <= cellSize`; a larger radius silently misses neighbours,
     * so the solver sizes the grid from its largest interaction distance.
     */
    forEachNeighbor(i: number, radius: number, cb: (j: number) => void): void {
        if (this.count === 0) return;
        const x = this.xs[i]!;
        const z = this.zs[i]!;
        const gx = Math.floor(x * this.invCellSize);
        const gz = Math.floor(z * this.invCellSize);
        const r2 = radius * radius;
        for (let dz = -1; dz <= 1; dz++) {
            for (let dx = -1; dx <= 1; dx++) {
                const slot = this.cellIndex.get(this.gridKey(gx + dx, gz + dz));
                if (slot === undefined) continue;
                const end = this.cellStart[slot + 1]!;
                for (let k = this.cellStart[slot]!; k < end; k++) {
                    const j = this.agentIds[k]!;
                    if (j === i) continue;
                    const ddx = this.xs[j]! - x;
                    const ddz = this.zs[j]! - z;
                    if (ddx * ddx + ddz * ddz <= r2) cb(j);
                }
            }
        }
    }

    /** Number of occupied cells in the current build (diagnostics, tests). */
    getOccupiedCellCount(): number {
        return this.cellIndex.size;
    }

    private cellKey(x: number, z: number): number {
        return this.gridKey(Math.floor(x * this.invCellSize), Math.floor(z * this.invCellSize));
    }

    /**
     * Pack signed cell coordinates into one number key. Offsetting by 2^15 keeps
     * negatives positive across a +-32768-cell span, which at a 1 m cell is a
     * 65 km world — far past any level this engine bakes.
     */
    private gridKey(gx: number, gz: number): number {
        return ((gx + 32768) << 16) | ((gz + 32768) & 0xFFFF);
    }
}
