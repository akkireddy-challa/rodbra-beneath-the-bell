/**
 * GroundDetailSystem — runtime ground detail for baked VxlScene levels, driven
 * by the v6 ground mask (see GroundMaskBaker.ts):
 *
 *   - cobble/brick cells grow render-only stone caps (domed stones / brick
 *     pairs) sitting ON TOP of the flat greedy-quad surface — the flat surface
 *     shows between stones and reads as mortar. Physics NEVER sees them: no
 *     collider is created and the collider path is untouched.
 *   - grass cells grow instanced tufts + occasional flower clumps; gravel and
 *     dirt get sparse pebbles. Density follows the mask's grass variant.
 *
 * Detail exists only inside a camera ring (`detailDistance`, with hysteresis),
 * one InstancedMesh per column-chunk per detail kind, built lazily on ring
 * entry and disposed on exit — mirroring VoxelFoliageSystem's per-chunk
 * instancing without its VoxelWorld/terrain-registry coupling. Mask edits
 * (`invalidateRegion`) mark built columns dirty; each re-plans at most once
 * per `rebuildCooldownMs`, rewriting its instance buffers in place.
 *
 * Colors sample the BAKED quad colors (the forger's per-stone / per-patch
 * mosaic), so runtime detail always matches the surface it stands on. A cell
 * whose visible top surface does not match the mask's topY (a building roof, a
 * bridge deck over the road) spawns nothing — that is the occupancy guard.
 */

import * as THREE from 'three';
import { createFoliageMaterial, prepareFoliageInstances, DEFAULT_FOLIAGE_APPEARANCE, type FoliageAppearance, type FoliageMaterialHandle } from 'engine/foliage/FoliageMaterial.js';
import { createGroundCoverTuft, createGroundCoverFlower } from 'engine/foliage/GroundCoverGeometry.js';
import type { DecodedVxlSceneWorld, DecodedChunk } from 'engine/vxlscene/VxlSceneFormat.js';
import type { GroundMaskData } from 'engine/vxlscene/GroundMaskBaker.js';
import { GROUND_MASK_HEIGHT_STEP } from 'engine/vxlscene/GroundMaskBaker.js';
import { GROUND_TYPE, isStoneDetail, grassDensity, hasPebbles } from 'engine/vxlscene/GroundTypes.js';
import { finestKeptQuads } from 'engine/VxlSceneTerrainSystem.js';
import { atlasCellRepr } from 'engine/vxlscene/atlasColor.js';

export interface GroundDetailOptions {
    /** Camera ring (m) within which ground detail is built. */
    detailDistance: number;
    /** Extra margin (m) past the ring before a column's detail is disposed. */
    hysteresis: number;
    /** Max stone instances per column-chunk (excess skipped, logged once). */
    maxStonesPerChunk: number;
    /**
     * Max cover (tuft/flower/pebble) instances per column-chunk. Raising `density`
     * without raising this silently clamps the field back to a sparse look, so
     * `groundDetailOptionsFor` scales it with density rather than leaving it fixed.
     */
    maxCoverPerChunk: number;
    /** Columns built per update() call at most — spreads build cost over frames. */
    maxBuildsPerUpdate: number;
    /** Mask-topY vs quad-top match tolerance (m) — the roof/bridge occupancy guard. */
    matchTolerance: number;
    /**
     * Minimum ms between invalidation-driven rebuilds of one column.
     * `invalidateRegion` marks columns dirty; the rebuild lands on the next
     * update once this cooldown has passed since the column's last build. A
     * mower repainting the same column every frame then costs a few rebuilds
     * per second instead of one per frame — while a column not rebuilt
     * recently still refreshes on the very next update, so a fresh cut
     * appears immediately.
     */
    rebuildCooldownMs: number;
    /**
     * Cover multiplier: how many tufts grow per cell relative to the default look.
     * 1 = the original city-park sprinkle (~2 tufts/m²); 4–6 = a thick meadow you
     * can mow through. Multiplies the per-type density, so cut grass stays visibly
     * thinner than long grass at every setting.
     */
    density: number;
    /** Tuft size multiplier — the other half of "volume". 1 = default (~0.3 m blades). */
    scale: number;
    /** Deterministic per-level seed for jitter. */
    seed: number;
    /** Optional wind/inspection overrides; existing ground-cover configs keep their defaults. */
    appearance?: Partial<FoliageAppearance>;
}

export const DEFAULT_GROUND_DETAIL_OPTIONS: GroundDetailOptions = {
    detailDistance: 60,
    hysteresis: 14,
    maxStonesPerChunk: 2600,
    maxCoverPerChunk: 1500,
    maxBuildsPerUpdate: 4,
    rebuildCooldownMs: 250,
    matchTolerance: 0.8,
    density: 1,
    scale: 1,
    seed: 1337,
};

