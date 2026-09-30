// Creator/editor message handler — extracted from GameTemplate.ts so the entire
// creator<->game command surface (and its heavy editor-only imports) can be
// stubbed out of player-facing standalone/publish bundles. Registered only in
// creator mode; replaced by a no-op stub in the publish vite configs.
import type { GameEngine } from 'engine/GameEngine.js';
import type { GameRuntimeController } from 'engine/GameRuntimeController.js';
import type { GameData } from 'types/game.js';
import type { InGameNotification } from 'engine/InGameNotification.js';
import { GameState, type GameStateManager } from 'engine/GameStateManager.js';
import { safePostMessageToCreator as safePostMessage } from 'engine/CreatorMode.js';
import { setLanguage, type SupportedLanguage } from 'engine/i18n/index.js';
import { getVoxelTextureAtlas } from 'engine/VoxelTextureAtlas.js';
import { getMaterialRegistry } from 'engine/MaterialRegistry.js';
import { getActiveEnvironmentObjectSystem } from 'engine/EnvironmentObjectSystem.js';
import { getActiveLevelManager, getActiveLevelIdOrNull } from 'engine/levels/levelManagerRegistry.js';
import type { CameraSpec } from 'engine/ScreenshotService.js';
import { handleCaptureView } from 'engine/template/ViewCaptureHandler.js';
import { handleSceneFootprint } from 'engine/template/SceneFootprint.js';
import type { SplatExportGlbOverlay } from 'engine/SplatExportGlbOverlay.js';
import { downloadSceneGLB } from 'debug/SceneExporter.js';
import type { GameTemplateContext } from 'engine/template/GameTemplateContext.js';
import { createHighlightBox, clearObjectHighlight } from 'engine/template/ObjectHighlight.js';
import { applyHqGeneratingAssets } from 'engine/template/HqGeneratingHandler.js';
import { handleSetEditorTab } from 'engine/template/EditorTabHandler.js';
import { getCloudSaveStatus, resetPlayerData } from 'engine/persistence/EngineCloudSaves.js';
import {
    handleCreateVoxelAsset, handlePlaceVoxelObject, handleBatchPlaceVoxelObjects,
    handleModifyVoxelObject, handleDeleteVoxelObject, handleGenerateVoxelPreview,
    handleRegisterCustomBlockType, handleVoxelizeGLB, handleVoxelizeGlbAsLevel, handleCreateAssetFromGlbUrl,
} from 'engine/template/VoxelMessageHandlers.js';
import { handleCreateAssetFromVxlMaster, handleRevoxelizeFromVxlMaster } from 'engine/template/VxlMasterAssetHandler.js';
import { handleApplyVxlMaterials, handleReadVxlMaterialSignature } from 'engine/template/VxlMaterialAssetHandler.js';
import {
    handleRegisterGlbAsset
} from 'engine/template/VoxelMessageHandlers.js';
import { handleInspectVoxelModel, handleImportVoxelModel } from 'engine/template/VoxelImportMessageHandlers.js';
import { handleGenerateGlbCollider, handleGenerateGlbPreview } from 'engine/template/GlbAssetMessageHandlers.js';
import {
    handleProcessFBXAnimation, handleTestFBXWithSkin, handleCleanupFBXTest
} from 'engine/template/FBXMessageHandlers.js';
import { handleInspectGlbAnimation } from 'engine/template/GlbAnimationMessageHandlers.js';
import { handleInspectGlbForLevelVoxelize } from 'engine/template/GlbLevelInspectMessageHandlers.js';
import {
    fetchGameDataCategoriesForDialog, fetchGameDataUsage, resetGameDataCategory, deleteGameDataEntry
} from 'engine/template/GameDataMessageHandlers.js';
import { GaussianSplatSelectionTool } from 'debug/GaussianSplatSelectionTool.js';
import { SplatBoundsEditor, type Bounds as SplatBounds, type BoundsEditMode } from 'debug/SplatBoundsEditor.js';

export interface CreatorMessageContext {
    getEngine(): GameEngine | null;
    runtimeController: GameRuntimeController;
    getCurrentGameData(): any;
    setCurrentGameData(data: any): void;
    getCurrentGameId(): string | null;
    /**
     * True while a `loadGame()` is in flight. `getCurrentGameData()` alone
     * cannot tell: it is set at the very START of a load, long before the
     * engine, editor and lock state are usable.
     */
    isGameLoading(): boolean;
    ensureNotification(): InGameNotification;
    loadGame(gameId: string, gameData: GameData, setPlayingState?: boolean): Promise<void>;
    reloadCurrentGame(): Promise<void>;
    disposeGame(): void;
    captureScreenshot(mode?: 'immediate' | 'warmup'): Promise<void>;
    handleGameStart(): Promise<void>;
    showMenu(): void;
}

let ctx: CreatorMessageContext;
let templateContext: GameTemplateContext;
let physicsReady = false;
let pendingMessages: Array<{ type: string; data: any }> = [];

/**
 * Message types that need a LOADED game — queued while none is loaded (a fresh
 * document before LOAD_GAME, an iframe reload) or one is still loading, and
 * flushed once the load and its editor-tab setup are done.
 *
 * GENERATE_VOXEL_PREVIEW is deliberately absent: the thumbnail renderer owns
 * its own offscreen WebGL context and reads nothing from the loaded game, so
 * the Assets tab gets its previews during a long load instead of after it.
 */
const REQUIRES_GAME_LOADED = new Set([
    // The agent's `look` wants the loaded scene, not whatever a half-built one shows.
    'CAPTURE_VIEW',
    // The visual check diffs the loaded scene before and after an edit.
    'SCENE_FOOTPRINT',
    'CREATE_VOXEL_ASSET',
    'CREATE_ASSET_FROM_GLB_URL',
    'CREATE_ASSET_FROM_VXL_MASTER',
    'REGISTER_GLB_ASSET',
    'PLACE_VOXEL_OBJECT',
    'BATCH_PLACE_VOXEL_OBJECTS',
    'MODIFY_VOXEL_OBJECT',
    'DELETE_VOXEL_OBJECT',
    'REGISTER_CUSTOM_BLOCK_TYPE',
    'VOXELIZE_GLB',
    'VOXELIZE_GLB_AS_LEVEL',
    'IMPORT_VOXEL_MODEL',
    'GENERATE_GLB_COLLIDER',
    'EDIT_VOXEL_ASSET',
    'CONVERT_LEGACY_VXL_ASSET',
    'CHECK_VXL_ASSET_FORMAT',
    // Both read a `.vxl` by url and touch nothing in the loaded scene, but the
    // apply path uploads, and `uploadFile` resolves its target from the loaded
    // game. Queuing is free here — neither is on a load-time path.
    'READ_VXL_MATERIAL_SIGNATURE',
    'APPLY_VXL_MATERIALS',
]);

// Active GLB-for-voxel overlay during a Gaussian Splat export. Held at module
// scope so CANCEL (a separate message) can also tear it down.
let activeSplatGlbOverlay: SplatExportGlbOverlay | null = null;

function getRuntimeStateManager(): GameStateManager {
    return ctx.runtimeController.getStateManager();
}

/** The active Gaussian-splat collider editor, or null when no splat renderer exists yet. */
function getColliderEditor(): any | null {
    return ctx.getEngine()?.gaussianSplatRenderer?.getColliderEditor() ?? null;
}

let splatSelectionTool: GaussianSplatSelectionTool | null = null;
function getSplatSelectionTool(): GaussianSplatSelectionTool | null {
    if (splatSelectionTool) return splatSelectionTool;
    const engine = ctx.getEngine();
    if (!engine || !engine.camera || !engine.renderer) return null;
    splatSelectionTool = new GaussianSplatSelectionTool(
        engine.camera,
        engine.renderer.domElement,
        {
            onRectSelection: (count) => safePostMessage({ type: 'SPLAT_SELECTION_RECT', count }),
            onPendingChanged: (count) => safePostMessage({ type: 'SPLAT_SELECTION_PENDING', count }),
            onExited: () => safePostMessage({ type: 'SPLAT_SELECTION_EXITED' }),
        },
    );
    return splatSelectionTool;
}

let splatBoundsEditor: SplatBoundsEditor | null = null;
function getSplatBoundsEditor(): SplatBoundsEditor | null {
    if (splatBoundsEditor) return splatBoundsEditor;
    const engine = ctx.getEngine();
    if (!engine || !engine.scene || !engine.camera || !engine.renderer) return null;
    splatBoundsEditor = new SplatBoundsEditor(
        engine.scene,
        engine.camera,
        engine.renderer.domElement,
        {
            onBoundsChanged: (bounds) => safePostMessage({ type: 'SPLAT_BOUNDS_EDIT_CHANGED', bounds }),
            onDragStart: () => safePostMessage({ type: 'SPLAT_BOUNDS_EDIT_DRAG', dragging: true }),
            onDragEnd: (bounds) => safePostMessage({ type: 'SPLAT_BOUNDS_EDIT_DRAG', dragging: false, bounds }),
            onExited: () => safePostMessage({ type: 'SPLAT_BOUNDS_EDIT_EXITED' }),
        },
    );
    return splatBoundsEditor;
}

