/**
 * @jest-environment jsdom
 */
import { buildOctreeMeshFromBuffers, LeafBuffer } from 'engine/VoxelOctreeRenderer.js';

/** A single red voxel at the grid origin. When `emiss` is non-null the buffer
 *  carries a per-leaf emissive column (0..255); when null it has none. */
function oneVoxel(emiss: number | null): LeafBuffer {
    const buf = new LeafBuffer(1, 1, 0, 0, 0);
    buf.gx[0] = 0; buf.gy[0] = 0; buf.gz[0] = 0; buf.lod[0] = 0;
    buf.color[0] = 0xF00; // red RGB444
    if (emiss !== null) { buf.emiss = new Uint8Array([emiss]); }
    return buf;
}

/** A voxel at an arbitrary grid position (so two fragments don't overlap). */
function voxelAt(gx: number, color: number, emiss: number | null): LeafBuffer {
    const buf = new LeafBuffer(1, 1, 0, 0, 0);
    buf.gx[0] = gx; buf.gy[0] = 0; buf.gz[0] = 0; buf.lod[0] = 0;
    buf.color[0] = color;
    if (emiss !== null) { buf.emiss = new Uint8Array([emiss]); }
    return buf;
}

describe('voxel emissive vertex attribute', () => {
    test('asset with emissive gets an emissive attribute in [0,1]', () => {
        const mesh = buildOctreeMeshFromBuffers([oneVoxel(255)], 0, 0, 0, false, 'test-emissive-a');
        expect(mesh).not.toBeNull();
        const attr = mesh!.geometry.getAttribute('emissive');
        expect(attr).toBeDefined();
        expect(attr.itemSize).toBe(1);
        // A lone voxel exposes 6 faces x 4 verts = 24 verts, all full-emissive.
        expect(attr.count).toBe(24);
        expect(attr.array[0]).toBeCloseTo(1, 3);
        for (let i = 0; i < attr.count; i++) {
            expect(attr.array[i]).toBeCloseTo(1, 3);
        }
    });

    test('partial emissive maps 128/255 -> ~0.502', () => {
        const mesh = buildOctreeMeshFromBuffers([oneVoxel(128)], 0, 0, 0, false, 'test-emissive-partial');
        const attr = mesh!.geometry.getAttribute('emissive');
        expect(attr).toBeDefined();
        expect(attr.array[0]).toBeCloseTo(128 / 255, 3);
    });

    test('asset without emissive has no emissive attribute (byte-identical geometry)', () => {
        const mesh = buildOctreeMeshFromBuffers([oneVoxel(null)], 0, 0, 0, false, 'test-emissive-none');
        expect(mesh).not.toBeNull();
        expect(mesh!.geometry.getAttribute('emissive')).toBeUndefined();
    });

    test('mixed fragments: null-emiss fragment gets explicit 0, no misalignment', () => {
        // Two non-overlapping voxels: the first emissive (255), the second on a
        // fragment with no emissive column. The whole mesh gets an emissive
        // attribute; the second voxel's 24 verts must read exactly 0.
        const mesh = buildOctreeMeshFromBuffers(
            [voxelAt(0, 0xF00, 255), voxelAt(4, 0x0F0, null)],
            0, 0, 0, false, 'test-emissive-mixed',
        );
        const attr = mesh!.geometry.getAttribute('emissive');
        expect(attr).toBeDefined();
        expect(attr.count).toBe(48); // 2 voxels x 6 faces x 4 verts
        // First voxel's 24 verts full-emissive, second voxel's 24 verts zero.
        for (let i = 0; i < 24; i++) expect(attr.array[i]).toBeCloseTo(1, 3);
        for (let i = 24; i < 48; i++) expect(attr.array[i]).toBe(0);
    });
});
