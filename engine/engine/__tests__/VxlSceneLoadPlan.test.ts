import type { DecodedVxlSceneWorld, DecodedChunk, DecodedChunkVoxels, DecodedChunkQuads } from 'engine/vxlscene/VxlSceneFormat.js';
import {
    planVxlSceneLoad, applyLodSkip, applyEffectiveStepSkip, applyLodOffsetDrop, finestKeptQuads,
    estimateQuadRenderBytes, VXL_SCENE_LOAD_BUDGET_FULL, VXL_SCENE_LOAD_BUDGET_CONSTRAINED,
    type VxlSceneLoadBudget,
} from 'engine/VxlSceneTerrainSystem.js';

/** A budget with a quad cell-size floor, a surface byte budget, and an optional TOTAL ceiling. */
function budget(
    minQuadCellSizeM: number | null,
    surfaceBudgetBytes = 600 * 1024 * 1024,
    totalBudgetBytes: number | null = null,
): VxlSceneLoadBudget {
    return { minQuadCellSizeM, totalBudgetBytes, surfaceBudgetBytes, dropTerrainBandsAtOrAboveOffset: null };
}

function quads(count: number, offset = 0): DecodedChunkQuads {
    return {
        count,
        gx: new Uint16Array(count), gy: new Uint16Array(count), gz: new Uint16Array(count),
        w: new Uint16Array(count), h: new Uint16Array(count),
        axisDir: new Uint8Array(count).fill((offset & 0x7) << 3),
        colorIdx: new Uint16Array(count), disp: new Int8Array(count),
    };
}

/** One column set holding `counts[offset]` quads per packed offset, concatenated ascending. */
function quadsByOffset(counts: Record<number, number>): DecodedChunkQuads {
    const offsets = Object.keys(counts).map(Number).sort((a, b) => a - b);
    const total = offsets.reduce((s, o) => s + counts[o]!, 0);
    const q = quads(total);
    let i = 0;
    for (const o of offsets) {
        for (let k = 0; k < counts[o]!; k++) {
            q.axisDir[i] = (o & 0x7) << 3;
            q.gx[i] = i; // distinct positions so compaction is observable
            i++;
        }
    }
    return q;
}

/** Quad count per packed offset in a column set. */
function countByOffset(q: DecodedChunkQuads): Record<number, number> {
    const out: Record<number, number> = {};
    for (let i = 0; i < q.count; i++) {
        const o = (q.axisDir[i]! >> 3) & 0x7;
        out[o] = (out[o] ?? 0) + 1;
    }
    return out;
}
function displacedVoxels(count: number): DecodedChunkVoxels {
    const flags = new Uint8Array(count).fill(2); // all displaced
    return {
        count, gx: new Uint16Array(count), gy: new Uint16Array(count), gz: new Uint16Array(count),
        sizeLevel: new Uint8Array(count), colorIdx: new Uint16Array(count), flags,
        disp: new Int8Array(count * 3),
    };
}
function emptyVoxels(): DecodedChunkVoxels {
    return { count: 0, gx: new Uint16Array(0), gy: new Uint16Array(0), gz: new Uint16Array(0), sizeLevel: new Uint8Array(0), colorIdx: new Uint16Array(0), flags: new Uint8Array(0), disp: null };
}
function world(chunks: DecodedChunk[], lodDistances = [50, 90, 160]): DecodedVxlSceneWorld {
    return { chunkSize: 16, minVoxelSize: 0.0625, bounds: { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 }, lodDistances, chunks };
}
const ch = (lodHints: DecodedChunkQuads[], voxels: DecodedChunkVoxels): DecodedChunk =>
    ({ cx: 0, cy: 0, cz: 0, voxels, lodHints, namedTrimeshes: [] });
/** A chunk whose smooth surface is a v5+ SURFACE TILE (no displaced voxels at all). */
const chWithTile = (lodHints: DecodedChunkQuads[], tileCells: number): DecodedChunk => ({
    ...ch(lodHints, emptyVoxels()),
    surfaceTile: {
        count: tileCells,
        localGx: new Uint16Array(tileCells), localGz: new Uint16Array(tileCells),
        gy: new Uint16Array(tileCells), dy: new Int8Array(tileCells),
        colorIdx: new Uint16Array(tileCells),
    },
});

