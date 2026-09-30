# engine-api-world-env

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/AssetSpawner.ts
interface SpawnAssetOptions
SpawnAssetOptions.position: { x: number; y: number; z: number }
SpawnAssetOptions.rotation: { x: number; y: number; z: number }
SpawnAssetOptions.scale: number
SpawnAssetOptions.name: string | null
SpawnAssetOptions.collision: boolean
SpawnAssetOptions.collectible: { radius: number; onCollect: ((spawned: SpawnedAsset) => void) | null } | null
SpawnAssetOptions.parent: THREE.Object3D | null
SpawnAssetOptions.shadows: boolean
const DEFAULT_SPAWN_ASSET_OPTIONS: SpawnAssetOptions
interface SpawnedAsset
SpawnedAsset.object: THREE.Object3D
SpawnedAsset.objectId: string
SpawnedAsset.name: string
SpawnedAsset.collectibleComponent: CollectibleComponent | null
SpawnedAsset.dispose(): void
class AssetSpawner
AssetSpawner.constructor(engine: EngineLike)
AssetSpawner.spawn(assetIdOrName: string, options: SpawnAssetOptions): Promise<SpawnedAsset | null>
AssetSpawner.dispose(): void

## engine/BuildingSystem.ts
interface ShellCell — One cell of the building shell in the object's voxel grid (h=0 is the floor slab row).
ShellCell.i: number
ShellCell.h: number
ShellCell.k: number
ShellCell.part: 'floor' | 'wall' | 'roof'
interface RasterizedShell
RasterizedShell.ox: number
RasterizedShell.oz: number
RasterizedShell.hCells: number
RasterizedShell.cells: ShellCell[]
RasterizedShell.autoDoor: boolean
function rasterizeBuildingShell(spec: BuildingHotspot, bs: number): RasterizedShell
class BuildingSystem
BuildingSystem.constructor(engine: EngineLike)
BuildingSystem.update(): void
BuildingSystem.dispose(): void

## engine/Constants.ts
interface GameConstants — Game Constants Interface
GameConstants.interactionRange: number
const DEFAULT_CONSTANTS: GameConstants
function mergeConstants(templateConstants?: Partial<GameConstants>): GameConstants

## engine/EnvGlbPhysics.ts
interface GlbDynamicEngineRef — Structural slice of GameEngine needed to register dynamic GLB bodies with
GlbDynamicEngineRef.getDynamicObjectManager?: () => { register(obj: ChunkManagedObject, type: string, radius?: number): void; unregister?(obj: ChunkManagedObject): void; updatePosition(obj: ChunkManagedObject): void; getVoxelFloorY(x: number, feetY: number, z: number): number | null; }
function createGlbBoxColliders(physicsWorld: PhysicsWorld, worldBodies: unknown[], object: THREE.Group): void
function glbWorldPhysicsBoxes(object: THREE.Group): PhysicsBox[]
function createGlbPlaneLockedColliders(physicsWorld: PlaneLockedPhysics, worldBodies: unknown[], object: THREE.Group): void
function createDynamicGlbBody(physicsWorld: PhysicsWorld, object: THREE.Group, engine: GlbDynamicEngineRef | null): { syncWithPhysics(): void; dispose(): void }
function collectGlbTriangleSoup(root: THREE.Object3D, include: (mesh: THREE.Mesh) => boolean = () => true): { verts: Float32Array; indices: Uint32Array }
function createGlbTrimeshCollider(physicsWorld: PhysicsWorld, worldBodies: unknown[], object: THREE.Group, asset: Asset, recenterOffset: THREE.Vector3, visualScale: THREE.Vector3 = object.scale): Promise<void>

## engine/EnvObjectPackOps.ts
function unpackInstancedMeshes(sys: EnvironmentObjectSystem, typeName?: string): void
function packInstancedMeshes(sys: EnvironmentObjectSystem, typeName?: string): void

## engine/EnvironmentObjectCarve.ts
function promoteEnvInstanceForCarving(system: EnvironmentObjectSystem, typeName: string, instanceIndex: number, template: VoxelObject): VoxelObject | null

