/**
 * Per-frame PVS culling for the voxel-chunk visualization. Looks up the
 * walkable cell closest to the camera, reads that cell's visible-tile
 * set from the PVS (v3 stores tile keys on a shared visibility grid),
 * and hides every chunk whose AABB doesn't overlap any visible tile.
 *
 * Polls at ~10 Hz — full per-frame is overkill since the cell only
 * changes when the camera moves into a new (X, Z) column. Update is cheap
 * once a frame: O(chunkCount × tilesPerChunk) which is small.
 */
import * as THREE from 'three';
import type { VoxelWorld } from 'engine/VoxelWorld.js';
import type { WalkableMapVisualizer } from './WalkableMapVisualizer.js';
import { CHUNK_SIZE } from 'engine/VoxelGeometry.js';
import type { VisibilityTileGrid } from './VisibilityTileGrid.js';

/**
 * Structural view of one splat PVS grid cell — implemented by the splat side
 * (`SplatPvsGrid`'s `SplatGridCell`). Declared here so the culler can drive
 * splat grids WITHOUT importing splat code, keeping the PVS subsystem
 * geometry-agnostic and splat-free.
 */
export interface SplatPvsGridCellLike {
    gsplatCount: number;
    attached: boolean;
    worldAabb: THREE.Box3;
    mesh: { forEachSplat(cb: (index: number, center: THREE.Vector3, scales: THREE.Vector3, quaternion: THREE.Quaternion, opacity: number) => void): void };
}

/** Structural view of a splat PVS grid — implemented by the splat side's `SplatPvsGrid`. */
export interface SplatPvsGridLike {
    readonly cells: SplatPvsGridCellLike[];
    readonly splatToWorld: THREE.Matrix4;
    setPvsCullingActive(active: boolean): void;
    setVisibleTiles(visibleTiles: ReadonlySet<number>, tileGrid: VisibilityTileGrid): void;
    rebuildCells(keep: (center: THREE.Vector3, scales: THREE.Vector3, quaternion: THREE.Quaternion, opacity: number, color: THREE.Color) => boolean): { kept: number; removed: number; cellsRemoved: number };
}

/** Surface area a renderer must expose so the culler can drive its per-cell splat visibility. */
export interface SplatPvsRendererTarget {
    getSplatPvsGrid?: () => SplatPvsGridLike | null;
    getVoxelWorld?: () => VoxelWorld | null;
}

const GRID_OFFSET = 32768;
// `>>> 0` forces the result to uint32. Without it, bitwise `|` returns a signed
// int32 — and for any cz ≥ 0 the high-word `(cz+OFF)*65536` already exceeds
// 2³¹−1, so the result wraps to a *negative* number. The PVS file format stores
// keys as uint32 (encode side does `cellKey >>> 0`), so a Map keyed by signed
// in-memory packs won't match the loaded PVS map — every lookup misses and the
// culler hides nothing (or everything). Must stay in sync with the matching
// `packXZ` in WalkableMapVisualizer.
const packXZ = (cx: number, cz: number): number => (((cz + GRID_OFFSET) * 65536) | (cx + GRID_OFFSET)) >>> 0;

