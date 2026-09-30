/** @jest-environment jsdom */
import * as THREE from 'three';
import { buildHintMesh, buildHintMeshSoA } from 'engine/vxlscene/buildHintMesh.js';
import type { DecodedChunkQuads } from 'engine/vxlscene/VxlSceneFormat.js';
import { greedyMesh } from 'engine/vxlscene/GreedyMesher.js';
import { packCell } from 'engine/vxlscene/SurfaceRasterizer.js';
import type { CellAttr, SceneQuad } from 'engine/vxlscene/SceneVoxTypes.js';
import { getVoxelTextureAtlas } from 'engine/VoxelTextureAtlas.js';

/** Min/max Y over all vertices of a mesh's position attribute. */
function yRange(mesh: THREE.Mesh): { minY: number; maxY: number } {
    const pos = (mesh.geometry as THREE.BufferGeometry).getAttribute('position');
    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i);
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
    }
    return { minY, maxY };
}

/** A single +Y quad (axis 1, dir +1), w=h=1, at the given grid origin and offset. */
function plusYQuad(offset: number): SceneQuad {
    return { gx: 0, gy: 0, gz: 0, w: 1, h: 1, axis: 1, dir: 1, color: { r: 1, g: 1, b: 1 }, disp: 0, offset };
}

/** Center-pixel UV in the atlas color palette for an RGB888 triple (matches the runtime). */
function uvForColor(r: number, g: number, b: number): [number, number] {
    const uv = getVoxelTextureAtlas().getColorPaletteUV(r, g, b);
    return [(uv.u0 + uv.u1) / 2, (uv.v0 + uv.v1) / 2];
}

