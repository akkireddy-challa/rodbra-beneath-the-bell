import { LevelManager, type LevelManagerOptions, shouldApplyBootNav } from 'engine/levels/LevelManager.js';
import type { GameData } from 'types/game.js';

const makeGameData = (): GameData => ({
    worldProfileData: {
        levels: [
            { id: 'l1', name: 'One', vwldAssetId: 'a1' },
            {
                id: 'l2', name: 'Two', vwldAssetId: 'a2',
                spawnPoints: [{ id: 's2', type: 'player', position: { x: 5, y: 1, z: 5 }, rotationY: 0 }],
            },
        ],
        startLevelId: 'l1',
        spawnPoints: [{ id: 'g', type: 'player', position: { x: 0, y: 0, z: 0 }, rotationY: 0 }],
    },
    assets: [
        { id: 'a1', name: 'L1', url: 'http://x/l1.vwld', type: 'vwld' },
        { id: 'a2', name: 'L2', url: 'http://x/l2.vwld', type: 'vwld' },
    ],
} as unknown as GameData);

const makeOpts = (gameData: GameData, calls: string[]): LevelManagerOptions => ({
    gameData,
    loadTerrain: async () => { calls.push('terrain'); },
    settleTerrainUpload: async () => { calls.push('uploadFrame'); },
    reloadSceneContent: async (id) => { calls.push(`content:${id}`); },
    applyAtmosphere: () => { calls.push('atmosphere'); },
    setTransitionLock: (locked) => { calls.push(`lock:${locked}`); },
    // Deliberately not recorded into `calls`: the sequence tests below assert an exact
    // call list, and this hook is about the quality sampler rather than the load's shape.
    // Its own test overrides this.
    noteQualityDisturbance: () => {},
    respawnPlayer: (sp) => { calls.push(`respawn:${sp?.id ?? 'none'}`); },
    sendLevelChange: (id) => { calls.push(`net:${id}`); },
    installNavmesh: async (id) => { calls.push(`navmesh:${id}`); },
    reportSwitchProgress: (stage) => { calls.push(`progress:${stage}`); },
    warmUpScene: async () => { calls.push('warmup'); },
    fetchBuffer: async () => { calls.push('fetch'); return new ArrayBuffer(4); },
});

