/**
 * Bake-time MATERIAL CLASSES for a `.vxl` asset from a forger-authored
 * `materialByColor` map — the asset-side sibling of the level bake's
 * `classByColor.ts`, and the deterministic half of what `APPLY_VXL_MATERIALS`
 * does with a model's verdicts.
 *
 * A dungeon's walls, doorways and stairs are archetype ASSETS, not level
 * geometry, so the level bake's class map never reaches them: every forged ship
 * interior baked matte and waited for the CLI's classify step (a model reading
 * the asset's colour table) to guess that riveted plating is metal. The forger
 * already knows — the designer wrote `materialClass: "metal"` on the material —
 * and this writes that knowledge into the bytes at bake time, through the same
 * signature + slot plan the classify path uses, so the two never disagree about
 * what a class costs (share floors, the slot budget) or how it is stored.
 *
 * Matching: each authored hex claims the signature group that holds its cell
 * exactly, else the nearest group within one RGB444 step per channel (the
 * pattern shading jitters a wall colour across neighbouring cells, and an exact
 * rule would class one plate and leave the rest matte — the level path's rule,
 * for the same reason). Farther than that, the key is unmatched: a note, never a
 * guess. One class per group; among competing keys the exact claim wins, then
 * the nearer, then the lexicographically smaller hex.
 */

import { decodeVxlV3, colorToCell } from 'engine/VxlV3Format.js';
import { buildMaterialSignature, type MaterialSignature } from 'engine/template/VxlMaterialSignature.js';
import {
    applyMaterialSlotsToVxlBytes, type MaterialVerdict,
} from 'engine/template/VxlMaterialSlotTransforms.js';

export interface MaterialByColorPlan {
    /** One verdict per claimed group, in group order. */
    verdicts: MaterialVerdict[];
    /** Authored keys that claimed no group (malformed hex included). */
    unmatched: string[];
}

export interface MaterialByColorApplied {
    bytes: Uint8Array;
    /** The class names now on the asset (empty when nothing was classed). */
    slots: string[];
    unmatched: string[];
    /** True when the bytes were left byte-identical. */
    unchanged: boolean;
}

function parseHexColor(hex: string): { r: number; g: number; b: number } | null {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return null;
    const v = parseInt(m[1]!, 16);
    return { r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff };
}

/** Channel-wise distance between two 12-bit cells (each channel 4 bits, r<<8|g<<4|b). */
function cellDistance(a: number, b: number): number {
    return Math.abs(((a >> 8) & 0xf) - ((b >> 8) & 0xf))
        + Math.abs(((a >> 4) & 0xf) - ((b >> 4) & 0xf))
        + Math.abs((a & 0xf) - (b & 0xf));
}

function withinOneStep(a: number, b: number): boolean {
    return Math.abs(((a >> 8) & 0xf) - ((b >> 8) & 0xf)) <= 1
        && Math.abs(((a >> 4) & 0xf) - ((b >> 4) & 0xf)) <= 1
        && Math.abs((a & 0xf) - (b & 0xf)) <= 1;
}

/**
 * Resolve the map against a signature. Pure: no I/O, unit-tested directly.
 * `useAtlas` must be the decoded file's, so the authored colour lands in the
 * same cell space the signature's groups were built in.
 */
export function planMaterialByColor(
    sig: MaterialSignature,
    materialByColor: Record<string, string>,
    useAtlas: boolean,
): MaterialByColorPlan {
    const unmatched: string[] = [];
    // group id → { class, exact, distance, hex } of the claim that holds it.
    const claims = new Map<string, { className: string; exact: boolean; distance: number; hex: string }>();
    const keys = Object.keys(materialByColor).sort();
    for (const hex of keys) {
        const parsed = parseHexColor(hex);
        if (!parsed) { unmatched.push(hex); continue; }
        // `colorToCell` takes the leaf's 0..1 floats; the authored hex is 0..255.
        const cell = colorToCell(parsed.r / 255, parsed.g / 255, parsed.b / 255, useAtlas);
        let best: { id: string; exact: boolean; distance: number } | null = null;
        for (const group of sig.groups) {
            if (group.cells.includes(cell)) { best = { id: group.id, exact: true, distance: 0 }; break; }
            for (const c of group.cells) {
                if (!withinOneStep(c, cell)) continue;
                const distance = cellDistance(c, cell);
                if (best === null || distance < best.distance) best = { id: group.id, exact: false, distance };
            }
        }
        if (best === null) { unmatched.push(hex); continue; }
        const claim = { className: materialByColor[hex]!, exact: best.exact, distance: best.distance, hex };
        const held = claims.get(best.id);
        const wins = held === undefined
            || (claim.exact && !held.exact)
            || (claim.exact === held.exact && claim.distance < held.distance);
        if (wins) claims.set(best.id, claim);
    }
    const verdicts: MaterialVerdict[] = sig.groups.flatMap((group) => {
        const claim = claims.get(group.id);
        return claim ? [{ id: group.id, class: claim.className, confidence: 1 }] : [];
    });
    return { verdicts, unmatched };
}

/**
 * Apply the map to already-encoded `.vxl` bytes: decode, sign, plan, and write
 * the slots through `applyMaterialSlotsToVxlBytes` (share floors, budget and
 * the plausibility guard included). A map that claims nothing leaves the bytes
 * byte-identical, so an asset's url never churns for a no-op.
 */
export async function applyMaterialByColorToVxl(
    vxlBytes: Uint8Array,
    materialByColor: Record<string, string>,
    options: { promptText?: string } = {},
): Promise<MaterialByColorApplied> {
    const copy = new Uint8Array(vxlBytes.byteLength);
    copy.set(vxlBytes);
    const decoded = await decodeVxlV3(copy.buffer);
    const signature = buildMaterialSignature(decoded);
    const { verdicts, unmatched } = planMaterialByColor(signature, materialByColor, decoded.useAtlas);
    if (verdicts.length === 0) {
        return { bytes: vxlBytes, slots: [], unmatched, unchanged: true };
    }
    const applied = await applyMaterialSlotsToVxlBytes(
        vxlBytes,
        { signatureVersion: signature.version, signatureHash: signature.hash, verdicts, classifier: 'heuristic' },
        options.promptText === undefined ? {} : { promptText: options.promptText },
    );
    return {
        bytes: applied.unchanged ? vxlBytes : applied.bytes,
        slots: applied.plan.slots.filter((s) => s.materialClass !== undefined).map((s) => s.name),
        unmatched,
        unchanged: applied.unchanged,
    };
}
