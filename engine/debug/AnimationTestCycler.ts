/**
 * @fileoverview AnimationTestCycler — debug helper for verifying every clip in
 * `AnimationAssets.coreAnimations` (and any other supplied motion IDs) plays
 * correctly on the visible character.
 *
 * Press a configurable key (default `N`) to advance to the next animation.
 * Press the back key (default `B`) to go to the previous. The active clip
 * loops by re-triggering itself in its own `onFinished` callback, so blocks
 * stay in motion until you press the next key (the current motion is
 * automatically stopped when the next one is started — `playCustomAnimation`
 * swaps out the active track-B Mixamo player for you).
 *
 * Use this whenever you ship a new clip, swap the Uthana skeleton, or refactor
 * any of the Mixamo player path — it's the fastest way to eyeball every
 * built-in animation against the block character without writing a
 * one-off test scene.
 *
 * ## Quick start
 *
 * ```ts
 * import { AnimationTestCycler, DEFAULT_ANIMATION_TEST_CYCLER_OPTIONS } from 'debug/AnimationTestCycler.js';
 *
 * // After the player controller is initialised (typically end of Game.ts setup):
 * const cycler = new AnimationTestCycler(playerController, { ...DEFAULT_ANIMATION_TEST_CYCLER_OPTIONS });
 * cycler.enable();
 * // Now press N in-game to step through every coreAnimations clip.
 * ```
 *
 * To test a custom list (e.g. just the Uthana clip + a generated one in
 * `world.json`):
 *
 * ```ts
 * const cycler = new AnimationTestCycler(playerController, {
 *     ...DEFAULT_ANIMATION_TEST_CYCLER_OPTIONS,
 *     motionIds: ['mDanceUthana01', 'mYourGeneratedMotionId'],
 *     speed: 1.0,
 * });
 * cycler.enable();
 * ```
 *
 * Remember to call `cycler.disable()` (or simply drop the reference and reload)
 * before shipping — this hooks `window.keydown`, which would otherwise compete
 * with template input bindings.
 */

import { ALL_BUILTIN_MOTION_IDS } from 'engine/AnimationPacks.js';
import type { PlayerController } from 'engine/PlayerController.js';

export interface AnimationTestCyclerOptions {
    /**
     * Motion IDs to cycle through, in order. Default: every entry in
     * `ALL_BUILTIN_MOTION_IDS` — every clip the active library ships,
     * on-demand packs (postures, strafes, weapon holds) included.
     */
    motionIds: string[];
    /** `KeyboardEvent.code` to advance to the next animation. Default `'KeyN'`. */
    advanceKey: string;
    /** `KeyboardEvent.code` to step back to the previous animation. Default `'KeyB'`. */
    previousKey: string;
    /** Playback rate (1 = native). Default 1.0. */
    speed: number;
    /** Crossfade-in duration in seconds. Default 0.2. */
    fadeInDuration: number;
    /** Crossfade-out duration in seconds. Default 0.2. */
    fadeOutDuration: number;
    /**
     * When true, upper body plays the clip while legs keep the run cycle if
     * the player is running. Useful for testing punch/throw/cast animations
     * without locking the character in place. Default false (full body).
     */
    splitBodyOnRun: boolean;
    /**
     * When true, the clip's hips translation track is locked so the visual
     * rotates in place instead of drifting across the world. Recommended ON
     * for testing animations whose root motion would otherwise carry the
     * character offscreen. Default true.
     */
    filterRootMotion: boolean;
    /**
     * When true, log the current motion and index to console on advance.
     * Default true.
     */
    logToConsole: boolean;
}

export const DEFAULT_ANIMATION_TEST_CYCLER_OPTIONS: AnimationTestCyclerOptions = {
    // EVERY built-in clip of the active library, packs included (postures,
    // strafes, weapon holds) — not just the 11 core locomotion clips, and not
    // the inactive library's ids. "Step through every animation" that skipped
    // the postures is what made the crawl look like it had none of its own.
    motionIds: ALL_BUILTIN_MOTION_IDS,
    advanceKey: 'KeyN',
    previousKey: 'KeyB',
    speed: 1.0,
    fadeInDuration: 0.2,
    fadeOutDuration: 0.2,
    splitBodyOnRun: false,
    filterRootMotion: true,
    logToConsole: true,
};

