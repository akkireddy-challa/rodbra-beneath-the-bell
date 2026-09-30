/**
 * VxlWorldVoxelizer — converts a GLB into a chunked VxlScene (`.vwld`) file.
 *
 * Public entry: `voxelizeGLBToVxlWorld(glbBuffer, options)`. The body composes
 * three already-built, separately-tested stages:
 *
 *   1. extractGlbScene  — GLB → world-space `RasterTriangle[]` + bounds + node
 *      names (reuses the shared GLB / texture parsing; cm→m auto-scale OFF).
 *   2. <level transform> — uniformly scale the triangles to fit levelSizeX/Z
 *      (independent Y when levelSizeY given), bottom at Y=0, centered in any
 *      chunk-aligned padding.
 *   3. bakeSceneFromTriangles → encodeVxlScene — per-chunk rasterize → interior
 *      fill → compact → greedy-mesh LODs → trimesh clip, then VxlScene encode.
 *
 * The old per-bucket octree + multi-pass VXL3/VWLD merge pipeline is gone; the
 * new bake derives every coarser LOD as exactly 2× the finer one (design §7),
 * so the previous per-LOD min/max voxel sizes are intentionally unused.
 *
 * The exported `VxlWorldVoxelizeOptions` / `VxlWorldVoxelizeResult` contract is
 * preserved verbatim so `VoxelMessageHandlers.ts` (the sole caller) is
 * untouched. `buildControlsByNode` is exported separately for unit testing —
 * the full GLB round-trip can't run under ts-jest (GLTFLoader is ESM-only), so
 * `extractGlbScene` is imported lazily inside the async body to keep this
 * module's top level (and the helper) free of that dependency.
 */

import { bakeSceneFromTriangles, type BakeOptions } from 'engine/vxlscene/bakeScene.js';
import { createVxlSceneEncoder, type VxlSceneChunk, type VxlSceneHeaderInfo } from 'engine/vxlscene/VxlSceneFormat.js';
import type { RasterTriangle } from 'engine/vxlscene/SurfaceRasterizer.js';
import { validateObjectControls, type ObjectControls } from 'engine/vxlscene/SceneVoxTypes.js';
import type { VxlWorldBounds } from 'engine/VxlWorldFormat.js';
import { bakeGroundMask, type GroundMaskData } from 'engine/vxlscene/GroundMaskBaker.js';
import { groundTypeByte } from 'engine/vxlscene/GroundTypes.js';
import { rgb888ToAtlasCell } from 'engine/vxlscene/atlasColor.js';
import { applyEmissiveByColor } from 'engine/vxlscene/emissiveByColor.js';
import { applyClassByColor } from 'engine/vxlscene/classByColor.js';
import { buildPathCullMask, type PathCullMask, type PathCullPoint, type PathCullSpec } from 'engine/vxlscene/PathCull.js';
import { LOD_VARIANT_DROPS, coarsenChunkForVariant, surfaceStepForDrop } from 'engine/vxlscene/lodVariants.js';

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Path-cull request as it arrives from the caller — the `PathCullSpec` the mask
 * is built from, plus the level settings the `points` were AUTHORED against.
 *
 * The points come off the level's `path` gameplay feature, which is stored in
 * the BAKED WORLD space of the bake that produced it. Change `levelSizeX/Z` (or
 * `chunkSize`) on the re-bake and that space moves, so a verbatim polyline
 * would cull the wrong ground — silently, since nothing downstream can tell a
 * mis-scaled path from a real one. `pointSpace` lets the voxelizer rebuild the
 * OLD transform from the same source bounds, invert it, and re-apply the new
 * one. Omit it when the points are already in this bake's world space.
 */
export interface PathCullOptions extends PathCullSpec {
    pointSpace?: {
        levelSizeX: number;
        levelSizeZ: number;
        levelSizeY?: number;
        chunkSize: number;
    };
}