async function handleMessage(type: string, data: any): Promise<void> {
    let gameEngine = ctx.getEngine();
    const runtimeController = ctx.runtimeController;
    const currentGameId = ctx.getCurrentGameId();
    const loadGame = ctx.loadGame;
    const reloadCurrentGame = ctx.reloadCurrentGame;
    const disposeGame = ctx.disposeGame;
    const captureScreenshot = ctx.captureScreenshot;
    const handleGameStart = ctx.handleGameStart;
    const showMenu = ctx.showMenu;
    switch (type) {
        case 'LOAD_GAME':
            console.log(`🚀 Received LOAD_GAME message for: ${data.gameId}`);

            // Set AI_AGENT_URL on window for use by game systems (S3 uploads, etc.)
            if (data.agentUrl) {
                (window as unknown as { AI_AGENT_URL: string }).AI_AGENT_URL = data.agentUrl;
                console.log(`🔗 AI_AGENT_URL set to: ${data.agentUrl}`);
            }

            // Which deployed game-server runtime AI falls back to when none is running
            // locally (engine/runtimeBackend.ts). The `bitmagic dev` shell sends it (it
            // knows the project's pinned environment, which the engine cannot read off a
            // localhost URL), and so does the Creator on plain-http local dev (it knows a
            // parallel clone's shifted game-server port, which this page — served without
            // Vite env — does not). Absent everywhere else, and the engine picks for itself.
            if (data.gameServerUrl) {
                (window as unknown as { BITMAGIC_GAME_SERVER_URL: string }).BITMAGIC_GAME_SERVER_URL = data.gameServerUrl;
                console.log(`🔗 BITMAGIC_GAME_SERVER_URL set to: ${data.gameServerUrl}`);
            }

            // Initialize notification system if not already initialized
            ctx.ensureNotification();

            // Check if we should skip menu (e.g., when in editor tabs)
            const skipMenu = data.skipMenu === true;
            const currentTab = data.currentTab || 'prompt';
            runtimeController.setCurrentTab(currentTab);

            // Show menu first (if not already shown and not skipping)
            if (!skipMenu) {
                showMenu();
            }

            // Store multiplayerGameId for version-aware room matching in editor.
            // This ensures the editor creates/joins rooms with the correct version suffix.
            // Stored on window so NetworkManager can access it without threading through templates.
            // Always assign (even undefined) to clear stale values from previous game loads.
            (window as any).__multiplayerGameId = data.multiplayerGameId || undefined;
            // Store networkSendRate so NetworkManager can pick it up on connect.
            (window as any).__networkSendRate = data.gameData?.worldProfileData?.networkSendRate ?? undefined;

            // Load the game world immediately so it's visible behind the Play button
            // Pass skipMenu to loadGame to control menu visibility
            console.log(`🌍 Loading game world: ${data.gameId} (currentTab: ${currentTab})`);
            await loadGame(data.gameId, data.gameData, skipMenu);
            // loadGame (re)creates the engine — re-read the live reference.
            gameEngine = ctx.getEngine();

            // Keep the menu visible on top of the game world (unless skipped)
            if (!skipMenu) {
                console.log(`📦 Game world loaded, Play button visible`);
            } else {
                console.log(`📦 Game world loaded, menu skipped (editor mode, tab: ${currentTab})`);

                // Editor tabs should preview a loaded world without starting gameplay.
                runtimeController.showEditorPreview();
                console.log('🎮 Game state set to READY (editor preview)');

                // Set up camera and controls based on the active tab
                if (gameEngine && gameEngine.editorManager) {
                    const editorManager = gameEngine.editorManager;

                    if (currentTab === 'prompt') {
                        // Prompt tab: player controls + player camera
                        const playerController = gameEngine.getPlayerController();
                        if (playerController && 'setControlsEnabled' in playerController) {
                            (playerController as any).setControlsEnabled(true);
                            console.log(`🎮 Player controls enabled (Prompt tab)`);
                        }
                        editorManager.disableFreeCamera();
                    } else {
                        // All other tabs: free camera + no player controls
                        const playerController = gameEngine.getPlayerController();
                        if (playerController && 'setControlsEnabled' in playerController) {
                            (playerController as any).setControlsEnabled(false);
                            console.log(`🎮 Player controls disabled (${currentTab} tab)`);
                        }
                        editorManager.enableFreeCamera();
                        editorManager.setPaused(true);

                        // Enable specific editor for the tab
                        if (currentTab === 'splats') {
                            editorManager.enableGaussianColliderEditor();
                        }
                    }
                }

                // Show controls in HUD
                const controlsContainer = document.querySelector('.controls-container') as HTMLElement;
                if (controlsContainer) {
                    controlsContainer.style.display = 'block';
                }
            }

            // The creator may have switched tabs WHILE the world loaded. That
            // SET_EDITOR_TAB updated the runtime's current tab but returned
            // early ("deferring until game is loaded" — no player controller
            // yet), and the setup above ran for the tab LOAD_GAME was sent
            // with — so a switch to the Assets tab mid-load left the start menu
            // up, and "Edit voxels…" then opened the voxel editor under the
            // PLAY card. Apply the live tab now that the game can take it.
            {
                const liveTab = getRuntimeStateManager().getCurrentTab();
                if (gameEngine && liveTab !== null && liveTab !== currentTab) {
                    console.log(`[editor] Tab changed during load (${currentTab} -> ${liveTab}) — applying it now`);
                    handleSetEditorTab(gameEngine, runtimeController, getRuntimeStateManager, { tab: liveTab }, safePostMessage);
                }
            }

            // Tool messages queued during the load run only now, after the
            // editor-tab setup: a queued EDIT_VOXEL_ASSET opens a session
            // that disableFreeCamera()/enableFreeCamera() above would end or
            // take the camera from.
            await flushPendingToolMessages();
            break;
        case 'SHOW_NOTIFICATION':
            console.log('📢 Received SHOW_NOTIFICATION message');
            if (data && data.message) {
                const duration = data.durationMs || 3000;
                ctx.ensureNotification().show(data.message, duration);
            }
            break;
        case 'HQ_ASSET_GENERATING':
            // The creator polls the agent's HQ job list and pushes the currently-generating
            // asset ids here (~every 4 s). Generation takes minutes, so without this the
            // world gives no sign anything is happening. We highlight every instance and
            // let the Object Inspector reflect it via the shared state module.
            applyHqGeneratingAssets(
                Array.isArray(data?.assetIds) ? (data.assetIds as string[]) : [],
                ctx.getCurrentGameData(),
            );
            break;
        case 'RELOAD_GAME':
            if (data.gameId && data.gameData) {
                // For development, force a full page reload to ensure all modules are fresh
                window.location.reload();
            } else {
                // Fallback to existing reload logic if no data provided
                await reloadCurrentGame();
            }
            break;
        case 'DISPOSE_GAME':
            disposeGame();
            break;
        case 'LOAD_LEVEL': {
            // Editor level switch: run the same runtime path game code uses
            // (no iframe reload). Replies LEVEL_LOADED so the creator can
            // update its active-level state and re-filter scene views.
            const levelId = String(data?.levelId ?? '');
            const levelManager = getActiveLevelManager();
            if (!levelManager) {
                safePostMessage({ type: 'LEVEL_LOADED', levelId, success: false, error: 'game has no levels[] (legacy single-world mode)' });
                break;
            }
            levelManager.loadLevel(levelId, { networked: data?.networked !== false })
                .then(() => safePostMessage({ type: 'LEVEL_LOADED', levelId, success: true }))
                .catch((err: unknown) => safePostMessage({
                    type: 'LEVEL_LOADED', levelId, success: false,
                    error: err instanceof Error ? err.message : String(err),
                }));
            break;
        }
        case 'GET_ACTIVE_LEVEL':
            // Which level is on screen RIGHT NOW. Asked before every AI prompt so
            // the agent edits the level the creator is looking at. Deliberately
            // reads the LevelManager rather than echoing the last LOAD_LEVEL: game
            // code switches levels too (a portal, an arena rotation), and those
            // switches never pass through the creator. `null` = legacy/single-world.
            safePostMessage({
                type: 'ACTIVE_LEVEL',
                activeLevelId: getActiveLevelIdOrNull(),
                levels: getActiveLevelManager()?.getLevels() ?? [],
            });
            break;
        case 'RESIZE':
            if (gameEngine) {
                gameEngine.onWindowResize();
            }
            break;
        case 'CAPTURE_SCREENSHOT':
            await captureScreenshot(data?.mode === 'warmup' ? 'warmup' : 'immediate');
            break;
        case 'CAPTURE_VIEW':
            // The AI editor's `look` tool — see ViewCaptureHandler.ts.
            await handleCaptureView(gameEngine, data, safePostMessage);
            break;
        case 'SCENE_FOOTPRINT':
            // Where the scene's geometry is — the post-edit visual check diffs two of these.
            handleSceneFootprint(gameEngine, data, safePostMessage);
            break;
        case 'CAPTURE_STEAM_SCREENSHOTS': {
            // Steam-export capture: several distinct angles rendered off-screen
            // at store resolution (default 1920×1080). Each shot self-uploads
            // via ScreenshotService; the response carries the public URLs.
            if (!gameEngine) {
                safePostMessage({ type: 'STEAM_SCREENSHOTS_RESPONSE', data: { urls: [], error: 'Game engine not ready' } });
                break;
            }
            const shotWidth = typeof data?.width === 'number' ? data.width : 1920;
            const shotHeight = typeof data?.height === 'number' ? data.height : 1080;
            const service = gameEngine.getScreenshotService();
            const cameraSpecs: (CameraSpec | null)[] = [
                null, // live player view
                { kind: 'orbit', target: null, distance: 8, azimuth: 0.8, pitch: 0.35 },
                { kind: 'orbit', target: null, distance: 16, azimuth: 2.4, pitch: 0.5 },
                { kind: 'isometric', fitLevel: true, distance: null, azimuth: Math.PI / 4, margin: null },
                { kind: 'topdown', fitLevel: true, height: null, tilt: 0.35, margin: null },
            ];
            const shotUrls: string[] = [];
            let shotError: string | undefined;
            for (let i = 0; i < cameraSpecs.length; i++) {
                try {
                    const { url } = await service.captureAndUpload({
                        camera: cameraSpecs[i],
                        width: shotWidth,
                        height: shotHeight,
                        filename: `steam-screenshot-${i + 1}`,
                    });
                    shotUrls.push(url);
                } catch (err) {
                    console.warn(`[SteamScreenshots] Capture ${i + 1}/${cameraSpecs.length} failed:`, err);
                    shotError = err instanceof Error ? err.message : String(err);
                }
                safePostMessage({ type: 'STEAM_SCREENSHOTS_PROGRESS', data: { done: i + 1, total: cameraSpecs.length } });
            }
            safePostMessage({ type: 'STEAM_SCREENSHOTS_RESPONSE', data: { urls: shotUrls, error: shotUrls.length === 0 ? shotError : undefined } });
            break;
        }
        case 'EXPORT_SCENE_GLB':
            if (gameEngine) {
                downloadSceneGLB(gameEngine).catch(err => {
                    console.error('[SceneExporter] GLB export failed:', err);
                });
            }
            break;
        case 'EXPORT_GAUSSIAN_SPLAT':
            if (gameEngine?.scene && gameEngine.camera && gameEngine.renderer) {
                const splatExporter = gameEngine.getGaussianSplatExporter();
                const splatGameData = gameEngine.getGameData();
                const splatWorldProfile = splatGameData?.worldProfileData;
                const splatGenreModule = gameEngine.genreModule;

                // Render original textured GLBs in place of voxelised environment
                // objects for the capture (far better Gaussian-splat source than
                // hard-edged voxels). Lazily imported so GLTFLoader stays out of
                // non-export bundles. Restored on complete/error/cancel.
                activeSplatGlbOverlay?.restore();
                activeSplatGlbOverlay = null;
                try {
                    const { buildSplatExportGlbOverlay } = await import('engine/SplatExportGlbOverlay.js');
                    activeSplatGlbOverlay = await buildSplatExportGlbOverlay(
                        gameEngine.scene, splatGameData, getActiveEnvironmentObjectSystem());
                    if (activeSplatGlbOverlay.instanceCount > 0) {
                        console.log(`[SplatExport] Substituted ${activeSplatGlbOverlay.instanceCount} textured GLBs across ${activeSplatGlbOverlay.typeCount} types in place of voxels.`);
                    }
                } catch (err) {
                    console.warn('[SplatExport] GLB overlay unavailable — capturing voxels as-is:', err);
                    activeSplatGlbOverlay = null;
                }
                const restoreSplatOverlay = (): void => {
                    activeSplatGlbOverlay?.restore();
                    activeSplatGlbOverlay = null;
                };

                splatExporter.startExport(gameEngine.scene, gameEngine.getDefaultCamera(), gameEngine.renderer, {
                    numViews: data?.numViews ?? 400,
                    width: data?.width ?? 1024,
                    height: data?.height ?? 768,
                    worldSizeX: splatWorldProfile?.groundWorldSizeX,
                    worldSizeZ: splatWorldProfile?.groundWorldSizeZ,
                    characterHeight: splatWorldProfile?.characterHeight,
                    isPointInPlayableArea: splatGenreModule?.isPointInPlayableArea?.bind(splatGenreModule),
                    externalViewpoints: data?.externalViewpoints,
                    onFrame: (frameIndex: number, fileName: string, pngBase64: string) => {
                        safePostMessage({ type: 'GAUSSIAN_SPLAT_EXPORT_FRAME', data: { frameIndex, fileName, pngBase64 } });
                    },
                    onProgress: (current: number, total: number) => {
                        safePostMessage({ type: 'GAUSSIAN_SPLAT_EXPORT_PROGRESS', data: { current, total } });
                    },
                    onComplete: (transformsJson: string) => {
                        restoreSplatOverlay();
                        safePostMessage({ type: 'GAUSSIAN_SPLAT_EXPORT_COMPLETE', data: { transformsJson } });
                    },
                    onError: (error: Error) => {
                        restoreSplatOverlay();
                        safePostMessage({ type: 'GAUSSIAN_SPLAT_EXPORT_COMPLETE', data: { error: error.message } });
                    },
                });
            }
            break;
        case 'CANCEL_GAUSSIAN_SPLAT_EXPORT':
            if (gameEngine) {
                gameEngine.getGaussianSplatExporter().cancel();
            }
            activeSplatGlbOverlay?.restore();
            activeSplatGlbOverlay = null;
            break;
        case 'GENERATE_INIT_PLY':
            if (gameEngine?.scene) {
                try {
                    const { generateInitializationPLY } = await import('engine/GaussianSplatExporter.js');
                    const targetCount = data?.targetPointCount ?? 5_000_000;
                    const plyGameData = gameEngine.getGameData();
                    const worldX = data?.worldSizeX ?? plyGameData?.worldProfileData?.groundWorldSizeX ?? 128;
                    const worldZ = data?.worldSizeZ ?? plyGameData?.worldProfileData?.groundWorldSizeZ ?? 128;
                    const plyValidator = gameEngine.genreModule?.isPointInPlayableArea?.bind(gameEngine.genreModule);
                    safePostMessage({ type: 'INIT_PLY_PROGRESS', data: { status: 'Generating point cloud...' } });
                    const plyBuffer = generateInitializationPLY(gameEngine.scene, targetCount, 3, worldX, worldZ, plyValidator);
                    const msg = { type: 'INIT_PLY_COMPLETE', data: { buffer: plyBuffer, pointCount: targetCount } };
                    if (window.parent !== window) {
                        window.parent.postMessage(msg, '*', [plyBuffer]);
                    }
                } catch (err) {
                    safePostMessage({ type: 'INIT_PLY_COMPLETE', data: { error: String(err) } });
                }
            }
            break;
        case 'LOAD_VOXEL_OVERLAY_SPLAT':
            if (gameEngine && data?.splatConfig) {
                try {
                    const splatCfg = data.splatConfig;
                    await gameEngine.loadGaussianSplat(splatCfg.url, splatCfg);
                    console.log(`[game-template] Voxel overlay splat loaded: ${splatCfg.url}`);
                    safePostMessage({ type: 'VOXEL_OVERLAY_SPLAT_LOADED' });
                } catch (err) {
                    console.error('[game-template] Failed to load voxel overlay splat:', err);
                    safePostMessage({ type: 'VOXEL_OVERLAY_SPLAT_LOADED', data: { error: String(err) } });
                }
            }
            break;
        case 'SET_EDITOR_MODE':
            // Enable or disable scene editor mode (debug camera, click-to-select, transform gizmo,
            // unpacked InstancedMeshes). Not to be confused with DebugManager's true-debug toggles
            // (wireframes, debug info panel) — those are separate.
            if (gameEngine && gameEngine.editorManager) {
                if (data && data.enabled) {
                    gameEngine.editorManager.enableEditorMode();
                } else {
                    gameEngine.editorManager.disableEditorMode();
                }
            }
            break;
        case 'SET_RENDER_ACTIVE':
            // Pause/resume the render+update loop based on whether the game is
            // actually visible to the user (driven by the creator's render gate:
            // portal mode, an open modal, or the Prompts-tab blurred backdrop).
            if (gameEngine && data && typeof data.renderActive === 'boolean') {
                gameEngine.setRenderActive(data.renderActive);
            }
            break;
        case 'UPDATE_LOD_CONFIG_FOR_ASSET': {
            // Live-apply LOD distance changes from the Assets re-voxelize
            // dialog when the user clicked "Save" (settings-only path).
            // Skips the voxelizer entirely — just patches the running
            // EnvironmentObjectSystem's lodStorage so the next frame uses
            // the new distance thresholds.
            const envObjSystem = getActiveEnvironmentObjectSystem();
            if (envObjSystem && data?.assetId && data.voxelizeSettings) {
                envObjSystem.updateLodConfigForAsset(data.assetId, data.voxelizeSettings);
            }
            break;
        }
        case 'EDIT_VOXEL_ASSET':
            // Open the 3D voxel editor for an asset straight from the Assets
            // tab — no placed instance needed, and deliberately WITHOUT
            // enabling editor mode: the session already pauses gameplay, hides
            // the world, and takes the camera, so turning the scene editor on
            // would only add a hierarchy panel and debug camera to undo again.
            // The creator opened its modal on send and only closes it on
            // VOXEL_OBJECT_EDIT_ENDED — a silent drop or an uncaught throw
            // here (no engine after a failed load, malformed request, a
            // session that fails to start) would leave that modal blocking
            // the whole creator with no way out. Every path must answer.
            if (gameEngine && gameEngine.editorManager && data?.assetId) {
                try {
                    await gameEngine.editorManager.startAssetVoxelSession(data.assetId);
                } catch (error) {
                    console.error('[EDIT_VOXEL_ASSET] Failed to start voxel session:', error);
                    safePostMessage({
                        type: 'VOXEL_OBJECT_EDIT_ENDED',
                        hasChanges: false,
                        canceled: true,
                        error: error instanceof Error ? error.message : 'Could not open the voxel editor',
                    });
                }
            } else {
                safePostMessage({
                    type: 'VOXEL_OBJECT_EDIT_ENDED',
                    hasChanges: false,
                    canceled: true,
                    error: gameEngine ? 'Invalid voxel edit request' : 'Game is not loaded',
                });
            }
            break;
        case 'CHECK_VXL_ASSET_FORMAT':
            if (gameEngine && gameEngine.editorManager && data?.assetId) {
                await gameEngine.editorManager.reportVxlAssetFormat(data.assetId);
            }
            break;
        case 'CONVERT_LEGACY_VXL_ASSET':
            // Re-save a legacy JSON `.vxl` as VXL3. The runtime loader refuses the old
            // form, so this is the only way an already-published asset gets back in.
            if (gameEngine && gameEngine.editorManager && data?.assetId) {
                await gameEngine.editorManager.convertLegacyVxlAsset(data.assetId);
            }
            break;
        case 'SET_GAUSSIAN_COLLIDER_EDITOR':
            // Enable or disable Gaussian splat collider editor. The floating
            // in-canvas UI is gone — the Splats side panel owns the controls.
            if (gameEngine && gameEngine.editorManager) {
                if (data && data.enabled) {
                    gameEngine.editorManager.enableGaussianColliderEditor();
                } else {
                    gameEngine.editorManager.disableGaussianColliderEditor();
                }
            }
            break;
        case 'SET_SPLAT_VISIBILITY': {
            const idx = typeof data?.splatIndex === 'number' ? data.splatIndex : -1;
            const editor = getColliderEditor();
            if (editor && typeof (editor as any).setSplatVisibilityByIndex === 'function') {
                (editor as any).setSplatVisibilityByIndex(idx, data?.gaussians, data?.voxels);
            }
            break;
        }
        case 'UPDATE_SPLAT_TRANSFORM': {
            // Live transform edit from the Splats side panel. Mutates the
            // renderer at `splatIndex` and marks transforms dirty so the
            // existing Save Splat Settings flow knows there's unsaved work.
            const idx = typeof data?.splatIndex === 'number' ? data.splatIndex : -1;
            const renderer = gameEngine?.gaussianSplatRenderers?.[idx] ?? null;
            if (!renderer) break;
            const position = renderer.getPosition().clone();
            const rotation = renderer.getRotation().clone();
            const scale = renderer.getScale().clone();
            const pos = data?.position as { x?: number; y?: number; z?: number } | undefined;
            const rot = data?.rotation as { x?: number; y?: number; z?: number } | undefined; // radians
            const scl = data?.scale as { x?: number; y?: number; z?: number } | undefined;
            if (pos) position.set(pos.x ?? position.x, pos.y ?? position.y, pos.z ?? position.z);
            if (rot) rotation.set(rot.x ?? rotation.x, rot.y ?? rotation.y, rot.z ?? rotation.z, rotation.order);
            if (scl) scale.set(scl.x ?? scale.x, scl.y ?? scale.y, scl.z ?? scale.z);
            renderer.updateSplatTransform(position, rotation, scale);
            const editor: any = getColliderEditor();
            if (editor && typeof editor.markTransformsDirty === 'function') {
                editor.markTransformsDirty();
            }
            break;
        }
        case 'SAVE_ALL_COLLIDERS': {
            // Persist manual box colliders / heightmap to disk. Mirrors the
            // floating "Save Colliders" button that lived in the old UI.
            const editor: any = getColliderEditor();
            if (editor && typeof editor.saveColliders === 'function') {
                editor.saveColliders().catch((err: unknown) => {
                    console.error('[SAVE_ALL_COLLIDERS] failed:', err);
                });
            }
            break;
        }
        case 'GENERATE_WALKABLE_MAP': {
            // Bridge to the editor's walkable-map builder: walks the active
            // splat's VoxelWorld for surface voxels and renders one green
            // quad per cell so the user can validate coverage. Also
            // persists the result to S3 in the background.
            //
            // `maxYAboveSpawn` (when supplied) clamps reachable cells to
            // a flat slab around the spawn — useful when the voxel
            // collider permits unintended rooftop traversal that bloats
            // the PVS.
            const pvs = gameEngine?.pvsController;
            if (pvs) {
                try {
                    const opts: { maxYAboveSpawn?: number } = {};
                    if (typeof data.maxYAboveSpawn === 'number' && Number.isFinite(data.maxYAboveSpawn)) {
                        opts.maxYAboveSpawn = data.maxYAboveSpawn;
                    }
                    const result = pvs.generateWalkableMap(opts);
                    safePostMessage({ type: 'WALKABLE_MAP_GENERATED', success: true, cellCount: result?.cellCount ?? 0 });
                    // Mirror of the auto-load notification so the creator
                    // panel knows a mesh now exists, regardless of whether
                    // it was built fresh or restored from S3.
                    safePostMessage({ type: 'WALKABLE_MAP_LOADED', cellCount: result?.cellCount ?? 0 });
                } catch (err) {
                    console.error('[GENERATE_WALKABLE_MAP] failed:', err);
                    safePostMessage({ type: 'WALKABLE_MAP_GENERATED', success: false, error: err instanceof Error ? err.message : String(err) });
                }
            }
            break;
        }
        case 'CLEAR_WALKABLE_MAP': {
            gameEngine?.pvsController?.clearWalkableMap();
            break;
        }
        case 'SET_WALKABLE_MAP_VISIBILITY': {
            gameEngine?.pvsController?.setWalkableMapVisible(!!data?.visible);
            break;
        }
        case 'SET_PVS_CULLING_ENABLED': {
            gameEngine?.pvsController?.setPvsCullingEnabled(!!data?.enabled);
            break;
        }
        case 'SET_PVS_LOCKED': {
            // Debug freeze of the PVS state. When locked the per-tick
            // visibility update halts so the user can fly the camera
            // around and inspect what was kept from the locked vantage.
            gameEngine?.pvsController?.setPvsLocked(!!data?.locked);
            break;
        }
        case 'DELETE_PVS': {
            // Clear the persisted pvsUrl / pvsFileSize (env-object for a placed
            // splat, or worldProfileData for a scene-wide voxel level) and drop
            // the in-memory PVS so the culler stops immediately. The S3 blob is
            // intentionally left intact — recompute overwrites its URL anyway;
            // "delete" here means "untether from the PVS data".
            const pvs = gameEngine?.pvsController;
            if (pvs) {
                pvs.clearActivePvs().then((success: boolean) => {
                    safePostMessage({ type: 'PVS_DELETED', success });
                }).catch((err: unknown) => {
                    safePostMessage({ type: 'PVS_DELETED', success: false, error: err instanceof Error ? err.message : String(err) });
                });
            } else {
                safePostMessage({ type: 'PVS_DELETED', success: false, error: 'No PVS controller' });
            }
            break;
        }
        case 'SET_SPLAT_RENDER_MODE': {
            // 'gaussian' → load the full splat in the background and hide
            // the preview points when ready; 'points' → unload the full
            // splat (if loaded) and rely on the preview only.
            const renderer: any = gameEngine?.gaussianSplatRenderer;
            const mode = data?.mode === 'gaussian' ? 'gaussian' : 'points';
            if (renderer && typeof renderer.setSplatRenderMode === 'function') {
                renderer.setSplatRenderMode(mode);
            }
            break;
        }
        case 'COMPUTE_WALKABLE_VISIBILITY': {
            // PVS bake from each walkable cell. Heavy operation — runs async.
            // Caller can pass eye-height / sample-count overrides; missing
            // fields fall back to the bake's defaults.
            const pvs = gameEngine?.pvsController;
            if (pvs && gameEngine?.renderer) {
                pvs.computeWalkableVisibility({
                    renderer: gameEngine.renderer,
                    minEyeHeight: data?.minEyeHeight,
                    maxEyeHeight: data?.maxEyeHeight,
                    eyeSamples: data?.eyeSamples,
                    tileSize: data?.tileSize,
                    faceResolution: data?.faceResolution,
                }).then((stats) => {
                    safePostMessage({ type: 'WALKABLE_VISIBILITY_COMPUTED', success: !!stats, stats });
                }).catch((err: unknown) => {
                    console.error('[COMPUTE_WALKABLE_VISIBILITY] failed:', err);
                    safePostMessage({ type: 'WALKABLE_VISIBILITY_COMPUTED', success: false, error: err instanceof Error ? err.message : String(err) });
                });
            }
            break;
        }
        case 'VOXELIZE_ACTIVE_SPLAT': {
            // Bridge into the editor's existing voxelize flow. Voxel size,
            // opacity threshold, and voxelize mode come from the side panel;
            // if omitted, the editor's current settings are used.
            const editor: any = getColliderEditor();
            if (editor) {
                if (typeof data?.voxelSize === 'number' && typeof editor.setCurrentVoxelSize === 'function') {
                    editor.setCurrentVoxelSize(data.voxelSize);
                }
                if (typeof data?.opacityThreshold === 'number' && typeof editor.setCurrentOpacityThreshold === 'function') {
                    editor.setCurrentOpacityThreshold(data.opacityThreshold);
                }
                if ((data?.voxelizeMode === 'center' || data?.voxelizeMode === 'coverage') && typeof editor.setCurrentVoxelizeMode === 'function') {
                    editor.setCurrentVoxelizeMode(data.voxelizeMode);
                }
                if (typeof editor.generateVoxelColliders === 'function') {
                    editor.generateVoxelColliders().catch((err: unknown) => {
                        console.error('[VOXELIZE_ACTIVE_SPLAT] failed:', err);
                    });
                }
            }
            break;
        }
        case 'SET_FREE_CAMERA':
            // Enable or disable free camera controls without debug UI (for Splats tab)
            if (gameEngine && gameEngine.editorManager) {
                if (data && data.enabled) {
                    gameEngine.editorManager.enableFreeCamera();
                } else {
                    gameEngine.editorManager.disableFreeCamera();
                }
            }
            break;
        case 'SET_ACTIVE_SPLAT':
            // Set active splat for editing
            if (gameEngine && data && data.splatIndex !== undefined) {
                const splatIndex = data.splatIndex;
                if (splatIndex >= 0 && splatIndex < gameEngine.gaussianSplatRenderers.length) {
                    gameEngine.activeSplatIndex = splatIndex;
                    const activeRenderer = gameEngine.gaussianSplatRenderers[splatIndex];
                    const colliderEditor = gameEngine.gaussianSplatRenderer?.getColliderEditor();

                    if (colliderEditor && activeRenderer) {
                        // Update editor's splat transform to point to active renderer
                        colliderEditor.setSplatTransform(
                            activeRenderer.getPosition(),
                            activeRenderer.getRotation(),
                            activeRenderer.getScale()
                        );
                        colliderEditor.setSplatUrl(activeRenderer.getSplatUrl());
                        if (typeof activeRenderer.getEnvObjectId === 'function') {
                            colliderEditor.setActiveEnvObjectId(activeRenderer.getEnvObjectId() ?? null);
                        }

                        console.log(`[GameTemplate] Active splat set to index: ${splatIndex}`);
                    }
                }
            }
            break;
        case 'SPLAT_SELECTION_START': {
            const tool = getSplatSelectionTool();
            if (!tool || !gameEngine) {
                safePostMessage({ type: 'SPLAT_SELECTION_ERROR', message: 'Game engine not ready' });
                break;
            }
            const requestedIndex = typeof data?.splatIndex === 'number' ? data.splatIndex : gameEngine.activeSplatIndex;
            const renderer = gameEngine.gaussianSplatRenderers[requestedIndex];
            if (!renderer) {
                safePostMessage({ type: 'SPLAT_SELECTION_ERROR', message: `No splat at index ${requestedIndex}` });
                break;
            }
            tool.enable(renderer);
            break;
        }
        case 'SPLAT_SELECTION_COMMIT_DELETE': {
            splatSelectionTool?.commitDelete();
            break;
        }
        case 'SPLAT_SELECTION_REQUEST_PENDING': {
            const tool = splatSelectionTool;
            const renderer = tool?.getRenderer();
            if (!tool || !renderer) {
                safePostMessage({ type: 'SPLAT_SELECTION_PENDING_DATA', indices: [], url: null });
                break;
            }
            safePostMessage({
                type: 'SPLAT_SELECTION_PENDING_DATA',
                indices: tool.getPendingIndices(),
                url: renderer.getSplatUrl(),
                envObjectId: renderer.getEnvObjectId(),
            });
            break;
        }
        case 'SPLAT_SELECTION_FINISH': {
            // Asset URL has been patched on the server; the env-system will
            // reload the splat from the new URL on the next UPDATE_GAME_DATA.
            // Skip restoring opacities — old splat is about to be replaced.
            splatSelectionTool?.disable(false);
            break;
        }
        case 'SPLAT_SELECTION_CANCEL': {
            splatSelectionTool?.disable(true);
            break;
        }
        case 'COMPUTE_OUT_OF_BOUNDS_INDICES': {
            // Walk every gaussian and return the indices of those whose 3-σ
            // ellipsoid AABB is *completely* outside the supplied (SPZ-local)
            // box. Used by the side-panel "Clean up gaussians" cleanup. Center-
            // -outside-but-overlap-inside gaussians are preserved — large
            // splats near the bounds shouldn't get clipped.
            const idx = typeof data?.splatIndex === 'number' ? data.splatIndex : -1;
            const requestId = (data?.requestId ?? null) as string | null;
            const bounds = data?.bounds as { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } | undefined;
            const sigma = (typeof data?.sigma === 'number' && data.sigma > 0) ? data.sigma : 3;
            const renderer = gameEngine?.gaussianSplatRenderers?.[idx] ?? null;
            const splatMesh = renderer && typeof (renderer as { getSplatMesh?: () => unknown }).getSplatMesh === 'function'
                ? (renderer as { getSplatMesh: () => unknown }).getSplatMesh()
                : null;
            const mesh = splatMesh as { forEachSplat?: (cb: (i: number, c: { x: number; y: number; z: number }, s: { x: number; y: number; z: number }, q: { x: number; y: number; z: number; w: number }, opacity: number, color: unknown) => void) => void } | null;
            if (!bounds || !mesh || typeof mesh.forEachSplat !== 'function') {
                safePostMessage({ type: 'OUT_OF_BOUNDS_INDICES_RESULT', requestId, splatIndex: idx, success: false, error: 'No splat mesh / bounds at that index' });
                break;
            }
            try {
                const indices: number[] = [];
                let total = 0;
                mesh.forEachSplat((i, c, s, q, opacity) => {
                    total++;
                    if (opacity <= 0) return; // already-deleted splats stay deleted

                    // Rotation matrix from quaternion (column-major equivalent;
                    // we only need its rows for half-extent calc below).
                    const x = q.x, y = q.y, z = q.z, w = q.w;
                    const xx = x * x, yy = y * y, zz = z * z;
                    const xy = x * y, xz = x * z, yz = y * z;
                    const wx = w * x, wy = w * y, wz = w * z;
                    // R rows: [r00 r01 r02; r10 r11 r12; r20 r21 r22]
                    const r00 = 1 - 2 * (yy + zz);
                    const r01 = 2 * (xy - wz);
                    const r02 = 2 * (xz + wy);
                    const r10 = 2 * (xy + wz);
                    const r11 = 1 - 2 * (xx + zz);
                    const r12 = 2 * (yz - wx);
                    const r20 = 2 * (xz - wy);
                    const r21 = 2 * (yz + wx);
                    const r22 = 1 - 2 * (xx + yy);

                    const sx2 = s.x * s.x, sy2 = s.y * s.y, sz2 = s.z * s.z;
                    // Diagonal of Σ = R · diag(s²) · Rᵀ — gives axis-aligned variance.
                    const varX = r00 * r00 * sx2 + r01 * r01 * sy2 + r02 * r02 * sz2;
                    const varY = r10 * r10 * sx2 + r11 * r11 * sy2 + r12 * r12 * sz2;
                    const varZ = r20 * r20 * sx2 + r21 * r21 * sy2 + r22 * r22 * sz2;
                    const hx = sigma * Math.sqrt(varX);
                    const hy = sigma * Math.sqrt(varY);
                    const hz = sigma * Math.sqrt(varZ);

                    const aabbMinX = c.x - hx, aabbMaxX = c.x + hx;
                    const aabbMinY = c.y - hy, aabbMaxY = c.y + hy;
                    const aabbMinZ = c.z - hz, aabbMaxZ = c.z + hz;

                    const completelyOutside =
                        aabbMaxX < bounds.minX || aabbMinX > bounds.maxX ||
                        aabbMaxY < bounds.minY || aabbMinY > bounds.maxY ||
                        aabbMaxZ < bounds.minZ || aabbMinZ > bounds.maxZ;

                    if (completelyOutside) indices.push(i);
                });
                console.log(`[COMPUTE_OUT_OF_BOUNDS_INDICES] ${indices.length}/${total} gaussians are fully outside cropBounds (sigma=${sigma})`);
                safePostMessage({ type: 'OUT_OF_BOUNDS_INDICES_RESULT', requestId, splatIndex: idx, success: true, indices, total });
            } catch (err) {
                safePostMessage({ type: 'OUT_OF_BOUNDS_INDICES_RESULT', requestId, splatIndex: idx, success: false, error: err instanceof Error ? err.message : String(err) });
            }
            break;
        }
        case 'CALCULATE_DENSE_SPLAT_BOUNDS': {
            // Compute the splat's "dense area" bbox in untransformed/SPZ-local
            // coords — the value Asset.cropBounds wants. The renderer owns the
            // calc (uses spark's forEachSplat); the editor doesn't get
            // involved. Result is shipped back to the creator which persists
            // it on the asset record.
            const idx = typeof data?.splatIndex === 'number' ? data.splatIndex : -1;
            const requestId = (data?.requestId ?? null) as string | null;
            const renderer = gameEngine?.gaussianSplatRenderers?.[idx] ?? null;
            if (!renderer || typeof (renderer as any).getDenseBounds !== 'function') {
                safePostMessage({ type: 'DENSE_SPLAT_BOUNDS_RESULT', requestId, splatIndex: idx, success: false, error: 'No splat renderer / getDenseBounds at that index' });
                break;
            }
            try {
                const bounds = (renderer as any).getDenseBounds();
                if (!bounds) {
                    safePostMessage({ type: 'DENSE_SPLAT_BOUNDS_RESULT', requestId, splatIndex: idx, success: false, error: 'Splat not yet decoded — wait for it to load and try again' });
                    break;
                }
                console.log(`[CALCULATE_DENSE_SPLAT_BOUNDS] splat ${idx} dense bounds:`, bounds);
                safePostMessage({ type: 'DENSE_SPLAT_BOUNDS_RESULT', requestId, splatIndex: idx, success: true, bounds });
            } catch (err) {
                safePostMessage({ type: 'DENSE_SPLAT_BOUNDS_RESULT', requestId, splatIndex: idx, success: false, error: err instanceof Error ? err.message : String(err) });
            }
            break;
        }
        case 'SPLAT_BOUNDS_EDIT_START': {
            const idx = typeof data?.splatIndex === 'number' ? data.splatIndex : -1;
            const requestId = (data?.requestId ?? null) as string | null;
            const initial = (data?.bounds ?? null) as SplatBounds | null;
            const renderer = gameEngine?.gaussianSplatRenderers?.[idx] ?? null;
            const tool = getSplatBoundsEditor();
            if (!renderer || !tool) {
                safePostMessage({ type: 'SPLAT_BOUNDS_EDIT_STARTED', requestId, success: false, error: 'No splat renderer / bounds editor available' });
                break;
            }
            let bounds = initial;
            if (!bounds && typeof (renderer as any).getDenseBounds === 'function') {
                bounds = (renderer as any).getDenseBounds();
            }
            if (!bounds) {
                safePostMessage({ type: 'SPLAT_BOUNDS_EDIT_STARTED', requestId, success: false, error: 'No initial bounds (splat may not be decoded yet)' });
                break;
            }
            const ok = tool.enable(renderer, bounds);
            if (!ok) {
                safePostMessage({ type: 'SPLAT_BOUNDS_EDIT_STARTED', requestId, success: false, error: 'Failed to attach bounds editor (no splat mesh)' });
                break;
            }
            safePostMessage({ type: 'SPLAT_BOUNDS_EDIT_STARTED', requestId, success: true, bounds });
            break;
        }
        case 'SPLAT_BOUNDS_EDIT_SET_MODE': {
            const mode = (data?.mode ?? 'translate') as BoundsEditMode;
            splatBoundsEditor?.setMode(mode);
            break;
        }
        case 'SPLAT_BOUNDS_EDIT_SET_BOUNDS': {
            const bounds = data?.bounds as SplatBounds | undefined;
            if (bounds) splatBoundsEditor?.setBounds(bounds);
            break;
        }
        case 'SPLAT_BOUNDS_EDIT_GET_BOUNDS': {
            const requestId = (data?.requestId ?? null) as string | null;
            const bounds = splatBoundsEditor?.getBounds() ?? null;
            safePostMessage({ type: 'SPLAT_BOUNDS_EDIT_BOUNDS_RESPONSE', requestId, bounds });
            break;
        }
        case 'SPLAT_BOUNDS_EDIT_EXIT': {
            splatBoundsEditor?.disable();
            break;
        }
        case 'SET_HEIGHTMAP_EDITOR':
            // Enable or disable heightmap editor
            if (gameEngine && gameEngine.editorManager) {
                if (data && data.enabled) {
                    gameEngine.editorManager.enableHeightmapEditor();
                } else {
                    gameEngine.editorManager.disableHeightmapEditor();
                }
            }
            break;
        case 'SET_MENU_VISIBLE':
            // Show or hide the Play button menu
            // Only show menu if game is in MENU state (not PLAYING)
            if (data && data.visible !== undefined) {
                const menuUI = runtimeController.getStartScreen();
                const gameStateManager = getRuntimeStateManager();
                if (menuUI) {
                    const currentState = gameStateManager.getCurrentState();
                    if (data.visible && (currentState === GameState.MENU || gameStateManager.isWaitingForPlayerStart())) {
                        // Only show menu if we're in MENU state (game hasn't started)
                        menuUI.show();
                    } else {
                        // Hide menu if requested OR if game is already playing
                        menuUI.hide();
                    }
                }
            }
            break;
        case 'TOGGLE_PAUSE':
            if (gameEngine && gameEngine.editorManager) {
                const isPaused = getRuntimeStateManager().getCurrentState() === GameState.PAUSED;
                if (isPaused) {
                    runtimeController.resumeFromParentFrame();
                } else {
                    runtimeController.setGameplayPaused(true, 'manual');
                }
            }
            break;
        case 'START_GAME':
            if (gameEngine) {
                await handleGameStart();
            }
            break;
        case 'SET_PAUSE':
            // Set pause state explicitly
            console.log(`[game-template] Received SET_PAUSE message: paused=${data?.paused}`);
            if (gameEngine && gameEngine.editorManager && data && typeof data.paused === 'boolean') {
                console.log(`[game-template] Calling setPaused(${data.paused})`);
                runtimeController.setGameplayPaused(data.paused, 'editor-tab');
            } else {
                console.warn(`[game-template] SET_PAUSE message invalid or gameEngine/editorManager not ready:`, {
                    hasGameEngine: !!gameEngine,
                    hasEditorManager: !!(gameEngine && gameEngine.editorManager),
                    dataType: typeof data?.paused,
                    dataValue: data?.paused
                });
            }
            break;
        case 'CHECK_DEBUG_MANAGER_READY':
            // Respond with readiness status
            if (gameEngine && gameEngine.editorManager) {
                safePostMessage({ type: 'DEBUG_MANAGER_READY' });
            }
            break;
        case 'SET_EDITOR_TAB':
            if (gameEngine) {
                handleSetEditorTab(gameEngine, runtimeController, getRuntimeStateManager, data, safePostMessage);
            } else {
                // No engine yet (iframe just booted, or a load is waiting on
                // the level chooser). Still RECORD the tab: the LOAD_GAME
                // handler replays the live tab once the world is up, and it
                // can only do that if the switch was written down here.
                runtimeController.setCurrentTab(data?.tab || null);
                console.warn('[editor] gameEngine not available - editor tab recorded, applied after load');
            }
            // The cropBounds wireframe + gizmo only belongs in the Splats tab.
            // Force-disable on any other tab to prevent it from leaking into
            // gameplay or other editor surfaces.
            if (data?.tab !== 'splats' && splatBoundsEditor) {
                splatBoundsEditor.disable();
            }
            break;
        case 'SET_MOBILE_PREVIEW': {
            // Creator sends this to force-enable/disable mobile controls for preview.
            // Disables pointer lock so mouse can simulate touch interactions.
            if (gameEngine) {
                const enabled = !!data?.enabled;
                try {
                    // 1. Toggle pointer lock — freeMouseMode exits lock and hides overlay
                    const plm = gameEngine.getPointerLockManager?.();
                    if (plm) {
                        plm.setFreeMouseMode(enabled);
                    }

                    // 2. Tell camera to use click-and-drag instead of pointer lock
                    const playerController = gameEngine.getPlayerController();
                    const cam = playerController
                        ? (playerController as unknown as { getCameraController?: () => unknown }).getCameraController?.()
                        : null;
                    if (cam && typeof (cam as Record<string, unknown>).setMobilePreviewMode === 'function') {
                        (cam as { setMobilePreviewMode: (e: boolean) => void }).setMobilePreviewMode(enabled);
                    }

                    // 3. Force-enable/disable touch controls
                    if (playerController?.setMobilePreviewMode) {
                        playerController.setMobilePreviewMode(enabled, enabled ? data.controls as Record<string, unknown> | undefined : undefined);
                    }

                    console.log(`[game-template] Mobile preview ${enabled ? 'enabled' : 'disabled'}`);
                } catch (e) {
                    console.warn('[game-template] Failed to set mobile preview mode:', e);
                }
            }
            break;
        }
        // SET_EDIT_MODE removed - menu is always visible, users can click Play button to start
        case 'HEIGHTMAP_EDITOR_SETTINGS':
            // Update heightmap editor settings
            if (gameEngine && gameEngine.editorManager && gameEngine.editorManager.heightmapEditor) {
                gameEngine.editorManager.heightmapEditor.setSettings(data);
            }
            break;
        case 'HEIGHTMAP_EDITOR_CANCEL':
            // Cancel heightmap editing
            if (gameEngine && gameEngine.editorManager && gameEngine.editorManager.heightmapEditor) {
                gameEngine.editorManager.heightmapEditor.cancelEditing();
            }
            break;
        case 'HEIGHTMAP_EDITOR_SAVE':
            // Save and apply heightmap changes
            if (gameEngine && gameEngine.editorManager && gameEngine.editorManager.heightmapEditor) {
                gameEngine.editorManager.heightmapEditor.saveAndApplyHeightmap();
            }
            break;
        case 'MARK_HEIGHTMAP_CLEAN':
            // Mark heightmap as clean (saved)
            if (gameEngine && gameEngine.genreModule) {
                const worldGenerator = (gameEngine.genreModule as any).worldGenerator;
                if (worldGenerator && worldGenerator.heightmapSystem) {
                    if (typeof worldGenerator.heightmapSystem.markClean === 'function') {
                        worldGenerator.heightmapSystem.markClean();
                        console.log('✅ Heightmap marked as clean');
                    }
                }
            }
            break;
        case 'GET_HEIGHTMAP_DIRTY_STATUS': {
            // Return heightmap dirty status and data if dirty
            const heightmapSystem = (gameEngine?.genreModule as any)?.worldGenerator?.heightmapSystem;
            if (heightmapSystem) {
                const isDirty = heightmapSystem.getDirty ? heightmapSystem.getDirty() : false;
                const heightmapData = heightmapSystem.getHeightmapData ? heightmapSystem.getHeightmapData() : null;
                safePostMessage({
                    type: 'HEIGHTMAP_DIRTY_STATUS',
                    dirty: isDirty,
                    heightmapData: isDirty && heightmapData ? {
                        width: heightmapData.width,
                        height: heightmapData.height,
                        heights: Array.from(heightmapData.heights),
                        minX: heightmapData.minX,
                        maxX: heightmapData.maxX,
                        minZ: heightmapData.minZ,
                        maxZ: heightmapData.maxZ,
                        minY: heightmapData.minY,
                        maxY: heightmapData.maxY
                    } : null
                });
            } else {
                safePostMessage({ type: 'HEIGHTMAP_DIRTY_STATUS', dirty: false });
            }
            break;
        }
        case 'CHECK_SCENE_CHANGES':
            // Check if scene has unsaved changes and get list of modified object IDs
            if (gameEngine?.editorManager) {
                const { editorManager } = gameEngine;
                safePostMessage({
                    type: 'SCENE_HAS_CHANGES',
                    hasChanges: editorManager.hasSceneChanges(),
                    modifiedObjectIds: editorManager.getModifiedObjectIds(),
                    deletedObjectIds: editorManager.getDeletedObjectIds(),
                    fullSaveNeeded: editorManager.isFullSaveNeeded(),
                    pendingWorldConfig: editorManager.getPendingWorldConfig(),
                    pendingSpawnPoints: editorManager.getPendingSpawnPoints()
                });
            } else {
                safePostMessage({
                    type: 'SCENE_HAS_CHANGES',
                    hasChanges: false,
                    modifiedObjectIds: [],
                    fullSaveNeeded: false,
                    pendingWorldConfig: null
                });
            }
            break;
        case 'CLEAR_SCENE_CHANGES':
            // Clear the scene changes flag after successful save
            gameEngine?.editorManager?.clearSceneChanges();
            break;
        case 'GET_PERSISTENCE_DATA': {
            const persistence = gameEngine?.getGamePersistence?.();
            // Who the saves belong to: the local player (localhost), the
            // signed-in account, or a guest — the inspector labels them.
            const player = getCloudSaveStatus()?.player ?? { kind: 'guest', id: null };
            if (persistence) {
                const slots = persistence.listSlots();
                const slotData: Array<{ slot: string; version: number | null; savedAt: number | null; dataPreview: string }> = [];
                for (const slot of slots) {
                    const envelope = persistence.loadRaw(slot);
                    if (envelope) {
                        slotData.push({
                            slot,
                            version: envelope.version,
                            savedAt: envelope.savedAt,
                            dataPreview: JSON.stringify(envelope.data, null, 2),
                        });
                    }
                }
                safePostMessage({ type: 'PERSISTENCE_DATA', slots: slotData, player });
            } else {
                safePostMessage({ type: 'PERSISTENCE_DATA', slots: [], player });
            }
            break;
        }
        case 'CLEAR_PERSISTENCE_SLOT': {
            const persistence = gameEngine?.getGamePersistence?.();
            if (persistence && data.slot) {
                persistence.deleteSave(data.slot);
            }
            break;
        }
        case 'CLEAR_ALL_PERSISTENCE': {
            const persistence = gameEngine?.getGamePersistence?.();
            if (persistence) {
                for (const slot of persistence.listSlots()) {
                    persistence.deleteSave(slot);
                }
            }
            break;
        }
        case 'RESET_PLAYER_DATA': {
            // Hard wipe (unlike CLEAR_ALL_PERSISTENCE, which deletes through the
            // game's own persistence and so leaves tombstones): every key the
            // player accumulated for this game goes, and on localhost a new local
            // player is issued. The game reloads so it starts as that player.
            const removed = resetPlayerData();
            safePostMessage({ type: 'PLAYER_DATA_RESET', removed });
            await reloadCurrentGame();
            break;
        }
        case 'GET_GAME_DATA_CATEGORIES': {
            const adminToken = typeof data.adminToken === 'string' ? data.adminToken : '';
            const gameId = currentGameId;
            if (!gameId) {
                safePostMessage({ type: 'GAME_DATA_CATEGORIES', categories: [], error: 'No game loaded' });
                break;
            }
            fetchGameDataCategoriesForDialog(gameId, adminToken)
                .then((categories) => {
                    safePostMessage({ type: 'GAME_DATA_CATEGORIES', categories });
                })
                .catch((err: Error) => {
                    safePostMessage({ type: 'GAME_DATA_CATEGORIES', categories: [], error: err.message });
                });
            break;
        }
        case 'GET_GAME_DATA_USAGE': {
            const adminToken = typeof data.adminToken === 'string' ? data.adminToken : '';
            const gameId = currentGameId;
            if (!gameId) {
                safePostMessage({ type: 'GAME_DATA_USAGE', error: 'No game loaded' });
                break;
            }
            fetchGameDataUsage(gameId, adminToken)
                .then((usage) => safePostMessage({ type: 'GAME_DATA_USAGE', usage }))
                .catch((err: Error) => safePostMessage({ type: 'GAME_DATA_USAGE', error: err.message }));
            break;
        }
        case 'DELETE_GAME_DATA_ENTRY': {
            const adminToken = typeof data.adminToken === 'string' ? data.adminToken : '';
            const category = typeof data.category === 'string' ? data.category : '';
            const entryId = typeof data.entryId === 'string' ? data.entryId : '';
            const gameId = currentGameId;
            if (!gameId || !category || !entryId) {
                safePostMessage({ type: 'GAME_DATA_ENTRY_DELETED', category, entryId, error: 'Missing gameId, category, or entryId' });
                break;
            }
            deleteGameDataEntry(gameId, adminToken, category, entryId)
                .then(() => safePostMessage({ type: 'GAME_DATA_ENTRY_DELETED', category, entryId }))
                .catch((err: Error) => safePostMessage({ type: 'GAME_DATA_ENTRY_DELETED', category, entryId, error: err.message }));
            break;
        }
        case 'RESET_GAME_DATA_CATEGORY': {
            const adminToken = typeof data.adminToken === 'string' ? data.adminToken : '';
            const category = typeof data.category === 'string' ? data.category : '';
            const gameId = currentGameId;
            if (!gameId || !category) {
                safePostMessage({ type: 'GAME_DATA_RESET_DONE', category, error: 'Missing gameId or category' });
                break;
            }
            resetGameDataCategory(gameId, adminToken, category)
                .then((result) => {
                    safePostMessage({ type: 'GAME_DATA_RESET_DONE', category, jobId: result.jobId, totalEstimate: result.totalEstimate });
                })
                .catch((err: Error) => {
                    safePostMessage({ type: 'GAME_DATA_RESET_DONE', category, error: err.message });
                });
            break;
        }
        case 'CHECK_WORLD_MODIFIED':
            // Check if the game world has been modified since initial load
            // (voxels destroyed, objects moved, etc.)
            safePostMessage({
                type: 'WORLD_MODIFIED_STATUS',
                isModified: gameEngine?.editorManager?.isWorldModified() ?? false
            });
            break;
        case 'CHECK_VOXEL_CHANGES':
            // Check if voxel editor has unsaved changes
            safePostMessage({
                type: 'VOXEL_HAS_CHANGES',
                hasChanges: gameEngine?.editorManager?.hasVoxelChanges() ?? false
            });
            break;
        case 'CLEAR_VOXEL_CHANGES':
            // Clear the voxel changes flag after successful save
            gameEngine?.editorManager?.clearVoxelChanges();
            break;
        case 'GET_BLOCK_TYPES':
            // Return runtime-registered block types, terrain types, and materials for Ground Type editor
            try {
                const atlas = getVoxelTextureAtlas();
                const materialRegistry = getMaterialRegistry();
                const allBlockTypes = atlas.getAllBlockTypesWithProperties();
                const blockTypes = allBlockTypes.map(bt => ({
                    id: bt.id, name: bt.name,
                    properties: { smoothSurface: bt.properties.smoothSurface, smoothRadius: bt.properties.smoothRadius },
                    materialId: atlas.getBlockMaterial(bt.id),
                    terrainTypeId: atlas.getBlockTerrainType(bt.id),
                    grip: atlas.getBlockGrip(bt.id)  // Surface grip (0=ice, 1=max traction)
                }));
                const materials: Array<{ id: number; name: string; friction: number; density: number; restitution: number }> = [];
                for (const [id, mat] of materialRegistry.getAllMaterials()) {
                    materials.push({ id, name: mat.name, friction: mat.friction, density: mat.density, restitution: mat.restitution });
                }
                // Get terrain types from world generator if available
                let terrainTypes: Array<{ id: number; name: string }> = [];
                const worldGenerator = (gameEngine?.genreModule as any)?.worldGenerator;
                if (worldGenerator?.terrainRegistry?.getAllTypes) {
                    for (const [id, tt] of worldGenerator.terrainRegistry.getAllTypes()) {
                        terrainTypes.push({ id, name: tt.name });
                    }
                }
                safePostMessage({ type: 'BLOCK_TYPES_RESPONSE', blockTypes, materials, terrainTypes });
            } catch (error) {
                console.error('[GroundTypes] Error getting block types:', error);
                safePostMessage({ type: 'BLOCK_TYPES_RESPONSE', blockTypes: [], materials: [], terrainTypes: [], error: String(error) });
            }
            break;
        case 'CHECK_TERRAIN_CHANGES':
            // Check if terrain has unsaved changes
            safePostMessage({
                type: 'TERRAIN_HAS_CHANGES',
                hasChanges: gameEngine?.editorManager?.hasUnsavedTerrainChanges() ?? false
            });
            break;
        case 'SAVE_TERRAIN_CHANGES':
            // Save terrain changes - pass sessionId for diff tracking
            if (gameEngine?.editorManager) {
                const sessionId = data?.sessionId;
                gameEngine.editorManager.saveTerrainChangesAsync(sessionId).then((result) => {
                    // `ok` distinguishes "saved" from "the upload failed and the edit is still
                    // unsaved in the tab". Hosts that only read voxelUrl are unaffected.
                    if (!result?.ok) {
                        safePostMessage({ type: 'TERRAIN_SAVE_ERROR', error: result?.error ?? 'Terrain save failed', sessionId });
                        return;
                    }
                    safePostMessage({ type: 'TERRAIN_SAVED', voxelUrl: result.voxelUrl, sessionId });
                }).catch((error: Error) => {
                    console.error('[game-template] Error saving terrain:', error);
                    safePostMessage({ type: 'TERRAIN_SAVE_ERROR', error: error.message });
                });
            }
            break;
        case 'REVERT_TERRAIN_CHANGES':
            // Revert terrain changes
            if (gameEngine?.editorManager) {
                gameEngine.editorManager.cancelTerrainChanges();
                safePostMessage({ type: 'TERRAIN_REVERTED' });
            }
            break;
        case 'GET_CAMERA_TRANSFORM':
            // Get current camera position and rotation for save/restore across reloads
            if (gameEngine && gameEngine.camera) {
                const cam = gameEngine.camera;
                safePostMessage({
                    type: 'CAMERA_TRANSFORM',
                    transform: {
                        position: { x: cam.position.x, y: cam.position.y, z: cam.position.z },
                        rotation: { x: cam.rotation.x, y: cam.rotation.y, z: cam.rotation.z }
                    }
                });
            } else {
                safePostMessage({ type: 'CAMERA_TRANSFORM', transform: null });
            }
            break;
        case 'SET_CAMERA_TRANSFORM':
            // Restore camera position and rotation after reload
            if (gameEngine && gameEngine.camera && data && data.transform) {
                const { position, rotation } = data.transform;
                if (position) {
                    gameEngine.camera.position.set(position.x, position.y, position.z);
                }
                if (rotation) {
                    gameEngine.camera.rotation.set(rotation.x, rotation.y, rotation.z);
                }
            }
            break;
        case 'REMOVE_MARKER':
            // Handle marker removal from creator
            if (gameEngine && gameEngine.editorManager && gameEngine.editorManager.markerSystem) {
                const markerSystem = gameEngine.editorManager.markerSystem;
                if (data.markerId) {
                    markerSystem.removeMarker(data.markerId);
                    // Refresh scene hierarchy to reflect removal
                    if (gameEngine.editorManager.refreshSceneHierarchy) {
                        gameEngine.editorManager.refreshSceneHierarchy();
                    }
                    // Clear selection if the removed marker was selected
                    if (gameEngine.editorManager.selectedObject &&
                        gameEngine.editorManager.selectedObject.userData?.markerData?.id === data.markerId) {
                        gameEngine.editorManager.selectedObject = null;
                        if (gameEngine.editorManager.objectInspector) {
                            gameEngine.editorManager.objectInspector.close();
                        }
                    }
                }
            }
            break;
        case 'CHECK_SPLAT_TRANSFORMS_DIRTY': {
            // Check if splat transforms have been modified since last save
            const colliderEditor = getColliderEditor();
            const isDirty = colliderEditor && typeof (colliderEditor as any).getTransformsDirty === 'function'
                ? (colliderEditor as any).getTransformsDirty()
                : false;
            safePostMessage({ type: 'SPLAT_TRANSFORMS_DIRTY_STATUS', isDirty });
            break;
        }
        case 'SAVE_ALL_SPLAT_TRANSFORMS':
            // Save all current splat transforms to world.json before operations like adding new splats
            if (gameEngine && gameEngine.gaussianSplatRenderer) {
                const colliderEditor = gameEngine.gaussianSplatRenderer.getColliderEditor();
                if (colliderEditor && typeof (colliderEditor as any).saveAllSplatTransforms === 'function') {
                    try {
                        console.log('[editor] [game-template] Calling saveAllSplatTransforms...');
                        const savedSplats = await (colliderEditor as any).saveAllSplatTransforms();
                        console.log('[editor] [game-template] ✅ saveAllSplatTransforms complete, returning saved data');

                        // Clear dirty flag after successful save
                        if (typeof (colliderEditor as any).clearTransformsDirty === 'function') {
                            (colliderEditor as any).clearTransformsDirty();
                        }

                        safePostMessage({
                            type: 'SAVE_ALL_SPLAT_TRANSFORMS_RESPONSE',
                            success: true,
                            savedSplats: savedSplats
                        });
                    } catch (error) {
                        console.error('[editor] [game-template] ❌ Failed to save all splat transforms:', error);
                        safePostMessage({
                            type: 'SAVE_ALL_SPLAT_TRANSFORMS_RESPONSE',
                            success: false,
                            error: error instanceof Error ? error.message : String(error)
                        });
                    }
                } else {
                    safePostMessage({
                        type: 'SAVE_ALL_SPLAT_TRANSFORMS_RESPONSE',
                        success: false,
                        error: 'Collider editor not available'
                    });
                }
            } else {
                safePostMessage({
                    type: 'SAVE_ALL_SPLAT_TRANSFORMS_RESPONSE',
                    success: false,
                    error: 'Game engine not available'
                });
            }
            break;
        case 'ASSETS_RESPONSE':
        case 'EDITOR_HOST_CAPABILITIES':
            // Both belong to EditorHost, which owns its own window message listener
            // (game/src/editor/EditorHost.ts) — the assets reply because the request that asked
            // for it is awaiting exactly that message, and the capability announcement because a
            // host may re-send it at any time, including before this router exists.
            //
            // Listed rather than left to fall through: the default arm warns about every unknown
            // type, and a host announcing itself twice a session should not read as a bug in every
            // creator's console.
            break;
        case 'MARK_OBJECT_MODIFIED':
            // Mark an object as modified for scene change tracking
            // Called when object is added via asset library so it's included in tab-switch save
            if (data.objectId && gameEngine?.editorManager) {
                gameEngine.editorManager.markObjectModified(data.objectId);
            }
            break;
        case 'UPDATE_GAME_DATA':
            // Update gameData without reloading (for flag updates, asset additions, etc.)
            if (gameEngine && data.gameData) {
                ctx.setCurrentGameData(data.gameData);
                // Update GameEngine's currentGameData via loadGame method's storage
                (gameEngine as any).currentGameData = data.gameData;

                // CRITICAL: Also update WorldGenerator's gameData so serializePlacedObjects works
                const worldGenerator = (gameEngine.genreModule as any)?.worldGenerator;
                if (worldGenerator && typeof worldGenerator.setGameData === 'function') {
                    worldGenerator.setGameData(data.gameData);
                    console.log('[game-template] Updated worldGenerator.gameData');
                }

                // Push the latest cropBounds / cleanupBounds onto every splat
                // renderer so runtime bounds queries (CarWashSystem etc.)
                // match what the user set in the side panel without needing
                // a reload.
                try {
                    const assets: Array<{ id?: string; cropBounds?: any; cleanupBounds?: any; shadowCatcher?: boolean; shadowCatcherYOffset?: number }> = Array.isArray(data.gameData?.assets) ? data.gameData.assets : [];
                    const envObjs: Array<{ id?: string; assetId?: string }> = Array.isArray(data.gameData?.environmentObjects) ? data.gameData.environmentObjects : [];
                    type SplatSettings = { crop: any; cleanup: any; shadowCatcher: boolean; shadowYOffset: number };
                    const settingsByAssetId = new Map<string, SplatSettings>();
                    for (const a of assets) {
                        if (a?.id) settingsByAssetId.set(a.id, {
                            crop: a.cropBounds ?? null,
                            cleanup: a.cleanupBounds ?? null,
                            shadowCatcher: !!a.shadowCatcher,
                            shadowYOffset: typeof a.shadowCatcherYOffset === 'number' ? a.shadowCatcherYOffset : 0,
                        });
                    }
                    const settingsByEnvId = new Map<string, SplatSettings>();
                    for (const e of envObjs) {
                        if (e?.id && e?.assetId) settingsByEnvId.set(e.id, settingsByAssetId.get(e.assetId) ?? { crop: null, cleanup: null, shadowCatcher: false, shadowYOffset: 0 });
                    }
                    for (const r of (gameEngine.gaussianSplatRenderers ?? [])) {
                        const envId = typeof r?.getEnvObjectId === 'function' ? r.getEnvObjectId() : null;
                        const s = envId ? settingsByEnvId.get(envId) : null;
                        if (typeof (r as any).setCropBoundsRaw === 'function') {
                            (r as any).setCropBoundsRaw(s?.crop ?? null);
                        }
                        if (typeof (r as any).setCleanupBoundsRaw === 'function') {
                            (r as any).setCleanupBoundsRaw(s?.cleanup ?? null);
                        }
                        // Offset must come BEFORE enabling — refreshShadowCatcher
                        // reads the offset when (re)building the plane.
                        if (typeof (r as any).setShadowCatcherYOffset === 'function') {
                            (r as any).setShadowCatcherYOffset(s?.shadowYOffset ?? 0);
                        }
                        if (typeof (r as any).setShadowCatcherEnabled === 'function') {
                            (r as any).setShadowCatcherEnabled(!!s?.shadowCatcher);
                        }
                    }
                } catch (err) {
                    console.warn('[game-template] splat settings propagation failed (non-fatal):', err);
                }

                // Update scene editing lock status
                gameEngine.editorManager?.checkSceneEditingLockStatus(false);

                console.log('[game-template] Updated gameData without reload');
            }
            break;
        case 'GET_WORLD_DATA':
            // Return current world data (gameData) to parent frame
            {
                const gameData = gameEngine?.getGameData();
                if (gameData) {
                    // Include gameId in the response so editor can use it for unique filenames
                    const responseData = { ...gameData };
                    if (currentGameId) {
                        (responseData as any).gameId = currentGameId;
                    }
                    safePostMessage({
                        type: 'WORLD_DATA_RESPONSE',
                        worldData: responseData
                    });
                } else {
                    // Fallback: try to load world.json directly
                    try {
                        const { loadWorldData } = await import('../../utils/worldDataLoader.js');
                        const worldData = await loadWorldData();
                        const responseData = { ...worldData };
                        if (currentGameId) {
                            (responseData as any).gameId = currentGameId;
                        }
                        safePostMessage({
                            type: 'WORLD_DATA_RESPONSE',
                            worldData: responseData
                        });
                    } catch (error) {
                        console.error('Failed to load world data:', error);
                        safePostMessage({
                            type: 'WORLD_DATA_RESPONSE',
                            worldData: null
                        });
                    }
                }
            }
            break;
        case 'GET_RUNTIME_SPLATS':
            if (gameEngine) {
                const runtimeSplats = gameEngine.gaussianSplatRenderers.map((r, i) => ({
                    url: r.getSplatUrl?.() || '',
                    position: { x: r.getPosition().x, y: r.getPosition().y, z: r.getPosition().z },
                    eulerAngles: {
                        x: r.getRotation().x * (180 / Math.PI),
                        y: r.getRotation().y * (180 / Math.PI),
                        z: r.getRotation().z * (180 / Math.PI),
                    },
                    scale: { x: r.getScale().x, y: r.getScale().y, z: r.getScale().z },
                    name: `Splat ${i + 1}`,
                }));
                safePostMessage({ type: 'RUNTIME_SPLATS_RESPONSE', splats: runtimeSplats });
            } else {
                safePostMessage({ type: 'RUNTIME_SPLATS_RESPONSE', splats: [] });
            }
            break;
        case 'GET_SCENE_EDITING_STATUS':
            if (gameEngine && gameEngine.editorManager) {
                const editorManager = gameEngine.editorManager;
                const isUnlocked = !editorManager.sceneEditingLocked;

                // Always get markers data (independent of scene editing lock)
                // Prefer runtime markerSystem (has current state) over gameData (initial state)
                let markers: any[] = [];
                if (editorManager.markerSystem && typeof editorManager.markerSystem.serializeMarkers === 'function') {
                    markers = editorManager.markerSystem.serializeMarkers();
                } else {
                    // Fallback to initial game data if markerSystem not available
                    const gameData = gameEngine.getGameData();
                    if (gameData?.worldProfileData?.markers) {
                        markers = gameData.worldProfileData.markers;
                    }
                }
                if (!Array.isArray(markers)) {
                    markers = []; // Ensure markers is always an array
                }

                // Always get environment objects for read-only purposes (e.g., @-mentions)
                // The 'unlocked' flag indicates whether editing is allowed
                const worldGenerator = gameEngine.genreModule ? (gameEngine.genreModule as any).worldGenerator : null;
                let environmentObjects: any[] = [];

                if (worldGenerator) {
                    // Read-only handler — never mutate scene state here. serializeEnvironmentObjects()
                    // is state-agnostic (works whether InstancedMeshes are packed or unpacked).
                    if (typeof worldGenerator.serializeEnvironmentObjects === 'function') {
                        // LOD-instanced buffers are repacked per frame by culling;
                        // restore logical slot order so the serializer's
                        // getMatrixAt(instanceIndex) reads the right instance.
                        getActiveEnvironmentObjectSystem()?.restoreLogicalInstanceMatrices();
                        environmentObjects = worldGenerator.serializeEnvironmentObjects();
                    }
                }

                // WHICH LEVEL the array above covers. serializeEnvironmentObjects()
                // walks the LIVE scene, and a multi-level game only ever has one
                // level instantiated — so the array holds this level's instances
                // plus the untagged/global ones (the isInstanceInActiveLevel rule),
                // and NOTHING from the other levels. A saver that treats it as the
                // whole world deletes every other level's scenery. `null` (legacy /
                // single-level games) genuinely means "this is the whole world".
                safePostMessage({
                    type: 'SCENE_EDITING_STATUS',
                    unlocked: isUnlocked,
                    environmentObjects: environmentObjects,
                    activeLevelId: getActiveLevelIdOrNull(),
                    markers: markers
                });
            } else {
                // Silently return empty data - this is expected during initial load
                // when the game engine hasn't fully initialized yet
                safePostMessage({
                    type: 'SCENE_EDITING_STATUS',
                    unlocked: false,
                    environmentObjects: [],
                    activeLevelId: null,
                    markers: []
                });
            }
            break;
        case 'HIGHLIGHT_OBJECT':
            // Highlight an object in the scene (for @-mention preview)
            if (data.position && gameEngine) {
                createHighlightBox(gameEngine, data.position, data.objectType);
            }
            break;
        case 'CLEAR_HIGHLIGHT':
            // Clear object highlighting
            if (gameEngine) {
                clearObjectHighlight(gameEngine);
            }
            break;
        case 'SET_LANGUAGE':
            if (data.language) {
                console.log(`🌐 Setting language to: ${data.language}`);
                setLanguage(data.language as SupportedLanguage);
            }
            break;
        case 'CREATE_VOXEL_ASSET':
            await handleCreateVoxelAsset(templateContext, data);
            break;
        case 'PLACE_VOXEL_OBJECT':
            await handlePlaceVoxelObject(templateContext, data);
            break;
        case 'BATCH_PLACE_VOXEL_OBJECTS':
            await handleBatchPlaceVoxelObjects(templateContext, data);
            break;
        case 'MODIFY_VOXEL_OBJECT':
            await handleModifyVoxelObject(templateContext, data);
            break;
        case 'DELETE_VOXEL_OBJECT':
            await handleDeleteVoxelObject(templateContext, data);
            break;
        case 'GENERATE_VOXEL_PREVIEW':
            await handleGenerateVoxelPreview(templateContext, data);
            break;
        case 'REGISTER_CUSTOM_BLOCK_TYPE':
            await handleRegisterCustomBlockType(templateContext, data);
            break;
        case 'PROCESS_FBX_ANIMATION':
            await handleProcessFBXAnimation(templateContext, data);
            break;
        case 'INSPECT_GLB_ANIMATION':
            await handleInspectGlbAnimation(templateContext, data);
            break;
        case 'INSPECT_GLB_FOR_LEVEL_VOXELIZE':
            await handleInspectGlbForLevelVoxelize(templateContext, data);
            break;
        case 'TEST_FBX_WITH_SKIN':
            await handleTestFBXWithSkin(templateContext, data);
            break;
        case 'CLEANUP_FBX_TEST':
            handleCleanupFBXTest(templateContext);
            break;
        case 'VOXELIZE_GLB':
            await handleVoxelizeGLB(templateContext, data);
            break;
        case 'VOXELIZE_GLB_AS_LEVEL':
            await handleVoxelizeGlbAsLevel(templateContext, data);
            break;
        case 'INSPECT_VOXEL_MODEL':
            await handleInspectVoxelModel(templateContext, data);
            break;
        case 'IMPORT_VOXEL_MODEL':
            await handleImportVoxelModel(templateContext, data);
            break;
        case 'GENERATE_GLB_COLLIDER':
            await handleGenerateGlbCollider(templateContext, data);
            break;
        case 'GENERATE_GLB_PREVIEW':
            await handleGenerateGlbPreview(templateContext, data);
            break;
        case 'CREATE_ASSET_FROM_GLB_URL':
            await handleCreateAssetFromGlbUrl(templateContext, data);
            break;
        case 'CREATE_ASSET_FROM_VXL_MASTER':
            await handleCreateAssetFromVxlMaster(templateContext, data);
            break;
        case 'REVOXELIZE_FROM_VXL_MASTER':
            await handleRevoxelizeFromVxlMaster(templateContext, data);
            break;
        case 'READ_VXL_MATERIAL_SIGNATURE':
            await handleReadVxlMaterialSignature(templateContext, data);
            break;
        case 'APPLY_VXL_MATERIALS':
            await handleApplyVxlMaterials(templateContext, data);
            break;
        case 'REGISTER_GLB_ASSET':
            await handleRegisterGlbAsset(templateContext, data);
            break;
        case 'ENABLE_PERF_STATS':
            gameEngine?.enablePerfStats();
            break;
        case 'DISABLE_PERF_STATS':
            gameEngine?.disablePerfStats();
            break;
        case 'RESET_PERF_ORPHANS':
            gameEngine?.resetPerfOrphanTracking();
            break;
        case 'SET_RENDERER_TYPE': {
            const rendererType = (data as { rendererType?: unknown })?.rendererType;
            if (rendererType === 'webgl' || rendererType === 'webgpu') {
                gameEngine?.setRendererType(rendererType);
            }
            break;
        }
        case 'SET_WEB_LLM': {
            // Dev-tool toggle for the in-browser web-llm runtime-AI provider.
            // Persists the flag to this (game-origin) localStorage and re-resolves
            // the provider live — no reload needed.
            const enabled = !!(data as { enabled?: unknown })?.enabled;
            gameEngine?.getAIService().setWebLLMEnabled(enabled);
            break;
        }
        case 'SET_LID_CONTROL': {
            // Dev-tool toggle for the experimental MacBook-lid controller (localhost
            // only). Persists the flag to this (game-origin) localStorage and opens
            // or closes the sensor SSE connection live — no reload needed.
            const enabled = !!(data as { enabled?: unknown })?.enabled;
            gameEngine?.setLidControlEnabled(enabled);
            break;
        }
        // Owned by other window listeners in this same frame. Every 'message' listener on the
        // window sees every post, so these reach the switch too — named here so a message that
        // was in fact handled does not get reported as an unknown one.
        case 'RECORDING_SETTINGS_CHANGED': // ScreenRecorder
        case 'TRAILER_RECORDING': // ScreenRecorder (bitmagic trailer record)
        case 'TRAILER_FLYTHROUGH': // ScreenRecorder (bitmagic trailer record --flythrough)
        case 'SPLAT_BATCH_SAVED_RESPONSE': // CreatorPersistence / GaussianSplatEditor
        case 'WORLD_PROFILE_FIELD_SAVED_RESPONSE': // CreatorPersistence
        case 'FIX_ERRORS_COMPLETE': // ConsolePanel
        case 'EDITOR_HOST_CAPABILITIES': // EditorHost
            break;
        default:
            // The engine's OWN replies land back here. `safePostMessage` posts on the window,
            // and every 'message' listener in the frame sees every post — the same mechanism the
            // named cases above document, just for outbound traffic rather than another
            // listener's inbound. An ACK or a RESULT is never a command, so it is ignored rather
            // than reported as unknown.
            //
            // Matched by suffix instead of enumerated: reply names are added far more often than
            // this switch is read, and a list would put every new handler one forgotten line away
            // from a false "Unknown message type". Commands are imperative by convention
            // (CREATE_, APPLY_, READ_, REGISTER_) and so cannot collide with these endings.
            if (/_(ACK|RESULT|SAVED|REGISTERED|PROGRESS)$/.test(type)) break;
            console.warn('Unknown message type:', type);
    }
}

