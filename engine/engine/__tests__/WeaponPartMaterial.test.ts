/** @jest-environment jsdom */
import * as THREE from 'three';
import {
    clampWeaponPartMaterialsToDirect,
    createClassedPartMaterial,
    createWeaponPartMaterial,
    WEAPON_PART_CLASS,
} from 'engine/WeaponPartMaterial.js';
import { clearMaterialQuality, setMaterialQuality } from 'engine/MaterialQuality.js';
import { defaultGlowForVoxelMaterialClass, VOXEL_MATERIAL_CLASSES } from 'engine/VoxelMaterialClass.js';
import { EMISSIVE_INTENSITY } from 'engine/VoxelEmissiveMaterial.js';
import { createWeaponMesh } from 'engine/WeaponRegistry.js';

/**
 * Classed part materials are what let a procedural weapon say 'metal' instead
 * of hand-tuning PBR numbers — and what makes weapons respect the material
 * quality ladder for the first time. The contracts that matter: the tier map
 * per quality, caller-owned albedo modulated by the class, class-derived glow,
 * unknown-name degradation (this call sits in LLM-generated code), fresh
 * instances (every consumer disposes what it owns), and the view-model clamp's
 * rebuild-from-userData round trip.
 */
describe('createClassedPartMaterial tier mapping', () => {
    it("'metal' walks Physical → Phong → Lambert down the quality ladder", () => {
        const cls = VOXEL_MATERIAL_CLASSES.metal;
        expect(cls.lighting).toBe('environment');

        const high = createClassedPartMaterial('metal', { color: 0xcccccc }, 'high');
        expect(high).toBeInstanceOf(THREE.MeshPhysicalMaterial);
        const physical = high as THREE.MeshPhysicalMaterial;
        expect(physical.metalness).toBe(cls.metalness);
        expect(physical.roughness).toBe(cls.roughness);
        expect(physical.envMapIntensity).toBe(cls.envMapIntensity);

        const medium = createClassedPartMaterial('metal', { color: 0xcccccc }, 'medium');
        expect(medium).toBeInstanceOf(THREE.MeshPhongMaterial);
        const phong = medium as THREE.MeshPhongMaterial;
        expect(phong.shininess).toBe(cls.shininess);
        expect(phong.specular.r).toBeCloseTo(cls.specular, 5);

        const low = createClassedPartMaterial('metal', { color: 0xcccccc }, 'low');
        expect(low).toBeInstanceOf(THREE.MeshLambertMaterial);
    });

    it("'wood' is Phong at high (direct tier) and Lambert at low", () => {
        expect(VOXEL_MATERIAL_CLASSES.wood.lighting).toBe('direct');
        expect(createClassedPartMaterial('wood', { color: 0x8b4513 }, 'high'))
            .toBeInstanceOf(THREE.MeshPhongMaterial);
        expect(createClassedPartMaterial('wood', { color: 0x8b4513 }, 'medium'))
            .toBeInstanceOf(THREE.MeshPhongMaterial);
        expect(createClassedPartMaterial('wood', { color: 0x8b4513 }, 'low'))
            .toBeInstanceOf(THREE.MeshLambertMaterial);
    });

    it("'matte' is Lambert at every quality", () => {
        for (const quality of ['high', 'medium', 'low'] as const) {
            expect(createClassedPartMaterial('matte', { color: 0x808080 }, quality))
                .toBeInstanceOf(THREE.MeshLambertMaterial);
        }
    });

    it('unknown class names degrade to matte Lambert instead of throwing', () => {
        const mat = createClassedPartMaterial('adamantium', { color: 0x123456 }, 'high');
        expect(mat).toBeInstanceOf(THREE.MeshLambertMaterial);
        expect(mat.userData[WEAPON_PART_CLASS]).toBe('matte');
    });

    it('every call returns a fresh instance — consumers own and dispose their materials', () => {
        const a = createClassedPartMaterial('metal', { color: 0xcccccc }, 'high');
        const b = createClassedPartMaterial('metal', { color: 0xcccccc }, 'high');
        expect(a).not.toBe(b);
    });
});

