/**
 * @jest-environment node
 *
 * Applying a material assignment to a baked `.vxl`.
 *
 * The single most important test in this file is the FIDELITY one: a re-encode
 * that drops a per-leaf column silently switches off every light on a classified
 * asset, and nothing downstream can notice, because the asset-level sections are
 * not reconstructible from leaves. That is why the applier goes through
 * `decodedToEncodable` rather than a hand-rolled converter, and why the columns
 * are asserted rather than assumed.
 */
import {
    encodeVxlV3, decodeVxlV3, VXL3_VERSION_MATERIAL_CLASS,
    type VxlV3Data, type VxlV3Fragment,
} from 'engine/VxlV3Format.js';
import type { OctreeLeaf } from 'engine/VoxelOctreeRenderer.js';
import { gunzip } from 'engine/gzip.js';
import { buildMaterialSignature } from 'engine/template/VxlMaterialSignature.js';
import {
    applyMaterialSlotsToVxlBytes, clearMaterialClassesFromVxlBytes,
    planMaterialSlots, MAX_MATERIAL_SLOTS_PER_ASSET,
    type MaterialAssignment, type MaterialVerdict,
} from 'engine/template/VxlMaterialSlotTransforms.js';

const V = 0.1;

const STEEL: [number, number, number] = [0.72, 0.75, 0.80];
const LEATHER: [number, number, number] = [0.35, 0.22, 0.12];
const BRASS: [number, number, number] = [0.85, 0.65, 0.15];

function leaf(
    y: number, rgb: [number, number, number],
    opts: { slot?: number; emissive?: number; blockType?: number } = {},
): OctreeLeaf {
    return {
        x: 0, y: y * V, z: 0, size: V,
        r: rgb[0], g: rgb[1], b: rgb[2],
        emissive: opts.emissive ?? 0,
        slot: opts.slot ?? 0,
        ...(opts.blockType === undefined ? {} : { blockType: opts.blockType }),
    };
}

/** A sword: steel blade above, leather grip below, brass pommel between. */
function swordLeaves(): OctreeLeaf[] {
    const out: OctreeLeaf[] = [];
    for (let i = 6; i < 20; i++) out.push(leaf(i, STEEL));
    for (let i = 0; i < 4; i++) out.push(leaf(i, LEATHER));
    out.push(leaf(4, BRASS));
    out.push(leaf(5, BRASS));
    return out;
}

function dataOf(leaves: OctreeLeaf[], extra: Partial<VxlV3Data> = {}): VxlV3Data {
    const fragments: VxlV3Fragment[] = [{ aabbMin: [0, 0, 0], aabbMax: [V, 2.0, V], leaves }];
    return {
        minVoxelSize: V, maxVoxelSize: V, physicsGridStep: V,
        bounds: { minX: 0, minY: 0, minZ: 0, maxX: V, maxY: 2.0, maxZ: V },
        useAtlas: true, fragments, ...extra,
    };
}

const bytesOf = (data: VxlV3Data): Promise<Uint8Array> =>
    encodeVxlV3(data, { compression: 'none' });

const decode = (bytes: Uint8Array): Promise<Awaited<ReturnType<typeof decodeVxlV3>>> =>
    decodeVxlV3(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);

/** Signature of some bytes, so a test can name real group ids. */
async function signatureOf(bytes: Uint8Array): Promise<ReturnType<typeof buildMaterialSignature>> {
    return buildMaterialSignature(await decode(bytes));
}

/** An assignment bound to `sig`, with the given verdicts. */
function assignment(
    sig: { version: number; hash: string },
    verdicts: MaterialVerdict[],
): MaterialAssignment {
    return {
        signatureVersion: sig.version,
        signatureHash: sig.hash,
        verdicts,
        classifier: 'manual',
    };
}

/** The group covering the largest share — the blade, on the sword above. */
const largest = (sig: ReturnType<typeof buildMaterialSignature>): string => sig.groups[0]!.id;

