import {
    VoxelChunk,
    baseFootprint,
    footprintGroundSamples,
    footprintGroundHeight,
    type ChunkKey,
} from 'engine/VoxelGeometry.js';

/** Chunk map from absolute voxel coordinates, split into 16-voxel chunks. */
function chunksFromVoxels(voxels: Array<[number, number, number]>): Map<ChunkKey, VoxelChunk> {
    const chunks = new Map<ChunkKey, VoxelChunk>();
    const fdiv = (a: number, b: number): number => Math.floor(a / b);
    for (const [x, y, z] of voxels) {
        const cx = fdiv(x, 16), cy = fdiv(y, 16), cz = fdiv(z, 16);
        const key = `${cx},${cy},${cz}` as ChunkKey;
        let chunk = chunks.get(key);
        if (!chunk) { chunk = new VoxelChunk(); chunk.palette = [0, 9]; chunks.set(key, chunk); }
        chunk.set(x - cx * 16, y - cy * 16, z - cz * 16, 9);
    }
    return chunks;
}

// The default tree asset: one trunk voxel at index 0 with a wide canopy above it,
// voxelSize 0.5, boundsOffset -1.5, pivot 0.25.
const VS = 0.5;
const OFFSET = { x: -1.5, z: -1.5 };
const PIVOT = { x: 0.25, z: 0.25 };

describe('baseFootprint', () => {
    it('measures the lowest layer only, ignoring a wider canopy above it', () => {
        const chunks = chunksFromVoxels([
            [0, 0, 0],                                     // trunk
            [-3, 5, -3], [3, 5, 3], [0, 6, 0],             // canopy, much wider
        ]);
        // Trunk voxel 0 spans [offset - pivot, +voxelSize) = [-1.75, -1.25).
        expect(baseFootprint(chunks, VS, OFFSET, PIVOT)).toEqual({
            minX: -1.75, maxX: -1.25, minZ: -1.75, maxZ: -1.25,
        });
    });

    it('spans every voxel in the lowest layer when the base is wider', () => {
        const chunks = chunksFromVoxels([[0, 0, 0], [1, 0, 2], [0, 3, 0]]);
        expect(baseFootprint(chunks, VS, OFFSET, PIVOT)).toEqual({
            minX: -1.75, maxX: -0.75, minZ: -1.75, maxZ: -0.25,
        });
    });

    it('lets a newly found lower layer supersede everything measured above it', () => {
        // Chunk iteration order is not sorted by Y, so a lower voxel discovered late
        // must reset the extent rather than widen it.
        const chunks = chunksFromVoxels([[5, 4, 5], [0, 0, 0]]);
        expect(baseFootprint(chunks, VS, OFFSET, PIVOT)).toEqual({
            minX: -1.75, maxX: -1.25, minZ: -1.75, maxZ: -1.25,
        });
    });

    it('returns null when nothing is occupied', () => {
        expect(baseFootprint(new Map(), VS, OFFSET, PIVOT)).toBeNull();
    });
});

describe('footprintGroundSamples', () => {
    const fp = { minX: -0.25, maxX: 0.25, minZ: -0.25, maxZ: 0.25 };

    it('covers the footprint corners around the placed position', () => {
        const pts = footprintGroundSamples(fp, 10, 20, 0, 1, 1, 0.5);
        expect(pts).toHaveLength(4);
        expect(pts).toContainEqual({ x: 9.75, z: 19.75 });
        expect(pts).toContainEqual({ x: 10.25, z: 20.25 });
    });

    it('rotates the footprint about the placed position', () => {
        // 90 deg: local +X maps to world -Z under the engine's yaw convention.
        const [p] = footprintGroundSamples({ minX: 1, maxX: 1, minZ: 0, maxZ: 0 }, 0, 0, Math.PI / 2, 1, 1, 0.5);
        expect(p!.x).toBeCloseTo(1 * Math.cos(Math.PI / 2), 6);
        expect(p!.z).toBeCloseTo(-1, 6);
    });

    it('scales the footprint', () => {
        const pts = footprintGroundSamples(fp, 0, 0, 0, 4, 1, 10);
        const xs = pts.map(p => p.x);
        expect(Math.min(...xs)).toBeCloseTo(-1, 6);
        expect(Math.max(...xs)).toBeCloseTo(1, 6);
    });

    it('adds interior samples for a large footprint but stays bounded', () => {
        const big = { minX: -50, maxX: 50, minZ: -50, maxZ: 50 };
        expect(footprintGroundSamples(big, 0, 0, 0, 1, 1, 0.5)).toHaveLength(9 * 9);
    });
});

describe('footprintGroundHeight', () => {
    const fp = { minX: -0.25, maxX: 0.25, minZ: -0.25, maxZ: 0.25 };

    it('rests the object on the highest terrain under its base', () => {
        // A base straddling a one-block step settles on the upper block, the way a
        // box collider of that footprint would.
        const h = footprintGroundHeight(fp, 0, 0, 0, 1, 1, 0.5, (x) => (x < 0 ? 1 : 2));
        expect(h).toBe(2);
    });

    it('ignores terrain outside the base footprint', () => {
        // A cliff 2 m away — under the canopy, not the trunk — must not lift the tree.
        const h = footprintGroundHeight(fp, 0, 0, 0, 1, 1, 0.5, (x) => (Math.abs(x) > 1 ? 9 : 3));
        expect(h).toBe(3);
    });
});
