# engine-api-core-1

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/AIService.ts
interface AIModelOptions
AIModelOptions.systemPrompt?: string
AIModelOptions.maxTokens?: number
AIModelOptions.temperature?: number
AIModelOptions.timeoutMs?: number
AIModelOptions.think?: boolean
AIModelOptions.stream?: boolean
AIModelOptions.images?: string[]
interface AIModelResponse
AIModelResponse.text: string
AIModelResponse.model: string
AIModelResponse.provider: string
interface ImageGenerationOptions
ImageGenerationOptions.width?: number
ImageGenerationOptions.height?: number
ImageGenerationOptions.timeoutMs?: number
interface MeshGenerationOptions
MeshGenerationOptions.timeoutMs?: number
interface TranscriptionOptions
TranscriptionOptions.language?: string
TranscriptionOptions.timeoutMs?: number
interface TranscriptionResult
TranscriptionResult.text: string
TranscriptionResult.language?: string
class AIService
static AIService.getInstance(): AIService
AIService.configure(config: RuntimeAIConfig | undefined, gameId?: string): void
AIService.getConfig(): Readonly<Required<RuntimeAIConfig>>
AIService.setConfig(partial: RuntimeAIConfig): void
AIService.setWebLLMEnabled(enabled: boolean): void
AIService.callModel(prompt: string, options?: AIModelOptions): Promise<string>
AIService.callModelJSON<T = unknown>(prompt: string, options?: AIModelOptions): Promise<T>
AIService.generateImage(prompt: string, options?: ImageGenerationOptions): Promise<string>
AIService.transcribe(audio: Blob, options?: TranscriptionOptions): Promise<TranscriptionResult>
AIService.generateMesh(prompt: string, options?: MeshGenerationOptions): Promise<string>
AIService.decide<Q extends Record<string, DecisionQuestion>>(state: unknown, questions: Q, options?: DecisionOptions): Promise<DecisionsResult<Q>>

## engine/ActionSuppressionManager.ts
type SuppressibleAction = 'action' | 'secondaryAction' | 'interact' | 'ascend' | 'descend' | 'exit'
class ActionSuppressionManager
ActionSuppressionManager.suppressFor(seconds: number, actions?: SuppressibleAction[]): void
ActionSuppressionManager.apply(keys: Record<string, boolean>, desktopControls: DesktopControls, mobileControls: MobileControls, gamepadControls: GamepadControls): void

## engine/AssetBufferPrefetch.ts
const DEFAULT_PREFETCH_AHEAD = 3
function prefetchAheadFor(fallback: number): number
function prefetchVxlAssets(defsByType: Iterable<HasAssetId[]>, resolveAsset: (assetId: string) => AssetLike | null | undefined, resolveUrl: (url: string) => string, ahead: number = DEFAULT_PREFETCH_AHEAD): AssetBufferPrefetch
type BufferFetcher = (url: string) => Promise<ArrayBuffer | null>
class AssetBufferPrefetch
AssetBufferPrefetch.constructor(urls: string[], private readonly fetcher: BufferFetcher, private readonly ahead: number = DEFAULT_PREFETCH_AHEAD)
AssetBufferPrefetch.take(url: string): Promise<ArrayBuffer | null>
AssetBufferPrefetch.dispose(): void

## engine/AsyncConcurrency.ts
function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]>

## engine/AudioPlayer.ts
class AudioPlayer — Plays audio asset files (e.g. opus/ogg) via the Web Audio API.
AudioPlayer.constructor(camera: THREE.Camera)
AudioPlayer.playSound(url: string, opts?: { volume?: number }): void
AudioPlayer.playMusic(url: string, opts?: { loop?: boolean; fadeIn?: number; volume?: number }): Promise<void>
AudioPlayer.stopMusic(opts?: { fadeOut?: number }): Promise<void>
AudioPlayer.setVolume(opts: { master?: number; sfx?: number; music?: number }): void
AudioPlayer.getContext(): AudioContext
AudioPlayer.getInput(): AudioNode
AudioPlayer.setCamera(camera: THREE.Camera): void
AudioPlayer.dispose(): void
AudioPlayer.preload(url: string): Promise<void>

## engine/BloomDefaults.ts
function resolveBloomDefaults(genre: string, artStyle: string | undefined): BloomConfig

## engine/BmDebug.ts
const isEventLogRequested: boolean
interface BmDebugEntity — An entity as __bmDebug reports it — the JSON-safe projection of a registered object.
BmDebugEntity.id: string
BmDebugEntity.type: ObjectType
BmDebugEntity.name: string
BmDebugEntity.position: [number, number, number] | null
const DEFAULT_ENTITY_LIMIT = 100
function projectEvents(session: TimelineSession): TimelineGameEvent[]
function projectEntities(objects: RegisteredObject[], type?: ObjectType, limit: number = DEFAULT_ENTITY_LIMIT): BmDebugEntity[]
function installBmDebug(): void

