import * as THREE from 'three';
import type { EngineLike, GameData, WorldProfileData } from 'types/game.js';
import { WorldGenerator } from 'genres/voxel/WorldGenerator.js';

/**
 * `terrain.shape: 'none'` — the mesh-level world mode. No voxel terrain system
 * is built, one physics step runs so scenery colliders answer before spawns,
 * and NPC spawn validation falls back to physics raycasts instead of silently
 * returning null (which produced zero live NPCs on authored levels).
 */
const FLOOR_Y = 1.5;

// Block registration paints atlas textures on a canvas; there is no document
// under node, and the terrainless path only needs the call to have happened.
beforeEach(() => {
    jest.spyOn(WorldGenerator.prototype as unknown as { registerBlockTypes(): Promise<void> }, 'registerBlockTypes').mockResolvedValue(undefined);
});
afterEach(() => { jest.restoreAllMocks(); });

function fakeEngine(): { engine: EngineLike; steps: number[]; raycasts: number } {
    const steps: number[] = [];
    const worldGroup = new THREE.Group();
    const state = { raycasts: 0 };
    const physicsWorld = {
        step: (dt: number) => { steps.push(dt); },
        raycast: (origin: THREE.Vector3, direction: THREE.Vector3) => {
            state.raycasts++;
            if (direction.y < 0 && origin.y > FLOOR_Y) return { hasHit: true, hitPoint: new THREE.Vector3(origin.x, FLOOR_Y, origin.z) };
            return { hasHit: false, hitPoint: new THREE.Vector3() };
        },
    };
    const engine = {
        physicsWorld,
        getWorldGroup: () => worldGroup,
        blocks: { registerBlockName: () => {}, register: () => {}, resolve: () => undefined, get: () => undefined },
        getDynamicObjectManager: () => ({ getTerrainBounds: () => null }),
    } as unknown as EngineLike;
    return { engine, steps, get raycasts() { return state.raycasts; } };
}

function profile(): WorldProfileData {
    return { terrain: { shape: 'none' }, groundWorldSizeX: 64, groundWorldSizeZ: 64 } as WorldProfileData;
}

describe("WorldGenerator with terrain.shape 'none'", () => {
    it('builds no voxel terrain and steps physics once', async () => {
        const { engine, steps } = fakeEngine();
        const gen = new WorldGenerator(64, 1, profile(), engine, 'g', { environmentObjects: [] } as unknown as GameData);
        await gen.generateWorld();
        expect(gen.getVoxelTerrainSystem()).toBeNull();
        expect(steps).toEqual([1 / 60]);
    });

    it('resolves NPC spawns with physics raycasts instead of returning null', async () => {
        const fake = fakeEngine();
        const gen = new WorldGenerator(64, 1, profile(), fake.engine, 'g', { environmentObjects: [] } as unknown as GameData);
        await gen.generateWorld();
        const spawn = gen.findValidVoxelSpawnPosition(3, -4);
        expect(spawn).toEqual(new THREE.Vector3(3, FLOOR_Y, -4));
        expect(fake.raycasts).toBeGreaterThan(0);
    });

    it('refuses addTerrainFeature loudly rather than dereferencing a missing terrain', async () => {
        const { engine } = fakeEngine();
        const gen = new WorldGenerator(64, 1, profile(), engine, 'g', { environmentObjects: [] } as unknown as GameData);
        await gen.generateWorld();
        expect(() => gen.addTerrainFeature(0, 0, 4, 4, 1)).toThrow(/needs a voxel ground/);
    });
});
