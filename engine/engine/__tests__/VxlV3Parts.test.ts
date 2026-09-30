/**
 * `.vxl` v12 — the smart-object PARTS section.
 *
 * Three things are worth pinning. A parts-free asset must encode to exactly the
 * bytes it did before v12 existed. The parts table must come back in joint order
 * with its motions intact, alongside the v10 joint column it names — a table
 * without its column, or a column without its table, is a windmill that stops
 * being a windmill. And the encoder must refuse a table that does not match its
 * rig, because that mismatch has no runtime error, only wrong voxels turning.
 *
 * @jest-environment node
 */
import {
    encodeVxlV3, decodeVxlV3,
    VXL3_VERSION_COLUMNAR, VXL3_VERSION_MATERIAL_CLASS, VXL3_VERSION_PARTS,
    type VxlV3Data, type VxlV3Fragment,
} from 'engine/VxlV3Format.js';
import { VXL3_SECTION_RIG } from 'engine/VxlV3MaterialClass.js';
import {
    PARTS_SKELETON_REF, VXL3_SECTION_PARTS, partsSkeleton, validateParts, type VxlV3Part,
} from 'engine/VxlV3Parts.js';
import { buildEditedVxlV3Data } from 'engine/VoxelObjectLeafEdit.js';
import type { OctreeLeaf } from 'engine/VoxelOctreeRenderer.js';

const SIZE = 0.1;

function leaf(x: number, y: number, z: number, bone = 0): OctreeLeaf {
    return { x: x * SIZE, y: y * SIZE, z: z * SIZE, size: SIZE, r: 0.6, g: 0.4, b: 0.2, ...(bone ? { bone } : {}) };
}

function frag(leaves: OctreeLeaf[]): VxlV3Fragment {
    return { aabbMin: [0, 0, 0], aabbMax: [SIZE, 12 * SIZE, SIZE], leaves };
}

/** A tower (body) with a blade disc on top (joint 1) and a cabin hanging off it (joint 2). */
function windmillLeaves(): OctreeLeaf[] {
    const leaves: OctreeLeaf[] = [];
    for (let y = 0; y < 8; y++) leaves.push(leaf(0, y, 0));
    for (let y = 8; y < 11; y++) leaves.push(leaf(0, y, 0, 1));
    leaves.push(leaf(0, 11, 0, 2));
    return leaves;
}

const PARTS: VxlV3Part[] = [
    { name: 'blades', parentJoint: 0, motion: { kind: 'spin', axis: [0, 0, 1], rpm: 12 } },
    { name: 'cabin', parentJoint: 1, motion: { kind: 'upright' } },
];

function emptyFillers(): NonNullable<VxlV3Data['rig']>['fillers'] {
    return {
        count: 0, gx: new Uint16Array(0), gy: new Uint16Array(0), gz: new Uint16Array(0),
        bone: new Uint8Array(0), color: new Uint16Array(0),
    };
}

function rigFor(parts: VxlV3Part[], skeletonRef = PARTS_SKELETON_REF): NonNullable<VxlV3Data['rig']> {
    const bindPositions = new Float32Array((parts.length + 1) * 3);
    for (let i = 0; i < parts.length; i++) bindPositions[(i + 1) * 3 + 1] = 0.9 + i * 0.3;
    return { skeletonRef, bindPositions, fillers: emptyFillers(), sockets: [] };
}

function base(leaves: OctreeLeaf[]): VxlV3Data {
    return {
        minVoxelSize: SIZE, maxVoxelSize: SIZE, physicsGridStep: SIZE,
        bounds: { minX: 0, minY: 0, minZ: 0, maxX: SIZE, maxY: 12 * SIZE, maxZ: SIZE },
        useAtlas: true, fragments: [frag(leaves)],
    };
}

const smartData = (): VxlV3Data => ({ ...base(windmillLeaves()), rig: rigFor(PARTS), parts: PARTS });

const encode = (d: VxlV3Data): Promise<Uint8Array> => encodeVxlV3(d, { compression: 'none' });
const versionOf = (enc: Uint8Array): number => new DataView(enc.buffer, enc.byteOffset + 5, 4).getUint32(0, true);
const flagsOf = (enc: Uint8Array): number => new Uint8Array(enc.buffer, enc.byteOffset + 5, 48)[46]!;
const decode = (enc: Uint8Array): ReturnType<typeof decodeVxlV3> =>
    decodeVxlV3(enc.buffer.slice(enc.byteOffset, enc.byteOffset + enc.byteLength) as ArrayBuffer);