/** Cover instances a chunk needs at `density`, so a raised density is never silently clamped. */
export function coverBudgetForDensity(density: number, baseline = DEFAULT_GROUND_DETAIL_OPTIONS.maxCoverPerChunk): number {
    return Math.ceil(baseline * Math.max(1, density));
}

/**
 * Distance-based cover density falloff (the foliage LOD). A column always PLANS
 * and buffers its full authored grass density, but the instances are ordered by
 * a per-instance thinning hash, so the drawn set at any band is a PREFIX of the
 * buffer: crossing a band just changes `InstancedMesh.count` — no re-plan, no
 * allocation, no GPU upload. (The first version rebuilt the column on every
 * band crossing; while driving that stacked several multi-ms rebuilds per
 * second and read as movement stutter on low-end machines.) The hash is
 * position-uncorrelated, so a prefix thins the field uniformly — a tuft at 60m
 * is about a pixel, and more than half the standing instances of a dense
 * meadow were invisible cost.
 *
 * Applies to GRASS COVER ONLY: stones (cobble/brick road surfaces) and pebbles
 * thin into visible holes, so they always draw in full.
 *
 * `DENSITY_BAND_BOUNDS[i]` is the camera distance (m) where band i ends;
 * `DENSITY_BAND_FACTORS[i]` the drawn fraction inside it (one extra factor for
 * beyond the last bound). Band changes apply with `DENSITY_BAND_HYSTERESIS_M`
 * of margin so a column sitting on a boundary doesn't flicker.
 */
export const DENSITY_BAND_BOUNDS: readonly number[] = [30, 45];
export const DENSITY_BAND_FACTORS: readonly number[] = [1, 0.6, 0.3];
export const DENSITY_BAND_HYSTERESIS_M = 3;

/** Density band for a camera→column-center distance (0 = nearest/full). */
export function densityBandForDistance(d: number): number {
    for (let i = 0; i < DENSITY_BAND_BOUNDS.length; i++) {
        if (d < DENSITY_BAND_BOUNDS[i]!) return i;
    }
    return DENSITY_BAND_BOUNDS.length;
}

/**
 * Build options from a game's `groundCoverConfig` (world.json), falling back to
 * the defaults field by field. This is the AI-authorable entry point: a game that
 * wants a thick mowable meadow sets density/scale/distance and the engine does the
 * rest — including widening the per-chunk budget so the density actually lands.
 */
export function groundDetailOptionsFor(
    config: { density?: number; scale?: number; distance?: number } | undefined,
    seed = DEFAULT_GROUND_DETAIL_OPTIONS.seed,
): GroundDetailOptions {
    const density = Math.max(0, config?.density ?? DEFAULT_GROUND_DETAIL_OPTIONS.density);
    return {
        ...DEFAULT_GROUND_DETAIL_OPTIONS,
        density,
        scale: Math.max(0.1, config?.scale ?? DEFAULT_GROUND_DETAIL_OPTIONS.scale),
        detailDistance: Math.max(10, config?.distance ?? DEFAULT_GROUND_DETAIL_OPTIONS.detailDistance),
        maxCoverPerChunk: coverBudgetForDensity(density),
        seed,
    };
}

/**
 * Height multiplier per grass type — what makes mowing READ. Long grass stands
 * tall, cut grass is stubble, so a mown stripe is visible from the seat even
 * before the density difference registers.
 */
export function grassHeightScale(t: number): number {
    switch (t) {
        case GROUND_TYPE.grassLush: return 1.6;
        case GROUND_TYPE.grass: return 1.0;
        case GROUND_TYPE.grassDry: return 0.45;
        default: return 1.0;
    }
}

/** One planned detail instance (pure data — unit-testable without THREE). */
export interface DetailInstance {
    kind: 'dome' | 'brick' | 'tuft' | 'flower' | 'pebble';
    x: number; y: number; z: number;
    yaw: number;
    scale: number;
    /** Linear-ish display color 0..255 (from the baked atlas cell, jittered). */
    r: number; g: number; b: number;
    /**
     * Deterministic thinning key [0,1) — GRASS COVER ONLY (tuft/flower).
     * Instances drawn at a density band are those with the smallest keys, so
     * sorting by it makes every band's drawn set a prefix (see the falloff doc).
     * Stones and pebbles never thin and carry no key.
     */
    thin?: number;
}

/** Deterministic 2D integer hash → [0, 1). */
function hash01(ix: number, iz: number, seed: number): number {
    let h = (ix * 374761393 + iz * 668265263 + (seed | 0) * 2246822519) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}

/** Top surface candidate for one mask cell: up-facing quad top + its color. */
interface CellSurface { y: number; colorIdx: number }

