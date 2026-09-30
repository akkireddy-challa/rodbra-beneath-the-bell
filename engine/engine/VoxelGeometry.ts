/**
 * VoxelGeometry - Shared voxel data structures and geometry utilities
 * 
 * Used by both VoxelWorld (large worlds) and VoxelObject (individual assets)
 * to ensure consistent data handling and rendering.
 */

export type BlockID = number;
export type ChunkKey = string;

export const CHUNK_SIZE = 16;
export const CHUNK_MASK = CHUNK_SIZE - 1;

export interface CollisionBox {
    x: number;
    y: number;
    z: number;
    w: number;
    h: number;
    d: number;
    blockType?: BlockID; // For per-material physics colliders
}

export interface VoxelBounds {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
}

/**
 * Face vertex templates for cube faces.
 * Each face has 4 vertices, ordered for counter-clockwise winding when viewed from outside.
 * Order: [-Z, +Z, -X, +X, -Y, +Y]
 */
export const FACE_TEMPLATES: ReadonlyArray<ReadonlyArray<number>> = [
    // -Z face (back)
    [-0.5, -0.5, -0.5], [ 0.5, -0.5, -0.5], [ 0.5,  0.5, -0.5], [-0.5,  0.5, -0.5],
    // +Z face (front)
    [-0.5, -0.5,  0.5], [-0.5,  0.5,  0.5], [ 0.5,  0.5,  0.5], [ 0.5, -0.5,  0.5],
    // -X face (left)
    [-0.5, -0.5, -0.5], [-0.5,  0.5, -0.5], [-0.5,  0.5,  0.5], [-0.5, -0.5,  0.5],
    // +X face (right)
    [ 0.5, -0.5, -0.5], [ 0.5, -0.5,  0.5], [ 0.5,  0.5,  0.5], [ 0.5,  0.5, -0.5],
    // -Y face (bottom)
    [-0.5, -0.5, -0.5], [-0.5, -0.5,  0.5], [ 0.5, -0.5,  0.5], [ 0.5, -0.5, -0.5],
    // +Y face (top)
    [-0.5,  0.5, -0.5], [ 0.5,  0.5, -0.5], [ 0.5,  0.5,  0.5], [-0.5,  0.5,  0.5],
];

/**
 * Face indices for two triangles per face (clockwise winding for Three.js FrontSide).
 * Flat array: 6 indices per face × 6 faces = 36 indices.
 * Order: [-Z, +Z, -X, +X, -Y, +Y]
 */
export const FACE_INDICES: ReadonlyArray<number> = [
    0, 2, 1, 0, 3, 2,       // -Z
    4, 6, 5, 4, 7, 6,       // +Z
    8, 10, 9, 8, 11, 10,    // -X
    12, 14, 13, 12, 15, 14, // +X
    16, 18, 17, 16, 19, 18, // -Y
    20, 22, 21, 20, 23, 22, // +Y
];

/**
 * Color storage using RLE encoding with RGB565 format.
 * Each entry: [color:16 bits | length:16 bits] in a 32-bit uint.
 */
export class ColorChunk {
    data: Uint32Array = new Uint32Array(4096);
    length: number = 0;

    constructor() {
        this.addRun(0, CHUNK_SIZE ** 3);
    }

    private addRun(color: number, count: number): void {
        while (count > 0) {
            const run = Math.min(count, 65535);
            this.data[this.length++] = (color << 16) | run;
            count -= run;
        }
    }

    static rgb888To565(r: number, g: number, b: number): number {
        const r5 = (r >> 3) & 0x1F;
        const g6 = (g >> 2) & 0x3F;
        const b5 = (b >> 3) & 0x1F;
        return (r5 << 11) | (g6 << 5) | b5;
    }

    static rgb565To888(rgb565: number): number {
        const r5 = (rgb565 >> 11) & 0x1F;
        const g6 = (rgb565 >> 5) & 0x3F;
        const b5 = rgb565 & 0x1F;
        const r = (r5 << 3) | (r5 >> 2);
        const g = (g6 << 2) | (g6 >> 4);
        const b = (b5 << 3) | (b5 >> 2);
        return (r << 16) | (g << 8) | b;
    }

