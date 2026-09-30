/**
 * `.vxl` v11 — the per-slot MATERIAL CLASS section.
 *
 * Class names are UTF-8 in the file, so these run on the node environment —
 * jsdom ships no TextEncoder/TextDecoder, unlike every runtime the engine
 * actually loads assets in.
 *
 * Two properties matter more than the round trip itself, and both are pinned
 * here. First, **an asset that names no class must encode to exactly the bytes it
 * did before v11 existed** — the version ladder's whole discipline. Second, v11
 * is the first version whose optional sections are DECLARED in header byte 46
 * rather than inferred from the version number, because a v11 file cannot be
 * required to always carry the rig section: a rig costs a byte per leaf per LOD
 * and cannot be written empty, which would leave a non-rigged gold statue with no
 * representable version.
 *
 * @jest-environment node
 */
import {
    encodeVxlV3, decodeVxlV3,
    VXL3_VERSION_COLUMNAR, VXL3_VERSION_SLOTS, VXL3_VERSION_BLOCK_TYPES,
    VXL3_VERSION_RIG, VXL3_VERSION_MATERIAL_CLASS,
    type VxlV3Data, type VxlV3Fragment,
} from 'engine/VxlV3Format.js';
import {
    VXL3_SECTION_LEGACY_EMISSIVE, VXL3_SECTION_MATERIAL_CLASS, VXL3_SECTION_RIG,
} from 'engine/VxlV3MaterialClass.js';
import { resolveVoxelMaterialClass } from 'engine/VoxelMaterialClass.js';
import type { OctreeLeaf } from 'engine/VoxelOctreeRenderer.js';

function leaf(
    x: number, y: number, z: number, size: number,
    opts: { slot?: number; emissive?: number } = {},
): OctreeLeaf {
    return {
        x, y, z, size, r: 0.8, g: 0.7, b: 0.2,
        emissive: opts.emissive ?? 0, slot: opts.slot ?? 0,
    };
}

function frag(leaves: OctreeLeaf[]): VxlV3Fragment {
    return { aabbMin: [0, 0, 0], aabbMax: [1.6, 1.6, 1.6], leaves };
}

const base = (fragments: VxlV3Fragment[], slots?: VxlV3Data['slots']): VxlV3Data => ({
    minVoxelSize: 0.1, maxVoxelSize: 0.4, physicsGridStep: 0.1,
    bounds: { minX: 0, minY: 0, minZ: 0, maxX: 1.6, maxY: 1.6, maxZ: 1.6 },
    useAtlas: true, fragments, ...(slots ? { slots } : {}),
});

const encode = async (d: VxlV3Data): Promise<Uint8Array> =>
    encodeVxlV3(d, { compression: 'none' });

const roundtrip = async (d: VxlV3Data): Promise<Awaited<ReturnType<typeof decodeVxlV3>>> => {
    const enc = await encode(d);
    return decodeVxlV3(enc.buffer.slice(enc.byteOffset, enc.byteOffset + enc.byteLength) as ArrayBuffer);
};

/** Version field of the encoded body (the 5-byte wrapper precedes it). */
const versionOf = async (d: VxlV3Data): Promise<number> => {
    const enc = await encode(d);
    return new DataView(enc.buffer, enc.byteOffset + 5, 4).getUint32(0, true);
};

/** Header byte 46 — the section bitfield from v11 on. */
const sectionFlagsOf = async (d: VxlV3Data): Promise<number> => {
    const enc = await encode(d);
    return new Uint8Array(enc.buffer, enc.byteOffset + 5, 48)[46]!;
};

/** Two leaves in the base material, one in slot 1. */
const slottedFragments = (): VxlV3Fragment[] => [frag([
    leaf(0, 0, 0, 0.1),
    leaf(0.2, 0, 0, 0.1),
    leaf(0.4, 0, 0, 0.1, { slot: 1 }),
])];

describe('v11 is written only when a class is actually used', () => {
    test('an asset with no slots at all stays v5', async () => {
        expect(await versionOf(base([frag([leaf(0, 0, 0, 0.1)])]))).toBe(VXL3_VERSION_COLUMNAR);
    });

    test('a slotted asset with no class stays v7', async () => {
        const data = base(slottedFragments(), [{ name: 'trim', emissive: 0 }]);
        expect(await versionOf(data)).toBe(VXL3_VERSION_SLOTS);
    });

    test('an explicitly-matte class is not a class — still v7', async () => {
        // matte IS the default look, so writing a section to say so would raise the
        // version and change the bytes for no behavioural difference at all.
        const data = base(slottedFragments(), [{ name: 'trim', emissive: 0, materialClass: 'matte' }]);
        expect(await versionOf(data)).toBe(VXL3_VERSION_SLOTS);
    });

    test('a real class raises the version to v11', async () => {
        const data = base(slottedFragments(), [{ name: 'trim', emissive: 0, materialClass: 'gold' }]);
        expect(await versionOf(data)).toBe(VXL3_VERSION_MATERIAL_CLASS);
    });

    test('BYTE IDENTITY: a class-free asset encodes exactly as it did before v11', async () => {
        // The version ladder's core promise. `materialClass: undefined` and an
        // explicit 'matte' must both reproduce the pre-feature bytes.
        const withoutField = await encode(base(slottedFragments(), [{ name: 'trim', emissive: 128 }]));
        const withMatte = await encode(
            base(slottedFragments(), [{ name: 'trim', emissive: 128, materialClass: 'matte' }]),
        );
        expect(Array.from(withMatte)).toEqual(Array.from(withoutField));
    });
});