## engine/EnvironmentObjectSystem.ts
function setEnvironmentObjectSystemEngine(engine: any): void
function getActiveEnvironmentObjectSystem(): EnvironmentObjectSystem | null
function serializeEnvironmentObject(registrationData: Record<string, unknown>, id: string, position: { x: number; y: number; z: number }, rotation: { x: number; y: number; z: number }, scale: { x: number; y: number; z: number }): Record<string, unknown>
interface FoliageClearable — Interface for foliage systems that can clear foliage at specific positions.
FoliageClearable.clearFoliageAt(x: number, z: number, radius: number): void
interface EnvironmentObjectData — Interactive environment objects (trees, rocks, etc.) follow the InstancedMesh pattern.
EnvironmentObjectData.cubes: EnvironmentCube[]
EnvironmentObjectData.mergedGeometry: THREE.BufferGeometry
EnvironmentObjectData.mesh: THREE.Mesh | THREE.Object3D
EnvironmentObjectData.instanceId?: number
EnvironmentObjectData.scale?: { width: number; height: number; depth: number }
EnvironmentObjectData.voxelObject?: THREE.Object3D
interface EnvironmentInstance
EnvironmentInstance.data: EnvironmentObjectData
EnvironmentInstance.x: number
EnvironmentInstance.z: number
EnvironmentInstance.y: number
EnvironmentInstance.rotation?: number
EnvironmentInstance.rotationXYZ?: { x: number; y: number; z: number }
EnvironmentInstance.scale?: { width: number; height: number; depth: number }
EnvironmentInstance.objDef?: any
interface EnvironmentObjectType — Registry entry for an environment object type.
EnvironmentObjectType.typeName: string
EnvironmentObjectType.factory: () => EnvironmentObjectData
EnvironmentObjectType.canPlace: (x: number, z: number, terrainHeightProvider: TerrainHeightProvider, terrainRegistry: TerrainTypeRegistry) => boolean
EnvironmentObjectType.proceduralCount: number
EnvironmentObjectType.createInstancedMesh: ( instances: EnvironmentInstance[], instancedMesh: THREE.InstancedMesh | null, instanceData: EnvironmentObjectData[], world: THREE.Object3D, worldBodies: any[], material: THREE.MeshStandardMaterial, physicsWorld: PhysicsWorld | null ) => { instancedMesh: THREE.InstancedMesh; instanceData: EnvironmentObjectData[] }
EnvironmentObjectType.createPhysics: (instance: EnvironmentInstance, worldBodies: any[], physicsWorld: PhysicsWorld | null) => void
EnvironmentObjectType.getPlacementY: (instance: EnvironmentInstance, terrainHeightProvider: TerrainHeightProvider, groundOffset: number) => number
EnvironmentObjectType.getClearRadius: (instance: EnvironmentInstance) => number
EnvironmentObjectType.getClearSize: (instance: EnvironmentInstance) => { width: number; depth: number }
const DEFAULT_DISABLE_FRUSTUM_CULLING = false
class EnvironmentObjectSystem
static EnvironmentObjectSystem.SHADOW_ONLY_LAYER
EnvironmentObjectSystem.constructor(world: THREE.Object3D, worldBodies: any[], rng: SeededRandom, worldSize: number, terrainHeightProvider: TerrainHeightProvider, terrainRegistry: TerrainTypeRegistry, foliageSystem: FoliageClearable | null, groundOffset: number, worldProfileData: WorldProfileData, gameData: GameData | null = null, physicsWorld: PhysicsWorld | null = null)
EnvironmentObjectSystem.registerEnvironmentObjectType(type: EnvironmentObjectType): void
EnvironmentObjectSystem.setChunkParentProvider(provider: (chunkKey: string) => THREE.Object3D | null): void
EnvironmentObjectSystem.getEnvironmentMaterial(): THREE.MeshStandardMaterial | null
EnvironmentObjectSystem.getRng(): SeededRandom
EnvironmentObjectSystem.setOnBeforePhysicsStep(callback: () => void): void
EnvironmentObjectSystem.getTerrainHeightProvider(): TerrainHeightProvider
EnvironmentObjectSystem.getTerrainRegistry(): TerrainTypeRegistry
EnvironmentObjectSystem.isPositionOccupied(x: number, z: number, checkRadius: number = 1.0, maxObjectRadius: number | null = null): boolean
EnvironmentObjectSystem.registerPlacedPosition(x: number, z: number, radius: number): void
EnvironmentObjectSystem.getAllPlacedPositions(): Array<{ x: number; z: number; radius: number }>
EnvironmentObjectSystem.getGroundOffset(): number
EnvironmentObjectSystem.getInstanceCount(typeName: string): number
EnvironmentObjectSystem.getVoxelObjects(typeName: string): THREE.Object3D[]
EnvironmentObjectSystem.collectExportMeshesForTypes(typeNames: Set<string>): THREE.Object3D[]
EnvironmentObjectSystem.removeVoxelObjectFromStorage(voxelObject: THREE.Object3D): boolean
EnvironmentObjectSystem.getRegisteredTypeNames(): string[]
EnvironmentObjectSystem.reloadForLevel(_activeLevelId: string): Promise<void>
EnvironmentObjectSystem.initializeEnvironmentTexture(colors?: { trunk?: string; leaves?: string; rock?: string; }): void
EnvironmentObjectSystem.generateScenery(): Promise<void>
EnvironmentObjectSystem.createStandardInstancedMesh(typeName: string, instances: EnvironmentInstance[], instancedMesh: THREE.InstancedMesh | null, instanceData: EnvironmentObjectData[], world: THREE.Object3D, worldBodies: any[], material: THREE.MeshStandardMaterial): { instancedMesh: THREE.InstancedMesh; instanceData: EnvironmentObjectData[] }
EnvironmentObjectSystem.unpackInstancedMeshes(typeName?: string): void
EnvironmentObjectSystem.packInstancedMeshes(typeName?: string): void
EnvironmentObjectSystem.isTypeUnpacked(typeName: string): boolean
EnvironmentObjectSystem.getEnvTypeForObject(object: THREE.Object3D): string | null
EnvironmentObjectSystem.getTypeInstanceCount(typeName: string): number
EnvironmentObjectSystem.findUnpackedMeshNear(typeName: string, position: THREE.Vector3): THREE.Object3D | null
EnvironmentObjectSystem.restoreLogicalInstanceMatrices(): void
EnvironmentObjectSystem.markEnvironmentObjectsModified(): void
EnvironmentObjectSystem.serializeEnvironmentObjects(): any[]
EnvironmentObjectSystem.getInstanceCounts(): Map<string, number>
EnvironmentObjectSystem.hasEnvironmentObjectModifications(): boolean
EnvironmentObjectSystem.updateLodConfigForAsset(assetId: string, voxelizeSettings: { additionalLods?: Array<{ distance?: number }> } | undefined): void
EnvironmentObjectSystem.updateInstanceCulling(camera: THREE.Camera, shadowCamera?: THREE.Camera | null): void
EnvironmentObjectSystem.setCullingEnabled(enabled: boolean): void
EnvironmentObjectSystem.isCullingEnabled(): boolean
EnvironmentObjectSystem.setRenderRegion(region: THREE.Box3 | null): void
EnvironmentObjectSystem.setMaxRenderDistance(distance: number): void
EnvironmentObjectSystem.reapplyQualityScale(): void
EnvironmentObjectSystem.getMaxRenderDistance(): number
EnvironmentObjectSystem.updateVisibility(camera: THREE.Camera): void
EnvironmentObjectSystem.setVoxelSize(size: number): void
EnvironmentObjectSystem.setVoxelTerrainSystem(voxelTerrainSystem: any): void
EnvironmentObjectSystem.setEngine(engine: any): void
EnvironmentObjectSystem.setChunkPhysicsEnabled(chunkKey: string, enabled: boolean): void