describe('applying an assignment', () => {
    it('turns the blade into a metal slot and leaves the rest alone', async () => {
        const bytes = await bytesOf(dataOf(swordLeaves()));
        const sig = await signatureOf(bytes);
        const result = await applyMaterialSlotsToVxlBytes(
            bytes, assignment(sig, [{ id: largest(sig), class: 'metal', confidence: 0.9 }]),
        );

        expect(result.unchanged).toBe(false);
        expect(result.plan.slots.map((s) => s.name)).toEqual(['metal']);
        expect(result.plan.slots[0]!.materialClass).toBe('metal');

        const dec = await decode(result.bytes);
        expect(dec.slots!.map((s) => s.materialClass)).toEqual(['metal']);
        // Exactly the blade's 14 voxels moved into slot 1.
        const buf = dec.fragments[0]!.leaves;
        const inSlot1 = Array.from({ length: buf.count }, (_, i) => buf.slot![i]).filter((s) => s === 1);
        expect(inSlot1).toHaveLength(14);
    });

    it('writes a v11 file, gzipped as a shipping asset is', async () => {
        const bytes = await bytesOf(dataOf(swordLeaves()));
        const sig = await signatureOf(bytes);
        const result = await applyMaterialSlotsToVxlBytes(
            bytes, assignment(sig, [{ id: largest(sig), class: 'metal', confidence: 0.9 }]),
        );
        // The applier uses the encoder's default compression, so the output is the
        // form that actually gets uploaded — the body has to be inflated to read
        // its version, which is also a check that the wrapper is well-formed.
        expect(result.bytes[4]).toBe(1);
        const body = await gunzip(result.bytes.subarray(5));
        expect(new DataView(body.buffer, body.byteOffset, 4).getUint32(0, true))
            .toBe(VXL3_VERSION_MATERIAL_CLASS);
    });

    it('returns the input bytes UNCHANGED when nothing was classified', async () => {
        // "The classifier found nothing" must be byte-identical to "it never ran",
        // so an asset's url never churns for no change.
        const bytes = await bytesOf(dataOf(swordLeaves()));
        const sig = await signatureOf(bytes);
        const result = await applyMaterialSlotsToVxlBytes(
            bytes, assignment(sig, [{ id: largest(sig), class: 'unknown', confidence: 0.9 }]),
        );
        expect(result.unchanged).toBe(true);
        expect(result.bytes).toBe(bytes);
    });

    it('REFUSES an assignment built against different bytes', async () => {
        // What lets the wire payload be a handful of verdicts instead of the whole
        // palette: a stale assignment cannot be applied to geometry it never saw.
        const bytes = await bytesOf(dataOf(swordLeaves()));
        const sig = await signatureOf(bytes);
        const stale = { ...assignment(sig, [{ id: 'g0', class: 'metal', confidence: 0.9 }]), signatureHash: 'deadbeef' };
        await expect(applyMaterialSlotsToVxlBytes(bytes, stale))
            .rejects.toThrow(/does not describe this asset/);
    });

    it('refuses an assignment from a different signature version', async () => {
        const bytes = await bytesOf(dataOf(swordLeaves()));
        const sig = await signatureOf(bytes);
        const wrong = { ...assignment(sig, [{ id: largest(sig), class: 'metal', confidence: 0.9 }]), signatureVersion: 99 };
        await expect(applyMaterialSlotsToVxlBytes(bytes, wrong))
            .rejects.toThrow(/signature version/);
    });
});

