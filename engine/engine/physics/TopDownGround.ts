/**
 * TopDownGround — the vertical axis of the GROUND-PLANE 2D lane (top-down games).
 *
 * A top-down game plays on the world's X/Z plane. Rapier 2D simulates exactly
 * that plane (2D x = world X, 2D y = world Z, zero gravity); world Y — the axis
 * the character pipeline integrates gravity along, probes the floor along and
 * reports "grounded" against — is not simulated at all. This module is what
 * answers for it:
 *
 *  - A COLUMN HEIGHTMAP of the voxel terrain, fed per chunk from the same greedy
 *    `CollisionBox` list the 3D colliders are built from (`VoxelTerrain2DBridge`
 *    forwards `VoxelWorld.onChunkPhysicsRebuilt`). `heightAt(x, z)` is the
 *    walkable top of the highest solid voxel in that column, so a character's
 *    virtual Y follows steps, ramps of stacked blocks and the flat plate alike.
 *  - `resolveVerticalMove` — the KCC's vertical contract (fall, land, snap to a
 *    lower step, rise on a jump) as one pure function of the desired Y motion
 *    and the rest height under the destination.
 *  - ONE-WAY CLIFF WALLS. A height difference a character cannot step over
 *    (> `TOP_DOWN_STEP_MAX_M`, the same limit the 3D lane's autostep and manual
 *    step-up share) becomes a thin 2D wall on the cell boundary. The wall
 *    blocks only from BELOW: `ledgeBlocks()` lets a character whose feet are at
 *    or above the wall's top through, so walking off a ledge drops you (the
 *    column under you is lower, gravity does the rest) while walking into the
 *    same ledge from the street stops you — exactly the 3D behaviour, one axis down.
 *
 * Top-down terrain is flat by engine rule (`WorldGenerator` stamps a plane
 * whenever `cameraMode === 'top-down'`), so the common case is one height and
 * zero walls; the heightmap and walls exist for creator-edited terrain (raised
 * plazas, dug moats) and for stacked-block ramps.
 *
 * MODULE-SCOPE RULE (PhysicsFlavorAgreement.test.ts): no top-level Rapier value
 * reads — everything Rapier happens inside methods, after `initRapier2D()`.
 */
import type RAPIER2D from '@dimforge/rapier2d-compat';
import { getRapier2D } from 'engine/physics/RapierPhysics2D.js';
import type { PhysicsWorld2D } from 'engine/physics/PhysicsWorld2D.js';
import { CHUNK_SIZE, type ChunkKey, type CollisionBox } from 'engine/VoxelGeometry.js';
import { CollisionGroup, CollisionMask, makeCollisionGroups } from 'engine/CollisionLayers.js';

/**
 * Tallest rise a character walks up without a jump. Equals the shared KCC
 * autostep height and `WalkingAndJumpingMovement.STEP_MAX_HEIGHT`; a
 * difference above it is a cliff (wall), at or below it is a step (heightmap).
 */
export const TOP_DOWN_STEP_MAX_M = 0.65;
/** Placed-object geometry above the ground by more than this is overhead (an arch, a roof) and never blocks. */
export const TOP_DOWN_HEAD_CLEARANCE_M = 2.0;
/** A grounded character re-grounds on a floor this far below it (the KCC snap-to-ground distance). */
export const TOP_DOWN_SNAP_DOWN_M = 0.5;
/** Half-thickness of a cliff wall. Thin, so the standable area on both sides is the full cell. */
export const CLIFF_WALL_HALF_THICKNESS_M = 0.05;
/**
 * Finest cell the ground heightmap is worth keeping, in metres.
 *
 * The map is a GAMEPLAY surface, not a bake: what reads it is a character 0.6 m
 * wide, its step probe and the cliff walls between columns. A baked level's
 * voxel size (0.125 m) would make it 64 columns per square metre — millions of
 * cells for a 240 m level, seconds of rasterizing at load and megabytes held —
 * to place a wall more precisely than anything can stand. Feeds clamp their
 * grid to this; a coarser source (a 1 m voxel world) keeps its own size.
 */
export const GROUND_PLANE_MIN_CELL_M = 0.25;

/** Column-top value of a column with no solid voxel. */
export const NO_GROUND = -Infinity;

export interface VerticalMove {
    /** The Y motion to apply this frame. */
    dy: number;
    grounded: boolean;
}

