/**
 * Turn a MATERIAL ASSIGNMENT into material slots on a baked `.vxl`.
 *
 * The sibling of `VxlMaterialSignature.ts`: that module describes an asset well
 * enough for a reader to say what it is made of, and this one applies the answer.
 * Together they let a generated voxel sword's blade become a `metal` slot without
 * regenerating anything — the asset is already finished and correct before this
 * runs, which is what makes classification structurally unable to fail a bake.
 *
 * ── Colour-keyed, and why that matters ──────────────────────────────────────
 *
 * A verdict names a signature GROUP, which is a set of RGB444 colour cells. So
 * the assignment reduces to "cell → class", and three things fall out for free:
 *
 *  - **Every LOD is covered.** The encoder builds a separate palette per LOD from
 *    that LOD's own leaves, so applying a cell→slot rule to each level's leaves
 *    fills all the per-LOD slot arrays with no extra work. Without this a gold
 *    statue would revert to matte at the first LOD switch — exactly the artefact
 *    v8 of the format exists to prevent.
 *  - **The palette does not grow.** The `(cell, slot)` pairing stays 1:1, so this
 *    cannot push an asset over the 256-entry line where `paletteIdxBytes` widens.
 *  - **Coarsening cannot lose a material.** `coarsenLeaves` decides a coarse
 *    cell's material by presence rather than volume, which is how street lamps
 *    once went dark; a colour rule is not a vote and has no such failure mode.
 *
 * The one thing colour-keying cannot express is the same grey being steel on a
 * blade and stone on a plinth. Accepted for now: the class is chosen for the
 * dominant member so the larger surface wins, `blobs > 1` in the signature is the
 * detectable warning sign, and the format already stores `(cell, slot)` so
 * splitting a colour spatially would need no format change when it is wanted.
 *
 * ── What is never touched ───────────────────────────────────────────────────
 *
 * Geometry, colours, block types, the rig, and any slot a MODELLER authored. Slot
 * indices are never renumbered, and a voxel can only be moved out of the base
 * material or out of a slot a previous run of this same pass created — which is
 * how a re-classification can change its mind about a colour without ever being
 * able to take away a `BM_slot_headlights` or an editor-authored light. A slot is
 * recognised as this pass's own by being named after a material class.
 *
 * The re-encode must also carry every per-leaf column the file had — emissive,
 * block type, bone. Dropping `emissive` here would silently switch off every
 * light on a classified asset, with nothing downstream able to notice, which is
 * the single worst bug available in this design. It is why the rebuild goes
 * through `decodedToEncodable` rather than a hand-rolled converter: that function
 * exists because the same hole has already been dug twice, once for `slots` and
 * once nearly for `rig`.
 *
 * ── A class assigned here does NOT bring its default glow ───────────────────
 *
 * A material class carries a default glow that authoring steps seed into a
 * slot's `emissive` (`defaultGlowForVoxelMaterialClass`). This pass is not one of
 * them, deliberately, and it is a rule worth not rediscovering:
 *
 *  - It is COLOUR-KEYED. "This yellow group is a filament" is not distinguishable
 *    by colour and geometry from "this yellow group is gold". A false shiny
 *    surface is something a player screenshots; a false glowing one blooms and
 *    drags the whole scene's exposure with it.
 *  - The mechanics would apply it inconsistently anyway. For a REUSED slot the
 *    applier overlays the real decoded slot and takes only `materialClass` from
 *    the plan, so a planned emissive would be dropped; for an APPENDED one it
 *    would survive. And the `unchanged` gate compares slot count and class only,
 *    so a plan whose sole change was a glow would report a no-op and never be
 *    written.
 *
 * So a classifier-assigned light class arrives dark, and a human turns it up in
 * the editor. The bulk guard below is the belt to that braces.
 */

import { colorToCell, decodeVxlV3, encodeVxlV3, type VxlV3Data } from 'engine/VxlV3Format.js';
import { decodedToEncodable } from 'engine/VoxelExplosionHelpers.js';
import { MAX_VOXEL_SLOTS, type VoxelSlot } from 'engine/VoxelMaterialSlots.js';
import {
    VOXEL_MATERIAL_CLASSES, isVoxelMaterialClassName, normalizeVoxelMaterialClassName,
    type VoxelMaterialClassName,
} from 'engine/VoxelMaterialClass.js';
import {
    buildMaterialSignature, nearestGroupId,
    type MaterialSignature,
} from 'engine/template/VxlMaterialSignature.js';

