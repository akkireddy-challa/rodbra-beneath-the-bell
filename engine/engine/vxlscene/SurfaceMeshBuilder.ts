/**
 * Surface heightfield extractor — first stage of the smooth-surface render system
 * (design 2026-06-16-smooth-surface-render-design.md).
 *
 * Walks every chunk's displaced-voxel columns and extracts a Y-heightfield: per kept
 * (gX,gZ) column the drivable-top world Y and atlas colour. Downstream per-chunk geometry
 * builders consume this field to produce crack-free welded meshes across chunk boundaries.
 *
 * MEMORY: the field is stored as DENSE TYPED ARRAYS (`Float32Array topY` + `Uint16Array
 * colorIdx`) over the bounding box of the kept cells, indexed by a packed numeric offset —
 * NOT string-keyed Maps. Welded corner heights are computed ON THE FLY from `topY` rather
 * than materialised into a second Map. A 990 m piste at 0.125 m is ~3.5 M columns: the old
 * `Map<string,{...}>` cellMap + cornerH cost ~0.6-1.0 GB resident; the dense arrays cost
 * ~6 bytes/column (~57 MB here) with O(1) array lookups and zero key-string churn.
 *
 * Pure: no THREE, no engine state. Coordinates are GLOBAL min-cell indices; positions are
 * world-space (cellIndex * minVoxelSize), matching the renderer's world-space geometry.
 */

import type { DecodedVxlSceneWorld, DecodedChunk } from 'engine/vxlscene/VxlSceneFormat.js';

/**
 * Dense Y-heightfield extracted once per world (decimated by `step`).
 *
 * Cells are stored over the [gx0, gx0 + sx*step) x [gz0, gz0 + sz*step) bounding box of the
 * kept (step-aligned) displaced columns. `topY[idx]` is `NaN` where no column exists; a valid
 * column's colour is `colorIdx[idx]`. `idx = ((gX - gx0)/step) * sz + ((gZ - gz0)/step)`.
 */
/**
 * Tile edge in STEP units. The field is stored as lazily-allocated tiles rather than one
 * dense rectangle because a smooth surface is a RIBBON through a square level, not a
 * plane: measured on two real racing levels the bounding box is only ~11% occupied, so a
 * dense array spends ~89% of itself on NaN.
 *
 * 16 measured best of 8/16/32/64 on those levels — the same footprint as 8 (9.0 vs 8.9 MB)
 * with a quarter of the tiles and pointer grid, and 86% fill inside an allocated tile.
 * Larger tiles waste interior; smaller ones spend it back on the pointer grid.
 */
const FIELD_TILE = 16;

export interface SurfaceField {
    /** Min-cells per chunk axis = round(chunkSize / minVoxelSize). */
    cells: number;
    /** World-space min-cell edge length. */
    s: number;
    /** Decimation step in min-cells (>=1). A kept cell spans a step x step patch. */
    step: number;
    /** Number of kept (filled) columns — diagnostic. */
    count: number;
    /** Bounding-box min global cell index (multiple of `step`). 0 when empty. */
    gx0: number;
    gz0: number;
    /** Bounding-box size in step units. 0 when empty. */
    sx: number;
    sz: number;
    /** Tile-grid dimensions covering `sx * sz` (`ceil(sx/FIELD_TILE)` etc). */
    tw: number;
    th: number;
    /**
     * Drivable-top world Y, one `FIELD_TILE^2` tile per occupied region, `NaN` where absent.
     * `null` for a tile no column falls in — the common case, and the whole point.
     * Tile index is `tx * th + tz`; within a tile, `(ix % FIELD_TILE) * FIELD_TILE + (iz % FIELD_TILE)`.
     */
    tileTopY: (Float32Array | null)[];
    /** Atlas colour cell, parallel to `tileTopY`; valid only where that is not NaN. */
    tileColorIdx: (Uint16Array | null)[];
}

