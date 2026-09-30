/**
 * Leaf-level editing support for VXL v3 octree VoxelObjects.
 *
 * The voxel editor mutates a VoxelObject's materialised `OctreeLeaf[]`
 * (variable-size cubes in bounds-space object units). This module holds
 * the pieces of that which belong to the engine:
 *
 *  - `LeafSpatialIndex` — bucketed point-containment / box-overlap queries
 *    over a leaf list, used for picking and add-occupancy checks.
 *  - `buildEditedVxlV3Data` — rebuilds an encodable VXL v3 payload from
 *    the LIVE leaves after edits. `VoxelObject.toVXL()` uses it instead of
 *    round-tripping the original (now stale) decoded file data, and it
 *    REGENERATES the coarser LOD levels from the edited LOD 0 so saved
 *    files never carry stale LODs (docs/voxel-editor-design.md §4.1).
 *
 * Grid invariants relied on throughout: leaf positions are grid-aligned
 * to their own size relative to the file's bounds origin, and every leaf
 * size is `minVoxelSize × 2^n` — both guaranteed by the voxelizer and
 * preserved by editor mutations (adds step by an existing leaf's size).
 */

import type { OctreeLeaf } from 'engine/VoxelOctreeRenderer.js';
import type { DecodedVxlV3, VxlV3Bounds, VxlV3Data, VxlV3LodLevel } from 'engine/VxlV3Format.js';
import type { VoxelSlot } from 'engine/VoxelMaterialSlots.js';
// The one runtime import here, and deliberately from the module with no imports of
// its own: this file has to keep loading under plain Node (tools/vxl3-encode.ts).
import { rigToEncodeInput } from 'engine/VxlV3Rig.js';

/** Axis-aligned bounds spanning a leaf list (min corner .. max corner). */
export function computeLeafBounds(leaves: OctreeLeaf[]): VxlV3Bounds {
    if (leaves.length === 0) {
        return { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
    }
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const leaf of leaves) {
        if (leaf.x < minX) minX = leaf.x;
        if (leaf.y < minY) minY = leaf.y;
        if (leaf.z < minZ) minZ = leaf.z;
        if (leaf.x + leaf.size > maxX) maxX = leaf.x + leaf.size;
        if (leaf.y + leaf.size > maxY) maxY = leaf.y + leaf.size;
        if (leaf.z + leaf.size > maxZ) maxZ = leaf.z + leaf.size;
    }
    return { minX, minY, minZ, maxX, maxY, maxZ };
}

/**
 * Bucketed spatial index over a leaf list. Buckets are sized to the
 * largest leaf so any leaf overlaps at most 8 buckets. The index is
 * immutable — the editor rebuilds it after each mutation batch (leaf
 * counts in editable assets make a full rebuild cheap relative to the
 * remesh that accompanies every mutation anyway).
 */
export class LeafSpatialIndex {
    private buckets = new Map<string, number[]>();
    private leaves: OctreeLeaf[];
    private bucketSize: number;
    private epsilon: number;

    constructor(leaves: OctreeLeaf[], minVoxelSize: number) {
        this.leaves = leaves;
        let maxSize = minVoxelSize;
        for (const leaf of leaves) {
            if (leaf.size > maxSize) maxSize = leaf.size;
        }
        this.bucketSize = maxSize;
        this.epsilon = minVoxelSize * 1e-3;

        for (let i = 0; i < leaves.length; i++) {
            const leaf = leaves[i]!;
            this.forEachBucketOf(
                leaf.x, leaf.y, leaf.z,
                leaf.x + leaf.size, leaf.y + leaf.size, leaf.z + leaf.size,
                (key) => {
                    const bucket = this.buckets.get(key);
                    if (bucket) bucket.push(i);
                    else this.buckets.set(key, [i]);
                },
            );
        }
    }

