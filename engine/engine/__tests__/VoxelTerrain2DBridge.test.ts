/**
 * @jest-environment jsdom
 *
 * VoxelTerrain2DBridge — a VoxelWorld with NO 3D physics, meshed for real, kept
 * in lockstep with a REAL rapier2d world through the `onChunkPhysicsRebuilt`
 * hook. This is the 2D lane's terrain path end to end: stamp → greedy boxes →
 * slice → cuboid colliders → query.
 *
 * Grid facts the assertions rely on (same mapping as VoxelWorld.setBlock):
 *  - bounds.minY = -20, voxelSize 1 → a block set at world y = 0 occupies
 *    [0, 1), so the walkable top is y = 1.0;
 *  - bounds.minZ = -1.5 (the sidescroller strip): rows set at z = -1, 0, 1 are
 *    layers 0, 1, 2, and the plane z = 0 snaps to layer 1 = world [-0.5, 0.5).
 */
import RAPIER2D from '@dimforge/rapier2d-compat';
import * as THREE from 'three';
import { VoxelWorld } from 'engine/VoxelWorld.js';
import { initRapier2D } from 'engine/physics/RapierPhysics2D.js';
import { PhysicsWorld2D } from 'engine/physics/PhysicsWorld2D.js';
import { VoxelTerrain2DBridge, gameplaySliceFor, chunkColumnKey } from 'engine/physics/VoxelTerrain2DBridge.js';
import { TopDownGround } from 'engine/physics/TopDownGround.js';
import { CollisionGroup } from 'engine/CollisionLayers.js';

jest.setTimeout(30_000);

beforeAll(async () => {
    await initRapier2D();
});

const STONE = 1;
const ICE = 2;
const MIN_X = -64;
const MIN_Z = -1.5;
const GROUND = CollisionGroup.TERRAIN | CollisionGroup.ENVIRONMENT;

interface Lane {
    world2D: PhysicsWorld2D;
    voxelWorld: VoxelWorld;
    bridge: VoxelTerrain2DBridge;
}

function makeLane(planeZ: number = 0): Lane {
    const world2D = new PhysicsWorld2D({ x: 0, y: -30 });
    const holder: { bridge: VoxelTerrain2DBridge | null } = { bridge: null };
    const voxelWorld = new VoxelWorld(null, new THREE.Scene(), {
        voxelSize: 1,
        materialType: 'atlas',
        onChunkPhysicsRebuilt: (key, boxes, cx, cy, cz) => holder.bridge?.onChunkRebuilt(key, boxes, cx, cy, cz),
    });
    voxelWorld.setBounds({ minX: MIN_X, maxX: 64, minY: -20, maxY: 100, minZ: MIN_Z, maxZ: MIN_Z + 3 });
    holder.bridge = new VoxelTerrain2DBridge({
        world2D,
        grid: voxelWorld,
        planeZ,
        frictionForBlock: (blockType) => (blockType === ICE ? 0.05 : 0.5),
    });
    return { world2D, voxelWorld, bridge: holder.bridge };
}

/** Solid columns from y = -3 up to `top`, over x ∈ [x0, x1), on the given depth rows. */
function stamp(lane: Lane, opts: { x0?: number; x1?: number; top?: number; rows?: number[]; block?: number } = {}): void {
    const { x0 = -8, x1 = 8, top = 0, rows = [-1, 0, 1], block = STONE } = opts;
    lane.voxelWorld.beginBatchUpdate();
    for (let x = x0; x < x1; x++) {
        for (const z of rows) {
            for (let y = -3; y <= top; y++) lane.voxelWorld.setBlock(x, y, z, block);
        }
    }
    lane.voxelWorld.endBatchUpdate();
}

function surfaceUnder(lane: Lane, x: number): number | null {
    lane.world2D.step(1 / 60);
    const hit = lane.world2D.raycast({ x, y: 50 }, { x: 0, y: -1 }, 200, GROUND);
    return hit.hasHit ? hit.hitPoint.y : null;
}