/**
 * The vertical outcome of one character move, given the rest height (capsule
 * centre when standing) under the destination column — `null` off the terrain.
 *
 *  - rising (`desiredDy > 0`, a jump): free, unless the destination floor is
 *    higher still (walking a jump into a step lands on it);
 *  - at or below the floor: land / follow the floor up (a step);
 *  - grounded and the floor dropped by at most the snap distance: stick to it
 *    (the KCC snap-to-ground that keeps a walk down a step from becoming a fall);
 *  - otherwise: airborne, the desired (gravity) motion applies.
 */
export function resolveVerticalMove(centerY: number, desiredDy: number, restY: number | null, wasGrounded: boolean): VerticalMove {
    if (restY === null) return { dy: desiredDy, grounded: false };
    const target = centerY + desiredDy;
    if (desiredDy > 1e-9) {
        return target < restY ? { dy: restY - centerY, grounded: true } : { dy: desiredDy, grounded: false };
    }
    if (target <= restY + 1e-6) return { dy: restY - centerY, grounded: true };
    if (wasGrounded && target <= restY + TOP_DOWN_SNAP_DOWN_M) return { dy: restY - centerY, grounded: true };
    return { dy: desiredDy, grounded: false };
}

/** Index of local column (lx, lz) in a chunk's `CHUNK_SIZE × CHUNK_SIZE` top array. */
export function columnIndex(lx: number, lz: number): number {
    return lx * CHUNK_SIZE + lz;
}

/**
 * World-Y top of the highest solid box over each column of one chunk
 * (`NO_GROUND` where the chunk has none). Boxes are chunk-local voxel units,
 * as `VoxelWorld` hands them to `onChunkPhysicsRebuilt`.
 */
export function columnTopsFromBoxes(boxes: readonly CollisionBox[], voxelSize: number, chunkWorldY: number): Float32Array {
    const tops = new Float32Array(CHUNK_SIZE * CHUNK_SIZE).fill(NO_GROUND);
    for (const b of boxes) {
        const top = chunkWorldY + (b.y + b.h) * voxelSize;
        const x1 = Math.min(CHUNK_SIZE, b.x + b.w);
        const z1 = Math.min(CHUNK_SIZE, b.z + b.d);
        for (let x = Math.max(0, b.x); x < x1; x++) {
            for (let z = Math.max(0, b.z); z < z1; z++) {
                const i = columnIndex(x, z);
                if (top > tops[i]!) tops[i] = top;
            }
        }
    }
    return tops;
}

/** A walkable surface patch in world space (its top face), for `TopDownGround.setSourceRects`. */
export interface GroundRect {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
    topY: number;
}

/** One cliff wall, world space: centre, half extents (X and Z), and the two floor heights it separates. */
export interface CliffWall {
    x: number;
    z: number;
    hx: number;
    hz: number;
    top: number;
    low: number;
}

/**
 * The cliff walls a column stack owns: its +X and +Z cell boundaries (the −X
 * and −Z boundaries belong to the neighbouring stacks). `rightEdge` is the
 * neighbouring stack's `lx = 0` column (indexed by lz) and `frontEdge` its
 * `lz = 0` row (indexed by lx); null when that stack has no terrain, which is
 * a void — no wall, the character walks off and falls exactly as in 3D.
 * Runs of identical (top, low) along a boundary merge into one wall.
 */
