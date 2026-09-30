/**
 * Who owns a chasing melee NPC's facing.
 *
 * While a path is walking it somewhere, navigation does: movement is projected onto the
 * facing, so a chaser held pointing at its target cannot walk a detour the navmesh hands it
 * around a wreck — commanded movement reads (0, 0) and it stands there, short of the player,
 * apparently stuck. While nothing is steering it, the NPC does: otherwise it never turns to
 * its target at all and strikes whatever direction it arrived facing.
 */
import { NpcMeleeAttack } from 'engine/npc/behaviors/NpcMeleeAttack.js';
import type { ICharacterContext } from 'engine/character/ICharacterContext.js';
import { makeFakeRival, makeFakeWorld } from 'engine/npc/behaviors/__tests__/fakeCharacterContext.js';
import type { FakeWorld } from 'engine/npc/behaviors/__tests__/fakeCharacterContext.js';

/**
 * A chaser at the origin with something to chase `targetX` metres along +X. `followingPath`
 * gives the context the one navigation member this helper reads; left off, that member is
 * absent entirely, as it is on a context that cannot path (an animal, a test stub).
 */
function harness(targetX: number, followingPath = false): { melee: NpcMeleeAttack; world: FakeWorld } {
    const world = makeFakeWorld();
    if (followingPath) {
        (world.context as ICharacterContext & { isFollowingPath: () => boolean }).isFollowingPath = () => true;
    }
    const rival = makeFakeRival(targetX, 0, 0);
    // attacksPlayer: false — these tests are about where the NPC points, not what it hits.
    const melee = new NpcMeleeAttack({ attackRange: 2, attacksPlayer: false, findTargets: () => [rival.target] });
    melee.initialize(world.context);
    return { melee, world };
}

describe('melee facing', () => {
    it('leaves the facing alone while a path is steering the chase', () => {
        const { melee, world } = harness(8, true);
        world.character.rotation.y = 0;                                            // facing +Z
        const engagement = melee.update(1 / 60, world.character.position);
        expect(engagement.state).toBe('chase');
        expect(world.character.rotation.y).toBe(0);
    });

    it('faces the target while chasing when nothing is steering it', () => {
        const { melee, world } = harness(8);
        const engagement = melee.update(1 / 60, world.character.position);
        expect(engagement.state).toBe('chase');
        expect(world.character.rotation.y).toBeCloseTo(Math.PI / 2, 6);            // atan2(x, z) toward +X
    });

    it('faces the target once in attack range, path or no path', () => {
        for (const followingPath of [false, true]) {
            const { melee, world } = harness(1.5, followingPath);
            const engagement = melee.update(1 / 60, world.character.position);
            expect(engagement.state).toBe('attack');
            expect(world.character.rotation.y).toBeCloseTo(Math.PI / 2, 6);
        }
    });
});
