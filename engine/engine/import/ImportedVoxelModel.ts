/**
 * Shared intermediate representation for foreign voxel-model formats (.vox, .qb).
 * Parsers (VoxParser, QbParser) produce this; VoxelModelCompiler flattens it into
 * engine-oriented grids consumed by the asset / level converters. Adding a new
 * foreign format only ever adds a parser.
 *
 * Coordinates stay in SOURCE-format axes here (MagicaVoxel: Z-up; Qubicle: Y-up,
 * normalized to right-handed by the parser). The source→engine axis conversion
 * happens once, in VoxelModelCompiler.
 */

/** One voxel grid (a MagicaVoxel model / Qubicle matrix). */
export interface ImportedVoxelGrid {
    name: string | null;
    sizeX: number;
    sizeY: number;
    sizeZ: number;
    /** Stride 4: x, y, z, paletteIndex. Coordinates 0-based in source axes. */
    voxels: Int32Array;
}

/** Placement of a grid in the file's scene (resolved from the .vox scene graph). */
export interface ImportedVoxelInstance {
    gridIndex: number;
    /**
     * Row-major 3x3 sign-permutation rotation in source axes (values -1/0/1).
     * Identity for files without a scene graph.
     */
    rotation: readonly [number, number, number, number, number, number, number, number, number];
    /**
     * Translation in source voxel units. MagicaVoxel semantics: the transform is
     * applied about the grid's integer center `floor(size/2)`:
     *   worldVoxel = R * (localVoxel - floor(size/2)) + t
     */
    translation: readonly [number, number, number];
    name: string | null;
}

export interface ImportedVoxelFile {
    format: 'vox' | 'qb';
    grids: ImportedVoxelGrid[];
    /**
     * RGBA bytes, 4 per entry, sRGB. For .vox this is always 256 entries indexed
     * DIRECTLY by voxel paletteIndex (entry 0 unused — color indices are 1-based).
     * For .qb the palette is built by uniquing per-voxel colors (0-based indices).
     */
    palette: Uint8Array;
    /** Per-color emissive 0..255, parallel to `palette` (256 entries), or null
     *  when the file has no emissive materials. Indexed by 1-based color index. */
    paletteEmissive: Uint8Array | null;
    instances: ImportedVoxelInstance[];
    /** Informational notes accumulated during parsing (e.g. unsupported materials). */
    notes: string[];
}

export const IDENTITY_ROTATION: ImportedVoxelInstance['rotation'] = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Cumulative solid-voxel budget for any single imported file (256^3 — MagicaVoxel's max model volume). Caps hostile expansion (RLE bombs, repeated scene-graph instances). */
export const MAX_IMPORT_VOXELS = 16_777_216;
