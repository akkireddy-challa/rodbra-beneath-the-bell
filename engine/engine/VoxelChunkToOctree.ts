/**
 * Convert a legacy chunk-backed `VoxelObject` into octree leaves.
 *
 * The legacy `{"chunks": …}` JSON is the format every procedurally BUILT object
 * lands in, because `VoxelObjectBuilder` never sets `_isOctreeV2` and
 * `toVXL()`'s last branch serialises chunks. That format is both wasteful (JSON
 * text vs a gzipped columnar binary) and a dead end: material slots — and
 * therefore all controllable glow — are a VXL3 v7 feature that lives in the
 * leaf `slot` column, so a chunk asset can never light up.
 *
 * Converting is lossless for colour-only objects, which is what procedural
 * builders and hand-painted props actually are. It is REFUSED for anything
 * using textured atlas block types: a leaf carries a colour, not a block, so
 * grass and stone would flatten into paint.
 *
 * Coordinate contract: `getVoxelData()` returns pivot-relative MIN corners, and
 * the conversion anchors the octree pivot at the origin, so leaf space and the
 * chunk mesh's local space coincide and geometry lands exactly where it was.
 */

import * as THREE from 'three';
import { BlockType } from 'engine/VoxelTextureAtlas.js';
import type { VoxelObject } from 'engine/VoxelObject.js';
import type { OctreeLeaf } from 'engine/VoxelOctreeRenderer.js';
import { packRgb444 } from 'engine/VoxelOctreeRenderer.js';
import { atlasCellToLinearRgb, rgb888ToAtlasCell } from 'engine/vxlscene/atlasColor.js';
import type { VoxelSlot } from 'engine/VoxelMaterialSlots.js';

/**
 * Leaf r/g/b for an 0xRRGGBB colour, in whichever space this object's palette
 * cells are quantised from — so the value survives `colorToCell` on save.
 *
 * Atlas cells bake the sRGB OETF in at encode time, so the stored float has to
 * be the LINEAR preimage; vertex-colour cells are plain RGB444 fractions.
 * Mixing the two shifts every mid-tone several palette steps.
 */
function leafRgbForColor(rgb24: number, useAtlas: boolean): { r: number; g: number; b: number } {
    const r8 = (rgb24 >> 16) & 0xff, g8 = (rgb24 >> 8) & 0xff, b8 = rgb24 & 0xff;
    if (useAtlas) return atlasCellToLinearRgb(rgb888ToAtlasCell(r8, g8, b8));

    const linear = new THREE.Color().setHex(rgb24, THREE.SRGBColorSpace);
    const cell = packRgb444(linear.r, linear.g, linear.b);
    return { r: ((cell >> 8) & 0xf) / 15, g: ((cell >> 4) & 0xf) / 15, b: (cell & 0xf) / 15 };
}

/**
 * Whether this object can be converted without losing anything.
 *
 * Textured BLOCK TYPES used to disqualify an object here, because the octree form could
 * only carry colour — so every textured asset fell through to the legacy JSON writer and
 * stayed there. VXL3 v9 carries a block type per palette entry, so that exclusion is gone
 * and this is now simply "is there anything to convert".
 */
export function canConvertChunkObjectToOctree(object: VoxelObject): boolean {
    if (object.isOctreeV2) return false;
    return object.getVoxelData().length > 0;
}

/**
 * Convert in place, optionally installing a material-slot table. Returns false
 * when the object is already octree or uses textured blocks.
 *
 * `slotOf` maps a voxel's colour to a slot index — how a procedural builder
 * says "the bulb voxels are the `light` material". Omit for a plain conversion.
 */
export function convertChunkObjectToOctree(
    object: VoxelObject,
    slots: VoxelSlot[] = [],
    slotOf?: (voxel: { x: number; y: number; z: number; blockType: number; color: number }) => number,
    /** Owning smart-object joint per voxel (0 = body) — see engine/VxlV3Parts.ts. */
    boneOf?: (voxel: { x: number; y: number; z: number }) => number,
): boolean {
    if (!canConvertChunkObjectToOctree(object)) return false;

    const data = object.getVoxelData();
    const size = object.getVoxelSize();
    const useAtlas = object.useAtlas;
    const leaves: OctreeLeaf[] = data.map((v) => {
        const { r, g, b } = leafRgbForColor(v.color, useAtlas);
        return {
            x: v.x, y: v.y, z: v.z, size, r, g, b,
            slot: slotOf ? slotOf(v) : 0,
            // COLOR is the "no texture" sentinel; anything else names an atlas tile.
            ...(v.blockType !== BlockType.COLOR ? { blockType: v.blockType } : {}),
            ...(boneOf ? (() => { const bone = boneOf(v); return bone > 0 ? { bone } : {}; })() : {}),
        };
    });

    if (slots.length > 0) object.setSlotsForEdit(slots);
    object.initFromOctreeLeaves(leaves, size, { x: 0, y: 0, z: 0 });
    // Mark the leaves edited, or `toVXL()` matches neither octree branch — it
    // needs `_octreeLeafEdited` for the encode-from-live-leaves path and
    // `_vxlV3Data` for the round-trip one, and a converted object has neither.
    // It then falls through to the legacy chunk branch and serialises the (now
    // empty) chunk store: a converted object saved as `{"chunks":{}}`.
    object.setOctreeLeavesForEdit(leaves);
    return true;
}
