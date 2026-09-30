import * as THREE from 'three';
import { NpcHostileBehavior } from 'engine/npc/behaviors/NpcHostileBehavior.js';
import { makeFakeWorld, runFrames, settleAnimations } from 'engine/npc/behaviors/__tests__/fakeCharacterContext.js';
import type { FakeWorld, FakeWorldOptions } from 'engine/npc/behaviors/__tests__/fakeCharacterContext.js';

type HostileConfig = ConstructorParameters<typeof NpcHostileBehavior>[0];

function setup(
    config?: HostileConfig,
    worldOptions?: FakeWorldOptions,
): { behavior: NpcHostileBehavior; world: FakeWorld; tick: (dt: number) => THREE.Vector3 | null } {
    const world = makeFakeWorld(worldOptions);
    const behavior = new NpcHostileBehavior(config);
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

describe('NpcHostileBehavior', () => {
    it('stops and damages the player once in attack range', async () => {
        // Regression: the attack used to be a `// TODO: Trigger attack animation` comment,
        // so a "hostile" NPC stood in the player's face doing nothing.
        const { behavior, world, tick } = setup();
        world.setPlayerAt(0, 0, 5);
        tick(1 / 60);                       // aggro, which loads the strike clips
        await settleAnimations(behavior);

        world.setPlayerAt(0, 0, 1);
        expect(tick(1 / 60)).toBeNull();

        expect(world.damageTaken).toEqual([{ amount: 10, source: 'npc_strike' }]);
        expect(world.anim?.startAttackCalls).toBe(1);
    });

    it('returns a clone of the player position when chasing', () => {
        // Regression: it used to hand back the player controller's live vector, so any
        // caller mutating the target silently teleported the player.
        const { world, tick } = setup({ updateInterval: 0 });
        world.setPlayerAt(0, 0, 5);

        const target = tick(1 / 60);
        expect(target).toEqual(new THREE.Vector3(0, 0, 5));
        target?.set(999, 999, 999);

        expect(tick(1 / 60)).toEqual(new THREE.Vector3(0, 0, 5));
    });

    it('applies chaseSpeed on aggro and restores the original speed when the player escapes', () => {
        // Regression: chaseSpeed was stored and cloned but never applied to the NPC.
        const { world, tick } = setup({ chaseSpeed: 8, detectionRange: 10 }, { moveSpeed: 2 });

        world.setPlayerAt(0, 0, 5);
        tick(1 / 60);
        expect(world.moveSpeed()).toBe(8);

        world.setPlayerAt(0, 0, 40);
        tick(1 / 60);
        expect(world.moveSpeed()).toBe(2);
    });

    it('restores the original speed when disposed mid-chase (behavior swap)', () => {
        const { behavior, world, tick } = setup({ chaseSpeed: 8 }, { moveSpeed: 2 });
        world.setPlayerAt(0, 0, 5);
        tick(1 / 60);

        behavior.dispose();

        expect(world.moveSpeed()).toBe(2);
    });

    it('walks back to its spawn point after losing the player, then stands down', () => {
        const world = makeFakeWorld({ spawn: new THREE.Vector3(20, 0, 20) });
        const behavior = new NpcHostileBehavior({ returnToOrigin: true });
        behavior.initialize(world.context);

        // Wandered off chasing, player now gone.
        world.removePlayer();
        world.setNpcAt(30, 0, 30);
        expect(behavior.update(1 / 60, world.character.position, null)).toEqual(new THREE.Vector3(20, 0, 20));

        world.setNpcAt(20.5, 0, 20);
        expect(behavior.update(1 / 60, world.character.position, null)).toBeNull();
    });

    it('stands still instead of returning home when returnToOrigin is false', () => {
        const world = makeFakeWorld({ spawn: new THREE.Vector3(20, 0, 20) });
        const behavior = new NpcHostileBehavior({ returnToOrigin: false });
        behavior.initialize(world.context);
        world.removePlayer();
        world.setNpcAt(30, 0, 30);

        expect(behavior.update(1 / 60, world.character.position, null)).toBeNull();
    });

    it('faces the player on every frame it holds still to attack', () => {
        // NavigationComponent only rotates the character while a path exists, so an NPC
        // that stops to attack has to own its own facing or it punches the wrong way.
        const { world, tick } = setup();
        world.setPlayerAt(3, 0, 0);

        runFrames(0.2, tick);
        expect(world.character.rotation.y).toBeCloseTo(Math.PI / 2);

        world.setPlayerAt(-3, 0, 0);
        runFrames(0.2, tick);
        expect(world.character.rotation.y).toBeCloseTo(-Math.PI / 2);
    });

    it('logs nothing while chasing and attacking', () => {
        // Regression: it logged "Hostile NPC in attack range!" every single frame.
        const log = jest.spyOn(console, 'log').mockImplementation(() => {});
        try {
            const { world, tick } = setup();
            world.setPlayerAt(0, 0, 1);
            runFrames(2.0, tick);

            expect(log).not.toHaveBeenCalled();
        } finally {
            log.mockRestore();
        }
    });

    it('arms a guard given a weapon, and its clones too', async () => {
        // The weapon config reaches the helper through the same resolve/clone path as the
        // tuning fields, so a built-in guard can hold an axe without a custom behavior.
        const source = new NpcHostileBehavior({ weapon: { type: 'axe' }, damage: 20 });
        const clone = source.clone() as NpcHostileBehavior;

        const world = makeFakeWorld();
        clone.initialize(world.context);
        expect(world.weapon.isArmed()).toBe(true);

        world.setPlayerAt(0, 0, 5);
        clone.update(1 / 60, world.character.position, null);
        await settleAnimations(clone);
        for (const move of world.anim?.registered ?? []) expect(move.type).toBe('attack');
    });

    it('clone() carries the melee config so spawned copies deal the configured damage', async () => {
        const source = new NpcHostileBehavior({ damage: 25, detectionRange: 30, chaseSpeed: 9 });
        const clone = source.clone() as NpcHostileBehavior;

        const world = makeFakeWorld();
        clone.initialize(world.context);
        // 20m is inside the configured detectionRange but outside the default one.
        world.setPlayerAt(0, 0, 20);
        clone.update(1 / 60, world.character.position, null);
        expect(world.moveSpeed()).toBe(9);
        await settleAnimations(clone);

        world.setPlayerAt(0, 0, 1);
        clone.update(1 / 60, world.character.position, null);

        expect(world.damageTaken).toEqual([{ amount: 25, source: 'npc_strike' }]);
    });
});
