/**
 * DoorSystem — data-driven lifecycle, level filtering, proximity routing,
 * the id-keyed open/close/lock API, and network delta/snapshot sync.
 *
 * Runs against the same stubbed `EngineLike` shape `DungeonDoor.test.ts` uses:
 * a physics world that records body/collider creation instead of simulating,
 * and a mocked navmesh module so obstacle registration never needs a real
 * VoxelNavMesh. Doors and pickups are REAL `DungeonDoor`/`KeyPickup`
 * instances — the system's job is building and wiring them, so stubbing them
 * out would test nothing.
 */
import * as THREE from 'three';
import { initRapier } from 'engine/physics/RapierPhysics.js';
import { DoorSystem, DOOR_PROXIMITY_INTERVAL_SECONDS, type DoorDelta, type DoorSnapshot } from 'engine/doors/DoorSystem.js';
import { DungeonDoor } from 'engine/doors/DungeonDoor.js';
import { KeyPickup } from 'engine/doors/KeyPickup.js';
import { getInteractionManager, resetInteractionManager } from 'engine/InteractionManager.js';
import type { DoorDefinition, EngineLike, GameData, KeyItemDefinition } from 'types/game.js';

jest.mock('engine/VoxelNavMesh.js', () => ({
    registerObstacleProvider: (getShape: () => unknown) => ({ getShape, currentHandle: 0 }),
    unregisterObstacleProvider: () => { /* no-op */ },
}));

beforeAll(async () => {
    // RigidBodyDesc/ColliderDesc construction goes through the Rapier module.
    await initRapier();
});

// ---- stubs ----------------------------------------------------------------

interface Harness {
    engine: EngineLike;
    worldGroup: THREE.Group;
    /** Run every registered physics pre-step callback for `ms` of simulated time. */
    advance: (ms: number, dtMs?: number) => void;
}

function makeHarness(withPhysics = true): Harness {
    const preStep: Array<(dt: number) => void> = [];
    let nextHandle = 1;

    const physicsWorld = {
        createRigidBody: jest.fn(() => ({
            setNextKinematicTranslation: jest.fn(),
            setNextKinematicRotation: jest.fn(),
            setTranslation: jest.fn(),
            isValid: () => true,
        })),
        createCollider: jest.fn(() => ({
            handle: nextHandle++,
            setEnabled: jest.fn(),
            isValid: () => true,
        })),
        registerPreStepCallback: jest.fn((cb: (dt: number) => void) => { preStep.push(cb); }),
        unregisterPreStepCallback: jest.fn((cb: (dt: number) => void) => {
            const i = preStep.indexOf(cb);
            if (i >= 0) preStep.splice(i, 1);
        }),
        removeCollider: jest.fn(),
        removeRigidBody: jest.fn(),
    };

    const worldGroup = new THREE.Group();
    const engine = {
        physicsWorld: withPhysics ? physicsWorld : null,
        scene: new THREE.Scene(),
        getWorldGroup: () => worldGroup,
    } as unknown as EngineLike;

    return {
        engine,
        worldGroup,
        advance: (ms: number, dtMs = 100) => {
            const steps = Math.round(ms / dtMs);
            for (let i = 0; i < steps; i++) {
                for (const cb of [...preStep]) cb(dtMs / 1000);
            }
        },
    };
}

function doorDef(overrides: Partial<DoorDefinition> = {}): DoorDefinition {
    return {
        id: 'door_1',
        position: { x: 0, y: 1, z: 0 },
        rotationY: 0,
        width: 2,
        height: 3,
        thickness: 0.2,
        kind: 'plain',
        animation: 'slide',
        ...overrides,
    };
}

function keyDef(overrides: Partial<KeyItemDefinition> = {}): KeyItemDefinition {
    return {
        id: 'key_1',
        keyId: 'brass_key',
        name: 'Brass Key',
        position: { x: 5, y: 1, z: 5 },
        ...overrides,
    };
}

function gameData(doors: DoorDefinition[] = [], keyItems: KeyItemDefinition[] = []): GameData {
    return { worldProfileData: { doors, keyItems } } as unknown as GameData;
}

interface SystemFixture {
    system: DoorSystem;
    harness: Harness;
    emitted: DoorDelta[];
    notified: string[];
    /** Count of `network.requestSnapshot()` calls. */
    snapshotRequests: number;
    positions: Array<{ x: number; y: number; z: number }>;
}

