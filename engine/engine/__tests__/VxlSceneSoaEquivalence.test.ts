/**
 * @jest-environment jsdom
 *
 * STRICT EQUIVALENCE tests for the Structure-of-Arrays runtime decode + its
 * SoA-consuming consumers. Each suite runs the OLD object path and the NEW SoA
 * path on the same input and asserts byte/geometry-identical output:
 *
 *   1. Decode equivalence  — encode an object `VxlSceneWorld`, decode to SoA,
 *      and assert the SoA columns reconstruct EXACTLY the pre-encode voxels /
 *      quads / colors / trimesh (incl. displaced + noCollider voxels and a
 *      >256-color palette so indices are 2 bytes). Plus skipLodLevels:1.
 *   2. buildHintMesh equivalence — same quads as SoA vs as objects produce the
 *      same positions / normals / colors / index.
 *   3. greedyBoxes equivalence — same voxels as SoA vs objects → identical boxes.
 *   4. quadsToTrimesh equivalence — same quads as SoA vs objects → identical mesh.
 *
 * jsdom is used (parity with the other vxlscene jsdom tests); compression:'none'
 * because jsdom lacks the gzip CompressionStream.
 */
import { TextEncoder, TextDecoder } from 'util';
// jsdom lacks TextEncoder/TextDecoder; the v3 trimesh name table uses them.
// Polyfill onto globalThis (mirrors VoxelChunkRoundtrip.test.ts).
if (typeof globalThis.TextEncoder === 'undefined') {
    (globalThis as unknown as { TextEncoder: typeof TextEncoder }).TextEncoder = TextEncoder;
}
if (typeof globalThis.TextDecoder === 'undefined') {
    (globalThis as unknown as { TextDecoder: typeof TextDecoder }).TextDecoder = TextDecoder;
}
import * as THREE from 'three';
import {
    encodeVxlScene, decodeVxlScene,
    type VxlSceneWorld, type VxlSceneChunk,
} from 'engine/vxlscene/VxlSceneFormat.js';
import type { SceneQuad, SceneVoxel } from 'engine/vxlscene/SceneVoxTypes.js';
import { buildHintMesh, buildHintMeshSoA } from 'engine/vxlscene/buildHintMesh.js';
import {
    greedyBoxes, greedyBoxesSoA, quadsToTrimesh, quadsToTrimeshSoA,
} from 'engine/vxlscene/ColliderBaker.js';
import { worldSoaToObjects, cellColor } from 'engine/__tests__/vxlSceneSoaTestUtils.js';
import { getVoxelTextureAtlas } from 'engine/VoxelTextureAtlas.js';
import { rgb888ToAtlasCell } from 'engine/vxlscene/atlasColor.js';

/** Map an RGB888 palette (length 3N) to the per-entry atlas color-palette UV centers (length 2N). */
function paletteToUV(palette: Uint8Array): Float32Array {
    const atlas = getVoxelTextureAtlas();
    const out = new Float32Array((palette.length / 3) * 2);
    for (let i = 0; i < palette.length / 3; i++) {
        const uv = atlas.getColorPaletteUV(palette[i * 3]!, palette[i * 3 + 1]!, palette[i * 3 + 2]!);
        out[i * 2] = (uv.u0 + uv.u1) / 2;
        out[i * 2 + 1] = (uv.v0 + uv.v1) / 2;
    }
    return out;
}

/** An object color built from 0..255 channels. */
const c = (r: number, g: number, b: number) => ({ r: r / 255, g: g / 255, b: b / 255 });

/**
 * Apply the format's lossy color round-trip: every stored color is quantized to a 12-bit
 * RGB444 atlas cell (sRGB-encode baked in), so a decoded color equals
 * `cellColor(rgb888ToAtlasCell(original))` — not the original. Use on EXPECTED colors.
 */
const rt = (col: { r: number; g: number; b: number }): { r: number; g: number; b: number } =>
    cellColor(rgb888ToAtlasCell(Math.round(col.r * 255), Math.round(col.g * 255), Math.round(col.b * 255)));
const rtVox = (vs: SceneVoxel[]): SceneVoxel[] => vs.map(v => ({ ...v, color: rt(v.color) }));
const rtQuads = (qs: SceneQuad[]): SceneQuad[] => qs.map(q => ({ ...q, color: rt(q.color) }));

