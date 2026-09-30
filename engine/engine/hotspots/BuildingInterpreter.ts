/**
 * BuildingInterpreter — INERT registry stub for hotspot type `building`.
 *
 * Enterable buildings are built by the ENGINE (`engine/BuildingSystem.ts`) as
 * self-contained voxel objects after world load, because the hotspot pipeline
 * runs inside per-game WorldGenerator copies that (a) never execute on baked
 * `.vxl`/VxlScene levels — where forged-city team bases live — and (b) don't
 * receive engine updates once a game is created. This stub exists ONLY so
 * `HotspotInterpreterRegistry.applyAll` in any game copy (old or new) doesn't
 * throw "no interpreter registered" for `building` entries; it intentionally
 * builds nothing.
 */

import type { BuildingHotspot } from 'types/game.js';
import {
  HotspotInterpreterBase,
  type HotspotContext,
} from 'engine/hotspots/HotspotInterpreter.js';

export class BuildingInterpreter extends HotspotInterpreterBase<BuildingHotspot> {
  readonly type = 'building' as const;
  // Suppress the vxl-terrain skip warning — the engine builds these anywhere.
  override readonly worksOnVxlTerrain = true;

  apply(_ctx: HotspotContext, _hotspot: BuildingHotspot): void {
    // Engine-built by BuildingSystem — nothing to do at world-generation time.
  }
}
