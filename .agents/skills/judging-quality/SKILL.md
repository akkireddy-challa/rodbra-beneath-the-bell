---
name: judging-quality
description: Use after finishing a milestone — a mechanics-plan slice shipped, a level forged, a visual pass done — to get an independent quality verdict on the running game, or when asked whether the game looks good, what to polish next, or to review the game's quality.
---

# Judging the game's quality

```bash
bitmagic verify              # first: captures the screenshot the judge grades (no --fast)
bitmagic judge               # one vision-model call; prints a scorecard, exits 0
bitmagic judge --genre platformer   # sharpen the rubric: platformer, racing, shooter, combat, driving, tower-defense
bitmagic judge --platform mobile   # grade the phone frame: touch-HUD legibility, thumb reach, portrait framing
bitmagic judge --min-score 7 # exit 4 when the overall score is below the bar
bitmagic judge --json        # the scorecard as one JSON document on stdout
```

You built this game, so you are the wrong judge of it. `bitmagic judge` sends the screenshot
`bitmagic verify` captured, plus a rubric built from `GAME-DESIGN.md`, to a separate vision
model and prints back four dimension scores (visual-quality, readability, design-fidelity, polish)
and at most three findings — each naming what to change, most severe first. The scorecard is also
written to `.bitmagic/judge.json`.

A mobile-primary game is graded on its phone frame by default — the one
`bitmagic verify --platform mobile` captured — with the rubric re-pointed at what a phone player
sees. Pass `--platform desktop` to grade the other one.

Visual scores and frame rate are separate. Build the requested look first and report verify's
performance warnings to the creator. Do not remove visual detail or effects to improve FPS
without their approval of the visible tradeoff, even if a judge finding suggests doing so.
Phone emulation runs on the host computer; its FPS does not establish real-phone performance.

It is paid (a few sparks per run — one call to a model that reasons about the frame before it
scores) and deliberate — which is why it is a command you run, not something verify does for you.

## The loop, and where it stops

1. Finish the milestone. Run `bitmagic verify` — the judge grades verify's screenshot, so a
   stale one gets you a verdict on the game you had yesterday (the command warns when so).
2. Run `bitmagic judge`. Read the findings.
3. Fix the ones worth fixing — they name the object or region and the change.
4. Re-run `verify`, then `judge` once to confirm the fixes landed. The judge is shown its own
   previous verdict, so this second run says of each earlier finding whether it is fixed,
   unchanged or worse — that adjudication is the point of running it again.
5. **Stop.** Whatever the score now says, move on to the next milestone. Never run the judge a
   third time on the same milestone, and never chase a number — the findings are the product, the
   score is context.

## What the score is, and what it is not

The overall score is the mean of the four dimension scores, so shipping a real improvement moves
it — that is arithmetic, not opinion. It is reported to one decimal for the same reason: one
dimension gaining a point is worth 0.25 overall, and you are entitled to see it.

What it is **not** is a target. There is no score at which a game is done, and two things will not
move it however many rounds you spend:

- **Your art style.** Declare it under `## Art direction` in `GAME-DESIGN.md` (with `artStyle`
  in game.json as the fallback the judge reads when the heading is missing) and the judge
  grades craft within that medium. If it is still calling your voxel characters blocky, that
  heading is missing or empty — fix the document, not the game.
- **Matters of taste.** When the remaining findings are things a reasonable person could disagree
  with, or they rotate between runs, the frame is done. Re-rolling for a better number spends the
  creator's sparks on reassurance.

If three or more consecutive rounds return the same score with findings you have judged to be
style or taste, say so to the creator and move on. That is a finished frame, not a stuck one.

## When it refuses

- **No screenshot** — run `bitmagic verify` first, without `--fast` (which skips screenshots).
- **Not enough sparks / spending not approved** — report it to the creator; see the
  `checking-usage` skill. Never enable spending yourself.
