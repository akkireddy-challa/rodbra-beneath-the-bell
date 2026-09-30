import { GameState, GameStateManager, type PauseReason, setGameStateManager } from 'engine/GameStateManager.js';
import { t } from 'engine/i18n/index.js';
import { PauseButton } from 'engine/ui/PauseButton.js';
import { isPauseButtonShown } from 'engine/ui/pauseButtonPolicy.js';
import { StartScreen, type StartScreenOptions } from 'engine/ui/StartScreen.js';
import { getScreenOverlayLayer } from 'engine/ui/screenOverlayLayer.js';
import { PauseScreen } from 'engine/ui/PauseScreen.js';
import { DEFAULT_SCREEN_TRANSITION, setScreenTransition } from 'engine/ui/modalCard.js';
import { PointerLockManager } from 'engine/PointerLockManager.js';
import { isMobileRuntime } from 'engine/isMobileRuntime.js';
import type { GameEngine } from 'engine/GameEngine.js';
import type { GameData, PlayerControllerLike, StartupUiMode, WorldProfileData } from 'types/game.js';
import { PokiIntegration } from 'engine/PokiIntegration.js';
import { handoffBootShell } from 'engine/progress/LoadProgress.js';

type PostMessageFn = (message: Record<string, unknown>) => void;
type StartRequestHandler = () => void;

/**
 * How a pointer-locked game gets its cursor back on resume. Only a click inside the iframe
 * may request the lock; a button in the parent frame grants no user activation, so before
 * the first lock that resume shows the "Click to play" start prompt instead.
 */
type LockRegain = 'click' | 'overlay';

/**
 * The camera-controller members this file drives. Not part of `PlayerControllerLike` —
 * only some controllers own a camera — so each call stays optional.
 */
interface RuntimeCameraController {
    setEditorModeCamera?(enabled: boolean): void;
    setPointerLocked?(locked: boolean): void;
}

export class GameRuntimeController {
    private container: HTMLElement;
    private postMessage: PostMessageFn;
    private gameStateManager: GameStateManager;
    private pokiIntegration: PokiIntegration;
    private menuUI: StartScreen | null = null;
    private pauseScreen: PauseScreen | null = null;
    /** Touch-only pause entry point; null on desktop, where Escape already works. */
    private pauseButton: PauseButton | null = null;
    private escapeKeyHandler: ((event: KeyboardEvent) => void) | null = null;
    private pointerLockManager: PointerLockManager | null = null;
    /** True while this controller holds the 'pointer-lock' pause reason. */
    private pausedForPointerLock = false;
    /**
     * Has the cursor been locked since this playing session started? Until it has, a missing
     * lock gets the "Click to play" start prompt; afterwards it gets the pause card.
     */
    private hasHeldLockThisLoad = false;
    private gameEngine: GameEngine | null = null;
    private currentGameId: string | null = null;
    private currentGameData: unknown = null;
    private startupUiMode: StartupUiMode = 'engine';
    /**
     * Did gameplay start during the CURRENT load? Set by enterPlayingMode(),
     * cleared by resetForLoad(). See finishLoadWaitingForStart() for why the
     * engine has to know this, and why `gameStateManager.hasStarted()` cannot
     * answer it (that flag is never reset, so it stays true across the
     * Creator's in-page LOAD_GAME reloads).
     */
    private gameplayStartedThisLoad = false;

    constructor(container: HTMLElement, postMessage: PostMessageFn) {
        this.container = container;
        this.postMessage = postMessage;
        // Runs on each PLAYING transition, after pokiIntegration is assigned just below.
        this.gameStateManager = new GameStateManager(GameState.MENU, (resume) => this.pokiIntegration.beforePlaying(resume));
        setGameStateManager(this.gameStateManager);
        this.pokiIntegration = new PokiIntegration();
        this.pokiIntegration.setCameraGetter(() => this.gameEngine?.camera ?? null);
        this.pokiIntegration.init();
        this.gameStateManager.addListener(this.pokiIntegration.createStateListener());
    }

    getStateManager(): GameStateManager {
        return this.gameStateManager;
    }

    getStartScreen(): StartScreen | null {
        return this.menuUI;
    }

    getPointerLockManager(): PointerLockManager | null {
        return this.pointerLockManager;
    }

