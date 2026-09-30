import * as THREE from 'three';
import type { VoxelWorld } from 'engine/VoxelWorld.js';
import { getVoxelTextureAtlas } from 'engine/VoxelTextureAtlas.js';
import { CHUNK_SIZE as VOXEL_CHUNK_SIZE } from 'engine/VoxelGeometry.js';
import { ensureNormalAttribute } from 'engine/utils/ensureNormalAttribute.js';
import {
    BLOCKED_BITS, DELTA_MAX, DELTA_SHIFT, MAX_NAV_LAYERS, OBSTACLE_BIT, TERRAIN_BIT, VOID_SENTINEL,
    decodeNavMesh, encodeNavMesh,
} from 'engine/nav/NavSerialization.js';
import type { GridChunk, MultiLayerChunk, NavChunk, NavHeader, TrivialChunk } from 'engine/nav/NavSerialization.js';

/**
 * VoxelNavMesh — Voxel-terrain-aware A* pathfinding for NPCs and animals.
 *
 * In a voxel world, pathfinding is simple:
 * - Each surface voxel (with clearance above) is a node
 * - Two adjacent nodes are connected if the height difference allows stepping
 * - Agent radius: cells where standing would clip into a higher neighbor are not usable
 *
 * Rules:
 * - Can climb UP 1 block (1 meter)
 * - Can drop DOWN 2 blocks (2 meters)
 * - Agent radius (default 0.4 m, configurable per build) — cells too close to higher neighbours are blocked
 *
 * ── Storage model ────────────────────────────────────────────────────────────
 *
 * The world is split into chunks matching the voxel chunk size (16 voxels →
 * 16m per chunk at default voxelSize). Each chunk is one of four states:
 *
 *  • `null` (Empty)    — no walkable surface in this chunk. Zero memory.
 *  • Trivial          — uniform groundY, every cell walkable, no obstacles.
 *                        ~24 bytes per chunk regardless of cell resolution.
 *  • Grid             — packed `Uint16Array`, 2 bytes per cell:
 *                        bit 0 = obstacle-blocked (cleared/re-painted as
 *                        registered obstacles add/update/remove),
 *                        bit 1 = terrain-blocked (set by pass-2 agent-radius
 *                        check; never cleared at runtime),
 *                        bits 2-15 = groundY delta from the chunk's `baseY`
 *                        in voxel-size units,
 *                        sentinel `0xFFFF` = void (no walkable surface here).
 *                        A cell is walkable iff both blocked bits are zero.
 *  • MultiLayer       — same packed cells, but `layerCount` stacked walkable
 *                        surfaces per column (dungeon floors, bridges). Only
 *                        `buildFromSerialized` produces these: the voxel scan
 *                        is 2.5D and keeps one ground height per column.
 *
 * Most chunks in an open world are Empty or Trivial, so memory stays small
 * even when the dense chunks (towns, interiors) run at 0.125m resolution.
 * For a 64×64m village game at 0.125m everywhere, the worst-case footprint
 * is ~1 MB; a typical mix of trivial outdoor + dense indoor is ~250 KB.
 *
 * Cell resolution is a per-build setting (passed to `buildFromVoxelWorld`),
 * uniform across all chunks for now. Each chunk stores its own `cellSize` so
 * a future enhancement can promote individual chunks to finer resolution
 * when small obstacles land in them — the data model already supports it.
 */

// ── Configuration ───────────────────────────────────────────────────────────

const DEFAULT_CELL_SIZE = 1.0;
const MAX_CLIMB_UP = 1;          // Can step up 1 block
const MAX_DROP_DOWN = 2;         // Can drop down 2 blocks
/**
 * Default agent capsule radius (meters) for obstacle inflation and pass-2
 * terrain-clip checks. Matches the player's actual physics capsule (0.3 m)
 * exactly — bigger values over-block every passage and make finely-arranged
 * scenes (tavern interiors, narrow village paths) unwalkable. Each
 * `buildFromVoxelWorld` call can override via `agentRadius` for genres
 * with larger creatures (animals max ~0.5 m).
 */
const DEFAULT_AGENT_RADIUS = 0.35;
const AGENT_HEIGHT = 2;          // Blocks of clearance needed above ground
const BASE_MAX_ITERATIONS = 50_000; // A* cap at 1m; scaled inversely with cellSize²
const CLIMB_COST = 2.0;          // Extra cost per meter of climbing
const DIAGONAL_COST = 1.414;     // Cost for diagonal movement
const FIND_NEAREST_DEFAULT_RADIUS_M = 15; // Search distance for findNearestValidTarget
/**
 * Tolerance for "this waypoint stands on that layer". Waypoint Y values are
 * produced from the very same `baseY + delta * voxelSize` arithmetic as the
 * layer they came from, so the real gap is 0; stacked layers are at least one
 * quantization unit apart, so this never conflates two of them.
 */
const LAYER_MATCH_EPSILON = 1e-4;

// The packed-cell layout (VOID_SENTINEL / OBSTACLE_BIT / TERRAIN_BIT / delta
// bits) and the chunk types live in nav/NavSerialization.ts — they are the
// on-disk format, shared with the offline nav compiler.

// ── Types ───────────────────────────────────────────────────────────────────

/** Chunk kinds whose cells are packed Uint16 (grid = 1 layer per cell). */
type PackedChunk = GridChunk | MultiLayerChunk;

export type { GridChunk, MultiLayerChunk, NavChunk, NavHeader, TrivialChunk };

interface CellRef {
    /** Ground Y in world coordinates (top surface). */
    groundY: number;
    /** True if the cell is unusable (blocked by agent-radius rule or obstacle marker). */
    blocked: boolean;
}

/** A global cell address resolved to its chunk and chunk-local coordinates. */
interface ResolvedCell {
    chunk: NavChunk;
    lx: number;
    lz: number;
}

export interface AStarNode {
    gx: number;
    gz: number;
    g: number;
    f: number;
    /** Walkable layer within the cell. Omitted = 0, the only layer of a 2.5D cell. */
    layer?: number;
}

// ── Obstacle registry types ─────────────────────────────────────────────────

/** Opaque handle returned by `addObstacle`. Use it to update or remove later. */
export type ObstacleHandle = number;

/**
 * `y` (optional) is the world height the obstacle sits at. On a multilayer
 * chunk it selects the single floor the obstacle blocks; omitted, the shape
 * blocks every layer of the cells it covers (the 2.5D behaviour).
 */
export type CircleObstacle = { kind: 'circle'; x: number; z: number; radius: number; y?: number };
export type BoxObstacle    = { kind: 'box'; x: number; z: number; halfW: number; halfD: number; yaw?: number; y?: number };
export type ObstacleShape  = CircleObstacle | BoxObstacle;

/** World-space XZ AABB — used to clip re-paints to a cleared region. */
type ObstacleAABB = { minX: number; maxX: number; minZ: number; maxZ: number };

interface ObstacleEntry {
    shape: ObstacleShape;
    /** Inflated world-AABB (cached for overlap tests during removal/update). */
    minX: number; maxX: number; minZ: number; maxZ: number;
    /**
     * Optional live-shape getter. When present, `tick()` calls it each frame
     * and re-paints the obstacle if the result has moved more than one cell
     * size on either axis. Used for dynamic obstacles (chairs, tables,
     * carts) that get pushed around by physics. Returning null removes the
     * obstacle (e.g. the source object was destroyed).
     */
    getCurrentShape?: () => ObstacleShape | null;
}

// ── Min-heap for A* ─────────────────────────────────────────────────────────

export class MinHeap {
    private data: AStarNode[] = [];
    get size() { return this.data.length; }

    push(node: AStarNode) {
        this.data.push(node);
        let i = this.data.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (this.data[i]!.f >= this.data[p]!.f) break;
            [this.data[i], this.data[p]] = [this.data[p]!, this.data[i]!];
            i = p;
        }
    }

    pop(): AStarNode | undefined {
        const top = this.data[0];
        const last = this.data.pop();
        if (this.data.length && last) {
            this.data[0] = last;
            let i = 0;
            while (true) {
                let smallest = i;
                const l = 2 * i + 1, r = 2 * i + 2;
                if (l < this.data.length && this.data[l]!.f < this.data[smallest]!.f) smallest = l;
                if (r < this.data.length && this.data[r]!.f < this.data[smallest]!.f) smallest = r;
                if (smallest === i) break;
                [this.data[i], this.data[smallest]] = [this.data[smallest]!, this.data[i]!];
                i = smallest;
            }
        }
        return top;
    }
}

// ── VoxelNavMesh ────────────────────────────────────────────────────────────

export interface BuildOptions {
    /**
     * Cell size in world meters. Defaults to 1.0 (matches a voxel). Use finer
     * values (0.5, 0.25, 0.125) to resolve small obstacles like furniture.
     * Memory scales with 1/cellSize² per dense chunk.
     */
    cellSize?: number;
    /**
     * Agent capsule radius in meters used for obstacle inflation and pass-2
     * terrain-clip checks. Defaults to 0.4 m (matches typical NPCs). Larger
     * values (e.g. 0.6 for big creatures) reserve more clearance around every
     * obstacle; smaller values let agents squeeze through tighter passages.
     */
    agentRadius?: number;
}

/** NPC navmesh over a baked level's ground: 1 m cells, 0.5 m step unit (a kerb mounts, a wall does not). */
export const NPC_NAV_CELL_M = 1.0;
export const NPC_NAV_STEP_M = 0.5;

export class VoxelNavMesh {
    // World extent (set at build).
    private minX = 0;
    private minZ = 0;
    /** Total cells per axis across the whole world (cols × rows = world cell grid). */
    private cols = 0;
    private rows = 0;
    /** World size of one voxel-chunk in meters (= VOXEL_CHUNK_SIZE * voxelSize). */
    private chunkWorldSize = 0;
    /** Chunks per axis (chunkCols × chunkRows = chunk grid). */
    private chunkCols = 0;
    private chunkRows = 0;
    /** Default cell size used when promoting a chunk; per-chunk cellSize may differ in the future. */
    private cellSize = DEFAULT_CELL_SIZE;
    /** Agent capsule radius used for obstacle inflation and pass-2 clip checks. */
    private agentRadius = DEFAULT_AGENT_RADIUS;
    /** Cells per chunk per axis at the default cellSize (chunkWorldSize / cellSize). */
    private cellsPerChunkSide = VOXEL_CHUNK_SIZE;
    private voxelSize = 1.0;
    /**
     * Step limits in meters, decoupled from `voxelSize`. A voxel-scanned mesh
     * derives them from the block size (MAX_CLIMB_UP / MAX_DROP_DOWN blocks),
     * but a serialized mesh quantizes groundY at a much finer unit (0.125 m
     * for dungeons) — reusing that as the climb basis would cap stepping at
     * 0.125 m and make every staircase unwalkable.
     */
    private stepUpM = MAX_CLIMB_UP;
    private stepDownM = MAX_DROP_DOWN;
    /** Chunk store, indexed by `cx * chunkRows + cz`. Missing entries = Empty. */
    private chunks: Map<number, NavChunk> = new Map();
    /** Registered dynamic obstacles, keyed by handle. */
    private obstacles: Map<ObstacleHandle, ObstacleEntry> = new Map();
    private nextObstacleId: ObstacleHandle = 1;
    /**
     * Bumped every time any cell's blocked state changes (obstacle painted /
     * cleared, terrain pass-2 mark, etc.). The debug overlay reads this to
     * decide whether to rebuild its snapshot mesh — without it, the
     * overlay shows where obstacles WERE at toggle-on time, not where they
     * are now.
     */
    private _cellMutationVersion: number = 0;
    private voxelWorld: VoxelWorld | null = null;
    private isBuilt = false;
    private debugMesh: THREE.Mesh | null = null;