/** A baked atlas color scaled by `factor`, clamped to the 0..255 display range. */
function tint(base: { r: number; g: number; b: number }, factor: number): { r: number; g: number; b: number } {
    return {
        r: Math.min(255, base.r * factor),
        g: Math.min(255, base.g * factor),
        b: Math.min(255, base.b * factor),
    };
}

/**
 * Dominant direction (yaw about +Y) of same-type mask cells around (cx, cz) —
 * orients brick running bond along the road instead of world axes. Doubled-angle
 * covariance so opposite directions reinforce; falls back to 0 for isolated cells.
 */
export function maskDirectionYaw(mask: GroundMaskData, cx: number, cz: number): number {
    const type = mask.types[cz * mask.width + cx]!;
    let sxx = 0, sxz = 0, szz = 0, n = 0;
    for (let dz = -3; dz <= 3; dz++) {
        for (let dx = -3; dx <= 3; dx++) {
            const x = cx + dx, z = cz + dz;
            if (x < 0 || z < 0 || x >= mask.width || z >= mask.height) continue;
            if (mask.types[z * mask.width + x] !== type) continue;
            sxx += dx * dx; sxz += dx * dz; szz += dz * dz; n++;
        }
    }
    if (n < 4) return 0;
    return 0.5 * Math.atan2(2 * sxz, sxx - szz);
}

/**
 * Collect the up-facing quad top surfaces of one column-chunk, indexed by mask
 * cell. For each covered cell the candidate CLOSEST to the mask's topY wins, so
 * a bridge deck above a road never masks the road's own surface out.
 * Pure — exported for tests.
 */
export function collectColumnSurfaces(
    world: DecodedVxlSceneWorld,
    mask: GroundMaskData,
    colCx: number,
    colCz: number,
): Map<number, CellSurface> {
    const s = world.minVoxelSize;
    const chunkSize = world.chunkSize;
    const { minX, minZ } = world.bounds;
    const out = new Map<number, CellSurface>();

    for (const chunk of world.chunks) {
        if (chunk.cx !== colCx || chunk.cz !== colCz) continue;
        const originX = chunk.cx * chunkSize;
        const originY = chunk.cy * chunkSize;
        const originZ = chunk.cz * chunkSize;
        const quads = finestKeptQuads(chunk);
        if (!quads) continue;
        for (let i = 0; i < quads.count; i++) {
            const axisDir = quads.axisDir[i]!;
            if ((axisDir & 0x3) !== 1 || ((axisDir >> 2) & 1) !== 0) continue; // up-facing Y quads only
            // Axis-Y quad: in-plane u = Z carries w, v = X carries h (buildHintMesh axes).
            const x0 = originX + quads.gx[i]! * s;
            const x1 = x0 + quads.h[i]! * s;
            const z0 = originZ + quads.gz[i]! * s;
            const z1 = z0 + quads.w[i]! * s;
            const y = originY + (quads.gy[i]! + 1) * s; // +dir face sits on the far side
            const colorIdx = quads.colorIdx[i]!;

            const gx0 = Math.max(0, Math.floor((x0 - minX) / mask.cellSize));
            const gx1 = Math.min(mask.width - 1, Math.ceil((x1 - minX) / mask.cellSize) - 1);
            const gz0 = Math.max(0, Math.floor((z0 - minZ) / mask.cellSize));
            const gz1 = Math.min(mask.height - 1, Math.ceil((z1 - minZ) / mask.cellSize) - 1);
            for (let gz = gz0; gz <= gz1; gz++) {
                for (let gx = gx0; gx <= gx1; gx++) {
                    const idx = gz * mask.width + gx;
                    const maskQ = mask.topY[idx]!;
                    if (maskQ === 0) continue; // untyped cell — nothing will spawn anyway
                    const maskY = maskQ * GROUND_MASK_HEIGHT_STEP;
                    const prev = out.get(idx);
                    if (!prev || Math.abs(y - maskY) < Math.abs(prev.y - maskY)) {
                        out.set(idx, { y, colorIdx });
                    }
                }
            }
        }
    }
    return out;
}

/**
 * Plan one column-chunk's detail instances from the mask + its collected
 * surfaces. Deterministic for a given seed. Pure — exported for tests.
 */
