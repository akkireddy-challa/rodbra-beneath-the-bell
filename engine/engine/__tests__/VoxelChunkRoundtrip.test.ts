/**
 * @jest-environment jsdom
 */
import { TextEncoder, TextDecoder } from 'util';
// jsdom doesn't expose these as globals on older versions; VoxelObject.toVXL
// constructs a TextEncoder, and loadFromFile decodes via TextDecoder.
if (typeof globalThis.TextEncoder === 'undefined') {
    (globalThis as unknown as { TextEncoder: typeof TextEncoder }).TextEncoder = TextEncoder;
}
if (typeof globalThis.TextDecoder === 'undefined') {
    (globalThis as unknown as { TextDecoder: typeof TextDecoder }).TextDecoder = TextDecoder;
}

import { VoxelChunk } from 'engine/VoxelGeometry.js';
import type { BlockTypeId } from 'engine/VoxelTextureAtlas.js';
import { VoxelObject } from 'engine/VoxelObject.js';

describe('VoxelChunk compaction roundtrip', () => {
    it('serializes correctly after set() switches the chunk into dense mode', () => {
        // Reproduces the May 2026 bug: a fresh chunk starts in RLE state. The
        // first `set()` call switches it to a dense write buffer. If a reader
        // pulls the on-disk RLE without compacting first, it sees the stale
        // initial all-air run.
        const chunk = new VoxelChunk();
        chunk.palette = [0, 11];
        chunk.set(5, 5, 5, 11);
        chunk.set(6, 5, 5, 11);
        chunk.set(7, 5, 5, 11);

        const compacted = chunk.getCompactedRle();

        const loaded = new VoxelChunk();
        loaded.palette = [...chunk.palette];
        loaded.setRleData(compacted);

        expect(loaded.get(5, 5, 5)).toBe(11);
        expect(loaded.get(6, 5, 5)).toBe(11);
        expect(loaded.get(7, 5, 5)).toBe(11);
        expect(loaded.get(0, 0, 0)).toBe(0);
        expect(loaded.get(4, 5, 5)).toBe(0);
        expect(loaded.get(8, 5, 5)).toBe(0);
    });

    it('forEachRun visits compacted runs that cover the full chunk', () => {
        const chunk = new VoxelChunk();
        chunk.palette = [0, 11];
        chunk.set(0, 0, 0, 11);

        let totalCells = 0;
        let solidCells = 0;
        chunk.forEachRun((paletteIndex, runLength) => {
            totalCells += runLength;
            if (paletteIndex !== 0) solidCells += runLength;
        });
        expect(totalCells).toBe(16 * 16 * 16);
        expect(solidCells).toBe(1);
    });
});

describe('VoxelObject VXL roundtrip', () => {
    it('preserves voxel data through toVXL() → loadFromFile()', async () => {
        // End-to-end check of the path the AI voxelAssetCreationTool walks:
        // build voxels with setVoxel, finalize, serialize, then load back and
        // verify the voxels survived. This test would have failed before the
        // ensureCompacted fix in toVXL.
        const vo = new VoxelObject({ voxelSize: 0.25, shadows: false });
        vo.setUseAtlas(true);
        const leaves = 11 as BlockTypeId;
        vo.setVoxel(1, 0, 1, leaves, 0);
        vo.setVoxel(2, 0, 1, leaves, 0);
        vo.setVoxel(3, 0, 1, leaves, 0);
        vo.finalize();

        const bytes = await vo.toVXL();

        const vo2 = new VoxelObject({ voxelSize: 0.25, shadows: false });
        await vo2.loadFromFile(bytes);

        // A chunk grid now saves as VXL3 (v9 carries the block type), so the reloaded
        // object is octree-backed rather than chunk-backed — the `chunks` map is empty by
        // design. What must survive is the DATA: three voxels, all block type 11. Asserting
        // that through the leaves rather than the grid states the real invariant, and stops
        // this test from pinning a storage form the format has moved past.
        const reloaded = (vo2 as unknown as {
            _vxlV3Data: { fragments: Array<{ leaves: { toArray(a?: boolean): Array<{ blockType?: number }> } }> } | null;
        })._vxlV3Data!.fragments[0]!.leaves.toArray(true);
        expect(reloaded).toHaveLength(3);
        expect(reloaded.map(l => l.blockType)).toEqual([11, 11, 11]);
    });

    it('round-trips bounds in WORLD units, not voxel units', async () => {
        // Regression: toVXL() used to serialize raw this.bounds (VOXEL units for a
        // builder-created object), but loadFromFile() always flags bounds as world
        // units — so getBoundsInWorldUnits() came back inflated by 1/voxelSize
        // (here 4× at voxelSize 0.25). That fed a 4× ball-collider / kick radius.
        const voxelSize = 0.25;
        const vo = new VoxelObject({ voxelSize, shadows: false });
        vo.setUseAtlas(true);
        const block = 11 as BlockTypeId;
        // Voxels at grid x=1..3, y=0, z=1 → voxel bounds (1,0,1)..(4,1,2) (max exclusive).
        vo.setVoxel(1, 0, 1, block, 0);
        vo.setVoxel(2, 0, 1, block, 0);
        vo.setVoxel(3, 0, 1, block, 0);
        vo.finalize();

        const bytes = await vo.toVXL();
        const vo2 = new VoxelObject({ voxelSize, shadows: false });
        await vo2.loadFromFile(bytes);

        const b = vo2.getBoundsInWorldUnits();
        expect(b).not.toBeNull();
        // World units: grid coord × voxelSize. maxX = 4 × 0.25 = 1.0 (NOT 4.0).
        expect(b!.minX).toBeCloseTo(0.25, 5);
        expect(b!.maxX).toBeCloseTo(1.0, 5);
        expect(b!.maxY).toBeCloseTo(0.25, 5);
        expect(b!.maxZ).toBeCloseTo(0.5, 5);
        // The largest dimension drives a derived radius — must be ~0.375 m, not 1.5 m.
        const radius = Math.max(b!.maxX - b!.minX, b!.maxY - b!.minY, b!.maxZ - b!.minZ) / 2;
        expect(radius).toBeCloseTo(0.375, 5);
    });
});
