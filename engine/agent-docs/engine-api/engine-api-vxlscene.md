# engine-api-vxlscene

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/vxlscene/ColliderBaker.ts
interface AABB — Axis-aligned box in MIN-CELL units (integer grid coords).
AABB.minX: number
AABB.minY: number
AABB.minZ: number
AABB.maxX: number
AABB.maxY: number
AABB.maxZ: number
interface TrimeshBlob
TrimeshBlob.verts: Float32Array
TrimeshBlob.indices: Uint32Array
function quadsToTrimesh(quads: SceneQuad[], minVoxelSize: number, originX: number, originY: number, originZ: number): TrimeshBlob
function quadsToTrimeshSoA(quads: DecodedChunkQuads, minVoxelSize: number, originX: number, originY: number, originZ: number): TrimeshBlob
function quadsToShellCells(quads: DecodedChunkQuads): Int32Array
function orientTrimeshUpward(verts: Float32Array, indices: Uint32Array): Uint32Array
function greedyBoxes(voxels: SceneVoxel[]): AABB[]
function greedyBoxesSoA(voxels: DecodedChunkVoxels): AABB[]
function clipTrimeshToChunk(tris: Array<{ v0: [number, number, number]; v1: [number, number, number]; v2: [number, number, number]; }>, chunk: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }): TrimeshBlob

## engine/vxlscene/GlbSceneExtractor.ts
interface ExtractedScene
ExtractedScene.triangles: RasterTriangle[]
ExtractedScene.bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }
ExtractedScene.nodeNames: string[]
function extractGlbScene(glbBuffer: ArrayBuffer, opts?: { useSRGB?: boolean }): Promise<ExtractedScene>

## engine/vxlscene/GlobalInteriorField.ts
interface GlobalTriangle
GlobalTriangle.v0: [number, number, number]
GlobalTriangle.v1: [number, number, number]
GlobalTriangle.v2: [number, number, number]
interface GlobalInteriorBounds
GlobalInteriorBounds.minX: number
GlobalInteriorBounds.minY: number
GlobalInteriorBounds.minZ: number
GlobalInteriorBounds.maxX: number
GlobalInteriorBounds.maxY: number
GlobalInteriorBounds.maxZ: number
interface GlobalInteriorField
GlobalInteriorField.isInterior: (wx: number, wy: number, wz: number) => boolean
GlobalInteriorField.hasInterior: boolean
GlobalInteriorField.interiorAabbOverlaps: (minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number) => boolean
GlobalInteriorField.cellSize: number
GlobalInteriorField.nx: number
GlobalInteriorField.ny: number
GlobalInteriorField.nz: number
function buildGlobalInterior(tris: GlobalTriangle[], bounds: GlobalInteriorBounds, opts: { cellSize: number }): GlobalInteriorField
function fillInteriorFromField(grid: Map<number, CellAttr>, ctx: RasterCtx, field: GlobalInteriorField, opts?: { defaultColor?: RGB; maxSizeLevel?: number }): InteriorResult

## engine/vxlscene/GreedyMesher.ts
interface MeshCtx — Optional meshing context.
MeshCtx.isSolidExtra?: (gx: number, gy: number, gz: number) => boolean
function greedyMesh(grid: Map<number, CellAttr>, ctx?: MeshCtx): SceneQuad[]

