/**
 * @jest-environment jsdom
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
import * as zlib from 'zlib';
import {
    encodeVxlScene, decodeVxlScene, isVxlScene, createVxlSceneEncoder, VXLSCENE_MAGIC,
    type VxlSceneWorld, type VxlSceneChunk, type DecodedVxlSceneWorld,
} from 'engine/vxlscene/VxlSceneFormat.js';
import type { SceneVoxel, SceneQuad } from 'engine/vxlscene/SceneVoxTypes.js';
import { worldSoaToObjects } from 'engine/__tests__/vxlSceneSoaTestUtils.js';
import { rgb888ToAtlasCell } from 'engine/vxlscene/atlasColor.js';

function chunk(cx: number, cy: number, cz: number): VxlSceneChunk {
    const voxels: SceneVoxel[] = [
        { gx: 0, gy: 0, gz: 0, sizeLevel: 0, color: { r: 1, g: 0, b: 0 }, noCollider: false, disp: null },
        { gx: 1, gy: 0, gz: 0, sizeLevel: 1, color: { r: 0, g: 1, b: 0 }, noCollider: true,
          disp: { dx: 0, dy: 12, dz: 0 } },
    ];
    const lod0: SceneQuad[] = [
        { gx: 0, gy: 1, gz: 0, w: 2, h: 1, axis: 1, dir: 1, color: { r: 1, g: 0, b: 0 }, disp: 0 },
    ];
    return { cx, cy, cz, voxels, lodHints: [lod0], namedTrimeshes: [] };
}

/**
 * Deep structural comparison of two decoded SoA worlds (geometry equality):
 * reconstruct the object form of each and compare voxels / LOD quads / trimesh.
 * Colors are compared via the shared palette so a color delta still fails.
 */
function expectChunksEqual(a: DecodedVxlSceneWorld, b: DecodedVxlSceneWorld): void {
    const oa = worldSoaToObjects(a);
    const ob = worldSoaToObjects(b);
    expect(oa.length).toBe(ob.length);
    for (let i = 0; i < oa.length; i++) {
        const ca = oa[i]!; const cb = ob[i]!;
        expect({ cx: ca.cx, cy: ca.cy, cz: ca.cz }).toEqual({ cx: cb.cx, cy: cb.cy, cz: cb.cz });
        expect(ca.voxels).toEqual(cb.voxels);
        expect(ca.lodHints).toEqual(cb.lodHints);
        expect(ca.namedTrimeshes).toEqual(cb.namedTrimeshes);
    }
}

