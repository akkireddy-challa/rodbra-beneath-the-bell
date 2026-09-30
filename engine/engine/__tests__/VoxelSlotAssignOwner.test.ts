/**
 * The nearest-triangle owner contest that material slots and smart-object
 * parts share: a leaf takes the owner of the closest triangle, an unowned
 * triangle can win a leaf back, and leaves far from any owned geometry are
 * never visited.
 *
 * @jest-environment node
 */
import * as THREE from 'three';
import { nearestOwnerForLeaves } from 'engine/VoxelSlotAssign.js';
import type { Triangle } from 'engine/GLBVoxelizer.js';
import type { OctreeLeaf } from 'engine/VoxelOctreeRenderer.js';

function tri(name: string, x: number, y: number, z: number): Triangle {
    return {
        v0: new THREE.Vector3(x, y, z), v1: new THREE.Vector3(x + 0.5, y, z), v2: new THREE.Vector3(x, y + 0.5, z),
        normal: new THREE.Vector3(0, 0, 1), material: null, uv0: null, uv1: null, uv2: null, col0: null, col1: null, col2: null,
        sourceNodeName: name,
    } as unknown as Triangle;
}

function leaf(x: number, y: number, z: number, size = 0.25): OctreeLeaf {
    return { x, y, z, size, r: 0, g: 0, b: 0 };
}

describe('nearestOwnerForLeaves', () => {
    const triangles = [tri('body', 0, 0, 0), tri('BM_part_blades', 3, 0, 0)];
    const ownerOf = (i: number): number => (triangles[i]!.sourceNodeName === 'BM_part_blades' ? 1 : 0);

    it('gives each leaf the owner of its closest triangle', () => {
        const leaves = [leaf(0, 0, 0), leaf(3, 0, 0), leaf(2.9, 0.1, 0)];
        const owner = nearestOwnerForLeaves(leaves, triangles, ownerOf);
        expect(Array.from(owner)).toEqual([0, 1, 1]);
    });

    it('lets a body triangle win a leaf back from a nearby part', () => {
        // A part triangle right beside a body triangle: the leaf on the body side stays body.
        const close = [tri('body', 0, 0, 0), tri('BM_part_blades', 0.6, 0, 0)];
        const owner = nearestOwnerForLeaves([leaf(0, 0, 0), leaf(0.6, 0, 0)], close, (i) => (i === 1 ? 1 : 0));
        expect(Array.from(owner)).toEqual([0, 1]);
    });

    it('never visits leaves far from any owned geometry', () => {
        const owner = nearestOwnerForLeaves([leaf(50, 50, 50)], triangles, ownerOf);
        expect(Array.from(owner)).toEqual([0]);
    });

    it('is all zeros with no owned triangles at all', () => {
        const owner = nearestOwnerForLeaves([leaf(0, 0, 0), leaf(3, 0, 0)], triangles, () => 0);
        expect(Array.from(owner)).toEqual([0, 0]);
    });
});
