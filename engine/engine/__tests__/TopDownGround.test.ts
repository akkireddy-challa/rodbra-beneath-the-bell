/**
 * TopDownGround — the virtual vertical axis of the ground-plane 2D lane.
 *
 * The pure pieces (vertical resolution, column tops, cliff-wall derivation)
 * are tested as functions; the class is tested against a REAL rapier2d world,
 * because what matters about a wall is that the 2D world collides with it and
 * that the one-way rule knows it by its handle.
 */
import { initRapier2D } from 'engine/physics/RapierPhysics2D.js';
import { PhysicsWorld2D } from 'engine/physics/PhysicsWorld2D.js';
import {
    TopDownGround,
    resolveVerticalMove,
    columnTopsFromBoxes,
    cliffWallsForStack,
    columnIndex,
    NO_GROUND,
    TOP_DOWN_STEP_MAX_M,
    TOP_DOWN_SNAP_DOWN_M,
    CLIFF_WALL_HALF_THICKNESS_M,
    GROUND_PLANE_MIN_CELL_M,
} from 'engine/physics/TopDownGround.js';
import { CHUNK_SIZE, type CollisionBox } from 'engine/VoxelGeometry.js';
import { CollisionGroup } from 'engine/CollisionLayers.js';

jest.setTimeout(30_000);

beforeAll(async () => {
    await initRapier2D();
});

function expectMove(move: { dy: number; grounded: boolean }, dy: number, grounded: boolean): void {
    expect(move.dy).toBeCloseTo(dy, 9);
    expect(move.grounded).toBe(grounded);
}

describe('resolveVerticalMove', () => {
    it('lands on the floor and stays grounded', () => {
        expectMove(resolveVerticalMove(2, -0.5, 1.5, false), -0.5, true);
        expectMove(resolveVerticalMove(2, -1, 1.5, false), -0.5, true); // clamped at the floor
        expectMove(resolveVerticalMove(1.5, 0, 1.5, true), 0, true);
    });

    it('follows a rising floor — a step the character walks up', () => {
        expectMove(resolveVerticalMove(1.5, 0, 1.9, true), 0.4, true);
    });

    it('snaps a GROUNDED character down a small drop, never an airborne one, and never past the snap distance', () => {
        expectMove(resolveVerticalMove(1.5, 0, 1.2, true), -0.3, true);
        expectMove(resolveVerticalMove(1.5, 0, 1.2, false), 0, false);
        expectMove(resolveVerticalMove(1.5, 0, 1.5 - TOP_DOWN_SNAP_DOWN_M - 0.01, true), 0, false);
    });

    it('a jump rises freely unless the floor ahead is higher still', () => {
        expectMove(resolveVerticalMove(1.5, 0.3, 1.5, true), 0.3, false);
        expectMove(resolveVerticalMove(1.5, 0.3, 2.5, true), 1.0, true);
    });

    it('off the terrain the desired motion applies and nothing is grounded', () => {
        expectMove(resolveVerticalMove(1.5, -0.2, null, true), -0.2, false);
    });
});

describe('columnTopsFromBoxes', () => {
    it('takes the highest box over each column, in world Y', () => {
        const boxes: CollisionBox[] = [
            { x: 0, y: 0, z: 0, w: 16, h: 2, d: 16 },
            { x: 3, y: 2, z: 4, w: 2, h: 1, d: 1 },
        ];
        const tops = columnTopsFromBoxes(boxes, 1, -20);
        expect(tops[columnIndex(0, 0)]).toBe(-18);
        expect(tops[columnIndex(3, 4)]).toBe(-17);
        expect(tops[columnIndex(4, 4)]).toBe(-17);
        expect(tops[columnIndex(5, 4)]).toBe(-18);
        expect(tops[columnIndex(3, 5)]).toBe(-18);
    });

    it('scales by the voxel size and leaves empty columns at NO_GROUND', () => {
        const tops = columnTopsFromBoxes([{ x: 1, y: 2, z: 0, w: 1, h: 3, d: 1 }], 0.5, 4);
        expect(tops[columnIndex(1, 0)]).toBe(4 + 2.5);
        expect(tops[columnIndex(0, 0)]).toBe(NO_GROUND);
        expect(tops).toHaveLength(CHUNK_SIZE * CHUNK_SIZE);
    });
});

