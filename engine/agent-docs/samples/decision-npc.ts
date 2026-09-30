/**
 * Guards that judge a situation with a decision model: one question per ALARM
 * (a guard post with intruders near it), never one per guard, and a hand-written
 * protocol that both decides when the model cannot and gives you a baseline to
 * measure it against.
 *
 * Referenced from agent docs (read-docs name: `samples/decision-npc`).
 * Compiled against the live engine by game's `pnpm run check`
 * (tsconfig.docs-samples.json) — an engine API change breaks this file loudly.
 *
 * The shape to copy is the split:
 *   - code decides what MUST happen (a guard who can see an intruder within
 *     `CERTAIN_SIGHT_M` always raises the alarm; a post with nothing near it is
 *     never asked about);
 *   - the model decides the JUDGEMENT that is genuinely a judgement — of the
 *     people loitering near this post, is any of them worth calling about?
 * Getting this the wrong way round is what made the traffic prototype's first
 * two brains collide more than a ten-line rule set (docs/jev-traffic-prototype.md).
 */
import {
    DecisionLoop,
    DecisionOverlay,
    DegradingPolicy,
    ModelDecisionPolicy,
    DEFAULT_DECISION_LOOP_OPTIONS,
    DEFAULT_DECISION_OVERLAY_OPTIONS,
    DEFAULT_DECISION_POLICY_TUNING,
    DEFAULT_DEGRADING_OPTIONS,
    decisionOverlayRequested,
    snapshotFromChoice,
    type DecisionPolicy,
    type DecisionService,
} from 'engine/decisions/index.js';
import { choice, type ChoiceQuestion } from 'engine/DecisionTypes.js';
import type { IGameHUD } from 'engine/IGameHUD.js';
import type { EngineLike } from 'types/game.js';

// ── What the game perceives, and what it applies ────────────────────────────
// Keep the state small and rounded: it is billed per input token, and a model
// reading "4.5 m" decides no worse than one reading "4.4718272".

/** One person the guards can see, as the question describes them. */
export interface SuspectView {
    id: string;
    /** Metres from the post, rounded to the half metre. */
    distance_m: number;
    /** Where they are heading relative to the post. */
    heading: 'towards' | 'away' | 'along';
    /** Seconds they have been inside the post's watch radius. */
    loitering_s: number;
    carrying: 'nothing' | 'tool' | 'weapon';
}

export interface PostView {
    id: string;
    /** What the post guards, so the model can weigh what is at stake. */
    guards: string;
    suspects: SuspectView[];
}

export interface GuardView {
    posts: PostView[];
}

/** Post id → the suspect to raise the alarm about, or null for "no one yet". */
export type GuardDecisions = Map<string, string | null>;

const CERTAIN_SIGHT_M = 4;
const WATCH_RADIUS_M = 25;

/** The briefing the model gets, once per request. Prose, not a prompt to tune. */
const POST_RULES = 'A guard raises the alarm only for someone who is plainly about to break in — '
    + 'walking towards the post, carrying something, or loitering for a long time. Someone walking '
    + 'past, or standing still far away, is not worth calling about; a false alarm costs the guards '
    + 'their post.';

const postKey = (id: string): string => `post_${id}`;
const suspectKey = (id: string): string => `suspect_${id}`;
const NOBODY = 'nobody';

/**
 * The invariant, in code: a suspect this close with a weapon is an alarm whatever
 * any model thinks, and a post with nothing near it is not a question at all.
 * Everything left over is the judgement worth a round trip.
 */
function splitPosts(view: GuardView): { settled: GuardDecisions; contested: PostView[] } {
    const settled: GuardDecisions = new Map();
    const contested: PostView[] = [];
    for (const post of view.posts) {
        const certain = post.suspects.find(s => s.distance_m <= CERTAIN_SIGHT_M && s.carrying === 'weapon');
        if (certain) settled.set(post.id, certain.id);
        else if (post.suspects.length === 0) settled.set(post.id, null);
        else contested.push(post);
    }
    return { settled, contested };
}

type PostQuestions = Record<string, ChoiceQuestion<string>>;

/**
 * The hand-written protocol. Build this FIRST: it is what the game falls back to
 * when the model is unavailable, and it is the baseline the model has to beat
 * before it earns its cost.
 */
export class RuleGuardPolicy implements DecisionPolicy<GuardView, GuardDecisions> {
    readonly name = 'rules';

