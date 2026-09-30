/**
 * Rounded-edge voxels must still glow.
 *
 * The rounded path builds its vertices in `appendRoundedVoxelMesh` plus a
 * flat-face greedy merge, neither of which originally carried an emissive
 * channel — so a rounded asset silently rendered unlit no matter what the file
 * said. That is not a cosmetic gap: `roundedEdges` is a per-asset voxelize
 * setting, so an author could set maximum glow, watch it save correctly into a
 * v6 `.vxl`, and still see nothing in game.
 *
 * The merge is the subtle half: plain faces merge by an opaque integer key, so
 * a glowing face and an unlit face of the SAME colour would merge into one
 * rectangle and average the glow away unless emissive is part of that key.
 */

import * as THREE from 'three';
import { buildOctreeMesh, type OctreeLeaf } from 'engine/VoxelOctreeRenderer.js';

const ROUNDING = { radiusVoxels: 0.25, segments: 2 };

function leaf(x: number, y: number, z: number, hex: [number, number, number], emissive: number): OctreeLeaf {
    return { x, y, z, size: 1, r: hex[0], g: hex[1], b: hex[2], emissive };
}

const ORANGE: [number, number, number] = [1, 0.5, 0];
const GREY: [number, number, number] = [0.5, 0.5, 0.5];

/** A solid slab, so plenty of faces are "plain" and go through the merge. */
function slab(emissiveFor: (x: number) => number): OctreeLeaf[] {
    const out: OctreeLeaf[] = [];
    for (let x = 0; x < 4; x++) {
        for (let z = 0; z < 2; z++) out.push(leaf(x, 0, z, x < 2 ? ORANGE : GREY, emissiveFor(x)));
    }
    return out;
}

function emissiveAttr(mesh: THREE.Mesh | null): THREE.BufferAttribute | null {
    const attr = mesh?.geometry?.getAttribute('emissive');
    return (attr as THREE.BufferAttribute | undefined) ?? null;
}

describe('rounded voxel meshes carry emissive', () => {
    it('builds an emissive attribute when the leaves glow', () => {
        const mesh = buildOctreeMesh(slab((x) => (x < 2 ? 255 : 0)), 0, 0, 0, false, 'test-rounded', ROUNDING);
        const attr = emissiveAttr(mesh);
        expect(attr).not.toBeNull();
        expect(attr!.count).toBe(mesh!.geometry.getAttribute('position').count);
    });

    it('adds no attribute at all when nothing glows (unchanged geometry)', () => {
        const mesh = buildOctreeMesh(slab(() => 0), 0, 0, 0, false, 'test-rounded-none', ROUNDING);
        expect(emissiveAttr(mesh)).toBeNull();
    });

    it('carries the full 0-1 range through, not just a flag', () => {
        const mesh = buildOctreeMesh(slab((x) => (x < 2 ? 255 : 0)), 0, 0, 0, false, 'test-rounded-range', ROUNDING);
        const values = Array.from(emissiveAttr(mesh)!.array as Float32Array);
        expect(Math.max(...values)).toBeCloseTo(1, 5);
        expect(Math.min(...values)).toBe(0);
    });

    it('does not let the flat-face merge average glow across same-coloured faces', () => {
        // Same colour throughout, but only half of it glows. If emissive were
        // absent from the merge key these would fuse into one rect and the
        // distinction would vanish.
        const leaves: OctreeLeaf[] = [];
        for (let x = 0; x < 4; x++) {
            for (let z = 0; z < 2; z++) leaves.push(leaf(x, 0, z, ORANGE, x < 2 ? 255 : 0));
        }
        const values = Array.from(
            emissiveAttr(buildOctreeMesh(leaves, 0, 0, 0, false, 'test-rounded-merge', ROUNDING))!.array as Float32Array,
        );
        expect(values.some((v) => v > 0.99)).toBe(true);
        expect(values.some((v) => v === 0)).toBe(true);
    });

    it('matches the sharp path, which already glowed', () => {
        const leaves = slab((x) => (x < 2 ? 255 : 0));
        const sharp = emissiveAttr(buildOctreeMesh(leaves, 0, 0, 0, false, 'test-sharp', null));
        const rounded = emissiveAttr(buildOctreeMesh(leaves, 0, 0, 0, false, 'test-rounded-cmp', ROUNDING));
        expect(sharp).not.toBeNull();
        expect(rounded).not.toBeNull();
        // Different tessellation, same story: some vertices lit, some not.
        for (const attr of [sharp!, rounded!]) {
            const v = Array.from(attr.array as Float32Array);
            expect(v.some((x) => x > 0.99)).toBe(true);
            expect(v.some((x) => x === 0)).toBe(true);
        }
    });
});
