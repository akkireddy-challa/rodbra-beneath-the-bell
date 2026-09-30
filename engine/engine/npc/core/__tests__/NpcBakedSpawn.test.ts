import * as THREE from 'three';
import { NpcManager } from 'engine/npc/core/NpcManager.js';

/**
 * NPC spawning on BAKED (.vwld) levels, which expose no voxel grid: every column
 * makes `engine.findValidVoxelSpawnPosition` return null, so the position has to be
 * resolved from the level's colliders instead. Covers the outdoor street, a roofed
 * interior (which must resolve to the ROOM floor, not the roof above it), an
 * obstacle column that must be rejected, and the terminal give-up diagnostic.
 */

const TERRAIN = 512;
const ENVIRONMENT = 2;

/** One horizontal slab in the fake level. */
interface Slab {
    y: number;
    group: number;
    /** Omitted = covers the whole level. */
    within?: (x: number, z: number) => boolean;
}

interface FakeLevel {
    slabs: Slab[];
    /** Columns where the sideways headroom rays hit something (inside a wall). */
    blocked?: (x: number, z: number) => boolean;
}

/**
 * An engine whose only spawn-relevant surface is a physics world raycasting the
 * slabs above. `findValidVoxelSpawnPosition` returning null for every column is
 * exactly what a baked level does — that is the condition under test.
 */
function engineFor(level: FakeLevel): Parameters<typeof makeManager>[0] {
    const miss = { hasHit: false, hitPoint: new THREE.Vector3() };
    return {
        scene: {},
        physicsWorld: {
            raycast: (origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number, mask: number) => {
                if (direction.y === 0) {
                    return level.blocked?.(origin.x, origin.z)
                        ? { hasHit: true, hitPoint: origin.clone() }
                        : miss;
                }
                const hit = level.slabs
                    .filter(s => (s.group & mask) !== 0
                        && (s.within?.(origin.x, origin.z) ?? true)
                        && s.y <= origin.y
                        && origin.y - s.y <= maxDistance)
                    .sort((a, b) => b.y - a.y)[0];
                return hit ? { hasHit: true, hitPoint: new THREE.Vector3(origin.x, hit.y, origin.z) } : miss;
            },
        },
        // Baked level: no voxel grid, so every column is rejected here.
        findValidVoxelSpawnPosition: () => null,
        getGameData: () => ({
            worldProfileData: { groundWorldSizeX: 64, groundWorldSizeZ: 64, voxelUrl: 'level.vwld' },
        }),
        getDynamicObjectManager: () => ({ getTerrainBounds: () => ({ maxY: 20 }) }),
    };
}

/**
 * A level where no column is ever spawnable: bare ground under a solid roof slab
 * (rejected as a prop top) with every sideways ray blocked (no standing room, and
 * the Spawner's isOpenArea check fails too). Used for the permanent-failure cases.
 */
const unspawnableLevel = (): FakeLevel => ({
    slabs: [{ y: 0, group: TERRAIN }, { y: 5, group: ENVIRONMENT }],
    blocked: () => true,
});

/** A manager wired to `engine`, without running the real (async, asset-loading) constructor. */
function makeManager(engine: unknown): NpcManager {
    const manager = Object.create(NpcManager.prototype) as NpcManager;
    Object.assign(manager as unknown as Record<string, unknown>, {
        engine,
        managerBehavior: { getName: () => 'guard' },
        pendingPositionRetries: [],
        physicsSpawnFinder: null,
        fallbackSpawner: null,
        warnedPositionRetriesFull: false,
        characterFactory: null,
    });
    return manager;
}

/** `findSpawnPosition` is private; these tests are its contract. */
function findSpawn(manager: NpcManager, x?: number, z?: number, y?: number): { position: THREE.Vector3 | null; reason: string } {
    const callable = manager as unknown as {
        findSpawnPosition(x?: number, z?: number, y?: number): { position: THREE.Vector3 | null; reason: string };
    };
    return callable.findSpawnPosition(x, z, y);
}

