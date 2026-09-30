import type { PlayerController } from 'engine/PlayerController.js';
import { GameState, getGameStateManager, type GameStateChangeListener } from 'engine/GameStateManager.js';
import { t } from 'engine/i18n/index.js';
import { isMobileRuntime } from 'engine/isMobileRuntime.js';
import { HUD_ANCHORS } from 'engine/IGameHUD.js';
import type {
    IGameHUD,
    HUDAnchor, HUDElement,
    CounterOptions, ProgressBarOptions, IconTextOptions,
    TimerOptions, CustomElementOptions, MouseUnlockCallback,
    HUDScaleFactors, ControlEntry, ToastOptions, HUDElementType,
    HUDActionRowOptions, HUDActionControlOptions, HUDActionControlUpdate,
    HUDActionVariant,
} from 'engine/IGameHUD.js';
import { MuteControl } from 'engine/ui/MuteControl.js';
import { renderButtonContent, type ButtonContent } from 'engine/ui/buttonContent.js';
import { getGameEventLog, type HudElementKind } from 'engine/recording/GameEventLog.js';
import type { EngineLike, GameData } from 'types/game.js';
import {
    ThemeManager,
    injectHudBaseStyles,
    logGameStylesheets,
    BITMAGIC_THEME,
    getLastAppliedTheme,
    type ThemeTokens,
    type HudElementClass,
    createNamedIcon,
    arrowIconHtml,
} from 'engine/hud/index.js';

// Re-export all types from IGameHUD for backward compatibility with callers
// that imported them from GameHUD historically.
export type {
    IGameHUD,
    HUDAnchor, HUDElementType, HUDElement,
    CounterOptions, ProgressBarOptions, IconTextOptions,
    TimerOptions, CustomElementOptions, MouseUnlockCallback,
    HUDScaleFactors, ControlEntry, ToastVariant, ToastOptions,
    HUDActionRowOptions, HUDActionControlOptions, HUDActionControlUpdate,
    HUDActionVariant, HUDActionControlKind,
} from 'engine/IGameHUD.js';

/**
 * Cap on custom-element markup recorded per trailer-timeline entry. Custom
 * elements can hold arbitrary DOM; a runaway one would bloat timeline.json
 * without making a better trailer. 16 KB now that selector styling rides the
 * `stylesheet` ops instead of inflating the markup — the largest real widget
 * html observed is under 4 KB. Every enforcement point warns once per element,
 * because a silently vanishing widget was this cap's original failure mode.
 */
const MAX_CUSTOM_HTML_CHARS = 16384;

interface TimerData {
    currentSeconds: number;
    startSeconds: number;
    countDown: boolean;
    running: boolean;
    format: 'mm:ss' | 'hh:mm:ss' | 'seconds';
    onComplete?: () => void;
    intervalId?: number;
    textElement: HTMLDivElement;
}

/** Timer state is parked on the container, so the element registry stays generic. */
type TimerContainer = HTMLDivElement & { timerData?: TimerData };

interface ProgressBarRefs {
    fillEl: HTMLDivElement;
    textEl: HTMLDivElement | null;
    maxValue: number;
    format?: (current: number, max: number) => string;
}

/** A managed action control is always one of these two form elements. */
type ActionControlElement = HTMLButtonElement | HTMLInputElement;

interface ActionRowRefs {
    container: HTMLDivElement;
    controls: Map<string, ActionControlElement>;
}

/** Every variant class, so `updateActionControl` can swap one for another. */
const ACTION_VARIANTS: readonly HUDActionVariant[] = ['primary', 'danger', 'warning', 'neutral'];

/**
 * Keys that activate a focused button. Only these are withheld from gameplay
 * while a button holds focus — WASD and the rest still reach the player, so a
 * HUD button that keeps focus after a click doesn't leave the game unplayable.
 */
const ACTIVATION_KEYS: ReadonlySet<string> = new Set([' ', 'Spacebar', 'Enter']);

/** Pointer/touch events that must not reach the document-level input layers. */
const POINTER_EVENT_TYPES: readonly string[] = [
    'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'touchstart', 'touchend',
];

// Maps the IGameHUD HUDAnchor names to the CSS classes from hud-base.
function anchorClass(anchor: HUDAnchor): string {
    return `hud-anchor-${anchor} hud-anchor-stack`;
}

/**
 * GameHUD — token-driven, class-based implementation of IGameHUD.
 *
 * Architecture:
 *   - One `.hud-root` element hosts the 9-anchor grid for chrome (game name,
 *     health bar, counters, timers, controls overlay, etc.). ThemeManager
 *     attaches here so --hud-* custom properties cascade to all elements.
 *   - A sibling `.hud-gameplay-layer` hosts the reticle, ESC hint, and comic
 *     bubbles. It's toggled visible only while pointer lock is active.
 *   - Built-in elements (game name, health, controls) sit in the top-left
 *     anchor by default. Custom factory elements stack below them automatically.
 *   - Per-element theme overrides apply via ThemeManager.applyElementOverride.
 *
 * Styling rules live in `engine/hud/hudBaseStyles.ts` and are scoped via the
 * `.hud-*` class names below. Do NOT add inline cssText to factories — the
 * theme system relies on classes + custom properties.
 */
export class GameHUD implements IGameHUD {
    private hudRoot!: HTMLDivElement;
    private gameplayLayer!: HTMLDivElement;
    private themeManager!: ThemeManager;

    private controlsDisplay!: HTMLDivElement;
    private healthContainer!: HTMLDivElement;
    private healthFill!: HTMLDivElement;
    private healthText!: HTMLDivElement;

    private playerController: PlayerController | null = null;
    private healthEnabled: boolean = false;
    private damageFlashTimeout: number | null = null;
    private reticle: HTMLDivElement | null = null;
    private escHint: HTMLDivElement | null = null;
    private freeMouseMode: boolean = false;

    private controlsAutoHideTimeout: number | null = null;
    private controlsManuallyHidden: boolean = false;
    private controlsGuideEnabled: boolean = true;
    private customControls: ControlEntry[] | null = null;

    private muteControl: MuteControl | null = null;

    private gameStateListener: GameStateChangeListener | null = null;

    private readonly elements: Map<string, HUDElement> = new Map();
    private readonly anchorContainers: Map<HUDAnchor, HTMLDivElement> = new Map();
    private readonly toastStacks: Map<HUDAnchor, HTMLDivElement> = new Map();

    private readonly interactiveElements: Set<string> = new Set();
    /** Custom-element ids already warned about oversized markup — once each. */
    private readonly oversizeWarnedIds: Set<string> = new Set();
    /** Recording session the ids above belong to; see refreshOversizeWarnSession. */
    private oversizeWarnedSerial = -1;
    private mouseUnlockCallback: MouseUnlockCallback | null = null;

    private readonly actionRows: Map<string, ActionRowRefs> = new Map();
    /** Current label/image of each action button, so a partial update can re-render the rest. */
    private readonly actionButtonContent: WeakMap<HTMLButtonElement, ButtonContent> = new WeakMap();
    /** True while a managed text input holds the keyboard (see suppressGameplayInputForFocus). */
    private actionInputFocused = false;
    /** Player-controls state to restore once that input gives the keyboard back. */
    private controlsEnabledBeforeActionFocus = true;

    /**
     * Legacy responsive-scale factors. CSS clamp() now drives actual sizing;
     * these values are exposed for external callers (MuteControl, a genre's
     * Game class) that read them to build custom UIs that match HUD chrome.
     */
    private readonly scale: HUDScaleFactors;

    private readonly keydownHandler: (event: KeyboardEvent) => void;

