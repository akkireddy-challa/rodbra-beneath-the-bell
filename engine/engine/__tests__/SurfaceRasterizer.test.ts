import { rasterizeChunk, packCell, unpackCell, type RasterTriangle, type RasterCtx } from 'engine/vxlscene/SurfaceRasterizer.js';
import { triBoxOverlap } from 'engine/vxlscene/triBoxOverlap.js';
import { DEFAULT_OBJECT_CONTROLS, type RGB } from 'engine/vxlscene/SceneVoxTypes.js';

function tri(v0: number[], v1: number[], v2: number[], normal: number[], nodeName: string, color: RGB): RasterTriangle {
    return {
        v0: v0 as [number, number, number], v1: v1 as [number, number, number], v2: v2 as [number, number, number],
        normal: normal as [number, number, number], nodeName, sampleColor: () => color,
    };
}
// Floor: two triangles covering x,z in [0,1] at y=0.5, normal +y.
function floorTris(color: RGB, node = 'floor'): RasterTriangle[] {
    return [
        tri([0, 0.5, 0], [1, 0.5, 0], [1, 0.5, 1], [0, 1, 0], node, color),
        tri([0, 0.5, 0], [1, 0.5, 1], [0, 0.5, 1], [0, 1, 0], node, color),
    ];
}
function ctx(over: Partial<RasterCtx> = {}): RasterCtx {
    return {
        originCellX: 0, originCellY: 0, originCellZ: 0,
        cellsPerAxis: 1, minVoxelSize: 1, controlsByNode: {}, ...over,
    };
}

describe('cell key packing', () => {
    it('round-trips a range of coords including negatives and multi-cell', () => {
        const coords: [number, number, number][] = [
            [0, 0, 0], [1, 2, 3], [5, 0, 4], [320, 17, 9], [-1, -2, -3], [-65536, 0, 65535],
        ];
        const keys = coords.map(c => packCell(c[0], c[1], c[2]));
        for (let i = 0; i < coords.length; i++) {
            expect(unpackCell(keys[i])).toEqual(coords[i]);
        }
        expect(new Set(keys).size).toBe(coords.length); // all distinct
    });
});

describe('SurfaceRasterizer multi-cell', () => {
    it('marks every cell a large triangle spans in a 4-cell chunk', () => {
        // floor plane y=0.5 covering x,z in [0,4): a 4x4 grid of cells at cy=0 -> 16 cells
        const tri = (v0: number[], v1: number[], v2: number[]) => ({
            v0: v0 as [number, number, number], v1: v1 as [number, number, number], v2: v2 as [number, number, number],
            normal: [0, 1, 0] as [number, number, number], nodeName: 'f', sampleColor: () => ({ r: 1, g: 1, b: 1 }),
        });
        const tris = [tri([0, 0.5, 0], [4, 0.5, 0], [4, 0.5, 4]), tri([0, 0.5, 0], [4, 0.5, 4], [0, 0.5, 4])];
        const grid = rasterizeChunk(tris, {
            originCellX: 0, originCellY: 0, originCellZ: 0, cellsPerAxis: 4, minVoxelSize: 1, controlsByNode: {},
        });
        expect(grid.size).toBe(16); // 4x4 cells on the y=0 layer
    });
});

