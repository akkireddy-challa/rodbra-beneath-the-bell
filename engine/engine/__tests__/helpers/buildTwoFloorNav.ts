/**
 * Test-only fixtures: nav meshes built purely from serialized data (no
 * VoxelWorld), so stacked walkable layers can be described directly.
 *
 * `buildLayeredNav` takes a per-cell table of ground heights and packs them
 * into one multilayer chunk. `buildTwoFloorNav` is the two-storey fixture the
 * dungeon work is specified against: two 8x8 m floors at y=0 and y=6 inside a
 * single 16x16 m chunk, optionally connected by a stair strip along z=3 that
 * rises 0.75 m per cell (x=0 -> 0.75 m ... x=7 -> 6 m). Stair cells are
 * single-layer (the tread only), so the storeys connect exclusively through
 * the stair; `stair: false` leaves them disconnected.
 *
 * The header packs groundY deltas at 0.125 m while the step limits are 1 m up
 * / 2 m down: the case that forces the step-limit basis to come from the
 * header instead of the quantization unit.
 */
import { VoxelNavMesh } from 'engine/VoxelNavMesh.js';
import { DELTA_SHIFT, MAX_NAV_LAYERS, VOID_SENTINEL, encodeNavMesh } from 'engine/nav/NavSerialization.js';
import type { MultiLayerChunk, NavHeader } from 'engine/nav/NavSerialization.js';

export const TWO_FLOOR = {
    cellSize: 1,
    cellsPerSide: 16,
    voxelSize: 0.125,
    /** Both floors span cells [0..7] on each axis. */
    floorCells: 8,
    lowerY: 0,
    upperY: 6,
    /** Cell row (gz) occupied by the stair strip. */
    stairGz: 3,
    riserM: 0.75,
    maxClimbM: 1,
    maxDropM: 2,
} as const;

export interface LayeredNavOptions {
    cellsPerSide?: number;
    cellSize?: number;
    voxelSize?: number;
    agentRadius?: number;
    maxClimbM?: number;
    maxDropM?: number;
}

/**
 * Build a single-chunk nav mesh from a per-cell list of walkable ground
 * heights (world Y, non-negative — the chunk's baseY is 0). Heights are
 * sorted ascending and packed from layer 0 up, as the format requires.
 */
export function buildLayeredNav(
    layersAt: (lx: number, lz: number) => number[],
    options: LayeredNavOptions = {},
): VoxelNavMesh {
    const cps = options.cellsPerSide ?? TWO_FLOOR.cellsPerSide;
    const cellSize = options.cellSize ?? TWO_FLOOR.cellSize;
    const voxelSize = options.voxelSize ?? TWO_FLOOR.voxelSize;

    const table: number[][] = [];
    let layerCount = 1;
    for (let lx = 0; lx < cps; lx++) {
        for (let lz = 0; lz < cps; lz++) {
            const heights = [...layersAt(lx, lz)].sort((a, b) => a - b);
            if (heights.length > MAX_NAV_LAYERS) {
                throw new Error(`fixture cell (${lx},${lz}) has ${heights.length} layers, max ${MAX_NAV_LAYERS}`);
            }
            table[lx * cps + lz] = heights;
            if (heights.length > layerCount) layerCount = heights.length;
        }
    }

    const data = new Uint16Array(cps * cps * layerCount).fill(VOID_SENTINEL);
    for (let cell = 0; cell < cps * cps; cell++) {
        const heights = table[cell]!;
        for (let i = 0; i < heights.length; i++) {
            data[cell * layerCount + i] = Math.round(heights[i]! / voxelSize) << DELTA_SHIFT;
        }
    }

    const chunk: MultiLayerChunk = {
        kind: 'multilayer',
        cx: 0,
        cz: 0,
        cellSize,
        cellsPerSide: cps,
        baseY: 0,
        voxelSize,
        layerCount,
        data,
    };

    const header: NavHeader = {
        cellSize,
        agentRadius: options.agentRadius ?? 0.35,
        voxelSize,
        chunkWorldSize: cps * cellSize,
        minX: 0,
        minZ: 0,
        chunkCols: 1,
        chunkRows: 1,
        cellsPerChunkSide: cps,
        maxClimbM: options.maxClimbM ?? TWO_FLOOR.maxClimbM,
        maxDropM: options.maxDropM ?? TWO_FLOOR.maxDropM,
    };

    const nav = new VoxelNavMesh();
    nav.buildFromSerialized(toArrayBuffer(encodeNavMesh(header, [chunk])));
    return nav;
}

export interface TwoFloorOptions {
    /** Include the stair strip connecting the floors. Default true. */
    stair?: boolean;
}

/** Ground height of the stair tread in cell column `lx`. */
export function stairHeight(lx: number): number {
    return TWO_FLOOR.riserM * (lx + 1);
}

export function buildTwoFloorNav(options: TwoFloorOptions = {}): VoxelNavMesh {
    const withStair = options.stair ?? true;
    return buildLayeredNav((lx, lz) => {
        if (lx >= TWO_FLOOR.floorCells || lz >= TWO_FLOOR.floorCells) return [];
        if (withStair && lz === TWO_FLOOR.stairGz) return [stairHeight(lx)];
        return [TWO_FLOOR.lowerY, TWO_FLOOR.upperY];
    });
}

/** Copy a Uint8Array into a standalone ArrayBuffer (what decode/build take). */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    const out = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(out).set(bytes);
    return out;
}
