import ASSET_MAP from 'bundle/BundledAssetData.js';
import { CUTSCENE_OVERLAY_Z_INDEX } from 'engine/ui/screenOverlayLayer.js';

/** Fade length used when the caller asks for neither, in seconds. */
const DEFAULT_FADE_SECONDS = 0.5;
/** How long the cutscene runs before the "you can skip this" hint fades in. */
const SKIP_HINT_DELAY_MS = 2000;
/** Grace period after the fade-out, in case `transitionend` never fires. */
const FADE_OUT_SAFETY_MS = 100;

/** Options for {@link VideoPlayer.play}; every field falls back to an engine default. */
export interface VideoPlayOptions {
    /** A click or any key ends the cutscene early. Default: true. */
    skippable?: boolean;
    /** Fade-in length in seconds, 0 to disable. Default: 0.5. */
    fadeIn?: number;
    /** Fade-out length in seconds, 0 to disable. Default: 0.5. */
    fadeOut?: number;
}

/**
 * Handles fullscreen video overlay playback for cutscenes.
 * Creates a DOM overlay on top of everything the game draws, plays the video,
 * and resolves when the video ends or is skipped.
 *
 * The overlay mounts on `<body>`, NOT inside `#game-container`: the container is
 * `position: fixed` and therefore its own stacking context, so an overlay nested
 * in it can never out-stack the body-level HUD layers no matter how high its
 * z-index. See screenOverlayLayer.ts for the full body-level stack.
 */
export class VideoPlayer {
    /** Teardown for the cutscene currently on screen, if any. Set while playing. */
    private activeTeardown: (() => void) | null = null;

    /**
     * Play a video as a fullscreen overlay.
     * Returns a promise that resolves when the video ends or is skipped.
     * Never rejects — errors resolve immediately so gameplay always continues.
     */
    play(videoUrl: string, options?: VideoPlayOptions): Promise<void> {
        const skippable = options?.skippable !== false;
        const fadeIn = options?.fadeIn ?? DEFAULT_FADE_SECONDS;
        const fadeOut = options?.fadeOut ?? DEFAULT_FADE_SECONDS;

        return new Promise<void>((resolve) => {
            const overlay = document.createElement('div');
            overlay.style.cssText = `
                position: fixed;
                inset: 0;
                background: #000;
                z-index: ${CUTSCENE_OVERLAY_Z_INDEX};
                display: flex;
                align-items: center;
                justify-content: center;
                flex-direction: column;
                opacity: ${fadeIn > 0 ? '0' : '1'};
                transition: opacity ${fadeIn}s ease;
            `;

            const video = document.createElement('video');
            video.crossOrigin = 'anonymous';
            video.preload = 'auto';
            video.playsInline = true;
            video.style.cssText = `
                width: 100%; height: 100%;
                object-fit: contain;
            `;
            overlay.appendChild(video);

            let skipHintTimeout: number | undefined;
            if (skippable) {
                const skipHint = document.createElement('div');
                skipHint.textContent = 'Click or press any key to skip';
                skipHint.style.cssText = `
                    position: absolute;
                    bottom: 40px;
                    left: 50%;
                    transform: translateX(-50%);
                    color: rgba(255, 255, 255, 0.7);
                    font-size: 14px;
                    font-family: sans-serif;
                    opacity: 0;
                    transition: opacity 0.5s ease;
                    pointer-events: none;
                `;
                overlay.appendChild(skipHint);
                skipHintTimeout = window.setTimeout(() => {
                    skipHint.style.opacity = '1';
                }, SKIP_HINT_DELAY_MS);
            }

            let fadeOutTimeout: number | undefined;
            let ending = false;

            // Detach everything, drop the overlay and settle the play() promise.
            // Whichever of `transitionend` / the safety timeout gets here first
            // cancels the other, so this runs exactly once per cutscene.
            const removeOverlay = () => {
                clearTimeout(skipHintTimeout);
                clearTimeout(fadeOutTimeout);
                overlay.removeEventListener('transitionend', removeOverlay);
                overlay.removeEventListener('click', cleanup);
                document.removeEventListener('keydown', cleanup);
                video.removeEventListener('ended', cleanup);
                video.removeEventListener('error', onError);
                video.pause();
                video.removeAttribute('src');
                video.load(); // release resources
                overlay.remove();
                this.activeTeardown = null;
                resolve();
            };

            // Fade out first when asked for; `transitionend` then removes the overlay.
            const cleanup = () => {
                if (ending) return;
                ending = true;

                if (fadeOut <= 0) {
                    removeOverlay();
                    return;
                }
                overlay.style.transition = `opacity ${fadeOut}s ease`;
                overlay.style.opacity = '0';
                overlay.addEventListener('transitionend', removeOverlay, { once: true });
                fadeOutTimeout = window.setTimeout(removeOverlay, fadeOut * 1000 + FADE_OUT_SAFETY_MS);
            };

            const onError = () => {
                console.warn('[VideoPlayer] Video playback error:', video.error?.message);
                cleanup();
            };

            video.addEventListener('ended', cleanup);
            video.addEventListener('error', onError);
            if (skippable) {
                overlay.addEventListener('click', cleanup);
                document.addEventListener('keydown', cleanup);
            }

            // Add overlay to DOM. Body-level, above every HUD layer — see the
            // class comment and screenOverlayLayer.ts for why not the container.
            this.activeTeardown = removeOverlay;
            document.body.appendChild(overlay);

            // Trigger fade-in after browser paints the initial opacity: 0 state
            if (fadeIn > 0) {
                requestAnimationFrame(() => {
                    overlay.style.opacity = '1';
                });
            }

            // Wait for enough data to be buffered before playing.
            // MP4 files with moov atom at end need full download before playback can start.
            video.addEventListener('canplay', () => {
                video.play().catch(() => {
                    console.warn('[VideoPlayer] Autoplay blocked, resolving immediately');
                    cleanup();
                });
            }, { once: true });

            // Set src after listeners are attached to avoid race conditions
            video.src = ASSET_MAP.get(videoUrl) ?? videoUrl;
        });
    }

    /**
     * Tear down a cutscene that is still on screen, skipping the fade-out, and
     * resolve its pending play() promise. Called from GameEngine.dispose(): the
     * overlay lives on <body>, so nothing else would sweep it up.
     */
    dispose(): void {
        this.activeTeardown?.();
    }
}
