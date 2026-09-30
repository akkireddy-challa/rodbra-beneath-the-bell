/**
 * What the voxel editor promises about colour and materials.
 *
 *  1. `colorSimilarity` / `fuzzinessToThreshold` — "Select similar" is only
 *     usable if a given fuzziness means roughly the same thing everywhere in
 *     the palette, and if the useful range lands on the first half of the
 *     track.
 *  2. Editing an ATLAS asset must not shift its colours. The stored cell
 *     already carries the sRGB OETF, so handing the raw fractions back to the
 *     encoder double-encoded and brightened every mid-tone on any edit.
 *  3. Material slots survive the editor's save path — the table AND each
 *     voxel's assignment. Glow lives on the material, so losing either turns
 *     every light in the asset off.
 */

import { decodeVxlV3, encodeVxlV3, type VxlV3Data } from 'engine/VxlV3Format.js';
import type { OctreeLeaf } from 'engine/VoxelOctreeRenderer.js';
import { buildEditedVxlV3Data } from 'engine/VoxelObjectLeafEdit.js';
import {
    colorSimilarity,
    fuzzinessToThreshold,
} from 'editor/voxel-edit/VoxelEditTypes.js';

// ---------------------------------------------------------------------------
// Color similarity
// ---------------------------------------------------------------------------

describe('colorSimilarity', () => {
    it('is 0 for identical colors and 1 for black vs white', () => {
        expect(colorSimilarity(0x3f7ac2, 0x3f7ac2)).toBe(0);
        expect(colorSimilarity(0x000000, 0xffffff)).toBeCloseTo(1, 6);
    });

    it('is symmetric', () => {
        expect(colorSimilarity(0xff0000, 0x00ff00))
            .toBeCloseTo(colorSimilarity(0x00ff00, 0xff0000), 12);
    });

    it('rates one RGB444 step as a small distance in every channel', () => {
        // 0x11 is one 4-bit palette step. Whatever channel it lands in, the
        // slider has to treat it as "basically the same color" — otherwise a
        // fuzziness that merges two shades of red would swallow half a
        // greenish object.
        const base = 0x808080;
        const steps = [0x918080, 0x809180, 0x808091];
        for (const stepped of steps) {
            const d = colorSimilarity(base, stepped);
            expect(d).toBeGreaterThan(0);
            expect(d).toBeLessThan(0.05);
        }
    });

    it('separates genuinely different materials by more than a shade', () => {
        const shade = colorSimilarity(0x2e6f3a, 0x357f42);   // two greens
        const material = colorSimilarity(0x2e6f3a, 0xb07030); // green vs brown
        expect(shade).toBeLessThan(material);
        expect(material).toBeGreaterThan(0.15);
    });
});

describe('fuzzinessToThreshold', () => {
    it('spans 0..1 and is monotonic', () => {
        expect(fuzzinessToThreshold(0)).toBe(0);
        expect(fuzzinessToThreshold(100)).toBe(1);
        let previous = -1;
        for (let f = 0; f <= 100; f += 5) {
            const t = fuzzinessToThreshold(f);
            expect(t).toBeGreaterThan(previous);
            previous = t;
        }
    });

    it('clamps out-of-range input', () => {
        expect(fuzzinessToThreshold(-20)).toBe(0);
        expect(fuzzinessToThreshold(320)).toBe(1);
    });

    it('keeps the useful range on the first half of the track', () => {
        // Anything past ~0.3 already swallows unrelated materials (see the
        // green-vs-brown distance above), so half travel must not exceed it.
        expect(fuzzinessToThreshold(50)).toBeLessThan(0.3);
        // ...but half travel must still be well clear of a single shade step.
        expect(fuzzinessToThreshold(50)).toBeGreaterThan(0.05);
    });
});

// ---------------------------------------------------------------------------
// Persistence through the editor's save path
// ---------------------------------------------------------------------------

const RED: [number, number, number] = [1, 0, 0];
const GREEN: [number, number, number] = [0, 1, 0];
const BLUE: [number, number, number] = [0, 0, 1];

