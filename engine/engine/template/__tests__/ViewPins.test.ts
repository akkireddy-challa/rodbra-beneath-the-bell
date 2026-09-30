import * as THREE from 'three';
import { projectPins } from 'engine/template/ViewPins.js';

function cameraAtOriginLookingDownMinusZ(): THREE.PerspectiveCamera {
    const cam = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 1000);
    cam.position.set(0, 0, 0);
    cam.lookAt(0, 0, -1);
    cam.updateMatrixWorld(true);
    return cam;
}

describe('projectPins', () => {
    const cam = cameraAtOriginLookingDownMinusZ();

    it('keeps points in front of the camera, nearest first, numbered from 1', () => {
        const pins = projectPins([
            { id: 'far', label: 'Far', position: { x: 0, y: 0, z: -20 } },
            { id: 'near', label: 'Near', position: { x: 0, y: 0, z: -5 } },
        ], cam, 400, 300);
        expect(pins.map(p => [p.n, p.id])).toEqual([[1, 'near'], [2, 'far']]);
        // Dead ahead lands in the image centre.
        expect(pins[0]?.screen).toEqual([200, 150]);
        expect(pins[0]?.distance).toBeCloseTo(5);
    });

    it('drops points behind the camera and outside the frame', () => {
        const pins = projectPins([
            { id: 'behind', label: 'Behind', position: { x: 0, y: 0, z: 5 } },
            { id: 'off', label: 'Off to the side', position: { x: 100, y: 0, z: -5 } },
        ], cam, 400, 300);
        expect(pins).toEqual([]);
    });

    it('caps the number of pins', () => {
        const many = Array.from({ length: 30 }, (_, i) => ({ id: `o${i}`, label: `O${i}`, position: { x: 0, y: 0, z: -2 - i } }));
        expect(projectPins(many, cam, 400, 300, 5)).toHaveLength(5);
    });
});