    /**
     * Build navigation grid from voxel world.
     */
    buildFromVoxelWorld(
        voxelWorld: VoxelWorld,
        minX: number, maxX: number,
        minZ: number, maxZ: number,
        options: BuildOptions = {},
    ): void {
        this.voxelWorld = voxelWorld;
        this.voxelSize = voxelWorld.getVoxelSize();
        this.stepUpM = MAX_CLIMB_UP * this.voxelSize;
        this.stepDownM = MAX_DROP_DOWN * this.voxelSize;
        this.cellSize = options.cellSize ?? DEFAULT_CELL_SIZE;
        if (this.cellSize <= 0) {
            console.warn(`[VoxelNavMesh] Invalid cellSize ${this.cellSize}, falling back to 1.0`);
            this.cellSize = 1.0;
        }
        this.agentRadius = options.agentRadius ?? DEFAULT_AGENT_RADIUS;
        if (this.agentRadius <= 0) {
            console.warn(`[VoxelNavMesh] Invalid agentRadius ${this.agentRadius}, falling back to ${DEFAULT_AGENT_RADIUS}`);
            this.agentRadius = DEFAULT_AGENT_RADIUS;
        }
        // Align world bounds onto a chunk grid so chunk-local addressing is exact.
        this.chunkWorldSize = VOXEL_CHUNK_SIZE * this.voxelSize;
        // Snap min outward so the chunk grid covers the requested world rectangle.
        this.minX = Math.floor(minX / this.chunkWorldSize) * this.chunkWorldSize;
        this.minZ = Math.floor(minZ / this.chunkWorldSize) * this.chunkWorldSize;
        const alignedMaxX = Math.ceil(maxX / this.chunkWorldSize) * this.chunkWorldSize;
        const alignedMaxZ = Math.ceil(maxZ / this.chunkWorldSize) * this.chunkWorldSize;
        this.chunkCols = Math.round((alignedMaxX - this.minX) / this.chunkWorldSize);
        this.chunkRows = Math.round((alignedMaxZ - this.minZ) / this.chunkWorldSize);
        this.cellsPerChunkSide = Math.max(1, Math.round(this.chunkWorldSize / this.cellSize));
        this.cols = this.chunkCols * this.cellsPerChunkSide;
        this.rows = this.chunkRows * this.cellsPerChunkSide;
        this.chunks.clear();
        // Preserve the obstacle registry across rebuilds. Game.ts can switch
        // from the default 1m navmesh to 0.125m without losing every
        // registered obstacle (chairs, tables, etc.) — handles stay valid
        // and the obstacles are re-painted at the new resolution below.
        // Callers who explicitly want to start fresh should call dispose()
        // (which clears the registry) and construct a new instance.
        const preserved = this.snapshotObstacles();

        const atlas = getVoxelTextureAtlas();

        // Pass 1: build each chunk independently.
        for (let cx = 0; cx < this.chunkCols; cx++) {
            for (let cz = 0; cz < this.chunkRows; cz++) {
                const chunk = this.buildChunk(cx, cz, atlas);
                if (chunk === null) continue;
                this.chunks.set(this.chunkKey(cx, cz), chunk);
            }
        }

        // Pass 2: agent-radius clip check. Only Grid chunks need this; Trivial
        // chunks are by definition uniform, so no clipping can occur. We still
        // have to consider that a Grid chunk's edges may abut Trivial chunks
        // with a different groundY — handled by reading neighbours through
        // getCell() which works across chunk boundaries.
        this.finishBuild(preserved);
    }

    /**
     * Install a prebuilt nav mesh from its serialized form (see
     * nav/NavSerialization.ts). No VoxelWorld is involved — the sidecar
     * already carries the walkable surfaces, including multilayer chunks the
     * 2.5D voxel scan cannot produce — so `voxelWorld` stays null and the
     * agent-radius pass is skipped (the compiler ran it offline).
     *
     * Throws if the buffer is not a valid sidecar; the mesh is left unbuilt.
     */
    /**
     * Build from a ground-height sampler instead of a voxel world — the path
     * for a FORGED level (VxlScene `.vwld`), whose ground is a baked mesh with
     * a per-column ground mask, not voxel columns. `sampler(x, z)` answers the
     * walkable surface height at a world point, or null for no ground (void,
     * water, a building's footprint). Chunks come out exactly as the voxel
     * build makes them (trivial where uniform, grid otherwise), so every
     * consumer — A*, GoalField hordes, obstacle providers — is unchanged.
     *
     * `voxelSize` is the height quantum grid chunks store deltas in AND the
     * unit of the step limits (`MAX_CLIMB_UP` / `MAX_DROP_DOWN` are in it):
     * 0.5 m lets an agent mount a kerb or a low stair and forbids a wall.
     *
     * Jani, 2026-09-05: forged cities had no NPC navmesh at all, so the horde
     * flow field had nothing to sample and every enemy walked straight at the
     * player — and stood pushing against the first bus in the way.
     */
    buildFromHeightSampler(
        sampler: (x: number, z: number) => number | null,
        minX: number, maxX: number,
        minZ: number, maxZ: number,
        voxelSize: number,
        options: BuildOptions = {},
    ): void {
        this.voxelWorld = null;
        this.voxelSize = voxelSize > 0 ? voxelSize : 0.5;
        this.stepUpM = MAX_CLIMB_UP * this.voxelSize;
        this.stepDownM = MAX_DROP_DOWN * this.voxelSize;
        this.cellSize = options.cellSize ?? DEFAULT_CELL_SIZE;
        if (this.cellSize <= 0) this.cellSize = 1.0;
        this.agentRadius = options.agentRadius ?? DEFAULT_AGENT_RADIUS;
        if (this.agentRadius <= 0) this.agentRadius = DEFAULT_AGENT_RADIUS;
        this.chunkWorldSize = VOXEL_CHUNK_SIZE * this.voxelSize;
        this.minX = Math.floor(minX / this.chunkWorldSize) * this.chunkWorldSize;
        this.minZ = Math.floor(minZ / this.chunkWorldSize) * this.chunkWorldSize;
        const alignedMaxX = Math.ceil(maxX / this.chunkWorldSize) * this.chunkWorldSize;
        const alignedMaxZ = Math.ceil(maxZ / this.chunkWorldSize) * this.chunkWorldSize;
        this.chunkCols = Math.round((alignedMaxX - this.minX) / this.chunkWorldSize);
        this.chunkRows = Math.round((alignedMaxZ - this.minZ) / this.chunkWorldSize);
        this.cellsPerChunkSide = Math.max(1, Math.round(this.chunkWorldSize / this.cellSize));
        this.cols = this.chunkCols * this.cellsPerChunkSide;
        this.rows = this.chunkRows * this.cellsPerChunkSide;
        this.chunks.clear();
        const preserved = this.snapshotObstacles();

        for (let cx = 0; cx < this.chunkCols; cx++) {
            for (let cz = 0; cz < this.chunkRows; cz++) {
                const chunk = this.buildChunkFromSampler(cx, cz, sampler);
                if (chunk === null) continue;
                this.chunks.set(this.chunkKey(cx, cz), chunk);
            }
        }
        this.finishBuild(preserved);
    }

    /** The voxel builder's chunk recipe, fed by a sampler: trivial when uniform, grid otherwise. */
    private buildChunkFromSampler(cx: number, cz: number, sampler: (x: number, z: number) => number | null): NavChunk | null {
        const cps = this.cellsPerChunkSide;
        const baseWorldX = this.minX + cx * this.chunkWorldSize;
        const baseWorldZ = this.minZ + cz * this.chunkWorldSize;
        let baseY = Number.POSITIVE_INFINITY;
        let anyWalkable = false;
        let uniform = true;
        let firstY: number | null = null;
        const groundYs = new Float32Array(cps * cps);
        const present = new Uint8Array(cps * cps);
        for (let lx = 0; lx < cps; lx++) {
            for (let lz = 0; lz < cps; lz++) {
                const groundY = sampler(baseWorldX + (lx + 0.5) * this.cellSize, baseWorldZ + (lz + 0.5) * this.cellSize);
                const idx = lx * cps + lz;
                if (groundY === null || !Number.isFinite(groundY)) {
                    present[idx] = 0;
                    uniform = false;
                    continue;
                }
                present[idx] = 1;
                groundYs[idx] = groundY;
                anyWalkable = true;
                if (groundY < baseY) baseY = groundY;
                if (firstY === null) firstY = groundY;
                else if (Math.abs(groundY - firstY) > 1e-6) uniform = false;
            }
        }
        if (!anyWalkable) return null;
        if (uniform && firstY !== null) return { kind: 'trivial', cx, cz, groundY: firstY };
        const data = new Uint16Array(cps * cps);
        for (let i = 0; i < cps * cps; i++) {
            if (!present[i]) { data[i] = VOID_SENTINEL; continue; }
            const deltaVoxels = Math.round((groundYs[i]! - baseY) / this.voxelSize);
            data[i] = Math.max(0, Math.min(DELTA_MAX, deltaVoxels)) << DELTA_SHIFT;
        }
        return { kind: 'grid', cx, cz, cellSize: this.cellSize, cellsPerSide: cps, baseY, voxelSize: this.voxelSize, data };
    }

    /** Shared tail of every build: agent-radius inflation against void/blocked, then obstacles. */
    private finishBuild(preserved: ReturnType<VoxelNavMesh['snapshotObstacles']>): void {
        const radiusInCells = Math.max(1, Math.ceil(this.agentRadius / this.cellSize));
        for (const chunk of this.chunks.values()) {
            if (chunk.kind !== 'grid') continue;
            const baseGx = chunk.cx * this.cellsPerChunkSide;
            const baseGz = chunk.cz * this.cellsPerChunkSide;
            for (let lx = 0; lx < chunk.cellsPerSide; lx++) {
                for (let lz = 0; lz < chunk.cellsPerSide; lz++) {
                    if (this.readGridCell(chunk, lx, lz) === null) continue;
                    if (this.shouldBlockForRadius(baseGx + lx, baseGz + lz, radiusInCells)) {
                        this.setCellBits(chunk, lx, lz, TERRAIN_BIT, true);
                    }
                }
            }
        }
        this.isBuilt = true;
        this.repaintObstacles(preserved);
    }

