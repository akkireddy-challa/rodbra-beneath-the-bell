/**
 * Leaderboard storage for ghost runs.
 *
 * Two decisions here are forced by the game data service rather than chosen,
 * and both are load-bearing (design §2, §10):
 *
 * - **Per-level boards are separate CATEGORIES, not a `where` filter.**
 *   `where levelId == X` combined with `orderBy lapMs` is a Firestore composite
 *   index that is not declared anywhere, and `rank` accepts no filter at all,
 *   so a filtered board could not report placement. One category per level
 *   makes the sort single-field (auto-indexed) and makes `rank` correct for
 *   free, because the category IS the level.
 *
 * - **The board is append-only.** A game cannot make its own category mutable
 *   — auto-created categories are immutable and only an admin route can change
 *   that — so "one row per player" is achieved by submitting only personal
 *   bests and deduping by `playerId` at read time.
 */

import type { GameDataService } from 'engine/gamedata/GameDataService.js';
import { LEADERBOARD_MANIFEST_CATEGORY, publishLeaderboard } from 'engine/gamedata/LeaderboardManifest.js';
import type { EntryView } from 'engine/gamedata/types.js';
import { localBoardRows } from 'engine/replay/GhostLocalRuns.js';
import type { RunSource } from 'engine/replay/GhostRunStorage.js';

/** `CATEGORY_NAME_RE` on the server allows 32 chars of `[a-z0-9_-]`. */
const MAX_CATEGORY_LENGTH = 32;
const CATEGORY_PREFIX = 'ghosts-';

/** FNV-1a, matching GhostNames — every client must derive the same bucket. */
function hash32(text: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
}

/**
 * Category name for a level's board.
 *
 * Deterministic, because every client must compute the same bucket from the
 * same level id. Long or unsafe ids fall back to a hash rather than being
 * truncated — truncation would collide two levels whose ids share a prefix,
 * silently merging their boards.
 */
export function boardCategoryFor(levelId: string): string {
    const slug = levelId
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '');
    const candidate = `${CATEGORY_PREFIX}${slug}`;
    if (slug.length > 0 && candidate.length <= MAX_CATEGORY_LENGTH) return candidate;
    return `${CATEGORY_PREFIX}${hash32(levelId).toString(16).padStart(8, '0')}`;
}

/**
 * Category holding the board manifest the portal reads (design §11.1).
 *
 * Re-exported from `LeaderboardManifest`, which now owns publishing for every
 * kind of board — a ghost board is one shape of leaderboard, not its own
 * mechanism.
 */
export const BOARD_MANIFEST_CATEGORY = LEADERBOARD_MANIFEST_CATEGORY;

export interface BoardEntry {
    entryId: string;
    playerId: string;
    /** Name as submitted. The portal re-resolves it; this is the offline fallback. */
    name: string;
    timeMs: number;
    createdAt: string;
    /**
     * Vehicle the record was set with — an asset id or name.
     *
     * Stored WITH the run because which car set a time is part of the record:
     * a ghost replayed in the wrong kart misrepresents it, and players want to
     * know what beat them. Null for runs recorded before this was captured, or
     * for vehicles built without an asset.
     */
    assetId: string | null;
}

export interface SubmitRunInput {
    levelId: string;
    timeMs: number;
    name: string;
    playerId: string;
    verifier: string;
    /** Vehicle asset id or name the run was set with, when there is one. */
    assetId: string | null;
    /**
     * Where the run's bytes are.
     *
     * Normally a URL — `GhostRunStorage.uploadRun` has already put them in the
     * bucket — which is what keeps an entry at ~150 bytes instead of ~20 KB and
     * lets a board hold every player's time instead of the fastest few. Inline
     * is the fallback for a deployment with no object storage.
     */
    run: RunSource;
}

/**
 * Consecutive board-read failures before this session stops asking.
 *
 * A leaderboard read happens per level, and the level selector reads one for
 * every track shown — so a service that is down turns into a request and a red
 * console line per track, repeated on every visit to the menu. Three strikes is
 * enough to conclude the service is unavailable rather than the board empty.
 */
const BOARD_FAILURE_LIMIT = 3;

let consecutiveBoardFailures = 0;

/** True once this session has given up on reaching the shared board. */
export function isBoardServiceUnavailable(): boolean {
    return consecutiveBoardFailures >= BOARD_FAILURE_LIMIT;
}

/** Test seam, and the hook for a manual retry. */
export function resetBoardFailures(): void {
    consecutiveBoardFailures = 0;
}

/**
 * Rows for a level's board, best first and one per player.
 *
 * `fields: 'values'` keeps this cheap — the run blobs stay on the server until
 * a ghost is actually wanted. Over-fetching then deduping is deliberate: the
 * board is append-only, so a player who improved five times owns five rows.
 */
export async function fetchBoard(
    service: GameDataService,
    levelId: string,
    limit: number,
): Promise<BoardEntry[]> {
    // LOCAL FIRST, and never conditional on the network. A player who has
    // driven this track HAS times, and they must show whether or not the shared
    // service answers.
    const local = localBoardRows(levelId);
    const remote = await fetchRemoteBoard(service, levelId, limit);
    return mergeBoards(local, remote).slice(0, limit);
}

