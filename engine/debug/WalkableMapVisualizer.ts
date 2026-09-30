import * as THREE from 'three';
import type { VoxelWorld } from 'engine/VoxelWorld.js';
import { VisibilityTileGrid, DEFAULT_TILE_SIZE } from './VisibilityTileGrid.js';
import { WalkableMapGpuBaker } from './WalkableMapGpuBaker.js';

export interface WalkableMapBounds {
    minX: number; minY: number; minZ: number;
    maxX: number; maxY: number; maxZ: number;
}

export interface WalkableMapOptions {
    /** Max metres climbed without a jump (small steps, ramps). */
    stepUp: number;
    /** Max metres climbed in one jump. */
    jumpUp: number;
    /** Max metres dropped in one step. */
    fallDown: number;
    /** Required empty space (metres) above a cell so the player capsule fits. */
    playerHeight: number;
    /**
     * Minimum eye height above a walkable cell — used by the visibility
     * (PVS) compute pass. Defaults to a crouched eye level so cover that
     * only blocks line-of-sight at full stance still hides things.
     */
    minEyeHeight: number;
    /**
     * Maximum eye height above a walkable cell — used by the visibility
     * (PVS) compute pass. Defaults to the eye level at a jump apex so a
     * jumping player can peek over ledges.
     */
    maxEyeHeight: number;
    /**
     * Optional ceiling on walkable Y, expressed as max metres ABOVE
     * `spawn.y`. The BFS rejects any candidate cell whose surface sits
     * higher than `spawn.y + maxYAboveSpawn`. Use when the voxel collider
     * has accidental high-up footholds (rooftops, ledges) that the
     * player shouldn't reach — clamping here shrinks the PVS and
     * therefore the prunable splat set. `Infinity` (default) disables.
     */
    maxYAboveSpawn: number;
}

export const DEFAULT_WALKABLE_MAP_OPTIONS: WalkableMapOptions = {
    stepUp: 0.6,
    jumpUp: 1.4,
    fallDown: 4.0,
    playerHeight: 1.8,
    minEyeHeight: 0.6,  // crouched eyeline (player ~1.1 tall when crouched, eyes ~0.6 above feet)
    maxEyeHeight: 2.5,  // standing height 1.65m + jump peak ~0.85m ≈ 2.5m eye level at apex
    maxYAboveSpawn: Infinity,
};

/**
 * Build & visualize the walkable map by flooding outward from the player
 * spawn. A cell is "walkable" if the player can physically reach it from
 * spawn, respecting step / jump / clearance limits — this is reachability,
 * not "topmost voxel". Building roofs and floating geometry the player
 * can't reach are correctly excluded.
 *
 * Cells are voxel-column footprints in (X, Z). Each visited cell gets a
 * translucent green quad in one InstancedMesh, drawn just above the
 * voxel surface so it's visible against the voxel chunks.
 */
/** Compact, post-bake snapshot of every walkable cell + the world it was built against. */
interface CellSet {
    /** Map<packedXZKey, surfaceY> — surface Y at the player's feet for each reachable cell. */
    cells: Map<number, number>;
    world: VoxelWorld;
    bounds: WalkableMapBounds;
    options: WalkableMapOptions;
}

const PVS_MAGIC = 0x53565057; // "WPVS" little-endian
// v3: per-tile visibility on a shared 3D tile grid (default 2 m cubes).
// Replaces v2's per-chunk PVS because chunk granularity scales with
// voxel size (collision resolution) rather than visibility coherence —
// fine voxels produced absurdly large PVS tables and over-coarse tiles
// for splat culling. v3 decouples visibility granularity from physics.
//
// The bake itself also changes in v3: instead of JS ray-marching (still
// minutes-to-hours for large scenes), we GPU-rasterize a tile-ID
// cubemap from each cell. Strictly conservative, seconds total.
const PVS_VERSION = 3;

export class WalkableMapVisualizer {
    private scene: THREE.Scene;
    private mesh: THREE.InstancedMesh | null = null;
    /** Cached snapshot from the last successful `generate(...)` so visibility/PVS passes can reuse it without re-running BFS. */
    private lastBake: CellSet | null = null;
    /** Last `computeVisibility(...)` result — kept in memory for queries (camera-cell PVS lookup) and for persistence. */
    private lastPvs: Map<number, Set<number>> | null = null;
    /** Tile grid the PVS keys are defined against. Set whenever a PVS is computed or loaded. */
    private lastTileGrid: VisibilityTileGrid | null = null;

