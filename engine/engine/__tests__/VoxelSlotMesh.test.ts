/**
 * @jest-environment jsdom
 */
import * as THREE from 'three';
import { buildOctreeMesh, VOXEL_SLOT_HANDLES, type OctreeLeaf } from 'engine/VoxelOctreeRenderer.js';
import { EMISSIVE_INTENSITY } from 'engine/VoxelEmissiveMaterial.js';
import type { VoxelSlotMaterialHandle } from 'engine/VoxelSlotMaterial.js';
import type { VoxelSlot } from 'engine/VoxelMaterialSlots.js';

function leaf(x: number, slot = 0): OctreeLeaf {
    // Spread along X so no face is hidden by a neighbour and every leaf keeps
    // all six faces — the triangle counts below are then exact.
    return { x: x * 0.4, y: 0, z: 0, size: 0.1, r: 1, g: 0, b: 0, slot };
}

const SLOTS: VoxelSlot[] = [
    { name: 'headlights', emissive: 255 },
    { name: 'beacon', emissive: 0 },
];

function handlesOf(mesh: THREE.Mesh): VoxelSlotMaterialHandle[] {
    return (mesh.userData[VOXEL_SLOT_HANDLES] ?? []) as VoxelSlotMaterialHandle[];
}

describe('voxel material slots → geometry groups', () => {
    test('slot-free geometry keeps ONE material and no groups', () => {
        const mesh = buildOctreeMesh([leaf(0), leaf(1)], 0, 0, 0, false, 'test-plain');
        expect(Array.isArray(mesh.material)).toBe(false);
        expect(mesh.geometry.groups.length).toBe(0);
        expect(handlesOf(mesh).length).toBe(0);
    });

    test('a slot table with no slotted leaves also stays single-material', () => {
        const mesh = buildOctreeMesh([leaf(0), leaf(1)], 0, 0, 0, false, 'test-unused', null, SLOTS);
        expect(Array.isArray(mesh.material)).toBe(false);
        expect(mesh.geometry.groups.length).toBe(0);
    });

    test('slotted leaves split into one group and one material per slot', () => {
        const mesh = buildOctreeMesh(
            [leaf(0), leaf(1, 1), leaf(2, 2), leaf(3, 1)],
            0, 0, 0, false, 'test-slots', null, SLOTS,
        );
        const materials = mesh.material as THREE.Material[];
        expect(Array.isArray(mesh.material)).toBe(true);
        expect(materials.length).toBe(3); // base + headlights + beacon

        // 6 faces x 2 triangles x 3 indices = 36 indices per leaf.
        const groups = [...mesh.geometry.groups].sort((a, b) => a.materialIndex! - b.materialIndex!);
        expect(groups.map((g) => [g.materialIndex, g.count])).toEqual([
            [0, 36],  // one base leaf
            [1, 72],  // two headlight leaves
            [2, 36],  // one beacon leaf
        ]);
        // Groups tile the index buffer with no gap or overlap.
        expect(groups[0]!.start).toBe(0);
        expect(groups[1]!.start).toBe(36);
        expect(groups[2]!.start).toBe(108);
        expect(mesh.geometry.getIndex()!.count).toBe(144);
    });

    test('regrouping preserves every triangle — no index is lost or duplicated', () => {
        const plain = buildOctreeMesh(
            [leaf(0), leaf(1), leaf(2), leaf(3)], 0, 0, 0, false, 'test-a',
        );
        const slotted = buildOctreeMesh(
            [leaf(0), leaf(1, 1), leaf(2, 2), leaf(3, 1)], 0, 0, 0, false, 'test-b', null, SLOTS,
        );
        const sortedIndices = (m: THREE.Mesh): number[] =>
            Array.from(m.geometry.getIndex()!.array as ArrayLike<number>).sort((a, b) => a - b);
        // Same vertex layout either way — only the ORDER of the indices changes.
        expect(sortedIndices(slotted)).toEqual(sortedIndices(plain));
        expect(slotted.geometry.getAttribute('position').count)
            .toBe(plain.geometry.getAttribute('position').count);
    });

    test('slots start at the emissive level the asset declared', () => {
        const mesh = buildOctreeMesh([leaf(0, 1), leaf(1, 2)], 0, 0, 0, false, 'test-default', null, SLOTS);
        const handles = handlesOf(mesh);
        expect(handles.map((h) => h.name)).toEqual(['headlights', 'beacon']);
        expect(handles[0]!.getEmissive()).toBeCloseTo(1);  // 255/255 — lit on arrival
        expect(handles[1]!.getEmissive()).toBeCloseTo(0);  // waiting for its flasher
    });

    test('THE POINT: a slot is settable at runtime, and only that slot moves', () => {
        const mesh = buildOctreeMesh([leaf(0, 1), leaf(1, 2)], 0, 0, 0, false, 'test-runtime', null, SLOTS);
        const [head, beacon] = handlesOf(mesh);
        beacon!.setEmissive(1);
        expect(beacon!.getEmissive()).toBeCloseTo(1);
        expect(head!.getEmissive()).toBeCloseTo(1);
        head!.setEmissive(0);
        expect(head!.getEmissive()).toBeCloseTo(0);
        expect(beacon!.getEmissive()).toBeCloseTo(1);
        // On the WebGL path the level rides material.emissiveIntensity, which
        // three re-uploads every frame — no recompile, so a flasher can write it.
        const materials = mesh.material as THREE.MeshLambertMaterial[];
        expect(materials[2]!.emissiveIntensity).toBeCloseTo(1);
        expect(materials[1]!.emissiveIntensity).toBeCloseTo(0);
    });

    test('same colour in two slots does not merge into one material', () => {
        // Every leaf here is the SAME red. Only the slot differs.
        const mesh = buildOctreeMesh(
            [leaf(0, 1), leaf(1, 2)], 0, 0, 0, false, 'test-samecolor', null, SLOTS,
        );
        const groups = [...mesh.geometry.groups].sort((a, b) => a.materialIndex! - b.materialIndex!);
        expect(groups.map((g) => g.count)).toEqual([36, 36]);
        expect(groups.map((g) => g.materialIndex)).toEqual([1, 2]);
    });

    test('rounded-edge geometry groups by slot too', () => {
        const mesh = buildOctreeMesh(
            [leaf(0, 1), leaf(1, 2)], 0, 0, 0, false, 'test-rounded',
            { radiusVoxels: 0.25, segments: 2 }, SLOTS,
        );
        const groups = mesh.geometry.groups;
        expect(Array.isArray(mesh.material)).toBe(true);
        expect(groups.length).toBeGreaterThan(0);
        // Whatever the rounded emitter produced, the groups must cover the whole
        // index buffer exactly once.
        const total = groups.reduce((sum, g) => sum + g.count, 0);
        expect(total).toBe(mesh.geometry.getIndex()!.count);
    });
});
