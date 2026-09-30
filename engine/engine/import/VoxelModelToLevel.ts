/**
 * CompiledVoxelModel → baked .vwld level bytes.
 *
 * Reuses the vxlscene building blocks the GLB level bake uses — greedyMesh for
 * LOD0 + coarser LODs (via the shared average-color downsampleGrid), quads
 * localized with localizeChunkResQuads, streamed through createVxlSceneEncoder.
 * There is no rasterizer and no compact() pass: the source is already voxels,
 * every cell is grid-aligned (no displacement), so chunks carry geometry as
 * greedy quads only (`voxels: []` — the exact shape the GLB path emits for
 * non-displaced cells; runtime colliders derive from LOD0 quads).
 *
 * Placement: the model is centered on the XZ origin in whole cells, ground at
 * Y = 0, and world bounds snap outward to whole chunks — mirroring the GLB
 * level transform's centering.
 */
import type { CellAttr, SceneQuad } from 'engine/vxlscene/SceneVoxTypes.js';
import { packCell, unpackCell } from 'engine/vxlscene/SurfaceRasterizer.js';
import { greedyMesh } from 'engine/vxlscene/GreedyMesher.js';
import { downsampleGrid, localizeChunkResQuads, log2Int } from 'engine/vxlscene/bakeScene.js';
import { createVxlSceneEncoder } from 'engine/vxlscene/VxlSceneFormat.js';
import { srgbByteToLinear } from 'engine/import/VoxelModelToAsset.js';
import type { CompiledVoxelModel } from 'engine/import/VoxelModelCompiler.js';

export interface VoxelLevelImportOptions {
    /** Edge length of one source voxel, meters. chunkSize/voxelSize must be a power of two. */
    voxelSize: number;
    /** Chunk size in meters. */
    chunkSize: number;
    /** Coarser LODs (2x each) with activation distances. */
    additionalLods: Array<{ distance?: number }>;
    /** Optional per-chunk progress callback. */
    onProgress?: (info: { chunkIndex: number; totalChunks: number; label: string }) => void;
}

export const DEFAULT_VOXEL_LEVEL_IMPORT_OPTIONS: VoxelLevelImportOptions = {
    voxelSize: 0.5,
    chunkSize: 16,
    additionalLods: [{ distance: 60 }, { distance: 120 }],
};

export interface VoxelLevelImportResult {
    vwldBytes: Uint8Array;
    worldBounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
    chunkSize: number;
    nonEmptyChunkCount: number;
    totalLod0Cells: number;
}

const DEFAULT_LOD_DISTANCE = 60;

