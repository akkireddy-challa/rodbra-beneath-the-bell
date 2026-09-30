/**
 * HotspotInterpreter — pluggable structure spawners that the WorldGenerator
 * runs after terrain generation. Each interpreter expands one hotspot from
 * `worldProfileData.hotspots[]` into:
 *   1. Carved flat foundations under any buildings (via `flattenArea`).
 *   2. Injected `environmentObject` entries that the standard scenery loader
 *      picks up (via `pushEnvironmentObject`).
 *
 * Salvaged from `stash@{1}` ("2step system") with the listed anti-patterns
 * cleaned up:
 *   - Hardcoded block-type dicts on the context → use `resolveBlockByName()`
 *     resolver function (mirrors the resolver in `WorldGenerator.ts`).
 *   - Per-system unseeded PRNGs → context carries a single seeded RNG, so two
 *     interpreters running on the same hotspot produce reproducible output.
 *   - Silent `applyAll` error swallowing → throws + aborts. Half-rendered
 *     levels are worse than no rendering: the agent gets no feedback when an
 *     interpreter is failing.
 *   - Magic-number layout constants → hoisted to typed config on each hotspot
 *     shape (`density`, `foundationBlockType`, …).
 *
 * Critical interpreter rule: **buildings carve their foundation FIRST**, via
 * `withFlatFoundation()`. Painting building voxels via direct `getHeightAt`
 * lookups is the broken case Phase 0 was added to prevent — a tower placed
 * from a fixed origin on a slope clips into the hill on one side and floats
 * over it on the other.
 */

import type { Hotspot } from 'types/game.js';

/**
 * Single env-object entry that an interpreter can push back into the world.
 * Mirrors the schema accepted by `EnvironmentObjectSystem.loadSceneryFromWorldJson`
 * — the engine reads the same shape from `world.json`.
 */
export interface InjectedEnvironmentObject {
  /** Optional id; the interpreter MUST provide a stable, unique value to keep reloads idempotent. */
  id: string;
  /** Type tag (e.g., `'voxelBuilding'`, `'voxelTower'`). */
  type: string;
  /** Asset reference. MUST match an asset in `worldData.assets`. */
  assetId: string;
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
  /** Display label for grouping in the scene editor. */
  name?: string;
  /** Phase 0 mode B — engine carves a flat lot the size of the asset bbox. Recommended for buildings/towers. */
  flattenTerrain?: boolean;
  /** Phase 0 mode A — engine snaps Y to terrain surface. Use for trees / decor inside a hotspot region. */
  placeOnTerrain?: boolean;
}

/**
 * Asset metadata visible to interpreters. The interpreter reads
 * `naturalDimensions` (preferred) or `boundingBox * voxelSize` to compute
 * a building's footprint before carving the foundation.
 */
export interface HotspotAsset {
  id: string;
  name?: string;
  type?: string;
  voxelSize?: number;
  boundingBox?: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
  naturalDimensions?: { x: number; y: number; z: number };
}

/**
 * Context passed to every interpreter. Decouples interpreters from the
 * concrete `WorldGenerator` so they can be unit-tested in isolation with
 * a stub context.
 */
export interface HotspotContext {
  /** Carve a flat lot. Mirrors `WorldGenerator.flattenArea`. */
  flattenArea(
    centerX: number,
    centerZ: number,
    width: number,
    depth: number,
    height: number,
    blockType?: number,
    rebuildMeshes?: boolean,
    margin?: number,
  ): void;
  /** Read the local terrain surface Y. Mirrors `VoxelTerrainSystem.getHeightAt`. */
  getHeightAt(x: number, z: number): number;
  /** Resolve a block-type name to its registered numeric id (`'STONE'` → number). Returns undefined for unknown names. */
  resolveBlockByName(name: string): number | undefined;
  /** Push an env-object spec into the world. The standard scenery loader will then create the runtime instance. */
  pushEnvironmentObject(envObj: InjectedEnvironmentObject): void;
  /** All assets visible to the world. Interpreters look up dimensions by id. */
  assets: HotspotAsset[];
  /** Single seeded RNG shared by all interpreters in this run. Functions returns a value in [0, 1). */
  rng: () => number;
  /**
   * Set one terrain voxel at WORLD coordinates (floored into the voxel grid;
   * rebuilds are deferred via dirty-chunk marking, so bulk writes are cheap).
   * Optional for backward compatibility with per-game WorldGenerator copies
   * that predate it — interpreters that need it (BuildingInterpreter) throw a
   * clear error when absent. Mirrors `WorldGenerator.setTerrainBlock`.
   */
  setBlock?(x: number, y: number, z: number, blockType: number): void;
  /** Terrain voxel size in meters (same value `flattenArea` snaps to). Optional; default 1. */
  blockSize?: number;
}

