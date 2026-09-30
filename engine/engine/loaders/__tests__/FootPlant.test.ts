import * as THREE from 'three';
import { FootPlant } from 'engine/loaders/FootPlant.js';
import type { RaycastResult } from 'engine/physics/PhysicsWorld.js';

function fixture() {
    const thigh = new THREE.Bone(); thigh.position.y = 1;
    const shin = new THREE.Bone(); shin.position.set(0, -.45, .2); thigh.add(shin);
    const foot = new THREE.Bone(); foot.position.set(0, -.45, -.2); shin.add(foot);
    thigh.updateMatrixWorld(true);
    const hit: RaycastResult = { hasHit: true, hitPoint: new THREE.Vector3(0, .1, 0),
        hitNormal: new THREE.Vector3(0, 1, 0), hitDistance: .1, hitCollider: null, hitRigidBody: null };
    return { bones: { thigh, shin, foot }, hit };
}

describe('conservative skinned foot contacts', () => {
    it.each([30, 60, 120, 144])('keeps rotating toes above ground after the stance solve at %i Hz', fps => {
        const plant = new FootPlant(), { bones, hit } = fixture();
        const facing = new THREE.Quaternion(), toe = new THREE.Bone();
        toe.position.set(0, -.1, .18); bones.foot.add(toe); hit.hitPoint.y = 0;
        for (let i = 0; i < fps; i++) {
            bones.thigh.position.y = 1;
            bones.thigh.quaternion.identity(); bones.shin.quaternion.identity();
            bones.foot.rotation.x = 0;
            bones.thigh.updateMatrixWorld(true);
            plant.solve(bones, facing, hit, 0, 0, true, 1.75, 1 / fps);
        }
        expect(plant.isPlanted).toBe(true);
        let remainedPlanted = false;
        for (let i = 0; i < fps; i++) {
            bones.thigh.position.y = 1;
            bones.thigh.quaternion.identity(); bones.shin.quaternion.identity();
            bones.foot.rotation.x = .6 * Math.sin(i / fps * Math.PI);
            bones.thigh.updateMatrixWorld(true);
            // The preceding clearance solve delivered a safe pose. A stale
            // ankle anchor must not undo it as the toe rotates downwards.
            bones.thigh.position.y -= toe.getWorldPosition(new THREE.Vector3()).y;
            bones.thigh.updateMatrixWorld(true);
            const hip = bones.thigh.position.clone();
            const rotation = bones.foot.getWorldQuaternion(new THREE.Quaternion());
            plant.solve(bones, facing, hit, 0, 0, true, 1.75, 1 / fps);
            remainedPlanted ||= plant.isPlanted;
            expect(toe.getWorldPosition(new THREE.Vector3()).y).toBeGreaterThan(-1e-6);
            expect(bones.thigh.position).toEqual(hip);
            expect(bones.foot.getWorldQuaternion(new THREE.Quaternion()).angleTo(rotation)).toBeLessThan(1e-6);
        }
        expect(remainedPlanted).toBe(true);
    });

    it.each([30, 60, 120, 144])('releases a drifting stance continuously at %i Hz', fps => {
        const plant = new FootPlant(); const { bones, hit } = fixture(); const facing = new THREE.Quaternion();
        for (let i = 0; i < fps; i++) plant.solve(bones, facing, hit, .1, .1, true, 1.75, 1 / fps);
        let previous = bones.foot.getWorldPosition(new THREE.Vector3());
        let released = false;
        for (let i = 0; i < fps * 2; i++) {
            bones.thigh.position.x = i / fps * .12;
            bones.thigh.quaternion.identity(); bones.shin.quaternion.identity(); bones.foot.quaternion.identity();
            bones.thigh.updateMatrixWorld(true);
            plant.solve(bones, facing, hit, .1, .1, true, 1.75, 1 / fps);
            const current = bones.foot.getWorldPosition(new THREE.Vector3());
            expect(current.distanceTo(previous)).toBeLessThan(.35 / fps);
            released ||= !plant.isPlanted;
            previous = current;
        }
        expect(released).toBe(true);
    });
    it('plants reachable stance without moving the hip or flattening the foot', () => {
        const plant = new FootPlant(); const { bones, hit } = fixture();
        const before = bones.thigh.position.clone();
        for (let i = 0; i < 10; i++) plant.solve(bones, new THREE.Quaternion(), hit, .1, .1, true, 1.75, 1 / 60);
        expect(plant.isPlanted).toBe(true);
        expect(bones.thigh.position).toEqual(before);
    });
    it.each(['airborne', 'wall', 'highStep', 'noSurface'])('releases on %s', mode => {
        const plant = new FootPlant(); const { bones, hit } = fixture();
        for (let i = 0; i < 3; i++) plant.solve(bones, new THREE.Quaternion(), hit, .1, .1, true, 1.75, 1 / 60);
        if (mode === 'wall') hit.hitNormal.set(1, 0, 0);
        if (mode === 'highStep') hit.hitPoint.y += .5;
        if (mode === 'noSurface') hit.hasHit = false;
        plant.solve(bones, new THREE.Quaternion(), hit, .1, .1, mode !== 'airborne', 1.75, 1 / 60);
        expect(plant.isPlanted).toBe(false);
    });
    it('fades a valid stance to zero influence without changing the authored foot rotation', () => {
        const plant = new FootPlant(); const { bones, hit } = fixture();
        const facing = new THREE.Quaternion();
        for (let i = 0; i < 10; i++) plant.solve(bones, facing, hit, .1, .1, true, 1.75, 1 / 60);
        let lastCorrection = Infinity;
        for (const weight of [1, .5, .1, 0]) {
            bones.thigh.position.x = .04;
            bones.thigh.quaternion.identity(); bones.shin.quaternion.identity();
            bones.foot.rotation.set(.2, .1, .3);
            bones.thigh.updateMatrixWorld(true);
            const before = bones.foot.getWorldPosition(new THREE.Vector3());
            const rotation = bones.foot.getWorldQuaternion(new THREE.Quaternion());
            plant.solve(bones, facing, hit, .1, .1, true, 1.75, 1 / 60, weight);
            const correction = bones.foot.getWorldPosition(new THREE.Vector3()).distanceTo(before);
            expect(correction).toBeLessThan(lastCorrection);
            expect(bones.foot.getWorldQuaternion(new THREE.Quaternion()).angleTo(rotation)).toBeLessThan(1e-6);
            lastCorrection = correction;
        }
        expect(plant.isPlanted).toBe(false);
        expect(lastCorrection).toBe(0);
    });
});
