import { bakeSceneFromTriangles, type BakeOptions } from 'engine/vxlscene/bakeScene.js';
import { greedyBoxes } from 'engine/vxlscene/ColliderBaker.js';
import { createVxlSceneEncoder, decodeVxlScene, type VxlSceneChunk } from 'engine/vxlscene/VxlSceneFormat.js';
import { worldSoaToObjects } from 'engine/__tests__/vxlSceneSoaTestUtils.js';
import type { RasterTriangle } from 'engine/vxlscene/SurfaceRasterizer.js';
import type { SceneQuad } from 'engine/vxlscene/SceneVoxTypes.js';
import { DEFAULT_OBJECT_CONTROLS, validateObjectControls } from 'engine/vxlscene/SceneVoxTypes.js';
import { buildPathCullMask } from 'engine/vxlscene/PathCull.js';

/** 12 outward-facing triangles of the axis-aligned box [min..max]^3 under one node. */
function boxTris(min: number, max: number, node = 'box'): RasterTriangle[] {
    const a = min, b = max;
    const verts = [
        [a, a, a], [b, a, a], [b, b, a], [a, b, a],
        [a, a, b], [b, a, b], [b, b, b], [a, b, b],
    ] as [number, number, number][];
    const mk = (i: number, j: number, k: number, n: [number, number, number]): RasterTriangle => ({
        v0: verts[i]!, v1: verts[j]!, v2: verts[k]!, normal: n, nodeName: node,
        sampleColor: () => ({ r: 0.3, g: 0.6, b: 0.9 }),
    });
    const quad = (i: number, j: number, k: number, l: number, n: [number, number, number]): RasterTriangle[] =>
        [mk(i, j, k, n), mk(i, k, l, n)];
    return [
        ...quad(0, 3, 2, 1, [0, 0, -1]),
        ...quad(4, 5, 6, 7, [0, 0, 1]),
        ...quad(0, 1, 5, 4, [0, -1, 0]),
        ...quad(3, 7, 6, 2, [0, 1, 0]),
        ...quad(0, 4, 7, 3, [-1, 0, 0]),
        ...quad(1, 2, 6, 5, [1, 0, 0]),
    ];
}

function tri(v0: number[], v1: number[], v2: number[], node = 'f'): RasterTriangle {
    return {
        v0: v0 as [number, number, number], v1: v1 as [number, number, number], v2: v2 as [number, number, number],
        normal: [0, 1, 0], nodeName: node, sampleColor: () => ({ r: 1, g: 1, b: 1 }),
    };
}
/** Horizontal floor at world y=yc over the rectangle x in [x0,x1], z in [z0,z1], under `node`. */
function floorRect(x0: number, x1: number, z0: number, z1: number, yc: number, node: string): RasterTriangle[] {
    return [
        tri([x0, yc, z0], [x1, yc, z0], [x1, yc, z1], node),
        tri([x0, yc, z0], [x1, yc, z1], [x0, yc, z1], node),
    ];
}
/** Floor at y=0.5 covering x in [0,W], z in [0,D]. */
function floor(W: number, D: number, node = 'f'): RasterTriangle[] {
    return floorRect(0, W, 0, D, 0.5, node);
}
/** A single 1x1 horizontal quad at world y=yc, over x,z in [x0,x0+1]x[z0,z0+1]. */
function heroCell(x0: number, z0: number, yc: number, node: string): RasterTriangle[] {
    return floorRect(x0, x0 + 1, z0, z0 + 1, yc, node);
}
/**
 * Floor at y=0.5 with a per-unit-cell CHECKERBOARD color (alternating black/white by
 * floor(x)+floor(z)). At a fine resolution the alternating colors can't merge so the
 * greedy top face splits into many small quads; at a coarse resolution colors are
 * sampled at block centers and merge into far fewer quads — exactly what adaptive
 * per-chunk resolution should produce. Single node 'f'.
 */
function checkerFloor(W: number, D: number): RasterTriangle[] {
    const sampleColor = (p: [number, number, number]): { r: number; g: number; b: number } => {
        const c = (Math.floor(p[0]) + Math.floor(p[2])) % 2 === 0 ? 0 : 1;
        return { r: c, g: c, b: c };
    };
    const mk = (v0: number[], v1: number[], v2: number[]): RasterTriangle => ({
        v0: v0 as [number, number, number], v1: v1 as [number, number, number], v2: v2 as [number, number, number],
        normal: [0, 1, 0], nodeName: 'f', sampleColor,
    });
    return [mk([0, 0.5, 0], [W, 0.5, 0], [W, 0.5, D]), mk([0, 0.5, 0], [W, 0.5, D], [0, 0.5, D])];
}
function opts(o: Partial<BakeOptions> = {}): BakeOptions {
    return { chunkSize: 4, minVoxelSize: 1, maxVoxelSize: 4, additionalLods: 0, lodDistances: [50], fillInterior: false, controlsByNode: {}, ...o };
}
const plusYArea = (quads: SceneQuad[]): number =>
    quads.filter(q => q.axis === 1 && q.dir === 1).reduce((s, q) => s + q.w * q.h, 0);

