import { createVxlSceneEncoder, decodeVxlScene } from 'engine/vxlscene/VxlSceneFormat.js';
import type { VxlSceneChunk, DecodedVxlSceneWorld, DecodedChunk } from 'engine/vxlscene/VxlSceneFormat.js';
import type { SceneVoxel } from 'engine/vxlscene/SceneVoxTypes.js';
import {
    buildSurfaceField, buildChunkSurfaceGeometry, cellTopY, cellColorIdx,
    type SurfaceGeometryData, type SurfaceField,
} from 'engine/vxlscene/SurfaceMeshBuilder.js';
import { rgb888ToAtlasCell } from 'engine/vxlscene/atlasColor.js';
import { buildSurfaceField as buildField } from 'engine/vxlscene/SurfaceMeshBuilder.js';

/**
 * Every cell of a field's bounding box as `[topY, colorIdx]` (null where empty), read
 * through the public accessors. Storage-independent, so it compares what the field MEANS.
 */
function dumpField(f: SurfaceField): Array<[number | null, number | null]> {
    const out: Array<[number | null, number | null]> = [];
    for (let ix = 0; ix < f.sx; ix++) {
        for (let iz = 0; iz < f.sz; iz++) {
            const gX = f.gx0 + ix * f.step, gZ = f.gz0 + iz * f.step;
            out.push([cellTopY(f, gX, gZ), cellColorIdx(f, gX, gZ)]);
        }
    }
    return out;
}

const toR8 = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));
const cellOf = (c: { r: number; g: number; b: number }): number => rgb888ToAtlasCell(toR8(c.r), toR8(c.g), toR8(c.b));
const idPal = (() => { const out = new Float32Array(4096 * 2); for (let i = 0; i < 4096; i++) { out[i * 2] = i; out[i * 2 + 1] = i; } return out; })();

const header = { chunkSize: 16, minVoxelSize: 0.125, bounds: { minX: 0, minY: 0, minZ: 0, maxX: 16, maxY: 16, maxZ: 16 }, lodDistances: [1e9] };
const subDy = (gx: number, gz: number): number => ((gx + gz) % 3) * 40 - 40; // -40, 0, 40

/** 5x5 columns; each a 2-cell SHELL (a sloped drivable top + a lower underside), multi-colour. */
function makeVoxels(): SceneVoxel[] {
    const vox: SceneVoxel[] = [];
    for (let gx = 0; gx < 5; gx++) for (let gz = 0; gz < 5; gz++) {
        const color = gx % 2 === 0 ? { r: 0.9, g: 0.9, b: 0.95 } : { r: 0.3, g: 0.5, b: 0.8 };
        vox.push({ gx, gy: 8 + gx, gz, sizeLevel: 0, color, noCollider: true, disp: { dx: 0, dy: subDy(gx, gz), dz: 0 } }); // top (slope)
        vox.push({ gx, gy: 2, gz, sizeLevel: 0, color, noCollider: true, disp: { dx: 0, dy: 0, dz: 0 } });                  // underside
    }
    return vox;
}

/** Sorted vertex multiset (pos+normal+uv) — order-independent geometry comparison. */
function sortedVerts(g: SurfaceGeometryData): string[] {
    const out: string[] = [];
    for (let i = 0; i < g.vertCount; i++) {
        out.push([g.positions[i * 3], g.positions[i * 3 + 1], g.positions[i * 3 + 2],
            g.normals[i * 3], g.normals[i * 3 + 1], g.normals[i * 3 + 2],
            g.uvs[i * 2], g.uvs[i * 2 + 1]].join(','));
    }
    return out.sort();
}

