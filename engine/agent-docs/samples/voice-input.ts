/**
 * Player voice input (speech-to-text): push-to-talk preset and the core API.
 *
 * Referenced from agent docs (read-docs name: `samples/voice-input`).
 * Compiled against the live engine by game's `pnpm run check`
 * (tsconfig.docs-samples.json) — an engine API change breaks this file loudly.
 *
 * Two levels of API, both shown below:
 * - `engine.enablePushToTalk(cb)` — one call in `Game.load()` for hold-to-talk:
 *   desktop key + mobile TALK button + recording indicator + error toasts.
 * - `engine.getVoiceInput()` — startListening/stopListening for custom flows
 *   (an NPC dialog that opens the mic, a toggle button, a timed challenge).
 */
import { AIService } from 'engine/AIService.js';
import { VoiceInputError, type VoiceInput } from 'engine/VoiceInput.js';
import type { EngineLike } from 'types/game.js';

/**
 * Push-to-talk feeding an NPC conversation. Call from `Game.load()` — the
 * engine binds the key/button once the player controller exists. Hold V,
 * speak, release: the transcript lands in the callback, where the game decides
 * what to do with the text (here: ask the runtime AI for the NPC's reply).
 */
export function setupVoiceChat(engine: EngineLike, sayAsNpc: (line: string) => void): void {
    engine.enablePushToTalk?.(async (text) => {
        // `text` is already trimmed and non-empty.
        const reply = await AIService.getInstance().callModel(text, {
            systemPrompt: 'You are Tavern-keeper Brom. Answer in one short line.',
        });
        sayAsNpc(reply);
    });
}

/**
 * Custom flow on the core API: a dialog opens the mic explicitly and shows the
 * transcript in its own UI. Degraded handling matters here — a blocked mic
 * must message the player, never break the dialog.
 */
export async function askOnce(voiceInput: VoiceInput, showLine: (line: string) => void): Promise<string | null> {
    if (!voiceInput.isSupported()) {
        showLine('(Voice input is not available in this browser — type instead.)');
        return null;
    }
    try {
        await voiceInput.startListening({ maxDurationMs: 8_000 });
        showLine('Listening — speak now…');
        // Wait for the player to finish; here we simply let the auto-stop cap
        // end the recording. A real dialog would call stopListening() from its
        // own "done" button instead.
        const result = await voiceInput.stopListening();
        return result.text || null;
    } catch (err) {
        if (err instanceof VoiceInputError && err.code === 'permission-denied') {
            showLine('(Microphone blocked — allow mic access to talk.)');
        } else {
            showLine('(Voice input failed — try again.)');
        }
        return null;
    }
}