describe('VxlScene format', () => {
    const world: VxlSceneWorld = {
        chunkSize: 16, minVoxelSize: 0.5,
        bounds: { minX: 0, minY: 0, minZ: 0, maxX: 16, maxY: 16, maxZ: 16 },
        lodDistances: [50, 120],
        chunks: [chunk(0, 0, 0), chunk(1, 0, 0)],
    };
    it('detects magic and round-trips a world', async () => {
        const bytes = await encodeVxlScene(world, { compression: 'none' });
        expect(isVxlScene(bytes.buffer)).toBe(true);
        const back = await decodeVxlScene(bytes);
        expect(back.chunkSize).toBe(16);
        expect(back.minVoxelSize).toBeCloseTo(0.5);
        expect(back.lodDistances).toEqual([50, 120]);
        expect(back.chunks).toHaveLength(2);
        const c = worldSoaToObjects(back)[0]!;
        // The non-displaced voxel stays a voxel; the smooth:y (displaced) one moved to the surface tile.
        expect(c.voxels).toHaveLength(1);
        expect(c.voxels[0]!.color.r).toBeCloseTo(1, 2);
        expect(c.lodHints[0]![0]).toMatchObject({ gx: 0, gy: 1, gz: 0, w: 2, h: 1, axis: 1, dir: 1 });
        // The displaced voxel (gx=1, gy=0, dy=12) round-trips as a tile column storing gy + dy.
        const tile = back.chunks[0]!.surfaceTile!;
        expect(tile.count).toBe(1);
        expect(tile.localGx[0]).toBe(1);
        expect(tile.gy[0]).toBe(0);
        expect(tile.dy[0]).toBe(12);
    });
    it('rejects non-magic buffers', () => {
        expect(isVxlScene(new Uint8Array([1, 2, 3, 4]).buffer)).toBe(false);
    });
    it('packs a quad offset into axisDir bits 3-5, leaving axis/dir intact', async () => {
        // A single -Z quad (axis 2, dir -1) tagged with the source object's lodOffset 2.
        // The encoder packs offset into the free high bits of the axisDir byte; the
        // decoder stores axisDir raw, so the decoded byte must round-trip all three
        // fields: axis (bits 0-1), dir (bit 2) and offset (bits 3-5).
        const offsetWorld: VxlSceneWorld = {
            chunkSize: 16, minVoxelSize: 0.5,
            bounds: { minX: 0, minY: 0, minZ: 0, maxX: 16, maxY: 16, maxZ: 16 },
            lodDistances: [50],
            chunks: [{
                cx: 0, cy: 0, cz: 0,
                voxels: [],
                lodHints: [[
                    { gx: 1, gy: 2, gz: 3, w: 4, h: 5, axis: 2, dir: -1, color: { r: 1, g: 0, b: 0 }, disp: 0, offset: 2 },
                ]],
                namedTrimeshes: [],
            }],
        };
        const back = await decodeVxlScene(await encodeVxlScene(offsetWorld, { compression: 'none' }));
        const axisDir = back.chunks[0]!.lodHints[0]!.axisDir[0]!;
        expect(axisDir & 0x3).toBe(2);          // axis 2 (Z) intact
        expect((axisDir >> 2) & 1).toBe(1);     // dir -1 intact
        expect((axisDir >> 3) & 0x7).toBe(2);   // offset 2 packed into bits 3-5
    });
    it('a quad with no offset (absent) round-trips as offset bits 0', async () => {
        const back = await decodeVxlScene(await encodeVxlScene(world, { compression: 'none' }));
        const axisDir = back.chunks[0]!.lodHints[0]!.axisDir[0]!;
        // chunk() builds axis 1, dir 1, no offset.
        expect(axisDir & 0x3).toBe(1);
        expect((axisDir >> 2) & 1).toBe(0);
        expect((axisDir >> 3) & 0x7).toBe(0);   // absent offset ⇒ 0
    });
    it('is deterministic', async () => {
        const a = await encodeVxlScene(world, { compression: 'none' });
        const b = await encodeVxlScene(world, { compression: 'none' });
        expect(Buffer.from(a)).toEqual(Buffer.from(b));
    });
});

