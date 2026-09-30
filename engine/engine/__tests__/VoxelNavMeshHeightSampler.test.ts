/**
 * The height-sampler build (forged levels) must produce the same navmesh the
 * voxel build does: uniform ground is a trivial chunk, holes and ledges make
 * grid cells, and paths route around registered obstacles.
 */
import * as THREE from 'three';
import { VoxelNavMesh } from 'engine/VoxelNavMesh.js';

/** Flat ground at y=10 with a 6×6 m hole and a 3 m-high ledge along x ≥ 20. */
const sampler = (x: number, z: number): number | null => {
    if (x >= -3 && x <= 3 && z >= -3 && z <= 3) return null;   // a pit
    if (x >= 20) return 13;                                     // a wall-height ledge
    return 10;
};

describe('VoxelNavMesh.buildFromHeightSampler', () => {
    it('builds walkable ground with a hole and a wall, at the sampled heights', () => {
        const nav = new VoxelNavMesh();
        nav.buildFromHeightSampler(sampler, -32, 32, -32, 32, 0.5, { cellSize: 1 });
        expect(nav.isReady()).toBe(true);
        expect(nav.isValidNavigationTarget(new THREE.Vector3(-10, 10, -10))).toBe(true);
        expect(nav.isValidNavigationTarget(new THREE.Vector3(0, 10, 0))).toBe(false);     // the pit
        const cell = nav.worldToCell(-10, -10)!;
        expect(nav.getCellGroundY(cell.gx, cell.gz)).toBeCloseTo(10, 3);
        // A 3 m ledge is a wall: no step onto it from the street.
        const low = nav.worldToCell(19.5, 0)!;
        const high = nav.worldToCell(20.5, 0)!;
        expect(nav.canStepCells(low.gx, low.gz, high.gx, high.gz)).toBe(false);
    });

    it('paths around a box obstacle instead of through it', () => {
        const nav = new VoxelNavMesh();
        nav.buildFromHeightSampler(sampler, -32, 32, -32, 32, 0.5, { cellSize: 1 });
        nav.addObstacle({ kind: 'box', x: -12, z: 0, halfW: 1.5, halfD: 4 });   // an overturned bus
        const path = nav.findPath(new THREE.Vector3(-20, 10, 0), new THREE.Vector3(-4, 10, 0));
        expect(path.length).toBeGreaterThan(2);
        for (const p of path) {
            const inside = Math.abs(p.x + 12) < 1.5 && Math.abs(p.z) < 4;
            expect(inside).toBe(false);
        }
    });
});