describe('LevelManager', () => {
    test('reports loading throughout fetch, construction and warmup, then clears it', async () => {
        const opts = makeOpts(makeGameData(), []);
        let finishFetch!: (buffer: ArrayBuffer) => void;
        opts.fetchBuffer = () => new Promise((resolve) => { finishFetch = resolve; });
        const lm = new LevelManager(opts);
        const stages: string[] = [];
        opts.loadTerrain = async () => { expect(lm.isLoading()).toBe(true); stages.push('terrain'); };
        opts.reloadSceneContent = async () => { expect(lm.isLoading()).toBe(true); stages.push('content'); };
        opts.warmUpScene = async () => { expect(lm.isLoading()).toBe(true); stages.push('warmup'); };
        expect(lm.isLoading()).toBe(false);
        const pending = lm.loadLevel('l2');
        expect(lm.isLoading()).toBe(true);
        finishFetch(new ArrayBuffer(4));
        await pending;
        expect(stages).toEqual(['terrain', 'content', 'warmup']);
        expect(lm.isLoading()).toBe(false);
    });

    test('clears the loading gate after a failed fetch', async () => {
        const opts = makeOpts(makeGameData(), []);
        opts.fetchBuffer = async () => { throw new Error('offline'); };
        const lm = new LevelManager(opts);
        await expect(lm.loadLevel('l2')).rejects.toThrow('offline');
        expect(lm.isLoading()).toBe(false);
    });

    test('tells the quality sampler a level switch is not evidence about the device', async () => {
        // A switch never leaves GameState.PLAYING (the fade is DOM-only), so without this
        // the auto-tuner would judge the device on frames spent fetching, meshing and
        // warming a level — and downgrade it for loading.
        const reasons: string[] = [];
        const opts = { ...makeOpts(makeGameData(), []), noteQualityDisturbance: (r: string) => { reasons.push(r); } };
        await new LevelManager(opts).loadLevel('l2');
        expect(reasons).toEqual(['level load']);
    });

    test('tells it even when the load failed', async () => {
        // A failed load is MORE frames of not-gameplay, not fewer.
        const reasons: string[] = [];
        const opts = {
            ...makeOpts(makeGameData(), []),
            fetchBuffer: async () => { throw new Error('offline'); },
            noteQualityDisturbance: (r: string) => { reasons.push(r); },
        };
        await expect(new LevelManager(opts).loadLevel('l2')).rejects.toThrow();
        expect(reasons).toEqual(['level load']);
    });

    test('constructor throws in legacy mode', () => {
        expect(() => new LevelManager(makeOpts({ worldProfileData: {} } as GameData, []))).toThrow(/legacy/);
    });

    test('boots on startLevelId and lists levels', () => {
        const lm = new LevelManager(makeOpts(makeGameData(), []));
        expect(lm.getActiveLevelId()).toBe('l1');
        expect(lm.getLevels()).toEqual([{ id: 'l1', name: 'One' }, { id: 'l2', name: 'Two' }]);
        expect(lm.getActiveLevel().vwldAssetId).toBe('a1');
        expect(lm.isInActiveLevel({})).toBe(true);
        expect(lm.isInActiveLevel({ levelId: 'l1' })).toBe(true);
        expect(lm.isInActiveLevel({ levelId: 'l2' })).toBe(false);
    });

    test('loadLevel sequences fetch → willUnload → lock → net → terrain → uploadFrame → content → navmesh → atmosphere → respawn → didLoad → warmup → unlock', async () => {
        const calls: string[] = [];
        const lm = new LevelManager(makeOpts(makeGameData(), calls));
        lm.onLevelWillUnload((f, t) => calls.push(`will:${f}->${t}`));
        lm.onLevelDidLoad((id) => calls.push(`did:${id}`));
        await lm.loadLevel('l2');
        expect(calls).toEqual([
            'fetch', 'will:l1->l2', 'lock:true', 'net:l2', 'progress:terrain', 'terrain', 'uploadFrame',
            'progress:objects', 'content:l2', 'progress:navmesh', 'navmesh:l2', 'progress:atmosphere', 'atmosphere',
            'respawn:s2', 'did:l2', 'progress:warmup', 'warmup', 'lock:false',
        ]);
        expect(lm.getActiveLevelId()).toBe('l2');
    });

    test('a rejecting installNavmesh degrades but does not abort the load', async () => {
        const calls: string[] = [];
        const opts = makeOpts(makeGameData(), calls);
        opts.installNavmesh = async (id) => {
            calls.push(`navmesh:${id}`);
            throw new Error('nav fetch failed');
        };
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const lm = new LevelManager(opts);
        await expect(lm.loadLevel('l2')).resolves.toBeUndefined();
        expect(calls).toEqual([
            'fetch', 'lock:true', 'net:l2', 'progress:terrain', 'terrain', 'uploadFrame',
            // warmup still runs: a missing navmesh degrades the level, it does
            // not stop it being played, so its shaders must still be linked
            // under the fade.
            'progress:objects', 'content:l2', 'progress:navmesh', 'navmesh:l2', 'progress:atmosphere', 'atmosphere',
            'respawn:s2', 'progress:warmup', 'warmup', 'lock:false',
        ]);
        expect(lm.getActiveLevelId()).toBe('l2');
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    test('networked:false skips broadcast; global spawn fallback', async () => {
        const calls: string[] = [];
        const lm = new LevelManager(makeOpts(makeGameData(), calls));
        await lm.loadLevel('l1', { networked: false });
        expect(calls).not.toContain('net:l1');
        expect(calls).toContain('respawn:g');
    });

    test('spawnPointId picks a specific spawn', async () => {
        const calls: string[] = [];
        const lm = new LevelManager(makeOpts(makeGameData(), calls));
        await lm.loadLevel('l2', { spawnPointId: 's2' });
        expect(calls).toContain('respawn:s2');
    });

    test('unknown level / missing asset / wrong type reject before any teardown', async () => {
        const calls: string[] = [];
        const gd = makeGameData();
        (gd.assets as Array<{ id: string; type: string }>).find((a) => a.id === 'a2')!.type = 'vxl';
        const lm = new LevelManager(makeOpts(gd, calls));
        await expect(lm.loadLevel('nope')).rejects.toThrow(/unknown level/);
        await expect(lm.loadLevel('l2')).rejects.toThrow(/expected 'vwld'/);
        expect(calls).toEqual([]);
    });

    test('fetch failure aborts before teardown, emits nothing, keeps old level', async () => {
        const calls: string[] = [];
        const opts = makeOpts(makeGameData(), calls);
        opts.fetchBuffer = async () => { throw new Error('net down'); };
        const lm = new LevelManager(opts);
        await expect(lm.loadLevel('l2')).rejects.toThrow('net down');
        expect(calls).toEqual([]);
        expect(lm.getActiveLevelId()).toBe('l1');
    });

    test('concurrent switch rejected; same-level reload allowed; prefetch retains nothing', async () => {
        const calls: string[] = [];
        const opts = makeOpts(makeGameData(), calls);
        let release: () => void = () => {};
        let gate: Promise<void> | null = new Promise<void>((r) => { release = r; });
        opts.loadTerrain = async () => {
            if (gate) { const g = gate; gate = null; await g; } // gate only the FIRST switch
            calls.push('terrain');
        };
        const lm = new LevelManager(opts);
        const p = lm.loadLevel('l2');
        // wait a tick so the first switch is inside loadTerrain
        await new Promise((r) => setTimeout(r, 0));
        await expect(lm.loadLevel('l1')).rejects.toThrow(/in flight/);
        release();
        await p;
        expect(lm.getActiveLevelId()).toBe('l2');

        // Prefetch warms the BROWSER's cache and keeps no bytes, so it never goes through
        // the buffer fetcher and the subsequent load still fetches. Holding the inflated
        // container to skip that was ~35 MB per level for a saving the HTTP cache already
        // provides — see `LevelManager.fetchLevelBuffer`.
        const beforePrefetch = calls.filter((c) => c === 'fetch').length;
        await lm.prefetchLevel('l1');
        expect(calls.filter((c) => c === 'fetch').length).toBe(beforePrefetch);
        await lm.loadLevel('l1');
        expect(calls.filter((c) => c === 'fetch').length).toBe(beforePrefetch + 1);
        // same-level reload allowed
        await lm.loadLevel('l1');
        expect(lm.getActiveLevelId()).toBe('l1');
    });

    test('installNetworkHooks replaces the broadcast hook', async () => {
        const calls: string[] = [];
        const opts = makeOpts(makeGameData(), calls);
        opts.sendLevelChange = null;
        const lm = new LevelManager(opts);
        await lm.loadLevel('l2');
        expect(calls.filter((c) => c.startsWith('net:'))).toEqual([]);
        lm.installNetworkHooks((id) => calls.push(`net2:${id}`));
        await lm.loadLevel('l1');
        expect(calls).toContain('net2:l1');
    });
});

// FINDING 2 (fix round 1): staleness guard for the boot-time fire-and-forget
// nav install (WorldGenerator.loadVxlSceneWorld). A late-join multiplayer
// boot's sidecar fetch can resolve after the room owner's level switch
// already installed the correct mesh — this predicate is what the boot IIFE
// checks, right before calling setGlobalNavMesh, to avoid clobbering a
// newer, correct install with a stale boot-level one.
describe('shouldApplyBootNav', () => {
    test('no known level to compare (legacy fallback resolution) always applies', () => {
        expect(shouldApplyBootNav(undefined, null)).toBe(true);
        expect(shouldApplyBootNav(undefined, 'l1')).toBe(true);
    });

    test('outside levels mode (no LevelManager, nothing could have raced) always applies', () => {
        expect(shouldApplyBootNav('l1', null)).toBe(true);
    });

    test('the active level still matches the captured boot level: applies', () => {
        expect(shouldApplyBootNav('l1', 'l1')).toBe(true);
    });

    test('the active level moved on (a switch superseded the boot install): skips', () => {
        expect(shouldApplyBootNav('l1', 'l2')).toBe(false);
    });
});

describe('LevelManager buffer cache ownership', () => {
    /**
     * `fetchLevelBuffer` keeps every fetched buffer in an LRU so `prefetchLevel` can warm
     * an upcoming switch. That makes the cache the OWNER: a `loadTerrain` implementation
     * that consumes the buffer destructively — detaching it to free memory, say — leaves a
     * zero-length entry under that URL, and the next load or prefetch of the same level
     * gets it back and fails to decode.
     *
     * That shipped once (levels intermittently refusing to load, "Could not load this
     * level", worse in a rotation because a poisoned entry survives until eviction), so
     * these pin the contract in both directions: the cache serves the same bytes again,
     * and it notices if a consumer has ruined them.
     */
    function optsWithRealBuffers(gameData: GameData, calls: string[], onTerrain: (b: ArrayBuffer) => void) {
        return {
            ...makeOpts(gameData, calls),
            fetchBuffer: async (url: string) => {
                calls.push(`fetch:${url}`);
                // Distinguishable contents, so a swapped or emptied buffer is visible.
                return new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer;
            },
            loadTerrain: async (b: ArrayBuffer) => { calls.push('terrain'); onTerrain(b); },
        };
    }

    test('fetches every load and retains no buffer between them', async () => {
        // The buffers are ~35 MB inflated (≈4 MB on the wire), and these responses carry
        // `max-age` one year — so a repeat load is a browser disk read, and holding the
        // inflated form to avoid it was the wrong trade by roughly an order of magnitude.
        // Three retained levels was >100 MB with no byte ceiling, which is what killed
        // mobile loads while every terrain budget reported itself within limits.
        const calls: string[] = [];
        const seen: ArrayBuffer[] = [];
        const lm = new LevelManager(optsWithRealBuffers(makeGameData(), calls, b => seen.push(b)));

        await lm.loadLevel('l2');
        await lm.loadLevel('l1');
        await lm.loadLevel('l2');   // a rotation — refetched, not held

        expect(calls.filter(c => c.startsWith('fetch:')).length).toBe(3);
        expect(seen.length).toBe(3);
        for (const b of seen) {
            expect(Array.from(new Uint8Array(b))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        }
    });

    test('a consumer may detach the buffer it was handed', async () => {
        // This is the point of dropping the cache: with exactly one owner, the load path
        // can release ~35 MB the moment the decode is done — right where the pressure
        // peaks. While an LRU co-owned these, detaching left a zero-length entry that the
        // next load got back and died on, surfacing as an intermittent "Could not load
        // this level". Nothing retains them now, so a detached buffer can never be reused.
        const calls: string[] = [];
        const received: number[] = [];
        const lm = new LevelManager(optsWithRealBuffers(makeGameData(), calls, (b) => {
            received.push(b.byteLength);
            try { structuredClone(b, { transfer: [b] }); } catch { /* older engines */ }
        }));

        await lm.loadLevel('l2');
        await lm.loadLevel('l1');
        await lm.loadLevel('l2');

        // Every load got real bytes despite the previous one destroying its own.
        expect(received).toEqual([8, 8, 8]);
    });
});

describe('onBeforeSceneContent', () => {
    test('runs after terrain and BEFORE scenery, with the incoming level already active', async () => {
        const calls: string[] = [];
        const lm = new LevelManager(makeOpts(makeGameData(), calls));
        // The whole point of the hook: definition-mutating work must land while the
        // spawn is still ahead of it, or it can only take effect via a second full
        // scenery rebuild. Asserting the position in the sequence IS the contract.
        lm.onBeforeSceneContent((id) => { calls.push(`prepare:${id}:active=${lm.getActiveLevelId()}`); });
        await lm.loadLevel('l2');
        expect(calls).toEqual([
            'fetch', 'lock:true', 'net:l2', 'progress:terrain', 'terrain', 'uploadFrame',
            // 'objects' is reported BEFORE the hook: aligning and culling definitions is
            // part of placing this level's objects, and it is slow enough that leaving the
            // bar on 'terrain' through it would under-report where the load is.
            'progress:objects', 'prepare:l2:active=l2',
            'content:l2', 'progress:navmesh', 'navmesh:l2', 'progress:atmosphere', 'atmosphere',
            'respawn:s2', 'progress:warmup', 'warmup', 'lock:false',
        ]);
    });

    test('awaits each callback in registration order', async () => {
        const calls: string[] = [];
        const lm = new LevelManager(makeOpts(makeGameData(), calls));
        // A hook that yields must still complete before the next one starts, and before
        // the scenery spawns — culling depends on alignment having already moved things.
        lm.onBeforeSceneContent(async () => {
            await Promise.resolve();
            calls.push('prepare:slow');
        });
        lm.onBeforeSceneContent(() => { calls.push('prepare:fast'); });
        await lm.loadLevel('l2');
        expect(calls.slice(calls.indexOf('terrain'))).toEqual([
            'terrain', 'uploadFrame', 'progress:objects', 'prepare:slow', 'prepare:fast', 'content:l2',
            'progress:navmesh', 'navmesh:l2', 'progress:atmosphere', 'atmosphere',
            'respawn:s2', 'progress:warmup', 'warmup', 'lock:false',
        ]);
    });

    test('a throwing hook is skipped without aborting the load', async () => {
        const calls: string[] = [];
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const lm = new LevelManager(makeOpts(makeGameData(), calls));
        lm.onBeforeSceneContent(() => { throw new Error('alignment blew up'); });
        lm.onBeforeSceneContent((id) => { calls.push(`prepare:${id}`); });
        await expect(lm.loadLevel('l2')).resolves.toBeUndefined();
        // Unaligned scenery is cosmetic; a dead level load is not. Later hooks still run.
        expect(calls).toContain('prepare:l2');
        expect(calls).toContain('content:l2');
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    test('no hooks registered leaves the sequence untouched', async () => {
        const calls: string[] = [];
        const lm = new LevelManager(makeOpts(makeGameData(), calls));
        await lm.loadLevel('l2');
        expect(calls).toEqual([
            'fetch', 'lock:true', 'net:l2', 'progress:terrain', 'terrain', 'uploadFrame',
            'progress:objects', 'content:l2', 'progress:navmesh', 'navmesh:l2',
            'progress:atmosphere', 'atmosphere', 'respawn:s2', 'progress:warmup',
            'warmup', 'lock:false',
        ]);
    });
});
