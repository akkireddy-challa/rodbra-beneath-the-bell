import * as THREE from 'three';
import { ContinuousQuaternionBlend } from 'engine/animation/ContinuousQuaternionBlend.js';

const axis = new THREE.Vector3(0, 1, 0);
const rotation = (angle: number) => new THREE.Quaternion().setFromAxisAngle(axis, angle);
describe('continuous quaternion blend', () => {
    it('records the initial arc at zero weight before a fast half-turn crossing', () => {
        const blend = new ContinuousQuaternionBlend(); const out = new THREE.Quaternion();
        blend.sample('hand', out, rotation(0), rotation(179 * Math.PI / 180), 0);
        blend.sample('hand', out, rotation(0), rotation(185 * Math.PI / 180), .5);
        expect(out.angleTo(rotation(92.5 * Math.PI / 180))).toBeLessThan(1e-6);
    });
    it.each([30, 60, 120, 144])('unwraps moving endpoints past 180 and 360 degrees at %i Hz', fps => {
        const blend = new ContinuousQuaternionBlend(); blend.begin('same sources');
        const target = new THREE.Quaternion(); let previous = target.clone();
        for (let i = 0; i <= fps * 2; i++) {
            const angle = i / fps * Math.PI * 1.5;
            const b = rotation(angle);
            // Quaternion signs carry no physical orientation information.
            if (i % 2) b.set(-b.x, -b.y, -b.z, -b.w);
            blend.sample('hand', target, rotation(0), b, .5);
            expect(target.angleTo(rotation(angle * .5))).toBeLessThan(1e-6);
            expect(target.angleTo(previous)).toBeLessThan(2.4 / fps);
            previous = target.clone();
        }
    });
    it('resets winding on replacement and at exact endpoints, including aliased output', () => {
        const blend = new ContinuousQuaternionBlend(); const out = new THREE.Quaternion();
        for (let degrees = 0; degrees <= 270; degrees++) blend.sample('hand', out, rotation(0), rotation(degrees * Math.PI / 180), .5);
        blend.begin('replacement');
        const b = rotation(270 * Math.PI / 180);
        blend.sample('hand', b, rotation(0), b, .5);
        expect(b.angleTo(rotation(-Math.PI / 4))).toBeLessThan(1e-6);
        blend.sample('hand', out, rotation(.3), rotation(.8), 1);
        expect(out.angleTo(rotation(.8))).toBeLessThan(1e-6);
        blend.sample('hand', out, rotation(.3), rotation(.8), 0);
        expect(out.angleTo(rotation(.3))).toBeLessThan(1e-6);
    });
    it('commutes with a shared moving world frame', () => {
        const blend = new ContinuousQuaternionBlend(); const out = new THREE.Quaternion();
        for (let i = 0; i < 200; i++) {
            const frame = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), i * .07);
            blend.sample('hand', out, frame, frame.clone().multiply(rotation(i * .02)), .4);
            expect(out.angleTo(frame.clone().multiply(rotation(i * .02 * .4)))).toBeLessThan(1e-6);
        }
    });
});
