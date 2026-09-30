# engine-api-render

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/AmbientFloorLight.ts
const AMBIENT_FLOOR_LIGHT_NAME = 'AmbientFloor'
const DEFAULT_AMBIENT_FLOOR = 0.05
function resolveAmbientFloor(config?: LightingConfig | null): number
function installAmbientFloorLight(scene: THREE.Scene): THREE.AmbientLight
function applyAmbientFloor(scene: THREE.Scene, config?: LightingConfig | null): void

## engine/ClassedPartMaterial.ts
const CLASSED_PART_CLASS = 'weaponPartClass'
const CLASSED_PART_COLOR = 'weaponPartColor'
const CLASSED_PART_GLOW = 'weaponPartGlow'
interface ClassedPartMaterialOptions
ClassedPartMaterialOptions.color: number
ClassedPartMaterialOptions.glow?: number
ClassedPartMaterialOptions.vertexColors?: boolean
ClassedPartMaterialOptions.flatShading?: boolean
type ClassedPartMaterial = | THREE.MeshLambertMaterial | THREE.MeshPhongMaterial | THREE.MeshPhysicalMaterial
function createClassedPartMaterial(className: string, options: ClassedPartMaterialOptions, quality?: MaterialQuality): ClassedPartMaterial
function isClassedPartMaterial(mat: THREE.Material): boolean

## engine/EnvDistanceFade.ts
function setEnvFadeBand(band: EnvFadeBand): void
function createFadedEnvMaterial(source: THREE.Material): THREE.Material

## engine/EnvDistanceFadeBand.ts
interface EnvFadeBand — Pure fade-band math for `EnvDistanceFade` — kept free of `three/webgpu` /
EnvFadeBand.start: number
EnvFadeBand.end: number
const DISABLED_FADE_BAND: EnvFadeBand
function computeEnvFadeBand(maxRenderDistance: number): EnvFadeBand

## engine/EnvLodPolicy.ts
const BUILDING_LOD_MAX_DIM_M = 12
const BUILDING_LOD_DISTANCES_M = [0, 100, 200, 300]
const PROP_LOD_DISTANCES_M = [0, 70, 120, 180, 240]
const INSTANCE_CULL_SPHERE_MARGIN = 1.15
const BUILDING_ADDITIONAL_LODS = 3
const PROP_ADDITIONAL_LODS = 2
const MAX_DROPPED_ENV_LODS = 2
function isBuildingSized(maxDimMeters: number): boolean
function additionalLodsForSize(maxDimMeters: number): number
function additionalLodsForBake(fitBox: { x: number; z: number; height: number } | undefined, fallbackMaxDimMeters: number): number

## engine/EnvSplatObjects.ts
interface SplatObjectTransform — Transform slice the loader needs from EnvironmentObjectSystem.parseObjectTransform.
SplatObjectTransform.x: number
SplatObjectTransform.y: number
SplatObjectTransform.z: number
interface SplatObjectGroup — One asset's worth of splat instances, grouped by env-object type name.
SplatObjectGroup.typeName: string
SplatObjectGroup.objDefs: any[]
SplatObjectGroup.asset: any
function loadGaussianSplatObjects(splatGroups: SplatObjectGroup[], engineRef: any | null, parseObjectTransform: (objDef: any) => SplatObjectTransform): Promise<void>

## engine/EnvironmentLightSystem.ts
interface EnvironmentLightOptions — Turns placed environment objects into light sources.
EnvironmentLightOptions.poolSize: number
const DEFAULT_ENVIRONMENT_LIGHT_OPTIONS: EnvironmentLightOptions
interface SmartPartAnchors — What `followSmartParts` needs from `SmartObjectSystem`.
SmartPartAnchors.anchorToWorld(id: string, partName: string, point: Vector3Like, out: THREE.Vector3): boolean
class EnvironmentLightSystem
EnvironmentLightSystem.constructor(scene: THREE.Scene, options: EnvironmentLightOptions)
static EnvironmentLightSystem.gameDataHasEmitters(gameData: GameData): boolean
EnvironmentLightSystem.initFromGameData(gameData: GameData): void
EnvironmentLightSystem.followSmartParts(smart: SmartPartAnchors | null): void
EnvironmentLightSystem.hasRiders(): boolean
EnvironmentLightSystem.updateFlicker(elapsedSeconds: number): void
EnvironmentLightSystem.dispose(): void

