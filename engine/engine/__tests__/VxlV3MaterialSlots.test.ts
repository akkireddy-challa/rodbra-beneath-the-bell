/**
 * Slot names are UTF-8 in the file, so these run on the node environment —
 * jsdom ships no TextEncoder/TextDecoder, unlike every runtime the engine
 * actually loads assets in.
 *
 * @jest-environment node
 */
import {
    encodeVxlV3, decodeVxlV3, VXL3_VERSION_SLOTS, VXL3_VERSION_LOD_MATERIALS,
    type VxlV3Data, type VxlV3Fragment,
} from 'engine/VxlV3Format.js';
import type { OctreeLeaf } from 'engine/VoxelOctreeRenderer.js';
import { LeafBuffer } from 'engine/VoxelOctreeRenderer.js';
import {
    buildSlotTable, slotNameFromMaterialName, materialNameForSlot, MAX_VOXEL_SLOTS,
} from 'engine/VoxelMaterialSlots.js';

function leaf(
    x: number, y: number, z: number, size: number,
    r: number, g: number, b: number,
    opts: { emissive?: number; slot?: number } = {},
): OctreeLeaf {
    return { x, y, z, size, r, g, b, emissive: opts.emissive ?? 0, slot: opts.slot ?? 0 };
}
function frag(leaves: OctreeLeaf[]): VxlV3Fragment {
    return { aabbMin: [0, 0, 0], aabbMax: [1.6, 1.6, 1.6], leaves };
}
const base = (fragments: VxlV3Fragment[], slots?: VxlV3Data['slots']): VxlV3Data => ({
    minVoxelSize: 0.1, maxVoxelSize: 0.4, physicsGridStep: 0.1,
    bounds: { minX: 0, minY: 0, minZ: 0, maxX: 1.6, maxY: 1.6, maxZ: 1.6 },
    useAtlas: true, fragments, ...(slots ? { slots } : {}),
});
const roundtrip = async (d: VxlV3Data): Promise<Awaited<ReturnType<typeof decodeVxlV3>>> => {
    const enc = await encodeVxlV3(d, { compression: 'none' });
    return decodeVxlV3(enc.buffer.slice(enc.byteOffset, enc.byteOffset + enc.byteLength) as ArrayBuffer);
};
const versionOf = async (d: VxlV3Data): Promise<number> => {
    const enc = await encodeVxlV3(d, { compression: 'none' });
    return new DataView(enc.buffer, enc.byteOffset + 5, 4).getUint32(0, true);
};

describe('slot names from GLB materials', () => {
    test('reads the BM_slot_ prefix, ignores ordinary materials', () => {
        expect(slotNameFromMaterialName('BM_slot_beacon')).toBe('beacon');
        expect(slotNameFromMaterialName('VehicleParts')).toBeNull();
        expect(slotNameFromMaterialName('')).toBeNull();
        expect(slotNameFromMaterialName(undefined)).toBeNull();
        expect(slotNameFromMaterialName('BM_slot_')).toBeNull();
    });

    test('survives what GLTFLoader does to duplicate material names', () => {
        // createUniqueName appends _1, _2 … to duplicates; both must be one slot.
        expect(slotNameFromMaterialName('BM_slot_headlights_1')).toBe('headlights');
        expect(slotNameFromMaterialName('BM_slot_headlights')).toBe('headlights');
        // A name that legitimately ends in a digit has no underscore before it.
        expect(slotNameFromMaterialName('BM_slot_beacon2')).toBe('beacon2');
    });

    test('materialNameForSlot round-trips', () => {
        expect(slotNameFromMaterialName(materialNameForSlot('taillights'))).toBe('taillights');
    });

    test('duplicate declarations merge, brightest wins; overflow is reported not thrown', () => {
        const declared = [
            { name: 'beacon', emissive: 40 },
            { name: 'beacon', emissive: 255 },
        ];
        // 'beacon' takes one of the slots, so this many extras overflow by 3.
        const overflow = 3;
        for (let i = 0; i < MAX_VOXEL_SLOTS - 1 + overflow; i++) {
            declared.push({ name: `extra${i}`, emissive: 10 });
        }
        const { slots, dropped } = buildSlotTable(declared);
        expect(slots[0]).toEqual({ name: 'beacon', emissive: 255 });
        expect(slots.length).toBe(MAX_VOXEL_SLOTS);
        expect(dropped.length).toBe(overflow);
    });
});

