/**
 * The voxels-collider building blocks, and the one upstream convention the
 * whole feature stands on: a cell with grid coordinate g spans
 * [g, g+1] * voxelSize in the collider's local space. If a rapier upgrade ever
 * moves that (say, to cell-centered-at-g), every voxel surface in the engine
 * shifts by half a voxel — the integration tests below are what catch it.
 *
 * Both cell emitters hand Rapier BOUNDARY cells only. The tests pin that an
 * interior cell is dropped, that nothing thinner than three cells loses any,
 * that a neighbour in another box still counts, and that hollowing changes no
 * surface a ray can reach.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import {
    cellsFromIntBoxes, cellsFromDenseGrid, voxelsDesc,
    getVoxelColliderMode, installVoxelColliderMode, DEFAULT_VOXEL_COLLIDER_MODE,
} from 'engine/physics/VoxelColliders.js';

/** Cell triples as a set of "x,y,z" keys, order-free. */
function keys(cells: Int32Array): Set<string> {
    const out = new Set<string>();
    for (let i = 0; i < cells.length; i += 3) out.add(`${cells[i]},${cells[i + 1]},${cells[i + 2]}`);
    return out;
}

describe('cellsFromIntBoxes', () => {
    it('expands box runs into one triple per cell, honoring offsets', () => {
        const cells = cellsFromIntBoxes([{ x: 1, y: 0, z: 2, w: 2, h: 1, d: 1 }], 10, 20, 30);
        expect(Array.from(cells)).toEqual([11, 20, 32, 12, 20, 32]);
    });

    it('keeps every cell of a shape no thicker than two — nothing is interior', () => {
        const cells = cellsFromIntBoxes([
            { x: 0, y: 0, z: 0, w: 2, h: 3, d: 4 },
            { x: 5, y: 5, z: 5, w: 1, h: 1, d: 1 },
        ]);
        expect(cells.length).toBe((2 * 3 * 4 + 1) * 3);
    });

    it('drops the interior of a solid block', () => {
        const cells = cellsFromIntBoxes([{ x: 0, y: 0, z: 0, w: 3, h: 3, d: 3 }]);
        expect(cells.length).toBe(26 * 3);
        expect(keys(cells).has('1,1,1')).toBe(false);
    });

    it('judges a cell against neighbours that belong to another box', () => {
        // Two boxes that together form the same solid 3x3x3: the centre cell's
        // +x neighbour lives in the second box, and must still count as filled.
        const cells = cellsFromIntBoxes([
            { x: 0, y: 0, z: 0, w: 2, h: 3, d: 3 },
            { x: 2, y: 0, z: 0, w: 1, h: 3, d: 3 },
        ]);
        expect(cells.length).toBe(26 * 3);
        expect(keys(cells).has('1,1,1')).toBe(false);
    });

    it('returns an empty array for no boxes', () => {
        expect(cellsFromIntBoxes([]).length).toBe(0);
    });
});

describe('cellsFromDenseGrid', () => {
    it('reads the (y * nz + z) * nx + x layout back into triples', () => {
        const nx = 2, ny = 2, nz = 2;
        const grid = new Uint8Array(nx * ny * nz);
        grid[(1 * nz + 0) * nx + 1] = 1; // (x=1, y=1, z=0)
        expect(Array.from(cellsFromDenseGrid(grid, nx, ny, nz))).toEqual([1, 1, 0]);
    });

    it('drops the interior of a solid grid', () => {
        const grid = new Uint8Array(27).fill(1);
        const cells = cellsFromDenseGrid(grid, 3, 3, 3);
        expect(cells.length).toBe(26 * 3);
        expect(keys(cells).has('1,1,1')).toBe(false);
    });
});

describe('terrain mode selection', () => {
    afterEach(() => installVoxelColliderMode(null));

    it('defaults to voxels and honors an installed override (the trimesh escape hatch)', () => {
        expect(DEFAULT_VOXEL_COLLIDER_MODE).toBe('voxels');
        expect(getVoxelColliderMode()).toBe('voxels');
        installVoxelColliderMode('trimesh');
        expect(getVoxelColliderMode()).toBe('trimesh');
    });
});

describe('rapier voxels grid convention', () => {
    beforeAll(async () => { await RAPIER.init(); });

    const top = (w: RAPIER.World, x: number, z: number): number | null => {
        const hit = w.castRay(new RAPIER.Ray({ x, y: 15, z }, { x: 0, y: -1, z: 0 }), 30, true);
        return hit ? 15 - hit.timeOfImpact : null;
    };

    it('places cell g at [g, g+1] * voxelSize, shifted by the collider translation', () => {
        const w = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
        const body = w.createRigidBody(RAPIER.RigidBodyDesc.fixed());
        // One 2-cell run at half-meter cells, translated up 10.
        const cells = cellsFromIntBoxes([{ x: 4, y: 0, z: 4, w: 2, h: 1, d: 1 }]);
        w.createCollider(voxelsDesc(cells, 0.5, 0.5, 0.5, 0, 10, 0), body);
        w.step(); // scene queries see new colliders after the next step
        expect(top(w, 2.25, 2.25)).toBeCloseTo(10.5, 5); // inside cell (4,0,4)
        expect(top(w, 2.75, 2.25)).toBeCloseTo(10.5, 5); // inside cell (5,0,4)
        expect(top(w, 1.9, 2.25)).toBeNull();            // just before the run
        expect(top(w, 3.1, 2.25)).toBeNull();            // just past it
        w.free();
    });

    it('a hollowed block reads the same surface as a solid one', () => {
        // 3x3x3 at half-meter cells: the centre cell is dropped, and a ray down
        // the centre column must still stop on the top shell cell at 11.5.
        const w = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
        const body = w.createRigidBody(RAPIER.RigidBodyDesc.fixed());
        const cells = cellsFromIntBoxes([{ x: 0, y: 0, z: 0, w: 3, h: 3, d: 3 }]);
        expect(cells.length).toBe(26 * 3);
        w.createCollider(voxelsDesc(cells, 0.5, 0.5, 0.5, 0, 10, 0), body);
        w.step();
        expect(top(w, 0.75, 0.75)).toBeCloseTo(11.5, 5); // centre column
        expect(top(w, 0.25, 0.25)).toBeCloseTo(11.5, 5); // corner column
        expect(top(w, 1.6, 0.75)).toBeNull();            // off the block
        w.free();
    });
});
