/**
 * DungeonDoor — state machine, animation, proximity, lock/nav and lifecycle
 * tests.
 *
 * Everything runs against a stubbed `EngineLike`: the physics world records
 * the kinematic calls instead of simulating them, and the pre-step callback
 * the door registers is captured so each test advances time with a fixed dt
 * rather than waiting on real frames. The navmesh module is mocked so
 * obstacle registration is observable without building a real VoxelNavMesh.
 */
import * as THREE from 'three';
import { initRapier } from 'engine/physics/RapierPhysics.js';
import { Keyring } from 'engine/doors/Keyring.js';
import {
    DungeonDoor,
    DOOR_ANIM_MS,
    DOOR_CLOSE_DELAY_MS,
    DEFAULT_DOOR_AUTO_OPEN_RADIUS,
    type DungeonDoorState,
} from 'engine/doors/DungeonDoor.js';
import type { DoorDefinition, EngineLike } from 'types/game.js';
import type { SpawnedAsset } from 'engine/AssetSpawner.js';

// The navmesh singleton is module-level state shared by the whole engine;
// mocking it keeps obstacle registration observable (and per-test isolated)
// without standing up a real navmesh.
const mockNavRegister = jest.fn();
const mockNavUnregister = jest.fn();
jest.mock('engine/VoxelNavMesh.js', () => ({
    registerObstacleProvider: (getShape: () => unknown) => {
        mockNavRegister(getShape);
        return { getShape, currentHandle: 0 };
    },
    unregisterObstacleProvider: (provider: unknown) => {
        mockNavUnregister(provider);
    },
}));

beforeAll(async () => {
    // RigidBodyDesc/ColliderDesc construction goes through the Rapier module.
    await initRapier();
});

// ---- stubs ----------------------------------------------------------------

interface Vec3Like { x: number; y: number; z: number }
interface QuatLike { x: number; y: number; z: number; w: number }

interface StubBody {
    setNextKinematicTranslation: jest.Mock<void, [Vec3Like]>;
    setNextKinematicRotation: jest.Mock<void, [QuatLike]>;
    setTranslation: jest.Mock;
    isValid: () => boolean;
}

interface StubCollider {
    handle: number;
    setEnabled: jest.Mock<void, [boolean]>;
    isValid: () => boolean;
}

interface Harness {
    engine: EngineLike;
    /** Bodies in creation order — [0] is the door body, [1] the interact sensor. */
    bodies: StubBody[];
    /** Colliders in creation order — [0] is the door collider, [1] the sensor. */
    colliders: StubCollider[];
    preStep: Array<(dt: number) => void>;
    unregisterPreStepCallback: jest.Mock;
    removeCollider: jest.Mock;
    removeRigidBody: jest.Mock;
    worldGroup: THREE.Group;
    /** Run the door's pre-step callback for `ms` of simulated time. */
    advance: (ms: number, dtMs?: number) => void;
}

function makeHarness(extra: Partial<Record<string, unknown>> = {}): Harness {
    const bodies: StubBody[] = [];
    const colliders: StubCollider[] = [];
    const preStep: Array<(dt: number) => void> = [];
    let nextHandle = 1;

    const unregisterPreStepCallback = jest.fn((cb: (dt: number) => void) => {
        const i = preStep.indexOf(cb);
        if (i >= 0) preStep.splice(i, 1);
    });
    const removeCollider = jest.fn();
    const removeRigidBody = jest.fn();

    const physicsWorld = {
        createRigidBody: jest.fn(() => {
            const body: StubBody = {
                setNextKinematicTranslation: jest.fn(),
                setNextKinematicRotation: jest.fn(),
                setTranslation: jest.fn(),
                isValid: () => true,
            };
            bodies.push(body);
            return body;
        }),
        createCollider: jest.fn(() => {
            const collider: StubCollider = {
                handle: nextHandle++,
                setEnabled: jest.fn(),
                isValid: () => true,
            };
            colliders.push(collider);
            return collider;
        }),
        registerPreStepCallback: jest.fn((cb: (dt: number) => void) => { preStep.push(cb); }),
        unregisterPreStepCallback,
        removeCollider,
        removeRigidBody,
    };

    const worldGroup = new THREE.Group();
    const engine = {
        physicsWorld,
        scene: new THREE.Scene(),
        getWorldGroup: () => worldGroup,
        ...extra,
    } as unknown as EngineLike;

    return {
        engine,
        bodies,
        colliders,
        preStep,
        unregisterPreStepCallback,
        removeCollider,
        removeRigidBody,
        worldGroup,
        advance: (ms: number, dtMs = 100) => {
            const steps = Math.round(ms / dtMs);
            for (let i = 0; i < steps; i++) {
                for (const cb of [...preStep]) cb(dtMs / 1000);
            }
        },
    };
}

function baseDef(overrides: Partial<DoorDefinition> = {}): DoorDefinition {
    return {
        id: 'door_1',
        position: { x: 10, y: 1, z: 5 },
        rotationY: 0,
        width: 2,
        height: 3,
        thickness: 0.2,
        kind: 'plain',
        animation: 'slide',
        ...overrides,
    };
}

