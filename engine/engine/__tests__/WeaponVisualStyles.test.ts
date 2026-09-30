import * as THREE from 'three';
import { createWeaponMesh, WeaponType, WeaponRegistry, parseWeaponType } from 'engine/WeaponRegistry.js';
import { createRangedWeaponMesh, RangedWeaponType, RangedWeaponRegistry, parseRangedWeaponType } from 'engine/RangedWeaponRegistry.js';
import { weaponMovesFor } from 'engine/MeleeWeaponMoves.js';
import { rangedMovesFor } from 'engine/AnimationPacks.js';
import { weaponStyleId } from 'engine/WeaponVisualStyle.js';
import { clampWeaponPartMaterialsToDirect } from 'engine/WeaponPartMaterial.js';
import { setMaterialQuality, clearMaterialQuality } from 'engine/MaterialQuality.js';
import { registerDuelistSabres } from 'engine/examples/MeleeWeaponGuide.js';
import { registerTrailCarbines } from 'engine/examples/RangedWeaponGuide.js';

function validateGeometry(group: THREE.Group, drawBudget: number): void {
    let meshes = 0;
    let triangles = 0;
    group.traverse(child => {
        if (!(child instanceof THREE.Mesh)) return;
        meshes++;
        const geometry = child.geometry as THREE.BufferGeometry;
        const positions = geometry.getAttribute('position');
        const normals = geometry.getAttribute('normal');
        triangles += positions.count / 3;
        expect(Array.from(positions.array).every(Number.isFinite)).toBe(true);
        const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
        for (let i = 0; i < positions.count; i += 3) {
            a.fromBufferAttribute(positions, i); b.fromBufferAttribute(positions, i + 1); c.fromBufferAttribute(positions, i + 2);
            const area = b.sub(a).cross(c.sub(a)).length();
            expect(area).toBeGreaterThan(1e-11);
            expect(new THREE.Vector3().fromBufferAttribute(normals, i).length()).toBeCloseTo(1, 4);
        }
    });
    expect(meshes).toBeGreaterThan(2);
    expect(meshes).toBeLessThanOrEqual(drawBudget);
    expect(triangles).toBeLessThan(12000);
}

function dispose(group: THREE.Group): void {
    group.traverse(child => {
        if (!(child instanceof THREE.Mesh)) return;
        child.geometry.dispose();
        const materials: THREE.Material[] = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach(m => m.dispose());
    });
}

