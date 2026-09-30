import type { PlayerController } from 'engine/PlayerController.js';
import type { RigFrameInput } from 'engine/viewmodel/ViewModelRig.js';

/**
 * Reads the per-frame state a view-model rig needs off a PlayerController.
 *
 * Shared by every view-model system so there is ONE place that knows how the
 * controller exposes this state — and so it can be tested against a
 * controller-shaped object without standing up an engine.
 *
 * That matters because the shapes here are not guessable and getting one wrong
 * is fatal rather than degraded: `isGrounded` is a PROPERTY, not a method, so
 * `controller.isGrounded?.()` is not a safe probe — optional-call guards
 * null and undefined, but `true?.()` throws. A throw in here lands inside
 * PlayerController.update, which takes the player's movement down with it.
 */

/** Fallback nominal speed when the movement system reports none. */
const DEFAULT_REFERENCE_SPEED = 5;

/** Tracks what has to be derived across frames rather than read. */
export class RigInputReader {
    private previousPlayerY: number | null = null;
    private verticalVelocity = 0;

    /** Forget the motion history — use after a teleport or respawn. */
    reset(): void {
        this.previousPlayerY = null;
        this.verticalVelocity = 0;
    }

    /**
     * Build one frame of rig input.
     *
     * @param adsHeld whether the aim control is held; the rig applies its own
     *                blocking rules on top.
     */
    read(controller: PlayerController | null, deltaTime: number, adsHeld: boolean): RigFrameInput {
        if (!controller) {
            return {
                yaw: 0, pitch: 0,
                speed: 0, referenceSpeed: DEFAULT_REFERENCE_SPEED,
                lateralVelocity: 0, verticalVelocity: 0,
                grounded: true, adsHeld: false,
            };
        }

        // Probed rather than called outright: these are required members of
        // PlayerController, but generated games install custom controllers that
        // implement only part of it, and a missing accessor must cost the
        // weapon its sway — not cost the player their movement.
        const camera = typeof controller.getCameraController === 'function'
            ? controller.getCameraController()
            : null;

        // Vertical velocity is DERIVED: no movement system exposes it, and
        // differentiating the player's own position works under every custom
        // movement system, on moving platforms, and during knockback.
        const playerY = controller.player?.position.y;
        if (playerY !== undefined) {
            if (this.previousPlayerY !== null && deltaTime > 0) {
                this.verticalVelocity = (playerY - this.previousPlayerY) / deltaTime;
            }
            this.previousPlayerY = playerY;
        }

        const movement = typeof controller.getMovementSystem === 'function'
            ? controller.getMovementSystem()
            : null;
        const referenceSpeed = typeof movement?.getMoveSpeed === 'function'
            ? movement.getMoveSpeed()
            : DEFAULT_REFERENCE_SPEED;

        return {
            yaw: typeof camera?.getHorizontalAngle === 'function' ? camera.getHorizontalAngle() : 0,
            pitch: typeof camera?.getPitchAngle === 'function' ? camera.getPitchAngle() : 0,
            speed: typeof controller.getCurrentSpeed === 'function' ? controller.getCurrentSpeed() : 0,
            referenceSpeed: referenceSpeed > 0 ? referenceSpeed : DEFAULT_REFERENCE_SPEED,
            // Strafe lean would need a body-frame velocity nothing exposes yet;
            // look sway and bob carry the motion in the meantime.
            lateralVelocity: 0,
            verticalVelocity: this.verticalVelocity,
            // A PROPERTY. See the note at the top of this file.
            grounded: controller.isGrounded !== false,
            adsHeld,
        };
    }
}