export function cliffWallsForStack(
    merged: Float32Array,
    rightEdge: Float32Array | null,
    frontEdge: Float32Array | null,
    originX: number,
    originZ: number,
    voxelSize: number,
): CliffWall[] {
    const walls: CliffWall[] = [];
    const edge = (a: number, b: number): [number, number] | null => {
        if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
        if (Math.abs(a - b) <= TOP_DOWN_STEP_MAX_M + 1e-6) return null;
        return a > b ? [a, b] : [b, a];
    };
    // +X boundaries: for each lx, merge along lz.
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const x = originX + (lx + 1) * voxelSize;
        let run: { z0: number; top: number; low: number; n: number } | null = null;
        const flush = (): void => {
            if (!run) return;
            walls.push({ x, z: run.z0 + (run.n * voxelSize) / 2, hx: CLIFF_WALL_HALF_THICKNESS_M, hz: (run.n * voxelSize) / 2, top: run.top, low: run.low });
            run = null;
        };
        for (let lz = 0; lz < CHUNK_SIZE; lz++) {
            const h = merged[columnIndex(lx, lz)]!;
            const hr = lx + 1 < CHUNK_SIZE ? merged[columnIndex(lx + 1, lz)]! : (rightEdge ? rightEdge[lz]! : NO_GROUND);
            const e = edge(h, hr);
            if (e && run && run.top === e[0] && run.low === e[1]) { run.n++; continue; }
            flush();
            if (e) run = { z0: originZ + lz * voxelSize, top: e[0], low: e[1], n: 1 };
        }
        flush();
    }
    // +Z boundaries: for each lz, merge along lx.
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const z = originZ + (lz + 1) * voxelSize;
        let run: { x0: number; top: number; low: number; n: number } | null = null;
        const flush = (): void => {
            if (!run) return;
            walls.push({ x: run.x0 + (run.n * voxelSize) / 2, z, hx: (run.n * voxelSize) / 2, hz: CLIFF_WALL_HALF_THICKNESS_M, top: run.top, low: run.low });
            run = null;
        };
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
            const h = merged[columnIndex(lx, lz)]!;
            const hf = lz + 1 < CHUNK_SIZE ? merged[columnIndex(lx, lz + 1)]! : (frontEdge ? frontEdge[lx]! : NO_GROUND);
            const e = edge(h, hf);
            if (e && run && run.top === e[0] && run.low === e[1]) { run.n++; continue; }
            flush();
            if (e) run = { x0: originX + lx * voxelSize, top: e[0], low: e[1], n: 1 };
        }
        flush();
    }
    return walls;
}

/** One column stack's grid coordinates. */
interface StackCoord { cx: number; cz: number }

/** One stack's column tops while a source is being rasterized. */
interface StackTops extends StackCoord { tops: Float32Array }

/**
 * Visit every stack an INCLUSIVE grid range covers, handing each the sub-range
 * of its own cells and the grid coords its local (0,0) sits at.
 *
 * Per STACK rather than per cell on purpose: a level's surface is millions of
 * cells, and doing the `stackKey` string build plus a Map lookup for each of
 * them was the whole cost of feeding a baked level (seconds, at load).
 */
function forEachStack(
    perStack: Map<string, StackTops>,
    gx0: number, gx1: number, gz0: number, gz1: number,
    visit: (tops: Float32Array, lx0: number, lx1: number, lz0: number, lz1: number, gxBase: number, gzBase: number) => void,
): void {
    if (gx1 < gx0 || gz1 < gz0) return;
    const cx0 = Math.floor(gx0 / CHUNK_SIZE), cx1 = Math.floor(gx1 / CHUNK_SIZE);
    const cz0 = Math.floor(gz0 / CHUNK_SIZE), cz1 = Math.floor(gz1 / CHUNK_SIZE);
    for (let cx = cx0; cx <= cx1; cx++) {
        const gxBase = cx * CHUNK_SIZE;
        const lx0 = Math.max(gx0 - gxBase, 0), lx1 = Math.min(gx1 - gxBase, CHUNK_SIZE - 1);
        for (let cz = cz0; cz <= cz1; cz++) {
            const gzBase = cz * CHUNK_SIZE;
            const lz0 = Math.max(gz0 - gzBase, 0), lz1 = Math.min(gz1 - gzBase, CHUNK_SIZE - 1);
            const sk = stackKey(cx, cz);
            let entry = perStack.get(sk);
            if (!entry) { entry = { cx, cz, tops: new Float32Array(CHUNK_SIZE * CHUNK_SIZE).fill(NO_GROUND) }; perStack.set(sk, entry); }
            visit(entry.tops, lx0, lx1, lz0, lz1, gxBase, gzBase);
        }
    }
}

export function stackKey(cx: number, cz: number): string {
    return `${cx},${cz}`;
}

interface ChunkTops {
    cx: number;
    cy: number;
    cz: number;
    tops: Float32Array;
}

interface Stack {
    cx: number;
    cz: number;
    keys: Set<ChunkKey>;
    /** Column tops merged over the stack's chunks; null = recompute. */
    merged: Float32Array | null;
    walls: RAPIER2D.Collider[];
}

/**
 * The ground of one top-down game: column heightmap + cliff walls, kept in
 * lockstep with the terrain chunks through `setChunkTops`. Owned by the
 * plane-locked facade (`PlaneLockedPhysics.ground`), fed by
 * `VoxelTerrain2DBridge`, read by every vertical query the facade answers.
 */
