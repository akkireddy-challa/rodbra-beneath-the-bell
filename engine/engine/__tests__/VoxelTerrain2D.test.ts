/**
 * Voxel terrain projected onto the 2D gameplay plane (VoxelTerrain2D).
 *
 * The projection is where the arithmetic mistakes live, so it is tested pure —
 * and the one-voxel slice is pinned deliberately: a thicker slab silently makes
 * the collision silhouette the UNION over its depth, so the character walks on
 * a surface the camera never shows.
 *
 * The suite is in three parts:
 *
 *  1. SHAPE — the pure arithmetic, on hand-built boxes.
 *  2. REAL VOXEL DATA — the same greedy-merged `CollisionBox` list the 3D
 *     trimesh is built from, straight out of `generateCollisionBoxes`, sliced
 *     and then compared surface-height-by-surface-height against the voxels it
 *     came from. A projection that agrees with hand-built boxes but disagrees
 *     with the mesher is worth nothing.
 *  3. THE CALLER CONTRACT — nothing calls `buildChunkColliders2D` yet, and the
 *     slice geometry only produces a ONE-voxel silhouette for particular values
 *     of `slice.z` / `slice.halfDepth`. Those requirements are unwritten in the
 *     source, so they are written here, as executable traps: each of these
 *     tests fails the moment the overlap arithmetic moves.
 */
import RAPIER2D from '@dimforge/rapier2d-compat';
import { buildChunkColliders2D, sliceBoxesToPlane, type Cuboid2D, type GameplaySlice, type VoxelTerrain2DOptions } from 'engine/physics/VoxelTerrain2D.js';
import { generateCollisionBoxes, VoxelChunk, CHUNK_SIZE, type CollisionBox } from 'engine/VoxelGeometry.js';
import { initRapier2D } from 'engine/physics/RapierPhysics2D.js';
import { PhysicsWorld2D } from 'engine/physics/PhysicsWorld2D.js';
import { CollisionGroup, CollisionMask, makeCollisionGroups } from 'engine/CollisionLayers.js';

jest.setTimeout(30_000);

const SLICE: GameplaySlice = { z: 0, halfDepth: 0.5 };
const OPTS = { voxelSize: 1, chunkWorldX: 0, chunkWorldY: 0, chunkWorldZ: 0, slice: SLICE };

const box = (o: Partial<CollisionBox>): CollisionBox =>
    ({ x: 0, y: 0, z: 0, w: 1, h: 1, d: 1, ...o } as CollisionBox);

/**
 * The slice that actually yields a ONE-voxel silhouette: centred on a voxel
 * CENTRE, half a voxel thick. `{ z: 0, halfDepth: 0.5 }` — the default the
 * source's own doc comment and the `VoxelPhysics2D` object lane both use — is
 * centred on a voxel BOUNDARY instead, and keeps two layers. See the
 * 'slice alignment' block below.
 */
const voxelCentredSlice = (voxelSize: number): GameplaySlice =>
    ({ z: voxelSize / 2, halfDepth: voxelSize / 2 });

/** Top of the highest cuboid covering world X = `x`, or null where nothing does. */
function surfaceHeightAt(cuboids: readonly Cuboid2D[], x: number): number | null {
    let top: number | null = null;
    for (const c of cuboids) {
        if (x < c.x - c.hx || x > c.x + c.hx) continue;
        const y = c.y + c.hy;
        if (top === null || y > top) top = y;
    }
    return top;
}

/** True where world X = `x` is inside the cuboid's X span (half-open, matching the voxel span). */
const covers = (c: Cuboid2D, x: number): boolean => x >= c.x - c.hx && x < c.x + c.hx;

/**
 * A chunk whose column at (x, z) is solid from y = 0 up to `heights[x] - 1`.
 * `blockType` per Z layer, so the greedy mesher does NOT merge layers together
 * — the seam tests need the plane's layer to be its own box.
 */
function chunkFromProfile(
    layers: ReadonlyArray<{ z: number; heights: readonly number[]; blockType: number }>,
): VoxelChunk {
    const chunk = new VoxelChunk();
    for (const layer of layers) {
        for (let x = 0; x < layer.heights.length; x++) {
            const h = layer.heights[x]!;
            for (let y = 0; y < h; y++) chunk.set(x, y, layer.z, layer.blockType);
        }
    }
    return chunk;
}