    constructor() {
        this.scale = calculateScale();

        injectHudBaseStyles();

        this.hudRoot = document.createElement('div');
        this.hudRoot.className = 'hud-root';
        // Start hidden — the HUD only fades in once the game state moves to
        // PLAYING. The state listener installed below drives the opacity
        // and keeps it in sync with subsequent transitions (e.g. restart →
        // MENU fades the HUD back out).
        this.hudRoot.style.transition = 'opacity 0.3s ease-in-out';
        this.hudRoot.style.opacity = '0';
        document.body.appendChild(this.hudRoot);

        this.themeManager = new ThemeManager({ root: this.hudRoot, manageFontLink: true });
        // Prefer the theme already applied to the document (by GameTemplate
        // before the StartScreen was built). Falling back to BITMAGIC here
        // would overwrite that, causing the StartScreen to flash default
        // styles before setTheme() runs with the real resolved theme.
        this.themeManager.applyTheme(getLastAppliedTheme() ?? BITMAGIC_THEME);

        this.gameplayLayer = document.createElement('div');
        this.gameplayLayer.className = 'hud-gameplay-layer';
        document.body.appendChild(this.gameplayLayer);

        this.createAnchorContainers();
        this.createBuiltInElements();
        this.createEscHint();
        this.createReticle();

        this.keydownHandler = (event: KeyboardEvent): void => {
            if (event.key.toLowerCase() === 'h') this.toggleControls();
        };
        document.addEventListener('keydown', this.keydownHandler);

        this.gameStateListener = (newState: GameState) => this.applyVisibilityForState(newState);
        getGameStateManager().addListener(this.gameStateListener);
        this.applyVisibilityForState(getGameStateManager().getCurrentState());
    }

    private applyVisibilityForState(state: GameState): void {
        const gameplayActive = state === GameState.PLAYING || state === GameState.PAUSED || state === GameState.END;
        this.hudRoot.style.opacity = gameplayActive ? '1' : '0';
    }

    // ==================== THEME ====================

    setTheme(theme: ThemeTokens): void {
        this.themeManager.applyTheme(theme);
        // Mid-recording rethemes must reach the timeline — snapshotForRecording
        // only captures the theme in force at F9.
        getGameEventLog().logHud({ op: 'theme', theme });
        // Re-apply per-element overrides for any registered element whose class
        // matches one with per-element tokens in the new theme.
        for (const element of this.elements.values()) {
            const cls = mapElementTypeToClass(element.type);
            if (cls) this.themeManager.applyElementOverride(element.container, cls);
        }
        // Built-in health bar override re-application.
        if (this.healthContainer) {
            this.themeManager.applyElementOverride(this.healthContainer, 'healthBar');
        }
    }

    getTheme(): ThemeTokens | null {
        return this.themeManager.getTheme();
    }

    // ==================== ANCHOR CONTAINERS ====================

    private createAnchorContainers(): void {
        for (const anchor of HUD_ANCHORS) {
            const container = document.createElement('div');
            container.className = anchorClass(anchor);
            container.dataset.anchor = anchor;
            this.hudRoot.appendChild(container);
            this.anchorContainers.set(anchor, container);
        }
    }

    private getAnchorContainer(anchor: HUDAnchor): HTMLDivElement {
        const container = this.anchorContainers.get(anchor);
        if (!container) throw new Error(`Anchor container not found: ${anchor}`);
        return container;
    }

    // ==================== ELEMENT REGISTRY ====================

    getElement(id: string): HUDElement | undefined {
        return this.elements.get(id);
    }

    showElement(id: string): void {
        const element = this.elements.get(id);
        if (!element) return;
        element.container.style.display = '';
        getGameEventLog().logHud({ op: 'show', id });
        if (element.interactive) {
            this.interactiveElements.add(id);
            this.updateMouseLockState();
        }
    }

    hideElement(id: string): void {
        const element = this.elements.get(id);
        if (!element) return;
        element.container.style.display = 'none';
        getGameEventLog().logHud({ op: 'hide', id });
        if (element.interactive) {
            this.interactiveElements.delete(id);
            this.updateMouseLockState();
        }
    }

    removeElement(id: string): void {
        const element = this.elements.get(id);
        if (!element) return;
        element.dispose();
        element.container.parentNode?.removeChild(element.container);
        this.elements.delete(id);
        getGameEventLog().logHud({ op: 'remove', id });
    }

    // ==================== PROGRESS BAR ====================

    createProgressBar(id: string, options: ProgressBarOptions = {}): void {
        const {
            anchor = 'top-left',
            label,
            color,
            width,
            showText = true,
            initialValue = 100,
            maxValue = 100,
            format,
        } = options;

        const container = document.createElement('div');
        container.id = `hud-progress-${id}`;
        container.className = 'hud-element hud-progress-bar';
        if (width !== undefined) container.style.minWidth = `${width}px`;
        if (color !== undefined) container.style.setProperty('--hud-color-primary', color);

        if (label) {
            const labelEl = document.createElement('div');
            labelEl.className = 'hud-progress-bar__label';
            labelEl.textContent = label;
            container.appendChild(labelEl);
        }

        const track = document.createElement('div');
        track.className = 'hud-progress-bar__track';
        const fill = document.createElement('div');
        fill.className = 'hud-progress-bar__fill';
        const percentage = clampPct((initialValue / maxValue) * 100);
        fill.style.setProperty('--hud-progress-value', `${percentage}%`);
        track.appendChild(fill);
        container.appendChild(track);

        let textEl: HTMLDivElement | null = null;
        if (showText) {
            textEl = document.createElement('div');
            textEl.className = 'hud-progress-bar__text';
            textEl.textContent = format
                ? format(initialValue, maxValue)
                : `${Math.ceil(initialValue)} / ${maxValue}`;
            container.appendChild(textEl);
        }

        this.getAnchorContainer(anchor).appendChild(container);
        this.themeManager.applyElementOverride(container, 'progressBar');

        getGameEventLog().logHud({
            op: 'create', id, elType: 'progress',
            params: { anchor, label, color, width, showText, percent: percentage, text: textEl?.textContent ?? undefined },
        });

        const refs: ProgressBarRefs = { fillEl: fill, textEl, maxValue, format };

        const element: HUDElement = {
            id,
            type: 'progress',
            container,
            anchor,
            update: (value: unknown) => {
                if (typeof value === 'object' && value !== null) {
                    const v = value as { current: number; max?: number };
                    this.updateProgressBarInternal(refs, v.current, v.max ?? refs.maxValue);
                } else if (typeof value === 'number') {
                    this.updateProgressBarInternal(refs, value, refs.maxValue);
                }
            },
            dispose: () => { /* no-op */ },
        };
        this.elements.set(id, element);
    }

    private updateProgressBarInternal(refs: ProgressBarRefs, current: number, max: number): void {
        const percentage = clampPct((current / max) * 100);
        refs.fillEl.style.setProperty('--hud-progress-value', `${percentage}%`);
        refs.maxValue = max;
        if (refs.textEl) {
            refs.textEl.textContent = refs.format
                ? refs.format(current, max)
                : `${Math.ceil(current)} / ${max}`;
        }
    }

    updateProgressBar(id: string, current: number, max?: number): void {
        const element = this.elements.get(id);
        if (element && element.type === 'progress') {
            element.update({ current, max });
            this.logProgressState(id, element);
        }
    }

    /** Log a progress bar's rendered state (percent + text) after a mutation. */
    private logProgressState(id: string, element: HUDElement): void {
        const log = getGameEventLog();
        if (!log.isActive()) return;
        log.logHud({
            op: 'update', id,
            percent: progressPercent(element.container),
            text: childText(element.container, '.hud-progress-bar__text'),
        });
    }

    // ==================== COUNTER ====================

    createCounter(id: string, options: CounterOptions = {}): void {
        const {
            anchor = 'top-right',
            label,
            icon,
            initialValue = 0,
            format = (v: number) => v.toLocaleString(),
        } = options;

        const container = document.createElement('div');
        container.id = `hud-counter-${id}`;
        container.className = 'hud-element hud-counter';

        if (label) {
            const labelEl = document.createElement('div');
            labelEl.className = 'hud-counter__label';
            labelEl.textContent = label;
            container.appendChild(labelEl);
        }
        if (icon) {
            const iconEl = document.createElement('span');
            iconEl.className = 'hud-counter__icon';
            iconEl.textContent = icon;
            container.appendChild(iconEl);
        }
        const valueEl = document.createElement('span');
        valueEl.className = 'hud-counter__value';
        valueEl.textContent = format(initialValue);
        container.appendChild(valueEl);

        this.getAnchorContainer(anchor).appendChild(container);
        this.themeManager.applyElementOverride(container, 'counter');

        getGameEventLog().logHud({
            op: 'create', id, elType: 'counter',
            params: { anchor, label, icon, text: valueEl.textContent ?? undefined },
        });

        const element: HUDElement = {
            id,
            type: 'counter',
            container,
            anchor,
            update: (value: unknown) => {
                if (typeof value === 'number') valueEl.textContent = format(value);
            },
            dispose: () => { /* no-op */ },
        };
        this.elements.set(id, element);
    }

