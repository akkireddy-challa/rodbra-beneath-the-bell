# engine-api-voxel-1

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/BlockRegistry.ts
interface BlockLoadReport
BlockLoadReport.loaded: string[]
BlockLoadReport.failed: Array<{ name: string; reason: string }>
BlockLoadReport.skipped: Array<{ name: string; reason: 'duplicate' | 'invalid' }>
type BlockResolveResult = | { id: number } | { id: undefined; reason: 'not-in-world-json' | 'load-failed' | 'invalid-name' }
class BlockRegistry
BlockRegistry.constructor(atlas?: VoxelTextureAtlas)
BlockRegistry.loadFromWorldProfile(profile: WorldProfileData): Promise<BlockLoadReport>
BlockRegistry.registerCustom(spec: CustomBlockType): Promise<{ id: number; alreadyExisted: boolean } | { error: string }>
BlockRegistry.resolve(name: string | undefined): BlockResolveResult
BlockRegistry.resolveOrFallback(name: string | undefined, fallbackId: number, ctx?: string): number
BlockRegistry.resolveOptional(name: string | undefined, ctx?: string): number | undefined
BlockRegistry.getFailureReason(name: string): string | undefined

## engine/ChunkPhysicsManager.ts
interface ChunkManagedObject — Interface for objects that can be managed by the chunk physics system.
ChunkManagedObject.getPosition(): THREE.Vector3
ChunkManagedObject.hibernate(): void
ChunkManagedObject.wake(): void
ChunkManagedObject.isHibernating(): boolean
ChunkManagedObject.holdPhysicsUntilReady?(): void
ChunkManagedObject.releasePhysics?(): void
ChunkManagedObject.isAlwaysActive?(): boolean
ChunkManagedObject.canHibernate?(): boolean
class ChunkPhysicsManager — ChunkPhysicsManager - Manages physics collider activation based on distance
ChunkPhysicsManager.constructor(voxelSize: number = 1.0)
ChunkPhysicsManager.initializeAllChunksActive(chunkKeys: Set<string>): void
ChunkPhysicsManager.setPhysicsDistance(distance: number): void
ChunkPhysicsManager.getPhysicsDistance(): number
ChunkPhysicsManager.setBoundsOffset(minX: number, minZ: number): void
ChunkPhysicsManager.setChunkStateChangeCallback(callback: (chunkKey: string, enabled: boolean) => void): void
ChunkPhysicsManager.getOverlappingChunkKeys(position: THREE.Vector3, objectRadius: number = 0.5): Set<string>
ChunkPhysicsManager.registerObject(obj: ChunkManagedObject, objectRadius: number = 0.5): void
ChunkPhysicsManager.unregisterObject(obj: ChunkManagedObject): void
ChunkPhysicsManager.updateObjectPosition(obj: ChunkManagedObject, objectRadius: number = 0.5): void
ChunkPhysicsManager.updateActiveChunks(cameraPosition: THREE.Vector3): void
ChunkPhysicsManager.setChunkActiveFromVisibility(chunkKey2D: string, visible: boolean): void
ChunkPhysicsManager.isChunkActive(chunkKey: string): boolean
ChunkPhysicsManager.isPositionInActiveChunk(position: THREE.Vector3): boolean
ChunkPhysicsManager.forceActivateAtPosition(worldX: number, worldZ: number): void
ChunkPhysicsManager.keepActiveAround(worldPositions: ReadonlyArray<THREE.Vector3>): void
ChunkPhysicsManager.getAnchorCount(): number
ChunkPhysicsManager.getStats(): { activeChunks: number; trackedObjects: number; registrations: number; terrainAnchors: number }
ChunkPhysicsManager.clear(): void

## engine/ExtractGlbForVoxelization.ts
interface ExtractedGlb — Pre-extracted GLB data ready for octree voxelization. Returned by
ExtractedGlb.allTriangles: Triangle[]
ExtractedGlb.rawBounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }
ExtractedGlb.bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }
ExtractedGlb.rootMin: THREE.Vector3
ExtractedGlb.rootSize: number
ExtractedGlb.centerX: number
ExtractedGlb.centerZ: number
ExtractedGlb.modelWidth: number
ExtractedGlb.modelHeight: number
ExtractedGlb.modelDepth: number
ExtractedGlb.appliedScale: number
ExtractedGlb.sceneExtras: Record<string, unknown> | null
ExtractedGlb.hasBmWheelNodes: boolean
ExtractedGlb.preRebaseBounds: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }
function extractGlbForVoxelization(glbBuffer: ArrayBuffer, options: { minVoxelSize: number; targetHeight?: number; /** * Allocated placeholder box (meters). When set and `targetHeight` is * unset, the effective target height is computed so the whole model * fits inside this box while preserving its proportions: * `min(height, x * objH/objW, z * objH/objD)`. Ignored when * `targetHeight` is supplied. */ fitBox?: { x: number; z: number; height: number }; /** * When true, skip the cm→m auto-scale heuristic regardless of model * height. Set by the level voxelizer (`voxelizeGLBToVxlWorld`): a * level-sized GLB can legitimately exceed 100m, and silently * shrinking it by 100× produces a sub-meter world the user can't see. * Asset voxelization keeps the heuristic on — that path expects * placeable models, where >100 units is almost always centimeters. */ disableCmAutoScale?: boolean; }): Promise<ExtractedGlb>

## engine/GLBVoxelizer.ts
interface VoxelizeOptions
VoxelizeOptions.minVoxelSize: number
VoxelizeOptions.maxVoxelSize: number
VoxelizeOptions.targetHeight?: number
VoxelizeOptions.fitBox?: { x: number; z: number; height: number }
VoxelizeOptions.fillInterior: boolean
VoxelizeOptions.useSRGB?: boolean
VoxelizeOptions.preFragment?: { targetFragments?: number; individualVoxels?: number }
VoxelizeOptions.additionalLods?: Array<{ minVoxelSize: number; maxVoxelSize: number }>
VoxelizeOptions.algorithm?: 'surface' | 'octree'
VoxelizeOptions.smartParts?: { table: VxlV3Part[]; rig: VxlV3RigInput; jointOfNode: (nodeName: string) => number }
VoxelizeOptions.onProgress?: (info: { index: number; total: number; label: string }) => void
VoxelizeOptions.enableDisplacement?: boolean
VoxelizeOptions.displacementAxis?: 'x' | 'y' | 'z'
interface VoxelizeResult
VoxelizeResult.vxlBytes: Uint8Array
VoxelizeResult.bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }
VoxelizeResult.effectiveTargetHeight: number
VoxelizeResult.effectiveMinVoxelSize?: number
VoxelizeResult.totalVoxels: number
VoxelizeResult.nodeCount: number
VoxelizeResult.fragmentCount: number
VoxelizeResult.colliderBoxCount: number
VoxelizeResult.trimeshTriangles: number
VoxelizeResult.lodCount: number
VoxelizeResult.voxelsPerLod: number[]
VoxelizeResult.slotNames: string[]
VoxelizeResult.warning?: string
function snapDown(v: number, step: number): number
function snapUp(v: number, step: number): number
interface Triangle
Triangle.v0: THREE.Vector3
Triangle.v1: THREE.Vector3
Triangle.v2: THREE.Vector3
Triangle.normal: THREE.Vector3
Triangle.material: THREE.MeshStandardMaterial | null
Triangle.uv0?: THREE.Vector2
Triangle.uv1?: THREE.Vector2
Triangle.uv2?: THREE.Vector2
Triangle.col0?: { r: number; g: number; b: number }
Triangle.col1?: { r: number; g: number; b: number }
Triangle.col2?: { r: number; g: number; b: number }
Triangle.sourceNodeName?: string
function collectMeshes(root: THREE.Object3D): THREE.Mesh[]
function getGeometryAttributes(mesh: THREE.Mesh): GeometryAttrs | null
interface PixelData
PixelData.width: number
PixelData.height: number
PixelData.data: Uint8Array | Uint8ClampedArray
function sampleLinearColorAtPoint(point: THREE.Vector3, triangles: Triangle[], useSRGB: boolean): { r: number; g: number; b: number } | null
function voxelizeGLB(glbBuffer: ArrayBuffer, options: VoxelizeOptions): Promise<VoxelizeResult>
function voxelizeFromExtracted(extracted: ExtractedGlb, options: VoxelizeOptions): Promise<VoxelizeResult>

