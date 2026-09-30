/**
 * BuildingSystem — engine-side builder for `worldProfileData.hotspots[]`
 * entries of type `building`: the parametric ENTERABLE structure (hollow
 * shell, guaranteed doorways, optional windows, flat/none roof).
 *
 * Buildings are constructed as self-contained `VoxelObject`s (own floor slab,
 * merged-box colliders, atlas-textured blocks), NOT painted into the terrain.
 * That makes them work identically on EVERY terrain backend — procedurally
 * generated worlds AND baked `.vxl`/VxlScene levels (forged cities), whose
 * grids are render-immutable at runtime. It also means construction lives in
 * the ENGINE (like `MechanismSystem`), so per-game WorldGenerator copies never
 * need migrating; the legacy hotspot interpreter for `building` is an inert
 * stub kept only so old registries don't throw.
 *
 * Geometry model (axis-aligned, 1-block walls, sides in world axes:
 * north = max Z wall, south = min Z, east = max X, west = min X):
 *   - `size` is the INTERIOR clear footprint; walls sit one cell outside it.
 *   - The object carries its own floor slab one cell below the walls, placed
 *     so the slab's top sits at the sampled ground height (median of the four
 *     outer corners) — no terrain carving needed.
 *   - Doorways/windows are cells simply left unbuilt; corners never open, and
 *     a building with no doors is never built (auto south door + warning).
 */

import * as THREE from 'three';
import type { EngineLike, BuildingHotspot, BuildingOpening } from 'types/game.js';
import { VoxelObject } from 'engine/VoxelObject.js';
import { CollisionGroup } from 'engine/CollisionLayers.js';
import { BlockType, type BlockTypeId } from 'engine/VoxelTextureAtlas.js';

/**
 * Baked (.vxl/VxlScene) levels never register block NAMES with the texture
 * atlas, so name resolution fails there — build from palette-colored voxels
 * instead (BlockType.COLOR + RGB24, the same mechanism VXL assets use). The
 * map covers the block names buildings commonly ask for.
 */
const BLOCK_NAME_COLORS: Record<string, number> = {
  STONE: 0x8f8f8f,
  BRICK: 0x9c4a32,
  WOOD: 0x8a6a42,
  MARBLE: 0xdedad2,
  SAND: 0xd8c98a,
  ASPHALT: 0x4a4a4a,
};

const DOOR_DEFAULT_WIDTH_M = 2;
const DOOR_DEFAULT_HEIGHT_M = 2.5;
const WINDOW_DEFAULT_WIDTH_M = 1.5;
const WINDOW_DEFAULT_HEIGHT_M = 1;
const WINDOW_DEFAULT_SILL_M = 1;
const DEFAULT_WALL_HEIGHT_M = 3;

type Side = BuildingOpening['side'];

/** One opening rasterized to wall-cell space: along-wall cell range + vertical cell range (wall rows, 0-based). */
interface OpeningCells {
  side: Side;
  alongMin: number;
  alongMax: number; // inclusive
  hMin: number;
  hMax: number; // inclusive
}

/** One cell of the building shell in the object's voxel grid (h=0 is the floor slab row). */
export interface ShellCell {
  i: number;
  h: number;
  k: number;
  part: 'floor' | 'wall' | 'roof';
}

export interface RasterizedShell {
  /** Outer footprint in cells (walls included). */
  ox: number;
  oz: number;
  /** Wall rows above the floor slab. */
  hCells: number;
  cells: ShellCell[];
  /** True when the spec declared no doors and a south door was auto-added. */
  autoDoor: boolean;
}

/**
 * Pure shell rasterization — exported for tests. Cell grid: i along +X
 * (0..ox-1), k along +Z (0..oz-1), h up with h=0 the floor slab, walls at
 * h=1..hCells, roof (when not 'none') at h=hCells+1.
 */