## engine/ColorGradeNode.ts
interface ColorGradeParams — Fully-resolved grade. Every field neutral in {@link DEFAULT_COLOR_GRADING}.
ColorGradeParams.brightness: number
ColorGradeParams.contrast: number
ColorGradeParams.saturation: number
ColorGradeParams.temperature: number
ColorGradeParams.tint: number
ColorGradeParams.lift: [number, number, number]
ColorGradeParams.gamma: [number, number, number]
ColorGradeParams.gain: [number, number, number]
interface VignetteParams — Fully-resolved vignette.
VignetteParams.intensity: number
VignetteParams.radius: number
VignetteParams.softness: number
VignetteParams.color: string
const DEFAULT_COLOR_GRADING: ColorGradeParams
const DEFAULT_VIGNETTE: VignetteParams
function resolveColorGrading(cfg: ColorGradingConfig | null | undefined): ColorGradeParams
function resolveVignette(cfg: VignetteConfig | null | undefined): VignetteParams
class ColorGradeState — Live grade + vignette uniforms for BOTH backends. The engine owns one for its
ColorGradeState.brightness
ColorGradeState.contrast
ColorGradeState.saturation
ColorGradeState.whiteBalance
ColorGradeState.lift
ColorGradeState.invGamma
ColorGradeState.gain
ColorGradeState.vignetteIntensity
ColorGradeState.vignetteRadius
ColorGradeState.vignetteSoftness
ColorGradeState.vignetteColor
ColorGradeState.glUniforms
ColorGradeState.setGrade(p: ColorGradeParams | null): void
ColorGradeState.setVignette(p: VignetteParams | null): void
function applyColorGrade(displayColor: Vec4Node, s: ColorGradeState): Vec4Node
const COLOR_GRADE_FRAGMENT = ` uniform sampler2D tDiffuse; uniform float brightness; unif
const COLOR_GRADE_VERTEX = ` varying vec2 vUv; void main() { vUv = uv; gl_Position = pr

## engine/ConsoleCapture.ts
interface CapturedMessage
CapturedMessage.type: 'warn' | 'error'
CapturedMessage.message: string
CapturedMessage.timestamp: number
CapturedMessage.stack?: string
CapturedMessage.count: number
class ConsoleCapture — Singleton utility that captures console.warn, console.error, and exceptions.
static ConsoleCapture.getInstance(): ConsoleCapture
ConsoleCapture.start(): void
ConsoleCapture.getMessages(): CapturedMessage[]
ConsoleCapture.getErrorCount(): number
ConsoleCapture.getWarningCount(): number
ConsoleCapture.addListener(callback: () => void): void
ConsoleCapture.removeListener(callback: () => void): void

## engine/CreatorMode.ts
const isCreatorMode: boolean
const isStandaloneMode: boolean
const isPlaytestMode: boolean
const isAutostartRequested: boolean
function safePostMessageToCreator(message: any): void

## engine/CreatorPersistence.ts
function saveEnvObjectFields(envObjectId: string, fields: Record<string, unknown>, description?: string): Promise<boolean>
function saveWorldProfileField(field: string, value: unknown, description?: string): Promise<boolean>

## engine/CustomActionKeys.ts
interface CustomActionState — The per-action state slot `MobileControls.customActionEntries()` yields.
CustomActionState.pressed: boolean
CustomActionState.behavior: 'tap' | 'continuous'
function mergeCustomActionKeys(keys: Record<string, boolean>, entries: Iterable<[string, CustomActionState]>, mobileHeld: Set<string>, isKeyboardHeld: (action: string) => boolean = () => false): void

## engine/DebugController.ts
class DebugController — DebugController provides debug features that are only active in development.
DebugController.constructor(engine: EngineLike)
DebugController.addDebugMesh(mesh: THREE.Mesh): void
DebugController.getDebugMode(): boolean
DebugController.setGame(game: any): void
DebugController.dispose(): void

## engine/DebugManager.ts
class DebugManager — DebugManager handles debug-only functionality that should not be in production.
DebugManager.constructor(engine: EngineLike)
DebugManager.enableDebug(): void
DebugManager.disableDebug(): void
DebugManager.isDebugActive(): boolean
DebugManager.setCallbacks(callbacks: DebugCallbacks): void
DebugManager.onKeyDown(event: KeyboardEvent): boolean
DebugManager.isDebugInfoVisible(): boolean
DebugManager.setDebugInfoVisible(visible: boolean): void
DebugManager.dispose(): void

## engine/DecisionTypes.ts
type DecisionText = string | Record<string, unknown> | unknown[]
interface NoulQuestion — A yes/no question, answered with the probability of "yes".
NoulQuestion.type: 'noul'
NoulQuestion.instructions: DecisionText
NoulQuestion.criteria?: { true: DecisionText; false: DecisionText }
interface ChoiceQuestion<O extends string = string> — Pick one option; every option gets a probability and the winner is `choice`.
ChoiceQuestion.type: 'choice'
ChoiceQuestion.instructions: DecisionText
ChoiceQuestion.criteria: Record<O, DecisionText | null>
interface ScoreQuestion — Rate along ordered levels; `score` is probability-weighted and may land between levels.
ScoreQuestion.type: 'score'
ScoreQuestion.instructions: DecisionText
ScoreQuestion.criteria: DecisionText[]
type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion
interface NoulAnswer
NoulAnswer.type: 'noul'
NoulAnswer.noul: number
interface ChoiceAnswer<O extends string = string>
ChoiceAnswer.type: 'choice'
ChoiceAnswer.choice: O
ChoiceAnswer.probabilities: Record<O, number>
ChoiceAnswer.confidence: number
interface ScoreAnswer
ScoreAnswer.type: 'score'
ScoreAnswer.score: number
ScoreAnswer.legend: Record<string, DecisionText>
ScoreAnswer.probabilities: Record<string, number>
ScoreAnswer.confidence: number
type DecisionAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer
type DecisionAnswerFor<Q> = Q extends ChoiceQuestion<infer O> ? ChoiceAnswer<O> : Q extends ScoreQuestion ? ScoreAnswer : Q extends NoulQuestion ? NoulAnswer : never
type DecisionAnswers<Q extends Record<string, DecisionQuestion>> = { [K in keyof Q]: DecisionAnswerFor<Q[K]>; }
interface DecisionsUsage
DecisionsUsage.input_tokens: number
DecisionsUsage.output_tokens: number
DecisionsUsage.cost?: number
interface DecisionsResult<Q extends Record<string, DecisionQuestion>>
DecisionsResult.answers: DecisionAnswers<Q>
DecisionsResult.model: string
DecisionsResult.usage: DecisionsUsage
DecisionsResult.latencyMs: number
interface DecisionOptions
DecisionOptions.timeoutMs?: number
DecisionOptions.sessionId?: string
function choice<O extends string>(instructions: DecisionText, criteria: Record<O, DecisionText | null>): ChoiceQuestion<O>
function noul(instructions: DecisionText, criteria?: NoulQuestion['criteria']): NoulQuestion
function score(instructions: DecisionText, criteria: DecisionText[]): ScoreQuestion

## engine/DeviceQuality.ts
type DeviceQualityTier = 'ultra' | 'high' | 'medium' | 'low' | 'minimal'
type QualityPreference = 'auto' | DeviceQualityTier
const DEVICE_QUALITY_TIERS: readonly DeviceQualityTier[]
interface DeviceQualityPolicy — What a rung switches on, split by WHEN it can be applied.
DeviceQualityPolicy.live: { /** * Ceiling handed to `resolveRenderPixelRatio`. * * ⚠ A cap in CSS-PIXEL terms, not a fraction of the device ratio: `0.75` means * 0.75 device pixels per CSS pixel on every display, so on a dpr-3 phone that is * one SIXTEENTH of the pixels of ratio 3, not 75% of them. That is why `minimal` * is a rescue rung and why there is nothing between 2 and 0.75. `4` is effectively * uncapped — it matches `MAX_RENDER_PIXEL_RATIO` and no shipping display exceeds it. */ maxPixelRatio: number; /** Ceiling for `resolveShadowMapSize`. 0 means no sun shadows at all. */ shadowMapMaxSize: number; /** Multiplier on `EnvironmentObjectSystem.maxRenderDistance`. */ envRenderDistanceScale: number; /** Multiplier on `CharacterLodScheduler` ring distances and per-frame caps. */ characterLodScale: number; /** * Post-processing passes this rung allows. Each is still ALSO subject to the * per-game config and to its own correctness gates — an allowance here never turns * an effect on, it only declines to turn one off. */ postFx: { ssr: boolean; ao: boolean; dof: boolean; bloom: boolean }; }
DeviceQualityPolicy.deferred: { /** * Next material construction — already-built materials are not rebuilt. * * The phone band lands on 'medium', not 'low', for the reason that made it the * mobile default before the ladder existed: the medium tier's Phong lobe is * near-free per fragment and it is what keeps a stone cliff reading as stone on a * phone. 'low' is the rescue rung, and stays reachable via `?matq=low` and the * stored setting for a device where even a specular lobe is unwelcome. */ materialQuality: MaterialQuality; /** * Next level load. Composed with the crash-downgrade floor by MAX, never by sum — * see `resolveLevelDetail`. * * A phone still starts one tier down, as it did before the ladder; what the ladder * adds is that a *weak* phone can start further down than that. */ levelDetail: number; /** Finest baked env LODs never meshed at load. Next `VoxelObject` construction. */ envLodDrop: number; /** * Voxel level a rigged `.vxl` NPC body is built from — 0 the file's full detail, * 1 its coarser level (about 4.5× fewer triangles: a library townsperson is * ~105k triangles at 0 and ~23k at 1). Next character load. NPCs only: the * player's own body is seen close-up every frame and stays at 0 on every tier. * A file without the requested level falls back to the finest it has. */ characterBodyLod: number; /** Next warmup. */ warmup: WarmupMode; /** * Which `VxlSceneLoadBudget` to use. A SELECTOR, not the numbers — the measured * byte budgets stay next to their load/crash table in `VxlSceneTerrainSystem.ts` * so the evidence never drifts away from the constant it justifies. */ terrainBudget: 'full' | 'constrained'; /** The CPU-geometry upload frame between terrain and scenery. */ terrainUploadFrame: boolean; /** The per-chassis vehicle paint finish. */ vehiclePaint: boolean; /** * Cap on concurrent asset loads (fetch + decode), handed straight to * `mapWithConcurrency`. * * Weaker rungs get a smaller cap because the binding constraint there is **memory** * from decoding several assets at once (iOS Safari / Android Chrome kill the tab * under memory pressure), NOT the per-host connection count — the CDN is HTTP/2, * which multiplexes many requests over one connection. Tune the ladder, not call * sites. */ loadConcurrency: number; /** Downloads run ahead of the scenery build's consumer. */ prefetchAhead: number; }
const DEFAULT_DEVICE_QUALITY_TIER: DeviceQualityTier
type AutoTierReason = 'probe' | 'measure' | 'crash'
interface AutoTierRecord — The persisted conclusion of detection + measurement.
AutoTierRecord.v: 1
AutoTierRecord.tier: DeviceQualityTier
AutoTierRecord.reason: AutoTierReason
AutoTierRecord.at: number
AutoTierRecord.sig: string
AutoTierRecord.measurementVersion?: number
type DeviceQualitySource = 'url' | 'pinned' | 'auto' | 'default'
function deviceQualityPolicy(tier: DeviceQualityTier): DeviceQualityPolicy
function isDeviceQualityTier(value: string): value is DeviceQualityTier
function stepTier(tier: DeviceQualityTier, delta: number): DeviceQualityTier
function worseTier(a: DeviceQualityTier, b: DeviceQualityTier): DeviceQualityTier
function clampPolicyToDevice(p: DeviceQualityPolicy, isMobile: boolean): DeviceQualityPolicy
function readAutoDeviceTier(signature: string): AutoTierRecord | null
function setAutoDeviceTier(tier: DeviceQualityTier, reason: AutoTierReason, signature: string): void
function clearAutoDeviceTier(): void
function readQualityPreference(): QualityPreference
function qualityPreferenceEpoch(): number
function setQualityPreference(pref: QualityPreference): void
function resolveDeviceQualityTier(guess: DeviceQualityTier, signature: string): { tier: DeviceQualityTier; source: DeviceQualitySource }
function activeDeviceQualityTier(): DeviceQualityTier
function activeQualityPolicy(): DeviceQualityPolicy
function deviceQualitySource(): DeviceQualitySource
function activeDeviceSignature(): string
function activeMaterialQuality(): MaterialQuality
function adoptDeviceQualityTier(tier: DeviceQualityTier, source: 'auto' | 'pinned'): void
function refreshActiveDeviceQuality(): void

## engine/DeviceQualityGuess.ts
interface DeviceSignals — Everything the guess is allowed to look at, passed in rather than probed so every
DeviceSignals.isMobile: boolean
DeviceSignals.automation: boolean
DeviceSignals.webGpuAvailable: boolean
DeviceSignals.logicalCores: number | null
DeviceSignals.deviceMemoryGb: number | null
DeviceSignals.devicePixelRatio: number
DeviceSignals.screenMinCss: number
DeviceSignals.platform: 'ios' | 'android' | 'other'
DeviceSignals.iosMajorVersion: number | null
DeviceSignals.gpuRenderer: string | null
function guessStartingTier(s: DeviceSignals): DeviceQualityTier
function deviceSignature(s: DeviceSignals): string
function readDeviceSignals(isMobile: boolean): DeviceSignals

## engine/DriverPickupProbe.ts
const DRIVER_PICKUP_PROBE_PADDING = 0.5
interface DriverPickupProbeHalfExtents — Half-extents of the probe box before padding — normally the chassis half-size.
DriverPickupProbeHalfExtents.x: number
DriverPickupProbeHalfExtents.y: number
DriverPickupProbeHalfExtents.z: number
class DriverPickupProbe
DriverPickupProbe.constructor(physicsWorld: PhysicsWorld, chassisBody: RAPIER.RigidBody, halfExtents: DriverPickupProbeHalfExtents)
DriverPickupProbe.getColliderHandle(): number | null
DriverPickupProbe.dispose(): void

## engine/EditorViewMemory.ts
function saveEditorView(gameId: string | null, camera: THREE.Camera | null): void
function restoreEditorView(gameId: string | null, camera: THREE.Camera | null): boolean

## engine/FallRescue.ts
const DEFAULT_KILL_PLANE_Y = -100
const DEFAULT_VEHICLE_RESPAWN_LIFT = 1.0
interface FallRescueOptions
FallRescueOptions.killPlaneY: number
FallRescueOptions.vehicleRespawnLift: number
const DEFAULT_FALL_RESCUE_OPTIONS: FallRescueOptions
type VehicleRespawnPoint = ReturnType<VehicleRespawnProvider>
type FallRescueEvent = | { action: 'vehicle-respawned'; vehicle: Vehicle; position: { x: number; y: number; z: number }; heading: number | null } | { action: 'vehicle-destroyed'; vehicle: Vehicle; position: { x: number; y: number; z: number }; heading: null } | { action: 'player-respawned'; vehicle: null; position: { x: number; y: number; z: number }; heading: null }
interface FallRescueInput
FallRescueInput.vehicle: Vehicle | null
FallRescueInput.respawn: VehicleRespawnPoint
FallRescueInput.vehicleExitLocked: boolean
FallRescueInput.startPosition: { x: number; y: number; z: number }
FallRescueInput.options: FallRescueOptions
function planFallRescue(input: FallRescueInput): FallRescueEvent

## engine/FixedPointMath.ts
type Fixed16 = number
function fpFromFloat(f: number): Fixed16
function fpToFloat(fp: Fixed16): number
function fpAdd(a: Fixed16, b: Fixed16): Fixed16
function fpSub(a: Fixed16, b: Fixed16): Fixed16
function fpMul(a: Fixed16, b: Fixed16): Fixed16
function fpDiv(a: Fixed16, b: Fixed16): Fixed16
function fpSqrt(a: Fixed16): Fixed16
function fpDistSq3(dx: Fixed16, dy: Fixed16, dz: Fixed16): Fixed16
function fpDist3(dx: Fixed16, dy: Fixed16, dz: Fixed16): Fixed16
function fpHorizDistSq(dx: Fixed16, dz: Fixed16): Fixed16
function fpSin(angle: Fixed16): Fixed16
function fpCos(angle: Fixed16): Fixed16
class FixedPointRng — Deterministic PRNG suitable for fixed-point destruction sequences.
FixedPointRng.constructor(seed: number)
FixedPointRng.nextInt(): number
FixedPointRng.nextFixed(): Fixed16
FixedPointRng.nextAngle(): Fixed16
function explosionSeed(cx: Fixed16, cy: Fixed16, cz: Fixed16, radius: Fixed16): number
interface FpVec3
FpVec3.x: Fixed16
FpVec3.y: Fixed16
FpVec3.z: Fixed16
const FP_ONE = SCALE
const FP_ZERO = 0

## engine/ForgedLevelData.ts
type ForgedFeatureQuery = | { kind: string; name?: string } | { kind?: string; name: string }
function forgedFeatures(gameData: GameData | null | undefined): ForgedLevelFeature[]
function findForgedFeature(gameData: GameData | null | undefined, query: ForgedFeatureQuery): ForgedLevelFeature | null
function findForgedFeatures(gameData: GameData | null | undefined, query: ForgedFeatureQuery): ForgedLevelFeature[]
type ForgedMarker = NonNullable<ForgedLevelMarkers['named']>[number]
function findForgedMarker(gameData: GameData | null | undefined, name: string): ForgedMarker | null
function forgedPathFeature(gameData: GameData | null | undefined): ForgedLevelFeature | null
function forgedStreetGraph(gameData: GameData | null | undefined): ForgedStreetGraph | null

## engine/FrameTimer.ts
const MAX_DELTA = 0.1
class FrameTimer
FrameTimer.tick(nowMs: number): number
FrameTimer.discardNext(): void
FrameTimer.isDiscardPending(): boolean
FrameTimer.get ambienceTime(): number
class LegacyClock — A drop-in replacement for `THREE.Clock`, kept alive for ONE reason:
LegacyClock.autoStart: boolean
LegacyClock.startTime
LegacyClock.oldTime
LegacyClock.elapsedTime
LegacyClock.running
LegacyClock.constructor(autoStart = true)
LegacyClock.start(): void
LegacyClock.stop(): void
LegacyClock.getElapsedTime(): number
LegacyClock.getDelta(): number

## engine/GameEngine.ts
type RendererType = 'webgl' | 'webgpu'
class GameEngine implements EngineLike
GameEngine.container: HTMLElement
GameEngine.scene: THREE.Scene | null
GameEngine.camera: THREE.PerspectiveCamera | THREE.OrthographicCamera | null
GameEngine.renderer: THREE.WebGLRenderer | null
GameEngine.physicsWorld: PhysicsWorld | null
GameEngine.physicsWorld2D: PhysicsWorld2D | null
GameEngine.genreModule: GenreGameInterface | null
GameEngine.getMechanismSystem(): MechanismSystem | null
GameEngine.getSmartObjectSystem(): SmartObjectSystem
GameEngine.getSpawnPoints(type?: string): SpawnPoint[]
GameEngine.genreRegistry: typeof genreRegistry
GameEngine.loader: GLTFLoader | null
GameEngine.clock: LegacyClock
GameEngine.editorManager: EditorManager | null
GameEngine.gameStateManager: GameStateManager
GameEngine.isWindowFocused: boolean
GameEngine.isGaussianSplatMode: boolean
GameEngine.gaussianSplatRenderer: GaussianSplatRenderer | null
GameEngine.gaussianSplatRenderers: GaussianSplatRenderer[]
GameEngine.activeSplatIndex: number
GameEngine.pvsController: PvsController | null
GameEngine.blockCharacterFactory: BlockCharacterFactoryType | undefined
GameEngine.applyCharacterModifications: CharacterModificationsFunction | undefined
GameEngine.quality: QualityController
GameEngine.blocks: BlockRegistry
GameEngine.composer: EffectComposer | null
GameEngine.forceFixedDeltaTime: boolean
GameEngine.constructor(container: HTMLElement)
static GameEngine.getFrameCount(): number
GameEngine.getRenderedFrameCount(): number
GameEngine.getDeltaTime(): number
GameEngine.getElapsedTime(): number
GameEngine.getAmbienceTime(): number
GameEngine.setDebugDisableNpcs(v: boolean): void
GameEngine.getDebugDisableNpcs(): boolean
GameEngine.setDebugForceActiveRate(v: boolean): void
GameEngine.getDebugForceActiveRate(): boolean
GameEngine.getTargetFps(): number
GameEngine.init(): void
GameEngine.applyFogConfig(config?: FogConfig | null): void
GameEngine.applyLightingConfig(config?: LightingConfig | null): void
GameEngine.applyWeatherConfig(config?: WeatherConfig | null): void
GameEngine.getLightingConfig(): LightingConfig | null
GameEngine.getRenderConfig(): RenderConfig | null
GameEngine.setColorGrading(config: Partial<ColorGradingConfig>): void
GameEngine.setVignette(config: Partial<VignetteConfig>): void
GameEngine.getSkyColorHex(): string
GameEngine.isSolidBackgroundActive(): boolean
GameEngine.setSolidBackground(color: string | null): void
GameEngine.setupSelectionOutline(): void
GameEngine.setOutlineSelectedObjects(objects: THREE.Object3D[]): void
GameEngine.hasOutlinePass(): boolean
GameEngine.setupLighting(): void
GameEngine.applyShadowConfiguration(): void
GameEngine.fitShadowsToWorld(): void
GameEngine.updateShadowCameraPosition(): void
GameEngine.getCurrentPlayer(): any | null
GameEngine.getWorldHeightAt(x: number, z: number): number
GameEngine.getWorldCenter(): THREE.Vector3
GameEngine.getGameplayPlaneZ(): number | null
GameEngine.getPlaneLockedPhysics(): PlaneLockedPhysics | null
GameEngine.resolveGroundPlacement(x: number, z: number, options?: Partial<GroundPlacementOptions>): GroundPlacement
GameEngine.applyWaterSurface(waterLevelY: number | null): void
GameEngine.applyOpenWater(config: OpenWaterConfig | null): void
GameEngine.getOceanSurface(): OceanSurface | null
GameEngine.getSunDirection(): THREE.Vector3 | null
GameEngine.getShadowConfig(): ShadowConfig
GameEngine.ensureGaussianSplatEditor(firstRenderer: GaussianSplatRenderer): Promise<void>
GameEngine.setupWindowFocusListeners(): void
GameEngine.setRendererType(type: RendererType): void
GameEngine.getRendererType(): RendererType
GameEngine.getActiveBackend(): RendererBackend
GameEngine.recreateRenderer(antialias: boolean, type: RendererType = this.currentRendererType): void
GameEngine.initPhysics(mode: '3d' | '2d' | 'none' = '3d'): Promise<void>
GameEngine.getLevelManager(): LevelManager | null
GameEngine.loadLevel(levelId: string, opts?: LoadLevelOptions): Promise<void>
GameEngine.getActiveLevelId(): string | null
GameEngine.getLevels(): Array<{ id: string; name: string }>
GameEngine.prefetchLevel(levelId: string): Promise<void>
GameEngine.applyLevelAtmosphere(profile: WorldProfileData | undefined): void
GameEngine.refreshEnvironmentLights(): void
GameEngine.getDoorSystem(): DoorSystem | null
GameEngine.loadGame(gameId: string, gameData: GameData, options?: LoadGameOptions): Promise<void>
GameEngine.getWorldGroup(): THREE.Object3D
GameEngine.addToWorld(...objects: THREE.Object3D[]): void
GameEngine.spawnAsset(assetIdOrName: string, options?: Partial<SpawnAssetOptions>): Promise<SpawnedAsset | null>
GameEngine.loadGaussianSplat(url: string, config?: { position?: Vector3Like; eulerAngles?: Vector3Like; scale?: Vector3Like; }): Promise<GaussianSplatRenderer>
GameEngine.setRenderActive(active: boolean): void
GameEngine.animate(): void
GameEngine.getViewModelLayer(): ViewModelLayer | null
GameEngine.renderFrameNow(): void
GameEngine.getDefaultCamera(): THREE.PerspectiveCamera
GameEngine.setRenderCamera(cam: THREE.PerspectiveCamera | THREE.OrthographicCamera): void
GameEngine.noteQualityDisturbance(reason: string): void
GameEngine.onWindowResize(): void
GameEngine.dispose(): void
GameEngine.registerPlayerController(playerController: PlayerControllerLike): void
GameEngine.registerBeforeRender(callback: () => void): () => void
GameEngine.getPlayerController(): PlayerControllerLike | null
GameEngine.setLidControlEnabled(enabled: boolean): void
GameEngine.getActiveVehicle(): any | null
GameEngine.getVehicleSpawner(): import('./VehicleSpawner.js').VehicleSpawner | null
GameEngine.setVehicleSpawner(spawner: import('./VehicleSpawner.js').VehicleSpawner): void
GameEngine.getVehicleManager(): import('./VehicleManager.js').VehicleManager | null
GameEngine.setVehicleManager(manager: import('./VehicleManager.js').VehicleManager): void
GameEngine.getSpawner(): import('./Spawner.js').Spawner | null
GameEngine.setSpawner(spawner: import('./Spawner.js').Spawner): void
GameEngine.getPlayerLoader(): import('./loaders/PlayerLoader.js').PlayerLoader | null
GameEngine.setPlayerLoader(loader: import('./loaders/PlayerLoader.js').PlayerLoader): void
GameEngine.onSceneWarmedUp(cb: () => void): void
GameEngine.preloadLevel(opts?: { audioAssetIds?: string[] }): Promise<void>
GameEngine.warmUpLoadedScene(onProgress: WarmupProgressFn): Promise<void>
GameEngine.preloadPlayerCharacter(): Promise<void>
GameEngine.preloadNpcSkeleton(): Promise<void>
GameEngine.preloadAudio(idsOrUrls: string[]): Promise<void>
GameEngine.warmUpScene(reveal: THREE.Object3D[] = []): Promise<boolean>
GameEngine.getPlayerVisibility(): PlayerVisibility
GameEngine.getAnimalRegistry(): AnimalRegistry
GameEngine.getAIService(): AIService
GameEngine.getVoiceInput(): VoiceInput
GameEngine.enablePushToTalk(onTranscript: (text: string) => void, options?: Partial<PushToTalkOptions>): void
GameEngine.getScreenshotService(): ScreenshotService
GameEngine.getGameDataService(): GameDataService
GameEngine.publishLeaderboard(declaration: LeaderboardDeclaration): Promise<void>
GameEngine.getLaunchParams(): LaunchParams
GameEngine.getGamePersistence(): GamePersistence
GameEngine.getGhostRacing(): GhostRacing
GameEngine.getLeaderboardIdentity(): Promise<LeaderboardIdentity>
GameEngine.getDynamicObjectManager(): DynamicObjectManager
GameEngine.getNpcRegistry(): NpcRegistry | null
GameEngine.setNpcRegistry(registry: NpcRegistry): void
GameEngine.registerNpc(name: string, behavior: INpcBehavior, options?: RegisterNpcOptions): NpcHandle
GameEngine.getPointerLockManager(): import('./PointerLockManager.js').PointerLockManager | null
GameEngine.setPointerLockManager(manager: import('./PointerLockManager.js').PointerLockManager): void
GameEngine.enterInteractiveUI(): void
GameEngine.exitInteractiveUI(): void
GameEngine.setStartGameHandler(handler: () => void): void
GameEngine.setPlayButtonVisibilityHandler(handler: (visible: boolean) => void): void
GameEngine.setStartupUiModeHandler(handler: (mode: StartupUiMode) => void): void
GameEngine.startGame(): void
GameEngine.setPlayButtonVisible(visible: boolean): void
GameEngine.setStartupUiMode(mode: StartupUiMode): void
GameEngine.endGame(options: Partial<EndGameOptions> = {}): void
GameEngine.unlockAchievement(id: string): void
GameEngine.setUIComponent(slot: UISlot, component: GameUIComponent | null): void
GameEngine.getUIComponent(slot: UISlot): GameUIComponent | null
GameEngine.setScreenTransition(options: Partial<ScreenTransitionOptions>): void
GameEngine.setUIComponentChangeHandler(handler: (slot: UISlot) => void): void
GameEngine.setPreGameSelection(selectionId: string, optionId: string): void
GameEngine.getPreGameSelections(): Record<string, string>
GameEngine.getRenderer(): THREE.WebGLRenderer
GameEngine.getGameData(): GameData | null
GameEngine.isRecordingFrames(): boolean
GameEngine.getCameraPathEditor(): CameraPathEditor | null
GameEngine.enablePerfStats(): void
GameEngine.disablePerfStats(): void
GameEngine.resetPerfOrphanTracking(): void
GameEngine.getGaussianSplatExporter(): GaussianSplatExporter
GameEngine.playVideo(assetId: string, options?: VideoPlayOptions): Promise<void>
GameEngine.playSound(assetId: string, opts?: { volume?: number }): void
GameEngine.playMusic(assetId: string, opts?: { loop?: boolean; fadeIn?: number; volume?: number }): Promise<void>
GameEngine.stopMusic(opts?: { fadeOut?: number }): Promise<void>
GameEngine.logGameEvent(event: GameEventInput): void
GameEngine.logSoundEvent(name: string, recipe?: SynthSoundRecipe): void
GameEngine.setAudioVolume(opts: { master?: number; sfx?: number; music?: number }): void
GameEngine.getAudioContext(): AudioContext | null
GameEngine.getAudioDestination(): AudioNode | null
GameEngine.enableMuteControl(): void
GameEngine.isAudioUsed(): boolean
GameEngine.isAudioMuted(): boolean
GameEngine.setAudioMuted(muted: boolean): void
GameEngine.onAudioMuteChange(cb: (muted: boolean) => void): () => void
GameEngine.setMuteHotkeyEnabled(enabled: boolean): void
GameEngine.enableBloomOnObject(object: THREE.Object3D): void

## engine/GameEnginePostFx.ts
function syncColorGrade(eng: GameEngine): void
function rebuildComposerPasses(eng: GameEngine): void

## engine/GameEngineViewModel.ts
function viewModelVisible(eng: GameEngine): boolean
function viewModelPassRequired(eng: GameEngine): boolean
function syncViewModelLayer(eng: GameEngine): boolean
function renderViewModelOverlay(eng: GameEngine): void

## engine/GameEngineWarmup.ts
type WarmupProgressFn = (fraction: number, label?: string) => void
const DEFAULT_WARMUP_PROGRESS: WarmupProgressFn
function addSceneWarmedUpCallback(eng: GameEngine, cb: () => void): void
function runLevelPreload(eng: GameEngine, opts?: { audioAssetIds?: string[] }): Promise<void>
function runLoadedSceneWarmup(eng: GameEngine, onProgress: WarmupProgressFn): Promise<void>
function runPlayerCharacterPreload(eng: GameEngine): Promise<void>
function runNpcSkeletonPreload(eng: GameEngine): Promise<void>
function runAudioPreload(eng: GameEngine, idsOrUrls: string[]): Promise<void>
function runSceneWarmup(eng: GameEngine, reveal: THREE.Object3D[], onProgress: WarmupProgressFn): Promise<boolean>

## engine/GameRuntimeController.ts
class GameRuntimeController
GameRuntimeController.constructor(container: HTMLElement, postMessage: PostMessageFn)
GameRuntimeController.getStateManager(): GameStateManager
GameRuntimeController.getStartScreen(): StartScreen | null
GameRuntimeController.getPointerLockManager(): PointerLockManager | null
GameRuntimeController.getStartupUiMode(): StartupUiMode
GameRuntimeController.setCurrentGame(gameId: string | null, gameData: unknown): void
GameRuntimeController.setCurrentTab(tab: string | null): void
GameRuntimeController.attachEngine(engine: GameEngine, onStartRequested: StartRequestHandler): void
GameRuntimeController.resetForLoad(showStartMenu: boolean): StartScreen | null
GameRuntimeController.finishLoadWaitingForStart(): void
GameRuntimeController.hasGameplayStartedThisLoad(): boolean
GameRuntimeController.showMenu(): void
GameRuntimeController.showEditorPreview(): void
GameRuntimeController.setGameplayPaused(paused: boolean, reason: PauseReason): void
GameRuntimeController.prepareGameplayStart(): Promise<boolean>
GameRuntimeController.enterPlayingMode(): void
GameRuntimeController.applyEditorTabMode(tab: string | null): void
GameRuntimeController.canSwitchToEditorTab(tab: string | null): boolean
GameRuntimeController.requestManualPause(): void
GameRuntimeController.resumeFromParentFrame(): void

## engine/GameStateManager.ts
enum GameState { MENU, LOADING, READY, PLAYING, PAUSED, END }
type GameStateChangeListener = (newState: GameState, oldState: GameState) => void
type ReadyMode = 'menu' | 'editor-preview'
type PauseReason = 'editor-tab' | 'manual' | 'interactive-ui' | 'system' | 'pointer-lock'
class GameStateManager
GameStateManager.constructor(initialState: GameState = GameState.MENU, private readonly beforePlaying?: (resume: () => void) => void)
GameStateManager.getCurrentState(): GameState
GameStateManager.getReadyMode(): ReadyMode
GameStateManager.getCurrentTab(): string | null
GameStateManager.setCurrentTab(tab: string | null): void
GameStateManager.hasStarted(): boolean
GameStateManager.isWaitingForPlayerStart(): boolean
GameStateManager.setState(newState: GameState): void
GameStateManager.isState(state: GameState): boolean
GameStateManager.transitionToLoading(): void
GameStateManager.transitionToMenu(): void
GameStateManager.transitionToReady(mode: ReadyMode): void
GameStateManager.markPlaying(): void
GameStateManager.setPaused(paused: boolean, reason: PauseReason = 'manual'): void
GameStateManager.forceUnpause(): void
GameStateManager.getPauseReasons(): ReadonlySet<PauseReason>
GameStateManager.transitionToEnd(): void
GameStateManager.resetForNewSession(initialState: GameState = GameState.MENU): void
GameStateManager.addListener(listener: GameStateChangeListener): void
GameStateManager.removeListener(listener: GameStateChangeListener): void
GameStateManager.clearListeners(): void
function getGameStateManager(): GameStateManager
function setGameStateManager(manager: GameStateManager): void
function resetGameStateManager(): void

## engine/GameplayPlane.ts
function resolveGameplayPlaneZ(gameData: GameData): number | null
type PlaneOrientation = 'xy' | 'xz'
interface PhysicsPlane
PhysicsPlane.orientation: PlaneOrientation
PhysicsPlane.planeZ: number
function resolvePhysicsPlane(gameData: GameData): PhysicsPlane

## engine/GameplayTimers.ts
function scheduleGameplaySeconds(seconds: number, callback: () => void): void
function advanceGameplayTimers(deltaSeconds: number): void
function clearGameplayTimers(): void

## engine/GenreLoader.ts
class GenreLoader
static GenreLoader.loadAvailableGenres(): Promise<void>
static GenreLoader.forceReloadGenre(genreRegistryName: string): Promise<GenreConstructor | null>
static GenreLoader.clearCache(): void
static GenreLoader.loadGenre(genreRegistryName: string): Promise<GenreConstructor | null>

## engine/GenreRegistry.ts
interface GenreGameInterface
GenreGameInterface.load(gameId: string): Promise<void>
GenreGameInterface.update(deltaTime: number): void
GenreGameInterface.dispose(): void
GenreGameInterface.onWindowResize(): void
GenreGameInterface.getCurrentPlayer(): any | null
GenreGameInterface.hud?: IGameHUD
GenreGameInterface.declareMobileActions?(): MobileActionSpec[]
GenreGameInterface.isPointInPlayableArea?(point: { x: number; y: number; z: number }): boolean
GenreGameInterface.getNetworkManager?(): import('engine/networking/NetworkManager.js').NetworkManager | null
type GenreConstructor = new (engine: any, worldProfileData: any, gameData?: any) => GenreGameInterface
class GenreRegistry
static GenreRegistry.getInstance(): GenreRegistry
GenreRegistry.registerGenre(name: string, constructor: GenreConstructor): void
GenreRegistry.getGenre(name: string): GenreConstructor | null
GenreRegistry.getAvailableGenres(): string[]
GenreRegistry.createGenreGame(name: string, engine: any, worldProfileData: any, gameData?: any): GenreGameInterface | null
const genreRegistry = GenreRegistry.getInstance()

## engine/GlbInstancing.ts
const GLB_INSTANCING_MIN_COPIES = 8
function isInstanceableGlb(scene: THREE.Object3D): boolean
function isPickableOnScreen(mesh: THREE.Object3D): boolean
class GlbInstanceBatch
GlbInstanceBatch.root
GlbInstanceBatch.constructor(template: THREE.Object3D, private readonly world: THREE.Object3D, capacity: number)
GlbInstanceBatch.add(owner: THREE.Object3D): void
GlbInstanceBatch.update(): void
GlbInstanceBatch.dispose(): void

## engine/GlbSmartObject.ts
interface GlbAssetFrame — The native→asset mapping the GLB loader applies to a model.
GlbAssetFrame.origin: Vector3Like
GlbAssetFrame.scale: number
GlbAssetFrame.lift: number
interface GlbSmartDerivation
GlbSmartDerivation.bake: SmartPropBake
GlbSmartDerivation.warnings: string[]
function deriveGlbSmartObject(scene: THREE.Object3D, frame: GlbAssetFrame): GlbSmartDerivation | null
const BM_ANCHOR_NODE_PREFIX = 'BM_anchor_'
function canonicalAnchorNames(part: THREE.Object3D): void
class GlbSmartObjectHost extends THREE.Group implements SmartObjectHost — A placed GLB instance that is also its own `SmartObjectSystem` host: the loader builds a smart
GlbSmartObjectHost.constructor(private readonly bake: SmartPropBake)
GlbSmartObjectHost.liftParts(): boolean
GlbSmartObjectHost.restoreParts(): void
GlbSmartObjectHost.getDecodedVxlV3(): { parts: VxlV3Part[]; rig: { bindPositions: Float32Array } }
GlbSmartObjectHost.buildSmartPartMeshes(): Array<{ joint: number; mesh: THREE.Mesh }>
GlbSmartObjectHost.getMesh(): THREE.Mesh | null
GlbSmartObjectHost.getPivot(): null

## engine/HitDebrisSystem.ts
interface HitDebrisConfig
HitDebrisConfig.count: number
HitDebrisConfig.minSize: number
HitDebrisConfig.maxSize: number
HitDebrisConfig.minSpeed: number
HitDebrisConfig.maxSpeed: number
HitDebrisConfig.spread: number
HitDebrisConfig.gravity: number
HitDebrisConfig.lifetime: number
HitDebrisConfig.fallbackColor: THREE.Color
HitDebrisConfig.maxPieces: number
const DEFAULT_HIT_DEBRIS: HitDebrisConfig
function sampleTargetColor(object: THREE.Object3D | null | undefined): THREE.Color | null
class HitDebrisSystem
HitDebrisSystem.constructor(scene: THREE.Scene, config?: Partial<HitDebrisConfig>)
HitDebrisSystem.spawn(position: THREE.Vector3, normal: THREE.Vector3, target?: THREE.Object3D | null, overrides?: Partial<HitDebrisConfig>): void
HitDebrisSystem.update(deltaTime: number): void
HitDebrisSystem.dispose(): void
function initHitDebrisSystem(scene: THREE.Scene, config?: Partial<HitDebrisConfig>): HitDebrisSystem
function getHitDebrisSystem(): HitDebrisSystem | null
function spawnHitDebris(position: THREE.Vector3, normal: THREE.Vector3, target?: THREE.Object3D | null, overrides?: Partial<HitDebrisConfig>): void
const DEATH_BURST: Partial<HitDebrisConfig>
function disposeHitDebrisSystem(): void

## engine/HqGenerationState.ts
function isGeneratingHqAsset(assetId: string | undefined): boolean
function getGeneratingHqAssetIds(): ReadonlySet<string>
function setGeneratingHqAssetIds(assetIds: Iterable<string>): boolean
function onGeneratingHqAssetsChanged(fn: () => void): () => void

## engine/InkOutlineNode.ts
interface InkOutlineParams — Resolved look of the ink outline (see `InkOutlineConfig` in types/game.ts).
InkOutlineParams.color: THREE.Color
InkOutlineParams.thickness: number
InkOutlineParams.normalThreshold: number
InkOutlineParams.depthThreshold: number
InkOutlineParams.strength: number
InkOutlineParams.near: number
InkOutlineParams.far: number
const DEFAULT_INK_OUTLINE: Omit<InkOutlineParams, 'near' | 'far'>
function applyInkOutline(sceneColor: Vec4Node, depthTex: SampleableTexture, normalTex: SampleableTexture, params: InkOutlineParams): Vec4Node

## engine/InkOutlinePassWebGL.ts
class InkOutlinePassWebGL extends Pass — Classic-composer ink outline. Add to the `EffectComposer` like any `Pass`.
InkOutlinePassWebGL.constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera, params: InkOutlineParams)
InkOutlinePassWebGL.setSize(width: number, height: number): void
InkOutlinePassWebGL.render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void
InkOutlinePassWebGL.dispose(): void