describe('planVxlSceneLoad', () => {
    it('a tiny world loads at full detail', () => {
        const w = world([ch([quads(100), quads(20)], emptyVoxels())]);
        expect(planVxlSceneLoad(w, VXL_SCENE_LOAD_BUDGET_FULL)).toEqual({ skipLodLevels: 0, skipEffectiveSteps: 0, surfaceStep: 1 });
    });

    it('DESKTOP never sheds quad detail, no matter how large the world (quad budget null)', () => {
        // The baked voxel resolution is part of the game's look — silently coarsening
        // 0.125m → 0.25m on desktop is not acceptable. Only mobile budgets shed.
        const w = world([ch([quads(50_000_000), quads(1_000_000)], emptyVoxels())]);
        const plan = planVxlSceneLoad(w, VXL_SCENE_LOAD_BUDGET_FULL);
        expect(plan.skipEffectiveSteps).toBe(0);
        expect(plan.skipLodLevels).toBe(0);
    });

    it('the MOBILE floor (0.25m) lifts a fine bake to 0.25m and never skips whole LOD levels', () => {
        // Test worlds bake at minVoxelSize 0.0625 → two doublings reach the 0.25m floor.
        const w = world([ch([quads(5_000_000), quads(100_000)], emptyVoxels())]);
        const plan = planVxlSceneLoad(w, VXL_SCENE_LOAD_BUDGET_CONSTRAINED);
        expect(plan.skipLodLevels).toBe(0);
        expect(plan.skipEffectiveSteps).toBe(2);
        expect(plan.surfaceStep).toBe(1);
    });

    it('the cell-size floor is bake-resolution-relative: steps = ceil(log2(floor / minVoxelSize))', () => {
        const w = (minVoxelSize: number): DecodedVxlSceneWorld => ({
            ...world([ch([quads(10), quads(5)], emptyVoxels())]),
            minVoxelSize,
        });
        expect(planVxlSceneLoad(w(0.25), budget(0.25)).skipEffectiveSteps).toBe(0);  // already at floor
        expect(planVxlSceneLoad(w(0.5), budget(0.25)).skipEffectiveSteps).toBe(0);   // coarser than floor
        expect(planVxlSceneLoad(w(0.125), budget(0.25)).skipEffectiveSteps).toBe(1);
        expect(planVxlSceneLoad(w(0.0625), budget(0.25)).skipEffectiveSteps).toBe(2);
        // Absurdly fine bake clamps at the cap rather than shedding everything.
        expect(planVxlSceneLoad(w(0.001), budget(0.25)).skipEffectiveSteps).toBe(4);
    });

    it('a null floor never sheds regardless of world size', () => {
        const w = world([ch([quads(50_000_000), quads(1_000_000)], emptyVoxels())]);
        expect(planVxlSceneLoad(w, budget(null)).skipEffectiveSteps).toBe(0);
    });

    it('a surface-heavy world raises surfaceStep when surfaces alone exceed budget', () => {
        const w = world([ch([quads(10)], displacedVoxels(10_000_000))]);
        const plan = planVxlSceneLoad(w, budget(null, 100 * 1024 * 1024));
        expect(plan.surfaceStep).toBeGreaterThanOrEqual(2);
    });

    it('an empty world plans full detail without throwing (Math.max over no chunks)', () => {
        expect(planVxlSceneLoad(world([]), VXL_SCENE_LOAD_BUDGET_CONSTRAINED)).toEqual({ skipLodLevels: 0, skipEffectiveSteps: 2, surfaceStep: 1 });
    });

    it('a surface too large to fit even decimated caps surfaceStep at 8 (terminates)', () => {
        // 100M cells over a tiny budget: cannot fit at any step → loop stops at the cap.
        const w = world([ch([quads(0)], displacedVoxels(100_000_000))]);
        expect(planVxlSceneLoad(w, budget(null, 10 * 1024 * 1024)).surfaceStep).toBe(8);
    });

    it('the MOBILE total ceiling keeps coarsening past the cell floor until the bytes fit', () => {
        // 4M quads at the finest step is ~627 MB of buffers — the 0.25m floor alone sheds a
        // token slice of that (it only lifts ONE doubling on a 0.125m bake) and the level
        // still jetsams a phone. The ceiling is what has to bite.
        const w = { ...world([ch([quadsByOffset({ 0: 2_000_000, 1: 1_000_000 }), quads(500_000, 2), quads(50_000, 3)], emptyVoxels())]), minVoxelSize: 0.125 };
        const floorOnly = planVxlSceneLoad(w, budget(0.25));
        expect(floorOnly.skipEffectiveSteps).toBe(1);

        // The ceiling is derived from what the floor alone leaves standing, so this stays a
        // test of the SEARCH rather than of the current bytes-per-quad constant.
        const ceiling = Math.floor(estimateQuadRenderBytes(w, floorOnly.skipEffectiveSteps) / 2);
        const plan = planVxlSceneLoad(w, budget(0.25, 600 * 1024 * 1024, ceiling));
        expect(plan.skipEffectiveSteps).toBeGreaterThan(floorOnly.skipEffectiveSteps);
        expect(estimateQuadRenderBytes(w, plan.skipEffectiveSteps)).toBeLessThanOrEqual(ceiling);
    });

    it('the total ceiling never shreds a world that already fits', () => {
        const w = { ...world([ch([quads(1000), quads(100)], emptyVoxels())]), minVoxelSize: 0.25 };
        expect(planVxlSceneLoad(w, budget(0.25, 600 * 1024 * 1024, 200 * 1024 * 1024)).skipEffectiveSteps).toBe(0);
    });

    it('a world over the total ceiling at every candidate stops at the cap (needs a coarser bake)', () => {
        // Every quad sits on the coarsest level, so NO skip can shed any of them: the search
        // must terminate at the cap instead of spinning.
        const w = { ...world([ch([quads(50_000_000)], emptyVoxels())]), minVoxelSize: 0.125 };
        expect(planVxlSceneLoad(w, budget(0.25, 600 * 1024 * 1024, 1024 * 1024)).skipEffectiveSteps).toBe(4);
    });

    it('the ceiling bounds quads PLUS surface, not each alone', () => {
        // The defect this replaced: with independent per-mesh ceilings, the circuit with
        // the biggest surface got quads up to the quad ceiling ON TOP of it and crashed a
        // phone at 316 MB while every level around 200 MB loaded. Both parts were
        // "within budget"; nothing watched the sum.
        const w = {
            ...world([chWithTile([quadsByOffset({ 1: 900_000, 2: 400_000 }), quads(40_000, 3)], 900_000)]),
            minVoxelSize: 0.125,
        };
        const surfaceOnly = 900_000 * (32 + 6 * 4);
        const quadsAt = (skip: number): number => estimateQuadRenderBytes(w, skip);

        // A ceiling the QUADS alone fit under, but the pair does not.
        const total = quadsAt(1) + Math.floor(surfaceOnly / 2);
        const plan = planVxlSceneLoad(w, budget(0.25, 600 * 1024 * 1024, total));
        expect(plan.surfaceStep).toBe(1);                       // surface fits its own budget
        expect(plan.skipEffectiveSteps).toBeGreaterThan(1);      // so the QUADS gave way
        expect(quadsAt(plan.skipEffectiveSteps) + surfaceOnly).toBeLessThanOrEqual(total);
    });

    it('decimates the surface BEFORE coarsening quads, so the look-carrying mesh gives way last', () => {
        // Same total either way; the order decides which mesh pays. A surface over its own
        // budget must shrink first, leaving the quads more of the total to spend.
        const w = {
            ...world([chWithTile([quadsByOffset({ 1: 600_000, 2: 300_000 }), quads(30_000, 3)], 4_000_000)]),
            minVoxelSize: 0.125,
        };
        const tightSurface = planVxlSceneLoad(w, budget(0.25, 16 * 1024 * 1024, 200 * 1024 * 1024));
        const looseSurface = planVxlSceneLoad(w, budget(0.25, 600 * 1024 * 1024, 200 * 1024 * 1024));
        expect(tightSurface.surfaceStep).toBeGreaterThan(looseSurface.surfaceStep);
        expect(tightSurface.skipEffectiveSteps).toBeLessThan(looseSurface.skipEffectiveSteps);
    });

    it('a v5+ SURFACE TILE counts toward the surface budget (displaced voxels are always 0 there)', () => {
        // Regression: the estimate counted only displaced voxels, so every v5+ bake reported a
        // 0-byte surface and the budget could never fire however huge the real surface was.
        const w = world([chWithTile([quads(10)], 10_000_000)]);
        expect(planVxlSceneLoad(w, budget(null, 100 * 1024 * 1024)).surfaceStep).toBeGreaterThanOrEqual(2);
    });

    it('a quad-AND-surface-heavy world still never skips LODs, but may decimate the surface', () => {
        const w = world([ch([quads(5_000_000), quads(100_000)], displacedVoxels(10_000_000))]);
        const plan = planVxlSceneLoad(w, budget(null, 200 * 1024 * 1024));
        expect(plan.skipLodLevels).toBe(0);
        expect(plan.surfaceStep).toBeGreaterThanOrEqual(2);
    });
});

