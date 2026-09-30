/**
 * Hotspot subsystem entry points. The WorldGenerator imports `buildDefaultHotspotRegistry`
 * once per generate() and applies it via `registry.applyAll(ctx, hotspots)`.
 *
 * To add a new hotspot type:
 *   1. Extend `Hotspot` discriminated union in `types/game.ts`.
 *   2. Implement `class FooInterpreter extends HotspotInterpreterBase<FooHotspot>`.
 *   3. Register it inside `buildDefaultHotspotRegistry()` below.
 *   4. Extend the validator in `validate-world-json-tool.ts` with schema checks for the new shape.
 */

import { HotspotInterpreterRegistry } from 'engine/hotspots/HotspotInterpreter.js';
import { VillageInterpreter } from 'engine/hotspots/VillageInterpreter.js';
import { TowerInterpreter } from 'engine/hotspots/TowerInterpreter.js';
import { BuildingInterpreter } from 'engine/hotspots/BuildingInterpreter.js';

export {
  HotspotInterpreterBase,
  HotspotInterpreterRegistry,
  assetDimensionsMeters,
} from 'engine/hotspots/HotspotInterpreter.js';
export type {
  HotspotContext,
  HotspotAsset,
  InjectedEnvironmentObject,
} from 'engine/hotspots/HotspotInterpreter.js';
export { VillageInterpreter } from 'engine/hotspots/VillageInterpreter.js';
export { TowerInterpreter } from 'engine/hotspots/TowerInterpreter.js';
export { BuildingInterpreter } from 'engine/hotspots/BuildingInterpreter.js';

/**
 * Build a registry pre-populated with every shipping interpreter. One call per
 * world-generation run.
 */
export function buildDefaultHotspotRegistry(): HotspotInterpreterRegistry {
  const registry = new HotspotInterpreterRegistry();
  registry.register(new VillageInterpreter());
  registry.register(new TowerInterpreter());
  registry.register(new BuildingInterpreter());
  return registry;
}
