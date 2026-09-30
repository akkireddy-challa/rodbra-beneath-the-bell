/**
 * Drives one decision policy on a fixed cadence and applies its answers when they
 * land.
 *
 * The two rules that make this safe to run inside a game loop:
 *
 *  - **Never queue.** A tick whose previous request is still in flight is skipped
 *    and counted. A decision about a situation that has already changed is worth
 *    less than none, and a queue turns one slow round trip into a growing backlog.
 *  - **Never block.** `update()` returns immediately; the answer arrives some
 *    frames later, so `applyResult` gets the view that was perceived and must
 *    re-check it against the live world before acting on it.
 *
 * One loop per game. At the default 400 ms cadence that is ~150 requests a minute
 * against the proxy's 300/min per-game window; two loops, or a faster tick, breach
 * it and the game degrades to its fallback policy for nothing.
 */

import type { DecisionPolicy } from 'engine/decisions/DecisionPolicy.js';
import type { DecisionSnapshot } from 'engine/decisions/DecisionSnapshot.js';
import type { DecisionStatsRecorder, DecisionStatsSummary } from 'engine/decisions/DecisionStats.js';

/**
 * A policy that also keeps counters and answer rows — `ModelDecisionPolicy`
 * satisfies it. Passed alongside `policy` because the policy the loop drives is
 * usually a `DegradingPolicy` wrapping the one that has the numbers.
 */
export interface DecisionReporter {
    readonly stats: DecisionStatsRecorder;
    snapshots(): readonly DecisionSnapshot[];
    resetCounters(): void;
}

export interface DecisionLoopOptions {
    /** Decision cadence in ms. Clamped up to `MIN_TICK_MS`. */
    tickMs: number;
    /** False parks the loop without discarding its counters — a pause, a start screen. */
    enabled: boolean;
}

export const DEFAULT_DECISION_LOOP_OPTIONS: DecisionLoopOptions = {
    tickMs: 400,
    enabled: true,
};

/** Below this a loop cannot stay inside the proxy's per-game request window. */
export const MIN_TICK_MS = 250;

export interface DecisionLoopConfig<V, R> extends DecisionLoopOptions {
    /** Builds this tick's view of the world. Keep it small — the state is billed per token. */
    perceive(): V;
    policy: DecisionPolicy<V, R>;
    /** The policy carrying the counters and answer rows, or null when none does. */
    reporter: DecisionReporter | null;
    /**
     * Runs when the answer lands, possibly several frames after `perceive`. Re-validate
     * against live state: entities move, die and change lanes while a request is out.
     */
    applyResult(view: V, result: R): void;
}

export interface DecisionLoopStats extends DecisionStatsSummary {
    /** The policy that answered last, e.g. 'jev' or 'jev→rules'. */
    activePolicy: string;
    /** Ticks skipped because the previous request was still in flight. */
    skippedTicks: number;
    inFlight: boolean;
}

/** Ticks per skip-rate check, and the rate that earns the one-off warning. */
const SKIP_CHECK_TICKS = 20;
const SKIP_WARN_FRACTION = 0.5;

const EMPTY_SNAPSHOTS: readonly DecisionSnapshot[] = [];

export class DecisionLoop<V, R> {
    private policy: DecisionPolicy<V, R>;
    private reporter: DecisionReporter | null;
    private tickMs: number;
    private enabled: boolean;

    private sinceTickMs = 0;
    private inFlight = false;
    private skippedTicks = 0;
    /**
     * Bumped whenever the answers in flight stop being wanted (a policy swap, a
     * dispose). A reply carrying a stale generation is dropped instead of applied.
     */
    private generation = 0;
    private ticksSinceCheck = 0;
    private skipsSinceCheck = 0;
    private warnedAboutSkips = false;

    constructor(private readonly config: DecisionLoopConfig<V, R>) {
        this.policy = config.policy;
        this.reporter = config.reporter;
        this.tickMs = Math.max(MIN_TICK_MS, config.tickMs);
        this.enabled = config.enabled;
    }