describe('applyLodOffsetDrop', () => {
    it('removes every quad at or above the offset, from EVERY level including the coarsest', () => {
        // The effective-step shed always leaves an offset group one surviving level; a
        // dropped terrain band must leave nothing, or it still costs the memory it was
        // dropped to reclaim.
        const w = world([ch([
            quadsByOffset({ 0: 3, 1: 4, 2: 5, 3: 6 }),
            quadsByOffset({ 1: 2, 2: 7 }),
        ], emptyVoxels())]);
        expect(applyLodOffsetDrop(w, 2)).toBe(5 + 6 + 7);
        expect(countByOffset(w.chunks[0]!.lodHints[0]!)).toEqual({ 0: 3, 1: 4 });
        expect(countByOffset(w.chunks[0]!.lodHints[1]!)).toEqual({ 1: 2 });
    });

    it('leaves named trimeshes alone — a dropped band keeps its collider', () => {
        const chunk = ch([quadsByOffset({ 1: 2, 3: 9 })], emptyVoxels());
        chunk.namedTrimeshes = [{ name: 'Terrain_4', verts: new Float32Array(9), indices: new Uint32Array(3) }];
        applyLodOffsetDrop(world([chunk]), 2);
        expect(chunk.namedTrimeshes).toHaveLength(1);
        expect(chunk.namedTrimeshes[0]!.indices).toHaveLength(3);
    });

    it('offset 0 is a no-op (nothing to drop below the first band)', () => {
        const w = world([ch([quadsByOffset({ 0: 3, 2: 4 })], emptyVoxels())]);
        const before = w.chunks[0]!.lodHints[0]!;
        expect(applyLodOffsetDrop(w, 0)).toBe(0);
        expect(w.chunks[0]!.lodHints[0]).toBe(before);   // same object: no copy made
    });

    it('a level with nothing at or above the cap is untouched', () => {
        const w = world([ch([quadsByOffset({ 0: 5, 1: 6 })], emptyVoxels())]);
        expect(applyLodOffsetDrop(w, 2)).toBe(0);
        expect(countByOffset(w.chunks[0]!.lodHints[0]!)).toEqual({ 0: 5, 1: 6 });
    });

    it('dropping the bands lets the byte ceiling keep FINER cells near the track', () => {
        // The point of the drop: the same ceiling buys 0.25m terrain where the camera is
        // instead of 1m everywhere, because the budget is no longer paying for backdrop.
        const build = (): DecodedVxlSceneWorld => ({
            ...world([ch([quadsByOffset({ 1: 800_000, 2: 700_000, 3: 900_000 }), quads(40_000, 3)], emptyVoxels())]),
            minVoxelSize: 0.125,
        });
        const ceiling = 120 * 1024 * 1024;
        const withBands = planVxlSceneLoad(build(), budget(0.25, 600 * 1024 * 1024, ceiling));
        const dropped = build();
        applyLodOffsetDrop(dropped, 2);
        const withoutBands = planVxlSceneLoad(dropped, budget(0.25, 600 * 1024 * 1024, ceiling));
        expect(withoutBands.skipEffectiveSteps).toBeLessThan(withBands.skipEffectiveSteps);
        expect(estimateQuadRenderBytes(dropped, withoutBands.skipEffectiveSteps)).toBeLessThanOrEqual(ceiling);
    });
});

