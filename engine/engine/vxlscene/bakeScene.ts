/**
 * Pure scene baker (design §3.4–§3.10, §7).
 *
 * Composes the already-built vxlscene kernels into a VxlSceneWorld with NO GLB
 * parsing and NO I/O: it takes world-space triangles plus bake options and,
 * for each chunk, runs rasterize → interior-fill → compact → greedy-mesh (LOD0)
 * → coarser LODs (grid downsample) → trimesh clip, then assembles the world.
 *
 * The GLB entry point (next phase) calls this after triangle extraction; this
 * function is fully unit-testable with synthetic triangles.
 *
 * Pipeline coordinate convention: all grids use GLOBAL min-cell coords
 * (cell center `(gx+0.5)*minVoxelSize` is WORLD space). Per-chunk outputs are
 * converted to chunk-local only when emitting into the VxlSceneChunk.
 *
 * Smooth-axis sub-cell displacement (design §3.8, §6.3) flows through: displaced
 * cells stay size-0 in `compact` and carry a `disp` vector; `greedyMesh` excludes
 * them so LOD0 quads skip displaced cells (they render as a welded heightfield surface
 * mesh via `SurfaceMeshBuilder`). Coarser LODs downsample grid-aligned (displacement dropped).
 *
 * LOD-pin (design §6.2): cells whose owning object is `pinned` keep their FINEST
 * detail at every LOD. When building each coarse LOD the grid is partitioned —
 * only non-pinned cells are downsampled, while pinned cells are greedy-meshed at
 * min-cell resolution and merged into every coarse LOD's hint. Combined with the
 * min-cell coordinate unification (design §7), fine pinned geometry and coarse
 * bulk share one scale and render in ONE mesh per LOD.
 *
 * A ONE-CELL-THICK surface — painted road lines, a grass median, a lot's parking
 * stripes — MUST be pinned, whatever its distance from the camera. `downsampleGrid`
 * fills a parent cell whenever ANY child is occupied, so three folds inflate a 2 cm
 * decal into a solid 1 m cube; and on mobile the coarsest level is not "far away"
 * at all, because the load budget sheds the fine levels and renders that level right
 * under the camera. Pinning is what keeps a decal a decal there.
 */

import type { RasterTriangle, RasterCtx } from 'engine/vxlscene/SurfaceRasterizer.js';
import { rasterizeChunk, packCell, unpackCell } from 'engine/vxlscene/SurfaceRasterizer.js';
import type { GlobalInteriorField } from 'engine/vxlscene/GlobalInteriorField.js';
import { buildGlobalInterior, fillInteriorFromField } from 'engine/vxlscene/GlobalInteriorField.js';
import { compact } from 'engine/vxlscene/VoxelCompactor.js';
import { greedyMesh } from 'engine/vxlscene/GreedyMesher.js';
import { clipTrimeshToChunk } from 'engine/vxlscene/ColliderBaker.js';
import { validateObjectControls } from 'engine/vxlscene/SceneVoxTypes.js';
import type { CellAttr, ObjectControls, RGB, SceneVoxel, SceneQuad } from 'engine/vxlscene/SceneVoxTypes.js';
import type { NamedTrimesh, VxlSceneWorld, VxlSceneChunk, VxlSceneTotals } from 'engine/vxlscene/VxlSceneFormat.js';
import type { PathCullMask, PathCullBoxClass } from 'engine/vxlscene/PathCull.js';

export interface BakeOptions {
    chunkSize: number;
    /** chunkSize / minVoxelSize must be a power-of-two integer. */
    minVoxelSize: number;
    maxVoxelSize: number;
    /** Count of coarser LODs (each 2x coarser); 0 = LOD0 only. */
    additionalLods: number;
    /** Activation distances; length should be additionalLods+1. */
    lodDistances: number[];
    fillInterior: boolean;
    /**
     * Optional resolution of the global interior flood field. Default
     * `max(maxVoxelSize*2, chunkSize/16)` suits level-scale structures; the
     * ASSET bake passes a finer value because a single prop's interior can be
     * smaller than one default field cell (no interior found → no merging).
     */
    interiorFieldCellSize?: number;
    controlsByNode: Record<string, ObjectControls>;
    /** Optional explicit world bounds; if omitted, computed from triangles and snapped to chunk grid. */
    bounds?: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
    /**
     * Optional horizontal keep-region around the level's designed path (see
     * `PathCull.ts`). Cells and interior voxels whose world XZ centre falls
     * outside it are dropped, and chunk columns entirely outside it are skipped
     * before any rasterization — which is where most of the saving comes from.
     * World BOUNDS are unaffected: the level keeps its footprint and its
     * coordinates, it just has holes where the scenery used to be. Omitted =
     * no cull (byte-identical to a bake without this option).
     */
    pathCull?: PathCullMask;
    /** Fired once per grid chunk (including empty ones) as the bake progresses. */
    onProgress?: (info: { chunkIndex: number; totalChunks: number; nonEmptyChunks: number; label: string }) => void;
    /**
     * Optional streaming sink (memory-bounded bake). When provided, each NON-EMPTY
     * chunk is handed to this callback the moment it is built and is then DROPPED —
     * it is NOT retained in the returned world's `chunks` array. Peak heap stays
     * bounded to a single chunk's objects (plus whatever the sink keeps), instead of
     * accumulating every chunk's voxels + quads for the whole world. The returned
     * world therefore has `chunks: []`; its per-bake totals live on
     * `VxlSceneWorld.totals`. The entry point streams each chunk straight into the
     * incremental encoder so the full object graph never coexists in memory.
     *
     * When absent the bake behaves exactly as before (accumulates `chunks`).
     */
    onChunkBaked?: (chunk: VxlSceneChunk) => Promise<void> | void;
    /**
     * Optional per-chunk profiling hook (instrumentation only; zero cost when
     * undefined). Fired once for every NON-EMPTY chunk with phase timings and
     * cell/voxel/quad counts. `surfaceCells` is grid.size right after rasterize;
     * `interiorCells` is now the count of LARGE interior VOXELS emitted by
     * fillInterior (the interior is no longer materialized as min-cells); `voxels`
     * is the total compacted+interior voxel count; `quads` is the LOD0 greedy-mesh
     * quad count. Each `*Ms` is the wall-clock time of that phase via `performance.now()`.
     */
    profile?: {
        onChunk: (info: {
            index: number;
            totalChunks: number;
            cx: number; cy: number; cz: number;
            surfaceCells: number;
            interiorCells: number;
            voxels: number;
            quads: number;
            rasterizeMs: number;
            fillMs: number;
            compactMs: number;
            meshMs: number;
            clipMs: number;
            /**
             * The chunk's FINEST per-axis cell count (= worldCellsPerAxis / 2^minOffset,
             * minOffset = the finest overlapping object's lodOffset). A chunk now mixes
             * per-object resolutions, so this is the finest one present; surfaceCells /
             * voxels / quads are summed across all of the chunk's per-object groups. Lets
             * harnesses tally the resolution distribution. The interior fast-path emits no
             * onChunk.
             */
            chunkCellsPerAxis: number;
            /** The chunk's finest (min) overlapping-object lodOffset. */
            lodOffset: number;
        }) => void;
    };
}

