// Shared CSS and helpers for the three full-screen overlay templates:
// StartScreen, PauseScreen, EndScreen. Each renders a centered card on a dim
// backdrop so the family looks coherent regardless of the active HUD theme.
//
// All visual values come from HUD theme tokens (--hud-*) so themes flow
// through automatically. Per-screen specifics (background image for the
// start screen, outcome accent for the end screen) layer on top via
// dedicated classes / data attributes.

export const MODAL_STYLE_ID = 'ui-modal-card-styles';

/** How the engine's start, pause and end screens enter and leave. */
export type ScreenTransitionStyle = 'fade-rise' | 'fade' | 'none';

export interface ScreenTransitionOptions {
    /**
     * 'fade-rise': the backdrop fades while the card rises into place. 'fade': opacity
     * only. 'none': screens appear and disappear at once.
     */
    style: ScreenTransitionStyle;
    /** Enter animation length, ms. */
    enterMs: number;
    /** Leave animation length, ms. A leaving screen is removed once it has run. */
    leaveMs: number;
}

export const DEFAULT_SCREEN_TRANSITION: ScreenTransitionOptions = {
    style: 'fade-rise',
    enterMs: 200,
    leaveMs: 140,
};

let activeScreenTransition: ScreenTransitionOptions = DEFAULT_SCREEN_TRANSITION;

function durationMs(value: number, fallback: number): number {
    return Number.isFinite(value) ? Math.max(0, value) : fallback;
}

/**
 * Apply `options` to every engine screen. The CSS reads the root attribute and custom
 * properties set here; `ScreenLeave` reads them for when to remove a leaving node.
 * Game code goes through `GameEngine.setScreenTransition`.
 */
export function setScreenTransition(options: ScreenTransitionOptions): void {
    activeScreenTransition = {
        style: options.style,
        enterMs: durationMs(options.enterMs, DEFAULT_SCREEN_TRANSITION.enterMs),
        leaveMs: durationMs(options.leaveMs, DEFAULT_SCREEN_TRANSITION.leaveMs),
    };
    const root = document.documentElement;
    root.dataset.uiScreenTransition = activeScreenTransition.style;
    root.style.setProperty('--ui-screen-enter-ms', `${activeScreenTransition.enterMs}ms`);
    root.style.setProperty('--ui-screen-leave-ms', `${activeScreenTransition.leaveMs}ms`);
}

export function getScreenTransition(): ScreenTransitionOptions {
    return activeScreenTransition;
}

/**
 * How long a leaving screen stays in the DOM for its animation: 0 when nothing animates
 * ('none', a zero duration, or a player who asked the OS for reduced motion).
 */
export function screenLeaveDelayMs(): number {
    if (activeScreenTransition.style === 'none') return 0;
    if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return 0;
    return activeScreenTransition.leaveMs;
}

/**
 * One screen's leave animation. `start` marks the overlay so the CSS plays the fade-out,
 * then runs `finish` (remove or hide the node) once it has run. Each screen keeps one, so
 * that a screen coming back mid-leave — pause, resume, pause again — cancels the pending
 * finish instead of letting it take the newer card down with it.
 */
export class ScreenLeave {
    private timer: ReturnType<typeof setTimeout> | null = null;

    /**
     * Cancel any pending leave, then take `overlay` out. With no overlay, or when nothing
     * animates, `finish` runs synchronously.
     */
    start(overlay: HTMLElement | null, finish: () => void): void {
        this.cancel();
        const delay = overlay ? screenLeaveDelayMs() : 0;
        if (!overlay || delay === 0) {
            finish();
            return;
        }
        overlay.dataset.leaving = 'true';
        this.timer = setTimeout(() => {
            this.timer = null;
            finish();
        }, delay);
    }

    /** Drop a pending finish, so it can never apply to a card that has since come back. */
    cancel(): void {
        if (this.timer === null) return;
        clearTimeout(this.timer);
        this.timer = null;
    }
}

/**
 * Escape a value interpolated into card markup. Shared by the screens that build their
 * HTML as a string (PauseScreen, EndScreen).
 */