describe('cliffWallsForStack', () => {
    const flat = (h: number): Float32Array => new Float32Array(CHUNK_SIZE * CHUNK_SIZE).fill(h);
    const edge = (h: number): Float32Array => new Float32Array(CHUNK_SIZE).fill(h);
    /** Raise the columns lx ∈ [x0, x1), lz ∈ [z0, z1) to `h`. */
    const raise = (m: Float32Array, x0: number, x1: number, z0: number, z1: number, h: number): Float32Array => {
        for (let lx = x0; lx < x1; lx++) for (let lz = z0; lz < z1; lz++) m[columnIndex(lx, lz)] = h;
        return m;
    };

    it('a flat stack with flat neighbours has no walls', () => {
        expect(cliffWallsForStack(flat(1), edge(1), edge(1), 0, 0, 1)).toEqual([]);
    });

    it('a rise above the step limit is a wall on the +X boundary, merged along Z', () => {
        const walls = cliffWallsForStack(raise(flat(0), 8, 16, 0, 16, 1), null, null, 0, 0, 1);
        expect(walls).toEqual([{ x: 8, z: 8, hx: CLIFF_WALL_HALF_THICKNESS_M, hz: 8, top: 1, low: 0 }]);
    });

    it('a rise within the step limit is a step, not a wall', () => {
        expect(cliffWallsForStack(raise(flat(0), 8, 16, 0, 16, TOP_DOWN_STEP_MAX_M), null, null, 0, 0, 1)).toEqual([]);
    });

    it('the +Z boundary merges along X, and the origin/voxel size place the wall in world space', () => {
        const walls = cliffWallsForStack(raise(flat(0), 0, 16, 4, 16, 2), null, null, 10, -6, 0.5);
        // Cells lz = 3 (height 0) face lz = 4 (height 2): the boundary is z = -6 + 4 * 0.5.
        expect(walls).toEqual([{ x: 10 + 4, z: -6 + 2, hx: 4, hz: CLIFF_WALL_HALF_THICKNESS_M, top: 2, low: 0 }]);
    });

    it('a boundary shared with the neighbouring stack uses that stack\'s edge column', () => {
        expect(cliffWallsForStack(flat(0), edge(2), edge(0), 0, 0, 1))
            .toEqual([{ x: 16, z: 8, hx: CLIFF_WALL_HALF_THICKNESS_M, hz: 8, top: 2, low: 0 }]);
    });

    it('a void on either side is not a cliff — the character walks off and falls, as in 3D', () => {
        expect(cliffWallsForStack(flat(0), edge(NO_GROUND), null, 0, 0, 1)).toEqual([]);
        expect(cliffWallsForStack(raise(flat(NO_GROUND), 0, 8, 0, 16, 3), null, null, 0, 0, 1)).toEqual([]);
    });

    it('runs break where the height pair changes', () => {
        const m = raise(raise(flat(0), 8, 16, 0, 8, 1), 8, 16, 8, 16, 2);
        const walls = cliffWallsForStack(m, null, null, 0, 0, 1).filter((w) => w.hx === CLIFF_WALL_HALF_THICKNESS_M);
        expect(walls).toEqual([
            { x: 8, z: 4, hx: CLIFF_WALL_HALF_THICKNESS_M, hz: 4, top: 1, low: 0 },
            { x: 8, z: 12, hx: CLIFF_WALL_HALF_THICKNESS_M, hz: 4, top: 2, low: 0 },
        ]);
    });
});