## engine/LaunchParams.ts
const GHOST_PARAM = 'ghost'
const TRACK_PARAM = 'track'
interface LaunchParams
LaunchParams.ghostEntryId: string | null
LaunchParams.trackLevelId: string | null
const NO_LAUNCH_PARAMS: LaunchParams
function getLaunchParams(): LaunchParams

## engine/LevelDetail.ts
const MAX_LEVEL_DETAIL = 4
interface LevelDetailPlan — How a tier splits into "which file" and "how much more to shed at load".
LevelDetailPlan.fileDrop: number
LevelDetailPlan.extraSkipSteps: number
function levelDetailPlan(tier: number): LevelDetailPlan
function resolveLevelDetail(fallback: number): number
function noteLevelLoadStarted(): void
function noteLevelLoadFinished(): void
function applyPendingDowngrade(fallback: number): number | null
function resetDowngradeCheckForTests(): void
function setLevelDetail(tier: number): void
function clearLevelDetail(): void

## engine/LoadProfile.ts
function profilingEnabled(): boolean
function profileMark(name: string, detail = ''): void
function installLoadProfiler(subscribe: (fn: (phase: string | null) => void) => void): void
function report(): void

## engine/PerfStatsCollector.ts
interface PerfStats
PerfStats.timestamp: number
PerfStats.fps: number
PerfStats.targetFps: number
PerfStats.frameTime: number
PerfStats.drawCalls: number
PerfStats.triangles: number
PerfStats.points: number
PerfStats.lines: number
PerfStats.geometries: number
PerfStats.textures: number
PerfStats.shaderPrograms: number
PerfStats.shaderRecompiles: number
PerfStats.sceneObjectCount: number
PerfStats.meshCount: number
PerfStats.lightCount: number
PerfStats.groupCount: number
PerfStats.spriteCount: number
PerfStats.lineObjectCount: number
PerfStats.pointsObjectCount: number
PerfStats.skinnedMeshCount: number
PerfStats.instancedMeshCount: number
PerfStats.uniqueGeometries: number
PerfStats.uniqueMaterials: number
PerfStats.rigidBodyCount: number
PerfStats.colliderCount: number
PerfStats.topObjectTypes: [string, number][]
PerfStats.objectTypeDeltas: [string, number][]
PerfStats.orphanedGeoTypes: [string, number][]
PerfStats.orphanedGeoTotal: number
PerfStats.jsHeapUsedMB: number | null
PerfStats.jsHeapTotalMB: number | null
class PerfStatsCollector — Collects WebGL, scene, and physics performance stats from the game engine
PerfStatsCollector.constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, physicsWorld: PhysicsWorld | null, getTargetFps: () => number)
PerfStatsCollector.recordFrameTiming(frameMs: number, renderMs: number, camera: THREE.Camera | null): void
PerfStatsCollector.buildPerfReport(): object
PerfStatsCollector.dumpPerfReport(): object
PerfStatsCollector.recordFrame(): void
PerfStatsCollector.collect(): PerfStats
PerfStatsCollector.startEmitting(intervalMs = 500): void
PerfStatsCollector.stopEmitting(): void
PerfStatsCollector.setPhysicsWorld(physicsWorld: PhysicsWorld | null): void
PerfStatsCollector.resetOrphanTracking(): void
PerfStatsCollector.resetChurnTracking(): void

