/** @jest-environment jsdom */
import * as THREE from 'three';
import {
    deriveEmissiveAttribute, buildCellByPaletteUv, deriveEmissiveFromUv,
} from 'engine/vxlscene/emissiveAttribute.js';
import { VxlSceneRenderer } from 'engine/vxlscene/VxlSceneRenderer.js';
import { isVoxelEmissiveMaterial } from 'engine/VoxelEmissiveMaterial.js';
import { ATLAS_CELL_COUNT } from 'engine/vxlscene/atlasColor.js';
import type {
    DecodedVxlSceneWorld, DecodedChunk, DecodedChunkQuads, DecodedChunkVoxels,
} from 'engine/vxlscene/VxlSceneFormat.js';

/** An arbitrary 12-bit atlas cell used as "the glowing colour" throughout. */
const GLOW_CELL = 42;
/** A second cell that carries no emissive strength. */
const DARK_CELL = 7;

describe('deriveEmissiveAttribute (pure)', () => {
    const lut = (): Uint8Array => {
        const l = new Uint8Array(ATLAS_CELL_COUNT);
        l[GLOW_CELL] = 255;
        l[DARK_CELL] = 0;
        l[9] = 51; // 51/255 = 0.2
        return l;
    };

    it('emits one float per vertex: strength/255 replicated across the quad', () => {
        const cells = new Uint16Array([GLOW_CELL, DARK_CELL, 9]);
        const out = deriveEmissiveAttribute(cells, 4, lut(), 0);
        expect(out.length).toBe(3 * 4);
        expect(Array.from(out.slice(0, 4))).toEqual([1, 1, 1, 1]);
        expect(Array.from(out.slice(4, 8))).toEqual([0, 0, 0, 0]);
        for (const v of out.slice(8, 12)) expect(v).toBeCloseTo(0.2, 6);
    });

    it('honours vertsPerQuad other than 4', () => {
        const out = deriveEmissiveAttribute(new Uint16Array([GLOW_CELL]), 6, lut(), 0);
        expect(out.length).toBe(6);
        expect(Array.from(out)).toEqual([1, 1, 1, 1, 1, 1]);
    });

    it('is ALL ZEROS for any lod > 0 (the caller passes 0 for the near representation)', () => {
        const cells = new Uint16Array([GLOW_CELL, GLOW_CELL]);
        for (const lod of [1, 2, 3]) {
            const out = deriveEmissiveAttribute(cells, 4, lut(), lod);
            expect(out.length).toBe(2 * 4);            // layout is still uniform...
            expect(out.some(v => v !== 0)).toBe(false); // ...but carries no glow
        }
    });

    it('returns an empty array for an empty quad column', () => {
        expect(deriveEmissiveAttribute(new Uint16Array(0), 4, lut(), 0).length).toBe(0);
    });

    it('treats a cell outside the LUT as non-emissive', () => {
        const short = new Uint8Array(8); // shorter than the cell index used below
        const out = deriveEmissiveAttribute(new Uint16Array([4000]), 4, short, 0);
        expect(Array.from(out)).toEqual([0, 0, 0, 0]);
    });

    it('accepts a plain number[] column', () => {
        const out = deriveEmissiveAttribute([GLOW_CELL], 4, lut(), 0);
        expect(Array.from(out)).toEqual([1, 1, 1, 1]);
    });
});