/** Result of `analyzePvsPruning` — see method for semantics. Aggregates totals across all splat renderers. */
export interface PvsPruningReport {
    /** Number of walkable cells contributing to the PVS union. */
    walkableCells: number;
    /** Total distinct tiles reachable from any walkable cell. */
    everVisibleTiles: number;
    /** Total gsplats across every splat grid currently built. */
    gsplatsTotal: number;
    /** Gsplats sitting in cells whose world AABB doesn't overlap any ever-visible tile. */
    gsplatsPrunable: number;
    /** Total splat-grid cells across every splat grid. */
    cellsTotal: number;
    /** Cells fully outside the PVS union. */
    cellsPrunable: number;
    /** Per-renderer breakdown — useful when the scene has multiple splats. */
    perRenderer: Array<{ gsplatsTotal: number; gsplatsPrunable: number; cellsTotal: number; cellsPrunable: number }>;
    /**
     * Per-splat analysis (iterates every gsplat, transforms its center to
     * world, looks up the tile). Tighter than the cell-level prunable
     * count — a cell that overlaps a visible tile can still contain
     * splats whose individual centers are in never-visible tiles. Adds
     * scale/opacity breakdowns so we can spot fill-rate suspects (large
     * low-opacity background splats).
     */
    perSplat: {
        analysed: number;
        centerInsidePvs: number;
        centerOutsidePvs: number;
        /** Of the outside-PVS set: opacity < 0.2 (safest to drop — barely contributes anywhere). */
        prunableLowOpacity: number;
        /** Of the outside-PVS set: opacity ≥ 0.2 (still droppable since center never visible, but contributes more if it WERE seen). */
        prunableHighOpacity: number;
        /** Of the inside-PVS set: max object-space scale > 0.5 AND opacity < 0.2. These are the "background causes fill" suspects the user hypothesised. */
        largeLowOpacityVisible: number;
        /** Wall-clock time for the per-splat loop, ms. Run on the main thread (one-shot), so we report it. */
        analysisMs: number;
    };
}

export interface PvsCullerStats {
    enabled: boolean;
    /** Total chunks that have a collisionMesh (whether shown or hidden). */
    totalChunks: number;
    /** Chunks currently shown by the culler. */
    visibleChunks: number;
    /** Chunks currently hidden by the culler. */
    hiddenChunks: number;
    /** How many neighbour walkable cells contributed to the current PVS union. */
    cellsUnioned: number;
    /** Camera-cell XZ coordinates (voxel-grid indices). */
    cellX: number;
    cellZ: number;
    /** Sum of splat-grid cells across all renderers (whether attached or detached). 0 when no splat grids exist. */
    splatCellsTotal: number;
    /** Sum of currently-attached splat-grid cells across all renderers. */
    splatCellsVisible: number;
    /** Sum of gsplats across all splat grids (over all cells). 0 when no splat grids exist. */
    splatGaussiansTotal: number;
    /** Sum of gsplats in currently-attached cells. This is the value Spark actually sorts/rasterises each frame. */
    splatGaussiansVisible: number;
}

export class VoxelPvsCuller {
    private camera: THREE.Camera;
    private getActiveWorld: () => VoxelWorld | null;
    private getWalkableMap: () => WalkableMapVisualizer | null;
    private intervalId: ReturnType<typeof setInterval> | null = null;
    private lastCellKey: number = -1;
    /** Tracks the user's per-row Voxels intent so we re-evaluate when it flips back on. */
    private lastChunksVisibleFlag: boolean = true;
    private enabled: boolean = false;
    /**
     * Debug freeze. When true, `tick()` is a no-op — the last-computed
     * voxel-chunk visibility AND splat-grid cell attachments stay
     * exactly as they were when the lock engaged. Lets the user
     * stand inside the scene, lock, then fly out and inspect "what was
     * the PVS actually keeping?" — the camera-frustum culling test
     * stays alive in the renderer, but the PVS gate doesn't move.
     */
    private locked: boolean = false;
    /** Renderer enumerator (set by the editor). Returns the renderers that own splat grids the culler should drive each tick. */
    private getSplatRenderers: () => SplatPvsRendererTarget[] = () => [];
    private lastStats: PvsCullerStats = {
        enabled: false,
        totalChunks: 0,
        visibleChunks: 0,
        hiddenChunks: 0,
        cellsUnioned: 0,
        cellX: 0,
        cellZ: 0,
        splatCellsTotal: 0,
        splatCellsVisible: 0,
        splatGaussiansTotal: 0,
        splatGaussiansVisible: 0,
    };

