import * as THREE from 'three';
import { RealisticCharacter, type RealisticCharacterOptions } from 'engine/hero/RealisticCharacter.js';
import { SkinAppearanceState } from 'engine/hero/SkinAppearanceState.js';
import { setActiveRendererType } from 'engine/RendererType.js';

function options(): RealisticCharacterOptions {
    return { resolveTexture: async () => new THREE.Texture(), environment: null,
        environmentIntensity: .6, detailEnabled: true, transmission: undefined, appearance: new SkinAppearanceState() };
}
beforeEach(() => setActiveRendererType('webgl'));

test('adoption preserves untagged materials and restores authored skin on disposal', async () => {
    const root = new THREE.Group(), skin = new THREE.MeshPhysicalMaterial(), armor = new THREE.MeshPhysicalMaterial();
    skin.userData.characterSurface = 'skin';
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), [skin, armor]); root.add(mesh);
    const actor = await RealisticCharacter.create(root, options());
    expect(mesh.material[0]).not.toBe(skin); expect(mesh.material[1]).toBe(armor);
    await expect(RealisticCharacter.create(root, options())).rejects.toThrow('already adopted');
    actor.dispose(); actor.dispose(); expect(mesh.material).toEqual([skin, armor]);
    const again = await RealisticCharacter.create(root, options()); again.dispose();
});

test('failed texture resolution leaves the model unchanged and allows retry', async () => {
    const material = new THREE.MeshPhysicalMaterial(); material.userData.characterSurface = 'skin';
    Object.assign(material.userData, { skinAtlasTexture: 3, skinExpressionTexture: 4, skinMicroDetail: true, skinAtlasHeightRangeM: .001 });
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('_face_uv', new THREE.Float32BufferAttribute([0, 0], 2));
    geometry.setAttribute('_face_weight', new THREE.Float32BufferAttribute([1], 1));
    const root = new THREE.Mesh(geometry, material);
    await expect(RealisticCharacter.create(root, { ...options(), resolveTexture: async () => { throw new Error('missing map'); } })).rejects.toThrow('missing map');
    expect(root.material).toBe(material);
    const actor = await RealisticCharacter.create(root, { ...options(), detailEnabled: false });
    expect(material.userData.skinMicroDetail).toBe(true); expect(actor.detailTextures.size).toBe(2);
    actor.dispose(); expect(root.material).toBe(material);
});

test('missing required UV attributes fails before replacing materials', async () => {
    const material = new THREE.MeshPhysicalMaterial(); material.userData.skinAtlasTexture = 0;
    const root = new THREE.Mesh(new THREE.BufferGeometry(), material);
    await expect(RealisticCharacter.create(root, options())).rejects.toThrow('_face_uv');
    expect(root.material).toBe(material);
});

test('independent facial detail validates its layout and adopts all maps without losing body coverage', async () => {
    const material = new THREE.MeshPhysicalMaterial();
    Object.assign(material.userData, { characterSurface: 'skin', skinSurfaceBlend: true, skinMicroDetail: true,
        skinAtlasTexture: 0, skinExpressionTexture: 1, skinFacialAtlasTexture: 2, skinAtlasHeightRangeM: .0006 });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('_face_uv', new THREE.Float32BufferAttribute([.3, .4], 2));
    geometry.setAttribute('_face_weight', new THREE.Float32BufferAttribute([1], 1));
    const root = new THREE.Mesh(geometry, material);
    await expect(RealisticCharacter.create(root, options())).rejects.toThrow('packed layout');
    material.userData.skinFacialAtlasLayout = 'detail-expression-halves-v1';
    await expect(RealisticCharacter.create(root, options())).rejects.toThrow('_facial_detail');
    geometry.setAttribute('_facial_detail', new THREE.Float32BufferAttribute([.5, .6, .8], 3));
    const actor = await RealisticCharacter.create(root, { ...options(), detailEnabled: false });
    expect(actor.detailTextures.size).toBe(3);
    expect(root.material.userData.skinSurfaceBlend).toBe(true);
    expect(material.userData.skinMicroDetail).toBe(true);
    actor.dispose(); expect(root.material).toBe(material);
});

test('regional additive height requires a valid face rectangle and preserves legacy assets', async () => {
    const material = new THREE.MeshPhysicalMaterial();
    Object.assign(material.userData, { characterSurface: 'skin', skinSurfaceBlend: true, skinMicroDetail: true,
        skinAtlasTexture: 0, skinExpressionTexture: 1, skinFacialAtlasTexture: 2, skinAtlasHeightRangeM: .0006,
        skinFacialAtlasLayout: 'detail-expression-halves-v1', skinRegionalAtlasHeightMode: 'additive-v1' });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('_face_uv', new THREE.Float32BufferAttribute([.3, .4], 2));
    geometry.setAttribute('_face_weight', new THREE.Float32BufferAttribute([1], 1));
    geometry.setAttribute('_facial_detail', new THREE.Float32BufferAttribute([.5, .9, 1], 3));
    const root = new THREE.Mesh(geometry, material);
    await expect(RealisticCharacter.create(root, options())).rejects.toThrow('valid top-row face rectangle');
    expect(root.material).toBe(material);
    material.userData.skinFacialAtlasRegion = [0, 0, 1, .8];
    const actor = await RealisticCharacter.create(root, options());
    expect(actor.detailTextures.size).toBe(3);
    actor.dispose(); expect(root.material).toBe(material);
    delete material.userData.skinRegionalAtlasHeightMode;
    delete material.userData.skinFacialAtlasRegion;
    const legacy = await RealisticCharacter.create(root, options()); legacy.dispose();
});