export function planColumnDetail(
    world: DecodedVxlSceneWorld,
    mask: GroundMaskData,
    colCx: number,
    colCz: number,
    opts: GroundDetailOptions,
): { instances: DetailInstance[]; stonesDropped: number; coverDropped: number } {
    const chunkSize = world.chunkSize;
    const cell = mask.cellSize;
    const { minX, minZ } = world.bounds;
    const surfaces = collectColumnSurfaces(world, mask, colCx, colCz);
    const instances: DetailInstance[] = [];

    const colX0 = colCx * chunkSize;
    const colZ0 = colCz * chunkSize;
    const gx0 = Math.max(0, Math.floor((colX0 - minX) / cell));
    const gx1 = Math.min(mask.width - 1, Math.floor((colX0 + chunkSize - 1e-6 - minX) / cell));
    const gz0 = Math.max(0, Math.floor((colZ0 - minZ) / cell));
    const gz1 = Math.min(mask.height - 1, Math.floor((colZ0 + chunkSize - 1e-6 - minZ) / cell));

    let stones = 0, cover = 0, stonesDropped = 0, coverDropped = 0;

    for (let gz = gz0; gz <= gz1; gz++) {
        for (let gx = gx0; gx <= gx1; gx++) {
            const idx = gz * mask.width + gx;
            const type = mask.types[idx]!;
            if (type === GROUND_TYPE.none) continue;
            const surf = surfaces.get(idx);
            if (!surf) continue;
            const maskY = mask.topY[idx]! * GROUND_MASK_HEIGHT_STEP;
            // Occupancy guard: the visible top here is NOT the typed ground
            // (building roof, bridge deck) — spawn nothing.
            if (Math.abs(surf.y - maskY) > opts.matchTolerance) continue;

            const cx = minX + (gx + 0.5) * cell;
            const cz = minZ + (gz + 0.5) * cell;
            const base = atlasCellRepr(surf.colorIdx);
            const jit = 0.88 + hash01(gx, gz, opts.seed ^ 0x51ed) * 0.24;
            const { r, g, b } = tint(base, jit);

            if (isStoneDetail(type)) {
                if (stones >= opts.maxStonesPerChunk) { stonesDropped++; continue; }
                if (type === GROUND_TYPE.cobble) {
                    instances.push({
                        kind: 'dome', x: cx, y: surf.y, z: cz,
                        yaw: hash01(gx, gz, opts.seed) * Math.PI * 2,
                        scale: cell * (0.92 + hash01(gx, gz, opts.seed ^ 0xa1) * 0.12),
                        r, g, b,
                    });
                    stones++;
                } else {
                    // Brick: two half-cell bricks per cell, running bond along the road.
                    const yaw = maskDirectionYaw(mask, gx, gz);
                    const ux = Math.cos(yaw), uz = Math.sin(yaw);   // along-road
                    const px = -uz, pz = ux;                        // across-road
                    const alongPhase = ((gx + gz) % 2) * 0.25 * cell; // offset alternate courses
                    for (const side of [-1, 1]) {
                        if (stones >= opts.maxStonesPerChunk) { stonesDropped++; continue; }
                        const off = side * 0.24 * cell;
                        instances.push({
                            kind: 'brick',
                            x: cx + px * off + ux * alongPhase,
                            y: surf.y,
                            z: cz + pz * off + uz * alongPhase,
                            yaw: -yaw,
                            scale: cell,
                            r, g, b,
                        });
                        stones++;
                    }
                }
                continue;
            }

            const gDensity = grassDensity(type);
            if (gDensity > 0) {
                // Tufts this cell wants: the type's own density (lush > cut) times the
                // game's cover multiplier. At density 1 this is ~half a tuft per cell —
                // the original city-park sprinkle — and it scales up from there into a
                // meadow with real volume. Fractional part is a hashed coin flip, so
                // the field thickens smoothly instead of in visible steps.
                const want = gDensity * 0.5 * opts.density;
                let count = Math.floor(want);
                if (hash01(gx, gz, opts.seed ^ 0x77aa) < want - count) count++;
                const heightScale = grassHeightScale(type) * opts.scale;
                for (let k = 0; k < count; k++) {
                    if (cover >= opts.maxCoverPerChunk) { coverDropped++; break; }
                    // Salt every roll with the tuft index so clumps in one cell differ.
                    const salt = opts.seed ^ (k * 0x9e37);
                    const flower = type !== GROUND_TYPE.grassDry && hash01(gx, gz, salt ^ 0x1234) < 0.07;
                    instances.push({
                        kind: flower ? 'flower' : 'tuft',
                        x: cx + (hash01(gx, gz, salt ^ 0x9) - 0.5) * cell * 0.9,
                        y: surf.y,
                        z: cz + (hash01(gx, gz, salt ^ 0xb) - 0.5) * cell * 0.9,
                        yaw: hash01(gx, gz, salt ^ 0xd) * Math.PI * 2,
                        scale: (0.75 + hash01(gx, gz, salt ^ 0xf) * 0.5) * heightScale,
                        r, g, b,
                        thin: hash01(gx, gz, salt ^ 0x7f1),
                    });
                    cover++;
                }
            } else if (hasPebbles(type)) {
                if (hash01(gx, gz, opts.seed ^ 0x3c) > 0.12) continue;
                if (cover >= opts.maxCoverPerChunk) { coverDropped++; continue; }
                instances.push({
                    kind: 'pebble', x: cx, y: surf.y, z: cz,
                    yaw: hash01(gx, gz, opts.seed ^ 0x5e) * Math.PI * 2,
                    scale: 0.6 + hash01(gx, gz, opts.seed ^ 0x71) * 0.8,
                    ...tint(base, 0.9),
                });
                cover++;
            }
        }
    }
    return { instances, stonesDropped, coverDropped };
}