## engine/vxlscene/GroundDetailSystem.ts
interface GroundDetailOptions
GroundDetailOptions.detailDistance: number
GroundDetailOptions.hysteresis: number
GroundDetailOptions.maxStonesPerChunk: number
GroundDetailOptions.maxCoverPerChunk: number
GroundDetailOptions.maxBuildsPerUpdate: number
GroundDetailOptions.matchTolerance: number
GroundDetailOptions.rebuildCooldownMs: number
GroundDetailOptions.density: number
GroundDetailOptions.scale: number
GroundDetailOptions.seed: number
GroundDetailOptions.appearance?: Partial<FoliageAppearance>
const DEFAULT_GROUND_DETAIL_OPTIONS: GroundDetailOptions
function coverBudgetForDensity(density: number, baseline = DEFAULT_GROUND_DETAIL_OPTIONS.maxCoverPerChunk): number
const DENSITY_BAND_BOUNDS: readonly number[]
const DENSITY_BAND_FACTORS: readonly number[]
const DENSITY_BAND_HYSTERESIS_M = 3
function densityBandForDistance(d: number): number
function groundDetailOptionsFor(config: { density?: number; scale?: number; distance?: number } | undefined, seed = DEFAULT_GROUND_DETAIL_OPTIONS.seed): GroundDetailOptions
function grassHeightScale(t: number): number
interface DetailInstance — One planned detail instance (pure data — unit-testable without THREE).
DetailInstance.kind: 'dome' | 'brick' | 'tuft' | 'flower' | 'pebble'
DetailInstance.x: number
DetailInstance.y: number
DetailInstance.z: number
DetailInstance.yaw: number
DetailInstance.scale: number
DetailInstance.r: number
DetailInstance.g: number
DetailInstance.b: number
DetailInstance.thin?: number
function maskDirectionYaw(mask: GroundMaskData, cx: number, cz: number): number
function collectColumnSurfaces(world: DecodedVxlSceneWorld, mask: GroundMaskData, colCx: number, colCz: number): Map<number, CellSurface>
function planColumnDetail(world: DecodedVxlSceneWorld, mask: GroundMaskData, colCx: number, colCz: number, opts: GroundDetailOptions): { instances: DetailInstance[]; stonesDropped: number; coverDropped: number }
class GroundDetailSystem
GroundDetailSystem.appearance: FoliageAppearance
GroundDetailSystem.constructor(world: DecodedVxlSceneWorld, parent: THREE.Object3D, opts: GroundDetailOptions)
GroundDetailSystem.updateDetail(cameraWorldPos: THREE.Vector3): void
GroundDetailSystem.invalidateRegion(minX: number, minZ: number, maxX: number, maxZ: number): number
GroundDetailSystem.dispose(): void

## engine/vxlscene/GroundMaskBaker.ts
const GROUND_MASK_CELL_M = 0.5
const GROUND_MASK_HEIGHT_STEP = 0.05
interface GroundMaskData
GroundMaskData.cellSize: number
GroundMaskData.width: number
GroundMaskData.height: number
GroundMaskData.types: Uint8Array
GroundMaskData.topY: Uint16Array
function groundMaskCellIndex(mask: GroundMaskData, x: number, z: number, minX: number, minZ: number): number
function groundTypeAtPoint(mask: GroundMaskData, minX: number, minZ: number, x: number, y: number, z: number, tolerance: number): number
interface GroundPaintResult — What a ground-type edit touched: cell count plus the world-space XZ box to refresh.
GroundPaintResult.changed: number
GroundPaintResult.minX: number
GroundPaintResult.minZ: number
GroundPaintResult.maxX: number
GroundPaintResult.maxZ: number
function paintGroundTypeInMask(mask: GroundMaskData, originX: number, originZ: number, box: { minX: number; minZ: number; maxX: number; maxZ: number }, type: number, onlyReplacing: number | undefined, inside: ((cellCenterX: number, cellCenterZ: number) => boolean) | null): GroundPaintResult
function bakeGroundMask(triangles: readonly RasterTriangle[], typeByNode: Record<string, number>, bounds: VxlWorldBounds, cellSize: number = GROUND_MASK_CELL_M): GroundMaskData | null

## engine/vxlscene/GroundPlaneFeed.ts
type ChunkQuadsSelector = (chunk: DecodedVxlSceneWorld['chunks'][number]) => DecodedChunkQuads | null
function chunkFloorRects(quads: DecodedChunkQuads, minVoxelSize: number, originX: number, originY: number, originZ: number, out: GroundRect[] = []): GroundRect[]
function vxlSceneFloorRects(world: DecodedVxlSceneWorld, selectQuads: ChunkQuadsSelector): GroundRect[]
interface FloorTriangles — A world-space triangle soup, as `TopDownGround.setSourceTriangles` takes it.
FloorTriangles.verts: Float32Array
FloorTriangles.indices: Uint32Array
function vxlSceneFloorTriangles(world: DecodedVxlSceneWorld): FloorTriangles

