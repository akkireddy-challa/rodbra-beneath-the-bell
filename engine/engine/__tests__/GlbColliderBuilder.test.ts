/**
 * Tests for GlbColliderBuilder — the pure collider core for GLB native assets'
 * precise-collision option: triangles in, Rapier-ready trimesh out, with the
 * coarse-voxelize auto-simplify path (rasterize -> greedy mesh -> quad trimesh)
 * for meshes over the triangle budget.
 */
import { buildColliderFromTriangles, DEFAULT_GLB_COLLIDER_OPTIONS } from 'engine/GlbColliderBuilder.js';
import type { RasterTriangle } from 'engine/vxlscene/SurfaceRasterizer.js';

/** Construct a real RasterTriangle: tuple verts, unit normal from the winding, constant color. */
function tri(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
): RasterTriangle {
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz);
    if (len === 0) throw new Error('degenerate test triangle');
    return {
        v0: [ax, ay, az],
        v1: [bx, by, bz],
        v2: [cx, cy, cz],
        normal: [nx / len, ny / len, nz / len],
        nodeName: 'test-node',
        sampleColor: () => ({ r: 0.5, g: 0.5, b: 0.5 }),
    };
}

/** An axis-aligned quad grid split into 2 triangles per cell at (x0,z0)-(x1,z1), y=h. */
function planeTris(x0: number, z0: number, x1: number, z1: number, y: number, nx = 1, nz = 1): RasterTriangle[] {
    const tris: RasterTriangle[] = [];
    const dx = (x1 - x0) / nx;
    const dz = (z1 - z0) / nz;
    for (let i = 0; i < nx; i++) {
        for (let j = 0; j < nz; j++) {
            const ax = x0 + i * dx, az = z0 + j * dz, bx = ax + dx, bz = az + dz;
            tris.push(tri(ax, y, az, bx, y, az, bx, y, bz));
            tris.push(tri(ax, y, az, bx, y, bz, ax, y, bz));
        }
    }
    return tris;
}

/** orientTrimeshUpward post-condition: no output triangle's geometric normal points clearly down. */
function expectNoDownwardTriangle(verts: Float32Array, indices: Uint32Array): void {
    for (let t = 0; t < indices.length; t += 3) {
        const i0 = indices[t]!, i1 = indices[t + 1]!, i2 = indices[t + 2]!;
        const ax = verts[i0 * 3]!, ay = verts[i0 * 3 + 1]!, az = verts[i0 * 3 + 2]!;
        const bx = verts[i1 * 3]!, by = verts[i1 * 3 + 1]!, bz = verts[i1 * 3 + 2]!;
        const cx = verts[i2 * 3]!, cy = verts[i2 * 3 + 1]!, cz = verts[i2 * 3 + 2]!;
        const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
        const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
        const nx = e1y * e2z - e1z * e2y;
        const ny = e1z * e2x - e1x * e2z;
        const nz = e1x * e2y - e1y * e2x;
        const len = Math.hypot(nx, ny, nz);
        if (len === 0) continue;
        expect(ny / len).toBeGreaterThanOrEqual(-1e-3);
    }
}

