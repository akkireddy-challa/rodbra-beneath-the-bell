import { VoxelNavMesh, MinHeap } from 'engine/VoxelNavMesh.js';

describe('VoxelNavMesh cell API', () => {
    test('MinHeap is exported and orders by f', () => {
        const h = new MinHeap();
        h.push({ gx: 0, gz: 0, g: 0, f: 5 });
        h.push({ gx: 1, gz: 0, g: 0, f: 1 });
        h.push({ gx: 2, gz: 0, g: 0, f: 3 });
        expect(h.pop()?.f).toBe(1);
        expect(h.pop()?.f).toBe(3);
        expect(h.pop()?.f).toBe(5);
    });

    test('grid info and cell queries on an unbuilt mesh are safe', () => {
        const mesh = new VoxelNavMesh();
        expect(mesh.isReady()).toBe(false);
        expect(mesh.getGridInfo()).toBeNull();
        expect(mesh.getCellGroundY(0, 0)).toBeNull();
        expect(mesh.canStepCells(0, 0, 1, 0)).toBe(false);
    });
});
