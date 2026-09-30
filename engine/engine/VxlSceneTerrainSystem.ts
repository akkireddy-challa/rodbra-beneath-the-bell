/**
 * VxlSceneTerrainSystem — runtime for the VxlScene (`.vwld` / VLSC magic)
 * baked-GLB voxel-world format.
 *
 * This is the new-format sibling of `VxlChunkedTerrainSystem`. Where that
 * system loads a VWLD file whose chunk geometry is a standalone VXL3 v4
 * octree, this one consumes a `DecodedVxlSceneWorld` decoded from the VxlScene
 * container: per-chunk greedy-mesh LOD hints (rendered by `VxlSceneRenderer`)
 * plus compacted variable-size voxels and an optional per-chunk trimesh
 * (rendered as physics only).
 *
 * Engine integration deliberately MIRRORS `VxlChunkedTerrainSystem`:
 *   - Same constructor shape `(engine, config)` so `WorldGenerator` can
 *     construct it identically.
 *   - `VxlSceneRenderer.group` is added under a root group attached to the
 *     scene, exactly as the old system adds its `rootGroup`.
 *   - Colliders are static (a single `RAPIER.RigidBodyDesc.fixed()` body):
 *     ONE trimesh per chunk from its finest LOD quads (the rendered surface),
 *     plus the chunk's baked smooth trimesh if it has one. Both use
 *     `makeCollisionGroups(ENVIRONMENT, ENVIRONMENT)`.
 *   - `updateVisibility(camera, _playerPosition?)` matches the old method
 *     name `WorldGenerator`/`Game.ts` call per frame; it forwards the camera
 *     world position to `renderer.updateLod`.
 *   - `getHeightAt` and friends mirror the old read-only terrain-query surface
 *     so spawn / NPC / camera code works regardless of which terrain system
 *     is wired up.
 *
 * Like the old system, the baked GEOMETRY is static — no block editing, no
 * digging. The one mutable thing is the ground mask's SURFACE MATERIAL
 * (`setGroundTypeInRadius` / `setGroundTypeInRect`), which repaints what grows on
 * the ground without touching a single voxel or collider. That is what lets a game
 * cut grass, scorch earth or muddy a field on a baked level.
 */

import * as THREE from 'three';
import { VoxelNavMesh, setGlobalNavMesh, getGlobalNavMesh, NPC_NAV_CELL_M, NPC_NAV_STEP_M } from 'engine/VoxelNavMesh.js';
import { groundMaskCellIndex, GROUND_MASK_HEIGHT_STEP } from 'engine/vxlscene/GroundMaskBaker.js';
import RAPIER from '@dimforge/rapier3d-compat';
import type { EngineLike } from 'types/game.js';
import { isVxlScene, decodeVxlScene, type DecodedVxlSceneWorld, type DecodedChunk, type DecodedChunkQuads, type DecodedChunkVoxels } from 'engine/vxlscene/VxlSceneFormat.js';
import { VxlSceneRenderer } from 'engine/vxlscene/VxlSceneRenderer.js';
import { GroundDetailSystem, groundDetailOptionsFor } from 'engine/vxlscene/GroundDetailSystem.js';
import { groundTypeAtPoint, paintGroundTypeInMask, type GroundMaskData } from 'engine/vxlscene/GroundMaskBaker.js';
import { GROUND_TYPE } from 'engine/vxlscene/GroundTypes.js';
import { quadsToTrimeshSoA, quadsToShellCells, orientTrimeshUpward } from 'engine/vxlscene/ColliderBaker.js';
import { voxelCollidersEnabled, voxelsDesc, coupleChunkVoxelColliders, CHUNK_POSITIVE_NEIGHBOURS } from 'engine/physics/VoxelColliders.js';
import { CollisionGroup, CollisionMask, makeCollisionGroups } from 'engine/CollisionLayers.js';
import type { PhysicsWorld, RaycastResult } from 'engine/physics/PhysicsWorld.js';
import { isPlaneLockedPhysics, type PlaneLockedPhysics } from 'engine/physics/PlaneLockedPhysics.js';
import { GROUND_PLANE_MIN_CELL_M } from 'engine/physics/TopDownGround.js';
import { vxlSceneFloorRects, vxlSceneFloorTriangles } from 'engine/vxlscene/GroundPlaneFeed.js';
import { buildTrackCenterline, type TrackCenterlineOptions, type CenterlinePoint } from 'engine/TrackCenterline.js';
import { syncGroundWorldSizeToBakedLevel } from 'engine/syncGroundWorldSizeToBakedLevel.js';
import { isMobileRuntime } from 'engine/isMobileRuntime.js';
import { isStandaloneMode } from 'engine/CreatorMode.js';
import { profileMark } from 'engine/LoadProfile.js';
import { levelDetailPlan, resolveLevelDetail } from 'engine/LevelDetail.js';
import { activeMaterialQuality, activeQualityPolicy } from 'engine/DeviceQuality.js';
import {
    VehicleNavGrid, CELL_VALIDATED, setGlobalVehicleNav, type VehicleNavGridDims,
} from 'engine/nav/VehicleNavGrid.js';
import {
    seedFromMask, repaintMaskRect, VehicleNavGridBakePass, type CastDown, type CheckObstruction,
    type CheckWallObstruction,
    BAKE_OBSTRUCTION_MIN_ABOVE_M, BAKE_PROP_MAX_ABOVE_M,
    BAKE_WALL_MIN_ABOVE_M, BAKE_WALL_MAX_ABOVE_M,
} from 'engine/nav/VehicleNavGridBake.js';

// ─── Oversized-world load guard (render-cost budget) ────────────────────────
//
// Very large baked worlds can overwhelm the renderer's CPU/GPU mesh buffers. We
// estimate the render-buffer bytes from the DECODED counts (greedy quads + smooth
// surface cells) and pick the cheapest plan that fits a budget: drop the finest
// terrain LOD-hint levels first, then decimate the smooth surface. This replaces the
// old file-byte heuristic, which keyed off the wrong proxy and could not reduce the
// (former) per-voxel-cube cost at all.

/** Render-buffer limits for one platform tier. */
export interface VxlSceneLoadBudget {
    /**
     * Minimum effective quad cell size in meters; quads whose effective size
     * (`minVoxelSize · 2^(lodOffset+level)`) is finer than this are shed
     * (offset-aware — objects baked coarse are untouched; each chunk's coarsest
     * level is always kept). null = never shed: the world renders at its baked
     * resolution no matter how large.
     */
    minQuadCellSizeM: number | null;
    /**
     * Hard cap on the level's TOTAL render-buffer bytes — greedy quads plus the smooth
     * surface, which is the number the device actually has to hold.
     *
     * It has to be the total, not a per-mesh cap. With independent ceilings the level
     * with the largest surface got quads up to the quad ceiling ON TOP of it: measured
     * on a phone, four circuits at 194–238 MB loaded and the one at 316 MB — 252 MB of
     * quads plus a 64 MB surface, each individually "within budget" — did not. Nothing
     * was watching the sum.
     *
     * The surface is decimated first (`surfaceBudgetBytes`), then the quads are
     * coarsened until the pair fits here, so the cheap-to-shed mesh gives way before
     * the one that carries the level's look. null = uncapped (desktop).
     */
    totalBudgetBytes: number | null;
    /** Budget for the smooth movement-surface mesh; drives `surfaceStep` decimation. */
    surfaceBudgetBytes: number;
    /**
     * Drop the render geometry of every TERRAIN BAND at or beyond this lodOffset
     * outright — not coarsened, gone. null = keep every band (the normal path).
     *
     * A forged level's terrain is split into concentric bands by distance from the
     * track (`world-forger-internal/terrain-bands.ts`), each baked at its own
     * lodOffset, and the GLB node names follow the same order: `Terrain` = band 0 =
     * offset 1, `Terrain_2` = band 1 = offset 2, `Terrain_3`/`_4`/`_5` = bands 2+,
     * all clamped to the forger's `MAX_LOD_OFFSET` of 3. So a value of 2 means
     * "keep the track and the fine halo around it, discard `Terrain_2` and beyond",
     * which is how the setting is authored and read.
     *
     * Unlike the cell-size shed this is not a quality knob — it removes the distant
     * backdrop entirely, leaving open sky past the kept band. Colliders are NOT
     * dropped (the named trimeshes are untouched), so the ground out there stays
     * solid and every height query still answers; it is invisible, not absent.
     * Because a quad carries its band only as that offset, a PROP authored with an
     * explicit `lodOffset` at or above the cap goes with the band.
     */
    dropTerrainBandsAtOrAboveOffset: number | null;
}

/**
 * Desktop: quad detail is UNCAPPED — desktops absorb even multi-hundred-MB quad
 * buffers, and silently coarsening the baked voxel size would visibly degrade
 * worlds the creator built around it (0.125 m → 0.25 m is a different game).
 * Only the smooth surface keeps its historical 600 MB decimation guard.
 */
export const VXL_SCENE_LOAD_BUDGET_FULL: VxlSceneLoadBudget = {
    minQuadCellSizeM: null,
    totalBudgetBytes: null,
    surfaceBudgetBytes: 600 * 1024 * 1024,
    dropTerrainBandsAtOrAboveOffset: null,
};

/**
 * Mobile: a 0.25 m cell floor and a hard ceiling on the level's TOTAL render buffers.
 *
 * 240 MB is MEASURED on an iPhone, not chosen — the one number here that came from a
 * device rather than an estimate, so move it only with new device evidence:
 *
 *   loaded:  100  106  116  130  159  194  213  228  238 MB
 *   crashed: 316  323  373 MB
 *
 * The threshold sits between 238 and 316, and 240 is under it with the fine cells the
 * budget can still afford. (Both buffers are held TWICE on a phone — CPU copy until the
 * post-warmup release, plus the GPU copy in the same unified memory — so 240 MB of
 * buffers is ~480 MB of peak footprint, which is what the device is really rejecting.)
 *
 * ⚠ Two lessons are baked into that table. First, `quadBudgetBytes` + `surfaceBudgetBytes`
 * as INDEPENDENT ceilings does not bound anything: the circuit at 316 MB was 252 MB of
 * quads under a 280 MB quad ceiling plus a 64 MB surface under a 64 MB surface ceiling —
 * both "within budget", and it crashed. Hence one total. Second, the level that failed
 * first was assumed to be failing because of its weather (it is the only one with rain
 * and reflections); it was failing because it is the HEAVIEST — its surface alone is
 * 2.5–4× every other circuit's. A level being unusual and a level being biggest are easy
 * to confuse when only one level fails.
 *
 * The surface is decimated first and the quads then coarsen into what is left, so the
 * mesh that carries the level's look gives way last. On these circuits that lands the
 * four smaller ones at 0.5 m cells and the 640 m desert at 1 m.
 *
 * What a shed costs is scenery blockiness — on a forged level every quad is flagged
 * noCollider and the drivable surface is the baked named trimesh, so shedding them is
 * purely visual there; on a level whose quads DO collide, `finestKeptQuads` still bakes
 * the collider from each offset group's finest surviving level, so the surface coarsens
 * with the visuals rather than disappearing.
 *
 * `?terrainBudget=<MB>` overrides this per load, so the threshold can be re-measured on
 * a device without a republish — that is how the table above was produced.
 *
 * ⚠ The band cap interacts with the ceiling if it is ever turned on: dropping the outer
 * bands frees budget, and the search hands it straight back as finer cells — measured, a
 * 512 m circuit went 211 MB at 0.5 m to 278 MB at 0.25 m, i.e. the drop made it BIGGER.
 * Default is off; `?terrainBands=N` turns it on per-load for diagnosis.
 */
export const VXL_SCENE_LOAD_BUDGET_CONSTRAINED: VxlSceneLoadBudget = {
    minQuadCellSizeM: 0.25,
    totalBudgetBytes: 240 * 1024 * 1024,
    surfaceBudgetBytes: 64 * 1024 * 1024,
    dropTerrainBandsAtOrAboveOffset: null,
};

/**
 * Estimated GPU-buffer bytes per welded surface cell (~1 vert x 28 B + 6 indices x 4 B).
 * Per vertex: position float32x3 12 B + normal float32x3 12 B + uv unorm16x2 4 B. Keep in
 * sync with `SurfaceMeshBuilder.buildChunkSurfaceGeometry`'s attribute layout.
 * This is a LOWER bound: welding shares ~1 vert/cell only across large same-color patches;
 * isolated or color-fragmented cells emit up to 4 verts, so the real cost is 1–4× this.
 */
const SURFACE_CELL_RENDER_BYTES = 28 + 6 * 4;   // 52

/**
 * Render-buffer bytes per greedy quad: `buildHintMeshSoA` emits exactly 4 verts
 * (position float32x3 12 B + normal snorm8x4 4 B + uv unorm16x2 4 B = 20 B each) +
 * 6 uint32 indices per quad. Keep in sync with that builder's attribute layout —
 * every mobile byte ceiling is denominated in this number.
 */
