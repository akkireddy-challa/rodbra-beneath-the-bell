/**
 * Tests for the hotspot subsystem (Phase 2 of 3D-terrain authoring).
 *
 * Each interpreter is exercised against a stub `HotspotContext` that captures
 * `flattenArea` calls and pushed env-objects, so we can assert:
 *   1. Buildings carve a flat foundation BEFORE the env-object is pushed (the
 *      Phase 2 critical rule — a tower painted on a slope without a foundation
 *      is the broken case Phase 0 was added to prevent).
 *   2. Every injected env-object has `flattenTerrain: true` (mode B contract).
 *   3. Foundations are placed at the median of the four corner heights — not
 *      max (would float buildings) or min (would sink them).
 *   4. Registry throws on unknown types and on interpreter errors (no silent
 *      half-rendered levels).
 */

import {
  HotspotInterpreterRegistry,
  buildDefaultHotspotRegistry,
  assetDimensionsMeters,
  type HotspotContext,
  type HotspotAsset,
  type InjectedEnvironmentObject,
} from 'engine/hotspots/index.js';
import { VillageInterpreter } from 'engine/hotspots/VillageInterpreter.js';
import { TowerInterpreter } from 'engine/hotspots/TowerInterpreter.js';
import { BuildingInterpreter } from 'engine/hotspots/BuildingInterpreter.js';
import { rasterizeBuildingShell } from 'engine/BuildingSystem.js';
import type { Hotspot } from 'types/game.js';

interface FlattenCall {
  centerX: number; centerZ: number; width: number; depth: number;
  height: number; blockType?: number; rebuildMeshes?: boolean; margin?: number;
}

/**
 * Build a stub HotspotContext that records flattenArea calls + pushed env-objects
 * so tests can assert the right thing happened in the right order.
 *
 * `terrainHeight` controls what `getHeightAt` returns. Pass a function for
 * heterogeneous terrain (e.g. a slope: `(x, z) => x * 0.1`).
 */
function makeStubCtx(opts: {
  assets?: HotspotAsset[];
  terrainHeight?: number | ((x: number, z: number) => number);
  rngSequence?: number[];
}): {
  ctx: HotspotContext;
  flattenCalls: FlattenCall[];
  pushed: InjectedEnvironmentObject[];
} {
  const flattenCalls: FlattenCall[] = [];
  const pushed: InjectedEnvironmentObject[] = [];

  const heightFn = typeof opts.terrainHeight === 'function'
    ? opts.terrainHeight
    : () => (typeof opts.terrainHeight === 'number' ? opts.terrainHeight : 0);

  // Deterministic RNG: cycles through the supplied sequence (default fixed mid-range value)
  const seq = opts.rngSequence ?? [0.5];
  let i = 0;
  const rng = () => {
    const v = seq[i % seq.length];
    i++;
    return v;
  };

  const blockTypes: Record<string, number> = {
    STONE: 1, GRASS: 2, ASPHALT: 3, MARBLE: 4, SAND: 5,
  };

  const ctx: HotspotContext = {
    flattenArea: (centerX, centerZ, width, depth, height, blockType, rebuildMeshes, margin) => {
      flattenCalls.push({ centerX, centerZ, width, depth, height, blockType, rebuildMeshes, margin });
    },
    getHeightAt: heightFn,
    resolveBlockByName: (name) => blockTypes[name.toUpperCase()],
    pushEnvironmentObject: (envObj) => pushed.push(envObj),
    assets: opts.assets ?? [],
    rng,
  };
  return { ctx, flattenCalls, pushed };
}

function makeAsset(id: string, w: number, h: number, d: number, name?: string): HotspotAsset {
  return {
    id,
    name: name ?? id,
    type: 'vxl',
    naturalDimensions: { x: w, y: h, z: d },
  };
}