/**
 * Draw-call budget per asset, well under the format's `MAX_VOXEL_SLOTS` of 15.
 *
 * That 15 is a STORAGE cap; this is a rendering one. Each named slot is one extra
 * draw call per object, and a dressed scene holds hundreds of props, so four
 * materials per prop is already 4x the draw calls of today's scene. Deliberately
 * low until the cost has been measured on a real scene.
 */
export const MAX_MATERIAL_SLOTS_PER_ASSET = 4;

/** Verdicts below this confidence are dropped to the base material. */
export const MIN_VERDICT_CONFIDENCE = 0.45;

/**
 * Minimum share for a BULK material to earn a slot. A wood or stone claim over a
 * sliver of the model is far more likely to be a misread than a real surface.
 */
const MIN_BULK_SHARE = 0.02;

/**
 * Minimum share for an ACCENT material — two orders of magnitude lower, because a
 * gem in a hilt or a gold inlay genuinely is a fraction of a per cent of the
 * voxels and is the whole reason to classify anything.
 */
const MIN_ACCENT_SHARE = 0.002;

/**
 * The classes treated as accents by the share floors above.
 *
 * The emissive three belong here for the same reason the shiny four do, only
 * more so: a bulb, a sign's lettering or a vent of lava is a sliver of an
 * asset's voxels and the entire reason anyone would classify it.
 */
const ACCENT_CLASSES: ReadonlySet<string> = new Set([
    'gem', 'gold', 'glass', 'chrome',
    // A bulb's lens and a sign's lettering are sub-percent of a prop and are the
    // whole reason anyone would classify it — the accent floor's exact case.
    // `lava` is NOT here: a flow or a pool is a bulk surface, so it stays on the
    // higher floor where a stray hot-orange sliver cannot promote itself.
    'filament', 'neon',
]);

/**
 * A bulk surface claimed as one of the precious classes is refused unless the
 * asset's own prompt names that material.
 *
 * This is the guard worth having, and it is not in the prompt — a rule a model is
 * asked to follow is a rule it can forget. A wooden crate is never 40% gem, and a
 * wrongly-shiny surface is the failure a player screenshots.
 */
const PRECIOUS_BULK_LIMIT = 0.25;
const PRECIOUS_CLASSES: ReadonlySet<string> = new Set(['gem', 'gold', 'glass']);

/**
 * The emissive classes face the same bulk guard, as a separate set rather than
 * three more entries in the one above.
 *
 * Two reasons to keep them apart. The word "precious" is spelled out to the
 * classifying agent — `cli/README.md` and the prompt in `shared/asset-core/src/
 * material-classifier.ts` both name gold, gem and glass as THE precious three —
 * and quietly redefining it under them would make that text wrong. And the reason
 * is its own: a wrongly-shiny surface is something a player screenshots, while a
 * wrongly GLOWING one blooms and drags the whole scene's exposure with it. A
 * crate is never a quarter made of neon.
 */
const EMISSIVE_CLASSES: ReadonlySet<string> = new Set(['filament', 'neon', 'lava']);

/** One group's verdict. `class` is a name from the closed vocabulary, never a number. */
export interface MaterialVerdict {
    /** A signature group id (`g0`…). Anything else is dropped. */
    id: string;
    /** A `VoxelMaterialClassName`, or 'unknown' when the classifier could not tell. */
    class: string;
    /** 0..1. Below `MIN_VERDICT_CONFIDENCE` the verdict is ignored. */
    confidence: number;
}

/** Where an assignment came from — recorded on the asset for provenance. */
export type MaterialClassifier = 'agent' | 'ai' | 'manual' | 'heuristic';

export interface MaterialAssignment {
    signatureVersion: number;
    /** Must match the signature of the bytes being changed, or the apply is refused. */
    signatureHash: string;
    verdicts: MaterialVerdict[];
    classifier: MaterialClassifier;
    /** Optional model id, for provenance only. */
    model?: string;
}

