import { bakeSceneFromTriangles } from 'engine/vxlscene/bakeScene.js';
import type { RasterTriangle } from 'engine/vxlscene/SurfaceRasterizer.js';

// A flat horizontal quad (inset, away from the world boundary) at height `y`.
function flatQuad(y: number): RasterTriangle[] {
  const col = (): [number, number, number] => [128, 128, 128];
  const n: [number, number, number] = [0, 1, 0];
  const p = (x: number, z: number): [number, number, number] => [x, y, z];
  return [
    { v0: p(4, 4), v1: p(4, 12), v2: p(12, 12), normal: n, nodeName: 'T', sampleColor: col },
    { v0: p(4, 4), v1: p(12, 12), v2: p(12, 4), normal: n, nodeName: 'T', sampleColor: col },
  ];
}

const opts = {
  chunkSize: 16, minVoxelSize: 0.125, maxVoxelSize: 1, additionalLods: 2, lodDistances: [50, 100, 200],
  fillInterior: true,
  controlsByNode: { T: { lodOffset: 0, pinned: false, trimeshCollider: false, noCollider: false, collisionOnly: false, displacementAxis: null, assetInstance: false } },
  bounds: { minX: 0, minY: 0, minZ: 0, maxX: 16, maxY: 16, maxZ: 16 },
} as unknown as Parameters<typeof bakeSceneFromTriangles>[1];

async function voxelCount(y: number): Promise<number> {
  const world = await bakeSceneFromTriangles(flatQuad(y), opts);
  let c = 0;
  for (const ch of world.chunks) c += (ch.voxels as unknown[]).length;
  return c;
}

describe('SurfaceRasterizer: grid-coplanar surfaces', () => {
  it('rasterizes a horizontal surface lying exactly on a voxel grid plane (flat-terrain regression)', async () => {
    // y = 8.0 is exactly on the 0.125 m grid (8 / 0.125 = 64). This used to drop the
    // whole surface (empty cell range), making flat terrain invisible.
    expect(await voxelCount(8.0)).toBeGreaterThan(0);
  });

  it('still rasterizes an off-grid horizontal surface (control)', async () => {
    expect(await voxelCount(8.3)).toBeGreaterThan(0);
  });
});