describe('VxlScene v4 layout (columnar + world palette + quantized trimesh)', () => {
    /** chunkSize/minVoxelSize = 128 → 1-byte coords; few shared colors → 1-byte palette. */
    const TRIMESH_STEP = 16 / 65535;

    function paletteFriendlyWorld(): VxlSceneWorld {
        const sharedColors = [
            { r: 1, g: 0, b: 0 }, { r: 0, g: 1, b: 0 }, { r: 0, g: 0, b: 1 },
            { r: 1, g: 1, b: 0 }, { r: 0, g: 1, b: 1 }, { r: 1, g: 0, b: 1 },
        ];
        const chunks: VxlSceneChunk[] = [];
        for (let c = 0; c < 40; c++) {
            const lod0: SceneQuad[] = [];
            for (let q = 0; q < 300; q++) {
                lod0.push({
                    gx: q % 120, gy: (q * 3) % 120, gz: (q * 7) % 120,
                    w: 1 + (q % 100), h: 1 + (q % 80),
                    axis: (q % 3) as 0 | 1 | 2, dir: q % 2 === 0 ? 1 : -1,
                    color: sharedColors[q % sharedColors.length]!, disp: 0,
                });
            }
            chunks.push({ cx: c, cy: 0, cz: 0, voxels: [], lodHints: [lod0], namedTrimeshes: [] });
        }
        return {
            chunkSize: 16, minVoxelSize: 0.125,
            bounds: { minX: 0, minY: 0, minZ: 0, maxX: 640, maxY: 16, maxZ: 16 },
            lodDistances: [50], chunks,
        };
    }

    it('encodes as format version 7', async () => {
        const bytes = await encodeVxlScene(paletteFriendlyWorld(), { compression: 'none' });
        expect(bytes[4]).toBe(7); // v7 = v6 + optional emissive-palette section
    });

    it('columnar + palette encoding is much smaller than the interleaved inline layout', async () => {
        const bytes = await encodeVxlScene(paletteFriendlyWorld(), { compression: 'none' });
        // 40 chunks × 300 quads. Interleaved v3 inline = 14 B/quad ≈ 168 KB of payload.
        // Columnar + 1-byte palette + 1-byte coords = ~8 B/quad ≈ 96 KB. Gate well below v3.
        expect(bytes.length).toBeLessThan(120_000);
    });

    it('round-trips the palette-friendly world (colors preserved at RGB444 precision)', async () => {
        const w = paletteFriendlyWorld();
        const back = await decodeVxlScene(await encodeVxlScene(w, { compression: 'none' }));
        const obj = worldSoaToObjects(back);
        expect(obj).toHaveLength(40);
        // Spot-check first and last chunk's first quad colour survives.
        expect(obj[0]!.lodHints[0]![0]!.color.r).toBeCloseTo(1, 2);
        expect(obj[39]!.lodHints[0]![0]!.color.r).toBeCloseTo(1, 2);
        expect(obj[0]!.lodHints[0]).toHaveLength(300);
    });

    it('quantizes named-trimesh verts to the seam-safe collider lattice (lossy, sub-mm)', async () => {
        const w: VxlSceneWorld = {
            chunkSize: 16, minVoxelSize: 0.125,
            bounds: { minX: 0, minY: 0, minZ: 0, maxX: 16, maxY: 16, maxZ: 16 },
            lodDistances: [50],
            chunks: [{
                cx: 0, cy: 0, cz: 0, voxels: [], lodHints: [[]],
                // 1.0 and 7.3 are NOT exact multiples of the lattice step.
                namedTrimeshes: [{
                    name: 'road',
                    verts: new Float32Array([1.0, 7.3, 0.0, 2.5, 9.9, 3.3, 0.4, 1.1, 15.99]),
                    indices: new Uint32Array([0, 1, 2]),
                }],
            }],
        };
        const back = await decodeVxlScene(await encodeVxlScene(w, { compression: 'none' }));
        const verts = back.chunks[0]!.namedTrimeshes[0]!.verts;
        const original = [1.0, 7.3, 0.0, 2.5, 9.9, 3.3, 0.4, 1.1, 15.99];
        for (let i = 0; i < verts.length; i++) {
            // Each decoded vert is the input snapped to the lattice: round(o/step)·step.
            const expected = Math.fround(Math.round(original[i]! / TRIMESH_STEP) * TRIMESH_STEP);
            expect(verts[i]).toBeCloseTo(expected, 5);
            // …and therefore within one step of the original.
            expect(Math.abs(verts[i]! - original[i]!)).toBeLessThanOrEqual(TRIMESH_STEP);
        }
        // The 1.0 input is off-lattice, so it must NOT round-trip bit-exact (proves quantization).
        expect(verts[0]).not.toBe(1.0);
        // Indices stay exact.
        expect(Array.from(back.chunks[0]!.namedTrimeshes[0]!.indices)).toEqual([0, 1, 2]);
    });
});

