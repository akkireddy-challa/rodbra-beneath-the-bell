import * as THREE from 'three';
import { ProceduralPoseLayers } from 'engine/animation/ProceduralPoseLayers.js';

function fixture() {
    const arm = new THREE.Bone(); arm.name = 'arm';
    const hand = new THREE.Bone(); hand.name = 'hand'; hand.position.y = 1; arm.add(hand);
    const bones = new Map([['arm', arm], ['hand', hand]]);
    const pose = () => new Map([...bones].map(([name, bone]) => [name,
        { position: bone.getWorldPosition(new THREE.Vector3()), rotation: bone.getWorldQuaternion(new THREE.Quaternion()) }]));
    return { bones, pose };
}

describe('bounded procedural layers', () => {
    it.each([30, 60, 144])('streams targets without restarting or resurrecting envelopes at %i fps', fps => {
        const layers = new ProceduralPoseLayers(); const { bones, pose } = fixture();
        const rotations = new Map([['arm', new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), .3)]]);
        layers.set('aim', { rotations, weight: 1, fadeIn: .2, fadeOut: .1, duration: null });
        for (let i = 0; i < fps; i++) { expect(layers.updateTargets('aim', rotations)).toBe(true); layers.update(1 / fps); }
        const p = pose(); layers.apply(p, bones, () => null);
        expect(p.get('arm')!.rotation.angleTo(rotations.get('arm')!)).toBeLessThan(1e-6);
        const invalid = new Map([['arm', new THREE.Quaternion(NaN, 0, 0, 1)]]);
        expect(() => layers.updateTargets('aim', invalid)).toThrow();
        layers.remove('aim');
        expect(layers.updateTargets('aim', rotations)).toBe(false);
        for (let i = 0; i < fps; i++) layers.update(1 / fps);
        expect(layers.size).toBe(0); expect(layers.updateTargets('aim', rotations)).toBe(false);
    });
    it('rotates the entire subtree without changing limb length or the source rig', () => {
        const { bones, pose } = fixture();
        const layers = new ProceduralPoseLayers();
        layers.set('recoil', { rotations: new Map([['arm', new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), .3)]]),
            weight: 1, fadeIn: 0, fadeOut: .1, duration: 1 });
        layers.update(.1);
        const p = pose(); layers.apply(p, bones, () => null);
        expect(p.get('hand')!.position.x).toBeCloseTo(-Math.sin(.3));
        expect(p.get('hand')!.position.distanceTo(p.get('arm')!.position)).toBeCloseTo(1);
        expect(bones.get('arm')!.quaternion.w).toBe(1);
    });
    it.each([30, 60, 120])('fades out and resets at %i fps', fps => {
        const layers = new ProceduralPoseLayers();
        layers.set('breathing', { rotations: new Map(), weight: 1, fadeIn: .1, fadeOut: .1, duration: .5 });
        for (let i = 0; i < fps; i++) layers.update(1 / fps);
        expect(layers.size).toBe(0);
    });
    it('rejects NaNs and clamps excessive joint rotation', () => {
        const layers = new ProceduralPoseLayers();
        expect(() => layers.set('bad', { rotations: new Map(), weight: NaN, fadeIn: 0, fadeOut: 0, duration: null })).toThrow();
        const { bones, pose } = fixture();
        layers.set('limit', { rotations: new Map([['arm', new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 2)]]),
            weight: 1, fadeIn: 0, fadeOut: 0, duration: null });
        layers.update(.1);
        const p = pose(); layers.apply(p, bones, () => null);
        expect(p.get('arm')!.rotation.angleTo(new THREE.Quaternion())).toBeCloseTo(Math.PI / 4);
    });
});