describe('bakeSceneFromTriangles', () => {
    it('bakes a 4x4 floor into one chunk with quads and voxels', async () => {
        const w = await bakeSceneFromTriangles(floor(4, 4), opts());
        expect(w.chunks.length).toBe(1);
        expect(w.chunks[0]!.lodHints[0]!.length).toBeGreaterThan(0);
        expect(w.chunks[0]!.voxels.length).toBeGreaterThan(0);
    });
    it('a floor spanning two chunks lands in two chunks with no double-surfaced top faces', async () => {
        const w = await bakeSceneFromTriangles(floor(8, 4), opts()); // x in [0,8] -> cx 0,1; z in [0,4] -> cz 0
        expect(w.chunks.length).toBe(2);
        // total +Y (top) area across chunks equals the floor's top area (8*4=32); no duplicated border row
        const totalTop = w.chunks.reduce((s, c) => s + plusYArea(c.lodHints[0]!), 0);
        expect(totalTop).toBe(32);
    });
    it('additionalLods produces a hint per level, coarser <= finer in quad count', async () => {
        const w = await bakeSceneFromTriangles(floor(4, 4), opts({ additionalLods: 1, lodDistances: [50, 120] }));
        const c = w.chunks[0]!;
        expect(c.lodHints).toHaveLength(2);
        expect(c.lodHints[1]!.length).toBeLessThanOrEqual(c.lodHints[0]!.length);
    });

    it('a pinned object keeps its finest detail at LOD1 while the rest coarsens (design §6.2)', async () => {
        // Scene: a 4x4 'ground' floor (y row 0) plus a small 1x1 'hero' surface cell at
        // y row 2 (world y=2.5 -> cell y=2), both inside the one 4x4x4 chunk. The hero
        // sits in its own cell (0,2,0); when pinned it must NOT be downsampled at LOD1.
        const scene: RasterTriangle[] = [...floor(4, 4), ...heroCell(0, 0, 2.5, 'hero')];
        const baseOpts = { additionalLods: 1, lodDistances: [50, 120] } as const;

        const pinned = await bakeSceneFromTriangles(scene, opts({
            ...baseOpts,
            controlsByNode: { hero: { ...DEFAULT_OBJECT_CONTROLS, pinned: true } },
        }));
        const unpinned = await bakeSceneFromTriangles(scene, opts({ ...baseOpts }));

        const cP = pinned.chunks[0]!;
        const cU = unpinned.chunks[0]!;
        expect(cP.lodHints).toHaveLength(2);
        expect(cU.lodHints).toHaveLength(2);

        const lod1P = cP.lodHints[1]!;
        const lod1U = cU.lodHints[1]!;

        // A fine, 1-min-cell quad. The pinned hero contributes these to LOD1; the
        // unpinned (coarsened) hero produces only 2-cell-wide quads (min-cell units).
        const isFineUnit = (q: SceneQuad): boolean => q.w === 1 && q.h === 1;

        // 1) Pinning preserves the hero's fine detail, so the pinned LOD1 has at least
        //    as many quads as the unpinned (coarsened) LOD1 — and (2)/(3) show the
        //    pinned region is genuinely finer.
        expect(lod1P.length).toBeGreaterThanOrEqual(lod1U.length);

        // 2) Fine 1-cell quads survive at LOD1 only when the hero is pinned; with no
        //    pin, EVERY LOD1 quad is coarsened to >=2 min-cells per side.
        expect(lod1P.some(isFineUnit)).toBe(true);
        expect(lod1U.some(isFineUnit)).toBe(false);

        // 3) Specifically the hero's top face survives as a fine +Y unit quad at its
        //    min-cell location (0,2,0) only when pinned; unpinned it coarsens away.
        const isHeroFineTop = (q: SceneQuad): boolean =>
            q.axis === 1 && q.dir === 1 && q.gx === 0 && q.gy === 2 && q.gz === 0 && q.w === 1 && q.h === 1;
        expect(lod1P.some(isHeroFineTop)).toBe(true);
        expect(lod1U.some(isHeroFineTop)).toBe(false);
    });

    it('a one-cell-thick decal must be pinned or the coarsest LOD inflates it into a cube', async () => {
        // The shipped bug: a forged city pins its road surfaces but not the paint on them.
        // Road = a plane at cell row 2 (pinned, so it stays crisp at every level); paint =
        // a smaller plane one cell above it at row 3, render-only. Two extra LODs fold the
        // grid twice, so row 3 lands in a coarse cell spanning min-cell rows 0..3 — a solid
        // 4-cell block whose SIDES are what the player reads as a box on the street. Mobile
        // sheds down to this level and draws it right under the camera, which is why the
        // artifact showed up on a phone and never on desktop.
        const scene: RasterTriangle[] = [
            ...floorRect(0, 8, 0, 8, 2.5, 'road'),
            ...floorRect(2, 6, 2, 6, 3.5, 'paint'),
        ];
        const bake = async (paintPinned: boolean): Promise<SceneQuad[]> => {
            const w = await bakeSceneFromTriangles(scene, opts({
                chunkSize: 8, minVoxelSize: 1, maxVoxelSize: 8,
                additionalLods: 2, lodDistances: [50, 120, 200],
                controlsByNode: {
                    road: { ...DEFAULT_OBJECT_CONTROLS, pinned: true },
                    paint: { ...DEFAULT_OBJECT_CONTROLS, noCollider: true, pinned: paintPinned },
                },
            }));
            expect(w.chunks).toHaveLength(1);
            const hints = w.chunks[0]!.lodHints;
            expect(hints).toHaveLength(3);
            return hints[2]!;
        };
        // A side quad's vertical extent, in min-cells: for an X face (axis 0) that is w
        // (u = Y), for a Z face (axis 2) it is h (v = Y). Top/bottom faces have none.
        const sideHeight = (q: SceneQuad): number => (q.axis === 0 ? q.w : q.axis === 2 ? q.h : 0);
        const tallest = (quads: SceneQuad[]): number => Math.max(0, ...quads.map(sideHeight));

        // Unpinned: the paint is 4 min-cells tall at the coarsest level — the cube.
        expect(tallest(await bake(false))).toBe(4);
        // Pinned: it is split out before the fold and re-injected at min-cell resolution,
        // so nothing in the level is taller than one cell — paint stays paint.
        expect(tallest(await bake(true))).toBe(1);
    });

    it('onProgress is called once per grid chunk; final chunkIndex === totalChunks-1; nonEmptyChunks >= 1 and non-decreasing', async () => {
        // Scene spanning 2 chunks in X (x[0,8] with chunkSize=4 -> cx 0,1; z[0,4] -> cz 0)
        // Grid is 2x1x1 = 2 total chunks.
        interface ProgressInfo { chunkIndex: number; totalChunks: number; nonEmptyChunks: number; label: string }
        const calls: ProgressInfo[] = [];
        await bakeSceneFromTriangles(floor(8, 4), opts({ onProgress: (info) => { calls.push({ ...info }); } }));

        // Called once per grid chunk (2 total).
        expect(calls.length).toBe(2);

        // totalChunks is consistent across all calls.
        const seenTotal = calls[0]!.totalChunks;
        expect(seenTotal).toBe(2);
        for (const c of calls) {
            expect(c.totalChunks).toBe(seenTotal);
        }

        // Final call has chunkIndex === totalChunks - 1.
        expect(calls[calls.length - 1]!.chunkIndex).toBe(seenTotal - 1);

        // nonEmptyChunks >= 1 somewhere (the floor produces voxels).
        const maxNonEmpty = Math.max(...calls.map(c => c.nonEmptyChunks));
        expect(maxNonEmpty).toBeGreaterThanOrEqual(1);

        // nonEmptyChunks is monotonically non-decreasing.
        for (let i = 1; i < calls.length; i++) {
            expect(calls[i]!.nonEmptyChunks).toBeGreaterThanOrEqual(calls[i - 1]!.nonEmptyChunks);
        }
    });

    // ── Adaptive per-chunk resolution (per-object LOD offsets) ──────────────────

    /**
     * A single coarse-offset object is processed at a coarse chunk resolution: its
     * quads carry a high sizeLevel and snap to a coarse world-min-cell grid, with far
     * fewer quads than the same floor at offset 0. chunkSize 8, minVoxelSize 1
     * (worldCellsPerAxis 8); lodOffset 2 → chunkScale 4, chunkCellsPerAxis 2, so the
     * emitted coords/extents are multiples of 4 world-min-cells.
     */
    it('a single coarse-offset (lodOffset 2) floor bakes coarse: sizeLevel>=2, 4-cell-aligned, far fewer quads', async () => {
        const fineOpts = opts({ chunkSize: 8, minVoxelSize: 1, maxVoxelSize: 8 });
        const coarseOpts = opts({
            chunkSize: 8, minVoxelSize: 1, maxVoxelSize: 8,
            controlsByNode: { f: { ...DEFAULT_OBJECT_CONTROLS, lodOffset: 2 } },
        });

        const fine = await bakeSceneFromTriangles(checkerFloor(8, 8), fineOpts);
        const coarse = await bakeSceneFromTriangles(checkerFloor(8, 8), coarseOpts);

        // Single 8×8 chunk either way (floor in [0,8]×[0,8], chunkSize 8).
        expect(fine.chunks.length).toBe(1);
        expect(coarse.chunks.length).toBe(1);

        const coarseQuads = coarse.chunks[0]!.lodHints[0]!;
        const fineQuads = fine.chunks[0]!.lodHints[0]!;
        expect(coarseQuads.length).toBeGreaterThan(0);

        // chunkScale = 2^2 = 4: each coarse quad lives on the 4-min-cell grid. The face
        // PLANE (the face-axis coord plus the renderer's +dir offset) sits on a coarse
        // cell boundary; the two in-plane origin coords and the extents are multiples of 4.
        // (A +dir face stores plane−1 so buildHintMesh's +1 min-cell lands it on the far
        // edge — origin+f, not origin+1 — which is what keeps large voxels from rendering
        // inside-out.)
        for (const q of coarseQuads) {
            const coordOf = (ax: number): number => (ax === 0 ? q.gx : ax === 1 ? q.gy : q.gz);
            const dOff = q.dir === 1 ? 1 : 0; // renderer/collider push the +dir face out 1 min-cell
            expect((coordOf(q.axis) + dOff) % 4).toBe(0); // face plane on the coarse grid
            expect(coordOf((q.axis + 1) % 3) % 4).toBe(0); // in-plane u origin
            expect(coordOf((q.axis + 2) % 3) % 4).toBe(0); // in-plane v origin
            expect(q.w % 4).toBe(0);
            expect(q.h % 4).toBe(0);
        }

        // Voxels likewise live on the coarse grid with sizeLevel >= 2 (offset 2 added).
        const coarseVoxels = coarse.chunks[0]!.voxels;
        expect(coarseVoxels.length).toBeGreaterThan(0);
        for (const v of coarseVoxels) {
            expect(v.sizeLevel).toBeGreaterThanOrEqual(2);
            expect(v.gx % 4).toBe(0);
            expect(v.gy % 4).toBe(0);
            expect(v.gz % 4).toBe(0);
        }

        // Coarse processing means far fewer quads than the offset-0 bake of the same floor.
        expect(coarseQuads.length).toBeLessThan(fineQuads.length);

        // The top (+Y) surface area in world-min-cell units is conserved: the floor's
        // top covers the full 8×8 = 64 min-cells regardless of resolution.
        expect(plusYArea(coarseQuads)).toBe(64);
        expect(plusYArea(fineQuads)).toBe(64);
    });

    /**
     * REGRESSION (inside-out coarse voxels). A greedy quad stores its origin CELL;
     * buildHintMesh places the +dir face by adding exactly ONE MIN-CELL. For a voxel
     * larger than the minimum (any coarse LOD, or any lodOffset>0 object) the source
     * cell spans f>1 min-cells, so localizeChunkResQuads must pre-add (f-1) — otherwise
     * the outer (+dir) faces fold inward by f-1 cells and the mesh renders inside-out.
     * Here a box at lodOffset 3 (cell = 8 min-cells = 2.0 world) voxelizes to a solid
     * 2x2x2 coarse block filling world [2,6]^3; the rendered surface MUST reach 6 on the
     * + sides, not collapse to ~4.25 (origin+1 min-cell).
     */
    it('coarse voxels render their outer faces at the far edge (not inside-out)', async () => {
        const CHUNK = 8, MINV = 0.25; // 32 cells/axis; lodOffset 3 -> coarse cell = 8 min-cells.
        const w = await bakeSceneFromTriangles(boxTris(3, 5, 'box'), opts({
            chunkSize: CHUNK, minVoxelSize: MINV, maxVoxelSize: 8, additionalLods: 0,
            controlsByNode: { box: { ...DEFAULT_OBJECT_CONTROLS, lodOffset: 3 } },
        }));
        expect(w.chunks.length).toBe(1);
        const chunk = w.chunks[0]!;
        const lod0 = chunk.lodHints[0]!;
        const origin = [chunk.cx * CHUNK, chunk.cy * CHUNK, chunk.cz * CHUNK];

        // The box voxelizes to a solid 2×2×2 coarse block filling world [2,6]^3. Each face's
        // RENDERED plane is exactly what buildHintMesh / quadsToTrimesh emit:
        //   plane = (faceAxisCoord + dOffset)·minVoxel + origin,  dOffset = +1 min-cell for
        //   +dir, 0 for −dir. The +dir (far) faces MUST land on the block's outer edge (6.0).
        // Before the fix they collapsed to origin + 1 min-cell (~4.25), folding the box inward
        // by (f−1)·minVoxel = 1.75 — that is the inside-out bug. NB: a bounding box does NOT
        // catch this (the top/side faces' EXTENT still spans to 6); the +dir face PLANE does.
        const tol = MINV;
        for (let ax = 0; ax < 3; ax++) {
            const coordOf = (q: SceneQuad): number => (ax === 0 ? q.gx : ax === 1 ? q.gy : q.gz);
            const plus = lod0.filter(q => q.axis === ax && q.dir === 1);
            const minus = lod0.filter(q => q.axis === ax && q.dir === -1);
            expect(plus.length).toBeGreaterThan(0);
            expect(minus.length).toBeGreaterThan(0);
            const farPlane = Math.max(...plus.map(q => (coordOf(q) + 1) * MINV + origin[ax]!));
            const nearPlane = Math.min(...minus.map(q => coordOf(q) * MINV + origin[ax]!));
            expect(Math.abs(farPlane - 6)).toBeLessThanOrEqual(tol);  // far face on the outer edge
            expect(Math.abs(nearPlane - 2)).toBeLessThanOrEqual(tol); // near face (unaffected) stays put
        }
    });

    /**
     * SPEC: per-OBJECT resolution. Two objects with DIFFERENT nodeNames in the SAME
     * chunk voxelize at THEIR OWN offsets — a +0 object stays fine (0.125 m-equivalent
     * here: sizeLevel 0) while a +2 object in the very same chunk stays coarse
     * (sizeLevel 2). A chunk's geometry is a MIX of resolutions. Under the OLD baker
     * (whole chunk baked at the chunk's MIN/finest overlapping offset) the +2 object
     * would be dragged down to sizeLevel 0 and EVERY voxel/quad would be fine — this
     * test is the proof that no longer happens.
     */
    it('two objects in one chunk keep their OWN resolutions (mixed sizeLevels + quad scales)', async () => {
        // One 8×8×8 chunk. Object A: a fine 1×1 hero cell (offset 0) at world y=0.5
        // (cell y=0) over x,z∈[0,1]. Object B: a coarse floor (offset 2) at world y=0.5
        // over x∈[4,8],z∈[0,8] — disjoint from A in XZ so the two never share a cell.
        // worldMaxSizeLevel = log2(8/1) = 3; B's chunkMaxSizeLevel = 3-2 = 1, and its
        // flat 1×2 coarse-cell slab can't octree-merge, so B voxels emit at sizeLevel
        // 0+2 = 2; A's single cell emits at sizeLevel 0+0 = 0.
        const scene: RasterTriangle[] = [
            ...heroCell(0, 0, 0.5, 'A'),
            ...floorRect(4, 8, 0, 8, 0.5, 'B'),
        ];
        const w = await bakeSceneFromTriangles(scene, opts({
            chunkSize: 8, minVoxelSize: 1, maxVoxelSize: 8,
            controlsByNode: {
                A: { ...DEFAULT_OBJECT_CONTROLS, lodOffset: 0 },
                B: { ...DEFAULT_OBJECT_CONTROLS, lodOffset: 2 },
            },
        }));

        expect(w.chunks.length).toBe(1);
        const chunk = w.chunks[0]!;

        // (1) Voxels are a MIX: BOTH the fine (sizeLevel 0, from A) and the coarse
        //     (sizeLevel 2, from B) sizes coexist in the one chunk.
        const sizeLevels = new Set(chunk.voxels.map(v => v.sizeLevel));
        expect(sizeLevels.has(0)).toBe(true);
        expect(sizeLevels.has(2)).toBe(true);

        // (2) lodHints[0] mixes quad scales: A contributes a fine quad whose w/h are NOT
        //     multiples of 4 (its 1-min-cell face), while B's coarse quads land on the
        //     chunkScale-4 grid with w AND h multiples of 4.
        const lod0 = chunk.lodHints[0]!;
        expect(lod0.length).toBeGreaterThan(0);
        const hasFineQuad = lod0.some(q => (q.w % 4 !== 0) || (q.h % 4 !== 0));
        const hasCoarseQuad = lod0.some(q => q.w % 4 === 0 && q.h % 4 === 0 && q.w >= 4 && q.h >= 4);
        expect(hasFineQuad).toBe(true);
        expect(hasCoarseQuad).toBe(true);

        // (3) The fine 1×1 hero top face survives at its own min-cell location (A is
        //     offset 0, world y=0.5 → cell y=0), and the coarse B voxels live on the
        //     4-cell grid with sizeLevel exactly 2 (offset 2 added to a level-0 leaf).
        const isHeroFineTop = (q: SceneQuad): boolean =>
            q.axis === 1 && q.dir === 1 && q.w === 1 && q.h === 1 && q.gx === 0 && q.gy === 0 && q.gz === 0;
        expect(lod0.some(isHeroFineTop)).toBe(true);
        const coarseVoxels = chunk.voxels.filter(v => v.sizeLevel === 2);
        expect(coarseVoxels.length).toBeGreaterThan(0);
        for (const v of coarseVoxels) {
            expect(v.gx % 4).toBe(0);
            expect(v.gy % 4).toBe(0);
            expect(v.gz % 4).toBe(0);
        }
    });

    /**
     * Single offset shared by EVERY object in a chunk → unchanged behavior: the whole
     * chunk bakes at that one offset exactly as the per-object path collapses to a
     * single group. Two objects, both offset 1, produce voxels all at the SAME coarse
     * sizeLevel on the 2-cell grid (no fine sizeLevel-0 leaks in).
     */
    it('all objects in a chunk sharing one offset bake uniformly (single-group path unchanged)', async () => {
        // One 8×8×8 chunk, two disjoint floors A and B, BOTH offset 1 (chunkScale 2).
        // worldMaxSizeLevel = log2(8/1)=3; chunkMaxSizeLevel = 3-1 = 2. The flat slabs
        // stay level-0 leaves in chunk-res → every emitted voxel is sizeLevel 0+1 = 1.
        const scene: RasterTriangle[] = [
            ...floorRect(0, 4, 0, 8, 0.5, 'A'),
            ...floorRect(4, 8, 0, 8, 0.5, 'B'),
        ];
        const shared = { ...DEFAULT_OBJECT_CONTROLS, lodOffset: 1 };
        const w = await bakeSceneFromTriangles(scene, opts({
            chunkSize: 8, minVoxelSize: 1, maxVoxelSize: 8,
            controlsByNode: { A: shared, B: shared },
        }));
        expect(w.chunks.length).toBe(1);
        const chunk = w.chunks[0]!;
        expect(chunk.voxels.length).toBeGreaterThan(0);
        // Uniform offset → every voxel sits on the coarse (2-cell) grid at sizeLevel ≥ 1;
        // no fine sizeLevel-0 voxel sneaks in (that would be the per-object-mix signature).
        for (const v of chunk.voxels) {
            expect(v.sizeLevel).toBeGreaterThanOrEqual(1);
            expect(v.gx % 2).toBe(0);
            expect(v.gy % 2).toBe(0);
            expect(v.gz % 2).toBe(0);
        }
        // Every LOD0 quad likewise lands on the 2-cell grid: the face PLANE (face-axis
        // coord + the renderer's +dir offset) and the in-plane origin coords / extents are
        // all multiples of 2. (+dir faces store plane−1 so the renderer's +1 min-cell lands
        // on the far edge — the fix that stops large voxels rendering inside-out.)
        for (const q of chunk.lodHints[0]!) {
            const coordOf = (ax: number): number => (ax === 0 ? q.gx : ax === 1 ? q.gy : q.gz);
            const dOff = q.dir === 1 ? 1 : 0;
            expect((coordOf(q.axis) + dOff) % 2).toBe(0);
            expect(coordOf((q.axis + 1) % 3) % 2).toBe(0);
            expect(coordOf((q.axis + 2) % 3) % 2).toBe(0);
            expect(q.w % 2).toBe(0);
            expect(q.h % 2).toBe(0);
        }
    });

    /**
     * Spatial binning correctness: a single triangle whose AABB spans two chunks is
     * processed in BOTH, and the total surface area is conserved (no double-surfacing
     * at the shared border) — mirrors the acceptance "no cross-chunk double-surface".
     */
    it('a triangle spanning two chunks is binned into both with conserved top area', async () => {
        // Floor over x[0,8] (chunkSize 4 → cx 0,1), z[0,4] → cz 0: two chunks, all offset 0.
        const w = await bakeSceneFromTriangles(floor(8, 4), opts());
        expect(w.chunks.length).toBe(2);
        // Both chunks received geometry from the spanning triangles.
        for (const c of w.chunks) {
            expect(c.lodHints[0]!.length).toBeGreaterThan(0);
        }
        // Conserved: total +Y top area across both chunks equals the floor's 8×4 = 32
        // (no duplicated border row from binning a triangle into two chunks).
        const totalTop = w.chunks.reduce((s, c) => s + plusYArea(c.lodHints[0]!), 0);
        expect(totalTop).toBe(32);
    });

    // ── Global-field interior fill (replaces per-chunk winding) ──────────────────

    it('a closed box baked with fillInterior produces LARGE interior voxels (few, high sizeLevel) and few collider boxes', async () => {
        // Box [1.5,30.5]^3 in a single 32×32×32 chunk (chunkSize 32, minVoxel 1 → 32 cells/axis).
        // Non-integer bounds keep the flat faces mid-cell so they rasterize cleanly. The
        // enclosed region is ~28^3 ≈ 22k min-cells: a strong "few large voxels, not volume" case.
        const boxOpts = { chunkSize: 32, minVoxelSize: 1, maxVoxelSize: 4 } as const;
        const w = await bakeSceneFromTriangles(boxTris(1.5, 30.5), opts({ ...boxOpts, fillInterior: true }));
        // Same box with NO interior fill, for an apples-to-apples comparison.
        const surfOnly = await bakeSceneFromTriangles(boxTris(1.5, 30.5), opts({ ...boxOpts, fillInterior: false }));
        expect(w.chunks.length).toBe(1);
        const chunk = w.chunks[0]!;

        // Interior fill ADDS voxels (the enclosed bulk) on top of the surface shell.
        const interiorTotal = chunk.voxels.length;
        const surfaceTotal = surfOnly.chunks[0]!.voxels.length;
        expect(interiorTotal).toBeGreaterThan(surfaceTotal);

        // The added interior voxels are FEW and LARGE: surface is capped at maxVoxelSize
        // (sizeLevel ≤ log2(4)=2), so every voxel with sizeLevel ≥ 3 is interior. The
        // enclosed region is ~28^3 ≈ 22k min-cells but octree-merges to a handful of big
        // voxels — the count is bounded by coarse interior blocks, NOT the min-cell volume.
        const large = chunk.voxels.filter(v => v.sizeLevel >= 3);
        expect(large.length).toBeGreaterThan(0);
        expect(large.length).toBeLessThan(64); // a few big blocks, not thousands
        // Those few large voxels cover a substantial volume despite being few in number
        // (the global field classifies interior conservatively at its ~8 m coarse cell, so
        // the captured interior is the deep core, not the full geometric 28^3).
        const coveredByLarge = large.reduce((s, v) => { const e = 1 << v.sizeLevel; return s + e * e * e; }, 0);
        expect(coveredByLarge).toBeGreaterThan(2000); // thousands of min-cells from a handful of voxels

        // greedyBoxes emits one box per non-noCollider voxel — O(voxels), NOT O(volume).
        // The collider boxes covering the interior bulk are FEW (the large voxels above).
        const boxes = greedyBoxes(chunk.voxels);
        expect(boxes.length).toBe(chunk.voxels.filter(v => !v.noCollider).length);
        const largeBoxes = boxes.filter(b => (b.maxX - b.minX) >= 8);
        expect(largeBoxes.length).toBe(large.length); // one big box per big interior voxel
        expect(largeBoxes.length).toBeLessThan(64);
    });

    it('an OPEN surface (floor) baked with fillInterior produces NO interior voxels', async () => {
        // A flat floor is not an enclosed volume → the flood reaches everywhere → no interior.
        const w = await bakeSceneFromTriangles(floor(8, 8), opts({
            chunkSize: 8, minVoxelSize: 1, maxVoxelSize: 4, fillInterior: true,
        }));
        const allVoxels = w.chunks.flatMap(c => c.voxels);
        expect(allVoxels.length).toBeGreaterThan(0); // surface voxels exist
        // No voxel exceeds the surface cap (maxVoxelSize 4 → sizeLevel ≤ 2); i.e. nothing
        // interior was emitted (interior would be uncapped, sizeLevel ≥ 3 for this chunk).
        for (const v of allVoxels) expect(v.sizeLevel).toBeLessThanOrEqual(2);
    });

    it('a fully-enclosed triangle-free chunk takes the fast path → ONE whole-chunk interior voxel', async () => {
        // A big closed box spanning 2 chunks in X so the box interior contains a chunk that
        // itself holds NO triangles (the triangle-free interior chunk hits the fast path).
        // Box spanning 3 chunks/axis so the centre chunk (1,1,1) is fully interior with no
        // triangles. chunkSize 16, box [1.5,46.5]^3 → chunks cx/cy/cz 0,1,2; centre is (1,1,1).
        const w = await bakeSceneFromTriangles(boxTris(1.5, 46.5), opts({
            chunkSize: 16, minVoxelSize: 1, maxVoxelSize: 4, fillInterior: true,
        }));
        const centre = w.chunks.find(c => c.cx === 1 && c.cy === 1 && c.cz === 1);
        expect(centre).toBeDefined();
        // Triangle-free interior chunk → exactly one whole-chunk voxel (sizeLevel log2(16)=4).
        expect(centre!.voxels.length).toBe(1);
        expect(centre!.voxels[0]!.sizeLevel).toBe(4);
        expect(centre!.voxels[0]!).toMatchObject({ gx: 0, gy: 0, gz: 0 });
        // And it has no rendered quads (no surface).
        for (const lod of centre!.lodHints) expect(lod.length).toBe(0);
    });

    it('fillInterior bake is deterministic (two runs identical voxel + quad counts)', async () => {
        const mk = (): Promise<Awaited<ReturnType<typeof bakeSceneFromTriangles>>> =>
            bakeSceneFromTriangles(boxTris(1.5, 30.5), opts({
                chunkSize: 16, minVoxelSize: 1, maxVoxelSize: 4, fillInterior: true,
            }));
        const a = await mk();
        const b = await mk();
        expect(a.chunks.length).toBe(b.chunks.length);
        const count = (w: typeof a): [number, number] => [
            w.chunks.reduce((s, c) => s + c.voxels.length, 0),
            w.chunks.reduce((s, c) => s + c.lodHints.reduce((t, l) => t + l.length, 0), 0),
        ];
        expect(count(a)).toEqual(count(b));
    });

    // ── Streaming bake (memory-bounded — onChunkBaked) ──────────────────────────

    it('onChunkBaked streams every chunk and accumulates nothing; result is geometry-equivalent to a non-streaming bake', async () => {
        // A multi-chunk scene: a floor over x[0,8],z[0,8] with chunkSize 4 → a 2×2 XZ
        // grid (4 chunks). Plus interior fill on a closed box later for a harder case.
        const scene = floor(8, 8);
        const bakeOpts = opts({ chunkSize: 4, minVoxelSize: 1, maxVoxelSize: 4 });

        // Reference: ordinary (accumulating) bake.
        const nonStreaming = await bakeSceneFromTriangles(scene, bakeOpts);
        expect(nonStreaming.chunks.length).toBeGreaterThan(1); // genuinely multi-chunk

        // Streaming: collect chunks via the sink instead of accumulating them.
        const collected: VxlSceneChunk[] = [];
        const streaming = await bakeSceneFromTriangles(scene, {
            ...bakeOpts,
            onChunkBaked: (c) => { collected.push(c); },
        });

        // (a) Streaming retains NO chunks in the returned world → bounded peak memory.
        expect(streaming.chunks.length).toBe(0);

        // (b) The sink received exactly nonEmptyChunkCount chunks.
        expect(streaming.totals!.nonEmptyChunkCount).toBe(nonStreaming.chunks.length);
        expect(collected.length).toBe(streaming.totals!.nonEmptyChunkCount);

        // Totals match the non-streaming bake's actual geometry.
        const refVoxels = nonStreaming.chunks.reduce((s, c) => s + c.voxels.length, 0);
        const refLod0 = nonStreaming.chunks.reduce((s, c) => s + (c.lodHints[0]?.length ?? 0), 0);
        expect(streaming.totals!.totalVoxels).toBe(refVoxels);
        expect(streaming.totals!.totalLod0Quads).toBe(refLod0);

        // (c) Feeding the streamed chunks through the encoder → decode yields the SAME
        //     geometry as encoding the non-streaming bake. This proves streaming is
        //     equivalent AND that the chunks survived being streamed out one at a time.
        const enc = createVxlSceneEncoder(
            {
                chunkSize: streaming.chunkSize, minVoxelSize: streaming.minVoxelSize,
                bounds: streaming.bounds, lodDistances: streaming.lodDistances,
            },
            { compression: 'none' },
        );
        for (const c of collected) await enc.addChunk(c);
        const streamedDecoded = await decodeVxlScene(await enc.finish());

        // Non-streaming reference, encoded the same way.
        const refEnc = createVxlSceneEncoder(
            {
                chunkSize: nonStreaming.chunkSize, minVoxelSize: nonStreaming.minVoxelSize,
                bounds: nonStreaming.bounds, lodDistances: nonStreaming.lodDistances,
            },
            { compression: 'none' },
        );
        for (const c of nonStreaming.chunks) await refEnc.addChunk(c);
        const refDecoded = await decodeVxlScene(await refEnc.finish());

        expect(streamedDecoded.chunks.length).toBe(refDecoded.chunks.length);
        const streamedObj = worldSoaToObjects(streamedDecoded);
        const refObj = worldSoaToObjects(refDecoded);
        for (let i = 0; i < refObj.length; i++) {
            const s = streamedObj[i]!; const r = refObj[i]!;
            expect({ cx: s.cx, cy: s.cy, cz: s.cz }).toEqual({ cx: r.cx, cy: r.cy, cz: r.cz });
            expect(s.voxels).toEqual(r.voxels);
            expect(s.lodHints).toEqual(r.lodHints);
            expect(s.namedTrimeshes).toEqual(r.namedTrimeshes);
        }
    });

    it('streaming bake with fillInterior + trimesh tallies totals without retaining chunks', async () => {
        // Closed box across 3 chunks/axis with a trimesh-collider object: exercises the
        // interior fast path (triangle-free centre chunk) AND trimesh totals in the sink.
        const bakeOpts = opts({
            chunkSize: 16, minVoxelSize: 1, maxVoxelSize: 4, fillInterior: true,
            controlsByNode: { box: { ...DEFAULT_OBJECT_CONTROLS, trimeshCollider: true } },
        });
        const nonStreaming = await bakeSceneFromTriangles(boxTris(1.5, 46.5, 'box'), bakeOpts);

        const collected: VxlSceneChunk[] = [];
        const streaming = await bakeSceneFromTriangles(boxTris(1.5, 46.5, 'box'), {
            ...bakeOpts,
            onChunkBaked: (c) => { collected.push(c); },
        });

        expect(streaming.chunks.length).toBe(0);
        expect(collected.length).toBe(nonStreaming.chunks.length);
        expect(streaming.totals!.nonEmptyChunkCount).toBe(nonStreaming.chunks.length);

        const refTris = nonStreaming.chunks.reduce((s, c) => s + c.namedTrimeshes.reduce((t, tm) => t + tm.indices.length / 3, 0), 0);
        expect(refTris).toBeGreaterThan(0); // trimesh was actually baked
        expect(streaming.totals!.totalTrimeshTris).toBe(refTris);

        // The streamed-out chunks include the interior fast-path centre chunk.
        const centre = collected.find(c => c.cx === 1 && c.cy === 1 && c.cz === 1);
        expect(centre).toBeDefined();
        expect(centre!.voxels.length).toBe(1);
    });
});

