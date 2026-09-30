# engine-api-types

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## types/collectible.ts
interface Collectible — Interface for objects that are automatically collected when the player walks into them.
Collectible.onCollect(): void

## types/game.ts
function resolveAssetUrl(url: string | null | undefined): string | null
type Vector3Like = { x: number; y: number; z: number }
type StartupUiMode = 'engine' | 'external'
interface TerrainFrictionProvider — Interface for world generators that provide terrain friction.
TerrainFrictionProvider.getTerrainFriction(): number
interface GaussianSplatConfig
GaussianSplatConfig.url: string
GaussianSplatConfig.lowResUrl?: string
GaussianSplatConfig.radUrl?: string
GaussianSplatConfig.voxelUrl?: string
GaussianSplatConfig.previewUrl?: string
GaussianSplatConfig.floorMeshUrl?: string
GaussianSplatConfig.walkableUrl?: string
GaussianSplatConfig.pvsUrl?: string
GaussianSplatConfig.colliderUrl?: string
GaussianSplatConfig.colliderType?: 'mesh' | 'voxel'
GaussianSplatConfig.position: Vector3Like
GaussianSplatConfig.eulerAngles?: Vector3Like
GaussianSplatConfig.scale?: Vector3Like
interface AnimationDefinition
AnimationDefinition.animationUrl: string
AnimationDefinition.motionId: string
AnimationDefinition.prompt?: string
interface BaseAnimationDefinition
BaseAnimationDefinition.animationUrl: string
BaseAnimationDefinition.motionId: string
BaseAnimationDefinition.name: string
BaseAnimationDefinition.worksWithAttachedObjects?: boolean
BaseAnimationDefinition.source?: 'mixamo'
BaseAnimationDefinition.designSpeed?: number
interface CustomAttackMove — Custom attack move definition for template-controlled fighting moves.
CustomAttackMove.name: string
CustomAttackMove.animationMotionId: string
CustomAttackMove.type: 'punch' | 'kick' | 'attack'
CustomAttackMove.side?: 'left' | 'right'
CustomAttackMove.damage?: number
CustomAttackMove.range?: number
CustomAttackMove.force?: number
CustomAttackMove.speed?: number
CustomAttackMove.interruptOnMovement?: boolean
CustomAttackMove.splitBodyOnRun?: boolean
CustomAttackMove.filterRootMotion?: boolean
interface CombatConfig — Combat configuration for custom fighting moves
CombatConfig.customMoves?: CustomAttackMove[]
CombatConfig.useOnlyCustomMoves?: boolean
interface GameMetadata — Game metadata stored in game.json
GameMetadata.gameId: string
GameMetadata.gameGenre: string
GameMetadata.gameName: string
GameMetadata.gameDescription: string
GameMetadata.characterUrl: string
GameMetadata.thumbnailUrl: string
GameMetadata.environmentObjectsGeneratedProcedurally?: boolean
GameMetadata.gameDimension?: '2d' | '3d'
GameMetadata.physicsMode?: '2d' | '3d'
GameMetadata.physics2d?: boolean
GameMetadata.artStyle?: 'voxel' | 'low-poly'
interface SpawnPoint — One typed spawn point in the unified `worldProfileData.spawnPoints` array —
SpawnPoint.id: string
SpawnPoint.type: string
SpawnPoint.position: Vector3Like
SpawnPoint.rotationY: number
SpawnPoint.name?: string
SpawnPoint.params?: Record<string, unknown>
interface WorldLevelOverrides — Per-level overrides applied over the game-global WorldProfileData while
WorldLevelOverrides.skyboxUrl?: string
WorldLevelOverrides.fogConfig?: FogConfig
WorldLevelOverrides.lightingConfig?: LightingConfig
WorldLevelOverrides.waterLevelY?: number | null
WorldLevelOverrides.weatherConfig?: WeatherConfig
interface WorldLevel — One entry in the multi-level registry (`worldProfileData.levels`). A level
WorldLevel.id: string
WorldLevel.name: string
WorldLevel.vwldAssetId: string
WorldLevel.spawnPoints?: SpawnPoint[]
WorldLevel.overrides?: WorldLevelOverrides
interface StartScreenSelection — One pre-play selection step on the main screen
StartScreenSelection.id: string
StartScreenSelection.type: 'level' | 'choice'
StartScreenSelection.title?: string
StartScreenSelection.levelIds?: string[]
StartScreenSelection.options?: Array<{ id: string; label: string; imageUrl?: string }>
type Hotspot = VillageHotspot | TowerHotspot | BuildingHotspot
interface BuildingOpening — One wall opening of a `BuildingHotspot`. Sides are world-axis-aligned:
BuildingOpening.side: 'north' | 'south' | 'east' | 'west'
BuildingOpening.offset?: number
BuildingOpening.width?: number
BuildingOpening.height?: number
interface BuildingHotspot — Parametric ENTERABLE building painted from terrain voxel blocks at
BuildingHotspot.id: string
BuildingHotspot.type: 'building'
BuildingHotspot.center: { x: number; z: number }
BuildingHotspot.size: { x: number; z: number }
BuildingHotspot.wallHeight?: number
BuildingHotspot.wallBlockType?: string
BuildingHotspot.roof?: 'flat' | 'none'
BuildingHotspot.roofBlockType?: string
BuildingHotspot.foundationBlockType?: string
BuildingHotspot.doors?: BuildingOpening[]
BuildingHotspot.windows?: Array<BuildingOpening & { sillY?: number }>
interface VillageHotspot — Cluster of buildings within a circular region. Each building gets its own
VillageHotspot.id: string
VillageHotspot.type: 'village'
VillageHotspot.center: { x: number; z: number }
VillageHotspot.radius: number
VillageHotspot.buildingAssetIds: string[]
VillageHotspot.density?: number
VillageHotspot.foundationBlockType?: string
interface TowerHotspot — Single vertical structure with a carved foundation. Position is `center`;
TowerHotspot.id: string
TowerHotspot.type: 'tower'
TowerHotspot.center: { x: number; z: number }
TowerHotspot.assetId: string
TowerHotspot.foundationBlockType?: string
interface CustomBlockType
CustomBlockType.name: string
CustomBlockType.displayName?: string
CustomBlockType.description?: string
CustomBlockType.textureUrl: string
CustomBlockType.sideTextureUrl?: string | null
CustomBlockType.textureSize: number
CustomBlockType.isFluid?: boolean
CustomBlockType.opacity?: number
CustomBlockType.createdAt?: string
interface FitWorldInset — A single viewport edge inset for top-down fit-world UI reservation. Specify in
FitWorldInset.px?: number
FitWorldInset.fraction?: number
interface FitWorldRegion — Viewport edges to reserve for in-game UI so the fitted top-down map fills the
FitWorldRegion.left?: FitWorldInset
FitWorldRegion.right?: FitWorldInset
FitWorldRegion.top?: FitWorldInset
FitWorldRegion.bottom?: FitWorldInset
interface AchievementDefinition — A player-progression achievement definition (umbrella P6). Authored by the
AchievementDefinition.achievementId: string
AchievementDefinition.name: string
AchievementDefinition.description?: string
AchievementDefinition.imageUrl?: string | null
AchievementDefinition.xp?: number
AchievementDefinition.hidden?: boolean
interface DoorDefinition — A door definition for the data-driven dungeon door system
DoorDefinition.id: string
DoorDefinition.levelId?: string
DoorDefinition.position: Vector3Like
DoorDefinition.rotationY: number
DoorDefinition.width: number
DoorDefinition.height: number
DoorDefinition.thickness: number
DoorDefinition.kind: 'plain' | 'locked'
DoorDefinition.keyId?: string
DoorDefinition.animation: 'hinge' | 'slide' | 'dissolve'
DoorDefinition.maxOpenAngleDeg?: number
DoorDefinition.assetId?: string
DoorDefinition.color?: string
DoorDefinition.autoOpenRadius?: number
interface KeyItemDefinition — A key pickup definition for the data-driven dungeon door system
KeyItemDefinition.id: string
KeyItemDefinition.keyId: string
KeyItemDefinition.levelId?: string
KeyItemDefinition.name: string
KeyItemDefinition.position: Vector3Like
KeyItemDefinition.assetId?: string
KeyItemDefinition.color?: string
interface WorldProfileData — World profile data stored in world.json
WorldProfileData.skyboxUrl?: string
WorldProfileData.thumbnailUrlOverride?: string
WorldProfileData.descriptionOverride?: string
WorldProfileData.faviconUrlOverride?: string
WorldProfileData.heightmapUrl?: string
WorldProfileData.characterHeight?: number
WorldProfileData.playerSpawnPosition?: Vector3Like
WorldProfileData.playerSpawnRotationY?: number
WorldProfileData.spawnPoints?: SpawnPoint[]
WorldProfileData.worldSeed?: number
WorldProfileData.useHighResCharacter?: boolean
WorldProfileData.useBlockCharacter?: boolean
WorldProfileData.characterUrl?: string
WorldProfileData.characterModelRotationY?: number
WorldProfileData.eyeLook?: VxlEyeLook
WorldProfileData.characterPoseVersion?: number
WorldProfileData.playerMovement?: { mode: 'ski' | 'boat'; ski?: Record<string, number | boolean>; boat?: Record<string, number | boolean>; }
WorldProfileData.persistentWorld?: boolean
WorldProfileData.vehicleNavGrid?: boolean
WorldProfileData.bloomConfig?: BloomConfig
WorldProfileData.renderConfig?: RenderConfig
WorldProfileData.fogConfig?: FogConfig
WorldProfileData.lightingConfig?: LightingConfig
WorldProfileData.dofConfig?: DofConfig
WorldProfileData.aoConfig?: AoConfig
WorldProfileData.groundCoverConfig?: GroundCoverConfig
WorldProfileData.weatherConfig?: WeatherConfig
WorldProfileData.animations?: AnimationDefinition[]
WorldProfileData.baseAnimations?: BaseAnimationDefinition[]
WorldProfileData.meleeWeaponAnimations?: BaseAnimationDefinition[]
WorldProfileData.combat?: CombatConfig
WorldProfileData.groundRenderingType?: 'smooth' | 'polygonal'
WorldProfileData.groundPolygonSize?: number
WorldProfileData.groundWorldSizeX?: number
WorldProfileData.groundWorldSizeZ?: number
WorldProfileData.groundYGranularity?: number
WorldProfileData.terrain?: { shape?: 'flat' | 'default' | 'none'; groundBlockType?: string; /** * How many BLOCKS of sub-surface fill below a flat plane's surface block * (default 3). The fill is clamped to the world's own floor, so a large * value simply means "solid to the bottom". Side-on 2D games set this * high: their side camera looks AT the terrain's cross-section, and a * three-block band with open sky underneath reads as a floating texture * strip rather than ground. */ fillDepthBlocks?: number; }
WorldProfileData.meshLevel?: { glbAssetId: string; levelAssetId?: string; spawnLandmark?: string; lighting?: 'interior' | 'exterior' | 'none'; }
WorldProfileData.groundConfig?: { surfaceBlockType?: string; subLayers?: string[]; }
WorldProfileData.customBlockTypes?: CustomBlockType[]
WorldProfileData.hotspots?: Hotspot[]
WorldProfileData.voxelBlockSize?: number
WorldProfileData.renderDistance?: number
WorldProfileData.vegetationRenderDistance?: number
WorldProfileData.cameraMode?: CameraMode
WorldProfileData.topDownFitWorld?: boolean
WorldProfileData.topDownFitWorldMargin?: number
WorldProfileData.topDownFitWorldRegion?: FitWorldRegion
WorldProfileData.topDownFitWorldBackground?: string
WorldProfileData.hasPlayerCharacter?: boolean
WorldProfileData.useFreeMouse?: boolean
WorldProfileData.mobileOrientation?: 'portrait' | 'landscape'
WorldProfileData.environmentObjectsGeneratedProcedurally?: boolean
WorldProfileData.markers?: Array<{ id: string; name: string; color: string; position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number }; }>
WorldProfileData.voxelUrl?: string
WorldProfileData.voxelTimestamp?: number
WorldProfileData.levels?: WorldLevel[]
WorldProfileData.startLevelId?: string
WorldProfileData.floorMeshUrl?: string
WorldProfileData.colliderUrl?: string
WorldProfileData.walkableUrl?: string
WorldProfileData.walkableFileSize?: number
WorldProfileData.pvsUrl?: string
WorldProfileData.pvsFileSize?: number
WorldProfileData.cameraPathUrl?: string
WorldProfileData.waterLevelY?: number
WorldProfileData.openWater?: OpenWaterConfig
WorldProfileData.hud?: { theme?: string | Record<string, unknown>; /** * The engine's touch pause button (top-right corner on phones; desktop uses * Escape and never shows it). `'auto'` (default) shows it; `'hidden'` removes * it and frees the `top-right` mobile button slot for the game's own actions. * * Hiding it removes the ONLY built-in way a phone reaches the pause card, and * with it Resume, the mute toggle and the graphics-quality row — so hide it * only in a game that opens the card itself: * `getGameStateManager().setPaused(true, 'manual')`. */ pauseButton?: 'auto' | 'hidden'; startScreen?: { /** Absolute or root-relative URL of the background image. */ imageUrl?: string; /** Title override; falls back to `gameData.gameName`. */ title?: string; /** Play-button label override; falls back to `t('game.menu.play')`. */ playLabel?: string; /** When true, hide the title (keeping its space so the Play button stays put) — for cover images that already include the game name. */ hideTitle?: boolean; /** Card placement: 'center' (default), 'start' (top in portrait / left in landscape) or 'end' (bottom / right). */ cardPlacement?: 'center' | 'start' | 'end'; /** * Pre-play selection steps shown on the main screen. Absent/empty = * no selections (the default for every existing game). Order matters: * a 'level' step is presented BEFORE the world loads (it decides what * to load); 'choice' steps are presented after loading, before Play. */ selections?: StartScreenSelection[]; /** * Where `imageUrl` came from — provenance for the share-link cover gate * (spec 2026-08-04). Stamped automatically by the creator's own write * path (`edit-world-config`); nothing else in the codebase sets it today, * so it can be absent or stale. The gate treats `'template'` as a hint, * not a veto — it re-checks the URL against the starter-template * defaults rather than trusting the flag, so staleness can't cause a * false block. */ imageSource?: 'template' | 'generated' | 'uploaded'; }; }
WorldProfileData.decalSystem?: { /** Maximum number of decals before recycling oldest (default: 1000) */ maxDecals?: number; /** Default decal size in meters (default: 0.15) */ decalSize?: number; /** Default color when not specified by projectile (hex, default: 0x111111 near-black) */ defaultColor?: number; /** Whether decals are enabled (default: true) */ enabled?: boolean; }
WorldProfileData.characterConfig?: CharacterConfig
WorldProfileData.combatConfig?: DeathCombatConfig
WorldProfileData.runtimeAI?: RuntimeAIConfig
WorldProfileData.networkSendRate?: number
WorldProfileData.mapAssetId?: string
WorldProfileData.achievements?: AchievementDefinition[]
WorldProfileData.doors?: DoorDefinition[]
WorldProfileData.keyItems?: KeyItemDefinition[]
interface RuntimeAIConfig — Configuration for the runtime AI service (used by AIService in game code).
RuntimeAIConfig.defaultSystemPrompt?: string
RuntimeAIConfig.defaultTemperature?: number
RuntimeAIConfig.defaultMaxTokens?: number
RuntimeAIConfig.timeoutMs?: number
RuntimeAIConfig.think?: boolean
RuntimeAIConfig.stream?: boolean
interface AssetLightEmitter — Light emission for placed instances of an asset (torches, braziers, lamps,
AssetLightEmitter.color?: string
AssetLightEmitter.intensity?: number
AssetLightEmitter.distance?: number
AssetLightEmitter.offset?: Vector3Like
AssetLightEmitter.flicker?: boolean
AssetLightEmitter.part?: string
type AssetProductionMethod = 'procedural' | 'generated' | 'uploaded'
interface AssetProduction — An asset's production record: the method, and enough input to re-run it.
AssetProduction.method: AssetProductionMethod
AssetProduction.at?: string
AssetProduction.spec?: Record<string, unknown>
AssetProduction.prompt?: string
AssetProduction.sourceUrl?: string
AssetProduction.sourceName?: string
type MaterialClassifier = 'agent' | 'ai' | 'manual' | 'heuristic'
interface AssetMaterials — An asset's material-class provenance.
AssetMaterials.classifier: MaterialClassifier
AssetMaterials.slots: string[]
AssetMaterials.at?: string
AssetMaterials.model?: string
interface Asset
Asset.id: string
Asset.name: string
Asset.url: string
Asset.type: string
Asset.screenshotUrl?: string
Asset.size?: number
Asset.lodVariants?: Array<{ drop: number; url: string; size?: number; rawSize?: number }>
Asset.voxelSize?: number
Asset.opacityThreshold?: number
Asset.voxelizeMode?: 'center' | 'coverage'
Asset.voxelizeSettings?: { roundedEdges?: boolean }
Asset.shadowCatcher?: boolean
Asset.shadowCatcherYOffset?: number
Asset.boundingBoxInMeters?: boolean
Asset.flattenTerrain?: boolean
Asset.flattenMargin?: number
Asset.collision?: boolean
Asset.colliderShape?: 'box' | 'sphere'
Asset.light?: AssetLightEmitter
Asset.lights?: AssetLightEmitter[]
Asset.boundingBox?: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number; }
Asset.voxelCount?: number
Asset.fitBox?: { x: number; z: number; height: number }
Asset.description?: string
Asset.placeholder?: boolean
Asset.sourceGlbUrl?: string
Asset.sourceModelUrl?: string
Asset.sourceVxlMasterUrl?: string
Asset.sourceVxlMasterResolution?: number
Asset.voxelEdited?: boolean
Asset.production?: AssetProduction
Asset.materials?: AssetMaterials
Asset.vxlUrl?: string
Asset.sourceGlbType?: string
Asset.targetHeight?: number
Asset.glbDimensions?: { width: number; height: number; depth: number }
Asset.colliderUrl?: string
Asset.colliderType?: 'mesh' | 'voxel'
Asset.vehicleFitment?: VehicleAssetFitment
Asset.smartObject?: SmartObjectFitment
Asset.sourceHfvxUrl?: string
Asset.splatCount?: number
Asset.denormScale?: number
Asset.centerY?: number
Asset.source?: 'generated' | 'uploaded' | 'library'
Asset.librarySid?: string
Asset.duration?: number
Asset.prompt?: string
Asset.origin?: 'video'
Asset.locomotionState?: 'idle' | 'walk' | 'run'
Asset.sourceVideoUrl?: string
Asset.trimmedStartSeconds?: number
Asset.trimmedEndSeconds?: number
Asset.designSpeed?: number
Asset.cropBounds?: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }
Asset.cleanupBounds?: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }
Asset.navUrl?: string
Asset.worldForgerMarkers?: ForgedLevelMarkers
Asset.worldForgerFeatures?: ForgedLevelFeature[]
Asset.worldForgerMovement?: { effective?: Record<string, unknown> }
Asset.worldForgerStreetGraph?: ForgedStreetGraph
Asset.worldForgerUserPrompt?: string
Asset.worldForgerSpec?: Record<string, unknown>
Asset.worldForgerJobId?: string
interface ForgedStreetGraph — The `worldForgerStreetGraph` payload persisted on a forged city level asset.
ForgedStreetGraph.nodes: Array<{ id: number; x: number; z: number }>
ForgedStreetGraph.segments: Array<{ a: number; b: number; width: number; kind: 'avenue' | 'street' | 'diagonal' | 'bridge' }>
interface ForgedLevelMarkers
ForgedLevelMarkers.playerStart?: { x: number; y: number; z: number }
ForgedLevelMarkers.named?: Array<{ name?: string; x: number; y: number; z: number }>
interface ForgedLevelFeature — One entry of `worldForgerFeatures`. Deliberately loose: `kind` is an open
ForgedLevelFeature.kind?: string
ForgedLevelFeature.name?: string
ForgedLevelFeature.description?: string
ForgedLevelFeature.points?: Array<{ x: number; y: number; z: number }>
ForgedLevelFeature.params?: Record<string, unknown>
ForgedLevelFeature.anchors?: Array<{ name?: string; x: number; y: number; z: number }>
ForgedLevelFeature.archetypeAnchors?: Array<{ name?: string; instances: number; centroid: { x: number; y: number; z: number } }>
ForgedLevelFeature.widthM?: number
ForgedLevelFeature.lengthM?: number
ForgedLevelFeature.closed?: boolean
ForgedLevelFeature.start?: { x: number; y: number; z: number }
ForgedLevelFeature.finish?: { x: number; y: number; z: number }
ForgedLevelFeature.checkpoints?: Array<{ x: number; y: number; z: number; t: number }>
ForgedLevelFeature.surfaceObjectName?: string
interface GameData
GameData.gameId?: string
GameData.gameGenre: string
GameData.characterUrl: string
GameData.gameName: string
GameData.gameDescription: string
GameData.thumbnailUrl: string
GameData.environmentObjectsGeneratedProcedurally?: boolean
GameData.gameDimension?: '2d' | '3d'
GameData.physicsMode?: '2d' | '3d'
GameData.physics2d?: boolean
GameData.artStyle?: 'voxel' | 'low-poly'
GameData.worldProfileData?: WorldProfileData
GameData.assets?: Asset[]
GameData.environmentObjects?: any[]
GameData.mechanisms?: Array<Record<string, unknown>>
function mergeGameData(metadata: GameMetadata | null, worldData: Partial<GameData>): GameData
function extractMetadataFromWorldData(gameData: GameData): GameMetadata | null
function getAssetUrlByName(gameData: GameData | null, assetName: string): string | null
function getAssetUrlById(gameData: GameData | null, assetId: string): string | null
function resolveNpcCharacterUrl(options: { characterUrl?: string; characterAssetId?: string } | undefined, gameData: GameData | null): string | null
function getAssetUrl(gameData: GameData | null, assetId?: string, assetName?: string): string | null
function loadJsonAsset<T = unknown>(gameData: GameData | null, assetName: string): Promise<T | null>
interface BoxColliderData
BoxColliderData.id: string
BoxColliderData.position: Vector3Like
BoxColliderData.scale: Vector3Like
BoxColliderData.rotation: number
BoxColliderData.color?: number
interface HeightmapData
HeightmapData.width: number
HeightmapData.height: number
HeightmapData.minX: number
HeightmapData.maxX: number
HeightmapData.minZ: number
HeightmapData.maxZ: number
HeightmapData.minY: number
HeightmapData.maxY: number
HeightmapData.heights: number[]
interface ProjectileLike
ProjectileLike.getRigidBody: () => RAPIER.RigidBody | null
ProjectileLike.getPosition?: () => THREE.Vector3
ProjectileLike.getDirection?: () => THREE.Vector3
ProjectileLike.getDamage?: () => number
ProjectileLike.getKnockback?: () => number
interface PlayerControllerLike
PlayerControllerLike.enforceCharacterSeparation?(): void
PlayerControllerLike.setPosture?(posture: string): boolean
PlayerControllerLike.getPosture?(): string
PlayerControllerLike.setCoverPeek?(peek: boolean): void
PlayerControllerLike.tryGrabLedge?(): boolean
PlayerControllerLike.mantle?(): boolean
PlayerControllerLike.vault?(): boolean
PlayerControllerLike.getUp?(): boolean
PlayerControllerLike.slide?(): boolean
PlayerControllerLike.getProjectiles: () => ProjectileLike[]
PlayerControllerLike.removeProjectile: (projectile: ProjectileLike) => void
PlayerControllerLike.getActiveVehicle?: () => any | null
PlayerControllerLike.isPlayerInVehicle?: () => boolean
PlayerControllerLike.exitVehicle?: () => boolean
PlayerControllerLike.getPosition?: () => THREE.Vector3
PlayerControllerLike.getCurrentSpeed?: () => number
PlayerControllerLike.getGroundPosition?: () => THREE.Vector3
PlayerControllerLike.getCapsuleRadius?: () => number
PlayerControllerLike.getCapsuleHeight?: () => number
PlayerControllerLike.teleportTo?: (x: number, y: number, z: number, rotationY?: number) => void
PlayerControllerLike.reassertMovementContract?: () => void
PlayerControllerLike.getPlayerObject?: () => THREE.Object3D | null
PlayerControllerLike.syncVisibleBody?: () => void
PlayerControllerLike.takeDamage?: (amount: number, source?: string) => void
PlayerControllerLike.setCameraController?: (controller: { getForwardVector: () => THREE.Vector3; getRightVector: () => THREE.Vector3; getCamera: () => THREE.PerspectiveCamera }) => void
PlayerControllerLike.setPlayerEnabled?: (enabled: boolean) => void
PlayerControllerLike.isPlayerEnabled?: () => boolean
PlayerControllerLike.setMobilePreviewMode?: (enabled: boolean, config?: Record<string, unknown>) => void
PlayerControllerLike.getMobilePreviewMode?: () => boolean
PlayerControllerLike.isMiningActive?: () => boolean
PlayerControllerLike.setLidControlEnabled?: (enabled: boolean) => void
interface BloomConfig
BloomConfig.enabled: boolean
BloomConfig.strength?: number
BloomConfig.radius?: number
BloomConfig.threshold?: number
type ToneMappingMode = 'aces' | 'neutral' | 'reinhard' | 'linear' | 'cineon'
type VehicleFinishMode = 'flat' | 'paint'
interface InkOutlineConfig — Scene-wide black "ink" outline — the load-bearing half of the Borderlands look
InkOutlineConfig.enabled: boolean
InkOutlineConfig.color?: string
InkOutlineConfig.thickness?: number
InkOutlineConfig.normalThreshold?: number
InkOutlineConfig.depthThreshold?: number
InkOutlineConfig.strength?: number
interface PosterizeConfig — Final-image posterize — the tonal half of the comic look, companion to
PosterizeConfig.enabled: boolean
PosterizeConfig.levels?: number
PosterizeConfig.strength?: number
interface RenderConfig
RenderConfig.toneMapping?: ToneMappingMode
RenderConfig.exposure?: number
RenderConfig.shadowDistance?: number
RenderConfig.shadowMapSize?: number
RenderConfig.vehicleFinish?: VehicleFinishMode
RenderConfig.inkOutline?: InkOutlineConfig
RenderConfig.posterize?: PosterizeConfig
RenderConfig.colorGrading?: ColorGradingConfig
RenderConfig.vignette?: VignetteConfig
interface ColorGradingConfig — Final-image color grade, applied AFTER tone mapping on the displayed 0..1
ColorGradingConfig.enabled: boolean
ColorGradingConfig.brightness?: number
ColorGradingConfig.contrast?: number
ColorGradingConfig.saturation?: number
ColorGradingConfig.temperature?: number
ColorGradingConfig.tint?: number
ColorGradingConfig.lift?: [number, number, number]
ColorGradingConfig.gamma?: [number, number, number]
ColorGradingConfig.gain?: [number, number, number]
interface VignetteConfig — Darkened (or tinted) screen edges. Runtime: `engine.setVignette()`.
VignetteConfig.enabled: boolean
VignetteConfig.intensity?: number
VignetteConfig.radius?: number
VignetteConfig.softness?: number
VignetteConfig.color?: string
interface FogConfig
FogConfig.enabled?: boolean
FogConfig.color?: string
FogConfig.near?: number
FogConfig.far?: number
interface LightingConfig
LightingConfig.preset?: 'stylized-day' | 'golden-hour' | 'overcast-forest' | 'moonlit-street'
LightingConfig.ambientColor?: string
LightingConfig.sunIntensity?: number
LightingConfig.sunColor?: string
LightingConfig.sunElevationDeg?: number
LightingConfig.sunAzimuthDeg?: number
LightingConfig.environmentIntensity?: number
LightingConfig.skyboxIntensity?: number
LightingConfig.ambientFloor?: number
interface OpenWaterConfig — Open-water world: the whole playable surface is an animated stylized ocean,
OpenWaterConfig.seaLevelY?: number
OpenWaterConfig.preset?: 'calm' | 'ocean' | 'storm'
OpenWaterConfig.amplitudeScale?: number
OpenWaterConfig.windDirectionDeg?: number
OpenWaterConfig.sky?: boolean
OpenWaterConfig.skyHorizon?: number
OpenWaterConfig.skyZenith?: number
OpenWaterConfig.palette?: Record<string, number>
interface WeatherConfig — Weather — precipitation and the surface response it drives. One config feeds
WeatherConfig.precipitation?: 'none' | 'rain'
WeatherConfig.intensity?: number
WeatherConfig.wind?: { x: number; z: number }
WeatherConfig.wetness?: number
WeatherConfig.puddles?: number
WeatherConfig.reflections?: 'ssr' | 'env'
WeatherConfig.reflectionStrength?: number
WeatherConfig.reflectionHighlight?: number
WeatherConfig.reflectionStreak?: number
WeatherConfig.reflectionDistance?: number
WeatherConfig.filmGloss?: number
WeatherConfig.surfaceDarkening?: number
WeatherConfig.envSheen?: number
WeatherConfig.rippleStrength?: number
WeatherConfig.spray?: boolean
WeatherConfig.trailStrength?: number
interface DofConfig
DofConfig.enabled?: boolean
DofConfig.focus?: number
DofConfig.aperture?: number
DofConfig.maxblur?: number
interface GroundCoverConfig — Runtime ground cover on a FORGED (.vwld) level — the grass/pebbles the engine
GroundCoverConfig.density?: number
GroundCoverConfig.scale?: number
GroundCoverConfig.distance?: number
interface AoConfig
AoConfig.enabled?: boolean
AoConfig.intensity?: number
AoConfig.radius?: number
AoConfig.scale?: number
interface CharacterConfig — Character configuration
CharacterConfig.height?: number
CharacterConfig.runSpeed?: number
interface DeathCombatConfig — Death behaviour (ragdoll vs explode), read where damageable entities are set up.
DeathCombatConfig.ragdollOnDeath?: boolean
DeathCombatConfig.ragdollJointLimits?: boolean
DeathCombatConfig.ragdollSelfCollision?: boolean
type BlockCharacterFactoryType = import('../engine/IBlockCharacterFactory.js').IBlockCharacterFactory
type CharacterModificationsFunction = ( player: THREE.Object3D, playerController: PlayerControllerLike, playerLoader: import('../engine/loaders/PlayerLoader.js').PlayerLoader, blockCharacterRenderer: import('../engine/BlockCharacterRenderer.js').BlockCharacterRenderer ) => void
interface CameraControllerLike
CameraControllerLike.disableBuiltInTouchControls?: boolean
CameraControllerLike.disableBuiltInMouseControls?: boolean
CameraControllerLike.applyExternalDelta?: (deltaX: number, deltaY: number) => void
CameraControllerLike.setAutoFollow?: (enabled: boolean, speed?: number) => void
CameraControllerLike.setTargetForwardDirection?: (direction: THREE.Vector3 | null) => void
CameraControllerLike.setExternalOrbitDrive?: (enabled: boolean) => void
CameraControllerLike.driveOrbit?: (theta: number, phi: number, radius?: number, snap?: boolean) => void
CameraControllerLike.setTarget?: (target: THREE.Object3D) => void
CameraControllerLike.setEnabled?: (enabled: boolean) => void
interface EnvironmentMeshUserData
EnvironmentMeshUserData.environmentInstanceId?: number
EnvironmentMeshUserData.isEnvironmentInstance?: boolean
EnvironmentMeshUserData.environmentType?: string
EnvironmentMeshUserData.scale?: { width: number; height: number; depth: number }
interface RockGeometryUserData
RockGeometryUserData.rockScale?: { width: number; height: number; depth: number }
interface EngineLike
EngineLike.container: HTMLElement
EngineLike.scene: THREE.Scene | null
EngineLike.camera: THREE.PerspectiveCamera | THREE.OrthographicCamera | null
EngineLike.getDefaultCamera(): THREE.PerspectiveCamera
EngineLike.setRenderCamera(cam: THREE.PerspectiveCamera | THREE.OrthographicCamera): void
EngineLike.setSolidBackground(color: string | null): void
EngineLike.isSolidBackgroundActive(): boolean
EngineLike.getSkyColorHex(): string
EngineLike.getLightingConfig?: () => LightingConfig | null
EngineLike.applyLightingConfig?: (config?: LightingConfig | null) => void
EngineLike.applyFogConfig?: (config?: FogConfig | null) => void
EngineLike.getRenderConfig?: () => RenderConfig | null
EngineLike.setColorGrading?: (config: Partial<ColorGradingConfig>) => void
EngineLike.setVignette?: (config: Partial<VignetteConfig>) => void
EngineLike.renderer: (THREE.WebGLRenderer & { domElement: HTMLElement }) | null
EngineLike.physicsWorld: import('../engine/physics/PhysicsWorld.js').PhysicsWorld | null
EngineLike.getGameplayPlaneZ?(): number | null
EngineLike.getPlaneLockedPhysics?(): import('../engine/physics/PlaneLockedPhysics.js').PlaneLockedPhysics | null
EngineLike.getMechanismSystem?(): import('../engine/MechanismSystem.js').MechanismSystem | null
EngineLike.getSmartObjectSystem?(): import('../engine/SmartObjectSystem.js').SmartObjectSystem | null
EngineLike.getSpawnPoints?(type?: string): SpawnPoint[]
EngineLike.getOceanSurface?(): import('../engine/water/OceanSurface.js').OceanSurface | null
EngineLike.physicsWorld2D?: import('../engine/physics/PhysicsWorld2D.js').PhysicsWorld2D | null
EngineLike.genreModule: import('../engine/GenreRegistry.js').GenreGameInterface | null
EngineLike.loader: any
EngineLike.clock: import('../engine/FrameTimer.js').LegacyClock
EngineLike.editorManager: any
EngineLike.gameStateManager?: any
EngineLike.isWindowFocused: boolean
EngineLike.isGaussianSplatMode: boolean
EngineLike.gaussianSplatRenderer?: any
EngineLike.gaussianSplatRenderers?: any[]
EngineLike.getWorldHeightAt?: (x: number, z: number) => number
EngineLike.getWorldCenter?: () => THREE.Vector3
EngineLike.resolveGroundPlacement: ( x: number, z: number, options?: Partial<import('../engine/GroundPlacement.js').GroundPlacementOptions>, ) => import('../engine/GroundPlacement.js').GroundPlacement
EngineLike.findValidVoxelSpawnPosition?: (x: number, z: number, fromY?: number) => THREE.Vector3 | null
EngineLike.recreateRenderer?: (antialias: boolean, type?: 'webgl' | 'webgpu') => void
EngineLike.registerPlayerController: (playerController: PlayerControllerLike) => void
EngineLike.getPlayerController: () => PlayerControllerLike | null
EngineLike.registerBeforeRender?: (callback: () => void) => () => void
EngineLike.getViewModelLayer?: () => import('engine/ViewModelLayer.js').ViewModelLayer | null
EngineLike.getActiveVehicle?: () => any | null
EngineLike.enableBloomOnObject?: (object: THREE.Object3D) => void
EngineLike.preloadLevel?: (opts?: { audioAssetIds?: string[] }) => Promise<void>
EngineLike.preloadPlayerCharacter?: () => Promise<void>
EngineLike.preloadNpcSkeleton?: () => Promise<void>
EngineLike.preloadAudio?: (idsOrUrls: string[]) => Promise<void>
EngineLike.warmUpScene?: (reveal?: THREE.Object3D[]) => Promise<boolean>
EngineLike.onSceneWarmedUp?: (cb: () => void) => void
EngineLike.getVehicleManager?: () => import('../engine/VehicleManager.js').VehicleManager | null
EngineLike.setVehicleManager?: (manager: import('../engine/VehicleManager.js').VehicleManager) => void
EngineLike.getVehicleSpawner?: () => import('../engine/VehicleSpawner.js').VehicleSpawner | null
EngineLike.setVehicleSpawner?: (spawner: import('../engine/VehicleSpawner.js').VehicleSpawner) => void
EngineLike.getSpawner?: () => import('../engine/Spawner.js').Spawner | null
EngineLike.setSpawner?: (spawner: import('../engine/Spawner.js').Spawner) => void
EngineLike.getPlayerLoader?: () => import('../engine/loaders/PlayerLoader.js').PlayerLoader | null
EngineLike.setPlayerLoader?: (loader: import('../engine/loaders/PlayerLoader.js').PlayerLoader) => void
EngineLike.getPlayerVisibility: () => import('../engine/PlayerVisibility.js').PlayerVisibility
EngineLike.blockCharacterFactory?: BlockCharacterFactoryType
EngineLike.applyCharacterModifications?: CharacterModificationsFunction
EngineLike.getGameData?: () => GameData | null
EngineLike.getAnimalRegistry?: () => import('../engine/animal/AnimalRegistry.js').AnimalRegistry
EngineLike.getDynamicObjectManager?: () => import('../engine/DynamicObjectManager.js').DynamicObjectManager
EngineLike.getNpcRegistry?: () => import('../engine/npc/core/NpcRegistry.js').NpcRegistry | null
EngineLike.setNpcRegistry?: (registry: import('../engine/npc/core/NpcRegistry.js').NpcRegistry) => void
EngineLike.registerNpc: ( name: string, behavior: import('../engine/npc/INpcBehavior.js').INpcBehavior, options?: import('../engine/npc/core/NpcRegistry.js').RegisterNpcOptions, ) => import('../engine/npc/core/NpcHandle.js').NpcHandle
EngineLike.startGame?: () => void
EngineLike.endGame: (options?: Partial<import('../engine/ui/EndScreen.js').EndGameOptions>) => void
EngineLike.setPlayButtonVisible?: (visible: boolean) => void
EngineLike.setStartupUiMode?: (mode: StartupUiMode) => void
EngineLike.getPreGameSelections?: () => Record<string, string>
EngineLike.playVideo?: (assetId: string, options?: { skippable?: boolean; fadeIn?: number; fadeOut?: number }) => Promise<void>
EngineLike.isRecordingFrames?: () => boolean
EngineLike.logGameEvent(event: import('../engine/recording/GameEventLog.js').GameEventInput): void
EngineLike.logSoundEvent(name: string, recipe?: import('../engine/recording/GameEventLog.js').SynthSoundRecipe): void
EngineLike.playSound(assetId: string, opts?: { volume?: number }): void
EngineLike.playMusic(assetId: string, opts?: { loop?: boolean; fadeIn?: number; volume?: number }): Promise<void>
EngineLike.stopMusic(opts?: { fadeOut?: number }): Promise<void>
EngineLike.setAudioVolume(opts: { master?: number; sfx?: number; music?: number }): void
EngineLike.getAudioContext?(): AudioContext | null
EngineLike.getAudioDestination?(): AudioNode | null
EngineLike.enableMuteControl?(): void
EngineLike.isAudioUsed?(): boolean
EngineLike.isAudioMuted?(): boolean
EngineLike.setAudioMuted?(muted: boolean): void
EngineLike.onAudioMuteChange?(cb: (muted: boolean) => void): () => void
EngineLike.setMuteHotkeyEnabled?(enabled: boolean): void
EngineLike.getDeltaTime?: () => number
EngineLike.getAmbienceTime?: () => number
EngineLike.getPointerLockManager?: () => import('../engine/PointerLockManager.js').PointerLockManager | null
EngineLike.setPointerLockManager?: (manager: import('../engine/PointerLockManager.js').PointerLockManager) => void
EngineLike.enterInteractiveUI?: () => void
EngineLike.exitInteractiveUI?: () => void
EngineLike.getAIService?: () => import('../engine/AIService.js').AIService
EngineLike.getVoiceInput?: () => import('../engine/VoiceInput.js').VoiceInput
EngineLike.enablePushToTalk?: ( onTranscript: (text: string) => void, options?: Partial<import('../engine/PushToTalk.js').PushToTalkOptions>, ) => void
EngineLike.getScreenshotService?: () => import('../engine/ScreenshotService.js').ScreenshotService
EngineLike.getGamePersistence?: () => import('../engine/persistence/GamePersistence.js').GamePersistence
EngineLike.getGameDataService?: () => import('../engine/gamedata/GameDataService.js').GameDataService
EngineLike.getGhostRacing?: () => import('../engine/replay/GhostRacing.js').GhostRacing
EngineLike.getLeaderboardIdentity?: () => Promise<import('../engine/replay/GhostIdentity.js').LeaderboardIdentity>
EngineLike.publishLeaderboard?: ( declaration: import('../engine/gamedata/LeaderboardManifest.js').LeaderboardDeclaration, ) => Promise<void>
EngineLike.unlockAchievement?(id: string): void
EngineLike.getDoorSystem?(): import('../engine/doors/DoorSystem.js').DoorSystem | null
EngineLike.blocks: import('../engine/BlockRegistry.js').BlockRegistry
EngineLike.getWorldGroup(): THREE.Object3D
EngineLike.addToWorld?: (...objects: THREE.Object3D[]) => void
EngineLike.spawnAsset?: ( assetIdOrName: string, options?: Partial<import('../engine/AssetSpawner.js').SpawnAssetOptions>, ) => Promise<import('../engine/AssetSpawner.js').SpawnedAsset | null>
EngineLike.loadGaussianSplat?: (url: string, config?: { position?: Vector3Like; eulerAngles?: Vector3Like; scale?: Vector3Like; }) => Promise<any>

