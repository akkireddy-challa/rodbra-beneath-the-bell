/**
 * @jest-environment jsdom
 */

import type { GameEngine } from 'engine/GameEngine.js';
import { GameRuntimeController } from 'engine/GameRuntimeController.js';
import { GameState } from 'engine/GameStateManager.js';
import type { PointerLockManager } from 'engine/PointerLockManager.js';

/**
 * Desktop ESC → pause card, in pointer-locked and free-mouse games alike.
 *
 * jsdom has no Pointer Lock API, so `document.pointerLockElement` and
 * `requestPointerLock` are stubbed. The browser half — ESC releasing the lock without a
 * keydown reaching the page — is simulated with a bare `pointerlockchange`.
 */

let lockedElement: Element | null = null;
let lockGranted = true;

function installPointerLockStubs(): void {
    Object.defineProperty(document, 'pointerLockElement', {
        configurable: true,
        get: () => lockedElement,
    });
    Object.defineProperty(HTMLElement.prototype, 'requestPointerLock', {
        configurable: true,
        value: jest.fn(function (this: HTMLElement) {
            if (!lockGranted) return Promise.reject(new Error('The user has exited the lock before this request was completed.'));
            lockedElement = this;
            document.dispatchEvent(new Event('pointerlockchange'));
            return Promise.resolve();
        }),
    });
    Object.defineProperty(document, 'exitPointerLock', {
        configurable: true,
        value: () => releaseLock(),
    });
}

/** The browser releasing the lock, as it does on ESC — no keydown reaches the page. */
function releaseLock(): void {
    lockedElement = null;
    document.dispatchEvent(new Event('pointerlockchange'));
}

function pressEscape(): void {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
}

function stubEngine(hudRoot: HTMLElement): GameEngine {
    const hud = {
        createCustomElement: (id: string, options: { html: string; onCreate?: (c: HTMLElement) => void }) => {
            const container = document.createElement('div');
            container.id = id;
            container.innerHTML = options.html;
            hudRoot.appendChild(container);
            options.onCreate?.(container);
        },
        removeElement: (id: string) => { hudRoot.querySelector(`#${id}`)?.remove(); },
        setGameplayUIVisible: jest.fn(),
        showControlsTemporarily: jest.fn(),
        showToast: jest.fn(),
    };
    return {
        setPointerLockManager: jest.fn(),
        setStartGameHandler: jest.fn(),
        setPlayButtonVisibilityHandler: jest.fn(),
        setStartupUiModeHandler: jest.fn(),
        setUIComponentChangeHandler: jest.fn(),
        getUIComponent: () => null,
        quality: { onTierChanged: jest.fn() },
        genreModule: { hud },
        getPlayerController: () => null,
        exitInteractiveUI: jest.fn(),
    } as unknown as GameEngine;
}

