import * as THREE from 'three';
import {
    queryGroundPlacement,
    DEFAULT_GROUND_PLACEMENT_OPTIONS,
    type GroundSources,
} from 'engine/GroundPlacement.js';
import type { TerrainBounds } from 'engine/DynamicObjectManager.js';
import type { PhysicsWorld, RaycastResult } from 'engine/physics/PhysicsWorld.js';
import type { VoxelWorld } from 'engine/VoxelWorld.js';

/**
 * Two shipped games spawned objects into nowhere because the generated code
 * guessed the world: a forged park that starts far from the origin (the dog
 * ended up under the map) and a 2016 x 2016 configured ground plane around a
 * level that is really ~51 x 34 m. `queryGroundPlacement` answers both from the
 * LIVE terrain bounds, and reports a miss instead of Y = 0.
 */

/** Physics world whose downward ray hits `surfaceY` only inside the given X/Z rectangle. */
function physicsWithGroundIn(
    rect: { minX: number; maxX: number; minZ: number; maxZ: number },
    surfaceY: number,
): PhysicsWorld {
    const world = {
        raycast(origin: THREE.Vector3, _dir: THREE.Vector3, _max: number, _mask: number, out?: RaycastResult): RaycastResult {
            const result: RaycastResult = out ?? {
                hasHit: false,
                hitPoint: new THREE.Vector3(),
                hitNormal: new THREE.Vector3(),
                hitDistance: Infinity,
                hitCollider: null,
                hitRigidBody: null,
            };
            const inside = origin.x >= rect.minX && origin.x <= rect.maxX
                && origin.z >= rect.minZ && origin.z <= rect.maxZ;
            result.hasHit = inside;
            if (inside) result.hitPoint.set(origin.x, surfaceY, origin.z);
            return result;
        },
    };
    return world as unknown as PhysicsWorld;
}

/** Voxel grid with a solid surface block at `surfaceBlockY` everywhere inside its bounds. */
function voxelWorldWithSurface(bounds: TerrainBounds, surfaceBlockY: number): VoxelWorld {
    const world = {
        getBounds: () => bounds,
        getVoxelSize: () => 1,
        getBlock: (x: number, y: number, z: number) => {
            const inside = x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ;
            return inside && y <= surfaceBlockY ? 1 : 0;
        },
    };
    return world as unknown as VoxelWorld;
}

function sources(over: Partial<GroundSources>): GroundSources {
    return { physicsWorld: null, bounds: null, voxelWorld: null, ...over };
}

function resolve(src: GroundSources, x: number, z: number, over: Partial<typeof DEFAULT_GROUND_PLACEMENT_OPTIONS> = {}) {
    return queryGroundPlacement(src, x, z, { ...DEFAULT_GROUND_PLACEMENT_OPTIONS, ...over });
}

describe('queryGroundPlacement — forged level away from the origin', () => {
    // A baked park occupying x 200..251, z 400..434 — the origin is nowhere near it.
    const bounds: TerrainBounds = { minX: 200, minY: 0, minZ: 400, maxX: 251, maxY: 30, maxZ: 434 };
    const forged = sources({
        bounds,
        physicsWorld: physicsWithGroundIn({ minX: 200, maxX: 251, minZ: 400, maxZ: 434 }, 12.5),
    });

    it('resolves lawn inside the real bounds', () => {
        const placement = resolve(forged, 225, 417);
        expect(placement).toMatchObject({ status: 'ok', groundY: 12.5, clampedToBounds: false });
        if (placement.status !== 'ok') throw new Error('expected ok');
        expect(placement.position.x).toBe(225);
        expect(placement.position.z).toBe(417);
    });

    it('rejects the world origin as out-of-bounds and points at the nearest lawn', () => {
        const placement = resolve(forged, 0, 0);
        expect(placement.status).toBe('out-of-bounds');
        if (placement.status !== 'out-of-bounds') throw new Error('expected out-of-bounds');
        expect(placement.bounds).toBe(bounds);
        expect(placement.nearestX).toBeCloseTo(200.5, 6); // minX + default 0.5 m margin
        expect(placement.nearestZ).toBeCloseTo(400.5, 6);
    });

    it('clamps into the level when asked instead of failing', () => {
        const placement = resolve(forged, 0, 0, { clampToBounds: true });
        expect(placement).toMatchObject({ status: 'ok', groundY: 12.5, clampedToBounds: true });
        if (placement.status !== 'ok') throw new Error('expected ok');
        expect(placement.position.x).toBeCloseTo(200.5, 6);
        expect(placement.position.z).toBeCloseTo(400.5, 6);
    });

    it('rejects a point inside the configured ground size but outside the actual map', () => {
        // The 2016 x 2016 plane case: well within a configured size, far outside the level.
        expect(resolve(forged, 900, 900).status).toBe('out-of-bounds');
    });
});

