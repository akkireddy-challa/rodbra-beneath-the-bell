import RAPIER from '@dimforge/rapier3d-compat';
import {
    computeColliderRadius, createBallColliderDesc, sphereColliderDesc, type ColliderShapeView,
} from 'engine/physics/BallPhysics.js';

/** Build a cuboid collider view at a world position with the given half-extents. */
function cuboid(pos: [number, number, number], he: [number, number, number]): ColliderShapeView {
    return {
        translation: () => ({ x: pos[0], y: pos[1], z: pos[2] }),
        shape: { halfExtents: { x: he[0], y: he[1], z: he[2] } },
    };
}

describe('computeColliderRadius', () => {
    it('derives the true world radius from cuboid voxel colliders', () => {
        // Mirrors the real soccer-ball case: a 0.4 m ball (radius 0.2 m) built
        // from many small cuboids, centered on the body origin. The malformed
        // VXL bounds path returned 4.0 m here; collider geometry gives 0.2 m.
        const center = { x: 0, y: 0, z: 0 };
        const colliders: ColliderShapeView[] = [
            cuboid([0, 0, 0], [0.05, 0.2, 0.1]),       // tallest piece → 0.2 on Y
            cuboid([0.15, 0, 0], [0.05, 0.15, 0.025]), // farthest on X → 0.15 + 0.05 = 0.2
            cuboid([0, 0, 0.15], [0.025, 0.1, 0.05]),  // farthest on Z → 0.15 + 0.05 = 0.2
            cuboid([-0.1, 0, -0.1], [0.05, 0.05, 0.05]),
        ];
        expect(computeColliderRadius(colliders, center)).toBeCloseTo(0.2, 5);
    });

    it('handles a single ball collider via its radius', () => {
        const ball: ColliderShapeView = {
            translation: () => ({ x: 0, y: 0, z: 0 }),
            shape: { radius: 0.2 },
        };
        expect(computeColliderRadius([ball], { x: 0, y: 0, z: 0 })).toBeCloseTo(0.2, 5);
    });

    it('measures extent relative to the body center, not the origin', () => {
        // Body sits at (10, 1, -3); colliders are at world positions around it.
        const center = { x: 10, y: 1, z: -3 };
        const colliders: ColliderShapeView[] = [
            cuboid([10, 1, -3], [0.05, 0.2, 0.1]),
            cuboid([10.15, 1, -3], [0.05, 0.05, 0.05]),
        ];
        expect(computeColliderRadius(colliders, center)).toBeCloseTo(0.2, 5);
    });

    it('falls back when there are no measurable colliders', () => {
        expect(computeColliderRadius([], { x: 0, y: 0, z: 0 }, 0.4)).toBe(0.4);
    });
});

describe('sphereColliderDesc — the shape every moving sphere must use', () => {
    beforeAll(async () => { await RAPIER.init(); });

    it('is a zero-length capsule, not a Ball shape', () => {
        const desc = sphereColliderDesc(0.2);
        expect(desc.shape.type).toBe(RAPIER.ShapeType.Capsule);
        const capsule = desc.shape as RAPIER.Capsule;
        expect(capsule.halfHeight).toBe(0);
        expect(capsule.radius).toBe(0.2);
    });

    it('carries a true sphere mass', () => {
        const w = new RAPIER.World({ x: 0, y: 0, z: 0 });
        const body = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic());
        w.createCollider(sphereColliderDesc(0.2).setDensity(1), body);
        expect(body.mass()).toBeCloseTo((4 / 3) * Math.PI * 0.2 ** 3, 5);
        w.free();
    });

    it('rolls into a voxels wall at speed without killing the WASM (dimforge/rapier#993)', () => {
        // The exact scenario a Ball shape panics on: a rolling sphere meets the
        // side of a Voxels collider at 6 m/s. A regression here throws
        // `RuntimeError: unreachable` out of world.step() — and poisons every
        // later Rapier call in this worker, so a failure will be loud.
        const S = 0.5;
        const cells = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): Int32Array => {
            const out: number[] = [];
            for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) out.push(x, y, z);
            return new Int32Array(out);
        };
        const w = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
        w.timestep = 1 / 60;
        const fixed = w.createRigidBody(RAPIER.RigidBodyDesc.fixed());
        w.createCollider(RAPIER.ColliderDesc.voxels(cells(0, 32, 0, 1, 0, 16), { x: S, y: S, z: S }).setFriction(0.5), fixed);
        w.createCollider(RAPIER.ColliderDesc.voxels(cells(0, 8, 1, 5, 0, 16), { x: S, y: S, z: S }).setTranslation(16 * S, 0, 0).setFriction(0.5), fixed);
        const body = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(2, S + 0.2, 4).setLinvel(6, 0, 0));
        w.createCollider(sphereColliderDesc(0.2).setFriction(0.5).setDensity(100), body);
        for (let i = 0; i < 150; i++) w.step();
        const x = body.translation().x;
        expect(x).toBeGreaterThan(7);   // it reached the wall...
        expect(x).toBeLessThan(8);      // ...and stopped at it rather than passing through
        w.free();
    });
});

describe('createBallColliderDesc', () => {
    beforeAll(async () => { await RAPIER.init(); });

    it('sizes the sphere to half the largest bounds extent, centred on the bounds', () => {
        const desc = createBallColliderDesc(
            { minX: -1, minY: 0, minZ: -0.5, maxX: 1, maxY: 1, maxZ: 0.5 },
            { x: 0, y: -0.5, z: 0 },
            0xffffffff,
        );
        expect(desc.shape.type).toBe(RAPIER.ShapeType.Capsule);
        expect((desc.shape as RAPIER.Capsule).radius).toBe(1);
        expect(desc.translation).toEqual({ x: 0, y: 1, z: 0 });
    });
});