## engine/GlbColliderBuilder.ts
interface BuildGlbColliderOptions
BuildGlbColliderOptions.triangleBudget: number
BuildGlbColliderOptions.maxCellsPerAxis: number
const DEFAULT_GLB_COLLIDER_OPTIONS: BuildGlbColliderOptions
interface BuildGlbColliderResult
BuildGlbColliderResult.verts: Float32Array
BuildGlbColliderResult.indices: Uint32Array
BuildGlbColliderResult.triangleCount: number
BuildGlbColliderResult.simplified: boolean
BuildGlbColliderResult.cellSize?: number
function buildColliderFromTriangles(tris: RasterTriangle[], options: BuildGlbColliderOptions): BuildGlbColliderResult

## engine/SurfaceAssetVoxelizer.ts
interface SurfaceAssetBakeOptions
SurfaceAssetBakeOptions.minVoxelSize: number
SurfaceAssetBakeOptions.maxVoxelSize: number
SurfaceAssetBakeOptions.fillInterior: boolean
interface SurfaceAssetBakeResult
SurfaceAssetBakeResult.leaves: OctreeLeaf[]
function bakeSurfaceAssetLeaves(triangles: RasterTriangle[], options: SurfaceAssetBakeOptions): Promise<SurfaceAssetBakeResult>

## engine/VoxelBuildingFoundation.ts
interface BuildingFoundationOptions — Options for `VoxelTerrainSystem.placeBuildingFoundation`.
BuildingFoundationOptions.height: number | null
BuildingFoundationOptions.levelAt: { x: number; z: number } | null
BuildingFoundationOptions.blockType: number | null
BuildingFoundationOptions.margin: number
BuildingFoundationOptions.rebuildMeshes: boolean
const DEFAULT_BUILDING_FOUNDATION_OPTIONS: BuildingFoundationOptions
function chunkKeysInRect(voxelWorld: VoxelWorld, rect: FoliageExclusionRect): string[]
interface FoundationTerrainHost — The `VoxelTerrainSystem` surface the registry drives (kept structural to avoid an import cycle).
FoundationTerrainHost.getTerrainOnlyHeight(x: number, z: number): number
FoundationTerrainHost.getBlockSize(): number
FoundationTerrainHost.getVoxelWorld(): VoxelWorld | null
FoundationTerrainHost.flattenArea(centerX: number, centerZ: number, width: number, depth: number, height: number, blockType?: number, rebuildMeshes?: boolean, margin?: number, objectId?: string): void
FoundationTerrainHost.unflattenArea(objectId: string, rebuildMeshes?: boolean): void
FoundationTerrainHost.hasFlattenSnapshot(objectId: string): boolean
FoundationTerrainHost.clearFlattenSnapshot(objectId: string): void
FoundationTerrainHost.regenerateFoliageForChunk(key2D: string, getTerrainType: (blockType: number) => number): void
class BuildingFoundationRegistry — Building lots laid by `VoxelTerrainSystem.placeBuildingFoundation`, keyed by building id.
BuildingFoundationRegistry.constructor(private readonly terrain: FoundationTerrainHost, private readonly getFoliage: () => VoxelFoliageSystem | null, private readonly getTerrainTypeResolver: () => ((blockType: number) => number) | null)
BuildingFoundationRegistry.place(id: string, centerX: number, centerZ: number, width: number, depth: number, options: BuildingFoundationOptions): number
BuildingFoundationRegistry.release(id: string, restoreTerrain: boolean, rebuildMeshes: boolean): boolean
BuildingFoundationRegistry.get(id: string): FoliageExclusionRect | null
BuildingFoundationRegistry.applyExclusionsTo(foliage: VoxelFoliageSystem): void

## engine/VoxelChunkToOctree.ts
function canConvertChunkObjectToOctree(object: VoxelObject): boolean
function convertChunkObjectToOctree(object: VoxelObject, slots: VoxelSlot[] = [], slotOf?: (voxel: { x: number; y: number; z: number; blockType: number; color: number }) => number, boneOf?: (voxel: { x: number; y: number; z: number }) => number): boolean

