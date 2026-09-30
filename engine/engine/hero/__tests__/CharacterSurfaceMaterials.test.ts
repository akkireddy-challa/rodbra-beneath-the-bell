import * as THREE from 'three';
import { createCharacterSurfaceMaterial } from 'engine/hero/CharacterSurfaceMaterials.js';
import { setActiveRendererType } from 'engine/RendererType.js';

beforeEach(() => setActiveRendererType('webgl'));

test('unassigned armor and clothing retain the exact material object', () => {
    const armor = new THREE.MeshPhysicalMaterial({ metalness: 1, roughness: 0.3 });
    armor.name = 'skin-colored-armor';
    expect(createCharacterSurfaceMaterial(armor)).toBe(armor);
});

test('explicit skin preserves albedo and authored roughness maps without mutating the source', () => {
    const source = new THREE.MeshPhysicalMaterial({ metalness: 0.4 });
    source.userData.characterSurface = 'skin';
    source.map = new THREE.Texture();
    source.roughnessMap = new THREE.Texture();
    source.specularColor.setRGB(2, 2, 2);
    const skin = createCharacterSurfaceMaterial(source) as THREE.MeshPhysicalMaterial;
    expect(skin.map).toBe(source.map);
    expect(skin.roughnessMap).toBe(source.roughnessMap);
    expect(skin.metalness).toBe(0);
    expect(skin.clearcoat).toBe(0);
    expect(skin.defines).toHaveProperty('PHYSICAL');
    expect(source.metalness).toBe(0.4);
    expect(source.specularColor.r).toBe(2);
});

test('hair preserves the baked comb flow map rather than imposing atlas-wide rotation', () => {
    const source = new THREE.MeshPhysicalMaterial({ anisotropy: 0.65, anisotropyRotation: 0.2 });
    source.userData.characterSurface = 'hair';
    source.anisotropyMap = new THREE.Texture();
    source.sheenColor.setRGB(0.025, 0.025, 0.025);
    const hair = createCharacterSurfaceMaterial(source) as THREE.MeshPhysicalMaterial;
    expect(hair.anisotropyMap).toBe(source.anisotropyMap);
    expect(hair.anisotropyRotation).toBe(0.2);
    expect(hair.metalness).toBe(0);
    expect(hair.defines).toHaveProperty('PHYSICAL');
    expect(hair.sheenColor.equals(source.sheenColor)).toBe(true);
});
