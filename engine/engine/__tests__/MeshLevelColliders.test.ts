import * as THREE from 'three';
import { CollisionGroup } from 'engine/CollisionLayers.js';
import { buildColliderFromTriangles, DEFAULT_GLB_COLLIDER_OPTIONS } from 'engine/GlbColliderBuilder.js';
import {
    planCollider,
    orientedBoxContains,
    colliderBounds,
    symmetricExtent,
    soupToRasterTriangles,
    yawQuaternion,
} from 'engine/meshlevel/MeshLevelColliders.js';
import type { MeshLevelCollider } from 'engine/meshlevel/MeshLevelSchema.js';

describe('planCollider', () => {
    it('halves a box and turns yaw into a +Y rotation in the gameplay convention (+Z forward)', () => {
        const plan = planCollider({ name: 'wall', shape: 'box', position: [1, 2, 3], size: [4, 6, 8], yaw: Math.PI / 2 }, 'terrain');
        expect(plan.position.toArray()).toEqual([1, 2, 3]);
        expect(plan.shape.type).toBe('box');
        if (plan.shape.type === 'box') expect(plan.shape.halfExtents.toArray()).toEqual([2, 3, 4]);
        // Local +Z at yaw π/2 points along world +X (coordinate-system.md cheat sheet).
        const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(plan.quaternion);
        expect(forward.x).toBeCloseTo(1, 6);
        expect(forward.z).toBeCloseTo(0, 6);
    });

    it('resolves the collision group: record wins, else the level default', () => {
        const record: MeshLevelCollider = { name: 'floor', shape: 'box', position: [0, 0, 0], size: [1, 1, 1], yaw: 0 };
        expect(planCollider(record, 'terrain').collisionGroup).toBe(CollisionGroup.TERRAIN);
        expect(planCollider(record, 'environment').collisionGroup).toBe(CollisionGroup.ENVIRONMENT);
        expect(planCollider({ ...record, group: 'environment' }, 'terrain').collisionGroup).toBe(CollisionGroup.ENVIRONMENT);
    });

    it('places hulls and trimeshes at the origin because their vertices are already world space', () => {
        const hull = planCollider({ name: 'ramp', shape: 'convexHull', vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] }, 'terrain');
        expect(hull.position.toArray()).toEqual([0, 0, 0]);
        expect(hull.shape.type).toBe('convexHull');
        const tri = planCollider({ name: 'cage', shape: 'trimesh', vertices: [0, 0, 0, 1, 0, 0, 0, 0, 1], indices: [0, 1, 2] }, 'terrain');
        expect(tri.shape.type).toBe('trimesh');
        if (tri.shape.type === 'trimesh') expect(tri.shape.indices).toBeInstanceOf(Uint32Array);
    });
});

describe('orientedBoxContains', () => {
    const position: [number, number, number] = [10, 0, 10];
    const size: [number, number, number] = [4, 2, 1]; // long along X before rotation
    it('answers inside/outside/edge for an unrotated box', () => {
        expect(orientedBoxContains({ x: 11.9, y: 0.9, z: 10.4 }, position, size, 0)).toBe(true);
        expect(orientedBoxContains({ x: 12.1, y: 0, z: 10 }, position, size, 0)).toBe(false);
        expect(orientedBoxContains({ x: 12, y: 1, z: 10.5 }, position, size, 0)).toBe(true);
    });
    it('rotates the query into the box frame: at yaw π/2 the long axis lies along Z', () => {
        expect(orientedBoxContains({ x: 10, y: 0, z: 11.8 }, position, size, Math.PI / 2)).toBe(true);
        expect(orientedBoxContains({ x: 11.8, y: 0, z: 10 }, position, size, Math.PI / 2)).toBe(false);
    });
    it('agrees with a THREE rotation of the same yaw', () => {
        const yaw = 0.7;
        const local = new THREE.Vector3(1.9, 0, 0.4);
        const world = local.clone().applyQuaternion(yawQuaternion(yaw)).add(new THREE.Vector3(...position));
        expect(orientedBoxContains(world, position, size, yaw)).toBe(true);
        const outsideLocal = new THREE.Vector3(2.1, 0, 0);
        const outsideWorld = outsideLocal.applyQuaternion(yawQuaternion(yaw)).add(new THREE.Vector3(...position));
        expect(orientedBoxContains(outsideWorld, position, size, yaw)).toBe(false);
    });
});

describe('colliderBounds / symmetricExtent', () => {
    it('covers rotated box corners and hull vertices', () => {
        const bounds = colliderBounds([
            { name: 'a', shape: 'box', position: [0, 0, 0], size: [2, 2, 2], yaw: Math.PI / 4 },
            { name: 'h', shape: 'convexHull', vertices: [5, 0, 0, 6, 0, 0, 5, 1, 0, 5, 0, 7] },
        ]);
        expect(bounds).not.toBeNull();
        expect(bounds!.minX).toBeCloseTo(-Math.SQRT2, 6);
        expect(bounds!.maxX).toBe(6);
        expect(bounds!.maxZ).toBe(7);
        expect(bounds!.minY).toBe(-1);
    });
    it('returns null for no colliders', () => {
        expect(colliderBounds([])).toBeNull();
    });
    it('symmetricExtent grows an off-centre level to its farthest edge on each axis', () => {
        const ext = symmetricExtent({ minX: 10, maxX: 50, minY: 0, maxY: 3, minZ: -5, maxZ: 2 });
        expect(ext).toEqual({ minX: -50, maxX: 50, minZ: -5, maxZ: 5 });
    });
});

describe('soupToRasterTriangles', () => {
    it('round-trips a soup into the collider builder and skips degenerate triangles', () => {
        const verts = new Float32Array([0, 0, 0, 4, 0, 0, 0, 0, 4, 4, 0, 4, 0, 0, 0]);
        const indices = new Uint32Array([0, 2, 1, 1, 2, 3, 0, 0, 4]); // last triangle is degenerate (two identical points)
        const tris = soupToRasterTriangles(verts, indices, 'floor');
        expect(tris).toHaveLength(2);
        expect(tris[0]!.nodeName).toBe('floor');
        expect(Math.abs(tris[0]!.normal[1])).toBeCloseTo(1, 6);
        const built = buildColliderFromTriangles(tris, DEFAULT_GLB_COLLIDER_OPTIONS);
        expect(built.simplified).toBe(false);
        expect(built.triangleCount).toBe(2);
    });
});