describe('v12 is written only when parts are present', () => {
    test('a plain asset stays v5, byte for byte', async () => {
        const plain = base(windmillLeaves().map((l) => ({ ...l, bone: undefined })));
        const enc = await encode(plain);
        expect(versionOf(enc)).toBe(VXL3_VERSION_COLUMNAR);
        const decoded = await decode(enc);
        expect(decoded.parts).toBeUndefined();
        expect(decoded.rig).toBeUndefined();
    });

    test('an empty parts array is the same as none', async () => {
        const withEmpty = await encode({ ...base(windmillLeaves()), parts: [] });
        const without = await encode(base(windmillLeaves()));
        expect(Array.from(withEmpty)).toEqual(Array.from(without));
    });

    test('parts raise the version to 12 and set the rig and parts bits', async () => {
        const enc = await encode(smartData());
        expect(versionOf(enc)).toBe(VXL3_VERSION_PARTS);
        expect(flagsOf(enc) & VXL3_SECTION_PARTS).toBe(VXL3_SECTION_PARTS);
        expect(flagsOf(enc) & VXL3_SECTION_RIG).toBe(VXL3_SECTION_RIG);
        expect(VXL3_VERSION_PARTS).toBeGreaterThan(VXL3_VERSION_MATERIAL_CLASS);
    });
});

describe('the parts table round-trips with the joint column it names', () => {
    test('names, parents and motions come back in joint order', async () => {
        const decoded = await decode(await encode(smartData()));
        expect(decoded.parts).toEqual(PARTS);
        expect(decoded.rig?.skeletonRef).toBe(PARTS_SKELETON_REF);
        expect(Array.from(decoded.rig!.bindPositions)).toEqual(Array.from(rigFor(PARTS).bindPositions));
    });

    test('every leaf keeps its joint, in leaf order', async () => {
        const decoded = await decode(await encode(smartData()));
        const buf = decoded.fragments[0]!.leaves;
        expect(buf.bone).not.toBeNull();
        for (let i = 0; i < buf.count; i++) {
            const gy = buf.gy[i]!;
            expect(buf.bone![i]).toBe(gy < 8 ? 0 : gy < 11 ? 1 : 2);
        }
    });

    test('the pendulum motion survives its three numbers', async () => {
        const parts: VxlV3Part[] = [{
            name: 'sign', parentJoint: 0,
            motion: { kind: 'pendulum', axis: [1, 0, 0], amplitudeDeg: 25, periodS: 2.5 },
        }];
        const leaves = windmillLeaves().map((l) => ({ ...l, bone: l.bone ? 1 : undefined }));
        const decoded = await decode(await encode({ ...base(leaves), rig: rigFor(parts), parts }));
        expect(decoded.parts).toEqual(parts);
    });

    test('an editor re-save keeps the table, so the windmill stays a windmill', async () => {
        const decoded = await decode(await encode(smartData()));
        const resaved = buildEditedVxlV3Data(decoded.fragments[0]!.leaves.toArray(true), decoded, []);
        expect(resaved.parts).toEqual(PARTS);
        expect(resaved.rig?.skeletonRef).toBe(PARTS_SKELETON_REF);
        const again = await decode(await encode(resaved));
        expect(again.parts).toEqual(PARTS);
        expect(again.fragments[0]!.leaves.bone).not.toBeNull();
    });
});

describe('the encoder refuses a table that does not match its rig', () => {
    test('parts without a rig', async () => {
        await expect(encode({ ...base(windmillLeaves()), parts: PARTS })).rejects.toThrow(/parts need a rig/);
    });

    test('parts on a character skeleton', async () => {
        await expect(encode({ ...base(windmillLeaves()), rig: rigFor(PARTS, 'mixamo-22-v1'), parts: PARTS }))
            .rejects.toThrow(/parts need a rig/);
    });

    test('a joint count that disagrees with the table', async () => {
        const rig = rigFor([PARTS[0]!]);
        await expect(encode({ ...base(windmillLeaves()), rig, parts: PARTS })).rejects.toThrow(/joints/);
    });
});

describe('validateParts and partsSkeleton', () => {
    test('accepts a parents-first table and builds its skeleton', () => {
        expect(validateParts(PARTS, 3)).toBeNull();
        const skeleton = partsSkeleton(PARTS);
        expect(skeleton.joints).toEqual(['body', 'blades', 'cabin']);
        expect(skeleton.parents).toEqual([-1, 0, 1]);
        // Identity bind rotations: a part rests in the pose it was voxelized in.
        expect(Array.from(skeleton.rotations)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
    });

    test('rejects a part that parents a later joint, a duplicate name, and a missing name', () => {
        expect(validateParts([
            { name: 'a', parentJoint: 2, motion: { kind: 'none' } },
            { name: 'b', parentJoint: 0, motion: { kind: 'none' } },
        ], 3)).toMatch(/must come after its parent/);
        expect(validateParts([
            { name: 'a', parentJoint: 0, motion: { kind: 'none' } },
            { name: 'a', parentJoint: 0, motion: { kind: 'none' } },
        ], 3)).toMatch(/used twice/);
        expect(validateParts([{ name: '', parentJoint: 0, motion: { kind: 'none' } }], 2)).toMatch(/no name/);
    });
});
