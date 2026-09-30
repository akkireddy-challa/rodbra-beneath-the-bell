/**
 * @jest-environment jsdom
 *
 * jsdom for the `?track=` cases only: the boot level can be named by the URL,
 * so resolving it needs a location to read.
 */

import { refreshActiveDeviceQuality } from 'engine/DeviceQuality.js';
import {
    resolveLevels,
    isInstanceInActiveLevel,
    levelSpawnPoints,
    mergeEffectiveProfile,
    applyBootLevelOverride,
} from 'engine/levels/levelResolve.js';
import { TRACK_PARAM } from 'engine/LaunchParams.js';
import type { Asset, GameData, WorldProfileData } from 'types/game.js';

const profile = (over: Partial<WorldProfileData>): WorldProfileData => ({ ...over });
const gd = (wp: WorldProfileData): GameData => ({ worldProfileData: wp } as GameData);

describe('resolveLevels', () => {
    test('no levels[] → legacy mode (null)', () => {
        expect(resolveLevels(gd(profile({})))).toBeNull();
        expect(resolveLevels(gd(profile({ levels: [] })))).toBeNull();
        expect(resolveLevels(null)).toBeNull();
    });

    test('start level = startLevelId, falls back to levels[0] when missing/unknown', () => {
        const levels = [
            { id: 'l1', name: 'One', vwldAssetId: 'a1' },
            { id: 'l2', name: 'Two', vwldAssetId: 'a2' },
        ];
        expect(resolveLevels(gd(profile({ levels, startLevelId: 'l2' })))!.startLevel.id).toBe('l2');
        expect(resolveLevels(gd(profile({ levels })))!.startLevel.id).toBe('l1');
        expect(resolveLevels(gd(profile({ levels, startLevelId: 'nope' })))!.startLevel.id).toBe('l1');
    });

    describe(`?${TRACK_PARAM}= deep links`, () => {
        const levels = [
            { id: 'l1', name: 'One', vwldAssetId: 'a1' },
            { id: 'l2', name: 'Two', vwldAssetId: 'a2' },
        ];
        const search = (query: string): void => {
            window.history.replaceState({}, '', query ? `/?${query}` : '/');
        };
        afterEach(() => search(''));

        test('boots the level the link names, over the authored start level', () => {
            search(`${TRACK_PARAM}=l2`);
            expect(resolveLevels(gd(profile({ levels, startLevelId: 'l1' })))!.startLevel.id).toBe('l2');
        });

        // A link outlives the track it points at: renamed, deleted, or shared
        // into a different game entirely. None of those may fail the load.
        test('falls back to the authored start level when the id is unknown', () => {
            search(`${TRACK_PARAM}=gone`);
            expect(resolveLevels(gd(profile({ levels, startLevelId: 'l2' })))!.startLevel.id).toBe('l2');
        });

        test('ignores a malformed value rather than trusting it', () => {
            search(`${TRACK_PARAM}=${encodeURIComponent('../other level')}`);
            expect(resolveLevels(gd(profile({ levels, startLevelId: 'l2' })))!.startLevel.id).toBe('l2');
        });

        test('changes nothing for a game with no levels[]', () => {
            search(`${TRACK_PARAM}=l2`);
            expect(resolveLevels(gd(profile({})))).toBeNull();
        });
    });
});

describe('isInstanceInActiveLevel', () => {
    test('legacy mode (activeLevelId null) loads everything', () => {
        expect(isInstanceInActiveLevel({ levelId: 'x' }, null)).toBe(true);
        expect(isInstanceInActiveLevel({}, null)).toBe(true);
    });

    test('levels mode: tag match or untagged-global', () => {
        expect(isInstanceInActiveLevel({ levelId: 'l1' }, 'l1')).toBe(true);
        expect(isInstanceInActiveLevel({ levelId: 'l2' }, 'l1')).toBe(false);
        expect(isInstanceInActiveLevel({}, 'l1')).toBe(true);
    });
});

