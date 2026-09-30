import * as THREE from 'three';
import { CollisionGroup } from 'engine/CollisionLayers.js';
import type { PhysicsWorld, RaycastResult } from 'engine/physics/PhysicsWorld.js';
import type { VoxelWorld } from 'engine/VoxelWorld.js';
import type { TerrainBounds } from 'engine/DynamicObjectManager.js';

/**
 * Ground resolution for the ACTIVE world, shared by `GameEngine.resolveGroundPlacement()`
 * and `PlacementHelper`.
 *
 * Two assumptions kept producing objects buried under the map or floating over
 * a plane that isn't there, and both are wrong on real levels:
 *
 *  - "the world is centred on the origin" — forged (.vwld) levels are
 *    corner-origin and can start hundreds of metres away from (0, 0);
 *  - "a missed ground query means Y = 0" — outside the terrain, or over a hole,
 *    there is no ground at all, and 0 is just the bottom of the sky.
 *
 * So the resolver validates X/Z against the LIVE terrain bounds
 * (`DynamicObjectManager.getTerrainBounds()`, which already covers both the
 * procedural VoxelWorld and the baked level) and reports a miss as a
 * discriminated result instead of a number.
 */

/** Ray start: above the tallest supported terrain (matches VoxelTerrainSystem / WorldQueries). */
const GROUND_RAY_START_Y = 500;
/** Ray length: from GROUND_RAY_START_Y down to -100. */
const GROUND_RAY_RANGE = 600;

const _rayOrigin = new THREE.Vector3();
const _rayDown = new THREE.Vector3(0, -1, 0);
const _rayResult: RaycastResult = {
    hasHit: false,
    hitPoint: new THREE.Vector3(),
    hitNormal: new THREE.Vector3(),
    hitDistance: Infinity,
    hitCollider: null,
    hitRigidBody: null,
};

/** Everything the resolver reads about the world. GameEngine fills these from the live systems. */
export interface GroundSources {
    /** Collider world for the downward ray. Null before physics init. */
    physicsWorld: PhysicsWorld | null;
    /** AABB of the active terrain — procedural or baked. Null when the genre has no terrain. */
    bounds: TerrainBounds | null;
    /** Procedural block grid, read when terrain colliders aren't queryable yet. Null on baked (.vwld) levels. */
    voxelWorld: VoxelWorld | null;
}

export interface GroundPlacementOptions {
    /**
     * Radius (m) of the 4-point cross sampled around (x, z). The LOWEST hit wins,
     * so an object next to a slope sits on the ground instead of floating off its
     * uphill edge. 0 samples the centre only.
     */
    sampleRadius: number;
    /** Keep the resolved X/Z at least this far inside the terrain edge. */
    boundsMargin: number;
    /** When true, an out-of-bounds X/Z is pulled to the nearest in-bounds point instead of failing. */
    clampToBounds: boolean;
}

export const DEFAULT_GROUND_PLACEMENT_OPTIONS: GroundPlacementOptions = {
    sampleRadius: 0,
    boundsMargin: 0.5,
    clampToBounds: false,
};

/**
 * Outcome of a ground query. Deliberately discriminated: there is no numeric
 * failure value, so callers cannot spend a miss as a usable Y.
 */
export type GroundPlacement =
    | {
        status: 'ok';
        /** Standable point: the requested X/Z (clamped if asked for) at the resolved surface Y. */
        position: THREE.Vector3;
        groundY: number;
        /** True when X/Z had to be pulled inside the terrain bounds. */
        clampedToBounds: boolean;
    }
    | {
        status: 'out-of-bounds';
        /** Bounds the point failed against — the ACTUAL map extent, not a configured size. */
        bounds: TerrainBounds;
        /** Closest X/Z that would have passed, for callers that want to retry inward. */
        nearestX: number;
        nearestZ: number;
    }
    | {
        status: 'no-ground';
        /** The X/Z that was sampled (post-clamp). */
        x: number;
        z: number;
        bounds: TerrainBounds | null;
    };