describe('gameplaySliceFor', () => {
    it('snaps the plane to the grid LAYER that contains it', () => {
        expect(gameplaySliceFor(-1.5, 1, 0)).toEqual({ z: 0, halfDepth: 0.5 });
        // Grid origin on a voxel boundary: z = 0 is the START of layer 2, so the
        // slice is [0, 1) — centred on 0.5 — not [-0.5, 0.5) straddling two rows.
        expect(gameplaySliceFor(-2, 1, 0)).toEqual({ z: 0.5, halfDepth: 0.5 });
        expect(gameplaySliceFor(-1.5, 0.5, 0)).toEqual({ z: 0.25, halfDepth: 0.25 });
        // Layers are [-1.5,-0.5), [-0.5,0.5), [0.5,1.5): 0.4 is still the middle row, 0.9 is the next one.
        expect(gameplaySliceFor(-1.5, 1, 0.4)).toEqual({ z: 0, halfDepth: 0.5 });
        expect(gameplaySliceFor(-1.5, 1, -0.4)).toEqual({ z: 0, halfDepth: 0.5 });
        expect(gameplaySliceFor(-1.5, 1, 0.9)).toEqual({ z: 1, halfDepth: 0.5 });
    });
});

describe('VoxelTerrain2DBridge', () => {
    it('builds 2D colliders for the plane row and a down-ray lands on the walkable top', () => {
        const lane = makeLane();
        stamp(lane, { top: 0 });
        expect(lane.bridge.colliderCount()).toBeGreaterThan(0);
        expect(lane.bridge.getSlice()).toEqual({ z: 0, halfDepth: 0.5 });
        expect(surfaceUnder(lane, 0.5)).toBeCloseTo(1.0);
        expect(surfaceUnder(lane, -7.5)).toBeCloseTo(1.0);
        // Off the strip: nothing.
        expect(surfaceUnder(lane, 20)).toBeNull();
    });

    it('ignores the rows in front of and behind the plane', () => {
        const front = makeLane();
        stamp(front, { rows: [-1] });
        expect(front.bridge.colliderCount()).toBe(0);
        const back = makeLane();
        stamp(back, { rows: [1] });
        expect(back.bridge.colliderCount()).toBe(0);
        const on = makeLane();
        stamp(on, { rows: [0] });
        expect(on.bridge.colliderCount()).toBeGreaterThan(0);
    });

    it('follows the plane to another row when planeZ says so', () => {
        const lane = makeLane(1);
        stamp(lane, { rows: [1], top: 2 });
        expect(lane.bridge.getSlice()).toEqual({ z: 1, halfDepth: 0.5 });
        expect(surfaceUnder(lane, 0.5)).toBeCloseTo(3.0);
    });

    it('rebuilding a chunk retires its previous colliders — no stale collision, no leak', () => {
        const lane = makeLane();
        stamp(lane, { top: 0 });
        const before = lane.bridge.colliderCount();
        expect(lane.world2D.getStats().colliderCount).toBe(before);

        // Raise one column by a block and re-mesh the dirty chunk.
        lane.voxelWorld.setBlock(0, 1, 0, STONE);
        lane.voxelWorld.updatePhysicsAndMeshing(false);

        expect(surfaceUnder(lane, 0.5)).toBeCloseTo(2.0);
        expect(surfaceUnder(lane, 1.5)).toBeCloseTo(1.0);
        // Every collider the world holds is one the bridge tracks: the old set is gone.
        expect(lane.world2D.getStats().colliderCount).toBe(lane.bridge.colliderCount());
    });

    it('applies per-block friction through the lookup', () => {
        const lane = makeLane();
        stamp(lane, { x0: -8, x1: 0, block: STONE });
        stamp(lane, { x0: 0, x1: 8, block: ICE });
        lane.world2D.step(1 / 60);
        const onStone = lane.world2D.raycast({ x: -4, y: 50 }, { x: 0, y: -1 }, 200, GROUND);
        const onIce = lane.world2D.raycast({ x: 4, y: 50 }, { x: 0, y: -1 }, 200, GROUND);
        expect(onStone.hitCollider!.friction()).toBeCloseTo(0.5);
        expect(onIce.hitCollider!.friction()).toBeCloseTo(0.05);
    });

    it('column culling disables and re-enables a chunk column, including chunks rebuilt while disabled', () => {
        const lane = makeLane();
        stamp(lane, { top: 0 });
        const cx = Math.floor((0.5 - MIN_X) / 16);
        const column = chunkColumnKey(cx, 0);

        lane.bridge.setColumnEnabled(column, false);
        expect(surfaceUnder(lane, 0.5)).toBeNull();

        // A rebuild while the column is culled must come back culled too.
        lane.voxelWorld.setBlock(0, 1, 0, STONE);
        lane.voxelWorld.updatePhysicsAndMeshing(false);
        expect(surfaceUnder(lane, 0.5)).toBeNull();

        lane.bridge.setColumnEnabled(column, true);
        expect(surfaceUnder(lane, 0.5)).toBeCloseTo(2.0);
    });

    it('an emptied chunk drops its colliders', () => {
        const lane = makeLane();
        stamp(lane, { x0: 0, x1: 2, top: 0 });
        expect(lane.bridge.colliderCount()).toBeGreaterThan(0);
        lane.voxelWorld.beginBatchUpdate();
        for (let x = 0; x < 2; x++) for (const z of [-1, 0, 1]) for (let y = -3; y <= 0; y++) lane.voxelWorld.setBlock(x, y, z, 0);
        lane.voxelWorld.endBatchUpdate();
        expect(lane.bridge.colliderCount()).toBe(0);
        expect(lane.world2D.getStats().colliderCount).toBe(0);
    });

    it('clear() and dispose() leave the 2D world empty', () => {
        const lane = makeLane();
        stamp(lane, { top: 0 });
        lane.voxelWorld.clear();
        expect(lane.bridge.colliderCount()).toBe(0);
        expect(lane.world2D.getStats().colliderCount).toBe(0);
        lane.bridge.dispose();
        expect(lane.world2D.getStats().rigidBodyCount).toBe(0);
        // Disposing twice, or after the world is gone, is harmless.
        lane.bridge.dispose();
        lane.world2D.dispose();
        lane.bridge.dispose();
    });

    it('the fixed body sits at the origin so world-space cuboids need no offset', () => {
        const lane = makeLane();
        stamp(lane, { x0: 30, x1: 32, top: 4 });
        lane.world2D.step(1 / 60);
        const hit = lane.world2D.raycast({ x: 31, y: 50 }, { x: 0, y: -1 }, 200, GROUND);
        expect(hit.hasHit).toBe(true);
        expect(hit.hitPoint.y).toBeCloseTo(5.0);
        expect(hit.hitRigidBody!.translation()).toEqual({ x: 0, y: 0 });
        expect(hit.hitCollider).toBeInstanceOf(RAPIER2D.Collider);
    });
});