function lastTranslation(body: StubBody): Vec3Like {
    const calls = body.setNextKinematicTranslation.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    return calls[calls.length - 1]![0];
}

function lastRotation(body: StubBody): QuatLike {
    const calls = body.setNextKinematicRotation.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    return calls[calls.length - 1]![0];
}

function stateLog(): { events: { onStateChanged: (s: DungeonDoorState) => void }; states: DungeonDoorState[] } {
    const states: DungeonDoorState[] = [];
    return { events: { onStateChanged: (s) => { states.push(s); } }, states };
}

beforeEach(() => {
    mockNavRegister.mockClear();
    mockNavUnregister.mockClear();
});

// ---- tests ----------------------------------------------------------------

describe('DungeonDoor — construction', () => {
    it('exposes its id, starts closed, and starts unlocked for a plain door', () => {
        const h = makeHarness();
        const door = new DungeonDoor(h.engine, baseDef(), new Keyring(), stateLog().events);

        expect(door.id).toBe('door_1');
        expect(door.getState()).toBe('closed');
        expect(door.isLocked()).toBe(false);
        expect(h.preStep).toHaveLength(1);
        // Door body + collider first, then the interact sensor body + collider.
        expect(h.bodies.length).toBeGreaterThanOrEqual(1);
        expect(h.colliders.length).toBeGreaterThanOrEqual(1);

        door.dispose();
    });

    it('starts locked when kind is "locked"', () => {
        const h = makeHarness();
        const door = new DungeonDoor(h.engine, baseDef({ kind: 'locked', keyId: 'brass_key' }), new Keyring(), stateLog().events);
        expect(door.isLocked()).toBe(true);
        door.dispose();
    });

    it('builds the fallback box leaf in the world group when no assetId is given', () => {
        const h = makeHarness();
        const door = new DungeonDoor(h.engine, baseDef(), new Keyring(), stateLog().events);

        expect(h.worldGroup.children).toHaveLength(1);
        const mesh = h.worldGroup.children[0] as THREE.Mesh;
        expect(mesh).toBeInstanceOf(THREE.Mesh);
        expect(mesh.position.toArray()).toEqual([10, 1, 5]);

        door.dispose();
        expect(h.worldGroup.children).toHaveLength(0);
    });

    it('holds the body at the closed pose every frame while at rest', () => {
        const h = makeHarness();
        const door = new DungeonDoor(h.engine, baseDef(), new Keyring(), stateLog().events);

        h.advance(300);
        const pos = lastTranslation(h.bodies[0]!);
        expect(pos.x).toBeCloseTo(10, 5);
        expect(pos.y).toBeCloseTo(1, 5);
        expect(pos.z).toBeCloseTo(5, 5);

        door.dispose();
    });
});

describe('DungeonDoor — slide animation', () => {
    it('reaches the open pose after DOOR_ANIM_MS and fires opening + open exactly once', () => {
        const h = makeHarness();
        const log = stateLog();
        const door = new DungeonDoor(h.engine, baseDef(), new Keyring(), log.events);

        door.open();
        expect(door.getState()).toBe('opening');

        h.advance(DOOR_ANIM_MS);

        expect(door.getState()).toBe('open');
        expect(log.states).toEqual(['opening', 'open']);
        const pos = lastTranslation(h.bodies[0]!);
        // rotationY 0 → door-local +X is world +X; travel is width * 0.95.
        expect(pos.x).toBeCloseTo(10 + 2 * 0.95, 5);
        expect(pos.y).toBeCloseTo(1, 5);
        expect(pos.z).toBeCloseTo(5, 5);

        door.dispose();
    });

    it('slides along the rotated door-local +X axis', () => {
        const h = makeHarness();
        const door = new DungeonDoor(h.engine, baseDef({ rotationY: Math.PI / 2, position: { x: 0, y: 0, z: 0 } }), new Keyring(), stateLog().events);

        door.open();
        h.advance(DOOR_ANIM_MS);

        const pos = lastTranslation(h.bodies[0]!);
        // yaw +90° maps local +X to world -Z.
        expect(pos.x).toBeCloseTo(0, 5);
        expect(pos.z).toBeCloseTo(-1.9, 5);

        door.dispose();
    });

    it('eases the pose with a smoothstep rather than moving linearly', () => {
        const h = makeHarness();
        const door = new DungeonDoor(h.engine, baseDef(), new Keyring(), stateLog().events);

        door.open();
        h.advance(DOOR_ANIM_MS * 0.25, 25);

        const p = 0.25;
        const eased = p * p * (3 - 2 * p); // 0.15625
        const travel = 2 * 0.95;
        const x = lastTranslation(h.bodies[0]!).x;
        expect(x).toBeCloseTo(10 + travel * eased, 4);
        // A linear ramp would be 60% further along at this point.
        expect(x).not.toBeCloseTo(10 + travel * p, 4);

        door.dispose();
    });

    it('drives the fallback leaf mesh with the body', () => {
        const h = makeHarness();
        const door = new DungeonDoor(h.engine, baseDef(), new Keyring(), stateLog().events);
        const mesh = h.worldGroup.children[0] as THREE.Mesh;

        door.open();
        h.advance(DOOR_ANIM_MS);

        expect(mesh.position.x).toBeCloseTo(10 + 1.9, 5);

        door.dispose();
    });

    it('resumes from the current progress when reversed mid-animation', () => {
        const h = makeHarness();
        const log = stateLog();
        const door = new DungeonDoor(h.engine, baseDef(), new Keyring(), log.events);

        door.open();
        h.advance(DOOR_ANIM_MS / 2, 50);
        const midway = lastTranslation(h.bodies[0]!).x;
        expect(midway).toBeGreaterThan(10);
        expect(midway).toBeLessThan(10 + 1.9);

        door.close();
        // Continuity: the pose right after the reversal matches the pose before it.
        h.advance(0.0001, 0.0001);
        expect(lastTranslation(h.bodies[0]!).x).toBeCloseTo(midway, 4);

        // Half the animation remains, not a full one.
        h.advance(DOOR_ANIM_MS / 2, 50);
        expect(door.getState()).toBe('closed');
        expect(lastTranslation(h.bodies[0]!).x).toBeCloseTo(10, 5);
        expect(log.states).toEqual(['opening', 'closing', 'closed']);

        door.dispose();
    });

    it('open() is a no-op while already open or opening', () => {
        const h = makeHarness();
        const log = stateLog();
        const door = new DungeonDoor(h.engine, baseDef(), new Keyring(), log.events);

        door.open();
        door.open();
        h.advance(DOOR_ANIM_MS);
        door.open();

        expect(log.states).toEqual(['opening', 'open']);
        door.dispose();
    });

    it('open() bypasses the lock (scripted open)', () => {
        const h = makeHarness();
        const door = new DungeonDoor(h.engine, baseDef({ kind: 'locked', keyId: 'brass_key' }), new Keyring(), stateLog().events);

        door.open();
        h.advance(DOOR_ANIM_MS);

        expect(door.getState()).toBe('open');
        expect(door.isLocked()).toBe(true);
        door.dispose();
    });
});

