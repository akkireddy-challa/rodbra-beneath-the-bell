/** @jest-environment jsdom */
import * as THREE from 'three';
import { clearMaterialQuality, setMaterialQuality } from 'engine/MaterialQuality.js';
import { CLASSED_PART_CLASS } from 'engine/ClassedPartMaterial.js';
import { createArrowMesh, createLaserBeamMesh, createRocketMesh } from 'engine/RangedWeaponMeshes.js';
import { BlockAnimalBodyBuilder } from 'engine/animal/BlockAnimalBodyBuilder.js';
import { SnakeBodyBuilder } from 'engine/animal/SnakeBodyBuilder.js';

/**
 * Animals and projectile meshes on the material-class ladder: bodies say
 * 'fur'/'leather' and eyes say 'gem' instead of hand-tuned PBR numbers, and
 * projectiles reuse the weapon vocabulary (wood shaft, metal head, neon
 * energy). The contracts: every material is class-tagged, glow levels
 * reproduce the pre-class emissive intensities exactly, and low quality
 * renders everything Lambert.
 */
afterEach(() => {
    clearMaterialQuality();
});

function materialsOf(root: THREE.Object3D): THREE.Material[] {
    const out: THREE.Material[] = [];
    root.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        out.push(...(Array.isArray(child.material) ? child.material : [child.material]));
    });
    return out;
}

const classOf = (m: THREE.Material): unknown => m.userData[CLASSED_PART_CLASS];

describe('projectile meshes', () => {
    it('the arrow is wood/metal/cloth — and nothing is MeshStandardMaterial any more', () => {
        setMaterialQuality('high');
        const materials = materialsOf(createArrowMesh(0.05, 0xcccccc));
        const classes = new Set(materials.map(classOf));
        expect(classes).toEqual(new Set(['wood', 'metal', 'cloth']));
        // `type`, not instanceof — Physical EXTENDS Standard.
        expect(materials.some((m) => m.type === 'MeshStandardMaterial')).toBe(false);
        expect(materials.some((m) => m instanceof THREE.MeshPhysicalMaterial)).toBe(true);
    });

    it('energy bolts keep their exact pre-class glow (emissiveIntensity 5.0 for the laser)', () => {
        setMaterialQuality('high');
        const beam = materialsOf(createLaserBeamMesh(0.05, 0x00ff88))[0] as THREE.MeshPhysicalMaterial;
        expect(classOf(beam)).toBe('neon');
        expect(beam.emissiveIntensity).toBeCloseTo(5.0, 5);
        expect(beam.emissive.getHex()).toBe(0x00ff88);
    });

    it("the rocket's flame keeps its authored off-hue emissive and transparency", () => {
        setMaterialQuality('high');
        const materials = materialsOf(createRocketMesh(0.1, 0xff3300));
        const fire = materials.find(
            (m): m is THREE.MeshPhysicalMaterial => m.transparent && Math.abs(m.opacity - 0.9) < 1e-6,
        )!;
        expect(fire).toBeDefined();
        expect(classOf(fire)).toBe('neon');
        expect(fire.emissive.getHex()).toBe(0xffaa00);
        expect(fire.emissiveIntensity).toBeCloseTo(5.0, 5);
        expect(materials.some((m) => classOf(m) === 'metal')).toBe(true); // fins
    });

    it('at low quality every projectile part renders Lambert — glow included', () => {
        setMaterialQuality('low');
        for (const root of [createArrowMesh(0.05, 0xcccccc), createRocketMesh(0.1, 0xff3300)]) {
            const materials = materialsOf(root);
            expect(materials.length).toBeGreaterThan(0);
            expect(materials.every((m) => m instanceof THREE.MeshLambertMaterial)).toBe(true);
        }
        const beam = materialsOf(createLaserBeamMesh(0.05, 0x00ff88))[0] as THREE.MeshLambertMaterial;
        expect(beam).toBeInstanceOf(THREE.MeshLambertMaterial);
        expect(beam.emissiveIntensity).toBeCloseTo(5.0, 5);
    });
});

describe('animal bodies', () => {
    const block = (color: number) => ({
        size: { width: 0.4, height: 0.3, depth: 0.6 },
        position: { y: 0.3 },
        color,
    });

    it('block animals are fur with the matte/plastic/gem eye triple', () => {
        setMaterialQuality('high');
        const group = new THREE.Group();
        BlockAnimalBodyBuilder.buildAnimal(group, {
            bodyBlocks: [block(0x8b5a2b)],
            headBlocks: [block(0x6b4423)],
        });
        const classes = new Set(materialsOf(group).map(classOf));
        expect(classes.has('fur')).toBe(true);
        expect(classes.has('gem')).toBe(true);     // pupils
        expect(classes.has('plastic')).toBe(true); // sclera
        expect(classes.has(undefined)).toBe(false); // nothing untagged remains
    });

    it('snakes are leather-scaled, and low quality collapses everything to Lambert', () => {
        setMaterialQuality('high');
        const highGroup = new THREE.Group();
        SnakeBodyBuilder.buildSnake(highGroup, { headColor: 0x2f6f2f, bodyColor: 0x3f8f3f });
        expect(new Set(materialsOf(highGroup).map(classOf)).has('leather')).toBe(true);

        setMaterialQuality('low');
        const lowGroup = new THREE.Group();
        SnakeBodyBuilder.buildSnake(lowGroup, { headColor: 0x2f6f2f, bodyColor: 0x3f8f3f });
        const lowMats = materialsOf(lowGroup);
        expect(lowMats.length).toBeGreaterThan(0);
        expect(lowMats.every((m) => m instanceof THREE.MeshLambertMaterial)).toBe(true);
    });
});