## engine/FoliageSystem.ts
interface FoliageRegion
FoliageRegion.centerX: number
FoliageRegion.centerZ: number
FoliageRegion.mesh: THREE.Mesh | null
FoliageRegion.recreate: () => THREE.Mesh | null
class FoliageSystem
FoliageSystem.appearance: FoliageAppearance
FoliageSystem.constructor(world: THREE.Object3D, worldSizeX: number, worldSizeZ: number, resolution: number, seed: number, terrainRegistry: TerrainTypeRegistry, heightmapSystem: HeightmapSystem, appearance: Partial<FoliageAppearance> = {})
FoliageSystem.initializeFoliageTexture(colors?: { grass?: string; flowerPetals?: string; flowerStems?: string; pebbles?: string; }): void
FoliageSystem.generateFoliage(): void
FoliageSystem.recreateRegionAt(x: number, z: number): void
FoliageSystem.clearFoliageAt(x: number, z: number, radius: number): void
FoliageSystem.dispose(): void

## engine/GoldenPathVisualizer.ts
class GoldenPathVisualizer
GoldenPathVisualizer.constructor(engine: EngineLike)
GoldenPathVisualizer.toggle(): void
GoldenPathVisualizer.dispose(): void

## engine/GroundPlacement.ts
interface GroundSources — Everything the resolver reads about the world. GameEngine fills these from the live systems.
GroundSources.physicsWorld: PhysicsWorld | null
GroundSources.bounds: TerrainBounds | null
GroundSources.voxelWorld: VoxelWorld | null
interface GroundPlacementOptions
GroundPlacementOptions.sampleRadius: number
GroundPlacementOptions.boundsMargin: number
GroundPlacementOptions.clampToBounds: boolean
const DEFAULT_GROUND_PLACEMENT_OPTIONS: GroundPlacementOptions
type GroundPlacement = | { status: 'ok'; /** Standable point: the requested X/Z (clamped if asked for) at the resolved surface Y. */ position: THREE.Vector3; groundY: number; /** True when X/Z had to be pulled inside the terrain bounds. */ clampedToBounds: boolean; } | { status: 'out-of-bounds'; /** Bounds the point failed against — the ACTUAL map extent, not a configured size. */ bounds: TerrainBounds; /** Closest X/Z that would have passed, for callers that want to retry inward. */ nearestX: number; nearestZ: number; } | { status: 'no-ground'; /** The X/Z that was sampled (post-clamp). */ x: number; z: number; bounds: TerrainBounds | null; }
function raycastGroundY(physicsWorld: PhysicsWorld | null, x: number, z: number): number | null
function sampleVoxelColumnTopY(voxelWorld: VoxelWorld | null, x: number, z: number): number | null
function sampleGroundY(sources: GroundSources, x: number, z: number): number | null
function sampleLowestGroundY(sources: GroundSources, x: number, z: number, radius: number): number | null
function queryGroundPlacement(sources: GroundSources, x: number, z: number, options: GroundPlacementOptions): GroundPlacement