/** World-space axis-aligned box — world bounds, chunk bounds and triangle AABBs alike. */
interface AABB {
    minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number;
}

interface ChunkBin {
    triIndices: number[];
}

function triAABB(t: RasterTriangle): AABB {
    const { v0, v1, v2 } = t;
    return {
        minX: Math.min(v0[0], v1[0], v2[0]),
        minY: Math.min(v0[1], v1[1], v2[1]),
        minZ: Math.min(v0[2], v1[2], v2[2]),
        maxX: Math.max(v0[0], v1[0], v2[0]),
        maxY: Math.max(v0[1], v1[1], v2[1]),
        maxZ: Math.max(v0[2], v1[2], v2[2]),
    };
}

function clipNamedTrimeshesForChunk(
    bin: ChunkBin,
    tris: readonly RasterTriangle[],
    controlsByNode: Readonly<Record<string, ObjectControls>>,
    bounds: AABB,
    /**
     * Path-cull keep test (world XZ). Collider trimeshes are invisible, so one
     * left standing where its voxels were culled is an invisible floor or wall
     * — the one artifact of this cull a player would actually walk into.
     *
     * Applied AFTER the chunk clip, per clipped triangle, testing all three
     * vertices and the centroid and keeping the triangle if ANY of them is
     * kept. The source triangles can be arbitrarily large (a whole terrain
     * plate is often two of them), so testing them un-clipped would decide the
     * fate of the corridor's collision from a point far outside it. Biased
     * toward KEEPING for the same reason: a stub of invisible floor at the cut
     * is a blemish, a hole in the track is a fall-through.
     *
     * Undefined = no cull.
     */
    keepsXZ?: (x: number, z: number) => boolean,
): NamedTrimesh[] {
    const colliderTrisByName = new Map<string, RasterTriangle[]>();
    for (const i of bin.triIndices) {
        const triangle = tris[i]!;
        const controls = controlsByNode[triangle.nodeName];
        if (controls?.trimeshCollider !== true && controls?.collisionOnly !== true) continue;
        const group = colliderTrisByName.get(triangle.nodeName);
        if (group) group.push(triangle);
        else colliderTrisByName.set(triangle.nodeName, [triangle]);
    }

    const namedTrimeshes: NamedTrimesh[] = [];
    for (const [name, groupTris] of colliderTrisByName) {
        const clipped = clipTrimeshToChunk(groupTris, bounds);
        if (clipped.verts.length === 0 || clipped.indices.length === 0) continue;
        const indices = keepsXZ ? cullClippedTriangles(clipped, keepsXZ) : clipped.indices;
        if (indices.length === 0) continue;
        const localVerts = new Float32Array(clipped.verts.length);
        for (let v = 0; v < clipped.verts.length; v += 3) {
            localVerts[v] = clipped.verts[v]! - bounds.minX;
            localVerts[v + 1] = clipped.verts[v + 1]! - bounds.minY;
            localVerts[v + 2] = clipped.verts[v + 2]! - bounds.minZ;
        }
        namedTrimeshes.push({ name, verts: localVerts, indices });
    }
    return namedTrimeshes;
}

/**
 * Drop the clipped collider triangles that lie wholly outside the path-cull
 * keep-region. Vertices are left in place — an unreferenced vertex costs a few
 * bytes, while re-indexing costs a pass and a map, and the survivors usually
 * reference most of them anyway.
 */
function cullClippedTriangles(
    clipped: { verts: Float32Array; indices: Uint32Array },
    keepsXZ: (x: number, z: number) => boolean,
): Uint32Array {
    const kept: number[] = [];
    for (let t = 0; t + 2 < clipped.indices.length; t += 3) {
        const ia = clipped.indices[t]! * 3;
        const ib = clipped.indices[t + 1]! * 3;
        const ic = clipped.indices[t + 2]! * 3;
        const ax = clipped.verts[ia]!, az = clipped.verts[ia + 2]!;
        const bx = clipped.verts[ib]!, bz = clipped.verts[ib + 2]!;
        const cx = clipped.verts[ic]!, cz = clipped.verts[ic + 2]!;
        if (keepsXZ(ax, az) || keepsXZ(bx, bz) || keepsXZ(cx, cz)
            || keepsXZ((ax + bx + cx) / 3, (az + bz + cz) / 3)) {
            kept.push(clipped.indices[t]!, clipped.indices[t + 1]!, clipped.indices[t + 2]!);
        }
    }
    return kept.length === clipped.indices.length ? clipped.indices : new Uint32Array(kept);
}

/** Verify v is a positive integer power of two (1, 2, 4, …). */
function isPowerOfTwo(v: number): boolean {
    return Number.isInteger(v) && v > 0 && (v & (v - 1)) === 0;
}

/**
 * Compute world bounds: use opts.bounds if present, else the triangle AABB.
 * Either way, snap min DOWN and max UP to whole chunkSize multiples, and
 * guarantee at least one chunk per axis.
 */