describe('FIDELITY: the re-encode carries everything the file had', () => {
    it('keeps a MATERIAL slot glowing — the worst bug available here', async () => {
        // Losing this switches off a light on a classified asset. It is why the
        // applier substitutes the real decoded slots back over the planner's
        // name-only placeholders rather than storing what the plan built.
        const leaves = swordLeaves();
        leaves[0]!.slot = 1;
        leaves[1]!.slot = 1;
        const bytes = await bytesOf(dataOf(leaves, {
            slots: [{ name: 'lamp', emissive: 200 }],
        }));
        // The glow lives on the SLOT, not on the leaves — that is the whole point of
        // making it a material property, and `buf.emiss` is empty here as a result.
        const before = await decode(bytes);
        expect(before.slots![0]!).toMatchObject({ name: 'lamp', emissive: 200 });

        const sig = await signatureOf(bytes);
        const result = await applyMaterialSlotsToVxlBytes(
            bytes, assignment(sig, [{ id: largest(sig), class: 'metal', confidence: 0.9 }]),
        );
        const after = await decode(result.bytes);
        expect(after.slots![0]!).toMatchObject({ name: 'lamp', emissive: 200 });
        // …and the lamp's voxels are still in the lamp, not swept into metal.
        const buf = after.fragments[0]!.leaves;
        const inLamp = Array.from({ length: buf.count }, (_, i) => buf.slot![i]).filter((s) => s === 1);
        expect(inLamp).toHaveLength(2);
    });

    it('REFUSES to classify an asset whose base material glows', async () => {
        // A slot-0 glow can only have come from the legacy per-colour block, which
        // v11 cannot carry — so classifying would trade the creator's light for a
        // shine. Refusing keeps the more valuable of the two and says how to fix it.
        //
        // BOTH brass leaves, not one: that legacy glow is keyed by COLOUR, so two
        // same-coloured base leaves disagreeing about glow merge and the first wins.
        // Setting one would exercise the limitation instead of the guard.
        const leaves = swordLeaves();
        leaves[leaves.length - 1]!.emissive = 200;
        leaves[leaves.length - 2]!.emissive = 200;
        const bytes = await bytesOf(dataOf(leaves));
        const sig = await signatureOf(bytes);
        await expect(applyMaterialSlotsToVxlBytes(
            bytes, assignment(sig, [{ id: largest(sig), class: 'metal', confidence: 0.9 }]),
        )).rejects.toThrow(/base material/);
    });

    it('keeps block types', async () => {
        const leaves = swordLeaves();
        leaves[0]!.blockType = 7;
        const bytes = await bytesOf(dataOf(leaves));
        const sig = await signatureOf(bytes);
        const result = await applyMaterialSlotsToVxlBytes(
            bytes, assignment(sig, [{ id: largest(sig), class: 'metal', confidence: 0.9 }]),
        );
        const after = await decode(result.bytes);
        expect(sumColumn(after, 'blockType')).toBe(7);
    });

    it('keeps geometry, colours and leaf count exactly', async () => {
        const bytes = await bytesOf(dataOf(swordLeaves()));
        const before = await decode(bytes);
        const sig = await signatureOf(bytes);
        const result = await applyMaterialSlotsToVxlBytes(
            bytes, assignment(sig, [{ id: largest(sig), class: 'metal', confidence: 0.9 }]),
        );
        const after = await decode(result.bytes);

        const b = before.fragments[0]!.leaves;
        const a = after.fragments[0]!.leaves;
        expect(a.count).toBe(b.count);
        for (let i = 0; i < b.count; i++) {
            expect(a.worldX(i)).toBeCloseTo(b.worldX(i), 6);
            expect(a.worldY(i)).toBeCloseTo(b.worldY(i), 6);
            expect(a.worldZ(i)).toBeCloseTo(b.worldZ(i), 6);
            expect(a.worldSize(i)).toBeCloseTo(b.worldSize(i), 6);
            // Colour-lossless: the atlas cell must survive the decode → re-encode,
            // or the whole model's palette shifts on every classification.
            expect(a.color[i]).toBe(b.color[i]);
        }
    });

    it('never moves a leaf out of a slot the asset already had', async () => {
        // A modeller's headlights must survive classification. Reassigning them
        // would take a light away as a side effect of describing a surface.
        const leaves = swordLeaves();
        leaves[0]!.slot = 1;                 // a steel-coloured leaf, already lit
        leaves[1]!.slot = 1;
        const bytes = await bytesOf(dataOf(leaves, {
            slots: [{ name: 'headlights', emissive: 255 }],
        }));
        const sig = await signatureOf(bytes);
        expect(sig.existingSlots).toEqual(['headlights']);

        const result = await applyMaterialSlotsToVxlBytes(
            bytes, assignment(sig, [{ id: largest(sig), class: 'metal', confidence: 0.9 }]),
        );
        // headlights keeps index 1 — never renumbered — and metal is appended.
        expect(result.plan.slots.map((s) => s.name)).toEqual(['headlights', 'metal']);
        const after = await decode(result.bytes);
        expect(after.slots![0]!.name).toBe('headlights');
        expect(after.slots![0]!.emissive).toBe(255);
        expect(after.slots![0]!.materialClass).toBeUndefined();
        const buf = after.fragments[0]!.leaves;
        const counts = new Map<number, number>();
        for (let i = 0; i < buf.count; i++) {
            counts.set(buf.slot![i]!, (counts.get(buf.slot![i]!) ?? 0) + 1);
        }
        expect(counts.get(1)).toBe(2);       // the two headlight leaves, untouched
        expect(counts.get(2)).toBe(12);      // the remaining steel became metal
    });

    it('covers every LOD, so a class survives the switch to a coarser level', async () => {
        // The reason the assignment is keyed by COLOUR: a per-LOD rule falls out for
        // free, and a gold statue that reverted to matte at the first LOD switch is
        // the artefact v8 of the format exists to prevent.
        const bytes = await bytesOf(dataOf(swordLeaves(), {
            additionalLods: [{
                minVoxelSize: V * 2, maxVoxelSize: V * 2,
                fragments: [{
                    aabbMin: [0, 0, 0], aabbMax: [V * 2, 2.0, V * 2],
                    leaves: [
                        { x: 0, y: 1.0, z: 0, size: V * 2, r: STEEL[0], g: STEEL[1], b: STEEL[2], emissive: 0, slot: 0 },
                        { x: 0, y: 0, z: 0, size: V * 2, r: LEATHER[0], g: LEATHER[1], b: LEATHER[2], emissive: 0, slot: 0 },
                    ],
                }],
            }],
        }));
        const sig = await signatureOf(bytes);
        const result = await applyMaterialSlotsToVxlBytes(
            bytes, assignment(sig, [{ id: largest(sig), class: 'metal', confidence: 0.9 }]),
        );
        const after = await decode(result.bytes);
        const coarse = after.additionalLods![0]!.fragments[0]!.leaves;
        expect(coarse.slot).not.toBeNull();
        // The coarse steel voxel is in the metal slot too.
        const coarseSlots = Array.from({ length: coarse.count }, (_, i) => coarse.slot![i]);
        expect(coarseSlots).toContain(1);
    });
});

