/**
 * @fileoverview IGameHUD - Interface and types for the game HUD system
 *
 * Provides a typed contract for HUD operations that engine systems
 * (RangedWeaponSystem, PlayerController, etc.) can depend on without
 * coupling to the GameHUD implementation.
 */

// ════════════════════════════════════════════════════════════════════════════════
// HUD Types
// ════════════════════════════════════════════════════════════════════════════════

/**
 * A single control entry for the controls display.
 * Used to customize the controls shown to the player.
 */
export interface ControlEntry {
    /** Display string for the key(s), e.g., "WASD", "Z/X", "Tab", "Enter/Click" */
    key: string;
    /** Description of what the control does */
    action: string;
}

/**
 * Every anchor position, as the runtime list GameHUD builds its containers from.
 * `HUDAnchor` derives from it so the list and the type cannot drift apart.
 */
export const HUD_ANCHORS = [
    'top-left', 'top-center', 'top-right',
    'middle-left', 'middle-center', 'middle-right',
    'bottom-left', 'bottom-center', 'bottom-right',
] as const;

/**
 * Anchor positions for HUD elements.
 * Elements placed at the same anchor will stack automatically.
 */
export type HUDAnchor = typeof HUD_ANCHORS[number];

/**
 * HUD element types supported by factory methods.
 */
export type HUDElementType = 'progress' | 'counter' | 'icon-text' | 'timer' | 'custom';

/**
 * Represents a registered HUD element with its type, container, and lifecycle methods.
 */
export interface HUDElement {
    /** Unique identifier for this element */
    id: string;
    /** Type of the element (progress, counter, icon-text, timer, custom) */
    type: HUDElementType;
    /** The DOM container element */
    container: HTMLDivElement;
    /** Anchor position on screen */
    anchor: HUDAnchor;
    /** Update function - called when element value changes */
    update: (value: unknown) => void;
    /** Cleanup function - called when element is removed */
    dispose: () => void;
    /**
     * True for elements that need mouse interaction — show/hide then drives the
     * mouse unlock state. See `CustomElementOptions.interactive`.
     */
    interactive?: boolean;
}

/**
 * Options for creating a progress bar element.
 */
export interface ProgressBarOptions {
    /** Screen anchor position (default: 'top-left') */
    anchor?: HUDAnchor;
    /** Label text displayed above the bar */
    label?: string;
    /** Bar fill color (CSS color value, default: '#4ade80') */
    color?: string;
    /** Bar width in pixels (default: 150) */
    width?: number;
    /** Show numeric text below bar (default: true) */
    showText?: boolean;
    /** Initial current value (default: 100) */
    initialValue?: number;
    /** Maximum value (default: 100) */
    maxValue?: number;
    /** Custom format function for text display (default: "current / max") */
    format?: (current: number, max: number) => string;
}

/**
 * Options for creating a counter element.
 */
export interface CounterOptions {
    /** Screen anchor position (default: 'top-right') */
    anchor?: HUDAnchor;
    /** Label text (e.g., "Score") */
    label?: string;
    /** Icon emoji or character displayed before value */
    icon?: string;
    /** Initial value (default: 0) */
    initialValue?: number;
    /** Custom format function for display (default: adds commas) */
    format?: (value: number) => string;
}

/**
 * Options for creating an icon+text element.
 */
export interface IconTextOptions {
    /** Screen anchor position (default: 'bottom-left') */
    anchor?: HUDAnchor;
    /** Icon emoji or character */
    icon?: string;
    /** Text content */
    text?: string;
    /** Icon font size in pixels (default: 20) */
    iconSize?: number;
}

/**
 * Options for creating a timer element.
 */
export interface TimerOptions {
    /** Screen anchor position (default: 'top-center') */
    anchor?: HUDAnchor;
    /** Label text (e.g., "Time Left") */
    label?: string;
    /** If true, counts down; if false, counts up (default: false) */
    countDown?: boolean;
    /** Starting time in seconds (default: 0 for count up, required for countdown) */
    startSeconds?: number;
    /** Time format (default: 'mm:ss') */
    format?: 'mm:ss' | 'hh:mm:ss' | 'seconds';
    /** Callback when countdown reaches zero */
    onComplete?: () => void;
}

