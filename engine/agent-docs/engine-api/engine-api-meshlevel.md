# engine-api-meshlevel

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/meshlevel/DeclaredMeshLevel.ts
interface DeclaredMeshLevel
DeclaredMeshLevel.level: MeshLevel
DeclaredMeshLevel.result: MeshLevelLoadResult
function loadDeclaredMeshLevel(engine: EngineLike, worldProfileData: WorldProfileData): Promise<DeclaredMeshLevel | null>

## engine/meshlevel/MeshLevel.ts
interface MeshLevelSource — Where the level's two halves come from.
MeshLevelSource.glb: { assetId: string } | { url: string }
MeshLevelSource.level: { data: unknown } | { assetId: string } | 'trimesh-from-glb'
interface MeshLevelOptions
MeshLevelOptions.collisionGroup: MeshLevelCollisionGroup
MeshLevelOptions.friction: number
MeshLevelOptions.lighting: MeshLevelLightingOptions
MeshLevelOptions.shadows: MeshLevelShadowMode
MeshLevelOptions.materialConventions: boolean
MeshLevelOptions.registerAsTerrain: boolean
MeshLevelOptions.trimeshFallback: BuildGlbColliderOptions
const DEFAULT_MESH_LEVEL_OPTIONS: MeshLevelOptions
interface MeshLevelLoadResult
MeshLevelLoadResult.colliderCount: number
MeshLevelLoadResult.lightCount: number
MeshLevelLoadResult.bounds: TerrainBounds
MeshLevelLoadResult.warnings: string[]
interface MeshLevelBody — One static body the level owns.
MeshLevelBody.name: string
MeshLevelBody.group: MeshLevelCollisionGroup
MeshLevelBody.rigidBody: ReturnType<typeof PhysicsBodyFactory.createStaticBody>['rigidBody']
MeshLevelBody.collider: ReturnType<typeof PhysicsBodyFactory.createStaticBody>['collider']
class MeshLevelError extends Error
MeshLevelError.constructor(message: string)
const GLASS_MATERIAL_PREFIX = 'glass'
const EMISSIVE_MATERIAL_PREFIX = 'emissive'
const NOCOLLIDE_MESH_PREFIX = 'nocollide'
class MeshLevel implements BakedTerrainProvider
MeshLevel.constructor(private readonly engine: EngineLike, private readonly source: MeshLevelSource, private readonly options: MeshLevelOptions)
MeshLevel.load(): Promise<MeshLevelLoadResult>
MeshLevel.dispose(): void
MeshLevel.getTrimeshNames(): string[]
MeshLevel.getTrimesh(name: string): { vertices: Float32Array; indices: Uint32Array } | null
MeshLevel.getTrackCenterline(name: string, options?: Partial<TrackCenterlineOptions>): CenterlinePoint[]
MeshLevel.landmark(name: string): MeshLevelLandmark
MeshLevel.hasLandmark(name: string): boolean
MeshLevel.landmarksTagged(tag: string): MeshLevelLandmark[]
MeshLevel.volume(name: string): MeshLevelVolume
MeshLevel.volumesAt(point: { x: number; y: number; z: number }): MeshLevelVolume[]
MeshLevel.getColliders(): ReadonlyArray<MeshLevelBody>
MeshLevel.getBounds(): TerrainBounds | null
MeshLevel.getRoot(): THREE.Group
MeshLevel.getLights(): ReadonlyArray<THREE.Light>
MeshLevel.getExtras<T = Record<string, unknown>>(): T
MeshLevel.refreshShadows(): void
function applyMaterialConventions(root: THREE.Object3D): void