    get(x: number, y: number, z: number): number {
        const idx = (y << 8) | (z << 4) | x;
        let pos = 0;
        for (let i = 0; i < this.length; i++) {
            const entry = this.data[i]!;
            pos += entry & 0xFFFF;
            if (pos > idx) return ColorChunk.rgb565To888(entry >>> 16);
        }
        return 0;
    }

    hasColor(x: number, y: number, z: number): boolean {
        return this.get(x, y, z) !== 0;
    }

    set(x: number, y: number, z: number, rgb24: number): void {
        const r = (rgb24 >> 16) & 0xFF;
        const g = (rgb24 >> 8) & 0xFF;
        const b = rgb24 & 0xFF;
        const rgb565 = ColorChunk.rgb888To565(r, g, b);
        this.rebuildRLEWithChange((y << 8) | (z << 4) | x, rgb565);
    }

    private rebuildRLEWithChange(changedLinearIdx: number, newColor565: number): void {
        const newData = new Uint32Array(4096);
        let writePos = 0;
        let pos = 0;
        for (let i = 0; i < this.length; i++) {
            const entry = this.data[i]!;
            const oldColor565 = entry >>> 16;
            const len = entry & 0xFFFF;
            const nextPos = pos + len;
            if (nextPos <= changedLinearIdx || pos > changedLinearIdx) {
                newData[writePos++] = entry;
            } else {
                const before = changedLinearIdx - pos;
                if (before > 0) newData[writePos++] = (oldColor565 << 16) | before;
                newData[writePos++] = (newColor565 << 16) | 1;
                const after = nextPos - changedLinearIdx - 1;
                if (after > 0) newData[writePos++] = (oldColor565 << 16) | after;
            }
            pos = nextPos;
        }
        this.data = newData;
        this.length = writePos;
    }
}

/**
 * Voxel chunk with RLE-encoded block data and colors.
 *
 * Two storage representations:
 *   - **RLE** (private `data` + `length`): compact, cheap to read sequentially,
 *     slow to mutate (each `set` walks the run list). Canonical on-disk form.
 *   - **Dense** (`dense`): a 4096-entry palette-index array. O(1) random
 *     read and write. Lives only while writes are flowing through `set`.
 *
 * The chunk auto-switches to dense on the first `set` call after an RLE
 * read state. The dense buffer must be compacted back to RLE before any
 * read of the on-disk RLE representation — this happens automatically
 * inside `forEachRun`, `getCompactedRle`, and `ensureCompacted`. `get`
 * handles both representations.
 *
 * The dense buffer is `Uint8Array` (palette index ≤ 255). If the chunk's
 * palette grows past 255 while in dense mode, the chunk compacts back to
 * RLE and stays there — extremely rare in practice for voxel terrain.
 *
 * **External access:** Always go through `forEachRun` / `getCompactedRle` /
 * `setRleData` / `clearRleRuns`. The RLE buffer is private precisely so
 * forgetting to compact can't silently produce stale serialized data
 * (the bug that produced all-air VXL uploads in May 2026).
 */
export class VoxelChunk {
    palette: BlockID[] = [0];
    colors: ColorChunk = new ColorChunk();
    collisionBoxes: CollisionBox[] | null = null;
    needsRemesh: boolean = true;
    private data: Uint16Array = new Uint16Array(4096 * 2);
    private length: number = 0;
    private dense: Uint8Array | null = null;

    constructor() {
        this.addRun(0, CHUNK_SIZE ** 3);
    }

    private addRun(index: number, runLength: number): void {
        while (runLength > 0) {
            const run = Math.min(runLength, 15);
            this.data[this.length++] = (index << 4) | run;
            runLength -= run;
        }
    }

    /** Decode the RLE into the dense scratch buffer (~4096 ops, one-time). */
    private toDense(): void {
        const dense = this.dense ?? new Uint8Array(4096);
        let pos = 0;
        for (let i = 0; i < this.length; i++) {
            const entry = this.data[i]!;
            const len = entry & 0b1111;
            const palIdx = entry >> 4;
            for (let j = 0; j < len; j++) dense[pos++] = palIdx;
        }
        this.dense = dense;
    }