## engine/vxlscene/GroundTypes.ts
const GROUND_TYPE = { none: 0, asphalt: 1, cobble: 2, brick: 3, sidewalk: 4, gra
type GroundTypeName = keyof typeof GROUND_TYPE
function groundTypeByte(name: string): number
function isStoneDetail(t: number): boolean
function grassDensity(t: number): number
function hasPebbles(t: number): boolean
function groundFoliageType(t: number): FoliageType
function groundGrip(t: number): number

## engine/vxlscene/PathCull.ts
interface PathCullPoint — One control point of the path. `y` is accepted and ignored — the cull is horizontal.
PathCullPoint.x: number
PathCullPoint.y?: number
PathCullPoint.z: number
type PathCullMode = 'both' | 'outside'
interface PathCullSpec — The caller-facing cull request (mirrored on the wire and in the asset record).
PathCullSpec.points: PathCullPoint[]
PathCullSpec.closed: boolean
PathCullSpec.distanceM: number
PathCullSpec.mode: PathCullMode
type PathCullBoxClass = 'all' | 'none' | 'partial'
interface PathCullMask
PathCullMask.keeps(x: number, z: number): boolean
PathCullMask.classifyBox(minX: number, minZ: number, maxX: number, maxZ: number): PathCullBoxClass
PathCullMask.readonly mode: PathCullMode
PathCullMask.readonly segmentCount: number
interface PathCullBounds — World extent the mask is defined over (the bake's chunk-aligned bounds).
PathCullBounds.minX: number
PathCullBounds.minZ: number
PathCullBounds.maxX: number
PathCullBounds.maxZ: number
function buildPathCullMask(spec: PathCullSpec, bounds: PathCullBounds): PathCullMask

## engine/vxlscene/SceneVoxTypes.ts
interface RGB — RGB in [0,1] linear space.
RGB.r: number
RGB.g: number
RGB.b: number
type DisplacementAxis = 'x' | 'y' | 'z'
interface ObjectControls — Per-object bake controls, resolved from the public options maps (design §3.3, §6).
ObjectControls.lodOffset: number
ObjectControls.pinned: boolean
ObjectControls.trimeshCollider: boolean
ObjectControls.noCollider: boolean
ObjectControls.collisionOnly: boolean
ObjectControls.displacementAxis: DisplacementAxis | null
const DEFAULT_OBJECT_CONTROLS: ObjectControls
function validateObjectControls(nodeName: string, controls: ObjectControls): void
interface CellAttr — A surface/interior min-cell in the per-chunk attribute grid (design §3.5).
CellAttr.color: RGB
CellAttr.nx: number
CellAttr.ny: number
CellAttr.nz: number
CellAttr.interior: boolean
CellAttr.noCollider: boolean
CellAttr.pinned: boolean
CellAttr.displacementAxis: DisplacementAxis | null
CellAttr.dispOffset: number
interface SceneVoxel — A compacted variable-size voxel (design §3.7). Grid coords are in min-cell units.
SceneVoxel.gx: number
SceneVoxel.gy: number
SceneVoxel.gz: number
SceneVoxel.sizeLevel: number
SceneVoxel.color: RGB
SceneVoxel.noCollider: boolean
SceneVoxel.disp: { dx: number; dy: number; dz: number } | null
interface SceneQuad — One greedy-meshed face rectangle (design §3.9). The static render hint is SceneQuad[].
SceneQuad.gx: number
SceneQuad.gy: number
SceneQuad.gz: number
SceneQuad.w: number
SceneQuad.h: number
SceneQuad.axis: 0 | 1 | 2
SceneQuad.dir: 1 | -1
SceneQuad.color: RGB
SceneQuad.disp: number
SceneQuad.noCollider?: boolean
SceneQuad.offset?: number

## engine/vxlscene/SurfaceMeshBuilder.ts
interface SurfaceField
SurfaceField.cells: number
SurfaceField.s: number
SurfaceField.step: number
SurfaceField.count: number
SurfaceField.gx0: number
SurfaceField.gz0: number
SurfaceField.sx: number
SurfaceField.sz: number
SurfaceField.tw: number
SurfaceField.th: number
SurfaceField.tileTopY: (Float32Array | null)[]
SurfaceField.tileColorIdx: (Uint16Array | null)[]
function cellTopY(field: SurfaceField, gX: number, gZ: number): number | null
function cellColorIdx(field: SurfaceField, gX: number, gZ: number): number | null
function cornerHeightAt(field: SurfaceField, X: number, Z: number): number | null
function buildSurfaceField(world: DecodedVxlSceneWorld, step: number): SurfaceField
interface SurfaceGeometryData — Per-chunk welded surface geometry as raw typed arrays (renderer wraps into THREE).
SurfaceGeometryData.positions: Float32Array
SurfaceGeometryData.uvs: Uint16Array
SurfaceGeometryData.normals: Float32Array
SurfaceGeometryData.indices: Uint32Array
SurfaceGeometryData.vertCount: number
SurfaceGeometryData.indexCount: number
function measureChunkSurface(field: SurfaceField, chunk: DecodedChunk): { vertCount: number; indexCount: number }
function measureChunkSurfaceByClass(field: SurfaceField, chunk: DecodedChunk, classByCell: Uint8Array): Map<number, { vertCount: number; indexCount: number }>
function buildChunkSurfaceGeometry(field: SurfaceField, chunk: DecodedChunk, paletteUV: Float32Array, counts?: { vertCount: number; indexCount: number }): SurfaceGeometryData | null
function buildChunkSurfaceGeometryForClass(field: SurfaceField, chunk: DecodedChunk, paletteUV: Float32Array, classByCell: Uint8Array, classIdx: number, counts: { vertCount: number; indexCount: number }): SurfaceGeometryData | null

## engine/vxlscene/SurfaceRasterizer.ts
interface RasterTriangle
RasterTriangle.v0: [number, number, number]
RasterTriangle.v1: [number, number, number]
RasterTriangle.v2: [number, number, number]
RasterTriangle.normal: [number, number, number]
RasterTriangle.nodeName: string
RasterTriangle.sampleColor: (point: [number, number, number]) => RGB
interface RasterCtx
RasterCtx.originCellX: number
RasterCtx.originCellY: number
RasterCtx.originCellZ: number
RasterCtx.cellsPerAxis: number
RasterCtx.minVoxelSize: number
RasterCtx.controlsByNode: Record<string, ObjectControls>
const CELL_KEY_BASE = 131072
const CELL_KEY_HALF = 65536
function packCell(x: number, y: number, z: number): number
function unpackCell(key: number): [number, number, number]
function rasterizeChunk(tris: RasterTriangle[], ctx: RasterCtx): Map<number, CellAttr>

## engine/vxlscene/VoxelCompactor.ts
interface CompactCtx
CompactCtx.maxSizeLevel: number
CompactCtx.coplanarCos: number
CompactCtx.colorTol: number
function compact(grid: Map<number, CellAttr>, ctx: CompactCtx): SceneVoxel[]

## engine/vxlscene/VxlSceneEmissiveMaterial.ts
interface VxlSceneMaterialParams — The per-batch visual fields the renderer varies; everything else is the shared atlas setup.
VxlSceneMaterialParams.flatShading: boolean
VxlSceneMaterialParams.polygonOffset: boolean
VxlSceneMaterialParams.polygonOffsetFactor: number
VxlSceneMaterialParams.polygonOffsetUnits: number
VxlSceneMaterialParams.materialQuality: MaterialQuality
function createVxlSceneBatchMaterial(params: VxlSceneMaterialParams, emissive: boolean, className?: string): THREE.Material

## engine/vxlscene/VxlSceneFormat.ts
const VXLSCENE_MAGIC = 0x43_53_4c_56
interface NamedTrimesh — One trimesh-collider surface tagged with the source GLB object's node name.
NamedTrimesh.name: string
NamedTrimesh.verts: Float32Array
NamedTrimesh.indices: Uint32Array
interface VxlSceneChunk
VxlSceneChunk.cx: number
VxlSceneChunk.cy: number
VxlSceneChunk.cz: number
VxlSceneChunk.voxels: SceneVoxel[]
VxlSceneChunk.lodHints: SceneQuad[][]
VxlSceneChunk.namedTrimeshes: NamedTrimesh[]
interface DecodedChunkVoxels — Per-chunk voxel columns (one parallel array per field).
DecodedChunkVoxels.count: number
DecodedChunkVoxels.gx: Uint16Array
DecodedChunkVoxels.gy: Uint16Array
DecodedChunkVoxels.gz: Uint16Array
DecodedChunkVoxels.sizeLevel: Uint8Array
DecodedChunkVoxels.colorIdx: Uint16Array
DecodedChunkVoxels.flags: Uint8Array
DecodedChunkVoxels.disp: Int8Array | null
interface DecodedChunkQuads — One LOD level's greedy-quad columns.
DecodedChunkQuads.count: number
DecodedChunkQuads.gx: Uint16Array
DecodedChunkQuads.gy: Uint16Array
DecodedChunkQuads.gz: Uint16Array
DecodedChunkQuads.w: Uint16Array
DecodedChunkQuads.h: Uint16Array
DecodedChunkQuads.axisDir: Uint8Array
DecodedChunkQuads.colorIdx: Uint16Array
DecodedChunkQuads.disp: Int8Array
interface DecodedSurfaceTile — Per-chunk smooth-surface heightfield (v5+). The smooth (smooth:y) ride surface used to be
DecodedSurfaceTile.count: number
DecodedSurfaceTile.localGx: Uint16Array
DecodedSurfaceTile.localGz: Uint16Array
DecodedSurfaceTile.gy: Uint16Array
DecodedSurfaceTile.dy: Int8Array
DecodedSurfaceTile.colorIdx: Uint16Array
interface DecodedChunk
DecodedChunk.cx: number
DecodedChunk.cy: number
DecodedChunk.cz: number
DecodedChunk.voxels: DecodedChunkVoxels
DecodedChunk.lodHints: DecodedChunkQuads[]
DecodedChunk.namedTrimeshes: NamedTrimesh[]
DecodedChunk.surfaceTile?: DecodedSurfaceTile | null
interface DecodedVxlSceneWorld
DecodedVxlSceneWorld.chunkSize: number
DecodedVxlSceneWorld.minVoxelSize: number
DecodedVxlSceneWorld.bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }
DecodedVxlSceneWorld.lodDistances: number[]
DecodedVxlSceneWorld.chunks: DecodedChunk[]
DecodedVxlSceneWorld.surfaceStep: number
DecodedVxlSceneWorld.groundMask?: GroundMaskData | null
DecodedVxlSceneWorld.emissiveByCell?: Uint8Array | null
DecodedVxlSceneWorld.materialClassByCell?: Uint8Array | null
DecodedVxlSceneWorld.materialClassNames?: string[] | null
interface VxlSceneTotals — Per-bake aggregate counts. Populated by `bakeSceneFromTriangles` so callers can
VxlSceneTotals.nonEmptyChunkCount: number
VxlSceneTotals.totalVoxels: number
VxlSceneTotals.totalLod0Quads: number
VxlSceneTotals.totalTrimeshTris: number
VxlSceneTotals.totalTrimeshBytes: number
VxlSceneTotals.chunksByOffset: Record<number, number>
VxlSceneTotals.voxelsByOffset: Record<number, number>
interface VxlSceneWorld
VxlSceneWorld.chunkSize: number
VxlSceneWorld.minVoxelSize: number
VxlSceneWorld.bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }
VxlSceneWorld.lodDistances: number[]
VxlSceneWorld.chunks: VxlSceneChunk[]
VxlSceneWorld.totals?: VxlSceneTotals
VxlSceneWorld.groundMask?: GroundMaskData | null
VxlSceneWorld.emissiveByCell?: Map<number, number> | null
VxlSceneWorld.materialClassByCell?: Map<number, string> | null
interface VxlSceneEncodeOptions
VxlSceneEncodeOptions.compression?: 'none' | 'gzip'
interface VxlSceneDecodeOptions — Options for `decodeVxlScene`. All fields optional and default to a full,
VxlSceneDecodeOptions.skipLodLevels?: number
interface VxlSceneHeaderInfo — World-level metadata the streaming encoder needs before any chunk arrives.
VxlSceneHeaderInfo.chunkSize: number
VxlSceneHeaderInfo.minVoxelSize: number
VxlSceneHeaderInfo.bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }
VxlSceneHeaderInfo.lodDistances: number[]
VxlSceneHeaderInfo.groundMask?: GroundMaskData | null
VxlSceneHeaderInfo.emissiveByCell?: Map<number, number> | null
VxlSceneHeaderInfo.materialClassByCell?: Map<number, string> | null
VxlSceneHeaderInfo.surfaceStep?: number
interface VxlSceneEncoder — Incremental, memory-bounded VxlScene encoder. Encodes + gzips each chunk's blob
VxlSceneEncoder.addChunk(chunk: VxlSceneChunk): Promise<void>
VxlSceneEncoder.finish(): Promise<Uint8Array>
function isVxlScene(buf: ArrayBuffer): boolean
function createVxlSceneEncoder(header: VxlSceneHeaderInfo, opts?: VxlSceneEncodeOptions): VxlSceneEncoder
function encodeVxlScene(world: VxlSceneWorld, opts?: VxlSceneEncodeOptions): Promise<Uint8Array>
function decodeVxlScene(bytes: Uint8Array, opts?: VxlSceneDecodeOptions): Promise<DecodedVxlSceneWorld>

