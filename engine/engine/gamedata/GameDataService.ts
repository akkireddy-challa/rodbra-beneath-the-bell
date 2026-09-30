/**
 * GameDataService — HTTP client for the Bitmagic Game Data Service.
 *
 * Templates call this for arbitrary per-game persistence (leaderboards, custom
 * levels, shared state). Distinct from `GamePersistence`, which is per-player
 * localStorage save data.
 *
 * Read methods (`get`, `list`, `rank`) are public — no auth required.
 * Write methods (`create`, `update`, `delete`) lazily fetch and reuse a session
 * JWT minted by `POST /v1/session/token`. The token survives for 1h; we refresh
 * it transparently when it's near expiration.
 *
 * Categories are auto-created server-side on first write with safe defaults
 * (immutable, no secret required, no TTL). Admins can reconfigure later via
 * the dashboard.
 */

import { GAME_DATA_SERVICE_URL } from 'engine/config.js';
import {
    GameDataError,
    type CreatedEntry,
    type CreateEntryInput,
    type DeleteInput,
    type EntryView,
    type ListEntriesInput,
    type ListResult,
    type RankInput,
    type RankResult,
    type RunUploadTarget,
    type SessionTokenResponse,
    type UpdateEntryInput,
    type WhereFilter,
} from 'engine/gamedata/types.js';

export interface GameDataServiceOptions {
    /** Base URL of the service (without `/v1`). */
    baseUrl: string;
    /** Refresh the cached session token this many ms before its `expiresAt`. */
    sessionTokenTTLBufferMs: number;
    /** Default page size when `list()` is called without an explicit limit. */
    defaultListLimit: number;
}

export const DEFAULT_GAME_DATA_SERVICE_OPTIONS: GameDataServiceOptions = {
    baseUrl: '',
    sessionTokenTTLBufferMs: 5 * 60 * 1000,
    defaultListLimit: 50,
};

interface CachedToken {
    token: string;
    expiresAt: number;
}

export class GameDataService {
    private static instance: GameDataService | null = null;
    private options: GameDataServiceOptions;
    private gameId: string = '';
    private cachedToken: CachedToken | null = null;
    private inflightTokenFetch: Promise<CachedToken> | null = null;

    private constructor() {
        this.options = { ...DEFAULT_GAME_DATA_SERVICE_OPTIONS, baseUrl: GAME_DATA_SERVICE_URL };
    }

    static getInstance(): GameDataService {
        if (!GameDataService.instance) {
            GameDataService.instance = new GameDataService();
        }
        return GameDataService.instance;
    }

    /** Apply runtime configuration. Called by GameEngine during game load. */
    configure(options: GameDataServiceOptions, gameId: string): void {
        this.options = options;
        if (gameId !== this.gameId) {
            // gameId change invalidates any cached token (token has gameId claim).
            this.cachedToken = null;
            this.inflightTokenFetch = null;
        }
        this.gameId = gameId;
    }

    /** Drop any cached session token; the next write will mint a fresh one. */
    invalidateSessionToken(): void {
        this.cachedToken = null;
        this.inflightTokenFetch = null;
    }

    async create(category: string, input: CreateEntryInput): Promise<CreatedEntry> {
        return this.request<CreatedEntry>('POST', entryPath(category), {
            body: {
                data: input.data,
                values: input.values,
                withSecret: input.withSecret,
                playerId: input.playerId,
                verifier: input.verifier,
            },
            withSession: true,
        });
    }

    async updateEntry(category: string, id: string, input: UpdateEntryInput): Promise<EntryView> {
        return this.request<EntryView>('POST', entryPath(category, id), {
            body: { data: input.data, values: input.values, secret: input.secret },
            withSession: true,
        });
    }

    async delete(category: string, id: string, input: DeleteInput = {}): Promise<void> {
        await this.request<void>('DELETE', entryPath(category, id), {
            body: { secret: input.secret },
            withSession: true,
            expectEmpty: true,
        });
    }

    async get(category: string, id: string): Promise<EntryView> {
        return this.request<EntryView>('GET', entryPath(category, id), { withSession: false });
    }

    async list(category: string, input: ListEntriesInput = {}): Promise<ListResult> {
        const params = new URLSearchParams();
        const limit = input.limit ?? this.options.defaultListLimit;
        params.set('limit', String(limit));
        if (input.orderBy) params.set('orderBy', input.orderBy);
        if (input.orderDir) params.set('orderDir', input.orderDir);
        if (input.cursor) params.set('cursor', input.cursor);
        if (input.fields) params.set('fields', input.fields);
        if (input.where && input.where.length > 0) params.set('where', encodeWhere(input.where));
        const query = params.toString();
        const path = `${entryPath(category)}${query ? `?${query}` : ''}`;
        return this.request<ListResult>('GET', path, { withSession: false });
    }