const QUAD_RENDER_BYTES = 4 * 20 + 6 * 4;   // 104

/**
 * Cap on `skipEffectiveSteps`. Beyond ~4 doublings of the finest kept cell size the
 * world reads as featureless blobs; a world still over budget at the cap needs a
 * coarser BAKE (raise minVoxelSize), not more load-time shedding.
 */
const MAX_SKIP_EFFECTIVE_STEPS = 4;

/** Collision groups every baked collider uses — the world is pure static environment. */
const ENVIRONMENT_COLLISION_GROUPS = makeCollisionGroups(CollisionGroup.ENVIRONMENT, CollisionMask.ENVIRONMENT);

// Height-probe constants + scratch objects for `getBakedSurfaceHeightAt`, which
// runs hundreds of thousands of times while the weather system bakes its rain
// height field — it must not allocate per call.
const HEIGHT_RAY_START_Y = 500;
const HEIGHT_RAY_RANGE = 600;
/** How far below a skipped prop the next cast starts (m). */
const PROP_RAY_STEP_DOWN = 0.1;
/** Max stacked props to see through before giving up (canopy + trunk + fence…). */
const MAX_PROP_RAY_SKIPS = 8;
const _heightRayOrigin = new THREE.Vector3();
const _heightRayDown = new THREE.Vector3(0, -1, 0);
const _heightRayResult: RaycastResult = {
    hasHit: false,
    hitPoint: new THREE.Vector3(),
    hitNormal: new THREE.Vector3(),
    hitDistance: 0,
    hitCollider: null,
    hitRigidBody: null,
};

/** A render-load plan: how many finest LOD levels to drop, the finest effective
 *  cell steps to shed, and the surface decimation step. */
export interface VxlSceneLoadPlan {
    skipLodLevels: number;
    /**
     * Shed every greedy quad whose EFFECTIVE cell size is finer than
     * `minVoxelSize · 2^skipEffectiveSteps` (see `applyEffectiveStepSkip`). Unlike
     * `skipLodLevels` this is per-quad and offset-aware: an object baked at a
     * coarse lodOffset already renders at a large effective size, so its quads
     * survive — only genuinely fine geometry is dropped. 0 = keep everything.
     */
    skipEffectiveSteps: number;
    surfaceStep: number;
}

/** Count displaced cells (flags bit1) in a chunk's voxel columns. */
function countDisplaced(chunk: DecodedChunk): number {
    const v = chunk.voxels;
    if (!v.disp) return 0;
    let c = 0;
    for (let i = 0; i < v.count; i++) if ((v.flags[i]! & 2) !== 0) c++;
    return c;
}

/**
 * Cells the smooth movement surface will mesh for this chunk.
 *
 * BOTH storage forms count. v5 moved the smooth ride surface out of the displaced
 * voxel columns into a per-chunk SURFACE TILE (one height+colour per column), so a
 * modern bake has ZERO displaced voxels — counting only those made
 * `estimateSurfaceBytes` return 0 for every v5+ world and the surface budget could
 * never fire, however large the surface was (a 640 m racing level's 1.74M columns =
 * 104 MB of buffers, silently unbudgeted). `SurfaceMeshBuilder` welds both forms into
 * the same mesh, so the estimate must see both.
 */
function countSurfaceCells(chunk: DecodedChunk): number {
    return countDisplaced(chunk) + (chunk.surfaceTile?.count ?? 0);
}

/** Estimated surface render bytes at decimation `step` (each step quarters the cell count). */
function estimateSurfaceBytes(world: DecodedVxlSceneWorld, step: number): number {
    let cells = 0;
    for (const chunk of world.chunks) cells += countSurfaceCells(chunk);
    const kept = cells / (step * step);
    return kept * SURFACE_CELL_RENDER_BYTES;
}

/** The lodOffset packed into a quad's axisDir byte (bits 3–5). */
function quadOffset(axisDir: number): number {
    return (axisDir >> 3) & 0x7;
}

/**
 * Whether `applyEffectiveStepSkip(world, skipSteps)` would shed the quad at
 * (level `level`, packed offset byte `axisDir`) of a chunk with `levelCount` LOD
 * levels. A quad's effective coarseness step is `offset + level` (the renderer's
 * depth-bias step b); quads below `skipSteps` are shed EXCEPT on the chunk's
 * coarsest level, which is always kept whole so every object keeps at least one
 * renderable + collidable representation.
 */
function effectiveStepSheds(axisDir: number, level: number, levelCount: number, skipSteps: number): boolean {
    return level < levelCount - 1 && quadOffset(axisDir) + level < skipSteps;
}

/** Estimated greedy-quad render-buffer bytes kept after an effective-step skip of `skipSteps`. */
export function estimateQuadRenderBytes(world: DecodedVxlSceneWorld, skipSteps: number): number {
    let kept = 0;
    for (const chunk of world.chunks) {
        const levelCount = chunk.lodHints.length;
        for (let l = 0; l < levelCount; l++) {
            const q = chunk.lodHints[l]!;
            if (skipSteps <= 0 || l >= levelCount - 1) {
                kept += q.count;
                continue;
            }
            for (let i = 0; i < q.count; i++) {
                if (!effectiveStepSheds(q.axisDir[i]!, l, levelCount, skipSteps)) kept++;
            }
        }
    }
    return kept * QUAD_RENDER_BYTES;
}

/**
 * `kept[s]` = quads surviving `applyEffectiveStepSkip(world, s)`, for every candidate
 * `s` in `[0, MAX_SKIP_EFFECTIVE_STEPS]`, from ONE pass over the quad columns.
 *
 * A quad survives skip `s` exactly when it sits on its chunk's coarsest level (never
 * shed) or its effective step is >= `s`, so bucketing the shedable quads by effective
 * step and suffix-summing gives every candidate at once — the budget search below would
 * otherwise re-scan a 4M-quad level once per candidate.
 */
function keptQuadsBySkipStep(world: DecodedVxlSceneWorld): number[] {
    const bucket = new Array<number>(MAX_SKIP_EFFECTIVE_STEPS + 1).fill(0);
    let alwaysKept = 0;
    for (const chunk of world.chunks) {
        const levelCount = chunk.lodHints.length;
        for (let l = 0; l < levelCount; l++) {
            const q = chunk.lodHints[l]!;
            if (l >= levelCount - 1) { alwaysKept += q.count; continue; }
            for (let i = 0; i < q.count; i++) {
                // Steps past the cap can never be shed by any candidate, so they clamp
                // into the top bucket rather than needing their own.
                bucket[Math.min(quadOffset(q.axisDir[i]!) + l, MAX_SKIP_EFFECTIVE_STEPS)]!++;
            }
        }
    }
    const kept = new Array<number>(MAX_SKIP_EFFECTIVE_STEPS + 1).fill(alwaysKept);
    let suffix = 0;
    for (let s = MAX_SKIP_EFFECTIVE_STEPS; s >= 0; s--) {
        suffix += bucket[s]!;
        kept[s]! += suffix;
    }
    return kept;
}

/**
 * Choose `{ skipLodLevels, skipEffectiveSteps, surfaceStep }` for `budget`.
 *
 * Order matters and is the point: `surfaceStep` decimates the smooth surface to its own
 * budget FIRST, then `skipEffectiveSteps` — starting at the `minQuadCellSizeM` floor —
 * coarsens the quads until the PAIR fits `totalBudgetBytes`. Sizing the two
 * independently is what let a level pass both ceilings and still be too big for the
 * device (see the mobile budget's measurements). Pure + deterministic (unit-tested).
 */
export function planVxlSceneLoad(
    world: DecodedVxlSceneWorld,
    budget: VxlSceneLoadBudget,
    /**
     * Extra effective-size steps the chosen detail TIER asks for, beyond whatever the
     * budget decides. Non-zero only for tiers past the coarsest baked variant (see
     * `LevelDetail`), where there is no smaller file left to load.
     */
    extraSkipSteps = 0,
): VxlSceneLoadPlan {
    // NEVER skip whole terrain LOD-hint levels. Skipping LOD0 forces every chunk to render
    // a COARSER LOD, where smooth:y roads are baked as grid-aligned greedy quads (LOD0 is
    // the only level that excludes them) — i.e. skipping turns the smooth road into hard
    // voxel cubes — AND it needlessly coarsens objects whose lodOffset already made their
    // finest level coarse. The offset-aware `skipEffectiveSteps` below is the level-shedding
    // mechanism instead: it drops only quads whose EFFECTIVE size (minVoxel · 2^(offset+level))
    // is genuinely fine, and the renderer substitutes each shed (level, offset) sub-instance
    // with the object's finest KEPT one, so nothing disappears near the camera.
    const skipLodLevels = 0;

    // Steps to lift the finest effective cell size from world.minVoxelSize up to the
    // platform floor: ceil(log2(floor / minVoxel)), clamped to [0, cap]. The epsilon
    // absorbs float fuzz so an exact match (bake already at the floor) yields 0.
    let skipEffectiveSteps = 0;
    if (budget.minQuadCellSizeM !== null && world.minVoxelSize > 0) {
        // Measure the floor against what this container ALREADY IS, not its nominal grid.
        // `minVoxelSize` describes the lattice and is identical in every variant, so a
        // pre-coarsened file looked exactly as fine as the full one and got shed a second
        // time — asking for tier 1 rendered like tier 2, and tier 1 was unreachable.
        // `surfaceStep` is the pre-coarsening the bake applied (1, 2, 4 for full, +1, +2),
        // written by the same variant step that dropped the quad levels, so it is the
        // container's own record of how far it was already taken.
        // `?? 1` because a world built in code (tests, callers predating v8) carries no
        // surfaceStep, and `Math.max(1, undefined)` is NaN — which would silently disable
        // the floor rather than fail loudly.
        const effectiveMin = world.minVoxelSize * Math.max(1, world.surfaceStep ?? 1);
        const steps = Math.ceil(Math.log2(budget.minQuadCellSizeM / effectiveMin) - 1e-9);
        skipEffectiveSteps = Math.max(0, Math.min(MAX_SKIP_EFFECTIVE_STEPS, steps));
    }
    // The tier's own request rides on top of the budget's, capped the same way.
    skipEffectiveSteps = Math.min(MAX_SKIP_EFFECTIVE_STEPS, skipEffectiveSteps + Math.max(0, extraSkipSteps));

    // The smooth movement surface is decimated to its own budget first (this does not drop
    // terrain LODs and does not expose road cubes), because whatever it ends up costing is
    // a fixed charge against the total below.
    let surfaceStep = 1;
    while (surfaceStep < 8 && estimateSurfaceBytes(world, surfaceStep) > budget.surfaceBudgetBytes) {
        surfaceStep++;
    }

    // Then coarsen the quads past the floor until quads + surface fit the TOTAL. The floor
    // is a fixed number of doublings, so on a big enough level it sheds a token slice and
    // leaves hundreds of MB standing; this is the part that actually bounds memory. Capped
    // at MAX_SKIP_EFFECTIVE_STEPS — a world still over budget there needs a coarser BAKE.
    if (budget.totalBudgetBytes !== null) {
        const kept = keptQuadsBySkipStep(world);
        const surfaceBytes = estimateSurfaceBytes(world, surfaceStep);
        while (
            skipEffectiveSteps < MAX_SKIP_EFFECTIVE_STEPS
            && kept[skipEffectiveSteps]! * QUAD_RENDER_BYTES + surfaceBytes > budget.totalBudgetBytes
        ) {
            skipEffectiveSteps++;
        }
    }
    return { skipLodLevels, skipEffectiveSteps, surfaceStep };
}

/**
 * Per-load override of the budget's terrain-band cap, from `?terrainBands=`.
 *
 * A published game is a frozen bundle, so without this every band experiment costs a
 * full republish. The param takes the same value as the budget field — the first
 * lodOffset to DROP — plus `all` to keep every band:
 *
 *   ?terrainBands=all  keep everything          ?terrainBands=3  drop Terrain_3 and beyond
 *   ?terrainBands=2    drop Terrain_2 and beyond   ?terrainBands=1  drop every terrain band
 *
 * Returns `undefined` when the param is absent or unparseable, leaving the platform
 * budget in charge. Applies on BOTH platforms so a phone result can be reproduced on a
 * desktop browser.
 */
/**
 * Per-load override of the budget's TOTAL byte ceiling, from `?terrainBudget=<MB>`.
 *
 * The ceiling is the one number here that has to come from a real device, and a
 * published game is a frozen bundle — so without this, every point on the
 * loads/crashes curve costs a republish. `?terrainBudget=400` on a phone answers "is
 * 400 MB over the line" in one reload.
 *
 * Returns `undefined` when the param is absent or unparseable, leaving the platform
 * budget in charge; `0` is read as "no ceiling" so the uncapped case is reachable too.
 */