## types/interactable.ts
interface Interactable — Interface for objects that can be interacted with by the player
Interactable.onInteractStart(): boolean
Interactable.onInteractEnd?(): void
Interactable.getInteractStartDisplayName(): string
Interactable.getInteractEndDisplayName?(): string
Interactable.interactionEnabled?(): boolean
Interactable.isActionable?(): boolean
Interactable.isFollowingPlayer?(): boolean

## types/smartObject.ts
type GridVec3 = [number, number, number]
interface GridBox
GridBox.min: GridVec3
GridBox.max: GridVec3
type SmartObjectMotion = | { kind: 'spin'; axis: GridVec3; rpm: number } /** Hangs from a hinge on its parent and stays level while the parent turns (a ferris-wheel cabin). */ | { kind: 'upright' } | { kind: 'pendulum'; axis: GridVec3; amplitudeDeg: number; periodS: number } | { kind: 'none' }
interface SmartObjectSpecPart
SmartObjectSpecPart.name: string
SmartObjectSpecPart.parent?: string
SmartObjectSpecPart.box: GridBox
SmartObjectSpecPart.exclude?: GridBox[]
SmartObjectSpecPart.pivot: GridVec3
SmartObjectSpecPart.motion: SmartObjectMotion
SmartObjectSpecPart.voxelCount?: number
interface SmartObjectSpecLight
SmartObjectSpecLight.name: string
SmartObjectSpecLight.position: GridVec3
SmartObjectSpecLight.color: string
SmartObjectSpecLight.intensity?: number
SmartObjectSpecLight.distance?: number
SmartObjectSpecLight.flicker?: boolean
SmartObjectSpecLight.part?: string
interface SmartObjectSpec — The Forger's verdict, in master grid space. See the file header.
SmartObjectSpec.version: 1
SmartObjectSpec.grid: number
SmartObjectSpec.bounds?: GridBox
SmartObjectSpec.object?: string
SmartObjectSpec.parts: SmartObjectSpecPart[]
SmartObjectSpec.lights: SmartObjectSpecLight[]
SmartObjectSpec.minComponentFraction?: number
SmartObjectSpec.warnings?: string[]
SmartObjectSpec.notes?: string
SmartObjectSpec.model?: string
interface SmartObjectPartFitment — One part as the runtime sees it: pivot in metres, in the asset's own frame.
SmartObjectPartFitment.name: string
SmartObjectPartFitment.parent?: string
SmartObjectPartFitment.pivot: Vector3Like
SmartObjectPartFitment.motion: SmartObjectMotion
interface SmartObjectFitment — Derived at bake and consumed by `SmartObjectSystem`. Lights are not here:
SmartObjectFitment.version: 1
SmartObjectFitment.parts: SmartObjectPartFitment[]
SmartObjectFitment.source?: SmartObjectSpec
interface SmartPropPartSpec — What a placeholder declares about itself, in its authored frame — the
SmartPropPartSpec.name: string
SmartPropPartSpec.parent?: string
SmartPropPartSpec.motion: SmartObjectMotion
SmartPropPartSpec.pivot?: Vector3Like
interface SmartPropLightSpec
SmartPropLightSpec.name: string
SmartPropLightSpec.part?: string
SmartPropLightSpec.position?: Vector3Like
SmartPropLightSpec.color: string
SmartPropLightSpec.intensity?: number
SmartPropLightSpec.distance?: number
SmartPropLightSpec.flicker?: boolean
interface SmartPropSpec
SmartPropSpec.parts: SmartPropPartSpec[]
SmartPropSpec.lights?: SmartPropLightSpec[]