## engine/HeightmapSystem.ts
interface HeightmapData
HeightmapData.width: number
HeightmapData.height: number
HeightmapData.heights: Float32Array
HeightmapData.minX: number
HeightmapData.maxX: number
HeightmapData.minZ: number
HeightmapData.maxZ: number
HeightmapData.minY: number
HeightmapData.maxY: number
interface HeightmapConfig — Configuration for heightmap terrain generation.
HeightmapConfig.noise?: { /** Base noise scale (default: 0.1) - smaller = smoother terrain */ scale?: number; /** Height multiplier (default: 1.25) - larger = more dramatic hills */ heightMultiplier?: number; /** Center depression factor (default: 0.5) - how much terrain dips toward center */ centerDepression?: number; }
HeightmapConfig.heightLimits?: { /** Minimum terrain height (default: -2) */ min?: number; /** Maximum terrain height (default: 3) */ max?: number; }
HeightmapConfig.terrainThresholds?: { /** Height below which terrain becomes ice (default: -2) */ iceHeight?: number; /** Height above which terrain becomes stone (default: 5) */ stoneHeight?: number; /** Noise threshold for sand/beach areas (default: 0.7) */ sandNoiseThreshold?: number; /** Noise scale for terrain type variation (default: 0.05) */ terrainNoiseScale?: number; }
HeightmapConfig.terrainTypes?: { /** Ice terrain type ID (default: 4) */ ice?: number; /** Stone terrain type ID (default: 7) */ stone?: number; /** Sand terrain type ID (default: 2) */ sand?: number; /** Grass terrain type ID (default: 1) */ grass?: number; }
class HeightmapSystem implements TerrainHeightProvider — HeightmapSystem - Manages procedural heightmap generation.
HeightmapSystem.constructor(worldSizeX: number, worldSizeZ: number, resolution: number, seed: number, terrainRegistry: TerrainTypeRegistry, config?: HeightmapConfig)
HeightmapSystem.markDirty(): void
HeightmapSystem.markClean(): void
HeightmapSystem.getDirty(): boolean
HeightmapSystem.loadHeightmapData(data: HeightmapData): void
HeightmapSystem.generateHeightmap(): HeightmapData
HeightmapSystem.getHeightAt(x: number, z: number): number
HeightmapSystem.levelHeightmapAt(x: number, z: number, radius: number, targetHeight: number, flat: boolean = false): void
HeightmapSystem.levelHeightmapRect(x: number, z: number, widthX: number, widthZ: number, targetHeight: number, flat: boolean = true): void
HeightmapSystem.generateTerrainTypeMap(): Uint8Array
HeightmapSystem.getTerrainTypeAt(x: number, z: number): number
HeightmapSystem.setTerrainTypeAt(x: number, z: number, radius: number, type: number): void
HeightmapSystem.setTerrainTypeRect(x: number, z: number, widthX: number, widthZ: number, type: number): void
HeightmapSystem.getHeightmapData(): HeightmapData | null
HeightmapSystem.getTerrainTypeMap(): Uint8Array | null
HeightmapSystem.ensureLevelSurfaceAt(x: number, z: number, radius: number): void
HeightmapSystem.resizeHeightmap(newWorldSizeX: number, newWorldSizeZ: number, newResolution: number, defaultTerrainType: number = 1): void
static HeightmapSystem.loadHeightmapFromUrl(url: string): Promise<HeightmapData | null>
static HeightmapSystem.loadHeightmapFromBackend(gameId: string): Promise<HeightmapData | null>
static HeightmapSystem.resizeHeightmapData(data: HeightmapData, newWorldSizeX: number, newWorldSizeZ: number, newResolution: number, resolutionChanged: boolean): HeightmapData

