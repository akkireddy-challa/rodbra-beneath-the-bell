import * as THREE from 'three';
import { applyBloomTint, clearBloomTint } from 'engine/effects/BloomTint.js';

function meshWith(material: THREE.MeshStandardMaterial): THREE.Mesh {
    return new THREE.Mesh(new THREE.BufferGeometry(), material);
}

describe('applyBloomTint', () => {
    it('tints an unlit material toward its diffuse colour', () => {
        const mat = new THREE.MeshStandardMaterial({ color: 0x804000 });
        applyBloomTint(meshWith(mat));
        expect(mat.emissive.getHex()).not.toBe(0x000000);
        expect(mat.emissiveIntensity).toBe(1);
    });

    it('leaves a material that stores its look on the emissive channel alone', () => {
        const mat = new THREE.MeshStandardMaterial({ color: 0x000000 });
        mat.emissiveMap = new THREE.Texture();
        mat.emissive.setRGB(1, 1, 1);
        applyBloomTint(meshWith(mat));
        expect(mat.emissive.getHex()).toBe(0xffffff);
    });

    it('leaves an authored glow alone', () => {
        const mat = new THREE.MeshStandardMaterial({ color: 0x223344 });
        mat.emissive.setHex(0x00ff00);
        applyBloomTint(meshWith(mat));
        expect(mat.emissive.getHex()).toBe(0x00ff00);
    });

    it('re-tints its own previous tint when applied again', () => {
        const mat = new THREE.MeshStandardMaterial({ color: 0xffffff });
        const mesh = meshWith(mat);
        applyBloomTint(mesh);
        mat.color.setHex(0x000000);
        applyBloomTint(mesh);
        expect(mat.emissive.getHex()).toBe(0x000000);
    });

    it('honours the per-mesh opt-out', () => {
        const mat = new THREE.MeshStandardMaterial({ color: 0xffffff });
        const mesh = meshWith(mat);
        mesh.userData.skipBloomTint = true;
        applyBloomTint(mesh);
        expect(mat.emissive.getHex()).toBe(0x000000);
    });
});

describe('clearBloomTint', () => {
    it('clears emission the tint wrote', () => {
        const mat = new THREE.MeshStandardMaterial({ color: 0x804000 });
        applyBloomTint(meshWith(mat));
        expect(clearBloomTint(mat)).toBe(true);
        expect(mat.emissive.getHex()).toBe(0x000000);
    });

    it('leaves an untinted material untouched', () => {
        const mat = new THREE.MeshStandardMaterial({ color: 0x000000 });
        mat.emissive.setRGB(1, 1, 1);
        expect(clearBloomTint(mat)).toBe(false);
        expect(mat.emissive.getHex()).toBe(0xffffff);
    });

    it('leaves a runtime emissive written after the tint untouched', () => {
        const mat = new THREE.MeshStandardMaterial({ color: 0x804000 });
        applyBloomTint(meshWith(mat));
        mat.emissive.setHex(0xff0000); // DamageFlash
        expect(clearBloomTint(mat)).toBe(false);
        expect(mat.emissive.getHex()).toBe(0xff0000);
    });
});
