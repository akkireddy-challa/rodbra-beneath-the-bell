import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { EngineLike, WorldProfileData } from 'types/game.js';
import { PLAYER_REST_CLEARANCE_M, PlayerLoader } from 'engine/loaders/PlayerLoader.js';

/**
 * Spawn placement for INTERIOR spawn points (forged dungeons, voxelised
 * building rooms, caves).
 *
 * getWorldHeightAt is a TOP-DOWN query: inside a roofed structure it returns
 * the surface ABOVE the whole structure, so any correction that lifts to it
 * teleports the player onto the roof/terrain plate instead of the room floor.
 * These tests pin the room-floor outcome while keeping the outdoor lifts.
 *
 * Colliders are modelled analytically as vertical solid bands; capsuleOverlaps
 * is exact for an upright capsule, so the placement decision is the only thing
 * under test.
 */
interface Slab {
    /** Bottom of the solid band (world Y). */
    min: number;
    /** Top of the solid band (world Y). */
    max: number;
}

/** loadHeadlessPlayer() hardcodes the radius and takes the height from world.json. */
const CAPSULE_HEIGHT = 1.8;

/** Interior floor top — the surface the player must end up standing on. */
const FLOOR_Y = 20;
/** Top of the terrain plate covering the room — what getWorldHeightAt returns inside. */
const PLATE_TOP_Y = 28;
/** Every correction parks the capsule this far above the surface. Imported, not
 *  copied — a local literal drifts silently when the engine constant changes. */
const REST_CLEARANCE = PLAYER_REST_CLEARANCE_M;
/** Downward-search step in PlayerLoader (SUPPORT_PROBE / 2). */
const DESCENT_STEP = 0.05;
/** MAX_INTERIOR_DESCENT_M in PlayerLoader: how far below the spawn a floor is looked for. */
const MAX_INTERIOR_DESCENT_M = 3.0;

/** Room with 3.2 m of headroom, buried under a terrain plate. */
const INTERIOR_SLABS: Slab[] = [
    { min: FLOOR_Y - 1, max: FLOOR_Y },
    { min: FLOOR_Y + 3.2, max: FLOOR_Y + 4.2 },
    { min: PLATE_TOP_Y - 1, max: PLATE_TOP_Y },
];

/** Captures the position handed to the physics layer instead of building a Rapier body. */
class SpawnProbeLoader extends PlayerLoader {
    placedY = Number.NaN;

    createPhysicsBody(position: THREE.Vector3): RAPIER.RigidBody {
        this.placedY = position.y;
        return { handle: 0 } as unknown as RAPIER.RigidBody;
    }
}

interface PlacementResult {
    /** Y the player body was created at (capsule foot). */
    placedY: number;
    /** True when PlayerLoader logged a ground correction. */
    corrected: boolean;
}

async function placePlayer(opts: {
    configuredY: number;
    slabs: Slab[];
    worldHeightAt: number;
}): Promise<PlacementResult> {
    const physicsWorld = {
        capsuleOverlaps(
            center: { x: number; y: number; z: number },
            radius: number,
            halfHeight: number,
        ): boolean {
            const halfExtent = halfHeight + radius;
            const lo = center.y - halfExtent;
            const hi = center.y + halfExtent;
            return opts.slabs.some((s) => hi > s.min && lo < s.max);
        },
        // No horizontal hit anywhere → the enclosure warning stays quiet.
        raycast(): { hasHit: boolean } {
            return { hasHit: false };
        },
    };

    const engine = {
        scene: null,
        physicsWorld,
        getWorldHeightAt: (): number => opts.worldHeightAt,
    } as unknown as EngineLike;

    const worldProfileData = {
        characterHeight: CAPSULE_HEIGHT,
        spawnPoints: [
            { id: 'spawn', type: 'player', position: { x: 0, y: opts.configuredY, z: 0 }, rotationY: 0 },
        ],
    } as unknown as WorldProfileData;

    const loader = new SpawnProbeLoader(engine, worldProfileData);
    const logs: string[] = [];
    const logSpy = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        logs.push(args.map((a) => String(a)).join(' '));
    });
    try {
        await loader.loadHeadlessPlayer();
    } finally {
        logSpy.mockRestore();
    }

    return {
        placedY: loader.placedY,
        corrected: logs.some((l) => l.includes('Ground-corrected spawn')),
    };
}