export class TopDownGround {
    private grid: { minX: number; minY: number; minZ: number; voxelSize: number } | null = null;
    private readonly chunkTops = new Map<ChunkKey, ChunkTops>();
    private readonly stacks = new Map<string, Stack>();
    private readonly wallTops = new Map<number, number>();
    private readonly disabledStacks = new Set<string>();
    private readonly disabledWalls = new Set<number>();
    private body: RAPIER2D.RigidBody | null = null;

    constructor(private readonly world2D: PhysicsWorld2D) {}

    /** The voxel grid the chunks are addressed in (`VoxelWorld` bounds origin + voxel size). A changed grid drops everything. */
    setGrid(minX: number, minY: number, minZ: number, voxelSize: number): void {
        const g = this.grid;
        if (g && g.minX === minX && g.minY === minY && g.minZ === minZ && g.voxelSize === voxelSize) return;
        this.clear();
        this.grid = { minX, minY, minZ, voxelSize };
    }

    getGrid(): { minX: number; minY: number; minZ: number; voxelSize: number } | null {
        return this.grid;
    }

    /**
     * `VoxelWorld`'s per-chunk physics rebuild: `boxes` null retires the chunk.
     * Requires `setGrid` first (the bridge calls it with the world's bounds).
     */
    setChunkTops(key: ChunkKey, cx: number, cy: number, cz: number, boxes: readonly CollisionBox[] | null): void {
        const grid = this.grid;
        if (!grid) throw new Error('[TopDownGround] setChunkTops before setGrid');
        const chunkWorldY = grid.minY + cy * CHUNK_SIZE * grid.voxelSize;
        this.setTops(key, cx, cy, cz, boxes && boxes.length > 0 ? columnTopsFromBoxes(boxes, grid.voxelSize, chunkWorldY) : null);
    }

    /**
     * Terrain that is not a `VoxelWorld`: a baked level (`VxlSceneTerrainSystem`)
     * or a terrain-registered `VoxelObject`, as world-space top rectangles. Each
     * rect is a walkable surface patch (a voxel's top face, a smooth-surface
     * column); the union rasterises onto the same grid `setGrid` fixed, one
     * synthetic chunk per column stack, and replaces whatever `sourceId` fed
     * before. An empty list retires the source.
     */
    setSourceRects(sourceId: string, rects: readonly GroundRect[]): void {
        const grid = this.grid;
        if (!grid) throw new Error('[TopDownGround] setSourceRects before setGrid');
        const previous = this.sourceKeys.get(sourceId);
        const perStack = new Map<string, StackTops>();
        const vs = grid.voxelSize;
        for (const r of rects) {
            // Half-open cell ranges; a rect that only touches a cell boundary does not cover the cell.
            const gx0 = Math.floor((r.minX - grid.minX) / vs + 1e-6);
            const gx1 = Math.ceil((r.maxX - grid.minX) / vs - 1e-6);
            const gz0 = Math.floor((r.minZ - grid.minZ) / vs + 1e-6);
            const gz1 = Math.ceil((r.maxZ - grid.minZ) / vs - 1e-6);
            const top = r.topY;
            forEachStack(perStack, gx0, gx1 - 1, gz0, gz1 - 1, (tops, lx0, lx1, lz0, lz1) => {
                for (let lx = lx0; lx <= lx1; lx++) {
                    for (let lz = lz0; lz <= lz1; lz++) {
                        const i = columnIndex(lx, lz);
                        if (top > tops[i]!) tops[i] = top;
                    }
                }
            });
        }
        this.installSource(sourceId, perStack, previous);
    }

