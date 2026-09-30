/** @jest-environment jsdom */
import * as THREE from 'three';
import {
    AMBIENT_FLOOR_LIGHT_NAME,
    DEFAULT_AMBIENT_FLOOR,
    applyAmbientFloor,
    installAmbientFloorLight,
    resolveAmbientFloor,
} from 'engine/AmbientFloorLight.js';

/** Every light currently under the scene graph. */
function sceneLights(scene: THREE.Scene): THREE.Light[] {
    const out: THREE.Light[] = [];
    scene.traverse((o) => { if ((o as THREE.Light).isLight) out.push(o as THREE.Light); });
    return out;
}

describe('ambient floor', () => {
    describe('resolveAmbientFloor', () => {
        it('falls back to the documented default when unset', () => {
            expect(resolveAmbientFloor(undefined)).toBe(DEFAULT_AMBIENT_FLOOR);
            expect(resolveAmbientFloor(null)).toBe(DEFAULT_AMBIENT_FLOOR);
            expect(resolveAmbientFloor({})).toBe(DEFAULT_AMBIENT_FLOOR);
        });

        it('honors an explicit 0 — true blackness is a legitimate choice', () => {
            // `?? default` and `|| default` differ exactly here, and getting it
            // wrong would make total darkness impossible to author.
            expect(resolveAmbientFloor({ ambientFloor: 0 })).toBe(0);
        });

        it('honors an explicit value', () => {
            expect(resolveAmbientFloor({ ambientFloor: 0.3 })).toBe(0.3);
        });

        it('never goes negative, which would SUBTRACT light', () => {
            expect(resolveAmbientFloor({ ambientFloor: -1 })).toBe(0);
        });

        it('ignores a non-finite value rather than blacking the scene out', () => {
            expect(resolveAmbientFloor({ ambientFloor: NaN })).toBe(DEFAULT_AMBIENT_FLOOR);
        });
    });

    describe('installAmbientFloorLight', () => {
        it('adds exactly one named ambient light', () => {
            const scene = new THREE.Scene();
            const light = installAmbientFloorLight(scene);
            expect(light.name).toBe(AMBIENT_FLOOR_LIGHT_NAME);
            expect(sceneLights(scene)).toEqual([light]);
            expect(light.intensity).toBe(DEFAULT_AMBIENT_FLOOR);
        });

        it('is idempotent — the light COUNT must never change', () => {
            // Adding a light recompiles every material's shader (a 300–500 ms
            // synchronous stall on WebGPU), so re-entrant setup must reuse.
            const scene = new THREE.Scene();
            const first = installAmbientFloorLight(scene);
            const second = installAmbientFloorLight(scene);
            expect(second).toBe(first);
            expect(sceneLights(scene)).toHaveLength(1);
        });
    });

    describe('applyAmbientFloor', () => {
        it('parks the light at 0 instead of removing it when a game opts out', () => {
            const scene = new THREE.Scene();
            const light = installAmbientFloorLight(scene);
            applyAmbientFloor(scene, { ambientFloor: 0 });
            expect(light.intensity).toBe(0);
            expect(sceneLights(scene)).toHaveLength(1);
        });

        it('re-applies a new config without touching the light count', () => {
            const scene = new THREE.Scene();
            const light = installAmbientFloorLight(scene);
            applyAmbientFloor(scene, { ambientFloor: 0.25 });
            expect(light.intensity).toBe(0.25);
            applyAmbientFloor(scene, {});
            expect(light.intensity).toBe(DEFAULT_AMBIENT_FLOOR);
            expect(sceneLights(scene)).toHaveLength(1);
        });

        it('is a no-op when no floor light was installed', () => {
            const scene = new THREE.Scene();
            expect(() => applyAmbientFloor(scene, { ambientFloor: 0.2 })).not.toThrow();
        });
    });
});