    /**
     * Iterate compacted RLE runs. Compacts the dense buffer first, so callers
     * always see the canonical on-disk shape. Prefer this over poking at the
     * RLE buffer directly.
     */
    forEachRun(callback: (paletteIndex: number, runLength: number) => void): void {
        this.ensureCompacted();
        for (let i = 0; i < this.length; i++) {
            const entry = this.data[i]!;
            callback(entry >> 4, entry & 0b1111);
        }
    }

    /**
     * Length-trimmed view of the compacted RLE buffer for serialization.
     * Compacts first. The returned view shares memory with the chunk; copy
     * it (e.g. `Array.from(view)`) before any further writes to the chunk.
     */
    getCompactedRle(): Uint16Array {
        this.ensureCompacted();
        return this.data.subarray(0, this.length);
    }

    /**
     * Replace the chunk's RLE contents from deserialized data. Resets the
     * dense write buffer; palette/colors are untouched.
     */
    setRleData(data: number[] | Uint16Array): void {
        this.data = new Uint16Array(data);
        this.length = this.data.length;
        this.dense = null;
    }

    /**
     * Discard all RLE runs without touching palette/colors. Used by the
     * legacy voxel-list deserialization path which rebuilds runs through
     * repeated `set()` calls.
     */
    clearRleRuns(): void {
        this.length = 0;
        this.dense = null;
    }

    /** Byte size of the RLE buffer allocation — for diagnostic memory estimates. */
    getRleBufferByteLength(): number {
        return this.data.byteLength;
    }

    /**
     * Re-encode the dense buffer back to RLE. Most callers should use
     * `forEachRun` / `getCompactedRle` instead — they handle compaction
     * internally. Exposed for the rare case where you need to force
     * compaction without reading.
     */
    ensureCompacted(): void {
        if (!this.dense) return;
        const dense = this.dense;
        this.length = 0;
        let runStart = 0;
        let runPal = dense[0]!;
        for (let i = 1; i < 4096; i++) {
            const palAtI = dense[i]!;
            if (palAtI !== runPal) {
                this.addRun(runPal, i - runStart);
                runStart = i;
                runPal = palAtI;
            }
        }
        this.addRun(runPal, 4096 - runStart);
        this.dense = null;
    }

    get(x: number, y: number, z: number): BlockID {
        const idx = (y << 8) | (z << 4) | x;
        if (this.dense) return this.palette[this.dense[idx]!] ?? 0;
        let pos = 0;
        for (let i = 0; i < this.length; i++) {
            const entry = this.data[i]!;
            pos += entry & 0b1111;
            if (pos > idx) return this.palette[entry >> 4] ?? 0;
        }
        return 0;
    }

    clearToAir(): void {
        this.palette = [0];
        this.length = 0;
        this.addRun(0, CHUNK_SIZE ** 3);
        this.colors = new ColorChunk();
        this.collisionBoxes = null;
        this.needsRemesh = true;
        this.dense = null;
    }

