/**
 * PlayerIdentity — the engine-side handshake client for scoped play tokens
 * (umbrella P6, design spec §5).
 *
 * Published games run as UGC on per-game origins and must never bundle
 * auth0-spa-js. Instead, the game page embeds a hidden portal-origin iframe
 * (`PLAY_AUTH_URL`, e.g. `bitmagic.ai/play-auth.html`) that holds the first-party
 * portal Auth0 session. The engine postMessages `BM_PLAY_TOKEN_REQUEST`; the
 * bridge validates the EMBEDDER ORIGIN, derives the gameId from it, mints a
 * scoped play token, and answers `BM_PLAY_TOKEN_RESPONSE` — or `token:null` for
 * guests. See `portal/src/play-auth.ts` for the responder half.
 *
 * This module splits into two layers so the cache/expiry policy is unit-testable
 * without a DOM:
 *   - `PlayTokenCache` — PURE token-cache + refresh-decision logic (injected
 *     clock + fetcher; no `window`, `document`, or `postMessage`).
 *   - `PlayerIdentity` — the DOM wiring (embeds the iframe, generates request
 *     ids, resolves matching responses, times out to guest). Runtime-verified.
 *
 * Contract: `getPlayerToken()` NEVER rejects and NEVER blocks game start. Any
 * failure — no play-auth origin configured (local dev), timeout, malformed
 * response, thrown error — resolves to `null` (guest).
 */

import { PLAY_AUTH_URL } from 'engine/config.js';

/** The token bridge answers with a token (or null for guests) plus its expiry. */
export interface PlayTokenResult {
    token: string | null;
    /** Epoch ms when the token expires, or null when unknown / for guests. */
    expiresAt: number | null;
}

/** Refresh a live token this many ms before it actually expires. */
export const PLAY_TOKEN_REFRESH_BUFFER_MS = 60_000;

/**
 * How long a guest result (token:null, or a token missing an expiry) stays
 * cached before we re-ask the bridge. Keeps a guest game from hammering the
 * handshake while still recovering if the player signs in mid-session.
 */
export const PLAY_TOKEN_GUEST_TTL_MS = 30_000;

/**
 * PURE token cache. Holds the last handshake result and decides when to re-fetch:
 * a live token is reused until it is within `PLAY_TOKEN_REFRESH_BUFFER_MS` of
 * expiry; a guest result is reused for `PLAY_TOKEN_GUEST_TTL_MS`. Concurrent
 * callers collapse onto a single in-flight fetch.
 *
 * All I/O and time are injected, so the refresh policy can be exercised with a
 * fake clock and a stub fetcher — no iframe or `postMessage`.
 */
export class PlayTokenCache {
    private cached: PlayTokenResult | null = null;
    private inflight: Promise<string | null> | null = null;

    constructor(
        private readonly fetchToken: () => Promise<PlayTokenResult>,
        private readonly now: () => number = () => Date.now(),
    ) {}

    private isFresh(): boolean {
        if (!this.cached || this.cached.expiresAt === null) return false;
        // A live token refreshes early (buffer); a guest entry is valid up to its
        // synthetic TTL expiry, so no buffer is subtracted for it.
        const buffer = this.cached.token ? PLAY_TOKEN_REFRESH_BUFFER_MS : 0;
        return this.now() < this.cached.expiresAt - buffer;
    }

    /**
     * Resolve the current play token, or null for a guest. Reuses the cached
     * result while fresh; otherwise performs (and dedups) a single fetch. Never
     * rejects — a thrown fetcher degrades to a cached guest result.
     */
    async getToken(): Promise<string | null> {
        if (this.isFresh()) return this.cached!.token;
        if (this.inflight) return this.inflight;

        const p = (async (): Promise<string | null> => {
            try {
                this.cached = normalizeResult(await this.fetchToken(), this.now());
            } catch {
                this.cached = { token: null, expiresAt: this.now() + PLAY_TOKEN_GUEST_TTL_MS };
            } finally {
                this.inflight = null;
            }
            return this.cached.token;
        })();
        this.inflight = p;
        return p;
    }

    /** Drop the cached result so the next getToken() re-runs the handshake. */
    invalidate(): void {
        this.cached = null;
        this.inflight = null;
    }
}

/**
 * Coerce a raw handshake result into a cache entry with a concrete expiry. A
 * real token keeps its reported expiry (or a short TTL if the bridge omitted
 * one); anything else becomes a guest entry valid for the guest TTL.
 */