function computeBounds(tris: RasterTriangle[], opts: BakeOptions): AABB {
    let raw: AABB;
    if (opts.bounds) {
        raw = { ...opts.bounds };
    } else {
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (const t of tris) {
            const a = triAABB(t);
            if (a.minX < minX) minX = a.minX;
            if (a.minY < minY) minY = a.minY;
            if (a.minZ < minZ) minZ = a.minZ;
            if (a.maxX > maxX) maxX = a.maxX;
            if (a.maxY > maxY) maxY = a.maxY;
            if (a.maxZ > maxZ) maxZ = a.maxZ;
        }
        // No triangles → a single chunk at the origin.
        if (!isFinite(minX)) {
            minX = 0; minY = 0; minZ = 0; maxX = 0; maxY = 0; maxZ = 0;
        }
        raw = { minX, minY, minZ, maxX, maxY, maxZ };
    }

    const cs = opts.chunkSize;
    const snapMin = (v: number): number => Math.floor(v / cs) * cs;
    const snapMax = (v: number): number => Math.ceil(v / cs) * cs;

    const bMinX = snapMin(raw.minX), bMinY = snapMin(raw.minY), bMinZ = snapMin(raw.minZ);
    let bMaxX = snapMax(raw.maxX), bMaxY = snapMax(raw.maxY), bMaxZ = snapMax(raw.maxZ);

    // Guarantee at least one chunk per axis (max strictly above min).
    if (bMaxX <= bMinX) bMaxX = bMinX + cs;
    if (bMaxY <= bMinY) bMaxY = bMinY + cs;
    if (bMaxZ <= bMinZ) bMaxZ = bMinZ + cs;

    return { minX: bMinX, minY: bMinY, minZ: bMinZ, maxX: bMaxX, maxY: bMaxY, maxZ: bMaxZ };
}

/**
 * Downsample a min-cell grid by 2 (one coarser LOD step). Input keys are global
 * cell coords at the finer level; output keys are global coords at the coarser
 * level (= floor(fine/2) per axis). A coarse cell is occupied if ANY of its 8
 * fine children is. Color = mean of children; normal = normalized mean (zero if
 * the summed normal is ~0, e.g. all-interior); interior = majority (ties → not
 * interior, biasing toward a surface for the mesher); noCollider OR-ed.
 * Coarse LODs render grid-aligned only, so displacementAxis is null / dispOffset 0
 * (sub-cell displacement is a LOD0-only near-distance detail, design §3.8).
 */
export function downsampleGrid(grid: Map<number, CellAttr>): Map<number, CellAttr> {
    interface Agg {
        r: number; g: number; b: number;
        nx: number; ny: number; nz: number;
        interiorCount: number;
        noCollider: boolean;
        count: number;
    }
    const parents = new Map<number, Agg>();
    // Deterministic accumulation order.
    const keys = Array.from(grid.keys()).sort((a, b) => a - b);
    for (const key of keys) {
        const cell = grid.get(key)!;
        const [x, y, z] = unpackCell(key);
        const pKey = packCell(Math.floor(x / 2), Math.floor(y / 2), Math.floor(z / 2));
        let agg = parents.get(pKey);
        if (!agg) {
            agg = { r: 0, g: 0, b: 0, nx: 0, ny: 0, nz: 0, interiorCount: 0, noCollider: false, count: 0 };
            parents.set(pKey, agg);
        }
        agg.r += cell.color.r; agg.g += cell.color.g; agg.b += cell.color.b;
        agg.nx += cell.nx; agg.ny += cell.ny; agg.nz += cell.nz;
        if (cell.interior) agg.interiorCount++;
        if (cell.noCollider) agg.noCollider = true;
        agg.count++;
    }

    const out = new Map<number, CellAttr>();
    for (const [pKey, agg] of parents) {
        const inv = 1 / agg.count;
        let nx = agg.nx, ny = agg.ny, nz = agg.nz;
        const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (nlen > 1e-9) { nx /= nlen; ny /= nlen; nz /= nlen; } else { nx = 0; ny = 0; nz = 0; }
        out.set(pKey, {
            color: { r: agg.r * inv, g: agg.g * inv, b: agg.b * inv },
            nx, ny, nz,
            interior: agg.interiorCount * 2 > agg.count,
            noCollider: agg.noCollider,
            // A downsampled coarse cell is never pinned — pinned cells are meshed
            // separately at min-cell resolution and never enter downsampleGrid.
            pinned: false,
            displacementAxis: null,
            dispOffset: 0,
        });
    }
    return out;
}

/**
 * Split a min-cell grid into its pinned and non-pinned cells (design §6.2). Pinned
 * cells keep their finest detail at every LOD, so they are meshed separately at
 * min-cell resolution and never enter the coarse downsample path.
 */
function partitionPinned(grid: Map<number, CellAttr>): { pinned: Map<number, CellAttr>; rest: Map<number, CellAttr> } {
    const pinned = new Map<number, CellAttr>();
    const rest = new Map<number, CellAttr>();
    for (const [key, cell] of grid) {
        if (cell.pinned) pinned.set(key, cell);
        else rest.set(key, cell);
    }
    return { pinned, rest };
}

/** Floor of log2 for a positive integer (number of times it halves before reaching 1). */
export function log2Int(v: number): number {
    let n = 0;
    let x = v;
    while (x > 1) { x >>= 1; n++; }
    return n;
}

/**
 * Convert a chunk-resolution greedy quad (global chunk-RESOLUTION cell coords) into
 * CHUNK-LOCAL world-MIN-cell coords (design §7, adaptive resolution). A chunk
 * processed at offset `o` uses cells `chunkScale = 2^o`× larger than the world min:
 *   localWorldGx = (globalChunkResGx − cx·chunkCellsPerAxis) · chunkScale
 *   w/h          ×= chunkScale          sizeLevel-equivalent extent in min-cells
 * Origin and extents thus land on the coarse `chunkScale` grid, exactly the size a
 * world-min-resolution bake of this region at LOD `o` would produce. Quads already
 * scaled to chunk-resolution units (coarse LODs) pass `extraFactor` for the ×2^lod.
 */
export function localizeChunkResQuads(
    quads: SceneQuad[],
    cx: number, cy: number, cz: number,
    chunkCellsPerAxis: number,
    chunkScale: number,
    extraFactor: number,
): SceneQuad[] {
    const ocx = cx * chunkCellsPerAxis;
    const ocy = cy * chunkCellsPerAxis;
    const ocz = cz * chunkCellsPerAxis;
    const f = chunkScale * extraFactor;
    // A greedy quad stores its origin CELL; buildHintMesh places the face on the
    // cell's +dir side by adding exactly ONE MIN-CELL (dir === 1 → origin + 1). When
    // f > 1 a single source cell spans f min-cells, so the far (+dir) face belongs at
    // origin + f, not origin + 1. Pre-add (f − 1) on the face's own axis so the
    // renderer's +1 lands it on the far edge; without this the outer faces of every
    // voxel larger than the minimum collapse inward by f − 1 and render inside-out.
    // -dir faces stay on the near edge (origin); f === 1 (LOD0 of min-size voxels) is
    // unchanged.
    const far = f - 1;
    // The source object's lodOffset = log2(chunkScale) (chunkScale = 2^lodOffset is the
    // coarseness this group was baked at). Tag every quad with it so the renderer can
    // bias the depth test (polygonOffset) on coarser surfaces (z-fight bias). extraFactor
    // (the ×2^lod for coarser LODs) is a render-LOD concern the renderer folds in via the
    // render LOD index, so it is NOT applied here — `offset` is the SOURCE object's
    // coarseness only.
    const offset = Math.round(Math.log2(chunkScale));
    return quads.map(q => {
        const addFar = q.dir === 1 ? far : 0;
        return {
            ...q,
            gx: (q.gx - ocx) * f + (q.axis === 0 ? addFar : 0),
            gy: (q.gy - ocy) * f + (q.axis === 1 ? addFar : 0),
            gz: (q.gz - ocz) * f + (q.axis === 2 ? addFar : 0),
            w: q.w * f,
            h: q.h * f,
            offset,
        };
    });
}