## engine/GaussianSplatExporter.ts
type PointValidator = (point: { x: number; y: number; z: number }) => boolean
interface ExternalViewpoint — One pre-computed camera viewpoint, in world coordinates.
ExternalViewpoint.position: [number, number, number]
ExternalViewpoint.target: [number, number, number]
ExternalViewpoint.name?: string
interface GaussianSplatExportOptions
GaussianSplatExportOptions.numViews: number
GaussianSplatExportOptions.width: number
GaussianSplatExportOptions.height: number
GaussianSplatExportOptions.worldSizeX?: number
GaussianSplatExportOptions.worldSizeZ?: number
GaussianSplatExportOptions.characterHeight?: number
GaussianSplatExportOptions.isPointInPlayableArea?: PointValidator
GaussianSplatExportOptions.externalViewpoints?: ExternalViewpoint[]
GaussianSplatExportOptions.onFrame?: (frameIndex: number, fileName: string, pngBase64: string) => void
GaussianSplatExportOptions.onProgress?: (current: number, total: number) => void
GaussianSplatExportOptions.onComplete?: (transformsJson: string) => void
GaussianSplatExportOptions.onError?: (error: Error) => void
class GaussianSplatExporter — Exports the current Three.js scene as rendered images + camera poses
GaussianSplatExporter.isActive(): boolean
GaussianSplatExporter.getProgress(): { current: number; total: number }
GaussianSplatExporter.startExport(scene: THREE.Scene, camera: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer, options: GaussianSplatExportOptions): void
GaussianSplatExporter.processFrame(scene: THREE.Scene, renderer: THREE.WebGLRenderer): boolean
GaussianSplatExporter.cancel(): void
function generateInitializationPLY(scene: THREE.Scene, targetPointCount: number = 5_000_000, minPointsPerTriangle: number = 3, worldSizeX: number = 128, worldSizeZ: number = 128, isPointInPlayableArea?: PointValidator): ArrayBuffer