export function readTerrainBudgetOverride(): number | null | undefined {
    try {
        const raw = new URLSearchParams(window.location.search).get('terrainBudget');
        if (raw === null) return undefined;
        const mb = Number.parseFloat(raw);
        if (!Number.isFinite(mb) || mb < 0) return undefined;
        return mb === 0 ? null : mb * 1024 * 1024;
    } catch {
        // No window/location (tests, workers) — the platform budget stands.
        return undefined;
    }
}

/**
 * Per-load override of the SURFACE byte ceiling, from `?surfaceBudget=<MB>`.
 *
 * Separate from `?terrainBudget=` because the two are separate budgets and the surface is
 * spent FIRST: decimating quads leaves the smooth surface untouched, so a load can shed
 * over a hundred megabytes of quads and keep every byte of surface. Without its own knob
 * the surface is the one large consumer that cannot be isolated on a real device — which
 * is exactly the position this investigation reached.
 */
export function readSurfaceBudgetOverride(): number | undefined {
    try {
        const raw = new URLSearchParams(window.location.search).get('surfaceBudget');
        if (raw === null) return undefined;
        const mb = Number.parseFloat(raw);
        if (!Number.isFinite(mb) || mb < 0) return undefined;
        return mb * 1024 * 1024;
    } catch {
        return undefined;
    }
}

export function readTerrainBandOverride(): number | null | undefined {
    try {
        const raw = new URLSearchParams(window.location.search).get('terrainBands');
        if (raw === null) return undefined;
        if (raw === 'all') return null;
        const n = Number.parseInt(raw, 10);
        return Number.isFinite(n) && n >= 1 ? n : undefined;
    } catch {
        // No window/location (tests, workers) — fall through to the platform budget.
        return undefined;
    }
}

/**
 * Delete every quad whose lodOffset is at or above `minOffset`, from EVERY LOD level
 * including each chunk's coarsest.
 *
 * This is deliberately harsher than `applyEffectiveStepSkip`, which always leaves an
 * object one surviving representation: a dropped terrain band must leave nothing, or
 * the memory it holds is exactly the memory we were trying not to spend. Named
 * trimeshes are untouched, so the dropped band keeps its collider — the ground stays
 * solid and height queries still answer, it just is not drawn. Mutates `world` in
 * place; the removed columns are freed for GC. Returns the quad count dropped.
 */
export function applyLodOffsetDrop(world: DecodedVxlSceneWorld, minOffset: number): number {
    if (minOffset <= 0) return 0;
    let dropped = 0;
    for (const chunk of world.chunks) {
        for (let l = 0; l < chunk.lodHints.length; l++) {
            const q = chunk.lodHints[l]!;
            const keep: number[] = [];
            for (let i = 0; i < q.count; i++) {
                if (quadOffset(q.axisDir[i]!) < minOffset) keep.push(i);
            }
            if (keep.length !== q.count) {
                dropped += q.count - keep.length;
                chunk.lodHints[l] = gatherQuads([{ src: q, indices: keep }]);
            }
        }
    }
    return dropped;
}

/**
 * Drop the finest `skip` LOD-hint levels from every chunk (and the parallel `lodDistances`
 * thresholds), keeping >=1 LOD per chunk. Slicing frees the dropped columns for GC; the
 * renderer iterates `chunk.lodHints` / `world.lodDistances`, so no renderer change is needed.
 * Voxel columns (the smooth surface) are never touched. Mutates `world` in place.
 */
export function applyLodSkip(world: DecodedVxlSceneWorld, skip: number): void {
    if (skip <= 0) return;
    let maxEff = 0;
    for (const chunk of world.chunks) {
        const eff = Math.min(skip, Math.max(0, chunk.lodHints.length - 1));
        if (eff > 0) chunk.lodHints = chunk.lodHints.slice(eff);
        if (eff > maxEff) maxEff = eff;
    }
    if (maxEff > 0 && world.lodDistances.length > 1) {
        world.lodDistances = world.lodDistances.slice(Math.min(maxEff, world.lodDistances.length - 1));
    }
}

/** One source column set plus the indices of the quads to take from it. */
interface QuadPick { src: DecodedChunkQuads; indices: number[] }

/** Copy the picked quads, in order, into one fresh compacted column set. */
function gatherQuads(picks: readonly QuadPick[]): DecodedChunkQuads {
    let count = 0;
    for (const pick of picks) count += pick.indices.length;
    const gx = new Uint16Array(count), gy = new Uint16Array(count), gz = new Uint16Array(count);
    const w = new Uint16Array(count), h = new Uint16Array(count);
    const axisDir = new Uint8Array(count), colorIdx = new Uint16Array(count), disp = new Int8Array(count);
    let j = 0;
    for (const { src, indices } of picks) {
        for (const i of indices) {
            gx[j] = src.gx[i]!; gy[j] = src.gy[i]!; gz[j] = src.gz[i]!;
            w[j] = src.w[i]!; h[j] = src.h[i]!;
            axisDir[j] = src.axisDir[i]!; colorIdx[j] = src.colorIdx[i]!; disp[j] = src.disp[i]!;
            j++;
        }
    }
    return { count, gx, gy, gz, w, h, axisDir, colorIdx, disp };
}

/**
 * Shed every greedy quad whose EFFECTIVE cell size step (`lodOffset + level`) is below
 * `skipSteps` — i.e. finer than `minVoxelSize · 2^skipSteps` — from every LOD level
 * EXCEPT each chunk's coarsest, which is kept whole so every offset group retains at
 * least one representation (render + collision). Offset-aware, unlike `applyLodSkip`:
 * an object baked at a coarse lodOffset keeps its finest level because that level is
 * already coarse; only genuinely fine geometry is dropped. Level count and
 * `lodDistances` are unchanged — the RENDERER backfills a shed (level, offset)
 * sub-instance with the offset group's finest kept one (see `VxlSceneRenderer.build`),
 * so near-camera chunks show the substituted coarser geometry instead of a hole.
 * Mutates `world` in place; the shed columns are freed for GC.
 */
export function applyEffectiveStepSkip(world: DecodedVxlSceneWorld, skipSteps: number): void {
    if (skipSteps <= 0) return;
    for (const chunk of world.chunks) {
        const levelCount = chunk.lodHints.length;
        for (let l = 0; l < levelCount - 1; l++) {
            const q = chunk.lodHints[l]!;
            const keep: number[] = [];
            for (let i = 0; i < q.count; i++) {
                if (!effectiveStepSheds(q.axisDir[i]!, l, levelCount, skipSteps)) keep.push(i);
            }
            if (keep.length !== q.count) chunk.lodHints[l] = gatherQuads([{ src: q, indices: keep }]);
        }
    }
}


/**
 * Free an ArrayBuffer's memory NOW, whoever still holds a reference to it.
 *
 * Dropping a reference is not enough here: the same buffer is bound by this frame's
 * parameter AND by every caller up the chain, all of which stay live across the load's
 * awaits, so nothing is collectable until the whole load returns — which is exactly when
 * it stops mattering. Transferring ownership to a value we immediately discard detaches
 * the original, so every one of those references becomes a zero-length view and the
 * memory goes back at once.
 *
 * `structuredClone` with `transfer` rather than `ArrayBuffer.prototype.transfer()`:
 * Safari shipped the former in 15.4 and the latter in 17.4, and old iPhones are the
 * entire reason this exists. Failure is swallowed — on an engine with neither, the
 * buffer simply lives as long as it used to.
 */
function detachBuffer(buffer: ArrayBuffer): void {
    if (buffer.byteLength === 0) return; // already detached, or empty
    try {
        structuredClone(buffer, { transfer: [buffer] });
    } catch (err) {
        console.warn('[VxlSceneTerrainSystem] could not release the source buffer early:', err);
    }
}

/** Shared empty voxel columns installed on every chunk by `releaseDecodedColumns`. */
const EMPTY_DECODED_VOXELS: DecodedChunkVoxels = {
    count: 0,
    gx: new Uint16Array(0), gy: new Uint16Array(0), gz: new Uint16Array(0),
    sizeLevel: new Uint8Array(0), colorIdx: new Uint16Array(0), flags: new Uint8Array(0),
    disp: null,
};

/**
 * The chunk's up-facing (+Y) quads, taken from `finestKeptQuads` — precisely the
 * subset `GroundDetailSystem.collectColumnSurfaces` reads, and nothing else.
 *
 * Ground detail resolves each mask cell's top surface LAZILY, per column-chunk, as
 * the player moves and whenever a mow invalidates one, so it needs quad columns for
 * the whole level for the whole session. Keeping only these keeps that exact — the
 * collector's first act is to skip every quad that is not axis-Y, +dir — while
 * dropping the five other face directions and every coarser LOD level.
 *
 * Returns null when the chunk has no up-facing quads at all (nothing can stand on it).
 * Pure — exported for tests.
 */
export function upFacingQuads(chunk: DecodedChunk): DecodedChunkQuads | null {
    const src = finestKeptQuads(chunk);
    if (!src) return null;
    const indices: number[] = [];
    for (let i = 0; i < src.count; i++) {
        const axisDir = src.axisDir[i]!;
        if ((axisDir & 0x3) === 1 && ((axisDir >> 2) & 1) === 0) indices.push(i);
    }
    if (indices.length === 0) return null;
    return gatherQuads([{ src, indices }]);
}

/**
 * Free the decoded columns once every load-time consumer has had them.
 *
 * `voxels` and `surfaceTile` have no runtime reader at all — both are consumed by
 * the load planner and by `SurfaceMeshBuilder` during the renderer build — so they
 * go unconditionally. `lodHints` has exactly one runtime reader, ground detail, and
 * `keepGroundQuads` reduces each chunk to the up-facing set it actually reads rather
 * than retaining every face of every level for it.
 *
 * Mutates `world` in place. `chunks` itself stays (its cx/cy/cz and length are read
 * for bounds, counts and column keys), as do `groundMask` and `namedTrimeshes`
 * (`getTrimesh` merges lazily, so we cannot know which names will be asked for).
 *
 * Returns the number of quads freed, for the load log.
 */
export function releaseDecodedColumns(world: DecodedVxlSceneWorld, keepGroundQuads: boolean): number {
    let before = 0, after = 0;
    for (const chunk of world.chunks) {
        for (const level of chunk.lodHints) before += level.count;
        const kept = keepGroundQuads ? upFacingQuads(chunk) : null;
        chunk.lodHints = kept ? [kept] : [];
        after += kept?.count ?? 0;
        chunk.voxels = EMPTY_DECODED_VOXELS;
        chunk.surfaceTile = null;
    }
    return before - after;
}

/**
 * The chunk's finest KEPT quads per offset group, merged in ascending-offset order —
 * the collision surface after an effective-step skip. Each offset group contributes
 * its quads from the FIRST (finest) level where it still has any; on an unskipped
 * world every group first appears at level 0, so this reproduces `lodHints[0]`
 * exactly (levels are baked as ascending-offset group concatenations). Null when the
 * chunk has no quads at all.
 */
export function finestKeptQuads(chunk: DecodedChunk): DecodedChunkQuads | null {
    const levelCount = chunk.lodHints.length;
    if (levelCount === 0) return null;
    if (levelCount === 1) return chunk.lodHints[0]!.count > 0 ? chunk.lodHints[0]! : null;

    // First (finest) level per offset that still holds quads for it.
    const firstLevelByOffset = new Map<number, number>();
    for (let l = 0; l < levelCount; l++) {
        const q = chunk.lodHints[l]!;
        for (let i = 0; i < q.count; i++) {
            const o = quadOffset(q.axisDir[i]!);
            if (!firstLevelByOffset.has(o)) firstLevelByOffset.set(o, l);
        }
    }
    if (firstLevelByOffset.size === 0) return null;

    // Fast path: every offset's finest level is 0 → level 0 IS the collision surface.
    if ([...firstLevelByOffset.values()].every((l) => l === 0)) return chunk.lodHints[0]!;

    // Merge each group's finest kept quads, ascending offset (mirrors the bake's
    // ascending-offset group order within a level).
    const offsets = [...firstLevelByOffset.keys()].sort((a, b) => a - b);
    return gatherQuads(offsets.map((o) => {
        const src = chunk.lodHints[firstLevelByOffset.get(o)!]!;
        const indices: number[] = [];
        for (let i = 0; i < src.count; i++) {
            if (quadOffset(src.axisDir[i]!) === o) indices.push(i);
        }
        return { src, indices };
    }));
}

/**
 * Distinct, non-empty trimesh-collider object names baked into a decoded world.
 * Pure (no physics/engine state) so it's unit-testable. Backs `getTrimeshNames`.
 */
export function collectTrimeshNames(world: DecodedVxlSceneWorld): string[] {
    const names = new Set<string>();
    for (const chunk of world.chunks) {
        for (const tm of chunk.namedTrimeshes) {
            if (tm.name !== '') names.add(tm.name);
        }
    }
    return [...names];
}

