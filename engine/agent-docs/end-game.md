# Engine-level End Game (with Replay)

`engine.endGame(options?)` is the canonical way to end a game session. It transitions the engine into `GameState.END`, freezes physics / NPCs / genre `update()` (same gating PAUSED uses), and renders a themed default overlay with a "Play Again" button. Reports `gameplayStop()` to PokiSDK automatically.

**Do NOT roll your own game-over modal.** Use `engine.endGame()`. The default overlay matches the rest of the HUD theme, handles mouse unlock + input freeze for free, and gets PokiSDK integration that hand-rolled overlays would miss.

## When to call

From any place in a genre's game logic where a win/lose/draw condition fires. Examples:

- Player health drops to 0 → `endGame({ outcome: 'lose' })`
- Goal reached / boss defeated → `endGame({ outcome: 'win' })`
- Timer expires → `endGame({ outcome: 'lose', message: 'Time ran out!' })`

Call it once from the genre when the game session is over. Subsequent calls are safe — the overlay is rebuilt and the state listener early-returns when already in END.

## Signature

```ts
engine.endGame(options?: Partial<EndGameOptions>): void

interface EndGameOptions {
    outcome: 'win' | 'lose' | 'draw' | 'neutral';  // default: 'neutral'
    title: string;                                  // default: 'Game Over'
    message: string | null;                         // default: null
    stats: Array<{ label: string; value: string | number }>;  // default: []
    replayLabel: string;                            // default: 'Play Again'
}
```

`outcome` determines the accent color (success / danger / primary). All other fields are pass-through to the overlay.

## Examples

Minimal:

```ts
this.engine.endGame({ outcome: 'win' });
// → Title: "Game Over" in success-green, "Play Again" button.
```

With title + message:

```ts
this.engine.endGame({
    outcome: 'lose',
    title: 'You Died',
    message: 'The dragon got the best of you.',
});
```

With stats:

```ts
this.engine.endGame({
    outcome: 'win',
    title: 'Victory!',
    stats: [
        { label: 'Score', value: 1240 },
        { label: 'Time', value: '02:17' },
        { label: 'Enemies', value: 12 },
    ],
});
```

## What "Replay" does

The Replay button calls `window.location.reload()`. The iframe fully reloads, the game re-fetches its config, and starts in `LOADING → MENU → PLAYING` as on first open. World generation is deterministic from `worldProfileData.worldSeed`, so the world layout is identical on replay.

If a genre needs a faster in-place reset, that's not in the engine yet — full reload is the only path today.

## Screen transitions

The start, pause and end screens animate: the backdrop fades while the card rises into place. Change it or switch it off from game code, usually in `init()`:

```ts
this.engine.setScreenTransition({ style: 'none' });              // instant screens
this.engine.setScreenTransition({ style: 'fade' });              // fade only, no rise
this.engine.setScreenTransition({ enterMs: 400, leaveMs: 250 }); // slower
```

- Fields you leave out take their values from `DEFAULT_SCREEN_TRANSITION`: `'fade-rise'`, 200 ms in, 140 ms out.
- The setting resets on every game load.
- Players whose OS asks for reduced motion always get instant screens.
- A custom screen installed with `engine.setUIComponent(...)` gets the same enter animation if it uses the `ui-modal-overlay ui-modal-overlay--animated` markup.
- Game CSS can also restyle `.ui-modal-overlay--animated` directly.