describe('named trimesh-collider grouping', () => {
    it('groups collider triangles by source object name (two objects → distinct named blobs)', async () => {
        // Two boxes in adjacent 4-unit chunks, both flagged trimeshCollider.
        const tris = [...boxTris(0.5, 3.5, 'alpha'), ...boxTris(4.5, 7.5, 'beta')];
        const w = await bakeSceneFromTriangles(tris, opts({
            controlsByNode: {
                alpha: { ...DEFAULT_OBJECT_CONTROLS, trimeshCollider: true },
                beta: { ...DEFAULT_OBJECT_CONTROLS, trimeshCollider: true },
            },
        }));
        // Each chunk's trimeshes are tagged with their source object, and every
        // named blob is a real surface (≥3 indices). Both names exist world-wide.
        const names = new Set<string>();
        for (const c of w.chunks) {
            for (const tm of c.namedTrimeshes) {
                expect(tm.name === 'alpha' || tm.name === 'beta').toBe(true);
                expect(tm.indices.length).toBeGreaterThanOrEqual(3);
                names.add(tm.name);
            }
        }
        expect([...names].sort()).toEqual(['alpha', 'beta']);
    });

    it('excludes objects not flagged as trimeshCollider', async () => {
        const tris = [...boxTris(0.5, 3.5, 'alpha'), ...boxTris(4.5, 7.5, 'plain')];
        const w = await bakeSceneFromTriangles(tris, opts({
            controlsByNode: { alpha: { ...DEFAULT_OBJECT_CONTROLS, trimeshCollider: true } },
        }));
        const allNames = w.chunks.flatMap(c => c.namedTrimeshes.map(t => t.name));
        expect(allNames).toContain('alpha');
        expect(allNames).not.toContain('plain');
    });
});

