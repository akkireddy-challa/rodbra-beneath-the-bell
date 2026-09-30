/**
 * ColliderBaker — Phase 7 of the GLB-scene voxelizer (design §3.10, §6.4).
 *
 * Two entry points:
 *   greedyBoxes      — emit ONE axis-aligned box per solid (non-noCollider)
 *                      SceneVoxel (min-cell integer coordinates); O(voxels).
 *   clipTrimeshToChunk — Sutherland-Hodgman clip of original GLB triangles to
 *                      a chunk AABB; produces a deduped Float32/Uint32 mesh.
 */

import type { SceneVoxel, SceneQuad } from 'engine/vxlscene/SceneVoxTypes.js';
import type { DecodedChunkVoxels, DecodedChunkQuads } from 'engine/vxlscene/VxlSceneFormat.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Axis-aligned box in MIN-CELL units (integer grid coords). */
export interface AABB {
    minX: number; minY: number; minZ: number;
    maxX: number; maxY: number; maxZ: number;
}

export interface TrimeshBlob {
    verts: Float32Array;
    indices: Uint32Array;
}

// ---------------------------------------------------------------------------
// quadsToTrimesh
// ---------------------------------------------------------------------------

/**
 * Write ONE greedy quad's 4 verts + 6 indices (2 triangles) into the output
 * buffers at slot `w`. Shared by {@link quadsToTrimesh} (object form) and
 * {@link quadsToTrimeshSoA} (column form) so their geometry can never drift —
 * and it MIRRORS `buildHintMesh` exactly: same corner construction, the +/- side
 * offset along the face axis, and the `dir`-dependent winding.
 */
function emitQuadTrimesh(
    verts: Float32Array, indices: Uint32Array, w: number,
    d: number, dir: 1 | -1,
    og0: number, og1: number, og2: number, qw: number, qh: number,
    s: number, originX: number, originY: number, originZ: number,
): void {
    const u = (d + 1) % 3;        // in-plane axis carrying quad.w
    const v = (d + 2) % 3;        // in-plane axis carrying quad.h
    // +dir → far side (origin+1) along axis d, -dir → near side (origin+0).
    const dOffset = dir === 1 ? 1 : 0;

    const gridComp = (j: number, base: number, a: number, b: number): number =>
        base + (j === d ? dOffset : 0) + (j === u ? a : 0) + (j === v ? b : 0);
    const cornerX = (a: number, b: number): number => gridComp(0, og0, a, b) * s + originX;
    const cornerY = (a: number, b: number): number => gridComp(1, og1, a, b) * s + originY;
    const cornerZ = (a: number, b: number): number => gridComp(2, og2, a, b) * s + originZ;

    const base = w * 4;
    const writeVert = (vi: number, a: number, b: number): void => {
        const o = (base + vi) * 3;
        verts[o] = cornerX(a, b);
        verts[o + 1] = cornerY(a, b);
        verts[o + 2] = cornerZ(a, b);
    };
    // c00, c10, c11, c01 — same vertex order as buildHintMesh.
    writeVert(0, 0, 0);
    writeVert(1, qw, 0);
    writeVert(2, qw, qh);
    writeVert(3, 0, qh);

    const io = w * 6;
    if (dir === 1) {
        indices[io] = base + 0; indices[io + 1] = base + 1; indices[io + 2] = base + 2;
        indices[io + 3] = base + 0; indices[io + 4] = base + 2; indices[io + 5] = base + 3;
    } else {
        indices[io] = base + 0; indices[io + 1] = base + 2; indices[io + 2] = base + 1;
        indices[io + 3] = base + 0; indices[io + 4] = base + 3; indices[io + 5] = base + 2;
    }
}

