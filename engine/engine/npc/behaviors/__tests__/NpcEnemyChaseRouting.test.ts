/**
 * NpcEnemyBehavior chases via the SHARED goal field instead of per-NPC A*.
 *
 * A single layered A* over a city-scale level costs a median ~19 ms (see
 * PathRequestQueue), so a horde re-planning individually cannot fit in a frame
 * however it is budgeted. Chase steps are short gradient samples off one shared
 * flood; wander targets stay pathfound, because they are metres away across
 * arbitrary geometry and a straight line would walk through walls.
 *
 * That makes `usesDirectTargets()` MODE-DEPENDENT, where every other behaviour
 * returns a constant — so these tests pin the default (wander: pathfound) and
 * the engagement reporting the tier scheduler reads.
 */
import { NpcEnemyBehavior } from 'engine/npc/behaviors/NpcEnemyBehavior.js';

describe('NpcEnemyBehavior chase routing', () => {
    test('starts in wander mode: targets are pathfound, not straight-lined', () => {
        // The dangerous default is the other way round — an enemy that
        // straight-lines a 12 m wander target walks through walls.
        const b = new NpcEnemyBehavior();
        expect(b.usesDirectTargets()).toBe(false);
    });

    test('an unengaged enemy reports not-engaged so it can hibernate', () => {
        const b = new NpcEnemyBehavior();
        expect(b.isEngaged()).toBe(false);
    });

    test('is still hostile — hit response is unchanged by the tier work', () => {
        // isHostile drives "explodes on hit"; decoupling it from goal-holding
        // must not have altered what it reports.
        expect(new NpcEnemyBehavior().isHostile()).toBe(true);
    });

    test('clone() yields an independent instance in the wander default', () => {
        const b = new NpcEnemyBehavior({ detectionRange: 16, chaseSpeed: 5 });
        const c = b.clone() as NpcEnemyBehavior;
        expect(c).not.toBe(b);
        expect(c.usesDirectTargets()).toBe(false);
        expect(c.isEngaged()).toBe(false);
    });
});