describe('assetDimensionsMeters (engine-side)', () => {
  it('uses naturalDimensions when present', () => {
    const a = makeAsset('a', 10, 20, 8);
    expect(assetDimensionsMeters(a)).toEqual({ x: 10, y: 20, z: 8 });
  });

  it('falls back to bbox * voxelSize for VXL convention', () => {
    const a: HotspotAsset = {
      id: 'a', name: 'a', type: 'vxl', voxelSize: 0.25,
      boundingBox: { minX: 0, minY: 0, minZ: 0, maxX: 144, maxY: 484, maxZ: 144 },
    };
    expect(assetDimensionsMeters(a)).toEqual({ x: 36, y: 121, z: 36 });
  });

  it('falls back to 1m cube when neither is set', () => {
    const a: HotspotAsset = { id: 'a', name: 'a', type: 'vxl' };
    expect(assetDimensionsMeters(a)).toEqual({ x: 1, y: 1, z: 1 });
  });
});

describe('TowerInterpreter', () => {
  const TOWER_ASSET = makeAsset('tower-1', 8, 30, 8, 'tower');

  it('throws when assetId references an unknown asset', () => {
    const { ctx } = makeStubCtx({ assets: [] });
    const interp = new TowerInterpreter();
    const hotspot: Hotspot = { id: 't1', type: 'tower', center: { x: 0, z: 0 }, assetId: 'missing' };
    expect(() => interp.apply(ctx, hotspot)).toThrow(/unknown assetId/);
  });

  it('carves a flat foundation BEFORE pushing the env-object', () => {
    const { ctx, flattenCalls, pushed } = makeStubCtx({ assets: [TOWER_ASSET] });
    const interp = new TowerInterpreter();
    const hotspot: Hotspot = { id: 't1', type: 'tower', center: { x: 5, z: -5 }, assetId: 'tower-1' };
    interp.apply(ctx, hotspot);
    // flattenArea was called once, pushEnvironmentObject was called once.
    expect(flattenCalls).toHaveLength(1);
    expect(pushed).toHaveLength(1);
    // Foundation centered on the tower
    expect(flattenCalls[0].centerX).toBe(5);
    expect(flattenCalls[0].centerZ).toBe(-5);
    // Footprint matches asset XZ
    expect(flattenCalls[0].width).toBe(8);
    expect(flattenCalls[0].depth).toBe(8);
    // Margin is 2 voxels (TowerInterpreter constant)
    expect(flattenCalls[0].margin).toBe(2);
  });

  it('emits flattenTerrain: true on the env-object (Phase 0 mode B contract)', () => {
    const { ctx, pushed } = makeStubCtx({ assets: [TOWER_ASSET] });
    const interp = new TowerInterpreter();
    const hotspot: Hotspot = { id: 't1', type: 'tower', center: { x: 0, z: 0 }, assetId: 'tower-1' };
    interp.apply(ctx, hotspot);
    expect(pushed[0].flattenTerrain).toBe(true);
    expect(pushed[0].placeOnTerrain).toBeUndefined();
  });

  it('places the tower at the median Y of the four foundation corners (not max, not min)', () => {
    // Slope: Y rises with X. Corners at (-4, ±4) → Y = -0.4; (+4, ±4) → Y = 0.4.
    // Sorted: [-0.4, -0.4, 0.4, 0.4] → median = (sorted[1] + sorted[2]) / 2 = (-0.4 + 0.4) / 2 = 0.
    const { ctx, flattenCalls, pushed } = makeStubCtx({
      assets: [TOWER_ASSET],
      terrainHeight: (x, _z) => x * 0.1,
    });
    const interp = new TowerInterpreter();
    const hotspot: Hotspot = { id: 't1', type: 'tower', center: { x: 0, z: 0 }, assetId: 'tower-1' };
    interp.apply(ctx, hotspot);
    expect(flattenCalls[0].height).toBeCloseTo(0);
    expect(pushed[0].position.y).toBeCloseTo(0);
  });

  it('uses STONE as default foundation block when no override is set', () => {
    const { ctx, flattenCalls } = makeStubCtx({ assets: [TOWER_ASSET] });
    const interp = new TowerInterpreter();
    const hotspot: Hotspot = { id: 't1', type: 'tower', center: { x: 0, z: 0 }, assetId: 'tower-1' };
    interp.apply(ctx, hotspot);
    expect(flattenCalls[0].blockType).toBe(1); // STONE in stub blockTypes
  });

  it('honours foundationBlockType override when provided and resolvable', () => {
    const { ctx, flattenCalls } = makeStubCtx({ assets: [TOWER_ASSET] });
    const interp = new TowerInterpreter();
    const hotspot: Hotspot = {
      id: 't1', type: 'tower', center: { x: 0, z: 0 }, assetId: 'tower-1',
      foundationBlockType: 'marble',
    };
    interp.apply(ctx, hotspot);
    expect(flattenCalls[0].blockType).toBe(4); // MARBLE in stub blockTypes
  });

  it('falls back to STONE when foundationBlockType is unknown', () => {
    const { ctx, flattenCalls } = makeStubCtx({ assets: [TOWER_ASSET] });
    const interp = new TowerInterpreter();
    const hotspot: Hotspot = {
      id: 't1', type: 'tower', center: { x: 0, z: 0 }, assetId: 'tower-1',
      foundationBlockType: 'unobtainium',
    };
    interp.apply(ctx, hotspot);
    expect(flattenCalls[0].blockType).toBe(1); // STONE fallback
  });
});

