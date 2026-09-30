/**
 * Message handlers that proxy creator dialog requests for the Game Data Service
 * to its admin REST API. The creator embeds an Auth0 Bearer token in each
 * postMessage payload — the iframe forwards it as `Authorization: Bearer <token>`
 * so the iframe doesn't need its own Auth0 SDK.
 *
 * Mirrors the spec admin endpoints under `/v1/{gameId}/admin/...`.
 */

import { GAME_DATA_SERVICE_URL } from 'engine/config.js';

export interface GameDataCategorySummary {
    name: string;
    config: Record<string, unknown>;
    entries: Array<{
        id: string;
        values: Record<string, string | number>;
        data?: Record<string, unknown>;
        meta: { revision: number; createdAt: string; updatedAt: string; expireAt: string | null };
        hasSecret?: boolean;
    }>;
    /** Set when a per-category fetch failed; entries will be empty in that case. */
    error?: string;
}

interface AdminListResponse<T> {
    entries?: T[];
    categories?: T[];
    nextCursor?: string | null;
}

export interface ResetCategoryResult {
    jobId: string;
    totalEstimate: number | null;
}

export interface UsageReport {
    usedBytes: number;
    quotaBytes: number;
    categoryCount: number;
    entryCount: number;
}

const ENTRY_PREVIEW_LIMIT = 200;

async function adminFetch(
    adminToken: string,
    path: string,
    init?: { method?: string; body?: string },
): Promise<Response> {
    const headers: Record<string, string> = { Authorization: `Bearer ${adminToken}` };
    if (init?.body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(`${GAME_DATA_SERVICE_URL}/v1${path}`, {
        method: init?.method ?? 'GET',
        headers,
        body: init?.body,
    });
}

async function formatError(response: Response, label: string): Promise<string> {
    const text = await response.text();
    return `${label} (${response.status}): ${text || response.statusText}`;
}

async function ensureOk(response: Response, label: string): Promise<void> {
    if (!response.ok) throw new Error(await formatError(response, label));
}

function requireAdminToken(adminToken: string): void {
    if (!adminToken) throw new Error('admin token required');
}

/**
 * Idempotently bootstraps the game's registry doc so subsequent admin calls
 * pass `requireGameAdmin`. The dashboard hits this on every dialog open; the
 * server returns 200 if already owned and only writes on the first call.
 * Throws if the caller isn't allowed to admin this game.
 */
export async function ensureGameRegistered(gameId: string, adminToken: string): Promise<void> {
    requireAdminToken(adminToken);
    const response = await adminFetch(
        adminToken,
        `/games/${encodeURIComponent(gameId)}/register`,
        { method: 'POST', body: JSON.stringify({}) },
    );
    await ensureOk(response, 'game registration failed');
}

export async function fetchGameDataCategoriesForDialog(
    gameId: string,
    adminToken: string,
): Promise<GameDataCategorySummary[]> {
    requireAdminToken(adminToken);
    await ensureGameRegistered(gameId, adminToken);
    const listResponse = await adminFetch(adminToken, `/${encodeURIComponent(gameId)}/admin/categories`);
    await ensureOk(listResponse, 'categories list failed');
    const listJson = (await listResponse.json()) as { categories?: Array<{ name: string } & Record<string, unknown>> };
    const categories = listJson.categories ?? [];

    return Promise.all(categories.map(async (cfg): Promise<GameDataCategorySummary> => {
        const entriesResponse = await adminFetch(
            adminToken,
            `/${encodeURIComponent(gameId)}/admin/userdata/${encodeURIComponent(cfg.name)}?limit=${ENTRY_PREVIEW_LIMIT}&includeSecretMetadata=true`,
        );
        if (!entriesResponse.ok) {
            return {
                name: cfg.name,
                config: cfg,
                entries: [],
                error: await formatError(entriesResponse, 'entries fetch failed'),
            };
        }
        const body = (await entriesResponse.json()) as AdminListResponse<GameDataCategorySummary['entries'][number]>;
        return { name: cfg.name, config: cfg, entries: body.entries ?? [] };
    }));
}

export async function fetchGameDataUsage(
    gameId: string,
    adminToken: string,
): Promise<UsageReport> {
    requireAdminToken(adminToken);
    // Same race-avoidance as fetchGameDataCategoriesForDialog: ensure the
    // games/{gameId} registry doc exists so requireGameAdmin doesn't 404.
    // Idempotent — no-op once registered.
    await ensureGameRegistered(gameId, adminToken);
    const response = await adminFetch(adminToken, `/${encodeURIComponent(gameId)}/admin/usage`);
    await ensureOk(response, 'usage fetch failed');
    return (await response.json()) as UsageReport;
}

export async function resetGameDataCategory(
    gameId: string,
    adminToken: string,
    category: string,
): Promise<ResetCategoryResult> {
    requireAdminToken(adminToken);
    const response = await adminFetch(
        adminToken,
        `/${encodeURIComponent(gameId)}/admin/userdata/${encodeURIComponent(category)}/reset`,
        { method: 'POST', body: JSON.stringify({ confirm: category }) },
    );
    await ensureOk(response, 'reset failed');
    return (await response.json()) as ResetCategoryResult;
}

export async function deleteGameDataEntry(
    gameId: string,
    adminToken: string,
    category: string,
    entryId: string,
): Promise<void> {
    requireAdminToken(adminToken);
    const response = await adminFetch(
        adminToken,
        `/${encodeURIComponent(gameId)}/admin/userdata/${encodeURIComponent(category)}/${encodeURIComponent(entryId)}`,
        { method: 'DELETE', body: JSON.stringify({}) },
    );
    await ensureOk(response, 'delete failed');
}