function makeSystem(data: GameData, opts: { networked?: boolean; withPhysics?: boolean } = {}): SystemFixture {
    const harness = makeHarness(opts.withPhysics ?? true);
    const emitted: DoorDelta[] = [];
    const notified: string[] = [];
    const positions: Array<{ x: number; y: number; z: number }> = [];
    const fixture = {
        harness,
        emitted,
        notified,
        snapshotRequests: 0,
        positions,
    } as SystemFixture;
    fixture.system = new DoorSystem(harness.engine, {
        getGameData: () => data,
        getCharacterPositions: () => positions,
        network: (opts.networked ?? true) ? {
            emit: (delta) => { emitted.push(delta); },
            requestSnapshot: () => { fixture.snapshotRequests += 1; },
        } : null,
        notify: (message) => { notified.push(message); },
    });
    return fixture;
}

/**
 * The `Interactable` a `DungeonDoor` registered — the real path the E key
 * takes. Captured off the InteractionManager rather than reached for on the
 * system, which deliberately exposes ids, not door objects.
 */
function registeredDoors(register: jest.SpyInstance): DungeonDoor[] {
    return register.mock.calls.map((call) => {
        const component = call[1] as { getInteractable(): unknown };
        return component.getInteractable() as DungeonDoor;
    });
}

/** The `Collectible` a `KeyPickup` registered, via the same route. */
function registeredCollectibles(registerCollectible: jest.SpyInstance): Array<{ onCollect(): void }> {
    return registerCollectible.mock.calls.map((call) => {
        const component = call[1] as { getCollectible(): { onCollect(): void } };
        return component.getCollectible();
    });
}

/** One proximity sweep's worth of simulated time. */
const SWEEP = DOOR_PROXIMITY_INTERVAL_SECONDS;

// The InteractionManager is a module singleton keyed by collider handle, and
// each harness numbers its handles from 1 — reset it so registrations from one
// test can't shadow the next one's.
beforeEach(() => {
    resetInteractionManager();
});

// ---- tests ----------------------------------------------------------------

describe('DoorSystem.gameDataHasDoors', () => {
    it('is true when the world declares doors', () => {
        expect(DoorSystem.gameDataHasDoors(gameData([doorDef()]))).toBe(true);
    });

    it('is true when the world declares only key items', () => {
        expect(DoorSystem.gameDataHasDoors(gameData([], [keyDef()]))).toBe(true);
    });

    it('is false for a world with neither', () => {
        expect(DoorSystem.gameDataHasDoors(gameData())).toBe(false);
        expect(DoorSystem.gameDataHasDoors({} as GameData)).toBe(false);
    });
});

describe('DoorSystem.initForLevel — level filtering', () => {
    it('builds only doors belonging to the active level, plus untagged globals', () => {
        const f = makeSystem(gameData([
            doorDef({ id: 'crypt_door', levelId: 'crypt' }),
            doorDef({ id: 'tower_door', levelId: 'tower' }),
            doorDef({ id: 'global_door' }),
        ]));

        f.system.initForLevel('crypt');

        expect(f.system.getDoorState('crypt_door')).toBe('closed');
        expect(f.system.getDoorState('global_door')).toBe('closed');
        expect(f.system.getDoorState('tower_door')).toBeNull();
    });

    it('builds every door in legacy mode (null active level)', () => {
        const f = makeSystem(gameData([
            doorDef({ id: 'crypt_door', levelId: 'crypt' }),
            doorDef({ id: 'tower_door', levelId: 'tower' }),
        ]));

        f.system.initForLevel(null);

        expect(f.system.getDoorState('crypt_door')).toBe('closed');
        expect(f.system.getDoorState('tower_door')).toBe('closed');
    });

    it('spawns key pickups for the active level only', () => {
        const spawned: string[] = [];
        const spy = jest.spyOn(KeyPickup.prototype, 'dispose');
        const f = makeSystem(gameData([], [
            keyDef({ id: 'k_crypt', keyId: 'crypt_key', levelId: 'crypt' }),
            keyDef({ id: 'k_tower', keyId: 'tower_key', levelId: 'tower' }),
        ]));

        f.system.initForLevel('crypt');
        // The crypt key's fallback box mesh is the only thing in the world group.
        for (const child of f.harness.worldGroup.children) spawned.push(child.type);
        expect(spawned).toHaveLength(1);

        f.system.dispose();
        spy.mockRestore();
    });

    it('skips a key pickup whose key is already held (re-entering a level)', () => {
        const pickupDispose = jest.spyOn(KeyPickup.prototype, 'dispose');
        const f = makeSystem(gameData([], [keyDef()]));

        f.system.initForLevel(null);
        expect(f.harness.worldGroup.children).toHaveLength(1);

        // Collecting drops the pickup from the tracked set...
        f.system.getKeyring().grant('brass_key');
        f.system.initForLevel(null);
        expect(f.harness.worldGroup.children).toHaveLength(0);

        // ...and nothing was constructed to replace it: the next rebuild has
        // no pickup to tear down. (An inert already-held KeyPickup spawns no
        // mesh either, so the world group alone can't tell the two apart.)
        pickupDispose.mockClear();
        f.system.initForLevel(null);
        expect(pickupDispose).not.toHaveBeenCalled();

        f.system.dispose();
        pickupDispose.mockRestore();
    });

    it('disposes the previous level\'s doors and pickups before building the next', () => {
        const doorDispose = jest.spyOn(DungeonDoor.prototype, 'dispose');
        const pickupDispose = jest.spyOn(KeyPickup.prototype, 'dispose');
        const f = makeSystem(gameData(
            [doorDef({ id: 'crypt_door', levelId: 'crypt' }), doorDef({ id: 'tower_door', levelId: 'tower' })],
            [keyDef({ levelId: 'crypt' })],
        ));

        f.system.initForLevel('crypt');
        doorDispose.mockClear();
        pickupDispose.mockClear();

        f.system.initForLevel('tower');

        expect(doorDispose).toHaveBeenCalledTimes(1);
        expect(pickupDispose).toHaveBeenCalledTimes(1);
        expect(f.system.getDoorState('crypt_door')).toBeNull();
        expect(f.system.getDoorState('tower_door')).toBe('closed');

        f.system.dispose();
        doorDispose.mockRestore();
        pickupDispose.mockRestore();
    });

    it('skips doors and pickups (with a warning) when the game has no physics world', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });
        const f = makeSystem(gameData([doorDef()], [keyDef()]), { withPhysics: false });

        expect(() => f.system.initForLevel(null)).not.toThrow();
        expect(f.system.getDoorState('door_1')).toBeNull();
        expect(warn).toHaveBeenCalled();

        warn.mockRestore();
    });
});

