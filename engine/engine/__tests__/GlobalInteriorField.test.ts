import { buildGlobalInterior, fillInteriorFromField, type GlobalTriangle } from 'engine/vxlscene/GlobalInteriorField.js';
import { packCell, type RasterCtx } from 'engine/vxlscene/SurfaceRasterizer.js';
import type { CellAttr } from 'engine/vxlscene/SceneVoxTypes.js';

/**
 * 12 outward-facing triangles of the axis-aligned box [min..max]^3. Winding order
 * does not matter for the flood-fill field (it only checks AABB overlap), but we
 * keep a sensible CCW order for parity with WindingNumberFill's cubeTris. Faces are
 * appended in the order: -z, +z, -y, +y, -x, +x (so +y is tris[6],[7]).
 */
function box(min: number, max: number): GlobalTriangle[] {
    const a = min, b = max;
    const v = [
        [a, a, a], [b, a, a], [b, b, a], [a, b, a], // z = a face
        [a, a, b], [b, a, b], [b, b, b], [a, b, b], // z = b face
    ] as [number, number, number][];
    const quad = (i: number, j: number, k: number, l: number): GlobalTriangle[] => [
        { v0: v[i]!, v1: v[j]!, v2: v[k]! },
        { v0: v[i]!, v1: v[k]!, v2: v[l]! },
    ];
    return [
        ...quad(0, 3, 2, 1), // -z
        ...quad(4, 5, 6, 7), // +z
        ...quad(0, 1, 5, 4), // -y
        ...quad(3, 7, 6, 2), // +y
        ...quad(0, 4, 7, 3), // -x
        ...quad(1, 2, 6, 5), // +x
    ];
}

describe('buildGlobalInterior', () => {
    it('a closed box: deep interior is interior, points outside are exterior', () => {
        // Box [4,16]^3 inside a [0,20]^3 world; cellSize 1.
        const tris = box(4, 16);
        const bounds = { minX: 0, minY: 0, minZ: 0, maxX: 20, maxY: 20, maxZ: 20 };
        const field = buildGlobalInterior(tris, bounds, { cellSize: 1 });

        // Deep center is enclosed → interior.
        expect(field.isInterior(10, 10, 10)).toBe(true);
        // A point clearly inside but off-center.
        expect(field.isInterior(7, 12, 9)).toBe(true);

        // Points outside the box (but inside the world) are exterior.
        expect(field.isInterior(2, 2, 2)).toBe(false);
        expect(field.isInterior(18, 18, 18)).toBe(false);
        expect(field.isInterior(10, 1, 10)).toBe(false); // below the box
        expect(field.isInterior(1, 10, 10)).toBe(false); // beside the box
    });

    it('a far point (outside world bounds) is exterior', () => {
        const field = buildGlobalInterior(box(4, 16), { minX: 0, minY: 0, minZ: 0, maxX: 20, maxY: 20, maxZ: 20 }, { cellSize: 1 });
        expect(field.isInterior(1000, 1000, 1000)).toBe(false);
        expect(field.isInterior(-50, 10, 10)).toBe(false);
    });

    it('reports the coarse cell size used', () => {
        const field = buildGlobalInterior(box(4, 16), { minX: 0, minY: 0, minZ: 0, maxX: 20, maxY: 20, maxZ: 20 }, { cellSize: 2 });
        expect(field.cellSize).toBeGreaterThan(0);
    });

    it('an open box (one face removed) leaks: interior near the hole becomes exterior', () => {
        // Documents the accepted flood-fill trade-off vs the winding number: a hole
        // lets the exterior flood reach the inside, so cells reachable through the
        // opening are classified exterior. Remove the +Y face (the last quad's 2 tris).
        const closed = box(4, 16);
        // box() appends faces in order: -z,+z,-y,+y,-x,+x → +y is tris[6],[7].
        const open = closed.filter((_, i) => i !== 6 && i !== 7);
        const bounds = { minX: 0, minY: 0, minZ: 0, maxX: 20, maxY: 20, maxZ: 20 };

        const closedField = buildGlobalInterior(closed, bounds, { cellSize: 1 });
        const openField = buildGlobalInterior(open, bounds, { cellSize: 1 });

        // With the lid on, just under the top is interior.
        expect(closedField.isInterior(10, 14, 10)).toBe(true);
        // With the lid removed, the exterior floods down through the hole, so a cell
        // just under where the top WAS is now reachable → exterior.
        expect(openField.isInterior(10, 14, 10)).toBe(false);
    });

    it('handles an empty triangle list: everything is exterior (no enclosed region)', () => {
        const field = buildGlobalInterior([], { minX: 0, minY: 0, minZ: 0, maxX: 8, maxY: 8, maxZ: 8 }, { cellSize: 1 });
        expect(field.isInterior(4, 4, 4)).toBe(false);
        expect(field.hasInterior).toBe(false);
    });

    it('interiorAabbOverlaps rejects regions away from the interior, accepts the enclosed region', () => {
        // Box [20,40]^3 inside an 80^3 world; interior is roughly the central region.
        const field = buildGlobalInterior(box(20, 40), { minX: 0, minY: 0, minZ: 0, maxX: 80, maxY: 80, maxZ: 80 }, { cellSize: 2 });
        expect(field.hasInterior).toBe(true);
        // A region overlapping the box interior overlaps.
        expect(field.interiorAabbOverlaps(28, 28, 28, 32, 32, 32)).toBe(true);
        // A far corner region does NOT overlap the interior AABB.
        expect(field.interiorAabbOverlaps(60, 60, 60, 80, 80, 80)).toBe(false);
        expect(field.interiorAabbOverlaps(0, 0, 0, 8, 8, 8)).toBe(false);
        // An open scene never overlaps.
        const open = buildGlobalInterior([], { minX: 0, minY: 0, minZ: 0, maxX: 80, maxY: 80, maxZ: 80 }, { cellSize: 2 });
        expect(open.interiorAabbOverlaps(0, 0, 0, 80, 80, 80)).toBe(false);
    });

    it('hasInterior is true for a closed box, false for an open/empty scene', () => {
        const closed = buildGlobalInterior(box(4, 16), { minX: 0, minY: 0, minZ: 0, maxX: 20, maxY: 20, maxZ: 20 }, { cellSize: 1 });
        expect(closed.hasInterior).toBe(true);
        // A single flat quad (open) encloses nothing.
        const quad: GlobalTriangle[] = [
            { v0: [2, 5, 2], v1: [18, 5, 2], v2: [18, 5, 18] },
            { v0: [2, 5, 2], v1: [18, 5, 18], v2: [2, 5, 18] },
        ];
        const open = buildGlobalInterior(quad, { minX: 0, minY: 0, minZ: 0, maxX: 20, maxY: 20, maxZ: 20 }, { cellSize: 1 });
        expect(open.hasInterior).toBe(false);
    });
});