export interface VxlWorldVoxelizeOptions {
    /** Target world size along X in meters. World is snapped to a chunkSize multiple ≥ this. */
    levelSizeX: number;
    /** Target world size along Z in meters. Snapped same way as X. */
    levelSizeZ: number;
    /**
     * World size along Y. If omitted, uses the uniform X/Z scale on Y too
     * (preserves aspect ratio). Snapped to chunkSize.
     */
    levelSizeY?: number;
    /** Chunk size in meters (default 16). */
    chunkSize?: number;
    /** Min voxel size at LOD 0 (smallest leaf, e.g. 0.05 m). */
    minVoxelSize: number;
    /**
     * Max voxel size at LOD 0. Clamped to chunkSize so leaves never span
     * more than one chunk.
     */
    maxVoxelSize: number;
    /**
     * Optional coarser LODs ordered finest-to-coarsest. `distance` is
     * accepted as a pass-through field so callers can carry the full
     * UI shape through the voxelizer without stripping it. The new bake
     * derives each coarser LOD as exactly 2× the finer one, so the
     * per-LOD `minVoxelSize` / `maxVoxelSize` are NOT consumed — only the
     * COUNT of additional LODs and the per-LOD `distance` matter. The
     * runtime reads `distance` off the persisted asset record.
     */
    additionalLods?: Array<{ minVoxelSize: number; maxVoxelSize: number; distance?: number }>;
    /** Fill interior voids. Default true (matches voxelizeGLB default). */
    fillInterior?: boolean;
    /** Color-space handling for vertex/material colors. Default sRGB-linearise. */
    useSRGB?: boolean;
    /**
     * Per-object LOD-offset overrides keyed by top-level GLB node name
     * (matches `Triangle.sourceNodeName` stamped during extraction).
     * Each value is a power-of-2 exponent applied to the voxel size for
     * that object's triangles: `+1` = 2× voxel size, `-1` = ½× voxel
     * size, etc. Objects not in the map use offset 0.
     */
    objectLodOffsets?: Record<string, number>;
    /**
     * Per-object "pin LOD" flags. Same key space as `objectLodOffsets`.
     * Pinned objects keep finest detail across coarser LODs.
     */
    objectLodPins?: Record<string, true>;
    /**
     * Per-object "trimesh collider" flags. Same key space as the other
     * per-object maps. Tagged objects get their GLB triangles baked into
     * each chunk as a Rapier trimesh collider; their voxel cells are
     * marked "no-collider" so they only render (no double-collision).
     */
    objectTrimeshColliders?: Record<string, true>;
    /**
     * Per-object "no collider" flags. Same key space as the other per-object
     * maps. Tagged objects are purely visual: their voxels/quads are excluded
     * from ALL collision (no voxel, quad, or trimesh collider) so decorative
     * geometry like painted road lines doesn't become a step that vehicles or
     * the player collide with. They still render normally.
     */
    objectNoColliders?: Record<string, true>;
    /**
     * Per-object collision-only flags. Tagged objects contribute their original
     * GLB triangles as named collision trimeshes without producing render voxels.
     * Mutually exclusive with no-collider, trimesh-collider, and displacement.
     */
    objectCollisionOnlyNodes?: Record<string, true>;
    /**
     * Per-object smooth-surface axis. Voxels for that object are displaced
     * along the chosen axis so the cube face nearest the surface lies on
     * the actual surface (smooth driving / walking instead of stair-stepped
     * grid). One axis per object. Missing entries = no displacement.
     */
    objectDisplacementAxes?: Record<string, 'x' | 'y' | 'z'>;
    /**
     * Per-object "library-asset instance" flags (same key space). Tagged
     * objects are EXCLUDED from the level bake entirely — their geometry is
     * placeholder instancing for a library asset that is voxelized
     * separately and placed as environment objects, so the asset can later
     * be replaced (e.g. with a high-quality generated version) without
     * re-baking the level. The level-size transform is computed from the
     * REMAINING (level) geometry only. World Forger GLBs tag these groups
     * via node `extras.bmAssetRef`.
     */
    objectAssetInstances?: Record<string, true>;
    /**
     * Per-object GROUND TYPE names (same key space; values from the
     * `GroundTypes.ts` registry, e.g. 'cobble', 'grassLush'). The tagged
     * objects' level-transformed triangles are rasterized into the world's
     * v6 ground mask, which drives the runtime cobble domes and grass
     * ground cover. Unknown names are ignored (forward compat); missing /
     * empty = no mask section.
     */
    objectGroundTypes?: Record<string, string>;
    /**
     * Bake-time per-color emissive: keys are `#RRGGBB` authored colors, values
     * 1..255 strength. Matched EXACTLY (RGB444 cell equality, no tolerance —
     * see `emissiveByColor.ts`) against the colors this bake actually produces
     * and written into the v7 world-level emissive palette (`VxlSceneFormat.ts`).
     * Keys with no matching color are reported in the result's
     * `emissiveUnmatched` (a bake note, not an error). Missing/empty = no
     * emissive palette section.
     */
    emissiveByColor?: Record<string, number>;
    /**
     * Bake-time per-color MATERIAL CLASSES: keys are `#RRGGBB` authored colors,
     * values names from the `VoxelMaterialClass` vocabulary ('stone', 'wood',
     * 'metal', …). Matched against the colors this bake actually produces with a
     * ±1-per-RGB444-channel tolerance (build-time jitter spreads an authored
     * colour across neighbouring cells — see `classByColor.ts`), budget-capped,
     * and written into the v9 world-level class section (`VxlSceneFormat.ts`).
     * Unmatched keys land in `materialUnmatched`; collapse decisions in
     * `materialNotes`. Missing/empty = no class section (v7/v8 output).
     */
    materialByColor?: Record<string, string>;
    /**
     * Trim the world to a corridor around the level's designed path (see
     * `vxlscene/PathCull.ts`). Voxels whose world XZ centre lies farther than
     * `distanceM` from the path polyline are dropped — on both sides, or (for a
     * closed circuit) only outside the loop, so the infield survives.
     *
     * Non-destructive: this filters the BAKE, never the source GLB, so raising
     * the distance or dropping the option is just another re-voxelize.
     */
    pathCull?: PathCullOptions;
    /** Progress callback fired once per chunk after the bake completes. */
    onProgress?: (info: { chunkIndex: number; totalChunks: number; nonEmptyChunks: number; label: string }) => void;
    /** Optional per-chunk phase profiler (forwarded to the bake). For benchmarking. */
    profile?: BakeOptions['profile'];
}

