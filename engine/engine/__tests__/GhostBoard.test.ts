/**
 * Board storage rules.
 *
 * These are the constraints the game data service forces on us rather than
 * ones we chose, so they are exactly the ones that will be quietly broken by a
 * future change: per-level CATEGORIES (not a `where` filter), append-only with
 * read-time dedupe, and dedupe keyed on the server-stamped owner.
 */

import {
    BOARD_MANIFEST_CATEGORY,
    boardCategoryFor,
    dedupeByPlayer,
    fetchBoard,
    fetchRunSource,
    isBoardServiceUnavailable,
    resetBoardFailures,
    submitRun,
} from 'engine/replay/GhostBoard.js';
import type { GameDataService } from 'engine/gamedata/GameDataService.js';
import { generatedNameFor, isAnonymousPlayerId } from 'engine/replay/GhostNames.js';
import type { EntryView } from 'engine/gamedata/types.js';
import * as THREE from 'three';
import { describeVehicleForGhost, type ReplayVehicleSubject } from 'engine/replay/ReplaySubjects.js';

function entry(id: string, timeMs: number, owner: string | null, name = 'x'): EntryView {
    return {
        id,
        values: { timeMs, name },
        meta: { revision: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', expireAt: null },
        createdByUid: owner,
    };
}

describe('boardCategoryFor', () => {
    // The server's CATEGORY_NAME_RE: 32 chars of [a-z0-9_-], first char a letter.
    const CATEGORY_RE = /^[a-z][a-z0-9_-]{0,31}$/;

    test('produces a server-legal name for ordinary level ids', () => {
        expect(boardCategoryFor('sunset-ridge')).toBe('ghosts-sunset-ridge');
        expect(boardCategoryFor('sunset-ridge')).toMatch(CATEGORY_RE);
    });

    test('is deterministic — every client must compute the same bucket', () => {
        expect(boardCategoryFor('canyon run')).toBe(boardCategoryFor('canyon run'));
    });

    test('normalizes unsafe characters instead of emitting an illegal name', () => {
        for (const id of ['Canyon Run!', 'level/2', 'ÅÄÖ track', 'UPPER']) {
            expect(boardCategoryFor(id)).toMatch(CATEGORY_RE);
        }
    });

    test('falls back to a hash rather than TRUNCATING a long id', () => {
        // Truncation would merge two levels whose ids share a prefix into one
        // board, which is silent and unrecoverable.
        const a = 'a-very-long-level-identifier-that-exceeds-the-cap-alpha';
        const b = 'a-very-long-level-identifier-that-exceeds-the-cap-beta';
        expect(boardCategoryFor(a)).toMatch(CATEGORY_RE);
        expect(boardCategoryFor(b)).toMatch(CATEGORY_RE);
        expect(boardCategoryFor(a)).not.toBe(boardCategoryFor(b));
    });

    test('an empty or all-punctuation id still yields a legal name', () => {
        expect(boardCategoryFor('')).toMatch(CATEGORY_RE);
        expect(boardCategoryFor('///')).toMatch(CATEGORY_RE);
    });

    test('different levels never share a board', () => {
        const ids = ['a', 'b', 'sunset-ridge', 'canyon', '', '///', 'x'.repeat(80)];
        const names = new Set(ids.map(boardCategoryFor));
        expect(names.size).toBe(ids.length);
    });

    test('the manifest category is legal too', () => {
        expect(BOARD_MANIFEST_CATEGORY).toMatch(CATEGORY_RE);
    });
});

describe('dedupeByPlayer', () => {
    test('keeps each player only once, at their best time', () => {
        const rows = dedupeByPlayer([
            entry('e1', 1000, 'pub_alice'),
            entry('e2', 1100, 'pub_bob'),
            entry('e3', 1200, 'pub_alice'),
            entry('e4', 1300, 'pub_alice'),
        ]);
        expect(rows.map((r) => r.entryId)).toEqual(['e1', 'e2']);
        expect(rows[0]?.timeMs).toBe(1000);
    });

    test('keys on the SERVER-STAMPED owner, never the submitted name', () => {
        // A name is client-supplied. Deduping by it would let one griefer
        // submitting under someone else's name collapse the whole board.
        const rows = dedupeByPlayer([
            entry('e1', 1000, 'pub_alice', 'Alice'),
            entry('e2', 1100, 'pub_mallory', 'Alice'),
        ]);
        expect(rows).toHaveLength(2);
    });

    test('unowned rows each survive rather than collapsing into one', () => {
        const rows = dedupeByPlayer([
            entry('e1', 1000, null),
            entry('e2', 1100, null),
        ]);
        expect(rows).toHaveLength(2);
        expect(rows.every((r) => r.playerId === '')).toBe(true);
    });

    test('a malformed time sorts last instead of poisoning the board', () => {
        const rows = dedupeByPlayer([
            { ...entry('e1', 0, 'pub_a'), values: { name: 'a' } },
        ]);
        expect(rows[0]?.timeMs).toBe(Number.POSITIVE_INFINITY);
    });

    test('an empty board is empty, not an error', () => {
        expect(dedupeByPlayer([])).toEqual([]);
    });
});

describe('describeVehicleForGhost', () => {
    const wheels = [
        { position: { x: -0.8, y: -0.2, z: 1.3 }, radius: 0.35, width: 0.25, suspensionRestLength: 0.3, isSteering: true },
        { position: { x: 0.8, y: -0.2, z: 1.3 }, radius: 0.35, width: 0.25, suspensionRestLength: 0.3, isSteering: true },
        { position: { x: -0.8, y: -0.2, z: -1.3 }, radius: 0.35, width: 0.25, suspensionRestLength: 0.3, isSteering: false },
        { position: { x: 0.8, y: -0.2, z: -1.3 }, radius: 0.35, width: 0.25, suspensionRestLength: 0.3, isSteering: false },
    ];

    function subject(footprint: { width: number; height: number; length: number }): ReplayVehicleSubject {
        return {
            getPosition: () => new THREE.Vector3(),
            getChassisObject: () => new THREE.Object3D(),
            getForwardSpeed: () => 0,
            getSteeringAngle: () => 0,
            getWheelCount: () => wheels.length,
            getWheelRotation: () => 0,
            getFootprint: () => footprint,
            getWheelConfigs: () => wheels,
        };
    }

    test('uses the real footprint when the body colliders exist', () => {
        const descriptor = describeVehicleForGhost(subject({ width: 1.8, height: 1.1, length: 4.2 }));
        expect(descriptor.chassisSize).toEqual({ width: 1.8, height: 1.1, length: 4.2 });
    });

    test('falls back to wheel geometry when the footprint is just the platform slab', () => {
        // getFootprint() returns the 15 cm chassis slab when no body colliders
        // have been built. Drawing that literally is the "base of the car with
        // the chassis missing" bug.
        const descriptor = describeVehicleForGhost(subject({ width: 1.2, height: 0.15, length: 2.4 }));
        expect(descriptor.chassisSize.height).toBeCloseTo(1.05, 5); // 3 x wheel radius
        expect(descriptor.chassisSize.width).toBeCloseTo(1.6, 5);   // track
        expect(descriptor.chassisSize.length).toBeCloseTo(2.6, 5);  // wheelbase
    });

    test('carries every wheel through, with its steering flag', () => {
        const descriptor = describeVehicleForGhost(subject({ width: 1.8, height: 1.1, length: 4.2 }));
        expect(descriptor.wheels).toHaveLength(4);
        expect(descriptor.wheels.filter((w) => w.isSteering)).toHaveLength(2);
    });

    test('passes an assetId through, and omits it when absent', () => {
        const box = subject({ width: 1.8, height: 1.1, length: 4.2 });
        expect(describeVehicleForGhost(box, 'turbo-kart').assetId).toBe('turbo-kart');
        expect(describeVehicleForGhost(box).assetId).toBeUndefined();
    });
});

describe('generated guest names', () => {
    test('are a pure function of the id, so every client agrees', () => {
        expect(generatedNameFor('g_abc')).toBe(generatedNameFor('g_abc'));
        expect(generatedNameFor('g_abc')).not.toBe(generatedNameFor('g_abd'));
    });

    // The fixed `Adjective Noun 1234` shape was the point of the ORIGINAL
    // generator and is now the point of its frozen half: ids minted under it
    // are racing on boards under those names, and must keep them. Anything
    // newer is deliberately shapeless by comparison — see GhostNames.test.ts.
    test('keep the shape they were minted with', () => {
        for (const id of ['g_1', 'g_deadbeef']) {
            expect(generatedNameFor(id)).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+ \d{4}$/);
        }
        expect(generatedNameFor('g_v2_deadbeef')).not.toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+ \d{4}$/);
        expect(generatedNameFor('pub_xyz')).not.toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+ \d{4}$/);
    });

    test('spread across the name space rather than clustering', () => {
        const names = new Set<string>();
        for (let i = 0; i < 500; i++) names.add(generatedNameFor(`g_${i.toString(16)}`));
        // Collisions are possible but must be rare; clustering would mean the
        // hash is not mixing and half a board would share a name.
        expect(names.size).toBeGreaterThan(490);
    });

    test('guest ids are distinguishable from account ids without a lookup', () => {
        expect(isAnonymousPlayerId('g_deadbeef')).toBe(true);
        expect(isAnonymousPlayerId('pub_alice')).toBe(false);
    });
});


