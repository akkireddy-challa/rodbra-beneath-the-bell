import * as THREE from 'three';
import { MeleeNpcBehavior, DEFAULT_MELEE_NPC_AGGRO_RANGE } from 'engine/npc/examples/EXAMPLE_MeleeNpcBehavior.js';
import type { ICharacterContext } from 'engine/character/ICharacterContext.js';

/**
 * Minimal context fake. The behavior needs the real player-position path
 * (getEngine().getPlayerController().getPosition()), its own position, and a
 * character object to yaw. Weapon equipping runs but attaches to a stub, and
 * no animation controller exists, so nothing async is in flight.
 *
 * `npcPos` and `playerPos` are LIVE vectors — mutating them moves the actors,
 * which is how the simulation below walks the NPC around.
 */
const baseSpeed = 2.0; // the controller's own speed, before any chase override
let moveSpeed = baseSpeed;

function makeContext(npcPos: THREE.Vector3, playerPos: THREE.Vector3): ICharacterContext {
    const character = new THREE.Object3D();
    moveSpeed = baseSpeed;
    return {
        getEngine: () => ({
            getPlayerController: () => ({ getPosition: () => playerPos }),
        }),
        getPosition: () => npcPos,
        getMoveSpeed: () => baseSpeed,
        setMoveSpeed: (speed: number) => { moveSpeed = speed; },
        getCharacter: () => character,
        getAnimationController: () => null,
        attachToBodyPart: () => true,
        detachFromBodyPart: () => undefined,
    } as unknown as ICharacterContext;
}

/** Move `pos` toward `target` by at most `meters`. Returns the distance moved. */
function walkToward(pos: THREE.Vector3, target: THREE.Vector3, meters: number): number {
    const delta = target.clone().sub(pos);
    const dist = delta.length();
    const step = Math.min(meters, dist);
    if (dist > 1e-6) pos.addScaledVector(delta.divideScalar(dist), step);
    return step;
}

const TICK = 1 / 30;
const CHASE_SPEED = 4.0; // MeleeNpcConfig default

describe('MeleeNpcBehavior leash (returnToOrigin)', () => {
    test('a de-aggroed NPC walks back to its origin, then idles there', () => {
        const npcPos = new THREE.Vector3(0, 0, 0);      // origin / spawn point
        const playerPos = new THREE.Vector3(0, 0, 20);  // inside the 25 m aggro range
        const behavior = new MeleeNpcBehavior();
        behavior.initialize(makeContext(npcPos, playerPos));

        // 1. Chase: the NPC is given the player as its goal and closes in.
        let target = behavior.update(TICK, npcPos, null);
        expect(target).not.toBeNull();
        expect(target!.z).toBeCloseTo(20);
        for (let i = 0; i < 200; i++) {
            const t = behavior.update(TICK, npcPos, target);
            if (!t) break; // inside attackRange — stops to swing
            target = t;
            walkToward(npcPos, t, CHASE_SPEED * TICK);
        }
        const chasedDistanceFromOrigin = npcPos.length();
        expect(chasedDistanceFromOrigin).toBeGreaterThan(17); // ~17.5 m from home

        // 2. The player runs past the release distance (25 x 1.25 = 31.25 m).
        playerPos.set(0, 0, 60);
        expect(npcPos.distanceTo(playerPos)).toBeGreaterThan(DEFAULT_MELEE_NPC_AGGRO_RANGE * 1.25);

        // 3. Leash: every update hands back the origin, and the NPC closes on it.
        const leashTarget = behavior.update(TICK, npcPos, null);
        expect(leashTarget).not.toBeNull();
        expect(leashTarget!.x).toBeCloseTo(0);
        expect(leashTarget!.z).toBeCloseTo(0);

        let previousDistance = npcPos.length();
        let ticks = 0;
        for (; ticks < 400; ticks++) {
            const t = behavior.update(TICK, npcPos, null);
            if (!t) break; // arrived — no goal
            walkToward(npcPos, t, CHASE_SPEED * TICK);
            const d = npcPos.length();
            expect(d).toBeLessThan(previousDistance); // strictly homeward, never parked
            previousDistance = d;
        }

        // Measured: chases out to 17.60 m, de-aggros at 42.40 m from the player,
        // walks home in 125 ticks (4.17 s at 4 m/s) and finishes 0.933 m out.
        expect(npcPos.length()).toBeLessThanOrEqual(1.0); // ORIGIN_ARRIVAL_RADIUS
        expect(behavior.update(TICK, npcPos, null)).toBeNull(); // idles at home
        expect(ticks).toBeLessThan(400);
    });

    test('re-entering aggro range mid-return resumes the chase on that tick', () => {
        const npcPos = new THREE.Vector3(0, 0, 0);     // spawn / origin
        const playerPos = new THREE.Vector3(0, 0, 60);
        const behavior = new MeleeNpcBehavior();
        behavior.initialize(makeContext(npcPos, playerPos));
        npcPos.set(0, 0, 18); // it chased 18 m out, then the player escaped

        // Walk home for 1 second of ticks.
        for (let i = 0; i < 30; i++) {
            const t = behavior.update(TICK, npcPos, null);
            expect(t).not.toBeNull();
            walkToward(npcPos, t!, CHASE_SPEED * TICK);
        }
        const distanceFromOriginWhenInterrupted = npcPos.length();
        expect(distanceFromOriginWhenInterrupted).toBeGreaterThan(1.0); // still returning

        // The player steps back into aggro range.
        playerPos.set(0, 0, distanceFromOriginWhenInterrupted + 10);
        expect(npcPos.distanceTo(playerPos)).toBeLessThan(DEFAULT_MELEE_NPC_AGGRO_RANGE);

        // Measured: interrupted 14.00 m from origin with the player 10.00 m away;
        // the same tick returns the player position (z = 24.00), not the origin.
        const resumed = behavior.update(TICK, npcPos, null);
        expect(resumed).not.toBeNull();
        expect(resumed!.z).toBeCloseTo(playerPos.z); // chasing the player, not the origin
    });

    test('returnToOrigin: false keeps the pre-leash behavior (holds its ground)', () => {
        const npcPos = new THREE.Vector3(0, 0, 0);
        const playerPos = new THREE.Vector3(0, 0, 5);
        const behavior = new MeleeNpcBehavior({ returnToOrigin: false });
        behavior.initialize(makeContext(npcPos, playerPos));

        npcPos.set(0, 0, 18);
        playerPos.set(0, 0, 60);
        expect(behavior.update(TICK, npcPos, null)).toBeNull();
        expect(npcPos.z).toBe(18); // no goal, so nothing moves it home
    });

    test('the returned leash target is a copy, not the live origin anchor', () => {
        const npcPos = new THREE.Vector3(0, 0, 0);
        const playerPos = new THREE.Vector3(0, 0, 5);
        const behavior = new MeleeNpcBehavior();
        behavior.initialize(makeContext(npcPos, playerPos));

        npcPos.set(0, 0, 40);
        playerPos.set(0, 0, 200);
        const first = behavior.update(TICK, npcPos, null);
        expect(first).not.toBeNull();
        first!.set(99, 99, 99); // a consumer mutating its copy must not move home
        const second = behavior.update(TICK, npcPos, null);
        expect(second!.x).toBeCloseTo(0);
        expect(second!.z).toBeCloseTo(0);
    });

    test('clones anchor their own origin instead of sharing the template spawn', () => {
        const template = new MeleeNpcBehavior();
        const aPos = new THREE.Vector3(10, 0, 0);
        const bPos = new THREE.Vector3(-30, 0, 0);
        const playerPos = new THREE.Vector3(0, 0, 500);

        const a = template.clone();
        a.initialize(makeContext(aPos, playerPos));
        const b = template.clone();
        b.initialize(makeContext(bPos, playerPos));

        aPos.set(15, 0, 0);
        bPos.set(-25, 0, 0);
        expect(a.update(TICK, aPos, null)!.x).toBeCloseTo(10);
        expect(b.update(TICK, bPos, null)!.x).toBeCloseTo(-30);
    });
});