describe('DungeonDoor — hinge animation', () => {
    it('rotates the body about the door-local -X vertical edge', () => {
        const h = makeHarness();
        const door = new DungeonDoor(
            h.engine,
            baseDef({ animation: 'hinge', position: { x: 0, y: 1, z: 0 } }),
            new Keyring(),
            stateLog().events,
        );

        const restRotation = lastRotation(h.bodies[0]!);
        expect(restRotation.w).toBeCloseTo(1, 5);

        door.open();
        h.advance(DOOR_ANIM_MS);

        const angle = (100 * Math.PI) / 180;
        const expectedQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle);
        const rot = lastRotation(h.bodies[0]!);
        expect(rot.y).toBeCloseTo(expectedQuat.y, 4);
        expect(rot.w).toBeCloseTo(expectedQuat.w, 4);

        // Centre swings around the pivot at local (-width/2, 0, 0) → world (-1, 1, 0).
        const pivot = new THREE.Vector3(-1, 1, 0);
        const expectedPos = new THREE.Vector3(0, 1, 0).sub(pivot).applyQuaternion(expectedQuat).add(pivot);
        const pos = lastTranslation(h.bodies[0]!);
        expect(pos.x).toBeCloseTo(expectedPos.x, 4);
        expect(pos.y).toBeCloseTo(expectedPos.y, 4);
        expect(pos.z).toBeCloseTo(expectedPos.z, 4);

        door.dispose();
    });

    it('honors an explicit 90-degree forged-door limit without changing the edge pivot', () => {
        const h = makeHarness();
        const door = new DungeonDoor(
            h.engine,
            {
                ...baseDef({ animation: 'hinge', position: { x: 0, y: 1, z: 0 } }),
                maxOpenAngleDeg: 90,
            } as DoorDefinition,
            new Keyring(),
            stateLog().events,
        );

        door.open();
        h.advance(DOOR_ANIM_MS);

        const expectedQuat = new THREE.Quaternion().setFromAxisAngle(
            new THREE.Vector3(0, 1, 0),
            Math.PI / 2,
        );
        const rot = lastRotation(h.bodies[0]!);
        expect(rot.y).toBeCloseTo(expectedQuat.y, 4);
        expect(rot.w).toBeCloseTo(expectedQuat.w, 4);
        const pivot = new THREE.Vector3(-1, 1, 0);
        const expectedPos = new THREE.Vector3(0, 1, 0)
            .sub(pivot).applyQuaternion(expectedQuat).add(pivot);
        expect(lastTranslation(h.bodies[0]!)).toEqual(expect.objectContaining({
            x: expect.closeTo(expectedPos.x, 4),
            y: expect.closeTo(expectedPos.y, 4),
            z: expect.closeTo(expectedPos.z, 4),
        }));
        door.dispose();
    });
});

