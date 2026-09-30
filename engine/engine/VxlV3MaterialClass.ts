/**
 * VXL3 v11 — the MATERIAL-CLASS section.
 *
 * A material slot has carried a name and a glow level since v7. v11 adds what it
 * is MADE OF: one class name per named slot, resolved to render parameters by
 * `engine/VoxelMaterialClass.ts`. That is what lets a voxel sword's blade reflect
 * the sky while its leather grip does not.
 *
 * Layout, appended AFTER the v10 rig section:
 *
 *   per named slot, in slot-table order (slotCount entries):
 *     uint8   nameLength   (0 = this slot keeps the default class)
 *     bytes   className    (UTF-8, <= VOXEL_MATERIAL_CLASS_NAME_MAX)
 *
 * Two decisions worth stating, because both are load-bearing:
 *
 * **The section always has `slotCount` entries.** A slot with no class costs one
 * zero byte rather than being skipped, so the section stays positionally
 * addressable with no per-slot presence flag — the same reasoning v8 used for its
 * zero-filled per-LOD arrays.
 *
 * **The class is stored as a NAME, not as a metalness/roughness pair.** Precedent
 * is `VxlV3Rig.skeletonRef`. The render numbers then stay tunable without
 * re-baking a single asset, an unrecognised name resolves to the default instead
 * of throwing (so an asset authored against a newer vocabulary still loads), and
 * the stored value is legible in a hex dump.
 *
 * ── Why v11 needs a header flag, and v10 did not ─────────────────────────────
 *
 * `VxlV3Format`'s header comment records the constraint: the 48-byte header has
 * no spare field, so v9 and v10 announce their sections by VERSION alone — which
 * only works if a v10 file always carries every section a v9 file would.
 *
 * That cannot hold here. The v10 section it would have to always carry is the
 * RIG, and a rig costs one byte per leaf per LOD; it cannot be written empty. A
 * non-rigged gold statue would have no representable version at all.
 *
 * So v11 reintroduces a presence flag in header byte 46, which has been dead
 * since v8 dropped the legacy emissive block (`hasEmissive` is only read for
 * v6/v7/v8). For v11 that byte is a section bitfield. Old readers reject v11 by
 * version before ever looking at byte 46, so nothing can misread it. This also
 * repays v10's debt: from v11 on, optional sections are declared rather than
 * inferred.
 *
 * v11 still always carries the block-type and per-LOD material arrays, exactly as
 * v10 does and for the same reason — they sit BEFORE the flagged sections, so
 * everything up to the flags has to stay positionally addressable. Zero-filled
 * when unused, they cost two bytes per palette ENTRY and gzip to almost nothing.
 */

import { storedVoxelMaterialClassName } from 'engine/VoxelMaterialClass.js';
import type { VoxelSlot } from 'engine/VoxelMaterialSlots.js';

/**
 * Header byte 46 bit flags, meaningful for v11 and later only.
 *
 * Bit 0 keeps byte 46's historical meaning so the byte is never ambiguous when
 * read across versions. v11 never sets it: the legacy per-colour emissive block
 * cannot coexist with the block-type array a v11 file always carries, which is
 * the same trade v8, v9 and v10 already make.
 */
export const VXL3_SECTION_LEGACY_EMISSIVE = 1 << 0;
/** The v10 rig section is present. */
export const VXL3_SECTION_RIG = 1 << 1;
/** The v11 material-class section is present. */
export const VXL3_SECTION_MATERIAL_CLASS = 1 << 2;

/**
 * The class name to STORE for each slot — empty where the slot keeps the default.
 *
 * Deliberately NOT validated against the known vocabulary: an unrecognised name is
 * stored as authored and only falls back where it becomes render parameters, so a
 * round trip through an older engine does not silently strip a class a newer
 * vocabulary introduced. See `storedVoxelMaterialClassName`.
 */
export function materialClassNames(slots: readonly VoxelSlot[]): string[] {
    return slots.map((slot) => storedVoxelMaterialClassName(slot.materialClass));
}

/** True when at least one slot names a non-default class — the encoder's write gate. */
export function hasMaterialClasses(slots: readonly VoxelSlot[]): boolean {
    return materialClassNames(slots).some((name) => name.length > 0);
}

/** Byte size of the section for these class names (one entry per named slot). */
export function materialClassSectionBytes(names: readonly string[]): number {
    let total = 0;
    for (const name of names) {
        total += 1 + new TextEncoder().encode(name).byteLength;
    }
    return total;
}

/**
 * Write the section at `cursor`. Returns the new cursor.
 *
 * `names` must be parallel to the slot table the encoder wrote, and must be
 * exactly as long — a short array would desynchronise the reader, which addresses
 * this section by slot count alone.
 */
export function writeMaterialClassSection(
    bytes: Uint8Array,
    cursorIn: number,
    names: readonly string[],
): number {
    let cursor = cursorIn;
    for (const name of names) {
        const encoded = new TextEncoder().encode(name);
        bytes[cursor] = encoded.byteLength;
        cursor += 1;
        bytes.set(encoded, cursor);
        cursor += encoded.byteLength;
    }
    return cursor;
}

/**
 * Read `slotCount` class names from the section at `cursor`.
 *
 * Returns the names (empty string where a slot keeps the default) and the new
 * cursor. Throws on truncation rather than guessing, because everything after
 * this section is addressed relative to it.
 */
export function readMaterialClassSection(
    bytes: Uint8Array,
    cursorIn: number,
    slotCount: number,
): { names: string[]; cursor: number } {
    let cursor = cursorIn;
    const decoder = new TextDecoder();
    const names: string[] = [];
    for (let i = 0; i < slotCount; i++) {
        if (cursor + 1 > bytes.byteLength) {
            throw new Error(`VXL11 material-class section truncated reading length at slot ${i + 1}`);
        }
        const length = bytes[cursor]!;
        cursor += 1;
        if (cursor + length > bytes.byteLength) {
            throw new Error(`VXL11 material-class section truncated reading name at slot ${i + 1}`);
        }
        names.push(length === 0 ? '' : decoder.decode(bytes.subarray(cursor, cursor + length)));
        cursor += length;
    }
    return { names, cursor };
}

/**
 * Attach decoded class names to a decoded slot table, in place.
 *
 * An empty name leaves `materialClass` OFF the slot rather than setting it to the
 * default string, so a decoded slot is shaped identically to one that predates
 * this section — which is what keeps a decode → re-encode round trip
 * byte-identical for an asset with no classes.
 */
export function applyMaterialClassNames(slots: VoxelSlot[], names: readonly string[]): void {
    for (let i = 0; i < slots.length; i++) {
        const name = names[i];
        if (name === undefined || name.length === 0) continue;
        slots[i]!.materialClass = name;
    }
}
