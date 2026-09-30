/**
 * Greedy-box collider count estimation, extracted from `GLBVoxelizer.ts` into
 * its own pure module (no THREE / GLTFLoader import) so it can be unit tested
 * and reused by non-browser voxel-import paths (e.g. `VoxelModelToAsset.ts`)
 * without pulling in `GLBVoxelizer.ts`'s module-scope `three/examples/jsm`
 * import, which Jest cannot transform. `GLBVoxelizer.ts` re-exports this for
 * existing consumers.
 */
export function estimateColliderCount(leaves: ReadonlyArray<{ x: number; y: number; z: number; size: number }>, gridStep: number): number {
  if (leaves.length === 0) return 0;

  let gMinX = Infinity, gMinY = Infinity, gMinZ = Infinity;
  let gMaxX = -Infinity, gMaxY = -Infinity, gMaxZ = -Infinity;
  for (const l of leaves) {
    if (l.x < gMinX) gMinX = l.x;
    if (l.y < gMinY) gMinY = l.y;
    if (l.z < gMinZ) gMinZ = l.z;
    const ex = l.x + l.size, ey = l.y + l.size, ez = l.z + l.size;
    if (ex > gMaxX) gMaxX = ex;
    if (ey > gMaxY) gMaxY = ey;
    if (ez > gMaxZ) gMaxZ = ez;
  }

  const gs = gridStep;
  const nx = Math.ceil((gMaxX - gMinX) / gs);
  const ny = Math.ceil((gMaxY - gMinY) / gs);
  const nz = Math.ceil((gMaxZ - gMinZ) / gs);
  if (nx <= 0 || ny <= 0 || nz <= 0) return 0;

  const grid = new Uint8Array(nx * ny * nz);
  for (const l of leaves) {
    const ix0 = Math.max(0, Math.floor((l.x - gMinX) / gs));
    const iy0 = Math.max(0, Math.floor((l.y - gMinY) / gs));
    const iz0 = Math.max(0, Math.floor((l.z - gMinZ) / gs));
    const ix1 = Math.min(nx, Math.ceil((l.x + l.size - gMinX) / gs));
    const iy1 = Math.min(ny, Math.ceil((l.y + l.size - gMinY) / gs));
    const iz1 = Math.min(nz, Math.ceil((l.z + l.size - gMinZ) / gs));
    for (let iy = iy0; iy < iy1; iy++)
      for (let iz = iz0; iz < iz1; iz++)
        for (let ix = ix0; ix < ix1; ix++)
          grid[(iy * nz + iz) * nx + ix] = 1;
  }

  const visited = new Uint8Array(nx * ny * nz);
  const idx = (x: number, y: number, z: number) => (y * nz + z) * nx + x;
  const ok = (x: number, y: number, z: number) => grid[idx(x, y, z)] === 1 && !visited[idx(x, y, z)];

  let boxCount = 0;
  for (let y = 0; y < ny; y++) {
    for (let z = 0; z < nz; z++) {
      for (let x = 0; x < nx; x++) {
        if (!ok(x, y, z)) continue;
        let mx = x + 1;
        while (mx < nx && ok(mx, y, z)) mx++;
        let mz = z + 1;
        zLoop: while (mz < nz) {
          for (let ix = x; ix < mx; ix++) { if (!ok(ix, y, mz)) break zLoop; }
          mz++;
        }
        let my = y + 1;
        yLoop: while (my < ny) {
          for (let iz = z; iz < mz; iz++)
            for (let ix = x; ix < mx; ix++) { if (!ok(ix, my, iz)) break yLoop; }
          my++;
        }
        for (let iy = y; iy < my; iy++)
          for (let iz = z; iz < mz; iz++)
            for (let ix = x; ix < mx; ix++) visited[idx(ix, iy, iz)] = 1;
        boxCount++;
      }
    }
  }
  return boxCount;
}