    /** Current pre-start UI owner ('external' = an in-iframe lobby replaces the engine menu). */
    getStartupUiMode(): StartupUiMode {
        return this.startupUiMode;
    }

    setCurrentGame(gameId: string | null, gameData: unknown): void {
        this.currentGameId = gameId;
        this.currentGameData = gameData;
    }

    setCurrentTab(tab: string | null): void {
        this.gameStateManager.setCurrentTab(tab);
    }

    attachEngine(engine: GameEngine, onStartRequested: StartRequestHandler): void {
        this.gameEngine = engine;
        engine.gameStateManager = this.gameStateManager;

        const pointerLockManager = this.ensurePointerLockManager();
        engine.setPointerLockManager(pointerLockManager);
        engine.setStartGameHandler(onStartRequested);
        engine.setPlayButtonVisibilityHandler((visible) => {
            this.menuUI?.setPlayButtonVisible(visible);
        });
        engine.setStartupUiModeHandler((mode) => {
            this.setStartupUiMode(mode);
        });
        engine.setUIComponentChangeHandler((slot) => {
            this.onUISlotChanged(slot);
        });

        this.ensurePauseScreen();
        this.ensureEscapeKeyHandler();
        this.ensurePauseButton();
        this.announceQualityChanges(engine);
    }

    /**
     * Tell the player, once, when the engine lowered the graphics by itself.
     *
     * A game that silently looks worse reads as a broken game rather than a deliberate
     * rescue — the reasoning `LevelDetail.applyPendingDowngrade` was already written around,
     * which is why it returns the new tier at all. Once per session on purpose: a second
     * automatic change updates the pause menu's label silently, because a game that keeps
     * announcing its own degradation reads worse than one that quietly settles.
     */
    private announceQualityChanges(engine: GameEngine): void {
        engine.quality.onTierChanged((tier, reason) => {
            const hud = this.gameEngine?.genreModule?.hud;
            if (!hud) return;
            const name = t(`game.quality.${tier}`);
            hud.showToast(
                t(reason === 'crash' ? 'game.quality.loweredCrash' : 'game.quality.loweredMeasure', { tier: name }),
                { variant: 'warning', duration: 5000, anchor: 'top-center' },
            );
        });
    }

    /**
     * Called by `GameEngine.setUIComponent`. When a genre or per-game file
     * installs a custom start/pause override, dispose the corresponding
     * default so we don't have two implementations fighting for the same
     * state and DOM space. Clearing an override (`setUIComponent(slot, null)`)
     * does NOT auto-restore the default — the next `resetForLoad` will
     * recreate it.
     */
    private onUISlotChanged(slot: 'start' | 'pause' | 'end'): void {
        if (!this.gameEngine) return;
        const override = this.gameEngine.getUIComponent(slot);
        if (!override) return;

        if (slot === 'start' && this.menuUI) {
            this.menuUI.dispose();
            this.menuUI = null;
        } else if (slot === 'pause' && this.pauseScreen) {
            this.pauseScreen.dispose();
            this.pauseScreen = null;
        }
        // 'end' has no long-lived default to dispose — endGame() picks the
        // override vs. default on each call.
    }

    resetForLoad(showStartMenu: boolean): StartScreen | null {
        this.startupUiMode = 'engine';
        // A fresh load has not started gameplay yet, whatever the previous one did.
        this.gameplayStartedThisLoad = false;
        this.transitionToLoading();

        // Every load path converges here with game data in hand — the engine UI
        // (StartScreen progress bar, or the raw canvas in editor preview) takes
        // over the screen, so retire the static index.html boot shell.
        handoffBootShell();

        // Drop UI slot overrides from the previous game so the new game gets
        // a clean engine default unless its genre installs its own override.
        this.gameEngine?.setUIComponent('start', null);
        this.gameEngine?.setUIComponent('pause', null);
        this.gameEngine?.setUIComponent('end', null);
        // Same for the screen transition a previous game may have set.
        setScreenTransition(DEFAULT_SCREEN_TRANSITION);

        if (this.menuUI) {
            this.menuUI.dispose();
            this.menuUI = null;
        }

        // The pause button lives in the genre's HUD, and every load builds a new genre
        // module with a new HUD — so the old button's host is about to disappear. Drop it
        // here or `ensurePauseButton` early-returns on a live-looking object bound to a
        // dead HUD, and the phone silently loses its only way into the pause card. Also
        // what lets the next game answer `hud.pauseButton` differently.
        this.pauseButton?.dispose();
        this.pauseButton = null;

        this.gameStateManager.clearListeners();
        this.gameStateManager.addListener(this.pokiIntegration.createStateListener());
        // Recreate the default PauseScreen if a previous game's override
        // disposed it (idempotent — early-returns when already present).
        this.ensurePauseScreen();
        this.pauseScreen?.attachListener();

        if (!showStartMenu) {
            return null;
        }

        const menuUI = this.ensureStartScreen();
        // Label + bar fraction come from the LoadProgress subscription; this
        // only makes the indicator visible.
        menuUI?.showLoadingIndicator();
        return menuUI;
    }