export function rasterizeBuildingShell(spec: BuildingHotspot, bs: number): RasterizedShell {
  const ix = Math.max(2, Math.ceil(spec.size.x / bs));
  const iz = Math.max(2, Math.ceil(spec.size.z / bs));
  const ox = ix + 2;
  const oz = iz + 2;
  const hCells = Math.max(2, Math.round((spec.wallHeight ?? DEFAULT_WALL_HEIGHT_M) / bs));

  const autoDoor = !spec.doors || spec.doors.length === 0;
  const doors: BuildingOpening[] = autoDoor ? [{ side: 'south' }] : spec.doors ?? [];
  const openings: OpeningCells[] = [
    ...doors.map(d => rasterizeOpening(d, ix, iz, bs, hCells, {
      width: DOOR_DEFAULT_WIDTH_M, height: DOOR_DEFAULT_HEIGHT_M, sill: 0,
    })),
    ...(spec.windows ?? []).map(w => rasterizeOpening(w, ix, iz, bs, hCells, {
      width: WINDOW_DEFAULT_WIDTH_M, height: WINDOW_DEFAULT_HEIGHT_M, sill: w.sillY ?? WINDOW_DEFAULT_SILL_M,
    })),
  ];

  const cells: ShellCell[] = [];
  const roofed = (spec.roof ?? 'flat') !== 'none';
  for (let i = 0; i < ox; i++) {
    for (let k = 0; k < oz; k++) {
      cells.push({ i, h: 0, k, part: 'floor' });
      if (roofed) cells.push({ i, h: hCells + 1, k, part: 'roof' });
      const isPerimeter = i === 0 || i === ox - 1 || k === 0 || k === oz - 1;
      if (!isPerimeter) continue;
      const side = sideOfCell(i, k, ox, oz);
      const along = side === 'north' || side === 'south' ? i : k;
      for (let h = 0; h < hCells; h++) {
        if (side && isOpen(openings, side, along, h)) continue;
        cells.push({ i, h: h + 1, k, part: 'wall' });
      }
    }
  }
  return { ox, oz, hCells, cells, autoDoor };
}

/**
 * Convert one opening spec to wall-cell ranges. `along` counts cells in the
 * OUTER grid axis the wall runs on (x-index for north/south, z-index for
 * east/west); corners (cells 0 and last) are never opened so walls stay
 * connected. Vertical range is in wall rows (0 = the row on the floor).
 */
function rasterizeOpening(
  o: BuildingOpening,
  ix: number,
  iz: number,
  bs: number,
  hCells: number,
  defaults: { width: number; height: number; sill: number },
): OpeningCells {
  const wallCells = o.side === 'north' || o.side === 'south' ? ix : iz;
  const widthCells = Math.max(1, Math.round((o.width ?? defaults.width) / bs));
  const offsetCells = Math.round((o.offset ?? 0) / bs);
  // Wall interior cells run 1..wallCells in outer-grid indices.
  const centerIdx = 1 + (wallCells - 1) / 2 + offsetCells;
  let alongMin = Math.round(centerIdx - (widthCells - 1) / 2);
  let alongMax = alongMin + widthCells - 1;
  alongMin = Math.max(1, alongMin);
  alongMax = Math.min(wallCells, alongMax);

  const sillCells = Math.max(0, Math.round(defaults.sill / bs));
  const heightCells = Math.max(1, Math.round((o.height ?? defaults.height) / bs));
  const hMin = Math.min(sillCells, hCells - 1);
  const hMax = Math.min(hMin + heightCells - 1, hCells - 1);
  return { side: o.side, alongMin, alongMax, hMin, hMax };
}

/** Which wall a perimeter cell belongs to; corners resolve to north/south so `along` uses the x index. */
function sideOfCell(i: number, k: number, ox: number, oz: number): Side | null {
  if (k === oz - 1) return 'north';
  if (k === 0) return 'south';
  if (i === ox - 1) return 'east';
  if (i === 0) return 'west';
  return null;
}

function isOpen(openings: OpeningCells[], side: Side, along: number, h: number): boolean {
  for (const o of openings) {
    if (o.side !== side) continue;
    if (along >= o.alongMin && along <= o.alongMax && h >= o.hMin && h <= o.hMax) return true;
  }
  return false;
}

