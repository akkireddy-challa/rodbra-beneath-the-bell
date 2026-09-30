# engine-api-voxel-render

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/BlockCharacterRenderer.ts
function setBlockCharacterPoseVersion(version: number | undefined | null): void
interface BlockFootPose — Source-pose facts, before block bounding-box grounding. Optional on update()
BlockFootPose.grounded: boolean
BlockFootPose.bound: boolean
BlockFootPose.authoredFootLift: number | null
BlockFootPose.characterHeight: number
BlockFootPose.deltaSeconds: number
BlockFootPose.restRotations: ReadonlyMap<string, THREE.Quaternion> | null
interface BlockPosePartOffset — One owned body part's offset from the pose snapshot.
BlockPosePartOffset.position: THREE.Vector3
BlockPosePartOffset.rotation: THREE.Quaternion
interface BlockPoseArmTarget — One arm laid out from its shoulder to a world point. Only the named side's
BlockPoseArmTarget.side: 'left' | 'right'
BlockPoseArmTarget.position: THREE.Vector3
BlockPoseArmTarget.rotation: THREE.Quaternion
interface BlockPoseOverrideState — Everything a pose override holds. The renderer keeps the object it is handed
BlockPoseOverrideState.parts: Map<string, BlockPosePartOffset>
BlockPoseOverrideState.weight: number
BlockPoseOverrideState.preserveFeet: boolean
BlockPoseOverrideState.preserveRootHeight: boolean
BlockPoseOverrideState.armTarget: BlockPoseArmTarget | null
const BLOCK_BODY_PART_NAMES = [ 'head', 'neck', 'torso', 'leftUpperArm', 'leftForearm', 'l
interface BlockMeshSet — A pre-built set of block meshes for one look ("outfit"), recorded per body
BlockMeshSet.readonly parts: Map<string, THREE.Object3D[]>
BlockMeshSet.readonly extraGroups: THREE.Group[]
class BlockCharacterRenderer — Block Character Renderer
static BlockCharacterRenderer.footRotationTuning
static BlockCharacterRenderer.create(animatedSkeleton: THREE.Object3D, factory: IBlockCharacterFactory): BlockCharacterRenderer
BlockCharacterRenderer.getRoot(): THREE.Group
BlockCharacterRenderer.getBodyPart(name: string): THREE.Object3D | null
BlockCharacterRenderer.tintBodyPart(name: string, color: number): boolean
BlockCharacterRenderer.buildMeshSet(factory: IBlockCharacterFactory): BlockMeshSet
BlockCharacterRenderer.applyMeshSet(set: BlockMeshSet): void
BlockCharacterRenderer.getOriginalMeshSet(): BlockMeshSet
BlockCharacterRenderer.getAppliedMeshSet(): BlockMeshSet
BlockCharacterRenderer.disposeMeshSet(set: BlockMeshSet): void
static BlockCharacterRenderer.forEachMeshSetObject(set: BlockMeshSet, callback: (object: THREE.Object3D) => void): void
BlockCharacterRenderer.update(footPose?: BlockFootPose): void
BlockCharacterRenderer.canGroundLeg(side: 'left' | 'right'): boolean
BlockCharacterRenderer.setBoneTransformOverrides(overrides: Map<string, { position: THREE.Vector3; rotation: THREE.Quaternion }> | null): void
BlockCharacterRenderer.setHeadWorldYaw(yaw: number | null): void
static BlockCharacterRenderer.boneNamesForPart(partName: string): string[]
BlockCharacterRenderer.setCoordinateCorrection(correction: THREE.Quaternion): void
BlockCharacterRenderer.setModelForward(forward: THREE.Vector3): void
BlockCharacterRenderer.setAttachmentOverride(bodyPartName: string, target: THREE.Object3D, localPosition?: THREE.Vector3, localRotation?: THREE.Euler): void
BlockCharacterRenderer.setArmAttachmentOverride(side: 'left' | 'right', target: THREE.Object3D, localPosition?: THREE.Vector3, handRotation?: THREE.Euler, options?: { followTargetHeight?: boolean }): void
BlockCharacterRenderer.clearArmAttachmentOverride(side: 'left' | 'right'): void
BlockCharacterRenderer.clearAttachmentOverride(bodyPartName: string): void
BlockCharacterRenderer.clearAllAttachmentOverrides(): void
BlockCharacterRenderer.getArmAttachmentShoulder(side: 'left' | 'right', target: THREE.Vector3): boolean
BlockCharacterRenderer.refreshArmAttachments(): void
BlockCharacterRenderer.detachFromAnimation(bodyPartName: string): void
BlockCharacterRenderer.reattachToAnimation(bodyPartName: string): void
BlockCharacterRenderer.isDetachedFromAnimation(bodyPartName: string): boolean
BlockCharacterRenderer.getDetachedBodyParts(): string[]
BlockCharacterRenderer.setPoseOverride(state: BlockPoseOverrideState): void
BlockCharacterRenderer.hasPoseOverride(): boolean
BlockCharacterRenderer.clearPoseOverride(): void
BlockCharacterRenderer.resolvePoseOverrideRootY(groundY: number): number | null
BlockCharacterRenderer.dispose(): void

## engine/VoxelAssetBounds.ts
interface VoxelBoundsLeaf — The only leaf fields the bounds math needs (an `OctreeLeaf` satisfies this).
VoxelBoundsLeaf.x: number
VoxelBoundsLeaf.y: number
VoxelBoundsLeaf.z: number
VoxelBoundsLeaf.size: number
interface VoxelAssetBounds
VoxelAssetBounds.minX: number
VoxelAssetBounds.minY: number
VoxelAssetBounds.minZ: number
VoxelAssetBounds.maxX: number
VoxelAssetBounds.maxY: number
VoxelAssetBounds.maxZ: number
function expandBoundsToFitLeaves(bounds: VoxelAssetBounds, leaves: readonly VoxelBoundsLeaf[], step: number): void

## engine/VoxelChunkCulling.ts
interface CullingStats
CullingStats.visibleChunks: number
CullingStats.totalChunks: number
CullingStats.culledByDistance: number
CullingStats.culledByFrustum: number
interface ChunkLike
ChunkLike.collisionMesh: THREE.Object3D | null
interface CullableBounds
CullableBounds.minX: number
CullableBounds.minY: number
CullableBounds.minZ: number
class VoxelChunkCulling
VoxelChunkCulling.constructor(private voxelSize: number, private bounds: CullableBounds | null, private chunksShouldBeVisible: boolean)
VoxelChunkCulling.setOnChunkVisibilityChanged(callback: (chunkKey2D: string, visible: boolean) => void): void
VoxelChunkCulling.setCullingEnabled(enabled: boolean, chunks: Map<ChunkKey, ChunkLike>): void
VoxelChunkCulling.isCullingEnabled(): boolean
VoxelChunkCulling.setMaxRenderDistance(distance: number): void
VoxelChunkCulling.getMaxRenderDistance(): number
VoxelChunkCulling.getCullingStats(): CullingStats
VoxelChunkCulling.clearCache(): void
VoxelChunkCulling.updateBounds(bounds: CullableBounds | null): void
VoxelChunkCulling.updateVisibility(camera: THREE.Camera, chunks: Map<ChunkKey, ChunkLike>): void

## engine/VoxelDecalSystem.ts
interface DecalSystemConfig — Configuration for the decal system
DecalSystemConfig.maxDecals?: number
DecalSystemConfig.decalSize?: number
DecalSystemConfig.defaultColor?: number
DecalSystemConfig.enabled?: boolean
DecalSystemConfig.physicsWorld?: PhysicsWorld
interface DecalOptions — Options for spawning a single decal
DecalOptions.position: THREE.Vector3
DecalOptions.normal: THREE.Vector3
DecalOptions.color?: number
DecalOptions.size?: number
class VoxelDecalSystem
VoxelDecalSystem.constructor(scene: THREE.Scene, config: DecalSystemConfig = {})
VoxelDecalSystem.setPhysicsWorld(physicsWorld: PhysicsWorld): void
VoxelDecalSystem.spawn(options: DecalOptions): number
VoxelDecalSystem.spawnFromHit(hitPoint: THREE.Vector3, hitNormal: THREE.Vector3, color?: number, size?: number): number
VoxelDecalSystem.processPendingDecals(): void
VoxelDecalSystem.spawnTireMark(position: THREE.Vector3, direction: THREE.Vector3, width: number = 0.2, color: number = 0x222222): number
VoxelDecalSystem.clear(): void
VoxelDecalSystem.getActiveCount(): number
VoxelDecalSystem.getMaxDecals(): number
VoxelDecalSystem.isEnabled(): boolean
VoxelDecalSystem.setEnabled(enabled: boolean): void
VoxelDecalSystem.updateConfig(config: DecalSystemConfig): void
VoxelDecalSystem.dispose(): void
function initDecalSystem(scene: THREE.Scene, config?: DecalSystemConfig): VoxelDecalSystem
function getDecalSystem(): VoxelDecalSystem | null
function spawnDecal(options: DecalOptions): number
function spawnDecalFromHit(hitPoint: THREE.Vector3, hitNormal: THREE.Vector3, color?: number, size?: number): number

## engine/VoxelEmissiveMaterial.ts
const EMISSIVE_INTENSITY = 3.0
const LUMA_WEIGHTS: readonly [number, number, number]
const MIN_GLOW_LUMINANCE = 0.05
function glowGainForLuminance(luminance: number): number
const GLOW_GAIN_GLSL = `(${EMISSIVE_INTENSITY.toFixed(1)} / max(dot(diffuseColor.rg
interface VoxelMaterialParams — Visual parameters shared by both voxel material shapes (atlas-mapped and
VoxelMaterialParams.map: THREE.Texture | null
VoxelMaterialParams.vertexColors: boolean
VoxelMaterialParams.flatShading: boolean
VoxelMaterialParams.polygonOffsetFactor: number
VoxelMaterialParams.polygonOffsetUnits: number
const VOXEL_EMISSIVE_FLAG = 'voxelEmissive'
function isVoxelEmissiveMaterial(material: THREE.Material): boolean
function applyWebGlEmissive(mat: THREE.MeshLambertMaterial | THREE.MeshPhongMaterial | THREE.MeshPhysicalMaterial): void
function applyNodeEmissive(mat: THREE.Material): void
function glowGainNode()
function createWebGlVoxelMaterial(params: VoxelMaterialParams, emissive: boolean): THREE.Material
function createVoxelMaterial(params: VoxelMaterialParams, emissive: boolean): THREE.Material

## engine/VoxelFlatFaceMerge.ts
interface FlatFaceSquare — One leaf face projected onto its slice plane, in min-cell coordinates.
FlatFaceSquare.u0: number
FlatFaceSquare.v0: number
FlatFaceSquare.size: number
FlatFaceSquare.color: number
interface FlatFaceRect — A merged rectangle in the same cell coordinates. Max corner is exclusive.
FlatFaceRect.u0: number
FlatFaceRect.v0: number
FlatFaceRect.u1: number
FlatFaceRect.v1: number
FlatFaceRect.color: number
function mergeFlatFaceSquares(squares: readonly FlatFaceSquare[]): FlatFaceRect[]

## engine/VoxelFoliageSystem.ts
interface SurfaceVoxel — Surface voxel data for foliage generation
SurfaceVoxel.worldX: number
SurfaceVoxel.worldY: number
SurfaceVoxel.worldZ: number
SurfaceVoxel.blockType: number
const FOLIAGE_VOXEL_SIZE = 0.05
interface FoliageCreatorContext — Context passed to custom foliage creators
FoliageCreatorContext.rng: SeededRandom
FoliageCreatorContext.voxelSize: number
FoliageCreatorContext.parent: THREE.Group
FoliageCreatorContext.addMesh: (mesh: THREE.InstancedMesh) => void
FoliageCreatorContext.getRandomOffset: () => number
type FoliageCreator = ( positions: THREE.Matrix4[], ctx: FoliageCreatorContext ) => void
interface CustomFoliageType — Configuration for a custom foliage type.
CustomFoliageType.name: string
CustomFoliageType.foliageTypes: number[]
CustomFoliageType.spawnChance: number
CustomFoliageType.creator: FoliageCreator
interface FoliageExclusionRect — Axis-aligned world-space rectangle (XZ) in which no foliage grows.
FoliageExclusionRect.minX: number
FoliageExclusionRect.minZ: number
FoliageExclusionRect.maxX: number
FoliageExclusionRect.maxZ: number
interface VoxelFoliageConfig
VoxelFoliageConfig.terrainVoxelSize: number
VoxelFoliageConfig.getTerrainHeight: (x: number, z: number) => number
VoxelFoliageConfig.isPositionOccupied?: (x: number, z: number) => boolean
VoxelFoliageConfig.customFoliage?: CustomFoliageType[]
VoxelFoliageConfig.appearance?: Partial<FoliageAppearance>
class VoxelFoliageSystem — VoxelFoliageSystem - Generates grass, flowers, pebbles, cacti using InstancedMesh.
VoxelFoliageSystem.appearance: FoliageAppearance
VoxelFoliageSystem.constructor(world: THREE.Object3D, worldSizeX: number, worldSizeZ: number, seed: number, terrainRegistry: TerrainTypeRegistry, terrainHeightProvider: TerrainHeightProvider, config: VoxelFoliageConfig)
VoxelFoliageSystem.generateFoliageForChunk(chunkKey: string, surfaceVoxels: SurfaceVoxel[], chunkParent: THREE.Object3D, getTerrainType: (blockType: number) => number): void
VoxelFoliageSystem.removeFoliageForChunk(chunkKey: string): void
VoxelFoliageSystem.clearFoliageAt(x: number, z: number, radius: number): void
VoxelFoliageSystem.clearFoliageInRect(minX: number, minZ: number, maxX: number, maxZ: number): string
VoxelFoliageSystem.addFoliageExclusion(id: string, minX: number, minZ: number, maxX: number, maxZ: number): void
VoxelFoliageSystem.removeFoliageExclusion(id: string): boolean
VoxelFoliageSystem.isFoliageExcluded(x: number, z: number): boolean
VoxelFoliageSystem.detachFoliageInSphere(centerX: number, centerY: number, centerZ: number, radius: number, impulseStrength: number = 5, impulseUp: number = 3): void
VoxelFoliageSystem.updateDebris(deltaTime: number): void
VoxelFoliageSystem.getDebrisCount(): number
VoxelFoliageSystem.dispose(): void

## engine/VoxelGeometry.ts
type BlockID = number
type ChunkKey = string
const CHUNK_SIZE = 16
const CHUNK_MASK = CHUNK_SIZE - 1
interface CollisionBox
CollisionBox.x: number
CollisionBox.y: number
CollisionBox.z: number
CollisionBox.w: number
CollisionBox.h: number
CollisionBox.d: number
CollisionBox.blockType?: BlockID
interface VoxelBounds
VoxelBounds.minX: number
VoxelBounds.minY: number
VoxelBounds.minZ: number
VoxelBounds.maxX: number
VoxelBounds.maxY: number
VoxelBounds.maxZ: number
const FACE_TEMPLATES: ReadonlyArray<ReadonlyArray<number>>
const FACE_INDICES: ReadonlyArray<number>
class ColorChunk — Color storage using RLE encoding with RGB565 format.
ColorChunk.data: Uint32Array
ColorChunk.length: number
ColorChunk.constructor()
static ColorChunk.rgb888To565(r: number, g: number, b: number): number
static ColorChunk.rgb565To888(rgb565: number): number
ColorChunk.get(x: number, y: number, z: number): number
ColorChunk.hasColor(x: number, y: number, z: number): boolean
ColorChunk.set(x: number, y: number, z: number, rgb24: number): void
class VoxelChunk — Voxel chunk with RLE-encoded block data and colors.
VoxelChunk.palette: BlockID[]
VoxelChunk.colors: ColorChunk
VoxelChunk.collisionBoxes: CollisionBox[] | null
VoxelChunk.needsRemesh: boolean
VoxelChunk.constructor()
VoxelChunk.forEachRun(callback: (paletteIndex: number, runLength: number) => void): void
VoxelChunk.getCompactedRle(): Uint16Array
VoxelChunk.setRleData(data: number[] | Uint16Array): void
VoxelChunk.clearRleRuns(): void
VoxelChunk.getRleBufferByteLength(): number
VoxelChunk.ensureCompacted(): void
VoxelChunk.get(x: number, y: number, z: number): BlockID
VoxelChunk.clearToAir(): void
VoxelChunk.fillFlat(surfaceLocalY: number, yLowLocal: number, surfaceBlock: BlockID, subLayers?: BlockID[]): void
VoxelChunk.set(x: number, y: number, z: number, block: BlockID): void
function generateCollisionBoxes(chunk: VoxelChunk, skipBlock?: (blockType: number) => boolean): CollisionBox[]
function parseChunkKey(key: ChunkKey): { cx: number; cy: number; cz: number } | null
function makeChunkKey(cx: number, cy: number, cz: number): ChunkKey
interface BaseFootprint — X/Z extent of an object's base, in the mesh's own local (pivot-relative) space.
BaseFootprint.minX: number
BaseFootprint.maxX: number
BaseFootprint.minZ: number
BaseFootprint.maxZ: number
function baseFootprint(chunks: Map<ChunkKey, VoxelChunk>, voxelSize: number, boundsOffset: Readonly<{ x: number; z: number }>, pivot: Readonly<{ x: number; z: number }>): BaseFootprint | null
function footprintGroundSamples(footprint: Readonly<BaseFootprint>, x: number, z: number, yaw: number, scaleX: number, scaleZ: number, step: number): Array<{ x: number; z: number }>
function footprintGroundHeight(footprint: Readonly<BaseFootprint>, x: number, z: number, yaw: number, scaleX: number, scaleZ: number, step: number, sampleHeight: (x: number, z: number) => number): number
function sphereIntersectsAabb(center: { x: number; y: number; z: number }, radiusSq: number, aabbMin: [number, number, number], aabbMax: [number, number, number]): boolean

## engine/VoxelLeafPartition.ts
function spatialMidpointPartition(leaves: OctreeLeaf[], targetPieces: number): OctreeLeaf[][]

## engine/VoxelOctreeRenderer.ts
interface OctreeMeshRounding — Rounded-edge rendering for octree voxel meshes — the same visual treatment
OctreeMeshRounding.radiusVoxels: number
OctreeMeshRounding.segments: number
interface OctreeNodeV2
OctreeNodeV2.min: [number, number, number]
OctreeNodeV2.size: number
OctreeNodeV2.color?: number
OctreeNodeV2.children?: (OctreeNodeV2 | null)[]
interface OctreeLeaf
OctreeLeaf.x: number
OctreeLeaf.y: number
OctreeLeaf.z: number
OctreeLeaf.size: number
OctreeLeaf.r: number
OctreeLeaf.g: number
OctreeLeaf.b: number
OctreeLeaf.emissive?: number
OctreeLeaf.blockType?: number
OctreeLeaf.slot?: number
OctreeLeaf.bone?: number
function packRgb444(r: number, g: number, b: number): number
function unpackRgb444(c: number): { r: number; g: number; b: number }
class LeafBuffer — Structure-of-Arrays voxel-leaf store — the runtime replacement for `OctreeLeaf[]`.
LeafBuffer.count: number
LeafBuffer.gx: Uint16Array
LeafBuffer.gy: Uint16Array
LeafBuffer.gz: Uint16Array
LeafBuffer.lod: Uint8Array
LeafBuffer.color: Uint16Array
LeafBuffer.emiss: Uint8Array | null
LeafBuffer.slot: Uint8Array | null
LeafBuffer.blockType: Uint16Array | null
LeafBuffer.palIdx: Uint16Array | null
LeafBuffer.bone: Uint8Array | null
LeafBuffer.minVoxelSize: number
LeafBuffer.baseX: number
LeafBuffer.baseY: number
LeafBuffer.baseZ: number
LeafBuffer.constructor(count: number, minVoxelSize: number, baseX: number, baseY: number, baseZ: number)
LeafBuffer.worldX(i: number): number
LeafBuffer.worldY(i: number): number
LeafBuffer.worldZ(i: number): number
LeafBuffer.worldSize(i: number): number
LeafBuffer.forEach(cb: (leaf: OctreeLeaf, i: number) => void): void
LeafBuffer.toArray(useAtlas = false): OctreeLeaf[]
LeafBuffer.subset(keep: (index: number) => boolean): LeafBuffer
static LeafBuffer.fromArray(leaves: OctreeLeaf[], minVoxelSize: number, baseX: number, baseY: number, baseZ: number): LeafBuffer
type LeafSource = ReadonlyArray<OctreeLeaf> | LeafBuffer
type LeafSources = LeafSource | ReadonlyArray<LeafSource>
function leafSourceCount(src: LeafSources): number
function forEachLeaf(src: LeafSources, cb: (leaf: OctreeLeaf) => void): void
function octreeLeafIntersectsSpherePivotLocal(leaf: OctreeLeaf, pivotX: number, pivotY: number, pivotZ: number, sphereX: number, sphereY: number, sphereZ: number, radiusSq: number): boolean
function flattenOctreeLeaves(node: OctreeNodeV2 | null, out: OctreeLeaf[]): void
const VOXEL_SLOT_HANDLES = 'voxelSlotHandles'
interface VoxelSlotPlan — A mesh's material-slot split: the named slots and their index-buffer ranges.
VoxelSlotPlan.slots: VoxelSlot[]
VoxelSlotPlan.groups: Array<{ start: number; count: number }>
function buildOctreeMesh(leaves: OctreeLeaf[], pivotX: number, pivotY: number, pivotZ: number, shadows: boolean, zFightingId: string, rounding: OctreeMeshRounding | null = null, slots: VoxelSlot[] = [], useAtlas: boolean = false): THREE.Mesh
function buildOctreeMeshFromBuffers(buffers: LeafBuffer[], pivotX: number, pivotY: number, pivotZ: number, shadows: boolean, zFightingId: string, useAtlas: boolean = false, rounding: OctreeMeshRounding | null = null, slots: VoxelSlot[] = []): THREE.Mesh | null
interface OctreeColliderOpts
OctreeColliderOpts.sx?: number
OctreeColliderOpts.sy?: number
OctreeColliderOpts.sz?: number
OctreeColliderOpts.density?: number
OctreeColliderOpts.friction?: number
OctreeColliderOpts.restitution?: number
OctreeColliderOpts.dynamic?: boolean
interface PhysicsBox
PhysicsBox.cx: number
PhysicsBox.cy: number
PhysicsBox.cz: number
PhysicsBox.hx: number
PhysicsBox.hy: number
PhysicsBox.hz: number
interface OctreeVoxelCells — The voxels-collider input for a leaf set: flat boundary-cell triples (see
OctreeVoxelCells.cells: Int32Array
OctreeVoxelCells.gs: number
OctreeVoxelCells.gMinX: number
OctreeVoxelCells.gMinY: number
OctreeVoxelCells.gMinZ: number
function octreeVoxelCells(leaves: LeafSources, pivotX: number, pivotY: number, pivotZ: number, gridStep: number): OctreeVoxelCells | null
function greedyMeshOctreeLeaves(leaves: LeafSources, pivotX: number, pivotY: number, pivotZ: number, gridStep: number): PhysicsBox[]
function createOctreeColliders(leaves: LeafSources, pivotX: number, pivotY: number, pivotZ: number, gridStep: number, pw: PhysicsWorld, body: RAPIER.RigidBody, groups: number, opts?: OctreeColliderOpts): RAPIER.Collider[]
function octreeTotalVolume(leaves: LeafSources): number
function leafListCentroid(leaves: OctreeLeaf[]): { x: number; y: number; z: number }

## engine/VoxelPreviewRenderer.ts
const PREVIEW_LEAF_BUDGET = 20_000
function pickPreviewLod(decoded: DecodedVxlV3): readonly DecodedFragment[]
class VoxelPreviewRenderer
VoxelPreviewRenderer.generatePreview(vxlData: ArrayBuffer): Promise<string>
VoxelPreviewRenderer.dispose(): void
function getVoxelPreviewRenderer(): VoxelPreviewRenderer

## engine/VoxelRoundedMesh.ts
const ROUNDED_EDGES_RADIUS_VOXELS = 0.4
function mergeVoxelRoundingRadiusVoxels(worldRadiusVoxels: number, blockRadiusVoxels: number | undefined): number
interface DiagonalVoxelInfo
DiagonalVoxelInfo.blockType: number
DiagonalVoxelInfo.r: number
DiagonalVoxelInfo.g: number
DiagonalVoxelInfo.b: number
interface FloorBridgeQuadParams — Emit horizontal "bridge" quads at outer corner gaps where the diagonally
FloorBridgeQuadParams.positions: number[]
FloorBridgeQuadParams.colors: number[]
FloorBridgeQuadParams.normals: number[]
FloorBridgeQuadParams.uvs: number[]
FloorBridgeQuadParams.indices: number[]
FloorBridgeQuadParams.centerX: number
FloorBridgeQuadParams.centerY: number
FloorBridgeQuadParams.centerZ: number
FloorBridgeQuadParams.halfA: number
FloorBridgeQuadParams.halfB: number
FloorBridgeQuadParams.halfC: number
FloorBridgeQuadParams.radius: number
FloorBridgeQuadParams.exposedFaces: readonly boolean[]
FloorBridgeQuadParams.boxMinVoxX: number
FloorBridgeQuadParams.boxMinVoxY: number
FloorBridgeQuadParams.boxMinVoxZ: number
FloorBridgeQuadParams.boxW: number
FloorBridgeQuadParams.boxH: number
FloorBridgeQuadParams.boxD: number
FloorBridgeQuadParams.sampleVoxel: (vx: number, vy: number, vz: number) => DiagonalVoxelInfo | null
FloorBridgeQuadParams.useAtlas: boolean
FloorBridgeQuadParams.getAtlasRegion: ((diag: DiagonalVoxelInfo, faceType: 'top' | 'bottom') => AtlasUV | null) | null
FloorBridgeQuadParams.generateNormals: boolean
function appendFloorBridgeQuads(p: FloorBridgeQuadParams): void
interface RoundedAtlasContext
RoundedAtlasContext.isColorPalette: boolean
RoundedAtlasContext.rgb24: number
RoundedAtlasContext.getAtlasRegionForFace(faceIndex: number): AtlasUV | null
RoundedAtlasContext.getPaletteUV(rgb24: number): AtlasUV | null
interface AppendRoundedVoxelMeshParams
AppendRoundedVoxelMeshParams.positions: number[]
AppendRoundedVoxelMeshParams.colors: number[]
AppendRoundedVoxelMeshParams.normals: number[]
AppendRoundedVoxelMeshParams.uvs: number[]
AppendRoundedVoxelMeshParams.indices: number[]
AppendRoundedVoxelMeshParams.centerX: number
AppendRoundedVoxelMeshParams.centerY: number
AppendRoundedVoxelMeshParams.centerZ: number
AppendRoundedVoxelMeshParams.width: number
AppendRoundedVoxelMeshParams.height: number
AppendRoundedVoxelMeshParams.depth: number
AppendRoundedVoxelMeshParams.radius: number
AppendRoundedVoxelMeshParams.segments: number
AppendRoundedVoxelMeshParams.exposedFaces: readonly boolean[]
AppendRoundedVoxelMeshParams.cornerInnerFlags?: readonly boolean[]
AppendRoundedVoxelMeshParams.rgb: readonly [number, number, number]
AppendRoundedVoxelMeshParams.atlas: RoundedAtlasContext | null
AppendRoundedVoxelMeshParams.generateNormals: boolean
function appendRoundedVoxelMesh(params: AppendRoundedVoxelMeshParams): void

## engine/VoxelShadowSystem.ts
interface VoxelChunkProvider — Interface for accessing voxel data from chunks
VoxelChunkProvider.getChunks(): Map<string, { get(x: number, y: number, z: number): BlockID; colors: { get(x: number, y: number, z: number): number } }>
VoxelChunkProvider.getBounds(): { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } | null
VoxelChunkProvider.getVoxelSize(): number
VoxelChunkProvider.getParentGroup(): THREE.Object3D
VoxelChunkProvider.isPlacedObject(): boolean
VoxelChunkProvider.shouldSkipShadowMesh(): boolean
class VoxelShadowSystem
VoxelShadowSystem.constructor(provider: VoxelChunkProvider)
VoxelShadowSystem.getShadowMesh(): THREE.Mesh | null
VoxelShadowSystem.getLightReceiverMesh(): THREE.Mesh | null
VoxelShadowSystem.scheduleShadowUpdate(): void
VoxelShadowSystem.updateShadowMesh(): void
VoxelShadowSystem.addLightSphere(position: THREE.Vector3, radius: number, color: THREE.Color = new THREE.Color(1, 0.5, 0), intensity: number = 1.0): number
VoxelShadowSystem.removeLightSphere(id: number): void
VoxelShadowSystem.clearLightSpheres(): void
VoxelShadowSystem.updateLightSpherePosition(id: number, newPosition: THREE.Vector3): void
VoxelShadowSystem.dispose(): void

## engine/VoxelSmoothSurface.ts
interface VoxelHeightProvider — Interface for providing voxel height data.
VoxelHeightProvider.getTopmostVoxelHeight(vx: number, vz: number): number
VoxelHeightProvider.getTopmostVoxelHeightOfType(vx: number, vz: number, blockType: BlockID): number
class VoxelSmoothSurfaceManager — Manages smooth surface height calculations for voxel terrain.
VoxelSmoothSurfaceManager.constructor(filterDistance: number = 2.0)
VoxelSmoothSurfaceManager.setHeightProvider(provider: VoxelHeightProvider): void
VoxelSmoothSurfaceManager.enableForBlockType(blockId: BlockID): void
VoxelSmoothSurfaceManager.disableForBlockType(blockId: BlockID): void
VoxelSmoothSurfaceManager.isEnabledForBlockType(blockId: BlockID): boolean
VoxelSmoothSurfaceManager.getSmoothBlockTypes(): Set<BlockID>
VoxelSmoothSurfaceManager.setFilterDistance(distance: number): void
VoxelSmoothSurfaceManager.getFilterDistance(): number
VoxelSmoothSurfaceManager.invalidateCache(): void
VoxelSmoothSurfaceManager.logStats(label: string = ''): void
VoxelSmoothSurfaceManager.getSmoothedHeight(vx: number, vz: number, blockType: BlockID): number
VoxelSmoothSurfaceManager.calculateSmoothOffset(cornerVx: number, cornerVz: number, voxelX: number, voxelZ: number, boxTopY: number, blockType: BlockID, voxelSize: number): number
VoxelSmoothSurfaceManager.getSurfaceNormal(vx: number, vz: number, blockType: BlockID, voxelSize: number): { x: number; y: number; z: number }

## engine/VoxelSplineSurface.ts
interface VoxelHeightProvider — Interface for providing voxel height data.
VoxelHeightProvider.getTopmostVoxelHeight(vx: number, vz: number): number
VoxelHeightProvider.getTopmostVoxelHeightOfType(vx: number, vz: number, blockType: BlockID): number
interface CollisionBox — A collision box from greedy meshing.
CollisionBox.x: number
CollisionBox.y: number
CollisionBox.z: number
CollisionBox.w: number
CollisionBox.h: number
CollisionBox.d: number
CollisionBox.blockType?: BlockID
class VoxelSmoothSurfaceManager — Manages smooth surface height calculations for voxel terrain.
VoxelSmoothSurfaceManager.constructor(filterDistance: number = 2.0)
VoxelSmoothSurfaceManager.setHeightProvider(provider: VoxelHeightProvider): void
VoxelSmoothSurfaceManager.enableForBlockType(blockId: BlockID): void
VoxelSmoothSurfaceManager.disableForBlockType(blockId: BlockID): void
VoxelSmoothSurfaceManager.isEnabledForBlockType(blockId: BlockID): boolean
VoxelSmoothSurfaceManager.getSmoothBlockTypes(): Set<BlockID>
VoxelSmoothSurfaceManager.setFilterDistance(distance: number): void
VoxelSmoothSurfaceManager.getFilterDistance(): number
VoxelSmoothSurfaceManager.invalidateCache(): void
VoxelSmoothSurfaceManager.logStats(label: string = ''): void
VoxelSmoothSurfaceManager.getSmoothedHeight(vx: number, vz: number, blockType: BlockID): number
VoxelSmoothSurfaceManager.calculateSmoothOffset(cornerVx: number, cornerVz: number, voxelX: number, voxelZ: number, boxTopY: number, blockType: BlockID, voxelSize: number): number
VoxelSmoothSurfaceManager.getSurfaceNormal(vx: number, vz: number, blockType: BlockID, voxelSize: number): { x: number; y: number; z: number }
const SMOOTH_PHYSICS_SUBDIVISIONS = 4
function buildSmoothPhysicsTrimesh(boxes: CollisionBox[], chunkWorldX: number, chunkWorldY: number, chunkWorldZ: number, chunkGridX: number, chunkGridY: number, chunkGridZ: number, voxelSize: number, smoothSurfaceManager: VoxelSmoothSurfaceManager): { vertices: Float32Array; indices: Uint32Array } | null
function calculateVisualMeshSmoothOffset(vertexVx: number, vertexVz: number, boxCenterVx: number, boxCenterVz: number, boxTopY: number, blockType: BlockID, voxelSize: number, smoothSurfaceManager: VoxelSmoothSurfaceManager): number
function debugSplineInterpolation(voxelX: number, voxelZ: number, blockType: BlockID, smoothSurfaceManager: VoxelSmoothSurfaceManager): void

## engine/VoxelSurfaceFinish.ts
type VoxelSurfaceFinish = 'matte' | 'paint'
const DEFAULT_SURFACE_FINISH: VoxelSurfaceFinish
const DEFAULT_SHADING_SMOOTHNESS = 0
const DEFAULT_SHADING_SMOOTH_RADIUS_VOXELS = 2.5
interface VoxelPaintParams — Tunables for the 'paint' finish.
VoxelPaintParams.metalness: number
VoxelPaintParams.roughness: number
VoxelPaintParams.clearcoat: number
VoxelPaintParams.clearcoatRoughness: number
VoxelPaintParams.envMapIntensity: number
VoxelPaintParams.glossModel: 'direct' | 'environment'
VoxelPaintParams.directShininess: number
VoxelPaintParams.directSpecular: number
VoxelPaintParams.albedoScale: number
const DEFAULT_PAINT_PARAMS: VoxelPaintParams
const VEHICLE_PAINT_SMOOTHNESS = 0.75
function resolveVehicleFinish(mode: VehicleFinishMode | undefined): VoxelFinishOptions | null
interface ShadingNormalOptions
ShadingNormalOptions.positions: ArrayLike<number>
ShadingNormalOptions.normals: number[] | Float32Array
ShadingNormalOptions.indices: ArrayLike<number>
ShadingNormalOptions.radius: number
ShadingNormalOptions.strength: number
ShadingNormalOptions.writeMask?: Uint8Array | null
function smoothShadingNormals(options: ShadingNormalOptions): boolean
const VOXEL_SHADING_SMOOTHED = 'voxelShadingSmoothed'
function stampShadingSmoothed(geometry: THREE.BufferGeometry, strength: number, radiusVoxels: number): void
function shadingSmoothedStamp(geometry: THREE.BufferGeometry): { strength: number; radiusVoxels: number } | null
interface VoxelFinishOptions — Caller-facing finish settings; every field optional, defaults = stock look.
VoxelFinishOptions.surface?: VoxelSurfaceFinish
VoxelFinishOptions.smoothness?: number
VoxelFinishOptions.smoothRadiusVoxels?: number
VoxelFinishOptions.paint?: Partial<VoxelPaintParams>
interface VoxelFinishSettings — Fully resolved settings; what `VoxelObject` stores.
VoxelFinishSettings.surface: VoxelSurfaceFinish
VoxelFinishSettings.smoothness: number
VoxelFinishSettings.smoothRadiusVoxels: number
VoxelFinishSettings.paint: VoxelPaintParams
function resolveVoxelFinishSettings(options: VoxelFinishOptions = {}): VoxelFinishSettings
interface VoxelFinishBuildOptions
VoxelFinishBuildOptions.positions: ArrayLike<number>
VoxelFinishBuildOptions.normals: number[] | Float32Array
VoxelFinishBuildOptions.indices: ArrayLike<number>
VoxelFinishBuildOptions.voxelSize: number
VoxelFinishBuildOptions.settings: VoxelFinishSettings
VoxelFinishBuildOptions.map: THREE.Texture | null
function buildVoxelFinishMaterial(options: VoxelFinishBuildOptions): THREE.Material
function applyVoxelFinishToMesh(mesh: THREE.Mesh, settings: VoxelFinishSettings, voxelSize: number): void

## engine/VoxelTextureAtlas.ts
const BlockType = { /** Empty or road block type */ NONE: 0, /** Special block
type BlockTypeId = typeof BlockType[keyof typeof BlockType]
const CUSTOM_BLOCK_ID_BASE = 128
interface BlockTypeProperties — Voxel-specific rendering properties for a block type.
BlockTypeProperties.smoothSurface: boolean
BlockTypeProperties.smoothRadius: number
BlockTypeProperties.voxelRoundingRadiusVoxels?: number
BlockTypeProperties.isFluid: boolean
BlockTypeProperties.opacity: number
const DEFAULT_BLOCK_PROPERTIES: BlockTypeProperties
interface BlockTextureDef — Block texture definition.
BlockTextureDef.id: number
BlockTextureDef.name: string
BlockTextureDef.size: number
BlockTextureDef.top: HTMLCanvasElement | string
BlockTextureDef.side?: HTMLCanvasElement | string
BlockTextureDef.bottom?: HTMLCanvasElement | string
BlockTextureDef.properties?: Partial<BlockTypeProperties>
BlockTextureDef.materialId?: number
interface AtlasUV — UV coordinates for a texture in the atlas.
AtlasUV.u0: number
AtlasUV.v0: number
AtlasUV.u1: number
AtlasUV.v1: number
interface PackedBlockTexture — Packed block texture info with UV coordinates for each face.
PackedBlockTexture.id: number
PackedBlockTexture.name: string
PackedBlockTexture.top: AtlasUV
PackedBlockTexture.side: AtlasUV
PackedBlockTexture.bottom: AtlasUV
class VoxelTextureAtlas — Voxel Texture Atlas - packs multiple block textures into a single 4096x4096 atlas.
VoxelTextureAtlas.constructor()
VoxelTextureAtlas.initializeAtlas(): void
VoxelTextureAtlas.registerBlockTexture(def: BlockTextureDef): void
VoxelTextureAtlas.getNextBlockId(): number
VoxelTextureAtlas.getNextCustomBlockId(): number
VoxelTextureAtlas.registerBlockName(name: string, blockId: number): void
VoxelTextureAtlas.getBlockIdByName(name: string): number | undefined
VoxelTextureAtlas.getBlockTypeNames(): string[]
VoxelTextureAtlas.setFaceStyle(style: VoxelFaceStyle): void
VoxelTextureAtlas.getBlockUV(blockId: number, face: 'top' | 'side' | 'bottom'): AtlasUV
VoxelTextureAtlas.getRegisteredBlockTypes(): { id: number; name: string }[]
VoxelTextureAtlas.hasBlockType(blockId: number): boolean
VoxelTextureAtlas.getBlockTypeByName(name: string): number | undefined
VoxelTextureAtlas.getBlockProperties(blockId: number): BlockTypeProperties
VoxelTextureAtlas.setBlockProperties(blockId: number, properties: Partial<BlockTypeProperties>): void
VoxelTextureAtlas.setBlockTerrainType(blockId: number, terrainTypeId: number, grip?: number): void
VoxelTextureAtlas.getBlockTerrainType(blockId: number): number | undefined
VoxelTextureAtlas.setBlockMaterial(blockId: number, materialId: number): void
VoxelTextureAtlas.getBlockMaterial(blockId: number): number | undefined
VoxelTextureAtlas.setBlockGrip(blockId: number, grip: number): void
VoxelTextureAtlas.getBlockGrip(blockId: number): number
VoxelTextureAtlas.getAllBlockTypesWithProperties(): Array<{ id: number; name: string; properties: BlockTypeProperties }>
VoxelTextureAtlas.hasSmoothSurface(blockId: number): boolean
VoxelTextureAtlas.getSmoothRadius(blockId: number): number
VoxelTextureAtlas.getVoxelRoundingRadiusVoxels(blockId: number): number | undefined
VoxelTextureAtlas.hasAnyBlockWithRounding(): boolean
VoxelTextureAtlas.isFluidBlock(blockId: number): boolean
VoxelTextureAtlas.getBlockOpacity(blockId: number): number
VoxelTextureAtlas.getColorPaletteUV(r: number, g: number, b: number): AtlasUV
VoxelTextureAtlas.quantizeToColorPalette(color: number): number
VoxelTextureAtlas.getTexture(): THREE.CanvasTexture
VoxelTextureAtlas.createMaterial(): THREE.MeshLambertMaterial
VoxelTextureAtlas.loadTextureFromUrl(url: string, targetSize: number): Promise<HTMLCanvasElement>
VoxelTextureAtlas.registerBlockTextureFromUrl(def: { name: string; textureUrl: string; sideTextureUrl?: string | null; textureSize: number; properties?: Partial<BlockTypeProperties>; }): Promise<number>
VoxelTextureAtlas.generateGrassTexture(size: number): HTMLCanvasElement
VoxelTextureAtlas.generateGrassSideTexture(size: number): HTMLCanvasElement
VoxelTextureAtlas.generateDirtTexture(size: number): HTMLCanvasElement
VoxelTextureAtlas.generateSandTexture(size: number): HTMLCanvasElement
VoxelTextureAtlas.generateStoneTexture(size: number, r: number, g: number, b: number): HTMLCanvasElement
VoxelTextureAtlas.generateAsphaltTexture(size: number): HTMLCanvasElement
VoxelTextureAtlas.generateIceTexture(size: number): HTMLCanvasElement
VoxelTextureAtlas.generateLavaTexture(size: number): HTMLCanvasElement
VoxelTextureAtlas.generateWaterTexture(size: number, _opacity: number = 0.6): HTMLCanvasElement
VoxelTextureAtlas.generateSlimeTexture(size: number, _opacity: number = 0.7): HTMLCanvasElement
VoxelTextureAtlas.generateQuicksandTexture(size: number, _opacity: number = 0.85): HTMLCanvasElement
VoxelTextureAtlas.generateTrunkSideTexture(size: number): HTMLCanvasElement
VoxelTextureAtlas.generateTrunkTopTexture(size: number): HTMLCanvasElement
VoxelTextureAtlas.generateLeavesTexture(size: number): HTMLCanvasElement
VoxelTextureAtlas.generatePlanksTexture(size: number): HTMLCanvasElement
VoxelTextureAtlas.dispose(): void
type VoxelFaceStyle = 'textured' | 'flat'
function flattenFaceCanvas(source: HTMLCanvasElement): HTMLCanvasElement
function getVoxelTextureAtlas(): VoxelTextureAtlas
function resetVoxelTextureAtlas(): void
function createGrassBlockType(atlas: VoxelTextureAtlas, terrainTypeId?: number): number
function createSandBlockType(atlas: VoxelTextureAtlas, terrainTypeId?: number): number
function createIceBlockType(atlas: VoxelTextureAtlas, terrainTypeId?: number): number
function createStoneBlockType(atlas: VoxelTextureAtlas, terrainTypeId?: number): number
function createDirtBlockType(atlas: VoxelTextureAtlas, terrainTypeId?: number): number
function createAsphaltBlockType(atlas: VoxelTextureAtlas, terrainTypeId?: number): number
function createLavaBlockType(atlas: VoxelTextureAtlas, terrainTypeId?: number, isFluid: boolean = false, opacity: number = 0.9): number
function createWaterBlockType(atlas: VoxelTextureAtlas, terrainTypeId?: number, opacity: number = 0.6): number
function createSlimeBlockType(atlas: VoxelTextureAtlas, terrainTypeId?: number, opacity: number = 0.7): number
function createQuicksandBlockType(atlas: VoxelTextureAtlas, terrainTypeId?: number, opacity: number = 0.85): number
function createTrunkBlockType(atlas: VoxelTextureAtlas, materialId?: number): number
function createLeavesBlockType(atlas: VoxelTextureAtlas, materialId?: number): number
function createPlanksBlockType(atlas: VoxelTextureAtlas, materialId?: number): number
function createLazyBlockType(name: string, textureFactory: (atlas: VoxelTextureAtlas) => { size: number; top: HTMLCanvasElement; side?: HTMLCanvasElement; bottom?: HTMLCanvasElement }, terrainTypeId?: number): () => number

## engine/VoxelUniformFlatInstancing.ts
interface UniformFlatInstancingDeps — Builds and manages the per-block-type InstancedMesh registry for uniformly-flat
UniformFlatInstancingDeps.columnTopIndex: VoxelColumnTopIndex
UniformFlatInstancingDeps.bounds: { minX: number; minY: number; minZ: number } | null
UniformFlatInstancingDeps.voxelSize: number
UniformFlatInstancingDeps.parentGroup: THREE.Object3D
UniformFlatInstancingDeps.material: THREE.Material
interface UniformFlatInstancingState
UniformFlatInstancingState.chunksCoveredByInstance: Set<ChunkKey>
UniformFlatInstancingState.chunkInstanceSlot: Map<ChunkKey, { mesh: THREE.InstancedMesh; index: number }>
UniformFlatInstancingState.instanceMeshesByBlock: Map<BlockID, THREE.InstancedMesh>
UniformFlatInstancingState.totalInstances: number
function createEmptyInstancingState(): UniformFlatInstancingState
function buildUniformFlatInstancedMeshes(deps: UniformFlatInstancingDeps): UniformFlatInstancingState
function evictChunkFromInstance(state: UniformFlatInstancingState, chunkKey: ChunkKey): boolean
function disposeInstancingState(state: UniformFlatInstancingState, parentGroup: THREE.Object3D): void
