// Top-level DOM layer that hosts the engine's full-screen "screen" overlays —
// currently the StartScreen (Play button). It is appended directly to <body> as
// a sibling of the HUD root (`.hud-root`) and stacks ABOVE it, so a game's
// custom HUD elements (mounted inside `.hud-root` via GameHUD.createCustomElement)
// can never paint over — or, on mobile, swallow taps meant for — the Play button.
//
// Why this exists: the StartScreen used to mount inside `#game-container`, which
// is `position: fixed` and therefore its OWN stacking context (a fixed-position
// element always creates one, z-index or not), while `.hud-root` is a body-level
// z-index 100. A stacking context can't be escaped by a descendant's own z-index,
// so the Play button (z-index 1000 inside the start card) was still painted BELOW
// the HUD layer. A full-screen, game-centred HUD element therefore covered the
// button, and the mobile touch layer treated taps there as joystick/camera input.
//
// Pause/End overlays don't need this — they already mount through the HUD
// (`GameHUD.createCustomElement`), i.e. inside `.hud-root` and on top of any
// game HUD element appended earlier.
//
// The body-level stack, bottom to top — anything that must paint over the game
// belongs here, not inside `#game-container`:
//
//   #game-container (auto)      the WebGL/WebGPU canvas
//   .hud-root (100)             GameHUD, and every game HUD element in it
//   .ui-screen-overlay-layer    9000  — StartScreen (this module)
//   .hud-gameplay-layer         9998  — incl. `.hud-esc-hint`
//   FadeOverlay                 9999  — fade-to-black for respawn/teleport
//   cutscene overlay           10010  — VideoPlayer (CUTSCENE_OVERLAY_Z_INDEX)
//   #bm-boot-screen            10020  — static boot shell (game/index.html)

/** Must exceed `.hud-root`'s z-index (100, see hudBaseStyles.ts). */
export const SCREEN_OVERLAY_LAYER_Z_INDEX = 9000;

/**
 * Cutscene overlay (VideoPlayer), mounted straight on `<body>`. Must exceed
 * `.hud-gameplay-layer` (9998, hudBaseStyles.ts) and the FadeOverlay (9999) so a
 * cutscene covers the ESC hint and every in-game overlay, while staying below
 * `#bm-boot-screen` (10020, game/index.html).
 */
export const CUTSCENE_OVERLAY_Z_INDEX = 10010;
export const SCREEN_OVERLAY_LAYER_CLASS = 'ui-screen-overlay-layer';
export const SCREEN_OVERLAY_LAYER_STYLE_ID = 'ui-screen-overlay-layer-styles';

let layer: HTMLElement | null = null;

function injectStyles(): void {
    if (document.getElementById(SCREEN_OVERLAY_LAYER_STYLE_ID)) {
        return;
    }
    const style = document.createElement('style');
    style.id = SCREEN_OVERLAY_LAYER_STYLE_ID;
    // The layer itself is transparent to input (pointer-events: none) so taps on
    // empty areas fall through to the canvas / HUD beneath it, matching the
    // StartScreen's "video thumbnail" behaviour. The Play button re-enables
    // pointer-events on itself (`.hud-play-button { pointer-events: auto }`).
    style.textContent = `
.${SCREEN_OVERLAY_LAYER_CLASS} {
    position: fixed;
    inset: 0;
    z-index: ${SCREEN_OVERLAY_LAYER_Z_INDEX};
    pointer-events: none;
}`;
    document.head.appendChild(style);
}

/**
 * Lazily create (or reuse) the shared screen-overlay layer and return it.
 * Idempotent: repeated calls return the same connected element, and the layer is
 * recreated if it has been detached from the DOM (e.g. across a game reload).
 */
export function getScreenOverlayLayer(): HTMLElement {
    if (layer?.isConnected) {
        return layer;
    }
    injectStyles();
    layer = document.createElement('div');
    layer.className = SCREEN_OVERLAY_LAYER_CLASS;
    document.body.appendChild(layer);
    return layer;
}

/** Test hook: drop the cached layer + injected styles so each test starts clean. */
export function resetScreenOverlayLayerForTests(): void {
    layer?.remove();
    layer = null;
    document.getElementById(SCREEN_OVERLAY_LAYER_STYLE_ID)?.remove();
}
