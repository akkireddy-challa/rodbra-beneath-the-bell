# engine-api-voxel-2

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/VxlChunkedTerrainSystem.ts
interface VxlChunkedTerrainConfig
VxlChunkedTerrainConfig.lodDistances: number[]
VxlChunkedTerrainConfig.maxRenderDistance: number | null
VxlChunkedTerrainConfig.shadows: boolean
const DEFAULT_VXL_CHUNKED_TERRAIN_CONFIG: VxlChunkedTerrainConfig
class VxlChunkedTerrainSystem — Replaces (or runs alongside) `VoxelTerrainSystem` for baked-VXL levels.
VxlChunkedTerrainSystem.constructor(engine: EngineLike, config: VxlChunkedTerrainConfig)
VxlChunkedTerrainSystem.loadVxlWorld(vwldBuffer: ArrayBuffer): Promise<void>
VxlChunkedTerrainSystem.updateVisibility(camera: THREE.Camera, _playerPosition?: THREE.Vector3): void
VxlChunkedTerrainSystem.update(_deltaTime: number): void
VxlChunkedTerrainSystem.getHeightAt(x: number, z: number): number
VxlChunkedTerrainSystem.getVoxelHeightAt(x: number, z: number): number
VxlChunkedTerrainSystem.getVoxelTerrainHeight(x: number, z: number): number
VxlChunkedTerrainSystem.getActualVoxelSurfaceHeight(x: number, z: number): number
VxlChunkedTerrainSystem.getVoxelChunkGroup(): THREE.Group
VxlChunkedTerrainSystem.areCollidersReady(): boolean
VxlChunkedTerrainSystem.getChunkSize(): number
VxlChunkedTerrainSystem.getBlockSize(): number
VxlChunkedTerrainSystem.getChunkCount(): number
VxlChunkedTerrainSystem.setLodDistances(distances: number[]): void
VxlChunkedTerrainSystem.getBounds(): VxlWorldBounds | null
VxlChunkedTerrainSystem.getVoxelChunkData(): Array<{ chunkX: number; chunkZ: number; worldMinX: number; worldMaxX: number; worldMinZ: number; worldMaxZ: number; mesh: THREE.Mesh | null; physicsBody: import('@dimforge/rapier3d-compat').RigidBody | null; }>
VxlChunkedTerrainSystem.setCullingEnabled(enabled: boolean): void
VxlChunkedTerrainSystem.isCullingEnabled(): boolean
VxlChunkedTerrainSystem.setMaxRenderDistance(distance: number | null): void
VxlChunkedTerrainSystem.getMaxRenderDistance(): number | null
VxlChunkedTerrainSystem.setRenderRegion(region: THREE.Box3 | null): void
VxlChunkedTerrainSystem.dispose(): void
type VxlChunkedTerrainChunkBounds = VoxelObjectBounds

