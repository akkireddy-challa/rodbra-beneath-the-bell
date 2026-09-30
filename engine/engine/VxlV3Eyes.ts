/**
 * VXL v11 EYE section — eyes as METADATA, never as baked voxels.
 *
 * Jani, 2026-09-01: "we don't add eye geometry in the mesh... we add metadata
 * where eyes are, and the color and shape. If we add geometry, we can't modify
 * it easily in runtime." Eyes are realtime decoration — the runtime draws a
 * replaceable eye (round, sub-voxel, blinking, gaze-aimed) from this record.
 * Baking them into voxel cells froze all of that, so no `.vxl` carries eye
 * cells any more; it carries this instead.
 *
 * The record exploits the pipeline's guarantee that a pair is CONSTRUCTED
 * symmetric (same row, same depth, same distance from centre, same size — see
 * charforge eye_placement.py), so it stores the shared geometry once plus a
 * half-gap rather than two independent eyes. Fixed 19 bytes, no strings, no
 * arrays, no counts: presence is declared by the header section bit, and there
 * is always exactly one symmetric pair.
 *
 *   offset size field
 *   0      1    type      uint8   (0 = classic white/pupil, 1 = dark socket)
 *   1      1    w         uint8   eye box width  in grid cells
 *   2      1    h         uint8   eye box height in grid cells
 *   3      4    centreX   float32 grid X of the midpoint between the eyes
 *   7      4    y         float32 grid Y (the row both eyes sit on)
 *   11     4    z         float32 grid Z (depth of the eye plane)
 *   15     4    halfGap   float32 grid-X distance from the midpoint to each eye
 *
 * Coordinates are in the file's LEAF GRID (the same integer voxel lattice the
 * fragments use), so the runtime places eyes directly against the decoded mesh
 * with no extra transform. float32 because eyes are explicitly allowed to sit
 * off the lattice; the 16 float bytes are one record per BODY, not per voxel.
 */

/** The v11 eye section is present (header byte 46, bit 3). */
export const VXL3_SECTION_EYES = 1 << 3;

/** Bytes of one eye record. Fixed — the section is always exactly this size. */
export const EYE_SECTION_BYTES = 19;

export type EyeType = 'classic' | 'dark';

export interface EyeMeta {
    type: EyeType;
    /** Eye box width in grid cells. */
    w: number;
    /** Eye box height in grid cells. */
    h: number;
    /** Grid X of the midpoint between the two eyes. */
    centreX: number;
    /** Grid Y — the row both eyes sit on. */
    y: number;
    /** Grid Z — depth of the eye plane. */
    z: number;
    /** Grid-X distance from the midpoint to each eye centre. */
    halfGap: number;
}

/** A grid-cell dimension as the uint8 the record stores it in. */
function toByte(value: number): number {
    return Math.max(0, Math.min(255, Math.round(value)));
}

/** Write the eye section at `cursor`. Returns the new cursor. */
export function writeEyeSection(view: DataView, cursor: number, eyes: EyeMeta): number {
    view.setUint8(cursor, eyes.type === 'dark' ? 1 : 0);
    view.setUint8(cursor + 1, toByte(eyes.w));
    view.setUint8(cursor + 2, toByte(eyes.h));
    view.setFloat32(cursor + 3, eyes.centreX, true);
    view.setFloat32(cursor + 7, eyes.y, true);
    view.setFloat32(cursor + 11, eyes.z, true);
    view.setFloat32(cursor + 15, eyes.halfGap, true);
    return cursor + EYE_SECTION_BYTES;
}

/** Read the eye section at `cursor`. Returns the record and the new cursor. */
export function readEyeSection(view: DataView, cursor: number): { eyes: EyeMeta; cursor: number } {
    if (cursor + EYE_SECTION_BYTES > view.byteLength) {
        throw new Error('VXL11 eye section truncated');
    }
    const eyes: EyeMeta = {
        type: view.getUint8(cursor) === 1 ? 'dark' : 'classic',
        w: view.getUint8(cursor + 1),
        h: view.getUint8(cursor + 2),
        centreX: view.getFloat32(cursor + 3, true),
        y: view.getFloat32(cursor + 7, true),
        z: view.getFloat32(cursor + 11, true),
        halfGap: view.getFloat32(cursor + 15, true),
    };
    return { eyes, cursor: cursor + EYE_SECTION_BYTES };
}