describe('sliceBoxesToPlane', () => {
    it('keeps a box on the plane and converts it to a world-space centre + half extents', () => {
        const [c] = sliceBoxesToPlane([box({ x: 2, y: 3, z: 0, w: 4, h: 2, d: 1 })], OPTS);
        expect(c).toEqual({ x: 4, y: 4, hx: 2, hy: 1 });
    });

    it('drops boxes entirely outside the slice', () => {
        // Sitting at z = 5..6, nowhere near the plane at z = 0.
        expect(sliceBoxesToPlane([box({ z: 5 })], OPTS)).toEqual([]);
    });

    it('does NOT double up on a box that merely touches the slice boundary', () => {
        // z = 0.5..1.5 touches the slice's max edge at 0.5 and must not count —
        // otherwise the chunks either side of a boundary both emit a collider at
        // the same X and the character walks into a doubled wall.
        const touching = sliceBoxesToPlane([box({ z: 0, d: 1 })], {
            ...OPTS, chunkWorldZ: 0.5,
        });
        expect(touching).toEqual([]);
    });

    it('honours the chunk world origin', () => {
        const [c] = sliceBoxesToPlane([box({ x: 1, y: 1 })], {
            ...OPTS, chunkWorldX: 100, chunkWorldY: 20,
        });
        expect(c!.x).toBeCloseTo(101.5);
        expect(c!.y).toBeCloseTo(21.5);
    });

    it('scales with the voxel size', () => {
        const [c] = sliceBoxesToPlane([box({ x: 2, y: 0, w: 2, h: 4 })], { ...OPTS, voxelSize: 0.25 });
        expect(c).toEqual({ x: 0.75, y: 0.5, hx: 0.25, hy: 0.5 });
    });

    it('a one-voxel slice takes only the plane, not the union over a slab', () => {
        // Two boxes at the same X, at different depths and different heights. A
        // deep slab would keep both and the character would walk on the taller
        // one regardless of where it actually is.
        const boxes = [
            box({ x: 0, y: 0, z: 0, h: 1 }),   // on the plane, 1 high
            box({ x: 0, y: 0, z: 3, h: 9 }),   // three voxels back, 9 high
        ];
        const onPlane = sliceBoxesToPlane(boxes, OPTS);
        expect(onPlane).toHaveLength(1);
        expect(onPlane[0]!.hy).toBeCloseTo(0.5); // the 1-high box, not the 9-high one

        const slab = sliceBoxesToPlane(boxes, { ...OPTS, slice: { z: 0, halfDepth: 4 } });
        expect(slab).toHaveLength(2); // the union a thick slab would collide against
    });
});

describe('sliceBoxesToPlane — boundaries and degenerate input', () => {
    it('returns nothing for an empty box list', () => {
        expect(sliceBoxesToPlane([], OPTS)).toEqual([]);
    });

    it('is half-open at BOTH ends — a box abutting either edge from outside is dropped', () => {
        // Slice [0, 1]. Abutting from below: z spans [-1, 0]. Abutting from
        // above: z spans [1, 2]. Neither is on the plane.
        const slice = voxelCentredSlice(1);
        expect(sliceBoxesToPlane([box({ z: 0 })], { ...OPTS, slice, chunkWorldZ: -1 })).toEqual([]);
        expect(sliceBoxesToPlane([box({ z: 0 })], { ...OPTS, slice, chunkWorldZ: 1 })).toEqual([]);
        // ...and the layer BETWEEN them, [0, 1], is the one that survives.
        expect(sliceBoxesToPlane([box({ z: 0 })], { ...OPTS, slice, chunkWorldZ: 0 })).toHaveLength(1);
    });

    it('keeps a box that straddles the whole slice, at its FULL height', () => {
        // A background structure ten voxels deep that happens to cross the plane
        // collides with its entire silhouette — the slice clips depth, never
        // height. Deliberate, but it means "far background" must be modelled by
        // keeping objects OFF the plane, not by making them thin.
        const straddling = box({ z: -5, d: 10, h: 12 });
        const [c] = sliceBoxesToPlane([straddling], { ...OPTS, slice: voxelCentredSlice(1) });
        expect(c).toEqual({ x: 0.5, y: 6, hx: 0.5, hy: 6 });
    });

    it('keeps a ZERO-DEPTH box that lands strictly inside the slice', () => {
        // d = 0 gives zMin === zMax; both half-open tests are false, so it is
        // kept. The mesher never emits one, so this is only reached by a
        // hand-built box list — pinned so the behaviour is at least known.
        const [c] = sliceBoxesToPlane([box({ z: 0, d: 0 })], {
            ...OPTS, slice: { z: 0.5, halfDepth: 0.5 }, chunkWorldZ: 0.25,
        });
        expect(c).toEqual({ x: 0.5, y: 0.5, hx: 0.5, hy: 0.5 });
    });

    it('does NOT validate extents — zero and negative w/h pass straight through', () => {
        // `RAPIER2D.ColliderDesc.cuboid()` is handed these unchecked by
        // buildChunkColliders2D. A zero half-extent is a degenerate shape; a
        // NEGATIVE one is not a shape at all. Nothing here rejects either.
        const [zero] = sliceBoxesToPlane([box({ w: 0, h: 0 })], OPTS);
        expect(zero).toEqual({ x: 0, y: 0, hx: 0, hy: 0 });

        const [negative] = sliceBoxesToPlane([box({ w: -2, h: -4 })], OPTS);
        expect(negative!.hx).toBe(-1);
        expect(negative!.hy).toBe(-2);
    });

    it('works in negative world coordinates — the strip is centred on 0, so X and Y are routinely negative', () => {
        const cuboids = sliceBoxesToPlane(
            [box({ x: 0, y: 0, w: 4, h: 2 }), box({ x: 4, y: 0, w: 4, h: 5 })],
            { ...OPTS, chunkWorldX: -64, chunkWorldY: -16 },
        );
        expect(cuboids).toEqual([
            { x: -62, y: -15, hx: 2, hy: 1 },
            { x: -58, y: -13.5, hx: 2, hy: 2.5 },
        ]);
        // And the surface probe agrees at a negative sample X.
        expect(surfaceHeightAt(cuboids, -63)).toBe(-14);
        expect(surfaceHeightAt(cuboids, -57)).toBe(-11);
        expect(surfaceHeightAt(cuboids, -70)).toBeNull();
    });
});