async function onWindowMessage(event: MessageEvent): Promise<void> {
    // Accept messages from parent window (creator)
    // Support both http/https and localhost/custom domains
    const parentUrl = new URL(event.origin);

    // Validate that the message comes from an accepted origin
    // Local dev: port 3000
    // Production: alpha.creator.bitmagic.cloud or creator.bitmagic.cloud (ports 80/443)
    const acceptedOrigins = [
        'localhost',
        '127.0.0.1',
        'alpha.creator.bitmagic.cloud',
        'creator.bitmagic.cloud',
        'backend.creator.bitmagic.cloud',
        'beta.creator.bitmagic.cloud',
        'creator.bitmagic.ai'
    ];

    // Also accept messages from the same hostname (LAN IP testing)
    const isSameHost = parentUrl.hostname === window.location.hostname;
    const isAcceptedOrigin = isSameHost || acceptedOrigins.includes(parentUrl.hostname);
    // Local dev accepts any port so parallel clones on shifted ports (see repo .env.local)
    // can still reach the game iframe; prod is constrained to 80/443/default.
    const isLocalhost = parentUrl.hostname === 'localhost' || parentUrl.hostname === '127.0.0.1';
    const acceptedPorts = ['80', '443', ''];
    const isAcceptedPort = isLocalhost || acceptedPorts.includes(parentUrl.port);

    if (!isAcceptedOrigin || !isAcceptedPort) {
        return; // Silently ignore messages from other origins
    }

    const { type, data: messageData } = event.data;
    const data = messageData || event.data;

    // Queue messages until physics engine is ready
    if (!physicsReady && (type === 'LOAD_GAME' || type === 'RELOAD_GAME')) {
        console.log(`Queueing ${type} message until physics engine is ready`);
        pendingMessages.push({ type, data });
        return;
    }

    // Queue tool messages that require a loaded game: none is loaded yet
    // (arriving during an iframe reload, before LOAD_GAME) or one is still
    // loading. The second gate matters as much as the first — currentGameData
    // is set the moment a load STARTS, and an "Edit voxels…" click during the
    // seconds a world takes to boot used to reach a half-initialised editor
    // (still in its default locked state) and fail with a lock message the
    // Assets tab never shows.
    if ((!ctx.getCurrentGameData() || ctx.isGameLoading()) && REQUIRES_GAME_LOADED.has(type)) {
        console.log(`⏳ Queueing ${type} message until game is loaded`);
        // VOXELIZE_GLB deliveries are re-posted by the creator until ACKed
        // (they vanish when posted mid-reload). ACK from the queue too so the
        // re-post loop stops, and drop duplicates that already made it in.
        if (type === 'VOXELIZE_GLB' && data?.requestId) {
            safePostMessage({ type: 'VOXELIZE_GLB_ACK', requestId: data.requestId });
            if (pendingMessages.some((m) => m.type === 'VOXELIZE_GLB' && m.data?.requestId === data.requestId)) {
                return;
            }
        }
        // IMPORT_VOXEL_MODEL uses the same re-post-until-ACK protocol.
        if (type === 'IMPORT_VOXEL_MODEL' && data?.requestId) {
            safePostMessage({ type: 'IMPORT_VOXEL_MODEL_ACK', requestId: data.requestId });
            if (pendingMessages.some((m) => m.type === 'IMPORT_VOXEL_MODEL' && m.data?.requestId === data.requestId)) {
                return;
            }
        }
        // GENERATE_GLB_COLLIDER uses the same re-post-until-ACK protocol.
        if (type === 'GENERATE_GLB_COLLIDER' && data?.requestId) {
            safePostMessage({ type: 'GENERATE_GLB_COLLIDER_ACK', requestId: data.requestId });
            if (pendingMessages.some((m) => m.type === 'GENERATE_GLB_COLLIDER' && m.data?.requestId === data.requestId)) {
                return;
            }
        }
        pendingMessages.push({ type, data });
        return;
    }

    await handleMessage(type, data);
}