describe('VxlScene v4 delta-coded coordinates', () => {
    const mkWorld = (quads: SceneQuad[]): VxlSceneWorld => ({
        chunkSize: 16, minVoxelSize: 0.125,
        bounds: { minX: 0, minY: 0, minZ: 0, maxX: 16, maxY: 16, maxZ: 16 },
        lodDistances: [50],
        chunks: [{ cx: 0, cy: 0, cz: 0, voxels: [], lodHints: [quads], namedTrimeshes: [] }],
    });

    it('delta-coding makes sweep-ordered positions gzip far smaller than shuffled', async () => {
        // Identical quads in two orderings. Delta-coded gx/gy/gz compress when consecutive
        // positions are close (sweep order, as the greedy mesher emits) and poorly when
        // they jump around (shuffled). Everything else (w/h extents, color, axisDir) is
        // identical between the two, so any gzip gap is purely the delta'd position columns
        // exploiting locality. (Without delta the two would gzip to nearly the same size.)
        let x = 64, y = 64, z = 64, s = 12345;
        const rnd = (): number => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s; };
        const stepv = (v: number): number => Math.max(0, Math.min(127, v + (rnd() % 13) - 6));
        const base: SceneQuad[] = [];
        for (let i = 0; i < 40000; i++) {
            x = stepv(x); y = stepv(y); z = stepv(z);
            base.push({
                gx: x, gy: y, gz: z, w: 1 + (rnd() % 100), h: 1 + (rnd() % 100),
                axis: (i % 3) as 0 | 1 | 2, dir: i % 2 ? 1 : -1, color: { r: 1, g: 0, b: 0 }, disp: 0,
            });
        }
        const shuffled = [...base];
        for (let i = shuffled.length - 1; i > 0; i--) { const j = rnd() % (i + 1); [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]; }

        const gzSweep = zlib.gzipSync(Buffer.from(await encodeVxlScene(mkWorld(base), { compression: 'none' }))).length;
        const gzShuf = zlib.gzipSync(Buffer.from(await encodeVxlScene(mkWorld(shuffled), { compression: 'none' }))).length;
        expect(gzSweep).toBeLessThan(gzShuf * 0.75);
    });

    it('round-trips positions exactly through delta (incl. byte-boundary wraps)', async () => {
        // Big up/down jumps stress the wrapping prefix-sum (e.g. 120→3 → delta wraps).
        const seq = [120, 3, 110, 0, 64, 127, 1, 90, 5, 118];
        const quads: SceneQuad[] = seq.map((v, i) => ({
            gx: v, gy: seq[(i + 3) % seq.length]!, gz: seq[(i + 6) % seq.length]!,
            w: 1, h: 1, axis: 0, dir: 1, color: { r: 0, g: 1, b: 0 }, disp: 0,
        }));
        const world: VxlSceneWorld = {
            chunkSize: 16, minVoxelSize: 0.125,
            bounds: { minX: 0, minY: 0, minZ: 0, maxX: 16, maxY: 16, maxZ: 16 },
            lodDistances: [50],
            chunks: [{ cx: 0, cy: 0, cz: 0, voxels: [], lodHints: [quads], namedTrimeshes: [] }],
        };
        const back = worldSoaToObjects(await decodeVxlScene(await encodeVxlScene(world, { compression: 'none' })))[0]!.lodHints[0]!;
        seq.forEach((v, i) => {
            expect(back[i]!.gx).toBe(v);
            expect(back[i]!.gy).toBe(seq[(i + 3) % seq.length]!);
            expect(back[i]!.gz).toBe(seq[(i + 6) % seq.length]!);
        });
    });
});

