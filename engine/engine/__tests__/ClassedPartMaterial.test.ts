/** @jest-environment jsdom */
import * as THREE from 'three';
import {
    CLASSED_PART_CLASS,
    createClassedPartMaterial,
    isClassedPartMaterial,
} from 'engine/ClassedPartMaterial.js';
import { clearMaterialQuality, setMaterialQuality } from 'engine/MaterialQuality.js';
import * as WeaponPartMaterialModule from 'engine/WeaponPartMaterial.js';

/**
 * The neutral core extracted from WeaponPartMaterial when characters and
 * vehicle wheels joined weapons as consumers. The weapon-era behaviour is
 * pinned by WeaponPartMaterial.test.ts (which must pass UNMODIFIED — that is
 * the compat proof); this file covers what the extraction added: the
 * vertexColors/flatShading options the character paths need, the
 * self-identification predicate, and the re-export identity.
 */
describe('vertexColors and flatShading options', () => {
    it('vertexColors lands on every tier and defaults off', () => {
        for (const [cls, quality, type] of [
            ['gold', 'high', THREE.MeshPhysicalMaterial],
            ['gold', 'medium', THREE.MeshPhongMaterial],
            ['gold', 'low', THREE.MeshLambertMaterial],
        ] as const) {
            const on = createClassedPartMaterial(cls, { color: 0xffffff, vertexColors: true }, quality);
            expect(on).toBeInstanceOf(type);
            expect(on.vertexColors).toBe(true);

            const off = createClassedPartMaterial(cls, { color: 0xffffff }, quality);
            expect(off.vertexColors).toBe(false);
        }
    });

    it('flatShading lands on every tier and defaults off', () => {
        for (const quality of ['high', 'medium', 'low'] as const) {
            const flat = createClassedPartMaterial('metal', { color: 0xcccccc, flatShading: true }, quality);
            expect(flat.flatShading).toBe(true);
            const smooth = createClassedPartMaterial('metal', { color: 0xcccccc }, quality);
            expect(smooth.flatShading).toBe(false);
        }
    });
});

describe('isClassedPartMaterial', () => {
    it('recognises factory output and rejects hand-built materials', () => {
        expect(isClassedPartMaterial(createClassedPartMaterial('metal', { color: 0xcccccc }, 'high'))).toBe(true);
        expect(isClassedPartMaterial(createClassedPartMaterial('unknown', { color: 0xcccccc }, 'low'))).toBe(true);
        expect(isClassedPartMaterial(new THREE.MeshStandardMaterial({ color: 0x123456 }))).toBe(false);
        expect(isClassedPartMaterial(new THREE.MeshLambertMaterial())).toBe(false);
    });

    it('survives Material.clone() — DamageFlash clones keep their class tag', () => {
        const original = createClassedPartMaterial('gold', { color: 0xffd700 }, 'high');
        expect(isClassedPartMaterial(original.clone())).toBe(true);
    });
});

describe('omitted quality resolves the runtime tier per call', () => {
    afterEach(() => {
        clearMaterialQuality();
    });

    it("createClassedPartMaterial('metal', …) with no quality follows the stored choice", () => {
        setMaterialQuality('medium');
        expect(createClassedPartMaterial('metal', { color: 0xcccccc })).toBeInstanceOf(THREE.MeshPhongMaterial);
        setMaterialQuality('low');
        expect(createClassedPartMaterial('metal', { color: 0xcccccc })).toBeInstanceOf(THREE.MeshLambertMaterial);
    });
});

describe('WeaponPartMaterial re-export identity (frozen weapon code imports from there)', () => {
    it('functions and constants are the same objects, and the stored string is the weapon-era one', () => {
        expect(WeaponPartMaterialModule.createClassedPartMaterial).toBe(createClassedPartMaterial);
        expect(WeaponPartMaterialModule.isClassedPartMaterial).toBe(isClassedPartMaterial);
        expect(WeaponPartMaterialModule.WEAPON_PART_CLASS).toBe(CLASSED_PART_CLASS);
        expect(CLASSED_PART_CLASS).toBe('weaponPartClass');
    });
});
