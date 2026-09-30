import * as THREE from 'three';
import {
    DEFAULT_SUN_AZIMUTH_DEG,
    DEFAULT_SUN_ELEVATION_DEG,
    MIN_SUN_ELEVATION_DEG,
    applySunDirection,
    resolveSunDirection,
    resetSunDirection,
} from 'engine/SunDirection.js';

describe('sun direction', () => {
    it.each([false, true])('clearing a preset preserves the translated shadow target (Gaussian=%s)', gaussian => {
        const light = new THREE.DirectionalLight();
        light.target.position.set(100, 20, 100);
        light.position.set(100, 220, 100);
        applySunDirection(light, { sunElevationDeg: 14, sunAzimuthDeg: 245 });
        resetSunDirection(light, gaussian);
        expect(light.position.clone().sub(light.target.position).normalize()
            .distanceTo(new THREE.Vector3(gaussian ? 0 : 1, 2, 1).normalize())).toBeLessThan(1e-6);
        expect(light.position.distanceTo(light.target.position)).toBeCloseTo(200, 6);
        expect(light.target.position.toArray()).toEqual([100, 20, 100]);
    });
    it('with no config reproduces the engine default sun (1, 2, 1)', () => {
        const expected = new THREE.Vector3(1, 2, 1).normalize();
        for (const cfg of [undefined, null, {}]) {
            expect(resolveSunDirection(cfg).distanceTo(expected)).toBeLessThan(1e-4);
        }
        expect(resolveSunDirection({ sunElevationDeg: DEFAULT_SUN_ELEVATION_DEG, sunAzimuthDeg: DEFAULT_SUN_AZIMUTH_DEG })
            .distanceTo(expected)).toBeLessThan(1e-4);
    });

    it('elevation is the angle above the horizon, azimuth the bearing clockwise from +Z', () => {
        const dusk = resolveSunDirection({ sunElevationDeg: 10, sunAzimuthDeg: 0 });
        expect(dusk.y).toBeCloseTo(Math.sin(THREE.MathUtils.degToRad(10)), 6);
        expect(dusk.z).toBeGreaterThan(0.9);          // light from +Z
        expect(dusk.x).toBeCloseTo(0, 6);
        const east = resolveSunDirection({ sunElevationDeg: 10, sunAzimuthDeg: 90 });
        expect(east.x).toBeGreaterThan(0.9);          // light from +X
        expect(resolveSunDirection({ sunElevationDeg: 90 }).y).toBeCloseTo(1, 6);   // overhead
        expect(resolveSunDirection({ sunElevationDeg: 10 }).length()).toBeCloseTo(1, 6);
    });

    it('never lets the sun reach the horizon (shadows would be unbounded)', () => {
        const min = Math.sin(THREE.MathUtils.degToRad(MIN_SUN_ELEVATION_DEG));
        expect(resolveSunDirection({ sunElevationDeg: 0 }).y).toBeCloseTo(min, 6);
        expect(resolveSunDirection({ sunElevationDeg: -30 }).y).toBeCloseTo(min, 6);
        expect(resolveSunDirection({ sunElevationDeg: Number.NaN }).y)
            .toBeCloseTo(Math.sin(THREE.MathUtils.degToRad(DEFAULT_SUN_ELEVATION_DEG)), 6);
    });

    it('applySunDirection re-aims the light around its target, keeping the distance', () => {
        const light = new THREE.DirectionalLight();
        light.target.position.set(10, 0, -5);
        light.position.set(10, 200, -5);              // 200 m straight up
        applySunDirection(light, { sunElevationDeg: 12, sunAzimuthDeg: 270 });
        expect(light.position.distanceTo(light.target.position)).toBeCloseTo(200, 3);
        const dir = light.position.clone().sub(light.target.position).normalize();
        expect(dir.y).toBeCloseTo(Math.sin(THREE.MathUtils.degToRad(12)), 6);
        expect(dir.x).toBeLessThan(-0.9);             // from −X
        expect(light.target.position.toArray()).toEqual([10, 0, -5]);
    });
});