describe('VxlScene lite decode (skipLodLevels)', () => {
    // A world whose chunks each carry voxels (some displaced) + 3 distinct LOD
    // levels so we can verify per-voxel data is PRESERVED (the displaced smooth
    // surface) while the finest LOD-hint levels are skipped and the rest survive
    // byte-identically.
    function mkChunk(cx: number): VxlSceneChunk {
        const voxels: SceneVoxel[] = [
            { gx: 0, gy: 0, gz: 0, sizeLevel: 0, color: { r: 1, g: 0, b: 0 }, noCollider: false, disp: null },
            // hasDisp record → exercises the variable-width voxel-skip path.
            { gx: 1, gy: 2, gz: 3, sizeLevel: 1, color: { r: 0, g: 1, b: 0 }, noCollider: true, disp: { dx: 5, dy: -6, dz: 7 } },
            { gx: 4, gy: 0, gz: 0, sizeLevel: 0, color: { r: 0, g: 0, b: 1 }, noCollider: false, disp: null },
        ];
        const lod0: SceneQuad[] = [
            { gx: 0, gy: 1, gz: 0, w: 2, h: 3, axis: 1, dir: 1, color: { r: 1, g: 0, b: 0 }, disp: 0 },
            { gx: 1, gy: 0, gz: 2, w: 1, h: 1, axis: 0, dir: -1, color: { r: 0, g: 1, b: 0 }, disp: 4 },
        ];
        const lod1: SceneQuad[] = [
            { gx: 0, gy: 2, gz: 0, w: 4, h: 4, axis: 1, dir: 1, color: { r: 0, g: 0, b: 1 }, disp: 0 },
        ];
        const lod2: SceneQuad[] = [
            { gx: 0, gy: 4, gz: 0, w: 8, h: 8, axis: 2, dir: -1, color: { r: 1, g: 1, b: 0 }, disp: 0 },
        ];
        return { cx, cy: 0, cz: 0, voxels, lodHints: [lod0, lod1, lod2], namedTrimeshes: [] };
    }
    function liteWorld(): VxlSceneWorld {
        return {
            chunkSize: 16, minVoxelSize: 0.5,
            bounds: { minX: 0, minY: 0, minZ: 0, maxX: 32, maxY: 16, maxZ: 16 },
            lodDistances: [50, 120, 200],
            chunks: [mkChunk(0), mkChunk(1)],
        };
    }

    it('skipLodLevels:0 / undefined decode identically to the default decode', async () => {
        const bytes = await encodeVxlScene(liteWorld(), { compression: 'none' });
        const full = await decodeVxlScene(bytes);
        const explicitZero = await decodeVxlScene(bytes, { skipLodLevels: 0 });
        expect(explicitZero.lodDistances).toEqual(full.lodDistances);
        expectChunksEqual(explicitZero, full);
    });

    it('skipLodLevels:1 keeps voxels, drops the finest LOD level, and shifts lodDistances', async () => {
        const bytes = await encodeVxlScene(liteWorld(), { compression: 'none' });
        const full = await decodeVxlScene(bytes);
        const lite = await decodeVxlScene(bytes, { skipLodLevels: 1 });
        const fullObj = worldSoaToObjects(full);
        const liteObj = worldSoaToObjects(lite);

        // lodDistances dropped its first entry (stays parallel to kept LOD levels).
        expect(full.lodDistances).toEqual([50, 120, 200]);
        expect(lite.lodDistances).toEqual([120, 200]);

        expect(lite.chunks).toHaveLength(full.chunks.length);
        for (let i = 0; i < lite.chunks.length; i++) {
            const lc = lite.chunks[i]!;
            const fc = full.chunks[i]!;
            // Per-voxel columns are PRESERVED — they carry the displaced (smooth:y)
            // ride surface, which must survive the memory-bounded decode intact.
            expect(lc.voxels.count).toBe(fc.voxels.count);
            expect(liteObj[i]!.voxels).toEqual(fullObj[i]!.voxels);
            expect(liteObj[i]!.voxels.some(v => v.disp !== null)).toBe(true);
            // One fewer LOD level...
            expect(lc.lodHints.length).toBe(fc.lodHints.length - 1);
            // ...and the kept levels equal the full decode's levels[1..] exactly.
            expect(liteObj[i]!.lodHints).toEqual(fullObj[i]!.lodHints.slice(1));
            // trimesh decoding is unaffected.
            expect(lc.namedTrimeshes).toEqual(fc.namedTrimeshes);
        }
    });

    it('skipLodLevels ≥ count keeps exactly one (coarsest) LOD level', async () => {
        const bytes = await encodeVxlScene(liteWorld(), { compression: 'none' });
        const full = await decodeVxlScene(bytes);
        const lite = await decodeVxlScene(bytes, { skipLodLevels: 99 });
        const fullObj = worldSoaToObjects(full);
        const liteObj = worldSoaToObjects(lite);
        for (let i = 0; i < lite.chunks.length; i++) {
            const lc = lite.chunks[i]!;
            const fc = full.chunks[i]!;
            // Voxels preserved even when all but one LOD level is skipped.
            expect(lc.voxels.count).toBe(fc.voxels.count);
            expect(liteObj[i]!.voxels).toEqual(fullObj[i]!.voxels);
            expect(lc.lodHints.length).toBe(1);
            // The single kept level is the coarsest (last) level of the full decode.
            expect(liteObj[i]!.lodHints[0]).toEqual(fullObj[i]!.lodHints[fc.lodHints.length - 1]);
        }
        // lodDistances clamps to its last entry so it stays length ≥ 1.
        expect(lite.lodDistances).toEqual([200]);
    });

    it('lite decode keeps a baked per-chunk trimesh', async () => {
        const w = liteWorld();
        w.chunks[0]!.namedTrimeshes = [{
            name: 'road',
            verts: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]),
            indices: new Uint32Array([0, 1, 2]),
        }];
        const bytes = await encodeVxlScene(w, { compression: 'none' });
        const full = await decodeVxlScene(bytes);
        const lite = await decodeVxlScene(bytes, { skipLodLevels: 1 });
        expect(lite.chunks[0]!.namedTrimeshes.length).toBe(1);
        expect(lite.chunks[0]!.namedTrimeshes[0]!.name).toBe('road');
        expect(Array.from(lite.chunks[0]!.namedTrimeshes[0]!.indices)).toEqual([0, 1, 2]);
        // Per-voxel columns are preserved by the lite decode (smooth surface intact).
        expect(lite.chunks[0]!.voxels.count).toBe(full.chunks[0]!.voxels.count);
    });
});