describe('collisionOnly objects', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    const collisionOnly = {
        ...DEFAULT_OBJECT_CONTROLS,
        collisionOnly: true,
    };

    it('emits a named trimesh and no render voxels or quads', async () => {
        const world = await bakeSceneFromTriangles(
            boxTris(1, 3, 'DungeonCollision'),
            opts({ controlsByNode: { DungeonCollision: collisionOnly } }),
        );
        expect(world.chunks.length).toBeGreaterThan(0);
        expect(world.chunks.flatMap((c) => c.voxels)).toHaveLength(0);
        expect(world.chunks.flatMap((c) => c.lodHints[0] ?? [])).toHaveLength(0);
        expect(world.chunks.flatMap((c) => c.namedTrimeshes).map((m) => m.name))
            .toContain('DungeonCollision');
    });

    it('profiles collision-only chunks with zero render metrics and measured clipping time', async () => {
        type ProfileInfo = Parameters<NonNullable<BakeOptions['profile']>['onChunk']>[0];
        const profiles: ProfileInfo[] = [];
        await bakeSceneFromTriangles(
            boxTris(1, 3, 'DungeonCollision'),
            opts({
                controlsByNode: { DungeonCollision: collisionOnly },
                profile: { onChunk: (info) => { profiles.push(info); } },
            }),
        );

        expect(profiles).toHaveLength(1);
        expect(profiles[0]).toMatchObject({
            index: 0,
            totalChunks: 1,
            cx: 0,
            cy: 0,
            cz: 0,
            surfaceCells: 0,
            interiorCells: 0,
            voxels: 0,
            quads: 0,
            rasterizeMs: 0,
            fillMs: 0,
            compactMs: 0,
            meshMs: 0,
            chunkCellsPerAxis: 4,
            lodOffset: 0,
        });
        expect(profiles[0]!.clipMs).toBeGreaterThanOrEqual(0);
    });

    it('merges one node into at most one named mesh per occupied chunk', async () => {
        const tris = [
            ...boxTris(0.5, 1.5, 'DungeonCollision'),
            ...boxTris(2, 3, 'DungeonCollision'),
        ];
        const world = await bakeSceneFromTriangles(
            tris,
            opts({ controlsByNode: { DungeonCollision: collisionOnly } }),
        );
        for (const chunk of world.chunks) {
            expect(chunk.namedTrimeshes.filter((m) => m.name === 'DungeonCollision').length)
                .toBeLessThanOrEqual(1);
        }
    });

    it.each([
        { noCollider: true },
        { trimeshCollider: true },
        { displacementAxis: 'y' as const },
    ])('drops a conflicting control under collision-only with a warning: %o', (invalid) => {
        // A forge that hands a collision-only node a second flag used to lose its whole bake here
        // (the first field spaceship, on every terrain band). Collision-only already says it all.
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        const controls = { ...DEFAULT_OBJECT_CONTROLS, collisionOnly: true, ...invalid };
        expect(() => validateObjectControls('DungeonCollision', controls)).not.toThrow();
        expect(controls).toEqual({ ...DEFAULT_OBJECT_CONTROLS, collisionOnly: true });
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/DungeonCollision.*collisionOnly/));
    });
});

