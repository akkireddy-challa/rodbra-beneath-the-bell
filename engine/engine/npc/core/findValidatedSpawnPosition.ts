import * as THREE from 'three';

const MAX_ATTEMPTS = 10;
const MIN_RADIUS_M = 3;
const MAX_RADIUS_M = 20;
const WORLD_FRACTION = 0.1;

export type SpawnPositionValidator = (x: number, z: number) => THREE.Vector3 | null;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const snapToVoxelCentre = (v: number) => Math.floor(v) + 0.5;

/**
 * Find a validated spawn position for an NPC, honouring an explicit caller-requested coord.
 *
 * Behaviour:
 *  - Attempt 0 is always the exact snapped requested coord (or, when none was passed, a uniform
 *    random point in the world).
 *  - On rejection with explicit coords, retries drift outward in a bounded radius around the
 *    requested point — never escaping to "anywhere in the world". The radius cap scales with
 *    world size (10% of the smaller axis) clamped to [3m, 20m].
 *  - On rejection with no explicit coords, retries draw uniform random world points (legacy
 *    wave-spawn behaviour).
 *
 * Coordinate origin: the valid world range is [origin, origin + size]. `originX`/`originZ`
 * default to `-size/2`, i.e. a world CENTRED on the origin — correct for procedural voxel
 * worlds. Baked (.vwld) levels are CORNER-origin (content in [0, size]); callers must pass
 * `originX/Z = bounds.min` (0) for them, otherwise every in-level request collapses toward
 * the centred box (the "all NPCs spawn in one corner" bug).
 */
export function findValidatedSpawnPosition(
    worldSizeX: number,
    worldSizeZ: number,
    spawnX: number | undefined,
    spawnZ: number | undefined,
    validate: SpawnPositionValidator,
    originX?: number,
    originZ?: number,
): THREE.Vector3 | null {
    const worldMinX = originX ?? -worldSizeX / 2;
    const worldMinZ = originZ ?? -worldSizeZ / 2;
    // Valid voxel centres live in [min + 0.5, min + size - 0.5].
    const minCentreX = worldMinX + 0.5;
    const maxCentreX = worldMinX + worldSizeX - 0.5;
    const minCentreZ = worldMinZ + 0.5;
    const maxCentreZ = worldMinZ + worldSizeZ - 0.5;

    const randomWorldX = () => Math.random() * worldSizeX + worldMinX;
    const randomWorldZ = () => Math.random() * worldSizeZ + worldMinZ;

    // Clamp explicit out-of-world requests to the nearest in-bounds voxel in the
    // requested direction. This rescues callers that compute spawn rings on a wider
    // radius than the actual map (a common pattern) without escaping to "anywhere".
    const snappedX = snapToVoxelCentre(
        spawnX !== undefined ? clamp(spawnX, minCentreX, maxCentreX) : randomWorldX(),
    );
    const snappedZ = snapToVoxelCentre(
        spawnZ !== undefined ? clamp(spawnZ, minCentreZ, maxCentreZ) : randomWorldZ(),
    );

    const maxRadius = clamp(
        Math.min(worldSizeX, worldSizeZ) * WORLD_FRACTION,
        MIN_RADIUS_M,
        MAX_RADIUS_M,
    );

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        let ax: number;
        let az: number;
        if (attempt === 0) {
            ax = snappedX;
            az = snappedZ;
        } else if (spawnX !== undefined) {
            // Drift around the requested point. Radius grows 0 → maxRadius across attempts 1..9.
            const radius = (attempt / (MAX_ATTEMPTS - 1)) * maxRadius;
            const theta = Math.random() * Math.PI * 2;
            ax = clamp(snapToVoxelCentre(snappedX + Math.cos(theta) * radius), minCentreX, maxCentreX);
            az = clamp(snapToVoxelCentre(snappedZ + Math.sin(theta) * radius), minCentreZ, maxCentreZ);
        } else {
            ax = snapToVoxelCentre(randomWorldX());
            az = snapToVoxelCentre(randomWorldZ());
        }
        const validPos = validate(ax, az);
        if (validPos) return validPos;
    }

    return null;
}
