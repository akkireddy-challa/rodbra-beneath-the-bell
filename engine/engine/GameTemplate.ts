// Type checking enabled
// MUST stay the first import: in play-test mode it walls the page off from the
// user's storage and every network write before any other module runs.
import 'engine/playtest/PlaytestGuard.js';
import { GameEngine } from 'engine/GameEngine.js';
import type { MobileParityResult } from 'engine/MobileParity.js';
import { GameRuntimeController } from 'engine/GameRuntimeController.js';
import { getGameStateManager, GameState } from 'engine/GameStateManager.js';
import type { GameData } from 'types/game.js';
import 'core/utils/AutoCacheBuster.js'; // Enable automatic cache busting for work files
import { getAnalytics } from 'engine/Analytics.js';
import { InGameNotification } from 'engine/InGameNotification.js';
import { initI18n } from 'engine/i18n/index.js';
import { isCreatorMode, isStandaloneMode, isAutostartRequested, isPlaytestMode, safePostMessageToCreator as safePostMessage } from 'engine/CreatorMode.js';
import { installBmDebug, isEventLogRequested } from 'engine/BmDebug.js';
import { getGameEventLog } from 'engine/recording/GameEventLog.js';
import { getLoadProgress } from 'engine/progress/LoadProgress.js';
import { t } from 'engine/i18n/index.js';
import { resolveStartScreenSelections, defaultPick, type SelectionStepSpec } from 'engine/ui/SelectionSteps.js';
import { resolveLevels } from 'engine/levels/levelResolve.js';
import { getLaunchParams } from 'engine/LaunchParams.js';
import type { StartScreen } from 'engine/ui/StartScreen.js';
import { installForcedMobileTouchShim, isMobileRuntime } from 'engine/isMobileRuntime.js';
import {
    registerCreatorMessageListener, notifyPhysicsReady, flushPendingToolMessages,
    type CreatorMessageContext,
} from 'engine/template/CreatorMessageHandler.js';
import { applyThemeGlobals } from 'engine/hud/index.js';
import { saveEditorView, restoreEditorView } from 'engine/EditorViewMemory.js';
import { resolveWorldTheme } from 'engine/hud/resolveWorldTheme.js';


// viteSingleFile automatically inlines JSON files in bundles - fetch works in both dev and bundle modes

let gameEngine: GameEngine | null = null;
let currentGameId: string | null = null;
let currentGameData: any = null;
/**
 * Number of `loadGame()` calls in flight. `currentGameData` is assigned at the
 * top of a load, so on its own it says "a game exists", not "a game is ready";
 * the creator message handler reads this to hold tool messages until the load
 * has actually finished. A counter rather than a flag so an overlapping reload
 * cannot open the gate early.
 */
let activeGameLoads = 0;
let runtimeController: GameRuntimeController;
let inGameNotification: InGameNotification | null = null;

/**
 * The player's pre-play picks for the CURRENT game this session. Reloads of
 * the same game (creator AI edits reload the iframe content constantly) reuse
 * these instead of re-presenting every selection step after each edit; a
 * different gameId starts fresh.
 */
let lastSelections: { gameId: string; picks: Record<string, string> } | null = null;

function rememberSelection(gameId: string, selectionId: string, optionId: string): void {
    if (lastSelections?.gameId !== gameId) {
        lastSelections = { gameId, picks: {} };
    }
    lastSelections.picks[selectionId] = optionId;
}

/** A remembered pick, but only if it is still one of the step's options. */
function rememberedPickFor(gameId: string, step: SelectionStepSpec): string | null {
    if (lastSelections?.gameId !== gameId) return null;
    const pick = lastSelections.picks[step.id];
    if (pick === undefined) return null;
    return step.options.some((o) => o.id === pick) ? pick : null;
}

/** Lazily create the shared in-game notification toast. */
function ensureNotification(): InGameNotification {
    if (!inGameNotification) {
        inGameNotification = new InGameNotification();
    }
    return inGameNotification;
}

/** Bundle the module-level runtime state/lifecycle the creator message handler needs. */
function createCreatorMessageContext(): CreatorMessageContext {
    return {
        getEngine: () => gameEngine,
        runtimeController,
        getCurrentGameData: () => currentGameData,
        setCurrentGameData: (data) => { currentGameData = data; },
        getCurrentGameId: () => currentGameId,
        isGameLoading: () => activeGameLoads > 0,
        ensureNotification,
        loadGame,
        reloadCurrentGame,
        disposeGame,
        captureScreenshot,
        handleGameStart,
        showMenu,
    };
}