describe('sliceBoxesToPlane — against real greedy-meshed voxel data', () => {
    /**
     * `generateCollisionBoxes` is the exact function `VoxelWorld.updateChunkPhysics`
     * runs to fill `chunk.collisionBoxes`, which is what this module consumes.
     * The box convention it emits — a voxel at index i spanning
     * [origin + i*voxelSize, +voxelSize) — is the same one `buildTrimeshFromBoxes`
     * uses for the 3D trimesh, so agreeing with the voxel data here IS agreeing
     * with the 3D surface.
     */
    const HEIGHTS = [3, 3, 3, 5, 5, 1, 1, 1, 8, 8, 8, 8, 2, 2, 6, 6] as const;

    it('reproduces the source voxel heights at every X on the plane', () => {
        const chunk = chunkFromProfile([{ z: 0, heights: HEIGHTS, blockType: 1 }]);
        const boxes = generateCollisionBoxes(chunk);
        expect(boxes.length).toBeGreaterThan(0);

        const cuboids = sliceBoxesToPlane(boxes, { ...OPTS, slice: voxelCentredSlice(1) });

        for (let x = 0; x < CHUNK_SIZE; x++) {
            // Sample the middle of the voxel column so the half-open X span is unambiguous.
            expect(surfaceHeightAt(cuboids, x + 0.5)).toBe(HEIGHTS[x]);
        }
    });

    it('covers every solid voxel on the plane exactly once — no gaps, no overlaps', () => {
        const chunk = chunkFromProfile([{ z: 0, heights: HEIGHTS, blockType: 1 }]);
        const cuboids = sliceBoxesToPlane(generateCollisionBoxes(chunk), {
            ...OPTS, slice: voxelCentredSlice(1),
        });

        for (let x = 0; x < CHUNK_SIZE; x++) {
            for (let y = 0; y < 10; y++) {
                const solid = y < HEIGHTS[x]!;
                const hits = cuboids.filter(
                    (c) => covers(c, x + 0.5) && y + 0.5 >= c.y - c.hy && y + 0.5 < c.y + c.hy,
                );
                expect(hits).toHaveLength(solid ? 1 : 0);
            }
        }
    });

    it('keeps ONLY the plane layer when the world is deep — a real chunk carries 16 Z layers', () => {
        // A back wall two voxels behind the plane, far taller than the ground.
        // If the slice let it through, the character would collide with a wall
        // the side-on camera renders as background.
        const chunk = chunkFromProfile([
            { z: 0, heights: HEIGHTS, blockType: 1 },
            { z: 2, heights: new Array(CHUNK_SIZE).fill(14), blockType: 2 },
        ]);
        const cuboids = sliceBoxesToPlane(generateCollisionBoxes(chunk), {
            ...OPTS, slice: voxelCentredSlice(1),
        });
        for (let x = 0; x < CHUNK_SIZE; x++) {
            expect(surfaceHeightAt(cuboids, x + 0.5)).toBe(HEIGHTS[x]);
        }
    });

    it('greedy merging in Z does NOT lose the plane: a box spanning many Z layers still lands', () => {
        // Same blockType and same height across four Z layers → the mesher emits
        // ONE box with d = 4. It must still project, at full height.
        const heights = new Array(CHUNK_SIZE).fill(4);
        const chunk = chunkFromProfile([
            { z: 0, heights, blockType: 1 },
            { z: 1, heights, blockType: 1 },
            { z: 2, heights, blockType: 1 },
            { z: 3, heights, blockType: 1 },
        ]);
        const boxes = generateCollisionBoxes(chunk);
        expect(boxes).toHaveLength(1);
        expect(boxes[0]!.d).toBe(4);

        const cuboids = sliceBoxesToPlane(boxes, { ...OPTS, slice: voxelCentredSlice(1) });
        expect(cuboids).toEqual([{ x: 8, y: 2, hx: 8, hy: 2, blockType: 1 }]);
    });

    it('scales real voxel data by voxelSize, slice included', () => {
        const vs = 0.25;
        const chunk = chunkFromProfile([{ z: 0, heights: HEIGHTS, blockType: 1 }]);
        const cuboids = sliceBoxesToPlane(generateCollisionBoxes(chunk), {
            ...OPTS, voxelSize: vs, slice: voxelCentredSlice(vs),
        });
        for (let x = 0; x < CHUNK_SIZE; x++) {
            expect(surfaceHeightAt(cuboids, (x + 0.5) * vs)).toBeCloseTo(HEIGHTS[x]! * vs, 10);
        }
    });

    it('carries blockType through, so per-material friction survives the projection', () => {
        // updateChunkPhysics groups boxes by `atlas.getBlockGrip(box.blockType)`
        // and gives each friction group its own trimesh collider. The 2D lane
        // keeps the block type on every cuboid instead, and applies the same
        // lookup per collider (see the friction test below) — ice and rock stay
        // different surfaces.
        const chunk = chunkFromProfile([
            { z: 0, heights: [2, 2, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], blockType: 1 },
        ]);
        chunk.set(4, 0, 0, 7);
        chunk.set(5, 0, 0, 7);
        const boxes = generateCollisionBoxes(chunk);
        // The mesher DID keep them apart, so the information reaches this module...
        expect(new Set(boxes.map((b) => b.blockType))).toEqual(new Set([1, 7]));
        // ...and every cuboid remembers which material it came from.
        const cuboids = sliceBoxesToPlane(boxes, { ...OPTS, slice: voxelCentredSlice(1) });
        expect(cuboids.length).toBeGreaterThan(0);
        expect(new Set(cuboids.map((c) => c.blockType))).toEqual(new Set([1, 7]));
    });
});