    /**
     * End of the load sequence: park the session in READY, waiting for the
     * player's Play.
     *
     * NOT when the template already started gameplay itself. A template may
     * call `engine.startGame()` from inside its own `load()` — a retry /
     * restart reload that has to resume mid-level does exactly that — and the
     * engine's load sequence keeps running for a long time afterwards
     * (`preloadLevel()` alone GPU-warms the whole scene, seconds on a phone).
     * Parking the session here would then silently UN-START a running game:
     * the state machine leaves PLAYING, every gameplay system gated on it
     * freezes, and no start card is shown to recover with — a level that
     * renders and takes input but never runs. Templates cannot see this call
     * coming, so the guard belongs here rather than in each of them.
     */
    finishLoadWaitingForStart(): void {
        if (this.gameplayStartedThisLoad) return;
        this.transitionToReadyMenu();
    }

    /**
     * True when the template started gameplay from inside its own `load()`, so
     * the post-load steps that only make sense for a game still waiting on Play
     * (disabling player controls, presenting start-card choice steps) can be
     * skipped. Reset at the start of every load.
     */
    hasGameplayStartedThisLoad(): boolean {
        return this.gameplayStartedThisLoad;
    }

    showMenu(): void {
        const isLoadedAndWaitingForStart = !!(this.currentGameId && this.currentGameData && this.gameEngine && !this.gameStateManager.hasStarted());

        if (isLoadedAndWaitingForStart) {
            this.transitionToReadyMenu();
        } else {
            this.transitionToMenu();
        }

        this.pointerLockManager?.hideOverlay();

        const menuUI = this.ensureStartScreen();
        if (isLoadedAndWaitingForStart) {
            menuUI?.hideLoadingIndicator();
        }
    }

    showEditorPreview(): void {
        // The editor is taking the screen: a pending selection step must not
        // park its awaiting load flow behind a hidden menu — resolve it with
        // the default (not remembered; the chooser returns on the next
        // menu-ful load).
        this.menuUI?.cancelActiveSelection();
        this.gameStateManager.transitionToReady('editor-preview');
        this.postCurrentGameState();
    }

    /**
     * Gameplay must not run behind the "Click to play" start prompt. A refused first lock right
     * after Play used to leave the simulation running unseen — NPCs kept attacking a player
     * who could not see or move. Pause with its own reason while the prompt is up; resume the
     * moment the lock lands. Every later loss of the lock never reaches the prompt:
     * `claimClickPrompt` turns it into the pause card.
     */
    private syncPointerLockPause(isLocked: boolean): void {
        const plm = this.pointerLockManager;
        if (!plm || !plm.getIsSupported()) return;
        if (isLocked) {
            this.hasHeldLockThisLoad = true;
            if (this.pausedForPointerLock) {
                this.pausedForPointerLock = false;
                this.setGameplayPaused(false, 'pointer-lock');
            }
            return;
        }
        if (plm.isOverlayVisible() && this.gameStateManager.getCurrentState() === GameState.PLAYING) {
            this.pausedForPointerLock = true;
            this.setGameplayPaused(true, 'pointer-lock');
        }
    }

