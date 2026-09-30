/**
 * A baked .vwld level's chunk crust colliders are voxels shapes seam-coupled at
 * load: a body sliding from one chunk into the next must not catch on the seam.
 * Bakes a flat floor spanning two chunks, loads it through VxlSceneTerrainSystem
 * with a real PhysicsWorld, and slides a frictionless cuboid across the seam.
 */
import { encodeVxlScene } from 'engine/vxlscene/VxlSceneFormat.js';
import { bakeSceneFromTriangles } from 'engine/vxlscene/bakeScene.js';
import type { RasterTriangle } from 'engine/vxlscene/SurfaceRasterizer.js';
import { DEFAULT_VXL_SCENE_TERRAIN_CONFIG, VxlSceneTerrainSystem } from 'engine/VxlSceneTerrainSystem.js';
import { initRapier } from 'engine/physics/RapierPhysics.js';
import { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import { installVoxelColliderMode } from 'engine/physics/VoxelColliders.js';
import type { EngineLike } from 'types/game.js';
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

beforeAll(async () => { await initRapier(); });
afterEach(() => installVoxelColliderMode(null));

/** A flat floor at y = 1 spanning x 0..32 (two 16 m chunks), z 0..8. */
function floorTriangles(): RasterTriangle[] {
    const tri = (v0: [number, number, number], v1: [number, number, number], v2: [number, number, number]): RasterTriangle => ({
        v0, v1, v2, normal: [0, 1, 0], nodeName: 'Floor', sampleColor: () => ({ r: 0.4, g: 0.5, b: 0.3 }),
    });
    return [tri([0, 1, 0], [32, 1, 0], [32, 1, 8]), tri([0, 1, 0], [32, 1, 8], [0, 1, 8])];
}

describe('VxlScene chunk seams', () => {
    it('a cuboid slides from one chunk crust into the next without catching', async () => {
        installVoxelColliderMode('voxels');
        const baked = await bakeSceneFromTriangles(floorTriangles(), {
            chunkSize: 16, minVoxelSize: 0.125, maxVoxelSize: 1,
            additionalLods: 0, lodDistances: [50], fillInterior: false,
            bounds: { minX: 0, minY: 0, minZ: 0, maxX: 32, maxY: 8, maxZ: 8 },
            controlsByNode: {
                Floor: { lodOffset: 0, pinned: false, trimeshCollider: false, noCollider: false, collisionOnly: false, displacementAxis: null },
            },
        });
        const bytes = await encodeVxlScene(baked, { compression: 'none' });
        const physicsWorld = new PhysicsWorld();
        const terrain = new VxlSceneTerrainSystem(
            { scene: new THREE.Scene(), physicsWorld } as unknown as EngineLike,
            DEFAULT_VXL_SCENE_TERRAIN_CONFIG,
        );
        try {
            await terrain.loadVxlScene(
                bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
                { buildRenderer: false },
            );
            expect(terrain.getColliderCounts()).toEqual({ named: 0, quad: 2, total: 2 });
            physicsWorld.step(1 / 60);

            // Find the floor top under the start point, then slide along +x across x = 16.
            const hit = physicsWorld.raycast(new THREE.Vector3(8, 5, 4), new THREE.Vector3(0, -1, 0), 10);
            expect(hit.hasHit).toBe(true);
            const top = hit.hitPoint.y;
            const body = physicsWorld.createRigidBody(
                RAPIER.RigidBodyDesc.dynamic().setTranslation(8, top + 0.2 + 0.002, 4).setLinvel(6, 0, 0),
            );
            physicsWorld.createCollider(
                RAPIER.ColliderDesc.cuboid(0.2, 0.2, 0.2).setFriction(0).setRestitution(0).setDensity(100)
                    .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min),
                body,
            );
            body.lockRotations(true, true);
            for (let i = 0; i < 120; i++) physicsWorld.step(1 / 60);
            const x = body.translation().x;
            expect(x).toBeGreaterThan(18); // 2 s at 6 m/s from x = 8; an uncoupled seam stops it at ~16
            expect(body.translation().y).toBeGreaterThan(top); // still on the floor
        } finally {
            terrain.dispose();
            physicsWorld.dispose();
        }
    });
});
