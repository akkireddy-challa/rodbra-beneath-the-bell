import * as THREE from 'three';

/**
 * A column on a baked v2-octree level counts as a rooftop/obstacle (not a
 * walkable street) when its full surface sits at least this far above the bare
 * TERRAIN ground beneath it — i.e. a placed ENVIRONMENT object (building, prop)
 * occupies it.
 */
export const BAKED_ROOFTOP_CLEARANCE_M = 1.5;

/**
 * Resolve a spawn position on a baked level, rejecting building/prop tops.
 *
 * Baked v2-octree maps expose no per-voxel grid, so the surface is probed with
 * raycasts: `surfaceY` is the full surface (terrain + ENVIRONMENT) from
 * `getWorldHeightAt`, and `terrainY` is a TERRAIN-only raycast hit (the bare
 * ground, or null when the ray missed). The map registers on CollisionGroup.TERRAIN
 * while buildings/props stay on ENVIRONMENT, so when the full surface stands clearly
 * above the bare ground a placed object occupies this column — not a walkable street —
 * and we return null so callers retry nearby or fall back (mirrors the procedural
 * findValidVoxelSpawnPosition contract).
 *
 * @param x - requested world X (honoured verbatim)
 * @param z - requested world Z (honoured verbatim)
 * @param surfaceY - full surface height (terrain + ENVIRONMENT); 0 when nothing was hit
 * @param terrainY - TERRAIN-only ground height, or null if the terrain ray missed
 * @param dropY - fallback Y used when no surface was found (just above the map's top bound)
 * @returns spawn position, or null when the column is a building/prop top
 */
export function resolveBakedSpawnPosition(
    x: number,
    z: number,
    surfaceY: number,
    terrainY: number | null,
    dropY: number,
): THREE.Vector3 | null {
    if (terrainY !== null && surfaceY - terrainY > BAKED_ROOFTOP_CLEARANCE_M) {
        return null; // building/prop here — skip; caller retries nearby or falls back
    }
    const y = surfaceY !== 0 ? surfaceY : dropY;
    return new THREE.Vector3(x, y, z);
}

/**
 * The subset of the engine a physics spawn finder needs. `EngineLike` satisfies it.
 */
export interface SpawnFinderEngine {
    physicsWorld: {
        raycast(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number, collisionMask: number): { hasHit: boolean; hitPoint: THREE.Vector3 };
    } | null;
    getWorldHeightAt?: (x: number, z: number) => number | null | undefined;
}

export interface PhysicsSpawnFinderOptions {
    /**
     * Also reject a column when the resolved floor has no standing room around it
     * (a wall top, a ledge, a gap between two solids). Wanted on authored mesh
     * levels, whose walls are ordinary colliders; off for baked voxel maps where
     * the historical behaviour is kept until measured.
     */
    requireHeadroom: boolean;
}

/** Bit for the terrain collision group, mirrored here so this module stays free of engine imports. */
const TERRAIN_GROUP = 512;
/** Bit for the static-environment collision group. */
const ENVIRONMENT_GROUP = 2;
/** Height above the floor the headroom rays run at, and the radius they cover. */
const HEADROOM_RAY_HEIGHT_M = 0.5;
const HEADROOM_RADIUS_M = 0.6;
/**
 * Interior (`fromY`) probe window, mirrored from `Spawner`'s INTERIOR_PROBE_ABOVE_M /
 * INTERIOR_MAX_DROP_M so this module stays free of engine imports. The ray starts a
 * little ABOVE the requested height (a caller that passes the floor itself must still
 * hit it) and reaches down about one storey — a first hit further down means the probe
 * fell into an unrelated lower storey, i.e. the wrong column.
 */
const INTERIOR_PROBE_ABOVE_M = 1.5;
const INTERIOR_MAX_DROP_M = 12;

