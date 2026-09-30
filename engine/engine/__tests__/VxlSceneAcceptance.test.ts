/**
 * @jest-environment jsdom
 *
 * End-to-end acceptance tests for the vxlscene bake pipeline (design §10 / spec §11).
 *
 * These tests compose already-built, individually-tested modules and validate
 * their integration via bakeSceneFromTriangles + encodeVxlScene / decodeVxlScene.
 */

import { TextEncoder, TextDecoder } from 'util';
// jsdom lacks TextEncoder/TextDecoder; the v3+ trimesh name table uses them at
// encode/decode. Polyfill onto globalThis (mirrors VxlSceneFormat.test.ts).
if (typeof globalThis.TextEncoder === 'undefined') {
    (globalThis as unknown as { TextEncoder: typeof TextEncoder }).TextEncoder = TextEncoder;
}
if (typeof globalThis.TextDecoder === 'undefined') {
    (globalThis as unknown as { TextDecoder: typeof TextDecoder }).TextDecoder = TextDecoder;
}
import { bakeSceneFromTriangles, type BakeOptions } from 'engine/vxlscene/bakeScene.js';
import { encodeVxlScene, decodeVxlScene } from 'engine/vxlscene/VxlSceneFormat.js';
import { DEFAULT_OBJECT_CONTROLS } from 'engine/vxlscene/SceneVoxTypes.js';
import type { RasterTriangle } from 'engine/vxlscene/SurfaceRasterizer.js';
import type { SceneQuad } from 'engine/vxlscene/SceneVoxTypes.js';

// ─── Geometry helpers ─────────────────────────────────────────────────────────

function tri(
    v0: number[], v1: number[], v2: number[],
    node = 'f',
    normal?: number[],
): RasterTriangle {
    return {
        v0: v0 as [number, number, number],
        v1: v1 as [number, number, number],
        v2: v2 as [number, number, number],
        normal: (normal ?? [0, 1, 0]) as [number, number, number],
        nodeName: node,
        sampleColor: () => ({ r: 1, g: 1, b: 1 }),
    };
}

/** Flat floor at y=0.5 covering x in [0,W], z in [0,D]. */
function floor(W: number, D: number, node = 'f'): RasterTriangle[] {
    return [
        tri([0, 0.5, 0], [W, 0.5, 0], [W, 0.5, D], node),
        tri([0, 0.5, 0], [W, 0.5, D], [0, 0.5, D], node),
    ];
}

/**
 * Ramp surface as a quad: (0,0,0)-(8,0,0)-(8,4,8)-(0,4,8).
 * Y increases linearly with Z: y = z/2 along this ramp.
 * Normal is approximate: cross product of the two edge vectors gives ~(-0.5, 0, 0) × (0, 0, 8) ...
 * actually we compute it: edge1 = (8,0,0), edge2 = (0,4,8).
 * normal = edge1 × edge2 = (0*8 - 0*4, 0*0 - 8*8, 8*4 - 0*0) = (0, -64, 32) → normalized (0, -2, 1)/√5.
 * We use the upward-facing normal for the +Z-forward ramp:
 * the outward normal of the ramp (facing up-ish) is (0, 8, -4) normalized = (0, 2, -1)/√5.
 * For a ramp rising in Y as Z increases, the surface normal points "up and backward in Z".
 * We approximate [0, 0.894, -0.447] (normalized [0, 2, -1]).
 */
function rampTriangles(node = 'road'): RasterTriangle[] {
    const norm: [number, number, number] = [0, 0.894, -0.447];
    return [
        // Lower triangle: (0,0,0), (8,0,0), (8,4,8)
        {
            v0: [0, 0, 0], v1: [8, 0, 0], v2: [8, 4, 8],
            normal: norm, nodeName: node,
            sampleColor: () => ({ r: 0.6, g: 0.4, b: 0.2 }),
        },
        // Upper triangle: (0,0,0), (8,4,8), (0,4,8)
        {
            v0: [0, 0, 0], v1: [8, 4, 8], v2: [0, 4, 8],
            normal: norm, nodeName: node,
            sampleColor: () => ({ r: 0.6, g: 0.4, b: 0.2 }),
        },
    ];
}