describe('slice alignment — the unwritten caller contract', () => {
    /**
     * `{ z: 0, halfDepth: 0.5 }` is what the module's own doc calls the intended
     * default, what the existing tests use, and what the sibling object lane
     * ships as `VoxelPhysics2D.DEFAULT_Z_SLICE` ({ min: -0.5, max: 0.5 }). On a
     * voxel grid whose origin is a multiple of voxelSize — every voxel world —
     * world Z = 0 is a voxel BOUNDARY, not a voxel centre, so that slice
     * straddles two layers and keeps BOTH. The silhouette becomes the union of
     * the plane and the layer behind it: exactly the failure the file header
     * says the one-voxel slice exists to prevent.
     */
    it('a slice centred on world Z = 0 keeps TWO voxel layers, not one', () => {
        const boxes = [
            box({ z: 0, h: 1, blockType: 1 }),   // world Z [0, 1) — the layer in front
            box({ z: -1, h: 9, blockType: 2 }),  // world Z [-1, 0) — the layer behind
        ];
        const straddling = sliceBoxesToPlane(boxes, { ...OPTS, slice: { z: 0, halfDepth: 0.5 } });
        expect(straddling).toHaveLength(2);
        // ...and the character walks on the 9-high one, which the camera shows
        // a voxel behind the play plane.
        expect(surfaceHeightAt(straddling, 0.5)).toBe(9);

        // Centred on the voxel CENTRE instead, exactly one layer survives.
        const centred = sliceBoxesToPlane(boxes, { ...OPTS, slice: voxelCentredSlice(1) });
        expect(centred).toHaveLength(1);
        expect(surfaceHeightAt(centred, 0.5)).toBe(1);
    });

    it('halfDepth is in METRES and is not derived from voxelSize — a fixed 0.5 slices four layers at voxelSize 0.25', () => {
        const vs = 0.25;
        const boxes = [0, 1, 2, 3].map((z) => box({ z, h: z + 1, blockType: z + 1 }));
        // Slice [0, 0.5] at voxelSize 0.25 → layers [0,.25) [.25,.5) both fully
        // inside, and this is the CENTRED form; the boundary-centred default is
        // worse still.
        const withMetreHalfDepth = sliceBoxesToPlane(boxes, {
            ...OPTS, voxelSize: vs, slice: { z: 0.25, halfDepth: 0.25 },
        });
        expect(withMetreHalfDepth).toHaveLength(2);

        // Derived from voxelSize, it is one layer, as intended.
        const derived = sliceBoxesToPlane(boxes, {
            ...OPTS, voxelSize: vs, slice: voxelCentredSlice(vs),
        });
        expect(derived).toHaveLength(1);
        expect(derived[0]!.hy).toBeCloseTo(vs / 2, 10);
    });

    it('a chunk origin off the voxel grid the slice was chosen for keeps two layers', () => {
        // chunkWorldZ = bounds.minZ + cz*CHUNK_SIZE*voxelSize. A bounds.minZ that
        // is not a multiple of voxelSize shifts every layer by half a voxel, and
        // the plane-sized slice then overlaps two of them.
        const boxes = [box({ z: 0, blockType: 1 }), box({ z: 1, blockType: 2 })];
        const aligned = sliceBoxesToPlane(boxes, { ...OPTS, slice: voxelCentredSlice(1) });
        expect(aligned).toHaveLength(1);

        const offGrid = sliceBoxesToPlane(boxes, {
            ...OPTS, chunkWorldZ: -0.5, slice: voxelCentredSlice(1),
        });
        expect(offGrid).toHaveLength(2);
    });
});