/**
 * Cycles the player's character through a list of motion IDs, looping each
 * until the user presses the advance key. See module header for usage.
 */
export class AnimationTestCycler {
    private readonly playerController: PlayerController;
    private readonly options: AnimationTestCyclerOptions;
    private currentIndex: number = -1;
    private keyHandler: ((e: KeyboardEvent) => void) | null = null;
    /**
     * The motion currently expected to be playing. Stored so the re-trigger
     * loop knows to bail out when the user has advanced away mid-clip.
     */
    private activeMotionId: string | null = null;

    constructor(playerController: PlayerController, options: AnimationTestCyclerOptions) {
        this.playerController = playerController;
        this.options = options;
    }

    /** Install the keyboard listener. Idempotent. */
    enable(): void {
        if (this.keyHandler || this.options.motionIds.length === 0) return;
        this.keyHandler = (e: KeyboardEvent) => {
            // Ignore key events when modifier keys are held (avoid stepping
            // animation cycler when the user is hitting Cmd-N / Ctrl-N etc.)
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            if (e.code === this.options.advanceKey) {
                e.preventDefault();
                this.next();
            } else if (e.code === this.options.previousKey) {
                e.preventDefault();
                this.previous();
            }
        };
        window.addEventListener('keydown', this.keyHandler);
        if (this.options.logToConsole) {
            console.log(
                `[AnimationTestCycler] enabled — ${this.options.motionIds.length} clip(s). ` +
                `Press '${this.options.advanceKey}' for next, '${this.options.previousKey}' for previous.`,
            );
        }
    }

    /** Remove the keyboard listener. Safe to call when not enabled. */
    disable(): void {
        if (this.keyHandler) {
            window.removeEventListener('keydown', this.keyHandler);
            this.keyHandler = null;
        }
        this.activeMotionId = null;
    }

    /** Advance to the next motion ID, wrapping around at the end of the list. */
    next(): void {
        this.currentIndex = (this.currentIndex + 1) % this.options.motionIds.length;
        this.playCurrent();
    }

    /** Step back to the previous motion ID, wrapping at the start. */
    previous(): void {
        const n = this.options.motionIds.length;
        this.currentIndex = (this.currentIndex - 1 + n) % n;
        this.playCurrent();
    }

    /** Return the motion ID currently playing (or `null` if none played yet). */
    getCurrentMotionId(): string | null {
        return this.options.motionIds[this.currentIndex] ?? null;
    }

    private playCurrent(): void {
        const motionId = this.options.motionIds[this.currentIndex];
        if (!motionId) return;
        const animController = this.playerController.animationController;
        if (!animController?.playCustomAnimation) {
            console.warn('[AnimationTestCycler] Animation controller not ready');
            return;
        }
        if (this.options.logToConsole) {
            console.log(
                `[AnimationTestCycler] [${this.currentIndex + 1}/${this.options.motionIds.length}] ${motionId}`,
            );
        }
        this.activeMotionId = motionId;
        const result = animController.playCustomAnimation(motionId, {
            speed: this.options.speed,
            fadeInDuration: this.options.fadeInDuration,
            fadeOutDuration: this.options.fadeOutDuration,
            splitBodyOnRun: this.options.splitBodyOnRun,
            filterRootMotion: this.options.filterRootMotion,
            interruptOnMovement: false,
            onFinished: () => {
                // Re-trigger only if the user hasn't advanced to a different
                // clip in the meantime. activeMotionId is the source of truth
                // for "what should be playing right now"; if it has changed,
                // a fresh playCustomAnimation has already taken track B and
                // we must not stomp it.
                if (this.activeMotionId === motionId) {
                    this.playCurrent();
                }
            },
        });
        if (!result?.success && this.options.logToConsole) {
            console.warn(
                `[AnimationTestCycler] playCustomAnimation('${motionId}') returned success=false. ` +
                `Is the clip loaded? Built-in Mixamo clips are pre-loaded automatically; ` +
                `world.json assets need loadCustomAnimation() first.`,
            );
        }
    }
}
