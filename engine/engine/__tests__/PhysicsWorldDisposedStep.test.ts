/**
 * Dispose-during-load regression: the creator can DISPOSE_GAME while an async
 * load stage (spawnBakedLevelScenery → EnvironmentObjectSystem.generateScenery)
 * is still awaiting assets. The load continuation then calls step() on the
 * already-disposed PhysicsWorld — setting `world.timestep` on the freed WASM
 * world throws `Cannot set properties of undefined (setting 'dt')`, which the
 * catch in step() misreports as a poisoned rapier borrow and permanently halts
 * that instance.
 *
 * A disposed world must treat step() as a no-op instead.
 */
import { initRapier } from 'engine/physics/RapierPhysics.js';
import { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';

beforeAll(async () => {
    await initRapier();
});

describe('PhysicsWorld disposed-instance stepping', () => {
    test('step() after dispose() is a no-op, not a fake WASM-poisoned halt', () => {
        const pw = new PhysicsWorld();
        pw.step(1 / 60); // sanity: live world steps fine
        expect(pw.isHalted()).toBe(false);

        pw.dispose();

        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            expect(() => pw.step(1 / 60)).not.toThrow();
            expect(pw.isHalted()).toBe(false);
            expect(errorSpy).not.toHaveBeenCalled();
        } finally {
            errorSpy.mockRestore();
        }
    });

    test('isDisposed() reflects lifecycle', () => {
        const pw = new PhysicsWorld();
        expect(pw.isDisposed()).toBe(false);
        pw.dispose();
        expect(pw.isDisposed()).toBe(true);
    });
});