    /**
     * Walk every splat grid we drive and aggregate cell- and gsplat-level
     * visibility totals. Cheap (linear over total cells, ~thousands max) so
     * we just recompute on every stats write rather than caching. Returns
     * zeroes when no renderer has a grid yet — the panel uses that to hide
     * the splat row for splat-less games.
     */
    private aggregateSplatStats(): { cellsTotal: number; cellsVisible: number; gaussiansTotal: number; gaussiansVisible: number } {
        let cellsTotal = 0, cellsVisible = 0, gaussiansTotal = 0, gaussiansVisible = 0;
        for (const r of this.getSplatRenderers()) {
            const g = r.getSplatPvsGrid?.();
            if (!g) continue;
            cellsTotal += g.cells.length;
            for (const cell of g.cells) {
                gaussiansTotal += cell.gsplatCount;
                if (cell.attached) {
                    cellsVisible++;
                    gaussiansVisible += cell.gsplatCount;
                }
            }
        }
        return { cellsTotal, cellsVisible, gaussiansTotal, gaussiansVisible };
    }

    constructor(
        camera: THREE.Camera,
        getActiveWorld: () => VoxelWorld | null,
        getWalkableMap: () => WalkableMapVisualizer | null,
    ) {
        this.camera = camera;
        this.getActiveWorld = getActiveWorld;
        this.getWalkableMap = getWalkableMap;
    }

    /**
     * Wire the splat-renderer enumerator so the culler can attach its PVS
     * shader modifier to live SplatMeshes. Called once by the editor on
     * construction; takes a getter so the renderer list can change over
     * time (load/dispose).
     */
    setSplatRenderersAccessor(getSplatRenderers: () => SplatPvsRendererTarget[]): void {
        this.getSplatRenderers = getSplatRenderers;
    }

    /**
     * Start culling. Safe to call repeatedly; the second call is a no-op.
     * Re-evaluates which cell the camera is in every 100 ms and updates
     * chunk visibility only when the cell changes. Does NOT force the
     * world's chunks visible — the user's per-row "Voxels" toggle remains
     * authoritative for whether voxels render at all; PVS culling only
     * decides which of the user-shown chunks survive the visibility test.
     */
    enable(): void {
        if (this.enabled) return;
        this.enabled = true;
        this.lastCellKey = -1;
        this.intervalId = setInterval(() => this.tick(), 100);
        // Splat-grid culling on every renderer that has one. Grids may
        // not exist yet (splat still loading); the first non-empty tick
        // will catch them via `tick()`'s renderer scan.
        for (const r of this.getSplatRenderers()) {
            r.getSplatPvsGrid?.()?.setPvsCullingActive(true);
        }
        console.log('[PVS-cull] Enabled; tick=100ms');
        // Force an immediate tick so the user sees the culling take effect
        // without waiting up to 100 ms for the first interval.
        this.tick();
    }

    disable(): void {
        if (!this.enabled) return;
        this.enabled = false;
        if (this.intervalId !== null) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        // Restore PVS-hidden chunks to the user's intended visibility:
        // if the per-row "Voxels" toggle currently wants voxels shown,
        // they come back; if not, they stay hidden. Reading the flag via
        // a fresh `getChunks()` walk avoids a dependency on `VoxelWorld`
        // internals.
        const world = this.getActiveWorld();
        let total = 0;
        let visible = 0;
        if (world) {
            const wantVisible = world.areChunksVisible();
            for (const chunk of world.getChunks().values()) {
                if (chunk.collisionMesh) {
                    chunk.collisionMesh.visible = wantVisible;
                    total++;
                    if (wantVisible) visible++;
                }
            }
        }
        this.lastCellKey = -1;
        const sp = this.aggregateSplatStats();
        this.lastStats = {
            enabled: false,
            totalChunks: total,
            visibleChunks: visible,
            hiddenChunks: total - visible,
            cellsUnioned: 0,
            cellX: 0,
            cellZ: 0,
            splatCellsTotal: sp.cellsTotal,
            splatCellsVisible: sp.cellsVisible,
            splatGaussiansTotal: sp.gaussiansTotal,
            splatGaussiansVisible: sp.gaussiansVisible,
        };
        // Switch every splat grid back to "show all cells" — visibility
        // culling off means render the whole splat, regardless of cell.
        for (const r of this.getSplatRenderers()) {
            r.getSplatPvsGrid?.()?.setPvsCullingActive(false);
        }
        console.log(`[PVS-cull] Disabled — chunks restored to user's "Voxels" toggle (${visible}/${total} visible)`);
    }