export interface VxlWorldVoxelizeResult {
    /** Encoded VxlScene (.vwld) bytes — ready to upload / save. */
    vwldBytes: Uint8Array;
    /**
     * Coarser variants of the same bake, keyed by how many finest quad LOD levels each
     * dropped (see `LOD_VARIANT_DROPS`). Published alongside the full file so a phone can
     * fetch the detail it will actually draw instead of downloading everything and
     * shedding most of it. Composed from THIS bake, so they cannot disagree with it.
     */
    lodVariants: Array<{ drop: number; bytes: Uint8Array }>;
    /** Final chunk-aligned world bounds. */
    worldBounds: VxlWorldBounds;
    /** Chunk size in meters that the world was built with. */
    chunkSize: number;
    /** Number of non-empty chunks (index entries in the file). */
    nonEmptyChunkCount: number;
    /** Total LOD-0 voxel count summed across all chunks. */
    totalLod0Leaves: number;
    /** Total trimesh-collider triangles baked across all chunks (0 when no object opted in). */
    totalTrimeshTriangles: number;
    /** Total bytes of trimesh data across all chunks (approximate; 0 when none). */
    totalTrimeshBytes: number;
    /**
     * Per-object voxel count. The new bake does not yet attribute voxels to
     * source objects, so this is an empty map for now. Display-only (the
     * re-voxelize dialog shows it). TODO: attribute per object once the
     * per-chunk rasterizer carries source-object tags into compaction.
     */
    perObjectVoxelCounts: Record<string, number>;
    /**
     * `emissiveByColor` keys (see `VxlWorldVoxelizeOptions`) that never matched a
     * color this bake produced — a bake note, not an error. Empty when
     * `emissiveByColor` was absent/empty or every key matched.
     */
    emissiveUnmatched: string[];
    /**
     * `materialByColor` keys that never matched a color this bake produced — a bake
     * note, not an error. Empty when the option was absent/empty or every key matched.
     */
    materialUnmatched: string[];
    /**
     * Human-readable notes from the class resolution (budget collapses, unknown
     * class names). Empty when nothing noteworthy happened.
     */
    materialNotes: string[];
    /** First warning encountered during the bake, if any. */
    warning?: string;
}

const DEFAULT_CHUNK_SIZE = 16;
/** Default activation distance for a coarser LOD when the caller omits one. */
const DEFAULT_LOD_DISTANCE = 60;

// ─── Option mapping (pure, unit-tested) ────────────────────────────────────

/**
 * Union the sparse per-object option maps into a dense
 * `Record<nodeName, ObjectControls>`. Every node appearing in ANY map gets
 * a fully-populated `ObjectControls`; per field the value comes from its map
 * or the type's default (lodOffset 0, not pinned, no trimesh collider, no
 * displacement axis). Nodes absent from all maps are simply omitted — the
 * rasterizer treats a missing key as `DEFAULT_OBJECT_CONTROLS`.
 *
 * Exported (and pure — no GLB dependency) so it can be unit-tested without
 * loading the ESM-only GLB parser.
 */
export function buildControlsByNode(options: VxlWorldVoxelizeOptions): Record<string, ObjectControls> {
    const offsets = options.objectLodOffsets ?? {};
    const pins = options.objectLodPins ?? {};
    const trimesh = options.objectTrimeshColliders ?? {};
    const noColliders = options.objectNoColliders ?? {};
    const collisionOnly = options.objectCollisionOnlyNodes ?? {};
    const axes = options.objectDisplacementAxes ?? {};

    const names = new Set<string>([
        ...Object.keys(offsets),
        ...Object.keys(pins),
        ...Object.keys(trimesh),
        ...Object.keys(noColliders),
        ...Object.keys(collisionOnly),
        ...Object.keys(axes),
    ]);

    const out: Record<string, ObjectControls> = {};
    for (const n of names) {
        out[n] = {
            lodOffset: offsets[n] ?? 0,
            pinned: pins[n] === true,
            trimeshCollider: trimesh[n] === true,
            noCollider: noColliders[n] === true,
            collisionOnly: collisionOnly[n] === true,
            displacementAxis: axes[n] ?? null,
        };
        validateObjectControls(n, out[n]);
    }
    return out;
}

/**
 * Drop triangles belonging to library-asset instance groups
 * (`objectAssetInstances`) and recompute the source bounds over the
 * remaining LEVEL geometry, snapped outward to the 1 m grid exactly like
 * extraction snaps its raw bounds. The level-size transform must be defined
 * by the level geometry alone — decoration instances are placed separately
 * and must not stretch or shift the world.
 *
 * Pure and exported for unit tests (no GLB dependency).
 */
export function dropAssetInstanceTriangles(
    triangles: RasterTriangle[],
    bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number },
    objectAssetInstances: Record<string, true> | undefined,
): {
    triangles: RasterTriangle[];
    bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
} {
    if (!objectAssetInstances || Object.keys(objectAssetInstances).length === 0) {
        return { triangles, bounds };
    }
    const kept = triangles.filter((t) => objectAssetInstances[t.nodeName] !== true);
    if (kept.length === triangles.length) return { triangles, bounds };
    if (kept.length === 0) {
        throw new Error('All objects are tagged as asset instances — no level geometry left to bake');
    }
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const t of kept) {
        for (const v of [t.v0, t.v1, t.v2]) {
            if (v[0] < minX) minX = v[0];
            if (v[1] < minY) minY = v[1];
            if (v[2] < minZ) minZ = v[2];
            if (v[0] > maxX) maxX = v[0];
            if (v[1] > maxY) maxY = v[1];
            if (v[2] > maxZ) maxZ = v[2];
        }
    }
    return {
        triangles: kept,
        bounds: {
            minX: Math.floor(minX), minY: Math.floor(minY), minZ: Math.floor(minZ),
            maxX: Math.ceil(maxX), maxY: Math.ceil(maxY), maxZ: Math.ceil(maxZ),
        },
    };
}