/** Sum the +Y (axis===1, dir===1) quad areas across a quad array. */
function plusYArea(quads: SceneQuad[]): number {
    return quads
        .filter(q => q.axis === 1 && q.dir === 1)
        .reduce((s, q) => s + q.w * q.h, 0);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('VxlScene acceptance: smooth-road composition (design §6.3 + §6.4)', () => {
    /**
     * A ramp surface with displacementAxis:'y' and trimeshCollider:true.
     * Per design §6.4: trimesh objects produce voxels with noCollider=true.
     * Per design §6.3: displaced cells get a non-null disp vector.
     * Per design §6.4: the original triangles are baked as a trimesh collider.
     */
    it('road voxels have noCollider, at least one disp!=null, trimesh has indices', async () => {
        const opts: BakeOptions = {
            chunkSize: 8,
            minVoxelSize: 1,
            maxVoxelSize: 8,
            additionalLods: 0,
            lodDistances: [50],
            fillInterior: false,
            controlsByNode: {
                road: {
                    ...DEFAULT_OBJECT_CONTROLS,
                    displacementAxis: 'y',
                    trimeshCollider: true,
                },
            },
        };

        const world = await bakeSceneFromTriangles(rampTriangles(), opts);

        // Ramp spans x[0,8], z[0,8], y[0,4]; with chunkSize=8 → single chunk.
        expect(world.chunks.length).toBeGreaterThanOrEqual(1);

        // Collect all voxels across all chunks.
        const allVoxels = world.chunks.flatMap(c => c.voxels);
        expect(allVoxels.length).toBeGreaterThan(0);

        // 1a. Every voxel must have noCollider=true (road is trimesh, voxel-box colliders disabled).
        for (const voxel of allVoxels) {
            expect(voxel.noCollider).toBe(true);
        }

        // 1b. At least one voxel carries a non-null disp vector (displacement was computed).
        const hasDisp = allVoxels.some(v => v.disp !== null);
        expect(hasDisp).toBe(true);

        // 1c. Every non-empty chunk has a 'road'-named trimesh with at least 3 indices.
        for (const chunk of world.chunks) {
            const road = chunk.namedTrimeshes.find(tm => tm.name === 'road');
            expect(road).toBeDefined();
            expect(road!.indices.length).toBeGreaterThanOrEqual(3);
        }
    });
});

describe('VxlScene acceptance: end-to-end determinism (spec §11)', () => {
    /**
     * Baking the same scene twice and encoding both must yield byte-identical output.
     * Uses a non-trivial scene (floor + a pillar-like object) to exercise palette
     * deduplication and chunk ordering paths.
     */
    it('two bake+encode runs produce identical bytes', async () => {
        const scene: RasterTriangle[] = [
            ...floor(8, 8, 'ground'),
            // A small raised platform at y=3.5, x[2,4], z[2,4] — different node.
            tri([2, 3.5, 2], [4, 3.5, 2], [4, 3.5, 4], 'platform', [0, 1, 0]),
            tri([2, 3.5, 2], [4, 3.5, 4], [2, 3.5, 4], 'platform', [0, 1, 0]),
        ];

        const opts: BakeOptions = {
            chunkSize: 4,
            minVoxelSize: 1,
            maxVoxelSize: 4,
            additionalLods: 0,
            lodDistances: [50],
            fillInterior: false,
            controlsByNode: {
                platform: { ...DEFAULT_OBJECT_CONTROLS },
            },
        };

        const world1 = await bakeSceneFromTriangles(scene, opts);
        const world2 = await bakeSceneFromTriangles(scene, opts);

        const bytes1 = await encodeVxlScene(world1, { compression: 'none' });
        const bytes2 = await encodeVxlScene(world2, { compression: 'none' });

        expect(Buffer.from(bytes1).equals(Buffer.from(bytes2))).toBe(true);
    });
});

describe('VxlScene acceptance: no cross-chunk double-surfacing (spec §5.4 / §8.2)', () => {
    /**
     * A flat floor at y=0.5 spanning x,z in [0,8] with chunkSize=4 → 4 chunks (2×2 in XZ).
     * The total +Y quad area across all chunks' LOD0 hints must equal exactly 8×8=64:
     * no duplicated faces at the 3 internal chunk borders.
     */
    it('4-chunk floor has exactly 64 units of +Y top area (no border duplication)', async () => {
        const opts: BakeOptions = {
            chunkSize: 4,
            minVoxelSize: 1,
            maxVoxelSize: 4,
            additionalLods: 0,
            lodDistances: [50],
            fillInterior: false,
            controlsByNode: {},
        };

        const world = await bakeSceneFromTriangles(floor(8, 8), opts);

        // 2×2 XZ grid → 4 chunks (Y is one chunk since floor is flat).
        expect(world.chunks.length).toBe(4);

        // Sum +Y quad areas across all chunks' LOD0.
        const totalTop = world.chunks.reduce(
            (sum, chunk) => sum + plusYArea(chunk.lodHints[0]!),
            0,
        );
        expect(totalTop).toBe(64);
    });
});

describe('VxlScene acceptance: round-trip integrity (design §4)', () => {
    /**
     * Bake a small scene → encode → decode → verify chunk count and total LOD0
     * quad count are preserved. The format must not drop or duplicate geometry.
     */
    it('encode+decode preserves chunk count and total LOD0 quad count', async () => {
        const scene: RasterTriangle[] = [
            ...floor(8, 4, 'ground'),
            // A second surface offset in Z to ensure two chunks.
            tri([0, 1.5, 4], [8, 1.5, 4], [8, 1.5, 8], 'shelf', [0, 1, 0]),
            tri([0, 1.5, 4], [8, 1.5, 8], [0, 1.5, 8], 'shelf', [0, 1, 0]),
        ];

        const opts: BakeOptions = {
            chunkSize: 4,
            minVoxelSize: 1,
            maxVoxelSize: 4,
            additionalLods: 1,
            lodDistances: [50, 120],
            fillInterior: false,
            controlsByNode: {
                shelf: { ...DEFAULT_OBJECT_CONTROLS },
            },
        };

        const originalWorld = await bakeSceneFromTriangles(scene, opts);
        expect(originalWorld.chunks.length).toBeGreaterThan(0);

        const bytes = await encodeVxlScene(originalWorld, { compression: 'none' });
        const restoredWorld = await decodeVxlScene(bytes);

        // Chunk count must match exactly.
        expect(restoredWorld.chunks.length).toBe(originalWorld.chunks.length);

        // Total LOD0 quad count must match exactly.
        const originalQuadCount = originalWorld.chunks.reduce(
            (sum, c) => sum + (c.lodHints[0]?.length ?? 0),
            0,
        );
        const restoredQuadCount = restoredWorld.chunks.reduce(
            (sum, c) => sum + (c.lodHints[0]?.count ?? 0),
            0,
        );
        expect(restoredQuadCount).toBe(originalQuadCount);

        // LOD level count per chunk must also survive the round-trip.
        for (let i = 0; i < originalWorld.chunks.length; i++) {
            expect(restoredWorld.chunks[i]!.lodHints.length).toBe(
                originalWorld.chunks[i]!.lodHints.length,
            );
        }
    });
});
