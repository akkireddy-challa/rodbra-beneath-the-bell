/** @jest-environment jsdom */
/**
 * `VoxelObject.toVXL()` on a CHUNK-BACKED (procedurally built) object.
 *
 * This is the path the world forger's placeholders take, and it used to emit a legacy
 * JSON form: 324 KB against 2.4 KB for a comparable baked prop, no LOD trailer, and a
 * load path measured at 5.6s for one instance. It now emits VXL3 like every other save.
 *
 * The save path is where a mistake is PERMANENT — a wrong offset or a unit mix-up is
 * written into the asset and every later load faithfully reproduces it. So these tests
 * assert the round trip preserves what a player would see (where the voxels are, how
 * big, what colour), not merely that the output parses. The unit hazard is real and
 * specific: a builder-created object holds `bounds` in VOXEL units, and the old writer
 * carried an explicit comment about a 0.2m prop round-tripping as 4.0m if that was
 * confused with world units.
 */
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from 'util';
(globalThis as unknown as { TextDecoder: unknown }).TextDecoder ??= NodeTextDecoder;
(globalThis as unknown as { TextEncoder: unknown }).TextEncoder ??= NodeTextEncoder;

import { VoxelObject } from 'engine/VoxelObject.js';
import { isVxlV3, decodeVxlV3 } from 'engine/VxlV3Format.js';
import { BlockType, type BlockTypeId } from 'engine/VoxelTextureAtlas.js';

const VOXEL = 0.25;

/** A distinctly asymmetric, multi-coloured solid so any axis swap or offset shows up. */
function buildObject(): VoxelObject {
    const o = new VoxelObject({ voxelSize: VOXEL, useAtlas: false, shadows: false });
    // 3 x 2 x 1 block at a deliberately non-zero origin, each column its own colour.
    for (let x = 0; x < 3; x++) {
        for (let y = 0; y < 2; y++) {
            // BlockType.COLOR is what a vertex-coloured asset uses — the forger's output.
            o.setVoxel(4 + x, 5 + y, 6, BlockType.COLOR, { r: x / 2, g: y, b: 0.5 });
        }
    }
    return o;
}

