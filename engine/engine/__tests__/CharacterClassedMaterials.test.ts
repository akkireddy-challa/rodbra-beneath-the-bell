/** @jest-environment jsdom */
import * as THREE from 'three';
import { CLASSED_PART_CLASS } from 'engine/ClassedPartMaterial.js';
import { applyClassedCharacterMaterials } from 'engine/loaders/CharacterClassedMaterials.js';
import { EMISSIVE_INTENSITY } from 'engine/VoxelEmissiveMaterial.js';
import { VOXEL_MATERIAL_CLASSES } from 'engine/VoxelMaterialClass.js';

/**
 * The skinned-GLB class contract: a character GLB material named
 * `BM_slot_<class>` becomes the engine's tuned classed material at load. The
 * contracts that matter: name-only classing (honest gold PBR must stay gold,
 * not snap to metal), tier clamping, vertex-colour preservation (the whole
 * character look rides COLOR_0), authored glow over class-default glow, and
 * leaving everything unnamed — CharacterSkin, Asset Forger 'voxel' — for the
 * matte flattener exactly as before.
 */
function characterMesh(material: THREE.Material | THREE.Material[]): { root: THREE.Group; mesh: THREE.Mesh } {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
    const root = new THREE.Group();
    root.add(mesh);
    return { root, mesh };
}

function forgedMaterial(name: string, overrides: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, ...overrides });
    mat.name = name;
    return mat;
}

describe('applyClassedCharacterMaterials', () => {
    it('BM_slot_gold with honest gold PBR becomes the tuned GOLD material — name wins over the PBR snap', () => {
        // The forger writes honest PBR (metalness 0.9 / roughness 0.3) which
        // VoxelSlotAssign.declaredClass would snap to 'metal'; the hook is
        // name-only precisely so this stays gold.
        const { mesh } = characterMesh(forgedMaterial('BM_slot_gold', { metalness: 0.9, roughness: 0.3 }));
        const replaced = applyClassedCharacterMaterials(mesh.parent!, 'high');

        expect(replaced).toBe(1);
        const mat = mesh.material as THREE.MeshPhysicalMaterial;
        expect(mat).toBeInstanceOf(THREE.MeshPhysicalMaterial);
        expect(mat.userData[CLASSED_PART_CLASS]).toBe('gold');
        expect(mat.metalness).toBe(VOXEL_MATERIAL_CLASSES.gold.metalness);
        expect(mat.roughness).toBe(VOXEL_MATERIAL_CLASSES.gold.roughness);
        expect(mat.vertexColors).toBe(true);
        expect(mat.name).toBe('BM_slot_gold');
    });

    it('clamps down the quality ladder — Phong at medium, Lambert at low', () => {
        const medium = characterMesh(forgedMaterial('BM_slot_chrome'));
        applyClassedCharacterMaterials(medium.root, 'medium');
        expect(medium.mesh.material).toBeInstanceOf(THREE.MeshPhongMaterial);

        const low = characterMesh(forgedMaterial('BM_slot_chrome'));
        applyClassedCharacterMaterials(low.root, 'low');
        expect(low.mesh.material).toBeInstanceOf(THREE.MeshLambertMaterial);
        expect((low.mesh.material as THREE.Material).userData[CLASSED_PART_CLASS]).toBe('chrome');
    });

    it('disposes the material it replaces', () => {
        const source = forgedMaterial('BM_slot_leather');
        const dispose = jest.spyOn(source, 'dispose');
        const { root } = characterMesh(source);
        applyClassedCharacterMaterials(root, 'high');
        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it("leaves CharacterSkin, Asset Forger 'voxel', and non-vocabulary slot names alone", () => {
        const skin = forgedMaterial('CharacterSkin');
        const voxel = forgedMaterial('voxel');
        const headlights = forgedMaterial('BM_slot_headlights');
        const { root, mesh } = characterMesh([skin, voxel, headlights]);

        expect(applyClassedCharacterMaterials(root, 'high')).toBe(0);
        expect(mesh.material).toEqual([skin, voxel, headlights]);
    });

    it("glow comes from the GLB's own emissive, never the class default — authored dark stays dark", () => {
        // A glass part authored with zero emissive must not pick up any glow.
        const dark = characterMesh(forgedMaterial('BM_slot_glass'));
        applyClassedCharacterMaterials(dark.root, 'high');
        expect((dark.mesh.material as THREE.MeshPhysicalMaterial).emissive.getHex()).toBe(0x000000);
        expect(dark.mesh.userData.skipBloomTint).toBeUndefined();

        // An authored glow survives, scaled by the engine's full-glow intensity,
        // and the mesh opts out of the bloom tint that would overwrite it.
        const lit = characterMesh(forgedMaterial('BM_slot_gem', {
            emissive: 0xffffff,
            emissiveIntensity: 0.5,
        }));
        applyClassedCharacterMaterials(lit.root, 'high');
        const litMat = lit.mesh.material as THREE.MeshPhysicalMaterial;
        expect(litMat.emissiveIntensity).toBeCloseTo(0.5 * EMISSIVE_INTENSITY, 5);
        expect(lit.mesh.userData.skipBloomTint).toBe(true);
    });

    it('handles material arrays, replacing only the classed entries', () => {
        const skin = forgedMaterial('CharacterSkin');
        const gold = forgedMaterial('BM_slot_gold');
        const { root, mesh } = characterMesh([skin, gold]);

        expect(applyClassedCharacterMaterials(root, 'high')).toBe(1);
        const materials = mesh.material as THREE.Material[];
        expect(materials[0]).toBe(skin);
        expect(materials[1]).toBeInstanceOf(THREE.MeshPhysicalMaterial);
    });

    it('preserves transparency and sidedness postscripts', () => {
        const source = forgedMaterial('BM_slot_glass', {
            transparent: true,
            opacity: 0.6,
            side: THREE.DoubleSide,
        });
        const { root, mesh } = characterMesh(source);
        applyClassedCharacterMaterials(root, 'high');
        const mat = mesh.material as THREE.MeshPhysicalMaterial;
        expect(mat.transparent).toBe(true);
        expect(mat.opacity).toBeCloseTo(0.6, 5);
        expect(mat.side).toBe(THREE.DoubleSide);
    });

    it('is idempotent — a second pass over the same tree replaces nothing', () => {
        const { root } = characterMesh(forgedMaterial('BM_slot_metal'));
        expect(applyClassedCharacterMaterials(root, 'high')).toBe(1);
        expect(applyClassedCharacterMaterials(root, 'high')).toBe(0);
    });
});