describe('SurfaceRasterizer', () => {
    it('marks covered cells as surface with sampled color', () => {
        const grid = rasterizeChunk(floorTris({ r: 0.2, g: 0.4, b: 0.6 }), ctx());
        expect(grid.size).toBe(1);
        const cell = [...grid.values()][0];
        expect(cell.interior).toBe(false);
        expect(cell.color.g).toBeCloseTo(0.4, 5);
    });

    it('finest object owns a contested cell', () => {
        const tris = [
            ...floorTris({ r: 1, g: 0, b: 0 }, 'coarse'), // lodOffset +1 -> size 2 (coarser)
            ...floorTris({ r: 0, g: 0, b: 1 }, 'fine'),   // lodOffset 0  -> size 1 (finest)
        ];
        const grid = rasterizeChunk(tris, ctx({
            controlsByNode: {
                coarse: { ...DEFAULT_OBJECT_CONTROLS, lodOffset: 1 },
                fine: { ...DEFAULT_OBJECT_CONTROLS, lodOffset: 0 },
            },
        }));
        expect(grid.size).toBe(1);
        expect([...grid.values()][0].color.b).toBeGreaterThan(0.5); // blue (fine) won
    });

    it('marks a corner-clipping triangle (conservative, no holes)', () => {
        // tiny triangle wholly inside cell (0,0,0)
        const t = [tri([0.9, 0.9, 0.9], [0.95, 0.9, 0.9], [0.9, 0.95, 0.9], [0, 0, 1], 'x', { r: 1, g: 1, b: 1 })];
        expect(rasterizeChunk(t, ctx()).size).toBe(1);
    });

    it('carries trimesh/displacement flags from controls', () => {
        const grid = rasterizeChunk(floorTris({ r: 1, g: 1, b: 1 }, 'road'), ctx({
            controlsByNode: { road: { ...DEFAULT_OBJECT_CONTROLS, trimeshCollider: true, displacementAxis: 'y' } },
        }));
        const cell = [...grid.values()][0];
        expect(cell.noCollider).toBe(true);
        expect(cell.displacementAxis).toBe('y');
    });

    it('non-displaced cells get dispOffset 0', () => {
        const grid = rasterizeChunk(floorTris({ r: 1, g: 1, b: 1 }), ctx());
        expect([...grid.values()][0].dispOffset).toBe(0);
    });

    it('computes dispOffset from the surface point along the displacement axis', () => {
        // Floor plane at y=0.7, inside the unit cell (0,0,0) centered at y=0.5.
        // displacementAxis 'y', minVoxelSize 1 -> dispOffset = (0.7 - 0.5) / 1 = 0.2.
        const road: RasterTriangle[] = [
            tri([0, 0.7, 0], [1, 0.7, 0], [1, 0.7, 1], [0, 1, 0], 'road', { r: 1, g: 1, b: 1 }),
            tri([0, 0.7, 0], [1, 0.7, 1], [0, 0.7, 1], [0, 1, 0], 'road', { r: 1, g: 1, b: 1 }),
        ];
        const grid = rasterizeChunk(road, ctx({
            controlsByNode: { road: { ...DEFAULT_OBJECT_CONTROLS, displacementAxis: 'y' } },
        }));
        const cell = [...grid.values()][0];
        expect(cell.displacementAxis).toBe('y');
        expect(cell.dispOffset).toBeCloseTo(0.2, 5);
    });
});

/**
 * Coverage-equivalence: the optimized footprint traversal in rasterizeChunk
 * must mark EXACTLY the same set of cell keys as a brute-force reference that
 * triBoxOverlap-tests every cell in the triangle's full world-AABB (clamped to
 * the chunk). This proves the dominant-axis-plane candidate set is a superset
 * of the truly-overlapping cells (no holes) and that triBoxOverlap still rejects
 * the conservative band's non-overlapping cells (no extra cells).
 */
