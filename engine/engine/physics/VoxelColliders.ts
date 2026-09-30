import RAPIER from '@dimforge/rapier3d-compat';

/**
 * VoxelColliders — Rapier `Voxels` colliders for voxel geometry.
 *
 * Rapier's `Voxels` shape stores a cell grid instead of a triangle mesh: no
 * internal-edge ghost contacts, no winding sensitivity, no degenerate edge
 * normals, and O(1) per-cell edits via `Collider.setVoxel`.
 *
 * Every STATIC voxel object — v1 chunked, octree, pristine union — builds a
 * voxels collider unconditionally; there is no trimesh path for objects. (A
 * dynamic body is cuboids either way: Rapier derives its mass from collider
 * volume, which neither a trimesh nor a voxels shape carries.)
 *
 * TERRAIN — VoxelWorld chunk colliders and the VxlScene chunk crust — builds
 * one collider per chunk (per friction group, in VoxelWorld). Rapier decides a
 * cell's exposed faces from its own collider only, so two colliders meeting at
 * a seam each expose a wall of vertical faces there and a sliding cuboid stops
 * dead. The chunk helpers at the bottom couple every pair of neighbours with
 * `Collider.combineVoxelStates`, and clear the marks again before a rebuilt or
 * unloaded chunk's colliders are removed (combine never clears; a stale mark
 * lets bodies through the seam). One caveat is left standing: VoxelWorld's
 * frustum culling DISABLES far chunk colliders without removing them, so a
 * body already inside a disabled chunk's volume can cross into its coupled
 * neighbour where a trimesh boundary face would have stopped it. That body was
 * already inside terrain; nothing here makes that state common.
 *
 * The mode switch below is the escape hatch for that terrain: voxels by
 * default, `?voxelColliders=trimesh` to compare, until the feel-test on real
 * levels closes it. Named smooth trimeshes, VoxelWorld's smooth-surface boxes
 * and merged debris stay trimesh in both modes; they are separate paths.
 *
 * Grid semantics (verified empirically against rapier 0.20 / core 0.35):
 *   - cell with grid coordinate g spans [g, g+1] * voxelSize along each axis,
 *     in the collider's local space (collider translation shifts the whole grid);
 *   - `voxelSize` may be non-uniform, which is how parent-scale (sx, sy, sz)
 *     composes: pass voxelSize * scale and scale the translation;
 *   - scene queries (raycasts) see a voxels collider only after the next
 *     `world.step()` — identical to trimesh in rapier 0.20, so no behavior gap.
 *
 * Only BOUNDARY cells are handed to Rapier. A cell whose six face-neighbours
 * are all occupied can never take part in a contact, and dropping it changes
 * no exposed face or edge: the neighbours that decide a surface cell's edge
 * classification are surface cells themselves, and all stay. What it changes
 * is cost. The greedy meshers upstream collapse a solid volume into a few
 * boxes, and expanding those back into every cell they cover would undo that
 * work for cells nothing can touch — a solid 16³ chunk is 4096 cells filled
 * and 1352 as a shell. The shell is a full cell thick, so it is also a stouter
 * surface than the zero-thickness trimesh it replaced.
 */

export type VoxelColliderMode = 'trimesh' | 'voxels';

/** Terrain default. `?voxelColliders=trimesh` is the escape hatch while the feel-test runs. */
export const DEFAULT_VOXEL_COLLIDER_MODE: VoxelColliderMode = 'voxels';

let installedMode: VoxelColliderMode | null = null;
let urlMode: VoxelColliderMode | null | undefined;

/**
 * One-shot programmatic override of the TERRAIN collider mode (world config
 * wiring, tests, demo harnesses). The `?voxelColliders=` URL parameter still
 * wins so a running game can always be A/B-flipped from the address bar
 * without touching its config. Voxel objects are unaffected: they always
 * build voxels colliders.
 */
export function installVoxelColliderMode(mode: VoxelColliderMode | null): void {
    installedMode = mode;
}

/** `?voxelColliders=voxels|trimesh` (also accepts 1|0), parsed once per session. */
function urlOverride(): VoxelColliderMode | null {
    if (urlMode !== undefined) return urlMode;
    urlMode = null;
    if (typeof window !== 'undefined' && typeof window.location?.search === 'string') {
        const v = new URLSearchParams(window.location.search).get('voxelColliders');
        if (v === 'voxels' || v === '1') urlMode = 'voxels';
        else if (v === 'trimesh' || v === '0') urlMode = 'trimesh';
    }
    return urlMode;
}

