/**
 * VXL3 v10 — the optional RIGGED CHARACTER section.
 *
 * A rigged character is an *optional capability* of a `.vxl` file, not a new
 * format: one loader, one extension, and a file says for itself whether it
 * carries a rig. Everything here is appended AFTER the v9 block-type section,
 * so every byte before it is identical to the version the asset would
 * otherwise have been, and a v3–v9 reader that stops earlier renders the same
 * static object it always did.
 *
 * WHY A PER-LEAF COLUMN, NOT A PALETTE COLUMN
 * ───────────────────────────────────────────
 * v7 (slot) and v9 (block type) hang off the palette, because both are
 * MATERIAL properties: a colour cell plus a slot identifies an entry, and every
 * voxel sharing that entry shares the property. A bone is not a material. The
 * same red appears on the left arm and the right arm, and those voxels must
 * move with different bones — folding the bone into the palette key would
 * multiply the table by the bone count and shove `paletteIdxBytes` past the
 * 256-entry cliff on assets that are nowhere near it today. So the bone is its
 * own per-LEAF column, written in leaf order, exactly parallel to gx/gy/gz.
 *
 * It costs one byte per leaf before compression and far less after: bone ids
 * are spatially coherent, the leaf order is spatially coherent, and a body uses
 * at most 22 distinct values, so the column is mostly long runs. Measured over
 * the 424 approved bodies, a whole rigged character — geometry, colour, rig —
 * gzips to a median of about 7 KB against a 3.5 MB GLB.
 *
 * ONE BONE PER VOXEL
 * ──────────────────
 * There are no weights. Ownership is a single bone index, and that is a deliberate
 * choice by the generator, not a lossy summary of one. `voxel_skin_glb.py` takes
 * the nearest capsule only and says why:
 *
 *   "RIGID binding — the .bmch/frameMode-'bone' aesthetic. Soft blending sheared
 *    voxel rows into wafer slices; the game look is rigid voxels with joint
 *    overlap, not skin-smooth deformation."
 *
 * Verified across the approved corpus: every vertex of every body carries exactly
 * one influence at weight 1.0. (That file's own docstring still advertises
 * "two-nearest-capsule sigmoid weights" — it is stale, and the code above it is
 * what shipped.)
 *
 * So this is a different and cheaper animation model, not a simplification: a
 * voxel bound to one bone transforms RIGIDLY, so a cube stays a cube under
 * rotation instead of shearing, and the runtime needs one matrix per bone rather
 * than per-vertex blending. The `.bmch` block-character path already animates
 * this way; this section carries the same idea for a dense voxel grid rather than
 * for boxes — which is also why the joint fillers below exist, and why face
 * culling must never merge across two different bones.
 *
 * WHAT THE FILE STORES AND WHAT IT REFERENCES
 * ───────────────────────────────────────────
 * The skeleton is NOT in the file — every character shares it, and duplicating
 * a joint hierarchy 424 times to say "Mixamo, 22 joints" is waste. The file
 * stores a `skeletonRef` string and the engine resolves the names, order and
 * bind ROTATIONS from `SKELETON_REFS` below.
 *
 * The bind POSITIONS are per character and must be stored: bodies are fitted to
 * their own proportions, so a dwarf and an ogre share a skeleton but not a bind
 * pose. This is the exact split the generator already makes — `voxel_skin_glb.py`
 * builds "the 22 fitted joints as a mixamorig-named hierarchy, bind locals =
 * joint deltas", with the ORIENTATIONS taken from the canonical skeleton and only
 * the deltas fitted. Confirmed in the corpus: bind rotations are bit-identical on
 * every body (max delta exactly 0) and match `canonical-skeleton.ts` to float32,
 * while positions differ by up to 0.38 — the canonical rule that proportions scale
 * bone LENGTHS and never touch orientations, visible in the data.
 *
 * So a bind pose is `jointCount * 3` floats of LOCAL translation (each joint's
 * offset from its parent), 264 bytes for a 22-joint character, and the rotations
 * and hierarchy come free from the ref.
 *
 * JOINT FILLERS
 * ─────────────
 * A rigged body carries a second, smaller class of cube: an inset box that
 * plugs the gap a joint opens when it bends. They are not surface voxels —
 * they sit INSIDE a cell at 96% scale, invisible in bind pose, and they are
 * owned by the bone ACROSS the joint from the cell they occupy, which is
 * exactly why they cannot live in the main grid: two bones, one cell. On the
 * measured corpus a body has ~650 of them against ~5,900 surface voxels, and
 * 65% share a cell with a surface voxel that has a different bone.
 *
 * They are stored explicitly rather than regenerated, because they are not
 * derivable from a neighbour rule — only 227 of 522 on the reference body carry
 * a bone that any 6-neighbour surface voxel also carries. They are LOD 0 only:
 * they exist to hide a seam at conversational distance, and a coarse LOD has no
 * seam that fine.
 */

