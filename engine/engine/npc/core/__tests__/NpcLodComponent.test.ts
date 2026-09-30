import * as THREE from 'three';
import { NpcLodComponent, type LodBodyHooks } from 'engine/npc/core/NpcLodComponent.js';
import {
    SimClass, ALWAYS_FULL_LOD_STATE, type CharacterLodState,
} from 'engine/character/CharacterLodScheduler.js';

function makeHooks(): { hooks: LodBodyHooks; calls: string[] } {
    const calls: string[] = [];
    return {
        calls,
        hooks: {
            setBodyEnabled: (enabled: boolean) => calls.push(`body:${enabled}`),
            snapBodyToVisual: () => calls.push('snap'),
            setShadowsEnabled: (enabled: boolean) => calls.push(`shadows:${enabled}`),
        },
    };
}

function state(overrides: Partial<CharacterLodState>): CharacterLodState {
    return { ...ALWAYS_FULL_LOD_STATE, ...overrides };
}

describe('NpcLodComponent', () => {
    test('accumulates dt across skipped frames and consume returns the sum, then resets', () => {
        const { hooks } = makeHooks();
        const comp = new NpcLodComponent(hooks);
        comp.beginFrame(0.1, state({ tickAi: false, tickAnim: false }));
        comp.beginFrame(0.1, state({ tickAi: false, tickAnim: false }));
        comp.beginFrame(0.1, state({ tickAi: true, tickAnim: true }));
        expect(comp.consumeAiTick()).toBeCloseTo(0.3);
        expect(comp.consumeAnimTick()).toBeCloseTo(0.3);
        // Consumed: accumulators reset, the next frame carries only its own dt.
        comp.beginFrame(0.1, state({ tickAi: true, tickAnim: true }));
        expect(comp.consumeAiTick()).toBeCloseTo(0.1);
        expect(comp.consumeAnimTick()).toBeCloseTo(0.1);
    });

    test('skipped ticks return null while the accumulator keeps growing, clamped at 10 s', () => {
        const { hooks } = makeHooks();
        const comp = new NpcLodComponent(hooks);
        for (let i = 0; i < 300; i++) {
            comp.beginFrame(0.1, state({ tickAi: false, tickAnim: false }));
            expect(comp.consumeAiTick()).toBeNull();
        }
        // 30 s elapsed but the accumulator is clamped at 10 s.
        comp.beginFrame(0.1, state({ tickAi: true }));
        expect(comp.consumeAiTick()).toBe(10);
        // Avoidance gate: false while not granted, true (and reset) when granted.
        comp.beginFrame(0.1, state({ tickAvoidance: false }));
        expect(comp.consumeAvoidanceTick()).toBe(false);
        comp.beginFrame(0.1, state({ tickAvoidance: true }));
        expect(comp.consumeAvoidanceTick()).toBe(true);
    });

    test('dropAccumulators zeroes ai/anim/avoid so legacy dt-dropping paths cannot lump time', () => {
        const { hooks } = makeHooks();
        const comp = new NpcLodComponent(hooks);
        // Simulate a pause: several frames accumulate with no ticks granted.
        for (let i = 0; i < 5; i++) {
            comp.beginFrame(0.1, state({ tickAi: false, tickAnim: false, tickAvoidance: false }));
        }
        comp.dropAccumulators();
        // Unpause: the next granted tick sees ONLY its own frame's dt, not the lump.
        comp.beginFrame(0.1, state({ tickAi: true, tickAnim: true, tickAvoidance: true }));
        expect(comp.consumeAiTick()).toBeCloseTo(0.1);
        expect(comp.consumeAnimTick()).toBeCloseTo(0.1);
        expect(comp.consumeAvoidanceTick()).toBe(true);
    });

    test('sim class transitions drive the body hooks exactly once per change', () => {
        const { hooks, calls } = makeHooks();
        const comp = new NpcLodComponent(hooks);
        // FULL -> VIRTUAL disables the body once.
        comp.beginFrame(1 / 60, state({ simClass: SimClass.VIRTUAL }));
        expect(calls).toEqual(['body:false']);
        // Staying VIRTUAL does not repeat the hook.
        comp.beginFrame(1 / 60, state({ simClass: SimClass.VIRTUAL }));
        expect(calls).toEqual(['body:false']);
        // VIRTUAL -> COARSE snaps the body to the visual, then re-enables it.
        comp.beginFrame(1 / 60, state({ simClass: SimClass.COARSE }));
        expect(calls).toEqual(['body:false', 'snap', 'body:true']);

        // FULL -> COARSE is embodied-to-embodied: neither body hook fires.
        const second = makeHooks();
        const comp2 = new NpcLodComponent(second.hooks);
        comp2.beginFrame(1 / 60, state({ simClass: SimClass.COARSE }));
        expect(second.calls).toEqual([]);
    });

    test('castShadow flips call setShadowsEnabled exactly on change', () => {
        const { hooks, calls } = makeHooks();
        const comp = new NpcLodComponent(hooks);
        comp.beginFrame(1 / 60, state({ castShadow: true }));
        expect(calls).toEqual([]);
        comp.beginFrame(1 / 60, state({ castShadow: false }));
        expect(calls).toEqual(['shadows:false']);
        comp.beginFrame(1 / 60, state({ castShadow: false }));
        expect(calls).toEqual(['shadows:false']);
        comp.beginFrame(1 / 60, state({ castShadow: true }));
        expect(calls).toEqual(['shadows:false', 'shadows:true']);
    });

    test('simClassClamp downgrades VIRTUAL/HIBERNATED stamps in beginFrame without body hooks', () => {
        const { hooks, calls } = makeHooks();
        const comp = new NpcLodComponent(hooks, SimClass.COARSE);
        // VIRTUAL stamp is clamped to COARSE: embodied-to-embodied, no hooks.
        comp.beginFrame(1 / 60, state({ simClass: SimClass.VIRTUAL }));
        expect(comp.state.simClass).toBe(SimClass.COARSE);
        expect(calls).toEqual([]);
        // HIBERNATED likewise.
        comp.beginFrame(1 / 60, state({ simClass: SimClass.HIBERNATED }));
        expect(comp.state.simClass).toBe(SimClass.COARSE);
        expect(calls).toEqual([]);
        // FULL passes through untouched (the clamp is a ceiling, not a floor).
        comp.beginFrame(1 / 60, state({ simClass: SimClass.FULL }));
        expect(comp.state.simClass).toBe(SimClass.FULL);
        expect(calls).toEqual([]);
        // An unclamped component still disembodies on VIRTUAL.
        const second = makeHooks();
        const free = new NpcLodComponent(second.hooks);
        free.beginFrame(1 / 60, state({ simClass: SimClass.VIRTUAL }));
        expect(free.state.simClass).toBe(SimClass.VIRTUAL);
        expect(second.calls).toEqual(['body:false']);
    });

    test('noteCoarseStep measures velocity across ticks; bodyY opts into vertical tracking', () => {
        const { hooks } = makeHooks();
        const comp = new NpcLodComponent(hooks);
        // First note establishes the baseline only.
        comp.noteCoarseStep(0, 0, 0.2, 10, 0);
        expect(comp.lastStepVelocity.length()).toBe(0);
        // Second note: moved (1, 0.5, 0) over 0.5 s -> v = (2, 1, 0).
        comp.noteCoarseStep(1, 0, 0.5, 10, 0.5);
        expect(comp.lastStepVelocity.x).toBeCloseTo(2);
        expect(comp.lastStepVelocity.y).toBeCloseTo(1);
        expect(comp.lastStepVelocity.z).toBeCloseTo(0);
        // Without bodyY the vertical component stays zero (ground callers).
        const ground = new NpcLodComponent(makeHooks().hooks);
        ground.noteCoarseStep(0, 0, 0.2, 10);
        ground.noteCoarseStep(1, 1, 0.5, 10);
        expect(ground.lastStepVelocity.y).toBe(0);
        expect(ground.lastStepVelocity.x).toBeCloseTo(2);
    });

    test('advanceAlongPath walks waypoints with a moveSpeed * dt budget', () => {
        const { hooks } = makeHooks();
        const comp = new NpcLodComponent(hooks);
        const character = new THREE.Object3D();
        const waypoints = [new THREE.Vector3(3, 0, 0), new THREE.Vector3(3, 0, 4)];
        let index = 0;
        const follower = {
            getCurrentWaypoint: (): THREE.Vector3 | null => waypoints[index] ?? null,
            advanceWaypoint: (): void => { index++; },
        };
        comp.advanceAlongPath(character, follower, 2, 1); // 2 m budget toward (3,0,0)
        expect(character.position.x).toBeCloseTo(2);
        expect(character.position.z).toBeCloseTo(0);
        expect(index).toBe(0);
        // Next tick: reaches waypoint 0 (1 m), then 1 m toward waypoint 1 (+Z).
        comp.advanceAlongPath(character, follower, 2, 1);
        expect(character.position.x).toBeCloseTo(3);
        expect(character.position.z).toBeCloseTo(1);
        expect(index).toBe(1);
    });
});
