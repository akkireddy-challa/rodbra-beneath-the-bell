import type { DecodedVxlSceneWorld, DecodedChunk, DecodedChunkVoxels } from 'engine/vxlscene/VxlSceneFormat.js';
import { buildSurfaceField, cellTopY, cellColorIdx, cornerHeightAt, buildChunkSurfaceGeometry } from 'engine/vxlscene/SurfaceMeshBuilder.js';

/** Minimal displaced-voxel column block: cells = array of {gx,gy,gz,colorIdx,dy}. */
function voxels(cells: Array<{ gx: number; gy: number; gz: number; colorIdx: number; dy: number }>): DecodedChunkVoxels {
    const n = cells.length;
    const gx = new Uint16Array(n), gy = new Uint16Array(n), gz = new Uint16Array(n);
    const sizeLevel = new Uint8Array(n), colorIdx = new Uint16Array(n), flags = new Uint8Array(n);
    const disp = new Int8Array(n * 3);
    cells.forEach((c, i) => {
        gx[i] = c.gx; gy[i] = c.gy; gz[i] = c.gz; colorIdx[i] = c.colorIdx;
        flags[i] = 2;            // displaced
        disp[i * 3 + 1] = c.dy;  // Y-only displacement
    });
    return { count: n, gx, gy, gz, sizeLevel, colorIdx, flags, disp };
}

function world(chunks: DecodedChunk[], chunkSize = 4, minVoxelSize = 1): DecodedVxlSceneWorld {
    return {
        chunkSize, minVoxelSize,
        bounds: { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 },
        lodDistances: [], chunks,
    };
}
const chunk = (cx: number, cy: number, cz: number, v: DecodedChunkVoxels): DecodedChunk =>
    ({ cx, cy, cz, voxels: v, lodHints: [], namedTrimeshes: [] });

