/**
 * VXL3 v10 — rigged-character round-trip.
 *
 * The invariants worth defending are the ones that were expensive to establish:
 * a rig-free asset must not change a single byte, the bone column must survive
 * the trip in LEAF order (it is per-leaf, not per-palette, unlike every section
 * before it), and the joint fillers must come back intact — they are the reason
 * joints stay closed under animation, so silently dropping them is a rendering
 * bug that no static check would catch.
 */

import { decodeVxlV3, encodeVxlV3, VXL3_VERSION_RIG, type VxlV3Data } from 'engine/VxlV3Format.js';
import { SKELETON_REFS, type VxlV3Fillers } from 'engine/VxlV3Rig.js';
import { buildEditedVxlV3Data } from 'engine/VoxelObjectLeafEdit.js';
import type { OctreeLeaf } from 'engine/VoxelOctreeRenderer.js';

const SIZE = 0.1;

function leaf(x: number, y: number, z: number, bone: number, r = 0.8, g = 0.2, b = 0.2): OctreeLeaf {
    return { x: x * SIZE, y: y * SIZE, z: z * SIZE, size: SIZE, r, g, b, bone };
}

/** A small two-bone body: a column of leaves, lower half hips, upper half spine. */
function makeData(withRig: boolean): VxlV3Data {
    const leaves: OctreeLeaf[] = [];
    for (let i = 0; i < 12; i++) leaves.push(leaf(0, i, 0, i < 6 ? 0 : 1, i / 12, 0.3, 0.6));
    const data: VxlV3Data = {
        minVoxelSize: SIZE,
        maxVoxelSize: SIZE,
        physicsGridStep: SIZE,
        bounds: { minX: 0, minY: 0, minZ: 0, maxX: SIZE, maxY: 12 * SIZE, maxZ: SIZE },
        useAtlas: false,
        fragments: [{ aabbMin: [0, 0, 0], aabbMax: [SIZE, 12 * SIZE, SIZE], leaves }],
    };
    if (!withRig) return data;
    const fillers: VxlV3Fillers = {
        count: 2,
        gx: new Uint16Array([0, 0]),
        gy: new Uint16Array([5, 6]),
        gz: new Uint16Array([0, 0]),
        bone: new Uint8Array([1, 0]),
        color: new Uint16Array([0x0f00, 0x000f]),
    };
    return {
        ...data,
        rig: {
            skeletonRef: 'mixamo-22-v1',
            bindPositions: new Float32Array(22 * 3).map((_, i) => i * 0.01),
            fillers,
            sockets: [{ name: 'head', joint: 5, offset: [0, 1.5, 0] }],
        },
    };
}

