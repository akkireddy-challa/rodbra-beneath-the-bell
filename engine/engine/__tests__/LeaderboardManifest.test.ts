/**
 * Declaring a leaderboard to the website.
 *
 * The declaration is the ONLY way the portal learns a board exists, so the
 * fields it carries — and the fact that a repeat call does not write a row per
 * play — are the contract.
 */

import {
    LEADERBOARD_MANIFEST_CATEGORY,
    publishLeaderboard,
    resetPublishedLeaderboards,
} from 'engine/gamedata/LeaderboardManifest.js';
import { publishBoardManifest } from 'engine/replay/GhostBoard.js';
import type { GameDataService } from 'engine/gamedata/GameDataService.js';

interface Written { category: string; values: Record<string, string | number> }

function fakeService(onCreate?: () => never): { service: GameDataService; writes: Written[] } {
    const writes: Written[] = [];
    const service = {
        create: async (category: string, input: { values: Record<string, string | number> }) => {
            onCreate?.();
            writes.push({ category, values: input.values });
            return { id: `entry-${writes.length}` };
        },
    } as unknown as GameDataService;
    return { service, writes };
}

const SCORES = {
    category: 'leaderboard',
    label: 'High scores',
    metric: 'score' as const,
    field: 'score',
    levelId: null,
    ghost: false,
};

describe('publishLeaderboard', () => {
    beforeEach(() => resetPublishedLeaderboards());

    it('writes the declaration the portal reads', async () => {
        const { service, writes } = fakeService();
        await publishLeaderboard(service, SCORES);

        expect(writes).toHaveLength(1);
        expect(writes[0]!.category).toBe(LEADERBOARD_MANIFEST_CATEGORY);
        expect(writes[0]!.values).toMatchObject({
            category: 'leaderboard',
            label: 'High scores',
            metric: 'score',
            field: 'score',
            ghost: 0,
        });
    });

    // A game may call this on every score submit. The fact never changes, so
    // writing a row per play would grow the manifest forever.
    it('writes once per session for the same board', async () => {
        const { service, writes } = fakeService();
        await publishLeaderboard(service, SCORES);
        await publishLeaderboard(service, SCORES);
        await publishLeaderboard(service, { ...SCORES, category: 'weekly', label: 'This week' });

        expect(writes).toHaveLength(2);
    });

    // The board still works in-game when the site never hears about it.
    it('never throws, and retries after a failure', async () => {
        const failing = fakeService(() => { throw new Error('offline'); });
        await expect(publishLeaderboard(failing.service, SCORES)).resolves.toBeUndefined();

        const { service, writes } = fakeService();
        await publishLeaderboard(service, SCORES);
        expect(writes).toHaveLength(1);
    });

    it('carries the old key names, so existing readers still understand it', async () => {
        const { service, writes } = fakeService();
        await publishLeaderboard(service, { ...SCORES, levelId: 'circuit-2', label: 'Sunset Ridge' });

        expect(writes[0]!.values).toMatchObject({ levelId: 'circuit-2', levelName: 'Sunset Ridge' });
    });
});

describe('publishBoardManifest', () => {
    beforeEach(() => resetPublishedLeaderboards());

    // A ghost board is a leaderboard whose rows happen to be replayable, and
    // `ghost: 1` is what earns those rows a "race this lap" link.
    it('declares a ghost board as a time board with replayable rows', async () => {
        const { service, writes } = fakeService();
        await publishBoardManifest(service, {
            levelId: 'circuit-2',
            levelName: 'Sunset Ridge',
            category: 'ghosts-circuit-2',
        });

        expect(writes[0]!.values).toMatchObject({
            category: 'ghosts-circuit-2',
            label: 'Sunset Ridge',
            metric: 'time',
            field: 'timeMs',
            levelId: 'circuit-2',
            ghost: 1,
        });
    });
});
