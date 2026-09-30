# Audio System — Web Audio API Synthesis

Audio is **only added when the user explicitly requests sounds/music**. Never add audio by default.

## Approach

Use the **Web Audio API** to synthesize sounds procedurally. No audio files — everything is generated with oscillators, gain envelopes, and LFOs.

## AudioContext Setup

Initialize on gameplay start and resume a suspended AudioContext from a user gesture. Listen for
the engine's `GameStateManager` transition to `PLAYING`, but do not assume the listener always runs
within the original gesture: a Poki advertisement can delay the transition. If the browser leaves
audio suspended, resume it on the next player input.

```typescript
import { getGameStateManager, GameState } from 'engine/GameStateManager.js';

private audioCtx: AudioContext | null = null;
private masterGain: GainNode | null = null;

// Call this in load() or constructor — it just registers a listener, no AudioContext yet
private setupAudio(): void {
    getGameStateManager().addListener((newState) => {
        if (newState === GameState.PLAYING) this.initAudio();
    });
}

private initAudio(): void {
    if (this.audioCtx) {
        if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
        return;
    }
    try {
        this.audioCtx = new AudioContext();
        this.masterGain = this.audioCtx.createGain();
        this.masterGain.gain.value = 0.3;
        this.masterGain.connect(this.audioCtx.destination);
    } catch { /* audio not available */ }
}
```

This ensures AudioContext is created in the same call stack as the user gesture that starts gameplay.

## Playing a Sound

Build sounds from `OscillatorNode` + `GainNode` for envelope shaping:

```typescript
private playSound(freq: number, waveform: OscillatorType, duration: number): void {
    if (!this.audioCtx || this.audioCtx.state !== 'running' || !this.masterGain) return;
    const ctx = this.audioCtx;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = waveform;              // 'sine' | 'square' | 'sawtooth' | 'triangle'
    osc.frequency.setValueAtTime(freq, now);

    // Attack/decay envelope
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(0.3, now + 0.02);           // attack
    env.gain.exponentialRampToValueAtTime(0.001, now + duration); // decay

    osc.connect(env);
    env.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + duration + 0.05);
}
```

## Techniques

### Harmonics
Layer multiple oscillators at integer frequency multiples for richer tones:
```typescript
const harmonics = [1, 0.5, 0.25]; // amplitude per harmonic
for (let h = 0; h < harmonics.length; h++) {
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(freq * (h + 1), now);
    // ... connect with gain = harmonics[h] * volume
}
```

### Vibrato
Use an LFO oscillator connected to the main oscillator's frequency:
```typescript
const lfo = ctx.createOscillator();
const lfoGain = ctx.createGain();
lfo.frequency.value = 6;    // vibrato rate in Hz
lfoGain.gain.value = 8;     // vibrato depth in cents
lfo.connect(lfoGain);
lfoGain.connect(osc.frequency);
lfo.start(now);
lfo.stop(now + duration);
```

### Melody Sequences
Use frequency ratios for musical intervals. Pentatonic scale works well:
```typescript
const RATIOS = [1, 9/8, 5/4, 3/2, 5/3, 2]; // major pentatonic
let noteIndex = 0;
function nextFreq(baseFreq: number): number {
    const f = baseFreq * RATIOS[noteIndex % RATIOS.length];
    noteIndex++;
    return f;
}
```

## Sound Design Guide

| Use case | Waveform | Freq range | Duration | Character |
|----------|----------|-----------|----------|-----------|
| UI click/select | sine | 400-800 Hz | 0.1-0.2s | Clean, short |
| Jump | sine sweep up | 200->600 Hz | 0.2s | Rising pitch |
| Hit/damage | sawtooth | 80-200 Hz | 0.3s | Harsh, low |
| Collect item | sine | 600-1200 Hz | 0.15s | Bright ping |
| Explosion | noise + square | 40-100 Hz | 0.5s | Rumble |
| Ambient tone | triangle | 100-300 Hz | 1-3s | Soft, warm |
| Musical note | any | varies | 0.3-1s | Per design |

For pitch sweeps, use `osc.frequency.exponentialRampToValueAtTime(targetFreq, endTime)`.

## Cleanup

Close the AudioContext on game dispose:
```typescript
if (this.audioCtx) { this.audioCtx.close(); this.audioCtx = null; }
```

## Common Mistakes
- Creating AudioContext outside a user gesture handler (will be suspended/blocked)
- Forgetting to stop oscillators (memory leak)
- Using `linearRampToValueAtTime` to 0 (use `exponentialRampToValueAtTime` to 0.001 instead)
- Setting gain too high — keep master at 0.3 and individual sounds at 0.1-0.4

## Muting — built in, no call needed

Players can already mute any game that uses audio: the pause menu shows a Mute toggle as soon as the game has played a sound, and the `M` key toggles mute (on by default; a game that needs `M` for something else opts out with `engine.setMuteHotkeyEnabled(false)`). Do **not** add a mute button by default.

Only when the user explicitly asks for an on-screen mute button, enable the engine's HUD one (top-right) in `Game.load()`:

```typescript
engine.enableMuteControl();
```

To be silenced by mute, route your Web Audio nodes through the shared `AudioContext`: connect your master gain to `engine.getAudioDestination()` (or at minimum create your `AudioContext` via `engine.getAudioContext()` so the mute can suspend it).

## Trailer Timeline — log every synthesized SFX (required)

Right where you build a sound's oscillator graph, also log it (free no-op outside F9 recording sessions; asset sounds played via `engine.playSound()` log themselves — no call needed):

```typescript
engine.logSoundEvent('coin', { dur: 0.2, layers: [{ wave: 'square', freq: [880, 1320], gain: [0.3, 0] }] });
```

The recipe is required — it lets the trailer tool re-render the sound offline. Shape: `{ dur: seconds, layers: [{ wave: 'sine'|'square'|'sawtooth'|'triangle'|'noise', freq: hz | [startHz, endHz], gain: 0..1 | [start, end] }] }`; `[start, end]` pairs ramp linearly over `dur`. Approximate your envelope with the closest linear ramp — the recipe is a trailer stand-in, not the in-game sound.