## engine/PlacedObjectSystem.ts
interface PlacedObjectData
PlacedObjectData.id: string
PlacedObjectData.type?: string
PlacedObjectData.levelId?: string
PlacedObjectData.assetId: string
PlacedObjectData.position: { x: number; y: number; z: number }
PlacedObjectData.rotation: { x: number; y: number; z: number }
PlacedObjectData.scale?: { x: number; y: number; z: number }
PlacedObjectData.boundingBox?: BoundingBox
PlacedObjectData.collision?: boolean
class PlacedObjectSystem
PlacedObjectSystem.constructor(scene: THREE.Scene, engine: EngineLike)
PlacedObjectSystem.createPlacedObject(assetId: string, position: THREE.Vector3, rotation: THREE.Euler, boundingBox?: BoundingBox): Promise<PlacedObjectData>
PlacedObjectSystem.getPlacedObject(id: string): THREE.Object3D | null
PlacedObjectSystem.removePlacedObject(id: string): void
PlacedObjectSystem.loadPlacedObjects(placedObjectsData: PlacedObjectData[]): Promise<void>
PlacedObjectSystem.serializePlacedObjects(): PlacedObjectData[]

## engine/PlacementHelper.ts
interface PlacementResult
PlacementResult.position: THREE.Vector3
PlacementResult.normal: THREE.Vector3
PlacementResult.onGround: boolean
class PlacementHelper
static PlacementHelper.findGroundHeight(physicsWorld: PhysicsWorld, x: number, z: number): number
static PlacementHelper.findGroundHeightOrNull(physicsWorld: PhysicsWorld, x: number, z: number): number | null
static PlacementHelper.findLowestGroundHeight(physicsWorld: PhysicsWorld, x: number, z: number, radius: number = 1.0): number
static PlacementHelper.isTerrainFlat(physicsWorld: PhysicsWorld, x: number, z: number, width: number, length: number, maxHeightVariance: number = 0.5): boolean
static PlacementHelper.findFlatPosition(physicsWorld: PhysicsWorld, target: { x: number; z: number }, width: number, length: number, maxHeightVariance: number = 0.5, maxSearchRadius: number = 30, step: number = 3): { x: number; z: number } | null
PlacementHelper.constructor(scene: THREE.Scene)
PlacementHelper.findPlacement(object: THREE.Object3D, x: number, z: number): PlacementResult | null
PlacementHelper.findPlacementInRadius(object: THREE.Object3D, x: number, z: number, radius: number = 2, attempts: number = 8): PlacementResult | null
PlacementHelper.findGroundHeightAt(x: number, z: number, excludeObject?: THREE.Object3D): number | null
PlacementHelper.isAnythingAbove(x: number, y: number, z: number, maxDistance: number = 6, excludeObject?: THREE.Object3D): boolean
PlacementHelper.setMaxRayHeight(height: number): void
PlacementHelper.setMinClearanceHeight(height: number): void

## engine/SpawnHelper2D.ts
function findValidSpawnPosition2D(physicsWorld: PhysicsWorld2D, spawnX: number, spawnY: number, capsuleHalfHeight: number): { x: number; y: number }

## engine/SpawnedGlbResources.ts
function cloneSpawnedGlb(template: THREE.Object3D): { object: THREE.Object3D; dispose: () => void }
function disposeGlbTemplate(scene: THREE.Object3D): void

