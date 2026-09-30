/**
 * Named trimesh-collider query (v3): bake groups collider triangles by source
 * object name, the format round-trips the name table + per-blob name index, and
 * the runtime merges each named object across chunks into one world-space mesh.
 *
 * Node environment (default): TextEncoder/TextDecoder are Node globals here, so no
 * jsdom polyfill is needed.
 */
import {
    encodeVxlScene, decodeVxlScene,
    type VxlSceneWorld, type DecodedVxlSceneWorld, type DecodedChunk,
} from 'engine/vxlscene/VxlSceneFormat.js';
import { bakeSceneFromTriangles } from 'engine/vxlscene/bakeScene.js';
import type { RasterTriangle } from 'engine/vxlscene/SurfaceRasterizer.js';
import {
    collectTrimeshNames, mergeNamedTrimesh,
    DEFAULT_VXL_SCENE_TERRAIN_CONFIG, VxlSceneTerrainSystem,
} from 'engine/VxlSceneTerrainSystem.js';
import { initRapier } from 'engine/physics/RapierPhysics.js';
import { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import type { EngineLike } from 'types/game.js';
import * as THREE from 'three';

beforeAll(async () => {
    await initRapier();
});

/** Minimal empty voxel columns for a hand-built decoded chunk. */
function emptyVoxels(): DecodedChunk['voxels'] {
    return {
        count: 0,
        gx: new Uint16Array(0), gy: new Uint16Array(0), gz: new Uint16Array(0),
        sizeLevel: new Uint8Array(0), colorIdx: new Uint16Array(0), flags: new Uint8Array(0),
        disp: null,
    };
}

function decodedChunk(cx: number, cy: number, cz: number, named: DecodedChunk['namedTrimeshes']): DecodedChunk {
    return { cx, cy, cz, voxels: emptyVoxels(), lodHints: [], namedTrimeshes: named };
}

/** A unit right-triangle in the XZ plane at a given chunk-local corner. */
function tri(): { verts: Float32Array; indices: Uint32Array } {
    return { verts: new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 1]), indices: new Uint32Array([0, 1, 2]) };
}

describe('collectTrimeshNames', () => {
    it('returns distinct non-empty names across chunks', () => {
        const world: DecodedVxlSceneWorld = {
            chunkSize: 16, minVoxelSize: 1,
            bounds: { minX: 0, minY: 0, minZ: 0, maxX: 32, maxY: 16, maxZ: 16 },
            lodDistances: [50],
            chunks: [
                decodedChunk(0, 0, 0, [{ name: 'track', ...tri() }, { name: 'ramp', ...tri() }]),
                decodedChunk(1, 0, 0, [{ name: 'track', ...tri() }]),
            ],
        };
        expect(collectTrimeshNames(world).sort()).toEqual(['ramp', 'track']);
    });

    it('ignores the empty name (v2 unnamed trimesh)', () => {
        const world: DecodedVxlSceneWorld = {
            chunkSize: 16, minVoxelSize: 1,
            bounds: { minX: 0, minY: 0, minZ: 0, maxX: 16, maxY: 16, maxZ: 16 },
            lodDistances: [50],
            chunks: [decodedChunk(0, 0, 0, [{ name: '', ...tri() }])],
        };
        expect(collectTrimeshNames(world)).toEqual([]);
    });
});