/**
 * Step 3 interior fast path: a triangle-FREE chunk that is nonetheless enclosed deep
 * inside a closed object. ONE field lookup at the chunk center decides it:
 *   exterior → null (skip — the common empty-air case).
 *   interior → emit ONE whole-chunk interior voxel (sizeLevel = worldMaxCellLevel,
 *              uniform default color, noCollider:false, disp:null). No per-cell work.
 * A triangle-free chunk has no surface, so the field classifies it as a single uniform
 * region; one large voxel is the exact interior bulk. The voxel is in CHUNK-LOCAL
 * world-min-cell coords like every other chunk; lodHints are `additionalLods+1` EMPTY
 * levels (no surface → no quads). Only called when fillInterior is on (caller passes
 * the global field).
 */
function maybeEmitInteriorChunk(
    cx: number, cy: number, cz: number,
    chunkSize: number,
    minVoxelSize: number,
    worldMaxCellLevel: number,
    additionalLods: number,
    field: GlobalInteriorField,
): VxlSceneChunk | null {
    const ccx = (cx + 0.5) * chunkSize;
    const ccy = (cy + 0.5) * chunkSize;
    const ccz = (cz + 0.5) * chunkSize;
    if (!field.isInterior(ccx, ccy, ccz)) return null; // exterior

    // One whole-chunk interior voxel (edge = chunkSize). Interior is invisible/face-culled
    // so it is NOT bound by maxVoxelSize — sizeLevel = log2(cellsPerAxis).
    const color: RGB = { r: 0.5, g: 0.5, b: 0.5 };
    const voxels: SceneVoxel[] = [
        { gx: 0, gy: 0, gz: 0, sizeLevel: worldMaxCellLevel, color, noCollider: false, disp: null },
    ];
    const lodHints: SceneQuad[][] = [];
    for (let i = 0; i <= additionalLods; i++) lodHints.push([]);
    return { cx, cy, cz, voxels, lodHints, namedTrimeshes: [] };
}

/**
 * Yield control to the host event loop between chunks so it can repaint.
 *
 * Uses a MessageChannel macrotask rather than `setTimeout(0)`. Browsers clamp
 * `setTimeout` to ~4ms in the foreground and up to ~1000ms when the tab is
 * BACKGROUNDED; with one yield per chunk over tens of thousands of chunks, that
 * clamp silently turns a minutes-long bake into HOURS the moment the user switches
 * tabs. MessageChannel messages are still macrotasks (the host repaints between
 * them) but are NOT subject to the timer clamp, so the bake runs at full speed
 * whether the tab is focused or backgrounded. Falls back to `setTimeout` only where
 * MessageChannel is unavailable (some non-browser test environments).
 */