/**
 * A board read happens per level, and the level selector reads one for every
 * track it lists. When the service is down that is a request and a red console
 * line per track, on every visit to the menu — so the session stops asking
 * after a few failures and shows an empty board instead.
 */
describe('board service circuit breaker', () => {
    let warn: jest.SpyInstance;

    beforeEach(() => {
        resetBoardFailures();
        warn = jest.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });
    });

    afterEach(() => {
        warn.mockRestore();
        resetBoardFailures();
    });

    function failing(counter: { calls: number }): GameDataService {
        return {
            list: async () => { counter.calls++; throw new Error('Internal Server Error'); },
        } as unknown as GameDataService;
    }

    test('stops calling the service after repeated failures', async () => {
        const counter = { calls: 0 };
        const service = failing(counter);

        for (let i = 0; i < 10; i++) {
            await fetchBoard(service, `track-${i}`, 10).catch(() => []);
        }

        expect(counter.calls).toBe(3);
        expect(isBoardServiceUnavailable()).toBe(true);
        // Reported exactly once, not once per track.
        expect(warn).toHaveBeenCalledTimes(1);
    });

    test('returns an empty board once it has given up, rather than throwing', async () => {
        const counter = { calls: 0 };
        const service = failing(counter);
        for (let i = 0; i < 3; i++) await fetchBoard(service, 't', 10).catch(() => []);

        await expect(fetchBoard(service, 't', 10)).resolves.toEqual([]);
    });

    test('a success resets the counter, so a blip does not disable the session', async () => {
        const counter = { calls: 0 };
        let succeed = false;
        const flaky = {
            list: async () => {
                counter.calls++;
                if (!succeed) throw new Error('blip');
                return { entries: [], nextCursor: null };
            },
        } as unknown as GameDataService;

        await fetchBoard(flaky, 't', 10).catch(() => []);
        await fetchBoard(flaky, 't', 10).catch(() => []);
        succeed = true;
        await fetchBoard(flaky, 't', 10);
        succeed = false;
        await fetchBoard(flaky, 't', 10).catch(() => []);

        expect(isBoardServiceUnavailable()).toBe(false);
    });
});


