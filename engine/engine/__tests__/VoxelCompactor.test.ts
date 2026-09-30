import { compact, type CompactCtx } from 'engine/vxlscene/VoxelCompactor.js';
import { packCell } from 'engine/vxlscene/SurfaceRasterizer.js';
import type { CellAttr } from 'engine/vxlscene/SceneVoxTypes.js';

function mk(over: Partial<CellAttr>): CellAttr {
    return { color: { r: 0.5, g: 0.5, b: 0.5 }, nx: 0, ny: 1, nz: 0, interior: false, noCollider: false, displacementAxis: null, ...over };
}
function cube(n: number, attr: (i: number) => CellAttr, omit?: [number, number, number]): Map<number, CellAttr> {
    const g = new Map<number, CellAttr>();
    let i = 0;
    for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) for (let z = 0; z < n; z++) {
        if (omit && omit[0] === x && omit[1] === y && omit[2] === z) continue;
        g.set(packCell(x, y, z), attr(i++));
    }
    return g;
}
const ctx = (over: Partial<CompactCtx> = {}): CompactCtx => ({ maxSizeLevel: 4, coplanarCos: 0.95, colorTol: 0.1, ...over });

describe('VoxelCompactor', () => {
    it('uniform interior 2x2x2 merges to one size-1 voxel', () => {
        const v = compact(cube(2, () => mk({ interior: true })), ctx());
        expect(v).toHaveLength(1);
        expect(v[0].sizeLevel).toBe(1);
        expect([v[0].gx, v[0].gy, v[0].gz]).toEqual([0, 0, 0]);
    });
    it('interior 2x2x2 with one empty cell does NOT merge', () => {
        const v = compact(cube(2, () => mk({ interior: true }), [1, 1, 1]), ctx());
        expect(v).toHaveLength(7);
        expect(v.every(x => x.sizeLevel === 0)).toBe(true);
    });
    it('coplanar same-color surface block merges to size 1', () => {
        const v = compact(cube(2, () => mk({ color: { r: 0.2, g: 0.5, b: 0.7 } })), ctx());
        expect(v.map(x => x.sizeLevel)).toEqual([1]);
    });
    it('a bent-normal surface block does NOT merge', () => {
        const norms: [number, number, number][] = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [-1, 0, 0], [0, -1, 0], [0, 0, -1], [0.7, 0.7, 0], [0, 0.7, 0.7]];
        const v = compact(cube(2, (i) => mk({ nx: norms[i]![0], ny: norms[i]![1], nz: norms[i]![2] })), ctx());
        expect(v).toHaveLength(8);
        expect(v.every(x => x.sizeLevel === 0)).toBe(true);
    });
    it('displaced cells stay size 0', () => {
        const v = compact(cube(2, () => mk({ displacementAxis: 'y' })), ctx());
        expect(v.every(x => x.sizeLevel === 0)).toBe(true);
    });
    it('emits the displacement vector on a size-0 displaced cell (axis-only, int8)', () => {
        const g = new Map<number, CellAttr>();
        g.set(packCell(0, 0, 0), mk({ displacementAxis: 'y', dispOffset: 0.2 }));
        const v = compact(g, ctx());
        expect(v).toHaveLength(1);
        expect(v[0].sizeLevel).toBe(0);
        expect(v[0].disp).toEqual({ dx: 0, dy: 25, dz: 0 }); // round(0.2*127) = 25
    });
    it('non-displaced voxels keep disp null', () => {
        const v = compact(cube(2, () => mk({ interior: true })), ctx());
        expect(v).toHaveLength(1);
        expect(v[0].disp).toBeNull();
    });
});