/** Longest `skeletonRef` string the header will store. */
export const VOXEL_SKELETON_REF_MAX = 32;

/** Longest socket name. Sockets are few and named by hand; this is a sanity bound. */
export const VOXEL_SOCKET_NAME_MAX = 32;

/** Hard ceiling on joints, so the bone column stays one byte per leaf. */
export const VOXEL_MAX_JOINTS = 255;

/**
 * A named attachment point on the rig.
 *
 * Heads are swappable (`head.library`) and tails are stripped at build and
 * re-added procedurally at runtime, so where a part attaches is real data, not
 * something to re-derive by scanning geometry at load. `offset` is in the
 * character's model space, the same space as `bindPositions`.
 */
export interface VxlV3Socket {
    name: string;
    /** Index into the skeleton's joint list. */
    joint: number;
    offset: [number, number, number];
}

/**
 * One joint-filler cube: grid coords in LOD 0's `minVoxelSize`, relative to
 * `bounds.min`, exactly like a leaf.
 *
 * Parallel typed arrays, never an array of objects — the same rule the rest of
 * the voxel path follows, for the same reason.
 */
export interface VxlV3Fillers {
    /** Length of every column below. */
    count: number;
    gx: Uint16Array;
    gy: Uint16Array;
    gz: Uint16Array;
    /** Owning joint index, one per filler. */
    bone: Uint8Array;
    /** RGB444 colour cell, one per filler. Stored directly rather than through
     *  the palette: fillers are few, and a palette index would tie this section
     *  to the LOD 0 palette width for no measurable gain. */
    color: Uint16Array;
}

/** The decoded rig. Absent from `DecodedVxlV3` entirely when the file has no rig. */
export interface VxlV3Rig {
    /** Key into `SKELETON_REFS` — names, order and bind rotations. */
    skeletonRef: string;
    /** `jointCount * 3` bind LOCAL translations — each joint's offset from its parent,
     *  parallel to the ref's joint list. The rotations and hierarchy come from the ref;
     *  these deltas are what the body's own proportions changed. */
    bindPositions: Float32Array;
    /** Per-leaf owning joint, LOD 0 fragments concatenated in write order. */
    bones: Uint8Array;
    /** Per-leaf owning joint for each coarser LOD, same ordering rule. */
    lodBones: Uint8Array[];
    fillers: VxlV3Fillers;
    sockets: VxlV3Socket[];
}

/**
 * A decoded rig, narrowed to what the ENCODER takes (`VxlV3RigInput`).
 *
 * The two bone columns are dropped deliberately, not forgotten: the encoder reads
 * the owning joint off `OctreeLeaf.bone` in leaf order, so its own ordering stays
 * the single source of truth and a re-save cannot hand back a column that no longer
 * lines up with leaves the editor added or deleted.
 *
 * Lives here, in the one voxel module with no imports at all, so the re-save paths
 * (`buildEditedVxlV3Data`, `decodedToEncodable`) can share it without either of them
 * taking on a runtime dependency — and so there is ONE place that decides what
 * survives a round trip. Two hand-rolled field picks would be free to drift, and the
 * failure mode of that drift is a character that quietly stops being rigged.
 */
export function rigToEncodeInput(rig: VxlV3Rig): Omit<VxlV3Rig, 'bones' | 'lodBones'> {
    return {
        skeletonRef: rig.skeletonRef,
        bindPositions: rig.bindPositions,
        fillers: rig.fillers,
        sockets: rig.sockets,
    };
}

/**
 * A shared skeleton, referenced by name from the file.
 *
 * `rotations` is each joint's bind LOCAL orientation as a quaternion (x,y,z,w),
 * flattened, and `parents` is the hierarchy those locals compose through. Both
 * live here and not in the file because they are identical on every character
 * built against this skeleton — verified across the corpus — and because the
 * engine applies clip world rotations with NO bind compensation, so they must
 * stay bit-identical to what the clips were authored against. A body that needs
 * different orientations needs a different ref, not a patched file.
 */
