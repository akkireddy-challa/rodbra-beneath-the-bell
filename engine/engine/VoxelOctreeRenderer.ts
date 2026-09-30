import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { FACE_TEMPLATES } from 'engine/VoxelGeometry.js';
import { getZFightingRegistry } from 'engine/ZFightingRegistry.js';
import { getVoxelTextureAtlas } from 'engine/VoxelTextureAtlas.js';
import { createVoxelMaterial } from 'engine/VoxelEmissiveMaterial.js';
import { appendRoundedVoxelMesh, type RoundedAtlasContext } from 'engine/VoxelRoundedMesh.js';
import { mergeFlatFaceSquares, type FlatFaceSquare } from 'engine/VoxelFlatFaceMerge.js';
import { releaseMeshCpuBuffersAfterUpload } from 'engine/GeometryCpuRelease.js';
import { atlasCellToLinearRgb, atlasCellRepr, rgb888ToAtlasCell } from 'engine/vxlscene/atlasColor.js';
import type { VoxelSlot } from 'engine/VoxelMaterialSlots.js';
import { createVoxelSlotMaterial, type VoxelSlotMaterialHandle } from 'engine/VoxelSlotMaterial.js';
import { smoothSlotShadingNormals } from 'engine/VoxelSlotShading.js';
import { DEFAULT_MATERIAL_QUALITY } from 'engine/MaterialQuality.js';
import { activeMaterialQuality } from 'engine/DeviceQuality.js';
import { stampShadingSmoothed } from 'engine/VoxelSurfaceFinish.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import { voxelsDesc, cellsFromDenseGrid } from 'engine/physics/VoxelColliders.js';

/**
 * Rounded-edge rendering for octree voxel meshes — the same visual treatment
 * `VoxelWorld` / dense-grid `VoxelObject`s get from `appendRoundedVoxelMesh`,
 * applied per octree leaf. Radius is expressed in units of the smallest leaf
 * edge ("voxels") so it tracks the asset's voxel grain across LODs.
 */
export interface OctreeMeshRounding {
    radiusVoxels: number;
    /** Tessellation segments per quarter-arc. */
    segments: number;
}

// ─── Types ───────────────────────────────────────────────────────────

export interface OctreeNodeV2 {
    min: [number, number, number];
    size: number;
    color?: number;
    children?: (OctreeNodeV2 | null)[];
}

export interface OctreeLeaf {
    x: number;
    y: number;
    z: number;
    size: number;
    r: number;
    g: number;
    b: number;
    /** Emissive intensity 0..255 (0 = none). Optional — absent means 0. */
    emissive?: number;
    /**
     * Textured BLOCK TYPE id (0 / `BlockType.COLOR` = this voxel is coloured, not
     * textured). Optional — absent means coloured.
     *
     * A block type indexes the shared texture atlas per FACE (top/side/bottom), which
     * is what makes these read as Minecraft-style blocks rather than paint. It rides
     * alongside colour rather than replacing it so one asset can hold both, and it is
     * independent of `slot` for the same reason slot is independent of colour.
     */
    blockType?: number;
    /**
     * Material slot index (0 = the base material). Optional — absent means 0.
     * Independent of colour, so two same-coloured voxels can belong to
     * different materials; see engine/VoxelMaterialSlots.ts.
     */
    slot?: number;
    /**
     * Owning joint index for a RIGGED character (v10), or absent for static geometry.
     *
     * Exactly one joint — there are no weights. A voxel bound to a single bone
     * transforms rigidly, so a cube stays a cube under rotation instead of shearing,
     * and the runtime needs one matrix per bone rather than per-vertex blending. This
     * is spatial, not material: the same colour appears on both arms and moves with
     * different bones, which is why it is a per-leaf column and not a palette property
     * like `slot` or `blockType`. See engine/VxlV3Rig.ts.
     */
    bone?: number;
}

/** Pack 0-1 RGB into a 12-bit RGB444 value (low bits of a Uint16): 0x0RGB. The atlas
 *  palette is 4096 colours, so 4 bits/channel is the precision ceiling — anything more
 *  is wasted memory. */
export function packRgb444(r: number, g: number, b: number): number {
    const r4 = r <= 0 ? 0 : r >= 1 ? 15 : Math.round(r * 15);
    const g4 = g <= 0 ? 0 : g >= 1 ? 15 : Math.round(g * 15);
    const b4 = b <= 0 ? 0 : b >= 1 ? 15 : Math.round(b * 15);
    return (r4 << 8) | (g4 << 4) | b4;
}

/** Expand a 12-bit RGB444 value back to 0-1 floats (1/15 quantisation). */
export function unpackRgb444(c: number): { r: number; g: number; b: number } {
    return { r: ((c >> 8) & 0xF) / 15, g: ((c >> 4) & 0xF) / 15, b: (c & 0xF) / 15 };
}

/**
 * Structure-of-Arrays voxel-leaf store — the runtime replacement for `OctreeLeaf[]`.
 *
 * One `OctreeLeaf` object is ~80-100 bytes in JSC (header + 7 boxed numbers + the array
 * slot); a large v4 asset materialises millions of them at decode time, and that
 * allocation storm (plus the heap fragmentation and GC pressure it creates) is what kills
 * the tab on iOS Safari. `LeafBuffer` holds the same voxels in a handful of typed-array
 * columns at ~9 bytes/leaf — basically the on-disk size:
 *   - `gx/gy/gz` Uint16 grid coords (file-native; world pos = g·minVoxelSize + base)
 *   - `lod`      Uint8   (world size = minVoxelSize << lod)
 *   - `color`    Uint16  RGB444
 * World position / size / RGB are reconstructed only at the point of use (mesh build,
 * collision) — never stored expanded. Nothing per-leaf for the GC to trace; freeing is
 * instant (drop the column refs).
 */
export class LeafBuffer {
    readonly count: number;
    readonly gx: Uint16Array;
    readonly gy: Uint16Array;
    readonly gz: Uint16Array;
    readonly lod: Uint8Array;
    readonly color: Uint16Array; // RGB444
    /** Per-leaf emissive 0..255, or null when the asset has no emissive. Set by the decoder
     *  after construction; the mesh builder reads it directly, and forEach/toArray surface
     *  it on the produced leaves so decode -> leaves -> re-encode preserves emissive. */
    emiss: Uint8Array | null = null;
    /** Per-leaf material slot (0 = base), or null when the asset declares no slots. Set by
     *  the decoder alongside `emiss`; the mesh builder groups faces by it so each slot gets
     *  its own material. See engine/VoxelMaterialSlots.ts. */
    slot: Uint8Array | null = null;
    /** Per-leaf textured block type (0 = coloured), or null when the asset has none. Like
     *  `emiss`/`slot` it is stored per PALETTE ENTRY in the file and resolved here. */
    blockType: Uint16Array | null = null;
    /** Per-leaf palette index, kept ONLY while decoding an asset that has an emissive or
     *  slot section: those are stored per PALETTE ENTRY, and with slots a colour cell no
     *  longer identifies an entry uniquely, so the index is what resolves them. Dropped as
     *  soon as `emiss`/`slot` are filled — nothing downstream reads it. */
    palIdx: Uint16Array | null = null;
    /** Per-leaf owning joint for a rigged character (v10), or null for static geometry.
     *  Unlike `slot`/`blockType` this is stored per LEAF in the file, not per palette
     *  entry, so the decoder hands over a view of the file's column directly. */
    bone: Uint8Array | null = null;
    readonly minVoxelSize: number;
    readonly baseX: number;
    readonly baseY: number;
    readonly baseZ: number;

    /** Reused across forEach() so iteration allocates nothing. */
    private readonly _scratch: OctreeLeaf = { x: 0, y: 0, z: 0, size: 0, r: 0, g: 0, b: 0 };

    constructor(count: number, minVoxelSize: number, baseX: number, baseY: number, baseZ: number) {
        this.count = count;
        this.gx = new Uint16Array(count);
        this.gy = new Uint16Array(count);
        this.gz = new Uint16Array(count);
        this.lod = new Uint8Array(count);
        this.color = new Uint16Array(count);
        this.minVoxelSize = minVoxelSize;
        this.baseX = baseX;
        this.baseY = baseY;
        this.baseZ = baseZ;
    }

    worldX(i: number): number { return this.gx[i]! * this.minVoxelSize + this.baseX; }
    worldY(i: number): number { return this.gy[i]! * this.minVoxelSize + this.baseY; }
    worldZ(i: number): number { return this.gz[i]! * this.minVoxelSize + this.baseZ; }
    worldSize(i: number): number { return this.minVoxelSize * (1 << this.lod[i]!); }

    /** Iterate with a single REUSED scratch leaf — zero per-leaf allocation. The leaf is
     *  valid only for the duration of the callback; copy fields out if you keep it. */
    forEach(cb: (leaf: OctreeLeaf, i: number) => void): void {
        const s = this._scratch;
        for (let i = 0; i < this.count; i++) {
            s.x = this.worldX(i); s.y = this.worldY(i); s.z = this.worldZ(i);
            s.size = this.worldSize(i);
            const c = this.color[i]!;
            s.r = ((c >> 8) & 0xF) / 15; s.g = ((c >> 4) & 0xF) / 15; s.b = (c & 0xF) / 15;
            s.emissive = this.emiss ? this.emiss[i]! : 0;
            s.slot = this.slot ? this.slot[i]! : 0;
            cb(s, i);
        }
    }

    /** Materialise standalone leaf objects. Allocates — for the rare editor / destruction
     *  paths only, never the hot load path.
     *
     *  Pass the owning object's `useAtlas` whenever the leaves may be RE-ENCODED
     *  (the editor path). An atlas asset's stored cell already has the sRGB OETF
     *  baked in, so handing the raw `v4/15` fractions back to the encoder — which
     *  treats leaf floats as linear and encodes again — brightens every mid-tone
     *  and shifts the whole model's palette on save. Runtime-only consumers
     *  (explosion fragments, pristine ops) keep the default. */
    toArray(useAtlas = false): OctreeLeaf[] {
        const out = new Array<OctreeLeaf>(this.count);
        for (let i = 0; i < this.count; i++) {
            const c = this.color[i]!;
            const rgb = useAtlas ? atlasCellToLinearRgb(c) : unpackRgb444(c);
            out[i] = {
                x: this.worldX(i), y: this.worldY(i), z: this.worldZ(i), size: this.worldSize(i),
                r: rgb.r, g: rgb.g, b: rgb.b,
                emissive: this.emiss ? this.emiss[i]! : 0,
                slot: this.slot ? this.slot[i]! : 0,
                blockType: this.blockType ? this.blockType[i]! : 0,
                bone: this.bone ? this.bone[i]! : 0,
            };
        }
        return out;
    }

