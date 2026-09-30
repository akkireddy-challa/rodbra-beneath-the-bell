/**
 * GlbColliderBuilder — pure collider core for GLB native assets' precise-collision
 * option: triangles in, Rapier-ready trimesh out.
 *
 * Under the triangle budget the source triangles pass through directly (vertex
 * soup, no dedup — Rapier accepts that). Over budget the mesh is auto-simplified:
 * coarse-voxelize with the existing SurfaceRasterizer, greedy-mesh the occupancy
 * grid, and emit the quad trimesh — deterministic output size, robust against bad
 * topology. Either way the winding is normalized upward via the shared
 * orientTrimeshUpward safeguard so walkable surfaces read as ground, not ceiling.
 *
 * THREE-free on purpose: this module (and the vxlscene kernels it calls) must
 * stay pure so it runs under ts-jest node exactly as it does in the iframe.
 *
 * Simplify-path coordinate frame: rasterizeChunk anchors its cell grid at world
 * origin (cell = floor(coord / minVoxelSize)) and packs cell coords into keys
 * with a hard +/-CELL_KEY_HALF (65536) per-axis range. A GLB asset can sit
 * anywhere, so the triangles are rebased once into an asset-local frame at the
 * bounds min — cell coords then span [0, cellsPerAxis], always in range — and
 * the bounds min is restored as the quadsToTrimesh origin (world position of
 * grid cell 0). The rebase copy also normalizes every triangle to one node name
 * and one constant color: the greedy mesher merges per color, so a constant
 * color yields maximal quads (colors are irrelevant to a collider).
 *
 * RasterCtx regions are cubic (one scalar cellsPerAxis) and clamp-only — the
 * traversal cost is bounded by the triangle footprints, so sizing the region to
 * the max axis (rounded up, +1 spare cell so a surface coplanar with the max
 * bound still lands in the cell at the boundary) adds no work. Neither the
 * origin nor cellsPerAxis needs to be a power of two.
 */
import {
    rasterizeChunk,
    CELL_KEY_HALF,
    type RasterTriangle,
    type RasterCtx,
} from 'engine/vxlscene/SurfaceRasterizer.js';
import { greedyMesh } from 'engine/vxlscene/GreedyMesher.js';
import { quadsToTrimesh, orientTrimeshUpward } from 'engine/vxlscene/ColliderBaker.js';
import type { RGB } from 'engine/vxlscene/SceneVoxTypes.js';

export type { RasterTriangle } from 'engine/vxlscene/SurfaceRasterizer.js';

export interface BuildGlbColliderOptions {
    /** Max output triangles; also the threshold for the direct pass-through. */
    triangleBudget: number;
    /** Starting resolution cap for the simplify grid (halved each retry by doubling the cell). */
    maxCellsPerAxis: number;
}

export const DEFAULT_GLB_COLLIDER_OPTIONS: BuildGlbColliderOptions = {
    triangleBudget: 50_000,
    maxCellsPerAxis: 128,
};

export interface BuildGlbColliderResult {
    verts: Float32Array;
    indices: Uint32Array;
    triangleCount: number;
    simplified: boolean;
    /** Cell size used by the simplify path; undefined for direct pass-through. */
    cellSize?: number;
}

/**
 * Doubling the cell 8 times spans maxCellsPerAxis=128 down to a single cell;
 * beyond that, give up. COUPLED to DEFAULT_GLB_COLLIDER_OPTIONS.maxCellsPerAxis:
 * a caller starting at a much finer resolution (e.g. 4096) exhausts these
 * attempts before reaching coarse grids — raise both together.
 */
const MAX_SIMPLIFY_ATTEMPTS = 8;

/** Constant color for the collider bake — maximizes greedy merging (see module doc). */
const COLLIDER_COLOR: RGB = { r: 1, g: 1, b: 1 };
const sampleColliderColor = (): RGB => COLLIDER_COLOR;
/** Single node name so every triangle shares DEFAULT_OBJECT_CONTROLS in one raster group. */
const COLLIDER_NODE = 'glb-collider';

interface Bounds {
    minX: number; minY: number; minZ: number;
    maxX: number; maxY: number; maxZ: number;
}

function boundsOf(tris: RasterTriangle[]): Bounds {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const t of tris) {
        for (const v of [t.v0, t.v1, t.v2]) {
            if (v[0] < minX) minX = v[0];
            if (v[1] < minY) minY = v[1];
            if (v[2] < minZ) minZ = v[2];
            if (v[0] > maxX) maxX = v[0];
            if (v[1] > maxY) maxY = v[1];
            if (v[2] > maxZ) maxZ = v[2];
        }
    }
    return { minX, minY, minZ, maxX, maxY, maxZ };
}

