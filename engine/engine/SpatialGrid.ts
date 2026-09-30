/**
 * Generic 2D spatial grid for efficient range queries.
 *
 * Divides the XZ plane into fixed-size cells. Insert items with their
 * position, then query by radius to get only nearby items instead of
 * scanning the full list.
 *
 * Typical usage: rebuild once per frame, query per entity.
 */
export class SpatialGrid<T> {
    private cells = new Map<number, T[]>();
    private cellSize: number;
    private invCellSize: number;

    /** Reusable array for queryRadius when no `out` is provided. */
    private _queryResult: T[] = [];

    constructor(cellSize: number) {
        this.cellSize = cellSize;
        this.invCellSize = 1 / cellSize;
    }

    /** Remove all items. Call once at the start of each frame before re-inserting. */
    clear(): void {
        // Reuse cell arrays instead of discarding them
        for (const cell of this.cells.values()) {
            cell.length = 0;
        }
    }

    /** Insert an item at the given world XZ position. */
    insert(x: number, z: number, item: T): void {
        const k = this._key(x, z);
        let cell = this.cells.get(k);
        if (!cell) {
            cell = [];
            this.cells.set(k, cell);
        }
        cell.push(item);
    }

    /**
     * Query all items whose cell is within `radius` of the given point.
     *
     * Returns items from all cells that *could* contain items within radius.
     * Caller should still do a precise distance check on the results.
     *
     * @param out - Optional array to fill. If omitted, an internal reusable
     *              array is returned (overwritten on next call).
     */
    queryRadius(x: number, z: number, radius: number, out?: T[]): T[] {
        const results = out ?? this._queryResult;
        results.length = 0;

        const cellRadius = Math.ceil(radius * this.invCellSize);
        const cx = Math.floor(x * this.invCellSize);
        const cz = Math.floor(z * this.invCellSize);

        for (let dx = -cellRadius; dx <= cellRadius; dx++) {
            for (let dz = -cellRadius; dz <= cellRadius; dz++) {
                const k = this._packKey(cx + dx, cz + dz);
                const cell = this.cells.get(k);
                if (cell && cell.length > 0) {
                    for (const item of cell) {
                        results.push(item);
                    }
                }
            }
        }

        return results;
    }

    /** Number of occupied cells. */
    get activeCellCount(): number {
        let count = 0;
        for (const cell of this.cells.values()) {
            if (cell.length > 0) count++;
        }
        return count;
    }

    private _key(x: number, z: number): number {
        return this._packKey(
            Math.floor(x * this.invCellSize),
            Math.floor(z * this.invCellSize)
        );
    }

    /**
     * Pack two grid coordinates into a single number key.
     * Uses 16-bit signed range per axis (-32768..32767 cells).
     * At cellSize=10 that covers ±327 km — more than enough.
     */
    private _packKey(cx: number, cz: number): number {
        return ((cx & 0xFFFF) << 16) | (cz & 0xFFFF);
    }
}
