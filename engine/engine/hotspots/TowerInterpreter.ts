/**
 * TowerInterpreter — single vertical structure with a carved flat foundation.
 *
 * The simplest interpreter: takes one asset id, one center point, carves a
 * flat lot the size of the asset's footprint plus a small margin, then injects
 * one environmentObject entry. Idempotent across reloads (engine's `isAreaFlat`
 * short-circuits when the lot is already flat).
 */

import type { TowerHotspot } from 'types/game.js';
import {
  HotspotInterpreterBase,
  type HotspotContext,
  assetDimensionsMeters,
} from 'engine/hotspots/HotspotInterpreter.js';

/** Voxel margin around the tower base for visual breathing room. */
const FOUNDATION_MARGIN_VOXELS = 2;

export class TowerInterpreter extends HotspotInterpreterBase<TowerHotspot> {
  readonly type = 'tower' as const;

  apply(ctx: HotspotContext, hotspot: TowerHotspot): void {
    const asset = ctx.assets.find(a => a.id === hotspot.assetId);
    if (!asset) {
      throw new Error(
        `tower id="${hotspot.id}" references unknown assetId="${hotspot.assetId}". ` +
        `Check that the id matches an entry in worldData.assets.`,
      );
    }

    const dims = assetDimensionsMeters(asset);
    const w = Math.max(1, dims.x);
    const d = Math.max(1, dims.z);

    const foundationY = this.withFlatFoundation(
      ctx,
      hotspot.center.x,
      hotspot.center.z,
      w,
      d,
      FOUNDATION_MARGIN_VOXELS,
      hotspot.foundationBlockType,
    );

    ctx.pushEnvironmentObject({
      id: `${hotspot.id}_tower`,
      type: 'voxelTower',
      assetId: asset.id,
      name: asset.name ?? asset.id,
      position: {
        x: +hotspot.center.x.toFixed(2),
        y: +foundationY.toFixed(2),
        z: +hotspot.center.z.toFixed(2),
      },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      flattenTerrain: true,
    });
  }
}