## engine/VoxelChunkUpdateHelper.ts
interface ChunkEntry<T> — Helper utilities for VoxelWorld chunk update prioritization.
ChunkEntry.key: string
ChunkEntry.chunk: T
interface PlayerPosition
PlayerPosition.x: number
PlayerPosition.z: number
interface WorldBounds
WorldBounds.minX: number
WorldBounds.minZ: number
function getChunkDistanceToPlayer(chunkKey: string, playerPos: PlayerPosition, bounds: WorldBounds | null, voxelSize: number): number
function sortChunksByDistance<T>(chunks: Array<[string, T]>, playerPos: PlayerPosition, bounds: WorldBounds | null, voxelSize: number): Array<[string, T]>
const CHUNK_PRIORITY_CONFIG = { MAX_DISTANT_CHUNKS: 2, // Max distant chunks to process pe

## engine/VoxelColumnTopIndex.ts
class VoxelColumnTopIndex
VoxelColumnTopIndex.bump(cx: number, cz: number, vy: number): void
VoxelColumnTopIndex.bumpUniform(cx: number, cz: number, vy: number, surfaceBlock: number): void
VoxelColumnTopIndex.invalidateUniform(cx: number, cz: number): boolean
VoxelColumnTopIndex.getMax(cx: number, cz: number): number | undefined
VoxelColumnTopIndex.getUniform(cx: number, cz: number): number | undefined
VoxelColumnTopIndex.getUniformBlock(cx: number, cz: number): number | undefined
VoxelColumnTopIndex.forEachUniform(cb: (cx: number, cz: number, vy: number, block: number) => void): void
VoxelColumnTopIndex.clear(): void
VoxelColumnTopIndex.get size(): number
VoxelColumnTopIndex.get uniformSize(): number

## engine/VoxelDebrisManager.ts
interface VoxelDebris
VoxelDebris.body: RAPIER.RigidBody
VoxelDebris.collider: RAPIER.Collider
VoxelDebris.id?: number
interface DebrisFreezeEvent — A single freeze event — one debris piece that has settled on the authority
DebrisFreezeEvent.id: number
DebrisFreezeEvent.px: number
DebrisFreezeEvent.py: number
DebrisFreezeEvent.pz: number
DebrisFreezeEvent.qx: number
DebrisFreezeEvent.qy: number
DebrisFreezeEvent.qz: number
DebrisFreezeEvent.qw: number
interface DebrisSyncOptions — Options for enabling networked debris freeze sync.
DebrisSyncOptions.isAuthority: boolean
DebrisSyncOptions.maxFreezesPerFrame: number
DebrisSyncOptions.onFreezeBatch: (batch: DebrisFreezeEvent[]) => void
const VoxelDebrisManager = new VoxelDebrisManagerImpl()

## engine/VoxelDebrisOps.ts
function spawnDebrisFromBlocks(world: VoxelWorld, physicsWorld: PhysicsWorld, parentGroup: THREE.Object3D, voxelSize: number, blocks: Array<{ x: number; y: number; z: number; blockType: number }>, centerX: number, centerY: number, centerZ: number, impulseStrength: number, impulseUp: number, fixedDirection?: THREE.Vector3): Array<{ body: RAPIER.RigidBody; collider: RAPIER.Collider }>

## engine/VoxelExplosionHelpers.ts
function radialBlastImpulse(dx: number, dz: number, strength: number, up: number): { x: number; y: number; z: number }
function pushDebrisOutward(pos: THREE.Vector3, dx: number, dy: number, dz: number, dist: number, size: number): void
function debrisRigidBodyDesc(x: number, y: number, z: number, imp: { x: number; y: number; z: number }): RAPIER.RigidBodyDesc
function decodedToEncodable(d: DecodedVxlV3): VxlV3Data

## engine/VoxelFluidSystem.ts
enum FluidRenderMode { SURFACE_ONLY, FULL_DEPTH }
interface FluidSystemOptions
FluidSystemOptions.renderMode?: FluidRenderMode
FluidSystemOptions.opacity?: number
class VoxelFluidSystem
VoxelFluidSystem.constructor(parentGroup: THREE.Object3D, voxelWorld: VoxelWorld, options: FluidSystemOptions = {})
VoxelFluidSystem.setRenderMode(mode: FluidRenderMode): void
VoxelFluidSystem.setOpacity(opacity: number): void
VoxelFluidSystem.setVisible(visible: boolean): void
VoxelFluidSystem.updateFluidMeshes(dirtyChunkKeys?: Set<string>): void
VoxelFluidSystem.dispose(): void

## engine/VoxelLazyGeneration.ts
type ChunkKey = string
interface LazyGenerationStats
LazyGenerationStats.builtChunks: number
LazyGenerationStats.pendingChunks: number
LazyGenerationStats.totalChunks: number
class VoxelLazyGeneration
VoxelLazyGeneration.constructor(private getChunks: () => Map<ChunkKey, unknown>, private getVoxelSize: () => number, private getBounds: () => { minX: number; minZ: number } | null, private buildChunk: (chunkKey: ChunkKey) => void, private updateVisualization: (chunkKeys: Set<string>) => void)
VoxelLazyGeneration.enable(): void
VoxelLazyGeneration.isEnabled(): boolean
VoxelLazyGeneration.markChunkBuilt(chunkKey: ChunkKey): void
VoxelLazyGeneration.isChunkBuilt(chunkKey: ChunkKey): boolean
VoxelLazyGeneration.addPendingChunk(chunkKey: ChunkKey): void
VoxelLazyGeneration.buildChunksInRadius(centerX: number, centerZ: number, radius: number): { built: number; deferred: number }
VoxelLazyGeneration.buildPendingChunksNear(playerX: number, playerZ: number, maxChunks: number, buildRadius: number): number
VoxelLazyGeneration.getStats(): LazyGenerationStats
VoxelLazyGeneration.isComplete(): boolean

## engine/VoxelMaterialClass.ts
type VoxelMaterialClassName = | 'matte' | 'cloth' | 'fur' | 'leather' | 'wood' | 'stone' | 'plastic' | 'paint' | 'metal' | 'gold' | 'chrome' | 'gem' | 'glass' | 'filament' | 'neon' | 'lava'
const DEFAULT_VOXEL_MATERIAL_CLASS: VoxelMaterialClassName
const VOXEL_MATERIAL_CLASS_NAME_MAX = 24
type VoxelMaterialLighting = 'lambert' | 'direct' | 'environment'
interface VoxelMaterialClass — What a voxel surface is made of, in render terms. Every field is required with
VoxelMaterialClass.lighting: VoxelMaterialLighting
VoxelMaterialClass.metalness: number
VoxelMaterialClass.roughness: number
VoxelMaterialClass.clearcoat: number
VoxelMaterialClass.clearcoatRoughness: number
VoxelMaterialClass.shininess: number
VoxelMaterialClass.specular: number
VoxelMaterialClass.envMapIntensity: number
VoxelMaterialClass.albedoScale: number
VoxelMaterialClass.smoothness: number
VoxelMaterialClass.smoothRadiusVoxels: number
VoxelMaterialClass.sheen: number
VoxelMaterialClass.sheenRoughness: number
VoxelMaterialClass.sheenColor: number
VoxelMaterialClass.mobileFallback: VoxelMaterialClassName | null
VoxelMaterialClass.collapsesTo: VoxelMaterialClassName | null
VoxelMaterialClass.defaultGlow: number
VoxelMaterialClass.impact: 'soft' | 'hard' | 'metallic' | 'glassy' | 'wood'
const VOXEL_MATERIAL_CLASSES: Readonly<Record<VoxelMaterialClassName, VoxelMaterialClass>>
const VOXEL_MATERIAL_CLASS_NAMES: readonly VoxelMaterialClassName[]
function isVoxelMaterialClassName(name: string | undefined): name is VoxelMaterialClassName
function normalizeVoxelMaterialClassName(name: string | undefined | null): VoxelMaterialClassName
function storedVoxelMaterialClassName(name: string | undefined | null): string
function resolveVoxelMaterialClass(name: string | undefined | null): VoxelMaterialClass
function defaultGlowForVoxelMaterialClass(name: string | undefined | null): number
function effectiveVoxelMaterialClassName(name: string | undefined | null, smoothed: boolean): VoxelMaterialClassName
function wantsShadingSmoothing(cls: VoxelMaterialClass, quality: MaterialQuality): boolean
function clampVoxelMaterialLighting(lighting: VoxelMaterialLighting, quality: MaterialQuality): VoxelMaterialLighting

## engine/VoxelMaterialSlots.ts
const VOXEL_SLOT_PREFIX = 'BM_slot_'
const MAX_VOXEL_SLOTS = 15
const VOXEL_SLOT_NAME_MAX = 32
const BASE_VOXEL_SLOT = 0
interface VoxelSlot
VoxelSlot.name: string
VoxelSlot.emissive: number
VoxelSlot.materialClass?: string
function slotNameFromMaterialName(materialName: string | null | undefined): string | null
function materialNameForSlot(name: string): string
function buildSlotTable(declared: Array<{ name: string; emissive: number; materialClass?: string }>): { slots: VoxelSlot[]; dropped: string[] }
function slotIndexOf(slots: VoxelSlot[], name: string): number

## engine/VoxelMiningSystem.ts
interface VoxelWorldProvider — Minimal contract a world-generator must satisfy for VoxelMiningSystem.
VoxelWorldProvider.getVoxelWorld(): VoxelWorld | null
interface VoxelMiningOptions
VoxelMiningOptions.blockHp: Map<number, number>
VoxelMiningOptions.defaultHp: number
VoxelMiningOptions.damagePerSwing: number
VoxelMiningOptions.mineTerrain: boolean
VoxelMiningOptions.mineableBlocks: string[] | null
VoxelMiningOptions.targetHoldSec: number
const DEFAULT_MINING_OPTIONS: VoxelMiningOptions
class VoxelMiningSystem — VoxelMiningSystem — blade-sweep driven block mining for the Voxel genre.
VoxelMiningSystem.onBlockDestroyed: | ((pos: THREE.Vector3, blockId: number, blockName: string, color: number) => void) | null
VoxelMiningSystem.constructor(engine: EngineLike, worldProvider: VoxelWorldProvider, opts: VoxelMiningOptions)
VoxelMiningSystem.tryHitAt(hitBody: unknown, hitPoint: THREE.Vector3, hitNormal: THREE.Vector3, nameHint?: string): void
VoxelMiningSystem.hitVoxelObject(voxelObject: VoxelObject, contactPoint?: THREE.Vector3, nameHint?: string, bodyHandle: number = -1): void
VoxelMiningSystem.hitTerrainCell(bx: number, by: number, bz: number): void
VoxelMiningSystem.probeTerrain(x: number, y: number, z: number): number
VoxelMiningSystem.hitSceneryAt(position: THREE.Vector3, nameHint: string): void
VoxelMiningSystem.update(deltaTime: number): void
VoxelMiningSystem.dispose(): void

## engine/VoxelNavMesh.ts
interface AStarNode
AStarNode.gx: number
AStarNode.gz: number
AStarNode.g: number
AStarNode.f: number
AStarNode.layer?: number
type ObstacleHandle = number
type CircleObstacle = { kind: 'circle'; x: number; z: number; radius: number; y?: number }
type BoxObstacle = { kind: 'box'; x: number; z: number; halfW: number; halfD: number; yaw?: number; y?: number }
type ObstacleShape = CircleObstacle | BoxObstacle
class MinHeap
MinHeap.get size()
MinHeap.push(node: AStarNode)
MinHeap.pop(): AStarNode | undefined
interface BuildOptions
BuildOptions.cellSize?: number
BuildOptions.agentRadius?: number
const NPC_NAV_CELL_M = 1.0
const NPC_NAV_STEP_M = 0.5
class VoxelNavMesh
VoxelNavMesh.buildFromVoxelWorld(voxelWorld: VoxelWorld, minX: number, maxX: number, minZ: number, maxZ: number, options: BuildOptions = {}): void
VoxelNavMesh.buildFromHeightSampler(sampler: (x: number, z: number) => number | null, minX: number, maxX: number, minZ: number, maxZ: number, voxelSize: number, options: BuildOptions = {}): void
VoxelNavMesh.buildFromSerialized(data: ArrayBuffer): void
VoxelNavMesh.serialize(): Uint8Array
VoxelNavMesh.getCellMutationVersion(): number
VoxelNavMesh.addObstacle(shape: ObstacleShape): ObstacleHandle
VoxelNavMesh.updateObstacle(handle: ObstacleHandle, newShape: ObstacleShape): void
VoxelNavMesh.addTrackedObstacle(getCurrentShape: () => ObstacleShape | null): ObstacleHandle
VoxelNavMesh.tick(): void
VoxelNavMesh.removeObstacle(handle: ObstacleHandle): void
VoxelNavMesh.findPath(start: THREE.Vector3, end: THREE.Vector3, extraObstacles?: ReadonlyArray<{ x: number; z: number; radius: number }>, maxPathLength?: number): THREE.Vector3[]
VoxelNavMesh.isReady(): boolean
VoxelNavMesh.getStepLimits(): { maxClimbUp: number; maxDropDown: number }
VoxelNavMesh.getGridInfo(): { cols: number; rows: number; minX: number; minZ: number; cellSize: number } | null
VoxelNavMesh.getCellGroundY(gx: number, gz: number, refY?: number): number | null
VoxelNavMesh.canStepCells(fromGx: number, fromGz: number, toGx: number, toGz: number, fromRefY?: number): boolean
VoxelNavMesh.worldToCell(x: number, z: number): { gx: number; gz: number } | null
VoxelNavMesh.cellToWorld(gx: number, gz: number): { x: number; z: number }
VoxelNavMesh.isValidNavigationTarget(position: THREE.Vector3): boolean
VoxelNavMesh.isWalkableAt(x: number, z: number, refY?: number): boolean
VoxelNavMesh.findNearestValidTarget(position: THREE.Vector3, maxSearchRadius?: number): THREE.Vector3 | null
VoxelNavMesh.getGroundHeight(x: number, z: number, refY?: number): number | null
VoxelNavMesh.visualize(scene: THREE.Scene): void
VoxelNavMesh.removeVisualization(scene: THREE.Scene): void
VoxelNavMesh.dispose(): void
interface ObstacleProvider — One entry per long-lived obstacle (currently: every world.json env object
ObstacleProvider.getShape: () => ObstacleShape | null
ObstacleProvider.currentHandle: ObstacleHandle
function registerObstacleProvider(getShape: () => ObstacleShape | null): ObstacleProvider
function unregisterObstacleProvider(provider: ObstacleProvider): void
function setGlobalNavMesh(navMesh: VoxelNavMesh | null): void
function getGlobalNavMesh(): VoxelNavMesh | null

## engine/VoxelObject.ts
type VoxelDestructionMode = 'partial' | 'shatter'
interface VoxelObjectOptions — Options for VoxelObject construction.
VoxelObjectOptions.voxelSize?: number
VoxelObjectOptions.useAtlas?: boolean
VoxelObjectOptions.shadows?: boolean
VoxelObjectOptions.voxelRoundingRadiusVoxels?: number
VoxelObjectOptions.voxelRoundingSegments?: number
VoxelObjectOptions.finish?: VoxelFinishOptions
VoxelObjectOptions.primaryLod?: number
type VoxelObjectDebris = VoxelDebris
function setVoxelObjectEngine(engine: typeof _engineRef): void
class VoxelObject extends THREE.Group implements ChunkManagedObject
VoxelObject.useAtlas: boolean
VoxelObject.getPivot(): { x: number; y: number; z: number } | null
VoxelObject.setPivotAndBoundsOffset(pivot: { x: number; y: number; z: number }, boundsOffset: { x: number; y: number; z: number }): void
VoxelObject.getOctreeLeaves(): OctreeLeaf[] | null
VoxelObject.getMaterializedOctreeLeaves(): OctreeLeaf[] | null
VoxelObject.get isOctreeV2(): boolean
VoxelObject.removeOctreeLeavesByIndex(indices: Set<number>): OctreeLeaf[]
VoxelObject.setOctreeLeavesForEdit(leaves: OctreeLeaf[]): void
VoxelObject.refreshAfterLeafEdit(): void
VoxelObject.get isOctreeLeafEdited(): boolean
VoxelObject.initFromOctreeLeaves(leaves: OctreeLeaf[], voxelSize: number, pivot: { x: number; y: number; z: number }): void
VoxelObject.setLod0Visible(visible: boolean): void
VoxelObject.getPhysicsWorld(): PhysicsWorld | null
VoxelObject.getColliders(): RAPIER.Collider[]
VoxelObject.getPhysicsGridStepValue(): number
VoxelObject.getDecodedVxlV3(): DecodedVxlV3 | null
VoxelObject.buildSmartPartMeshes(): Array<{ joint: number; mesh: THREE.Mesh }> | null
VoxelObject.getMesh(): THREE.Mesh | null
VoxelObject.getLodCount(): number
VoxelObject.getPrimaryLod(): number
VoxelObject.getMeshForLod(k: number): THREE.Mesh | null
VoxelObject.getPhysicsInfo(): { hasCollider: boolean; isDynamic: boolean; colliderCount: number; colliderType: string; triangleCount?: number; }
VoxelObject.constructor(options: VoxelObjectOptions = {})
VoxelObject.setNavmeshObstacleEnabled(enabled: boolean, halfW?: number, halfD?: number, offsetX?: number, offsetZ?: number): void
VoxelObject.isNavmeshObstacleEnabled(): boolean
VoxelObject.getNavmeshObstacleHandle(): ObstacleHandle
VoxelObject.isFromAssetCatalog(): boolean
VoxelObject.isDestroyed(): boolean
VoxelObject.setDestructionMode(mode: VoxelDestructionMode): void
VoxelObject.getDestructionMode(): VoxelDestructionMode
VoxelObject.setOnPostExplosion(cb: ((obj: VoxelObject) => void) | null): void
static VoxelObject.fromRigidBody(body: RAPIER.RigidBody, physicsWorld: PhysicsWorld): VoxelObject | null
VoxelObject.markAsUnique(): void
VoxelObject.setCarveable(carveable: boolean): void
VoxelObject.isCarveable(): boolean
VoxelObject.setUseAtlas(useAtlas: boolean): void
VoxelObject.loadFromFile(buffer: ArrayBuffer, options?: { distinctFragmentOffsets?: boolean }): Promise<VoxelBounds | null>
VoxelObject.loadLegacyJsonForConversion(buffer: ArrayBuffer): Promise<VoxelBounds | null>
VoxelObject.toVXL(): Promise<ArrayBuffer>
VoxelObject.cloneDataTo(target: VoxelObject, options?: { keepPhysicsBody?: boolean }): void
VoxelObject.setVoxel(x: number, y: number, z: number, blockType: BlockTypeId, color?: number): void
VoxelObject.finalize(): void
VoxelObject.getRigidBody(): RAPIER.RigidBody | null
VoxelObject.enableDynamicGravity(): void
VoxelObject.getPosition(): THREE.Vector3
VoxelObject.setPosition(x: number, y: number, z: number): void
VoxelObject.setRotationY(yaw: number): void
VoxelObject.hibernate(): void
VoxelObject.wake(): void
VoxelObject.isHibernating(): boolean
VoxelObject.canHibernate(): boolean
VoxelObject.holdPhysicsUntilReady(): void
VoxelObject.releasePhysics(): void
VoxelObject.surfaceOffsetBelow(physicsWorld: PhysicsWorld, maxLift: number = 4, maxDrop: number = 3): number | null
VoxelObject.restOnSurfaceBelow(physicsWorld: PhysicsWorld, maxLift: number = 4, maxDrop: number = 3, sleepAfter: boolean = false): boolean
VoxelObject.settleSpuriousWake(physicsWorld: PhysicsWorld, restPosition: { x: number; y: number; z: number }, maxLift: number = 0.35, speedThreshold: number = 0.75, maxDrift: number = 0.2): 'moving' | 'settled'
VoxelObject.requestSurfaceRest(): void
VoxelObject.carveLeafCount(): number
VoxelObject.isDynamicObject(): boolean
VoxelObject.setAlwaysActive(active: boolean): void
VoxelObject.isAlwaysActive(): boolean
VoxelObject.getSlotNames(): string[]
VoxelObject.getSlots(): VoxelSlot[]
VoxelObject.setSlotsForEdit(slots: VoxelSlot[]): void
VoxelObject.setSmartPartsForEdit(smart: { rig: VxlV3RigInput; parts: VxlV3Part[] } | null): void
VoxelObject.setSlotEmissive(name: string, intensity: number): boolean
VoxelObject.getSlotEmissive(name: string): number | null
VoxelObject.getBounds(): VoxelBounds | null
VoxelObject.getBoundsInWorldUnits(): VoxelBounds | null
VoxelObject.getVoxelSize(): number
VoxelObject.getBaseFootprint(): BaseFootprint | null
VoxelObject.removeVoxelsAndRebuild(voxels: Array<{ x: number; y: number; z: number }>): void
VoxelObject.removeVoxelAt(localX: number, localY: number, localZ: number): boolean
VoxelObject.setVoxelAtLocal(localX: number, localY: number, localZ: number, blockType: BlockTypeId, color?: number): boolean
VoxelObject.changeVoxelType(localX: number, localY: number, localZ: number, newBlockType: BlockTypeId): boolean
VoxelObject.rebuild(): void
VoxelObject.getVoxelCount(): number
VoxelObject.getVoxelData(): Array<{x: number, y: number, z: number, blockType: number, color: number}>
VoxelObject.getPhysicsBoxes(): PhysicsBox[]
VoxelObject.createPhysicsBody(physicsWorld: PhysicsWorld, options?: { asTerrain?: boolean }): void
VoxelObject.createPhysicsBodyAtPosition(physicsWorld: PhysicsWorld, x: number, y: number, z: number, rotationY: number = 0, scale?: { width: number; height: number; depth: number }, rotationXYZ?: { x: number; y: number; z: number }, envInstance?: EnvInstanceRef): RAPIER.RigidBody | null
VoxelObject.createDynamicPhysicsBody(physicsWorld: PhysicsWorld, mass: number = 10, engine?: DynamicObjectManagerHost, options?: Partial<DynamicPhysicsBodyOptions>): void
VoxelObject.syncWithPhysics(): void
VoxelObject.updatePhysicsTransform(): void
VoxelObject.removePhysicsBody(): void
VoxelObject.explodeAt(worldCenter: THREE.Vector3, radius: number, impulseStrength: number = 5, impulseUp: number = 2, parentGroup?: THREE.Object3D, voxelWorld?: VoxelWorld, mergeBlockType?: number): VoxelObjectDebris[]
VoxelObject.detachAsDynamic(worldCenter: THREE.Vector3, impulseStrength: number, impulseUp: number): VoxelObjectDebris | null
VoxelObject.rebuildCollidersAsTrimesh(): boolean
VoxelObject.splitInPlace(k: number): VoxelObject[]
VoxelObject.removeVoxelsBatch(voxels: Array<{ localX: number; localY: number; localZ: number }>): void
VoxelObject.dispose(): void

## engine/VoxelObjectColliderOps.ts
interface EnvInstanceRef — Which batched environment instance a physics body belongs to.
EnvInstanceRef.typeName: string
EnvInstanceRef.index: number
function envInstanceFromRigidBody(body: RAPIER.RigidBody, pw: PhysicsWorld): EnvInstanceRef | null
function createStaticVoxelBody(vox: VoxelObject, pw: PhysicsWorld, translation: { x: number; y: number; z: number }, rotation: { x: number; y: number; z: number; w: number }, envInstance?: EnvInstanceRef): RAPIER.RigidBody
function clearColliders(vox: VoxelObject): void
function collectChunkPhysicsBoxes(vox: VoxelObject, bOffX: number, bOffY: number, bOffZ: number, pivotX: number, pivotY: number, pivotZ: number): PhysicsBox[]
function attachUnionVoxelCollider(vc: OctreeVoxelCells, pw: PhysicsWorld, body: RAPIER.RigidBody, groups: number, sx: number = 1, sy: number = 1, sz: number = 1): RAPIER.Collider
function chunkVoxelCells(vox: VoxelObject, bOffX: number, bOffY: number, bOffZ: number, pivotX: number, pivotY: number, pivotZ: number): OctreeVoxelCells | null
function voxelCellCollidersFromChunks(vox: VoxelObject, bOffX: number, bOffY: number, bOffZ: number, pivotX: number, pivotY: number, pivotZ: number, pw: PhysicsWorld, body: RAPIER.RigidBody, groups: number, sx: number = 1, sy: number = 1, sz: number = 1): RAPIER.Collider[]
function rebuildPhysicsColliders(vox: VoxelObject): void
function finishDynamicVoxelBody(vox: VoxelObject, mass: number, isSphere: boolean, startAsleep: boolean, engine: { getDynamicObjectManager?: () => { register(obj: ChunkManagedObject, type: string, radius?: number): void } } | null | undefined): void

## engine/VoxelObjectDebris.ts
interface DebrisFreezeEvent — Authoritative freeze: settled debris at a specific transform on all clients.
DebrisFreezeEvent.id: number
DebrisFreezeEvent.px: number
DebrisFreezeEvent.py: number
DebrisFreezeEvent.pz: number
DebrisFreezeEvent.qx: number
DebrisFreezeEvent.qy: number
DebrisFreezeEvent.qz: number
DebrisFreezeEvent.qw: number
interface DebrisSyncOptions — Network-sync configuration. See `enableSync`.
DebrisSyncOptions.isAuthority: boolean
DebrisSyncOptions.maxFreezesPerFrame: number
DebrisSyncOptions.onFreezeBatch: (batch: DebrisFreezeEvent[]) => void
const voxelObjectDebris = new VoxelObjectDebrisImpl()

## engine/VoxelObjectLeafEdit.ts
function computeLeafBounds(leaves: OctreeLeaf[]): VxlV3Bounds
class LeafSpatialIndex — Bucketed spatial index over a leaf list. Buckets are sized to the
LeafSpatialIndex.constructor(leaves: OctreeLeaf[], minVoxelSize: number)
LeafSpatialIndex.leafIndexAt(x: number, y: number, z: number): number
LeafSpatialIndex.overlapsBox(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): boolean
function buildEditedVxlV3Data(leaves: OctreeLeaf[], template: DecodedVxlV3 | null, fallback: { voxelSize: number; physicsGridStep: number; useAtlas: boolean }, slots: VoxelSlot[] = []): VxlV3Data

## engine/VoxelObjectPlaneLocked.ts
interface PlaneLockedVoxelBody
PlaneLockedVoxelBody.rigidBody: RAPIER.RigidBody
PlaneLockedVoxelBody.colliders: RAPIER.Collider[]
function planeLockedStaticBody(physicsWorld: PlaneLockedPhysics, boxes: readonly PhysicsBox[], transform: Transform, collisionGroups: number, userData: unknown, terrain: boolean = false): PlaneLockedVoxelBody
function planeLockedDynamicBody(physicsWorld: PlaneLockedPhysics, boxes: readonly PhysicsBox[], transform: Transform, mass: number, userData: unknown): PlaneLockedVoxelBody

## engine/VoxelObjectPristineOps.ts
function getFragmentCount(vox: VoxelObject): number
function getFragmentVisualSources(vox: VoxelObject): FragmentVisualSource[] | null
function getUnionColliderBoxes(vox: VoxelObject): PhysicsBox[]
function getUnionVoxelCells(vox: VoxelObject): OctreeVoxelCells | null
function adoptPristineTemplate(vox: VoxelObject, template: VoxelObject): void
function initPristineUnionBody(vox: VoxelObject, physicsWorld: PhysicsWorld, template: VoxelObject): void
function initPristineDynamicBody(vox: VoxelObject, physicsWorld: PhysicsWorld, template: VoxelObject, mass: number): void
function attachPristineDynamicColliders(vox: VoxelObject, physicsWorld: PhysicsWorld, template: VoxelObject, mass: number, scale: THREE.Vector3, body: RAPIER.RigidBody): void
function attachPromotedDynamicColliders(vox: VoxelObject, physicsWorld: PhysicsWorld, template: VoxelObject, mass: number): void
function templateBlastWouldAffect(vox: VoxelObject, template: VoxelObject, worldCenter: THREE.Vector3, radius: number): boolean
function materializePromotedFragments(vox: VoxelObject, template: VoxelObject, slotFor: (fragIndex: number, matrix: THREE.Matrix4) => FragmentSlot | null): void
function detachFragmentAt(fragments: VoxelObject[], aabbs: FragmentAabb[], index: number, worldCenter: THREE.Vector3, impulseStrength: number, impulseUp: number, debris: VoxelObjectDebris[]): void
function shatterAllFragments(vox: VoxelObject, worldCenter: THREE.Vector3, localCenter: THREE.Vector3, radiusSq: number, impulseStrength: number, impulseUp: number): VoxelObjectDebris[]
function collapseUnsupportedAndFinalize(vox: VoxelObject, worldCenter: THREE.Vector3, impulseStrength: number, debris: VoxelObjectDebris[]): void

## engine/VoxelSlotAssign.ts
interface SlotAssignResult
SlotAssignResult.slots: VoxelSlot[]
SlotAssignResult.assigned: number
SlotAssignResult.dropped: string[]
function assignVoxelSlotsFromTriangles(leaves: OctreeLeaf[], triangles: Triangle[]): SlotAssignResult
function nearestOwnerForLeaves(leaves: readonly OctreeLeaf[], triangles: readonly Triangle[], ownerOfTriangle: (index: number) => number): Uint8Array

## engine/VoxelSlotMaterial.ts
const VOXEL_SLOT_FLAG = 'voxelSlot'
const VOXEL_SLOT_LEVEL = 'voxelSlotLevel'
const VOXEL_SLOT_CLASS = 'voxelSlotClass'
const VOXEL_SLOT_SMOOTHED = 'voxelSlotSmoothed'
interface VoxelSlotInfo — What a slot material can say about itself — everything needed to rebuild it.
VoxelSlotInfo.name: string
VoxelSlotInfo.level: number
VoxelSlotInfo.materialClass: VoxelMaterialClassName | string
VoxelSlotInfo.smoothed: boolean
function slotInfoFromMaterial(material: THREE.Material): VoxelSlotInfo | null
interface VoxelSlotMaterialHandle — A slot's material plus the one control it exists to provide. `setEmissive`
VoxelSlotMaterialHandle.readonly name: string
VoxelSlotMaterialHandle.readonly material: THREE.Material
VoxelSlotMaterialHandle.setEmissive(intensity: number): void
VoxelSlotMaterialHandle.getEmissive(): number
function createVoxelSlotMaterial(params: VoxelMaterialParams, slot: VoxelSlot, smoothed: boolean, quality: MaterialQuality): VoxelSlotMaterialHandle
function createVoxelSlotMaterialFromInfo(params: VoxelMaterialParams, info: VoxelSlotInfo, quality: MaterialQuality): VoxelSlotMaterialHandle
function createWebGlVoxelSlotMaterial(params: VoxelMaterialParams, info: VoxelSlotInfo, quality: MaterialQuality): VoxelSlotMaterialHandle

## engine/VoxelSlotShading.ts
interface SlotShadingInput
SlotShadingInput.positions: Float32Array
SlotShadingInput.normals: Float32Array
SlotShadingInput.indices: Uint32Array
SlotShadingInput.slots: readonly VoxelSlot[]
SlotShadingInput.groups: ReadonlyArray<{ start: number; count: number }>
SlotShadingInput.voxelSize: number
SlotShadingInput.materialQuality: MaterialQuality
interface SlotShadingResult
SlotShadingResult.smoothed: boolean[]
SlotShadingResult.stamp: { strength: number; radiusVoxels: number } | null
function smoothSlotShadingNormals(input: SlotShadingInput): SlotShadingResult

## engine/VoxelStructuralCollapse.ts
function enableStructuralCollapse(obj: VoxelObject, physicsWorld: PhysicsWorld, parentGroup: THREE.Object3D): void

## engine/VoxelTerrainSystem.ts
interface VoxelTerrainConfig — Configuration for voxel terrain rendering.
VoxelTerrainConfig.blockSize?: number
VoxelTerrainConfig.material?: { roughness?: number; metalness?: number; }
VoxelTerrainConfig.physics?: { friction?: number; restitution?: number; }
class VoxelTerrainSystem — VoxelTerrainSystem generates terrain as discrete voxel blocks based on heightmap data.
VoxelTerrainSystem.loadedAsVoxelObject
VoxelTerrainSystem.constructor(world: THREE.Object3D, engine: EngineLike | null, terrainHeightProvider: TerrainHeightProvider, terrainRegistry: TerrainTypeRegistry, worldSizeX: number, worldSizeZ: number, config?: VoxelTerrainConfig)
VoxelTerrainSystem.setTerrainBlockMapping(terrainTypeId: number, blockTypeId: number): void
VoxelTerrainSystem.setUndergroundBlockMapping(surfaceBlockId: number, undergroundBlockId: number): void
VoxelTerrainSystem.loadFromUrl(url: string): Promise<boolean>
VoxelTerrainSystem.saveToS3(gameId: string): Promise<string | null>
VoxelTerrainSystem.initializeVoxelWorld(): void
VoxelTerrainSystem.generateVoxelTerrain(): void
VoxelTerrainSystem.finalizeTerrain(): void
VoxelTerrainSystem.finalizeTerrainLazy(spawnX: number, spawnZ: number, initialRadius: number = 150): void
VoxelTerrainSystem.setNavMeshResolution(options: NavMeshBuildOptions): void
VoxelTerrainSystem.getNavMeshResolution(): NavMeshBuildOptions
VoxelTerrainSystem.buildPendingChunksNear(playerX: number, playerZ: number, maxChunks: number = 1, buildRadius: number = 200): void
VoxelTerrainSystem.getLazyGenerationStats(): { builtChunks: number; pendingChunks: number; totalChunks: number } | null
VoxelTerrainSystem.isLazyGenerationComplete(): boolean
VoxelTerrainSystem.beginLevelGeneration(): void
VoxelTerrainSystem.endLevelGeneration(corridorCenterX: number, corridorCenterZ: number, corridorRadius: number = 40): { built: number; deferred: number }
VoxelTerrainSystem.onDeferredBuildComplete(callback: () => void): void
VoxelTerrainSystem.get hasDeferredWork(): boolean
VoxelTerrainSystem.processDeferredWork(budgetMs: number = 200): boolean
VoxelTerrainSystem.adjustSpawnPosition(_worldProfileData: { playerSpawnPosition: { x: number; y: number; z: number } }, _blockSize: number): void
VoxelTerrainSystem.regenerateTerrain(): void
VoxelTerrainSystem.getVoxelWorld(): VoxelWorld | null
VoxelTerrainSystem.isPositionChunkDirty(x: number, z: number): boolean
VoxelTerrainSystem.markCollidersAwaitingPhysicsStep(): void
VoxelTerrainSystem.areCollidersReady(): boolean
VoxelTerrainSystem.onCollidersReady(callback: () => void): void
VoxelTerrainSystem.getHeightAt(x: number, z: number): number
VoxelTerrainSystem.getTerrainOnlyHeight(x: number, z: number): number
VoxelTerrainSystem.getVoxelTerrainHeight(x: number, z: number): number
VoxelTerrainSystem.getVoxelFloorY(x: number, feetY: number, z: number): number | null
VoxelTerrainSystem.getChunkMeshFor2DKey(key2D: string): THREE.Object3D | null
VoxelTerrainSystem.update(_deltaTime: number): void
VoxelTerrainSystem.updateVisibility(camera: THREE.Camera, playerPosition?: THREE.Vector3): void
VoxelTerrainSystem.setCullingEnabled(enabled: boolean): void
VoxelTerrainSystem.isCullingEnabled(): boolean
VoxelTerrainSystem.setMaxRenderDistance(distance: number): void
VoxelTerrainSystem.getMaxRenderDistance(): number
VoxelTerrainSystem.getCullingStats(): { visibleChunks: number; totalChunks: number; culledByDistance: number; culledByFrustum: number } | null
VoxelTerrainSystem.setChunkCollidersEnabled(chunkKey2D: string, enabled: boolean): void
VoxelTerrainSystem.getChunk2DKeys(): Set<string>
VoxelTerrainSystem.registerDynamicObject(obj: ChunkManagedObject, objectRadius: number = 0.5): void
VoxelTerrainSystem.unregisterDynamicObject(obj: ChunkManagedObject): void
VoxelTerrainSystem.updateDynamicObjectPosition(obj: ChunkManagedObject, objectRadius: number = 0.5): void
VoxelTerrainSystem.hasChunkPhysicsManager(): boolean
VoxelTerrainSystem.forceActivateChunksAtPosition(x: number, z: number): void
VoxelTerrainSystem.getChunkPhysicsStats(): { activeChunks: number; trackedObjects: number; registrations: number; terrainAnchors: number } | null
VoxelTerrainSystem.getVoxelChunkGroup(): THREE.Group | null
VoxelTerrainSystem.getVoxelChunkData(): Array<{ chunkX: number; chunkZ: number; worldMinX: number; worldMaxX: number; worldMinZ: number; worldMaxZ: number; mesh: THREE.Mesh; physicsBody: RAPIER.RigidBody | null }>
VoxelTerrainSystem.getVoxelHeightAt(x: number, z: number): number
VoxelTerrainSystem.getBlockSize(): number
VoxelTerrainSystem.getActualVoxelSurfaceHeight(worldX: number, worldZ: number): number
VoxelTerrainSystem.destroyBlockAt(worldX: number, worldY: number, worldZ: number): boolean
VoxelTerrainSystem.deleteTerrainSphere(center: THREE.Vector3, radius: number): number
VoxelTerrainSystem.deleteTerrainBox(min: THREE.Vector3, max: THREE.Vector3): number
VoxelTerrainSystem.setFoliageSystem(foliageSystem: VoxelFoliageSystem): void
VoxelTerrainSystem.generateAllFoliage(getTerrainType: (blockType: number) => number): void
VoxelTerrainSystem.regenerateFoliageForChunk(key2D: string, getTerrainType: (blockType: number) => number): void
VoxelTerrainSystem.setEnvironmentObjectSystem(envSystem: EnvironmentObjectSystem): void
VoxelTerrainSystem.explodeTerrainSphere(center: THREE.Vector3, radius: number, impulseStrength: number = 5, impulseUp: number = 2): VoxelDebris[]
VoxelTerrainSystem.explodeTerrainBox(min: THREE.Vector3, max: THREE.Vector3, impulseDirection?: THREE.Vector3, impulseStrength: number = 5): VoxelDebris[]
VoxelTerrainSystem.deterministicExplodeTerrainSphere(params: DeterministicExplosionParams, physicsWorld: PhysicsWorldType, parentGroup: THREE.Object3D): VoxelDebris[]
VoxelTerrainSystem.updateDebris(): void
VoxelTerrainSystem.clearDebris(): void
VoxelTerrainSystem.findValidVoxelSpawnPosition(worldX: number, worldZ: number, environmentObjectSystem?: EnvironmentObjectSystem, fromY?: number): THREE.Vector3 | null
VoxelTerrainSystem.isAreaFlat(centerX: number, centerZ: number, width: number, depth: number, margin: number = 0): number | null
VoxelTerrainSystem.flattenArea(centerX: number, centerZ: number, width: number, depth: number, height: number, blockType?: number, rebuildMeshes: boolean = false, margin: number = 0, objectId?: string): void
VoxelTerrainSystem.unflattenArea(objectId: string, rebuildMeshes: boolean = true): void
VoxelTerrainSystem.clearFlattenSnapshot(objectId: string): void
VoxelTerrainSystem.hasFlattenSnapshot(objectId: string): boolean
VoxelTerrainSystem.placeBuildingFoundation(id: string, centerX: number, centerZ: number, width: number, depth: number, opts?: Partial<BuildingFoundationOptions>): number
VoxelTerrainSystem.releaseBuildingFoundation(id: string, restoreTerrain: boolean = true, rebuildMeshes: boolean = true): boolean
VoxelTerrainSystem.getBuildingFoundation(id: string): FoliageExclusionRect | null
VoxelTerrainSystem.dispose(): void

## engine/VoxelTerrainTypeProvider.ts
class VoxelTerrainTypeProvider implements TerrainHeightProvider — Terrain type provider for voxel worlds.
VoxelTerrainTypeProvider.constructor(terrainRegistry?: TerrainTypeRegistry)
VoxelTerrainTypeProvider.setVoxelWorld(voxelWorld: VoxelWorld): void
VoxelTerrainTypeProvider.registerBlockTerrainMapping(blockType: number, terrainType: number): void
VoxelTerrainTypeProvider.setDefaultTerrainType(terrainType: number): void
VoxelTerrainTypeProvider.getHeightAt(x: number, z: number): number
VoxelTerrainTypeProvider.getTerrainTypeAt(x: number, z: number): number
VoxelTerrainTypeProvider.getTerrainTypeForBlockType(blockType: number): number
VoxelTerrainTypeProvider.setTerrainTypeAt(_x: number, _z: number, _radius: number, _type: number): void
VoxelTerrainTypeProvider.setTerrainTypeRect(_x: number, _z: number, _widthX: number, _widthZ: number, _type: number): void

## engine/VoxelWaterRefill.ts
interface VoxelWorldLike
VoxelWorldLike.getBlock(x: number, y: number, z: number): number
VoxelWorldLike.setBlock(x: number, y: number, z: number, block: number): void
VoxelWorldLike.getVoxelSize(): number
VoxelWorldLike.getBounds(): { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } | null
VoxelWorldLike.beginBatchUpdate(): void
VoxelWorldLike.endBatchUpdate(): void
VoxelWorldLike.triggerFluidMeshRebuild(dirtyChunkKeys: Set<string>): void
class VoxelWaterRefill
VoxelWaterRefill.constructor(voxelWorld: VoxelWorldLike)
VoxelWaterRefill.refillWaterAfterDestruction(removedBlocks: Array<{ x: number; y: number; z: number; blockType: number }>): void

## engine/VoxelWorld.ts
interface MergedDebris
MergedDebris.vertices: Float32Array
MergedDebris.blockType: number
MergedDebris.rotation: { x: number; y: number; z: number; w: number }
MergedDebris.zFightingOffset: number
MergedDebris.color?: { r: number; g: number; b: number }
MergedDebris.debrisSize?: number
type VoxelMaterialType = 'standard' | 'lambert' | 'atlas'
interface VoxelWorldOptions
VoxelWorldOptions.voxelSize?: number
VoxelWorldOptions.parentGroup?: THREE.Object3D
VoxelWorldOptions.generateNormals?: boolean
VoxelWorldOptions.materialType?: VoxelMaterialType
VoxelWorldOptions.disableGreedyMeshing?: boolean
VoxelWorldOptions.skipShadowMesh?: boolean
VoxelWorldOptions.voxelRoundingRadiusVoxels?: number
VoxelWorldOptions.voxelRoundingSegments?: number
VoxelWorldOptions.onChunkPhysicsRebuilt?: (key: ChunkKey, collisionBoxes: CollisionBox[] | null, cx: number, cy: number, cz: number) => void
class VoxelWorld
VoxelWorld.constructor(physicsWorld: PhysicsWorld | null, scene: THREE.Scene, options: VoxelWorldOptions = {})
VoxelWorld.setVoxelSize(voxelSize: number): void
VoxelWorld.setBounds(bounds: { minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number } | null): void
VoxelWorld.logFillChunkFlatStats(): void
VoxelWorld.buildUniformFlatInstancing(): void
VoxelWorld.getColumnMaxWorldY(x: number, z: number): number | null
VoxelWorld.getColumnUniformGroundY(x: number, z: number): number | null
VoxelWorld.getBlock(x: number, y: number, z: number): BlockID
VoxelWorld.isPositionChunkDirty(x: number, z: number): boolean
VoxelWorld.getAllBlocks(): Array<{ x: number; y: number; z: number; blockType: number }>
VoxelWorld.setBlock(x: number, y: number, z: number, block: BlockID, color?: number): void
VoxelWorld.setBlockFast(x: number, y: number, z: number, block: BlockID, color?: number): void
VoxelWorld.finalizeBulkGeneration(): void
VoxelWorld.fillChunkFlat(cx: number, cy: number, cz: number, surfaceLocalY: number, yLowLocal: number, surfaceBlock: BlockID, subLayers?: BlockID[]): void
VoxelWorld.clearChunksInBounds(minX: number, minZ: number, maxX: number, maxZ: number, minY: number, maxY: number): void
VoxelWorld.getColor(x: number, y: number, z: number): number
VoxelWorld.getTopmostVoxelHeight(vx: number, vz: number): number
VoxelWorld.getTopmostVoxelHeightOfType(vx: number, vz: number, blockType: BlockID): number
VoxelWorld.invalidateHeightCache(): void
VoxelWorld.enableSmoothSurfaceForBlockType(blockId: BlockID): void
VoxelWorld.disableSmoothSurfaceForBlockType(blockId: BlockID): void
VoxelWorld.isSmoothSurfaceEnabledForBlockType(blockId: BlockID): boolean
VoxelWorld.setSmoothSurfaceFilterDistance(distance: number): void
VoxelWorld.getSmoothSurfaceFilterDistance(): number
VoxelWorld.createSmoothSurfaceHeightfield(friction: number = 0.1): void
VoxelWorld.removeSmoothSurfaceHeightfield(): void
VoxelWorld.hasSmoothSurfaceHeightfield(): boolean
VoxelWorld.updatePhysicsAndMeshing(forceAll: boolean = false, playerPos?: { x: number; z: number }): void
VoxelWorld.enableLazyGeneration(): void
VoxelWorld.updatePhysicsAndMeshingInRadius(centerX: number, centerZ: number, radius: number): void
VoxelWorld.buildPendingChunksNear(playerX: number, playerZ: number, maxChunks: number = 1, buildRadius: number = 200): void
VoxelWorld.getLazyGenerationStats()
VoxelWorld.isLazyGenerationComplete(): boolean
VoxelWorld.enableRevealEffect(): void
VoxelWorld.updateRevealEffect(deltaTime: number): void
VoxelWorld.startRevealRandom(): void
VoxelWorld.saveToFile(_filename: string, metadata?: { voxelSize?: number; bounds?: { minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number }; transform?: { position?: { x: number, y: number, z: number }, rotation?: { x: number, y: number, z: number }, scale?: { x: number, y: number, z: number } }; }): Promise<Uint8Array>
VoxelWorld.loadFromFile(buffer: ArrayBuffer): Promise<{ voxelSize?: number; bounds?: { minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number }; transform?: { position?: { x: number, y: number, z: number }, rotation?: { x: number, y: number, z: number }, scale?: { x: number, y: number, z: number } }; }>
VoxelWorld.clear(): void
VoxelWorld.areChunksVisible(): boolean
VoxelWorld.setChunksVisible(visible: boolean): void
VoxelWorld.setCollisionBoxesVisible(visible: boolean): void
VoxelWorld.getChunkCount(): number
VoxelWorld.getChunks(): Map<ChunkKey, Chunk>
VoxelWorld.getTotalVoxelCount(): number
VoxelWorld.getEstimatedMemoryMB(): number
VoxelWorld.setCullingEnabled(en: boolean): void
VoxelWorld.isCullingEnabled(): boolean
VoxelWorld.setMaxRenderDistance(d: number): void
VoxelWorld.getMaxRenderDistance(): number
VoxelWorld.updateChunkVisibility(cam: THREE.Camera): void
VoxelWorld.getCullingStats()
VoxelWorld.clearCullingCache(): void
VoxelWorld.setOnChunkVisibilityChanged(cb: (k: string, v: boolean) => void): void
VoxelWorld.getChunkMeshFor2DKey(key2D: string): THREE.Object3D | null
VoxelWorld.get2DChunkKeys(): string[]
VoxelWorld.getTopSurfaceVoxelsFor2DChunk(k2D: string): Array<{worldX: number, worldY: number, worldZ: number, blockType: number}>
VoxelWorld.getPhysicsStats(): { totalRigidBodies: number; totalBoxShapes: number; totalTriMeshShapes: number; estimatedPhysicsMemoryMB: number }
VoxelWorld.resetPhysicsStats(): void
VoxelWorld.setChunkCollidersEnabled(chunkKey2D: string, enabled: boolean): void
VoxelWorld.getChunk2DKeys(): Set<string>
VoxelWorld.getVoxelSize(): number
VoxelWorld.getBounds(): { minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number } | null
VoxelWorld.setMutationObserver(observer: ((vx: number, vy: number, vz: number, block: BlockID, color: number | undefined) => void) | null): void
VoxelWorld.getTerrainChecksum(): number
VoxelWorld.initializeChecksums(): void
VoxelWorld.addLightSphere(position: THREE.Vector3, radius: number, color: THREE.Color = new THREE.Color(1, 0.5, 0), intensity: number = 1.0): number
VoxelWorld.removeLightSphere(id: number): void
VoxelWorld.clearLightSpheres(): void
VoxelWorld.updateLightSpherePosition(id: number, newPosition: THREE.Vector3): void
VoxelWorld.beginBatchUpdate(): void
VoxelWorld.endBatchUpdate(): void
VoxelWorld.isInBatchMode(): boolean
VoxelWorld.removeBlock(x: number, y: number, z: number): boolean
VoxelWorld.removeBlocksInSphere(centerX: number, centerY: number, centerZ: number, radius: number): Array<{ x: number; y: number; z: number; blockType: number }>
VoxelWorld.removeBlocksInBox(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): Array<{ x: number; y: number; z: number; blockType: number }>
VoxelWorld.detachBlocksInSphere(centerX: number, centerY: number, centerZ: number, radius: number, impulseStrength: number = 5, impulseUp: number = 2): Array<{ body: RAPIER.RigidBody; collider: RAPIER.Collider }>
VoxelWorld.detachBlocksInBox(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, impulseDirection?: THREE.Vector3, impulseStrength: number = 5): Array<{ body: RAPIER.RigidBody; collider: RAPIER.Collider }>
VoxelWorld.clearDebris(): void
VoxelWorld.mergeDebrisIntoChunk(position: THREE.Vector3, quaternion: THREE.Quaternion, blockType: number, debrisSize?: number, color?: { r: number; g: number; b: number }): void
VoxelWorld.rebuildDirtyChunks(): void
VoxelWorld.suppressAutoRebuild(): void
VoxelWorld.resumeAutoRebuild(): void
VoxelWorld.deferAllDirtyChunks(): void
VoxelWorld.rebuildDirtyChunksNear(centerX: number, centerZ: number, radius: number): { built: number; remaining: number }
VoxelWorld.buildNextDeferredChunk(): boolean
VoxelWorld.hasDeferredChunks(): boolean
VoxelWorld.beginLevelGeneration(): void
VoxelWorld.endLevelGeneration(corridorCenterX: number, corridorCenterZ: number, corridorRadius: number): { built: number; deferred: number }
VoxelWorld.isLevelGenerationActive(): boolean
VoxelWorld.tickDeferredBuild(): { active: boolean; remaining: number }
VoxelWorld.setFluidUpdateCallback(callback: (dirtyChunkKeys: Set<string>) => void): void
VoxelWorld.triggerFluidMeshRebuild(dirtyChunkKeys: Set<string>): void
function createVertexColourTerrainMaterial(materialType: 'standard' | 'lambert', offset: { factor: number; units: number }): THREE.Material

## engine/VoxelWorldDestruction.ts
function removeBlocksInSphere(world: VoxelWorld, centerX: number, centerY: number, centerZ: number, radius: number): Array<{ x: number; y: number; z: number; blockType: number }>
function removeBlocksInBox(world: VoxelWorld, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): Array<{ x: number; y: number; z: number; blockType: number }>
function detachBlocksInSphere(world: VoxelWorld, centerX: number, centerY: number, centerZ: number, radius: number, impulseStrength: number = 5, impulseUp: number = 2): Array<{ body: RAPIER.RigidBody; collider: RAPIER.Collider }>
function detachBlocksInBox(world: VoxelWorld, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, impulseDirection?: THREE.Vector3, impulseStrength: number = 5): Array<{ body: RAPIER.RigidBody; collider: RAPIER.Collider }>
function clearDebris(world: VoxelWorld): void

## engine/VoxelWorldVxlIO.ts
interface VxlIOWorld<TChunk extends VoxelChunk> — Minimum surface VoxelWorld exposes for its IO helpers. The `Chunk` type is
VxlIOWorld.chunks: Map<string, TChunk>
VxlIOWorld.dirtyChunks: Set<TChunk>
VxlIOWorld.clear(): void
interface VoxelWorldSaveOptions
VoxelWorldSaveOptions.voxelSize: number
VoxelWorldSaveOptions.bounds?: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }
interface VoxelWorldLoadResult
VoxelWorldLoadResult.voxelSize?: number
VoxelWorldLoadResult.bounds?: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }
interface ChunkLeafConversion — One leaf per solid voxel, plus the box they span.
ChunkLeafConversion.leaves: OctreeLeaf[]
ChunkLeafConversion.bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }
function chunksToOctreeLeaves<TChunk extends VoxelChunk>(chunks: Map<string, TChunk>, voxelSize: number, base: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 }, carryBlockTypes = false): ChunkLeafConversion
function encodeVoxelWorldAsVxlV3<TChunk extends VoxelChunk>(world: VxlIOWorld<TChunk>, opts: VoxelWorldSaveOptions): Promise<Uint8Array>
function loadVxlV3IntoVoxelWorld<TChunk extends VoxelChunk>(world: VxlIOWorld<TChunk>, buffer: ArrayBuffer, newChunk: () => TChunk): Promise<VoxelWorldLoadResult>