describe('the chunk seam — does the half-open test actually stop the doubled wall?', () => {
    /**
     * The claim in the source: "Without this, the two chunks either side of a
     * boundary both contribute a collider at the same X and the character walks
     * into a doubled wall." Two REAL adjacent chunks, cz = -1 and cz = 0, whose
     * shared seam is world Z = 0 — the side-on lane's own gameplay plane.
     */
    const seamPair = (voxelSize: number) => {
        const heights = new Array(CHUNK_SIZE).fill(0);
        heights[3] = 4;
        // Behind the seam: chunk cz = -1, its LAST Z layer (world Z [-vs, 0)).
        const behind = chunkFromProfile([{ z: CHUNK_SIZE - 1, heights, blockType: 1 }]);
        // In front of the seam: chunk cz = 0, its FIRST Z layer (world Z [0, vs)).
        const front = chunkFromProfile([{ z: 0, heights, blockType: 1 }]);
        const optsFor = (chunkWorldZ: number): VoxelTerrain2DOptions => ({
            voxelSize,
            chunkWorldX: 0,
            chunkWorldY: 0,
            chunkWorldZ,
            slice: voxelCentredSlice(voxelSize),
        });
        return [
            ...sliceBoxesToPlane(generateCollisionBoxes(behind), optsFor(-CHUNK_SIZE * voxelSize)),
            ...sliceBoxesToPlane(generateCollisionBoxes(front), optsFor(0)),
        ];
    };

    it('at voxelSize 1 the seam yields exactly ONE collider, from the front chunk only', () => {
        const cuboids = seamPair(1);
        expect(cuboids).toHaveLength(1);
        expect(cuboids[0]).toEqual({ x: 3.5, y: 2, hx: 0.5, hy: 2, blockType: 1 });
    });

    it('a CLOSED overlap test would double it — which is what the half-open test buys', () => {
        // Reproduce the closed variant (`<` / `>`, as VoxelPhysics2D.attachVoxelColliders
        // still uses) over the same two chunks and show it keeps both.
        const closed = (boxes: readonly CollisionBox[], chunkWorldZ: number) => {
            const sliceMin = 0, sliceMax = 1;
            return boxes.filter((b) => {
                const zMin = chunkWorldZ + b.z;
                const zMax = zMin + b.d;
                return !(zMax < sliceMin || zMin > sliceMax);
            });
        };
        const heights = new Array(CHUNK_SIZE).fill(0);
        heights[3] = 4;
        const behind = generateCollisionBoxes(chunkFromProfile([{ z: CHUNK_SIZE - 1, heights, blockType: 1 }]));
        const front = generateCollisionBoxes(chunkFromProfile([{ z: 0, heights, blockType: 1 }]));
        expect(closed(behind, -CHUNK_SIZE)).toHaveLength(1); // wrongly kept
        expect(closed(front, 0)).toHaveLength(1);
        // Two colliders at the same X — the doubled wall.
    });

    it('BUT floating point defeats it whenever voxelSize is not a dyadic fraction', () => {
        // voxelSize 0.3: chunkWorldZ for cz = -1 is -4.800000000000001, so the
        // top layer's zMax lands at +2.2e-16 instead of exactly 0. `zMax <= sliceMin`
        // is false by one ulp, the layer survives, and the seam doubles anyway —
        // at world Z = 0, the one seam this lane cares about.
        //
        // 187 of the 400 voxel sizes 0.01..4.00 behave this way (0.3 and 0.15 are
        // among them; 0.1, 0.125, 0.25, 0.5, 1 are safe). A fix compares in
        // VOXEL-INDEX space instead of metres.
        const cuboids = seamPair(0.3);
        expect(cuboids).toHaveLength(2);
        expect(cuboids[0]!.x).toBeCloseTo(cuboids[1]!.x, 10); // same X — the doubled wall
        expect(cuboids[0]!.y).toBeCloseTo(cuboids[1]!.y, 10);
    });
});

