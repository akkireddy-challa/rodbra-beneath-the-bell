import {
    PlayTokenCache,
    PLAY_TOKEN_REFRESH_BUFFER_MS,
    PLAY_TOKEN_GUEST_TTL_MS,
    type PlayTokenResult,
} from 'engine/identity/PlayerIdentity.js';

/**
 * Unit tests for the PURE token-cache/expiry/refresh policy. The iframe +
 * postMessage handshake (PlayerIdentity) is runtime-verified; here we inject a
 * fake clock and a stub fetcher to exercise reuse, early refresh, guest TTL, and
 * concurrent-call dedup deterministically.
 */
describe('PlayTokenCache', () => {
    let nowMs: number;
    const now = (): number => nowMs;

    beforeEach(() => {
        nowMs = 1_000_000;
    });

    it('caches a live token and reuses it while fresh (single fetch)', async () => {
        const fetchToken = jest.fn(async (): Promise<PlayTokenResult> => ({
            token: 'tok-a',
            expiresAt: nowMs + 100_000,
        }));
        const cache = new PlayTokenCache(fetchToken, now);

        expect(await cache.getToken()).toBe('tok-a');
        // Advance, but stay outside the refresh buffer window.
        nowMs += 100_000 - PLAY_TOKEN_REFRESH_BUFFER_MS - 1_000;
        expect(await cache.getToken()).toBe('tok-a');
        expect(fetchToken).toHaveBeenCalledTimes(1);
    });

    it('refreshes a live token once within the refresh buffer of expiry', async () => {
        const fetchToken = jest.fn()
            .mockResolvedValueOnce({ token: 'tok-a', expiresAt: nowMs + 100_000 })
            .mockResolvedValueOnce({ token: 'tok-b', expiresAt: nowMs + 200_000 });
        const cache = new PlayTokenCache(fetchToken as () => Promise<PlayTokenResult>, now);

        expect(await cache.getToken()).toBe('tok-a');
        // Cross into the buffer window: now >= expiresAt - buffer.
        nowMs += 100_000 - PLAY_TOKEN_REFRESH_BUFFER_MS + 1;
        expect(await cache.getToken()).toBe('tok-b');
        expect(fetchToken).toHaveBeenCalledTimes(2);
    });

    it('caches a guest result for the guest TTL, then re-asks', async () => {
        const fetchToken = jest.fn()
            .mockResolvedValueOnce({ token: null, expiresAt: null })
            .mockResolvedValueOnce({ token: 'tok-signed-in', expiresAt: nowMs + 100_000 });
        const cache = new PlayTokenCache(fetchToken as () => Promise<PlayTokenResult>, now);

        expect(await cache.getToken()).toBeNull();
        // Still within the guest TTL → no re-fetch.
        nowMs += PLAY_TOKEN_GUEST_TTL_MS - 1;
        expect(await cache.getToken()).toBeNull();
        expect(fetchToken).toHaveBeenCalledTimes(1);
        // Past the guest TTL → re-ask (player may have signed in).
        nowMs += 2;
        expect(await cache.getToken()).toBe('tok-signed-in');
        expect(fetchToken).toHaveBeenCalledTimes(2);
    });

    it('degrades a thrown fetch to a cached guest result', async () => {
        const fetchToken = jest.fn(async (): Promise<PlayTokenResult> => { throw new Error('network'); });
        const cache = new PlayTokenCache(fetchToken, now);

        expect(await cache.getToken()).toBeNull();
        // Cached as guest — no repeat fetch within the guest TTL.
        nowMs += PLAY_TOKEN_GUEST_TTL_MS - 1;
        expect(await cache.getToken()).toBeNull();
        expect(fetchToken).toHaveBeenCalledTimes(1);
    });

    it('treats a live token with no expiry as short-lived (guest TTL)', async () => {
        const fetchToken = jest.fn()
            .mockResolvedValueOnce({ token: 'tok-a', expiresAt: null })
            .mockResolvedValueOnce({ token: 'tok-b', expiresAt: nowMs + 100_000 });
        const cache = new PlayTokenCache(fetchToken as () => Promise<PlayTokenResult>, now);

        expect(await cache.getToken()).toBe('tok-a');
        nowMs += PLAY_TOKEN_GUEST_TTL_MS + 1;
        expect(await cache.getToken()).toBe('tok-b');
        expect(fetchToken).toHaveBeenCalledTimes(2);
    });

    it('collapses concurrent getToken() calls onto one fetch', async () => {
        let resolveFetch: (r: PlayTokenResult) => void = () => {};
        const fetchToken = jest.fn(() => new Promise<PlayTokenResult>((res) => { resolveFetch = res; }));
        const cache = new PlayTokenCache(fetchToken, now);

        const a = cache.getToken();
        const b = cache.getToken();
        resolveFetch({ token: 'tok-a', expiresAt: nowMs + 100_000 });
        expect(await a).toBe('tok-a');
        expect(await b).toBe('tok-a');
        expect(fetchToken).toHaveBeenCalledTimes(1);
    });

    it('invalidate() forces the next getToken() to re-fetch', async () => {
        const fetchToken = jest.fn()
            .mockResolvedValueOnce({ token: 'tok-a', expiresAt: nowMs + 100_000 })
            .mockResolvedValueOnce({ token: 'tok-b', expiresAt: nowMs + 100_000 });
        const cache = new PlayTokenCache(fetchToken as () => Promise<PlayTokenResult>, now);

        expect(await cache.getToken()).toBe('tok-a');
        cache.invalidate();
        expect(await cache.getToken()).toBe('tok-b');
        expect(fetchToken).toHaveBeenCalledTimes(2);
    });
});