describe('DungeonDoor — dissolve animation', () => {
    it('shrinks the leaf and disables the collider past the halfway point, re-enabling it on close', () => {
        const h = makeHarness();
        const door = new DungeonDoor(h.engine, baseDef({ animation: 'dissolve' }), new Keyring(), stateLog().events);
        const mesh = h.worldGroup.children[0] as THREE.Mesh;
        const collider = h.colliders[0]!;

        door.open();
        h.advance(DOOR_ANIM_MS * 0.25, 25);
        expect(collider.setEnabled).not.toHaveBeenCalled();

        h.advance(DOOR_ANIM_MS, 25);
        expect(collider.setEnabled).toHaveBeenCalledWith(false);
        expect(mesh.scale.x).toBeCloseTo(0.02, 5);
        // The body never moves for a dissolve door.
        expect(lastTranslation(h.bodies[0]!).x).toBeCloseTo(10, 5);

        collider.setEnabled.mockClear();
        door.close();
        h.advance(DOOR_ANIM_MS, 25);
        expect(collider.setEnabled).toHaveBeenCalledWith(true);
        expect(mesh.scale.x).toBeCloseTo(1, 5);

        door.dispose();
    });
});

describe('DungeonDoor — proximity', () => {
    it('opens when an unlocked door has someone inside the radius', () => {
        const h = makeHarness();
        const log = stateLog();
        const door = new DungeonDoor(h.engine, baseDef(), new Keyring(), log.events);

        door.updateProximity([{ x: 10 + DEFAULT_DOOR_AUTO_OPEN_RADIUS - 0.1, y: 1, z: 5 }]);
        expect(door.getState()).toBe('opening');
        h.advance(DOOR_ANIM_MS);
        expect(door.getState()).toBe('open');

        door.dispose();
    });

    it('ignores positions outside the radius, and positions on another floor', () => {
        const h = makeHarness();
        const door = new DungeonDoor(h.engine, baseDef(), new Keyring(), stateLog().events);

        door.updateProximity([{ x: 10 + DEFAULT_DOOR_AUTO_OPEN_RADIUS + 0.5, y: 1, z: 5 }]);
        expect(door.getState()).toBe('closed');

        // Same XZ, but a full storey above the door centre (|dy| >= height).
        door.updateProximity([{ x: 10, y: 1 + 3, z: 5 }]);
        expect(door.getState()).toBe('closed');

        door.dispose();
    });

    it('honours a per-door autoOpenRadius override', () => {
        const h = makeHarness();
        const door = new DungeonDoor(h.engine, baseDef({ autoOpenRadius: 6 }), new Keyring(), stateLog().events);

        door.updateProximity([{ x: 15, y: 1, z: 5 }]);
        expect(door.getState()).toBe('opening');

        door.dispose();
    });

    it('a locked door ignores proximity entirely', () => {
        const h = makeHarness();
        const log = stateLog();
        const door = new DungeonDoor(h.engine, baseDef({ kind: 'locked', keyId: 'brass_key' }), new Keyring(), log.events);

        door.updateProximity([{ x: 10, y: 1, z: 5 }]);
        h.advance(DOOR_ANIM_MS);

        expect(door.getState()).toBe('closed');
        expect(log.states).toEqual([]);

        door.dispose();
    });

    it('closes DOOR_CLOSE_DELAY_MS after the last position leaves', () => {
        const h = makeHarness();
        const log = stateLog();
        const door = new DungeonDoor(h.engine, baseDef(), new Keyring(), log.events);

        door.updateProximity([{ x: 10, y: 1, z: 5 }]);
        h.advance(DOOR_ANIM_MS);
        expect(door.getState()).toBe('open');

        door.updateProximity([]);
        h.advance(DOOR_CLOSE_DELAY_MS - 200);
        expect(door.getState()).toBe('open');

        h.advance(200);
        expect(door.getState()).toBe('closing');
        h.advance(DOOR_ANIM_MS);
        expect(door.getState()).toBe('closed');
        expect(log.states).toEqual(['opening', 'open', 'closing', 'closed']);

        door.dispose();
    });

    it('a door locked while open still closes after the delay, and then blocks pathing', () => {
        const h = makeHarness();
        const door = new DungeonDoor(h.engine, baseDef(), new Keyring(), stateLog().events);

        door.updateProximity([{ x: 10, y: 1, z: 5 }]);
        h.advance(DOOR_ANIM_MS);
        expect(door.getState()).toBe('open');

        door.setLocked(true);
        // An open door is passable, so it is not an obstacle yet.
        expect(mockNavRegister).not.toHaveBeenCalled();

        door.updateProximity([]);
        h.advance(DOOR_CLOSE_DELAY_MS + DOOR_ANIM_MS);

        expect(door.getState()).toBe('closed');
        expect(mockNavRegister).toHaveBeenCalledTimes(1);
        const getShape = mockNavRegister.mock.calls[0]![0] as () => unknown;
        expect(getShape()).not.toBeNull();

        door.dispose();
    });

    it('a locked open door closes even with someone standing in its radius', () => {
        const h = makeHarness();
        const door = new DungeonDoor(h.engine, baseDef(), new Keyring(), stateLog().events);
        const inRange = [{ x: 10, y: 1, z: 5 }];

        door.updateProximity(inRange);
        h.advance(DOOR_ANIM_MS);
        door.setLocked(true);

        // Still standing in the doorway — a locked door must not treat that as a reason to stay open.
        door.updateProximity(inRange);
        h.advance(DOOR_CLOSE_DELAY_MS + DOOR_ANIM_MS);

        expect(door.getState()).toBe('closed');
        door.dispose();
    });

    it('cancels a pending close when someone comes back into range', () => {
        const h = makeHarness();
        const door = new DungeonDoor(h.engine, baseDef(), new Keyring(), stateLog().events);

        door.updateProximity([{ x: 10, y: 1, z: 5 }]);
        h.advance(DOOR_ANIM_MS);
        door.updateProximity([]);
        h.advance(DOOR_CLOSE_DELAY_MS - 200);
        door.updateProximity([{ x: 10, y: 1, z: 5 }]);
        h.advance(DOOR_CLOSE_DELAY_MS * 2);

        expect(door.getState()).toBe('open');
        door.dispose();
    });
});