export function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const MODAL_CARD_CSS = `
.ui-modal-overlay {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.55);
    font-family: var(--hud-font-family, 'Red Hat Display', system-ui, sans-serif);
    z-index: 1000;
    pointer-events: auto;
}

.ui-modal-overlay--transparent {
    background: transparent;
    pointer-events: none;
}

/* Enter/leave motion shared by the start, pause and end screens. ScreenLeave sets
   data-leaving and removes (or hides) the node once the fade has run. A leaving
   overlay lets clicks through, so the game underneath is live again at once.
   Style and durations come from setScreenTransition (GameEngine.setScreenTransition):
   the data-ui-screen-transition attribute and --ui-screen-enter-ms / --ui-screen-leave-ms
   on the root element. Game CSS may also target .ui-modal-overlay--animated directly. */
.ui-modal-overlay--animated[data-leaving] { pointer-events: none; }
.ui-modal-overlay--animated[data-leaving] > * { pointer-events: none; }
@media (prefers-reduced-motion: no-preference) {
    :root:not([data-ui-screen-transition="none"]) .ui-modal-overlay--animated {
        animation: ui-modal-fade-in var(--ui-screen-enter-ms, 200ms) ease-out both;
    }
    :root:not([data-ui-screen-transition="none"]) .ui-modal-overlay--animated > :is(.ui-modal-card, .start-screen-card) {
        animation: ui-modal-card-in var(--ui-screen-enter-ms, 200ms) cubic-bezier(0.2, 0.8, 0.2, 1) both;
    }
    :root:not([data-ui-screen-transition="none"]) .ui-modal-overlay--animated[data-leaving] {
        animation: ui-modal-fade-out var(--ui-screen-leave-ms, 140ms) ease-in both;
    }
    :root:not([data-ui-screen-transition="none"]) .ui-modal-overlay--animated[data-leaving] > :is(.ui-modal-card, .start-screen-card) {
        animation: ui-modal-card-out var(--ui-screen-leave-ms, 140ms) ease-in both;
    }
    /* 'fade': the overlay's own fade carries the card; no rise. */
    :root[data-ui-screen-transition="fade"] .ui-modal-overlay--animated > :is(.ui-modal-card, .start-screen-card),
    :root[data-ui-screen-transition="fade"] .ui-modal-overlay--animated[data-leaving] > :is(.ui-modal-card, .start-screen-card) {
        animation: none;
    }
}
@keyframes ui-modal-fade-in { from { opacity: 0; } }
@keyframes ui-modal-fade-out { to { opacity: 0; } }
@keyframes ui-modal-card-in { from { opacity: 0; transform: translateY(10px) scale(0.97); } }
@keyframes ui-modal-card-out { to { opacity: 0; transform: translateY(6px) scale(0.98); } }

/* Optional off-centre placement of the card. Orientation-aware: 'start' = top in
   portrait / left in landscape, 'end' = bottom / right. The unset axis stays
   centred (inherited from .ui-modal-overlay). Padding keeps the card off the edge. */
@media (orientation: portrait) {
    .ui-modal-overlay--place-start { align-items: flex-start; padding-top: clamp(24px, 8vh, 96px); }
    .ui-modal-overlay--place-end { align-items: flex-end; padding-bottom: clamp(24px, 8vh, 96px); }
}
@media (orientation: landscape) {
    .ui-modal-overlay--place-start { justify-content: flex-start; padding-left: clamp(24px, 6vw, 120px); }
    .ui-modal-overlay--place-end { justify-content: flex-end; padding-right: clamp(24px, 6vw, 120px); }
}

/* --- Start screen image card (cover image as background) --------------- */

.start-screen-card--with-image {
    /* min() across vw + vh keeps the card square in both portrait and
       landscape — width follows whichever axis is smaller, no letterbox. */
    width: min(90vw, 85vh, 480px);
    aspect-ratio: 1 / 1;
    background-size: cover;
    background-position: center;
    background-repeat: no-repeat;
    border-radius: 16px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.45);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    padding: clamp(20px, 3.5vw, 28px) clamp(16px, 3vw, 24px);
    pointer-events: auto;
    gap: 16px;
}

.start-screen-title--with-image {
    margin: 0;
    font-size: clamp(20px, 2.6vw, 32px);
    line-height: 1.2;
    font-weight: var(--hud-font-weight-heading, 700);
    text-transform: var(--hud-font-case, uppercase);
    letter-spacing: var(--hud-font-tracking-label, 1.4px);
    color: var(--hud-color-text, #ffffff);
    text-align: center;
    text-shadow: 0 2px 8px rgba(0, 0, 0, 0.75);
    max-width: 100%;
    overflow-wrap: break-word;
}

.start-screen-card--with-image .hud-loading-indicator[data-visible="true"] {
    text-shadow: 0 2px 6px rgba(0, 0, 0, 0.7);
}

/* --- Start screen load-progress bar ------------------------------------ */
/* A .hud-progress-bar tuned for the start card: wider, translucent surface
   (readable over cover images), label + percent on one row. */

.start-screen-progress {
    width: min(70vw, 320px);
    background: color-mix(in srgb, var(--hud-color-surface, #1f1f1f) 70%, transparent);
}

.start-screen-progress__label-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 12px;
    color: var(--hud-color-text, #ffffff);
}

.start-screen-progress__percent {
    color: var(--hud-color-text-muted, #b3b3b3);
    font-variant-numeric: tabular-nums;
}

/* --- Start screen pre-play selection steps ------------------------------ */
/* One step at a time on the start card: heading + option buttons. Buttons
   reuse .ui-modal-button so they match the family; the list scrolls when a
   game offers many options (long level lists on small screens). */

.start-screen-selection {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
    width: 100%;
    pointer-events: auto;
}

.start-screen-selection__title {
    font-size: clamp(15px, 2.2vw, 20px);
    font-weight: var(--hud-font-weight-heading, 700);
    text-transform: var(--hud-font-case, uppercase);
    letter-spacing: var(--hud-font-tracking-label, 1.4px);
    color: var(--hud-color-text, #ffffff);
    text-shadow: 0 2px 6px rgba(0, 0, 0, 0.6);
}

.start-screen-selection__options {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 10px;
    max-width: min(86vw, 440px);
    max-height: min(46vh, 320px);
    overflow-y: auto;
    padding: 2px;
}

.start-screen-selection__option {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
}

.start-screen-selection__option-image {
    width: clamp(56px, 9vw, 84px);
    height: clamp(56px, 9vw, 84px);
    object-fit: cover;
    border-radius: var(--hud-radius-card, 8px);
    pointer-events: none;
}

.ui-modal-card {
    position: relative;
    width: min(90vw, 480px);
    padding: clamp(20px, 4vw, 32px) clamp(20px, 5vw, 36px);
    /* The GROUND, not the furniture. A modal card is the canvas its rows, slots
       and chips sit in, which is what --hud-color-background means; painting it
       with --hud-color-surface put it on the same token as the counters and
       toasts, so on a theme whose big UI is light and whose HUD chips are darker
       the dialog came out as dark as a chip -- and it left inner elements filled
       with that same token sitting on their own colour.
       NOTE: no backticks in here. This whole block is a TS template literal. */
    background: var(--hud-color-background, rgba(20, 20, 24, 0.95));
    color: var(--hud-color-text, #ffffff);
    /* Width from the theme border token when set; color prefers the theme outline,
       then primary. data-accent rules below still win the color via border-color. */
    border: var(--hud-border-width, 2px) solid var(--hud-color-outline, var(--hud-color-primary, #ffffff));
    border-radius: var(--hud-radius-card, 8px);
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
    text-align: center;
    pointer-events: auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
    box-sizing: border-box;
}

/* --- The card's content column ------------------------------------------ */
/* ONE content width, not two. Actions were auto-width and centred while the
   settings row spanned the whole card, so the two blocks shared no edge and the
   card read as two unrelated halves. Everything inside the stack takes the same
   column, which also gives a second setting somewhere obvious to go. Cards that
   want the old auto-width buttons simply do not use it. */
.ui-modal-stack {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 12px;
    width: min(260px, 100%);
}

.ui-modal-stack > .ui-modal-button { width: 100%; }

.ui-modal-card[data-accent="win"]      { border-color: var(--hud-color-success, #4ade80); }
.ui-modal-card[data-accent="lose"]     { border-color: var(--hud-color-danger, #f87171); }
.ui-modal-card[data-accent="neutral"]  { border-color: var(--hud-color-primary, #ffffff); }

.ui-modal-title {
    margin: 0;
    font-size: calc(clamp(22px, 5vw, 32px) * var(--hud-font-scale, 1));
    font-weight: var(--hud-font-weight-heading, 700);
    text-transform: var(--hud-font-case, uppercase);
    letter-spacing: var(--hud-font-tracking-label, 1.4px);
    color: var(--hud-color-accent-ink, var(--hud-color-primary, #ffffff));
    -webkit-text-stroke: var(--hud-text-outline-width, 0px) var(--hud-color-outline, #000000);
    paint-order: stroke fill;
}

.ui-modal-card[data-accent="win"]     .ui-modal-title { color: var(--hud-color-accent-ink, var(--hud-color-success, #4ade80)); }
.ui-modal-card[data-accent="lose"]    .ui-modal-title { color: var(--hud-color-accent-ink, var(--hud-color-danger, #f87171)); }

.ui-modal-message {
    margin: 0;
    font-size: calc(16px * var(--hud-font-scale, 1));
    font-weight: var(--hud-font-weight-body, 400);
    color: var(--hud-color-text-muted, rgba(255, 255, 255, 0.75));
}

.ui-modal-button {
    /* Min 44px tall touch target — clamp keeps it comfortable on both phone
       and desktop without becoming oversized. */
    min-height: 44px;
    padding: clamp(12px, 2vh, 14px) clamp(22px, 5vw, 28px);
    font-family: inherit;
    font-size: calc(clamp(15px, 2.5vw, 17px) * var(--hud-font-scale, 1));
    font-weight: var(--hud-font-weight-heading, 700);
    text-transform: var(--hud-font-case, uppercase);
    letter-spacing: var(--hud-font-tracking-label, 1.4px);
    color: var(--hud-color-on-primary, #000000);
    background: var(--hud-color-primary, #ffffff);
    /* Theme bevel/outline tokens (transparent/0 when the theme doesn't set them).
       background-image layers the gloss over the background shorthand above. */
    background-image: linear-gradient(
        180deg,
        var(--hud-bevel-top, transparent) 0%,
        transparent 45%,
        var(--hud-bevel-bottom, transparent) 100%
    );
    border: var(--hud-border-width, 0px) solid var(--hud-color-outline, transparent);
    border-radius: var(--hud-radius-pill, 500px);
    -webkit-text-stroke: var(--hud-text-outline-width, 0px) var(--hud-color-outline, #000000);
    paint-order: stroke fill;
    cursor: pointer;
    transition: transform 0.08s ease, filter 0.12s ease;
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
}

.ui-modal-button:hover  { filter: brightness(1.1); }
.ui-modal-button:active { transform: scale(0.97); }

/* --- Settings row: a label, a dropdown, and a muted note ----------------- */
/* The setting must not carry a primary ACTION's weight. Six chips at the button
   family's size needed two rows and outweighed Resume, which is the one thing anyone
   opens this card to press, so the choice collapsed into a single select. The row is
   still deliberately quiet: a small uppercase label, a compact field on a precise
   pointer, and a separating rule above it. The 44px touch target comes back under
   (pointer: coarse), where it is a requirement rather than a style. */
.ui-modal-row {
    display: grid;
    /* Label and field share one line; the note spans both columns underneath.
       minmax(0, ...) lets the field shrink inside the card instead of widening it. */
    grid-template-columns: auto minmax(0, 1fr);
    align-items: center;
    column-gap: 12px;
    row-gap: 4px;
    width: 100%;
    /* Sets the settings apart from the actions above without adding a heading. */
    margin-top: 4px;
    padding-top: 12px;
    border-top: 1px solid color-mix(in srgb, var(--hud-color-text, #ffffff) 12%, transparent);
}

.ui-modal-row > .ui-modal-note { grid-column: 1 / -1; }

.ui-modal-row-label {
    font-size: calc(clamp(10px, 1.6vw, 11px) * var(--hud-font-scale, 1));
    font-weight: var(--hud-font-weight-heading, 700);
    text-transform: var(--hud-font-case, uppercase);
    letter-spacing: var(--hud-font-tracking-label, 1.4px);
    color: var(--hud-color-text-muted, #b3b3b3);
    text-align: left;
}

/* The wrapper exists only to hold the chevron: a select painted with
   appearance:none loses the platform arrow, and a pseudo-element on the select
   itself has nowhere to render. */
.ui-modal-select-wrap {
    position: relative;
    /* Sized to its longest label, not to the card: a field stretched across 480px
       reads as the card's main event, which is exactly what this row must not be.
       Right-aligned against the label so the pair reads as one settings line. */
    display: block;
    width: min(160px, 60%);
    justify-self: end;
    color: var(--hud-color-primary, #ffffff);
}

.ui-modal-select-wrap::after {
    content: '';
    position: absolute;
    right: 12px;
    top: 50%;
    width: 7px;
    height: 7px;
    border-right: 2px solid currentColor;
    border-bottom: 2px solid currentColor;
    transform: translateY(-70%) rotate(45deg);
    pointer-events: none;
}

/* The field reads as available rather than as an action: the card's own surface
   with the primary colour as text, so nothing in this row competes with Resume. */
.ui-modal-select {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    min-width: 0;
    min-height: 32px;
    padding: 6px 30px 6px 10px;
    font-family: inherit;
    font-size: calc(clamp(12px, 1.8vw, 14px) * var(--hud-font-scale, 1));
    font-weight: var(--hud-font-weight-heading, 700);
    text-transform: var(--hud-font-case, uppercase);
    letter-spacing: calc(var(--hud-font-tracking-label, 1.4px) * 0.4);
    color: var(--hud-color-primary, #ffffff);
    background: color-mix(in srgb, var(--hud-color-surface, #1f1f1f) 70%, transparent);
    border: var(--hud-border-width, 1px) solid color-mix(in srgb, var(--hud-color-primary, #ffffff) 45%, transparent);
    border-radius: var(--hud-radius-card, 8px);
    cursor: pointer;
    text-overflow: ellipsis;
    transition: filter 0.12s ease;
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
}

.ui-modal-select:hover { filter: brightness(1.15); }
.ui-modal-select:focus-visible { outline: 2px solid var(--hud-color-primary, #ffffff); outline-offset: 2px; }

/* The popup is drawn by the platform, which does not inherit the card's colours.
   Painting the options keeps it legible where the browser honours this (most do
   outside macOS) and costs nothing where it does not. */
.ui-modal-select option {
    color: var(--hud-color-text, #ffffff);
    background: var(--hud-color-background, #141418);
    text-transform: none;
    letter-spacing: normal;
}

/* A finger needs the full target; a mouse does not. Same complement as the
   branding rule below. */
@media (pointer: coarse) {
    .ui-modal-select {
        min-height: 44px;
        padding: 10px 32px 10px 12px;
    }
}

.ui-modal-note {
    font-size: calc(clamp(11px, 1.7vw, 12px) * var(--hud-font-scale, 1));
    line-height: 1.4;
    color: var(--hud-color-text-muted, #b3b3b3);
    text-align: left;
    text-transform: none;
    letter-spacing: 0;
}

/* The speaker glyph ahead of the Mute button's label. */
.pause-screen-mute-icon {
    display: inline-flex;
    vertical-align: middle;
    margin-right: 8px;
}

/* --- Bitmagic branding on the pause card -------------------------------- */
/* Touch-only: a published game shows its watermark in the bottom-right
   corner, but that corner belongs to the on-screen controls on a touch
   device, so publishing hides it behind the same (pointer: coarse) query
   this rule turns the pause logo ON with. The two are exact complements —
   see engine/ui/bitmagicBranding.ts before changing either. */
.pause-screen-brand { display: none; }

@media (pointer: coarse) {
    .pause-screen-brand {
        display: inline-flex;
        align-items: center;
        opacity: 0.8;
        transition: opacity 0.12s ease, transform 0.12s ease;
        -webkit-tap-highlight-color: transparent;
    }
    .pause-screen-brand:active { opacity: 1; transform: scale(0.97); }
    .pause-screen-brand img { display: block; height: 20px; width: auto; }
}
`;

export function injectModalCardStyles(): void {
    if (document.getElementById(MODAL_STYLE_ID)) {
        return;
    }
    const style = document.createElement('style');
    style.id = MODAL_STYLE_ID;
    style.textContent = MODAL_CARD_CSS;
    document.head.appendChild(style);
}