describe('levelSpawnPoints', () => {
    const globalPts = [{ id: 'g1', type: 'player', position: { x: 1, y: 0, z: 0 }, rotationY: 0 }];
    const levelPts = [{ id: 'p1', type: 'player', position: { x: 9, y: 0, z: 9 }, rotationY: 0 }];

    test('level spawns win; global fallback when level has none', () => {
        const wp = profile({ spawnPoints: globalPts });
        expect(levelSpawnPoints(wp, { id: 'l1', name: '', vwldAssetId: 'a', spawnPoints: levelPts })[0]!.id).toBe('p1');
        expect(levelSpawnPoints(wp, { id: 'l1', name: '', vwldAssetId: 'a' })[0]!.id).toBe('g1');
        expect(levelSpawnPoints(wp, { id: 'l1', name: '', vwldAssetId: 'a', spawnPoints: [] })[0]!.id).toBe('g1');
        expect(levelSpawnPoints(wp, null)[0]!.id).toBe('g1');
        expect(levelSpawnPoints(undefined, null)).toEqual([]);
    });
});

describe('mergeEffectiveProfile', () => {
    test('override fields replace, rest untouched, input not mutated', () => {
        const wp = profile({ skyboxUrl: 'sky-a', waterLevelY: 3, characterHeight: 2 });
        const lvl = {
            id: 'l1', name: '', vwldAssetId: 'a',
            overrides: { skyboxUrl: 'sky-b', fogConfig: { color: '#000' } },
        };
        const eff = mergeEffectiveProfile(wp, lvl);
        expect(eff.skyboxUrl).toBe('sky-b');
        expect(eff.fogConfig).toEqual({ color: '#000' });
        expect(eff.waterLevelY).toBe(3);
        expect(eff.characterHeight).toBe(2);
        expect(wp.skyboxUrl).toBe('sky-a');
        expect(wp.fogConfig).toBeUndefined();
        expect(eff).not.toBe(wp);
    });

    test('no level / no overrides → copy of globals', () => {
        const wp = profile({ skyboxUrl: 'sky-a' });
        expect(mergeEffectiveProfile(wp, null).skyboxUrl).toBe('sky-a');
        expect(mergeEffectiveProfile(wp, { id: 'l', name: '', vwldAssetId: 'a' }).skyboxUrl).toBe('sky-a');
    });
});