describe('chunk-backed toVXL', () => {
    it('emits VXL3, never the legacy JSON form', async () => {
        const buf = await buildObject().toVXL();
        expect(isVxlV3(buf)).toBe(true);
        // Belt and braces: the legacy form began with '{"chunks"'.
        expect(String.fromCharCode(new Uint8Array(buf)[0]!)).not.toBe('{');
    });

    it('round-trips voxel COUNT, POSITION, SIZE and COLOUR', async () => {
        const original = buildObject();
        const decoded = await decodeVxlV3(await original.toVXL());
        const leaves = decoded.fragments[0]!.leaves;
        expect(leaves.count).toBe(6);

        // Every leaf is one voxel at world scale — not voxel-index units. A unit mix-up
        // would show as sizes of 1 (indices) or positions off by 1/VOXEL.
        // `toArray` is what turns the packed grid columns back into world-space leaves.
        const seen = leaves.toArray();
        for (const leaf of seen) expect(leaf.size).toBeCloseTo(VOXEL, 6);

        const xs = seen.map(l => l.x).sort((a, b) => a - b);
        const ys = seen.map(l => l.y).sort((a, b) => a - b);
        const zs = seen.map(l => l.z);
        expect(xs[0]).toBeCloseTo(4 * VOXEL, 6);
        expect(xs[xs.length - 1]).toBeCloseTo(6 * VOXEL, 6);
        expect(ys[0]).toBeCloseTo(5 * VOXEL, 6);
        expect(ys[ys.length - 1]).toBeCloseTo(6 * VOXEL, 6);
        for (const z of zs) expect(z).toBeCloseTo(6 * VOXEL, 6);
    });

    it('reloads into an object whose rendered bounds match the original', async () => {
        // The strongest statement available: save, load, and compare what gets DRAWN.
        // Pivot is stored explicitly by the old form but RECOMPUTED from bounds on the
        // VXL3 path, so this is where a silent positional shift would appear.
        const original = buildObject();
        const before = original.getBoundsInWorldUnits();

        const reloaded = new VoxelObject({ voxelSize: VOXEL, useAtlas: false, shadows: false });
        await reloaded.loadFromFile(await original.toVXL());
        const after = reloaded.getBoundsInWorldUnits();

        expect(after.maxX - after.minX).toBeCloseTo(before.maxX - before.minX, 5);
        expect(after.maxY - after.minY).toBeCloseTo(before.maxY - before.minY, 5);
        expect(after.maxZ - after.minZ).toBeCloseTo(before.maxZ - before.minZ, 5);
        expect(reloaded.getMesh()).not.toBeNull();
    });

    it('carries a LOD trailer so the mobile LOD drop can act on it', async () => {
        // Converted assets stuck at lods=1 would render full density at every distance —
        // the defect that made these expensive in the first place.
        const decoded = await decodeVxlV3(await buildObject().toVXL());
        expect(decoded.additionalLods?.length ?? 0).toBeGreaterThan(0);
        // Coarser levels, in increasing voxel size.
        const sizes = (decoded.additionalLods ?? []).map(l => l.minVoxelSize);
        for (const s of sizes) expect(s).toBeGreaterThan(VOXEL);
        expect([...sizes]).toEqual([...sizes].sort((a, b) => a - b));
    });

    it('carries real BLOCK TYPES through as VXL3 (v9), not as flat colour', async () => {
        // The AI voxelAssetCreationTool's path (see VoxelChunkRoundtrip): textured blocks
        // addressed by id. Before v9 these had no VXL3 representation at all and had to be
        // written as JSON; converting them to colour would have flattened the texture away.
        const typed = new VoxelObject({ voxelSize: VOXEL, useAtlas: true, shadows: false });
        typed.setVoxel(1, 0, 1, 11 as BlockTypeId, 0);
        typed.setVoxel(2, 0, 1, 11 as BlockTypeId, 0);
        typed.finalize();

        const buf = await typed.toVXL();
        expect(isVxlV3(buf)).toBe(true);
        const decoded = await decodeVxlV3(buf);
        const leaves = decoded.fragments[0]!.leaves.toArray(true);
        expect(leaves.map(l => l.blockType)).toEqual([11, 11]);
    });

    it('upgrades legacy JSON to octree on the runtime path, and still re-saves it as VXL3', async () => {
        // A legacy asset must RENDER. Refusing it made every pre-VXL3 asset in every
        // existing game vanish silently, because both load sites catch the throw. The
        // cost objection is answered by converting once on load, not by refusing: after
        // this the object is octree-backed, which is what the rest of the engine expects.
        // The `voxels[]` layout the retired generator wrote — the form the default trees
        // and rocks still on the CDN are in. `p` must list the block ids the voxels use,
        // or the loader drops them. Colour blocks (255) rather than textured ones so the
        // mesh build needs no texture atlas, which needs a real 2D canvas.
        const legacy = new TextEncoder().encode(JSON.stringify({
            chunks: {
                '0,0,0': {
                    p: [0, 255],
                    voxels: [
                        { x: 0, y: 0, z: 0, blockId: 255, color: 0xFF0000 },
                        { x: 0, y: 1, z: 0, blockId: 255, color: 0xFF0000 },
                    ],
                },
            },
            metadata: { voxelSize: VOXEL, useAtlas: false },
        })).buffer as ArrayBuffer;

        const runtime = new VoxelObject({ voxelSize: VOXEL, shadows: false });
        await expect(runtime.loadFromFile(legacy)).resolves.toBeDefined();
        expect(runtime.isOctreeV2).toBe(true);
        expect(runtime.getMesh()).not.toBeNull();
        // Upgraded in memory, so it re-encodes as VXL3 like any other loaded asset.
        expect(isVxlV3(await runtime.toVXL())).toBe(true);

        // The re-save path keeps the chunk grid, because that is the branch of `toVXL()`
        // that synthesises LOD levels a legacy file cannot supply.
        const converting = new VoxelObject({ voxelSize: VOXEL, shadows: false });
        await expect(converting.loadLegacyJsonForConversion(legacy)).resolves.toBeDefined();
        expect(converting.isOctreeV2).toBe(false);
        expect(isVxlV3(await converting.toVXL())).toBe(true);
    });

    it('survives an empty grid rather than emitting an unloadable asset', async () => {
        const empty = new VoxelObject({ voxelSize: VOXEL, useAtlas: false, shadows: false });
        const buf = await empty.toVXL();
        expect(isVxlV3(buf)).toBe(true);
        await expect(decodeVxlV3(buf)).resolves.toBeDefined();
    });
});
