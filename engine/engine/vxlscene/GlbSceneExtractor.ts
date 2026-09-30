/**
 * GLB→triangles adapter for the scene voxelizer (design §3, entry phase).
 *
 * Thin bridge between the existing GLB extraction
 * (`extractGlbForVoxelization` in `ExtractGlbForVoxelization.ts` — loads the
 * GLB, decodes embedded textures, collects world-space triangles) and the
 * new per-chunk bake pipeline, which consumes `RasterTriangle[]`.
 *
 * It does NOT re-implement any GLB / texture parsing. It maps each extracted
 * `Triangle` to a `RasterTriangle`, wrapping the existing linear-color
 * sampler (`sampleLinearColorAtPoint`) in a per-triangle `sampleColor`
 * closure. The closure samples against the RasterTriangle's OWN current
 * vertex tuples (positions) combined with the source triangle's static
 * UV / material / vertex-color attributes, via the closest-point +
 * barycentric path. That makes it translation-invariant: a caller may
 * scale / center `RasterTriangle.v0/v1/v2` after extraction (the level
 * entry does) and `sampleColor` follows automatically — an affine
 * transform changes only positions, never UVs / material / vertex colors.
 *
 * cm→m auto-scale is DISABLED on this path (`disableCmAutoScale: true`):
 * a level-sized GLB legitimately exceeds 100 units, and the level entry owns
 * the explicit X/Z scaling.
 */

import type { Triangle } from 'engine/GLBVoxelizer.js';
import { extractGlbForVoxelization } from 'engine/ExtractGlbForVoxelization.js';
import { sampleLinearColorAtPoint } from 'engine/GLBVoxelizer.js';
import * as THREE from 'three';
import type { RasterTriangle } from 'engine/vxlscene/SurfaceRasterizer.js';
import type { RGB } from 'engine/vxlscene/SceneVoxTypes.js';

export interface ExtractedScene {
    /** World-space triangles ready for the bake pipeline. */
    triangles: RasterTriangle[];
    /** World AABB of the extracted geometry (pre any level-size transform). */
    bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
    /** Distinct top-level GLB node names seen (Triangle.sourceNodeName). */
    nodeNames: string[];
}

/** Fallback color (mid-grey, linear) when a sample is fully transparent / off-surface. */
const FALLBACK_COLOR: RGB = { r: 0.5, g: 0.5, b: 0.5 };

/**
 * Extract a GLB into `RasterTriangle[]` plus world bounds and node names.
 *
 * The returned `RasterTriangle.v0/v1/v2/normal` tuples are fresh and
 * self-contained: a caller may mutate them (e.g. apply a scale/center
 * transform) and `sampleColor` follows, because the closure reads those
 * same tuples for positions. The source `Triangle` objects are not
 * referenced for geometry after this call.
 */
export async function extractGlbScene(
    glbBuffer: ArrayBuffer,
    opts?: { useSRGB?: boolean },
): Promise<ExtractedScene> {
    const useSRGB = opts?.useSRGB ?? true;

    // Reuse the existing extraction verbatim. minVoxelSize only affects the
    // extractor's internal bounds snapping (which we don't consume here);
    // the scene bake recomputes bounds from the triangles. Keep cm→m
    // auto-scale OFF — levels can legitimately exceed 100 units.
    const extracted = await extractGlbForVoxelization(glbBuffer, {
        minVoxelSize: 1,
        disableCmAutoScale: true,
    });

    const triangles: RasterTriangle[] = [];
    const nodeNameSet = new Set<string>();

    for (const src of extracted.allTriangles) {
        const nodeName = src.sourceNodeName ?? '';
        nodeNameSet.add(nodeName);

        const rt: RasterTriangle = {
            v0: vecToTuple(src.v0),
            v1: vecToTuple(src.v1),
            v2: vecToTuple(src.v2),
            normal: vecToTuple(src.normal),
            nodeName,
            // Filled below — needs `rt` itself so it samples against the
            // tuple positions (which the caller may later transform), with
            // the source triangle's static UV / material / vertex colors.
            sampleColor: () => FALLBACK_COLOR,
        };
        rt.sampleColor = makeSampleColor(rt, src, useSRGB);
        triangles.push(rt);
    }

    const { rawBounds } = extracted;
    const bounds = {
        minX: rawBounds.minX, minY: rawBounds.minY, minZ: rawBounds.minZ,
        maxX: rawBounds.maxX, maxY: rawBounds.maxY, maxZ: rawBounds.maxZ,
    };

    return { triangles, bounds, nodeNames: Array.from(nodeNameSet) };
}

/** Copy a THREE.Vector3 into a fresh `[x, y, z]` tuple. */
function vecToTuple(v: THREE.Vector3): [number, number, number] {
    return [v.x, v.y, v.z];
}

/**
 * Build the per-triangle color closure. On each call it assembles a
 * lightweight `Triangle` from `rt`'s CURRENT tuple positions plus the
 * source triangle's static UV / material / vertex colors, then samples
 * against that single-element list. Reusing `sampleLinearColorAtPoint`
 * (closest-point + barycentric) keeps it translation-invariant — an
 * affine transform of `rt.v0/v1/v2` changes only positions, so the
 * barycentric weight of any surface point is preserved.
 */
function makeSampleColor(
    rt: RasterTriangle,
    src: Triangle,
    useSRGB: boolean,
): (p: [number, number, number]) => RGB {
    const v0 = new THREE.Vector3();
    const v1 = new THREE.Vector3();
    const v2 = new THREE.Vector3();
    const probe: Triangle = {
        v0, v1, v2,
        normal: src.normal,
        material: src.material,
        uv0: src.uv0, uv1: src.uv1, uv2: src.uv2,
        col0: src.col0, col1: src.col1, col2: src.col2,
        sourceNodeName: src.sourceNodeName,
    };
    const single = [probe];
    const scratch = new THREE.Vector3();
    return (p: [number, number, number]): RGB => {
        // Sync the probe's positions to rt's current (possibly transformed) tuples.
        v0.set(rt.v0[0], rt.v0[1], rt.v0[2]);
        v1.set(rt.v1[0], rt.v1[1], rt.v1[2]);
        v2.set(rt.v2[0], rt.v2[1], rt.v2[2]);
        scratch.set(p[0], p[1], p[2]);
        const c = sampleLinearColorAtPoint(scratch, single, useSRGB);
        return c ?? FALLBACK_COLOR;
    };
}
