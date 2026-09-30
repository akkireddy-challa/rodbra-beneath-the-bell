/** @jest-environment jsdom */
/**
 * Pre-baked coarser `.vwld` variants.
 *
 * The property that matters is not "the file is smaller" — it is that a variant is the
 * SAME WORLD at lower detail, with nothing missing. A dropped level that empties a chunk
 * is a hole, and a hole in a racing circuit is a car falling through it, so the clamp that
 * always leaves one level standing is the test worth having.
 */
import {
    dropFinestQuadLods, countChunkQuads, LOD_VARIANT_DROPS,
    decimateChunkSurface, surfaceStepForDrop, coarsenChunkForVariant,
} from 'engine/vxlscene/lodVariants.js';
import { selectVwldUrlForDevice, preferredLodDrop } from 'engine/levels/levelResolve.js';
import type { Asset } from 'types/game.js';
import type { VxlSceneChunk } from 'engine/vxlscene/VxlSceneFormat.js';
import type { SceneQuad } from 'engine/vxlscene/SceneVoxTypes.js';

const quad = (n: number): SceneQuad => ({
    gx: n, gy: 0, gz: 0, sizeLevel: 0, axis: 0, dir: 1, w: 1, h: 1,
    color: { r: 1, g: 0, b: 0 },
} as unknown as SceneQuad);

/** `levels[i]` = how many quads that LOD level holds, finest first. */
function chunkWith(levels: number[]): VxlSceneChunk {
    return {
        cx: 0, cy: 0, cz: 0,
        voxels: [],
        lodHints: levels.map((count) => Array.from({ length: count }, (_, i) => quad(i))),
        namedTrimeshes: [],
    };
}

describe('lod variants', () => {
    it('drops the finest level and keeps the rest, in order', () => {
        const out = dropFinestQuadLods(chunkWith([100, 25, 6]), 1);
        expect(out.lodHints.map(l => l.length)).toEqual([25, 6]);
    });

    it('drops two for the +2 variant', () => {
        const out = dropFinestQuadLods(chunkWith([100, 25, 6]), 2);
        expect(out.lodHints.map(l => l.length)).toEqual([6]);
    });

    it('NEVER empties a chunk — a chunk with no quads is a hole, not coarse detail', () => {
        // Chunks legitimately differ in level count; one holding a single small object may
        // carry only one. Dropping "2" from it must yield its coarsest, not nothing.
        for (const drop of [1, 2, 5]) {
            expect(dropFinestQuadLods(chunkWith([7]), drop).lodHints.map(l => l.length)).toEqual([7]);
        }
        expect(dropFinestQuadLods(chunkWith([9, 3]), 2).lodHints.map(l => l.length)).toEqual([3]);
    });

    it('leaves a chunk untouched at drop 0, and never mutates its input', () => {
        const original = chunkWith([10, 4]);
        expect(dropFinestQuadLods(original, 0)).toBe(original);
        dropFinestQuadLods(original, 1);
        expect(original.lodHints.map(l => l.length)).toEqual([10, 4]);
    });

    it('touches ONLY the quad levels — surface voxels and collider meshes survive', () => {
        // Those two are collision and surface, not detail. Dropping them would change how
        // the level plays rather than how it looks.
        const chunk = chunkWith([10, 4]);
        const withExtras: VxlSceneChunk = {
            ...chunk,
            voxels: [{ gx: 1 } as unknown as VxlSceneChunk['voxels'][number]],
            namedTrimeshes: [{ name: 'ramp' } as unknown as VxlSceneChunk['namedTrimeshes'][number]],
        };
        const out = dropFinestQuadLods(withExtras, 1);
        expect(out.voxels).toBe(withExtras.voxels);
        expect(out.namedTrimeshes).toBe(withExtras.namedTrimeshes);
    });

    it('makes each successive variant strictly smaller', () => {
        const chunk = chunkWith([100, 25, 6]);
        const sizes = [0, ...LOD_VARIANT_DROPS].map(d => countChunkQuads(dropFinestQuadLods(chunk, d)));
        expect(sizes).toEqual([131, 31, 6]);
        for (let i = 1; i < sizes.length; i++) expect(sizes[i]!).toBeLessThan(sizes[i - 1]!);
    });

    it('publishes +1 and +2, in that order', () => {
        // +1 is what mobile already renders at runtime; +2 is the fallback for devices that
        // cannot manage it, and is visibly blockier — so the order is the default first.
        expect([...LOD_VARIANT_DROPS]).toEqual([1, 2]);
    });
});