/**
 * Build a `findValidVoxelSpawnPosition` implementation for worlds that expose no
 * per-voxel grid: baked v2-octree maps and authored mesh levels. The surface is
 * resolved with downward physics raycasts against the level colliders.
 *
 * The level registers on the TERRAIN group while placed buildings/props stay on
 * ENVIRONMENT, so a TERRAIN-only ray yields the bare walkable ground and the
 * full-surface ray reveals whether a prop occupies the column (rejected via
 * `resolveBakedSpawnPosition`, so callers retry nearby).
 *
 * CRITICAL: honours the requested x/z verbatim. Callers (NPC line-ups, wave
 * spawns, animals, pickups) pass DISTINCT coordinates and must never be
 * collapsed onto one point. Interior spawns pass `fromY` and are probed DOWN
 * from that height so a roofed room resolves to its own floor, not the roof.
 * When nothing is hit the position falls back to just above the level's top
 * bound (`dropY`) so the body lands on whatever is below.
 */
export function createPhysicsSpawnFinder(
    engine: SpawnFinderEngine,
    bounds: { maxY: number } | null,
    options: PhysicsSpawnFinderOptions,
): (x: number, z: number, fromY?: number) => THREE.Vector3 | null {
    const dropY = (bounds?.maxY ?? 10) + 2;
    const down = new THREE.Vector3(0, -1, 0);

    /**
     * No solid within HEADROOM_RADIUS_M at knee height in any cardinal direction —
     * i.e. the resolved floor has standing room, and is not a wall top, a ledge,
     * or a gap wedged between two solids.
     */
    const hasStandingRoom = (physics: NonNullable<SpawnFinderEngine['physicsWorld']>, x: number, z: number, floorY: number): boolean => {
        const rayOrigin = new THREE.Vector3(x, floorY + HEADROOM_RAY_HEIGHT_M, z);
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const hit = physics.raycast(rayOrigin, new THREE.Vector3(dx, 0, dz), HEADROOM_RADIUS_M, TERRAIN_GROUP | ENVIRONMENT_GROUP);
            if (hit.hasHit) return false;
        }
        return true;
    };

    return (x: number, z: number, fromY?: number) => {
        const physics = engine.physicsWorld;
        if (!physics) return null;

        if (fromY !== undefined) {
            // INTERIOR spawn. The window is bounded (about one storey below the
            // requested height): a hit further down belongs to an unrelated lower
            // storey, and NO hit means this column has no floor near the height the
            // caller asked for — both are "wrong column", so return null and let the
            // caller retry nearby. Dropping from `dropY` instead (the outdoor
            // fallback) would land the body on the ROOF, the very thing `fromY` exists
            // to avoid. Standing room is always required here: inside a roofed room a
            // ray that starts within a wall resolves to the wall itself.
            const interiorHit = physics.raycast(
                new THREE.Vector3(x, fromY + INTERIOR_PROBE_ABOVE_M, z),
                down,
                INTERIOR_PROBE_ABOVE_M + INTERIOR_MAX_DROP_M,
                TERRAIN_GROUP | ENVIRONMENT_GROUP,
            );
            if (!interiorHit.hasHit) return null;
            const floorY = interiorHit.hitPoint.y;
            if (!hasStandingRoom(physics, x, z, floorY)) return null;
            return new THREE.Vector3(x, floorY, z);
        }

        const probeTop = 500;
        const probeRange = 600;
        const origin = new THREE.Vector3(x, probeTop, z);

        const fullHit = physics.raycast(origin, down, probeRange, TERRAIN_GROUP | ENVIRONMENT_GROUP);
        const surfaceY = fullHit.hasHit ? fullHit.hitPoint.y : engine.getWorldHeightAt?.(x, z) ?? 0;

        const terrainHit = physics.raycast(origin, down, probeRange, TERRAIN_GROUP);
        const terrainY = terrainHit.hasHit ? terrainHit.hitPoint.y : null;

        const resolved = resolveBakedSpawnPosition(x, z, surfaceY, terrainY, dropY);
        if (!resolved) return null;
        // The resolver's 0 means "nothing found"; a real floor at exactly y = 0 is common on mesh levels.
        if (fullHit.hasHit) resolved.y = fullHit.hitPoint.y;
        if (!options.requireHeadroom || !fullHit.hasHit) return resolved;

        return hasStandingRoom(physics, x, z, resolved.y) ? resolved : null;
    };
}
