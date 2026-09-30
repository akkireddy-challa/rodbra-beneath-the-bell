/**
 * Hint-mesh builder for the GLB scene voxelizer (design §3.9, §3.8).
 *
 * Expands a greedy-meshed set of quads into ONE BufferGeometry + ONE material =
 * one draw call. Per-vertex UVs index the shared VoxelTextureAtlas color-palette
 * region (matching VoxelWorld's atlas mode — the genre's fast path), so all chunk
 * meshes sample one atlas texture; normals are flat (one per face). This is a PURE
 * mesh builder: every vertex is emitted at its exact
 * grid position (no recess, no displacement of geometry). Where surfaces of different
 * coarseness are near-coplanar (e.g. sand baked at offset 1 over grass at offset 2),
 * the z-fight bias is applied by the RENDERER via per-material `polygonOffset` — a
 * depth-test bias that leaves geometry untouched, so it can never open gaps between
 * adjacent faces. The renderer therefore splits a chunk-LOD into one mesh per offset
 * (see VxlSceneRenderer) and sets each mesh's polygonOffset by its coarseness.
 *
 * Smooth surfaces (displaced voxels) are built by `SurfaceMeshBuilder` — this
 * builder handles greedy quads ONLY.
 *
 * VERTEX PACKING. Positions stay float32 (they are world-space and must stay seam-exact
 * across chunk borders), but `normal` is snorm8 and `uv` is unorm16 — 32 → 20 bytes per
 * vertex, i.e. 152 → 104 bytes per quad including the index. Neither is a quality
 * trade: a face normal is exactly ±1 on one axis, which snorm8 stores exactly, and an
 * atlas UV is a palette-cell CENTRE, where the unorm16 step is a small fraction of a
 * texel. It is a memory trade, and on a phone a decisive one — the batches are held
 * twice (CPU copy until the post-warmup release, plus the GPU copy in the same unified
 * memory), so a 640 m level's quads go from 627 MB to 429 MB per copy. Consumers read
 * these through `BufferAttribute.getX/getY`, which denormalizes; only code touching
 * `.array` directly needs to know the storage type.
 *
 * The runtime path consumes Structure-of-Arrays columns (`buildHintMeshSoA`):
 * the decoder produces parallel typed arrays + a shared RGB888 palette, so the
 * mesh is built in tight loops with no per-quad/per-voxel JS objects. The legacy
 * object form (`buildHintMesh`) is retained for tests and adapts its inputs into
 * SoA columns + a local palette, then delegates — so both paths emit byte-
 * identical geometry.
 */

import * as THREE from 'three';
import type { SceneQuad } from 'engine/vxlscene/SceneVoxTypes.js';
import type { DecodedChunkQuads } from 'engine/vxlscene/VxlSceneFormat.js';
import { getVoxelTextureAtlas } from 'engine/VoxelTextureAtlas.js';

export interface HintMeshCtx {
    minVoxelSize: number;
    originX: number;
    originY: number;
    originZ: number;
}

/** Full-scale snorm8 value: a packed normal component of ±1 is stored as ±127. */
const SNORM8_MAX = 127;

/** Full-scale unorm16 value: a packed UV of 1.0 is stored as 65535. */
const UNORM16_MAX = 65535;

/**
 * Item size of the packed `normal` attribute — FOUR, not three.
 *
 * WebGPU has no 3-component 8-bit vertex format, so three pads an itemSize-3 Int8
 * attribute up to `snorm8x4` by allocating a padded COPY of the whole array at upload
 * time (`WebGPUAttributeUtils`). On a level whose batches are hundreds of MB that
 * transient copy lands exactly at the memory peak this packing exists to lower, so the
 * padding lane is written up front instead. It is never read: both backends' shaders
 * declare `normal` as a vec3 and take the first three components.
 */
const NORMAL_ITEM_SIZE = 4;

/**
 * Build one mesh from greedy quads (Structure-of-Arrays columns). Each quad
 * becomes 4 vertices + 6 indices (two triangles) wound so the front face points
 * along the outward normal (dir · e_axis). Positions are in world space: grid
 * coords scaled by minVoxelSize and offset by the chunk origin.
 *
 * Each vertex's UV is the precomputed atlas color-palette center for its
 * `colorIdx`, read from `paletteUV` (a `Float32Array` of length `2·N` for an
 * `N`-entry palette: `[u0,v0, u1,v1, …]`). The renderer builds this once per world
 * from the RGB888 palette via `getColorPaletteUV`, so the per-vertex loops here do
 * no color math. All geometry is merged into ONE BufferGeometry + ONE material.
 *
 * `material` is optional: when supplied it is attached as-is (the renderer shares
 * one atlas material per depth-bias step across many meshes); when omitted a fresh
 * atlas material (`getVoxelTextureAtlas().createMaterial()`) is created — preserving
 * the object-form `buildHintMesh` and the SoA-equivalence tests, which call without
 * it. Both paths sample the SAME shared atlas texture.
 *
 * The `quads.disp` column is intentionally NOT read here — it belongs to the shared
 * `DecodedChunkQuads` type (also used by the collider baker); displaced-surface
 * geometry is the responsibility of `SurfaceMeshBuilder`, not this quad builder.
 */