describe('VoxelTerrain2DBridge on the ground plane (top-down)', () => {
    interface GroundLane extends Lane { ground: TopDownGround }

    function makeGroundLane(voxelSize: number = 1): GroundLane {
        const world2D = new PhysicsWorld2D({ x: 0, y: 0 });
        const ground = new TopDownGround(world2D);
        const holder: { bridge: VoxelTerrain2DBridge | null } = { bridge: null };
        const voxelWorld = new VoxelWorld(null, new THREE.Scene(), {
            voxelSize,
            materialType: 'atlas',
            onChunkPhysicsRebuilt: (key, boxes, cx, cy, cz) => holder.bridge?.onChunkRebuilt(key, boxes, cx, cy, cz),
        });
        voxelWorld.setBounds({ minX: -16, maxX: 16, minY: -20, maxY: 100, minZ: -16, maxZ: 16 });
        holder.bridge = new VoxelTerrain2DBridge({ world2D, grid: voxelWorld, planeZ: 0, frictionForBlock: () => 0.5, ground });
        return { world2D, voxelWorld, bridge: holder.bridge, ground };
    }

    /** A solid plate over x, z ∈ [−8, 8) from y = −3 up to `top` (blocks occupy [y, y + 1), so the walkable top is top + 1). */
    function plate(lane: GroundLane, top: number = 0): void {
        lane.voxelWorld.beginBatchUpdate();
        for (let x = -8; x < 8; x++) for (let z = -8; z < 8; z++) for (let y = -3; y <= top; y++) lane.voxelWorld.setBlock(x, y, z, STONE);
        lane.voxelWorld.endBatchUpdate();
    }

    function wallAhead(lane: GroundLane, fromX: number, y: number): { x: number; handle: number } | null {
        lane.world2D.step(1 / 60);
        const hit = lane.world2D.raycast({ x: fromX, y }, { x: 1, y: 0 }, 20, CollisionGroup.TERRAIN);
        return hit.hasHit ? { x: hit.hitPoint.x, handle: hit.hitCollider!.handle } : null;
    }

    it('feeds the heightmap instead of slicing: no terrain cuboids, heightAt is the walkable top', () => {
        const lane = makeGroundLane();
        plate(lane);
        expect(lane.ground.heightAt(0.5, 0.5)).toBeCloseTo(1.0);
        expect(lane.ground.heightAt(-7.5, 7.5)).toBeCloseTo(1.0);
        expect(lane.ground.heightAt(12, 12)).toBeNull();
        expect(lane.bridge.colliderCount()).toBe(0);
        expect(lane.bridge.getSlice()).toBeNull();
        expect(lane.world2D.getStats().colliderCount).toBe(0);
    });

    it('a rise of more than a step becomes a one-way wall, and mining it back removes the wall', () => {
        const lane = makeGroundLane();
        plate(lane);
        // A 4×4 pillar one block higher: walls on all four sides, with the stack's +X/+Z ownership across chunk seams.
        lane.voxelWorld.beginBatchUpdate();
        for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) lane.voxelWorld.setBlock(x, 1, z, STONE);
        lane.voxelWorld.endBatchUpdate();
        expect(lane.ground.heightAt(1.5, 1.5)).toBeCloseTo(2.0);
        expect(lane.ground.wallCount()).toBe(4);
        expect(lane.bridge.colliderCount()).toBe(4);
        // A probe along z = 1.5 (2D y) at "street height" meets the pillar's −X face at x = 0.
        const wall = wallAhead(lane, -5, 1.5);
        expect(wall).not.toBeNull();
        expect(wall!.x).toBeCloseTo(-0.05);
        expect(lane.ground.ledgeBlocks(wall!.handle, 1.0)).toBe(true);  // feet on the street (top 1.0)
        expect(lane.ground.ledgeBlocks(wall!.handle, 2.0)).toBe(false); // standing on the pillar
        // Mine the pillar away.
        lane.voxelWorld.beginBatchUpdate();
        for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) lane.voxelWorld.setBlock(x, 1, z, 0);
        lane.voxelWorld.endBatchUpdate();
        expect(lane.ground.wallCount()).toBe(0);
        expect(wallAhead(lane, -5, 1.5)).toBeNull();
        expect(lane.ground.heightAt(1.5, 1.5)).toBeCloseTo(1.0);
    });

    it('a one-block rise on a half-metre grid is a step, not a wall', () => {
        const lane = makeGroundLane(0.5);
        // setBlock takes world metres: fill every half-metre voxel of a plate topping out at y = 0.5.
        lane.voxelWorld.beginBatchUpdate();
        for (let x = -4; x < 4; x += 0.5) for (let z = -4; z < 4; z += 0.5) for (let y = -2; y <= 0; y += 0.5) lane.voxelWorld.setBlock(x, y, z, STONE);
        for (let x = 0; x < 2; x += 0.5) for (let z = 0; z < 2; z += 0.5) lane.voxelWorld.setBlock(x, 0.5, z, STONE);
        lane.voxelWorld.endBatchUpdate();
        expect(lane.ground.heightAt(-0.75, 0.75)).toBeCloseTo(0.5);
        expect(lane.ground.heightAt(0.75, 0.75)).toBeCloseTo(1.0);
        expect(lane.ground.wallCount()).toBe(0);
    });

    it('column culling toggles the walls; clear() and dispose() withdraw everything', () => {
        const lane = makeGroundLane();
        plate(lane);
        lane.voxelWorld.beginBatchUpdate();
        for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) lane.voxelWorld.setBlock(x, 1, z, STONE);
        lane.voxelWorld.endBatchUpdate();
        expect(wallAhead(lane, -5, 1.5)!.x).toBeCloseTo(-0.05);
        // The pillar's −X face is the +X edge of the cell at x = −1, owned by the stack west of
        // it: bounds start at −16, so that is chunk column (0, 1) for a probe at z = 1.5. Culling
        // it exposes the pillar's +X face, owned by column (1, 1); culling that too clears the ray.
        lane.bridge.setColumnEnabled(chunkColumnKey(0, 1), false);
        expect(wallAhead(lane, -5, 1.5)!.x).toBeCloseTo(3.95);
        lane.bridge.setColumnEnabled(chunkColumnKey(1, 1), false);
        expect(wallAhead(lane, -5, 1.5)).toBeNull();
        lane.bridge.setColumnEnabled(chunkColumnKey(0, 1), true);
        lane.bridge.setColumnEnabled(chunkColumnKey(1, 1), true);
        expect(wallAhead(lane, -5, 1.5)!.x).toBeCloseTo(-0.05);
        lane.voxelWorld.clear();
        expect(lane.ground.wallCount()).toBe(0);
        expect(lane.ground.heightAt(0.5, 0.5)).toBeNull();
        plate(lane);
        expect(lane.ground.heightAt(0.5, 0.5)).toBeCloseTo(1.0);
        lane.bridge.dispose();
        expect(lane.ground.heightAt(0.5, 0.5)).toBeNull();
        expect(lane.world2D.getStats().colliderCount).toBe(0);
    });
});