## engine/VxlCharacterMesh.ts
interface VxlCharacterColumns
VxlCharacterColumns.position: Float32Array
VxlCharacterColumns.normal: Float32Array
VxlCharacterColumns.color: Float32Array
VxlCharacterColumns.index: Uint32Array
VxlCharacterColumns.joint: Uint8Array
VxlCharacterColumns.groups: Array<{ start: number; count: number }>
VxlCharacterColumns.quads: number
VxlCharacterColumns.culled: number
VxlCharacterColumns.didCull: boolean
interface BuildVxlCharacterOptions
BuildVxlCharacterOptions.lod?: number
BuildVxlCharacterOptions.includeFillers?: boolean
function buildVxlCharacterColumns(decoded: DecodedVxlV3, options: BuildVxlCharacterOptions = {}): VxlCharacterColumns
interface VxlBindSkeleton
VxlBindSkeleton.bones: THREE.Bone[]
VxlBindSkeleton.root: THREE.Group
VxlBindSkeleton.ref: VoxelSkeletonRef
function createVxlBindSkeleton(rig: VxlV3Rig): VxlBindSkeleton
function assembleVxlSkinnedMesh(columns: VxlCharacterColumns, skeleton: VxlBindSkeleton, material: THREE.Material | THREE.Material[]): THREE.SkinnedMesh
function assembleVxlJointMeshes(columns: VxlCharacterColumns, skeleton: VxlBindSkeleton, material: THREE.Material): THREE.Mesh[]
