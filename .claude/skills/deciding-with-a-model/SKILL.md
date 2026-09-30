---
name: deciding-with-a-model
description: Use when the game wants NPCs that judge a situation rather than follow a rule — a guard deciding whether to raise the alarm, a referee, a trader weighing an offer, who-goes-next at a contested spot, or any ask for "NPCs that actually think". Also use before adding any per-tick AI call, to check it is worth what it costs.
---

# NPCs that judge a situation

A **decision model** answers typed questions about a game state with calibrated probabilities in
~300 ms. It is not a chat model: no prose, no streaming, nothing to parse. The engine wraps it in
`engine/decisions/` — a tick, a coded fallback, counters, and a panel.

Read `engine/agent-docs/decision-ai.md` for the API and the question rules, and
`engine/agent-docs/samples/decision-npc.ts` for a working one. This page is the method.

## First, decide whether to use it at all

Only for a **judgement** — something a player would recognise as a call that could go either way.

- The NPC has to **say** something → `ai.callModel`, not this.
- The behaviour is a rule you can write down ("attack under 20% HP", "stop within 6 m") → plain
  code. It is faster, free, and it cannot be wrong.
- It must never get this wrong (a safety invariant, a win condition, an economy rule) → plain code.
  The model picks among moves your code has already allowed. Getting that backwards is what made
  the reference experiment's first attempt collide twice as often as a ten-line rule set.

**It costs real money on every play.** Roughly 0.05 US cents a minute at a 400 ms tick asking one question
per contested spot. Do not add it because it would be clever — add it because the creator asked for
NPCs that think, or because you have a judgement that code genuinely cannot express.

## Build the rule policy first, and keep it

Write the hand-written protocol before you write the model one. It is three things at once:

1. **The fallback.** `DegradingPolicy` runs it when the link fails, when the game is rate
   limited, and when there is no provider key at all. The game must be playable on it alone.
2. **The baseline.** Without something to compare against you cannot tell whether the model earns
   its cost.
3. **The spec.** Writing it is how you find out which part of the job is genuinely a judgement —
   usually much less of it than it first looks.

## Then measure, don't assume

Run the same scene twice, same seed, same length: once on `rules`, once on the model. Write the
numbers down. Pick the measures before you run it — whatever the feature is actually for (alarms
raised vs false alarms, crossings per minute, fights won) plus `loop.stats()` for
p50/p95 latency, tokens and `costUsd`.

Then read the outcome honestly. A model that ties the rule policy and costs money is a **loss**;
say so and keep the rules. The reference experiment took four rounds to find a framing that beat
its baseline, and each round changed the question, not the model.

Watch `confidence` and the probability spread while you do it — turn the panel on with
`?decisions=1` in the dev view. A near-flat distribution means the model is guessing, and the
fix is the shape of the question (one per judgement, with all the options in it) rather than more
state or a bigger timeout.

## Before you call it done

- The game runs with the model unavailable — test it, do not assume it.
- One decision loop, `timeoutMs` below `tickMs`, and the state rounded and trimmed to what
  the question needs. It is billed per input token.
- `bitmagic check` passes, and you have played it in `bitmagic dev` with the panel on.
- Tell the creator, in plain words, that these NPCs call a paid service while the game is played,
  roughly what it costs a minute, and that it falls back to fixed rules when it cannot.
