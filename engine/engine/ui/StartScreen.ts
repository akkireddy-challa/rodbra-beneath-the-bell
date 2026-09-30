// Default start-screen template for the engine. Renders a centered card
// with the game's title, an optional full-bleed background image, and the
// Play button. Subscribes to GameStateManager so it hides as soon as
// gameplay starts (PLAYING) and shows again on MENU / READY / LOADING.

import { GameState, GameStateManager, type GameStateChangeListener } from 'engine/GameStateManager.js';
import { t } from 'engine/i18n/index.js';
import { injectHudBaseStyles } from 'engine/hud/index.js';
import { injectModalCardStyles, ScreenLeave } from 'engine/ui/modalCard.js';
import { getLoadProgress, type LoadProgressListener } from 'engine/progress/LoadProgress.js';
import { buildSelectionStepElement, defaultPick, type SelectionResolution, type SelectionStepSpec } from 'engine/ui/SelectionSteps.js';
import type { StartupUiMode } from 'types/game.js';

export type PlayButtonClickListener = () => void;

export interface StartScreenOptions {
    /** Title to display on the start card. Empty string suppresses the title element. */
    title: string;
    /** Full-bleed background image URL, or null/empty for the transparent default. */
    imageUrl: string | null;
    /** Play-button label. */
    playLabel: string;
    /**
     * When true, hide the title visually while keeping its layout box (so the Play
     * button doesn't shift up). Use when the cover `imageUrl` already has the game
     * name baked in, so it isn't shown twice.
     */
    hideTitle: boolean;
    /**
     * Where the card sits on screen. `'center'` (default) centres it. `'start'`
     * moves it to the leading edge — top in portrait, left in landscape; `'end'`
     * to the trailing edge — bottom in portrait, right in landscape. The other
     * axis stays centred.
     */
    cardPlacement: 'center' | 'start' | 'end';
}

export const DEFAULT_START_SCREEN_OPTIONS: StartScreenOptions = {
    title: '',
    imageUrl: null,
    playLabel: '',
    hideTitle: false,
    cardPlacement: 'center',
};

export class StartScreen {
    private container: HTMLElement;
    private menuElement: HTMLElement | null = null;
    private cardElement: HTMLElement | null = null;
    private playButton: HTMLButtonElement | null = null;
    private loadingIndicator: HTMLElement | null = null;
    private progressBar: HTMLElement | null = null;
    private progressFill: HTMLElement | null = null;
    private progressLabel: HTMLElement | null = null;
    private progressPercent: HTMLElement | null = null;
    private onPlayClickListeners: PlayButtonClickListener[] = [];
    private gameStateManager: GameStateManager;
    private stateListener: GameStateChangeListener | null = null;
    private progressListener: LoadProgressListener | null = null;
    private activeSelection: {
        step: SelectionStepSpec;
        element: HTMLElement;
        resolve: (result: SelectionResolution | null) => void;
    } | null = null;
    private startControlMode: 'play' | 'fallback' | 'hidden' = 'play';
    private startupUiMode: StartupUiMode = 'engine';
    private readonly options: StartScreenOptions;
    /** Pending display:none for a card that is fading out. */
    private readonly leave = new ScreenLeave();

    constructor(container: HTMLElement, gameStateManager: GameStateManager, options?: Partial<StartScreenOptions>) {
        this.container = container;
        this.gameStateManager = gameStateManager;
        this.options = { ...DEFAULT_START_SCREEN_OPTIONS, ...options };

        // StartScreen may be created before the HUD — inject the shared CSS
        // so the Play button's .hud-play-button class and .ui-modal-* classes
        // always have their CSS. Both injectors are idempotent.
        injectHudBaseStyles();
        injectModalCardStyles();

        this.createStartScreenUI();
        this.setupStateListener();
        this.setupProgressListener();
    }