export function buildHintMeshSoA(
    quads: DecodedChunkQuads,
    paletteUV: Float32Array,
    ctx: HintMeshCtx,
    material?: THREE.MeshLambertMaterial,
): THREE.Mesh {
    const { minVoxelSize: s, originX, originY, originZ } = ctx;
    const n = quads.count;

    // Quads: 4 verts / 6 indices each.
    //
    // Normals and UVs are stored PACKED (see the module doc): a baked 640 m level is
    // millions of quads, and float32 normals+uvs are 20 of the 32 bytes per vertex for
    // data that needs neither the range nor the precision.
    const vertCount = n * 4;
    const positions = new Float32Array(vertCount * 3);
    const uvs = new Uint16Array(vertCount * 2);
    const normals = new Int8Array(vertCount * NORMAL_ITEM_SIZE);
    const indices = new Uint32Array(n * 6);

    for (let i = 0; i < n; i++) {
        const axisDir = quads.axisDir[i]!;
        const d = axisDir & 0x3;            // face axis 0=X,1=Y,2=Z
        const dir = ((axisDir >> 2) & 1) === 0 ? 1 : -1;
        const u = (d + 1) % 3;              // in-plane axis carrying quad.w
        const v = (d + 2) % 3;              // in-plane axis carrying quad.h

        const og0 = quads.gx[i]!, og1 = quads.gy[i]!, og2 = quads.gz[i]!;
        const qw = quads.w[i]!, qh = quads.h[i]!;
        // The face sits at the +/- side of the cell layer. +dir -> far side (origin+1),
        // -dir -> near side (origin+0), along axis d.
        const dOffset = dir === 1 ? 1 : 0;

        // Build the four corners in grid space, then scale to world.
        // Corner (a along u in {0,w}, b along v in {0,h}). Each component adds
        // dOffset on axis d, `a` on axis u, `b` on axis v — axes are distinct so
        // exactly one term applies per component.
        const gridComp = (j: number, base: number, a: number, b: number): number =>
            base + (j === d ? dOffset : 0) + (j === u ? a : 0) + (j === v ? b : 0);
        const corner = (a: number, b: number): [number, number, number] => [
            gridComp(0, og0, a, b) * s + originX,
            gridComp(1, og1, a, b) * s + originY,
            gridComp(2, og2, a, b) * s + originZ,
        ];

        const c00 = corner(0, 0);
        const c10 = corner(qw, 0);
        const c11 = corner(qw, qh);
        const c01 = corner(0, qh);

        // Outward normal = dir along axis d. Vertices are at their exact grid positions:
        // the quad's `offset` (axisDir bits 3-5) is NOT applied to geometry here — the
        // renderer biases the depth test per offset via polygonOffset instead, so adjacent
        // faces always meet (no gaps).
        const nx = d === 0 ? dir * SNORM8_MAX : 0;
        const ny = d === 1 ? dir * SNORM8_MAX : 0;
        const nz = d === 2 ? dir * SNORM8_MAX : 0;

        // UV into the shared atlas color-palette region (precomputed per palette entry),
        // quantized once per quad to the unorm16 grid all four of its verts share.
        const ci = quads.colorIdx[i]! * 2;
        const uu = Math.round(paletteUV[ci]! * UNORM16_MAX);
        const vv = Math.round(paletteUV[ci + 1]! * UNORM16_MAX);

        // Vertex order: c00, c10, c11, c01. Triangles (0,1,2) + (0,2,3) give a
        // CCW front face when (u-edge × v-edge) aligns with +dir; for -dir we
        // reverse the triangle winding so the front face still points outward.
        const base = i * 4;
        const writeVert = (vi: number, p: [number, number, number]): void => {
            const o = (base + vi) * 3;
            positions[o] = p[0]; positions[o + 1] = p[1]; positions[o + 2] = p[2];
            // ±1 is exactly representable as snorm8 (±127/127), so packing the normal is
            // lossless here. The 4th lane stays 0 — it is padding, never read (the shaders
            // declare `normal` as a vec3).
            const no = (base + vi) * NORMAL_ITEM_SIZE;
            normals[no] = nx; normals[no + 1] = ny; normals[no + 2] = nz;
            const uo = (base + vi) * 2;
            uvs[uo] = uu; uvs[uo + 1] = vv;
        };
        writeVert(0, c00);
        writeVert(1, c10);
        writeVert(2, c11);
        writeVert(3, c01);

        // (u × v) = e_u × e_v = e_d (right-handed cyclic). So the c00->c10->c11
        // winding is CCW as seen from +d. Keep it for +dir, reverse for -dir.
        const io = i * 6;
        if (dir === 1) {
            indices[io] = base + 0; indices[io + 1] = base + 1; indices[io + 2] = base + 2;
            indices[io + 3] = base + 0; indices[io + 4] = base + 2; indices[io + 5] = base + 3;
        } else {
            indices[io] = base + 0; indices[io + 1] = base + 2; indices[io + 2] = base + 1;
            indices[io + 3] = base + 0; indices[io + 4] = base + 3; indices[io + 5] = base + 2;
        }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2, true));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, NORMAL_ITEM_SIZE, true));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));

    // Atlas material (shared texture). The renderer passes a cached per-bias-step
    // material; the object/test path (no material) gets a fresh atlas material that
    // still samples the one shared atlas texture.
    let mat: THREE.MeshLambertMaterial;
    if (material) {
        mat = material;
    } else {
        mat = getVoxelTextureAtlas().createMaterial();
        mat.flatShading = true;
    }

    return new THREE.Mesh(geometry, mat);
}

