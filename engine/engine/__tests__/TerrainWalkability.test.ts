/**
 * Walkability validation for generated terrain height grids.
 *
 * Game `A87VM86GULCH` shipped two edits in a row that both claimed to fix pale
 * ground patches the player fell into and could not climb out of; the second
 * reported the player was still trapped. The per-column fix game code could
 * write only ever caught a ONE-cell dip — a 2x2 pit has interior columns whose
 * neighbours are all equally (too) low, so nothing local looks wrong. These
 * tests pin the connected form of the test: the trap shapes that regressed, the
 * legal terrain that must stay untouched, and the pond that is meant to be a
 * hole.
 */
import {
    repairTerrainWalkability,
    DEFAULT_MAX_TRAPPED_BASIN_COLUMNS,
} from 'engine/TerrainWalkability.js';

const SIZE = 9;
const MAX_STEP = 1;

/** A flat `SIZE x SIZE` grid at `height`, X-major like the validator wants. */
function flatGrid(height = 4, sizeX = SIZE, sizeZ = SIZE): number[] {
    return new Array(sizeX * sizeZ).fill(height);
}

const at = (x: number, z: number, sizeZ = SIZE): number => x * sizeZ + z;

/** Typed so `for (const [x, z] of ...)` yields numbers, not `number | undefined`. */
type Column = readonly [x: number, z: number];

/** The 2x2 block used by the pit and pond cases. */
const QUAD: readonly Column[] = [[4, 4], [4, 5], [5, 4], [5, 5]];

describe('repairTerrainWalkability — trap shapes', () => {
    it('raises a one-cell pit to a height the player can step out of', () => {
        const heights = flatGrid(4);
        heights[at(4, 4)] = 0; // 4 blocks down, step height 1 — unclimbable

        const report = repairTerrainWalkability({ heights, sizeX: SIZE, sizeZ: SIZE, maxStep: MAX_STEP });

        expect(report.heights[at(4, 4)]).toBe(3); // rim 4 minus one step
        expect(report.raisedColumns).toBe(1);
        expect(report.basins).toHaveLength(1);
        expect(report.basins[0]).toMatchObject({
            columns: 1, floorHeight: 0, rimHeight: 4, spillHeight: 3, intended: false,
        });
        expect(report.incomplete).toBe(false);
    });

    it('raises a 2x2 pit — the case a per-column fix cannot see', () => {
        const heights = flatGrid(4);
        for (const [x, z] of QUAD) heights[at(x, z)] = 0;

        const report = repairTerrainWalkability({ heights, sizeX: SIZE, sizeZ: SIZE, maxStep: MAX_STEP });

        for (const [x, z] of QUAD) {
            expect(report.heights[at(x, z)]).toBe(3);
        }
        expect(report.raisedColumns).toBe(4);
        expect(report.basins[0]).toMatchObject({
            columns: 4, floorHeight: 0, minX: 4, maxX: 5, minZ: 4, maxZ: 5, intended: false,
        });
    });

    it('does not mutate the caller\'s array', () => {
        const heights = flatGrid(4);
        heights[at(4, 4)] = 0;
        const before = [...heights];

        const report = repairTerrainWalkability({ heights, sizeX: SIZE, sizeZ: SIZE, maxStep: MAX_STEP });

        expect(heights).toEqual(before);
        expect(report.heights).not.toEqual(before);
    });

    it('resolves chained basins — filling one spills into the next', () => {
        // A staircase of pits down one row, each far enough below its neighbour
        // that repairing the deepest reveals the next as still enclosed.
        const heights = flatGrid(12);
        heights[at(3, 4)] = 8;
        heights[at(4, 4)] = 4;
        heights[at(5, 4)] = 0;

        const report = repairTerrainWalkability({ heights, sizeX: SIZE, sizeZ: SIZE, maxStep: MAX_STEP });

        // Every column must be reachable from every other by single steps.
        for (const x of [3, 4, 5]) {
            const here = report.heights[at(x, 4)]!;
            const neighbours: readonly Column[] = [[x - 1, 4], [x + 1, 4], [x, 3], [x, 5]];
            for (const [nx, nz] of neighbours) {
                if (nx < 0 || nx >= SIZE) continue;
                expect(report.heights[at(nx, nz)]! - here).toBeLessThanOrEqual(MAX_STEP);
            }
        }
        expect(report.passes).toBeGreaterThan(1);
        expect(report.incomplete).toBe(false);
    });

    it('repairs a pit against the world edge, where the grid edge is one of its walls', () => {
        const heights = flatGrid(4);
        heights[at(0, 0)] = 0; // corner: two sides are the world's end, two are rim

        const report = repairTerrainWalkability({ heights, sizeX: SIZE, sizeZ: SIZE, maxStep: MAX_STEP });

        expect(report.heights[at(0, 0)]).toBe(3);
        expect(report.basins[0]).toMatchObject({ columns: 1, minX: 0, maxX: 0, minZ: 0, maxZ: 0 });
    });

    it('leaves a pit with no rim at all alone rather than inventing a height', () => {
        // A 1x3 grid stepping down to the edge has no wall above it anywhere.
        const report = repairTerrainWalkability({
            heights: [0, 0, 0], sizeX: 1, sizeZ: 3, maxStep: MAX_STEP,
        });

        expect(report.raisedColumns).toBe(0);
        expect(report.heights).toEqual([0, 0, 0]);
    });
});