## types/vehicle-extension.ts
interface VehicleKeyState — Key input state passed to extension callbacks
VehicleKeyState.forward: boolean
VehicleKeyState.backward: boolean
VehicleKeyState.left: boolean
VehicleKeyState.right: boolean
VehicleKeyState.ascend: boolean
VehicleKeyState.descend: boolean
VehicleKeyState.action: boolean
interface VehicleControlsExtension — Extension interface for custom vehicle controls.
VehicleControlsExtension.onAscendPressed?: (vehicle: Vehicle, deltaTime: number) => boolean
VehicleControlsExtension.onDescendPressed?: (vehicle: Vehicle, deltaTime: number) => boolean
VehicleControlsExtension.onActionPressed?: (vehicle: Vehicle, deltaTime: number) => boolean
VehicleControlsExtension.onUpdate?: (vehicle: Vehicle, deltaTime: number, keys: VehicleKeyState) => void
VehicleControlsExtension.onEnterVehicle?: (vehicle: Vehicle) => void
VehicleControlsExtension.onExitVehicle?: (vehicle: Vehicle) => void
VehicleControlsExtension.ascendDisplayName?: string
VehicleControlsExtension.descendDisplayName?: string
VehicleControlsExtension.actionDisplayName?: string
VehicleControlsExtension.ascendBehavior?: 'tap' | 'continuous'
VehicleControlsExtension.descendBehavior?: 'tap' | 'continuous'
VehicleControlsExtension.actionBehavior?: 'tap' | 'continuous'
VehicleControlsExtension.showAscend?: boolean
VehicleControlsExtension.showDescend?: boolean
VehicleControlsExtension.showAction?: boolean

