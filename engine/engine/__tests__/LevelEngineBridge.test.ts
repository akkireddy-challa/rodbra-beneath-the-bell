import { LevelEngineBridge, type LevelEngineSurface } from 'engine/levels/LevelEngineBridge.js';
import { VoxelNavMesh, getGlobalNavMesh, setGlobalNavMesh } from 'engine/VoxelNavMesh.js';
import { buildLayeredNav, toArrayBuffer } from 'engine/__tests__/helpers/buildTwoFloorNav.js';
import { LevelManager, type LevelManagerOptions } from 'engine/levels/LevelManager.js';
import { PLAYER_REST_CLEARANCE_M } from 'engine/loaders/PlayerLoader.js';
import { VxlSceneTerrainSystem, DEFAULT_VXL_SCENE_TERRAIN_CONFIG } from 'engine/VxlSceneTerrainSystem.js';
import type { DynamicObjectManager, TerrainBounds } from 'engine/DynamicObjectManager.js';
import type { EngineLike, GameData, PlayerControllerLike, SpawnPoint } from 'types/game.js';

// installNavmesh never touches `this.engine` — every member here is a
// never-called stub (typed `never`, assignable to any return type), which
// keeps this a real, type-safe `LevelEngineSurface` without an `as any`.
const engineStub: LevelEngineSurface = {
    scene: null,
    physicsWorld: null,
    getDynamicObjectManager: () => { throw new Error('not exercised by installNavmesh'); },
    getPlayerController: () => null,
    applyFogConfig: () => {},
    applyLightingConfig: () => {},
    applyWaterSurface: () => {},
    getLightingConfig: () => null,
    refreshEnvironmentLights: () => {},
    warmUpLoadedScene: async () => {},
};

// A tiny but genuinely valid serialized sidecar (round-trips through the real
// encode/decode path) used as the mocked fetch payload.
const NAV_BYTES = toArrayBuffer(
    buildLayeredNav((lx, lz) => (lx === 0 && lz === 0 ? [0] : []), { cellsPerSide: 1 }).serialize(),
);

// Long enough to clear NavSerialization's header-length check, but 0xFF
// everywhere fails the magic-number check that comes right after — a
// "successfully fetched, but not a real sidecar" payload.
const GARBAGE_BYTES = new Uint8Array(64).fill(0xff).buffer;

function makeGameData(): GameData {
    return ({
        worldProfileData: {
            levels: [
                { id: 'dungeon', name: 'Dungeon', vwldAssetId: 'dungeonAsset' },
                { id: 'city', name: 'City', vwldAssetId: 'cityAsset' },
            ],
            startLevelId: 'dungeon',
        },
        assets: [
            { id: 'dungeonAsset', name: 'Dungeon', url: 'http://x/dungeon.vwld', type: 'vwld', navUrl: 'http://x/dungeon.nav' },
            { id: 'cityAsset', name: 'City', url: 'http://x/city.vwld', type: 'vwld' }, // legacy: no navUrl
        ],
    } as unknown) as GameData;
}

describe('LevelEngineBridge.installNavmesh', () => {
    const originalFetch = global.fetch;
    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
        setGlobalNavMesh(null);
        warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        global.fetch = originalFetch;
        warnSpy.mockRestore();
        setGlobalNavMesh(null);
    });

    test('navUrl present and fetch succeeds installs a real navmesh', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            arrayBuffer: async () => NAV_BYTES,
        }) as unknown as typeof fetch;
        const bridge = new LevelEngineBridge(engineStub, makeGameData());

        await bridge.installNavmesh('dungeon');

        expect(getGlobalNavMesh()).toBeInstanceOf(VoxelNavMesh);
    });

    test('FINDING 1: switching to a level with no navUrl clears the global navmesh, not the previous level\'s', async () => {
        setGlobalNavMesh(new VoxelNavMesh()); // stand-in for the dungeon's already-installed navmesh
        const bridge = new LevelEngineBridge(engineStub, makeGameData());

        await bridge.installNavmesh('city'); // no navUrl authored on this level's asset

        expect(getGlobalNavMesh()).toBeNull();
    });

    test('FINDING 1: a failed sidecar fetch clears the global navmesh, not the previous level\'s', async () => {
        setGlobalNavMesh(new VoxelNavMesh()); // stand-in for a stale navmesh from the level being left
        global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch;
        const bridge = new LevelEngineBridge(engineStub, makeGameData());

        await bridge.installNavmesh('dungeon'); // navUrl present, but the fetch fails

        expect(getGlobalNavMesh()).toBeNull();
    });

    test('FINDING 1 (fix round 2): a corrupt-but-fetched sidecar clears the global navmesh, not the previous level\'s', async () => {
        setGlobalNavMesh(new VoxelNavMesh()); // stand-in for dungeon A's already-installed navmesh
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            arrayBuffer: async () => GARBAGE_BYTES, // fetched fine, but not a real sidecar
        }) as unknown as typeof fetch;
        const bridge = new LevelEngineBridge(engineStub, makeGameData());

        await bridge.installNavmesh('dungeon'); // switching into dungeon B, whose sidecar is corrupt

        expect(getGlobalNavMesh()).toBeNull(); // NOT dungeon A's mesh
        expect(warnSpy).toHaveBeenCalled();
    });
});

