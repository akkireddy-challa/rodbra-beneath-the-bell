import * as THREE from 'three';
import { NpcEnemyBehavior } from 'engine/npc/behaviors/NpcEnemyBehavior.js';
import { makeFakeWorld, runFrames, settleAnimations } from 'engine/npc/behaviors/__tests__/fakeCharacterContext.js';
import type { FakeWorld, FakeWorldOptions } from 'engine/npc/behaviors/__tests__/fakeCharacterContext.js';

type EnemyConfig = ConstructorParameters<typeof NpcEnemyBehavior>[0];

function setup(
    config?: EnemyConfig,
    worldOptions?: FakeWorldOptions,
): { behavior: NpcEnemyBehavior; world: FakeWorld; tick: (dt: number) => THREE.Vector3 | null } {
    const world = makeFakeWorld(worldOptions);
    const behavior = new NpcEnemyBehavior(config);
    behavior.initialize(world.context);
    let target: THREE.Vector3 | null = null;
    return {
        behavior,
        world,
        tick: (dt) => {
            target = behavior.update(dt, world.character.position, target);
            return target;
        },
    };
}

describe('NpcEnemyBehavior — wandering', () => {
    it('wanders inside a box around its own spawn, not around the world origin', () => {
        // Regression: pickNewTarget() used to sample (Math.random() - 0.5) * worldBounds
        // with no origin term, so an NPC spawned anywhere but 0,0 walked to the map centre.
        const spawn = new THREE.Vector3(100, 0, -40);
        const random = jest.spyOn(Math, 'random');
        try {
            for (const roll of [0, 0.999]) {
                random.mockReturnValue(roll);
                const { world, tick } = setup({ worldBounds: 15 }, { spawn: spawn.clone() });
                world.removePlayer();

                const target = tick(1 / 60);

                expect(target).not.toBeNull();
                expect(Math.abs(target!.x - spawn.x)).toBeLessThanOrEqual(7.5);
                expect(Math.abs(target!.z - spawn.z)).toBeLessThanOrEqual(7.5);
            }
        } finally {
            random.mockRestore();
        }
    });

    it('keeps its wander target until retargetInterval elapses', () => {
        const { world, tick } = setup({ retargetInterval: 5 });
        world.removePlayer();

        const first = tick(1 / 60);
        runFrames(2.0, tick);
        expect(tick(1 / 60)).toBe(first);

        runFrames(4.0, tick);
        expect(tick(1 / 60)).not.toBe(first);
    });
});

describe('NpcEnemyBehavior — combat', () => {
    it('chases the player, returning a clone of their position', () => {
        const { world, tick } = setup();
        world.setPlayerAt(0, 0, 5);

        const target = tick(1 / 60);
        expect(target).toEqual(new THREE.Vector3(0, 0, 5));
        target?.set(999, 999, 999);

        expect(tick(1 / 60)).toEqual(new THREE.Vector3(0, 0, 5));
    });

    it('stops and damages the player once in attack range', async () => {
        const { behavior, world, tick } = setup();
        world.setPlayerAt(0, 0, 5);
        tick(1 / 60);                       // aggro, which loads the strike clips
        await settleAnimations(behavior);

        world.setPlayerAt(0, 0, 1);
        expect(tick(1 / 60)).toBeNull();

        expect(world.damageTaken).toEqual([{ amount: 10, source: 'npc_strike' }]);
    });

    it('picks a fresh target near spawn — not the stale chase target — after the player escapes', () => {
        const spawn = new THREE.Vector3(20, 0, 20);
        const { world, tick } = setup({ worldBounds: 10 }, { spawn: spawn.clone(), moveSpeed: 2 });

        world.setPlayerAt(20, 0, 25);
        expect(tick(1 / 60)).toEqual(new THREE.Vector3(20, 0, 25));
        expect(world.moveSpeed()).toBe(4);

        world.setPlayerAt(200, 0, 200);
        const target = tick(1 / 60);

        expect(target).not.toBeNull();
        expect(Math.abs(target!.x - spawn.x)).toBeLessThanOrEqual(5);
        expect(Math.abs(target!.z - spawn.z)).toBeLessThanOrEqual(5);
        expect(world.moveSpeed()).toBe(2);
    });

    it('ignores the player entirely when detectionRange is 0', () => {
        // The escape hatch that restores the pre-combat pure wanderer.
        const { world, tick } = setup({ detectionRange: 0 });
        world.setPlayerAt(0, 0, 0.5);

        runFrames(5.0, tick);

        expect(world.damageTaken).toHaveLength(0);
        expect(world.setMoveSpeedCalls).toHaveLength(0);
    });
});

describe('NpcEnemyBehavior — clone', () => {
    it('gives each spawn its own wander box', () => {
        const source = new NpcEnemyBehavior({ worldBounds: 6 });

        const near = source.clone();
        const nearWorld = makeFakeWorld({ spawn: new THREE.Vector3(0, 0, 0) });
        nearWorld.removePlayer();
        near.initialize(nearWorld.context);

        const far = source.clone();
        const farWorld = makeFakeWorld({ spawn: new THREE.Vector3(80, 0, 80) });
        farWorld.removePlayer();
        far.initialize(farWorld.context);

        const nearTarget = near.update(1 / 60, nearWorld.character.position, null);
        const farTarget = far.update(1 / 60, farWorld.character.position, null);

        expect(Math.abs(nearTarget!.x)).toBeLessThanOrEqual(3);
        expect(Math.abs(farTarget!.x - 80)).toBeLessThanOrEqual(3);
    });

    it('carries the melee config to the clone', async () => {
        const source = new NpcEnemyBehavior({ damage: 25, chaseSpeed: 9 });
        const clone = source.clone();

        const world = makeFakeWorld();
        clone.initialize(world.context);
        world.setPlayerAt(0, 0, 5);
        clone.update(1 / 60, world.character.position, null);
        await settleAnimations(clone);

        world.setPlayerAt(0, 0, 1);
        clone.update(1 / 60, world.character.position, null);

        expect(world.damageTaken).toEqual([{ amount: 25, source: 'npc_strike' }]);
        expect(world.moveSpeed()).toBe(9);
    });
});
