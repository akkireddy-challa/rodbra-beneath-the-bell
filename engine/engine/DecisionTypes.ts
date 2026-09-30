/**
 * Typed questions for the runtime Decisions API (`AIService.decide`).
 *
 * A decision model (TypeSafe's Jev, reached through game-server's
 * `/api/ai/decide`) is not a chat model: it reads one `state` and answers a map
 * of typed questions about it, all in parallel, returning calibrated
 * probabilities instead of text. Ask everything you need about a state in ONE
 * call — extra questions add no latency — and let code decide what to do with
 * the answers. Reference nested state with a backticked path in the
 * instructions, e.g. "What should `cars[3]` do?".
 */

/** Instructions and option descriptions may be prose or structured JSON. */
export type DecisionText = string | Record<string, unknown> | unknown[];

/** A yes/no question, answered with the probability of "yes". */
export interface NoulQuestion {
    type: 'noul';
    instructions: DecisionText;
    /** Optional: what a yes (near 1) and a no (near 0) mean. */
    criteria?: { true: DecisionText; false: DecisionText };
}

/** Pick one option; every option gets a probability and the winner is `choice`. */
export interface ChoiceQuestion<O extends string = string> {
    type: 'choice';
    instructions: DecisionText;
    /** Option → description, or null when the name says enough. */
    criteria: Record<O, DecisionText | null>;
}

/** Rate along ordered levels; `score` is probability-weighted and may land between levels. */
export interface ScoreQuestion {
    type: 'score';
    instructions: DecisionText;
    /** Level descriptions in order, lowest first. At least two. */
    criteria: DecisionText[];
}

export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
    type: 'noul';
    /** 0 = no, 1 = yes. */
    noul: number;
}

export interface ChoiceAnswer<O extends string = string> {
    type: 'choice';
    /** The highest-probability option. */
    choice: O;
    /** Every option → probability; sums to 1. */
    probabilities: Record<O, number>;
    /** 0..1, derived from how peaked the distribution is. */
    confidence: number;
}

export interface ScoreAnswer {
    type: 'score';
    score: number;
    /** Level index (as a string key) → the description it had in `criteria`. */
    legend: Record<string, DecisionText>;
    probabilities: Record<string, number>;
    confidence: number;
}

export type DecisionAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

/** The answer type each question produces, so `answers.car_0.choice` is typed to its options. */
export type DecisionAnswerFor<Q> =
    Q extends ChoiceQuestion<infer O> ? ChoiceAnswer<O> :
    Q extends ScoreQuestion ? ScoreAnswer :
    Q extends NoulQuestion ? NoulAnswer :
    never;

export type DecisionAnswers<Q extends Record<string, DecisionQuestion>> = {
    [K in keyof Q]: DecisionAnswerFor<Q[K]>;
};

export interface DecisionsUsage {
    input_tokens: number;
    output_tokens: number;
    /** USD, when the provider reports it. */
    cost?: number;
}

export interface DecisionsResult<Q extends Record<string, DecisionQuestion>> {
    answers: DecisionAnswers<Q>;
    /** The versioned model that actually answered — log it; aliases move. */
    model: string;
    usage: DecisionsUsage;
    /** Wall-clock round trip from the browser, in ms. */
    latencyMs: number;
}

export interface DecisionOptions {
    /** Default 3000 — a decision is only useful while the situation it describes still holds. */
    timeoutMs?: number;
    /** Groups related requests in the provider's observability; never seen by the model. */
    sessionId?: string;
}

/** `choice('Which way?', { left: null, right: 'only if clear' })` — options typed from the keys. */
export function choice<O extends string>(
    instructions: DecisionText,
    criteria: Record<O, DecisionText | null>,
): ChoiceQuestion<O> {
    return { type: 'choice', instructions, criteria };
}

export function noul(instructions: DecisionText, criteria?: NoulQuestion['criteria']): NoulQuestion {
    return criteria ? { type: 'noul', instructions, criteria } : { type: 'noul', instructions };
}

export function score(instructions: DecisionText, criteria: DecisionText[]): ScoreQuestion {
    return { type: 'score', instructions, criteria };
}