describe('applyLodSkip', () => {
    it('slices the finest LOD levels and lodDistances in parallel, keeps >=1 LOD', () => {
        const w = world([ch([quads(1), quads(2), quads(3)], emptyVoxels())], [50, 90, 160]);
        applyLodSkip(w, 1);
        expect(w.chunks[0]!.lodHints.map(q => q.count)).toEqual([2, 3]);
        expect(w.lodDistances).toEqual([90, 160]);
    });

    it('never drops the last LOD of a chunk', () => {
        const w = world([ch([quads(1)], emptyVoxels())], [50]);
        applyLodSkip(w, 5);
        expect(w.chunks[0]!.lodHints.length).toBe(1);
    });

    it('leaves voxel columns untouched', () => {
        const v = displacedVoxels(3);
        const w = world([ch([quads(1), quads(2)], v)]);
        applyLodSkip(w, 1);
        expect(w.chunks[0]!.voxels).toBe(v);
    });

    it('skip 0 is a no-op', () => {
        const w = world([ch([quads(1), quads(2)], emptyVoxels())], [50, 90]);
        applyLodSkip(w, 0);
        expect(w.chunks[0]!.lodHints.length).toBe(2);
        expect(w.lodDistances).toEqual([50, 90]);
    });

    it('a chunk with zero LOD levels is left untouched (eff clamps to 0)', () => {
        const v = displacedVoxels(2);
        const w = world([ch([], v)], [50]);
        expect(() => applyLodSkip(w, 3)).not.toThrow();
        expect(w.chunks[0]!.lodHints.length).toBe(0);
        expect(w.chunks[0]!.voxels).toBe(v);
    });
});

