import {
    renderDecisionPanel,
    visibleSnapshots,
    escapeHtml,
    DEFAULT_DECISION_PANEL_OPTIONS,
} from 'engine/decisions/DecisionOverlayMarkup.js';
import type { DecisionSnapshot } from 'engine/decisions/DecisionSnapshot.js';
import type { DecisionLoopStats } from 'engine/decisions/DecisionLoop.js';

const NOW = 10_000;

function snapshot(id: string, at: number, label = 'from south · left · waiting 2.5 s'): DecisionSnapshot {
    return {
        id,
        question: `junction ${id}`,
        confidence: 0.77,
        at,
        options: [
            { key: 'car_3', label, probability: 0.62, chosen: true },
            { key: 'nobody', label: 'hold everyone', probability: 0.38, chosen: false },
        ],
    };
}

const STATS: DecisionLoopStats = {
    requests: 12,
    failures: 0,
    lastLatencyMs: 337.4,
    p50LatencyMs: 337,
    p95LatencyMs: 442,
    lastModel: 'typesafe/jev-1.13-20260917',
    lastInputTokens: 1739,
    lastQuestionCount: 9,
    costUsd: 0.009,
    meanConfidence: 0.77,
    activePolicy: 'jev',
    skippedTicks: 4,
    inFlight: false,
};

describe('renderDecisionPanel', () => {
    it('says which policy is deciding before anything has been asked', () => {
        const html = renderDecisionPanel([], { ...STATS, requests: 0, activePolicy: 'rules' }, NOW, DEFAULT_DECISION_PANEL_OPTIONS);

        expect(html).toContain('<b>rules</b>');
        expect(html).toContain('nothing has been asked yet');
    });

    it('reports the last round trip and the model that answered', () => {
        const html = renderDecisionPanel([snapshot('42', NOW)], STATS, NOW, DEFAULT_DECISION_PANEL_OPTIONS);

        expect(html).toContain('337 ms round trip');
        expect(html).toContain('1739 tokens');
        expect(html).toContain('typesafe/jev-1.13-20260917');
    });

    it('draws each option as a bar whose width is its probability, with the pick emphasised', () => {
        const html = renderDecisionPanel([snapshot('42', NOW)], STATS, NOW, DEFAULT_DECISION_PANEL_OPTIONS);

        expect(html).toContain('width:62%');
        expect(html).toContain('width:38%');
        expect(html).toContain('0.62');
        // The chosen option is the only one drawn bold.
        expect(html.match(/font-weight:700/g)).toHaveLength(1);
    });

    it('escapes labels, questions and the model id — all of them carry outside strings', () => {
        const hostile = snapshot('42', NOW, '<img src=x onerror=alert(1)>');
        hostile.question = 'junction <script>';
        const html = renderDecisionPanel([hostile], { ...STATS, lastModel: 'a"b' }, NOW, DEFAULT_DECISION_PANEL_OPTIONS);

        expect(html).not.toContain('<img');
        expect(html).not.toContain('<script>');
        expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
        expect(html).toContain('a&quot;b');
    });

    it('leaves the per-option label out in compact mode', () => {
        const options = { ...DEFAULT_DECISION_PANEL_OPTIONS, compact: true };
        const html = renderDecisionPanel([snapshot('42', NOW)], STATS, NOW, options);

        expect(html).not.toContain('waiting 2.5 s');
        expect(html).toContain('width:62%');
    });

    it('says so when nothing is contested rather than showing a stale answer', () => {
        const html = renderDecisionPanel([], STATS, NOW, DEFAULT_DECISION_PANEL_OPTIONS);

        expect(html).toContain('nothing contested right now');
    });

    it('ages an answer and shows how old it is', () => {
        const html = renderDecisionPanel([snapshot('42', NOW - 3000)], STATS, NOW, DEFAULT_DECISION_PANEL_OPTIONS);

        expect(html).toContain('3 s ago');
    });
});

describe('visibleSnapshots', () => {
    const options = { ...DEFAULT_DECISION_PANEL_OPTIONS, maxQuestions: 2, snapshotTtlMs: 6000 };

    it('keeps the newest however old it is, so the panel never empties mid-watch', () => {
        const stale = [snapshot('1', NOW - 60_000)];

        expect(visibleSnapshots(stale, NOW, options)).toHaveLength(1);
    });

    it('drops older answers once they pass the TTL', () => {
        const mixed = [snapshot('1', NOW), snapshot('2', NOW - 7000), snapshot('3', NOW - 1000)];

        expect(visibleSnapshots(mixed, NOW, options).map(s => s.id)).toEqual(['1', '3']);
    });

    it('never lists more than maxQuestions', () => {
        const many = ['1', '2', '3', '4'].map(id => snapshot(id, NOW));

        expect(visibleSnapshots(many, NOW, options)).toHaveLength(2);
    });
});

describe('escapeHtml', () => {
    it('covers the four characters that can break out of an attribute or a tag', () => {
        expect(escapeHtml('<a href="x">&')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;');
    });
});

describe('visibleSnapshots filtering', () => {
    it('lists only what a game considers relevant when a filter is set', () => {
        const options = { ...DEFAULT_DECISION_PANEL_OPTIONS, filter: (s: DecisionSnapshot) => s.id === '2' };
        const all = ['1', '2', '3'].map(id => snapshot(id, NOW));

        expect(visibleSnapshots(all, NOW, options).map(s => s.id)).toEqual(['2']);
    });
});
