/**
 * Wire-format types matching the Bitmagic Game Data Service v1 API.
 * Mirrors the shapes documented in `docs/game-data-service-spec.md`.
 */

export type ValuePrimitive = string | number;

export interface EntryMeta {
    revision: number;
    createdAt: string;
    updatedAt: string;
    expireAt: string | null;
}

export interface EntryView {
    id: string;
    /** Omitted by the server when the caller passed `fields=values`. */
    data?: Record<string, unknown>;
    values: Record<string, ValuePrimitive>;
    meta: EntryMeta;
    /** Only present on admin list responses with includeSecretMetadata=true. */
    hasSecret?: boolean;
    /**
     * Server-stamped owner. Trustworthy BECAUSE the client cannot set it — the
     * server writes it only after verifying the presented credential. Null for
     * anonymous writes.
     */
    createdByUid?: string | null;
}

export interface CreatedEntry extends EntryView {
    /**
     * Only returned on the initial create response when the category
     * is mutable AND the caller asked for (or the category requires) a secret.
     * The caller is responsible for persisting it — the server cannot return it again.
     */
    secret?: string;
}

export interface ListResult {
    entries: EntryView[];
    /** Opaque cursor for the next page; null when the list is exhausted. */
    nextCursor: string | null;
}

export interface RankResult {
    rank: number;
    total: number;
}

export interface CreateEntryInput {
    data: Record<string, unknown>;
    values: Record<string, ValuePrimitive>;
    /** Override the category's default secret behavior. */
    withSecret?: boolean;
    /**
     * Published owner of the entry. The server verifies it against `verifier`
     * and stamps it into `createdByUid`, so a client cannot claim to be someone
     * else. Omit both for an anonymous write.
     */
    playerId?: string;
    /**
     * Bearer credential proving `playerId`.
     *
     * 🚫 Sent with the request and NEVER stored in `data` or `values`. Reads on
     * this service are public, so a verifier written into an entry is a
     * verifier handed to every other player.
     */
    verifier?: string;
}

export interface UpdateEntryInput {
    /** Replaces the entire stored `data`; partial deep-merges are not supported in v1. */
    data?: Record<string, unknown>;
    values?: Record<string, ValuePrimitive>;
    /** Required when the category has `requireSecret: true`. */
    secret?: string;
}

export type WhereOp = 'eq' | 'gt' | 'gte' | 'lt' | 'lte';

export interface WhereFilter {
    /** e.g. "values.score" */
    field: string;
    op: WhereOp;
    value: string | number;
}

export interface ListEntriesInput {
    where?: WhereFilter[];
    /** e.g. "values.score" or "createdAt" (default). */
    orderBy?: string;
    orderDir?: 'asc' | 'desc';
    limit?: number;
    cursor?: string;
    /** "values" omits the `data` field server-side for cheaper top-N reads. */
    fields?: 'all' | 'values';
}

export interface RankInput {
    /** Field path under values, e.g. "values.score". */
    field: string;
    value: number;
    /** desc = higher is better (default). */
    direction?: 'asc' | 'desc';
}

export interface DeleteInput {
    secret?: string;
}

/**
 * Where to PUT a replay run, and where it will read back from.
 *
 * Runs live in object storage rather than inside their entry: a lap is 12–43 KB
 * and a game has 1 MB of entry storage in total, so a board that kept its runs
 * inline could hold a few dozen laps before it had to start forgetting times.
 * The entry stores `publicUrl`; the bytes never pass through the data service.
 */
export interface RunUploadTarget {
    /** Signed PUT. Send exactly `contentType` or the signature will not match. */
    uploadUrl: string;
    /** Public read URL — this is what goes in the leaderboard entry. */
    publicUrl: string;
    key: string;
    contentType: string;
    cacheControl: string;
    /** Seconds the signed URL stays valid. */
    expiresIn: number;
}

export interface SessionTokenResponse {
    token: string;
    /** Epoch milliseconds when the token expires. */
    expiresAt: number;
}

/**
 * Thrown by GameDataService when the backend returns an error envelope.
 * Mirrors the spec §4 shape: `{ error, message, requestId }`.
 */
export class GameDataError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string,
        readonly requestId: string | null,
    ) {
        super(message);
        this.name = 'GameDataError';
    }
}
