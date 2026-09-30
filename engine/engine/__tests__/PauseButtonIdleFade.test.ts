/**
 * @jest-environment jsdom
 */

import type { IGameHUD } from 'engine/IGameHUD.js';
import { PauseButton } from 'engine/ui/PauseButton.js';
import { isPauseButtonShown, setPauseButtonHidden } from 'engine/ui/pauseButtonPolicy.js';

/**
 * PauseButton and the policy both gate on isMobileRuntime(), which honours the
 * `?platform=mobile` override the creator's mobile preview uses — the one lever
 * that works under jsdom, where there is no touch screen to detect.
 */
function forceMobileRuntime(): void {
    window.history.replaceState({}, '', '/?platform=mobile');
}

/** Minimal IGameHUD: enough for PauseButton to mount its markup and be found again. */
function stubHud(root: HTMLElement): IGameHUD {
    return {
        getScale: () => ({ borderWidth: 1, borderRadius: 8, paddingSm: 6, paddingMd: 10 }),
        createCustomElement: (_id: string, options: { html: string; onCreate?: (c: HTMLElement) => void }) => {
            const container = document.createElement('div');
            container.innerHTML = options.html;
            root.appendChild(container);
            options.onCreate?.(container);
        },
        removeElement: (_id: string) => { root.innerHTML = ''; },
    } as unknown as IGameHUD;
}

const button = (root: HTMLElement): HTMLElement =>
    root.querySelector('.pause-btn') as HTMLElement;

describe('PauseButton idle fade', () => {
    let root: HTMLElement;

    beforeEach(() => {
        jest.useFakeTimers();
        forceMobileRuntime();
        setPauseButtonHidden(false);
        root = document.createElement('div');
        document.body.appendChild(root);
    });

    afterEach(() => {
        jest.useRealTimers();
        root.remove();
    });

    it('starts lit, fades once the player has had time to see it, and still opens the card', () => {
        const onPause = jest.fn();
        new PauseButton(stubHud(root), onPause);

        expect(button(root).classList.contains('is-idle')).toBe(false);

        jest.advanceTimersByTime(4000);
        expect(button(root).classList.contains('is-idle')).toBe(true);

        // Dimmed is still a live 44px target — the fade is opacity only.
        button(root).dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(onPause).toHaveBeenCalledTimes(1);
    });

    it('comes back to full opacity on touch, then fades again', () => {
        new PauseButton(stubHud(root), jest.fn());
        jest.advanceTimersByTime(4000);
        expect(button(root).classList.contains('is-idle')).toBe(true);

        button(root).dispatchEvent(new Event('pointerdown', { bubbles: true }));
        expect(button(root).classList.contains('is-idle')).toBe(false);

        jest.advanceTimersByTime(4000);
        expect(button(root).classList.contains('is-idle')).toBe(true);
    });

    it('drops its pending fade on dispose', () => {
        const pauseButton = new PauseButton(stubHud(root), jest.fn());
        const btn = button(root);
        pauseButton.dispose();

        jest.advanceTimersByTime(4000);
        expect(btn.classList.contains('is-idle')).toBe(false);
    });
});

describe('pause button policy', () => {
    afterEach(() => setPauseButtonHidden(false));

    it('is shown on a touch runtime and hidden when the game turns it off', () => {
        forceMobileRuntime();
        expect(isPauseButtonShown()).toBe(true);

        setPauseButtonHidden(true);
        expect(isPauseButtonShown()).toBe(false);
    });

    it('is never shown on desktop, where Escape opens the card', () => {
        window.history.replaceState({}, '', '/?platform=desktop');
        expect(isPauseButtonShown()).toBe(false);
    });
});
