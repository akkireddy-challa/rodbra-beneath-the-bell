import { greedyBoxes, clipTrimeshToChunk, quadsToTrimesh, quadsToTrimeshSoA, orientTrimeshUpward, type AABB } from 'engine/vxlscene/ColliderBaker.js';
import type { SceneVoxel, SceneQuad } from 'engine/vxlscene/SceneVoxTypes.js';
import type { DecodedChunkQuads } from 'engine/vxlscene/VxlSceneFormat.js';

function v(gx: number, gy: number, gz: number, sizeLevel = 0, noCollider = false): SceneVoxel {
    return { gx, gy, gz, sizeLevel, color: { r: 1, g: 1, b: 1 }, noCollider, disp: null };
}
const boxVol = (b: AABB) => (b.maxX - b.minX) * (b.maxY - b.minY) * (b.maxZ - b.minZ);

describe('greedyBoxes (one box per voxel — O(voxels), no dense occupancy grid)', () => {
    it('a single size-1 voxel yields one box of volume 8', () => {
        // A sizeLevel-1 voxel spans [gx, gx+2) on each axis → an 8-unit box.
        const boxes = greedyBoxes([v(0, 0, 0, 1)]);
        expect(boxes).toHaveLength(1);
        expect(boxVol(boxes[0]!)).toBe(8);
        expect(boxes[0]!).toEqual({ minX: 0, minY: 0, minZ: 0, maxX: 2, maxY: 2, maxZ: 2 });
    });
    it('a solid 2x2x2 set of size-0 (unit) voxels yields 8 boxes (one per voxel)', () => {
        const voxels: SceneVoxel[] = [];
        for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) voxels.push(v(x, y, z));
        const boxes = greedyBoxes(voxels);
        expect(boxes).toHaveLength(8);
        // Total covered volume is conserved (8 unit voxels → volume 8).
        const totalVol = boxes.reduce((s, b) => s + boxVol(b), 0);
        expect(totalVol).toBe(8);
        // Each box is a single unit cube.
        for (const b of boxes) expect(boxVol(b)).toBe(1);
    });
    it('a large interior voxel + small surface voxels: one box each, correct volumes', () => {
        // sizeLevel-3 voxel = 8^3 = 512 box; plus two size-0 unit voxels.
        const boxes = greedyBoxes([v(0, 0, 0, 3), v(100, 0, 0), v(100, 0, 1)]);
        expect(boxes).toHaveLength(3);
        const vols = boxes.map(boxVol).sort((a, b) => a - b);
        expect(vols).toEqual([1, 1, 512]);
    });
    it('excludes noCollider voxels', () => {
        const boxes = greedyBoxes([v(0, 0, 0), v(1, 0, 0, 0, true)]);
        expect(boxes).toHaveLength(1); // only the collider voxel
        const totalVol = boxes.reduce((s, b) => s + boxVol(b), 0);
        expect(totalVol).toBe(1);
    });
    it('returns no boxes when every voxel is noCollider', () => {
        expect(greedyBoxes([v(0, 0, 0, 0, true), v(1, 0, 0, 2, true)])).toHaveLength(0);
    });
});

describe('quadsToTrimesh (load-guard collider from finest LOD quads)', () => {
    function q(over: Partial<SceneQuad> = {}): SceneQuad {
        return { gx: 0, gy: 1, gz: 0, w: 2, h: 3, axis: 1, dir: 1, color: { r: 1, g: 1, b: 1 }, disp: 0, ...over };
    }

    it('emits 4 verts + 6 indices (2 triangles) per quad', () => {
        const { verts, indices } = quadsToTrimesh([q(), q({ gx: 5 })], 0.5, 0, 0, 0);
        expect(verts.length).toBe(2 * 4 * 3); // 2 quads * 4 verts * 3 floats
        expect(indices.length).toBe(2 * 6);   // 2 quads * 2 triangles * 3 indices
        // Indices reference only this primitive's 8 verts.
        for (const idx of indices) expect(idx).toBeLessThan(8);
    });

    it('places a +Y quad at the correct world positions (scaled + origin-offset)', () => {
        // axis=1 (Y), dir=1 → face on the +Y side (origin+1 along Y).
        // u=Z carries w, v=X carries h. minVoxelSize 0.5.
        const { verts } = quadsToTrimesh([q()], 0.5, 0, 0, 0);
        const corners: Array<[number, number, number]> = [];
        for (let i = 0; i < verts.length; i += 3) corners.push([verts[i]!, verts[i + 1]!, verts[i + 2]!]);
        // c00, c10, c11, c01 (see buildHintMesh corner order).
        expect(corners[0]).toEqual([0, 1.0, 0]);
        expect(corners[1]).toEqual([0, 1.0, 1.0]);
        expect(corners[2]).toEqual([1.5, 1.0, 1.0]);
        expect(corners[3]).toEqual([1.5, 1.0, 0]);
    });

    it('applies the chunk origin offset', () => {
        const { verts } = quadsToTrimesh([q()], 0.5, 10, 20, 30);
        // First vertex = c00 + origin.
        expect([verts[0], verts[1], verts[2]]).toEqual([10, 21.0, 30]);
    });

    it('reverses winding for dir === -1', () => {
        const plus = quadsToTrimesh([q({ dir: 1 })], 1, 0, 0, 0);
        const minus = quadsToTrimesh([q({ dir: -1 })], 1, 0, 0, 0);
        // Same vert order; the second triangle of each pair differs by winding.
        expect(Array.from(plus.indices)).toEqual([0, 1, 2, 0, 2, 3]);
        expect(Array.from(minus.indices)).toEqual([0, 2, 1, 0, 3, 2]);
    });

    it('handles an empty quad list', () => {
        const { verts, indices } = quadsToTrimesh([], 0.5, 0, 0, 0);
        expect(verts.length).toBe(0);
        expect(indices.length).toBe(0);
    });
});