export interface VoxelSkeletonRef {
    joints: readonly string[];
    /** Parent index per joint, -1 for the root. Parents always precede children. */
    parents: readonly number[];
    /** Bind LOCAL rotation per joint as (x,y,z,w), flattened. */
    rotations: Float32Array;
}

/**
 * `mixamo-22-v1` — the 22-joint canonical Mixamo skeleton the forged bodies are
 * built against: the full rig minus the 30 finger joints, which live on the far
 * side of the wrist cut and never receive voxels.
 *
 * Names are in three.js GLTFLoader form (colon stripped), the same names every
 * clip skeleton has after loading, so name matching never crosses a
 * sanitization boundary. Order IS the joint index order used by the bone column
 * and by `bindPositions`.
 */
const MIXAMO_22_JOINTS: readonly string[] = [
    'mixamorigHips',
    'mixamorigSpine',
    'mixamorigSpine1',
    'mixamorigSpine2',
    'mixamorigNeck',
    'mixamorigHead',
    'mixamorigLeftShoulder',
    'mixamorigLeftArm',
    'mixamorigLeftForeArm',
    'mixamorigLeftHand',
    'mixamorigRightShoulder',
    'mixamorigRightArm',
    'mixamorigRightForeArm',
    'mixamorigRightHand',
    'mixamorigLeftUpLeg',
    'mixamorigLeftLeg',
    'mixamorigLeftFoot',
    'mixamorigLeftToeBase',
    'mixamorigRightUpLeg',
    'mixamorigRightLeg',
    'mixamorigRightFoot',
    'mixamorigRightToeBase',
];

/** Parent index per joint, -1 for the root; parents-first, so one forward pass composes world matrices. */
const MIXAMO_22_PARENTS: readonly number[] = [
    -1, 0, 1, 2, 3, 4, 3, 6, 7, 8, 3, 10, 11, 12, 0, 14, 15, 16, 0, 18, 19, 20,
];

/**
 * Bind LOCAL rotations for `mixamo-22-v1`, (x,y,z,w) per joint in
 * `MIXAMO_22_JOINTS` order — the canonical Mixamo bind, identical to the 22
 * corresponding entries of `canonical-skeleton.ts` and to what every approved
 * body carries on its skin nodes.
 */
const MIXAMO_22_ROTATIONS = new Float32Array([
    0.006458546, 0, 0, 0.999979143,                         // mixamorigHips
    -0.080155432, 0, 0, 0.996782377,                        // mixamorigSpine
    0, 0, 0, 1,                                             // mixamorigSpine1
    0.012885409, 0, 0, 0.99991698,                          // mixamorigSpine2
    0, 0, 0, 1,                                             // mixamorigNeck
    0, 0, 0, 1,                                             // mixamorigHead
    0.484423023, 0.570969979, -0.526161886, 0.403089677,    // mixamorigLeftShoulder
    -0.024607434, -0.002561554, 0.103503846, 0.994321309,   // mixamorigLeftArm
    0, 0, 0, 1,                                             // mixamorigLeftForeArm
    0, 7.72e-07, 0, 1,                                      // mixamorigLeftHand
    -0.484430338, 0.57096406, -0.526163338, -0.403087375,   // mixamorigRightShoulder
    -0.024615668, 0.002562238, -0.103498588, 0.994321651,   // mixamorigRightArm
    0, 0, 0, 1,                                             // mixamorigRightForeArm
    0, 3.483e-06, 0, 1,                                     // mixamorigRightHand
    0, 0.010367943, 0.999946251, 0,                         // mixamorigLeftUpLeg
    -0.038112249, 0, 0, 0.999273464,                        // mixamorigLeftLeg
    0.459748812, 0, 0, 0.888049002,                         // mixamorigLeftFoot
    0.335241104, 0, 0, 0.94213237,                          // mixamorigLeftToeBase
    0, 0.010356599, 0.999946369, 0,                         // mixamorigRightUpLeg
    -0.03809132, 0, 0, 0.999274262,                         // mixamorigRightLeg
    0.459740287, 0, 0, 0.888053415,                         // mixamorigRightFoot
    0.335241926, 0, 0, 0.942132077,                         // mixamorigRightToeBase
]);

/** Every skeleton a `.vxl` rig may reference, by name. */
export const SKELETON_REFS: Readonly<Record<string, VoxelSkeletonRef>> = {
    'mixamo-22-v1': {
        joints: MIXAMO_22_JOINTS,
        parents: MIXAMO_22_PARENTS,
        rotations: MIXAMO_22_ROTATIONS,
    },
};