    /** Index of the leaf containing the point, or -1. */
    leafIndexAt(x: number, y: number, z: number): number {
        const key = this.bucketKey(x, y, z);
        const bucket = this.buckets.get(key);
        if (!bucket) return -1;
        const e = this.epsilon;
        for (const i of bucket) {
            const leaf = this.leaves[i]!;
            if (
                x >= leaf.x - e && x < leaf.x + leaf.size + e &&
                y >= leaf.y - e && y < leaf.y + leaf.size + e &&
                z >= leaf.z - e && z < leaf.z + leaf.size + e
            ) {
                return i;
            }
        }
        return -1;
    }

    /** True when any leaf overlaps the box (used for add-occupancy checks). */
    overlapsBox(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): boolean {
        const e = this.epsilon;
        let found = false;
        this.forEachBucketOf(minX, minY, minZ, maxX, maxY, maxZ, (key) => {
            if (found) return;
            const bucket = this.buckets.get(key);
            if (!bucket) return;
            for (const i of bucket) {
                const leaf = this.leaves[i]!;
                if (
                    minX < leaf.x + leaf.size - e && maxX > leaf.x + e &&
                    minY < leaf.y + leaf.size - e && maxY > leaf.y + e &&
                    minZ < leaf.z + leaf.size - e && maxZ > leaf.z + e
                ) {
                    found = true;
                    return;
                }
            }
        });
        return found;
    }

    private bucketKey(x: number, y: number, z: number): string {
        const s = this.bucketSize;
        return `${Math.floor(x / s)},${Math.floor(y / s)},${Math.floor(z / s)}`;
    }

    private forEachBucketOf(
        minX: number, minY: number, minZ: number,
        maxX: number, maxY: number, maxZ: number,
        fn: (key: string) => void,
    ): void {
        const s = this.bucketSize;
        const e = this.epsilon;
        const bx0 = Math.floor((minX + e) / s), bx1 = Math.floor((maxX - e) / s);
        const by0 = Math.floor((minY + e) / s), by1 = Math.floor((maxY - e) / s);
        const bz0 = Math.floor((minZ + e) / s), bz1 = Math.floor((maxZ - e) / s);
        for (let bx = bx0; bx <= bx1; bx++) {
            for (let by = by0; by <= by1; by++) {
                for (let bz = bz0; bz <= bz1; bz++) {
                    fn(`${bx},${by},${bz}`);
                }
            }
        }
    }
}

/** How much more a surface voxel's vote counts than a buried one when coarsening. */
const SURFACE_VOTE_WEIGHT = 16;

/**
 * A test for "this leaf has at least one face open to the outside".
 *
 * Occupancy is tracked at the FINEST leaf size present, and a leaf counts as exposed when
 * the cell just beyond the centre of any of its six faces is empty. Sampling face centres
 * rather than whole faces keeps this linear in leaf count — a coarse leaf spans many cells
 * per face, and the exact answer is not worth an O(area) scan for a vote weight.
 *
 * Leaves coarser than the finest size are treated as exposed: they only exist where detail
 * was already merged away, which is not the interior of a solid.
 */
function buildExposureTest(leaves: OctreeLeaf[]): (leaf: OctreeLeaf) => boolean {
    let unit = Infinity;
    for (const l of leaves) if (l.size < unit) unit = l.size;
    if (!Number.isFinite(unit) || unit <= 0) return () => true;

    const key = (x: number, y: number, z: number): string =>
        `${Math.round(x / unit)},${Math.round(y / unit)},${Math.round(z / unit)}`;
    const filled = new Set<string>();
    for (const l of leaves) {
        const span = Math.max(1, Math.round(l.size / unit));
        for (let dx = 0; dx < span; dx++) {
            for (let dy = 0; dy < span; dy++) {
                for (let dz = 0; dz < span; dz++) {
                    filled.add(key(l.x + dx * unit, l.y + dy * unit, l.z + dz * unit));
                }
            }
        }
    }
    return (leaf: OctreeLeaf): boolean => {
        if (leaf.size > unit + 1e-6) return true;
        const h = leaf.size * 0.5;
        return !filled.has(key(leaf.x + h - unit, leaf.y + h, leaf.z + h))
            || !filled.has(key(leaf.x + h + unit, leaf.y + h, leaf.z + h))
            || !filled.has(key(leaf.x + h, leaf.y + h - unit, leaf.z + h))
            || !filled.has(key(leaf.x + h, leaf.y + h + unit, leaf.z + h))
            || !filled.has(key(leaf.x + h, leaf.y + h, leaf.z + h - unit))
            || !filled.has(key(leaf.x + h, leaf.y + h, leaf.z + h + unit));
    };
}