function normalizeResult(result: PlayTokenResult, nowMs: number): PlayTokenResult {
    if (typeof result.token === 'string' && result.token !== '') {
        return {
            token: result.token,
            expiresAt: typeof result.expiresAt === 'number'
                ? result.expiresAt
                : nowMs + PLAY_TOKEN_GUEST_TTL_MS,
        };
    }
    return { token: null, expiresAt: nowMs + PLAY_TOKEN_GUEST_TTL_MS };
}

// ════════════════════════════════════════════════════════════════════════════
// DOM wiring (runtime-verified; not unit-tested)
// ════════════════════════════════════════════════════════════════════════════

interface TokenResponse {
    type: 'BM_PLAY_TOKEN_RESPONSE';
    requestId: string;
    token?: unknown;
    expiresAt?: unknown;
}

/** Wait at most this long for the hidden iframe to load before giving up (guest). */
const IFRAME_LOAD_TIMEOUT_MS = 8_000;
/** Wait at most this long for a token response after posting the request (guest). */
const HANDSHAKE_TIMEOUT_MS = 8_000;

function isTokenResponse(data: unknown): data is TokenResponse {
    return (
        typeof data === 'object' && data !== null &&
        (data as { type?: unknown }).type === 'BM_PLAY_TOKEN_RESPONSE' &&
        typeof (data as { requestId?: unknown }).requestId === 'string'
    );
}

