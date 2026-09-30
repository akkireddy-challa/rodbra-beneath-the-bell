/**
 * VoxelWorld ↔ VXL v3 bridge.
 *
 * Collision voxel grids (the output of splat voxelization) hold a single
 * block id (`convertVoxelGridToVoxelWorld` always emits id=1) plus per-voxel
 * RGB color, so they map cleanly onto VXL v3's "leaf + RGB" representation.
 * VXL v3 is ~30× smaller than the legacy JSON dump and is the format we
 * persist to cloud storage from `VoxelWorld.saveToFile`.
 *
 * Multi-block-type fidelity is intentionally NOT preserved — VXL v3 has no
 * slot for block-type names. If callers ever need it for collision saves
 * this module gets a sidecar palette block.
 */
import { CHUNK_SIZE, CHUNK_MASK, VoxelChunk } from 'engine/VoxelGeometry.js';
import type { BlockID } from 'engine/VoxelGeometry.js';
import { encodeVxlV3, decodeVxlV3, type VxlV3Data } from 'engine/VxlV3Format.js';
import type { OctreeLeaf } from 'engine/VoxelOctreeRenderer.js';

/**
 * Minimum surface VoxelWorld exposes for its IO helpers. The `Chunk` type is
 * a VoxelWorld-local subclass; we accept any subclass and let the caller
 * inject its factory so we don't have to reach back into VoxelWorld.ts.
 */
export interface VxlIOWorld<TChunk extends VoxelChunk> {
    chunks: Map<string, TChunk>;
    dirtyChunks: Set<TChunk>;
    clear(): void;
}

export interface VoxelWorldSaveOptions {
    voxelSize: number;
    bounds?: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
}

export interface VoxelWorldLoadResult {
    voxelSize?: number;
    bounds?: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
}

/**
 * Encode every non-air voxel as an OctreeLeaf and emit a gzipped VXL v3
 * buffer. Each voxel becomes one leaf at world position
 * `(cx*CHUNK_SIZE + lx) * voxelSize`, with the chunk-local RGB24 color
 * unpacked into 0-1 floats for the encoder.
 */
/** `BlockType.COLOR` — a voxel that carries its own colour rather than a texture. */
const COLOR_BLOCK_ID = 255;

/** One leaf per solid voxel, plus the box they span. */
export interface ChunkLeafConversion {
    leaves: OctreeLeaf[];
    bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
}

/**
 * Expand a chunk grid into one `OctreeLeaf` per solid voxel, in WORLD coordinates.
 *
 * Shared by every chunk-backed → VXL3 path so there is ONE definition of where a voxel
 * lands: leaf position is `base + (chunkCoord * CHUNK_SIZE + local) * voxelSize`, and
 * chunk keys are the signed `"cx,cy,cz"` triples the grid is stored under. A second
 * copy of this arithmetic that disagreed by one chunk would silently displace every
 * converted asset, so callers pass their own `base` rather than re-deriving positions.
 *
 * `base` is the world offset the grid's chunk coords are relative to. VoxelWorld numbers
 * its chunks from `bounds.min`, so it passes that; objects centred on their own origin
 * (signed chunk coords) pass zero and let the returned bounds describe them.
 */
export function chunksToOctreeLeaves<TChunk extends VoxelChunk>(
    chunks: Map<string, TChunk>,
    voxelSize: number,
    base: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 },
    /**
     * Carry each voxel's BLOCK TYPE onto its leaf (VXL3 v9). Opt-in because it changes
     * what the encoder writes: a grid of textured blocks becomes a v9 asset instead of a
     * colour-only one. Object saves want it — losing the type is the whole defect this
     * exists to fix. The world path leaves it off and keeps emitting exactly what it did.
     */
    carryBlockTypes = false,
): ChunkLeafConversion {
    const leaves: OctreeLeaf[] = [];
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    for (const [key, chunk] of chunks) {
        const parts = key.split(',');
        if (parts.length !== 3) continue;
        const cx = parseInt(parts[0]!, 10);
        const cy = parseInt(parts[1]!, 10);
        const cz = parseInt(parts[2]!, 10);
        if (isNaN(cx) || isNaN(cy) || isNaN(cz)) continue;
        const baseX = cx * CHUNK_SIZE;
        const baseY = cy * CHUNK_SIZE;
        const baseZ = cz * CHUNK_SIZE;
        for (let ly = 0; ly < CHUNK_SIZE; ly++) {
            for (let lz = 0; lz < CHUNK_SIZE; lz++) {
                for (let lx = 0; lx < CHUNK_SIZE; lx++) {
                    const blockId = chunk.get(lx, ly, lz);
                    if (blockId === 0) continue;
                    const wx = base.x + (baseX + lx) * voxelSize;
                    const wy = base.y + (baseY + ly) * voxelSize;
                    const wz = base.z + (baseZ + lz) * voxelSize;
                    const c24 = chunk.colors.length > 0 ? (chunk.colors.get(lx, ly, lz) >>> 0) : 0xFFFFFF;
                    const r = ((c24 >> 16) & 0xFF) / 255;
                    const g = ((c24 >> 8) & 0xFF) / 255;
                    const b = (c24 & 0xFF) / 255;
                    leaves.push({
                        x: wx, y: wy, z: wz, size: voxelSize, r, g, b,
                        // BlockType.COLOR means "coloured", which the encoder already reads
                        // as no block type — passing it through would address a texture
                        // that does not exist.
                        ...(carryBlockTypes && blockId !== COLOR_BLOCK_ID ? { blockType: blockId } : {}),
                    });
                    if (wx < minX) minX = wx;
                    if (wy < minY) minY = wy;
                    if (wz < minZ) minZ = wz;
                    if (wx + voxelSize > maxX) maxX = wx + voxelSize;
                    if (wy + voxelSize > maxY) maxY = wy + voxelSize;
                    if (wz + voxelSize > maxZ) maxZ = wz + voxelSize;
                }
            }
        }
    }

    // Empty grid → placeholder unit-cube bounds so the encoder still has a
    // well-formed body (it would reject zero-volume bounds).
    if (leaves.length === 0) {
        minX = minY = minZ = 0;
        maxX = maxY = maxZ = voxelSize;
    }
    return { leaves, bounds: { minX, minY, minZ, maxX, maxY, maxZ } };
}