describe('DungeonDoor — lock, keys and interaction', () => {
    it('shows the key requirement when locked and is not actionable without the key', () => {
        const h = makeHarness();
        const keyring = new Keyring();
        const door = new DungeonDoor(h.engine, baseDef({ kind: 'locked', keyId: 'brass_key' }), keyring, stateLog().events);

        expect(door.getInteractStartDisplayName()).toBe('locked - requires brass_key');
        expect(door.isActionable()).toBe(false);
        expect(door.onInteractStart()).toBe(false);
        expect(door.getState()).toBe('closed');
        expect(door.isLocked()).toBe(true);

        door.dispose();
    });

    it('offers "unlock" once the key is held, and E unlocks + opens + notifies', () => {
        const h = makeHarness();
        const keyring = new Keyring();
        keyring.grant('brass_key');
        const notify = jest.fn();
        const log = stateLog();
        const door = new DungeonDoor(h.engine, baseDef({ kind: 'locked', keyId: 'brass_key' }), keyring, log.events, notify);

        expect(door.getInteractStartDisplayName()).toBe('unlock');
        expect(door.isActionable()).toBe(true);

        expect(door.onInteractStart()).toBe(true);
        expect(door.isLocked()).toBe(false);
        expect(door.getState()).toBe('opening');
        expect(notify).toHaveBeenCalledTimes(1);

        h.advance(DOOR_ANIM_MS);
        expect(log.states).toEqual(['opening', 'open']);

        door.dispose();
    });

    it('an unlocked door offers no interaction prompt (it auto-opens on approach)', () => {
        const h = makeHarness();
        const door = new DungeonDoor(h.engine, baseDef(), new Keyring(), stateLog().events);

        expect(door.interactionEnabled()).toBe(false);
        door.setLocked(true);
        expect(door.interactionEnabled()).toBe(true);

        door.dispose();
    });

    it('setLocked toggles the lock without firing state events', () => {
        const h = makeHarness();
        const log = stateLog();
        const door = new DungeonDoor(h.engine, baseDef(), new Keyring(), log.events);

        door.setLocked(true);
        expect(door.isLocked()).toBe(true);
        door.setLocked(false);
        expect(door.isLocked()).toBe(false);
        expect(log.states).toEqual([]);

        door.dispose();
    });
});

describe('DungeonDoor — nav obstacle', () => {
    it('registers a box obstacle only while locked and closed', () => {
        const h = makeHarness();
        const door = new DungeonDoor(
            h.engine,
            baseDef({ kind: 'locked', keyId: 'brass_key', rotationY: 0.5 }),
            new Keyring(),
            stateLog().events,
        );

        expect(mockNavRegister).toHaveBeenCalledTimes(1);
        const getShape = mockNavRegister.mock.calls[0]![0] as () => unknown;
        expect(getShape()).toEqual({
            kind: 'box',
            x: 10,
            z: 5,
            halfW: 1,
            halfD: 0.2 / 2 + 0.2,
            yaw: 0.5,
            y: 1,
        });

        // Opening the door drops the obstacle (both the provider and its shape).
        door.open();
        expect(mockNavUnregister).toHaveBeenCalledTimes(1);
        expect(getShape()).toBeNull();

        door.dispose();
    });

    it('does not register an obstacle for an unlocked door, and adds/drops one as the lock changes', () => {
        const h = makeHarness();
        const door = new DungeonDoor(h.engine, baseDef(), new Keyring(), stateLog().events);
        expect(mockNavRegister).not.toHaveBeenCalled();

        door.setLocked(true);
        expect(mockNavRegister).toHaveBeenCalledTimes(1);

        door.setLocked(false);
        expect(mockNavUnregister).toHaveBeenCalledTimes(1);

        door.dispose();
    });

    it('re-registers the obstacle when a locked door finishes closing again', () => {
        const h = makeHarness();
        const door = new DungeonDoor(h.engine, baseDef({ kind: 'locked', keyId: 'brass_key' }), new Keyring(), stateLog().events);
        expect(mockNavRegister).toHaveBeenCalledTimes(1);

        door.open();
        h.advance(DOOR_ANIM_MS);
        expect(mockNavUnregister).toHaveBeenCalledTimes(1);

        door.close();
        h.advance(DOOR_ANIM_MS);
        expect(door.getState()).toBe('closed');
        expect(mockNavRegister).toHaveBeenCalledTimes(2);

        door.dispose();
    });
});