/**
 * Compute an asset's natural footprint + height in METERS. Resolution order:
 *   1. `naturalDimensions` (authoritative).
 *   2. `boundingBox * voxelSize` (VXL convention: bbox is voxel-count).
 *   3. `boundingBox` as-is (legacy GLB).
 *   4. 1m cube fallback.
 *
 * Same logic as the agent-side `building-asset-matcher.assetDimensionsMeters`,
 * duplicated here because the engine and game-play-agent are separate projects
 * with no shared module. Keep in sync if the convention changes.
 */
export function assetDimensionsMeters(asset: HotspotAsset): { x: number; y: number; z: number } {
  if (asset.naturalDimensions) {
    return {
      x: Math.max(0.1, asset.naturalDimensions.x),
      y: Math.max(0.1, asset.naturalDimensions.y),
      z: Math.max(0.1, asset.naturalDimensions.z),
    };
  }
  const bb = asset.boundingBox;
  if (!bb) return { x: 1, y: 1, z: 1 };
  const dx = bb.maxX - bb.minX;
  const dy = bb.maxY - bb.minY;
  const dz = bb.maxZ - bb.minZ;
  const vs = asset.voxelSize;
  const useVoxelScale = typeof vs === 'number' && vs > 0 && vs < 5;
  const scale = useVoxelScale ? vs : 1;
  return {
    x: Math.max(0.1, dx * scale),
    y: Math.max(0.1, dy * scale),
    z: Math.max(0.1, dz * scale),
  };
}

/**
 * Base class for hotspot interpreters. Concrete interpreters MUST go through
 * `withFlatFoundation()` for any building footprint — direct calls to
 * `getHeightAt` for picking building Y are forbidden by convention (no
 * compile-time enforcement, but the helper makes the right thing the easy
 * thing). Foliage / decor that should follow the slope can use `getHeightAt`
 * via `placeOnTerrain: true` on the injected env-object instead.
 */
export abstract class HotspotInterpreterBase<T extends Hotspot = Hotspot> {
  abstract readonly type: T['type'];

  /**
   * Whether this interpreter may run when the terrain was LOADED from a baked
   * .vxl/.vwld file (forged levels, uploaded worlds) rather than generated.
   * The loaded grid is physically writable (runtime mining edits it), so this
   * is a POLICY flag: constructive interpreters that only add structure
   * (BuildingInterpreter) opt in; interpreters that reshape the authored
   * ground for their own layout (village lots) stay generation-only.
   */
  readonly worksOnVxlTerrain: boolean = false;

  abstract apply(ctx: HotspotContext, hotspot: T): void;