export function registerCreatorMessageListener(context: CreatorMessageContext): void {
    ctx = context;
    templateContext = {
        getGameEngine: () => ctx.getEngine(),
        getCurrentGameData: () => ctx.getCurrentGameData(),
        setCurrentGameData: (d: any) => ctx.setCurrentGameData(d),
        safePostMessage,
    };
    window.addEventListener('message', (event) => { void onWindowMessage(event); });
}

/**
 * Run everything in `pendingMessages`, in arrival order. One handler throwing
 * must not strand the rest of the queue — each entry is a creator request
 * somebody is waiting on, and (before physics is ready) the LOAD_GAME itself
 * may sit behind a tool message.
 */
async function drainPendingMessages(reason: string): Promise<void> {
    if (pendingMessages.length === 0) return;
    console.log(`Processing ${pendingMessages.length} pending messages ${reason}`);
    const queued = [...pendingMessages];
    pendingMessages = [];
    for (const message of queued) {
        try {
            await handleMessage(message.type, message.data);
        } catch (error) {
            console.error(`[CreatorMessageHandler] Queued ${message.type} failed:`, error);
        }
    }
}

export async function notifyPhysicsReady(): Promise<void> {
    physicsReady = true;
    await drainPendingMessages('(physics ready)');
}

/**
 * Drain the tool messages queued while no game was loaded / a load was in
 * flight. Called by whoever finished a load, AFTER its post-load setup (see the
 * LOAD_GAME handler) — not from inside `loadGame()`, where it used to run.
 */
export async function flushPendingToolMessages(): Promise<void> {
    await drainPendingMessages('after game load');
}
