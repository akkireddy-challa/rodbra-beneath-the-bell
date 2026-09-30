/**
 * @jest-environment jsdom
 */
import * as THREE from 'three';
import { FirstPersonCamera, DEFAULT_VIEW_PUNCH_OPTIONS } from 'engine/FirstPersonCamera.js';

/**
 * View punch is the one place a weapon reaches into the player's aim, so the
 * boundary has to be exact: at recenter 1 firing must be provably decorative,
 * and below 1 the permanent share must still respect the pitch clamp that every
 * other input goes through.
 */

/** A FirstPersonCamera with just enough environment to run update(). */
function makeCamera(): FirstPersonCamera {
    const perspective = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 1000);
    const target = new THREE.Object3D();
    const dom = document.createElement('div');
    const engine = { editorManager: null } as never;
    const camera = new FirstPersonCamera(perspective, target, dom, engine);
    camera.setPointerLocked(true);
    return camera;
}

function run(camera: FirstPersonCamera, seconds: number, dt = 1 / 60): void {
    for (let t = 0; t < seconds - 1e-9; t += dt) camera.update(dt);
}

/**
 * How far above the horizon the camera is looking, in radians.
 *
 * Read off the camera's world direction rather than a pitch accessor:
 * getForwardVector() deliberately flattens Y (it is the MOVEMENT forward), and
 * getPitchAngle() uses a downward-positive convention. This says what the
 * player sees, in the sign everyone expects.
 */
function lookElevation(camera: FirstPersonCamera): number {
    const direction = camera.getCamera().getWorldDirection(new THREE.Vector3());
    return Math.asin(THREE.MathUtils.clamp(direction.y, -1, 1));
}

describe('view punch', () => {
    it('leaves the aim bit-identical when fully recentring', () => {
        const camera = makeCamera();
        run(camera, 0.5);
        const yaw = camera.getHorizontalAngle();
        const pitch = camera.getPitchAngle();

        for (let shot = 0; shot < 30; shot++) {
            camera.applyViewPunch(0.012, 0.005, { ...DEFAULT_VIEW_PUNCH_OPTIONS, recenter: 1 });
            run(camera, 0.125);
        }

        expect(camera.getHorizontalAngle()).toBeCloseTo(yaw, 12);
        expect(camera.getPitchAngle()).toBeCloseTo(pitch, 12);
    });

    it('raises the aim over a burst when it only partly recentres', () => {
        const camera = makeCamera();
        run(camera, 0.5);
        const before = lookElevation(camera);

        for (let shot = 0; shot < 30; shot++) {
            camera.applyViewPunch(0.012, 0.005, { ...DEFAULT_VIEW_PUNCH_OPTIONS, recenter: 0.65 });
            run(camera, 0.125);
        }
        run(camera, 1); // let the transient settle; only the permanent share is left

        // 30 shots x 0.012 rad x 35% permanent is ~0.126 rad (~7 degrees) —
        // enough to have to pull down against, not enough to lose the target.
        const climb = lookElevation(camera) - before;
        expect(climb).toBeGreaterThan(0.09);
        expect(climb).toBeLessThan(0.18);
    });

    it('clamps the permanent share like any other look input', () => {
        // A long burst straight up must not roll the view over the top.
        const camera = makeCamera();
        for (let shot = 0; shot < 400; shot++) {
            camera.applyViewPunch(0.05, 0, { ...DEFAULT_VIEW_PUNCH_OPTIONS, recenter: 0 });
            run(camera, 1 / 60);
        }
        run(camera, 1);
        expect(Math.abs(camera.getPitchAngle())).toBeLessThanOrEqual(Math.PI / 2 - 0.1 + 1e-9);
        // Still looking up, not flipped over behind the player.
        expect(lookElevation(camera)).toBeGreaterThan(1.3);
    });

    it('springs the visual kick back to nothing', () => {
        const camera = makeCamera();
        run(camera, 0.5);
        const before = camera.getCamera().quaternion.clone();

        camera.applyViewPunch(0.05, 0.02, { ...DEFAULT_VIEW_PUNCH_OPTIONS, recenter: 1 });
        camera.update(1 / 60);
        expect(camera.getCamera().quaternion.angleTo(before)).toBeGreaterThan(1e-3);

        run(camera, 2);
        expect(camera.getCamera().quaternion.angleTo(before)).toBeLessThan(1e-4);
    });

    it('is frame-rate independent', () => {
        const climbAt = (dt: number): number => {
            const camera = makeCamera();
            run(camera, 0.2, dt);
            const before = lookElevation(camera);
            for (let shot = 0; shot < 10; shot++) {
                camera.applyViewPunch(0.012, 0.005, { ...DEFAULT_VIEW_PUNCH_OPTIONS, recenter: 0.65 });
                run(camera, 0.125, dt);
            }
            // Settle before reading, so the comparison is of the permanent
            // change and not of where each rate happened to be mid-transient.
            run(camera, 2, dt);
            return lookElevation(camera) - before;
        };
        expect(climbAt(1 / 240)).toBeCloseTo(climbAt(1 / 30), 6);
    });
});

describe('aim-down-sights camera controls', () => {
    it('narrows and restores the field of view', () => {
        const camera = makeCamera();
        const base = camera.getCamera().fov;

        camera.setFovOffset(-18);
        run(camera, 1);
        expect(camera.getCamera().fov).toBeCloseTo(base - 18, 2);

        camera.clearFovOffset();
        run(camera, 1);
        expect(camera.getCamera().fov).toBe(base);
    });

    it('scales look sensitivity, and rejects nonsense scales', () => {
        const camera = makeCamera();
        expect(camera.getLookSensitivityScale()).toBe(1);

        camera.setLookSensitivityScale(0.708);
        camera.applyExternalDelta(100, 0);

        const reference = makeCamera();
        reference.applyExternalDelta(100, 0);

        // Read the TARGET angle: the live one is smoothed and has not moved yet.
        // Same input, 70.8% of the rotation.
        expect(camera.getTargetHorizontalAngle())
            .toBeCloseTo(reference.getTargetHorizontalAngle() * 0.708, 9);

        camera.setLookSensitivityScale(0);
        expect(camera.getLookSensitivityScale()).toBe(1);
    });
});