/** The terrain collider mode in effect: URL override, then installed, then the default. */
export function getVoxelColliderMode(): VoxelColliderMode {
    return urlOverride() ?? installedMode ?? DEFAULT_VOXEL_COLLIDER_MODE;
}

/** Whether TERRAIN chunks build voxels colliders this session (the default). */
export function voxelCollidersEnabled(): boolean {
    return getVoxelColliderMode() === 'voxels';
}

/**
 * The integer box runs every greedy mesher in the engine produces: min corner
 * (x, y, z) and extent (w, h, d), both in whole voxel units.
 */
export interface IntBoxRun {
    x: number; y: number; z: number;
    w: number; h: number; d: number;
}

/**
 * The boundary cells of a dense occupancy grid laid out as
 * `index = (y * nz + z) * nx + x`, as flat (x, y, z) triples offset by
 * (offX, offY, offZ). A cell is boundary when at least one of its six
 * face-neighbours is empty or lies outside the grid. Two passes so the
 * Int32Array is allocated at its final size.
 */
function boundaryCells(
    grid: Uint8Array, nx: number, ny: number, nz: number,
    offX: number, offY: number, offZ: number,
): Int32Array {
    const idx = (x: number, y: number, z: number): number => (y * nz + z) * nx + x;
    const exposed = (x: number, y: number, z: number): boolean =>
        x === 0 || y === 0 || z === 0 || x === nx - 1 || y === ny - 1 || z === nz - 1
        || !grid[idx(x - 1, y, z)] || !grid[idx(x + 1, y, z)]
        || !grid[idx(x, y - 1, z)] || !grid[idx(x, y + 1, z)]
        || !grid[idx(x, y, z - 1)] || !grid[idx(x, y, z + 1)];
    let count = 0;
    for (let y = 0; y < ny; y++) {
        for (let z = 0; z < nz; z++) {
            for (let x = 0; x < nx; x++) {
                if (grid[idx(x, y, z)] && exposed(x, y, z)) count++;
            }
        }
    }
    const cells = new Int32Array(count * 3);
    let o = 0;
    for (let y = 0; y < ny; y++) {
        for (let z = 0; z < nz; z++) {
            for (let x = 0; x < nx; x++) {
                if (grid[idx(x, y, z)] && exposed(x, y, z)) {
                    cells[o++] = offX + x; cells[o++] = offY + y; cells[o++] = offZ + z;
                }
            }
        }
    }
    return cells;
}

/**
 * The boundary cells of greedy-meshed box runs, offset by (offX, offY, offZ)
 * voxel units — the input `ColliderDesc.voxels` wants. The runs are rasterized
 * onto a grid over their joint bounds first, so a cell is judged against its
 * true neighbours even when those belong to another box.
 */
export function cellsFromIntBoxes(
    boxes: readonly IntBoxRun[],
    offX: number = 0, offY: number = 0, offZ: number = 0,
): Int32Array {
    if (boxes.length === 0) return new Int32Array(0);
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const b of boxes) {
        minX = Math.min(minX, b.x); maxX = Math.max(maxX, b.x + b.w);
        minY = Math.min(minY, b.y); maxY = Math.max(maxY, b.y + b.h);
        minZ = Math.min(minZ, b.z); maxZ = Math.max(maxZ, b.z + b.d);
    }
    const nx = maxX - minX, ny = maxY - minY, nz = maxZ - minZ;
    if (nx <= 0 || ny <= 0 || nz <= 0) return new Int32Array(0);
    const grid = new Uint8Array(nx * ny * nz);
    for (const b of boxes) {
        for (let dy = 0; dy < b.h; dy++) {
            for (let dz = 0; dz < b.d; dz++) {
                const row = ((b.y - minY + dy) * nz + (b.z - minZ + dz)) * nx + (b.x - minX);
                grid.fill(1, row, row + b.w);
            }
        }
    }
    return boundaryCells(grid, nx, ny, nz, offX + minX, offY + minY, offZ + minZ);
}

/**
 * The boundary cells of a dense occupancy grid laid out as
 * `index = (y * nz + z) * nx + x` — the layout `rasterizeLeafGrid` in
 * VoxelOctreeRenderer produces.
 */
export function cellsFromDenseGrid(
    grid: Uint8Array, nx: number, ny: number, nz: number,
): Int32Array {
    return boundaryCells(grid, nx, ny, nz, 0, 0, 0);
}