## types/vehicleFitment.ts
type BmWheelStyle = 'steel' | 'alloy5' | 'alloy6' | 'lug' | 'moon' | 'classic'
interface VehicleFitmentAxle
VehicleFitmentAxle.z: number
VehicleFitmentAxle.y: number
VehicleFitmentAxle.radius: number
VehicleFitmentAxle.width: number
VehicleFitmentAxle.track: number
VehicleFitmentAxle.steering: boolean
VehicleFitmentAxle.driven: boolean
VehicleFitmentAxle.dual: boolean
VehicleFitmentAxle.wheelStyle: BmWheelStyle
interface VehicleFitmentBox
VehicleFitmentBox.position: { x: number; y: number; z: number }
VehicleFitmentBox.size: { x: number; y: number; z: number }
interface VehicleAssetFitment
VehicleAssetFitment.version: 1
VehicleAssetFitment.platform: { width: number; length: number }
VehicleAssetFitment.axles: VehicleFitmentAxle[]
VehicleAssetFitment.bodyBounds: { min: [number, number, number]; max: [number, number, number] }
VehicleAssetFitment.hasWheelNodes: boolean
VehicleAssetFitment.wheelsFromSpec?: boolean
VehicleAssetFitment.tireColor?: string
VehicleAssetFitment.collisionBoxes: VehicleFitmentBox[]
VehicleAssetFitment.mass: number
VehicleAssetFitment.handling?: { topSpeed?: number; accelerationScale?: number; maxSteerAngle?: number; downforce?: number }
VehicleAssetFitment.preferredVoxelSizeM?: number
VehicleAssetFitment.seat?: { x: number; y: number; z: number }