/**
 * Bake runtime-visible ground detail from rendered geometry only. Collision-only
 * nodes still flow to the scene bake for named trimeshes, but must not seed any
 * visual side channel.
 */
export function bakeVisibleGroundMask(
    triangles: readonly RasterTriangle[],
    typeByNode: Record<string, number>,
    bounds: VxlWorldBounds,
    objectCollisionOnlyNodes: Record<string, true> | undefined,
): GroundMaskData | null {
    const visibleTriangles = objectCollisionOnlyNodes === undefined
        ? triangles
        : triangles.filter((triangle) => objectCollisionOnlyNodes[triangle.nodeName] !== true);
    return bakeGroundMask(visibleTriangles, typeByNode, bounds);
}

// ─── Voxel-size snapping (pure) ────────────────────────────────────────────

/**
 * Snap `minVoxelSize` / `maxVoxelSize` so the bake's power-of-two invariant
 * holds: `chunkSize / minVoxelSize` is a power-of-two integer and
 * `maxVoxelSize = minVoxelSize · 2^k ≤ chunkSize`.
 *
 * minVoxelSize is rounded to the nearest `chunkSize / 2^n` (n ≥ 0); then
 * maxVoxelSize is rounded down to the nearest `minVoxelSize · 2^k` not
 * exceeding chunkSize and not below minVoxelSize.
 */
function snapVoxelSizes(
    chunkSize: number,
    minVoxelSize: number,
    maxVoxelSize: number,
): { minVoxelSize: number; maxVoxelSize: number } {
    // Pick the power-of-two cells-per-axis closest (in log space) to the
    // requested chunkSize/minVoxelSize ratio, with at least 1 cell.
    const requestedCells = Math.max(1, chunkSize / minVoxelSize);
    const cellExp = Math.max(0, Math.round(Math.log2(requestedCells)));
    const cellsPerAxis = 1 << cellExp;
    const snappedMin = chunkSize / cellsPerAxis;

    // maxVoxelSize = snappedMin · 2^k, clamped to [snappedMin, chunkSize].
    const cappedMax = Math.min(maxVoxelSize, chunkSize);
    const kRaw = Math.max(0, Math.floor(Math.log2(Math.max(1, cappedMax / snappedMin))));
    let snappedMax = snappedMin * (1 << kRaw);
    if (snappedMax > chunkSize) snappedMax = chunkSize; // never exceed one chunk
    if (snappedMax < snappedMin) snappedMax = snappedMin;
    return { minVoxelSize: snappedMin, maxVoxelSize: snappedMax };
}

// ─── Level-size transform (pure) ───────────────────────────────────────────

/**
 * The affine that maps SOURCE (GLB) space into the baked level's world space,
 * plus the chunk-aligned world bounds it lands in. Split out from
 * `applyLevelSizeTransform` because the path cull needs to run the SAME map on
 * a polyline that was authored against a previous bake of this GLB.
 */
export interface LevelSizeTransform {
    /** Uniform scale applied to X and Z. */
    scaleXZ: number;
    /** Y scale — equal to `scaleXZ` unless an explicit `levelSizeY` was given. */
    scaleY: number;
    translateX: number;
    translateY: number;
    translateZ: number;
    /** Chunk-aligned world bounds, min corner at the origin. */
    bounds: VxlWorldBounds;
}

/**
 * Derive the level-size transform: uniformly scale the source footprint to fit
 * `levelSizeX × levelSizeZ`, snap the world bounds up to chunk multiples, and
 * center the scaled geometry inside any padding. Bottom sits at Y=0 (no
 * vertical centering — preserves ground placement). Y scales independently when
 * `levelSizeY` is given, else by the uniform X/Z factor (aspect-preserving).
 *
 * Pure and exported for unit tests — it is a function of the source bounds and
 * the level settings alone, which is what lets a re-bake reproduce (and invert)
 * an earlier bake's mapping.
 */