describe('repairTerrainWalkability — terrain that must stay untouched', () => {
    it('leaves flat ground alone', () => {
        const heights = flatGrid(4);
        const report = repairTerrainWalkability({ heights, sizeX: SIZE, sizeZ: SIZE, maxStep: MAX_STEP });

        expect(report.heights).toEqual(heights);
        expect(report.raisedColumns).toBe(0);
        expect(report.basins).toHaveLength(0);
    });

    it('leaves a legal slope alone — every step is within reach', () => {
        const heights: number[] = [];
        for (let x = 0; x < SIZE; x++) for (let z = 0; z < SIZE; z++) heights.push(x);

        const report = repairTerrainWalkability({ heights, sizeX: SIZE, sizeZ: SIZE, maxStep: MAX_STEP });

        expect(report.heights).toEqual(heights);
        expect(report.raisedColumns).toBe(0);
        expect(report.basins).toHaveLength(0);
    });

    it('leaves a legal bowl alone — reachable down AND back up', () => {
        const heights = flatGrid(4);
        heights[at(4, 4)] = 3; // exactly one step below the rim

        const report = repairTerrainWalkability({ heights, sizeX: SIZE, sizeZ: SIZE, maxStep: MAX_STEP });

        expect(report.raisedColumns).toBe(0);
        expect(report.basins).toHaveLength(0);
    });

    it('treats a basin past the column cap as intended landscape, not a defect', () => {
        // A valley wider than the cap is a designed feature (quarry, arena) the
        // shape test cannot tell from a pit — filling it would erase it.
        const BIG = 12; // 10x10 interior = 100 columns, past the 64 cap
        const heights = flatGrid(20, BIG, BIG);
        for (let x = 1; x < BIG - 1; x++) for (let z = 1; z < BIG - 1; z++) heights[at(x, z, BIG)] = 0;
        expect((BIG - 2) * (BIG - 2)).toBeGreaterThan(DEFAULT_MAX_TRAPPED_BASIN_COLUMNS);

        const report = repairTerrainWalkability({ heights, sizeX: BIG, sizeZ: BIG, maxStep: MAX_STEP });

        expect(report.raisedColumns).toBe(0);
        expect(report.heights[at(4, 4, BIG)]).toBe(0);
    });

    it('leaves an excluded pond basin as the hole it is meant to be', () => {
        const heights = flatGrid(4);
        const excluded = new Array(SIZE * SIZE).fill(false);
        for (const [x, z] of QUAD) {
            heights[at(x, z)] = 0;
            excluded[at(x, z)] = true;
        }

        const report = repairTerrainWalkability({ heights, sizeX: SIZE, sizeZ: SIZE, maxStep: MAX_STEP, excluded });

        for (const [x, z] of QUAD) {
            expect(report.heights[at(x, z)]).toBe(0);
        }
        expect(report.raisedColumns).toBe(0);
        expect(report.basins[0]).toMatchObject({ intended: true, raisedColumns: 0 });
    });

    it('a dry trap next to a pond is still repaired', () => {
        const heights = flatGrid(4);
        const excluded = new Array(SIZE * SIZE).fill(false);
        heights[at(2, 2)] = 0;
        excluded[at(2, 2)] = true;  // pond
        heights[at(6, 6)] = 0;      // dry pit, same depth

        const report = repairTerrainWalkability({ heights, sizeX: SIZE, sizeZ: SIZE, maxStep: MAX_STEP, excluded });

        expect(report.heights[at(2, 2)]).toBe(0);
        expect(report.heights[at(6, 6)]).toBe(3);
        expect(report.raisedColumns).toBe(1);
        expect(report.basins).toHaveLength(2);
    });
});

describe('repairTerrainWalkability — lattice and inputs', () => {
    it('snaps repaired heights onto the voxel lattice when given a quantum', () => {
        const heights = flatGrid(4);
        heights[at(4, 4)] = 0;

        // maxStep 1.05 (a 1 m block plus its margin) would spill to 2.95; on a
        // 1 m lattice the written block must be a whole 3.
        const report = repairTerrainWalkability({
            heights, sizeX: SIZE, sizeZ: SIZE, maxStep: 1.05, quantum: 1,
        });

        expect(report.heights[at(4, 4)]).toBe(3);
    });

    it('never raises a column above its own rim', () => {
        const heights = flatGrid(4);
        heights[at(4, 4)] = 0;

        // A quantum coarser than the pit is deep would round past the wall.
        const report = repairTerrainWalkability({
            heights, sizeX: SIZE, sizeZ: SIZE, maxStep: MAX_STEP, quantum: 8,
        });

        expect(report.heights[at(4, 4)]).toBe(4);
    });

    it('rejects a grid whose dimensions do not match its arrays', () => {
        expect(() => repairTerrainWalkability({ heights: [0, 0], sizeX: 3, sizeZ: 3, maxStep: 1 }))
            .toThrow(/expected 9/);
        expect(() => repairTerrainWalkability({
            heights: flatGrid(0, 2, 2), sizeX: 2, sizeZ: 2, maxStep: 1, excluded: [false],
        })).toThrow(/excluded/);
        expect(() => repairTerrainWalkability({ heights: [0], sizeX: 1, sizeZ: 1, maxStep: 0 }))
            .toThrow(/maxStep/);
    });
});