/** The ref a rig names, or null when the engine does not know it. */
export function resolveSkeletonRef(ref: string): VoxelSkeletonRef | null {
    return SKELETON_REFS[ref] ?? null;
}

/** Joint count for a ref, or 0 when unknown. */
export function skeletonJointCount(ref: string): number {
    return SKELETON_REFS[ref]?.joints.length ?? 0;
}

// ─── Section sizing / encode / decode ──────────────────────────────────────
//
// Layout, appended after the v9 block-type section:
//
//   uint8    skeletonRefLength
//   bytes    skeletonRef (UTF-8, <= VOXEL_SKELETON_REF_MAX)
//   uint8    jointCount
//   jointCount x 3 x float32   bind positions (model space)
//   lod0LeafCount x uint8      bone index, LOD 0 fragments in write order
//   per coarser LOD:
//     lodLeafCount x uint8     bone index, same ordering rule
//   uint32   fillerCount
//   fillerCount x uint16 gx    (columnar, not interleaved — same reason as leaves)
//   fillerCount x uint16 gy
//   fillerCount x uint16 gz
//   fillerCount x uint8  bone
//   fillerCount x uint16 colour (RGB444 cell)
//   uint8    socketCount
//   per socket:
//     uint8  nameLength
//     bytes  name (UTF-8, <= VOXEL_SOCKET_NAME_MAX)
//     uint8  joint
//     3 x float32 offset

const FILLER_RECORD_BYTES = 2 + 2 + 2 + 1 + 2;

/** Bytes the rig section occupies, given the leaf counts it must cover. */
export function rigSectionBytes(rig: VxlV3Rig, lod0LeafCount: number, lodLeafCounts: readonly number[]): number {
    const refBytes = new TextEncoder().encode(rig.skeletonRef).byteLength;
    const jointCount = rig.bindPositions.length / 3;
    let total = 1 + refBytes + 1 + jointCount * 12;
    total += lod0LeafCount;
    for (const n of lodLeafCounts) total += n;
    total += 4 + rig.fillers.count * FILLER_RECORD_BYTES;
    total += 1;
    for (const s of rig.sockets) {
        total += 1 + new TextEncoder().encode(s.name.slice(0, VOXEL_SOCKET_NAME_MAX)).byteLength + 1 + 12;
    }
    return total;
}

/**
 * Write the rig section at `cursor`. Returns the new cursor.
 *
 * `lod0Bones` / `lodBones` must already be in leaf write order — the encoder
 * owns that ordering, so this function never reorders and never guesses.
 */
export function writeRigSection(
    view: DataView,
    bytes: Uint8Array,
    cursorIn: number,
    rig: VxlV3Rig,
    lod0Bones: Uint8Array,
    lodBones: readonly Uint8Array[],
): number {
    let cursor = cursorIn;
    const encoder = new TextEncoder();

    const ref = encoder.encode(rig.skeletonRef.slice(0, VOXEL_SKELETON_REF_MAX));
    bytes[cursor] = ref.byteLength;
    cursor += 1;
    bytes.set(ref, cursor);
    cursor += ref.byteLength;

    const jointCount = rig.bindPositions.length / 3;
    bytes[cursor] = jointCount;
    cursor += 1;
    for (let i = 0; i < rig.bindPositions.length; i++) {
        view.setFloat32(cursor, rig.bindPositions[i]!, true);
        cursor += 4;
    }

    bytes.set(lod0Bones, cursor);
    cursor += lod0Bones.length;
    for (const col of lodBones) {
        bytes.set(col, cursor);
        cursor += col.length;
    }

    const f = rig.fillers;
    view.setUint32(cursor, f.count, true);
    cursor += 4;
    for (let i = 0; i < f.count; i++) { view.setUint16(cursor, f.gx[i]!, true); cursor += 2; }
    for (let i = 0; i < f.count; i++) { view.setUint16(cursor, f.gy[i]!, true); cursor += 2; }
    for (let i = 0; i < f.count; i++) { view.setUint16(cursor, f.gz[i]!, true); cursor += 2; }
    for (let i = 0; i < f.count; i++) { bytes[cursor] = f.bone[i]!; cursor += 1; }
    for (let i = 0; i < f.count; i++) { view.setUint16(cursor, f.color[i]!, true); cursor += 2; }

    bytes[cursor] = rig.sockets.length;
    cursor += 1;
    for (const s of rig.sockets) {
        const name = encoder.encode(s.name.slice(0, VOXEL_SOCKET_NAME_MAX));
        bytes[cursor] = name.byteLength;
        cursor += 1;
        bytes.set(name, cursor);
        cursor += name.byteLength;
        bytes[cursor] = s.joint;
        cursor += 1;
        view.setFloat32(cursor + 0, s.offset[0], true);
        view.setFloat32(cursor + 4, s.offset[1], true);
        view.setFloat32(cursor + 8, s.offset[2], true);
        cursor += 12;
    }
    return cursor;
}