/**
 * Build a Rapier-ready trimesh (2 triangles per greedy quad) in WORLD space from
 * a chunk's LOD quads. Used by the load-time oversized-world guard: when the
 * memory-bounded decode drops per-voxel data, a chunk's collider is baked from
 * its now-finest LOD quads instead of voxel boxes.
 *
 * The quad→world math MIRRORS `buildHintMesh` exactly (via {@link emitQuadTrimesh})
 * so the collider surface coincides with the rendered surface.
 *
 * Vertices are NOT deduped across quads (each quad emits its own 4 verts) — Rapier
 * accepts that and it keeps the function O(quads) and allocation-bounded.
 */
export function quadsToTrimesh(
    quads: SceneQuad[],
    minVoxelSize: number,
    originX: number,
    originY: number,
    originZ: number,
): TrimeshBlob {
    const n = quads.length;
    const verts = new Float32Array(n * 4 * 3); // 4 verts per quad
    const indices = new Uint32Array(n * 6);    // 2 triangles per quad

    for (let i = 0; i < n; i++) {
        const quad = quads[i]!;
        emitQuadTrimesh(
            verts, indices, i, quad.axis, quad.dir,
            quad.gx, quad.gy, quad.gz, quad.w, quad.h,
            minVoxelSize, originX, originY, originZ,
        );
    }

    return { verts, indices };
}

/**
 * Structure-of-Arrays variant of {@link quadsToTrimesh} for the runtime
 * reduced-detail collider path. Reads decoded quad columns directly (no
 * per-quad objects) and produces the SAME 2-triangles-per-quad world-space
 * trimesh (via the shared {@link emitQuadTrimesh}).
 */
export function quadsToTrimeshSoA(
    quads: DecodedChunkQuads,
    minVoxelSize: number,
    originX: number,
    originY: number,
    originZ: number,
): TrimeshBlob {
    const n = quads.count;
    // Quads whose owner object is collision-excluded (axisDir bit 6, e.g. painted
    // road lines) are decoration: they render but must NOT be in the collider, or
    // they become steps the player/AI bounces off. Count the collidable ones first
    // so the output arrays are sized exactly.
    let m = 0;
    for (let i = 0; i < n; i++) if (((quads.axisDir[i]! >> 6) & 1) === 0) m++;
    const verts = new Float32Array(m * 4 * 3); // 4 verts per collidable quad
    const indices = new Uint32Array(m * 6);    // 2 triangles per collidable quad

    let w = 0; // output (collidable) quad index
    for (let i = 0; i < n; i++) {
        const axisDir = quads.axisDir[i]!;
        if (((axisDir >> 6) & 1) !== 0) continue; // no-collider quad — skip
        const d = axisDir & 0x3;          // face axis 0=X,1=Y,2=Z
        const dir = ((axisDir >> 2) & 1) === 0 ? 1 : -1;
        emitQuadTrimesh(
            verts, indices, w, d, dir,
            quads.gx[i]!, quads.gy[i]!, quads.gz[i]!, quads.w[i]!, quads.h[i]!,
            minVoxelSize, originX, originY, originZ,
        );
        w++;
    }

    return { verts, indices };
}

/**
 * The voxels-collider counterpart of {@link quadsToTrimeshSoA}: the set of
 * solid cells that OWN the chunk's collidable surface quads, as flat
 * (x, y, z) triples in chunk-local min-cell coords.
 *
 * A quad's grid origin IS the owning cell (`dir` only picks which face plane —
 * see emitQuadTrimesh), so the emitted shell is exactly the crust the quad
 * surface renders: same cells, same noCollider filter, and — like the trimesh —
 * per-quad displacement is ignored. Interior faces between adjacent shell cells
 * generate no contacts, and nothing ever collides from inside the terrain, so
 * the crust is equivalent to a solid fill at a fraction of the cells. Winding
 * does not exist for a voxels shape, so the orientTrimeshUpward rescue below is
 * unnecessary on this path.
 */