    constructor(scene: THREE.Scene) {
        this.scene = scene;
    }

    /** True iff a walkable-map mesh has been generated (may be hidden). */
    get hasMesh(): boolean {
        return !!this.mesh;
    }

    /** True iff the walkable-map mesh exists AND is currently visible in the scene. */
    get visible(): boolean {
        return !!this.mesh && this.mesh.visible;
    }

    /** Toggle the existing walkable-map mesh on/off without rebuilding it. No-op if no mesh has been generated. */
    setVisible(v: boolean): void {
        if (this.mesh) this.mesh.visible = v;
    }

    generate(
        world: VoxelWorld,
        bounds: WalkableMapBounds,
        spawn: { x: number; y: number; z: number },
        options: Partial<WalkableMapOptions> = {},
    ): { cellCount: number } {
        const opts: WalkableMapOptions = { ...DEFAULT_WALKABLE_MAP_OPTIONS, ...options };
        const { stepUp, jumpUp, fallDown, playerHeight, maxYAboveSpawn } = opts;
        // Absolute Y ceiling derived from the spawn position. Anything
        // above this is rejected by the BFS (and findSurfaceNear) so the
        // walkable set stays a flat-ish slab around the spawn. Set to
        // Infinity by default to preserve the previous behaviour.
        const maxAllowedY = Number.isFinite(maxYAboveSpawn) ? spawn.y + maxYAboveSpawn : Infinity;
        // Step-up is a stricter limit for ramps that don't require a jump.
        // Above stepUp & below jumpUp counts as a jump-up edge — same
        // effect on reachability for now, kept distinct so future passes
        // can mark them differently.
        void stepUp;

        const vs = world.getVoxelSize();
        const clearanceVoxels = Math.max(1, Math.ceil(playerHeight / vs));

        // Cell coords: integer (cx, cz) where cx = floor((x - minX) / vs).
        // Pack to a 32-bit *unsigned* key for Set/Map. The trailing `>>> 0`
        // is load-bearing: bitwise `|` returns int32, and for any cz ≥ 0
        // the high word overflows into a negative number — which would
        // mismatch the uint32 keys written by `encodePvs` / read by
        // `decodePvs`, so post-reload PVS lookups would all miss.
        const GRID_OFFSET = 32768;
        const packXZ = (cx: number, cz: number): number => (((cz + GRID_OFFSET) * 65536) | (cx + GRID_OFFSET)) >>> 0;
        const xFromCx = (cx: number): number => bounds.minX + (cx + 0.5) * vs;
        const zFromCz = (cz: number): number => bounds.minZ + (cz + 0.5) * vs;
        const cxFromX = (x: number): number => Math.floor((x - bounds.minX) / vs);
        const czFromZ = (z: number): number => Math.floor((z - bounds.minZ) / vs);

        // Find a stand surface near refY in column (cx, cz). Scans the y
        // range [refY - fallDown, refY + jumpUp + extraUp] for a solid
        // voxel with an empty voxel directly above (=stand position). Picks
        // the surface closest to refY rather than the topmost — multi-level
        // buildings stay reachable.
        //
        // Pass requireClearance=false for the spawn snap, where the player
        // may spawn slightly inside a voxel or under a low ceiling and we
        // still want to find a foothold. BFS neighbours use true.
        const findSurfaceNear = (
            cx: number, cz: number, refY: number,
            requireClearance: boolean, extraUp: number = 0,
        ): number | null => {
            const wx = xFromCx(cx);
            const wz = zFromCz(cz);
            const yLo = Math.max(bounds.minY + vs * 0.5, refY - fallDown - vs);
            const yHi = Math.min(bounds.maxY - vs * 0.5, refY + jumpUp + extraUp + vs);
            let bestY: number | null = null;
            let bestDist = Infinity;
            for (let y = yLo; y <= yHi; y += vs) {
                if (world.getBlock(wx, y, wz) === 0) continue; // not solid
                if (world.getBlock(wx, y + vs, wz) !== 0) continue; // ceiling immediately above
                if (requireClearance) {
                    let blocked = false;
                    for (let k = 1; k <= clearanceVoxels; k++) {
                        if (world.getBlock(wx, y + k * vs, wz) !== 0) { blocked = true; break; }
                    }
                    if (blocked) continue;
                }
                const topY = y + vs * 0.5;
                const dist = Math.abs(topY - refY);
                if (dist < bestDist) { bestDist = dist; bestY = topY; }
            }
            return bestY;
        };

        // BFS state. `cellY` is both the visited set and the per-cell
        // surface-Y lookup so neighbour transitions check against the
        // player's feet at the previous cell, not the global topmost voxel.
        const cellY = new Map<number, number>();
        const queue: number[] = [];

        // Spawn-column scan: search the WHOLE column (huge tolerance), no
        // clearance requirement, pick the surface closest to spawn.y. This
        // handles "spawn is a bit above the floor" (snap down) and "spawn
        // is inside a voxel" (snap up to nearest exit).
        const startCx = cxFromX(spawn.x);
        const startCz = czFromZ(spawn.z);
        const spawnColumnHeight = bounds.maxY - bounds.minY;
        let seedCx = startCx;
        let seedCz = startCz;
        let seedY = findSurfaceNear(startCx, startCz, spawn.y, false, spawnColumnHeight);
        if (seedY === null) {
            // Spawn column has zero voxels. Sweep concentric rings so a
            // misplaced spawn next to a wall still succeeds.
            let found = false;
            for (let ring = 1; ring <= 5 && !found; ring++) {
                for (let dx = -ring; dx <= ring && !found; dx++) {
                    for (let dz = -ring; dz <= ring && !found; dz++) {
                        if (Math.abs(dx) !== ring && Math.abs(dz) !== ring) continue;
                        const y = findSurfaceNear(startCx + dx, startCz + dz, spawn.y, false, spawnColumnHeight);
                        if (y !== null) {
                            seedCx = startCx + dx;
                            seedCz = startCz + dz;
                            seedY = y;
                            found = true;
                            console.log(`[WalkableMap] Spawn column empty — snapped to neighbour cell (Δ=${dx},${dz})`);
                        }
                    }
                }
            }
            if (seedY === null) {
                console.warn(`[WalkableMap] No walkable surface near spawn (${spawn.x.toFixed(2)}, ${spawn.y.toFixed(2)}, ${spawn.z.toFixed(2)})`);
                this.clear();
                return { cellCount: 0 };
            }
        }
        cellY.set(packXZ(seedCx, seedCz), seedY);
        queue.push(seedCx, seedCz);
        let head = 0;

        const neighbors: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        while (head < queue.length) {
            const cx = queue[head]!;
            const cz = queue[head + 1]!;
            head += 2;
            const fromY = cellY.get(packXZ(cx, cz))!;

            for (const [dx, dz] of neighbors) {
                const ncx = cx + dx;
                const ncz = cz + dz;
                if (xFromCx(ncx) < bounds.minX || xFromCx(ncx) > bounds.maxX) continue;
                if (zFromCz(ncz) < bounds.minZ || zFromCz(ncz) > bounds.maxZ) continue;

                const nKey = packXZ(ncx, ncz);
                if (cellY.has(nKey)) continue;

                const nSurface = findSurfaceNear(ncx, ncz, fromY, true);
                if (nSurface === null) continue;

                const dy = nSurface - fromY;
                if (dy > jumpUp) continue;
                if (-dy > fallDown) continue;
                // Hard Y ceiling — drop cells more than `maxYAboveSpawn`
                // metres above the spawn point. Keeps the walkable set
                // flat for scenes where the voxel collider lets the
                // player accidentally reach rooftops or ledges.
                if (nSurface > maxAllowedY) continue;

                cellY.set(nKey, nSurface);
                queue.push(ncx, ncz);
            }
        }

        this.clear();
        const cellCount = cellY.size;
        if (cellCount === 0) return { cellCount: 0 };

        const geometry = new THREE.PlaneGeometry(vs * 0.9, vs * 0.9);
        geometry.rotateX(-Math.PI / 2);
        const material = new THREE.MeshBasicMaterial({
            color: 0x33ff66,
            transparent: true,
            opacity: 0.55,
            side: THREE.DoubleSide,
            depthWrite: false,
        });
        const mesh = new THREE.InstancedMesh(geometry, material, cellCount);
        mesh.name = 'WalkableMap';
        mesh.renderOrder = 1100;
        mesh.frustumCulled = true;
        const m = new THREE.Matrix4();
        let i = 0;
        for (const [key, y] of cellY) {
            const cx = (key & 0xFFFF) - GRID_OFFSET;
            const cz = ((key >>> 16) & 0xFFFF) - GRID_OFFSET;
            m.makeTranslation(xFromCx(cx), y + 0.02, zFromCz(cz));
            mesh.setMatrixAt(i++, m);
        }
        mesh.instanceMatrix.needsUpdate = true;
        this.scene.add(mesh);
        this.mesh = mesh;
        this.lastBake = { cells: cellY, world, bounds, options: opts };

        console.log(`✅ [WalkableMap] ${cellCount.toLocaleString()} reachable cells from spawn (${spawn.x.toFixed(2)}, ${spawn.y.toFixed(2)}, ${spawn.z.toFixed(2)})`);
        return { cellCount };
    }

