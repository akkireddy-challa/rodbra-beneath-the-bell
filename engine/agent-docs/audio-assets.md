# Audio Assets — Playing Sound Files

Use when the user has uploaded audio files as assets and wants to play them in the game, or wants a sound effect, music track or spoken line generated from a prompt. For procedurally synthesized sounds with no asset files, see `audio-system.md` instead.

`.opus` (Opus in an Ogg container) is the format to prefer — it is what the web editor converts uploads to, and it is the smallest download. The engine plays whatever the browser can decode, so `.mp3`, `.ogg` and `.m4a` also work; `bitmagic assets add sound.mp3` uploads them as-is. Converting first is a size choice, not a correctness one: `ffmpeg -i in.mp3 -c:a libopus -b:a 96k out.opus`.

Audio is **only added when the user explicitly requests it**. Never add audio by default.

## Asset Setup

Audio files are referenced by `assetId` from `world.json` assets (same pattern as video assets). The user uploads them through the asset pipeline — the web editor's Assets tab, or `bitmagic assets add <file>` from the CLI — and each gets an `id` you pass to the engine.

## Generating SFX from a prompt

`generate-sound-effect` is for **premium/high-quality SFX only**. Call it ONLY when the user explicitly asks for premium, high-quality, or AI-generated sound effects. For ordinary SFX, default to Web Audio synthesis (see `audio-system.md`).

When called, the tool generates an Opus-encoded SFX via Eleven Labs and appends it to `world.json` `assets[]` with `type: "audio"` (same shape as an uploaded `.opus`). Use the returned `sound_id` directly with `engine.playSound(sound_id, ...)`. Never generate or wire up audio the user did not explicitly ask for.

## Generating music from a prompt

A music bed can be composed from a prompt — the `generate-music` tool in the web editor, `bitmagic generate music` in a CLI project. Like premium SFX it costs sparks — **billed per second of track** — so only call it when the user explicitly asks for generated or original music. For a game that just needs *some* music, an uploaded track (`bitmagic assets add music.mp3`) costs nothing.

In the web editor, `generate-music` takes `prompt`, `durationSeconds` (10–180, default 30), `instrumental` and `loop`, and returns the `music_id` to play. From the CLI:

```bash
bitmagic generate music --prompt "calm forest ambience, soft strings, slow" --duration 60
bitmagic generate music --prompt "driving synthwave, 120 bpm" --instrumental --json
bitmagic generate music --prompt "..." --out trailer/bed.mp3 --no-world   # a file only, not a game asset
```

- `--duration` is 10–180 seconds (default 30). Describe genre, mood, tempo and instruments; `--instrumental` asks for no vocals.
- By default the track is appended to `world.json` `assets[]` as `type: "audio"` with `loop: true` and `durationSeconds` set — the same shape as an uploaded `.opus`. `--no-loop` marks it one-shot.
- `--out <file>` also saves the MP3 locally; `--no-world` skips the `world.json` entry (what `bitmagic trailer make --music-prompt` does — a trailer bed is not a game asset).
- The asset id is printed (and in the `--json` result as `musicId`). Play it with `engine.playMusic(musicId)`; it loops and cross-fades like any music track below.

## Generating spoken lines (text-to-speech)

A line of dialogue or narration can be spoken from its text — the `generate-speech` tool in the web editor, `bitmagic generate speech --text "..."` in a CLI project. It costs sparks — **billed per second of audio produced** (a sentence is about a spark) — so only call it when the user explicitly asks for voiced lines, narration or voice-over.

- One call per line: each line is its own asset, played when gameplay triggers it.
- `voice` is `narrator` (default), `male`, `female`, or a raw Eleven Labs `voice_id` the user supplied. `stability`, `style` and `speed` pass through to Eleven Labs; leave them unset for its defaults.
- The line is appended to `world.json` `assets[]` as `type: "audio"` with `loop: false` and `durationSeconds` set. Play it with `engine.playSound(speechId)` — the tool returns `speech_id`, the CLI prints it (`speechId` in `--json`).

## API

All methods are on `GameEngine`. Call them from template code (`game/src/work/`).

```typescript
// One-shot sound effect. Fire-and-forget. Multiple SFX can overlap.
engine.playSound(assetId, { volume: 0.8 });

// Background music. Only one track plays at a time — calling again cross-fades.
// Defaults: loop=true, fadeIn=0.5s, volume=1.
await engine.playMusic(assetId, { fadeIn: 1.0 });

// Fade out and stop the current music track. Default fadeOut=0.5s.
await engine.stopMusic({ fadeOut: 1.0 });

// Volume buses. 0 = silent, 1 = full. `master` affects everything.
engine.setAudioVolume({ master: 0.5, sfx: 1, music: 0.3 });
```

## Typical Usage

**SFX on events** (jump, hit, pickup):
```typescript
// In a player controller or gameplay code
onJump() {
    engine.playSound('jump_sound_asset_id');
}
```

**Music on game start:**
```typescript
// After the user starts the game (GameState.PLAYING)
getGameStateManager().addListener((state) => {
    if (state === GameState.PLAYING) {
        engine.playMusic('background_music_asset_id');
    }
});
```

**Stop music on game over:**
```typescript
await engine.stopMusic({ fadeOut: 2.0 });
```

## Notes

- Errors (missing asset, fetch failure, decode failure, autoplay block) log warnings and no-op. Gameplay never breaks on audio issues.
- Decoded buffers are cached — repeat plays of the same asset don't re-fetch.
- Uses the Web Audio API under the hood via `THREE.AudioListener`. Shared AudioContext, so this also works alongside any `THREE.Audio` or `PositionalAudio` usage.
- Automatically silenced during Poki SDK commercial breaks (the integration mutes the listener).
- First call must occur during a user gesture (clicking the Play button counts — `GameState.PLAYING` is entered from a user gesture).

## Muting — built in, no call needed

`engine.playSound` / `engine.playMusic` are silenced by the engine's mute: the pause-menu Mute toggle (shown once the game has used audio) and the `M` key (on by default; opt out with `engine.setMuteHotkeyEnabled(false)` if the game needs `M`). Do **not** add a mute button by default — only when the user explicitly asks for an on-screen one, call this in `Game.load()`:

```typescript
engine.enableMuteControl();
```
