/**
 * The engine's own frame clock.
 *
 * WHY THIS EXISTS INSTEAD OF `THREE.Clock`: `Clock.getDelta()` is destructive —
 * it resets `oldTime` — and `Clock.getElapsedTime()` calls `getDelta()`
 * internally, so it is destructive too, despite reading like a pure getter.
 * `GameEngine.clock` is public on `EngineLike`, so ANY code that touches it
 * mid-frame silently steals part of the frame delta from whoever reads the
 * clock next. That is not hypothetical: two ambience systems and the
 * motorcycle physics used to do exactly this just before render, leaving
 * `animate()` with only the render-and-idle tail. Physics received 0.47s of
 * simulated time per 4.01s of wall clock — `PhysicsWorld.step()` drains a
 * fixed-timestep accumulator, so a starved delta means most frames run ZERO
 * substeps and the world crawls while the frame rate looks fine.
 *
 * FrameTimer is private to the engine and consumes nothing shared, so no game
 * code can reintroduce that failure. It also owns the two delta corrections
 * `animate()` needs, which keeps them out of the hot path's control flow:
 * the tab-return discard and the spike cap.
 *
 * Timestamps are passed in rather than read from `performance.now()` so tests
 * can drive it deterministically.
 */

/** Longest delta a single frame may report, in seconds. Beyond this a hitch
 *  (GC pause, debugger breakpoint, chunk generation) would hand physics a step
 *  large enough to explode stiff constraints. */
export const MAX_DELTA = 0.1;

/** Delta substituted for the frame a discard lands on. */
const FALLBACK_DELTA = 1 / 60;

export class FrameTimer {
    private lastTickMs = 0;
    /** Explicit rather than `lastTickMs === 0`: a timestamp of exactly 0 is a
     *  legal first reading, and treating it as "never ticked" would silently
     *  discard the second frame too. */
    private started = false;
    private discardPending = false;
    private _ambienceTime = 0;

    /**
     * Advance to `nowMs` (a `performance.now()` reading) and return the seconds
     * elapsed since the previous tick, corrected for tab returns and capped at
     * MAX_DELTA. The first tick of a session reports FALLBACK_DELTA.
     */
    tick(nowMs: number): number {
        const previous = this.lastTickMs;
        const isFirstTick = !this.started;
        this.lastTickMs = nowMs;
        this.started = true;

        let delta: number;
        if (this.discardPending || isFirstTick) {
            // Returning from a hidden tab: the real gap can be minutes. Discard
            // it entirely rather than capping — a capped 100ms step still
            // teleports everything by a sixth of a second.
            this.discardPending = false;
            delta = FALLBACK_DELTA;
        } else {
            delta = Math.min((nowMs - previous) / 1000, MAX_DELTA);
        }

        this._ambienceTime += delta;
        return delta;
    }

    /** Discard the next frame's delta (tab hidden, page frozen, long RAF gap). */
    discardNext(): void {
        this.discardPending = true;
    }

    /** True while a discard is queued but not yet consumed by a tick. */
    isDiscardPending(): boolean {
        return this.discardPending;
    }

    /**
     * Monotonic seconds since the first tick, summed from the CORRECTED deltas
     * above. This is the ambience time base — it advances in pause and in the
     * editor (rain keeps falling, torches keep flickering), unlike
     * `GameEngine.getElapsedTime()` which is gated on GameState.PLAYING.
     *
     * Summing corrected deltas rather than reading raw wall time is deliberate:
     * a five-minute tab hide advances ambience by one frame instead of jumping
     * rain phase and flicker by five minutes.
     */
    get ambienceTime(): number {
        return this._ambienceTime;
    }
}

/**
 * A drop-in replacement for `THREE.Clock`, kept alive for ONE reason:
 * `GameEngine.clock` is public on `EngineLike`, and published games carry
 * frozen template code that may call `engine.clock.getDelta()` /
 * `.getElapsedTime()`. THREE deprecated `Clock` in r183 (it warns on every
 * construction and points at `THREE.Timer`), and the engine's own answer to
 * "advance and read as separate steps" is FrameTimer above — so the only thing
 * left for `THREE.Clock` here was the deprecation warning.
 *
 * The public surface matches THREE.Clock member for member, so this stays
 * structurally assignable in both directions and no game code has to change.
 * Nothing in the engine reads it; a mid-frame `getDelta()` from game code is
 * now harmless, which is the whole point.
 */
export class LegacyClock {
    autoStart: boolean;
    startTime = 0;
    oldTime = 0;
    elapsedTime = 0;
    running = false;

    constructor(autoStart = true) {
        this.autoStart = autoStart;
    }

    start(): void {
        this.startTime = performance.now();
        this.oldTime = this.startTime;
        this.elapsedTime = 0;
        this.running = true;
    }

    stop(): void {
        this.getElapsedTime();
        this.running = false;
        this.autoStart = false;
    }

    /** NOTE: destructive, exactly like THREE.Clock — it calls getDelta(). */
    getElapsedTime(): number {
        this.getDelta();
        return this.elapsedTime;
    }

    getDelta(): number {
        if (this.autoStart && !this.running) {
            this.start();
            return 0;
        }
        if (!this.running) return 0;

        const newTime = performance.now();
        const diff = (newTime - this.oldTime) / 1000;
        this.oldTime = newTime;
        this.elapsedTime += diff;
        return diff;
    }
}
