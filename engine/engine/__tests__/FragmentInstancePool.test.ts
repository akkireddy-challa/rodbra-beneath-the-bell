import * as THREE from 'three';
import { FragmentInstancePool } from 'engine/FragmentInstancePool.js';

const mat = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z);

const makePool = (fragments = 3) => {
    const parent = new THREE.Group();
    const sources = Array.from({ length: fragments }, () => ({
        geometry: new THREE.BufferGeometry(),
        material: new THREE.MeshBasicMaterial(),
    }));
    return { parent, pool: new FragmentInstancePool(parent, sources, 'test', true) };
};

const laneMesh = (parent: THREE.Group, fragIndex: number): THREE.InstancedMesh =>
    parent.children.find(c => c.name === `test_frag${fragIndex}`) as THREE.InstancedMesh;

const slotTranslation = (mesh: THREE.InstancedMesh, slot: number): [number, number, number] => {
    const m = new THREE.Matrix4();
    m.fromArray(mesh.instanceMatrix.array as unknown as number[], slot * 16);
    const v = new THREE.Vector3().setFromMatrixPosition(m);
    return [v.x, v.y, v.z];
};

describe('FragmentInstancePool', () => {
    it('creates lanes lazily and only for touched fragment indices', () => {
        const { parent, pool } = makePool(3);
        expect(parent.children.length).toBe(0);
        pool.acquire(1, mat(0, 0, 0));
        expect(parent.children.length).toBe(1);
        expect(laneMesh(parent, 1)).toBeDefined();
        expect(pool.activeCount(0)).toBe(0);
        expect(pool.activeCount(1)).toBe(1);
    });

    it('writes matrices to the rented slot', () => {
        const { parent, pool } = makePool();
        const a = pool.acquire(0, mat(1, 2, 3))!;
        expect(slotTranslation(laneMesh(parent, 0), a.slot)).toEqual([1, 2, 3]);
        a.setMatrix(mat(4, 5, 6));
        expect(slotTranslation(laneMesh(parent, 0), a.slot)).toEqual([4, 5, 6]);
    });

    it('swap-removes on release and keeps surviving handles valid', () => {
        const { parent, pool } = makePool();
        const a = pool.acquire(0, mat(1, 0, 0))!;
        const b = pool.acquire(0, mat(2, 0, 0))!;
        const c = pool.acquire(0, mat(3, 0, 0))!;
        expect(pool.activeCount(0)).toBe(3);

        a.release();
        expect(a.released).toBe(true);
        expect(pool.activeCount(0)).toBe(2);
        // c (the last entry) moved into a's slot and still routes writes there.
        expect(c.slot).toBe(0);
        expect(slotTranslation(laneMesh(parent, 0), 0)).toEqual([3, 0, 0]);
        c.setMatrix(mat(9, 9, 9));
        expect(slotTranslation(laneMesh(parent, 0), 0)).toEqual([9, 9, 9]);
        // b untouched.
        expect(slotTranslation(laneMesh(parent, 0), b.slot)).toEqual([2, 0, 0]);

        // Double-release is a no-op.
        a.release();
        expect(pool.activeCount(0)).toBe(2);
    });

    it('grows capacity, preserving matrices and handle routing', () => {
        const { parent, pool } = makePool(1);
        const handles = Array.from({ length: 20 }, (_, i) => pool.acquire(0, mat(i, 0, 0))!);
        expect(pool.activeCount(0)).toBe(20);
        const mesh = laneMesh(parent, 0);
        // One lane mesh only (old ones removed on growth).
        expect(parent.children.length).toBe(1);
        handles.forEach((h, i) => {
            expect(slotTranslation(mesh, h.slot)[0]).toBe(i);
        });
        handles[7]!.setMatrix(mat(70, 0, 0));
        expect(slotTranslation(mesh, handles[7]!.slot)).toEqual([70, 0, 0]);
    });

    it('does not dispose shared geometry on pool dispose, and voids handles', () => {
        const { parent, pool } = makePool(2);
        const src0 = pool.acquire(0, mat(0, 0, 0))!;
        const geom = laneMesh(parent, 0).geometry;
        const disposeSpy = jest.spyOn(geom, 'dispose');
        pool.dispose();
        expect(disposeSpy).not.toHaveBeenCalled();
        expect(parent.children.length).toBe(0);
        expect(src0.released).toBe(true);
        // Post-dispose interaction is inert.
        src0.setMatrix(mat(1, 1, 1));
        src0.release();
        expect(pool.acquire(0, mat(0, 0, 0))).toBeNull();
    });
});
