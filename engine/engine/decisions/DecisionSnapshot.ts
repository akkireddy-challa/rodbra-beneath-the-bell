/**
 * What a decision looked like when it came back, in a form anything can render.
 *
 * A snapshot is the bridge between a policy (which knows the game's domain) and
 * a read-out (which must not): the policy names the options and labels them, the
 * read-out draws probabilities. Nothing here imports a policy, and no policy has
 * to know a panel exists.
 */

import type { ChoiceAnswer, NoulAnswer, ScoreAnswer } from 'engine/DecisionTypes.js';

export interface DecisionOptionView {
    /** The option key as the question spelled it. */
    key: string;
    /** Human-readable line for this option, e.g. "from south · left · waiting 2.5 s". */
    label: string;
    /** 0..1. */
    probability: number;
    /** True for the option the model picked. */
    chosen: boolean;
}

export interface DecisionSnapshot {
    /** The question key this answered, so a viewer can follow one subject over time. */
    id: string;
    /** Short human title for the question, e.g. "junction 42". */
    question: string;
    options: DecisionOptionView[];
    /** 0..1; 0 for a `noul`, which carries none. */
    confidence: number;
    /** `performance.now()` when it landed, so a read-out can age it out. */
    at: number;
}

/**
 * `labels` maps option key → the line to show; a key with no entry falls back to
 * the key itself. Option order follows `labels` when it covers the answer, so the
 * panel lists options in the order the question offered them rather than however
 * the provider serialised its probabilities.
 */
export function snapshotFromChoice(
    id: string,
    question: string,
    answer: ChoiceAnswer,
    labels: Record<string, string>,
    at: number,
): DecisionSnapshot {
    const keys = Object.keys(labels).length > 0 ? Object.keys(labels) : Object.keys(answer.probabilities);
    return {
        id,
        question,
        confidence: answer.confidence,
        at,
        options: keys.map(key => ({
            key,
            label: labels[key] ?? key,
            probability: answer.probabilities[key] ?? 0,
            chosen: answer.choice === key,
        })),
    };
}

/** Levels in `legend` order, lowest first; the winning level is the most probable one. */
export function snapshotFromScore(id: string, question: string, answer: ScoreAnswer, at: number): DecisionSnapshot {
    const keys = Object.keys(answer.legend);
    let top = keys[0] ?? '';
    for (const key of keys) {
        if ((answer.probabilities[key] ?? 0) > (answer.probabilities[top] ?? 0)) top = key;
    }
    return {
        id,
        question,
        confidence: answer.confidence,
        at,
        options: keys.map(key => ({
            key,
            label: describeLevel(answer.legend[key]),
            probability: answer.probabilities[key] ?? 0,
            chosen: key === top,
        })),
    };
}

/** A yes/no as a two-option view, so one read-out draws every question type. */
export function snapshotFromNoul(id: string, question: string, answer: NoulAnswer, at: number): DecisionSnapshot {
    return {
        id,
        question,
        // A noul is a bare probability: the provider reports no confidence for it.
        confidence: 0,
        at,
        options: [
            { key: 'yes', label: 'yes', probability: answer.noul, chosen: answer.noul >= 0.5 },
            { key: 'no', label: 'no', probability: 1 - answer.noul, chosen: answer.noul < 0.5 },
        ],
    };
}

/** A level description may be prose or structured — show prose as-is, anything else as JSON. */
function describeLevel(level: unknown): string {
    return typeof level === 'string' ? level : JSON.stringify(level);
}