    /**
     * A source's walkable surface as a TRIANGLE soup in world space — a baked
     * level's trimesh surfaces (`namedTrimeshes`), which is where a forged
     * level keeps most of its ground.
     *
     * Each cell takes the highest surface over its centre: the triangle's own
     * plane sampled there, which is what a downward ray in 3D would have hit.
     * Near-vertical triangles are walls, not floor, and are skipped — the height
     * difference they stand between becomes a cliff wall on its own.
     */
    setSourceTriangles(sourceId: string, verts: Float32Array, indices: ArrayLike<number>): void {
        const grid = this.grid;
        if (!grid) throw new Error('[TopDownGround] setSourceTriangles before setGrid');
        const previous = this.sourceKeys.get(sourceId);
        const perStack = new Map<string, StackTops>();
        const vs = grid.voxelSize;
        for (let t = 0; t + 2 < indices.length; t += 3) {
            const i0 = indices[t]! * 3, i1 = indices[t + 1]! * 3, i2 = indices[t + 2]! * 3;
            const ax = verts[i0]!, ay = verts[i0 + 1]!, az = verts[i0 + 2]!;
            const bx = verts[i1]!, by = verts[i1 + 1]!, bz = verts[i1 + 2]!;
            const cx3 = verts[i2]!, cy3 = verts[i2 + 1]!, cz3 = verts[i2 + 2]!;
            // Plane from the edge cross product. `ny` is the vertical component:
            // a near-zero one is a wall seen edge-on, which no column stands on.
            const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
            const e2x = cx3 - ax, e2y = cy3 - ay, e2z = cz3 - az;
            const nx = e1y * e2z - e1z * e2y;
            const ny = e1z * e2x - e1x * e2z;
            const nz = e1x * e2y - e1y * e2x;
            if (Math.abs(ny) < 1e-6) continue;
            const minX = Math.min(ax, bx, cx3), maxX = Math.max(ax, bx, cx3);
            const minZ = Math.min(az, bz, cz3), maxZ = Math.max(az, bz, cz3);
            const gx0 = Math.floor((minX - grid.minX) / vs);
            const gx1 = Math.floor((maxX - grid.minX) / vs);
            const gz0 = Math.floor((minZ - grid.minZ) / vs);
            const gz1 = Math.floor((maxZ - grid.minZ) / vs);
            // The three edge functions and the plane are LINEAR in (px, pz), so
            // each is evaluated once per row and stepped by a constant along it
            // — the inner loop is then three compares and an add, which is what
            // keeps a 60k-triangle level inside a fraction of a second.
            const e1dx = az - bz, e1dz = bx - ax;
            const e2dx = bz - cz3, e2dz = cx3 - bx;
            const e3dx = cz3 - az, e3dz = ax - cx3;
            const ydx = -nx / ny, ydz = -nz / ny;
            forEachStack(perStack, gx0, gx1, gz0, gz1, (tops, lx0, lx1, lz0, lz1, gxBase, gzBase) => {
                for (let lx = lx0; lx <= lx1; lx++) {
                    const px = grid.minX + (gxBase + lx + 0.5) * vs;
                    let pz = grid.minZ + (gzBase + lz0 + 0.5) * vs;
                    let d1 = (px - bx) * e1dx + (pz - bz) * e1dz;
                    let d2 = (px - cx3) * e2dx + (pz - cz3) * e2dz;
                    let d3 = (px - ax) * e3dx + (pz - az) * e3dz;
                    let y = ay + (px - ax) * ydx + (pz - az) * ydz;
                    for (let lz = lz0; lz <= lz1; lz++) {
                        if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) {
                            const i = columnIndex(lx, lz);
                            if (y > tops[i]!) tops[i] = y;
                        }
                        d1 += e1dz * vs; d2 += e2dz * vs; d3 += e3dz * vs; y += ydz * vs;
                    }
                }
            });
        }
        this.installSource(sourceId, perStack, previous);
    }

    /** Install one source's per-stack tops, retire what it no longer covers, and rebuild the affected walls ONCE. */
    private installSource(sourceId: string, perStack: Map<string, StackTops>, previous: Set<ChunkKey> | undefined): void {
        const keys = new Set<ChunkKey>();
        const touched = new Map<string, StackCoord>();
        for (const [sk, entry] of perStack) {
            const key = `${sourceId}@${sk}`;
            keys.add(key);
            this.applyTops(key, entry.cx, 0, entry.cz, entry.tops, touched);
        }
        if (previous) {
            for (const key of previous) {
                if (keys.has(key)) continue;
                const [cx, cy, cz] = this.chunkCoords(key);
                this.applyTops(key, cx, cy, cz, null, touched);
            }
        }
        this.rebuildWallsAround(touched);
        if (keys.size > 0) this.sourceKeys.set(sourceId, keys);
        else this.sourceKeys.delete(sourceId);
    }

    removeSource(sourceId: string): void {
        this.setSourceRects(sourceId, []);
    }

    private readonly sourceKeys = new Map<string, Set<ChunkKey>>();

    private chunkCoords(key: ChunkKey): [number, number, number] {
        const c = this.chunkTops.get(key);
        return c ? [c.cx, c.cy, c.cz] : [0, 0, 0];
    }

    /** Install (or retire) one chunk's tops and rebuild the walls it can affect — the per-chunk streaming path. */
    private setTops(key: ChunkKey, cx: number, cy: number, cz: number, tops: Float32Array | null): void {
        const touched = new Map<string, StackCoord>();
        this.applyTops(key, cx, cy, cz, tops, touched);
        this.rebuildWallsAround(touched);
    }

    /**
     * Rebuild the walls a set of changed stacks can affect, each stack exactly
     * once. A stack owns its +X/+Z walls, so the stacks BEHIND it (−X, −Z) own
     * the walls that face it; nothing else can change. Collecting before
     * rebuilding is what keeps a whole-level feed cheap — rebuilding per changed
     * chunk was tens of thousands of redundant passes (seconds of load time).
     */
    private rebuildWallsAround(touched: Map<string, StackCoord>): void {
        const rebuild = new Map<string, StackCoord>();
        for (const { cx, cz } of touched.values()) {
            for (const [sx, sz] of [[cx, cz], [cx - 1, cz], [cx, cz - 1]] as const) rebuild.set(stackKey(sx, sz), { cx: sx, cz: sz });
        }
        for (const { cx, cz } of rebuild.values()) this.rebuildWalls(cx, cz);
    }

    /** Install (or retire, with null) one chunk's column tops. Records the stack in `touched`; builds no walls. */
    private applyTops(key: ChunkKey, cx: number, cy: number, cz: number, tops: Float32Array | null, touched: Map<string, StackCoord>): void {
        const previous = this.chunkTops.get(key);
        if (previous) {
            this.chunkTops.delete(key);
            const stack = this.stacks.get(stackKey(previous.cx, previous.cz));
            if (stack) { stack.keys.delete(key); stack.merged = null; }
        } else if (!tops) {
            return; // nothing to retire, nothing to add
        }
        if (tops) {
            this.chunkTops.set(key, { cx, cy, cz, tops });
            const sk = stackKey(cx, cz);
            let stack = this.stacks.get(sk);
            if (!stack) { stack = { cx, cz, keys: new Set(), merged: null, walls: [] }; this.stacks.set(sk, stack); }
            stack.keys.add(key);
            stack.merged = null;
        }
        touched.set(stackKey(cx, cz), { cx, cz });
        if (previous) touched.set(stackKey(previous.cx, previous.cz), { cx: previous.cx, cz: previous.cz });
    }

    /** Walkable top of the terrain column under (x, z), or null off the terrain. */
    heightAt(x: number, z: number): number | null {
        const grid = this.grid;
        if (!grid) return null;
        const gx = Math.floor((x - grid.minX) / grid.voxelSize);
        const gz = Math.floor((z - grid.minZ) / grid.voxelSize);
        const cx = Math.floor(gx / CHUNK_SIZE);
        const cz = Math.floor(gz / CHUNK_SIZE);
        const stack = this.stacks.get(stackKey(cx, cz));
        if (!stack) return null;
        const top = this.mergedOf(stack)[columnIndex(gx - cx * CHUNK_SIZE, gz - cz * CHUNK_SIZE)]!;
        return Number.isFinite(top) ? top : null;
    }

    /** The higher floor a cliff wall separates, or undefined for a collider that is not one of its walls. */
    wallTopOf(colliderHandle: number): number | undefined {
        return this.wallTops.get(colliderHandle);
    }

    /**
     * Does this collider block something at height `y`? Every collider does,
     * except a cliff wall whose top is no higher than `y + allowance`: for a
     * character (`y` = its feet, allowance = a step) that wall is a ledge it
     * stands on or steps onto, not an obstacle; for a ray (allowance 0) it is
     * geometry the ray passes over. The one-way rule of the ground plane.
     */
    ledgeBlocks(colliderHandle: number, y: number, allowance: number = TOP_DOWN_STEP_MAX_M): boolean {
        if (this.disabledWalls.has(colliderHandle)) return false;
        const top = this.wallTops.get(colliderHandle);
        return top === undefined || top > y + allowance + 1e-3;
    }

    /** `ChunkPhysicsManager` culling by 2D column key `"cx,cz"` — walls only; the heightmap always answers. */
    setStackEnabled(key: string, enabled: boolean): void {
        if (enabled === !this.disabledStacks.has(key)) return;
        if (enabled) this.disabledStacks.delete(key);
        else this.disabledStacks.add(key);
        const stack = this.stacks.get(key);
        if (!stack) return;
        // Keep the fixed broad-phase proxies stable: Rapier 2D can trap when
        // touching cliff walls are removed/reinserted by culling. Zero groups
        // suppress solver/ray contacts; ledgeBlocks also filters KCC queries
        // whose caller did not supply collision groups.
        for (const wall of stack.walls) {
            wall.setCollisionGroups(enabled ? makeCollisionGroups(CollisionGroup.TERRAIN, CollisionMask.TERRAIN) : 0);
            if (enabled) this.disabledWalls.delete(wall.handle);
            else this.disabledWalls.add(wall.handle);
        }
    }

    wallCount(): number {
        return this.wallTops.size;
    }

    /** Drop every chunk, source and wall; the grid stays. */
    clear(): void {
        for (const stack of this.stacks.values()) this.retireWalls(stack);
        this.stacks.clear();
        this.chunkTops.clear();
        this.sourceKeys.clear();
        this.wallTops.clear();
        this.disabledWalls.clear();
    }

    dispose(): void {
        this.clear();
        this.disabledStacks.clear();
        if (this.body && !this.world2D.isDisposed()) this.world2D.removeRigidBodyImmediate(this.body);
        this.body = null;
        this.grid = null;
    }

    private mergedOf(stack: Stack): Float32Array {
        if (stack.merged) return stack.merged;
        const merged = new Float32Array(CHUNK_SIZE * CHUNK_SIZE).fill(NO_GROUND);
        for (const key of stack.keys) {
            const chunk = this.chunkTops.get(key);
            if (!chunk) continue;
            for (let i = 0; i < merged.length; i++) if (chunk.tops[i]! > merged[i]!) merged[i] = chunk.tops[i]!;
        }
        stack.merged = merged;
        return merged;
    }

    private rebuildWalls(cx: number, cz: number): void {
        const sk = stackKey(cx, cz);
        const stack = this.stacks.get(sk);
        if (!stack) return;
        this.retireWalls(stack);
        if (stack.keys.size === 0) { this.stacks.delete(sk); return; }
        const grid = this.grid!;
        const merged = this.mergedOf(stack);
        const right = this.stacks.get(stackKey(cx + 1, cz));
        const front = this.stacks.get(stackKey(cx, cz + 1));
        let rightEdge: Float32Array | null = null;
        if (right) { const m = this.mergedOf(right); rightEdge = new Float32Array(CHUNK_SIZE); for (let lz = 0; lz < CHUNK_SIZE; lz++) rightEdge[lz] = m[columnIndex(0, lz)]!; }
        let frontEdge: Float32Array | null = null;
        if (front) { const m = this.mergedOf(front); frontEdge = new Float32Array(CHUNK_SIZE); for (let lx = 0; lx < CHUNK_SIZE; lx++) frontEdge[lx] = m[columnIndex(lx, 0)]!; }
        const span = CHUNK_SIZE * grid.voxelSize;
        const walls = cliffWallsForStack(merged, rightEdge, frontEdge, grid.minX + cx * span, grid.minZ + cz * span, grid.voxelSize);
        if (walls.length === 0 || this.world2D.isDisposed()) return;
        const R = getRapier2D();
        const body = this.ensureBody();
        const groups = makeCollisionGroups(CollisionGroup.TERRAIN, CollisionMask.TERRAIN);
        const enabled = !this.disabledStacks.has(sk);
        for (const w of walls) {
            // 2D y IS world Z on this lane; the body sits at the origin.
            const desc = R.ColliderDesc.cuboid(w.hx, w.hz).setTranslation(w.x, w.z).setCollisionGroups(groups)
                .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS);
            const collider = this.world2D.createCollider(desc, body);
            if (!enabled) { collider.setCollisionGroups(0); this.disabledWalls.add(collider.handle); }
            stack.walls.push(collider);
            this.wallTops.set(collider.handle, w.top);
        }
    }

    private retireWalls(stack: Stack): void {
        if (stack.walls.length === 0) return;
        const disposed = this.world2D.isDisposed();
        for (const wall of stack.walls) {
            this.wallTops.delete(wall.handle);
            this.disabledWalls.delete(wall.handle);
            if (!disposed) this.world2D.removeColliderImmediate(wall);
        }
        stack.walls = [];
    }

    private ensureBody(): RAPIER2D.RigidBody {
        if (this.body && this.body.isValid()) return this.body;
        const R = getRapier2D();
        this.body = this.world2D.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, 0));
        return this.body;
    }
}