/**
 * What an entry carries instead of the run itself.
 *
 * A lap is 12–43 KB and a game has 1 MB of entry storage in TOTAL, so a board
 * that stored its runs inline filled after a few dozen times — and a board that
 * has to stop accepting times is one no ordinary player can ever appear on.
 * The bytes live in object storage now and the entry keeps a URL.
 *
 * The board is append-only, so entries written before that are permanent. Both
 * shapes have to stay readable forever.
 */
describe('run storage in the entry', () => {
    function recording(created: { data?: Record<string, unknown> }): GameDataService {
        return {
            create: async (_category: string, input: { data: Record<string, unknown> }) => {
                created.data = input.data;
                return { id: 'e1' };
            },
        } as unknown as GameDataService;
    }

    const base = {
        levelId: 'ridge',
        timeMs: 61_000,
        name: 'Ada',
        playerId: 'p1',
        verifier: 'v1',
        assetId: null,
    };

    test('an uploaded run is stored as a URL, not as bytes', async () => {
        const created: { data?: Record<string, unknown> } = {};
        await submitRun(recording(created), {
            ...base,
            run: { kind: 'url', url: 'https://cdn.example/games/G/runs/ghosts-ridge/ab.bin' },
        });

        expect(created.data).toEqual({ runUrl: 'https://cdn.example/games/G/runs/ghosts-ridge/ab.bin' });
        // The entire point: an entry that costs bytes, not kilobytes.
        expect(JSON.stringify(created.data).length).toBeLessThan(200);
    });

    test('a run with nowhere to upload to still goes in the entry', async () => {
        // A deployment with no bucket — localhost, chiefly. Storing the lap
        // inline is what every run did before object storage existed, and it
        // must keep working rather than costing the player their record.
        const created: { data?: Record<string, unknown> } = {};
        await submitRun(recording(created), { ...base, run: { kind: 'inline', encoded: 'H4sIAAA' } });

        expect(created.data).toEqual({ run: 'H4sIAAA' });
    });

    test('reads a URL entry back as a url source', async () => {
        const service = {
            get: async () => ({ id: 'e1', data: { runUrl: 'https://cdn.example/r.bin' }, values: {} }),
        } as unknown as GameDataService;

        await expect(fetchRunSource(service, 'ridge', 'e1'))
            .resolves.toEqual({ kind: 'url', url: 'https://cdn.example/r.bin' });
    });

    test('reads a PRE-STORAGE entry back as an inline source', async () => {
        // Entries written before runs moved to object storage carry the run
        // under `run`. The board is append-only, so they are permanent — this
        // is not a migration window, it is forever.
        const service = {
            get: async () => ({ id: 'e0', data: { run: 'H4sIAAA' }, values: {} }),
        } as unknown as GameDataService;

        await expect(fetchRunSource(service, 'ridge', 'e0'))
            .resolves.toEqual({ kind: 'inline', encoded: 'H4sIAAA' });
    });

    test('an entry carrying neither reports nothing, rather than a broken source', async () => {
        const service = {
            get: async () => ({ id: 'e2', data: {}, values: {} }),
        } as unknown as GameDataService;

        await expect(fetchRunSource(service, 'ridge', 'e2')).resolves.toBeNull();
    });
});