    buildFromSerialized(data: ArrayBuffer): void {
        const { header, chunks } = decodeNavMesh(data);
        this.voxelWorld = null;
        this.cellSize = header.cellSize;
        this.agentRadius = header.agentRadius;
        this.voxelSize = header.voxelSize;
        this.chunkWorldSize = header.chunkWorldSize;
        this.minX = header.minX;
        this.minZ = header.minZ;
        this.chunkCols = header.chunkCols;
        this.chunkRows = header.chunkRows;
        this.cellsPerChunkSide = header.cellsPerChunkSide;
        this.cols = this.chunkCols * this.cellsPerChunkSide;
        this.rows = this.chunkRows * this.cellsPerChunkSide;
        this.stepUpM = header.maxClimbM;
        this.stepDownM = header.maxDropM;

        // Same contract as buildFromVoxelWorld: registered obstacles survive
        // the swap and are re-painted at the new resolution.
        const preserved = this.snapshotObstacles();
        this.chunks.clear();
        for (const chunk of chunks) {
            this.chunks.set(this.chunkKey(chunk.cx, chunk.cz), chunk);
        }
        this._cellMutationVersion++;
        this.isBuilt = true;
        this.repaintObstacles(preserved);
    }

    /** Serialize the current chunk store + build parameters. Requires isReady(). */
    serialize(): Uint8Array {
        const header: NavHeader = {
            cellSize: this.cellSize,
            agentRadius: this.agentRadius,
            voxelSize: this.voxelSize,
            chunkWorldSize: this.chunkWorldSize,
            minX: this.minX,
            minZ: this.minZ,
            chunkCols: this.chunkCols,
            chunkRows: this.chunkRows,
            cellsPerChunkSide: this.cellsPerChunkSide,
            maxClimbM: this.stepUpM,
            maxDropM: this.stepDownM,
        };
        return encodeNavMesh(header, this.chunks.values());
    }

    /** Copy the obstacle registry so a rebuild can re-insert it under the same handles. */
    private snapshotObstacles(): Array<{ handle: ObstacleHandle; entry: ObstacleEntry }> {
        const out: Array<{ handle: ObstacleHandle; entry: ObstacleEntry }> = [];
        for (const [handle, entry] of this.obstacles) out.push({ handle, entry: { ...entry } });
        return out;
    }

    /**
     * Re-paint a snapshot onto freshly built chunks. The inflated AABB is
     * recomputed (it changes with cellSize-dependent alignment); handles stay
     * valid because we re-insert into the same map.
     */
    private repaintObstacles(snapshot: Array<{ handle: ObstacleHandle; entry: ObstacleEntry }>): void {
        for (const { handle, entry } of snapshot) {
            const aabb = this.computeInflatedAABB(entry.shape);
            this.obstacles.set(handle, { shape: entry.shape, ...aabb, getCurrentShape: entry.getCurrentShape });
            this.paintShape(entry.shape, true);
        }
    }

    /** Build one chunk: detect Trivial vs Grid vs Empty, populate accordingly. */
    private buildChunk(cx: number, cz: number, atlas: ReturnType<typeof getVoxelTextureAtlas>): NavChunk | null {
        if (!this.voxelWorld) return null;
        const cps = this.cellsPerChunkSide;
        const baseWorldX = this.minX + cx * this.chunkWorldSize;
        const baseWorldZ = this.minZ + cz * this.chunkWorldSize;

        // Fast pass: sample one column near the chunk centre to spot a uniform
        // chunk. If the voxel world says the whole column is uniform-flat AND
        // every cell in the chunk reports the same uniform Y, we get away with
        // a Trivial chunk (one record total).
        const centreUniformY = this.voxelWorld.getColumnUniformGroundY(
            baseWorldX + this.chunkWorldSize / 2,
            baseWorldZ + this.chunkWorldSize / 2,
        );

        // Walk every cell. Track whether we can stay Trivial or must promote
        // to Grid. We always do this scan so the same loop fills the Grid
        // data when promotion is needed.
        let baseY = Number.POSITIVE_INFINITY;
        let anyWalkable = false;
        let mustPromote = false;
        const groundYs = new Float32Array(cps * cps);
        const present = new Uint8Array(cps * cps);

        for (let lx = 0; lx < cps; lx++) {
            for (let lz = 0; lz < cps; lz++) {
                const worldX = baseWorldX + (lx + 0.5) * this.cellSize;
                const worldZ = baseWorldZ + (lz + 0.5) * this.cellSize;

                // Try uniform fast path per cell — same trick as before.
                const u = this.voxelWorld.getColumnUniformGroundY(worldX, worldZ);
                let groundY: number | null;
                if (u !== null) {
                    groundY = u;
                } else {
                    groundY = this.findGroundHeight(worldX, worldZ, atlas);
                    if (groundY !== null && !this.hasHeadroom(worldX, groundY, worldZ, atlas)) {
                        groundY = null;
                    }
                }

                const idx = lx * cps + lz;
                if (groundY === null) {
                    present[idx] = 0;
                    mustPromote = true; // a void cell inside an otherwise-walkable chunk forces Grid
                    continue;
                }
                present[idx] = 1;
                groundYs[idx] = groundY;
                anyWalkable = true;
                if (groundY < baseY) baseY = groundY;
                if (centreUniformY === null || groundY !== centreUniformY) {
                    mustPromote = true;
                }
            }
        }

        if (!anyWalkable) return null;

        if (!mustPromote && centreUniformY !== null) {
            return { kind: 'trivial', cx, cz, groundY: centreUniformY };
        }

        // Promote to Grid. Pack groundY delta into 14 bits relative to baseY,
        // leaving bits 0 and 1 for OBSTACLE_BIT and TERRAIN_BIT.
        const data = new Uint16Array(cps * cps);
        for (let i = 0; i < cps * cps; i++) {
            if (!present[i]) {
                data[i] = VOID_SENTINEL;
                continue;
            }
            const deltaVoxels = Math.round((groundYs[i]! - baseY) / this.voxelSize);
            const clamped = Math.max(0, Math.min(DELTA_MAX, deltaVoxels));
            data[i] = clamped << DELTA_SHIFT; // blocked bits = 0
        }
        return {
            kind: 'grid',
            cx, cz,
            cellSize: this.cellSize,
            cellsPerSide: cps,
            baseY,
            voxelSize: this.voxelSize,
            data,
        };
    }

    private findGroundHeight(x: number, z: number, atlas: ReturnType<typeof getVoxelTextureAtlas>): number | null {
        if (!this.voxelWorld) return null;
        const top = this.voxelWorld.getColumnMaxWorldY(x, z);
        if (top === null) return null;
        const startY = top + this.voxelSize;
        for (let y = startY; y >= -50; y -= this.voxelSize) {
            const block = this.voxelWorld.getBlock(x, y, z);
            if (block !== 0 && !atlas.isFluidBlock(block)) {
                return y + this.voxelSize;
            }
        }
        return null;
    }

    private hasHeadroom(x: number, groundY: number, z: number, atlas: ReturnType<typeof getVoxelTextureAtlas>): boolean {
        if (!this.voxelWorld) return true;
        for (let h = 0; h < AGENT_HEIGHT; h++) {
            const block = this.voxelWorld.getBlock(x, groundY + h * this.voxelSize, z);
            if (block !== 0 && !atlas.isFluidBlock(block)) return false;
        }
        return true;
    }

    // ─── Chunk addressing ───────────────────────────────────────────────────

    private chunkKey(cx: number, cz: number): number {
        return cx * this.chunkRows + cz;
    }

    private getChunk(cx: number, cz: number): NavChunk | undefined {
        if (cx < 0 || cx >= this.chunkCols || cz < 0 || cz >= this.chunkRows) return undefined;
        return this.chunks.get(this.chunkKey(cx, cz));
    }

    /** Resolve a global cell address to (chunk, localX, localZ). */
    private resolveCell(gx: number, gz: number): ResolvedCell | null {
        const cps = this.cellsPerChunkSide;
        const cx = Math.floor(gx / cps);
        const cz = Math.floor(gz / cps);
        const chunk = this.getChunk(cx, cz);
        if (!chunk) return null;
        return { chunk, lx: gx - cx * cps, lz: gz - cz * cps };
    }

    /**
     * Read a cell's properties. Returns null for void cells. Legacy 2.5D
     * accessor: on a multilayer cell it reports the TOPMOST layer, so every
     * caller that has no height reference keeps its previous behaviour.
     */
    private getCell(gx: number, gz: number): CellRef | null {
        const r = this.resolveCell(gx, gz);
        if (!r) return null;
        return this.readResolvedLayer(r, this.resolvedLayerCount(r) - 1);
    }

    /** Layers stacked in a cell. Trivial/Grid report 1 (or 0 when void). */
    private getLayerCount(gx: number, gz: number): number {
        const r = this.resolveCell(gx, gz);
        return r ? this.resolvedLayerCount(r) : 0;
    }

    /** Read one walkable layer of a cell. Null when the layer does not exist. */
    private getLayer(gx: number, gz: number, layerIdx: number): CellRef | null {
        const r = this.resolveCell(gx, gz);
        return r ? this.readResolvedLayer(r, layerIdx) : null;
    }

    private resolvedLayerCount(r: ResolvedCell): number {
        if (r.chunk.kind === 'trivial') return 1;
        if (r.chunk.kind === 'grid') {
            return r.chunk.data[r.lx * r.chunk.cellsPerSide + r.lz]! === VOID_SENTINEL ? 0 : 1;
        }
        // Present layers are packed from 0 upwards; the first sentinel ends them.
        const base = (r.lx * r.chunk.cellsPerSide + r.lz) * r.chunk.layerCount;
        for (let i = 0; i < r.chunk.layerCount; i++) {
            if (r.chunk.data[base + i]! === VOID_SENTINEL) return i;
        }
        return r.chunk.layerCount;
    }

    private readResolvedLayer(r: ResolvedCell, layerIdx: number): CellRef | null {
        if (layerIdx < 0) return null;
        if (r.chunk.kind === 'trivial') {
            return layerIdx === 0 ? { groundY: r.chunk.groundY, blocked: false } : null;
        }
        return this.readPackedLayer(r.chunk, r.lx, r.lz, layerIdx);
    }

    /** Layer whose ground is closest to `refY`, blocked or not. -1 when void. */
    private nearestLayerIdx(gx: number, gz: number, refY: number): number {
        return this.pickLayer(gx, gz, refY, false, false);
    }

