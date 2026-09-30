/** @jest-environment jsdom */
/**
 * A batched (pristine) dynamic prop that Rapier wakes WITHOUT a real push must go back to
 * sleep where it was authored, not promote.
 *
 * In a forged city every wreck, can and crate woke on the first step after Play: the
 * environment colliders under them are enabled lazily (camera frustum), so for a few steps
 * they hung over nothing; others sat a few centimetres inside the voxel-rounded surface, or
 * under a lot ground plane placed over them. Each such wake promoted the prop — exact cuboid
 * colliders, per-step sync — and the solver then pushed it for the rest of the session. Two
 * hundred of them cost ~180 ms per physics step (2 fps). Asleep they cost nothing.
 *
 * `settleSpuriousWake` decides from the body alone (speed, drift from the rest position, and
 * a raycast for a shallow embed), so it is exercised here with a stub body and a stub
 * physics world — no Rapier.
 */
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from 'util';
(globalThis as unknown as { TextDecoder: unknown }).TextDecoder ??= NodeTextDecoder;
(globalThis as unknown as { TextEncoder: unknown }).TextEncoder ??= NodeTextEncoder;
import { VoxelObject } from 'engine/VoxelObject.js';
import { PristineDynamicVoxelObject } from 'engine/PristineDynamic.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';

interface Vec { x: number; y: number; z: number; }

/** The slice of a Rapier body the settle logic reads and writes. */
function stubBody(opts: { pos: Vec; vel?: Vec }) {
    const state = { pos: { ...opts.pos }, vel: { ...(opts.vel ?? { x: 0, y: 0, z: 0 }) }, sleeping: false, sleepCalls: 0 };
    const body = {
        isValid: () => true,
        isDynamic: () => true,
        isSleeping: () => state.sleeping,
        sleep: () => { state.sleeping = true; state.sleepCalls++; },
        translation: () => state.pos,
        linvel: () => state.vel,
        setLinvel: (v: Vec) => { state.vel = { ...v }; },
        setAngvel: () => undefined,
        setTranslation: (p: Vec) => { state.pos = { ...p }; },
        handle: 7,
    };
    return { body, state };
}

/** A physics world whose downward ray reports a surface `surfaceY` (or nothing). */
function stubPhysics(surfaceY: number | null): PhysicsWorld {
    return {
        raycastWithFilter: (origin: Vec, _dir: Vec, maxDistance: number) => {
            if (surfaceY === null || surfaceY > origin.y || origin.y - surfaceY > maxDistance) {
                return { hasHit: false, hitPoint: { x: 0, y: 0, z: 0 } };
            }
            return { hasHit: true, hitPoint: { x: origin.x, y: surfaceY, z: origin.z } };
        },
        getStepsTaken: () => 5,
    } as unknown as PhysicsWorld;
}

function makeProp(pos: Vec, vel?: Vec): { prop: VoxelObject; state: ReturnType<typeof stubBody>['state']; moves: Vec[] } {
    const { body, state } = stubBody({ pos, vel });
    const prop = Object.create(VoxelObject.prototype) as VoxelObject;
    const moves: Vec[] = [];
    Object.assign(prop as unknown as Record<string, unknown>, {
        rigidBody: body,
        _isDynamic: true,
        _colliderBottomOffsetY: 0,
        position: { x: pos.x, y: pos.y, z: pos.z },
        setPosition: (x: number, y: number, z: number) => { moves.push({ x, y, z }); state.pos = { x, y, z }; },
    });
    return { prop, state, moves };
}

const REST = { x: 10, y: 15, z: 20 };

describe('VoxelObject.settleSpuriousWake', () => {
    test('a slow, undisplaced wake with no queryable surface (support not enabled yet) is settled in place', () => {
        const { prop, state, moves } = makeProp({ ...REST }, { x: 0, y: -0.163, z: 0 }); // one step of gravity
        expect(prop.settleSpuriousWake(stubPhysics(null), REST)).toBe('settled');
        expect(state.sleeping).toBe(true);
        expect(moves).toHaveLength(0);               // stays exactly where it was authored
        expect(state.vel).toEqual({ x: 0, y: 0, z: 0 });
    });

    test('a shallow embed is lifted onto the surface, then slept', () => {
        const { prop, state, moves } = makeProp({ ...REST });
        expect(prop.settleSpuriousWake(stubPhysics(15.11), REST)).toBe('settled'); // 11 cm inside
        expect(moves).toHaveLength(1);
        expect(moves[0]!.y).toBeCloseTo(15.13, 3);   // surface + 2 cm clearance
        expect(state.sleeping).toBe(true);
    });

    test('a deep embed (a lot plane over a wreck) is slept where it is, so body and batch visual agree', () => {
        const { prop, state, moves } = makeProp({ ...REST });
        expect(prop.settleSpuriousWake(stubPhysics(16.3), REST)).toBe('settled'); // 1.3 m inside
        expect(moves).toHaveLength(0);
        expect(state.sleeping).toBe(true);
    });

    test('a real push (fast) is left to physics', () => {
        const { prop, state } = makeProp({ ...REST }, { x: 2, y: 0, z: 0 });
        expect(prop.settleSpuriousWake(stubPhysics(15), REST)).toBe('moving');
        expect(state.sleeping).toBe(false);
    });

    test('a prop that has drifted from where it was placed is left to physics', () => {
        const { prop, state } = makeProp({ x: REST.x + 0.5, y: REST.y, z: REST.z });
        expect(prop.settleSpuriousWake(stubPhysics(15), REST)).toBe('moving');
        expect(state.sleeping).toBe(false);
    });
});

describe('PristineDynamicVoxelObject.shouldPromoteOnWake', () => {
    function proxyAt(pos: Vec, vel?: Vec, surfaceY: number | null = null) {
        const { body, state } = stubBody({ pos, vel });
        const proxy = Object.create(PristineDynamicVoxelObject.prototype) as PristineDynamicVoxelObject;
        Object.assign(proxy as unknown as Record<string, unknown>, {
            rigidBody: body,
            _isDynamic: true,
            _colliderBottomOffsetY: 0,
            position: { ...pos },
            physicsWorldRef: stubPhysics(surfaceY),
            restPosition: { ...REST },
            spuriousWakes: 0,
            setPosition: () => undefined,
        });
        return { proxy, state };
    }

    test('an artifact wake keeps the prop batched and asleep', () => {
        const { proxy, state } = proxyAt({ ...REST }, { x: 0, y: -0.163, z: 0 });
        expect(proxy.shouldPromoteOnWake()).toBe(false);
        expect(state.sleeping).toBe(true);
        expect((proxy as unknown as { spuriousWakes: number }).spuriousWakes).toBe(1);
    });

    test('a kicked prop promotes', () => {
        const { proxy, state } = proxyAt({ ...REST }, { x: 0, y: 0, z: 3 }, 15);
        expect(proxy.shouldPromoteOnWake()).toBe(true);
        expect(state.sleeping).toBe(false);
    });
});
