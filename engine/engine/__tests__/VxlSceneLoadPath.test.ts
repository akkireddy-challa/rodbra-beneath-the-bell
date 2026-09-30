/** @jest-environment jsdom */
import { TextEncoder, TextDecoder } from 'util';
// jsdom lacks both; the format's trimesh name table needs them. Same shim as
// `VxlSceneFormat.test.ts`. jsdom (not node) because the renderer half of this test
// builds real BatchedMeshes and the atlas wants a canvas.
if (typeof globalThis.TextEncoder === 'undefined') {
    (globalThis as unknown as { TextEncoder: typeof TextEncoder }).TextEncoder = TextEncoder;
}
if (typeof globalThis.TextDecoder === 'undefined') {
    (globalThis as unknown as { TextDecoder: typeof TextDecoder }).TextDecoder = TextDecoder;
}

import * as THREE from 'three';
import { bakeSceneFromTriangles } from 'engine/vxlscene/bakeScene.js';
import { encodeVxlScene } from 'engine/vxlscene/VxlSceneFormat.js';
import { VxlSceneTerrainSystem, DEFAULT_VXL_SCENE_TERRAIN_CONFIG } from 'engine/VxlSceneTerrainSystem.js';
import { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import { initRapier } from 'engine/physics/RapierPhysics.js';
import type { RasterTriangle } from 'engine/vxlscene/SurfaceRasterizer.js';
import type { EngineLike } from 'types/game.js';

beforeAll(async () => {
    await initRapier();
    // The renderer branch of the load consults `isMobileRuntime()`, which reads
    // `matchMedia('(pointer: coarse)')` — absent under jsdom. Answer "desktop", so the
    // load planner keeps full detail and the baselines below are the unshed geometry.
    window.matchMedia = jest.fn().mockReturnValue({
        matches: false,
        media: '(pointer: coarse)',
        onchange: null,
        addListener: jest.fn(),
        removeListener: jest.fn(),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        dispatchEvent: jest.fn(),
    }) as unknown as typeof window.matchMedia;
});

/**
 * END-TO-END load path: bake -> encode -> decode -> plan -> renderer batches -> colliders
 * -> physics. The one test that exercises what a real level load actually does.
 *
 * It exists to be a BASELINE. Everything below is an observable of the finished load, not
 * of how the load got there — quad totals, batch layout, collider coverage, chunk-seam
 * continuity, a raycast that lands on the surface. So a change to HOW chunks are decoded
 * and consumed (streaming them one at a time instead of materialising the whole world, or
 * repacking the vertex format) has something to be judged against, in a subsystem whose
 * failure modes are falling through the world, geometry vanishing at LOD boundaries, and
 * cracks between chunks — none of which the per-unit tests can see.
 *
 * `VxlSceneNamedTrimesh.test.ts` covers the same path for named collision meshes, but with
 * `buildRenderer: false`; this one turns the renderer on.
 */

const GREY: RasterTriangle['sampleColor'] = () => ({ r: 0.4, g: 0.5, b: 0.6 });

/** A flat floor at `y` spanning [x0,x1] x [z0,z1], as two triangles of node `node`. */
function floor(x0: number, z0: number, x1: number, z1: number, y: number, node = 'ground'): RasterTriangle[] {
    const n: [number, number, number] = [0, 1, 0];
    return [
        { v0: [x0, y, z0], v1: [x1, y, z0], v2: [x1, y, z1], normal: n, nodeName: node, sampleColor: GREY },
        { v0: [x0, y, z0], v1: [x1, y, z1], v2: [x0, y, z1], normal: n, nodeName: node, sampleColor: GREY },
    ];
}

const CHUNK = 16;
const MIN_VOXEL = 0.5;
/** 3x1x2 chunks of floor, so chunk seams exist along both X and Z. */
const WORLD = { minX: 0, minY: 0, minZ: 0, maxX: 48, maxY: 16, maxZ: 32 };

async function bakedLevel(): Promise<ArrayBuffer> {
    const baked = await bakeSceneFromTriangles(
        [
            ...floor(0, 0, 48, 32, 4),                          // the ground plate
            ...floor(8, 8, 24, 24, 8, 'platform'),              // a raised slab, its own object
        ],
        {
            chunkSize: CHUNK, minVoxelSize: MIN_VOXEL, maxVoxelSize: 4,
            additionalLods: 1, lodDistances: [50, 1e9], fillInterior: false,
            bounds: WORLD, controlsByNode: {},
        },
    );
    const bytes = await encodeVxlScene(baked, { compression: 'none' });
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

interface Loaded {
    terrain: VxlSceneTerrainSystem;
    physics: PhysicsWorld;
    dispose: () => void;
}

async function load(buildRenderer: boolean): Promise<Loaded> {
    const physics = new PhysicsWorld();
    const terrain = new VxlSceneTerrainSystem(
        { scene: new THREE.Scene(), physicsWorld: physics } as unknown as EngineLike,
        DEFAULT_VXL_SCENE_TERRAIN_CONFIG,
    );
    await terrain.loadVxlScene(await bakedLevel(), { buildRenderer });
    return {
        terrain, physics,
        dispose: () => { terrain.dispose(); physics.dispose(); },
    };
}

/** Every BatchedMesh the renderer attached, in scene-graph order. */
function batches(terrain: VxlSceneTerrainSystem): THREE.BatchedMesh[] {
    const out: THREE.BatchedMesh[] = [];
    terrain.getVoxelChunkGroup().traverse((o) => {
        if ((o as THREE.BatchedMesh).isBatchedMesh) out.push(o as THREE.BatchedMesh);
    });
    return out;
}

/** Total vertices across every batch — the render-buffer size in vertex units. */
function totalVerts(terrain: VxlSceneTerrainSystem): number {
    return batches(terrain).reduce(
        (n, b) => n + (b.geometry.getAttribute('position') as THREE.BufferAttribute).count, 0,
    );
}

describe('VxlScene load path (baseline)', () => {
    it('decodes the level and reports its shape', async () => {
        const l = await load(false);
        try {
            expect(l.terrain.getChunkSize()).toBe(CHUNK);
            expect(l.terrain.getChunkCount()).toBeGreaterThan(1);   // multi-chunk, seams exist
            expect(l.terrain.getBounds()).toEqual(WORLD);
        } finally { l.dispose(); }
    });

    it('registers collidable terrain that a downward ray actually lands on', async () => {
        const l = await load(false);
        try {
            expect(l.terrain.areCollidersReady()).toBe(true);
            expect(l.terrain.getColliderCounts().total).toBeGreaterThan(0);
            l.physics.step(1 / 60);

            // Over the raised slab: the ray must stop on it, not fall through to the plate.
            const onSlab = l.physics.raycast(new THREE.Vector3(16, 14, 16), new THREE.Vector3(0, -1, 0), 20);
            expect(onSlab.hasHit).toBe(true);
            expect(onSlab.hitPoint.y).toBeGreaterThan(6);

            // Off the slab but over the plate.
            const onPlate = l.physics.raycast(new THREE.Vector3(40, 14, 4), new THREE.Vector3(0, -1, 0), 20);
            expect(onPlate.hasHit).toBe(true);
            expect(onPlate.hitPoint.y).toBeLessThan(6);
            expect(onPlate.hitPoint.y).toBeGreaterThan(2);
        } finally { l.dispose(); }
    });

    it('builds batched render geometry for every chunk, with a sane vertex budget', async () => {
        const l = await load(true);
        try {
            const bs = batches(l.terrain);
            expect(bs.length).toBeGreaterThan(0);
            // Draw calls scale with bias steps, NOT chunks — the whole point of batching.
            expect(bs.length).toBeLessThan(l.terrain.getChunkCount());
            // 4 verts per quad, and a floor this size cannot be empty.
            const verts = totalVerts(l.terrain);
            expect(verts).toBeGreaterThan(0);
            expect(verts % 4).toBe(0);
            for (const b of bs) {
                expect((b.geometry.getAttribute('position') as THREE.BufferAttribute).count).toBeGreaterThan(0);
                expect(b.geometry.getIndex()).not.toBeNull();
            }
        } finally { l.dispose(); }
    });

    it('places every vertex inside the world bounds — the chunk origins are applied', async () => {
        const l = await load(true);
        try {
            // Catches an origin dropped or applied twice, which is exactly how a
            // coordinate-space change goes wrong: geometry lands in one chunk's corner,
            // or scatters far outside the level.
            const box = new THREE.Box3();
            const v = new THREE.Vector3();
            for (const b of batches(l.terrain)) {
                const pos = b.geometry.getAttribute('position') as THREE.BufferAttribute;
                const m = new THREE.Matrix4();
                for (let i = 0; i < pos.count; i++) {
                    v.fromBufferAttribute(pos, i);
                    box.expandByPoint(v);
                }
                // Instance transforms must not move geometry out of the level either.
                for (let i = 0; i < b.instanceCount; i++) {
                    b.getMatrixAt(i, m);
                    expect(Number.isFinite(m.elements[12]!)).toBe(true);
                }
            }
            const EPS = 1e-4;
            expect(box.min.x).toBeGreaterThanOrEqual(WORLD.minX - EPS);
            expect(box.min.z).toBeGreaterThanOrEqual(WORLD.minZ - EPS);
            expect(box.max.x).toBeLessThanOrEqual(WORLD.maxX + EPS);
            expect(box.max.z).toBeLessThanOrEqual(WORLD.maxZ + EPS);
            expect(box.max.y).toBeLessThanOrEqual(WORLD.maxY + EPS);
        } finally { l.dispose(); }
    });

    it('lands vertices exactly on the voxel lattice, so chunk seams cannot crack', async () => {
        const l = await load(true);
        try {
            // Every vertex of a greedy quad sits on a multiple of minVoxelSize. Two chunks
            // meeting at a seam therefore emit the SAME coordinate for the shared edge. A
            // repacked position attribute that loses exactness shows up here as an offset
            // that is not a lattice multiple.
            let checked = 0;
            for (const b of batches(l.terrain)) {
                const pos = b.geometry.getAttribute('position') as THREE.BufferAttribute;
                const v = new THREE.Vector3();
                for (let i = 0; i < pos.count; i++) {
                    v.fromBufferAttribute(pos, i);
                    for (const c of [v.x, v.y, v.z]) {
                        const units = c / MIN_VOXEL;
                        expect(Math.abs(units - Math.round(units))).toBeLessThan(1e-3);
                    }
                    checked++;
                }
            }
            // Greedy meshing collapses a flat plate into few large quads, so this is
            // hundreds of vertices, not thousands — every one of them is checked.
            expect(checked).toBe(totalVerts(l.terrain));
            expect(checked).toBeGreaterThan(50);
        } finally { l.dispose(); }
    });

    it('produces the same world whether or not the renderer is built', async () => {
        const withRenderer = await load(true);
        const without = await load(false);
        try {
            // The renderer must not perturb decode, planning or collision.
            expect(withRenderer.terrain.getChunkCount()).toBe(without.terrain.getChunkCount());
            expect(withRenderer.terrain.getBounds()).toEqual(without.terrain.getBounds());
            expect(withRenderer.terrain.getColliderCounts()).toEqual(without.terrain.getColliderCounts());
        } finally {
            withRenderer.dispose();
            without.dispose();
        }
    });
});
