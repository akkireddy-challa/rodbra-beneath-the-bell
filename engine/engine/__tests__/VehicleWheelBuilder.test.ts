/** @jest-environment jsdom */
import * as THREE from 'three';
import { buildParametricWheelMesh } from 'engine/renderers/VehicleWheelBuilder.js';
import { WEAPON_PART_CLASS } from 'engine/WeaponPartMaterial.js';
import { clearMaterialQuality, setMaterialQuality } from 'engine/MaterialQuality.js';

/**
 * Parametric wheels were the last vehicle-path surface built from hand-tuned
 * MeshStandardMaterial — full PBR + IBL on every device. They now ride the
 * material-class ladder like weapon parts: chrome/metal rims from classed
 * materials, quality-clamped per the stored MaterialQuality.
 */
function materialsOf(root: THREE.Object3D): THREE.Material[] {
    const out: THREE.Material[] = [];
    root.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        // Skip transform-only nodes — a dual-wheel root draws nothing and its
        // shared placeholder material is not a wheel part.
        const position = mesh.geometry.getAttribute('position');
        if (!position || position.count === 0) return;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        out.push(...mats);
    });
    return out;
}

describe('parametric wheels ride the material-class ladder', () => {
    afterEach(() => {
        clearMaterialQuality();
    });

    it('a moon wheel is chrome-classed at high, and no part is MeshStandardMaterial', () => {
        setMaterialQuality('high');
        const wheel = buildParametricWheelMesh({ radius: 0.35, width: 0.24, style: 'moon', dual: false });
        const mats = materialsOf(wheel);
        expect(mats.length).toBeGreaterThan(0);
        expect(mats.some((m) => m.userData[WEAPON_PART_CLASS] === 'chrome')).toBe(true);
        expect(mats.every((m) => typeof m.userData[WEAPON_PART_CLASS] === 'string')).toBe(true);
        // `type`, not instanceof — MeshPhysicalMaterial EXTENDS MeshStandardMaterial.
        expect(mats.some((m) => m.type === 'MeshStandardMaterial')).toBe(false);
    });

    it('at low, every part of a dual alloy wheel renders Lambert', () => {
        setMaterialQuality('low');
        const wheel = buildParametricWheelMesh({ radius: 0.4, width: 0.3, style: 'alloy5', dual: true });
        const mats = materialsOf(wheel);
        expect(mats.length).toBeGreaterThan(0);
        expect(mats.every((m) => m instanceof THREE.MeshLambertMaterial)).toBe(true);
    });

    it('materials are shared per (class, colour) within one wheel build', () => {
        setMaterialQuality('high');
        const wheel = buildParametricWheelMesh({ radius: 0.4, width: 0.3, style: 'alloy6', dual: false });
        const mats = materialsOf(wheel);
        expect(new Set(mats).size).toBeLessThan(mats.length);
    });
});