describe('VillageInterpreter', () => {
  const HOUSE_ASSET = makeAsset('house', 6, 5, 6, 'house');
  const HALL_ASSET = makeAsset('hall', 8, 6, 12, 'hall');

  it('throws when buildingAssetIds is empty', () => {
    const { ctx } = makeStubCtx({ assets: [HOUSE_ASSET] });
    const interp = new VillageInterpreter();
    const hotspot: Hotspot = {
      id: 'v1', type: 'village', center: { x: 0, z: 0 }, radius: 20, buildingAssetIds: [],
    };
    expect(() => interp.apply(ctx, hotspot)).toThrow(/empty buildingAssetIds/);
  });

  it('throws when any buildingAssetId references an unknown asset', () => {
    const { ctx } = makeStubCtx({ assets: [HOUSE_ASSET] });
    const interp = new VillageInterpreter();
    const hotspot: Hotspot = {
      id: 'v1', type: 'village', center: { x: 0, z: 0 }, radius: 20,
      buildingAssetIds: ['house', 'no-such-asset'],
    };
    expect(() => interp.apply(ctx, hotspot)).toThrow(/no-such-asset/);
  });

  it('carves a foundation per building before pushing each env-object (1:1)', () => {
    const { ctx, flattenCalls, pushed } = makeStubCtx({
      assets: [HOUSE_ASSET],
      // RNG sequence places each candidate deterministically without overlap.
      rngSequence: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.05],
    });
    const interp = new VillageInterpreter();
    const hotspot: Hotspot = {
      id: 'v1', type: 'village', center: { x: 0, z: 0 }, radius: 20,
      buildingAssetIds: ['house'], density: 0.01, // small density → small count
    };
    interp.apply(ctx, hotspot);
    // 1:1 — every pushed env-object has a corresponding flattenArea.
    expect(flattenCalls.length).toBe(pushed.length);
    expect(pushed.length).toBeGreaterThanOrEqual(1);
  });

  it('emits flattenTerrain: true on every village env-object', () => {
    const { ctx, pushed } = makeStubCtx({
      assets: [HOUSE_ASSET],
      rngSequence: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
    });
    const interp = new VillageInterpreter();
    const hotspot: Hotspot = {
      id: 'v1', type: 'village', center: { x: 0, z: 0 }, radius: 20,
      buildingAssetIds: ['house'], density: 0.01,
    };
    interp.apply(ctx, hotspot);
    expect(pushed.length).toBeGreaterThan(0);
    for (const obj of pushed) {
      expect(obj.flattenTerrain).toBe(true);
      expect(obj.placeOnTerrain).toBeUndefined();
    }
  });

  it('rotates round-robin through buildingAssetIds', () => {
    const { ctx, pushed } = makeStubCtx({
      assets: [HOUSE_ASSET, HALL_ASSET],
      rngSequence: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95],
    });
    const interp = new VillageInterpreter();
    const hotspot: Hotspot = {
      id: 'v1', type: 'village', center: { x: 0, z: 0 }, radius: 30,
      buildingAssetIds: ['house', 'hall'], density: 0.005,
    };
    interp.apply(ctx, hotspot);
    expect(pushed.length).toBeGreaterThanOrEqual(2);
    // First building uses 'house' (index 0), second uses 'hall' (index 1).
    expect(pushed[0].assetId).toBe('house');
    expect(pushed[1].assetId).toBe('hall');
  });

  it('placed buildings stay inside the radius (with some tolerance for half-footprint margin)', () => {
    const { ctx, pushed } = makeStubCtx({
      assets: [HOUSE_ASSET],
      rngSequence: Array.from({ length: 50 }, (_, i) => (i % 100) / 100),
    });
    const interp = new VillageInterpreter();
    const hotspot: Hotspot = {
      id: 'v1', type: 'village', center: { x: 50, z: -25 }, radius: 30,
      buildingAssetIds: ['house'], density: 0.02,
    };
    interp.apply(ctx, hotspot);
    expect(pushed.length).toBeGreaterThan(0);
    for (const obj of pushed) {
      const dx = obj.position.x - 50;
      const dz = obj.position.z - (-25);
      const r = Math.sqrt(dx * dx + dz * dz);
      // sample radius reduced by half-footprint = 30 - 3 = 27. Allow tolerance.
      expect(r).toBeLessThanOrEqual(28);
    }
  });
});