## engine/vxlscene/VxlSceneRenderer.ts
interface VxlSceneRendererOptions — Renderer tuning knobs the decoded world doesn't carry.
VxlSceneRendererOptions.surfaceStep: number
VxlSceneRendererOptions.materialQuality: MaterialQuality
const DEFAULT_VXL_SCENE_RENDERER_OPTIONS: VxlSceneRendererOptions
function pickLod(distance: number, lodDistances: number[], maxLod: number): number
class VxlSceneRenderer
VxlSceneRenderer.group: THREE.Group
VxlSceneRenderer.constructor(world: DecodedVxlSceneWorld, opts: VxlSceneRendererOptions = DEFAULT_VXL_SCENE_RENDERER_OPTIONS)
VxlSceneRenderer.updateLod(cameraWorldPos: THREE.Vector3): void
VxlSceneRenderer.setRenderRegion(region: THREE.Box3 | null): void
VxlSceneRenderer.markDecodedColumnsReleased(): void
VxlSceneRenderer.setChunkHints(cx: number, cy: number, cz: number, lodHints: DecodedChunkQuads[]): void
VxlSceneRenderer.releaseCpuGeometry(mode: CpuReleaseMode = 'full'): void
VxlSceneRenderer.setBatchCulling(enabled: boolean): void
VxlSceneRenderer.dispose(): void

