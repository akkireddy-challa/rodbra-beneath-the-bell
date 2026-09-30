/**
 * The auto-tuner's decision rules.
 *
 * Two tests here are load-bearing beyond their own case:
 *
 *  - "a healthy 60 Hz session is never downgraded" is the regression test for the whole
 *    reason this is a windowed rate rather than a per-frame spike rule. The engine's frame
 *    cap makes a working desktop emit an occasional 33 ms gap; a naive threshold fires on
 *    those, and this stream contains them.
 *  - "no sequence of windows ever produces an upgrade" pins the ratchet directly, because
 *    the argument for it (under a cap, "it looks fine" is the absence of a measurement) is
 *    the sort of thing a later reader is very likely to want to "improve".
 */
import {
    evaluateWindow, initialAutoTuneState, DEFAULT_AUTO_TUNE,
    type AutoTuneConfig, type AutoTuneState, type AutoTuneDecision,
} from 'engine/quality/QualityAutoTune.js';
import type { FrameWindow } from 'engine/quality/FrameBudgetSampler.js';

const CFG: AutoTuneConfig = DEFAULT_AUTO_TUNE;

/** A window with nothing wrong with it, at `fps`, ending at `endMs`. */
function win(endMs: number, fps: number, over: Partial<FrameWindow> = {}): FrameWindow {
    const seconds = CFG.windowMs / 1000;
    return {
        startMs: endMs - CFG.windowMs,
        endMs,
        renderedFrames: Math.round(fps * seconds),
        targetFps: 60,
        droppedFrames: 0,
        worstGapMs: 17,
        busyMsSum: 0,
        busyMsMax: 0,
        renderMsSum: 0,
        programDelta: 0,
        geometryDelta: 0,
        textureDelta: 0,
        disturbed: false,
        ...over,
    };
}

/** Feed a sequence, returning every decision. Starts past the opening grace. */
function run(windows: FrameWindow[], state?: AutoTuneState): { decisions: AutoTuneDecision[]; state: AutoTuneState } {
    let s = state ?? initialAutoTuneState(0, CFG);
    const decisions: AutoTuneDecision[] = [];
    for (const w of windows) {
        const r = evaluateWindow(s, w, CFG);
        s = r.next;
        decisions.push(r.decision);
    }
    return { decisions, state: s };
}

/** `n` bad windows in a row, starting after the opening grace. */
function badRun(n: number, from = CFG.graceMs + CFG.windowMs, over: Partial<FrameWindow> = {}): FrameWindow[] {
    return Array.from({ length: n }, (_, i) => win(from + i * CFG.windowMs, 30, over));
}

const kinds = (ds: AutoTuneDecision[]): string[] => ds.map((d) => d.kind);
const downgrades = (ds: AutoTuneDecision[]): number => ds.filter((d) => d.kind === 'downgrade').length;

