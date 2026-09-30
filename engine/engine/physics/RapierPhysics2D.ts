import RAPIER2D from '@dimforge/rapier2d-compat';

let rapier2DInstance: typeof RAPIER2D | null = null;

export async function initRapier2D(): Promise<typeof RAPIER2D> {
    if (rapier2DInstance) {
        return rapier2DInstance;
    }
    // See RapierPhysics.ts: a bundle ships one flavor, and the other is a null stub.
    if ((RAPIER2D as unknown) === null) {
        throw new Error('Rapier 2D is not in this build: the game was published with 3D physics only, so nothing may initialise the 2D world.');
    }
    await RAPIER2D.init();
    rapier2DInstance = RAPIER2D;
    console.log('✅ Rapier 2D physics engine initialized');
    return RAPIER2D;
}

export function getRapier2D(): typeof RAPIER2D {
    if (!rapier2DInstance) {
        throw new Error('Rapier2D not initialized. Call initRapier2D() first.');
    }
    return rapier2DInstance;
}

export function isRapier2DReady(): boolean {
    return rapier2DInstance !== null;
}

export { RAPIER2D };
