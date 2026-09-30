/**
 * @jest-environment node
 *
 * The signature is the feature's central bet: that a baked `.vxl`'s palette,
 * described with a little geometry, says enough for a reader to name the
 * materials — so that classifying a generated sword is a small text problem
 * rather than a vision one.
 *
 * The sword below is the bet stated as a test. Its blade is a tall thin grey
 * region and its grip a small dark blob near the ground, and what these assert is
 * that the signature makes that legible: not merely that two groups exist, but
 * that the numbers a reader would use to tell them apart come out right.
 */
import { buildMaterialSignature, formatMaterialSignatureTable, MATERIAL_SIGNATURE_VERSION } from 'engine/template/VxlMaterialSignature.js';
import { encodeVxlV3, decodeVxlV3, type VxlV3Data, type VxlV3Fragment } from 'engine/VxlV3Format.js';
import type { OctreeLeaf } from 'engine/VoxelOctreeRenderer.js';

const V = 0.1;

function leaf(x: number, y: number, z: number, rgb: [number, number, number], slot = 0): OctreeLeaf {
    return { x, y, z, size: V, r: rgb[0], g: rgb[1], b: rgb[2], emissive: 0, slot };
}

const STEEL: [number, number, number] = [0.72, 0.75, 0.80];
const LEATHER: [number, number, number] = [0.35, 0.22, 0.12];
const BRASS: [number, number, number] = [0.85, 0.65, 0.15];

/**
 * A sword standing upright: a 1-voxel-wide blade from y=0.6 to y=2.0, a leather
 * grip from y=0.0 to y=0.4, and a two-voxel brass pommel between them.
 */
function sword(): VxlV3Fragment[] {
    const leaves: OctreeLeaf[] = [];
    for (let i = 6; i < 20; i++) leaves.push(leaf(0, i * V, 0, STEEL));
    for (let i = 0; i < 4; i++) leaves.push(leaf(0, i * V, 0, LEATHER));
    leaves.push(leaf(0, 4 * V, 0, BRASS));
    leaves.push(leaf(0, 5 * V, 0, BRASS));
    return [{ aabbMin: [0, 0, 0], aabbMax: [V, 2.0, V], leaves }];
}

async function signatureOf(
    fragments: VxlV3Fragment[],
    extra: Partial<VxlV3Data> = {},
): Promise<ReturnType<typeof buildMaterialSignature>> {
    const data: VxlV3Data = {
        minVoxelSize: V, maxVoxelSize: V, physicsGridStep: V,
        bounds: { minX: 0, minY: 0, minZ: 0, maxX: V, maxY: 2.0, maxZ: V },
        useAtlas: true, fragments, ...extra,
    };
    const enc = await encodeVxlV3(data, { compression: 'none' });
    const dec = await decodeVxlV3(
        enc.buffer.slice(enc.byteOffset, enc.byteOffset + enc.byteLength) as ArrayBuffer,
    );
    return buildMaterialSignature(dec);
}

