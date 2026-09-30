/**
 * Task 6 — the pure transform behind the creator's ENCODE_VXL_EMISSIVE
 * message: decode a .vxl, override per-palette-color emissive, re-encode.
 *
 * The load-bearing bars proven here:
 *  - geometry is preserved EXACTLY (header params, bounds, fragment AABBs,
 *    leaf order/positions/sizes/colors, LOD trailer) — byte-level where
 *    possible. The fixture includes atlas MID-TONE colors (0.5 gray, browns)
 *    on purpose: a naive decode → unpack → re-encode double-applies the sRGB
 *    OETF for useAtlas assets and brightens 14 of 16 channel values, which
 *    the color-column equality below would catch.
 *  - the palette order the decode handler reports is the SAME order the
 *    re-encode maps the emissive array onto (and it survives a re-encode).
 *  - an all-zero emissive array re-encodes as v5, byte-identical to the
 *    original v5 file (feature removal round-trips cleanly).
 */
// engine/config.js uses import.meta.env (Vite-only) — stub it out for Jest
// (pulled in via the handler module's uploadFile import; the upload path
// itself is never exercised here). Same pattern as ScreenshotService.test.ts.
jest.mock('engine/config.js', () => ({
    AI_AGENT_URL: 'http://localhost:4111',
}));

import {
    decodeVxlV3, encodeVxlV3,
    type DecodedVxlV3, type VxlV3Data, type VxlV3Fragment,
} from 'engine/VxlV3Format.js';
import type { OctreeLeaf } from 'engine/VoxelOctreeRenderer.js';
import { gunzip } from 'engine/gzip.js';
import { applyEmissiveToVxlBytes, collectVxlPalette } from 'engine/template/VxlEmissiveTransforms.js';

function leaf(x: number, y: number, z: number, size: number, r: number, g: number, b: number, emissive = 0): OctreeLeaf {
    return { x, y, z, size, r, g, b, emissive };
}

// Colors: red + green are sRGB fixed points; mid-gray and brown are the
// drift-prone atlas mid-tones. Palette first-occurrence order (fragment then
// leaf order): [red, gray, brown, green].
const RED: [number, number, number] = [1, 0, 0];
const GRAY: [number, number, number] = [0.5, 0.5, 0.5];
const BROWN: [number, number, number] = [0.3, 0.2, 0.1];
const GREEN: [number, number, number] = [0, 1, 0];

function makeData(useAtlas: boolean): VxlV3Data {
    const fragA: VxlV3Fragment = {
        aabbMin: [0, 0, 0], aabbMax: [0.4, 0.1, 0.1],
        leaves: [
            leaf(0, 0, 0, 0.1, ...RED),
            leaf(0.1, 0, 0, 0.1, ...GRAY),
            leaf(0.2, 0, 0, 0.1, ...BROWN),
            leaf(0.3, 0, 0, 0.1, ...GRAY),
        ],
    };
    const fragB: VxlV3Fragment = {
        aabbMin: [0.4, 0, 0], aabbMax: [0.6, 0.1, 0.1],
        leaves: [
            leaf(0.4, 0, 0, 0.1, ...GREEN),
            leaf(0.5, 0, 0, 0.1, ...RED),
        ],
    };
    return {
        minVoxelSize: 0.1, maxVoxelSize: 0.4, physicsGridStep: 0.1,
        bounds: { minX: 0, minY: 0, minZ: 0, maxX: 1.6, maxY: 1.6, maxZ: 1.6 },
        useAtlas,
        fragments: [fragA, fragB],
        additionalLods: [{
            minVoxelSize: 0.2, maxVoxelSize: 0.4,
            fragments: [{
                aabbMin: [0, 0, 0], aabbMax: [0.4, 0.2, 0.2],
                leaves: [leaf(0, 0, 0, 0.2, ...GRAY), leaf(0.2, 0, 0, 0.2, ...RED)],
            }],
        }],
    };
}

const decode = (u8: Uint8Array): Promise<DecodedVxlV3> =>
    decodeVxlV3(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer);

/** Gunzip the body (offset 5) of an encoded .vxl for byte-level comparison. */
async function fileBody(u8: Uint8Array): Promise<Uint8Array> {
    expect(u8[4]).toBe(1); // gzip wrapper, same as every uploaded .vxl
    return gunzip(u8.subarray(5));
}

/** Everything except emissive must match: header params, AABBs, leaf columns, LODs. */
function expectSameGeometry(a: DecodedVxlV3, b: DecodedVxlV3): void {
    expect(b.minVoxelSize).toBe(a.minVoxelSize);
    expect(b.maxVoxelSize).toBe(a.maxVoxelSize);
    expect(b.physicsGridStep).toBe(a.physicsGridStep);
    expect(b.bounds).toEqual(a.bounds);
    expect(b.useAtlas).toBe(a.useAtlas);
    expect(b.fragments.length).toBe(a.fragments.length);
    const compareFragments = (fa: DecodedVxlV3['fragments'], fb: DecodedVxlV3['fragments']): void => {
        for (let i = 0; i < fa.length; i++) {
            expect(fb[i]!.aabbMin).toEqual(fa[i]!.aabbMin);
            expect(fb[i]!.aabbMax).toEqual(fa[i]!.aabbMax);
            expect(fb[i]!.leaves.count).toBe(fa[i]!.leaves.count);
            expect(fb[i]!.leaves.gx).toEqual(fa[i]!.leaves.gx);
            expect(fb[i]!.leaves.gy).toEqual(fa[i]!.leaves.gy);
            expect(fb[i]!.leaves.gz).toEqual(fa[i]!.leaves.gz);
            expect(fb[i]!.leaves.lod).toEqual(fa[i]!.leaves.lod);
            expect(fb[i]!.leaves.color).toEqual(fa[i]!.leaves.color);
        }
    };
    compareFragments(a.fragments, b.fragments);
    expect(b.additionalLods?.length ?? 0).toBe(a.additionalLods?.length ?? 0);
    for (let l = 0; l < (a.additionalLods?.length ?? 0); l++) {
        expect(b.additionalLods![l]!.minVoxelSize).toBe(a.additionalLods![l]!.minVoxelSize);
        expect(b.additionalLods![l]!.maxVoxelSize).toBe(a.additionalLods![l]!.maxVoxelSize);
        compareFragments(a.additionalLods![l]!.fragments, b.additionalLods![l]!.fragments);
    }
}