## engine/meshlevel/MeshLevelColliders.ts
interface ColliderPlan
ColliderPlan.name: string
ColliderPlan.group: MeshLevelCollisionGroup
ColliderPlan.position: THREE.Vector3
ColliderPlan.quaternion: THREE.Quaternion
ColliderPlan.shape: ColliderShape
ColliderPlan.collisionGroup: number
ColliderPlan.collisionMask: number
function yawQuaternion(yaw: number): THREE.Quaternion
function collisionLayersFor(group: MeshLevelCollisionGroup): { collisionGroup: number; collisionMask: number }
function planCollider(collider: MeshLevelCollider, defaultGroup: MeshLevelCollisionGroup): ColliderPlan
function orientedBoxContains(point: { x: number; y: number; z: number }, position: MeshLevelVec3, size: MeshLevelVec3, yaw: number): boolean
function sampleHeightfield(collider: MeshLevelHeightfieldCollider, x: number, z: number): number | null
function colliderBounds(colliders: ReadonlyArray<MeshLevelCollider>): TerrainBounds | null
function unionBounds(a: TerrainBounds | null, b: TerrainBounds | null): TerrainBounds | null
function symmetricExtent(bounds: TerrainBounds): XZBounds
function soupToRasterTriangles(verts: Float32Array, indices: Uint32Array, nodeName: string): RasterTriangle[]

## engine/meshlevel/MeshLevelLighting.ts
type MeshLevelShadowMode = 'cached' | 'dynamic' | 'none'
interface MeshLevelLightingOptions
MeshLevelLightingOptions.mode: 'interior' | 'exterior' | 'none'
MeshLevelLightingOptions.interior: LightingConfig
MeshLevelLightingOptions.hemisphere: { sky: string; ground: string; intensity: number } | null
MeshLevelLightingOptions.pointLightPoolSize: number
MeshLevelLightingOptions.maxShadowCastingSpots: number
MeshLevelLightingOptions.spotShadowMapSize: number
const DEFAULT_MESH_LEVEL_LIGHTING: MeshLevelLightingOptions
interface AppliedMeshLevelLighting — Everything `applyMeshLevelLighting` touched, so `disposeMeshLevelLighting` can undo exactly that.
AppliedMeshLevelLighting.group: THREE.Group
AppliedMeshLevelLighting.pool: PointLightPool | null
AppliedMeshLevelLighting.spots: THREE.SpotLight[]
AppliedMeshLevelLighting.previousConfig: LightingConfig | null
AppliedMeshLevelLighting.previousHemisphere: { light: THREE.HemisphereLight; sky: THREE.Color; ground: THREE.Color; intensity: number; created: boolean } | null
AppliedMeshLevelLighting.shadows: MeshLevelShadowMode
function resolveShadowMode(requested: MeshLevelShadowMode): MeshLevelShadowMode
function applyMeshLevelLighting(engine: EngineLike, lights: ReadonlyArray<MeshLevelLight>, options: MeshLevelLightingOptions, requestedShadows: MeshLevelShadowMode): AppliedMeshLevelLighting
function refreshCachedShadows(applied: AppliedMeshLevelLighting): void
function disposeMeshLevelLighting(engine: EngineLike, applied: AppliedMeshLevelLighting): void

