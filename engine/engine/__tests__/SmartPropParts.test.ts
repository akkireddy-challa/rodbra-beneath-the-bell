/**
 * Smart placeholders: from a declaration and the parts' boxes to what the
 * encoder and the record need, and from an extracted GLB to the same.
 *
 * @jest-environment node
 */
import * as THREE from 'three';
import {
    BM_PART_NODE_PREFIX, defaultPartPivot, deriveSmartPropFromGlb, readSmartPropSpec, smartPropBake, smartRigFor,
} from 'engine/import/SmartPropParts.js';
import { partsTableFromSpec } from 'engine/import/SmartObjectParts.js';
import { PARTS_SKELETON_REF } from 'engine/VxlV3Parts.js';
import type { ExtractedGlb, Triangle } from 'engine/ExtractGlbForVoxelization.js';

describe('readSmartPropSpec', () => {
    it('keeps what is usable and warns about the rest', () => {
        const warnings: string[] = [];
        const spec = readSmartPropSpec({
            parts: [
                { name: 'blades', motion: { kind: 'spin', axis: [0, 0, 1], rpm: 12 } },
                { name: 'cabin', parent: 'wheel', motion: { kind: 'upright' }, pivot: { x: 0, y: 2, z: 0 } },
                { name: 'bad name', motion: { kind: 'spin' } },
                { name: 'blades', motion: { kind: 'spin' } },
                { name: 'odd', motion: { kind: 'wobble' } },
            ],
            lights: [
                { name: 'lamp', part: 'blades', color: '#ffd27a', intensity: 8, flicker: true },
                { name: 'nowhere', color: '#fff' },
                { position: { x: 1, y: 2, z: 3 } },
            ],
        }, warnings);
        expect(spec?.parts.map((p) => [p.name, p.motion.kind])).toEqual([['blades', 'spin'], ['cabin', 'upright'], ['odd', 'none']]);
        expect(spec?.parts[1]).toEqual({ name: 'cabin', parent: 'wheel', motion: { kind: 'upright' }, pivot: { x: 0, y: 2, z: 0 } });
        expect(spec?.lights).toEqual([{ name: 'lamp', part: 'blades', color: '#ffd27a', intensity: 8, flicker: true }]);
        expect(warnings.join('\n')).toMatch(/no usable name/);
        expect(warnings.join('\n')).toMatch(/declared twice/);
        expect(warnings.join('\n')).toMatch(/unknown motion "wobble"/);
        expect(warnings.join('\n')).toMatch(/neither a position nor a known part/);
    });

    it('is null for nothing, junk, or an empty declaration', () => {
        expect(readSmartPropSpec(undefined)).toBeNull();
        expect(readSmartPropSpec('blades')).toBeNull();
        expect(readSmartPropSpec({ parts: [] })).toBeNull();
    });
});

describe('smartRigFor and defaultPartPivot', () => {
    it('writes bind positions local to the parent, body at the origin', () => {
        const table = partsTableFromSpec([
            { name: 'wheel', motion: { kind: 'spin', axis: [0, 0, 1], rpm: 2 } },
            { name: 'cabin', parent: 'wheel', motion: { kind: 'upright' } },
        ]);
        const rig = smartRigFor(table, [{ x: 0, y: 5, z: 0 }, { x: 3, y: 5, z: 0 }]);
        expect(rig.skeletonRef).toBe(PARTS_SKELETON_REF);
        expect(Array.from(rig.bindPositions)).toEqual([0, 0, 0, 0, 5, 0, 3, 0, 0]);
        expect(rig.fillers.count).toBe(0);
        expect(rig.sockets).toEqual([]);
    });

    it('pivots a spin at the box centre and a hanging part at its top centre', () => {
        const box = { min: { x: -1, y: 2, z: 0 }, max: { x: 1, y: 4, z: 1 } };
        expect(defaultPartPivot(box, { kind: 'spin', axis: [0, 0, 1], rpm: 1 })).toEqual({ x: 0, y: 3, z: 0.5 });
        expect(defaultPartPivot(box, { kind: 'upright' })).toEqual({ x: 0, y: 4, z: 0.5 });
        expect(defaultPartPivot(box, { kind: 'pendulum', axis: [1, 0, 0], amplitudeDeg: 10, periodS: 2 })).toEqual({ x: 0, y: 4, z: 0.5 });
    });
});