/** Positive modulo (JS `%` keeps the sign of the dividend). */
function mod(a: number, n: number): number {
    return ((a % n) + n) % n;
}

/**
 * Linear step-lattice index for a step-aligned global cell/corner (gX,gZ), or -1 if outside
 * the field's bounding box. Callers pass coords that are multiples of `step`, so the division
 * is exact.
 *
 * This is an IDENTITY for a cell, not a storage offset — the values live in tiles. It stays
 * because callers need a cheap unique key per column (`forEachChunkColumn`'s emitted set,
 * `vertKey`), and a linear index is a better Map/Set key than a pair.
 */
function idxOf(field: SurfaceField, gX: number, gZ: number): number {
    if (field.sx === 0) return -1;
    const N = field.step;
    const dx = gX - field.gx0;
    const dz = gZ - field.gz0;
    if (dx < 0 || dz < 0) return -1;
    if (dx % N !== 0 || dz % N !== 0) return -1; // not on the step lattice → no cell there
    const ix = dx / N;
    const iz = dz / N;
    if (ix >= field.sx || iz >= field.sz) return -1;
    return ix * field.sz + iz;
}

/**
 * Tile slot for a step-aligned global cell: `tile * FIELD_TILE^2 + slot` packed into one
 * number so the hot lookups below need neither an object nor two calls. -1 when the cell is
 * outside the field or its tile was never allocated. Kept branch-light: this runs several
 * times per surface vertex.
 */
function slotOf(field: SurfaceField, gX: number, gZ: number): number {
    if (field.sx === 0) return -1;
    const N = field.step;
    const dx = gX - field.gx0;
    const dz = gZ - field.gz0;
    if (dx < 0 || dz < 0) return -1;
    if (dx % N !== 0 || dz % N !== 0) return -1;
    const ix = dx / N;
    const iz = dz / N;
    if (ix >= field.sx || iz >= field.sz) return -1;
    const tile = ((ix / FIELD_TILE) | 0) * field.th + ((iz / FIELD_TILE) | 0);
    return tile * (FIELD_TILE * FIELD_TILE)
        + (ix % FIELD_TILE) * FIELD_TILE + (iz % FIELD_TILE);
}

/** Raw drivable-top Y at a step-aligned global cell, or NaN if no column there. */
function topYRaw(field: SurfaceField, gX: number, gZ: number): number {
    const packed = slotOf(field, gX, gZ);
    if (packed < 0) return NaN;
    const tile = field.tileTopY[(packed / (FIELD_TILE * FIELD_TILE)) | 0];
    return tile === null || tile === undefined ? NaN : tile[packed % (FIELD_TILE * FIELD_TILE)]!;
}

/**
 * Welded corner height at global corner (X,Z) = average drivable-top of the up-to-4 incident
 * cells. Returns NaN when no incident cell exists (callers fall back to the current corner
 * height, matching the original `cornerH.get(...) ?? h` semantics). Unrolled — no per-call
 * allocation (this runs per vertex).
 */
function cornerHeightRaw(field: SurfaceField, X: number, Z: number): number {
    const N = field.step;
    let sum = 0, cnt = 0;
    let t = topYRaw(field, X, Z);     if (!Number.isNaN(t)) { sum += t; cnt++; }
    t = topYRaw(field, X - N, Z);     if (!Number.isNaN(t)) { sum += t; cnt++; }
    t = topYRaw(field, X, Z - N);     if (!Number.isNaN(t)) { sum += t; cnt++; }
    t = topYRaw(field, X - N, Z - N); if (!Number.isNaN(t)) { sum += t; cnt++; }
    return cnt > 0 ? sum / cnt : NaN;
}

// ── Public accessors (used by tests and any external inspection) ───────────────────────────

/** Drivable-top world Y at a kept global cell, or null if no column exists there. */
export function cellTopY(field: SurfaceField, gX: number, gZ: number): number | null {
    const t = topYRaw(field, gX, gZ);
    return Number.isNaN(t) ? null : t;
}

