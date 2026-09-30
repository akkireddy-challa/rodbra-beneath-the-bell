import { buildWindingTree, fillInterior, type WindingTriangle } from 'engine/vxlscene/WindingNumberFill.js';
import { packCell, rasterizeChunk, type RasterCtx, type RasterTriangle } from 'engine/vxlscene/SurfaceRasterizer.js';
import type { CellAttr } from 'engine/vxlscene/SceneVoxTypes.js';

/** 12 outward-facing triangles of the axis-aligned box [min..max]^3 (consistent CCW winding). */
function cubeTris(min: number, max: number): WindingTriangle[] {
    const a = min, b = max;
    const v = [
        [a, a, a], [b, a, a], [b, b, a], [a, b, a], // z = a face
        [a, a, b], [b, a, b], [b, b, b], [a, b, b], // z = b face
    ] as [number, number, number][];
    const quad = (i: number, j: number, k: number, l: number): WindingTriangle[] =>
        [{ v0: v[i], v1: v[j], v2: v[k] }, { v0: v[i], v1: v[k], v2: v[l] }];
    return [
        ...quad(0, 3, 2, 1), // -z (outward -z, CCW seen from -z)
        ...quad(4, 5, 6, 7), // +z
        ...quad(0, 1, 5, 4), // -y
        ...quad(3, 7, 6, 2), // +y
        ...quad(0, 4, 7, 3), // -x
        ...quad(1, 2, 6, 5), // +x
    ];
}

/**
 * Local brute-force reference: exact generalized winding number summed over every
 * triangle (Van Oosterom–Strackee solid angle / 4π). The BVH-accelerated windingAt
 * must match this on inside / just-outside / far points.
 */
function bruteWinding(tris: WindingTriangle[], p: [number, number, number]): number {
    const [px, py, pz] = p;
    let sum = 0;
    for (const t of tris) {
        const ax = t.v0[0] - px, ay = t.v0[1] - py, az = t.v0[2] - pz;
        const bx = t.v1[0] - px, by = t.v1[1] - py, bz = t.v1[2] - pz;
        const cx = t.v2[0] - px, cy = t.v2[1] - py, cz = t.v2[2] - pz;
        const la = Math.hypot(ax, ay, az);
        const lb = Math.hypot(bx, by, bz);
        const lc = Math.hypot(cx, cy, cz);
        if (la === 0 || lb === 0 || lc === 0) continue;
        const crx = by * cz - bz * cy;
        const cry = bz * cx - bx * cz;
        const crz = bx * cy - by * cx;
        const numer = ax * crx + ay * cry + az * crz;
        const ab = ax * bx + ay * by + az * bz;
        const ac = ax * cx + ay * cy + az * cz;
        const bc = bx * cx + by * cy + bz * cz;
        const denom = la * lb * lc + ab * lc + ac * lb + bc * la;
        sum += 2 * Math.atan2(numer, denom);
    }
    return sum / (4 * Math.PI);
}

/** Promote plain winding triangles to RasterTriangles (geometric normal, unique node, flat color). */
function toRasterTris(tris: WindingTriangle[]): RasterTriangle[] {
    return tris.map((t, i) => {
        const e1 = [t.v1[0] - t.v0[0], t.v1[1] - t.v0[1], t.v1[2] - t.v0[2]] as const;
        const e2 = [t.v2[0] - t.v0[0], t.v2[1] - t.v0[1], t.v2[2] - t.v0[2]] as const;
        const nx = e1[1] * e2[2] - e1[2] * e2[1];
        const ny = e1[2] * e2[0] - e1[0] * e2[2];
        const nz = e1[0] * e2[1] - e1[1] * e2[0];
        const len = Math.hypot(nx, ny, nz) || 1;
        return {
            v0: t.v0, v1: t.v1, v2: t.v2,
            normal: [nx / len, ny / len, nz / len],
            nodeName: `shell-${i}`,
            sampleColor: () => ({ r: 0.2, g: 0.4, b: 0.6 }),
        };
    });
}