describe('built-in weapon styles preserve gameplay and valid, bounded geometry', () => {
    beforeEach(() => setMaterialQuality('high'));
    afterEach(() => { clearMaterialQuality(); WeaponRegistry.clearCustom(); RangedWeaponRegistry.clearCustom(); });

    it.each(Object.values(WeaponType))('%s has two different meshes with the same hit and animation contracts', id => {
        const block = createWeaponMesh(id);
        const lowpoly = createWeaponMesh(weaponStyleId(id, 'lowpoly'));
        expect(WeaponRegistry.has(`${id}_lowpoly`)).toBe(true);
        expect(parseWeaponType(` ${id.toUpperCase()}_LOWPOLY `)).toBe(`${id}_lowpoly`);
        expect(lowpoly.preset).toEqual(block.preset);
        expect(lowpoly.config).toEqual(block.config);
        // Preserve the shipped sweep length, not just agreement between styles.
        const shippedTipAboveGrip = { sword: 1, dagger: 0.35, axe: 0.85, spear: 1.72, mace: 0.65,
            hammer: 0.85, katana: 1.1, cleaver: 0.5, staff: 1.48, club: 0.55, longsword: 2, lightsaber: 1.22 };
        expect(block.config.tipOffset.y - block.preset.gripOffset).toBeCloseTo(shippedTipAboveGrip[id], 5);
        expect(weaponMovesFor(`${id}_lowpoly`, lowpoly.preset.grip)).toEqual(weaponMovesFor(id, block.preset.grip));
        for (const result of [block, lowpoly]) {
            validateGeometry(result.mesh, 8);
            const bounds = new THREE.Box3().setFromObject(result.mesh);
            expect(bounds.max.y - result.mesh.position.y).toBeCloseTo(result.config.tipOffset.y, 1);
            const positions: number[][] = [];
            result.mesh.traverse(child => { if (child instanceof THREE.Mesh) positions.push(Array.from(child.geometry.getAttribute('normal').array)); });
            clampWeaponPartMaterialsToDirect(result.mesh);
            let meshIndex = 0;
            result.mesh.traverse(child => {
                if (child instanceof THREE.Mesh) {
                    expect(Array.from(child.geometry.getAttribute('normal').array)).toEqual(positions[meshIndex++]);
                    if (child.name === 'WeaponSurface_glow') expect(child.castShadow).toBe(false);
                }
            });
        }
        const blockVertices = block.mesh.children.map(c => (c as THREE.Mesh).geometry.getAttribute('position').count);
        const lowVertices = lowpoly.mesh.children.map(c => (c as THREE.Mesh).geometry.getAttribute('position').count);
        expect(lowVertices).not.toEqual(blockVertices);
        dispose(block.mesh); dispose(lowpoly.mesh);
    });

    it.each(Object.values(RangedWeaponType))('%s keeps its muzzle, grip, ammunition and dual setup in both styles', id => {
        const block = createRangedWeaponMesh(id), lowpoly = createRangedWeaponMesh(`${id}_lowpoly`);
        expect(RangedWeaponRegistry.has(`${id}_lowpoly`)).toBe(true);
        expect(parseRangedWeaponType(` ${id.toUpperCase()}_LOWPOLY `)).toBe(`${id}_lowpoly`);
        expect(lowpoly.preset).toEqual(block.preset);
        expect(lowpoly.foregrip).toEqual(block.foregrip);
        expect(rangedMovesFor(`${id}_lowpoly`)).toEqual(rangedMovesFor(id));
        for (const result of [block, lowpoly]) {
            validateGeometry(result.mesh, result.isDual ? 16 : 8);
            if (result.isDual) {
                expect(result.rightWeaponMesh!.userData.weaponVisualStyle).toBe(result.mesh.userData.weaponVisualStyle);
                expect(result.leftWeaponMesh!.scale.x).toBe(-1);
                expect(result.rightGrip).toEqual(block.rightGrip);
                expect(result.leftGrip).toEqual(block.leftGrip);
            }
            const mesh = result.rightWeaponMesh ?? result.mesh;
            mesh.updateMatrixWorld(true);
            // Shoot backward through the authored muzzle opening; the lip may not seal it.
            if (!['bow', 'crossbow'].includes(id)) {
                const start = result.preset.muzzleOffset.clone().add(new THREE.Vector3(0, 0, 0.001));
                const localRoot = mesh.clone(); localRoot.position.set(0, 0, 0); localRoot.updateMatrixWorld(true);
                const hit = new THREE.Raycaster(start, new THREE.Vector3(0, 0, -1), 0, 0.002).intersectObject(localRoot, true);
                expect(hit).toHaveLength(0);
            }
        }
        dispose(block.mesh); dispose(lowpoly.mesh);
    });

    it('keeps exact custom registrations ahead of built-in style resolution', () => {
        const preset = createWeaponMesh('dagger').preset;
        WeaponRegistry.register('sword_lowpoly', { preset, createMesh: () => 0.25 });
        expect(createWeaponMesh('sword_lowpoly').preset).toBe(preset);
        expect(WeaponRegistry.has('unknown_lowpoly')).toBe(false);
        expect(RangedWeaponRegistry.has('unknown_lowpoly')).toBe(false);
    });

    it('runs the documented custom authoring examples in both styles', () => {
        registerDuelistSabres();
        registerTrailCarbines();
        for (const suffix of ['', '_lowpoly']) {
            const melee = createWeaponMesh(`duelist_sabre${suffix}`);
            const ranged = createRangedWeaponMesh(`trail_carbine${suffix}`);
            try {
                validateGeometry(melee.mesh, 8);
                validateGeometry(ranged.mesh, 8);
                expect(melee.preset.name).toBe('Duelist Sabre');
                expect(melee.config.tipOffset.y).toBeCloseTo(melee.preset.gripOffset + 0.95);
                expect(ranged.preset.name).toBe('Trail Carbine');
                expect(ranged.preset.magazineSize).toBe(20);
                expect(ranged.foregrip).not.toBeNull();
            } finally { dispose(melee.mesh); dispose(ranged.mesh); }
        }
    });
});