/**
 * Atlas colour of a FILLED column, or -1 when the cell is outside the field, its tile was
 * never allocated, or nothing filled it. One lookup rather than a presence test plus a read,
 * because this is on the per-column path.
 */
function filledColorAt(field: SurfaceField, gX: number, gZ: number): number {
    const packed = slotOf(field, gX, gZ);
    if (packed < 0) return -1;
    const t = (packed / (FIELD_TILE * FIELD_TILE)) | 0;
    const slot = packed % (FIELD_TILE * FIELD_TILE);
    const tops = field.tileTopY[t];
    if (tops === null || tops === undefined || Number.isNaN(tops[slot]!)) return -1;
    return field.tileColorIdx[t]![slot]!;
}

/** Atlas colour cell at a kept global column, or null if no column exists there. */
export function cellColorIdx(field: SurfaceField, gX: number, gZ: number): number | null {
    const c = filledColorAt(field, gX, gZ);
    return c < 0 ? null : c;
}

/** Welded corner height at a global corner, or null when no incident cell exists. */
export function cornerHeightAt(field: SurfaceField, X: number, Z: number): number | null {
    const h = cornerHeightRaw(field, X, Z);
    return Number.isNaN(h) ? null : h;
}

/**
 * Visit each smooth-surface cell of a chunk with its global (gX,gZ) cell, drivable-top world Y,
 * and colour. Reads the v5 SURFACE TILE when present (one topmost cell per column), else falls
 * back to v4 DISPLACED VOXELS (the whole shell — caller resolves topmost). Both sources yield
 * identical (gX,gZ,topY,colorIdx) for the same baked surface, so the rendered mesh is unchanged.
 */
function eachChunkSurfaceCell(
    chunk: DecodedChunk, cells: number, chunkSize: number, s: number,
    cb: (gX: number, gZ: number, topY: number, colorIdx: number) => void,
): void {
    const baseGX = chunk.cx * cells, baseGZ = chunk.cz * cells;
    const baseY = chunk.cy * chunkSize;
    // heightQ = (gy + 0.5)·127 + dy is the chunk-relative quantized height;
    // topY = baseY + heightQ·(s/127).
    //
    // The +0.5 is the CELL CENTRE, and it must match `SurfaceRasterizer`, which
    // measures `dispOffset` as `(surfaceY - cellCentreY) / minVoxelSize`. Reading
    // it back against the cell TOP (`gy + 1`, as this did until 2026-08-06) floats
    // the whole rendered ride surface exactly half a min-voxel above the geometry
    // it was baked from — 6.25 cm at the world-forger's 0.125 m default, measured
    // in SurfaceFlatness.test.ts. That is also half a voxel above the trimesh
    // COLLIDER, which is baked from the source mesh and always sat at the true
    // height, so the car visibly drove sunk into its own road.
    //
    // BOTH sources use this identical expression so a v4 (displaced-voxel) and v5
    // (tile) bake of the same surface render bit-for-bit identically. (The format's
    // own `heightQ` keeps `gy + 1`: there it only RANKS columns, and a constant
    // shift cannot change an ordering.)
    const k = s / 127;
    const tile = chunk.surfaceTile;
    if (tile && tile.count > 0) {
        for (let i = 0; i < tile.count; i++) {
            const heightQ = (tile.gy[i]! + 0.5) * 127 + tile.dy[i]!;
            cb(baseGX + tile.localGx[i]!, baseGZ + tile.localGz[i]!, baseY + heightQ * k, tile.colorIdx[i]!);
        }
        // No early return: a v5 chunk keeps any NON-Y displaced voxels (smooth:x/z) in the voxel
        // columns; fall through so they still render as in v4. For a normal smooth:y chunk the voxel
        // columns are empty (or non-displaced), so the loop below is a no-op.
    }
    const v = chunk.voxels;
    if (!v.disp) return;
    for (let i = 0; i < v.count; i++) {
        if ((v.flags[i]! & 2) === 0) continue;
        const dy = v.disp[i * 3 + 1]!; // smooth:y surfaces displace along Y only
        const heightQ = (v.gy[i]! + 0.5) * 127 + dy;
        cb(baseGX + v.gx[i]!, baseGZ + v.gz[i]!, baseY + heightQ * k, v.colorIdx[i]!);
    }
}