describe('applyEffectiveStepSkip', () => {
    it('sheds only quads whose effective step (offset + level) is below skipSteps', () => {
        // Level 0 mixes offsets 0 and 2; level 1 mixes 0 and 2; level 2 is coarsest.
        const w = world([ch([
            quadsByOffset({ 0: 100, 2: 40 }),
            quadsByOffset({ 0: 25, 2: 10 }),
            quadsByOffset({ 0: 6, 2: 3 }),
        ], emptyVoxels())]);
        applyEffectiveStepSkip(w, 2);
        const [l0, l1, l2] = w.chunks[0]!.lodHints;
        // L0: offset0 (step 0 < 2) shed, offset2 (step 2) kept.
        expect(countByOffset(l0!)).toEqual({ 2: 40 });
        // L1: offset0 (step 1 < 2) shed, offset2 (step 3) kept.
        expect(countByOffset(l1!)).toEqual({ 2: 10 });
        // L2 is the chunk's coarsest level — always kept whole.
        expect(countByOffset(l2!)).toEqual({ 0: 6, 2: 3 });
    });

    it('keeps level count and lodDistances unchanged (renderer backfills, LOD schedule intact)', () => {
        const w = world([ch([quads(10), quads(5), quads(2)], emptyVoxels())], [50, 90, 160]);
        applyEffectiveStepSkip(w, 1);
        expect(w.chunks[0]!.lodHints.length).toBe(3);
        expect(w.lodDistances).toEqual([50, 90, 160]);
        expect(w.chunks[0]!.lodHints[0]!.count).toBe(0);  // fine level emptied, not removed
        expect(w.chunks[0]!.lodHints[1]!.count).toBe(5);  // step 1 >= 1 → kept
    });

    it('a single-level chunk is never touched (the only level is the coarsest)', () => {
        const w = world([ch([quads(10)], emptyVoxels())], [50]);
        const original = w.chunks[0]!.lodHints[0]!;
        applyEffectiveStepSkip(w, 3);
        expect(w.chunks[0]!.lodHints[0]).toBe(original);
    });

    it('skip 0 is a no-op that keeps the original column objects', () => {
        const w = world([ch([quads(10), quads(5)], emptyVoxels())]);
        const l0 = w.chunks[0]!.lodHints[0]!;
        applyEffectiveStepSkip(w, 0);
        expect(w.chunks[0]!.lodHints[0]).toBe(l0);
    });

    it('estimateQuadRenderBytes matches what applyEffectiveStepSkip actually keeps', () => {
        const mk = (): DecodedVxlSceneWorld => world([ch([
            quadsByOffset({ 0: 1000, 3: 200 }),
            quadsByOffset({ 0: 250, 3: 60 }),
            quadsByOffset({ 0: 70, 3: 20 }),
        ], emptyVoxels())]);
        for (const s of [0, 1, 2, 3, 4]) {
            const w = mk();
            const estimated = estimateQuadRenderBytes(w, s);
            applyEffectiveStepSkip(w, s);
            const actual = estimateQuadRenderBytes(w, 0); // post-skip world, no further shed
            expect(actual).toBe(estimated);
        }
    });
});

describe('finestKeptQuads', () => {
    it('is exactly lodHints[0] on a full-detail chunk (no copy)', () => {
        const c = ch([quadsByOffset({ 0: 10, 2: 5 }), quadsByOffset({ 0: 3, 2: 2 })], emptyVoxels());
        expect(finestKeptQuads(c)).toBe(c.lodHints[0]);
    });

    it('merges each offset group\'s finest surviving level after a skip', () => {
        const w = world([ch([
            quadsByOffset({ 0: 100, 2: 40 }),
            quadsByOffset({ 0: 25, 2: 10 }),
            quadsByOffset({ 0: 6, 2: 3 }),
        ], emptyVoxels())]);
        applyEffectiveStepSkip(w, 2);
        // offset 0 survives first at level 2 (6 quads); offset 2 at level 0 (40 quads).
        const merged = finestKeptQuads(w.chunks[0]!)!;
        expect(countByOffset(merged)).toEqual({ 0: 6, 2: 40 });
    });

    it('returns null for a chunk with no quads', () => {
        expect(finestKeptQuads(ch([], emptyVoxels()))).toBeNull();
        expect(finestKeptQuads(ch([quads(0), quads(0)], emptyVoxels()))).toBeNull();
    });
});
