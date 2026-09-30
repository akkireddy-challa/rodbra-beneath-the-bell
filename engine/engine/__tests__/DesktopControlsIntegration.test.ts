/**
 * @jest-environment jsdom
 *
 * Integration test for DesktopControls keydown/keyup dispatch and the
 * getUnpairedRawKeys metadata used by the parity check. Goes beyond the
 * pure-helper coverage in MobileButtonLayout.test / mobileParity.test by
 * exercising the full document-event → custom-handler path.
 *
 * DesktopControls is light enough to instantiate directly (only transitive
 * deps are a type and isMobileRuntime), so we use a real DOM via jsdom.
 * PlayerController itself pulls in Three.js + Rapier and isn't feasible here.
 */

import { DesktopControls } from 'engine/DesktopControls.js';

/**
 * DesktopControls only attaches its listeners when isMobileRuntime() is false,
 * which it decides via matchMedia('(pointer: coarse)') — absent under jsdom.
 */
function createDesktopControls(): DesktopControls {
    window.matchMedia = jest.fn().mockReturnValue({
        matches: false,
        media: '(pointer: coarse)',
        onchange: null,
        addListener: jest.fn(),
        removeListener: jest.fn(),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        dispatchEvent: jest.fn(),
    });
    const dc = new DesktopControls();
    // Tests don't run under pointer lock and default controlsEnabled=true,
    // but shouldProcessInput() still requires *either* pointer lock *or*
    // controlsEnabled && passing inputGate. A no-op inputGate works.
    dc.setInputGate(() => true);
    return dc;
}

/**
 * Dispatch one key event and report whether the game cancelled the browser's default
 * for it. `cancelable` is what makes `defaultPrevented` meaningful.
 */
function sendKey(
    type: 'keydown' | 'keyup',
    code: string,
    init: KeyboardEventInit = {},
    target: EventTarget = document,
): boolean {
    const ev = new KeyboardEvent(type, { code, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(ev);
    return ev.defaultPrevented;
}

const press = (code: string, init: KeyboardEventInit = {}, target: EventTarget = document): boolean =>
    sendKey('keydown', code, init, target);
const release = (code: string): boolean => sendKey('keyup', code);

/**
 * Register a mobile-paired custom key and return the array collecting the
 * pressed/released edges its handler receives.
 */
function trackKey(controls: DesktopControls, code: string): boolean[] {
    const edges: boolean[] = [];
    controls.registerKeyHandler(code, (pressed) => { edges.push(pressed); }, { source: 'test', pairedWithMobile: true });
    return edges;
}

let dc: DesktopControls;
beforeEach(() => { dc = createDesktopControls(); });
afterEach(() => { dc.dispose(); });

describe('DesktopControls key handler dispatch (integration)', () => {
    it('dispatches keydown and keyup to a registered custom handler', () => {
        const edges = trackKey(dc, 'KeyR');

        press('KeyR');
        release('KeyR');

        expect(edges).toEqual([true, false]);
    });

    describe('browser default of consumed keys', () => {
        it('cancels the default for movement, ascend, action and custom-handler keys', () => {
            trackKey(dc, 'KeyR');
            // ArrowDown scrolls the page and Space pages it down — the two that scroll a
            // portal iframe's host page; Enter is the action key, R a registered custom key.
            expect(press('ArrowDown')).toBe(true);
            expect(press('Space')).toBe(true);
            expect(press('Enter')).toBe(true);
            expect(press('KeyR')).toBe(true);
        });

        it('leaves a key the game does not consume alone', () => {
            expect(press('KeyZ')).toBe(false);
            expect(press('F5')).toBe(false);
        });

        it('leaves a movement key alone once keyboard movement is disabled', () => {
            dc.disableKeyboardMovement = true;
            expect(press('ArrowDown')).toBe(false);
            expect(press('Space')).toBe(true); // ascend is not movement
        });

        it('leaves a focused text field its keys', () => {
            const input = document.createElement('input');
            document.body.appendChild(input);
            try {
                expect(press('ArrowDown', {}, input)).toBe(false);
                expect(press('Space', {}, input)).toBe(false);
            } finally {
                input.remove();
            }
        });

        it('leaves Ctrl/Alt/Meta chords to the browser', () => {
            expect(press('ArrowLeft', { altKey: true })).toBe(false);
            expect(press('Space', { metaKey: true })).toBe(false);
            expect(press('ArrowUp', { shiftKey: true })).toBe(true); // Shift is a game modifier
        });
    });

    it('getUnpairedRawKeys lists only entries with pairedWithMobile:false', () => {
        dc.registerKeyHandler('KeyF', () => {}, { source: 'fire-system', pairedWithMobile: false });
        dc.registerKeyHandler('KeyR', () => {}, { source: 'reload-system', pairedWithMobile: true });

        const unpaired = dc.getUnpairedRawKeys();

        expect(unpaired).toEqual([{ key: 'KeyF', source: 'fire-system' }]);
    });

    it('unregisterKeyHandler stops dispatching to a previously registered handler', () => {
        const edges = trackKey(dc, 'KeyX');

        press('KeyX');
        dc.unregisterKeyHandler('KeyX');
        release('KeyX');

        // Only the first (keydown) call should have reached the handler.
        expect(edges).toEqual([true]);
    });
});

/**
 * Regression guard for the latched-key bug behind "the S key gets stuck and the
 * car reverses on its own": a key held while the input gate closes, or while the
 * window loses focus, must never stay down.
 */
describe('DesktopControls key release (never latches)', () => {
    const backward = () => { dc.update(); return dc.moveY < 0; };

    it('honours a keyup that arrives after the input gate closed', () => {
        press('KeyS');
        expect(backward()).toBe(true);

        // e.g. the window lost focus, or the editor took over, mid-press.
        dc.setInputGate(() => false);
        release('KeyS');
        dc.setInputGate(() => true);

        expect(backward()).toBe(false);
    });

    it('releases held keys when the window loses focus (no keyup is ever delivered)', () => {
        const edges = trackKey(dc, 'KeyR');
        press('KeyS');
        press('KeyR');

        window.dispatchEvent(new Event('blur'));

        expect(backward()).toBe(false);
        expect(edges).toEqual([true, false]); // custom handlers get their release edge too
    });

    it('releases held keys when the tab is hidden', () => {
        press('KeyS');
        Object.defineProperty(document, 'hidden', { value: true, configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));

        expect(backward()).toBe(false);
        Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    });
});
