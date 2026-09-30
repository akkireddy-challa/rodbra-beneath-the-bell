/**
 * CompiledVoxelModel → VXL asset bytes via the standard encoder (encodeVxlV3,
 * useAtlas — identical rendering path to GLB-voxelized assets).
 *
 * The source is already voxels, so there is no octree pass: every cell becomes
 * one uniform-size leaf. Coarser LODs are 2x2x2 MAJORITY-color downsamples
 * (voxel-art-friendly — never invents blended colors; the level path uses the
 * shared average-color downsampleGrid instead, matching GLB levels).
 */
import { encodeVxlV3, type VxlV3LodLevel, type VxlV3Bounds } from 'engine/VxlV3Format.js';
import type { OctreeLeaf } from 'engine/VoxelOctreeRenderer.js';
import { packCell, unpackCell } from 'engine/vxlscene/SurfaceRasterizer.js';
import { estimateColliderCount } from 'engine/ColliderEstimate.js';
import type { CompiledVoxelModel } from 'engine/import/VoxelModelCompiler.js';
import type { VxlV3Part } from 'engine/VxlV3Parts.js';
import { smartRigFor } from 'engine/import/SmartPropParts.js';

export interface VoxelAssetImportOptions {
    /** Edge length of one source voxel, meters. */
    voxelSize: number;
    /** Coarser LODs to bake (2x each), 0-2. */
    additionalLodCount: number;
    /** LOD0 leaf budget; over it the model auto-coarsens 2x per step. */
    maxLeaves: number;
    /**
     * Smart-object parts to bake as the v12 part channel. `cellsPart` is keyed
     * like `model.cells` and holds the owning JOINT per cell (0 = body, i + 1 =
     * `parts[i]`); cells absent from it are body. `pivots[i]` is part i's pivot
     * in cell units of `voxelSize` (fractional), converted to metres here so
     * the frame maths lives in one place. Carried through auto-coarsen and
     * every LOD by majority, exactly as colour is.
     */
    smartParts?: SmartPartsInput;
}

export interface SmartPartsInput {
    cellsPart: Map<number, number>;
    parts: VxlV3Part[];
    pivots: Array<[number, number, number]>;
}

export const DEFAULT_VOXEL_ASSET_IMPORT_OPTIONS: VoxelAssetImportOptions = {
    voxelSize: 0.1,
    additionalLodCount: 2,
    maxLeaves: 600_000,
};

export interface VoxelAssetImportResult {
    vxlBytes: Uint8Array;
    bounds: VxlV3Bounds;
    /** After auto-coarsen; equals options.voxelSize when under budget. */
    effectiveVoxelSize: number;
    totalVoxels: number;
    voxelsPerLod: number[];
    lodCount: number;
    fragmentCount: number;
    colliderBoxCount: number;
    trimeshTriangles: number;
    warning?: string;
    /** Part pivots in metres in the compiled frame, parallel to `options.smartParts.parts`. */
    smartPivots?: Array<{ x: number; y: number; z: number }>;
}

/** A point in cell units of the REQUESTED voxel size → metres in the compiled frame. */
export function cellPointToMetres(
    bounds: VxlV3Bounds,
    voxelSize: number,
    cell: readonly [number, number, number],
): { x: number; y: number; z: number } {
    return {
        x: bounds.minX + cell[0] * voxelSize,
        y: bounds.minY + cell[1] * voxelSize,
        z: bounds.minZ + cell[2] * voxelSize,
    };
}