/**
 * Build the surface field from every chunk's surface cells (v5 tile or v4 displaced voxels).
 * `step` (>=1) decimates: only cells whose GLOBAL indices are aligned to the step lattice are
 * kept, so the decimation phase is consistent across chunk boundaries (crack-free). Two passes:
 * (A) find the kept-cell bounding box, (B) fill, keeping the TOPMOST cell per column (a v4 road
 * shell stacks top/underside/wall cells in one column; the surface is the top).
 *
 * Storage is TILED (see `FIELD_TILE`) and allocated on first touch, so the ~89% of the
 * bounding box a ribbon never covers costs nothing. Measured on two real racing levels this
 * is 70.8 MB -> 9.0 MB and 92.4 MB -> 11.9 MB, and the field is live across the whole of
 * `VxlSceneRenderer.build()` — i.e. at the load's high-water mark, next to the batches.
 */
export function buildSurfaceField(world: DecodedVxlSceneWorld, step: number): SurfaceField {
    const s = world.minVoxelSize;
    const cells = Math.round(world.chunkSize / s);
    // The field's pitch can never be FINER than the container's own. A pre-decimated
    // variant stores columns `world.surfaceStep` cells apart; welding those at pitch 1
    // would look for neighbours that were never written and leave the surface full of
    // holes — a hole in a drivable ribbon is worse than any amount of blockiness. The
    // runtime budget may still ask for coarser, so this takes whichever is larger.
    const native = Math.max(1, Math.floor(world.surfaceStep ?? 1));
    const N = Math.max(native, Math.max(1, Math.floor(step)));

    // Pass A: bounding box over kept (step-aligned) surface cells.
    let minGX = Infinity, minGZ = Infinity, maxGX = -Infinity, maxGZ = -Infinity;
    for (const ch of world.chunks) {
        eachChunkSurfaceCell(ch, cells, world.chunkSize, s, (gX, gZ) => {
            if (N > 1 && (mod(gX, N) !== 0 || mod(gZ, N) !== 0)) return;
            if (gX < minGX) minGX = gX;
            if (gX > maxGX) maxGX = gX;
            if (gZ < minGZ) minGZ = gZ;
            if (gZ > maxGZ) maxGZ = gZ;
        });
    }
    if (minGX === Infinity) {
        return {
            cells, s, step: N, count: 0, gx0: 0, gz0: 0, sx: 0, sz: 0,
            tw: 0, th: 0, tileTopY: [], tileColorIdx: [],
        };
    }

    const sx = (maxGX - minGX) / N + 1;
    const sz = (maxGZ - minGZ) / N + 1;
    const tw = Math.ceil(sx / FIELD_TILE);
    const th = Math.ceil(sz / FIELD_TILE);
    const tileTopY: (Float32Array | null)[] = new Array<Float32Array | null>(tw * th).fill(null);
    const tileColorIdx: (Uint16Array | null)[] = new Array<Uint16Array | null>(tw * th).fill(null);
    let count = 0;

    // Pass B: fill, keeping the topmost cell per column. topY is float32 (the render output
    // precision — positions end up in a Float32Array anyway). Corner heights are therefore
    // averaged in float32 rather than double as the old Map did; the difference is <=1 float32
    // ULP (~5e-4 m at km altitude), below a voxel and below the tests' 1e-6 tolerance. It is
    // applied identically on both sides of every seam (same fixed summation order), so it is
    // crack-free. NaN marks an absent column (0 is a valid height).
    const TILE_CELLS = FIELD_TILE * FIELD_TILE;
    for (const ch of world.chunks) {
        eachChunkSurfaceCell(ch, cells, world.chunkSize, s, (gX, gZ, top, ci) => {
            if (N > 1 && (mod(gX, N) !== 0 || mod(gZ, N) !== 0)) return;
            const ix = (gX - minGX) / N;
            const iz = (gZ - minGZ) / N;
            const t = ((ix / FIELD_TILE) | 0) * th + ((iz / FIELD_TILE) | 0);
            let tops = tileTopY[t];
            if (tops === null || tops === undefined) {
                tops = new Float32Array(TILE_CELLS);
                tops.fill(NaN);
                tileTopY[t] = tops;
                tileColorIdx[t] = new Uint16Array(TILE_CELLS);
            }
            const slot = (ix % FIELD_TILE) * FIELD_TILE + (iz % FIELD_TILE);
            const cur = tops[slot]!;
            if (Number.isNaN(cur)) { tops[slot] = top; tileColorIdx[t]![slot] = ci; count++; }
            else if (top > cur) { tops[slot] = top; tileColorIdx[t]![slot] = ci; }
        });
    }

    return { cells, s, step: N, count, gx0: minGX, gz0: minGZ, sx, sz, tw, th, tileTopY, tileColorIdx };
}

