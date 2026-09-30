// Forwards runtime errors captured by ConsoleCapture to the Creator, so the AI
// agent sees what the running game threw without the user clicking "Fix errors".

import { ConsoleCapture, type CapturedMessage } from 'engine/ConsoleCapture.js';
import { safePostMessageToCreator } from 'engine/CreatorMode.js';

const BATCH_INTERVAL_MS = 500;
const MAX_STACK_FRAMES = 6;
const MAX_MESSAGE_LENGTH = 500;

// `http://localhost:3001/dist/work/Game.js?v=1790260069794:184:61` → `work/Game.js:184:61`.
// Origin, the `dist/` prefix and the query (the per-build cache-buster) carry
// nothing the agent can use, and the cache-buster would make the same error
// look new after every reload.
const SOURCE_URL = /\bhttps?:\/\/[^\s/]+\/(?:dist\/)?([^\s?#:)]+)(?:\?[^\s#:)]*)?(?:#[^\s:)]*)?/g;

/** Replace script URLs with their source path — `work/Game.js:184:61`. */
export function shortenSourceUrls(text: string): string {
    return text.replace(SOURCE_URL, '$1');
}

export interface ForwardedRuntimeError {
    message: string;
    stack?: string;
    count: number;
    firstSeen: number;
}

/** Keep the error line plus the first few frames — enough to locate the source. */
export function truncateStack(stack: string | undefined): string | undefined {
    if (!stack) return undefined;
    const lines = shortenSourceUrls(stack).split('\n');
    const frames = lines.filter(line => line.trim().startsWith('at '));
    if (frames.length === 0) return lines.slice(0, MAX_STACK_FRAMES).join('\n');
    return frames.slice(0, MAX_STACK_FRAMES).map(line => line.trim()).join('\n');
}

/**
 * Collect error entries whose count grew since the last send, merged by message
 * (ConsoleCapture only dedupes consecutive repeats, so one error can appear in
 * several entries). `sentCounts` is updated in place.
 */
export function collectNewErrors(
    messages: readonly CapturedMessage[],
    sentCounts: Map<string, number>
): ForwardedRuntimeError[] {
    const merged = new Map<string, ForwardedRuntimeError>();
    for (const entry of messages) {
        if (entry.type !== 'error') continue;
        const message = shortenSourceUrls(entry.message).slice(0, MAX_MESSAGE_LENGTH);
        const existing = merged.get(message);
        if (existing) {
            existing.count += entry.count;
            existing.stack ??= truncateStack(entry.stack);
        } else {
            merged.set(message, {
                message,
                stack: truncateStack(entry.stack),
                count: entry.count,
                firstSeen: entry.timestamp,
            });
        }
    }

    const changed: ForwardedRuntimeError[] = [];
    for (const [message, error] of merged) {
        if ((sentCounts.get(message) ?? 0) === error.count) continue;
        sentCounts.set(message, error.count);
        changed.push(error);
    }
    return changed;
}

/** Start forwarding. Call once, after ConsoleCapture has started (creator mode only). */
export function startRuntimeErrorForwarding(): void {
    const capture = ConsoleCapture.getInstance();
    const sentCounts = new Map<string, number>();
    let timer: number | null = null;

    const flush = () => {
        timer = null;
        const errors = collectNewErrors(capture.getMessages(), sentCounts);
        if (errors.length === 0) return;
        safePostMessageToCreator({ type: 'GAME_RUNTIME_ERRORS', data: { errors } });
    };

    capture.addListener(() => {
        if (timer !== null) return;
        timer = window.setTimeout(flush, BATCH_INTERVAL_MS);
    });
}