## engine/vxlscene/WindingNumberFill.ts
interface WindingTriangle
WindingTriangle.v0: [number, number, number]
WindingTriangle.v1: [number, number, number]
WindingTriangle.v2: [number, number, number]
interface WindingTree
WindingTree.windingAt: (p: [number, number, number]) => number
function buildWindingTree(tris: WindingTriangle[]): WindingTree
interface InteriorResult — Result of interior classification: large interior voxels + a solidity predicate.
InteriorResult.voxels: SceneVoxel[]
InteriorResult.isSolid: (gx: number, gy: number, gz: number) => boolean
function fillInterior(grid: Map<number, CellAttr>, ctx: RasterCtx, tree: WindingTree, opts?: { defaultColor?: RGB; maxSizeLevel?: number }): InteriorResult

## engine/vxlscene/atlasColor.ts
const ATLAS_CELL_COUNT = 4096
function srgbEncode8(v: number): number
function rgb888ToAtlasCell(r: number, g: number, b: number): number
function atlasCellRepr(cell: number): { r: number; g: number; b: number }
function atlasCellToLinearRgb(cell: number): { r: number; g: number; b: number }

## engine/vxlscene/bakeScene.ts
interface BakeOptions
BakeOptions.chunkSize: number
BakeOptions.minVoxelSize: number
BakeOptions.maxVoxelSize: number
BakeOptions.additionalLods: number
BakeOptions.lodDistances: number[]
BakeOptions.fillInterior: boolean
BakeOptions.interiorFieldCellSize?: number
BakeOptions.controlsByNode: Record<string, ObjectControls>
BakeOptions.bounds?: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }
BakeOptions.pathCull?: PathCullMask
BakeOptions.onProgress?: (info: { chunkIndex: number; totalChunks: number; nonEmptyChunks: number; label: string }) => void
BakeOptions.onChunkBaked?: (chunk: VxlSceneChunk) => Promise<void> | void
BakeOptions.profile?: { onChunk: (info: { index: number; totalChunks: number; cx: number; cy: number; cz: number; surfaceCells: number; interiorCells: number; voxels: number; quads: number; rasterizeMs: number; fillMs: number; compactMs: number; meshMs: number; clipMs: number; /** * The chunk's FINEST per-axis cell count (= worldCellsPerAxis / 2^minOffset, * minOffset = the finest overlapping object's lodOffset). A chunk now mixes * per-object resolutions, so this is the finest one present; surfaceCells / * voxels / quads are summed across all of the chunk's per-object groups. Lets * harnesses tally the resolution distribution. The interior fast-path emits no * onChunk. */ chunkCellsPerAxis: number; /** The chunk's finest (min) overlapping-object lodOffset. */ lodOffset: number; }) => void; }
function downsampleGrid(grid: Map<number, CellAttr>): Map<number, CellAttr>
function log2Int(v: number): number
function localizeChunkResQuads(quads: SceneQuad[], cx: number, cy: number, cz: number, chunkCellsPerAxis: number, chunkScale: number, extraFactor: number): SceneQuad[]
function bakeSceneFromTriangles(tris: RasterTriangle[], opts: BakeOptions): Promise<VxlSceneWorld>