## engine/Spawner.ts
type CustomPositionFn = (objectTransform: ObjectTransform) => THREE.Vector3
enum SpawnRelation { ON_TOP, BESIDE, IN_FRONT, BEHIND }
interface RelativeSpawnOptions — Options for spawning relative to an object
RelativeSpawnOptions.relation?: SpawnRelation
RelativeSpawnOptions.customPosition?: CustomPositionFn
RelativeSpawnOptions.offset?: { x?: number; y?: number; z?: number }
RelativeSpawnOptions.side?: 'left' | 'right'
RelativeSpawnOptions.distance?: number
const INTERIOR_PROBE_ABOVE_M = 1.5
const INTERIOR_MAX_DROP_M = 12
class Spawner — Spawner - Generic entity spawning system with ground height detection
Spawner.constructor(engine: EngineLike)
Spawner.getGroundHeight(x: number, z: number, searchHeight: number = 100): number | null
Spawner.getGroundHeightBelow(x: number, z: number, fromY: number): number | null
Spawner.calculateSpawnPosition(xz: { x: number; z: number }, heightOffset: number): THREE.Vector3 | null
Spawner.calculateSpawnPositionRelativeTo(referencePos: { x: number; z: number }, offset: { x: number; z: number }, heightOffset: number): THREE.Vector3 | null
Spawner.isValidPosition(position: { x: number; z: number }): boolean
Spawner.findNearbyValidPosition(target: { x: number; z: number }, maxSearchRadius: number = 20, step: number = 2): { x: number; z: number } | null
Spawner.calculateSpawnPositionWithFallback(xz: { x: number; z: number }, heightOffset: number, searchRadius: number = 20): THREE.Vector3 | null
Spawner.getEngine(): EngineLike
Spawner.getPlayerSpawnPosition(): THREE.Vector3
Spawner.isOpenArea(x: number, z: number, checkRadius: number = 1.5): boolean
Spawner.isOpenAreaAtHeight(x: number, z: number, groundY: number, checkRadius: number = 1.5): boolean
Spawner.isPositionFree(x: number, z: number, occupiedRadius: number = 2.0, additionalChecks?: { /** Current player position (if available) */ playerPosition?: { x: number; z: number }; /** Positions already occupied by other spawned entities */ occupiedPositions?: Array<{ x: number; z: number; radius?: number }>; /** Callback to check environment objects (trees, rocks, etc.) */ isEnvironmentOccupied?: (x: number, z: number, radius: number) => boolean; }): boolean
Spawner.findValidSpawnPositionNear(targetPos: THREE.Vector3, options: { minDistance?: number; maxDistance?: number; occupiedRadius?: number; step?: number; /** Current player position (if available at runtime) */ playerPosition?: { x: number; z: number }; /** Positions already occupied by spawned entities */ occupiedPositions?: Array<{ x: number; z: number; radius?: number }>; /** Callback to check environment objects (trees, rocks, etc.) */ isEnvironmentOccupied?: (x: number, z: number, radius: number) => boolean; } = {}): THREE.Vector3 | null
Spawner.calculateRelativePosition(objectTransform: ObjectTransform, options: RelativeSpawnOptions): THREE.Vector3
Spawner.validateAndAdjustPosition(targetPosition: THREE.Vector3, relation: SpawnRelation): THREE.Vector3 | null

## engine/TerrainMeshSystem.ts
interface TerrainMeshConfig — Configuration for terrain mesh rendering.
TerrainMeshConfig.material?: { /** Roughness of the ground surface (default: 0.95) - 0 = shiny, 1 = matte */ roughness?: number; /** Metalness of the ground surface (default: 0.0) - 0 = non-metal, 1 = metal */ metalness?: number; /** Emissive color hex value (default: 0x000000) - makes ground glow */ emissive?: number; /** Emissive intensity (default: 0.0) - how strongly ground glows */ emissiveIntensity?: number; }
TerrainMeshConfig.physics?: { /** Friction coefficient (default: 0.7) - higher = more grip */ friction?: number; /** Restitution/bounciness (default: 0.0) - higher = more bouncy */ restitution?: number; }
class TerrainMeshSystem
TerrainMeshSystem.constructor(world: THREE.Object3D, engine: EngineLike | null, heightmapSystem: HeightmapSystem, terrainRegistry: TerrainTypeRegistry, resolution: number, groundRenderingType: 'smooth' | 'polygonal', groundSettings: { polygonSize: number; worldSizeX: number; worldSizeZ: number; yGranularity: number; }, config?: TerrainMeshConfig)
TerrainMeshSystem.generateGroundMesh(): void
TerrainMeshSystem.setGroundRenderingType(renderingType: 'smooth' | 'polygonal'): void
TerrainMeshSystem.regenerateGroundMesh(affectedChunkKeys?: Set<string>): void
TerrainMeshSystem.updateVisualMeshesOnly(affectedChunkKeys?: Set<string>): void
TerrainMeshSystem.regenerateColormap(): void
TerrainMeshSystem.regenerateTerrain(): void
TerrainMeshSystem.addTerrainFeature(centerX: number, centerZ: number, widthX: number, widthZ: number, terrainType: number, height?: number): void
TerrainMeshSystem.getGroundChunkGroup(): THREE.Group | null
TerrainMeshSystem.getGroundChunkData(): GroundChunkData[]