describe('VXL3 v10 rigged character', () => {
    it('leaves a rig-free asset byte-identical', async () => {
        const before = await encodeVxlV3(makeData(false), { compression: 'none' });
        const after = await encodeVxlV3(makeData(false), { compression: 'none' });
        expect(Array.from(after)).toEqual(Array.from(before));
        const decoded = await decodeVxlV3(before.buffer as ArrayBuffer);
        expect(decoded.rig).toBeUndefined();
        expect(decoded.fragments[0]!.leaves.bone).toBeNull();
    });

    it('round-trips the per-leaf bone column in leaf order', async () => {
        const encoded = await encodeVxlV3(makeData(true));
        const decoded = await decodeVxlV3(encoded.buffer as ArrayBuffer);
        const buf = decoded.fragments[0]!.leaves;
        expect(buf.bone).not.toBeNull();
        expect(buf.count).toBe(12);
        // Leaf order is the encoder's, so compare by position rather than by index.
        for (let i = 0; i < buf.count; i++) {
            const gy = buf.gy[i]!;
            expect(buf.bone![i]).toBe(gy < 6 ? 0 : 1);
        }
    });

    it('writes version 10 only when a rig is present', async () => {
        const rigged = await encodeVxlV3(makeData(true), { compression: 'none' });
        // Body starts at byte 5; version is the first uint32 of the body.
        const version = new DataView(rigged.buffer, rigged.byteOffset + 5).getUint32(0, true);
        expect(version).toBe(VXL3_VERSION_RIG);

        const plain = await encodeVxlV3(makeData(false), { compression: 'none' });
        const plainVersion = new DataView(plain.buffer, plain.byteOffset + 5).getUint32(0, true);
        expect(plainVersion).toBeLessThan(VXL3_VERSION_RIG);
    });

    it('round-trips the skeleton reference and bind positions', async () => {
        const encoded = await encodeVxlV3(makeData(true));
        const { rig } = await decodeVxlV3(encoded.buffer as ArrayBuffer);
        expect(rig!.skeletonRef).toBe('mixamo-22-v1');
        expect(rig!.bindPositions.length).toBe(22 * 3);
        expect(rig!.bindPositions[3]).toBeCloseTo(0.03, 6);
        // The ref resolves to the shared skeleton — names and hierarchy are NOT in the file.
        const ref = SKELETON_REFS[rig!.skeletonRef]!;
        expect(ref.joints.length).toBe(22);
        expect(ref.joints[0]).toBe('mixamorigHips');
        expect(ref.parents[0]).toBe(-1);
        expect(ref.rotations.length).toBe(22 * 4);
    });

    it('preserves joint fillers exactly — they are what keeps joints closed', async () => {
        const encoded = await encodeVxlV3(makeData(true));
        const { rig } = await decodeVxlV3(encoded.buffer as ArrayBuffer);
        const f = rig!.fillers;
        expect(f.count).toBe(2);
        expect(Array.from(f.gy)).toEqual([5, 6]);
        expect(Array.from(f.bone)).toEqual([1, 0]);
        expect(Array.from(f.color)).toEqual([0x0f00, 0x000f]);
    });

    it('round-trips attachment sockets', async () => {
        const encoded = await encodeVxlV3(makeData(true));
        const { rig } = await decodeVxlV3(encoded.buffer as ArrayBuffer);
        expect(rig!.sockets).toHaveLength(1);
        expect(rig!.sockets[0]!.name).toBe('head');
        expect(rig!.sockets[0]!.joint).toBe(5);
        expect(rig!.sockets[0]!.offset[1]).toBeCloseTo(1.5, 6);
    });

    it('keeps colour and geometry unchanged alongside the rig', async () => {
        const plain = await decodeVxlV3((await encodeVxlV3(makeData(false))).buffer as ArrayBuffer);
        const rigged = await decodeVxlV3((await encodeVxlV3(makeData(true))).buffer as ArrayBuffer);
        const a = plain.fragments[0]!.leaves;
        const b = rigged.fragments[0]!.leaves;
        expect(b.count).toBe(a.count);
        expect(Array.from(b.gy)).toEqual(Array.from(a.gy));
        expect(Array.from(b.color)).toEqual(Array.from(a.color));
    });

    /**
     * Editing a rigged character must not un-rig it.
     *
     * Decoding and re-encoding the same payload is not the risky path — the risky one
     * is the EDITOR's, which rebuilds the payload from live leaves and so has to put
     * every asset-level section back by hand. It did not: an edit re-encoded the file
     * below v10 and the skeleton was gone, exactly as v7's slot table was once dropped
     * (with every named material and every light on one). Measured on a v10 sample
     * before the fix: 3859 leaves carrying a bone came back as 0.
     *
     * The shape assertions live next to `buildEditedVxlV3Data` in
     * `VoxelObjectLeafEdit.test.ts`; this is the end-to-end half, because only the
     * encoder decides what version actually reaches disk.
     */
    it('still writes v10 after an editor round trip through buildEditedVxlV3Data', async () => {
        const source = await decodeVxlV3((await encodeVxlV3(makeData(true))).buffer as ArrayBuffer);
        const leaves = source.fragments[0]!.leaves.toArray(source.useAtlas);
        expect(leaves.filter((l) => (l.bone ?? 0) > 0).length).toBeGreaterThan(0);

        // What VoxelObject.toVXL() does with a leaf-edited object.
        const edited = buildEditedVxlV3Data(leaves, source, {
            voxelSize: source.minVoxelSize,
            physicsGridStep: source.physicsGridStep,
            useAtlas: source.useAtlas,
        }, source.slots ?? []);
        // Uncompressed, so the version is readable where it sits: magic (4) +
        // compressionId (1), then the body header. Under the default gzip those bytes
        // are deflate output and the check would read noise.
        const encoded = await encodeVxlV3(edited, { compression: 'none' });
        expect(new DataView(encoded.buffer as ArrayBuffer, 5).getUint32(0, true)).toBe(VXL3_VERSION_RIG);

        const after = await decodeVxlV3(encoded.buffer as ArrayBuffer);
        expect(after.rig).toBeDefined();
        expect(after.rig!.skeletonRef).toBe(source.rig!.skeletonRef);
        expect(after.rig!.sockets).toHaveLength(source.rig!.sockets.length);
        expect(Array.from(after.rig!.fillers.bone)).toEqual(Array.from(source.rig!.fillers.bone));

        // Every joint assignment intact, matched by position rather than index.
        const before = source.fragments[0]!.leaves;
        const now = after.fragments[0]!.leaves;
        expect(now.count).toBe(before.count);
        const boneAt = (buf: typeof now) => {
            const map = new Map<string, number>();
            for (let i = 0; i < buf.count; i++) map.set(`${buf.gx[i]},${buf.gy[i]},${buf.gz[i]}`, buf.bone![i]!);
            return map;
        };
        expect(boneAt(now)).toEqual(boneAt(before));
    });
});
