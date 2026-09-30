import {
    ModelDecisionPolicy,
    DEFAULT_DECISION_POLICY_TUNING,
    type DecisionService,
} from 'engine/decisions/DecisionPolicy.js';
import { choice, noul } from 'engine/DecisionTypes.js';
import type { DecisionQuestion, DecisionsResult } from 'engine/DecisionTypes.js';
import { snapshotFromChoice } from 'engine/decisions/DecisionSnapshot.js';

interface View {
    contested: number[];
}

type Answers = Record<string, { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }>;

/** A stand-in for `AIService.decide` — no fetch, no browser, answers whatever the test says. */
class FakeService implements DecisionService {
    calls: Array<{ state: unknown; questions: Record<string, DecisionQuestion> }> = [];
    latencyMs = 120;
    model = 'typesafe/jev-1.13-20260917';
    cost: number | undefined = 0.0001;
    inputTokens = 560;
    reply: (questions: Record<string, DecisionQuestion>) => Answers = questions =>
        Object.fromEntries(Object.keys(questions).map(key => [key, {
            type: 'choice' as const, choice: 'go', probabilities: { go: 0.8, hold: 0.2 }, confidence: 0.7,
        }]));
    failWith: Error | null = null;

    async decide<Q extends Record<string, DecisionQuestion>>(
        state: unknown,
        questions: Q,
    ): Promise<DecisionsResult<Q>> {
        this.calls.push({ state, questions });
        if (this.failWith) throw this.failWith;
        const usage = this.cost === undefined
            ? { input_tokens: this.inputTokens, output_tokens: 0 }
            : { input_tokens: this.inputTokens, output_tokens: 0, cost: this.cost };
        // The fake answers whatever the test asked for; only the test knows the pairing.
        const answers = this.reply(questions) as unknown as DecisionsResult<Q>['answers'];
        return { answers, model: this.model, usage, latencyMs: this.latencyMs };
    }
}

function makePolicy(ai: DecisionService, overrides: Partial<{ maxQuestions: number; describe: boolean }> = {}) {
    const applied: Array<{ view: View; model: string; questionCount: number }> = [];
    const policy = new ModelDecisionPolicy<View, string[], Record<string, DecisionQuestion>>(ai, {
        ...DEFAULT_DECISION_POLICY_TUNING,
        maxQuestions: overrides.maxQuestions ?? DEFAULT_DECISION_POLICY_TUNING.maxQuestions,
        name: 'jev',
        sessionId: 'test-session',
        ask: view => view.contested.length === 0 ? null : {
            state: { spots: view.contested },
            questions: Object.fromEntries(view.contested.map((id, i) =>
                [`spot_${id}`, choice(`Who takes \`spots[${i}]\`?`, { go: null, hold: null })])),
        },
        apply: (view, answers, trip) => {
            applied.push({ view, model: trip.model, questionCount: trip.questionCount });
            return Object.keys(answers);
        },
        resolveLocally: () => ['local'],
        describe: overrides.describe === false ? null : (view, answers) => view.contested.map(id =>
            snapshotFromChoice(`spot_${id}`, `spot ${id}`, answers[`spot_${id}`] as never, { go: 'go', hold: 'hold' }, id)),
    });
    return { policy, applied };
}

