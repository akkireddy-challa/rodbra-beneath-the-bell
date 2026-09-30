/**
 * @jest-environment jsdom
 *
 * The pause card carries the Bitmagic branding for touch players, since a
 * published game hides its corner watermark there (it sits under the on-screen
 * controls). The logo URL comes out of the injected watermark node, so both
 * halves of that contract need a DOM.
 */
import { GameState, GameStateManager } from 'engine/GameStateManager.js';
import type { IGameHUD } from 'engine/IGameHUD.js';
import { PauseScreen } from 'engine/ui/PauseScreen.js';
import { DEFAULT_SCREEN_TRANSITION, setScreenTransition } from 'engine/ui/modalCard.js';

const LOGO_URL = 'https://cdn.example/assets/bitmagic-logo-v2.png';

/** Minimal HUD stand-in: PauseScreen only ever creates and removes one element. */
function createFakeHud(): { hud: IGameHUD; root: HTMLElement } {
    const root = document.createElement('div');
    document.body.appendChild(root);

    const fake = {
        createCustomElement(id: string, options: { html: string; onCreate?: (el: HTMLElement) => void }): void {
            const container = document.createElement('div');
            container.id = id;
            container.innerHTML = options.html;
            root.appendChild(container);
            options.onCreate?.(container);
        },
        removeElement(id: string): void {
            root.querySelector(`#${id}`)?.remove();
        },
    };
    return { hud: fake as unknown as IGameHUD, root };
}

/** A PauseScreen wired to a fresh state manager, with the game playing. */
function setup(): { gameStateManager: GameStateManager; root: HTMLElement } {
    const gameStateManager = new GameStateManager(GameState.MENU);
    const { hud, root } = createFakeHud();
    // The screen wires itself to the state manager; nothing to hold on to.
    new PauseScreen({ gameStateManager, getHud: () => hud, onResume: () => {} });
    gameStateManager.markPlaying();
    return { gameStateManager, root };
}

/** The same, then paused — so the card is mounted. Returns the HUD root it mounted into. */
function mountPaused(): HTMLElement {
    const { gameStateManager, root } = setup();
    gameStateManager.setPaused(true, 'manual');
    return root;
}

/** The watermark publishing injects into a published game's document. */
function injectWatermark(): void {
    const branding = document.createElement('div');
    branding.id = 'bitmagic-branding';
    branding.innerHTML = `<a href="https://bitmagic.ai"><img src="${LOGO_URL}" alt="Bitmagic" /></a>`;
    document.body.appendChild(branding);
}

beforeEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
});

describe('PauseScreen enter/leave animation', () => {
    const overlays = (root: HTMLElement): HTMLElement[] =>
        Array.from(root.querySelectorAll<HTMLElement>('#engine-pause-overlay .ui-modal-overlay'));

    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('fades the card out before removing it, and lets clicks through meanwhile', () => {
        const { gameStateManager, root } = setup();
        gameStateManager.setPaused(true, 'manual');
        expect(overlays(root)[0]?.classList.contains('ui-modal-overlay--animated')).toBe(true);

        gameStateManager.setPaused(false, 'manual');

        expect(overlays(root)).toHaveLength(1);
        expect(overlays(root)[0]?.dataset.leaving).toBe('true');
        jest.advanceTimersByTime(140);
        expect(overlays(root)).toHaveLength(0);
    });

    it('a pause during the fade-out keeps exactly one live card', () => {
        const { gameStateManager, root } = setup();
        gameStateManager.setPaused(true, 'manual');
        gameStateManager.setPaused(false, 'manual');

        gameStateManager.setPaused(true, 'manual');
        jest.advanceTimersByTime(500);

        expect(overlays(root)).toHaveLength(1);
        expect(overlays(root)[0]?.dataset.leaving).toBeUndefined();
    });

    describe('setScreenTransition', () => {
        afterEach(() => setScreenTransition(DEFAULT_SCREEN_TRANSITION));

        it("'none' removes the card at once", () => {
            setScreenTransition({ ...DEFAULT_SCREEN_TRANSITION, style: 'none' });
            const { gameStateManager, root } = setup();
            gameStateManager.setPaused(true, 'manual');

            gameStateManager.setPaused(false, 'manual');

            expect(overlays(root)).toHaveLength(0);
        });

        it('a longer leave keeps the card for its whole fade', () => {
            setScreenTransition({ ...DEFAULT_SCREEN_TRANSITION, leaveMs: 400 });
            const { gameStateManager, root } = setup();
            gameStateManager.setPaused(true, 'manual');
            gameStateManager.setPaused(false, 'manual');

            jest.advanceTimersByTime(300);
            expect(overlays(root)).toHaveLength(1);
            jest.advanceTimersByTime(100);
            expect(overlays(root)).toHaveLength(0);
        });

        it('hands style and durations to the CSS on the root element', () => {
            setScreenTransition({ style: 'fade', enterMs: 90, leaveMs: Number.NaN });

            const root = document.documentElement;
            expect(root.dataset.uiScreenTransition).toBe('fade');
            expect(root.style.getPropertyValue('--ui-screen-enter-ms')).toBe('90ms');
            // Untrusted input falls back to the default rather than poisoning the CSS.
            expect(root.style.getPropertyValue('--ui-screen-leave-ms')).toBe(`${DEFAULT_SCREEN_TRANSITION.leaveMs}ms`);
        });
    });
});

describe('PauseScreen Bitmagic branding', () => {
    it('links the pause-card logo to bitmagic.ai when the game carries a watermark', () => {
        injectWatermark();

        const brand = mountPaused().querySelector<HTMLAnchorElement>('.pause-screen-brand');

        expect(brand).not.toBeNull();
        expect(brand?.getAttribute('href')).toBe('https://bitmagic.ai/');
        expect(brand?.getAttribute('rel')).toBe('noopener noreferrer');
        expect(brand?.querySelector('img')?.getAttribute('src')).toBe(LOGO_URL);
    });

    it('shows no logo when the game was published without a watermark', () => {
        expect(mountPaused().querySelector('.pause-screen-brand')).toBeNull();
    });

    it('reveals the pause logo only where the corner watermark is hidden', () => {
        // Publishing hides #bitmagic-branding under (pointer: coarse); this rule
        // must be its exact complement, or a device gets two logos or none.
        injectWatermark();
        mountPaused();

        const styles = document.getElementById('ui-modal-card-styles')?.textContent ?? '';
        expect(styles).toContain('.pause-screen-brand { display: none; }');
        expect(styles).toMatch(/@media \(pointer: coarse\)\s*\{[\s\S]*?\.pause-screen-brand \{[\s\S]*?display: inline-flex;/);
    });
});