describe('quality auto-tune', () => {
    describe('the healthy cases it must never touch', () => {
        it('never downgrades a healthy 60 Hz session, frame-cap jitter included', () => {
            // 57 fps with a handful of 33 ms gaps is what the engine's own cap produces on a
            // working 60 Hz desktop. Judged per frame those gaps look like dropped frames;
            // judged as a rate over two seconds they are plainly fine.
            const windows = Array.from({ length: 40 }, (_, i) =>
                win(CFG.graceMs + (i + 1) * CFG.windowMs, 57, { droppedFrames: 2, worstGapMs: 33.4 }));
            expect(downgrades(run(windows).decisions)).toBe(0);
        });

        it('never downgrades a locked 60 fps session', () => {
            const windows = Array.from({ length: 40 }, (_, i) => win(CFG.graceMs + (i + 1) * CFG.windowMs, 60));
            expect(downgrades(run(windows).decisions)).toBe(0);
        });

        it('never downgrades a 30 fps paused loop, which is the cap doing its job', () => {
            const windows = Array.from({ length: 20 }, (_, i) =>
                win(CFG.graceMs + (i + 1) * CFG.windowMs, 30, { targetFps: 30 }));
            expect(downgrades(run(windows).decisions)).toBe(0);
        });
    });

    describe('acting on sustained badness', () => {
        it('downgrades once after three consecutive bad windows, not before', () => {
            const { decisions } = run(badRun(3));
            expect(kinds(decisions)).toEqual(['none', 'none', 'downgrade']);
        });

        it('resets the streak on a single good window', () => {
            const t = CFG.graceMs + CFG.windowMs;
            const { decisions } = run([
                win(t, 30), win(t + CFG.windowMs, 30),
                win(t + 2 * CFG.windowMs, 60),                       // recovered
                win(t + 3 * CFG.windowMs, 30), win(t + 4 * CFG.windowMs, 30),
            ]);
            expect(downgrades(decisions)).toBe(0);
        });

        it('fires on stutter that does not move the mean', () => {
            // 58 fps average, but a sixth of frames arriving two vsyncs late is unplayable.
            const t = CFG.graceMs + CFG.windowMs;
            const stuttery = (i: number): FrameWindow =>
                win(t + i * CFG.windowMs, 58, { droppedFrames: 30, worstGapMs: 60 });
            const { decisions } = run([stuttery(0), stuttery(1), stuttery(2)]);
            expect(downgrades(decisions)).toBe(1);
        });
    });

    describe('windows it refuses to judge', () => {
        it('discards everything inside the opening grace', () => {
            const early = [win(1000, 20), win(3000, 20), win(4999, 20)];
            const { decisions } = run(early);
            expect(kinds(decisions)).toEqual(['discard', 'discard', 'discard']);
            expect(decisions.every((d) => d.kind === 'discard' && d.why === 'grace')).toBe(true);
        });

        it('blames a shader compile on the content, not the device', () => {
            // The largest spike a healthy session produces, and the one a naive rule fires
            // on first. A discarded window must also NOT advance the streak.
            const { decisions, state } = run(badRun(3, undefined, { programDelta: 7 }));
            expect(kinds(decisions)).toEqual(['discard', 'discard', 'discard']);
            expect(decisions.every((d) => d.kind === 'discard' && d.why === 'compile')).toBe(true);
            expect(state.consecutiveBad).toBe(0);
        });

        it('blames a stream-in on the content', () => {
            const { decisions } = run(badRun(3, undefined, { geometryDelta: 40 }));
            expect(decisions.every((d) => d.kind === 'discard' && d.why === 'streaming')).toBe(true);
            const textures = run(badRun(3, undefined, { textureDelta: 40 }));
            expect(textures.decisions.every((d) => d.kind === 'discard' && d.why === 'streaming')).toBe(true);
        });

        it('tolerates small counter movement, which is ordinary gameplay churn', () => {
            const { decisions } = run(badRun(3, undefined, { geometryDelta: 1, textureDelta: -1 }));
            expect(downgrades(decisions)).toBe(1);
        });

        it('discards a disturbed window and extends the quiet period past it', () => {
            const t = CFG.graceMs + CFG.windowMs;
            const { decisions } = run([
                win(t, 30, { disturbed: true }),
                // Inside the re-grace: still settling after whatever the disturbance was.
                win(t + CFG.windowMs, 30),
                win(t + 2 * CFG.windowMs, 30),
                win(t + 3 * CFG.windowMs, 30),
            ]);
            expect(kinds(decisions).slice(0, 2)).toEqual(['discard', 'discard']);
            expect(downgrades(decisions)).toBe(0);
        });

        it('discards a window with too few frames to be a rate', () => {
            // A hidden tab, or the loop on its paused interval. Downgrading a device for
            // being in the background is the one thing worse than not adapting at all.
            const t = CFG.graceMs + CFG.windowMs;
            const { decisions } = run([win(t, 2), win(t + CFG.windowMs, 2)]);
            expect(decisions.every((d) => d.kind === 'discard' && d.why === 'short')).toBe(true);
        });
    });

    describe('bounds on how much it may do', () => {
        it('discards everything in the cooldown after a change', () => {
            const first = run(badRun(3));
            expect(downgrades(first.decisions)).toBe(1);
            const after = CFG.graceMs + 3 * CFG.windowMs;
            const { decisions } = run([win(after + CFG.windowMs, 20), win(after + 2 * CFG.windowMs, 20)], first.state);
            expect(decisions.every((d) => d.kind === 'discard' && d.why === 'cooldown')).toBe(true);
        });

        it('spends at most maxDowngradesPerSession, then stops for good', () => {
            // A long, continuously terrible session. Two changes and then silence — the
            // ladder is not allowed to walk a device to the floor on one bad measurement run.
            const windows = Array.from({ length: 200 }, (_, i) => win(CFG.graceMs + (i + 1) * CFG.windowMs, 20));
            const { decisions, state } = run(windows);
            expect(downgrades(decisions)).toBe(CFG.maxDowngradesPerSession);
            expect(state.downgradesUsed).toBe(CFG.maxDowngradesPerSession);
        });

        it('takes at least six seconds of bad frames before the first change', () => {
            const { decisions } = run(badRun(3));
            const idx = decisions.findIndex((d) => d.kind === 'downgrade');
            expect((idx + 1) * CFG.windowMs).toBeGreaterThanOrEqual(6000);
        });
    });

    describe('the ratchet', () => {
        it('never produces an upgrade, for any sequence of windows', () => {
            // Asserted directly rather than inferred, because the argument for the ratchet
            // is exactly the kind a later reader wants to "fix": under a 60 fps cap, a
            // device rendering in 4 ms and one rendering in 16 ms are indistinguishable, so
            // there is no evidence that could justify going back up.
            let state = initialAutoTuneState(0, CFG);
            let t = CFG.graceMs;
            for (let i = 0; i < 500; i++) {
                t += CFG.windowMs;
                const r = evaluateWindow(state, win(t, 5 + ((i * 37) % 60), {
                    droppedFrames: (i * 13) % 40,
                    programDelta: i % 11 === 0 ? 3 : 0,
                    geometryDelta: i % 17 === 0 ? 50 : 0,
                    disturbed: i % 23 === 0,
                }), CFG);
                expect(r.decision.kind).not.toBe('upgrade');
                expect(r.next.downgradesUsed).toBeGreaterThanOrEqual(state.downgradesUsed);
                expect(r.next.downgradesUsed).toBeLessThanOrEqual(CFG.maxDowngradesPerSession);
                state = r.next;
            }
        });
    });
});
