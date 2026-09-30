import * as THREE from 'three';
import { VehicleCamera } from 'engine/VehicleCamera.js';

/**
 * Chase-camera framing, which is two effects on one fov.
 *
 * The speed dolly runs at every aspect: the fov opens for the sensation of
 * speed and the rig comes in by exactly the amount that holds the car's
 * on-screen size, so the car must NOT end up looking further away.
 *
 * The portrait widening runs on top, only on tall viewports. `fov` is the
 * VERTICAL angle, so a phone held upright shows a fraction of the width a
 * landscape screen does — not enough of the sides to drive by — and the camera
 * answers by backing off and opening up further.
 *
 * Either way the fov is borrowed: it goes back as it was found.
 */

const DT = 1 / 60;
const LANDSCAPE = 16 / 9;
const PHONE_PORTRAIT = 375 / 812;

/** The engine default, and the value every expectation below is derived from. */
const BASE_FOV = 60;
/** tan(30°)/tan(34°) — the dolly that pays for SPEED_FOV_GAIN_DEG (8°). */
const DOLLY = Math.tan(THREE.MathUtils.degToRad(BASE_FOV) / 2)
    / Math.tan(THREE.MathUtils.degToRad(BASE_FOV + 8) / 2);

/** DOM stub — the camera only attaches listeners and sets a cursor. */
function domStub(): HTMLElement {
    return {
        addEventListener: () => {},
        removeEventListener: () => {},
        style: {},
    } as unknown as HTMLElement;
}

/** No world at all: the framing under test is the resting one, unblocked. */
const openSpace = {
    physicsWorld: {
        raycast: () => ({
            hasHit: false, hitPoint: new THREE.Vector3(), hitDistance: 0, hitRigidBody: null,
        }),
    },
};

function makeCamera(aspect: number) {
    const camera = new THREE.PerspectiveCamera(BASE_FOV, aspect, 0.1, 1000);
    const target = new THREE.Object3D();
    target.updateMatrixWorld(true);
    const vehicleCamera = new VehicleCamera(camera, target, domStub(), openSpace, 1);
    return { camera, target, vehicleCamera };
}

/** Let the smoothing settle, then measure how far behind the car the camera sits. */
function settledChaseDistance(camera: THREE.PerspectiveCamera, target: THREE.Object3D, vehicleCamera: VehicleCamera): number {
    for (let i = 0; i < 240; i++) vehicleCamera.update(DT);
    return Math.hypot(camera.position.x - target.position.x, camera.position.z - target.position.z);
}

describe('VehicleCamera speed dolly', () => {
    it('opens the fov on a landscape viewport and comes in to pay for it', () => {
        const { camera, target, vehicleCamera } = makeCamera(LANDSCAPE);

        expect(camera.fov).toBeCloseTo(68, 4);
        expect(settledChaseDistance(camera, target, vehicleCamera))
            .toBeCloseTo(vehicleCamera.getDistance() * DOLLY, 2);
    });

    it('leaves the car the size it was before the widening', () => {
        // The whole point: a wider lens alone shrinks the car, and a small car
        // reads as slow. Measure a metre of car on screen against the framing
        // this rig REPLACED — 8 m back, 4 m up, 60° — and the two must agree.
        const { camera, target, vehicleCamera } = makeCamera(LANDSCAPE);
        for (let i = 0; i < 240; i++) vehicleCamera.update(DT);

        const pivot = new THREE.Vector3(0, 1.5, 0); // aim point on the car
        const aim = new THREE.Vector3(0, 1.5, 2);   // where the chase cam looks: 2 m ahead
        const previous = new THREE.PerspectiveCamera(BASE_FOV, LANDSCAPE, 0.1, 1000);
        // Same direction out of the pivot, un-dollied radius: hypot(8, 4 - 1.5).
        previous.position.copy(pivot).addScaledVector(
            camera.position.clone().sub(pivot).normalize(),
            Math.hypot(vehicleCamera.getDistance(), vehicleCamera.getHeight() - 1.5),
        );
        previous.lookAt(aim);
        previous.updateMatrixWorld(true);

        /** On-screen height of the metre of car above the aim point. */
        const carHeightOnScreen = (cam: THREE.PerspectiveCamera): number =>
            Math.abs(new THREE.Vector3(0, 2.5, 0).project(cam).y - pivot.clone().project(cam).y);

        expect(carHeightOnScreen(camera)).toBeCloseTo(carHeightOnScreen(previous), 2);
        expect(target.position.length()).toBe(0); // the car never moved
    });
});

describe('VehicleCamera portrait framing', () => {
    it('backs off and opens the fov further on a phone-shaped viewport', () => {
        const { camera, target, vehicleCamera } = makeCamera(PHONE_PORTRAIT);

        // 8 m configured → 50% further back before the dolly, and 12° on top of
        // the speed gain: 60 + 8 + 12.
        expect(camera.fov).toBeCloseTo(80, 4);
        expect(settledChaseDistance(camera, target, vehicleCamera))
            .toBeCloseTo(vehicleCamera.getDistance() * 1.5 * DOLLY, 2);
    });

    it('ramps between the two rather than switching', () => {
        // Tablet-ish 3:4. Half way along the 1.0 → 0.6 ramp, so half the effect.
        const { camera, target, vehicleCamera } = makeCamera(0.8);

        expect(camera.fov).toBeCloseTo(74, 4);
        expect(settledChaseDistance(camera, target, vehicleCamera))
            .toBeCloseTo(vehicleCamera.getDistance() * 1.25 * DOLLY, 2);
    });

    it('follows the viewport when the device is rotated', () => {
        const { camera, target, vehicleCamera } = makeCamera(PHONE_PORTRAIT);
        settledChaseDistance(camera, target, vehicleCamera);

        // Turned sideways: GameEngine.onWindowResize owns aspect, the camera
        // must notice on its own and give the landscape framing back.
        camera.aspect = 1 / PHONE_PORTRAIT;
        expect(settledChaseDistance(camera, target, vehicleCamera))
            .toBeCloseTo(vehicleCamera.getDistance() * DOLLY, 2);
        expect(camera.fov).toBeCloseTo(68, 4);
    });

    it('does not compound the widening across frames or over setDistance', () => {
        const { camera, target, vehicleCamera } = makeCamera(PHONE_PORTRAIT);
        settledChaseDistance(camera, target, vehicleCamera);

        vehicleCamera.setDistance(10);

        expect(vehicleCamera.getDistance()).toBe(10);
        expect(settledChaseDistance(camera, target, vehicleCamera)).toBeCloseTo(10 * 1.5 * DOLLY, 2);
        expect(camera.fov).toBeCloseTo(80, 4);
    });

    it('hands the fov back on dispose, so leaving the vehicle does not keep it', () => {
        const { camera, target, vehicleCamera } = makeCamera(PHONE_PORTRAIT);
        settledChaseDistance(camera, target, vehicleCamera);
        expect(camera.fov).toBeCloseTo(80, 4);

        vehicleCamera.dispose();

        expect(camera.fov).toBe(BASE_FOV);
    });
});