describe('VxlScene streaming encoder', () => {
    // A world with several chunks and distinct colors per chunk, so the incremental
    // world palette must grow across addChunk calls (the case the streaming encoder
    // exists to handle: indices assigned to early chunks stay valid as it grows).
    function streamWorld(): VxlSceneWorld {
        const mkChunk = (cx: number, tint: number): VxlSceneChunk => ({
            cx, cy: 0, cz: 0,
            voxels: [
                { gx: 0, gy: 0, gz: 0, sizeLevel: 0, color: { r: tint, g: 0, b: 0 }, noCollider: false, disp: null },
                { gx: 1, gy: 0, gz: 0, sizeLevel: 2, color: { r: 0, g: tint, b: 0.5 }, noCollider: true,
                  disp: { dx: 1, dy: -2, dz: 3 } },
            ],
            lodHints: [
                [{ gx: 0, gy: 1, gz: 0, w: 1, h: 1, axis: 1, dir: 1, color: { r: 0, g: 0, b: tint }, disp: 0 }],
                [{ gx: 0, gy: 1, gz: 0, w: 2, h: 2, axis: 1, dir: 1, color: { r: tint, g: tint, b: tint }, disp: 0 }],
            ],
            namedTrimeshes: cx === 1
                ? [{ name: 'road', verts: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]), indices: new Uint32Array([0, 1, 2]) }]
                : [],
        });
        return {
            chunkSize: 16, minVoxelSize: 0.25,
            bounds: { minX: 0, minY: 0, minZ: 0, maxX: 48, maxY: 16, maxZ: 16 },
            lodDistances: [40, 100],
            // Distinct tints → a palette that grows chunk by chunk.
            chunks: [mkChunk(0, 0.1), mkChunk(1, 0.4), mkChunk(2, 0.7)],
        };
    }

    it('addChunk + finish decodes to the same chunks as one-shot encodeVxlScene', async () => {
        const w = streamWorld();

        // Reference: the existing one-shot encoder.
        const oneShot = await encodeVxlScene(w, { compression: 'none' });
        const oneShotBack = await decodeVxlScene(oneShot);

        // Streaming: feed each chunk, then finish — the encoder must never need the
        // whole world at once.
        const enc = createVxlSceneEncoder(
            { chunkSize: w.chunkSize, minVoxelSize: w.minVoxelSize, bounds: w.bounds, lodDistances: w.lodDistances },
            { compression: 'none' },
        );
        for (const c of w.chunks) await enc.addChunk(c);
        const streamed = await enc.finish();
        const streamedBack = await decodeVxlScene(streamed);

        expect(isVxlScene(streamed.buffer)).toBe(true);
        // World-level metadata round-trips.
        expect(streamedBack.chunkSize).toBe(w.chunkSize);
        expect(streamedBack.minVoxelSize).toBeCloseTo(w.minVoxelSize);
        expect(streamedBack.lodDistances).toEqual(w.lodDistances);
        expect(streamedBack.bounds).toEqual(w.bounds);

        // Both encoders decode to identical geometry (the load-bearing equivalence).
        expectChunksEqual(streamedBack, oneShotBack);
    });

    it('streaming encode is deterministic (identical bytes across runs)', async () => {
        const w = streamWorld();
        const run = async (): Promise<Uint8Array> => {
            const enc = createVxlSceneEncoder(
                { chunkSize: w.chunkSize, minVoxelSize: w.minVoxelSize, bounds: w.bounds, lodDistances: w.lodDistances },
                { compression: 'none' },
            );
            for (const c of w.chunks) await enc.addChunk(c);
            return enc.finish();
        };
        expect(Buffer.from(await run())).toEqual(Buffer.from(await run()));
    });

    it('round-trips a palette that grows past 256 colors across chunks (2-byte indices)', async () => {
        // 300 chunks, each with a unique color → palette > 256. The streaming encoder
        // must keep early-chunk indices valid (always 2-byte), and the decoder must
        // read that width from the explicit header byte.
        const chunks: VxlSceneChunk[] = [];
        for (let i = 0; i < 300; i++) {
            chunks.push({
                cx: i, cy: 0, cz: 0,
                voxels: [{ gx: 0, gy: 0, gz: 0, sizeLevel: 0, color: { r: i / 300, g: 0, b: 0 }, noCollider: false, disp: null }],
                lodHints: [[]],
                namedTrimeshes: [],
            });
        }
        const w: VxlSceneWorld = {
            chunkSize: 1, minVoxelSize: 0.5,
            bounds: { minX: 0, minY: 0, minZ: 0, maxX: 300, maxY: 1, maxZ: 1 },
            lodDistances: [50], chunks,
        };
        const enc = createVxlSceneEncoder(
            { chunkSize: w.chunkSize, minVoxelSize: w.minVoxelSize, bounds: w.bounds, lodDistances: w.lodDistances },
            { compression: 'none' },
        );
        for (const c of w.chunks) await enc.addChunk(c);
        const back = await decodeVxlScene(await enc.finish());
        expect(back.chunks).toHaveLength(300);
        // First and last chunk colors survive (early index still valid after growth).
        const backObj = worldSoaToObjects(back);
        expect(backObj[0]!.voxels[0]!.color.r).toBeCloseTo(0, 2);
        expect(backObj[299]!.voxels[0]!.color.r).toBeCloseTo(299 / 300, 2);
    });
});

