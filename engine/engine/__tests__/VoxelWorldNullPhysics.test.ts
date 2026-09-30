/**
 * @jest-environment jsdom
 *
 * jsdom (not the repo-default `node`) because the meshing path VoxelWorld runs
 * on every chunk builds the voxel texture atlas via `document.createElement('canvas')`.
 *
 * ---------------------------------------------------------------------------
 * `VoxelWorld.physicsWorld` became `PhysicsWorld | null` so a 2D-physics lane can
 * render a voxel world it collides against with Rapier 2D (see
 * `engine/physics/VoxelTerrain2D.ts`, which consumes `chunk.collisionBoxes`).
 *
 * VoxelWorld is used by EVERY voxel game, so the change has two contracts, and
 * this suite pins both:
 *
 *   (A) THE NULL LANE STILL RENDERS. `chunk.collisionBoxes` is not merely physics
 *       input — it is the MESH BUILDER's input (`updateCollisionVisualization`
 *       reads it, and so does `setChunksVisible`/`setCollisionBoxesVisible`). The
 *       null early-return in `updateChunkPhysics` therefore has to sit AFTER the
 *       `chunk.collisionBoxes = ...` assignment and before the first Rapier call.
 *       Return one line earlier and the world renders BLACK with no error.
 *
 *   (B) THE 3D LANE IS UNCHANGED. Two teardown guards were widened from
 *       `if (chunk.body)` to `if (chunk.body && this.physicsWorld)`. With a world
 *       present those must be exactly the old condition — a guard that skips
 *       teardown leaks a rigid body and a trimesh collider per chunk rebuild,
 *       which no type check and no crash would reveal.
 *
 * The two lanes are additionally compared box-for-box and vertex-for-vertex, so
 * "the null lane renders the same world" is asserted rather than assumed.
 */
import * as THREE from 'three';
import { VoxelWorld } from 'engine/VoxelWorld.js';
import { physicsBodyRegistry } from 'engine/PhysicsBodyRegistry.js';
import type { CollisionBox } from 'engine/VoxelGeometry.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import { sliceBoxesToPlane } from 'engine/physics/VoxelTerrain2D.js';

/** The private per-chunk state the two lanes have to agree (or deliberately disagree) about. */
interface ChunkPeek {
    collisionBoxes: CollisionBox[] | null;
    collisionMesh: THREE.Object3D | null;
    body: { handle: number } | null;
    colliders: unknown[];
}

function peekChunks(world: VoxelWorld): ChunkPeek[] {
    const chunks = (world as unknown as { chunks: Map<string, ChunkPeek> }).chunks;
    return [...chunks.values()];
}

/**
 * A PhysicsWorld stand-in that RECORDS instead of simulating.
 *
 * Rapier's descriptor builders (`RigidBodyDesc.fixed()`, `ColliderDesc.trimesh()`)
 * are plain JS and run fine without the wasm module initialised, so the whole 3D
 * collider path executes for real up to the world boundary — which is exactly the
 * boundary this suite counts calls across.
 */
/**
 * Handles are unique across the whole FILE, not per world: `physicsBodyRegistry`
 * is a process-global keyed by handle, so recycled handles would silently
 * overwrite an earlier test's entry and make the registry assertions lie.
 */
let nextHandle = 1;

function makeRecordingWorld(): { calls: string[]; world: PhysicsWorld } {
    const calls: string[] = [];
    const world = {
        createRigidBody: () => {
            calls.push('createRigidBody');
            // translation()/rotation() are what VoxelDebrisManager reads off a debris body.
            return {
                handle: nextHandle++,
                translation: () => ({ x: 0, y: 0, z: 0 }),
                rotation: () => ({ x: 0, y: 0, z: 0, w: 1 }),
            };
        },
        createCollider: () => {
            calls.push('createCollider');
            return { handle: nextHandle++, setActiveCollisionTypes: () => { /* no-op */ }, setEnabled: () => { /* no-op */ } };
        },
        removeCollider: () => { calls.push('removeCollider'); },
        removeColliderImmediate: () => { calls.push('removeColliderImmediate'); },
        removeRigidBody: () => { calls.push('removeRigidBody'); },
        removeRigidBodyImmediate: () => { calls.push('removeRigidBodyImmediate'); },
        setUserData: () => { calls.push('setUserData'); },
    };
    return { calls, world: world as unknown as PhysicsWorld };
}