/** One built InstancedMesh of a column plus what band changes and buffer reuse need to know. */
interface ColumnMesh {
    kind: DetailInstance['kind'];
    mesh: THREE.InstancedMesh;
    /** Allocated instance capacity of the buffers — a rebuild whose plan fits
     *  rewrites them in place instead of allocating a new mesh. */
    capacity: number;
    /** Live instances of the current plan (≤ capacity; mesh.count may draw a prefix of these). */
    fullCount: number;
    /** True for grass cover (tuft/flower): sorted by `thin`, so a density band
     *  draws the first `fullCount × factor` instances. Stones always draw all. */
    thinnable: boolean;
}

interface ColumnEntry {
    key: string;
    cx: number;
    cz: number;
    centerX: number;
    centerZ: number;
    built: boolean;
    /** Mask changed under this built column — re-plan once the cooldown allows. */
    dirty: boolean;
    /** When this column last (re)built, in performance.now() ms. */
    lastBuildMs: number;
    /** Density band currently applied to the meshes (see DENSITY_BAND_FACTORS). */
    band: number;
    meshes: ColumnMesh[];
}

const UP = new THREE.Vector3(0, 1, 0);

/** Scratch objects for `fillMesh` — instance composition runs in the hundreds of
 *  thousands, so the per-instance transform state is allocated once, not per call. */
const SCRATCH_MATRIX = new THREE.Matrix4();
const SCRATCH_QUAT = new THREE.Quaternion();
const SCRATCH_POS = new THREE.Vector3();
const SCRATCH_SCALE = new THREE.Vector3();
const SCRATCH_COLOR = new THREE.Color();

export class GroundDetailSystem {
    private readonly world: DecodedVxlSceneWorld;
    private readonly mask: GroundMaskData;
    private readonly opts: GroundDetailOptions;
    private readonly parent: THREE.Object3D;
    private readonly group: THREE.Group;
    private readonly columns: ColumnEntry[] = [];
    private readonly geometries = new Map<DetailInstance['kind'], THREE.BufferGeometry>();
    private material: THREE.MeshLambertMaterial | null = null;
    /** DoubleSide variant for the quad-based cover (tufts, flower stems) —
     *  single planes need both faces; the stone kinds stay front-side only. */
    private coverMaterial: THREE.Material | null = null;
    private coverHandle: FoliageMaterialHandle | null = null;
    readonly appearance: FoliageAppearance;
    private warnedBudget = false;
    /**
     * Retired column meshes, kept for reuse (per kind).
     *
     * An InstancedMesh under the uniform-buffer limit (~1024 instances) has its
     * matrices declared IN the generated WGSL as `array<mat4x4<f32>, N>`, where
     * N is the instance count (three's `createInstanceMatrixNode` +
     * WGSLNodeBuilder.getType). So two columns differing only in how many tufts
     * they planted are two different shader SOURCES, and the driver compiles
     * each from scratch. Each column plans an organic count, so building a mesh
     * per column entering the ring and disposing it on exit meant a fresh cold
     * compile for nearly every column — a continuous stutter across the whole
     * first visit of a level (~700 pipeline creations in one race, measured),
     * which every RELOAD hides because the browser's on-disk shader cache
     * already holds those exact texts. That is why it never showed in testing.
     *
     * Pooling + power-of-two capacities (see buildColumn) collapse the whole
     * world onto a handful of count classes, so once the spawn ring has
     * compiled under the load fade, ground detail never compiles again.
     */
    private readonly meshPool = new Map<DetailInstance['kind'], ColumnMesh[]>();

    constructor(world: DecodedVxlSceneWorld, parent: THREE.Object3D, opts: GroundDetailOptions) {
        if (!world.groundMask) throw new Error('[GroundDetail] world has no ground mask');
        this.appearance = { ...DEFAULT_FOLIAGE_APPEARANCE, ...opts.appearance };
        this.world = world;
        this.mask = world.groundMask;
        this.opts = opts;
        this.parent = parent;
        this.group = new THREE.Group();
        this.group.name = 'GroundDetail';
        this.parent.add(this.group);

        // Candidate columns = distinct (cx, cz) of existing chunks (detail can
        // only stand on baked geometry, so empty columns need no entry).
        const seen = new Set<string>();
        for (const chunk of world.chunks) {
            const key = `${chunk.cx},${chunk.cz}`;
            if (seen.has(key)) continue;
            seen.add(key);
            this.columns.push({
                key,
                cx: chunk.cx,
                cz: chunk.cz,
                centerX: (chunk.cx + 0.5) * world.chunkSize,
                centerZ: (chunk.cz + 0.5) * world.chunkSize,
                built: false,
                dirty: false,
                lastBuildMs: -Infinity,
                band: 0,
                meshes: [],
            });
        }
    }

