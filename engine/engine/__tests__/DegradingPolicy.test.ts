import { DegradingPolicy, DEFAULT_DEGRADING_OPTIONS } from 'engine/decisions/DegradingPolicy.js';
import { RuntimeAIBackoffError } from 'engine/RuntimeAIErrors.js';
import type { DecisionPolicy } from 'engine/decisions/DecisionPolicy.js';

class CountingPolicy implements DecisionPolicy<void, string> {
    calls = 0;
    failNext = 0;
    /** Thrown instead of a plain Error while set — for the "server said later" path. */
    failWith: Error | null = null;

    constructor(readonly name: string, private readonly answer: string) {}

    async decide(): Promise<string> {
        this.calls += 1;
        if (this.failNext > 0) {
            this.failNext -= 1;
            throw this.failWith ?? new Error(`${this.name} is down`);
        }
        return this.answer;
    }
}

function makeClock() {
    let now = 0;
    return { now: () => now, advanceSeconds: (s: number) => { now += s * 1000; } };
}

function setup() {
    const clock = makeClock();
    const primary = new CountingPolicy('jev', 'model');
    const fallback = new CountingPolicy('rules', 'coded');
    const policy = new DegradingPolicy(primary, fallback, {
        ...DEFAULT_DEGRADING_OPTIONS,
        now: clock.now,
    });
    return { clock, primary, fallback, policy };
}

describe('DegradingPolicy', () => {
    let warn: jest.SpyInstance;

    beforeEach(() => {
        warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        warn.mockRestore();
    });

    it('passes the primary through and names it while healthy', async () => {
        const { policy, primary, fallback } = setup();

        await expect(policy.decide()).resolves.toBe('model');
        expect(policy.name).toBe('jev');
        expect(fallback.calls).toBe(0);
        expect(primary.calls).toBe(1);
    });

    it('falls back for this tick on a single failure but keeps trying the primary', async () => {
        const { policy, primary, fallback } = setup();
        primary.failNext = 1;

        await expect(policy.decide()).resolves.toBe('coded');
        expect(policy.name).toBe('jev→rules');

        await expect(policy.decide()).resolves.toBe('model');
        expect(policy.name).toBe('jev');
        expect(primary.calls).toBe(2);
        expect(fallback.calls).toBe(1);
    });

    it('stops calling the primary once the failure budget is spent, then retries after the window', async () => {
        const { policy, primary, clock } = setup();
        primary.failNext = DEFAULT_DEGRADING_OPTIONS.failuresBeforeFallback;

        for (let i = 0; i < DEFAULT_DEGRADING_OPTIONS.failuresBeforeFallback; i++) {
            await expect(policy.decide()).resolves.toBe('coded');
        }
        const callsWhenWindowOpened = primary.calls;
        expect(callsWhenWindowOpened).toBe(DEFAULT_DEGRADING_OPTIONS.failuresBeforeFallback);

        clock.advanceSeconds(DEFAULT_DEGRADING_OPTIONS.fallbackSeconds - 1);
        await expect(policy.decide()).resolves.toBe('coded');
        expect(primary.calls).toBe(callsWhenWindowOpened);
        expect(policy.name).toBe('jev→rules');

        clock.advanceSeconds(2);
        await expect(policy.decide()).resolves.toBe('model');
        expect(primary.calls).toBe(callsWhenWindowOpened + 1);
        expect(policy.name).toBe('jev');
    });

    it('resets the failure budget on a success, so scattered failures never degrade', async () => {
        const { policy, primary, clock } = setup();

        for (let round = 0; round < 4; round++) {
            primary.failNext = DEFAULT_DEGRADING_OPTIONS.failuresBeforeFallback - 1;
            for (let i = 0; i < DEFAULT_DEGRADING_OPTIONS.failuresBeforeFallback - 1; i++) {
                await expect(policy.decide()).resolves.toBe('coded');
            }
            await expect(policy.decide()).resolves.toBe('model');
        }

        clock.advanceSeconds(0.001);
        await expect(policy.decide()).resolves.toBe('model');
    });

    it('says why once per failure — the fallback hides the outage from the player', async () => {
        const { policy, primary } = setup();
        primary.failNext = 2;

        await policy.decide();
        await policy.decide();

        expect(warn).toHaveBeenCalledTimes(2);
        expect(warn).toHaveBeenCalledWith('[decisions] primary policy failed:', 'jev is down');
    });

    it('obeys a rate limit at once and for exactly as long as it asked', async () => {
        const { policy, primary, fallback, clock } = setup();
        primary.failNext = 1;
        primary.failWith = new RuntimeAIBackoffError(429, 4000, 'Decision request failed (429): budget exhausted');

        // ONE refusal is enough: retrying through a rate limit cannot work.
        await expect(policy.decide()).resolves.toBe('coded');
        const callsWhenRefused = primary.calls;

        clock.advanceSeconds(3);
        await expect(policy.decide()).resolves.toBe('coded');
        expect(primary.calls).toBe(callsWhenRefused);

        clock.advanceSeconds(2);
        await expect(policy.decide()).resolves.toBe('model');
        expect(primary.calls).toBe(callsWhenRefused + 1);
        expect(fallback.calls).toBe(2);
    });

    it('does not let a rate limit eat the failure budget for real outages', async () => {
        const { policy, primary, clock } = setup();
        primary.failNext = 1;
        primary.failWith = new RuntimeAIBackoffError(429, 1000, 'rate limited');
        await policy.decide();
        clock.advanceSeconds(1.1);

        // After the wait, a single ordinary failure must not already be the fifth.
        primary.failWith = null;
        primary.failNext = 1;
        await expect(policy.decide()).resolves.toBe('coded');
        const callsBefore = primary.calls;
        await expect(policy.decide()).resolves.toBe('model');
        expect(primary.calls).toBe(callsBefore + 1);
    });
});
