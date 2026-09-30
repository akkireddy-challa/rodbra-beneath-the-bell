/**
 * @jest-environment jsdom
 *
 * A template author's route to a material class: `VoxelPartConfig.materialClass`.
 *
 * This is the path that makes the feature usable with no `.vxl` in the loop — a
 * chest whose banding is gold while its body stays matte wood — and it reuses the
 * machinery that already turns a glowing part into a material slot, because
 * "glows" and "is made of gold" are both material properties needing the same
 * per-voxel slot column.
 */
import * as THREE from 'three';
import { VoxelObjectBuilder } from 'engine/builders/VoxelObjectBuilder.js';
import { VOXEL_SLOT_HANDLES } from 'engine/VoxelOctreeRenderer.js';
import { VOXEL_MATERIAL_CLASSES } from 'engine/VoxelMaterialClass.js';
import type { VoxelSlotMaterialHandle } from 'engine/VoxelSlotMaterial.js';

/** The slot handles on whichever child mesh carries them. */
function handlesOf(object: THREE.Object3D): VoxelSlotMaterialHandle[] {
    let found: VoxelSlotMaterialHandle[] = [];
    object.traverse((child) => {
        const handles = child.userData?.[VOXEL_SLOT_HANDLES];
        if (Array.isArray(handles) && handles.length > 0) found = handles;
    });
    return found;
}

/** Every material on every mesh under `object`. */
function materialsOf(object: THREE.Object3D): THREE.Material[] {
    const out: THREE.Material[] = [];
    object.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        out.push(...(Array.isArray(child.material) ? child.material : [child.material]));
    });
    return out;
}

const box = (x: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    position: { x, y: 0, z: 0 },
    size: { width: 0.5, height: 0.5, length: 0.5 },
    color: 0xc0a020,
    ...extra,
});

describe('VoxelPartConfig.materialClass', () => {
    it('turns a classed part into a material slot named after its class', () => {
        // `materialClass: 'gold'` alone is enough — a part that is only declaring
        // what it is made of should not have to invent a slot name as well.
        const result = VoxelObjectBuilder.create({
            name: 'chest',
            voxelSize: 0.25,
            parts: [box(0), box(1, { materialClass: 'gold' })],
        } as Parameters<typeof VoxelObjectBuilder.create>[0]);

        const handles = handlesOf(result.object);
        expect(handles.map((h) => h.name)).toEqual(['gold']);
        const gold = handles[0]!.material as THREE.MeshPhysicalMaterial;
        expect(gold).toBeInstanceOf(THREE.MeshPhysicalMaterial);
        expect(gold.metalness).toBe(VOXEL_MATERIAL_CLASSES.gold.metalness);
        // Not lit — a surface description is not a light.
        expect(handles[0]!.getEmissive()).toBeCloseTo(0);
    });

    it('honours an explicit material name over the class-derived one', () => {
        const result = VoxelObjectBuilder.create({
            name: 'chest',
            voxelSize: 0.25,
            parts: [box(0), box(1, { materialClass: 'gold', material: 'banding' })],
        } as Parameters<typeof VoxelObjectBuilder.create>[0]);
        expect(handlesOf(result.object).map((h) => h.name)).toEqual(['banding']);
    });

    it('still names a glowing part with no class "light"', () => {
        // The pre-existing behaviour, unchanged.
        const result = VoxelObjectBuilder.create({
            name: 'lamp',
            voxelSize: 0.25,
            parts: [box(0), box(1, { emissive: 100 })],
        } as Parameters<typeof VoxelObjectBuilder.create>[0]);
        const handles = handlesOf(result.object);
        expect(handles.map((h) => h.name)).toEqual(['light']);
        expect(handles[0]!.getEmissive()).toBeCloseTo(1);
    });

    it('lets one part both glow and be made of something', () => {
        const result = VoxelObjectBuilder.create({
            name: 'beacon',
            voxelSize: 0.25,
            parts: [box(0), box(1, { emissive: 100, materialClass: 'glass', material: 'lamp' })],
        } as Parameters<typeof VoxelObjectBuilder.create>[0]);
        const handles = handlesOf(result.object);
        expect(handles.map((h) => h.name)).toEqual(['lamp']);
        expect(handles[0]!.getEmissive()).toBeCloseTo(1);
        expect(handles[0]!.material).toBeInstanceOf(THREE.MeshPhysicalMaterial);
    });

    it('lights a part that names a light class and no glow level', () => {
        // The template-side half of "made of" answering "how much glow?" — a
        // street lamp's bulb is fully described by what it is made of, and does
        // not have to also carry a number.
        const result = VoxelObjectBuilder.create({
            name: 'street-lamp',
            voxelSize: 0.25,
            parts: [box(0), box(1, { materialClass: 'filament' })],
        } as Parameters<typeof VoxelObjectBuilder.create>[0]);

        const handles = handlesOf(result.object);
        expect(handles.map((h) => h.name)).toEqual(['filament']);
        expect(handles[0]!.getEmissive())
            .toBeCloseTo(VOXEL_MATERIAL_CLASSES.filament.defaultGlow / 255);
    });

    it('lets an explicit glow of 0 keep a light class dark', () => {
        // A beacon waiting for its flasher. The default fills an UNSTATED glow,
        // never overrides a stated one — otherwise a template could not author a
        // light that starts off.
        const result = VoxelObjectBuilder.create({
            name: 'beacon',
            voxelSize: 0.25,
            parts: [box(0), box(1, { materialClass: 'neon', emissive: 0 })],
        } as Parameters<typeof VoxelObjectBuilder.create>[0]);

        const handles = handlesOf(result.object);
        expect(handles.map((h) => h.name)).toEqual(['neon']);
        expect(handles[0]!.getEmissive()).toBeCloseTo(0);
    });

    it('leaves an object with no classed or glowing part exactly as before', () => {
        const result = VoxelObjectBuilder.create({
            name: 'crate',
            voxelSize: 0.25,
            parts: [box(0), box(1)],
        } as Parameters<typeof VoxelObjectBuilder.create>[0]);
        expect(handlesOf(result.object)).toHaveLength(0);
        for (const m of materialsOf(result.object)) {
            expect(m).toBeInstanceOf(THREE.MeshLambertMaterial);
        }
    });
});