describe('ModelDecisionPolicy gating', () => {
    it('makes no request when code already settled the tick', async () => {
        const ai = new FakeService();
        const { policy, applied } = makePolicy(ai);

        await expect(policy.decide({ contested: [] })).resolves.toEqual(['local']);
        expect(ai.calls).toHaveLength(0);
        expect(applied).toHaveLength(0);
        expect(policy.stats.stats.requests).toBe(0);
    });

    it('batches every question of a tick into one request', async () => {
        const ai = new FakeService();
        const { policy } = makePolicy(ai);

        await policy.decide({ contested: [1, 2, 3] });

        expect(ai.calls).toHaveLength(1);
        expect(Object.keys(ai.calls[0]!.questions)).toEqual(['spot_1', 'spot_2', 'spot_3']);
        expect(policy.stats.stats.lastQuestionCount).toBe(3);
    });

    it('refuses a request over maxQuestions rather than letting the proxy reject it', async () => {
        const ai = new FakeService();
        const { policy } = makePolicy(ai, { maxQuestions: 2 });

        await expect(policy.decide({ contested: [1, 2, 3] })).rejects.toThrow(/3 questions, over the policy's maxQuestions of 2/);
        expect(ai.calls).toHaveLength(0);
    });
});

describe('ModelDecisionPolicy stats', () => {
    it('accumulates model, tokens, cost and latency', async () => {
        const ai = new FakeService();
        const { policy } = makePolicy(ai);

        await policy.decide({ contested: [1] });
        await policy.decide({ contested: [1] });

        const summary = policy.stats.summary();
        expect(summary.requests).toBe(2);
        expect(summary.lastModel).toBe('typesafe/jev-1.13-20260917');
        expect(summary.lastInputTokens).toBe(560);
        expect(summary.costUsd).toBeCloseTo(0.0002, 10);
        expect(summary.p50LatencyMs).toBe(120);
    });

    it('adds nothing when the provider reports no cost', async () => {
        const ai = new FakeService();
        ai.cost = undefined;
        const { policy } = makePolicy(ai);

        await policy.decide({ contested: [1] });

        expect(policy.stats.summary().costUsd).toBe(0);
    });

    it('reports percentiles over the latency samples', async () => {
        const ai = new FakeService();
        const { policy } = makePolicy(ai);

        for (let i = 1; i <= 100; i++) {
            ai.latencyMs = i;
            await policy.decide({ contested: [1] });
        }

        const summary = policy.stats.summary();
        expect(summary.p50LatencyMs).toBe(51);
        expect(summary.p95LatencyMs).toBe(96);
    });

    it('averages confidence over choice answers and ignores a noul, which carries none', async () => {
        const ai = new FakeService();
        ai.reply = () => ({
            a: { type: 'choice', choice: 'go', probabilities: { go: 1 }, confidence: 0.4 },
            b: { type: 'choice', choice: 'go', probabilities: { go: 1 }, confidence: 0.8 },
            // A noul among the answers must not be counted as confidence 0.
            c: { type: 'noul', noul: 0.9 } as never,
        });
        // describe:false — this reply answers keys of its own, not the ones `ask` posed.
        const { policy } = makePolicy(ai, { describe: false });

        await policy.decide({ contested: [1] });

        expect(policy.stats.summary().meanConfidence).toBeCloseTo(0.6, 10);
    });

    it('rethrows a transport failure and counts it', async () => {
        const ai = new FakeService();
        ai.failWith = new Error('Decision request failed (503): Decisions not available');
        const { policy } = makePolicy(ai);

        await expect(policy.decide({ contested: [1] })).rejects.toThrow('Decisions not available');
        expect(policy.stats.stats.failures).toBe(1);
        expect(policy.stats.stats.consecutiveFailures).toBe(1);
    });

    it('resetCounters zeroes the window but keeps what describes the link now', async () => {
        const ai = new FakeService();
        const { policy } = makePolicy(ai);
        await policy.decide({ contested: [1] });
        ai.failWith = new Error('down');
        await expect(policy.decide({ contested: [1] })).rejects.toThrow('down');

        policy.resetCounters();

        expect(policy.stats.stats.requests).toBe(0);
        expect(policy.stats.stats.failures).toBe(0);
        expect(policy.stats.summary().costUsd).toBe(0);
        expect(policy.stats.stats.lastModel).toBe('typesafe/jev-1.13-20260917');
        expect(policy.stats.stats.consecutiveFailures).toBe(1);
    });
});

describe('ModelDecisionPolicy snapshots', () => {
    it('keeps the last answers newest first', async () => {
        const ai = new FakeService();
        const { policy } = makePolicy(ai);

        await policy.decide({ contested: [1, 2] });

        const shown = policy.snapshots();
        expect(shown.map(s => s.id)).toEqual(['spot_2', 'spot_1']);
        expect(shown[0]!.options.find(o => o.chosen)!.key).toBe('go');
        expect(shown[0]!.options.find(o => o.key === 'hold')!.probability).toBe(0.2);
    });

    it('publishes none when the policy describes nothing', async () => {
        const ai = new FakeService();
        const { policy } = makePolicy(ai, { describe: false });

        await policy.decide({ contested: [1] });

        expect(policy.snapshots()).toEqual([]);
    });
});

describe('question builders', () => {
    it('types a choice from its option keys and leaves a bare noul without criteria', () => {
        const q = choice('Which way?', { left: null, right: 'only if clear' });
        expect(q).toEqual({ type: 'choice', instructions: 'Which way?', criteria: { left: null, right: 'only if clear' } });
        expect(noul('Alarm?')).toEqual({ type: 'noul', instructions: 'Alarm?' });
    });
});