## engine/TerrainTypeProvider.ts
interface TerrainTypeProvider — Interface for terrain type queries and modifications.
TerrainTypeProvider.getTerrainTypeAt(x: number, z: number): number
TerrainTypeProvider.setTerrainTypeAt(x: number, z: number, radius: number, type: number): void
TerrainTypeProvider.setTerrainTypeRect(x: number, z: number, widthX: number, widthZ: number, type: number): void
interface TerrainHeightProvider — Extended interface that also provides height queries.
TerrainHeightProvider.getHeightAt(x: number, z: number): number

## engine/TerrainTypes.ts
enum FoliageType { NONE, MEADOW, FIELD, BEACH, FOREST, DESERT }
interface FoliageTypeProperties — Properties for a foliage type.
FoliageTypeProperties.name: string
class FoliageTypeRegistry — Registry for foliage types.
FoliageTypeRegistry.constructor()
FoliageTypeRegistry.registerType(properties: FoliageTypeProperties): number
FoliageTypeRegistry.getType(id: number): FoliageTypeProperties | undefined
FoliageTypeRegistry.isBuiltIn(id: number): boolean
FoliageTypeRegistry.getAllTypes(): Map<number, FoliageTypeProperties>
interface FluidProperties — Fluid physics properties for non-solid terrain types (water, lava, slime, etc.)
FluidProperties.density: number
FluidProperties.buoyancyMultiplier: number
FluidProperties.viscosity: number
FluidProperties.maxSubmersionDepth: number
FluidProperties.waveStiffness: number
FluidProperties.waveDamping: number
FluidProperties.wavePropagationSpeed: number
FluidProperties.waveAmplitudeDecay: number
const DEFAULT_FLUID_PROPERTIES: FluidProperties
interface TerrainTypeProperties — Terrain/block material properties.
TerrainTypeProperties.name: string
TerrainTypeProperties.foliageType: number
TerrainTypeProperties.canPlaceTrees?: boolean
TerrainTypeProperties.canPlaceRocks?: boolean
TerrainTypeProperties.color?: { r: number; g: number; b: number }
TerrainTypeProperties.damagePerSecond?: number
TerrainTypeProperties.isSolid?: boolean
TerrainTypeProperties.fluidProperties?: FluidProperties
TerrainTypeProperties.opacity?: number
const TERRAIN_FLAGS = { FOLIAGE_BIT: 0x01, ENVIRONMENT_OBJECTS_BIT: 0x02 }
function getBaseTerrainType(encodedType: number): number
function hasFoliageFlag(encodedType: number): boolean
function hasEnvironmentObjectsFlag(encodedType: number): boolean
function encodeTerrainType(baseType: number, allowFoliage: boolean, allowEnvironmentObjects: boolean): number
class TerrainTypeRegistry
TerrainTypeRegistry.constructor()
TerrainTypeRegistry.getNextId(): number
TerrainTypeRegistry.registerType(id: number, properties: TerrainTypeProperties): void
TerrainTypeRegistry.getType(id: number): TerrainTypeProperties | undefined
TerrainTypeRegistry.getAllTypes(): Map<number, TerrainTypeProperties>
TerrainTypeRegistry.getNextAvailableId(): number
function createGrassTerrainType(registry: TerrainTypeRegistry): number
function createSandTerrainType(registry: TerrainTypeRegistry): number
function createAsphaltTerrainType(registry: TerrainTypeRegistry): number
function createIceTerrainType(registry: TerrainTypeRegistry): number
function createLavaTerrainType(registry: TerrainTypeRegistry): number
function createDirtTerrainType(registry: TerrainTypeRegistry): number
function createStoneTerrainType(registry: TerrainTypeRegistry): number
function createWaterTerrainType(registry: TerrainTypeRegistry): number
function createSwimmableLavaTerrainType(registry: TerrainTypeRegistry): number
function createSlimeTerrainType(registry: TerrainTypeRegistry): number
function createQuicksandTerrainType(registry: TerrainTypeRegistry): number
function createCustomFluidTerrainType(registry: TerrainTypeRegistry, name: string, color: { r: number; g: number; b: number }, fluidProperties: FluidProperties, options?: { opacity?: number; damagePerSecond?: number; }): number

