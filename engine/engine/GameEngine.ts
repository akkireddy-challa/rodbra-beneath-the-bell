// Type checking enabled
import * as THREE from 'three';
import { ExplosionVisual } from 'engine/effects/ExplosionVisual.js';
import { VisualEffects } from 'engine/effects/VisualEffects.js';
import { resolveLightingConfig, resolveAtmosphereFog } from 'engine/LightingPresets.js';
import { coastalTerrainSampler } from 'engine/water/CoastalTerrainSampler.js';
// three's WEBGPU build is what `three` resolves to (one module instance —
// r185's node lighting matches lights by class identity, and a split across the
// core and webgpu builds renders every scene unlit). That build has no
// WebGLRenderer, so the classic renderer is imported from its own module. The
// classic path is duck-typed (isMesh / isDirectionalLight), so it renders
// objects built by the webgpu bundle without trouble.
import { WebGLRenderer } from 'three/src/renderers/WebGLRenderer.js';
import { setGeometryReleaseSuspended } from 'engine/GeometryCpuRelease.js';
import { resolveRenderPixelRatio } from 'engine/RenderPixelRatio.js';
import { resolveBloomDefaults } from 'engine/BloomDefaults.js';
import { activeQualityPolicy } from 'engine/DeviceQuality.js';
import { QualityController } from 'engine/quality/QualityController.js';
import { createGltfLoader, initGltfLoaderSupport, disposeGltfLoaderSupport } from 'engine/loaders/GltfLoaderSupport.js';
import { applyPendingDowngrade } from 'engine/LevelDetail.js';
import { ViewModelLayer } from 'engine/ViewModelLayer.js';
import { renderViewModelOverlay, syncViewModelLayer } from 'engine/GameEngineViewModel.js';
import { WebGPURenderer, RenderPipeline } from 'three/webgpu';
import BloomNode from 'three/addons/tsl/display/BloomNode.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
// Only the post-FX passes the engine keeps fields for are imported here; the
// TSL nodes and the composer chain assembly live in GameEnginePostFx.ts.
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { rebuildComposerPasses, syncColorGrade } from 'engine/GameEnginePostFx.js';
import { ColorGradeState } from 'engine/ColorGradeNode.js';
import {
    addSceneWarmedUpCallback,
    runLevelPreload,
    runLoadedSceneWarmup,
    runPlayerCharacterPreload,
    runNpcSkeletonPreload,
    runAudioPreload,
    runSceneWarmup,
    DEFAULT_WARMUP_PROGRESS,
    type WarmupProgressFn,
} from 'engine/GameEngineWarmup.js';
import { applyEngineWeatherConfig } from 'engine/weather/WeatherEngineBridge.js';
import type { WeatherSystem } from 'engine/weather/WeatherSystem.js';

// The renderer field is typed THREE.WebGLRenderer in EngineLike. Under WebGL
// mode the field actually is a THREE.WebGLRenderer; under WebGPU mode we cast
// WebGPURenderer through unknown so other subsystems compile unchanged.
// Subsystems that need a real WebGL context (EffectComposer, AO/DOF/outline
// passes, GaussianSplatExporter, ScreenRecorder) work natively under WebGL
// mode and are guarded out of the rendering path under WebGPU mode.
// The four engine-side materials that use TSL NodeMaterials (VoxelWorld,
// VoxelShadowSystem, SkyboxMaterialHelper, CurvedGroundShader) branch on the
// active renderer type to pick NodeMaterial vs classic THREE material.
import { setActiveRendererType, getActiveBackend, rendererBackendReady, isWebGpuActive, type RendererBackend } from 'engine/RendererType.js';
import { advanceGameplayTimers, clearGameplayTimers } from 'engine/GameplayTimers.js';
import { SkyboxMaterialHelper } from 'engine/loaders/SkyboxMaterialHelper.js';
import { EngineWaterFeatures, resolveOpenWaterConfig } from 'engine/water/EngineWaterFeatures.js';
import type { OceanSurface } from 'engine/water/OceanSurface.js';
import { queryWorldCenter, queryWorldHeightAt } from 'engine/WorldQueries.js';
import {
    queryGroundPlacement,
    DEFAULT_GROUND_PLACEMENT_OPTIONS,
    type GroundPlacement,
    type GroundPlacementOptions,
} from 'engine/GroundPlacement.js';
import { applyWebGPUPolygonOffsetCacheFix } from 'engine/WebGPUPolygonOffsetFix.js';
import { applyWebGPUSwizzleFix } from 'engine/WebGPUSwizzleFix.js';
import { DEFAULT_RENDERER_TYPE } from 'engine/config.js';
import { readInitialRendererType, reloadIntoRendererType } from 'engine/RendererPreference.js';
export type RendererType = 'webgl' | 'webgpu';
type RendererField = THREE.WebGLRenderer & { domElement: HTMLCanvasElement };
const asRendererField = (r: WebGPURenderer | THREE.WebGLRenderer): RendererField => r as unknown as RendererField;
const isWebGpuRenderer = (r: unknown): boolean =>
    (r as { isWebGPURenderer?: boolean } | null)?.isWebGPURenderer === true;

// All renderer sizing reads window.innerWidth/innerHeight. During a fresh iframe
// navigation (e.g. the creator reloading the preview after publish) those can be
// momentarily 0 before layout settles. WebGL tolerates a 0-size drawing buffer,
// but WebGPU hard-fails: it builds a 0x0 swapchain/depthBuffer and then errors
// on every frame ("texture size ... is empty"). Floor every dimension at 1 so
// the swapchain is always valid; animate() re-syncs to the real size once it
// arrives (the window never fires a resize event for the 0 → real transition).
const viewportSize = (): { width: number; height: number } => ({
    width: Math.max(1, window.innerWidth),
    height: Math.max(1, window.innerHeight),
});

// Scratch vector for the per-frame size re-sync in animate(); avoids allocation.
const _rendererSizeScratch = new THREE.Vector2();

// Dispose a material AND every texture hanging off it. material.dispose() only
// frees the shader program, so the maps have to be walked by hand to give the
// GPU memory back. Names vary per material type, hence the structural sweep.
const disposeMaterialAndTextures = (material: THREE.Material): void => {
    for (const value of Object.values(material as unknown as Record<string, unknown>)) {
        const texture = value as { isTexture?: boolean; dispose?: () => void } | null;
        if (texture && typeof texture === 'object' && texture.isTexture && typeof texture.dispose === 'function') {
            texture.dispose();
        }
    }
    material.dispose();
};