    /**
     * PointerLockManager asks this before it shows "Click to play". That prompt is for the
     * start only: until the first lock lands the player has not begun, and "Paused" would be
     * the wrong word. After that, every moment the game needs a click to take the cursor back
     * lands on the pause card, and its Resume click is the click the browser wants: ESC
     * (the browser spends the press on the cursor, so the page never sees the key), alt-tab,
     * a refused re-lock, a game dialog closing.
     */
    private claimClickPrompt(): boolean {
        if (!this.hasHeldLockThisLoad || !this.gameStateManager.hasStarted()) return false;
        const state = this.gameStateManager.getCurrentState();
        if (state !== GameState.PLAYING && state !== GameState.PAUSED) return false;
        this.openPauseCard();
        return true;
    }

    setGameplayPaused(paused: boolean, reason: PauseReason): void {
        const previousState = this.gameStateManager.getCurrentState();
        this.gameStateManager.setPaused(paused, reason);

        if (this.gameEngine?.editorManager) {
            this.gameEngine.editorManager.setPaused(paused);
        }

        if (this.gameStateManager.getCurrentState() !== previousState) {
            this.postCurrentGameState();
        }
    }

    async prepareGameplayStart(): Promise<boolean> {
        const fullscreenReady = await this.requestFullscreenForGameplay();
        if (!fullscreenReady) {
            this.showMenu();
            return false;
        }

        return true;
    }

    enterPlayingMode(): void {
        // Remember this for the rest of the load, so the load sequence's tail
        // does not park or de-control a game that is already running.
        this.gameplayStartedThisLoad = true;
        // A new playing session begins with the start prompt, not the pause card.
        this.hasHeldLockThisLoad = false;
        // Safety net for paths that skip resetForLoad — the shell must never
        // cover live gameplay. Idempotent no-op when already handed off.
        handoffBootShell();
        this.setStartupUiMode('engine');
        // The genre's HUD exists by now, which it does not at attachEngine time on a first
        // load — so this is where the touch pause button actually gets created.
        this.ensurePauseButton();
        this.gameStateManager.markPlaying();
        this.postCurrentGameState();
        this.gameEngine?.editorManager?.setPaused(false);

        if (this.pointerLockManager && this.pointerLockManager.getIsSupported() && !this.pointerLockManager.getFreeMouseMode()) {
            if (this.hasActiveUserGesture()) {
                this.pointerLockManager.requestLock();
            } else {
                // Starting gameplay from a parent-frame button does not grant the iframe
                // transient activation for Pointer Lock. Enter playing mode and show the
                // standard overlay so the next click inside the iframe can acquire lock.
                this.pointerLockManager.showOverlay();
            }
        } else {
            this.gameEngine?.genreModule?.hud?.setGameplayUIVisible(true);
        }

        // Show the controls overlay once per new playing session — fades in, auto-hides
        // after 15s, H key toggles. The HUD itself early-exits on mobile / when the
        // controls guide is disabled / when the user manually hid them.
        this.gameEngine?.genreModule?.hud?.showControlsTemporarily();

        window.focus();
    }

    applyEditorTabMode(tab: string | null): void {
        if (!this.gameEngine?.editorManager) {
            return;
        }

        // Nothing below means anything without a player to re-aim and re-control.
        if (!this.gameEngine.getPlayerController()) {
            return;
        }

        const isGamePlaying = this.gameStateManager.isState(GameState.PLAYING);
        const pointerLockManager = this.pointerLockManager;

        if (tab === 'prompt') {
            this.gameEngine.editorManager.disableFreeCamera();

            if (pointerLockManager) {
                pointerLockManager.setEditorMode(false);
                if (isGamePlaying && !pointerLockManager.getIsLocked()) {
                    pointerLockManager.showOverlay();
                }
            }

            this.getCameraController()?.setEditorModeCamera?.(false);

            if (!isGamePlaying && !this.gameStateManager.hasStarted()) {
                this.showMenu();
                this.menuUI?.hideLoadingIndicator();
            }

            this.setPlayerControlsEnabled(isGamePlaying);
            return;
        }

        if (!tab) {
            return;
        }

        if (!this.gameStateManager.hasStarted()) {
            this.showEditorPreview();
        }

        this.gameEngine.editorManager.enableFreeCamera();

        if (pointerLockManager) {
            pointerLockManager.setEditorMode(true);
        }

        this.getCameraController()?.setEditorModeCamera?.(true);

        this.menuUI?.hide();
        this.setPlayerControlsEnabled(false);
    }

