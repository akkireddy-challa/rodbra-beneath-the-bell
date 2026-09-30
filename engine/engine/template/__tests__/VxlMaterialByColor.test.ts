/**
 * @jest-environment node
 *
 * Bake-time material classes from a forger-authored `materialByColor` map.
 * The fixture is the slot-transform suite's sword — steel blade, leather grip,
 * brass pommel — so the groups a signature yields are known.
 */
import { encodeVxlV3, decodeVxlV3, colorToCell, type VxlV3Data, type VxlV3Fragment } from 'engine/VxlV3Format.js';
import type { OctreeLeaf } from 'engine/VoxelOctreeRenderer.js';
import { buildMaterialSignature } from 'engine/template/VxlMaterialSignature.js';
import { applyMaterialByColorToVxl, planMaterialByColor } from 'engine/template/VxlMaterialByColor.js';

const V = 0.1;
const STEEL: [number, number, number] = [0.72, 0.75, 0.80];
const LEATHER: [number, number, number] = [0.35, 0.22, 0.12];
const BRASS: [number, number, number] = [0.85, 0.65, 0.15];

const hexOf = (rgb: [number, number, number]): string =>
    '#' + rgb.map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('');

function leaf(y: number, rgb: [number, number, number]): OctreeLeaf {
    return { x: 0, y: y * V, z: 0, size: V, r: rgb[0], g: rgb[1], b: rgb[2], emissive: 0, slot: 0 };
}

function swordLeaves(): OctreeLeaf[] {
    const out: OctreeLeaf[] = [];
    for (let i = 6; i < 20; i++) out.push(leaf(i, STEEL));
    for (let i = 0; i < 4; i++) out.push(leaf(i, LEATHER));
    out.push(leaf(4, BRASS));
    out.push(leaf(5, BRASS));
    return out;
}

function dataOf(leaves: OctreeLeaf[]): VxlV3Data {
    const fragments: VxlV3Fragment[] = [{ aabbMin: [0, 0, 0], aabbMax: [V, 2.0, V], leaves }];
    return {
        minVoxelSize: V, maxVoxelSize: V, physicsGridStep: V,
        bounds: { minX: 0, minY: 0, minZ: 0, maxX: V, maxY: 2.0, maxZ: V },
        useAtlas: true, fragments,
    };
}

const bytesOf = (data: VxlV3Data): Promise<Uint8Array> => encodeVxlV3(data, { compression: 'none' });
const decode = (bytes: Uint8Array) =>
    decodeVxlV3(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);

describe('planMaterialByColor', () => {
    it('claims the group holding an authored colour exactly, and reports the keys that land nowhere', async () => {
        const dec = await decode(await bytesOf(dataOf(swordLeaves())));
        const sig = buildMaterialSignature(dec);
        const plan = planMaterialByColor(sig, { [hexOf(STEEL)]: 'metal', '#00ff00': 'glass', 'nonsense': 'metal' }, dec.useAtlas);
        const steelGroup = sig.groups.find((g) => g.cells.includes(colorToCell(0.72, 0.75, 0.80, true)))!;
        expect(plan.verdicts).toEqual([{ id: steelGroup.id, class: 'metal', confidence: 1 }]);
        expect(plan.unmatched).toEqual(['#00ff00', 'nonsense']);
    });

    it('lets a colour one RGB444 step off still claim its group, and an exact claim beat a near one', async () => {
        const dec = await decode(await bytesOf(dataOf(swordLeaves())));
        const sig = buildMaterialSignature(dec);
        const steelCell = colorToCell(0.72, 0.75, 0.80, true);
        // One step brighter in blue than steel's cell: near, not exact.
        const nearHex = '#' + [((steelCell >> 8) & 0xf) * 17, ((steelCell >> 4) & 0xf) * 17, Math.min(255, ((steelCell & 0xf) + 1) * 17)]
            .map((c) => c.toString(16).padStart(2, '0')).join('');
        const nearOnly = planMaterialByColor(sig, { [nearHex]: 'chrome' }, dec.useAtlas);
        expect(nearOnly.verdicts.map((v) => v.class)).toEqual(['chrome']);
        const both = planMaterialByColor(sig, { [nearHex]: 'chrome', [hexOf(STEEL)]: 'metal' }, dec.useAtlas);
        expect(both.verdicts.map((v) => v.class)).toEqual(['metal']);
    });
});

describe('applyMaterialByColorToVxl', () => {
    it('writes the claimed classes as slots and leaves an unclaimed asset byte-identical', async () => {
        const bytes = await bytesOf(dataOf(swordLeaves()));
        const applied = await applyMaterialByColorToVxl(bytes, { [hexOf(STEEL)]: 'metal', [hexOf(LEATHER)]: 'leather' });
        expect(applied.unchanged).toBe(false);
        expect(applied.slots.sort()).toEqual(['leather', 'metal']);
        expect(applied.unmatched).toEqual([]);
        const dec = await decode(applied.bytes);
        expect(buildMaterialSignature(dec).existingSlots.sort()).toEqual(['leather', 'metal']);

        const untouched = await applyMaterialByColorToVxl(bytes, { '#00ff00': 'glass' });
        expect(untouched.unchanged).toBe(true);
        expect(untouched.bytes).toBe(bytes);
        expect(untouched.slots).toEqual([]);
        expect(untouched.unmatched).toEqual(['#00ff00']);
    });
});
