/**
 * @jest-environment jsdom
 *
 * jsdom because VoxelWorld's meshing path builds the voxel texture atlas via
 * `document.createElement('canvas')` (same reason as VoxelWorldNullPhysics).
 *
 * ---------------------------------------------------------------------------
 * `terrain.shape='flat'` must honour the DECLARED world bounds exactly.
 *
 * `fillChunkFlat` writes whole 16×16 chunk footprints, and the old fast path
 * stamped every chunk the bounds merely OVERLAPPED — quantizing the terrain to
 * whole chunk spans. A side-on 2D strip declared 3 m deep rendered 16 m deep:
 * a phantom apron of ground reaching toward (and past) the side camera, which
 * is what made forged 2D levels read as deep dioramas instead of thin strips.
 * `stampFlatTerrain` splits the work: fully-inside chunks keep the O(chunks)
 * RLE stamp, edge chunks are stamped per-column — and the terrain ends where
 * the world says it does.
 */
import * as THREE from 'three';
import { VoxelWorld } from 'engine/VoxelWorld.js';
import { stampFlatTerrain } from 'genres/voxel/WorldGenerator.js';

const STONE = 1;
const DIRT = 2;

function makeWorld(sizeX: number, sizeZ: number): VoxelWorld {
    const world = new VoxelWorld(null, new THREE.Scene(), { voxelSize: 1, materialType: 'atlas' });
    // The engine's terrain bounds convention: X/Z centred on the origin, minY
    // the terrain floor (VoxelTerrainSystem.TERRAIN_DEFAULT_MIN_Y is -20).
    world.setBounds({ minX: -sizeX / 2, maxX: sizeX / 2, minY: -20, maxY: 100, minZ: -sizeZ / 2, maxZ: sizeZ / 2 });
    return world;
}

function stamp(world: VoxelWorld, sizeX: number, sizeZ: number): { chunks: number; edgeColumns: number } {
    return stampFlatTerrain(world, {
        halfX: sizeX / 2, halfZ: sizeZ / 2,
        baseHeight: 0, fillDepth: 3, blockSize: 1,
        surfaceBlock: STONE, subLayers: [DIRT],
    });
}

/** The block at world coords, via the world's own accessor. */
function blockAt(world: VoxelWorld, x: number, y: number, z: number): number {
    return world.getBlock(x, y, z);
}

describe("terrain.shape='flat' honours the declared bounds", () => {
    it('a 3 m-deep side-on strip is EXACTLY 3 m deep — no chunk-span apron', () => {
        const world = makeWorld(48, 3);
        stamp(world, 48, 3);

        // Surface block occupies [0, 1): probe its centre at y = 0.5.
        // In bounds: the three declared columns.
        expect(blockAt(world, 0.5, 0.5, -1)).toBe(STONE);
        expect(blockAt(world, 0.5, 0.5, 0)).toBe(STONE);
        expect(blockAt(world, 0.5, 0.5, 1)).toBe(STONE);
        // One block past the declared edge: air, NOT the old 16 m apron.
        expect(blockAt(world, 0.5, 0.5, 2)).toBe(0);
        expect(blockAt(world, 0.5, 0.5, -2.5)).toBe(0);
        expect(blockAt(world, 0.5, 0.5, 8)).toBe(0);
        // …and in X as well (48 is a multiple of 16, so the edge is exact there
        // by construction — assert it anyway).
        expect(blockAt(world, 23.5, 0.5, 0)).toBe(STONE);
        expect(blockAt(world, 24.5, 0.5, 0)).toBe(0);
    });

    it('keeps the sub-layer stack identical between chunk-stamped and edge columns', () => {
        // 33 m: two full chunks in X plus a 1-column edge — both paths run.
        const world = makeWorld(33, 33);
        const { chunks, edgeColumns } = stamp(world, 33, 33);
        expect(chunks).toBeGreaterThan(0);
        expect(edgeColumns).toBeGreaterThan(0);

        // An interior (chunk-stamped) column and an edge column must be
        // indistinguishable: STONE surface at [0,1), DIRT fill below to -3.
        for (const x of [0.5, 16.4]) {
            expect(blockAt(world, x, 0.5, 0.5)).toBe(STONE);
            expect(blockAt(world, x, -0.5, 0.5)).toBe(DIRT);
            expect(blockAt(world, x, -2.5, 0.5)).toBe(DIRT);
            expect(blockAt(world, x, -3.5, 0.5)).toBe(0); // below the fill: air
            expect(blockAt(world, x, 1.5, 0.5)).toBe(0);  // above the surface: air
        }
    });

    it('a chunk-aligned world still uses the fast chunk stamp for everything', () => {
        const world = makeWorld(32, 32);
        const { edgeColumns } = stamp(world, 32, 32);
        expect(edgeColumns).toBe(0);
    });

    it('an oversized fillDepth fills SOLID to the world floor — never below it', () => {
        // The side-on persist writes fillDepthBlocks: 64 so the side camera sees
        // earth all the way down instead of a floating 3-block band over sky.
        // The world floor here is -20; 64 blocks would reach -64 without the
        // clamp, writing chunks below the world's own bounds.
        const world = makeWorld(32, 3);
        stampFlatTerrain(world, {
            halfX: 16, halfZ: 1.5,
            baseHeight: 0, fillDepth: 64, blockSize: 1,
            surfaceBlock: STONE, subLayers: [DIRT],
        });

        expect(blockAt(world, 0.5, 0.5, 0)).toBe(STONE);   // surface
        expect(blockAt(world, 0.5, -10.5, 0)).toBe(DIRT);  // deep fill
        expect(blockAt(world, 0.5, -19.5, 0)).toBe(DIRT);  // bottom-most in-bounds block
        // Below the world floor: nothing was written.
        expect(blockAt(world, 0.5, -20.5, 0)).toBe(0);
    });
});