/**
 * Visual variant for `IGameHUD.showToast`.
 */
export type ToastVariant = 'info' | 'success' | 'warning' | 'error';

/**
 * Options for `IGameHUD.showToast`.
 *
 * Defaults: `duration: 2500`, `variant: 'info'`, `anchor: 'top-center'`.
 */
export interface ToastOptions {
    /** How long the toast stays on screen, in milliseconds. */
    duration?: number;
    /** Visual style — drives the toast's accent color. */
    variant?: ToastVariant;
    /** Screen anchor where the toast stack appears. */
    anchor?: HUDAnchor;
}

/**
 * Options for creating a fully custom element.
 */
export interface CustomElementOptions {
    /** Screen anchor position (default: 'top-left') */
    anchor?: HUDAnchor;
    /** Initial innerHTML content */
    html: string;
    /** Additional CSS for the container (applied via style.cssText) */
    css?: string;
    /** Called after element is created - use for setup */
    onCreate?: (container: HTMLDivElement) => void;
    /** Called when updateCustomElement is called */
    onUpdate?: (container: HTMLDivElement, value: unknown) => void;
    /**
     * If true, this element needs mouse interaction (buttons, inputs, etc.)
     * When shown: automatically unlocks mouse and freezes game controls
     * When hidden/removed: automatically locks mouse if no other interactive elements
     */
    interactive?: boolean;
}

/**
 * Visual role of a managed action control. Maps onto the theme's color tokens
 * (`--hud-color-primary` / `--hud-color-danger` / `--hud-color-warning`), so a
 * control recolors with the HUD theme instead of carrying a hard-coded color.
 */
export type HUDActionVariant = 'primary' | 'danger' | 'warning' | 'neutral';

/**
 * Kind of managed action control. `button` is tap/click activated;
 * `text-input` is a single-line field that owns the keyboard while focused.
 */
export type HUDActionControlKind = 'button' | 'text-input';

/**
 * A single control inside a managed action row.
 */
export interface HUDActionControlOptions {
    /** Identifier, unique within its row — used by `updateActionControl`. */
    id: string;
    /** Control kind (default: 'button'). */
    kind?: HUDActionControlKind;
    /** Visible text, and the accessible name. */
    label?: string;
    /**
     * Buttons only — image URL (PNG/SVG/WebP, e.g. a game asset) shown ahead of
     * the label. With no `label` (or `imageOnly: true`) the button shows just
     * the image, squared to the tap target.
     */
    imageUrl?: string;
    /** Buttons only — show only the image; `label` stays the accessible name. */
    imageOnly?: boolean;
    /** Color role (default: 'neutral'). */
    variant?: HUDActionVariant;
    /** 'large' grows the tap target ~25% — use for the primary call to action. */
    size?: 'normal' | 'large';
    /** Start disabled (default: false). */
    disabled?: boolean;
    /**
     * Activation callback: click/tap for buttons, Enter for text inputs.
     * `value` carries the field's text for text inputs, `''` for buttons.
     */
    onSelect?: (value: string) => void;
    /** Text inputs only — placeholder text. */
    placeholder?: string;
    /** Text inputs only — initial value. */
    value?: string;
    /** Text inputs only — fires on every edit. */
    onInput?: (value: string) => void;
}

/**
 * Options for `IGameHUD.createActionRow`.
 */
export interface HUDActionRowOptions {
    /** Screen anchor position (default: 'bottom-center'). */
    anchor?: HUDAnchor;
    /** The controls, laid out in order. */
    controls: HUDActionControlOptions[];
    /** Main axis (default: 'row'). */
    layout?: 'row' | 'column';
    /** Wrap onto more lines rather than overflow when narrow (default: true). */
    wrap?: boolean;
    /**
     * If true, the row unlocks the mouse and freezes gameplay controls while
     * shown — same semantics as `CustomElementOptions.interactive`. Only needed
     * for pointer-locked games; the controls are clickable either way.
     */
    interactive?: boolean;
    /** Accessible group label for the row. */
    label?: string;
}

/**
 * Mutations accepted by `IGameHUD.updateActionControl`. Omitted fields are
 * left untouched.
 */