describe('generalized winding number', () => {
    it('center of a closed cube reads ~1 (inside)', () => {
        const w = buildWindingTree(cubeTris(0, 1));
        expect(Math.abs(w.windingAt([0.5, 0.5, 0.5]))).toBeCloseTo(1, 1);
    });
    it('far point reads ~0 (outside)', () => {
        expect(Math.abs(buildWindingTree(cubeTris(0, 1)).windingAt([5, 5, 5]))).toBeCloseTo(0, 2);
    });
    it('robust to a missing face — center still classified inside', () => {
        const tris = cubeTris(0, 1).slice(0, 10); // drop one face (2 tris)
        expect(Math.abs(buildWindingTree(tris).windingAt([0.5, 0.5, 0.5]))).toBeGreaterThan(0.5); // ~0.83
    });

    it('BVH windingAt matches the brute-force reference within 1e-2 (inside / near / far)', () => {
        const tris = cubeTris(0, 1);
        const tree = buildWindingTree(tris);
        // A spread of probe points: deep interior, on-axis interior, just-outside each
        // face/corner, and far field on several bearings.
        const points: [number, number, number][] = [
            [0.5, 0.5, 0.5], [0.25, 0.5, 0.75], [0.9, 0.1, 0.5], [0.5, 0.9, 0.1],
            [-0.05, 0.5, 0.5], [1.05, 0.5, 0.5], [0.5, -0.05, 0.5], [0.5, 1.05, 0.5],
            [0.5, 0.5, -0.05], [0.5, 0.5, 1.05], [-0.1, -0.1, -0.1], [1.1, 1.1, 1.1],
            [3, 0.5, 0.5], [0.5, -4, 0.5], [0.5, 0.5, 6], [-5, -5, -5], [8, 2, -3],
        ];
        for (const p of points) {
            const got = tree.windingAt(p);
            const ref = bruteWinding(tris, p);
            expect(Math.abs(got - ref)).toBeLessThan(1e-2);
        }
    });
});

