/**
 * LocalAccountTransport — the local player's "account" on localhost.
 *
 * Implements the same four calls CloudSaveClient makes against api-server
 * (/api/play/saves), over localStorage, with the same answers: a verbatim
 * envelope per slot, last-write-wins on `savedAt`, tombstones for deletes,
 * `stale` when an older write arrives, 413 over the size cap. CloudSaveSync
 * cannot tell the two apart, which is the point: on localhost the whole sync
 * system — binding, journal, pulls, forks, backups — runs for real against
 * this store, so it can be tested without a server or an account.
 *
 * Rows live at `bm-local-account-<gameId>:<slot>`; "reset the local player"
 * (LocalPlayer.ts) removes them along with everything else.
 */

import type { CloudSaveTransport } from 'engine/persistence/CloudSaveSync.js';
import type { CloudWriteResult, ServerSave, ServerSaveIndex } from 'engine/persistence/CloudSaveClient.js';

/** The subset of the DOM `Storage` interface the local-player helpers use (injectable for tests). */
export interface StorageLike {
    readonly length: number;
    key(index: number): string | null;
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

export const LOCAL_ACCOUNT_KEY_PREFIX = 'bm-local-account-';

/** Mirrors api-server's MAX_PAYLOAD_BYTES so an oversize save shows up locally too. */
export const LOCAL_ACCOUNT_MAX_PAYLOAD_BYTES = 256 * 1024;

interface LocalAccountRow {
    savedAt: number;
    version: number;
    /** Verbatim envelope; null for a tombstone. */
    payload: string | null;
    deleted: boolean;
}

function isRow(value: unknown): value is LocalAccountRow {
    if (!value || typeof value !== 'object') return false;
    const r = value as Record<string, unknown>;
    return typeof r.savedAt === 'number' && typeof r.version === 'number'
        && (typeof r.payload === 'string' || r.payload === null) && typeof r.deleted === 'boolean';
}

function byteLength(value: string): number {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).length;
    return value.length * 2;
}

export class LocalAccountTransport implements CloudSaveTransport {
    private readonly prefix: string;

    constructor(
        gameId: string,
        private readonly accountKey: string,
        /** null when localStorage is unavailable — every call then answers like an empty, unwritable store. */
        private readonly storage: StorageLike | null,
        private readonly now: () => number,
    ) {
        this.prefix = `${LOCAL_ACCOUNT_KEY_PREFIX}${gameId}:`;
    }

    private key(slot: string): string {
        return this.prefix + slot;
    }

    private read(slot: string): LocalAccountRow | null {
        if (!this.storage) return null;
        try {
            const raw = this.storage.getItem(this.key(slot));
            if (raw === null) return null;
            const parsed: unknown = JSON.parse(raw);
            return isRow(parsed) ? parsed : null;
        } catch {
            return null;
        }
    }

    private write(slot: string, row: LocalAccountRow): boolean {
        if (!this.storage) return false;
        try {
            this.storage.setItem(this.key(slot), JSON.stringify(row));
            return true;
        } catch {
            return false;
        }
    }

    private result(status: number, extra: Partial<CloudWriteResult> = {}): CloudWriteResult {
        return { status, stale: false, serverSavedAt: null, serverNow: this.now(), retryAfterSeconds: null, ...extra };
    }

    async list(): Promise<ServerSaveIndex | null> {
        const saves: ServerSaveIndex['saves'] = [];
        if (!this.storage) return { serverNow: this.now(), accountKey: this.accountKey, saves };
        try {
            for (let i = 0; i < this.storage.length; i++) {
                const key = this.storage.key(i);
                if (key === null || !key.startsWith(this.prefix)) continue;
                const slot = key.slice(this.prefix.length);
                const row = this.read(slot);
                if (!row) continue;
                saves.push({ slot, savedAt: row.savedAt, version: row.version, deleted: row.deleted, size: row.payload ? byteLength(row.payload) : 0 });
            }
        } catch {
            return null;
        }
        saves.sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));
        return { serverNow: this.now(), accountKey: this.accountKey, saves };
    }

    async get(_token: string, slot: string): Promise<ServerSave | 'missing' | null> {
        const row = this.read(slot);
        if (!row) return 'missing';
        return { slot, savedAt: row.savedAt, version: row.version, deleted: row.deleted, payload: row.payload };
    }

    async put(_token: string, slot: string, body: { savedAt: number; version: number; payload: string }): Promise<CloudWriteResult | null> {
        if (byteLength(body.payload) > LOCAL_ACCOUNT_MAX_PAYLOAD_BYTES) return this.result(413);
        const existing = this.read(slot);
        if (existing && existing.savedAt > body.savedAt) {
            return this.result(200, { stale: true, serverSavedAt: existing.savedAt });
        }
        if (!this.write(slot, { savedAt: body.savedAt, version: body.version, payload: body.payload, deleted: false })) return null;
        return this.result(200, { serverSavedAt: body.savedAt });
    }

    async del(_token: string, slot: string, deletedAt: number): Promise<CloudWriteResult | null> {
        const existing = this.read(slot);
        if (existing && existing.savedAt > deletedAt) {
            return this.result(200, { stale: true, serverSavedAt: existing.savedAt });
        }
        if (!this.write(slot, { savedAt: deletedAt, version: existing?.version ?? 1, payload: null, deleted: true })) return null;
        return this.result(200, { serverSavedAt: deletedAt });
    }
}
