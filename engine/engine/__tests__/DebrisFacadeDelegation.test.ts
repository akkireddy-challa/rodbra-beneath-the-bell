import * as THREE from 'three';
import { NpcController } from 'engine/npc/core/NpcController.js';
import { AnimalController } from 'engine/animal/AnimalController.js';
import { SnakeController } from 'engine/animal/SnakeController.js';
import { BlockExplosionComponent } from 'engine/character/BlockExplosionComponent.js';
import type { ExplosionCallbacks } from 'engine/character/BlockExplosionComponent.js';

/**
 * Manual debris lifetime — the last facade gap the divergence audit left open.
 * BlockExplosionComponent is private on every controller, so `getExplodedDebris`
 * / `removeDebrisPiece` (the documented way to drive debris lifetime yourself
 * after `setDebrisLifetime(0)`) were simply unavailable on snakes.
 *
 * Named for what the PEERS call it: the component method is `getDebrisPieces`,
 * but NpcController and AnimalController both publish it as `getExplodedDebris`,
 * and matching the existing vocabulary is the point of closing the gap.
 */

interface DebrisFacade {
    getExplodedDebris(): { mesh: THREE.Mesh; body: unknown }[];
    removeDebrisPiece(mesh: THREE.Mesh): boolean;
}

const CONTROLLERS: Array<[string, object]> = [
    ['NpcController', NpcController.prototype],
    ['AnimalController', AnimalController.prototype],
    ['SnakeController', SnakeController.prototype],
];

/**
 * A component with no explosion yet — enough to prove the call lands on it.
 * The callbacks are never reached: `getDebrisPieces` reads the (empty) piece
 * map and `removeDebrisPiece` returns false before touching them.
 */
function explosionComp(): BlockExplosionComponent {
    return new BlockExplosionComponent(
        { blockSize: 0.08, forceMin: 3, forceMax: 5, debrisLifetimeMs: 5000 },
        {} as unknown as ExplosionCallbacks,
    );
}

describe.each(CONTROLLERS)('%s debris facade', (_name, proto) => {
    /** A `this` carrying the private component, running the controller's own method bodies. */
    function bind(comp: BlockExplosionComponent): DebrisFacade {
        return Object.create(proto, Object.getOwnPropertyDescriptors({ explosionComp: comp }));
    }

    it('hands out the debris pieces', () => {
        const comp = explosionComp();

        expect(bind(comp).getExplodedDebris()).toEqual(comp.getDebrisPieces());
    });

    it('reports a miss when removing a piece it does not own', () => {
        expect(bind(explosionComp()).removeDebrisPiece(new THREE.Mesh())).toBe(false);
    });
});