## engine/GaussianSplatRenderer.ts
class GaussianSplatRenderer
GaussianSplatRenderer.constructor(scene: THREE.Scene, config: GaussianSplatConfig, physicsWorld?: PhysicsWorld | null, engine?: any, envObjectId?: string | null)
GaussianSplatRenderer.updateSplatTransform(position: THREE.Vector3, rotation: THREE.Euler, scale: THREE.Vector3): void
GaussianSplatRenderer.getPosition(): THREE.Vector3
GaussianSplatRenderer.getRotation(): THREE.Euler
GaussianSplatRenderer.getScale(): THREE.Vector3
GaussianSplatRenderer.setColliderEditor(editor: any): void
GaussianSplatRenderer.getEnvObjectId(): string | null
GaussianSplatRenderer.setSceneObject(obj: THREE.Object3D | null): void
GaussianSplatRenderer.load(): Promise<void>
GaussianSplatRenderer.getActiveColliderKind(): 'mesh' | 'voxel' | 'none'
GaussianSplatRenderer.setColliderVisualizationVisible(visible: boolean): void
GaussianSplatRenderer.setSplatRenderMode(mode: 'points' | 'gaussian'): void
GaussianSplatRenderer.updatePerFrame(_camera: THREE.Camera): void
GaussianSplatRenderer.getVisibleCells(camera: THREE.Camera): number[]
GaussianSplatRenderer.hasVisibilityCulling(): boolean
GaussianSplatRenderer.adjustRotation(axis: 'x' | 'y' | 'z', amount: number): void
GaussianSplatRenderer.getCurrentRotation(): { x: number; y: number; z: number }
GaussianSplatRenderer.dispose(): void
GaussianSplatRenderer.getSplatMesh(): THREE.Object3D | null
GaussianSplatRenderer.setSplatVisibility(visible: boolean): void
GaussianSplatRenderer.loadTestSplat(url: string): Promise<void>
GaussianSplatRenderer.toggleColliderVisibility(): void
GaussianSplatRenderer.setColliderVisibility(visible: boolean): void
GaussianSplatRenderer.getColliderVisibility(): boolean
GaussianSplatRenderer.getGlbMesh(): THREE.Object3D | null
GaussianSplatRenderer.getSplatUrl(): string
GaussianSplatRenderer.setOnLoadComplete(callback: () => void): void
GaussianSplatRenderer.getIsLoading(): boolean
GaussianSplatRenderer.closeColliderEditor(): void
GaussianSplatRenderer.getColliderEditor(): any | null
GaussianSplatRenderer.hasVoxelColliders(): boolean
GaussianSplatRenderer.getGlbBounds(): THREE.Box3 | null
GaussianSplatRenderer.getGlbMinY(): number | null
GaussianSplatRenderer.getVoxelWorld(): VoxelWorld | null
GaussianSplatRenderer.ensureVoxelWorld(voxelSize?: number): VoxelWorld
GaussianSplatRenderer.getVoxelWorldBoundsRaw(): RawBounds | null
GaussianSplatRenderer.getDenseBounds(opacityThreshold: number = 0.3, percentile: number = 0.95): { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } | null
GaussianSplatRenderer.setVoxelWorldBoundsRaw(bounds: RawBounds | null): void
GaussianSplatRenderer.setCropBoundsRaw(bounds: RawBounds | null): void
GaussianSplatRenderer.getCropBoundsRaw(): RawBounds | null
GaussianSplatRenderer.setCleanupBoundsRaw(bounds: RawBounds | null): void
GaussianSplatRenderer.setShadowCatcherEnabled(enabled: boolean): void
GaussianSplatRenderer.getShadowCatcherEnabled(): boolean
GaussianSplatRenderer.setShadowCatcherYOffset(offset: number): void
GaussianSplatRenderer.getShadowCatcherYOffset(): number
GaussianSplatRenderer.getCleanupBoundsRaw(): RawBounds | null
GaussianSplatRenderer.getSplatSubjectBounds(): THREE.Box3 | null
GaussianSplatRenderer.getVoxelColliderBounds(): THREE.Box3 | null
GaussianSplatRenderer.getVoxelColliderMinY(): number | null
GaussianSplatRenderer.findSpawnPositionInColliderMesh(preferredX?: number, preferredZ?: number): THREE.Vector3 | null

## engine/GeometryCache.ts
class GeometryCache — Deduplicates Three.js geometries by dimensions.
GeometryCache.box(width: number, height: number, depth: number): THREE.BoxGeometry
GeometryCache.sphere(radius: number, widthSegments = 8, heightSegments = 6): THREE.SphereGeometry
GeometryCache.cylinder(radiusTop: number, radiusBottom: number, height: number, radialSegments = 8): THREE.CylinderGeometry
GeometryCache.get size(): number
GeometryCache.dispose(): void

## engine/GeometryCpuRelease.ts
type CpuReleaseMode = 'full' | 'keep-pickable'
function setGeometryReleaseSuspended(suspended: boolean): void
function isGeometryReleaseSuspended(): boolean
function releaseAttributeArray(attr: THREE.BufferAttribute): void
function attributesToKeep(mesh: THREE.Mesh): Set<string>
function releaseGeometryCpuBuffers(geom: THREE.BufferGeometry, mode: CpuReleaseMode, keep: ReadonlySet<string> = new Set()): void
function releaseMeshCpuBuffersAfterUpload(mesh: THREE.Mesh, mode: CpuReleaseMode, keepShadingAttributes = false): void

## engine/GlbPreviewRenderer.ts
class GlbPreviewRenderer
GlbPreviewRenderer.constructor()
GlbPreviewRenderer.generatePreview(glbUrl: string): Promise<string>
GlbPreviewRenderer.dispose(): void
function getGlbPreviewRenderer(): GlbPreviewRenderer