describe('collider budget — one cuboid per greedy box', () => {
    /**
     * The source argues box-soup over a polyline because each box is convex, so
     * no internal edges catch the character. The cost is collider count. This
     * measures it on a level-shaped slice so a regression that stops merging
     * (or starts splitting) is visible as a number, not a frame-rate report.
     */
    it('a 512-voxel-wide stepped ground strip stays in the low hundreds of cuboids', () => {
        const CHUNKS = 32; // 512 voxels of X at voxelSize 1
        let total = 0;
        let runs = 0;
        let prev = -1;
        for (let cx = 0; cx < CHUNKS; cx++) {
            const heights: number[] = [];
            for (let i = 0; i < CHUNK_SIZE; i++) {
                const x = cx * CHUNK_SIZE + i;
                // A plateau every 8 voxels, stepping between 3 and 7 high.
                const h = 3 + (Math.floor(x / 8) % 5);
                heights.push(h);
                if (h !== prev) { runs++; prev = h; }
            }
            const chunk = chunkFromProfile([{ z: 0, heights, blockType: 1 }]);
            total += sliceBoxesToPlane(generateCollisionBoxes(chunk), {
                ...OPTS, chunkWorldX: cx * CHUNK_SIZE, slice: voxelCentredSlice(1),
            }).length;
        }
        // One cuboid per constant-height run, capped by the chunk grid: the
        // mesher cannot merge across a chunk boundary, so the floor is CHUNKS.
        // Measured, not bounded: 512 voxels of stepped ground cost 64 cuboids,
        // two per chunk. That is the real price of the box-soup choice.
        expect(total).toBe(64);
        expect(runs).toBe(64);
        // The honest comparison: a polyline would be ONE collider carrying ~130
        // vertices (2 per height change) instead of 64 cuboids. So box soup is
        // 64x the collider count for a level slice — cheap in absolute terms
        // (Rapier broad-phases thousands), and it buys convexity: no internal
        // edges, hence none of the seam-catching the 3D lane needs
        // TriMeshFlags.FIX_INTERNAL_EDGES for. The choice is defensible; this
        // test exists so a regression that stops greedy-merging (which would
        // send this to ~2000) shows up as a failure and not as a frame-rate report.
        expect(total).toBeLessThan(CHUNKS * CHUNK_SIZE / 4);
    });

    it('the count is driven by height CHANGES, not by width — a flat strip is one cuboid per chunk', () => {
        const flat = chunkFromProfile([{ z: 0, heights: new Array(CHUNK_SIZE).fill(4), blockType: 1 }]);
        expect(sliceBoxesToPlane(generateCollisionBoxes(flat), {
            ...OPTS, slice: voxelCentredSlice(1),
        })).toHaveLength(1);

        // Worst case: alternating heights defeat X merging above the shared base.
        // The mesher still merges the full-width slab the two heights have in
        // common (y 0..2, w 16) and then emits one 1-wide column per riser — so
        // a comb of 16 columns costs 1 + 8 = 9 cuboids, not 16.
        const comb = chunkFromProfile([{
            z: 0,
            heights: Array.from({ length: CHUNK_SIZE }, (_, i) => (i % 2 === 0 ? 2 : 5)),
            blockType: 1,
        }]);
        const combCuboids = sliceBoxesToPlane(generateCollisionBoxes(comb), {
            ...OPTS, slice: voxelCentredSlice(1),
        });
        expect(combCuboids).toHaveLength(9);
        expect(combCuboids.filter((c) => c.hx === 8)).toHaveLength(1);   // the shared base slab
        expect(combCuboids.filter((c) => c.hx === 0.5)).toHaveLength(8); // one riser per tall column
    });
});