interface HotspotsCarrier {
  hotspots?: Array<{ id?: unknown; type?: unknown }>;
}

export class BuildingSystem {
  private readonly engine: EngineLike;
  private built = false;
  private attempts = 0;
  private readonly objects: VoxelObject[] = [];

  constructor(engine: EngineLike) {
    this.engine = engine;
  }

  /** Lazily builds once the terrain answers ground probes; no per-frame work after that. */
  update(): void {
    if (!this.built) this.tryBuild();
  }

  dispose(): void {
    for (const obj of this.objects) {
      obj.parent?.remove(obj);
      obj.dispose();
    }
    this.objects.length = 0;
    this.built = true; // never rebuild after teardown
  }

  private specs(): BuildingHotspot[] {
    const wp = this.engine.getGameData?.()?.worldProfileData as HotspotsCarrier | undefined;
    const hotspots = Array.isArray(wp?.hotspots) ? wp.hotspots : [];
    return hotspots.filter((h): h is BuildingHotspot =>
      !!h && typeof h === 'object' && (h as { type?: unknown }).type === 'building');
  }

  private groundProbe(x: number, z: number): number | null {
    const pw = this.engine.physicsWorld;
    if (!pw) return null;
    const result = pw.raycast(new THREE.Vector3(x, 500, z), new THREE.Vector3(0, -1, 0), 600, CollisionGroup.TERRAIN | CollisionGroup.ENVIRONMENT);
    return result.hasHit ? result.hitPoint.y : null;
  }

  private tryBuild(): void {
    const specs = this.specs();
    if (specs.length === 0) {
      this.built = true;
      return;
    }
    const first = specs[0]!;
    if (this.groundProbe(first.center.x, first.center.z) === null) {
      if (++this.attempts < 600) return;
      console.warn('[BuildingSystem] ground never became queryable; building at y=0');
    }
    for (const spec of specs) {
      try {
        this.buildOne(spec);
      } catch (err) {
        console.error(`[BuildingSystem] failed to build building "${spec.id}":`, err);
      }
    }
    this.built = true;
  }

  /**
   * Voxel fill for a block name: a real atlas block id when the world has the
   * name registered (procedural terrains), else a palette-colored voxel
   * (baked levels — see BLOCK_NAME_COLORS).
   */
  private blockFor(name: string | undefined, dimBy = 1): { id: BlockTypeId; color?: number } {
    const wanted = (name ?? 'STONE').toUpperCase();
    const resolved = this.engine.blocks.resolve(wanted).id;
    if (resolved !== undefined && resolved > 0) return { id: resolved as BlockTypeId };
    const base = BLOCK_NAME_COLORS[wanted] ?? BLOCK_NAME_COLORS.STONE!;
    const c = new THREE.Color(base).multiplyScalar(dimBy);
    return { id: BlockType.COLOR, color: c.getHex() };
  }

