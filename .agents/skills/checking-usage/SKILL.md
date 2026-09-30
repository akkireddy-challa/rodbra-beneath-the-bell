---
name: checking-usage
description: Use when asked how many sparks have been used, what they were spent on, why a game is costing so much, how much Bitmagic Pro allowance is left, whether there is enough left to keep generating, or when a command refuses because the spark balance is not approved for spending.
---

# Checking spark usage

```bash
bitmagic usage                 # last 30 days, plus any Pro allowance still open
bitmagic usage --days 7        # a shorter window (max 90)
bitmagic usage --json          # the same report as one JSON document on stdout
bitmagic allowance             # just the two Pro windows, and what happens when they run out
```

It reports the account's spend broken down by what caused it, a per-day trend, and — for a
Bitmagic Pro subscriber — how much of the current 5-hour and weekly allowance windows is gone and
when each resets. It reads only; nothing is spent by running it.

## The categories

| Category | What it is |
|---|---|
| AI editing | the model doing the work — the largest line for most projects |
| Generation tools | tool calls that produce content during an edit |
| Asset generation (CLI) | `bitmagic generate` and `bitmagic cover` |
| World forge (CLI) | `bitmagic forge` |
| Other | anything else charged to the account |

## Reading the Pro windows

An allowance is a **spending limit, not a balance**: it does not accumulate, and an unused week
banks nothing. Both windows apply at once, so what is spendable right now is whichever has less
left.

Past a window's limit, work falls back to the creator's purchased spark balance — real money — and
**only if they have allowed it**. Until they have, generating stops instead, with a message saying
so. If the weekly window is nearly gone and a request needs several generations, say so before
starting, not after.

## Allowing the spark balance to be spent

```bash
bitmagic allowance --allow-sparks   # a HUMAN runs this, never you
bitmagic allowance --block-sparks   # turn it back off
```

**Never run `--allow-sparks` on the creator's behalf.** It authorises spending their money, so it
is theirs to decide; the command refuses to run outside a real terminal for exactly that reason, and
trying it will simply fail. When a command refuses for want of it, report the refusal and let them
choose between allowing it and waiting for the window to reset.

## When it refuses

- **Not logged in** — run `bitmagic login`.
- **Not entitled** — the CLI needs an active Bitmagic Pro subscription. `bitmagic subscribe`
  starts one.

## What it does not show

Individual charges, and anything older than 90 days. It also cannot attribute spend to a specific
game or prompt — the ledger records what was charged, not which change asked for it. For a
per-invoice view, the plan page on the web is the source of truth.