/**
 * Other players' times. Returns empty rather than throwing — an unreachable
 * board is an ordinary condition (offline, or a service that is down), and it
 * must never take the player's own records down with it.
 */
async function fetchRemoteBoard(
    service: GameDataService,
    levelId: string,
    limit: number,
): Promise<BoardEntry[]> {
    if (isBoardServiceUnavailable()) return [];
    try {
        const result = await service.list(boardCategoryFor(levelId), {
            orderBy: 'values.timeMs',
            orderDir: 'asc',
            limit: Math.min(200, Math.max(limit * 5, limit + 10)),
            fields: 'values',
        });
        consecutiveBoardFailures = 0;
        return dedupeByPlayer(result.entries);
    } catch (error) {
        consecutiveBoardFailures++;
        if (consecutiveBoardFailures === BOARD_FAILURE_LIMIT) {
            console.warn(
                '[GhostBoard] shared leaderboard unreachable after '
                + `${BOARD_FAILURE_LIMIT} attempts — not asking again this session. `
                + 'Local records and ghosts are unaffected.',
                error,
            );
        }
        return [];
    }
}

/**
 * Local rows plus remote rows, best first.
 *
 * A local run that has since uploaded exists in both, so a row whose time
 * matches one already present is dropped — the player must not race, or see,
 * two copies of the same lap.
 */
export function mergeBoards(local: BoardEntry[], remote: BoardEntry[]): BoardEntry[] {
    const times = new Set(remote.map((entry) => Math.round(entry.timeMs)));
    const unique = local.filter((entry) => !times.has(Math.round(entry.timeMs)));
    return [...remote, ...unique].sort((a, b) => a.timeMs - b.timeMs);
}

/**
 * Keep each player's best row.
 *
 * Entries arrive sorted by time, so the first occurrence of a player is
 * already their best. Dedupe keys on the SERVER-STAMPED `createdByUid`, never
 * on the submitted name: a name is client-supplied, so deduping by it would let
 * one griefer submitting fifty runs under someone else's name own the board.
 * Rows with no stamped owner keep their entry id, so they appear once each
 * rather than collapsing into a single anonymous row.
 */
export function dedupeByPlayer(entries: EntryView[]): BoardEntry[] {
    const seen = new Set<string>();
    const out: BoardEntry[] = [];
    for (const entry of entries) {
        const playerId = typeof entry.createdByUid === 'string' ? entry.createdByUid : '';
        const key = playerId || `entry:${entry.id}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const timeMs = entry.values.timeMs;
        const name = entry.values.name;
        const assetId = entry.values.assetId;
        out.push({
            entryId: entry.id,
            playerId,
            name: typeof name === 'string' ? name : '',
            timeMs: typeof timeMs === 'number' ? timeMs : Number.POSITIVE_INFINITY,
            createdAt: entry.meta.createdAt,
            assetId: typeof assetId === 'string' && assetId ? assetId : null,
        });
    }
    return out;
}

/** Store a run. Returns the new entry id, which is also its challenge-link id. */
export async function submitRun(service: GameDataService, input: SubmitRunInput): Promise<string> {
    // `values` is the queryable surface: string/number only, max 20 keys.
    const values: Record<string, string | number> = {
        timeMs: Math.round(input.timeMs),
        name: input.name,
        levelId: input.levelId,
    };
    // Kept in `values` rather than inside the run payload so a board can show
    // which car set a time without downloading the run itself.
    if (input.assetId) values.assetId = input.assetId.slice(0, 256);

    // `runUrl` for an uploaded run, `run` for an inline one. The inline key
    // keeps its ORIGINAL name because entries written before runs moved to
    // object storage carry it, and those runs must stay raceable.
    const data: Record<string, unknown> = input.run.kind === 'url'
        ? { runUrl: input.run.url }
        : { run: input.run.encoded };

    const created = await service.create(boardCategoryFor(input.levelId), {
        data,
        values,
        playerId: input.playerId,
        verifier: input.verifier,
    });
    return created.id;
}

/**
 * Where one entry's run is stored, by entry id.
 *
 * Understands both shapes, and must keep doing so: `runUrl` is what a run
 * written today carries, `run` is every run written before object storage
 * existed — and those entries are permanent, because the board is append-only.
 */
export async function fetchRunSource(
    service: GameDataService,
    levelId: string,
    entryId: string,
): Promise<RunSource | null> {
    const entry = await service.get(boardCategoryFor(levelId), entryId);
    const url = entry.data?.runUrl;
    if (typeof url === 'string' && url) return { kind: 'url', url };
    const inline = entry.data?.run;
    if (typeof inline === 'string' && inline) return { kind: 'inline', encoded: inline };
    return null;
}

export interface BoardManifestRow {
    levelId: string;
    levelName: string;
    category: string;
}

/**
 * Publish what boards this game has, so the portal can render them.
 *
 * A ghost board is a leaderboard of lap times whose rows happen to be
 * replayable, so it declares itself through the shared publisher rather than
 * writing its own manifest row — `ghost: true` is what earns a row the "race
 * this lap" link on the website.
 */
export async function publishBoardManifest(
    service: GameDataService,
    row: BoardManifestRow,
): Promise<void> {
    await publishLeaderboard(service, {
        category: row.category,
        label: row.levelName,
        metric: 'time',
        field: 'timeMs',
        levelId: row.levelId,
        ghost: true,
    });
}
