/**
 * Colliders must not cost a materialisation.
 *
 * A VoxelObject keeps its voxels compactly in a LeafBuffer (~9 B/leaf); the
 * `octreeLeaves` getter expands that into one JS object per voxel (~10× the
 * bytes) and drops the buffer permanently. Every physics path used to read the
 * getter, so any octree asset WITH colliders paid the expansion at load — on a
 * city's landmark set that alone was ~600 MB of heap, enough to push iPhone
 * loads over the jetsam line while the geometry itself stayed modest.
 *
 * These tests pin the two halves of the fix: the greedy mesher produces the
 * SAME boxes from a LeafBuffer as from the equivalent array (colliders can't
 * silently change shape), and the physics entry points leave `_leafBuffer`
 * resident — `_octreeLeaves` stays null.
 */

import { initRapier } from 'engine/physics/RapierPhysics.js';
import { VoxelObject } from 'engine/VoxelObject.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import { encodeVxlV3, type VxlV3Data } from 'engine/VxlV3Format.js';
import {
    LeafBuffer, greedyMeshOctreeLeaves, octreeTotalVolume, leafSourceCount,
    type OctreeLeaf,
} from 'engine/VoxelOctreeRenderer.js';

beforeAll(async () => {
    // ColliderDesc/RigidBodyDesc construction goes through the Rapier module.
    await initRapier();
});

const leaf = (x: number, y: number, z: number, size: number): OctreeLeaf =>
    ({ x, y, z, size, r: 0.5, g: 0.5, b: 0.5 });

// Grid-aligned so LeafBuffer.fromArray round-trips positions exactly.
const LEAVES_A: OctreeLeaf[] = [leaf(0, 0, 0, 1), leaf(1, 0, 0, 1), leaf(0, 1, 0, 1), leaf(4, 0, 4, 2)];
const LEAVES_B: OctreeLeaf[] = [leaf(8, 0, 0, 1), leaf(8, 1, 0, 1)];

describe('greedy mesher over LeafSources', () => {
    it('produces identical boxes from a LeafBuffer and from the equivalent array', () => {
        const fromArray = greedyMeshOctreeLeaves(LEAVES_A, 0.5, 0, 0.5, 1);
        const fromBuffer = greedyMeshOctreeLeaves(LeafBuffer.fromArray(LEAVES_A, 1, 0, 0, 0), 0.5, 0, 0.5, 1);
        expect(fromBuffer).toEqual(fromArray);
    });

    it('a source LIST equals the flattened array (multi-fragment union)', () => {
        const flattened = greedyMeshOctreeLeaves([...LEAVES_A, ...LEAVES_B], 0, 0, 0, 1);
        const asSources = greedyMeshOctreeLeaves(
            [LeafBuffer.fromArray(LEAVES_A, 1, 0, 0, 0), LEAVES_B],
            0, 0, 0, 1,
        );
        expect(asSources).toEqual(flattened);
    });

    it('volume and count agree across forms', () => {
        const buf = LeafBuffer.fromArray(LEAVES_A, 1, 0, 0, 0);
        expect(octreeTotalVolume(buf)).toBeCloseTo(octreeTotalVolume(LEAVES_A));
        expect(leafSourceCount([buf, LEAVES_B])).toBe(LEAVES_A.length + LEAVES_B.length);
        expect(greedyMeshOctreeLeaves([], 0, 0, 0, 1)).toEqual([]);
    });
});

/** Enough of PhysicsWorld for the static/dynamic body builders. */
function stubPhysicsWorld(): { world: PhysicsWorld; colliderCount: () => number } {
    let colliders = 0;
    const world = {
        // mass() feeds trueUpBodyMass on the dynamic path; any positive value
        // reads as "already at target" and leaves the colliders untouched.
        createRigidBody: () => ({ handle: 1, mass: () => 10 }),
        // shape/translation feed the dynamic path's collider-bottom scan.
        createCollider: () => {
            colliders++;
            return {
                handle: colliders,
                shape: { halfExtents: { x: 0.5, y: 0.5, z: 0.5 } },
                translation: () => ({ x: 0, y: 0, z: 0 }),
            };
        },
        setUserData: () => undefined,
    } as unknown as PhysicsWorld;
    return { world, colliderCount: () => colliders };
}

async function loadV3Object(fragments: OctreeLeaf[][]): Promise<VoxelObject> {
    const data: VxlV3Data = {
        minVoxelSize: 1, maxVoxelSize: 2, physicsGridStep: 1,
        bounds: { minX: 0, minY: 0, minZ: 0, maxX: 12, maxY: 8, maxZ: 12 },
        useAtlas: false,
        fragments: fragments.map(leaves => ({ aabbMin: [0, 0, 0], aabbMax: [12, 8, 12], leaves })),
    };
    const bytes = await encodeVxlV3(data);
    const vox = new VoxelObject({ voxelSize: 1 });
    const bounds = await vox.loadFromFile(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    );
    expect(bounds).not.toBeNull();
    return vox;
}

/** The buffer is resident and no per-voxel objects were materialised. */
function expectCompact(vox: VoxelObject): void {
    expect(vox['_leafBuffer']).toBeInstanceOf(LeafBuffer);
    expect(vox['_octreeLeaves']).toBeNull();
}

/** Every entry point that builds colliders from a single-fragment asset. */
const PHYSICS_ENTRY_POINTS: ReadonlyArray<[string, (vox: VoxelObject, world: PhysicsWorld) => void]> = [
    ['createPhysicsBody', (vox, world) => vox.createPhysicsBody(world)],
    ['createPhysicsBodyAtPosition (the batched env-instance path)',
        (vox, world) => { vox.createPhysicsBodyAtPosition(world, 3, 0, -2, 0.5); }],
    ['createDynamicPhysicsBody', (vox, world) => vox.createDynamicPhysicsBody(world, 10)],
];

describe('physics builds keep the LeafBuffer resident', () => {
    it.each(PHYSICS_ENTRY_POINTS)('%s on a single-fragment v3 asset', async (_name, buildBody) => {
        const vox = await loadV3Object([LEAVES_A]);
        expectCompact(vox);

        const { world, colliderCount } = stubPhysicsWorld();
        buildBody(vox, world);

        expect(colliderCount()).toBeGreaterThan(0);
        expectCompact(vox);
    });

    it('createPhysicsBody on a multi-fragment asset keeps every fragment compact', async () => {
        const vox = await loadV3Object([LEAVES_A, LEAVES_B]);
        const fragments = vox['_fragments'];
        expect(fragments).not.toBeNull();

        const { world, colliderCount } = stubPhysicsWorld();
        vox.createPhysicsBody(world);

        expect(colliderCount()).toBeGreaterThan(0);
        for (const child of fragments!) expectCompact(child);
    });

    it('getVoxelCount answers from the buffer without expanding it', async () => {
        const vox = await loadV3Object([LEAVES_A, LEAVES_B]);
        expect(vox.getVoxelCount()).toBe(LEAVES_A.length + LEAVES_B.length);
        for (const child of vox['_fragments']!) expectCompact(child);
    });
});
