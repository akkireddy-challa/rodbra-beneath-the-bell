# Trailer craft — structure, pacing, and on-screen text

Read this before composing a cut or putting any text on screen. Compressed
from Derek Lieu's trailer-editing essays (trailer editor for Half-Life: Alyx,
Dead Cells, Spelunky 2) plus general trailer-typography guidance; sources at
the bottom.

## Ordering: Genre → Hook → Anchors → Content

- **Genre** in 1–2 shots: the viewer must know what kind of game this is
  within the first seconds. For our games one gameplay shot usually does it.
- **Hook** — the thing only this game has — as soon as genre is established:
  ideally inside the first 10–15 s, never later than the first third.
  Showing generic-but-good content before the hook makes the game read as
  "a lesser version of an old game".
- **Anchors** — the features people expect from the genre (for a racer:
  overtakes, drifts, crashes, varied tracks) fill the middle.
- **Content** — breadth (levels, modes, vehicles) comes last, once the viewer
  already cares.

## Timeline layout: constraints first, footage last

Lay the timeline out as a skeleton and only then hunt for footage — not the
other way round:

1. Write the section skeleton: **Cold open → Introduction → Escalation →
   Climax → Breath → Button/End card**. Sections have different lengths and
   energy; they are not equal slices.
2. Reserve the **end card** first: 2–3 s, ONE card (logo + tagline + CTA),
   never a sequence of closing screens.
3. Place any **body title cards** next, as placeholders with their copy
   written — each one names what the following footage must prove.
4. Only now fill footage, chosen to demonstrate whatever the neighbouring
   card or section claims.

This turns "pick 15 great clips" (squishy, drifts toward sameness) into
"find the one clip that proves this beat" (constrained, self-diversifying).

## Pacing

- Sections need **ebb and flow**: build to a peak, then give a deliberate
  breathing shot (~5 s, calmer, wider) before the next build or the finale.
  The stops emphasize the fast; the fast emphasizes the slow.
- **Rule of three**: never more than three similar things in a row — three
  crashes, three drift shots, three of anything. Viewers extrapolate after
  two; the fourth is dead time.
- **Do not cut on every beat.** Snap cuts to the grid, but vary clip lengths
  (2, 3, 4, 6 beats) and sometimes let a musical moment land on an in-clip
  action (a landing, an impact) instead of a cut. Constant per-beat cutting
  reads as a sizzle reel, and gets nauseating.
- Average shot length is a genre statement: ~1.3 s reads as AAA shooter,
  ~4 s reads as contemplative indie. An arcade racer sits around 1.5–3 s
  with a few longer holds where one continuous action is the payoff.
- **More editing is not better editing.** A cut must clarify or escalate;
  cutting fast to look "like a real trailer" hides the game. If a single
  take shows the whole stunt, keep the take.
- Total length: under 90 s unless there's a reason; 30–45 s is a sweet spot
  for social/store use.

## Variety — the five axes

Audit the cut on each axis; the labels list in the shots file is the tool
(read the labels top to bottom — repetition is visible in text before you
ever re-watch):

1. **Content** — different actions, not the same action in new places.
   Escalate variants (jump → bigger jump) rather than repeating.
2. **Composition** — vary camera distance and framing; chase cam all the way
   through is monotone. Watch eye-trace: the viewer's focus point should not
   teleport across the frame on a cut.
3. **Energy** — intense vs. quiet moments; contrast matters more than speed.
4. **Pacing** — vary section tempo, not just shot tempo.
5. **Shot length** — vary beats-per-clip even inside a fast section.

## Where the shots come from

Played footage is the default and the bulk of any trailer: it is the only
thing that shows what the game DOES, and a trailer of pure scenery reads as a
tech demo however pretty it is. But two of the beats above are ones a chase
camera almost never hands you:

- the **cold open**, which wants the level to look composed and deliberate;
- the **breath**, which wants one calm wide shot with nothing happening.

Both are what an authored **camera fly-through** is for — a path through the
level with the game running underneath, so traffic still drives and animations
still play while the camera moves on rails. Recording one is cheap and nobody
has to play it, so a fly-through is worth having even when there is plenty of
gameplay: cut one or two of its shots into a gameplay trailer rather than
building a trailer out of it.

A fly-through alone is the right whole trailer in a narrow set of cases — a
world reveal, an architectural or exploration piece, a level that is the
feature — and whenever there is no one available to play. Otherwise it is a
source of shots, not a substitute for showing the game.

## On-screen text

When to use text at all: only when footage cannot say it. A card that
narrates what the next shot visibly shows is noise. Default for our
gameplay trailers: **end card only**; add body cards only when they carry
information the footage can't (game name early, a hook that isn't visual,
release date).

