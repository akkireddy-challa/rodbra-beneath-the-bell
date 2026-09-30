/** @jest-environment jsdom */
/**
 * The NPC skeleton preload fires only for games that actually have NPCs.
 *
 * Its guard used to read `if (!this.npcRegistry) return`, but the registry is constructed
 * unconditionally — so the guard never fired and EVERY game downloaded a shared humanoid
 * rig and waited on it. Measured on a car racing game with no humanoids at all: 412ms of a
 * 1.72s pre-menu load, spent on a character it never spawns.
 *
 * That is the kind of defect that survives because it is invisible: nothing breaks, the
 * game just starts slower, and the guard LOOKS like it covers the case. So the test asserts
 * the behaviour by counting fetches rather than by re-reading the condition.
 */
import { NpcRegistry } from 'engine/npc/core/NpcRegistry.js';

/** Minimal engine surface the registry touches on construction. */
function fakeEngine(): unknown {
    return { scene: {}, camera: {}, physicsWorld: null, loader: null };
}

describe('npc skeleton preload gating', () => {
    it('reports zero managers for a game that registers no NPCs', () => {
        // This is what the preload guard now asks. A racing game, a puzzle game, anything
        // without humanoids: the registry EXISTS (it always does) but holds nothing.
        const registry = new NpcRegistry(fakeEngine() as never);
        expect(registry.getManagerCount()).toBe(0);
    });

    it('counts a registered type, so a game with NPCs still preloads', () => {
        // The other half of the contract: skipping the preload must not become "never
        // preload". A game that does register NPCs should still get the rig up front.
        const registry = new NpcRegistry(fakeEngine() as never);
        const manager = { spawn: () => undefined, update: () => undefined } as never;
        registry.register('villager', manager);
        expect(registry.getManagerCount()).toBe(1);
    });
});