export interface HUDActionControlUpdate {
    /** New visible text / accessible name. */
    label?: string;
    /** New image URL (buttons only); `null` removes the image. */
    imageUrl?: string | null;
    /** Show only the image (buttons only). */
    imageOnly?: boolean;
    /** New color role (buttons only). */
    variant?: HUDActionVariant;
    /** Enable/disable the control. */
    disabled?: boolean;
    /** Show/hide this single control without touching the rest of the row. */
    visible?: boolean;
    /** New field text (text inputs only). */
    value?: string;
}

/**
 * Callback for mouse lock control.
 * Called with true to unlock mouse, false to lock it.
 */
export type MouseUnlockCallback = (unlock: boolean) => void;

/**
 * Responsive scale factors for HUD element sizing.
 */
export interface HUDScaleFactors {
    fontXs: number;
    fontSm: number;
    fontMd: number;
    fontLg: number;
    fontXl: number;
    font2xl: number;
    font3xl: number;
    font4xl: number;
    paddingSm: number;
    paddingMd: number;
    paddingLg: number;
    gap: number;
    margin: number;
    barWidth: number;
    barHeight: number;
    iconSize: number;
    borderRadius: number;
    borderWidth: number;
}

// ════════════════════════════════════════════════════════════════════════════════
// IGameHUD Interface
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Interface for the game HUD system.
 *
 * Engine systems (RangedWeaponSystem, PlayerController, etc.) depend on this
 * interface rather than the concrete GameHUD class. All methods are required —
 * callers only need to null-check the hud reference itself.
 */
export interface IGameHUD {
    // Element management
    getElement(id: string): HUDElement | undefined;
    showElement(id: string): void;
    hideElement(id: string): void;
    removeElement(id: string): void;

    /**
     * Emit the current HUD to the trailer timeline as `create` ops so a
     * recording started mid-game replays a complete UI overlay. Called by the
     * ScreenRecorder; optional so HUDs in already-published games (which
     * compile against a frozen engine) keep satisfying this interface.
     */
    snapshotForRecording?(): void;

    // Counter
    createCounter(id: string, options?: CounterOptions): void;
    updateCounter(id: string, value: number): void;

    // Progress bar
    createProgressBar(id: string, options?: ProgressBarOptions): void;
    updateProgressBar(id: string, current: number, max?: number): void;

    // Icon + text
    createIconText(id: string, options?: IconTextOptions): void;
    updateIconText(id: string, options: { icon?: string; text?: string }): void;

    // Timer
    createTimer(id: string, options?: TimerOptions): void;
    startTimer(id: string): void;
    pauseTimer(id: string): void;
    resetTimer(id: string, seconds?: number): void;

    // Custom element
    createCustomElement(id: string, options: CustomElementOptions): void;
    updateCustomElement(id: string, value: unknown): void;

    // ── Managed action controls ──────────────────────────────────────────────
    // Optional so HUDs in already-published games (which compile against a
    // frozen engine) keep satisfying this interface. Prefer these over
    // `createCustomElement` for anything the player taps or types into: the
    // engine owns the layout, so the controls cannot land off-screen, cannot
    // end up nested inside a game panel, and cannot leak keystrokes into
    // gameplay.

    /**
     * Create a responsive row of buttons / text inputs at a screen anchor.
     *
     * The row is mounted directly on the anchor stack — never inside another
     * element's markup — so it stays anchor-relative and outside any game
     * panel. Layout comes from HUD CSS tokens: it wraps instead of overflowing,
     * adds the device safe-area insets, and grows every control to a 60px tap
     * target on touch runtimes.
     *
     * While a control is focused the engine's gameplay keyboard/pointer
     * handlers are suppressed for that interaction, so a tap on a HUD button
     * cannot also fire the weapon and typing cannot walk the player.
     */
    createActionRow?(id: string, options: HUDActionRowOptions): void;

    /** Update one control of a row (label, variant, disabled, visible, value). */
    updateActionControl?(rowId: string, controlId: string, update: HUDActionControlUpdate): void;

    /** Show or hide a whole action row. */
    setActionRowVisible?(rowId: string, visible: boolean): void;

    /** Remove an action row and all of its controls. */
    removeActionRow?(rowId: string): void;

    /** Current text of a text-input control, or null if it isn't one. */
    getActionControlValue?(rowId: string, controlId: string): string | null;