describe('buildCellByPaletteUv / deriveEmissiveFromUv (pure, surface path)', () => {
    /** A 3-cell stand-in for the renderer's fixed RGB444→atlas-UV table. */
    const paletteUV = new Float32Array([
        0.10, 0.20, // cell 0
        0.30, 0.40, // cell 1
        0.10, 0.40, // cell 2 — shares u with cell 0 and v with cell 1
    ]);

    /** The unorm16 quantization `SurfaceMeshBuilder` writes into its `uv` attribute. */
    const pack = (v: number): number => Math.round(v * 65535);

    it('inverts the palette table into QUANTIZED keys, including shared u / shared v rows', () => {
        const byUv = buildCellByPaletteUv(paletteUV);
        expect(byUv.get(pack(paletteUV[0]!))!.get(pack(paletteUV[1]!))).toBe(0);
        expect(byUv.get(pack(paletteUV[2]!))!.get(pack(paletteUV[3]!))).toBe(1);
        expect(byUv.get(pack(paletteUV[4]!))!.get(pack(paletteUV[5]!))).toBe(2);
        // The raw float is NOT a key — the surface attribute never carries it.
        expect(byUv.get(paletteUV[0]!)).toBeUndefined();
    });

    it('resolves per-vertex emissive from welded surface UVs', () => {
        const lut = new Uint8Array(ATLAS_CELL_COUNT);
        lut[1] = 255;
        lut[2] = 51;
        // Three vertices: cell 0 (dark), cell 1 (full), cell 2 (0.2) — packed exactly
        // as the surface builder emits them.
        const uvs = new Uint16Array([
            pack(paletteUV[0]!), pack(paletteUV[1]!),
            pack(paletteUV[2]!), pack(paletteUV[3]!),
            pack(paletteUV[4]!), pack(paletteUV[5]!),
        ]);
        const out = deriveEmissiveFromUv(uvs, 3, buildCellByPaletteUv(paletteUV), lut);
        expect(out.length).toBe(3);
        expect(out[0]).toBe(0);
        expect(out[1]).toBe(1);
        expect(out[2]).toBeCloseTo(0.2, 6);
    });

    it('yields 0 for a UV that is not a palette entry', () => {
        const lut = new Uint8Array(ATLAS_CELL_COUNT).fill(255);
        const out = deriveEmissiveFromUv(new Uint16Array([pack(0.9), pack(0.9)]), 1, buildCellByPaletteUv(paletteUV), lut);
        expect(Array.from(out)).toEqual([0]);
    });
});

// ── Renderer wiring ─────────────────────────────────────────────────────────────

/** +Y quads (axis=1, dir=+1, w=h=1) at ascending X, all offset 0, all `cell`-coloured. */
function quads(n: number, cell: number): DecodedChunkQuads {
    const gx = new Uint16Array(n), gy = new Uint16Array(n), gz = new Uint16Array(n);
    const w = new Uint16Array(n).fill(1), h = new Uint16Array(n).fill(1);
    const axisDir = new Uint8Array(n).fill(1 & 0x3);
    const colorIdx = new Uint16Array(n).fill(cell);
    const disp = new Int8Array(n);
    for (let i = 0; i < n; i++) gx[i] = i * 2;
    return { count: n, gx, gy, gz, w, h, axisDir, colorIdx, disp };
}

function emptyVoxels(): DecodedChunkVoxels {
    return {
        count: 0, gx: new Uint16Array(0), gy: new Uint16Array(0), gz: new Uint16Array(0),
        sizeLevel: new Uint8Array(0), colorIdx: new Uint16Array(0), flags: new Uint8Array(0), disp: null,
    };
}

/** One displaced voxel (flags bit1) of colour `cell` — creates the smooth-surface batch. */
function displacedVoxel(cell: number): DecodedChunkVoxels {
    return {
        count: 1,
        gx: new Uint16Array([4]), gy: new Uint16Array([0]), gz: new Uint16Array([0]),
        sizeLevel: new Uint8Array([0]), colorIdx: new Uint16Array([cell]),
        flags: new Uint8Array([2]),
        disp: new Int8Array([0, 64, 0]),
    };
}

function world(chunks: DecodedChunk[], emissiveByCell: Uint8Array | null): DecodedVxlSceneWorld {
    return {
        chunkSize: 16, minVoxelSize: 1,
        bounds: { minX: 0, minY: 0, minZ: 0, maxX: 32, maxY: 16, maxZ: 16 },
        lodDistances: [50],
        chunks,
        emissiveByCell,
    };
}

function glowLut(): Uint8Array {
    const l = new Uint8Array(ATLAS_CELL_COUNT);
    l[GLOW_CELL] = 255;
    return l;
}

/** Every bias-step BatchedMesh (excludes the smooth-surface batch). */
function batches(r: VxlSceneRenderer): THREE.BatchedMesh[] {
    return r.group.children.filter((c): c is THREE.BatchedMesh =>
        (c as THREE.BatchedMesh).isBatchedMesh === true && c.name !== 'smoothSurface');
}

