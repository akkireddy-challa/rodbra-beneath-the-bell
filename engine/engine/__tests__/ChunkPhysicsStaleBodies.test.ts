/**
 * Chunk hibernation must never reach Rapier through a stale rigid-body handle.
 *
 * `EnvironmentObjectSystem` buckets every env-object body by chunk when it is
 * created, but a body can be REMOVED long after that (a destructible prop
 * breaking, an AI edit re-placing an object, a level reload). Rapier REUSES
 * freed handles, so calling `setEnabled()` on the retained entry either traps
 * the WASM module ("unreachable" / recursive borrow, physics frozen for the
 * rest of the session) or silently hibernates whatever body inherited the
 * handle. The toggle now prunes invalid bodies before touching any of them.
 */

import { EnvironmentObjectSystem } from 'engine/EnvironmentObjectSystem.js';
import type RAPIER from '@dimforge/rapier3d-compat';

interface FakeBody {
    id: number;
    valid: boolean;
    enabled: boolean | null;
    /** Every method the toggle called on this body, in order. */
    calls: string[];
    isValid(): boolean;
    setEnabled(enabled: boolean): void;
    asRapier(): RAPIER.RigidBody;
}

/**
 * A body that behaves like Rapier's: once removed, every method other than
 * `isValid()` traps. A throw stands in for the WASM `unreachable` so a test
 * that touches a dead handle fails loudly instead of quietly passing.
 */
function fakeBody(id: number): FakeBody {
    const body: FakeBody = {
        id,
        valid: true,
        enabled: null,
        calls: [],
        isValid: () => body.valid,
        setEnabled(enabled: boolean): void {
            if (!body.valid) throw new Error(`setEnabled() called through invalid handle ${body.id}`);
            body.calls.push('setEnabled');
            body.enabled = enabled;
        },
        asRapier: () => body as unknown as RAPIER.RigidBody,
    };
    return body;
}

/**
 * The chunk toggle only reads `chunkPhysicsBodies`; building the whole system
 * (world group, terrain registry, RNG…) would pull in the entire world-gen
 * stack and register a module-level active instance for nothing.
 */
function systemWithChunk(chunkKey: string, bodies: FakeBody[]): {
    system: EnvironmentObjectSystem;
    tracked: () => FakeBody[];
} {
    const system = Object.create(EnvironmentObjectSystem.prototype) as EnvironmentObjectSystem;
    const priv = system as unknown as { chunkPhysicsBodies: Map<string, RAPIER.RigidBody[]> };
    priv.chunkPhysicsBodies = new Map([[chunkKey, bodies.map((b) => b.asRapier())]]);
    return {
        system,
        tracked: () => (priv.chunkPhysicsBodies.get(chunkKey) ?? []) as unknown as FakeBody[],
    };
}

describe('EnvironmentObjectSystem.setChunkPhysicsEnabled with stale bodies', () => {
    test('a body removed since it was tracked is never toggled', () => {
        const removed = fakeBody(1);
        const live = fakeBody(2);
        const { system } = systemWithChunk('0,0', [removed, live]);

        removed.valid = false; // the prop was destroyed / re-placed by an edit

        expect(() => system.setChunkPhysicsEnabled('0,0', true)).not.toThrow();
        expect(removed.calls).toEqual([]);
        expect(live.calls).toEqual(['setEnabled']);
        expect(live.enabled).toBe(true);
    });

    test('the chunk keeps working after the stale entry is pruned', () => {
        const removed = fakeBody(1);
        const live = fakeBody(2);
        const { system, tracked } = systemWithChunk('0,0', [removed, live]);
        removed.valid = false;

        system.setChunkPhysicsEnabled('0,0', false);
        expect(tracked().map((b) => b.id)).toEqual([live.id]);

        // Re-activating the chunk still wakes the surviving bodies — hibernation
        // stays operational, it just no longer carries the dead handle.
        system.setChunkPhysicsEnabled('0,0', true);
        expect(live.calls).toEqual(['setEnabled', 'setEnabled']);
        expect(live.enabled).toBe(true);
        expect(removed.calls).toEqual([]);
    });

    test('a chunk whose bodies were all removed toggles to a no-op', () => {
        const bodies = [fakeBody(1), fakeBody(2)];
        const { system, tracked } = systemWithChunk('1,-2', bodies);
        for (const b of bodies) b.valid = false;

        expect(() => system.setChunkPhysicsEnabled('1,-2', true)).not.toThrow();
        expect(tracked()).toEqual([]);
        for (const b of bodies) expect(b.calls).toEqual([]);
    });
});