    updateCounter(id: string, value: number): void {
        const element = this.elements.get(id);
        if (!element || element.type !== 'counter') return;
        element.update(value);
        const log = getGameEventLog();
        if (!log.isActive()) return;
        // Log what was RENDERED — the game's `format` callback can't be serialized.
        log.logHud({ op: 'update', id, text: childText(element.container, '.hud-counter__value') });
    }

    // ==================== ICON + TEXT ====================

    createIconText(id: string, options: IconTextOptions = {}): void {
        const { anchor = 'bottom-left', icon = '', text = '', iconSize } = options;

        const container = document.createElement('div');
        container.id = `hud-icontext-${id}`;
        container.className = 'hud-element hud-icon-text';

        const iconEl = document.createElement('span');
        iconEl.className = 'hud-icon-text__icon';
        iconEl.textContent = icon;
        if (iconSize !== undefined) iconEl.style.fontSize = `${iconSize}px`;

        const textEl = document.createElement('span');
        textEl.className = 'hud-icon-text__label';
        textEl.textContent = text;

        container.appendChild(iconEl);
        container.appendChild(textEl);

        this.getAnchorContainer(anchor).appendChild(container);
        this.themeManager.applyElementOverride(container, 'iconText');

        getGameEventLog().logHud({
            op: 'create', id, elType: 'icon-text',
            params: { anchor, icon, text, iconSize },
        });

        const element: HUDElement = {
            id,
            type: 'icon-text',
            container,
            anchor,
            update: (value: unknown) => {
                if (typeof value === 'object' && value !== null) {
                    const v = value as { icon?: string; text?: string };
                    if (v.icon !== undefined) iconEl.textContent = v.icon;
                    if (v.text !== undefined) textEl.textContent = v.text;
                }
            },
            dispose: () => { /* no-op */ },
        };
        this.elements.set(id, element);
    }

    updateIconText(id: string, options: { icon?: string; text?: string }): void {
        const element = this.elements.get(id);
        if (!element || element.type !== 'icon-text') return;
        element.update(options);
        const log = getGameEventLog();
        if (!log.isActive()) return;
        log.logHud({
            op: 'update', id,
            icon: childText(element.container, '.hud-icon-text__icon'),
            text: childText(element.container, '.hud-icon-text__label'),
        });
    }

    // ==================== TIMER ====================

    createTimer(id: string, options: TimerOptions = {}): void {
        const {
            anchor = 'top-center',
            label,
            countDown = false,
            startSeconds = 0,
            format = 'mm:ss',
            onComplete,
        } = options;

        const container = document.createElement('div');
        container.id = `hud-timer-${id}`;
        container.className = 'hud-element hud-timer';

        if (label) {
            const labelEl = document.createElement('div');
            labelEl.className = 'hud-timer__label';
            labelEl.textContent = label;
            container.appendChild(labelEl);
        }

        const textEl = document.createElement('div');
        textEl.className = 'hud-timer__text';
        textEl.textContent = formatTime(startSeconds, format);
        container.appendChild(textEl);

        this.getAnchorContainer(anchor).appendChild(container);
        this.themeManager.applyElementOverride(container, 'timer');

        // Timers log ops only, never ticks: the replay derives the displayed
        // value from frame time, which is also more correct than this widget's
        // wall-clock setInterval when the recording runs time-dilated.
        getGameEventLog().logHud({
            op: 'create', id, elType: 'timer',
            params: { anchor, label, seconds: startSeconds, countDown, format },
        });

        const timerData: TimerData = {
            currentSeconds: startSeconds,
            startSeconds,
            countDown,
            running: false,
            format,
            onComplete,
            textElement: textEl,
        };
        (container as TimerContainer).timerData = timerData;

        const element: HUDElement = {
            id,
            type: 'timer',
            container,
            anchor,
            update: () => {
                textEl.textContent = formatTime(timerData.currentSeconds, timerData.format);
            },
            dispose: () => {
                if (timerData.intervalId) clearInterval(timerData.intervalId);
            },
        };
        this.elements.set(id, element);
    }

    /** Live timer state for `id`, or undefined if it isn't a registered timer. */
    private getTimerData(id: string): TimerData | undefined {
        const element = this.elements.get(id);
        if (!element || element.type !== 'timer') return undefined;
        return (element.container as TimerContainer).timerData;
    }

    startTimer(id: string): void {
        const timerData = this.getTimerData(id);
        if (!timerData || timerData.running) return;

        timerData.running = true;
        getGameEventLog().logHud({ op: 'timer', id, action: 'start', seconds: timerData.currentSeconds });
        const startTime = Date.now();
        const startValue = timerData.currentSeconds;

        timerData.intervalId = window.setInterval(() => {
            const elapsed = (Date.now() - startTime) / 1000;
            if (timerData.countDown) {
                timerData.currentSeconds = Math.max(0, startValue - elapsed);
                if (timerData.currentSeconds <= 0) {
                    this.pauseTimer(id);
                    timerData.onComplete?.();
                }
            } else {
                timerData.currentSeconds = startValue + elapsed;
            }
            timerData.textElement.textContent = formatTime(timerData.currentSeconds, timerData.format);
            timerData.textElement.parentElement?.toggleAttribute('data-urgent', timerData.countDown && timerData.currentSeconds <= 10);
        }, 100);
    }

    pauseTimer(id: string): void {
        const timerData = this.getTimerData(id);
        if (!timerData) return;
        if (timerData.running) {
            getGameEventLog().logHud({ op: 'timer', id, action: 'pause' });
        }
        timerData.running = false;
        if (timerData.intervalId) {
            clearInterval(timerData.intervalId);
            timerData.intervalId = undefined;
        }
    }

    resetTimer(id: string, seconds?: number): void {
        const timerData = this.getTimerData(id);
        if (!timerData) return;
        this.pauseTimer(id);
        timerData.currentSeconds = seconds ?? timerData.startSeconds;
        if (seconds !== undefined) timerData.startSeconds = seconds;
        timerData.textElement.textContent = formatTime(timerData.currentSeconds, timerData.format);
        getGameEventLog().logHud({ op: 'timer', id, action: 'reset', seconds: timerData.currentSeconds });
    }

    // ==================== CUSTOM ELEMENT ====================

    createCustomElement(id: string, options: CustomElementOptions): void {
        const { anchor = 'top-left', html, css = '', onCreate, onUpdate, interactive = false } = options;

        const container = document.createElement('div');
        container.id = `hud-custom-${id}`;
        container.className = 'hud-element hud-custom';
        // Custom elements keep the freeform `css` escape hatch for now — callers
        // pass arbitrary CSS strings, and pointer-events are enabled if interactive.
        const pointerStyle = interactive ? 'pointer-events: auto;' : '';
        container.style.cssText = `${pointerStyle}${css}`;
        // Tag interactive custom elements (plain <div>s, not <button>s) so the
        // mobile touch layer lets their taps through — see isInteractiveUiTarget().
        if (interactive) container.dataset.hudInteractive = 'true';
        container.innerHTML = html;

        this.getAnchorContainer(anchor).appendChild(container);
        onCreate?.(container);

        // The game's head stylesheets are what give this markup its look — the
        // widget's constructor typically injects them right before this call,
        // so re-collect here. Unchanged sheets dedupe to nothing in the log.
        logGameStylesheets();
        // Log after onCreate — it may rewrite the markup we need to replay.
        // Oversized markup records as an empty shell (same cap as updates, which
        // used to be the only capped path): the styled container still replays,
        // and the warning says why its content is missing from trailers.
        //
        // Gated rather than relying on logHud's own gate: the params object is
        // built BEFORE logHud can drop it, so an ungated call ran
        // recordableCustomHtml — and printed its warning, and spent its
        // warn-once — in every player's console with no recording in progress,
        // leaving the real recording to shell the widget in silence.
        const createLog = getGameEventLog();
        if (createLog.isActive()) {
            createLog.logHud({
                op: 'create', id, elType: 'custom',
                params: { anchor, html: this.recordableCustomHtml(id, container.innerHTML), css: container.style.cssText },
            });
        }

        if (interactive) {
            this.interactiveElements.add(id);
            this.updateMouseLockState();
        }

        const element: HUDElement = {
            id,
            type: 'custom',
            container,
            anchor,
            update: (value: unknown) => { onUpdate?.(container, value); },
            dispose: () => {
                if (interactive) {
                    this.interactiveElements.delete(id);
                    this.updateMouseLockState();
                }
            },
            interactive,
        };
        this.elements.set(id, element);
    }

