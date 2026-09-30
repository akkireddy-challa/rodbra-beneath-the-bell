/**
 * The decision read-out's markup, as a pure function of snapshots and stats.
 *
 * Kept apart from the HUD element that mounts it so the panel can be asserted on
 * in a unit test — the escaping in particular, since every label on it comes from
 * game data and some of it is shaped by a model's answer.
 *
 * It is a developer diagnostic, so it is drawn in the Bitmagic surface tokens
 * (`editor/editor-styles.ts`), not the HUD theme: a game may retheme the HUD into
 * anything, and a panel you read numbers off has to stay readable.
 */

import { BM } from 'editor/editor-styles.js';
import type { DecisionSnapshot } from 'engine/decisions/DecisionSnapshot.js';
import type { DecisionLoopStats } from 'engine/decisions/DecisionLoop.js';

export interface DecisionPanelOptions {
    /** Heading, e.g. 'JEV'. */
    title: string;
    /** How many questions to list. Keep it small — the markup goes into recordings. */
    maxQuestions: number;
    /** Older snapshots than this drop off; the newest always stays. */
    snapshotTtlMs: number;
    /** Compact rows for a phone screen. */
    compact: boolean;
    /**
     * Narrows the panel to the decisions a game considers relevant right now — a
     * camera holding one part of the map, one team, one room. Null lists them all.
     */
    filter: ((snapshot: DecisionSnapshot) => boolean) | null;
}

export const DEFAULT_DECISION_PANEL_OPTIONS: DecisionPanelOptions = {
    title: 'DECISIONS',
    maxQuestions: 3,
    snapshotTtlMs: 6000,
    compact: false,
    filter: null,
};

export const DECISION_PANEL_CSS = `
    min-width: 300px;
    max-width: 400px;
    padding: 12px 14px;
    background: ${BM.surface};
    color: ${BM.textPrimary};
    border-radius: 8px;
    box-shadow: ${BM.insetBorderDim};
    font-family: ${BM.font};
    font-size: 14px;
    line-height: 1.5;
`;

export const DECISION_PANEL_CSS_COMPACT = `
    max-width: 60vw;
    padding: 8px 10px;
    background: ${BM.surface};
    color: ${BM.textPrimary};
    border-radius: 8px;
    box-shadow: ${BM.insetBorderDim};
    font-family: ${BM.font};
    font-size: 11px;
    line-height: 1.4;
`;

/**
 * Everything drawn here may carry a model's words or a game's own strings, so it
 * all goes through this. `innerHTML` is how a HUD custom element is updated.
 */
export function escapeHtml(text: string): string {
    return text.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] ?? ch));
}

/** The snapshots a panel shows: the newest always, older ones only while fresh. */
export function visibleSnapshots(
    snapshots: readonly DecisionSnapshot[],
    now: number,
    options: DecisionPanelOptions,
): DecisionSnapshot[] {
    const relevant = options.filter ? snapshots.filter(options.filter) : snapshots;
    return relevant
        .filter((s, i) => i === 0 || now - s.at < options.snapshotTtlMs)
        .slice(0, options.maxQuestions);
}

export function renderDecisionPanel(
    snapshots: readonly DecisionSnapshot[],
    stats: DecisionLoopStats,
    now: number,
    options: DecisionPanelOptions,
): string {
    const title = `<b>${escapeHtml(options.title)}</b>`;
    if (stats.requests === 0) {
        const policy = escapeHtml(stats.activePolicy);
        return `${title} — <b>${policy}</b> is deciding; nothing has been asked yet`;
    }
    const head = `<div>${title} &nbsp;${stats.lastLatencyMs.toFixed(0)} ms round trip · ${stats.lastInputTokens} tokens`
        + `<div style="font-size:12px;color:${BM.textMuted}">${escapeHtml(stats.lastModel)}</div></div>`;
    const shown = visibleSnapshots(snapshots, now, options);
    const body = shown.length > 0
        ? shown.map(s => renderSnapshot(s, (now - s.at) / 1000, options)).join('')
        : `<div style="margin-top:6px;color:${BM.textMuted}">nothing contested right now</div>`;
    return head + body;
}

function renderSnapshot(snapshot: DecisionSnapshot, ageS: number, options: DecisionPanelOptions): string {
    const rows = snapshot.options.map(option => {
        const pct = Math.round(option.probability * 100);
        const emphasis = option.chosen ? `font-weight:700;color:${BM.aqua}` : `color:${BM.textMuted}`;
        const fill = option.chosen ? BM.aqua : BM.border;
        const label = options.compact
            ? ''
            : `<span style="grid-column:1 / -1;font-size:12px;color:${BM.textDim};margin-top:-2px">${escapeHtml(option.label)}</span>`;
        return `<div style="display:grid;grid-template-columns:72px 1fr 40px;gap:6px;align-items:center;${emphasis}">`
            + `<span>${escapeHtml(option.key)}</span>`
            + `<span style="display:block;height:8px;background:${BM.borderMuted};border-radius:4px;overflow:hidden">`
            + `<span style="display:block;height:100%;width:${pct}%;background:${fill}"></span></span>`
            + `<span style="text-align:right">${option.probability.toFixed(2)}</span>`
            + label
            + '</div>';
    }).join('');
    const age = ageS >= 1 ? `${ageS.toFixed(0)} s ago · ` : '';
    return `<div style="margin-top:6px">`
        + `<div style="color:${BM.textMuted};display:flex;justify-content:space-between;gap:8px">`
        + `<span>${escapeHtml(snapshot.question)}</span><span>${age}conf ${snapshot.confidence.toFixed(2)}</span></div>`
        + `${rows}</div>`;
}