/**
 * Surface Y at (x, z) from the collider world, or null when the ray hits nothing.
 * The physics path covers both runtimes — procedural chunks and the baked level
 * body both live on TERRAIN/ENVIRONMENT.
 */
export function raycastGroundY(physicsWorld: PhysicsWorld | null, x: number, z: number): number | null {
    if (!physicsWorld) return null;
    const result = physicsWorld.raycast(
        _rayOrigin.set(x, GROUND_RAY_START_Y, z),
        _rayDown,
        GROUND_RAY_RANGE,
        CollisionGroup.TERRAIN | CollisionGroup.ENVIRONMENT,
        _rayResult,
    );
    return result.hasHit ? result.hitPoint.y : null;
}

/**
 * Walkable top of the procedural voxel column at (x, z), or null when the column is empty.
 * Used when terrain colliders exist only as blocks so far (chunk rebuilt, physics not stepped).
 * Reports the block's TOP, matching what the raycast path returns for the same point.
 */
export function sampleVoxelColumnTopY(voxelWorld: VoxelWorld | null, x: number, z: number): number | null {
    if (!voxelWorld) return null;
    const bounds = voxelWorld.getBounds();
    if (!bounds) return null;
    const blockSize = voxelWorld.getVoxelSize();
    for (let y = bounds.maxY; y >= bounds.minY; y -= blockSize) {
        if (voxelWorld.getBlock(x, y, z) !== 0) return y + blockSize / 2;
    }
    return null;
}

/** Standable Y at (x, z) through whichever terrain path is live, or null when nothing is under the point. */
export function sampleGroundY(sources: GroundSources, x: number, z: number): number | null {
    return raycastGroundY(sources.physicsWorld, x, z) ?? sampleVoxelColumnTopY(sources.voxelWorld, x, z);
}

/**
 * Lowest ground in a cross of `radius` around (x, z), sampling the centre plus the
 * four cardinal directions. Null when the centre itself has no ground — a neighbour's
 * surface says nothing about a point over a hole. Neighbours that miss are skipped.
 */
export function sampleLowestGroundY(sources: GroundSources, x: number, z: number, radius: number): number | null {
    const centre = sampleGroundY(sources, x, z);
    if (centre === null || radius <= 0) return centre;

    let lowest = centre;
    const neighbours: Array<[number, number]> = [
        [x + radius, z], [x - radius, z], [x, z + radius], [x, z - radius],
    ];
    for (const [nx, nz] of neighbours) {
        const y = sampleGroundY(sources, nx, nz);
        if (y !== null && y < lowest) lowest = y;
    }
    return lowest;
}

function clampToRange(value: number, low: number, high: number): number {
    // Bounds narrower than 2 * margin (a tiny level) collapse to their middle.
    if (low > high) return (low + high) / 2;
    return Math.min(Math.max(value, low), high);
}

/**
 * Resolve a standable point at (x, z) in the active world.
 * See `GameEngine.resolveGroundPlacement()` for the game-code-facing entry point.
 */
export function queryGroundPlacement(
    sources: GroundSources,
    x: number,
    z: number,
    options: GroundPlacementOptions,
): GroundPlacement {
    const bounds = sources.bounds;
    let sampleX = x;
    let sampleZ = z;
    let clampedToBounds = false;

    if (bounds) {
        const margin = options.boundsMargin;
        const nearestX = clampToRange(x, bounds.minX + margin, bounds.maxX - margin);
        const nearestZ = clampToRange(z, bounds.minZ + margin, bounds.maxZ - margin);
        if (nearestX !== x || nearestZ !== z) {
            if (!options.clampToBounds) return { status: 'out-of-bounds', bounds, nearestX, nearestZ };
            sampleX = nearestX;
            sampleZ = nearestZ;
            clampedToBounds = true;
        }
    }

    const groundY = sampleLowestGroundY(sources, sampleX, sampleZ, options.sampleRadius);
    if (groundY === null) return { status: 'no-ground', x: sampleX, z: sampleZ, bounds };

    return {
        status: 'ok',
        position: new THREE.Vector3(sampleX, groundY, sampleZ),
        groundY,
        clampedToBounds,
    };
}
