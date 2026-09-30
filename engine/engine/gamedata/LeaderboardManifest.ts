/**
 * Telling the website a leaderboard exists.
 *
 * The portal CANNOT discover a game's boards. Category listing is admin-only
 * with no public equivalent, and even a listing would not say which categories
 * are leaderboards, what they are called, or which way round they sort. So a
 * game that wants its board on its page publishes a row saying so, and the
 * portal reads that (docs/ghost-racing-design.md §11.1).
 *
 * Ghost boards have done this since they shipped; this is the same mechanism
 * widened to any board, because a high-score table has exactly the same problem
 * and had no way to say it.
 *
 * ⚠ Declaring a board does not make it public on its own — the creator decides
 * that when publishing, and can turn it off on the game page afterwards. This
 * only says the board EXISTS.
 */

import type { GameDataService } from 'engine/gamedata/GameDataService.js';

/**
 * Category the manifest itself lives in.
 *
 * Still named for ghosts because renaming it would orphan every board already
 * published: the portal reads this name, and the rows in it are the only record
 * that those boards exist.
 */
export const LEADERBOARD_MANIFEST_CATEGORY = 'ghost-boards';

/**
 * How a board's numbers are read.
 *
 * - `time` — lower is better, rendered as `1:42.318`.
 * - `score` — higher is better, rendered as a plain number.
 *
 * This is the whole reason the declaration exists rather than being inferred:
 * a board sorted the wrong way is not a cosmetic problem, it is a leaderboard
 * showing the worst players at the top.
 */
export type LeaderboardMetric = 'time' | 'score';

export interface LeaderboardDeclaration {
    /** Category the rows live in — `boardCategoryFor(levelId)` for ghost boards. */
    category: string;
    /** What to call it on the page: a track name, "High scores", "Weekly". */
    label: string;
    metric: LeaderboardMetric;
    /**
     * Key inside `values` holding the number. `timeMs` for ghost boards,
     * `score` for the leaderboard the data-service doc teaches.
     *
     * ⚠ Must match what the rows actually carry. Firestore OMITS documents that
     * lack the field being sorted on, so a wrong name here reads as an empty
     * board rather than as an error.
     */
    field: string;
    /**
     * Level this board belongs to, when it belongs to one. Lets the website
     * link a row back to the right track.
     */
    levelId: string | null;
    /**
     * True when every row is a replayable run, so the site can offer "race this
     * ghost". False for a plain score table, which has nothing to replay.
     */
    ghost: boolean;
}

/**
 * Declarations already published this session.
 *
 * The manifest is append-only and readers take the newest row per category, so
 * a duplicate is harmless — but a game that declares on every score submit
 * would write a row per play, forever, for a fact that never changes.
 */
const published = new Set<string>();

/** Test seam — module state outlives a single game load. */
export function resetPublishedLeaderboards(): void {
    published.clear();
}

/**
 * Publish a board declaration. Safe to call every time the board is written to;
 * repeats within a session are dropped.
 *
 * Never throws: a game whose declaration fails to upload still has a working
 * board in-game, and the website simply does not know about it yet.
 */
export async function publishLeaderboard(
    service: GameDataService,
    declaration: LeaderboardDeclaration,
): Promise<void> {
    const key = JSON.stringify(declaration);
    if (published.has(key)) return;
    published.add(key);

    try {
        await service.create(LEADERBOARD_MANIFEST_CATEGORY, {
            data: {},
            values: {
                category: declaration.category,
                label: declaration.label,
                metric: declaration.metric,
                field: declaration.field,
                ghost: declaration.ghost ? 1 : 0,
                // Kept under the ORIGINAL key names as well, because manifest
                // rows written before this module existed carry `levelId` and
                // `levelName` and readers still understand those.
                levelId: declaration.levelId ?? '',
                levelName: declaration.label,
            },
        });
    } catch (error) {
        published.delete(key);
        console.warn('[Leaderboard] publishing the board declaration failed:', error);
    }
}