    // Reticle (crosshair)
    showReticle(): void;
    hideReticle(): void;
    setReticleOffset(offsetPercent: number): void;
    setReticleVerticalOffset(offsetPercent: number): void;
    setReticleBlocked(blocked: boolean): void;
    /**
     * How far open the crosshair is, 0 (tight) to 1 (maximum bloom). Values are
     * clamped.
     *
     * Drives a spreading tick crosshair from the weapon's real accuracy —
     * movement, being airborne, firing bloom, aiming down sights. Calling this
     * is what converts the reticle from the static '+' to ticks; a game that
     * never calls it sees no change at all.
     */
    setReticleSpread(spread: number): void;

    /**
     * Comic-style "POW!"/"KAPOW!" burst near the reticle. OPT-IN: the engine
     * fires nothing automatically (RangedWeaponSystem used to spawn one per
     * shot; that was removed as visual noise) — call it from game code when a
     * comic style is actually wanted.
     */
    spawnComicBubble(): void;

    /**
     * Show a transient toast/notification message.
     *
     * Multiple concurrent toasts stack vertically — newest at the top of the
     * stack for top anchors, bottom for bottom anchors. Toasts auto-dismiss
     * after `options.duration` ms (default 2500).
     *
     * Use this instead of rolling a custom toast helper with HTML/CSS/keyframes.
     */
    showToast(message: string, options?: ToastOptions): void;

    // Health
    updateHealth(current: number, max: number): void;
    /**
     * Show the built-in health bar.
     * @param options - Optional configuration
     * @param options.width - Override width in pixels (default: scale.barWidth, 150px desktop)
     */
    showHealth(options?: { width?: number }): void;
    hideHealth(): void;
    isHealthEnabled(): boolean;

    // Controls display
    showControlsTemporarily(): void;
    showControlsPermanently(): void;
    hideControls(): void;
    toggleControls(): void;
    updateControlsDisplay(): void;

    /**
     * Enable or disable the controls guide panel entirely.
     * When disabled, showControlsTemporarily/showControlsPermanently are no-ops.
     * Call with false in Game.load() to prevent the controls panel from appearing.
     */
    setControlsGuideEnabled(enabled: boolean): void;
    
    /**
     * Set custom controls to display instead of the default controls.
     * When set, the controls dialog will show ONLY these custom controls.
     * 
     * @param controls - Array of control entries to display
     */
    setCustomControls(controls: ControlEntry[]): void;
    
    /**
     * Clear custom controls and revert to default dynamic controls display.
     */
    clearCustomControls(): void;

    // Mouse lock
    setMouseUnlockCallback(callback: MouseUnlockCallback): void;
    hasInteractiveElements(): boolean;
    requestMouseUnlock(elementId: string): void;
    requestMouseLock(elementId: string): void;

    // Mute control
    /**
     * Set up the default mute control button.
     * Creates a mute button (with M key shortcut) and persists state per-game in localStorage.
     * Called by the engine when the template has opted in via `engine.enableMuteControl()`.
     *
     * @param engine - The game engine instance
     * @param gameData - The game data (used for per-game localStorage key)
     */
    setupMuteControl?(engine: import('types/game.js').EngineLike, gameData: import('types/game.js').GameData | null): void;

    /**
     * Remove the default mute control button and dispose it.
     * Has no effect if no mute control is currently active.
     */
    removeMuteControl(): void;

    // General
    getScale(): Readonly<HUDScaleFactors>;
    show(): void;
    hide(): void;
    dispose(): void;
    setGameplayUIVisible(visible: boolean): void;
    setFreeMouseMode?(enabled: boolean): void;

    // Theme
    /**
     * Apply a visual theme to the HUD. The theme drives colors, font, geometry,
     * and decoration slots via CSS custom properties — no element re-creation.
     *
     * Typically called from the engine after loading world data (with the theme
     * stored in world.json's `hud.theme` field), or from games that want to
     * override the default Bitmagic theme programmatically.
     */
    setTheme(theme: import('engine/hud/ThemeTokens.js').ThemeTokens): void;

    /**
     * Get the currently-applied theme, or null if none has been applied yet.
     */
    getTheme(): import('engine/hud/ThemeTokens.js').ThemeTokens | null;
}
