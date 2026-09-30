/**
 * VillageInterpreter — cluster of buildings within a circular region.
 *
 * Picks N positions within `radius` (where N is derived from `density` and
 * the area), and for each position:
 *   1. Pick an asset round-robin from `buildingAssetIds`.
 *   2. Compute the building's footprint from the asset's bbox or
 *      naturalDimensions (see `assetDimensionsMeters`).
 *   3. Carve a flat foundation via `withFlatFoundation` (Phase 0 mode B).
 *   4. Inject an `environmentObject` entry with `flattenTerrain: true` (the
 *      engine carves the foundation again at game-load — idempotent because
 *      `isAreaFlat` short-circuits when the terrain is already flat).
 *
 * Deterministic from the hotspot's `id` and the shared seeded RNG in context.
 */

import type { VillageHotspot } from 'types/game.js';
import {
  HotspotInterpreterBase,
  type HotspotContext,
  assetDimensionsMeters,
} from 'engine/hotspots/HotspotInterpreter.js';

/** Minimum spacing between two building centers, in meters. Prevents foundations from overlapping. */
const MIN_SPACING_METERS = 4;

/** Maximum attempts to place each building before giving up (avoids infinite loops in tight regions). */
const MAX_PLACEMENT_ATTEMPTS = 20;

/** Default density: 0.05 buildings per square meter inside the radius (≈1 building per 20m²). */
const DEFAULT_DENSITY = 0.05;

/** Margin (voxels) added to each foundation for a tidy plaza around the building. */
const FOUNDATION_MARGIN_VOXELS = 1;

export class VillageInterpreter extends HotspotInterpreterBase<VillageHotspot> {
  readonly type = 'village' as const;

  apply(ctx: HotspotContext, hotspot: VillageHotspot): void {
    if (hotspot.buildingAssetIds.length === 0) {
      throw new Error(`village id="${hotspot.id}" has empty buildingAssetIds — nothing to place.`);
    }

    // Validate every referenced asset exists in the world. Throwing here
    // surfaces typos in the agent's hotspot authoring rather than silently
    // skipping.
    const missing = hotspot.buildingAssetIds.filter(id => !ctx.assets.find(a => a.id === id));
    if (missing.length > 0) {
      throw new Error(
        `village id="${hotspot.id}" references unknown assetId(s): ${missing.join(', ')}. ` +
        `Check that each id matches an entry in worldData.assets.`,
      );
    }

    const radius = Math.max(2, hotspot.radius);
    const area = Math.PI * radius * radius;
    const density = typeof hotspot.density === 'number' ? Math.max(0, Math.min(1, hotspot.density)) : DEFAULT_DENSITY;
    const targetCount = Math.max(1, Math.floor(area * density));

    const placed: Array<{ x: number; z: number; w: number; d: number }> = [];

    for (let i = 0; i < targetCount; i++) {
      const assetId = hotspot.buildingAssetIds[i % hotspot.buildingAssetIds.length];
      const asset = ctx.assets.find(a => a.id === assetId)!;
      const dims = assetDimensionsMeters(asset);

      // Candidate position with rejection sampling — ensures buildings don't
      // overlap each other. We try MAX_PLACEMENT_ATTEMPTS positions per
      // building before giving up on this one.
      let placedThis = false;
      for (let attempt = 0; attempt < MAX_PLACEMENT_ATTEMPTS; attempt++) {
        const candidate = sampleInsideCircle(hotspot.center.x, hotspot.center.z, radius - dims.x / 2, ctx.rng);
        if (overlapsExisting(candidate.x, candidate.z, dims.x, dims.z, placed)) continue;

        // Carve foundation. Use minimum 1m for tiny assets to avoid degenerate flatten regions.
        const w = Math.max(1, dims.x);
        const d = Math.max(1, dims.z);
        const foundationY = this.withFlatFoundation(
          ctx,
          candidate.x,
          candidate.z,
          w,
          d,
          FOUNDATION_MARGIN_VOXELS,
          hotspot.foundationBlockType,
        );

        // Inject the env-object. flattenTerrain: true so the engine re-checks
        // the lot at game-load (idempotent on already-flat terrain). Y is the
        // foundation Y so the building sits flush.
        ctx.pushEnvironmentObject({
          id: `${hotspot.id}_b${i}`,
          type: 'voxelBuilding',
          assetId: asset.id,
          name: asset.name ?? asset.id,
          position: {
            x: +candidate.x.toFixed(2),
            y: +foundationY.toFixed(2),
            z: +candidate.z.toFixed(2),
          },
          rotation: { x: 0, y: 0, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
          flattenTerrain: true,
        });

        placed.push({ x: candidate.x, z: candidate.z, w, d });
        placedThis = true;
        break;
      }

      // If we couldn't place this building after MAX_PLACEMENT_ATTEMPTS, skip it
      // and try the NEXT building (which might be smaller and fit). Subsequent
      // assets in the round-robin pool may have a smaller footprint that fits
      // a tight gap. We only abort the entire village when the radius is so
      // packed that no remaining attempt could succeed — but that's a property
      // of the placement loop's combined attempts, not this single index.
      if (!placedThis) continue;
    }
  }
}

/**
 * Uniform random sample inside a circle of given radius, centered at (cx, cz).
 * Uses sqrt to keep the distribution uniform per-area (otherwise samples cluster
 * at the center).
 */
function sampleInsideCircle(cx: number, cz: number, radius: number, rng: () => number): { x: number; z: number } {
  const r = Math.sqrt(rng()) * Math.max(0, radius);
  const theta = rng() * Math.PI * 2;
  return { x: cx + r * Math.cos(theta), z: cz + r * Math.sin(theta) };
}

/** Axis-aligned overlap test with a min-spacing buffer. */
function overlapsExisting(
  x: number,
  z: number,
  w: number,
  d: number,
  placed: Array<{ x: number; z: number; w: number; d: number }>,
): boolean {
  for (const p of placed) {
    const dx = Math.abs(x - p.x);
    const dz = Math.abs(z - p.z);
    const minDX = (w + p.w) / 2 + MIN_SPACING_METERS;
    const minDZ = (d + p.d) / 2 + MIN_SPACING_METERS;
    if (dx < minDX && dz < minDZ) return true;
  }
  return false;
}