    canSwitchToEditorTab(tab: string | null): boolean {
        const editorManager = this.gameEngine?.editorManager;
        if (!editorManager) {
            return true;
        }

        if (tab !== 'voxels' && editorManager.hasUnsavedTerrainChanges()) {
            console.log('[GameRuntimeController] Cannot switch tab - unsaved terrain changes');
            this.postMessage({
                type: 'TAB_SWITCH_BLOCKED',
                reason: 'unsaved_terrain_changes',
                message: 'Please save or cancel terrain changes before switching tabs.'
            });
            return false;
        }

        return true;
    }

    private ensurePauseScreen(): void {
        if (this.pauseScreen) {
            return;
        }
        // Honor a custom override in the 'pause' slot: if a genre or per-game
        // file has already installed one before attachEngine, skip the default.
        if (this.gameEngine?.getUIComponent('pause')) {
            return;
        }
        this.pauseScreen = new PauseScreen({
            gameStateManager: this.gameStateManager,
            getHud: () => this.gameEngine?.genreModule?.hud ?? null,
            onResume: () => this.resumeFromManualPause(),
            // Lazy: this runs before attachEngine on first load, so resolve the
            // engine each time the screen mounts rather than capturing null now.
            getEngine: () => this.gameEngine ?? null,
        });
    }

    /**
     * The touch-only pause entry point. Created lazily against the genre's HUD, which does
     * not exist yet at `attachEngine` time on the first load — the same reason
     * `ensurePauseScreen` resolves its engine through a callback. Skipped entirely for a
     * game that hides it (`worldProfileData.hud.pauseButton: 'hidden'`).
     */
    private ensurePauseButton(): void {
        if (this.pauseButton || !isPauseButtonShown()) return;
        const hud = this.gameEngine?.genreModule?.hud;
        if (!hud) return;
        this.pauseButton = new PauseButton(hud, () => this.requestManualPause());
    }

    private ensureEscapeKeyHandler(): void {
        if (this.escapeKeyHandler) {
            return;
        }
        this.escapeKeyHandler = (event: KeyboardEvent) => this.handleEscapeKey(event);
        document.addEventListener('keydown', this.escapeKeyHandler);
    }

    private handleEscapeKey(event: KeyboardEvent): void {
        if (event.key !== 'Escape' || event.repeat) return;
        if (!this.gameStateManager.hasStarted()) return;

        const state = this.gameStateManager.getCurrentState();
        const reasons = this.gameStateManager.getPauseReasons();
        if (state === GameState.PLAYING) {
            this.openPauseCard();
        } else if (state === GameState.PAUSED && reasons.has('manual')) {
            // A cursor-locked game can take the cursor back only on a click, and ESC grants
            // the page no user activation, so the card stays until Resume is clicked. This
            // also makes a browser that delivers the unlocking ESC as a keydown harmless.
            if (this.pointerLockToRegain()) return;
            this.resumeFromManualPause();
        } else if (state === GameState.PAUSED && this.pausedForPointerLock && !reasons.has('editor-tab')) {
            this.openPauseCard();
        }
    }

    /**
     * Show the card over whatever holds the game — play, or the start prompt. The game never
     * runs in between: 'manual' goes on before 'pointer-lock' comes off. When the state stays
     * PAUSED no state event fires, so the card is refreshed by hand.
     */
    private openPauseCard(): void {
        this.pointerLockManager?.cancelLockRequest();
        this.pointerLockManager?.hideOverlay();
        this.setGameplayPaused(true, 'manual');
        if (this.pausedForPointerLock) {
            this.pausedForPointerLock = false;
            this.setGameplayPaused(false, 'pointer-lock');
        }
        this.pauseScreen?.refresh();
    }

    /**
     * Open the pause card, the way the Escape key does.
     *
     * Public because touch has no Escape key: `PauseButton` is the only way a phone reaches
     * the pause screen, and with it the mute toggle and the graphics-quality row. Guarded
     * the same way the key handler is, so a tap before the game has started, or while it is
     * already paused for another reason, does nothing.
     */
    requestManualPause(): void {
        if (!this.gameStateManager.hasStarted()) return;
        if (this.gameStateManager.getCurrentState() !== GameState.PLAYING) return;
        this.setGameplayPaused(true, 'manual');
    }

