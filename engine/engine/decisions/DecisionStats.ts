/**
 * Counters for a decision-model link: how often it was asked, how often it
 * failed, how long it took, what it cost and how sure it was.
 *
 * Kept apart from the policy that records them so a HUD, a `console.table` row
 * or a test can read a flat, JSON-safe summary without touching the policy's
 * internals — and so the percentile maths has one home instead of being
 * re-derived per game.
 */

import type { DecisionAnswer, DecisionsUsage } from 'engine/DecisionTypes.js';

/** Raw counters. `last*` describe the most recent round trip, the rest accumulate. */
export interface DecisionStats {
    requests: number;
    failures: number;
    /** Failures since the last success — what a degrading policy watches. */
    consecutiveFailures: number;
    lastLatencyMs: number;
    /** The versioned model id that answered — log it; aliases move. */
    lastModel: string;
    lastInputTokens: number;
    lastQuestionCount: number;
    totalCostUsd: number;
    /** Newest last, capped at the recorder's sample count. */
    latenciesMs: number[];
    confidenceSum: number;
    confidenceCount: number;
}

/** Flat and JSON-safe: what an overlay, a metrics panel or a logged row reads. */
export interface DecisionStatsSummary {
    requests: number;
    failures: number;
    /** The most recent round trip, for a live read-out. */
    lastLatencyMs: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
    lastModel: string;
    lastInputTokens: number;
    lastQuestionCount: number;
    costUsd: number;
    /** 0 when nothing answerable has been asked yet. */
    meanConfidence: number;
}

/**
 * `choice` and `score` answers carry a calibrated confidence; a `noul` is a bare
 * probability with none, so it is excluded from the mean rather than counted as 0.
 */
export function answerConfidence(answer: DecisionAnswer): number | null {
    return answer.type === 'noul' ? null : answer.confidence;
}

export class DecisionStatsRecorder {
    readonly stats: DecisionStats = {
        requests: 0,
        failures: 0,
        consecutiveFailures: 0,
        lastLatencyMs: 0,
        lastModel: '',
        lastInputTokens: 0,
        lastQuestionCount: 0,
        totalCostUsd: 0,
        latenciesMs: [],
        confidenceSum: 0,
        confidenceCount: 0,
    };

    constructor(private readonly latencySamples: number) {}

    /** Count a request about to go out, with the number of questions it carries. */
    recordRequest(questionCount: number): void {
        this.stats.requests += 1;
        this.stats.lastQuestionCount = questionCount;
    }

    recordSuccess(
        result: { model: string; usage: DecisionsUsage; latencyMs: number },
        answers: Record<string, DecisionAnswer>,
    ): void {
        const s = this.stats;
        s.consecutiveFailures = 0;
        s.lastLatencyMs = result.latencyMs;
        s.lastModel = result.model;
        s.lastInputTokens = result.usage.input_tokens;
        // The provider reports `cost` only sometimes; a missing one adds nothing rather
        // than poisoning the running total with NaN.
        s.totalCostUsd += result.usage.cost ?? 0;
        s.latenciesMs.push(result.latencyMs);
        if (s.latenciesMs.length > this.latencySamples) s.latenciesMs.shift();
        for (const answer of Object.values(answers)) {
            const confidence = answerConfidence(answer);
            if (confidence === null) continue;
            s.confidenceSum += confidence;
            s.confidenceCount += 1;
        }
    }

    recordFailure(): void {
        this.stats.failures += 1;
        this.stats.consecutiveFailures += 1;
    }

    /**
     * Zero the cumulative counters for a fresh measurement window. `last*` and
     * `consecutiveFailures` are left alone: they describe the most recent round trip
     * and the current health of the link, neither of which a counter reset undoes.
     */
    resetCounters(): void {
        const s = this.stats;
        s.requests = 0;
        s.failures = 0;
        s.totalCostUsd = 0;
        s.latenciesMs.length = 0;
        s.confidenceSum = 0;
        s.confidenceCount = 0;
    }

    summary(): DecisionStatsSummary {
        const s = this.stats;
        const sorted = [...s.latenciesMs].sort((a, b) => a - b);
        const percentile = (p: number): number =>
            sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
        return {
            requests: s.requests,
            failures: s.failures,
            lastLatencyMs: s.lastLatencyMs,
            p50LatencyMs: percentile(0.5),
            p95LatencyMs: percentile(0.95),
            lastModel: s.lastModel,
            lastInputTokens: s.lastInputTokens,
            lastQuestionCount: s.lastQuestionCount,
            costUsd: s.totalCostUsd,
            meanConfidence: s.confidenceCount > 0 ? s.confidenceSum / s.confidenceCount : 0,
        };
    }
}