describe('fillInteriorFromField', () => {
    /** Set of min-cell keys covered by a voxel (expanded over its 2^L extent). */
    function coveredCells(voxels: { gx: number; gy: number; gz: number; sizeLevel: number }[]): Set<number> {
        const set = new Set<number>();
        for (const v of voxels) {
            const ext = 1 << v.sizeLevel;
            for (let dx = 0; dx < ext; dx++)
                for (let dy = 0; dy < ext; dy++)
                    for (let dz = 0; dz < ext; dz++)
                        set.add(packCell(v.gx + dx, v.gy + dy, v.gz + dz));
        }
        return set;
    }

    it('a small closed box emits interior voxels covering the inside, exterior empty; grid not mutated', () => {
        // chunk = cells [0,6) at minVoxelSize 1, box world [1,5]^3 → interior cells 2..4 centers.
        const ctx: RasterCtx = { originCellX: 0, originCellY: 0, originCellZ: 0, cellsPerAxis: 6, minVoxelSize: 1, controlsByNode: {} };
        const field = buildGlobalInterior(box(1, 5), { minX: 0, minY: 0, minZ: 0, maxX: 6, maxY: 6, maxZ: 6 }, { cellSize: 1 });
        const grid = new Map<number, CellAttr>();
        const result = fillInteriorFromField(grid, ctx, field);

        expect(grid.size).toBe(0); // not mutated
        expect(result.voxels.length).toBeGreaterThan(0);

        const covered = coveredCells(result.voxels);
        // Deep interior covered, exterior corners not.
        expect(covered.has(packCell(3, 3, 3))).toBe(true);
        expect(covered.has(packCell(0, 0, 0))).toBe(false);
        expect(covered.has(packCell(5, 5, 5))).toBe(false);

        // isSolid agrees.
        expect(result.isSolid(3, 3, 3)).toBe(true);
        expect(result.isSolid(0, 0, 0)).toBe(false);
        // Outside the chunk cell range → false.
        expect(result.isSolid(-1, 3, 3)).toBe(false);
        expect(result.isSolid(6, 3, 3)).toBe(false);
    });

    it('interior voxels share one uniform color (average of surface colors); colliders, no disp', () => {
        const ctx: RasterCtx = { originCellX: 0, originCellY: 0, originCellZ: 0, cellsPerAxis: 6, minVoxelSize: 1, controlsByNode: {} };
        const field = buildGlobalInterior(box(1, 5), { minX: 0, minY: 0, minZ: 0, maxX: 6, maxY: 6, maxZ: 6 }, { cellSize: 1 });
        const grid = new Map<number, CellAttr>();
        const surf = (x: number, y: number, z: number, color: { r: number; g: number; b: number }): void => {
            grid.set(packCell(x, y, z), { color, nx: 0, ny: 1, nz: 0, interior: false, noCollider: false, displacementAxis: null, pinned: false, dispOffset: 0 });
        };
        surf(1, 1, 1, { r: 1, g: 0, b: 0 });
        surf(4, 4, 4, { r: 0, g: 0, b: 1 });
        const result = fillInteriorFromField(grid, ctx, field);

        expect(result.voxels.length).toBeGreaterThan(0);
        const first = result.voxels[0]!;
        expect(first.color.r).toBeCloseTo(0.5, 5);
        expect(first.color.g).toBeCloseTo(0, 5);
        expect(first.color.b).toBeCloseTo(0.5, 5);
        for (const v of result.voxels) {
            expect(v.color.r).toBe(first.color.r);
            expect(v.noCollider).toBe(false);
            expect(v.disp).toBeNull();
        }
    });

    it('a FULLY-enclosed chunk collapses to ONE whole-chunk interior voxel (uncapped size)', () => {
        // 16-cell chunk fully inside a big closed box → the entire chunk is interior.
        // With no maxSizeLevel cap the octree merges everything into a single size-4 voxel.
        const ctx: RasterCtx = { originCellX: 0, originCellY: 0, originCellZ: 0, cellsPerAxis: 16, minVoxelSize: 1, controlsByNode: {} };
        // Box spans well beyond the chunk so every chunk cell is enclosed.
        const field = buildGlobalInterior(box(-50, 50), { minX: -64, minY: -64, minZ: -64, maxX: 64, maxY: 64, maxZ: 64 }, { cellSize: 2 });
        // Sanity: the field really classifies the chunk region as interior.
        expect(field.isInterior(8, 8, 8)).toBe(true);

        const result = fillInteriorFromField(new Map<number, CellAttr>(), ctx, field);
        expect(result.voxels.length).toBe(1);
        expect(result.voxels[0]!.sizeLevel).toBe(4); // log2(16) — whole chunk
        expect(result.voxels[0]!).toMatchObject({ gx: 0, gy: 0, gz: 0 });
    });

    it('large interior bulk emits FEW voxels (not ~volume)', () => {
        // 64-cell chunk, big enclosing box → interior bulk ~ whole chunk minus a thin
        // surface skin. Voxel count must be tiny (octree-merged), far below 64^3.
        const ctx: RasterCtx = { originCellX: 0, originCellY: 0, originCellZ: 0, cellsPerAxis: 64, minVoxelSize: 1, controlsByNode: {} };
        const field = buildGlobalInterior(box(-100, 100), { minX: -128, minY: -128, minZ: -128, maxX: 128, maxY: 128, maxZ: 128 }, { cellSize: 2 });
        const result = fillInteriorFromField(new Map<number, CellAttr>(), ctx, field);
        expect(result.voxels.length).toBeLessThan(100);
        expect(result.isSolid(32, 32, 32)).toBe(true);
        // Covered volume equals the whole chunk (fully enclosed).
        const covered = coveredCells(result.voxels);
        expect(covered.size).toBe(64 * 64 * 64);
    });

    it('a fully-exterior chunk emits nothing', () => {
        const ctx: RasterCtx = { originCellX: 0, originCellY: 0, originCellZ: 0, cellsPerAxis: 8, minVoxelSize: 1, controlsByNode: {} };
        // Box far away → the chunk region is all exterior.
        const field = buildGlobalInterior(box(100, 110), { minX: 0, minY: 0, minZ: 0, maxX: 120, maxY: 120, maxZ: 120 }, { cellSize: 2 });
        const result = fillInteriorFromField(new Map<number, CellAttr>(), ctx, field);
        expect(result.voxels.length).toBe(0);
        expect(result.isSolid(4, 4, 4)).toBe(false);
    });

    it('respects a maxSizeLevel cap when provided (interior voxels stay <= cap)', () => {
        const ctx: RasterCtx = { originCellX: 0, originCellY: 0, originCellZ: 0, cellsPerAxis: 16, minVoxelSize: 1, controlsByNode: {} };
        const field = buildGlobalInterior(box(-50, 50), { minX: -64, minY: -64, minZ: -64, maxX: 64, maxY: 64, maxZ: 64 }, { cellSize: 2 });
        const result = fillInteriorFromField(new Map<number, CellAttr>(), ctx, field, { maxSizeLevel: 2 });
        expect(result.voxels.length).toBeGreaterThan(1);
        for (const v of result.voxels) expect(v.sizeLevel).toBeLessThanOrEqual(2);
    });
});