export function computeLevelSizeTransform(
    srcBounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number },
    levelSizeX: number,
    levelSizeZ: number,
    levelSizeY: number | undefined,
    chunkSize: number,
): LevelSizeTransform {
    const glbW = srcBounds.maxX - srcBounds.minX;
    const glbD = srcBounds.maxZ - srcBounds.minZ;
    const glbH = srcBounds.maxY - srcBounds.minY;
    if (glbW <= 0 || glbD <= 0) throw new Error('GLB has zero footprint on X or Z');

    // Uniform scale = whichever of X / Z is the tighter constraint.
    const scaleX = levelSizeX / glbW;
    const scaleZ = levelSizeZ / glbD;
    const uniformScale = Math.min(scaleX, scaleZ);
    const scaledX = glbW * uniformScale;
    const scaledZ = glbD * uniformScale;
    const scaleY = levelSizeY !== undefined && glbH > 0 ? levelSizeY / glbH : uniformScale;
    const scaledY = glbH * scaleY;

    // World bounds: snap each axis UP to a chunkSize multiple, never crop.
    const worldExtentX = Math.max(levelSizeX, Math.ceil(scaledX / chunkSize) * chunkSize);
    const worldExtentZ = Math.max(levelSizeZ, Math.ceil(scaledZ / chunkSize) * chunkSize);
    const worldExtentY = Math.max(chunkSize, Math.ceil(scaledY / chunkSize) * chunkSize);

    // Center the scaled geometry inside any padding; bottom at world Y=0.
    const padX = (worldExtentX - scaledX) / 2;
    const padZ = (worldExtentZ - scaledZ) / 2;
    const translateX = padX - srcBounds.minX * uniformScale;
    const translateY = -srcBounds.minY * scaleY;
    const translateZ = padZ - srcBounds.minZ * uniformScale;

    return {
        scaleXZ: uniformScale,
        scaleY,
        translateX, translateY, translateZ,
        bounds: {
            minX: 0, minY: 0, minZ: 0,
            maxX: worldExtentX, maxY: worldExtentY, maxZ: worldExtentZ,
        },
    };
}

/**
 * Apply `computeLevelSizeTransform`'s affine to the triangles in place
 * (`v0/v1/v2`, plus `normal` when the Y scale differs from the uniform one).
 */
function applyLevelSizeTransform(tris: RasterTriangle[], xf: LevelSizeTransform): void {
    const { scaleXZ: uniformScale, scaleY, translateX, translateY, translateZ } = xf;
    const nonUniformY = Math.abs(scaleY - uniformScale) > 1e-9;
    for (const t of tris) {
        applyAffine(t.v0, uniformScale, scaleY, uniformScale, translateX, translateY, translateZ);
        applyAffine(t.v1, uniformScale, scaleY, uniformScale, translateX, translateY, translateZ);
        applyAffine(t.v2, uniformScale, scaleY, uniformScale, translateX, translateY, translateZ);
        if (nonUniformY) {
            // Non-uniform scale transforms a normal by the inverse-transpose
            // of the linear part; for a diagonal scale (sx, sy, sz) that is
            // (1/sx, 1/sy, 1/sz). With sx = sz = uniformScale that reduces to
            // the components below, then re-normalize.
            const nx = t.normal[0] / uniformScale;
            const ny = t.normal[1] / scaleY;
            const nz = t.normal[2] / uniformScale;
            const len = Math.hypot(nx, ny, nz) || 1;
            t.normal[0] = nx / len;
            t.normal[1] = ny / len;
            t.normal[2] = nz / len;
        }
    }
}

// ─── Path cull (pure helpers) ─────────────────────────────────────────────

/**
 * Re-express path points authored against ONE level-size transform in the
 * space of another. Both transforms derive from the same source bounds, so the
 * round-trip is exact: undo the authoring scale/translate to get back to source
 * (GLB) space, then apply this bake's. Returns the points unchanged when the two
 * transforms agree (the common case — a re-bake at the same level size).
 *
 * Pure and exported for unit tests.
 */
export function remapPathPoints(
    points: readonly PathCullPoint[],
    from: LevelSizeTransform,
    to: LevelSizeTransform,
): PathCullPoint[] {
    const sameXZ = Math.abs(from.scaleXZ - to.scaleXZ) < 1e-9
        && Math.abs(from.translateX - to.translateX) < 1e-9
        && Math.abs(from.translateZ - to.translateZ) < 1e-9;
    if (sameXZ) return points.map((p) => ({ x: p.x, z: p.z }));
    return points.map((p) => ({
        x: ((p.x - from.translateX) / from.scaleXZ) * to.scaleXZ + to.translateX,
        z: ((p.z - from.translateZ) / from.scaleXZ) * to.scaleXZ + to.translateZ,
    }));
}

/**
 * Blank every ground-mask cell the cull removed. The mask drives runtime grass
 * and cobble detail off a 2D grid that knows nothing about the voxels under it,
 * so leaving it intact would keep asking for ground cover over ground that is
 * no longer there. Mutates `mask` in place.
 */
export function cullGroundMask(mask: GroundMaskData, bounds: VxlWorldBounds, cull: PathCullMask): void {
    for (let cz = 0; cz < mask.height; cz++) {
        const z = bounds.minZ + (cz + 0.5) * mask.cellSize;
        const rowBase = cz * mask.width;
        for (let cx = 0; cx < mask.width; cx++) {
            const i = rowBase + cx;
            if (mask.types[i] === 0) continue;
            if (cull.keeps(bounds.minX + (cx + 0.5) * mask.cellSize, z)) continue;
            mask.types[i] = 0;
            mask.topY[i] = 0;
        }
    }
}

/** In-place affine on a `[x, y, z]` tuple: scale then translate. */
function applyAffine(
    v: [number, number, number],
    sx: number, sy: number, sz: number,
    tx: number, ty: number, tz: number,
): void {
    v[0] = v[0] * sx + tx;
    v[1] = v[1] * sy + ty;
    v[2] = v[2] * sz + tz;
}