export interface ReadRigResult {
    rig: VxlV3Rig;
    cursor: number;
}

/**
 * Read the rig section. `lod0LeafCount` / `lodLeafCounts` come from the
 * fragments already decoded, which is what makes the section positionally
 * addressable without repeating the counts on the wire.
 */
export function readRigSection(
    view: DataView,
    bytes: Uint8Array,
    cursorIn: number,
    lod0LeafCount: number,
    lodLeafCounts: readonly number[],
): ReadRigResult {
    let cursor = cursorIn;
    const decoder = new TextDecoder();
    const need = (n: number, what: string): void => {
        if (cursor + n > bytes.byteLength) throw new Error(`VXL10 rig section truncated reading ${what}`);
    };

    need(1, 'skeletonRef length');
    const refLen = bytes[cursor]!;
    cursor += 1;
    need(refLen, 'skeletonRef');
    const skeletonRef = decoder.decode(bytes.subarray(cursor, cursor + refLen));
    cursor += refLen;

    need(1, 'jointCount');
    const jointCount = bytes[cursor]!;
    cursor += 1;
    need(jointCount * 12, 'bind positions');
    const bindPositions = new Float32Array(jointCount * 3);
    for (let i = 0; i < bindPositions.length; i++) {
        bindPositions[i] = view.getFloat32(cursor, true);
        cursor += 4;
    }

    need(lod0LeafCount, 'LOD 0 bone column');
    const bones = bytes.slice(cursor, cursor + lod0LeafCount);
    cursor += lod0LeafCount;
    const lodBones: Uint8Array[] = [];
    for (let l = 0; l < lodLeafCounts.length; l++) {
        const n = lodLeafCounts[l]!;
        need(n, `LOD ${l + 1} bone column`);
        lodBones.push(bytes.slice(cursor, cursor + n));
        cursor += n;
    }

    need(4, 'filler count');
    const count = view.getUint32(cursor, true);
    cursor += 4;
    need(count * FILLER_RECORD_BYTES, 'fillers');
    const gx = new Uint16Array(count);
    const gy = new Uint16Array(count);
    const gz = new Uint16Array(count);
    const bone = new Uint8Array(count);
    const color = new Uint16Array(count);
    for (let i = 0; i < count; i++) { gx[i] = view.getUint16(cursor, true); cursor += 2; }
    for (let i = 0; i < count; i++) { gy[i] = view.getUint16(cursor, true); cursor += 2; }
    for (let i = 0; i < count; i++) { gz[i] = view.getUint16(cursor, true); cursor += 2; }
    for (let i = 0; i < count; i++) { bone[i] = bytes[cursor]!; cursor += 1; }
    for (let i = 0; i < count; i++) { color[i] = view.getUint16(cursor, true); cursor += 2; }

    need(1, 'socket count');
    const socketCount = bytes[cursor]!;
    cursor += 1;
    const sockets: VxlV3Socket[] = [];
    for (let i = 0; i < socketCount; i++) {
        need(1, 'socket name length');
        const nameLen = bytes[cursor]!;
        cursor += 1;
        need(nameLen + 1 + 12, 'socket');
        const name = decoder.decode(bytes.subarray(cursor, cursor + nameLen));
        cursor += nameLen;
        const joint = bytes[cursor]!;
        cursor += 1;
        const offset: [number, number, number] = [
            view.getFloat32(cursor + 0, true),
            view.getFloat32(cursor + 4, true),
            view.getFloat32(cursor + 8, true),
        ];
        cursor += 12;
        sockets.push({ name, joint, offset });
    }

    return {
        rig: {
            skeletonRef,
            bindPositions,
            bones,
            lodBones,
            fillers: { count, gx, gy, gz, bone, color },
            sockets,
        },
        cursor,
    };
}