    private createStartScreenUI(): void {
        // Outer overlay is always transparent — the game canvas remains visible
        // behind the centered card, matching the "video thumbnail" pattern.
        this.menuElement = document.createElement('div');
        this.menuElement.id = 'game-menu';
        this.menuElement.className = 'ui-modal-overlay ui-modal-overlay--transparent ui-modal-overlay--animated';
        if (this.options.cardPlacement === 'start') {
            this.menuElement.classList.add('ui-modal-overlay--place-start');
        } else if (this.options.cardPlacement === 'end') {
            this.menuElement.classList.add('ui-modal-overlay--place-end');
        }

        const imageUrl = this.options.imageUrl;
        this.cardElement = document.createElement('div');
        if (imageUrl) {
            this.cardElement.className = 'start-screen-card start-screen-card--with-image';
            this.cardElement.style.backgroundImage = `url(${cssUrl(imageUrl)})`;
        } else {
            this.cardElement.className = 'ui-modal-card start-screen-card start-screen-card--text';
            this.cardElement.dataset.accent = 'neutral';
        }

        if (this.options.title) {
            const title = document.createElement('h1');
            title.className = imageUrl
                ? 'start-screen-title start-screen-title--with-image'
                : 'ui-modal-title start-screen-title';
            title.textContent = this.options.title;
            if (this.options.hideTitle) {
                // Hide the name visually but keep its layout box, so the Play button
                // stays in the same place as when the title is shown (e.g. for cover
                // images that already include the game name).
                title.style.visibility = 'hidden';
            }
            this.cardElement.appendChild(title);
        }

        this.loadingIndicator = this.createLoadingIndicator();
        this.cardElement.appendChild(this.loadingIndicator);

        this.playButton = document.createElement('button');
        this.playButton.id = 'play-button';
        this.playButton.className = 'hud-play-button';
        this.playButton.textContent = this.options.playLabel || t('game.menu.play');
        this.wirePlayButtonEvents(this.playButton);
        this.playButton.style.display = 'none';
        this.cardElement.appendChild(this.playButton);

        this.menuElement.appendChild(this.cardElement);
        this.container.appendChild(this.menuElement);
    }

    /**
     * Determinate load-progress bar (replaces the old indeterminate spinner).
     * Driven by the engine-wide LoadProgress tracker; `updateLoadingMessage`
     * still overrides the label line for callers that set their own text.
     * Keeps the legacy `#gaussian-loading-indicator` id and the
     * `.hud-loading-indicator` show/hide contract (data-visible).
     */
    private createLoadingIndicator(): HTMLElement {
        const indicator = document.createElement('div');
        indicator.id = 'gaussian-loading-indicator';
        indicator.className = 'hud-loading-indicator';

        const bar = document.createElement('div');
        bar.className = 'hud-progress-bar start-screen-progress';
        this.progressBar = bar;

        const labelRow = document.createElement('div');
        labelRow.className = 'hud-progress-bar__label start-screen-progress__label-row';

        this.progressLabel = document.createElement('span');
        this.progressLabel.textContent = t('game.menu.loading');

        this.progressPercent = document.createElement('span');
        this.progressPercent.className = 'start-screen-progress__percent';
        this.progressPercent.textContent = '0%';

        labelRow.appendChild(this.progressLabel);
        labelRow.appendChild(this.progressPercent);

        const track = document.createElement('div');
        track.className = 'hud-progress-bar__track';
        this.progressFill = document.createElement('div');
        this.progressFill.className = 'hud-progress-bar__fill';
        track.appendChild(this.progressFill);

        bar.appendChild(labelRow);
        bar.appendChild(track);
        indicator.appendChild(bar);
        return indicator;
    }

    /**
     * Mirror the engine-wide load progress onto the bar. The tracker syncs new
     * listeners immediately, so a StartScreen rebuilt mid-load (game data
     * arriving disposes the empty boot-time instance) starts at the current
     * fraction instead of 0.
     */
    private setupProgressListener(): void {
        this.progressListener = (snapshot) => {
            const percent = Math.round(snapshot.fraction * 100);
            if (this.progressFill) {
                // .hud-progress-bar__fill reads its width from this var (same
                // pattern as GameHUD's progress/health bars).
                this.progressFill.style.setProperty('--hud-progress-value', `${percent}%`);
            }
            if (this.progressPercent) {
                this.progressPercent.textContent = `${percent}%`;
            }
            if (snapshot.label && this.progressLabel) {
                this.progressLabel.textContent = snapshot.label;
            }
            // The warmup phase ends in main-thread blocks (the warm frame;
            // WebGL shader links) that freeze every JS-driven update — the
            // busy shimmer is compositor-driven and keeps moving through them
            // (see .hud-progress-bar--busy in hudBaseStyles).
            this.progressBar?.classList.toggle('hud-progress-bar--busy', snapshot.phase === 'warmup');
        };
        getLoadProgress().addListener(this.progressListener);
    }