// ─── emissiveByColor support (pure-ish; the Set is the only mutation) ──────

/** Object-color channel (0..1) → 0..255, matching `VxlSceneFormat.ts`'s own `toR8`. */
function toR8(v: number): number {
    return Math.max(0, Math.min(255, Math.round(v * 255)));
}

/**
 * Add every RGB444 cell a chunk's colors quantize to into `into` — the SAME
 * `rgb888ToAtlasCell` quantization `VxlSceneFormat.ts`'s `chunkToColumns`
 * applies to these same fields when it registers the encoder's palette. Only
 * `voxels` + `lodHints` carry colors (`namedTrimeshes` are geometry-only).
 *
 * Called on the identical (disp-filtered) chunk object handed to
 * `encoder.addChunk`, so the accumulated set is a close match for the file's
 * FINAL palette — the one inaccuracy is the v5 surface-tile reduction, which
 * keeps only the topmost displaced voxel per (gx,gz) column and silently
 * drops the others (see `chunkToColumns`'s `surfCol` map); a shadowed voxel's
 * color that never reaches the tile can end up in `into` without ever
 * reaching the real file palette. Harmless for the actual bake (the real
 * palette lookup happens independently, keyed by cell, inside
 * `VxlSceneFormat.ts`'s `finish()`), it only means `emissiveUnmatched` could
 * rarely under-report — acceptable for a bake note.
 *
 * Pure and exported for unit tests (no GLB dependency) — same pattern as
 * `buildControlsByNode` / `dropAssetInstanceTriangles` above.
 */
export function collectChunkCells(chunk: VxlSceneChunk, into: Map<number, number>): void {
    // A COUNTING map rather than a Set: the value is how many voxels/quads carry the
    // cell, which is the coverage weight `applyClassByColor`'s budget collapse ranks
    // by (the emissive path only reads the keys).
    const bump = (cell: number): void => { into.set(cell, (into.get(cell) ?? 0) + 1); };
    for (const v of chunk.voxels) bump(rgb888ToAtlasCell(toR8(v.color.r), toR8(v.color.g), toR8(v.color.b)));
    for (const level of chunk.lodHints) {
        for (const q of level) bump(rgb888ToAtlasCell(toR8(q.color.r), toR8(q.color.g), toR8(q.color.b)));
    }
}

// ─── Driver ──────────────────────────────────────────────────────────────