/**
 * Translate chunk-local verts into world space by adding the chunk origin,
 * returning a fresh Float32Array. Shared by the collider baker and the
 * `getTrimesh` merge so the chunk-local → world conversion lives in one place.
 */
function translateVerts(src: Float32Array, originX: number, originY: number, originZ: number): Float32Array {
    const out = new Float32Array(src.length);
    for (let v = 0; v < src.length; v += 3) {
        out[v] = src[v]! + originX;
        out[v + 1] = src[v + 1]! + originY;
        out[v + 2] = src[v + 2]! + originZ;
    }
    return out;
}

/**
 * Merge every chunk's slice of the named trimesh into one WORLD-space mesh
 * (chunk-local verts + chunk origin; indices rebased per chunk), or null if no
 * object by that name exists. Pure (no physics/engine state). Backs `getTrimesh`.
 */
export function mergeNamedTrimesh(
    world: DecodedVxlSceneWorld,
    name: string,
): { vertices: Float32Array; indices: Uint32Array } | null {
    const chunkSize = world.chunkSize;
    const vertChunks: Float32Array[] = [];
    const idxChunks: Uint32Array[] = [];
    let vertFloatTotal = 0;
    let idxTotal = 0;
    let vertOffset = 0; // running vertex count, to rebase each chunk's indices

    for (const chunk of world.chunks) {
        const originX = chunk.cx * chunkSize;
        const originY = chunk.cy * chunkSize;
        const originZ = chunk.cz * chunkSize;
        for (const tm of chunk.namedTrimeshes) {
            if (tm.name !== name || tm.verts.length === 0 || tm.indices.length === 0) continue;
            const worldVerts = translateVerts(tm.verts, originX, originY, originZ);
            const baseVert = vertOffset;
            const rebased = new Uint32Array(tm.indices.length);
            for (let i = 0; i < tm.indices.length; i++) rebased[i] = tm.indices[i]! + baseVert;
            vertChunks.push(worldVerts);
            idxChunks.push(rebased);
            vertFloatTotal += worldVerts.length;
            idxTotal += rebased.length;
            vertOffset += worldVerts.length / 3;
        }
    }

    if (vertChunks.length === 0) return null;

    const vertices = new Float32Array(vertFloatTotal);
    const indices = new Uint32Array(idxTotal);
    let vp = 0;
    for (const vc of vertChunks) { vertices.set(vc, vp); vp += vc.length; }
    let ip = 0;
    for (const ic of idxChunks) { indices.set(ic, ip); ip += ic.length; }
    return { vertices, indices };
}

/**
 * Config for the VxlScene runtime. Mirrors `VxlChunkedTerrainConfig` so the
 * two systems are interchangeable from a caller's point of view. LOD distance
 * thresholds themselves live on the decoded `DecodedVxlSceneWorld.lodDistances`
 * (the renderer reads them directly), so this config only carries the engine-side
 * knobs the renderer doesn't own.
 */
export interface VxlSceneTerrainConfig {
    /**
     * Per-LOD camera-distance thresholds. Present for shape-parity with
     * `VxlChunkedTerrainConfig`, but note the authoritative schedule used by
     * the renderer is `DecodedVxlSceneWorld.lodDistances` baked into the file. This
     * value is only consulted if the world ships without its own thresholds.
     */
    lodDistances: number[];
    /**
     * Optional hard render cutoff in meters. Present for parity with the old
     * config. The VxlScene renderer does its own distance-based LOD selection
     * and has no explicit cutoff, so this is informational here.
     */
    maxRenderDistance: number | null;
    /** Whether chunk meshes cast/receive shadows. Parity field. */
    shadows: boolean;
    /**
     * Keep the decoded LOD/voxel/surface COLUMNS resident after the load finishes.
     *
     * They exist to build three things — the render batches, the chunk colliders and
     * the vehicle nav grid — and all three are done by the end of `loadVxlScene`. On a
     * big level they are tens of MB of typed arrays that then sit in the heap for the
     * level's lifetime, costing GC marking time as well as bytes (the same argument
     * `GeometryCpuRelease` makes for the batches' own buffer copies).
     *
     * The one thing that still needs them is `VxlSceneRenderer.setChunkHints`, which
     * rebuilds every batch and therefore re-reads EVERY chunk's hints, not just the
     * edited one. Set this when a game drives that API; it throws otherwise rather
     * than silently rebuilding a world with no geometry in it.
     *
     * Ground detail is NOT a reason to set this: the release keeps exactly the quads
     * `GroundDetailSystem` reads (see `upFacingQuads`).
     *
     * Optional with a false default — game code already constructs this config.
     */
    keepDecodedColumns?: boolean;
}

/**
 * Default height window (m) for `getGroundTypeAt`: how far a query point may sit
 * from the masked top surface and still count as standing on it. Wider than the
 * ground-detail system's 0.8 m visual guard because a wheel contact point rides
 * above the surface by its own radius and suspension travel.
 */
export const GROUND_TYPE_MATCH_TOLERANCE_M = 2.0;

export const DEFAULT_VXL_SCENE_TERRAIN_CONFIG: VxlSceneTerrainConfig = {
    // Fallback only — a forged `.vwld` carries its own authoritative lodDistances
    // (baked at 100/200/300 by the forger's derive-settings). Kept in step with that
    // default so a world that somehow ships without thresholds still matches.
    lodDistances: [100, 200, 300],
    maxRenderDistance: null,
    shadows: true,
    keepDecodedColumns: false,
};

export interface VxlSceneLoadOptions {
    /**
     * Build and attach render batches. Disable only for native/server validation
     * that needs the production decode and Rapier registration paths without DOM/WebGL.
     */
    buildRenderer?: boolean;
    /**
     * DETACH `vwldBuffer` once it has been decoded, freeing the inflated container
     * immediately instead of at whatever point the caller happens to drop it.
     *
     * It is worth a lot: the container is 52 MB on a Joyride level and 87 MB on the
     * largest, and both this frame's parameter and the caller's local hold it live for
     * the whole load — across `build()`, where the render batches are allocated. That is
     * the load's high-water mark, and the buffer is dead weight in it: nothing reads the
     * bytes again after `decodeVxlScene` returns.
     *
     * OFF by default because detaching a buffer the caller owns is a surprise, and this
     * is a published engine API. The engine's own load paths set it; a game that wants to
     * keep its bytes simply does not.
     */
    releaseSourceBuffer?: boolean;
}

/** The heightmap source a baked level feeds on the ground plane (see feedGroundPlane). */
const VXLSCENE_GROUND_SOURCE = 'vxlscene';
/** The same level's baked trimesh surfaces — a second source so each replaces itself. */
const VXLSCENE_TRIMESH_GROUND_SOURCE = 'vxlscene-trimesh';

/** Per-chunk physics handles kept so `dispose()` can tear them down. */
interface ChunkColliders {
    /** Trimesh colliders for the chunk's baked named trimeshes (smooth/curved surfaces), one per source object. */
    trimeshColliders: RAPIER.Collider[];
    /**
     * The chunk's PRIMARY collision surface: ONE trimesh collider baked from its
     * finest LOD quads (`chunk.lodHints[0]`). One collider per chunk replaces the
     * old one-cuboid-per-voxel packing (up to 1.57M Rapier shapes, which blew the
     * 200k budget and left most of the map without collision). Null if the chunk
     * has no surface quads.
     */
    quadTrimeshCollider: RAPIER.Collider | null;
}

/**
 * Replaces (or runs alongside) `VoxelTerrainSystem` for baked VxlScene levels.
 *
 * Construction is cheap — no I/O happens until `loadVxlScene()` runs.
 * Callers (genres / world-generators) do:
 *
 *   const terrain = new VxlSceneTerrainSystem(engine, { ...DEFAULT_…, … });
 *   await terrain.loadVxlScene(vwldBuffer);
 *   // every-frame: terrain.updateVisibility(camera);
 */

export class VxlSceneTerrainSystem {
    private engine: EngineLike;
    private config: VxlSceneTerrainConfig;
    /** Top-level container in the scene. Holds the renderer's group. */
    private rootGroup: THREE.Group;
    private renderer: VxlSceneRenderer | null = null;
    /** Kept so a region set before (or across) a load reaches the renderer built for it. */
    private renderRegion: THREE.Box3 | null = null;
    /** Runtime ground detail (cobble domes / grass cover) — only for worlds baked
     *  with a v6 ground mask; render-only, adds NO physics colliders. */
    private groundDetail: GroundDetailSystem | null = null;
    /** Unregister for the engine beforeRender hook that self-drives LOD +
     *  ground detail (see loadVxlScene); null until a world is loaded. */
    private unregisterBeforeRender: (() => void) | null = null;
    private worldData: DecodedVxlSceneWorld | null = null;
    /** Bumped by every loadVxlScene — see getWorldGeneration(). */
    private worldGeneration = 0;
    /** Memoized merged world-space geometry per trimesh name (built lazily by `getTrimesh`). */
    private readonly _trimeshCache = new Map<string, { vertices: Float32Array; indices: Uint32Array } | null>();
    /** One static body carrying every chunk's colliders (mirrors the
     *  old system's per-chunk static bodies, collapsed to one because the
     *  whole VxlScene world is static and never peels off fragments). */
    private rigidBody: RAPIER.RigidBody | null = null;
    private colliders: ChunkColliders[] = [];
    /** True after `loadVxlScene` finishes and every chunk's collider is wired up. */
    private collidersReady: boolean = false;
    /**
     * Number of finest LOD levels dropped at load to keep an oversized world
     * inside the memory budget (0 = loaded at full detail). Exposed via
     * `getReducedLodLevels()` so the Creator can surface an in-UI banner. The
     * runtime itself adds NO DOM / alert / postMessage — only a console.warn.
     */
    private reducedLodLevels = 0;
    /** Scratch vector to avoid allocating per frame. */
    private readonly _scratchCamPos = new THREE.Vector3();

    /** This level's vehicle-pathing grid (see engine/nav/VehicleNavGrid.ts), or
     *  null when the level has no ground mask or the grid failed to build. Also
     *  installed as the process-wide `getGlobalVehicleNav()` singleton. */
    private navGrid: VehicleNavGrid | null = null;
    /** Time-sliced collider raycast pass filling in navGrid; stepped from the
     *  beforeRender hook until isDone, and re-armed by ground-paint edits. */
    private navBakePass: VehicleNavGridBakePass | null = null;
    /**
     * Gates the FIRST `navBakePass.step()` call after a level load. Colliders
     * baked earlier in `loadVxlScene` are not queryable by raycast until the
     * physics world has stepped at least once (`LevelEngineBridge` steps once
     * right after `loadVxlScene` resolves, but this beforeRender hook can also
     * fire on the very first tick before that step is guaranteed to have run) —
     * stepping the bake pass against not-yet-synced colliders would have every
     * cell's first cast see stale/no geometry. Starts false; the hook flips it
     * true and skips stepping on its first invocation after (re)build, so every
     * real `step()` call is guaranteed to run after at least one physics step.
     */
    private navBakeReadyToStep = false;
    /** Set once a bake-pass step() throws, so the failure is logged once and the
     *  pass is permanently disabled rather than spamming every frame. */
    private navBakeFailed = false;

    constructor(engine: EngineLike, config: VxlSceneTerrainConfig) {
        this.engine = engine;
        this.config = config;
        this.rootGroup = new THREE.Group();
        this.rootGroup.name = 'VxlSceneTerrain';
    }

    /**
     * Sniff whether a buffer is a VxlScene file. Thin re-export of the format
     * helper so callers can branch without importing the format module too.
     */
    static isVxlScene(buf: ArrayBuffer): boolean {
        return isVxlScene(buf);
    }