describe('HotspotInterpreterRegistry', () => {
  it('throws on unknown hotspot type rather than silently skipping', () => {
    const reg = new HotspotInterpreterRegistry();
    reg.register(new TowerInterpreter());
    const { ctx } = makeStubCtx({});
    const hotspots = [{ id: 'unk', type: 'mystery_type' as 'tower', center: { x: 0, z: 0 }, assetId: 'a' }];
    expect(() => reg.applyAll(ctx, hotspots as unknown as Hotspot[])).toThrow(/no interpreter registered for type "mystery_type"/);
  });

  it('rethrows interpreter errors with hotspot id context', () => {
    const reg = new HotspotInterpreterRegistry();
    reg.register(new TowerInterpreter());
    const { ctx } = makeStubCtx({ assets: [] }); // no asset registered
    const hotspots: Hotspot[] = [{ id: 't_bad', type: 'tower', center: { x: 0, z: 0 }, assetId: 'missing' }];
    expect(() => reg.applyAll(ctx, hotspots)).toThrow(/"tower" failed on id="t_bad"/);
  });

  it('applyAll runs in array order — last flatten wins on overlap', () => {
    const reg = new HotspotInterpreterRegistry();
    reg.register(new TowerInterpreter());
    const TOWER = makeAsset('tower', 4, 10, 4);
    const { ctx, flattenCalls } = makeStubCtx({ assets: [TOWER] });
    const hotspots: Hotspot[] = [
      { id: 'a', type: 'tower', center: { x: 0, z: 0 }, assetId: 'tower' },
      { id: 'b', type: 'tower', center: { x: 5, z: 0 }, assetId: 'tower' },
    ];
    reg.applyAll(ctx, hotspots);
    expect(flattenCalls).toHaveLength(2);
    expect(flattenCalls[0].centerX).toBe(0);
    expect(flattenCalls[1].centerX).toBe(5);
  });
});

describe('buildDefaultHotspotRegistry', () => {
  it('registers village, tower and building interpreters', () => {
    const reg = buildDefaultHotspotRegistry();
    expect(reg.has('village')).toBe(true);
    expect(reg.has('tower')).toBe(true);
    expect(reg.has('building')).toBe(true);
  });
});

/**
 * BuildingInterpreter is an INERT stub: enterable buildings are engine-built
 * by BuildingSystem (works on baked .vxl levels + needs no per-game
 * WorldGenerator support). The stub exists so legacy registries don't throw.
 * The geometry contract lives in rasterizeBuildingShell (tested below).
 */