describe('the budget and its collapse chain', () => {
    const sig = (groups: Array<{ id: string; share: number; cells: number[] }>) => ({
        version: 1, hash: 'h', voxelCount: 100, paletteSize: groups.length,
        bboxVoxels: [1, 1, 1] as [number, number, number],
        existingSlots: [],
        groups: groups.map((g) => ({
            ...g, hex: '#808080',
            y: [0, 0.5, 1] as [number, number, number],
            extent: [1, 1, 1] as [number, number, number],
            radial: 0, shape: 'blob' as const, blobs: 1,
        })),
    });

    const verdicts = (...pairs: Array<[string, string, number]>): MaterialVerdict[] =>
        pairs.map(([id, cls, confidence]) => ({ id, class: cls, confidence }));

    it('drops a low-confidence verdict rather than guessing', async () => {
        const s = sig([{ id: 'g0', share: 0.9, cells: [1] }]);
        const plan = planMaterialSlots(s, assignment(s, verdicts(['g0', 'metal', 0.2])));
        expect(plan.slots).toHaveLength(0);
        expect(plan.dropped[0]).toMatchObject({ class: 'metal', reason: 'low-confidence' });
    });

    it('drops a bulk claim over a sliver of the model', async () => {
        const s = sig([{ id: 'g0', share: 0.005, cells: [1] }]);
        const plan = planMaterialSlots(s, assignment(s, verdicts(['g0', 'wood', 0.9])));
        expect(plan.dropped[0]).toMatchObject({ class: 'wood', reason: 'too-small' });
    });

    it('KEEPS a tiny accent — a gem in a hilt is the point of the feature', async () => {
        const s = sig([{ id: 'g0', share: 0.004, cells: [1] }]);
        const plan = planMaterialSlots(s, assignment(s, verdicts(['g0', 'gem', 0.9])));
        expect(plan.slots.map((x) => x.name)).toEqual(['gem']);
    });

    it('refuses a precious class over a bulk surface the prompt never mentions', async () => {
        // A wooden crate is never 40% gem, and a wrongly-shiny surface is the
        // failure a player screenshots. Enforced here, not asked of the model.
        const s = sig([{ id: 'g0', share: 0.6, cells: [1] }]);
        const plan = planMaterialSlots(s, assignment(s, verdicts(['g0', 'gold', 0.9])));
        expect(plan.dropped[0]).toMatchObject({ class: 'gold', reason: 'implausible-bulk' });
    });

    it('allows it when the prompt does say so', async () => {
        const s = sig([{ id: 'g0', share: 0.6, cells: [1] }]);
        const plan = planMaterialSlots(
            s, assignment(s, verdicts(['g0', 'gold', 0.9])),
            { promptText: 'a solid gold idol' },
        );
        expect(plan.slots.map((x) => x.name)).toEqual(['gold']);
    });

    it('refuses a light over a bulk surface the prompt never mentions', async () => {
        // The same guard as the precious classes, for a louder failure: a wrongly
        // shiny surface is something a player screenshots, but a wrongly glowing
        // one blooms and drags the whole scene's exposure with it.
        const s = sig([{ id: 'g0', share: 0.6, cells: [1] }]);
        const plan = planMaterialSlots(s, assignment(s, verdicts(['g0', 'neon', 0.9])));
        expect(plan.dropped[0]).toMatchObject({ class: 'neon', reason: 'implausible-bulk' });
    });

    it('KEEPS a tiny light — a bulb in a lamp is the same case as a gem in a hilt', async () => {
        const s = sig([{ id: 'g0', share: 0.004, cells: [1] }]);
        const plan = planMaterialSlots(s, assignment(s, verdicts(['g0', 'filament', 0.9])));
        expect(plan.slots.map((x) => x.name)).toEqual(['filament']);
    });

    it('does NOT seed a light class with its default glow', async () => {
        // Classification is colour-keyed, and "this yellow group is a filament"
        // is not distinguishable from "this yellow group is gold" by colour. So a
        // classifier-assigned light arrives dark and a human turns it up in the
        // editor — see this module's header for the two mechanical reasons a glow
        // planned here would be applied inconsistently anyway.
        const s = sig([{ id: 'g0', share: 0.004, cells: [1] }]);
        const plan = planMaterialSlots(s, assignment(s, verdicts(['g0', 'neon', 0.9])));
        expect(plan.slots.map((x) => x.emissive)).toEqual([0]);
    });

    it('collapses the smallest class along its chain when over budget', async () => {
        // gold → metal loses detail; it does not lose the material.
        const groups = Array.from({ length: 5 }, (_, i) => ({
            id: `g${i}`, share: 0.3 - i * 0.05, cells: [i + 1],
        }));
        const s = sig(groups);
        const plan = planMaterialSlots(s, assignment(s, verdicts(
            ['g0', 'metal', 0.9], ['g1', 'wood', 0.9], ['g2', 'stone', 0.9],
            ['g3', 'cloth', 0.9], ['g4', 'gold', 0.9],
        )));
        expect(plan.slots.length).toBeLessThanOrEqual(MAX_MATERIAL_SLOTS_PER_ASSET);
        // gold was smallest, so it folded into metal rather than disappearing.
        expect(plan.slots.map((x) => x.name)).toContain('metal');
        expect(plan.dropped.some((d) => d.class === 'gold' && d.reason === 'over-budget')).toBe(true);
        // The metal slot now covers gold's colours as well.
        expect([...plan.slotOfCell.keys()]).toContain(5);
    });

    it('reports an unrecognised class instead of storing it as matte', async () => {
        const s = sig([{ id: 'g0', share: 0.9, cells: [1] }]);
        const plan = planMaterialSlots(s, assignment(s, verdicts(['g0', 'unobtanium', 0.9])));
        expect(plan.slots).toHaveLength(0);
        expect(plan.dropped[0]).toMatchObject({ class: 'unobtanium', reason: 'unknown-class' });
    });

    it('ignores a verdict for a group this signature does not have', async () => {
        const s = sig([{ id: 'g0', share: 0.9, cells: [1] }]);
        const plan = planMaterialSlots(s, assignment(s, verdicts(['g7', 'metal', 0.9])));
        expect(plan.slots).toHaveLength(0);
        expect(plan.dropped).toHaveLength(0);
    });

    it('reports how much of the asset stayed in the base material', async () => {
        const s = sig([
            { id: 'g0', share: 0.3, cells: [1] },
            { id: 'g1', share: 0.7, cells: [2] },
        ]);
        const plan = planMaterialSlots(s, assignment(s, verdicts(['g0', 'metal', 0.9])));
        expect(plan.baseShare).toBeCloseTo(0.7, 3);
    });

    it('never exceeds the format cap when an asset already has slots', async () => {
        const s = { ...sig([{ id: 'g0', share: 0.9, cells: [1] }]), existingSlots: Array.from({ length: 15 }, (_, i) => `s${i}`) };
        const plan = planMaterialSlots(s, assignment(s, verdicts(['g0', 'metal', 0.9])));
        // No room left; the class is not stored rather than pushing past MAX_VOXEL_SLOTS.
        expect(plan.slots.map((x) => x.name)).toEqual(s.existingSlots);
    });
});

