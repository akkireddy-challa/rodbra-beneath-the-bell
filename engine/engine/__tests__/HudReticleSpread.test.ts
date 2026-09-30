/**
 * @jest-environment jsdom
 */
import { GameHUD } from 'engine/GameHUD.js';

/**
 * The spreading crosshair is strictly opt-in. Every shipped game and every
 * community HUD theme renders the reticle as it is today until a system asks
 * for a spread, so the guard that matters most here is the one asserting the
 * DOM is unchanged when nobody calls the new method.
 */

// jsdom ships no matchMedia, and the HUD queries it while building its layers.
beforeAll(() => {
    if (!window.matchMedia) {
        window.matchMedia = ((query: string) => ({
            matches: false,
            media: query,
            onchange: null,
            addListener() {}, removeListener() {},
            addEventListener() {}, removeEventListener() {},
            dispatchEvent: () => false,
        })) as unknown as typeof window.matchMedia;
    }
});

function makeHud(): GameHUD {
    document.body.innerHTML = '';
    return new GameHUD();
}

function reticleOf(): HTMLElement {
    const el = document.getElementById('hud-reticle');
    if (!el) throw new Error('reticle not created');
    return el;
}

afterEach(() => { document.body.innerHTML = ''; });

describe('reticle spread', () => {
    it('leaves the reticle untouched when never called', () => {
        makeHud();
        const reticle = reticleOf();
        expect(reticle.children.length).toBe(0);
        expect(reticle.dataset.spread).toBeUndefined();
        expect(reticle.style.getPropertyValue('--hud-reticle-spread')).toBe('');
    });

    it('builds the ticks on first use and marks the element', () => {
        const hud = makeHud();
        hud.setReticleSpread(0.5);
        const reticle = reticleOf();
        expect(reticle.dataset.spread).toBe('true');
        expect(reticle.querySelectorAll('.hud-reticle__tick').length).toBe(4);
        expect(reticle.querySelectorAll('.hud-reticle__dot').length).toBe(1);
        expect(reticle.style.getPropertyValue('--hud-reticle-spread')).toBe('0.500');
    });

    it('builds the ticks exactly once however often it is driven', () => {
        const hud = makeHud();
        for (let i = 0; i < 100; i++) hud.setReticleSpread(i / 100);
        expect(reticleOf().querySelectorAll('.hud-reticle__tick').length).toBe(4);
    });

    it('clamps out-of-range values', () => {
        const hud = makeHud();
        hud.setReticleSpread(-5);
        expect(reticleOf().style.getPropertyValue('--hud-reticle-spread')).toBe('0.000');
        hud.setReticleSpread(12);
        expect(reticleOf().style.getPropertyValue('--hud-reticle-spread')).toBe('1.000');
    });

    it('keeps working with the blocked-reticle recolouring', () => {
        // The ticks paint with currentColor, so [data-blocked] applies to them
        // with no extra rule — both attributes must be able to coexist.
        const hud = makeHud();
        hud.setReticleSpread(0.3);
        hud.setReticleBlocked(true);
        const reticle = reticleOf();
        expect(reticle.dataset.blocked).toBe('true');
        expect(reticle.dataset.spread).toBe('true');
    });
});