  private buildOne(spec: BuildingHotspot): void {
    const scene = this.engine.scene;
    if (!scene) return;
    const wp = this.engine.getGameData?.()?.worldProfileData as { voxelBlockSize?: number } | undefined;
    const bs = typeof wp?.voxelBlockSize === 'number' && wp.voxelBlockSize > 0 ? wp.voxelBlockSize : 1;

    const shell = rasterizeBuildingShell(spec, bs);
    if (shell.autoDoor) {
      console.warn(
        `[BuildingSystem] building id="${spec.id}" declared no doors — added a centered south ` +
        `doorway so it is enterable. Declare doors[] to control placement.`,
      );
    }

    // Floor height: median of the four OUTER corner ground heights — a
    // constructed-pad look without floating the shell on the highest corner.
    const hw = (shell.ox * bs) / 2;
    const hd = (shell.oz * bs) / 2;
    const corners = [
      this.groundProbe(spec.center.x - hw, spec.center.z - hd),
      this.groundProbe(spec.center.x + hw, spec.center.z - hd),
      this.groundProbe(spec.center.x - hw, spec.center.z + hd),
      this.groundProbe(spec.center.x + hw, spec.center.z + hd),
    ].map(v => v ?? 0).sort((a, b) => a - b);
    const floorY = ((corners[1] ?? 0) + (corners[2] ?? 0)) / 2;

    const wall = this.blockFor(spec.wallBlockType);
    const roof = spec.roofBlockType ? this.blockFor(spec.roofBlockType) : this.blockFor(spec.wallBlockType, 0.8);
    const floor = this.blockFor(spec.foundationBlockType, 0.7);

    const obj = new VoxelObject({ voxelSize: bs, useAtlas: true, shadows: true });
    obj.name = spec.id;
    for (const c of shell.cells) {
      const b = c.part === 'wall' ? wall : c.part === 'roof' ? roof : floor;
      obj.setVoxel(c.i, c.h, c.k, b.id, b.color);
    }
    obj.finalize();

    // VoxelObject pivot = X/Z bounds center, Y bottom. Place the slab TOP at
    // the sampled ground height (object bottom one cell below it).
    obj.position.set(spec.center.x, floorY - bs, spec.center.z);
    Object.assign(obj.userData, { source: 'data:hotspots', buildingId: spec.id, building: 'building' });

    scene.add(obj);
    if (this.engine.physicsWorld) {
      obj.createPhysicsBody(this.engine.physicsWorld);
    }
    this.objects.push(obj);

    // Remove the terrain surface voxel directly beneath this building's own
    // floor slab. The slab's top sits AT floorY (the sampled ground height), so
    // on flat terrain it is coplanar with the terrain surface — two opaque
    // faces at the same depth z-fight, and both get shaded (double floor
    // overdraw). Carving the coincident terrain block leaves the building floor
    // as the sole surface: no z-fight, and the floor is shaded once. Guarded
    // per-column (solid at floorY AND air just above) so it only ever removes a
    // genuine surface block at the slab height — sloped terrain the pad floats
    // over, and baked levels (no grid), are left untouched.
    this.carveTerrainUnderFloor(spec.center.x, spec.center.z, shell.ox, shell.oz, bs, floorY);

    console.log(`[BuildingSystem] built "${spec.id}" (${shell.ox}x${shell.oz}x${shell.hCells + 2} cells) at (${spec.center.x.toFixed(1)}, ${floorY.toFixed(2)}, ${spec.center.z.toFixed(1)})`);
  }

  /**
   * Clear the terrain surface voxel coincident with a building's floor slab
   * across its footprint, so the slab is the only floor there. World-coordinate
   * `setBlock` invalidates height caches and coalesces the chunk rebuild to a
   * single microtask across the whole build burst. No-op without a chunk-grid
   * terrain (baked `.vwld` levels return null here).
   */
  private carveTerrainUnderFloor(centerX: number, centerZ: number, ox: number, oz: number, bs: number, floorY: number): void {
    const terrain = this.engine.getDynamicObjectManager?.().getMainVoxelWorld();
    if (!terrain) return;
    const half = bs * 0.5;
    const x0 = centerX - (ox * bs) / 2 + half;
    const z0 = centerZ - (oz * bs) / 2 + half;
    const yInSlab = floorY - half;   // sample inside the surface block [floorY-bs, floorY]
    const yAbove = floorY + half;    // sample the block that would sit above it
    for (let i = 0; i < ox; i++) {
      const x = x0 + i * bs;
      for (let k = 0; k < oz; k++) {
        const z = z0 + k * bs;
        // Only carve a genuine terrain surface block sitting exactly at the slab
        // height: solid at the slab row, air above. Skips walls of higher
        // terrain (slopes) and columns already at/below the slab.
        if (terrain.getBlock(x, yInSlab, z) !== BlockType.NONE && terrain.getBlock(x, yAbove, z) === BlockType.NONE) {
          terrain.setBlock(x, yInSlab, z, BlockType.NONE);
        }
      }
    }
  }
}