/** Bias-step batches ascending by depth bias (≈ ascending step b = offset + lod). */
function stepSorted(r: VxlSceneRenderer): THREE.BatchedMesh[] {
    return batches(r).sort((a, b) => a.material.polygonOffsetUnits - b.material.polygonOffsetUnits);
}

function surfaceBatch(r: VxlSceneRenderer): THREE.BatchedMesh | null {
    return r.group.children.find((c): c is THREE.BatchedMesh =>
        (c as THREE.BatchedMesh).isBatchedMesh === true && c.name === 'smoothSurface') ?? null;
}

function emissiveAttr(b: THREE.BatchedMesh): THREE.BufferAttribute | null {
    const a = b.geometry.getAttribute('emissive');
    return a ? (a as THREE.BufferAttribute) : null;
}

describe('VxlSceneRenderer emissive wiring — world WITHOUT an emissive LUT', () => {
    const plain = (): DecodedChunk => ({
        cx: 0, cy: 0, cz: 0,
        voxels: displacedVoxel(GLOW_CELL),
        lodHints: [quads(2, GLOW_CELL)],
        namedTrimeshes: [],
    });

    it('adds NO emissive attribute and keeps the plain shared materials', () => {
        const r = new VxlSceneRenderer(world([plain()], null));
        const all = [...batches(r), surfaceBatch(r)!];
        expect(all.length).toBe(2);
        for (const b of all) {
            expect(emissiveAttr(b)).toBeNull();
            expect(isVoxelEmissiveMaterial(b.material)).toBe(false);
        }
        r.dispose();
    });

    it('is unaffected by an ABSENT emissiveByCell field (older decoded worlds)', () => {
        const w = world([plain()], null);
        delete w.emissiveByCell;
        const r = new VxlSceneRenderer(w);
        for (const b of [...batches(r), surfaceBatch(r)!]) expect(emissiveAttr(b)).toBeNull();
        r.dispose();
    });
});

