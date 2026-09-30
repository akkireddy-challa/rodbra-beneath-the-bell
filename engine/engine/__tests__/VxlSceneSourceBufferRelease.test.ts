/**
 * Node environment (default), like `VxlSceneNamedTrimesh.test.ts`: the format decoder
 * needs TextEncoder/TextDecoder, which are Node globals but absent from this repo's jsdom
 * setup. Nothing here renders, so no DOM is required.
 */
import * as THREE from 'three';
import { bakeSceneFromTriangles } from 'engine/vxlscene/bakeScene.js';
import { encodeVxlScene } from 'engine/vxlscene/VxlSceneFormat.js';
import { VxlSceneTerrainSystem, DEFAULT_VXL_SCENE_TERRAIN_CONFIG } from 'engine/VxlSceneTerrainSystem.js';
import type { RasterTriangle } from 'engine/vxlscene/SurfaceRasterizer.js';
import type { EngineLike } from 'types/game.js';

/**
 * `releaseSourceBuffer` frees the inflated `.vwld` container the moment it is decoded.
 *
 * It matters because of WHEN, not how much: the container is 52-87 MB on a real level,
 * and both `loadVxlScene`'s parameter and every caller's local hold it live across the
 * whole load — including `build()`, where the render batches are allocated. Dropping a
 * reference cannot help while those bindings are alive, so the buffer is detached
 * instead, which frees it for every holder at once.
 */

const GREY: RasterTriangle['sampleColor'] = () => ({ r: 0.5, g: 0.5, b: 0.5 });

/** A flat floor at y=1 spanning the chunk, as two triangles. */
function floor(): RasterTriangle[] {
    const n: [number, number, number] = [0, 1, 0];
    return [
        { v0: [0, 1, 0], v1: [16, 1, 0], v2: [16, 1, 16], normal: n, nodeName: 'f', sampleColor: GREY },
        { v0: [0, 1, 0], v1: [16, 1, 16], v2: [0, 1, 16], normal: n, nodeName: 'f', sampleColor: GREY },
    ];
}

async function bakedBuffer(): Promise<ArrayBuffer> {
    const baked = await bakeSceneFromTriangles(floor(), {
        chunkSize: 16, minVoxelSize: 0.5, maxVoxelSize: 4,
        additionalLods: 0, lodDistances: [50], fillInterior: false,
        bounds: { minX: 0, minY: 0, minZ: 0, maxX: 16, maxY: 16, maxZ: 16 },
        controlsByNode: {},
    });
    const bytes = await encodeVxlScene(baked, { compression: 'none' });
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function makeTerrain(): VxlSceneTerrainSystem {
    return new VxlSceneTerrainSystem(
        { scene: new THREE.Scene() } as unknown as EngineLike,
        DEFAULT_VXL_SCENE_TERRAIN_CONFIG,
    );
}

describe('loadVxlScene releaseSourceBuffer', () => {
    it('detaches the container once decoded, so every holder loses it at once', async () => {
        const buffer = await bakedBuffer();
        const before = buffer.byteLength;
        expect(before).toBeGreaterThan(0);

        const terrain = makeTerrain();
        try {
            await terrain.loadVxlScene(buffer, { buildRenderer: false, releaseSourceBuffer: true });
            // The caller's own reference — the one that would otherwise pin the container
            // through the whole load — now sees a detached buffer.
            expect(buffer.byteLength).toBe(0);
            // And the world still decoded correctly from it before the release.
            expect(terrain.getChunkCount()).toBeGreaterThan(0);
            expect(terrain.getBounds()).not.toBeNull();
        } finally {
            terrain.dispose();
        }
    });

    it('leaves the caller its buffer by default — this is a published API', async () => {
        const buffer = await bakedBuffer();
        const before = buffer.byteLength;

        const terrain = makeTerrain();
        try {
            await terrain.loadVxlScene(buffer, { buildRenderer: false });
            expect(buffer.byteLength).toBe(before);
            expect(terrain.getChunkCount()).toBeGreaterThan(0);
        } finally {
            terrain.dispose();
        }
    });

    it('loads identically whether or not the buffer is released', async () => {
        const kept = makeTerrain();
        const released = makeTerrain();
        try {
            await kept.loadVxlScene(await bakedBuffer(), { buildRenderer: false });
            await released.loadVxlScene(await bakedBuffer(), { buildRenderer: false, releaseSourceBuffer: true });
            expect(released.getChunkCount()).toBe(kept.getChunkCount());
            expect(released.getBounds()).toEqual(kept.getBounds());
            expect(released.getChunkSize()).toBe(kept.getChunkSize());
        } finally {
            kept.dispose();
            released.dispose();
        }
    });
});