describe('fillInterior', () => {
    function ctx(): RasterCtx {
        return { originCellX: 0, originCellY: 0, originCellZ: 0, cellsPerAxis: 6, minVoxelSize: 1, controlsByNode: {} };
    }

    /** Set of min-cell keys covered by an interior voxel (expanded over its 2^L extent). */
    function coveredCells(voxels: { gx: number; gy: number; gz: number; sizeLevel: number }[]): Set<number> {
        const set = new Set<number>();
        for (const v of voxels) {
            const ext = 1 << v.sizeLevel;
            for (let dx = 0; dx < ext; dx++)
                for (let dy = 0; dy < ext; dy++)
                    for (let dz = 0; dz < ext; dz++)
                        set.add(packCell(v.gx + dx, v.gy + dy, v.gz + dz));
        }
        return set;
    }

    it('emits interior voxels covering the inside of the cube, leaves exterior empty; does not mutate grid', () => {
        const grid = new Map<number, CellAttr>();
        const tree = buildWindingTree(cubeTris(1, 5)); // cube occupies world [1,5]^3
        const result = fillInterior(grid, ctx(), tree);

        // The grid is NOT mutated — interior is returned separately.
        expect(grid.size).toBe(0);

        // chunk cells 0..5 per axis; centers 0.5..5.5; inside-cube centers are {1.5,2.5,3.5,4.5}.
        // S=1 for a 6-cell chunk, so interior emits size-0 voxels at the interior positions: 4^3 = 64.
        expect(result.voxels.length).toBe(64);
        for (const v of result.voxels) expect(v.sizeLevel).toBe(0);

        const covered = coveredCells(result.voxels);
        expect(covered.has(packCell(2, 2, 2))).toBe(true);
        expect(covered.has(packCell(0, 0, 0))).toBe(false);
        expect(covered.has(packCell(5, 5, 5))).toBe(false);

        // isSolid reflects the filled coarse blocks (S=1 → per-min-cell).
        expect(result.isSolid(2, 2, 2)).toBe(true);
        expect(result.isSolid(0, 0, 0)).toBe(false);
        expect(result.isSolid(5, 5, 5)).toBe(false);
        // Outside the chunk cell range → false.
        expect(result.isSolid(-1, 2, 2)).toBe(false);
        expect(result.isSolid(2, 6, 2)).toBe(false);
    });

    it('interior voxels share a single uniform color (average of surface colors)', () => {
        const grid = new Map<number, CellAttr>();
        // Two surface cells with distinct colors at opposite ends of the cube.
        const surf = (x: number, y: number, z: number, color: { r: number; g: number; b: number }) =>
            grid.set(packCell(x, y, z), { color, nx: 0, ny: 1, nz: 0, interior: false, noCollider: false, displacementAxis: null, pinned: false, dispOffset: 0 });
        surf(1, 1, 1, { r: 1, g: 0, b: 0 }); // red
        surf(4, 4, 4, { r: 0, g: 0, b: 1 }); // blue
        const tree = buildWindingTree(cubeTris(1, 5));
        const result = fillInterior(grid, ctx(), tree);

        expect(result.voxels.length).toBeGreaterThan(0);
        // Every interior voxel carries the SAME uniform color = average(red, blue) = (0.5, 0, 0.5).
        const first = result.voxels[0]!;
        expect(first.color.r).toBeCloseTo(0.5, 5);
        expect(first.color.g).toBeCloseTo(0, 5);
        expect(first.color.b).toBeCloseTo(0.5, 5);
        for (const v of result.voxels) {
            expect(v.color.r).toBe(first.color.r);
            expect(v.color.g).toBe(first.color.g);
            expect(v.color.b).toBe(first.color.b);
        }
        // Interior voxels are colliders with no displacement.
        for (const v of result.voxels) {
            expect(v.noCollider).toBe(false);
            expect(v.disp).toBeNull();
        }
    });

    it('falls back to opts.defaultColor when there are no surface cells', () => {
        const grid = new Map<number, CellAttr>();
        const tree = buildWindingTree(cubeTris(1, 5));
        const result = fillInterior(grid, ctx(), tree, { defaultColor: { r: 0.1, g: 0.2, b: 0.3 } });
        expect(result.voxels.length).toBe(64);
        for (const v of result.voxels) {
            expect(v.color.r).toBeCloseTo(0.1, 5);
            expect(v.color.g).toBeCloseTo(0.2, 5);
            expect(v.color.b).toBeCloseTo(0.3, 5);
        }
    });

    it('LARGE closed shell (cellsPerAxis=64): emits FEW coarse voxels (not ~volume) and runs fast', () => {
        // 64-cell chunk -> coarse stride S=4 (floor(64/2)=32≥16→2; floor(64/4)=16≥16→4;
        // floor(64/8)=8<16→stop). A cube shell well inside leaves a big interior bulk.
        const ctx64: RasterCtx = {
            originCellX: 0, originCellY: 0, originCellZ: 0,
            cellsPerAxis: 64, minVoxelSize: 1, controlsByNode: {},
        };
        // Non-integer bounds so the flat faces sit mid-cell and rasterize cleanly.
        const tris = cubeTris(8.5, 55.5);
        const grid = rasterizeChunk(toRasterTris(tris), ctx64);
        expect(grid.size).toBeGreaterThan(0);
        const surfaceSnapshot = grid.size;

        const tree = buildWindingTree(tris);
        const t0 = performance.now();
        const result = fillInterior(grid, ctx64, tree, { maxSizeLevel: 3 });
        const ms = performance.now() - t0;

        // Grid is not mutated.
        expect(grid.size).toBe(surfaceSnapshot);

        // The interior is ~47^3 ≈ 104k min-cells, but the emitted voxel count must be
        // SMALL — bounded by the coarse-block count (64/4)^3 = 4096, far below the
        // min-cell volume. With maxSizeLevel=3 (≥ strideLevel=2) each inside coarse
        // block collapses to ONE size-2 voxel.
        expect(result.voxels.length).toBeLessThan(5000);
        // Deep interior is classified solid.
        expect(result.isSolid(32, 32, 32)).toBe(true);
        // Clear exterior stays empty.
        expect(result.isSolid(2, 2, 2)).toBe(false);
        expect(result.isSolid(61, 61, 61)).toBe(false);
        // The voxels actually cover the deep interior region.
        const covered = coveredCells(result.voxels);
        expect(covered.has(packCell(32, 32, 32))).toBe(true);
        // Fast: no per-min-cell winding, no nearest-color scan.
        expect(ms).toBeLessThan(2000);
    });
});
