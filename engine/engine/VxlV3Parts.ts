/**
 * VXL3 v12 — the SMART-OBJECT PARTS section.
 *
 * A windmill's blades turn, a ferris wheel's cabins hang level while the wheel
 * rotates, a shop sign swings. v12 lets a static prop declare those parts as
 * DATA: which voxels belong to which part, where each part pivots, and how it
 * moves — so one runtime system animates every such prop and no game ever
 * writes per-object code for it.
 *
 * ── The voxel-to-part mapping is the v10 RIG, reused ─────────────────────────
 *
 * v10 already carries a per-leaf owning-joint column at every LOD, and every
 * path that touches leaves — the editor's coarsen and re-encode, explosion
 * fragments, the LOD pass — already preserves it. So a smart object is written
 * as a rig whose skeleton is `PARTS_SKELETON_REF` (`parts-v1`): joint 0 is the
 * static body, joints 1..N are the parts, and `bindPositions` are the part
 * pivots as LOCAL offsets from each parent, exactly the semantics a character
 * rig gives them. What v10 cannot store is the part NAMES, HIERARCHY and MOTION
 * — a character gets those from a shared skeleton table by name, and a windmill
 * has no shared table — so that is what this section adds.
 *
 * Nothing in the static path reads the rig (`VoxelObject` never does), so a
 * v12 prop loaded by a reader that ignores this section renders as the static
 * shell it always was. Only `SmartObjectView` splits it.
 *
 * ── Layout ───────────────────────────────────────────────────────────────────
 *
 * Appended after the v11 eye section, announced by `VXL3_SECTION_PARTS` in
 * header byte 46 (the section bitfield v11 introduced; see VxlV3MaterialClass.ts
 * for why optional sections are DECLARED from v11 on):
 *
 *   uint8    partCount           (= rig jointCount - 1; parts are joints 1..N)
 *   per part, in joint order:
 *     uint8    nameLength
 *     bytes    name              (UTF-8, <= VOXEL_PART_NAME_MAX)
 *     uint8    parentJoint       (0 = the body, else another part's joint)
 *     uint8    motionKind        (MOTION_KIND_* below)
 *     3 x float32  axis          (unit vector, model space; spin/pendulum)
 *     float32  speed             (rpm for spin; 0 otherwise)
 *     float32  amplitude         (degrees, pendulum; 0 otherwise)
 *     float32  period            (seconds, pendulum; 0 otherwise)
 *
 * A fixed 20-byte motion record rather than a per-kind payload, because the
 * closed vocabulary is four kinds and the reader must never guess a length.
 */

import type { VoxelSkeletonRef } from 'engine/VxlV3Rig.js';

/** The v12 parts section is present. Bits 0-3 are taken by v11 (see VxlV3MaterialClass.ts, VxlV3Eyes.ts). */
export const VXL3_SECTION_PARTS = 1 << 4;

/** The `skeletonRef` a smart object's rig carries. Never in `SKELETON_REFS`: its joints come from this section. */
export const PARTS_SKELETON_REF = 'parts-v1';

/** Longest part name the file stores. */
export const VOXEL_PART_NAME_MAX = 32;

/** Hard ceiling on parts, so the bone column stays one byte per leaf with room for the body. */
export const VOXEL_MAX_PARTS = 254;

export const MOTION_KIND_NONE = 0;
export const MOTION_KIND_SPIN = 1;
export const MOTION_KIND_UPRIGHT = 2;
export const MOTION_KIND_PENDULUM = 3;

/** The closed motion vocabulary. Mirrors `SmartObjectMotion` in types/smartObject.ts. */
export type VxlV3PartMotion =
    | { kind: 'spin'; axis: [number, number, number]; rpm: number }
    /** Hangs from a hinge on its parent and stays level while the parent turns. */
    | { kind: 'upright' }
    | { kind: 'pendulum'; axis: [number, number, number]; amplitudeDeg: number; periodS: number }
    | { kind: 'none' };

/** One part, as stored. The pivot is NOT here — it is the rig's bind position for joint `index + 1`. */
export interface VxlV3Part {
    name: string;
    /** Joint index of the parent: 0 for the body, else `1 + partIndex` of another part. */
    parentJoint: number;
    motion: VxlV3PartMotion;
}

const MOTION_RECORD_BYTES = 1 + 12 + 4 + 4 + 4;

function motionKindByte(motion: VxlV3PartMotion): number {
    switch (motion.kind) {
        case 'spin': return MOTION_KIND_SPIN;
        case 'upright': return MOTION_KIND_UPRIGHT;
        case 'pendulum': return MOTION_KIND_PENDULUM;
        default: return MOTION_KIND_NONE;
    }
}

function encodedName(name: string): Uint8Array {
    return new TextEncoder().encode(name.slice(0, VOXEL_PART_NAME_MAX));
}

/** Byte size of the section for these parts. */
export function partsSectionBytes(parts: readonly VxlV3Part[]): number {
    let total = 1;
    for (const part of parts) {
        total += 1 + encodedName(part.name).byteLength + 1 + MOTION_RECORD_BYTES;
    }
    return total;
}

/**
 * Write the section at `cursor`. Returns the new cursor.
 *
 * `parts` must be in joint order (part i is joint i + 1), the same order the
 * rig's `bindPositions` and the per-leaf bone column use — the section is what
 * gives those joints their names, so the two cannot be allowed to disagree.
 */