    updateCustomElement(id: string, value: unknown): void {
        const element = this.elements.get(id);
        if (!element || element.type !== 'custom') return;
        element.update(value);
        const log = getGameEventLog();
        if (!log.isActive()) return;
        // Sheets can appear (or change) after the element did — a lazy widget
        // injecting styles on first update, or a game retheming a panel.
        logGameStylesheets();
        // A custom element's onUpdate mutates arbitrary DOM, so the rendered
        // markup is the only faithful record — and so is the container's own
        // cssText, which onUpdate mutates just as freely (the docs invite it);
        // without it, a post-create transform/background change replays frozen
        // at the create-time style. Oversized markup keeps the skip (freezing
        // on the last good markup beats blanking a live widget) but says so.
        const html = element.container.innerHTML;
        if (html.length <= MAX_CUSTOM_HTML_CHARS) {
            log.logHud({ op: 'custom-html', id, html, css: element.container.style.cssText });
            return;
        }
        this.warnOversizedOnce(id, html.length, 'updates are not recorded; trailers will show its last small state');
    }

    /**
     * One warning per element per RECORDING for markup over the cap, whatever
     * path hit it: the set is dropped when a new recording starts, otherwise
     * the second F9 of a session shells the same widget in silence.
     */
    private warnOversizedOnce(id: string, length: number, consequence: string): void {
        const serial = getGameEventLog().getSessionSerial();
        if (serial !== this.oversizeWarnedSerial) {
            this.oversizeWarnedSerial = serial;
            this.oversizeWarnedIds.clear();
        }
        if (this.oversizeWarnedIds.has(id)) return;
        this.oversizeWarnedIds.add(id);
        console.warn(
            `[GameHUD] custom element "${id}" markup is ${length} chars (cap ${MAX_CUSTOM_HTML_CHARS}) — ${consequence}`
        );
    }

    /**
     * Markup for a recorded create/snapshot op: verbatim under the cap, an
     * empty shell (plus one warning) over it. The shell keeps the element —
     * and the styling on its container — in the trailer instead of silently
     * dropping the whole widget, which is how oversized elements used to
     * vanish from overlays with no diagnostic anywhere.
     */
    private recordableCustomHtml(id: string, html: string): string {
        if (html.length <= MAX_CUSTOM_HTML_CHARS) return html;
        this.warnOversizedOnce(id, html.length, 'recorded as an empty shell; trailers will not show its content');
        return '';
    }

    // ==================== MANAGED ACTION ROWS ====================

    createActionRow(id: string, options: HUDActionRowOptions): void {
        const {
            anchor = 'bottom-center',
            controls,
            layout = 'row',
            wrap = true,
            interactive = false,
            label,
        } = options;

        const container = document.createElement('div');
        container.id = `hud-action-row-${id}`;
        container.className = 'hud-element hud-action-row';
        container.setAttribute('role', 'group');
        if (label) container.setAttribute('aria-label', label);
        container.dataset.layout = layout;
        container.dataset.wrap = wrap ? 'true' : 'false';
        // Touch runtime decided here rather than purely in a media query, so the
        // creator's ?platform=mobile preview gets the same 60px targets a phone does.
        if (isMobileRuntime()) container.dataset.touch = 'true';
        // Lets the mobile touch layer pass taps through — see isInteractiveUiTarget().
        container.dataset.hudInteractive = 'true';

        const refs: ActionRowRefs = { container, controls: new Map() };
        for (const control of controls) {
            const el = this.buildActionControl(control);
            refs.controls.set(control.id, el);
            container.appendChild(el);
        }

        // Mounted on the ANCHOR STACK, never inside another element's markup:
        // that is what keeps the row anchor-relative and outside whatever panel
        // the game happens to be rendering at the same corner.
        this.getAnchorContainer(anchor).appendChild(container);
        this.actionRows.set(id, refs);

        // Same shape as createCustomElement: gated so nothing is built or
        // warned outside a recording, and capped so a runaway row shells
        // rather than recording whole.
        const rowLog = getGameEventLog();
        if (rowLog.isActive()) {
            rowLog.logHud({
                op: 'create', id, elType: 'custom',
                params: { anchor, html: this.recordableCustomHtml(id, container.innerHTML), css: container.style.cssText },
            });
        }

        if (interactive) {
            this.interactiveElements.add(id);
            this.updateMouseLockState();
        }

        // Registered as a 'custom' element so the whole existing lifecycle —
        // showElement/hideElement/removeElement, the trailer snapshot, dispose —
        // applies with no new element kind to teach the replay about.
        const element: HUDElement = {
            id,
            type: 'custom',
            container,
            anchor,
            update: () => { /* controls are updated through updateActionControl */ },
            dispose: () => {
                if (container.contains(document.activeElement)) this.releaseGameplayInputForFocus();
                this.actionRows.delete(id);
                if (interactive) {
                    this.interactiveElements.delete(id);
                    this.updateMouseLockState();
                }
            },
            interactive,
        };
        this.elements.set(id, element);
    }

    private buildActionControl(options: HUDActionControlOptions): ActionControlElement {
        const { kind = 'button', variant = 'neutral', size = 'normal', disabled = false } = options;

        if (kind === 'text-input') {
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'hud-action-control hud-action-input';
            input.dataset.controlId = options.id;
            if (options.placeholder !== undefined) input.placeholder = options.placeholder;
            if (options.value !== undefined) input.value = options.value;
            if (options.label) input.setAttribute('aria-label', options.label);
            input.disabled = disabled;
            input.addEventListener('input', () => { options.onInput?.(input.value); });
            input.addEventListener('keydown', (event: KeyboardEvent) => {
                if (event.key === 'Enter') options.onSelect?.(input.value);
            });
            // A focused field owns the keyboard outright — the player must not
            // walk, jump or shoot while typing a room name or a wave count.
            input.addEventListener('focus', () => { this.suppressGameplayInputForFocus(); });
            input.addEventListener('blur', () => { this.releaseGameplayInputForFocus(); });
            this.attachInputIsolation(input, 'all');
            return input;
        }

        const button = document.createElement('button');
        button.type = 'button';
        button.className = `hud-action-control hud-action-button hud-action-button--${variant}`;
        if (size === 'large') button.classList.add('hud-action-button--large');
        button.dataset.controlId = options.id;
        const content: ButtonContent = { label: options.label, imageUrl: options.imageUrl, imageOnly: options.imageOnly };
        renderButtonContent(button, 'hud-action-button', content);
        this.actionButtonContent.set(button, content);
        button.disabled = disabled;
        button.addEventListener('click', () => {
            if (!button.disabled) options.onSelect?.('');
        });
        this.attachInputIsolation(button, 'activation');
        return button;
    }

    /**
     * Element-level gameplay-input suppression.
     *
     * DesktopControls, MobileControls and the HUD's own 'h' shortcut all listen
     * on `document` in the bubble phase, so stopping propagation at the control
     * is enough: the tap that starts a wave cannot also fire the weapon, and a
     * keystroke aimed at a HUD field cannot also drive the player.
     *
     * `keys: 'activation'` withholds only Enter/Space (what a focused button
     * consumes); `keys: 'all'` is for text inputs, which own the keyboard.
     */
    private attachInputIsolation(el: HTMLElement, keys: 'all' | 'activation'): void {
        const stop = (event: Event): void => { event.stopPropagation(); };
        for (const type of POINTER_EVENT_TYPES) el.addEventListener(type, stop);
        const stopKey = (event: KeyboardEvent): void => {
            if (keys === 'all' || ACTIVATION_KEYS.has(event.key)) event.stopPropagation();
        };
        el.addEventListener('keydown', stopKey);
        el.addEventListener('keyup', stopKey);
        el.addEventListener('keypress', stopKey);
    }

