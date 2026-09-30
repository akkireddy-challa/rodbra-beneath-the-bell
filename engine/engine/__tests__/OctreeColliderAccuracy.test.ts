/**
 * The physics grid a voxel asset's collider is rasterized onto is COARSER than
 * the asset's own voxels (the bake stores `minVoxelSize * 4`, floored at 0.1 m),
 * and the rasterization is conservative: any cell touched by any part of a leaf
 * becomes fully solid. On a large building that is invisible. On a small prop it
 * is the whole object — a 0.32 m rubble pile on a 0.25 m grid collides as a
 * 0.50 m block, so the player stands a quarter-metre above it in mid-air and is
 * blocked a fifth of a metre before touching it.
 *
 * These tests pin the collider to the geometry it is standing in for.
 */

import { greedyMeshOctreeLeaves, type OctreeLeaf, type PhysicsBox } from 'engine/VoxelOctreeRenderer.js';

const LEAF = 0.0625;
/** What the bake stores for a 0.0625 m asset: `clamp(minVoxelSize * 4, 0.1, 0.5)`. */
const BAKED_STEP = 0.25;

function leaf(x: number, y: number, z: number, size = LEAF): OctreeLeaf {
  return { x, y, z, size, r: 0.5, g: 0.5, b: 0.5 };
}

/** Fill an axis-aligned slab with leaves on the leaf lattice. */
function slab(
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
): OctreeLeaf[] {
  const out: OctreeLeaf[] = [];
  for (let x = x0; x < x1 - 1e-9; x += LEAF) {
    for (let y = y0; y < y1 - 1e-9; y += LEAF) {
      for (let z = z0; z < z1 - 1e-9; z += LEAF) out.push(leaf(x, y, z));
    }
  }
  return out;
}

function bounds(boxes: readonly PhysicsBox[]) {
  return {
    minX: Math.min(...boxes.map((b) => b.cx - b.hx)),
    maxX: Math.max(...boxes.map((b) => b.cx + b.hx)),
    minY: Math.min(...boxes.map((b) => b.cy - b.hy)),
    maxY: Math.max(...boxes.map((b) => b.cy + b.hy)),
    minZ: Math.min(...boxes.map((b) => b.cz - b.hz)),
    maxZ: Math.max(...boxes.map((b) => b.cz + b.hz)),
  };
}

describe('greedyMeshOctreeLeaves collider accuracy', () => {
  // The real Decor_Rubble: a low, wide debris pile. Authored 1.1875 x 0.3125 x
  // 0.9375 m, baked at 0.0625 m leaves — and given a 0.25 m physics grid.
  const rubble = [
    ...slab(0, 0, 0, 0.5, 0.3125, 0.4375),
    ...slab(0.5, 0, 0.25, 0.8125, 0.25, 0.5625),
    ...slab(0.875, 0, 0.5, 1.1875, 0.1875, 0.9375),
  ];

  it('never collides above the geometry it stands in for', () => {
    const boxes = greedyMeshOctreeLeaves(rubble, 0, 0, 0, BAKED_STEP);
    // The pile is 0.3125 m tall. On the raw 0.25 m grid its collider top lands
    // at 0.5 — the player mounts a step that is not there and hovers.
    expect(bounds(boxes).maxY).toBeCloseTo(0.3125, 6);
  });

  it('never collides wider or deeper than the geometry', () => {
    const b = bounds(greedyMeshOctreeLeaves(rubble, 0, 0, 0, BAKED_STEP));
    expect(b.minX).toBeCloseTo(0, 6);
    expect(b.maxX).toBeCloseTo(1.1875, 6);
    expect(b.minZ).toBeCloseTo(0, 6);
    expect(b.maxZ).toBeCloseTo(0.9375, 6);
    expect(b.minY).toBeCloseTo(0, 6);
  });

  it('keeps a small prop within one leaf of its true silhouette everywhere', () => {
    // Not just the outer hull: the SHORT chunks of the pile must not inflate to
    // the tall one's height either, or the player walks on a phantom plateau
    // spanning the whole prop.
    const boxes = greedyMeshOctreeLeaves(rubble, 0, 0, 0, BAKED_STEP);
    const solidAt = (x: number, z: number): number => Math.max(
      0,
      ...boxes
        .filter((b) => x > b.cx - b.hx + 1e-9 && x < b.cx + b.hx - 1e-9
          && z > b.cz - b.hz + 1e-9 && z < b.cz + b.hz - 1e-9)
        .map((b) => b.cy + b.hy),
    );
    // Over the third chunk (0.1875 tall) the collider must not stand at the
    // first chunk's 0.3125.
    expect(solidAt(1.0, 0.7)).toBeLessThanOrEqual(0.1875 + LEAF + 1e-9);
    // ...and over empty floor there is nothing at all.
    expect(solidAt(1.15, 0.05)).toBe(0);
  });

  it('still merges into few boxes — accuracy must not cost a collider per voxel', () => {
    const boxes = greedyMeshOctreeLeaves(rubble, 0, 0, 0, BAKED_STEP);
    expect(boxes.length).toBeGreaterThan(0);
    // Three axis-aligned chunks; a greedy mesher should be nowhere near the
    // ~1500 leaves that make them up.
    expect(boxes.length).toBeLessThan(40);
  });

  it('leaves a LARGE asset on its coarse grid — the budget is what makes props cheap', () => {
    // A building-sized slab: 12 x 6 x 12 m. Refining this to leaf resolution
    // would be millions of cells, and nobody can perceive 0.19 m on it.
    const big: OctreeLeaf[] = [];
    for (let x = 0; x < 12; x += 0.5) {
      for (let z = 0; z < 12; z += 0.5) big.push(leaf(x, 0, z, 0.5));
    }
    const boxes = greedyMeshOctreeLeaves(big, 0, 0, 0, 0.5);
    expect(boxes.length).toBeLessThan(10);
    expect(bounds(boxes).maxX).toBeCloseTo(12, 6);
  });
});
