/**
 * DeclaredMeshLevel — load the mesh level a world.json DECLARES (`worldProfileData.meshLevel`),
 * so a game gets a mesh-level world without constructing `MeshLevel` in its own code.
 *
 * The world generator calls this on its `terrain.shape: 'none'` path, before environment
 * objects are placed and before the player spawns, so both land on the level's colliders.
 * A game that builds its own `MeshLevel` (the arena pattern) simply leaves the field out.
 */

import type { EngineLike, WorldProfileData } from 'types/game.js';
import { DEFAULT_MESH_LEVEL_OPTIONS, MeshLevel, type MeshLevelLoadResult } from 'engine/meshlevel/MeshLevel.js';

export interface DeclaredMeshLevel {
    level: MeshLevel;
    result: MeshLevelLoadResult;
}

/**
 * Load `worldProfileData.meshLevel`, or return null when the world declares none.
 *
 * With `spawnLandmark`, the landmark's position and yaw replace `playerSpawnPosition` and
 * `playerSpawnRotationY` in `worldProfileData` (in memory) — the fields every spawn path already
 * reads — so the player starts where the level's author put the spawn.
 */
export async function loadDeclaredMeshLevel(
    engine: EngineLike,
    worldProfileData: WorldProfileData,
): Promise<DeclaredMeshLevel | null> {
    const declared = worldProfileData.meshLevel;
    if (!declared) return null;

    const level = new MeshLevel(
        engine,
        {
            glb: { assetId: declared.glbAssetId },
            level: declared.levelAssetId ? { assetId: declared.levelAssetId } : 'trimesh-from-glb',
        },
        {
            ...DEFAULT_MESH_LEVEL_OPTIONS,
            // Declared levels are outdoor grounds and forged landscapes unless they say otherwise;
            // the interior preset (a dimmed sun) is for enclosed levels.
            lighting: { ...DEFAULT_MESH_LEVEL_OPTIONS.lighting, mode: declared.lighting ?? 'exterior' },
        },
    );
    const result = await level.load();

    if (declared.spawnLandmark) {
        const spawn = level.landmark(declared.spawnLandmark);
        worldProfileData.playerSpawnPosition = { x: spawn.position[0], y: spawn.position[1], z: spawn.position[2] };
        worldProfileData.playerSpawnRotationY = spawn.yaw;
    }
    return { level, result };
}