describe('VXL v7 material slots', () => {
    test('THE POINT: same colour, different slots stay separate', async () => {
        // A steady red taillight and a flashing red beacon — identical colour.
        // The old colour-keyed design could not tell these apart.
        const dec = await roundtrip(base(
            [frag([
                leaf(0, 0, 0, 0.1, 1, 0, 0, { slot: 1 }),
                leaf(0.1, 0, 0, 0.1, 1, 0, 0, { slot: 2 }),
                leaf(0.2, 0, 0, 0.1, 1, 0, 0, { slot: 0 }),
            ])],
            [{ name: 'taillights', emissive: 255 }, { name: 'beacon', emissive: 0 }],
        ));
        const buf = dec.fragments[0]!.leaves;
        expect(buf.slot).not.toBeNull();
        expect(Array.from(buf.slot!)).toEqual([1, 2, 0]);
        // All three kept the same colour cell — the slot is what separates them.
        expect(buf.color[0]).toBe(buf.color[1]);
        expect(buf.color[1]).toBe(buf.color[2]);
        expect(dec.slots).toEqual([
            { name: 'taillights', emissive: 255 },
            { name: 'beacon', emissive: 0 },
        ]);
    });

    test('slots present → version 7', async () => {
        const d = base(
            [frag([leaf(0, 0, 0, 0.1, 1, 1, 1, { slot: 1 })])],
            [{ name: 'headlights', emissive: 255 }],
        );
        expect(await versionOf(d)).toBe(7);
    });

    test('no slots → still v5, and the slot column stays null', async () => {
        const d = base([frag([leaf(0, 0, 0, 0.1, 0.5, 0.5, 0.5)])]);
        expect(await versionOf(d)).toBe(5);
        const dec = await roundtrip(d);
        expect(dec.fragments[0]!.leaves.slot).toBeNull();
        expect(dec.slots).toBeUndefined();
    });

    test('a slot table with no slotted leaves does not bump the version', async () => {
        // Declaring lights that ended up matching no voxels must not cost bytes.
        const d = base(
            [frag([leaf(0, 0, 0, 0.1, 0.5, 0.5, 0.5)])],
            [{ name: 'headlights', emissive: 255 }],
        );
        expect(await versionOf(d)).toBe(5);
    });

    test('emissive and slots coexist, each resolved per palette ENTRY', async () => {
        const dec = await roundtrip(base(
            [frag([
                // Same colour, one baked-emissive in the base material, one in a slot.
                leaf(0, 0, 0, 0.1, 0, 1, 0, { emissive: 200, slot: 0 }),
                leaf(0.1, 0, 0, 0.1, 0, 1, 0, { emissive: 0, slot: 1 }),
            ])],
            [{ name: 'beacon', emissive: 128 }],
        ));
        const buf = dec.fragments[0]!.leaves;
        expect(Array.from(buf.emiss!)).toEqual([200, 0]);
        expect(Array.from(buf.slot!)).toEqual([0, 1]);
    });

    test('decode → toArray → re-encode preserves slots', async () => {
        const slots = [{ name: 'headlights', emissive: 255 }, { name: 'beacon', emissive: 0 }];
        const first = await roundtrip(base(
            [frag([
                leaf(0, 0, 0, 0.1, 1, 1, 0, { slot: 1 }),
                leaf(0.1, 0, 0, 0.1, 1, 0, 0, { slot: 2 }),
                leaf(0.2, 0, 0, 0.1, 0.2, 0.2, 0.2),
            ])],
            slots,
        ));
        const again = await roundtrip(base(
            first.fragments.map((f) => ({
                aabbMin: f.aabbMin, aabbMax: f.aabbMax, leaves: f.leaves.toArray(true),
            })),
            first.slots,
        ));
        expect(Array.from(again.fragments[0]!.leaves.slot!)).toEqual([1, 2, 0]);
        expect(again.slots).toEqual(slots);
    });

    test('a slot index past the table falls back to the base material', async () => {
        const dec = await roundtrip(base(
            [frag([leaf(0, 0, 0, 0.1, 1, 0, 0, { slot: 5 })])],
            [{ name: 'beacon', emissive: 255 }],
        ));
        // Only slot 1 exists; the encoder still stores 5, so the decoder must not
        // hand the mesh builder a material index it has no material for.
        const buf = dec.fragments[0]!.leaves;
        expect(buf.slot === null || buf.slot[0] === 0).toBe(true);
    });

    test('LeafBuffer.fromArray carries slots (editor / VWLD bridge)', () => {
        const buf = LeafBuffer.fromArray(
            [leaf(0, 0, 0, 0.1, 1, 0, 0, { slot: 2 }), leaf(0.1, 0, 0, 0.1, 1, 0, 0)],
            0.1, 0, 0, 0,
        );
        expect(Array.from(buf.slot!)).toEqual([2, 0]);
    });
    test('same colour, two materials: one glows and the other does not', async () => {
        // The property the whole slot design exists for, stated plainly. "Palette"
        // is a legacy name — since v7 an entry is (colourCell, slot), so an
        // identical colour in two materials is TWO entries and the glow follows
        // the material, not the colour.
        const dec = await roundtrip(base(
            [frag([
                leaf(0, 0, 0, 0.1, 1, 0, 0, { slot: 1 }),      // red, in the lit material
                leaf(0.1, 0, 0, 0.1, 1, 0, 0, { slot: 2 }),    // the SAME red, unlit material
            ])],
            [{ name: 'lit', emissive: 255 }, { name: 'plain', emissive: 0 }],
        ));
        const buf = dec.fragments[0]!.leaves;
        expect(Array.from(buf.slot!)).toEqual([1, 2]);
        // Both leaves resolve to the same colour cell, and to different materials.
        expect(buf.color[0]).toBe(buf.color[1]);
        expect(dec.slots!.map(s => s.emissive)).toEqual([255, 0]);
    });

    describe('per-LOD material columns (v8)', () => {
        // A slot that only reaches LOD 0 is a light that goes out the moment the
        // renderer switches away from it — which is exactly where a light is the
        // only part of a distant object still worth drawing.
        // Glow lives in the slot table, not on the leaves — that IS the v8 model.
        const withLod = (): VxlV3Data => ({
            ...base([frag([leaf(0, 0, 0, 0.1, 1, 0.9, 0.6, { slot: 1 })])],
                    [{ name: 'glow', emissive: 255 }]),
            additionalLods: [{
                minVoxelSize: 0.2,
                maxVoxelSize: 0.4,
                fragments: [frag([leaf(0, 0, 0, 0.2, 1, 0.9, 0.6, { slot: 1 })])],
            }],
        });

        test('a coarse LOD keeps its material, and the material carries the glow', async () => {
            const dec = await roundtrip(withLod());
            const coarse = dec.additionalLods![0]!.fragments[0]!.leaves;
            expect(coarse.slot?.[0]).toBe(1);
            expect(dec.slots).toEqual([{ name: 'glow', emissive: 255 }]);
            // No per-leaf emissive anywhere: v8 does not carry the legacy column.
            expect(coarse.emiss).toBeNull();
        });

        test('an asset still using legacy per-leaf emissive stays v7 rather than losing it', async () => {
            // v8 cannot represent colour-keyed emissive, so the encoder declines the
            // version instead of dropping the user's glow to earn it.
            const legacy: VxlV3Data = {
                ...base([frag([leaf(0, 0, 0, 0.1, 1, 0, 0, { emissive: 200, slot: 1 })])],
                        [{ name: 'glow', emissive: 255 }]),
                additionalLods: [{
                    minVoxelSize: 0.2, maxVoxelSize: 0.4,
                    fragments: [frag([leaf(0, 0, 0, 0.2, 1, 0, 0, { emissive: 200, slot: 1 })])],
                }],
            };
            expect(await versionOf(legacy)).toBe(VXL3_VERSION_SLOTS);
            const dec = await roundtrip(legacy);
            expect(dec.fragments[0]!.leaves.emiss?.[0]).toBe(200);
        });

        test('raises the version only when a coarse LOD carries material data', async () => {
            expect(await versionOf(withLod())).toBe(VXL3_VERSION_LOD_MATERIALS);
            // LOD 0 slots, coarse level plain: nothing per-LOD to write, so v7.
            const lod0Only: VxlV3Data = {
                ...withLod(),
                additionalLods: [{
                    minVoxelSize: 0.2, maxVoxelSize: 0.4,
                    fragments: [frag([leaf(0, 0, 0, 0.2, 1, 0, 0)])],   // no material at LOD 1
                }],
            };
            expect(await versionOf(lod0Only)).toBe(VXL3_VERSION_SLOTS);
        });

        test('still reads a v7 file, whose coarse LODs are simply unlit', async () => {
            const dec = await roundtrip({
                ...base([frag([leaf(0, 0, 0, 0.1, 1, 0, 0, { slot: 1 })])], [{ name: 'glow', emissive: 200 }]),
                additionalLods: [{
                    minVoxelSize: 0.2, maxVoxelSize: 0.4,
                    fragments: [frag([leaf(0, 0, 0, 0.2, 1, 0, 0)])],
                }],
            });
            expect(dec.fragments[0]!.leaves.slot?.[0]).toBe(1);
            const coarse = dec.additionalLods![0]!.fragments[0]!.leaves;
            expect(coarse.slot === null || coarse.slot[0] === 0).toBe(true);
        });
    });
});
