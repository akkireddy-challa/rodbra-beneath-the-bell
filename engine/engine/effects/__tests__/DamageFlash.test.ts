/**
 * DamageFlash swaps a target's materials for flash clones and puts the
 * originals back. Block characters wear CACHE-OWNED materials
 * (userData.__sharedLodCache), so two things must hold: a flash clone never
 * inherits the flag (clone() deep-copies userData), and restore disposes only
 * what the flash created — never an original it merely handed back.
 */
import * as THREE from 'three';
import { DamageFlash } from 'engine/effects/DamageFlash.js';

function sharedLambert(): THREE.MeshLambertMaterial {
    const mat = new THREE.MeshLambertMaterial({ color: 0x8844aa });
    mat.userData.__sharedLodCache = true;
    return mat;
}

function meshWith(material: THREE.Material): THREE.Mesh {
    return new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
}

describe('DamageFlash on cache-owned materials', () => {
    test('the flash clone drops the shared-cache flag and the original is untouched', () => {
        const shared = sharedLambert();
        const mesh = meshWith(shared);
        const flash = new DamageFlash(mesh);

        flash.trigger();

        const flashMat = mesh.material as THREE.MeshLambertMaterial;
        expect(flashMat).not.toBe(shared);
        expect(flashMat.userData.__sharedLodCache).toBeUndefined();
        expect(shared.userData.__sharedLodCache).toBe(true);
        expect(shared.emissive.getHex()).toBe(0x000000);
        flash.dispose();
    });

    test('restore disposes the clone and reinstalls the original', () => {
        const shared = sharedLambert();
        const mesh = meshWith(shared);
        const flash = new DamageFlash(mesh);
        const sharedDispose = jest.spyOn(shared, 'dispose');

        flash.trigger();
        const clone = mesh.material as THREE.Material;
        const cloneDispose = jest.spyOn(clone, 'dispose');
        flash.restoreImmediately();

        expect(mesh.material).toBe(shared);
        expect(cloneDispose).toHaveBeenCalledTimes(1);
        expect(sharedDispose).not.toHaveBeenCalled();
    });

    test('an original handed back unflashed is never disposed on restore', () => {
        // ShaderMaterial has no emissive and is neither Basic nor Lambert, so
        // cloneWithFlash returns it as is.
        const shader = new THREE.ShaderMaterial();
        const mesh = meshWith(shader);
        const flash = new DamageFlash(mesh);
        const dispose = jest.spyOn(shader, 'dispose');

        flash.trigger();
        expect(mesh.material).toBe(shader);
        flash.restoreImmediately();

        expect(mesh.material).toBe(shader);
        expect(dispose).not.toHaveBeenCalled();
    });
});