Writing the cards:
- Copy must sound like this game and no other. Exercise: describe the game
  in three words; build cards from what's left after cutting everything
  generic.
- ≤ 6 words per card. Evocative verbs beat feature lists ("Forge your own
  path", not "Over 40 unique tracks").
- Banned: content quantities ("5 unique levels"), genre-descriptor stacks
  ("a 2D rogue-lite action adventure"), player-verb lists ("Race! Drift!
  Win!"), and stock phrases ("In a world…", "Get ready…", "Experience…",
  "…like never before").

Showing the cards:
- **Intercut, don't overlay**: a card gets its own beat between gameplay
  shots (dimmed still or plain background). Never ask the viewer to read
  while action plays — they do neither. Small persistent text (logo bug,
  date) is the exception.
- Reading time: ~0.5–0.7 s per word, minimum 2.5 s on screen; end card
  2–3 s (ours may run longer over a music outro).
- Cards ride the same beat grid as the cuts — a card is a clip.
- Typography must match the game's art quality and universe: one typeface
  family for the whole trailer, generous letter-spacing for all-caps,
  strong contrast against footage (our title raster already adds shadow),
  subtle animation only (fade/scale-in) — a static default-font card reads
  as a last-minute add-on.

## Structure template (30–45 s, gameplay-only, end card close)

| Section | ~share | What goes here |
|---|---|---|
| Cold open | 5–15% | The single most striking moment; genre obvious at a glance |
| Introduction | 15–20% | Clean, readable driving; establish look + one anchor |
| Escalation | 35–45% | Varied action, rising energy, hook prominent early in it |
| Climax | 15–20% | Densest, loudest stretch; biggest moments back to back |
| Breath | ~5% | One calmer, wider shot; lets the climax land |
| End card | 2–3 s+ | Logo, tagline, CTA — over the music's outro |

## Selection rules already paid for

These came out of review rounds on real cuts. They cost time to learn and
nothing to apply, so apply them before the first render, not after.

- **Never use slow motion.** On gameplay footage it reads as the game running
  at a low framerate, not as drama. `speed` stays 1.0.
- **Numbers are not interest.** Event `severity` / `impactSpeed` ranks
  car-stops-dead-against-a-wall highest — the worst possible clip. A crash
  earns its slot only if things visibly break (`destruction` events, debris)
  and motion continues through the hit.
- **Low speed can BE the drama.** Wheelspin recoveries throwing dirt or snow,
  plowing back onto the track, being overtaken while struggling
  (`position-change` with `gained: false`), `off-track` +
  `hard-acceleration` clusters — these are among the best clips and score
  near zero on any speed metric.
- **"Some shots of X" means a few.** The failure mode is 0-or-100: one
  standing start is an opener, five is a broken trailer.
- **Quota check before rendering.** Read the shots list labels top to bottom.
  Max one standing start; no more than three of any shot type in the whole
  cut and never three similar in a row; vary track or biome, camera distance
  and action type (the five axes above).
- **Menu and selection clips need `"ui": false`** — the HUD replay only knows
  the gameplay HUD and will paint it over menus.
- **Verify on pixels.** Contact sheets and stills for every candidate, and
  stills from the RENDERED file for anything you changed. The timeline knows
  about events; it cannot see framing, occlusion or beauty.
- **Iterate cheaply, keep history.** Editing the shots and re-rendering is
  minutes, and revisions auto-version — so render rather than debate, and
  compare against the previous `-rN` before delivering.

## Sources

- [How to Hook the Audience and How Quickly to Do it](https://www.derek-lieu.com/blog/2022/10/24/how-to-hook-the-audience-and-how-quickly-to-do-it)
- [Step Two of Starting a Game Trailer Timeline](https://www.derek-lieu.com/blog/2023/2/19/step-two-of-starting-a-game-trailer-timeline)
- [How to Think About Pacing in a Trailer](https://www.derek-lieu.com/blog/2020/11/16/how-to-think-about-pacing-in-a-trailer)
- [Variety is the Spice of Trailers](https://www.derek-lieu.com/blog/2019/3/27/variety-is-the-spice-of-trailers)
- [More Trailer Editing is not Better Trailer Editing](https://www.derek-lieu.com/blog/2023/4/23/more-trailer-editing-is-not-better-trailer-editing)
- [How to Write Trailer Title Cards With Strong Messaging](https://www.derek-lieu.com/blog/2020/4/19/how-to-write-trailer-title-cards-with-strong-messaging)
- [10 Common Indie Game Trailer Mistakes & How to Fix Them](https://www.derek-lieu.com/blog/2020/9/14/10-common-indie-game-trailer-mistakes-and-how-to-fix-them)