describe('DoorSystem.update — proximity routing', () => {
    it('feeds the injected character positions into every door', () => {
        const spy = jest.spyOn(DungeonDoor.prototype, 'updateProximity');
        const f = makeSystem(gameData([doorDef({ id: 'a' }), doorDef({ id: 'b' })]));
        f.system.initForLevel(null);
        f.positions.push({ x: 1, y: 1, z: 0 });
        spy.mockClear();

        f.system.update(SWEEP);

        expect(spy).toHaveBeenCalledTimes(2);
        expect(spy.mock.calls[0]![0]).toEqual([{ x: 1, y: 1, z: 0 }]);

        f.system.dispose();
        spy.mockRestore();
    });

    it('sweeps at a fixed interval rather than every frame', () => {
        const spy = jest.spyOn(DungeonDoor.prototype, 'updateProximity');
        const f = makeSystem(gameData([doorDef()]));
        f.system.initForLevel(null);
        spy.mockClear();

        // First tick sweeps immediately, then the accumulator has to refill.
        f.system.update(0.001);
        expect(spy).toHaveBeenCalledTimes(1);
        f.system.update(0.001);
        expect(spy).toHaveBeenCalledTimes(1);
        f.system.update(SWEEP);
        expect(spy).toHaveBeenCalledTimes(2);

        f.system.dispose();
        spy.mockRestore();
    });

    it('auto-opens a door the player walks up to', () => {
        const f = makeSystem(gameData([doorDef()]));
        f.system.initForLevel(null);

        f.positions.push({ x: 1, y: 1, z: 0 });
        f.system.update(SWEEP);

        expect(f.system.getDoorState('door_1')).toBe('opening');
        f.system.dispose();
    });

    it('does nothing once disposed', () => {
        const spy = jest.spyOn(DungeonDoor.prototype, 'updateProximity');
        const f = makeSystem(gameData([doorDef()]));
        f.system.initForLevel(null);
        f.system.dispose();
        spy.mockClear();

        f.system.update(SWEEP);

        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });
});