    /** Like nearestLayerIdx but skips blocked layers. -1 when none is usable. */
    private nearestWalkableLayerIdx(gx: number, gz: number, refY: number): number {
        return this.pickLayer(gx, gz, refY, true, false);
    }

    /**
     * Layer of (gx, gz) an agent standing at `fromY` can step onto — the
     * closest in height among the unblocked layers within the step limits.
     * -1 when the cell offers none.
     */
    private reachableLayerIdx(gx: number, gz: number, fromY: number): number {
        return this.pickLayer(gx, gz, fromY, true, true);
    }

    private pickLayer(gx: number, gz: number, refY: number, walkableOnly: boolean, stepLimited: boolean): number {
        const r = this.resolveCell(gx, gz);
        if (!r) return -1;
        const count = this.resolvedLayerCount(r);
        let best = -1;
        let bestDist = Infinity;
        for (let i = 0; i < count; i++) {
            const layer = this.readResolvedLayer(r, i);
            if (!layer) continue;
            if (walkableOnly && layer.blocked) continue;
            if (stepLimited && !this.stepAllowed(refY, layer.groundY)) continue;
            const dist = Math.abs(layer.groundY - refY);
            if (dist < bestDist) {
                bestDist = dist;
                best = i;
            }
        }
        return best;
    }

    /** Index of a packed cell's layer inside `chunk.data`. */
    private packedIndex(chunk: PackedChunk, lx: number, lz: number, layerIdx: number): number {
        const cellIdx = lx * chunk.cellsPerSide + lz;
        return chunk.kind === 'grid' ? cellIdx : cellIdx * chunk.layerCount + layerIdx;
    }

    private packedLayers(chunk: PackedChunk): number {
        return chunk.kind === 'grid' ? 1 : chunk.layerCount;
    }

    private readPackedLayer(chunk: PackedChunk, lx: number, lz: number, layerIdx: number): CellRef | null {
        if (layerIdx < 0 || layerIdx >= this.packedLayers(chunk)) return null;
        const v = chunk.data[this.packedIndex(chunk, lx, lz, layerIdx)]!;
        if (v === VOID_SENTINEL) return null;
        return {
            groundY: chunk.baseY + (v >> DELTA_SHIFT) * chunk.voxelSize,
            blocked: (v & BLOCKED_BITS) !== 0,
        };
    }

    private readGridCell(chunk: GridChunk, lx: number, lz: number): CellRef | null {
        return this.readPackedLayer(chunk, lx, lz, 0);
    }

    /**
     * Set or clear specific blocked bits on a cell layer. Returns true if the
     * value changed. Leaves groundY delta untouched.
     */
    private setCellBits(chunk: PackedChunk, lx: number, lz: number, bits: number, value: boolean, layerIdx = 0): boolean {
        if (layerIdx < 0 || layerIdx >= this.packedLayers(chunk)) return false;
        const idx = this.packedIndex(chunk, lx, lz, layerIdx);
        const v = chunk.data[idx]!;
        if (v === VOID_SENTINEL) return false;
        const next = value ? (v | bits) : (v & ~bits);
        if (next === v) return false;
        chunk.data[idx] = next;
        this._cellMutationVersion++;
        return true;
    }

    /**
     * Monotonically-increasing counter that ticks every time a navmesh cell
     * changes blocked state. Used by the debug overlay to refresh its
     * snapshot mesh only when needed.
     */
    getCellMutationVersion(): number {
        return this._cellMutationVersion;
    }

    /**
     * Convert a Trivial chunk to a Grid chunk in place. Needed when an
     * obstacle is marked inside an otherwise-uniform chunk.
     */
    private promoteToGrid(trivial: TrivialChunk): GridChunk {
        const cps = this.cellsPerChunkSide;
        const data = new Uint16Array(cps * cps);
        // groundY delta is 0 across the chunk (everything sits at baseY).
        // Encoded as 0 << DELTA_SHIFT = 0 (walkable, no blocked bits set).
        // VOID_SENTINEL not used — a Trivial chunk has no void cells.
        data.fill(0);
        const grid: GridChunk = {
            kind: 'grid',
            cx: trivial.cx,
            cz: trivial.cz,
            cellSize: this.cellSize,
            cellsPerSide: cps,
            baseY: trivial.groundY,
            voxelSize: this.voxelSize,
            data,
        };
        this.chunks.set(this.chunkKey(trivial.cx, trivial.cz), grid);
        return grid;
    }

    // ─── Pass 2: radius check ───────────────────────────────────────────────

    /**
     * Returns true if the cell at (gx, gz) should be marked blocked because a
     * nearby higher neighbour would clip the agent. Scans all cells within
     * `radiusInCells` and checks distance from cell centre to neighbour edge.
     */
    private shouldBlockForRadius(gx: number, gz: number, radiusInCells: number): boolean {
        const self = this.getCell(gx, gz);
        if (!self) return false;
        const climbThreshold = this.stepUpM;
        for (let dx = -radiusInCells; dx <= radiusInCells; dx++) {
            for (let dz = -radiusInCells; dz <= radiusInCells; dz++) {
                if (dx === 0 && dz === 0) continue;
                const neighbour = this.getCell(gx + dx, gz + dz);
                if (!neighbour) continue;
                const heightDiff = neighbour.groundY - self.groundY;
                if (heightDiff <= climbThreshold) continue;
                // Cell-centre to neighbour-cell-edge distance.
                const dist = Math.max(0, Math.sqrt(dx * dx + dz * dz) * this.cellSize - this.cellSize / 2);
                if (dist < this.agentRadius) return true;
            }
        }
        return false;
    }

    // ─── Obstacle registry — single-shape add/update/remove ─────────────────

    /**
     * Register an obstacle. Returns an opaque handle for later
     * `updateObstacle` / `removeObstacle`. The navmesh inflates the shape by
     * the configured agent radius internally so agents never graze the obstacle's
     * footprint — callers pass physical dimensions only.
     *
     * Every obstacle is tracked so removal can correctly preserve cells
     * still blocked by other overlapping obstacles.
     */
    addObstacle(shape: ObstacleShape): ObstacleHandle {
        if (!this.isBuilt) return 0;
        const handle = this.nextObstacleId++;
        const aabb = this.computeInflatedAABB(shape);
        this.obstacles.set(handle, { shape, ...aabb });
        this.paintShape(shape, true);
        return handle;
    }

    /**
     * Move or resize an existing obstacle in place. The handle stays valid.
     * Cells in the union of the old and new footprints are cleared and then
     * re-painted from every obstacle that overlaps the union — so siblings
     * sharing cells with the moved obstacle stay correctly blocked.
     */
    updateObstacle(handle: ObstacleHandle, newShape: ObstacleShape): void {
        const entry = this.obstacles.get(handle);
        if (!entry) return;
        const oldAabb = { minX: entry.minX, maxX: entry.maxX, minZ: entry.minZ, maxZ: entry.maxZ };
        const newAabb = this.computeInflatedAABB(newShape);
        // 1. Clear the obstacle bit on every cell either footprint touched.
        this.paintShape(entry.shape, false);
        this.paintShape(newShape, false);
        // 2. Swap the registry entry.
        this.obstacles.set(handle, { shape: newShape, ...newAabb });
        // 3. Re-paint everyone (including ourselves) whose footprint overlaps
        //    EITHER the old or the new AABB. We test the two boxes SEPARATELY,
        //    NOT their bounding union: when an obstacle is teleported or launched
        //    a long way in a single frame, the bounding union can span a huge
        //    swath of the map, and
        //    "re-paint everything overlapping the union" then re-paints every
        //    obstacle along the entire flight path — including large building
        //    obstacles, every frame — which collapsed the frame rate (60→5 fps).
        //    Obstacles in the GAP between the old and new positions never shared
        //    cells with this obstacle, so they must not be re-painted.
        //
        //    Neighbour re-paints are CLIPPED to the cleared boxes: step 1 only
        //    cleared cells inside oldAabb/newAabb, so those are the only cells of
        //    a neighbour that can need restoring. Without the clip, a small
        //    obstacle moving every frame (pushed/rolling) inside a large
        //    obstacle's footprint re-painted the large obstacle's ENTIRE
        //    footprint (thousands of cells) every frame — the other half of the
        //    same 60→5 fps collapse.
        const self = this.obstacles.get(handle);
        for (const other of this.obstacles.values()) {
            if (other === self) {
                this.paintShape(other.shape, true);
                continue;
            }
            if (this.aabbsOverlap(other, oldAabb)) {
                this.paintShape(other.shape, true, oldAabb);
            }
            if (this.aabbsOverlap(other, newAabb)) {
                this.paintShape(other.shape, true, newAabb);
            }
        }
    }

    /**
     * Register a **tracked** obstacle that auto-refreshes when the source
     * object moves. The engine calls `getCurrentShape()` from `tick()` each
     * frame; if the returned shape has moved more than one cell-size on
     * either axis (or its size/yaw changed), the obstacle is re-painted
     * via the standard `updateObstacle()` path. Returning `null` from
     * `getCurrentShape()` removes the obstacle (e.g. the source VoxelObject
     * was destroyed).
     *
     * This is the right API for dynamic VoxelObjects whose physics body can
     * be pushed by NPCs — chairs, tables, market carts, kegs, etc. For
     * truly static obstacles (walls, buildings), `addObstacle()` is fine.
     */
    addTrackedObstacle(getCurrentShape: () => ObstacleShape | null): ObstacleHandle {
        if (!this.isBuilt) return 0;
        const shape = getCurrentShape();
        if (!shape) return 0;
        const handle = this.nextObstacleId++;
        const aabb = this.computeInflatedAABB(shape);
        this.obstacles.set(handle, { shape, ...aabb, getCurrentShape });
        this.paintShape(shape, true);
        return handle;
    }

    /**
     * Per-frame tick. Iterates every tracked obstacle, polls its live shape,
     * and re-paints anything whose position has drifted more than one cell
     * size on either axis (or whose size/yaw changed). Cheap — the position
     * comparison is a few floats per obstacle, and the actual re-paint only
     * runs when motion crosses the threshold.
     *
     * Call this from the engine's render loop. Safe to call before the
     * navmesh is built (no-op).
     */
    tick(): void {
        if (!this.isBuilt || this.obstacles.size === 0) return;
        const threshold = this.cellSize;
        // Snapshot handles into an array — updateObstacle/removeObstacle
        // both mutate the obstacles Map, which would break a live iterator.
        const handles: ObstacleHandle[] = [];
        for (const [h, entry] of this.obstacles) {
            if (entry.getCurrentShape) handles.push(h);
        }
        for (const handle of handles) {
            const entry = this.obstacles.get(handle);
            if (!entry || !entry.getCurrentShape) continue;
            const cur = entry.getCurrentShape();
            if (!cur) {
                this.removeObstacle(handle);
                continue;
            }
            if (!this.shapeChangedEnough(entry.shape, cur, threshold)) continue;
            // updateObstacle preserves the getCurrentShape callback via re-set below.
            const getter = entry.getCurrentShape;
            this.updateObstacle(handle, cur);
            const refreshed = this.obstacles.get(handle);
            if (refreshed) refreshed.getCurrentShape = getter;
        }
    }

