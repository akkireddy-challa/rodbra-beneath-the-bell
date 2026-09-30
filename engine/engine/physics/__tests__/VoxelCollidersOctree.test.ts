/**
 * The octree collider path — the one every placed VXL building and pristine
 * fragment union goes through — builds ONE voxels collider from the rasterized
 * leaf grid. The collider and the greedy mesher rasterize the same grid, so the
 * surface heights below are fixed by the raster convention (cell g spans
 * [g, g+1] * step); this suite pins them, including the parent-scale
 * composition, against real WASM. Dynamic bodies get cuboids instead.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { createOctreeColliders, type OctreeLeaf } from 'engine/VoxelOctreeRenderer.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';

const LEAF = 0.0625;
/** What a bake stores for a 0.0625 m asset: `clamp(minVoxelSize * 4, 0.1, 0.5)`. */
const BAKED_STEP = 0.25;

function leaf(x: number, y: number, z: number): OctreeLeaf {
    return { x, y, z, size: LEAF, r: 0.5, g: 0.5, b: 0.5 };
}

function slab(
    x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
): OctreeLeaf[] {
    const out: OctreeLeaf[] = [];
    for (let x = x0; x < x1 - 1e-9; x += LEAF) {
        for (let y = y0; y < y1 - 1e-9; y += LEAF) {
            for (let z = z0; z < z1 - 1e-9; z += LEAF) out.push(leaf(x, y, z));
        }
    }
    return out;
}

// A 1 x 0.5 x 1 m ground slab with a 0.5 x 0.25 x 0.5 m block on top. The
// refined grid step for this shape is 0.1875 m (thinnest extent 0.75 / 4), so
// the slab's 0.5 m interior top is NOT grid-aligned: the conservative fill
// rounds it up to the next cell row at 0.5625. The block top (0.75 = 4 cells)
// is exact.
const terrain = [
    ...slab(0, 0, 0, 1.0, 0.5, 1.0),
    ...slab(0.25, 0.5, 0.25, 0.75, 0.75, 0.75),
];
const SLAB_TOP = 0.5625;
const BLOCK_TOP = 0.75;

/** Surface height under a downward ray, or null when nothing is hit. */
function topAt(world: RAPIER.World, x: number, z: number): number | null {
    const hit = world.castRay(new RAPIER.Ray({ x, y: 10, z }, { x: 0, y: -1, z: 0 }), 20, true);
    return hit ? +(10 - hit.timeOfImpact).toFixed(4) : null;
}

function physicsWorldOver(world: RAPIER.World): PhysicsWorld {
    return { createCollider: (d: RAPIER.ColliderDesc, b: RAPIER.RigidBody) => world.createCollider(d, b) } as unknown as PhysicsWorld;
}

/**
 * Build the static octree collider inside a fresh world and measure the surface
 * at the sample points (post-scale coordinates), then drop a small box on the
 * first sample and read where it settles.
 */
function buildAndMeasure(
    scale: { sx: number; sy: number; sz: number } | undefined,
    samples: Array<[number, number]>,
): { shapeType: number; heights: Array<number | null>; settleY: number } {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const colliders = createOctreeColliders(terrain, 0, 0, 0, BAKED_STEP, physicsWorldOver(world), body, 0xffffffff, scale);
    expect(colliders).toHaveLength(1);
    const shapeType = colliders[0]!.shape.type;

    world.step(); // scene queries see new colliders after the next step
    const heights = samples.map(([x, z]) => topAt(world, x, z));

    const box = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(samples[0]![0], 3, samples[0]![1]));
    world.createCollider(RAPIER.ColliderDesc.cuboid(0.05, 0.05, 0.05).setDensity(500), box);
    for (let i = 0; i < 300; i++) world.step();
    const settleY = box.translation().y;
    world.free();
    return { shapeType, heights, settleY };
}

describe('createOctreeColliders (the static voxel-object path)', () => {
    beforeAll(async () => { await RAPIER.init(); });

    it('builds one voxels collider whose surface follows the raster convention', () => {
        const samples: Array<[number, number]> = [
            [0.1, 0.1],   // slab top: 0.5625
            [0.9, 0.9],   // slab top: 0.5625
            [0.5, 0.5],   // raised block top: 0.75
            [1.6, 0.5],   // off the object: no hit
        ];
        const r = buildAndMeasure(undefined, samples);
        expect(r.shapeType).toBe(RAPIER.ShapeType.Voxels);
        expect(r.heights).toEqual([SLAB_TOP, SLAB_TOP, BLOCK_TOP, null]);
        // A small box dropped on the slab comes to rest on it.
        expect(r.settleY).toBeCloseTo(SLAB_TOP + 0.05, 2);
    });

    it('composes parent scale through the cell size and origin', () => {
        // Scale (2, 1, 0.5): the slab becomes 2 x 0.5 x 0.5, the block top
        // stays at y = 0.75. Sample in POST-scale coordinates.
        const scale = { sx: 2, sy: 1, sz: 0.5 };
        const samples: Array<[number, number]> = [
            [0.2, 0.1],   // slab top: 0.5625
            [1.8, 0.4],   // slab top near far corner: 0.5625
            [1.0, 0.25],  // raised block top: 0.75
            [2.3, 0.25],  // beyond the scaled extent: no hit
        ];
        const r = buildAndMeasure(scale, samples);
        expect(r.shapeType).toBe(RAPIER.ShapeType.Voxels);
        expect(r.heights).toEqual([SLAB_TOP, SLAB_TOP, BLOCK_TOP, null]);
        expect(r.settleY).toBeCloseTo(SLAB_TOP + 0.05, 2);
    });

    it('gives a dynamic body cuboids, never a voxels shape', () => {
        const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
        const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic());
        const colliders = createOctreeColliders(
            terrain, 0, 0, 0, BAKED_STEP, physicsWorldOver(world), body, 0xffffffff, { dynamic: true, density: 1 },
        );
        expect(colliders.length).toBeGreaterThan(0);
        for (const c of colliders) expect(c.shape.type).toBe(RAPIER.ShapeType.Cuboid);
        world.free();
    });
});
