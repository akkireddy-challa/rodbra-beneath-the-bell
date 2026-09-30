/**
 * The one runtime-AI failure a caller can do something specific about: the
 * game-server telling it to come back later.
 *
 * Everything else — a bad request, a provider error, a timeout — is an ordinary
 * `Error`, because the only sensible response is to stop asking and carry on
 * without it. A back-off is different: it names how long, and a caller that
 * respects it stops burning its retry budget on requests that cannot succeed.
 */

/** Default wait when the server refuses without saying for how long. */
export const DEFAULT_BACKOFF_MS = 1000;

export class RuntimeAIBackoffError extends Error {
    constructor(
        /** 429 (rate limit or budget) or 503 (provider overloaded / feature unavailable). */
        readonly status: number,
        /** How long to wait before asking again. */
        readonly retryAfterMs: number,
        message: string,
    ) {
        super(message);
        this.name = 'RuntimeAIBackoffError';
    }
}

/** True for the statuses that mean "later", not "never" and not "your request was wrong". */
export function isBackoffStatus(status: number): boolean {
    return status === 429 || status === 503;
}

/**
 * The `retryAfterMs` a game-server puts in its refusal body, or the default. The
 * body is whatever the server sent, so it is parsed defensively and never thrown from.
 */
export function readRetryAfterMs(body: string): number {
    try {
        const parsed: unknown = JSON.parse(body);
        if (typeof parsed === 'object' && parsed !== null) {
            const value = (parsed as { retryAfterMs?: unknown }).retryAfterMs;
            if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
        }
    } catch {
        // Not JSON — the default wait is the right answer, not a failure.
    }
    return DEFAULT_BACKOFF_MS;
}
