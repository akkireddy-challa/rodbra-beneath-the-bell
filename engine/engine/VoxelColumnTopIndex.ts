/**
 * Per-chunk-column (cx,cz) indices used by:
 *   - the navmesh build, to skip the costly per-cell top-down ground scan, AND
 *   - the uniform-flat InstancedMesh path, which renders unedited fillFlat-stamped
 *     chunks via a single batched instanced draw instead of one Mesh per chunk.
 *
 * Two maps are maintained:
 *   - `maxY`   — voxel-Y of the highest occupied voxel in the column. Lets navmesh
 *                start its top-down scan at the actual top instead of a fixed Y.
 *   - `uniform` — for columns whose contents were written exclusively by
 *                `VoxelWorld.fillChunkFlat` and whose surface block is non-fluid.
 *                Each entry packs both the surface voxel-Y AND the surface block
 *                id so consumers can build per-block instanced meshes. Any direct
 *                `setBlock` / `setBlockFast` to the column drops the uniform entry.
 *
 * Keys are packed `((cx + 32768) << 16) | ((cz + 32768) & 0xFFFF)` — numeric, not
 * string. The uniform value packs `((vy + 32768) << 16) | (block & 0xFFFF)`. Both
 * vy and block fit comfortably in 16 bits for any realistic voxel world.
 *
 * Monotonic on `vy`: stale over-estimates are safe for the navmesh scan-start hint
 * (a few extra air iterations); never an under-estimate. Uniform entries are
 * dropped (not stale-allowed) on any direct edit so consumers can trust them.
 */
const OFFSET = 32768;
const MASK16 = 0xFFFF;

function packKey(cx: number, cz: number): number {
    return ((cx + OFFSET) << 16) | ((cz + OFFSET) & MASK16);
}

function unpackCx(key: number): number { return ((key >>> 16) & MASK16) - OFFSET; }
function unpackCz(key: number): number { return (key & MASK16) - OFFSET; }

function packUniform(vy: number, block: number): number {
    return ((vy + OFFSET) << 16) | (block & MASK16);
}

function unpackUniformVy(packed: number): number { return ((packed >>> 16) & MASK16) - OFFSET; }
function unpackUniformBlock(packed: number): number { return packed & MASK16; }

export class VoxelColumnTopIndex {
    private maxY = new Map<number, number>();
    private uniform = new Map<number, number>();

    /** Record a non-air voxel write at voxel-Y `vy` in column (cx,cz). */
    bump(cx: number, cz: number, vy: number): void {
        const k = packKey(cx, cz);
        const cur = this.maxY.get(k);
        if (cur === undefined || vy > cur) this.maxY.set(k, vy);
    }

    /** Record a uniform-flat fillFlat call. Also bumps `maxY`. Latest (highest-vy) call wins. */
    bumpUniform(cx: number, cz: number, vy: number, surfaceBlock: number): void {
        const k = packKey(cx, cz);
        const curMax = this.maxY.get(k);
        if (curMax === undefined || vy > curMax) this.maxY.set(k, vy);
        const curU = this.uniform.get(k);
        if (curU === undefined || unpackUniformVy(curU) < vy) this.uniform.set(k, packUniform(vy, surfaceBlock));
    }

    /** Called by per-block writes — they invalidate the uniform-flat property. Returns true iff an entry existed. */
    invalidateUniform(cx: number, cz: number): boolean { return this.uniform.delete(packKey(cx, cz)); }

    getMax(cx: number, cz: number): number | undefined { return this.maxY.get(packKey(cx, cz)); }
    getUniform(cx: number, cz: number): number | undefined {
        const p = this.uniform.get(packKey(cx, cz));
        return p === undefined ? undefined : unpackUniformVy(p);
    }
    getUniformBlock(cx: number, cz: number): number | undefined {
        const p = this.uniform.get(packKey(cx, cz));
        return p === undefined ? undefined : unpackUniformBlock(p);
    }

    /** Iterate every uniform entry. Callback receives (cx, cz, vy, block). */
    forEachUniform(cb: (cx: number, cz: number, vy: number, block: number) => void): void {
        for (const [k, p] of this.uniform) cb(unpackCx(k), unpackCz(k), unpackUniformVy(p), unpackUniformBlock(p));
    }

    clear(): void { this.maxY.clear(); this.uniform.clear(); }
    get size(): number { return this.maxY.size; }
    get uniformSize(): number { return this.uniform.size; }
}