    /**
     * Push the current PVS state into every renderer's splat grid. Each
     * grid decides per-cell visibility from its precomputed tile-overlap
     * cache. Cheap to call every tick — the per-cell tile lookup is
     * cached after the first call, so subsequent ticks are pure
     * `Set.has` over a small array per cell.
     */
    private updateSplatGrids(visibleTiles: ReadonlySet<number>): void {
        const wm = this.getWalkableMap();
        const tg = wm?.tileGrid;
        if (!tg) return;
        for (const r of this.getSplatRenderers()) {
            const g = r.getSplatPvsGrid?.();
            if (!g) continue;
            g.setPvsCullingActive(this.enabled);
            g.setVisibleTiles(visibleTiles, tg);
        }
    }

    /**
     * Release per-grid PVS state. Called from `clearActivePvs` when the
     * user deletes the PVS bake — the grids stay (they're owned by the
     * renderer) but stop gating on stale visibility data.
     */
    clearSplatHandle(): void {
        for (const r of this.getSplatRenderers()) {
            r.getSplatPvsGrid?.()?.setPvsCullingActive(false);
        }
    }

    isEnabled(): boolean { return this.enabled; }

    /**
     * Freeze / un-freeze the PVS evaluation. Toggling off invalidates
     * the last-cell cache so the next tick re-evaluates from the
     * camera's current position (otherwise the cache short-circuit
     * would skip the first un-frozen tick when the camera happens to
     * already match `lastCellKey`).
     */
    setLocked(locked: boolean): void {
        if (this.locked === locked) return;
        this.locked = locked;
        if (!locked) this.lastCellKey = -1;
        console.log(`[PVS-cull] Lock ${locked ? 'engaged — visibility frozen' : 'released — tracking camera again'}`);
    }

    isLocked(): boolean { return this.locked; }

    /** Snapshot of the last culling tick's outcome — drives the debug HUD readout. */
    getLastStats(): PvsCullerStats {
        return { ...this.lastStats, enabled: this.enabled };
    }