describe('buildSurfaceField', () => {
    it('maps each displaced cell to a global column with the cell-centre surface height', () => {
        // chunkSize 4, minVoxel 1 → 4 cells/chunk. One cell at chunk(1,0,0) local (2,3,1), dy=0.
        const w = world([chunk(1, 0, 0, voxels([{ gx: 2, gy: 3, gz: 1, colorIdx: 7, dy: 0 }]))]);
        const f = buildSurfaceField(w, 1);
        expect(f.cells).toBe(4);
        // global cell = (1*4+2, 1) = (6,1); top = cy*chunkSize + (gy+0.5)*s + (dy/127)*s
        // = 0 + 3.5 + 0 = 3.5. dy is measured from the CELL CENTRE by SurfaceRasterizer,
        // so dy=0 means "surface through the centre" — not through the cube top.
        expect(cellTopY(f, 6, 1)).toBe(3.5);
        expect(cellColorIdx(f, 6, 1)).toBe(7);
    });

    it('applies the dy sub-cell shift to the surface height', () => {
        const w = world([chunk(0, 0, 0, voxels([{ gx: 0, gy: 0, gz: 0, colorIdx: 0, dy: 127 }]))]);
        const f = buildSurfaceField(w, 1);
        // top = (0+0.5)*1 + (127/127)*1 = 1.5
        expect(cellTopY(f, 0, 0)!).toBeCloseTo(1.5, 6);
    });

    it('welds a shared corner to the average of incident cell heights', () => {
        // Two adjacent cells (0,0) topY=1.5 and (1,0) topY=3.5 share corner (1,0).
        const v = voxels([
            { gx: 0, gy: 1, gz: 0, colorIdx: 0, dy: 0 }, // top = 1.5
            { gx: 1, gy: 3, gz: 0, colorIdx: 0, dy: 0 }, // top = 3.5
        ]);
        const f = buildSurfaceField(world([chunk(0, 0, 0, v)]), 1);
        expect(cornerHeightAt(f, 1, 0)).toBeCloseTo(2.5, 6); // (1.5+3.5)/2
        expect(cornerHeightAt(f, 0, 0)).toBeCloseTo(1.5, 6); // only cell (0,0)
        expect(cornerHeightAt(f, 2, 0)).toBeCloseTo(3.5, 6); // only cell (1,0)
    });

    it('decimation step 2 keeps only step-aligned global cells', () => {
        const v = voxels([
            { gx: 0, gy: 0, gz: 0, colorIdx: 0, dy: 0 },
            { gx: 1, gy: 0, gz: 0, colorIdx: 0, dy: 0 }, // dropped (gx odd)
            { gx: 2, gy: 0, gz: 0, colorIdx: 0, dy: 0 },
        ]);
        const f = buildSurfaceField(world([chunk(0, 0, 0, v)]), 2);
        expect(cellTopY(f, 0, 0)).not.toBeNull();
        expect(cellTopY(f, 1, 0)).toBeNull();
        expect(cellTopY(f, 2, 0)).not.toBeNull();
    });

    it('empty chunk and mixed displaced/non-displaced: only displaced voxels land in cellMap', () => {
        // Empty chunk: count 0, loop body never executes.
        const emptyField = buildSurfaceField(world([chunk(0, 0, 0, voxels([]))]), 1);
        expect(emptyField.count).toBe(0);
        expect(cornerHeightAt(emptyField, 0, 0)).toBeNull();

        // Mixed chunk: two voxels, only the first has flags=2 (displaced).
        const n = 2;
        const gx = new Uint16Array([1, 2]);
        const gy = new Uint16Array([0, 0]);
        const gz = new Uint16Array([0, 0]);
        const sizeLevel = new Uint8Array(n);
        const colorIdx = new Uint16Array([5, 6]);
        const flags = new Uint8Array([2, 0]); // second voxel: not displaced
        const disp = new Int8Array(n * 3);
        disp[0 * 3 + 1] = 0; // Y displacement for voxel 0
        const mixedVoxels: import('engine/vxlscene/VxlSceneFormat.js').DecodedChunkVoxels =
            { count: n, gx, gy, gz, sizeLevel, colorIdx, flags, disp };
        const mixedField = buildSurfaceField(world([chunk(0, 0, 0, mixedVoxels)]), 1);
        expect(mixedField.count).toBe(1);
        expect(cellTopY(mixedField, 1, 0)).not.toBeNull();
        expect(cellTopY(mixedField, 2, 0)).toBeNull();
    });

    it('negative chunk coordinates land at the correct global cell and respect step decimation', () => {
        // cx=-1, cz=-1, cells=4 (chunkSize 4, minVoxelSize 1).
        // Local (gx:3, gz:3) → global (-1*4+3, -1*4+3) = (-1,-1).
        // Local (gx:2, gz:2) → global (-4+2, -4+2)     = (-2,-2).
        const v = voxels([
            { gx: 3, gy: 0, gz: 3, colorIdx: 1, dy: 0 }, // global (-1,-1)
            { gx: 2, gy: 0, gz: 2, colorIdx: 2, dy: 0 }, // global (-2,-2)
        ]);
        // step=1: both cells present.
        const f1 = buildSurfaceField(world([chunk(-1, 0, -1, v)]), 1);
        expect(cellTopY(f1, -1, -1)).not.toBeNull();
        expect(cellTopY(f1, -2, -2)).not.toBeNull();

        // step=2: mod(-1,2) = 1 → dropped; mod(-2,2) = 0 → kept.
        const f2 = buildSurfaceField(world([chunk(-1, 0, -1, v)]), 2);
        expect(cellTopY(f2, -1, -1)).toBeNull();
        expect(cellTopY(f2, -2, -2)).not.toBeNull();
    });
});

/** A flat paletteUV table: cell c → uv (c, c) so we can read color back off a vertex. */
/**
 * Identity-ish palette: cell `i` maps to `(i/n, i/n)`, so a vertex's UV still names the
 * cell it came from while staying in the real 0..1 range the builder's unorm16 packing
 * assumes. (Raw cell indices would overflow the packed attribute.)
 */
function idPaletteUV(n = 4096): Float32Array {
    const out = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { out[i * 2] = i / n; out[i * 2 + 1] = i / n; }
    return out;
}

/** The unorm16 quantization `buildChunkSurfaceGeometry` applies to every UV. */
function packUv(v: number): number {
    return Math.round(v * 65535);
}

/** The packed UV pair a vertex coloured by `cell` must carry. */
function uvOfCell(cell: number, n = 4096): [number, number] {
    return [packUv(cell / n), packUv(cell / n)];
}

