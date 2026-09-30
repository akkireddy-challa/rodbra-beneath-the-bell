/**
 * Keeps a game playable when the decision model cannot answer: after
 * `failuresBeforeFallback` consecutive failures the coded fallback drives for
 * `fallbackSeconds`, then the primary is tried again. Degraded, not disabled.
 *
 * A server that said "later" — a rate limit, or the game's spend budget for this
 * window — is obeyed straight away and for as long as it asked, instead of being
 * treated as one failure among five. Retrying through a refusal cannot work, and
 * every attempt is another refused request.
 *
 * Every game that decides with a model should be wrapped in one of these, because
 * the model is a network call: a rate limit, a provider outage or a missing key
 * must cost the player nothing but a less clever opponent. The fallback is also
 * what makes the model measurable — it is the baseline to compare against.
 */

import { RuntimeAIBackoffError } from 'engine/RuntimeAIErrors.js';
import type { DecisionPolicy } from 'engine/decisions/DecisionPolicy.js';

export interface DegradingOptions {
    /** Consecutive failures that open the fallback window. */
    failuresBeforeFallback: number;
    /** How long the fallback drives before the primary is retried. */
    fallbackSeconds: number;
    /** Injectable clock, so the window is testable without waiting for it. */
    now(): number;
}

export const DEFAULT_DEGRADING_OPTIONS: DegradingOptions = {
    failuresBeforeFallback: 5,
    fallbackSeconds: 10,
    now: () => performance.now(),
};

export class DegradingPolicy<V, R> implements DecisionPolicy<V, R> {
    private fallbackUntil = 0;
    private consecutiveFailures = 0;
    private degraded = false;

    constructor(
        private readonly primary: DecisionPolicy<V, R>,
        private readonly fallback: DecisionPolicy<V, R>,
        private readonly options: DegradingOptions,
    ) {}

    /** `'jev'` while healthy, `'jev→rules'` while degraded — readable in a HUD. */
    get name(): string {
        return this.degraded ? `${this.primary.name}→${this.fallback.name}` : this.primary.name;
    }

    async decide(view: V): Promise<R> {
        if (this.options.now() < this.fallbackUntil) {
            this.degraded = true;
            return this.fallback.decide(view);
        }
        try {
            const result = await this.primary.decide(view);
            this.degraded = false;
            this.consecutiveFailures = 0;
            return result;
        } catch (error) {
            // Worth seeing once per failure: the fallback hides the outage from the player,
            // so the console is the only place it shows.
            console.warn('[decisions] primary policy failed:', error instanceof Error ? error.message : error);
            if (error instanceof RuntimeAIBackoffError) {
                this.fallbackUntil = this.options.now() + error.retryAfterMs;
                this.consecutiveFailures = 0;
            } else {
                this.consecutiveFailures += 1;
                if (this.consecutiveFailures >= this.options.failuresBeforeFallback) {
                    this.fallbackUntil = this.options.now() + this.options.fallbackSeconds * 1000;
                    this.consecutiveFailures = 0;
                }
            }
            this.degraded = true;
            return this.fallback.decide(view);
        }
    }
}