describe('SurfaceRasterizer coverage-equivalence (footprint vs brute-force AABB)', () => {
    // Brute-force reference: the ORIGINAL full-AABB iteration. For a single triangle
    // (finest-wins ordering is irrelevant with one triangle) it visits every cell in
    // the triangle's clamped world-AABB and keeps those triBoxOverlap accepts.
    function bruteForceKeys(t: RasterTriangle, c: RasterCtx): Set<number> {
        const { originCellX, originCellY, originCellZ, cellsPerAxis, minVoxelSize } = c;
        const half = minVoxelSize / 2;
        const h: [number, number, number] = [half, half, half];
        const maxCellX = originCellX + cellsPerAxis - 1;
        const maxCellY = originCellY + cellsPerAxis - 1;
        const maxCellZ = originCellZ + cellsPerAxis - 1;
        const { v0, v1, v2 } = t;
        const triMinX = Math.min(v0[0], v1[0], v2[0]);
        const triMinY = Math.min(v0[1], v1[1], v2[1]);
        const triMinZ = Math.min(v0[2], v1[2], v2[2]);
        const triMaxX = Math.max(v0[0], v1[0], v2[0]);
        const triMaxY = Math.max(v0[1], v1[1], v2[1]);
        const triMaxZ = Math.max(v0[2], v1[2], v2[2]);
        const startCX = Math.max(originCellX, Math.floor(triMinX / minVoxelSize));
        const startCY = Math.max(originCellY, Math.floor(triMinY / minVoxelSize));
        const startCZ = Math.max(originCellZ, Math.floor(triMinZ / minVoxelSize));
        const endCX = Math.min(maxCellX, Math.ceil(triMaxX / minVoxelSize) - 1);
        const endCY = Math.min(maxCellY, Math.ceil(triMaxY / minVoxelSize) - 1);
        const endCZ = Math.min(maxCellZ, Math.ceil(triMaxZ / minVoxelSize) - 1);
        const keys = new Set<number>();
        for (let cx = startCX; cx <= endCX; cx++) {
            for (let cy = startCY; cy <= endCY; cy++) {
                for (let cz = startCZ; cz <= endCZ; cz++) {
                    const center: [number, number, number] = [
                        (cx + 0.5) * minVoxelSize, (cy + 0.5) * minVoxelSize, (cz + 0.5) * minVoxelSize,
                    ];
                    if (triBoxOverlap(center, h, v0, v1, v2)) keys.add(packCell(cx, cy, cz));
                }
            }
        }
        return keys;
    }

    function keysOf(grid: Map<number, unknown>): Set<number> {
        return new Set(grid.keys());
    }

    const cases: { name: string; tri: RasterTriangle; ctx: RasterCtx }[] = [
        {
            // Big flat floor triangle spanning a whole 32-cell chunk on (x,z), thin in y.
            name: 'big flat floor triangle (dominant axis y)',
            tri: tri([0.3, 8.4, 0.3], [31.7, 8.4, 0.3], [31.7, 8.4, 31.7], [0, 1, 0], 'f', { r: 1, g: 1, b: 1 }),
            ctx: ctx({ cellsPerAxis: 32, minVoxelSize: 1 }),
        },
        {
            // Steep/slanted triangle: spans (x,z) AND climbs in y. Dominant axis still y.
            // normal = unit geometric normal of the triangle (as the GLB loader supplies).
            name: 'steep slanted triangle',
            tri: tri([1, 2, 1], [30, 20, 5], [10, 8, 28], [0.525953, -0.850404, 0.013661], 'f', { r: 1, g: 1, b: 1 }),
            ctx: ctx({ cellsPerAxis: 32, minVoxelSize: 1 }),
        },
        {
            // Vertical wall triangle in the x=const plane: dominant axis x, spans (y,z).
            name: 'vertical wall triangle (dominant axis x)',
            tri: tri([12.5, 0.4, 0.4], [12.5, 31.6, 0.4], [12.5, 16, 31.6], [1, 0, 0], 'f', { r: 1, g: 1, b: 1 }),
            ctx: ctx({ cellsPerAxis: 32, minVoxelSize: 1 }),
        },
        {
            // Vertical wall triangle in the z=const plane: dominant axis z, spans (x,y).
            name: 'vertical wall triangle (dominant axis z)',
            tri: tri([0.4, 0.4, 7.5], [31.6, 0.4, 7.5], [16, 31.6, 7.5], [0, 0, -1], 'f', { r: 1, g: 1, b: 1 }),
            ctx: ctx({ cellsPerAxis: 32, minVoxelSize: 1 }),
        },
        {
            // Tiny corner triangle wholly inside one cell.
            name: 'tiny corner triangle',
            tri: tri([0.9, 0.9, 0.9], [0.95, 0.9, 0.9], [0.9, 0.95, 0.9], [0, 0, 1], 'f', { r: 1, g: 1, b: 1 }),
            ctx: ctx({ cellsPerAxis: 4, minVoxelSize: 1 }),
        },
        {
            // Arbitrarily-oriented (diagonal) triangle, dominant axis z (no axis dominant by much).
            // normal = unit geometric normal of the triangle (as the GLB loader supplies).
            name: 'general diagonal triangle',
            tri: tri([2.1, 3.3, 1.7], [25.6, 9.2, 18.4], [7.8, 28.1, 12.9], [-0.518326, -0.250184, 0.817769], 'f', { r: 1, g: 1, b: 1 }),
            ctx: ctx({ cellsPerAxis: 32, minVoxelSize: 1 }),
        },
        {
            // Triangle partially OUTSIDE the chunk on (u,v) and in d: clamping must match.
            name: 'triangle clipped by chunk bounds on all axes',
            tri: tri([-5, 5.5, -5], [40, 5.5, -5], [40, 5.5, 40], [0, 1, 0], 'f', { r: 1, g: 1, b: 1 }),
            ctx: ctx({ cellsPerAxis: 16, minVoxelSize: 1 }),
        },
        {
            // Sub-cell-resolution: minVoxelSize 0.0625 like the real bake, thin floor.
            name: 'fine-resolution floor (minVoxelSize 0.0625)',
            tri: tri([0.05, 0.53, 0.05], [0.95, 0.53, 0.05], [0.95, 0.53, 0.95], [0, 1, 0], 'f', { r: 1, g: 1, b: 1 }),
            ctx: ctx({ cellsPerAxis: 16, minVoxelSize: 0.0625 }),
        },
    ];

    for (const tc of cases) {
        it(`marks exactly the brute-force cell set: ${tc.name}`, () => {
            const expected = bruteForceKeys(tc.tri, tc.ctx);
            const actual = keysOf(rasterizeChunk([tc.tri], tc.ctx));
            // Compare as sorted arrays for a readable diff if they ever diverge.
            const exp = [...expected].sort((a, b) => a - b);
            const act = [...actual].sort((a, b) => a - b);
            expect(act).toEqual(exp);
            // The brute-force set is non-trivial for the spanning cases (guards against
            // a vacuous pass where both happen to be empty).
            if (tc.name !== 'tiny corner triangle') expect(expected.size).toBeGreaterThan(1);
        });
    }
});

