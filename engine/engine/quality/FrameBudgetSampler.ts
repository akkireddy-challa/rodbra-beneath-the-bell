/**
 * A running per-frame accumulator that emits one summary every couple of seconds, for the
 * auto-tuner to judge. Zero allocation per frame.
 *
 * WHY A WINDOW AND NOT A PER-FRAME SPIKE RULE. The engine caps the render loop at 60 fps,
 * and the cap's own epsilon (`elapsed < frameInterval` against a 16.6 ms vsync gap) costs a
 * perfectly healthy 60 Hz desktop a small fraction of its frames — measured at ~0.2-0.6% of
 * gaps landing above 1.4x the interval, with the `elapsed % frameInterval` carry absorbing
 * the rest. A per-frame threshold cannot tell those occasional 33 ms gaps from real dropped
 * frames. A two-second FRAME COUNT can: a healthy machine reads 57-60 fps, and a device
 * that is actually struggling reads 30-45. The rate is the signal; individual gaps are not.
 *
 * WHY NOT `PerfStatsCollector`. That is the lab tool, and it must stay one. Its spike path
 * calls `scene.traverseVisible()` and builds a per-object fingerprint map on a 150 ms
 * minimum gap — on a struggling device that fires constantly, and a full scene traverse per
 * spike is the last thing to add to a device already dropping frames. It is also gated on
 * an `ENABLE_PERF_STATS` message from the Creator, so it is off in a published game, which
 * is exactly where this has to work. This is fed instead from the already-unconditional
 * instrumentation site in `GameEngine.animate`, and reads no clock of its own.
 *
 * All timestamps are passed IN rather than read from `performance.now()` here — the same
 * reason `FrameTimer` states: a module that reads its own clock cannot be tested against a
 * fabricated frame stream, and a fabricated frame stream is the only way to prove the
 * healthy-60 Hz case does not trigger a downgrade.
 */

/** One window's worth of evidence. The only thing `evaluateWindow` ever sees. */
export interface FrameWindow {
    /** Window bounds in `performance.now()` ms. */
    startMs: number;
    endMs: number;
    /** Frames the loop actually rendered in the window. The primary signal. */
    renderedFrames: number;
    /** What the loop was capped to, so the tuner can judge a rate rather than a count. */
    targetFps: number;
    /** Gaps beyond `DROPPED_FRAME_FACTOR` x the interval — stutter that need not move the mean. */
    droppedFrames: number;
    /** Worst single rAF gap in the window, ms. Diagnostic; not a trigger on its own. */
    worstGapMs: number;
    /** Summed main-thread time inside the frame callback, ms. */
    busyMsSum: number;
    /** Worst single frame's main-thread time, ms. */
    busyMsMax: number;
    /** Summed CPU time inside `renderer.render()`, ms. */
    renderMsSum: number;
    /**
     * Change in `renderer.info` program count across the window. Non-zero means a shader
     * compiled, and a compile stall is a fact about the CONTENT arriving, not about how
     * fast the device is — so the window is discarded rather than blamed.
     */
    programDelta: number;
    /** Change in geometry count — a stream-in or a level load, discarded for the same reason. */
    geometryDelta: number;
    /** Change in texture count, likewise. */
    textureDelta: number;
    /** An explicit disturbance was reported during the window (level load, resize, respawn). */
    disturbed: boolean;
}

/** Counted as dropped at 1.75x the interval — two whole vsyncs missed, not a jittery one. */
export const DROPPED_FRAME_FACTOR = 1.75;

/** Renderer counters the sampler reads once per window, never per frame. */
export interface RendererCounters {
    programs: number;
    geometries: number;
    textures: number;
}

/**
 * Accumulates frames and emits a `FrameWindow` when one is full.
 *
 * `recordFrame` runs on every rendered frame of every session, so it does arithmetic on
 * numbers the caller already computed and nothing else — no array push, no object literal,
 * no clock read. The one allocation per window is the emitted record itself.
 */
export class FrameBudgetSampler {
    private windowStartMs = 0;
    private started = false;
    /** A window must never mix paused and active frame-rate caps. */
    private targetFps = 0;
    private frames = 0;
    private dropped = 0;
    private worstGapMs = 0;
    private busySum = 0;
    private busyMax = 0;
    private renderSum = 0;
    private counters: RendererCounters = { programs: 0, geometries: 0, textures: 0 };
    /** True once a disturbance was reported inside the current window. */
    private disturbed = false;

    constructor(private readonly windowMs: number) {}

    /**
     * Mark the current window as containing something that is not the device's fault — a
     * level load, a resize, a respawn, or a change the tuner itself just applied. The flag
     * survives to the end of the window, so a disturbance anywhere in it discards all of it.
     */
    noteDisturbance(): void {
        this.disturbed = true;
    }

    /**
     * Record one rendered frame and return a window if this frame completed one.
     *
     * `gapMs` is the rAF-to-rAF span and `busyMs` the time spent inside the frame callback;
     * both are already computed at the call site. `counters` is read from `renderer.info`
     * once here rather than per frame — that is what makes compile/stream-in discrimination
     * essentially free, and what means no call site can forget to do it.
     */
    recordFrame(
        nowMs: number,
        gapMs: number,
        busyMs: number,
        renderMs: number,
        targetFps: number,
        counters: RendererCounters,
    ): FrameWindow | null {
        if (!this.started || targetFps !== this.targetFps) {
            this.started = true;
            this.targetFps = targetFps;
            this.windowStartMs = nowMs;
            this.clearAccumulators();
            this.counters = { ...counters };
            return null;
        }

        this.frames++;
        const interval = 1000 / targetFps;
        if (gapMs > interval * DROPPED_FRAME_FACTOR) this.dropped++;
        if (gapMs > this.worstGapMs) this.worstGapMs = gapMs;
        this.busySum += busyMs;
        if (busyMs > this.busyMax) this.busyMax = busyMs;
        this.renderSum += renderMs;

        if (nowMs - this.windowStartMs < this.windowMs) return null;

        const window: FrameWindow = {
            startMs: this.windowStartMs,
            endMs: nowMs,
            renderedFrames: this.frames,
            targetFps,
            droppedFrames: this.dropped,
            worstGapMs: this.worstGapMs,
            busyMsSum: this.busySum,
            busyMsMax: this.busyMax,
            renderMsSum: this.renderSum,
            programDelta: counters.programs - this.counters.programs,
            geometryDelta: counters.geometries - this.counters.geometries,
            textureDelta: counters.textures - this.counters.textures,
            disturbed: this.disturbed,
        };

        this.windowStartMs = nowMs;
        this.clearAccumulators();
        this.counters.programs = counters.programs;
        this.counters.geometries = counters.geometries;
        this.counters.textures = counters.textures;
        return window;
    }

    /**
     * Throw away the partial window in progress.
     *
     * Used when the loop stops being comparable to itself — a tab returning from hidden, or
     * the frame cap changing between the active and paused intervals. Keeping those frames
     * would put a gap of several seconds into a window that is meant to describe gameplay.
     *
     * Clearing `started` is what separates this from the roll-over above: the next frame
     * re-anchors the window start and re-baselines the counters instead of being measured
     * against a start that is now on the far side of the gap.
     */
    reset(): void {
        this.started = false;
        this.clearAccumulators();
    }

    /** Everything a window accumulates, back to empty. Not the counter baseline. */
    private clearAccumulators(): void {
        this.frames = 0;
        this.dropped = 0;
        this.worstGapMs = 0;
        this.busySum = 0;
        this.busyMax = 0;
        this.renderSum = 0;
        this.disturbed = false;
    }
}