describe('variant selection', () => {
    const asset = (variants?: Array<{ drop: number; url: string }>): Asset => ({
        id: 'a1', name: 'L', type: 'vwld', url: 'full.vwld',
        ...(variants ? { lodVariants: variants } : {}),
    } as Asset);

    const published = [{ drop: 1, url: 'lod1.vwld' }, { drop: 2, url: 'lod2.vwld' }];

    it('takes the full container on desktop', () => {
        expect(selectVwldUrlForDevice(asset(published), 0)).toBe('full.vwld');
    });

    it('takes the matching variant', () => {
        expect(selectVwldUrlForDevice(asset(published), 1)).toBe('lod1.vwld');
        expect(selectVwldUrlForDevice(asset(published), 2)).toBe('lod2.vwld');
    });

    it('falls back to the full file for a level baked before variants existed', () => {
        // Every level published so far is in this state, so it is the common path, not an
        // edge case — those loads must keep working untouched.
        expect(selectVwldUrlForDevice(asset(), 2)).toBe('full.vwld');
        expect(selectVwldUrlForDevice(asset([]), 1)).toBe('full.vwld');
    });

    it('takes the coarsest AVAILABLE rather than dropping back to full detail', () => {
        // Asking for +2 where only +1 was published should still avoid the full container:
        // the device asked for less detail because it cannot afford more, and handing it
        // the largest file of all would be the worst possible answer.
        expect(selectVwldUrlForDevice(asset([{ drop: 1, url: 'lod1.vwld' }]), 2)).toBe('lod1.vwld');
    });

    it('ignores variants coarser than asked for', () => {
        expect(selectVwldUrlForDevice(asset([{ drop: 3, url: 'lod3.vwld' }]), 1)).toBe('full.vwld');
    });
});

/** A displaced (surface) voxel at chunk-local (gx,gz). */
const surf = (gx: number, gz: number): VxlSceneChunk['voxels'][number] => ({
    gx, gy: 4, gz, sizeLevel: 0, color: { r: 1, g: 1, b: 1 },
    disp: { dx: 0, dy: 3, dz: 0 },
} as unknown as VxlSceneChunk['voxels'][number]);

/** A solid (non-displaced) voxel — not part of the surface. */
const solid = (gx: number, gz: number): VxlSceneChunk['voxels'][number] => ({
    gx, gy: 4, gz, sizeLevel: 0, color: { r: 1, g: 0, b: 0 }, disp: null,
} as unknown as VxlSceneChunk['voxels'][number]);

function chunkAt(cx: number, cz: number, voxels: VxlSceneChunk['voxels']): VxlSceneChunk {
    return { cx, cy: 0, cz, voxels, lodHints: [[quad(0)], [quad(1)]], namedTrimeshes: [] };
}