const BOUNDS = { minX: 0, minY: 0, minZ: 0, maxX: 16, maxY: 16, maxZ: 16 };
const STONE = 1;

function makeWorld(physics: PhysicsWorld | null): { world: VoxelWorld; scene: THREE.Scene } {
    const scene = new THREE.Scene();
    const world = new VoxelWorld(physics, scene, { voxelSize: 1, materialType: 'atlas' });
    world.setBounds({ ...BOUNDS });
    return { world, scene };
}

/**
 * A small ledge + step: enough voxels that greedy meshing produces more than one box.
 *
 * `endBatchUpdate()` runs the single physics+meshing pass — deliberately the ONLY
 * pass, so the call counts below are one build's worth and a rebuild is visible.
 */
function stampTerrain(world: VoxelWorld): void {
    world.beginBatchUpdate();
    for (let x = 0; x < 6; x++) for (let z = 0; z < 3; z++) world.setBlock(x, 0, z, STONE);
    for (let x = 2; x < 4; x++) for (let z = 0; z < 3; z++) world.setBlock(x, 1, z, STONE);
    world.endBatchUpdate();
}

function meshPositions(chunk: ChunkPeek): Float32Array {
    const mesh = chunk.collisionMesh;
    if (!(mesh instanceof THREE.Mesh)) throw new Error('chunk has no visual mesh');
    const attr = mesh.geometry.getAttribute('position');
    return attr.array as Float32Array;
}