describe('albedo and glow', () => {
    it("the caller's colour is modulated by the class's albedoScale", () => {
        const gemScale = VOXEL_MATERIAL_CLASSES.gem.albedoScale;
        expect(gemScale).toBeLessThan(1);
        const gem = createClassedPartMaterial('gem', { color: 0xffffff }, 'high');
        expect(gem.color.r).toBeCloseTo(gemScale, 5);

        // Metals keep the colour untouched — it is the reflection tint.
        expect(VOXEL_MATERIAL_CLASSES.metal.albedoScale).toBe(1);
        const metal = createClassedPartMaterial('metal', { color: 0xffffff }, 'high');
        expect(metal.color.r).toBeCloseTo(1, 5);
    });

    it("'neon' glows by default, tinted by the part's own colour; 'metal' does not", () => {
        const defaultGlow = defaultGlowForVoxelMaterialClass('neon') / 255;
        expect(defaultGlow).toBeGreaterThan(0);

        const neon = createClassedPartMaterial('neon', { color: 0xff0000 }, 'high');
        expect(neon.emissiveIntensity).toBeCloseTo(defaultGlow * EMISSIVE_INTENSITY, 5);
        expect(neon.emissive.getHex()).toBe(0xff0000);

        const metal = createClassedPartMaterial('metal', { color: 0xff0000 }, 'high');
        expect(metal.emissive.getHex()).toBe(0x000000);
    });

    it('an explicit glow overrides the class default, and glow 0 silences a glowing class', () => {
        const tuned = createClassedPartMaterial('neon', { color: 0x00ff00, glow: 0.5 }, 'high');
        expect(tuned.emissiveIntensity).toBeCloseTo(0.5 * EMISSIVE_INTENSITY, 5);

        const silenced = createClassedPartMaterial('neon', { color: 0x00ff00, glow: 0 }, 'high');
        expect(silenced.emissive.getHex()).toBe(0x000000);
    });

    it('the glow survives every tier — a lightsaber blade still glows on low', () => {
        const low = createClassedPartMaterial('neon', { color: 0x00ff00, glow: 5 / 3 }, 'low');
        expect(low).toBeInstanceOf(THREE.MeshLambertMaterial);
        expect(low.emissiveIntensity).toBeCloseTo(5, 5);
    });
});

describe('clampWeaponPartMaterialsToDirect (the view-model clamp)', () => {
    /** Clamp a one-mesh view model and hand back whatever material it ended up with. */
    function clampMaterial(material: THREE.Material): THREE.Material {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
        const root = new THREE.Group();
        root.add(mesh);
        clampWeaponPartMaterialsToDirect(root);
        return mesh.material as THREE.Material;
    }

    it('rebuilds tagged environment-tier parts as Phong with the class parameters', () => {
        const chrome = createClassedPartMaterial('chrome', { color: 0x888888 }, 'high');
        expect(chrome).toBeInstanceOf(THREE.MeshPhysicalMaterial);

        const clamped = clampMaterial(chrome);
        expect(clamped).toBeInstanceOf(THREE.MeshPhongMaterial);
        const phong = clamped as THREE.MeshPhongMaterial;
        expect(phong.shininess).toBe(VOXEL_MATERIAL_CLASSES.chrome.shininess);
        expect(phong.userData[WEAPON_PART_CLASS]).toBe('chrome');
    });

    it('preserves caller transparency postscripts across the rebuild', () => {
        const glass = createClassedPartMaterial('glass', { color: 0x333333 }, 'high');
        glass.transparent = true;
        glass.opacity = 0.7;

        const rebuilt = clampMaterial(glass);
        expect(rebuilt).not.toBe(glass);
        expect(rebuilt.transparent).toBe(true);
        expect(rebuilt.opacity).toBeCloseTo(0.7, 5);
    });

    it('leaves untagged materials (old-style hand-tuned customs) exactly alone', () => {
        const legacy = new THREE.MeshStandardMaterial({ color: 0x123456, metalness: 0.9 });
        expect(clampMaterial(legacy)).toBe(legacy);
    });

    it('leaves already-clamped tiers alone — a Phong or Lambert part is not rebuilt', () => {
        const phong = createClassedPartMaterial('metal', { color: 0x444444 }, 'medium');
        expect(clampMaterial(phong)).toBe(phong);
    });
});

describe('built-in weapons ride the quality ladder', () => {
    afterEach(() => {
        clearMaterialQuality();
    });

    function materialsOf(mesh: THREE.Group): THREE.Material[] {
        const out: THREE.Material[] = [];
        mesh.traverse((child) => {
            const asMesh = child as THREE.Mesh;
            if (!asMesh.isMesh) return;
            const mats = Array.isArray(asMesh.material) ? asMesh.material : [asMesh.material];
            out.push(...mats);
        });
        return out;
    }

    it("the sword's blade is Physical at high and nothing is MeshStandardMaterial any more", () => {
        setMaterialQuality('high');
        const { mesh } = createWeaponMesh('sword');
        const materials = materialsOf(mesh);
        expect(materials.length).toBeGreaterThan(0);
        expect(materials.some((m) => m instanceof THREE.MeshPhysicalMaterial)).toBe(true);
        // `type`, not instanceof — MeshPhysicalMaterial EXTENDS MeshStandardMaterial,
        // so instanceof would flag the classed blade itself.
        expect(materials.some((m) => m.type === 'MeshStandardMaterial')).toBe(false);
    });

    it('at low, every sword part renders Lambert — the hard opt-out', () => {
        setMaterialQuality('low');
        const { mesh } = createWeaponMesh('sword');
        const materials = materialsOf(mesh);
        expect(materials.length).toBeGreaterThan(0);
        expect(materials.every((m) => m instanceof THREE.MeshLambertMaterial)).toBe(true);
    });

    it("createWeaponPartMaterial resolves the stored quality per call — an equip after setMaterialQuality('medium') builds Phong", () => {
        setMaterialQuality('medium');
        const mat = createWeaponPartMaterial('metal', { color: 0xcccccc });
        expect(mat).toBeInstanceOf(THREE.MeshPhongMaterial);
    });
});
