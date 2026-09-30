/** @jest-environment jsdom */
import * as THREE from 'three';
import { clearMaterialQuality, setMaterialQuality } from 'engine/MaterialQuality.js';
import { MaterialCache } from 'engine/MaterialCache.js';

/**
 * The class-keyed cache API beside the legacy numeric one: getClassed rides
 * the quality ladder (with the tier in the key, so a mid-session ?matq=
 * change can never alias tiers), shares one instance per key, and the legacy
 * get/getBasic behaviour stays byte-compatible for shipped game code.
 */
afterEach(() => {
    clearMaterialQuality();
});

describe('getClassed', () => {
    it('rides the quality ladder — metal is Physical at high, Phong at medium, Lambert at low', () => {
        const cache = new MaterialCache();
        setMaterialQuality('high');
        expect(cache.getClassed('metal', 0x8899aa)).toBeInstanceOf(THREE.MeshPhysicalMaterial);
        setMaterialQuality('medium');
        expect(cache.getClassed('metal', 0x8899aa)).toBeInstanceOf(THREE.MeshPhongMaterial);
        setMaterialQuality('low');
        expect(cache.getClassed('metal', 0x8899aa)).toBeInstanceOf(THREE.MeshLambertMaterial);
        cache.dispose();
    });

    it('shares one instance per (class, colour, quality) — and never across qualities', () => {
        const cache = new MaterialCache();
        setMaterialQuality('high');
        const a = cache.getClassed('gold', 0xffd700);
        expect(cache.getClassed('gold', 0xffd700)).toBe(a);

        setMaterialQuality('low');
        expect(cache.getClassed('gold', 0xffd700)).not.toBe(a);
        expect(cache.size).toBe(2);
        cache.dispose();
    });

    it('applies transparency postscripts and keeps them in the key', () => {
        const cache = new MaterialCache();
        setMaterialQuality('high');
        const glass = cache.getClassed('glass', 0x88ccff, { transparent: true, opacity: 0.4 });
        expect(glass.transparent).toBe(true);
        expect(glass.opacity).toBeCloseTo(0.4, 5);
        expect(cache.getClassed('glass', 0x88ccff)).not.toBe(glass);
        cache.dispose();
    });

    it('dispose() clears classed materials too', () => {
        const cache = new MaterialCache();
        setMaterialQuality('high');
        const mat = cache.getClassed('metal', 0xcccccc);
        const dispose = jest.spyOn(mat, 'dispose');
        cache.dispose();
        expect(dispose).toHaveBeenCalledTimes(1);
        expect(cache.size).toBe(0);
    });
});

describe('legacy API stays byte-compatible for shipped game code', () => {
    it('get() still returns a cached MeshStandardMaterial with the exact old defaults', () => {
        const cache = new MaterialCache();
        const mat = cache.get(0xff0000);
        expect(mat).toBeInstanceOf(THREE.MeshStandardMaterial);
        expect(mat.roughness).toBeCloseTo(0.45, 5);
        expect(mat.metalness).toBe(0);
        expect(cache.get(0xff0000)).toBe(mat);
        expect(cache.get(0xff0000, { roughness: 0.2 })).not.toBe(mat);
        cache.dispose();
    });

    it('getBasic() still returns a cached MeshBasicMaterial', () => {
        const cache = new MaterialCache();
        const mat = cache.getBasic(0xffffff, { transparent: true, opacity: 0.5 });
        expect(mat).toBeInstanceOf(THREE.MeshBasicMaterial);
        expect(cache.getBasic(0xffffff, { transparent: true, opacity: 0.5 })).toBe(mat);
        cache.dispose();
    });
});
