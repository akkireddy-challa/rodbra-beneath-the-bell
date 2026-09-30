import * as THREE from 'three';
import { VoxelFoliageSystem, type SurfaceVoxel } from 'engine/VoxelFoliageSystem.js';
import { TerrainTypeRegistry, FoliageType } from 'engine/TerrainTypes.js';
import type { TerrainHeightProvider } from 'engine/TerrainTypeProvider.js';

/**
 * Building-footprint foliage exclusions. Beach pebbles are the fixture because they build
 * from core Three geometry only (grass/flowers go through addons the Jest runner stubs).
 */

const BEACH = 1;

function makeSystem(scene: THREE.Scene): VoxelFoliageSystem {
  const registry = new TerrainTypeRegistry();
  registry.registerType(BEACH, { name: 'Beach', foliageType: FoliageType.BEACH, canPlaceTrees: false, canPlaceRocks: false });
  const provider = { getHeightAt: () => 0 } as unknown as TerrainHeightProvider;
  return new VoxelFoliageSystem(scene, 64, 64, 4242, registry, provider, { terrainVoxelSize: 0.25, getTerrainHeight: () => 0 });
}

/** 32 × 32 surface voxels (0.25 m) spanning world X/Z [0, 8). */
function surface(): SurfaceVoxel[] {
  return Array.from({ length: 1024 }, (_, i) => ({
    worldX: (i % 32) * 0.25 + 0.125, worldY: 0, worldZ: Math.floor(i / 32) * 0.25 + 0.125, blockType: BEACH,
  }));
}

/** World XZ of every visible (non-zero-scale) pebble instance under `parent`. */
function visiblePebbles(parent: THREE.Object3D): Array<{ x: number; z: number }> {
  const out: Array<{ x: number; z: number }> = [];
  const matrix = new THREE.Matrix4(), pos = new THREE.Vector3(), scale = new THREE.Vector3();
  for (const child of parent.children) {
    if (!(child instanceof THREE.InstancedMesh)) continue;
    for (let i = 0; i < child.count; i++) {
      child.getMatrixAt(i, matrix);
      // Hidden instances are scaled to zero (hideFoliageItem).
      if (scale.setFromMatrixScale(matrix).lengthSq() > 0) out.push({ x: pos.setFromMatrixPosition(matrix).x, z: pos.z });
    }
  }
  return out;
}

const inFootprint = (p: { x: number; z: number }): boolean => p.x >= 2 && p.x <= 5 && p.z >= 2 && p.z <= 5;

describe('VoxelFoliageSystem footprint exclusions', () => {
  let system: VoxelFoliageSystem;
  let chunk: THREE.Group;

  beforeEach(() => {
    const scene = new THREE.Scene();
    system = makeSystem(scene);
    chunk = new THREE.Group();
    scene.add(chunk);
  });

  afterEach(() => system.dispose());

  /** (Re)grow the fixture chunk's foliage and report the visible pebbles. */
  const regenerate = (): Array<{ x: number; z: number }> => {
    system.generateFoliageForChunk('0,0', surface(), chunk, t => t);
    return visiblePebbles(chunk);
  };

  it('hides foliage already growing inside the footprint of an existing chunk', () => {
    expect(regenerate().some(inFootprint)).toBe(true);

    system.addFoliageExclusion('diner', 2, 2, 5, 5);

    expect(visiblePebbles(chunk).some(inFootprint)).toBe(false);
  });

  it('keeps the footprint clear when the chunk is regenerated, and regrows after release', () => {
    system.clearFoliageInRect(0, 0, 1, 1); // unrelated anonymous rect must not disturb the named one
    system.addFoliageExclusion('diner', 2, 2, 5, 5);

    expect(regenerate().some(inFootprint)).toBe(false);
    expect(system.isFoliageExcluded(3, 3)).toBe(true);

    expect(system.removeFoliageExclusion('diner')).toBe(true);
    expect(regenerate().some(inFootprint)).toBe(true);
  });

  it('leaves foliage in a nearby area untouched', () => {
    const outside = regenerate().filter(p => !inFootprint(p));
    expect(outside.length).toBeGreaterThan(0);

    system.addFoliageExclusion('diner', 2, 2, 5, 5);
    expect(visiblePebbles(chunk).filter(p => !inFootprint(p))).toEqual(outside);

    // A regenerated chunk grows the exact same plants outside the lot (seeded per chunk).
    for (const p of regenerate()) expect(inFootprint(p)).toBe(false);
    expect(system.isFoliageExcluded(6, 6)).toBe(false);
  });

  it('clearFoliageAt hides the plants within the radius only', () => {
    const before = regenerate().length;

    system.clearFoliageAt(4, 4, 1.5);

    const after = visiblePebbles(chunk);
    expect(after.length).toBeLessThan(before);
    for (const p of after) expect(Math.hypot(p.x - 4, p.z - 4)).toBeGreaterThan(1.5);
  });
});