async function captureScreenshot(mode: 'immediate' | 'warmup' = 'immediate'): Promise<void> {
    try {
        if (!gameEngine) {
            console.warn('Game engine not loaded, cannot capture screenshot');
            safePostMessage({ type: 'SCREENSHOT_RESPONSE', screenshot: null });
            return;
        }

        // Warmup mode waits a few frames so async asset uploads (textures, splats)
        // reach the GPU before we sample the back buffer.
        if (mode === 'warmup') {
            await waitForFrames(SCREENSHOT_WARMUP_FRAMES);
        }

        // Get the Three.js renderer's canvas.
        const canvas = gameEngine.getRenderer().domElement;

        // Gate on the GENRE, not `gameDimension`: only the Physics2D genre draws its
        // visible pixels into a separate 2D overlay <canvas> that exists while
        // PLAYING — for those games we briefly enter play to paint it, composite all
        // on-screen canvases, then revert to a clean menu via reload. Every other
        // game — voxel sidescrollers with `gameDimension: '2d'` included — renders in
        // the WebGL canvas, which we read directly (preserveDrawingBuffer is enabled
        // in creator mode): the composite path's premise is simply false for them,
        // and its revert-reload is a full second loadGame per capture.
        const is2D = currentGameData?.gameGenre === 'Physics2D';
        let forcedPlayForCapture = false;
        if (is2D) {
            const stateManager = getGameStateManager();
            if (!stateManager.isState(GameState.PLAYING)) {
                stateManager.markPlaying();
                forcedPlayForCapture = true;
                await waitForFrames(SCREENSHOT_2D_PLAY_FRAMES);
            }
        }

        const screenshot = is2D
            ? captureCompositeScreenshot(canvas)
            : canvas.toDataURL('image/jpeg', 0.9);

        console.log('Screenshot captured, size:', screenshot.length, 'mode:', mode);

        // Send screenshot data back to parent
        safePostMessage({
            type: 'SCREENSHOT_RESPONSE',
            screenshot: screenshot
        });

        // Restore the clean menu after a capture-only play. Fire-and-forget: the
        // screenshot is already sent, and the reload disposes the temporary 2D canvas.
        if (forcedPlayForCapture) {
            void reloadCurrentGame();
        }

    } catch (error) {
        console.error('Failed to capture screenshot:', error);
        safePostMessage({ type: 'SCREENSHOT_RESPONSE', screenshot: null });
    }
}

/** True if `c` is currently visible with a non-zero backing store. */
function isCanvasVisible(c: HTMLCanvasElement): boolean {
    if (!c.width || !c.height) return false;
    const style = getComputedStyle(c);
    return style.display !== 'none' && style.visibility !== 'hidden';
}

/**
 * Composite every visible <canvas> in the document onto a single 2D canvas and
 * return it as a JPEG data URL. Used for 2D games, whose pixels live in their own
 * 2D canvas overlaid on the (empty) WebGL/WebGPU renderer canvas.
 *
 * Draws the renderer canvas first (background), then all other canvases in
 * document order. Ordering is not strict CSS z-index, which is acceptable for the
 * single-overlay pattern 2D games use. drawImage from the renderer canvas works
 * because preserveDrawingBuffer is enabled in creator mode.
 */
function captureCompositeScreenshot(rendererCanvas: HTMLCanvasElement): string {
    const out = document.createElement('canvas');
    out.width = rendererCanvas.width;
    out.height = rendererCanvas.height;
    const ctx = out.getContext('2d');
    if (!ctx) return rendererCanvas.toDataURL('image/jpeg', 0.9);

    const others = Array.from(document.querySelectorAll('canvas')).filter(c => c !== rendererCanvas);
    for (const c of [rendererCanvas, ...others]) {
        if (!isCanvasVisible(c)) continue;
        ctx.drawImage(c, 0, 0, out.width, out.height); // scales source canvas to fill
    }
    return out.toDataURL('image/jpeg', 0.9);
}

const SCREENSHOT_WARMUP_FRAMES = 6;

// Frames to let a 2D game's render loop paint its board after we force-enter play
// purely to capture a screenshot (see captureScreenshot).
const SCREENSHOT_2D_PLAY_FRAMES = 12;