function newRequestId(): string {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    return `bm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * DOM handshake client. Lazily embeds the hidden play-auth iframe on first token
 * request and reuses it for refreshes. Delegates all cache/expiry decisions to
 * `PlayTokenCache`; this layer only performs one request/response round-trip per
 * cache miss.
 */
export class PlayerIdentity {
    private readonly cache: PlayTokenCache;
    private iframe: HTMLIFrameElement | null = null;
    /** Set by the iframe's load event whenever it fires — even after a timeout. */
    private iframeWindow: Window | null = null;
    private iframeReady: Promise<Window | null> | null = null;
    private readonly authOrigin: string | null;
    private readonly pending = new Map<string, (result: PlayTokenResult) => void>();
    private messageListenerBound = false;

    constructor(private readonly playAuthUrl: string = PLAY_AUTH_URL) {
        this.authOrigin = deriveOrigin(playAuthUrl);
        this.cache = new PlayTokenCache(() => this.requestTokenViaIframe());
    }

    /**
     * The origin to postMessage the bridge at, or null when there is no bridge to
     * reach (no play-auth URL — local dev — or no DOM to embed it in). Every
     * caller must treat null as "stay a guest, never embed an iframe".
     */
    private bridgeOrigin(): string | null {
        if (!this.playAuthUrl || typeof document === 'undefined') return null;
        return this.authOrigin;
    }

    /**
     * Resolve the current play token, or null for a guest. Safe to call from
     * game start and on every heartbeat/unlock — cheap while the cache is fresh.
     */
    getPlayerToken(): Promise<string | null> {
        if (!this.bridgeOrigin()) return Promise.resolve(null);
        return this.cache.getToken();
    }

    /**
     * Tell the portal bridge that a GUEST just unlocked an achievement, so it can
     * report it against the browser session id (which lives on the portal origin
     * and is unreadable from here). Fire-and-forget; the bridge itself skips
     * signed-in players, whose unlocks are posted directly with a play token.
     */
    reportGuestUnlock(achievementId: string): void {
        const origin = this.bridgeOrigin();
        if (!origin) return;
        void this.ensureIframe().then((target) => {
            try {
                target?.postMessage({ type: 'BM_ACHIEVEMENT_UNLOCKED', achievementId }, origin);
            } catch {
                // Bridge unavailable — the unlock still toasted locally.
            }
        });
    }

    /**
     * Relay a GUEST play-session heartbeat to the portal bridge, which owns the
     * anonymous session on this game's behalf: the anon lane is keyed on the
     * browser session id (portal-origin storage, unreadable from here) and sits
     * behind an API token a published bundle cannot carry. Fire-and-forget; the
     * bridge skips signed-in players, whose game heartbeats directly with a play
     * token. `visibleMs` is the play's running visible total — the bridge keeps
     * it consistent across session restarts, so this side needs no session state.
     */
    sendGuestHeartbeat(beat: { visible: boolean; active: boolean; visibleMs: number }): void {
        const origin = this.bridgeOrigin();
        if (!origin) return;
        void this.ensureIframe().then((target) => {
            try {
                target?.postMessage({ type: 'BM_GUEST_HEARTBEAT', ...beat }, origin);
            } catch {
                // Bridge unavailable — the next tick tries again.
            }
        });
    }

    /** Remove the hidden iframe and listener. Idempotent. */
    dispose(): void {
        if (this.messageListenerBound && typeof window !== 'undefined') {
            window.removeEventListener('message', this.onMessage);
            this.messageListenerBound = false;
        }
        this.pending.clear();
        if (this.iframe && this.iframe.parentNode) {
            this.iframe.parentNode.removeChild(this.iframe);
        }
        this.iframe = null;
        this.iframeWindow = null;
        this.iframeReady = null;
        this.cache.invalidate();
    }

    private onMessage = (event: MessageEvent): void => {
        // Only trust responses from the bridge origin and iframe window.
        if (event.origin !== this.authOrigin) return;
        if (this.iframe && event.source !== this.iframe.contentWindow) return;
        if (!isTokenResponse(event.data)) return;
        const resolve = this.pending.get(event.data.requestId);
        if (!resolve) return;
        this.pending.delete(event.data.requestId);
        const token = typeof event.data.token === 'string' ? event.data.token : null;
        const expiresAt = typeof event.data.expiresAt === 'number' ? event.data.expiresAt : null;
        resolve({ token, expiresAt });
    };

    private ensureIframe(): Promise<Window | null> {
        if (this.iframeWindow) return Promise.resolve(this.iframeWindow);
        if (this.iframeReady) return this.iframeReady;

        if (!this.iframe) {
            if (!this.messageListenerBound) {
                window.addEventListener('message', this.onMessage);
                this.messageListenerBound = true;
            }
            const iframe = document.createElement('iframe');
            iframe.setAttribute('aria-hidden', 'true');
            iframe.setAttribute('title', 'play-auth');
            iframe.style.display = 'none';
            iframe.src = this.playAuthUrl;
            // The persistent load listener captures the window even when it
            // arrives after this attempt's timeout below, so a slow first load
            // does NOT latch the player as a guest — the guest-TTL re-ask picks
            // the window up on its next round-trip.
            iframe.addEventListener('load', () => {
                this.iframeWindow = iframe.contentWindow;
            });
            this.iframe = iframe;
            document.body.appendChild(iframe);
        }

        this.iframeReady = new Promise<Window | null>((resolve) => {
            const iframe = this.iframe!;
            let settled = false;
            const settle = (win: Window | null): void => {
                if (settled) return;
                settled = true;
                iframe.removeEventListener('load', onLoad);
                clearTimeout(loadTimer);
                // Un-latch: the next request re-checks iframeWindow / waits again.
                this.iframeReady = null;
                resolve(win);
            };
            const onLoad = (): void => settle(iframe.contentWindow);
            const loadTimer = setTimeout(() => settle(null), IFRAME_LOAD_TIMEOUT_MS);
            iframe.addEventListener('load', onLoad);
        });
        return this.iframeReady;
    }

    private async requestTokenViaIframe(): Promise<PlayTokenResult> {
        const target = await this.ensureIframe();
        if (!target || !this.authOrigin) return { token: null, expiresAt: null };

        const requestId = newRequestId();
        return new Promise<PlayTokenResult>((resolve) => {
            const finish = (result: PlayTokenResult): void => {
                clearTimeout(timer);
                this.pending.delete(requestId);
                resolve(result);
            };
            const timer = setTimeout(() => finish({ token: null, expiresAt: null }), HANDSHAKE_TIMEOUT_MS);
            this.pending.set(requestId, finish);
            try {
                target.postMessage({ type: 'BM_PLAY_TOKEN_REQUEST', requestId }, this.authOrigin!);
            } catch {
                finish({ token: null, expiresAt: null });
            }
        });
    }
}

function deriveOrigin(url: string): string | null {
    if (!url) return null;
    try {
        return new URL(url).origin;
    } catch {
        return null;
    }
}

// Module-level singleton so every engine subsystem (play heartbeats, achievement
// unlocks) shares one iframe + one token cache, mirroring the design's "one
// handshake client per game page" model.
let _identity: PlayerIdentity | null = null;

/** The shared PlayerIdentity for this game page (lazily constructed). */
export function getPlayerIdentity(): PlayerIdentity {
    if (!_identity) _identity = new PlayerIdentity();
    return _identity;
}
