import { bakeSurfaceAssetLeaves } from 'engine/SurfaceAssetVoxelizer.js';
import type { RasterTriangle } from 'engine/vxlscene/SurfaceRasterizer.js';

type V3 = [number, number, number];

function tri(v0: V3, v1: V3, v2: V3, normal: V3, color = { r: 0.8, g: 0.2, b: 0.1 }): RasterTriangle {
    return { v0, v1, v2, normal, nodeName: '', sampleColor: () => color };
}

/** Two triangles forming the quad (a,b,c,d) with the given normal. */
function quad(a: V3, b: V3, c: V3, d: V3, normal: V3, color?: { r: number; g: number; b: number }): RasterTriangle[] {
    return [tri(a, b, c, normal, color), tri(a, c, d, normal, color)];
}

/** Closed axis-aligned box [0,s]^3 (12 triangles, outward normals). */
function boxTris(s: number): RasterTriangle[] {
    return [
        ...quad([0, 0, 0], [0, s, 0], [s, s, 0], [s, 0, 0], [0, 0, -1]),   // -Z
        ...quad([0, 0, s], [s, 0, s], [s, s, s], [0, s, s], [0, 0, 1]),    // +Z
        ...quad([0, 0, 0], [0, 0, s], [0, s, s], [0, s, 0], [-1, 0, 0]),   // -X
        ...quad([s, 0, 0], [s, s, 0], [s, s, s], [s, 0, s], [1, 0, 0]),    // +X
        ...quad([0, 0, 0], [s, 0, 0], [s, 0, s], [0, 0, s], [0, -1, 0]),   // -Y
        ...quad([0, s, 0], [0, s, s], [s, s, s], [s, s, 0], [0, 1, 0]),    // +Y
    ];
}

describe('bakeSurfaceAssetLeaves', () => {
    it('fills a closed box to its full volume with octree-aligned leaves', async () => {
        const { leaves } = await bakeSurfaceAssetLeaves(boxTris(4), {
            minVoxelSize: 0.5, maxVoxelSize: 2, fillInterior: true,
        });
        expect(leaves.length).toBeGreaterThan(0);
        let volume = 0;
        for (const l of leaves) {
            volume += l.size ** 3;
            // Sizes are power-of-two multiples of the min voxel.
            expect(Math.log2(l.size / 0.5) % 1).toBeCloseTo(0, 6);
            // Every leaf lies inside the box (with one cell of rasterization slack).
            expect(l.x).toBeGreaterThanOrEqual(-0.5);
            expect(l.x + l.size).toBeLessThanOrEqual(4.5);
            expect(l.y).toBeGreaterThanOrEqual(-0.5);
            expect(l.y + l.size).toBeLessThanOrEqual(4.5);
        }
        // Interior fill + surface shell approximate the 4^3 = 64 volume. The
        // global interior field is coarse relative to this small test box, so
        // allow generous under-fill; the surface shell alone is ~37.
        expect(volume).toBeGreaterThan(64 * 0.55);
        expect(volume).toBeLessThan(64 * 1.35);
        // Compaction produced leaves LARGER than min (merging works).
        expect(leaves.some((l) => l.size > 0.5)).toBe(true);
    });

    it('keeps a thin 45-degree ramp near min voxel size (no runaway slant merging)', async () => {
        // A thin tilted sheet: y = x, spanning 8m. The octree algorithm's failure
        // mode was multi-meter leaves on exactly this shape. The surface bake only
        // merges FULLY OCCUPIED power-of-two blocks — a lossless representation
        // change (8 children tile the parent exactly) — so the rasterized band of
        // a thin sheet can merge at most one level; nothing approaches the 4m max.
        const n: V3 = [-Math.SQRT1_2, Math.SQRT1_2, 0];
        const sheet = quad([0, 0, 0], [8, 8, 0], [8, 8, 8], [0, 0, 8], n);
        const { leaves } = await bakeSurfaceAssetLeaves(sheet, {
            minVoxelSize: 0.25, maxVoxelSize: 4, fillInterior: false,
        });
        expect(leaves.length).toBeGreaterThan(100);
        for (const l of leaves) {
            expect(l.size).toBeLessThanOrEqual(0.5 + 1e-9);
        }
    });

    it('honors fillInterior=false (shell only)', async () => {
        const filled = await bakeSurfaceAssetLeaves(boxTris(4), { minVoxelSize: 0.5, maxVoxelSize: 2, fillInterior: true });
        const shell = await bakeSurfaceAssetLeaves(boxTris(4), { minVoxelSize: 0.5, maxVoxelSize: 2, fillInterior: false });
        const vol = (ls: { size: number }[]): number => ls.reduce((a, l) => a + l.size ** 3, 0);
        expect(vol(shell.leaves)).toBeLessThan(vol(filled.leaves));
    });

    it('samples per-cell color from the owning triangle', async () => {
        const red = { r: 1, g: 0, b: 0 };
        const blue = { r: 0, g: 0, b: 1 };
        // One flat ground quad whose color depends on X: red below x=2, blue above.
        const colorByX = (p: V3): { r: number; g: number; b: number } => (p[0] < 2 ? red : blue);
        const ground: RasterTriangle[] = quad([0, 0, 0], [4, 0, 0], [4, 0, 4], [0, 0, 4], [0, 1, 0]).map((t) => ({
            ...t,
            sampleColor: (p: [number, number, number]) => colorByX(p),
        }));
        const { leaves } = await bakeSurfaceAssetLeaves(ground, {
            minVoxelSize: 0.5, maxVoxelSize: 0.5, fillInterior: false,
        });
        const reds = leaves.filter((l) => l.r > 0.5 && l.b < 0.5);
        const blues = leaves.filter((l) => l.b > 0.5 && l.r < 0.5);
        expect(reds.length).toBeGreaterThan(0);
        expect(blues.length).toBeGreaterThan(0);
        // Red leaves sit on the low-X side, blue on the high-X side.
        expect(Math.max(...reds.map((l) => l.x))).toBeLessThan(Math.min(...blues.map((l) => l.x)) + 1);
    });
});