## engine/vxlscene/buildHintMesh.ts
interface HintMeshCtx
HintMeshCtx.minVoxelSize: number
HintMeshCtx.originX: number
HintMeshCtx.originY: number
HintMeshCtx.originZ: number
function buildHintMeshSoA(quads: DecodedChunkQuads, paletteUV: Float32Array, ctx: HintMeshCtx, material?: THREE.MeshLambertMaterial): THREE.Mesh
function buildHintMesh(quads: SceneQuad[], ctx: HintMeshCtx): THREE.Mesh

## engine/vxlscene/classByColor.ts
const MAX_LEVEL_MATERIAL_CLASSES = 3
interface ClassByColorResult
ClassByColorResult.classNames: VoxelMaterialClassName[]
ClassByColorResult.classIdxByPaletteEntry: Uint8Array
ClassByColorResult.unmatched: string[]
ClassByColorResult.notes: string[]
function applyClassByColor(paletteCells: ArrayLike<number>, cellCoverage: ArrayLike<number>, materialByColor: Record<string, string>, maxClasses: number = MAX_LEVEL_MATERIAL_CLASSES): ClassByColorResult

## engine/vxlscene/emissiveAttribute.ts
function deriveEmissiveAttribute(quadCells: ArrayLike<number>, vertsPerQuad: number, emissiveByCell: Uint8Array, lod: number): Float32Array
function buildCellByPaletteUv(paletteUV: Float32Array): Map<number, Map<number, number>>
function deriveEmissiveFromUv(uvs: Uint16Array, vertCount: number, cellByUv: Map<number, Map<number, number>>, emissiveByCell: Uint8Array): Float32Array

## engine/vxlscene/emissiveByColor.ts
interface EmissiveByColorResult
EmissiveByColorResult.emissive: Uint8Array
EmissiveByColorResult.unmatched: string[]
function applyEmissiveByColor(paletteCells: ArrayLike<number>, emissiveByColor: Record<string, number>): EmissiveByColorResult

## engine/vxlscene/lodVariants.ts
const LOD_VARIANT_DROPS: readonly number[]
function dropFinestQuadLods(chunk: VxlSceneChunk, drop: number): VxlSceneChunk
function surfaceStepForDrop(drop: number): number
function decimateChunkSurface(chunk: VxlSceneChunk, step: number, cellsPerChunk: number): VxlSceneChunk
function coarsenChunkForVariant(chunk: VxlSceneChunk, drop: number, cellsPerChunk: number): VxlSceneChunk
function countChunkQuads(chunk: VxlSceneChunk): number

## engine/vxlscene/triBoxOverlap.ts
function triBoxOverlap(c: [number, number, number], h: [number, number, number], v0: [number, number, number], v1: [number, number, number], v2: [number, number, number]): boolean
