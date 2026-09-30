import { NpcController } from 'engine/npc/core/NpcController.js';
import { AnimalController } from 'engine/animal/AnimalController.js';
import { SnakeController } from 'engine/animal/SnakeController.js';
import { HealthComponent } from 'engine/character/HealthComponent.js';

/**
 * NpcController, AnimalController and SnakeController each hold a PRIVATE
 * HealthComponent and act as its facade. Whatever they do not delegate is
 * unreachable from game code — there is no other handle on the component.
 *
 * `setMaxHealth` was missing from all three until it was added to NpcController
 * only; `heal`/`resetHealth` existed on PlayerController and on none of them.
 * The gap is invisible to tsc, so it is pinned here per controller.
 *
 * Only `this` is supplied — the real method body runs against a real
 * HealthComponent, so a delegation that forwards to the wrong member fails.
 */

interface HealthFacade {
    setMaxHealth(maxHealth: number): void;
    heal(amount: number): boolean;
    resetHealth(): void;
}

const CONTROLLERS: Array<[string, HealthFacade]> = [
    ['NpcController', NpcController.prototype as unknown as HealthFacade],
    ['AnimalController', AnimalController.prototype as unknown as HealthFacade],
    ['SnakeController', SnakeController.prototype as unknown as HealthFacade],
];

/**
 * A health component with no-op death hooks, plus the `this` to run methods against.
 *
 * A starting health below max is arranged through `DamageableConfig` — the same
 * way every controller configures a spawned entity's health. The component
 * deliberately has no health setter: one existed for a while reachable from
 * nothing but this file, which is not a reason for engine code to exist.
 */
function facadeFor(proto: HealthFacade, startingHealth?: number): { health: HealthComponent; self: HealthFacade } {
    const health = new HealthComponent(
        { onPreDeath() {}, onExplode() {}, onRagdoll() {} },
        startingHealth === undefined ? undefined : { health: startingHealth }
    );
    const self = { healthComp: health } as unknown as HealthFacade;
    return { health, self: Object.create(proto as object, Object.getOwnPropertyDescriptors(self)) };
}

describe.each(CONTROLLERS)('%s health facade', (_name, proto) => {
    it('delegates setMaxHealth to the health component', () => {
        const { health, self } = facadeFor(proto);
        expect(health.getMaxHealth()).toBe(100); // engine default

        self.setMaxHealth(250);

        expect(health.getMaxHealth()).toBe(250);
    });

    it('delegates heal, reporting whether health actually moved', () => {
        const { health, self } = facadeFor(proto, 40);

        expect(self.heal(25)).toBe(true);
        expect(health.getHealth()).toBe(65);
    });

    it('reports no change when healing an already-full target', () => {
        const { health, self } = facadeFor(proto);
        expect(health.getHealth()).toBe(100);

        expect(self.heal(25)).toBe(false);
        expect(health.getHealth()).toBe(100);
    });

    it('delegates resetHealth back to full', () => {
        const { health, self } = facadeFor(proto, 10);

        self.resetHealth();

        expect(health.getHealth()).toBe(100);
    });
});
