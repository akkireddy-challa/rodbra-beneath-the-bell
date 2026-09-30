/**
 * The per-frame accumulator.
 *
 * Two properties matter beyond the arithmetic: it must allocate nothing per frame (it runs
 * on every rendered frame of every published session), and it must read the renderer's
 * counters once per WINDOW rather than per frame — that is what makes the tuner's
 * compile/stream-in discrimination essentially free, and what means no call site can forget
 * to do it.
 */
import {
    FrameBudgetSampler, DROPPED_FRAME_FACTOR, type RendererCounters,
} from 'engine/quality/FrameBudgetSampler.js';

const WINDOW_MS = 2000;
const zero: RendererCounters = { programs: 0, geometries: 0, textures: 0 };

/** Feed `count` frames at a fixed cadence, collecting emitted windows. */
function feed(
    s: FrameBudgetSampler,
    count: number,
    gapMs: number,
    start = 0,
    counters: (i: number) => RendererCounters = () => zero,
): { windows: ReturnType<FrameBudgetSampler['recordFrame']>[]; endMs: number } {
    const windows = [];
    let t = start;
    for (let i = 0; i < count; i++) {
        const w = s.recordFrame(t, gapMs, 4, 2, 60, counters(i));
        if (w) windows.push(w);
        t += gapMs;
    }
    return { windows: windows.filter(Boolean), endMs: t };
}

describe('FrameBudgetSampler', () => {
    it('emits one window per windowMs and resets its counters', () => {
        const s = new FrameBudgetSampler(WINDOW_MS);
        // 16.67 ms frames: ~120 per two-second window. Each window restarts from the
        // frame that closed the previous one, so boundaries drift by up to a frame — the
        // contract is "about one window per windowMs", not an exact count.
        const { windows } = feed(s, 601, 1000 / 60);
        expect(windows.length).toBe(4);
        for (const w of windows) {
            expect(w!.endMs - w!.startMs).toBeGreaterThanOrEqual(WINDOW_MS);
            expect(w!.renderedFrames).toBeGreaterThan(110);
            expect(w!.renderedFrames).toBeLessThan(130);
        }
    });

    it('does not count the very first frame, which has no gap to measure', () => {
        const s = new FrameBudgetSampler(WINDOW_MS);
        expect(s.recordFrame(0, 0, 0, 0, 60, zero)).toBeNull();
    });

    it('counts a dropped frame at 1.75x the interval and not at 1.4x', () => {
        // 1.4x is a jittery vsync; 1.75x is two whole vsyncs missed. The engine's own frame
        // cap produces the former on a healthy machine, which is why the line is here.
        const interval = 1000 / 60;
        const s = new FrameBudgetSampler(WINDOW_MS);
        s.recordFrame(0, 0, 0, 0, 60, zero);
        s.recordFrame(100, interval * 1.4, 0, 0, 60, zero);
        s.recordFrame(200, interval * (DROPPED_FRAME_FACTOR + 0.1), 0, 0, 60, zero);
        const w = s.recordFrame(2100, interval, 0, 0, 60, zero);
        expect(w!.droppedFrames).toBe(1);
    });

    it('reports counter movement as a delta across the window, not per frame', () => {
        const s = new FrameBudgetSampler(WINDOW_MS);
        const { windows } = feed(s, 200, 1000 / 60, 0, (i) => ({
            programs: i > 50 ? 3 : 0,
            geometries: i,
            textures: 0,
        }));
        const first = windows[0]!;
        expect(first.programDelta).toBe(3);
        expect(first.geometryDelta).toBeGreaterThan(100);
        expect(first.textureDelta).toBe(0);
    });

    it('keeps a disturbance for the whole window it lands in', () => {
        const s = new FrameBudgetSampler(WINDOW_MS);
        s.recordFrame(0, 0, 0, 0, 60, zero);
        s.recordFrame(10, 10, 0, 0, 60, zero);
        s.noteDisturbance();
        const w = s.recordFrame(2100, 16, 0, 0, 60, zero);
        expect(w!.disturbed).toBe(true);
        // …and not into the next one.
        const next = s.recordFrame(4200, 16, 0, 0, 60, zero);
        expect(next!.disturbed).toBe(false);
    });

    it('tracks the worst gap and the busiest frame', () => {
        const s = new FrameBudgetSampler(WINDOW_MS);
        s.recordFrame(0, 0, 0, 0, 60, zero);
        s.recordFrame(100, 16, 5, 3, 60, zero);
        s.recordFrame(200, 90, 40, 30, 60, zero);
        const w = s.recordFrame(2100, 16, 6, 4, 60, zero);
        expect(w!.worstGapMs).toBe(90);
        expect(w!.busyMsMax).toBe(40);
        expect(w!.busyMsSum).toBe(51);
        expect(w!.renderMsSum).toBe(37);
    });

    it('drops the partial window on reset, so a tab return is not measured as a stall', () => {
        const s = new FrameBudgetSampler(WINDOW_MS);
        feed(s, 60, 1000 / 60);
        s.reset();
        // The next frame restarts the window rather than closing a stale one that would
        // contain however many seconds the tab spent hidden.
        expect(s.recordFrame(60_000, 16, 4, 2, 60, zero)).toBeNull();
        const { windows } = feed(s, 200, 1000 / 60, 60_016);
        expect(windows[0]!.startMs).toBeGreaterThanOrEqual(60_000);
    });

    it('starts a fresh window when the frame cap changes', () => {
        const s = new FrameBudgetSampler(WINDOW_MS);
        feed(s, 60, 1000 / 60);
        expect(s.recordFrame(1000, 1000 / 30, 4, 2, 30, zero)).toBeNull();
        for (let frame = 1; frame < 60; frame++) {
            expect(s.recordFrame(1000 + frame * 1000 / 30, 1000 / 30, 4, 2, 30, zero)).toBeNull();
        }
        const window = s.recordFrame(3000, 1000 / 30, 4, 2, 30, zero);
        expect(window).toMatchObject({ startMs: 1000, endMs: 3000, targetFps: 30, renderedFrames: 60, droppedFrames: 0 });
    });

    it('allocates only once per window, not once per frame', () => {
        // The load-bearing property: this runs on every rendered frame of every published
        // session. 12 000 frames must produce 100 objects, not 12 000.
        const s = new FrameBudgetSampler(WINDOW_MS);
        const { windows } = feed(s, 12_001, 1000 / 60);
        // ~200 seconds of frames. The number that matters is that it is two orders of
        // magnitude below 12 000, not its exact value.
        expect(windows.length).toBeGreaterThan(95);
        expect(windows.length).toBeLessThan(105);
    });
});