describe('bakeSceneFromTriangles — path cull', () => {
    /**
     * A 32×16 m floor, with a straight path down its middle (z = 8). Chunks are
     * 4 m, so a keep distance of 2 m spares the two middle chunk rows (cz 1, 2)
     * and drops the outer two entirely.
     */
    const CULL_PATH = [{ x: 0, z: 8 }, { x: 16, z: 8 }, { x: 32, z: 8 }];

    const cullOpts = (distanceM: number, mode: 'both' | 'outside' = 'both'): BakeOptions => opts({
        pathCull: buildPathCullMask(
            { points: CULL_PATH, closed: false, distanceM, mode },
            { minX: 0, minZ: 0, maxX: 32, maxZ: 16 },
        ),
    });

    it('drops the chunks the corridor never reaches', async () => {
        const whole = await bakeSceneFromTriangles(floor(32, 16), opts());
        const culled = await bakeSceneFromTriangles(floor(32, 16), cullOpts(2));
        expect(whole.chunks.length).toBe(32);
        expect(culled.chunks.length).toBe(16);
        // Only the two chunk rows the corridor touches survive.
        for (const c of culled.chunks) {
            expect(c.cz).toBeGreaterThanOrEqual(1);
            expect(c.cz).toBeLessThanOrEqual(2);
        }
    });

    it('keeps exactly the surface inside the corridor, cut at the distance', async () => {
        const culled = await bakeSceneFromTriangles(floor(32, 16), cullOpts(2));
        // Top-face area survives only within ±2 m of z = 8 → 32 m × 4 m.
        const totalTop = culled.chunks.reduce((s, c) => s + plusYArea(c.lodHints[0]!), 0);
        expect(totalTop).toBe(32 * 4);
    });

    it('leaves the bake untouched when the corridor covers everything', async () => {
        const whole = await bakeSceneFromTriangles(floor(32, 16), opts());
        const covered = await bakeSceneFromTriangles(floor(32, 16), cullOpts(100));
        expect(covered.chunks.length).toBe(whole.chunks.length);
        expect(covered.chunks.reduce((s, c) => s + plusYArea(c.lodHints[0]!), 0))
            .toBe(whole.chunks.reduce((s, c) => s + plusYArea(c.lodHints[0]!), 0));
    });

    it('does not move the world bounds — the level keeps its footprint', async () => {
        const whole = await bakeSceneFromTriangles(floor(32, 16), opts());
        const culled = await bakeSceneFromTriangles(floor(32, 16), cullOpts(2));
        expect(culled.bounds).toEqual(whole.bounds);
    });

    it('drops collider trimeshes standing where their voxels were culled', async () => {
        const controlsByNode = { f: { ...DEFAULT_OBJECT_CONTROLS, trimeshCollider: true } };
        const culled = await bakeSceneFromTriangles(
            floor(32, 16),
            opts({ ...cullOpts(2), controlsByNode }),
        );
        // Collision survives only in the two chunk rows the corridor touches.
        for (const chunk of culled.chunks) {
            if (chunk.namedTrimeshes.length === 0) continue;
            expect(chunk.cz).toBeGreaterThanOrEqual(1);
            expect(chunk.cz).toBeLessThanOrEqual(2);
        }
        const countTris = (w: { chunks: Array<{ namedTrimeshes: Array<{ indices: Uint32Array }> }> }): number =>
            w.chunks.reduce((s, c) => s + c.namedTrimeshes.reduce((n, m) => n + m.indices.length / 3, 0), 0);
        const whole = await bakeSceneFromTriangles(floor(32, 16), opts({ controlsByNode }));
        expect(countTris(culled)).toBeGreaterThan(0);
        expect(countTris(culled)).toBeLessThan(countTris(whole));
    });
});
