/**
 * A policy is "what decides, this tick". `DecisionLoop` drives one; the game
 * supplies the domain.
 *
 * `ModelDecisionPolicy` is the one that asks a decision model. Its shape enforces
 * the rule the traffic experiment paid for (see `docs/jev-traffic-prototype.md`):
 * **code owns what must never happen; the model only picks among the moves that
 * are already allowed.** That is what `ask()` returning `null` means — the game
 * already settled this tick in code, so there is nothing to ask. Everything the
 * model IS asked goes out as ONE batched request, because every question in a
 * request is answered in parallel against the same state and extra questions add
 * no latency.
 */

import type {
    DecisionAnswers,
    DecisionOptions,
    DecisionQuestion,
    DecisionsResult,
} from 'engine/DecisionTypes.js';
import { DecisionStatsRecorder } from 'engine/decisions/DecisionStats.js';
import type { DecisionSnapshot } from 'engine/decisions/DecisionSnapshot.js';

/**
 * The structural slice of `AIService` this namespace needs. Depending on the type
 * rather than the class keeps `AIService` (and its fetch/browser surface) out of
 * the import graph, so a policy is unit-testable with a plain object.
 */
export interface DecisionService {
    decide<Q extends Record<string, DecisionQuestion>>(
        state: unknown,
        questions: Q,
        options?: DecisionOptions,
    ): Promise<DecisionsResult<Q>>;
}

/**
 * `V` is what the game perceived this tick, `R` is what it will apply. A policy
 * never touches the world: it reads a view and returns a result.
 */
export interface DecisionPolicy<V, R> {
    readonly name: string;
    decide(view: V): Promise<R>;
}

/** The one batched request a tick sends. */
export interface DecisionAsk<Q extends Record<string, DecisionQuestion>> {
    state: unknown;
    questions: Q;
}

/** What the round trip reported, handed to `apply` so a game can log or show it. */
export interface DecisionRoundTrip {
    model: string;
    latencyMs: number;
    inputTokens: number;
    costUsd: number;
    questionCount: number;
}

/** Tunables only — non-generic, so the `DEFAULT_*` const below is a plain value. */
export interface DecisionPolicyTuning {
    /** Per-request timeout. Keep it BELOW the loop's `tickMs`. */
    timeoutMs: number;
    /** Groups requests in the provider's observability; never seen by the model. */
    sessionId: string;
    /** Latency samples kept for the percentiles. */
    latencySamples: number;
    /**
     * Refuse to send more questions than this. The proxy caps a request at 160
     * questions and 64 KB, and a request over the cap is rejected outright — so a
     * policy that would exceed it throws with the count rather than letting every
     * tick fail at the server. Gate in `ask()`; do not raise this to paper over it.
     */
    maxQuestions: number;
}

export const DEFAULT_DECISION_POLICY_TUNING: DecisionPolicyTuning = {
    timeoutMs: 1500,
    sessionId: '',
    latencySamples: 200,
    maxQuestions: 64,
};

export interface ModelPolicyOptions<V, R, Q extends Record<string, DecisionQuestion>>
    extends DecisionPolicyTuning {
    /** Shown wherever the active policy is named, e.g. 'jev'. */
    name: string;
    /**
     * The ONE request this tick, or `null` when code already settled everything —
     * which is the common case and the cheap one. Gate here: an invariant that must
     * hold belongs in code, not in a question.
     */
    ask(view: V): DecisionAsk<Q> | null;
    /**
     * Answers → the game's result. Called only when `ask` returned a request. This is
     * where an answer is checked against what is actually possible: a model may name
     * an option that no longer applies, and only the game knows that.
     */
    apply(view: V, answers: DecisionAnswers<Q>, trip: DecisionRoundTrip): R;
    /** The result when `ask` returned `null`. No request is made. */
    resolveLocally(view: V): R;
    /** Rows for a read-out of the last answers, or `null` to publish none. */
    describe: ((view: V, answers: DecisionAnswers<Q>) => DecisionSnapshot[]) | null;
}

/** Snapshots kept for a read-out, newest first. */
const SNAPSHOT_HISTORY = 12;

export class ModelDecisionPolicy<V, R, Q extends Record<string, DecisionQuestion>>
implements DecisionPolicy<V, R> {
    readonly name: string;
    readonly stats: DecisionStatsRecorder;

    private lastSnapshots: DecisionSnapshot[] = [];

    constructor(
        private readonly ai: DecisionService,
        private readonly options: ModelPolicyOptions<V, R, Q>,
    ) {
        this.name = options.name;
        this.stats = new DecisionStatsRecorder(options.latencySamples);
    }

    async decide(view: V): Promise<R> {
        const request = this.options.ask(view);
        if (request === null) return this.options.resolveLocally(view);

        const questionCount = Object.keys(request.questions).length;
        if (questionCount > this.options.maxQuestions) {
            throw new Error(
                `Decision request carries ${questionCount} questions, over the policy's maxQuestions of `
                + `${this.options.maxQuestions} — gate the situation in ask() instead of asking about every entity`,
            );
        }

        this.stats.recordRequest(questionCount);
        let result: DecisionsResult<Q>;
        try {
            result = await this.ai.decide(request.state, request.questions, {
                timeoutMs: this.options.timeoutMs,
                sessionId: this.options.sessionId,
            });
        } catch (error) {
            this.stats.recordFailure();
            throw error;
        }
        this.stats.recordSuccess(result, result.answers);

        if (this.options.describe) {
            // Newest first, and a rolling history: a viewer watching one subject still sees
            // its last decision after requests about other subjects have come and gone.
            const shown = this.options.describe(view, result.answers);
            this.lastSnapshots = [...shown.reverse(), ...this.lastSnapshots].slice(0, SNAPSHOT_HISTORY);
        }

        return this.options.apply(view, result.answers, {
            model: result.model,
            latencyMs: result.latencyMs,
            inputTokens: result.usage.input_tokens,
            costUsd: result.usage.cost ?? 0,
            questionCount,
        });
    }

    /** The last answers as rows, newest first. Empty when `describe` is null. */
    snapshots(): readonly DecisionSnapshot[] {
        return this.lastSnapshots;
    }

    resetCounters(): void {
        this.stats.resetCounters();
    }
}