describe('DungeonDoor — remote state', () => {
    it('applyRemoteState performs the transition without firing onStateChanged', () => {
        const h = makeHarness();
        const log = stateLog();
        const door = new DungeonDoor(h.engine, baseDef(), new Keyring(), log.events);

        door.applyRemoteState('opening');
        expect(door.getState()).toBe('opening');
        expect(log.states).toEqual([]);

        door.applyRemoteState('open');
        expect(door.getState()).toBe('open');
        expect(log.states).toEqual([]);

        door.applyRemoteState('closed');
        expect(door.getState()).toBe('closed');
        expect(log.states).toEqual([]);

        door.dispose();
    });

    it('a remote snap to open holds the open pose', () => {
        const h = makeHarness();
        const door = new DungeonDoor(h.engine, baseDef(), new Keyring(), stateLog().events);

        door.applyRemoteState('open');
        h.advance(100);
        expect(lastTranslation(h.bodies[0]!).x).toBeCloseTo(10 + 1.9, 5);

        door.dispose();
    });

    it('a remote-driven animation completes silently — the authoring peer owns the broadcast', () => {
        const h = makeHarness();
        const log = stateLog();
        const door = new DungeonDoor(h.engine, baseDef(), new Keyring(), log.events);

        door.applyRemoteState('opening');
        h.advance(DOOR_ANIM_MS * 2);

        expect(door.getState()).toBe('open');
        expect(log.states).toEqual([]);
        expect(lastTranslation(h.bodies[0]!).x).toBeCloseTo(10 + 1.9, 5);

        door.dispose();
    });

    it('a locally initiated animation after a remote one fires both of its events', () => {
        const h = makeHarness();
        const log = stateLog();
        const door = new DungeonDoor(h.engine, baseDef(), new Keyring(), log.events);

        door.applyRemoteState('opening');
        h.advance(DOOR_ANIM_MS);
        expect(log.states).toEqual([]);

        // The remote flag is per-animation: the next local transition is ours again.
        door.close();
        h.advance(DOOR_ANIM_MS);
        expect(door.getState()).toBe('closed');
        expect(log.states).toEqual(['closing', 'closed']);

        door.dispose();
    });

    it('taking over a remote animation locally restores the events', () => {
        const h = makeHarness();
        const log = stateLog();
        const door = new DungeonDoor(h.engine, baseDef(), new Keyring(), log.events);

        door.applyRemoteState('opening');
        h.advance(DOOR_ANIM_MS / 2, 50);
        door.close(); // local reversal mid remote animation
        h.advance(DOOR_ANIM_MS);

        expect(door.getState()).toBe('closed');
        expect(log.states).toEqual(['closing', 'closed']);

        door.dispose();
    });

    it('applyRemoteState to the current state is a no-op', () => {
        const h = makeHarness();
        const log = stateLog();
        const door = new DungeonDoor(h.engine, baseDef(), new Keyring(), log.events);

        door.applyRemoteState('closed');
        expect(door.getState()).toBe('closed');
        expect(log.states).toEqual([]);

        door.dispose();
    });
});