describe('clipTrimeshToChunk', () => {
    const chunk = { minX: 0, minY: 0, minZ: 0, maxX: 16, maxY: 16, maxZ: 16 };
    it('passes a fully-inside triangle through (3 verts, 1 tri)', () => {
        const blob = clipTrimeshToChunk([{ v0: [1, 1, 1], v1: [5, 1, 1], v2: [1, 5, 1] }], chunk);
        expect(blob.verts.length).toBe(9);   // 3 verts * 3
        expect(blob.indices.length).toBe(3); // 1 tri
    });
    it('clips a triangle straddling the +x border to within the chunk', () => {
        const blob = clipTrimeshToChunk([{ v0: [10, 1, 1], v1: [20, 1, 1], v2: [10, 5, 1] }], chunk);
        expect(blob.indices.length).toBeGreaterThanOrEqual(3); // at least 1 triangle remains
        // every vertex lies within the chunk (x clamped to <= 16)
        for (let i = 0; i < blob.verts.length; i += 3) {
            expect(blob.verts[i]!).toBeLessThanOrEqual(16.0001);
            expect(blob.verts[i]!).toBeGreaterThanOrEqual(-0.0001);
        }
    });
});

describe('quadsToTrimeshSoA excludes no-collider quads (axisDir bit 6)', () => {
    // Two unit +Y quads; the second is flagged no-collider (decoration like a
    // painted line). The collider must contain ONLY the first.
    const mkQuads = (secondNoCollider: boolean): DecodedChunkQuads => ({
        count: 2,
        gx: Uint16Array.from([0, 5]),
        gy: Uint16Array.from([0, 0]),
        gz: Uint16Array.from([0, 0]),
        w: Uint16Array.from([1, 1]),
        h: Uint16Array.from([1, 1]),
        // axis=1 (Y), dir +1 (bit2=0); second quad sets bit 6 (no-collider) when asked.
        axisDir: Uint8Array.from([0b010, 0b010 | (secondNoCollider ? 1 << 6 : 0)]),
        colorIdx: Uint16Array.from([0, 0]),
        disp: Int8Array.from([0, 0]),
    });

    it('drops the flagged quad (one quad worth of geometry remains)', () => {
        const blob = quadsToTrimeshSoA(mkQuads(true), 1, 0, 0, 0);
        expect(blob.verts.length).toBe(4 * 3); // 1 quad → 4 verts
        expect(blob.indices.length).toBe(6);   // 1 quad → 2 triangles
    });

    it('keeps both when neither is flagged (control)', () => {
        const blob = quadsToTrimeshSoA(mkQuads(false), 1, 0, 0, 0);
        expect(blob.verts.length).toBe(2 * 4 * 3);
        expect(blob.indices.length).toBe(2 * 6);
    });
});

describe('orientTrimeshUpward (rescue back-wound baked trimesh colliders)', () => {
    // Y of triangle (i0,i1,i2)'s geometric face normal — what Rapier derives the
    // contact normal from (winding, not stored vertex normals). x/z edges only.
    const normalY = (verts: Float32Array, i0: number, i1: number, i2: number): number => {
        const ax = verts[i0 * 3]!, az = verts[i0 * 3 + 2]!;
        const bx = verts[i1 * 3]!, bz = verts[i1 * 3 + 2]!;
        const cx = verts[i2 * 3]!, cz = verts[i2 * 3 + 2]!;
        return (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    };

    it('flips a downward-wound (back-faced) triangle so it faces up', () => {
        const verts = new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 1]); // wound −Y
        const indices = new Uint32Array([0, 1, 2]);
        expect(normalY(verts, indices[0]!, indices[1]!, indices[2]!)).toBeLessThan(0);
        const fixed = orientTrimeshUpward(verts, indices);
        expect(normalY(verts, fixed[0]!, fixed[1]!, fixed[2]!)).toBeGreaterThan(0);
    });

    it('leaves an already-upward triangle untouched', () => {
        const verts = new Float32Array([0, 0, 0, 1, 0, 1, 1, 0, 0]); // wound +Y
        const indices = new Uint32Array([0, 1, 2]);
        const fixed = orientTrimeshUpward(verts, indices);
        expect(Array.from(fixed)).toEqual([0, 1, 2]);
    });

    it('orients a mixed mesh so no triangle faces down', () => {
        const verts = new Float32Array([
            0, 0, 0, 1, 0, 0, 1, 0, 1, // tri A: down
            0, 0, 0, 1, 0, 1, 1, 0, 0, // tri B: up
        ]);
        const fixed = orientTrimeshUpward(verts, new Uint32Array([0, 1, 2, 3, 4, 5]));
        for (let t = 0; t < fixed.length; t += 3) {
            expect(normalY(verts, fixed[t]!, fixed[t + 1]!, fixed[t + 2]!)).toBeGreaterThanOrEqual(0);
        }
    });

    it('does not flip vertical triangles (normal.y ≈ 0 — walls stay as-is)', () => {
        // A vertical triangle in the x=0 plane: normal is horizontal (ny ≈ 0).
        const verts = new Float32Array([0, 0, 0, 0, 0, 1, 0, 1, 0]);
        const indices = new Uint32Array([0, 1, 2]);
        const fixed = orientTrimeshUpward(verts, indices);
        expect(Array.from(fixed)).toEqual([0, 1, 2]);
    });
});
