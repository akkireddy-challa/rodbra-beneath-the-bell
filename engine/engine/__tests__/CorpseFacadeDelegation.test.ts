import { NpcController } from 'engine/npc/core/NpcController.js';
import { AnimalController } from 'engine/animal/AnimalController.js';
import { SnakeController } from 'engine/animal/SnakeController.js';
import { PlayerController } from 'engine/PlayerController.js';
import { RagdollComponent, DEFAULT_RAGDOLL_CONFIG } from 'engine/character/RagdollComponent.js';

/**
 * Corpse lifetime existed but was reachable by nobody — the component is
 * private, no facade forwarded it, nothing in the repo called it and no doc
 * named it. The only route was a misleading one: controllers feed
 * `damageableConfig.debrisLifetimeMs` (a field documented as EXPLOSION-DEBRIS
 * lifetime) into `corpseLifetimeMs`, so shortening debris silently shortened
 * ragdoll corpses too, and neither could be retuned once the corpse was
 * already on the ground.
 *
 * Each facade is exercised on the prototype with only the one component the
 * method touches, so no controller has to be constructed (they need an engine,
 * a physics world and a loaded character).
 */

interface CorpseFacade {
    setCorpseLifetimeMs(ms: number): void;
}

/** A stand-in instance of `proto`'s class carrying just the components in `state`. */
function facade<T>(proto: object, state: object): T {
    return Object.assign(Object.create(proto), state) as T;
}

const CORPSE_FACADES: [string, object][] = [
    ['NpcController', NpcController.prototype],
    ['AnimalController', AnimalController.prototype],
    ['SnakeController', SnakeController.prototype],
    ['PlayerController', PlayerController.prototype],
];

describe.each(CORPSE_FACADES)('%s corpse facade', (_name, proto) => {
    it('retunes how long the corpse lingers', () => {
        const config = { ...DEFAULT_RAGDOLL_CONFIG };
        const ragdollComp = new RagdollComponent(
            config,
            {} as unknown as ConstructorParameters<typeof RagdollComponent>[1],
        );
        const self = facade<CorpseFacade>(proto, { ragdollComp });

        self.setCorpseLifetimeMs(3000);

        expect(config.corpseLifetimeMs).toBe(3000);
    });
});