    /**
     * Compute the **potentially-visible set (PVS)** for every walkable cell
     * via GPU rasterization. For each cell we render a six-face cubemap
     * from eye height with a tile-ID material; every fragment writes the
     * tile-ID of its world position into an RGBA8 buffer; the dedupe of
     * those pixel values is the cell's PVS. Strictly conservative — every
     * pixel the rasterizer covers is in the PVS, no random sampling.
     *
     * Delegates the GPU work to {@link WalkableMapGpuBaker}. Bake speed
     * is GPU-bound (~milliseconds per cell), so a 30k-cell scene finishes
     * in seconds rather than the hours v2's JS DDA bake needed.
     */
    async computeVisibility(samples: {
        /** Live game renderer — we render into its WebGL2 context so we don't blow Chrome's per-page context cap. */
        renderer: THREE.WebGLRenderer;
        /** Tile size in metres. Default 2 m (matches UE Precomputed Visibility's middle range). */
        tileSize?: number;
        /** Min eye height above surface. Default = bake's `options.minEyeHeight`. */
        minEyeHeight?: number;
        /** Max eye height above surface. Default = bake's `options.maxEyeHeight`. */
        maxEyeHeight?: number;
        /** Number of eye-height samples between min and max. Default 1 — GPU rasterization fills in lots of angles per sample. */
        eyeSamples?: number;
        /** Cubemap face resolution. Default 64². */
        faceResolution?: number;
        /** Progress callback `(done, total)`. */
        onProgress?: (done: number, total: number) => void;
    }): Promise<{ cellCount: number; tileCount: number; avgVisibleTiles: number; maxVisibleTiles: number; tileSize: number; minEye: number; maxEye: number; elapsedMs: number; pvs: Map<number, Set<number>> }> {
        if (!this.lastBake) throw new Error('[WalkableMap] computeVisibility called before generate — no walkable cells to process');
        const { cells, world, bounds, options } = this.lastBake;
        const tileSize = samples.tileSize ?? DEFAULT_TILE_SIZE;
        const eyeSamples = Math.max(1, samples.eyeSamples ?? 1);
        const minEye = samples.minEyeHeight ?? options.minEyeHeight;
        const maxEye = samples.maxEyeHeight ?? options.maxEyeHeight;

        const tileGrid = new VisibilityTileGrid(bounds, tileSize);
        const baker = new WalkableMapGpuBaker();
        baker.setRenderer(samples.renderer);

        try {
            const result = await baker.bake({
                world,
                cells,
                tileGrid,
                cellOriginX: bounds.minX,
                cellOriginZ: bounds.minZ,
                voxelSize: world.getVoxelSize(),
                minEyeHeight: minEye,
                maxEyeHeight: maxEye,
                eyeSamples,
                faceResolution: samples.faceResolution,
                onProgress: samples.onProgress,
            });

            let totalVisible = 0;
            let maxVisible = 0;
            for (const set of result.pvs.values()) {
                totalVisible += set.size;
                if (set.size > maxVisible) maxVisible = set.size;
            }
            const totalCells = result.pvs.size;
            const avgVisibleTiles = totalCells > 0 ? totalVisible / totalCells : 0;
            console.log(`✅ [WalkableMap] PVS v3 GPU: ${totalCells.toLocaleString()} cells × tileSize=${tileSize.toFixed(2)}m × ${eyeSamples} eyes = ${result.totalTilesRendered.toLocaleString()} tile pixels in ${result.elapsedMs.toFixed(0)}ms; avg ${avgVisibleTiles.toFixed(1)} tiles/cell, max ${maxVisible.toLocaleString()}`);
            this.lastPvs = result.pvs;
            this.lastTileGrid = tileGrid;
            return {
                cellCount: totalCells,
                tileCount: result.totalTilesRendered,
                avgVisibleTiles,
                maxVisibleTiles: maxVisible,
                tileSize,
                minEye,
                maxEye,
                elapsedMs: result.elapsedMs,
                pvs: result.pvs,
            };
        } finally {
            baker.dispose();
        }
    }