## engine/PhysicsBodyRegistry.ts
const physicsBodyRegistry = new Map<number, string>()
function registerPhysicsBody(body: RAPIER.RigidBody, typeName: string): void
function unregisterPhysicsBody(body: RAPIER.RigidBody): void
function getBodyTypeName(handle: number): string | undefined
function getPhysicsHandle(body: RAPIER.RigidBody | RAPIER.Collider | null | undefined): number

## engine/PlayerPosture.ts
interface PostureHost — The PlayerController handles a posture change touches.
PostureHost.body: RAPIER.RigidBody | null
PostureHost.loader: { getCapsuleHeight(): number; getCapsuleRadius(): number; setCapsuleDimensions(h: number, r: number): void } | null
PostureHost.physicsWorld: PhysicsWorld
PostureHost.movementSystem: IPlayerMovement
PostureHost.animationController: ICharacterAnimationController | null
const POSTURE_PHYSICS: Record<Posture, { height: number; speed: number }>
class PlayerPosture
PlayerPosture.current: Posture
PlayerPosture.onMovementSystemChanged(): void
PlayerPosture.set(posture: Posture, host: PostureHost): boolean

## engine/PosterizeNode.ts
interface PosterizeParams — Resolved look of the posterize pass (see `PosterizeConfig` in types/game.ts).
PosterizeParams.levels: number
PosterizeParams.strength: number
const DEFAULT_POSTERIZE: PosterizeParams
function applyPosterize(sceneColor: Vec4Node, params: PosterizeParams): Vec4Node
const POSTERIZE_SHADER = { uniforms: { tDiffuse: { value: null as unknown }, levels:

## engine/PostureActions.ts
interface PostureActionHost
PostureActionHost.body: RAPIER.RigidBody | null
PostureActionHost.physicsWorld: PhysicsWorld
PostureActionHost.animationController: ICharacterAnimationController | null
PostureActionHost.getYaw(): number
PostureActionHost.getCapsule(): { height: number; radius: number } | null
PostureActionHost.setPosture(p: string): boolean
PostureActionHost.getPosture(): string
PostureActionHost.setBodyHeld(held: boolean): void
function buildPostureActionHost(_owner: object, h: { body: RAPIER.RigidBody | null; physicsWorld: PhysicsWorld; animationController: ICharacterAnimationController | null; loader: { getCapsuleHeight(): number; getCapsuleRadius(): number } | null; movementSystem: IPlayerMovement; yaw: number; setPosture(p: string): boolean; getPosture(): string; setHeld(held: boolean): void; }): PostureActionHost
interface LedgeInfo — Ledge probe result: where the top surface is and how high above the feet.
LedgeInfo.topY: number
LedgeInfo.landing: THREE.Vector3
LedgeInfo.rise: number
LedgeInfo.wallDist: number
const LEDGE_MIN_RISE = 0.9
const LEDGE_MAX_RISE = 2.3
const VAULT_MAX_RISE = 1.2
const VAULT_MAX_DEPTH = 1.4
class PostureActions
PostureActions.setCoverPeek(peek: boolean, host: PostureActionHost): void
PostureActions.onLeaveCover(): void
PostureActions.isPeeking(): boolean
PostureActions.probeLedge(host: PostureActionHost, minRise = LEDGE_MIN_RISE, maxRise = LEDGE_MAX_RISE): LedgeInfo | null
PostureActions.tryGrabLedge(host: PostureActionHost): boolean
PostureActions.mantle(host: PostureActionHost): boolean
PostureActions.vault(host: PostureActionHost): boolean
PostureActions.getUp(host: PostureActionHost): boolean
PostureActions.slide(host: PostureActionHost): boolean
PostureActions.isBusy(): boolean

## engine/PreferenceStorage.ts
function getPreference(key: string): string | undefined
function setPreference(key: string, value: string): void

## engine/PushToTalk.ts
interface PushToTalkOptions — Options for the push-to-talk preset.
PushToTalkOptions.action: string
PushToTalkOptions.desktopKeys: string[]
PushToTalkOptions.mobileLabel: string
PushToTalkOptions.mobileRole: 'primary' | 'danger' | 'warning'
PushToTalkOptions.mobilePosition: MobileButtonPosition | null
PushToTalkOptions.indicator: boolean
PushToTalkOptions.language: string | null
PushToTalkOptions.maxDurationMs: number
PushToTalkOptions.minDurationMs: number
PushToTalkOptions.onError: ((error: VoiceInputError) => void) | null
const DEFAULT_PUSH_TO_TALK_OPTIONS: PushToTalkOptions
class PushToTalk
PushToTalk.constructor(voiceInput: VoiceInput)
PushToTalk.configure(onTranscript: (text: string) => void, options?: Partial<PushToTalkOptions>): void
PushToTalk.isConfigured(): boolean
PushToTalk.wire(playerController: PlayerControllerLike | null, hud: IGameHUD | null, container: HTMLElement): void
PushToTalk.update(): void
PushToTalk.reset(): void

## engine/RenderPixelRatio.ts
const MOBILE_MAX_PIXEL_RATIO = 2
const MAX_RENDER_PIXEL_RATIO = 4
const MIN_RENDER_PIXEL_RATIO = 0.5
function resolveRenderPixelRatio(deviceRatio: number, maxPixelRatio: number): number

## engine/RuntimeAIErrors.ts
const DEFAULT_BACKOFF_MS = 1000
class RuntimeAIBackoffError extends Error
RuntimeAIBackoffError.constructor(readonly status: number, readonly retryAfterMs: number, message: string)
function isBackoffStatus(status: number): boolean
function readRetryAfterMs(body: string): number

## engine/RuntimeErrorForwarder.ts
function shortenSourceUrls(text: string): string
interface ForwardedRuntimeError
ForwardedRuntimeError.message: string
ForwardedRuntimeError.stack?: string
ForwardedRuntimeError.count: number
ForwardedRuntimeError.firstSeen: number
function truncateStack(stack: string | undefined): string | undefined
function collectNewErrors(messages: readonly CapturedMessage[], sentCounts: Map<string, number>): ForwardedRuntimeError[]
function startRuntimeErrorForwarding(): void

## engine/SeededRandom.ts
class SeededRandom
SeededRandom.constructor(seed: number)
SeededRandom.next(): number
SeededRandom.nextInRange(min: number, max: number): number
SeededRandom.nextInt(max: number): number
SeededRandom.reset(): void
SeededRandom.setSeed(newSeed: number): void
SeededRandom.getSeed(): number

## engine/ShaderChurnDetector.ts
interface ProgramIdentity — The three fields of a WebGL program entry this detector reads.
ProgramIdentity.id: number
ProgramIdentity.cacheKey: string
ProgramIdentity.name: string
function describeProgram(p: ProgramIdentity): string
interface ShaderChurnEvent — One detected recompile.
ShaderChurnEvent.t: number
ShaderChurnEvent.name: string
ShaderChurnEvent.count: number
const WEBGPU_CHURN_PAIRING_WINDOW_MS = 5000
class ShaderChurnDetector
ShaderChurnDetector.get totalRecompiles(): number
ShaderChurnDetector.get eventLog(): readonly ShaderChurnEvent[]
ShaderChurnDetector.observePrograms(programs: readonly ProgramIdentity[], t: number): readonly string[]
ShaderChurnDetector.observeProgramCount(count: number, t: number): readonly string[]
ShaderChurnDetector.reset(): void

## engine/SlidingVFX.ts
interface SlidingVFXConfig — Configuration for sliding particle effects
SlidingVFXConfig.color?: { r: number; g: number; b: number }
SlidingVFXConfig.minSize?: number
SlidingVFXConfig.maxSize?: number
SlidingVFXConfig.emissionRate?: number
SlidingVFXConfig.particleLifetime?: number
SlidingVFXConfig.velocityThreshold?: number
SlidingVFXConfig.frictionThreshold?: number
SlidingVFXConfig.riseSpeed?: number
SlidingVFXConfig.spreadSpeed?: number
SlidingVFXConfig.groundOffset?: number
interface ISlidingVFX — Interface for sliding VFX providers
ISlidingVFX.update( deltaTime: number, playerPosition: THREE.Vector3, velocity: number, friction: number, isSliding: boolean ): void
ISlidingVFX.dispose(): void
ISlidingVFX.updateConfig?(config: Partial<SlidingVFXConfig>): void
class SlidingVFX implements ISlidingVFX — Default sliding VFX implementation - ice crystal particle trail
SlidingVFX.constructor(scene: THREE.Scene, config?: SlidingVFXConfig)
SlidingVFX.updateConfig(config: Partial<SlidingVFXConfig>): void
SlidingVFX.getConfig(): Required<SlidingVFXConfig>
SlidingVFX.update(deltaTime: number, playerPosition: THREE.Vector3, velocity: number, friction: number, isSliding: boolean): void
SlidingVFX.dispose(): void

## engine/SmartObjectSystem.ts
interface SmartObjectHost — What `attach()` needs from the instance — `VoxelObject` satisfies it.
SmartObjectHost.getDecodedVxlV3(): { parts?: VxlV3Part[]; rig?: { bindPositions: Float32Array } } | null
SmartObjectHost.buildSmartPartMeshes(): Array<{ joint: number; mesh: THREE.Mesh }> | null
SmartObjectHost.getMesh(): THREE.Mesh | null
SmartObjectHost.getPivot(): { x: number; y: number; z: number } | null
class SmartObjectSystem
SmartObjectSystem.attach(id: string, host: SmartObjectHost, fitment: SmartObjectFitment): boolean
SmartObjectSystem.detach(id: string): void
SmartObjectSystem.ids(): string[]
SmartObjectSystem.partsOf(id: string): string[]
SmartObjectSystem.setPartSpeed(id: string, partName: string, scale: number): boolean
SmartObjectSystem.setPaused(id: string, paused: boolean): boolean
SmartObjectSystem.pivotOf(id: string, partName: string): THREE.Object3D | null
SmartObjectSystem.anchorToWorld(id: string, partName: string, point: { x: number; y: number; z: number }, out: THREE.Vector3): boolean
SmartObjectSystem.update(deltaTime: number): void
SmartObjectSystem.getElapsed(): number
SmartObjectSystem.dispose(): void

## engine/SmartObjectView.ts
interface SmartObjectViewInput
SmartObjectViewInput.parts: readonly VxlV3Part[]
SmartObjectViewInput.bindPositions: Float32Array
SmartObjectViewInput.meshes: ReadonlyArray<{ joint: number; mesh: THREE.Object3D }>
SmartObjectViewInput.pivot?: { x: number; y: number; z: number }
class SmartObjectView extends THREE.Group
SmartObjectView.pivots: THREE.Object3D[]
SmartObjectView.pivotAssetPositions: readonly THREE.Vector3[]
SmartObjectView.parts: readonly VxlV3Part[]
SmartObjectView.constructor(input: SmartObjectViewInput)
SmartObjectView.pivotOf(name: string): THREE.Object3D | null
SmartObjectView.assetPointOnPartToWorld(name: string, point: { x: number; y: number; z: number }, out: THREE.Vector3): boolean
SmartObjectView.disposeMeshes(): void

## engine/StorageUploadUtil.ts
interface UploadOptions
UploadOptions.contentType?: string
UploadOptions.gameId?: string
UploadOptions.noCache?: boolean
UploadOptions.onUploaded?: (uploadedBytes: number) => void
function uploadFile(data: Uint8Array | string, filename: string, options: UploadOptions = {}): Promise<string | null>
const uploadToS3 = uploadFile

## engine/StreetLaneGraph.ts
interface LanePoint
LanePoint.x: number
LanePoint.z: number
interface Lane — One direction of travel along one street segment.
Lane.id: number
Lane.segment: number
Lane.from: number
Lane.to: number
Lane.start: LanePoint
Lane.end: LanePoint
Lane.length: number
Lane.heading: number
Lane.roadWidth: number
Lane.kind: ForgedStreetGraph['segments'][number]['kind']
type TurnDirection = 'left' | 'straight' | 'right' | 'uturn'
interface TurnOption
TurnOption.direction: TurnDirection
TurnOption.lane: number
interface Junction
Junction.node: number
Junction.x: number
Junction.z: number
Junction.incoming: number[]
Junction.outgoing: number[]
Junction.degree: number
Junction.radius: number
interface StreetLaneGraphOptions
StreetLaneGraphOptions.laneOffsetFraction: number
StreetLaneGraphOptions.minLaneOffsetM: number
StreetLaneGraphOptions.straightToleranceRad: number
StreetLaneGraphOptions.junctionMarginM: number
const DEFAULT_STREET_LANE_GRAPH_OPTIONS: StreetLaneGraphOptions
class StreetLaneGraph
StreetLaneGraph.lanes: readonly Lane[]
StreetLaneGraph.junctions: ReadonlyMap<number, Junction>
static StreetLaneGraph.fromStreetGraph(graph: ForgedStreetGraph, options: StreetLaneGraphOptions = DEFAULT_STREET_LANE_GRAPH_OPTIONS): StreetLaneGraph
StreetLaneGraph.lane(id: number): Lane
StreetLaneGraph.junctionAtEnd(laneId: number): Junction
StreetLaneGraph.endsAtIntersection(laneId: number): boolean
StreetLaneGraph.turnAngle(fromLane: number, toLane: number): number
StreetLaneGraph.classifyTurn(fromLane: number, toLane: number): TurnDirection
StreetLaneGraph.turnOptions(laneId: number): TurnOption[]
StreetLaneGraph.progressAlong(laneId: number, x: number, z: number): number
StreetLaneGraph.pointAlong(laneId: number, distance: number): LanePoint
function compassName(heading: number): 'north' | 'northeast' | 'east' | 'southeast' | 'south' | 'southwest' | 'west' | 'northwest'

## engine/SunDirection.ts
const DEFAULT_SUN_ELEVATION_DEG = 54.7356
const DEFAULT_SUN_AZIMUTH_DEG = 45
const MIN_SUN_ELEVATION_DEG = 2
function resolveSunDirection(config?: LightingConfig | null, out = new THREE.Vector3()): THREE.Vector3
function applySunDirection(light: THREE.DirectionalLight, config?: LightingConfig | null): void
function resetSunDirection(light: THREE.DirectionalLight, gaussianSplat: boolean): void

## engine/TransformOnlyMesh.ts
const TRANSFORM_ONLY_GEOMETRY = (() => { const geom = new THREE.BufferGeometry(); geom.setAt
function createTransformOnlyMesh(name?: string): THREE.Mesh

## engine/ViewModelLayer.ts
interface ViewModelLayerOptions — The first-person view-model layer — a weapon drawn in front of the camera, in
ViewModelLayerOptions.fovDegrees: number
ViewModelLayerOptions.near: number
ViewModelLayerOptions.far: number
ViewModelLayerOptions.keyLightIntensity: number
ViewModelLayerOptions.keyLightDirection: THREE.Vector3
ViewModelLayerOptions.fillLightIntensity: number
ViewModelLayerOptions.ambientIntensity: number
ViewModelLayerOptions.flashLightDistance: number
ViewModelLayerOptions.flashLightDecay: number
const DEFAULT_VIEW_MODEL_LAYER_OPTIONS: ViewModelLayerOptions
class ViewModelLayer
ViewModelLayer.scene: THREE.Scene
ViewModelLayer.camera: THREE.PerspectiveCamera
ViewModelLayer.flashLight: THREE.PointLight
ViewModelLayer.constructor(options: ViewModelLayerOptions = DEFAULT_VIEW_MODEL_LAYER_OPTIONS)
ViewModelLayer.attach(object: THREE.Object3D): void
ViewModelLayer.detach(object: THREE.Object3D): void
ViewModelLayer.hasContent(): boolean
ViewModelLayer.setFovOffset(offsetDegrees: number): void
ViewModelLayer.syncProjection(renderer: OverlayRenderer): void
ViewModelLayer.renderOverlay(renderer: OverlayRenderer): void
ViewModelLayer.dispose(): void

## engine/VoiceInput.ts
type VoiceInputErrorCode = | 'unsupported' // insecure context, no mic API, or no usable backend | 'permission-denied' // the player blocked the microphone | 'no-microphone' // no audio input device present | 'already-listening' | 'not-listening' | 'transcription-failed' // backend/network failure | 'unavailable' // speech-to-text backend not configured (503) | 'rate-limited'
class VoiceInputError extends Error
VoiceInputError.code: VoiceInputErrorCode
VoiceInputError.constructor(code: VoiceInputErrorCode, message: string)
interface VoiceListenOptions — Options for a single listening session.
VoiceListenOptions.language: string | null
VoiceListenOptions.maxDurationMs: number
VoiceListenOptions.timeoutMs: number
const DEFAULT_VOICE_LISTEN_OPTIONS: VoiceListenOptions
type VoiceInputState = 'idle' | 'listening' | 'transcribing'
class VoiceInput
VoiceInput.constructor(aiService: AIService, onMicrophoneReleased?: () => void)
VoiceInput.isSupported(): boolean
VoiceInput.isListening(): boolean
VoiceInput.getState(): VoiceInputState
VoiceInput.onStateChange(callback: (state: VoiceInputState) => void): () => void
VoiceInput.startListening(options?: Partial<VoiceListenOptions>): Promise<void>
VoiceInput.stopListening(): Promise<TranscriptionResult>
VoiceInput.cancelListening(): void
VoiceInput.releaseMicrophone(): void
VoiceInput.dispose(): void
