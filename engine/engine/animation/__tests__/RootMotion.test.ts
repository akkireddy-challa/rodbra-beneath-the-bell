import * as THREE from 'three';
import { captureRootMotionBaseline, rootMotionWorldTravelXZ } from 'engine/animation/RootMotion.js';

/**
 * Build a skeleton-root Object3D positioned and facing like the engine sets it
 * each frame (translation = player world pos, rotation.y = player yaw), with a
 * single hips child at a given local position.
 */
function makeRig(opts: {
    rootPos: [number, number, number];
    yaw: number;
    scale?: number;
    hipsLocal: [number, number, number];
}): { root: THREE.Object3D; hips: THREE.Object3D } {
    const root = new THREE.Group();
    root.position.set(...opts.rootPos);
    root.rotation.y = opts.yaw;
    const s = opts.scale ?? 1;
    root.scale.set(s, s, s);
    const hips = new THREE.Object3D();
    hips.position.set(...opts.hipsLocal);
    root.add(hips);
    root.updateMatrixWorld(true);
    return { root, hips };
}

describe('rootMotionWorldTravelXZ', () => {
    const out = new THREE.Vector3();

    it('reports zero travel before the hips move', () => {
        const { root, hips } = makeRig({ rootPos: [5, 0, 7], yaw: 0, hipsLocal: [0, 1, 0] });
        const baseline = captureRootMotionBaseline(root, hips.getWorldPosition(new THREE.Vector3()));
        rootMotionWorldTravelXZ(root, hips.getWorldPosition(new THREE.Vector3()), baseline, out);
        expect(out.x).toBeCloseTo(0, 6);
        expect(out.z).toBeCloseTo(0, 6);
    });

    it('a forward (+Z local) step facing yaw=0 travels +Z in world', () => {
        const { root, hips } = makeRig({ rootPos: [0, 0, 0], yaw: 0, hipsLocal: [0, 1, 0] });
        const baseline = captureRootMotionBaseline(root, hips.getWorldPosition(new THREE.Vector3()));
        hips.position.set(0, 1, 0.5);
        root.updateMatrixWorld(true);
        rootMotionWorldTravelXZ(root, hips.getWorldPosition(new THREE.Vector3()), baseline, out);
        expect(out.x).toBeCloseTo(0, 6);
        expect(out.z).toBeCloseTo(0.5, 6);
        expect(out.y).toBe(0);
    });

    it('rotates the local step into the player facing (yaw=90° → +Z local becomes +X world)', () => {
        // Gameplay forward under R_y(θ) is (sinθ, 0, cosθ); at θ=π/2 that is +X.
        const { root, hips } = makeRig({ rootPos: [0, 0, 0], yaw: Math.PI / 2, hipsLocal: [0, 1, 0] });
        const baseline = captureRootMotionBaseline(root, hips.getWorldPosition(new THREE.Vector3()));
        hips.position.set(0, 1, 0.5);
        root.updateMatrixWorld(true);
        rootMotionWorldTravelXZ(root, hips.getWorldPosition(new THREE.Vector3()), baseline, out);
        expect(out.x).toBeCloseTo(0.5, 6);
        expect(out.z).toBeCloseTo(0, 6);
    });

    it('is independent of the player world position (translation cancels)', () => {
        const { root, hips } = makeRig({ rootPos: [123, 45, -67], yaw: 0, hipsLocal: [0, 1, 0] });
        const baseline = captureRootMotionBaseline(root, hips.getWorldPosition(new THREE.Vector3()));
        hips.position.set(0.2, 1, 0.5);
        root.updateMatrixWorld(true);
        rootMotionWorldTravelXZ(root, hips.getWorldPosition(new THREE.Vector3()), baseline, out);
        expect(out.x).toBeCloseTo(0.2, 6);
        expect(out.z).toBeCloseTo(0.5, 6);
    });

    it('scales the travel by the skeleton root scale', () => {
        const { root, hips } = makeRig({ rootPos: [0, 0, 0], yaw: 0, scale: 2, hipsLocal: [0, 1, 0] });
        const baseline = captureRootMotionBaseline(root, hips.getWorldPosition(new THREE.Vector3()));
        hips.position.set(0, 1, 0.5);
        root.updateMatrixWorld(true);
        rootMotionWorldTravelXZ(root, hips.getWorldPosition(new THREE.Vector3()), baseline, out);
        expect(out.z).toBeCloseTo(1.0, 6); // 0.5 local * scale 2
    });
});
