/**
 * CloudSaveClient — HTTP transport for the api-server /api/play/saves routes
 * (api-server/src/controllers/play-saves-controller.ts).
 *
 * Same credential shape as PlaySessionClient: the shared X-API-Token (ignored
 * on these exempt routes, sent for uniformity) plus the scoped play Bearer.
 * Every method resolves to null when the request throws; callers treat null
 * as "the cloud is unreachable right now" and carry on locally.
 *
 * The save payload travels as a JSON STRING FIELD, never re-serialized: the
 * engine stores the server's copy back into localStorage verbatim, and
 * JSON-encoding a string is lossless for any JS string.
 */

import { API_SERVER_BASE_URL, API_SERVER_TOKEN } from 'engine/config.js';

export interface ServerSaveIndexEntry {
    slot: string;
    /** Server-side (clock-corrected) epoch ms; for a tombstone, the deletion time. */
    savedAt: number;
    version: number;
    deleted: boolean;
    size: number;
}

export interface ServerSaveIndex {
    serverNow: number;
    /** Opaque per-account value — changes when a different account signs in. */
    accountKey: string;
    saves: ServerSaveIndexEntry[];
}

export interface ServerSave {
    slot: string;
    savedAt: number;
    version: number;
    deleted: boolean;
    /** The verbatim envelope JSON; null for a tombstone. */
    payload: string | null;
}

export interface CloudWriteResult {
    /** HTTP status — 2xx means the server answered, whatever it decided. */
    status: number;
    /** True when the server kept its own (newer) row instead of this write. */
    stale: boolean;
    serverSavedAt: number | null;
    serverNow: number | null;
    /** Present on 429. */
    retryAfterSeconds: number | null;
}

export interface CloudWriteOptions {
    /** Let the request outlive the page (pagehide flush). Bodies must stay under ~64KB. */
    keepalive: boolean;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

function num(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export class CloudSaveClient {
    constructor(
        private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
        private readonly baseUrl: string = API_SERVER_BASE_URL,
        private readonly apiToken: string = API_SERVER_TOKEN,
    ) {}

    private headers(token: string): Record<string, string> {
        return {
            'Content-Type': 'application/json',
            'X-API-Token': this.apiToken,
            Authorization: `Bearer ${token}`,
        };
    }

    private url(slot?: string): string {
        return slot === undefined
            ? `${this.baseUrl}/api/play/saves`
            : `${this.baseUrl}/api/play/saves/${encodeURIComponent(slot)}`;
    }

    /** The slot index, or null when unreachable / refused. */
    async list(token: string): Promise<ServerSaveIndex | null> {
        try {
            const res = await this.fetchImpl(this.url(), { method: 'GET', headers: this.headers(token) });
            if (!res.ok) return null;
            const body = await res.json() as { serverNow?: unknown; accountKey?: unknown; saves?: unknown };
            const serverNow = num(body.serverNow);
            if (serverNow === null || typeof body.accountKey !== 'string' || !Array.isArray(body.saves)) return null;
            const saves: ServerSaveIndexEntry[] = [];
            for (const raw of body.saves as Record<string, unknown>[]) {
                const savedAt = num(raw.savedAt);
                if (typeof raw.slot !== 'string' || savedAt === null) continue;
                saves.push({
                    slot: raw.slot,
                    savedAt,
                    version: num(raw.version) ?? 1,
                    deleted: raw.deleted === true,
                    size: num(raw.size) ?? 0,
                });
            }
            return { serverNow, accountKey: body.accountKey, saves };
        } catch {
            return null;
        }
    }

    /** One slot. `'missing'` when the server has no row; null when unreachable. */
    async get(token: string, slot: string): Promise<ServerSave | 'missing' | null> {
        try {
            const res = await this.fetchImpl(this.url(slot), { method: 'GET', headers: this.headers(token) });
            if (res.status === 404) return 'missing';
            if (!res.ok) return null;
            const body = await res.json() as { save?: Record<string, unknown> };
            const raw = body.save;
            if (!raw || typeof raw.slot !== 'string') return null;
            const savedAt = num(raw.savedAt);
            if (savedAt === null) return null;
            return {
                slot: raw.slot,
                savedAt,
                version: num(raw.version) ?? 1,
                deleted: raw.deleted === true,
                payload: typeof raw.payload === 'string' ? raw.payload : null,
            };
        } catch {
            return null;
        }
    }

    async put(
        token: string,
        slot: string,
        body: { savedAt: number; version: number; payload: string },
        options: CloudWriteOptions,
    ): Promise<CloudWriteResult | null> {
        return this.write('PUT', token, slot, body, options);
    }

    async del(token: string, slot: string, deletedAt: number, options: CloudWriteOptions): Promise<CloudWriteResult | null> {
        return this.write('DELETE', token, slot, { deletedAt }, options);
    }

    private async write(
        method: 'PUT' | 'DELETE',
        token: string,
        slot: string,
        body: Record<string, unknown>,
        options: CloudWriteOptions,
    ): Promise<CloudWriteResult | null> {
        try {
            const res = await this.fetchImpl(this.url(slot), {
                method,
                headers: this.headers(token),
                body: JSON.stringify(body),
                keepalive: options.keepalive,
            });
            const data = await res.json().catch(() => null) as Record<string, unknown> | null;
            return {
                status: res.status,
                stale: data?.stale === true,
                serverSavedAt: num(data?.serverSavedAt),
                serverNow: num(data?.serverNow),
                retryAfterSeconds: num(data?.retryAfterSeconds),
            };
        } catch {
            return null;
        }
    }
}
