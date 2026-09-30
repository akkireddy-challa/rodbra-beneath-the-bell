/**
 * Voxel MATERIAL SLOTS — a voxel's material identity, independent of its colour.
 *
 * Before slots, the only per-voxel classification a `.vxl` had was its palette
 * colour, so "this voxel glows" had to be keyed by colour: every red voxel in
 * the asset glowed or none did. That forced two bad outcomes — an ambulance
 * could not have a steady red taillight AND a flashing red beacon, and the
 * voxel editor had to offer artists a "give the selection its own colour"
 * button so a glow could be confined to the voxels they picked.
 *
 * A slot is the material. Slot 0 is the implicit base material every voxel
 * belongs to unless it says otherwise; slots 1..N are named, carry their own
 * emissive level, and become their own geometry group + material instance at
 * mesh-assembly time — which is what makes them settable at RUNTIME (flash a
 * beacon, dim the headlights of a parked car) without touching geometry.
 *
 * Colour still varies freely WITHIN a slot: the palette key becomes
 * (colourCell, slot), so two voxels of the same colour in different slots are
 * two palette entries, and a whole multi-coloured lightbar can live in one
 * slot.
 *
 * A slot also carries what it is MADE OF: an optional `materialClass` naming one
 * of the entries in `engine/VoxelMaterialClass.ts`, which decides whether it
 * shades as plain Lambert, gains a direct specular highlight, or reflects
 * `scene.environment` like real metal. Absent means `matte` — the Lambert look
 * every slot had before classes existed — so this is additive in the strict
 * sense: an asset that names no class renders exactly as it did.
 *
 * Authoring: a source GLB declares a slot by naming a material
 * `BM_slot_<name>` (see `slotNameFromMaterialName`). That keeps the concept
 * where it belongs — a material in the GLB becomes a material in the voxel
 * asset — and works for both forge-generated and hand-modelled Blender GLBs.
 */

import { storedVoxelMaterialClassName } from 'engine/VoxelMaterialClass.js';

/** GLB material-name prefix that promotes its triangles into a named slot. */
export const VOXEL_SLOT_PREFIX = 'BM_slot_';

/**
 * Slot 0 is the base material, so this many NAMED slots plus the base fit in
 * one asset. Each named slot is one extra draw call per object, so the ceiling
 * is deliberately low — it is a material budget, not a storage limit (the
 * stored slot index is a full byte).
 */
export const MAX_VOXEL_SLOTS = 15;

/** Slot names are stored with a uint8 length prefix and shown in editors. */
export const VOXEL_SLOT_NAME_MAX = 32;

/** The implicit material every voxel belongs to unless it declares otherwise. */
export const BASE_VOXEL_SLOT = 0;

export interface VoxelSlot {
    /** Runtime lookup key — `VoxelObject.setSlotEmissive('beacon', 1)`. */
    name: string;
    /**
     * Emissive the slot ships with, 0..255 (0 = a plain material that runtime
     * code can still light up). 255 is the full-strength glow the bloom
     * threshold is tuned against — see `EMISSIVE_INTENSITY`.
     */
    emissive: number;
    /**
     * What this slot is MADE OF — a `VoxelMaterialClassName`, deciding which
     * lighting model backs it (see `engine/VoxelMaterialClass.ts`).
     *
     * Absent means `matte`, which is exactly the Lambert look every voxel had
     * before material classes existed — so an omitted class is not a gap, it is
     * the default, and an asset that sets none renders unchanged.
     *
     * Optional because `VoxelSlot` reaches user-game code through
     * `VoxelObjectBuilder`: a shipped engine type may only gain optional members
     * with sensible defaults (root `AGENTS.md`, engine API backward compat).
     *
     * Deliberately a SEPARATE field from `name` rather than being read off it.
     * Overloading the name would avoid a format section, but it costs two real
     * cases: a modeller's `BM_slot_headlights` could then never be chrome, and
     * the voxel editor lets an artist name a slot anything they like.
     */
    materialClass?: string;
}

/**
 * The slot a GLB material declares, or null for an ordinary material.
 *
 * Tolerant of what `GLTFLoader` does to names on load: it runs every material
 * name through `createUniqueName`, which sanitises `. - # [ ]` and whitespace
 * to `_` and appends `_1`, `_2`… to duplicates. A slot name is matched
 * case-insensitively on the prefix and stripped of a trailing dedupe suffix so
 * `BM_slot_beacon` and a deduped `BM_slot_beacon_1` resolve to the same slot.
 */