describe('buildColliderFromTriangles', () => {
    test('under budget: direct triangles, not simplified', () => {
        const tris = planeTris(0, 0, 4, 4, 1, 2, 2); // 8 triangles
        const r = buildColliderFromTriangles(tris, { ...DEFAULT_GLB_COLLIDER_OPTIONS, triangleBudget: 100 });
        expect(r.simplified).toBe(false);
        expect(r.triangleCount).toBe(8);
        expect(r.indices.length).toBe(8 * 3);
        expect(r.verts.length).toBe(8 * 9);
        expect(r.cellSize).toBeUndefined();
        // Vertex positions pass through verbatim (first triangle's v0/v1/v2).
        const first = tris[0]!;
        expect(Array.from(r.verts.slice(0, 9))).toEqual([...first.v0, ...first.v1, ...first.v2]);
        // planeTris winds its triangles downward, so this fails unless orientTrimeshUpward ran.
        expectNoDownwardTriangle(r.verts, r.indices);
    });

    test('over budget: simplified via coarse voxelization, lands under budget', () => {
        const tris = planeTris(0, 0, 8, 8, 1, 40, 40); // 3200 triangles
        const r = buildColliderFromTriangles(tris, { ...DEFAULT_GLB_COLLIDER_OPTIONS, triangleBudget: 500, maxCellsPerAxis: 64 });
        expect(r.simplified).toBe(true);
        expect(r.triangleCount).toBeLessThanOrEqual(500);
        expect(r.triangleCount).toBeGreaterThan(0);
        expect(r.cellSize).toBeGreaterThan(0);
        expect(r.indices.length).toBe(r.triangleCount * 3);
        // Every index addresses a real vertex.
        let maxIndex = 0;
        for (const idx of r.indices) maxIndex = Math.max(maxIndex, idx);
        expect(maxIndex).toBeLessThan(r.verts.length / 3);
        // Simplified surface must still be near y=1: all verts within one cell of the plane.
        for (let i = 1; i < r.verts.length; i += 3) {
            expect(Math.abs(r.verts[i]! - 1)).toBeLessThanOrEqual(r.cellSize! + 1e-6);
        }
        expectNoDownwardTriangle(r.verts, r.indices);
    });

    test('over budget far from the origin: grid is rebased into packCell range', () => {
        // Naive world-anchored grid coords would be ~8e7 cells — far outside packCell's
        // +/-65536 range. The builder must rebase to asset-local cells before rasterizing.
        const base = 10_000_000;
        const tris = planeTris(base, base, base + 8, base + 8, 42, 40, 40); // 3200 triangles
        const r = buildColliderFromTriangles(tris, { ...DEFAULT_GLB_COLLIDER_OPTIONS, triangleBudget: 500, maxCellsPerAxis: 64 });
        expect(r.simplified).toBe(true);
        expect(r.triangleCount).toBeLessThanOrEqual(500);
        expect(r.triangleCount).toBeGreaterThan(0);
        // Output stays in world space: the surface sits near y=42 (y is small, so Float32-exact).
        for (let i = 1; i < r.verts.length; i += 3) {
            expect(Math.abs(r.verts[i]! - 42)).toBeLessThanOrEqual(r.cellSize! + 1e-6);
        }
        expectNoDownwardTriangle(r.verts, r.indices);
    });

    test('non-finite vertices throw instead of reaching Rapier', () => {
        const bad = tri(0, 0, 0, 1, 0, 0, 1, 0, 1);
        bad.v1 = [Number.NaN, 0, 0];
        expect(() => buildColliderFromTriangles([bad], DEFAULT_GLB_COLLIDER_OPTIONS))
            .toThrow(/non-finite/i);
    });

    test('empty input throws', () => {
        expect(() => buildColliderFromTriangles([], DEFAULT_GLB_COLLIDER_OPTIONS)).toThrow(/no triangles/i);
    });

    test('unsatisfiable budget: retry cap throws a readable error instead of looping', () => {
        // The coarsest pass over a closed slab still emits ~6 quads = 12 triangles,
        // so a budget of 2 can never be met: all retries must be consumed, then throw.
        const tris = planeTris(0, 0, 8, 8, 1, 40, 40); // 3200 triangles
        expect(() => buildColliderFromTriangles(tris, { ...DEFAULT_GLB_COLLIDER_OPTIONS, triangleBudget: 2, maxCellsPerAxis: 64 }))
            .toThrow(/could not simplify/i);
    });

    test('degenerate bounds (all triangles at one point) throw a readable error', () => {
        const point: RasterTriangle = {
            v0: [1, 1, 1], v1: [1, 1, 1], v2: [1, 1, 1],
            normal: [0, 1, 0], nodeName: 'point', sampleColor: () => ({ r: 1, g: 1, b: 1 }),
        };
        const tris = Array.from({ length: 10 }, () => point);
        expect(() => buildColliderFromTriangles(tris, { ...DEFAULT_GLB_COLLIDER_OPTIONS, triangleBudget: 4 }))
            .toThrow(/bounds/i);
    });
});
