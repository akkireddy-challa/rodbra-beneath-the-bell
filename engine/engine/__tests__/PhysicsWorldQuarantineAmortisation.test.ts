/**
 * quarantineNonFiniteBodies amortises its scan of FIXED bodies across substeps
 * (FIXED_QUARANTINE_SCAN_SLICES) because they dominate a level's body set —
 * 1547 of 1844 in a measured city — and, never being integrated by the solver,
 * cannot BECOME non-finite mid-simulation.
 *
 * Amortising must not mean dropping coverage. These tests pin both halves of
 * that bargain: a DYNAMIC body (what the solver can actually run away with) is
 * still caught on the very next step, and a FIXED one is still caught, just
 * within the sweep window rather than immediately.
 *
 * They also pin `forEachActiveRigidBody`, which the pristine-dynamic wake sweep
 * relies on to cost nothing while a level's props are asleep.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { initRapier } from 'engine/physics/RapierPhysics.js';
import { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';

/** Upper bound on substeps one full fixed-body sweep takes (see PhysicsWorld). */
const SWEEP_SLICES = 32;

beforeAll(async () => {
    await initRapier();
});

/** Step until `done()` or `maxSteps` substeps have run; returns substeps used. */
function stepUntil(pw: PhysicsWorld, done: () => boolean, maxSteps: number): number {
    for (let i = 1; i <= maxSteps; i++) {
        pw.step(1 / 60);
        if (done()) return i;
    }
    return Infinity;
}

describe('quarantineNonFiniteBodies coverage after amortisation', () => {
    test('a non-finite DYNAMIC body is still caught immediately', () => {
        const pw = new PhysicsWorld();
        const body = pw.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 10, 0));
        pw.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5), body);
        const before = pw.getStats().rigidBodyCount;

        body.setTranslation({ x: NaN, y: 10, z: 0 }, true);

        // One substep sanitizes it, the next removes it — well inside the window
        // a fixed body would need.
        const used = stepUntil(pw, () => pw.getStats().rigidBodyCount < before, 4);
        expect(used).toBeLessThanOrEqual(4);
        expect(pw.isHalted()).toBe(false);
        pw.dispose();
    });

    test('a non-finite FIXED body is still caught, within the sweep window', () => {
        const pw = new PhysicsWorld();
        const body = pw.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, 0));
        pw.createCollider(RAPIER.ColliderDesc.cuboid(1, 1, 1), body);
        const before = pw.getStats().rigidBodyCount;

        body.setTranslation({ x: 0, y: NaN, z: 0 }, true);

        // +2 substeps of slack: the sweep has to reach this body's slice, then
        // the sanitize/remove handshake takes one more step.
        const used = stepUntil(pw, () => pw.getStats().rigidBodyCount < before, SWEEP_SLICES + 2);
        expect(used).toBeLessThanOrEqual(SWEEP_SLICES + 2);
        expect(pw.isHalted()).toBe(false);
        pw.dispose();
    });
});

describe('forEachActiveRigidBody', () => {
    test('skips sleeping bodies and visits them once woken', () => {
        const pw = new PhysicsWorld();
        const body = pw.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 1, 0));
        pw.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5), body);
        body.sleep();

        // The island manager is rebuilt inside world.step(), so both halves step
        // first — which is also how the pristine-dynamic wake sweep sees it, as a
        // POST-step callback.
        pw.step(1 / 60);
        const visitedWhileAsleep: number[] = [];
        pw.forEachActiveRigidBody((b) => visitedWhileAsleep.push(b.handle));
        expect(visitedWhileAsleep).not.toContain(body.handle);

        body.wakeUp();
        pw.step(1 / 60);
        const visitedAwake: number[] = [];
        pw.forEachActiveRigidBody((b) => visitedAwake.push(b.handle));
        expect(visitedAwake).toContain(body.handle);

        pw.dispose();
    });

    test('is a no-op on a disposed world rather than touching freed WASM', () => {
        const pw = new PhysicsWorld();
        pw.dispose();
        let visited = 0;
        expect(() => pw.forEachActiveRigidBody(() => { visited++; })).not.toThrow();
        expect(visited).toBe(0);
    });
});
