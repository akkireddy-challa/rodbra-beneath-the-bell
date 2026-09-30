# Voice Input (Speech-to-Text)

Players talk into the microphone; the game receives the transcript as text. Two levels of API — pick the preset unless the game needs a custom flow. Speech-to-text runs server-side (game-server → Asset Forger → Eleven Labs); the engine handles mic capture, permissions, finding a game-server that can transcribe (@docs ai-service.md), and failures. Runnable example: `samples/voice-input.ts` (push-to-talk NPC chat + a custom dialog flow, compile-checked against the live engine).

## Push-to-talk preset (default choice)

One call in `Game.load()` gives working hold-to-talk: desktop key + mobile TALK button (parity is automatic), a "Listening" indicator, and error toasts. The transcript arrives trimmed and non-empty.

```typescript
this.engine.enablePushToTalk?.((text) => {
    // e.g. feed an NPC conversation via the runtime AI (@docs ai-service.md)
    this.handlePlayerSpeech(text);
});
```

Options (`Partial<PushToTalkOptions>`, defaults in `DEFAULT_PUSH_TO_TALK_OPTIONS` from `engine/PushToTalk.js`): `action`, `desktopKeys`, `mobileLabel`, `mobileRole`, `mobilePosition`, `indicator`, `language` (ISO 639-1 hint, null = auto-detect), `maxDurationMs`, `minDurationMs`, `onError`.

- Do NOT also register the same key with `playerController.registerCustomAction(...)` — the preset does that itself.
- The flag resets on every `loadGame()` (same lifecycle as `engine.enableMuteControl()`).
- Failures never throw into game code: the default shows a HUD toast (mic blocked, unsupported browser, backend down) and the game keeps running. Pass `onError` to customize.

## Core API — custom flows

For an NPC dialog that opens the mic, a toggle button, or any non-hold interaction, drive the service directly:

```typescript
const voiceInput = this.engine.getVoiceInput?.();
if (voiceInput?.isSupported()) {
    await voiceInput.startListening({ maxDurationMs: 8_000 });   // browser prompts once per origin
    // ... player speaks; then:
    const result = await voiceInput.stopListening();             // { text, language? }
}
```

Methods: `voiceInput.isSupported()`, `voiceInput.isListening()`, `voiceInput.startListening(options?)`, `voiceInput.stopListening()`, `voiceInput.cancelListening()` (abort without transcribing), `voiceInput.releaseMicrophone()` (turn off the browser's recording indicator), `voiceInput.onStateChange(cb)` (`'idle' | 'listening' | 'transcribing'` — drive custom UI from this).

Listen options (`Partial<VoiceListenOptions>`, defaults in `DEFAULT_VOICE_LISTEN_OPTIONS` from `engine/VoiceInput.js`): `language`, `maxDurationMs` (auto-stops and still transcribes), `timeoutMs`.

Failures reject with `VoiceInputError` (`error.code`): `unsupported`, `permission-denied`, `no-microphone`, `already-listening`, `not-listening`, `transcription-failed`, `unavailable` (backend not configured), `rate-limited`. Always catch and degrade — show a message, fall back to text input; never let a blocked mic break the game.

## Rules

- Voice input is opt-in per game — wire it only when the user asks for talking/voice features.
- An empty transcript (`''`) means silence — skip it, don't error.
- The transcript is plain text; feeding it to `ai.callModel(...)` for an NPC reply is the common pattern (@docs ai-service.md).
- `AIService.transcribe` exists but is the raw network call — game code should use the two APIs above, which own mic capture and error mapping.
- Recordings are capped (`maxDurationMs`) and rate-limited server-side per game; keep exchanges short.