    /**
     * Mouse and touch wiring for Play. Every handler stops propagation so the press never
     * also reaches the document-level mobile/shoot handlers.
     */
    private wirePlayButtonEvents(button: HTMLButtonElement): void {
        button.addEventListener('mousedown', (e: MouseEvent) => { e.stopPropagation(); });
        button.addEventListener('mouseup', (e: MouseEvent) => { e.stopPropagation(); });
        button.addEventListener('click', (e: MouseEvent) => {
            e.stopPropagation();
            this.handlePlayClick();
        });
        button.addEventListener('touchstart', (e: TouchEvent) => { e.stopPropagation(); }, { passive: false });
        button.addEventListener('touchend', (e: TouchEvent) => {
            e.stopPropagation();
            e.preventDefault();
            this.handlePlayClick();
        });
    }

    private setupStateListener(): void {
        // applyStartupVisibility already inspects the current state and the
        // startup-UI mode, so it handles every transition the listener cares
        // about (LOADING → spinner, MENU/READY → show or hide per mode,
        // anything else → hide).
        this.stateListener = () => this.applyStartupVisibility();
        this.gameStateManager.addListener(this.stateListener);
    }

    private handlePlayClick(): void {
        this.onPlayClickListeners.forEach(listener => {
            try {
                listener();
            } catch (error) {
                console.error('Error in play click listener:', error);
            }
        });
    }

    show(): void {
        if (!this.menuElement) return;
        // Also rescues a card mid-fade-out: dropping data-leaving swaps the leave animation
        // back for the enter one. Going from display:none replays the enter animation.
        this.leave.cancel();
        delete this.menuElement.dataset.leaving;
        this.menuElement.style.display = 'flex';
    }

    hide(): void {
        const menu = this.menuElement;
        if (!menu || menu.style.display === 'none' || menu.dataset.leaving) return;
        this.leave.start(menu, () => {
            delete menu.dataset.leaving;
            menu.style.display = 'none';
        });
    }

    addPlayClickListener(listener: PlayButtonClickListener): void {
        this.onPlayClickListeners.push(listener);
    }

    removePlayClickListener(listener: PlayButtonClickListener): void {
        const index = this.onPlayClickListeners.indexOf(listener);
        if (index !== -1) {
            this.onPlayClickListeners.splice(index, 1);
        }
    }

    /**
     * Present one pre-play selection step on the start card and resolve with
     * the picked option. While a step is active the progress bar and Play
     * button are hidden; normal visibility is restored on resolution.
     *
     * Resolution paths:
     *   - the player taps an option → `{ optionId, userPicked: true }`;
     *   - the flow is interrupted (gameplay force-starts mid-step, the editor
     *     cancels via cancelActiveSelection, or a step is somehow already
     *     active) → the step's DEFAULT as `{ optionId, userPicked: false }`,
     *     so awaiting flows always continue with a value but know not to
     *     remember it or present further steps;
     *   - this StartScreen is disposed (load superseded / UI slot overridden)
     *     → null. Callers treat null as "this flow is obsolete".
     */
    presentSelection(step: SelectionStepSpec): Promise<SelectionResolution | null> {
        return new Promise((resolve) => {
            if (!this.cardElement) {
                // Disposed — this flow is obsolete (see contract above).
                resolve(null);
                return;
            }
            if (this.activeSelection) {
                // Callers await sequentially, so this is a programming error;
                // degrade to the default rather than stalling the load.
                console.warn('[StartScreen] presentSelection called while a step is active — using default pick for step', step.id);
                resolve({ optionId: defaultPick(step), userPicked: false });
                return;
            }
            this.show();
            // Hide the bar + Play while choosing (restored on resolution).
            if (this.loadingIndicator) {
                delete this.loadingIndicator.dataset.visible;
            }
            this.hidePlayButton();
            const element = buildSelectionStepElement(step, (optionId) => this.finishSelection(optionId, true));
            this.activeSelection = { step, element, resolve };
            this.cardElement.appendChild(element);
        });
    }

    /**
     * Resolve a pending selection step with its default (userPicked=false).
     * Called by the runtime when something else takes over the screen while a
     * step is up — e.g. the creator switches to an editor tab — so the flow
     * awaiting the pick continues instead of parking forever. No-op when no
     * step is active.
     */
    cancelActiveSelection(): void {
        if (this.activeSelection) {
            this.finishSelection(defaultPick(this.activeSelection.step), false);
        }
    }

    private finishSelection(optionId: string, userPicked: boolean): void {
        const active = this.activeSelection;
        if (!active) {
            return;
        }
        this.activeSelection = null;
        active.element.remove();
        // Restore the standard indicator/Play visibility for the current state.
        if (this.gameStateManager.getCurrentState() === GameState.LOADING) {
            this.showLoadingIndicator();
        } else {
            this.hideLoadingIndicator();
        }
        this.applyStartupVisibility();
        active.resolve({ optionId, userPicked });
    }