describe('VoxelWorld with a NULL physics world (the 2D lane)', () => {
    it('still assigns chunk.collisionBoxes — the mesh builder reads it, so it is visual input', () => {
        const { world } = makeWorld(null);
        stampTerrain(world);

        const chunks = peekChunks(world);
        expect(chunks.length).toBeGreaterThan(0);
        const boxes = chunks.flatMap((c) => c.collisionBoxes ?? []);
        // Guard against the "return one line too early" regression: the early
        // return must sit BELOW `chunk.collisionBoxes = ...`.
        expect(boxes.length).toBeGreaterThan(0);
        // ...and the boxes must be real geometry, not empty stubs.
        expect(boxes.every((b) => b.w > 0 && b.h > 0 && b.d > 0)).toBe(true);
    });

    it('still builds the visual chunk mesh and parents it to the scene (no black world)', () => {
        const { world, scene } = makeWorld(null);
        stampTerrain(world);

        const meshes = peekChunks(world).map((c) => c.collisionMesh).filter((m): m is THREE.Mesh => m instanceof THREE.Mesh);
        expect(meshes.length).toBeGreaterThan(0);
        for (const mesh of meshes) {
            expect(mesh.geometry.getAttribute('position').count).toBeGreaterThan(0);
            expect(scene.children).toContain(mesh);
        }
    });

    it('renders the SAME world as the 3D lane — identical collision boxes and mesh vertices', () => {
        const { world: world2d } = makeWorld(null);
        const { world: world3d } = makeWorld(makeRecordingWorld().world);
        stampTerrain(world2d);
        stampTerrain(world3d);

        const a = peekChunks(world2d);
        const b = peekChunks(world3d);
        expect(a).toHaveLength(b.length);
        // Box-for-box: the null branch must not alter what greedy meshing produced.
        expect(a.map((c) => c.collisionBoxes)).toEqual(b.map((c) => c.collisionBoxes));
        // Vertex-for-vertex: and the mesh built from those boxes must be the same mesh.
        for (let i = 0; i < a.length; i++) {
            expect(Array.from(meshPositions(a[i]!))).toEqual(Array.from(meshPositions(b[i]!)));
        }
    });

    it('creates no rigid bodies: chunk.body stays null, chunk.colliders stays empty, stats stay zero', () => {
        const registryBefore = physicsBodyRegistry.size;
        const { world } = makeWorld(null);
        stampTerrain(world);

        for (const chunk of peekChunks(world)) {
            expect(chunk.body).toBeNull();
            expect(chunk.colliders).toEqual([]);
        }
        // `registerPhysicsBody` bookkeeping must not gain phantom entries.
        expect(physicsBodyRegistry.size).toBe(registryBefore);
        expect(world.getPhysicsStats()).toEqual({
            totalRigidBodies: 0,
            totalBoxShapes: 0,
            totalTriMeshShapes: 0,
            estimatedPhysicsMemoryMB: 0,
        });
    });

    it('rebuilding a chunk repeatedly leaves no drift in the physics counters', () => {
        const { world } = makeWorld(null);
        stampTerrain(world);
        for (let i = 0; i < 3; i++) {
            world.setBlock(1, 1, 1, STONE);
            world.setBlock(1, 1, 1, 0);
            world.updatePhysicsAndMeshing(true);
        }

        expect(world.getPhysicsStats().totalRigidBodies).toBe(0);
        expect(world.getPhysicsStats().totalTriMeshShapes).toBe(0);
        for (const chunk of peekChunks(world)) expect(chunk.colliders).toEqual([]);
        // The world is still rendered after all those rebuilds.
        expect(peekChunks(world).flatMap((c) => c.collisionBoxes ?? []).length).toBeGreaterThan(0);
    });

    it('the physics-only APIs degrade to no-ops instead of dereferencing null', () => {
        const { world } = makeWorld(null);
        stampTerrain(world);

        world.enableSmoothSurfaceForBlockType(STONE);
        expect(() => world.createSmoothSurfaceHeightfield(0.1)).not.toThrow();
        expect(world.hasSmoothSurfaceHeightfield()).toBe(false);
        expect(() => world.removeSmoothSurfaceHeightfield()).not.toThrow();
        expect(() => world.clearDebris()).not.toThrow();
    });

    it('destruction still CARVES the voxels even though it spawns no debris bodies', () => {
        const { world } = makeWorld(null);
        stampTerrain(world);
        expect(world.getBlock(3, 1, 1)).toBe(STONE);

        const debris = world.detachBlocksInSphere(3.5, 1.5, 1.5, 1.2, 5, 2);

        // No dynamic bodies (only a 3D world can hold them)...
        expect(debris).toEqual([]);
        // ...but the terrain edit itself happened, and the world re-meshed.
        expect(world.getBlock(3, 1, 1)).toBe(0);
        const meshes = peekChunks(world).map((c) => c.collisionMesh).filter((m): m is THREE.Mesh => m instanceof THREE.Mesh);
        expect(meshes.length).toBeGreaterThan(0);
    });

    it('hands VoxelTerrain2D boxes it can actually slice into the gameplay plane', () => {
        // The whole point of keeping the assignment above the early return: this is
        // the ONLY input the 2D lane's colliders are built from. Non-null is not
        // enough — the boxes have to describe the terrain the player sees.
        const { world } = makeWorld(null);
        stampTerrain(world);

        const boxes = peekChunks(world).flatMap((c) => c.collisionBoxes ?? []);
        const cuboids = sliceBoxesToPlane(boxes, {
            voxelSize: 1,
            chunkWorldX: 0, chunkWorldY: 0, chunkWorldZ: 0,
            slice: { z: 1.5, halfDepth: 0.5 },
        });
        expect(cuboids.length).toBeGreaterThan(0);

        const topAt = (x: number): number => Math.max(
            ...cuboids.filter((c) => x >= c.x - c.hx && x <= c.x + c.hx).map((c) => c.y + c.hy),
            Number.NEGATIVE_INFINITY,
        );
        // stampTerrain lays a 6x3 slab at y=0 with a 2-wide step on top at x in [2,4).
        expect(topAt(0.5)).toBe(1);
        expect(topAt(2.5)).toBe(2);
        expect(topAt(5.5)).toBe(1);
    });

    it('clear() tears the world down without touching physics', () => {
        const { world, scene } = makeWorld(null);
        stampTerrain(world);
        expect(scene.children.length).toBeGreaterThan(0);

        expect(() => world.clear()).not.toThrow();

        expect(peekChunks(world)).toEqual([]);
        expect(scene.children.filter((c) => c.name.startsWith('VoxelChunk_'))).toEqual([]);
        expect(world.getPhysicsStats().totalRigidBodies).toBe(0);
    });
});