    /**
     * Decode a VxlScene buffer, build its render meshes via `VxlSceneRenderer`,
     * and bake static Rapier colliders for every chunk.
     *
     * After this resolves: the renderer group is in the scene, and every chunk
     * has one surface trimesh collider (from its finest LOD quads) plus an
     * optional smooth trimesh collider on a single static rigid body.
     *
     * Calling `loadVxlScene` twice replaces the previous world atomically.
     */
    async loadVxlScene(vwldBuffer: ArrayBuffer, options: VxlSceneLoadOptions = {}): Promise<void> {
        const buildRenderer = options.buildRenderer ?? true;
        // Drop any previous world so the system is reusable.
        if (this.renderer || this.rigidBody) this.clearWorld();

        const megabytes = vwldBuffer.byteLength / 1024 / 1024;
        // Full decode (voxel columns always kept). The SoA columns are cheap; the render
        // buffers are the cost, which the plan below bounds. `decodeVxlScene` consumes a
        // Uint8Array view; wrap without copying.
        const world = await decodeVxlScene(new Uint8Array(vwldBuffer));
        profileMark('decode', `${world.chunks.length} chunks, ${megabytes.toFixed(1)} MB container`);
        if (options.releaseSourceBuffer === true) detachBuffer(vwldBuffer);
        this.worldData = world;
        // This baked level defines the real playable extent — grow groundWorldSizeX/Z to it
        // so spawn clamping and camera framing use the level size, not the tiny default plane.
        syncGroundWorldSizeToBakedLevel(this.engine, world.bounds);
        // Register as the engine's main terrain: a VxlScene level has no procedural VoxelWorld,
        // so bounds consumers (e.g. the coastal water surface) reach the level extent through
        // DynamicObjectManager.getTerrainBounds().
        this.engine.getDynamicObjectManager?.()?.setBakedTerrain(this);

        // Render-cost guard: shed the quad levels finer than the platform's minimum
        // effective cell size and decimate the smooth surface to its byte budget.
        // Desktop never sheds quad detail (baked resolution is sacred there); mobile
        // floors the effective cell at 0.25 m — enough to drop the dominant finest
        // level of a fine bake without breaking terrain playability.
        // A collider-only load (buildRenderer false) renders nothing, so it neither needs a
        // budget nor may touch the quads — and it runs in environments with no `window` for
        // `isMobileRuntime` to probe, so the platform lookup stays inside this branch.
        let plan: VxlSceneLoadPlan = { skipLodLevels: 0, skipEffectiveSteps: 0, surfaceStep: 1 };
        if (buildRenderer) {
            const platformBudget = activeQualityPolicy().deferred.terrainBudget === 'constrained'
                ? VXL_SCENE_LOAD_BUDGET_CONSTRAINED
                : VXL_SCENE_LOAD_BUDGET_FULL;
            const budgetOverride = readTerrainBudgetOverride();
            const surfaceOverride = readSurfaceBudgetOverride();
            const budget: VxlSceneLoadBudget = {
                ...platformBudget,
                ...(budgetOverride !== undefined ? { totalBudgetBytes: budgetOverride } : {}),
                ...(surfaceOverride !== undefined ? { surfaceBudgetBytes: surfaceOverride } : {}),
            };

            // Distant terrain bands go FIRST, before the plan is chosen: they are removed
            // outright, so the cell-size search should size its shed against what is actually
            // going to be rendered. Coarsening a backdrop that is about to be deleted would
            // spend the budget's headroom on nothing and leave the near terrain blockier than
            // it needs to be.
            const override = readTerrainBandOverride();
            const bandCap = override !== undefined ? override : budget.dropTerrainBandsAtOrAboveOffset;
            if (bandCap !== null) {
                const dropped = applyLodOffsetDrop(world, bandCap);
                if (dropped > 0) {
                    console.warn(
                        `[VxlSceneTerrain] terrain bands at lodOffset >= ${bandCap} dropped ` +
                        `(Terrain_${bandCap} and beyond): ${dropped.toLocaleString()} quads removed from the render. ` +
                        'Colliders are unchanged — the ground out there is invisible, not absent.',
                    );
                }
            }

            // The tier the player/game/device settled on decides how much MORE to shed
            // once the variants run out — see `LevelDetail`.
            plan = planVxlSceneLoad(world, budget, levelDetailPlan(resolveLevelDetail(activeQualityPolicy().deferred.levelDetail)).extraSkipSteps);
            applyLodSkip(world, plan.skipLodLevels);
            applyEffectiveStepSkip(world, plan.skipEffectiveSteps);
        }
        this.reducedLodLevels = Math.max(plan.skipLodLevels, plan.skipEffectiveSteps);

        // ── [SmoothSurface] diagnostic (temporary; remove once validated) ───────────
        // Proves the smooth:y surface data survived decode + the load guard. If you do NOT
        // see this line on load, the iframe is running a stale/cached engine build.
        let totalDisplaced = 0;
        for (const c of world.chunks) totalDisplaced += countDisplaced(c);
        console.log(
            `[SmoothSurface] loadVxlScene: ${megabytes.toFixed(1)}MB, chunks=${world.chunks.length}, ` +
            `displacedVoxels(smooth top cells)=${totalDisplaced}, ` +
            `plan={skipEffectiveSteps:${plan.skipEffectiveSteps}, surfaceStep:${plan.surfaceStep}}, ` +
            `namedTrimeshObjects=[${collectTrimeshNames(world).join(', ')}]`,
        );

        if (plan.skipEffectiveSteps > 0 || plan.surfaceStep > 1) {
            console.warn(
                `[VxlSceneTerrain] world is large (${megabytes.toFixed(0)} MB) — loaded at reduced detail ` +
                `(finest kept cell ${world.minVoxelSize * Math.pow(2, plan.skipEffectiveSteps)}m` +
                `${plan.surfaceStep > 1 ? `, surface decimated x${plan.surfaceStep}` : ''}); ` +
                `re-voxelize at a coarser min voxel size for full detail.`,
            );
        }

        const scene = this.engine.scene;
        // 2D-physics lane: `engine.physicsWorld` is the plane-locked facade, which
        // has no 3D bodies to bake into. The ground plane takes the level as a
        // heightmap instead (feedGroundPlane); side-on has no baked-level collision.
        const enginePhysics = this.engine.physicsWorld;
        const planeLocked = isPlaneLockedPhysics(enginePhysics) ? enginePhysics : null;
        const physicsWorld = planeLocked ? null : enginePhysics;
        if (buildRenderer && !scene) {
            throw new Error('[VxlSceneTerrainSystem] engine.scene is null — call after GameEngine init');
        }

        // Build the renderer (eagerly builds LOD0 meshes for every chunk) and
        // parent its group under our root group — mirrors how the old system
        // adds its per-chunk VoxelObjects to `rootGroup`.
        if (buildRenderer) {
            this.renderer = new VxlSceneRenderer(world, {
                surfaceStep: plan.surfaceStep,
                // The quality tier decides how a v9 world's material classes shade
                // (Physical on 'high', Phong-clamped on 'medium') and whether the
                // per-class batch split happens at all ('low' renders every classified
                // world exactly as an unclassified one). Same resolution family as the
                // level-detail tier above.
                materialQuality: activeMaterialQuality(),
            });
            profileMark('renderer build');
            this.renderer.setRenderRegion(this.renderRegion);
            this.rootGroup.add(this.renderer.group);
            if (this.rootGroup.parent !== scene) {
                scene!.add(this.rootGroup);
            }
        }

        // Runtime ground detail (v6 ground mask): cobble/brick stone caps + grass
        // cover near the camera. Render-only — the collider baking below never
        // sees it. Levels without a mask (all pre-v6 bakes) skip it entirely.
        // Density/size/range come from `worldProfileData.groundCoverConfig` so a game
        // that needs a thick mowable meadow authors it as config, never as thousands
        // of scattered grass props.
        if (buildRenderer && world.groundMask) {
            const coverConfig = this.engine.getGameData?.()?.worldProfileData?.groundCoverConfig;
            this.groundDetail = new GroundDetailSystem(world, this.rootGroup, groundDetailOptionsFor(coverConfig));
        }

        // Self-drive LOD + ground detail every frame from the engine's pre-render
        // hook (post-gameplay, so a mow/terraform invalidation this frame is
        // rebuilt before it is ever rendered). Both are CAMERA-DISTANCE driven —
        // no frustum involved — so they must keep running while templates skip
        // their `updateVisibility` call during F9 recording (games freeze
        // frustum culling then because the recording camera's aspect differs;
        // that guard does not apply here, and skipping the detail rebuild left
        // the mower's own chunk permanently bare in recordings). Template
        // `updateVisibility` calls remain harmless duplicates.
        this.unregisterBeforeRender = this.engine.registerBeforeRender?.(() => {
            if (this.renderer && this.engine.camera) {
                this.engine.camera.getWorldPosition(this._scratchCamPos);
                this.renderer.updateLod(this._scratchCamPos);
                this.groundDetail?.updateDetail(this._scratchCamPos);
            }
            // Independent of the renderer/camera guard above — the nav bake must
            // keep progressing even for collider-only (buildRenderer: false) loads.
            this.stepVehicleNavBake();
        }) ?? null;

        // One static body owns all chunk colliders. Mirror the old system's
        // body construction: a fixed body, userData pointing back at this
        // system, ENVIRONMENT collision groups on the colliders.
        if (physicsWorld) {
            const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, 0);
            this.rigidBody = physicsWorld.createRigidBody(bodyDesc);
            physicsWorld.setUserData(this.rigidBody, { vxlSceneTerrain: this });
        }

        // ONE trimesh collider per chunk (built from the chunk's finest LOD quads),
        // plus the chunk's baked smooth trimesh if any. This is ~2 colliders/chunk
        // (~8k total) instead of one cuboid per voxel (up to 1.57M, which blew the
        // old 200k budget and left ~87% of the map with no collision). No budget is
        // needed — the count scales with chunks, not voxels.
        for (const chunk of world.chunks) {
            const entry: ChunkColliders = { trimeshColliders: [], quadTrimeshCollider: null };
            if (physicsWorld && this.rigidBody) {
                this.bakeChunkColliders(chunk, world, physicsWorld, this.rigidBody, entry);
            }
            this.colliders.push(entry);
        }
        if (physicsWorld) this.coupleChunkSeams(world);
        if (planeLocked) this.feedGroundPlane(world, planeLocked);
        profileMark('collider bake', `${this.colliders.length} chunks`);
        this.collidersReady = true;
        this.buildNpcNavMesh(world);
        // A game with no AI vehicles opts out of the grid and its two bake sweeps
        // (worldProfileData.vehicleNavGrid: false) — see the field's doc.
        if (this.engine.getGameData?.()?.worldProfileData?.vehicleNavGrid === false) {
            console.log('[VehicleNav] vehicle nav grid off for this world (worldProfileData.vehicleNavGrid: false)');
        } else if (planeLocked) {
            console.log('[VehicleNav] vehicle nav grid skipped on the 2D-physics lane (vehicles are 3D-only)');
        } else {
            this.buildVehicleNavGrid(world, physicsWorld);
        }

        // Arm the release of the batches' CPU-side buffer copies — for a big
        // baked world that's
        // the difference between loading and jetsam on iPhone. Published games
        // drop every vertex attribute ('full' — gameplay raycasts go through
        // physics). Editor sessions keep position ('keep-pickable') because
        // PlacementHelper THREE-raycasts the terrain for object placement, and
        // drop the rest (normals/uv, roughly half the copy). Indices survive in
        // both modes (see GeometryCpuRelease). The identity guard ignores the
        // callback if the world was replaced before the warmup fired.
        //
        // onSceneWarmedUp runs IMMEDIATELY once the boot warmup has happened, so
        // on a level switch this lands before the new batches have rendered.
        // releaseCpuGeometry therefore only ARMS a per-batch after-draw release;
        // releasing here directly left the whole level drawing as empty sky.
        //
        // Registered only when a renderer was actually built: with
        // buildRenderer false (collider-only worlds) `this.renderer` stays
        // null, and an identity guard alone would compare null to null, pass,
        // and dereference it.
        const builtRenderer = this.renderer;
        if (builtRenderer) {
            this.engine.onSceneWarmedUp?.(() => {
                if (this.renderer !== builtRenderer) return;
                builtRenderer.releaseCpuGeometry(isStandaloneMode ? 'full' : 'keep-pickable');
            });
        }

        // Every load-time consumer of the decoded columns has now run — the render
        // batches, the chunk colliders and the nav grid are all built from them —
        // so free them unless a game opted into keeping them for `setChunkHints`.
        // Ground detail keeps reading quads for the whole session, so its subset
        // survives whenever it is running.
        if (this.config.keepDecodedColumns !== true) {
            const freed = releaseDecodedColumns(world, this.groundDetail !== null);
            this.renderer?.markDecodedColumnsReleased();
            console.log(
                `[VxlSceneTerrainSystem] released ${freed.toLocaleString()} decoded quads `
                + `(${this.groundDetail ? 'kept the up-facing set for ground detail' : 'kept none'})`,
            );
        }

