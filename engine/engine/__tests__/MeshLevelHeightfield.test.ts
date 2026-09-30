import RAPIER from '@dimforge/rapier3d-compat';
import { initRapier } from 'engine/physics/RapierPhysics.js';
import { PhysicsBodyFactory } from 'engine/physics/PhysicsBodyFactory.js';
import { colliderBounds, planCollider } from 'engine/meshlevel/MeshLevelColliders.js';
import { parseMeshLevel } from 'engine/meshlevel/MeshLevelSchema.js';
import type { MeshLevelHeightfieldCollider } from 'engine/meshlevel/MeshLevelSchema.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';

/**
 * A 4×2-cell grid (5×3 vertices) over x∈[10,18], z∈[-4,0] whose height is a
 * plane rising along X only: h = x - 10. A ray down anywhere must land on it —
 * which is what pins the row/column convention (a swapped layout tilts the
 * plane along Z instead and every sample below misses by metres).
 */
function rampAlongX(): MeshLevelHeightfieldCollider {
  const nx = 4;
  const nz = 2;
  const cellSize = 2;
  const minX = 10;
  const minZ = -4;
  const heights: number[] = [];
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) heights.push(i * cellSize);
  }
  return { name: 'ground', shape: 'heightfield', minX, minZ, cellSize, nx, nz, heights };
}

function groundY(world: RAPIER.World, x: number, z: number): number | null {
  const hit = world.castRay(new RAPIER.Ray({ x, y: 50, z }, { x: 0, y: -1, z: 0 }), 100, true);
  return hit ? 50 - hit.timeOfImpact : null;
}

describe('heightfield mesh-level collider', () => {
  beforeAll(async () => { await RAPIER.init(); await initRapier(); });

  it('lands rays on the heights where the record puts them', () => {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const plan = planCollider(rampAlongX(), 'terrain');
    PhysicsBodyFactory.createStaticBody(world as unknown as PhysicsWorld, plan.position, { shape: plan.shape }, plan.quaternion);
    world.step();

    for (const [x, z] of [[11, -3], [14, -1], [17.5, -2], [12, -0.5]] as const) {
      expect(groundY(world, x, z)).toBeCloseTo(x - 10, 3);
    }
    expect(groundY(world, 20, -2)).toBeNull(); // off the grid
  });

  it('parses from level JSON and bounds by its corners and height range', () => {
    const collider = rampAlongX();
    const { data } = parseMeshLevel({ format: 'bitmagic-mesh-level', version: 1, units: 'meters', colliders: [collider] }, 'test');
    expect(data.colliders[0]).toEqual(collider);
    expect(colliderBounds([collider])).toEqual({ minX: 10, minY: 0, minZ: -4, maxX: 18, maxY: 8, maxZ: 0 });
  });

  it('refuses a height array of the wrong length', () => {
    const bad = { ...rampAlongX(), heights: [0, 1, 2] };
    expect(() => parseMeshLevel({ format: 'bitmagic-mesh-level', version: 1, units: 'meters', colliders: [bad] }, 'test')).toThrow(/heights/);
  });
});

describe('sampleHeightfield', () => {
  it('interpolates the grid the collider is built from, and is null off it', async () => {
    const { sampleHeightfield } = await import('engine/meshlevel/MeshLevelColliders.js');
    const ramp = rampAlongX();
    expect(sampleHeightfield(ramp, 13, -2)).toBeCloseTo(3, 6);
    expect(sampleHeightfield(ramp, 18, 0)).toBeCloseTo(8, 6);
    expect(sampleHeightfield(ramp, 9.9, -2)).toBeNull();
    expect(sampleHeightfield(ramp, 12, 0.1)).toBeNull();
  });
});
