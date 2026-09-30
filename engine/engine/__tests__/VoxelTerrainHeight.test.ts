/**
 * @jest-environment jsdom
 *
 * jsdom (not the repo-default `node`) because VoxelWorld's meshing path builds the
 * voxel texture atlas via `document.createElement('canvas')`.
 */
import * as THREE from 'three';
import { VoxelTerrainSystem } from 'engine/VoxelTerrainSystem.js';
import { TerrainTypeRegistry } from 'engine/TerrainTypes.js';
import type { EngineLike, TerrainFrictionProvider } from 'types/game.js';

/**
 * Height semantics for voxel terrain.
 *
 * A voxel at index `vy` spans world Y `[minY + vy*bs, minY + (vy+1)*bs)` (VoxelWorld's
 * mesh builder places it at `centerY = boxMinWorldY + h/2`), so for a surface block
 * resting at base 0 with blockSize 0.5 the walkable TOP is 0.5 and the CENTRE is 0.25.
 *
 * `getHeightAt` documents itself as returning "top of terrain or building surface" and
 * has two paths: a physics raycast (fast, chunk clean) and a voxel-grid scan (slow, chunk
 * dirty). These MUST agree — callers place objects on the result, and which path runs is
 * an invisible timing detail. Regression guard for the half-block discrepancy that buried
 * path ribbons and sank spawns.
 */

/** No physics hit — forces getHeightAt down the voxel-grid (slow) path and skips the ENVIRONMENT ray. */
function makeEngine(): EngineLike {
  return {
    physicsWorld: {
      raycast: () => ({ hasHit: false }),
      step: () => { /* no-op */ },
    },
  } as unknown as EngineLike;
}

function makeSystem(blockSize: number): VoxelTerrainSystem {
  const world = new THREE.Group();
  const registry = new TerrainTypeRegistry();
  const heightProvider = { getHeightAt: () => 0 } as unknown as TerrainFrictionProvider;
  const system = new VoxelTerrainSystem(
    world,
    makeEngine(),
    heightProvider as never,
    registry,
    16,
    16,
    { blockSize }
  );
  system.initializeVoxelWorld();
  return system;
}

/**
 * Lay a single surface block whose base sits at world Y = 0.
 *
 * Batch mode keeps setBlock from eagerly rebuilding chunk physics/meshes — the height
 * APIs read the voxel grid, so no rigid bodies or texture atlas are needed. It also
 * leaves the chunk dirty, which is precisely the state that sends getHeightAt down its
 * voxel-scan path (the one under test).
 */
function stampGround(system: VoxelTerrainSystem, x: number, z: number): void {
  const voxelWorld = system.getVoxelWorld();
  if (!voxelWorld) throw new Error('voxelWorld not initialized — test setup is wrong');
  voxelWorld.beginBatchUpdate();
  voxelWorld.setBlock(x, 0, z, 1);
}

describe('VoxelTerrainSystem height semantics', () => {
  describe.each([[1], [0.5], [0.25]])('blockSize %p', (blockSize) => {
    it('getTerrainOnlyHeight returns the surface block CENTRE', () => {
      const system = makeSystem(blockSize);
      stampGround(system, 0, 0);

      // Documented-by-usage contract: adjustSpawnPosition and EditorManager both rely on
      // this being the centre (it floors down to the block base when fed to flattenArea).
      expect(system.getTerrainOnlyHeight(0, 0)).toBeCloseTo(blockSize / 2, 6);
    });

    it('getHeightAt returns the walkable TOP, matching its documented @returns', () => {
      const system = makeSystem(blockSize);
      stampGround(system, 0, 0);

      expect(system.getHeightAt(0, 0)).toBeCloseTo(blockSize, 6);
    });

    it('getHeightAt sits a full half-block above getTerrainOnlyHeight', () => {
      const system = makeSystem(blockSize);
      stampGround(system, 0, 0);

      const top = system.getHeightAt(0, 0);
      const centre = system.getTerrainOnlyHeight(0, 0);
      expect(top - centre).toBeCloseTo(blockSize / 2, 6);
    });
  });

  it('reports the same value a physics raycast would report for the block top', () => {
    // The clean-chunk path returns rayResult.hitPoint.y — the collider's true top face,
    // i.e. 0.5 for a block spanning [0, 0.5). The dirty-chunk path under test must agree,
    // or getHeightAt silently changes answer with physics timing and callers that offset
    // just above the surface end up buried inside it.
    const system = makeSystem(0.5);
    stampGround(system, 0, 0);

    const raycastWouldReport = 0.5;
    expect(system.getHeightAt(0, 0)).toBeCloseTo(raycastWouldReport, 6);
  });
});
