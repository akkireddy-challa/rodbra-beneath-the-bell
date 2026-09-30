/**
 * @jest-environment jsdom
 *
 * A GLB material's own PBR values decide its slot's MATERIAL CLASS.
 *
 * The alternative would be a second naming convention on top of `BM_slot_*`, and
 * that asks the modeller twice: someone who made the blade metallic and the grip
 * rough has already said what those surfaces are. So the class is snapped from
 * `metalness`/`roughness` — coarsely and on purpose, because the class table owns
 * the look and a `metal` voxel should get the engine's tuned metal whether the
 * GLB said 0.8 or 1.0.
 */
import * as THREE from 'three';
import { assignVoxelSlotsFromTriangles } from 'engine/VoxelSlotAssign.js';
import type { Triangle } from 'engine/GLBVoxelizer.js';
import type { OctreeLeaf } from 'engine/VoxelOctreeRenderer.js';

type Pbr = Partial<THREE.MeshStandardMaterialParameters>;
type SlotAssignment = ReturnType<typeof assignVoxelSlotsFromTriangles>;

/** One triangle straddling the origin, carrying `material`. */
function triangle(material: THREE.MeshStandardMaterial | null): Triangle {
    return {
        v0: new THREE.Vector3(0, 0, 0),
        v1: new THREE.Vector3(1, 0, 0),
        v2: new THREE.Vector3(0, 1, 0),
        normal: new THREE.Vector3(0, 0, 1),
        material,
    };
}

function slotMaterial(name: string, pbr: Pbr): THREE.MeshStandardMaterial {
    const material = new THREE.MeshStandardMaterial(pbr);
    material.name = name;
    return material;
}

/** A leaf sitting on the triangle above, so the nearest-triangle rule finds it. */
const leaf = (): OctreeLeaf => ({ x: 0.1, y: 0.1, z: 0, size: 0.2, r: 1, g: 1, b: 1, slot: 0 });

/** Assign against a GLB material whose NAME is the thing under test. */
function assignNamed(materialName: string, pbr: Pbr): SlotAssignment {
    return assignVoxelSlotsFromTriangles([leaf()], [triangle(slotMaterial(materialName, pbr))]);
}

/** The same, for the cases where only the PBR values are under test. */
function assign(pbr: Pbr): SlotAssignment {
    return assignNamed('BM_slot_blade', pbr);
}

describe('a GLB material declares its slot class', () => {
    it('reads a polished metal as metal', () => {
        const result = assign({ metalness: 1, roughness: 0.3 });
        expect(result.slots).toHaveLength(1);
        expect(result.slots[0]!.name).toBe('blade');
        expect(result.slots[0]!.materialClass).toBe('metal');
    });

    it('reads a mirror-smooth metal as chrome', () => {
        expect(assign({ metalness: 1, roughness: 0.05 }).slots[0]!.materialClass).toBe('chrome');
    });

    it('reads a smooth dielectric as glass', () => {
        expect(assign({ metalness: 0, roughness: 0.05 }).slots[0]!.materialClass).toBe('glass');
    });

    it('leaves an ordinary matte surface unclassified', () => {
        // Guessing wood from roughness 0.6 would be inventing a material the
        // modeller never claimed.
        expect(assign({ metalness: 0, roughness: 0.6 }).slots[0]!.materialClass).toBeUndefined();
    });

    it("ignores glTF's default metalness 1 / roughness 1", () => {
        // Exporters write that pair for untouched materials, so taking it
        // literally would make every unstyled slot brushed iron.
        expect(assign({ metalness: 1, roughness: 1 }).slots[0]!.materialClass).toBeUndefined();
    });

    it('still assigns the slot itself when there is no class to read', () => {
        // The class is additive: a slot with no PBR intent is exactly the slot it
        // was before material classes existed.
        const result = assign({ metalness: 0, roughness: 1 });
        expect(result.slots).toHaveLength(1);
        expect(result.assigned).toBeGreaterThan(0);
    });

    it('leaves a non-slot material alone entirely', () => {
        const result = assignVoxelSlotsFromTriangles(
            [leaf()],
            [triangle(slotMaterial('SwordSteel', { metalness: 1, roughness: 0.2 }))],
        );
        // No BM_slot_ prefix means no slot, however metallic the material is —
        // the class rides on a slot, it does not create one.
        expect(result.slots).toHaveLength(0);
    });

    it('keeps the glow and the class independent', () => {
        const material = slotMaterial('BM_slot_beacon', { metalness: 1, roughness: 0.2 });
        material.emissive = new THREE.Color(1, 1, 1);
        material.emissiveIntensity = 1;
        const result = assignVoxelSlotsFromTriangles([leaf()], [triangle(material)]);
        expect(result.slots[0]!.emissive).toBe(255);
        expect(result.slots[0]!.materialClass).toBe('metal');
    });
});

/**
 * The fallback for the classes PBR values physically cannot tell apart.
 *
 * Fur, cloth and leather are the same metalness and the same roughness as each
 * other and as an untouched material, so a modeller who means fur has no way to
 * say so through the numbers. Reading the slot's own name closes that off without
 * adding a convention: naming a slot after a class is already load-bearing
 * elsewhere (`VxlMaterialSlotTransforms` recognises exactly these slots as ones
 * re-classification owns).
 */
describe('a slot named after a class declares that class', () => {
    it('reads BM_slot_fur as fur', () => {
        // The case the whole fallback exists for: nothing in the PBR values of a
        // teddy bear's pelt distinguishes it from a cushion's fabric.
        const result = assignNamed('BM_slot_fur', { metalness: 0, roughness: 1 });
        expect(result.slots[0]!.name).toBe('fur');
        expect(result.slots[0]!.materialClass).toBe('fur');
    });

    it('generalises to the rest of the vocabulary', () => {
        // Not a fur special case — every class name works, which is what keeps
        // this one rule rather than an exception list.
        expect(assignNamed('BM_slot_wood', { metalness: 0, roughness: 0.8 }).slots[0]!.materialClass)
            .toBe('wood');
        expect(assignNamed('BM_slot_Leather', { metalness: 0, roughness: 0.8 }).slots[0]!.materialClass)
            .toBe('leather');
    });

    it('leaves an ordinary slot name unclassified', () => {
        // Only names already in the vocabulary count, or every hand-named slot
        // would start guessing at a material.
        expect(assignNamed('BM_slot_headlights', { metalness: 0, roughness: 0.8 }).slots[0]!.materialClass)
            .toBeUndefined();
    });

    it('lets the PBR values win when they say something', () => {
        // The modeller who actually set metalness made the stronger statement, so
        // the name is a fallback and never an override.
        expect(assignNamed('BM_slot_wood', { metalness: 1, roughness: 0.05 }).slots[0]!.materialClass)
            .toBe('chrome');
    });

    it('does not turn a class-named material into a slot on its own', () => {
        // The class still rides on a slot; without the prefix there is no slot to
        // ride, however suggestive the name.
        expect(assignNamed('fur', { metalness: 0, roughness: 1 }).slots).toHaveLength(0);
    });

    it('classes a forged vehicle glazing slot: name and PBR agree, no glow', () => {
        // Exactly what the vehicle forger writes for the cabin glass — a slot
        // NAMED after the class with PBR that declares the same class, shipped
        // dark. Belt and braces on one contract.
        const result = assignNamed('BM_slot_glass', { metalness: 0, roughness: 0.05 });
        expect(result.slots[0]!.name).toBe('glass');
        expect(result.slots[0]!.materialClass).toBe('glass');
        expect(result.slots[0]!.emissive).toBe(0);
    });
});