/**
 * Coarsen a leaf list to `targetSize`: leaves already at or above the
 * target survive unchanged (power-of-two alignment guarantees they tile
 * whole target cells, so they can never overlap a coarsened cell); finer
 * leaves merge into their containing target cell with volume-weighted
 * majority color. `origin` anchors the target grid and MUST be the min corner
 * of the bounds the result will be encoded against: every emitted cell then
 * starts at `origin + n × targetSize` with n >= 0, which is exactly the range
 * `writeFragments` can represent.
 */
function coarsenLeaves(leaves: OctreeLeaf[], targetSize: number, origin: { x: number; y: number; z: number }): OctreeLeaf[] {
    const out: OctreeLeaf[] = [];
    type Candidate = { weight: number; r: number; g: number; b: number; emissive: number; slot: number; blockType: number; bone: number };
    // cell key → material key → accumulated volume weight
    const cells = new Map<string, Map<number, Candidate>>();
    const exposed = buildExposureTest(leaves);

    for (const leaf of leaves) {
        if (leaf.size >= targetSize - 1e-6) {
            out.push(leaf);
            continue;
        }
        const cx = Math.floor((leaf.x - origin.x) / targetSize + 1e-6);
        const cy = Math.floor((leaf.y - origin.y) / targetSize + 1e-6);
        const cz = Math.floor((leaf.z - origin.z) / targetSize + 1e-6);
        const cellKey = `${cx},${cy},${cz}`;
        // Quantise to 4 bits/channel — matches the file palette (RGB444),
        // so "same color" here equals "same palette entry" after encode.
        const colorKey = (Math.round(leaf.r * 15) << 8) | (Math.round(leaf.g * 15) << 4) | Math.round(leaf.b * 15);
        const emissive = leaf.emissive ?? 0;
        const slot = leaf.slot ?? 0;
        const blockType = leaf.blockType ?? 0;
        const bone = leaf.bone ?? 0;
        // Keyed by the full MATERIAL, not the colour: two cells of the same red
        // that belong to different slots must not pool their weight, or the
        // winner would carry one of the two materials arbitrarily.
        //
        // The owning joint joins the key even though a bone is spatial rather than
        // material (see `OctreeLeaf.bone`). Two voxels of one colour on two different
        // limbs are the ordinary case for a character, and pooling them would hand the
        // coarse cell whichever joint happened to win — an elbow's voxels swinging from
        // the opposite shoulder. Keeping them apart also satisfies the format's rule of
        // strictly one bone per cell, because the winning candidate carries exactly one.
        //
        // Bit budget: colour 12 + emissive 8 + slot 8 + blockType 16 + bone 8 = 52, one
        // under the 53 bits a double indexes exactly. A sixth column needs a real key.
        const materialKey = (((colorKey * 256 + Math.min(255, emissive)) * 256 + Math.min(255, slot))
            * 65536 + Math.min(65535, blockType)) * 256 + Math.min(255, bone);
        // Volume, biased hard toward voxels on the OUTSIDE. A coarse cell should look
        // like the surface it replaces, not like its fill: four grass on top of four
        // soil is grass from any distance you would ever see the coarse LOD from, but a
        // pure volume vote is a coin flip between them. Textured blocks make this visible
        // in a way colour never did — soil where grass should be reads as a bug.
        const weight = leaf.size * leaf.size * leaf.size * (exposed(leaf) ? SURFACE_VOTE_WEIGHT : 1);

        let colorMap = cells.get(cellKey);
        if (!colorMap) {
            colorMap = new Map();
            cells.set(cellKey, colorMap);
        }
        const entry = colorMap.get(materialKey);
        if (entry) entry.weight += weight;
        else colorMap.set(materialKey, { weight, r: leaf.r, g: leaf.g, b: leaf.b, emissive, slot, blockType, bone });
    }

    for (const [cellKey, colorMap] of cells) {
        const [cx, cy, cz] = cellKey.split(',').map(Number) as [number, number, number];
        // Two separate votes, because a light is not a colour.
        //
        // Colour takes the majority: a coarse cell should look like what it
        // replaces. A LIGHT must not, and this is the whole reason distant lamps
        // went dark — a bulb is by definition a handful of voxels inside a much
        // larger dark fixture, so it loses every volume vote it will ever be in.
        // Emissive material therefore wins by PRESENCE: if anything in the cell
        // glows, the cell glows, taking the strongest contributor's material and
        // its colour, so the lamp keeps its own hue rather than the pole's grey.
        let majority: Candidate | null = null;
        let lit: Candidate | null = null;
        for (const entry of colorMap.values()) {
            if (!majority || entry.weight > majority.weight) majority = entry;
            const isLit = entry.emissive > 0 || entry.slot > 0;
            if (!isLit) continue;
            if (!lit || entry.emissive > lit.emissive || (entry.emissive === lit.emissive && entry.weight > lit.weight)) {
                lit = entry;
            }
        }
        const best = lit ?? majority;
        if (!best) continue;
        out.push({
            x: origin.x + cx * targetSize,
            y: origin.y + cy * targetSize,
            z: origin.z + cz * targetSize,
            size: targetSize,
            r: best.r, g: best.g, b: best.b,
            ...(best.emissive > 0 ? { emissive: best.emissive } : {}),
            ...(best.slot > 0 ? { slot: best.slot } : {}),
            ...(best.blockType > 0 ? { blockType: best.blockType } : {}),
            // Whichever candidate won brought its joint with it, so the coarse cell
            // moves with the limb it came from. Without this every coarse level
            // decodes as bone 0 and a distant character animates from the root
            // alone — the v8 lesson (per-LOD slots), one column later.
            ...(best.bone > 0 ? { bone: best.bone } : {}),
        });
    }

    return out;
}

