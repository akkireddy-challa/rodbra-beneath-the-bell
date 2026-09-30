/**
 * @jest-environment jsdom
 *
 * jsdom because VoxelWorld's meshing path builds the voxel texture atlas via a canvas.
 */
import * as THREE from 'three';
import { VoxelTerrainSystem } from 'engine/VoxelTerrainSystem.js';
import { VoxelFoliageSystem } from 'engine/VoxelFoliageSystem.js';
import type { VoxelWorld } from 'engine/VoxelWorld.js';
import { TerrainTypeRegistry } from 'engine/TerrainTypes.js';
import { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import { initRapier } from 'engine/physics/RapierPhysics.js';
import type { EngineLike, TerrainFrictionProvider } from 'types/game.js';
import type { TerrainHeightProvider } from 'engine/TerrainTypeProvider.js';

/** No physics hit — getHeightAt reads the voxel grid. */
function makeEngine(): EngineLike {
  return { physicsWorld: { raycast: () => ({ hasHit: false }), step: () => { /* no-op */ } } } as unknown as EngineLike;
}

const GRASS = 1;
const PATH = 2;

/**
 * A VoxelTerrainSystem over a `size` × `size` world with 1 m blocks, plus its
 * initialized VoxelWorld mid-batch — callers fill blocks and close the batch.
 */
function startTerrain(size: number, engine: EngineLike): { system: VoxelTerrainSystem; world: VoxelWorld } {
  const heightProvider = { getHeightAt: () => 0 } as unknown as TerrainFrictionProvider;
  const system = new VoxelTerrainSystem(new THREE.Group(), engine, heightProvider as never, new TerrainTypeRegistry(), size, size, { blockSize: 1 });
  system.initializeVoxelWorld();
  const world = system.getVoxelWorld();
  if (!world) throw new Error('voxelWorld not initialized — test setup is wrong');
  world.beginBatchUpdate();
  return { system, world };
}

/**
 * Ground at surface-block base Y = 0 over X/Z [-8, 8), with a one-block bump at x ≥ 2
 * (the slope a diner lot must level) and a path block at the doorway column.
 * Left un-meshed: only the block grid is queried.
 */
function makeTerrain(): VoxelTerrainSystem {
  const { system, world } = startTerrain(16, makeEngine());
  for (let x = -8; x < 8; x++) for (let z = -8; z < 8; z++) {
    world.setBlock(x, 0, z, GRASS);
    if (x >= 2 && z >= -2 && z < 2) world.setBlock(x, 1, z, GRASS);
  }
  world.setBlock(0, 0, -4, PATH);
  return system;
}

function makeFoliage(): VoxelFoliageSystem {
  const provider = { getHeightAt: () => 0 } as unknown as TerrainHeightProvider;
  return new VoxelFoliageSystem(new THREE.Scene(), 16, 16, 7, new TerrainTypeRegistry(), provider, { terrainVoxelSize: 1, getTerrainHeight: () => 0 });
}

describe('VoxelTerrainSystem.placeBuildingFoundation', () => {
  it('levels the lot at the prevailing ground, so the doorway stays level with the path', () => {
    const terrain = makeTerrain();
    const floorTop = terrain.placeBuildingFoundation('diner', 1, 0, 6, 4, { rebuildMeshes: false });

    expect(floorTop).toBe(1); // surface block spans [0, 1) — same top as the path
    expect(terrain.getHeightAt(0, -4)).toBe(1);
    for (const x of [-1.5, 1.5, 3.5]) expect(terrain.getHeightAt(x, 0.5)).toBe(1); // bump removed
    expect(terrain.getHeightAt(5.5, 0.5)).toBe(2); // outside the lot untouched
  });

  it('ignores a bump under the lot centre: the most common ground level across the footprint wins', () => {
    const terrain = makeTerrain();
    // Centre (2.5, 0) sits on the bump, which covers only 24 of the lot's 80 columns.
    const floorTop = terrain.placeBuildingFoundation('diner', 2.5, 0, 10, 8, { rebuildMeshes: false });

    expect(floorTop).toBe(1);
    expect(terrain.getHeightAt(2.5, 0.5)).toBe(1);
  });

  it('levelAt matches the floor to the ground at the given point', () => {
    const terrain = makeTerrain();
    // A raised landing outside the lot, two blocks above the ground: neither the lot centre's level nor the prevailing one.
    terrain.getVoxelWorld()!.setBlock(-8, 1, -8, GRASS);
    terrain.getVoxelWorld()!.setBlock(-8, 2, -8, GRASS);
    const floorTop = terrain.placeBuildingFoundation('diner', 2.5, 0, 10, 8, { rebuildMeshes: false, levelAt: { x: -7.5, z: -7.5 } });

    expect(floorTop).toBe(3);
    expect(terrain.getHeightAt(-1.5, -3.5)).toBe(3);
  });

  it('re-placing a lot levels it from the original ground, not from its previous floor', () => {
    const terrain = makeTerrain();
    expect(terrain.placeBuildingFoundation('diner', 1, 0, 6, 4, { rebuildMeshes: false, height: 2 })).toBe(3);

    expect(terrain.placeBuildingFoundation('diner', 1, 0, 6, 4, { rebuildMeshes: false })).toBe(1);
    expect(terrain.getHeightAt(-1.5, 0.5)).toBe(1);
  });

  it('registers a foliage exclusion for the footprint, also for a foliage system connected later', () => {
    const terrain = makeTerrain();
    const early = makeFoliage();
    terrain.setFoliageSystem(early);
    terrain.placeBuildingFoundation('diner', 1, 0, 6, 4, { rebuildMeshes: false, margin: 0.5 });

    expect(early.isFoliageExcluded(1, 0)).toBe(true);
    expect(early.isFoliageExcluded(-2.4, 2.4)).toBe(true); // inside the margin
    expect(early.isFoliageExcluded(-3, 3)).toBe(false);
    expect(terrain.getBuildingFoundation('diner')).toEqual({ minX: -2.5, minZ: -2.5, maxX: 4.5, maxZ: 2.5 });

    const late = makeFoliage();
    terrain.setFoliageSystem(late);
    expect(late.isFoliageExcluded(1, 0)).toBe(true);
  });

  it('releasing a temporary building drops the exclusion and restores the original ground', () => {
    const terrain = makeTerrain();
    const foliage = makeFoliage();
    terrain.setFoliageSystem(foliage);
    terrain.placeBuildingFoundation('stall', 1, 0, 6, 4, { rebuildMeshes: false });

    expect(terrain.releaseBuildingFoundation('stall', true, false)).toBe(true);
    expect(foliage.isFoliageExcluded(1, 0)).toBe(false);
    expect(terrain.getHeightAt(3.5, 0.5)).toBe(2); // bump back
    expect(terrain.hasFlattenSnapshot('stall')).toBe(false);
    expect(terrain.releaseBuildingFoundation('stall')).toBe(false);
  });
});

/** 64 m × 64 m flat ground (4 × 4 chunks) meshed against a real physics world. */
function makeMeshedTerrain(): VoxelTerrainSystem {
  const engine = { physicsWorld: new PhysicsWorld() } as unknown as EngineLike;
  const { system, world } = startTerrain(64, engine);
  for (let x = -32; x < 32; x++) for (let z = -32; z < 32; z++) world.setBlock(x, 0, z, GRASS);
  world.endBatchUpdate();
  return system;
}

/** Chunk meshes by 2D key; a re-meshed chunk gets a new mesh object. */
function chunkMeshes(system: VoxelTerrainSystem): Map<string, THREE.Object3D | null> {
  const world = system.getVoxelWorld()!;
  return new Map(world.get2DChunkKeys().map(key => [key, world.getChunkMeshFor2DKey(key)]));
}

describe('placeBuildingFoundation mesh rebuild', () => {
  beforeAll(async () => { await initRapier(); });

  it('re-meshes only the chunk under the lot, not the whole world', () => {
    const terrain = makeMeshedTerrain();
    const before = chunkMeshes(terrain);
    expect(before.size).toBe(16);

    // Lot well inside chunk "0,0" (x/z [-32, -16)), clear of its borders.
    terrain.placeBuildingFoundation('diner', -24, -24, 4, 4);

    const after = chunkMeshes(terrain);
    const rebuilt = [...after].filter(([key, mesh]) => mesh !== before.get(key)).map(([key]) => key);
    expect(rebuilt).toEqual(['0,0']);
  });

  it('does nothing before the terrain is first built, leaving the meshing to that build', () => {
    const terrain = makeTerrain(); // blocks set, never meshed
    terrain.placeBuildingFoundation('diner', 1, 0, 6, 4);
    for (const mesh of chunkMeshes(terrain).values()) expect(mesh).toBeNull();
  });
});