/** Full-scale unorm16 value: a packed UV of 1.0 is stored as 65535. */
const UNORM16_MAX = 65535;

/** Per-chunk welded surface geometry as raw typed arrays (renderer wraps into THREE). */
export interface SurfaceGeometryData {
    positions: Float32Array;
    /**
     * PACKED unorm16 atlas UVs (attach with `normalized: true`), matching the greedy-quad
     * builder's `uv` layout — 8 → 4 bytes per vertex. Every UV here is a palette-cell
     * CENTRE, where the unorm16 step is a small fraction of a texel, so this is a memory
     * trade and not a quality one. On a 640 m racing level the surface is ~1.74M welded
     * columns, and the arrays are held twice on a phone (CPU copy until the post-warmup
     * release, plus the GPU copy in the same unified memory).
     *
     * Consumers that need the real 0..1 value must divide by 65535 — see
     * `deriveEmissiveFromUv`, which inverts these back to atlas cells.
     */
    uvs: Uint16Array;
    normals: Float32Array;
    indices: Uint32Array;
    vertCount: number;
    indexCount: number;
}

/** Analytic heightfield normal at global corner (X,Z): n = normalize(-dH/dx, 1, -dH/dz). */
function cornerNormal(field: SurfaceField, X: number, Z: number, h: number): [number, number, number] {
    const N = field.step, s = field.s;
    let hxp = cornerHeightRaw(field, X + N, Z); if (Number.isNaN(hxp)) hxp = h;
    let hxm = cornerHeightRaw(field, X - N, Z); if (Number.isNaN(hxm)) hxm = h;
    let hzp = cornerHeightRaw(field, X, Z + N); if (Number.isNaN(hzp)) hzp = h;
    let hzm = cornerHeightRaw(field, X, Z - N); if (Number.isNaN(hzm)) hzm = h;
    const span = 2 * N * s;
    const nx = -(hxp - hxm) / span;
    const nz = -(hzp - hzm) / span;
    const len = Math.hypot(nx, 1, nz) || 1;
    // `+ 0` normalises negative zero to 0 (a flat patch yields nx = -0); keep it.
    return [nx / len + 0, 1 / len, nz / len + 0];
}

/**
 * Visit each emitted surface column of a chunk exactly once, with its global min-corner (X,Z)
 * and the field's topmost colour. Reads the v5 tile or v4 displaced voxels via the shared
 * `eachChunkSurfaceCell`; the `emitted` set collapses a column to one visit (a v4 shell stacks
 * several cells per column; a v5 tile already has one). Shared by the measure and build passes
 * so their vertex counts are guaranteed identical.
 */