describe('editing an atlas-rendered object does not shift its colors', () => {
    // The editor materialises leaves through `LeafBuffer.toArray()` and saves
    // by re-encoding them. An atlas asset's stored cell already carries the
    // sRGB OETF, so handing the raw v4/15 fractions back to the encoder (which
    // encodes again) brightened every mid-tone — the whole model's palette
    // shifted on any edit, glow or not. toArray(useAtlas) is what prevents it.
    async function encodeThenReEncode(useAtlas: boolean): Promise<{ before: number[]; after: number[] }> {
        const data: VxlV3Data = {
            minVoxelSize: 0.1, maxVoxelSize: 0.1, physicsGridStep: 0.1,
            bounds: { minX: 0, minY: 0, minZ: 0, maxX: 0.3, maxY: 0.1, maxZ: 0.1 },
            useAtlas,
            fragments: [{
                aabbMin: [0, 0, 0], aabbMax: [0.3, 0.1, 0.1],
                leaves: [
                    { x: 0, y: 0, z: 0, size: 0.1, r: 0.5, g: 0.25, b: 0.1 },
                    { x: 0.1, y: 0, z: 0, size: 0.1, r: 0.9, g: 0.4, b: 0.2 },
                ],
            }],
        };
        const first = await decodeVxlV3(new Uint8Array(await encodeVxlV3(data)).buffer);
        const before = Array.from(first.fragments[0]!.leaves.color);

        const materialized = first.fragments[0]!.leaves.toArray(useAtlas);
        const rebuilt = buildEditedVxlV3Data(materialized, first, {
            voxelSize: 0.1, physicsGridStep: 0.1, useAtlas,
        });
        const second = await decodeVxlV3(new Uint8Array(await encodeVxlV3(rebuilt)).buffer);
        return { before, after: Array.from(second.fragments[0]!.leaves.color) };
    }

    it('round-trips atlas cells exactly', async () => {
        const { before, after } = await encodeThenReEncode(true);
        expect(after).toEqual(before);
    });

    it('round-trips vertex-color cells exactly', async () => {
        const { before, after } = await encodeThenReEncode(false);
        expect(after).toEqual(before);
    });

    it('keeps an atlas cell stable under repeated materialize/re-encode', async () => {
        // Several edit sessions in a row must not walk the palette: each pass
        // re-materialises what the previous pass wrote.
        const data: VxlV3Data = {
            minVoxelSize: 0.1, maxVoxelSize: 0.1, physicsGridStep: 0.1,
            bounds: { minX: 0, minY: 0, minZ: 0, maxX: 0.1, maxY: 0.1, maxZ: 0.1 },
            useAtlas: true,
            fragments: [{
                aabbMin: [0, 0, 0], aabbMax: [0.1, 0.1, 0.1],
                leaves: [{ x: 0, y: 0, z: 0, size: 0.1, r: 0.5, g: 0.25, b: 0.1 }],
            }],
        };
        let decoded = await decodeVxlV3(new Uint8Array(await encodeVxlV3(data)).buffer);
        const original = decoded.fragments[0]!.leaves.color[0]!;

        for (let pass = 0; pass < 4; pass++) {
            const rebuilt = buildEditedVxlV3Data(
                decoded.fragments[0]!.leaves.toArray(true), decoded,
                { voxelSize: 0.1, physicsGridStep: 0.1, useAtlas: true },
            );
            decoded = await decodeVxlV3(new Uint8Array(await encodeVxlV3(rebuilt)).buffer);
            expect(decoded.fragments[0]!.leaves.color[0]).toBe(original);
        }
    });
});

describe('material slots through the voxel editor save path', () => {
    // The editor's save path (`buildEditedVxlV3Data`) originally dropped the
    // slot table on the floor: the leaves kept their `slot` column but the
    // encoder got no table to write, so the file downgraded out of v7 and every
    // named material — and every light riding on one — vanished the first time
    // an asset was hand-edited. These pin that it round-trips.
    const SLOTS = [
        { name: 'sign', emissive: 255 },
        { name: 'trim', emissive: 96 },
    ];

    async function roundTripSlots(leaves: OctreeLeaf[], slots = SLOTS): Promise<{
        slots: Array<{ name: string; emissive: number }>;
        bySlot: Map<number, number>;
    }> {
        const data = buildEditedVxlV3Data(leaves, null, {
            voxelSize: 0.1, physicsGridStep: 0.1, useAtlas: false,
        }, slots);
        const decoded = await decodeVxlV3(new Uint8Array(await encodeVxlV3(data)).buffer);
        const bySlot = new Map<number, number>();
        for (const fragment of decoded.fragments) {
            for (const l of fragment.leaves.toArray()) {
                const slot = l.slot ?? 0;
                bySlot.set(slot, (bySlot.get(slot) ?? 0) + 1);
            }
        }
        return { slots: decoded.slots ?? [], bySlot };
    }

    function slotted(x: number, hex: [number, number, number], slot: number): OctreeLeaf {
        return { x, y: 0, z: 0, size: 0.1, r: hex[0], g: hex[1], b: hex[2], slot };
    }

    it('preserves the slot table and every voxel assignment', async () => {
        const { slots, bySlot } = await roundTripSlots([
            slotted(0, RED, 1), slotted(0.1, GREEN, 1),
            slotted(0.2, BLUE, 2), slotted(0.3, RED, 0),
        ]);
        expect(slots.map((s) => s.name)).toEqual(['sign', 'trim']);
        expect(slots.map((s) => s.emissive)).toEqual([255, 96]);
        expect(bySlot.get(1)).toBe(2);
        expect(bySlot.get(2)).toBe(1);
        expect(bySlot.get(0)).toBe(1);
    });

    it('keeps two voxels of the SAME colour in different materials apart', async () => {
        // The whole point of slots: colour-keyed emissive could not express
        // this, which is why the editor used to need a "give the selection its
        // own colour" button.
        const { bySlot } = await roundTripSlots([slotted(0, RED, 1), slotted(0.1, RED, 0)]);
        expect(bySlot.get(1)).toBe(1);
        expect(bySlot.get(0)).toBe(1);
    });

    it('leaves a slot-free asset slot-free', async () => {
        const { slots, bySlot } = await roundTripSlots(
            [slotted(0, RED, 0), slotted(0.1, GREEN, 0)], [],
        );
        expect(slots).toEqual([]);
        expect(bySlot.get(0)).toBe(2);
    });
});