    /**
     * Find the walkable cell whose XZ centre is closest to the camera
     * (ignoring Y) and toggle chunk visibility based on its PVS. Skips
     * the work if the cell hasn't changed since last tick — the common
     * case while the user is rotating in place.
     */
    private tick(): void {
        // Frozen: leave every cell where it is. Debug tool for verifying
        // PVS correctness — lock from inside, fly out, inspect what
        // survived.
        if (this.locked) return;
        const world = this.getActiveWorld();
        const wm = this.getWalkableMap();
        if (!world || !wm || !wm.hasPvs) {
            console.log(`[PVS-cull] No world/walkableMap/PVS — skip tick (world=${!!world} wm=${!!wm} hasPvs=${wm?.hasPvs ?? false})`);
            return;
        }
        // Note: per-row "Voxels" toggle gates the voxel-chunk visibility
        // update later in this tick — the splat-side modifier still gets
        // its visibility set fed every tick so the gaussians cull
        // independently of whether the user wants the colored voxel
        // colliders shown. Track the flag so we can force a re-evaluation
        // (i.e. discard the lastCellKey short-circuit) the moment voxels
        // come back on after being off.
        const wantChunksVisible = world.areChunksVisible();
        if (wantChunksVisible && !this.lastChunksVisibleFlag) {
            this.lastCellKey = -1;
        }
        this.lastChunksVisibleFlag = wantChunksVisible;
        const bounds = wm.bounds;
        const cells = wm.cells;
        if (!bounds || !cells) return;

        const vs = world.getVoxelSize();
        const cx = Math.floor((this.camera.position.x - bounds.minX) / vs);
        const cz = Math.floor((this.camera.position.z - bounds.minZ) / vs);
        let nearestKey = packXZ(cx, cz);
        if (!wm.hasCell(nearestKey)) {
            // Widen the search radius — the user often flies up high above
            // the splat or to the side; the closest walkable cell can be
            // many voxel-cells away in XZ. 64 voxel-cells at 0.3m = 19.2m.
            nearestKey = this.findNearestCellKey(cells, cx, cz, 64);
            if (nearestKey === -1) {
                console.log(`[PVS-cull] No walkable cell within 64 cells of camera (${this.camera.position.x.toFixed(1)}, ${this.camera.position.z.toFixed(1)}) — leaving chunks as-is`);
                return;
            }
        }
        if (nearestKey === this.lastCellKey) return;
        this.lastCellKey = nearestKey;

        // Union PVS over a 3×3 horizontal neighbourhood around the camera
        // cell. GPU rasterization is strictly conservative, but a small
        // union still helps when the player straddles a cell boundary or
        // peeks around a corner — the eye position briefly belongs to a
        // cell that lacks PVS to a tile the *next* cell sees. Radius=1
        // is cheap (9 lookups) and removes residual edge-flicker.
        const NEIGHBOUR_RADIUS = 1;
        const camCx = (nearestKey & 0xFFFF) - GRID_OFFSET;
        const camCz = ((nearestKey >>> 16) & 0xFFFF) - GRID_OFFSET;
        const tileGrid = wm.tileGrid;
        if (!tileGrid) {
            console.warn('[PVS-cull] PVS loaded but tile grid is missing — was decodePvs called? Skipping.');
            return;
        }
        const visibleTiles = new Set<number>();
        let cellsUnioned = 0;
        for (let dx = -NEIGHBOUR_RADIUS; dx <= NEIGHBOUR_RADIUS; dx++) {
            for (let dz = -NEIGHBOUR_RADIUS; dz <= NEIGHBOUR_RADIUS; dz++) {
                const nKey = packXZ(camCx + dx, camCz + dz);
                const pvs = wm.pvsForCell(nKey);
                if (!pvs) continue;
                cellsUnioned++;
                for (const tileKey of pvs) visibleTiles.add(tileKey);
            }
        }

        // Safety net: empty PVS union → leave chunks alone. The bake
        // covered the scene at this cell, but the unioned neighbours had
        // no tile entries at all (shouldn't happen in practice — only
        // possible if the cell snapped to a never-rendered island).
        if (visibleTiles.size === 0) {
            let total = 0;
            for (const chunk of world.getChunks().values()) if (chunk.collisionMesh) total++;
            const sp = this.aggregateSplatStats();
            this.lastStats = {
                enabled: true,
                totalChunks: total,
                visibleChunks: total,
                hiddenChunks: 0,
                cellsUnioned,
                cellX: cx,
                cellZ: cz,
                splatCellsTotal: sp.cellsTotal,
                splatCellsVisible: sp.cellsVisible,
                splatGaussiansTotal: sp.gaussiansTotal,
                splatGaussiansVisible: sp.gaussiansVisible,
            };
            console.warn(`[PVS-cull] Empty PVS for cell=(${cx},${cz}) after unioning ${cellsUnioned} neighbour cells — skipping update (chunks unchanged)`);
            return;
        }

        // Splat-side culling — same visible-tile set fed to each grid;
        // the grid flips per-cell `.visible` so Spark skips the sort and
        // draw for hidden cells entirely.
        this.updateSplatGrids(visibleTiles);

        // For each chunk, compute its world AABB and ask the tile grid
        // which tiles it overlaps; show the chunk iff at least one of
        // those tiles is in the visible-tile set, AND the user wants
        // voxels visible at all. The tile-AABB lookup is small (typically
        // 1–8 tiles per chunk at 2 m tiles / ~3 m chunks), so the
        // per-chunk cost is constant.
        const chunkSize = CHUNK_SIZE * vs;
        const tilesScratch: number[] = [];
        let hidden = 0, shown = 0;
        for (const [key, chunk] of world.getChunks()) {
            if (!chunk.collisionMesh) continue;
            const parts = key.split(',');
            const ccx = parseInt(parts[0]!, 10);
            const ccy = parseInt(parts[1]!, 10);
            const ccz = parseInt(parts[2]!, 10);
            const minX = bounds.minX + ccx * chunkSize;
            const minY = bounds.minY + ccy * chunkSize;
            const minZ = bounds.minZ + ccz * chunkSize;
            tilesScratch.length = 0;
            tileGrid.tilesOverlappingAabb(minX, minY, minZ, minX + chunkSize, minY + chunkSize, minZ + chunkSize, tilesScratch);
            let chunkVisible = false;
            for (let i = 0; i < tilesScratch.length; i++) {
                if (visibleTiles.has(tilesScratch[i]!)) { chunkVisible = true; break; }
            }
            // Honour the per-row "Voxels" toggle — when it's off the
            // chunks must stay hidden regardless of the PVS decision.
            chunkVisible = chunkVisible && wantChunksVisible;
            chunk.collisionMesh.visible = chunkVisible;
            if (chunkVisible) shown++; else hidden++;
        }
        // Splat-grid stats: each renderer reports how many of its cells
        // are still visible after the PVS filter. If "splat=N/N" stays
        // 100% the cell size is too coarse vs. the tile granularity —
        // no perf saving because no sort is being skipped. We also sum
        // gsplats over attached cells so the debug panel can show the
        // actual workload Spark is being handed each frame (the cell-count
        // ratio alone misleads when cell density varies).
        const sp = this.aggregateSplatStats();
        this.lastStats = {
            enabled: true,
            totalChunks: shown + hidden,
            visibleChunks: shown,
            hiddenChunks: hidden,
            cellsUnioned,
            cellX: cx,
            cellZ: cz,
            splatCellsTotal: sp.cellsTotal,
            splatCellsVisible: sp.cellsVisible,
            splatGaussiansTotal: sp.gaussiansTotal,
            splatGaussiansVisible: sp.gaussiansVisible,
        };
        const splatPart = sp.cellsTotal > 0
            ? ` splat=${sp.cellsVisible}/${sp.cellsTotal} cells, ${sp.gaussiansVisible.toLocaleString()}/${sp.gaussiansTotal.toLocaleString()} gsplats`
            : ' splat=<no grid>';
        console.log(`[PVS-cull] cell=(${cx},${cz}) unioned=${cellsUnioned} cells → ${visibleTiles.size} tiles → chunks shown=${shown} hidden=${hidden}${splatPart}`);
    }