/** Why a class did not become a slot — reported as a note, never as an error. */
export interface DroppedClass {
    class: string;
    reason: 'low-confidence' | 'too-small' | 'implausible-bulk' | 'over-budget' | 'unknown-class';
    /** Share of the asset that class would have covered. */
    share: number;
}

export interface MaterialSlotPlan {
    /**
     * The named slots to store, in assignment order — the asset's EXISTING slots
     * first, so nothing is ever renumbered, then one per surviving class.
     *
     * The leading `signature.existingSlots.length` entries are PLACEHOLDERS
     * carrying only the name: a pure planner reads the signature, and the
     * signature deliberately lists existing slots by name alone because it is
     * JSON meant for a reader. `applyMaterialSlotsToVxlBytes` substitutes the real
     * decoded slots back over them — without that an asset's lights would come
     * back at emissive 0, dark, as a side effect of describing its surfaces.
     */
    slots: VoxelSlot[];
    /** RGB444 cell → slot index (1..N). Cells absent from this keep the base material. */
    slotOfCell: Map<number, number>;
    /** Classes that lost a share floor, the budget, or the plausibility guard. */
    dropped: DroppedClass[];
    /** Fraction of the asset left in the base material. */
    baseShare: number;
}

export interface PlanOptions {
    maxSlots?: number;
    /**
     * The prompt or description the asset was generated from, if known. Used only
     * by the plausibility guard above — it is evidence, not instruction.
     */
    promptText?: string;
}

/**
 * Verdicts + signature → the slots to store and which colours belong to them.
 *
 * Pure: no bytes, no I/O, so the budget and collapse rules are testable on their
 * own. Never throws — an unusable assignment yields an empty plan, because the
 * caller's fallback is always "leave the asset exactly as it is".
 */