export async function compileVoxelModelToVwld(
    model: CompiledVoxelModel,
    options: VoxelLevelImportOptions,
): Promise<VoxelLevelImportResult> {
    const { voxelSize: vs, chunkSize } = options;
    const cellsPerAxis = chunkSize / vs;
    if (!Number.isInteger(cellsPerAxis) || cellsPerAxis < 1 || (cellsPerAxis & (cellsPerAxis - 1)) !== 0) {
        throw new Error(`chunkSize / voxelSize must be a power-of-two integer (got ${chunkSize} / ${vs})`);
    }
    if (model.cells.size === 0) throw new Error('Model contains no solid voxels');

    const maxAdditional = log2Int(cellsPerAxis);
    const lodsInput = options.additionalLods.slice(0, maxAdditional);
    const lodDistances = lodsInput.length === 0
        ? [1e9]
        : [...lodsInput.map(l => l.distance ?? DEFAULT_LOD_DISTANCE), 1e9];

    // Center on XZ in whole cells; ground at Y = 0.
    const offX = -Math.floor(model.sizeX / 2);
    const offZ = -Math.floor(model.sizeZ / 2);

    // Phase 1 — bucket cells into per-chunk compact pair lists (GLOBAL min-cell
    // coords, same convention as the GLB bake: world position = cell · voxelSize,
    // chunk cx = floor(cell / cellsPerAxis)). Each bucket holds one interleaved
    // number[] of (packedCellKey, rgb) pairs (~16 B/cell) rather than a
    // Map<number, CellAttr> (~140 B/cell, ~2.9 GB at the 16.7M-cell cap). Each
    // chunk's attribute Map is materialized only while that chunk is encoded in
    // phase 2, then freed — the same streaming rationale as the GLB bake's
    // stream-encode note (VxlWorldVoxelizer.ts:461-469).
    const buckets = new Map<number, { cx: number; cy: number; cz: number; pairs: number[] }>();
    for (const [key, rgb] of model.cells) {
        const [x, y, z] = unpackCell(key);
        const gx = x + offX, gy = y, gz = z + offZ;
        const cx = Math.floor(gx / cellsPerAxis);
        const cy = Math.floor(gy / cellsPerAxis);
        const cz = Math.floor(gz / cellsPerAxis);
        const ck = packCell(cx, cy, cz);
        let entry = buckets.get(ck);
        if (!entry) {
            entry = { cx, cy, cz, pairs: [] };
            buckets.set(ck, entry);
        }
        entry.pairs.push(packCell(gx, gy, gz), rgb);
    }

    // Chunk-aligned world bounds.
    let cxMin = Infinity, cyMin = Infinity, czMin = Infinity;
    let cxMax = -Infinity, cyMax = -Infinity, czMax = -Infinity;
    for (const { cx, cy, cz } of buckets.values()) {
        cxMin = Math.min(cxMin, cx); cyMin = Math.min(cyMin, cy); czMin = Math.min(czMin, cz);
        cxMax = Math.max(cxMax, cx); cyMax = Math.max(cyMax, cy); czMax = Math.max(czMax, cz);
    }
    const bounds = {
        minX: cxMin * chunkSize, minY: cyMin * chunkSize, minZ: czMin * chunkSize,
        maxX: (cxMax + 1) * chunkSize, maxY: (cyMax + 1) * chunkSize, maxZ: (czMax + 1) * chunkSize,
    };

    const encoder = createVxlSceneEncoder(
        { chunkSize, minVoxelSize: vs, bounds, lodDistances, groundMask: null },
        { compression: 'none' },
    );

    // Phase 2 — encode chunk by chunk in deterministic order: cx, then cy, then
    // cz ascending (matches the GLB bake). Only the chunk being encoded holds a
    // full Map<number, CellAttr>; its bucket is dropped as soon as it is encoded.
    const orderedKeys = Array.from(buckets.keys()).sort((ka, kb) => {
        const a = buckets.get(ka)!, b = buckets.get(kb)!;
        return a.cx - b.cx || a.cy - b.cy || a.cz - b.cz;
    });
    const totalChunks = orderedKeys.length;
    let totalLod0Cells = 0;
    let chunkIndex = 0;
    for (const ck of orderedKeys) {
        const { cx, cy, cz, pairs } = buckets.get(ck)!;
        const grid = new Map<number, CellAttr>();
        for (let i = 0; i < pairs.length; i += 2) {
            const rgb = pairs[i + 1]!;
            grid.set(pairs[i]!, {
                color: {
                    r: srgbByteToLinear((rgb >> 16) & 255),
                    g: srgbByteToLinear((rgb >> 8) & 255),
                    b: srgbByteToLinear(rgb & 255),
                },
                nx: 0, ny: 0, nz: 0,
                interior: false,
                noCollider: false,
                pinned: false,
                displacementAxis: null,
                dispOffset: 0,
            });
        }
        const lodHints: SceneQuad[][] = [
            localizeChunkResQuads(greedyMesh(grid), cx, cy, cz, cellsPerAxis, 1, 1),
        ];
        let coarse = grid;
        for (let i = 1; i <= lodsInput.length; i++) {
            coarse = downsampleGrid(coarse);
            lodHints.push(localizeChunkResQuads(greedyMesh(coarse), cx, cy, cz, cellsPerAxis >> i, 1, 1 << i));
        }
        // pairs.length / 2 === grid.size: cells were unique in model.cells, so
        // each chunk's packed cell keys are unique.
        totalLod0Cells += pairs.length / 2;
        await encoder.addChunk({ cx, cy, cz, voxels: [], lodHints, namedTrimeshes: [] });
        buckets.delete(ck); // encoded — free this chunk's pairs immediately
        chunkIndex++;
        options.onProgress?.({ chunkIndex, totalChunks, label: `chunk (${cx},${cy},${cz})` });
        if (chunkIndex % 8 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
    }

    const vwldBytes = await encoder.finish();
    return {
        vwldBytes,
        worldBounds: bounds,
        chunkSize,
        nonEmptyChunkCount: totalChunks,
        totalLod0Cells,
    };
}
