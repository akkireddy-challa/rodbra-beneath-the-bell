/** @jest-environment jsdom */
import { TextEncoder, TextDecoder } from 'util';
// jsdom lacks TextEncoder/TextDecoder; the format's name tables use them.
if (typeof globalThis.TextEncoder === 'undefined') {
    (globalThis as unknown as { TextEncoder: typeof TextEncoder }).TextEncoder = TextEncoder;
}
if (typeof globalThis.TextDecoder === 'undefined') {
    (globalThis as unknown as { TextDecoder: typeof TextDecoder }).TextDecoder = TextDecoder;
}
import * as THREE from 'three';
import {
    encodeVxlScene, decodeVxlScene,
    type VxlSceneWorld, type DecodedVxlSceneWorld, type DecodedChunk, type DecodedChunkQuads, type DecodedChunkVoxels,
} from 'engine/vxlscene/VxlSceneFormat.js';
import { VxlSceneRenderer } from 'engine/vxlscene/VxlSceneRenderer.js';
import { rgb888ToAtlasCell } from 'engine/vxlscene/atlasColor.js';

/**
 * v9 material classes end to end: the format round-trips the class section (and
 * unclassified bakes stay byte-identical v7), and the renderer splits its batch key
 * per class, picks the class's lighting tier, clamps it by quality, and partitions
 * the smooth surface — while a matte world builds exactly today's batches.
 */

// ── Format ──────────────────────────────────────────────────────────────────

const RED = { r: 1, g: 0, b: 0 };
const RED_CELL = rgb888ToAtlasCell(255, 0, 0);

function objWorld(materialClassByCell?: Map<number, string> | null): VxlSceneWorld {
    return {
        chunkSize: 16, minVoxelSize: 0.5,
        bounds: { minX: 0, minY: 0, minZ: 0, maxX: 16, maxY: 16, maxZ: 16 },
        lodDistances: [50],
        chunks: [{
            cx: 0, cy: 0, cz: 0,
            voxels: [],
            lodHints: [[{ gx: 0, gy: 1, gz: 0, w: 2, h: 1, axis: 1, dir: 1, color: RED, disp: 0 }]],
            namedTrimeshes: [],
        }],
        ...(materialClassByCell !== undefined ? { materialClassByCell } : {}),
    };
}

describe('VxlScene v9 material-class section', () => {
    it('round-trips the class name table and the per-cell LUT', async () => {
        const bytes = await encodeVxlScene(objWorld(new Map([[RED_CELL, 'stone']])), { compression: 'none' });
        expect(bytes[4]).toBe(9);
        const back = await decodeVxlScene(bytes);
        expect(back.materialClassNames).toEqual(['stone']);
        expect(back.materialClassByCell![RED_CELL]).toBe(1);
        // Every other cell stays matte, and the v9 always-written surface step decodes as 1.
        expect(back.materialClassByCell![(RED_CELL + 1) & 0xfff]).toBe(0);
        expect(back.surfaceStep).toBe(1);
    });

    it('an unclassified bake stays byte-identical v7 — absent, null and empty maps alike', async () => {
        const plain = await encodeVxlScene(objWorld(), { compression: 'none' });
        const nulled = await encodeVxlScene(objWorld(null), { compression: 'none' });
        const empty = await encodeVxlScene(objWorld(new Map()), { compression: 'none' });
        expect(plain[4]).toBe(7);
        expect(Buffer.from(nulled)).toEqual(Buffer.from(plain));
        expect(Buffer.from(empty)).toEqual(Buffer.from(plain));
        const back = await decodeVxlScene(plain);
        expect(back.materialClassByCell ?? null).toBeNull();
    });

    it('a class map matching no palette cell emits no section (still v7)', async () => {
        const bytes = await encodeVxlScene(
            objWorld(new Map([[(RED_CELL + 7) & 0xfff, 'stone']])), { compression: 'none' },
        );
        expect(bytes[4]).toBe(7);
    });
});

// ── Renderer ────────────────────────────────────────────────────────────────

const PLAIN_CELL = rgb888ToAtlasCell(255, 255, 255);
const CLASSED_CELL = rgb888ToAtlasCell(122, 122, 114);

