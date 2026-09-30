# Video Cutscenes

`engine.playVideo(assetId)` plays a generated clip as a fullscreen overlay and resolves when it ends or the player skips it. Use it for an opening cutscene, a level-transition beat, or an ending sting.

## 1. Generate the clip

```bash
bitmagic generate video --prompt "rider leaps onto a jetski in an icy strait" --duration 5
```

In the web Creator the asset subagent's `generate-video` tool does the same from a chat prompt ("add a 5 second intro video of …").

This adds an `assets[]` row of `type: "video"` to `world.json` and prints the asset id plus the exact `engine.playVideo("<id>")` call to use. Generation is billed per second and takes ~20s (prompt only) or ~30s with `--image` (a local first frame); a clip under 5s, or of fractional length, runs on a slower model at ~40s / ~3min.

**Look at what you got before wiring it up.** The command tiles 8 frames from the clip into `.bitmagic/videos/<assetId>.png` — read that image to check the clip shows what you asked for. It also reports whether the clip has an audio track; generated clips are silent today, so a cutscene that needs sound needs a music bed under it (see "Audio" below). Both need `ffmpeg` on `PATH`; without it the generation still succeeds and the command says why there are no frames.

## 2. Play it

```ts
await this.engine.playVideo?.('5174eb4f-…', { skippable: true, fadeIn: 0.5, fadeOut: 0.5 });
```

`playVideo` is optional on `EngineLike`, so template code calls it with `?.`.

| Option | Default | Meaning |
|---|---|---|
| `skippable` | `true` | Any click or keypress ends the clip. A "Click or press any key to skip" hint fades in after 2s. |
| `fadeIn` | `0.5` | Seconds to fade the black overlay in. `0` disables. |
| `fadeOut` | `0.5` | Seconds to fade out before the overlay is removed. `0` disables. |

It **never rejects**. A missing asset id, a decode error, or blocked autoplay all resolve immediately with a `console.warn`, so gameplay always continues — which also means a cutscene that silently does not play looks exactly like one that finished.

## Layering — you do not need to hide anything

The overlay mounts on `<body>` at z-index 10010, above every layer the engine or your game can draw into:

```
#game-container (auto)     the WebGL/WebGPU canvas
.hud-root (100)            GameHUD and every HUD element you create
.ui-screen-overlay-layer   9000   StartScreen
.hud-gameplay-layer        9998   incl. the "Press ESC for menu" hint
FadeOverlay                9999   fade-to-black for respawn/teleport
cutscene overlay          10010   playVideo
```

So the cutscene covers the HUD, the ESC hint, the start screen and any full-screen DOM your game mounted — and, being opaque and click-swallowing, nothing underneath is reachable while it plays. **Do not hand-roll a backdrop to hide the scene behind the cutscene**; anything you mount inside `#game-container` is trapped there (it is `position: fixed`, i.e. its own stacking context) and anything you mount on `<body>` still loses to the overlay.

## The user-gesture requirement

Browsers block autoplay until the page has seen a user gesture. Call `playVideo` **from or after the Play click** — an intro cutscene belongs in the code path that runs when gameplay starts, never at load/construct time. Without a prior gesture `VideoPlayer` logs `[VideoPlayer] Autoplay blocked, resolving immediately` and the promise resolves with nothing shown.

## What to freeze, and why the engine will not do it for you

`GameState.PLAYING` is entered on the Play click, before and independently of any cutscene, and that state is what makes `isGameplayRunning()` true and feeds a non-zero `simulationDeltaTime` to physics, NPCs and `genreModule.update()`. **The world keeps running behind the overlay.** A 5-second intro means five seconds of simulation the player never sees — the boat drifts, timers tick, an NPC may already have reached you.

Freeze what matters before awaiting, restore after:

```ts
// In the genre's start/play path — after the Play click.
this.playerController.setPlayerEnabled(false);   // freeze the capsule + skip its update
this.hud.setGameplayUIVisible(false);            // optional: also hides the ESC hint on exit
this.introPlaying = true;                        // your own update() checks this and returns early

await this.engine.playVideo?.(INTRO_VIDEO_ID);

this.introPlaying = false;
this.hud.setGameplayUIVisible(true);
this.playerController.setPlayerEnabled(true);
```

`setPlayerEnabled(false)` covers the player only. Anything your genre advances in its own `update()` — vehicle physics, race timers, spawners — needs its own gate; that is what the `introPlaying` flag is for.

## Audio

The cutscene `<video>` is a plain DOM element and is **not** routed through the engine's audio graph. Consequences:

- Engine volume and mute (`engine.setAudioVolume()`, the mute hotkey) do not apply to it.
- Nothing ducks or pauses your background music, ambience or looping SFX — they play *under* the cutscene. The easy way to get this wrong: a loop that starts on its first `update()` call, where that first call lands on the same frame as the Play click, so the engine note plays under the intro. Start ambient loops after the cutscene resolves, or stop them for its duration.
- Generated clips are silent, so any sound during the cutscene has to come from `engine.playMusic()` / `engine.playSound()`.

## Related

- `START_SCREEN.md` — the Play button that must be clicked before a cutscene can play.
- `audio-system.md` — `playMusic` / `playSound` for a music bed.
- `level-system.md` — for a cutscene between levels, play it around the level switch.
