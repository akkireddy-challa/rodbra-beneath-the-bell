/**
 * EnvObject2D — placed voxel objects projected onto the gameplay plane.
 * Pure arithmetic: no Rapier, no THREE.
 */
import { envBoxesToGroundCuboids, envBoxesToPlaneCuboids, envSliceFor, ENV_SLAB_HALF_DEPTH_M, type EnvTransform } from 'engine/physics/EnvObject2D.js';
import type { PhysicsBox } from 'engine/VoxelOctreeRenderer.js';

const IDENTITY: EnvTransform = {
    translation: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
};

const box = (cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): PhysicsBox => ({ cx, cy, cz, hx, hy, hz });

/** Yaw about +Y as a quaternion. */
const yaw = (radians: number): EnvTransform['rotation'] => ({ x: 0, y: Math.sin(radians / 2), z: 0, w: Math.cos(radians / 2) });

const SLICE = envSliceFor(0);

describe('envBoxesToPlaneCuboids', () => {
    it('the slab is one metre deep, centred on the plane', () => {
        expect(ENV_SLAB_HALF_DEPTH_M).toBe(0.5);
        expect(envSliceFor(2)).toEqual({ z: 2, halfDepth: 0.5 });
    });

    it('translates a local box to world and drops Z', () => {
        const out = envBoxesToPlaneCuboids([box(1, 2, 0, 0.5, 1, 0.5)], { ...IDENTITY, translation: { x: 10, y: 3, z: 0 } }, SLICE);
        expect(out).toEqual([{ x: 11, y: 5, hx: 0.5, hy: 1 }]);
    });

    it('applies the instance scale before placing', () => {
        const out = envBoxesToPlaneCuboids([box(1, 1, 0, 0.5, 0.5, 0.5)], { ...IDENTITY, scale: { x: 2, y: 3, z: 1 } }, SLICE);
        expect(out).toEqual([{ x: 2, y: 3, hx: 1, hy: 1.5 }]);
    });

    it('keeps only the boxes whose Z extent overlaps the slab (half-open)', () => {
        const boxes = [
            box(0, 0, 0, 1, 1, 0.5),      // on the plane
            box(0, 0, -3, 1, 1, 0.5),     // backdrop décor: [-3.5, -2.5] — out
            box(0, 0, 1, 1, 1, 0.5),      // [0.5, 1.5] touches the slab edge at 0.5 — out (half-open)
            box(0, 0, 0.9, 1, 1, 0.5),    // [0.4, 1.4] overlaps — in
        ];
        const out = envBoxesToPlaneCuboids(boxes, IDENTITY, SLICE);
        expect(out).toHaveLength(2);
    });

    it('a 90° yaw swaps the X and Z extents exactly', () => {
        // A 4 m long, 1 m deep plank along X turned by 90° presents its 1 m face.
        const out = envBoxesToPlaneCuboids([box(0, 1, 0, 2, 0.5, 0.5)], { ...IDENTITY, rotation: yaw(Math.PI / 2) }, SLICE);
        expect(out).toHaveLength(1);
        expect(out[0]!.hx).toBeCloseTo(0.5);
        expect(out[0]!.hy).toBeCloseTo(0.5);
        expect(out[0]!.x).toBeCloseTo(0);
        expect(out[0]!.y).toBeCloseTo(1);
    });

    it('a yaw moves an off-centre box around the origin, so it can leave the slab', () => {
        // Box centred 3 m along +X; a 90° yaw puts it 3 m along Z, off the plane.
        const boxes = [box(3, 0, 0, 0.5, 0.5, 0.5)];
        expect(envBoxesToPlaneCuboids(boxes, IDENTITY, SLICE)).toHaveLength(1);
        expect(envBoxesToPlaneCuboids(boxes, { ...IDENTITY, rotation: yaw(Math.PI / 2) }, SLICE)).toHaveLength(0);
    });

    it('an arbitrary rotation is represented by a conservative world AABB — never smaller', () => {
        const out = envBoxesToPlaneCuboids([box(0, 0, 0, 1, 1, 0.5)], { ...IDENTITY, rotation: yaw(Math.PI / 4) }, SLICE);
        expect(out).toHaveLength(1);
        // A unit half-width box turned 45° about Y spans ±(1+0.5)/√2 ≈ ±1.06 in X.
        expect(out[0]!.hx).toBeCloseTo(1.5 / Math.SQRT2, 5);
        expect(out[0]!.hx).toBeGreaterThan(1);
        expect(out[0]!.hy).toBeCloseTo(1);
    });

    it('a roll about Z rotates within the plane and keeps the box on it', () => {
        const roll = (r: number): EnvTransform['rotation'] => ({ x: 0, y: 0, z: Math.sin(r / 2), w: Math.cos(r / 2) });
        const out = envBoxesToPlaneCuboids([box(0, 0, 0, 2, 0.5, 0.5)], { ...IDENTITY, rotation: roll(Math.PI / 2) }, SLICE);
        expect(out).toHaveLength(1);
        expect(out[0]!.hx).toBeCloseTo(0.5);
        expect(out[0]!.hy).toBeCloseTo(2);
    });

    it('degenerate boxes are dropped', () => {
        expect(envBoxesToPlaneCuboids([box(0, 0, 0, 0, 1, 0.5)], IDENTITY, SLICE)).toEqual([]);
    });
});