        // Bumped LAST: consumers comparing generations (weather's surface swap
        // + rain collision bake) must only ever observe a COMPLETE world — a
        // bump at load start would let them bake a half-built level.
        this.worldGeneration++;
    }

    /**
     * Bake one chunk's colliders onto the shared static body.
     *
     * The chunk's collision surface is ONE trimesh built from its finest LOD quads
     * (`chunk.lodHints[0]`) — the exact same greedy surface the renderer draws, so
     * collision matches the visuals. This replaces the old one-cuboid-per-voxel
     * packing (up to 1.57M Rapier shapes vs a 200k cap, which both choked physics
     * and left most of the map without collision). Collider count now scales with
     * chunks (~3.9k), not voxels.
     *
     * The shared body sits at the world origin (0,0,0); `quadsToTrimeshSoA` already
     * emits world-space verts (chunk origin + grid·minVoxelSize), so no pivot math.
     * The chunk's baked named trimesh colliders (smooth/curved surfaces) are added too.
     */
    /**
     * Seam-couple the chunks' voxels crust colliders (see VoxelColliders.ts): a
     * voxels collider exposes its boundary faces unless told what lies beyond
     * them, so without this a cuboid sliding across a chunk seam stops dead.
     * Chunk cells are chunk-local on the min-cell lattice, so a neighbour one
     * chunk along +x starts `chunkSize / minVoxelSize` cells away. Every chunk is
     * visited once and combine updates both sides, so the positive neighbours
     * cover every pair. Chunks are never rebuilt or unloaded individually here
     * (dispose removes everything), so no decoupling is needed.
     */
    /**
     * Ground plane (top-down 2D physics): the level's up-facing collidable quads
     * become the terrain heightmap — the same surface the 3D trimesh would have
     * been, one axis down (engine/vxlscene/GroundPlaneFeed.ts). `clearWorld`
     * withdraws them. Side-on 2D physics has no baked-level collision at all.
     */
    private feedGroundPlane(world: DecodedVxlSceneWorld, physics: PlaneLockedPhysics): void {
        const ground = physics.ground;
        if (!ground) {
            console.warn('[VxlSceneTerrainSystem] side-on 2D physics has no baked-level collision — the level renders without terrain colliders');
            return;
        }
        // The heightmap is a gameplay surface: a baked level's 0.125 m voxels would
        // be millions of columns to place a wall finer than anyone can stand on.
        ground.setGrid(0, 0, 0, Math.max(world.minVoxelSize, GROUND_PLANE_MIN_CELL_M));
        // BOTH halves of the 3D lane's collision surface: the voxel shell's
        // up-faces AND the baked trimeshes. A forged level's terrain is in the
        // trimeshes, so the quads alone are holes to fall through.
        const rects = vxlSceneFloorRects(world, finestKeptQuads);
        ground.setSourceRects(VXLSCENE_GROUND_SOURCE, rects);
        const tris = vxlSceneFloorTriangles(world);
        ground.setSourceTriangles(VXLSCENE_TRIMESH_GROUND_SOURCE, tris.verts, tris.indices);
        console.log(
            `[VxlSceneTerrainSystem] ground-plane heightmap: ${rects.length} voxel floor patches + `
            + `${tris.indices.length / 3} surface triangles, ${ground.wallCount()} cliff walls`,
        );
    }

    private coupleChunkSeams(world: DecodedVxlSceneWorld): void {
        const cellsPerChunk = Math.round(world.chunkSize / world.minVoxelSize);
        const crust = new Map<string, RAPIER.Collider[]>();
        world.chunks.forEach((chunk, i) => {
            const c = this.colliders[i]?.quadTrimeshCollider;
            if (c && c.shape.type === RAPIER.ShapeType.Voxels) crust.set(`${chunk.cx},${chunk.cy},${chunk.cz}`, [c]);
        });
        for (const chunk of world.chunks) {
            const own = crust.get(`${chunk.cx},${chunk.cy},${chunk.cz}`);
            if (!own) continue;
            coupleChunkVoxelColliders(own, cellsPerChunk,
                (dx, dy, dz) => crust.get(`${chunk.cx + dx},${chunk.cy + dy},${chunk.cz + dz}`), CHUNK_POSITIVE_NEIGHBOURS);
        }
    }

    private bakeChunkColliders(
        chunk: DecodedChunk,
        world: DecodedVxlSceneWorld,
        physicsWorld: PhysicsWorld,
        body: RAPIER.RigidBody,
        out: ChunkColliders,
    ): void {
        const chunkSize = world.chunkSize;
        const minVoxelSize = world.minVoxelSize;
        const originX = chunk.cx * chunkSize;
        const originY = chunk.cy * chunkSize;
        const originZ = chunk.cz * chunkSize;

        // --- Primary collision surface: one trimesh from the chunk's finest KEPT quads ---
        // `finestKeptQuads` is `lodHints[0]` on a full-detail load; after an
        // effective-step skip it merges each offset group's finest surviving level so
        // collision still covers geometry whose fine level was shed (matching what the
        // renderer substitutes near the camera).
        const quads = finestKeptQuads(chunk);
        if (quads && quads.count > 0 && voxelCollidersEnabled()) {
            // Voxels mode: the crust cells behind the same collidable quads,
            // on the same min-cell lattice — identical collision surface with
            // no winding to rescue (a voxels shape has no triangle winding).
            const cells = quadsToShellCells(quads);
            if (cells.length > 0) {
                const desc = voxelsDesc(cells, minVoxelSize, minVoxelSize, minVoxelSize, originX, originY, originZ)
                    .setCollisionGroups(ENVIRONMENT_COLLISION_GROUPS)
                    .setFriction(0.5)
                    .setRestitution(0.0);
                out.quadTrimeshCollider = physicsWorld.createCollider(desc, body);
            }
        } else if (quads && quads.count > 0) {
            const { verts, indices } = quadsToTrimeshSoA(quads, minVoxelSize, originX, originY, originZ);
            if (verts.length > 0 && indices.length > 0) {
                // Re-orient back-wound triangles to face up. createTrimeshCollider uses
                // FIX_INTERNAL_EDGES, so Rapier takes the contact normal from WINDING —
                // a downward-wound walkable surface then reads as a CEILING to the
                // character controller: the capsule rests on it but computedGrounded()
                // is false, so the player can't jump, slides like ice, and can't step
                // curbs (every movement fix downstream is defeated by the missing
                // ground contact). Older forged city levels (e.g. Mini Helsinki) baked
                // the road/sidewalk surface wound downward. No-op for correctly-wound
                // meshes, so it's safe for all levels. (The named-trimesh path below
                // already did this; the primary LOD-quad surface was missing it.)
                const oriented = orientTrimeshUpward(verts, indices);
                out.quadTrimeshCollider = this.createTrimeshCollider(physicsWorld, body, verts, oriented);
            }
        }

        // --- Baked trimesh collider (smooth/curved surfaces) ---------------
        this.bakeBakedTrimesh(chunk, originX, originY, originZ, physicsWorld, body, out);
    }

    /**
     * Create one static trimesh collider with the environment collision groups and
     * the standard terrain friction/restitution, attached to the shared body.
     * Single source for the collider settings shared by the LOD-quad surface and
     * the baked named-trimesh surfaces.
     */
    private createTrimeshCollider(
        physicsWorld: PhysicsWorld,
        body: RAPIER.RigidBody,
        verts: Float32Array,
        indices: Uint32Array,
    ): RAPIER.Collider {
        // FIX_INTERNAL_EDGES: without it, fast bodies (skiers, vehicles)
        // sliding across internal triangle edges — and the per-chunk
        // collider seams — clip phantom edge normals that pop them off the
        // surface. The flag makes Rapier treat the mesh as the continuous
        // surface it is.
        const desc = RAPIER.ColliderDesc.trimesh(verts, indices, RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES)
            .setCollisionGroups(ENVIRONMENT_COLLISION_GROUPS)
            .setFriction(0.5)
            .setRestitution(0.0);
        return physicsWorld.createCollider(desc, body);
    }

    /**
     * Add a trimesh collider for each of the chunk's baked named trimeshes
     * (smooth/curved surfaces) — one collider per source object. Named-trimesh
     * verts are CHUNK-LOCAL world coords; translate them by the chunk world origin
     * before handing to Rapier. Mirrors the old system's trimesh-collider creation
     * (ColliderDesc.trimesh with ENVIRONMENT groups, friction 0.5, restitution 0.0).
     * Used by BOTH the full-detail and reduced-detail collider paths.
     */
    private bakeBakedTrimesh(
        chunk: DecodedChunk,
        originX: number, originY: number, originZ: number,
        physicsWorld: PhysicsWorld,
        body: RAPIER.RigidBody,
        out: ChunkColliders,
    ): void {
        for (const tm of chunk.namedTrimeshes) {
            if (tm.verts.length === 0 || tm.indices.length === 0) continue;
            const verts = translateVerts(tm.verts, originX, originY, originZ);
            // Re-orient any back-wound triangles up so the surface reads as ground to
            // the character controller (Rapier takes the contact normal from winding).
            // Near-horizontal roads/terrain only; a no-op for correctly-wound meshes
            // (all newly forged levels) — rescues older city levels baked with the
            // road surface wound downward, without re-baking.
            const indices = orientTrimeshUpward(verts, tm.indices);
            out.trimeshColliders.push(this.createTrimeshCollider(physicsWorld, body, verts, indices));
        }
    }

    /**
     * Build this level's vehicle nav grid from the ground mask, seed it, and start
     * the time-sliced collider bake (see `engine/nav/VehicleNavGridBake.ts`). No-op
     * (and clears the global) when the level has no ground mask. The grid covers
     * the same world extent as the mask at half its resolution (cellSize 1.0m vs
     * the mask's 0.5m), per the wiring brief.
     *
     * `VehicleNavGridBakePass.isDone` / `VehicleNavGrid.isFullyBaked()` go true
     * only after its SECOND sweep (see that class's doc) — `BAKE_REVALIDATE_DELAY_MS`
     * (8s) after the first one drains. A caller that snapshots a route the
     * instant the level "loads" (before that revalidation window closes) can
     * still catch an async-loaded prop collider mid-registration; anything
     * gating on `isFullyBaked()` — this system's own `stepVehicleNavBake`
     * included — already tolerates that extra wait for free, since it just
     * keeps calling `step()` every frame regardless of how many sweeps that
     * takes.
     *
     * Failure isolation: any error here (bad mask data, grid construction) is
     * caught and logged once — it must never abort `loadVxlScene`, since a broken
     * nav grid is far less bad than a level that fails to load.
     */
    private buildVehicleNavGrid(world: DecodedVxlSceneWorld, physicsWorld: PhysicsWorld | null): void {
        const mask = world.groundMask;
        if (!mask) {
            setGlobalVehicleNav(null);
            return;
        }
        try {
            const dims: VehicleNavGridDims = {
                cellSize: 1.0,
                width: Math.ceil(mask.width / 2),
                height: Math.ceil(mask.height / 2),
                minX: world.bounds.minX,
                minZ: world.bounds.minZ,
            };
            const grid = new VehicleNavGrid(dims);
            seedFromMask(grid, mask, world.bounds.minX, world.bounds.minZ);

            const pass = new VehicleNavGridBakePass(
                grid,
                this.makeCastDown(physicsWorld),
                this.makeCheckObstruction(physicsWorld),
                this.makeCheckWallObstruction(physicsWorld),
                () => performance.now(),
            );
            pass.start();

            this.navGrid = grid;
            this.navBakePass = pass;
            this.navBakeReadyToStep = false;
            this.navBakeFailed = false;
            setGlobalVehicleNav(grid);
        } catch (err) {
            console.warn('[VehicleNav] failed to build the vehicle nav grid for this level — '
                + 'vehicle pathfinding is unavailable', err);
            this.navGrid = null;
            this.navBakePass = null;
            setGlobalVehicleNav(null);
        }
    }

    /**
     * The bake pass's downward raycast primitive: casts against ENVIRONMENT |
     * TERRAIN colliders (same groups `probeVehiclePath` uses for vehicles) and
     * reports whether the hit is THIS level's baked terrain body — mirrors the
     * identity check `getBakedSurfaceHeightAt` uses (`hit.hitRigidBody ===
     * this.rigidBody`) rather than the userData set on the body, since a direct
     * reference comparison is the established pattern in this file and the
     * baked world owns exactly one static body (see `loadVxlScene`).
     */
    private makeCastDown(physicsWorld: PhysicsWorld | null): CastDown {
        return (x, fromY, z, maxDist) => {
            if (!physicsWorld) return null;
            const hit = physicsWorld.raycast(
                new THREE.Vector3(x, fromY, z),
                new THREE.Vector3(0, -1, 0),
                maxDist,
                CollisionGroup.ENVIRONMENT | CollisionGroup.TERRAIN,
            );
            if (!hit.hasHit) return null;
            return { y: hit.hitPoint.y, isTerrainBody: hit.hitRigidBody === this.rigidBody };
        };
    }

    /**
     * The bake pass's per-cell obstruction query (Fix 2 — off-centre props on
     * flat ground, see `VehicleNavGridBake.ts`'s `CheckObstruction` doc): a box
     * spanning the cell's prop band, queried against ENVIRONMENT | TERRAIN
     * (same groups the centre-ray `castDown` above already uses — props and
     * street furniture on a baked level register in ENVIRONMENT), excluding
     * THIS level's own terrain body by identity so the road/ground surface the
     * box itself rests just above never counts as its own obstruction.
     */
    private makeCheckObstruction(physicsWorld: PhysicsWorld | null): CheckObstruction {
        return (x, groundY, z) => {
            if (!physicsWorld) return false;
            const centerY = groundY + (BAKE_OBSTRUCTION_MIN_ABOVE_M + BAKE_PROP_MAX_ABOVE_M) / 2;
            const halfY = (BAKE_PROP_MAX_ABOVE_M - BAKE_OBSTRUCTION_MIN_ABOVE_M) / 2;
            return physicsWorld.intersectsBox(
                new THREE.Vector3(x, centerY, z),
                new THREE.Vector3(0.5, halfY, 0.5),
                CollisionGroup.ENVIRONMENT | CollisionGroup.TERRAIN,
                this.rigidBody ?? undefined,
            );
        };
    }

    /**
     * The bake pass's per-cell WALL obstruction query (see
     * `VehicleNavGridBake.ts`'s `CheckWallObstruction` doc). Same
     * `intersectsBox` primitive and same 1x1 m footprint as
     * `makeCheckObstruction` above, with two deliberate differences:
     *
     *  - band: `[groundY + 0.25, groundY + 1.9]` instead of `[0.15, 2.5]`.
     *  - `excludeBody`: NOT passed, i.e. THIS level's terrain body counts.
     *
     * The two go together. The prop box starts at 0.15 m and must exclude the
     * terrain body, because at that height the box straddles the road surface
     * the cell is standing on and every cell would block itself. The wall box
     * INCLUDES the terrain body precisely so kerb corners, ledges, walls and
     * low arches baked into the same trimesh as the road are visible at all —
     * and can only afford to do that because its floor sits above both the
     * road surface and any grade a vehicle could climb (see
     * `BAKE_WALL_MIN_ABOVE_M`, where both ends of that window are measured).
     * The ceiling mirrors `probeVehiclePath`'s swept slab, so geometry the car
     * fits under stays clear in both truths.
     */
    private makeCheckWallObstruction(physicsWorld: PhysicsWorld | null): CheckWallObstruction {
        return (x, groundY, z) => {
            if (!physicsWorld) return false;
            const centerY = groundY + (BAKE_WALL_MIN_ABOVE_M + BAKE_WALL_MAX_ABOVE_M) / 2;
            const halfY = (BAKE_WALL_MAX_ABOVE_M - BAKE_WALL_MIN_ABOVE_M) / 2;
            return physicsWorld.intersectsBox(
                new THREE.Vector3(x, centerY, z),
                new THREE.Vector3(0.5, halfY, 0.5),
                CollisionGroup.ENVIRONMENT | CollisionGroup.TERRAIN,
            );
        };
    }

    /**
     * Advance the collider bake pass by one time slice. Called every frame from
     * the beforeRender hook registered in `loadVxlScene`.
     *
     * HAZARD (see `navBakeReadyToStep`'s doc): the very first invocation after a
     * (re)build must be skipped, not stepped — the physics world is guaranteed to
     * have stepped at least once only from the SECOND invocation onward, and
     * casting rays before that would see colliders that aren't synced yet.
     *
     * Failure isolation: a step() throw is caught, logged once with a
     * `[VehicleNav]` prefix, and permanently disables further stepping for this
     * level — it must never break the render loop.
     */
    private stepVehicleNavBake(): void {
        if (!this.navBakePass || this.navBakeFailed) return;
        if (!this.navBakeReadyToStep) {
            this.navBakeReadyToStep = true;
            return;
        }
        if (this.navBakePass.isDone) return;
        try {
            this.navBakePass.step();
        } catch (err) {
            console.warn('[VehicleNav] bake pass step() failed — disabling further '
                + 'vehicle nav baking for this level', err);
            this.navBakeFailed = true;
        }
    }

    /**
     * Re-open the bake pass for cells a ground paint just touched. `repaintMaskRect`
     * only recomputes COST over `rect` (groundY/flags/midpoints are untouched — see
     * its doc comment); any cell that came out newly drivable and isn't yet
     * VALIDATED gets queued so the collider pass re-checks it for real obstructions.
     * `enqueueCell` reopens the pass (clears `isDone`) so `stepVehicleNavBake`
     * resumes stepping it next frame.
     */
    private repaintVehicleNav(minX: number, minZ: number, maxX: number, maxZ: number): void {
        if (this.navBakeFailed || !this.navGrid || !this.navBakePass) return;
        const world = this.worldData;
        const mask = world?.groundMask;
        if (!world || !mask) return;
        try {
            const changed = repaintMaskRect(this.navGrid, mask, world.bounds.minX, world.bounds.minZ, {
                minX, minZ, maxX, maxZ,
            });
            for (const { gx, gz } of changed) {
                if (this.navGrid.getCost(gx, gz) <= 0) continue;
                if ((this.navGrid.getFlags(gx, gz) & CELL_VALIDATED) !== 0) continue;
                this.navBakePass.enqueueCell(gx, gz);
            }
        } catch (err) {
            console.warn('[VehicleNav] repaint of the vehicle nav grid failed — '
                + 'affected cells may be stale', err);
            this.navBakeFailed = true;
        }
    }

    /**
     * Per-frame LOD selection. Matches `VxlChunkedTerrainSystem.updateVisibility`
     * (the method name `WorldGenerator` / `Game.ts` call). `_playerPosition` is
     * accepted for signature parity but unused — LOD is camera-relative.
     *
     * Kept for template compatibility, but the engine already self-drives the
     * same refresh from a beforeRender hook (see loadVxlScene) — including
     * during F9 recording, when templates skip this call — so this is a no-op
     * while that hook is registered. It MUST be a no-op, not a duplicate: a
     * second updateDetail per frame doubles the per-frame column-build budget,
     * which stacked into visible movement stutter on low-end machines.
     */
    updateVisibility(camera: THREE.Camera, _playerPosition?: THREE.Vector3): void {
        if (!this.renderer || this.unregisterBeforeRender) return;
        camera.getWorldPosition(this._scratchCamPos);
        this.renderer.updateLod(this._scratchCamPos);
        this.groundDetail?.updateDetail(this._scratchCamPos);
    }

    /**
     * Per-frame tick. No-op for static baked terrain — kept so callers can
     * drive every terrain system through the same `update(dt)` shape.
     */
    update(_deltaTime: number): void {
        // intentionally empty
    }

    /**
     * Returns the surface height (world Y) at `(x, z)` via a downward physics
     * raycast against TERRAIN + ENVIRONMENT colliders. Mirrors
     * `VxlChunkedTerrainSystem.getHeightAt` so callers don't care which terrain
     * implementation is wired up.
     */
    getHeightAt(x: number, z: number): number {
        const physicsWorld = this.engine.physicsWorld;
        if (!physicsWorld) return 0;
        const rayResult = physicsWorld.raycast(
            new THREE.Vector3(x, 500, z),
            new THREE.Vector3(0, -1, 0),
            600,
            CollisionGroup.TERRAIN | CollisionGroup.ENVIRONMENT,
        );
        if (rayResult.hasHit) return rayResult.hitPoint.y;
        return this.worldData?.bounds.minY ?? 0;
    }

    /**
     * Surface height at (x, z) considering ONLY the BAKED WORLD — the terrain,
     * roads, kerbs and any bridge/structure baked into the `.vwld`. Environment
     * -object props (trees, foliage, scenery placed as instances) are skipped
     * by re-casting from just beneath each one.
     *
     * The weather system's rain height field uses this instead of
     * `getHeightAt`: that field is a HEIGHTMAP, so whatever it records makes
     * the entire column beneath it dry. With props included, tree canopies
     * stopped the rain over wide bands of the map (measured: up to 40% of the
     * near-field area) and floated impact splashes in mid-air beside trees.
     * Baked structures still shelter properly — a bridge deck IS the level.
     */
    getBakedSurfaceHeightAt(x: number, z: number): number {
        const physicsWorld = this.engine.physicsWorld;
        const floorY = this.worldData?.bounds.minY ?? 0;
        if (!physicsWorld) return floorY;
        let fromY = HEIGHT_RAY_START_Y;
        for (let skips = 0; skips < MAX_PROP_RAY_SKIPS; skips++) {
            _heightRayOrigin.set(x, fromY, z);
            const hit = physicsWorld.raycast(
                _heightRayOrigin,
                _heightRayDown,
                HEIGHT_RAY_RANGE,
                CollisionGroup.TERRAIN | CollisionGroup.ENVIRONMENT,
                _heightRayResult,
            );
            if (!hit.hasHit) return floorY;
            // The baked world owns exactly one static body (see loadVxlScene).
            if (hit.hitRigidBody === this.rigidBody) return hit.hitPoint.y;
            fromY = hit.hitPoint.y - PROP_RAY_STEP_DOWN;
            if (fromY <= floorY) return floorY;
        }
        return floorY;
    }

    /** Alias — parity with `VxlChunkedTerrainSystem.getVoxelHeightAt`. */
    getVoxelHeightAt(x: number, z: number): number {
        return this.getHeightAt(x, z);
    }

    /** Alias — parity with `VxlChunkedTerrainSystem.getVoxelTerrainHeight`. */
    getVoxelTerrainHeight(x: number, z: number): number {
        return this.getHeightAt(x, z);
    }

    /** Alias — parity with `VxlChunkedTerrainSystem.getActualVoxelSurfaceHeight`. */
    getActualVoxelSurfaceHeight(x: number, z: number): number {
        return this.getHeightAt(x, z);
    }

    /**
     * Top-level scene group containing the renderer's chunk meshes. Genre code
     * can attach extra terrain decorations under here so they get culled /
     * disposed alongside the terrain. Mirrors
     * `VxlChunkedTerrainSystem.getVoxelChunkGroup`.
     */
    getVoxelChunkGroup(): THREE.Group {
        return this.rootGroup;
    }

    /** True once `loadVxlScene` has finished and physics bodies are in. */
    areCollidersReady(): boolean {
        return this.collidersReady;
    }

    /**
     * Number of finest LOD levels that were dropped at load to keep an oversized
     * world inside the memory budget. 0 means the world loaded at full detail.
     * The Creator uses this to surface an in-UI "loaded at reduced detail"
     * banner; the runtime adds NO DOM / notification itself.
     */
    getReducedLodLevels(): number {
        return this.reducedLodLevels;
    }

    /** World-space chunk size in meters. */
    getChunkSize(): number {
        return this.worldData?.chunkSize ?? 0;
    }

    /** Per-cell unit. Baked levels have no uniform grid, so report chunk size,
     *  mirroring `VxlChunkedTerrainSystem.getBlockSize`. */
    getBlockSize(): number {
        return this.getChunkSize();
    }

    /** Number of chunks in the loaded world. */
    getChunkCount(): number {
        return this.worldData?.chunks.length ?? 0;
    }

    /** Runtime collider registrations currently owned by this loaded terrain. */
    getColliderCounts(): { named: number; quad: number; total: number } {
        let named = 0;
        let quad = 0;
        for (const chunk of this.colliders) {
            named += chunk.trimeshColliders.length;
            if (chunk.quadTrimeshCollider) quad++;
        }
        return { named, quad, total: named + quad };
    }

    /** Toggle the entire terrain's render visibility without disposing it. */
    setCullingEnabled(enabled: boolean): void {
        this.rootGroup.visible = enabled;
    }

    isCullingEnabled(): boolean {
        return this.rootGroup.visible;
    }

    /** Set the per-LOD distance schedule on the underlying world (parity with
     *  `VxlChunkedTerrainSystem.setLodDistances`). Takes effect next frame
     *  because the renderer reads `world.lodDistances` live. */
    setLodDistances(distances: number[]): void {
        this.config = { ...this.config, lodDistances: distances };
        if (this.worldData) this.worldData.lodDistances = distances;
    }

    /** The per-LOD distance schedule in force — the world's own when loaded, else the config's. */
    getLodDistances(): number[] {
        return [...(this.worldData?.lodDistances ?? this.config.lodDistances)];
    }

    /** Parity with `VxlChunkedTerrainSystem.setMaxRenderDistance`. The VxlScene
     *  renderer has no explicit cutoff, so this only updates the config. */
    setMaxRenderDistance(distance: number | null): void {
        this.config = { ...this.config, maxRenderDistance: distance };
    }

    getMaxRenderDistance(): number | null {
        return this.config.maxRenderDistance;
    }

    /**
     * Draw only the baked chunks whose box touches `region` (world space); `null`
     * draws the whole level again. Render-only — the level's colliders stay.
     *
     * For a level part of which must not be seen: a forged ship sailing on open
     * water, say, whose baked coast cannot move and would sit still while the
     * sea goes by (`engine/sailing/`). Safe to call before the level has loaded;
     * the region is applied when the renderer is built.
     */
    setRenderRegion(region: THREE.Box3 | null): void {
        this.renderRegion = region ? region.clone() : null;
        this.renderer?.setRenderRegion(this.renderRegion);
    }

    /** World-space AABB of the loaded world, or null if nothing's loaded. */
    getBounds(): DecodedVxlSceneWorld['bounds'] | null {
        return this.worldData ? { ...this.worldData.bounds } : null;
    }

    /**
     * Monotonic counter bumped by every `loadVxlScene` (boot AND level
     * switches). Systems that cache scene-graph or world-derived state
     * (weather's surface swap + rain collision bake) compare it to know when
     * to rebuild, instead of probing the scene graph for orphaned nodes.
     */
    getWorldGeneration(): number {
        return this.worldGeneration;
    }

    /**
     * Ground-surface type byte at a world position (see `GroundTypes.ts`), or
     * `GROUND_TYPE.none` when this world has no ground mask, the point is outside
     * it, or nothing typed that cell. Game code reads it for surface behaviour —
     * the vehicle's per-wheel tyre grip is the first consumer.
     *
     * `y` is the query height. The mask stores ONE type per 0.5 m column, so a
     * point far above the masked surface (a bridge deck over grass, a car mid-jump)
     * would otherwise inherit the ground below it; supply the contact height and
     * anything beyond `tolerance` of the masked top reads as untyped. Pass
     * `Infinity` to ignore height entirely.
     */
    getGroundTypeAt(x: number, y: number, z: number, tolerance = GROUND_TYPE_MATCH_TOLERANCE_M): number {
        const world = this.worldData;
        if (!world?.groundMask) return GROUND_TYPE.none;
        return groundTypeAtPoint(world.groundMask, world.bounds.minX, world.bounds.minZ, x, y, z, tolerance);
    }

    /** Ground-mask cell size in metres (the resolution ground-type edits work at), or 0 with no mask. */
    getGroundMaskCellSize(): number {
        return this.worldData?.groundMask?.cellSize ?? 0;
    }

    /**
     * Baked ground mask for bulk scanning (types and surface heights for all cells),
     * or null if the level has no mask or is not yet loaded.
     *
     * Do not mutate; treat as a snapshot owned by the terrain system, invalidated
     * on level load (`getWorldGeneration()` bump). The mask's world origin (cell grid
     * begins at these X / Z coordinates) is available from `getBounds().minX` and
     * `getBounds().minZ`.
     */
    getGroundMask(): Readonly<GroundMaskData> | null {
        return this.worldData?.groundMask ?? null;
    }

    /**
     * Repaint the ground material over a world-space CIRCLE and refresh the cover
     * that grows there. The engine owns the refresh: changed columns are re-planned
     * by `GroundDetailSystem` — immediately when the column hasn't rebuilt lately,
     * else coalesced behind its rebuild cooldown — so long grass visibly becomes
     * short where it was cut without a per-frame rebuild while mowing.
     *
     * Returns HOW MANY CELLS ACTUALLY CHANGED — the natural score for area-clearing
     * gameplay (cells × cellSize² = m² cleared). Cells already at `type` count 0, so
     * driving over the same patch twice earns nothing the second time.
     *
     * `onlyReplacing` restricts the edit to one existing material: pass
     * `GROUND_TYPE.grassLush` and a mower crossing a mixed field cuts the long grass
     * and leaves sand, dirt and the path untouched, in ONE call.
     *
     * No-op (returns 0) on a level with no ground mask.
     */
    setGroundTypeInRadius(x: number, z: number, radius: number, type: number, onlyReplacing?: number): number {
        return this.paintGroundType(x - radius, z - radius, x + radius, z + radius, type, onlyReplacing,
            (cx, cz) => (cx - x) * (cx - x) + (cz - z) * (cz - z) <= radius * radius);
    }

    /** Rect form of `setGroundTypeInRadius` — same contract, axis-aligned footprint. */
    setGroundTypeInRect(minX: number, minZ: number, maxX: number, maxZ: number, type: number, onlyReplacing?: number): number {
        return this.paintGroundType(minX, minZ, maxX, maxZ, type, onlyReplacing, null);
    }

    /**
     * Shared painter: walk the mask cells in an XZ box, apply `inside` (circle test
     * or null for the whole box), write `type`, then invalidate the detail columns
     * that changed so their cover rebuilds.
     */
    private paintGroundType(
        minX: number, minZ: number, maxX: number, maxZ: number,
        type: number, onlyReplacing: number | undefined,
        inside: ((cellCenterX: number, cellCenterZ: number) => boolean) | null,
    ): number {
        const world = this.worldData;
        if (!world?.groundMask) return 0;
        const hit = paintGroundTypeInMask(
            world.groundMask, world.bounds.minX, world.bounds.minZ,
            { minX, minZ, maxX, maxZ }, type, onlyReplacing, inside,
        );
        // Only flag columns that actually changed — a mower idling on already-cut
        // grass must not mark (and eventually rebuild) its column every frame.
        if (hit.changed > 0) {
            this.groundDetail?.invalidateRegion(hit.minX, hit.minZ, hit.maxX, hit.maxZ);
            this.repaintVehicleNav(hit.minX, hit.minZ, hit.maxX, hit.maxZ);
        }
        return hit.changed;
    }

    /**
     * Names of the trimesh-collider objects baked into this world (the GLB node
     * names flagged with the `trimeshCollider` voxelize option). Empty for worlds
     * with no trimesh colliders, or for v2-format worlds (which carry an unnamed
     * trimesh — re-bake to gain names). Game code calls this to discover which
     * surfaces it can query with `getTrimesh`.
     */
    getTrimeshNames(): string[] {
        return this.worldData ? collectTrimeshNames(this.worldData) : [];
    }

    /**
     * Merged geometry of the named trimesh-collider object, in WORLD coordinates
     * (the space physics bodies and gameplay run in), or null if no object by that
     * name exists. Concatenates every chunk's slice of the object into one
     * vertex/index buffer. Game code uses this to derive things like AI driving
     * paths — the engine itself does no path-building. Cached per name.
     */
    /**
     * Un-cull / re-cull every terrain batch. Used for the single upload frame that frees
     * the batches' CPU-side arrays before the scenery build allocates — see
     * levels/terrainUploadFrame.ts. No-op for a collider-only world (no renderer).
     */
    setBatchCulling(enabled: boolean): void {
        this.renderer?.setBatchCulling(enabled);
    }

    getTrimesh(name: string): { vertices: Float32Array; indices: Uint32Array } | null {
        if (!this.worldData) return null;
        const cached = this._trimeshCache.get(name);
        if (cached !== undefined) return cached;
        const result = mergeNamedTrimesh(this.worldData, name);
        this._trimeshCache.set(name, result);
        return result;
    }

    /**
     * Road-centered, evenly-spaced, closed waypoint loop for the named trimesh —
     * an ordered driving line ready for AI cars, checkpoints, or a minimap.
     * Convenience wrapper over `getTrimesh(name)` + `buildTrackCenterline`. Returns
     * [] if the object isn't found or its surface doesn't form a usable loop.
     *
     * The lap is oriented to run the way the player's start spawn faces, so the
     * order matches the direction the grid was laid out for. Pass `orientTo`
     * explicitly to override, or when the game has no player spawn point.
     */
    getTrackCenterline(name: string, options?: Partial<TrackCenterlineOptions>): CenterlinePoint[] {
        const trimesh = this.getTrimesh(name);
        if (!trimesh) return [];
        const orientTo = options?.orientTo ?? this.playerSpawnOrientation();
        return buildTrackCenterline(trimesh, { ...options, orientTo });
    }

    /**
     * Racing direction implied by the `player` spawn point: where the grid sits
     * and which way it faces. `rotationY` is a gameplay yaw (local +Z forward),
     * so the heading is (sin y, cos y) — see docs/coordinate-system.md §2.
     * Returns undefined when the game declares no player spawn, leaving the
     * loop direction unconstrained rather than guessing one.
     */
    private playerSpawnOrientation(): TrackCenterlineOptions['orientTo'] {
        const spawn = this.engine.getSpawnPoints?.('player')?.[0];
        if (!spawn) return undefined;
        return {
            position: { x: spawn.position.x, z: spawn.position.z },
            heading: { x: Math.sin(spawn.rotationY), z: Math.cos(spawn.rotationY) },
        };
    }

    /** Tear down the renderer + every collider, but keep the root group in the
     *  scene so the system is reusable via another `loadVxlScene`. */
    private clearWorld(): void {
        // Ground plane: withdraw this level's heightmap patches (a level switch feeds the next).
        const enginePhysics = this.engine.physicsWorld;
        if (isPlaneLockedPhysics(enginePhysics)) {
            enginePhysics.ground?.removeSource(VXLSCENE_GROUND_SOURCE);
            enginePhysics.ground?.removeSource(VXLSCENE_TRIMESH_GROUND_SOURCE);
        }
        if (this.unregisterBeforeRender) {
            this.unregisterBeforeRender();
            this.unregisterBeforeRender = null;
        }
        if (this.groundDetail) {
            this.groundDetail.dispose();
            this.groundDetail = null;
        }
        if (this.renderer) {
            this.rootGroup.remove(this.renderer.group);
            this.renderer.dispose();
            this.renderer = null;
        }
        const physicsWorld = this.engine.physicsWorld;
        if (physicsWorld) {
            // Removing the rigid body removes its attached colliders; mirror
            // the old system which lets VoxelObject.dispose drop the body.
            // We track colliders explicitly so they're cleared even if the
            // body removal path changes.
            for (const entry of this.colliders) {
                for (const c of entry.trimeshColliders) physicsWorld.removeCollider(c);
                if (entry.quadTrimeshCollider) physicsWorld.removeCollider(entry.quadTrimeshCollider);
            }
            if (this.rigidBody) physicsWorld.removeRigidBody(this.rigidBody);
        }
        this.colliders = [];
        this.rigidBody = null;
        this.collidersReady = false;
        this.reducedLodLevels = 0;
        this._trimeshCache.clear();
        // Invalidate the vehicle nav grid here — this runs both from `dispose()`
        // and re-entrantly at the top of `loadVxlScene` on a level switch (see its
        // `if (this.renderer || this.rigidBody) this.clearWorld();` guard), so a
        // stale grid from the previous level is never left installed as the
        // global while the new level's colliders are (re)baking.
        this.navGrid = null;
        this.navBakePass = null;
        this.navBakeReadyToStep = false;
        this.navBakeFailed = false;
        setGlobalVehicleNav(null);
        // Unregister as the main terrain — but only if WE are the registered one, so tearing
        // down a stale instance never clobbers a newer system's registration.
        const dom = this.engine.getDynamicObjectManager?.();
        if (dom?.getBakedTerrain() === this) dom.setBakedTerrain(null);
    }

    /**
     * Drop the renderer, every collider, and detach from the scene. Safe to
     * call multiple times. After disposal the system can be re-used via another
     * `loadVxlScene(...)` call. Mirrors `VxlChunkedTerrainSystem.dispose`.
     */
    /** The NPC navmesh this level built from its ground mask (null: a sidecar or no mask). */
    private npcNavMesh: VoxelNavMesh | null = null;

    /**
     * Give NPCs a navmesh. A forged level has no voxel columns to scan, but its
     * ground mask already knows every column's top surface and ground type,
     * so the navmesh is built from that in one pass at load — a sampler over
     * the mask, no raycasts, no per-frame cost. Environment objects (buildings,
     * wrecks, trees) block cells through the obstacle providers they already
     * register; a prebuilt sidecar (`asset.navUrl`, LevelEngineBridge) wins
     * when one exists. Without this every enemy beelined at the player.
     */
    private buildNpcNavMesh(world: DecodedVxlSceneWorld): void {
        const mask = world.groundMask;
        if (!mask) return;
        if (getGlobalNavMesh()?.isReady()) return;   // a sidecar was installed for this level
        // `?npcnav=off` — A/B the old beeline behaviour in a test drive (debug only).
        if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('npcnav') === 'off') {
            console.log('[VxlSceneTerrain] NPC navmesh skipped (?npcnav=off)');
            return;
        }
        const t0 = performance.now();
        const { minX, minZ, maxX, maxZ } = world.bounds;
        const sampler = (x: number, z: number): number | null => {
            const idx = groundMaskCellIndex(mask, x, z, minX, minZ);
            if (idx < 0) return null;
            const q = mask.topY[idx]!;
            if (q === 0 || mask.types[idx] === GROUND_TYPE.none) return null;
            return q * GROUND_MASK_HEIGHT_STEP;
        };
        const nav = new VoxelNavMesh();
        nav.buildFromHeightSampler(sampler, minX, maxX, minZ, maxZ, NPC_NAV_STEP_M, { cellSize: NPC_NAV_CELL_M });
        setGlobalNavMesh(nav);
        this.npcNavMesh = nav;
        console.log(`[VxlSceneTerrain] NPC navmesh built from the ground mask in ${(performance.now() - t0).toFixed(0)} ms`);
    }

    dispose(): void {
        if (this.npcNavMesh) {
            if (getGlobalNavMesh() === this.npcNavMesh) setGlobalNavMesh(null);
            this.npcNavMesh.dispose();
            this.npcNavMesh = null;
        }
        this.clearWorld();
        if (this.rootGroup.parent) {
            this.rootGroup.parent.remove(this.rootGroup);
        }
        this.worldData = null;
    }
}
