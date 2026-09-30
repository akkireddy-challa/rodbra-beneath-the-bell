import * as THREE from 'three';
import { skinPoreTexture } from 'engine/hero/SkinMicroDetail.js';
import { createCharacterSurfaceMaterial } from 'engine/hero/CharacterSurfaceMaterials.js';
import { setActiveRendererType } from 'engine/RendererType.js';

test('pore data is shared, linear and mipmapped for distant minification', () => {
    const texture = skinPoreTexture();
    expect(skinPoreTexture()).toBe(texture);
    expect(texture.colorSpace).toBe(THREE.NoColorSpace);
    expect(texture.wrapS).toBe(THREE.RepeatWrapping);
    expect(texture.generateMipmaps).toBe(true);
    const bytes = texture.image.data as Uint8Array;
    let depressions = 0;
    for (let i = 0; i < bytes.length; i += 4) if (bytes[i]! < 115) depressions++;
    expect(depressions).toBeGreaterThan(10000);
    expect(depressions).toBeLessThan(texture.image.width * texture.image.height / 2);
});

test('detail is explicitly opt-in and preserves the base atlas', () => {
    setActiveRendererType('webgl');
    const source = new THREE.MeshPhysicalMaterial();
    source.userData = { characterSurface: 'skin', skinMicroDetail: true };
    source.normalMap = new THREE.Texture();
    const material = createCharacterSurfaceMaterial(source) as THREE.MeshPhysicalMaterial;
    expect(material.normalMap).toBe(source.normalMap);
    expect(material.customProgramCacheKey()).toBe('character-skin-micro-v1');
    expect(source.customProgramCacheKey()).not.toBe('character-skin-micro-v1');
});