describe('smartPropBake', () => {
    const boxes = new Map([
        ['blades', { min: { x: -2, y: 3, z: 0.5 }, max: { x: 2, y: 5, z: 1 } }],
    ]);
    const identity = (p: { x: number; y: number; z: number }): { x: number; y: number; z: number } => p;

    it('places a light on its part and another at its position, first as light, rest as lights', () => {
        const bake = smartPropBake({
            parts: [{ name: 'blades', motion: { kind: 'spin', axis: [0, 0, 1], rpm: 12 } }],
            lights: [
                { name: 'hub', part: 'blades', color: '#fff' },
                { name: 'door', position: { x: 0, y: 1, z: 0.6 }, color: '#f80', intensity: 4 },
            ],
        }, boxes, identity)!;
        expect(bake.fitment.parts[0]!.pivot).toEqual({ x: 0, y: 4, z: 0.75 });
        expect(bake.light).toEqual({ color: '#fff', offset: { x: 0, y: 4, z: 0.75 }, part: 'blades' });
        expect(bake.lights).toEqual([{ color: '#f80', offset: { x: 0, y: 1, z: 0.6 }, intensity: 4 }]);
        expect(bake.fitment.source).toBeUndefined();
    });

    it('drops a part with no geometry and is null when nothing remains', () => {
        const warnings: string[] = [];
        expect(smartPropBake({ parts: [{ name: 'vane', motion: { kind: 'none' } }] }, boxes, identity, warnings)).toBeNull();
        expect(warnings[0]).toMatch(/"vane" has no geometry/);
    });
});

describe('deriveSmartPropFromGlb', () => {
    /** One triangle under a named node at the given corner. */
    function tri(node: string, x: number, y: number, z: number): Triangle {
        return {
            v0: new THREE.Vector3(x, y, z), v1: new THREE.Vector3(x + 1, y, z), v2: new THREE.Vector3(x, y + 1, z),
            normal: new THREE.Vector3(0, 0, 1), material: null, uv0: null, uv1: null, uv2: null, col0: null, col1: null, col2: null,
            sourceNodeName: node,
        } as unknown as Triangle;
    }

    function extracted(overrides: Partial<ExtractedGlb> = {}): ExtractedGlb {
        return {
            allTriangles: [tri('windmill', -1, 0, 0), tri(`${BM_PART_NODE_PREFIX}blades`, -2, 3, 0.5), tri(`${BM_PART_NODE_PREFIX}blades`, 1, 4, 0.5)],
            appliedScale: 2,
            // Authored frame spanned x −1..1, y 0..3, z −0.5..0.5; scaled by 2 → x −2..2, y 0..6, z −1..1.
            preRebaseBounds: { min: { x: -2, y: 0, z: -1 }, max: { x: 2, y: 6, z: 1 } },
            sceneExtras: {
                bmSmartObject: {
                    parts: [{ name: 'blades', motion: { kind: 'spin', axis: [0, 0, 1], rpm: 12 } }],
                    lights: [{ name: 'lamp', position: { x: 0, y: 2.5, z: 0 }, color: '#ffd27a' }],
                },
            },
            ...overrides,
        } as unknown as ExtractedGlb;
    }

    it('maps part nodes to joints, boxes from their triangles, and authored points through scale and rebase', () => {
        const derived = deriveSmartPropFromGlb(extracted())!;
        expect(derived.bake.table).toEqual([{ name: 'blades', parentJoint: 0, motion: { kind: 'spin', axis: [0, 0, 1], rpm: 12 } }]);
        // Blade triangles span x −2..2, y 3..5, z 0.5 → centre (0, 4, 0.5).
        expect(derived.fields.smartObject.parts[0]!.pivot).toEqual({ x: 0, y: 4, z: 0.5 });
        // Authored (0, 2.5, 0) × 2 = (0, 5, 0), rebased by (0, 0, 0) → (0, 5, 0).
        expect(derived.fields.light?.offset).toEqual({ x: 0, y: 5, z: 0 });
        expect(derived.voxelizerInput.jointOfNode(`${BM_PART_NODE_PREFIX}blades`)).toBe(1);
        expect(derived.voxelizerInput.jointOfNode('windmill')).toBe(0);
        expect(derived.voxelizerInput.rig.skeletonRef).toBe(PARTS_SKELETON_REF);
    });

    it('is null without the extras, and drops a declared part with no node', () => {
        expect(deriveSmartPropFromGlb(extracted({ sceneExtras: null }))).toBeNull();
        const derived = deriveSmartPropFromGlb(extracted({
            sceneExtras: { bmSmartObject: { parts: [{ name: 'vane', motion: { kind: 'spin', axis: [0, 1, 0], rpm: 1 } }] } },
        }));
        expect(derived).toBeNull();
    });
});