function waitForFrames(count: number): Promise<void> {
    return new Promise(resolve => {
        let remaining = count;
        const step = () => {
            remaining -= 1;
            if (remaining <= 0) resolve();
            else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    });
}

// Initialize game engine (physics WASM is loaded on-demand in GameEngine.loadGame based on physicsMode)
(async () => {
    try {
        // The engine bundle is executing — first real progress signal after the
        // static boot shell's synthetic trickle (see index.html / LoadProgress).
        // No label: i18n isn't up yet, and the shell already says "Loading…".
        getLoadProgress().beginPhase('boot');

        // Before anything else: when ?platform=mobile forces mobile mode on a
        // non-touch device (creator mobile preview), shim the touch-capability
        // globals so game-side device probes match real mobile behavior.
        installForcedMobileTouchShim();

        // Initialize i18n before processing any messages (required for EditorManager)
        await initI18n();
        console.log('i18n initialized in game template');

        // Flush any creator messages queued before physics was ready (no-op in
        // standalone, where the creator handler is stubbed out of the bundle).
        await notifyPhysicsReady();

        await init();
    } catch (error) {
        console.error('Failed to initialize game engine:', error);
    }
})();

async function init(): Promise<void> {
    console.log('Game template initialized');

    // Note: i18n is initialized earlier in Rapier callback to avoid race conditions
    // with EditorManager creation that needs translations

    runtimeController = new GameRuntimeController(
        document.getElementById('game-container') as HTMLElement,
        safePostMessage
    );

    // Set up resize handler
    window.addEventListener('resize', () => {
        if (gameEngine) {
            gameEngine.onWindowResize();
        }
    });


    console.log('🔍 Mode detection:', {
        isCreatorMode,
        isStandaloneMode,
        location: window.location.href
    });

    // Always show menu first
    console.log('🎮 Showing menu screen...');
    showMenu();

    // In standalone mode (including Poki iframe), load game world immediately
    if (isStandaloneMode) {
        console.log('🎮 Standalone mode: loading game world...');
        if (isPlaytestMode) {
            // Started before the load so a world that fails to load is reported too.
            import('engine/playtest/PlaytestProbe.js').then(({ runPlaytestProbe }) =>
                runPlaytestProbe(() => gameEngine)
            ).catch(error => {
                console.error('Play test probe failed:', error);
            });
        }
        loadGameFromWorkDirectory(false).then(() => {
            // Disable controls until Play is clicked
            if (gameEngine) {
                const playerController = gameEngine.getPlayerController();
                if (playerController && 'setControlsEnabled' in playerController) {
                    (playerController as any).setControlsEnabled(false);
                    console.log('🎮 Player controls disabled - waiting for Play button');
                }
            }
            // ?autostart=1 (portal instant play): skip the StartScreen once the world is
            // loaded + warmed. Desktop only — mobile keeps the StartScreen tap because
            // fullscreen needs a user gesture inside this frame (prepareGameplayStart).
            // Pointer lock may still need a first click on the canvas; that degrades
            // softly, unlike a denied fullscreen which would bounce back to the menu.
            // A play test has no one to tap, and never goes fullscreen anyway.
            if (isAutostartRequested && (!isMobileRuntime() || isPlaytestMode)) {
                console.log('🎮 Autostart requested: entering gameplay without StartScreen');
                handleGameStart().catch(error => {
                    console.error('Autostart failed (menu stays up):', error);
                });
            }
        }).catch(error => {
            console.error('Failed to load game in standalone mode:', error);
        });
    } else {
        // In creator mode, register the creator<->game message listener (kept out of
        // standalone bundles via the publish stub), then notify the parent we're ready.
        console.log('📱 Running in creator mode, notifying parent...');
        registerCreatorMessageListener(createCreatorMessageContext());
        safePostMessage({ type: 'GAME_TEMPLATE_READY' });

        // Initialize console capture for debugging in creator mode
        import('engine/ConsoleCapture.js').then(({ ConsoleCapture }) => {
            console.log('🔧 Console capture starting...');
            ConsoleCapture.getInstance().start();
            import('engine/RuntimeErrorForwarder.js').then(({ startRuntimeErrorForwarding }) => {
                startRuntimeErrorForwarding();
            });
            import('engine/ConsolePanel.js').then(({ ConsolePanel }) => {
                console.log('🔧 Console panel created');
                new ConsolePanel();
            });
        });
    }
}

/**
 * Lock screen orientation on published mobile games based on world.json config.
 * Best-effort — not all browsers support screen.orientation.lock() (iOS Safari doesn't).
 * Only runs in standalone mode on mobile devices.
 */
function lockMobileOrientation(): void {
    if (!isStandaloneMode) return;
    const orientation = currentGameData?.worldProfileData?.mobileOrientation;
    if (!orientation) return;
    // Only on mobile/tablet devices
    if (!isMobileRuntime()) return;
    try {
        const lockType = orientation === 'portrait' ? 'portrait-primary' : 'landscape-primary';
        const orientationApi = screen.orientation as ScreenOrientation & { lock?: (type: string) => Promise<void> };
        if (orientationApi.lock) {
            orientationApi.lock(lockType).catch(() => { /* unsupported or not in fullscreen */ });
        }
    } catch {
        // screen.orientation.lock not available
    }
}

/**
 * Parity check: every desktop custom key must have a mobile button.
 * If gaps are found, post a structured message so the creator iframe
 * can surface a warning banner to the user. Called from both the
 * Play-click path and the standalone work-directory load path.
 */
function runMobileParityCheck(playerController: unknown): void {
    if (playerController && typeof playerController === 'object' && 'verifyMobileParity' in playerController) {
        const parity = (playerController as { verifyMobileParity: () => MobileParityResult }).verifyMobileParity();
        if (!parity.ok) {
            window.postMessage(
                { type: 'aitopia:mobile-parity-gap', payload: parity },
                window.location.origin,
            );
        }
    }
}

/**
 * Handle game start — called by Play button click or programmatically via engine.startGame().
 * Fires analytics, transitions to PLAYING state, enables controls, pointer lock, etc.
 */
async function handleGameStart(): Promise<void> {
    console.log('🎮 Starting game...');

    try {
        const gameplayStarted = await runtimeController.prepareGameplayStart();
        if (!gameplayStarted) {
            runtimeController.showMenu();
            inGameNotification?.show('Tap Play to enter fullscreen before gameplay starts.', 3000);
            return;
        }

        // Retry orientation lock — some browsers require user activation
        lockMobileOrientation();

        // Track analytics event only after the start interaction is accepted.
        // A hidden play test is not a player pressing Play.
        if (!isPlaytestMode) {
            const analytics = getAnalytics();
            const gameGenre = currentGameData?.gameGenre;
            const gameTitle = currentGameData?.gameName;
            analytics.trackPlayButtonClick(gameGenre, currentGameId || undefined, gameTitle);
        }

        // Check if game is already loaded (from LOAD_GAME message)
        if (gameEngine && currentGameId && currentGameData) {
            // Enable player controls (if player exists)
            const playerController = gameEngine.getPlayerController();
            if (playerController && 'setControlsEnabled' in playerController) {
                (playerController as unknown as { setControlsEnabled: (enabled: boolean) => void }).setControlsEnabled(true);
                console.log('🎮 Player controls enabled');
            }

            runMobileParityCheck(playerController);

            runtimeController.enterPlayingMode();
        } else {
            // Game not loaded yet - load from work directory (standalone mode)
            console.log('📁 Loading game from work directory...');
            await loadGameFromWorkDirectory(false); // Don't auto-set playing state

            // Enable player controls (if player exists)
            if (gameEngine) {
                const playerController = gameEngine.getPlayerController();
                if (playerController && 'setControlsEnabled' in playerController) {
                    (playerController as unknown as { setControlsEnabled: (enabled: boolean) => void }).setControlsEnabled(true);
                    console.log('🎮 Player controls enabled');
                }

                runMobileParityCheck(playerController);

                runtimeController.enterPlayingMode();
            }
        }
    } catch (error) {
        console.error('Failed to start game:', error);
        runtimeController.showMenu();
        alert(`Failed to start game: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function showMenu(): void {
    runtimeController.showMenu();
    console.log('📺 Menu displayed');
}

async function loadGameFromWorkDirectory(setPlayingState: boolean = true): Promise<void> {
    try {
        console.log('🔄 Loading game data from work directory...');

        // Try to get game ID from meta tag (CLI/pro publishes use the bm: prefix)
        const gameIdMeta = document.querySelector('meta[name="game-id"], meta[name="bm:game-id"]');
        let gameId: string;

        if (gameIdMeta) {
            gameId = gameIdMeta.getAttribute('content') || '';
            if (!gameId) {
                throw new Error('Game ID meta tag is empty. This game may not be properly published.');
            }
            // Published clients: scope multiplayer rooms by publish version so different versions don't mix.
            // Store the versioned ID on window.__multiplayerGameId (same mechanism the editor uses)
            // so NetworkManager picks it up, but keep gameId clean for analytics and other systems.
            if (!isCreatorMode) {
                const publishVersionMeta = document.querySelector('meta[name="publish-version"], meta[name="bm:publish-version"]');
                const publishVersion = publishVersionMeta?.getAttribute('content');
                if (publishVersion && publishVersion !== '-1') {
                    (window as any).__multiplayerGameId = `${gameId}-v${publishVersion}`;
                }
            }
            console.log(`📊 Using game ID from meta tag: ${gameId}`);
        } else {
            // No meta tag — this is a development build (work directory)
            gameId = 'work-dev-game';
            console.log(`📊 No meta tag found, using development game ID: ${gameId}`);
        }

        let gameData: GameData;

        // Use utility function that tries bundle loader first, then fetch
        console.log('📄 Loading world data from JSON...');
        getLoadProgress().beginPhase('data', t('game.loading.data'));
        const { loadWorldData } = await import('../utils/worldDataLoader.js');
        gameData = await loadWorldData();

        console.log('✅ Successfully loaded work directory game data from preprocessed module');
        console.log('🔍 Final gameData.characterUrl:', gameData.characterUrl);
        await loadGame(gameId, gameData, setPlayingState);
        // Standalone: the creator handler is a stub and this is a no-op. Kept
        // so every load initiator drains the queue the same way.
        await flushPendingToolMessages();

    } catch (error) {
        console.error('Failed to load game from work directory:', error);
        throw new Error(`Cannot load game from work directory: ${error instanceof Error ? error.message : String(error)}`);
    }
}

async function loadGame(gameId: string, gameData: GameData, setPlayingState: boolean = true): Promise<void> {
    activeGameLoads++;
    try {
        console.log(`🎯 Loading game in template: ${gameId}`, { gameData });

        // Progress bar lifecycle: a RELOAD restarts the bar from 0 (reset is the
        // only allowed regression); the first boot keeps the fractions already
        // accumulated by the boot/data phases. The creator LOAD_GAME path enters
        // here with data in hand, so 'data' completes immediately either way.
        const loadProgress = getLoadProgress();
        if (currentGameId) {
            loadProgress.reset();
        }
        loadProgress.beginPhase('data', t('game.loading.data'));

        // Add gameId to gameData so it's accessible to all systems
        (gameData as any).gameId = gameId;

        // Store current game state for potential reloads
        currentGameId = gameId;
        currentGameData = gameData;
        runtimeController.setCurrentGame(gameId, gameData);

        // Track creation prompt submitted event as soon as game data is received
        const analytics = getAnalytics();
        analytics.trackCreationPromptSubmitted(gameId);

        // Apply HUD theme tokens to documentElement BEFORE the StartScreen DOM
        // is built so its CSS custom properties resolve to the game's theme on
        // the very first paint. Without this, StartScreen renders with default
        // fallback fonts/colors and then re-paints when GameEngine.loadGame()
        // calls setTheme() further down — the visible "style flash" on load.
        // resolveWorldTheme returns DEFAULT_HUD_THEME for missing/invalid input.
        applyThemeGlobals(resolveWorldTheme(gameData.worldProfileData?.hud?.theme));

        // The menu's progress bar mirrors LoadProgress on its own — no manual
        // updateLoadingMessage calls needed on this path anymore.
        const activeMenuUI = runtimeController.resetForLoad(!setPlayingState);

        // ── Pre-play level selection (hud.startScreen.selections) ─────────
        // Presented BEFORE the world loads — the pick decides what to load.
        // Auto-skipping flows (editor preview / no menu, ?autostart=1) and
        // reloads with a remembered pick boot without asking; 'choice' steps
        // are presented AFTER the load, right before the Play button.
        const selections = resolveStartScreenSelections(gameData);
        let bootLevelId: string | undefined;
        if (selections.levelStep) {
            const step = selections.levelStep;
            const remembered = rememberedPickFor(gameId, step);
            // A ?track= deep link already chose the level — don't ask again.
            // Routed through the same bootLevelId override so the legacy
            // mirror fields follow the link (resolveLevels alone only moves
            // the registry's start level, not what frozen boot code reads).
            const trackId = getLaunchParams().trackLevelId;
            if (trackId !== null && resolveLevels(gameData)?.byId.has(trackId)) {
                bootLevelId = trackId;
            } else if (remembered) {
                bootLevelId = remembered;
            } else if (activeMenuUI && !isAutostartRequested) {
                const picked = await activeMenuUI.presentSelection(step);
                if (picked === null) {
                    // This StartScreen was disposed mid-pick — a newer load owns
                    // the screen now, so this whole flow is obsolete.
                    console.log('🧭 Level selection superseded by a newer load — aborting this flow');
                    return;
                }
                bootLevelId = picked.optionId;
                // Only a REAL tap is the player's session pick. A fallback
                // resolution (force-start, editor-tab cancel) boots the default
                // but leaves the chooser available on the next menu-ful load.
                if (picked.userPicked) {
                    rememberSelection(gameId, step.id, bootLevelId);
                }
            } else {
                // Skipping flow: boot the configured start level (the default).
                // Not remembered — a menu-less load must not suppress the
                // chooser for later menu-ful loads of the same game.
                bootLevelId = resolveLevels(gameData)?.startLevel.id;
            }
        }

        // Note: Playing state is set by Play button, not here
        // setPlayingState parameter is kept for backward compatibility but doesn't set state anymore

        // Dispose existing game engine
        if (gameEngine) {
            gameEngine.dispose();
        }

        // Initialize new game engine
        gameEngine = new GameEngine(document.getElementById('game-container') as HTMLDivElement);

        // Passive event session for external observers (bitmagic verify).
        // Before the loadGame await, so load-time events are captured rather
        // than raced. Clock: gameplay-time pseudo-frames (~60/s, frame 0
        // through menu/load) — see the GameEventLog header. A repeat loadGame
        // simply re-takes its own session with a provider bound to the new
        // engine (last starter wins).
        if (isEventLogRequested) {
            const engineForClock = gameEngine;
            getGameEventLog().startSession(
                () => Math.round(engineForClock.getElapsedTime() * 60),
                'eventlog',
            );
        }

        runtimeController.attachEngine(gameEngine, () => {
            void handleGameStart();
        });

        // Set free mouse mode BEFORE loading so templates that call startGame()
        // during load() already have the correct pointer lock behavior
        const pointerLockManager = runtimeController.getPointerLockManager();
        if (pointerLockManager && gameData.worldProfileData?.useFreeMouse) {
            pointerLockManager.setFreeMouseMode(true);
        }

        await gameEngine.loadGame(gameId, gameData, bootLevelId !== undefined ? { bootLevelId } : undefined);

        // Everything awaited by loadGame (world, assets, GPU warmup) is done —
        // pin the bar at 100% before the indicator is swapped for Play.
        loadProgress.complete();

        // Seed getPreGameSelections(): the level pick plus each choice step's
        // remembered pick or default. The interactive choice flow (kicked off
        // below) overwrites defaults with real picks before Play is shown, and
        // auto-skipping flows simply keep these values.
        if (selections.levelStep && bootLevelId !== undefined) {
            gameEngine.setPreGameSelection(selections.levelStep.id, bootLevelId);
        }
        for (const step of selections.choiceSteps) {
            gameEngine.setPreGameSelection(step.id, rememberedPickFor(gameId, step) ?? defaultPick(step));
        }

        // Hide loading indicator and show Play button after game is fully loaded
        // For Gaussian splat games, splats are loaded synchronously via await in loadGame
        // so by this point everything should be ready
        if (activeMenuUI) {
            console.log('✅ Game loaded, hiding loading indicator and showing Play button');
            activeMenuUI.hideLoadingIndicator();
        }

        // Disable player controls if menu is still visible (waiting for Play button)
        // Only if menu is actually visible (not skipped in editor mode), and never
        // when the template already started gameplay from inside its own load() —
        // that game is running, and this would take its controls away.
        if (!setPlayingState && !runtimeController.hasGameplayStartedThisLoad() && runtimeController.getStartScreen()) {
            const playerController = gameEngine.getPlayerController();
            if (playerController && 'setControlsEnabled' in playerController) {
                (playerController as any).setControlsEnabled(false);
                console.log('🎮 Player controls disabled - waiting for Play button');
            }
        }

        // Both steps below are for a game still waiting on Play, so both are
        // skipped when the template started gameplay from inside its own load():
        // finishLoadWaitingForStart() self-guards, and presenting choice steps
        // would pop a difficulty/character picker over a running game.
        if (!setPlayingState && !runtimeController.hasGameplayStartedThisLoad()) {
            runtimeController.finishLoadWaitingForStart();
            // Post-load 'choice' steps (difficulty, character, …) — presented
            // one at a time where the Play button will appear. Deliberately
            // NOT awaited: GAME_LOADED (below) must post as soon as the game
            // is loaded — the creator treats it as the end-of-load signal and
            // must never wait on a player's menu picks.
            void presentChoiceSelections(gameEngine, activeMenuUI, selections.choiceSteps, gameId);
        }

        // Update Debug Info via EditorManager (now available after game engine is created)
        const gameName = gameData.gameName ?? 'Unknown';
        if (gameEngine && gameEngine.editorManager) {
            gameEngine.editorManager.updateGameName(gameName);
            // Capture initial checksums for world modification detection — only in
            // creator/editor mode. Standalone/published builds never compare against
            // these baselines, so computing them is pure waste (was ~25s for a
            // 1920×1920 flat world before the RLE-checksum optimization, ~20ms after).
            if (isCreatorMode) {
                gameEngine.editorManager.captureInitialChecksums();
            }
        }

        // Sync free mouse mode to HUD (hides ESC hint when pointer lock is disabled)
        // This covers both world.json useFreeMouse and template-set freeMouseMode
        if (pointerLockManager && pointerLockManager.getFreeMouseMode() && gameEngine.genreModule) {
            gameEngine.genreModule.hud?.setFreeMouseMode?.(true);
        }

        // Wire up HUD interactive element system to PointerLockManager
        // When interactive UI elements (like "Play Again" button) are shown, the mouse is unlocked
        // When all interactive elements are hidden, the mouse is locked again
        if (pointerLockManager && gameEngine.genreModule) {
            const hud = gameEngine.genreModule?.hud;
            if (hud) {
                const plm = pointerLockManager; // Capture reference for callback closure
                hud.setMouseUnlockCallback((needsUnlock: boolean) => {
                    if (needsUnlock) {
                        // Interactive UI mode first, so no prompt flashes as the lock is released
                        plm.setInteractiveUIMode(true);
                        plm.exitLock();
                        return;
                    }
                    // The click that dismissed the UI (a "Play Again" button) can take the cursor
                    // straight back; the click prompt only shows if the browser refuses.
                    plm.requestLockWithRetry();
                    plm.setInteractiveUIMode(false);
                });
            }
        }

        // Note: useFreeMouse is set before loadGame() so it's active during template load()

        // Notify parent that game loaded successfully
        safePostMessage({
            type: 'GAME_LOADED',
            data: { gameId }
        });

        // Lock screen orientation on published mobile games
        lockMobileOrientation();

        // Tool messages queued during the load are NOT flushed here: the
        // caller still has post-load work (the LOAD_GAME handler applies the
        // editor tab / camera), and a queued EDIT_VOXEL_ASSET must open its
        // session after that, not under it. Each caller flushes when done.

        // Controls are shown by Play button click handler, not here

    } catch (error) {
        console.error('Failed to load game in template:', error);
        runtimeController.showMenu();
        const errorMessage = error instanceof Error ? error.message : String(error);
        safePostMessage({
            type: 'GAME_LOAD_ERROR',
            data: { error: errorMessage }
        });
    } finally {
        activeGameLoads--;
    }
}

/**
 * Present the post-load 'choice' selection steps sequentially on the start
 * card (the Play button stays hidden until the last one resolves). Runs
 * fire-and-forget after GAME_LOADED; skipped entirely — keeping the defaults
 * seeded in loadGame() — when there is no menu, an external lobby owns the
 * pre-start UI, autostart is requested, or every step has a remembered pick.
 */
async function presentChoiceSelections(
    engine: GameEngine,
    menuUI: StartScreen | null,
    steps: SelectionStepSpec[],
    gameId: string,
): Promise<void> {
    if (!menuUI || steps.length === 0 || isAutostartRequested) {
        return;
    }
    if (runtimeController.getStartupUiMode() === 'external') {
        return;
    }
    try {
        for (const step of steps) {
            if (rememberedPickFor(gameId, step)) {
                continue; // already picked this session (seeded in loadGame)
            }
            const picked = await menuUI.presentSelection(step);
            if (picked === null) {
                return; // superseded by a newer load / UI override
            }
            engine.setPreGameSelection(step.id, picked.optionId);
            if (!picked.userPicked) {
                // The flow was interrupted (force-start / editor cancel):
                // remaining steps keep their seeded defaults, and nothing is
                // remembered — presenting more cards now would paint over
                // whatever took the screen.
                return;
            }
            rememberSelection(gameId, step.id, picked.optionId);
        }
    } catch (error) {
        // Selections must never block the Play button; defaults are already set.
        console.error('Failed to present pre-play selections:', error);
    }
}

async function reloadCurrentGame(): Promise<void> {
    console.log('Reload requested - game state:', {
        currentGameId: currentGameId,
        hasCurrentGameData: !!currentGameData
    });

    if (!currentGameId || !currentGameData) {
        console.warn('No current game to reload - game may not be fully initialized yet');
        // Don't send error message - just silently ignore if no game is loaded
        // This can happen during initial load or if reload happens too early
        return;
    }

    console.log(`Reloading current game: ${currentGameId}`);

    // Notify parent that reload is starting
    safePostMessage({
        type: 'GAME_RELOADING',
        data: { gameId: currentGameId }
    });

    // Remember the editor viewpoint. A reload triggered by background work (a finished
    // high-quality asset) would otherwise dump the user back at the default view, which on
    // a large level means flying back to whatever they were working on.
    saveEditorView(currentGameId, gameEngine?.camera ?? null);

    try {
        // Fetch fresh game data from game.json and world.json
        // This ensures we get the latest data after edits or publish
        const { loadWorldData } = await import('../utils/worldDataLoader.js');
        const freshGameData = await loadWorldData();
        console.log('✅ Fetched fresh game data for reload');

        // Reload with fresh data (don't set playing state - Play button controls that)
        await loadGame(currentGameId, freshGameData, false);

        // Put the editor camera back where it was. Must happen after the level exists and
        // before the editor's debug camera activates — it derives its orbit from the
        // camera's transform at activation (see EditorViewMemory).
        restoreEditorView(currentGameId, gameEngine?.camera ?? null);

        // Notify parent that reload completed
        safePostMessage({
            type: 'GAME_RELOADED',
            data: { gameId: currentGameId }
        });

    } catch (error) {
        console.error('Failed to reload game:', error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        safePostMessage({
            type: 'GAME_LOAD_ERROR',
            data: { error: errorMessage }
        });
    }

    // Creator tool messages that arrived mid-reload were queued; run them now
    // that the world is back (no-op in standalone, where the creator handler
    // is stubbed out of the bundle).
    await flushPendingToolMessages();
}

function disposeGame(): void {
    // Owner-gated: cannot touch an F9 recorder session. The beforeunload path
    // below needs no equivalent — that is a navigation, nothing reads after it.
    if (isEventLogRequested) {
        getGameEventLog().endSession('eventlog');
    }
    if (gameEngine) {
        gameEngine.dispose();
        gameEngine = null;
    }

    // Clear current game state
    currentGameId = null;
    currentGameData = null;
    runtimeController.setCurrentGame(null, null);

    // Notify parent that game was disposed
    safePostMessage({
        type: 'GAME_DISPOSED'
    });
}


// Dispose game engine when iframe navigates away (e.g., creator hot-reload).
// Without this, each iframe reload leaks WebGL textures, buffers, and GPU memory
// because Three.js resources require explicit disposal — GC alone won't reclaim them.
window.addEventListener('beforeunload', () => {
    if (gameEngine) {
        gameEngine.dispose();
        gameEngine = null;
    }
});

// Export functions for debugging
(window as any).gameTemplate = {
    loadGame,
    disposeGame,
    getGameEngine: () => gameEngine
};

// The read-only debug surface external observers (bitmagic verify) query.
// Installed module-level so it answers — with empties — even while a game is
// still loading, or never loads at all.
installBmDebug();
