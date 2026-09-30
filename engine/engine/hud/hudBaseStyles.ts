// Token-driven base stylesheet for the HUD. Loaded as a string and injected once
// per HUD root via injectHudBaseStyles(). Every visual value is sourced from a
// --hud-* CSS custom property so themes only need to swap those properties.
//
// Authored as a TS string (not a .css file) because the engine runtime serves
// from /dist/ (tsc output) which doesn't bundle non-TS assets. Keeping the stylesheet
// here means it ships with engine bundles automatically — dev, publish, and tests.

export const HUD_BASE_STYLES = `
/* === HUD root: 9 INDEPENDENT anchor stacks ================================ */
/* Each anchor is its own absolutely-positioned stack. This is deliberate — the
   original 3x3 grid shared column tracks across rows, so ONE wide element (a
   long toast, a big status panel) widened its whole column: top content moved
   bottom content, and past min-content width the grid pushed the right column
   clean off the viewport. With absolute anchors nothing can move anything else;
   each stack clamps its width and long content WRAPS inside it instead of
   growing the layout. Anchors can overlap in the extreme — that beats
   off-screen UI every time. */
.hud-root {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 100;
    --hud-pad: clamp(8px, 1.5vw, 16px);
    /* Minimum hit area for managed action controls. Bumped to 60px on touch
       runtimes (see .hud-action-row[data-touch] and the media queries below). */
    --hud-tap-target: 44px;
    font-family: var(--hud-font-family, "Helvetica Neue", Helvetica, Arial, system-ui, sans-serif);
    color: var(--hud-color-text, #ffffff);
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
}

.hud-root > * {
    pointer-events: auto;
}

/* Anchor names match HUDAnchor in IGameHUD.ts.
   Centred anchors are centred with auto margins (inset on both sides +
   fit-content size), NOT with 'left/top: 50%' + 'transform: translate(-50%)'.
   A transform makes the anchor the containing block for every
   'position: fixed' descendant, and the engine's pause/end overlays
   (engine/ui/modalCard.ts, '.ui-modal-overlay { position: fixed; inset: 0 }')
   mount inside middle-center through GameHUD.createCustomElement: with a
   transform the overlay collapsed to the anchor's 0x0 box, the card shrank
   to min-content width and the dim backdrop vanished. The 'left: 50%' form
   also capped a centred stack's shrink-to-fit width at half the viewport;
   the auto-margin form honours the width clamps below as written. */
.hud-anchor-top-left      { position: absolute; top: var(--hud-pad); left: var(--hud-pad); align-items: flex-start; }
.hud-anchor-top-center    { position: absolute; top: var(--hud-pad); left: 0; right: 0; margin-inline: auto; width: fit-content; align-items: center; }
.hud-anchor-top-right     { position: absolute; top: var(--hud-pad); right: var(--hud-pad); align-items: flex-end; }
.hud-anchor-middle-left   { position: absolute; top: 0; bottom: 0; margin-block: auto; height: fit-content; left: var(--hud-pad); align-items: flex-start; }
.hud-anchor-middle-center { position: absolute; inset: 0; margin: auto; width: fit-content; height: fit-content; align-items: center; }
.hud-anchor-middle-right  { position: absolute; top: 0; bottom: 0; margin-block: auto; height: fit-content; right: var(--hud-pad); align-items: flex-end; }
.hud-anchor-bottom-left   { position: absolute; bottom: var(--hud-pad); left: var(--hud-pad); align-items: flex-start; }
.hud-anchor-bottom-center { position: absolute; bottom: var(--hud-pad); left: 0; right: 0; margin-inline: auto; width: fit-content; align-items: center; }
.hud-anchor-bottom-right  { position: absolute; bottom: var(--hud-pad); right: var(--hud-pad); align-items: flex-end; }

/* The bottom-right corner is a reserved band, 32px tall: published games put
   the Bitmagic watermark there (PublishController: "#bitmagic-branding",
   fixed at bottom 12px / right 16px, 20px-tall logo — hidden on touch
   devices, where the pause card carries the logo instead), and creator mode puts
   the dev Console button in the same slot (ConsolePanel.ts, sized to stay
   inside the band). Bottom-right HUD content (ammo counter, custom counters)
   starts above that zone: the padding puts the lowest element at 40px from
   the viewport bottom regardless of what --hud-pad resolves to. Applied
   unconditionally so the HUD does not shift between preview and publish.
   The mobile media query below overrides this with the larger joystick
   clearance, which also clears the band. */
.hud-anchor-bottom-right  { padding-bottom: calc(40px - var(--hud-pad)); }

/* Width clamps: corners/edges narrower, centers wider. Content beyond the
   clamp wraps (see the stack child rule below) — it never pushes the layout. */
.hud-anchor-top-left, .hud-anchor-top-right,
.hud-anchor-middle-left, .hud-anchor-middle-right,
.hud-anchor-bottom-left, .hud-anchor-bottom-right { max-width: min(38vw, 420px); }
.hud-anchor-top-center, .hud-anchor-middle-center, .hud-anchor-bottom-center { max-width: min(72vw, 640px); }

/* Auto-stacking: when multiple elements share an anchor, the parent flex column
   gives them a consistent gap without each element having to set its own margin. */
.hud-anchor-stack {
    display: flex;
    flex-direction: column;
    gap: clamp(4px, 0.8vw, 10px);
}
.hud-anchor-stack.is-horizontal {
    flex-direction: row;
}
/* Children may not blow past the anchor clamp — wrap text instead. */
.hud-anchor-stack > * {
    max-width: 100%;
    min-width: 0;
    overflow-wrap: break-word;
}

/* === Icons (currentColor-driven inline SVGs) ============================== */
/* All HUD icons size by em so they scale with surrounding text, and inherit
   color via currentColor. Used everywhere instead of emoji glyphs so themes
   render identically across OSes. */
.hud-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1em;
    height: 1em;
    flex-shrink: 0;
    line-height: 1;
}
.hud-icon > svg {
    width: 100%;
    height: 100%;
    display: block;
}
/* One arrow SVG, rotated by direction modifier. */
.hud-icon-arrow--up    { transform: rotate(0deg);   }
.hud-icon-arrow--right { transform: rotate(90deg);  }
.hud-icon-arrow--down  { transform: rotate(180deg); }
.hud-icon-arrow--left  { transform: rotate(-90deg); }

/* === Element base ========================================================= */
.hud-element {
    position: relative;
    box-sizing: border-box;
    image-rendering: var(--hud-image-rendering, auto);
}

/* Pseudo-element base — decoration slots fill these in via the runtime stylesheet. */
.hud-element::before,
.hud-element::after {
    content: none;
}

/* === Typography ========================================================== */
.hud-label {
    font-weight: var(--hud-font-weight-heading, 700);
    text-transform: var(--hud-font-case, uppercase);
    letter-spacing: var(--hud-font-tracking-label, 1.4px);
}

.hud-body {
    font-weight: var(--hud-font-weight-body, 400);
    text-transform: none;
    letter-spacing: normal;
}

/* === Progress bar ======================================================== */
.hud-progress-bar {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: clamp(120px, 18vw, 220px);
    padding: clamp(6px, 0.8vw, 10px) clamp(10px, 1.2vw, 16px);
    background: var(--hud-color-surface, #1f1f1f);
    border-radius: var(--hud-radius-card, 8px);
    color: var(--hud-color-on-surface, var(--hud-color-text, #ffffff));
}

.hud-progress-bar__label {
    font-size: calc(clamp(10px, 1.1vw, 12px) * var(--hud-font-scale, 1));
    font-weight: var(--hud-font-weight-heading, 700);
    text-transform: var(--hud-font-case, uppercase);
    letter-spacing: var(--hud-font-tracking-label, 1.4px);
    color: var(--hud-color-on-surface-muted, var(--hud-color-text-muted, #b3b3b3));
}

.hud-progress-bar__track {
    position: relative;
    height: clamp(8px, 1vw, 12px);
    background: var(--hud-color-background, #0b0b0b);
    border-radius: var(--hud-radius-pill, 500px);
    overflow: hidden;
}

.hud-progress-bar__fill {
    position: absolute;
    inset: 0 auto 0 0;
    width: var(--hud-progress-value, 0%);
    background: var(--hud-color-primary, #A0DAB9);
    border-radius: inherit;
    transition: width 180ms ease-out;
}

/* Busy shimmer — a light sweep across the whole track while a load step that
   blocks the main thread is running (GPU warmup: the warm frame, WebGL shader
   links). It animates transform only, so it runs on the COMPOSITOR thread and
   keeps moving while JS is frozen — the one signal that separates "working"
   from "hung" there. Toggle .hud-progress-bar--busy on the bar root and let
   one frame paint before the blocking work starts. */
@keyframes hud-progress-busy-shimmer {
    from { transform: translateX(-100%); }
    to   { transform: translateX(100%); }
}
.hud-progress-bar--busy .hud-progress-bar__track::after {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(105deg, transparent 25%, rgba(255, 255, 255, 0.28) 50%, transparent 75%);
    transform: translateX(-100%);
    animation: hud-progress-busy-shimmer 1.2s linear infinite;
    will-change: transform;
    pointer-events: none;
}

/* Health bar — .hud-progress-bar plus a three-tier fill color driven by the
   data-health-tier attribute, set from JS as health changes. Decoupled from
   --hud-progress-value so games can choose their own thresholds. */
.hud-health-bar[data-health-tier="healthy"]  .hud-progress-bar__fill { background: var(--hud-color-primary, #A0DAB9); }
.hud-health-bar[data-health-tier="warning"]  .hud-progress-bar__fill { background: var(--hud-color-warning, #FF8200); }
.hud-health-bar[data-health-tier="critical"] .hud-progress-bar__fill { background: var(--hud-color-danger,  #E0218A); }
/* Damage flash. */
.hud-health-bar[data-damaged="true"] {
    box-shadow: 0 0 24px var(--hud-glow-color, rgba(199, 16, 16, 0.5));
}

/* === Counter ============================================================= */
.hud-counter {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: clamp(6px, 0.8vw, 10px) clamp(12px, 1.4vw, 18px);
    background: var(--hud-color-surface, #1f1f1f);
    border-radius: var(--hud-radius-pill, 500px);
    color: var(--hud-color-on-surface, var(--hud-color-text, #ffffff));
    font-weight: var(--hud-font-weight-heading, 700);
    font-size: calc(clamp(14px, 1.5vw, 18px) * var(--hud-font-scale, 1));
    letter-spacing: var(--hud-font-tracking-label, 1.4px);
}

.hud-counter__icon {
    width: 1em;
    height: 1em;
    display: inline-flex;
    align-items: center;
    justify-content: center;
}

.hud-counter__value {
    font-variant-numeric: tabular-nums;
}

/* === Icon-text (small label + value) ===================================== */
.hud-icon-text {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--hud-color-text-muted, #b3b3b3);
    font-size: calc(clamp(11px, 1.1vw, 13px) * var(--hud-font-scale, 1));
}

.hud-icon-text__label {
    text-transform: var(--hud-font-case, uppercase);
    letter-spacing: var(--hud-font-tracking-label, 1.4px);
}

/* === Timer =============================================================== */
.hud-timer {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: clamp(4px, 0.6vw, 8px) clamp(10px, 1.2vw, 14px);
    background: var(--hud-color-surface, #1f1f1f);
    border-radius: var(--hud-radius-pill, 500px);
    font-variant-numeric: tabular-nums;
    font-size: calc(clamp(13px, 1.4vw, 16px) * var(--hud-font-scale, 1));
    font-weight: var(--hud-font-weight-heading, 700);
    /* Surface-filled, so it takes the FURNITURE ink. Without this it inherits
       the colour set on .hud-root, which is the text token -- the ink fitted to
       the light big-UI ground on a theme that has one. Measured 1.76:1 there. */
    color: var(--hud-color-on-surface, var(--hud-color-text, #ffffff));
}

.hud-timer[data-urgent="true"] {
    color: var(--hud-color-danger, #E0218A);
    animation: hud-pulse 600ms ease-in-out infinite alternate;
}

@keyframes hud-pulse {
    from { opacity: 0.6; }
    to   { opacity: 1.0; }
}

/* === Toast =============================================================== */
.hud-toast {
    padding: clamp(8px, 1vw, 12px) clamp(14px, 1.6vw, 22px);
    background: var(--hud-color-surface, #1f1f1f);
    color: var(--hud-color-on-surface, var(--hud-color-text, #ffffff));
    border-radius: var(--hud-radius-pill, 500px);
    font-size: calc(clamp(12px, 1.3vw, 14px) * var(--hud-font-scale, 1));
    font-weight: var(--hud-font-weight-heading, 700);
    text-transform: var(--hud-font-case, uppercase);
    letter-spacing: var(--hud-font-tracking-label, 1.4px);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5), 0 0 24px var(--hud-glow-color, transparent);
    animation: hud-toast-in 200ms ease-out;
}

.hud-toast[data-kind="success"] { color: var(--hud-color-primary, #A0DAB9); }
.hud-toast[data-kind="warning"] { color: var(--hud-color-warning, #FF8200); }
.hud-toast[data-kind="error"]   { color: var(--hud-color-danger,  #E0218A); }

@keyframes hud-toast-in {
    from { transform: translateY(-8px); opacity: 0; }
    to   { transform: translateY(0);    opacity: 1; }
}

/* === Controls overlay ===================================================== */
.hud-controls {
    padding: clamp(10px, 1.2vw, 16px) clamp(12px, 1.4vw, 18px);
    background: var(--hud-color-surface, #1f1f1f);
    border-radius: var(--hud-radius-card, 8px);
    color: var(--hud-color-on-surface-muted, var(--hud-color-text-muted, #b3b3b3));
    font-size: calc(clamp(11px, 1.1vw, 13px) * var(--hud-font-scale, 1));
    max-width: 320px;
}

.hud-controls__row {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    padding: 2px 0;
}

.hud-controls__key {
    display: inline-block;
    min-width: 22px;
    padding: 2px 6px;
    border: 1px solid var(--hud-color-text-muted, #b3b3b3);
    border-radius: 4px;
    text-align: center;
    font-weight: var(--hud-font-weight-heading, 700);
    color: var(--hud-color-on-surface, var(--hud-color-text, #ffffff));
    font-family: var(--hud-font-family);
}

/* === Managed action row (GameHUD.createActionRow) ========================= */
/* Buttons and text inputs the engine lays out itself. Everything a free-form
   custom element got wrong repeatedly is fixed here once: the row is a child of
   an anchor stack (so it can never be nested inside a game panel), it wraps
   instead of overflowing (so controls can never sit off-screen), it adds the
   device safe-area insets on top of --hud-pad (notches, home indicators,
   rounded corners), and every control honours --hud-tap-target. */
.hud-action-row {
    display: flex;
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
    gap: clamp(8px, 1.2vw, 14px);
    max-width: 100%;
    pointer-events: auto;
    /* Left/right insets apply at every anchor; the vertical ones depend on
       which edge the row is anchored to — see the [data-anchor] rules. */
    margin-left: env(safe-area-inset-left, 0px);
    margin-right: env(safe-area-inset-right, 0px);
}
.hud-action-row[data-layout="column"] {
    flex-direction: column;
    align-items: stretch;
}
.hud-action-row[data-wrap="false"] {
    flex-wrap: nowrap;
}
/* data-anchor is set on the anchor container by GameHUD.createAnchorContainers. */
[data-anchor^="top-"]     > .hud-action-row { margin-top: env(safe-area-inset-top, 0px); }
[data-anchor^="bottom-"]  > .hud-action-row { margin-bottom: env(safe-area-inset-bottom, 0px); }
[data-anchor$="-right"]   > .hud-action-row { justify-content: flex-end; }
[data-anchor$="-center"]  > .hud-action-row { justify-content: center; }
/* Touch runtime, decided in JS by isMobileRuntime() so the creator's
   ?platform=mobile preview matches a real phone (the media queries below cover
   the reverse case: a real phone the UA sniff somehow missed). */
.hud-action-row[data-touch="true"] { --hud-tap-target: 60px; }

.hud-action-control {
    box-sizing: border-box;
    min-height: var(--hud-tap-target, 44px);
    max-width: 100%;
    font-family: var(--hud-font-family, "Helvetica Neue", Helvetica, Arial, system-ui, sans-serif);
    -webkit-tap-highlight-color: transparent;
    /* No double-tap-to-zoom delay on the buttons players spam. */
    touch-action: manipulation;
}
.hud-action-control[hidden] {
    display: none;
}

.hud-action-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    min-width: var(--hud-tap-target, 44px);
    padding: 0 clamp(14px, 2vw, 26px);
    border: none;
    border-radius: var(--hud-radius-pill, 500px);
    background: var(--hud-color-surface, #1f1f1f);
    color: var(--hud-color-text, #ffffff);
    font-size: clamp(13px, 1.4vw, 16px);
    font-weight: var(--hud-font-weight-heading, 700);
    text-transform: var(--hud-font-case, uppercase);
    letter-spacing: var(--hud-font-tracking-label, 1.4px);
    line-height: 1.1;
    cursor: pointer;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
    transition: transform 0.1s ease, filter 0.1s ease;
}
.hud-action-button--primary { background: var(--hud-color-primary, #A0DAB9); color: var(--hud-color-on-primary, #000000); }
.hud-action-button--danger  { background: var(--hud-color-danger,  #E0218A); color: var(--hud-color-on-danger,  #ffffff); }
.hud-action-button--warning { background: var(--hud-color-warning, #FF8200); color: #000000; }
.hud-action-button--large {
    min-height: calc(var(--hud-tap-target, 44px) * 1.25);
    padding: 0 clamp(20px, 2.8vw, 40px);
    font-size: clamp(15px, 1.7vw, 20px);
}
.hud-action-button:hover:not(:disabled) { filter: brightness(1.06); }
.hud-action-button:active:not(:disabled) { transform: scale(0.97); }
.hud-action-button:disabled { opacity: 0.45; cursor: not-allowed; }
/* imageUrl: the image sits ahead of the label at text scale; image-only
   buttons square up to the tap target and let the image fill them. */
.hud-action-button__image {
    display: block;
    flex-shrink: 0;
    height: 1.6em;
    width: auto;
    max-width: 3em;
    object-fit: contain;
    pointer-events: none;
}
.hud-action-button--image-only {
    padding: 6px;
    width: var(--hud-tap-target, 44px);
}
.hud-action-button--image-only.hud-action-button--large {
    padding: 8px;
    width: calc(var(--hud-tap-target, 44px) * 1.25);
}
.hud-action-button--image-only .hud-action-button__image {
    width: 100%;
    height: 100%;
    max-width: none;
}

.hud-action-input {
    padding: 0 clamp(10px, 1.2vw, 16px);
    border: 2px solid color-mix(in srgb, var(--hud-color-text, #ffffff) 18%, transparent);
    border-radius: var(--hud-radius-card, 8px);
    background: var(--hud-color-background, #0b0b0b);
    color: var(--hud-color-text, #ffffff);
    /* 16px floor: anything smaller makes iOS Safari zoom the page on focus,
       which leaves the rest of the HUD scrolled off-screen. */
    font-size: 16px;
    outline: none;
}
.hud-action-input:focus { border-color: var(--hud-color-primary, #A0DAB9); }
.hud-action-input:disabled { opacity: 0.45; }

/* === Reticle / crosshair ================================================= */
.hud-reticle {
    width: clamp(20px, 2.5vw, 32px);
    height: clamp(20px, 2.5vw, 32px);
    display: grid;
    place-items: center;
    color: var(--hud-color-primary, #A0DAB9);
    mix-blend-mode: difference;
}
/* The reticle lives in .hud-gameplay-layer, not .hud-root, so it centers on
   that layer instead of taking an anchor-stack slot. */
.hud-gameplay-layer .hud-reticle {
    position: fixed;
    /* Keep in sync with RETICLE_VERTICAL_FRACTION in RangedWeaponSystem: the
       aim ray is cast through THIS point, so bullets land exactly on the
       crosshair. (Measured before the pairing: reticle at 52% + a theme
       override stomping 'transform' put the crosshair ~27cm below the true
       impact point at 9m — every shot read as "hitting high".) */
    top: 52%;
    left: 50%;
    /* The standalone 'translate' property, NOT 'transform': theme element
       overrides write 'transform' and were wiping the centering, anchoring
       the crosshair by its top-left corner. 'translate' composes with any
       theme transform and survives it. */
    translate: -50% -50%;
}
.hud-reticle[data-blocked="true"] {
    color: var(--hud-color-danger, #E0218A);
}

.hud-reticle::after {
    /* Only when no decoration is set does the default crosshair show. */
    content: "+";
    font-size: 1.5em;
    line-height: 1;
}

/* === Spreading crosshair ================================================= */
/* Opt-in: the ticks and [data-spread] appear only once a system calls
   setReticleSpread, so every existing game keeps the '+' above untouched. */
.hud-reticle[data-spread] {
    --hud-reticle-spread: 0;
}
.hud-reticle[data-spread]::after {
    content: none;
}
.hud-reticle__tick,
.hud-reticle__dot {
    position: absolute;
    left: 50%;
    top: 50%;
    /* currentColor, so the [data-blocked] recolouring above applies here too
       with no extra rule. */
    background: currentColor;
    /* 'translate', NOT 'transform' - same reason as the centering above: theme
       element overrides write 'transform' and would wipe this out. */
}
.hud-reticle__tick {
    --hud-reticle-gap: calc(3px + 13px * var(--hud-reticle-spread, 0));
}
/* Vertical ticks are 2x7, horizontal ones 7x2; only the offset differs per side. */
.hud-reticle__tick--up,
.hud-reticle__tick--down    { width: 2px; height: 7px; }
.hud-reticle__tick--left,
.hud-reticle__tick--right   { width: 7px; height: 2px; }
.hud-reticle__tick--up      { translate: -50% calc(-1 * var(--hud-reticle-gap) - 7px); }
.hud-reticle__tick--down    { translate: -50% var(--hud-reticle-gap); }
.hud-reticle__tick--left    { translate: calc(-1 * var(--hud-reticle-gap) - 7px) -50%; }
.hud-reticle__tick--right   { translate: var(--hud-reticle-gap) -50%; }
.hud-reticle__dot {
    width: 2px; height: 2px;
    translate: -50% -50%;
}

/* When a theme provides a decoration for the reticle, the runtime stylesheet
   overrides ::after — the default "+" disappears automatically because the
   ::after content gets replaced. */

/* === ESC unlock hint (gameplay-only, fades in on pointer lock) ============= */
.hud-esc-hint {
    position: fixed;
    bottom: clamp(12px, 1.5vw, 20px);
    left: clamp(12px, 1.5vw, 20px);
    padding: clamp(6px, 0.8vw, 10px) clamp(10px, 1.4vw, 16px);
    background: var(--hud-color-surface, #1f1f1f);
    color: var(--hud-color-on-surface, var(--hud-color-text, #ffffff));
    border-radius: var(--hud-radius-card, 8px);
    font-family: var(--hud-font-family, "Helvetica Neue", Helvetica, Arial, system-ui, sans-serif);
    font-size: calc(clamp(11px, 1.1vw, 13px) * var(--hud-font-scale, 1));
    font-weight: var(--hud-font-weight-body, 400);
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.3s ease-out;
    z-index: 10001;
}
.hud-esc-hint[data-visible="true"] {
    opacity: 0.85;
}

/* === Network lobby (multiplayer name input / room browser / waiting room) === */
/* Big surface with several view modes. All driven by theme tokens — surface,
   text, primary, font, radius, glow. Show/hide via data-visible on the overlay
   for the fade-in animation; invalid-input flash via .is-invalid class. */
.hud-lobby-overlay {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    display: flex;
    justify-content: center;
    align-items: center;
    background: rgba(0, 0, 0, 0.7);
    backdrop-filter: blur(4px);
    z-index: 2000;
    opacity: 0;
    transition: opacity 0.3s ease;
    font-family: var(--hud-font-family, "Helvetica Neue", Helvetica, Arial, system-ui, sans-serif);
}
.hud-lobby-overlay[data-visible="true"] {
    opacity: 1;
}

.hud-lobby-panel {
    /* The GROUND. A lobby panel is big UI -- the canvas its rows, fields and
       badges sit in -- which is what --hud-color-background means. Filling it with
       --hud-color-surface put it on the same token as the counters and toasts, so
       on a theme whose big UI is light and whose HUD chips are darker the whole
       panel came out as dark as a chip, and its own input well vanished into it. */
    background: var(--hud-color-background, #181818);
    border: 1px solid color-mix(in srgb, var(--hud-color-primary, #A0DAB9) 35%, transparent);
    border-radius: var(--hud-radius-card, 16px);
    padding: clamp(20px, 3vh, 32px);
    min-width: min(400px, 90vw);
    max-width: 500px;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5), 0 0 32px var(--hud-glow-color, transparent);
    color: var(--hud-color-text, #ffffff);
}

.hud-lobby-title {
    color: var(--hud-color-accent-ink, var(--hud-color-primary, #A0DAB9));
    margin: 0 0 24px 0;
    font-size: calc(clamp(20px, 2.4vw, 24px) * var(--hud-font-scale, 1));
    font-weight: var(--hud-font-weight-heading, 700);
    text-transform: var(--hud-font-case, none);
    letter-spacing: var(--hud-font-tracking-label, 0.5px);
    text-align: center;
    text-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
}
.hud-lobby-title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 20px;
}
.hud-lobby-title-row .hud-lobby-title {
    margin: 0;
    text-align: left;
}

.hud-lobby-body {
    color: var(--hud-color-text, #ffffff);
    margin: 0 0 24px 0;
    font-size: calc(15px * var(--hud-font-scale, 1));
    line-height: 1.5;
    text-align: center;
}

.hud-lobby-status {
    color: var(--hud-color-accent-ink, var(--hud-color-primary, #A0DAB9));
    text-align: center;
    font-size: calc(18px * var(--hud-font-scale, 1));
    padding: 24px 0;
}
.hud-lobby-status--error {
    color: var(--hud-color-danger-ink, var(--hud-color-danger, #ff6b6b));
}

.hud-lobby-muted {
    color: var(--hud-color-text-muted, #8899aa);
    text-align: center;
    padding: 20px;
    font-size: calc(14px * var(--hud-font-scale, 1));
}

.hud-lobby-divider {
    border: none;
    border-top: 1px solid color-mix(in srgb, var(--hud-color-text, #ffffff) 15%, transparent);
    margin: 0 0 16px 0;
}

.hud-lobby-input {
    width: 100%;
    padding: 12px 16px;
    border-radius: var(--hud-radius-card, 8px);
    /* A FIELD in the panel, so it takes the furniture token -- it used to share
       the panel's own, which on a ground-filled panel is the same colour. */
    border: 2px solid color-mix(in srgb, var(--hud-color-on-surface, var(--hud-color-text, #ffffff)) 18%, transparent);
    background: var(--hud-color-surface, #0a1018);
    color: var(--hud-color-on-surface, var(--hud-color-text, #ffffff));
    font-family: var(--hud-font-family);
    /* max() keeps the 16px iOS auto-zoom-on-focus floor intact. */
    font-size: max(16px, calc(16px * var(--hud-font-scale, 1)));
    outline: none;
    transition: border-color 0.2s;
    box-sizing: border-box;
    margin-bottom: 20px;
}
.hud-lobby-input:focus {
    border-color: var(--hud-color-primary, #4db8a0);
}
.hud-lobby-input.is-invalid {
    border-color: var(--hud-color-danger, #ff6b6b);
}
.hud-lobby-input--inline {
    flex: 1;
    margin-bottom: 0;
    padding: 10px 14px;
    /* max() keeps the 16px iOS auto-zoom-on-focus floor intact. */
    font-size: max(16px, calc(14px * var(--hud-font-scale, 1)));
}

.hud-lobby-name-badge {
    color: var(--hud-color-accent-ink, var(--hud-color-primary, #A0DAB9));
    font-size: calc(13px * var(--hud-font-scale, 1));
    font-weight: 600;
    padding: 4px 10px;
    border: 1px solid color-mix(in srgb, var(--hud-color-primary, #A0DAB9) 40%, transparent);
    border-radius: var(--hud-radius-pill, 12px);
    background: color-mix(in srgb, var(--hud-color-primary, #A0DAB9) 12%, transparent);
    font-family: var(--hud-font-family);
    white-space: nowrap;
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
}

.hud-lobby-button {
    padding: 10px 20px;
    border-radius: var(--hud-radius-card, 8px);
    border: none;
    background: var(--hud-color-primary, #A0DAB9);
    color: var(--hud-color-on-primary, #000000);
    font-family: var(--hud-font-family);
    font-size: calc(14px * var(--hud-font-scale, 1));
    font-weight: var(--hud-font-weight-heading, 700);
    cursor: pointer;
    transition: transform 0.15s ease, box-shadow 0.15s ease, filter 0.15s ease;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
    white-space: nowrap;
}
.hud-lobby-button:hover:not(:disabled) {
    transform: scale(1.04);
    box-shadow: 0 4px 12px var(--hud-glow-color, rgba(0, 0, 0, 0.3));
    filter: brightness(1.05);
}
.hud-lobby-button:active:not(:disabled) {
    transform: scale(0.98);
}
.hud-lobby-button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
}
.hud-lobby-button--full-width {
    width: 100%;
}
.hud-lobby-button--small {
    padding: 6px 16px;
    font-size: calc(13px * var(--hud-font-scale, 1));
}

/* Appearance picker (PlayerAppearanceSync.pickAppearance) */
.hud-appearance-swatches {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    justify-content: center;
    margin-top: 8px;
}
.hud-appearance-swatch {
    /* --swatch-color is set inline per choice (dynamic data); falls back to theme primary. */
    background: var(--swatch-color, var(--hud-color-primary, #A0DAB9));
    min-width: 96px;
}

.hud-lobby-list {
    flex: 1;
    overflow-y: auto;
    margin-bottom: 20px;
    min-height: 100px;
    max-height: 300px;
}
.hud-lobby-list--compact {
    min-height: 80px;
    max-height: 250px;
}

.hud-lobby-create-section {
    display: flex;
    gap: 8px;
}

.hud-lobby-room-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    margin-bottom: 6px;
    border-radius: var(--hud-radius-card, 8px);
    background: color-mix(in srgb, var(--hud-color-text, #ffffff) 5%, transparent);
    transition: background 0.2s;
    cursor: pointer;
}
.hud-lobby-room-row:hover:not(.is-disabled) {
    background: color-mix(in srgb, var(--hud-color-text, #ffffff) 10%, transparent);
}
.hud-lobby-room-row.is-disabled {
    opacity: 0.5;
    cursor: default;
}
.hud-lobby-room-row__info {
    display: flex;
    flex-direction: column;
    gap: 2px;
}
.hud-lobby-room-row__name-row {
    display: flex;
    align-items: center;
    gap: 8px;
}
.hud-lobby-room-row__name {
    color: var(--hud-color-text, #ffffff);
    font-size: calc(15px * var(--hud-font-scale, 1));
    font-weight: 500;
}
.hud-lobby-room-row__players {
    color: var(--hud-color-text-muted, #8899aa);
    font-size: calc(12px * var(--hud-font-scale, 1));
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 280px;
}

.hud-lobby-room-badge {
    color: var(--hud-color-text-muted, #8899aa);
    font-size: calc(12px * var(--hud-font-scale, 1));
    padding: 1px 6px;
    border: 1px solid color-mix(in srgb, var(--hud-color-text-muted, #8899aa) 60%, transparent);
    border-radius: 4px;
    font-family: var(--hud-font-family);
}
.hud-lobby-room-badge--full {
    color: var(--hud-color-danger-ink, var(--hud-color-danger, #ff6b6b));
    border-color: var(--hud-color-danger, #ff6b6b);
}
.hud-lobby-room-badge--status {
    padding: 6px 12px;
    border-radius: 6px;
}

.hud-lobby-player-row {
    padding: 6px 12px;
    margin-bottom: 4px;
    border-radius: 6px;
    background: color-mix(in srgb, var(--hud-color-text, #ffffff) 5%, transparent);
    color: var(--hud-color-text, #ffffff);
    font-size: calc(14px * var(--hud-font-scale, 1));
    display: flex;
    align-items: center;
    gap: 8px;
}
.hud-lobby-player-row__dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--hud-color-primary, #A0DAB9);
    display: inline-block;
    flex-shrink: 0;
}

.hud-lobby-waiting-subtitle {
    text-align: center;
    margin-bottom: 20px;
    font-size: calc(14px * var(--hud-font-scale, 1));
    color: var(--hud-color-text-muted, #8899aa);
}
.hud-lobby-count {
    color: var(--hud-color-accent-ink, var(--hud-color-primary, #A0DAB9));
    font-weight: 600;
    font-size: calc(16px * var(--hud-font-scale, 1));
}

/* === In-game notification banner (top-center toast during gameplay) ======= */
.hud-notification {
    position: fixed;
    top: clamp(12px, 2vh, 24px);
    left: 50%;
    transform: translateX(-50%);
    max-width: min(600px, 90vw);
    background: var(--hud-color-surface, #181818);
    color: var(--hud-color-on-surface, var(--hud-color-text, #ffffff));
    padding: clamp(14px, 1.8vh, 22px) clamp(18px, 2vw, 26px);
    border-radius: var(--hud-radius-card, 12px);
    border: 1px solid color-mix(in srgb, var(--hud-color-primary, #A0DAB9) 40%, transparent);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4), 0 0 24px var(--hud-glow-color, transparent);
    font-family: var(--hud-font-family, "Helvetica Neue", Helvetica, Arial, system-ui, sans-serif);
    font-size: calc(clamp(13px, 1.4vw, 15px) * var(--hud-font-scale, 1));
    font-weight: var(--hud-font-weight-body, 400);
    line-height: 1.6;
    z-index: 10000;
    pointer-events: none;
    opacity: 0;
    display: none;
    transition: opacity 0.3s ease-in-out;
}
.hud-notification[data-visible="true"] {
    opacity: 1;
    display: block;
}

/* === NPC speech bubble (3D-anchored above NPCs) =========================== */
.hud-npc-speech-bubble {
    position: fixed;
    background: var(--hud-color-surface, #181818);
    color: var(--hud-color-on-surface, var(--hud-color-text, #ffffff));
    padding: clamp(8px, 1vh, 12px) clamp(10px, 1.2vw, 16px);
    border-radius: var(--hud-radius-card, 12px);
    font-family: var(--hud-font-family, "Helvetica Neue", Helvetica, Arial, system-ui, sans-serif);
    font-size: calc(clamp(13px, 1.3vw, 15px) * var(--hud-font-scale, 1));
    font-weight: var(--hud-font-weight-body, 400);
    pointer-events: none;
    text-align: center;
    border: 1px solid color-mix(in srgb, var(--hud-color-on-surface, var(--hud-color-text, #ffffff)) 25%, transparent);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    transform: translate(-50%, -100%);
    max-width: 300px;
    word-wrap: break-word;
    line-height: 1.4;
    z-index: 1000;
    opacity: 0;
    transition: opacity 0.3s ease-in-out;
}
.hud-npc-speech-bubble[data-visible="true"] {
    opacity: 1;
}
.hud-npc-speech-bubble__tail {
    position: absolute;
    bottom: -8px;
    left: 50%;
    transform: translateX(-50%);
    width: 0;
    height: 0;
    border-left: 8px solid transparent;
    border-right: 8px solid transparent;
    /* Tail color matches the bubble surface so the seam is invisible. */
    border-top: 8px solid var(--hud-color-surface, #181818);
}

/* === World-space health bar (floating above NPCs / enemies / destructibles) */
/* Dimensions stay inline (config-driven per instance). Theme tokens drive the
   surface, border, and tier-coloured fill. JS sets data-tier; callers can
   still override fill color per-bar via inline style if a genre demands a
   specific palette (the inline style wins by specificity). */
.hud-world-health-bar {
    position: fixed;
    background: color-mix(in srgb, var(--hud-color-background, #0b0b0b) 70%, transparent);
    border: 1px solid color-mix(in srgb, var(--hud-color-text, #ffffff) 30%, transparent);
    pointer-events: none;
    transform: translate(-50%, -100%);
    z-index: 998;
    overflow: hidden;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.5);
}
.hud-world-health-bar__fill {
    height: 100%;
    width: 100%;
    background: var(--hud-color-primary, #00ff00);
    transition: width 0.15s ease-out, background 0.15s ease-out;
}
.hud-world-health-bar[data-tier="healthy"]  .hud-world-health-bar__fill { background: var(--hud-color-primary, #00ff00); }
.hud-world-health-bar[data-tier="warning"]  .hud-world-health-bar__fill { background: var(--hud-color-warning, #ffff00); }
.hud-world-health-bar[data-tier="critical"] .hud-world-health-bar__fill { background: var(--hud-color-danger,  #ff0000); }

/* === Interaction prompt (floating "[E] Open door" above interactables) ==== */
/* World-anchored prompt — JS sets left/top per frame from the projected world
   position; CSS owns the visual styling. Show/hide via data-visible; touch
   feedback via .is-pressed (the prompt inverts colors during a tap, which
   reads more clearly than a brightness dip on these small floating pills). */
.hud-interaction-prompt {
    position: fixed;
    transform: translate(-50%, -100%);
    background-color: var(--hud-color-surface, rgba(0, 0, 0, 0.75));
    color: var(--hud-color-on-surface, var(--hud-color-text, #ffffff));
    padding: clamp(8px, 1vw, 12px) clamp(14px, 1.6vw, 22px);
    border-radius: var(--hud-radius-card, 8px);
    font-family: var(--hud-font-family, "Helvetica Neue", Helvetica, Arial, system-ui, sans-serif);
    font-size: calc(clamp(13px, 1.3vw, 16px) * var(--hud-font-scale, 1));
    font-weight: var(--hud-font-weight-body, 400);
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.2s ease-in-out, background-color 0.1s ease, color 0.1s ease;
    z-index: 1000;
    display: flex;
    align-items: center;
    gap: 12px;
    white-space: nowrap;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
}
.hud-interaction-prompt[data-visible="true"] {
    opacity: 1;
}
.hud-interaction-prompt.is-pressed {
    background-color: var(--hud-color-text, #ffffff);
    color: var(--hud-color-background, #000000);
}
.hud-interaction-prompt__key {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 28px;
    height: 28px;
    padding: 0 8px;
    background: var(--hud-color-background, #1a1a1a);
    border: 1px solid color-mix(in srgb, var(--hud-color-text, #ffffff) 30%, transparent);
    border-radius: 5px;
    box-shadow: 0 2px 0 rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.1);
    font-weight: var(--hud-font-weight-heading, 700);
    font-size: 14px;
    color: var(--hud-color-on-surface, var(--hud-color-text, #ffffff));
    text-shadow: 0 1px 1px rgba(0, 0, 0, 0.5);
    font-family: var(--hud-font-family);
}

/* === Mobile controls (touch action buttons + joystick) ==================== */
/* Theme-driven mobile UI. Built-in action buttons (exit/action/secondaryAction
   /ascend/descend/interact) get a role class — colors come from --hud-color-*
   so the buttons recolor when the theme changes. Custom genre-registered
   actions skip the role classes and set background inline (legacy path).
   Press feedback toggles .is-pressed (JS-set since touch doesn't reliably
   trigger CSS :active). */
.hud-mobile-button {
    /* Layout (size + position) stays inline since each button has its own slot.
       Typography follows the theme (family + weight + case + tracking) so text
       labels match the rest of the HUD. */
    color: var(--hud-color-on-primary, #ffffff);
    font-family: var(--hud-font-family, "Helvetica Neue", Helvetica, Arial, system-ui, sans-serif);
    font-weight: var(--hud-font-weight-heading, 700);
    text-transform: var(--hud-font-case, uppercase);
    letter-spacing: var(--hud-font-tracking-label, 1.6px);
    line-height: 1.1;
    border: none;
    cursor: pointer;
    transition: transform 0.1s ease, background-color 0.1s ease, filter 0.1s ease;
    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.3);
    -webkit-tap-highlight-color: transparent;
}
.hud-mobile-button--image-only { padding: 12%; }
.hud-mobile-button__image {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
    pointer-events: none;
}
.hud-mobile-button.is-pressed {
    transform: scale(0.95);
    filter: brightness(0.85);
}

/* Role-based recoloring. The mobile button background sits at ~80% opacity
   over the game world so the user still sees what's happening underneath;
   pressed state goes full opacity for a clear "you're touching it" cue. */
.hud-mobile-button--primary  { background-color: color-mix(in srgb, var(--hud-color-primary, #A0DAB9) 80%, transparent); color: var(--hud-color-on-primary, #000000); }
.hud-mobile-button--primary.is-pressed  { background-color: var(--hud-color-primary, #A0DAB9); }

.hud-mobile-button--danger   { background-color: color-mix(in srgb, var(--hud-color-danger, #E0218A)  80%, transparent); color: var(--hud-color-on-danger,  #ffffff); }
.hud-mobile-button--danger.is-pressed   { background-color: var(--hud-color-danger, #E0218A); }

.hud-mobile-button--warning  { background-color: color-mix(in srgb, var(--hud-color-warning, #FF8200) 80%, transparent); color: #000000; }
.hud-mobile-button--warning.is-pressed  { background-color: var(--hud-color-warning, #FF8200); }

/* Joystick (movement) — uses surface + text tokens so it tints with the theme
   without competing with the action buttons for attention. */
.hud-mobile-joystick-outer {
    background-color: color-mix(in srgb, var(--hud-color-text, #ffffff) 25%, transparent);
    border: 2px solid color-mix(in srgb, var(--hud-color-text, #ffffff) 50%, transparent);
}
.hud-mobile-joystick-inner {
    background-color: color-mix(in srgb, var(--hud-color-text, #ffffff) 85%, transparent);
}

/* === Loading indicator (shown during world-data fetch, before GameHUD exists) === */
/* Tokens cascade from documentElement (set by applyThemeGlobals as soon as world
   data is parsed), so this renders in the active theme even before any HUD
   instance exists. Falls back to Bitmagic defaults until the theme is applied. */
.hud-loading-indicator {
    display: none;
    flex-direction: column;
    align-items: center;
    gap: 20px;
    font-family: var(--hud-font-family, "Helvetica Neue", Helvetica, Arial, system-ui, sans-serif);
    font-size: calc(clamp(20px, 2.4vw, 32px) * var(--hud-font-scale, 1));
    font-weight: var(--hud-font-weight-heading, 700);
    text-transform: var(--hud-font-case, uppercase);
    letter-spacing: var(--hud-font-tracking-label, 1.6px);
    color: var(--hud-color-text, #ffffff);
    text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.5);
    pointer-events: auto;
}
.hud-loading-indicator[data-visible="true"] {
    display: flex;
}
.hud-loading-spinner {
    width: clamp(40px, 4.5vw, 60px);
    height: clamp(40px, 4.5vw, 60px);
    border: 6px solid color-mix(in srgb, var(--hud-color-text, #ffffff) 30%, transparent);
    border-top-color: var(--hud-color-primary, #ffffff);
    border-radius: 50%;
    animation: hud-spin 1s linear infinite;
}
@keyframes hud-spin {
    0%   { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
}

/* === Pointer-lock overlay ("Click to play" backdrop) ====================== */
/* The START prompt: shown by PointerLockManager when gameplay begins without a
   click inside the iframe, which pointer lock needs. Every later relock goes
   through the pause card instead. Light on purpose — the scene stays visible
   behind it — but the typography pulls from the active theme. */
.hud-pointer-lock-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.35);
    display: none;
    justify-content: center;
    align-items: center;
    z-index: 10000;
    cursor: pointer;
}
.hud-pointer-lock-overlay[data-visible="true"] {
    display: flex;
}
.hud-pointer-lock-overlay__inner {
    text-align: center;
    color: var(--hud-color-text, #ffffff);
    font-family: var(--hud-font-family, "Helvetica Neue", Helvetica, Arial, system-ui, sans-serif);
    pointer-events: none;
}
.hud-pointer-lock-overlay__icon {
    font-size: calc(48px * var(--hud-font-scale, 1));
    margin-bottom: 20px;
    line-height: 1;
    pointer-events: none;
}
.hud-pointer-lock-overlay__message {
    font-size: calc(clamp(24px, 3vw, 36px) * var(--hud-font-scale, 1));
    font-weight: var(--hud-font-weight-heading, 700);
    text-transform: var(--hud-font-case, uppercase);
    letter-spacing: var(--hud-font-tracking-label, 1.6px);
    text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.5);
    color: var(--hud-color-on-primary, var(--hud-color-text, #ffffff));
    background: var(--hud-color-primary, transparent);
    padding: clamp(10px, 1.5vh, 16px) clamp(28px, 4vw, 56px);
    border-radius: var(--hud-radius-pill, 500px);
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.34), 0 0 24px var(--hud-glow-color, transparent);
    pointer-events: none;
}

/* === Gameplay layer (reticle + ESC hint live here; toggled by pointer lock) */
.hud-gameplay-layer {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 9998;
    display: none;
}
.hud-gameplay-layer[data-visible="true"] {
    display: block;
}

/* === Play button (menu pre-gameplay CTA) ================================== */
/* Token-driven so theme changes (Bitmagic, Horror, etc.) recolor the button
   without any JS hover/press code in MenuUI. --hud-color-on-primary is
   auto-derived by ThemeManager from primary luminance, so light primaries get
   black text and dark primaries get white. */
.hud-play-button {
    font-family: var(--hud-font-family, "Helvetica Neue", Helvetica, Arial, system-ui, sans-serif);
    font-size: calc(clamp(34px, 4.2vw, 52px) * var(--hud-font-scale, 1));
    font-weight: var(--hud-font-weight-heading, 800);
    text-transform: var(--hud-font-case, uppercase);
    letter-spacing: var(--hud-font-tracking-label, 1.8px);
    color: var(--hud-color-on-primary, #051b17);
    background: var(--hud-color-primary, #A0DAB9);
    /* Fallback chain keeps the pre-token look (1px primary) for themes without
       outline/border tokens; themed borders follow the pill radius. */
    border: var(--hud-border-width, 1px) solid var(--hud-color-outline, var(--hud-color-primary, #A0DAB9));
    border-radius: var(--hud-radius-pill, 500px);
    padding: clamp(14px, 2vh, 22px) clamp(52px, 7vw, 124px);
    cursor: pointer;
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.34), 0 0 0 1px var(--hud-glow-color, transparent);
    transition: transform 120ms ease, box-shadow 180ms ease, filter 180ms ease;
    text-shadow: none;
    pointer-events: auto;
}

.hud-play-button:hover {
    transform: translateY(-1px);
    filter: saturate(1.04);
    box-shadow:
        0 14px 34px rgba(0, 0, 0, 0.42),
        0 0 0 1px var(--hud-glow-color, transparent),
        0 0 24px var(--hud-glow-color, transparent);
}

.hud-play-button:active {
    transform: translateY(0);
    filter: saturate(0.98) brightness(0.96);
    box-shadow: 0 6px 14px rgba(0, 0, 0, 0.3), 0 0 0 1px var(--hud-glow-color, transparent);
}

.hud-play-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    transform: none;
    filter: grayscale(0.4);
}

/* === Comic bubble (transient pop-on-fire feedback) ======================== */
.hud-comic-bubble {
    position: fixed;
    transform: translate(-50%, -50%);
    font-family: 'Impact', 'Arial Black', sans-serif;
    font-weight: 700;
    border-radius: 50% 50% 50% 10%;
    padding: 4px 10px;
    text-shadow: 1px 1px 0 rgba(0, 0, 0, 0.4);
    box-shadow: 2px 2px 0 rgba(0, 0, 0, 0.3);
    z-index: 10000;
    pointer-events: none;
    white-space: nowrap;
    letter-spacing: 1px;
    animation: hud-comic-pop 0.5s ease-out forwards;
}

@keyframes hud-comic-pop {
    0%   { opacity: 0; transform: translate(-50%, -50%) scale(0.5); }
    15%  { opacity: 1; transform: translate(-50%, -50%) scale(1.1); }
    30%  {              transform: translate(-50%, -55%) scale(1.0); }
    100% { opacity: 0; transform: translate(-50%, -90%) scale(0.9); }
}

/* === Theme outline / bevel / text-outline tokens ========================== */
/* ThemeManager sets these custom properties ONLY when the theme defines them
   (and removes them otherwise), so every fallback below equals the pre-token
   look and existing themes render pixel-identically. The play button keeps its
   own 1px-primary fallback chain in its rule above. */
.hud-progress-bar, .hud-counter, .hud-timer, .hud-toast, .hud-controls,
.hud-lobby-button, .hud-mobile-button {
    border: var(--hud-border-width, 0px) solid var(--hud-color-outline, transparent);
}

/* Bevel + gloss: two white-alpha layers over each element's own background
   color via background-IMAGE. The GLOSS is the specular sheen band across the
   upper face (shape.gloss); the BEVEL is the lit-top/shadowed-bottom edge light
   (shape.bevel). Listed gloss-first so the sheen composites over the edge
   light, and every stop defaults to transparent so a theme carrying neither
   token renders byte-identically to the pre-token look. Theme backdrop
   decorations live in the per-root <style> (later in document order) and still
   win over both layers. */
.hud-play-button, .hud-lobby-button, .hud-mobile-button,
.hud-counter, .hud-timer, .hud-toast, .hud-progress-bar__fill {
    background-image: linear-gradient(
        180deg,
        var(--hud-gloss-top, transparent) 0%,
        var(--hud-gloss-fade, transparent) 34%,
        transparent 42%
    ), linear-gradient(
        180deg,
        var(--hud-bevel-top, transparent) 0%,
        transparent 45%,
        var(--hud-bevel-bottom, transparent) 100%
    );
}

/* Text outline for display-scale text ONLY — never small labels or body copy
   (a 2px stroke on 10px text is illegible). paint-order keeps the stroke behind
   the glyph fill where supported; themes cap outlineWidth at 2 for the rest. */
.hud-play-button, .hud-counter, .hud-timer, .hud-toast, .hud-mobile-button,
.hud-loading-indicator, .hud-pointer-lock-overlay__message {
    -webkit-text-stroke: var(--hud-text-outline-width, 0px) var(--hud-color-outline, #000000);
    paint-order: stroke fill;
}

/* === Responsive =========================================================== */
/* Note: "is this a mobile device" is decided in JS via isMobileRuntime()
   (user-agent / touch capability), NOT viewport width — a narrow desktop
   window like the creator iframe is still desktop and must keep the controls
   overlay visible. CSS media queries here only tweak sizing, never visibility. */
@media (max-width: 768px) {
    .hud-progress-bar { min-width: clamp(100px, 30vw, 160px); }
    /* Mobile bottom anchors need clearance for joystick / action buttons. */
    .hud-anchor-bottom-left,
    .hud-anchor-bottom-center,
    .hud-anchor-bottom-right { padding-bottom: clamp(80px, 14vw, 110px); }
}

/* Every finger-driven runtime gets the full 60px hit area, whatever the UA
   sniff concluded — a coarse pointer is the property that actually matters. */
@media (pointer: coarse) {
    .hud-root { --hud-tap-target: 60px; }
}

@media (max-width: 480px) {
    /* .hud-root isn't a flex/grid container — only padding (which the absolutely
       positioned anchors resolve against) has any effect here. */
    .hud-root { padding: 6px; }
}

/* Portrait phones: a row of pill buttons no longer fits side by side at the
   corners, so each control takes the full anchor width and stacks. Without
   this the last control in a row is what ends up clipped at the screen edge. */
@media (max-width: 480px) and (orientation: portrait) {
    .hud-action-row { width: 100%; }
    .hud-action-row > .hud-action-control { flex: 1 1 100%; }
    /* Square icon buttons are small enough to share a line — don't stretch them. */
    .hud-action-row > .hud-action-button--image-only { flex: 0 0 auto; }
}

/* Pixelated theme override — tightens letter-spacing and disables font smoothing
   so pixel fonts (Press Start 2P, VT323) render crisply. Activates via the
   --hud-image-rendering custom property. */
.hud-root[data-pixel-mode="true"] {
    image-rendering: pixelated;
    -webkit-font-smoothing: none;
}
`;

// Injects the base stylesheet exactly once per document. Multiple ThemeManagers
// on different roots share one global <style> in <head> — there's no per-theme
// state here (decoration CSS lives in a separate, per-root <style> managed by
// ThemeManager). Idempotency is by presence of the GLOBAL_STYLE_ID element.
export const GLOBAL_STYLE_ID = 'hud-base-styles';

export function injectHudBaseStyles(): void {
    if (typeof document === 'undefined') return;
    if (document.getElementById(GLOBAL_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = GLOBAL_STYLE_ID;
    style.textContent = HUD_BASE_STYLES;
    document.head.appendChild(style);
}

// Test-only reset. Used in jest to allow re-injection between tests.
export function _resetHudBaseStylesForTests(): void {
    if (typeof document === 'undefined') return;
    document.getElementById(GLOBAL_STYLE_ID)?.remove();
}