    /**
     * Diagnostic: estimate how many gsplats sit entirely outside every
     * walkable cell's PVS — i.e. tiles that no player position can ever
     * see — and therefore could be deleted from the source SPZ without
     * affecting visible quality. **Cell-granular**, so the count is a
     * conservative lower bound (a partly-visible cell keeps all its
     * splats even if individual splats inside it land in never-visible
     * tiles). Adaptive subdivision already keeps cells small (≤ cap), so
     * the slack is bounded.
     *
     * Returns null with a reason string when prerequisites are missing
     * (no walkable map, no PVS bake, no grid). Pure read — no side
     * effects on the scene or grid state.
     */
    analyzePvsPruning(): PvsPruningReport | { error: string } {
        const wm = this.getWalkableMap();
        if (!wm) return { error: 'No walkable map' };
        if (!wm.hasPvs) return { error: 'No PVS data — bake PVS first' };
        const tileGrid = wm.tileGrid;
        const cells = wm.cells;
        if (!tileGrid || !cells) return { error: 'tileGrid/cells missing' };

        // Union of every tile reachable from any walkable cell. Built
        // once upfront so the per-splat-cell loop below is O(1) per
        // lookup.
        const everVisible = new Set<number>();
        for (const cellKey of cells.keys()) {
            const pvs = wm.pvsForCell(cellKey);
            if (pvs) for (const t of pvs) everVisible.add(t);
        }

        const renderers = this.getSplatRenderers();
        if (renderers.length === 0) return { error: 'No splat renderers' };
        const scratch: number[] = [];
        const perRenderer: PvsPruningReport['perRenderer'] = [];
        let aggTotal = 0;
        let aggPrunable = 0;
        let aggCellsTotal = 0;
        let aggCellsPrunable = 0;
        for (const r of renderers) {
            const g = r.getSplatPvsGrid?.();
            if (!g) continue;
            let total = 0;
            let prunable = 0;
            let prunableCells = 0;
            for (const cell of g.cells) {
                total += cell.gsplatCount;
                scratch.length = 0;
                const a = cell.worldAabb;
                tileGrid.tilesOverlappingAabb(a.min.x, a.min.y, a.min.z, a.max.x, a.max.y, a.max.z, scratch);
                let intersects = false;
                for (let i = 0; i < scratch.length; i++) {
                    if (everVisible.has(scratch[i]!)) { intersects = true; break; }
                }
                if (!intersects) {
                    prunableCells++;
                    prunable += cell.gsplatCount;
                }
            }
            aggTotal += total;
            aggPrunable += prunable;
            aggCellsTotal += g.cells.length;
            aggCellsPrunable += prunableCells;
            perRenderer.push({ gsplatsTotal: total, gsplatsPrunable: prunable, cellsTotal: g.cells.length, cellsPrunable: prunableCells });
        }
        if (perRenderer.length === 0) return { error: 'No splat grids built yet (still loading?)' };

        // Per-splat pass: tighter than cell-level because it tests each
        // gsplat's transformed center directly, catching splats inside
        // partially-visible cells that themselves sit in never-visible
        // tiles. Also surfaces fill-rate suspects (large low-opacity in
        // PVS). Hot loop — pre-extract matrix elements and avoid all
        // allocations inside `forEachSplat` (Spark reuses its center/
        // scales objects per callback, so this is safe).
        const LOW_OPACITY = 0.2;
        const LARGE_SCALE_OBJECT_SPACE = 0.5;
        const splatStart = performance.now();
        let analysed = 0, inPvs = 0, outPvs = 0;
        let prunableLow = 0, prunableHigh = 0;
        let largeLowVisible = 0;
        for (const r of this.getSplatRenderers()) {
            const g = r.getSplatPvsGrid?.();
            if (!g) continue;
            const m = g.splatToWorld.elements;
            const m00 = m[0]!, m01 = m[4]!, m02 = m[8]!, m03 = m[12]!;
            const m10 = m[1]!, m11 = m[5]!, m12 = m[9]!, m13 = m[13]!;
            const m20 = m[2]!, m21 = m[6]!, m22 = m[10]!, m23 = m[14]!;
            for (const cell of g.cells) {
                cell.mesh.forEachSplat((_i, center, scales, _q, opacity) => {
                    analysed++;
                    const cx = center.x, cy = center.y, cz = center.z;
                    const wx = m00 * cx + m01 * cy + m02 * cz + m03;
                    const wy = m10 * cx + m11 * cy + m12 * cz + m13;
                    const wz = m20 * cx + m21 * cy + m22 * cz + m23;
                    const tk = tileGrid.worldToTileKey(wx, wy, wz);
                    const visible = everVisible.has(tk);
                    const low = opacity < LOW_OPACITY;
                    if (visible) {
                        inPvs++;
                        const maxScale = scales.x > scales.y ? (scales.x > scales.z ? scales.x : scales.z) : (scales.y > scales.z ? scales.y : scales.z);
                        if (low && maxScale > LARGE_SCALE_OBJECT_SPACE) largeLowVisible++;
                    } else {
                        outPvs++;
                        if (low) prunableLow++; else prunableHigh++;
                    }
                });
            }
        }
        const analysisMs = performance.now() - splatStart;

        return {
            walkableCells: cells.size,
            everVisibleTiles: everVisible.size,
            gsplatsTotal: aggTotal,
            gsplatsPrunable: aggPrunable,
            cellsTotal: aggCellsTotal,
            cellsPrunable: aggCellsPrunable,
            perRenderer,
            perSplat: {
                analysed,
                centerInsidePvs: inPvs,
                centerOutsidePvs: outPvs,
                prunableLowOpacity: prunableLow,
                prunableHighOpacity: prunableHigh,
                largeLowOpacityVisible: largeLowVisible,
                analysisMs,
            },
        };
    }

