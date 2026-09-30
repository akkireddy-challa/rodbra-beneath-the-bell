/**
 * @jest-environment jsdom
 *
 * `VoxelObjectOptions.primaryLod` — dropping the finest baked LODs AT LOAD.
 *
 * The saving only exists if the dropped level is never meshed, so these tests assert on
 * what the object BUILT (its primary mesh, and which level every LOD index resolves to),
 * not merely on which meshes something downstream chose to draw.
 *
 * The clamp is the risky half: a request for more levels than the asset baked must fall
 * back to the coarsest one it has. Getting that wrong yields an object with no mesh —
 * an invisible prop rather than a coarse one — so each LOD count is pinned explicitly.
 */
import { encodeVxlV3, type VxlV3Data, type VxlV3Fragment } from 'engine/VxlV3Format.js';
import type { OctreeLeaf } from 'engine/VoxelOctreeRenderer.js';
import { VoxelObject } from 'engine/VoxelObject.js';

function makeLeaf(x: number, y: number, z: number, size: number, r: number, g: number, b: number): OctreeLeaf {
    return { x, y, z, size, r, g, b };
}

function makeFragment(leaves: OctreeLeaf[]): VxlV3Fragment {
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const l of leaves) {
        if (l.x < min[0]) min[0] = l.x;
        if (l.y < min[1]) min[1] = l.y;
        if (l.z < min[2]) min[2] = l.z;
        if (l.x + l.size > max[0]) max[0] = l.x + l.size;
        if (l.y + l.size > max[1]) max[1] = l.y + l.size;
        if (l.z + l.size > max[2]) max[2] = l.z + l.size;
    }
    return { aabbMin: min, aabbMax: max, leaves };
}

/** Eight fine leaves — enough geometry that a mesh is genuinely produced. */
function fineLeaves(): OctreeLeaf[] {
    const out: OctreeLeaf[] = [];
    for (let x = 0; x < 2; x++) {
        for (let y = 0; y < 2; y++) {
            for (let z = 0; z < 2; z++) out.push(makeLeaf(x * 0.1, y * 0.1, z * 0.1, 0.1, 1, 0, 0));
        }
    }
    return out;
}

/** A distinguishable coarse level: one leaf of `size`, so levels differ in vertex count. */
function coarseLeaves(size: number): OctreeLeaf[] {
    return [makeLeaf(0, 0, 0, size, 0, 1, 0)];
}

/** `.vxl` bytes carrying LOD0 plus `extraLods` coarser levels. */
async function buildAsset(extraLods: number): Promise<ArrayBuffer> {
    const data: VxlV3Data = {
        minVoxelSize: 0.1,
        maxVoxelSize: 0.4,
        physicsGridStep: 0.1,
        bounds: { minX: 0, minY: 0, minZ: 0, maxX: 0.4, maxY: 0.4, maxZ: 0.4 },
        useAtlas: false,
        fragments: [makeFragment(fineLeaves())],
        additionalLods: Array.from({ length: extraLods }, (_, i) => ({
            fragments: [makeFragment(coarseLeaves(0.2 * (i + 1)))],
        })),
    };
    const encoded = await encodeVxlV3(data, { compression: 'none' });
    return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer;
}

async function load(extraLods: number, primaryLod: number): Promise<VoxelObject> {
    const obj = new VoxelObject({ voxelSize: 0.1, useAtlas: false, shadows: false, primaryLod });
    await obj.loadFromFile(await buildAsset(extraLods));
    return obj;
}

describe('VoxelObject primaryLod', () => {
    it('defaults to the finest level, unchanged', async () => {
        const obj = await load(2, 0);
        expect(obj.getPrimaryLod()).toBe(0);
        expect(obj.getLodCount()).toBe(3);
        expect(obj.getMesh()).not.toBeNull();
    });

    it('promotes the requested level and reports it back', async () => {
        const obj = await load(3, 2); // building-shaped: 4 levels
        expect(obj.getPrimaryLod()).toBe(2);
        expect(obj.getLodCount()).toBe(4); // full count is unchanged — distance schedules key off it
        expect(obj.getMesh()).not.toBeNull();
    });

    it('builds the promoted level, NOT the finest one', async () => {
        const fine = await load(3, 0);
        const promoted = await load(3, 2);
        const fineVerts = fine.getMesh()!.geometry.getAttribute('position').count;
        const promotedVerts = promoted.getMesh()!.geometry.getAttribute('position').count;
        // The coarse level here is a single leaf against LOD0's eight, so a primary mesh
        // that still matched the fine vertex count would mean the drop never happened.
        expect(promotedVerts).toBeLessThan(fineVerts);
        // And it must match what that level yields on its own.
        expect(promotedVerts).toBe(fine.getMeshForLod(2)!.geometry.getAttribute('position').count);
    });

    it('resolves every index at or below the promoted level to the primary mesh', async () => {
        const obj = await load(3, 2);
        const primary = obj.getMesh();
        expect(obj.getMeshForLod(0)).toBe(primary);
        expect(obj.getMeshForLod(1)).toBe(primary);
        expect(obj.getMeshForLod(2)).toBe(primary);
        expect(obj.getMeshForLod(3)).not.toBe(primary); // coarser than primary — its own mesh
    });

    it('clamps to the coarsest level a prop actually baked', async () => {
        const obj = await load(2, 2); // prop-shaped: 3 levels, so LOD2 IS the coarsest
        expect(obj.getPrimaryLod()).toBe(2);
        expect(obj.getMesh()).not.toBeNull();
    });

    it('clamps a request that exceeds the baked levels rather than losing the mesh', async () => {
        const obj = await load(1, 2); // only one extra level exists
        expect(obj.getPrimaryLod()).toBe(1);
        expect(obj.getMesh()).not.toBeNull();
    });

    it('falls back to the finest level for an asset with no extra LODs', async () => {
        const obj = await load(0, 2);
        expect(obj.getPrimaryLod()).toBe(0);
        expect(obj.getLodCount()).toBe(1);
        expect(obj.getMesh()).not.toBeNull(); // never an invisible prop
    });
});