    /**
     * Replace the chunk's contents with a flat horizontal stack:
     *   ly > surfaceLocalY                 → AIR
     *   ly == surfaceLocalY                → `surfaceBlock`
     *   yLowLocal ≤ ly < surfaceLocalY     → `subLayers[depth]` (last entry repeats)
     *                                        where `depth = surfaceLocalY - ly - 1`
     *                                        falls back to `surfaceBlock` if no subLayers
     *   ly < yLowLocal                     → AIR
     *
     * O(CHUNK_SIZE) — one palette lookup and one RLE write per Y-layer.
     * Replaces the chunk's existing contents entirely; intended for
     * world-generation use, not for mid-game edits. Works for any
     * surfaceLocalY (including out-of-chunk values for stacks where the
     * surface lies above or below this chunk's vertical range).
     */
    fillFlat(surfaceLocalY: number, yLowLocal: number, surfaceBlock: BlockID, subLayers?: BlockID[]): void {
        this.palette = [0];
        this.length = 0;
        this.colors = new ColorChunk();
        this.collisionBoxes = null;
        this.needsRemesh = true;
        this.dense = null;

        const layerCells = CHUNK_SIZE * CHUNK_SIZE;
        const subLen = subLayers?.length ?? 0;

        const getPaletteIdx = (block: BlockID): number => {
            if (block === 0) return 0;
            let idx = this.palette.indexOf(block);
            if (idx === -1) {
                idx = this.palette.length;
                this.palette.push(block);
            }
            return idx;
        };

        for (let ly = 0; ly < CHUNK_SIZE; ly++) {
            let block: BlockID;
            if (ly > surfaceLocalY || ly < yLowLocal) {
                block = 0;
            } else if (ly === surfaceLocalY) {
                block = surfaceBlock;
            } else if (subLen > 0 && subLayers) {
                const depth = surfaceLocalY - ly - 1;
                block = subLayers[Math.min(depth, subLen - 1)] ?? surfaceBlock;
            } else {
                block = surfaceBlock;
            }
            this.addRun(getPaletteIdx(block), layerCells);
        }
    }

    set(x: number, y: number, z: number, block: BlockID): void {
        let paletteIndex = this.palette.indexOf(block);
        if (paletteIndex === -1) {
            paletteIndex = this.palette.length;
            this.palette.push(block);
        }
        const targetIdx = (y << 8) | (z << 4) | x;

        // Dense fast path — O(1) write while in bulk-write mode.
        if (this.dense !== null && paletteIndex < 256) {
            this.dense[targetIdx] = paletteIndex;
            this.needsRemesh = true;
            return;
        }
        // Switch to dense from RLE for this and any subsequent writes.
        if (this.dense === null && paletteIndex < 256 && this.palette.length <= 256) {
            this.toDense();
            this.dense![targetIdx] = paletteIndex;
            this.needsRemesh = true;
            return;
        }
        // Palette outgrew Uint8 — drop dense, fall back to the RLE walk.
        if (this.dense !== null) this.ensureCompacted();

        const oldData = this.data.slice(0, this.length);
        this.length = 0;
        let currentPos = 0;
        let inserted = false;

        for (let i = 0; i < oldData.length; i++) {
            const entry = oldData[i]!;
            const len = entry & 0b1111;
            const oldPaletteIdx = entry >> 4;
            const runEnd = currentPos + len;

            if (!inserted && targetIdx < runEnd) {
                const offsetInRun = targetIdx - currentPos;
                if (offsetInRun > 0) {
                    this.addRun(oldPaletteIdx, offsetInRun);
                }
                this.addRun(paletteIndex, 1);
                const remaining = len - offsetInRun - 1;
                if (remaining > 0) {
                    this.addRun(oldPaletteIdx, remaining);
                }
                inserted = true;
            } else {
                this.addRun(oldPaletteIdx, len);
            }
            currentPos = runEnd;
        }

        if (!inserted && targetIdx >= currentPos) {
            const airNeeded = targetIdx - currentPos;
            if (airNeeded > 0) {
                this.addRun(0, airNeeded);
            }
            this.addRun(paletteIndex, 1);
        }

        this.needsRemesh = true;
    }
}

/**
 * Generate greedy-meshed collision boxes from a chunk.
 * Merges adjacent solid voxels into larger boxes for efficient physics and rendering.
 * @param chunk The voxel chunk
 * @param skipBlock Optional predicate - return true to skip a block (treat as empty)
 */