// ───────────────────────── 1. Decode equivalence ─────────────────────────

describe('decode equivalence (SoA decode reconstructs the pre-encode objects exactly)', () => {
    /**
     * A world exercising every voxel/quad variation the decode must preserve:
     *   - plain voxels, displaced voxels (hasDisp), noCollider voxels;
     *   - several sizeLevels;
     *   - multiple LOD levels with +dir and -dir quads on all three axes;
     *   - a baked per-chunk trimesh on one chunk;
     *   - many distinct colors (all collapse into the 4096 RGB444 atlas cells).
     */
    function richWorld(): VxlSceneWorld {
        const chunks: VxlSceneChunk[] = [];
        let colorN = 0;
        const nextColor = () => c((colorN++) % 256, Math.floor(colorN / 256) % 256, (colorN * 7) % 256);
        // 40 chunks × (≥8 distinct colors each) ⇒ well over 256 palette entries.
        for (let cx = 0; cx < 40; cx++) {
            const voxels: SceneVoxel[] = [
                { gx: 0, gy: 0, gz: 0, sizeLevel: 0, color: nextColor(), noCollider: false, disp: null },
                { gx: 1, gy: 2, gz: 3, sizeLevel: 2, color: nextColor(), noCollider: true, disp: { dx: 5, dy: -6, dz: 7 } },
                { gx: 9, gy: 0, gz: 0, sizeLevel: 1, color: nextColor(), noCollider: false, disp: { dx: -128, dy: 127, dz: 0 } },
                { gx: 4, gy: 4, gz: 4, sizeLevel: 3, color: nextColor(), noCollider: true, disp: null },
            ];
            const lod0: SceneQuad[] = [
                { gx: 0, gy: 1, gz: 0, w: 2, h: 3, axis: 1, dir: 1, color: nextColor(), disp: 0 },
                { gx: 1, gy: 0, gz: 2, w: 1, h: 1, axis: 0, dir: -1, color: nextColor(), disp: 4 },
                { gx: 3, gy: 3, gz: 1, w: 5, h: 2, axis: 2, dir: 1, color: nextColor(), disp: -9 },
            ];
            const lod1: SceneQuad[] = [
                { gx: 0, gy: 2, gz: 0, w: 4, h: 4, axis: 1, dir: -1, color: nextColor(), disp: 0 },
            ];
            chunks.push({
                cx, cy: 0, cz: 0, voxels, lodHints: [lod0, lod1],
                namedTrimeshes: cx === 0
                    ? [{ name: 'ramp', verts: new Float32Array([0, 0, 0, 1.5, 0, 0, 1.5, 2.25, 0, 0, 2.25, 0]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) }]
                    : [],
            });
        }
        return {
            chunkSize: 16, minVoxelSize: 0.0625,
            bounds: { minX: 0, minY: 0, minZ: 0, maxX: 640, maxY: 16, maxZ: 16 },
            lodDistances: [50, 120],
            chunks,
        };
    }

    it('reconstructs voxels, quads and colors exactly, trimesh within the quant lattice (full decode)', async () => {
        const world = richWorld();
        const bytes = await encodeVxlScene(world, { compression: 'none' });
        const decoded = await decodeVxlScene(bytes);
        const step = world.chunkSize / 65535; // v4 trimesh vert lattice step

        const reconstructed = worldSoaToObjects(decoded);
        expect(reconstructed.length).toBe(world.chunks.length);

        for (let i = 0; i < world.chunks.length; i++) {
            const orig = world.chunks[i]!;
            const got = reconstructed[i]!;
            expect({ cx: got.cx, cy: got.cy, cz: got.cz }).toEqual({ cx: orig.cx, cy: orig.cy, cz: orig.cz });
            // Every non-color field (gx/gy/gz/sizeLevel/noCollider/disp, quad axis/dir/
            // extents/disp) must match EXACTLY; colors match after the RGB444 round-trip
            // (the format stores a 12-bit atlas cell, not the original color).
            expect(got.voxels).toEqual(rtVox(orig.voxels));
            expect(got.lodHints).toEqual(orig.lodHints.map(rtQuads));
            // Trimesh names + indices are exact; verts are quantized to the lattice (≤1 step).
            expect(got.namedTrimeshes.length).toBe(orig.namedTrimeshes.length);
            for (let t = 0; t < orig.namedTrimeshes.length; t++) {
                expect(got.namedTrimeshes[t]!.name).toBe(orig.namedTrimeshes[t]!.name);
                expect(Array.from(got.namedTrimeshes[t]!.indices)).toEqual(Array.from(orig.namedTrimeshes[t]!.indices));
                const ov = orig.namedTrimeshes[t]!.verts; const gv = got.namedTrimeshes[t]!.verts;
                expect(gv.length).toBe(ov.length);
                for (let k = 0; k < ov.length; k++) expect(Math.abs(gv[k]! - ov[k]!)).toBeLessThanOrEqual(step);
            }
        }
    });

    it('SoA columns hold the raw fields (not via the object adapter)', async () => {
        const world = richWorld();
        const decoded = await decodeVxlScene(await encodeVxlScene(world, { compression: 'none' }));
        const ch0 = decoded.chunks[0]!;
        const v = ch0.voxels;
        // Column lengths == count; first voxel matches the fixture's raw values.
        expect(v.count).toBe(4);
        expect(v.gx[0]).toBe(0); expect(v.gy[0]).toBe(0); expect(v.gz[0]).toBe(0);
        expect(v.sizeLevel[1]).toBe(2);
        // Voxel 1 is noCollider + hasDisp → flags bit0 and bit1 set.
        expect(v.flags[1]! & 1).toBe(1);
        expect(v.flags[1]! & 2).toBe(2);
        // Voxel 0 has no displacement → flags bit1 clear.
        expect(v.flags[0]! & 2).toBe(0);
        // The disp column exists (some voxels are displaced) and holds voxel 1's offset.
        expect(v.disp).not.toBeNull();
        expect([v.disp![3], v.disp![4], v.disp![5]]).toEqual([5, -6, 7]);
        // Quad columns: axisDir packs axis + dir; verify the -dir quad of lod0.
        const q = ch0.lodHints[0]!;
        expect(q.count).toBe(3);
        expect(q.axisDir[1]! & 0x3).toBe(0);        // axis 0 (X)
        expect((q.axisDir[1]! >> 2) & 1).toBe(1);   // dir -1
        expect(q.disp[1]).toBe(4);
    });

    it('a chunk with no displaced voxels decodes disp === null', async () => {
        const world: VxlSceneWorld = {
            chunkSize: 8, minVoxelSize: 1,
            bounds: { minX: 0, minY: 0, minZ: 0, maxX: 8, maxY: 8, maxZ: 8 },
            lodDistances: [50],
            chunks: [{
                cx: 0, cy: 0, cz: 0,
                voxels: [
                    { gx: 0, gy: 0, gz: 0, sizeLevel: 0, color: c(10, 20, 30), noCollider: false, disp: null },
                    { gx: 1, gy: 0, gz: 0, sizeLevel: 0, color: c(40, 50, 60), noCollider: true, disp: null },
                ],
                lodHints: [[]],
                namedTrimeshes: [],
            }],
        };
        const decoded = await decodeVxlScene(await encodeVxlScene(world, { compression: 'none' }));
        expect(decoded.chunks[0]!.voxels.disp).toBeNull();
        // Still reconstructs the (null-disp) voxels (colors at RGB444 precision).
        expect(worldSoaToObjects(decoded)[0]!.voxels).toEqual(rtVox(world.chunks[0]!.voxels));
    });

    it('skipLodLevels:1 on the SoA path: voxels kept, levels shifted, distances shifted', async () => {
        const world = richWorld();
        const bytes = await encodeVxlScene(world, { compression: 'none' });
        const full = await decodeVxlScene(bytes);
        const lite = await decodeVxlScene(bytes, { skipLodLevels: 1 });

        expect(full.lodDistances).toEqual([50, 120]);
        expect(lite.lodDistances).toEqual([120]); // first distance dropped

        const fullObj = worldSoaToObjects(full);
        const liteObj = worldSoaToObjects(lite);
        for (let i = 0; i < lite.chunks.length; i++) {
            // Per-voxel columns are PRESERVED — the displaced smooth surface must survive.
            expect(lite.chunks[i]!.voxels.count).toBe(full.chunks[i]!.voxels.count);
            expect(liteObj[i]!.voxels).toEqual(fullObj[i]!.voxels);
            expect(lite.chunks[i]!.lodHints.length).toBe(full.chunks[i]!.lodHints.length - 1);
            // Kept LOD levels equal the full decode's levels[1..] exactly.
            expect(liteObj[i]!.lodHints).toEqual(fullObj[i]!.lodHints.slice(1));
            // Baked trimesh survives the lite decode.
            expect(lite.chunks[i]!.namedTrimeshes).toEqual(full.chunks[i]!.namedTrimeshes);
        }
    });
});