describe('DungeonDoor — spawnAsset leaf', () => {
    /**
     * A stand-in for a baked door archetype: bottom-origin (y = 0 at the floor,
     * x/z centred) and 1 x 2 x 0.1 m — deliberately none of the door's authored
     * dimensions, so the fit scale has to do real work.
     */
    const ASSET_SIZE = { w: 1, h: 2, d: 0.1 };
    function bottomOriginAsset(): THREE.Mesh {
        const geometry = new THREE.BoxGeometry(ASSET_SIZE.w, ASSET_SIZE.h, ASSET_SIZE.d);
        geometry.translate(0, ASSET_SIZE.h / 2, 0);
        return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
    }

    function spawnHarness(object: THREE.Object3D): { h: Harness; spawnAsset: jest.Mock; disposeSpy: jest.Mock } {
        const disposeSpy = jest.fn();
        const spawned: SpawnedAsset = { object, objectId: 'obj_1', name: 'door-asset', collectibleComponent: null, dispose: disposeSpy };
        const spawnAsset = jest.fn(() => Promise.resolve(spawned));
        return { h: makeHarness({ spawnAsset }), spawnAsset, disposeSpy };
    }

    it('spawns the authored leaf without collision and drives its pivot with the animation', async () => {
        const object = bottomOriginAsset();
        const { h, spawnAsset, disposeSpy } = spawnHarness(object);

        const door = new DungeonDoor(h.engine, baseDef({ assetId: 'oak_door' }), new Keyring(), stateLog().events);
        expect(spawnAsset).toHaveBeenCalledWith('oak_door', expect.objectContaining({
            position: { x: 10, y: 1, z: 5 },
            rotation: { x: 0, y: 0, z: 0 },
            collision: false,
        }));
        // No fallback mesh while the authored leaf is in flight.
        expect(h.worldGroup.children).toHaveLength(0);

        await Promise.resolve();
        await Promise.resolve();

        const wrapper = h.worldGroup.children[0]!;
        expect(object.parent).toBe(wrapper);
        expect(h.worldGroup.children).toHaveLength(1);

        door.open();
        h.advance(DOOR_ANIM_MS);
        // The pivot is what moves; the asset rides along at its local offset.
        expect(wrapper.position.x).toBeCloseTo(10 + 1.9, 5);
        expect(object.getWorldPosition(new THREE.Vector3()).x).toBeCloseTo(10 + 1.9, 5);

        door.dispose();
        expect(disposeSpy).toHaveBeenCalledTimes(1);
        expect(h.worldGroup.children).toHaveLength(0);
    });

    it('re-centres the bottom-origin asset so the pivot sits at the door centre', async () => {
        const object = bottomOriginAsset();
        const { h } = spawnHarness(object);

        const door = new DungeonDoor(h.engine, baseDef({ assetId: 'oak_door' }), new Keyring(), stateLog().events);
        await Promise.resolve();
        await Promise.resolve();

        const wrapper = h.worldGroup.children[0]!;
        expect(wrapper.position.toArray()).toEqual([10, 1, 5]);
        // Local offset is half the asset's OWN height; after the pivot's fit
        // scale that lands the asset exactly half a door below the centre.
        expect(object.position.y).toBeCloseTo(-ASSET_SIZE.h / 2, 6);
        expect(object.position.x).toBeCloseTo(0, 6);
        expect(object.position.z).toBeCloseTo(0, 6);
        expect(object.getWorldPosition(new THREE.Vector3()).y).toBeCloseTo(1 - 3 / 2, 5);

        door.dispose();
    });

    it('fits one archetype to the door with a per-axis scale', async () => {
        const object = bottomOriginAsset();
        const { h } = spawnHarness(object);

        // width 2 / 1, height 3 / 2, thickness 0.2 / 0.1
        const door = new DungeonDoor(h.engine, baseDef({ assetId: 'oak_door' }), new Keyring(), stateLog().events);
        await Promise.resolve();
        await Promise.resolve();

        const wrapper = h.worldGroup.children[0]!;
        expect(wrapper.scale.x).toBeCloseTo(2, 6);
        expect(wrapper.scale.y).toBeCloseTo(1.5, 6);
        expect(wrapper.scale.z).toBeCloseTo(2, 6);

        // The fitted leaf measures the authored door dimensions in world space.
        // (The renderer flushes world matrices every frame; nothing renders here.)
        h.worldGroup.updateMatrixWorld(true);
        const worldBox = new THREE.Box3().setFromObject(object);
        const worldSize = worldBox.getSize(new THREE.Vector3());
        expect(worldSize.x).toBeCloseTo(2, 5);
        expect(worldSize.y).toBeCloseTo(3, 5);
        expect(worldSize.z).toBeCloseTo(0.2, 5);

        door.dispose();
    });

    it('clears the yaw spawnAsset applied so the pivot does not rotate the asset twice', async () => {
        const object = bottomOriginAsset();
        object.rotation.y = 0.7; // as spawnAsset would have left it
        const { h } = spawnHarness(object);

        const door = new DungeonDoor(h.engine, baseDef({ assetId: 'oak_door', rotationY: 0.7 }), new Keyring(), stateLog().events);
        await Promise.resolve();
        await Promise.resolve();

        const wrapper = h.worldGroup.children[0]!;
        expect(object.rotation.y).toBeCloseTo(0, 6);
        expect(wrapper.quaternion.y).toBeCloseTo(Math.sin(0.35), 6);

        door.dispose();
    });

    it('dissolve scales the fitted pivot down from its per-axis base scale', async () => {
        const object = bottomOriginAsset();
        const { h } = spawnHarness(object);

        const door = new DungeonDoor(h.engine, baseDef({ assetId: 'oak_door', animation: 'dissolve' }), new Keyring(), stateLog().events);
        await Promise.resolve();
        await Promise.resolve();

        const wrapper = h.worldGroup.children[0]!;
        door.open();
        h.advance(DOOR_ANIM_MS);

        expect(wrapper.scale.x).toBeCloseTo(2 * 0.02, 6);
        expect(wrapper.scale.y).toBeCloseTo(1.5 * 0.02, 6);
        expect(wrapper.scale.z).toBeCloseTo(2 * 0.02, 6);

        door.dispose();
    });

    it('hinge swings the fitted pivot about the door edge', async () => {
        const object = bottomOriginAsset();
        const { h } = spawnHarness(object);

        const door = new DungeonDoor(
            h.engine,
            baseDef({ assetId: 'oak_door', animation: 'hinge', position: { x: 0, y: 1, z: 0 } }),
            new Keyring(),
            stateLog().events,
        );
        await Promise.resolve();
        await Promise.resolve();

        const wrapper = h.worldGroup.children[0]!;
        door.open();
        h.advance(DOOR_ANIM_MS);

        const expectedQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (100 * Math.PI) / 180);
        const pivot = new THREE.Vector3(-1, 1, 0);
        const expectedPos = new THREE.Vector3(0, 1, 0).sub(pivot).applyQuaternion(expectedQuat).add(pivot);
        expect(wrapper.position.x).toBeCloseTo(expectedPos.x, 4);
        expect(wrapper.position.z).toBeCloseTo(expectedPos.z, 4);
        expect(wrapper.quaternion.w).toBeCloseTo(expectedQuat.w, 4);
        // Still the fit scale — the hinge must not disturb it.
        expect(wrapper.scale.y).toBeCloseTo(1.5, 6);

        door.dispose();
    });

    it('leaves a degenerate-bounds asset unscaled and warns', async () => {
        const object = new THREE.Object3D(); // no geometry → empty bounds
        const { h } = spawnHarness(object);
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const door = new DungeonDoor(h.engine, baseDef({ assetId: 'oak_door' }), new Keyring(), stateLog().events);
        await Promise.resolve();
        await Promise.resolve();

        const wrapper = h.worldGroup.children[0]!;
        expect(wrapper.scale.toArray()).toEqual([1, 1, 1]);
        expect(warnSpy).toHaveBeenCalled();

        door.dispose();
        warnSpy.mockRestore();
    });

    it('falls back to the box leaf when spawnAsset resolves null', async () => {
        const spawnAsset = jest.fn(() => Promise.resolve(null));
        const h = makeHarness({ spawnAsset });
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const door = new DungeonDoor(h.engine, baseDef({ assetId: 'missing_door' }), new Keyring(), stateLog().events);
        await Promise.resolve();
        await Promise.resolve();

        expect(h.worldGroup.children).toHaveLength(1);
        expect(warnSpy).toHaveBeenCalled();

        door.dispose();
        warnSpy.mockRestore();
    });

    it('falls back to the box leaf when spawnAsset rejects', async () => {
        const spawnAsset = jest.fn(() => Promise.reject(new Error('network')));
        const h = makeHarness({ spawnAsset });
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const door = new DungeonDoor(h.engine, baseDef({ assetId: 'missing_door' }), new Keyring(), stateLog().events);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(h.worldGroup.children).toHaveLength(1);
        expect(warnSpy).toHaveBeenCalled();

        door.dispose();
        warnSpy.mockRestore();
    });

    it('disposes a leaf that lands after the door was disposed, and builds no fallback', async () => {
        const disposeSpy = jest.fn();
        let resolveSpawn!: (s: SpawnedAsset) => void;
        const spawnPromise = new Promise<SpawnedAsset>((resolve) => { resolveSpawn = resolve; });
        const spawnAsset = jest.fn(() => spawnPromise);
        const h = makeHarness({ spawnAsset });

        const door = new DungeonDoor(h.engine, baseDef({ assetId: 'oak_door' }), new Keyring(), stateLog().events);
        door.dispose();

        resolveSpawn({ object: new THREE.Object3D(), objectId: 'obj_2', name: 'door-asset', collectibleComponent: null, dispose: disposeSpy });
        await Promise.resolve();
        await Promise.resolve();

        expect(disposeSpy).toHaveBeenCalledTimes(1);
        expect(h.worldGroup.children).toHaveLength(0);
    });
});

