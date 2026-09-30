import * as THREE from 'three';
import { computeSkiRiderKeys, DEFAULT_SKI_RIDER_SKILL } from 'engine/ski/SkiRiderInput.js';

// Heading 0 means facing +Z (forward = (sin0, 0, cos0) = +Z). SkiMovement turns
// with `left` = turnInput +1 = heading INCREASES, `right` = heading DECREASES.
// So the rider presses the key that drives `heading` toward the target's bearing.
const dir = (x: number, z: number) => new THREE.Vector3(x, 0, z);
const skill = DEFAULT_SKI_RIDER_SKILL;

describe('computeSkiRiderKeys', () => {
    it('holds a straight tuck when already aligned with the target', () => {
        const k = computeSkiRiderKeys(0, 20, dir(0, 1), skill); // target dead ahead (+Z)
        expect(k.forward).toBe(true);
        expect(k.backward).toBe(false);
        expect(k.left).toBe(false);
        expect(k.right).toBe(false);
    });

    it('presses left to raise heading toward a target that needs +yaw', () => {
        // target +X → bearing +pi/2 > current 0 → must increase heading → left key
        const k = computeSkiRiderKeys(0, 20, dir(1, 0), skill);
        expect(k.left).toBe(true);
        expect(k.right).toBe(false);
    });

    it('presses right to lower heading toward a target that needs -yaw', () => {
        // target -X → bearing -pi/2 < current 0 → must decrease heading → right key
        const k = computeSkiRiderKeys(0, 20, dir(-1, 0), skill);
        expect(k.right).toBe(true);
        expect(k.left).toBe(false);
    });

    it('brakes (drops the tuck) on a too-sharp turn at speed', () => {
        const k = computeSkiRiderKeys(0, 25, dir(-1, 0), skill); // 90° error, fast
        expect(k.backward).toBe(true);
        expect(k.forward).toBe(false);
        expect(k.right).toBe(true); // still steers into the turn while braking
    });

    it('carves without braking on the same sharp turn when slow', () => {
        const k = computeSkiRiderKeys(0, 5, dir(-1, 0), skill); // 90° error, below brakeMinSpeed
        expect(k.backward).toBe(false);
        expect(k.forward).toBe(true);
        expect(k.right).toBe(true);
    });

    it('holds a straight tuck when there is no target', () => {
        const k = computeSkiRiderKeys(0, 20, dir(0, 0), skill);
        expect(k.forward).toBe(true);
        expect(k.left).toBe(false);
        expect(k.right).toBe(false);
    });

    it('ignores tiny heading errors (deadzone) to avoid oscillation', () => {
        const tiny = 1 * (Math.PI / 180); // 1° < 3° deadzone
        const k = computeSkiRiderKeys(0, 20, dir(Math.sin(tiny), Math.cos(tiny)), skill);
        expect(k.left).toBe(false);
        expect(k.right).toBe(false);
    });
});
