import { greedyMesh } from 'engine/vxlscene/GreedyMesher.js';
import { packCell } from 'engine/vxlscene/SurfaceRasterizer.js';
import type { CellAttr, SceneQuad } from 'engine/vxlscene/SceneVoxTypes.js';

function cell(color = { r: 1, g: 1, b: 1 }): CellAttr {
    return { color, nx: 0, ny: 1, nz: 0, interior: false, noCollider: false, displacementAxis: null };
}
function box(nx: number, ny: number, nz: number, colorAt?: (x: number, y: number, z: number) => { r: number; g: number; b: number }): Map<number, CellAttr> {
    const g = new Map<number, CellAttr>();
    for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) {
        g.set(packCell(x, y, z), cell(colorAt ? colorAt(x, y, z) : { r: 1, g: 1, b: 1 }));
    }
    return g;
}
const area = (q: SceneQuad[]): number => q.reduce((s, x) => s + x.w * x.h, 0);

describe('greedyMesh', () => {
    it('single solid cell -> 6 quads, area 6', () => {
        const q = greedyMesh(box(1, 1, 1));
        expect(q).toHaveLength(6);
        expect(area(q)).toBe(6);
    });
    it('2x2x1 uniform slab -> 6 quads (internal faces culled, merged), area 16', () => {
        const q = greedyMesh(box(2, 2, 1));
        expect(q).toHaveLength(6);
        expect(area(q)).toBe(16);
    });
    it('3x3x3 uniform cube -> 6 quads, area 54', () => {
        const q = greedyMesh(box(3, 3, 3));
        expect(q).toHaveLength(6);
        expect(area(q)).toBe(54);
    });
    it('color-aware: a 2x1x1 row of two different colors does not merge same-orientation faces', () => {
        const uniform = greedyMesh(box(2, 1, 1));
        expect(uniform).toHaveLength(6);          // ±Y,±Z merged across both cells; ±X end caps
        expect(area(uniform)).toBe(10);
        const twoColor = greedyMesh(box(2, 1, 1, (x) => (x === 0 ? { r: 1, g: 0, b: 0 } : { r: 0, g: 0, b: 1 })));
        expect(area(twoColor)).toBe(10);          // same exposed area, conserved
        expect(twoColor.length).toBeGreaterThan(6); // but split by color -> more quads (10)
    });
    it('isSolidExtra culls faces against the (out-of-grid) interior bulk', () => {
        // A lone surface cell at the origin. With no extra occupancy it is a free cube
        // (6 faces). Mark its -X neighbour solid via isSolidExtra → the -X face is culled.
        const g = box(1, 1, 1);
        const base = greedyMesh(g);
        expect(base).toHaveLength(6);
        expect(area(base)).toBe(6);

        const culled = greedyMesh(g, {
            isSolidExtra: (x, y, z) => x === -1 && y === 0 && z === 0,
        });
        // One face (-X) removed; the other five remain.
        expect(culled).toHaveLength(5);
        expect(area(culled)).toBe(5);
        expect(culled.some(q => q.axis === 0 && q.dir === -1)).toBe(false); // -X face gone
        // isSolidExtra never makes a cell EMIT a face — only the grid cell does.
        expect(culled.every(q => q.gx === 0 && q.gy === 0 && q.gz === 0)).toBe(true);
    });

    it('skips displaced cells: they emit no greedy quads (rendered as displaced cubes instead)', () => {
        // Two adjacent cells; one is displaced (displacementAxis 'y'), one is grid-aligned.
        const g = new Map<number, CellAttr>();
        g.set(packCell(0, 0, 0), { ...cell(), displacementAxis: 'y' }); // displaced -> excluded
        g.set(packCell(1, 0, 0), cell());                                // grid-aligned -> meshed
        const q = greedyMesh(g);
        // Only the null cell contributes. Treated as a lone cube (its neighbour is
        // absent for the sweep), so all 6 faces are exposed.
        expect(q).toHaveLength(6);
        expect(area(q)).toBe(6);
        // Every quad must originate at the grid-aligned cell (gx === 1), never the displaced one.
        expect(q.every(quad => quad.gx === 1)).toBe(true);
    });
});