describe('applyBootLevelOverride', () => {
    const levels = [
        { id: 'l1', name: 'One', vwldAssetId: 'a1' },
        {
            id: 'l2', name: 'Two', vwldAssetId: 'a2',
            spawnPoints: [{ id: 'p2', type: 'player', position: { x: 7, y: 1, z: 7 }, rotationY: 0 }],
        },
    ];
    const makeGame = (): GameData => ({
        // Fresh copies per call — one test swaps an asset type and must not
        // leak that into the fixtures of later tests.
        assets: [
            { id: 'a1', type: 'vwld', url: 'https://x/l1.vwld' },
            { id: 'a2', type: 'vwld', url: 'https://x/l2.vwld' },
        ] as Asset[],
        worldProfileData: profile({
            levels,
            startLevelId: 'l1',
            voxelUrl: 'https://x/l1.vwld',
            spawnPoints: [{ id: 'g1', type: 'player', position: { x: 1, y: 0, z: 1 }, rotationY: 0 }],
            playerSpawnPosition: { x: 1, y: 0, z: 1 },
        }),
    } as GameData);

    test('mirrors the DEVICE variant url, not the authored one', () => {
        // The boot path fetches `voxelUrl` as a plain string, so writing the full container
        // here bypasses the pre-baked LOD variants entirely. Pre-play level selection routes
        // through this function, which makes it the primary way a phone loads a level —
        // measured on the heaviest circuit that is 39.6 MB inflated against 22.8 MB.
        const game = makeGame();
        (game.assets as Asset[])[1]!.lodVariants = [{ drop: 1, url: 'https://x/l2.lod1.vwld' }];

        // Desktop (the default here) takes the full container.
        refreshActiveDeviceQuality();
        expect(applyBootLevelOverride(game, 'l2').worldProfileData!.voxelUrl).toBe('https://x/l2.vwld');

        // Mobile takes the variant. Driven through the URL the same way this file's
        // ?track= test does, so jsdom keeps ownership of `window`.
        //
        // The reset is required because the quality tier is resolved once per session and
        // memoised — it sits on the per-material construction path, so it cannot re-probe
        // the platform per call. A real load never changes platform underneath itself; a
        // test that drives both in one function has to say so explicitly.
        window.history.replaceState({}, '', '/?platform=mobile');
        refreshActiveDeviceQuality();
        try {
            expect(applyBootLevelOverride(game, 'l2').worldProfileData!.voxelUrl)
                .toBe('https://x/l2.lod1.vwld');
        } finally {
            window.history.replaceState({}, '', '/');
            refreshActiveDeviceQuality();
        }
    });

    test('remaps startLevelId + legacy mirror fields to the picked level, without mutating the input', () => {
        const original = makeGame();
        const out = applyBootLevelOverride(original, 'l2');
        expect(out).not.toBe(original);
        expect(out.worldProfileData!.startLevelId).toBe('l2');
        expect(out.worldProfileData!.voxelUrl).toBe('https://x/l2.vwld');
        expect(out.worldProfileData!.spawnPoints![0]!.id).toBe('p2');
        expect(out.worldProfileData!.playerSpawnPosition).toEqual({ x: 7, y: 1, z: 7 });
        // resolveLevels on the copy boots the pick
        expect(resolveLevels(out)!.startLevel.id).toBe('l2');
        // original untouched (load-once rule)
        expect(original.worldProfileData!.startLevelId).toBe('l1');
        expect(original.worldProfileData!.voxelUrl).toBe('https://x/l1.vwld');
        expect(original.worldProfileData!.spawnPoints![0]!.id).toBe('g1');
    });

    test('picking the AUTHORED start level is a no-op (same reference)', () => {
        const original = makeGame();
        expect(applyBootLevelOverride(original, 'l1')).toBe(original);
    });

    test('a ?track= link to a non-start level still gets the mirror remap (early-exit keys on the authored start, not the track-resolved one)', () => {
        window.history.replaceState({}, '', `/?${TRACK_PARAM}=l2`);
        try {
            const original = makeGame();
            // resolveLevels already boots l2 via the link…
            expect(resolveLevels(original)!.startLevel.id).toBe('l2');
            // …but the mirrors still describe l1, so the override must NOT no-op.
            const out = applyBootLevelOverride(original, 'l2');
            expect(out).not.toBe(original);
            expect(out.worldProfileData!.voxelUrl).toBe('https://x/l2.vwld');
        } finally {
            window.history.replaceState({}, '', '/');
        }
    });

    test('degrades to the original on unknown level, missing/invalid asset, or no levels[]', () => {
        const original = makeGame();
        expect(applyBootLevelOverride(original, 'nope')).toBe(original);

        const badAsset = makeGame();
        (badAsset.assets as Asset[])[1] = { id: 'a2', type: 'glb', url: 'https://x/l2.glb' } as Asset;
        expect(applyBootLevelOverride(badAsset, 'l2')).toBe(badAsset);

        const legacy = { worldProfileData: profile({}) } as GameData;
        expect(applyBootLevelOverride(legacy, 'l2')).toBe(legacy);
    });

    test('level without own spawn points keeps the global mirror spawns', () => {
        const game = makeGame();
        game.worldProfileData!.levels = [
            { id: 'l1', name: 'One', vwldAssetId: 'a1' },
            { id: 'l2', name: 'Two', vwldAssetId: 'a2' }, // no spawnPoints
        ];
        const out = applyBootLevelOverride(game, 'l2');
        expect(out.worldProfileData!.voxelUrl).toBe('https://x/l2.vwld');
        expect(out.worldProfileData!.spawnPoints![0]!.id).toBe('g1');
        expect(out.worldProfileData!.playerSpawnPosition).toEqual({ x: 1, y: 0, z: 1 });
    });
});

describe('mergeEffectiveProfile — a level with no water', () => {
    it('drops the world default when the level override is null, and keeps it when the level says nothing', () => {
        const profile = { waterLevelY: 62.9 } as unknown as Parameters<typeof mergeEffectiveProfile>[0];
        const dry = mergeEffectiveProfile(profile, { id: 'l', name: 'Dry', vwldAssetId: 'v', overrides: { waterLevelY: null } } as unknown as Parameters<typeof mergeEffectiveProfile>[1]);
        expect('waterLevelY' in dry).toBe(false);
        const silent = mergeEffectiveProfile(profile, { id: 'l', name: 'Silent', vwldAssetId: 'v', overrides: {} } as unknown as Parameters<typeof mergeEffectiveProfile>[1]);
        expect(silent.waterLevelY).toBe(62.9);
        const wet = mergeEffectiveProfile(profile, { id: 'l', name: 'Wet', vwldAssetId: 'v', overrides: { waterLevelY: 4 } } as unknown as Parameters<typeof mergeEffectiveProfile>[1]);
        expect(wet.waterLevelY).toBe(4);
    });
});
