import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

let rapierInstance: typeof RAPIER | null = null;

export async function initRapier(): Promise<typeof RAPIER> {
    if (rapierInstance) {
        return rapierInstance;
    }
    // A published bundle ships exactly one Rapier flavor (game/vite.rapier-flavor.js);
    // the other package is stubbed to null. Reaching it is a lane bug, and this
    // names it instead of the "Cannot read properties of null (reading 'init')"
    // a black screen would otherwise show.
    if ((RAPIER as unknown) === null) {
        throw new Error('Rapier 3D is not in this build: the game was published with 2D physics only (game.json physicsMode "2d"), so nothing may initialise the 3D world.');
    }
    await RAPIER.init();
    rapierInstance = RAPIER;
    console.log('✅ Rapier physics engine initialized');
    return RAPIER;
}

export function getRapier(): typeof RAPIER {
    if (!rapierInstance) {
        throw new Error('Rapier not initialized. Call initRapier() first.');
    }
    return rapierInstance;
}

export function isRapierReady(): boolean {
    return rapierInstance !== null;
}

export { RAPIER };