    /**
     * The leaves for which `keep(i)` is true, as a new buffer sharing this one's
     * frame. Optional columns come along only when present here, so a subset of
     * a plain buffer stays plain. Used to split a smart object into its parts:
     * each part meshes its own subset, and the faces between two parts — which a
     * whole-object mesh culls as interior — are exactly the faces that show once
     * a part turns.
     */
    subset(keep: (index: number) => boolean): LeafBuffer {
        let n = 0;
        for (let i = 0; i < this.count; i++) if (keep(i)) n++;
        const out = new LeafBuffer(n, this.minVoxelSize, this.baseX, this.baseY, this.baseZ);
        if (this.emiss) out.emiss = new Uint8Array(n);
        if (this.slot) out.slot = new Uint8Array(n);
        if (this.blockType) out.blockType = new Uint16Array(n);
        if (this.bone) out.bone = new Uint8Array(n);
        let j = 0;
        for (let i = 0; i < this.count; i++) {
            if (!keep(i)) continue;
            out.gx[j] = this.gx[i]!; out.gy[j] = this.gy[i]!; out.gz[j] = this.gz[i]!;
            out.lod[j] = this.lod[i]!; out.color[j] = this.color[i]!;
            if (out.emiss) out.emiss[j] = this.emiss![i]!;
            if (out.slot) out.slot[j] = this.slot![i]!;
            if (out.blockType) out.blockType[j] = this.blockType![i]!;
            if (out.bone) out.bone[j] = this.bone![i]!;
            j++;
        }
        return out;
    }

    /** Build a LeafBuffer from world-space `OctreeLeaf` objects (bridge for the editor /
     *  VWLD-load paths that still produce object arrays). Colour is quantised to RGB444. */
    static fromArray(leaves: OctreeLeaf[], minVoxelSize: number, baseX: number, baseY: number, baseZ: number): LeafBuffer {
        const buf = new LeafBuffer(leaves.length, minVoxelSize, baseX, baseY, baseZ);
        const inv = 1 / minVoxelSize;
        // Emissive / slot columns are allocated only when the input actually carries them,
        // so plain assets keep the same per-leaf footprint they always had.
        const hasEmissive = leaves.some((l) => (l.emissive ?? 0) > 0);
        const hasSlot = leaves.some((l) => (l.slot ?? 0) > 0);
        const hasBlockType = leaves.some((l) => (l.blockType ?? 0) > 0);
        const hasBone = leaves.some((l) => (l.bone ?? 0) > 0);
        if (hasEmissive) buf.emiss = new Uint8Array(leaves.length);
        if (hasSlot) buf.slot = new Uint8Array(leaves.length);
        if (hasBlockType) buf.blockType = new Uint16Array(leaves.length);
        if (hasBone) buf.bone = new Uint8Array(leaves.length);
        for (let i = 0; i < leaves.length; i++) {
            const l = leaves[i]!;
            buf.gx[i] = Math.round((l.x - baseX) * inv);
            buf.gy[i] = Math.round((l.y - baseY) * inv);
            buf.gz[i] = Math.round((l.z - baseZ) * inv);
            buf.lod[i] = Math.round(Math.log2(Math.max(1, l.size * inv)));
            buf.color[i] = packRgb444(l.r, l.g, l.b);
            if (buf.emiss) buf.emiss[i] = l.emissive ?? 0;
            if (buf.slot) buf.slot[i] = l.slot ?? 0;
            if (buf.blockType) buf.blockType[i] = l.blockType ?? 0;
            if (buf.bone) buf.bone[i] = l.bone ?? 0;
        }
        return buf;
    }
}

/**
 * Leaves in either storage form — the compact LeafBuffer or materialised
 * OctreeLeaf objects. Geometry-only consumers (collision, volume, the shadow
 * proxy) accept this so a huge asset never has to expand its buffer: the
 * materialised form costs ~10× the bytes and, through the `octreeLeaves`
 * getter, the expansion is permanent.
 */
export type LeafSource = ReadonlyArray<OctreeLeaf> | LeafBuffer;

/**
 * One source or several — the multi-fragment union paths hand every fragment's
 * resident storage over as a list instead of flatMap-ing them into one giant
 * array.
 */
export type LeafSources = LeafSource | ReadonlyArray<LeafSource>;

/**
 * Normalise LeafSources to a list. An array is either a list of sources or a
 * list of leaves — its first element tells which, since a leaf is a plain
 * object, never an array or a LeafBuffer.
 */
function leafSourceList(src: LeafSources): ReadonlyArray<LeafSource> {
    if (src instanceof LeafBuffer) return [src];
    if (src.length === 0) return [];
    const first = src[0]!;
    return (first instanceof LeafBuffer || Array.isArray(first))
        ? (src as ReadonlyArray<LeafSource>)
        : [src as ReadonlyArray<OctreeLeaf>];
}

/** Total leaf count across sources, without touching a single leaf. */
export function leafSourceCount(src: LeafSources): number {
    let n = 0;
    for (const s of leafSourceList(src)) n += s instanceof LeafBuffer ? s.count : s.length;
    return n;
}

/**
 * Iterate every leaf across sources without materialising buffers.
 * Buffer-backed sources hand `cb` a REUSED scratch leaf (see
 * LeafBuffer.forEach) — copy fields out, never retain it.
 */
export function forEachLeaf(src: LeafSources, cb: (leaf: OctreeLeaf) => void): void {
    for (const s of leafSourceList(src)) {
        if (s instanceof LeafBuffer) s.forEach(cb);
        else for (const leaf of s) cb(leaf);
    }
}

/**
 * Whether a sphere intersects the octree leaf's axis-aligned box in pivot-subtracted local space
 * (same convention as greedyMeshOctreeLeaves and mesh: min corner at leaf.{xyz} − pivot, extent leaf.size).
 * Using leaf centers only misses surface/near-edge blasts while colliders still register hits.
 */
export function octreeLeafIntersectsSpherePivotLocal(
    leaf: OctreeLeaf,
    pivotX: number,
    pivotY: number,
    pivotZ: number,
    sphereX: number,
    sphereY: number,
    sphereZ: number,
    radiusSq: number,
): boolean {
    const minX = leaf.x - pivotX;
    const minY = leaf.y - pivotY;
    const minZ = leaf.z - pivotZ;
    const maxX = leaf.x + leaf.size - pivotX;
    const maxY = leaf.y + leaf.size - pivotY;
    const maxZ = leaf.z + leaf.size - pivotZ;

    const cx = Math.max(minX, Math.min(sphereX, maxX));
    const cy = Math.max(minY, Math.min(sphereY, maxY));
    const cz = Math.max(minZ, Math.min(sphereZ, maxZ));
    const dx = sphereX - cx;
    const dy = sphereY - cy;
    const dz = sphereZ - cz;
    return dx * dx + dy * dy + dz * dz <= radiusSq;
}

// ─── Octree traversal ────────────────────────────────────────────────

export function flattenOctreeLeaves(node: OctreeNodeV2 | null, out: OctreeLeaf[]): void {
    if (!node) return;
    if (node.children) {
        for (const child of node.children) flattenOctreeLeaves(child, out);
        return;
    }
    if (!node.color) return;
    const c = node.color;
    const r5 = (c >> 11) & 0x1F;
    const g6 = (c >> 5) & 0x3F;
    const b5 = c & 0x1F;
    out.push({
        x: node.min[0], y: node.min[1], z: node.min[2], size: node.size,
        r: ((r5 << 3) | (r5 >> 2)) / 255,
        g: ((g6 << 2) | (g6 >> 4)) / 255,
        b: ((b5 << 3) | (b5 >> 2)) / 255,
    });
}

// ─── Mesh generation ─────────────────────────────────────────────────

const FACE_NORMALS = [0, 0, -1, 0, 0, 1, -1, 0, 0, 1, 0, 0, 0, -1, 0, 0, 1, 0];

/** Which atlas tile a face samples. Block textures differ top/side/bottom (grass, logs). */
const FACE_TEXTURE_KIND: ReadonlyArray<'top' | 'side' | 'bottom'> =
    ['side', 'side', 'side', 'side', 'bottom', 'top'];

/**
 * Per-face, per-vertex (u,v) in 0..1 across the face — what a TEXTURED block needs, as
 * opposed to the single centre point a flat colour uses.
 *
 * Derived from `FACE_TEMPLATES` rather than tabulated by hand: each face is axis-aligned,
 * so its two in-plane axes span -0.5..0.5 and map straight onto the tile. Deriving it
 * keeps the two tables from drifting apart — a hand-written copy that disagreed about
 * vertex order would texture the face rotated, which is the kind of defect that survives
 * review because every individual number looks plausible.
 */
const FACE_UV_TEMPLATES: Float32Array = (() => {
    const out = new Float32Array(6 * 4 * 2);
    for (let fi = 0; fi < 6; fi++) {
        // The axis this face faces along; the other two are its in-plane axes.
        const nx = FACE_NORMALS[fi * 3]!, ny = FACE_NORMALS[fi * 3 + 1]!;
        const normalAxis = nx !== 0 ? 0 : ny !== 0 ? 1 : 2;
        const uAxis = normalAxis === 0 ? 2 : 0;
        const vAxis = normalAxis === 1 ? 2 : 1;
        for (let v = 0; v < 4; v++) {
            const tmpl = FACE_TEMPLATES[fi * 4 + v]!;
            out[(fi * 4 + v) * 2] = (tmpl[uAxis] ?? 0) + 0.5;
            // Texture V runs down the image while world +Y runs up, so the vertical axis
            // is flipped — without this, every side texture renders upside down.
            out[(fi * 4 + v) * 2 + 1] = 0.5 - (tmpl[vAxis] ?? 0);
        }
    }
    return out;
})();

/** Largest occupancy grid we are willing to allocate for hidden-face removal
 *  (~64 MB as Uint8). Above this we skip culling and emit every face — a tiny
 *  object will never hit it; a pathologically huge bbox degrades to old behaviour. */
const MAX_OCCUPANCY_CELLS = 64_000_000;

/** Tolerance (in `step` units) for treating a leaf as sitting exactly on the
 *  occupancy lattice. Aligned octree data rounds to <1e-6; a larger fractional
 *  offset means the leaves don't share one voxel size, so culling is skipped. */
