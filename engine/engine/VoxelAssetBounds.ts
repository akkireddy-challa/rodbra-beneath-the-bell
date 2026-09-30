/**
 * Published-bounds math for an ASSET voxel bake. Pure (no three.js / DOM), so
 * it unit-tests in isolation — `GLBVoxelizer.ts` itself pulls in GLTFLoader and
 * can't be imported under jest.
 */

/** The only leaf fields the bounds math needs (an `OctreeLeaf` satisfies this). */
export interface VoxelBoundsLeaf {
  x: number;
  y: number;
  z: number;
  size: number;
}

export interface VoxelAssetBounds {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}

/**
 * Mutate `bounds` so it fully encloses every leaf, snapping outward to
 * `step` multiples so v3's integer grid coords stay non-negative.
 *
 * X/Z stay CENTERED on the origin — the asset frame's published contract (see
 * `ExtractedGlb.bounds`), which the rest of the engine relies on: `VoxelObject`
 * derives its render pivot from the bounds CENTRE, so a lopsided box silently
 * shifts the whole model sideways. That is easy to produce accidentally: each
 * LOD pass snaps with its own (coarser) step, so one side can jump a full
 * coarse voxel outward while the other is already grid-aligned — e.g.
 * [-0.48, +0.48] became [-0.64, +0.48], moving a forged kart's body 8 cm off
 * its wheels even though the source GLB was perfectly symmetric. Mirroring each
 * axis to its wider side only ever GROWS the box (enclosure is preserved) and
 * keeps both edges on the same snapped grid. Y is deliberately untouched: its
 * contract is base-at-0, not centered.
 */
export function expandBoundsToFitLeaves(
  bounds: VoxelAssetBounds,
  leaves: readonly VoxelBoundsLeaf[],
  step: number,
): void {
  for (const l of leaves) {
    if (l.x < bounds.minX) bounds.minX = l.x;
    if (l.y < bounds.minY) bounds.minY = l.y;
    if (l.z < bounds.minZ) bounds.minZ = l.z;
    const ex = l.x + l.size, ey = l.y + l.size, ez = l.z + l.size;
    if (ex > bounds.maxX) bounds.maxX = ex;
    if (ey > bounds.maxY) bounds.maxY = ey;
    if (ez > bounds.maxZ) bounds.maxZ = ez;
  }
  // Snap to the voxel grid so quantization stays exact.
  bounds.minX = Math.floor(bounds.minX / step) * step;
  bounds.minY = Math.floor(bounds.minY / step) * step;
  bounds.minZ = Math.floor(bounds.minZ / step) * step;
  bounds.maxX = Math.ceil(bounds.maxX / step) * step;
  bounds.maxY = Math.ceil(bounds.maxY / step) * step;
  bounds.maxZ = Math.ceil(bounds.maxZ / step) * step;
  // Restore the X/Z-centered contract (grow-only, so leaves stay enclosed).
  const halfX = Math.max(-bounds.minX, bounds.maxX);
  bounds.minX = -halfX;
  bounds.maxX = halfX;
  const halfZ = Math.max(-bounds.minZ, bounds.maxZ);
  bounds.minZ = -halfZ;
  bounds.maxZ = halfZ;
}