    /** True iff a PVS bake exists in memory (either freshly computed or restored from a saved file). */
    get hasPvs(): boolean { return this.lastPvs !== null && this.lastPvs.size > 0; }

    /** Number of cells in the current PVS (0 if none). */
    get pvsCellCount(): number { return this.lastPvs?.size ?? 0; }

    /** Bounds of the last bake — read by external culling code to translate camera position → cell index. */
    get bounds(): WalkableMapBounds | null { return this.lastBake?.bounds ?? null; }

    /** Visible-tile set (packed tile keys) for a single cell, or null if no PVS / no entry for that cell. */
    pvsForCell(cellKey: number): Set<number> | null { return this.lastPvs?.get(cellKey) ?? null; }

    /** Tile grid the current PVS keys are defined against (null if no PVS computed/loaded). */
    get tileGrid(): VisibilityTileGrid | null { return this.lastTileGrid; }

    /** True iff the given (cx, cz) cell key exists in the walkable map. */
    hasCell(cellKey: number): boolean { return this.lastBake?.cells.has(cellKey) ?? false; }

    /** Read-only access to the cell set; consumers iterate for nearest-cell searches. */
    get cells(): ReadonlyMap<number, number> | null { return this.lastBake?.cells ?? null; }

    /**
     * Serialize the current PVS to a compact binary buffer. v3 layout
     * (little-endian, no padding):
     *
     *   header (32 B):  u32 magic ("WPVS"), u32 version=3, u32 cellCount,
     *                   u32 totalEntries, f32 tileSize, f32 originX,
     *                   f32 originY, f32 originZ
     *   per cell:       u32 cellKey, u32 tileCount, tileCount × (3 × u8) raw (R, G, B)
     *
     * Tile keys are stored as their packed 24-bit form (R = tx+128,
     * G = ty+128, B = tz+128). Three bytes per tile and only a few hundred
     * tiles per cell typically — total file size is well under 1 MB for
     * scenes that produced 15 MB under v1.
     */
    encodePvs(): Uint8Array | null {
        if (!this.lastPvs || this.lastPvs.size === 0 || !this.lastTileGrid) return null;
        const grid = this.lastTileGrid;
        let totalEntries = 0;
        for (const set of this.lastPvs.values()) totalEntries += set.size;

        const headerBytes = 32;
        const perCellBytes = 8;
        const perTileBytes = 3;
        const totalBytes = headerBytes + this.lastPvs.size * perCellBytes + totalEntries * perTileBytes;
        const buffer = new ArrayBuffer(totalBytes);
        const view = new DataView(buffer);
        let off = 0;
        view.setUint32(off, PVS_MAGIC, true); off += 4;
        view.setUint32(off, PVS_VERSION, true); off += 4;
        view.setUint32(off, this.lastPvs.size, true); off += 4;
        view.setUint32(off, totalEntries, true); off += 4;
        view.setFloat32(off, grid.tileSize, true); off += 4;
        view.setFloat32(off, grid.originX, true); off += 4;
        view.setFloat32(off, grid.originY, true); off += 4;
        view.setFloat32(off, grid.originZ, true); off += 4;

        for (const [cellKey, tileSet] of this.lastPvs) {
            view.setUint32(off, cellKey >>> 0, true); off += 4;
            view.setUint32(off, tileSet.size, true); off += 4;
            for (const packedTile of tileSet) {
                // Tile keys pack as (tz+128)<<16 | (ty+128)<<8 | (tx+128).
                // Store as 3 raw u8 — load reads the same 3 bytes back
                // and reassembles into a single packed number.
                view.setUint8(off, packedTile & 0xFF); off += 1;
                view.setUint8(off, (packedTile >>> 8) & 0xFF); off += 1;
                view.setUint8(off, (packedTile >>> 16) & 0xFF); off += 1;
            }
        }
        return new Uint8Array(buffer);
    }

