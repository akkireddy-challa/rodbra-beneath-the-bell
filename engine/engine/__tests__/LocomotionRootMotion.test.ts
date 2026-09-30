import { VectorKeyframeTrack } from 'three';
import { removeLinearRootTravel } from 'engine/animation/LocomotionRootMotion.js';

describe('locomotion root filtering', () => {
    it('removes travel without deleting sideways sway, vertical bob or local surges', () => {
        const track = new VectorKeyframeTrack('Hips.position', [0, .5, 1], [2, 100, 0, -2, 103, 54, 2, 100, 100]);
        expect(removeLinearRootTravel(track)).toBe(100);
        expect(Array.from(track.values)).toEqual([2, 100, 0, -2, 103, 4, 2, 100, 0]);
        expect(removeLinearRootTravel(track)).toBe(0);
        expect(Array.from(track.values)).toEqual([2, 100, 0, -2, 103, 4, 2, 100, 0]);
    });

    it('preserves an idle weight shift and handles nonuniform lateral timing', () => {
        const idle = new VectorKeyframeTrack('Hips.position', [0, 1, 2], [2, 100, 0, -2, 100, 0, 2, 100, 0]);
        expect(removeLinearRootTravel(idle)).toBe(0);
        expect(idle.values[3]).toBe(-2);
        const strafe = new VectorKeyframeTrack('Hips.position', [1, 1.25, 2], [0, 100, 3, 27, 100, 3, 100, 100, 3]);
        expect(removeLinearRootTravel(strafe)).toBe(100);
        expect(strafe.values[3]).toBe(2);
    });
});
