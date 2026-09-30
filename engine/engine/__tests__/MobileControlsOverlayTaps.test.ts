/**
 * @jest-environment jsdom
 *
 * Regression test for the mobile overlay-tap bug: MobileControls attaches
 * document-level touch listeners that call preventDefault() to suppress
 * scroll/zoom while gameplay controls are enabled. preventDefault() on a touch
 * also cancels the browser's synthetic `click`, which is what DOM overlays
 * (the multiplayer lobby, the PlayerAppearanceSync team-colour picker) rely on
 * to fire their button handlers — so on mobile those taps were being swallowed.
 *
 * The fix: MobileControls.isInteractiveUiTarget() bails out before
 * preventDefault() when a touch lands on interactive overlay DOM (button / link
 * / form control), leaving the synthetic click intact. These tests exercise the
 * document-event → preventDefault path directly.
 */

import { MobileControls } from 'engine/MobileControls.js';

/**
 * Build a cancelable, bubbling touch-like event. jsdom has no TouchEvent
 * constructor, so we synthesise one with an empty changedTouches list (the
 * handlers iterate it; empty keeps them from touching unset geometry).
 */
function makeTouchEvent(type: 'touchstart' | 'touchmove' | 'touchend'): Event {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'changedTouches', { value: [], configurable: true });
    return ev;
}

describe('MobileControls overlay tap handling (integration)', () => {
    let controls: MobileControls;

    beforeEach(() => {
        // isMobileRuntime() short-circuits to true on an explicit mobile UA, so
        // MobileControls wires up its DOM + document touch listeners.
        Object.defineProperty(window.navigator, 'userAgent', {
            value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
            configurable: true,
        });
        controls = new MobileControls();
    });

    afterEach(() => {
        controls.dispose();
    });

    it('does NOT preventDefault a touch that lands on an overlay button (synthetic click survives)', () => {
        const button = document.createElement('button');
        button.textContent = 'Red';
        document.body.appendChild(button);

        const start = makeTouchEvent('touchstart');
        button.dispatchEvent(start);
        const end = makeTouchEvent('touchend');
        button.dispatchEvent(end);

        expect(start.defaultPrevented).toBe(false);
        expect(end.defaultPrevented).toBe(false);

        button.remove();
    });

    it('still preventDefaults a touch on the game surface (scroll/zoom suppressed, camera/joystick drive)', () => {
        const surface = document.createElement('div');
        document.body.appendChild(surface);

        const start = makeTouchEvent('touchstart');
        surface.dispatchEvent(start);

        expect(start.defaultPrevented).toBe(true);

        surface.remove();
    });

    it('treats inputs and links inside an overlay as interactive too', () => {
        const input = document.createElement('input');
        const link = document.createElement('a');
        link.href = '#';
        document.body.append(input, link);

        const onInput = makeTouchEvent('touchstart');
        input.dispatchEvent(onInput);
        const onLink = makeTouchEvent('touchstart');
        link.dispatchEvent(onLink);

        expect(onInput.defaultPrevented).toBe(false);
        expect(onLink.defaultPrevented).toBe(false);

        input.remove();
        link.remove();
    });
});