    private suppressGameplayInputForFocus(): void {
        if (this.actionInputFocused) return;
        this.actionInputFocused = true;
        const pc = this.playerController;
        if (!pc) return;
        // Remember the pre-focus state: a game that had already frozen controls
        // (cutscene, dialog) must stay frozen once the field is dismissed.
        this.controlsEnabledBeforeActionFocus = pc.getControlsEnabled();
        pc.setControlsEnabled(false);
    }

    private releaseGameplayInputForFocus(): void {
        if (!this.actionInputFocused) return;
        this.actionInputFocused = false;
        if (this.controlsEnabledBeforeActionFocus) this.playerController?.setControlsEnabled(true);
    }

    updateActionControl(rowId: string, controlId: string, update: HUDActionControlUpdate): void {
        const el = this.actionRows.get(rowId)?.controls.get(controlId);
        if (!el) return;

        if (el instanceof HTMLButtonElement) {
            if (update.label !== undefined || update.imageUrl !== undefined || update.imageOnly !== undefined) {
                const content: ButtonContent = { ...this.actionButtonContent.get(el) };
                if (update.label !== undefined) content.label = update.label;
                if (update.imageUrl !== undefined) content.imageUrl = update.imageUrl;
                if (update.imageOnly !== undefined) content.imageOnly = update.imageOnly;
                renderButtonContent(el, 'hud-action-button', content);
                this.actionButtonContent.set(el, content);
            }
        } else if (update.label !== undefined) {
            el.setAttribute('aria-label', update.label);
        }
        if (update.variant !== undefined && el instanceof HTMLButtonElement) {
            for (const variant of ACTION_VARIANTS) el.classList.remove(`hud-action-button--${variant}`);
            el.classList.add(`hud-action-button--${update.variant}`);
        }
        if (update.disabled !== undefined) el.disabled = update.disabled;
        if (update.visible !== undefined) el.hidden = !update.visible;
        if (update.value !== undefined && el instanceof HTMLInputElement) el.value = update.value;

        // Rendered markup is the only faithful record for the trailer replay —
        // same path a custom element's update takes.
        this.updateCustomElement(rowId, undefined);
    }

    setActionRowVisible(rowId: string, visible: boolean): void {
        const refs = this.actionRows.get(rowId);
        if (!refs) return;
        if (visible) {
            this.showElement(rowId);
            return;
        }
        // Hand the keyboard back before the row disappears — otherwise a field
        // hidden mid-edit leaves gameplay controls frozen with nothing focused.
        const active = document.activeElement;
        if (active instanceof HTMLElement && refs.container.contains(active)) active.blur();
        this.releaseGameplayInputForFocus();
        this.hideElement(rowId);
    }

    removeActionRow(rowId: string): void {
        if (!this.actionRows.has(rowId)) return;
        this.removeElement(rowId);
    }

    getActionControlValue(rowId: string, controlId: string): string | null {
        const el = this.actionRows.get(rowId)?.controls.get(controlId);
        return el instanceof HTMLInputElement ? el.value : null;
    }

    // ==================== BUILT-IN ELEMENTS ====================

    private createBuiltInElements(): void {
        const topLeft = this.getAnchorContainer('top-left');

        // Health bar — same structure as a regular progress bar but with the
        // hud-health-bar class for the tiered fill color.
        this.healthContainer = document.createElement('div');
        this.healthContainer.id = 'hud-health-container';
        this.healthContainer.className = 'hud-element hud-progress-bar hud-health-bar';
        this.healthContainer.style.display = 'none';
        this.healthContainer.dataset.healthTier = 'healthy';

        const healthLabel = document.createElement('div');
        healthLabel.className = 'hud-progress-bar__label';
        healthLabel.appendChild(createNamedIcon('heart'));
        healthLabel.appendChild(document.createTextNode(' HP'));
        this.healthContainer.appendChild(healthLabel);

        const healthTrack = document.createElement('div');
        healthTrack.className = 'hud-progress-bar__track';
        this.healthFill = document.createElement('div');
        this.healthFill.className = 'hud-progress-bar__fill';
        this.healthFill.style.setProperty('--hud-progress-value', '100%');
        healthTrack.appendChild(this.healthFill);
        this.healthContainer.appendChild(healthTrack);

        this.healthText = document.createElement('div');
        this.healthText.className = 'hud-progress-bar__text';
        this.healthText.textContent = '100 / 100';
        this.healthContainer.appendChild(this.healthText);

        topLeft.appendChild(this.healthContainer);
        this.themeManager.applyElementOverride(this.healthContainer, 'healthBar');

        // Controls overlay — populated by updateControlsDisplay().
        this.controlsDisplay = document.createElement('div');
        this.controlsDisplay.id = 'hud-controls';
        this.controlsDisplay.className = 'hud-element hud-controls';
        this.controlsDisplay.style.display = 'none';
        topLeft.appendChild(this.controlsDisplay);
        this.themeManager.applyElementOverride(this.controlsDisplay, 'controls');
    }

    // ==================== PLAYER CONTROLLER ====================

    setPlayerController(playerController: PlayerController): void {
        this.playerController = playerController;
        playerController.onHealthChanged = (current: number, max: number) => {
            this.updateHealth(current, max);
        };
        this.updateHealth(playerController.getPlayerHealth(), playerController.getPlayerMaxHealth());
    }

    // ==================== HEALTH ====================

    updateHealth(current: number, max: number): void {
        if (!this.healthFill || !this.healthText) return;
        const percentage = clampPct((current / max) * 100);
        this.healthFill.style.setProperty('--hud-progress-value', `${percentage}%`);

        const tier = percentage > 60 ? 'healthy' : percentage > 30 ? 'warning' : 'critical';
        this.healthContainer.dataset.healthTier = tier;

        this.healthText.textContent = `${Math.ceil(current)} / ${max}`;
        getGameEventLog().logHud({ op: 'health', current, max });

        if (this.damageFlashTimeout) clearTimeout(this.damageFlashTimeout);
        if (current < max) {
            this.healthContainer.dataset.damaged = 'true';
            this.damageFlashTimeout = window.setTimeout(() => {
                delete this.healthContainer.dataset.damaged;
            }, 200);
        }
    }

    showHealth(options?: { width?: number }): void {
        this.healthEnabled = true;
        getGameEventLog().logHud({
            op: 'health-visible', visible: true,
            ...(options?.width !== undefined ? { width: options.width } : {}),
        });
        this.healthContainer.style.display = '';
        if (options?.width !== undefined) {
            this.healthContainer.style.boxSizing = 'border-box';
            this.healthContainer.style.width = `${options.width}px`;
            this.healthContainer.style.minWidth = `${options.width}px`;
            this.healthContainer.style.maxWidth = `${options.width}px`;
        }
    }

    hideHealth(): void {
        this.healthEnabled = false;
        getGameEventLog().logHud({ op: 'health-visible', visible: false });
        this.healthContainer.style.display = 'none';
    }

    isHealthEnabled(): boolean {
        return this.healthEnabled;
    }

    // ==================== CONTROLS OVERLAY ====================

    toggleControls(): void {
        if (this.controlsDisplay.style.display === 'none' || this.controlsManuallyHidden) {
            this.controlsManuallyHidden = false;
            this.showControlsWithAutoHide();
        } else {
            this.controlsManuallyHidden = true;
            this.hideControlsWithFade();
        }
    }

    /** Cancel a pending controls-overlay auto-hide, if one is scheduled. */
    private clearControlsAutoHide(): void {
        if (this.controlsAutoHideTimeout === null) return;
        clearTimeout(this.controlsAutoHideTimeout);
        this.controlsAutoHideTimeout = null;
    }

    private showControlsWithAutoHide(): void {
        this.clearControlsAutoHide();
        this.updateControlsDisplay();
        this.controlsDisplay.style.display = '';
        this.controlsDisplay.style.opacity = '1';
        this.controlsDisplay.style.transition = 'opacity 0.3s ease-out';
        this.controlsAutoHideTimeout = window.setTimeout(() => {
            this.hideControlsWithFade();
        }, 15000);
    }