describe('buildHintMesh', () => {
    it('produces one mesh: 24 verts, 36 indices, uv attribute, NO color attribute, no polygonOffset', () => {
        const grid = new Map<number, CellAttr>();
        grid.set(packCell(0, 0, 0), { color: { r: 1, g: 1, b: 1 }, nx: 0, ny: 1, nz: 0, interior: false, noCollider: false, displacementAxis: null, dispOffset: 0 });
        const quads = greedyMesh(grid); // 6 quads
        const mesh = buildHintMesh(quads, { minVoxelSize: 1, originX: 0, originY: 0, originZ: 0 });
        const geo = mesh.geometry as THREE.BufferGeometry;
        expect(geo.getAttribute('position').count).toBe(24); // 6 quads * 4 verts
        expect(geo.getIndex()!.count).toBe(36);              // 6 quads * 6 indices
        // Atlas mode: per-vertex UV into the shared atlas, no per-vertex color.
        const uv = geo.getAttribute('uv');
        expect(uv).toBeTruthy();
        expect(uv.itemSize).toBe(2);
        expect(uv.count).toBe(24);
        expect(geo.getAttribute('color')).toBeUndefined();
        const mat = mesh.material as THREE.MeshLambertMaterial;
        expect(mat.polygonOffset).toBe(false);
        // Atlas material samples the shared atlas texture (NOT vertex colors).
        expect(mat.map).toBeTruthy();
    });

    it("each quad's four vertices share one uv (the quad's palette-color center)", () => {
        // Two distinct-colored +Y quads. Within each quad all 4 verts share the same
        // uv; the two quads' uvs differ because their colors differ.
        const ctx = { minVoxelSize: 1, originX: 0, originY: 0, originZ: 0 };
        const mesh = buildHintMesh(
            [
                { gx: 0, gy: 0, gz: 0, w: 1, h: 1, axis: 1, dir: 1, color: { r: 1, g: 0, b: 0 }, disp: 0, offset: 0 },
                { gx: 4, gy: 0, gz: 0, w: 1, h: 1, axis: 1, dir: 1, color: { r: 0, g: 0, b: 1 }, disp: 0, offset: 0 },
            ],
            ctx,
        );
        const uv = (mesh.geometry as THREE.BufferGeometry).getAttribute('uv');
        expect(uv.count).toBe(8); // 2 quads × 4 verts
        // Quad 0 (verts 0-3) all equal; quad 1 (verts 4-7) all equal.
        for (let i = 1; i < 4; i++) {
            expect(uv.getX(i)).toBe(uv.getX(0));
            expect(uv.getY(i)).toBe(uv.getY(0));
        }
        for (let i = 5; i < 8; i++) {
            expect(uv.getX(i)).toBe(uv.getX(4));
            expect(uv.getY(i)).toBe(uv.getY(4));
        }
        // Red vs blue map to different palette pixels → different uv.
        //
        // UVs are stored packed (unorm16), so the comparison is to within the packing's
        // resolution rather than exact. What has to hold is that the vertex still samples
        // its OWN palette pixel: the 4096px atlas has a 1/4096 texel, the unorm16 step is
        // 1/65535 — a sixteenth of that — so a tenth of a texel is a tolerance the
        // packing passes with room to spare and a genuinely wrong cell could not.
        const TENTH_TEXEL = 0.1 / 4096;
        const [ur, vr] = uvForColor(255, 0, 0);
        const [ub, vb] = uvForColor(0, 0, 255);
        expect(Math.abs(uv.getX(0) - ur)).toBeLessThan(TENTH_TEXEL);
        expect(Math.abs(uv.getY(0) - vr)).toBeLessThan(TENTH_TEXEL);
        expect(Math.abs(uv.getX(4) - ub)).toBeLessThan(TENTH_TEXEL);
        expect(Math.abs(uv.getY(4) - vb)).toBeLessThan(TENTH_TEXEL);
        expect(uv.getX(0) === uv.getX(4) && uv.getY(0) === uv.getY(4)).toBe(false);
    });

    it('packs normal as snorm8x4 and uv as unorm16x2, with normals still exactly ±1', () => {
        // The packing is what keeps a big baked level inside a phone's memory (32 → 20
        // bytes per vertex). Two things must hold for it to be free: the storage types
        // are ones WebGPU can bind — hence itemSize 4 on the 8-bit normal, since there is
        // no 3-component 8-bit vertex format — and a face normal survives EXACTLY, so
        // lighting and `shadow.normalBias` are unchanged.
        const ctx = { minVoxelSize: 1, originX: 0, originY: 0, originZ: 0 };
        const mesh = buildHintMesh(
            [
                { gx: 0, gy: 0, gz: 0, w: 1, h: 1, axis: 1, dir: 1, color: { r: 1, g: 0, b: 0 }, disp: 0, offset: 0 },
                { gx: 4, gy: 0, gz: 0, w: 1, h: 1, axis: 0, dir: -1, color: { r: 0, g: 0, b: 1 }, disp: 0, offset: 0 },
            ],
            ctx,
        );
        const geo = mesh.geometry as THREE.BufferGeometry;
        const normal = geo.getAttribute('normal') as THREE.BufferAttribute;
        const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
        expect(normal.array).toBeInstanceOf(Int8Array);
        expect(normal.itemSize).toBe(4);
        expect(normal.normalized).toBe(true);
        expect(uv.array).toBeInstanceOf(Uint16Array);
        expect(uv.itemSize).toBe(2);
        expect(uv.normalized).toBe(true);
        // +Y quad and -X quad: both unit axis normals, exact after denormalization.
        expect([normal.getX(0), normal.getY(0), normal.getZ(0)]).toEqual([0, 1, 0]);
        expect([normal.getX(4), normal.getY(4), normal.getZ(4)]).toEqual([-1, 0, 0]);
    });

    // (Displaced voxels are no longer rendered by buildHintMesh — smooth:y surfaces
    // are built by SurfaceMeshBuilder; see its __tests__ for the welded-mesh coverage.)

    it('does NOT recess quads: offset never moves vertex positions (gap-free regression guard)', () => {
        // A previous change RECESSED each quad inward (along -normal) by an amount
        // proportional to its `offset`, which moved geometry and opened gaps between
        // adjacent faces of differently-offset surfaces. The builder must now emit
        // vertices at their EXACT grid positions regardless of offset; the depth bias
        // lives in the renderer's per-material polygonOffset instead (geometry untouched).
        const minVoxelSize = 0.5;
        const ctx = { minVoxelSize, originX: 0, originY: 0, originZ: 0 };

        // A +Y quad's face sits at the exact plane y = (gy+1)*s = s for EVERY offset.
        for (const offset of [0, 1, 2]) {
            const { minY, maxY } = yRange(buildHintMesh([plusYQuad(offset)], ctx));
            expect(minY).toBeCloseTo(minVoxelSize, 6); // un-recessed plane, identical for all offsets
            expect(maxY).toBeCloseTo(minVoxelSize, 6); // flat +Y quad: all 4 verts at the same Y
        }
    });

    it('reuses a caller-provided material instead of creating one (shared-material path)', () => {
        // The renderer shares one material per bias step. When buildHintMeshSoA is
        // given a material, it must attach THAT instance (===) and not allocate a new one.
        const ctx = { minVoxelSize: 1, originX: 0, originY: 0, originZ: 0 };
        const empty: DecodedChunkQuads = {
            count: 1,
            gx: new Uint16Array([0]), gy: new Uint16Array([0]), gz: new Uint16Array([0]),
            w: new Uint16Array([1]), h: new Uint16Array([1]),
            axisDir: new Uint8Array([1]), colorIdx: new Uint16Array([0]), disp: new Int8Array([0]),
        };
        const shared = getVoxelTextureAtlas().createMaterial();
        const mesh = buildHintMeshSoA(empty, new Float32Array([0, 0]), ctx, shared);
        expect(mesh.material).toBe(shared);
    });

    it('a mix of offset-1 and offset-2 quads still yields ONE geometry + ONE material', () => {
        const ctx = { minVoxelSize: 0.5, originX: 0, originY: 0, originZ: 0 };
        const mesh = buildHintMesh(
            [
                { gx: 0, gy: 0, gz: 0, w: 2, h: 2, axis: 1, dir: 1, color: { r: 1, g: 0, b: 0 }, disp: 0, offset: 1 },
                { gx: 4, gy: 0, gz: 0, w: 4, h: 4, axis: 1, dir: 1, color: { r: 0, g: 1, b: 0 }, disp: 0, offset: 2 },
            ],
            ctx,
        );
        // One BufferGeometry holding BOTH quads (2 quads × 4 verts), one material.
        // (Per-offset splitting + polygonOffset is the RENDERER's job; the object
        // builder remains a single pure mesh builder.)
        const geo = mesh.geometry as THREE.BufferGeometry;
        expect(geo.getAttribute('position').count).toBe(8);
        expect(geo.getIndex()!.count).toBe(12);
        expect(Array.isArray(mesh.material)).toBe(false);
    });
});
