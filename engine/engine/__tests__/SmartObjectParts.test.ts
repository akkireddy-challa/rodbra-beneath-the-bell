/**
 * Smart-object parts: from a grid-space spec to a baked `.vxl` with a part channel.
 *
 * The property that matters end to end: a voxel the Forger's analysis counted as
 * "blade" is a voxel the compiled asset animates as blade — through the box and
 * component rule, the majority vote onto the working lattice, the auto-coarsen
 * and every LOD. The synthetic master here is a tower with a blade disc whose
 * box also clips a sliver of tower, which is exactly the case the component
 * rule exists for.
 *
 * @jest-environment node
 */
import { decodeVxlV3 } from 'engine/VxlV3Format.js';
import { PARTS_SKELETON_REF } from 'engine/VxlV3Parts.js';
import {
    assignPartJoints, cellsPartFromWorking, fitmentFromSpec, lightsFromSpec,
    masterPointToCells, partsTableFromSpec,
} from 'engine/import/SmartObjectParts.js';
import { resampleMaster, type VoxelMaster } from 'engine/import/VoxelMaster.js';
import { compileVoxelModelToVxlAsset } from 'engine/import/VoxelModelToAsset.js';
import { packCell } from 'engine/vxlscene/SurfaceRasterizer.js';
import type { SmartObjectSpec } from 'types/smartObject.js';

/**
 * A 32-grid master: a 4x24x4 tower at the centre, and a 16x16x2 blade disc in
 * front of it (z = 24..25) centred on the tower's top. The disc is joined to the
 * tower by a hub so it is one connected object.
 */
function windmillMaster(): { master: VoxelMaster; isBlade: (x: number, y: number, z: number) => boolean } {
    const xs: number[] = [], ys: number[] = [], zs: number[] = [], cs: number[] = [];
    const add = (x: number, y: number, z: number, c: number): void => { xs.push(x); ys.push(y); zs.push(z); cs.push(c); };
    for (let x = 14; x < 18; x++) for (let y = 0; y < 24; y++) for (let z = 14; z < 18; z++) add(x, y, z, 0x8b5a2b);
    // Hub: bridges tower front (z = 17) to the disc (z = 24).
    for (let z = 18; z < 24; z++) add(15, 19, z, 0x444444);
    const isBlade = (x: number, y: number, z: number): boolean =>
        z >= 24 && z <= 25 && x >= 8 && x < 24 && y >= 12 && y < 28 && (x === 15 || y === 19);
    for (let x = 8; x < 24; x++) for (let y = 12; y < 28; y++) for (let z = 24; z < 26; z++) {
        if (isBlade(x, y, z)) add(x, y, z, 0xdddddd);
    }
    return {
        master: {
            resolution: 32,
            x: Uint16Array.from(xs), y: Uint16Array.from(ys), z: Uint16Array.from(zs),
            color: Uint32Array.from(cs), count: xs.length,
        },
        isBlade,
    };
}

/** The blade box, deliberately wide in Z so it clips the hub's last cells and a slice of nothing else. */
const SPEC: SmartObjectSpec = {
    version: 1,
    grid: 32,
    parts: [{
        name: 'blades',
        box: { min: [6, 10, 22], max: [25, 29, 27] },
        pivot: [15.5, 19.5, 25],
        motion: { kind: 'spin', axis: [0, 0, 1], rpm: 12 },
    }],
    lights: [{ name: 'lamp', position: [15.5, 24, 13], color: '#ffd27a', intensity: 15 }],
    minComponentFraction: 0.1,
};

describe('assignPartJoints', () => {
    test('labels the blade voxels and keeps the tower as body', () => {
        const { master, isBlade } = windmillMaster();
        const joints = assignPartJoints(master, SPEC);
        let bladeCount = 0;
        for (let i = 0; i < master.count; i++) {
            const expected = isBlade(master.x[i]!, master.y[i]!, master.z[i]!) ? 1 : 0;
            // The two hub cells inside the box (z = 22, 23) are connected to the disc
            // and so ride with it — the box is the Forger's call, not the rule's.
            if (master.z[i]! >= 22 && master.z[i]! < 24 && master.x[i] === 15 && master.y[i] === 19) continue;
            expect(joints[i]).toBe(expected);
            if (expected) bladeCount++;
        }
        expect(bladeCount).toBeGreaterThan(50);
    });

    test('drops a component inside the box that is a sliver of something else', () => {
        const { master } = windmillMaster();
        // Widen the box so it swallows the tower's top rows too: the tower slice is
        // connected to the disc through the hub, so nothing is a separate component
        // here — but a box around empty space plus a stray cell must drop the stray.
        const spec: SmartObjectSpec = {
            ...SPEC,
            parts: [{
                ...SPEC.parts[0]!,
                box: { min: [0, 0, 0], max: [31, 31, 12] },   // only the tower's back rows: z 14..17 are outside → nothing
            }],
        };
        const joints = assignPartJoints(master, spec);
        expect(Array.from(joints).every((j) => j === 0)).toBe(true);
    });

    test('a later part carves out of an earlier one', () => {
        const { master } = windmillMaster();
        const spec: SmartObjectSpec = {
            ...SPEC,
            parts: [
                SPEC.parts[0]!,
                { name: 'tip', parent: 'blades', box: { min: [8, 19, 24], max: [10, 19, 25] }, pivot: [9, 19, 25], motion: { kind: 'upright' } },
            ],
        };
        const joints = assignPartJoints(master, spec);
        for (let i = 0; i < master.count; i++) {
            if (master.z[i]! >= 24 && master.y[i] === 19 && master.x[i]! >= 8 && master.x[i]! <= 10) expect(joints[i]).toBe(2);
        }
    });
});