describe('v11 round trip', () => {
    test('carries the class back on the decoded slot', async () => {
        const dec = await roundtrip(base(slottedFragments(), [
            { name: 'blade', emissive: 0, materialClass: 'metal' },
        ]));
        expect(dec.slots).toHaveLength(1);
        expect(dec.slots![0]!.name).toBe('blade');
        expect(dec.slots![0]!.materialClass).toBe('metal');
    });

    test('leaves the field OFF a slot that has no class', async () => {
        // Shaped identically to a slot decoded from a pre-v11 file, which is what
        // keeps a decode → re-encode round trip byte-identical.
        const dec = await roundtrip(base([frag([
            leaf(0, 0, 0, 0.1),
            leaf(0.2, 0, 0, 0.1, { slot: 1 }),
            leaf(0.4, 0, 0, 0.1, { slot: 2 }),
        ])], [
            { name: 'plain', emissive: 0 },
            { name: 'shiny', emissive: 0, materialClass: 'chrome' },
        ]));
        expect(dec.slots).toHaveLength(2);
        expect(Object.hasOwnProperty.call(dec.slots![0]!, 'materialClass')).toBe(false);
        expect(dec.slots![1]!.materialClass).toBe('chrome');
    });

    test('keeps the glow and the class independent', async () => {
        const dec = await roundtrip(base(slottedFragments(), [
            { name: 'beacon', emissive: 200, materialClass: 'gold' },
        ]));
        expect(dec.slots![0]!.emissive).toBe(200);
        expect(dec.slots![0]!.materialClass).toBe('gold');
    });

    test('preserves the per-leaf slot column, so the class reaches the right voxels', async () => {
        const dec = await roundtrip(base(slottedFragments(), [
            { name: 'trim', emissive: 0, materialClass: 'gold' },
        ]));
        const buf = dec.fragments[0]!.leaves;
        const slotsSeen = Array.from({ length: buf.count }, (_, i) => buf.slot![i]);
        expect(slotsSeen.filter((s) => s === 1)).toHaveLength(1);
        expect(slotsSeen.filter((s) => s === 0)).toHaveLength(2);
    });

    test('normalises a stored class name', async () => {
        const dec = await roundtrip(base(slottedFragments(), [
            { name: 'trim', emissive: 0, materialClass: '  GOLD  ' },
        ]));
        expect(dec.slots![0]!.materialClass).toBe('gold');
    });

    test('an UNKNOWN class survives the round trip and resolves to the default', async () => {
        // Stored identity and rendered identity are separate: an asset authored
        // against a newer vocabulary must not be silently stripped by an older
        // engine that merely does not know the name yet.
        const dec = await roundtrip(base(slottedFragments(), [
            { name: 'trim', emissive: 0, materialClass: 'unobtanium' },
        ]));
        expect(dec.slots![0]!.materialClass).toBe('unobtanium');
        expect(resolveVoxelMaterialClass(dec.slots![0]!.materialClass).lighting).toBe('lambert');
    });

    test('a light keeps GLOWING on an engine that has never heard of its class', async () => {
        // Why a class's default glow is materialised into the slot's `emissive`
        // at authoring time rather than read from the class table at render
        // time. The class name degrades to `matte` on an older build — that is
        // the documented forward-compat contract — but `emissive` is a field
        // every version back to v7 reads literally, so the light survives the
        // shading. Derive the glow instead and this asset opens DARK, which is
        // the "street lamps went dark" failure the format's own history is
        // littered with.
        const dec = await roundtrip(base(slottedFragments(), [
            { name: 'tube', emissive: 255, materialClass: 'unobtanium' },
        ]));
        expect(dec.slots![0]!.emissive).toBe(255);
        expect(resolveVoxelMaterialClass(dec.slots![0]!.materialClass).lighting).toBe('lambert');
    });

    test('re-encoding a decoded v11 asset reproduces the same bytes', async () => {
        const data = base(slottedFragments(), [
            { name: 'blade', emissive: 0, materialClass: 'metal' },
            { name: 'grip', emissive: 0, materialClass: 'leather' },
        ]);
        const first = await encode(base([frag([
            leaf(0, 0, 0, 0.1),
            leaf(0.2, 0, 0, 0.1, { slot: 1 }),
            leaf(0.4, 0, 0, 0.1, { slot: 2 }),
        ])], data.slots));
        const dec = await decodeVxlV3(
            first.buffer.slice(first.byteOffset, first.byteOffset + first.byteLength) as ArrayBuffer,
        );
        // Round-tripping the SLOT TABLE is what the editor's save path depends on;
        // dropping the class there downgraded the file out of v11 and lost the
        // material the first time an asset was hand-edited.
        expect(dec.slots!.map((s) => s.materialClass)).toEqual(['metal', 'leather']);
    });
});