/**
 * Build a Rapier-ready trimesh for a GLB asset's triangles (see module doc for
 * the direct vs auto-simplify split). Triangles are expected in the asset's own
 * space; the result is in the same space. Throws on empty input, degenerate
 * bounds, and when the budget cannot be met within the retry cap.
 */
export function buildColliderFromTriangles(
    tris: RasterTriangle[],
    options: BuildGlbColliderOptions,
): BuildGlbColliderResult {
    if (tris.length === 0) throw new Error('No triangles in GLB for collider generation');

    // Non-finite vertices (corrupt GLB) would reach RAPIER.ColliderDesc.trimesh
    // and panic the WASM module, killing all physics — reject up front.
    for (const t of tris) {
        for (const v of [t.v0, t.v1, t.v2]) {
            if (!Number.isFinite(v[0]) || !Number.isFinite(v[1]) || !Number.isFinite(v[2])) {
                throw new Error('GLB contains non-finite vertex positions; cannot build collider');
            }
        }
    }

    if (tris.length <= options.triangleBudget) {
        // Direct: 3 verts per triangle (no dedup — Rapier is fine with soup).
        const verts = new Float32Array(tris.length * 9);
        const indices = new Uint32Array(tris.length * 3);
        for (let i = 0; i < tris.length; i++) {
            const t = tris[i]!;
            const o = i * 9;
            verts[o] = t.v0[0]; verts[o + 1] = t.v0[1]; verts[o + 2] = t.v0[2];
            verts[o + 3] = t.v1[0]; verts[o + 4] = t.v1[1]; verts[o + 5] = t.v1[2];
            verts[o + 6] = t.v2[0]; verts[o + 7] = t.v2[1]; verts[o + 8] = t.v2[2];
            indices[i * 3] = i * 3;
            indices[i * 3 + 1] = i * 3 + 1;
            indices[i * 3 + 2] = i * 3 + 2;
        }
        return {
            verts,
            indices: orientTrimeshUpward(verts, indices),
            triangleCount: tris.length,
            simplified: false,
        };
    }

    // Simplify: coarse grid -> greedy quads -> quad trimesh. Double the cell until
    // the quad-derived triangle count fits the budget (bounded retries).
    const b = boundsOf(tris);
    const maxDim = Math.max(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ);
    if (!Number.isFinite(maxDim) || maxDim <= 0) {
        throw new Error('GLB collider simplification needs finite, non-degenerate triangle bounds');
    }
    if (!Number.isFinite(options.maxCellsPerAxis) || options.maxCellsPerAxis < 1
        || options.maxCellsPerAxis + 2 >= CELL_KEY_HALF) {
        throw new Error(
            `maxCellsPerAxis must be in [1, ${CELL_KEY_HALF - 3}] (packCell grid-key range), `
            + `got ${options.maxCellsPerAxis}`,
        );
    }

    // Rebase once into the asset-local frame (shift is cell-size independent).
    const local: RasterTriangle[] = tris.map((t) => ({
        v0: [t.v0[0] - b.minX, t.v0[1] - b.minY, t.v0[2] - b.minZ],
        v1: [t.v1[0] - b.minX, t.v1[1] - b.minY, t.v1[2] - b.minZ],
        v2: [t.v2[0] - b.minX, t.v2[1] - b.minY, t.v2[2] - b.minZ],
        normal: t.normal, // translation-invariant; reused, never mutated downstream
        nodeName: COLLIDER_NODE,
        sampleColor: sampleColliderColor,
    }));

    let cell = maxDim / options.maxCellsPerAxis;
    for (let attempt = 0; attempt < MAX_SIMPLIFY_ATTEMPTS; attempt++) {
        // +1 spare cell: a surface coplanar with the max bound lands in the cell
        // AT the boundary (floor(maxDim/cell) when the division is exact).
        const ctx: RasterCtx = {
            originCellX: 0, originCellY: 0, originCellZ: 0,
            cellsPerAxis: Math.ceil(maxDim / cell) + 1,
            minVoxelSize: cell,
            controlsByNode: {},
        };
        // One attempt's grid lives at a time — rebuilt per attempt, dropped on retry.
        const grid = rasterizeChunk(local, ctx);
        const quads = greedyMesh(grid);
        const triCount = quads.length * 2;
        if (triCount > 0 && triCount <= options.triangleBudget) {
            const { verts, indices } = quadsToTrimesh(quads, cell, b.minX, b.minY, b.minZ);
            return {
                verts,
                indices: orientTrimeshUpward(verts, indices),
                triangleCount: triCount,
                simplified: true,
                cellSize: cell,
            };
        }
        cell *= 2;
    }
    throw new Error(
        `Could not simplify GLB collider under the ${options.triangleBudget}-triangle budget `
        + `after ${MAX_SIMPLIFY_ATTEMPTS} attempts`,
    );
}