export function planMaterialSlots(
    sig: MaterialSignature,
    assignment: MaterialAssignment,
    options: PlanOptions = {},
): MaterialSlotPlan {
    const maxSlots = Math.max(0, Math.min(
        options.maxSlots ?? MAX_MATERIAL_SLOTS_PER_ASSET,
        MAX_VOXEL_SLOTS - sig.existingSlots.length,
    ));
    const prompt = (options.promptText ?? '').toLowerCase();
    const dropped: DroppedClass[] = [];

    // Group id → its share, for every rule below.
    const shareOf = new Map(sig.groups.map((g) => [g.id, g.share]));
    const groupById = new Map(sig.groups.map((g) => [g.id, g]));

    // 1. Accumulate share per CLASS, dropping verdicts that fail on their own terms.
    const byClass = new Map<VoxelMaterialClassName, { share: number; groups: string[] }>();
    for (const verdict of assignment.verdicts) {
        const share = shareOf.get(verdict.id);
        if (share === undefined) continue;          // a group this signature does not have
        if (verdict.class === 'unknown') continue;  // an honest abstention, not a failure
        if (!Number.isFinite(verdict.confidence) || verdict.confidence < MIN_VERDICT_CONFIDENCE) {
            dropped.push({ class: verdict.class, reason: 'low-confidence', share });
            continue;
        }
        const known = normalizeVoxelMaterialClassName(verdict.class);
        // `normalize` answers "how does this shade?", so an unrecognised name comes
        // back as the default. Storing that would claim the model said `matte` when
        // it said something this build does not know; report it instead.
        if (known !== verdict.class) {
            dropped.push({ class: verdict.class, reason: 'unknown-class', share });
            continue;
        }
        if (known === 'matte') continue;            // the default needs no slot
        const entry = byClass.get(known);
        if (entry) {
            entry.share += share;
            entry.groups.push(verdict.id);
        } else {
            byClass.set(known, { share, groups: [verdict.id] });
        }
    }

    // 2. Share floors, and the plausibility guard on the precious classes.
    for (const [className, entry] of [...byClass]) {
        const floor = ACCENT_CLASSES.has(className) ? MIN_ACCENT_SHARE : MIN_BULK_SHARE;
        if (entry.share < floor) {
            dropped.push({ class: className, reason: 'too-small', share: entry.share });
            byClass.delete(className);
            continue;
        }
        if ((PRECIOUS_CLASSES.has(className) || EMISSIVE_CLASSES.has(className))
            && entry.share > PRECIOUS_BULK_LIMIT
            && !prompt.includes(className)) {
            dropped.push({ class: className, reason: 'implausible-bulk', share: entry.share });
            byClass.delete(className);
        }
    }

    // 3. Over budget: collapse the SMALLEST-share class along its `collapsesTo`
    //    chain, so a merge loses detail (gold becomes metal) rather than losing the
    //    material entirely.
    while (byClass.size > maxSlots && byClass.size > 0) {
        const smallest = [...byClass.entries()]
            .sort((a, b) => (a[1].share - b[1].share) || a[0].localeCompare(b[0]))[0]!;
        const [className, entry] = smallest;
        byClass.delete(className);
        const target = VOXEL_MATERIAL_CLASSES[className].collapsesTo;
        if (target === null || target === 'matte') {
            dropped.push({ class: className, reason: 'over-budget', share: entry.share });
            continue;
        }
        const existing = byClass.get(target);
        if (existing) {
            existing.share += entry.share;
            existing.groups.push(...entry.groups);
        } else {
            byClass.set(target, { share: entry.share, groups: [...entry.groups] });
        }
        dropped.push({ class: className, reason: 'over-budget', share: entry.share });
    }

    // 4. Existing slots keep their indices — this never renumbers what an asset
    //    already had, so a GLB's `BM_slot_headlights` is unaffected.
    const slots: VoxelSlot[] = sig.existingSlots.map((name) => ({ name, emissive: 0 }));
    const indexByName = new Map(sig.existingSlots.map((name, i) => [name, i + 1]));
    const slotOfCell = new Map<number, number>();
    let classedShare = 0;
    // Largest class first, so the budget is spent on what covers the most of the
    // asset and the slot order is deterministic.
    const ordered = [...byClass.entries()]
        .sort((a, b) => (b[1].share - a[1].share) || a[0].localeCompare(b[0]));
    for (const [className, entry] of ordered) {
        // Slot NAME is the class name, so the render side keys off what the file
        // already stores and the editor's material picker shows something meaningful.
        //
        // A slot of that name already existing means this asset has been classified
        // before: REUSE it rather than appending a second one. Two slots sharing a
        // name are two materials the runtime cannot tell apart by name, which is the
        // one thing `setSlotEmissive` needs to work — the same clash
        // `createMaterialSlot` resolves in the editor. Reusing also makes re-running
        // the identical assignment a clean no-op instead of growing the table every
        // time.
        const reused = indexByName.get(className);
        let index: number;
        if (reused !== undefined) {
            index = reused;
            // The placeholder carries the class so the applier can overlay it onto
            // the real decoded slot — a slot that was named after a class but had
            // lost the class itself (a `--clear`) gets it back.
            slots[reused - 1] = { ...slots[reused - 1]!, materialClass: className };
        } else {
            slots.push({ name: className, emissive: 0, materialClass: className });
            index = slots.length;
            indexByName.set(className, index);
        }
        for (const groupId of entry.groups) {
            const group = groupById.get(groupId);
            if (!group) continue;
            for (const cell of group.cells) {
                // First class to claim a colour keeps it: a colour cannot be in two
                // slots here, since the whole assignment is keyed by colour.
                if (!slotOfCell.has(cell)) slotOfCell.set(cell, index);
            }
        }
        classedShare += entry.share;
    }

    return {
        slots,
        slotOfCell,
        dropped,
        baseShare: Math.max(0, Math.min(1, 1 - classedShare)),
    };
}

/** What an apply produced, alongside the bytes. */
export interface AppliedMaterials {
    bytes: Uint8Array;
    plan: MaterialSlotPlan;
    signature: MaterialSignature;
    /** True when the plan named no new slot, so `bytes` is the input unchanged. */
    unchanged: boolean;
}

/**
 * Apply an assignment to a `.vxl`'s bytes: decode, set slots, re-encode.
 *
 * Re-derives the signature from the decoded file and REFUSES on a hash mismatch.
 * That is what lets the wire payload be a handful of verdicts rather than the
 * whole palette: an assignment computed against a different bake — a re-voxelized
 * asset, a different voxel size — cannot be silently misapplied to geometry it
 * does not describe.
 */