describe('DoorSystem — id-keyed API', () => {
    it('opens, closes, locks and unlocks by id', () => {
        const f = makeSystem(gameData([doorDef()]));
        f.system.initForLevel(null);

        expect(f.system.openDoor('door_1')).toBe(true);
        expect(f.system.getDoorState('door_1')).toBe('opening');

        expect(f.system.closeDoor('door_1')).toBe(true);
        expect(f.system.getDoorState('door_1')).toBe('closing');

        expect(f.system.lockDoor('door_1')).toBe(true);
        expect(f.system.unlockDoor('door_1')).toBe(true);

        f.system.dispose();
    });

    it('a locked door ignores an approaching player', () => {
        const f = makeSystem(gameData([doorDef()]));
        f.system.initForLevel(null);
        f.system.lockDoor('door_1');

        f.positions.push({ x: 1, y: 1, z: 0 });
        f.system.update(SWEEP);

        expect(f.system.getDoorState('door_1')).toBe('closed');
        f.system.dispose();
    });

    it('returns false for an unknown door id', () => {
        const f = makeSystem(gameData([doorDef()]));
        f.system.initForLevel(null);

        expect(f.system.openDoor('nope')).toBe(false);
        expect(f.system.closeDoor('nope')).toBe(false);
        expect(f.system.lockDoor('nope')).toBe(false);
        expect(f.system.unlockDoor('nope')).toBe(false);
        expect(f.system.getDoorState('nope')).toBeNull();

        f.system.dispose();
    });
});

describe('DoorSystem — network deltas', () => {
    it('emits a delta on every local door state change', () => {
        const f = makeSystem(gameData([doorDef()]));
        f.system.initForLevel(null);

        f.system.openDoor('door_1');
        expect(f.emitted).toEqual([{ doorId: 'door_1', state: 'opening' }]);

        f.harness.advance(1000);
        expect(f.emitted).toEqual([
            { doorId: 'door_1', state: 'opening' },
            { doorId: 'door_1', state: 'open' },
        ]);

        f.system.dispose();
    });

    it('emits a delta when a key is granted', () => {
        const f = makeSystem(gameData([], [keyDef()]));
        f.system.initForLevel(null);

        f.system.getKeyring().grant('brass_key');

        expect(f.emitted).toEqual([{ grantKey: 'brass_key' }]);
        f.system.dispose();
    });

    it('applies a remote door state without re-emitting it', () => {
        const f = makeSystem(gameData([doorDef()]));
        f.system.initForLevel(null);

        f.system.applyDelta({ doorId: 'door_1', state: 'opening' });
        f.harness.advance(1000);

        expect(f.system.getDoorState('door_1')).toBe('open');
        expect(f.emitted).toEqual([]);

        f.system.dispose();
    });

    it('applies a remote key grant without re-emitting it', () => {
        const f = makeSystem(gameData([], [keyDef()]));
        f.system.initForLevel(null);

        f.system.applyDelta({ grantKey: 'brass_key' });

        expect(f.system.getKeyring().has('brass_key')).toBe(true);
        expect(f.emitted).toEqual([]);

        f.system.dispose();
    });

    it('removes the local pickup when the key is collected by another player', () => {
        const f = makeSystem(gameData([], [keyDef()]));
        f.system.initForLevel(null);
        expect(f.harness.worldGroup.children).toHaveLength(1);

        f.system.applyDelta({ grantKey: 'brass_key' });

        expect(f.harness.worldGroup.children).toHaveLength(0);
        f.system.dispose();
    });

    it('is fully functional in single-player with no network', () => {
        const f = makeSystem(gameData([doorDef()], [keyDef()]), { networked: false });
        f.system.initForLevel(null);

        expect(() => f.system.openDoor('door_1')).not.toThrow();
        expect(() => f.system.getKeyring().grant('brass_key')).not.toThrow();
        expect(f.system.getDoorState('door_1')).toBe('opening');

        f.system.dispose();
    });
});

describe('DoorSystem — snapshots', () => {
    it('serializes live door states and held keys', () => {
        const f = makeSystem(gameData([doorDef({ id: 'a' }), doorDef({ id: 'b' })], [keyDef()]));
        f.system.initForLevel(null);
        f.system.openDoor('a');
        f.system.getKeyring().grant('brass_key');

        const snapshot = f.system.serializeSnapshot();

        expect(snapshot).toEqual({ doors: { a: 'opening', b: 'closed' }, keys: ['brass_key'] });
        f.system.dispose();
    });

    it('restores door states and keys without re-emitting', () => {
        const f = makeSystem(gameData([doorDef({ id: 'a' })], [keyDef()]));
        f.system.initForLevel(null);
        // Door leaf + key pickup.
        expect(f.harness.worldGroup.children).toHaveLength(2);

        f.system.applySnapshot({ doors: { a: 'open' }, keys: ['brass_key'] });

        expect(f.system.getDoorState('a')).toBe('open');
        expect(f.system.getKeyring().has('brass_key')).toBe(true);
        expect(f.emitted).toEqual([]);
        // A key held per the snapshot despawns its pickup — no duplicate key.
        // The door leaf is all that's left.
        expect(f.harness.worldGroup.children).toHaveLength(1);

        f.system.dispose();
    });

    it('ignores a malformed snapshot payload off the wire', () => {
        const f = makeSystem(gameData([doorDef({ id: 'a' })]));
        f.system.initForLevel(null);

        expect(() => f.system.applySnapshot({} as unknown as DoorSnapshot)).not.toThrow();
        expect(f.system.getDoorState('a')).toBe('closed');

        f.system.dispose();
    });
});

