import * as THREE from 'three';
import { PlacedObjectSystem } from 'engine/PlacedObjectSystem.js';
import { serializeEnvironmentObject } from 'engine/EnvironmentObjectSystem.js';
import { setActiveLevelManager } from 'engine/levels/levelManagerRegistry.js';
import { isInstanceInActiveLevel } from 'engine/levels/levelResolve.js';
import type { LevelManager } from 'engine/levels/LevelManager.js';
import type { EngineLike } from 'types/game.js';

/**
 * An object added in the editor belongs to the level open RIGHT NOW. Untagged
 * means global — it loads in EVERY level — so a missing tag made every editor
 * placement show up in all levels at once.
 */

function useActiveLevel(id: string | null): void {
    setActiveLevelManager(
        id === null ? null : ({ getActiveLevelId: () => id } as unknown as LevelManager),
    );
}

function makeSystem(): { system: PlacedObjectSystem; gameData: { assets: unknown[]; environmentObjects: Record<string, unknown>[] } } {
    // No matching asset: createPlacedObject records the instance and returns
    // before any loader runs — exactly the record-building half under test.
    const gameData = { assets: [], environmentObjects: [] as Record<string, unknown>[] };
    const engine = { getGameData: () => gameData } as unknown as EngineLike;
    return { system: new PlacedObjectSystem(new THREE.Scene(), engine), gameData };
}

describe('PlacedObjectSystem.createPlacedObject level tagging', () => {
    afterEach(() => { useActiveLevel(null); });

    it('tags a new placement with the active level', async () => {
        useActiveLevel('level_forest');
        const { system, gameData } = makeSystem();

        const data = await system.createPlacedObject('asset_missing', new THREE.Vector3(1, 2, 3), new THREE.Euler());

        expect(data.levelId).toBe('level_forest');
        expect(gameData.environmentObjects[0]).toMatchObject({ id: data.id, levelId: 'level_forest' });
    });

    it('keeps the tag through the save round-trip', async () => {
        useActiveLevel('level_forest');
        const { system } = makeSystem();

        // `data` IS the ObjectIdService registration data, which is what the
        // scene save re-serializes into world.json — the tag has to survive it.
        const data = await system.createPlacedObject('asset_missing', new THREE.Vector3(), new THREE.Euler());
        const saved = serializeEnvironmentObject(
            data as unknown as Record<string, unknown>,
            data.id,
            { x: 0, y: 0, z: 0 },
            { x: 0, y: 0, z: 0 },
            { x: 1, y: 1, z: 1 },
        );

        expect(saved.levelId).toBe('level_forest');
        expect(isInstanceInActiveLevel(saved as { levelId?: string }, 'level_forest')).toBe(true);
        expect(isInstanceInActiveLevel(saved as { levelId?: string }, 'level_caves')).toBe(false);
    });

    it('leaves legacy single-world games untagged', async () => {
        useActiveLevel(null);
        const { system, gameData } = makeSystem();

        const data = await system.createPlacedObject('asset_missing', new THREE.Vector3(), new THREE.Euler());

        expect(data).not.toHaveProperty('levelId');
        expect(gameData.environmentObjects[0]).not.toHaveProperty('levelId');
    });
});