## engine/VxlSceneTerrainSystem.ts
interface VxlSceneLoadBudget — Render-buffer limits for one platform tier.
VxlSceneLoadBudget.minQuadCellSizeM: number | null
VxlSceneLoadBudget.totalBudgetBytes: number | null
VxlSceneLoadBudget.surfaceBudgetBytes: number
VxlSceneLoadBudget.dropTerrainBandsAtOrAboveOffset: number | null
const VXL_SCENE_LOAD_BUDGET_FULL: VxlSceneLoadBudget
const VXL_SCENE_LOAD_BUDGET_CONSTRAINED: VxlSceneLoadBudget
interface VxlSceneLoadPlan — A render-load plan: how many finest LOD levels to drop, the finest effective
VxlSceneLoadPlan.skipLodLevels: number
VxlSceneLoadPlan.skipEffectiveSteps: number
VxlSceneLoadPlan.surfaceStep: number
function estimateQuadRenderBytes(world: DecodedVxlSceneWorld, skipSteps: number): number
function planVxlSceneLoad(world: DecodedVxlSceneWorld, budget: VxlSceneLoadBudget, extraSkipSteps = 0): VxlSceneLoadPlan
function readTerrainBudgetOverride(): number | null | undefined
function readSurfaceBudgetOverride(): number | undefined
function readTerrainBandOverride(): number | null | undefined
function applyLodOffsetDrop(world: DecodedVxlSceneWorld, minOffset: number): number
function applyLodSkip(world: DecodedVxlSceneWorld, skip: number): void
function applyEffectiveStepSkip(world: DecodedVxlSceneWorld, skipSteps: number): void
function upFacingQuads(chunk: DecodedChunk): DecodedChunkQuads | null
function releaseDecodedColumns(world: DecodedVxlSceneWorld, keepGroundQuads: boolean): number
function finestKeptQuads(chunk: DecodedChunk): DecodedChunkQuads | null
function collectTrimeshNames(world: DecodedVxlSceneWorld): string[]
function mergeNamedTrimesh(world: DecodedVxlSceneWorld, name: string): { vertices: Float32Array; indices: Uint32Array } | null
interface VxlSceneTerrainConfig — Config for the VxlScene runtime. Mirrors `VxlChunkedTerrainConfig` so the
VxlSceneTerrainConfig.lodDistances: number[]
VxlSceneTerrainConfig.maxRenderDistance: number | null
VxlSceneTerrainConfig.shadows: boolean
VxlSceneTerrainConfig.keepDecodedColumns?: boolean
const GROUND_TYPE_MATCH_TOLERANCE_M = 2.0
const DEFAULT_VXL_SCENE_TERRAIN_CONFIG: VxlSceneTerrainConfig
interface VxlSceneLoadOptions
VxlSceneLoadOptions.buildRenderer?: boolean
VxlSceneLoadOptions.releaseSourceBuffer?: boolean
class VxlSceneTerrainSystem — Replaces (or runs alongside) `VoxelTerrainSystem` for baked VxlScene levels.
VxlSceneTerrainSystem.constructor(engine: EngineLike, config: VxlSceneTerrainConfig)
static VxlSceneTerrainSystem.isVxlScene(buf: ArrayBuffer): boolean
VxlSceneTerrainSystem.loadVxlScene(vwldBuffer: ArrayBuffer, options: VxlSceneLoadOptions = {}): Promise<void>
VxlSceneTerrainSystem.updateVisibility(camera: THREE.Camera, _playerPosition?: THREE.Vector3): void
VxlSceneTerrainSystem.update(_deltaTime: number): void
VxlSceneTerrainSystem.getHeightAt(x: number, z: number): number
VxlSceneTerrainSystem.getBakedSurfaceHeightAt(x: number, z: number): number
VxlSceneTerrainSystem.getVoxelHeightAt(x: number, z: number): number
VxlSceneTerrainSystem.getVoxelTerrainHeight(x: number, z: number): number
VxlSceneTerrainSystem.getActualVoxelSurfaceHeight(x: number, z: number): number
VxlSceneTerrainSystem.getVoxelChunkGroup(): THREE.Group
VxlSceneTerrainSystem.areCollidersReady(): boolean
VxlSceneTerrainSystem.getReducedLodLevels(): number
VxlSceneTerrainSystem.getChunkSize(): number
VxlSceneTerrainSystem.getBlockSize(): number
VxlSceneTerrainSystem.getChunkCount(): number
VxlSceneTerrainSystem.getColliderCounts(): { named: number; quad: number; total: number }
VxlSceneTerrainSystem.setCullingEnabled(enabled: boolean): void
VxlSceneTerrainSystem.isCullingEnabled(): boolean
VxlSceneTerrainSystem.setLodDistances(distances: number[]): void
VxlSceneTerrainSystem.getLodDistances(): number[]
VxlSceneTerrainSystem.setMaxRenderDistance(distance: number | null): void
VxlSceneTerrainSystem.getMaxRenderDistance(): number | null
VxlSceneTerrainSystem.setRenderRegion(region: THREE.Box3 | null): void
VxlSceneTerrainSystem.getBounds(): DecodedVxlSceneWorld['bounds'] | null
VxlSceneTerrainSystem.getWorldGeneration(): number
VxlSceneTerrainSystem.getGroundTypeAt(x: number, y: number, z: number, tolerance = GROUND_TYPE_MATCH_TOLERANCE_M): number
VxlSceneTerrainSystem.getGroundMaskCellSize(): number
VxlSceneTerrainSystem.getGroundMask(): Readonly<GroundMaskData> | null
VxlSceneTerrainSystem.setGroundTypeInRadius(x: number, z: number, radius: number, type: number, onlyReplacing?: number): number
VxlSceneTerrainSystem.setGroundTypeInRect(minX: number, minZ: number, maxX: number, maxZ: number, type: number, onlyReplacing?: number): number
VxlSceneTerrainSystem.getTrimeshNames(): string[]
VxlSceneTerrainSystem.setBatchCulling(enabled: boolean): void
VxlSceneTerrainSystem.getTrimesh(name: string): { vertices: Float32Array; indices: Uint32Array } | null
VxlSceneTerrainSystem.getTrackCenterline(name: string, options?: Partial<TrackCenterlineOptions>): CenterlinePoint[]
VxlSceneTerrainSystem.dispose(): void