    /** Restore a PVS from a buffer produced by `encodePvs`. Replaces any existing in-memory PVS and tile grid. */
    decodePvs(buffer: ArrayBuffer | Uint8Array): { cellCount: number; totalEntries: number } {
        const ab = buffer instanceof Uint8Array ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) : buffer;
        const view = new DataView(ab);
        let off = 0;
        const magic = view.getUint32(off, true); off += 4;
        if (magic !== PVS_MAGIC) throw new Error(`[WalkableMap] PVS magic mismatch — expected WPVS, got 0x${magic.toString(16)}`);
        const version = view.getUint32(off, true); off += 4;
        if (version !== PVS_VERSION) throw new Error(`[WalkableMap] PVS version ${version} not supported — only v${PVS_VERSION}. The format changed to tile-grain visibility on a shared grid; please recompute visibility on this scene.`);
        const cellCount = view.getUint32(off, true); off += 4;
        const totalEntries = view.getUint32(off, true); off += 4;
        const tileSize = view.getFloat32(off, true); off += 4;
        const originX = view.getFloat32(off, true); off += 4;
        const originY = view.getFloat32(off, true); off += 4;
        const originZ = view.getFloat32(off, true); off += 4;

        const pvs = new Map<number, Set<number>>();
        for (let c = 0; c < cellCount; c++) {
            const cellKey = view.getUint32(off, true); off += 4;
            const tileCount = view.getUint32(off, true); off += 4;
            const set = new Set<number>();
            for (let v = 0; v < tileCount; v++) {
                const r = view.getUint8(off); off += 1;
                const g = view.getUint8(off); off += 1;
                const b = view.getUint8(off); off += 1;
                const packed = ((b << 16) | (g << 8) | r) >>> 0;
                set.add(packed);
            }
            pvs.set(cellKey, set);
        }
        this.lastPvs = pvs;
        // Rebuild the tile grid from the header so the culler can map
        // chunks → tiles without re-running the bake. The min* corner
        // already lives in originXYZ; the rest of the bounds aren't
        // required at runtime since the grid is unbounded by design.
        this.lastTileGrid = new VisibilityTileGrid(
            { minX: originX, minY: originY, minZ: originZ, maxX: originX, maxY: originY, maxZ: originZ },
            tileSize,
        );
        console.log(`✅ [WalkableMap] Loaded PVS: ${cellCount.toLocaleString()} cells, ${totalEntries.toLocaleString()} visibility entries (tileSize=${tileSize.toFixed(2)}m)`);
        return { cellCount, totalEntries };
    }

    clear(): void {
        if (!this.mesh) return;
        this.scene.remove(this.mesh);
        this.mesh.geometry.dispose();
        (this.mesh.material as THREE.Material).dispose();
        this.mesh = null;
        // Invalidate the cached PVS — it's keyed to the cells that were
        // just removed and would silently mismatch any newer bake.
        this.lastPvs = null;
        this.lastTileGrid = null;
    }

    /**
     * Serialize the most recent bake to a JSON-able shape. Returns null
     * if no walkable map has been generated yet. The format is the
     * canonical wire format for `/api/save-collider-file` and for
     * `WalkableMapVisualizer.loadFromData(...)`.
     *
     * Stored cells are flat triples `[cx, cz, y]` — 3 numbers per cell —
     * so a 100k-cell map serialises to ~2 MB JSON / ~300 KB gzipped.
     */
    toJSON(): WalkableMapFileV1 | null {
        if (!this.lastBake) return null;
        const { cells, bounds, options } = this.lastBake;
        const flat: number[] = [];
        for (const [key, y] of cells) {
            const GRID_OFFSET = 32768;
            const cx = (key & 0xFFFF) - GRID_OFFSET;
            const cz = ((key >>> 16) & 0xFFFF) - GRID_OFFSET;
            flat.push(cx, cz, y);
        }
        return {
            version: 1,
            voxelSize: this.lastBake.world.getVoxelSize(),
            bounds: { ...bounds },
            options: { ...options },
            cellCount: cells.size,
            cells: flat,
        };
    }

    /**
     * Populate the visualizer from a previously-saved file and render the
     * cells as an InstancedMesh. The caller supplies the live VoxelWorld
     * so future passes (PVS, etc.) can re-use it. The file's `bounds` are
     * trusted as-is — they must match the world's bounds, which they will
     * if the file was saved from this same voxel collider.
     */
    loadFromData(data: WalkableMapFileV1, world: VoxelWorld): { cellCount: number } {
        if (data.version !== 1) {
            console.warn(`[WalkableMap] Unsupported file version ${data.version}; expected 1`);
            return { cellCount: 0 };
        }
        const cellY = new Map<number, number>();
        const GRID_OFFSET = 32768;
        const flat = data.cells;
        for (let i = 0; i < flat.length; i += 3) {
            const cx = flat[i]!;
            const cz = flat[i + 1]!;
            const y = flat[i + 2]!;
            const key = (((cz + GRID_OFFSET) * 65536) | (cx + GRID_OFFSET)) >>> 0;
            cellY.set(key, y);
        }
        const vs = data.voxelSize;
        const bounds = data.bounds;

        this.clear();
        const cellCount = cellY.size;
        if (cellCount === 0) return { cellCount: 0 };

        const geometry = new THREE.PlaneGeometry(vs * 0.9, vs * 0.9);
        geometry.rotateX(-Math.PI / 2);
        const material = new THREE.MeshBasicMaterial({
            color: 0x33ff66,
            transparent: true,
            opacity: 0.55,
            side: THREE.DoubleSide,
            depthWrite: false,
        });
        const mesh = new THREE.InstancedMesh(geometry, material, cellCount);
        mesh.name = 'WalkableMap';
        mesh.renderOrder = 1100;
        mesh.frustumCulled = true;
        const m = new THREE.Matrix4();
        let i = 0;
        for (const [key, y] of cellY) {
            const cx = (key & 0xFFFF) - GRID_OFFSET;
            const cz = ((key >>> 16) & 0xFFFF) - GRID_OFFSET;
            const wx = bounds.minX + (cx + 0.5) * vs;
            const wz = bounds.minZ + (cz + 0.5) * vs;
            m.makeTranslation(wx, y + 0.02, wz);
            mesh.setMatrixAt(i++, m);
        }
        mesh.instanceMatrix.needsUpdate = true;
        this.scene.add(mesh);
        this.mesh = mesh;
        this.lastBake = {
            cells: cellY,
            world,
            bounds,
            options: { ...DEFAULT_WALKABLE_MAP_OPTIONS, ...data.options },
        };
        console.log(`✅ [WalkableMap] Loaded ${cellCount.toLocaleString()} walkable cells from saved file`);
        return { cellCount };
    }
}

/**
 * On-disk format for a saved walkable map. v1 keeps everything readable:
 * cells are a flat `[cx, cz, y]` triple array, bounds + options + voxel
 * size live in the header so a load doesn't need any context beyond the
 * file + the VoxelWorld it was saved against. Encoded as JSON and saved
 * via the existing `/api/save-collider-file` endpoint.
 */
export interface WalkableMapFileV1 {
    version: 1;
    voxelSize: number;
    bounds: WalkableMapBounds;
    options: WalkableMapOptions;
    cellCount: number;
    /** Flat `[cx0, cz0, y0, cx1, cz1, y1, ...]` — 3 numbers per cell. */
    cells: number[];
}