describe('BuildingInterpreter (inert stub)', () => {
  const BASE: Hotspot = {
    id: 'base_red', type: 'building',
    center: { x: 0, z: 0 }, size: { x: 6, z: 4 }, wallHeight: 3,
    doors: [{ side: 'south' }],
  };

  it('applies as a no-op (no flatten, no env objects) — BuildingSystem owns construction', () => {
    const { ctx, flattenCalls, pushed } = makeStubCtx({ terrainHeight: 10 });
    new BuildingInterpreter().apply(ctx, BASE as never);
    expect(flattenCalls).toHaveLength(0);
    expect(pushed).toHaveLength(0);
  });

  it('is registered and vxl-safe, so baked-level worlds neither throw nor warn on building entries', () => {
    const reg = buildDefaultHotspotRegistry();
    const { ctx } = makeStubCtx({ terrainHeight: 10 });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      reg.applyAll(ctx, [
        BASE,
        { id: 'v1', type: 'village', center: { x: 50, z: 50 }, radius: 20, buildingAssetIds: ['a1'] },
      ] as Hotspot[], { vxlTerrain: true });
      expect(warn.mock.calls.some(c => String(c[0]).includes('SKIPPED "village"'))).toBe(true);
      expect(warn.mock.calls.some(c => String(c[0]).includes('"building"'))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * rasterizeBuildingShell: the enterable-structure geometry contract. A
 * building is a hollow shell with its own floor slab and REAL openings — the
 * rasterizer must be unable to produce a doorless box (the "spawn locked
 * inside a cube" failure this type exists to prevent).
 */
describe('rasterizeBuildingShell (BuildingSystem geometry)', () => {
  const BASE = {
    id: 'base_red', type: 'building' as const,
    center: { x: 0, z: 0 }, size: { x: 6, z: 4 }, wallHeight: 3,
    doors: [{ side: 'south' as const }],
    windows: [{ side: 'east' as const }],
  };
  // Cell layout for BASE at bs=1: interior 6x4 -> outer 8x6 cells; h=0 floor
  // slab, walls h=1..3, roof h=4.
  const cellsOf = (spec: Parameters<typeof rasterizeBuildingShell>[0]) => {
    const shell = rasterizeBuildingShell(spec, 1);
    const set = new Set(shell.cells.map(c => `${c.i},${c.h},${c.k}`));
    return { shell, has: (i: number, h: number, k: number) => set.has(`${i},${h},${k}`) };
  };

  it('builds a hollow shell on a full floor slab: perimeter walls, open interior', () => {
    const { shell, has } = cellsOf(BASE);
    expect(shell).toMatchObject({ ox: 8, oz: 6, hCells: 3, autoDoor: false });
    expect(has(0, 1, 0)).toBe(true);   // corner wall base
    expect(has(0, 3, 5)).toBe(true);   // opposite corner, top wall row
    expect(has(4, 0, 3)).toBe(true);   // floor under the interior
    expect(has(4, 1, 3)).toBe(false);  // interior stays open
    expect(has(4, 2, 3)).toBe(false);
  });

  it('opens the doorway through the full wall at the door cells only', () => {
    const { has } = cellsOf(BASE);
    // South wall (k=0): centered 2m door -> cells i=3,4 open for wall rows 1..3.
    for (const h of [1, 2, 3]) {
      expect(has(3, h, 0)).toBe(false);
      expect(has(4, h, 0)).toBe(false);
    }
    expect(has(2, 1, 0)).toBe(true); // jamb next to the door stays
    expect(has(5, 1, 0)).toBe(true);
    expect(has(0, 1, 0)).toBe(true); // corners never open
    expect(has(7, 1, 0)).toBe(true);
    expect(has(3, 0, 0)).toBe(true); // the floor slab runs through the doorway
  });

  it('cuts windows mid-wall, keeping wall below and lintel above', () => {
    const { has } = cellsOf(BASE);
    // East wall (i=7), default window: sill 1m, height 1m, centered on k=2,3.
    expect(has(7, 2, 2)).toBe(false);
    expect(has(7, 2, 3)).toBe(false);
    expect(has(7, 1, 2)).toBe(true); // below the sill
    expect(has(7, 3, 2)).toBe(true); // lintel above
  });

  it('roofs the full footprint by default and skips it for roof:none', () => {
    const roofed = cellsOf(BASE);
    expect(roofed.has(4, 4, 3)).toBe(true);   // over the interior
    expect(roofed.has(0, 4, 0)).toBe(true);   // over the walls

    const open = cellsOf({ ...BASE, id: 'b2', roof: 'none' });
    expect(open.has(4, 4, 3)).toBe(false);
  });

  it('NEVER produces a doorless box: missing doors[] auto-adds a south doorway', () => {
    const { shell, has } = cellsOf({ ...BASE, id: 'b3', doors: undefined, windows: undefined });
    expect(shell.autoDoor).toBe(true);
    expect(has(3, 1, 0)).toBe(false); // south doorway exists anyway
    expect(has(4, 1, 0)).toBe(false);
  });
});