## engine/VxlV3Eyes.ts
const VXL3_SECTION_EYES = 1 << 3
const EYE_SECTION_BYTES = 19
type EyeType = 'classic' | 'dark'
interface EyeMeta
EyeMeta.type: EyeType
EyeMeta.w: number
EyeMeta.h: number
EyeMeta.centreX: number
EyeMeta.y: number
EyeMeta.z: number
EyeMeta.halfGap: number
function writeEyeSection(view: DataView, cursor: number, eyes: EyeMeta): number
function readEyeSection(view: DataView, cursor: number): { eyes: EyeMeta; cursor: number }

## engine/VxlV3Format.ts
function colorToCell(r: number, g: number, b: number, useAtlas: boolean): number
const VXL3_MAGIC = 0x33_4c_58_56
const VXL3_VERSION = 3
const VXL3_VERSION_WITH_LODS = 4
const VXL3_VERSION_COLUMNAR = 5
const VXL3_VERSION_EMISSIVE = 6
const VXL3_VERSION_SLOTS = 7
const VXL3_VERSION_LOD_MATERIALS = 8
const VXL3_VERSION_BLOCK_TYPES = 9
const VXL3_VERSION_RIG = 10
const VXL3_VERSION_MATERIAL_CLASS = 11
const VXL3_VERSION_PARTS = 12
const VXL3_COMPRESSION_NONE = 0
const VXL3_COMPRESSION_GZIP = 1
const VXL3_MIN_FILE_SIZE = 5 + 48
interface VxlV3Bounds
VxlV3Bounds.minX: number
VxlV3Bounds.minY: number
VxlV3Bounds.minZ: number
VxlV3Bounds.maxX: number
VxlV3Bounds.maxY: number
VxlV3Bounds.maxZ: number
interface VxlV3Fragment — One fragment in the file. `leaves` are in object-local world units (same
VxlV3Fragment.aabbMin: [number, number, number]
VxlV3Fragment.aabbMax: [number, number, number]
VxlV3Fragment.leaves: OctreeLeaf[]
interface VxlV3LodLevel — One coarser LOD level. Shares bounds + useAtlas with LOD 0; carries
VxlV3LodLevel.minVoxelSize: number
VxlV3LodLevel.maxVoxelSize: number
VxlV3LodLevel.fragments: VxlV3Fragment[]
interface VxlV3Data
VxlV3Data.minVoxelSize: number
VxlV3Data.maxVoxelSize: number
VxlV3Data.physicsGridStep: number
VxlV3Data.bounds: VxlV3Bounds
VxlV3Data.useAtlas: boolean
VxlV3Data.fragments: VxlV3Fragment[]
VxlV3Data.additionalLods?: VxlV3LodLevel[]
VxlV3Data.slots?: VoxelSlot[]
VxlV3Data.rig?: VxlV3RigInput
VxlV3Data.eyes?: EyeMeta
VxlV3Data.parts?: VxlV3Part[]
interface VxlV3RigInput — Rig as handed to the ENCODER. The per-leaf bone column is not passed here — it
VxlV3RigInput.skeletonRef: string
VxlV3RigInput.bindPositions: Float32Array
VxlV3RigInput.fillers: VxlV3Rig['fillers']
VxlV3RigInput.sockets: VxlV3Rig['sockets']
interface DecodedFragment
DecodedFragment.aabbMin: [number, number, number]
DecodedFragment.aabbMax: [number, number, number]
DecodedFragment.leaves: LeafBuffer
interface DecodedLodLevel
DecodedLodLevel.minVoxelSize: number
DecodedLodLevel.maxVoxelSize: number
DecodedLodLevel.fragments: DecodedFragment[]
interface DecodedVxlV3
DecodedVxlV3.minVoxelSize: number
DecodedVxlV3.maxVoxelSize: number
DecodedVxlV3.physicsGridStep: number
DecodedVxlV3.bounds: VxlV3Bounds
DecodedVxlV3.useAtlas: boolean
DecodedVxlV3.fragments: DecodedFragment[]
DecodedVxlV3.additionalLods?: DecodedLodLevel[]
DecodedVxlV3.paletteEmissive?: Uint8Array
DecodedVxlV3.slots?: VoxelSlot[]
DecodedVxlV3.eyes?: EyeMeta
DecodedVxlV3.rig?: VxlV3Rig
DecodedVxlV3.parts?: VxlV3Part[]
interface EncodeVxlV3Options
EncodeVxlV3Options.compression?: 'gzip' | 'none'
function isVxlV3(buffer: ArrayBuffer): boolean
function encodeVxlV3(data: VxlV3Data, options: EncodeVxlV3Options = {}): Promise<Uint8Array>
function decodeVxlV3(buffer: ArrayBuffer): Promise<DecodedVxlV3>

## engine/VxlV3MaterialClass.ts
const VXL3_SECTION_LEGACY_EMISSIVE = 1 << 0
const VXL3_SECTION_RIG = 1 << 1
const VXL3_SECTION_MATERIAL_CLASS = 1 << 2
function materialClassNames(slots: readonly VoxelSlot[]): string[]
function hasMaterialClasses(slots: readonly VoxelSlot[]): boolean
function materialClassSectionBytes(names: readonly string[]): number
function writeMaterialClassSection(bytes: Uint8Array, cursorIn: number, names: readonly string[]): number
function readMaterialClassSection(bytes: Uint8Array, cursorIn: number, slotCount: number): { names: string[]; cursor: number }
function applyMaterialClassNames(slots: VoxelSlot[], names: readonly string[]): void

## engine/VxlV3Parts.ts
const VXL3_SECTION_PARTS = 1 << 4
const PARTS_SKELETON_REF = 'parts-v1'
const VOXEL_PART_NAME_MAX = 32
const VOXEL_MAX_PARTS = 254
const MOTION_KIND_NONE = 0
const MOTION_KIND_SPIN = 1
const MOTION_KIND_UPRIGHT = 2
const MOTION_KIND_PENDULUM = 3
type VxlV3PartMotion = | { kind: 'spin'; axis: [number, number, number]; rpm: number } /** Hangs from a hinge on its parent and stays level while the parent turns. */ | { kind: 'upright' } | { kind: 'pendulum'; axis: [number, number, number]; amplitudeDeg: number; periodS: number } | { kind: 'none' }
interface VxlV3Part — One part, as stored. The pivot is NOT here — it is the rig's bind position for joint `index + 1`.
VxlV3Part.name: string
VxlV3Part.parentJoint: number
VxlV3Part.motion: VxlV3PartMotion
function partsSectionBytes(parts: readonly VxlV3Part[]): number
function writePartsSection(view: DataView, bytes: Uint8Array, cursorIn: number, parts: readonly VxlV3Part[]): number
interface ReadPartsResult
ReadPartsResult.parts: VxlV3Part[]
ReadPartsResult.cursor: number
function readPartsSection(view: DataView, bytes: Uint8Array, cursorIn: number): ReadPartsResult
function partsSkeleton(parts: readonly VxlV3Part[]): VoxelSkeletonRef
function validateParts(parts: readonly VxlV3Part[], jointCount: number): string | null

## engine/VxlV3Rig.ts
const VOXEL_SKELETON_REF_MAX = 32
const VOXEL_SOCKET_NAME_MAX = 32
const VOXEL_MAX_JOINTS = 255
interface VxlV3Socket — A named attachment point on the rig.
VxlV3Socket.name: string
VxlV3Socket.joint: number
VxlV3Socket.offset: [number, number, number]
interface VxlV3Fillers — One joint-filler cube: grid coords in LOD 0's `minVoxelSize`, relative to
VxlV3Fillers.count: number
VxlV3Fillers.gx: Uint16Array
VxlV3Fillers.gy: Uint16Array
VxlV3Fillers.gz: Uint16Array
VxlV3Fillers.bone: Uint8Array
VxlV3Fillers.color: Uint16Array
interface VxlV3Rig — The decoded rig. Absent from `DecodedVxlV3` entirely when the file has no rig.
VxlV3Rig.skeletonRef: string
VxlV3Rig.bindPositions: Float32Array
VxlV3Rig.bones: Uint8Array
VxlV3Rig.lodBones: Uint8Array[]
VxlV3Rig.fillers: VxlV3Fillers
VxlV3Rig.sockets: VxlV3Socket[]
function rigToEncodeInput(rig: VxlV3Rig): Omit<VxlV3Rig, 'bones' | 'lodBones'>
interface VoxelSkeletonRef — A shared skeleton, referenced by name from the file.
VoxelSkeletonRef.joints: readonly string[]
VoxelSkeletonRef.parents: readonly number[]
VoxelSkeletonRef.rotations: Float32Array
const SKELETON_REFS: Readonly<Record<string, VoxelSkeletonRef>>
function resolveSkeletonRef(ref: string): VoxelSkeletonRef | null
function skeletonJointCount(ref: string): number
function rigSectionBytes(rig: VxlV3Rig, lod0LeafCount: number, lodLeafCounts: readonly number[]): number
function writeRigSection(view: DataView, bytes: Uint8Array, cursorIn: number, rig: VxlV3Rig, lod0Bones: Uint8Array, lodBones: readonly Uint8Array[]): number
interface ReadRigResult
ReadRigResult.rig: VxlV3Rig
ReadRigResult.cursor: number
function readRigSection(view: DataView, bytes: Uint8Array, cursorIn: number, lod0LeafCount: number, lodLeafCounts: readonly number[]): ReadRigResult

## engine/VxlWorldFormat.ts
const VWLD_MAGIC = 0x44_4c_57_56
const VWLD_VERSION = 1
const VWLD_VERSION_WITH_TRIMESH = 2
const TMSH_MAGIC = 0x48_53_4d_54
const VWLD_COMPRESSION_NONE = 0
const VWLD_COMPRESSION_GZIP = 1
const VWLD_MIN_FILE_SIZE = 5 + BODY_HEADER_SIZE + CHUNK_COUNT_SIZE
interface VxlWorldBounds
VxlWorldBounds.minX: number
VxlWorldBounds.minY: number
VxlWorldBounds.minZ: number
VxlWorldBounds.maxX: number
VxlWorldBounds.maxY: number
VxlWorldBounds.maxZ: number
interface VxlWorldChunk — One chunk in the file. `vxlBytes` is the *standalone* VXL3 blob (starts
VxlWorldChunk.sx: number
VxlWorldChunk.sy: number
VxlWorldChunk.sz: number
VxlWorldChunk.vxlBytes: Uint8Array
VxlWorldChunk.tcolBytes?: Uint8Array
interface VxlWorldData
VxlWorldData.chunkSize: number
VxlWorldData.bounds: VxlWorldBounds
VxlWorldData.chunks: VxlWorldChunk[]
interface EncodeVxlWorldOptions
EncodeVxlWorldOptions.compression?: 'gzip' | 'none'
function isVxlWorld(buffer: ArrayBuffer): boolean
function encodeVxlWorld(data: VxlWorldData, options: EncodeVxlWorldOptions = {}): Promise<Uint8Array>
function decodeVxlWorld(buffer: ArrayBuffer): Promise<VxlWorldData>
interface ChunkTrimeshData — Decoded trimesh-collider payload. Positions are in CHUNK-LOCAL world
ChunkTrimeshData.vertices: Float32Array
ChunkTrimeshData.indices: Uint32Array
function encodeTrimeshBlob(vertices: Float32Array, indices: Uint32Array, chunkSize: number): Uint8Array
function decodeTrimeshBlob(bytes: Uint8Array, chunkSize: number): ChunkTrimeshData
function decodeChunkVxl(chunk: VxlWorldChunk): Promise<DecodedVxlV3>

## engine/VxlWorldVoxelizer.ts
interface PathCullOptions — Path-cull request as it arrives from the caller — the `PathCullSpec` the mask
PathCullOptions.pointSpace?: { levelSizeX: number; levelSizeZ: number; levelSizeY?: number; chunkSize: number; }
interface VxlWorldVoxelizeOptions
VxlWorldVoxelizeOptions.levelSizeX: number
VxlWorldVoxelizeOptions.levelSizeZ: number
VxlWorldVoxelizeOptions.levelSizeY?: number
VxlWorldVoxelizeOptions.chunkSize?: number
VxlWorldVoxelizeOptions.minVoxelSize: number
VxlWorldVoxelizeOptions.maxVoxelSize: number
VxlWorldVoxelizeOptions.additionalLods?: Array<{ minVoxelSize: number; maxVoxelSize: number; distance?: number }>
VxlWorldVoxelizeOptions.fillInterior?: boolean
VxlWorldVoxelizeOptions.useSRGB?: boolean
VxlWorldVoxelizeOptions.objectLodOffsets?: Record<string, number>
VxlWorldVoxelizeOptions.objectLodPins?: Record<string, true>
VxlWorldVoxelizeOptions.objectTrimeshColliders?: Record<string, true>
VxlWorldVoxelizeOptions.objectNoColliders?: Record<string, true>
VxlWorldVoxelizeOptions.objectCollisionOnlyNodes?: Record<string, true>
VxlWorldVoxelizeOptions.objectDisplacementAxes?: Record<string, 'x' | 'y' | 'z'>
VxlWorldVoxelizeOptions.objectAssetInstances?: Record<string, true>
VxlWorldVoxelizeOptions.objectGroundTypes?: Record<string, string>
VxlWorldVoxelizeOptions.emissiveByColor?: Record<string, number>
VxlWorldVoxelizeOptions.materialByColor?: Record<string, string>
VxlWorldVoxelizeOptions.pathCull?: PathCullOptions
VxlWorldVoxelizeOptions.onProgress?: (info: { chunkIndex: number; totalChunks: number; nonEmptyChunks: number; label: string }) => void
VxlWorldVoxelizeOptions.profile?: BakeOptions['profile']
interface VxlWorldVoxelizeResult
VxlWorldVoxelizeResult.vwldBytes: Uint8Array
VxlWorldVoxelizeResult.lodVariants: Array<{ drop: number; bytes: Uint8Array }>
VxlWorldVoxelizeResult.worldBounds: VxlWorldBounds
VxlWorldVoxelizeResult.chunkSize: number
VxlWorldVoxelizeResult.nonEmptyChunkCount: number
VxlWorldVoxelizeResult.totalLod0Leaves: number
VxlWorldVoxelizeResult.totalTrimeshTriangles: number
VxlWorldVoxelizeResult.totalTrimeshBytes: number
VxlWorldVoxelizeResult.perObjectVoxelCounts: Record<string, number>
VxlWorldVoxelizeResult.emissiveUnmatched: string[]
VxlWorldVoxelizeResult.materialUnmatched: string[]
VxlWorldVoxelizeResult.materialNotes: string[]
VxlWorldVoxelizeResult.warning?: string
function buildControlsByNode(options: VxlWorldVoxelizeOptions): Record<string, ObjectControls>
function dropAssetInstanceTriangles(triangles: RasterTriangle[], bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }, objectAssetInstances: Record<string, true> | undefined): { triangles: RasterTriangle[]; bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }; }
function bakeVisibleGroundMask(triangles: readonly RasterTriangle[], typeByNode: Record<string, number>, bounds: VxlWorldBounds, objectCollisionOnlyNodes: Record<string, true> | undefined): GroundMaskData | null
interface LevelSizeTransform — The affine that maps SOURCE (GLB) space into the baked level's world space,
LevelSizeTransform.scaleXZ: number
LevelSizeTransform.scaleY: number
LevelSizeTransform.translateX: number
LevelSizeTransform.translateY: number
LevelSizeTransform.translateZ: number
LevelSizeTransform.bounds: VxlWorldBounds
function computeLevelSizeTransform(srcBounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }, levelSizeX: number, levelSizeZ: number, levelSizeY: number | undefined, chunkSize: number): LevelSizeTransform
function remapPathPoints(points: readonly PathCullPoint[], from: LevelSizeTransform, to: LevelSizeTransform): PathCullPoint[]
function cullGroundMask(mask: GroundMaskData, bounds: VxlWorldBounds, cull: PathCullMask): void
function collectChunkCells(chunk: VxlSceneChunk, into: Map<number, number>): void
function voxelizeGLBToVxlWorld(glbBuffer: ArrayBuffer, options: VxlWorldVoxelizeOptions): Promise<VxlWorldVoxelizeResult>