function dquads(items: Array<{ pos: [number, number, number]; cell: number }>): DecodedChunkQuads {
    const n = items.length;
    const gx = new Uint16Array(n), gy = new Uint16Array(n), gz = new Uint16Array(n);
    const w = new Uint16Array(n).fill(1), h = new Uint16Array(n).fill(1);
    const axisDir = new Uint8Array(n).fill(1 & 0x3); // axis=1 (Y), dir=+1, offset=0
    const colorIdx = new Uint16Array(n);
    const disp = new Int8Array(n);
    for (let i = 0; i < n; i++) {
        const it = items[i]!;
        gx[i] = it.pos[0]; gy[i] = it.pos[1]; gz[i] = it.pos[2];
        colorIdx[i] = it.cell;
    }
    return { count: n, gx, gy, gz, w, h, axisDir, colorIdx, disp };
}

function emptyVoxels(): DecodedChunkVoxels {
    return {
        count: 0, gx: new Uint16Array(0), gy: new Uint16Array(0), gz: new Uint16Array(0),
        sizeLevel: new Uint8Array(0), colorIdx: new Uint16Array(0), flags: new Uint8Array(0), disp: null,
    };
}

/** One displaced (smooth:y) voxel of the given colour cell — feeds the surface batch. */
function displacedVoxel(cell: number): DecodedChunkVoxels {
    return {
        count: 1,
        gx: new Uint16Array([4]), gy: new Uint16Array([0]), gz: new Uint16Array([0]),
        sizeLevel: new Uint8Array([0]), colorIdx: new Uint16Array([cell]),
        flags: new Uint8Array([2]),
        disp: new Int8Array([0, 64, 0]),
    };
}

function dchunk(lodLevels: DecodedChunkQuads[], voxels: DecodedChunkVoxels = emptyVoxels()): DecodedChunk {
    return { cx: 0, cy: 0, cz: 0, voxels, lodHints: lodLevels, namedTrimeshes: [] };
}

function lutWith(entries: Array<[number, number]>): Uint8Array {
    const lut = new Uint8Array(4096);
    for (const [cell, idx] of entries) lut[cell] = idx;
    return lut;
}

function dworld(chunks: DecodedChunk[], lut: Uint8Array | null, names: string[] | null): DecodedVxlSceneWorld {
    return {
        chunkSize: 16, minVoxelSize: 1,
        bounds: { minX: 0, minY: 0, minZ: 0, maxX: 16, maxY: 16, maxZ: 16 },
        lodDistances: [50],
        chunks, surfaceStep: 1,
        materialClassByCell: lut, materialClassNames: names,
    };
}

function terrainBatches(r: VxlSceneRenderer): THREE.BatchedMesh[] {
    return r.group.children.filter((c): c is THREE.BatchedMesh =>
        (c as THREE.BatchedMesh).isBatchedMesh === true && !c.name.startsWith('smoothSurface'));
}

function surfaceBatchNamed(r: VxlSceneRenderer, name: string): THREE.BatchedMesh | null {
    return (r.group.children.find((c) =>
        (c as THREE.BatchedMesh).isBatchedMesh === true && c.name === name) as THREE.BatchedMesh | undefined) ?? null;
}

function totalVisible(r: VxlSceneRenderer): number {
    let n = 0;
    for (const b of terrainBatches(r)) {
        for (let i = 0; i < b.instanceCount; i++) if (b.getVisibleAt(i)) n++;
    }
    return n;
}