    /** `deltaTime` in SECONDS, like every other engine system. */
    update(deltaTime: number): void {
        if (!this.enabled) return;
        this.sinceTickMs += deltaTime * 1000;
        if (this.sinceTickMs < this.tickMs) return;
        this.sinceTickMs = 0;
        this.ticksSinceCheck += 1;
        if (this.inFlight) {
            this.skippedTicks += 1;
            this.skipsSinceCheck += 1;
        } else {
            void this.tick();
        }
        this.checkSkipRate();
    }

    private async tick(): Promise<void> {
        this.inFlight = true;
        const generation = this.generation;
        const view = this.config.perceive();
        try {
            const result = await this.policy.decide(view);
            // The answer is only wanted if nothing has invalidated it while it was out.
            if (generation === this.generation) this.config.applyResult(view, result);
        } catch (error) {
            // A DegradingPolicy has already fallen back by here; a bare policy throwing is a
            // bug worth seeing, and the loop keeps ticking either way.
            console.warn('[decisions] tick failed:', error instanceof Error ? error.message : error);
        } finally {
            if (generation === this.generation) this.inFlight = false;
        }
    }

    /**
     * Say once when most ticks are being skipped. p95 latency above one tick is the
     * documented failure mode: the game is paying for decisions it mostly throws away,
     * and the cure is a longer `tickMs` or a smaller state, not a bigger timeout.
     */
    private checkSkipRate(): void {
        if (this.ticksSinceCheck < SKIP_CHECK_TICKS) return;
        const rate = this.skipsSinceCheck / this.ticksSinceCheck;
        if (rate > SKIP_WARN_FRACTION && !this.warnedAboutSkips) {
            this.warnedAboutSkips = true;
            console.warn(
                `[decisions] ${Math.round(rate * 100)}% of ticks skipped — the model is slower than the `
                + `${this.tickMs} ms cadence. Raise tickMs or send a smaller state.`,
            );
        }
        this.ticksSinceCheck = 0;
        this.skipsSinceCheck = 0;
    }

    /**
     * Swap policies at runtime. Answers from the old one are dropped, not applied.
     * The reporter travels with the policy — a swap to a coded policy has none, and
     * leaving the old one attached would report the previous policy's numbers as
     * the current one's.
     */
    setPolicy(policy: DecisionPolicy<V, R>, reporter: DecisionReporter | null): void {
        this.generation += 1;
        this.inFlight = false;
        this.sinceTickMs = 0;
        this.policy = policy;
        this.reporter = reporter;
    }

    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
    }

    stats(): DecisionLoopStats {
        const summary = this.reporter?.stats.summary() ?? EMPTY_SUMMARY;
        return {
            ...summary,
            activePolicy: this.policy.name,
            skippedTicks: this.skippedTicks,
            inFlight: this.inFlight,
        };
    }

    /** The reporter's last answers, newest first; empty when there is no reporter. */
    snapshots(): readonly DecisionSnapshot[] {
        return this.reporter?.snapshots() ?? EMPTY_SNAPSHOTS;
    }

    /** Zero the measurement window — the loop's own counters and the reporter's. */
    resetCounters(): void {
        this.skippedTicks = 0;
        this.ticksSinceCheck = 0;
        this.skipsSinceCheck = 0;
        this.reporter?.resetCounters();
    }

    /** Stop deciding. Answers still in flight are dropped when they land. */
    dispose(): void {
        this.generation += 1;
        this.enabled = false;
        this.inFlight = false;
    }
}

const EMPTY_SUMMARY: DecisionStatsSummary = {
    requests: 0,
    failures: 0,
    lastLatencyMs: 0,
    p50LatencyMs: 0,
    p95LatencyMs: 0,
    lastModel: '',
    lastInputTokens: 0,
    lastQuestionCount: 0,
    costUsd: 0,
    meanConfidence: 0,
};
