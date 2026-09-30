/** @jest-environment jsdom */
import * as THREE from 'three';
import { PointLightPool, DEFAULT_POINT_LIGHT_POOL_OPTIONS } from 'engine/PointLightPool.js';

/** All PointLights currently under the scene graph. */
function sceneLights(scene: THREE.Scene): THREE.PointLight[] {
    const out: THREE.PointLight[] = [];
    scene.traverse((o) => { if ((o as THREE.PointLight).isPointLight) out.push(o as THREE.PointLight); });
    return out;
}

/** `count` sources laid out along +X at x = 1, 2, 3, … (distinct distances from origin). */
function lineSources(count: number, intensity = 5): Array<{ position: THREE.Vector3; color: THREE.Color; intensity: number; distance: number; decay: number }> {
    return Array.from({ length: count }, (_, i) => ({
        position: new THREE.Vector3(i + 1, 0, 0),
        color: new THREE.Color(0xffffff),
        intensity,
        distance: 32,
        decay: 2,
    }));
}

describe('PointLightPool — constant light count (WebGPU recompile guard)', () => {
    it('creates exactly poolSize lights, all visible, and never changes the count', () => {
        const scene = new THREE.Scene();
        const pool = new PointLightPool(scene, { ...DEFAULT_POINT_LIGHT_POOL_OPTIONS, poolSize: 4, focusFromCamera: false });
        pool.setSources(lineSources(100));

        expect(sceneLights(scene)).toHaveLength(4);
        expect(sceneLights(scene).every((l) => l.visible)).toBe(true);

        // Walk the focus across the whole line of sources — the count must stay 4.
        for (let x = 0; x <= 100; x += 7) {
            pool.aimAt(new THREE.Vector3(x, 0, 0));
            const lights = sceneLights(scene);
            expect(lights).toHaveLength(4);
            expect(lights.every((l) => l.visible)).toBe(true);
        }
    });

    it('lights the nearest poolSize sources', () => {
        const scene = new THREE.Scene();
        const pool = new PointLightPool(scene, { ...DEFAULT_POINT_LIGHT_POOL_OPTIONS, poolSize: 3, focusFromCamera: false });
        pool.setSources(lineSources(10)); // sources at x = 1..10

        pool.aimAt(new THREE.Vector3(0, 0, 0)); // nearest 3 are x = 1, 2, 3

        const litX = sceneLights(scene)
            .filter((l) => l.intensity > 0)
            .map((l) => l.position.x)
            .sort((a, b) => a - b);
        expect(litX).toEqual([1, 2, 3]);
    });

    it('parks spare slots at intensity 0 (still visible) when fewer sources than slots', () => {
        const scene = new THREE.Scene();
        const pool = new PointLightPool(scene, { ...DEFAULT_POINT_LIGHT_POOL_OPTIONS, poolSize: 4, focusFromCamera: false });
        pool.setSources(lineSources(2));

        pool.aimAt(new THREE.Vector3(0, 0, 0));

        const lights = sceneLights(scene);
        expect(lights).toHaveLength(4);
        expect(lights.every((l) => l.visible)).toBe(true);
        expect(lights.filter((l) => l.intensity > 0)).toHaveLength(2); // two real sources
        expect(lights.filter((l) => l.intensity === 0)).toHaveLength(2); // two parked slots
    });

    it('handles zero sources without removing lights', () => {
        const scene = new THREE.Scene();
        const pool = new PointLightPool(scene, { ...DEFAULT_POINT_LIGHT_POOL_OPTIONS, poolSize: 3, focusFromCamera: false });
        pool.setSources([]);

        pool.aimAt(new THREE.Vector3(0, 0, 0));

        const lights = sceneLights(scene);
        expect(lights).toHaveLength(3);
        expect(lights.every((l) => l.visible && l.intensity === 0)).toBe(true);
    });

    it('keeps a slot on its source under hysteresis when a rival is only marginally closer', () => {
        const scene = new THREE.Scene();
        const pool = new PointLightPool(scene, { ...DEFAULT_POINT_LIGHT_POOL_OPTIONS, poolSize: 1, focusFromCamera: false, reassignHysteresis: 2 });
        const a = { position: new THREE.Vector3(0, 0, 0), color: new THREE.Color(0xff0000), intensity: 5, distance: 32, decay: 2 };
        const b = { position: new THREE.Vector3(10, 0, 0), color: new THREE.Color(0x00ff00), intensity: 5, distance: 32, decay: 2 };
        pool.setSources([a, b]);

        pool.aimAt(new THREE.Vector3(0, 0, 0)); // a is nearest → slot holds a (red)
        expect(sceneLights(scene)[0]!.color.getHex()).toBe(0xff0000);

        // Move focus so b is closer by 1m (< hysteresis of 2m): slot should STAY on a.
        pool.aimAt(new THREE.Vector3(5.5, 0, 0));
        expect(sceneLights(scene)[0]!.color.getHex()).toBe(0xff0000);

        // Move clearly past b (closer by > hysteresis): slot swaps to b (green).
        pool.aimAt(new THREE.Vector3(9, 0, 0));
        expect(sceneLights(scene)[0]!.color.getHex()).toBe(0x00ff00);
    });

    it('dispose removes all pool lights from the scene', () => {
        const scene = new THREE.Scene();
        const pool = new PointLightPool(scene, { ...DEFAULT_POINT_LIGHT_POOL_OPTIONS, poolSize: 4, focusFromCamera: false });
        pool.setSources(lineSources(5));
        pool.aimAt(new THREE.Vector3(0, 0, 0));
        expect(sceneLights(scene)).toHaveLength(4);

        pool.dispose();
        expect(sceneLights(scene)).toHaveLength(0);
    });
});