// ─────────────────── 2. buildHintMesh equivalence ───────────────────

describe('buildHintMesh equivalence (SoA quads vs object quads → identical geometry)', () => {
    const ctx = { minVoxelSize: 0.5, originX: 10, originY: -3, originZ: 7 };

    // Quads on all three axes, both directions. (disp values are carried in the
    // SceneQuad/SoA struct but not consumed by the quad builder.)
    const objQuads: SceneQuad[] = [
        { gx: 0, gy: 1, gz: 0, w: 2, h: 3, axis: 1, dir: 1, color: c(255, 0, 0), disp: 0 },
        { gx: 1, gy: 0, gz: 2, w: 1, h: 4, axis: 0, dir: -1, color: c(0, 255, 0), disp: 9 },
        { gx: 3, gy: 3, gz: 1, w: 5, h: 2, axis: 2, dir: 1, color: c(0, 0, 255), disp: -12 },
        { gx: 2, gy: 2, gz: 2, w: 1, h: 1, axis: 2, dir: -1, color: c(128, 64, 32), disp: 0 },
    ];

    /** Build the SoA columns + palette mirroring the object fixtures above. */
    function soaInputs() {
        const palette: number[] = [];
        const map = new Map<number, number>();
        const intern = (col: { r: number; g: number; b: number }): number => {
            const r8 = Math.round(col.r * 255), g8 = Math.round(col.g * 255), b8 = Math.round(col.b * 255);
            const key = (r8 << 16) | (g8 << 8) | b8;
            let idx = map.get(key);
            if (idx === undefined) { idx = palette.length / 3; palette.push(r8, g8, b8); map.set(key, idx); }
            return idx;
        };
        const nq = objQuads.length;
        const quads = {
            count: nq,
            gx: new Uint16Array(nq), gy: new Uint16Array(nq), gz: new Uint16Array(nq),
            w: new Uint16Array(nq), h: new Uint16Array(nq),
            axisDir: new Uint8Array(nq), colorIdx: new Uint16Array(nq), disp: new Int8Array(nq),
        };
        objQuads.forEach((q, i) => {
            quads.gx[i] = q.gx; quads.gy[i] = q.gy; quads.gz[i] = q.gz;
            quads.w[i] = q.w; quads.h[i] = q.h;
            quads.axisDir[i] = (q.axis & 0x3) | ((q.dir === -1 ? 1 : 0) << 2);
            quads.colorIdx[i] = intern(q.color); quads.disp[i] = q.disp;
        });
        return { quads, palette: new Uint8Array(palette) };
    }

    function attrs(mesh: THREE.Mesh) {
        const g = mesh.geometry as THREE.BufferGeometry;
        return {
            position: Array.from((g.getAttribute('position') as THREE.BufferAttribute).array as Float32Array),
            normal: Array.from((g.getAttribute('normal') as THREE.BufferAttribute).array as Float32Array),
            // Atlas mode: per-vertex UV into the shared atlas (replaces the old per-vertex color).
            uv: Array.from((g.getAttribute('uv') as THREE.BufferAttribute).array as Float32Array),
            index: Array.from((g.getIndex() as THREE.BufferAttribute).array as Uint32Array),
        };
    }

    it('quads only: identical positions / normals / uv / index', () => {
        const obj = buildHintMesh(objQuads, ctx);
        const { quads, palette } = soaInputs();
        const soa = buildHintMeshSoA(quads, paletteToUV(palette), ctx);
        expect(attrs(soa)).toEqual(attrs(obj));
    });
});