function forEachChunkColumn(
    field: SurfaceField,
    chunk: DecodedChunk,
    cb: (X: number, Z: number, colorIdx: number) => void,
): void {
    const N = field.step;
    const cells = field.cells;
    const chunkSize = cells * field.s;
    const emitted = new Set<number>(); // packed dense index, per chunk (small, transient)
    eachChunkSurfaceCell(chunk, cells, chunkSize, field.s, (X, Z) => {
        if (N > 1 && (mod(X, N) !== 0 || mod(Z, N) !== 0)) return;
        const key = idxOf(field, X, Z);
        if (key < 0) return;
        const ci = filledColorAt(field, X, Z);
        if (ci < 0) return;                                    // safety: only kept columns
        if (emitted.has(key)) return;                          // ONE quad per column
        emitted.add(key);
        cb(X, Z, ci);
    });
}

/** Packed per-(corner,colour) vertex key for welding (corners weld only within the same colour). */
function vertKey(field: SurfaceField, X: number, Z: number, colorIdx: number): number {
    // Corner lattice index in [0..sx] x [0..sz] (quad corners reach gx0+sx*step), strided by (sz+1).
    const cx = (X - field.gx0) / field.step;
    const cz = (Z - field.gz0) / field.step;
    return (cx * (field.sz + 1) + cz) * 4096 + colorIdx; // 4096 = ATLAS_CELL_COUNT
}

/** Exact welded vertex/index count for one chunk's surface, without building geometry. */
export function measureChunkSurface(field: SurfaceField, chunk: DecodedChunk): { vertCount: number; indexCount: number } {
    const N = field.step;
    const verts = new Set<number>();
    let quads = 0;
    forEachChunkColumn(field, chunk, (X, Z, ci) => {
        quads++;
        verts.add(vertKey(field, X, Z, ci));
        verts.add(vertKey(field, X, Z + N, ci));
        verts.add(vertKey(field, X + N, Z + N, ci));
        verts.add(vertKey(field, X + N, Z, ci));
    });
    return { vertCount: verts.size, indexCount: quads * 6 };
}

/**
 * Exact welded counts for one chunk's surface, split by MATERIAL CLASS index — the
 * measure pass for a v9 world whose renderer draws one surface batch per class.
 * `classByCell` is the decoded 4096-entry cell→classIdx LUT (0 = matte). A column's
 * class is a function of its colour, and vertices weld only within one colour
 * (`vertKey`), so partitioning by class never splits a welded vertex: the per-class
 * counts sum exactly to `measureChunkSurface`'s.
 */
export function measureChunkSurfaceByClass(
    field: SurfaceField,
    chunk: DecodedChunk,
    classByCell: Uint8Array,
): Map<number, { vertCount: number; indexCount: number }> {
    const N = field.step;
    const vertsByClass = new Map<number, Set<number>>();
    const quadsByClass = new Map<number, number>();
    forEachChunkColumn(field, chunk, (X, Z, ci) => {
        const classIdx = classByCell[ci] ?? 0;
        let verts = vertsByClass.get(classIdx);
        if (!verts) {
            verts = new Set<number>();
            vertsByClass.set(classIdx, verts);
        }
        quadsByClass.set(classIdx, (quadsByClass.get(classIdx) ?? 0) + 1);
        verts.add(vertKey(field, X, Z, ci));
        verts.add(vertKey(field, X, Z + N, ci));
        verts.add(vertKey(field, X + N, Z + N, ci));
        verts.add(vertKey(field, X + N, Z, ci));
    });
    const out = new Map<number, { vertCount: number; indexCount: number }>();
    for (const [classIdx, verts] of vertsByClass) {
        out.set(classIdx, { vertCount: verts.size, indexCount: quadsByClass.get(classIdx)! * 6 });
    }
    return out;
}

/**
 * Build the welded surface geometry for one chunk. Each kept displaced cell becomes one upward
 * quad (2 triangles). Corner vertices are shared among same-colour incident cells (smooth +
 * crisp colour boundaries); heights and normals come from the GLOBAL field, so chunk seams are
 * crack-free and smoothly shaded. Returns null if the chunk has no surface.
 *
 * `counts` (the result of `measureChunkSurface`) lets the caller pre-size the typed output
 * arrays exactly and avoid `number[]` push-and-convert churn; omit it and they are measured here.
 */