describe('NpcManager baked-level spawn resolution', () => {
    it('resolves outdoor terrain when the voxel grid rejects every column', () => {
        // Bare street at y = 3. Without the physics fallback the voxel finder's null
        // is final and the NPC never appears — the reported bug.
        const engine = engineFor({ slabs: [{ y: 3, group: TERRAIN }] });
        const { position } = findSpawn(makeManager(engine), 12, 20);

        expect(position).not.toBeNull();
        expect(position!.y).toBe(3);
        // x/z honoured verbatim (voxel-centre snapped) — distinct requests must not collapse.
        expect(position!.x).toBe(12.5);
        expect(position!.z).toBe(20.5);
    });

    it('resolves a roofed room to its OWN floor when spawnY is given, not the roof above it', () => {
        // A one-storey house: floor y = 0, roof y = 4, over the whole level.
        const engine = engineFor({ slabs: [{ y: 0, group: TERRAIN }, { y: 4, group: ENVIRONMENT }] });
        const manager = makeManager(engine);

        // Indoors: probing DOWN from the room's walk height finds the room floor.
        expect(findSpawn(manager, 8, 8, 1).position!.y).toBe(0);

        // The same coord WITHOUT spawnY resolves top-down and lands on the roof — this is
        // why an indoor spawn must pass y, and why the give-up warning says so.
        expect(findSpawn(manager, 8, 8).position!.y).toBe(4);
    });

    it('rejects an obstacle column with no standing room and reports the interior reason', () => {
        // Same house, but this column is inside a wall: the sideways headroom rays hit,
        // so neither the shared finder nor the Spawner's isOpenArea accepts it.
        const engine = engineFor(unspawnableLevel());
        const { position, reason } = findSpawn(makeManager(engine), 8, 8, 1);

        expect(position).toBeNull();
        expect(reason).toBe('no-interior-floor-below-spawnY');
    });

    it('reports the outdoor reason when nothing anywhere is spawnable', () => {
        const engine = engineFor(unspawnableLevel());
        const { position, reason } = findSpawn(makeManager(engine), 8, 8);

        expect(position).toBeNull();
        expect(reason).toBe('no-open-floor-on-baked-level');
    });

    it('honours DISTINCT requested coords rather than collapsing them onto one point', () => {
        // A patrol line-up: each enemy must keep its own x/z.
        const engine = engineFor({ slabs: [{ y: 2, group: TERRAIN }] });
        const manager = makeManager(engine);
        const xs = [4, 18, 33, 51].map(x => findSpawn(manager, x, 10).position!.x);

        expect(xs).toEqual([4.5, 18.5, 33.5, 51.5]);
    });

    it('builds the physics finder once per manager, not once per spawn', () => {
        // Regression guard: rebuilding it per call would re-read the terrain bounds
        // on every retry of every wave.
        const engine = engineFor({ slabs: [{ y: 1, group: TERRAIN }] });
        const manager = makeManager(engine);
        findSpawn(manager, 5, 5);
        const first = (manager as unknown as { physicsSpawnFinder: unknown }).physicsSpawnFinder;
        findSpawn(manager, 6, 6);

        expect(first).not.toBeNull();
        expect((manager as unknown as { physicsSpawnFinder: unknown }).physicsSpawnFinder).toBe(first);
    });

    it('never replaces the game\'s own findValidVoxelSpawnPosition hook', () => {
        // The repair this fix replaces monkey-patched the engine hook, which changes
        // spawning for every other system that reads it (animals, pickups, the player).
        const engine = engineFor({ slabs: [{ y: 1, group: TERRAIN }] });
        const hook = engine.findValidVoxelSpawnPosition;
        findSpawn(makeManager(engine), 5, 5, 1);

        expect(engine.findValidVoxelSpawnPosition).toBe(hook);
    });
});

describe('NpcManager position-retry bounding', () => {
    /** Drive spawnNpc's position-failure branch with prerequisites already satisfied. */
    function unspawnableManager(): { manager: NpcManager; warnings: string[] } {
        const manager = makeManager(engineFor(unspawnableLevel()));
        Object.assign(manager as unknown as Record<string, unknown>, {
            autoRegisterWithRegistry: () => { /* no registry in this test */ },
            requestNpcSkeleton: () => { /* no asset loading in this test */ },
            validateSpawnPrerequisites: () => ({ ready: true, reason: '' }),
        });
        const warnings: string[] = [];
        jest.spyOn(console, 'warn').mockImplementation((msg: string) => { warnings.push(String(msg)); });
        return { manager, warnings };
    }

    afterEach(() => { jest.restoreAllMocks(); });

    it('re-queues a failed request with an incremented attempt count', async () => {
        const { manager } = unspawnableManager();
        await manager.spawnNpc(8, 8, undefined, 0, 1, 0);

        const queue = (manager as unknown as { pendingPositionRetries: Array<{ attempt: number; y?: number }> }).pendingPositionRetries;
        expect(queue).toHaveLength(1);
        expect(queue[0].attempt).toBe(1);
        // The interior height must survive the round trip, or the retry resolves the roof.
        expect(queue[0].y).toBe(1);
    });

    it('stops re-queuing at the attempt cap and warns with the coords and reason', async () => {
        const { manager, warnings } = unspawnableManager();
        const cap = (NpcManager as unknown as { MAX_POSITION_ATTEMPTS: number }).MAX_POSITION_ATTEMPTS;

        await manager.spawnNpc(8, 24, undefined, 0, 1.5, cap);

        // Terminal: nothing re-queued, so the request cannot cycle for the whole session.
        expect((manager as unknown as { pendingPositionRetries: unknown[] }).pendingPositionRetries).toHaveLength(0);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('x=8.0');
        expect(warnings[0]).toContain('z=24.0');
        expect(warnings[0]).toContain('y=1.5');
        expect(warnings[0]).toContain('no-interior-floor-below-spawnY');
    });

    it('names the missing interior height when a top-down spawn gives up', async () => {
        const { manager, warnings } = unspawnableManager();
        const cap = (NpcManager as unknown as { MAX_POSITION_ATTEMPTS: number }).MAX_POSITION_ATTEMPTS;

        await manager.spawnNpc(8, 24, undefined, 0, undefined, cap);

        expect(warnings[0]).toContain('y=none');
        expect(warnings[0]).toContain('no-open-floor-on-baked-level');
    });
});
