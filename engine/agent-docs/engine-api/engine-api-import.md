# engine-api-import

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/import/ImportedVoxelModel.ts
interface ImportedVoxelGrid — One voxel grid (a MagicaVoxel model / Qubicle matrix).
ImportedVoxelGrid.name: string | null
ImportedVoxelGrid.sizeX: number
ImportedVoxelGrid.sizeY: number
ImportedVoxelGrid.sizeZ: number
ImportedVoxelGrid.voxels: Int32Array
interface ImportedVoxelInstance — Placement of a grid in the file's scene (resolved from the .vox scene graph).
ImportedVoxelInstance.gridIndex: number
ImportedVoxelInstance.rotation: readonly [number, number, number, number, number, number, number, number, number]
ImportedVoxelInstance.translation: readonly [number, number, number]
ImportedVoxelInstance.name: string | null
interface ImportedVoxelFile
ImportedVoxelFile.format: 'vox' | 'qb'
ImportedVoxelFile.grids: ImportedVoxelGrid[]
ImportedVoxelFile.palette: Uint8Array
ImportedVoxelFile.paletteEmissive: Uint8Array | null
ImportedVoxelFile.instances: ImportedVoxelInstance[]
ImportedVoxelFile.notes: string[]
const IDENTITY_ROTATION: ImportedVoxelInstance['rotation']
const MAX_IMPORT_VOXELS = 16_777_216

## engine/import/QbParser.ts
function isQbFile(buffer: ArrayBuffer): boolean
function parseQb(buffer: ArrayBuffer): ImportedVoxelFile

## engine/import/SmartObjectParts.ts
const DEFAULT_MIN_COMPONENT_FRACTION = 0.1
function assignPartJoints(master: VoxelMaster, spec: SmartObjectSpec): Uint8Array
function partMotionFromSpec(motion: SmartObjectMotion): VxlV3PartMotion
function partsTableFromSpec(parts: ReadonlyArray<Pick<SmartObjectSpecPart, 'name' | 'parent' | 'motion'>>): VxlV3Part[]
function masterPointToCells(working: ResampledVoxels, point: GridVec3): [number, number, number]
function cellsPartFromWorking(working: ResampledVoxels, packCell: (x: number, y: number, z: number) => number): Map<number, number>
function fitmentFromSpec(spec: SmartObjectSpec, table: readonly VxlV3Part[], pivotsMetres: ReadonlyArray<{ x: number; y: number; z: number }>): SmartObjectFitment
function fitmentFromTable(table: readonly VxlV3Part[], pivotsMetres: ReadonlyArray<{ x: number; y: number; z: number }>): SmartObjectFitment
function lightsFromSpec(spec: SmartObjectSpec, working: ResampledVoxels, bounds: VxlV3Bounds, voxelSize: number): AssetLightEmitter[]

## engine/import/SmartPropParts.ts
const BM_PART_NODE_PREFIX = 'BM_part_'
const BM_SMART_OBJECT_EXTRAS_KEY = 'bmSmartObject'
function isBmPartNodeName(name: string | undefined): boolean
interface AssetBox
AssetBox.min: Vector3Like
AssetBox.max: Vector3Like
interface SmartPropBake — Everything a bake writes for a smart placeholder.
SmartPropBake.table: VxlV3Part[]
SmartPropBake.pivots: Vector3Like[]
SmartPropBake.rig: VxlV3RigInput
SmartPropBake.fitment: SmartObjectFitment
SmartPropBake.light?: AssetLightEmitter
SmartPropBake.lights?: AssetLightEmitter[]
function readSmartPropSpec(raw: unknown, warnings: string[] = []): SmartPropSpec | null
function smartRigFor(table: readonly VxlV3Part[], pivotsMetres: ReadonlyArray<Vector3Like>): VxlV3RigInput
function defaultPartPivot(box: AssetBox, motion: SmartObjectMotion): Vector3Like
interface SmartGlbDerivation — What a GLB bake hands the voxelizer and puts on the record.
SmartGlbDerivation.bake: SmartPropBake
SmartGlbDerivation.voxelizerInput: { table: VxlV3Part[]; rig: VxlV3RigInput; jointOfNode: (nodeName: string) => number }
SmartGlbDerivation.fields: { smartObject: SmartObjectFitment; light?: AssetLightEmitter; lights?: AssetLightEmitter[] }
SmartGlbDerivation.warnings: string[]
function deriveSmartPropFromGlb(extracted: ExtractedGlb): SmartGlbDerivation | null
function smartPropBake(spec: SmartPropSpec, boxes: ReadonlyMap<string, AssetBox>, toAsset: (point: Vector3Like) => Vector3Like, warnings: string[] = []): SmartPropBake | null

## engine/import/VoxDefaultPalette.ts
const VOX_DEFAULT_PALETTE: Uint8Array

## engine/import/VoxParser.ts
function isVoxFile(buffer: ArrayBuffer): boolean
function parseVox(buffer: ArrayBuffer): ImportedVoxelFile