## engine/HqGenerationGlow.ts
interface HqGlowDeps
HqGlowDeps.collectMeshesForTypes(typeNames: Set<string>): THREE.Object3D[]
class HqGenerationGlow
HqGenerationGlow.constructor(deps: HqGlowDeps)
HqGenerationGlow.getActiveTypes(): ReadonlySet<string>
HqGenerationGlow.setGeneratingTypes(typeNames: Iterable<string>): void
HqGenerationGlow.clear(): void
HqGenerationGlow.dispose(): void

## engine/LightingPresets.ts
type LightingPreset = 'stylized-day' | 'golden-hour' | 'overcast-forest' | 'moonlit-street'
const LIGHTING_PRESETS: Readonly<Record<LightingPreset, AtmospherePreset>>
function resolveLightingConfig(config?: LightingConfig | null): LightingConfig | null
function resolveAtmosphereFog(lighting: LightingConfig | null, fog: FogConfig | null): FogConfig | null

## engine/MaterialCache.ts
interface StandardMaterialOpts
StandardMaterialOpts.roughness?: number
StandardMaterialOpts.metalness?: number
StandardMaterialOpts.emissive?: number
StandardMaterialOpts.transparent?: boolean
StandardMaterialOpts.opacity?: number
interface BasicMaterialOpts
BasicMaterialOpts.transparent?: boolean
BasicMaterialOpts.opacity?: number
BasicMaterialOpts.depthWrite?: boolean
interface ClassedMaterialOpts
ClassedMaterialOpts.glow?: number
ClassedMaterialOpts.transparent?: boolean
ClassedMaterialOpts.opacity?: number
class MaterialCache — Deduplicates Three.js materials by property key.
MaterialCache.get(color: number, opts?: StandardMaterialOpts): THREE.MeshStandardMaterial
MaterialCache.getClassed(className: string, color: number, opts?: ClassedMaterialOpts): ClassedPartMaterial
MaterialCache.getBasic(color: number, opts?: BasicMaterialOpts): THREE.MeshBasicMaterial
MaterialCache.get size(): number
MaterialCache.dispose(): void

## engine/MaterialQuality.ts
type MaterialQuality = 'high' | 'medium' | 'low'
interface MaterialQualityPolicy — What a quality tier actually switches on.
MaterialQualityPolicy.environmentTier: boolean
MaterialQualityPolicy.directTier: boolean
MaterialQualityPolicy.shadingSmoothing: boolean
const DEFAULT_MATERIAL_QUALITY: MaterialQuality
function materialQualityPolicy(quality: MaterialQuality): MaterialQualityPolicy
function isMaterialQuality(value: string): value is MaterialQuality
function resolveMaterialQuality(fallback: MaterialQuality): MaterialQuality
function materialQualityEpoch(): number
function setMaterialQuality(quality: MaterialQuality): void
function clearMaterialQuality(): void