describe('SurfaceRasterizer smooth:y displaces the whole solid (renderer collapses to the top)', () => {
    const smoothY = { ...DEFAULT_OBJECT_CONTROLS, displacementAxis: 'y' as const };

    it('marks every face cell of a smooth:y object displaced (excluded from greedy meshing)', () => {
        // The whole road solid must be displaced so the greedy mesher skips ALL of it (no
        // blocky cubes). SurfaceMeshBuilder later collapses each column to its topmost cell.
        const up = rasterizeChunk(floorTris({ r: 1, g: 1, b: 1 }, 'road'), ctx({ controlsByNode: { road: smoothY } }));
        expect([...up.values()][0]!.displacementAxis).toBe('y');
        // A down-facing (underside) face of the same object is ALSO displaced (not gated out).
        const down = rasterizeChunk(
            [
                tri([0, 0.5, 0], [1, 0.5, 1], [1, 0.5, 0], [0, -1, 0], 'road', { r: 1, g: 1, b: 1 }),
                tri([0, 0.5, 0], [0, 0.5, 1], [1, 0.5, 1], [0, -1, 0], 'road', { r: 1, g: 1, b: 1 }),
            ],
            ctx({ controlsByNode: { road: smoothY } }),
        );
        expect([...down.values()][0]!.displacementAxis).toBe('y');
    });
});

describe('SurfaceRasterizer drivable-top guard (displaced vs blocky ownership)', () => {
    // A unit floor (x,z in [0,1]) at height y, normal +y.
    const floorAt = (y: number, node: string): RasterTriangle[] => [
        tri([0, y, 0], [1, y, 0], [1, y, 1], [0, 1, 0], node, { r: 0.5, g: 0.5, b: 0.5 }),
        tri([0, y, 0], [1, y, 1], [0, y, 1], [0, 1, 0], node, { r: 0.5, g: 0.5, b: 0.5 }),
    ];
    const smoothY = { ...DEFAULT_OBJECT_CONTROLS, displacementAxis: 'y' as const };
    const blocky = { ...DEFAULT_OBJECT_CONTROLS, displacementAxis: null };

    it("protects a displaced object's drivable top from a coincident blocky object", () => {
        // A smooth road and blocky terrain contend for the road's only cell — its drivable top.
        // Regression guard: a non-carved road laid ~0.05 m over terrain must NOT lose its surface.
        const grid = rasterizeChunk(
            [...floorAt(0.5, 'road'), ...floorAt(0.5, 'terrain')],
            ctx({ controlsByNode: { road: smoothY, terrain: blocky } }),
        );
        expect(grid.size).toBe(1);
        expect(grid.get(packCell(0, 0, 0))!.displacementAxis).toBe('y'); // road keeps the surface
    });

    it("lets a blocky object win a displaced object's NON-top cell (edge wall covers the culled side)", () => {
        // Road owns a column's top (cy=1) and a lower cell (cy=0); a blocky wall coincides at cy=0.
        const grid = rasterizeChunk(
            [...floorAt(1.5, 'road'), ...floorAt(0.5, 'road'), ...floorAt(0.5, 'wall')],
            ctx({ cellsPerAxis: 2, controlsByNode: { road: smoothY, wall: blocky } }),
        );
        expect(grid.get(packCell(0, 1, 0))!.displacementAxis).toBe('y');  // drivable top stays road
        expect(grid.get(packCell(0, 0, 0))!.displacementAxis).toBeNull(); // side cell: wall wins
    });
});