    async decide(view: GuardView): Promise<GuardDecisions> {
        const { settled, contested } = splitPosts(view);
        for (const post of contested) {
            const worrying = post.suspects.find(s =>
                s.heading === 'towards' && s.distance_m < WATCH_RADIUS_M / 2 && s.carrying !== 'nothing');
            settled.set(post.id, worrying?.id ?? null);
        }
        return settled;
    }
}

/** The same question put to the decision model — every contested post in ONE request. */
export function createGuardPolicy(
    ai: DecisionService,
    sessionId: string,
): ModelDecisionPolicy<GuardView, GuardDecisions, PostQuestions> {
    return new ModelDecisionPolicy(ai, {
        ...DEFAULT_DECISION_POLICY_TUNING,
        name: 'jev',
        sessionId,
        // Returning null means code already settled the tick — no request, no cost.
        ask: view => {
            const { contested } = splitPosts(view);
            if (contested.length === 0) return null;
            const questions: PostQuestions = {};
            contested.forEach((post, i) => {
                const criteria: Record<string, string | null> = {};
                for (const s of post.suspects) criteria[suspectKey(s.id)] = null;
                criteria[NOBODY] = 'No one here is worth raising the alarm about yet';
                // A backticked path points the model at the exact entry in `state`.
                questions[postKey(post.id)] = choice(
                    `At \`posts[${i}]\`, which person should the guards raise the alarm about?`,
                    criteria,
                );
            });
            return { state: { rules: POST_RULES, posts: contested }, questions };
        },
        // The model may name someone who has already walked off. Only the game knows
        // that, so the answer is checked here, against the view it was asked about.
        apply: (view, answers) => {
            const { settled, contested } = splitPosts(view);
            for (const post of contested) {
                const picked = answers[postKey(post.id)]?.choice;
                const suspect = post.suspects.find(s => picked === suspectKey(s.id));
                settled.set(post.id, suspect?.id ?? null);
            }
            return settled;
        },
        resolveLocally: view => splitPosts(view).settled,
        // Rows for the `?decisions=1` panel: read the probabilities, not just the winner.
        describe: (view, answers) => splitPosts(view).contested.flatMap(post => {
            const answer = answers[postKey(post.id)];
            if (!answer) return [];
            const labels: Record<string, string> = { [NOBODY]: 'no alarm' };
            for (const s of post.suspects) {
                labels[suspectKey(s.id)] = `${s.heading} · ${s.distance_m} m · ${s.carrying}`;
            }
            return [snapshotFromChoice(postKey(post.id), `post ${post.id}`, answer, labels, performance.now())];
        }),
    });
}

// ── Wiring it into a game ───────────────────────────────────────────────────

export interface GuardBrain {
    update(deltaTime: number): void;
    dispose(): void;
}

/**
 * Call once from `Game.load()`, then `update(deltaTime)` each frame and
 * `dispose()` on teardown. One loop per game: at the default 400 ms cadence that
 * is ~150 requests a minute, against a per-game limit of 300.
 */
export function installGuardBrain(
    engine: EngineLike,
    hud: IGameHUD,
    gameId: string,
    perceive: () => GuardView,
    raiseAlarm: (postId: string, suspectId: string | null) => void,
): GuardBrain | null {
    const ai = engine.getAIService?.();
    // No decision model available (no provider key, an offline build): the game still
    // runs, on the rule policy alone. Never make the feature a hard requirement.
    const rules = new RuleGuardPolicy();
    const model = ai ? createGuardPolicy(ai, gameId) : null;

    const loop = new DecisionLoop<GuardView, GuardDecisions>({
        ...DEFAULT_DECISION_LOOP_OPTIONS,
        // A rate limit or a spent budget degrades to `rules` for as long as the
        // server asked; five straight failures of any other kind do the same for ten
        // seconds. The player sees less clever guards, never a broken game.
        policy: model ? new DegradingPolicy(model, rules, DEFAULT_DEGRADING_OPTIONS) : rules,
        reporter: model,
        perceive,
        // The answer lands frames after `perceive`, so re-check it against the world
        // as it is NOW before acting on it.
        applyResult: (_view, decisions) => {
            for (const [postId, suspectId] of decisions) raiseAlarm(postId, suspectId);
        },
    });

    const overlay = new DecisionOverlay(hud, loop, {
        ...DEFAULT_DECISION_OVERLAY_OPTIONS,
        title: 'GUARDS',
        visible: decisionOverlayRequested(),
    });

    return {
        update: (deltaTime: number) => {
            loop.update(deltaTime);
            overlay.update(deltaTime);
        },
        dispose: () => {
            loop.dispose();
            overlay.dispose();
        },
    };
}