describe('TopDownGround (with a real 2D world)', () => {
    /** Grid origin (0, −20, 0), 1 m voxels: chunk cy = 1 spans world y ∈ [−4, 12), so a box y = 0, h = 4 tops out at y = 0. */
    function ground(): { world2D: PhysicsWorld2D; g: TopDownGround } {
        const world2D = new PhysicsWorld2D({ x: 0, y: 0 });
        const g = new TopDownGround(world2D);
        g.setGrid(0, -20, 0, 1);
        return { world2D, g };
    }
    const slab = (h: number, x = 0, w = 16): CollisionBox[] => [{ x, y: 0, z: 0, w, h, d: 16 }];

    it('heightAt reads the merged column tops across the chunk stack, null off the terrain', () => {
        const { g } = ground();
        g.setChunkTops('0,1,0', 0, 1, 0, slab(4));
        expect(g.heightAt(0.5, 0.5)).toBe(0);
        expect(g.heightAt(15.9, 15.9)).toBe(0);
        expect(g.heightAt(-0.5, 0.5)).toBeNull();
        expect(g.heightAt(16.5, 0.5)).toBeNull();
        // A chunk higher in the same stack wins where it has solid.
        g.setChunkTops('0,2,0', 0, 2, 0, [{ x: 2, y: 0, z: 2, w: 1, h: 1, d: 1 }]);
        expect(g.heightAt(2.5, 2.5)).toBe(13);
        expect(g.heightAt(3.5, 2.5)).toBe(0);
        g.setChunkTops('0,2,0', 0, 2, 0, null);
        expect(g.heightAt(2.5, 2.5)).toBe(0);
    });

    it('builds one-way cliff walls the 2D world collides with', () => {
        const { world2D, g } = ground();
        g.setChunkTops('0,1,0', 0, 1, 0, [...slab(4, 0, 8), ...slab(5, 8, 8)]);
        expect(g.wallCount()).toBe(1);
        world2D.step(1 / 60);
        const hit = world2D.raycast({ x: 2, y: 8 }, { x: 1, y: 0 }, 20, CollisionGroup.TERRAIN);
        expect(hit.hasHit).toBe(true);
        expect(hit.hitPoint.x).toBeCloseTo(8 - CLIFF_WALL_HALF_THICKNESS_M);
        const handle = hit.hitCollider!.handle;
        expect(g.wallTopOf(handle)).toBe(1);
        expect(g.ledgeBlocks(handle, 0)).toBe(true);        // feet on the street: blocked
        expect(g.ledgeBlocks(handle, 1 - TOP_DOWN_STEP_MAX_M)).toBe(false); // a step below the top: a ledge to mount
        expect(g.ledgeBlocks(handle, 1)).toBe(false);       // standing on top: walk off
        expect(g.ledgeBlocks(handle, 0.5, 0)).toBe(true);   // a ray below the top, no step allowance: hits
        expect(g.ledgeBlocks(handle, 1.5, 0)).toBe(false);  // a ray above it: passes over
        expect(g.ledgeBlocks(123456, 0)).toBe(true);        // not a wall at all: blocks like any collider
        expect(g.wallTopOf(123456)).toBeUndefined();
        for (let i = 0; i < 20; i++) {
            g.setStackEnabled('0,0', false); world2D.step(1 / 60);
            expect(g.ledgeBlocks(handle, -10)).toBe(false); // KCC calls without a group mask must also miss
            expect(world2D.raycast({ x: 2, y: 8 }, { x: 1, y: 0 }, 20, CollisionGroup.TERRAIN).hasHit).toBe(false);
            expect(g.heightAt(12, 8)).toBe(1); // culling never removes virtual ground
            g.setStackEnabled('0,0', true); world2D.step(1 / 60);
            expect(g.ledgeBlocks(handle, 0)).toBe(true);
            expect(world2D.raycast({ x: 2, y: 8 }, { x: 1, y: 0 }, 20, CollisionGroup.TERRAIN).hitCollider!.handle).toBe(handle);
        }
    });

    it('a rebuilt chunk replaces its walls; an emptied one drops them and the neighbours re-evaluate', () => {
        const { world2D, g } = ground();
        g.setChunkTops('0,1,0', 0, 1, 0, slab(4));
        g.setChunkTops('1,1,0', 1, 1, 0, slab(6)); // the stack to the +X: 2 m higher → a wall on x = 16
        expect(g.wallCount()).toBe(1);
        expect(world2D.getStats().colliderCount).toBe(1);
        g.setChunkTops('1,1,0', 1, 1, 0, slab(4)); // levelled
        expect(g.wallCount()).toBe(0);
        expect(world2D.getStats().colliderCount).toBe(0);
        g.setChunkTops('1,1,0', 1, 1, 0, slab(6));
        expect(g.wallCount()).toBe(1);
        g.setChunkTops('1,1,0', 1, 1, 0, null); // gone: a void, not a cliff
        expect(g.wallCount()).toBe(0);
        expect(g.heightAt(16.5, 0.5)).toBeNull();
    });

    it('a stack can be culled — its walls switch off and back on — and dispose leaves the world empty', () => {
        const { world2D, g } = ground();
        g.setChunkTops('0,1,0', 0, 1, 0, [...slab(4, 0, 8), ...slab(5, 8, 8)]);
        world2D.step(1 / 60);
        const probe = (): boolean => { world2D.step(1 / 60); return world2D.raycast({ x: 2, y: 8 }, { x: 1, y: 0 }, 20, CollisionGroup.TERRAIN).hasHit; };
        expect(probe()).toBe(true);
        g.setStackEnabled('0,0', false);
        expect(probe()).toBe(false);
        g.setStackEnabled('0,0', true);
        expect(probe()).toBe(true);
        g.dispose();
        expect(g.wallCount()).toBe(0);
        expect(g.heightAt(0.5, 0.5)).toBeNull();
        expect(world2D.getStats().colliderCount).toBe(0);
        expect(world2D.getStats().rigidBodyCount).toBe(0);
    });

    it('a changed grid drops everything (a regenerated world)', () => {
        const { g } = ground();
        g.setChunkTops('0,1,0', 0, 1, 0, slab(4));
        g.setGrid(0, -20, 0, 1); // same grid: keeps
        expect(g.heightAt(0.5, 0.5)).toBe(0);
        g.setGrid(-8, -20, -8, 1);
        expect(g.heightAt(0.5, 0.5)).toBeNull();
    });
});