// ─────────────────── 3. greedyBoxes equivalence ───────────────────

describe('greedyBoxes equivalence (SoA voxels vs object voxels → identical boxes)', () => {
    const objVoxels: SceneVoxel[] = [
        { gx: 0, gy: 0, gz: 0, sizeLevel: 0, color: c(1, 1, 1), noCollider: false, disp: null },
        { gx: 2, gy: 0, gz: 0, sizeLevel: 1, color: c(1, 1, 1), noCollider: false, disp: { dx: 1, dy: 2, dz: 3 } },
        { gx: 10, gy: 0, gz: 0, sizeLevel: 0, color: c(1, 1, 1), noCollider: true, disp: null }, // excluded
        { gx: 20, gy: 5, gz: 5, sizeLevel: 3, color: c(1, 1, 1), noCollider: false, disp: null },
        { gx: 0, gy: 9, gz: 0, sizeLevel: 2, color: c(1, 1, 1), noCollider: true, disp: { dx: 0, dy: 0, dz: 0 } }, // excluded
    ];

    function soaVoxels() {
        const n = objVoxels.length;
        const disp = new Int8Array(n * 3);
        const out = {
            count: n,
            gx: new Uint16Array(n), gy: new Uint16Array(n), gz: new Uint16Array(n),
            sizeLevel: new Uint8Array(n), colorIdx: new Uint16Array(n), flags: new Uint8Array(n),
            disp,
        };
        objVoxels.forEach((v, i) => {
            out.gx[i] = v.gx; out.gy[i] = v.gy; out.gz[i] = v.gz;
            out.sizeLevel[i] = v.sizeLevel; out.colorIdx[i] = 0;
            out.flags[i] = (v.noCollider ? 1 : 0) | (v.disp ? 2 : 0);
            if (v.disp) { const o = i * 3; disp[o] = v.disp.dx; disp[o + 1] = v.disp.dy; disp[o + 2] = v.disp.dz; }
        });
        return out;
    }

    it('emits the same AABB list in the same order', () => {
        const objBoxes = greedyBoxes(objVoxels);
        const soaBoxes = greedyBoxesSoA(soaVoxels());
        expect(soaBoxes).toEqual(objBoxes);
    });

    it('all-noCollider input yields no boxes (both forms)', () => {
        const allNoCollider: SceneVoxel[] = objVoxels.map(v => ({ ...v, noCollider: true }));
        const obj = greedyBoxes(allNoCollider);
        const soa = greedyBoxesSoA({
            ...soaVoxels(),
            flags: new Uint8Array(objVoxels.length).fill(1),
        });
        expect(obj).toHaveLength(0);
        expect(soa).toHaveLength(0);
    });
});