    async rank(category: string, input: RankInput): Promise<RankResult> {
        const params = new URLSearchParams({
            field: input.field,
            value: String(input.value),
        });
        if (input.direction) params.set('direction', input.direction);
        const path = `${entryPath(category, 'rank')}?${params.toString()}`;
        return this.request<RankResult>('GET', path, { withSession: false });
    }

    /**
     * Mint a signed upload for a replay run.
     *
     * A run is the one payload that does not fit the entry model — 12–43 KB per
     * lap against a 1 MB per-game budget — so its bytes go to object storage
     * and the entry keeps the returned `publicUrl`. Uploading is a write, so it
     * carries the session token and counts against the write rate limits.
     *
     * Rejects with `storage_unavailable` on a deployment that has no bucket
     * (localhost, chiefly). That is not an error to report: the caller stores
     * the run inside the entry instead, which is what every run did before.
     */
    async createRunUploadUrl(category: string, sizeBytes: number): Promise<RunUploadTarget> {
        return this.request<RunUploadTarget>('POST', '/runs/upload-url', {
            body: { category, sizeBytes },
            withSession: true,
        });
    }

    private async request<T>(
        method: string,
        path: string,
        opts: { body?: Record<string, unknown>; withSession: boolean; expectEmpty?: boolean },
    ): Promise<T> {
        if (!this.gameId) {
            throw new GameDataError(0, 'not_configured', 'GameDataService used before configure()', null);
        }
        const url = `${this.options.baseUrl}/v1/${encodeURIComponent(this.gameId)}${path}`;
        const headers: Record<string, string> = {};
        if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
        if (opts.withSession) {
            const token = await this.getSessionToken();
            headers['Authorization'] = `Session ${token.token}`;
        }

        const init: RequestInit = { method, headers };
        // `undefined` fields drop out of JSON.stringify, so an option the caller
        // omitted is simply absent from the body rather than sent as null — which
        // is what the server needs to tell "not supplied" from "supplied empty".
        if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

        const response = await fetch(url, init);
        if (response.status === 401 && opts.withSession) {
            // Token may have been rotated server-side. Drop it so the NEXT
            // write mints a fresh one; this call still fails, and the caller
            // decides whether the write is worth retrying.
            this.invalidateSessionToken();
        }
        if (!response.ok) {
            await throwFromResponse(response);
        }
        if (opts.expectEmpty || response.status === 204) {
            return undefined as T;
        }
        return (await response.json()) as T;
    }

    private async getSessionToken(): Promise<CachedToken> {
        const now = Date.now();
        if (this.cachedToken && now < this.cachedToken.expiresAt - this.options.sessionTokenTTLBufferMs) {
            return this.cachedToken;
        }
        // Concurrent writes share one mint; only the caller that started it
        // clears the slot, so the others simply await the same promise.
        if (this.inflightTokenFetch) {
            return this.inflightTokenFetch;
        }
        this.inflightTokenFetch = this.mintSessionToken();
        try {
            return await this.inflightTokenFetch;
        } finally {
            this.inflightTokenFetch = null;
        }
    }

    private async mintSessionToken(): Promise<CachedToken> {
        const response = await fetch(`${this.options.baseUrl}/v1/session/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ gameId: this.gameId }),
        });
        if (!response.ok) {
            await throwFromResponse(response);
        }
        const issued = (await response.json()) as SessionTokenResponse;
        this.cachedToken = { token: issued.token, expiresAt: issued.expiresAt };
        return this.cachedToken;
    }
}

/** Path to a category's entry collection, or to one entry inside it. */
function entryPath(category: string, id?: string): string {
    const base = `/userdata/${encodeURIComponent(category)}`;
    return id === undefined ? base : `${base}/${encodeURIComponent(id)}`;
}

function encodeWhere(filters: WhereFilter[]): string {
    return filters.map((f) => `${f.field}:${f.op}:${f.value}`).join(',');
}

async function throwFromResponse(response: Response): Promise<never> {
    let code = `http_${response.status}`;
    let message = response.statusText || 'request failed';
    let requestId: string | null = response.headers.get('X-Request-Id');
    try {
        const body = await response.json() as { error?: string; message?: string; requestId?: string };
        if (typeof body.error === 'string') code = body.error;
        if (typeof body.message === 'string') message = body.message;
        if (typeof body.requestId === 'string') requestId = body.requestId;
    } catch {
        // Body wasn't JSON — keep defaults.
    }
    throw new GameDataError(response.status, code, message, requestId);
}
