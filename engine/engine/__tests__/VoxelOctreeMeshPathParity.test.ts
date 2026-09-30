/** @jest-environment jsdom */
/**
 * The octree mesh has TWO front-ends feeding one column builder
 * (`meshFromVoxelColumns`): the compact LeafBuffer path (file load — templates
 * and batched instances) and the materialised-leaves path (clones of edited
 * templates, post-carve rebuilds). They MUST stay feature-equivalent.
 *
 * They weren't: the leaves path dropped textured block types and atlas UVs, so
 * any object rebuilt from materialised leaves changed its look — and because
 * `cloneDataTo` always materialised, every interactable/collectible env-object
 * clone rendered through the degraded path from birth. A voxel whose look comes
 * from a block type has no palette colour of its own, so those objects drew
 * pure black while their batched siblings drew textured.
 *
 * Two pins here: (1) the leaves front-end now emits the same atlas/block-type
 * geometry as the buffer front-end, and (2) clones of untouched templates get
 * the compact buffer itself — the SAME rendering path, no materialisation.
 */
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from 'util';
(globalThis as unknown as { TextDecoder: unknown }).TextDecoder ??= NodeTextDecoder;
(globalThis as unknown as { TextEncoder: unknown }).TextEncoder ??= NodeTextEncoder;

jest.mock('engine/VoxelTextureAtlas.js', () => {
    const actual = jest.requireActual('engine/VoxelTextureAtlas.js') as Record<string, unknown>;
    // Deterministic pure-math stand-in: the real atlas needs a 2D canvas, which
    // jsdom does not provide. UVs only need to be distinct per input so parity
    // and lookup wiring are observable.
    const stub = {
        getTexture: () => null,
        getColorPaletteUV: (r: number, g: number, b: number) => {
            const u = (Math.round(r / 17) + Math.round(g / 17) * 16) / 4096;
            const v = Math.round(b / 17) / 16;
            return { u0: u, v0: v, u1: u + 1 / 4096, v1: v + 1 / 4096 };
        },
        getBlockUV: (blockId: number, face: 'top' | 'side' | 'bottom') => {
            const f = face === 'top' ? 0 : face === 'side' ? 1 : 2;
            return { u0: blockId / 100, v0: f / 10, u1: blockId / 100 + 0.01, v1: f / 10 + 0.01 };
        },
    };
    return { ...actual, getVoxelTextureAtlas: () => stub };
});

import type * as THREE from 'three';
import { buildOctreeMesh, buildOctreeMeshFromBuffers, LeafBuffer, type OctreeLeaf } from 'engine/VoxelOctreeRenderer.js';
import { VoxelObject } from 'engine/VoxelObject.js';
import { encodeVxlV3, type VxlV3Data } from 'engine/VxlV3Format.js';

let zid = 0;
const nextZid = (): string => `mesh-parity-${zid++}`;

/** Two spaced unit voxels: index 0 textured (block type 5, colour 0 = black in
 *  the palette — the exact shape of the bug), index 1 plain red. */
function testBuffer(): LeafBuffer {
    const buf = new LeafBuffer(2, 1, 0, 0, 0);
    buf.gx[0] = 0; buf.gx[1] = 3;
    buf.color[0] = 0x000;
    buf.color[1] = 0xF00;
    buf.blockType = new Uint16Array([5, 0]);
    return buf;
}

function attrArray(mesh: THREE.Mesh | null, name: string): number[] | null {
    const attr = mesh?.geometry.getAttribute(name);
    return attr ? Array.from(attr.array as ArrayLike<number>) : null;
}

describe('leaves front-end matches the buffer front-end', () => {
    it('renders textured block types identically to the buffer path (no black voxels)', () => {
        const buf = testBuffer();
        const fromBuffers = buildOctreeMeshFromBuffers([buf], 0, 0, 0, false, nextZid());
        const fromLeaves = buildOctreeMesh(buf.toArray(false), 0, 0, 0, false, nextZid());
        // Atlas mode: UVs into the texture atlas, no vertex colours at all —
        // the old leaves path emitted a colour attribute with (0,0,0) here.
        expect(attrArray(fromLeaves, 'color')).toBeNull();
        expect(attrArray(fromLeaves, 'uv')).toEqual(attrArray(fromBuffers, 'uv'));
        expect(attrArray(fromLeaves, 'position')).toEqual(attrArray(fromBuffers, 'position'));
    });

    it('maps atlas-mode colours to the same palette cells as the buffer path', () => {
        const buf = new LeafBuffer(2, 1, 0, 0, 0);
        buf.gx[0] = 0; buf.gx[1] = 3;
        buf.color[0] = 0x28F;
        buf.color[1] = 0x7C1;
        const fromBuffers = buildOctreeMeshFromBuffers([buf], 0, 0, 0, false, nextZid(), true);
        // toArray(true) hands back LINEAR floats — the builder must round-trip
        // them to the exact stored cell, not treat them as raw fractions.
        const fromLeaves = buildOctreeMesh(buf.toArray(true), 0, 0, 0, false, nextZid(), null, [], true);
        expect(attrArray(fromLeaves, 'uv')).toEqual(attrArray(fromBuffers, 'uv'));
    });
});

describe('cloneDataTo keeps clones on the buffer path', () => {
    const V3_DATA: VxlV3Data = {
        minVoxelSize: 1,
        maxVoxelSize: 1,
        physicsGridStep: 1,
        bounds: { minX: 0, minY: 0, minZ: 0, maxX: 4, maxY: 1, maxZ: 1 },
        useAtlas: false,
        fragments: [{
            aabbMin: [0, 0, 0], aabbMax: [4, 1, 1],
            leaves: [
                { x: 0, y: 0, z: 0, size: 1, r: 0, g: 0, b: 0, blockType: 5 },
                { x: 3, y: 0, z: 0, size: 1, r: 1, g: 0, b: 0 },
            ] as OctreeLeaf[],
        }],
    };

    async function loadTemplate(): Promise<VoxelObject> {
        const bytes = await encodeVxlV3(V3_DATA, { compression: 'none' });
        const template = new VoxelObject({ voxelSize: 1, shadows: false });
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        await template.loadFromFile(buffer);
        return template;
    }

    it('an untouched template hands its clone the compact buffer — same path, same mesh', async () => {
        const template = await loadTemplate();
        const clone = new VoxelObject({ voxelSize: 1, shadows: false });
        template.cloneDataTo(clone);
        // Neither side materialised leaf objects — both rendered from the buffer.
        expect(template.getMaterializedOctreeLeaves()).toBeNull();
        expect(clone.getMaterializedOctreeLeaves()).toBeNull();
        expect(attrArray(clone.getMesh(), 'uv')).toEqual(attrArray(template.getMesh(), 'uv'));
        expect(attrArray(clone.getMesh(), 'color')).toBeNull();
    });

    it('a mutated template clones its LIVE leaves, not the stale file buffer', async () => {
        const template = await loadTemplate();
        const before = attrArray(template.getMesh(), 'position')!.length;
        template.removeOctreeLeavesByIndex(new Set([1]));
        const clone = new VoxelObject({ voxelSize: 1, shadows: false });
        template.cloneDataTo(clone);
        const clonePositions = attrArray(clone.getMesh(), 'position')!;
        expect(clonePositions.length).toBeLessThan(before);
        expect(clonePositions).toEqual(attrArray(template.getMesh(), 'position'));
    });
});
