/**
 * Death shatter, pooled: limb pieces are baked once per character asset and
 * their bodies/meshes are reused between kills — a kill builds nothing.
 */
import * as THREE from 'three';
import { initRapier } from 'engine/physics/RapierPhysics.js';
import { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import {
    DEFAULT_BONE_VOXEL_SHATTER,
    boneVoxelLimbs,
    limbPiecePool,
    prewarmSkinnedVoxelShatter,
    shatterSkinnedVoxelCharacter,
} from 'engine/effects/BoneVoxelShatter.js';

const VOXEL = 0.1;

/**
 * A voxel body the extractor accepts: a solid column of cubes, the lower half
 * skinned to the hips bone (torso), the upper half to the head bone — two limbs.
 */
function makeVoxelCharacter(): THREE.SkinnedMesh {
    const H = 12;
    const pos: number[] = [], col: number[] = [], si: number[] = [], sw: number[] = [];
    for (let iy = 0; iy < H; iy++) {
        for (let ix = 0; ix < 2; ix++) {
            for (let iz = 0; iz < 2; iz++) {
                const g = new THREE.BoxGeometry(VOXEL, VOXEL, VOXEL).toNonIndexed();
                g.translate((ix + 0.5) * VOXEL, (iy + 0.5) * VOXEL, (iz + 0.5) * VOXEL);
                const p = g.getAttribute('position');
                const bone = iy >= H / 2 ? 1 : 0;
                for (let v = 0; v < p.count; v++) {
                    pos.push(p.getX(v), p.getY(v), p.getZ(v));
                    col.push(bone ? 0.9 : 0.4, 0.3, 0.3);
                    si.push(bone, 0, 0, 0);
                    sw.push(1, 0, 0, 0);
                }
            }
        }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geometry.setAttribute('skinIndex', new THREE.Float32BufferAttribute(si, 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    const hips = new THREE.Bone(); hips.name = 'mixamorigHips';
    const head = new THREE.Bone(); head.name = 'mixamorigHead';
    hips.add(head); head.position.y = H * VOXEL * 0.5;
    const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial({ vertexColors: true }));
    mesh.add(hips);
    mesh.bind(new THREE.Skeleton([hips, head]));
    mesh.updateMatrixWorld(true);
    mesh.skeleton.update();
    return mesh;
}

describe('pooled bone-voxel shatter', () => {
    let pw: PhysicsWorld;
    beforeAll(async () => { await initRapier(); });
    beforeEach(() => { pw = new PhysicsWorld(); });

    it('a kill spawns pooled limb pieces; after they retire, the next kill reuses them and builds nothing', () => {
        const scene = new THREE.Scene();
        const first = makeVoxelCharacter(); scene.add(first);
        prewarmSkinnedVoxelShatter(first);
        // Bursting pieces with a 1 s lifetime: they retire on their own, back into the pool.
        const options = { ...DEFAULT_BONE_VOXEL_SHATTER, limbs: true, limbBurst: true, limbImpactGraceSec: 0, splashCount: 0, maxDebris: 8, limbMaxLifetimeSec: 1 };
        const createdBefore = limbPiecePool.created;

        expect(shatterSkinnedVoxelCharacter(first, pw, scene, options)).toBe(true);
        const built = limbPiecePool.created - createdBefore;
        expect(built).toBe(2);                                   // torso + head, one piece each
        const bodiesFirst = scene.children.filter((c) => c.type === 'Group').length;
        expect(bodiesFirst).toBe(2);

        // Let the pieces live out their lifetime: they burst and retire to the pool, not to the GC.
        for (let i = 0; i < 70; i++) boneVoxelLimbs.update(1 / 60);
        expect(scene.children.filter((c) => c.type === 'Group')).toHaveLength(0);
        expect(limbPiecePool.freeCount).toBeGreaterThanOrEqual(2);

        // A clone of the same asset (shared geometry) dies: nothing new is created.
        const second = new THREE.SkinnedMesh(first.geometry, first.material as THREE.Material);
        const hips = first.skeleton.bones[0]!.clone(true) as THREE.Bone;
        second.add(hips);
        second.bind(new THREE.Skeleton([hips, hips.children[0] as THREE.Bone]));
        second.position.set(5, 0, 5);
        scene.add(second);
        second.updateMatrixWorld(true);
        second.skeleton.update();
        expect(shatterSkinnedVoxelCharacter(second, pw, scene, options)).toBe(true);
        expect(limbPiecePool.created - createdBefore).toBe(built);   // reused, not rebuilt
        const groups = scene.children.filter((c) => c.type === 'Group');
        expect(groups).toHaveLength(2);
        // …and they landed where the SECOND body stood, not the first.
        for (const g of groups) expect(g.position.distanceTo(new THREE.Vector3(5, 0, 5))).toBeLessThan(2);
    });
});