    /** Threshold check: position drift on either axis, or any size/yaw delta. */
    private shapeChangedEnough(prev: ObstacleShape, cur: ObstacleShape, posThreshold: number): boolean {
        if (Math.abs(prev.x - cur.x) > posThreshold) return true;
        if (Math.abs(prev.z - cur.z) > posThreshold) return true;
        // A layer-bound obstacle that changed floors must re-paint too.
        if ((prev.y ?? 0) !== (cur.y ?? 0)) return true;
        if (prev.kind !== cur.kind) return true;
        if (prev.kind === 'circle' && cur.kind === 'circle') {
            return Math.abs(prev.radius - cur.radius) > posThreshold;
        }
        if (prev.kind === 'box' && cur.kind === 'box') {
            if (Math.abs(prev.halfW - cur.halfW) > posThreshold) return true;
            if (Math.abs(prev.halfD - cur.halfD) > posThreshold) return true;
            const py = prev.yaw ?? 0;
            const cy = cur.yaw ?? 0;
            // ~6° yaw change is enough to repaint at our resolutions.
            return Math.abs(py - cy) > 0.1;
        }
        return true;
    }

    /**
     * Remove a registered obstacle. The cells under its footprint have their
     * obstacle bit cleared, then every other registered obstacle whose AABB
     * overlaps that footprint is re-painted so cells they shared with the
     * removed obstacle stay blocked. Cells blocked by terrain (TERRAIN_BIT)
     * are untouched.
     */
    removeObstacle(handle: ObstacleHandle): void {
        const entry = this.obstacles.get(handle);
        if (!entry) return;
        this.obstacles.delete(handle);
        this.paintShape(entry.shape, false);
        const clearedAabb = { minX: entry.minX, maxX: entry.maxX, minZ: entry.minZ, maxZ: entry.maxZ };
        for (const other of this.obstacles.values()) {
            if (this.aabbsOverlap(other, entry)) {
                // Clipped: only cells inside the removed footprint were cleared.
                this.paintShape(other.shape, true, clearedAabb);
            }
        }
    }

    // ─── Shape painting + geometry ──────────────────────────────────────────
    // (World-space XZ AABB used for clipped re-paints.)

    /**
     * Paint (or clear) a shape's inflated footprint. When `clip` (a world-space
     * XZ AABB) is given, only cells inside it are touched — used when restoring
     * a neighbour after another obstacle moved/was removed, so a large obstacle
     * never re-paints its whole footprint because a small one shifted nearby.
     */
    private paintShape(shape: ObstacleShape, blocked: boolean, clip?: ObstacleAABB): void {
        if (shape.kind === 'circle') this.paintCircle(shape, blocked, clip);
        else this.paintBox(shape, blocked, clip);
    }

    private paintCircle(c: CircleObstacle, blocked: boolean, clip?: ObstacleAABB): void {
        const inflated = c.radius + this.agentRadius;
        const inflatedSq = inflated * inflated;
        const gxCentre = (c.x - this.minX) / this.cellSize;
        const gzCentre = (c.z - this.minZ) / this.cellSize;
        const radiusInCells = Math.ceil(inflated / this.cellSize);
        let gxMin = Math.floor(gxCentre - radiusInCells);
        let gxMax = Math.floor(gxCentre + radiusInCells);
        let gzMin = Math.floor(gzCentre - radiusInCells);
        let gzMax = Math.floor(gzCentre + radiusInCells);
        if (clip) {
            gxMin = Math.max(gxMin, Math.floor((clip.minX - this.minX) / this.cellSize));
            gxMax = Math.min(gxMax, Math.floor((clip.maxX - this.minX) / this.cellSize));
            gzMin = Math.max(gzMin, Math.floor((clip.minZ - this.minZ) / this.cellSize));
            gzMax = Math.min(gzMax, Math.floor((clip.maxZ - this.minZ) / this.cellSize));
        }
        for (let gx = gxMin; gx <= gxMax; gx++) {
            for (let gz = gzMin; gz <= gzMax; gz++) {
                const cx = this.minX + (gx + 0.5) * this.cellSize;
                const cz = this.minZ + (gz + 0.5) * this.cellSize;
                if ((cx - c.x) ** 2 + (cz - c.z) ** 2 > inflatedSq) continue;
                this.setCellObstacleBit(gx, gz, blocked, c.y);
            }
        }
    }

    /**
     * Paint a rotated rectangle obstacle. Inflation uses **box-on-box**
     * Minkowski sum (the agent is treated as a square of half-size
     * `agentRadius`, not a circle). The result is a strictly larger
     * axis-aligned-in-local-frame rectangle with **sharp corners** — the
     * blocked footprint covers the actual obstacle corner instead of the
     * curved keep-out zone an agent-circle would carve.
     *
     * Why sharp corners matter: NPCs aren't perfectly round, and the path
     * smoother / corner-cutting in NavigationComponent tends to clip the
     * corner of the obstacle when the navmesh only blocks a curved arc.
     * A sharp inflated rectangle keeps the corner safely inside the
     * blocked zone, so the smoothed path never clips it.
     */
    private paintBox(b: BoxObstacle, blocked: boolean, clip?: ObstacleAABB): void {
        const yaw = b.yaw ?? 0;
        const cosY = Math.cos(yaw);
        const sinY = Math.sin(yaw);
        const absCos = Math.abs(cosY);
        const absSin = Math.abs(sinY);
        // Inflated box's local half-extents (sharp corners — no rounding).
        const ihW = b.halfW + this.agentRadius;
        const ihD = b.halfD + this.agentRadius;
        // World-AABB of the rotated, inflated box.
        const aabbHalfW = ihW * absCos + ihD * absSin;
        const aabbHalfD = ihW * absSin + ihD * absCos;
        let gxMin = Math.floor((b.x - aabbHalfW - this.minX) / this.cellSize);
        let gxMax = Math.floor((b.x + aabbHalfW - this.minX) / this.cellSize);
        let gzMin = Math.floor((b.z - aabbHalfD - this.minZ) / this.cellSize);
        let gzMax = Math.floor((b.z + aabbHalfD - this.minZ) / this.cellSize);
        if (clip) {
            gxMin = Math.max(gxMin, Math.floor((clip.minX - this.minX) / this.cellSize));
            gxMax = Math.min(gxMax, Math.floor((clip.maxX - this.minX) / this.cellSize));
            gzMin = Math.max(gzMin, Math.floor((clip.minZ - this.minZ) / this.cellSize));
            gzMax = Math.min(gzMax, Math.floor((clip.maxZ - this.minZ) / this.cellSize));
        }
        for (let gx = gxMin; gx <= gxMax; gx++) {
            for (let gz = gzMin; gz <= gzMax; gz++) {
                const cx = this.minX + (gx + 0.5) * this.cellSize;
                const cz = this.minZ + (gz + 0.5) * this.cellSize;
                // Transform cell centre into box-local space. Three.js
                // `Object3D.rotation.y = θ` maps local +Z to world
                // (sin θ, 0, cos θ) — the gameplay-forward convention. The
                // inverse rotation R_y(-θ) takes a world XZ point into the
                // box's local frame:
                //   lx =  cosθ · wx − sinθ · wz
                //   lz =  sinθ · wx + cosθ · wz
                // (Earlier versions of this file used the forward rotation
                // by mistake, which rotated the blocked footprint in the
                // *opposite* direction from the object's yaw — visible in
                // the debug overlay as a mask mirrored across the object.)
                const rx = cx - b.x;
                const rz = cz - b.z;
                const lx = rx * cosY - rz * sinY;
                const lz = rx * sinY + rz * cosY;
                // Sharp-corner test: inside the local inflated rectangle.
                if (Math.abs(lx) > ihW || Math.abs(lz) > ihD) continue;
                this.setCellObstacleBit(gx, gz, blocked, b.y);
            }
        }
    }

    /**
     * Set or clear OBSTACLE_BIT on a single global cell. `y`, when given,
     * restricts the change to the stacked layer nearest that height — an
     * obstacle on the ground floor must not block the balcony above it.
     */
    private setCellObstacleBit(gx: number, gz: number, value: boolean, y?: number): void {
        const cps = this.cellsPerChunkSide;
        const cx = Math.floor(gx / cps);
        const cz = Math.floor(gz / cps);
        const chunk = this.getChunk(cx, cz);
        if (!chunk) return;
        let packed: PackedChunk;
        if (chunk.kind === 'trivial') {
            // Trivial chunk has no obstacle bit set anywhere — clearing is a no-op.
            if (!value) return;
            packed = this.promoteToGrid(chunk);
        } else {
            packed = chunk;
        }
        const lx = gx - cx * cps;
        const lz = gz - cz * cps;
        if (y !== undefined) {
            const layer = this.nearestLayerIdx(gx, gz, y);
            if (layer >= 0) this.setCellBits(packed, lx, lz, OBSTACLE_BIT, value, layer);
            return;
        }
        const layers = this.packedLayers(packed);
        for (let i = 0; i < layers; i++) {
            this.setCellBits(packed, lx, lz, OBSTACLE_BIT, value, i);
        }
    }

    private computeInflatedAABB(shape: ObstacleShape): { minX: number; maxX: number; minZ: number; maxZ: number } {
        if (shape.kind === 'circle') {
            const r = shape.radius + this.agentRadius;
            return { minX: shape.x - r, maxX: shape.x + r, minZ: shape.z - r, maxZ: shape.z + r };
        }
        // Matches paintBox: box-on-box inflation (sharp corners), then
        // world-AABB of the rotated inflated box.
        const yaw = shape.yaw ?? 0;
        const absCos = Math.abs(Math.cos(yaw));
        const absSin = Math.abs(Math.sin(yaw));
        const ihW = shape.halfW + this.agentRadius;
        const ihD = shape.halfD + this.agentRadius;
        const hw = ihW * absCos + ihD * absSin;
        const hd = ihW * absSin + ihD * absCos;
        return { minX: shape.x - hw, maxX: shape.x + hw, minZ: shape.z - hd, maxZ: shape.z + hd };
    }

    private aabbsOverlap(
        a: { minX: number; maxX: number; minZ: number; maxZ: number },
        b: { minX: number; maxX: number; minZ: number; maxZ: number },
    ): boolean {
        return a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ;
    }

    // ─── Walkability / step rules ───────────────────────────────────────────

    /** Height rule: a step is allowed when the rise/drop stays inside the limits. */
    private stepAllowed(fromY: number, toY: number): boolean {
        const heightDiff = toY - fromY;
        return heightDiff <= this.stepUpM && heightDiff >= -this.stepDownM;
    }