describe('buildChunkSurfaceGeometry', () => {
    const pal = idPaletteUV();

    it('a single flat cell → 4 welded verts, 6 indices, +Y normals, world positions', () => {
        const v = voxels([{ gx: 0, gy: 0, gz: 0, colorIdx: 5, dy: 0 }]); // top = 0.5
        const w = world([chunk(0, 0, 0, v)]);
        const f = buildSurfaceField(w, 1);
        const g = buildChunkSurfaceGeometry(f, w.chunks[0]!, pal)!;
        expect(g.vertCount).toBe(4);
        expect(g.indexCount).toBe(6);
        // every vertex at y = 0.5 (the cell centre), normal straight up, uv = (5,5)
        for (let i = 0; i < 4; i++) {
            expect(g.positions[i * 3 + 1]).toBeCloseTo(0.5, 6);
            expect([g.normals[i * 3], g.normals[i * 3 + 1], g.normals[i * 3 + 2]]).toEqual([0, 1, 0]);
            expect([g.uvs[i * 2], g.uvs[i * 2 + 1]]).toEqual(uvOfCell(5));
        }
    });

    it('two same-color adjacent cells share the seam corners (welded, fewer than 8 verts)', () => {
        const v = voxels([
            { gx: 0, gy: 0, gz: 0, colorIdx: 1, dy: 0 },
            { gx: 1, gy: 0, gz: 0, colorIdx: 1, dy: 0 },
        ]);
        const w = world([chunk(0, 0, 0, v)]);
        const f = buildSurfaceField(w, 1);
        const g = buildChunkSurfaceGeometry(f, w.chunks[0]!, pal)!;
        expect(g.vertCount).toBe(6); // 2 quads, shared seam edge → 6 not 8 verts
        expect(g.indexCount).toBe(12);
    });

    it('two DIFFERENT-color adjacent cells split the seam (no welding across colors)', () => {
        const v = voxels([
            { gx: 0, gy: 0, gz: 0, colorIdx: 1, dy: 0 },
            { gx: 1, gy: 0, gz: 0, colorIdx: 2, dy: 0 },
        ]);
        const w = world([chunk(0, 0, 0, v)]);
        const f = buildSurfaceField(w, 1);
        const g = buildChunkSurfaceGeometry(f, w.chunks[0]!, pal)!;
        expect(g.vertCount).toBe(8); // seam corners duplicated (different uv) → 8 verts
    });

    it('a colour split duplicates the seam vertex but NOT its normal (no shading seam)', () => {
        // Colour boundary on a SLOPE, so the shared normal is non-trivial and a
        // mismatch would actually show. Welding is per-(corner, colour), so the
        // seam corners exist twice — but position and normal both come from the
        // GLOBAL field and ignore colour, so the two copies must be identical.
        // If they ever diverge, the road creases along every paint boundary.
        const v = voxels([
            { gx: 0, gy: 0, gz: 0, colorIdx: 1, dy: 0 }, // top 0.5
            { gx: 1, gy: 2, gz: 0, colorIdx: 2, dy: 0 }, // top 2.5 — different colour AND height
        ]);
        const w = world([chunk(0, 0, 0, v)]);
        const f = buildSurfaceField(w, 1);
        const g = buildChunkSurfaceGeometry(f, w.chunks[0]!, pal)!;
        // Both copies of the seam corner sit at world X=1; collect their normals.
        const seam: number[][] = [];
        for (let i = 0; i < g.vertCount; i++) {
            if (Math.abs(g.positions[i * 3]! - 1) < 1e-9 && Math.abs(g.positions[i * 3 + 2]!) < 1e-9) {
                seam.push([g.positions[i * 3 + 1]!, g.normals[i * 3]!, g.normals[i * 3 + 1]!, g.normals[i * 3 + 2]!]);
            }
        }
        expect(seam).toHaveLength(2);        // duplicated by the colour split
        expect(seam[0]![1]).toBeLessThan(0); // and actually sloped (nx < 0), not a vacuous pass
        expect(seam[0]).toEqual(seam[1]);    // identical height AND normal
    });

    it('cross-chunk seam: boundary corner heights match on both chunks (crack-free)', () => {
        // chunkSize 4, minVoxel 1 → 4 cells/chunk. Cell at end of chunk0 (gx=3) and start of
        // chunk1 (gx=0) are global cells 3 and 4, sharing the corner at global X=4.
        const v0 = voxels([{ gx: 3, gy: 1, gz: 0, colorIdx: 0, dy: 0 }]); // top 2, global cell (3,0)
        const v1 = voxels([{ gx: 0, gy: 3, gz: 0, colorIdx: 0, dy: 0 }]); // top 4, global cell (4,0)
        const w = world([chunk(0, 0, 0, v0), chunk(1, 0, 0, v1)]);
        const f = buildSurfaceField(w, 1);
        const g0 = buildChunkSurfaceGeometry(f, w.chunks[0]!, pal)!;
        const g1 = buildChunkSurfaceGeometry(f, w.chunks[1]!, pal)!;
        // The shared corner is world X=4. Chunks are meshed independently (one
        // geometry each), so it exists once per chunk — height AND normal must
        // match, or the road both cracks and creases along every chunk boundary.
        const atX4 = (g: { positions: Float32Array; normals: Float32Array }): number[] => {
            for (let i = 0; i < g.positions.length; i += 3) {
                if (Math.abs(g.positions[i]! - 4) < 1e-9) {
                    return [g.positions[i + 1]!, g.normals[i]!, g.normals[i + 1]!, g.normals[i + 2]!];
                }
            }
            return [NaN];
        };
        const c0 = atX4(g0), c1 = atX4(g1);
        expect(c0[0]).toBeCloseTo(2.5, 6); // (1.5 + 3.5) / 2 averaged from the global field
        expect(c0[1]).toBeLessThan(0);     // sloped (nx < 0) — not a vacuous comparison
        expect(c1).toEqual(c0);            // identical on both sides → no crack, no crease
    });

    it('returns null for a chunk with no displaced voxels', () => {
        const empty = voxels([]);
        const w = world([chunk(0, 0, 0, empty)]);
        const f = buildSurfaceField(w, 1);
        expect(buildChunkSurfaceGeometry(f, w.chunks[0]!, pal)).toBeNull();
    });

    it('a multi-cell column (solid shell: top+bottom+walls) collapses to its topmost cell', () => {
        // Three displaced cells in the SAME (x,z) column at gy 9/4/0 (tops 9.5/4.5/0.5), in an order
        // where a naive last-wins would pick the BOTTOM. Real road bakes emit such shells
        // (top + underside + wall cells share a column); the surface is the topmost only.
        const v = voxels([
            { gx: 0, gy: 9, gz: 0, colorIdx: 3, dy: 0 }, // top = 9.5 (the drivable surface)
            { gx: 0, gy: 4, gz: 0, colorIdx: 2, dy: 0 }, // top = 4.5
            { gx: 0, gy: 0, gz: 0, colorIdx: 1, dy: 0 }, // top = 0.5 (a naive last-wins would pick this)
        ]);
        const w = world([chunk(0, 0, 0, v)]);
        const f = buildSurfaceField(w, 1);
        // The field keeps the TOPMOST cell for the column, not the last-written one.
        expect(cellTopY(f, 0, 0)).toBe(9.5);
        expect(cellColorIdx(f, 0, 0)).toBe(3);
        const g = buildChunkSurfaceGeometry(f, w.chunks[0]!, pal)!;
        // ONE quad for the column (not one per shell cell), at the topmost height.
        expect(g.vertCount).toBe(4);
        expect(g.indexCount).toBe(6);
        for (let i = 0; i < 4; i++) expect(g.positions[i * 3 + 1]).toBeCloseTo(9.5, 6);
        expect([g.uvs[0], g.uvs[1]]).toEqual(uvOfCell(3)); // uses the topmost cell's color
    });

    it('sloped surface: shared seam corner at X=1 has nx<0 and ny>0 (normal leans back up-slope)', () => {
        // Cell (0,0) topY=0.5 (gy=0, dy=0), cell (1,0) topY=1.5 (gy=1, dy=0) — slope rising along +X.
        // Corner (1,0) is shared: cornerH = (0.5+1.5)/2 = 1; hxp=cornerH(2,0)=1.5, hxm=cornerH(0,0)=0.5.
        // nx = -(1.5-0.5)/(2*1*1) = -0.5 → negative. ny = 1/hypot(-0.5,1,0) > 0. Normal is unit length.
        const v = voxels([
            { gx: 0, gy: 0, gz: 0, colorIdx: 0, dy: 0 }, // topY = 0.5
            { gx: 1, gy: 1, gz: 0, colorIdx: 0, dy: 0 }, // topY = 1.5
        ]);
        const w = world([chunk(0, 0, 0, v)]);
        const f = buildSurfaceField(w, 1);
        const g = buildChunkSurfaceGeometry(f, w.chunks[0]!, pal)!;

        // Find the vertex at world X=1 (the seam corner shared by both cells).
        let nx = NaN, ny = NaN, nz = NaN;
        for (let i = 0; i < g.vertCount; i++) {
            if (Math.abs(g.positions[i * 3]! - 1) < 1e-9 && Math.abs(g.positions[i * 3 + 2]!) < 1e-9) {
                nx = g.normals[i * 3]!;
                ny = g.normals[i * 3 + 1]!;
                nz = g.normals[i * 3 + 2]!;
                break;
            }
        }
        expect(nx).not.toBeNaN();
        expect(nx).toBeLessThan(0);      // normal leans back against up-slope direction (+X)
        expect(ny).toBeGreaterThan(0);   // still has upward component
        expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 6); // unit length
    });

    it('decimation step=2: each kept cell produces one quad spanning 2*s world units', () => {
        // Three cells at gx=0,1,2 (gz=0). With step=2: gx=0 (mod 0 → kept), gx=1 (dropped), gx=2 (kept).
        // chunkSize=4, minVoxelSize=1 → s=1. Each kept quad spans N=2 in X.
        const v = voxels([
            { gx: 0, gy: 0, gz: 0, colorIdx: 3, dy: 0 },
            { gx: 1, gy: 0, gz: 0, colorIdx: 3, dy: 0 }, // dropped by decimation
            { gx: 2, gy: 0, gz: 0, colorIdx: 3, dy: 0 },
        ]);
        const w = world([chunk(0, 0, 0, v)]);
        const f = buildSurfaceField(w, 2);

        // Only 2 cells kept (gx=0 and gx=2); field.count should be 2.
        expect(f.count).toBe(2);

        const g = buildChunkSurfaceGeometry(f, w.chunks[0]!, pal)!;
        // 2 kept cells → 2 quads → indexCount = 12.
        expect(g.indexCount).toBe(12);

        // Collect unique X positions from the geometry — the two quads share no corners
        // (different origin X: 0 and 2, each spanning to X=2 and X=4 respectively, overlap at X=2).
        // Same color, so corner at X=2 is welded between the two quads.
        // Unique X values: 0, 2, 4.
        const xVals = new Set<number>();
        for (let i = 0; i < g.vertCount; i++) xVals.add(Math.round(g.positions[i * 3]! * 1e6) / 1e6);
        // Each quad's corners differ by N*s = 2*1 = 2 in X.
        const xArr = [...xVals].sort((a, b) => a - b);
        expect(xArr[1]! - xArr[0]!).toBeCloseTo(2, 6); // step between consecutive unique X corners
    });
});