/** Standard sRGB EOTF — matches THREE.Color.convertSRGBToLinear. */
export function srgbByteToLinear(v: number): number {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** 2x2x2 majority-color downsample; ties break to the lowest rgb for determinism. */
export function downsampleCellsMajority(cells: Map<number, number>): Map<number, number> {
    const groups = new Map<number, Map<number, number>>();
    const keys = Array.from(cells.keys()).sort((a, b) => a - b);
    for (const key of keys) {
        const [x, y, z] = unpackCell(key);
        const pKey = packCell(x >> 1, y >> 1, z >> 1);
        let counts = groups.get(pKey);
        if (!counts) { counts = new Map(); groups.set(pKey, counts); }
        const rgb = cells.get(key)!;
        counts.set(rgb, (counts.get(rgb) ?? 0) + 1);
    }
    const out = new Map<number, number>();
    for (const [pKey, counts] of groups) {
        let best = -1, bestCount = -1;
        for (const [rgb, n] of counts) {
            if (n > bestCount || (n === bestCount && rgb < best)) { best = rgb; bestCount = n; }
        }
        out.set(pKey, best);
    }
    return out;
}

function cellsToLeaves(
    cells: Map<number, number>,
    voxelSize: number,
    bounds: VxlV3Bounds,
    cellsEmissive: Map<number, number> | null,
    cellsPart: Map<number, number> | null = null,
): OctreeLeaf[] {
    const leaves: OctreeLeaf[] = [];
    for (const [key, rgb] of cells) {
        const [gx, gy, gz] = unpackCell(key);
        const leaf: OctreeLeaf = {
            x: bounds.minX + gx * voxelSize,
            y: bounds.minY + gy * voxelSize,
            z: bounds.minZ + gz * voxelSize,
            size: voxelSize,
            r: srgbByteToLinear((rgb >> 16) & 255),
            g: srgbByteToLinear((rgb >> 8) & 255),
            b: srgbByteToLinear(rgb & 255),
        };
        // Same packCell keying as `cells`; absent means 0 (leaf stays non-emissive,
        // so emissive-free models keep producing byte-identical v5 assets).
        const emissive = cellsEmissive?.get(key);
        if (emissive !== undefined && emissive > 0) leaf.emissive = emissive;
        // The owning joint of a smart-object part; absent means the body (joint 0).
        const joint = cellsPart?.get(key);
        if (joint !== undefined && joint > 0) leaf.bone = joint;
        leaves.push(leaf);
    }
    return leaves;
}

export async function compileVoxelModelToVxlAsset(
    model: CompiledVoxelModel,
    options: VoxelAssetImportOptions,
): Promise<VoxelAssetImportResult> {
    let cells = model.cells;
    let vs = options.voxelSize;
    // The part channel follows every halving by the same majority vote, so a
    // coarsened windmill still knows which cells are blade.
    let cellsPart = options.smartParts?.cellsPart ?? null;
    while (cells.size > options.maxLeaves) {
        cells = downsampleCellsMajority(cells);
        if (cellsPart) cellsPart = downsampleCellsMajority(cellsPart);
        vs *= 2;
    }
    let warning: string | undefined;
    if (vs !== options.voxelSize) {
        warning = `Voxel count exceeded the renderable budget (${options.maxLeaves.toLocaleString()} leaves) ` +
            `at ${options.voxelSize} m — imported at ${vs} m instead.`;
    }
    if (cells.size === 0) throw new Error('Model contains no solid voxels');

    // Extent from the (possibly coarsened) cells; pivot convention matches the GLB
    // voxelizer output: XZ centered on the origin, ground at Y = 0.
    let maxGx = 0, maxGy = 0, maxGz = 0;
    for (const key of cells.keys()) {
        const [gx, gy, gz] = unpackCell(key);
        if (gx > maxGx) maxGx = gx;
        if (gy > maxGy) maxGy = gy;
        if (gz > maxGz) maxGz = gz;
    }
    const w = (maxGx + 1) * vs, h = (maxGy + 1) * vs, d = (maxGz + 1) * vs;
    const bounds: VxlV3Bounds = { minX: -w / 2, minY: 0, minZ: -d / 2, maxX: w / 2, maxY: h, maxZ: d / 2 };

    // Emissive keys match the ORIGINAL cell grid; an auto-coarsen rebuilds the keys,
    // so emissive rides only when no coarsening happened (the resolution loss is
    // already surfaced via `warning`).
    const lod0Emissive = cells === model.cells ? model.cellsEmissive : null;
    const lod0Leaves = cellsToLeaves(cells, vs, bounds, lod0Emissive, cellsPart);
    const voxelsPerLod = [lod0Leaves.length];
    const additionalLods: VxlV3LodLevel[] = [];
    let lodCells = cells;
    let lodCellsPart = cellsPart;
    for (let i = 1; i <= options.additionalLodCount; i++) {
        lodCells = downsampleCellsMajority(lodCells);
        if (lodCellsPart) lodCellsPart = downsampleCellsMajority(lodCellsPart);
        if (lodCells.size === 0) break;
        const lvs = vs * (1 << i);
        additionalLods.push({
            minVoxelSize: lvs,
            maxVoxelSize: lvs,
            fragments: [{
                aabbMin: [bounds.minX, bounds.minY, bounds.minZ],
                aabbMax: [bounds.maxX, bounds.maxY, bounds.maxZ],
                // v6 emissive is LOD0-only (coarse LODs render unlit) — no map here.
                // The part channel IS carried: a blade that rejoined the body at the
                // first LOD switch would stop turning at distance.
                leaves: cellsToLeaves(lodCells, lvs, bounds, null, lodCellsPart),
            }],
        });
        voxelsPerLod.push(lodCells.size);
    }

    // Smart-object rig + parts table. Pivots arrive in cell units of the REQUESTED
    // voxel size; cell × requested size is invariant under the halvings above, so the
    // conversion needs no coarsen factor. Bind positions are LOCAL to the parent, the
    // v10 rig's convention; joint 0 (the body) sits at the asset origin.
    const smart = options.smartParts;
    let smartPivots: Array<{ x: number; y: number; z: number }> | undefined;
    let rig: ReturnType<typeof smartRigFor> | undefined;
    if (smart && smart.parts.length > 0) {
        smartPivots = smart.pivots.map((pivot) => cellPointToMetres(bounds, options.voxelSize, pivot));
        rig = smartRigFor(smart.parts, smartPivots);
    }

    // Same physics-grid formula as the GLB voxelizer (GLBVoxelizer.ts:1396).
    const physicsGridStep = Math.min(Math.max(vs * 4, 0.1), 0.5);
    const colliderBoxCount = estimateColliderCount(lod0Leaves, physicsGridStep);

    const vxlBytes = await encodeVxlV3({
        minVoxelSize: vs,
        maxVoxelSize: vs,
        physicsGridStep,
        bounds,
        useAtlas: true,
        fragments: [{
            aabbMin: [bounds.minX, bounds.minY, bounds.minZ],
            aabbMax: [bounds.maxX, bounds.maxY, bounds.maxZ],
            leaves: lod0Leaves,
        }],
        ...(additionalLods.length > 0 ? { additionalLods } : {}),
        ...(rig && smart ? { rig, parts: smart.parts } : {}),
    });

    return {
        vxlBytes,
        bounds,
        effectiveVoxelSize: vs,
        totalVoxels: lod0Leaves.length,
        voxelsPerLod,
        lodCount: 1 + additionalLods.length,
        fragmentCount: 1,
        colliderBoxCount,
        trimeshTriangles: colliderBoxCount * 12,
        warning,
        ...(smartPivots ? { smartPivots } : {}),
    };
}
