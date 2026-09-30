/**
 * Regression: mid-frame consumers of a shared THREE-style clock used to starve
 * physics.
 *
 * `Clock.getElapsedTime()` reads like a getter but calls `getDelta()`
 * internally, which resets the clock. `GameEngine.animate()` took the frame
 * delta at the top of the frame, then two ambience systems (torch flicker,
 * weather) consumed the same shared clock again just before render — so the
 * NEXT frame's delta only measured the render-and-idle tail. Because
 * `PhysicsWorld.step()` drains a fixed-timestep accumulator, a starved delta
 * doesn't slow the world smoothly: most frames run ZERO substeps. Measured on
 * a real game: 0.47s simulated per 4.01s of wall clock.
 *
 * The fix is structural — `FrameTimer` is private to the engine and consumes
 * nothing shared, so no amount of clock-reading elsewhere can touch the frame
 * delta. The second test below is the one that fails if that ever regresses.
 */
import { FrameTimer, MAX_DELTA, LegacyClock } from 'engine/FrameTimer.js';
import { initRapier } from 'engine/physics/RapierPhysics.js';
import { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';

const FRAME_MS = 1000 / 60;

/** Run `frames` frames of `FRAME_MS` each, stepping a real PhysicsWorld with
 *  the timer's delta, and return the total number of 1/60s substeps executed.
 *  `midFrame` runs after the tick, i.e. where the ambience systems live. */
function simulateSubsteps(frames: number, midFrame?: (nowMs: number) => void): number {
    const timer = new FrameTimer();
    const world = new PhysicsWorld();
    let substeps = 0;
    try {
        for (let i = 0; i < frames; i++) {
            const nowMs = 1000 + i * FRAME_MS;
            world.step(timer.tick(nowMs));
            substeps += world.lastStepSubstepCount;
            midFrame?.(nowMs);
        }
    } finally {
        world.dispose();
    }
    return substeps;
}

beforeAll(async () => {
    await initRapier();
});

describe('frame delta ownership', () => {
    test('one wall-clock second of frames produces ~60 physics substeps', () => {
        // 61 frames because the first reports the 1/60 fallback rather than a
        // measured gap, so 60 real inter-frame gaps need 61 ticks.
        expect(simulateSubsteps(61)).toBeGreaterThanOrEqual(58);
        expect(simulateSubsteps(61)).toBeLessThanOrEqual(62);
    });

    test('mid-frame clock readers cannot steal the frame delta', () => {
        // Exactly the old failure shape: two destructive reads per frame,
        // after the delta was taken and before the frame ends.
        const shared = new LegacyClock();
        const thief = (): void => {
            shared.getElapsedTime();
            shared.getElapsedTime();
        };

        const withThief = simulateSubsteps(61, thief);
        const withoutThief = simulateSubsteps(61);

        expect(withThief).toBe(withoutThief);
        expect(withThief).toBeGreaterThanOrEqual(58);
    });
});

describe('FrameTimer', () => {
    test('first tick reports the fallback delta, not the time since epoch', () => {
        const timer = new FrameTimer();
        expect(timer.tick(9_999_999)).toBeCloseTo(1 / 60, 6);
    });

    test('a hitch is capped so physics never gets an explosive step', () => {
        const timer = new FrameTimer();
        timer.tick(0);
        expect(timer.tick(5000)).toBe(MAX_DELTA);
    });

    test('discardNext() drops the gap entirely instead of capping it', () => {
        const timer = new FrameTimer();
        timer.tick(0);
        timer.discardNext();
        expect(timer.isDiscardPending()).toBe(true);
        // A capped 100ms step would still teleport everything by a sixth of a
        // second after a tab return; the discard replaces it with one frame.
        expect(timer.tick(300_000)).toBeCloseTo(1 / 60, 6);
        expect(timer.isDiscardPending()).toBe(false);
        // ...and only the one frame is discarded.
        expect(timer.tick(300_000 + FRAME_MS)).toBeCloseTo(FRAME_MS / 1000, 6);
    });

    test('ambienceTime sums the corrected deltas, so a long hide does not jump phase', () => {
        const timer = new FrameTimer();
        let expected = 0;
        expected += timer.tick(0);
        expected += timer.tick(FRAME_MS);
        timer.discardNext();
        expected += timer.tick(300_000); // 5-minute tab hide
        expected += timer.tick(300_000 + FRAME_MS);

        expect(timer.ambienceTime).toBeCloseTo(expected, 6);
        // Four frames of ambience, not five minutes of it.
        expect(timer.ambienceTime).toBeLessThan(0.1);
    });
});