describe('applyEmissiveToVxlBytes (ENCODE_VXL_EMISSIVE transform)', () => {
    test('applies per-palette-color emissive; geometry/colors/LODs byte-preserved (useAtlas)', async () => {
        const original = await encodeVxlV3(makeData(true));
        const decOriginal = await decode(original);
        const palette = collectVxlPalette(decOriginal);
        expect(palette.colors).toHaveLength(4);
        expect(palette.emissive).toEqual([0, 0, 0, 0]);

        // Emissive indexed by the palette order the decode handler returns: light up GRAY only.
        const result = await applyEmissiveToVxlBytes(original, [0, 180, 0, 0]);
        const decResult = await decode(result);
        expectSameGeometry(decOriginal, decResult);

        // LOD0 leaves whose color is the gray cell carry 180; everything else 0.
        expect(Array.from(decResult.fragments[0]!.leaves.emiss!)).toEqual([0, 180, 0, 180]);
        expect(Array.from(decResult.fragments[1]!.leaves.emiss!)).toEqual([0, 0]);
        // Coarse LODs stay emissive-free (v6 is LOD0-only).
        expect(decResult.additionalLods![0]!.fragments[0]!.leaves.emiss).toBeNull();
        expect(Array.from(decResult.paletteEmissive!)).toEqual([0, 180, 0, 0]);

        // Byte-level: the v6 body is the v5 body with only the version word,
        // the hasEmissive flag, and the appended emissive block differing.
        const v5Body = await fileBody(original);
        const v6Body = await fileBody(result);
        expect(v6Body.length).toBe(v5Body.length + palette.colors.length);
        expect(new DataView(v5Body.buffer, v5Body.byteOffset, 4).getUint32(0, true)).toBe(5);
        expect(new DataView(v6Body.buffer, v6Body.byteOffset, 4).getUint32(0, true)).toBe(6);
        expect(v6Body.subarray(4, 46)).toEqual(v5Body.subarray(4, 46));
        expect(v5Body[46]).toBe(0);
        expect(v6Body[46]).toBe(1);
        expect(v6Body.subarray(47, v5Body.length)).toEqual(v5Body.subarray(47));
        expect(Array.from(v6Body.subarray(v5Body.length))).toEqual([0, 180, 0, 0]);
    });

    test('palette order is stable across re-encode (decode handler and re-opened file agree)', async () => {
        const original = await encodeVxlV3(makeData(true));
        const result = await applyEmissiveToVxlBytes(original, [0, 180, 0, 0]);
        const before = collectVxlPalette(await decode(original));
        const after = collectVxlPalette(await decode(result));
        expect(after.colors).toEqual(before.colors);
        // Re-decoding the saved file reports the emissive that was applied.
        expect(after.emissive).toEqual([0, 180, 0, 0]);
    });

    test('all-zero emissive re-encodes byte-identical v5 (emissive removal round-trips)', async () => {
        const original = await encodeVxlV3(makeData(true));
        // Start from a v6 file, zero everything out: back to v5, byte-for-byte the original.
        const v6 = await applyEmissiveToVxlBytes(original, [0, 180, 0, 0]);
        const zeroed = await applyEmissiveToVxlBytes(v6, [0, 0, 0, 0]);
        expect(await fileBody(zeroed)).toEqual(await fileBody(original));
        const decZeroed = await decode(zeroed);
        expect(decZeroed.paletteEmissive).toBeUndefined();
        expect(decZeroed.fragments[0]!.leaves.emiss).toBeNull();
    });

    test('overrides existing emissive values (edit, not merge)', async () => {
        const original = await encodeVxlV3(makeData(true));
        const v6 = await applyEmissiveToVxlBytes(original, [0, 180, 0, 0]);
        const edited = await applyEmissiveToVxlBytes(v6, [255, 0, 0, 90]);
        const dec = await decode(edited);
        expectSameGeometry(await decode(original), dec);
        // fragA: [red, gray, brown, gray] -> [255, 0, 0, 0]; fragB: [green, red] -> [90, 255]
        expect(Array.from(dec.fragments[0]!.leaves.emiss!)).toEqual([255, 0, 0, 0]);
        expect(Array.from(dec.fragments[1]!.leaves.emiss!)).toEqual([90, 255]);
    });

    test('vertex-color (useAtlas=false) assets round-trip exactly too', async () => {
        const original = await encodeVxlV3(makeData(false));
        const decOriginal = await decode(original);
        const palette = collectVxlPalette(decOriginal);
        const result = await applyEmissiveToVxlBytes(original, palette.colors.map((_, i) => (i === 2 ? 64 : 0)));
        const decResult = await decode(result);
        expectSameGeometry(decOriginal, decResult);
        // Brown (palette position 2) is fragA leaf 2.
        expect(Array.from(decResult.fragments[0]!.leaves.emiss!)).toEqual([0, 0, 64, 0]);
    });

    test('rejects an emissive array that does not match the palette size', async () => {
        const original = await encodeVxlV3(makeData(true));
        await expect(applyEmissiveToVxlBytes(original, [0, 180])).rejects.toThrow(/palette size/);
    });
});