    private resumeFromManualPause(): void {
        this.gameStateManager.forceUnpause();
        const plm = this.pointerLockToRegain();
        if (plm) {
            this.resumeIntoPointerLock(plm, 'click');
            return;
        }
        this.setGameplayPaused(false, 'manual');
        this.gameEngine?.exitInteractiveUI();
    }

    /**
     * The Creator's parent-frame Play/Pause button. That button gives the iframe no user
     * activation, so a pointer-locked game cannot take the cursor back from it. Once the
     * player has held the cursor, the card stays up for its Resume click; before that, the
     * game resumes behind the "Click to play" start prompt. Other games resume in place and
     * leave any interactive UI they have open alone.
     */
    resumeFromParentFrame(): void {
        const plm = this.pointerLockToRegain();
        if (plm && this.hasHeldLockThisLoad) return;
        this.gameStateManager.forceUnpause();
        if (plm) {
            this.resumeIntoPointerLock(plm, 'overlay');
            return;
        }
        this.setGameplayPaused(false, 'manual');
    }

    /** The manager when resuming has to re-acquire the lock first, otherwise null. */
    private pointerLockToRegain(): PointerLockManager | null {
        const plm = this.pointerLockManager;
        if (!plm || !plm.getIsSupported() || plm.getIsLocked()) return null;
        if (plm.getFreeMouseMode() || plm.getEditorMode() || plm.getInteractiveUIMode()) return null;
        return plm;
    }

    /**
     * Take the card down, but keep the simulation paused behind 'pointer-lock' until the
     * lock lands; `syncPointerLockPause` lifts that reason. Otherwise the game would run
     * with a free cursor during the browser's re-lock cooldown.
     */
    private resumeIntoPointerLock(plm: PointerLockManager, lockVia: LockRegain): void {
        this.pausedForPointerLock = true;
        this.setGameplayPaused(true, 'pointer-lock');
        // The state stayed PAUSED, so no state event unmounts the card.
        this.pauseScreen?.refresh();
        this.setPlayerControlsEnabled(true);
        if (lockVia === 'click') {
            plm.requestLockWithRetry();
        } else {
            plm.showOverlay();
        }
    }

    private transitionToLoading(): void {
        this.gameStateManager.transitionToLoading();
        this.postCurrentGameState();
    }

    private transitionToMenu(): void {
        this.gameStateManager.transitionToMenu();
        this.postCurrentGameState();
    }

    private transitionToReadyMenu(): void {
        this.gameStateManager.transitionToReady('menu');
        this.postCurrentGameState();
    }

    private postCurrentGameState(): void {
        this.postMessage({
            type: 'GAME_STATE_CHANGED',
            state: this.gameStateManager.getCurrentState()
        });
    }

    private ensureStartScreen(): StartScreen | null {
        if (this.menuUI) {
            return this.menuUI;
        }

        // Honor a custom override in the 'start' slot: if a genre or per-game
        // file has already installed one, skip the default. Callers must
        // null-check the return value.
        if (this.gameEngine?.getUIComponent('start')) {
            return null;
        }

        const options = this.resolveStartScreenOptions();
        // Mount the start screen in a top-level layer that stacks ABOVE the HUD
        // (`.hud-root`), not inside `#game-container` (stacking level `auto`).
        // Otherwise a game's full-screen HUD overlay paints over the Play button
        // and, on mobile, swallows its taps. See screenOverlayLayer.ts.
        this.menuUI = new StartScreen(getScreenOverlayLayer(), this.gameStateManager, options);
        this.menuUI.setStartupUiMode(this.startupUiMode);
        this.menuUI.addPlayClickListener(() => {
            const engine = this.gameEngine;
            if (engine) {
                engine.startGame();
            }
        });
        return this.menuUI;
    }

    private resolveStartScreenOptions(): StartScreenOptions {
        const gameData = this.currentGameData as GameData | null;
        const startScreen = (gameData?.worldProfileData as WorldProfileData | undefined)?.hud?.startScreen;
        return {
            title: startScreen?.title ?? gameData?.gameName ?? '',
            imageUrl: startScreen?.imageUrl ?? null,
            playLabel: startScreen?.playLabel ?? '',
            hideTitle: startScreen?.hideTitle ?? false,
            cardPlacement: startScreen?.cardPlacement ?? 'center',
        };
    }