export async function voxelizeGLBToVxlWorld(
    glbBuffer: ArrayBuffer,
    options: VxlWorldVoxelizeOptions,
): Promise<VxlWorldVoxelizeResult> {
    const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    if (!(chunkSize > 0) || !isFinite(chunkSize)) {
        throw new Error(`Invalid chunkSize: ${chunkSize}`);
    }
    if (options.maxVoxelSize < options.minVoxelSize) {
        throw new Error('maxVoxelSize must be >= minVoxelSize');
    }
    const useSRGB = options.useSRGB ?? true;

    // 1. Snap voxel sizes to the bake's power-of-two grid invariant.
    const { minVoxelSize, maxVoxelSize } = snapVoxelSizes(
        chunkSize, options.minVoxelSize, options.maxVoxelSize,
    );

    // 2. Per-object controls (union of the sparse maps).
    const controlsByNode = buildControlsByNode(options);

    // 3. Extract triangles. extractGlbScene transitively imports the ESM-only
    //    GLTFLoader, so load it lazily here — top-level import would break the
    //    pure-helper unit test under ts-jest.
    const { extractGlbScene } = await import('engine/vxlscene/GlbSceneExtractor.js');
    const scene = await extractGlbScene(glbBuffer, { useSRGB });

    // 3b. Library-asset instance groups are placeholders, not level geometry:
    //     drop them and re-derive the source bounds from what remains BEFORE
    //     the level transform, so decorations never stretch/shift the world.
    const levelScene = dropAssetInstanceTriangles(
        scene.triangles,
        scene.bounds,
        options.objectAssetInstances,
    );

    // 4. Scale / center the triangles into the requested level bounds.
    const transform = computeLevelSizeTransform(
        levelScene.bounds,
        options.levelSizeX,
        options.levelSizeZ,
        options.levelSizeY,
        chunkSize,
    );
    applyLevelSizeTransform(levelScene.triangles, transform);
    const bounds = transform.bounds;

    // 4a. Path cull: build the keep-region in THIS bake's world space. The
    //     caller's points may have been authored against a different level size
    //     (the settings dialog lets both change in one go), so they go through
    //     the same source-space round-trip the triangles just took.
    let pathCull: PathCullMask | undefined;
    if (options.pathCull) {
        const spec = options.pathCull;
        const authoredSpace = spec.pointSpace
            ? computeLevelSizeTransform(
                levelScene.bounds,
                spec.pointSpace.levelSizeX,
                spec.pointSpace.levelSizeZ,
                spec.pointSpace.levelSizeY,
                spec.pointSpace.chunkSize,
            )
            : transform;
        pathCull = buildPathCullMask(
            { ...spec, points: remapPathPoints(spec.points, authoredSpace, transform) },
            bounds,
        );
        console.log(
            `[VxlWorldVoxelizer] path cull: ${pathCull.segmentCount} segments, ` +
            `keep ${spec.distanceM} m, mode=${pathCull.mode}`,
        );
    }

    // 4b. Ground mask: rasterize the ground-typed objects' (now level-space)
    //     triangles into the v6 mask. Best-effort — a mask failure must never
    //     abort the bake (the level just ships without runtime ground detail).
    let groundMask: GroundMaskData | null = null;
    if (options.objectGroundTypes && Object.keys(options.objectGroundTypes).length > 0) {
        try {
            const typeByNode: Record<string, number> = {};
            for (const [node, name] of Object.entries(options.objectGroundTypes)) {
                const byte = groundTypeByte(name);
                if (byte !== 0) typeByNode[node] = byte;
            }
            groundMask = bakeVisibleGroundMask(
                levelScene.triangles,
                typeByNode,
                bounds,
                options.objectCollisionOnlyNodes,
            );
            if (groundMask && pathCull) cullGroundMask(groundMask, bounds, pathCull);
        } catch (err) {
            console.warn('[VxlWorldVoxelizer] ground-mask bake failed — continuing without it:', err);
        }
    }

    // 5. Additional-LOD count + per-LOD activation distances. LOD0's distance
    //    is the first additional-LOD distance (or a default); each coarser LOD
    //    uses its own `distance` (or the default). No additional LODs → a
    //    single very-large LOD0 distance so it never deactivates.
    //
    //    The bake halves cells-per-axis once per coarser LOD and requires
    //    cellsPerAxis >= 2^additionalLods (local coords must stay integer), so
    //    clamp the requested count to log2(cellsPerAxis). Reachable from the UI
    //    (e.g. chunkSize 8 + minVoxelSize 1 → 8 cells → max 3 LODs); without
    //    the clamp those combinations would throw inside the bake.
    const maxAdditionalLods = Math.max(0, Math.round(Math.log2(chunkSize / minVoxelSize)));
    const additionalLodsInput = (options.additionalLods ?? []).slice(0, maxAdditionalLods);
    const additionalLods = additionalLodsInput.length;
    let lodDistances: number[];
    if (additionalLods === 0) {
        lodDistances = [1e9];
    } else {
        // One entry per LOD level, kept PARALLEL to the LOD pyramid (the skip-LOD load
        // guard shifts it in step) and STRICTLY INCREASING. lodDistances[i] is the max
        // distance LOD i renders before the next coarser LOD takes over, i.e. the
        // activation distance of additional-LOD i (= overall LOD i+1). The coarsest LOD
        // never deactivates, so its entry is effectively infinite. (Previous bug: it
        // PREPENDED additionalLodsInput[0].distance, duplicating the first threshold — so
        // pickLod skipped LOD1 and jumped two levels at once, a 4× voxel-size step.)
        lodDistances = [
            ...additionalLodsInput.map(l => l.distance ?? DEFAULT_LOD_DISTANCE),
            1e9,
        ];
    }

    // 6. Stream-encode while baking. The bake runs IN THE BROWSER iframe; accumulating
    //    every chunk's voxels + greedy quads as JS objects before encoding OOMs the
    //    renderer on large worlds (tens of millions of objects at 1024 m / 0.0625 m).
    //    Each chunk is reduced to compact typed-array columns the instant it is baked
    //    (objects dropped), and the raw v4 columnar blobs are assembled at finish.
    //    `compression: 'none'` keeps the chunk blobs RAW so the at-rest/transport gzip
    //    (Content-Encoding, applied once at upload) compresses the whole container —
    //    a single coherent gzip beats the old per-chunk gzip ~3× on the wire and lets
    //    the runtime decode with zero per-chunk gunzips.
    const header: VxlSceneHeaderInfo = { chunkSize, minVoxelSize, bounds, lodDistances, groundMask };
    const encoder = createVxlSceneEncoder(header, { compression: 'none' });
    // One encoder per published variant, fed from the SAME chunk stream. A second pass
    // would mean baking the world again; a second bake would mean two voxelizations that
    // can differ. They share `header` by reference, so the emissive palette resolved after
    // the bake reaches all of them.
    // Each variant gets its OWN header: it declares a different `surfaceStep`, and the
    // encoder reads the header at finish(), so a shared object would give every variant
    // the last step written. The emissive palette resolved after the bake is applied to
    // all of them below for the same reason.
    const variantEncoders = LOD_VARIANT_DROPS.map((drop) => {
        const variantHeader: VxlSceneHeaderInfo = { ...header, surfaceStep: surfaceStepForDrop(drop) };
        return { drop, header: variantHeader, encoder: createVxlSceneEncoder(variantHeader, { compression: 'none' }) };
    });
    // Cells per chunk axis — surface decimation aligns on GLOBAL cells, so it needs the
    // chunk origin in cell units to convert a chunk-local column coordinate.
    const cellsPerChunk = Math.round(chunkSize / minVoxelSize);
    // emissiveByColor / materialByColor: collect every RGB444 cell the bake actually
    // produces, with a per-cell coverage count (bounded — RGB444 has only 4096 possible
    // values) so both post-bake resolutions run without a second decode pass over a
    // potentially huge world (see `collectChunkCells`).
    const wantsCellScan =
        (options.emissiveByColor !== undefined && Object.keys(options.emissiveByColor).length > 0)
        || (options.materialByColor !== undefined && Object.keys(options.materialByColor).length > 0);
    const seenCells = wantsCellScan ? new Map<number, number>() : null;
    const bakeOpts: BakeOptions = {
        chunkSize,
        minVoxelSize,
        maxVoxelSize,
        additionalLods,
        lodDistances,
        fillInterior: options.fillInterior ?? true,
        controlsByNode,
        bounds,
        pathCull,
        onProgress: options.onProgress,
        profile: options.profile,
        // Drop non-displaced voxels at the bake→encode boundary: they are fully redundant at
        // runtime (surfaces render from the greedy-mesh LOD quads; colliders come from the
        // trimesh + LOD0 quads, never per-voxel). The DISPLACED (smooth:y) voxels that remain are
        // turned into a compact per-chunk surface tile by the v5 encoder (chunkToColumns) — one
        // topmost height per column — so the heavy per-cell displaced shell never reaches the file.
        onChunkBaked: async (chunk) => {
            const filtered = { ...chunk, voxels: chunk.voxels.filter(v => v.disp !== null) };
            if (seenCells) collectChunkCells(filtered, seenCells);
            await encoder.addChunk(filtered);
            for (const v of variantEncoders) {
                await v.encoder.addChunk(coarsenChunkForVariant(filtered, v.drop, cellsPerChunk));
            }
        },
    };
    const world = await bakeSceneFromTriangles(levelScene.triangles, bakeOpts);

    // emissiveByColor resolution: `header` is captured by reference inside `encoder`
    // (read at `finish()`, not at creation), so setting `header.emissiveByCell` here —
    // AFTER the bake, once `seenCells` holds every color this bake produced — still
    // reaches the v7 encode step below.
    let emissiveUnmatched: string[] = [];
    if (seenCells && options.emissiveByColor) {
        const paletteCells = [...seenCells.keys()];
        const { emissive, unmatched } = applyEmissiveByColor(paletteCells, options.emissiveByColor);
        emissiveUnmatched = unmatched;
        const cellMap = new Map<number, number>();
        for (let i = 0; i < paletteCells.length; i++) {
            if (emissive[i]! > 0) cellMap.set(paletteCells[i]!, emissive[i]!);
        }
        if (cellMap.size > 0) {
            header.emissiveByCell = cellMap;
            for (const v of variantEncoders) v.header.emissiveByCell = cellMap;
        }
    }

    // materialByColor resolution — same timing and same header-by-reference trick as
    // the emissive block above; `seenCells`' counts are the coverage the budget
    // collapse ranks by (`classByColor.ts`).
    let materialUnmatched: string[] = [];
    let materialNotes: string[] = [];
    if (seenCells && options.materialByColor && Object.keys(options.materialByColor).length > 0) {
        const paletteCells = [...seenCells.keys()];
        const coverage = paletteCells.map((cell) => seenCells.get(cell)!);
        const resolved = applyClassByColor(paletteCells, coverage, options.materialByColor);
        materialUnmatched = resolved.unmatched;
        materialNotes = resolved.notes;
        if (resolved.classNames.length > 0) {
            const cellMap = new Map<number, string>();
            const cellsPerClass = new Array<number>(resolved.classNames.length).fill(0);
            for (let i = 0; i < paletteCells.length; i++) {
                const idx = resolved.classIdxByPaletteEntry[i]!;
                if (idx === 0) continue;
                cellMap.set(paletteCells[i]!, resolved.classNames[idx - 1]!);
                cellsPerClass[idx - 1]! += 1;
            }
            header.materialClassByCell = cellMap;
            for (const v of variantEncoders) v.header.materialClassByCell = cellMap;
            console.log(
                '[VxlWorldVoxelizer] material classes: '
                + resolved.classNames.map((c, i) => `${c}(${cellsPerClass[i]} cells)`).join(', '),
            );
        }
        for (const note of materialNotes) console.log(`[VxlWorldVoxelizer] material classes: ${note}`);
    }

    const vwldBytes = await encoder.finish();
    const lodVariants: Array<{ drop: number; bytes: Uint8Array }> = [];
    for (const v of variantEncoders) lodVariants.push({ drop: v.drop, bytes: await v.encoder.finish() });

    // 7. Result stats come from the bake's accumulated totals — the streaming bake
    //    leaves `world.chunks` empty (every chunk was streamed out), so we MUST NOT
    //    iterate it. `totals` is always populated by bakeSceneFromTriangles.
    const totals = world.totals ?? {
        nonEmptyChunkCount: 0, totalVoxels: 0, totalLod0Quads: 0, totalTrimeshTris: 0, totalTrimeshBytes: 0,
        chunksByOffset: {}, voxelsByOffset: {},
    };

    return {
        vwldBytes,
        lodVariants,
        worldBounds: world.bounds,
        chunkSize,
        nonEmptyChunkCount: totals.nonEmptyChunkCount,
        totalLod0Leaves: totals.totalVoxels,
        totalTrimeshTriangles: totals.totalTrimeshTris,
        totalTrimeshBytes: totals.totalTrimeshBytes,
        // TODO: the new bake doesn't attribute voxels per source object yet;
        // surfaced display-only in the re-voxelize dialog. Empty for now.
        perObjectVoxelCounts: {},
        emissiveUnmatched,
        materialUnmatched,
        materialNotes,
    };
}