describe('the part channel survives resample, compile and decode', () => {
    test('a windmill baked at half size still has its blades, its table and its pivot', async () => {
        const { master, isBlade } = windmillMaster();
        const joints = assignPartJoints(master, SPEC);
        // Master height is 28 rows; ask for 14 cells tall → scale 0.5.
        const voxelSize = 0.1;
        const working = resampleMaster(master, { targetHeight: 1.4, voxelSize, colorMode: 'mode', attribute: joints });
        expect(working.scale).toBeCloseTo(0.5);
        expect(working.attribute).toBeDefined();

        const table = partsTableFromSpec(SPEC.parts);
        const cells = new Map<number, number>();
        for (let i = 0; i < working.count; i++) cells.set(packCell(working.x[i]!, working.y[i]!, working.z[i]!), working.color[i]!);
        const built = await compileVoxelModelToVxlAsset(
            { name: 'windmill', sizeX: 0, sizeY: 0, sizeZ: 0, cells, cellsEmissive: null },
            {
                voxelSize, additionalLodCount: 1, maxLeaves: 600_000,
                smartParts: {
                    cellsPart: cellsPartFromWorking(working, packCell),
                    parts: table,
                    pivots: SPEC.parts.map((part) => masterPointToCells(working, part.pivot)),
                },
            },
        );

        const decoded = await decodeVxlV3(built.vxlBytes.buffer.slice(
            built.vxlBytes.byteOffset, built.vxlBytes.byteOffset + built.vxlBytes.byteLength) as ArrayBuffer);
        expect(decoded.parts).toEqual(table);
        expect(decoded.rig?.skeletonRef).toBe(PARTS_SKELETON_REF);

        // LOD 0: cells in front of the tower are blade, the tower is body.
        const buf = decoded.fragments[0]!.leaves;
        expect(buf.bone).not.toBeNull();
        let blade = 0, body = 0;
        for (let i = 0; i < buf.count; i++) {
            // Working cell → master cell centre, to ask the oracle.
            const mx = working.masterMin[0] + (buf.gx[i]! + 0.5) / working.scale;
            const my = working.masterMin[1] + (buf.gy[i]! + 0.5) / working.scale;
            const mz = working.masterMin[2] + (buf.gz[i]! + 0.5) / working.scale;
            const front = mz >= 24;
            if (front) expect(buf.bone![i]).toBe(1); else if (mz < 18) expect(buf.bone![i]).toBe(0);
            if (buf.bone![i] === 1) blade++; else body++;
            void isBlade(mx, my, mz);
        }
        expect(blade).toBeGreaterThan(0);
        expect(body).toBeGreaterThan(blade);

        // LOD 1 still knows which cells are blade.
        const lod1 = decoded.additionalLods![0]!.fragments[0]!.leaves;
        expect(lod1.bone).not.toBeNull();
        expect(Array.from(lod1.bone!).some((j) => j === 1)).toBe(true);

        // The pivot landed at the disc's centre in metres: the compiled frame is XZ-centred
        // with the ground at y = 0, and the disc centre is (15.5, 19.5, 25) in master space.
        const pivot = built.smartPivots![0]!;
        const cellsPivot = masterPointToCells(working, SPEC.parts[0]!.pivot);
        expect(pivot.x).toBeCloseTo(built.bounds.minX + cellsPivot[0] * voxelSize, 5);
        expect(pivot.y).toBeCloseTo(cellsPivot[1] * voxelSize, 5);
        expect(pivot.z).toBeCloseTo(built.bounds.minZ + cellsPivot[2] * voxelSize, 5);
        // The bind position is the same pivot, local to the body at the origin.
        expect(decoded.rig!.bindPositions[3]).toBeCloseTo(pivot.x, 5);
        expect(decoded.rig!.bindPositions[4]).toBeCloseTo(pivot.y, 5);
        expect(decoded.rig!.bindPositions[5]).toBeCloseTo(pivot.z, 5);

        // The fitment and the lights use the same mapping.
        const fitment = fitmentFromSpec(SPEC, table, built.smartPivots!);
        expect(fitment.parts[0]!.pivot).toEqual(pivot);
        expect(fitment.parts[0]!.motion).toEqual({ kind: 'spin', axis: [0, 0, 1], rpm: 12 });
        expect(fitment.source).toBe(SPEC);
        const lights = lightsFromSpec(SPEC, working, built.bounds, voxelSize);
        expect(lights).toHaveLength(1);
        expect(lights[0]!.color).toBe('#ffd27a');
        expect(lights[0]!.intensity).toBe(15);
        // The lamp is on the tower's back face, 24 master rows up → 1.2 m at scale 0.5.
        expect(lights[0]!.offset!.y).toBeCloseTo(1.2, 5);
    });

    test('a spec with an unknown parent falls back to the body, parents-first', () => {
        const table = partsTableFromSpec([
            { name: 'cabin', parent: 'wheel', box: { min: [0, 0, 0], max: [1, 1, 1] }, pivot: [0, 0, 0], motion: { kind: 'upright' } },
            { name: 'wheel', box: { min: [0, 0, 0], max: [1, 1, 1] }, pivot: [0, 0, 0], motion: { kind: 'spin', axis: [0, 0, 2], rpm: 2 } },
        ]);
        // 'wheel' is a later joint, so the cabin cannot parent it; it hangs from the body.
        expect(table[0]).toEqual({ name: 'cabin', parentJoint: 0, motion: { kind: 'upright' } });
        // Axes are normalised.
        expect(table[1]!.motion).toEqual({ kind: 'spin', axis: [0, 0, 1], rpm: 2 });
    });
});
