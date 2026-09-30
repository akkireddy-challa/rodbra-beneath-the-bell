import { expandBoundsToFitLeaves, type VoxelBoundsLeaf } from 'engine/VoxelAssetBounds.js';

/**
 * An asset bake publishes bounds that are X/Z CENTERED on the origin (see
 * `ExtractedGlb.bounds`). `VoxelObject` derives its render pivot from the
 * bounds CENTRE, so a lopsided box shifts the whole model sideways — that is
 * how a forged kart's body ended up 8 cm off its wheels while the source GLB
 * was perfectly symmetric (measured: body ±0.4462, wheels ±0.3768/±0.4885).
 */

const leaf = (x: number, y: number, z: number, size: number): VoxelBoundsLeaf =>
  ({ x, y, z, size });

/** Fresh symmetric starting box, as extractGlbForVoxelization builds it. */
const boundsOf = (halfX: number, height: number, halfZ: number) =>
  ({ minX: -halfX, minY: 0, minZ: -halfZ, maxX: halfX, maxY: height, maxZ: halfZ });

describe('asset bake bounds stay X/Z centered', () => {
  it('a coarse LOD step that pushes ONE side out keeps the box centered', () => {
    // The real regression: content symmetric at ±0.48, but a coarse-step snap
    // pushed minX to -0.64 while +0.48 was already grid-aligned, giving
    // [-0.64, +0.48] — centre -0.08, i.e. an 8 cm sideways shift.
    const bounds = boundsOf(0.48, 0.96, 1.24);
    expandBoundsToFitLeaves(bounds, [leaf(-0.60, 0, -0.16, 0.16)], 0.16);

    expect((bounds.minX + bounds.maxX) / 2).toBeCloseTo(0, 10);
    expect((bounds.minZ + bounds.maxZ) / 2).toBeCloseTo(0, 10);
    // Grew (never shrank) to enclose the leaf.
    expect(bounds.minX).toBeLessThanOrEqual(-0.60);
    expect(bounds.maxX).toBeGreaterThanOrEqual(0.48);
  });

  it('encloses every leaf on both sides while staying centered', () => {
    const bounds = boundsOf(0.5, 1, 0.5);
    const leaves = [leaf(-0.9, 0, -0.3, 0.1), leaf(0.7, 0, 0.62, 0.1)];
    expandBoundsToFitLeaves(bounds, leaves, 0.1);

    for (const l of leaves) {
      expect(l.x).toBeGreaterThanOrEqual(bounds.minX);
      expect(l.x + l.size).toBeLessThanOrEqual(bounds.maxX);
      expect(l.z).toBeGreaterThanOrEqual(bounds.minZ);
      expect(l.z + l.size).toBeLessThanOrEqual(bounds.maxZ);
    }
    expect((bounds.minX + bounds.maxX) / 2).toBeCloseTo(0, 10);
    expect((bounds.minZ + bounds.maxZ) / 2).toBeCloseTo(0, 10);
  });

  it('leaves Y alone — its contract is base-at-0, not centered', () => {
    const bounds = boundsOf(0.5, 1, 0.5);
    expandBoundsToFitLeaves(bounds, [leaf(0, 1.05, 0, 0.1)], 0.1);
    expect(bounds.minY).toBe(0);
    expect(bounds.maxY).toBeGreaterThanOrEqual(1.15);
  });

  it('is idempotent across repeated LOD passes (each pass may only grow)', () => {
    const bounds = boundsOf(0.48, 0.96, 1.24);
    expandBoundsToFitLeaves(bounds, [leaf(-0.60, 0, -0.16, 0.16)], 0.16);
    const after = { ...bounds };
    expandBoundsToFitLeaves(bounds, [leaf(-0.60, 0, -0.16, 0.16)], 0.16);
    expect(bounds).toEqual(after);
  });
});