describe('envBoxesToGroundCuboids (the top-down lane)', () => {
    const near = (actual: number, expected: number): void => expect(actual).toBeCloseTo(expected, 9);

    it('keeps the boxes in the obstacle band above the ground, as X/Z cuboids that remember their top', () => {
        const out = envBoxesToGroundCuboids([box(1, 1, 2, 0.5, 1, 0.5)], { ...IDENTITY, translation: { x: 10, y: 0, z: 5 } }, 0);
        expect(out).toEqual([{ x: 11, y: 7, hx: 0.5, hy: 0.5, topY: 2 }]);
    });

    it('a floor tile or a kerb below the step limit is walked over', () => {
        expect(envBoxesToGroundCuboids([box(0, 0.1, 0, 1, 0.1, 1)], IDENTITY, 0)).toEqual([]);
        expect(envBoxesToGroundCuboids([box(0, 0.3, 0, 1, 0.3, 1)], IDENTITY, 0)).toEqual([]);
        // ...and a box that just crosses the limit blocks.
        expect(envBoxesToGroundCuboids([box(0, 0.4, 0, 1, 0.3, 1)], IDENTITY, 0)).toHaveLength(1);
    });

    it('geometry above head clearance is walked under', () => {
        expect(envBoxesToGroundCuboids([box(0, 2.5, 0, 1, 0.4, 1)], IDENTITY, 0)).toEqual([]);
        expect(envBoxesToGroundCuboids([box(0, 2.0, 0, 1, 0.5, 1)], IDENTITY, 0)).toHaveLength(1);
    });

    it('the band follows the terrain height under the object; the object base stands in when it is unknown', () => {
        const raised = { ...IDENTITY, translation: { x: 0, y: 5, z: 0 } };
        // A 2 m prop standing on a 5 m plateau: an obstacle relative to that plateau…
        expect(envBoxesToGroundCuboids([box(0, 1, 0, 0.5, 1, 0.5)], raised, 5)).toHaveLength(1);
        expect(envBoxesToGroundCuboids([box(0, 1, 0, 0.5, 1, 0.5)], raised, null)).toHaveLength(1);
        // …and a floating platform when the street below is at 0.
        expect(envBoxesToGroundCuboids([box(0, 1, 0, 0.5, 1, 0.5)], raised, 0)).toEqual([]);
        expect(envBoxesToGroundCuboids([], IDENTITY, null)).toEqual([]);
    });

    it('yaw rotates the footprint about the object origin', () => {
        const [c] = envBoxesToGroundCuboids([box(2, 1, 0, 1, 1, 0.5)], { ...IDENTITY, rotation: yaw(Math.PI / 2) }, 0);
        expect(c).toBeDefined();
        near(c!.x, 0);
        near(c!.y, -2);
        near(c!.hx, 0.5);
        near(c!.hy, 1);
        near(c!.topY, 2);
    });
});