let _yieldChannel: MessageChannel | null = null;
function yieldToEventLoop(): Promise<void> {
    if (typeof MessageChannel === 'undefined') {
        return new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    const ch = _yieldChannel ?? (_yieldChannel = new MessageChannel());
    return new Promise<void>(resolve => {
        ch.port1.onmessage = (): void => { ch.port1.onmessage = null; resolve(); };
        ch.port2.postMessage(0);
    });
}

/**
 * Compose the vxlscene kernels into a VxlSceneWorld from world-space triangles.
 * Pure: no GLB parsing, no I/O. See the file header for the algorithm, the
 * LOD-pin handling, and the smooth-displacement flow.
 */
export async function bakeSceneFromTriangles(tris: RasterTriangle[], opts: BakeOptions): Promise<VxlSceneWorld> {
    const { chunkSize, minVoxelSize, maxVoxelSize, additionalLods, controlsByNode, pathCull } = opts;

    for (const [nodeName, controls] of Object.entries(controlsByNode)) {
        validateObjectControls(nodeName, controls);
    }

    // --- Constants (assert grid divisibility) ---
    const cellsPerAxis = Math.round(chunkSize / minVoxelSize);
    if (!isPowerOfTwo(cellsPerAxis)) {
        throw new Error(
            `bakeSceneFromTriangles: chunkSize/minVoxelSize must be a power-of-two integer ` +
            `(got chunkSize=${chunkSize}, minVoxelSize=${minVoxelSize} → ${cellsPerAxis})`,
        );
    }
    // Coarse-LOD downsampling halves cellsPerAxis once per level; with `additionalLods`
    // levels we need cellsPerAxis >= 2^additionalLods so local coords stay integers.
    if (additionalLods > 0 && (1 << additionalLods) > cellsPerAxis) {
        throw new Error(
            `bakeSceneFromTriangles: additionalLods=${additionalLods} requires ` +
            `cellsPerAxis (${cellsPerAxis}) >= 2^additionalLods (${1 << additionalLods})`,
        );
    }
    // World coarsest level: a voxel/quad sizeLevel never exceeds this regardless of
    // a chunk's adaptive offset (chunkMaxSizeLevel + offset ≤ worldMaxSizeLevel).
    const worldMaxSizeLevel = Math.round(Math.log2(maxVoxelSize / minVoxelSize));
    // Whole-chunk voxel level (= log2(cellsPerAxis)). INTERIOR voxels are invisible
    // (face-culled) so they are NOT capped at maxVoxelSize and may grow this large.
    const worldMaxCellLevel = log2Int(cellsPerAxis);

    // --- Bounds (snapped to chunk grid) ---
    const bounds = computeBounds(tris, opts);

    // --- Global flood-fill interior field (computed ONCE, world-space) ---
    // Replaces the per-chunk winding-number fill (the bake bottleneck). One coarse flood
    // marks every enclosed cell; each chunk then derives its interior via O(1) lookups.
    // cellSize ≈ max(maxVoxelSize·2, chunkSize/16): ~1–2 m here, fine enough that the
    // interior boundary is sub-chunk while the grid stays small (≤ MAX_CELLS, auto-grown).
    let interiorField: GlobalInteriorField | null = null;
    if (opts.fillInterior) {
        const cellSize = opts.interiorFieldCellSize ?? Math.max(maxVoxelSize * 2, chunkSize / 16);
        const renderTris = tris.filter(t => controlsByNode[t.nodeName]?.collisionOnly !== true);
        interiorField = buildGlobalInterior(renderTris, bounds, { cellSize });
    }

    // --- Chunk grid extents (inclusive cx/cy/cz ranges) ---
    const cxMin = Math.floor(bounds.minX / chunkSize);
    const cxMax = Math.ceil(bounds.maxX / chunkSize) - 1;
    const cyMin = Math.floor(bounds.minY / chunkSize);
    const cyMax = Math.ceil(bounds.maxY / chunkSize) - 1;
    const czMin = Math.floor(bounds.minZ / chunkSize);
    const czMax = Math.ceil(bounds.maxZ / chunkSize) - 1;

    // ── Step 1: spatial triangle binning (O(tris × avgChunksPerTri)) ────────────
    // For each triangle, find the chunk-coord box its world AABB overlaps (clamped to the
    // world chunk grid) and append its index to every overlapped chunk. Per-triangle lod
    // offsets are NOT reduced here — Step 2 groups each chunk's triangles by their OWN
    // offset and bakes each group at its own resolution (per-object LOD, design §7).
    const binKey = (cx: number, cy: number, cz: number): string => `${cx},${cy},${cz}`;
    const bins = new Map<string, ChunkBin>();
    for (let i = 0; i < tris.length; i++) {
        const t = tris[i]!;
        const a = triAABB(t);
        // Inclusive chunk-coord range of the triangle's AABB, clamped to the grid.
        const txMin = Math.max(cxMin, Math.floor(a.minX / chunkSize));
        const txMax = Math.min(cxMax, Math.floor(a.maxX / chunkSize));
        const tyMin = Math.max(cyMin, Math.floor(a.minY / chunkSize));
        const tyMax = Math.min(cyMax, Math.floor(a.maxY / chunkSize));
        const tzMin = Math.max(czMin, Math.floor(a.minZ / chunkSize));
        const tzMax = Math.min(czMax, Math.floor(a.maxZ / chunkSize));
        if (txMin > txMax || tyMin > tyMax || tzMin > tzMax) continue; // outside grid
        for (let cx = txMin; cx <= txMax; cx++) {
            for (let cy = tyMin; cy <= tyMax; cy++) {
                for (let cz = tzMin; cz <= tzMax; cz++) {
                    const k = binKey(cx, cy, cz);
                    let bin = bins.get(k);
                    if (!bin) { bin = { triIndices: [] }; bins.set(k, bin); }
                    bin.triIndices.push(i);
                }
            }
        }
    }

    const totalChunks = (cxMax - cxMin + 1) * (cyMax - cyMin + 1) * (czMax - czMin + 1);
    let chunkIndex = 0;
    let nonEmptyChunks = 0;

    // When a streaming sink is provided we DON'T accumulate chunks (peak memory must
    // stay bounded to one chunk); the array stays empty and the encoder consumes each
    // chunk via onChunkBaked. Otherwise we accumulate as before.
    const streaming = opts.onChunkBaked !== undefined;
    const chunks: VxlSceneChunk[] = [];

    // Per-bake aggregates, summed as each non-empty chunk is emitted (so they are
    // correct even in the streaming path where `chunks` is never populated).
    const totals: VxlSceneTotals = {
        nonEmptyChunkCount: 0,
        totalVoxels: 0,
        totalLod0Quads: 0,
        totalTrimeshTris: 0,
        totalTrimeshBytes: 0,
        chunksByOffset: {},
        voxelsByOffset: {},
    };

    /**
     * Diagnostic histogram contributions for ONE chunk. A chunk now mixes per-object
     * resolutions, so its voxels are attributed to each group's OWN offset
     * (`voxelsByOffset`) while the chunk itself is counted once under its finest/min
     * overlapping offset (`chunkOffset`). The interior fast-path passes a single bucket
     * at the whole-chunk level.
     */
    interface ChunkHistogram {
        /** chunksByOffset[chunkOffset] += 1 (the chunk's min/finest overlapping offset). */
        chunkOffset: number;
        /** voxelsByOffset[off] += count, one entry per per-object group in the chunk. */
        voxelsByOffset: Map<number, number>;
    }

    /**
     * Emit one non-empty chunk: tally its totals (offset-independent) and the
     * per-offset diagnostic histograms, then either stream it out (and let it be GC'd)
     * or push it onto the accumulated `chunks` array. The single place both code paths
     * funnel through so the streaming/non-streaming results stay geometry-identical.
     */
    const emitChunk = async (chunk: VxlSceneChunk, hist: ChunkHistogram): Promise<void> => {
        totals.nonEmptyChunkCount++;
        totals.totalVoxels += chunk.voxels.length;
        totals.totalLod0Quads += chunk.lodHints[0]?.length ?? 0;
        totals.chunksByOffset[hist.chunkOffset] = (totals.chunksByOffset[hist.chunkOffset] ?? 0) + 1;
        for (const [off, count] of hist.voxelsByOffset) {
            totals.voxelsByOffset[off] = (totals.voxelsByOffset[off] ?? 0) + count;
        }
        for (const tm of chunk.namedTrimeshes) {
            totals.totalTrimeshTris += tm.indices.length / 3;
            const vertBytes = tm.verts.byteLength;
            const idxBytes = tm.indices.length * (tm.verts.length / 3 <= 0xffff ? 2 : 4);
            totals.totalTrimeshBytes += vertBytes + idxBytes;
        }
        if (streaming) {
            await opts.onChunkBaked!(chunk);
        } else {
            chunks.push(chunk);
        }
    };

    /** Geometry + diagnostics for ONE per-object group baked at its own offset. */
    interface GroupBakeResult {
        /** CHUNK-LOCAL world-MIN-cell voxels (sizeLevel already += off). Empty if nothing rasterized. */
        voxels: SceneVoxel[];
        /** LOD0 + coarser quads, CHUNK-LOCAL world-MIN-cell coords. lodHints[0] is LOD0. */
        lodHints: SceneQuad[][];
        /** grid.size right after rasterize (diagnostics / profile.surfaceCells). */
        surfaceCells: number;
        /** Interior voxels emitted by fillInteriorFromField for this group (profile.interiorCells). */
        interiorVoxels: number;
        /** Per-phase wall-clock (ms) for THIS group; the caller sums across groups for profile.onChunk. */
        rasterizeMs: number; fillMs: number; compactMs: number; meshMs: number;
    }

    /**
     * Bake ONE per-object group of a chunk at ITS OWN lod offset (design §7, per-object
     * resolution). Runs the full single-resolution pipeline for `groupTris` at offset
     * `off`: derive the chunk-resolution lattice (cellsPerAxis >> off), rasterize at that
     * resolution, interior-fill (querying the GLOBAL field at this resolution — world
     * positions are reconstructed from the rasterize ctx exactly as before), compact
     * (capped at worldMaxSizeLevel-off), map voxels/quads back to CHUNK-LOCAL
     * world-min-cell coords (voxel sizeLevel += off, coords ×chunkScale), greedy-mesh
     * LOD0, then the coarser LODs with pinned cells kept at the group's finest detail.
     * Trimesh colliders are NOT handled here — they are clipped ONCE per chunk from the
     * chunk's whole triangle set, independent of grouping. Per-phase timings + geometry +
     * counts are returned so the caller can combine across groups and feed
     * profile.onChunk. Returns empty arrays
     * (and zero counts) when the group rasterizes to nothing and has no interior.
     */
    const bakeGroupAtOffset = (
        groupTris: RasterTriangle[],
        off: number,
        cx: number, cy: number, cz: number,
        cullClass: PathCullBoxClass,
    ): GroupBakeResult => {
        const chunkScale = 1 << off;                                  // 2^off
        const chunkCellsPerAxis = Math.round(cellsPerAxis / chunkScale); // integer (both pow2)
        const chunkMinVoxel = minVoxelSize * chunkScale;
        const chunkMaxSizeLevel = Math.max(0, worldMaxSizeLevel - off);
        // Coarse-LOD downsample halves chunkCellsPerAxis per level, so a coarse group
        // supports fewer additional LODs than the world; clamp so local coords stay
        // integers. The renderer clamps to each chunk's own LOD count.
        const chunkAdditionalLods = Math.min(additionalLods, log2Int(chunkCellsPerAxis));

        const originCellX = cx * chunkCellsPerAxis;
        const originCellY = cy * chunkCellsPerAxis;
        const originCellZ = cz * chunkCellsPerAxis;
        const ctx: RasterCtx = {
            originCellX, originCellY, originCellZ,
            cellsPerAxis: chunkCellsPerAxis, minVoxelSize: chunkMinVoxel, controlsByNode,
        };

        // Rasterize at the group resolution. Cell centers (cellIdx+0.5)*chunkMinVoxel are
        // correct WORLD positions, so winding + sampleColor work unchanged.
        const tRasterStart = performance.now();
        const grid = rasterizeChunk(groupTris, ctx);
        const rasterizeMs = performance.now() - tRasterStart;

        // Path cull, per cell. Only 'partial' columns reach here — 'none' columns
        // were skipped whole and 'all' columns need no test. Culling BEFORE the
        // interior fill and the mesher means the cut renders as an exposed
        // cross-section rather than as geometry that quietly kept its far side.
        const cullCells = pathCull !== undefined && cullClass === 'partial';
        if (cullCells) {
            for (const key of Array.from(grid.keys())) {
                const [gx, , gz] = unpackCell(key);
                if (!pathCull!.keeps((gx + 0.5) * chunkMinVoxel, (gz + 0.5) * chunkMinVoxel)) grid.delete(key);
            }
        }
        const surfaceCells = grid.size;

        // Interior classification from the GLOBAL field → large interior voxels
        // (group-resolution global cell coords) + an isSolid predicate for the mesher.
        const tFillStart = performance.now();
        const rawInterior = interiorField
            ? fillInteriorFromField(grid, ctx, interiorField)
            : { voxels: [] as SceneVoxel[], isSolid: (): boolean => false };
        // The global interior field knows nothing about the cull, so culled space
        // still reads as "inside a solid". Mask both halves of its contract: drop
        // interior voxels centred outside the keep-region, and make `isSolid`
        // false there so the mesher does NOT cull the faces at the cut (which
        // would leave a see-through hole instead of a wall).
        const interior = cullCells
            ? {
                voxels: rawInterior.voxels.filter((v) => {
                    const half = (1 << v.sizeLevel) / 2;
                    return pathCull!.keeps((v.gx + half) * chunkMinVoxel, (v.gz + half) * chunkMinVoxel);
                }),
                isSolid: (gx: number, gy: number, gz: number): boolean =>
                    pathCull!.keeps((gx + 0.5) * chunkMinVoxel, (gz + 0.5) * chunkMinVoxel)
                    && rawInterior.isSolid(gx, gy, gz),
            }
            : rawInterior;
        const fillMs = performance.now() - tFillStart;
        const interiorVoxels = interior.voxels.length;

        // Nothing rasterized AND no interior → empty group.
        if (grid.size === 0 && interiorVoxels === 0) {
            return { voxels: [], lodHints: [], surfaceCells, interiorVoxels, rasterizeMs, fillMs, compactMs: 0, meshMs: 0 };
        }

        // Compact the SURFACE grid (group-resolution coords) + append interior voxels.
        const tCompactStart = performance.now();
        const surfaceVoxels = compact(grid, { maxSizeLevel: chunkMaxSizeLevel, coplanarCos: 0.95, colorTol: 0.1 });
        const globalVoxels = [...surfaceVoxels, ...interior.voxels];
        const compactMs = performance.now() - tCompactStart;

        // LOD0 greedy mesh (group-resolution coords); cull faces abutting interior.
        const tMeshStart = performance.now();
        const lod0Global = greedyMesh(grid, { isSolidExtra: interior.isSolid });

        // ── Emit conversion: group-resolution coords → CHUNK-LOCAL world-MIN-cell ──
        // Voxel: local = (globalGroupResG − origin) · chunkScale; sizeLevel += off.
        const voxels: SceneVoxel[] = globalVoxels.map(v => ({
            ...v,
            gx: (v.gx - originCellX) * chunkScale,
            gy: (v.gy - originCellY) * chunkScale,
            gz: (v.gz - originCellZ) * chunkScale,
            sizeLevel: v.sizeLevel + off,
        }));
        // LOD0 quads: localize + ×chunkScale (extraFactor 1).
        const lodHints: SceneQuad[][] = [
            localizeChunkResQuads(lod0Global, cx, cy, cz, chunkCellsPerAxis, chunkScale, 1),
        ];

        // Coarser LODs i=1..chunkAdditionalLods. Pinned cells keep their FINEST
        // (group-resolution) detail at every LOD; the rest downsample. Coarse quads come
        // back in coarse-cell units (×2^i within the group-resolution grid), and the
        // whole group-resolution grid is itself ×chunkScale world-min cells, so a coarse
        // quad's world-min extent = chunkScale·2^i (extraFactor 2^i).
        const { pinned: pinnedGrid, rest: restGrid } = partitionPinned(grid);
        const pinnedFineQuads = pinnedGrid.size > 0 ? greedyMesh(pinnedGrid) : [];
        const pinnedFineLocal = pinnedFineQuads.length > 0
            ? localizeChunkResQuads(pinnedFineQuads, cx, cy, cz, chunkCellsPerAxis, chunkScale, 1)
            : [];
        let coarseGrid = restGrid;
        for (let i = 1; i <= chunkAdditionalLods; i++) {
            coarseGrid = downsampleGrid(coarseGrid);
            // The downsampled grid is at resolution chunkCellsPerAxis>>i, so its chunk
            // origin is cx*(chunkCellsPerAxis>>i) — pass the DOWNSAMPLED per-axis count so
            // the origin matches (the existing LOD>=1 origin fix; design note above).
            const coarseLocal = localizeChunkResQuads(
                greedyMesh(coarseGrid), cx, cy, cz, chunkCellsPerAxis >> i, chunkScale, 1 << i,
            );
            lodHints.push(pinnedFineLocal.length > 0 ? [...coarseLocal, ...pinnedFineLocal] : coarseLocal);
        }
        const meshMs = performance.now() - tMeshStart;

        return { voxels, lodHints, surfaceCells, interiorVoxels, rasterizeMs, fillMs, compactMs, meshMs };
    };

    // ── Step 2 + 3: per-chunk adaptive bake ─────────────────────────────────────
    // Deterministic chunk iteration: cx outer, cy middle, cz inner. Every grid chunk
    // (empty included) fires onProgress and advances chunkIndex; only non-empty chunks
    // fire profile.onChunk. Chunks present in `bins` bake PER OBJECT — each object's
    // triangles at their own lod offset, combined into one mixed-resolution chunk
    // (Step 2); triangle-free chunks take the interior fast path (Step 3).
    // The path cull is a 2D (XZ) region, so its verdict is per chunk COLUMN and is
    // reused by every cy in that column — classifyBox scans the whole polyline, so
    // re-deciding it once per chunk would cost segments × chunks for nothing.
    const cullClassByColumn = new Map<number, PathCullBoxClass>();
    const columnCullClass = (cx: number, cz: number): PathCullBoxClass => {
        if (!pathCull) return 'all';
        const key = (cx - cxMin) * (czMax - czMin + 1) + (cz - czMin);
        const cached = cullClassByColumn.get(key);
        if (cached !== undefined) return cached;
        const verdict = pathCull.classifyBox(
            cx * chunkSize, cz * chunkSize, (cx + 1) * chunkSize, (cz + 1) * chunkSize,
        );
        cullClassByColumn.set(key, verdict);
        return verdict;
    };

    /**
     * Close out one visited grid chunk — report progress (every chunk, empty ones
     * included, so progress stays honest about the grid it walked), advance the
     * index, and yield to the host so it can repaint.
     */
    const advanceChunk = async (cx: number, cy: number, cz: number): Promise<void> => {
        opts.onProgress?.({ chunkIndex, totalChunks, nonEmptyChunks, label: `chunk (${cx},${cy},${cz})` });
        chunkIndex++;
        await yieldToEventLoop();
    };

    for (let cx = cxMin; cx <= cxMax; cx++) {
        const chunkMinX = cx * chunkSize;
        const chunkMaxX = (cx + 1) * chunkSize;
        for (let cy = cyMin; cy <= cyMax; cy++) {
            const chunkMinY = cy * chunkSize;
            const chunkMaxY = (cy + 1) * chunkSize;
            for (let cz = czMin; cz <= czMax; cz++) {
                const chunkMinZ = cz * chunkSize;
                const chunkMaxZ = (cz + 1) * chunkSize;

                // Wholly outside the keep-region: nothing to rasterize, no interior
                // to fill, no collider to clip. Still counted + reported as a visited
                // chunk so progress stays honest about the grid it walked.
                const cullClass = columnCullClass(cx, cz);
                if (cullClass === 'none') {
                    await advanceChunk(cx, cy, cz);
                    continue;
                }

                const bin = bins.get(binKey(cx, cy, cz));

                // ── Step 3: triangle-free chunk → interior fast path ───────────
                if (!bin) {
                    // The fast path emits ONE whole-chunk voxel, so it cannot be cut in
                    // half: a straddling column keeps or drops it by its centre. It is
                    // enclosed bulk deep inside a solid, and it collides, so leaving it
                    // where the centre was culled would be an invisible wall.
                    const fastCulled = cullClass === 'partial'
                        && !pathCull!.keeps((cx + 0.5) * chunkSize, (cz + 0.5) * chunkSize);
                    const fastChunk = !interiorField || fastCulled
                        ? null
                        : maybeEmitInteriorChunk(cx, cy, cz, chunkSize, minVoxelSize, worldMaxCellLevel, additionalLods, interiorField);
                    if (fastChunk) {
                        nonEmptyChunks++;
                        // Interior fast-path chunks have no surface object; tally them under
                        // the whole-chunk level so they're visible but don't masquerade as
                        // fine (offset-0) surface chunks in the diagnostic histogram.
                        await emitChunk(fastChunk, {
                            chunkOffset: worldMaxCellLevel,
                            voxelsByOffset: new Map([[worldMaxCellLevel, fastChunk.voxels.length]]),
                        });
                    }
                    await advanceChunk(cx, cy, cz);
                    continue;
                }

                // ── Step 2: PER-OBJECT adaptive resolution (design §7) ──────────────
                // Each object in this chunk voxelizes at ITS OWN lod offset, so a chunk's
                // geometry is a MIX of resolutions (a +0 road and a +2 terrain coexist at
                // their own sizes). Group the chunk's binned triangles by per-triangle
                // offset, bake each group at that offset, then COMBINE. (The OLD baker
                // baked the whole chunk at the chunk's MIN/finest offset, dragging coarse
                // objects down to the fine size — the bug this fixes.)
                const maxOffset = log2Int(cellsPerAxis);
                const triOffset = (i: number): number =>
                    Math.min(Math.max(0, controlsByNode[tris[i]!.nodeName]?.lodOffset ?? 0), maxOffset);

                // Bucket triIndices by offset. bin.triIndices is ascending, and we scan it
                // in order, so each bucket's indices stay ascending → deterministic group
                // triangle order. Offsets are then visited in ASCENDING order.
                const byOffset = new Map<number, number[]>();
                for (const i of bin.triIndices) {
                    if (controlsByNode[tris[i]!.nodeName]?.collisionOnly === true) continue;
                    const off = triOffset(i);
                    let arr = byOffset.get(off);
                    if (!arr) { arr = []; byOffset.set(off, arr); }
                    arr.push(i);
                }
                const offsets = Array.from(byOffset.keys()).sort((a, b) => a - b);
                const minOffset = offsets[0] ?? 0; // finest overlapping offset (chunk histogram + profile)

                // Bake each offset group; collect non-empty results in ascending-offset order.
                const groups: { off: number; result: GroupBakeResult }[] = [];
                for (const off of offsets) {
                    const groupTris = byOffset.get(off)!.map(i => tris[i]!);
                    const result = bakeGroupAtOffset(groupTris, off, cx, cy, cz, cullClass);
                    // A group with no surface and no interior produces empty arrays; skip it
                    // (lodHints.length === 0 ⇔ empty group; a non-empty group always has LOD0).
                    if (result.lodHints.length === 0 && result.voxels.length === 0) continue;
                    groups.push({ off, result });
                }

                const tClipStart = performance.now();
                const namedTrimeshes = clipNamedTrimeshesForChunk(bin, tris, controlsByNode, {
                    minX: chunkMinX, minY: chunkMinY, minZ: chunkMinZ,
                    maxX: chunkMaxX, maxY: chunkMaxY, maxZ: chunkMaxZ,
                }, cullClass === 'partial' ? pathCull!.keeps : undefined);
                const clipMs = performance.now() - tClipStart;

                // Every render group empty and no named collision mesh → nothing to emit.
                if (groups.length === 0) {
                    if (namedTrimeshes.length > 0) {
                        nonEmptyChunks++;
                        await emitChunk(
                            { cx, cy, cz, voxels: [], lodHints: [[]], namedTrimeshes },
                            { chunkOffset: 0, voxelsByOffset: new Map() },
                        );
                        opts.profile?.onChunk({
                            index: chunkIndex,
                            totalChunks,
                            cx, cy, cz,
                            surfaceCells: 0,
                            interiorCells: 0,
                            voxels: 0,
                            quads: 0,
                            rasterizeMs: 0,
                            fillMs: 0,
                            compactMs: 0,
                            meshMs: 0,
                            clipMs,
                            chunkCellsPerAxis: cellsPerAxis,
                            lodOffset: 0,
                        });
                    }
                    await advanceChunk(cx, cy, cz);
                    continue;
                }

                // COMBINE the groups into one chunk (mixed sizeLevels / quad scales).
                //  • voxels: concat (each group already mapped to CHUNK-LOCAL world-min cells).
                //  • lodHints: maxLevels = max group LOD count; level k = concat over groups
                //    of group.lodHints[min(k, group.lodHints.length-1)] — a group with fewer
                //    LODs reuses its COARSEST level for far levels so a coarse object does NOT
                //    vanish at distance.
                const voxels: SceneVoxel[] = [];
                let maxLevels = 0;
                for (const g of groups) {
                    for (const v of g.result.voxels) voxels.push(v);
                    if (g.result.lodHints.length > maxLevels) maxLevels = g.result.lodHints.length;
                }
                const lodHints: SceneQuad[][] = [];
                for (let k = 0; k < maxLevels; k++) {
                    const level: SceneQuad[] = [];
                    for (const g of groups) {
                        const src = g.result.lodHints[Math.min(k, g.result.lodHints.length - 1)]!;
                        for (const q of src) level.push(q);
                    }
                    lodHints.push(level);
                }

                // Diagnostic histogram: attribute voxels to each GROUP's own offset, but
                // count the chunk once at its finest (min) offset.
                const voxelsByOffset = new Map<number, number>();
                for (const g of groups) {
                    voxelsByOffset.set(g.off, (voxelsByOffset.get(g.off) ?? 0) + g.result.voxels.length);
                }

                nonEmptyChunks++;
                await emitChunk({ cx, cy, cz, voxels, lodHints, namedTrimeshes }, { chunkOffset: minOffset, voxelsByOffset });

                // profile.onChunk: aggregate per-chunk counts + per-phase timings ACROSS
                // groups; report the chunk's FINEST resolution (min offset →
                // chunkCellsPerAxis at that offset). All sums are this chunk's, not the
                // rolling [BAKE-PERF] window.
                if (opts.profile) {
                    let surfaceCells = 0, interiorCells = 0;
                    let rasterizeMs = 0, fillMs = 0, compactMs = 0, meshMs = 0;
                    for (const g of groups) {
                        surfaceCells += g.result.surfaceCells;
                        interiorCells += g.result.interiorVoxels;
                        rasterizeMs += g.result.rasterizeMs;
                        fillMs += g.result.fillMs;
                        compactMs += g.result.compactMs;
                        meshMs += g.result.meshMs;
                    }
                    opts.profile.onChunk({
                        index: chunkIndex,
                        totalChunks,
                        cx, cy, cz,
                        surfaceCells,
                        interiorCells,
                        voxels: voxels.length,
                        quads: lodHints[0]?.length ?? 0,
                        rasterizeMs,
                        fillMs,
                        compactMs,
                        meshMs,
                        clipMs,
                        chunkCellsPerAxis: cellsPerAxis >> minOffset,
                        lodOffset: minOffset,
                    });
                }
                await advanceChunk(cx, cy, cz);
            }
        }
    }

    return {
        chunkSize,
        minVoxelSize,
        bounds,
        lodDistances: opts.lodDistances,
        // Empty in the streaming path (each chunk was handed to onChunkBaked and
        // dropped); fully populated otherwise. Callers that need counts read `totals`.
        chunks,
        totals,
    };
}