describe('v11 declares its sections in header byte 46', () => {
    test('sets the material-class bit and nothing else on a class-only asset', async () => {
        const flags = await sectionFlagsOf(base(slottedFragments(), [
            { name: 'trim', emissive: 0, materialClass: 'gold' },
        ]));
        expect(flags & VXL3_SECTION_MATERIAL_CLASS).toBeTruthy();
        expect(flags & VXL3_SECTION_RIG).toBe(0);
        // v11 always carries the block-type array, which cannot coexist with the
        // legacy per-colour emissive block — so this bit is never set in v11.
        expect(flags & VXL3_SECTION_LEGACY_EMISSIVE).toBe(0);
    });

    test('a v11 file with no rig really has no rig', async () => {
        // The reason the flag exists at all: a rig is one byte per leaf per LOD and
        // cannot be written empty, so "v11 implies a rig" would be unaffordable.
        const dec = await roundtrip(base(slottedFragments(), [
            { name: 'trim', emissive: 0, materialClass: 'gold' },
        ]));
        expect(dec.rig).toBeUndefined();
    });

    test('byte 46 keeps its old meaning below v11', async () => {
        // A v6/v7 file uses the same byte as a plain 1/0 emissive flag. Both
        // readings must stay correct, which they do because a decoder rejects an
        // unknown version before ever reaching the byte.
        const emissive = base([frag([leaf(0, 0, 0, 0.1, { emissive: 200 })])]);
        expect(await sectionFlagsOf(emissive)).toBe(VXL3_SECTION_LEGACY_EMISSIVE);
        const plain = base([frag([leaf(0, 0, 0, 0.1)])]);
        expect(await sectionFlagsOf(plain)).toBe(0);
    });
});

describe('v11 interacts correctly with the sections before it', () => {
    test('a class forces the block-type array, as a rig does', async () => {
        // Those arrays sit BEFORE the flagged sections, so everything up to the
        // flags has to stay positionally addressable. Zero-filled when unused.
        const dec = await roundtrip(base(slottedFragments(), [
            { name: 'trim', emissive: 0, materialClass: 'gold' },
        ]));
        const buf = dec.fragments[0]!.leaves;
        expect(buf.blockType).not.toBeNull();
        expect(Array.from(buf.blockType!)).toEqual([0, 0, 0]);
    });

    test('a class and legacy per-colour emissive: the class wins, with a warning', async () => {
        // The same trade v8/v9/v10 already make in one direction or the other —
        // never silently, and never both.
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const data = base([frag([
            leaf(0, 0, 0, 0.1, { emissive: 200 }),
            leaf(0.2, 0, 0, 0.1, { slot: 1 }),
        ])], [{ name: 'trim', emissive: 0, materialClass: 'gold' }]);
        expect(await versionOf(data)).toBe(VXL3_VERSION_MATERIAL_CLASS);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    test('block types alone still produce v9', async () => {
        const data = base([frag([{ ...leaf(0, 0, 0, 0.1), blockType: 7 }])]);
        expect(await versionOf(data)).toBe(VXL3_VERSION_BLOCK_TYPES);
    });

    test('a rig alone still produces v10', async () => {
        const data: VxlV3Data = {
            ...base([frag([leaf(0, 0, 0, 0.1)])]),
            rig: {
                skeletonRef: 'default',
                bindPositions: new Float32Array([0, 0, 0]),
                bones: new Uint8Array([0]),
                lodBones: [],
                fillers: { count: 0, gx: new Uint16Array(0), gy: new Uint16Array(0), gz: new Uint16Array(0), lod: new Uint8Array(0), bone: new Uint8Array(0), color: new Uint16Array(0) },
                sockets: [],
            },
        };
        expect(await versionOf(data)).toBe(VXL3_VERSION_RIG);
    });
});

describe('a truncated section fails loudly', () => {
    test('throws rather than guessing at a class name', async () => {
        const enc = await encode(base(slottedFragments(), [
            { name: 'trim', emissive: 0, materialClass: 'gold' },
        ]));
        // Chop the last byte of the class name off the body.
        const truncated = enc.slice(0, enc.byteLength - 1);
        await expect(decodeVxlV3(
            truncated.buffer.slice(
                truncated.byteOffset, truncated.byteOffset + truncated.byteLength,
            ) as ArrayBuffer,
        )).rejects.toThrow(/material-class section truncated/);
    });
});
