import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import { NpcController } from 'engine/npc/core/NpcController.js';
import { createNpcManager } from 'engine/npc/core/NpcManagerHelper.js';
import { HealthComponent } from 'engine/character/HealthComponent.js';
import type { INpcBehavior } from 'engine/npc/INpcBehavior.js';
import type { DamageableConfig } from 'engine/IDamageable.js';

/**
 * `registerNpc({ damageable })` carries a config down two hops that tsc cannot
 * check: the runtime setter delegating to the health component, and the manager
 * handing its configured bag to create() in the right ARGUMENT SLOT — create()
 * takes 14 positional parameters, so a mis-slotted config would type-check
 * happily against a neighbouring optional and then silently do nothing.
 */

/** Index of the damageableConfig parameter in NpcController.create(). */
const DAMAGEABLE_SLOT = 13;

/**
 * Stand-in controller for the create() spy. Only the members these assertions
 * actually depend on are stubbed; ANY other member resolves to a no-op through
 * the Proxy. That matters because this test drives the real
 * `createNpcAtPosition`, which calls a growing list of setters on the fresh
 * controller (`setBehavior`, `setAlwaysActive`, `setImportance`, ...). A
 * hand-listed object silently falls behind that list and fails with a runtime
 * "not a function" — the Proxy absorbs new calls instead, so this test only
 * breaks when the behavior it actually asserts on changes.
 */
function fakeNpcController(): NpcController {
    const stubs: Record<string, unknown> = {
        voxelBlockSize: 1.0,
        getCharacter: () => new THREE.Group(),
        getAnimationController: () => null,
    };
    return new Proxy(stubs, {
        get: (target, prop) => {
            if (prop in target) return target[prop as string];
            // Never fake the promise protocol or symbols: `await` inspects
            // `then` on a resolved value, and a no-op `then` makes the double
            // look like a thenable that never settles (the await hangs).
            if (typeof prop === 'symbol' || prop === 'then' || prop === 'catch' || prop === 'finally') {
                return undefined;
            }
            return () => undefined;
        },
    }) as unknown as NpcController;
}

/** Drive a manager through to NpcController.create, capturing the arguments. */
async function captureCreateArgs(config?: Partial<DamageableConfig>): Promise<unknown[]> {
    const captured: unknown[][] = [];
    const spy = jest
        .spyOn(NpcController, 'create')
        .mockImplementation(async (...args: unknown[]) => {
            captured.push(args);
            return fakeNpcController();
        });
    try {
        const engine = {
            scene: new THREE.Scene(),
            physicsWorld: {},
            genreModule: null,
        } as unknown as EngineLike;
        const behavior = { update: () => {} } as unknown as INpcBehavior;

        const manager = createNpcManager(engine, 'goblin', behavior);
        if (config) manager.setDamageableConfig(config);

        await (
            manager as unknown as {
                createNpcAtPosition: (p: THREE.Vector3, f: null) => Promise<string>;
            }
        ).createNpcAtPosition(new THREE.Vector3(0, 0, 0), null);
    } finally {
        spy.mockRestore();
    }
    expect(captured).toHaveLength(1);
    return captured[0];
}

describe('NPC damageable config', () => {
    it('setMaxHealth delegates to the health component', () => {
        const health = new HealthComponent({ onPreDeath() {}, onExplode() {}, onRagdoll() {} });
        expect(health.getMaxHealth()).toBe(100); // engine default

        // Real method body, real collaborator — only `this` is supplied.
        NpcController.prototype.setMaxHealth.call(
            { healthComp: health } as unknown as NpcController,
            250,
        );

        expect(health.getMaxHealth()).toBe(250);
    });

    it('maxHealth alone spawns at full health at that max (health is not left at the 100 default)', () => {
        const cb = { onPreDeath() {}, onExplode() {}, onRagdoll() {} };

        const tank = new HealthComponent(cb, { maxHealth: 260 });
        expect(tank.getMaxHealth()).toBe(260);
        expect(tank.getHealth()).toBe(260);

        const runt = new HealthComponent(cb, { maxHealth: 45 });
        expect(runt.getHealth()).toBe(45); // not 100/45

        // An explicit starting health still wins — a wounded spawn is a real use case.
        const wounded = new HealthComponent(cb, { maxHealth: 200, health: 50 });
        expect(wounded.getMaxHealth()).toBe(200);
        expect(wounded.getHealth()).toBe(50);
    });

    it('manager forwards its configured damageable bag into NpcController.create', async () => {
        const args = await captureCreateArgs({ maxHealth: 250, canDie: false });

        expect(args[DAMAGEABLE_SLOT]).toEqual({ maxHealth: 250, canDie: false });
    });

    it('manager passes undefined when no damageable config was set', async () => {
        const args = await captureCreateArgs();

        expect(args[DAMAGEABLE_SLOT]).toBeUndefined();
    });
});