// ── Property test: the sparse sweep must be LOSSLESS — exploding the merged quads back to
//    unit faces must reproduce EXACTLY the naive per-cell exposed-face set (same cell, axis,
//    dir, color, collidability). This guards the sparse-bucketing refactor against any
//    missing/extra/mis-coloured face, independent of the specific rectangle grouping. ──
describe('greedyMesh sparse sweep is lossless vs the naive per-face reference', () => {
    const q255 = (c: number): number => Math.round(c * 255);
    const ckey = (c: { r: number; g: number; b: number }, nc: boolean): number =>
        (((q255(c.r) * 256 + q255(c.g)) * 256 + q255(c.b)) << 1) | (nc ? 1 : 0);

    /** Decode covered unit faces from merged quads: key->mergeKey. */
    function explode(quads: SceneQuad[]): Map<string, number> {
        const out = new Map<string, number>();
        for (const q of quads) {
            const d = q.axis, u = (d + 1) % 3, v = (d + 2) % 3;
            for (let iu = 0; iu < q.w; iu++) {
                for (let iv = 0; iv < q.h; iv++) {
                    const cell: [number, number, number] = [q.gx, q.gy, q.gz];
                    cell[u] += iu; cell[v] += iv;
                    out.set(`${cell[0]},${cell[1]},${cell[2]},${d},${q.dir}`, ckey(q.color, q.noCollider));
                }
            }
        }
        return out;
    }

    // Seeded LCG so failures reproduce (Math.random would be non-deterministic).
    let seed = 0x12345;
    const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const ri = (n: number): number => Math.floor(rnd() * n);

    function randomGrid(extent: number, palette: Array<{ r: number; g: number; b: number }>): { grid: Map<number, CellAttr>; coords: Array<[number, number, number]> } {
        const grid = new Map<number, CellAttr>();
        const coords: Array<[number, number, number]> = [];
        for (let x = 0; x < extent; x++) for (let y = 0; y < extent; y++) for (let z = 0; z < extent; z++) {
            if (rnd() < 0.5) continue; // ~half occupancy
            const color = palette[ri(palette.length)]!;
            const displaced = rnd() < 0.1;
            const noCollider = rnd() < 0.25;
            grid.set(packCell(x, y, z), { color, nx: 0, ny: 1, nz: 0, interior: false, noCollider, displacementAxis: displaced ? 'y' : null });
            if (!displaced) coords.push([x, y, z]);
        }
        return { grid, coords };
    }

    /** Naive faces computed from explicit coords (avoids unpack). */
    function naive(grid: Map<number, CellAttr>, coords: Array<[number, number, number]>, isSolidExtra?: (x: number, y: number, z: number) => boolean): Map<string, number> {
        const out = new Map<string, number>();
        const at = (x: number, y: number, z: number): CellAttr | undefined => {
            const c = grid.get(packCell(x, y, z));
            return c && c.displacementAxis === null ? c : undefined;
        };
        const solid = (x: number, y: number, z: number): boolean => at(x, y, z) !== undefined || (isSolidExtra?.(x, y, z) ?? false);
        for (const [x, y, z] of coords) {
            const c = at(x, y, z)!;
            for (let d = 0; d < 3; d++) {
                for (const dir of [-1, 1]) {
                    const n: [number, number, number] = [x, y, z];
                    n[d] += dir;
                    if (solid(n[0], n[1], n[2])) continue;
                    out.set(`${x},${y},${z},${d},${dir}`, ckey(c.color, c.noCollider));
                }
            }
        }
        return out;
    }

    const palette = [
        { r: 1, g: 0, b: 0 }, { r: 0, g: 1, b: 0 }, { r: 0, g: 0, b: 1 }, { r: 1, g: 1, b: 1 },
    ];

    it('100 random grids: merged quads explode back to the exact naive face set', () => {
        for (let t = 0; t < 100; t++) {
            const { grid, coords } = randomGrid(6, palette);
            // Half the runs add an isSolidExtra predicate (random plane) to exercise interior culling.
            const useExtra = (t % 2) === 0;
            const extra = useExtra ? (x: number, _y: number, _z: number): boolean => x < 0 : undefined;
            const got = explode(greedyMesh(grid, extra ? { isSolidExtra: extra } : undefined));
            const want = naive(grid, coords, extra);
            expect(got.size).toBe(want.size);
            for (const [k, val] of want) expect(got.get(k)).toBe(val);
        }
    });
});