/**
 * Differential test against a deliberately naive reference.
 *
 * The real search skips work the shape-specific tests above cannot see: it reuses
 * scratch buffers across seeds, and a search that hits the column cap rules out
 * the seed's whole equal-height plateau at once. Their grids are small and regular
 * enough that either shortcut is a no-op, so neither is actually exercised there.
 *
 * This matters because a third shortcut — seeding only local minima, on an
 * argument that read like a proof and was not one — passed every test above and
 * was still wrong: this fuzz found 11 grids in 400 where it left the world LESS
 * walkable than the reference, and it was removed. The reference below is the same
 * algorithm written the slow obvious way (a `Set` per seed, every column seeded),
 * so a future shortcut has to agree with it or be explained.
 */
function referenceRepair(
    input: readonly number[], sizeX: number, sizeZ: number,
    maxStep: number, excluded: readonly boolean[], quantum: number,
    cap = DEFAULT_MAX_TRAPPED_BASIN_COLUMNS, maxPasses = 8,
): number[] {
    const h = [...input];
    const total = sizeX * sizeZ;
    let passes = 0;
    let changed = false;
    do {
        changed = false;
        passes++;
        const settled = new Set<number>();
        for (let seed = 0; seed < total; seed++) {
            if (settled.has(seed)) continue;
            settled.add(seed);
            const region = [seed];
            const inRegion = new Set([seed]);
            let rim = Infinity;
            let overCap = false;
            for (let k = 0; k < region.length && !overCap; k++) {
                const idx = region[k]!;
                const x = Math.floor(idx / sizeZ);
                const z = idx - x * sizeZ;
                const from = h[idx]!;
                const neighbours: readonly Column[] = [[x + 1, z], [x - 1, z], [x, z + 1], [x, z - 1]];
                for (const [nx, nz] of neighbours) {
                    if (nx < 0 || nx >= sizeX || nz < 0 || nz >= sizeZ) continue;
                    const n = nx * sizeZ + nz;
                    const to = h[n]!;
                    if (to - from > maxStep + 1e-9) { if (to < rim) rim = to; continue; }
                    if (inRegion.has(n)) continue;
                    if (region.length >= cap) { overCap = true; break; }
                    inRegion.add(n);
                    region.push(n);
                }
            }
            if (overCap || region.length >= total) continue;
            let intended = false;
            for (const i of region) { settled.add(i); if (excluded[i]) intended = true; }
            if (intended || !Number.isFinite(rim)) continue;
            const spill = Math.min(rim, Math.ceil((rim - maxStep) / quantum - 1e-9) * quantum);
            for (const i of region) {
                if (excluded[i] || h[i]! >= spill) continue;
                h[i] = spill;
                changed = true;
            }
        }
    } while (changed && passes < maxPasses);
    return h;
}

describe('repairTerrainWalkability — differential fuzz vs a naive reference', () => {
    it('matches the reference, never lowers ground, and never touches an excluded column', () => {
        let state = 123456789;
        const rand = (): number => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
        const grids = 400;
        for (let iter = 0; iter < grids; iter++) {
            const sizeX = 3 + Math.floor(rand() * 10);
            const sizeZ = 3 + Math.floor(rand() * 10);
            const range = 1 + Math.floor(rand() * 6);
            const heights: number[] = [];
            const excluded: boolean[] = [];
            for (let i = 0; i < sizeX * sizeZ; i++) {
                heights.push(Math.floor(rand() * range) - Math.floor(range / 2));
                excluded.push(rand() < 0.08);
            }

            const got = repairTerrainWalkability({
                heights, sizeX, sizeZ, maxStep: MAX_STEP, excluded, quantum: 1,
            });
            const want = referenceRepair(heights, sizeX, sizeZ, MAX_STEP, excluded, 1);

            expect(got.heights).toEqual(want);
            got.heights.forEach((value, i) => {
                // Repair only ever fills terrain in; it must never carve it away,
                // or a repaired world would sink features the generator authored.
                expect(value).toBeGreaterThanOrEqual(heights[i]!);
                if (excluded[i]) expect(value).toBe(heights[i]!);
            });
        }
    });
});