    private hideControlsWithFade(): void {
        this.clearControlsAutoHide();
        this.controlsDisplay.style.transition = 'opacity 1s ease-out';
        this.controlsDisplay.style.opacity = '0';
        setTimeout(() => {
            this.controlsDisplay.style.display = 'none';
        }, 1050);
    }

    showControlsTemporarily(): void {
        if (!this.controlsGuideEnabled || !this.playerController) return;
        if (isMobileRuntime()) return;
        if (this.controlsManuallyHidden) return;

        if (this.playerController.markCurrentMovementSystemControlsAsShown) {
            this.playerController.markCurrentMovementSystemControlsAsShown();
        }
        this.showControlsWithAutoHide();
    }

    showControlsPermanently(): void {
        if (!this.controlsGuideEnabled || !this.playerController) return;
        this.clearControlsAutoHide();
        this.controlsManuallyHidden = false;
        this.updateControlsDisplay();
        this.controlsDisplay.style.display = '';
        this.controlsDisplay.style.opacity = '1';
        this.controlsDisplay.style.transition = 'none';
    }

    hideControls(): void {
        this.controlsDisplay.style.display = 'none';
        this.controlsDisplay.style.opacity = '0';
        this.clearControlsAutoHide();
    }

    setControlsGuideEnabled(enabled: boolean): void {
        this.controlsGuideEnabled = enabled;
        if (!enabled) this.hideControls();
    }

    setCustomControls(controls: ControlEntry[]): void {
        this.customControls = controls;
        this.updateControlsDisplay();
    }

    clearCustomControls(): void {
        this.customControls = null;
        this.updateControlsDisplay();
    }

    updateControlsDisplay(): void {
        // `keyHtml` carries innerHTML-safe markup so we can embed SVG arrow icons
        // for movement keys instead of Unicode arrow characters (which render
        // inconsistently — sometimes as emoji, sometimes as text glyphs).
        // Plain text values are also valid HTML.
        const rows: Array<{ keyHtml: string; action: string; separator?: boolean }> = [];

        if (this.customControls && this.customControls.length > 0) {
            for (const c of this.customControls) rows.push({ keyHtml: escapeHtml(c.key), action: c.action });
        } else {
            if (!this.playerController) return;
            const pc = this.playerController;
            const actionType = pc.actionType;
            const secondaryActionType = pc.secondaryActionType;
            const movementSystem = pc.getMovementSystem();
            if (!movementSystem) return;

            const isGamepad = pc.getLastActiveInput() === 'gamepad';
            const ascendName = movementSystem.getAscendDisplayName();
            const supportedKeys = movementSystem.getSupportedKeys();

            if (isGamepad) {
                rows.push({ keyHtml: 'Left Stick', action: t('game.controlsGuide.moveForward') });
                rows.push({ keyHtml: 'Right Stick', action: t('game.controlsGuide.mouseLook') });
            } else {
                rows.push({ keyHtml: `W/${arrowIconHtml('up')}`,    action: t('game.controlsGuide.moveForward') });
                rows.push({ keyHtml: `S/${arrowIconHtml('down')}`,  action: t('game.controlsGuide.moveBackward') });
                rows.push({ keyHtml: `A/${arrowIconHtml('left')}`,  action: t('game.controlsGuide.moveLeft') });
                rows.push({ keyHtml: `D/${arrowIconHtml('right')}`, action: t('game.controlsGuide.moveRight') });
            }

            if (!pc.isJumpInputSuppressed()) {
                rows.push({ keyHtml: escapeHtml(pc.getInputLabel('ascend')), action: ascendName });
            }
            if (supportedKeys.descend) {
                rows.push({ keyHtml: escapeHtml(pc.getInputLabel('descend')), action: movementSystem.getDescendDisplayName() });
            }
            if (pc.hasInteractablesInScene()) {
                rows.push({ keyHtml: escapeHtml(pc.getInputLabel('interact')), action: t('game.controlsGuide.interact') });
            }
            if (!isGamepad && !isMobileRuntime()) {
                rows.push({ keyHtml: escapeHtml(t('game.controlsGuide.mouse')), action: t('game.controlsGuide.mouseLook') });
                rows.push({ keyHtml: 'ESC', action: t('game.controlsGuide.escMenu') });
            }
            if (actionType) {
                const keyStr = isGamepad ? pc.getInputLabel('action') : `${pc.getInputLabel('action')}/Click`;
                rows.push({
                    keyHtml: escapeHtml(keyStr),
                    action: actionLabel(actionType, ACTION_LABEL_KEYS),
                    separator: true,
                });
            }
            if (secondaryActionType) {
                const keyStr = isGamepad
                    ? pc.getInputLabel('secondaryAction')
                    : `${pc.getInputLabel('secondaryAction')}/Right-Click`;
                rows.push({
                    keyHtml: escapeHtml(keyStr),
                    action: actionLabel(secondaryActionType, SECONDARY_ACTION_LABEL_KEYS),
                    separator: !actionType,
                });
            }
        }

        this.controlsDisplay.replaceChildren();
        const title = document.createElement('div');
        title.className = 'hud-controls__title';
        title.textContent = t('game.controlsGuide.title');
        this.controlsDisplay.appendChild(title);

        for (const row of rows) {
            const rowEl = document.createElement('div');
            rowEl.className = row.separator ? 'hud-controls__row hud-controls__row--separated' : 'hud-controls__row';
            const keyEl = document.createElement('span');
            keyEl.className = 'hud-controls__key';
            keyEl.innerHTML = row.keyHtml;
            const actionEl = document.createElement('span');
            actionEl.className = 'hud-controls__action';
            actionEl.textContent = row.action;
            rowEl.appendChild(keyEl);
            rowEl.appendChild(actionEl);
            this.controlsDisplay.appendChild(rowEl);
        }
    }

    // ==================== ESC HINT ====================

    private createEscHint(): void {
        if (isMobileRuntime()) return;
        this.escHint = document.createElement('div');
        this.escHint.id = 'hud-esc-hint';
        this.escHint.className = 'hud-esc-hint';
        this.escHint.textContent = t('game.pointerLock.escForMenu');
        this.gameplayLayer.appendChild(this.escHint);
    }

    private showEscHint(): void {
        if (this.freeMouseMode || !this.escHint) return;
        this.escHint.dataset.visible = 'true';
    }

    private hideEscHint(): void {
        if (!this.escHint) return;
        delete this.escHint.dataset.visible;
    }

    setFreeMouseMode(enabled: boolean): void {
        this.freeMouseMode = enabled;
        if (enabled) this.hideEscHint();
    }

    setGameplayUIVisible(visible: boolean): void {
        if (visible) this.gameplayLayer.dataset.visible = 'true';
        else delete this.gameplayLayer.dataset.visible;

        if (!isMobileRuntime()) {
            if (visible) this.showEscHint();
            else this.hideEscHint();
        }
    }

    // ==================== RETICLE ====================

    /** Whether the spreading-crosshair parts have been built (see setReticleSpread). */
    private reticleTicksCreated = false;

    private createReticle(): void {
        this.reticle = document.createElement('div');
        this.reticle.id = 'hud-reticle';
        this.reticle.className = 'hud-element hud-reticle';
        this.reticle.style.display = 'none';
        this.gameplayLayer.appendChild(this.reticle);
        this.themeManager.applyElementOverride(this.reticle, 'reticle');
    }

    showReticle(): void {
        if (this.reticle) this.reticle.style.display = '';
    }
    hideReticle(): void {
        if (this.reticle) this.reticle.style.display = 'none';
    }
    setReticleOffset(offsetPercent: number): void {
        if (this.reticle) this.reticle.style.left = `${50 + offsetPercent}%`;
    }
    setReticleVerticalOffset(offsetPercent: number): void {
        if (this.reticle) this.reticle.style.top = `${52 + offsetPercent}%`;
    }
    setReticleBlocked(blocked: boolean): void {
        if (!this.reticle) return;
        if (blocked) this.reticle.dataset.blocked = 'true';
        else delete this.reticle.dataset.blocked;
    }