    /** Per-frame: build detail for columns entering the ring, drop it past the
     *  ring, rebuild dirty (mow-invalidated) columns whose cooldown elapsed, and
     *  re-apply the density band of built columns that crossed a band boundary
     *  (with margin — see DENSITY_BAND_HYSTERESIS_M). Builds AND rebuilds share
     *  the per-update budget; band changes are draw-count writes and free.
     *  (Named like VxlSceneRenderer.updateLod — it is camera-driven, not a dt tick.) */
    updateDetail(cameraWorldPos: THREE.Vector3): void {
        const nowMs = performance.now();
        const near2 = this.opts.detailDistance * this.opts.detailDistance;
        const farD = this.opts.detailDistance + this.opts.hysteresis;
        const far2 = farD * farD;
        let builds = 0;
        for (const col of this.columns) {
            const dx = cameraWorldPos.x - col.centerX;
            const dz = cameraWorldPos.z - col.centerZ;
            const d2 = dx * dx + dz * dz;
            if (!col.built && d2 < near2 && builds < this.opts.maxBuildsPerUpdate) {
                this.buildColumn(col, densityBandForDistance(Math.sqrt(d2)), nowMs);
                builds++;
            } else if (col.built && d2 > far2) {
                this.dropColumn(col);
            } else if (col.built) {
                const d = Math.sqrt(d2);
                const band = densityBandForDistance(d);
                const rebuildDue = col.dirty && builds < this.opts.maxBuildsPerUpdate
                    && nowMs - col.lastBuildMs >= this.opts.rebuildCooldownMs;
                if (rebuildDue) {
                    // Mow/terraform coalescing: re-plan from the CURRENT mask at
                    // most once per cooldown; the old cover kept drawing until now.
                    this.buildColumn(col, band, nowMs);
                    builds++;
                } else if (band !== col.band) {
                    // Confirm the crossing with margin: the new band must hold even
                    // when the distance is nudged back toward the old band.
                    const confirmed = band < col.band
                        ? densityBandForDistance(d + DENSITY_BAND_HYSTERESIS_M) === band
                        : densityBandForDistance(d - DENSITY_BAND_HYSTERESIS_M) === band;
                    // A band change is a draw-count write per mesh — no budget needed.
                    if (confirmed) this.applyBand(col, band);
                }
            }
        }
    }

    /**
     * Mark every built column overlapping a world-space XZ region DIRTY so a
     * coming `updateDetail` re-plans it from the CURRENT mask. Call after
     * mutating ground types (mowing, terraforming) — the mask is read at build
     * time, so without this the old cover keeps rendering until the camera leaves
     * and returns. Returns how many columns were newly marked.
     *
     * The rebuild is coalesced, not immediate: the old cover keeps drawing until
     * the column's `rebuildCooldownMs` has elapsed since its last build, so a
     * mower repainting the same column every frame costs a few rebuilds per
     * second instead of one per frame. (The per-frame drop+rebuild stacked
     * multi-ms re-plans plus buffer churn from four concurrent mowers and read
     * as rhythmic hitching.) A column whose last build is older than the
     * cooldown rebuilds on the very next update, so a fresh cut still appears
     * instantly. Rebuilds are also rate-limited by `maxBuildsPerUpdate`, so
     * invalidating a wide area repaints over a few frames rather than spiking one.
     */
    invalidateRegion(minX: number, minZ: number, maxX: number, maxZ: number): number {
        const chunk = this.world.chunkSize;
        let marked = 0;
        for (const col of this.columns) {
            // Unbuilt columns re-plan from the current mask on ring entry anyway.
            if (!col.built || col.dirty) continue;
            const x0 = col.cx * chunk, z0 = col.cz * chunk;
            if (x0 > maxX || x0 + chunk < minX || z0 > maxZ || z0 + chunk < minZ) continue;
            col.dirty = true;
            marked++;
        }
        return marked;
    }

    dispose(): void {
        for (const col of this.columns) this.dropColumn(col);
        // dropColumn parks meshes in the pool — this is the one place they die.
        for (const pool of this.meshPool.values()) {
            for (const cm of pool) {
                cm.mesh.dispose();
                if (cm.thinnable) cm.mesh.geometry.dispose();
            }
        }
        this.meshPool.clear();
        this.parent.remove(this.group);
        for (const geom of this.geometries.values()) geom.dispose();
        this.geometries.clear();
        this.material?.dispose();
        this.material = null;
        this.coverMaterial?.dispose();
        this.coverMaterial = null;
    }

