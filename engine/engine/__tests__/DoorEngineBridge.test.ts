/**
 * @jest-environment jsdom
 */
/**
 * DoorEngineBridge — the engine-side wiring GameEngine delegates to: ONE
 * shared HUD toast for every door and pickup, the level-switch hooks, and the
 * multiplayer stream's configuration.
 *
 * jsdom, not node: the bridge constructs a real `InGameNotification`, which
 * owns a DOM container — and "exactly one container exists" is precisely what
 * the shared-notify test has to prove.
 *
 * `SharedMultiplayerState` is mocked so the stream's constructor options are
 * observable (the persistence ruling is a config value, not a behaviour) and
 * so no timers or sockets are opened.
 */
import * as THREE from 'three';
import { initRapier } from 'engine/physics/RapierPhysics.js';
import { DoorEngineBridge } from 'engine/doors/DoorEngineBridge.js';
import { DOORS_SNAPSHOT_REQUEST_EVENT } from 'engine/doors/DoorNetworkSync.js';
import type { DoorDelta, DoorSnapshot } from 'engine/doors/DoorSystem.js';
import { getInteractionManager, resetInteractionManager } from 'engine/InteractionManager.js';
import { setActiveLevelManager } from 'engine/levels/levelManagerRegistry.js';
import type { LevelManager } from 'engine/levels/LevelManager.js';
import type { DungeonDoor } from 'engine/doors/DungeonDoor.js';
import type { EngineLike, GameData } from 'types/game.js';

jest.mock('engine/VoxelNavMesh.js', () => ({
    registerObstacleProvider: (getShape: () => unknown) => ({ getShape, currentHandle: 0 }),
    unregisterObstacleProvider: () => { /* no-op */ },
}));

interface SharedOptions {
    name: string;
    isHost: () => boolean;
    applyDelta: (delta: DoorDelta, senderId: string) => void;
    serializeSnapshot: () => DoorSnapshot;
    applySnapshot: (snapshot: DoorSnapshot) => void;
    persistFlushIntervalMs?: number;
}

const sharedOptions: SharedOptions[] = [];
const sharedEmit = jest.fn();

jest.mock('engine/networking/SharedMultiplayerState.js', () => ({
    SharedMultiplayerState: class {
        constructor(opts: SharedOptions) { sharedOptions.push(opts); }
        start(): Promise<void> { return Promise.resolve(); }
        emit(delta: DoorDelta): void { sharedEmit(delta); }
        dispose(): void { /* no-op */ }
    },
}));

beforeAll(async () => {
    await initRapier();
});

// ---- stubs ----------------------------------------------------------------

interface NetworkStub {
    events: { on: jest.Mock; off: jest.Mock };
    sendEvent: jest.Mock;
    getLocalPlayerId: () => string;
}

interface BridgeFixture {
    engine: EngineLike;
    worldGroup: THREE.Group;
    network: NetworkStub | null;
    levelHooks: { willUnload: Array<() => void>; didLoad: Array<(levelId: string) => void> };
}

function makeEngine(opts: { networked?: boolean } = {}): BridgeFixture {
    let nextHandle = 1;
    const physicsWorld = {
        createRigidBody: jest.fn(() => ({
            setNextKinematicTranslation: jest.fn(),
            setNextKinematicRotation: jest.fn(),
            setTranslation: jest.fn(),
            isValid: () => true,
        })),
        createCollider: jest.fn(() => ({ handle: nextHandle++, setEnabled: jest.fn(), isValid: () => true })),
        registerPreStepCallback: jest.fn(),
        unregisterPreStepCallback: jest.fn(),
        removeCollider: jest.fn(),
        removeRigidBody: jest.fn(),
    };

    const network: NetworkStub | null = opts.networked
        ? {
            events: { on: jest.fn(), off: jest.fn() },
            sendEvent: jest.fn(),
            getLocalPlayerId: () => 'local_player',
        }
        : null;

    const worldGroup = new THREE.Group();
    const engine = {
        physicsWorld,
        scene: new THREE.Scene(),
        getWorldGroup: () => worldGroup,
        getPlayerController: () => null,
        genreModule: network ? { getNetworkManager: () => network } : null,
        getGameDataService: () => ({}),
    } as unknown as EngineLike;

    const levelHooks = {
        willUnload: [] as Array<() => void>,
        didLoad: [] as Array<(levelId: string) => void>,
    };
    setActiveLevelManager({
        getActiveLevelId: () => 'crypt',
        onLevelWillUnload: (cb: () => void) => { levelHooks.willUnload.push(cb); },
        onLevelDidLoad: (cb: (levelId: string) => void) => { levelHooks.didLoad.push(cb); },
    } as unknown as LevelManager);

    return { engine, worldGroup, network, levelHooks };
}

