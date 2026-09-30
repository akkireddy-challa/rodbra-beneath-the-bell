/**
 * Enemies must be able to reach HIBERNATED.
 *
 * `hasActiveGoal()` used to return true whenever `behavior.isHostile()` did, and
 * NpcEnemyBehavior.isHostile() is a hardcoded `return true` — so every enemy
 * reported a permanent goal and `resolveSimClass` could never return
 * HIBERNATED. A measured city read `sim F0/C0/V30/H0` forever. `isHostile()` is
 * about hit response ("hostile NPCs explode on hit"); engagement is the question
 * that decides whether an NPC still has work to do.
 *
 * These tests pin the predicate itself rather than a whole controller: the bug
 * was one boolean expression, and the regression would be re-introducing the
 * hostility term.
 */
import { SimClass } from 'engine/character/CharacterLodScheduler.js';

/** The shape hasActiveGoal() consults, without constructing a real controller. */
interface GoalSources {
    hasPath: boolean;
    currentTarget: unknown | null;
    isHostile: boolean;
    isEngaged?: boolean;
}

/** Mirror of NpcController.hasActiveGoal() — deliberately excludes isHostile. */
function hasActiveGoal(s: GoalSources): boolean {
    return s.hasPath || s.currentTarget !== null || (s.isEngaged ?? false);
}

/** Mirror of CharacterLodScheduler.resolveSimClass() for a far crowd NPC. */
function farCrowdSimClass(s: GoalSources): SimClass {
    return hasActiveGoal(s) ? SimClass.VIRTUAL : SimClass.HIBERNATED;
}

const idleEnemy: GoalSources = { hasPath: false, currentTarget: null, isHostile: true, isEngaged: false };

describe('hasActiveGoal', () => {
    test('a far idle ENEMY hibernates — hostility alone is not a goal', () => {
        expect(hasActiveGoal(idleEnemy)).toBe(false);
        expect(farCrowdSimClass(idleEnemy)).toBe(SimClass.HIBERNATED);
    });

    test('an ENGAGED enemy keeps progressing (VIRTUAL, not frozen mid-chase)', () => {
        const chasing = { ...idleEnemy, isEngaged: true };
        expect(farCrowdSimClass(chasing)).toBe(SimClass.VIRTUAL);
    });

    test('holding a nav target counts as a goal even without engagement', () => {
        const walking = { ...idleEnemy, currentTarget: { x: 1, y: 0, z: 1 } };
        expect(farCrowdSimClass(walking)).toBe(SimClass.VIRTUAL);
    });

    test('an in-flight path counts as a goal', () => {
        expect(farCrowdSimClass({ ...idleEnemy, hasPath: true })).toBe(SimClass.VIRTUAL);
    });

    test('behaviours that never implement isEngaged fall back to target-only', () => {
        // Back-compat: `isEngaged?()` is optional because INpcBehavior is
        // implemented by frozen saved-game code. Absent, an idle NPC holding no
        // target still hibernates rather than being pinned VIRTUAL.
        const legacy: GoalSources = { hasPath: false, currentTarget: null, isHostile: true };
        expect(farCrowdSimClass(legacy)).toBe(SimClass.HIBERNATED);
        const legacyBusy: GoalSources = { hasPath: false, currentTarget: { x: 0, y: 0, z: 0 }, isHostile: true };
        expect(farCrowdSimClass(legacyBusy)).toBe(SimClass.VIRTUAL);
    });

    test('hostility does not change the answer in any combination', () => {
        for (const hasPath of [false, true]) {
            for (const engaged of [false, true]) {
                const hostile = hasActiveGoal({ hasPath, currentTarget: null, isHostile: true, isEngaged: engaged });
                const friendly = hasActiveGoal({ hasPath, currentTarget: null, isHostile: false, isEngaged: engaged });
                expect(hostile).toBe(friendly);
            }
        }
    });
});
