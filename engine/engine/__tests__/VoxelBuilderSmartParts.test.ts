/**
 * @jest-environment jsdom
 *
 * A smart PLACEHOLDER from boxes: `VoxelPartConfig.part` names a moving part,
 * `VoxelObjectConfig.smart` says how it moves, and the built object encodes as
 * a v12 `.vxl` whose blade voxels carry joint 1 while the tower stays joint 0.
 *
 * What is pinned: the joint column matches the boxes exactly, it survives the
 * synthesized coarser LODs, the parts table and `parts-v1` rig are written, the
 * pivot lands at the blade box's centre in the asset frame, and a light placed
 * on a part sits at that part's pivot. And a config that declares nothing
 * encodes exactly as it always did.
 */
import { VoxelObjectBuilder, SMART_PROP_BAKE } from 'engine/builders/VoxelObjectBuilder.js';
import type { SmartPropBake } from 'engine/import/SmartPropParts.js';
import { decodeVxlV3 } from 'engine/VxlV3Format.js';
import { PARTS_SKELETON_REF } from 'engine/VxlV3Parts.js';

const VS = 0.25;
/**
 * The object pivot the builder centres on: bottom-centre of the union of the
 * boxes — x 0, y 0, z 0.125 (the tower spans z −0.5..0.5, the blades reach 0.75).
 * Decoded leaves and the bake's fitment are in this pivot-relative asset frame.
 */
const PIVOT = { x: 0, y: 0, z: 0.125 };

/** A 1 m tower with a 3 m wide, thin blade bar across its top, in front of it. */
function windmill(smart = true): Parameters<typeof VoxelObjectBuilder.create>[0] {
    return {
        name: 'windmill',
        voxelSize: VS,
        parts: [
            { position: { x: -0.5, y: 0, z: -0.5 }, size: { width: 1, height: 4, length: 1 }, color: 0x8b5a2b },
            { position: { x: -1.5, y: 3.5, z: 0.5 }, size: { width: 3, height: 0.5, length: 0.25 }, color: 0xd2b48c, part: 'blades' },
        ],
        ...(smart ? {
            smart: {
                parts: [{ name: 'blades', motion: { kind: 'spin', axis: [0, 0, 1], rpm: 12 } }],
                lights: [{ name: 'hub_lamp', part: 'blades', color: '#ffd27a', intensity: 8 }],
            },
        } : {}),
    } as Parameters<typeof VoxelObjectBuilder.create>[0];
}

async function decodeBuilt(object: { toVXL(): Promise<ArrayBuffer> }): ReturnType<typeof decodeVxlV3> {
    return decodeVxlV3(await object.toVXL());
}

describe('VoxelObjectBuilder smart parts', () => {
    it('writes the blade voxels as joint 1 and the tower as the body', async () => {
        const { object } = VoxelObjectBuilder.create(windmill());
        const decoded = await decodeBuilt(object);
        expect(decoded.parts).toEqual([
            { name: 'blades', parentJoint: 0, motion: { kind: 'spin', axis: [0, 0, 1], rpm: 12 } },
        ]);
        expect(decoded.rig?.skeletonRef).toBe(PARTS_SKELETON_REF);

        const buf = decoded.fragments[0]!.leaves;
        expect(buf.bone).not.toBeNull();
        let blade = 0, body = 0;
        for (let i = 0; i < buf.count; i++) {
            // Back to build space: the blade bar is the only geometry at y >= 3.5 m
            // in front of the tower (z >= 0.5).
            const y = buf.worldY(i) + PIVOT.y, z = buf.worldZ(i) + PIVOT.z;
            const inBlades = y >= 3.5 - 1e-6 && z >= 0.5 - 1e-6;
            expect(buf.bone![i]).toBe(inBlades ? 1 : 0);
            if (inBlades) blade++; else body++;
        }
        // 3 m × 0.5 m × 0.25 m at 0.25 m voxels = 12 × 2 × 1.
        expect(blade).toBe(24);
        expect(body).toBeGreaterThan(blade);
    });

    it('keeps the joint column on any coarser LOD the encoder synthesizes', async () => {
        // A converted object encodes from its live leaves; whether the encoder adds
        // coarser levels depends on size. Whatever it adds must carry the column.
        const { object } = VoxelObjectBuilder.create(windmill());
        const decoded = await decodeBuilt(object);
        for (const lod of decoded.additionalLods ?? []) {
            const buf = lod.fragments[0]!.leaves;
            expect(buf.bone).not.toBeNull();
            expect(Array.from(buf.bone!).some((j) => j === 1)).toBe(true);
        }
    });

    it('puts the pivot at the blade box centre in the asset frame, and the light on it', () => {
        const { object } = VoxelObjectBuilder.create(windmill());
        const bake = object.userData[SMART_PROP_BAKE] as SmartPropBake;
        expect(bake.fitment.parts).toHaveLength(1);
        // Build-space box centre (0, 3.75, 0.625) minus the object pivot.
        expect(bake.fitment.parts[0]!.pivot.x).toBeCloseTo(0 - PIVOT.x, 5);
        expect(bake.fitment.parts[0]!.pivot.y).toBeCloseTo(3.75 - PIVOT.y, 5);
        expect(bake.fitment.parts[0]!.pivot.z).toBeCloseTo(0.625 - PIVOT.z, 5);
        // The rig's bind position is the same pivot, local to the body at the origin.
        expect(bake.rig.bindPositions[4]).toBeCloseTo(3.75 - PIVOT.y, 5);
        expect(bake.rig.bindPositions[5]).toBeCloseTo(0.625 - PIVOT.z, 5);
        // The lamp rides the blades: same offset as the pivot, and it names the part.
        expect(bake.light?.offset).toEqual(bake.fitment.parts[0]!.pivot);
        expect(bake.light?.part).toBe('blades');
        expect(bake.light?.intensity).toBe(8);
        expect(bake.fitment.source).toBeUndefined();
    });

    it('drops a declared part no box carries, with a warning, and keeps the rest', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        const config = windmill();
        config.smart!.parts.push({ name: 'vane', motion: { kind: 'spin', axis: [0, 1, 0], rpm: 3 } });
        const { object } = VoxelObjectBuilder.create(config);
        const decoded = await decodeBuilt(object);
        expect(decoded.parts?.map((p) => p.name)).toEqual(['blades']);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('"vane"'));
        warn.mockRestore();
    });

    it('encodes a config that declares nothing exactly as before', async () => {
        const { object } = VoxelObjectBuilder.create(windmill(false));
        const decoded = await decodeBuilt(object);
        expect(decoded.parts).toBeUndefined();
        expect(decoded.rig).toBeUndefined();
        expect(decoded.fragments[0]!.leaves.bone).toBeNull();
        expect(object.userData[SMART_PROP_BAKE]).toBeUndefined();
    });
});