export function writePartsSection(
    view: DataView,
    bytes: Uint8Array,
    cursorIn: number,
    parts: readonly VxlV3Part[],
): number {
    let cursor = cursorIn;
    bytes[cursor] = parts.length;
    cursor += 1;
    for (const part of parts) {
        const name = encodedName(part.name);
        bytes[cursor] = name.byteLength;
        cursor += 1;
        bytes.set(name, cursor);
        cursor += name.byteLength;
        bytes[cursor] = part.parentJoint;
        cursor += 1;

        const motion = part.motion;
        bytes[cursor] = motionKindByte(motion);
        cursor += 1;
        const axis = motion.kind === 'spin' || motion.kind === 'pendulum' ? motion.axis : [0, 0, 0];
        view.setFloat32(cursor + 0, axis[0]!, true);
        view.setFloat32(cursor + 4, axis[1]!, true);
        view.setFloat32(cursor + 8, axis[2]!, true);
        cursor += 12;
        view.setFloat32(cursor, motion.kind === 'spin' ? motion.rpm : 0, true);
        cursor += 4;
        view.setFloat32(cursor, motion.kind === 'pendulum' ? motion.amplitudeDeg : 0, true);
        cursor += 4;
        view.setFloat32(cursor, motion.kind === 'pendulum' ? motion.periodS : 0, true);
        cursor += 4;
    }
    return cursor;
}

export interface ReadPartsResult {
    parts: VxlV3Part[];
    cursor: number;
}

/** Read the section at `cursor`. Throws on truncation rather than guessing. */
export function readPartsSection(view: DataView, bytes: Uint8Array, cursorIn: number): ReadPartsResult {
    let cursor = cursorIn;
    const decoder = new TextDecoder();
    const need = (n: number, what: string): void => {
        if (cursor + n > bytes.byteLength) throw new Error(`VXL12 parts section truncated reading ${what}`);
    };

    need(1, 'part count');
    const count = bytes[cursor]!;
    cursor += 1;
    const parts: VxlV3Part[] = [];
    for (let i = 0; i < count; i++) {
        need(1, `part ${i + 1} name length`);
        const nameLength = bytes[cursor]!;
        cursor += 1;
        need(nameLength + 1 + MOTION_RECORD_BYTES, `part ${i + 1}`);
        const name = decoder.decode(bytes.subarray(cursor, cursor + nameLength));
        cursor += nameLength;
        const parentJoint = bytes[cursor]!;
        cursor += 1;
        const kind = bytes[cursor]!;
        cursor += 1;
        const axis: [number, number, number] = [
            view.getFloat32(cursor + 0, true),
            view.getFloat32(cursor + 4, true),
            view.getFloat32(cursor + 8, true),
        ];
        cursor += 12;
        const speed = view.getFloat32(cursor, true);
        cursor += 4;
        const amplitude = view.getFloat32(cursor, true);
        cursor += 4;
        const period = view.getFloat32(cursor, true);
        cursor += 4;

        let motion: VxlV3PartMotion;
        switch (kind) {
            case MOTION_KIND_SPIN: motion = { kind: 'spin', axis, rpm: speed }; break;
            case MOTION_KIND_UPRIGHT: motion = { kind: 'upright' }; break;
            case MOTION_KIND_PENDULUM: motion = { kind: 'pendulum', axis, amplitudeDeg: amplitude, periodS: period }; break;
            // An unknown kind from a newer vocabulary loads as a static part rather than
            // failing the asset — the same stance the material-class section takes.
            default: motion = { kind: 'none' };
        }
        parts.push({ name, parentJoint, motion });
    }
    return { parts, cursor };
}

/**
 * The skeleton a `parts-v1` rig resolves to: joint 0 is the body, joints 1..N
 * the parts, parents from the table, identity bind rotations throughout — a
 * part's rest pose is the pose it was voxelized in.
 *
 * This is the smart-object counterpart of `resolveSkeletonRef`, which looks a
 * ref up in `SKELETON_REFS`; a parts skeleton cannot live there because every
 * prop has its own.
 */
export function partsSkeleton(parts: readonly VxlV3Part[]): VoxelSkeletonRef {
    const joints = ['body', ...parts.map((part) => part.name)];
    const parents = [-1, ...parts.map((part) => part.parentJoint)];
    const rotations = new Float32Array(joints.length * 4);
    for (let i = 0; i < joints.length; i++) rotations[i * 4 + 3] = 1;
    return { joints, parents, rotations };
}

/**
 * Validate a parts table against the rig it must pair with. Returns a message
 * describing the first problem, or null when consistent. Used by the encoder,
 * because a mismatch here is a file that decodes and then animates the wrong
 * voxels — a failure with no error attached.
 */
export function validateParts(parts: readonly VxlV3Part[], jointCount: number): string | null {
    if (parts.length > VOXEL_MAX_PARTS) return `${parts.length} parts exceeds the limit of ${VOXEL_MAX_PARTS}`;
    if (jointCount !== parts.length + 1) {
        return `parts table has ${parts.length} entries but the rig has ${jointCount} joints (expected ${parts.length + 1})`;
    }
    const seen = new Set<string>();
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!;
        if (!part.name) return `part ${i + 1} has no name`;
        if (seen.has(part.name)) return `part name "${part.name}" is used twice`;
        seen.add(part.name);
        const joint = i + 1;
        if (part.parentJoint < 0 || part.parentJoint > parts.length) {
            return `part "${part.name}" parents joint ${part.parentJoint}, which does not exist`;
        }
        // Parents-first is what lets one forward pass compose world transforms.
        if (part.parentJoint >= joint) {
            return `part "${part.name}" (joint ${joint}) must come after its parent (joint ${part.parentJoint})`;
        }
    }
    return null;
}