describe('MeleeNpcBehavior chaseSpeed', () => {
    test('chaseSpeed reaches the controller on aggro and is restored on de-aggro', () => {
        const npcPos = new THREE.Vector3(0, 0, 0);
        const playerPos = new THREE.Vector3(0, 0, 100); // well outside the 25 m aggro range
        const behavior = new MeleeNpcBehavior({ chaseSpeed: 7 });
        behavior.initialize(makeContext(npcPos, playerPos));

        // Not aggroed yet — the controller keeps its own speed.
        behavior.update(TICK, npcPos, null);
        expect(moveSpeed).toBe(baseSpeed);

        // Player walks into range: chaseSpeed applies.
        playerPos.set(0, 0, 10);
        behavior.update(TICK, npcPos, null);
        expect(moveSpeed).toBe(7);

        // Player escapes past the hysteresis release: the base speed comes back,
        // so the NPC leashes home at its own pace rather than sprinting.
        playerPos.set(0, 0, 200);
        behavior.update(TICK, npcPos, null);
        expect(moveSpeed).toBe(baseSpeed);
    });

    test('defaults to 4.0 when unset', () => {
        const npcPos = new THREE.Vector3(0, 0, 0);
        const playerPos = new THREE.Vector3(0, 0, 10);
        const behavior = new MeleeNpcBehavior();
        behavior.initialize(makeContext(npcPos, playerPos));
        behavior.update(TICK, npcPos, null);
        expect(moveSpeed).toBe(CHASE_SPEED);
    });

    test('a clone does not inherit the template captured speed', () => {
        const templatePos = new THREE.Vector3(0, 0, 0);
        const playerPos = new THREE.Vector3(0, 0, 10);
        const template = new MeleeNpcBehavior({ chaseSpeed: 7 });
        template.initialize(makeContext(templatePos, playerPos));
        template.update(TICK, templatePos, null); // template captures base speed

        const clonePos = new THREE.Vector3(0, 0, 0);
        const clone = template.clone();
        clone.initialize(makeContext(clonePos, playerPos));
        clone.update(TICK, clonePos, null);
        expect(moveSpeed).toBe(7);
    });
});
