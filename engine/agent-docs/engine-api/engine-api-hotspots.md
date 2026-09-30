# engine-api-hotspots

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/hotspots/BuildingInterpreter.ts
class BuildingInterpreter extends HotspotInterpreterBase<BuildingHotspot>
BuildingInterpreter.type
BuildingInterpreter.worksOnVxlTerrain
BuildingInterpreter.apply(_ctx: HotspotContext, _hotspot: BuildingHotspot): void

## engine/hotspots/HotspotInterpreter.ts
interface InjectedEnvironmentObject — Single env-object entry that an interpreter can push back into the world.
InjectedEnvironmentObject.id: string
InjectedEnvironmentObject.type: string
InjectedEnvironmentObject.assetId: string
InjectedEnvironmentObject.position: { x: number; y: number; z: number }
InjectedEnvironmentObject.rotation: { x: number; y: number; z: number }
InjectedEnvironmentObject.scale: { x: number; y: number; z: number }
InjectedEnvironmentObject.name?: string
InjectedEnvironmentObject.flattenTerrain?: boolean
InjectedEnvironmentObject.placeOnTerrain?: boolean
interface HotspotAsset — Asset metadata visible to interpreters. The interpreter reads
HotspotAsset.id: string
HotspotAsset.name?: string
HotspotAsset.type?: string
HotspotAsset.voxelSize?: number
HotspotAsset.boundingBox?: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }
HotspotAsset.naturalDimensions?: { x: number; y: number; z: number }
interface HotspotContext — Context passed to every interpreter. Decouples interpreters from the
HotspotContext.flattenArea( centerX: number, centerZ: number, width: number, depth: number, height: number, blockType?: number, rebuildMeshes?: boolean, margin?: number, ): void
HotspotContext.getHeightAt(x: number, z: number): number
HotspotContext.resolveBlockByName(name: string): number | undefined
HotspotContext.pushEnvironmentObject(envObj: InjectedEnvironmentObject): void
HotspotContext.assets: HotspotAsset[]
HotspotContext.rng: () => number
HotspotContext.setBlock?(x: number, y: number, z: number, blockType: number): void
HotspotContext.blockSize?: number
function assetDimensionsMeters(asset: HotspotAsset): { x: number; y: number; z: number }
class HotspotInterpreterBase<T extends Hotspot = Hotspot> — Base class for hotspot interpreters. Concrete interpreters MUST go through
HotspotInterpreterBase.type: T['type']
HotspotInterpreterBase.worksOnVxlTerrain: boolean
HotspotInterpreterBase.apply(ctx: HotspotContext, hotspot: T): void
class HotspotInterpreterRegistry — Registry. One instance per world-generation run. `applyAll` THROWS on:
HotspotInterpreterRegistry.register<T extends Hotspot>(interpreter: HotspotInterpreterBase<T>): void
HotspotInterpreterRegistry.has(type: string): boolean
HotspotInterpreterRegistry.applyAll(ctx: HotspotContext, hotspots: Hotspot[], opts?: { vxlTerrain?: boolean }): void

## engine/hotspots/TowerInterpreter.ts
class TowerInterpreter extends HotspotInterpreterBase<TowerHotspot>
TowerInterpreter.type
TowerInterpreter.apply(ctx: HotspotContext, hotspot: TowerHotspot): void

## engine/hotspots/VillageInterpreter.ts
class VillageInterpreter extends HotspotInterpreterBase<VillageHotspot>
VillageInterpreter.type
VillageInterpreter.apply(ctx: HotspotContext, hotspot: VillageHotspot): void

## engine/hotspots/index.ts
function buildDefaultHotspotRegistry(): HotspotInterpreterRegistry
