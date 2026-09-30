/**
 * Shading normals for the voxel slots that need them.
 *
 * A voxel mesh has exactly six distinct face normals. A specular highlight and a
 * reflection are both functions of the normal, so an unsmoothed metal blade
 * samples the light and the environment in only three directions and comes back
 * as three flat tones — it reads as grey paint, not as steel. What makes a
 * surface read as metal is the highlight ROLLING along it, and
 * `smoothShadingNormals` produces exactly that by replacing each face normal with
 * a world-space neighbourhood average, leaving the stair-stepped silhouette and
 * every vertex position untouched.
 *
 * The pass is not cheap: measured at 53.7ms of a 105.6ms load for one 5,537-leaf
 * kart (38,168 vertices), per object, and an order of magnitude worse on a phone.
 * That cost is why this module exists rather than the renderer simply smoothing
 * every mesh with a shiny slot. Two things make it affordable:
 *
 *  - **Only the shiny slots' vertices are written.** A voxel mesh's material
 *    groups reference disjoint vertex sets — slot is part of the greedy merge key,
 *    so a merged rectangle never spans two slots, and the meshers duplicate
 *    vertices per face anyway. So a gold trim strip at 3% of a cathedral's
 *    vertices costs about 3% of the pass. Reading is never restricted, only
 *    writing: the strip needs the stone beside it inside its average, or its
 *    normals collapse back to its own few faces and the highlight steps again.
 *  - **One pass per distinct (strength, radius)**, not one per slot. Classes
 *    share tunings, so a mesh with gold trim and a chrome fitting usually runs
 *    once or twice, never once per slot.
 *
 * Slots whose pass did not run are reported back, because that changes how their
 * material is built: it keeps flat shading, and a class whose whole identity is a
 * mirror image falls back to something that survives faceting
 * (`effectiveVoxelMaterialClassName`).
 */

import { resolveVoxelMaterialClass, wantsShadingSmoothing } from 'engine/VoxelMaterialClass.js';
import { smoothShadingNormals } from 'engine/VoxelSurfaceFinish.js';
import type { MaterialQuality } from 'engine/MaterialQuality.js';
import type { VoxelSlot } from 'engine/VoxelMaterialSlots.js';

export interface SlotShadingInput {
    /** Vertex positions, xyz triples. Read only. */
    positions: Float32Array;
    /** Per-face normals, xyz triples. **Mutated in place** where a mask allows. */
    normals: Float32Array;
    /** Index buffer, already ordered slot-major by `groupIndicesBySlot`. */
    indices: Uint32Array;
    /** Named slots, describing material indices 1..N (0 is the base material). */
    slots: readonly VoxelSlot[];
    /**
     * Index range per material, `groups[0]` = base — i.e. `VoxelSlotPlan.groups`.
     * Slot `i` is described by `groups[i + 1]`.
     */
    groups: ReadonlyArray<{ start: number; count: number }>;
    /** Smallest leaf edge in world units; the smoothing radius is a multiple of it. */
    voxelSize: number;
    /**
     * The material quality this load resolved to (`resolveMaterialQuality`). The
     * pass runs only on tiers whose policy allows it — the caller resolves once
     * per assembly so this module stays platform-free and testable.
     */
    materialQuality: MaterialQuality;
}

export interface SlotShadingResult {
    /** True per slot (parallel to `slots`) when that slot's normals were smoothed. */
    smoothed: boolean[];
    /** Strength/radius of the pass that ran, or null when none did. */
    stamp: { strength: number; radiusVoxels: number } | null;
}

/** Nothing to smooth — the shape every slot-free or all-matte asset gets. */
function noneSmoothed(count: number): SlotShadingResult {
    return { smoothed: new Array<boolean>(count).fill(false), stamp: null };
}

/**
 * Smooth the shading normals of every slot whose material class asks for it.
 *
 * Mutates `normals` in place and returns which slots were actually covered. A
 * no-op — with `normals` untouched — when no slot wants smoothing, when the
 * runtime refuses the pass (mobile), or when the geometry is degenerate.
 */
export function smoothSlotShadingNormals(input: SlotShadingInput): SlotShadingResult {
    const { positions, normals, indices, slots, groups, voxelSize, materialQuality } = input;
    const smoothed = new Array<boolean>(slots.length).fill(false);
    if (slots.length === 0 || voxelSize <= 0) return noneSmoothed(slots.length);

    // Bucket slots by their tuning, so slots that shade alike share one pass.
    const buckets = new Map<string, { strength: number; radiusVoxels: number; slotIndices: number[] }>();
    for (let i = 0; i < slots.length; i++) {
        const cls = resolveVoxelMaterialClass(slots[i]!.materialClass);
        if (!wantsShadingSmoothing(cls, materialQuality)) continue;
        const key = `${cls.smoothness}:${cls.smoothRadiusVoxels}`;
        const bucket = buckets.get(key);
        if (bucket) {
            bucket.slotIndices.push(i);
        } else {
            buckets.set(key, {
                strength: cls.smoothness,
                radiusVoxels: cls.smoothRadiusVoxels,
                slotIndices: [i],
            });
        }
    }
    if (buckets.size === 0) return noneSmoothed(slots.length);

    const vertexCount = Math.floor(normals.length / 3);
    let stamp: { strength: number; radiusVoxels: number } | null = null;

    for (const bucket of buckets.values()) {
        const mask = maskForSlots(indices, groups, bucket.slotIndices, vertexCount);
        if (mask === null) continue;
        const ran = smoothShadingNormals({
            positions,
            normals,
            indices,
            radius: bucket.radiusVoxels * voxelSize,
            strength: bucket.strength,
            writeMask: mask,
        });
        if (!ran) continue;
        for (const i of bucket.slotIndices) smoothed[i] = true;
        // The stamp only has to stop a SECOND whole-mesh pass from running (see
        // `applyVoxelFinishToMesh`), so when several buckets ran, recording the
        // strongest is both the honest summary and the conservative one.
        if (stamp === null || bucket.strength > stamp.strength) {
            stamp = { strength: bucket.strength, radiusVoxels: bucket.radiusVoxels };
        }
    }

    return { smoothed, stamp };
}

/**
 * One byte per vertex, non-zero for the vertices these slots' triangles use, or
 * null when they reference none.
 *
 * `groups` is indexed by MATERIAL, where material 0 is the base and slot `i` is
 * material `i + 1` — the offset `VoxelSlotPlan` documents.
 */
function maskForSlots(
    indices: Uint32Array,
    groups: ReadonlyArray<{ start: number; count: number }>,
    slotIndices: readonly number[],
    vertexCount: number,
): Uint8Array | null {
    const mask = new Uint8Array(vertexCount);
    let marked = 0;
    for (const slotIndex of slotIndices) {
        const group = groups[slotIndex + 1];
        if (!group) continue;
        const end = Math.min(group.start + group.count, indices.length);
        for (let k = group.start; k < end; k++) {
            const v = indices[k]!;
            if (v >= vertexCount || mask[v] !== 0) continue;
            mask[v] = 1;
            marked++;
        }
    }
    return marked === 0 ? null : mask;
}