## engine/import/VoxelMaster.ts
const MAX_RESAMPLE_SIZE = 512
const MASTER_UP_AXIS = 1
interface VoxelMaster
VoxelMaster.readonly resolution: number
VoxelMaster.readonly x: Uint16Array
VoxelMaster.readonly y: Uint16Array
VoxelMaster.readonly z: Uint16Array
VoxelMaster.readonly color: Uint32Array
VoxelMaster.readonly count: number
interface MasterExtents
MasterExtents.readonly min: readonly [number, number, number]
MasterExtents.readonly max: readonly [number, number, number]
MasterExtents.readonly span: readonly [number, number, number]
interface ResampleOptions
ResampleOptions.attribute?: Uint8Array
ResampleOptions.readonly targetHeight: number
ResampleOptions.readonly voxelSize: number
ResampleOptions.readonly colorMode: 'mode' | 'mean'
const DEFAULT_RESAMPLE_COLOR_MODE: ResampleOptions['colorMode']
interface ResampledVoxels
ResampledVoxels.masterMin: [number, number, number]
ResampledVoxels.scale: number
ResampledVoxels.attribute?: Uint8Array
ResampledVoxels.readonly x: Uint16Array
ResampledVoxels.readonly y: Uint16Array
ResampledVoxels.readonly z: Uint16Array
ResampledVoxels.readonly color: Uint32Array
ResampledVoxels.readonly count: number
ResampledVoxels.readonly dimensions: readonly [number, number, number]
ResampledVoxels.readonly voxelSize: number
function readVoxelMaster(buffer: ArrayBuffer): VoxelMaster
function masterExtents(master: VoxelMaster): MasterExtents
function rgb444ToImporterBytes(packed: number): number
function resampleMaster(master: VoxelMaster, options: ResampleOptions): ResampledVoxels

## engine/import/VoxelModelCompiler.ts
interface CompiledVoxelModel
CompiledVoxelModel.name: string
CompiledVoxelModel.sizeX: number
CompiledVoxelModel.sizeY: number
CompiledVoxelModel.sizeZ: number
CompiledVoxelModel.cells: Map<number, number>
CompiledVoxelModel.cellsEmissive: Map<number, number> | null
interface CompileOptions
CompileOptions.mode: 'merge' | 'separate'
CompileOptions.baseName: string
CompileOptions.maxVoxels?: number
function compileImportedFile(file: ImportedVoxelFile, options: CompileOptions): CompiledVoxelModel[]

## engine/import/VoxelModelToAsset.ts
interface VoxelAssetImportOptions
VoxelAssetImportOptions.voxelSize: number
VoxelAssetImportOptions.additionalLodCount: number
VoxelAssetImportOptions.maxLeaves: number
VoxelAssetImportOptions.smartParts?: SmartPartsInput
interface SmartPartsInput
SmartPartsInput.cellsPart: Map<number, number>
SmartPartsInput.parts: VxlV3Part[]
SmartPartsInput.pivots: Array<[number, number, number]>
const DEFAULT_VOXEL_ASSET_IMPORT_OPTIONS: VoxelAssetImportOptions
interface VoxelAssetImportResult
VoxelAssetImportResult.vxlBytes: Uint8Array
VoxelAssetImportResult.bounds: VxlV3Bounds
VoxelAssetImportResult.effectiveVoxelSize: number
VoxelAssetImportResult.totalVoxels: number
VoxelAssetImportResult.voxelsPerLod: number[]
VoxelAssetImportResult.lodCount: number
VoxelAssetImportResult.fragmentCount: number
VoxelAssetImportResult.colliderBoxCount: number
VoxelAssetImportResult.trimeshTriangles: number
VoxelAssetImportResult.warning?: string
VoxelAssetImportResult.smartPivots?: Array<{ x: number; y: number; z: number }>
function cellPointToMetres(bounds: VxlV3Bounds, voxelSize: number, cell: readonly [number, number, number]): { x: number; y: number; z: number }
function srgbByteToLinear(v: number): number
function downsampleCellsMajority(cells: Map<number, number>): Map<number, number>
function compileVoxelModelToVxlAsset(model: CompiledVoxelModel, options: VoxelAssetImportOptions): Promise<VoxelAssetImportResult>

## engine/import/VoxelModelToLevel.ts
interface VoxelLevelImportOptions
VoxelLevelImportOptions.voxelSize: number
VoxelLevelImportOptions.chunkSize: number
VoxelLevelImportOptions.additionalLods: Array<{ distance?: number }>
VoxelLevelImportOptions.onProgress?: (info: { chunkIndex: number; totalChunks: number; label: string }) => void
const DEFAULT_VOXEL_LEVEL_IMPORT_OPTIONS: VoxelLevelImportOptions
interface VoxelLevelImportResult
VoxelLevelImportResult.vwldBytes: Uint8Array
VoxelLevelImportResult.worldBounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }
VoxelLevelImportResult.chunkSize: number
VoxelLevelImportResult.nonEmptyChunkCount: number
VoxelLevelImportResult.totalLod0Cells: number
function compileVoxelModelToVwld(model: CompiledVoxelModel, options: VoxelLevelImportOptions): Promise<VoxelLevelImportResult>