// gameData for the respawnPlayer tests below: 'city' (no spawnPoints, the
// legacy/no-nav level from makeGameData()'s shape) switching into 'dungeon',
// which authors ONE player spawn at the TRUE floor Y (clearance 0) — the
// world-forger's convention now that PlayerLoader seats the capsule itself.
function makeGameDataWithDungeonSpawn(): GameData {
    return ({
        worldProfileData: {
            levels: [
                { id: 'city', name: 'City', vwldAssetId: 'cityAsset' },
                {
                    id: 'dungeon', name: 'Dungeon', vwldAssetId: 'dungeonAsset',
                    spawnPoints: [{ id: 'ds', type: 'player', position: { x: 3, y: 12.5, z: -4 }, rotationY: 1.2 }],
                },
            ],
            startLevelId: 'city',
        },
        assets: [
            { id: 'cityAsset', name: 'City', url: 'http://x/city.vwld', type: 'vwld' },
            { id: 'dungeonAsset', name: 'Dungeon', url: 'http://x/dungeon.vwld', type: 'vwld' },
        ],
    } as unknown) as GameData;
}

/**
 * respawnPlayer is intentionally left PRIVATE on LevelEngineBridge — unlike
 * installNavmesh above, which was deliberately made non-private so tests
 * could call it directly, widening respawnPlayer's visibility just for a
 * test would loosen the class's real API. Instead drive it exactly the way
 * production code does: wire it into a real LevelManager's `respawnPlayer`
 * option (same as `createManager()` does internally) and exercise it through
 * the public `loadLevel()` sequencing, same test seam LevelManager.test.ts
 * already uses.
 */
function wireRespawnPlayer(bridge: LevelEngineBridge): (spawn: SpawnPoint | null) => void {
    return (spawn) =>
        (bridge as unknown as { respawnPlayer: (spawn: SpawnPoint | null) => void }).respawnPlayer(spawn);
}

/** Minimal LevelManagerOptions for the respawnPlayer tests: every hand-off
 *  before respawnPlayer (fetch/lock/terrain/content/navmesh/atmosphere) is a
 *  no-op — only respawnPlayer is wired to the real bridge under test. */
function makeRespawnLevelManagerOptions(gameData: GameData, bridge: LevelEngineBridge): LevelManagerOptions {
    return {
        gameData,
        loadTerrain: async () => {},
        reloadSceneContent: async () => {},
        applyAtmosphere: () => {},
        setTransitionLock: () => {},
        noteQualityDisturbance: () => {},
        respawnPlayer: wireRespawnPlayer(bridge),
        sendLevelChange: null,
        installNavmesh: async () => {},
        reportSwitchProgress: () => {},
        warmUpScene: async () => {},
        fetchBuffer: async () => new ArrayBuffer(4),
    };
}

describe('LevelEngineBridge.respawnPlayer (via LevelManager.loadLevel)', () => {
    test('authored spawn: a level switch teleports feet to spawn.position.y + PLAYER_REST_CLEARANCE_M', async () => {
        const teleportTo = jest.fn();
        const fakePlayerController: PlayerControllerLike = {
            getProjectiles: () => [],
            removeProjectile: () => {},
            teleportTo,
        };
        const surface: LevelEngineSurface = {
            ...engineStub,
            getPlayerController: () => fakePlayerController,
        };
        const gameData = makeGameDataWithDungeonSpawn();
        const bridge = new LevelEngineBridge(surface, gameData);
        const lm = new LevelManager(makeRespawnLevelManagerOptions(gameData, bridge));

        await lm.loadLevel('dungeon'); // city -> dungeon, the headline switch

        // Authored floor Y is 12.5 (clearance 0) — must land at 12.5 + PLAYER_REST_CLEARANCE_M,
        // matching PlayerLoader's boot-time seating, not flush with the floor.
        expect(teleportTo).toHaveBeenCalledTimes(1);
        expect(teleportTo).toHaveBeenCalledWith(3, 12.5 + PLAYER_REST_CLEARANCE_M, -4, 1.2);
    });

    test('no spawn authored: fallback to terrain-center surface height + 2 is unchanged', async () => {
        const teleportTo = jest.fn();
        const fakePlayerController: PlayerControllerLike = {
            getProjectiles: () => [],
            removeProjectile: () => {},
            teleportTo,
        };
        // Real VxlSceneTerrainSystem so `terrain instanceof VxlSceneTerrainSystem`
        // holds — construction is cheap (no I/O) and with physicsWorld null,
        // getHeightAt short-circuits to 0 without needing a loaded world.
        const terrain = new VxlSceneTerrainSystem(
            { physicsWorld: null } as unknown as EngineLike,
            DEFAULT_VXL_SCENE_TERRAIN_CONFIG,
        );
        const bounds: TerrainBounds = { minX: 0, minY: 0, minZ: 0, maxX: 10, maxY: 5, maxZ: 20 };
        const dom = {
            getBakedTerrain: () => terrain,
            getTerrainBounds: () => bounds,
        } as unknown as DynamicObjectManager;
        const surface: LevelEngineSurface = {
            ...engineStub,
            getPlayerController: () => fakePlayerController,
            getDynamicObjectManager: () => dom,
        };
        const gameData = makeGameData(); // 'dungeon' and 'city' both have no spawnPoints
        const bridge = new LevelEngineBridge(surface, gameData);
        const lm = new LevelManager(makeRespawnLevelManagerOptions(gameData, bridge));

        await lm.loadLevel('city');

        expect(teleportTo).toHaveBeenCalledTimes(1);
        expect(teleportTo).toHaveBeenCalledWith(5, 2, 10); // center (5,10); getHeightAt->0, +2 fallback lift, untouched by this fix
    });
});