describe('THE BET: a sword is legible from its signature alone', () => {
    it('separates the blade, the grip and the pommel', async () => {
        const sig = await signatureOf(sword());
        // Three materials in, three groups out — the steel's own shading would be
        // what merged them wrongly, and the lightness down-weighting is what stops
        // it splitting instead.
        expect(sig.groups).toHaveLength(3);
        expect(sig.groups[0]!.id).toBe('g0');
    });

    it('makes the blade the largest group, high and thin', async () => {
        const sig = await signatureOf(sword());
        const blade = sig.groups[0]!;
        // 14 of 20 voxels.
        expect(blade.share).toBeCloseTo(0.7, 1);
        // Starts above the grip and reaches the top.
        expect(blade.y[0]).toBeGreaterThan(0.25);
        expect(blade.y[2]).toBeCloseTo(1, 1);
        // Tall in Y, negligible in X and Z — which is what "this is a blade" looks
        // like in numbers, and the discriminator colour cannot provide.
        expect(blade.extent[1]).toBeGreaterThan(0.6);
        expect(blade.extent[0]).toBeLessThan(0.1);
        expect(blade.shape).toBe('thin-long');
    });

    it('puts the grip low and compact', async () => {
        const sig = await signatureOf(sword());
        const grip = sig.groups.find((g) => g.share > 0.15 && g.y[2] < 0.5);
        expect(grip).toBeDefined();
        expect(grip!.y[0]).toBeCloseTo(0, 1);
        expect(grip!.y[2]).toBeLessThan(0.3);
    });

    it('keeps a two-voxel accent rather than folding it away', async () => {
        // A gem or a brass band is a fraction of the model and is exactly what the
        // feature exists to find, so the small-group threshold must not eat it.
        const sig = await signatureOf(sword());
        const pommel = sig.groups.find((g) => g.share < 0.15);
        expect(pommel).toBeDefined();
        expect(pommel!.share).toBeCloseTo(0.1, 1);
    });

    it('renders a table a person can read', async () => {
        const sig = await signatureOf(sword());
        const table = formatMaterialSignatureTable(sig);
        expect(table).toContain('g0');
        expect(table).toContain('thin-long');
        expect(table).toMatch(/#[0-9a-f]{6}/);
        // Every group gets a row, plus the summary and header lines.
        expect(table.split('\n').filter((l) => /^g\d/.test(l))).toHaveLength(3);
    });
});

describe('determinism, which the hash depends on', () => {
    it('produces an identical signature for identical bytes', async () => {
        const a = await signatureOf(sword());
        const b = await signatureOf(sword());
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });

    it('changes the hash when the palette changes', async () => {
        const a = await signatureOf(sword());
        const recoloured = sword();
        recoloured[0]!.leaves[0]!.r = 0.1;
        recoloured[0]!.leaves[0]!.g = 0.9;
        recoloured[0]!.leaves[0]!.b = 0.1;
        const b = await signatureOf(recoloured);
        expect(b.hash).not.toBe(a.hash);
    });

    it('does not depend on the order leaves were written in', async () => {
        const forward = await signatureOf(sword());
        const reversed = sword();
        reversed[0]!.leaves.reverse();
        const back = await signatureOf(reversed);
        // Same colours in the same places, so the same signature — the clustering
        // must not be sensitive to encounter order.
        expect(back.hash).toBe(forward.hash);
    });

    it('stamps its own version', async () => {
        expect((await signatureOf(sword())).version).toBe(MATERIAL_SIGNATURE_VERSION);
    });
});

describe('shape words', () => {
    it('calls a broad flat plate a flat-shell', async () => {
        const leaves: OctreeLeaf[] = [];
        for (let x = 0; x < 12; x++) {
            for (let z = 0; z < 12; z++) leaves.push(leaf(x * V, 0, z * V, STEEL));
        }
        const sig = await signatureOf(
            [{ aabbMin: [0, 0, 0], aabbMax: [1.2, V, 1.2], leaves }],
            { bounds: { minX: 0, minY: 0, minZ: 0, maxX: 1.2, maxY: V, maxZ: 1.2 } },
        );
        expect(sig.groups[0]!.shape).toBe('flat-shell');
    });

    it('calls a colour spread through the whole volume scattered', async () => {
        // The speckle case: a dithered colour is almost never a material of its own,
        // and this is the signal that says so.
        const leaves: OctreeLeaf[] = [];
        for (let x = 0; x < 8; x++) {
            for (let y = 0; y < 8; y++) {
                for (let z = 0; z < 8; z++) leaves.push(leaf(x * V, y * V, z * V, STEEL));
            }
        }
        const sig = await signatureOf(
            [{ aabbMin: [0, 0, 0], aabbMax: [0.8, 0.8, 0.8], leaves }],
            { bounds: { minX: 0, minY: 0, minZ: 0, maxX: 0.8, maxY: 0.8, maxZ: 0.8 } },
        );
        expect(sig.groups[0]!.shape).toBe('scattered');
    });
});

describe('edge cases stay describable rather than throwing', () => {
    it('reports an empty asset as empty', async () => {
        const sig = await signatureOf([{ aabbMin: [0, 0, 0], aabbMax: [V, V, V], leaves: [] }]);
        expect(sig.groups).toHaveLength(0);
        expect(sig.paletteSize).toBe(0);
        expect(formatMaterialSignatureTable(sig)).toContain('empty');
    });

    it('lists the materials an asset already has, so they are never reassigned', async () => {
        const leaves = [leaf(0, 0, 0, STEEL), leaf(0, V, 0, BRASS, 1)];
        const sig = await signatureOf(
            [{ aabbMin: [0, 0, 0], aabbMax: [V, 2 * V, V], leaves }],
            { slots: [{ name: 'headlights', emissive: 255 }] },
        );
        expect(sig.existingSlots).toEqual(['headlights']);
        expect(formatMaterialSignatureTable(sig)).toContain('headlights');
    });

    it('weights a coarse leaf by the volume it stands in for', async () => {
        // One 4x leaf of brass against one fine leaf of steel: by count that is
        // 50/50, by volume the brass is 64:1. Volume is the honest answer to "how
        // much of this thing is that colour".
        const leaves: OctreeLeaf[] = [
            { x: 0, y: 0, z: 0, size: V * 4, r: BRASS[0], g: BRASS[1], b: BRASS[2], emissive: 0, slot: 0 },
            leaf(0, V * 4, 0, STEEL),
        ];
        const sig = await signatureOf(
            [{ aabbMin: [0, 0, 0], aabbMax: [V * 4, V * 5, V * 4], leaves }],
            {
                maxVoxelSize: V * 4,
                bounds: { minX: 0, minY: 0, minZ: 0, maxX: V * 4, maxY: V * 5, maxZ: V * 4 },
            },
        );
        expect(sig.groups[0]!.share).toBeGreaterThan(0.9);
    });
});