## engine/MaterialRegistry.ts
interface MaterialProperties — MaterialRegistry - Defines physical properties of substances
MaterialProperties.name: string
MaterialProperties.density: number
MaterialProperties.friction: number
MaterialProperties.restitution: number
const MaterialId = { NONE: 0, WOOD: 1, STONE: 2, DIRT: 3, SAND: 4, METAL: 5, IC
type MaterialIdType = typeof MaterialId[keyof typeof MaterialId]
function getMaterialRegistry(): MaterialRegistryImpl

## engine/OffscreenRender.ts
type ReadbackBackend = 'webgpu' | 'webgl'
function normalizeReadbackPixels(raw: Uint8Array, width: number, height: number, backend: ReadbackBackend): Uint8Array
function renderToWebpBlob(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, width: number, height: number, quality: number): Promise<Blob>

## engine/PointLightPool.ts
interface PointLightSource — A "logical" light the pool can point a real light at. Mutate fields in place to animate.
PointLightSource.position: THREE.Vector3
PointLightSource.color: THREE.Color
PointLightSource.intensity: number
PointLightSource.distance: number
PointLightSource.decay: number
interface PointLightPoolOptions
PointLightPoolOptions.poolSize: number
PointLightPoolOptions.focusFromCamera: boolean
PointLightPoolOptions.reassignHysteresis: number
const DEFAULT_POINT_LIGHT_POOL_OPTIONS: PointLightPoolOptions
function updatePointLightPoolsFromCamera(cameraWorldPosition: THREE.Vector3): void
class PointLightPool
PointLightPool.constructor(scene: THREE.Scene, opts: PointLightPoolOptions)
PointLightPool.get size(): number
PointLightPool.setSources(sources: PointLightSource[]): void
PointLightPool.aimAt(focus: THREE.Vector3): void
PointLightPool.dispose(): void

## engine/RendererPreference.ts
const readInitialRendererType = (): RendererType => withoutUnavailableWebGpu(readRequestedRe
const reloadIntoRendererType = (type: RendererType): void => { try { localStorage.setItem(R

## engine/RendererType.ts
type RendererType = 'webgl' | 'webgpu'
function setActiveRendererType(type: RendererType): void
function getActiveRendererType(): RendererType
function isWebGpuActive(): boolean
type RendererBackend = 'webgpu' | 'webgl2'
function getActiveBackend(renderer: unknown): RendererBackend
function rendererBackendReady(renderer: unknown): boolean

## engine/SplatPreviewLoader.ts
interface PreviewMeshOptions
PreviewMeshOptions.pointSize?: number
function loadSplatPreviewMesh(url: string, opts: PreviewMeshOptions = {}): Promise<THREE.Points>

## engine/SplatViewMode.ts
type SplatViewMode = 'both' | 'splats' | 'voxels'
const DEFAULT_SPLAT_VIEW_MODE: SplatViewMode
function isSplatViewMode(value: unknown): value is SplatViewMode
function resolveSplatViewMode(): SplatViewMode
interface SplatViewRenderer — The bits of a splat renderer this controller drives. Structural, so tests need no engine.
SplatViewRenderer.setSplatVisibility?(visible: boolean): void
interface SplatViewColliderEditor — The bit of the collider editor this controller drives.
SplatViewColliderEditor.setVoxelsVisible?(visible: boolean): void
interface SplatViewDeps
SplatViewDeps.getWorldGroup(): THREE.Object3D | null
SplatViewDeps.getRenderers(): SplatViewRenderer[]
SplatViewDeps.getColliderEditor(): SplatViewColliderEditor | null
class SplatViewController — Applies a {@link SplatViewMode} across every surface that has to agree about it.
SplatViewController.constructor(private readonly deps: SplatViewDeps, mode: SplatViewMode = resolveSplatViewMode())
SplatViewController.getMode(): SplatViewMode
SplatViewController.setMode(mode: SplatViewMode): void
SplatViewController.hasSplats(): boolean
SplatViewController.refresh(): void
function ensureSplatViewController(deps: SplatViewDeps): SplatViewController
function refreshSplatView(): void
function activeSplatViewController(): SplatViewController | null

## engine/WebGPUPolygonOffsetFix.ts
function applyWebGPUPolygonOffsetCacheFix(renderer: unknown): void

## engine/WebGPUSwizzleFix.ts
function unchainWgslSwizzles(code: string): string
function applyWebGPUSwizzleFix(renderer: unknown): boolean

## engine/ZFightingRegistry.ts
interface PolygonOffset — ZFightingRegistry - System-wide z-fighting prevention through unique offset assignment.
PolygonOffset.factor: number
PolygonOffset.units: number
interface ZFightingOffsets
ZFightingOffsets.terrain: PolygonOffset
ZFightingOffsets.getObjectOffset: (objectId: string) => PolygonOffset
ZFightingOffsets.getDebrisVertexOffset: (debrisIndex: number) => number
function getZFightingRegistry(): ZFightingRegistryImpl

## engine/autoLodRamp.ts
const AUTO_LOD_LEVELS = 2
const AUTO_LOD_MIN_BOUND = 0.02
const AUTO_LOD_MIN_MAX = 1.0
const AUTO_LOD_MAX_BOUND = 4.0
interface AutoLodLevel
AutoLodLevel.minVoxelSize: number
AutoLodLevel.maxVoxelSize: number
function buildAutoLodRamp(baseMinVoxelSize: number, baseMaxVoxelSize: number, levels: number = AUTO_LOD_LEVELS): AutoLodLevel[]