describe('TopDownGround.setSourceRects (baked levels, terrain objects)', () => {
    function ground(): { world2D: PhysicsWorld2D; g: TopDownGround } {
        const world2D = new PhysicsWorld2D({ x: 0, y: 0 });
        const g = new TopDownGround(world2D);
        g.setGrid(0, -20, 0, 0.5);
        return { world2D, g };
    }

    it('rasterises world rects onto the grid across stack boundaries, half-open', () => {
        const { g } = ground();
        g.setSourceRects('level', [
            { minX: 0, maxX: 12, minZ: 0, maxZ: 12, topY: 0 },   // a plate over two stacks each way (a stack is 8 m)
            { minX: 2, maxX: 4, minZ: 2, maxZ: 4, topY: 0.5 },   // a kerb
            { minX: 4, maxX: 4.5, minZ: 0, maxZ: 12, topY: 0 },  // touching the kerb's boundary: does not raise x ∈ [4, 4.5)
        ]);
        expect(g.heightAt(0.25, 0.25)).toBe(0);
        expect(g.heightAt(11.75, 11.75)).toBe(0);
        expect(g.heightAt(12.25, 0.25)).toBeNull();
        expect(g.heightAt(3, 3)).toBe(0.5);
        expect(g.heightAt(3.99, 3.99)).toBe(0.5);
        expect(g.heightAt(4.01, 3)).toBe(0);
        expect(g.heightAt(1.99, 3)).toBe(0);
        expect(g.wallCount()).toBe(0); // 0.5 is a step
    });

    it('a source replaces itself, can shrink, and can be removed; walls follow', () => {
        const { g } = ground();
        g.setSourceRects('level', [{ minX: 0, maxX: 8, minZ: 0, maxZ: 8, topY: 0 }, { minX: 8, maxX: 16, minZ: 0, maxZ: 8, topY: 2 }]);
        expect(g.wallCount()).toBe(1);
        expect(g.heightAt(10, 4)).toBe(2);
        g.setSourceRects('level', [{ minX: 0, maxX: 8, minZ: 0, maxZ: 8, topY: 0 }]);
        expect(g.wallCount()).toBe(0);
        expect(g.heightAt(10, 4)).toBeNull();
        g.setSourceRects('prop', [{ minX: 2, maxX: 4, minZ: 2, maxZ: 4, topY: 3 }]);
        expect(g.heightAt(3, 3)).toBe(3);
        expect(g.wallCount()).toBeGreaterThan(0);
        g.removeSource('prop');
        expect(g.heightAt(3, 3)).toBe(0);
        expect(g.wallCount()).toBe(0);
        g.removeSource('level');
        expect(g.heightAt(1, 1)).toBeNull();
    });
});