    private buildColumn(col: ColumnEntry, band: number, nowMs: number): void {
        col.built = true; // even when the plan is empty — don't re-plan every frame
        col.dirty = false;
        col.lastBuildMs = nowMs;
        col.band = band;
        const plan = planColumnDetail(this.world, this.mask, col.cx, col.cz, this.opts);
        if ((plan.stonesDropped > 0 || plan.coverDropped > 0) && !this.warnedBudget) {
            this.warnedBudget = true;
            console.warn(
                `[GroundDetail] per-chunk budget hit (dropped ${plan.stonesDropped} stones, ` +
                `${plan.coverDropped} cover at column ${col.key}) — capped for perf; further drops not logged.`,
            );
        }

        const byKind = new Map<DetailInstance['kind'], DetailInstance[]>();
        for (const inst of plan.instances) {
            let list = byKind.get(inst.kind);
            if (!list) { list = []; byKind.set(inst.kind, list); }
            list.push(inst);
        }

        // Kinds the replan no longer produces (the mowed-away flowers): stop
        // drawing but KEEP the buffers — this is a rebuild path and dropping
        // GPU buffers on every mow stroke is exactly the churn to avoid.
        for (const cm of col.meshes) {
            if (!byKind.has(cm.kind)) {
                cm.fullCount = 0;
                cm.mesh.count = 0;
            }
        }

        for (const [kind, list] of byKind) {
            const thinnable = kind === 'tuft' || kind === 'flower';
            // Prefix-thinning order: smallest thinning key first, so every
            // density band's drawn set is the front of the buffer.
            if (thinnable) list.sort((a, b) => (a.thin ?? 0) - (b.thin ?? 0));
            const existingAt = col.meshes.findIndex((existing) => existing.kind === kind);
            let cm = existingAt >= 0 ? col.meshes[existingAt]! : undefined;
            if (cm && cm.capacity < list.length) {
                // Outgrown its buffers (regrowth) — park it and take a bigger one.
                this.retireMesh(cm);
                col.meshes.splice(existingAt, 1);
                cm = undefined;
            }
            if (!cm) {
                cm = this.takePooledMesh(kind, list.length) ?? undefined;
                if (cm) col.meshes.push(cm);
            }
            if (!cm) {
                const mat = thinnable ? this.sharedCoverMaterial() : this.sharedMaterial();
                // Capacity quantized to the next power of two. The instance
                // COUNT is baked into the generated WGSL — three's small-
                // instanced-mesh path declares the matrices as a uniform
                // `array<mat4x4<f32>, N>` (Instance.js), so every distinct
                // capacity is a distinct shader source the driver has never
                // compiled. Quantizing collapses all columns, levels and
                // sessions onto a handful of count classes; the rounding also
                // provides the headroom that raises pool hits and absorbs
                // regrowth without the outgrown-replace path.
                const capacity = Math.pow(2, Math.ceil(Math.log2(Math.max(list.length, 4))));
                // Cover owns small per-mesh geometries for its instance anchors/tints;
                // those buffers are reused with the pooled mesh, never on every mow.
                const geometry = thinnable ? this.geometry(kind).clone() : this.geometry(kind);
                const mesh = new THREE.InstancedMesh(geometry, mat, capacity);
                if (thinnable) geometry.setAttribute('foliageTint', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3));
                mesh.name = `GroundDetail_${kind}`;
                mesh.castShadow = false;    // ground-hugging detail: casting adds cost, not depth
                mesh.receiveShadow = true;
                this.group.add(mesh);
                cm = { kind, mesh, capacity, fullCount: list.length, thinnable };
                col.meshes.push(cm);
            }
            this.fillMesh(cm, list);
        }
        this.applyBand(col, band);
    }

    /** (Re)write a column mesh's instances from a plan list — matrices, colors,
     *  live count and culling bounds. The same path fills a fresh mesh and
     *  rewrites a reused one in place (list.length ≤ capacity, checked by the
     *  caller); reused buffers re-upload in full, which at the rebuild cadence
     *  is far cheaper than allocating fresh GPU buffers each time. */
    private fillMesh(cm: ColumnMesh, list: DetailInstance[]): void {
        const mesh = cm.mesh;
        // Stones keep their authored height; cover scales uniformly.
        const flatHeight = cm.kind === 'dome' || cm.kind === 'brick';
        for (let i = 0; i < list.length; i++) {
            const inst = list[i]!;
            SCRATCH_POS.set(inst.x, inst.y, inst.z);
            SCRATCH_QUAT.setFromAxisAngle(UP, inst.yaw);
            SCRATCH_SCALE.set(inst.scale, flatHeight ? 1 : inst.scale, inst.scale);
            SCRATCH_MATRIX.compose(SCRATCH_POS, SCRATCH_QUAT, SCRATCH_SCALE);
            mesh.setMatrixAt(i, SCRATCH_MATRIX);
            if (cm.thinnable) mesh.geometry.getAttribute('foliageTint').setXYZ(i, inst.r / 255, inst.g / 255, inst.b / 255);
            else mesh.setColorAt(i, SCRATCH_COLOR.setRGB(inst.r / 255, inst.g / 255, inst.b / 255));
        }
        cm.fullCount = list.length;
        // Pin culling bounds over the LIVE set now, count first — three's
        // computeBoundingSphere walks `count` instances, would otherwise lazily
        // compute from whatever band prefix happens to be drawn at first render,
        // and a later band upgrade would then draw outside them. Bands only ever
        // draw a prefix of these instances, and a reused buffer's stale tail
        // (beyond fullCount) is never drawn.
        mesh.count = list.length;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        if (cm.thinnable) {
            mesh.geometry.getAttribute('foliageTint').needsUpdate = true;
            prepareFoliageInstances(mesh, this.coverHandle!);
        } else mesh.computeBoundingSphere();
    }

    /** Apply a density band by drawing a prefix of each grass mesh's buffer —
     *  a per-mesh `count` write, cheap enough for no rate limit. */
    private applyBand(col: ColumnEntry, band: number): void {
        col.band = band;
        const factor = DENSITY_BAND_FACTORS[band] ?? DENSITY_BAND_FACTORS[DENSITY_BAND_FACTORS.length - 1]!;
        for (const cm of col.meshes) {
            if (!cm.thinnable) continue;
            cm.mesh.count = Math.round(cm.fullCount * factor);
        }
    }

    private dropColumn(col: ColumnEntry): void {
        for (const cm of col.meshes) this.retireMesh(cm);
        col.meshes = [];
        col.built = false;
        col.dirty = false;
    }

    /** Park a column mesh in the pool for reuse — see meshPool for why this
     *  must never dispose. The pool's high-water mark is the peak ring
     *  occupancy per kind, memory the ring itself already reached. */
    private retireMesh(cm: ColumnMesh): void {
        this.group.remove(cm.mesh);
        cm.mesh.count = 0; // parked meshes draw nothing even if referenced
        cm.fullCount = 0;
        let pool = this.meshPool.get(cm.kind);
        if (!pool) { pool = []; this.meshPool.set(cm.kind, pool); }
        pool.push(cm);
    }

    /** Best-fit pooled mesh for a kind (smallest capacity ≥ needed), or null. */
    private takePooledMesh(kind: DetailInstance['kind'], needed: number): ColumnMesh | null {
        const pool = this.meshPool.get(kind);
        if (!pool || pool.length === 0) return null;
        let best = -1;
        for (let i = 0; i < pool.length; i++) {
            const c = pool[i]!.capacity;
            if (c >= needed && (best < 0 || c < pool[best]!.capacity)) best = i;
        }
        if (best < 0) return null;
        const cm = pool.splice(best, 1)[0]!;
        this.group.add(cm.mesh);
        return cm;
    }

    /** White lambert tinted per instance (instanceColor) — one shared material. */
    private sharedMaterial(): THREE.MeshLambertMaterial {
        if (!this.material) this.material = new THREE.MeshLambertMaterial({ color: 0xffffff });
        return this.material;
    }

    /** Lit, rooted foliage; one material for both kinds and every pooled column. */
    private sharedCoverMaterial(): THREE.Material {
        if (!this.coverMaterial) {
            this.coverHandle = createFoliageMaterial({ appearance: this.appearance, block: true, map: null, selectiveTint: true });
            this.coverMaterial = this.coverHandle.material;
        }
        return this.coverMaterial;
    }

    private geometry(kind: DetailInstance['kind']): THREE.BufferGeometry {
        let geom = this.geometries.get(kind);
        if (geom) return geom;
        switch (kind) {
            case 'dome':
                // Unit-diameter squashed dome: one cobblestone per mask cell.
                geom = new THREE.SphereGeometry(0.5, 6, 3, 0, Math.PI * 2, 0, Math.PI / 2);
                geom.scale(1, 0.3, 1);
                break;
            case 'brick':
                // Half-cell brick (scaled by cell size per instance).
                geom = new THREE.BoxGeometry(0.46, 0.09, 0.22);
                geom.translate(0, 0.02, 0); // proud of the surface, slightly embedded
                break;
            case 'tuft':
                geom = createGroundCoverTuft();
                break;
            case 'flower':
                geom = createGroundCoverFlower();
                break;
            case 'pebble':
                geom = new THREE.BoxGeometry(0.22, 0.08, 0.18);
                geom.translate(0, 0.03, 0);
                break;
        }
        this.geometries.set(kind, geom);
        return geom;
    }
}