export function generateCollisionBoxes(chunk: VoxelChunk, skipBlock?: (blockType: number) => boolean): CollisionBox[] {
    const boxes: CollisionBox[] = [];
    const visited = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE);
    const isSolid = (blockType: number) => blockType !== 0 && !(skipBlock?.(blockType));

    for (let y = 0; y < CHUNK_SIZE; y++) {
        for (let z = 0; z < CHUNK_SIZE; z++) {
            for (let x = 0; x < CHUNK_SIZE; x++) {
                const idx = (y << 8) | (z << 4) | x;
                const startBlockType = chunk.get(x, y, z);
                if (visited[idx] || !isSolid(startBlockType)) continue;

                // Only merge blocks of the SAME type (for per-material physics colliders)
                const canMerge = (bx: number, by: number, bz: number) => 
                    chunk.get(bx, by, bz) === startBlockType && !visited[(by << 8) | (bz << 4) | bx];

                // Expand in X (same block type only)
                let maxX = x + 1;
                while (maxX < CHUNK_SIZE && canMerge(maxX, y, z)) maxX++;

                // Expand in Z (same block type only)
                let maxZ = z + 1;
                zLoop: while (maxZ < CHUNK_SIZE) {
                    for (let ix = x; ix < maxX; ix++) { if (!canMerge(ix, y, maxZ)) break zLoop; }
                    maxZ++;
                }

                // Expand in Y (same block type only)
                let maxY = y + 1;
                yLoop: while (maxY < CHUNK_SIZE) {
                    for (let iz = z; iz < maxZ; iz++) {
                        for (let ix = x; ix < maxX; ix++) { if (!canMerge(ix, maxY, iz)) break yLoop; }
                    }
                    maxY++;
                }

                // Mark visited
                for (let iy = y; iy < maxY; iy++) {
                    for (let iz = z; iz < maxZ; iz++) {
                        for (let ix = x; ix < maxX; ix++) { visited[(iy << 8) | (iz << 4) | ix] = 1; }
                    }
                }

                boxes.push({ x, y, z, w: maxX - x, h: maxY - y, d: maxZ - z, blockType: startBlockType });
            }
        }
    }
    return boxes;
}

/**
 * Parse a chunk key string "cx,cy,cz" into coordinates.
 */
export function parseChunkKey(key: ChunkKey): { cx: number; cy: number; cz: number } | null {
    const parts = key.split(',');
    if (parts.length !== 3) return null;
    const cx = parseInt(parts[0]!, 10);
    const cy = parseInt(parts[1]!, 10);
    const cz = parseInt(parts[2]!, 10);
    if (isNaN(cx) || isNaN(cy) || isNaN(cz)) return null;
    return { cx, cy, cz };
}

/**
 * Create a chunk key string from coordinates.
 */
export function makeChunkKey(cx: number, cy: number, cz: number): ChunkKey {
    return `${cx},${cy},${cz}`;
}

/** X/Z extent of an object's base, in the mesh's own local (pivot-relative) space. */
export interface BaseFootprint { minX: number; maxX: number; minZ: number; maxZ: number }

/**
 * X/Z extent of the LOWEST occupied voxel layer of a chunk map — the part of the
 * object that actually rests on the ground.
 *
 * Returned in the same local space `buildMesh` uses, so a voxel's box spans
 * `[boundsOffset + index * voxelSize - pivot, +voxelSize)`.
 *
 * Callers that place an object on terrain need this rather than the instance
 * origin (which need not lie under the object at all — `boundsOffset`/`pivot` put
 * the mesh wherever the asset says) and rather than the full bounds (a tree's
 * canopy is metres wider than its trunk, so a cliff under the leaves would lift
 * the tree off the ground).
 *
 * Returns null when nothing is occupied.
 */
export function baseFootprint(
    chunks: Map<ChunkKey, VoxelChunk>,
    voxelSize: number,
    boundsOffset: Readonly<{ x: number; z: number }>,
    pivot: Readonly<{ x: number; z: number }>,
): BaseFootprint | null {
    let baseY = Infinity;
    let minVX = Infinity, maxVX = -Infinity, minVZ = Infinity, maxVZ = -Infinity;
    for (const [key, chunk] of chunks) {
        const parsed = parseChunkKey(key);
        if (!parsed) continue;
        const { cx, cy, cz } = parsed;
        for (let ly = 0; ly < CHUNK_SIZE; ly++) {
            const gy = cy * CHUNK_SIZE + ly;
            if (gy > baseY) continue;
            for (let lz = 0; lz < CHUNK_SIZE; lz++) for (let lx = 0; lx < CHUNK_SIZE; lx++) {
                if (chunk.get(lx, ly, lz) === 0) continue;
                const gx = cx * CHUNK_SIZE + lx, gz = cz * CHUNK_SIZE + lz;
                if (gy < baseY) {
                    // A new lowest layer supersedes anything measured above it.
                    baseY = gy;
                    minVX = maxVX = gx;
                    minVZ = maxVZ = gz;
                    continue;
                }
                if (gx < minVX) minVX = gx;
                if (gx > maxVX) maxVX = gx;
                if (gz < minVZ) minVZ = gz;
                if (gz > maxVZ) maxVZ = gz;
            }
        }
    }
    if (!Number.isFinite(baseY)) return null;
    return {
        minX: boundsOffset.x + minVX * voxelSize - pivot.x,
        maxX: boundsOffset.x + (maxVX + 1) * voxelSize - pivot.x,
        minZ: boundsOffset.z + minVZ * voxelSize - pivot.z,
        maxZ: boundsOffset.z + (maxVZ + 1) * voxelSize - pivot.z,
    };
}