## engine/TerrainWalkability.ts
const DEFAULT_MAX_TRAPPED_BASIN_COLUMNS = 64
interface TerrainWalkabilityOptions
TerrainWalkabilityOptions.heights: readonly number[]
TerrainWalkabilityOptions.sizeX: number
TerrainWalkabilityOptions.sizeZ: number
TerrainWalkabilityOptions.maxStep: number
TerrainWalkabilityOptions.excluded?: readonly boolean[]
TerrainWalkabilityOptions.maxBasinColumns?: number
TerrainWalkabilityOptions.quantum?: number
TerrainWalkabilityOptions.maxPasses?: number
interface TerrainBasinDiagnostic — One connected basin the validator found.
TerrainBasinDiagnostic.columns: number
TerrainBasinDiagnostic.floorHeight: number
TerrainBasinDiagnostic.rimHeight: number
TerrainBasinDiagnostic.spillHeight: number
TerrainBasinDiagnostic.minX: number
TerrainBasinDiagnostic.maxX: number
TerrainBasinDiagnostic.minZ: number
TerrainBasinDiagnostic.maxZ: number
TerrainBasinDiagnostic.intended: boolean
TerrainBasinDiagnostic.raisedColumns: number
interface TerrainWalkabilityReport
TerrainWalkabilityReport.heights: number[]
TerrainWalkabilityReport.basins: TerrainBasinDiagnostic[]
TerrainWalkabilityReport.raisedColumns: number
TerrainWalkabilityReport.passes: number
TerrainWalkabilityReport.incomplete: boolean
function repairTerrainWalkability(options: TerrainWalkabilityOptions): TerrainWalkabilityReport

## engine/WaterBuoyancySystem.ts
function getWaterBuoyancySystem(): WaterBuoyancySystemImpl

## engine/WaterSurface.ts
type CoastalSunDirection = THREE.Vector3 | null | (() => THREE.Vector3 | null)
function buildWaterSurfaceMesh(waterLevelY: number, bounds: { minX: number; maxX: number; minZ: number; maxZ: number }, sunPosition: CoastalSunDirection, heightAt?: CoastalHeightAt): THREE.Mesh

## engine/WorldQueries.ts
function queryWorldHeightAt(physicsWorld: PhysicsWorld | null, x: number, z: number): number
function queryWorldCenter(physicsWorld: PhysicsWorld | null, profile: WorldProfileData | undefined): THREE.Vector3

## engine/bakedSpawnResolver.ts
const BAKED_ROOFTOP_CLEARANCE_M = 1.5
function resolveBakedSpawnPosition(x: number, z: number, surfaceY: number, terrainY: number | null, dropY: number): THREE.Vector3 | null
interface SpawnFinderEngine — The subset of the engine a physics spawn finder needs. `EngineLike` satisfies it.
SpawnFinderEngine.physicsWorld: { raycast(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number, collisionMask: number): { hasHit: boolean; hitPoint: THREE.Vector3 }; } | null
SpawnFinderEngine.getWorldHeightAt?: (x: number, z: number) => number | null | undefined
interface PhysicsSpawnFinderOptions
PhysicsSpawnFinderOptions.requireHeadroom: boolean
function createPhysicsSpawnFinder(engine: SpawnFinderEngine, bounds: { maxY: number } | null, options: PhysicsSpawnFinderOptions): (x: number, z: number, fromY?: number) => THREE.Vector3 | null

## engine/environment.ts
type Environment = 'production' | 'development' | 'local'
function getEnvironment(): Environment
function isProduction(): boolean
function isDevelopment(): boolean
function isLocal(): boolean