export function quadsToShellCells(quads: DecodedChunkQuads): Int32Array {
    const seen = new Set<number>();
    const n = quads.count;
    const og = [0, 0, 0];
    for (let i = 0; i < n; i++) {
        const axisDir = quads.axisDir[i]!;
        if (((axisDir >> 6) & 1) !== 0) continue; // no-collider quad — skip
        const d = axisDir & 0x3;
        const u = (d + 1) % 3;        // in-plane axis carrying quad.w
        const v = (d + 2) % 3;        // in-plane axis carrying quad.h
        og[0] = quads.gx[i]!; og[1] = quads.gy[i]!; og[2] = quads.gz[i]!;
        const qw = quads.w[i]!, qh = quads.h[i]!;
        for (let b = 0; b < qh; b++) {
            for (let a = 0; a < qw; a++) {
                const x = og[0]! + (u === 0 ? a : 0) + (v === 0 ? b : 0);
                const y = og[1]! + (u === 1 ? a : 0) + (v === 1 ? b : 0);
                const z = og[2]! + (u === 2 ? a : 0) + (v === 2 ? b : 0);
                seen.add((y * 65536 + z) * 65536 + x);
            }
        }
    }
    const cells = new Int32Array(seen.size * 3);
    let o = 0;
    for (const key of seen) {
        const x = key % 65536;
        const rest = (key - x) / 65536;
        const z = rest % 65536;
        const y = (rest - z) / 65536;
        cells[o++] = x; cells[o++] = y; cells[o++] = z;
    }
    return cells;
}

// ---------------------------------------------------------------------------
// orientTrimeshUpward
// ---------------------------------------------------------------------------

/**
 * Return a copy of `indices` with every clearly downward-facing triangle's
 * winding reversed so its geometric normal points +Y.
 *
 * Rapier derives a trimesh contact normal from triangle WINDING (especially with
 * TriMeshFlags.FIX_INTERNAL_EDGES), not from any stored vertex normals. A baked
 * named-trimesh collider whose drivable surface was authored with reversed
 * winding therefore reads as a ceiling to the character controller — the capsule
 * rests on it but `computedGrounded()` is false, so the player cannot jump and
 * slides as if on ice. Re-orienting the surface up at collider-build time fixes
 * such meshes at load (e.g. older forged city levels baked before the generator
 * wound roads correctly) without re-baking.
 *
 * Only triangles whose normalized normal.y is meaningfully negative are flipped;
 * near-vertical walls (normal.y ≈ 0) and already-upward triangles are untouched,
 * so a correctly-wound mesh is returned unchanged.
 */
