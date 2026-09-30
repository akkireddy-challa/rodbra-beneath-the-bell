import * as THREE from 'three';
import { NpcChaseBehavior } from 'engine/npc/behaviors/NpcChaseBehavior.js';
import { disposeGlobalGoalFields } from 'engine/npc/nav/GoalField.js';
import type { ICharacterContext } from 'engine/character/ICharacterContext.js';

/** Minimal context fake exposing the real player-position path:
 *  getEngine().getPlayerController()?.getPosition?.() */
function makeContext(playerPos: THREE.Vector3): ICharacterContext {
    return {
        getEngine: () => ({
            getPlayerController: () => ({ getPosition: () => playerPos }),
        }),
    } as unknown as ICharacterContext;
}

describe('NpcChaseBehavior', () => {
    afterEach(() => disposeGlobalGoalFields());

    test('clone returns a fresh instance with same config', () => {
        const b = new NpcChaseBehavior({ target: 'player', stopDistanceM: 3 });
        const c = b.clone();
        expect(c).not.toBe(b);
        expect(c).toBeInstanceOf(NpcChaseBehavior);
    });

    test('is hostile and requests direct targets', () => {
        const b = new NpcChaseBehavior({ target: 'player' });
        expect(b.isHostile()).toBe(true);
        expect(b.usesDirectTargets()).toBe(true);
    });

    test('returns null (no move) when within stop distance of the player', () => {
        const b = new NpcChaseBehavior({ target: 'player', stopDistanceM: 4 });
        const playerPos = new THREE.Vector3(1, 0, 1);
        b.initialize(makeContext(playerPos));
        const target = b.update(1 / 60, new THREE.Vector3(2, 0, 1), null);
        expect(target).toBeNull();
    });

    test('falls back to the player position when the goal field has no direction', () => {
        const b = new NpcChaseBehavior({ target: 'player' });
        const playerPos = new THREE.Vector3(20, 0, 20);
        b.initialize(makeContext(playerPos));
        // Global goal field has never been built (no navmesh), so sampleDirection
        // returns null and the behavior must fall back to the raw player position.
        const target = b.update(1 / 60, new THREE.Vector3(0, 0, 0), null);
        expect(target).not.toBeNull();
        expect(target!.x).toBeCloseTo(20);
        expect(target!.z).toBeCloseTo(20);
        expect(target).not.toBe(playerPos); // must be a clone, not the live vector
    });
});