describe('desktop ESC reaches the pause card', () => {
    let hudRoot: HTMLElement;
    let controller: GameRuntimeController;
    let plm: PointerLockManager;
    let engine: GameEngine;

    const state = (): GameState => controller.getStateManager().getCurrentState();
    const reasons = (): string[] => [...controller.getStateManager().getPauseReasons()].sort();
    /** On screen and not fading out — a leaving card lingers for its animation only. */
    const cardShown = (): boolean =>
        hudRoot.querySelector('#engine-pause-overlay .ui-modal-overlay:not([data-leaving])') !== null;
    const clickResume = (): void => {
        hudRoot.querySelector<HTMLButtonElement>('.pause-screen-resume')?.click();
    };

    /** Start gameplay holding the lock, as a click on Play inside the iframe does. */
    function startLocked(): void {
        controller.getStateManager().markPlaying();
        plm.requestLock();
        expect(plm.getIsLocked()).toBe(true);
    }

    beforeEach(() => {
        jest.useFakeTimers();
        window.history.replaceState({}, '', '/?platform=desktop');
        lockedElement = null;
        lockGranted = true;
        installPointerLockStubs();

        hudRoot = document.createElement('div');
        document.body.appendChild(hudRoot);
        const container = document.createElement('div');
        document.body.appendChild(container);

        controller = new GameRuntimeController(container, jest.fn());
        engine = stubEngine(hudRoot);
        controller.attachEngine(engine, jest.fn());
        const manager = controller.getPointerLockManager();
        if (!manager) throw new Error('attachEngine did not create a PointerLockManager');
        plm = manager;
    });

    afterEach(() => {
        plm.dispose();
        hudRoot.remove();
        jest.useRealTimers();
    });

    it('opens the card the moment ESC releases a held lock, with no "Click to play" over it', () => {
        startLocked();

        releaseLock();

        expect(state()).toBe(GameState.PAUSED);
        expect(reasons()).toEqual(['manual']);
        expect(cardShown()).toBe(true);
        expect(plm.isOverlayVisible()).toBe(false);
    });

    it('ignores the unlocking ESC if the browser also delivers it as a keydown', () => {
        startLocked();
        releaseLock();

        pressEscape();

        expect(cardShown()).toBe(true);
    });

    it('keeps "Click to play" for a lock that never landed, and ESC there opens the card', () => {
        controller.getStateManager().markPlaying();
        lockGranted = false;
        plm.requestLockWithRetry();
        jest.advanceTimersByTime(1500);

        expect(plm.isOverlayVisible()).toBe(true);
        expect(reasons()).toEqual(['pointer-lock']);
        expect(cardShown()).toBe(false);

        pressEscape();

        expect(plm.isOverlayVisible()).toBe(false);
        expect(reasons()).toEqual(['manual']);
        expect(cardShown()).toBe(true);
    });

    it('Resume re-locks, and the game stays paused until the lock lands', () => {
        startLocked();
        releaseLock();
        lockGranted = false;

        clickResume();

        expect(cardShown()).toBe(false);
        expect(reasons()).toEqual(['pointer-lock']);

        // Chrome's post-ESC cooldown ends; a retry lands.
        lockGranted = true;
        jest.advanceTimersByTime(300);

        expect(plm.getIsLocked()).toBe(true);
        expect(state()).toBe(GameState.PLAYING);
    });

    it('ESC on the card leaves it up — ESC grants no user activation, so it cannot take the cursor back', () => {
        startLocked();
        releaseLock();
        jest.advanceTimersByTime(500);

        pressEscape();

        expect(cardShown()).toBe(true);
        expect(plm.isOverlayVisible()).toBe(false);
        expect(reasons()).toEqual(['manual']);
    });

    it('the Creator\'s Play button leaves the card up once the player has held the cursor', () => {
        startLocked();
        releaseLock();

        controller.resumeFromParentFrame();

        expect(cardShown()).toBe(true);
        expect(plm.isOverlayVisible()).toBe(false);
        expect(reasons()).toEqual(['manual']);
    });

    it('a re-lock the browser refuses after Resume comes back to the card, not "Click to play"', () => {
        startLocked();
        releaseLock();
        lockGranted = false;

        clickResume();
        jest.advanceTimersByTime(1500);

        expect(cardShown()).toBe(true);
        expect(plm.isOverlayVisible()).toBe(false);
        expect(reasons()).toEqual(['manual']);
    });

    it('a game dialog closing without a click lands on the card', () => {
        startLocked();
        plm.setInteractiveUIMode(true);
        plm.exitLock();
        expect(cardShown()).toBe(false);

        plm.setInteractiveUIMode(false);

        expect(cardShown()).toBe(true);
        expect(plm.isOverlayVisible()).toBe(false);
        expect(reasons()).toEqual(['manual']);
    });

    it('a game dialog closed by a click takes the cursor straight back, no prompt at all', () => {
        startLocked();
        plm.setInteractiveUIMode(true);
        plm.exitLock();
        // The order GameEngine.exitInteractiveUI uses: ask for the lock, then leave the mode.
        plm.requestLockWithRetry();
        plm.setInteractiveUIMode(false);

        expect(plm.getIsLocked()).toBe(true);
        expect(cardShown()).toBe(false);
        expect(state()).toBe(GameState.PLAYING);
    });

    it('toggles the card on a single ESC in a free-mouse game', () => {
        plm.setFreeMouseMode(true);
        controller.getStateManager().markPlaying();

        pressEscape();
        expect(cardShown()).toBe(true);

        pressEscape();
        expect(cardShown()).toBe(false);
        expect(state()).toBe(GameState.PLAYING);
        expect(engine.exitInteractiveUI).toHaveBeenCalled();
    });
});