    setReticleSpread(spread: number): void {
        if (!this.reticle) return;
        // Built on FIRST USE, never at creation. Every existing game and every
        // HUD theme keeps the exact reticle markup it has today until something
        // actually asks for a spreading crosshair; the '+' glyph and the ticks
        // are mutually exclusive, selected by the [data-spread] attribute.
        this.createReticleTicks();
        const clamped = Math.max(0, Math.min(1, spread));
        this.reticle.style.setProperty('--hud-reticle-spread', clamped.toFixed(3));
    }

    /** Swap the static '+' for four ticks and a centre dot that can open up. */
    private createReticleTicks(): void {
        if (!this.reticle || this.reticleTicksCreated) return;
        for (const part of ['up', 'down', 'left', 'right']) {
            const tick = document.createElement('div');
            tick.className = `hud-reticle__tick hud-reticle__tick--${part}`;
            this.reticle.appendChild(tick);
        }
        const dot = document.createElement('div');
        dot.className = 'hud-reticle__dot';
        this.reticle.appendChild(dot);
        this.reticle.dataset.spread = 'true';
        this.reticleTicksCreated = true;
    }

    // ==================== COMIC BUBBLE ====================

    private static readonly COMIC_SOUNDS = [
        'POW!', 'BANG!', 'BLAM!', 'PEW!', 'RATATATA!',
        'DAKKA!', 'BOOM!', 'ZAP!', 'CRACK!', 'THWACK!',
        'KAPOW!', 'WHAM!', 'SPLAT!', 'PLINK!', 'PEWPEW!',
    ];

    private static readonly COMIC_COLORS = [
        { bg: '#FFE135', border: '#FF6B00', text: '#8B0000' },
        { bg: '#FF6B6B', border: '#C0392B', text: '#FFFFFF' },
        { bg: '#4ECDC4', border: '#1A535C', text: '#FFFFFF' },
        { bg: '#F39C12', border: '#D35400', text: '#FFFFFF' },
        { bg: '#E74C3C', border: '#922B21', text: '#FFFFFF' },
        { bg: '#9B59B6', border: '#6C3483', text: '#FFFFFF' },
        { bg: '#3498DB', border: '#21618C', text: '#FFFFFF' },
    ];

    private lastComicSoundIndex = -1;

    spawnComicBubble(): void {
        if (!this.gameplayLayer) return;

        let soundIndex = Math.floor(Math.random() * GameHUD.COMIC_SOUNDS.length);
        if (soundIndex === this.lastComicSoundIndex && GameHUD.COMIC_SOUNDS.length > 1) {
            soundIndex = (soundIndex + 1) % GameHUD.COMIC_SOUNDS.length;
        }
        this.lastComicSoundIndex = soundIndex;
        const sound = GameHUD.COMIC_SOUNDS[soundIndex] ?? 'POW!';

        const colorIndex = Math.floor(Math.random() * GameHUD.COMIC_COLORS.length);
        const colors = GameHUD.COMIC_COLORS[colorIndex] ?? GameHUD.COMIC_COLORS[0]!;

        const bubble = document.createElement('div');
        bubble.className = 'hud-comic-bubble';
        bubble.textContent = sound;

        const startX = 50 + (Math.random() - 0.5) * 10;
        const startY = 38 + (Math.random() - 0.5) * 6;
        const rotation = (Math.random() - 0.5) * 20;
        const scale = 0.6 + Math.random() * 0.2;

        bubble.style.left = `${startX}%`;
        bubble.style.top = `${startY}%`;
        bubble.style.fontSize = `${14 + Math.random() * 6}px`;
        bubble.style.color = colors.text;
        bubble.style.background = colors.bg;
        bubble.style.borderColor = colors.border;
        bubble.style.borderStyle = 'solid';
        bubble.style.borderWidth = '2px';
        // Per-spawn rotation/scale for the first painted frame; the hud-comic-pop
        // keyframes own the transform from there on.
        bubble.style.transform = `translate(-50%, -50%) rotate(${rotation}deg) scale(${scale})`;

        this.gameplayLayer.appendChild(bubble);
        setTimeout(() => { bubble.parentNode?.removeChild(bubble); }, 500);
    }

    // ==================== TOAST ====================

    showToast(message: string, options?: ToastOptions): void {
        const duration = options?.duration ?? 2500;
        const variant = options?.variant ?? 'info';
        const anchor = options?.anchor ?? 'top-center';

        let stack = this.toastStacks.get(anchor);
        if (!stack) {
            stack = document.createElement('div');
            stack.className = anchor.startsWith('top')
                ? 'hud-toast-stack hud-toast-stack--newest-top'
                : 'hud-toast-stack';
            this.getAnchorContainer(anchor).appendChild(stack);
            this.toastStacks.set(anchor, stack);
        }

        getGameEventLog().logHud({ op: 'toast', message, variant, durationMs: duration, anchor });

        const toast = document.createElement('div');
        toast.className = 'hud-element hud-toast';
        toast.dataset.kind = variant;
        toast.textContent = message;
        stack.appendChild(toast);
        this.themeManager.applyElementOverride(toast, 'toast');

        const exitMs = 250;
        const visibleMs = Math.max(0, duration - exitMs);
        window.setTimeout(() => {
            toast.dataset.leaving = 'true';
            window.setTimeout(() => { toast.remove(); }, exitMs);
        }, visibleMs);
    }

    // ==================== INTERACTIVE / MOUSE ====================

    setMouseUnlockCallback(callback: MouseUnlockCallback): void {
        this.mouseUnlockCallback = callback;
    }

    hasInteractiveElements(): boolean {
        return this.interactiveElements.size > 0;
    }

    requestMouseUnlock(elementId: string): void {
        this.interactiveElements.add(elementId);
        this.updateMouseLockState();
    }

    requestMouseLock(elementId: string): void {
        this.interactiveElements.delete(elementId);
        this.updateMouseLockState();
    }

    private updateMouseLockState(): void {
        if (!this.mouseUnlockCallback) return;
        this.mouseUnlockCallback(this.interactiveElements.size > 0);
    }

    // ==================== MUTE CONTROL ====================

    setupMuteControl(engine: EngineLike, gameData: GameData | null): void {
        this.removeMuteControl();
        this.muteControl = new MuteControl(this, engine, gameData);
    }

    getMuteControl(): MuteControl | null {
        return this.muteControl;
    }

    removeMuteControl(): void {
        if (this.muteControl) {
            this.muteControl.dispose();
            this.muteControl = null;
        }
    }

    // ==================== GENERAL ====================

    getScale(): Readonly<HUDScaleFactors> {
        return this.scale;
    }

    /**
     * Emit the current HUD as `create` ops so a trailer recording that starts
     * mid-game replays a complete UI. HUDs are built at load, long before F9,
     * so without this the overlay would start empty. Called by ScreenRecorder
     * at session start; harmless (a no-op) when no session is active.
     */
    snapshotForRecording(): void {
        const log = getGameEventLog();
        if (!log.isActive()) return;

        const theme = getLastAppliedTheme();
        if (theme) log.logHud({ op: 'theme', theme });

        // Game stylesheets before the element creates below — custom elements
        // alive at F9 need their rules in the timeline from frame 0.
        logGameStylesheets();

        log.logHud({ op: 'hud-visible', visible: this.hudRoot.style.display !== 'none' });

        if (this.healthEnabled) {
            // Carry the bar's width like showHealth does; without it a
            // recording that starts with health already up replays at the
            // engine default width instead of the game's.
            const width = parseFloat(this.healthContainer.style.minWidth);
            log.logHud({ op: 'health-visible', visible: true, ...(Number.isFinite(width) ? { width } : {}) });
            const [currentText, maxText] = (this.healthText.textContent ?? '').split('/');
            log.logHud({
                op: 'health',
                current: parseFloat(currentText ?? '') || 0,
                max: parseFloat(maxText ?? '') || 100,
            });
        }

        // Map order is insertion order = stacking order within an anchor.
        for (const element of this.elements.values()) {
            const described = this.describeElement(element);
            if (!described) continue;
            const { elType, params, running } = described;
            log.logHud({ op: 'create', id: element.id, elType, params });
            // A timer already counting needs its start re-anchored to this
            // frame, or the replay would render it frozen.
            if (running) {
                log.logHud({ op: 'timer', id: element.id, action: 'start', seconds: Number(params.seconds) || 0 });
            }
            if (element.container.style.display === 'none') {
                log.logHud({ op: 'hide', id: element.id });
            }
        }
    }