const isPhong = (m: THREE.Material): boolean => (m as THREE.MeshPhongMaterial).isMeshPhongMaterial === true;
const isPhysical = (m: THREE.Material): boolean => (m as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial === true;

describe('VxlSceneRenderer material-class batch split', () => {
    const mixedChunk = (): DecodedChunk => dchunk([dquads([
        { pos: [0, 0, 0], cell: PLAIN_CELL },
        { pos: [2, 0, 0], cell: CLASSED_CELL },
    ])]);

    it('splits one bias step into a matte batch and a classed batch on its lighting tier', () => {
        const r = new VxlSceneRenderer(dworld([mixedChunk()], lutWith([[CLASSED_CELL, 1]]), ['stone']));
        const bs = terrainBatches(r);
        expect(bs.length).toBe(2);
        const mats = bs.map(b => b.material as THREE.Material);
        expect(mats.filter(isPhong).length).toBe(1);   // stone = 'direct' tier
        expect(mats.filter(m => !isPhong(m) && !isPhysical(m)).length).toBe(1); // matte Lambert
        for (const b of bs) expect(b.instanceCount).toBe(1);
        r.dispose();
    });

    it("an 'environment' class is Physical at high, Phong at medium, and unsplit Lambert at low", () => {
        const w = (): DecodedVxlSceneWorld => dworld([mixedChunk()], lutWith([[CLASSED_CELL, 1]]), ['gold']);

        const high = new VxlSceneRenderer(w(), { surfaceStep: 1, materialQuality: 'high' });
        expect(terrainBatches(high).map(b => b.material as THREE.Material).filter(isPhysical).length).toBe(1);
        high.dispose();

        const medium = new VxlSceneRenderer(w(), { surfaceStep: 1, materialQuality: 'medium' });
        const mediumMats = terrainBatches(medium).map(b => b.material as THREE.Material);
        expect(mediumMats.filter(isPhysical).length).toBe(0);
        expect(mediumMats.filter(isPhong).length).toBe(1);
        medium.dispose();

        // 'low' skips the split entirely: one batch, plain Lambert — today's rendering.
        const low = new VxlSceneRenderer(w(), { surfaceStep: 1, materialQuality: 'low' });
        const lowBatches = terrainBatches(low);
        expect(lowBatches.length).toBe(1);
        expect(isPhong(lowBatches[0]!.material as THREE.Material)).toBe(false);
        expect(isPhysical(lowBatches[0]!.material as THREE.Material)).toBe(false);
        low.dispose();
    });

    it('a class LUT that assigns nothing builds exactly the single batch of an unclassified world', () => {
        const r = new VxlSceneRenderer(dworld([mixedChunk()], lutWith([]), ['stone']));
        expect(terrainBatches(r).length).toBe(1);
        r.dispose();
    });

    it('LOD switching keeps exactly one level visible per (offset, class) group', () => {
        const c = dchunk([
            dquads([{ pos: [0, 0, 0], cell: PLAIN_CELL }, { pos: [2, 0, 0], cell: CLASSED_CELL }]),
            dquads([{ pos: [0, 0, 0], cell: PLAIN_CELL }, { pos: [2, 0, 0], cell: CLASSED_CELL }]),
        ]);
        const r = new VxlSceneRenderer(dworld([c], lutWith([[CLASSED_CELL, 1]]), ['stone']));
        expect(totalVisible(r)).toBe(2); // one matte + one classed instance at LOD0
        r.updateLod(new THREE.Vector3(1000, 0, 0));
        expect(totalVisible(r)).toBe(2); // still one per group at LOD1
        r.updateLod(new THREE.Vector3(0, 0, 0));
        expect(totalVisible(r)).toBe(2);
        r.dispose();
    });

    it('partitions the smooth surface into a per-class batch on the class tier', () => {
        const c = dchunk([dquads([])], displacedVoxel(CLASSED_CELL));
        const r = new VxlSceneRenderer(dworld([c], lutWith([[CLASSED_CELL, 1]]), ['stone']));
        const sb = surfaceBatchNamed(r, 'smoothSurface:stone');
        expect(sb).not.toBeNull();
        expect(sb!.instanceCount).toBe(1);
        expect(isPhong(sb!.material as THREE.Material)).toBe(true);
        expect((sb!.material as THREE.MeshPhongMaterial).flatShading).toBe(false);
        // No matte surface batch: every surface column is classed.
        expect(surfaceBatchNamed(r, 'smoothSurface')).toBeNull();
        r.dispose();
    });

    it('an unclassified world still builds the plain matte surface batch', () => {
        const c = dchunk([dquads([])], displacedVoxel(PLAIN_CELL));
        const r = new VxlSceneRenderer(dworld([c], null, null));
        expect(surfaceBatchNamed(r, 'smoothSurface')).not.toBeNull();
        r.dispose();
    });
});