const LATTICE_EPS = 1e-4;

/**
 * Is cube face `fi` of the leaf occupying cells [ix..ix+L)×[iy..iy+L)×[iz..iz+L)
 * fully occluded? True iff every cell in the L×L slab directly outside that face
 * is occupied (and in-bounds). A slab cell that is out of bounds counts as air,
 * so object-surface faces are always kept. Face order: [-Z, +Z, -X, +X, -Y, +Y].
 */
function faceHidden(
    occ: Uint8Array, nx: number, ny: number, nz: number, nxy: number,
    ix: number, iy: number, iz: number, L: number, fi: number,
): boolean {
    switch (fi) {
        case 0: { // -Z
            const z = iz - 1; if (z < 0) return false;
            const zb = z * nxy;
            for (let y = iy; y < iy + L; y++) { const yb = zb + y * nx; for (let x = ix; x < ix + L; x++) if (!occ[yb + x]) return false; }
            return true;
        }
        case 1: { // +Z
            const z = iz + L; if (z >= nz) return false;
            const zb = z * nxy;
            for (let y = iy; y < iy + L; y++) { const yb = zb + y * nx; for (let x = ix; x < ix + L; x++) if (!occ[yb + x]) return false; }
            return true;
        }
        case 2: { // -X
            const x = ix - 1; if (x < 0) return false;
            for (let z = iz; z < iz + L; z++) { const zb = z * nxy; for (let y = iy; y < iy + L; y++) if (!occ[zb + y * nx + x]) return false; }
            return true;
        }
        case 3: { // +X
            const x = ix + L; if (x >= nx) return false;
            for (let z = iz; z < iz + L; z++) { const zb = z * nxy; for (let y = iy; y < iy + L; y++) if (!occ[zb + y * nx + x]) return false; }
            return true;
        }
        case 4: { // -Y
            const y = iy - 1; if (y < 0) return false;
            for (let z = iz; z < iz + L; z++) { const zb = z * nxy + y * nx; for (let x = ix; x < ix + L; x++) if (!occ[zb + x]) return false; }
            return true;
        }
        default: { // +Y (fi === 5)
            const y = iy + L; if (y >= ny) return false;
            for (let z = iz; z < iz + L; z++) { const zb = z * nxy + y * nx; for (let x = ix; x < ix + L; x++) if (!occ[zb + x]) return false; }
            return true;
        }
    }
}

/**
 * `mesh.userData` key holding the `VoxelSlotMaterialHandle[]` for a mesh with
 * named material slots — how `VoxelObject.setSlotEmissive` reaches the live
 * emissive control without every caller knowing the material layout.
 */
export const VOXEL_SLOT_HANDLES = 'voxelSlotHandles';

/** A mesh's material-slot split: the named slots and their index-buffer ranges. */
export interface VoxelSlotPlan {
    /** Named slots, describing material indices 1..N (0 is the base material). */
    slots: VoxelSlot[];
    /** Index range per material, `groups[0]` = base. Length is slots.length + 1. */
    groups: Array<{ start: number; count: number }>;
}

/**
 * Reorder an index buffer so every material's triangles are contiguous, and
 * report each material's range.
 *
 * Vertex data is left exactly where it was — only the index buffer moves — so
 * this is independent of how the caller emitted geometry (sharp faces, rounded
 * arcs, greedy-merged rects) and costs nothing for the slot-free assets that
 * never call it.
 */
function groupIndicesBySlot(
    indices: Uint32Array,
    /** Material index per TRIANGLE (indices.length / 3 entries). */
    triSlot: Uint8Array,
    materialCount: number,
): { indices: Uint32Array; groups: Array<{ start: number; count: number }> } {
    const triCount = triSlot.length;
    const counts = new Uint32Array(materialCount);
    for (let t = 0; t < triCount; t++) counts[triSlot[t]!]!++;

    const groups: Array<{ start: number; count: number }> = [];
    const cursor = new Uint32Array(materialCount);
    let start = 0;
    for (let m = 0; m < materialCount; m++) {
        cursor[m] = start;
        groups.push({ start, count: counts[m]! * 3 });
        start += counts[m]! * 3;
    }

    const out = new Uint32Array(indices.length);
    for (let t = 0; t < triCount; t++) {
        const m = triSlot[t]!;
        const dst = cursor[m]!;
        out[dst] = indices[t * 3]!;
        out[dst + 1] = indices[t * 3 + 1]!;
        out[dst + 2] = indices[t * 3 + 2]!;
        cursor[m] = dst + 3;
    }
    return { indices: out, groups };
}

/**
 * Wrap finished vertex/index buffers in a voxel mesh. Two color paths:
 *  - `uvs` provided (atlas mode): per-vertex UVs into the shared sRGB color-palette atlas
 *    + an atlas-textured material — the same color pipeline vwld uses, so colors match and
 *    the texture is shared across objects.
 *  - `colors` provided (vertex-color mode): per-vertex RGB + a vertexColors material.
 * Either way the per-object polygon offset is kept so z-fighting behaves as before.
 */