describe('VoxelWorld with a 3D physics world (the path every voxel game uses)', () => {
    it('creates one fixed body and at least one collider for a stamped chunk', () => {
        const registryBefore = physicsBodyRegistry.size;
        const { calls, world: physics } = makeRecordingWorld();
        const { world } = makeWorld(physics);
        stampTerrain(world);

        expect(calls.filter((c) => c === 'createRigidBody')).toHaveLength(1);
        expect(calls.filter((c) => c === 'createCollider').length).toBeGreaterThan(0);
        expect(physicsBodyRegistry.size).toBe(registryBefore + 1);

        const stats = world.getPhysicsStats();
        expect(stats.totalRigidBodies).toBe(1);
        expect(stats.totalTriMeshShapes).toBeGreaterThan(0);
        for (const chunk of peekChunks(world)) {
            expect(chunk.body).not.toBeNull();
            expect(chunk.colliders.length).toBeGreaterThan(0);
        }
    });

    it('REBUILDING a chunk still tears the previous body and colliders down', () => {
        // The teardown guard was widened from `if (chunk.body)` to
        // `if (chunk.body && this.physicsWorld)`. With a world present the two must
        // be the same condition; if the second term ever wins, every rebuild leaks a
        // body plus its colliders and totalTriMeshShapes climbs without bound.
        const { calls, world: physics } = makeRecordingWorld();
        const { world } = makeWorld(physics);
        stampTerrain(world);

        const collidersFirstBuild = calls.filter((c) => c === 'createCollider').length;
        const trimeshesAfterFirstBuild = world.getPhysicsStats().totalTriMeshShapes;

        world.setBlock(5, 1, 1, STONE);
        world.updatePhysicsAndMeshing(true);

        expect(calls.filter((c) => c === 'removeRigidBodyImmediate')).toHaveLength(1);
        expect(calls.filter((c) => c === 'removeColliderImmediate')).toHaveLength(collidersFirstBuild);
        // One body at a time, and the trimesh counter returns to a single build's worth.
        expect(world.getPhysicsStats().totalRigidBodies).toBe(1);
        expect(world.getPhysicsStats().totalTriMeshShapes).toBe(trimeshesAfterFirstBuild);
    });

    it('clear() removes every collider and body from the physics world', () => {
        const { calls, world: physics } = makeRecordingWorld();
        const { world } = makeWorld(physics);
        stampTerrain(world);
        const collidersCreated = calls.filter((c) => c === 'createCollider').length;

        world.clear();

        expect(calls.filter((c) => c === 'removeRigidBody')).toHaveLength(1);
        expect(calls.filter((c) => c === 'removeCollider')).toHaveLength(collidersCreated);
        expect(world.getPhysicsStats().totalRigidBodies).toBe(0);
    });

    it('the smooth-surface heightfield is still created and removed through the world', () => {
        // Both heightfield methods gained a `if (!this.physicsWorld) return;` guard.
        // With a world present neither may fire, or snow/ice terrain silently loses
        // its heightfield collider and characters fall through the smoothed surface.
        const { calls, world: physics } = makeRecordingWorld();
        const { world } = makeWorld(physics);
        stampTerrain(world);
        world.enableSmoothSurfaceForBlockType(STONE);
        calls.length = 0;

        world.createSmoothSurfaceHeightfield(0.1);

        expect(calls).toContain('createRigidBody');
        expect(calls).toContain('createCollider');
        expect(world.hasSmoothSurfaceHeightfield()).toBe(true);

        calls.length = 0;
        world.removeSmoothSurfaceHeightfield();

        expect(calls).toEqual(['removeColliderImmediate', 'removeRigidBodyImmediate']);
        expect(world.hasSmoothSurfaceHeightfield()).toBe(false);
    });

    it('destruction still reaches the physics world and spawns debris bodies', () => {
        const { calls, world: physics } = makeRecordingWorld();
        const { world } = makeWorld(physics);
        stampTerrain(world);
        calls.length = 0;

        const debris = world.detachBlocksInSphere(3.5, 1.5, 1.5, 1.2, 5, 2);

        expect(debris.length).toBeGreaterThan(0);
        expect(calls).toContain('setUserData');
        expect(world.getBlock(3, 1, 1)).toBe(0);
    });
});
