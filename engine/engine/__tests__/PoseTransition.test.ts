import * as THREE from 'three';
import { PoseBuffer, PoseTransition } from 'engine/animation/PoseTransition.js';

const pose = (x: number) => new Map([['hips', { position: new THREE.Vector3(x, 1, 0), rotation: new THREE.Quaternion() }]]);

describe('animation pose handoff', () => {
    it('interpolates a quaternion toward the destination, not toward its overwritten alias', () => {
        const transition = new PoseTransition();
        transition.apply(pose(0), 'a', null, .05, 0, .1);
        const makeTarget = () => {
            const p = pose(0);
            p.get('hips')!.rotation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
            return p;
        };
        transition.apply(makeTarget(), 'b', null, .05, 0, .1);
        const middle = makeTarget(); transition.apply(middle, 'b', null, .05, 0, .1);
        expect(middle.get('hips')!.rotation.angleTo(new THREE.Quaternion())).toBeCloseTo(Math.PI / 4);
    });
    it('owns its snapshot independently of reused input objects', () => {
        const input = pose(1);
        const buffer = new PoseBuffer();
        buffer.copy(input);
        input.get('hips')!.position.x = 99;
        input.clear();
        expect(buffer.pose.get('hips')!.position.x).toBe(1);
    });

    it('starts an interruption at the displayed pose and carries matching lift', () => {
        const blend = new PoseTransition();
        blend.apply(pose(1), 'strike1', null, 1 / 60, .1);
        const next = pose(4);
        const lift = blend.apply(next, 'strike2', null, 1 / 60, .4);
        expect(next.get('hips')!.position.x).toBe(1);
        expect(lift).toBeCloseTo(.1);
        const third = pose(8);
        blend.apply(third, 'strike3', null, 1 / 60, .8);
        expect(third.get('hips')!.position.x).toBe(1);
    });

    it.each([30, 60, 120])('converges and follows moving characters at %i fps', fps => {
        const blend = new PoseTransition();
        const frame = new THREE.Group();
        blend.apply(pose(1), 'a', frame, 1 / fps, 0);
        frame.position.x = 10;
        const next = pose(14);
        blend.apply(next, 'b', frame, 1 / fps, .2);
        expect(next.get('hips')!.position.x).toBeCloseTo(11);
        for (let i = 0; i < fps; i++) blend.apply(pose(14), 'b', frame, 1 / fps, .2);
        const end = pose(14);
        expect(blend.apply(end, 'b', frame, 1 / fps, .2)).toBe(.2);
        expect(end.get('hips')!.position.x).toBe(14);
    });
});