    /** Serializable description of a live element, for snapshotForRecording. */
    private describeElement(
        element: HUDElement,
    ): { elType: HudElementKind; params: Record<string, unknown>; running?: boolean } | null {
        const c = element.container;
        const text = (sel: string): string | undefined => childText(c, sel);
        const anchor = element.anchor;
        switch (element.type) {
            case 'counter':
                return { elType: 'counter', params: {
                    anchor, label: text('.hud-counter__label'), icon: text('.hud-counter__icon'),
                    text: text('.hud-counter__value'),
                } };
            case 'progress':
                return { elType: 'progress', params: {
                    anchor, label: text('.hud-progress-bar__label'),
                    percent: progressPercent(c),
                    text: text('.hud-progress-bar__text'),
                    showText: c.querySelector('.hud-progress-bar__text') !== null,
                    color: c.style.getPropertyValue('--hud-color-primary') || undefined,
                    width: c.style.minWidth ? parseFloat(c.style.minWidth) : undefined,
                } };
            case 'icon-text': {
                // The icon's size is inline on its node (createIconText); the
                // snapshot must carry it or a pre-F9 element replays at the
                // default size while a mid-recording one keeps its own.
                const iconEl = c.querySelector<HTMLElement>('.hud-icon-text__icon');
                const iconSize = iconEl?.style.fontSize ? parseFloat(iconEl.style.fontSize) : undefined;
                return { elType: 'icon-text', params: {
                    anchor, icon: text('.hud-icon-text__icon'), text: text('.hud-icon-text__label'),
                    ...(iconSize !== undefined && Number.isFinite(iconSize) ? { iconSize } : {}),
                } };
            }
            case 'timer': {
                const data = (c as TimerContainer).timerData;
                if (!data) return null;
                return {
                    elType: 'timer',
                    params: {
                        anchor, label: text('.hud-timer__label'),
                        seconds: data.currentSeconds, countDown: data.countDown, format: data.format,
                    },
                    running: data.running,
                };
            }
            case 'custom':
                // Oversized markup snapshots as an empty shell rather than
                // omitting the element — dropping it whole also silently
                // discarded every later custom-html op for the id.
                return { elType: 'custom', params: {
                    anchor, html: this.recordableCustomHtml(element.id, c.innerHTML), css: c.style.cssText,
                } };
            default:
                return null;
        }
    }

    show(): void {
        this.hudRoot.style.display = '';
        getGameEventLog().logHud({ op: 'hud-visible', visible: true });
    }

    hide(): void {
        this.hudRoot.style.display = 'none';
        getGameEventLog().logHud({ op: 'hud-visible', visible: false });
    }

    dispose(): void {
        if (this.gameStateListener) {
            getGameStateManager().removeListener(this.gameStateListener);
            this.gameStateListener = null;
        }
        this.removeMuteControl();
        this.clearControlsAutoHide();
        if (this.damageFlashTimeout !== null) clearTimeout(this.damageFlashTimeout);

        for (const element of this.elements.values()) {
            element.dispose();
            element.container.parentNode?.removeChild(element.container);
        }
        this.elements.clear();
        this.actionRows.clear();
        this.anchorContainers.clear();
        this.toastStacks.clear();

        this.themeManager.destroy();
        this.hudRoot.parentNode?.removeChild(this.hudRoot);
        this.gameplayLayer.parentNode?.removeChild(this.gameplayLayer);

        document.removeEventListener('keydown', this.keydownHandler);
    }
}

// ============================================================================
// Module-private helpers
// ============================================================================

function clampPct(value: number): number {
    return Math.max(0, Math.min(100, value));
}

/** textContent of the first matching descendant, or undefined when there is none. */
function childText(root: HTMLElement, selector: string): string | undefined {
    return root.querySelector<HTMLElement>(selector)?.textContent ?? undefined;
}

/** Rendered fill percentage of a progress-bar container (0 when unset). */
function progressPercent(container: HTMLElement): number {
    const fill = container.querySelector<HTMLElement>('.hud-progress-bar__fill');
    return parseFloat(fill?.style.getPropertyValue('--hud-progress-value') ?? '') || 0;
}

// HTML escape for values funneled into innerHTML — protects against custom
// control labels containing `<`, `>`, or quotes that would otherwise break out
// of the key cap. Game-supplied labels are trusted-ish (they ship with the
// genre code) but escaping costs nothing and keeps the controls display safe
// from accidental markup.
function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatTime(seconds: number, format: 'mm:ss' | 'hh:mm:ss' | 'seconds'): string {
    const s = Math.max(0, Math.floor(seconds));
    if (format === 'seconds') return `${s}`;
    const mins = Math.floor(s / 60);
    const secs = s % 60;
    if (format === 'hh:mm:ss') {
        const hrs = Math.floor(mins / 60);
        const m = mins % 60;
        return `${hrs.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

const ACTION_LABEL_KEYS: Record<string, string> = {
    melee: 'game.controlsGuide.meleeAttack',
    projectile: 'game.controlsGuide.shootProjectile',
    shoot: 'game.controlsGuide.shootProjectile',
    dance: 'game.controlsGuide.dance',
    build: 'game.controlsGuide.build',
    magic: 'game.controlsGuide.castSpell',
    pushup: 'game.controlsGuide.pushup',
};

const SECONDARY_ACTION_LABEL_KEYS: Record<string, string> = {
    aim: 'game.controlsGuide.aimDownSights',
    block: 'game.controlsGuide.block',
    altfire: 'game.controlsGuide.alternateFire',
    special: 'game.controlsGuide.specialAbility',
    reload: 'game.controlsGuide.reload',
};

/**
 * Translated label for an action type. Genres can register action types the
 * engine has no i18n key for, so an unknown one falls back to its own
 * capitalized name rather than rendering a raw translation key.
 */
function actionLabel(actionType: string, keys: Record<string, string>): string {
    const key = keys[actionType];
    return key ? t(key) : `${actionType.charAt(0).toUpperCase()}${actionType.slice(1)}`;
}

function mapElementTypeToClass(type: HUDElementType): HudElementClass | null {
    switch (type) {
        case 'progress': return 'progressBar';
        case 'counter':  return 'counter';
        case 'icon-text': return 'iconText';
        case 'timer':    return 'timer';
        case 'custom':   return null;
    }
}

function calculateScale(): HUDScaleFactors {
    const mobile = isMobileRuntime();
    if (mobile) {
        const vw = window.innerWidth / 100;
        const base = Math.min(vw * 2.5, 10);
        return {
            fontXs: Math.max(6, base * 0.6),
            fontSm: Math.max(7, base * 0.7),
            fontMd: Math.max(8, base * 0.8),
            fontLg: Math.max(9, base * 0.9),
            fontXl: Math.max(10, base * 1.0),
            font2xl: Math.max(11, base * 1.1),
            font3xl: Math.max(12, base * 1.2),
            font4xl: Math.max(13, base * 1.3),
            paddingSm: Math.max(2, base * 0.3),
            paddingMd: Math.max(3, base * 0.4),
            paddingLg: Math.max(4, base * 0.5),
            gap: Math.max(2, base * 0.25),
            margin: Math.max(4, base * 0.6),
            barWidth: Math.max(50, vw * 18),
            barHeight: Math.max(8, base * 0.8),
            iconSize: Math.max(10, base * 1.0),
            borderRadius: Math.max(3, base * 0.4),
            borderWidth: 1,
        };
    }
    return {
        fontXs: 10, fontSm: 11, fontMd: 12, fontLg: 14,
        fontXl: 16, font2xl: 20, font3xl: 24, font4xl: 28,
        paddingSm: 6, paddingMd: 10, paddingLg: 15,
        gap: 8, margin: 20,
        barWidth: 150, barHeight: 20, iconSize: 20,
        borderRadius: 8, borderWidth: 2,
    };
}
