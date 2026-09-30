import * as THREE from 'three';
import type { PlayerController } from 'engine/PlayerController.js';
import { RigInputReader } from 'engine/viewmodel/RigInput.js';

/**
 * These read the controller's REAL shapes, and getting one wrong is fatal
 * rather than cosmetic: this runs inside PlayerController.update, so a throw
 * here stops the player moving.
 *
 * The shape that actually bit: `isGrounded` is a boolean PROPERTY, and
 * `controller.isGrounded?.()` looks like a safe probe but is not — optional
 * call guards null and undefined, so `true?.()` throws "is not a function"
 * every frame from the moment a weapon is equipped.
 */

/** A stand-in with the controller's real member shapes. */
function makeController(overrides: Record<string, unknown> = {}): PlayerController {
    const player = new THREE.Object3D();
    return {
        player,
        // PROPERTY, not a method. This is the whole point of the test.
        isGrounded: true,
        getCurrentSpeed: () => 3,
        getMovementSystem: () => ({ getMoveSpeed: () => 6 }),
        getCameraController: () => ({
            getHorizontalAngle: () => 0.5,
            getPitchAngle: () => -0.2,
        }),
        ...overrides,
    } as unknown as PlayerController;
}

describe('RigInputReader', () => {
    it('reads isGrounded as a property, never as a call', () => {
        const reader = new RigInputReader();
        expect(() => reader.read(makeController(), 1 / 60, false)).not.toThrow();
        expect(reader.read(makeController(), 1 / 60, false).grounded).toBe(true);
        expect(reader.read(makeController({ isGrounded: false }), 1 / 60, false).grounded).toBe(false);
    });

    it('reads speed and reference speed off the real accessors', () => {
        const input = new RigInputReader().read(makeController(), 1 / 60, false);
        expect(input.speed).toBe(3);
        expect(input.referenceSpeed).toBe(6);
    });

    it('reads look angles off the camera controller', () => {
        const input = new RigInputReader().read(makeController(), 1 / 60, false);
        expect(input.yaw).toBe(0.5);
        expect(input.pitch).toBe(-0.2);
    });

    it('derives vertical velocity from the player position', () => {
        // No movement system exposes it, so it is differentiated here.
        const reader = new RigInputReader();
        const controller = makeController();
        const player = (controller as unknown as { player: THREE.Object3D }).player;

        player.position.y = 10;
        expect(reader.read(controller, 1 / 60, false).verticalVelocity).toBe(0); // no history yet

        player.position.y = 10 - 0.1;
        expect(reader.read(controller, 1 / 60, false).verticalVelocity).toBeCloseTo(-6, 6);

        reader.reset();
        player.position.y = 5;
        expect(reader.read(controller, 1 / 60, false).verticalVelocity).toBe(0);
    });

    it('survives a controller missing every optional accessor', () => {
        // Custom controllers in generated games are real, and a missing getter
        // must degrade rather than take the player's movement down with it.
        const bare = { player: new THREE.Object3D() } as unknown as PlayerController;
        const reader = new RigInputReader();
        expect(() => reader.read(bare, 1 / 60, false)).not.toThrow();
        const input = reader.read(bare, 1 / 60, false);
        expect(input.grounded).toBe(true);
        expect(input.speed).toBe(0);
        expect(input.referenceSpeed).toBeGreaterThan(0);
    });

    it('survives no controller at all', () => {
        const input = new RigInputReader().read(null, 1 / 60, false);
        expect(Number.isFinite(input.speed)).toBe(true);
        expect(input.referenceSpeed).toBeGreaterThan(0);
    });

    it('never reports a zero reference speed, which would divide by zero downstream', () => {
        const reader = new RigInputReader();
        const controller = makeController({ getMovementSystem: () => ({ getMoveSpeed: () => 0 }) });
        expect(reader.read(controller, 1 / 60, false).referenceSpeed).toBeGreaterThan(0);
    });

    it('passes the aim flag straight through', () => {
        const reader = new RigInputReader();
        expect(reader.read(makeController(), 1 / 60, true).adsHeld).toBe(true);
        expect(reader.read(makeController(), 1 / 60, false).adsHeld).toBe(false);
    });
});