## engine/meshlevel/MeshLevelSchema.ts
const MESH_LEVEL_FORMAT = 'bitmagic-mesh-level'
const MESH_LEVEL_VERSION = 1
type MeshLevelVec3 = [number, number, number]
type MeshLevelCollisionGroup = 'terrain' | 'environment'
interface MeshLevelBoxCollider
MeshLevelBoxCollider.name: string
MeshLevelBoxCollider.shape: 'box'
MeshLevelBoxCollider.position: MeshLevelVec3
MeshLevelBoxCollider.size: MeshLevelVec3
MeshLevelBoxCollider.yaw: number
MeshLevelBoxCollider.group?: MeshLevelCollisionGroup
interface MeshLevelHullCollider
MeshLevelHullCollider.name: string
MeshLevelHullCollider.shape: 'convexHull'
MeshLevelHullCollider.vertices: number[]
MeshLevelHullCollider.group?: MeshLevelCollisionGroup
interface MeshLevelTrimeshCollider
MeshLevelTrimeshCollider.name: string
MeshLevelTrimeshCollider.shape: 'trimesh'
MeshLevelTrimeshCollider.vertices: number[]
MeshLevelTrimeshCollider.indices: number[]
MeshLevelTrimeshCollider.group?: MeshLevelCollisionGroup
interface MeshLevelHeightfieldCollider — A regular height grid in world space — the compact, exact collider for terrain (a forged
MeshLevelHeightfieldCollider.name: string
MeshLevelHeightfieldCollider.shape: 'heightfield'
MeshLevelHeightfieldCollider.minX: number
MeshLevelHeightfieldCollider.minZ: number
MeshLevelHeightfieldCollider.cellSize: number
MeshLevelHeightfieldCollider.nx: number
MeshLevelHeightfieldCollider.nz: number
MeshLevelHeightfieldCollider.heights: number[]
MeshLevelHeightfieldCollider.group?: MeshLevelCollisionGroup
type MeshLevelCollider = MeshLevelBoxCollider | MeshLevelHullCollider | MeshLevelTrimeshCollider | MeshLevelHeightfieldCollider
interface MeshLevelVolume — A named oriented box region — a room, an airlock, a pressure envelope, a trigger area.
MeshLevelVolume.name: string
MeshLevelVolume.position: MeshLevelVec3
MeshLevelVolume.size: MeshLevelVec3
MeshLevelVolume.yaw: number
MeshLevelVolume.tags: string[]
interface MeshLevelLandmark — A named point with a facing — `spawn`, an extraction pad, an NPC post.
MeshLevelLandmark.name: string
MeshLevelLandmark.position: MeshLevelVec3
MeshLevelLandmark.yaw: number
MeshLevelLandmark.tags: string[]
interface MeshLevelPointLight
MeshLevelPointLight.name: string
MeshLevelPointLight.type: 'point'
MeshLevelPointLight.position: MeshLevelVec3
MeshLevelPointLight.color: string
MeshLevelPointLight.intensity: number
MeshLevelPointLight.distance: number
MeshLevelPointLight.decay: number
interface MeshLevelSpotLight
MeshLevelSpotLight.name: string
MeshLevelSpotLight.type: 'spot'
MeshLevelSpotLight.position: MeshLevelVec3
MeshLevelSpotLight.target: MeshLevelVec3
MeshLevelSpotLight.color: string
MeshLevelSpotLight.intensity: number
MeshLevelSpotLight.angle: number
MeshLevelSpotLight.penumbra: number
MeshLevelSpotLight.castShadow: boolean
type MeshLevelLight = MeshLevelPointLight | MeshLevelSpotLight
interface MeshLevelData
MeshLevelData.format: typeof MESH_LEVEL_FORMAT
MeshLevelData.version: typeof MESH_LEVEL_VERSION
MeshLevelData.units: 'meters'
MeshLevelData.colliders: MeshLevelCollider[]
MeshLevelData.volumes: MeshLevelVolume[]
MeshLevelData.landmarks: MeshLevelLandmark[]
MeshLevelData.lights: MeshLevelLight[]
MeshLevelData.extras: Record<string, unknown>
interface ParsedMeshLevel
ParsedMeshLevel.data: MeshLevelData
ParsedMeshLevel.warnings: string[]
class MeshLevelSchemaError extends Error — Thrown for every contract violation; `path` names the offending JSON node.
MeshLevelSchemaError.constructor(public readonly path: string, detail: string)
const DEFAULT_POINT_LIGHT_DISTANCE_M = 20
const DEFAULT_POINT_LIGHT_DECAY = 2
const DEFAULT_SPOT_ANGLE_RAD = Math.PI / 4
const DEFAULT_SPOT_PENUMBRA = 0.3
const THIN_BOX_WARNING_M = 0.05
const MANY_LIGHTS_WARNING = 8
const SPAWN_LANDMARK = 'spawn'
function parseMeshLevel(raw: unknown, sourceLabel: string): ParsedMeshLevel