export async function applyMaterialSlotsToVxlBytes(
    vxlBytes: Uint8Array,
    assignment: MaterialAssignment,
    options: PlanOptions = {},
): Promise<AppliedMaterials> {
    const dec = await decodeVxlV3(toExactArrayBuffer(vxlBytes));
    const signature = buildMaterialSignature(dec);
    if (assignment.signatureHash !== signature.hash) {
        throw new Error(
            `Material assignment does not describe this asset: expected signature ${signature.hash}, `
            + `assignment carries ${assignment.signatureHash}. Re-read the signature and try again.`,
        );
    }
    if (assignment.signatureVersion !== signature.version) {
        throw new Error(
            `Material assignment was built for signature version ${assignment.signatureVersion}, `
            + `this engine produces version ${signature.version}.`,
        );
    }

    // An asset whose BASE material glows cannot be classified, and refusing is the
    // right answer rather than a warning.
    //
    // A slot-0 leaf's glow can only have come from the legacy per-colour emissive
    // block, which v8 dropped and v11 therefore cannot carry — the file always
    // writes the block-type array, and the two cannot coexist. So re-encoding such
    // an asset as v11 would trade the creator's light for a shine, silently from
    // their point of view. The format's own encoder refuses the mirror of this
    // trade ("dropping a user's glow to gain a version number is not a trade the
    // encoder gets to make"), and the remedy is the same one it names: put the glow
    // on a material.
    if (hasBaseMaterialGlow(dec)) {
        throw new Error(
            'This asset lights up voxels in its base material, using the legacy '
            + 'per-colour glow that material classes replaced. Classifying it would '
            + 'drop that glow. Move the glow onto a named material first (in the voxel '
            + 'editor, put those voxels in a material and set its glow there).',
        );
    }

    const plan = planMaterialSlots(signature, assignment, options);
    // "Would this write anything?" is not just "are there new slots": a plan can
    // instead REUSE an existing slot of the same name, which is a change when that
    // slot had lost its class and a no-op when it still has it.
    const existingSlots = dec.slots ?? [];
    const appended = plan.slots.length - existingSlots.length;
    const reclassified = plan.slots.slice(0, existingSlots.length).some(
        (slot, i) => (slot.materialClass ?? '') !== (existingSlots[i]?.materialClass ?? ''),
    );
    if (appended <= 0 && !reclassified) {
        // Nothing to write. Returning the input bytes rather than a re-encode keeps
        // "the classifier found nothing" byte-identical to "it never ran", so an
        // asset is never rewritten — and its url never churns — for no change.
        return { bytes: vxlBytes, plan, signature, unchanged: true };
    }

    // `decodedToEncodable` is the one converter that carries every per-leaf column
    // (emissive, block type, bone) and the asset-level sections. See the file
    // header for why hand-rolling this is the worst bug available here.
    const rebuilt: VxlV3Data = decodedToEncodable(dec);
    const useAtlas = dec.useAtlas;

    // Resolve each palette cell ONCE per level: the nearest-group fallback is the
    // expensive part, and a level has far fewer distinct colours than leaves.
    const resolved = new Map<number, number>();
    const slotForCell = (cell: number): number => {
        const cached = resolved.get(cell);
        if (cached !== undefined) return cached;
        let slot = plan.slotOfCell.get(cell) ?? 0;
        if (slot === 0) {
            // A coarser LOD's colour may be an average that appears nowhere in LOD0.
            const groupId = nearestGroupId(signature, cell, useAtlas);
            if (groupId !== null) {
                const group = signature.groups.find((g) => g.id === groupId);
                if (group) {
                    for (const member of group.cells) {
                        const candidate = plan.slotOfCell.get(member);
                        if (candidate !== undefined) { slot = candidate; break; }
                    }
                }
            }
        }
        resolved.set(cell, slot);
        return slot;
    };

    // Which existing slots a re-classification may move voxels OUT of.
    //
    // A slot named after a material class was created by a previous run of this
    // same pass, so a later run owns it and may change its mind. Any other slot —
    // a modeller's `BM_slot_headlights`, an editor-authored light — is untouchable:
    // classification must never be able to take a light away.
    //
    // Without this, asking for `gold` where a previous run said `metal` did
    // something worse than nothing: the leaves stayed metal, an empty `gold` slot
    // was appended, and the file was rewritten to say so.
    const reassignable = new Set<number>();
    existingSlots.forEach((slot, i) => {
        if (isVoxelMaterialClassName(slot.name)) reassignable.add(i + 1);
    });

    const applyTo = (leaves: VxlV3Data['fragments'][number]['leaves']): void => {
        for (const leaf of leaves) {
            const current = leaf.slot ?? 0;
            if (current !== 0 && !reassignable.has(current)) continue;
            const cell = colorCellOf(leaf, useAtlas);
            const slot = slotForCell(cell);
            // Assigned unconditionally for a leaf already in a class slot, so a
            // colour the new assignment says nothing about goes back to the default
            // rather than keeping a verdict that has been withdrawn.
            if (slot !== 0 || current !== 0) leaf.slot = slot;
        }
    };

    for (const fragment of rebuilt.fragments) applyTo(fragment.leaves);
    for (const lod of rebuilt.additionalLods ?? []) {
        for (const fragment of lod.fragments) applyTo(fragment.leaves);
    }

    // Substitute the REAL existing slots back over the planner's name-only
    // placeholders (see `MaterialSlotPlan.slots`). Indices are unchanged — the
    // placeholders exist precisely to hold the positions — but the emissive levels
    // those slots already carried are restored, so classifying an asset never dims
    // a light it did not touch.
    //
    // The one field taken from the PLAN is the class, and only where the plan set
    // one: that is how a re-classification reaches a slot it reused rather than
    // appended.
    rebuilt.slots = plan.slots.map((planned, i) => {
        const existing = existingSlots[i];
        if (!existing) return planned;
        return planned.materialClass === undefined
            ? existing
            : { ...existing, materialClass: planned.materialClass };
    });
    return { bytes: await encodeVxlV3(rebuilt), plan, signature, unchanged: false };
}

