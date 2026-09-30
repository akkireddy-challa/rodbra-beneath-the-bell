/**
 * @jest-environment jsdom
 *
 * Regression test for the start-screen layering guard.
 *
 * The StartScreen (Play button) used to mount inside `#game-container`, which is
 * `position: fixed` and therefore its own stacking context, while the HUD layer
 * `.hud-root` is a body-level z-index 100. That trapped the Play button BELOW
 * every HUD overlay regardless of its own z-index, so a game's full-screen,
 * game-centred HUD element (e.g. a generated board) could paint over — and on
 * mobile swallow taps meant for — the Play button.
 *
 * The fix: the StartScreen mounts in a dedicated top-level layer that is a
 * direct child of <body> (sibling of `.hud-root`) and stacks ABOVE it. These
 * tests lock in that placement + ordering.
 */
import {
    getScreenOverlayLayer,
    resetScreenOverlayLayerForTests,
    SCREEN_OVERLAY_LAYER_CLASS,
    SCREEN_OVERLAY_LAYER_STYLE_ID,
    SCREEN_OVERLAY_LAYER_Z_INDEX,
} from 'engine/ui/screenOverlayLayer.js';

// Mirrors `.hud-root { z-index: 100 }` in hudBaseStyles.ts — the layer must beat it.
const HUD_ROOT_Z_INDEX = 100;

describe('screen overlay layer (start-screen layering guard)', () => {
    afterEach(() => resetScreenOverlayLayerForTests());

    it('mounts as a direct child of <body> — a sibling of the HUD root, not nested in #game-container', () => {
        const layer = getScreenOverlayLayer();
        expect(layer.parentElement).toBe(document.body);
        expect(layer.classList.contains(SCREEN_OVERLAY_LAYER_CLASS)).toBe(true);
    });

    it('is idempotent — repeated calls reuse the same element', () => {
        const a = getScreenOverlayLayer();
        const b = getScreenOverlayLayer();
        expect(b).toBe(a);
        expect(document.querySelectorAll(`.${SCREEN_OVERLAY_LAYER_CLASS}`).length).toBe(1);
    });

    it('stacks above the HUD layer so HUD overlays cannot cover the Play button', () => {
        getScreenOverlayLayer();
        const style = document.getElementById(SCREEN_OVERLAY_LAYER_STYLE_ID);
        expect(style?.textContent).toContain(`z-index: ${SCREEN_OVERLAY_LAYER_Z_INDEX}`);
        expect(SCREEN_OVERLAY_LAYER_Z_INDEX).toBeGreaterThan(HUD_ROOT_Z_INDEX);
    });

    it('does not capture pointer events itself — only the Play button inside it does', () => {
        getScreenOverlayLayer();
        const style = document.getElementById(SCREEN_OVERLAY_LAYER_STYLE_ID);
        expect(style?.textContent).toContain('pointer-events: none');
    });

    it('recreates the layer after it is removed from the DOM', () => {
        const first = getScreenOverlayLayer();
        first.remove();
        const second = getScreenOverlayLayer();
        expect(second).not.toBe(first);
        expect(second.isConnected).toBe(true);
    });
});