    /**
     * Check if we can step from one cell layer to a layer of an adjacent cell.
     * Only considers height difference - no "walls between" in voxel world.
     */
    private canStepLayer(
        fromGx: number, fromGz: number, fromLayer: number,
        toGx: number, toGz: number, toLayer: number,
    ): boolean {
        const from = this.getLayer(fromGx, fromGz, fromLayer);
        const to = this.getLayer(toGx, toGz, toLayer);
        if (!from || !to || from.blocked || to.blocked) return false;
        if (!this.stepAllowed(from.groundY, to.groundY)) return false;

        // For diagonal, ensure both cardinal neighbors are also passable —
        // on whichever of their layers the agent could actually stand on.
        const dx = toGx - fromGx;
        const dz = toGz - fromGz;
        if (dx !== 0 && dz !== 0) {
            if (this.reachableLayerIdx(fromGx + dx, fromGz, from.groundY) < 0) return false;
            if (this.reachableLayerIdx(fromGx, fromGz + dz, from.groundY) < 0) return false;
        }

        return true;
    }

    /**
     * Cell-level step check. Without `fromRefY` the source layer is the
     * topmost one (the 2.5D reading); the destination layer is always the one
     * an agent standing on the source could step onto.
     */
    private canStep(fromGx: number, fromGz: number, toGx: number, toGz: number, fromRefY?: number): boolean {
        const fromLayer = fromRefY === undefined
            ? this.getLayerCount(fromGx, fromGz) - 1
            : this.nearestLayerIdx(fromGx, fromGz, fromRefY);
        const from = this.getLayer(fromGx, fromGz, fromLayer);
        if (!from || from.blocked) return false;
        const toLayer = this.reachableLayerIdx(toGx, toGz, from.groundY);
        if (toLayer < 0) return false;
        return this.canStepLayer(fromGx, fromGz, fromLayer, toGx, toGz, toLayer);
    }

    // ─── A* pathfinding ────────────────────────────────────────────────────

    /**
     * If start or end positions are not on walkable cells, returns a straight-line
     * path to the end position. Use isValidNavigationTarget() to check validity first.
     *
     * `extraObstacles`, when supplied, are treated as additional blocked
     * circles for this query only — they don't mutate the navmesh. This is
     * how the PathConflictAvoidance system inserts other agents into the
     * search so an agent re-plans around them, without the self-blocking
     * problem you'd get from mutating the global navmesh per agent. The
     * caller is responsible for excluding the agent itself from the list.
     *
     * `maxPathLength` caps how far (in metres of accumulated path) A* will
     * search. Branches that would exceed the budget are pruned, so an
     * unreachable target fails fast instead of expanding the entire
     * reachable area. **The default is `max(20 m, linearDistance × 1.3)`** —
     * 30% slack over the straight-line distance, with a 20 m floor for very
     * short targets. Callers that need to plan longer routes (e.g. an AI
     * agent setting up a cross-map errand) should pass an explicit higher
     * value. Without this cap, a fine 0.125 m navmesh can spend hundreds
     * of milliseconds exploring an unreachable subgraph.
     */
    findPath(
        start: THREE.Vector3,
        end: THREE.Vector3,
        extraObstacles?: ReadonlyArray<{ x: number; z: number; radius: number }>,
        maxPathLength?: number,
    ): THREE.Vector3[] {
        if (!this.isBuilt) return [end.clone()];

        const sg = this.worldToGrid(start.x, start.z);
        const eg = this.worldToGrid(end.x, end.z);

        // Start and end layers come from the Vector3 Y — on a single-layer
        // mesh both resolve to layer 0 and this is the previous behaviour.
        const validStart = this.findValidCell(sg.gx, sg.gz, start.y);
        if (!validStart) return [end.clone()];
        const endLayer = this.nearestWalkableLayerIdx(eg.gx, eg.gz, end.y);
        if (endLayer < 0) return [end.clone()];
        if (validStart.gx === eg.gx && validStart.gz === eg.gz && validStart.layer === endLayer) return [end.clone()];

        // Resolve the path-length budget. Default: 30% slack over the straight-
        // line cost estimate, never less than 20 m for short hops. This is the
        // primary mechanism preventing runaway A* — the iteration cap is
        // just defense-in-depth below.
        //
        // The estimate carries the vertical leg because `g` also charges
        // CLIMB_COST per metre climbed. On a level query the vertical term is
        // zero and this is the old formula; without it a stairwell spends its
        // whole budget on climb cost and every cross-floor query fails.
        const linearDist = Math.sqrt(
            (end.x - start.x) * (end.x - start.x) + (end.z - start.z) * (end.z - start.z),
        );
        const verticalCost = Math.abs(end.y - start.y) * (1 + CLIMB_COST);
        const budgetMeters = maxPathLength ?? Math.max(20, (linearDist + verticalCost) * 1.3);
        const budgetG = budgetMeters / this.cellSize;

        // Pre-bin extras into a Set of grid-cell keys covered by any
        // inflated circle. Inner A* expansion then asks "is this cell in
        // the set?" — O(1) instead of O(extras) per cell. The bin cost is
        // O(extras × radius²) up front but radius is tiny (a couple of
        // cells per extra), so total bin cost is negligible vs the inner
        // A* loop which can run hundreds of thousands of times.
        //
        // Treat extras as inflated by the agent radius, same as static
        // box/circle obstacles — otherwise the path could route within
        // grazing distance of another agent.
        const hasExtras = extraObstacles !== undefined && extraObstacles.length > 0;
        const extrasBlockedCells = hasExtras ? new Set<number>() : null;
        if (hasExtras && extrasBlockedCells) {
            // Pre-compute the start cell's world centre. If an extra's inflated
            // zone contains the start cell, we can't bin its cells at the full
            // radius — A* would have no walkable neighbour to step into and the
            // path would come back empty, even though the agent is sitting on
            // a real navigable cell. Instead, shrink that extra's effective
            // radius to *just inside* the start so A* can step OUT of the
            // pocket on the first move (cells further from the peer than the
            // start are unblocked, cells deeper into the peer's zone stay
            // blocked). For extras the agent is NOT inside, the full inflated
            // radius applies as before.
            const startCellX = this.minX + (validStart.gx + 0.5) * this.cellSize;
            const startCellZ = this.minZ + (validStart.gz + 0.5) * this.cellSize;
            for (const e of extraObstacles!) {
                const fullInflated = e.radius + this.agentRadius;
                const dxStart = startCellX - e.x;
                const dzStart = startCellZ - e.z;
                const startDistSq = dxStart * dxStart + dzStart * dzStart;
                let effective = fullInflated;
                if (startDistSq <= fullInflated * fullInflated) {
                    // Shrink to one cell inside start distance so the start
                    // cell is reliably unblocked but the bulk of the peer's
                    // zone is still impassable.
                    const startDist = Math.sqrt(startDistSq);
                    effective = startDist - this.cellSize;
                    if (effective < this.cellSize * 0.5) continue; // peer too close — skip entirely
                }
                const inflatedSq = effective * effective;
                const gxMin = Math.max(0, Math.floor((e.x - effective - this.minX) / this.cellSize));
                const gxMax = Math.min(this.cols - 1, Math.floor((e.x + effective - this.minX) / this.cellSize));
                const gzMin = Math.max(0, Math.floor((e.z - effective - this.minZ) / this.cellSize));
                const gzMax = Math.min(this.rows - 1, Math.floor((e.z + effective - this.minZ) / this.cellSize));
                for (let gx = gxMin; gx <= gxMax; gx++) {
                    const cx = this.minX + (gx + 0.5) * this.cellSize;
                    const dx = cx - e.x;
                    const dxSq = dx * dx;
                    for (let gz = gzMin; gz <= gzMax; gz++) {
                        const cz = this.minZ + (gz + 0.5) * this.cellSize;
                        const dz = cz - e.z;
                        if (dxSq + dz * dz <= inflatedSq) {
                            extrasBlockedCells.add(gx * this.rows + gz);
                        }
                    }
                }
            }
        }
        const cellBlockedByExtras = (gx: number, gz: number): boolean => {
            return extrasBlockedCells !== null && extrasBlockedCells.has(gx * this.rows + gz);
        };

        // Node identity is (cell, layer): stacked floors of the same column
        // are separate nodes, reachable from each other only through cells
        // that actually connect them (a stair, a ramp).
        const key = (gx: number, gz: number, layer: number) => (gx * this.rows + gz) * MAX_NAV_LAYERS + layer;
        const gScore = new Map<number, number>();
        const parent = new Map<number, number>();
        const closed = new Set<number>();
        const heap = new MinHeap();

        const startKey = key(validStart.gx, validStart.gz, validStart.layer);
        const endKey = key(eg.gx, eg.gz, endLayer);
        gScore.set(startKey, 0);
        heap.push({
            gx: validStart.gx, gz: validStart.gz, layer: validStart.layer,
            g: 0, f: this.heuristic(validStart.gx, validStart.gz, eg.gx, eg.gz),
        });

        const dirs = [
            { dx: 1, dz: 0, cost: 1 }, { dx: -1, dz: 0, cost: 1 },
            { dx: 0, dz: 1, cost: 1 }, { dx: 0, dz: -1, cost: 1 },
            { dx: 1, dz: 1, cost: DIAGONAL_COST }, { dx: -1, dz: 1, cost: DIAGONAL_COST },
            { dx: 1, dz: -1, cost: DIAGONAL_COST }, { dx: -1, dz: -1, cost: DIAGONAL_COST },
        ];

        // Scale the iteration cap so finer grids get proportionally more
        // budget. At 0.25m, a 60m path may legitimately need ~240 cells in a
        // straight line plus exploration overhead. This is a defence-in-
        // depth cap — the primary bound is the `maxPathLength` distance
        // budget above, which prunes branches by metres traveled.
        const maxIterations = Math.ceil(BASE_MAX_ITERATIONS / (this.cellSize * this.cellSize));

        let iterations = 0;
        while (heap.size > 0 && iterations++ < maxIterations) {
            const cur = heap.pop()!;
            const curLayer = cur.layer ?? 0;
            const curKey = key(cur.gx, cur.gz, curLayer);

            if (closed.has(curKey)) continue;
            closed.add(curKey);

            if (curKey === endKey) {
                const raw = this.buildPath(parent, key, eg, endLayer, end);
                return this.smoothPath(raw, extrasBlockedCells);
            }

            const curCell = this.getLayer(cur.gx, cur.gz, curLayer);
            if (!curCell) continue;

            for (const dir of dirs) {
                const nx = cur.gx + dir.dx;
                const nz = cur.gz + dir.dz;
                if (nx < 0 || nx >= this.cols || nz < 0 || nz >= this.rows) continue;
                if (cellBlockedByExtras(nx, nz)) continue;

                // Every layer of the neighbour cell is its own candidate node.
                const nLayers = this.getLayerCount(nx, nz);
                for (let nLayer = 0; nLayer < nLayers; nLayer++) {
                    const nKey = key(nx, nz, nLayer);
                    if (closed.has(nKey)) continue;
                    if (!this.canStepLayer(cur.gx, cur.gz, curLayer, nx, nz, nLayer)) continue;

                    const neighborCell = this.getLayer(nx, nz, nLayer);
                    if (!neighborCell) continue;

                    const heightDiff = neighborCell.groundY - curCell.groundY;
                    const climbCost = heightDiff > 0 ? heightDiff * CLIMB_COST : 0;
                    const tentativeG = cur.g + dir.cost + climbCost;

                    // Prune branches that exceed the path-length budget. `g`
                    // accumulates cell-cost units (cardinal=1, diagonal=√2,
                    // plus climb cost); multiplied by cellSize this is metres
                    // of XZ path travelled (climb cost overestimates slightly,
                    // which is fine — it just prunes climby detours sooner).
                    if (tentativeG > budgetG) continue;

                    const prevG = gScore.get(nKey);
                    if (prevG !== undefined && tentativeG >= prevG) continue;

                    gScore.set(nKey, tentativeG);
                    parent.set(nKey, curKey);
                    heap.push({
                        gx: nx, gz: nz, layer: nLayer,
                        g: tentativeG, f: tentativeG + this.heuristic(nx, nz, eg.gx, eg.gz),
                    });
                }
            }
        }

        // No path. Empty array signals "unreachable" (vs straight-line fallbacks above).
        return [];
    }