function gameData(): GameData {
    return {
        worldProfileData: {
            doors: [{
                id: 'crypt_door',
                levelId: 'crypt',
                position: { x: 0, y: 1, z: 0 },
                rotationY: 0,
                width: 2,
                height: 3,
                thickness: 0.2,
                kind: 'locked',
                keyId: 'brass_key',
                animation: 'slide',
            }, {
                id: 'tower_door',
                levelId: 'tower',
                position: { x: 20, y: 1, z: 0 },
                rotationY: 0,
                width: 2,
                height: 3,
                thickness: 0.2,
                kind: 'plain',
                animation: 'slide',
            }],
            keyItems: [{
                id: 'k1',
                keyId: 'brass_key',
                levelId: 'crypt',
                name: 'Brass Key',
                position: { x: 5, y: 1, z: 5 },
            }],
        },
    } as unknown as GameData;
}

function notificationContainers(): number {
    return document.querySelectorAll('#in-game-notification').length;
}

beforeEach(() => {
    resetInteractionManager();
    sharedOptions.length = 0;
    sharedEmit.mockClear();
    document.body.innerHTML = '';
});

afterEach(() => {
    setActiveLevelManager(null);
});

// ---- tests ----------------------------------------------------------------

describe('DoorEngineBridge — construction', () => {
    it('skips a game that declares no doors or key items', () => {
        expect(DoorEngineBridge.gameDataHasDoors({} as GameData)).toBe(false);
        expect(DoorEngineBridge.gameDataHasDoors(gameData())).toBe(true);
    });

    it('builds the active level only, and disposes everything it owns', () => {
        const f = makeEngine();
        const bridge = new DoorEngineBridge(f.engine, gameData());

        expect(bridge.getSystem().getDoorState('crypt_door')).toBe('closed');
        expect(bridge.getSystem().getDoorState('tower_door')).toBeNull();
        expect(notificationContainers()).toBe(1);

        bridge.dispose();
        expect(f.worldGroup.children).toHaveLength(0);
        expect(notificationContainers()).toBe(0);
    });
});

describe('DoorEngineBridge — one shared notify sink', () => {
    it('sends the door unlock and the key pickup to the SAME toast instance', () => {
        const register = jest.spyOn(getInteractionManager(), 'register');
        const registerCollectible = jest.spyOn(getInteractionManager(), 'registerCollectible');
        const f = makeEngine();
        const bridge = new DoorEngineBridge(f.engine, gameData());

        // Exactly one InGameNotification exists — the door's own
        // DEFAULT_DOOR_NOTIFY would have created a second container.
        expect(notificationContainers()).toBe(1);
        const container = document.querySelector('#in-game-notification');

        // Collect the key: the pickup's message goes through the shared sink.
        const collectible = (registerCollectible.mock.calls[0]![1] as unknown as {
            getCollectible(): { onCollect(): void };
        }).getCollectible();
        collectible.onCollect();
        expect(container?.innerHTML).toBe('Picked up: Brass Key');

        // Unlock the door with it: same container, so the same function.
        const door = (register.mock.calls[0]![1] as unknown as {
            getInteractable(): DungeonDoor;
        }).getInteractable();
        expect(door.onInteractStart()).toBe(true);
        expect(notificationContainers()).toBe(1);
        expect(container?.innerHTML).toBe('Unlocked with brass_key');

        bridge.dispose();
        register.mockRestore();
        registerCollectible.mockRestore();
    });
});