function assembleVoxelMesh(
    positions: Float32Array, colors: Float32Array | null, uvs: Float32Array | null,
    norms: Float32Array, indices: Uint32Array,
    shadows: boolean, zFightingId: string,
    /**
     * Shade using the provided vertex normals instead of flat face normals.
     * REQUIRED for rounded-edge geometry: its arcs carry analytic curved
     * normals, and flat shading would render each chamfer segment as a
     * visible facet instead of a smooth round-over.
     */
    smoothShading: boolean = false,
    /**
     * Per-vertex emissive 0..1, one float per vertex (parallel to `positions`).
     * Present only when the asset carries emissive; when omitted no `emissive`
     * attribute is added, so non-emissive geometry is byte-identical to before.
     * The emissive material (Task 3) reads this attribute; the current
     * MeshLambertMaterial ignores an unknown attribute, so geometry stays valid.
     */
    emissives?: Float32Array,
    /**
     * Material-slot split. When present, `indices` is already ordered
     * slot-major and `groups[i]` is material i's index range (0 = the base
     * material, i>0 = `slots[i-1]`). Absent for every slot-free asset, which
     * therefore builds exactly the single-material, single-draw-call mesh it
     * always did.
     */
    slotPlan?: VoxelSlotPlan,
    /**
     * Smallest leaf edge in world units. Only used to size the shading-normal
     * smoothing radius for shiny material slots, so a caller with no slots may
     * leave it at 0 and nothing reads it.
     */
    voxelSize: number = 0,
): THREE.Mesh {
    // Shading normals BEFORE the attribute is built, because a shiny material
    // class needs them: with six flat face normals a metal slot returns three
    // flat reflection tones. Only the shiny slots' vertices are rewritten, and
    // nothing happens at all for an asset whose slots are all `matte` — which is
    // every asset that predates material classes.
    //
    // Rounded-edge geometry is already there: `smoothShading` means the arcs
    // carry curved ANALYTIC normals, which is the thing the smoothing pass
    // approximates. So every slot counts as smoothed and no pass runs — averaging
    // the arcs would only flatten what the emitter computed exactly.
    // Resolved once per assembly (URL + localStorage reads), and only when slots
    // exist at all — a slot-free mesh never probes the platform.
    const materialQuality = slotPlan && slotPlan.slots.length > 0
        ? activeMaterialQuality()
        : DEFAULT_MATERIAL_QUALITY;
    const slotShading = slotPlan && slotPlan.slots.length > 0
        ? (smoothShading
            ? { smoothed: slotPlan.slots.map(() => true), stamp: null }
            : smoothSlotShadingNormals({
                positions, normals: norms, indices,
                slots: slotPlan.slots, groups: slotPlan.groups, voxelSize,
                materialQuality,
            }))
        : null;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(norms, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    if (emissives) {
        geometry.setAttribute('emissive', new THREE.BufferAttribute(emissives, 1));
    }
    // Tells `applyVoxelFinishToMesh` not to smooth this geometry a second time —
    // averaging already-averaged normals flattens the surface further.
    if (slotShading?.stamp) {
        stampShadingSmoothed(geometry, slotShading.stamp.strength, slotShading.stamp.radiusVoxels);
    }

    const zOffset = getZFightingRegistry().acquireObjectOffset(zFightingId);
    if (uvs) {
        geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    } else {
        geometry.setAttribute('color', new THREE.BufferAttribute(colors!, 3));
    }
    // Dual-path (WebGPU/WebGL) material; glows per-vertex only when the mesh
    // carries an `emissive` attribute. Non-emissive meshes get the plain Lambert
    // material identical to before. The atlas path shares the atlas texture via
    // `map` — getVoxelTextureAtlas().createMaterial() used the same getTexture().
    const materialParams = {
        map: uvs ? getVoxelTextureAtlas().getTexture() : null,
        vertexColors: !uvs,
        flatShading: !smoothShading,
        polygonOffsetFactor: zOffset.factor,
        polygonOffsetUnits: zOffset.units,
    };
    const baseMaterial = createVoxelMaterial(materialParams, !!emissives);

    // Named slots become extra geometry GROUPS over the same buffers — one
    // extra draw call each, one material each whose emissive is settable at
    // runtime, and one material CLASS each deciding how it responds to light.
    // The base material keeps group 0 and never changes class, so slot-0 voxels
    // (all of them, in an ordinary asset) render exactly as before.
    //
    // Note an all-one-class asset needs no special handling: `addGroup` below is
    // skipped for an empty range, so if a class owns every palette entry the base
    // group is never drawn — no extra draw call, and no Lambert group for the
    // shiny one to seam against.
    let material: THREE.Material | THREE.Material[] = baseMaterial;
    let slotHandles: VoxelSlotMaterialHandle[] = [];
    if (slotPlan && slotPlan.slots.length > 0) {
        slotHandles = slotPlan.slots.map(
            (slot, i) => createVoxelSlotMaterial(materialParams, slot, slotShading?.smoothed[i] === true, materialQuality),
        );
        material = [baseMaterial, ...slotHandles.map((h) => h.material)];
        for (let i = 0; i < slotPlan.groups.length; i++) {
            const group = slotPlan.groups[i]!;
            if (group.count > 0) geometry.addGroup(group.start, group.count, i);
        }
    }

    const mesh = new THREE.Mesh(geometry, material);
    if (slotHandles.length > 0) {
        mesh.userData[VOXEL_SLOT_HANDLES] = slotHandles;
    }
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
    mesh.name = 'VoxelMesh';
    // Every VoxelObject render path (individual objects, v3 fragments, LOD
    // templates, chunked-terrain LODs, debris, previews) assembles here, so
    // this is the one choke point for the post-upload CPU release. Always
    // keep-pickable: individual objects can be damageable/dynamic (melee
    // sweeps THREE-raycast them) and editor click-select needs position +
    // index. Template meshes that are only ever clone sources are never
    // drawn, so their release never fires and their arrays stay intact.
    releaseMeshCpuBuffersAfterUpload(mesh, 'keep-pickable');
    return mesh;
}

/**
 * Rounded-edge emitter for octree leaves. Mirrors the semantics VoxelWorld uses
 * for its greedy boxes: a leaf edge is rounded when both adjacent faces are
 * exposed; an outer corner with all 3 faces exposed gets a sphere octant; a
 * corner with exactly 2 hidden faces whose diagonal cell is empty gets an
 * L-shape concave patch. Exposure comes from the per-leaf face mask, concavity
 * from the occupancy grid — both already computed by the culling pass.
 *
 * Geometry size is data-dependent (arcs, octants), so this path builds plain
 * number arrays instead of the sharp path's preallocated buffers.
 *
 * Flat-face pooling: a face with no rounded edges and no L-chords (the entire
 * interior of any flat region) is geometrically a full lattice-aligned square.
 * Emitting it per leaf wastes triangles and — across mixed-size coplanar
 * leaves — creates T-junction hairline cracks. Such faces are diverted into
 * per-axis-plane pools and greedy-merged into maximal same-color rectangles;
 * only faces actually touching a rounded edge/corner go through
 * `appendRoundedVoxelMesh`. The rounded rim keeps its vertices on the same
 * lattice lines the merged rectangles use, so the two pools stitch exactly.
 */

/** For each face index, the 4 faces sharing an edge with it (all but itself and its opposite). */
const PERP_FACES: readonly (readonly [number, number, number, number])[] = [
    [2, 3, 4, 5], [2, 3, 4, 5], [0, 1, 4, 5], [0, 1, 4, 5], [0, 1, 2, 3], [0, 1, 2, 3],
];
/** Corner octant lies on face fi's side iff ((oct >> FACE_OCT_SHIFT[fi]) & 1) === FACE_OCT_BIT[fi].
 *  Octant bit layout: ((sx>0?1:0)<<2) | ((sy>0?1:0)<<1) | (sz>0?1:0). */
const FACE_OCT_SHIFT = [0, 0, 2, 2, 1, 1] as const;
const FACE_OCT_BIT = [0, 1, 0, 1, 0, 1] as const;

function meshRoundedVoxelColumns(
    n: number,
    minX: Float64Array, minY: Float64Array, minZ: Float64Array, size: Float64Array,
    r: Float32Array, g: Float32Array, b: Float32Array,
    occ: Uint8Array, nx: number, ny: number, nz: number, nxy: number,
    cix: Int32Array, ciy: Int32Array, ciz: Int32Array, cL: Int32Array,
    mask: Uint8Array,
    step: number,
    oMinX: number, oMinY: number, oMinZ: number,
    pivotX: number, pivotY: number, pivotZ: number,
    shadows: boolean, zFightingId: string,
    atlasMode: boolean,
    rounding: OctreeMeshRounding,
    /** Per-leaf emissive 0-1, or null when the asset carries none. */
    emiss: Float32Array | null = null,
    /** Per-leaf material slot (0 = base), or null when the asset declares none. */
    slotCol: Uint8Array | null = null,
    slots: VoxelSlot[] = [],
): THREE.Mesh | null {
    const positions: number[] = [];
    const colors: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    // One float per VERTEX, appended in lockstep with `positions`. Null for
    // non-emissive assets so their geometry stays byte-identical.
    const emissives: number[] | null = emiss ? [] : null;
    // Material index per TRIANGLE, appended in lockstep with `indices`. Null for
    // slot-free assets. The rounded emitter owns its own index layout, so each
    // leaf's contribution is measured after the fact rather than predicted.
    const useSlots = slotCol !== null && slots.length > 0;
    const triSlots: number[] | null = useSlots ? [] : null;

    /**
     * Plain faces merge by an opaque integer key, so anything that must NOT be
     * averaged across a merge has to ride in it — otherwise a glowing face and
     * an unlit face of the SAME colour merge into one rect and the glow is lost,
     * and a beacon face merges with a body face into one material. Packing
     * rgb24|emissive|slot into one int overflows Int32 (the merge grid), so keys
     * are registry indices.
     */
    const faceKeys: Array<{ rgb24: number; e: number; slot: number }> = [];
    const faceKeyByComposite = new Map<number, number>();
    const keyed = !!emissives || useSlots;
    const faceKeyFor = (rgb24: number, e: number, slot: number): number => {
        if (!keyed) return rgb24;
        const composite = (rgb24 * 256 + e) * 256 + slot;
        let idx = faceKeyByComposite.get(composite);
        if (idx === undefined) {
            idx = faceKeys.length;
            faceKeys.push({ rgb24, e, slot });
            faceKeyByComposite.set(composite, idx);
        }
        return idx;
    };
    const rgb24OfKey = (key: number): number => (keyed ? faceKeys[key]!.rgb24 : key);
    const emissiveOfKey = (key: number): number => (keyed ? faceKeys[key]!.e / 255 : 0);
    const slotOfKey = (key: number): number => (keyed ? faceKeys[key]!.slot : 0);

    const atlas = atlasMode ? getVoxelTextureAtlas() : null;
    const radius = rounding.radiusVoxels * step;
    const segments = Math.max(1, rounding.segments);

    const isOcc = (x: number, y: number, z: number): boolean =>
        x >= 0 && y >= 0 && z >= 0 && x < nx && y < ny && z < nz && occ[z * nxy + y * nx + x] === 1;

    const exposed: boolean[] = [false, false, false, false, false, false];
    const exposedRim: boolean[] = [false, false, false, false, false, false];
    const cornerFlags: boolean[] = [false, false, false, false, false, false, false, false];

    // Plain-face pools, keyed by face index x slice plane (cell coordinate of
    // the face plane along the face's normal axis).
    const planeStride = Math.max(nx, ny, nz) + 1;
    const plainPools = new Map<number, FlatFaceSquare[]>();
    const poolPlainFace = (fi: number, x0: number, y0: number, z0: number, L: number, mergeKey: number): void => {
        // In-plane axes (au, av) chosen so unit(au) x unit(av) = face normal;
        // the rect emitter walks (u0,v0)->(u1,v0)->(u1,v1)->(u0,v1) CCW.
        let plane: number, u0: number, v0: number;
        switch (fi) {
            case 0: plane = z0; u0 = y0; v0 = x0; break;         // -Z: au=Y, av=X
            case 1: plane = z0 + L; u0 = x0; v0 = y0; break;     // +Z: au=X, av=Y
            case 2: plane = x0; u0 = z0; v0 = y0; break;         // -X: au=Z, av=Y
            case 3: plane = x0 + L; u0 = y0; v0 = z0; break;     // +X: au=Y, av=Z
            case 4: plane = y0; u0 = x0; v0 = z0; break;         // -Y: au=X, av=Z
            default: plane = y0 + L; u0 = z0; v0 = x0; break;    // +Y: au=Z, av=X
        }
        const key = fi * planeStride + plane;
        let pool = plainPools.get(key);
        if (!pool) { pool = []; plainPools.set(key, pool); }
        pool.push({ u0, v0, size: L, color: mergeKey });
    };

    for (let i = 0; i < n; i++) {
        const m = mask[i]!;
        if (m === 0) continue;
        for (let fi = 0; fi < 6; fi++) exposed[fi] = (m & (1 << fi)) !== 0;

        // L-shape concave corners: exactly 2 of the octant's 3 faces hidden and
        // the diagonal cell past the leaf's corner-most cell (offset along the
        // 2 hidden axes) empty. Same rule as VoxelWorld.getCornerRoundedFlags.
        const x0 = cix[i]!, y0 = ciy[i]!, z0 = ciz[i]!, L = cL[i]!;
        for (let oct = 0; oct < 8; oct++) {
            cornerFlags[oct] = false;
            const sxPos = (oct & 4) !== 0;
            const syPos = (oct & 2) !== 0;
            const szPos = (oct & 1) !== 0;
            const hX = !exposed[sxPos ? 3 : 2];
            const hY = !exposed[syPos ? 5 : 4];
            const hZ = !exposed[szPos ? 1 : 0];
            const hiddenCount = (hX ? 1 : 0) + (hY ? 1 : 0) + (hZ ? 1 : 0);
            if (hiddenCount !== 2) continue;
            const cx0 = x0 + (sxPos ? L - 1 : 0);
            const cy0 = y0 + (syPos ? L - 1 : 0);
            const cz0 = z0 + (szPos ? L - 1 : 0);
            const dx = cx0 + (hX ? (sxPos ? 1 : -1) : 0);
            const dy = cy0 + (hY ? (syPos ? 1 : -1) : 0);
            const dz = cz0 + (hZ ? (szPos ? 1 : -1) : 0);
            if (!isOcc(dx, dy, dz)) cornerFlags[oct] = true;
        }

        const s = size[i]!;
        const lr = r[i]!, lg = g[i]!, lb = b[i]!;
        // RGB444-derived floats round-trip to the exact 0-255 cell representative
        // (nibble·17), so this palette lookup matches the sharp path's UV centre.
        const rgb24 = (Math.round(lr * 255) << 16) | (Math.round(lg * 255) << 8) | Math.round(lb * 255);
        const leafEmissive = emiss ? emiss[i]! : 0;
        const leafEmissiveByte = Math.round(leafEmissive * 255);
        const leafSlot = slotCol ? slotCol[i]! : 0;
        const mergeKey = faceKeyFor(rgb24, leafEmissiveByte, leafSlot);

        // Split exposed faces into the plain pool (no rounded edges — none of
        // the 4 edge-sharing faces exposed — and no L-chord on any of the
        // face's corner octants) and the rounded rim. A plain face's polygon
        // is exactly its full square, so pooling it changes no geometry; and
        // since all its edges are unrounded and its corners unflagged, hiding
        // it from appendRoundedVoxelMesh changes no cylinder/sphere/patch.
        let anyRim = false;
        for (let fi = 0; fi < 6; fi++) {
            exposedRim[fi] = false;
            if (!exposed[fi]) continue;
            const perp = PERP_FACES[fi]!;
            let plain = !exposed[perp[0]]! && !exposed[perp[1]]! && !exposed[perp[2]]! && !exposed[perp[3]]!;
            if (plain) {
                const shift = FACE_OCT_SHIFT[fi]!, bit = FACE_OCT_BIT[fi]!;
                for (let oct = 0; oct < 8; oct++) {
                    if (((oct >> shift) & 1) === bit && cornerFlags[oct]) { plain = false; break; }
                }
            }
            if (plain) poolPlainFace(fi, x0, y0, z0, L, mergeKey);
            else { exposedRim[fi] = true; anyRim = true; }
        }
        if (!anyRim) continue;

        const roundedAtlas: RoundedAtlasContext | null = atlas ? {
            isColorPalette: true,
            rgb24,
            getAtlasRegionForFace: () => null,
            getPaletteUV: (c24: number) => atlas.getColorPaletteUV((c24 >>> 16) & 255, (c24 >>> 8) & 255, c24 & 255),
        } : null;

        const vertsBeforeRounded = positions.length / 3;
        const trisBeforeRounded = indices.length / 3;
        appendRoundedVoxelMesh({
            positions, colors, normals, uvs, indices,
            centerX: minX[i]! + s * 0.5 - pivotX,
            centerY: minY[i]! + s * 0.5 - pivotY,
            centerZ: minZ[i]! + s * 0.5 - pivotZ,
            width: s, height: s, depth: s,
            radius,
            segments,
            exposedFaces: exposedRim,
            cornerInnerFlags: cornerFlags,
            rgb: [lr, lg, lb],
            atlas: roundedAtlas,
            generateNormals: true,
        });
        // The rounded builder owns its own vertex layout (arcs, patches, caps),
        // so count what it produced rather than predicting it.
        if (emissives) {
            for (let v = positions.length / 3; v > vertsBeforeRounded; v--) emissives.push(leafEmissive);
        }
        if (triSlots) {
            for (let t = indices.length / 3; t > trisBeforeRounded; t--) triSlots.push(leafSlot);
        }
    }

    // Emit the plain pools: greedy-merge each axis-plane slice into maximal
    // same-color rectangles on the min-cell lattice, two triangles each.
    for (const [key, squares] of plainPools) {
        const fi = Math.floor(key / planeStride);
        const plane = key % planeStride;
        const nX = FACE_NORMALS[fi * 3]!, nY = FACE_NORMALS[fi * 3 + 1]!, nZ = FACE_NORMALS[fi * 3 + 2]!;
        for (const rect of mergeFlatFaceSquares(squares)) {
            const c24 = rgb24OfKey(rect.color);
            const rectEmissive = emissiveOfKey(rect.color);
            const cr = ((c24 >>> 16) & 255) / 255, cg = ((c24 >>> 8) & 255) / 255, cb = (c24 & 255) / 255;
            // Palette-cell UV centre for all 4 verts — same convention as the
            // sharp path (the cell is a single flat color, position within the
            // region is irrelevant).
            let cu = 0, cv = 0;
            if (atlas) {
                const region = atlas.getColorPaletteUV((c24 >>> 16) & 255, (c24 >>> 8) & 255, c24 & 255);
                cu = (region.u0 + region.u1) * 0.5;
                cv = (region.v0 + region.v1) * 0.5;
            }
            const base = positions.length / 3;
            // Corner walk (u0,v0) -> (u1,v0) -> (u1,v1) -> (u0,v1) is CCW from
            // outside for the (au, av) axis pairs chosen in poolPlainFace.
            for (let corner = 0; corner < 4; corner++) {
                const u = (corner === 1 || corner === 2) ? rect.u1 : rect.u0;
                const v = (corner === 2 || corner === 3) ? rect.v1 : rect.v0;
                let cx: number, cy: number, cz: number;
                switch (fi) {
                    case 0: cy = u; cx = v; cz = plane; break;
                    case 1: cx = u; cy = v; cz = plane; break;
                    case 2: cz = u; cy = v; cx = plane; break;
                    case 3: cy = u; cz = v; cx = plane; break;
                    case 4: cx = u; cz = v; cy = plane; break;
                    default: cz = u; cx = v; cy = plane; break;
                }
                positions.push(
                    oMinX + cx * step - pivotX,
                    oMinY + cy * step - pivotY,
                    oMinZ + cz * step - pivotZ,
                );
                colors.push(cr, cg, cb);
                normals.push(nX, nY, nZ);
                if (atlas) uvs.push(cu, cv);
                if (emissives) emissives.push(rectEmissive);
            }
            indices.push(base, base + 1, base + 2);
            indices.push(base, base + 2, base + 3);
            if (triSlots) {
                const rectSlot = slotOfKey(rect.color);
                triSlots.push(rectSlot, rectSlot);
            }
        }
    }

    if (positions.length === 0) return null;
    const indexArray = new Uint32Array(indices);
    const grouped = triSlots
        ? groupIndicesBySlot(indexArray, new Uint8Array(triSlots), slots.length + 1)
        : null;
    return assembleVoxelMesh(
        new Float32Array(positions),
        atlasMode ? null : new Float32Array(colors),
        atlasMode ? new Float32Array(uvs) : null,
        new Float32Array(normals),
        grouped ? grouped.indices : indexArray,
        shadows, zFightingId,
        true, // smooth shading — the rounded arcs carry curved analytic normals
        emissives ? new Float32Array(emissives) : undefined,
        grouped ? { slots, groups: grouped.groups } : undefined,
        // Unused on this path: `smoothShading` above already tells
        // `assembleVoxelMesh` these normals are curved, so no smoothing pass runs.
        0,
    );
}

/**
 * Shared builder for both octree mesh paths. Takes per-leaf columns in world
 * space (min corner, edge size, RGB 0-1) and emits one mesh with hidden-face
 * removal: any cube face fully occluded by its neighbour(s) is dropped. Faces on
 * the object surface — and faces only partially covered by a smaller neighbour —
 * are kept, so the rendered result is identical to emitting all six faces, just
 * with the invisible interior triangles gone.
 *
 * Culling runs on a dense occupancy grid rasterised at the smallest leaf size, so
 * mixed-LOD leaves and multi-fragment objects resolve correctly. Allocation is
 * sized to the surviving faces, so the giant interior of a solid-filled building
 * never reaches the vertex buffers. Returns null when there are no leaves.
 */
function meshFromVoxelColumns(
    n: number,
    minX: Float64Array, minY: Float64Array, minZ: Float64Array, size: Float64Array,
    r: Float32Array | null, g: Float32Array | null, b: Float32Array | null,
    pivotX: number, pivotY: number, pivotZ: number,
    shadows: boolean, zFightingId: string,
    uvU: Float32Array | null = null, uvV: Float32Array | null = null,
    rounding: OctreeMeshRounding | null = null,
    // Per-leaf emissive 0..1 (only when the asset has emissive; null otherwise).
    // Written to a parallel per-vertex `emissive` attribute at the same cadence
    // as position/color. Non-emissive assets pass null and pay nothing.
    emiss: Float32Array | null = null,
    // Per-leaf material slot (0 = base), and the names/defaults of slots 1..N.
    // Null / empty for every asset that declares no slots, which then takes the
    // exact single-material path it always did.
    slotCol: Uint8Array | null = null,
    slots: VoxelSlot[] = [],
    // Per-leaf textured block type (0 = coloured), and the atlas its tiles live in.
    // Null for every asset that has none, which then takes the exact path it always did.
    blockCol: Uint16Array | null = null,
    atlas: ReturnType<typeof getVoxelTextureAtlas> | null = null,
): THREE.Mesh | null {
    // Atlas mode: per-voxel UVs into the shared color-palette atlas (uvU/uvV set).
    // Otherwise: per-voxel RGB vertex colors (r/g/b set).
    const atlasMode = uvU !== null;
    if (n === 0) return null;

    // Uniform cell step = smallest leaf edge; bounding box in world space.
    let step = Infinity;
    let oMinX = Infinity, oMinY = Infinity, oMinZ = Infinity;
    let oMaxX = -Infinity, oMaxY = -Infinity, oMaxZ = -Infinity;
    for (let i = 0; i < n; i++) {
        const s = size[i]!;
        if (s < step) step = s;
        if (minX[i]! < oMinX) oMinX = minX[i]!;
        if (minY[i]! < oMinY) oMinY = minY[i]!;
        if (minZ[i]! < oMinZ) oMinZ = minZ[i]!;
        if (minX[i]! + s > oMaxX) oMaxX = minX[i]! + s;
        if (minY[i]! + s > oMaxY) oMaxY = minY[i]! + s;
        if (minZ[i]! + s > oMaxZ) oMaxZ = minZ[i]! + s;
    }
    if (!(step > 0) || !isFinite(step)) step = 1;
    const inv = 1 / step;
    const nx = Math.max(1, Math.round((oMaxX - oMinX) * inv));
    const ny = Math.max(1, Math.round((oMaxY - oMinY) * inv));
    const nz = Math.max(1, Math.round((oMaxZ - oMinZ) * inv));
    const nxy = nx * ny;

    // Per-leaf 6-bit visible-face mask + total surviving face count. Hidden-face
    // removal runs only when the grid is small enough to rasterise AND every leaf
    // sits on a single `step` lattice inside that grid; otherwise we keep all six
    // faces (the pre-culling output, always correct).
    const mask = new Uint8Array(n);
    let faces = 0;
    let culled = false;
    // Retained past culling when rounding is requested — the rounded emitter
    // reuses the occupancy grid for concave-corner (L-shape) detection.
    let occ: Uint8Array | null = null;
    let cix: Int32Array | null = null, ciy: Int32Array | null = null, ciz: Int32Array | null = null, cL: Int32Array | null = null;

    if (nx * ny * nz <= MAX_OCCUPANCY_CELLS) {
        // Integer cell coords per leaf. Bail out the moment a leaf is off-lattice
        // (fractional offset — e.g. fragments with incompatible minVoxelSize) or
        // would fall outside the grid (rounding overshoot): reading the wrong
        // occupancy cell could drop a genuinely visible face.
        cix = new Int32Array(n); ciy = new Int32Array(n); ciz = new Int32Array(n); cL = new Int32Array(n);
        let onLattice = true;
        for (let i = 0; i < n; i++) {
            const fx = (minX[i]! - oMinX) * inv, fy = (minY[i]! - oMinY) * inv, fz = (minZ[i]! - oMinZ) * inv;
            const fL = size[i]! * inv;
            const ax = Math.round(fx), ay = Math.round(fy), az = Math.round(fz), L = Math.max(1, Math.round(fL));
            if (Math.abs(fx - ax) > LATTICE_EPS || Math.abs(fy - ay) > LATTICE_EPS ||
                Math.abs(fz - az) > LATTICE_EPS || Math.abs(fL - L) > LATTICE_EPS ||
                ax < 0 || ay < 0 || az < 0 || ax + L > nx || ay + L > ny || az + L > nz) {
                onLattice = false;
                break;
            }
            cix[i] = ax; ciy[i] = ay; ciz[i] = az; cL[i] = L;
        }

        if (onLattice) {
            // Rasterise occupancy at min-leaf resolution.
            occ = new Uint8Array(nx * ny * nz);
            for (let i = 0; i < n; i++) {
                const x0 = cix[i]!, y0 = ciy[i]!, z0 = ciz[i]!, L = cL[i]!;
                for (let z = z0; z < z0 + L; z++) {
                    const zb = z * nxy;
                    for (let y = y0; y < y0 + L; y++) {
                        const yb = zb + y * nx;
                        for (let x = x0; x < x0 + L; x++) occ[yb + x] = 1;
                    }
                }
            }
            // Drop any face whose adjacent slab of cells is fully solid.
            for (let i = 0; i < n; i++) {
                let m = 0;
                for (let fi = 0; fi < 6; fi++) {
                    if (faceHidden(occ, nx, ny, nz, nxy, cix[i]!, ciy[i]!, ciz[i]!, cL[i]!, fi)) continue;
                    m |= (1 << fi);
                    faces++;
                }
                mask[i] = m;
            }
            culled = true;
        }
    }

    if (!culled) {
        mask.fill(0x3F); // all six faces (bits 0-5)
        faces = 6 * n;
    }

    // Rounded-edge path: replaces the sharp face emission entirely. Needs the
    // occupancy grid (exposure + concave-corner queries) and per-leaf RGB (the
    // atlas variant maps colors through the palette region, not a fixed UV
    // centre). Without occupancy (off-lattice / oversized grid) fall through to
    // the sharp path — always correct, just not rounded.
    if (rounding && rounding.radiusVoxels > 0) {
        if (culled && occ && cix && ciy && ciz && cL && r && g && b) {
            return meshRoundedVoxelColumns(
                n, minX, minY, minZ, size, r, g, b,
                occ, nx, ny, nz, nxy, cix, ciy, ciz, cL, mask,
                step, oMinX, oMinY, oMinZ, pivotX, pivotY, pivotZ, shadows, zFightingId,
                atlasMode, rounding, emiss, slotCol, slots,
            );
        }
        console.warn('[VoxelOctreeRenderer] Rounded edges requested but occupancy data unavailable (off-lattice leaves or oversized grid) — rendering sharp voxels.');
    }

    // Emit only the surviving faces.
    const positions = new Float32Array(faces * 12);
    const colors = atlasMode ? null : new Float32Array(faces * 12);
    const uvs = atlasMode ? new Float32Array(faces * 8) : null;
    const norms = new Float32Array(faces * 12);
    const indices = new Uint32Array(faces * 6);
    // One emissive float per vertex, only when the asset carries emissive.
    const emissives = emiss ? new Float32Array(faces * 4) : null;
    // Material index per triangle (2 per face), only when the asset has slots.
    const useSlots = slotCol !== null && slots.length > 0;
    const triSlot = useSlots ? new Uint8Array(faces * 2) : null;
    let vIdx = 0, pPtr = 0, iPtr = 0, uvPtr = 0, ePtr = 0, tPtr = 0;
    for (let i = 0; i < n; i++) {
        const m = mask[i]!;
        if (m === 0) continue;
        const s = size[i]!;
        const cx = minX[i]! + s * 0.5 - pivotX;
        const cy = minY[i]! + s * 0.5 - pivotY;
        const cz = minZ[i]! + s * 0.5 - pivotZ;
        const lr = r ? r[i]! : 0, lg = g ? g[i]! : 0, lb = b ? b[i]! : 0;
        const lu = uvU ? uvU[i]! : 0, lv = uvV ? uvV[i]! : 0;
        const le = emiss ? emiss[i]! : 0;
        const ls = slotCol ? slotCol[i]! : 0;
        const lblock = blockCol ? blockCol[i]! : 0;
        for (let fi = 0; fi < 6; fi++) {
            if ((m & (1 << fi)) === 0) continue;
            const fb = fi * 4;
            const fv = vIdx;
            // A textured block samples a whole tile ACROSS the face — top, side and bottom
            // can be different images. A coloured voxel keeps its single centre point,
            // because its "texture" is one atlas pixel and stretching it would be identical
            // but cost four lookups.
            const region = lblock > 0 && atlas ? atlas.getBlockUV(lblock, FACE_TEXTURE_KIND[fi]!) : null;
            for (let v = 0; v < 4; v++) {
                const tmpl = FACE_TEMPLATES[fb + v]!;
                positions[pPtr]     = cx + (tmpl[0] ?? 0) * s;
                positions[pPtr + 1] = cy + (tmpl[1] ?? 0) * s;
                positions[pPtr + 2] = cz + (tmpl[2] ?? 0) * s;
                if (region) {
                    const t = (fb + v) * 2;
                    uvs![uvPtr] = region.u0 + FACE_UV_TEMPLATES[t]! * (region.u1 - region.u0);
                    uvs![uvPtr + 1] = region.v0 + FACE_UV_TEMPLATES[t + 1]! * (region.v1 - region.v0);
                    uvPtr += 2;
                } else if (atlasMode) { uvs![uvPtr] = lu; uvs![uvPtr + 1] = lv; uvPtr += 2; }
                else { colors![pPtr] = lr; colors![pPtr + 1] = lg; colors![pPtr + 2] = lb; }
                norms[pPtr]     = FACE_NORMALS[fi * 3]!;
                norms[pPtr + 1] = FACE_NORMALS[fi * 3 + 1]!;
                norms[pPtr + 2] = FACE_NORMALS[fi * 3 + 2]!;
                pPtr += 3;
                if (emissives) { emissives[ePtr] = le; ePtr += 1; }
            }
            indices[iPtr]     = fv;     indices[iPtr + 1] = fv + 2; indices[iPtr + 2] = fv + 1;
            indices[iPtr + 3] = fv;     indices[iPtr + 4] = fv + 3; indices[iPtr + 5] = fv + 2;
            iPtr += 6;
            vIdx += 4;
            if (triSlot) { triSlot[tPtr] = ls; triSlot[tPtr + 1] = ls; tPtr += 2; }
        }
    }

    if (triSlot) {
        const grouped = groupIndicesBySlot(indices, triSlot, slots.length + 1);
        return assembleVoxelMesh(
            positions, colors, uvs, norms, grouped.indices, shadows, zFightingId, false,
            emissives ?? undefined, { slots, groups: grouped.groups },
            // `step` is the smallest leaf edge, which is what a shiny slot's
            // smoothing radius is expressed in multiples of.
            step,
        );
    }
    return assembleVoxelMesh(positions, colors, uvs, norms, indices, shadows, zFightingId, false, emissives ?? undefined);
}

export function buildOctreeMesh(
    leaves: OctreeLeaf[],
    pivotX: number, pivotY: number, pivotZ: number,
    shadows: boolean,
    zFightingId: string,
    rounding: OctreeMeshRounding | null = null,
    /** Named material slots the leaves' `slot` indices refer to; empty = base material only. */
    slots: VoxelSlot[] = [],
    /**
     * The owning object's atlas flag — pass the same value the leaves were
     * materialised with (`LeafBuffer.toArray(useAtlas)`), so their float colours
     * convert back to the exact atlas cell the buffer path reads from
     * `buf.color`. Appended last so existing positional callers keep meaning.
     */
    useAtlas: boolean = false,
): THREE.Mesh {
    const n = leaves.length;
    const minX = new Float64Array(n), minY = new Float64Array(n), minZ = new Float64Array(n), size = new Float64Array(n);
    // Mode rules MUST mirror buildOctreeMeshFromBuffers — the two front-ends
    // feed the same column builder, and any feature one of them drops changes
    // an object's look the first time a clone / carve / edit rebuilds it from
    // materialised leaves (textured voxels used to lose their block type here
    // and render with their palette colour: none, i.e. pure black). A textured
    // block IS an atlas lookup, so block types force atlas mode either way.
    const hasBlockTypes = leaves.some((l) => (l.blockType ?? 0) > 0);
    const atlasUvs = useAtlas || hasBlockTypes;
    const needRgb = !atlasUvs || rounding !== null;
    const r = needRgb ? new Float32Array(n) : null;
    const g = needRgb ? new Float32Array(n) : null;
    const b = needRgb ? new Float32Array(n) : null;
    const uvU = atlasUvs ? new Float32Array(n) : null;
    const uvV = atlasUvs ? new Float32Array(n) : null;
    const atlas = atlasUvs ? getVoxelTextureAtlas() : null;
    const blockColumn = hasBlockTypes ? new Uint16Array(n) : null;
    // Emissive column, allocated only when at least one leaf carries emissive.
    const hasEmissive = leaves.some((l) => (l.emissive ?? 0) > 0);
    const emiss = hasEmissive ? new Float32Array(n) : null;
    // Slot column, allocated only when the caller named slots AND a leaf is in one.
    const hasSlots = slots.length > 0 && leaves.some((l) => (l.slot ?? 0) > 0);
    const slotCol = hasSlots ? new Uint8Array(n) : null;
    for (let i = 0; i < n; i++) {
        const l = leaves[i]!;
        minX[i] = l.x; minY[i] = l.y; minZ[i] = l.z; size[i] = l.size;
        if (blockColumn) blockColumn[i] = l.blockType ?? 0;
        if (atlasUvs) {
            // Recover the RGB444 cell the buffer path reads straight from
            // `buf.color`. Atlas leaves hold LINEAR floats (`toArray` decoded the
            // cell's sRGB repr), so encoding rounds back to the exact cell; raw
            // non-atlas floats (forced into atlas mode by a block type) pack
            // directly. Edited colours land on the nearest cell — the same cell a
            // re-encode on save would pick.
            const cell = useAtlas
                ? rgb888ToAtlasCell(l.r * 255, l.g * 255, l.b * 255)
                : packRgb444(l.r, l.g, l.b);
            const repr = atlasCellRepr(cell);
            const uv = atlas!.getColorPaletteUV(repr.r, repr.g, repr.b);
            uvU![i] = (uv.u0 + uv.u1) * 0.5;
            uvV![i] = (uv.v0 + uv.v1) * 0.5;
            if (needRgb) {
                r![i] = ((cell >> 8) & 0xF) / 15; g![i] = ((cell >> 4) & 0xF) / 15; b![i] = (cell & 0xF) / 15;
            }
        } else {
            r![i] = l.r; g![i] = l.g; b![i] = l.b;
        }
        if (emiss) { emiss[i] = (l.emissive ?? 0) / 255; }
        if (slotCol) { slotCol[i] = l.slot ?? 0; }
    }
    // Object path keeps its non-null contract: an empty leaf set yields an empty mesh.
    return meshFromVoxelColumns(n, minX, minY, minZ, size, r, g, b, pivotX, pivotY, pivotZ, shadows, zFightingId, uvU, uvV, rounding, emiss, slotCol, slots, blockColumn, atlas)
        ?? assembleVoxelMesh(new Float32Array(0), new Float32Array(0), null, new Float32Array(0), new Uint32Array(0), shadows, zFightingId);
}

/**
 * Same geometry as `buildOctreeMesh`, but reads voxels straight from compact
 * `LeafBuffer` columns — never materialising `OctreeLeaf` objects. Accepts one
 * buffer per fragment and lays them all into a single mesh. This is the decode /
 * load path (the one that OOMs on iOS with the object form). Returns null when
 * there are no leaves.
 */
export function buildOctreeMeshFromBuffers(
    buffers: LeafBuffer[],
    pivotX: number, pivotY: number, pivotZ: number,
    shadows: boolean,
    zFightingId: string,
    useAtlas: boolean = false,
    rounding: OctreeMeshRounding | null = null,
    /** Named material slots from the decoded file (`DecodedVxlV3.slots`); empty = base only. */
    slots: VoxelSlot[] = [],
): THREE.Mesh | null {
    let n = 0;
    for (const buf of buffers) n += buf.count;
    if (n === 0) return null;
    const minX = new Float64Array(n), minY = new Float64Array(n), minZ = new Float64Array(n), size = new Float64Array(n);
    // Atlas mode (useAtlas): per-voxel UVs into the shared sRGB color-palette atlas, so the
    // object renders through the same material/texture as vwld terrain. `buf.color` is then
    // the sRGB-encoded RGB444 cell. Otherwise: per-voxel RGB vertex colors.
    // The rounded path needs RGB in atlas mode too — it maps each vertex through
    // the palette REGION (position-based UV) rather than a fixed UV centre.
    // A textured block IS an atlas lookup, so an asset carrying block types renders in
    // atlas mode whatever its own flag says — its coloured voxels then sample the atlas'
    // colour-palette region instead of vertex colours, which keeps a mixed asset on ONE
    // material and one draw call rather than splitting it in two.
    const hasBlockTypes = buffers.some((buf) => buf.blockType !== null);
    const atlasUvs = useAtlas || hasBlockTypes;
    const needRgb = !atlasUvs || rounding !== null;
    const r = needRgb ? new Float32Array(n) : null;
    const g = needRgb ? new Float32Array(n) : null;
    const b = needRgb ? new Float32Array(n) : null;
    const uvU = atlasUvs ? new Float32Array(n) : null;
    const uvV = atlasUvs ? new Float32Array(n) : null;
    const atlas = atlasUvs ? getVoxelTextureAtlas() : null;
    const blockColumn = hasBlockTypes ? new Uint16Array(n) : null;
    // Per-leaf emissive 0..1, allocated only when at least one buffer carries an
    // emissive column (v6 assets). Non-emissive assets keep `emiss = null` so no
    // emissive attribute is built and geometry is byte-identical to before.
    const hasEmissive = buffers.some((buf) => buf.emiss !== null);
    const emiss = hasEmissive ? new Float32Array(n) : null;
    // Per-leaf material slot, allocated only when the file named slots AND a buffer
    // carries the column (v7 assets). Everything else keeps the single-material path.
    const hasSlots = slots.length > 0 && buffers.some((buf) => buf.slot !== null);
    const slotCol = hasSlots ? new Uint8Array(n) : null;

    let li = 0;
    for (const buf of buffers) {
        const ms = buf.minVoxelSize;
        const bx = buf.baseX, by = buf.baseY, bz = buf.baseZ;
        const bufEmiss = buf.emiss;
        const bufSlot = buf.slot;
        const bufBlock = buf.blockType;
        for (let k = 0; k < buf.count; k++, li++) {
            const s = ms * (1 << buf.lod[k]!);
            minX[li] = buf.gx[k]! * ms + bx;
            minY[li] = buf.gy[k]! * ms + by;
            minZ[li] = buf.gz[k]! * ms + bz;
            size[li] = s;
            const c = buf.color[k]!;
            if (blockColumn) blockColumn[li] = bufBlock ? bufBlock[k]! : 0;
            if (atlasUvs) {
                // Map the cell to its atlas-cell UV centre — the same lookup vwld uses
                // (atlasCellRepr → getColorPaletteUV): cell nibble r4 → r4·17 (the cell's
                // 0-255 sRGB representative).
                const uv = atlas!.getColorPaletteUV(((c >> 8) & 0xF) * 17, ((c >> 4) & 0xF) * 17, (c & 0xF) * 17);
                uvU![li] = (uv.u0 + uv.u1) * 0.5;
                uvV![li] = (uv.v0 + uv.v1) * 0.5;
            }
            if (needRgb) {
                r![li] = ((c >> 8) & 0xF) / 15; g![li] = ((c >> 4) & 0xF) / 15; b![li] = (c & 0xF) / 15;
            }
            // A buffer without an emissive column contributes 0 (non-glowing).
            if (emiss) { emiss[li] = bufEmiss ? bufEmiss[k]! / 255 : 0; }
            // A buffer without a slot column belongs to the base material.
            if (slotCol) { slotCol[li] = bufSlot ? bufSlot[k]! : 0; }
        }
    }

    return meshFromVoxelColumns(n, minX, minY, minZ, size, r, g, b, pivotX, pivotY, pivotZ, shadows, zFightingId, uvU, uvV, rounding, emiss, slotCol, slots, blockColumn, atlas);
}

// ─── Physics colliders (greedy-meshed) ───────────────────────────────

export interface OctreeColliderOpts {
    sx?: number;
    sy?: number;
    sz?: number;
    density?: number;
    friction?: number;
    restitution?: number;
    dynamic?: boolean;
}

export interface PhysicsBox {
    cx: number; cy: number; cz: number;
    hx: number; hy: number; hz: number;
}

/** Cells one asset may rasterize its physics grid into. Refining a small prop's
 *  grid is a few hundred cells; refining a building's is millions, and nobody
 *  can perceive a fifth of a metre on a building. */
const PHYSICS_GRID_CELL_BUDGET = 200_000;

/**
 * The physics grid step to actually use, which is at most the one the bake
 * stored.
 *
 * The stored step is `minVoxelSize * 4` floored at 0.1 m (GLBVoxelizer), chosen
 * to keep collider complexity down. Combined with the conservative fill below —
 * every cell ANY leaf touches becomes fully solid — that inflates each face by
 * up to a whole cell. On a building it is imperceptible. On a small prop it IS
 * the prop: a 0.31 m rubble pile on a 0.25 m grid collides as a 0.5 m block, so
 * the character controller mounts a step that is not there and the player
 * hovers a quarter-metre up, blocked a fifth of a metre before touching it.
 *
 * So the step is refined until the thinnest axis spans a few cells, never finer
 * than the data itself and never past the cell budget. Because it only ever
 * refines assets that are small relative to the stored step, the cell count
 * stays bounded — and because it happens at rasterization time, ALREADY-BAKED
 * assets are corrected without a re-bake.
 */
function physicsGridStepFor(
    gridStep: number, finestLeaf: number, dx: number, dy: number, dz: number,
): number {
    const thinnest = Math.min(dx, dy, dz);
    let gs = Math.max(finestLeaf, Math.min(gridStep, thinnest / 4));
    if (!Number.isFinite(gs) || gs <= 0) return gridStep;
    const cells = (step: number): number =>
        Math.ceil(dx / step) * Math.ceil(dy / step) * Math.ceil(dz / step);
    while (gs < gridStep && cells(gs) > PHYSICS_GRID_CELL_BUDGET) gs *= 2;
    return Math.min(gs, gridStep);
}

/** A leaf set rasterized onto its uniform physics grid. Layout: `(y * nz + z) * nx + x`. */
interface LeafGridRaster {
    grid: Uint8Array;
    nx: number; ny: number; nz: number;
    gs: number;
    gMinX: number; gMinY: number; gMinZ: number;
    gMaxX: number; gMaxY: number; gMaxZ: number;
}

/**
 * Rasterize octree leaves onto a uniform occupancy grid. Conservative fill:
 * every cell ANY leaf touches becomes fully solid. Shared by the greedy mesher
 * below (trimesh colliders) and the voxels-collider branch of
 * createOctreeColliders, so both shapes are built from the same cells.
 *
 * @param gridStep Resolution of the occupancy grid (typically minVoxelSize).
 *                 An UPPER bound: see `physicsGridStepFor`.
 */
function rasterizeLeafGrid(
    leaves: LeafSources,
    pivotX: number, pivotY: number, pivotZ: number,
    gridStep: number,
): LeafGridRaster | null {
    let gMinX = Infinity, gMinY = Infinity, gMinZ = Infinity;
    let gMaxX = -Infinity, gMaxY = -Infinity, gMaxZ = -Infinity;
    let finestLeaf = Infinity;
    forEachLeaf(leaves, leaf => {
        const lx = leaf.x - pivotX;
        const ly = leaf.y - pivotY;
        const lz = leaf.z - pivotZ;
        if (lx < gMinX) gMinX = lx;
        if (ly < gMinY) gMinY = ly;
        if (lz < gMinZ) gMinZ = lz;
        const ex = lx + leaf.size;
        const ey = ly + leaf.size;
        const ez = lz + leaf.size;
        if (ex > gMaxX) gMaxX = ex;
        if (ey > gMaxY) gMaxY = ey;
        if (ez > gMaxZ) gMaxZ = ez;
        if (leaf.size < finestLeaf) finestLeaf = leaf.size;
    });
    if (finestLeaf === Infinity) return null; // no leaves in any source

    const gs = physicsGridStepFor(
        gridStep, finestLeaf, gMaxX - gMinX, gMaxY - gMinY, gMaxZ - gMinZ,
    );
    const nx = Math.ceil((gMaxX - gMinX) / gs);
    const ny = Math.ceil((gMaxY - gMinY) / gs);
    const nz = Math.ceil((gMaxZ - gMinZ) / gs);

    if (nx <= 0 || ny <= 0 || nz <= 0) return null;

    // One definition of the cell layout for the rasterizer and both consumers.
    const idx = (x: number, y: number, z: number) => (y * nz + z) * nx + x;

    const grid = new Uint8Array(nx * ny * nz);
    forEachLeaf(leaves, leaf => {
        const lx = leaf.x - pivotX;
        const ly = leaf.y - pivotY;
        const lz = leaf.z - pivotZ;
        const ix0 = Math.max(0, Math.floor((lx - gMinX) / gs));
        const iy0 = Math.max(0, Math.floor((ly - gMinY) / gs));
        const iz0 = Math.max(0, Math.floor((lz - gMinZ) / gs));
        const ix1 = Math.min(nx, Math.ceil((lx + leaf.size - gMinX) / gs));
        const iy1 = Math.min(ny, Math.ceil((ly + leaf.size - gMinY) / gs));
        const iz1 = Math.min(nz, Math.ceil((lz + leaf.size - gMinZ) / gs));
        for (let iy = iy0; iy < iy1; iy++) {
            for (let iz = iz0; iz < iz1; iz++) {
                for (let ix = ix0; ix < ix1; ix++) {
                    grid[idx(ix, iy, iz)] = 1;
                }
            }
        }
    });

    return { grid, nx, ny, nz, gs, gMinX, gMinY, gMinZ, gMaxX, gMaxY, gMaxZ };
}

/**
 * The voxels-collider input for a leaf set: flat boundary-cell triples (see
 * VoxelColliders — an interior cell never takes part in a contact) plus the
 * grid step and origin that place them. Cell (i) spans [gMin + i*gs,
 * gMin + (i+1)*gs] per axis in pivot-adjusted local space; parent scale
 * composes through a non-uniform voxelSize (gs * s) and a scaled origin.
 */
export interface OctreeVoxelCells {
    cells: Int32Array;
    gs: number;
    gMinX: number; gMinY: number; gMinZ: number;
}

/** Rasterize leaves and emit the voxels-collider cell set, or null when empty. */
export function octreeVoxelCells(
    leaves: LeafSources,
    pivotX: number, pivotY: number, pivotZ: number,
    gridStep: number,
): OctreeVoxelCells | null {
    const raster = rasterizeLeafGrid(leaves, pivotX, pivotY, pivotZ, gridStep);
    if (!raster) return null;
    return {
        cells: cellsFromDenseGrid(raster.grid, raster.nx, raster.ny, raster.nz),
        gs: raster.gs,
        gMinX: raster.gMinX, gMinY: raster.gMinY, gMinZ: raster.gMinZ,
    };
}

/**
 * Rasterize octree leaves onto a uniform occupancy grid, then greedy-mesh
 * adjacent cells into merged boxes — same algorithm as generateCollisionBoxes
 * in VoxelGeometry. Produces a small number of large boxes that approximate
 * the object's shape for physics.
 *
 * @param gridStep Resolution of the occupancy grid (typically minVoxelSize).
 *                 An UPPER bound: see `physicsGridStepFor`.
 */
export function greedyMeshOctreeLeaves(
    leaves: LeafSources,
    pivotX: number, pivotY: number, pivotZ: number,
    gridStep: number,
): PhysicsBox[] {
    const raster = rasterizeLeafGrid(leaves, pivotX, pivotY, pivotZ, gridStep);
    if (!raster) return [];
    const { grid, nx, ny, nz, gs, gMinX, gMinY, gMinZ, gMaxX, gMaxY, gMaxZ } = raster;
    const idx = (x: number, y: number, z: number) => (y * nz + z) * nx + x;

    const visited = new Uint8Array(nx * ny * nz);
    const canMerge = (x: number, y: number, z: number) =>
        grid[idx(x, y, z)] === 1 && !visited[idx(x, y, z)];

    const boxes: PhysicsBox[] = [];

    for (let y = 0; y < ny; y++) {
        for (let z = 0; z < nz; z++) {
            for (let x = 0; x < nx; x++) {
                if (!canMerge(x, y, z)) continue;

                let mx = x + 1;
                while (mx < nx && canMerge(mx, y, z)) mx++;

                let mz = z + 1;
                zLoop: while (mz < nz) {
                    for (let ix = x; ix < mx; ix++) { if (!canMerge(ix, y, mz)) break zLoop; }
                    mz++;
                }

                let my = y + 1;
                yLoop: while (my < ny) {
                    for (let iz = z; iz < mz; iz++) {
                        for (let ix = x; ix < mx; ix++) { if (!canMerge(ix, my, iz)) break yLoop; }
                    }
                    my++;
                }

                for (let iy = y; iy < my; iy++) {
                    for (let iz = z; iz < mz; iz++) {
                        for (let ix = x; ix < mx; ix++) { visited[idx(ix, iy, iz)] = 1; }
                    }
                }

                // Clamped to the true leaf extent: the grid is anchored at the
                // minimum corner, so only the far faces can overhang, and they
                // do whenever an extent is not a whole number of cells.
                const bx0 = gMinX + x * gs;
                const by0 = gMinY + y * gs;
                const bz0 = gMinZ + z * gs;
                const bx1 = Math.min(gMaxX, gMinX + mx * gs);
                const by1 = Math.min(gMaxY, gMinY + my * gs);
                const bz1 = Math.min(gMaxZ, gMinZ + mz * gs);
                if (bx1 <= bx0 || by1 <= by0 || bz1 <= bz0) continue;

                boxes.push({
                    cx: (bx0 + bx1) * 0.5, cy: (by0 + by1) * 0.5, cz: (bz0 + bz1) * 0.5,
                    hx: (bx1 - bx0) * 0.5, hy: (by1 - by0) * 0.5, hz: (bz1 - bz0) * 0.5,
                });
            }
        }
    }

    return boxes;
}


/**
 * Create physics colliders for octree leaves.
 * Static bodies (default): ONE voxels collider over the rasterized leaf grid,
 * boundary cells only (see VoxelColliders).
 * Dynamic bodies (opts.dynamic=true): one cuboid per greedy-meshed box, because
 * Rapier derives a dynamic body's mass from collider volume, which neither a
 * voxels shape nor a trimesh carries.
 */
export function createOctreeColliders(
    leaves: LeafSources,
    pivotX: number, pivotY: number, pivotZ: number,
    gridStep: number,
    pw: PhysicsWorld, body: RAPIER.RigidBody,
    groups: number,
    opts?: OctreeColliderOpts,
): RAPIER.Collider[] {
    // Guard the per-axis scale. Callers derive sx/sy/sz from a parent matrix
    // decompose (detachAsDynamic, splitInPlace fragments, etc.). A parent that is
    // mid-despawn-scale, or whose own transform already went non-finite in an
    // earlier cascade, decomposes to a 0 or NaN scale — which turns every cuboid
    // below (`box.hx * sx`) into a DEGENERATE collider: its local AABB is
    // non-finite (unrecoverable by the quarantine net, which only rewrites the
    // body translation) and its contact manifold normal is undefined, so the
    // solver emits a NaN contact force that poisons the velocity of every body it
    // touches. That is the `type=unknown` voxel-fragment all-NaN crash. Falling
    // back to unit scale keeps a valid collision footprint instead. (1e-4 only
    // rejects an essentially-zero scale; a legitimately small object is ~0.01+.)
    const safeScale = (n: number | undefined): number =>
        (n !== undefined && Number.isFinite(n) && Math.abs(n) > 1e-4) ? n : 1;
    const sx = safeScale(opts?.sx), sy = safeScale(opts?.sy), sz = safeScale(opts?.sz);

    // Static path: hand Rapier the rasterized occupancy grid itself. Same
    // cells, same conservative fill as the greedy mesher below; parent scale
    // composes through a non-uniform voxelSize. (The trimesh this replaced
    // clamped far faces back to the true leaf extent; the voxel grid keeps the
    // whole cell — the same up-to-one-cell inflation the conservative fill
    // already accepts everywhere else.)
    if (!opts?.dynamic) {
        const vc = octreeVoxelCells(leaves, pivotX, pivotY, pivotZ, gridStep);
        if (!vc) return [];
        const desc = voxelsDesc(
            vc.cells,
            vc.gs * sx, vc.gs * sy, vc.gs * sz,
            vc.gMinX * sx, vc.gMinY * sy, vc.gMinZ * sz,
        )
            .setCollisionGroups(groups)
            .setFriction(opts?.friction ?? 0.5)
            .setRestitution(opts?.restitution ?? 0.0);
        return [pw.createCollider(desc, body)];
    }

    // Dynamic path: one cuboid per greedy-meshed box. Fragment chunks are
    // dynamic only briefly (until they settle and we flip them back to fixed),
    // so the per-body collider count for dynamic bodies is short-lived.
    const boxes = greedyMeshOctreeLeaves(leaves, pivotX, pivotY, pivotZ, gridStep);
    const colliders: RAPIER.Collider[] = [];
    for (const box of boxes) {
        const desc = RAPIER.ColliderDesc.cuboid(box.hx * sx, box.hy * sy, box.hz * sz)
            .setTranslation(box.cx * sx, box.cy * sy, box.cz * sz)
            .setCollisionGroups(groups)
            .setFriction(opts?.friction ?? 0.5)
            .setRestitution(opts?.restitution ?? 0.0);
        if (opts?.density !== undefined) desc.setDensity(opts.density);
        colliders.push(pw.createCollider(desc, body));
    }
    return colliders;
}

/**
 * Compute total volume of all octree leaves (for mass/density calculation).
 */
export function octreeTotalVolume(leaves: LeafSources): number {
    let vol = 0;
    forEachLeaf(leaves, leaf => { vol += leaf.size ** 3; });
    return vol;
}

/** Centroid of a leaf list, using each leaf's CENTRE (leaf x/y/z is its min corner). */
export function leafListCentroid(leaves: OctreeLeaf[]): { x: number; y: number; z: number } {
    let x = 0, y = 0, z = 0;
    for (const leaf of leaves) {
        x += leaf.x + leaf.size * 0.5;
        y += leaf.y + leaf.size * 0.5;
        z += leaf.z + leaf.size * 0.5;
    }
    const n = leaves.length;
    return { x: x / n, y: y / n, z: z / n };
}