  /**
   * Carve a flat lot at the local terrain median height under (centerX, centerZ),
   * sized to (`width` × `depth`) plus an optional `margin` of extra voxels.
   * Returns the resulting flat Y, ready to be used as `position.y` for any
   * building placed on that lot.
   *
   * Foundation block defaults to `STONE`. Pass `foundationBlockType` (a string
   * name like `'asphalt'` / `'grass'` / `'marble'` / a registered custom block)
   * to override; falls back to `STONE` if the name doesn't resolve.
   */
  protected withFlatFoundation(
    ctx: HotspotContext,
    centerX: number,
    centerZ: number,
    width: number,
    depth: number,
    margin: number,
    foundationBlockType?: string,
  ): number {
    // Median of corner heights — produces a constructed-pad look without
    // floating the building above the original surface (which `max` would do).
    const y00 = ctx.getHeightAt(centerX - width / 2, centerZ - depth / 2);
    const y10 = ctx.getHeightAt(centerX + width / 2, centerZ - depth / 2);
    const y01 = ctx.getHeightAt(centerX - width / 2, centerZ + depth / 2);
    const y11 = ctx.getHeightAt(centerX + width / 2, centerZ + depth / 2);
    const sorted = [y00, y10, y01, y11].sort((a, b) => a - b);
    // sorted has exactly 4 entries (we just constructed the array literal) — the
    // bracket access is safe but `noUncheckedIndexedAccess` doesn't see that.
    const medianY = ((sorted[1] ?? 0) + (sorted[2] ?? 0)) / 2;

    let blockId: number | undefined;
    if (foundationBlockType) {
      blockId = ctx.resolveBlockByName(foundationBlockType);
      if (blockId === undefined) {
        // The agent set a name we can't resolve — likely a typo or an
        // unregistered custom block. Warn once + fall through to STONE so the
        // foundation still gets carved (better than no foundation at all).
        console.warn(`[HotspotInterpreter] foundationBlockType "${foundationBlockType}" not registered — falling back to STONE.`);
        blockId = ctx.resolveBlockByName('STONE');
      }
    } else {
      blockId = ctx.resolveBlockByName('STONE');
    }

    ctx.flattenArea(centerX, centerZ, width, depth, medianY, blockId, false, margin);
    return medianY;
  }
}

/**
 * Registry. One instance per world-generation run. `applyAll` THROWS on:
 *   - Unknown hotspot type (the `world.json` schema check should catch this
 *     up-front, but we throw at runtime as a defense in depth).
 *   - Any error inside an interpreter (no silent swallowing — half-rendered
 *     levels are worse than no rendering, and the agent needs feedback).
 */
export class HotspotInterpreterRegistry {
  private interpreters = new Map<string, HotspotInterpreterBase>();

  register<T extends Hotspot>(interpreter: HotspotInterpreterBase<T>): void {
    this.interpreters.set(interpreter.type, interpreter as HotspotInterpreterBase);
  }

  /** True when an interpreter has been registered for this type. Used by the WorldGenerator's "skip-when-empty" guard. */
  has(type: string): boolean {
    return this.interpreters.has(type);
  }

  /**
   * Apply every hotspot in `hotspots` via its registered interpreter, in array
   * order. Order matters when interpreters carve overlapping foundations —
   * the LAST flatten wins.
   *
   * `opts.vxlTerrain` — set when the terrain was loaded from a baked .vxl file:
   * only interpreters with `worksOnVxlTerrain` run; the rest are skipped with a
   * loud per-hotspot warning (building hotspots MUST work on forged levels —
   * the old skip-everything guard silently dropped them).
   *
   * @throws Error when a hotspot's type has no registered interpreter, or when
   *   an interpreter throws. The world-generation pipeline aborts in that case.
   */
  applyAll(ctx: HotspotContext, hotspots: Hotspot[], opts?: { vxlTerrain?: boolean }): void {
    for (const hs of hotspots) {
      const interpreter = this.interpreters.get(hs.type);
      if (!interpreter) {
        throw new Error(
          `[HotspotInterpreter] no interpreter registered for type "${hs.type}" (id="${hs.id}"). ` +
          `Registered types: [${[...this.interpreters.keys()].join(', ') || '(none)'}].`,
        );
      }
      if (opts?.vxlTerrain && !interpreter.worksOnVxlTerrain) {
        console.warn(
          `[HotspotInterpreter] SKIPPED "${hs.type}" id="${hs.id}" — this hotspot type only runs on ` +
          `generated terrain, and this world's terrain was loaded from a .vxl file. ` +
          `('building' hotspots DO run on .vxl terrain.)`,
        );
        continue;
      }
      try {
        interpreter.apply(ctx, hs);
      } catch (err) {
        // Re-throw with a context-rich message so the engine logs identify the
        // failing hotspot. Use Error.cause to preserve the original stack —
        // bare-rethrow message-string would lose the inner frames.
        const msg = err instanceof Error ? err.message : String(err);
        const wrapped = new Error(`[HotspotInterpreter] "${hs.type}" failed on id="${hs.id}": ${msg}`);
        if (err instanceof Error) (wrapped as Error & { cause?: unknown }).cause = err;
        throw wrapped;
      }
    }
  }
}
