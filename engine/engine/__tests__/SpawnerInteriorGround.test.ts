import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import { Spawner, INTERIOR_PROBE_ABOVE_M, INTERIOR_MAX_DROP_M } from 'engine/Spawner.js';

/**
 * Interior-aware ground resolution regression (the "dungeon enemies on the roof"
 * bug): getGroundHeight() raycasts from the sky, so inside a roofed room it
 * resolves the ROOF, not the room's floor. NpcHandle.spawn(x, z, y) promises
 * floor placement, which needs a probe that starts just above the requested
 * interior height instead.
 *
 * The fake physics world models one column of an enclosed catacombs room:
 * roof slab at y=20, room floor at y=13.625. A downward ray hits the first
 * surface strictly below its origin.
 */
const ROOF_Y = 20;
const FLOOR_Y = 13.625;

interface RaycastCall {
    origin: THREE.Vector3;
    direction: THREE.Vector3;
    maxDistance: number;
}

function roofedRoomEngine(surfaces: number[] = [ROOF_Y, FLOOR_Y]): { engine: EngineLike; calls: RaycastCall[] } {
    const calls: RaycastCall[] = [];
    const physicsWorld = {
        raycast: (origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number) => {
            calls.push({ origin: origin.clone(), direction: direction.clone(), maxDistance });
            if (direction.y >= 0) return { hasHit: false, hitPoint: new THREE.Vector3() }; // sideways rays: open room
            const below = surfaces
                .filter((y) => y < origin.y && origin.y - y <= maxDistance)
                .sort((a, b) => b - a)[0];
            return below !== undefined
                ? { hasHit: true, hitPoint: new THREE.Vector3(origin.x, below, origin.z) }
                : { hasHit: false, hitPoint: new THREE.Vector3() };
        },
    };
    return { engine: { physicsWorld } as unknown as EngineLike, calls };
}

describe('Spawner interior ground resolution', () => {
    it('getGroundHeight (sky-down) resolves the ROOF of an enclosed room — the documented baseline', () => {
        const { engine } = roofedRoomEngine();
        const spawner = new Spawner(engine);
        expect(spawner.getGroundHeight(4, 4)).toBe(ROOF_Y);
    });

    it('getGroundHeightBelow resolves the room FLOOR when given the interior height', () => {
        const { engine } = roofedRoomEngine();
        const spawner = new Spawner(engine);
        expect(spawner.getGroundHeightBelow(4, 4, FLOOR_Y)).toBe(FLOOR_Y);
    });

    it('getGroundHeightBelow starts its probe under the ceiling, not in the sky', () => {
        const { engine, calls } = roofedRoomEngine();
        const spawner = new Spawner(engine);
        spawner.getGroundHeightBelow(4, 4, FLOOR_Y);
        expect(calls).toHaveLength(1);
        expect(calls[0]!.origin.y).toBeCloseTo(FLOOR_Y + INTERIOR_PROBE_ABOVE_M, 5);
        expect(calls[0]!.origin.y).toBeLessThan(ROOF_Y);
    });

    it('getGroundHeightBelow rejects a column whose floor is more than a storey below', () => {
        // Only surface is a basement far below the requested height — wrong column.
        const { engine } = roofedRoomEngine([FLOOR_Y - INTERIOR_MAX_DROP_M - 5]);
        const spawner = new Spawner(engine);
        expect(spawner.getGroundHeightBelow(4, 4, FLOOR_Y)).toBeNull();
    });

    it('getGroundHeightBelow returns null without a physics world (no terrain-function roof fallback)', () => {
        // getWorldHeightAt reports the exterior surface; the interior probe must NOT use it.
        const engine = {
            getWorldHeightAt: () => ROOF_Y,
        } as unknown as EngineLike;
        const spawner = new Spawner(engine);
        expect(spawner.getGroundHeightBelow(4, 4, FLOOR_Y)).toBeNull();
    });

    it('isOpenAreaAtHeight probes sideways at the GIVEN storey, not the roof', () => {
        const { engine, calls } = roofedRoomEngine();
        const spawner = new Spawner(engine);
        expect(spawner.isOpenAreaAtHeight(4, 4, FLOOR_Y)).toBe(true);
        const sideRays = calls.filter((c) => c.direction.y === 0);
        expect(sideRays.length).toBe(4);
        for (const ray of sideRays) {
            expect(ray.origin.y).toBeCloseTo(FLOOR_Y + 0.5, 5);
        }
    });

    it('isOpenArea keeps its sky-down behaviour (delegates at the topmost surface)', () => {
        const { engine, calls } = roofedRoomEngine();
        const spawner = new Spawner(engine);
        expect(spawner.isOpenArea(4, 4)).toBe(true);
        const sideRays = calls.filter((c) => c.direction.y === 0);
        expect(sideRays.length).toBe(4);
        for (const ray of sideRays) {
            expect(ray.origin.y).toBeCloseTo(ROOF_Y + 0.5, 5);
        }
    });
});
