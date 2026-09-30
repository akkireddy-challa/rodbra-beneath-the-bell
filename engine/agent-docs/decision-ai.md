# Decision AI — NPCs that judge a situation

A **decision model** answers typed questions about a state with calibrated probabilities in
~100–600 ms. No prose to parse, no tokens streaming out, no prompt to tune. Bitmagic reaches one
(TypeSafe's Jev) through `AIService.decide`, and `engine/decisions/` is the machinery around it:
a tick, a coded fallback, counters, and a panel showing what it decided and how sure it was.

Runnable reference: `samples/decision-npc.ts` — guards deciding who to raise the alarm about,
compile-checked against the live engine.
The experiment this all came out of, with numbers: `docs/jev-traffic-prototype.md`.

## Is this the right tool?

| The NPC has to… | Use |
|---|---|
| Say something — dialogue, a description, a name, a rumour | `ai.callModel` (`@docs ai-service.md`) |
| Choose between a handful of options in a way a player would call *judgement* — who goes first, is this worth reacting to, how alarmed should I be, which of these offers is fair | **`decide`, this doc** |
| Follow a rule you can write down — "stop under 6 m", "attack when HP < 20%", "patrol between A and B" | Plain code. Faster, free, and it cannot be wrong |
| Path, steer, aim, animate | Engine systems (`@docs npc-navigation.md`, `@docs npc-system.md`) |

**A decision model is not a chat model.** No `/chat/completions`, no text out, no tools, no
streaming. And it is not a way to avoid writing game logic: it is worth a round trip only where a
rule would be arbitrary and a player would notice the difference.

## The one rule that decides whether this works

> **Code owns what must never happen. The model only picks among the moves that are already allowed.**

The traffic prototype learned this the expensive way. Asking the model for each car's speed, with
no shared view of the junction, collided **twice as often as a ten-line rule set**. Asking it one
question per junction — "which of these cars enters next?" — while the *system* enforced "nobody
enters an occupied box" brought it to within a collision a minute of the rule set (2.3 vs 1.6) while
moving ~9 % more traffic, for a tenth of a cent over two and a half minutes. Same model, same city,
same cars. The difference was entirely in which half of the job it was given.

In the API, that rule is `ask()`:

```typescript
ask: view => {
    const { contested } = splitPosts(view);   // code settled everything else
    if (contested.length === 0) return null;  // → no request, no cost, no latency
    …
}
```

Returning `null` is the common case and the cheap one. If you find yourself asking about every
entity every tick, the invariant is in the wrong place.

## Shaping the question

- **One question per JUDGEMENT, not per entity.** "Which of these five cars goes next" is one
  question with five options; "should car 3 go" × 5 is five questions that cannot see each other.
  The first is cheaper, more confident (0.77 vs 0.43 in the prototype) and actually coherent.
- **Batch.** Every question in a request is answered *in parallel against the same state*, so extra
  questions add no latency. One request per tick for the whole scene — never one call per NPC.
- **Give the model an out.** A `nobody` / `no alarm` / `wait` option, described, so "not yet" is an
  answer rather than a forced pick.
- **Brief it in the state.** A short `rules` string ("right-hand traffic; longest wait goes first")
  costs a few tokens and is the model's only briefing on your world's conventions.
- **Point at the subject with a backticked path** in the instructions: ``"At `posts[2]`, which
  person…"``. That is how the question binds to one entry of the state.
- **Read `probabilities` and `confidence`, not just the winner.** A near-flat distribution is the
  model telling you it is guessing — usually because the question is the wrong shape. Turn the panel
  on (`?decisions=1`) and look.

### Question types

`choice(instructions, criteria)` — options → probabilities + `confidence`. The one you want almost
always. `noul(instructions)` — yes/no probability. `score(instructions, levels)` — ordered levels →
a weighted score, which may land between levels. All from `engine/DecisionTypes.js`.

## The state is billed per input token

Round it and trim it. The prototype sends half-metres and tenths of m/s, only entities within 25 m,
and only the first car per lane. That is the difference between 5.8k tokens a request and 1.7k.

Nothing about a model reading `4.5` decides worse than one reading `4.4718272`.

## The loop

`DecisionLoop` (`engine/decisions/`) drives one policy on a cadence and applies answers when they
land. Two rules it enforces for you:

- **Never queue.** A tick whose previous request is still in flight is skipped and counted. A
  decision about a situation that has already changed is worth less than none.
- **Never block.** `update()` returns immediately; the answer arrives some frames later, so
  `applyResult` gets the view that was *perceived* and must re-check it against the live world.
  Entities move, die and change lanes while a request is out.

```typescript
const loop = new DecisionLoop<View, Result>({
    ...DEFAULT_DECISION_LOOP_OPTIONS,                    // tickMs: 400
    policy: new DegradingPolicy(model, rules, DEFAULT_DEGRADING_OPTIONS),
    reporter: model,                                     // the policy with the counters
    perceive: () => this.perceive(),
    applyResult: (view, result) => this.apply(view, result),
});
// in update(): loop.update(deltaTime);   in dispose(): loop.dispose();
```

Keep `timeoutMs` **below** `tickMs`. One loop per game: 400 ms is ~150 requests a minute against a
per-game limit of 300, so a second loop or a 200 ms cadence breaches it. The loop warns once when
most ticks are being skipped — that means the model is slower than your cadence, and the cure is a
longer `tickMs` or a smaller state, never a longer timeout.

## Always ship the coded policy too

Write the hand-written protocol **first** and keep it, for three reasons:

1. **The game stays playable.** `DegradingPolicy` falls back to it after five straight failures for
   ten seconds, and obeys a rate limit or a spent budget for exactly as long as the server asked
   (`RuntimeAIBackoffError.retryAfterMs`). The player gets less clever NPCs, never a broken game.
2. **No provider key, no loop.** `engine.getAIService()` can be absent, and `/health` can report
   `decisions: false`. Branch on it; never make the feature a hard requirement.
3. **It is the baseline.** Without something to compare against you cannot tell whether the model is
   earning its cost. Run the same scene with the same seed on both and write the numbers down — that
   is the whole method in `docs/jev-traffic-prototype.md`.

## Limits, cost and what to watch

- **Per game: 300 requests/minute and an hourly spend budget.** Over either, `decide` throws a
  `RuntimeAIBackoffError` (`engine/RuntimeAIErrors.js`) carrying `retryAfterMs`. Do not retry
  through it — `DegradingPolicy` waits it out for you.
- **Per request: 160 questions, 64 KB.** `ModelDecisionPolicy` refuses over its own `maxQuestions`
  first, with the count, so you find out in the console rather than as a 400 every tick.
- **Cost.** $0.042 per million input tokens, output free. A 40-car traffic tick asking one question
  per contested junction is ~$0.0005/min; the same scene asking one question per car was ~$0.03/min.
  `loop.stats().costUsd` is the running total.
- **Latency.** p50 ~340 ms and p95 ~430–490 ms in every recorded run. Budget for it: a 400 ms tick
  skips some of the time, and that is normal.

## The panel

```typescript
const overlay = new DecisionOverlay(hud, loop, {
    ...DEFAULT_DECISION_OVERLAY_OPTIONS, title: 'GUARDS', visible: decisionOverlayRequested(),
});
```

`?decisions=1` turns it on: a probability bar per option with the pick highlighted, the confidence,
and the round trip's latency, tokens and model id. `setVisible` drives it from a key;
`setFilter` narrows it to the decisions in shot. It is a developer surface — leave it off by default.

Log the `model` from a round trip. It is the versioned id that actually answered, and aliases move.