/**
 * A voxels collider descriptor with the standard voxel-surface material.
 * `voxelSize` per axis; `(tx, ty, tz)` places grid cell (0,0,0)'s min corner.
 */
export function voxelsDesc(
    cells: Int32Array,
    sizeX: number, sizeY: number, sizeZ: number,
    tx: number, ty: number, tz: number,
): RAPIER.ColliderDesc {
    return RAPIER.ColliderDesc.voxels(cells, { x: sizeX, y: sizeY, z: sizeZ })
        .setTranslation(tx, ty, tz);
}

// ---------------------------------------------------------------------------
// Neighbour coupling
// ---------------------------------------------------------------------------
//
// A voxels collider decides which of a cell's faces and edges are exposed by
// looking at its OWN cells only. Two colliders that meet at a seam therefore
// each believe their seam faces are exposed, and a body sliding across the
// seam meets a wall of "free" vertical faces: a flat-bottomed cuboid stops
// dead (measured: 6 m/s → 0 in one step), a capsule barely notices.
// `Collider.combineVoxelStates` marks the shared faces internal on both sides,
// which is what makes a chunked terrain behave as one shape.
//
// Two facts about the Rapier API decide the shape of the helpers below:
//   - `shift` is `b.origin − a.origin`, in cells: for a neighbour whose grid
//     starts 16 cells along +x, `a.combineVoxelStates(b, 16, 0, 0)`.
//   - combine only ever ADDS internal marks. Removing or rebuilding a coupled
//     collider leaves its neighbours believing the old cells are still there,
//     and a stale internal face lets bodies straight through the seam (measured:
//     a wall that stops a cuboid at 8.2 m fresh lets it reach 4.5 m stale, and
//     re-combining a replacement does not repair it). The only thing that clears
//     a mark is `setVoxel(false)` + `propagateVoxelChange` on the doomed cells —
//     cheap (0.2 ms for a full 16×16 face), and done here BEFORE the removal.
//
// Decoupling therefore runs in PHASES, never cell-by-cell interleaved: plan with
// no rapier call at all, then clear every doomed cell exactly once, then
// propagate. A chunk faces several colliders per neighbour (one per friction
// group) and a corner cell sits on up to three faces, so clearing per pair
// re-ran `setVoxel(false)` on cells already emptied and re-entered
// `propagateVoxelChange` on the same borrowed collider — rapier answered with
// `RuntimeError: unreachable` and "recursive use of an object detected which
// would lead to unsafe aliasing in rust", after which the world is unusable.
// The phase split is what keeps each wasm mutation of a doomed collider unique.

/** Offset from collider `a`'s cell (0,0,0) to collider `b`'s, in whole cells. */
export interface CellShift { x: number; y: number; z: number }

/**
 * Couple two voxels colliders whose grids share a boundary or overlap, so a
 * body crossing between them meets no phantom seam faces. Idempotent; call it
 * once per pair after both exist, and again after either is rebuilt.
 */
export function coupleVoxelColliders(a: RAPIER.Collider, b: RAPIER.Collider, shift: CellShift): void {
    a.combineVoxelStates(b, shift.x, shift.y, shift.z);
}

/**
 * The cells of `cells` that lie on the face `cells[axis] === faceCoord`, as flat
 * (x, y, z) triples. Pure — no rapier call — so decoupling can plan before it
 * mutates anything.
 */
function faceCells(cells: Int32Array, axis: 0 | 1 | 2, faceCoord: number): Int32Array {
    let count = 0;
    for (let i = 0; i < cells.length; i += 3) if (cells[i + axis] === faceCoord) count++;
    const out = new Int32Array(count * 3);
    let o = 0;
    for (let i = 0; i < cells.length; i += 3) {
        if (cells[i + axis] !== faceCoord) continue;
        out[o++] = cells[i]!; out[o++] = cells[i + 1]!; out[o++] = cells[i + 2]!;
    }
    return out;
}

/**
 * Undo the marks a collider about to be removed left on one neighbour: every
 * cell of `doomed` on the face toward `neighbour` — `cells[axis] === faceCoord`
 * — is emptied and the change propagated, so the neighbour's seam faces read as
 * exposed again. `cells` is the set `doomed` was built from; `shift` is
 * `neighbour.origin − doomed.origin`. Returns how many cells were propagated.
 *
 * Emptying and propagating are two separate passes, never interleaved per cell:
 * `propagateVoxelChange` borrows `doomed` to read the cell it re-evaluates, and
 * a `setVoxel` on the same collider between two propagations is what rapier
 * reports as unsafe aliasing.
 */
