import {
    RuntimeAIBackoffError,
    isBackoffStatus,
    readRetryAfterMs,
    DEFAULT_BACKOFF_MS,
} from 'engine/RuntimeAIErrors.js';

describe('isBackoffStatus', () => {
    it('is true for the statuses that mean "later"', () => {
        expect(isBackoffStatus(429)).toBe(true);
        expect(isBackoffStatus(503)).toBe(true);
    });

    it('is false for a request that was wrong, or a provider that broke', () => {
        // Retrying these is pointless: nothing about waiting makes them succeed.
        expect(isBackoffStatus(400)).toBe(false);
        expect(isBackoffStatus(413)).toBe(false);
        expect(isBackoffStatus(502)).toBe(false);
    });
});

describe('readRetryAfterMs', () => {
    it('reads the wait the server asked for', () => {
        expect(readRetryAfterMs('{"error":"Rate limit exceeded","retryAfterMs":4200}')).toBe(4200);
    });

    it('falls back to the default for a body that names no wait', () => {
        expect(readRetryAfterMs('{"error":"Decisions budget exhausted"}')).toBe(DEFAULT_BACKOFF_MS);
    });

    it('falls back to the default rather than throwing on a body that is not JSON', () => {
        // The body is whatever the server (or a proxy in front of it) sent.
        expect(readRetryAfterMs('<html>502 Bad Gateway</html>')).toBe(DEFAULT_BACKOFF_MS);
        expect(readRetryAfterMs('')).toBe(DEFAULT_BACKOFF_MS);
    });

    it('ignores a wait that is not a usable number', () => {
        expect(readRetryAfterMs('{"retryAfterMs":"soon"}')).toBe(DEFAULT_BACKOFF_MS);
        expect(readRetryAfterMs('{"retryAfterMs":-1}')).toBe(DEFAULT_BACKOFF_MS);
        expect(readRetryAfterMs('null')).toBe(DEFAULT_BACKOFF_MS);
    });
});

describe('RuntimeAIBackoffError', () => {
    it('is an Error that carries the status and the wait', () => {
        const error = new RuntimeAIBackoffError(429, 4200, 'Decision request failed (429): budget exhausted');

        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe('RuntimeAIBackoffError');
        expect(error.status).toBe(429);
        expect(error.retryAfterMs).toBe(4200);
        expect(error.message).toContain('budget exhausted');
    });
});