describe('queryGroundPlacement — procedural centred world', () => {
    const bounds: TerrainBounds = { minX: -64, minY: -16, minZ: -64, maxX: 64, maxY: 64, maxZ: 64 };

    it('resolves through the collider world', () => {
        const placement = resolve(
            sources({ bounds, physicsWorld: physicsWithGroundIn({ minX: -64, maxX: 64, minZ: -64, maxZ: 64 }, 3) }),
            -20,
            8,
        );
        expect(placement).toMatchObject({ status: 'ok', groundY: 3 });
    });

    it('falls back to the voxel grid while terrain colliders are still building', () => {
        const placement = resolve(sources({ bounds, voxelWorld: voxelWorldWithSurface(bounds, 6) }), -20, 8);
        // Block centre 6 with size 1 → walkable top 6.5, matching what the raycast reports.
        expect(placement).toMatchObject({ status: 'ok', groundY: 6.5 });
    });

    it('takes the lowest nearby ground so a slope edge does not float', () => {
        const stepped = sources({
            bounds,
            physicsWorld: {
                raycast(origin: THREE.Vector3): RaycastResult {
                    return {
                        hasHit: true,
                        hitPoint: new THREE.Vector3(origin.x, origin.x < 0 ? 2 : 8, origin.z),
                        hitNormal: new THREE.Vector3(0, 1, 0),
                        hitDistance: 0,
                        hitCollider: null,
                        hitRigidBody: null,
                    };
                },
            } as unknown as PhysicsWorld,
        });
        expect(resolve(stepped, 0.5, 0, { sampleRadius: 1 })).toMatchObject({ status: 'ok', groundY: 2 });
    });

    it('reports out-of-bounds beyond the procedural extent', () => {
        expect(resolve(sources({ bounds }), 0, 500).status).toBe('out-of-bounds');
    });
});

describe('queryGroundPlacement — missing ground', () => {
    const bounds: TerrainBounds = { minX: -64, minY: -16, minZ: -64, maxX: 64, maxY: 64, maxZ: 64 };

    it('reports no-ground over a hole instead of Y = 0', () => {
        // In bounds, but the ray misses (hole in the level) and no voxel column exists.
        const holed = sources({
            bounds,
            physicsWorld: physicsWithGroundIn({ minX: 10, maxX: 64, minZ: -64, maxZ: 64 }, 1),
        });
        const placement = resolve(holed, 0, 0);
        expect(placement).toMatchObject({ status: 'no-ground', x: 0, z: 0, bounds });
        expect(placement).not.toHaveProperty('groundY');
    });

    it('reports no-ground when there is no physics world and no voxel grid yet', () => {
        expect(resolve(sources({ bounds }), 0, 0).status).toBe('no-ground');
    });

    it('reports no-ground for the centre even when a neighbour has ground', () => {
        const edge = sources({
            bounds,
            physicsWorld: physicsWithGroundIn({ minX: 2, maxX: 64, minZ: -64, maxZ: 64 }, 4),
        });
        expect(resolve(edge, 0, 0, { sampleRadius: 3 }).status).toBe('no-ground');
    });
});