describe('PlayerLoader interior spawn placement', () => {
    it('seats a head-in-ceiling interior spawn on the room floor, not on the plate above', async () => {
        // Configured 1.5 above the floor → foot at +2.0, head inside the ceiling slab.
        const { placedY, corrected } = await placePlayer({
            configuredY: FLOOR_Y + 1.5,
            slabs: INTERIOR_SLABS,
            worldHeightAt: PLATE_TOP_Y,
        });

        expect(placedY).toBeGreaterThan(FLOOR_Y - 0.3);
        expect(placedY).toBeLessThan(FLOOR_Y + 0.3);
        expect(placedY).toBeLessThan(PLATE_TOP_Y); // never parked on the terrain plate
        expect(corrected).toBe(true);
    });

    it('seats a floating-but-fitting interior spawn on the room floor, not on the plate above', async () => {
        // Configured at floor level → foot at +0.5: the capsule fits but nothing supports it.
        const { placedY, corrected } = await placePlayer({
            configuredY: FLOOR_Y,
            slabs: INTERIOR_SLABS,
            worldHeightAt: PLATE_TOP_Y,
        });

        expect(placedY).toBeGreaterThan(FLOOR_Y - 0.3);
        expect(placedY).toBeLessThan(FLOOR_Y + 0.3);
        expect(placedY).toBeLessThan(PLATE_TOP_Y);
        expect(corrected).toBe(true);
    });

    it('leaves an already-correct interior spawn untouched', async () => {
        // Configured 0.5 below the floor → foot exactly on the floor, supported.
        const { placedY, corrected } = await placePlayer({
            configuredY: FLOOR_Y - 0.5,
            slabs: INTERIOR_SLABS,
            worldHeightAt: PLATE_TOP_Y,
        });

        expect(placedY).toBeCloseTo(FLOOR_Y, 6);
        expect(corrected).toBe(false);
    });

    it('still lifts an outdoor spawn buried in terrain up to the surface', async () => {
        // Solid ground all the way up to the surface — no interior floor to seat on.
        const { placedY, corrected } = await placePlayer({
            configuredY: FLOOR_Y,
            slabs: [{ min: -5, max: PLATE_TOP_Y }],
            worldHeightAt: PLATE_TOP_Y,
        });

        expect(placedY).toBeCloseTo(PLATE_TOP_Y + REST_CLEARANCE, 6);
        expect(corrected).toBe(true);
    });

    it('seats the descended player one rest clearance above the floor, not flush on it', async () => {
        const { placedY } = await placePlayer({
            configuredY: FLOOR_Y + 1.5,
            slabs: INTERIOR_SLABS,
            worldHeightAt: PLATE_TOP_Y,
        });

        // The raw lattice point can land flush on the floor; the seat is normalized
        // to the same rest pose the lift produces, so the feet never sink in.
        //
        // The bound is exact, not a sanity range. The accept window above a floor is
        // SUPPORT_PROBE tall and the step is half of it, so exactly two lattice points
        // qualify and first-match-wins always takes the upper one — the raw candidate
        // lands in [FLOOR_Y, FLOOR_Y + DESCENT_STEP), hence a normalized clearance of
        // [REST_CLEARANCE, REST_CLEARANCE + DESCENT_STEP). Dropping the normalization
        // moves it to [0, DESCENT_STEP) and fails the lower bound.
        const clearance = placedY - FLOOR_Y;
        expect(clearance).toBeGreaterThanOrEqual(REST_CLEARANCE - 1e-6);
        expect(clearance).toBeLessThan(REST_CLEARANCE + DESCENT_STEP);
    });

    it('does not descend to a floor further below than the search budget', async () => {
        // Tall room: the spawn floats 4.2 m above its floor — past MAX_INTERIOR_DESCENT_M —
        // so the legacy lift must still win. The cap bounds the search; it is the
        // first-match-wins scan (nearest floor beneath) that keeps a reachable spawn indoors.
        const spawnAboveFloor = MAX_INTERIOR_DESCENT_M + 1.2;
        const { placedY } = await placePlayer({
            configuredY: FLOOR_Y + spawnAboveFloor - 0.5, // +0.5 lift → foot at FLOOR_Y + 4.2
            slabs: [
                { min: FLOOR_Y - 1, max: FLOOR_Y },
                { min: FLOOR_Y + 10, max: FLOOR_Y + 11 }, // ceiling well clear of the capsule
                { min: PLATE_TOP_Y + 6, max: PLATE_TOP_Y + 7 },
            ],
            worldHeightAt: PLATE_TOP_Y + 7,
        });

        expect(placedY).toBeCloseTo(PLATE_TOP_Y + 7 + REST_CLEARANCE, 6);
        expect(placedY).toBeGreaterThan(FLOOR_Y + spawnAboveFloor); // never seated on the far floor
    });

    it('leaves an outdoor spawn floating in open air above the ground to gravity', async () => {
        // Ground far below and no floor within the descent budget → no correction at all.
        const { placedY, corrected } = await placePlayer({
            configuredY: FLOOR_Y,
            slabs: [{ min: -5, max: 0 }],
            worldHeightAt: 0,
        });

        expect(placedY).toBeCloseTo(FLOOR_Y + 0.5, 6); // configured Y + the placeGroupAtSpawn lift
        expect(corrected).toBe(false);
    });
});
