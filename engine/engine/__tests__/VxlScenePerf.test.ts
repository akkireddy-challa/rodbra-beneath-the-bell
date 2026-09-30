/**
 * @jest-environment node
 *
 * Perf probe (NOT part of the normal suite — gated behind RUN_PERF=1).
 * Measures how interior-fill cost scales with cellsPerAxis, to confirm/deny
 * the hypothesis that fillInterior materializes O(volume) CellAttr objects.
 *
 * Run: RUN_PERF=1 NODE_OPTIONS=--max-old-space-size=4096 \
 *      npx jest src/engine/__tests__/VxlScenePerf.test.ts -t fillInterior
 */
import { buildWindingTree, fillInterior, type WindingTriangle } from 'engine/vxlscene/WindingNumberFill.js';
import type { CellAttr } from 'engine/vxlscene/SceneVoxTypes.js';
import type { RasterCtx } from 'engine/vxlscene/SurfaceRasterizer.js';

const perfIt = process.env.RUN_PERF ? it : it.skip;

/** 12 outward triangles of the axis-aligned box [min..max]^3. */
function cubeTris(min: number, max: number): WindingTriangle[] {
    const a = min, b = max;
    const v = [
        [a, a, a], [b, a, a], [b, b, a], [a, b, a],
        [a, a, b], [b, a, b], [b, b, b], [a, b, b],
    ] as [number, number, number][];
    const quad = (i: number, j: number, k: number, l: number): WindingTriangle[] =>
        [{ v0: v[i]!, v1: v[j]!, v2: v[k]! }, { v0: v[i]!, v1: v[k]!, v2: v[l]! }];
    return [
        ...quad(0, 3, 2, 1), ...quad(4, 5, 6, 7), ...quad(0, 1, 5, 4),
        ...quad(3, 7, 6, 2), ...quad(0, 4, 7, 3), ...quad(1, 2, 6, 5),
    ];
}

perfIt('MEASURE fillInterior coarse-voxel emission vs cellsPerAxis', () => {
    const mv = 0.0625; // user's min voxel size
    const maxSizeLevel = Math.round(Math.log2(0.5 / mv)); // matches the real bake (maxVoxelSize 0.5)
    for (const N of [64, 128, 160, 256]) {
        const chunkM = N * mv; // chunk edge in meters
        const tree = buildWindingTree(cubeTris(0.5, chunkM - 0.5)); // closed box filling the chunk
        const grid = new Map<number, CellAttr>();
        const ctx: RasterCtx = {
            originCellX: 0, originCellY: 0, originCellZ: 0,
            cellsPerAxis: N, minVoxelSize: mv, controlsByNode: {},
        };
        const t0 = performance.now();
        const result = fillInterior(grid, ctx, tree, { maxSizeLevel });
        const ms = performance.now() - t0;
        const volume = N * N * N; // min-cell volume of a fully-solid chunk
        console.log(
            `[perf] N=${N} (chunk ${chunkM}m): emitted ${result.voxels.length.toLocaleString()} interior voxels ` +
            `in ${ms.toFixed(1)}ms  (min-cell volume would be ${volume.toLocaleString()})`,
        );
        // Grid is never mutated by the coarse-classify fill.
        expect(grid.size).toBe(0);
        // Voxel count is COARSE (≈ coarse blocks), nowhere near the min-cell volume.
        expect(result.voxels.length).toBeGreaterThan(0);
        expect(result.voxels.length).toBeLessThan(volume / 100);
        // Fast: a handful of ms even at the user's N=256 (no per-cell winding / color scan).
        expect(ms).toBeLessThan(1500);
    }
});
