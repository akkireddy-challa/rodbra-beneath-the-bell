import { dropAssetInstanceTriangles } from 'engine/VxlWorldVoxelizer.js';
import type { RasterTriangle } from 'engine/vxlscene/SurfaceRasterizer.js';

function tri(nodeName: string, x: number, y: number, z: number): RasterTriangle {
    return {
        v0: [x, y, z],
        v1: [x + 1, y, z],
        v2: [x, y, z + 1],
        normal: [0, 1, 0],
        nodeName,
        sampleColor: () => ({ r: 0.5, g: 0.5, b: 0.5 }),
    };
}

const BOUNDS = { minX: 0, minY: 0, minZ: 0, maxX: 64, maxY: 16, maxZ: 64 };

describe('dropAssetInstanceTriangles (library-asset instance groups skip the level bake)', () => {
    it('passes everything through when no objects are tagged', () => {
        const tris = [tri('Terrain', 0, 0, 0), tri('Pines', 10, 2, 10)];
        const a = dropAssetInstanceTriangles(tris, BOUNDS, undefined);
        const b = dropAssetInstanceTriangles(tris, BOUNDS, {});
        expect(a.triangles).toBe(tris);
        expect(a.bounds).toBe(BOUNDS);
        expect(b.triangles).toBe(tris);
    });

    it('drops tagged objects and recomputes 1m-snapped bounds from the rest', () => {
        const tris = [
            tri('Terrain', 0.4, 0.2, 0.6),       // level geometry
            tri('Terrain', 30.2, 5.5, 30.9),
            tri('Pines', 60, 40, 60),            // tagged decoration far outside
            tri('Lodge', -20, -10, -20),
        ];
        const out = dropAssetInstanceTriangles(tris, BOUNDS, { Pines: true, Lodge: true });
        expect(out.triangles.map((t) => t.nodeName)).toEqual(['Terrain', 'Terrain']);
        // Bounds cover only the terrain triangles, floor/ceil to the 1m grid
        // (matching extraction's snap semantics).
        expect(out.bounds).toEqual({ minX: 0, minY: 0, minZ: 0, maxX: 32, maxY: 6, maxZ: 32 });
    });

    it('untagged names are unaffected by tags for other names', () => {
        const tris = [tri('Terrain', 0, 0, 0), tri('SkiRun', 5, 1, 5)];
        const out = dropAssetInstanceTriangles(tris, BOUNDS, { Pines: true });
        expect(out.triangles).toHaveLength(2);
        expect(out.bounds).toBe(BOUNDS); // nothing dropped — bounds untouched
    });

    it('throws when every object is tagged (no level geometry left)', () => {
        const tris = [tri('Pines', 0, 0, 0)];
        expect(() => dropAssetInstanceTriangles(tris, BOUNDS, { Pines: true })).toThrow(/no level geometry/i);
    });
});