export function decoupleVoxelFace(
    doomed: RAPIER.Collider,
    cells: Int32Array,
    neighbour: RAPIER.Collider,
    shift: CellShift,
    axis: 0 | 1 | 2,
    faceCoord: number,
): number {
    const face = faceCells(cells, axis, faceCoord);
    for (let i = 0; i < face.length; i += 3) doomed.setVoxel(face[i]!, face[i + 1]!, face[i + 2]!, false);
    for (let i = 0; i < face.length; i += 3) {
        doomed.propagateVoxelChange(neighbour, face[i]!, face[i + 1]!, face[i + 2]!, shift.x, shift.y, shift.z);
    }
    return face.length / 3;
}

// ---------------------------------------------------------------------------
// Chunk neighbourhoods
// ---------------------------------------------------------------------------

/** A chunk's voxels collider with the cell set it was built from — what decoupling needs. */
export interface ChunkVoxelCollider { collider: RAPIER.Collider; cells: Int32Array }

/** The six face neighbours of a chunk, as (dx, dy, dz) chunk steps. */
export const CHUNK_FACE_NEIGHBOURS: ReadonlyArray<readonly [number, number, number]> = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

/** The positive half of CHUNK_FACE_NEIGHBOURS: enough when every chunk is visited once. */
export const CHUNK_POSITIVE_NEIGHBOURS: ReadonlyArray<readonly [number, number, number]> = [
    [1, 0, 0], [0, 1, 0], [0, 0, 1],
];

/**
 * Couple a chunk's voxels colliders with each other (friction groups share the
 * grid, so shift 0) and with every neighbour's along `dirs`. Chunk cells are
 * chunk-local, so a neighbour one chunk along +x starts `cellsPerChunk` cells
 * away. Combine updates both colliders of a pair, so when every chunk is
 * visited once (a load-time bake) `CHUNK_POSITIVE_NEIGHBOURS` covers every
 * pair exactly once; a chunk built or rebuilt on its own needs all six.
 */
export function coupleChunkVoxelColliders(
    own: readonly RAPIER.Collider[],
    cellsPerChunk: number,
    neighbourAt: (dx: number, dy: number, dz: number) => readonly RAPIER.Collider[] | undefined,
    dirs: ReadonlyArray<readonly [number, number, number]> = CHUNK_FACE_NEIGHBOURS,
): void {
    for (let i = 0; i < own.length; i++) {
        for (let j = i + 1; j < own.length; j++) coupleVoxelColliders(own[i]!, own[j]!, { x: 0, y: 0, z: 0 });
    }
    for (const [dx, dy, dz] of dirs) {
        const theirs = neighbourAt(dx, dy, dz);
        if (!theirs || theirs.length === 0) continue;
        const shift = { x: dx * cellsPerChunk, y: dy * cellsPerChunk, z: dz * cellsPerChunk };
        for (const a of own) for (const b of theirs) coupleVoxelColliders(a, b, shift);
    }
}

/** Edge of the cubic storage blocks a 3D voxels shape keeps its cells in (parry's `VoxelsChunk`). */
const RAPIER_VOXEL_BLOCK = 8;

/**
 * Rapier's voxels shape stores cells in 8³ blocks, and `setVoxel(..., false)` that clears a
 * block's last cell frees the block in bookkeeping that can panic: wasm `unreachable`, which
 * poisons the world and halts physics for good. It depends on block layout and clear order
 * (e.g. clearing a row that crosses x = 8 at z ≥ 8), and happens in rapier3d-compat 0.20 and
 * 0.21 alike. Decoupling empties such a block whenever all of its cells lie on seam faces, as
 * in a one-layer slice at a chunk's top: rebuilding that chunk mid-game crashed the game.
 *
 * The doomed collider is about to be removed, so before clearing, give every block that would
 * empty one extra cell. It lies off every chunk face, so no neighbour's seam can see it, and
 * the clears then never free a block.
 */