export function buildChunkSurfaceGeometry(
    field: SurfaceField,
    chunk: DecodedChunk,
    paletteUV: Float32Array,
    counts?: { vertCount: number; indexCount: number },
): SurfaceGeometryData | null {
    return buildFilteredSurfaceGeometry(field, chunk, paletteUV, counts ?? measureChunkSurface(field, chunk), null);
}

/**
 * One class's share of a chunk's welded surface — the geometry for one per-class
 * surface batch. `counts` MUST be that class's entry from `measureChunkSurfaceByClass`
 * (the arrays are pre-sized exactly from it). Columns of every other class are simply
 * skipped; welding is unaffected because vertices only ever weld within one colour.
 */
export function buildChunkSurfaceGeometryForClass(
    field: SurfaceField,
    chunk: DecodedChunk,
    paletteUV: Float32Array,
    classByCell: Uint8Array,
    classIdx: number,
    counts: { vertCount: number; indexCount: number },
): SurfaceGeometryData | null {
    return buildFilteredSurfaceGeometry(
        field, chunk, paletteUV, counts,
        (colorIdx) => (classByCell[colorIdx] ?? 0) === classIdx,
    );
}

function buildFilteredSurfaceGeometry(
    field: SurfaceField,
    chunk: DecodedChunk,
    paletteUV: Float32Array,
    c: { vertCount: number; indexCount: number },
    keepColumn: ((colorIdx: number) => boolean) | null,
): SurfaceGeometryData | null {
    if (c.vertCount === 0) return null;

    const N = field.step, s = field.s;
    const positions = new Float32Array(c.vertCount * 3);
    const uvs = new Uint16Array(c.vertCount * 2);
    const normals = new Float32Array(c.vertCount * 3);
    const indices = new Uint32Array(c.indexCount);
    const vertMap = new Map<number, number>();
    let vCursor = 0, iCursor = 0;

    const vertFor = (X: number, Z: number, colorIdx: number): number => {
        const vk = vertKey(field, X, Z, colorIdx);
        const existing = vertMap.get(vk);
        if (existing !== undefined) return existing;
        const id = vCursor++;
        const hRaw = cornerHeightRaw(field, X, Z);
        const h = Number.isNaN(hRaw) ? 0 : hRaw;
        positions[id * 3] = X * s; positions[id * 3 + 1] = h; positions[id * 3 + 2] = Z * s;
        const n = cornerNormal(field, X, Z, h);
        normals[id * 3] = n[0]; normals[id * 3 + 1] = n[1]; normals[id * 3 + 2] = n[2];
        // Quantize once per vertex to the unorm16 grid (see SurfaceGeometryData.uvs).
        const ci = colorIdx * 2;
        uvs[id * 2] = Math.round(paletteUV[ci]! * UNORM16_MAX);
        uvs[id * 2 + 1] = Math.round(paletteUV[ci + 1]! * UNORM16_MAX);
        vertMap.set(vk, id);
        return id;
    };

    forEachChunkColumn(field, chunk, (X, Z, colorIdx) => {
        if (keepColumn && !keepColumn(colorIdx)) return;
        // Upward face, CCW from above (matches the engine's +Y cube-face winding).
        const a = vertFor(X, Z, colorIdx);
        const b = vertFor(X, Z + N, colorIdx);
        const cc = vertFor(X + N, Z + N, colorIdx);
        const d = vertFor(X + N, Z, colorIdx);
        indices[iCursor++] = a; indices[iCursor++] = b; indices[iCursor++] = cc;
        indices[iCursor++] = a; indices[iCursor++] = cc; indices[iCursor++] = d;
    });

    return { positions, uvs, normals, indices, vertCount: c.vertCount, indexCount: c.indexCount };
}