describe('buildSurfaceField sparse storage', () => {
    /**
     * A diagonal ribbon across a wide box — the shape a race track actually makes, and the
     * reason the field is tiled: the bounding box is large, the occupied fraction is small.
     */
    function ribbonWorld(len: number): ReturnType<typeof world> {
        const entries: Array<{ gx: number; gy: number; gz: number; colorIdx: number; dy: number }> = [];
        for (let i = 0; i < len; i++) {
            entries.push({ gx: i, gy: 0, gz: i, colorIdx: 1, dy: 0 });
        }
        return world([chunk(0, 0, 0, voxels(entries))]);
    }

    it('allocates only the tiles a column falls in, not the whole bounding box', () => {
        const f = buildSurfaceField(ribbonWorld(64), 1);
        const allocated = f.tileTopY.filter(t => t !== null).length;
        expect(f.tw * f.th).toBeGreaterThan(allocated);   // the box is bigger than what is stored
        expect(allocated).toBeGreaterThan(0);
        // A diagonal touches one tile per 16x16 step along it, never the off-diagonal ones.
        expect(allocated).toBe(Math.ceil(64 / 16));
    });

    it('reads back every filled column and nothing else', () => {
        const f = buildSurfaceField(ribbonWorld(40), 1);
        expect(f.count).toBe(40);
        for (let i = 0; i < 40; i++) {
            expect(cellTopY(f, i, i)).toBeCloseTo(0.5, 6);
            expect(cellColorIdx(f, i, i)).toBe(1);
        }
        // Off the ribbon: inside the bounding box, inside an ALLOCATED tile, still empty.
        expect(cellTopY(f, 0, 1)).toBeNull();
        expect(cellColorIdx(f, 0, 1)).toBeNull();
        // Off the ribbon in a tile that was never allocated at all.
        expect(cellTopY(f, 0, 39)).toBeNull();
        expect(cellColorIdx(f, 39, 0)).toBeNull();
    });

    it('is empty-safe: no tiles, no bounding box, no reads that throw', () => {
        const f = buildSurfaceField(world([chunk(0, 0, 0, voxels([]))]), 1);
        expect([f.sx, f.sz, f.tw, f.th, f.count]).toEqual([0, 0, 0, 0, 0]);
        expect(f.tileTopY).toEqual([]);
        expect(cellTopY(f, 0, 0)).toBeNull();
        expect(cornerHeightAt(f, 0, 0)).toBeNull();
    });
});