describe('v5 surface tile', () => {
    it('encode→decode moves the displaced shell into a topmost-per-column tile (drops underside)', async () => {
        const vox = makeVoxels(); // 50 displaced voxels = 25 columns x 2 (top + underside)
        const enc = createVxlSceneEncoder(header);
        const chunk: VxlSceneChunk = { cx: 0, cy: 0, cz: 0, voxels: vox, lodHints: [], namedTrimeshes: [] };
        await enc.addChunk(chunk);
        const world = await decodeVxlScene(await enc.finish());
        const ch = world.chunks[0]!;

        expect(ch.voxels.count).toBe(0);          // displaced voxels no longer stored as voxels
        expect(ch.surfaceTile).not.toBeUndefined();
        expect(ch.surfaceTile).not.toBeNull();
        expect(ch.surfaceTile!.count).toBe(25);   // one topmost cell per (gx,gz) column (underside dropped)

        for (let i = 0; i < ch.surfaceTile!.count; i++) {
            const gx = ch.surfaceTile!.localGx[i]!, gz = ch.surfaceTile!.localGz[i]!;
            // The kept cell is the slope top (gy=8+gx, dy=subDy), never the underside (gy=2).
            expect(ch.surfaceTile!.gy[i]).toBe(8 + gx);
            expect(ch.surfaceTile!.dy[i]).toBe(subDy(gx, gz));
            const heightQ = (ch.surfaceTile!.gy[i]! + 1) * 127 + ch.surfaceTile!.dy[i]!;
            expect(heightQ).toBeGreaterThan((2 + 1) * 127); // above the underside (gy=2)
        }
    });

    it('round-trips a near-top cell at the finest+largest chunk config without height overflow', async () => {
        // chunkSize 64 / minVoxel 0.0625 → 1024 cells/axis. A cell near the top (gy=1000) would make
        // heightQ = (1001)*127 + 100 = 127227 > 65535 — proves gy+dy are stored, not the product.
        const big = { chunkSize: 64, minVoxelSize: 0.0625, bounds: { minX: 0, minY: 0, minZ: 0, maxX: 64, maxY: 64, maxZ: 64 }, lodDistances: [1e9] };
        const v: SceneVoxel = { gx: 5, gy: 1000, gz: 7, sizeLevel: 0, color: { r: 0.9, g: 0.9, b: 0.95 }, noCollider: true, disp: { dx: 0, dy: 100, dz: 0 } };
        const enc = createVxlSceneEncoder(big);
        await enc.addChunk({ cx: 0, cy: 0, cz: 0, voxels: [v], lodHints: [], namedTrimeshes: [] });
        const ch = (await decodeVxlScene(await enc.finish())).chunks[0]!;
        expect(ch.surfaceTile!.count).toBe(1);
        expect(ch.surfaceTile!.gy[0]).toBe(1000); // exact (not truncated mod 65536)
        expect(ch.surfaceTile!.dy[0]).toBe(100);
    });

    it('renders identically to the v4 displaced-voxel path (same field, same mesh)', async () => {
        const vox = makeVoxels();

        // v5: encode → decode → tile.
        const enc = createVxlSceneEncoder(header);
        await enc.addChunk({ cx: 0, cy: 0, cz: 0, voxels: vox, lodHints: [], namedTrimeshes: [] });
        const world5 = await decodeVxlScene(await enc.finish());

        // v4: a DecodedChunk holding the same voxels as displaced cells, no tile.
        const n = vox.length;
        const gx = new Uint16Array(n), gy = new Uint16Array(n), gz = new Uint16Array(n);
        const sizeLevel = new Uint8Array(n), colorIdx = new Uint16Array(n), flags = new Uint8Array(n);
        const disp = new Int8Array(n * 3);
        vox.forEach((v, i) => {
            gx[i] = v.gx; gy[i] = v.gy; gz[i] = v.gz; colorIdx[i] = cellOf(v.color);
            flags[i] = (v.noCollider ? 1 : 0) | 2; disp[i * 3 + 1] = v.disp!.dy;
        });
        const v4chunk: DecodedChunk = {
            cx: 0, cy: 0, cz: 0,
            voxels: { count: n, gx, gy, gz, sizeLevel, colorIdx, flags, disp },
            lodHints: [], namedTrimeshes: [], surfaceTile: null,
        };
        const world4: DecodedVxlSceneWorld = { chunkSize: 16, minVoxelSize: 0.125, bounds: header.bounds, lodDistances: [], chunks: [v4chunk] };

        // Field is the canonical, order-independent surface — it must be byte-identical.
        const f4 = buildSurfaceField(world4, 1);
        const f5 = buildSurfaceField(world5, 1);
        expect([f5.count, f5.sx, f5.sz, f5.gx0, f5.gz0]).toEqual([f4.count, f4.sx, f4.sz, f4.gx0, f4.gz0]);
        // Compared cell by cell through the public accessors rather than against the raw
        // storage: the field is tiled and sparsely allocated, so identical CONTENT is the
        // claim worth making — and it is the stronger one, since it would also catch two
        // fields that agreed byte for byte on a layout that read back wrong.
        expect(dumpField(f5)).toEqual(dumpField(f4));

        // Same welded mesh (vertices compared as an order-independent multiset).
        const g4 = buildChunkSurfaceGeometry(f4, world4.chunks[0]!, idPal)!;
        const g5 = buildChunkSurfaceGeometry(f5, world5.chunks[0]!, idPal)!;
        expect(g5.vertCount).toBe(g4.vertCount);
        expect(g5.indexCount).toBe(g4.indexCount);
        expect(sortedVerts(g5)).toEqual(sortedVerts(g4));
    });
});

describe('v8 declared surface step', () => {
    it('round-trips the step and never welds finer than the container stores', async () => {
        // A pre-decimated variant stores columns 2 cells apart. Read at pitch 1 the builder
        // would look for neighbours that were never written and leave HOLES in the drivable
        // surface — strictly worse than the blockiness the decimation buys. The declared
        // step is what stops that, so it has to survive the file.
        const enc = createVxlSceneEncoder({ ...header, surfaceStep: 2 });
        await enc.addChunk({ cx: 0, cy: 0, cz: 0, voxels: makeVoxels(), lodHints: [], namedTrimeshes: [] });
        const world = await decodeVxlScene(await enc.finish());

        expect(world.surfaceStep).toBe(2);
        expect(buildField(world, 1).step).toBe(2);   // never finer than stored
        expect(buildField(world, 4).step).toBe(4);   // the runtime budget may still coarsen
    });

    it('defaults to 1 and stays byte-identical when no step is declared', async () => {
        // Every existing bake is in this state: the version must not move, or published
        // games stop being able to read their own levels.
        const chunk: VxlSceneChunk = { cx: 0, cy: 0, cz: 0, voxels: makeVoxels(), lodHints: [], namedTrimeshes: [] };
        const plain = createVxlSceneEncoder(header);
        await plain.addChunk(chunk);
        const a = await plain.finish();

        const explicit = createVxlSceneEncoder({ ...header, surfaceStep: 1 });
        await explicit.addChunk(chunk);
        const b = await explicit.finish();

        expect(Array.from(a)).toEqual(Array.from(b));
        expect((await decodeVxlScene(a)).surfaceStep).toBe(1);
    });
});