describe('TopDownGround.setSourceTriangles (baked trimesh surfaces)', () => {
    function ground(cell = 0.5): { world2D: PhysicsWorld2D; g: TopDownGround } {
        const world2D = new PhysicsWorld2D({ x: 0, y: 0 });
        const g = new TopDownGround(world2D);
        g.setGrid(0, 0, 0, cell);
        return { world2D, g };
    }
    /** One quad (two triangles) over x,z ∈ [x0,x1]×[z0,z1] at a constant height. */
    function flatQuad(x0: number, x1: number, z0: number, z1: number, y: number): { verts: Float32Array; indices: Uint32Array } {
        return {
            verts: new Float32Array([x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1]),
            indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
        };
    }

    it('rasterises a flat surface into the columns it covers, and nothing outside it', () => {
        const { g } = ground();
        const quad = flatQuad(0, 8, 0, 8, 3);
        g.setSourceTriangles('level', quad.verts, quad.indices);
        expect(g.heightAt(4, 4)).toBeCloseTo(3);
        expect(g.heightAt(0.3, 7.7)).toBeCloseTo(3);
        expect(g.heightAt(9, 4)).toBeNull();
        expect(g.heightAt(4, -1)).toBeNull();
    });

    it('samples a SLOPED triangle at each column, not one height for the whole thing', () => {
        const { g } = ground();
        // A ramp climbing +X: y = x/2 over x ∈ [0, 8].
        g.setSourceTriangles('ramp', new Float32Array([
            0, 0, 0, 8, 4, 0, 8, 4, 8,
            0, 0, 0, 8, 4, 8, 0, 0, 8,
        ]), new Uint32Array([0, 1, 2, 3, 4, 5]));
        expect(g.heightAt(1.25, 4)).toBeCloseTo(1.25 / 2, 2);
        expect(g.heightAt(6.25, 4)).toBeCloseTo(6.25 / 2, 2);
    });

    it('keeps the HIGHEST surface where two overlap — a floor under a balcony reports the balcony', () => {
        const { g } = ground();
        const floor = flatQuad(0, 8, 0, 8, 0);
        g.setSourceTriangles('floor', floor.verts, floor.indices);
        const balcony = flatQuad(2, 6, 2, 6, 5);
        g.setSourceTriangles('balcony', balcony.verts, balcony.indices);
        expect(g.heightAt(4, 4)).toBeCloseTo(5);
        expect(g.heightAt(1, 1)).toBeCloseTo(0);
        // Each source replaces itself; removing the balcony exposes the floor again.
        g.removeSource('balcony');
        expect(g.heightAt(4, 4)).toBeCloseTo(0);
    });

    it('skips vertical triangles — a wall is not a floor, and its cliff comes from the height difference', () => {
        const { g } = ground();
        // A vertical wall standing on the x = 4 line.
        g.setSourceTriangles('wall', new Float32Array([
            4, 0, 0, 4, 6, 0, 4, 6, 8,
        ]), new Uint32Array([0, 1, 2]));
        expect(g.heightAt(4, 4)).toBeNull();
    });

    it('feeds a whole level in one pass: walls appear between its height steps', () => {
        const { world2D, g } = ground();
        const low = flatQuad(0, 8, 0, 16, 0);
        const high = flatQuad(8, 16, 0, 16, 4);
        const verts = new Float32Array([...low.verts, ...high.verts]);
        const indices = new Uint32Array([...low.indices, ...[...high.indices].map((i) => i + 4)]);
        g.setSourceTriangles('level', verts, indices);
        expect(g.heightAt(4, 8)).toBeCloseTo(0);
        expect(g.heightAt(12, 8)).toBeCloseTo(4);
        expect(g.wallCount()).toBeGreaterThan(0);
        world2D.step(1 / 60);
        const hit = world2D.raycast({ x: 2, y: 8 }, { x: 1, y: 0 }, 20, CollisionGroup.TERRAIN);
        expect(hit.hasHit).toBe(true);
        expect(hit.hitPoint.x).toBeCloseTo(8 - CLIFF_WALL_HALF_THICKNESS_M, 5);
    });

    it("the gameplay cell floor is coarser than a baked level's voxels", () => {
        // Feeds clamp to it: the map answers a character, not a bake.
        expect(GROUND_PLANE_MIN_CELL_M).toBeGreaterThan(0.125);
        expect(GROUND_PLANE_MIN_CELL_M).toBeLessThan(TOP_DOWN_STEP_MAX_M);
    });
});