    private setStartupUiMode(mode: StartupUiMode): void {
        this.startupUiMode = mode;
        this.menuUI?.setStartupUiMode(mode);
    }

    /** The active player controller's camera controller, when it has one. */
    private getCameraController(): RuntimeCameraController | null {
        const playerController = this.gameEngine?.getPlayerController() as
            (PlayerControllerLike & { getCameraController?: () => RuntimeCameraController | null }) | null | undefined;
        return playerController?.getCameraController?.() ?? null;
    }

    private setPlayerControlsEnabled(enabled: boolean): void {
        const playerController = this.gameEngine?.getPlayerController();
        if (playerController && 'setControlsEnabled' in playerController) {
            (playerController as { setControlsEnabled: (enabled: boolean) => void }).setControlsEnabled(enabled);
        }
    }

    private ensurePointerLockManager(): PointerLockManager {
        if (this.pointerLockManager) {
            return this.pointerLockManager;
        }

        this.pointerLockManager = new PointerLockManager(this.container, () => this.claimClickPrompt());
        this.pointerLockManager.addListener((isLocked) => {
            if (!this.gameEngine) {
                return;
            }

            if (isLocked) {
                this.gameEngine.isWindowFocused = true;
            }

            this.getCameraController()?.setPointerLocked?.(isLocked);

            const playerController = this.gameEngine.getPlayerController();
            if (isLocked && playerController && 'setShootingDelay' in playerController) {
                (playerController as { setShootingDelay: (ms: number) => void }).setShootingDelay(150);
            }

            if (this.pointerLockManager && this.pointerLockManager.getIsSupported()) {
                this.gameEngine.genreModule?.hud?.setGameplayUIVisible(isLocked);
            }

            this.syncPointerLockPause(isLocked);
        });

        return this.pointerLockManager;
    }

    private hasActiveUserGesture(): boolean {
        const nav = navigator as Navigator & {
            userActivation?: {
                isActive?: boolean;
            };
        };
        if (typeof nav.userActivation?.isActive === 'boolean') {
            return nav.userActivation.isActive;
        }
        const doc = document as Document & {
            hasTransientUserActivation?: boolean;
        };
        if (typeof doc.hasTransientUserActivation === 'boolean') {
            return doc.hasTransientUserActivation;
        }
        return false;
    }

    private async requestFullscreenForGameplay(): Promise<boolean> {
        if (!isMobileRuntime()) {
            return true;
        }

        // Mobile simulation preview runs the engine in mobile mode on a desktop
        // browser inside the creator iframe. Going fullscreen there hijacks the
        // whole creator UI, so skip the request while previewing.
        const playerController = this.gameEngine?.getPlayerController();
        if (playerController?.getMobilePreviewMode?.()) {
            return true;
        }

        if (document.fullscreenElement) {
            return true;
        }

        if (!this.hasActiveUserGesture()) {
            console.warn('[GameRuntimeController] Mobile gameplay start: no user activation for fullscreen, continuing without fullscreen');
            return true;
        }

        const elem = document.documentElement as HTMLElement & {
            webkitRequestFullscreen?: () => Promise<void>;
            mozRequestFullScreen?: () => Promise<void>;
            msRequestFullscreen?: () => Promise<void>;
        };

        const request = elem.requestFullscreen
            ?? elem.webkitRequestFullscreen
            ?? elem.mozRequestFullScreen
            ?? elem.msRequestFullscreen;

        if (!request) {
            console.warn('[GameRuntimeController] No fullscreen API available, continuing without fullscreen');
            return true;
        }

        const FULLSCREEN_TIMEOUT_MS = 2000;
        const timeout = new Promise<'timeout'>((resolve) =>
            setTimeout(() => resolve('timeout'), FULLSCREEN_TIMEOUT_MS),
        );

        try {
            const result = await Promise.race([request.call(elem).then(() => 'ok' as const), timeout]);
            if (result === 'timeout') {
                console.warn('[GameRuntimeController] Fullscreen request timed out, continuing without fullscreen');
            }
        } catch (error) {
            console.warn('[GameRuntimeController] Fullscreen not available (e.g. iframe permissions policy), continuing without fullscreen:', error);
        }
        return true;
    }
}
