# engine-api-levels

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/levels/LevelEngineBridge.ts
interface LevelEngineSurface — The slice of GameEngine the multi-level runtime needs. Only PUBLIC engine
LevelEngineSurface.scene: THREE.Scene | null
LevelEngineSurface.physicsWorld: PhysicsWorld | null
LevelEngineSurface.getDynamicObjectManager(): DynamicObjectManager
LevelEngineSurface.getPlayerController(): PlayerControllerLike | null
LevelEngineSurface.applyFogConfig(config?: FogConfig | null): void
LevelEngineSurface.applyLightingConfig(config?: LightingConfig | null): void
LevelEngineSurface.applyWeatherConfig(config?: WeatherConfig | null): void
LevelEngineSurface.applyWaterSurface(waterLevelY: number | null): void
LevelEngineSurface.fitShadowsToWorld(): void
LevelEngineSurface.getLightingConfig(): LightingConfig | null
LevelEngineSurface.refreshEnvironmentLights(): void
LevelEngineSurface.warmUpLoadedScene(onProgress: WarmupProgressFn): Promise<void>
LevelEngineSurface.registerBeforeRender(callback: () => void): () => void
LevelEngineSurface.noteQualityDisturbance(reason: string): void
class LevelEngineBridge — Engine-side wiring for LevelManager: builds its options against the public
LevelEngineBridge.constructor(engine: LevelEngineSurface, gameData: GameData)
LevelEngineBridge.createManager(): LevelManager
LevelEngineBridge.installNavmesh(levelId: string): Promise<void>
LevelEngineBridge.applyAtmosphere(profile: WorldProfileData | undefined): Promise<void>
LevelEngineBridge.noteBootSkybox(genreLoadedUrl: string | undefined, bootEffectiveUrl: string | undefined): void

## engine/levels/LevelManager.ts
interface LevelManagerOptions — Everything LevelManager touches in the engine goes through these injected
LevelManagerOptions.gameData: GameData
LevelManagerOptions.loadTerrain: (buffer: ArrayBuffer) => Promise<void>
LevelManagerOptions.settleTerrainUpload: () => Promise<void>
LevelManagerOptions.reloadSceneContent: (activeLevelId: string) => Promise<void>
LevelManagerOptions.applyAtmosphere: (effectiveProfile: WorldProfileData) => void | Promise<void>
LevelManagerOptions.setTransitionLock: (locked: boolean) => void | Promise<void>
LevelManagerOptions.noteQualityDisturbance: (reason: string) => void
LevelManagerOptions.respawnPlayer: (spawn: SpawnPoint | null) => void
LevelManagerOptions.warmUpScene: () => Promise<void>
LevelManagerOptions.sendLevelChange: ((levelId: string, spawnPointId?: string) => void) | null
LevelManagerOptions.installNavmesh: (levelId: string) => Promise<void>
LevelManagerOptions.reportSwitchProgress: (stage: LevelSwitchStage) => void
LevelManagerOptions.fetchBuffer?: (url: string) => Promise<ArrayBuffer>
type LevelSwitchStage = 'terrain' | 'objects' | 'navmesh' | 'atmosphere' | 'warmup'
interface LoadLevelOptions
LoadLevelOptions.spawnPointId?: string
LoadLevelOptions.networked?: boolean
function resolveLevelVwldAsset(gameData: GameData, level: WorldLevel): Asset
function shouldApplyBootNav(bootLevelId: string | undefined, activeLevelId: string | null): boolean
class LevelManager — Multi-level runtime: owns the active level id and the switch sequence.
LevelManager.constructor(options: LevelManagerOptions)
LevelManager.getActiveLevelId(): string
LevelManager.isLoading(): boolean
LevelManager.getLevels(): Array<{ id: string; name: string }>
LevelManager.getActiveLevel(): WorldLevel
LevelManager.isInActiveLevel(instance: { levelId?: string }): boolean
LevelManager.onLevelWillUnload(cb: (fromLevelId: string, toLevelId: string) => void): void
LevelManager.onLevelDidLoad(cb: (levelId: string) => void): void
LevelManager.onBeforeSceneContent(cb: (levelId: string) => Promise<void> | void): void
LevelManager.installNetworkHooks(send: (levelId: string, spawnPointId?: string) => void): void
LevelManager.prefetchLevel(levelId: string): Promise<void>
LevelManager.loadLevel(levelId: string, options: LoadLevelOptions = {}): Promise<void>

## engine/levels/envObjectTeardown.ts
interface EnvObjectTeardownParts — The EnvironmentObjectSystem internals a level-switch teardown touches.
EnvObjectTeardownParts.physicsWorld: PhysicsWorld | null
EnvObjectTeardownParts.objectStorage: Map<string, { instances: Array<{ voxelObject?: (THREE.Object3D & { dispose?: () => void }) | null }>; instancedMesh: THREE.InstancedMesh | null; unpackedMeshes: THREE.Mesh[]; }>
EnvObjectTeardownParts.lodStorage: Map<string, { meshes: THREE.InstancedMesh[]; shadowMesh: THREE.InstancedMesh | null }>
EnvObjectTeardownParts.chunkMeshes: Map<string, Map<string, THREE.InstancedMesh>>
EnvObjectTeardownParts.worldBodies: Array<{ isValid?: () => boolean }>
EnvObjectTeardownParts.chunkPhysicsBodies: Map<string, unknown[]>
EnvObjectTeardownParts.dynamicObjects: Array<{ dispose?: () => void }>
EnvObjectTeardownParts.individualObjects: Array<THREE.Object3D & { dispose?: () => void }>
function disposeSpawnedEnvObjectContent(parts: EnvObjectTeardownParts): number

## engine/levels/fetchNavSidecar.ts
function fetchNavSidecar(url: string): Promise<ArrayBuffer | null>

## engine/levels/fetchVwld.ts
function fetchVwldBuffer(url: string): Promise<ArrayBuffer>
function warmVwldCache(url: string): Promise<void>

## engine/levels/levelManagerRegistry.ts
function setActiveLevelManager(lm: LevelManager | null): void
function getActiveLevelManager(): LevelManager | null
function getActiveLevelIdOrNull(): string | null

## engine/levels/levelResolve.ts
interface ResolvedLevels
ResolvedLevels.levels: WorldLevel[]
ResolvedLevels.byId: Map<string, WorldLevel>
ResolvedLevels.startLevel: WorldLevel
function resolveLevels(gameData: GameData | null | undefined): ResolvedLevels | null
interface LoadGameOptions — Per-load options for `GameEngine.loadGame`. Optional param on a
LoadGameOptions.bootLevelId?: string
function applyBootLevelOverride(gameData: GameData, levelId: string): GameData
function isInstanceInActiveLevel(instance: { levelId?: string }, activeLevelId: string | null): boolean
function levelSpawnPoints(profile: WorldProfileData | undefined, level: WorldLevel | null): SpawnPoint[]
function mergeEffectiveProfile(profile: WorldProfileData, level: WorldLevel | null): WorldProfileData
function preferredLodDrop(): number
function selectVwldUrlForDevice(asset: Asset, drop: number): string

## engine/levels/terrainUploadFrame.ts
function uploadFrameEnabled(fallback: boolean): boolean
interface CullableTerrain — The slice of the terrain system this needs.
CullableTerrain.setBatchCulling(enabled: boolean): void
function drawTerrainUploadFrame(terrain: CullableTerrain, registerBeforeRender: (cb: () => void) => () => void): Promise<void>