describe('surface decimation', () => {
    const CELLS = 8; // cells per chunk axis

    it('keeps every step-th column and drops the rest', () => {
        const voxels = [surf(0, 0), surf(1, 0), surf(2, 0), surf(3, 0)];
        const out = decimateChunkSurface(chunkAt(0, 0, voxels), 2, CELLS);
        expect(out.voxels.map(v => v.gx)).toEqual([0, 2]);
    });

    it('aligns on GLOBAL cells so neighbouring chunks agree across a seam', () => {
        // The surface is welded ACROSS chunks. With CELLS=8 and step 4, chunk 1 starts at
        // global 8 — aligned — while a chunk starting at an odd multiple must keep the
        // columns that continue its neighbour's pattern, not restart at its own origin.
        // Getting this wrong tears the ribbon open along the middle of the track.
        const a = decimateChunkSurface(chunkAt(0, 0, [surf(0, 0), surf(4, 0)]), 4, CELLS);
        const b = decimateChunkSurface(chunkAt(1, 0, [surf(0, 0), surf(4, 0)]), 4, CELLS);
        expect(a.voxels.map(v => v.gx)).toEqual([0, 4]);   // global 0, 4
        expect(b.voxels.map(v => v.gx)).toEqual([0, 4]);   // global 8, 12 — same lattice
        // A chunk whose origin is NOT on the lattice keeps only the columns that are.
        const odd = decimateChunkSurface(chunkAt(0, 0, [surf(1, 0), surf(2, 0), surf(3, 0)]), 4, CELLS);
        expect(odd.voxels).toHaveLength(0);
    });

    it('never touches solid voxels, quad levels or collider meshes', () => {
        // Those are collision and blocky geometry — decimating them would change how the
        // level PLAYS, and the whole point is that only the visual surface coarsens.
        const chunk = chunkAt(0, 0, [surf(1, 1), solid(1, 1), solid(3, 3)]);
        const out = decimateChunkSurface(chunk, 2, CELLS);
        expect(out.voxels.filter(v => v.disp === null)).toHaveLength(2);
        expect(out.lodHints).toBe(chunk.lodHints);
        expect(out.namedTrimeshes).toBe(chunk.namedTrimeshes);
    });

    it('is a no-op at step 1, returning the same object', () => {
        const chunk = chunkAt(0, 0, [surf(1, 1)]);
        expect(decimateChunkSurface(chunk, 1, CELLS)).toBe(chunk);
    });

    it('maps drops to doubling steps', () => {
        expect([0, 1, 2].map(surfaceStepForDrop)).toEqual([1, 2, 4]);
    });

    it('applies both transforms together for a variant', () => {
        const chunk = chunkAt(0, 0, [surf(0, 0), surf(1, 0), surf(2, 0), surf(3, 0)]);
        const out = coarsenChunkForVariant(chunk, 1, CELLS);
        expect(out.lodHints).toHaveLength(1);              // finest quad level dropped
        expect(out.voxels.map(v => v.gx)).toEqual([0, 2]); // surface halved on each axis
    });
});

describe('?lod= override', () => {
    const withSearch = (search: string, fn: () => void): void => {
        window.history.replaceState({}, '', search);
        try { fn(); } finally { window.history.replaceState({}, '', '/'); }
    };

    it('forces a tier the automatic answer cannot reach', () => {
        // Automatic is mobile?1:0 — there is no way to ask for +2 on a real device, which
        // is exactly the comparison worth making before shipping a tier.
        withSearch('/?lod=2', () => expect(preferredLodDrop()).toBe(2));
        withSearch('/?lod=0', () => expect(preferredLodDrop()).toBe(0));
    });

    it('falls through to the automatic answer when absent or malformed', () => {
        withSearch('/', () => expect(preferredLodDrop()).toBe(0));            // jsdom = desktop
        withSearch('/?lod=abc', () => expect(preferredLodDrop()).toBe(0));
        withSearch('/?lod=-1', () => expect(preferredLodDrop()).toBe(0));
    });

    it('degrades rather than failing when the tier has no published variant', () => {
        const asset = { id: 'a', name: 'L', type: 'vwld', url: 'full.vwld',
            lodVariants: [{ drop: 1, url: 'lod1.vwld' }] } as Asset;
        expect(selectVwldUrlForDevice(asset, 9)).toBe('lod1.vwld');
    });
});