describe('DoorSystem — notifications', () => {
    it('routes a key pickup collect through the injected notify sink', () => {
        const registerCollectible = jest.spyOn(getInteractionManager(), 'registerCollectible');
        const f = makeSystem(gameData([], [keyDef()]));
        f.system.initForLevel(null);

        const collectibles = registeredCollectibles(registerCollectible);
        expect(collectibles).toHaveLength(1);
        collectibles[0]!.onCollect();

        expect(f.notified).toEqual(['Picked up: Brass Key']);
        expect(f.system.getKeyring().has('brass_key')).toBe(true);
        // Collecting despawns the pickup.
        expect(f.harness.worldGroup.children).toHaveLength(0);

        f.system.dispose();
        registerCollectible.mockRestore();
    });

    it('routes a door key-unlock through the same sink', () => {
        const register = jest.spyOn(getInteractionManager(), 'register');
        const f = makeSystem(gameData([doorDef({ kind: 'locked', keyId: 'brass_key' })]));
        f.system.initForLevel(null);
        f.system.getKeyring().grant('brass_key');
        f.notified.length = 0;

        const doors = registeredDoors(register);
        expect(doors).toHaveLength(1);
        expect(doors[0]!.onInteractStart()).toBe(true);

        expect(f.notified).toEqual(['Unlocked with brass_key']);
        expect(f.system.getDoorState('door_1')).toBe('opening');

        f.system.dispose();
        register.mockRestore();
    });
});

describe('DoorSystem — snapshot requests', () => {
    it('asks the host for the live state every time a level is built', () => {
        const f = makeSystem(gameData([doorDef({ id: 'crypt_door', levelId: 'crypt' })]));

        f.system.initForLevel('crypt');
        expect(f.snapshotRequests).toBe(1);

        // A level switch rebuilds doors closed — it has to re-converge.
        f.system.initForLevel('crypt');
        expect(f.snapshotRequests).toBe(2);

        f.system.dispose();
    });

    it('does not ask when the level declares no doors or keys', () => {
        const f = makeSystem(gameData([doorDef({ levelId: 'crypt' })]));

        f.system.initForLevel('tower');

        expect(f.snapshotRequests).toBe(0);
        f.system.dispose();
    });

    it('does not ask in single-player', () => {
        const f = makeSystem(gameData([doorDef()]), { networked: false });
        expect(() => f.system.initForLevel(null)).not.toThrow();
        expect(f.snapshotRequests).toBe(0);
        f.system.dispose();
    });
});

describe('DoorSystem.unloadLevel', () => {
    it('drops doors and pickups without rebuilding, and keeps the keyring', () => {
        const f = makeSystem(gameData([doorDef()], [keyDef()]));
        f.system.initForLevel(null);
        f.system.getKeyring().grant('held_key');
        // Door leaf + key pickup.
        expect(f.harness.worldGroup.children).toHaveLength(2);

        f.system.unloadLevel();

        expect(f.harness.worldGroup.children).toHaveLength(0);
        expect(f.system.getDoorState('door_1')).toBeNull();
        expect(f.system.getKeyring().has('held_key')).toBe(true);

        f.system.dispose();
    });

    it('is a no-op once disposed', () => {
        const f = makeSystem(gameData([doorDef()]));
        f.system.initForLevel(null);
        f.system.dispose();
        expect(() => f.system.unloadLevel()).not.toThrow();
    });
});

describe('DoorSystem.dispose', () => {
    it('tears down doors and pickups and stops emitting', () => {
        const f = makeSystem(gameData([doorDef()], [keyDef()]));
        f.system.initForLevel(null);

        f.system.dispose();

        expect(f.harness.worldGroup.children).toHaveLength(0);
        expect(f.system.getDoorState('door_1')).toBeNull();

        f.emitted.length = 0;
        f.system.getKeyring().grant('brass_key');
        f.system.applyDelta({ grantKey: 'other' });
        expect(f.emitted).toEqual([]);
    });

    it('is idempotent', () => {
        const f = makeSystem(gameData([doorDef()]));
        f.system.initForLevel(null);
        f.system.dispose();
        expect(() => f.system.dispose()).not.toThrow();
    });
});
