---
name: making-a-trailer
description: Make, tune and publish a trailer for this game with bitmagic trailer — record gameplay (or a camera fly-through), auto-cut the highlights to generated music, render an MP4, put it on the CDN and the game page. Use when asked for a trailer, highlight reel, gameplay video, or to record gameplay.
---

# Making a trailer

`bitmagic trailer` takes a gameplay recording to a finished MP4 and a public link. You are the
editor: the tool finds the candidates, cuts on the beat and renders; you decide which moments,
in what order, and what the end card says — and you change your mind by editing one JSON file
and running one command again.

## The flow

1. **Have `bitmagic dev` running** (it is the sink the recorder streams frames to, and the HUD
   replay for `--ui`). ffmpeg and Google Chrome must be installed; the commands say so if not.
2. **Record — played footage, a fly-through, or both.** Decide this BEFORE you ask anyone to play:

   ```
   bitmagic trailer record --seconds 60                              # they play
   bitmagic trailer record --flythrough trailer/flythrough.json      # nobody plays
   ```

   **Played footage** is the bulk of any trailer — it is the only thing that shows what the game
   does. `record` opens Chrome on the dev view, waits for the creator to press Play, starts the
   recorder for them, stops after 60 s (or when they press F9), and prints the recording directory.
   Ask them to PLAY WELL — the trailer is only as good as the footage: overtakes, jumps, kills,
   close calls, a finish. `--seconds` is wall-clock; the recording counts FRAMES at 60 fps, and the
   game runs as fast as the machine encodes them — on a machine capturing at 30 fps, 60 s of play
   becomes 30 s of footage (the command reports both). After stop the frames are extracted from the
   capture; the command waits for that. Aim for about 3x the trailer length: a 30 s trailer wants
   90 s of footage, so `--seconds 120` or two sittings.

   **A fly-through needs nobody.** `--flythrough` clicks through the menu and Play itself, then
   glides the camera along an authored path WHILE THE GAME RUNS — traffic drives, animations play,
   physics ticks — and stops at the last marker. It is the whole trailer flow with no human in it,
   so reach for it when the creator is not around, when you are working on your own, or when they
   would rather not be filmed playing badly.

   **Offer it even when there IS gameplay.** A chase camera almost never gives you the two shots
   the craft doc asks for by name — a composed cold open and one calm wide breath before the end —
   and a fly-through costs the creator nothing. Record a short one as well and join the two:

   ```
   bitmagic trailer merge <gameplay-dir> <flythrough-dir> --out <dir>
   ```

   `merge` is how two sittings become one cuttable recording, and it does not care how the
   footage was made — only that the runs share a resolution and post-processing state. So the cut
   can pull an establishing shot from the fly-through and everything else from play.
   Tell the creator the offer in one line ("I can also fly a camera through the level for the
   opening shot — you don't have to do anything"), and write the path yourself from the level you
   built: `world.json` has the coordinates.
3. **Make.** `bitmagic trailer make --music-prompt "<style that fits the game>" --title "<name>"`
   analyzes the recording, generates a music bed (sparks — say so to the creator; `--music <file>`
   uses their own track, `--no-music` skips it), writes a first cut to `trailer/shots.json`,
   renders `.bitmagic/trailer/<recording>/<game>-trailer.mp4`, and prints where everything is.
   Build the music prompt from GAME-DESIGN.md: genre, mood, tempo ("driving synthwave, 128 bpm,
   no vocals").
4. **Look before you deliver.** Open `.bitmagic/trailer/<recording>/sheets/` — one contact sheet
   per candidate window — and extract stills from the RENDERED file to check framing
   (`ffmpeg -ss 12 -i <mp4> -frames:v 1 still.png`). The timeline knows about events, not about
   beauty, occlusion or a camera pointing at a wall.
5. **Tune** (below), then **publish**: `bitmagic trailer make --publish` (or
   `bitmagic trailer publish <mp4>`) uploads to the CDN and puts the video first in the game
   page gallery; re-running replaces the previous trailer. Give the creator the printed URL.

Renders never overwrite — each run writes the next `-rN` — so compare against the previous
cut before delivering.

## What is where

| File | What it is |
|---|---|
| `trailer/shots.json` | **The cut.** Committed. Your edits live here; `make` re-cuts from it every run. |
| `trailer/flythrough.json` | A camera path you author. Committed. Records with nobody playing — the whole trailer, or just the opening shot. |
| `.bitmagic/trailer/recordings/<name>/` | A recording: `<name>_%06d.png` at 60 fps + `timeline.json` (events, sounds, HUD). |
| `.bitmagic/trailer/<name>/analysis.json` | Scored highlight windows: `startFrame`, `endFrame`, `score`, event digests (`"f3121 explosion i0.9"`), `sheet`. |
| `.bitmagic/trailer/<name>/sheets/` | Contact sheets, one per window — read these. |
| `.bitmagic/trailer/<name>/beats.json`, `music.mp3` | The bed and its beat grid. |
| `.bitmagic/trailer/<name>/edl.json`, `*-trailer[-rN].mp4` | The frame-exact cut and the renders (each with its `.edl.json`). |

### shots.json

```jsonc
{
  "version": 1,
  "recording": "gameplay_recording_2026-09-02_14-03-22",
  "shots": [
    { "in": 3100, "beats": 4, "label": "chain explosion" },          // beats with music …
    { "in": 7440, "seconds": 2, "label": "clean overtake", "ui": false } // … or seconds without
  ],
  "titles": [ { "at": "last-clip", "text": "JOYRIDE", "sub": "by Bitmagic", "style": "card" } ]
}
```

`in` is a source frame (60 fps: seconds × 60). Shots may be non-chronological. `speed` stays
1.0. `ui: false` hides the HUD replay on that shot (menus need it). `titles[].at` is output
seconds or `"last-clip"` for the end card. `bitmagic trailer cut` turns this into
`edl.json`; `make` does that and renders.

### flythrough.json

```json
{ "version": 1, "markers": [
  { "position": { "x": 0, "y": 14, "z": -60 }, "lookAt": { "x": 0, "y": 2, "z": 0 }, "timestamp": 0 },
  { "position": { "x": 45, "y": 10, "z": -10 }, "lookAt": { "x": 0, "y": 2, "z": 0 }, "timestamp": 6 },
  { "position": { "x": 20, "y": 6, "z": 40 }, "lookAt": { "x": 0, "y": 3, "z": 20 }, "timestamp": 12 } ] }
```

Positions are world units (`engine/agent-docs/coordinate-system.md`); `timestamp` is seconds,
ascending from 0; `lookAt` (or an Euler `rotation`) per marker. The camera glides through the
markers and the recording stops at the last one (600 s is the ceiling).

You write this file — take the coordinates from the level you built, in `world.json`. Aim the
first marker at whatever makes the game recognisable, keep the camera moving slowly and in one
direction per leg (a drifting push or a slow arc reads as deliberate; a whip-pan reads as a
mistake), and give each leg several seconds. Six markers over 20 s is plenty for the two or three
shots a cut will actually use — you are recording candidate footage, not the trailer.

## Craft — read `references/trailer-craft.md` before touching the cut

Everything about WHICH moments and in what order lives in
`references/trailer-craft.md`, next to this file: the Genre → Hook → Anchors → Content ordering,
laying the timeline out as a skeleton before hunting footage, pacing and shot length, the five
variety axes, the rules for on-screen text, a section-by-section structure template, and the
selection rules earlier trailers already paid for (never slow motion; a high `impactSpeed` is
usually a car dead against a wall; low speed can BE the drama; menus need `"ui": false`).

Read it in full the first time you cut a trailer for this game. The tool finds candidate windows
and snaps cuts to the beat — it has no opinion about any of the above, so without that file your
"tuning" is random.

## Tuning from prompts

The creator talks; you edit `trailer/shots.json`, run `bitmagic trailer make` (add
`--publish` when they want the link updated), and look at the new render.

| They say | You do |
|---|---|
| "faster", "punchier", "more energy" | fewer `beats`/`seconds` per shot (2–3 beats), MORE shots; keep one longer hold and the breath |
| "slower", "let it breathe", "calmer" | longer shots (4–6 beats), fewer of them, a wider calmer shot before the end |
| "more crashes / jumps / kills / X" | swap 1–3 shots for windows whose digests carry `vehicle-collision`, `explosion`, `player-death`, … from analysis.json (check the sheet) — max three, never three in a row |
| "show the menu / the map / the start" | add ONE shot from the recording's opening with `"ui": false` |
| "put the title at the end" / "change the tagline" | `titles: [{ "at": "last-clip", "text": "…", "sub": "…", "style": "card" }]` |
| "add a title at the start" | a `title`-style cue at `at: 0` for ~2.5 s, and make the first shot calm enough to read over |
| "show more of the world / the level", "a wider shot", "an establishing shot" | record a fly-through, `merge` it with the gameplay recording, and take the cold open (and the breath) from it |
| "I can't play right now", "you do it", nobody available | `record --flythrough` — it clicks Play itself and needs no one |
| "different music", "more epic / chill" | `--music-prompt` with the new direction (spends sparks), or `--music <file>`; shots keep their beat counts and re-snap |
| "no HUD" / "show the HUD" | drop or add `--ui` (per shot: `"ui": false`) |
| "the HUD stutters" / "smoother HUD" | raise `--ui-keyframe-rate` on `make` or `render` (default 30/s; 0 = every change) |
| "shorter / longer" | `--seconds N` only matters for a fresh auto cut (`--reset-shots`); otherwise add or remove shots |
| "start over" | `bitmagic trailer make --reset-shots` |
| "use the other recording" | `--recording <dir>`; shots.json from another recording is kept beside a fresh cut |

Then: **quota check** the labels (rule of three, one standing start), render, extract two stills
from the changed region, compare with the previous `-rN`, deliver the URL.