export function orientTrimeshUpward(verts: Float32Array, indices: Uint32Array): Uint32Array {
    const out = new Uint32Array(indices.length);
    for (let t = 0; t < indices.length; t += 3) {
        const i0 = indices[t]!, i1 = indices[t + 1]!, i2 = indices[t + 2]!;
        const ax = verts[i0 * 3]!, ay = verts[i0 * 3 + 1]!, az = verts[i0 * 3 + 2]!;
        const bx = verts[i1 * 3]!, by = verts[i1 * 3 + 1]!, bz = verts[i1 * 3 + 2]!;
        const cx = verts[i2 * 3]!, cy = verts[i2 * 3 + 1]!, cz = verts[i2 * 3 + 2]!;
        const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
        const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
        const nx = e1y * e2z - e1z * e2y;
        const ny = e1z * e2x - e1x * e2z;
        const nz = e1x * e2y - e1y * e2x;
        const len = Math.hypot(nx, ny, nz);
        if (len > 0 && ny / len < -1e-3) {
            out[t] = i0; out[t + 1] = i2; out[t + 2] = i1; // reverse winding → +Y
        } else {
            out[t] = i0; out[t + 1] = i1; out[t + 2] = i2;
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// greedyBoxes
// ---------------------------------------------------------------------------

/**
 * Emit ONE axis-aligned collider box per solid (non-noCollider) voxel.
 *
 * A voxel of sizeLevel L spans [gx, gx + 2^L) on each axis in min-cell units, and
 * that is exactly the box we emit. The voxels are already octree-compacted (surface
 * via the compactor, interior via the global-field large-voxel pass), so the box
 * count is bounded by the voxel count — Rapier handles many cuboids fine.
 *
 * This is O(voxels) and allocates nothing per cell. It deliberately does NOT rasterize
 * into a dense occupancy grid the way the old greedy-packing variant did: with large
 * interior voxels a single voxel can span an entire chunk, so a dense grid would be
 * O(min-cell volume) and hang at load time. Per-voxel boxes are slightly more numerous
 * than a globally-merged set, but the compaction already keeps that count low and the
 * cost is linear instead of cubic.
 */
export function greedyBoxes(voxels: SceneVoxel[]): AABB[] {
    const boxes: AABB[] = [];
    for (const vox of voxels) {
        if (vox.noCollider) continue;
        const extent = 1 << vox.sizeLevel; // 2^L cells along each axis
        boxes.push({
            minX: vox.gx, minY: vox.gy, minZ: vox.gz,
            maxX: vox.gx + extent, maxY: vox.gy + extent, maxZ: vox.gz + extent,
        });
    }
    return boxes;
}

/**
 * Structure-of-Arrays variant of {@link greedyBoxes} for the runtime collider
 * path. Reads the decoded voxel columns directly (no per-voxel objects) and
 * emits the SAME one-box-per-solid-voxel AABB list, in the SAME order — a voxel
 * is solid iff bit0 (noCollider) of its `flags` is clear. Equivalent to
 * `greedyBoxes(reconstructObjects(voxels))`.
 */
export function greedyBoxesSoA(voxels: DecodedChunkVoxels): AABB[] {
    const boxes: AABB[] = [];
    const { count, gx, gy, gz, sizeLevel, flags } = voxels;
    for (let i = 0; i < count; i++) {
        if ((flags[i]! & 1) !== 0) continue; // noCollider
        const extent = 1 << sizeLevel[i]!; // 2^L cells along each axis
        const x = gx[i]!, y = gy[i]!, z = gz[i]!;
        boxes.push({
            minX: x, minY: y, minZ: z,
            maxX: x + extent, maxY: y + extent, maxZ: z + extent,
        });
    }
    return boxes;
}

// ---------------------------------------------------------------------------
// clipTrimeshToChunk (Sutherland-Hodgman)
// ---------------------------------------------------------------------------

/**
 * Clip each triangle in `tris` against the 6 planes of `chunk`.
 * Clipped convex polygons are fan-triangulated. Vertices are deduped via a
 * quantized-position hash. World-space coords are preserved as-is.
 */
export function clipTrimeshToChunk(
    tris: Array<{
        v0: [number, number, number];
        v1: [number, number, number];
        v2: [number, number, number];
    }>,
    chunk: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number },
): TrimeshBlob {
    const { minX, minY, minZ, maxX, maxY, maxZ } = chunk;

    const vertsBuf: number[] = [];
    const indicesBuf: number[] = [];

    // Dedupe: snap coords to a small epsilon grid (1e-6) and map to indices.
    const SNAP = 1e-6;
    const snapKey = (x: number, y: number, z: number): string => {
        const sx = Math.round(x / SNAP);
        const sy = Math.round(y / SNAP);
        const sz = Math.round(z / SNAP);
        return `${sx},${sy},${sz}`;
    };
    const vertIndex = new Map<string, number>();

    const addVertex = (x: number, y: number, z: number): number => {
        const key = snapKey(x, y, z);
        const existing = vertIndex.get(key);
        if (existing !== undefined) return existing;
        const idx = vertsBuf.length / 3;
        vertsBuf.push(x, y, z);
        vertIndex.set(key, idx);
        return idx;
    };

    // Scratch arrays for Sutherland-Hodgman (reused per triangle).
    const polyA: number[] = [];
    const polyB: number[] = [];

    for (const tri of tris) {
        polyA.length = 0;
        polyA.push(
            tri.v0[0], tri.v0[1], tri.v0[2],
            tri.v1[0], tri.v1[1], tri.v1[2],
            tri.v2[0], tri.v2[1], tri.v2[2],
        );

        const clipped = clipPolygon(polyA, polyB, minX, minY, minZ, maxX, maxY, maxZ);
        if (clipped.length < 9) continue; // fewer than 3 vertices — degenerate

        // Fan-triangulate: (0, v, v+1) for v = 1 .. vCount-2.
        const vCount = clipped.length / 3;
        const i0 = addVertex(clipped[0]!, clipped[1]!, clipped[2]!);
        for (let vi = 1; vi + 1 < vCount; vi++) {
            const ix = addVertex(clipped[vi * 3]!, clipped[vi * 3 + 1]!, clipped[vi * 3 + 2]!);
            const iy = addVertex(clipped[(vi + 1) * 3]!, clipped[(vi + 1) * 3 + 1]!, clipped[(vi + 1) * 3 + 2]!);
            if (i0 === ix || ix === iy || i0 === iy) continue; // degenerate
            indicesBuf.push(i0, ix, iy);
        }
    }

    return {
        verts: new Float32Array(vertsBuf),
        indices: new Uint32Array(indicesBuf),
    };
}

// ---------------------------------------------------------------------------
// Sutherland-Hodgman internals
// ---------------------------------------------------------------------------

/**
 * Clip a polygon (flat [x,y,z,...] array) against all 6 planes of an AABB.
 * Returns the clipped polygon as a flat array (may be the `src` or `dst`
 * scratch buffer — caller must not mutate it before consuming the result).
 */
function clipPolygon(
    polyA: number[],
    polyB: number[],
    minX: number, minY: number, minZ: number,
    maxX: number, maxY: number, maxZ: number,
): number[] {
    let src = polyA;
    let dst = polyB;

    /**
     * Clip src against one half-plane: axis component >= limit (keepGreater)
     * or <= limit (!keepGreater). Result is written into dst; src/dst are
     * swapped so the next call reads the result.
     * Returns false if the result is empty.
     */
    const clipHalfPlane = (axis: 0 | 1 | 2, limit: number, keepGreater: boolean): boolean => {
        dst.length = 0;
        const n = src.length / 3;
        if (n === 0) return false;

        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            const ax = src[i * 3]!;
            const ay = src[i * 3 + 1]!;
            const az = src[i * 3 + 2]!;
            const bx = src[j * 3]!;
            const by = src[j * 3 + 1]!;
            const bz = src[j * 3 + 2]!;

            const aVal = axis === 0 ? ax : axis === 1 ? ay : az;
            const bVal = axis === 0 ? bx : axis === 1 ? by : bz;
            const aIn = keepGreater ? aVal >= limit : aVal <= limit;
            const bIn = keepGreater ? bVal >= limit : bVal <= limit;

            if (aIn) dst.push(ax, ay, az);
            if (aIn !== bIn) {
                // Edge straddles the plane — emit the intersection point.
                const denom = bVal - aVal;
                const t = denom !== 0 ? (limit - aVal) / denom : 0;
                dst.push(ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t);
            }
        }

        // Swap: dst becomes the new src for the next clip stage.
        const tmp = src;
        src = dst;
        dst = tmp;
        return src.length > 0;
    };

    if (!clipHalfPlane(0, minX, true))  { dst.length = 0; return dst; }
    if (!clipHalfPlane(0, maxX, false)) { dst.length = 0; return dst; }
    if (!clipHalfPlane(1, minY, true))  { dst.length = 0; return dst; }
    if (!clipHalfPlane(1, maxY, false)) { dst.length = 0; return dst; }
    if (!clipHalfPlane(2, minZ, true))  { dst.length = 0; return dst; }
    if (!clipHalfPlane(2, maxZ, false)) { dst.length = 0; return dst; }

    // After the last swap, the result lives in `src`.
    return src;
}