import { EditorManager } from 'editor/EditorManager.js';
import { genreRegistry, type GenreGameInterface } from 'engine/GenreRegistry.js';
import { GenreLoader } from 'engine/GenreLoader.js';
import { TraversalChallengeSystem } from 'engine/TraversalChallengeSystem.js';
import { MechanismSystem } from 'engine/MechanismSystem.js';
import { SmartObjectSystem } from 'engine/SmartObjectSystem.js';
import { BuildingSystem } from 'engine/BuildingSystem.js';
import { resolveWorldTheme } from 'engine/hud/resolveWorldTheme.js';
import type { GaussianSplatRenderer } from 'engine/GaussianSplatRenderer.js';
import { ScreenRecorder } from 'debug/ScreenRecorder.js';
import { getGameEventLog, type GameEventInput, type SynthSoundRecipe } from 'engine/recording/GameEventLog.js';
import { CameraPathEditor } from 'debug/CameraPathEditor.js';
import type { GaussianSplatEditor } from 'debug/GaussianSplatEditor.js';
import { PvsController } from 'debug/PvsController.js';
import { frameSpanRecorder } from 'debug/FrameSpanRecorder.js';
import { ensureSplatViewController, refreshSplatView as applySplatView } from 'engine/SplatViewMode.js';
import type { VoxelWorld } from 'engine/VoxelWorld.js';
import type { EngineLike, WorldProfileData, GameData, PlayerControllerLike, BlockCharacterFactoryType, CharacterModificationsFunction, BloomConfig, RenderConfig, ColorGradingConfig, VignetteConfig, FogConfig, LightingConfig, DofConfig, AoConfig, StartupUiMode, GaussianSplatConfig, Vector3Like, SpawnPoint, WeatherConfig, OpenWaterConfig } from 'types/game.js';
import type { MobileActionSpec } from 'engine/MobileActionSpec.js';
import { getAssetUrlById, resolveNpcCharacterUrl } from 'types/game.js';
import { AnimalRegistry } from 'engine/animal/AnimalRegistry.js';
import { DynamicObjectManager } from 'engine/DynamicObjectManager.js';
import { initDecalSystem, getDecalSystem, type DecalSystemConfig } from 'engine/VoxelDecalSystem.js';
import { initVoxelCarveSystem, getVoxelCarveSystem } from 'engine/voxelcarve/VoxelCarveSystem.js';
import { initHitDebrisSystem, getHitDebrisSystem, disposeHitDebrisSystem } from 'engine/HitDebrisSystem.js';
import { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import type { PhysicsWorld2D } from 'engine/physics/PhysicsWorld2D.js';
import { effectivePhysicsMode, type PhysicsMode } from 'engine/physics/PhysicsModeRule.js';
import { resolveGameplayPlaneZ, resolvePhysicsPlane, type PhysicsPlane } from 'engine/GameplayPlane.js';
import { VoxelDebrisManager } from 'engine/VoxelDebrisManager.js';
import { voxelObjectDebris } from 'engine/VoxelObjectDebris.js';
import { boneVoxelLimbs } from 'engine/effects/BoneVoxelShatter.js';
import { applyBloomTint } from 'engine/effects/BloomTint.js';
import { PerfStatsCollector } from 'engine/PerfStatsCollector.js';
import { updateWebGpuSplatMeshes } from 'engine/splats/WebGpuSplatMesh.js';
import { updatePointLightPoolsFromCamera } from 'engine/PointLightPool.js';
import { installAmbientFloorLight, applyAmbientFloor } from 'engine/AmbientFloorLight.js';
import { shatterScheduler } from 'engine/effects/ShatterScheduler.js';
import { applySunDirection, resetSunDirection } from 'engine/SunDirection.js';
import { EnvironmentLightSystem, DEFAULT_ENVIRONMENT_LIGHT_OPTIONS } from 'engine/EnvironmentLightSystem.js';
import { FrameTimer, LegacyClock } from 'engine/FrameTimer.js';
import type { DoorSystem } from 'engine/doors/DoorSystem.js';
import { DoorEngineBridge } from 'engine/doors/DoorEngineBridge.js';
import { getInteractionManager, resetInteractionManager } from 'engine/InteractionManager.js';
import { asPlayerPhysics, createPlaneLockedPhysics, queryPhysicsFor, type PlaneLockedPhysics } from 'engine/physics/PlaneLockedPhysics.js';
import { DropZoneComponent } from 'engine/DropZoneComponent.js';
import { clearCarryEventListeners } from 'engine/CarryableComponent.js';
import { setVoxelObjectEngine } from 'engine/VoxelObject.js';
import { getPlayProgress, buildAchievementDefMap } from 'engine/progress/PlaySessionClient.js';
import { getLoadProgress } from 'engine/progress/LoadProgress.js';
import { t } from 'engine/i18n/index.js';
import { AchievementToast } from 'engine/progress/AchievementToast.js';
import { installEngineProgress } from 'engine/progress/installEngineProgress.js';
import { setBlockCharacterPoseVersion } from 'engine/BlockCharacterRenderer.js';
import { setEnvironmentObjectSystemEngine, getActiveEnvironmentObjectSystem } from 'engine/EnvironmentObjectSystem.js';
import { LevelManager, type LoadLevelOptions } from 'engine/levels/LevelManager.js';
import { setActiveLevelManager } from 'engine/levels/levelManagerRegistry.js';
import { LevelEngineBridge } from 'engine/levels/LevelEngineBridge.js';
import { applyBootLevelOverride, levelSpawnPoints, mergeEffectiveProfile, resolveLevels, type LoadGameOptions } from 'engine/levels/levelResolve.js';
export type { LoadGameOptions } from 'engine/levels/levelResolve.js';
import { getLaunchParams, type LaunchParams } from 'engine/LaunchParams.js';
import { publishLeaderboard, type LeaderboardDeclaration } from 'engine/gamedata/LeaderboardManifest.js';
import { AgentAvoidanceSystem, setGlobalAgentAvoidance } from 'engine/AgentAvoidance.js';
import { PathConflictAvoidanceSystem, setGlobalPathConflictAvoidance, getGlobalPathConflictAvoidance } from 'engine/PathConflictAvoidance.js';
import { getGlobalCrowd } from 'engine/npc/crowd/CrowdAgents.js';
import { getGlobalCrowdSolver } from 'engine/npc/crowd/CrowdSolver.js';
import { getGlobalCrowdRenderer } from 'engine/npc/crowd/CrowdRenderer.js';
import { getGlobalLodScheduler } from 'engine/character/CharacterLodScheduler.js';
import { NpcController } from 'engine/npc/core/NpcController.js';
import { getGlobalNavMesh } from 'engine/VoxelNavMesh.js';
import { VideoPlayer, type VideoPlayOptions } from 'engine/VideoPlayer.js';
import { AudioPlayer } from 'engine/AudioPlayer.js';
import { AIService } from 'engine/AIService.js';
import { VoiceInput } from 'engine/VoiceInput.js';
import { PushToTalk, type PushToTalkOptions } from 'engine/PushToTalk.js';
import { ScreenshotService } from 'engine/ScreenshotService.js';
import { DEFAULT_GAME_DATA_SERVICE_OPTIONS, GameDataService } from 'engine/gamedata/GameDataService.js';
import { GAME_DATA_SERVICE_URL } from 'engine/config.js';
import { safePostMessageToCreator } from 'engine/CreatorMode.js';
import { GamePersistence } from 'engine/persistence/GamePersistence.js';
import type { GhostRacing } from 'engine/replay/GhostRacing.js';
import { createPlayerIdentity, installGhostRacing, type PlayerIdentitySetup } from 'engine/replay/installGhostRacing.js';
import type { LeaderboardIdentity } from 'engine/replay/GhostIdentity.js';
import { LocalStorageAdapter } from 'engine/persistence/StorageAdapter.js';
import { prewarmPlayerToken, installCloudSaves, gateCloudSaves, disposeCloudSaves } from 'engine/persistence/EngineCloudSaves.js';
import { GameState, type GameStateManager } from 'engine/GameStateManager.js';
import { DEFAULT_END_GAME_OPTIONS, showEndOverlay, type EndGameOptions } from 'engine/ui/EndScreen.js';
import { setPauseButtonHidden } from 'engine/ui/pauseButtonPolicy.js';
import { isEndScreenComponent, type GameUIComponent, type UISlot } from 'engine/ui/GameUIComponent.js';
import {
    DEFAULT_SCREEN_TRANSITION, setScreenTransition as applyScreenTransition, type ScreenTransitionOptions,
} from 'engine/ui/modalCard.js';
import { GaussianSplatExporter } from 'engine/GaussianSplatExporter.js';
import { VoxelObjectBuilder } from 'engine/builders/VoxelObjectBuilder.js';
import { AssetSpawner, DEFAULT_SPAWN_ASSET_OPTIONS, type SpawnAssetOptions, type SpawnedAsset } from 'engine/AssetSpawner.js';
import { NpcRegistry, type RegisterNpcOptions } from 'engine/npc/core/NpcRegistry.js';
import { createNpcManager } from 'engine/npc/core/NpcManagerHelper.js';
import { NpcHandleImpl, type NpcHandle } from 'engine/npc/core/NpcHandle.js';
import type { INpcBehavior } from 'engine/npc/INpcBehavior.js';
import { BlockRegistry } from 'engine/BlockRegistry.js';
import { PlayerVisibility } from 'engine/PlayerVisibility.js';
import {
    configureDirectionalShadow,
    resolveShadowDistance,
    resolveShadowMapSize,
    updateShadowCameraPosition as computeShadowCameraPosition,
    DEFAULT_SHADOW_DISTANCE,
    type ShadowConfig,
} from 'engine/ShadowCamera.js';

// Definitions moved to engine/ShadowCamera.ts; re-exported so existing
// importers (published game code included) keep resolving them from here.
export { DEFAULT_SHADOW_DISTANCE };
export type { ShadowConfig };

// world.json `renderConfig.toneMapping` name → the THREE tone-mapping constant.
// A missing or unknown name falls back to ACESFilmic (see applyRenderConfig).
const TONE_MAPPING_BY_NAME: Record<string, THREE.ToneMapping> = {
    aces: THREE.ACESFilmicToneMapping,
    neutral: THREE.NeutralToneMapping,
    reinhard: THREE.ReinhardToneMapping,
    linear: THREE.LinearToneMapping,
    cineon: THREE.CineonToneMapping,
};

export class GameEngine implements EngineLike {
    container: HTMLElement;
    scene: THREE.Scene | null;
    /** The active render camera. Normally the default perspective camera, but
     *  swapped to an orthographic camera while the top-down "fit whole world"
     *  mode is active (see TopDownCamera.setFitWorld / setRenderCamera). */
    camera: THREE.PerspectiveCamera | THREE.OrthographicCamera | null;
    /** The default perspective camera created at boot. Camera controllers always
     *  receive this; setRenderCamera() restores it when ortho mode ends. */
    private defaultPerspectiveCamera: THREE.PerspectiveCamera | null = null;
    renderer: THREE.WebGLRenderer | null;
    physicsWorld: PhysicsWorld | null;
    physicsWorld2D: PhysicsWorld2D | null;
    /** 2D lane only: `physicsWorld2D` behind the 3D `PhysicsWorld` surface (engine/physics/PlaneLockedPhysics.ts). */
    private planeLockedPhysics: PlaneLockedPhysics | null = null;
    genreModule: GenreGameInterface | null;
    /** Engine-owned achievement-unlock popup (art + name + XP; queues multiples). */
    private readonly achievementToast = new AchievementToast();
    private traversalChallenges: TraversalChallengeSystem | null = null;
    private mechanisms: MechanismSystem | null = null;
    private buildings: BuildingSystem | null = null;

    /**
     * Data-driven mechanism registry (world.json `mechanisms[]`). Game code
     * uses it to read custom-mechanism config (getSpec) and to bind custom
     * mechanisms into the editor's editable-parameter contract (registerCustom).
     */
    public getMechanismSystem(): MechanismSystem | null {
        return this.mechanisms;
    }

    /**
     * The smart-object runtime (assets with `smartObject` parts — windmill
     * blades, ferris-wheel cabins). Created on demand: the environment object
     * system attaches each placed instance as it builds it, and game code uses
     * it to change a part's speed or stop it.
     */
    public getSmartObjectSystem(): SmartObjectSystem {
        this.smartObjects ??= new SmartObjectSystem();
        return this.smartObjects;
    }

    /**
     * Typed spawn points from the unified `worldProfileData.spawnPoints` array.
     * `type` filters (`'player' | 'npc' | 'animal' | 'vehicle' | ...` — open
     * vocabulary); omit it for all entries. The engine consumes `player`
     * entries itself (start position + multiplayer spread); every other type
     * is a placement contract for game code: spawn your NPC/animal/vehicle at
     * each point using its `params` (archetype, behavior, species, ...).
     */
    public getSpawnPoints(type?: string): SpawnPoint[] {
        // Levels mode: the active level's spawn points win, global set is the fallback.
        const pts = levelSpawnPoints(
            this.getGameData()?.worldProfileData,
            this.levelManager?.getActiveLevel() ?? null,
        );
        return type ? pts.filter((p) => p.type === type) : pts;
    }
    genreRegistry: typeof genreRegistry;
    loader: GLTFLoader | null;
    /**
     * Retained for backward compatibility with published game code only — the
     * engine itself no longer reads it. Both `getDelta()` and `getElapsedTime()`
     * MUTATE this clock (getElapsedTime calls getDelta internally), so any
     * mid-frame caller used to steal part of the frame delta from animate().
     * New code wants `getDeltaTime()`, `getElapsedTime()` (gameplay time), or
     * `getAmbienceTime()` (clock time that keeps running in pause) instead.
     */
    clock: LegacyClock;
    editorManager: EditorManager | null;
    gameStateManager?: GameStateManager;
    isWindowFocused: boolean;
    /** True while the tab is (or was last seen) hidden. Distinct from the
     *  frame-timer's delta discard, which is consumed by the next tick. */
    private _wasTabHidden = false;
    // Set once after physics permanently halts, so the "gameplay frozen" notice logs only once.
    private _physicsHaltedNotified = false;
    isGaussianSplatMode: boolean;
    gaussianSplatRenderer: GaussianSplatRenderer | null; // First/main renderer
    gaussianSplatRenderers: GaussianSplatRenderer[]; // Array of all splat renderers
    activeSplatIndex: number; // Index of currently active splat for editing
    private colliderEditor: GaussianSplatEditor | null = null; // Editor for splat transforms
    private screenRecorder: ScreenRecorder | null = null;
    private cameraPathEditor: CameraPathEditor | null = null;
    /** Geometry-agnostic PVS owner — bakes/culls visibility for the terrain VoxelWorld or a splat's collider world. */
    pvsController: PvsController | null = null;
    private playerController: PlayerControllerLike | null = null;
    /** Multi-level runtime (levels mode only; null for legacy single-world games). */
    private levelManager: LevelManager | null = null;
    private levelBridge: LevelEngineBridge | null = null;
    private vehicleSpawner: import('./VehicleSpawner.js').VehicleSpawner | null = null;
    private vehicleManager: import('./VehicleManager.js').VehicleManager | null = null;
    private spawner: import('./Spawner.js').Spawner | null = null;
    private playerLoader: import('./loaders/PlayerLoader.js').PlayerLoader | null = null;
    private playerVisibility: import('./PlayerVisibility.js').PlayerVisibility;
    private npcRegistry: NpcRegistry | null = null;
    private _pointerLockManager: import('./PointerLockManager.js').PointerLockManager | null = null;
    private animalRegistry: AnimalRegistry;
    private dynamicObjectManager: DynamicObjectManager;
    blockCharacterFactory: BlockCharacterFactoryType | undefined = undefined;
    applyCharacterModifications: CharacterModificationsFunction | undefined = undefined;
    private currentGameData: GameData | null = null;
    /** Side-on 2D games: the locked gameplay plane's Z (see engine/GameplayPlane.ts). */
    private gameplayPlaneZ: number | null = null;
    /** 2D lane: which world plane the Rapier 2D world simulates (engine/GameplayPlane.ts). */
    private physicsPlane: PhysicsPlane = { orientation: 'xy', planeZ: 0 };
    private worldShardSync: import('./networking/WorldShardSync.js').WorldShardSync | null = null;
    private videoPlayer: VideoPlayer;
    private audioPlayer: AudioPlayer | null = null;
    private aiService: AIService;
    private voiceInput: VoiceInput;
    private pushToTalk: PushToTalk;
    private screenshotService: ScreenshotService;
    /**
     * Automatic quality adaptation. Installed once here rather than exposed through a
     * setter, per `docs/engine-options-pattern.md`; `crashRescued` is whether the level
     * detail crash rescue already fired this boot, which halves what this loop may spend.
     */
    readonly quality: QualityController;
    private gameDataService: GameDataService;
    private gamePersistence: GamePersistence | null = null;
    private ghostRacing: GhostRacing | null = null;
    /** Shared by ghost racing and by game code writing its own boards. */
    private playerIdentity: PlayerIdentitySetup | null = null;
    /** Set by loadGame; challenge links and the identity mint both need it. */
    private loadedGameId: string = '';
    private gaussianSplatExporterInstance: GaussianSplatExporter | null = null;
    /** Main-screen pre-play picks (selection id → option/level id); per-load. */
    private preGameSelections: Record<string, string> = {};
    private readonly uiComponents: Map<UISlot, GameUIComponent> = new Map();
    private uiSlotChangeHandler: ((slot: UISlot) => void) | null = null;
    /** Engine-owned registry for `worldProfileData.customBlockTypes`. Loaded
     *  before the genre's WorldGenerator runs so terrain.groundBlockType and
     *  other name-based lookups resolve consistently. */
    readonly blocks: BlockRegistry = new BlockRegistry();

    // FPS capping
    private lastFrameTime: number = 0;
    private static readonly ACTIVE_FRAME_INTERVAL = 1000 / 60;  // 60 FPS
    private static readonly PAUSED_FRAME_INTERVAL = 1000 / 30;  // 30 FPS
    /** ID returned by the current requestAnimationFrame chain; used to cancel stale chains on reload. */
    private _animFrameId: number = 0;

    // Update counter, including iterations that hold rendering during shader warmup.
    private static _frameCount: number = 0;
    /** Completed animation-loop renders for this engine, excluding forced warmup/capture draws. */
    private renderedFrameCount = 0;

    private shadowConfig: ShadowConfig;
    private directionalLight: THREE.DirectionalLight | null;
    private shadowUnitsPerTexel = 0;
    /**
     * WebGPU only: the rescue rung turned off a sun shadow that had a map allocated, and it
     * stays off until the next engine. three r185 cannot turn it back on live. Render objects
     * that stayed culled while it was off never changed cache key, so they keep the disposed
     * ShadowNode in their graph, and its first update throws "Cannot read properties of null
     * (reading 'depthTexture')". Turning it OFF is safe: every render object's key changes.
     */
    private sunShadowParked = false;
    private lastSnappedCenter: THREE.Vector3 | null = null;

    // Pre-allocated temp objects for getWorldHeightAt()
    // Bloom post-processing — EffectComposer/UnrealBloomPass is the WebGL path;
    // bloomPipeline/bloomNode is the WebGPU path. Only one is active per renderer.
    composer: EffectComposer | null = null;
    private bloomPass: UnrealBloomPass | null = null;
    private bloomPipeline: RenderPipeline | null = null;
    private bloomNode: BloomNode | null = null;
    private bloomConfig: { enabled: boolean; strength: number; radius: number; threshold: number } | null = null;

    // First-person weapon view model. Constructed once and inert until a system
    // attaches something; see ViewModelLayer for why it owns its own scene.
    private viewModelLayer: ViewModelLayer | null = null;
    /** Last value of viewModelPassRequired(), so the WebGPU graph rebuilds on change. */
    private viewModelWasVisible = false;
    /** Once a view model has existed, its pass stays in the graph — see viewModelPassRequired. */
    private viewModelPassLatched = false;

    // Weather (rain + wet surfaces). Wiring lives in WeatherEngineBridge.
    private weatherSystem: WeatherSystem | null = null;
    private currentWeatherConfig: WeatherConfig | null = null;

    // Active renderer backend. Updated by setRendererType / recreateRenderer.
    private currentRendererType: RendererType = 'webgl';

    // Renderer color pipeline — cached so recreateRenderer() can re-apply it.
    private currentRenderConfig: RenderConfig | null = null;

    // Live grade + vignette uniforms (both backends) — owned for the engine's
    // life so runtime changes write values instead of rebuilding the pipeline.
    private colorGrade = new ColorGradeState();

    // Scene fog + sky fallback — cached so applyFogConfig() can re-apply
    // after a renderer swap or skybox-load failure.
    private currentFogConfig: FogConfig | null = null;

    // Scene lighting (sun / ambient / sky brightness) — cached so
    // applyLightingConfig() can re-apply and SkyboxLoader can read the sky
    // brightness when the skybox mesh arrives after loadGame.
    private currentLightingConfig: LightingConfig | null = null;

    // Light-emitting environment props (world.json assets[].light — torches,
    // braziers). Created per game in loadGame() when any placed asset emits.
    private environmentLights: EnvironmentLightSystem | null = null;

    // Data-driven dungeon doors + key pickups (world.json doors[] / keyItems[]).
    // Created per game in loadGame() only when the world declares any; the
    // wiring (toast, proximity sources, network sync, level re-init) lives in
    // engine/doors/DoorEngineBridge.ts.
    private doorBridge: DoorEngineBridge | null = null;

    // Smart objects: placed props whose .vxl carries moving parts (windmill
    // blades, ferris wheels). Created on first attach by the environment object
    // system, ticked from the simulation loop, disposed with the world systems.
    private smartObjects: SmartObjectSystem | null = null;

    // Callbacks fired each frame AFTER all updates (genre, camera, NPCs) and
    // immediately BEFORE render. The place to glue a visual to the camera's
    // final per-frame transform — e.g. a first-person view-model weapon.
    // Syncing earlier (during genre.update, before the camera controller runs)
    // leaves the visual one frame behind the smoothly-interpolated camera and
    // it twitches while moving/turning.
    private readonly beforeRenderCallbacks = new Set<() => void>();
    
    // Selection outline post-processing
    private outlinePass: OutlinePass | null = null;
    // Shared outline-selection state — backed by outlinePass under WebGL and by
    // the TSL outline() node under WebGPU. Mutated in place so both backends
    // see the latest list without rebuilding the pipeline.
    private outlineSelectedObjects: THREE.Object3D[] = [];
    private outlineEnabled = false;

    // Depth-of-field + ambient-occlusion post passes (Phase 5). Cached configs
    // let recreateRenderer() and toggle paths rebuild from the same source.
    private bokehPass: BokehPass | null = null;
    private gtaoPass: GTAOPass | null = null;
    private currentDofConfig: DofConfig | null = null;
    private currentAoConfig: AoConfig | null = null;

    // Bound window/document listeners for proper removal on dispose
    private boundFocusListeners: { target: EventTarget; event: string; handler: EventListener; options?: AddEventListenerOptions }[] = [];
    
    // When true, animate() uses deltaTime = 1/60 regardless of real time.
    // Set directly by ScreenRecorder — no method calls in the hot path.
    public forceFixedDeltaTime: boolean = false;
    
    // Current frame's delta time (in seconds), updated each frame in animate()
    private _currentDeltaTime: number = 0;

    // Accumulated gameplay wall-clock time (in seconds). Advances only while
    // gameplay is running (not paused), updated each frame in animate().
    private _elapsedGameplayTime: number = 0;

    /** The engine's own frame clock. Owns the per-frame delta and the ambience
     *  time base — deliberately NOT `this.clock`, see FrameTimer's header. */
    private readonly frameTimer = new FrameTimer();

    // Performance stats collector for debug overlay
    private perfStatsCollector: PerfStatsCollector | null = null;
    /** Wall-clock timestamp of the previous animate frame, for per-frame spike timing. */
    private _lastFrameTs = 0;
    /** Reused scratch for the camera world position passed to PointLightPools each frame. */
    private readonly _lightPoolFocus = new THREE.Vector3();

    private startGameHandler: (() => void) | null = null;
    private playButtonVisibilityHandler: ((visible: boolean) => void) | null = null;
    private startupUiModeHandler: ((mode: StartupUiMode) => void) | null = null;
    private muteControlEnabled = false;
    // Audio mute + usage tracking. `_audioUsed` flips true the first time the game
    // plays a sound or grabs the shared audio context/destination — the pause menu
    // uses it to auto-show a mute toggle. `_audioMuted` is the single source of
    // truth for mute (shared by the pause toggle and the optional HUD button),
    // persisted per-game and applied to the master gain + shared AudioContext.
    private _audioUsed = false;
    private _audioMuted = false;
    private readonly audioMuteListeners = new Set<(muted: boolean) => void>();
    // Default M-key mute shortcut. On by default; a game that needs M for
    // something else opts out via setMuteHotkeyEnabled(false).
    private muteHotkeyEnabled = true;

    constructor(container: HTMLElement) {
        this.container = container;
        this.videoPlayer = new VideoPlayer();
        this.aiService = AIService.getInstance();
        this.voiceInput = new VoiceInput(this.aiService, () => this.handleMicrophoneReleased());
        this.pushToTalk = new PushToTalk(this.voiceInput);
        this.screenshotService = ScreenshotService.getInstance();
        // Applied here rather than waiting for the first level load, because whether a
        // crash rescue fired decides how much this loop is allowed to spend. It runs at
        // most once per page either way, so `resolveLevelDetail` later sees it done.
        const crashRescued = applyPendingDowngrade(activeQualityPolicy().deferred.levelDetail) !== null;
        this.quality = new QualityController(this, crashRescued);
        this.gameDataService = GameDataService.getInstance();
        // Play-token handshake overlaps the game-data fetch (see EngineCloudSaves).
        prewarmPlayerToken();
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.physicsWorld = null;
        this.physicsWorld2D = null;
        this.genreModule = null;
        this.genreRegistry = genreRegistry;
        this.loader = createGltfLoader();
        this.clock = new LegacyClock();
        this.editorManager = null;
        this.directionalLight = null;
        this.gaussianSplatRenderer = null;
        this.gaussianSplatRenderers = [];
        this.activeSplatIndex = 0;
        this.isGaussianSplatMode = false;
        
        this.shadowConfig = {
            // Derived from shadowDistance + device class on every shadow apply
            // (see ShadowCamera.resolveShadowMapSize) — seeded here only so
            // getShadowConfig() is coherent before setupLighting() runs.
            mapSize: resolveShadowMapSize(DEFAULT_SHADOW_DISTANCE, activeQualityPolicy().live.shadowMapMaxSize),
            bias: 0.0001,
            normalBias: 0.05,
            shadowBlurRadius: 3,
            shadowDistance: DEFAULT_SHADOW_DISTANCE // meters; overridable via renderConfig.shadowDistance
        };
        
        this.isWindowFocused = true;
        this.setupWindowFocusListeners();
        this.animalRegistry = new AnimalRegistry(this);
        this.dynamicObjectManager = new DynamicObjectManager(this);
        this.npcRegistry = new NpcRegistry(this);
        // NOTE: getPlayerVisibility() on EngineLike is typed as required,
        // which means anything constructed BEFORE this line that calls
        // engine.getPlayerVisibility() in its constructor will hit
        // `undefined.setHideReason is not a function`. Keep this assignment
        // ahead of any future construction that depends on PlayerVisibility.
        this.playerVisibility = new PlayerVisibility();

        // Set engine reference for VoxelObject auto-registration with DynamicObjectManager
        setVoxelObjectEngine(this);
        // Play progress (P6 XP + achievements): installed once; never blocks start.
        installEngineProgress(this.achievementToast);
        // Module-level fallback so EnvironmentObjectSystem can load Gaussian Splat
        // assets even when the WorldGenerator template did not call setEngine().
        setEnvironmentObjectSystemEngine(this);
        // Install the engine-wide agent-to-agent avoidance system. NavigationComponent
        // looks it up via getGlobalAgentAvoidance() during path following so NPCs,
        // animals, players, and vehicles steer around each other instead of
        // deadlocking at chokepoints.
        setGlobalAgentAvoidance(new AgentAvoidanceSystem());
        // Install the path-conflict avoidance system. Round-robins through
        // registered NPCs/animals once per tick, samples their forward path,
        // and asks any agent whose path is blocked by a peer to re-plan
        // around them as virtual obstacles. Complements AgentAvoidance's
        // reactive per-frame steering.
        setGlobalPathConflictAvoidance(new PathConflictAvoidanceSystem());

        this.init();
    }
    
    /**
     * Get the current update count, including iterations that hold rendering during warmup.
     * Useful for staggering updates across multiple objects.
     */
    static getFrameCount(): number {
        return GameEngine._frameCount;
    }

    /** Completed animation-loop renders; held or failed renders never advance this counter. */
    getRenderedFrameCount(): number {
        return this.renderedFrameCount;
    }

    /**
     * Get the current frame's delta time in seconds.
     * This is the time elapsed since the last frame, capped and adjusted for recording.
     */
    getDeltaTime(): number {
        return this._currentDeltaTime;
    }

    /**
     * Get the total accumulated gameplay wall-clock time in seconds.
     *
     * This sums the real per-frame delta times and advances only while gameplay
     * is running (GameState.PLAYING) — paused/menu/editor time is not counted.
     * Use this as the source of truth for on-screen timers/clocks, cooldowns,
     * and score-over-time. Do NOT re-derive elapsed time by accumulating an
     * assumed fixed frame delta — that drifts under variable frame rate and runs
     * slow.
     *
     * For ambience that must keep moving while paused or in the editor (rain,
     * torch flicker, shader time), use getAmbienceTime() instead.
     */
    getElapsedTime(): number {
        return this._elapsedGameplayTime;
    }

    /**
     * Total accumulated CLOCK time in seconds — advances every rendered frame,
     * including while paused, in menus and in the editor. This is the time base
     * for ambience (weather, flickering lights, animated materials), which
     * should not freeze when gameplay does.
     *
     * Prefer this over `clock.getElapsedTime()`: THREE's clock reader is
     * destructive and stealing from it starves the frame delta the physics
     * world runs on (see FrameTimer). This accumulator is also tab-hide aware —
     * a five-minute hide advances it by one frame, not five minutes, so wave
     * and rain phase resume where they left off.
     */
    getAmbienceTime(): number {
        return this.frameTimer.ambienceTime;
    }

    private isGameplayRunning(): boolean {
        return this.gameStateManager?.isState(GameState.PLAYING) ?? true;
    }

    /**
     * Debug ablation: when true, ALL NPC and animal work is skipped — behaviour
     * updates, the LOD scheduler, the crowd solver — and their characters are
     * hidden so their draw calls go too. Everything else (terrain, environment,
     * physics, player, weather) runs exactly as normal.
     *
     * The point is to answer "what would this game cost with no NPCs at all?"
     * in one keypress, instead of inferring it from spans that only ever measure
     * the NPCs that happen to be awake. Not a shipping feature — a measuring tool.
     */
    private _debugDisableNpcs: boolean = false;
    setDebugDisableNpcs(v: boolean): void {
        if (this._debugDisableNpcs === v) return;
        this._debugDisableNpcs = v;
        // Hide/show once on the transition rather than every frame.
        this.npcRegistry?.setAllCharactersVisible(!v);
    }
    getDebugDisableNpcs(): boolean { return this._debugDisableNpcs; }

    /**
     * Debug-only override: when true, the render loop targets ACTIVE_FRAME_INTERVAL
     * even outside of PLAYING state (so editor/menu also runs at 60 FPS).
     * Does NOT affect physics pause behavior — only the frame rate cap.
     */
    private _debugForceActiveRate: boolean = false;
    setDebugForceActiveRate(v: boolean): void { this._debugForceActiveRate = v; }
    getDebugForceActiveRate(): boolean { return this._debugForceActiveRate; }
    private shouldUseActiveFrameRate(): boolean { return this._debugForceActiveRate || this.isGameplayRunning(); }

    /** Frame interval (ms) the animate loop caps to right now. Single source of
     *  truth for both the loop's own cap and the reported target FPS. */
    private currentFrameInterval(): number {
        return this.shouldUseActiveFrameRate()
            ? GameEngine.ACTIVE_FRAME_INTERVAL
            : GameEngine.PAUSED_FRAME_INTERVAL;
    }

    /** Target FPS the render loop is currently capped to. Derived from the frame interval the animate loop uses. */
    getTargetFps(): number {
        return Math.round(1000 / this.currentFrameInterval());
    }

    init(): void {
        this.scene = new THREE.Scene();
        this.scene.name = 'Scene';
        // Defaults until loadGame() applies worldProfileData.fogConfig.
        this.applyFogConfig();

        const perspectiveCamera = new THREE.PerspectiveCamera(
            60,
            window.innerWidth / window.innerHeight,
            0.1,
            1000
        );
        perspectiveCamera.position.set(0, 5, 10);
        perspectiveCamera.layers.enable(0);
        perspectiveCamera.layers.enable(1);
        perspectiveCamera.layers.enable(2);
        this.camera = perspectiveCamera;
        this.defaultPerspectiveCamera = perspectiveCamera;

        // Always present, costs nothing until something is attached to it.
        // Keeping it non-null makes viewModelVisible() a state query instead of
        // a null check repeated at every call site.
        this.viewModelLayer = new ViewModelLayer();

        this.audioPlayer = new AudioPlayer(perspectiveCamera);

        this.currentRendererType = readInitialRendererType();
        setActiveRendererType(this.currentRendererType);
        this.renderer = this.createRenderer(this.currentRendererType, true);
        const { width: initWidth, height: initHeight } = viewportSize();
        this.renderer.setSize(initWidth, initHeight);
        // Capped by the device quality tier: every render target the post chain allocates
        // scales with the SQUARE of this, and an iPhone reports 3. See RenderPixelRatio.ts.
        this.renderer.setPixelRatio(resolveRenderPixelRatio(window.devicePixelRatio, activeQualityPolicy().live.maxPixelRatio));

        // Ensure viewport is set to full window size
        this.renderer.setViewport(0, 0, initWidth, initHeight);
        
        // Setup color pipeline (tone mapping + exposure + output color space).
        // Defaults until loadGame() applies worldProfileData.renderConfig.
        this.applyRenderConfig();

        this.container.appendChild(this.renderer.domElement);

        // WebGL context loss — mobile OS can reclaim GPU memory at any time.
        // When this happens the renderer is a black screen. Reload to recover.
        let contextLostTimer: ReturnType<typeof setTimeout> | null = null;
        this.renderer.domElement.addEventListener('webglcontextlost', (e) => {
            e.preventDefault(); // allow potential context restore
            console.warn('🎮 WebGL context lost — will reload if not restored');
            // If context isn't restored within 3s, force reload
            contextLostTimer = setTimeout(() => {
                console.warn('🎮 WebGL context not restored — reloading');
                window.location.reload();
            }, 3000);
        });
        this.renderer.domElement.addEventListener('webglcontextrestored', () => {
            if (contextLostTimer) { clearTimeout(contextLostTimer); contextLostTimer = null; }
            console.log('🎮 WebGL context restored — reloading for clean state');
            // Three.js cannot fully recover all GPU resources; safest to reload.
            window.location.reload();
        });

        this.renderer.domElement.addEventListener('mousedown', () => {
            safePostMessageToCreator({ type: 'GAME_IFRAME_FOCUSED' });
        });

        this.setupBloom({
            enabled: false,
            strength: 0.3,
            radius: 0.3,
            threshold: 0.9
        });

        this.setupLighting();
        this.editorManager = new EditorManager(this as any);
        this.screenRecorder = new ScreenRecorder(this.renderer, this);
        this.cameraPathEditor = new CameraPathEditor(this.scene, this.camera, this.renderer.domElement);
        this.cameraPathEditor.setGameDataCallback(() => this.getGameData());
        // Neutral PVS owner. Drives the terrain VoxelWorld by default; a splat
        // registers its collider world + grids through the providers below.
        this.pvsController = new PvsController({
            scene: this.scene!,
            camera: this.camera!,
            getActiveVoxelWorld: () => this.getActivePvsVoxelWorld(),
            getActiveVoxelWorldBounds: () => this.getActivePvsVoxelWorldBounds(),
            getGameData: () => this.getGameData(),
            getActiveEnvObjectId: () => this.getActivePvsEnvObjectId(),
        });
        this.pvsController.setSplatRenderersAccessor(() => this.gaussianSplatRenderers);
    }

    /** The splat renderer whose collider world currently holds chunks (the PVS bake target), if any. */
    private getActivePvsSplatRenderer(): GaussianSplatRenderer | null {
        return this.gaussianSplatRenderers.find(r => (r.getVoxelWorld?.()?.getChunkCount() ?? 0) > 0) ?? null;
    }

    /** Voxel world the PVS operates on: an active splat's collider world if present, else the terrain. */
    private getActivePvsVoxelWorld(): VoxelWorld | null {
        return this.getActivePvsSplatRenderer()?.getVoxelWorld?.() ?? this.dynamicObjectManager.getMainVoxelWorld();
    }

    private getActivePvsVoxelWorldBounds(): { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } | null {
        const splat = this.getActivePvsSplatRenderer();
        if (splat) return splat.getVoxelWorldBoundsRaw();
        // getTerrainBounds covers BOTH runtimes: the procedural VoxelWorld's bounds, else the
        // registered baked (.vwld) terrain's. The baked fallback is inert for PVS itself
        // (generateWalkableMap is gated on an active voxel world) but lets other bounds
        // consumers — e.g. the coastal water surface — work on forged VxlScene levels.
        return this.dynamicObjectManager.getTerrainBounds();
    }

    /** Env-object id the bake belongs to (a placed splat); null for a scene-wide voxel level → worldProfile persistence. */
    private getActivePvsEnvObjectId(): string | null {
        return this.getActivePvsSplatRenderer()?.getEnvObjectId() ?? null;
    }

    /**
     * Setup bloom post-processing (internal use only). Takes a fully-resolved
     * config — applyBloomConfig() is the one place that fills in defaults — and
     * delegates pass ordering to rebuildComposerPasses().
     */
    private setupBloom(config: { enabled: boolean; strength: number; radius: number; threshold: number } | null): void {
        if (!this.renderer || !this.scene || !this.camera) return;

        this.bloomConfig = config;

        if (this.bloomConfig?.enabled) {
            console.log('🌟 Setting up bloom:', this.bloomConfig);
        } else {
            console.log('🌟 Bloom disabled');
        }

        rebuildComposerPasses(this);
    }


    /**
     * Apply depth-of-field configuration. Called from loadGame with
     * worldProfileData.dofConfig. Cached so recreateRenderer() / toggles
     * can re-apply.
     */
    private applyDofConfig(config?: DofConfig | null): void {
        if (config !== undefined) {
            this.currentDofConfig = config;
        }
        rebuildComposerPasses(this);
    }

    /**
     * Apply screen-space ambient occlusion configuration. Called from
     * loadGame with worldProfileData.aoConfig. Cached so recreateRenderer()
     * / toggles can re-apply.
     */
    private applyAoConfig(config?: AoConfig | null): void {
        if (config !== undefined) {
            this.currentAoConfig = config;
        }
        rebuildComposerPasses(this);
    }

    /**
     * Apply renderer-level color pipeline (tone mapping + exposure + output color space).
     * Called during initial renderer construction (with no config = defaults),
     * after world.json loads (config = worldProfileData.renderConfig), and from
     * recreateRenderer() to re-apply the cached config after a renderer swap.
     */
    private applyRenderConfig(config?: RenderConfig | null): void {
        if (!this.renderer) return;
        if (config !== undefined) {
            this.currentRenderConfig = config;
        }
        const cfg = this.currentRenderConfig;
        this.renderer.toneMapping = TONE_MAPPING_BY_NAME[cfg?.toneMapping ?? 'aces'] ?? THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = cfg?.exposure ?? 1.0;
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        syncColorGrade(this);

        // Directional-shadow coverage radius — exposed via renderConfig so the AI
        // editor can push shadows out to the view distance without touching three.js.
        // Without an explicit value the default shrinks to the world footprint
        // (fitShadowsToWorld re-runs post-load / per level switch, once bounds exist).
        this.fitShadowsToWorld();
    }

    /**
     * Apply scene fog + sky fallback color. Called during init() (defaults),
     * during loadGame() with worldProfileData.fogConfig, and replayable.
     * The same color drives scene.background — when no skybox sphere is added,
     * the renderer paints with this color; when a skybox mesh covers the view
     * the background color is hidden behind it.
     */
    public applyFogConfig(config?: FogConfig | null): void {
        if (!this.scene) return;
        if (config !== undefined) {
            this.currentFogConfig = config;
        }
        const cfg = resolveAtmosphereFog(this.currentLightingConfig, this.currentFogConfig);
        const enabled = cfg?.enabled ?? true;
        const colorHex = cfg?.color ?? '#87CEEB';
        const near = cfg?.near ?? 10;
        const far = cfg?.far ?? 500;
        const color = new THREE.Color(colorHex);
        this.scene.background = color;
        this.scene.fog = enabled ? new THREE.Fog(color.getHex(), near, far) : null;
    }

    /**
     * Apply scene lighting from world.json `lightingConfig` — the knob that
     * makes dark interiors and night scenes possible. All fields are
     * multipliers on the daylight defaults (1 = classic look):
     * - sun: the hardcoded DirectionalLight from setupLighting()
     * - environmentIntensity: how strongly the skybox-derived IBL
     *   (AmbientLighting → scene.environment) lights every material
     * - skyboxIntensity: brightness of the visible skybox mesh (plus
     *   scene.backgroundIntensity for the rare texture-background path)
     * Called during loadGame() and replayable at any time.
     */
    public applyLightingConfig(config?: LightingConfig | null): void {
        if (!this.scene) return;
        const previousPreset = this.currentLightingConfig?.preset;
        if (config !== undefined) {
            this.currentLightingConfig = config;
        }
        const cfg = resolveLightingConfig(this.currentLightingConfig);

        if (this.directionalLight) {
            const color = new THREE.Color(cfg?.sunColor ?? GameEngine.DEFAULT_SUN_COLOR);
            const luminance = GameEngine.relativeLuminance(color);
            const compensated = luminance > 0 ? GameEngine.DEFAULT_SUN_INTENSITY / luminance : GameEngine.DEFAULT_SUN_INTENSITY;
            const sunScale = cfg?.sunIntensity ?? 1.0;
            this.directionalLight.color.copy(color);
            this.directionalLight.intensity = compensated * sunScale;

            // A near-dark sun (dungeons, night: sunIntensity ≈ 0) casts no
            // visible shadow, but a shadow-casting directional light still
            // renders a full scene depth pass every frame. Skip it below a
            // threshold so dark interiors don't pay for an invisible shadow.
            // Set here (config-apply time), NOT per frame — toggling castShadow
            // rebuilds the light's shader on WebGPU, so it must stay one-shot.
            this.directionalLight.castShadow = this.sunCastsShadow();

            // Sun ANGLE — long dusk shadows are a direction, not an intensity.
            // Only when a game asks: the setup default (and the Gaussian-splat
            // variant of it) stays untouched otherwise.
            if (cfg?.sunElevationDeg !== undefined || cfg?.sunAzimuthDeg !== undefined) {
                applySunDirection(this.directionalLight, cfg);
            } else if (previousPreset) {
                resetSunDirection(this.directionalLight, this.isGaussianSplatMode);
            }
        }

        // Honored by both backends: WebGL multiplies it into envMapIntensity,
        // WebGPU reads it through materialEnvIntensity.
        this.scene.environmentIntensity = cfg?.environmentIntensity ?? 1.0;

        // The floor is ADDITIVE and sky-independent, so it still lifts a scene
        // whose skybox is black — which environmentIntensity alone cannot do.
        applyAmbientFloor(this.scene, cfg);

        const skyBrightness = cfg?.skyboxIntensity ?? 1.0;
        this.scene.backgroundIntensity = skyBrightness;
        const skybox = this.scene.getObjectByName('Skybox'); // SkyboxLoader.SKYBOX_NAME
        const skyUniforms = SkyboxMaterialHelper.getUniformsFromMesh(skybox);
        if (skyUniforms) {
            SkyboxMaterialHelper.setBrightness(skyUniforms, skyBrightness);
        }
        // Resolve fog after lighting as well: load and level switches apply fog first.
        if (previousPreset || cfg?.preset) this.applyFogConfig();
    }

    /** Apply weather (rain + wet surfaces) from world.json `weatherConfig`.
     *  Replayable; per-level override aware (LevelEngineBridge.applyAtmosphere).
     *  Wiring lives in WeatherEngineBridge (friend module — line-cap seam). */
    public applyWeatherConfig(config?: WeatherConfig | null): void {
        applyEngineWeatherConfig(this, config);
    }

    /** Current scene lighting config (world.json `lightingConfig`), or null for
     *  daylight defaults. SkyboxLoader reads the sky brightness from here when
     *  the skybox mesh is (re)created. */
    getLightingConfig(): LightingConfig | null {
        return resolveLightingConfig(this.currentLightingConfig);
    }

    /** Current renderer config (world.json `renderConfig`), or null for defaults.
     *  The vehicle asset loader reads `vehicleFinish` from here when it builds a
     *  VXL chassis — the finish is baked into the mesh's material at build time,
     *  so it is picked up on the next level load rather than applied live. */
    getRenderConfig(): RenderConfig | null {
        return this.currentRenderConfig;
    }

    /** Runtime color grade: merges over `renderConfig.colorGrading`. Value-only
     *  changes just write uniforms; toggling `enabled` rebuilds the pipeline. */
    public setColorGrading(config: Partial<ColorGradingConfig>): void {
        const base = this.currentRenderConfig ?? {};
        const prev = base.colorGrading;
        this.currentRenderConfig = { ...base, colorGrading: { ...prev, ...config, enabled: config.enabled ?? prev?.enabled ?? false } };
        syncColorGrade(this);
    }

    /** Runtime vignette: merges over `renderConfig.vignette` (see setColorGrading). */
    public setVignette(config: Partial<VignetteConfig>): void {
        const base = this.currentRenderConfig ?? {};
        const prev = base.vignette;
        this.currentRenderConfig = { ...base, vignette: { ...prev, ...config, enabled: config.enabled ?? prev?.enabled ?? false } };
        syncColorGrade(this);
    }

    /** Current sky/fog fallback color as a hex string. Used as the default solid
     *  background for top-down fit-world margins. */
    getSkyColorHex(): string {
        return resolveAtmosphereFog(this.currentLightingConfig, this.currentFogConfig)?.color ?? '#87CEEB';
    }

    private solidBackgroundActive = false;

    /** Whether a solid background override is active (skybox should stay hidden).
     *  The skybox loads asynchronously, so SkyboxLoader checks this when adding
     *  its mesh to avoid the skybox popping back in over the fit-world margins. */
    isSolidBackgroundActive(): boolean {
        return this.solidBackgroundActive;
    }

    /**
     * Replace the skybox with a solid background color, or restore it with `null`.
     * A straight-down orthographic view (top-down fit-world) only ever shows the
     * skybox as margins around the map, so painting them a solid color is cleaner.
     * Hides the skybox mesh and paints `scene.background`.
     */
    setSolidBackground(color: string | null): void {
        if (!this.scene) return;
        const skybox = this.scene.getObjectByName('Skybox'); // SkyboxLoader.SKYBOX_NAME
        if (color === null) {
            if (!this.solidBackgroundActive) return;
            this.solidBackgroundActive = false;
            if (skybox) skybox.visible = true;
            this.applyFogConfig();                      // restore scene.background = fog color
            if (skybox) this.scene.background = null;    // hidden behind the skybox again
            return;
        }
        this.solidBackgroundActive = true;
        if (skybox) skybox.visible = false;
        this.scene.background = new THREE.Color(color);
    }

    /**
     * Apply bloom configuration from world.json with genre-specific defaults
     * - Voxel (unless game.json artStyle is low-poly): slight bloom (enabled: true, strength: 0.15, radius: 0.2, threshold: 0.98)
     * - Low-poly voxel-genre games and other genres: no bloom by default
     */
    private applyBloomConfig(config: BloomConfig | undefined, genre: string, artStyle: string | undefined): void {
        const defaults = resolveBloomDefaults(genre, artStyle);

        this.setupBloom({
            enabled: config?.enabled ?? defaults.enabled,
            strength: config?.strength ?? defaults.strength ?? 0.6,
            radius: config?.radius ?? defaults.radius ?? 0.3,
            threshold: config?.threshold ?? defaults.threshold ?? 0.9,
        });
    }

    /**
     * Set up selection outline effect (OutlinePass).
     * Creates composer if it doesn't exist.
     */
    setupSelectionOutline(): void {
        if (!this.renderer || !this.scene || !this.camera) return;

        this.outlineEnabled = true;

        if (!isWebGpuRenderer(this.renderer) && !this.outlinePass) {
            this.outlinePass = new OutlinePass(
                new THREE.Vector2(window.innerWidth, window.innerHeight),
                this.scene,
                this.camera,
            );
            this.outlinePass.edgeStrength = 10.0;
            this.outlinePass.edgeGlow = 1.0;
            this.outlinePass.edgeThickness = 2.5;
            this.outlinePass.pulsePeriod = 0;
            this.outlinePass.visibleEdgeColor.set(0x00ffff);
            this.outlinePass.hiddenEdgeColor.set(0x00ffff);
            this.outlinePass.selectedObjects = this.outlineSelectedObjects;
        }

        rebuildComposerPasses(this);

        console.log('✨ Selection outline pass initialized');
    }

    /**
     * Set objects to be highlighted with outline effect.
     * Pass empty array to clear selection and disable the pass.
     *
     * Mutates the shared `outlineSelectedObjects` array in place so the WebGPU
     * OutlineNode (which captured the reference at pipeline-construction time)
     * picks up the new list without a pipeline rebuild.
     */
    setOutlineSelectedObjects(objects: THREE.Object3D[]): void {
        this.outlineSelectedObjects.length = 0;
        this.outlineSelectedObjects.push(...objects);
        if (this.outlinePass) {
            this.outlinePass.selectedObjects = this.outlineSelectedObjects;
            this.outlinePass.enabled = this.outlineSelectedObjects.length > 0;
        }
    }

    /**
     * Check if outline effect is available (works on both backends).
     */
    hasOutlinePass(): boolean {
        return this.outlineEnabled;
    }


    // Daylight sun defaults. worldProfileData.lightingConfig scales/overrides
    // these via applyLightingConfig() — sunIntensity is a multiplier on the
    // (luminance-compensated) default intensity, sunColor replaces the color.
    private static readonly DEFAULT_SUN_COLOR = 0xffeece;
    private static readonly DEFAULT_SUN_INTENSITY = 5.0;
    /** Below this sunIntensity multiplier the directional light stops casting
     *  shadows (invisible shadow, wasted depth pass). See applyLightingConfig. */
    private static readonly SUN_SHADOW_MIN_INTENSITY = 0.2;

    setupLighting(): void {
        if (!this.renderer || !this.scene) return;

        this.directionalLight = this.createCompensatedLight(GameEngine.DEFAULT_SUN_COLOR, GameEngine.DEFAULT_SUN_INTENSITY);
        this.directionalLight.name = 'DirectionalLight';

        // Rotate light direction for Gaussian splat mode
        if (this.isGaussianSplatMode) {
            this.directionalLight.position.set(0, 2, 1); // Rotated 90 degrees for splat lighting
        } else {
            this.directionalLight.position.set(1, 2, 1); // Normal direction
        }

        this.directionalLight.castShadow = true;

        // Configure shadow mapping and apply all settings
        this.applyShadowConfiguration();

        this.scene.add(this.directionalLight);
        this.scene.add(this.directionalLight.target);
        this.directionalLight.target.name = 'DirectionalLightTarget';

        // The ambient floor is installed ONCE and never removed — it is parked at
        // intensity 0 when a game opts out, so the scene's light count (and every
        // material's compiled shader) stays constant.
        installAmbientFloorLight(this.scene);

        // Honor a lighting config applied before the sun existed.
        this.applyLightingConfig();
    }
    
    /** Rec. 709 relative luminance of a color. Used to normalize sun intensity so
     *  a colored sun keeps the same perceived brightness as a white one. */
    private static relativeLuminance(color: THREE.Color): number {
        return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
    }

    private createCompensatedLight(color: THREE.Color | number, intensity: number): THREE.DirectionalLight {
        const light = new THREE.DirectionalLight(color, intensity);
        const luminance = GameEngine.relativeLuminance(light.color);

        // Avoid division by zero for black light.
        if (luminance > 0) {
            light.intensity = intensity / luminance;
        }

        return light;
    }

    /**
     * Re-run the shadow setup against the current `shadowConfig` and quality tier.
     *
     * Public because a quality-tier change moves the shadow map-size cap and nothing else:
     * `fitShadowsToWorld()` early-returns unless the coverage distance or the authored size
     * override changed, so routing a tier change through it would silently swallow it.
     * See `quality/DeviceQualityApply.ts`.
     */
    applyShadowConfiguration(): void {
        if (!this.renderer || !this.scene || !this.directionalLight) return;
        const hadMap = this.directionalLight.shadow.map !== null;
        this.shadowUnitsPerTexel = configureDirectionalShadow(this.renderer, this.directionalLight, this.shadowConfig);
        // Landing on the rescue rung (map size 0) with a map already allocated parks the sun's
        // shadow for the life of this engine under WebGPU — see `sunShadowParked`.
        if (this.shadowConfig.mapSize === 0 && isWebGpuActive() && hadMap) this.sunShadowParked = true;
        // A parked shadow is still off, so report it that way: getShadowConfig() is what the
        // settings UI reads to tell the player shadows come back at the next load.
        if (this.sunShadowParked) this.shadowConfig.mapSize = 0;
        // configureDirectionalShadow turns the sun's shadow off on the rescue rung but never
        // turns it back on, so re-derive it by applyLightingConfig's rule. When the value is
        // unchanged this is a no-op, so it costs no shader rebuild outside an actual change.
        this.directionalLight.castShadow = this.sunCastsShadow();
    }

    /**
     * applyLightingConfig's sun-shadow rule: a near-dark sun casts none. The rescue rung
     * and a parked shadow win, so a lighting apply cannot undo either.
     */
    private sunCastsShadow(): boolean {
        if (this.sunShadowParked || this.shadowConfig.mapSize === 0) return false;
        const sunScale = resolveLightingConfig(this.currentLightingConfig)?.sunIntensity ?? 1.0;
        return sunScale > GameEngine.SUN_SHADOW_MIN_INTENSITY;
    }

    /**
     * Re-resolve the shadow coverage radius — explicit renderConfig.shadowDistance,
     * else the default clamped to the terrain footprint — plus the explicit
     * renderConfig.shadowMapSize resolution override, and re-apply the shadow
     * setup (which re-derives the map size) when either changed. Called whenever
     * an input can have moved: render-config apply, world load, level switch.
     */
    public fitShadowsToWorld(): void {
        const distance = resolveShadowDistance(
            this.currentRenderConfig?.shadowDistance,
            this.dynamicObjectManager.getTerrainBounds(),
        );
        const mapSizeOverride = this.currentRenderConfig?.shadowMapSize;
        if (distance === this.shadowConfig.shadowDistance && mapSizeOverride === this.shadowConfig.mapSizeOverride) return;
        this.shadowConfig.shadowDistance = distance;
        this.shadowConfig.mapSizeOverride = mapSizeOverride;
        this.applyShadowConfiguration();
    }

    updateShadowCameraPosition(): void {
        if (!this.directionalLight || !this.camera) return;

        const playerPosition = this.getCurrentPlayer()?.player?.position;
        if (!playerPosition) return;

        const snappedCenter = computeShadowCameraPosition(
            this.directionalLight,
            playerPosition,
            this.shadowConfig,
            this.shadowUnitsPerTexel,
            this.lastSnappedCenter,
            this.isGaussianSplatMode,
        );
        if (!snappedCenter) return; // unchanged since last frame

        if (!this.lastSnappedCenter) this.lastSnappedCenter = new THREE.Vector3();
        this.lastSnappedCenter.copy(snappedCenter);
    }

    getCurrentPlayer(): any | null {
        return this.genreModule?.getCurrentPlayer?.() ?? null;
    }

    /** Ground height at (x, z) — see engine/WorldQueries.ts. */
    getWorldHeightAt(x: number, z: number): number { return queryWorldHeightAt(queryPhysicsFor(this), x, z); }

    /** Ground-snapped centre of the active level (baked levels are corner-origin) — see engine/WorldQueries.ts. */
    getWorldCenter(): THREE.Vector3 { return queryWorldCenter(queryPhysicsFor(this), this.getGameData()?.worldProfileData); }

    /** Side-on 2D games: the locked gameplay plane's Z; null when the game has no such plane. */
    getGameplayPlaneZ(): number | null { return this.gameplayPlaneZ; }

    /**
     * 2D-physics lane: the Rapier 2D world presented through the 3D `PhysicsWorld`
     * surface, for the character pipeline (PlayerLoader, PlayerController, the
     * template's mover). Null on the 3D lane — callers that need "whichever
     * physics answers world queries" use `queryPhysicsFor(engine)`.
     */
    getPlaneLockedPhysics(): PlaneLockedPhysics | null { return this.planeLockedPhysics; }

    /**
     * Resolve a standable point at (x, z) in the ACTIVE world — see engine/GroundPlacement.ts.
     *
     * Use this instead of guessing a spawn: X/Z are validated against the live terrain
     * bounds (a forged .vwld park can sit hundreds of metres from the origin, and a
     * configured ground size can be far larger than the level actually is), and Y comes
     * from whichever terrain path is live — baked level body, procedural chunks, or the
     * voxel grid while colliders are still building.
     *
     * There is no zero fallback: a point outside the map returns `'out-of-bounds'` (with
     * the nearest in-bounds X/Z), and a point with nothing under it returns `'no-ground'`.
     * Pass `{ clampToBounds: true }` to have an outside point pulled in and resolved.
     */
    resolveGroundPlacement(x: number, z: number, options?: Partial<GroundPlacementOptions>): GroundPlacement {
        return queryGroundPlacement(
            {
                physicsWorld: queryPhysicsFor(this),
                bounds: this.dynamicObjectManager.getTerrainBounds(),
                voxelWorld: this.dynamicObjectManager.getMainVoxelWorld(),
            },
            x,
            z,
            { ...DEFAULT_GROUND_PLACEMENT_OPTIONS, ...options },
        );
    }

    /**
     * Coastal water plane at `waterLevelY` (see engine/WaterSurface.ts). Called
     * each loadGame and on level switches (disposes any prior plane); a null
     * level removes water. Baked (.vwld) levels have no main VoxelWorld — their
     * terrain system registers with the DynamicObjectManager so the bounds
     * getter still resolves.
     */
    public applyWaterSurface(waterLevelY: number | null): void {
        const mesh = this.waterFeatures.applyCoastal(
            this.scene, waterLevelY, this.getActivePvsVoxelWorldBounds(),
            () => this.getSunDirection(),
            coastalTerrainSampler(this),
        );
        if (mesh) this.addToWorld(mesh);
    }

    /**
     * Open-water world (see `types/game.ts` OpenWaterConfig): an engine-owned
     * animated ocean + painted sky, driven every frame. Null removes them.
     * `BoatMovement` picks the ocean up on its own, so a boat game needs no
     * water wiring at all.
     */
    public applyOpenWater(config: OpenWaterConfig | null): void {
        this.waterFeatures.configureOpenWater(this, config);
    }

    /** The live open-water ocean, or null. Everything that floats reads it. */
    public getOceanSurface(): OceanSurface | null { return this.waterFeatures.getOceanSurface(); }

    /** Unit direction TOWARD the sun, null before lighting exists — see engine/water/OceanSurface.ts. */
    getSunDirection(): THREE.Vector3 | null {
        return this.directionalLight ? this.directionalLight.position.clone().sub(this.directionalLight.target.position).normalize() : null;
    }

    getShadowConfig(): ShadowConfig {
        return { ...this.shadowConfig };
    }

    private disposeSplatRenderers(): void {
        if (this.gaussianSplatRenderer) {
            this.gaussianSplatRenderer.dispose();
            this.gaussianSplatRenderer = null;
        }
        for (const renderer of this.gaussianSplatRenderers) {
            renderer.dispose();
        }
        this.gaussianSplatRenderers = [];
        if (this.colliderEditor) {
            this.colliderEditor.dispose();
            this.colliderEditor = null;
        }
    }

    /**
     * Returns true if `gameData` has at least one environment object whose asset is a gaussian-splat.
     * Used to set `isGaussianSplatMode` early in `loadGame` (before genre construction) so
     * shadow/lighting setup can adjust accordingly.
     */
    private gameDataHasGaussianSplatEnvObjects(gameData: GameData): boolean {
        const envs = gameData.environmentObjects as Array<{ assetId?: string; assetType?: string }> | undefined;
        if (!envs || envs.length === 0) return false;
        const splatAssetIds = new Set<string>();
        for (const a of gameData.assets ?? []) {
            if (a.type === 'gaussian-splat' || a.type === 'spz') splatAssetIds.add(a.id);
        }
        for (const e of envs) {
            if (e.assetId && splatAssetIds.has(e.assetId)) return true;
            if (e.assetType === 'gaussian-splat' || e.assetType === 'spz') return true;
        }
        return false;
    }

    /**
     * Lazily create the singleton GaussianSplatEditor and wire it to the active splat renderer.
     * Called by EnvironmentObjectSystem after creating the first GaussianSplatRenderer.
     */
    async ensureGaussianSplatEditor(firstRenderer: GaussianSplatRenderer): Promise<void> {
        if (this.colliderEditor) { applySplatView(); return; } // 2nd splat: re-assert, done
        if (!this.scene || !this.camera || !this.physicsWorld || !this.renderer || !this.renderer.domElement) {
            return;
        }

        const { GaussianSplatEditor } = await import('debug/GaussianSplatEditor.js');

        const onHeightmapGenerated = (heightmapData: any) => {
            if (this.genreModule && typeof (this.genreModule as any).onHeightmapGenerated === 'function') {
                (this.genreModule as any).onHeightmapGenerated(heightmapData);
            }
        };

        const colliderEditor = new GaussianSplatEditor(
            this.scene,
            this.camera,
            this.physicsWorld,
            this.renderer.domElement,
            onHeightmapGenerated
        );
        // Let the editor's visibility cycle follow the walkable overlay; the PVS
        // bake/cull lifecycle itself lives on the engine-level controller.
        colliderEditor.setPvsController(this.pvsController);

        colliderEditor.setSplatTransform(
            firstRenderer.getPosition(),
            firstRenderer.getRotation(),
            firstRenderer.getScale()
        );
        colliderEditor.setSplatUrl(firstRenderer.getSplatUrl());

        colliderEditor.setSplatTransformChangeCallback((transform: { position: any; rotation: any; scale: any }) => {
            const activeRenderer = this.gaussianSplatRenderers[this.activeSplatIndex];
            if (activeRenderer) {
                activeRenderer.updateSplatTransform(transform.position, transform.rotation, transform.scale);
            }
            if (typeof (colliderEditor as any).markTransformsDirty === 'function') {
                (colliderEditor as any).markTransformsDirty();
            }
        });

        colliderEditor.setSplatVisibilityCallback((visible: boolean) => {
            const r = this.gaussianSplatRenderers[this.activeSplatIndex];
            if (r) r.setSplatVisibility(visible);
        });

        colliderEditor.setGetGameDataCallback(() => this.getGameData());
        colliderEditor.setGetSplatRenderersCallback(() => this.gaussianSplatRenderers);

        firstRenderer.setColliderEditor(colliderEditor);
        this.colliderEditor = colliderEditor;

        // AFTER the editor is wired: loadColliders() hides the collider voxels; `both` (the
        // `?splats=` default) restores them. See engine/SplatViewMode.ts.
        ensureSplatViewController({ getWorldGroup: () => this.worldGroup,
            getRenderers: () => this.gaussianSplatRenderers, getColliderEditor: () => this.colliderEditor }).refresh();
    }

    setupWindowFocusListeners(): void {
        // Helper to add and track listeners for removal in dispose()
        const track = (target: EventTarget, event: string, handler: EventListener, options?: AddEventListenerOptions) => {
            target.addEventListener(event, handler, options);
            this.boundFocusListeners.push({ target, event, handler, options });
        };

        // iOS Safari only lets an AudioContext move to 'running' while
        // synchronously processing a user gesture, and ours is created at
        // engine construction — long before any gesture — so on iOS it is born
        // suspended and every async resume() (e.g. after a fetch+decode in
        // AudioPlayer) is silently ignored. Desktop Chrome's sticky user
        // activation is lenient, which is why the silence was iPhone-only.
        // Capture-phase so game-code stopPropagation can't starve it; kept
        // installed for the whole session so the first tap unlocks and later
        // taps recover from iOS's non-standard 'interrupted' state (phone
        // call, Siri, lock screen, mic session). Mute-gated inside the helper:
        // mute deliberately suspends the context.
        const unlockAudio = () => this.resumeAudioContextIfAllowed();
        for (const gesture of ['pointerdown', 'touchend', 'keydown']) {
            track(window, gesture, unlockAudio as EventListener, { capture: true, passive: true });
        }

        // Clicking on the game canvas restores focus state immediately.
        // Important for free mouse mode where there's no pointer lock overlay to re-engage.
        track(this.container, 'mousedown', () => {
            if (!this.isWindowFocused) {
                this.isWindowFocused = true;
                window.focus();
            }
        });

        track(window, 'focus', () => {
            this.isWindowFocused = true;
            console.log('🪟 Window focused - input enabled');

            // Notify parent window that game iframe received focus (for narrow layout minimize)
            safePostMessageToCreator({ type: 'GAME_IFRAME_FOCUSED' });
        });

        track(window, 'blur', () => {
            this.isWindowFocused = false;
            console.log('🪟 Window blurred - input disabled');
        });

        // Helper: called by all hide-detecting events
        const markHidden = () => {
            this._wasTabHidden = true;
            this.isWindowFocused = false;
        };
        // Helper: called by all show-detecting events
        const markVisible = () => {
            this.isWindowFocused = true;
            // Lock-screen / app-switch recovery without waiting for a tap:
            // iOS may allow a resume here, and when it doesn't the caught
            // rejection is harmless — the next gesture unlock recovers.
            this.resumeAudioContextIfAllowed();
        };

        track(document, 'visibilitychange', () => {
            if (document.hidden) {
                markHidden();
            } else {
                markVisible();
            }
            console.log(`🪟 Visibility changed - input ${this.isWindowFocused ? 'enabled' : 'disabled'}`);
        });

        // Mobile WebViews (Slack, Discord, etc.) often don't fire visibilitychange.
        // pageshow/pagehide are more reliable, especially with bfcache restores.
        track(window, 'pagehide', markHidden as EventListener);
        track(window, 'pageshow', (() => {
            // pageshow fires on initial load too; only act if we were hidden
            if (this._wasTabHidden) markVisible();
        }) as EventListener);

        // Page Lifecycle API — fires when the OS freezes a WebView entirely
        track(document, 'freeze', (() => {
            markHidden();
            console.log('🪟 Page frozen by OS');
        }) as EventListener);
        track(document, 'resume', (() => {
            markVisible();
            console.log('🪟 Page resumed from OS freeze');
        }) as EventListener);

        // M — default mute toggle. Engine-level so a game gets a mute shortcut
        // even without the HUD mute button. Only acts once the game has used
        // audio; a game that needs M for something else opts out with
        // engine.setMuteHotkeyEnabled(false).
        track(window, 'keydown', ((e: KeyboardEvent) => {
            if (e.key.toLowerCase() !== 'm' || e.ctrlKey || e.altKey || e.metaKey) return;
            if (!this.muteHotkeyEnabled || !this._audioUsed) return;
            const target = e.target;
            if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
            this.setAudioMuted(!this._audioMuted);
        }) as EventListener);
    }



    private createRenderer(type: RendererType, antialias: boolean): RendererField {
        // Two distinct backends. WebGPU mode → TSL NodeMaterial pipeline (the
        // PR's converted materials). WebGL mode → legacy classic-material
        // pipeline (full post-FX, Spark, AO/DOF/outline, broader browser
        // support, no WebGL2 UBO size limits from TSL).
        // Material-creation sites branch on RendererType.getActiveRendererType().
        setActiveRendererType(type);
        if (type === 'webgpu') {
            // WebGPU's default maxBufferSize is 256MiB — a single large voxelized
            // environment object can exceed it (e.g. ~1M leaves with face culling
            // skipped → 282MB vertex attributes), making CreateBuffer fail and the
            // whole frame render black. Request the adapter's full maxBufferSize
            // instead. The backend keeps this object by reference and only reads
            // it inside init() after its own adapter request, so filling it in
            // before init() is race-free.
            const requiredLimits: Record<string, number> = {};
            const wgpu = new WebGPURenderer({ antialias, requiredLimits });
            // WebGPU bakes polygon offset into the immutable pipeline but Three.js
            // omits it from the pipeline cache key, so materials differing only in
            // depth bias collide onto one pipeline and z-fight (e.g. the voxel-world
            // per-bias-step terrain). Patch the backend before any pipeline is built.
            applyWebGPUPolygonOffsetCacheFix(wgpu);
            (async () => {
                try {
                    const adapter = await navigator.gpu?.requestAdapter();
                    if (adapter) requiredLimits.maxBufferSize = adapter.limits.maxBufferSize;
                } catch { /* no adapter limits — init with defaults */ }
                await wgpu.init();
                // The device exists only now. Chrome 153/Metal rejects three's
                // chained swizzles; see WebGPUSwizzleFix for why this is unconditional.
                applyWebGPUSwizzleFix(wgpu);
                // The device is live, so KTX2 can be asked which compressed formats it has.
                initGltfLoaderSupport(wgpu);
            })().catch((err) => console.error('webgpu renderer init failed:', err));
            return asRendererField(wgpu);
        }
        const wgl = new WebGLRenderer({ antialias });
        initGltfLoaderSupport(wgl);
        return wgl as RendererField;
    }

    setRendererType(type: RendererType): void {
        if (type === this.currentRendererType) return;
        reloadIntoRendererType(type);
    }

    getRendererType(): RendererType {
        return this.currentRendererType;
    }

    /**
     * The GPU backend actually in use. Differs from getRendererType() when a
     * WebGPURenderer has fallen back to the WebGL2 backend (no browser WebGPU).
     * Resolved only after the renderer's async init() completes.
     */
    getActiveBackend(): RendererBackend {
        return getActiveBackend(this.renderer);
    }

    recreateRenderer(antialias: boolean, type: RendererType = this.currentRendererType): void {
        if (!this.renderer) return;

        // Type-swap mid-session leaves NodeMaterials / classic materials baked
        // into existing scene objects — they won't render under the other
        // backend. Persist the choice and reload with the URL param so the
        // engine constructs fresh in the requested mode.
        if (type !== this.currentRendererType) {
            reloadIntoRendererType(type);
            return;
        }

        const { width, height } = viewportSize();
        const pixelRatio = this.renderer.getPixelRatio();

        this.container.removeChild(this.renderer.domElement);
        this.renderer.dispose();

        this.renderer = this.createRenderer(type, antialias);
        this.renderer.setSize(width, height);
        this.renderer.setPixelRatio(pixelRatio);
        this.renderer.setViewport(0, 0, width, height);
        // Re-apply cached color pipeline (recreateRenderer is called mid-loadGame
        // after applyRenderConfig has stored worldProfileData.renderConfig).
        this.applyRenderConfig();
        // Full shadow re-setup against the fresh renderer: restores
        // shadowMap.enabled and the platform filter type (BasicShadowMap on
        // Android — the bare PCF assignment this replaces silently lost it).
        this.applyShadowConfiguration();

        this.container.appendChild(this.renderer.domElement);

        // Composer + all post-effect passes hold a reference to the disposed
        // renderer. Drop them so rebuildComposerPasses() reconstructs against
        // the new renderer with the cached configs.
        if (this.composer) {
            this.composer.dispose();
            this.composer = null;
        }
        this.bloomPass = null;
        this.bokehPass = null;
        this.gtaoPass = null;
        this.outlinePass = null;
        // Re-create outline pass if outline was enabled (lazy: setupSelectionOutline
        // is idempotent and only recreates the WebGL pass when missing).
        if (this.outlineEnabled) this.setupSelectionOutline();
        // setupBloom calls rebuildComposerPasses, which honors the cached DOF/AO
        // configs and the now-active outline state.
        this.setupBloom(this.bloomConfig);

        if (this.screenRecorder) {
            this.screenRecorder.dispose();
            this.screenRecorder = new ScreenRecorder(this.renderer, this);
        }
    }

    async initPhysics(mode: '3d' | '2d' | 'none' = '3d'): Promise<void> {
        if (mode === '3d') {
            const { initRapier } = await import('engine/physics/RapierPhysics.js');
            await initRapier();
            const { PhysicsWorld: PW } = await import('engine/physics/PhysicsWorld.js');
            this.physicsWorld = new PW(new THREE.Vector3(0, -9.81, 0));
            console.log('Rapier 3D physics world initialized');
        } else if (mode === '2d') {
            const { initRapier2D } = await import('engine/physics/RapierPhysics2D.js');
            await initRapier2D();
            const { PhysicsWorld2D: PW2D } = await import('engine/physics/PhysicsWorld2D.js');
            // Side-on: real gravity on the X/Y plane. Ground plane (top-down): the
            // 2D world IS the X/Z plane and world Y is virtual — no 2D gravity.
            const plane = this.physicsPlane;
            this.physicsWorld2D = new PW2D(plane.orientation === 'xz' ? { x: 0, y: 0 } : { x: 0, y: -9.81 });
            // The character pipeline is 3D-typed; it drives this world through the
            // plane-locked facade, on the plane loadGame resolved above.
            this.planeLockedPhysics = createPlaneLockedPhysics(this.physicsWorld2D, plane);
            // `engine.physicsWorld` IS the facade on this lane: frozen game code (a
            // template Game.ts written for the 3D world) guards on it, passes it to
            // the player controller, and removes bodies through it — unchanged.
            // `physicsWorld2D` stays the raw world for 2D-native code. Systems that
            // must NOT drive a 2D world as if it were 3D (VoxelWorld's own colliders,
            // splat colliders) test `isPlaneLockedPhysics(engine.physicsWorld)`.
            this.physicsWorld = asPlayerPhysics(this.planeLockedPhysics);
            // Triggers (collectibles, interaction zones) resolve through the
            // handle-based InteractionManager on both lanes; the 3D world wires
            // it lazily on first sensor, the 2D world here.
            this.physicsWorld2D.addSensorListener(getInteractionManager());
            console.log(`Rapier 2D physics world initialized (${plane.orientation === 'xz' ? 'ground plane, top-down' : `side-on plane z=${plane.planeZ}`})`);
        }
    }

    // ==================== MULTI-LEVEL (levels mode) ====================
    // Wiring lives in engine/levels/LevelEngineBridge.ts — GameEngine keeps
    // only the game-code-facing delegates (this file is at the max-lines cap).

    /** Multi-level API (levels mode only; null in legacy single-world games). */
    public getLevelManager(): LevelManager | null { return this.levelManager; }

    /**
     * Switch to another level of this game (worldProfileData.levels). Game
     * code drives WHEN (round end, door, menu); in multiplayer the switch is
     * broadcast to the room by default — gate the call on your authority
     * model (typically the host).
     */
    public async loadLevel(levelId: string, opts?: LoadLevelOptions): Promise<void> {
        if (!this.levelManager) {
            throw new Error('[GameEngine] loadLevel requires worldProfileData.levels — this game has a single world');
        }
        await this.levelManager.loadLevel(levelId, opts);
    }

    /** Active level id, or null for legacy single-world games. */
    public getActiveLevelId(): string | null { return this.levelManager?.getActiveLevelId() ?? null; }

    /** The level registry as {id, name} pairs ([] for legacy games). */
    public getLevels(): Array<{ id: string; name: string }> { return this.levelManager?.getLevels() ?? []; }

    /** Warm the vwld buffer cache for an upcoming switch (round rotation). */
    public async prefetchLevel(levelId: string): Promise<void> { await this.levelManager?.prefetchLevel(levelId); }

    /** Re-apply per-level atmosphere from an effective profile (see LevelEngineBridge). */
    // Fire-and-forget here (live creator edit, no fade to hold): only the
    // level-switch path needs to await the skybox tail — see LevelManager.
    public applyLevelAtmosphere(profile: WorldProfileData | undefined): void { void this.levelBridge?.applyAtmosphere(profile); }

    /** Rebuild the light-emitting-prop sources from gameData (level switches re-filter). */
    public refreshEnvironmentLights(): void { this.environmentLights?.initFromGameData(this.currentGameData ?? ({} as GameData)); }

    /**
     * The data-driven dungeon door system (world.json doors[] / keyItems[]),
     * or null when this game declares none. See engine/doors/DoorSystem.ts.
     */
    public getDoorSystem(): DoorSystem | null { return this.doorBridge?.getSystem() ?? null; }

    private disposeDoorSystem(): void {
        this.doorBridge?.dispose();
        this.doorBridge = null;
    }

    /**
     * Tear down everything that belongs to the currently-loaded world. Shared by
     * loadGame() (before building the next one) and dispose(), which must drop
     * the same systems in the same order: doors and the shard sync ride on the
     * genre's world group, so they go before the genre that owns it.
     */
    private disposeWorldSystems(): void {
        if (this.scene) {
            VisualEffects.disposeScene(this.scene);
            ExplosionVisual.disposeScene(this.scene);
        }
        this.disposeDoorSystem();
        this.assetSpawner?.dispose();
        this.assetSpawner = null;
        if (this.worldShardSync) {
            this.worldShardSync.dispose();
            this.worldShardSync = null;
        }
        if (this.genreModule) {
            this.genreModule.dispose();
            this.genreModule = null;
        }
        if (this.traversalChallenges) {
            this.traversalChallenges.dispose();
            this.traversalChallenges = null;
        }
        if (this.mechanisms) {
            this.mechanisms.dispose();
            this.mechanisms = null;
        }
        if (this.smartObjects) {
            this.smartObjects.dispose();
            this.smartObjects = null;
        }
        if (this.buildings) {
            this.buildings.dispose();
            this.buildings = null;
        }
    }

    async loadGame(gameId: string, gameData: GameData, options?: LoadGameOptions): Promise<void> {
        this.gameLoadComplete = false;
        this.quality.resetSampling();
        // Main-screen level chooser: boot straight into the picked level. The
        // override returns a shallow COPY with startLevelId + the legacy mirror
        // fields remapped (frozen genre code boots from the mirrors); the
        // caller's gameData is never mutated. Invalid picks degrade to the
        // normal boot with a console warning.
        if (options?.bootLevelId !== undefined) {
            gameData = applyBootLevelOverride(gameData, options.bootLevelId);
        }
        // Pre-play selections are per-load; GameTemplate re-records them (and
        // the level pick) via setPreGameSelection after this load finishes.
        this.preGameSelections = {};
        this.currentGameData = gameData;
        this.muteControlEnabled = false;
        // Voice input is per-game: stop any recording, drop the mic stream (the
        // browser's recording indicator turns off) and clear push-to-talk wiring.
        this.voiceInput.releaseMicrophone();
        this.pushToTalk.reset();
        // Fresh audio state per game — the persisted mute preference is
        // re-applied on the new game's first audio use (see markAudioUsed).
        this._audioUsed = false;
        this._audioMuted = false;
        this.audioMuteListeners.clear();
        this.muteHotkeyEnabled = true;
        // PlayerVisibility lives on the engine, not per-game — reset its
        // hide reasons / body-part filters / manual override so state from
        // the previously-loaded game doesn't leak into the new one. Roots
        // are re-registered by the new PlayerController constructor + the
        // new PlayerLoader's block character.
        this.playerVisibility.reset();
        // Re-arm level preload/warmup for this load — the engine instance is
        // reused across game reloads, so a stale `true` would skip warming the
        // new scene. See preloadLevel().
        this.preloadDone = false;

        const worldProfileData = (gameData as any).worldProfileData as WorldProfileData;
        const genre = gameData.gameGenre;
        if (!genre) {
            throw new Error('gameGenre is missing from game data — cannot load game without a genre');
        }

        // Multi-level registry (levels mode). Constructed before any config is
        // applied so boot uses the START level's effective profile; legacy
        // games (no levels[]) skip this entirely. The previous game's manager
        // is always cleared first — the engine instance survives reloads.
        setActiveLevelManager(null);
        this.levelManager = null;
        this.levelBridge = null;
        const bootLevels = resolveLevels(gameData);
        const bootProfile = bootLevels
            ? mergeEffectiveProfile(worldProfileData, bootLevels.startLevel)
            : worldProfileData;
        // Resolve the touch pause button's visibility before the genre module is
        // constructed below: its game object declares mobile action buttons during
        // construction, and MobileButtonLayout has to know whether the top-right
        // corner is the engine's or the game's. Re-read every load — the flag must
        // not survive into the next game.
        setPauseButtonHidden(bootProfile.hud?.pauseButton === 'hidden');

        if (bootLevels) {
            this.levelBridge = new LevelEngineBridge(this, gameData);
            this.levelManager = this.levelBridge.createManager();
            this.levelManager.onLevelWillUnload(() => {
                if (this.scene) VisualEffects.clearScene(this.scene);
            });
            setActiveLevelManager(this.levelManager);
        }

        console.log(`Loading ${genre} game: ${gameId}`);

        const requested = (gameData as Record<string, unknown>).physicsMode as PhysicsMode | undefined;
        // Declared → effective mode (the genre downgrade lives in the rule; see
        // engine/physics/PhysicsModeRule.ts — mirrored by the publish lanes).
        // `physics2d` is the template's own statement that its code is written
        // against the 2D world; without it a legacy `physicsMode: '2d'` stays
        // downgraded, which is what protects every pre-existing sidescroller.
        const physics2dCapable = (gameData as Record<string, unknown>).physics2d === true;
        const physicsMode = effectivePhysicsMode(genre, requested, physics2dCapable);
        // Side-on 2D games play on one locked X/Y plane; NPC controllers read
        // this to keep enemies on it (behaviors/avoidance are 3D and drift off).
        this.gameplayPlaneZ = resolveGameplayPlaneZ(gameData);
        this.physicsPlane = resolvePhysicsPlane(gameData);
        if (requested === '2d' && physicsMode !== '2d') {
            console.warn(`physicsMode '2d' requested for genre '${genre}', which has no 2D physics path yet — using 3D physics.`);
        }
        // Main-screen progress: the load's phase boundaries live here (the
        // within-'world' sub-signals report from the shared loaders — see
        // reportWorldSubProgress). Frozen genre/work template code is never
        // instrumented, so this works for every game, old and new.
        getLoadProgress().beginPhase('physics', t('game.loading.physics'));
        await this.initPhysics(physicsMode);

        // The id every per-game store keys on: the published gameId when the data
        // carries one, else the id this load was asked for.
        const dataGameId = gameData.gameId || gameId;

        this.aiService.configure(worldProfileData.runtimeAI, gameId);
        this.screenshotService.configure(this, gameId);
        this.gameDataService.configure(
            { ...DEFAULT_GAME_DATA_SERVICE_OPTIONS, baseUrl: GAME_DATA_SERVICE_URL },
            dataGameId,
        );

        // Initialize persistence with game ID and publish version
        const publishVersionMeta = document.querySelector('meta[name="publish-version"], meta[name="bm:publish-version"]');
        const publishVersion = publishVersionMeta ? parseInt(publishVersionMeta.getAttribute('content') || '1', 10) : 1;
        // Account-backed saves: localStorage stays the synchronous store the game
        // reads; the installed sync mirrors it to the player's account (or the
        // local player's store on localhost) — see EngineCloudSaves.
        this.gamePersistence = new GamePersistence(installCloudSaves(dataGameId).adapter, dataGameId, publishVersion);
        this.loadedGameId = dataGameId;
        // A ghost subsystem built against the previous game would carry its id
        // and its personal bests into this one, and its credential is scoped to
        // that game — the service rejects it on this one.
        this.ghostRacing?.detach();
        this.ghostRacing = null;
        this.playerIdentity = null;

        // Block-character pose convention (absent ⇒ v1/legacy). v2 makes the torso
        // group face +Z forward like the head; new games set it via templates.
        setBlockCharacterPoseVersion(worldProfileData.characterPoseVersion);

        this.applyBloomConfig(worldProfileData.bloomConfig, genre, gameData.artStyle);
        this.applyRenderConfig(worldProfileData.renderConfig ?? null);
        // Fog + lighting come from the boot profile: in levels mode that is
        // the START level's overrides merged over the globals.
        this.applyFogConfig(bootProfile.fogConfig ?? null);
        this.applyLightingConfig(bootProfile.lightingConfig ?? null);
        this.applyWeatherConfig(bootProfile.weatherConfig ?? null);
        this.applyAoConfig(worldProfileData.aoConfig ?? null);
        this.applyDofConfig(worldProfileData.dofConfig ?? null);

        if (this.scene) {
            const decalConfig: DecalSystemConfig = (worldProfileData as any).decalSystem ?? {};
            // Pass physics world for edge detection raycasts
            if (this.physicsWorld) {
                decalConfig.physicsWorld = this.physicsWorld;
            }
            initDecalSystem(this.scene, decalConfig);
            // Real carved holes where the geometry supports them; the decal
            // above is the fallback for everything else.
            initVoxelCarveSystem();
            // Debris knocked off whatever gets hit — melee, unarmed and ranged all
            // spawn through the same global, exactly as decals do.
            initHitDebrisSystem(this.scene);
        }

        // Determine splat mode before genre loading — the genre constructor may call
        // recreateRenderer() which must happen BEFORE the splat renderers are created
        // (by EnvironmentObjectSystem) so they bind to the final renderer/context.
        const hasSplats = this.gameDataHasGaussianSplatEnvObjects(gameData);
        this.isGaussianSplatMode = hasSplats;
        this.disposeSplatRenderers();
        if (!hasSplats) {
            console.log('No Gaussian splat configured, using normal world generation');
        }

        // Light-emitting props (assets[].light). Skip creating the system —
        // and its constant-count pooled lights — when nothing emits.
        if (this.environmentLights) {
            this.environmentLights.dispose();
            this.environmentLights = null;
        }
        if (this.scene && EnvironmentLightSystem.gameDataHasEmitters(gameData)) {
            this.environmentLights = new EnvironmentLightSystem(this.scene, DEFAULT_ENVIRONMENT_LIGHT_OPTIONS);
            this.environmentLights.initFromGameData(gameData);
        }

        // Dungeon doors are rebuilt below (after the genre's world exists, so
        // the leaves have a world group and colliders a physics world); the
        // previous game's must go now, along with its network stream, its genre
        // module and the world systems built on top of it.
        this.disposeWorldSystems();

        // Reset world group so the new genre gets a fresh one via getWorldGroup()
        if (this.worldGroup && this.scene) {
            this.scene.remove(this.worldGroup);
        }
        this.worldGroup = null;
        VoxelObjectBuilder.setWorldGroup(null);

        // Cancel the previous animate() chain so it doesn't survive across reloads
        if (this._animFrameId) {
            cancelAnimationFrame(this._animFrameId);
            this._animFrameId = 0;
        }

        getLoadProgress().beginPhase('genre', t('game.loading.code'));
        const GenreClass = await GenreLoader.forceReloadGenre(genre);

        if (!GenreClass) {
            throw new Error(`Failed to load genre "${genre}". Try reloading the game.`);
        }

        // Pre-register custom block types declared in world.json so the genre's
        // WorldGenerator sees them already in the atlas. Each entry is loaded
        // independently; one bad textureUrl no longer aborts the whole batch.
        await this.blocks.loadFromWorldProfile(worldProfileData);

        // Account saves must be in localStorage before any genre code (constructors
        // included) can read them; bounded, and a missed gate is safe.
        await gateCloudSaves();

        // Construct genre first — constructors may call recreateRenderer() which
        // replaces the renderer. This must happen before the splat renderers are
        // created so they bind to the final renderer/context.
        this.genreModule = new GenreClass(this, worldProfileData, gameData);

        // Splats are loaded as environment objects by EnvironmentObjectSystem during genre.load().

        if (hasSplats && this.cameraPathEditor && gameId) {
            await this.cameraPathEditor.loadCameraPath(gameId);
        }

        // Open water BEFORE the genre loads. Generated game code asks for the
        // ocean while it is being constructed (inside genreModule.load), so an
        // ocean applied afterwards does not exist when the game looks for it —
        // and "no ocean" is indistinguishable from a missing flag. Unlike the
        // coastal plane below, the ocean needs no terrain, so it can go first.
        this.applyOpenWater(resolveOpenWaterConfig(worldProfileData));

        try {
            getLoadProgress().beginPhase('world', t('game.loading.world'));
            await this.genreModule.load(gameId);

            // Coastal levels: ONE realtime water-surface plane at the sea level. Added AFTER the
            // level loads so the terrain is present to occlude it — the higher land hides the plane
            // and only the carved water basins below it reveal the see-through sea.
            // Boot profile = start level's overrides merged over globals (levels mode).
            this.applyWaterSurface(bootProfile.waterLevelY ?? null);

            // Terrain bounds exist now — shrink the default shadow coverage
            // (and with it the derived shadow-map size) to fit a small world.
            this.fitShadowsToWorld();

            // Genre code (frozen templates) loaded the GLOBAL skybox URL; swap to
            // the start level's override now if one exists.
            this.levelBridge?.noteBootSkybox(worldProfileData.skyboxUrl, bootProfile.skyboxUrl);

            // Scene-wide PVS for splat-less voxel levels: restore a baked
            // worldProfileData.walkableUrl/pvsUrl into the controller and enable
            // culling. Splat scenes load PVS per-splat instead, so gate on no
            // splat. Fire-and-forget — a multi-MB PVS fetch must not block game
            // start; culling activates once it lands.
            if (!this.isGaussianSplatMode && this.pvsController && worldProfileData.walkableUrl && this.dynamicObjectManager.getMainVoxelWorld()) {
                const controller = this.pvsController;
                const walkableUrl = worldProfileData.walkableUrl;
                const pvsUrl = worldProfileData.pvsUrl;
                void (async () => {
                    try {
                        await controller.loadWalkableMapFromUrl(walkableUrl);
                        if (pvsUrl) {
                            await controller.loadPvsFromUrl(pvsUrl);
                            controller.setPvsCullingEnabled(true);
                        }
                    } catch (err) {
                        console.error('[PVS] Scene-wide PVS load failed:', err);
                    }
                })();
            }

            // Apply HUD theme from world.json (falls back to Bitmagic default if
            // absent, invalid, or an unknown preset name — resolveWorldTheme logs
            // a console warning and never throws).
            this.genreModule.hud?.setTheme(resolveWorldTheme(worldProfileData.hud?.theme));

            // Mute control is opt-in: templates must call engine.enableMuteControl()
            // during load() to get the default mute button. Off by default.
            if (this.muteControlEnabled) {
                this.genreModule.hud?.setupMuteControl?.(this, gameData);
            }

            // Declarative mobile action registration.
            // Fires after the genre's load() resolves (player controller is now
            // registered) and before game systems wire runtime action handlers.
            // verifyMobileParity (called later at Play-click) relies on this
            // having run first, so specs are visible to the parity check.
            const playerController = this.getPlayerController();
            if (
                playerController &&
                'declareMobileActions' in playerController &&
                this.genreModule.declareMobileActions
            ) {
                const specs = this.genreModule.declareMobileActions();
                if (specs.length > 0) {
                    (playerController as unknown as { declareMobileActions: (specs: MobileActionSpec[]) => void })
                        .declareMobileActions(specs);
                }
            }

            // Forged levels: re-assert the movement contract now that the genre's
            // build is done — templates configure the player from characterConfig
            // during build (setMoveSpeed with the 5 m/s default), clobbering the
            // contract kit the level's platform spacing was solved for.
            playerController?.reassertMovementContract?.();

            // Push-to-talk is opt-in: templates call engine.enablePushToTalk()
            // during load() (before the player controller exists), so the actual
            // key/button binding happens here. A later enablePushToTalk call
            // wires itself immediately instead.
            this.pushToTalk.wire(playerController, this.genreModule.hud ?? null, this.container);

            // Forged levels: the completability-critical challenge mechanisms
            // (ferries, lifts, crumbling crossings) marked engineAutoBuild are
            // built and run by the ENGINE — a level must never be unfinishable
            // because generated game code skipped or misplaced one.
            this.traversalChallenges = new TraversalChallengeSystem(this);

            // Data-driven mechanisms: spinners/movers/pendulums/crushers/
            // conveyors/crumbling floors declared in world.json `mechanisms[]`
            // — engine-spawned, editable in the creator editor, persisted.
            this.mechanisms = new MechanismSystem(this);

            // Enterable buildings declared as `building` hotspots — built by the
            // ENGINE as self-contained voxel objects so they exist on every
            // terrain backend (procedural AND baked .vxl levels) without
            // per-game WorldGenerator support.
            this.buildings = new BuildingSystem(this);

            // Data-driven dungeon doors + key pickups. Built after the world so
            // door leaves land in the live world group; the bridge re-builds
            // them on every level switch (doors/keys carry an optional levelId).
            if (DoorEngineBridge.gameDataHasDoors(gameData)) {
                this.doorBridge = new DoorEngineBridge(this, gameData);
            }

            if (this.editorManager) {
                await this.editorManager.checkSceneEditingLockStatus(false);
                // The markers need the loaded game data, hence after the genre's load().
                this.editorManager.markerSystem.loadMarkers(worldProfileData?.markers || []);
                this.editorManager.initSpawnPointMarkers();
            }

            // Preload assets + GPU-warm the scene before the Play button is
            // presented (GAME_LOADED is posted only after loadGame() resolves),
            // so the player reveal (UFO beam-down) and the first NPC/sound don't
            // hitch on mobile. Idempotent — a no-op if the genre already called
            // preloadLevel() during its own load(). See preloadLevel().
            await this.preloadLevel();

            this.animate();

            // Play-session lifecycle + achievement definitions (P6). configure()
            // stops any prior session and resets the per-session unlock dedup;
            // startSession() opens a session + heartbeat loop only when a play
            // token is available (guests are skipped, unlock toasts still work).
            const playProgress = getPlayProgress();
            if (playProgress) {
                playProgress.configure(gameId, buildAchievementDefMap(worldProfileData.achievements));
                playProgress.startSession();
            }

            // Wire up persistent-world shard sync if world.json opts in. Single
            // source of truth — no URL params, no postMessage flags, no
            // localStorage. The agent toggles this field via the existing
            // edit-world-config endpoint. See `game/agent-docs/
            // world-persistence.md` for the contract.
            const persistFlag = worldProfileData?.persistentWorld === true;
            const voxelWorldForSync = persistFlag ? this.dynamicObjectManager.getMainVoxelWorld() : null;
            if (persistFlag && !voxelWorldForSync) {
                console.log('[GameEngine] persistentWorld=true but no main VoxelWorld available (non-voxel genre?) — skipping');
            }
            if (voxelWorldForSync) {
                const { WorldShardSync, DEFAULT_WORLD_SHARD_SYNC_OPTIONS } = await import('./networking/WorldShardSync.js');
                const spawn = this.getSpawnPoints('player')[0]?.position
                    ?? (worldProfileData as { playerSpawnPosition?: { x?: number; y?: number; z?: number } })?.playerSpawnPosition
                    ?? { x: 0, y: 0, z: 0 };
                // Genres with multiplayer expose their NetworkManager via the
                // optional `getNetworkManager` hook (see GenreGameInterface).
                // When present, WorldShardSync uses WS for live cross-client
                // fan-out and server-pushed snapshots on join. Otherwise it
                // falls back to HTTP-only persistence (still saves+restores,
                // just no live sync to other players).
                const networkManager = this.genreModule?.getNetworkManager?.() ?? null;
                const sync = new WorldShardSync({
                    ...DEFAULT_WORLD_SHARD_SYNC_OPTIONS,
                    gameId,
                    voxelWorld: voxelWorldForSync,
                    networkManager,
                    spawnX: spawn.x ?? 0,
                    spawnY: spawn.y ?? 0,
                    spawnZ: spawn.z ?? 0,
                });
                this.worldShardSync = sync;
                sync.bootstrap().then((result) => {
                    console.log(`[GameEngine] World persistence: bootstrap complete (mode=${networkManager ? 'ws' : 'http'}, ${result.editCount} edits from ${result.shardCount} shards)`);
                }).catch((err) => {
                    console.warn('[GameEngine] WorldShardSync bootstrap failed', err);
                });
            }
        } catch (error: any) {
            console.error(`Failed to load genre module for ${genre}:`, error);
            throw error;
        }
        this.gameLoadComplete = true;
    }

    private worldGroup: THREE.Object3D | null = null;
    private assetSpawner: AssetSpawner | null = null;
    /** Coastal plane + open-water ocean/sky. See engine/water/EngineWaterFeatures.ts. */
    private readonly waterFeatures = new EngineWaterFeatures();

    /**
     * Get the world group, creating it on first access.
     * All world objects (terrain, VoxelObjects, scenery) must be children of this group.
     * This is called by WorldGenerators before world generation begins, ensuring
     * the hierarchy exists before any objects are created.
     */
    getWorldGroup(): THREE.Object3D {
        if (!this.worldGroup) {
            this.worldGroup = new THREE.Group();
            this.worldGroup.name = 'WorldGroup';
            if (this.scene) {
                this.scene.add(this.worldGroup);
            }
            VoxelObjectBuilder.setWorldGroup(this.worldGroup);
        }
        return this.worldGroup;
    }

    /**
     * Add a static object (VoxelObject, mesh, group) to the world group.
     * Use this instead of scene.add() for anything that belongs to the
     * game world and should be hidden when toggling display modes.
     */
    addToWorld(...objects: THREE.Object3D[]): void {
        this.getWorldGroup().add(...objects);
    }

    /**
     * Spawn a library asset (world.json `assets[]` entry) into the scene at
     * runtime, by asset id or name. The code-side counterpart of declarative
     * `environmentObjects[]` placement — use it for placements computed at
     * runtime (procedural levels, pickups, drops). Fetches each asset once and
     * clones per spawn; handles VXL metadata, physics, scene registration, and
     * optional collectible wiring. See AssetSpawner.ts for options.
     */
    async spawnAsset(assetIdOrName: string, options?: Partial<SpawnAssetOptions>): Promise<SpawnedAsset | null> {
        if (!this.assetSpawner) {
            this.assetSpawner = new AssetSpawner(this);
        }
        return this.assetSpawner.spawn(assetIdOrName, { ...DEFAULT_SPAWN_ASSET_OPTIONS, ...options });
    }

    async loadGaussianSplat(url: string, config?: {
        position?: Vector3Like;
        eulerAngles?: Vector3Like;
        scale?: Vector3Like;
    }): Promise<GaussianSplatRenderer> {
        if (!this.scene) throw new Error('Scene not initialized');

        const { GaussianSplatRenderer: GSRenderer } = await import('./GaussianSplatRenderer.js');

        // Defaults are identity. Callers (e.g. LOAD_VOXEL_OVERLAY_SPLAT) supply their
        // own position/rotation/scale via `config`.
        const splatConfig: GaussianSplatConfig = {
            url,
            position: config?.position ?? { x: 0, y: 0, z: 0 },
            eulerAngles: config?.eulerAngles ?? { x: 0, y: 0, z: 0 },
            scale: config?.scale ?? { x: 1, y: 1, z: 1 },
        };
        const renderer = new GSRenderer(this.scene, splatConfig, this.physicsWorld, this);
        await renderer.load();

        this.gaussianSplatRenderers.push(renderer);
        if (!this.gaussianSplatRenderer) {
            this.gaussianSplatRenderer = renderer;
        }
        await this.ensureGaussianSplatEditor(renderer);

        // Kept for ALREADY-PUBLISHED games: no template implements it now (see SplatViewMode.ts).
        if (this.genreModule && typeof (this.genreModule as any).onOverlaySplatLoaded === 'function') {
            (this.genreModule as any).onOverlaySplatLoaded(renderer);
        }
        return renderer;
    }

    private renderActive = true;

    /**
     * Enable/disable the render+update loop without tearing it down. The creator
     * calls this (via SET_RENDER_ACTIVE) to stop rendering when the game isn't
     * visible to the user — portal mode, a modal covering the canvas, or the
     * Prompts-tab blurred backdrop. The rAF chain stays alive so rendering
     * resumes instantly when the game becomes visible again.
     */
    setRenderActive(active: boolean): void {
        if (this.renderActive !== active) this.quality.resetSampling();
        this.renderActive = active;
    }

    animate(): void {
        if (!this.genreModule) return;

        // Cancel any previous requestAnimationFrame chain to prevent stacking
        // when loadGame() is called multiple times (e.g. hot-reload in creator).
        if (this._animFrameId) {
            cancelAnimationFrame(this._animFrameId);
        }
        this._animFrameId = requestAnimationFrame(() => this.animate());

        // Recording backpressure: while the F9 recorder's upload queue is deep, do nothing this
        // frame — not even tick the timer — so the frames already captured can reach the sink.
        // The recording runs on a fixed timestep, so a held frame changes nothing in the output.
        if (this.screenRecorder?.shouldHoldFrame()) return;

        // Render-active gate: when the creator signals the game isn't visible
        // (portal mode, a modal covering it, or the Prompts-tab blurred backdrop),
        // keep the rAF chain alive but skip ALL per-frame work + rendering. This
        // is the core fix for big-scene lag — the engine no longer renders a huge
        // world every frame behind an editor panel or dialog.
        if (!this.renderActive) {
            return;
        }

        // Cold-start race: the WebGPU backend initializes asynchronously, so the
        // first frames after loadGame() can run before it is ready. Calling
        // render() then throws "backend is not initialized" every frame until a
        // reload happens to win the race. Skip rendering until the backend
        // reports ready — the RAF chain above keeps the loop alive, so it
        // self-heals the moment init() resolves. No-op on WebGL (always ready).
        if (!rendererBackendReady(this.renderer)) {
            return;
        }

        // Size self-heal, companion to the cold-start guard above. init() and
        // recreateRenderer() floor the renderer size at 1x1 when window.innerWidth/
        // Height are momentarily 0 during a fresh iframe navigation, so the canvas
        // can be stuck at 1x1 with no resize event to correct it (the window never
        // actually changed size). Re-sync to the live viewport whenever it diverges
        // from the renderer's current size. Cheap; no-op once they match.
        // Never while the screen recorder owns the size. It sets the renderer to the recording
        // resolution and CSS-scales the canvas back to fit the window, so renderer size and
        // viewport are MEANT to diverge for the length of a recording — and this heal would undo
        // that on the very next tick, resetting both the size and the camera aspect to the
        // viewport's. The recording still writes files at the chosen resolution (the capture
        // upscales), so it fails silently: every "1920x1080" recording is really a viewport-sized
        // render at the wrong aspect, stretched. The 1x1 swapchain this exists to heal happens
        // during a fresh iframe navigation, when no recording can be running, and
        // restoreRendererState() puts the size back at stop.
        if (this.renderer && !this.isRecordingFrames()) {
            const { width: liveWidth, height: liveHeight } = viewportSize();
            this.renderer.getSize(_rendererSizeScratch);
            if (_rendererSizeScratch.x !== liveWidth || _rendererSizeScratch.y !== liveHeight) {
                this.onWindowResize();
            }
        }

        // Drop to 30 FPS when gameplay is paused to reduce GPU/CPU usage.
        // Debug toggle (`debugForceActiveRate`) can override this to keep the editor at 60 FPS.
        const frameInterval = this.currentFrameInterval();

        // FPS capping - skip frame if not enough time has passed
        const now = performance.now();
        const elapsed = now - this.lastFrameTime;

        if (elapsed < frameInterval) {
            return; // Skip this frame
        }

        if (elapsed > 1000) {
            this._wasTabHidden = true;
        }

        this.lastFrameTime = now - (elapsed % frameInterval);
        GameEngine._frameCount++;

        // If physics was permanently halted by a fatal WASM error, the rapier
        // borrow is poisoned: ANY further rapier call (player movement's
        // isKinematic()/setTranslation(), vehicle updates, raycasts, …) throws
        // "recursive use of an object". Those calls live in genreModule.update()
        // and the player controller below, which run every frame — that is the
        // real source of the thousands-per-second error flood that freezes the
        // tab, NOT PhysicsWorld.step() (already gated). Skip ALL gameplay/physics
        // updates and keep only rendering, so the page stays responsive and the
        // log stays readable. Recovery requires a page reload.
        if (this.physicsWorld?.isHalted()) {
            if (!this._physicsHaltedNotified) {
                this._physicsHaltedNotified = true;
                console.error('Physics halted — gameplay frozen to stop the error cascade. Reload the page to recover.');
            }
            if (this.warmupCompileInFlight) {
                return; // same render hold as the main path below
            }
            this.renderActiveFrame();
            this.renderedFrameCount++;
            return;
        }

        // The frame delta comes from the engine's OWN timer, never from
        // `this.clock` — that clock is public on EngineLike, and both of its
        // readers are destructive, so any mid-frame caller (game code, an
        // ambience system) would silently hand this line only the tail of the
        // frame. See FrameTimer's header for the 0.47s-per-4.01s regression
        // that caused. tick() also applies the tab-return discard and the
        // 100ms spike cap.
        if (this._wasTabHidden) {
            this._wasTabHidden = false;
            this.frameTimer.discardNext();
            // The window in flight spans however long the tab was hidden, which describes
            // the browser's backgrounding, not this device's speed.
            this.quality.resetSampling();
            console.log('🪟 Tab returned — discarding stale delta time');
        }
        const rawDeltaTime = this.frameTimer.tick(now);
        const isCurrentlyRecording = this.isRecordingFrames();

        // Force fixed 1/60s timestep during recording (set by ScreenRecorder)
        const deltaTime = this.forceFixedDeltaTime ? 1 / 60 : rawDeltaTime;

        const isCameraPathEditorActive = this.cameraPathEditor?.isEditorEnabled() ?? false;
        // An object voxel edit session hides the whole world, frames one asset,
        // and drives the camera with its own orbit controls — the same
        // "an editor owns the view" situation as the camera-path editor.
        const isVoxelObjectEditActive = this.editorManager?.isInVoxelObjectEditMode() === true;
        const gameplayRunning = this.isGameplayRunning();
        const shouldPauseGameplay = isCameraPathEditorActive || isVoxelObjectEditActive || !gameplayRunning;
        const simulationDeltaTime = shouldPauseGameplay ? 0 : deltaTime;
        this._currentDeltaTime = simulationDeltaTime;
        this._elapsedGameplayTime += simulationDeltaTime;

        if (isCurrentlyRecording) {
            this.gaussianSplatRenderer?.getColliderEditor()?.forceActivateAllVoxelColliders?.();
        }

        // Tell the physics world whether we are actively stepping this frame.
        // While active, `*Immediate` collider/body removals are downgraded to
        // the deferred queue so the broad-phase is never mutated between steps
        // (prevents the "recursive use of an object" rapier panic from a stale
        // scene-query structure — see PhysicsWorld.simulationActive). When
        // paused / not stepping, removals stay immediate (no queries run, and
        // there is no step to flush the queue), matching generation-time behavior.
        const willStep = simulationDeltaTime > 0 && !shouldPauseGameplay;
        this.physicsWorld?.setSimulationActive(willStep);
        // Neutralize the substep meter on intentionally-unstepped frames so the
        // debug panel's judder counter only reflects real pacing beats.
        if (!willStep && this.physicsWorld) this.physicsWorld.lastStepSubstepCount = 1;

        if (willStep) {
            const _physT0 = performance.now();
            if (this.physicsWorld) {
                this.physicsWorld.step(simulationDeltaTime);
                this.physicsWorld.flushCollisionCallbacks();
            } else if (this.physicsWorld2D) {
                this.physicsWorld2D.step(simulationDeltaTime);
                this.physicsWorld2D.flushCollisionCallbacks();
            }
            frameSpanRecorder.record('physics', performance.now() - _physT0);
        }

        VoxelDebrisManager.update();
        voxelObjectDebris.update(simulationDeltaTime);
        if (this.scene) VisualEffects.updateScene(this.scene, simulationDeltaTime);
        boneVoxelLimbs.update(simulationDeltaTime);
        shatterScheduler.beginFrame();

        if (!shouldPauseGameplay) {
            getDecalSystem()?.processPendingDecals();
            // Carved bullet holes. Same timing rule as decals: geometry cannot
            // be rebuilt from inside a physics contact callback.
            getVoxelCarveSystem()?.processPendingCarves();
            // simulationDeltaTime, not the render delta: debris is gameplay
            // matter and must freeze with everything else when paused.
            getHitDebrisSystem()?.update(simulationDeltaTime);
        }

        // A zero delta is not enough to hold a template off the camera: showroom
        // and cinematic templates set the camera to an ABSOLUTE pose every
        // frame, so they overwrote the voxel editor's orbit controls on the
        // frame after every drag (rotation snapped back, the wheel did nothing,
        // and the framing never took). Skip the template outright — its scene
        // is hidden behind the isolated view anyway.
        if (this.genreModule && !isVoxelObjectEditActive) {
            // The game's OWN per-frame work (its WorldGenerator, player controller,
            // weapons, safe zones). Attributed because it is the largest single
            // thing that used to vanish into the derived 'other' remainder, and a
            // template can put anything in here.
            const _genreT0 = performance.now();
            this.genreModule.update(simulationDeltaTime);
            frameSpanRecorder.record('genre', performance.now() - _genreT0);
        }

        // Edge-detect the held push-to-talk key/button (no-op unless enabled).
        this.pushToTalk.update();

        this.dynamicObjectManager.updateMining(simulationDeltaTime);

        // Refresh the navmesh's tracked obstacles BEFORE NPC/animal updates,
        // so pathfinding decisions made this frame see the latest positions
        // of dynamic blockers (chairs, tables, market carts that physics has
        // pushed since the last frame). The tick is cheap — only re-paints
        // when an obstacle has drifted more than one cell-size.
        const _navT0 = performance.now();
        const liveNavMesh = getGlobalNavMesh();
        if (liveNavMesh) liveNavMesh.tick();

        // Run path-conflict scans before NPC updates so any replan that
        // gets triggered this frame is honored on the very next waypoint
        // step. Distributed round-robin: 1 agent per tick, so the cost is
        // O(samples_per_path) per frame regardless of NPC count.
        const pathConflict = getGlobalPathConflictAvoidance();
        if (pathConflict && this.physicsWorld) pathConflict.tick(simulationDeltaTime, this.physicsWorld);
        // Navmesh obstacle refresh + path-conflict scan. Separate from 'npc'
        // because these scale with tracked OBSTACLES, not with NPC count — a
        // level full of pushable props pays here even with no NPCs alive.
        frameSpanRecorder.record('nav', performance.now() - _navT0);

        // Gameplay-time timers (melee hit checks etc.) — frozen while paused,
        // because simulationDeltaTime is zero then. See GameplayTimers.ts.
        advanceGameplayTimers(simulationDeltaTime);

        const _npcT0 = performance.now();
        if (!this._debugDisableNpcs) {
            this.animalRegistry.updateAll(simulationDeltaTime);
            this.npcRegistry?.updateAll(simulationDeltaTime);
        }
        // Split the navigation drain (A* + goal-field flooding) out of 'npc'.
        // Its cost tracks PATH DEMAND, not NPC count, and it is separately
        // budgeted — leaving it folded in made a ~20 ms navigation span read as
        // though per-NPC AI were expensive. Subtracted so the spans still sum.
        const _navDrainMs = getGlobalLodScheduler().getLastNavDrainMs();
        // Avoidance is a physics scene query per granted NPC (a wasm capsule
        // swept against the whole collider set), so it scales with the collider
        // count rather than the NPC count. Split out for the same reason as the
        // drain: inside 'npc' it masquerades as AI cost.
        const _avoidMs = NpcController.takeAvoidanceMs();
        // poseCharacter (2x updateMatrixWorld plus bone lookups) and the KCC
        // movement system (a physics shape cast per NPC per frame) are the two
        // costs that scale with ACTIVE NPC count. Naming them is what turns
        // "NPCs are slow" into something actionable.
        const _poseMs = NpcController.takePoseMs();
        const _moveMs = NpcController.takeMoveMs();
        frameSpanRecorder.record('navDrain', _navDrainMs);
        frameSpanRecorder.record('npcAvoid', _avoidMs);
        frameSpanRecorder.record('npcPose', _poseMs);
        frameSpanRecorder.record('npcMove', _moveMs);
        frameSpanRecorder.record('npc', Math.max(
            0,
            (performance.now() - _npcT0) - _navDrainMs - _avoidMs - _poseMs - _moveMs,
        ));

        // Crowd separation: keep characters from standing inside one another.
        // Runs AFTER every behaviour has moved its agent and BEFORE the frame's
        // transforms are consumed, so what renders is the separated arrangement.
        // Only meaningful while gameplay steps — a paused crowd cannot drift into
        // overlap, and solving it anyway would fight the editor's own dragging.
        if (willStep && !this._debugDisableNpcs) {
            const _crowdT0 = performance.now();
            getGlobalCrowdSolver().solve(getGlobalCrowd());
            frameSpanRecorder.record('crowd', performance.now() - _crowdT0);
        }
        // Push the instanced crowd batches' transforms and clip frames for this
        // frame — after the solver, so what draws is the separated arrangement.
        // Unconditional: a paused crowd still has to be drawn where it stands.
        getGlobalCrowdRenderer().update();
        // Engine-owned player↔NPC separation — after every character has
        // moved, whatever moved them. See enforceCharacterSeparation for why
        // this cannot live in a movement system.
        this.playerController?.enforceCharacterSeparation?.();
        this.traversalChallenges?.update(simulationDeltaTime);
        this.mechanisms?.update(simulationDeltaTime);
        // Smart-object parts pose from gameplay time, so they freeze on pause too.
        this.smartObjects?.update(simulationDeltaTime);
        this.buildings?.update();
        // Dungeon-door proximity sweep. Gameplay time, so it freezes on pause.
        this.doorBridge?.update(simulationDeltaTime);

        this.editorManager?.update(rawDeltaTime);

        // Update debug FBX test mixer if present
        const fbxMixer = (window as any).__fbxTestMixer as THREE.AnimationMixer | undefined;
        fbxMixer?.update(deltaTime);

        if (this.cameraPathEditor?.isEditorEnabled()) {
            this.cameraPathEditor.update(rawDeltaTime);
            this.cameraPathEditor.updatePreview();
        }

        if (this.cameraPathEditor?.isRecording()) {
            const stillRecording = this.cameraPathEditor.updateRecordingPath(deltaTime);
            // Re-read: this frame's camera-path update may have just stopped it.
            if (!stillRecording && this.isRecordingFrames()) {
                this.screenRecorder?.stopRecording();
            }
        }

        this.updateShadowCameraPosition();

        // Per-frame instance-level frustum + distance cull and LOD bucketing
        // for environment objects (city scenery, foliage, etc.). Same timing
        // requirement as the splat cull above: must run before renderer.render
        // so each LOD's InstancedMesh has its post-cull `count` set. The
        // shadow camera is passed so instances behind the player still cast
        // shadows into the visible scene.
        if (this.camera) {
            // Per-instance LOD + cull repack for every env-object type. Scales
            // with placed instances and LOD meshes, and runs whether or not
            // gameplay is stepping — so it must be visible separately from the
            // simulation spans when diagnosing a paused-vs-playing difference.
            const _envCullT0 = performance.now();
            const envObjSystem = getActiveEnvironmentObjectSystem();
            const shadowCam = this.directionalLight?.shadow.camera ?? null;
            envObjSystem?.updateInstanceCulling(this.camera, shadowCam);
            frameSpanRecorder.record('envCull', performance.now() - _envCullT0);
            // Lights riding smart-object parts (a lantern on a cabin) move to
            // the part's current pose — before the pool aims, which is when
            // source positions are copied into the real lights.
            this.environmentLights?.followSmartParts(this.smartObjects);
            // Drive camera-focused PointLightPools (constant-count light pooling;
            // keeps the scene's light count stable to avoid WebGPU shader recompiles).
            updatePointLightPoolsFromCamera(this.camera.getWorldPosition(this._lightPoolFocus));
            // Torch/brazier flicker on light-emitting props. Wall clock, not
            // gameplay time — ambience keeps moving in the editor and pause.
            this.environmentLights?.updateFlicker(this.frameTimer.ambienceTime);
        }

        if (this.gaussianSplatExporterInstance?.isActive() && this.scene && this.renderer) {
            this.gaussianSplatExporterInstance.processFrame(this.scene, this.renderer);
        }

        // WebGPU splat meshes: refresh draw uniforms and re-run the GPU depth
        // sort when needed. Compute dispatches are illegal inside an active
        // render pass on WebGPU, so this must run BEFORE render — an
        // onBeforeRender hook cannot do it.
        if (this.camera) {
            const splatCamera = this.editorManager?.getObjectEditModeCamera?.() || this.camera;
            updateWebGpuSplatMeshes(this.renderer, splatCamera);
        }

        // Post-update, pre-render hooks — camera and all bodies are at their
        // final per-frame transforms here, so a view-model glued to the camera
        // stays locked to it (no one-frame twitch).
        for (const cb of this.beforeRenderCallbacks) { try { cb(); } catch (err) { console.error('beforeRender callback failed:', err); } }

        if (syncViewModelLayer(this)) rebuildComposerPasses(this);

        // A warmup compile owns the renderer right now — drawing the same
        // objects it is async-compiling hands setPipeline() a pending pipeline
        // and permanently kills presentation (see warmupCompileInFlight). Skip
        // just the render: the level-switch fade covers the screen anyway, and
        // the game/physics updates above already ran this frame.
        if (this.warmupCompileInFlight) {
            return;
        }

        // Weather: envelopes, wet-surface uniforms, the rain compute dispatch,
        // and (on level changes) the collision-map bake render. Runs pre-render
        // because compute is illegal inside the render pass — but strictly
        // AFTER the warmup hold above: the bake RENDERS, and rendering while a
        // warmup compileAsync is in flight both reads back empty (pipelines
        // pending) and risks the mid-pass setPipeline failure the hold exists
        // to prevent. Clock time (not gameplay time): rain keeps falling in
        // pause and in the editor.
        this.weatherSystem?.frameUpdate(rawDeltaTime, this.frameTimer.ambienceTime);

        // Measure CPU time spent inside the render call. On WebGPU this captures
        // synchronous pipeline compilation (which runs on the CPU during the draw),
        // distinguishing a compile/submit stall from a GPU- or logic-bound frame.
        const _renderStart = performance.now();
        this.renderActiveFrame();
        this.renderedFrameCount++;
        const _renderMs = performance.now() - _renderStart;
        frameSpanRecorder.record('render', _renderMs);
        const _busyMs = performance.now() - now;
        frameSpanRecorder.endFrame(_busyMs);
        // Maintained unconditionally, not inside the perf-stats branch below: the quality
        // sampler is always on, and reading a gap that only advances while a debug tool is
        // enabled would have measured every published session as a flat zero.
        const _gapMs = this._lastFrameTs > 0 ? now - this._lastFrameTs : 0;
        this._lastFrameTs = now;
        // Cheap by construction: four numbers already computed above, into a running
        // accumulator. See FrameBudgetSampler for why this is not PerfStatsCollector.
        this.quality.recordFrame(now, _gapMs, _busyMs, _renderMs);

        // Record frame for perf stats (must be after render to capture renderer.info)
        if (this.perfStatsCollector) {
            this.perfStatsCollector.recordFrame();
            this.perfStatsCollector.recordFrameTiming(_gapMs, _renderMs, this.camera);
        }

        if (this.isRecordingFrames()) {
            this.screenRecorder?.update(this.scene, this.camera);
        }
    }

    /**
     * The single render call a frame is made of. Extracted so the GPU warmup
     * draws through exactly the same path the frame loop does.
     *
     * That equivalence is the whole point on WebGPU: a render pipeline is
     * cached against its target's COLOUR FORMAT, depth format and sample count
     * (three's `WebGPUBackend.getRenderCacheKey`). When a post chain is active
     * the scene renders into the pass node's HDR (and, with SSR, multi-target)
     * buffer, so pipelines built by rendering the scene straight to the canvas
     * are a different cache entry from the ones the game actually draws with —
     * warming that path leaves every material to compile on the gameplay frame
     * that first draws it.
     */
    private renderActiveFrame(): void {
        this.waterFeatures.update(this._currentDeltaTime, this.camera);
        if (this.bloomPipeline) {
            // WebGPU: the view model is composited INSIDE the node graph
            // (GameEnginePostFx). Drawing it here instead would blank the canvas.
            this.bloomPipeline.render();
            return;
        }
        if (this.composer) {
            this.composer.render();
        } else if (this.renderer && this.scene && this.camera) {
            const editModeCamera = this.editorManager?.getObjectEditModeCamera?.();
            this.renderer.render(this.scene, editModeCamera || this.camera);
        }
        renderViewModelOverlay(this);
    }

    /**
     * The view-model layer, or null before init(). Weapon systems attach their
     * meshes to it; see ViewModelLayer for the camera-local transform contract.
     */
    getViewModelLayer(): ViewModelLayer | null {
        return this.viewModelLayer;
    }

    /**
     * Draw one frame through the engine's own render path.
     *
     * @internal for code that has to force a render outside the animate loop —
     * the screen recorder, which must render and capture in the same task.
     * Exists so those call sites stop re-implementing the branch: every copy
     * has to know about the WebGPU pipeline, the WebGL composer, the direct
     * path AND the view-model overlay, and the last time one drifted it
     * silently dropped all post-FX from WebGPU recordings.
     */
    renderFrameNow(): void {
        this.renderActiveFrame();
    }

    /** The default perspective camera created at boot (never the swapped-in
     *  orthographic one). Camera controllers receive this so they keep a typed
     *  perspective reference even while ortho fit-mode is active. */
    getDefaultCamera(): THREE.PerspectiveCamera {
        if (!this.defaultPerspectiveCamera) {
            throw new Error('getDefaultCamera() called before engine init()');
        }
        return this.defaultPerspectiveCamera;
    }

    /** Swap the active render camera (e.g. to/from an orthographic top-down
     *  camera) and rebind the post-processing passes, which capture the camera
     *  at construction. */
    setRenderCamera(cam: THREE.PerspectiveCamera | THREE.OrthographicCamera): void {
        if (this.camera === cam) return;
        this.camera = cam;
        this.onWindowResize();
        rebuildComposerPasses(this);
    }

    /** {@link LevelEngineSurface.noteQualityDisturbance} */
    noteQualityDisturbance(reason: string): void {
        // A level switch can finish between two rendered frames; polling its loading
        // flag alone would miss the entire gap and carry the old bad-window streak.
        this.quality.resetSampling();
        this.quality.noteDisturbance(reason);
    }

    onWindowResize(): void {
        // A resize reallocates every render target; the frames around it are not gameplay.
        this.quality.noteDisturbance('resize');
        if (this.camera && this.renderer) {
            const { width, height } = viewportSize();
            // Orthographic cameras get no aspect update: the active controller
            // (TopDownCamera fit-world) recomputes the frustum each frame from
            // the viewport aspect, so refreshing the projection matrix is enough.
            if (this.camera instanceof THREE.PerspectiveCamera) {
                this.camera.aspect = width / height;
            }
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(width, height);

            if (this.composer) {
                this.composer.setSize(width, height);
            }

            // BloomNode is deliberately NOT resized here. It builds its blur materials lazily in
            // setup(), which runs on the first frame that actually renders the post chain, and
            // its setSize() dereferences `_separableBlurMaterials[i].invSize` with no guard — so
            // calling it before that first render throws "Cannot read properties of undefined
            // (reading 'invSize')". The size self-heal in the animate loop reaches exactly that
            // state: a game loaded in an iframe starts at a 0-size viewport, the renderer is
            // floored to 1x1, and the first frame calls onWindowResize() before anything has
            // rendered. That is invisible to `bitmagic dev` and `bitmagic verify`, which serve the
            // page directly with a real viewport from the start — it only appears in the portal,
            // which loads published games in an iframe.
            //
            // The call was redundant anyway: BloomNode.updateBefore() re-syncs from
            // renderer.getDrawingBufferSize() on every frame it renders. It was also passing the
            // wrong units — `width`/`height` here are CSS pixels from viewportSize(), while the
            // drawing buffer is device pixels, so on any devicePixelRatio != 1 display this set a
            // size the next rendered frame immediately corrected.
            //
            // warmUpScene() documents the same invSize failure from its own call site, where it
            // was fixed by not resizing mid-warmup; this site kept the hazard until a published
            // game hit it.

            if (this.outlinePass) {
                this.outlinePass.setSize(width, height);
            }
        }
    }

    dispose(): void {
        // A disposed game's pending hit checks must never fire into the next one.
        clearGameplayTimers();
        // Stop the animation loop first to prevent callbacks on disposed state
        if (this._animFrameId) {
            cancelAnimationFrame(this._animFrameId);
            this._animFrameId = 0;
        }

        // Stop the play-session heartbeat loop (P6). Idempotent; safe if never started.
        getPlayProgress()?.stop();
        // Push any save still waiting on its debounce, then stop syncing.
        disposeCloudSaves();
        this.achievementToast.dispose();
        // The cutscene overlay lives on <body>, so it outlives the container.
        this.videoPlayer.dispose();

        this.worldGroup = null;
        VoxelObjectBuilder.setWorldGroup(null);

        if (this.cameraPathEditor) {
            this.cameraPathEditor.dispose();
            this.cameraPathEditor = null;
        }

        if (this.screenRecorder) {
            this.screenRecorder.dispose();
            this.screenRecorder = null;
        }

        if (this.editorManager) {
            this.editorManager.dispose();
            this.editorManager = null;
        }

        this.disposeSplatRenderers();

        this.npcRegistry?.disposeAll();

        this.dynamicObjectManager.disposeMining();

        if (this.environmentLights) {
            this.environmentLights.dispose();
            this.environmentLights = null;
        }

        this.disposeWorldSystems();

        this.currentGameData = null;
        this.gameplayPlaneZ = null;

        // Reset interaction manager before physics world (it holds collider handles)
        resetInteractionManager();
        DropZoneComponent.clearRegistry();
        clearCarryEventListeners();

        if (this.physicsWorld) {
            this.physicsWorld.dispose();
            this.physicsWorld = null;
        }

        this.planeLockedPhysics = null;
        if (this.physicsWorld2D) {
            this.physicsWorld2D.dispose();
            this.physicsWorld2D = null;
        }

        this.scene?.traverse((obj: THREE.Object3D) => {
            if (!(obj instanceof THREE.Mesh)) return;
            obj.geometry?.dispose();
            if (!obj.material) return;
            const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
            for (const mat of materials) disposeMaterialAndTextures(mat);
        });

        // Dispose post-processing (render targets + framebuffers)
        if (this.bloomPass) {
            this.bloomPass.dispose();
            this.bloomPass = null;
        }
        if (this.outlinePass) {
            this.outlinePass.dispose();
            this.outlinePass = null;
        }
        if (this.composer) {
            this.composer.dispose();
            this.composer = null;
        }
        if (this.bloomPipeline) {
            this.bloomPipeline.dispose();
            this.bloomPipeline = null;
        }
        this.bloomNode = null;

        if (this.renderer) {
            this.container.removeChild(this.renderer.domElement);
            this.renderer.dispose();
            this.renderer = null;
        }
        // The KTX2 transcoder's worker pool outlives the renderer otherwise, and its
        // detected format set belongs to the device that just went away.
        disposeGltfLoaderSupport();

        // Remove all window/document listeners added by setupWindowFocusListeners
        for (const { target, event, handler, options } of this.boundFocusListeners) {
            target.removeEventListener(event, handler, options);
        }
        this.boundFocusListeners = [];

        if (this.audioPlayer) {
            this.audioPlayer.dispose();
            this.audioPlayer = null;
        }

        // Unconditional: the debris system is owned by the scene, not the audio
        // player, and a game with no audio still has to give its meshes back.
        disposeHitDebrisSystem();

        this.loader = null;
        this.scene = null;
        this.camera = null;
    }

    registerPlayerController(playerController: PlayerControllerLike): void {
        this.playerController = playerController;
    }

    /**
     * Register a callback fired every frame AFTER all updates (genre, camera,
     * physics-interpolated bodies) and immediately BEFORE render. Use it to
     * pin a visual to the camera's final per-frame transform — e.g. a
     * first-person view-model weapon — so it doesn't lag the camera by a frame
     * and twitch while the player moves/turns. Returns an unregister function.
     */
    registerBeforeRender(callback: () => void): () => void {
        this.beforeRenderCallbacks.add(callback);
        return () => { this.beforeRenderCallbacks.delete(callback); };
    }

    getPlayerController(): PlayerControllerLike | null {
        return this.playerController;
    }

    /**
     * Toggle the experimental MacBook-lid controller (localhost only). Forwarded
     * from the creator DevTools tab via the SET_LID_CONTROL postMessage; no-op off
     * localhost or before a player controller exists.
     */
    setLidControlEnabled(enabled: boolean): void {
        this.playerController?.setLidControlEnabled?.(enabled);
    }

    getActiveVehicle(): any | null {
        return this.playerController?.getActiveVehicle?.() ?? null;
    }

    getVehicleSpawner(): import('./VehicleSpawner.js').VehicleSpawner | null {
        return this.vehicleSpawner;
    }

    setVehicleSpawner(spawner: import('./VehicleSpawner.js').VehicleSpawner): void {
        this.vehicleSpawner = spawner;
    }

    getVehicleManager(): import('./VehicleManager.js').VehicleManager | null {
        return this.vehicleManager;
    }

    setVehicleManager(manager: import('./VehicleManager.js').VehicleManager): void {
        this.vehicleManager = manager;
    }

    getSpawner(): import('./Spawner.js').Spawner | null {
        return this.spawner;
    }

    setSpawner(spawner: import('./Spawner.js').Spawner): void {
        this.spawner = spawner;
    }

    getPlayerLoader(): import('./loaders/PlayerLoader.js').PlayerLoader | null {
        return this.playerLoader;
    }

    setPlayerLoader(loader: import('./loaders/PlayerLoader.js').PlayerLoader): void {
        this.playerLoader = loader;
    }

    // ──────────────────────────────────────────────────────────────────────
    // Level preloading & GPU warmup
    //
    // The bodies live in GameEngineWarmup.ts — a friend module, because this
    // file sits at the repo's 2000-line ESLint cap; see that header for why
    // preloading and the warmup travel together and what they are for. The
    // STATE stays declared here: animate() reads warmupCompileInFlight every
    // frame and loadGame() resets preloadDone.
    // ──────────────────────────────────────────────────────────────────────

    private preloadDone = false;
    /** Covers the entire load, including genres that enter PLAYING before load() resolves. */
    private gameLoadComplete = false;

    /** True once preloadLevel()'s scene-wide GPU warmup render has completed. */
    private sceneWarmedUp = false;
    /** Callbacks waiting on the scene-wide warmup (see onSceneWarmedUp). */
    private sceneWarmedUpCallbacks: Array<() => void> = [];

    /** Warmup serialization chain — see GameEngineWarmup.runSceneWarmup(). */
    private warmupChain: Promise<unknown> = Promise.resolve();

    /**
     * True while warmUpScene() has an async pipeline compile in flight. The
     * animate() loop must not render then: compileAsync() registers pipeline
     * cache entries whose GPU pipeline is still pending, and a concurrent
     * render that draws the same objects passes that pending entry straight to
     * setPipeline() — "parameter 1 is not of type 'GPURenderPipeline'". The
     * throw aborts render() mid-pass, and the renderer never presents again
     * (permanent black screen with the DOM HUD still alive). Only a problem
     * when the warmed objects are VISIBLE to the loop — i.e. the level-switch
     * warmup (warmUpLoadedScene), where the fade is DOM-only and the loop keeps
     * drawing the freshly built level. The boot warmup only async-compiles
     * hidden subtrees, but holds the same gate for the few frames it runs.
     */
    private warmupCompileInFlight = false;

    /** @see GameEngineWarmup.addSceneWarmedUpCallback */
    onSceneWarmedUp(cb: () => void): void {
        addSceneWarmedUpCallback(this, cb);
    }

    /** @see GameEngineWarmup.runLevelPreload */
    async preloadLevel(opts?: { audioAssetIds?: string[] }): Promise<void> {
        await runLevelPreload(this, opts);
    }

    /** @see GameEngineWarmup.runLoadedSceneWarmup */
    async warmUpLoadedScene(onProgress: WarmupProgressFn): Promise<void> {
        await runLoadedSceneWarmup(this, onProgress);
    }

    /** @see GameEngineWarmup.runPlayerCharacterPreload */
    async preloadPlayerCharacter(): Promise<void> {
        await runPlayerCharacterPreload(this);
    }

    /** @see GameEngineWarmup.runNpcSkeletonPreload */
    async preloadNpcSkeleton(): Promise<void> {
        await runNpcSkeletonPreload(this);
    }

    /** @see GameEngineWarmup.runAudioPreload */
    async preloadAudio(idsOrUrls: string[]): Promise<void> {
        await runAudioPreload(this, idsOrUrls);
    }

    /**
     * @see GameEngineWarmup.runSceneWarmup
     * `reveal` keeps its default — this is public engine surface that frozen
     * template code may call. No progress surface exists at this call depth.
     */
    async warmUpScene(reveal: THREE.Object3D[] = []): Promise<boolean> {
        return runSceneWarmup(this, reveal, DEFAULT_WARMUP_PROGRESS);
    }

    getPlayerVisibility(): PlayerVisibility {
        return this.playerVisibility;
    }

    getAnimalRegistry(): AnimalRegistry {
        return this.animalRegistry;
    }

    getAIService(): AIService {
        return this.aiService;
    }

    /**
     * Voice input service — microphone capture + speech-to-text. Use
     * `startListening()` / `stopListening()` for custom flows (NPC dialogs,
     * toggle buttons); for plain hold-to-talk use `enablePushToTalk()` instead.
     */
    getVoiceInput(): VoiceInput {
        return this.voiceInput;
    }

    /**
     * One-call push-to-talk: hold `V` (desktop) or the TALK button (mobile) to
     * speak; the transcript arrives in `onTranscript`. Registers the mobile
     * button automatically, shows a recording indicator, and surfaces failures
     * as HUD toasts (override via `options.onError`). Call in `Game.load()`;
     * resets on each `loadGame()` like `enableMuteControl()`.
     */
    enablePushToTalk(onTranscript: (text: string) => void, options?: Partial<PushToTalkOptions>): void {
        this.pushToTalk.configure(onTranscript, options);
        // Called after load (player controller already registered)? Wire now —
        // otherwise the post-genre-load hook in loadGame does it.
        if (this.playerController) {
            this.pushToTalk.wire(this.playerController, this.genreModule?.hud ?? null, this.container);
        }
    }

    getScreenshotService(): ScreenshotService {
        return this.screenshotService;
    }

    getGameDataService(): GameDataService {
        return this.gameDataService;
    }

    /**
     * Tell the website this game has a leaderboard, so it can show it.
     *
     * Call it once the board exists — right after the first score is written is
     * the natural place, and repeat calls within a session are dropped. The
     * website cannot find a board on its own: it can neither list a game's
     * categories nor guess which way a board sorts, so an undeclared board is
     * invisible there no matter how many rows it has.
     *
     * Ghost racing declares its own boards; a game only calls this for a board
     * it writes itself through `GameDataService`.
     *
     * ⚠ `field` must name the key inside `values` that actually holds the
     * number. The service omits rows that lack the sorted field, so a wrong
     * name here shows an empty board rather than an error.
     */
    async publishLeaderboard(declaration: LeaderboardDeclaration): Promise<void> {
        await publishLeaderboard(this.gameDataService, declaration);
    }

    /**
     * What the URL asked for when this game was opened — a track, a ghost to
     * race, or neither.
     *
     * Read this before a menu decides where the player starts. The engine
     * already honours `trackLevelId` when it boots (`levelResolve.ts`) and
     * `ghostEntryId` when ghosts line up, so a game that ignores this still
     * behaves — but a game that shows its own track selector will sit on that
     * menu instead of racing, and only the game knows it has one.
     *
     * ⚠ Untrusted input, straight off a URL. Treat a value as a request: an id
     * that names nothing in this game must fall back to normal behaviour.
     */
    getLaunchParams(): LaunchParams {
        return getLaunchParams();
    }

    getGamePersistence(): GamePersistence {
        return (this.gamePersistence ??= new GamePersistence(new LocalStorageAdapter(), 'unknown', 1));
    }

    /**
     * Ghost recording and replay (docs/ghost-racing-design.md).
     *
     * Built on first use rather than at construction: it needs the game id,
     * which arrives with the loaded game, and a game that never races one
     * should not pay for the identity round trip.
     */
    getGhostRacing(): GhostRacing {
        return (this.ghostRacing ??= installGhostRacing(
            this, this.gameDataService, this.loadedGameId, this.ensurePlayerIdentity(),
        ));
    }

    /**
     * Who this player is on a leaderboard — id, credential, and display name.
     *
     * Pass `playerId` and `verifier` to every `GameDataService.create()` that
     * writes a board row. Without them the service stamps no owner, and the
     * website has nothing to attribute the row to: it renders as a generated
     * guest name with no avatar and no profile link even when the player is
     * signed in, because a name in `values` is client-supplied and a board
     * will not show an unverified string as a player.
     *
     * Use `displayName` for the name too. A game must NEVER ask the player to
     * type one — a signed-in player already chose a name on their profile, and
     * asking again creates a second identity that agrees with nothing.
     *
     * ⚠ `verifier` is a bearer credential: it goes in the `create()` call and
     * nowhere else. Never write it into `data` or `values` — reads are public.
     *
     * Resolving costs one round trip on first call and is cached after that,
     * so a game may call it per submit rather than holding the result.
     */
    async getLeaderboardIdentity(): Promise<LeaderboardIdentity> {
        return this.ensurePlayerIdentity().identity.info();
    }

    /**
     * The one identity for the loaded game, built on first use.
     *
     * Not at construction: it needs the game id, which arrives with the loaded
     * game, and a game that touches no board should not pay for the mint.
     */
    private ensurePlayerIdentity(): PlayerIdentitySetup {
        return (this.playerIdentity ??= createPlayerIdentity(this.loadedGameId));
    }

    getDynamicObjectManager(): DynamicObjectManager {
        return this.dynamicObjectManager;
    }

    getNpcRegistry(): NpcRegistry | null {
        return this.npcRegistry;
    }

    setNpcRegistry(registry: NpcRegistry): void {
        this.npcRegistry = registry;
    }

    registerNpc(name: string, behavior: INpcBehavior, options?: RegisterNpcOptions): NpcHandle {
        const registry = (this.npcRegistry ??= new NpcRegistry(this));
        const manager = createNpcManager(this, name, behavior, options?.autoRespawn);
        if (options?.characterFactory) {
            manager.setCharacterFactory(options.characterFactory);
        }
        if (options?.importance) { manager.setImportance(options.importance); }
        if (options?.planeLock === false) { manager.setPlaneLockEnabled(false); }
        const characterUrl = resolveNpcCharacterUrl(options, this.currentGameData);
        if (characterUrl) {
            manager.setNpcCharacterUrl(characterUrl);
        } else if (options?.characterAssetId) {
            console.warn(`[GameEngine] NPC character asset not found: ${options.characterAssetId}`);
        }
        if (typeof options?.characterModelRotationY === 'number') {
            manager.setNpcModelRotationY(options.characterModelRotationY);
        }
        if (options?.eyeLook) {
            manager.setNpcEyeLook(options.eyeLook);
        }
        if (options?.damageable) {
            manager.setDamageableConfig(options.damageable);
        }
        registry.register(name, manager);
        if (options?.onDeath) {
            const deathCb = options.onDeath;
            const existingCb = registry.onNpcDeath;
            registry.onNpcDeath = (npcId, npcType, position) => {
                existingCb?.(npcId, npcType, position);
                if (npcType.toLowerCase() === name.toLowerCase()) {
                    deathCb(npcId, npcType, position);
                }
            };
        }
        return new NpcHandleImpl(name, manager);
    }

    getPointerLockManager(): import('./PointerLockManager.js').PointerLockManager | null {
        return this._pointerLockManager;
    }

    setPointerLockManager(manager: import('./PointerLockManager.js').PointerLockManager): void {
        this._pointerLockManager = manager;
    }

    /**
     * Release the mouse cursor for in-game UI (dialogues, shops, menus) without
     * showing the blur overlay. Also disables player movement controls.
     * Call exitInteractiveUI() when the UI is dismissed.
     */
    enterInteractiveUI(): void {
        const plm = this._pointerLockManager;
        if (plm) {
            plm.setInteractiveUIMode(true);
            plm.exitLock();
        }
        this.setPlayerControlsEnabled(false);
    }

    /** `setControlsEnabled` is an optional controller method, not on PlayerControllerLike. */
    private setPlayerControlsEnabled(enabled: boolean): void {
        const pc = this.playerController as (PlayerControllerLike & { setControlsEnabled?: (v: boolean) => void }) | null;
        pc?.setControlsEnabled?.(enabled);
    }

    /**
     * Re-lock the mouse cursor and restore player controls after an interactive
     * UI session started with enterInteractiveUI().
     */
    exitInteractiveUI(): void {
        this.setPlayerControlsEnabled(true);
        const plm = this._pointerLockManager;
        if (plm) {
            // Ask first, so the click that closed the UI takes the cursor straight back without
            // a prompt flashing up in between; the prompt only shows if the browser refuses.
            plm.requestLockWithRetry();
            plm.setInteractiveUIMode(false);
        }
    }

    // ==================== TEMPLATE STARTUP FLOW ====================
    
    setStartGameHandler(handler: () => void): void {
        this.startGameHandler = handler;
    }
    
    setPlayButtonVisibilityHandler(handler: (visible: boolean) => void): void {
        this.playButtonVisibilityHandler = handler;
    }

    /**
     * Register the handler for startup UI ownership changes.
     * Multiplayer/custom flows can temporarily suppress the default engine menu
     * while still using the same engine start transition.
     */
    setStartupUiModeHandler(handler: (mode: StartupUiMode) => void): void {
        this.startupUiModeHandler = handler;
    }
    
    /**
     * Start the game programmatically — triggers the same flow as clicking the Play button.
     * Fires analytics, transitions to PLAYING state, enables controls, pointer lock, etc.
     * 
     * Use this when the template hides the Play button (e.g., for a level selector)
     * and needs to start gameplay from its own UI.
     */
    startGame(): void {
        if (this.startGameHandler) {
            this.startGameHandler();
        } else {
            console.warn('[GameEngine] startGame() called but no handler registered');
        }
    }
    
    /**
     * Show or hide the engine's Play button.
     * Before first start, setPlayButtonVisible(false) degrades to a fallback Start
     * control unless the template provides another way for the player to begin.
     * Templates must never remove the only start affordance.
     */
    setPlayButtonVisible(visible: boolean): void {
        if (this.playButtonVisibilityHandler) {
            this.playButtonVisibilityHandler(visible);
        }
    }

    /**
     * Select which system owns the pre-start UI.
     * `engine` shows the normal engine start menu, `external` suppresses it so
     * another in-iframe UI can own the startup flow.
     */
    setStartupUiMode(mode: StartupUiMode): void {
        this.startupUiModeHandler?.(mode);
    }

    /**
     * End the current game session. Transitions to GameState.END (which freezes
     * physics, NPCs, and genre update() via the same gating PAUSED uses) and
     * renders a themed default overlay with a "Play Again" button that triggers
     * a full page reload. PokiSDK's gameplayStop() fires automatically via the
     * state listener.
     *
     * Genres call this from their own win/lose conditions:
     *   this.engine.endGame({ outcome: 'win', title: 'You Win!', stats: [...] });
     *
     * Idempotent — calling twice is safe; the existing overlay is removed and
     * recreated, and the state listener early-returns when already in END.
     */
    endGame(options: Partial<EndGameOptions> = {}): void {
        const resolved: EndGameOptions = { ...DEFAULT_END_GAME_OPTIONS, ...options };
        if (!this.gameStateManager) {
            throw new Error('endGame() called before GameRuntimeController attached the state manager');
        }
        getGameEventLog().logEvent({ type: 'match-end', data: { outcome: resolved.outcome, title: resolved.title } });
        this.gameStateManager.transitionToEnd();
        this.enterInteractiveUI();
        const hud = this.genreModule?.hud;
        if (!hud) {
            return;
        }
        const override = this.uiComponents.get('end') ?? null;
        if (isEndScreenComponent(override)) {
            override.render(hud, resolved);
        } else {
            showEndOverlay(hud, resolved);
        }
    }

    /**
     * Unlock a player achievement by its authored slug (umbrella P6). Delegates
     * to the play-progress subsystem: dedups per session, shows a HUD toast
     * (guests included), and posts the unlock to the backend only when a play
     * token is available. Fire-and-forget — never throws, never blocks gameplay.
     *
     * Definitions live in game data (`worldProfileData.achievements`), authored
     * via the agent's manage-achievements tool; game code only references ids.
     *
     *   this.engine.unlockAchievement('first_blood');
     */
    unlockAchievement(id: string): void {
        getPlayProgress()?.unlockAchievement(id);
    }

    /**
     * Install (or remove with `null`) a custom UI component in one of the
     * three screen slots: `'start'`, `'pause'`, `'end'`. Override components
     * fully replace the default templates for that slot. When replaced or
     * cleared, the previous component's `dispose()` (if any) is called.
     *
     * Genres and per-game code typically call this from their `init()` to
     * provide custom branding or layout while still letting the engine drive
     * the state machine. For `'start'` and `'pause'`, the runtime controller
     * disposes its default template when the override is installed — see
     * `GameRuntimeController.attachEngine`.
     */
    setUIComponent(slot: UISlot, component: GameUIComponent | null): void {
        const existing = this.uiComponents.get(slot);
        existing?.dispose?.();
        if (component === null) {
            this.uiComponents.delete(slot);
        } else {
            this.uiComponents.set(slot, component);
        }
        this.uiSlotChangeHandler?.(slot);
    }

    getUIComponent(slot: UISlot): GameUIComponent | null {
        return this.uiComponents.get(slot) ?? null;
    }

    /**
     * How the start, pause and end screens appear and disappear — the engine's own, and any
     * custom screen built on the `ui-modal-overlay ui-modal-overlay--animated` markup.
     * The default is a short fade with the card rising into place (`DEFAULT_SCREEN_TRANSITION`).
     * `{ style: 'fade' }` drops the rise, and `{ style: 'none' }` makes screens instant.
     * `enterMs` / `leaveMs` set the lengths, and fields left out take their defaults.
     * Players whose OS asks for reduced motion always get instant screens. Reset to the
     * default on every game load, so call it from `init()`.
     */
    setScreenTransition(options: Partial<ScreenTransitionOptions>): void {
        applyScreenTransition({ ...DEFAULT_SCREEN_TRANSITION, ...options });
    }

    /**
     * Register a handler invoked after any `setUIComponent` call. The runtime
     * controller uses this to dispose the default StartScreen / PauseScreen
     * once a genre or per-game file installs an override.
     */
    setUIComponentChangeHandler(handler: (slot: UISlot) => void): void {
        this.uiSlotChangeHandler = handler;
    }

    /**
     * Record a main-screen pre-play pick (selection id → picked option id, or
     * level id for a 'level' step). Called by the runtime between load and
     * gameplay start; game code reads them via getPreGameSelections().
     */
    setPreGameSelection(selectionId: string, optionId: string): void {
        this.preGameSelections[selectionId] = optionId;
    }

    /**
     * The player's main-screen picks for this load, keyed by
     * `hud.startScreen.selections[].id`. Empty object when the game has no
     * selections (or the flow auto-skipped them — editor preview, autostart —
     * in which case each step's DEFAULT was applied and recorded here).
     * Returns a copy; read at startGame() time or later.
     */
    getPreGameSelections(): Record<string, string> {
        return { ...this.preGameSelections };
    }

    getRenderer(): THREE.WebGLRenderer {
        if (!this.renderer) {
            throw new Error('Renderer not initialized');
        }
        return this.renderer;
    }

    getGameData(): GameData | null {
        return this.currentGameData;
    }

    /**
     * Whether the screen recorder is currently capturing frames.
     * Templates should disable visibility culling during recording because the
     * recording camera may have a different aspect ratio than the editor camera,
     * causing frustum mismatches that leave chunks invisible in the recorded output.
     */
    isRecordingFrames(): boolean {
        return this.screenRecorder?.isCurrentlyRecording() ?? false;
    }

    /** The camera path editor, for the screen recorder's fly-through capture. Null before the renderer exists. */
    getCameraPathEditor(): CameraPathEditor | null {
        return this.cameraPathEditor;
    }

    /**
     * Enable perf stats emission to the creator (debug tab).
     */
    enablePerfStats(): void {
        if (!this.renderer || !this.scene) return;
        if (!this.perfStatsCollector) {
            this.perfStatsCollector = new PerfStatsCollector(this.renderer, this.scene, this.physicsWorld, () => this.getTargetFps());
        } else {
            this.perfStatsCollector.setPhysicsWorld(this.physicsWorld);
        }
        this.perfStatsCollector.startEmitting(500);
    }

    /**
     * Disable perf stats emission.
     */
    disablePerfStats(): void {
        this.perfStatsCollector?.stopEmitting();
    }

    /**
     * Reset orphaned geometry and shader churn tracking in perf stats.
     * Call on game reload to start fresh.
     */
    resetPerfOrphanTracking(): void {
        this.perfStatsCollector?.resetOrphanTracking();
        this.perfStatsCollector?.resetChurnTracking();
    }

    getGaussianSplatExporter(): GaussianSplatExporter {
        if (!this.gaussianSplatExporterInstance) {
            this.gaussianSplatExporterInstance = new GaussianSplatExporter();
        }
        return this.gaussianSplatExporterInstance;
    }

    /**
     * Play a video cutscene as a fullscreen overlay.
     * Resolves when the video ends or is skipped.
     * @param assetId - The asset ID from world.json assets array
     * @param options - Skip and fade behaviour; see {@link VideoPlayOptions} for each default
     */
    async playVideo(assetId: string, options?: VideoPlayOptions): Promise<void> {
        const url = getAssetUrlById(this.currentGameData, assetId);
        if (!url) {
            console.warn(`[GameEngine] Video asset not found: ${assetId}`);
            return;
        }
        await this.videoPlayer.play(url, options);
    }

    /**
     * Play a one-shot sound effect from an audio asset (e.g. opus/ogg).
     * Fire-and-forget — multiple SFX can overlap.
     */
    playSound(assetId: string, opts?: { volume?: number }): void {
        this.markAudioUsed();
        if (!this.audioPlayer) return;
        const url = getAssetUrlById(this.currentGameData, assetId);
        if (!url) {
            console.warn(`[GameEngine] Sound asset not found: ${assetId}`);
            return;
        }
        getGameEventLog().logAssetSound(assetId, url, opts?.volume);
        this.audioPlayer.playSound(url, opts);
    }

    /**
     * Play a background music track from an audio asset. Only one music track
     * plays at a time — cross-fades if another is already playing.
     * Defaults: loop=true, fadeIn=0.5s, volume=1.
     */
    async playMusic(assetId: string, opts?: { loop?: boolean; fadeIn?: number; volume?: number }): Promise<void> {
        this.markAudioUsed();
        if (!this.audioPlayer) return;
        const url = getAssetUrlById(this.currentGameData, assetId);
        if (!url) {
            console.warn(`[GameEngine] Music asset not found: ${assetId}`);
            return;
        }
        getGameEventLog().logMusic('play', { assetId, url, volume: opts?.volume, loop: opts?.loop, fadeIn: opts?.fadeIn });
        await this.audioPlayer.playMusic(url, opts);
    }

    /**
     * Fade out and stop the current music track. Default fadeOut=0.5s.
     */
    async stopMusic(opts?: { fadeOut?: number }): Promise<void> {
        if (!this.audioPlayer) return;
        getGameEventLog().logMusic('stop', { fadeOut: opts?.fadeOut });
        await this.audioPlayer.stopMusic(opts);
    }

    /**
     * Trailer-timeline hooks. Both are no-ops unless an F9 frame recording is
     * running, so game code calls them unconditionally. `logGameEvent` records
     * a gameplay moment the engine can't see itself (score, lap, goal…);
     * `logSoundEvent` records a synthesized SFX, and the recipe is what lets it
     * be re-rendered offline. Documented for game code on `EngineLike`; the
     * op shapes live in GameEventLog.
     */
    logGameEvent(event: GameEventInput): void { getGameEventLog().logEvent(event); }

    logSoundEvent(name: string, recipe?: SynthSoundRecipe): void { getGameEventLog().logSynthSound(name, recipe); }

    /**
     * Set audio volumes. 0=silent, 1=full.
     * `master` affects everything (including THREE.Audio / PositionalAudio).
     */
    setAudioVolume(opts: { master?: number; sfx?: number; music?: number }): void {
        if (!this.audioPlayer) return;
        this.audioPlayer.setVolume(opts);
    }

    /**
     * Return the shared Web Audio API AudioContext used by the engine.
     * Templates that use the Web Audio API directly should use this context so that
     * muting (via engine.setAudioVolume or the default mute button) takes effect.
     * Connect audio nodes to engine.getAudioDestination() to route them through
     * the master volume control.
     */
    getAudioContext(): AudioContext | null {
        this.markAudioUsed();
        return this.audioPlayer?.getContext() ?? null;
    }

    /**
     * Return the master gain input node (THREE.AudioListener's gain).
     * Connect Web Audio API source nodes here to have them controlled by
     * engine.setAudioVolume({ master: N }) (master volume slider / mute button).
     */
    getAudioDestination(): AudioNode | null {
        this.markAudioUsed();
        return this.audioPlayer?.getInput() ?? null;
    }

    /**
     * Enable the engine's HUD mute button for this game.
     *
     * Opt-in: call this in `Game.load()` to add an on-screen mute button
     * (top-right). Not needed for muting itself — the pause menu's Mute toggle
     * and the `M` key shortcut work without it. Mute state is persisted per-game in
     * localStorage and silences both engine audio and Web Audio API nodes
     * routed through the shared AudioContext.
     *
     * The flag resets on each `loadGame()` call, so each template controls its own preference.
     */
    enableMuteControl(): void {
        this.muteControlEnabled = true;
        // Opting into a mute button implies the game has audio — mark it used so
        // the persisted mute preference is applied immediately and the button
        // (and pause toggle) render the correct initial state.
        this.markAudioUsed();
    }

    /**
     * True once the game has used audio (played a sound/music or grabbed the
     * shared audio context/destination). The pause menu shows its mute toggle
     * only when this is true, so silent games stay clutter-free.
     */
    isAudioUsed(): boolean {
        return this._audioUsed;
    }

    /** Current mute state — the single source of truth for the pause toggle and HUD button. */
    isAudioMuted(): boolean {
        return this._audioMuted;
    }

    /**
     * Set the global mute state: silences the master gain and suspends/resumes
     * the shared AudioContext (so raw Web Audio routed through it is silenced
     * too), persists the preference per-game, and notifies UI listeners.
     */
    setAudioMuted(muted: boolean): void {
        this._audioMuted = muted;
        this.audioPlayer?.setVolume({ master: muted ? 0 : 1 });
        const ctx = this.audioPlayer?.getContext();
        if (ctx) {
            (muted ? ctx.suspend() : ctx.resume()).catch(() => { /* ignore */ });
        }
        try {
            localStorage.setItem(`bm-mute-${this.currentGameData?.gameId ?? 'unknown'}`, String(muted));
        } catch { /* localStorage unavailable */ }
        for (const cb of this.audioMuteListeners) cb(muted);
    }

    /**
     * Resume the shared AudioContext unless the user muted — mute deliberately
     * suspends the context (see setAudioMuted), so an unguarded resume would
     * defeat it. `!== 'running'` rather than `=== 'suspended'` so iOS Safari's
     * non-standard 'interrupted' state recovers too; it isn't in the TS
     * AudioContextState union, so this is also the only comparison that
     * typechecks. Idempotent and safe to call outside a gesture stack (a
     * blocked resume rejects and is ignored).
     */
    private resumeAudioContextIfAllowed(): void {
        if (this._audioMuted) return;
        const ctx = this.audioPlayer?.getContext();
        if (ctx && ctx.state !== 'running') {
            ctx.resume().catch(() => { /* blocked outside a gesture; ignore */ });
        }
    }

    /**
     * After a mic session (TALK), iOS holds the OS audio session in
     * play-and-record, which ducks/re-routes game output and can leave the
     * shared context 'interrupted'. Nudge it back immediately and again after
     * ~300 ms — the OS session takes a beat to flip from record to playback.
     */
    private handleMicrophoneReleased(): void {
        this.resumeAudioContextIfAllowed();
        window.setTimeout(() => this.resumeAudioContextIfAllowed(), 300);
    }

    /**
     * Subscribe to mute-state changes so multiple controls (pause toggle, HUD
     * button) stay in sync. Returns an unsubscribe function.
     */
    onAudioMuteChange(cb: (muted: boolean) => void): () => void {
        this.audioMuteListeners.add(cb);
        return () => { this.audioMuteListeners.delete(cb); };
    }

    /**
     * Enable/disable the default `M`-key mute shortcut (on by default). Games
     * that use `M` for something else can opt out — call in `Game.load()`. The
     * shortcut only acts once the game has used audio.
     */
    setMuteHotkeyEnabled(enabled: boolean): void {
        this.muteHotkeyEnabled = enabled;
    }

    /**
     * Mark audio as used and, on the first use for this game, apply the persisted
     * mute preference (which also clears any stale mute left on the shared master
     * gain by a previously-loaded game).
     */
    private markAudioUsed(): void {
        if (this._audioUsed) return;
        this._audioUsed = true;
        let persisted = false;
        try {
            persisted = localStorage.getItem(`bm-mute-${this.currentGameData?.gameId ?? 'unknown'}`) === 'true';
        } catch { /* localStorage unavailable */ }
        this.setAudioMuted(persisted);
    }

    /**
     * Give an object a low-level emissive tint so it self-illuminates and stands
     * out under the scene's full-scene bloom. See engine/effects/BloomTint.ts.
     */
    enableBloomOnObject(object: THREE.Object3D): void {
        applyBloomTint(object);
    }
}
