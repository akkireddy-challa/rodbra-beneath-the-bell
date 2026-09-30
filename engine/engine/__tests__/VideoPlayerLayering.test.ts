/**
 * @jest-environment jsdom
 *
 * Regression test for the cutscene layering guard.
 *
 * VideoPlayer used to append its overlay to `#game-container`, which is
 * `position: fixed` and therefore its own stacking context. That scoped the
 * overlay's z-index INSIDE the container, so every body-level layer painted over
 * the cutscene: the engine's own ESC hint (inside `.hud-gameplay-layer`, 9998)
 * sat on top of each frame, and any game-authored full-screen element mounted on
 * <body> hid the video entirely.
 *
 * The fix: the overlay mounts directly on <body>, above every HUD layer. These
 * tests lock in that placement + ordering, and the teardown that a body-level
 * overlay now needs (nothing else sweeps it up).
 */
import { VideoPlayer } from 'engine/VideoPlayer.js';
import {
    CUTSCENE_OVERLAY_Z_INDEX,
    SCREEN_OVERLAY_LAYER_Z_INDEX,
} from 'engine/ui/screenOverlayLayer.js';

// Mirrors `.hud-gameplay-layer { z-index: 9998 }` in hudBaseStyles.ts (which hosts
// `.hud-esc-hint`) and the FadeOverlay's 9999 — a cutscene must beat both.
const HUD_GAMEPLAY_LAYER_Z_INDEX = 9998;
const FADE_OVERLAY_Z_INDEX = 9999;

/** The <video> of the cutscene overlay VideoPlayer.play() mounts, or null. */
function findVideo(): HTMLVideoElement | null {
    return document.body.querySelector<HTMLVideoElement>(':scope > div > video');
}

/**
 * The one overlay VideoPlayer.play() puts on <body>, or null. Found through the
 * <video> it wraps, so a sibling body-level div (the game container, below) is
 * never mistaken for it.
 */
function findOverlay(): HTMLElement | null {
    return findVideo()?.parentElement ?? null;
}

function videoElement(): HTMLVideoElement {
    const video = findVideo();
    if (!video) throw new Error('no cutscene overlay on <body>');
    return video;
}

describe('cutscene overlay layering (VideoPlayer)', () => {
    let player: VideoPlayer;

    beforeEach(() => {
        // jsdom implements neither; play() must return a promise so the
        // autoplay-rejection path can .catch() it.
        HTMLMediaElement.prototype.play = jest.fn().mockResolvedValue(undefined);
        HTMLMediaElement.prototype.load = jest.fn();
        document.body.innerHTML = '';
        player = new VideoPlayer();
    });

    // A cutscene left on screen would keep its keydown listener on document.
    afterEach(() => player.dispose());

    it('mounts as a direct child of <body>, not inside the game container', () => {
        const container = document.createElement('div');
        container.id = 'game-container';
        document.body.appendChild(container);

        void player.play('intro.mp4');

        const overlay = findOverlay();
        expect(overlay).not.toBeNull();
        expect(overlay?.parentElement).toBe(document.body);
        expect(container.children.length).toBe(0);
    });

    it('stacks above every body-level layer that could cover the cutscene', () => {
        void player.play('intro.mp4');

        expect(findOverlay()?.style.zIndex).toBe(String(CUTSCENE_OVERLAY_Z_INDEX));
        expect(CUTSCENE_OVERLAY_Z_INDEX).toBeGreaterThan(SCREEN_OVERLAY_LAYER_Z_INDEX);
        expect(CUTSCENE_OVERLAY_Z_INDEX).toBeGreaterThan(HUD_GAMEPLAY_LAYER_Z_INDEX);
        expect(CUTSCENE_OVERLAY_Z_INDEX).toBeGreaterThan(FADE_OVERLAY_Z_INDEX);
    });

    it('removes the overlay from <body> and resolves when the video ends', async () => {
        const done = player.play('intro.mp4', { fadeIn: 0, fadeOut: 0 });
        videoElement().dispatchEvent(new Event('ended'));

        await expect(done).resolves.toBeUndefined();
        expect(findOverlay()).toBeNull();
    });

    it('dispose() tears down a cutscene still on screen and resolves its promise', async () => {
        const done = player.play('intro.mp4');
        expect(findOverlay()).not.toBeNull();

        player.dispose();

        await expect(done).resolves.toBeUndefined();
        expect(findOverlay()).toBeNull();
    });

    it('dispose() is a no-op when no cutscene is playing', () => {
        expect(() => player.dispose()).not.toThrow();
    });
});