    private worldToGrid(x: number, z: number) {
        return {
            gx: Math.max(0, Math.min(this.cols - 1, Math.floor((x - this.minX) / this.cellSize))),
            gz: Math.max(0, Math.min(this.rows - 1, Math.floor((z - this.minZ) / this.cellSize))),
        };
    }

    private isWalkable(gx: number, gz: number): boolean {
        const cell = this.getCell(gx, gz);
        return cell !== null && !cell.blocked;
    }

    /**
     * Nearest usable cell to (gx, gz), ranked outwards in rings. Candidate
     * layers within a cell are ranked by distance from `refY`.
     */
    private findValidCell(gx: number, gz: number, refY: number): { gx: number; gz: number; layer: number } | null {
        const at = (cx: number, cz: number): { gx: number; gz: number; layer: number } | null => {
            const layer = this.nearestWalkableLayerIdx(cx, cz, refY);
            return layer >= 0 ? { gx: cx, gz: cz, layer } : null;
        };
        const self = at(gx, gz);
        if (self) return self;
        const maxRing = Math.max(1, Math.ceil(FIND_NEAREST_DEFAULT_RADIUS_M / this.cellSize));
        for (let r = 1; r <= maxRing; r++) {
            for (let dx = -r; dx <= r; dx++) {
                for (const dz of [-r, r]) {
                    const hit = at(gx + dx, gz + dz);
                    if (hit) return hit;
                }
            }
            for (let dz = -r + 1; dz < r; dz++) {
                for (const dx of [-r, r]) {
                    const hit = at(gx + dx, gz + dz);
                    if (hit) return hit;
                }
            }
        }
        return null;
    }

    private heuristic(ax: number, az: number, bx: number, bz: number): number {
        const dx = Math.abs(ax - bx), dz = Math.abs(az - bz);
        return Math.max(dx, dz) + 0.414 * Math.min(dx, dz);
    }

    private buildPath(
        parent: Map<number, number>,
        key: (gx: number, gz: number, layer: number) => number,
        endGrid: { gx: number; gz: number },
        endLayer: number,
        end: THREE.Vector3,
    ): THREE.Vector3[] {
        const path: { gx: number; gz: number; layer: number }[] = [];
        let k: number | undefined = key(endGrid.gx, endGrid.gz, endLayer);
        while (k !== undefined) {
            const layer = k % MAX_NAV_LAYERS;
            const cell = (k - layer) / MAX_NAV_LAYERS;
            const gz = cell % this.rows;
            const gx = (cell - gz) / this.rows;
            path.unshift({ gx, gz, layer });
            k = parent.get(k);
        }
        if (path.length > 1) path.shift(); // Remove start

        const result: THREE.Vector3[] = [];
        for (const p of path) {
            const cell = this.getLayer(p.gx, p.gz, p.layer);
            result.push(this.cellToWorldPos(p.gx, p.gz, cell?.groundY ?? 0));
        }
        if (result.length === 0) {
            const endCell = this.getLayer(endGrid.gx, endGrid.gz, endLayer);
            result.push(this.cellToWorldPos(endGrid.gx, endGrid.gz, endCell?.groundY ?? end.y));
        }
        return result;
    }

    /**
     * String-pulling: collapse runs of waypoints that share line-of-sight into
     * a single segment. Critical at fine resolutions — a 30m straight walk
     * generates 240 waypoints at 0.125m, and feeding those to NavigationComponent
     * would make the NPC micro-turn on every step.
     */
    private smoothPath(path: THREE.Vector3[], extrasBlockedCells: Set<number> | null): THREE.Vector3[] {
        if (path.length <= 2) return path;
        const smoothed: THREE.Vector3[] = [];
        let anchor = 0;
        smoothed.push(path[anchor]!);
        while (anchor < path.length - 1) {
            // Greedy: find the farthest index reachable from `anchor` via LOS.
            let farthest = anchor + 1;
            for (let i = anchor + 2; i < path.length; i++) {
                if (this.hasLineOfSight(path[anchor]!, path[i]!, extrasBlockedCells)) {
                    farthest = i;
                } else {
                    break;
                }
            }
            smoothed.push(path[farthest]!);
            anchor = farthest;
        }
        return smoothed;
    }

