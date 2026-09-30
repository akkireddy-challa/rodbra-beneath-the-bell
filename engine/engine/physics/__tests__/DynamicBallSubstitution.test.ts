/**
 * PhysicsWorld.createCollider is the one funnel every 3D collider passes
 * through, and it must never let a Ball shape onto a moving body: in the Rapier
 * we ship, a ball hitting a Voxels collider's wall, edge or seam at speed panics
 * the WASM (dimforge/rapier#993). The engine's own sphere sites already use
 * sphereColliderDesc; this pins the guarantee for game code that calls
 * RAPIER.ColliderDesc.ball directly.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { initRapier } from 'engine/physics/RapierPhysics.js';
import { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';

beforeAll(async () => { await initRapier(); });

function capsuleOf(collider: RAPIER.Collider): { halfHeight: number; radius: number } {
    expect(collider.shape.type).toBe(RAPIER.ShapeType.Capsule);
    return collider.shape as RAPIER.Capsule;
}

describe('PhysicsWorld.createCollider and Ball shapes', () => {
    it('turns a Ball on a dynamic body into a zero-length capsule of the same radius', () => {
        const pw = new PhysicsWorld();
        const body = pw.createRigidBody(RAPIER.RigidBodyDesc.dynamic());
        const collider = pw.createCollider(RAPIER.ColliderDesc.ball(0.2).setDensity(1), body);
        const capsule = capsuleOf(collider);
        expect(capsule.halfHeight).toBe(0);
        expect(capsule.radius).toBe(0.2);
        expect(body.mass()).toBeCloseTo((4 / 3) * Math.PI * 0.2 ** 3, 5);
        pw.dispose();
    });

    it('does the same for a kinematic body', () => {
        const pw = new PhysicsWorld();
        const body = pw.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
        const capsule = capsuleOf(pw.createCollider(RAPIER.ColliderDesc.ball(0.5), body));
        expect(capsule.radius).toBe(0.5);
        pw.dispose();
    });

    it('leaves a Ball on a fixed body alone', () => {
        const pw = new PhysicsWorld();
        const body = pw.createRigidBody(RAPIER.RigidBodyDesc.fixed());
        const collider = pw.createCollider(RAPIER.ColliderDesc.ball(0.3).setSensor(true), body);
        expect(collider.shape.type).toBe(RAPIER.ShapeType.Ball);
        pw.dispose();
    });

    it('lets a game-code ball roll into a voxel wall at speed (the rapier#993 scenario)', () => {
        // Built exactly as a game would: RAPIER.ColliderDesc.ball, through the
        // engine's PhysicsWorld. With a real Ball shape this dies in step().
        const S = 0.5;
        const cells = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): Int32Array => {
            const out: number[] = [];
            for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) out.push(x, y, z);
            return new Int32Array(out);
        };
        const pw = new PhysicsWorld();
        const fixed = pw.createRigidBody(RAPIER.RigidBodyDesc.fixed());
        pw.createCollider(RAPIER.ColliderDesc.voxels(cells(0, 32, 0, 1, 0, 16), { x: S, y: S, z: S }).setFriction(0.5), fixed);
        pw.createCollider(RAPIER.ColliderDesc.voxels(cells(0, 8, 1, 5, 0, 16), { x: S, y: S, z: S }).setTranslation(16 * S, 0, 0).setFriction(0.5), fixed);
        const ball = pw.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(2, S + 0.2, 4).setLinvel(6, 0, 0));
        pw.createCollider(RAPIER.ColliderDesc.ball(0.2).setFriction(0.5).setDensity(100), ball);
        for (let i = 0; i < 150; i++) pw.step(1 / 60);
        const x = ball.translation().x;
        expect(x).toBeGreaterThan(7);
        expect(x).toBeLessThan(8);
        pw.dispose();
    });
});