describe('clearing classes', () => {
    it('removes the class but keeps the slot and its glow', async () => {
        const leaves = swordLeaves();
        leaves[0]!.slot = 1;
        const bytes = await bytesOf(dataOf(leaves, {
            slots: [{ name: 'lamp', emissive: 255, materialClass: 'glass' }],
        }));
        const cleared = await clearMaterialClassesFromVxlBytes(bytes);
        const dec = await decode(cleared);
        expect(dec.slots![0]!.name).toBe('lamp');
        expect(dec.slots![0]!.emissive).toBe(255);
        expect(dec.slots![0]!.materialClass).toBeUndefined();
    });

    it('is a no-op on an asset with no slots', async () => {
        const bytes = await bytesOf(dataOf(swordLeaves()));
        expect(await clearMaterialClassesFromVxlBytes(bytes)).toBe(bytes);
    });

    it('is a no-op on an asset with slots but no CLASSES', async () => {
        // Re-encoding here would upload a byte-identical file under a new url and
        // churn every placed instance's reference for no change at all.
        const leaves = swordLeaves();
        leaves[0]!.slot = 1;
        const bytes = await bytesOf(dataOf(leaves, { slots: [{ name: 'lamp', emissive: 200 }] }));
        expect(await clearMaterialClassesFromVxlBytes(bytes)).toBe(bytes);
    });
});