/**
 * Legacy object-based hint-mesh builder. Adapts `SceneQuad[]` into SoA columns
 * + a local RGB888 palette, then delegates to `buildHintMeshSoA`, so the
 * geometry it emits is byte-identical to the SoA runtime path. Retained for
 * tests / any object-shaped caller. Colors are quantized to RGB888 and back
 * (the same rounding the encoder applies) so the delegated result matches a
 * decode of the same colors.
 */
export function buildHintMesh(
    quads: SceneQuad[],
    ctx: HintMeshCtx,
): THREE.Mesh {
    // Intern colors into a local palette (RGB888) so both forms share one path.
    const palette: number[] = [];
    const paletteMap = new Map<number, number>();
    const intern = (r: number, g: number, b: number): number => {
        const r8 = clamp255(r), g8 = clamp255(g), b8 = clamp255(b);
        const key = (r8 << 16) | (g8 << 8) | b8;
        let idx = paletteMap.get(key);
        if (idx === undefined) {
            idx = palette.length / 3;
            palette.push(r8, g8, b8);
            paletteMap.set(key, idx);
        }
        return idx;
    };

    const n = quads.length;
    const qSoA: DecodedChunkQuads = {
        count: n,
        gx: new Uint16Array(n), gy: new Uint16Array(n), gz: new Uint16Array(n),
        w: new Uint16Array(n), h: new Uint16Array(n),
        axisDir: new Uint8Array(n), colorIdx: new Uint16Array(n), disp: new Int8Array(n),
    };
    for (let i = 0; i < n; i++) {
        const q = quads[i]!;
        qSoA.gx[i] = q.gx; qSoA.gy[i] = q.gy; qSoA.gz[i] = q.gz;
        qSoA.w[i] = q.w; qSoA.h[i] = q.h;
        // Pack axis (bits 0-1) + dir (bit 2) + source lodOffset (bits 3-5) so the object
        // form round-trips offset exactly as the encoder/decoder do — the renderer
        // reads the offset out of these bits to apply the per-offset z-fight polygonOffset.
        qSoA.axisDir[i] = (q.axis & 0x3) | ((q.dir === -1 ? 1 : 0) << 2) | (((q.offset ?? 0) & 0x7) << 3) | ((q.noCollider ? 1 : 0) << 6);
        qSoA.colorIdx[i] = intern(q.color.r, q.color.g, q.color.b);
        qSoA.disp[i] = q.disp;
    }

    const atlas = getVoxelTextureAtlas();
    const paletteUV = new Float32Array((palette.length / 3) * 2);
    for (let i = 0; i < palette.length / 3; i++) {
        const uv = atlas.getColorPaletteUV(palette[i * 3]!, palette[i * 3 + 1]!, palette[i * 3 + 2]!);
        paletteUV[i * 2] = (uv.u0 + uv.u1) / 2;
        paletteUV[i * 2 + 1] = (uv.v0 + uv.v1) / 2;
    }

    return buildHintMeshSoA(qSoA, paletteUV, ctx);
}

function clamp255(v: number): number {
    return Math.max(0, Math.min(255, Math.round(v * 255)));
}