/**
 * Re-encode with every material class removed — the undo.
 *
 * Existing named slots and their glow survive; only the CLASS is cleared, so an
 * asset that was classified goes back to the plain look without losing a
 * modeller's lights along with it.
 */
export async function clearMaterialClassesFromVxlBytes(vxlBytes: Uint8Array): Promise<Uint8Array> {
    const dec = await decodeVxlV3(toExactArrayBuffer(vxlBytes));
    const rebuilt = decodedToEncodable(dec);
    // Nothing to clear means nothing to write. Re-encoding an asset that has slots
    // but no CLASSES would upload a byte-identical file under a new url and churn
    // every placed instance's reference for no change at all.
    if (!rebuilt.slots?.some((slot) => slot.materialClass !== undefined)) return vxlBytes;
    rebuilt.slots = rebuilt.slots.map(({ name, emissive }) => ({ name, emissive }));
    return encodeVxlV3(rebuilt);
}

/**
 * The RGB444 cell an encode-form leaf will land on.
 *
 * Mirrors `colorToCell`, which is what the encoder itself uses — the plan is keyed
 * by the cells the DECODER reported, so anything that quantised differently here
 * would look up a colour the plan has never heard of.
 */
function colorCellOf(
    leaf: { r: number; g: number; b: number },
    useAtlas: boolean,
): number {
    return colorToCell(leaf.r, leaf.g, leaf.b, useAtlas);
}

/**
 * True when any leaf in the BASE material glows.
 *
 * That is precisely the glow a v11 file cannot represent: from v8 on, emissive is
 * read from the slot table, and slot 0 has no entry there — so a base-material
 * glow can only have arrived through the legacy per-colour block. Every LOD is
 * checked, since a coarser level can carry it too.
 */
function hasBaseMaterialGlow(dec: Awaited<ReturnType<typeof decodeVxlV3>>): boolean {
    const levels = [dec.fragments, ...(dec.additionalLods ?? []).map((l) => l.fragments)];
    for (const fragments of levels) {
        for (const fragment of fragments) {
            const buf = fragment.leaves;
            if (!buf.emiss) continue;
            for (let i = 0; i < buf.count; i++) {
                if (buf.emiss[i]! > 0 && (buf.slot ? buf.slot[i]! : 0) === 0) return true;
            }
        }
    }
    return false;
}

function toExactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    if (bytes.byteOffset === 0
        && bytes.byteLength === bytes.buffer.byteLength
        && bytes.buffer instanceof ArrayBuffer) {
        return bytes.buffer;
    }
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