/**
 * Classifying an asset that has already been classified.
 *
 * The trap: the plan names a slot after its class, so an asset already carrying a
 * `metal` slot would get a SECOND one. Two slots sharing a name are two materials
 * the runtime cannot tell apart by name — the one thing `setSlotEmissive` needs to
 * work, and the same clash the editor's `createMaterialSlot` resolves rather than
 * appending.
 */
describe('re-classifying', () => {
    const classifyAsMetal = async (bytes: Uint8Array): Promise<Awaited<ReturnType<typeof applyMaterialSlotsToVxlBytes>>> => {
        const sig = await signatureOf(bytes);
        return applyMaterialSlotsToVxlBytes(
            bytes, assignment(sig, [{ id: largest(sig), class: 'metal', confidence: 0.9 }]),
        );
    };

    it('reuses the slot instead of creating a duplicate name', async () => {
        const first = await classifyAsMetal(await bytesOf(dataOf(swordLeaves())));
        const second = await classifyAsMetal(first.bytes);
        expect(second.plan.slots.map((s) => s.name)).toEqual(['metal']);
    });

    it('is a clean no-op when the answer has not changed', async () => {
        // Not merely "does not duplicate": running the same assignment twice must
        // write nothing at all, so an idempotent re-run does not churn the url.
        const first = await classifyAsMetal(await bytesOf(dataOf(swordLeaves())));
        const second = await classifyAsMetal(first.bytes);
        expect(second.unchanged).toBe(true);
        expect(second.bytes).toBe(first.bytes);
    });

    it('CHANGES ITS MIND: a second run can move voxels to a different class', async () => {
        // Before this worked, asking for gold where a previous run said metal did
        // something worse than nothing: the leaves stayed metal, an empty gold slot
        // was appended, and the file was rewritten to say so.
        const first = await classifyAsMetal(await bytesOf(dataOf(swordLeaves())));
        const sig = await signatureOf(first.bytes);
        const second = await applyMaterialSlotsToVxlBytes(
            first.bytes,
            assignment(sig, [{ id: largest(sig), class: 'gold', confidence: 0.9 }]),
            { promptText: 'a gold sword' },
        );
        expect(second.unchanged).toBe(false);

        const dec = await decode(second.bytes);
        const goldIndex = dec.slots!.findIndex((s) => s.materialClass === 'gold') + 1;
        expect(goldIndex).toBeGreaterThan(0);
        const buf = dec.fragments[0]!.leaves;
        const slots = Array.from({ length: buf.count }, (_, i) => buf.slot![i]);
        // The blade's 14 voxels really moved into the gold slot.
        expect(slots.filter((s) => s === goldIndex)).toHaveLength(14);
    });

    it('withdraws a class when the new answer says nothing about that colour', async () => {
        // A verdict that is taken back has to actually be taken back, or a slot's
        // voxels would keep a shine the classifier no longer claims.
        const first = await classifyAsMetal(await bytesOf(dataOf(swordLeaves())));
        const sig = await signatureOf(first.bytes);
        const second = await applyMaterialSlotsToVxlBytes(
            first.bytes,
            // A verdict for a DIFFERENT group, so the blade is left unclaimed.
            assignment(sig, [{ id: sig.groups[1]!.id, class: 'leather', confidence: 0.9 }]),
        );
        const dec = await decode(second.bytes);
        const metalIndex = dec.slots!.findIndex((s) => s.name === 'metal') + 1;
        const buf = dec.fragments[0]!.leaves;
        const slots = Array.from({ length: buf.count }, (_, i) => buf.slot![i]);
        // Nothing is left in the metal slot; it stays in the table (an empty group
        // is never drawn) but claims no voxels.
        expect(slots.filter((s) => s === metalIndex)).toHaveLength(0);
    });

    it('never moves voxels out of a MODELLER\'s slot, even on a second run', async () => {
        // The line that must not move: a `BM_slot_headlights` is not this pass's to
        // reassign, however confident a verdict about its colour is.
        const leaves = swordLeaves();
        leaves[0]!.slot = 1;
        leaves[1]!.slot = 1;
        const bytes = await bytesOf(dataOf(leaves, {
            slots: [{ name: 'headlights', emissive: 255 }],
        }));
        const result = await classifyAsMetal(bytes);
        const dec = await decode(result.bytes);
        const buf = dec.fragments[0]!.leaves;
        const slots = Array.from({ length: buf.count }, (_, i) => buf.slot![i]);
        expect(slots.filter((s) => s === 1)).toHaveLength(2);
        expect(dec.slots![0]!).toMatchObject({ name: 'headlights', emissive: 255 });
    });

    it('puts a class back onto a slot that was cleared', async () => {
        // clear → classify has to reach the slot it reuses, or the class would be
        // planned and then silently dropped when the real decoded slot is
        // substituted back over the placeholder.
        const first = await classifyAsMetal(await bytesOf(dataOf(swordLeaves())));
        const cleared = await clearMaterialClassesFromVxlBytes(first.bytes);
        expect((await decode(cleared)).slots![0]!.materialClass).toBeUndefined();

        const again = await classifyAsMetal(cleared);
        expect(again.unchanged).toBe(false);
        const dec = await decode(again.bytes);
        expect(dec.slots!.map((s) => s.name)).toEqual(['metal']);
        expect(dec.slots![0]!.materialClass).toBe('metal');
    });
});

/** Sum of a per-leaf column across LOD0, for the fidelity assertions. */
function sumColumn(
    dec: Awaited<ReturnType<typeof decodeVxlV3>>,
    column: 'emiss' | 'blockType',
): number {
    let total = 0;
    for (const fragment of dec.fragments) {
        const values = fragment.leaves[column];
        if (!values) continue;
        for (let i = 0; i < fragment.leaves.count; i++) total += values[i]!;
    }
    return total;
}