describe('DoorEngineBridge — level hooks', () => {
    it('re-initialises for the level that just loaded', () => {
        const f = makeEngine();
        const bridge = new DoorEngineBridge(f.engine, gameData());
        expect(f.levelHooks.didLoad).toHaveLength(1);

        f.levelHooks.didLoad[0]!('tower');

        expect(bridge.getSystem().getDoorState('tower_door')).toBe('closed');
        expect(bridge.getSystem().getDoorState('crypt_door')).toBeNull();

        bridge.dispose();
    });

    it('tears the outgoing level down before the switch', () => {
        const f = makeEngine();
        const bridge = new DoorEngineBridge(f.engine, gameData());
        expect(f.levelHooks.willUnload).toHaveLength(1);
        // Door leaf + key pickup.
        expect(f.worldGroup.children).toHaveLength(2);

        f.levelHooks.willUnload[0]!();

        // Nothing of the old level survives into the new level's navmesh install.
        expect(f.worldGroup.children).toHaveLength(0);
        expect(bridge.getSystem().getDoorState('crypt_door')).toBeNull();

        bridge.dispose();
    });

    it('ignores level hooks that fire after dispose', () => {
        const f = makeEngine();
        const bridge = new DoorEngineBridge(f.engine, gameData());
        bridge.dispose();

        expect(() => f.levelHooks.willUnload[0]!()).not.toThrow();
        expect(() => f.levelHooks.didLoad[0]!('tower')).not.toThrow();
        expect(bridge.getSystem().getDoorState('tower_door')).toBeNull();
    });
});

describe('DoorEngineBridge — multiplayer stream', () => {
    it('builds no stream without a NetworkManager', () => {
        const f = makeEngine({ networked: false });
        const bridge = new DoorEngineBridge(f.engine, gameData());

        expect(sharedOptions).toHaveLength(0);
        // Single-player still works in full.
        expect(bridge.getSystem().openDoor('crypt_door')).toBe(true);
        expect(sharedEmit).not.toHaveBeenCalled();

        bridge.dispose();
    });

    it('configures the "doors" stream as LIVE-ONLY (never persisted)', () => {
        const f = makeEngine({ networked: true });
        const bridge = new DoorEngineBridge(f.engine, gameData());

        expect(sharedOptions).toHaveLength(1);
        const opts = sharedOptions[0]!;
        expect(opts.name).toBe('doors');
        // Persisting {keys} would pre-solve the dungeon for every future
        // session — dungeon progression is session-scoped by ruling.
        expect(opts.persistFlushIntervalMs).toBe(0);

        bridge.dispose();
    });

    it('requests a snapshot on build and on every level switch', () => {
        const f = makeEngine({ networked: true });
        const bridge = new DoorEngineBridge(f.engine, gameData());

        const requests = () => f.network!.sendEvent.mock.calls
            .filter((call) => call[0] === DOORS_SNAPSHOT_REQUEST_EVENT).length;
        expect(requests()).toBe(1);

        f.levelHooks.didLoad[0]!('tower');
        expect(requests()).toBe(2);

        bridge.dispose();
    });

    it('pipes local door changes out and remote deltas back in', () => {
        const f = makeEngine({ networked: true });
        const bridge = new DoorEngineBridge(f.engine, gameData());

        bridge.getSystem().openDoor('crypt_door');
        expect(sharedEmit).toHaveBeenCalledWith({ doorId: 'crypt_door', state: 'opening' });

        sharedEmit.mockClear();
        sharedOptions[0]!.applyDelta({ grantKey: 'brass_key' }, 'peer');
        expect(bridge.getSystem().getKeyring().has('brass_key')).toBe(true);
        expect(sharedEmit).not.toHaveBeenCalled();

        expect(sharedOptions[0]!.serializeSnapshot().keys).toEqual(['brass_key']);

        bridge.dispose();
    });
});