describe('VxlScene v7 emissive palette', () => {
    // Three distinct colors: red gets a strong emissive strength, green a weaker
    // one, blue none — so a "non-emissive cell reads 0" case is covered alongside
    // the emissive ones.
    const RED_CELL = rgb888ToAtlasCell(255, 0, 0);
    const GREEN_CELL = rgb888ToAtlasCell(0, 255, 0);
    const BLUE_CELL = rgb888ToAtlasCell(0, 0, 255);

    function emissiveTestWorld(): VxlSceneWorld {
        return {
            chunkSize: 16, minVoxelSize: 0.5,
            bounds: { minX: 0, minY: 0, minZ: 0, maxX: 16, maxY: 16, maxZ: 16 },
            lodDistances: [50],
            chunks: [{
                cx: 0, cy: 0, cz: 0,
                voxels: [
                    { gx: 0, gy: 0, gz: 0, sizeLevel: 0, color: { r: 1, g: 0, b: 0 }, noCollider: false, disp: null }, // rune inlay
                    { gx: 1, gy: 0, gz: 0, sizeLevel: 0, color: { r: 0, g: 1, b: 0 }, noCollider: false, disp: null }, // crystal vein
                    { gx: 2, gy: 0, gz: 0, sizeLevel: 0, color: { r: 0, g: 0, b: 1 }, noCollider: false, disp: null }, // non-emissive
                ],
                lodHints: [[]],
                namedTrimeshes: [],
            }],
        };
    }

    it('round-trips an emissive palette, expanding per-palette-entry strengths into a 4096-cell LUT', async () => {
        const w = emissiveTestWorld();
        w.emissiveByCell = new Map([[RED_CELL, 200], [GREEN_CELL, 80]]);
        const bytes = await encodeVxlScene(w, { compression: 'none' });
        expect(bytes[4]).toBe(7);
        const back = await decodeVxlScene(bytes);
        expect(back.emissiveByCell).not.toBeNull();
        const lut = back.emissiveByCell!;
        expect(lut.length).toBe(4096);
        expect(lut[RED_CELL]).toBe(200);
        expect(lut[GREEN_CELL]).toBe(80);
        expect(lut[BLUE_CELL]).toBe(0); // present in content, absent from the map
        // Geometry is unaffected by the new section.
        expect(back.chunks[0]!.voxels.count).toBe(3);
    });

    it('an explicit all-zero emissive map encodes identically to no map at all (writes only the flag byte)', async () => {
        const plain = emissiveTestWorld();
        const zeroed = emissiveTestWorld();
        zeroed.emissiveByCell = new Map([[RED_CELL, 0], [GREEN_CELL, 0]]);
        const bytesPlain = await encodeVxlScene(plain, { compression: 'none' });
        const bytesZeroed = await encodeVxlScene(zeroed, { compression: 'none' });
        expect(Buffer.from(bytesZeroed)).toEqual(Buffer.from(bytesPlain));
    });

    it('a v6 file (no emissive section at all) decodes with emissiveByCell null; the all-zero v7 encode is byte-identical past the version field and the 1-byte flag', async () => {
        const w = emissiveTestWorld(); // no emissiveByCell set
        const bytes = await encodeVxlScene(w, { compression: 'none' });
        expect(bytes[4]).toBe(7);

        // Locate the v7 hasEmissivePalette flag byte by walking the header exactly
        // like the encoder does: wrapper(6) + header(8+24) + lod + name table +
        // v4 palette block + v6 hasGroundMask flag (1 byte, no mask here).
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let cur = 6 + 8 + 24;
        const lodCount = view.getUint16(cur, true); cur += 2 + lodCount * 4;
        const nameCount = view.getUint16(cur, true); cur += 2;
        for (let i = 0; i < nameCount; i++) { const len = view.getUint16(cur, true); cur += 2 + len; }
        cur += 1 + 1; // coordsBytes + paletteIdxBytes
        const paletteCount = view.getUint16(cur, true); cur += 2 + paletteCount * 2;
        cur += 1; // v6 hasGroundMask flag (0 — no mask bytes follow)
        // cur now points at the v7 flag byte. The all-zero/no-map case must write
        // ONLY this one zero byte — no per-palette-entry array.
        expect(bytes[cur]).toBe(0);

        // Splice that single byte out and stamp the version back to 6, reproducing
        // an actual pre-v7 file's exact byte layout (identical to `bytes` save for
        // the version field and this one flag byte).
        const v6Equivalent = new Uint8Array(bytes.length - 1);
        v6Equivalent.set(bytes.subarray(0, cur), 0);
        v6Equivalent.set(bytes.subarray(cur + 1), cur);
        v6Equivalent[4] = 6;

        const decoded = await decodeVxlScene(v6Equivalent);
        expect(decoded.emissiveByCell ?? null).toBeNull();
        expect(decoded.chunks[0]!.voxels.count).toBe(3);
        expect(decoded.chunks[0]!.voxels.colorIdx[0]).toBe(RED_CELL);
    });

    it('when two palette entries map to the same cell (not reachable via this encoder), the higher strength wins', async () => {
        // Hand-build a minimal, valid v7 buffer: 0 chunks, no LOD distances, no
        // trimesh names, 1-byte coords/palette-idx width, and a 2-entry palette
        // where BOTH entries resolve to the SAME atlas cell. `encodeVxlScene`'s
        // `cellToIdx` Map de-dupes cells to one index each, so this shape can only
        // arise from a hand-crafted or foreign-tool file — exactly what this test
        // exercises: the decoder's defensive "higher strength wins" rule.
        const cell = rgb888ToAtlasCell(10, 20, 30);
        const palette = [cell, cell];
        const emissiveStrengths = [50, 180];

        const size = 6 // wrapper
            + 4 + 4 + 24 + 2 // chunkSize, minVoxelSize, bounds, lodCount(0)
            + 2 // nameCount(0)
            + 1 + 1 + 2 + palette.length * 2 // palette block
            + 1 // hasGroundMask(0)
            + 1 + emissiveStrengths.length // hasEmissivePalette(1) + strengths
            + 4; // chunkCount(0)
        const out = new Uint8Array(size);
        const view = new DataView(out.buffer);
        view.setUint32(0, VXLSCENE_MAGIC, true);
        out[4] = 7; out[5] = 0;
        let cur = 6;
        view.setFloat32(cur, 16, true); cur += 4; // chunkSize
        view.setFloat32(cur, 0.5, true); cur += 4; // minVoxelSize
        for (let i = 0; i < 6; i++) { view.setFloat32(cur, 0, true); cur += 4; } // bounds
        view.setUint16(cur, 0, true); cur += 2; // lodCount
        view.setUint16(cur, 0, true); cur += 2; // trimesh name count
        out[cur] = 1; cur += 1; // coordsBytes
        out[cur] = 1; cur += 1; // paletteIdxBytes
        view.setUint16(cur, palette.length, true); cur += 2;
        for (const c of palette) { view.setUint16(cur, c, true); cur += 2; }
        out[cur] = 0; cur += 1; // hasGroundMask
        out[cur] = 1; cur += 1; // hasEmissivePalette
        for (const s of emissiveStrengths) { out[cur] = s; cur += 1; }
        view.setUint32(cur, 0, true); cur += 4; // chunkCount

        const decoded = await decodeVxlScene(out);
        expect(decoded.emissiveByCell).not.toBeNull();
        expect(decoded.emissiveByCell![cell]).toBe(180); // max(50, 180)
        expect(decoded.chunks).toHaveLength(0);
    });
});
