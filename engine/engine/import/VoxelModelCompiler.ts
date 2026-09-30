/**
 * Flattens an ImportedVoxelFile into engine-oriented, zero-rebased voxel grids.
 *
 * - merge: all instances stamped into ONE grid (scene layout preserved; later
 *   instances win on overlap).
 * - separate: one grid per source model, authored orientation (instance
 *   transforms ignored — a prop pack's per-model placement is scene layout,
 *   not part of the prop).
 *
 * Axis conversion happens here, once: MagicaVoxel is Z-up right-handed, the
 * engine is Y-up right-handed, so engine = (x, z, -y) (a −90° rotation about X —
 * a plain y/z swap would mirror every model). Qubicle is already Y-up.
 * After conversion the grid is rebased so min = (0,0,0).
 */
import type { ImportedVoxelFile, ImportedVoxelInstance } from 'engine/import/ImportedVoxelModel.js';
import { IDENTITY_ROTATION, MAX_IMPORT_VOXELS } from 'engine/import/ImportedVoxelModel.js';
import { packCell, CELL_KEY_HALF } from 'engine/vxlscene/SurfaceRasterizer.js';

export interface CompiledVoxelModel {
    name: string;
    /** Grid extent in cells (engine axes, after rebase). */
    sizeX: number;
    sizeY: number;
    sizeZ: number;
    /** key = packCell(x, y, z), all coords >= 0; value = 0xRRGGBB (sRGB). */
    cells: Map<number, number>;
    /**
     * Per-cell emissive intensity, keyed exactly like `cells`; value 0..255.
     * Sparse: entries exist only for glowing cells (value > 0). Null when the
     * source file has no emissive materials, or none of its emissive colors is
     * used by a placed voxel (unused palette entries are never ghost-emitted).
     */
    cellsEmissive: Map<number, number> | null;
}

export interface CompileOptions {
    mode: 'merge' | 'separate';
    /** Fallback naming stem (usually the file name without extension). */
    baseName: string;
    /** Cumulative stamped-voxel budget; override only in tests. Default MAX_IMPORT_VOXELS. */
    maxVoxels?: number;
}

interface RawCell { x: number; y: number; z: number; rgb: number; /** 0..255, 0 = none */ emissive: number; }

/** Mutable cumulative counter threaded through collectInstance calls (merge: across instances; separate: across grids). */
interface VoxelBudget { remaining: number; limit: number; }

export function compileImportedFile(file: ImportedVoxelFile, options: CompileOptions): CompiledVoxelModel[] {
    const limit = options.maxVoxels ?? MAX_IMPORT_VOXELS;
    const budget: VoxelBudget = { remaining: limit, limit };
    const hasEmissive = file.paletteEmissive !== null;
    if (options.mode === 'merge') {
        const cells: RawCell[] = [];
        for (const inst of file.instances) collectInstance(file, inst, cells, budget);
        return [finishModel(cells, options.baseName, file.format, hasEmissive)];
    }
    const models: CompiledVoxelModel[] = [];
    for (let i = 0; i < file.grids.length; i++) {
        const identity: ImportedVoxelInstance = {
            gridIndex: i, rotation: IDENTITY_ROTATION, translation: [0, 0, 0], name: null,
        };
        const cells: RawCell[] = [];
        collectInstance(file, identity, cells, budget);
        if (cells.length === 0) continue; // fully-transparent grid
        const instName = file.instances.find(inst => inst.gridIndex === i)?.name ?? null;
        const name = instName ?? file.grids[i]!.name ?? `${options.baseName}-${i + 1}`;
        models.push(finishModel(cells, name, file.format, hasEmissive));
    }
    if (models.length === 0) throw new Error('No solid voxels found in file');
    return models;
}

function collectInstance(file: ImportedVoxelFile, inst: ImportedVoxelInstance, out: RawCell[], budget: VoxelBudget): void {
    const grid = file.grids[inst.gridIndex];
    if (!grid) return;
    const m = inst.rotation;
    const t = inst.translation;
    const cx = Math.floor(grid.sizeX / 2);
    const cy = Math.floor(grid.sizeY / 2);
    const cz = Math.floor(grid.sizeZ / 2);
    const pal = file.palette;
    const pe = file.paletteEmissive;
    const v = grid.voxels;
    for (let i = 0; i < v.length; i += 4) {
        const ci = v[i + 3]!;
        const pr = pal[ci * 4 + 0];
        if (pr === undefined) continue; // palette index out of range
        const a = pal[ci * 4 + 3]!;
        if (a < 128) continue; // transparent palette entry = air
        const rgb = (pr << 16) | (pal[ci * 4 + 1]! << 8) | pal[ci * 4 + 2]!;
        // paletteEmissive shares the palette's color indexing (1-based for .vox).
        const emissive = pe ? pe[ci] ?? 0 : 0;
        // MagicaVoxel placement: world = R * (p - floor(size/2)) + t
        const lx = v[i]! - cx, ly = v[i + 1]! - cy, lz = v[i + 2]! - cz;
        const x = m[0]! * lx + m[1]! * ly + m[2]! * lz + t[0];
        const y = m[3]! * lx + m[4]! * ly + m[5]! * lz + t[1];
        const z = m[6]! * lx + m[7]! * ly + m[8]! * lz + t[2];
        if (--budget.remaining < 0) {
            throw new Error(`Voxel count exceeds import limit (${budget.limit.toLocaleString('en-US')})`);
        }
        out.push({ x, y, z, rgb, emissive });
    }
}

function finishModel(cells: RawCell[], name: string, format: 'vox' | 'qb', hasEmissive: boolean): CompiledVoxelModel {
    if (cells.length === 0) throw new Error('No solid voxels found in file');
    // Axis conversion to engine Y-up. MagicaVoxel: (x, y, z)src → (x, z, -y)eng.
    const converted = format === 'vox'
        ? cells.map(c => ({ x: c.x, y: c.z, z: -c.y, rgb: c.rgb, emissive: c.emissive }))
        : cells;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const c of converted) {
        if (c.x < minX) minX = c.x;
        if (c.y < minY) minY = c.y;
        if (c.z < minZ) minZ = c.z;
        if (c.x > maxX) maxX = c.x;
        if (c.y > maxY) maxY = c.y;
        if (c.z > maxZ) maxZ = c.z;
    }
    if (maxX - minX + 1 > CELL_KEY_HALF || maxY - minY + 1 > CELL_KEY_HALF || maxZ - minZ + 1 > CELL_KEY_HALF) {
        throw new Error(`Model extent exceeds the importable range (${CELL_KEY_HALF} cells per axis)`);
    }
    const out = new Map<number, number>();
    // Sparse: only glowing cells get an entry. Allocated only when the file has
    // emissive at all; the delete keeps later-instance-wins correct when a
    // non-glowing cell overwrites a glowing one.
    const emissive = hasEmissive ? new Map<number, number>() : null;
    for (const c of converted) {
        const key = packCell(c.x - minX, c.y - minY, c.z - minZ);
        out.set(key, c.rgb);
        if (emissive) {
            if (c.emissive > 0) emissive.set(key, c.emissive);
            else emissive.delete(key);
        }
    }
    return {
        name,
        sizeX: maxX - minX + 1,
        sizeY: maxY - minY + 1,
        sizeZ: maxZ - minZ + 1,
        cells: out,
        cellsEmissive: emissive !== null && emissive.size > 0 ? emissive : null,
    };
}