/**
 * Build an encodable VXL v3 payload from LIVE (edited) leaves.
 *
 * - Bounds are recomputed from the leaves (edits may grow the object).
 * - Coarser LODs are regenerated from the edited leaves, one per LOD
 *   level of the original file, at the original per-level voxel sizes —
 *   never round-tripped from the stale decode.
 * - The result is always single-fragment: leaf editing is only offered
 *   for single-fragment objects (pre-fragmented explodables keep their
 *   fragment tree and are not editable at the leaf level).
 */
export function buildEditedVxlV3Data(
    leaves: OctreeLeaf[],
    template: DecodedVxlV3 | null,
    fallback: { voxelSize: number; physicsGridStep: number; useAtlas: boolean },
    /**
     * The asset's material slots (indices 1..N), which the leaves' `slot`
     * column refers to. MUST be passed for any asset that has them: the
     * encoder writes the v7 slot section from this table, and omitting it
     * silently downgrades a slotted asset to v5/v6 — every named material,
     * and every light riding on one, gone on the first editor save.
     *
     * The editor may also have ADDED slots this session (a new emissive
     * material), so this is the live table, not `template.slots`.
     */
    slots: VoxelSlot[] = [],
): VxlV3Data {
    const minVoxelSize = template?.minVoxelSize ?? fallback.voxelSize;
    let maxLeafSize = minVoxelSize;
    for (const leaf of leaves) {
        if (leaf.size > maxLeafSize) maxLeafSize = leaf.size;
    }

    const bounds = computeLeafBounds(leaves);
    // The coarse grid is anchored at the bounds the fragments are WRITTEN
    // against, never at the original file's origin. `writeFragments` encodes
    // every LOD as `round((leaf.x - bounds.minX) / lodVoxelSize)`, so a coarse
    // cell starting before `bounds.min` encodes as a negative coordinate and the
    // whole save throws. Anchoring here guarantees `cx >= 0`, exactly as a fresh
    // bake does by coarsening from its own bounds.
    //
    // Anchoring at the ORIGINAL origin only held while that origin equalled the
    // tight extent of the leaves, and for a voxelized asset it routinely does
    // not — the bake stores the source model's AABB, which sits outside the
    // snapped voxel grid. A real case: bounds min X -1.25 with the first leaf at
    // -1.0625, three cells in. Re-encoding recomputed the tight -1.0625 while
    // the 0.25 grid still started at -1.25, so the first coarse cell began 0.75
    // of a cell BELOW the minimum and encoded as -1 — "VXL3 grid coord overflow:
    // (-1, 0, 0)". No edit had to move anything; changing a material was enough,
    // because every save re-encodes every LOD.
    const lodOrigin = { x: bounds.minX, y: bounds.minY, z: bounds.minZ };

    let additionalLods: VxlV3LodLevel[] | undefined;
    const templateLods = template?.additionalLods;
    if (templateLods && templateLods.length > 0) {
        additionalLods = templateLods.map((lod) => {
            const coarse = coarsenLeaves(leaves, lod.minVoxelSize, lodOrigin);
            const lodBounds = computeLeafBounds(coarse);
            return {
                minVoxelSize: lod.minVoxelSize,
                maxVoxelSize: Math.max(lod.maxVoxelSize, maxLeafSize),
                fragments: [{
                    aabbMin: [lodBounds.minX, lodBounds.minY, lodBounds.minZ] as [number, number, number],
                    aabbMax: [lodBounds.maxX, lodBounds.maxY, lodBounds.maxZ] as [number, number, number],
                    leaves: coarse,
                }],
            };
        });
    }

    return {
        minVoxelSize,
        maxVoxelSize: Math.max(template?.maxVoxelSize ?? 0, maxLeafSize),
        physicsGridStep: template?.physicsGridStep ?? fallback.physicsGridStep,
        bounds,
        useAtlas: template?.useAtlas ?? fallback.useAtlas,
        fragments: [{
            aabbMin: [bounds.minX, bounds.minY, bounds.minZ],
            aabbMax: [bounds.maxX, bounds.maxY, bounds.maxZ],
            leaves,
        }],
        ...(additionalLods ? { additionalLods } : {}),
        // The slot table names the slots for EVERY level: `coarsenLeaves` carries
        // the emissive/slot columns into the coarse levels and the encoder writes
        // them per LOD (v8), so a light stays lit — and stays runtime-controllable
        // — past the first LOD switch.
        ...(slots.length > 0 ? { slots } : {}),
        // The rig, for exactly the same reason and with the same failure mode one
        // version further on. Present ⇒ the file is written as v10; omitted ⇒ the
        // encoder writes v9 or lower and the skeleton is GONE — the character keeps
        // its voxels and stops being a character. Measured on a sample before this
        // line existed: 3859 leaves carrying a bone became 0, and the file shrank
        // from 5077 to 3615 bytes, on a save the creator asked for by nudging one
        // voxel. Taken from the template because the editor never edits the rig;
        // the per-leaf bone column rides on the leaves themselves.
        ...(template?.rig ? { rig: rigToEncodeInput(template.rig) } : {}),
        // And the parts table the rig's joints are named by (v12), for the same reason.
        ...(template?.parts && template.parts.length > 0 ? { parts: template.parts } : {}),
    };
}