function keepStorageBlocksOccupied(
    doomed: RAPIER.Collider,
    cells: Int32Array,
    toClear: Iterable<readonly [number, number, number]>,
    cellsPerChunk: number,
): void {
    const block = (v: number): number => Math.floor(v / RAPIER_VOXEL_BLOCK);
    const blockKey = (x: number, y: number, z: number): string => `${block(x)},${block(y)},${block(z)}`;
    const remaining = new Map<string, number>();
    for (let i = 0; i < cells.length; i += 3) {
        const key = blockKey(cells[i]!, cells[i + 1]!, cells[i + 2]!);
        remaining.set(key, (remaining.get(key) ?? 0) + 1);
    }
    for (const [x, y, z] of toClear) {
        const key = blockKey(x, y, z);
        remaining.set(key, (remaining.get(key) ?? 0) - 1);
    }
    // One cell in from the block's low corner: inside the block, and off the chunk faces (0 and cellsPerChunk - 1).
    const inner = (b: number): number => Math.min(Math.max(b * RAPIER_VOXEL_BLOCK + 1, 1), cellsPerChunk - 2);
    for (const [key, left] of remaining) {
        if (left > 0) continue;
        const [bx, by, bz] = key.split(',').map(Number) as [number, number, number];
        doomed.setVoxel(inner(bx), inner(by), inner(bz), true);
    }
}

/**
 * Before a chunk's voxels colliders are removed — a rebuild after an edit, or
 * an unload — clear the seam marks they left on every face neighbour. The
 * chunk's own colliders need nothing between them: they go together.
 *
 * Planned first, then executed in two passes per doomed collider, because a
 * chunk's faces overlap and its neighbours are plural: an edge cell lies on two
 * faces and a corner cell on three, and each direction answers with one
 * collider per friction group. Clearing and propagating inside the pair loop
 * therefore emptied the same cell several times and re-entered
 * `propagateVoxelChange` on a collider rapier had already borrowed — "recursive
 * use of an object detected which would lead to unsafe aliasing in rust", then
 * `unreachable`, then a Voxel game that cannot load. A big edit is what makes it
 * likely: `VoxelWorld.updateChunkPhysics` walks adjacent dirty chunks in the
 * same pass, so the same seam is revisited from both sides. Here each doomed
 * cell is emptied exactly once, and each (cell, neighbour) propagation issued
 * exactly once, after all the emptying is done.
 */
export function decoupleChunkVoxelColliders(
    own: readonly ChunkVoxelCollider[],
    cellsPerChunk: number,
    neighbourAt: (dx: number, dy: number, dz: number) => readonly RAPIER.Collider[] | undefined,
): void {
    for (const { collider: doomed, cells } of own) {
        // Plan: no rapier call in this loop.
        const toClear = new Map<string, readonly [number, number, number]>();
        const toPropagate: { neighbour: RAPIER.Collider; shift: CellShift; face: Int32Array }[] = [];
        const plannedPairs = new Set<string>();
        for (const [dx, dy, dz] of CHUNK_FACE_NEIGHBOURS) {
            const theirs = neighbourAt(dx, dy, dz);
            if (!theirs || theirs.length === 0) continue;
            const axis: 0 | 1 | 2 = dx !== 0 ? 0 : dy !== 0 ? 1 : 2;
            const faceCoord = dx + dy + dz > 0 ? cellsPerChunk - 1 : 0;
            const face = faceCells(cells, axis, faceCoord);
            if (face.length === 0) continue;
            const shift = { x: dx * cellsPerChunk, y: dy * cellsPerChunk, z: dz * cellsPerChunk };
            for (const neighbour of theirs) {
                // One propagation set per (doomed, neighbour, direction): a neighbour listed
                // twice for one direction is a duplicate, and duplicating the wasm mutation
                // is the aliasing bug. A collider reached along two directions has two
                // distinct seams and still needs both.
                const pair = `${neighbour.handle}|${dx},${dy},${dz}`;
                if (neighbour === doomed || plannedPairs.has(pair)) continue;
                plannedPairs.add(pair);
                toPropagate.push({ neighbour, shift, face });
            }
            for (let i = 0; i < face.length; i += 3) {
                const x = face[i]!, y = face[i + 1]!, z = face[i + 2]!;
                toClear.set(`${x},${y},${z}`, [x, y, z]);
            }
        }
        if (toPropagate.length === 0) continue;
        keepStorageBlocksOccupied(doomed, cells, toClear.values(), cellsPerChunk);
        for (const [x, y, z] of toClear.values()) doomed.setVoxel(x, y, z, false);
        for (const { neighbour, shift, face } of toPropagate) {
            for (let i = 0; i < face.length; i += 3) {
                doomed.propagateVoxelChange(neighbour, face[i]!, face[i + 1]!, face[i + 2]!, shift.x, shift.y, shift.z);
            }
        }
    }
}