    /**
     * Walks the grid line from a → b and returns true if every intermediate
     * cell is walkable and step-compatible with its predecessor. Uses a
     * conservative DDA-style trace at half-cell increments so it doesn't
     * miss thin diagonal blockers.
     *
     * `extrasBlockedCells`, when supplied, also rejects the segment if any
     * traced cell is in the per-query virtual-obstacle set. Without this
     * check, A* would correctly detour around an extra but then smoothing
     * would collapse the detour back to the original straight line
     * (because static-navmesh LOS is intact) — the visible symptom being
     * one NPC walking straight through another's flagged-conflict ring.
     */
    private hasLineOfSight(a: THREE.Vector3, b: THREE.Vector3, extrasBlockedCells: Set<number> | null = null): boolean {
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const dist = Math.hypot(dx, dz);
        // Sub-cell hop: no cells to trace. Distinct cell centres are always at
        // least one cellSize apart, so this only fires for two layers of the
        // SAME column (a spiral stair) — which is a shortcut only if the step
        // rules allow it.
        if (dist < this.cellSize) return this.stepAllowed(a.y, b.y);
        const steps = Math.ceil((dist / this.cellSize) * 2);
        // The traced layer follows the walk: each cell is entered on the layer
        // closest to the height we left the previous one at. A segment that
        // would need a layer change the step rules forbid is rejected.
        let prevGx = -1, prevGz = -1, prevLayer = -1, prevY = a.y;
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const x = a.x + dx * t;
            const z = a.z + dz * t;
            const gx = Math.floor((x - this.minX) / this.cellSize);
            const gz = Math.floor((z - this.minZ) / this.cellSize);
            if (gx === prevGx && gz === prevGz) continue;
            const layer = prevGx < 0
                ? this.nearestWalkableLayerIdx(gx, gz, prevY)
                : this.reachableLayerIdx(gx, gz, prevY);
            if (layer < 0) return false;
            if (prevGx >= 0 && !this.canStepLayer(prevGx, prevGz, prevLayer, gx, gz, layer)) return false;
            if (extrasBlockedCells !== null && extrasBlockedCells.has(gx * this.rows + gz)) return false;
            const cell = this.getLayer(gx, gz, layer);
            if (!cell) return false;
            prevGx = gx;
            prevGz = gz;
            prevLayer = layer;
            prevY = cell.groundY;
        }
        // The trace must ARRIVE on the layer `b` stands on. Without this a
        // straight line that runs UNDER a walkway reports line of sight to a
        // waypoint on top of it — the trace quietly stays on the lower layer —
        // and string-pulling then collapses the whole detour to the ramp into
        // one vertical teleport.
        return Math.abs(prevY - b.y) <= LAYER_MATCH_EPSILON;
    }

    // ─── Public API ─────────────────────────────────────────────────────────

    isReady(): boolean { return this.isBuilt; }

    /**
     * Step-height limits (world units) used by canStep — lets cell-based
     * consumers (GoalField) replicate edge checks locally on cached ground
     * heights instead of paying a nav call per edge.
     */
    getStepLimits(): { maxClimbUp: number; maxDropDown: number } {
        return { maxClimbUp: this.stepUpM, maxDropDown: this.stepDownM };
    }

    /** Public grid metadata for external cell-based consumers (GoalField). Null until built. */
    getGridInfo(): { cols: number; rows: number; minX: number; minZ: number; cellSize: number } | null {
        if (!this.isBuilt) return null;
        return { cols: this.cols, rows: this.rows, minX: this.minX, minZ: this.minZ, cellSize: this.cellSize };
    }

    /**
     * Ground Y of a walkable cell by grid coords, or null if blocked/out of
     * bounds/unbuilt. `refY` picks the stacked layer nearest that height;
     * without it the topmost layer answers, as before.
     */
    getCellGroundY(gx: number, gz: number, refY?: number): number | null {
        if (!this.isBuilt || gx < 0 || gz < 0 || gx >= this.cols || gz >= this.rows) return null;
        const cell = refY === undefined ? this.getCell(gx, gz) : this.getLayer(gx, gz, this.nearestLayerIdx(gx, gz, refY));
        return cell && !cell.blocked ? cell.groundY : null;
    }

    /**
     * Whether an agent can step from cell (fromGx,fromGz) to adjacent cell
     * (toGx,toGz). `fromRefY` selects which stacked layer the agent starts on.
     */
    canStepCells(fromGx: number, fromGz: number, toGx: number, toGz: number, fromRefY?: number): boolean {
        if (!this.isBuilt) return false;
        return this.canStep(fromGx, fromGz, toGx, toGz, fromRefY);
    }

    /** World XZ -> grid coords (clamped). Null until built. */
    worldToCell(x: number, z: number): { gx: number; gz: number } | null {
        if (!this.isBuilt) return null;
        return this.worldToGrid(x, z);
    }

    /** Grid coords -> world-space cell center XZ. */
    cellToWorld(gx: number, gz: number): { x: number; z: number } {
        return { x: this.minX + (gx + 0.5) * this.cellSize, z: this.minZ + (gz + 0.5) * this.cellSize };
    }

    /** Walkable check at a world position; `position.y` selects the layer. */
    isValidNavigationTarget(position: THREE.Vector3): boolean {
        return this.isWalkableAt(position.x, position.z, position.y);
    }

    /**
     * Primitive-arg variant of `isValidNavigationTarget` for hot paths that
     * don't already hold a `THREE.Vector3` (notably `AgentAvoidance.steer`,
     * which probes per-frame for every NPC and every neighbour). Avoids the
     * Vector3 allocation churn. `refY` selects the stacked layer; without it
     * the topmost layer answers, as before.
     */
    isWalkableAt(x: number, z: number, refY?: number): boolean {
        if (!this.isBuilt) return false;
        const g = this.worldToGrid(x, z);
        if (refY === undefined) return this.isWalkable(g.gx, g.gz);
        const cell = this.getLayer(g.gx, g.gz, this.nearestLayerIdx(g.gx, g.gz, refY));
        return cell !== null && !cell.blocked;
    }

    /** Nearest walkable world position; `position.y` ranks stacked layers. */
    findNearestValidTarget(position: THREE.Vector3, maxSearchRadius?: number): THREE.Vector3 | null {
        if (!this.isBuilt) return null;
        const g = this.worldToGrid(position.x, position.z);

        const hereLayer = this.nearestLayerIdx(g.gx, g.gz, position.y);
        const here = this.getLayer(g.gx, g.gz, hereLayer);
        if (here && !here.blocked) {
            return this.cellToWorldPos(g.gx, g.gz, here.groundY);
        }

        const searchM = maxSearchRadius ?? FIND_NEAREST_DEFAULT_RADIUS_M;
        const searchRings = Math.max(1, Math.ceil(searchM / this.cellSize));
        let bestGx = -1, bestGz = -1, bestDistSq = Infinity, bestGroundY = position.y;

        for (let r = 1; r <= searchRings; r++) {
            for (let dx = -r; dx <= r; dx++) {
                for (let dz = -r; dz <= r; dz++) {
                    if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
                    const cx = g.gx + dx, cz = g.gz + dz;
                    const layer = this.nearestWalkableLayerIdx(cx, cz, position.y);
                    const cell = this.getLayer(cx, cz, layer);
                    if (!cell) continue;
                    const cellX = this.minX + (cx + 0.5) * this.cellSize;
                    const cellZ = this.minZ + (cz + 0.5) * this.cellSize;
                    const distSq = (cellX - position.x) ** 2 + (cell.groundY - position.y) ** 2 + (cellZ - position.z) ** 2;
                    if (distSq < bestDistSq) {
                        bestDistSq = distSq;
                        bestGx = cx;
                        bestGz = cz;
                        bestGroundY = cell.groundY;
                    }
                }
            }
            if (bestGx >= 0 && bestDistSq < ((r + 1) * this.cellSize) ** 2) break;
        }

        if (bestGx < 0) return null;
        return this.cellToWorldPos(bestGx, bestGz, bestGroundY);
    }

    private cellToWorldPos(gx: number, gz: number, y: number): THREE.Vector3 {
        return new THREE.Vector3(
            this.minX + (gx + 0.5) * this.cellSize,
            y,
            this.minZ + (gz + 0.5) * this.cellSize,
        );
    }

    /**
     * Get the ground height at a position according to the navmesh.
     * Returns null if the position is outside the navmesh or not walkable.
     * `refY` picks the stacked layer nearest that height; without it the
     * topmost layer answers, as before.
     */
    getGroundHeight(x: number, z: number, refY?: number): number | null {
        if (!this.isBuilt) return null;
        const g = this.worldToGrid(x, z);
        const cell = refY === undefined
            ? this.getCell(g.gx, g.gz)
            : this.getLayer(g.gx, g.gz, this.nearestLayerIdx(g.gx, g.gz, refY));
        return cell?.groundY ?? null;
    }

    // ─── Debug visualization ────────────────────────────────────────────────

    /**
     * Render the navmesh as a transparent quad layer for debugging. Only
     * **blocked** cells (obstacle or terrain bit set) are drawn — at fine
     * resolutions (0.125 m on a 256 m world) drawing every walkable cell
     * would produce 16 M+ vertices and hang the browser. Walkable cells are
     * the default state, so their absence in the overlay is the "passable"
     * signal.
     *
     * Cell colour encodes WHY a cell is blocked:
     *  • red       — obstacle (registered via addObstacle / addTrackedObstacle)
     *  • yellow    — terrain clip (pass-2 agent-radius rule, set at build)
     *  • orange    — both bits set
     *
     * The mesh is a static snapshot at the moment of the call. To refresh
     * after obstacles change, call `visualize(scene)` again (it disposes
     * the prior mesh first).
     */
    visualize(scene: THREE.Scene): void {
        this.removeVisualization(scene);
        if (!this.isBuilt) return;

        const positions: number[] = [];
        const colors: number[] = [];
        const indices: number[] = [];
        const pad = 0.05 * this.cellSize;
        const s = this.cellSize - 2 * pad;
        let vi = 0;

        // Iterate per-chunk so we only touch Grid chunks (Trivial / Empty
        // chunks have no blocked cells to render — that's the whole point of
        // the three-state model).
        for (const chunk of this.chunks.values()) {
            if (chunk.kind === 'trivial') continue;
            const baseGx = chunk.cx * this.cellsPerChunkSide;
            const baseGz = chunk.cz * this.cellsPerChunkSide;
            const layers = this.packedLayers(chunk);
            for (let lx = 0; lx < chunk.cellsPerSide; lx++) {
                for (let lz = 0; lz < chunk.cellsPerSide; lz++) {
                    for (let layer = 0; layer < layers; layer++) {
                        const v = chunk.data[this.packedIndex(chunk, lx, lz, layer)]!;
                        if (v === VOID_SENTINEL) continue;
                        const obstacleBit = (v & OBSTACLE_BIT) !== 0;
                        const terrainBit = (v & TERRAIN_BIT) !== 0;
                        if (!obstacleBit && !terrainBit) continue;
                        const gx = baseGx + lx;
                        const gz = baseGz + lz;
                        const y = chunk.baseY + (v >> DELTA_SHIFT) * chunk.voxelSize + 0.1;
                        // Red for obstacle, yellow for terrain clip, orange for both.
                        let r: number, g: number, b: number;
                        if (obstacleBit && terrainBit) { r = 1.0; g = 0.5; b = 0.0; }
                        else if (obstacleBit)         { r = 0.95; g = 0.15; b = 0.15; }
                        else                          { r = 0.95; g = 0.85; b = 0.15; }
                        const x0 = this.minX + gx * this.cellSize + pad;
                        const z0 = this.minZ + gz * this.cellSize + pad;
                        const base = vi;
                        positions.push(x0, y, z0, x0 + s, y, z0, x0 + s, y, z0 + s, x0, y, z0 + s);
                        for (let i = 0; i < 4; i++) colors.push(r, g, b);
                        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
                        vi += 4;
                    }
                }
            }
        }

        if (vi === 0) {
            // No blocked cells. Still install an empty mesh so removeVisualization
            // has something to clean up on toggle-off.
            this.debugMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
            return;
        }

        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        geom.setIndex(indices);
        ensureNormalAttribute(geom);

        this.debugMesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({
            vertexColors: true, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false,
        }));
        this.debugMesh.renderOrder = 9998;
        scene.add(this.debugMesh);
    }

    removeVisualization(scene: THREE.Scene): void {
        if (this.debugMesh) {
            scene.remove(this.debugMesh);
            this.debugMesh.geometry.dispose();
            (this.debugMesh.material as THREE.Material).dispose();
            this.debugMesh = null;
        }
    }

    dispose(): void {
        this.chunks.clear();
        this.obstacles.clear();
        this.nextObstacleId = 1;
        this.voxelWorld = null;
        this.isBuilt = false;
    }
}

// ── Global registry ─────────────────────────────────────────────────────────

let globalNavMesh: VoxelNavMesh | null = null;

/**
 * One entry per long-lived obstacle (currently: every world.json env object
 * registered through `VoxelObject.setNavmeshObstacleEnabled`). The provider's
 * `getShape` callback is kept at module level, separate from any specific
 * navmesh instance — so when Game.ts rebuilds the navmesh by constructing
 * a new `VoxelNavMesh` (instead of calling `buildFromVoxelWorld` on the
 * existing one), `setGlobalNavMesh` can transparently re-attach every
 * provider to the new instance. Without this registry, every obstacle would
 * be lost the first time the 1 m default navmesh is swapped for a 0.125 m
 * high-res one.
 */
export interface ObstacleProvider {
    /** Live shape getter. Returning null removes the obstacle. */
    getShape: () => ObstacleShape | null;
    /** Current navmesh handle (0 = not currently attached). */
    currentHandle: ObstacleHandle;
}

const obstacleProviders: Set<ObstacleProvider> = new Set();

/**
 * Register a tracked obstacle that survives `setGlobalNavMesh` swaps.
 * Returns a provider record whose `currentHandle` always reflects the
 * current navmesh's handle for this obstacle (0 if no navmesh is active).
 * Call `unregisterObstacleProvider(provider)` to remove it.
 */
export function registerObstacleProvider(getShape: () => ObstacleShape | null): ObstacleProvider {
    const provider: ObstacleProvider = { getShape, currentHandle: 0 };
    obstacleProviders.add(provider);
    if (globalNavMesh) {
        const shape = getShape();
        if (shape) provider.currentHandle = globalNavMesh.addTrackedObstacle(getShape);
    }
    return provider;
}

/** Unregister a provider. Idempotent. */
export function unregisterObstacleProvider(provider: ObstacleProvider): void {
    obstacleProviders.delete(provider);
    if (globalNavMesh && provider.currentHandle !== 0) {
        globalNavMesh.removeObstacle(provider.currentHandle);
    }
    provider.currentHandle = 0;
}

/**
 * Install a new global navmesh. Re-attaches every registered obstacle
 * provider to the new instance so handles stay valid across rebuilds.
 * Providers whose `getShape()` returns null (source object destroyed) are
 * auto-evicted from the registry.
 */
export function setGlobalNavMesh(navMesh: VoxelNavMesh | null): void {
    // Same-instance re-set is a no-op — otherwise we'd duplicate every
    // registered obstacle in the navmesh's internal map.
    if (globalNavMesh === navMesh) return;
    globalNavMesh = navMesh;
    if (!navMesh) {
        for (const p of obstacleProviders) p.currentHandle = 0;
        return;
    }
    const dead: ObstacleProvider[] = [];
    for (const p of obstacleProviders) {
        const shape = p.getShape();
        if (!shape) {
            dead.push(p);
            p.currentHandle = 0;
            continue;
        }
        p.currentHandle = navMesh.addTrackedObstacle(p.getShape);
    }
    for (const p of dead) obstacleProviders.delete(p);
}

export function getGlobalNavMesh(): VoxelNavMesh | null { return globalNavMesh; }