    /**
     * Apply the per-splat PVS prune live: for each splat grid, drop every
     * gsplat whose transformed center sits in a tile no walkable cell
     * can ever see. Rebuilds each cell's SplatMesh in place — the result
     * is visible immediately; no SPZ write. Returns counts. On reload
     * the original splat is restored.
     */
    applyPvsPruneInMemory(): { keptSplats: number; removedSplats: number; cellsRemoved: number; elapsedMs: number } | { error: string } {
        const wm = this.getWalkableMap();
        if (!wm) return { error: 'No walkable map' };
        if (!wm.hasPvs) return { error: 'No PVS data — bake PVS first' };
        const tileGrid = wm.tileGrid;
        const cells = wm.cells;
        if (!tileGrid || !cells) return { error: 'tileGrid/cells missing' };

        const everVisible = new Set<number>();
        for (const cellKey of cells.keys()) {
            const pvs = wm.pvsForCell(cellKey);
            if (pvs) for (const t of pvs) everVisible.add(t);
        }

        const start = performance.now();
        let totalKept = 0, totalRemoved = 0, totalCellsRemoved = 0;
        for (const r of this.getSplatRenderers()) {
            const g = r.getSplatPvsGrid?.();
            if (!g) continue;
            const m = g.splatToWorld.elements;
            const m00 = m[0]!, m01 = m[4]!, m02 = m[8]!, m03 = m[12]!;
            const m10 = m[1]!, m11 = m[5]!, m12 = m[9]!, m13 = m[13]!;
            const m20 = m[2]!, m21 = m[6]!, m22 = m[10]!, m23 = m[14]!;
            const result = g.rebuildCells((center) => {
                const cx = center.x, cy = center.y, cz = center.z;
                const wx = m00 * cx + m01 * cy + m02 * cz + m03;
                const wy = m10 * cx + m11 * cy + m12 * cz + m13;
                const wz = m20 * cx + m21 * cy + m22 * cz + m23;
                return everVisible.has(tileGrid.worldToTileKey(wx, wy, wz));
            });
            totalKept += result.kept;
            totalRemoved += result.removed;
            totalCellsRemoved += result.cellsRemoved;
        }
        return { keptSplats: totalKept, removedSplats: totalRemoved, cellsRemoved: totalCellsRemoved, elapsedMs: performance.now() - start };
    }

    /** Spiral-out search for the closest existing walkable cell within `maxRing` steps. */
    private findNearestCellKey(cells: ReadonlyMap<number, number>, cx: number, cz: number, maxRing: number): number {
        for (let r = 1; r <= maxRing; r++) {
            for (let dx = -r; dx <= r; dx++) {
                for (let dz = -r; dz <= r; dz++) {
                    if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
                    const k = packXZ(cx + dx, cz + dz);
                    if (cells.has(k)) return k;
                }
            }
        }
        return -1;
    }
}