describe('VxlSceneRenderer emissive wiring — world WITH an emissive LUT', () => {
    it('gives every batch geometry a per-vertex emissive attribute and an emissive material', () => {
        const c: DecodedChunk = {
            cx: 0, cy: 0, cz: 0,
            voxels: emptyVoxels(),
            lodHints: [quads(2, GLOW_CELL)],
            namedTrimeshes: [],
        };
        const r = new VxlSceneRenderer(world([c], glowLut()));
        const bs = batches(r);
        expect(bs.length).toBe(1);
        const attr = emissiveAttr(bs[0]!)!;
        expect(attr).not.toBeNull();
        expect(attr.itemSize).toBe(1);
        expect(attr.count).toBe((bs[0]!.geometry.getAttribute('position') as THREE.BufferAttribute).count);
        expect(Array.from(attr.array as Float32Array)).toEqual(new Array(8).fill(1)); // 2 quads × 4 verts
        expect(isVoxelEmissiveMaterial(bs[0]!.material)).toBe(true);
        r.dispose();
    });

    it('leaves non-emissive cells at zero within the SAME batch', () => {
        // Two chunks in one bias step: one glowing, one dark. The shared batch must carry
        // both (uniform attribute layout) with the dark chunk's vertices at 0.
        const glow: DecodedChunk = {
            cx: 0, cy: 0, cz: 0, voxels: emptyVoxels(),
            lodHints: [quads(1, GLOW_CELL)], namedTrimeshes: [],
        };
        const dark: DecodedChunk = {
            cx: 1, cy: 0, cz: 0, voxels: emptyVoxels(),
            lodHints: [quads(1, DARK_CELL)], namedTrimeshes: [],
        };
        const r = new VxlSceneRenderer(world([glow, dark], glowLut()));
        const arr = Array.from(emissiveAttr(batches(r)[0]!)!.array as Float32Array);
        expect(arr.length).toBe(8);
        expect(arr.filter(v => v === 1).length).toBe(4);
        expect(arr.filter(v => v === 0).length).toBe(4);
        r.dispose();
    });

    it('ZEROES the attribute on a level COARSER than the offset group\'s finest kept one', () => {
        // The offset-0 group exists at both levels: LOD0 → step 0 (glows), LOD1 → step 1
        // (the coarse stand-in, must stay dark so only the near representation glows).
        const c: DecodedChunk = {
            cx: 0, cy: 0, cz: 0, voxels: emptyVoxels(),
            lodHints: [quads(1, GLOW_CELL), quads(1, GLOW_CELL)],
            namedTrimeshes: [],
        };
        const r = new VxlSceneRenderer(world([c], glowLut()));
        const bs = stepSorted(r);
        expect(bs.length).toBe(2);
        expect(Array.from(emissiveAttr(bs[0]!)!.array as Float32Array).every(v => v === 1)).toBe(true);
        expect((emissiveAttr(bs[1]!)!.array as Float32Array).some(v => v !== 0)).toBe(false);
        r.dispose();
    });

    it('GLOWS on the finest KEPT level when LOD0 was shed for that offset (mobile budget)', () => {
        // `applyEffectiveStepSkip` (mobile min-quad-cell budget) sheds the whole LOD0 offset
        // group: level 0 is empty and the offset first appears at level 1. That level-1
        // instance is backfilled as the NEAR representation, so it MUST glow — zeroing it
        // would leave every forged dungeon rune/crystal dark at all distances on mobile.
        const c: DecodedChunk = {
            cx: 0, cy: 0, cz: 0, voxels: emptyVoxels(),
            lodHints: [quads(0, GLOW_CELL), quads(2, GLOW_CELL)],
            namedTrimeshes: [],
        };
        const r = new VxlSceneRenderer(world([c], glowLut()));
        const bs = batches(r);
        expect(bs.length).toBe(1);                 // only the level-1 (step 1) batch exists
        expect(bs[0]!.getVisibleAt(0)).toBe(true); // ...and it IS the near-LOD representation
        expect(Array.from(emissiveAttr(bs[0]!)!.array as Float32Array)).toEqual(new Array(8).fill(1));
        r.dispose();
    });

    it('gives the smooth-surface batch the same emissive attribute + material', () => {
        const c: DecodedChunk = {
            cx: 0, cy: 0, cz: 0,
            voxels: displacedVoxel(GLOW_CELL),
            lodHints: [quads(0, GLOW_CELL)],
            namedTrimeshes: [],
        };
        const r = new VxlSceneRenderer(world([c], glowLut()));
        const sb = surfaceBatch(r)!;
        expect(sb).not.toBeNull();
        const attr = emissiveAttr(sb)!;
        expect(attr).not.toBeNull();
        expect(attr.count).toBe((sb.geometry.getAttribute('position') as THREE.BufferAttribute).count);
        expect(Array.from(attr.array as Float32Array).every(v => v === 1)).toBe(true);
        expect(isVoxelEmissiveMaterial(sb.material)).toBe(true);
        r.dispose();
    });

    it('keeps the smooth surface dark when its colour carries no emissive strength', () => {
        const c: DecodedChunk = {
            cx: 0, cy: 0, cz: 0,
            voxels: displacedVoxel(DARK_CELL),
            lodHints: [quads(0, GLOW_CELL)],
            namedTrimeshes: [],
        };
        const r = new VxlSceneRenderer(world([c], glowLut()));
        const arr = emissiveAttr(surfaceBatch(r)!)!.array as Float32Array;
        expect(arr.length).toBeGreaterThan(0);
        expect(arr.some(v => v !== 0)).toBe(false);
        r.dispose();
    });

    it('survives a setChunkHints rebuild with the attribute intact', () => {
        const c: DecodedChunk = {
            cx: 0, cy: 0, cz: 0, voxels: emptyVoxels(),
            lodHints: [quads(1, GLOW_CELL)], namedTrimeshes: [],
        };
        const r = new VxlSceneRenderer(world([c], glowLut()));
        r.setChunkHints(0, 0, 0, [quads(3, GLOW_CELL)]);
        const attr = emissiveAttr(batches(r)[0]!)!;
        expect(attr).not.toBeNull();
        expect(Array.from(attr.array as Float32Array)).toEqual(new Array(12).fill(1));
        r.dispose();
    });
});