describe('buildChunkColliders2D — against a real rapier2d world', () => {
    /**
     * Nothing in the tree calls this function yet: the only references to
     * `VoxelTerrain2D` are a doc comment in `VoxelWorld.ts` and this file. So
     * every contract it imposes on its future caller is currently unwritten and
     * unenforced. This block writes them down by driving the real solver.
     */
    beforeAll(async () => {
        await initRapier2D();
    });

    const groundBoxes = (): CollisionBox[] =>
        generateCollisionBoxes(chunkFromProfile([{
            z: 0,
            heights: new Array(CHUNK_SIZE).fill(4),
            blockType: 1,
        }]));

    const terrainOpts: VoxelTerrain2DOptions = {
        voxelSize: 1, chunkWorldX: 0, chunkWorldY: 0, chunkWorldZ: 0, slice: voxelCentredSlice(1),
    };

    it('emits one collider per sliced cuboid, with the 3D lane\'s TERRAIN groups', () => {
        const world = new PhysicsWorld2D({ x: 0, y: -30 });
        const body = world.createRigidBody(RAPIER2D.RigidBodyDesc.fixed());
        const boxes = groundBoxes();

        const colliders = buildChunkColliders2D(world, body, boxes, terrainOpts);

        expect(colliders).toHaveLength(sliceBoxesToPlane(boxes, terrainOpts).length);
        expect(body.numColliders()).toBe(colliders.length);
        // Same group/mask pair updateChunkPhysics gives the 3D trimesh, so a 2D
        // player (CollisionMask.PLAYER includes TERRAIN) collides with it.
        const expected = makeCollisionGroups(CollisionGroup.TERRAIN, CollisionMask.TERRAIN);
        for (const c of colliders) expect(c.collisionGroups()).toBe(expected);
    });

    it('keeps Rapier\'s default friction when no per-block lookup is supplied', () => {
        // VoxelPhysics2D.attachVoxelColliders hard-codes `.setFriction(0.7)`;
        // terrain deliberately does not — without a lookup every surface is
        // Rapier's default, and WITH one (next test) it is the block's grip.
        const world = new PhysicsWorld2D({ x: 0, y: -30 });
        const body = world.createRigidBody(RAPIER2D.RigidBodyDesc.fixed());
        const [c] = buildChunkColliders2D(world, body, groundBoxes(), terrainOpts);
        expect(c!.friction()).toBe(0.5); // Rapier's default, not 0.7
    });

    it('applies frictionForBlock per collider — ice and rock are different surfaces', () => {
        // The 3D lane's `atlas.getBlockGrip(box.blockType)` grouping, one
        // collider per box here. The lookup also sees `undefined` for a box with
        // no block type, so a partial palette still gets a sane answer.
        const world = new PhysicsWorld2D({ x: 0, y: -30 });
        const body = world.createRigidBody(RAPIER2D.RigidBodyDesc.fixed());
        const boxes = [
            box({ x: 0, y: 0, z: 0, w: 4, h: 1, d: 1, blockType: 1 }),
            box({ x: 4, y: 0, z: 0, w: 4, h: 1, d: 1, blockType: 7 }),
            box({ x: 8, y: 0, z: 0, w: 4, h: 1, d: 1 }),
        ];
        const grip = (bt: number | undefined): number => (bt === 7 ? 0.05 : bt === 1 ? 0.9 : 0.3);
        const colliders = buildChunkColliders2D(world, body, boxes, { ...terrainOpts, frictionForBlock: grip });
        // Rapier stores friction as f32, so compare loosely.
        const frictions = colliders.map((c) => c.friction());
        expect(frictions).toHaveLength(3);
        expect(frictions[0]).toBeCloseTo(0.9, 5);
        expect(frictions[1]).toBeCloseTo(0.05, 5);
        expect(frictions[2]).toBeCloseTo(0.3, 5);
    });

    it('places colliders at the right WORLD position whatever the body\'s translation', () => {
        // `ColliderDesc.setTranslation` is BODY-LOCAL while `sliceBoxesToPlane`
        // returns world space, so the builder subtracts the body's own
        // translation. Passing the world centre straight through would be
        // correct only for a body at the origin and silently offset for any
        // other — and a per-chunk body sitting at the chunk origin is the
        // natural thing for a caller to do. The sibling object lane
        // (VoxelPhysics2D.attachVoxelColliders) subtracts for the same reason.
        const world = new PhysicsWorld2D({ x: 0, y: -30 });
        const boxes = groundBoxes();
        const [expectedCuboid] = sliceBoxesToPlane(boxes, terrainOpts);

        for (const [bx, by] of [[0, 0], [64, 0], [-128, 12.5]] as const) {
            const body = world.createRigidBody(RAPIER2D.RigidBodyDesc.fixed().setTranslation(bx, by));
            const [collider] = buildChunkColliders2D(world, body, boxes, terrainOpts);
            // `collider.translation()` reports the ABSOLUTE position, so the
            // sliced world coordinate is what must come back — for every body.
            expect(collider!.translation().x).toBeCloseTo(expectedCuboid!.x, 5);
            expect(collider!.translation().y).toBeCloseTo(expectedCuboid!.y, 5);
        }
    });

    it('raises collision events on terrain contacts, as the 3D lane does', () => {
        const world = new PhysicsWorld2D({ x: 0, y: -30 });
        const body = world.createRigidBody(RAPIER2D.RigidBodyDesc.fixed());
        const [collider] = buildChunkColliders2D(world, body, groundBoxes(), terrainOpts);
        expect(collider!.activeEvents()).toBe(RAPIER2D.ActiveEvents.COLLISION_EVENTS);
    });

    it('ACCUMULATES on rebuild — the caller must retire the previous set itself', () => {
        // The streaming case rebuilds a chunk repeatedly. This function never
        // clears; it only returns the new set. A caller that overwrites its
        // stored handle without removing the old colliders leaks one full chunk
        // of geometry per rebuild — and the leaked colliders are still SOLID, so
        // the symptom is stale invisible walls, not just memory.
        const world = new PhysicsWorld2D({ x: 0, y: -30 });
        const body = world.createRigidBody(RAPIER2D.RigidBodyDesc.fixed());
        const boxes = groundBoxes();

        const first = buildChunkColliders2D(world, body, boxes, terrainOpts);
        const second = buildChunkColliders2D(world, body, boxes, terrainOpts);
        expect(body.numColliders()).toBe(first.length + second.length);
        // The second return does NOT include the first set, so it is not enough
        // on its own to describe what the chunk owns.
        expect(second.map((c) => c.handle)).not.toEqual(expect.arrayContaining(first.map((c) => c.handle)));

        // The documented retire path does work, once the caller keeps the handles.
        for (const c of first) world.removeColliderImmediate(c);
        expect(body.numColliders()).toBe(second.length);
    });

    it('a body dropped onto the sliced terrain rests on the voxel surface', () => {
        // The end-to-end claim the module exists for: the 2D solver stops a
        // falling body at the height the voxel data says the ground is. Four
        // voxels of ground at voxelSize 1 → surface at y = 4.
        const world = new PhysicsWorld2D({ x: 0, y: -30 });
        const terrain = world.createRigidBody(RAPIER2D.RigidBodyDesc.fixed());
        buildChunkColliders2D(world, terrain, groundBoxes(), terrainOpts);

        const RADIUS = 0.4;
        const faller = world.createRigidBody(RAPIER2D.RigidBodyDesc.dynamic().setTranslation(8, 12));
        world.createCollider(RAPIER2D.ColliderDesc.ball(RADIUS), faller);

        for (let i = 0; i < 400; i++) {
            world.step(1 / 60);
            world.flushCollisionCallbacks();
        }

        expect(faller.translation().y).toBeCloseTo(4 + RADIUS, 1);
        expect(faller.translation().x).toBeCloseTo(8, 1);
    });

    it('a stepped profile stops the body at the height of the column it lands on', () => {
        const world = new PhysicsWorld2D({ x: 0, y: -30 });
        const heights = new Array(CHUNK_SIZE).fill(2);
        for (let x = 8; x < CHUNK_SIZE; x++) heights[x] = 7;
        const terrain = world.createRigidBody(RAPIER2D.RigidBodyDesc.fixed());
        buildChunkColliders2D(
            world, terrain,
            generateCollisionBoxes(chunkFromProfile([{ z: 0, heights, blockType: 1 }])),
            terrainOpts,
        );

        const RADIUS = 0.4;
        const onPlateau = world.createRigidBody(RAPIER2D.RigidBodyDesc.dynamic().setTranslation(12, 14));
        world.createCollider(RAPIER2D.ColliderDesc.ball(RADIUS), onPlateau);

        for (let i = 0; i < 400; i++) {
            world.step(1 / 60);
            world.flushCollisionCallbacks();
        }
        expect(onPlateau.translation().y).toBeCloseTo(7 + RADIUS, 1);
    });
});