export async function encodeVoxelWorldAsVxlV3<TChunk extends VoxelChunk>(world: VxlIOWorld<TChunk>, opts: VoxelWorldSaveOptions): Promise<Uint8Array> {
    const voxelSize = opts.voxelSize;
    // Leaf positions are emitted in WORLD coordinates so the saved file is
    // self-describing — leaf.x is the same number the loader subtracts
    // bounds.minX from to recover the voxel index. Chunk coords inside
    // VoxelWorld are 0-based offsets from `bounds.minX`, so we add the
    // bounds offset back here. When no bounds are supplied, the offset is
    // 0 and the auto-computed bounds (below) end up at minX=0 — symmetric
    // either way.
    const converted = chunksToOctreeLeaves(world.chunks, voxelSize, {
        x: opts.bounds?.minX ?? 0,
        y: opts.bounds?.minY ?? 0,
        z: opts.bounds?.minZ ?? 0,
    });
    const bounds = opts.bounds ?? converted.bounds;
    const data: VxlV3Data = {
        minVoxelSize: voxelSize,
        maxVoxelSize: voxelSize,
        physicsGridStep: voxelSize,
        bounds,
        useAtlas: false,
        fragments: [{
            aabbMin: [bounds.minX, bounds.minY, bounds.minZ],
            aabbMax: [bounds.maxX, bounds.maxY, bounds.maxZ],
            leaves: converted.leaves,
        }],
    };
    return encodeVxlV3(data);
}

/**
 * Decode a VXL v3 buffer and populate the world's chunk grid. Clears any
 * existing chunks first; marks every loaded chunk dirty so downstream
 * meshing/physics rebuilds it. All voxels load as block id 1, matching the
 * single-id contract of `convertVoxelGridToVoxelWorld`.
 */
export async function loadVxlV3IntoVoxelWorld<TChunk extends VoxelChunk>(world: VxlIOWorld<TChunk>, buffer: ArrayBuffer, newChunk: () => TChunk): Promise<VoxelWorldLoadResult> {
    const data = await decodeVxlV3(buffer);
    const voxelSize = data.minVoxelSize;
    world.clear();

    const COLLISION_BLOCK_ID = 1 as BlockID;
    const inv = 1 / voxelSize;
    const baseX = data.bounds.minX;
    const baseY = data.bounds.minY;
    const baseZ = data.bounds.minZ;

    for (const fragment of data.fragments) {
        fragment.leaves.forEach((leaf) => {
            const vx = Math.round((leaf.x - baseX) * inv);
            const vy = Math.round((leaf.y - baseY) * inv);
            const vz = Math.round((leaf.z - baseZ) * inv);
            const cx = Math.floor(vx / CHUNK_SIZE);
            const cy = Math.floor(vy / CHUNK_SIZE);
            const cz = Math.floor(vz / CHUNK_SIZE);
            const lx = vx & CHUNK_MASK;
            const ly = vy & CHUNK_MASK;
            const lz = vz & CHUNK_MASK;
            const chunkKey = `${cx},${cy},${cz}`;
            let chunk = world.chunks.get(chunkKey);
            if (!chunk) {
                chunk = newChunk();
                world.chunks.set(chunkKey, chunk);
            }
            chunk.set(lx, ly, lz, COLLISION_BLOCK_ID);
            const r = Math.max(0, Math.min(255, Math.round(leaf.r * 255)));
            const g = Math.max(0, Math.min(255, Math.round(leaf.g * 255)));
            const b = Math.max(0, Math.min(255, Math.round(leaf.b * 255)));
            chunk.colors.set(lx, ly, lz, (r << 16) | (g << 8) | b);
        });
    }

    for (const chunk of world.chunks.values()) {
        chunk.needsRemesh = true;
        world.dirtyChunks.add(chunk);
    }

    return { voxelSize, bounds: data.bounds };
}