// ─────────────────── 4. quadsToTrimesh equivalence ───────────────────

describe('quadsToTrimesh equivalence (SoA quads vs object quads → identical trimesh)', () => {
    const objQuads: SceneQuad[] = [
        { gx: 0, gy: 1, gz: 0, w: 2, h: 3, axis: 1, dir: 1, color: c(1, 1, 1), disp: 0 },
        { gx: 1, gy: 0, gz: 2, w: 1, h: 1, axis: 0, dir: -1, color: c(1, 1, 1), disp: 0 },
        { gx: 3, gy: 3, gz: 1, w: 5, h: 2, axis: 2, dir: 1, color: c(1, 1, 1), disp: 0 },
    ];

    function soaQuads() {
        const n = objQuads.length;
        const out = {
            count: n,
            gx: new Uint16Array(n), gy: new Uint16Array(n), gz: new Uint16Array(n),
            w: new Uint16Array(n), h: new Uint16Array(n),
            axisDir: new Uint8Array(n), colorIdx: new Uint16Array(n), disp: new Int8Array(n),
        };
        objQuads.forEach((q, i) => {
            out.gx[i] = q.gx; out.gy[i] = q.gy; out.gz[i] = q.gz;
            out.w[i] = q.w; out.h[i] = q.h;
            out.axisDir[i] = (q.axis & 0x3) | ((q.dir === -1 ? 1 : 0) << 2);
            out.colorIdx[i] = 0; out.disp[i] = q.disp;
        });
        return out;
    }

    it('identical verts + indices for varied axes/dirs/extents', () => {
        const obj = quadsToTrimesh(objQuads, 0.0625, 10, -3, 7);
        const soa = quadsToTrimeshSoA(soaQuads(), 0.0625, 10, -3, 7);
        expect(Array.from(soa.verts)).toEqual(Array.from(obj.verts));
        expect(Array.from(soa.indices)).toEqual(Array.from(obj.indices));
    });
});