describe('mergeNamedTrimesh', () => {
    const world: DecodedVxlSceneWorld = {
        chunkSize: 16, minVoxelSize: 1,
        bounds: { minX: 0, minY: 0, minZ: 0, maxX: 32, maxY: 16, maxZ: 16 },
        lodDistances: [50],
        chunks: [
            decodedChunk(0, 0, 0, [{ name: 'track', ...tri() }, { name: 'ramp', ...tri() }]),
            decodedChunk(1, 0, 0, [{ name: 'track', ...tri() }]),
        ],
    };

    it('merges an object spanning two chunks into one world-space mesh with rebased indices', () => {
        const merged = mergeNamedTrimesh(world, 'track');
        expect(merged).not.toBeNull();
        // Two triangles → 6 verts (18 floats), 6 indices.
        expect(merged!.vertices.length).toBe(18);
        expect(merged!.indices.length).toBe(6);
        // Chunk (0,0,0): chunk-local verts unchanged (origin 0). First vert (0,0,0).
        expect(Array.from(merged!.vertices.slice(0, 3))).toEqual([0, 0, 0]);
        // Chunk (1,0,0): origin x = 1*16 = 16 added. Its first vert (0,0,0) → (16,0,0).
        expect(Array.from(merged!.vertices.slice(9, 12))).toEqual([16, 0, 0]);
        // Second chunk's indices are rebased by the running vertex count (3).
        expect(Array.from(merged!.indices)).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it('returns a single-chunk object untranslated when its chunk is at the origin', () => {
        const merged = mergeNamedTrimesh(world, 'ramp');
        expect(merged!.vertices.length).toBe(9);
        expect(Array.from(merged!.indices)).toEqual([0, 1, 2]);
    });

    it('returns null for an unknown name', () => {
        expect(mergeNamedTrimesh(world, 'nope')).toBeNull();
    });
});

describe('v3 format round-trip with named trimeshes', () => {
    it('preserves the name table and per-object geometry', async () => {
        const world: VxlSceneWorld = {
            chunkSize: 16, minVoxelSize: 1,
            bounds: { minX: 0, minY: 0, minZ: 0, maxX: 32, maxY: 16, maxZ: 16 },
            lodDistances: [50],
            chunks: [
                { cx: 0, cy: 0, cz: 0, voxels: [], lodHints: [], namedTrimeshes: [{ name: 'track', ...tri() }, { name: 'ramp', ...tri() }] },
                { cx: 1, cy: 0, cz: 0, voxels: [], lodHints: [], namedTrimeshes: [{ name: 'track', ...tri() }] },
            ],
        };
        const bytes = await encodeVxlScene(world, { compression: 'none' });
        expect(bytes[4]).toBe(7); // format version byte (v7 = v6 + optional emissive-palette section)
        const decoded = await decodeVxlScene(bytes);

        expect(collectTrimeshNames(decoded).sort()).toEqual(['ramp', 'track']);
        const c0 = decoded.chunks[0]!;
        expect(c0.namedTrimeshes.map(t => t.name)).toEqual(['track', 'ramp']);
        // v4 quantizes verts to the collider lattice → compare within one step.
        const expectedVerts = [0, 0, 0, 1, 0, 0, 1, 0, 1];
        const gotVerts = Array.from(c0.namedTrimeshes[0]!.verts);
        gotVerts.forEach((v, i) => expect(v).toBeCloseTo(expectedVerts[i]!, 3));
        expect(Array.from(c0.namedTrimeshes[0]!.indices)).toEqual([0, 1, 2]);
        // 'track' spans both chunks.
        const track = mergeNamedTrimesh(decoded, 'track');
        expect(track!.indices.length).toBe(6);
    });

    it('decodes collision-only DungeonCollision once per occupied chunk with no render voxels or quads', async () => {
        const collisionTri = (x: number): RasterTriangle => ({
            v0: [x, 1, 1],
            v1: [x + 2, 1, 1],
            v2: [x + 2, 1, 3],
            normal: [0, 1, 0],
            nodeName: 'DungeonCollision',
            sampleColor: () => ({ r: 0.4, g: 0.4, b: 0.4 }),
        });
        const world = await bakeSceneFromTriangles([collisionTri(1), collisionTri(17)], {
            chunkSize: 16,
            minVoxelSize: 0.125,
            maxVoxelSize: 1,
            additionalLods: 0,
            lodDistances: [50],
            fillInterior: false,
            bounds: { minX: 0, minY: 0, minZ: 0, maxX: 32, maxY: 16, maxZ: 16 },
            controlsByNode: {
                DungeonCollision: {
                    lodOffset: 0,
                    pinned: false,
                    trimeshCollider: false,
                    noCollider: false,
                    collisionOnly: true,
                    displacementAxis: null,
                },
            },
        });

        const decoded = await decodeVxlScene(await encodeVxlScene(world, { compression: 'none' }));
        expect(collectTrimeshNames(decoded)).toEqual(['DungeonCollision']);
        expect(decoded.chunks.reduce((sum, chunk) => sum + chunk.voxels.count, 0)).toBe(0);
        expect(decoded.chunks.reduce((sum, chunk) => sum + (chunk.lodHints[0]?.length ?? 0), 0)).toBe(0);
        for (const chunk of decoded.chunks) {
            expect(chunk.namedTrimeshes.filter(mesh => mesh.name === 'DungeonCollision').length).toBeLessThanOrEqual(1);
        }
        expect(mergeNamedTrimesh(decoded, 'DungeonCollision')!.indices.length).toBe(6);
    });

    it('loads the decoded level through VxlSceneTerrainSystem and registers queryable Rapier colliders', async () => {
        const floor = (x: number): RasterTriangle[] => [
            {
                v0: [x, 1, 1], v1: [x + 2, 1, 1], v2: [x + 2, 1, 3],
                normal: [0, 1, 0], nodeName: 'DungeonCollision',
                sampleColor: () => ({ r: 0.4, g: 0.4, b: 0.4 }),
            },
            {
                v0: [x, 1, 1], v1: [x + 2, 1, 3], v2: [x, 1, 3],
                normal: [0, 1, 0], nodeName: 'DungeonCollision',
                sampleColor: () => ({ r: 0.4, g: 0.4, b: 0.4 }),
            },
        ];
        const baked = await bakeSceneFromTriangles([...floor(1), ...floor(17)], {
            chunkSize: 16, minVoxelSize: 0.125, maxVoxelSize: 1,
            additionalLods: 0, lodDistances: [50], fillInterior: false,
            bounds: { minX: 0, minY: 0, minZ: 0, maxX: 32, maxY: 16, maxZ: 16 },
            controlsByNode: {
                DungeonCollision: {
                    lodOffset: 0, pinned: false, trimeshCollider: false,
                    noCollider: false, collisionOnly: true, displacementAxis: null,
                },
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
            expect(terrain.areCollidersReady()).toBe(true);
            expect(terrain.getColliderCounts()).toEqual({ named: 2, quad: 0, total: 2 });
            physicsWorld.step(1 / 60);
            const hit = physicsWorld.raycast(
                new THREE.Vector3(2, 5, 2),
                new THREE.Vector3(0, -1, 0),
                10,
            );
            expect(hit.hasHit).toBe(true);
            expect(hit.hitPoint.y).toBeCloseTo(1, 3);
        } finally {
            terrain.dispose();
            physicsWorld.dispose();
        }
    });
});