describe('DungeonDoor — dispose', () => {
    it('tears down the pre-step callback, physics, nav provider and visual, and is idempotent', () => {
        const h = makeHarness();
        const door = new DungeonDoor(h.engine, baseDef({ kind: 'locked', keyId: 'brass_key' }), new Keyring(), stateLog().events);

        expect(h.preStep).toHaveLength(1);
        door.dispose();

        expect(h.unregisterPreStepCallback).toHaveBeenCalledTimes(1);
        expect(h.preStep).toHaveLength(0);
        expect(mockNavUnregister).toHaveBeenCalledTimes(1);
        expect(h.removeCollider).toHaveBeenCalled();
        expect(h.removeRigidBody).toHaveBeenCalled();
        expect(h.worldGroup.children).toHaveLength(0);

        expect(() => door.dispose()).not.toThrow();
        expect(h.unregisterPreStepCallback).toHaveBeenCalledTimes(1);
        expect(mockNavUnregister).toHaveBeenCalledTimes(1);
    });

    it('ignores open/close/proximity after dispose', () => {
        const h = makeHarness();
        const log = stateLog();
        const door = new DungeonDoor(h.engine, baseDef(), new Keyring(), log.events);
        door.dispose();

        door.open();
        door.updateProximity([{ x: 10, y: 1, z: 5 }]);
        door.applyRemoteState('open');

        expect(door.getState()).toBe('closed');
        expect(log.states).toEqual([]);
    });
});