    showLoadingIndicator(): void {
        // A selection step owns the card right now; visibility is restored
        // from the current state when the step resolves.
        if (this.activeSelection) {
            return;
        }
        if (this.loadingIndicator) {
            this.loadingIndicator.dataset.visible = 'true';
        }
        this.hidePlayButton();
    }

    hideLoadingIndicator(): void {
        // A selection step owns the card — don't reveal Play under it.
        if (this.activeSelection) {
            return;
        }
        if (this.loadingIndicator) {
            delete this.loadingIndicator.dataset.visible;
        }
        if (this.playButton && this.startControlMode !== 'hidden') {
            this.playButton.style.display = 'block';
        }
    }

    setPlayButtonVisible(visible: boolean): void {
        // Hiding is only honoured once gameplay can no longer be started from
        // here — otherwise the control stays up as a fallback Start, or the
        // player would have no way to begin.
        const keepAsFallback = !visible && this.gameStateManager.isWaitingForPlayerStart();
        if (!visible && !keepAsFallback) {
            this.startControlMode = 'hidden';
            this.hidePlayButton();
            return;
        }

        this.startControlMode = keepAsFallback ? 'fallback' : 'play';
        this.updateStartButtonText();
        this.revealPlayButton();
        if (keepAsFallback) {
            console.warn('[StartScreen] setPlayButtonVisible(false) called before gameplay start; keeping fallback Start control visible');
        }
    }

    setStartupUiMode(mode: StartupUiMode): void {
        this.startupUiMode = mode;
        this.applyStartupVisibility();
    }

    updateLoadingMessage(message: string): void {
        if (this.progressLabel) {
            this.progressLabel.textContent = message;
        }
    }

    private updateStartButtonText(): void {
        if (!this.playButton) {
            return;
        }
        this.playButton.textContent = this.startControlMode === 'fallback'
            ? t('game.menu.start')
            : (this.options.playLabel || t('game.menu.play'));
    }

    private isLoadingIndicatorVisible(): boolean {
        return this.loadingIndicator?.dataset.visible === 'true';
    }

    /**
     * Show the Play/Start control unless something else owns the card right
     * now: the load bar, an unresolved selection step, or an external startup
     * UI that replaces the engine's own screen.
     */
    private revealPlayButton(): void {
        if (this.playButton && !this.isLoadingIndicatorVisible() && this.startupUiMode === 'engine' && !this.activeSelection) {
            this.playButton.style.display = 'block';
        }
    }

    private hidePlayButton(): void {
        if (this.playButton) {
            this.playButton.style.display = 'none';
        }
    }

    private applyStartupVisibility(): void {
        const currentState = this.gameStateManager.getCurrentState();

        // Gameplay started (or ended) under an unresolved selection step —
        // e.g. template code force-starts during load. Resolve it with the
        // step's default (not a user pick) so the awaiting load flow
        // continues, then fall through to the normal visibility rules
        // (finishSelection re-enters this method once, with activeSelection
        // already cleared).
        if (this.activeSelection
            && currentState !== GameState.LOADING
            && currentState !== GameState.MENU
            && currentState !== GameState.READY) {
            this.finishSelection(defaultPick(this.activeSelection.step), false);
            return;
        }

        if (currentState === GameState.LOADING) {
            this.show();
            this.showLoadingIndicator();
            return;
        }

        if (currentState !== GameState.MENU && currentState !== GameState.READY) {
            this.hide();
            return;
        }

        if (this.startupUiMode === 'external') {
            this.hide();
            return;
        }

        this.show();
    }

    dispose(): void {
        this.leave.cancel();
        // Superseded mid-selection (new load / custom start-slot override):
        // resolve with null so the awaiting flow can tell it is obsolete.
        // (Deliberately NOT finishSelection — no default, no visibility work.)
        if (this.activeSelection) {
            const active = this.activeSelection;
            this.activeSelection = null;
            active.element.remove();
            active.resolve(null);
        }
        if (this.stateListener) {
            this.gameStateManager.removeListener(this.stateListener);
            this.stateListener = null;
        }
        if (this.progressListener) {
            getLoadProgress().removeListener(this.progressListener);
            this.progressListener = null;
        }
        this.menuElement?.remove();
        this.onPlayClickListeners = [];
        this.menuElement = null;
        this.cardElement = null;
        this.playButton = null;
        this.loadingIndicator = null;
        this.progressBar = null;
        this.progressFill = null;
        this.progressLabel = null;
        this.progressPercent = null;
    }
}

function cssUrl(value: string): string {
    return value.replace(/[\\"\n)]/g, (ch) => '\\' + ch);
}
