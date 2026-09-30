import * as THREE from 'three';
import { createPhysicsSpawnFinder, BAKED_ROOFTOP_CLEARANCE_M, type SpawnFinderEngine } from 'engine/bakedSpawnResolver.js';

/**
 * The gridless spawn finder shared by baked v2-octree maps and mesh levels.
 * The fake physics world models one column: an optional TERRAIN floor, an
 * optional ENVIRONMENT prop top above it, an optional roof, and optional
 * side walls that block the headroom rays.
 */
const TERRAIN = 512;
const ENVIRONMENT = 2;

interface Column {
    floorY?: number;
    propTopY?: number;
    roofY?: number;
    walled?: boolean;
}

interface Call { origin: THREE.Vector3; direction: THREE.Vector3; mask: number }

function engineFor(column: Column): { engine: SpawnFinderEngine; calls: Call[] } {
    const calls: Call[] = [];
    const miss = () => ({ hasHit: false, hitPoint: new THREE.Vector3() });
    const engine: SpawnFinderEngine = {
        physicsWorld: {
            raycast: (origin, direction, maxDistance, mask) => {
                calls.push({ origin: origin.clone(), direction: direction.clone(), mask });
                if (direction.y < 0) {
                    const surfaces: Array<{ y: number; group: number }> = [];
                    if (column.floorY !== undefined) surfaces.push({ y: column.floorY, group: TERRAIN });
                    if (column.propTopY !== undefined) surfaces.push({ y: column.propTopY, group: ENVIRONMENT });
                    if (column.roofY !== undefined) surfaces.push({ y: column.roofY, group: TERRAIN });
                    const hit = surfaces
                        .filter((s) => (s.group & mask) !== 0 && s.y < origin.y && origin.y - s.y <= maxDistance)
                        .sort((a, b) => b.y - a.y)[0];
                    return hit ? { hasHit: true, hitPoint: new THREE.Vector3(origin.x, hit.y, origin.z) } : miss();
                }
                return column.walled ? { hasHit: true, hitPoint: origin.clone() } : miss();
            },
        },
    };
    return { engine, calls };
}

describe('createPhysicsSpawnFinder', () => {
    it('resolves the bare floor and honours x/z verbatim', () => {
        const { engine } = engineFor({ floorY: 2 });
        const find = createPhysicsSpawnFinder(engine, { maxY: 10 }, { requireHeadroom: false });
        const a = find(3, 7);
        const b = find(-40, 12.5);
        expect(a).toEqual(new THREE.Vector3(3, 2, 7));
        expect(b).toEqual(new THREE.Vector3(-40, 2, 12.5));
    });

    it('returns null over a prop top so the caller retries nearby', () => {
        const { engine } = engineFor({ floorY: 0, propTopY: BAKED_ROOFTOP_CLEARANCE_M + 1 });
        const find = createPhysicsSpawnFinder(engine, { maxY: 10 }, { requireHeadroom: false });
        expect(find(1, 1)).toBeNull();
    });

    it('probes down from fromY so a roofed room resolves to its own floor, not the roof', () => {
        const { engine, calls } = engineFor({ floorY: 1, roofY: 8 });
        const find = createPhysicsSpawnFinder(engine, { maxY: 10 }, { requireHeadroom: false });
        expect(find(0, 0)!.y).toBe(8); // sky-down: roof
        expect(find(0, 0, 3)!.y).toBe(1); // interior: floor
        // The interior probe starts just ABOVE fromY (a caller may pass the floor height
        // itself) and reaches down about one storey — never up from the sky.
        const interiorProbe = calls.filter((c) => c.direction.y < 0 && c.origin.y < 100);
        expect(interiorProbe).toHaveLength(1);
        expect(interiorProbe[0].origin.y).toBeGreaterThan(3);
        expect(interiorProbe[0].origin.y).toBeLessThan(8); // stays under the roof
    });

    it('rejects an interior column with no floor within one storey below fromY', () => {
        // fromY names a height inside a room; a floor 40m down belongs to an unrelated
        // lower storey, and no floor at all means the wrong column. Both must return null
        // so the caller drifts — dropping from the level top would land on the ROOF, the
        // very thing fromY exists to avoid.
        const deep = engineFor({ floorY: -40 });
        expect(createPhysicsSpawnFinder(deep.engine, { maxY: 30 }, { requireHeadroom: false })(0, 0, 2)).toBeNull();
        const empty = engineFor({});
        expect(createPhysicsSpawnFinder(empty.engine, { maxY: 30 }, { requireHeadroom: false })(0, 0, 2)).toBeNull();
        // Without fromY the same empty column still falls back to the drop height.
        expect(createPhysicsSpawnFinder(empty.engine, { maxY: 30 }, { requireHeadroom: false })(0, 0)!.y).toBe(32);
    });

    it('always requires standing room for an interior spawn, even with requireHeadroom off', () => {
        // Inside a roofed room a column wedged in a wall reads as a perfectly good floor
        // from above; only the sideways rays can tell it apart. Baked voxel maps pass
        // requireHeadroom:false for their OUTDOOR contract, which must not leak indoors.
        const walled = engineFor({ floorY: 1, roofY: 8, walled: true });
        expect(createPhysicsSpawnFinder(walled.engine, { maxY: 10 }, { requireHeadroom: false })(0, 0, 3)).toBeNull();
        const open = engineFor({ floorY: 1, roofY: 8 });
        expect(createPhysicsSpawnFinder(open.engine, { maxY: 10 }, { requireHeadroom: false })(0, 0, 3)!.y).toBe(1);
    });

    it('drops from just above the level top when nothing is hit', () => {
        const { engine } = engineFor({});
        const find = createPhysicsSpawnFinder(engine, { maxY: 30 }, { requireHeadroom: false });
        expect(find(0, 0)!.y).toBe(32);
        expect(createPhysicsSpawnFinder(engine, null, { requireHeadroom: false })(0, 0)!.y).toBe(12);
    });

    it('with requireHeadroom rejects a column hemmed in by walls, and accepts an open one', () => {
        const walled = engineFor({ floorY: 0, walled: true });
        expect(createPhysicsSpawnFinder(walled.engine, null, { requireHeadroom: true })(0, 0)).toBeNull();
        expect(createPhysicsSpawnFinder(walled.engine, null, { requireHeadroom: false })(0, 0)).not.toBeNull();
        const open = engineFor({ floorY: 0 });
        const { calls } = open;
        expect(createPhysicsSpawnFinder(open.engine, null, { requireHeadroom: true })(0, 0)).toEqual(new THREE.Vector3(0, 0, 0));
        expect(calls.filter((c) => c.direction.y === 0)).toHaveLength(4);
    });

    it('returns null without a physics world instead of inventing a position', () => {
        const find = createPhysicsSpawnFinder({ physicsWorld: null }, null, { requireHeadroom: true });
        expect(find(0, 0)).toBeNull();
    });
});