/**
 * World-space points to sample the terrain at, spread across a base footprint
 * placed at `(x, z)` with the given yaw and X/Z scale.
 *
 * Spacing is `step` (use half a terrain block so a one-block step under the base
 * cannot be missed), with at least the corners and at most 9 samples per axis so a
 * large footprint stays cheap. Yaw follows the instance-matrix / navmesh-obstacle
 * convention used elsewhere in the engine.
 */
export function footprintGroundSamples(
    footprint: Readonly<BaseFootprint>,
    x: number,
    z: number,
    yaw: number,
    scaleX: number,
    scaleZ: number,
    step: number,
): Array<{ x: number; z: number }> {
    const minX = footprint.minX * scaleX, maxX = footprint.maxX * scaleX;
    const minZ = footprint.minZ * scaleZ, maxZ = footprint.maxZ * scaleZ;
    const cos = Math.cos(yaw), sin = Math.sin(yaw);
    const countFor = (lo: number, hi: number): number =>
        Math.min(9, Math.max(2, Math.ceil((hi - lo) / Math.max(step, 1e-3)) + 1));
    const nx = countFor(minX, maxX), nz = countFor(minZ, maxZ);

    const points: Array<{ x: number; z: number }> = [];
    for (let i = 0; i < nx; i++) {
        const lx = minX + ((maxX - minX) * i) / (nx - 1);
        for (let j = 0; j < nz; j++) {
            const lz = minZ + ((maxZ - minZ) * j) / (nz - 1);
            points.push({ x: x + cos * lx + sin * lz, z: z - sin * lx + cos * lz });
        }
    }
    return points;
}

/**
 * Height at which an object with this base footprint rests on the terrain: the
 * HIGHEST reading under the footprint, which is where a box collider of that shape
 * would settle — the object touches ground rather than hovering over the tallest
 * column beneath it.
 */
export function footprintGroundHeight(
    footprint: Readonly<BaseFootprint>,
    x: number,
    z: number,
    yaw: number,
    scaleX: number,
    scaleZ: number,
    step: number,
    sampleHeight: (x: number, z: number) => number,
): number {
    let highest = -Infinity;
    for (const p of footprintGroundSamples(footprint, x, z, yaw, scaleX, scaleZ, step)) {
        const h = sampleHeight(p.x, p.z);
        if (h > highest) highest = h;
    }
    return highest;
}

/**
 * Sphere ↔ AABB overlap test. Sphere center / radius² in the same frame
 * as the AABB. Standard "clamp center to box, compare squared distance".
 */
export function sphereIntersectsAabb(
    center: { x: number; y: number; z: number }, radiusSq: number,
    aabbMin: [number, number, number], aabbMax: [number, number, number],
): boolean {
    const cx = Math.max(aabbMin[0], Math.min(center.x, aabbMax[0]));
    const cy = Math.max(aabbMin[1], Math.min(center.y, aabbMax[1]));
    const cz = Math.max(aabbMin[2], Math.min(center.z, aabbMax[2]));
    const dx = center.x - cx, dy = center.y - cy, dz = center.z - cz;
    return (dx * dx + dy * dy + dz * dz) <= radiusSq;
}