export function slotNameFromMaterialName(materialName: string | null | undefined): string | null {
    if (!materialName) return null;
    const trimmed = materialName.trim();
    if (trimmed.length <= VOXEL_SLOT_PREFIX.length) return null;
    if (trimmed.slice(0, VOXEL_SLOT_PREFIX.length).toLowerCase() !== VOXEL_SLOT_PREFIX.toLowerCase()) {
        return null;
    }
    const raw = trimmed.slice(VOXEL_SLOT_PREFIX.length);
    // Strip a GLTFLoader dedupe suffix ("_1"), but never a name that is ITSELF
    // numeric-tailed by design (`beacon2` has no underscore, so it survives).
    const deduped = /_\d+$/.test(raw) ? raw.replace(/_\d+$/, '') : raw;
    const name = deduped.slice(0, VOXEL_SLOT_NAME_MAX);
    return name.length > 0 ? name : null;
}

/** The GLB material name that puts geometry into `name`'s slot. */
export function materialNameForSlot(name: string): string {
    return `${VOXEL_SLOT_PREFIX}${name}`;
}

/**
 * Resolve slot names to indices, in first-declared order, capped at
 * `MAX_VOXEL_SLOTS`. Returns the table (slot 1..N — index 0 is the implicit
 * base and is never listed) plus the names that did not fit, which callers
 * report as a bake note rather than an error: an over-budget asset still bakes,
 * its extra lights just render as ordinary paint.
 *
 * NOT the place to apply a material class's default glow, tempting though the
 * shared funnel is. `emissive` is REQUIRED on the input, so by the time a
 * declaration arrives here an unstated glow and a deliberate zero are the same
 * number and cannot be told apart — defaulting would overwrite an author's
 * explicit dark. Each caller resolves that before it calls, while it still has
 * the `undefined` to test. This function normalises and dedupes; it does not
 * decide.
 */
export function buildSlotTable(
    declared: Array<{ name: string; emissive: number; materialClass?: string }>,
): { slots: VoxelSlot[]; dropped: string[] } {
    const slots: VoxelSlot[] = [];
    const dropped: string[] = [];
    const seen = new Map<string, number>();
    for (const entry of declared) {
        const name = entry.name.slice(0, VOXEL_SLOT_NAME_MAX);
        if (name.length === 0) continue;
        const existing = seen.get(name);
        if (existing !== undefined) {
            // Same slot declared twice (two GLB materials, one logical light) —
            // the brightest declaration wins so a dimmer duplicate can't
            // silently turn a light off.
            const slot = slots[existing]!;
            slot.emissive = Math.max(slot.emissive, clampEmissive(entry.emissive));
            // A material class has no natural "max", so the FIRST declaration
            // wins and a conflicting second one is reported. Two GLB materials
            // claiming one slot name with different materials is an authoring
            // mistake, not something to silently average.
            const incoming = normalizeSlotClass(entry.materialClass);
            if (incoming !== undefined && incoming !== normalizeSlotClass(slot.materialClass)) {
                if (slot.materialClass === undefined) {
                    slot.materialClass = incoming;
                } else {
                    console.warn(
                        `[VoxelMaterialSlots] slot "${name}" declared as both "${slot.materialClass}" and "${incoming}" — keeping "${slot.materialClass}"`,
                    );
                }
            }
            continue;
        }
        if (slots.length >= MAX_VOXEL_SLOTS) {
            dropped.push(name);
            continue;
        }
        seen.set(name, slots.length);
        const materialClass = normalizeSlotClass(entry.materialClass);
        slots.push({
            name,
            emissive: clampEmissive(entry.emissive),
            // Left OFF the object when it is the default, so a class-free slot is
            // shaped exactly as it was before classes existed — which is what
            // keeps the encoder's "write nothing" gate and the existing
            // round-trip tests honest.
            ...(materialClass === undefined ? {} : { materialClass }),
        });
    }
    return { slots, dropped };
}

/**
 * A declared class name as it should be STORED, or `undefined` for "no class" —
 * which covers an absent declaration and an explicit `matte` one alike, since
 * those mean the same thing and only one of them should ever reach the wire.
 *
 * The `''`-vs-`undefined` shuffle is so an absent class stays ABSENT from the slot
 * object rather than becoming an empty string: a slot must be shaped exactly as
 * one that predates material classes, or a decode → re-encode round trip stops
 * being byte-identical.
 */
function normalizeSlotClass(name: string | undefined): string | undefined {
    const stored = storedVoxelMaterialClassName(name);
    return stored.length === 0 ? undefined : stored;
}

function clampEmissive(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(255, Math.round(value)));
}

/** Index of `name` in a slot table, as stored per voxel (0 = base material). */
export function slotIndexOf(slots: VoxelSlot[], name: string): number {
    const i = slots.findIndex((s) => s.name === name);
    return i < 0 ? BASE_VOXEL_SLOT : i + 1;
}
