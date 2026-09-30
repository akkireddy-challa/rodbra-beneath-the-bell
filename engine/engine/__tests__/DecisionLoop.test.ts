import { DecisionLoop, DEFAULT_DECISION_LOOP_OPTIONS, MIN_TICK_MS } from 'engine/decisions/DecisionLoop.js';
import type { DecisionPolicy } from 'engine/decisions/DecisionPolicy.js';

/**
 * A policy whose answer is resolved by the test, so the "request still in flight"
 * window is exactly as long as the test wants it to be.
 */
class ManualPolicy implements DecisionPolicy<{ tag: string }, string> {
    readonly name = 'manual';
    calls = 0;
    private resolve: ((value: string) => void) | null = null;
    private reject: ((error: Error) => void) | null = null;

    decide(): Promise<string> {
        this.calls += 1;
        return new Promise<string>((resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
        });
    }

    answer(value: string): Promise<void> {
        this.resolve!(value);
        this.resolve = null;
        return flush();
    }

    fail(message: string): Promise<void> {
        this.reject!(new Error(message));
        this.reject = null;
        return flush();
    }
}

/** Let the loop's pending `await` chain run to completion. */
const flush = (): Promise<void> => new Promise<void>(resolve => setImmediate(resolve));

interface Applied {
    view: { tag: string };
    result: string;
}

function makeLoop(policy: DecisionPolicy<{ tag: string }, string>, tickMs = 400) {
    const applied: Applied[] = [];
    let tag = 'a';
    const loop = new DecisionLoop<{ tag: string }, string>({
        ...DEFAULT_DECISION_LOOP_OPTIONS,
        tickMs,
        policy,
        reporter: null,
        perceive: () => ({ tag }),
        applyResult: (view, result) => applied.push({ view, result }),
    });
    return { loop, applied, setTag: (next: string) => { tag = next; } };
}

/** One tick's worth of time, as seconds. */
const TICK_S = 0.4;

describe('DecisionLoop cadence', () => {
    it('does not decide before a full tick has elapsed, then decides exactly once', () => {
        const policy = new ManualPolicy();
        const { loop } = makeLoop(policy);

        loop.update(0.39);
        expect(policy.calls).toBe(0);

        loop.update(0.01);
        expect(policy.calls).toBe(1);
    });

    it('clamps a cadence that would breach the proxy rate window', () => {
        const policy = new ManualPolicy();
        const { loop } = makeLoop(policy, 10);

        loop.update(MIN_TICK_MS / 1000 - 0.01);
        expect(policy.calls).toBe(0);

        loop.update(0.01);
        expect(policy.calls).toBe(1);
    });

    it('skips rather than queues while a request is in flight', async () => {
        const policy = new ManualPolicy();
        const { loop } = makeLoop(policy);

        loop.update(TICK_S);
        loop.update(TICK_S);
        loop.update(TICK_S);
        expect(policy.calls).toBe(1);
        expect(loop.stats().skippedTicks).toBe(2);
        expect(loop.stats().inFlight).toBe(true);

        await policy.answer('go');
        expect(loop.stats().inFlight).toBe(false);

        loop.update(TICK_S);
        expect(policy.calls).toBe(2);
    });

    it('applies the answer against the view captured when the request went out', async () => {
        const policy = new ManualPolicy();
        const { loop, applied, setTag } = makeLoop(policy);

        loop.update(TICK_S);
        setTag('b');
        await policy.answer('go');

        expect(applied).toEqual([{ view: { tag: 'a' }, result: 'go' }]);
    });

    it('parks while disabled and resumes without losing its counters', async () => {
        const policy = new ManualPolicy();
        const { loop } = makeLoop(policy);

        loop.update(TICK_S);
        await policy.answer('go');
        loop.setEnabled(false);
        loop.update(TICK_S);
        expect(policy.calls).toBe(1);

        loop.setEnabled(true);
        loop.update(TICK_S);
        expect(policy.calls).toBe(2);
    });
});

describe('DecisionLoop staleness', () => {
    it('drops an answer that lands after the policy was swapped', async () => {
        const policy = new ManualPolicy();
        const { loop, applied } = makeLoop(policy);

        loop.update(TICK_S);
        loop.setPolicy(new ManualPolicy(), null);
        await policy.answer('stale');

        expect(applied).toEqual([]);
    });

    it('drops an answer that lands after dispose', async () => {
        const policy = new ManualPolicy();
        const { loop, applied } = makeLoop(policy);

        loop.update(TICK_S);
        loop.dispose();
        await policy.answer('stale');

        expect(applied).toEqual([]);
    });

    it('is ready to decide again immediately after a policy swap', () => {
        const policy = new ManualPolicy();
        const replacement = new ManualPolicy();
        const { loop } = makeLoop(policy);

        loop.update(TICK_S);
        loop.setPolicy(replacement, null);
        loop.update(TICK_S);

        expect(replacement.calls).toBe(1);
        expect(policy.calls).toBe(1);
    });
});

describe('DecisionLoop failures', () => {
    it('keeps ticking after a policy throws, and says so once per failure', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const policy = new ManualPolicy();
        const { loop, applied } = makeLoop(policy);

        loop.update(TICK_S);
        await policy.fail('upstream down');

        expect(applied).toEqual([]);
        expect(warn).toHaveBeenCalledWith('[decisions] tick failed:', 'upstream down');

        loop.update(TICK_S);
        expect(policy.calls).toBe(2);
        warn.mockRestore();
    });

    it('warns once when most ticks are being skipped', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const policy = new ManualPolicy();
        const { loop } = makeLoop(policy);

        // One request goes out and never answers, so every later tick is a skip.
        for (let i = 0; i < 60; i++) loop.update(TICK_S);

        const skipWarnings = warn.mock.calls.filter(c => String(c[0]).includes('% of ticks skipped'));
        expect(skipWarnings).toHaveLength(1);
        expect(String(skipWarnings[0]![0])).toContain('Raise tickMs');
        warn.mockRestore();
    });
});
