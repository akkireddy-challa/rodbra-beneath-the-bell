/**
 * Geometry for a rigged VXL3 v10 character.
 *
 * A v10 file binds every voxel to exactly ONE joint at weight 1.0 — rigid
 * binding, never blended (see `VxlV3Rig.ts`). That is what makes a character
 * expressible as a plain `THREE.SkinnedMesh`: one influence per vertex means one
 * bone matrix per vertex, so a cube stays a cube instead of shearing, and the
 * GPU does no blending at all. The skinned form is what the rest of the engine
 * already knows how to drive — `CharacterLoader` poses bones and three does the
 * rest — so a `.vxl` character needs no renderer of its own.
 *
 * `game/vxl-v10-character-demo.html` is the reference this was lifted from, and
 * it remains the pixel check: it renders the same bodies through the same
 * columns, so a regression here shows up there immediately.
 *
 * Two rules in here are load-bearing and were both found the hard way:
 *
 * 1. **Same-owner face culling.** A face is dropped only when the neighbouring
 *    cell belongs to the SAME joint. A face hidden by a neighbour on a different
 *    joint must survive — the two pull apart when the joint bends, and a culled
 *    face there is a hole straight through the limb.
 * 2. **Joint fillers are not decoration.** They are interior voxels duplicated
 *    across a pivot with the child copy shrunk 4 %, so a bending joint fans them
 *    into the wedge it opens. Dropping them re-opens the knees at full
 *    extension. They live in their own section because a filler and the surface
 *    voxel it sits inside have different bones, and the main grid is strictly
 *    one bone per cell.
 *
 * Face corner offsets and winding come from `FACE_TEMPLATES`, never a table
 * written here — the winding is what decides which way the surface faces.
 */
import * as THREE from 'three';
import { FACE_TEMPLATES } from 'engine/VoxelGeometry.js';
import { unpackRgb444 } from 'engine/VoxelOctreeRenderer.js';
import { resolveSkeletonRef, type VoxelSkeletonRef, type VxlV3Rig } from 'engine/VxlV3Rig.js';
import type { DecodedVxlV3 } from 'engine/VxlV3Format.js';

/**
 * Neighbour direction per face, in `FACE_TEMPLATES` order: -Z, +Z, -X, +X, -Y, +Y.
 * Doubles as the face normal — these cubes are axis-aligned by construction.
 */
const FACE_DIRS: ReadonlyArray<readonly [number, number, number]> = [
    [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0],
];

/**
 * Ceiling on the occupancy grid, mirroring `VoxelOctreeRenderer`'s. A character
 * is ~60 cells on a side so this is never close, but a corrupt header could ask
 * for a grid that does not fit in memory. Above it, culling is skipped and every
 * face is emitted — more geometry, still correct.
 */
const MAX_OCCUPANCY_CELLS = 64_000_000;

/** How much a joint filler is shrunk so it does not z-fight the voxel it sits inside. */
const FILLER_INSET = 0.96;

export interface VxlCharacterColumns {
    /** Vertex positions in MODEL space, 3 per vertex, 4 vertices per quad. */
    position: Float32Array;
    normal: Float32Array;
    /** Linear RGB per vertex, matching the engine's `unpackRgb444` output. */
    color: Float32Array;
    index: Uint32Array;
    /** Owning joint per VERTEX — becomes `skinIndex.x`, or the group key for the rigid build. */
    joint: Uint8Array;
    /**
     * INDEX range per MATERIAL — `groups[0]` the base, `groups[i + 1]` named
     * slot `i` (the `VoxelSlotPlan.groups` convention). Emission is
     * material-major, so each material's quads are contiguous in BOTH vertex
     * and index space — what `geometry.addGroup` and the slot shading-normal
     * pass both require. A slot-free body has exactly one base group covering
     * everything, produced by the identical single pass the pre-slot builder
     * ran.
     */
    groups: Array<{ start: number; count: number }>;
    /** Quads emitted, and faces dropped by the same-owner rule. Diagnostics only. */
    quads: number;
    culled: number;
    /** True when the occupancy grid was built; false means every face was emitted. */
    didCull: boolean;
}

export interface BuildVxlCharacterOptions {
    /** Coarser level to build from, 0 (default) being the full-resolution grid. */
    lod?: number;
    /** Joint fillers are on by default. Off is for the demo's comparison view only. */
    includeFillers?: boolean;
}

/** A fragment's leaves plus the rig column that owns them. */
interface SourceGrid {
    count: number;
    gx: Uint16Array; gy: Uint16Array; gz: Uint16Array;
    color: Uint16Array;
    bone: Uint8Array;
    /** Per-leaf material slot (0 = base), or null when the file declares none. */
    slot: Uint8Array | null;
    size: number;
    baseX: number; baseY: number; baseZ: number;
}

/**
 * A character is written as a single fragment at a single voxel size, which is
 * what lets the occupancy grid be a flat array indexed by the file's own grid
 * coords. Anything else is not a character this builder can read.
 */
function sourceGridFor(decoded: DecodedVxlV3, rig: VxlV3Rig, lod: number): SourceGrid {
    const level = lod === 0
        ? { fragments: decoded.fragments }
        : decoded.additionalLods?.[lod - 1];
    if (!level || level.fragments.length !== 1) {
        throw new Error(`vxl character: expected exactly one fragment at LOD ${lod}`);
    }
    const buf = level.fragments[0]!.leaves;
    const bone = lod === 0 ? (buf.bone ?? rig.bones) : (buf.bone ?? rig.lodBones[lod - 1]);
    if (!bone || bone.length < buf.count) {
        throw new Error(`vxl character: LOD ${lod} carries no bone column`);
    }
    return {
        count: buf.count,
        gx: buf.gx, gy: buf.gy, gz: buf.gz,
        color: buf.color,
        bone,
        slot: buf.slot ?? null,
        size: buf.minVoxelSize,
        baseX: buf.baseX, baseY: buf.baseY, baseZ: buf.baseZ,
    };
}

/** Flat occupancy lattice over the file's own grid coords. */
interface Occupancy {
    /** `joint + 1` per cell, so 0 can mean empty. */
    occ: Uint8Array;
    nx: number; ny: number; nz: number;
    /** `nx * ny` — the stride between Z slices. */
    nxy: number;
}

/**
 * Build the occupancy lattice.
 *
 * The demo used a `Map` keyed on `"x,y,z"`, which allocates one string per voxel
 * per lookup — ~6 000 voxels x 6 neighbours per body. A flat typed array over
 * the same lattice answers the same question with no allocation.
 *
 * Returns null when the grid would be too large, or when a leaf sits off the
 * lattice — either way the caller emits every face, which is always correct.
 */
function buildOccupancy(g: SourceGrid): Occupancy | null {
    let maxX = 0, maxY = 0, maxZ = 0;
    for (let i = 0; i < g.count; i++) {
        if (g.gx[i]! > maxX) maxX = g.gx[i]!;
        if (g.gy[i]! > maxY) maxY = g.gy[i]!;
        if (g.gz[i]! > maxZ) maxZ = g.gz[i]!;
    }
    const nx = maxX + 1, ny = maxY + 1, nz = maxZ + 1;
    if (nx * ny * nz > MAX_OCCUPANCY_CELLS) return null;
    const occ = new Uint8Array(nx * ny * nz);
    const nxy = nx * ny;
    for (let i = 0; i < g.count; i++) {
        // Joints are capped at 255 (VOXEL_MAX_JOINTS) precisely so `joint + 1`
        // still fits a byte here.
        occ[g.gz[i]! * nxy + g.gy[i]! * nx + g.gx[i]!] = g.bone[i]! + 1;
    }
    return { occ, nx, ny, nz, nxy };
}

/**
 * Build a character's geometry columns in MODEL space, one joint index per vertex.
 *
 * Model space, not bone space, on purpose: the inverse bind then lives in
 * `THREE.Skeleton.boneInverses` where three applies it, instead of being baked
 * into vertices by hand. The demo has to bake it because it parents rigid meshes
 * to bones, and baking it is exactly where the "transform every corner, not just
 * the min one" trap lives. Here there is no such transform to get wrong.
 */
export function buildVxlCharacterColumns(
    decoded: DecodedVxlV3,
    options: BuildVxlCharacterOptions = {},
): VxlCharacterColumns {
    const rig = decoded.rig;
    if (!rig) throw new Error('vxl character: file carries no rig (not a v10 character)');
    const lod = options.lod ?? 0;
    const includeFillers = options.includeFillers !== false;

    const g = sourceGridFor(decoded, rig, lod);
    const grid = buildOccupancy(g);
    // Fillers are LOD-0 geometry by definition — they exist to fill a joint wedge
    // at close range, and a coarse level has no cell small enough to hold one.
    const fillers = includeFillers && lod === 0 ? rig.fillers : null;

    // Materials: 0 = base, 1..slotCount = the file's named slots (v11 material
    // classes ride them). Emission below is MATERIAL-MAJOR so each material's
    // quads land contiguously; with no named slots the one base pass walks the
    // leaves in file order — the identical output of the pre-slot builder.
    const slotCount = decoded.slots?.length ?? 0;
    const materialCount = slotCount + 1;
    const leafMaterial = (i: number): number => {
        if (slotCount === 0 || !g.slot) return 0;
        const s = g.slot[i]!;
        return s <= slotCount ? s : 0;
    };

    // Fillers carry colour+bone but no slot column: derive theirs from the
    // CELL they sit in (the surface voxel they were duplicated from), so a
    // gold limb's fillers stay gold inside a bent joint. Falls back to base
    // when the occupancy lattice was refused.
    let fillerMaterial: (i: number) => number = () => 0;
    if (fillers && slotCount > 0 && g.slot && grid) {
        const cellSlot = new Uint8Array(grid.nx * grid.ny * grid.nz);
        for (let i = 0; i < g.count; i++) {
            cellSlot[g.gz[i]! * grid.nxy + g.gy[i]! * grid.nx + g.gx[i]!] = leafMaterial(i);
        }
        fillerMaterial = (i: number): number => {
            const x = fillers.gx[i]!, y = fillers.gy[i]!, z = fillers.gz[i]!;
            if (x >= grid.nx || y >= grid.ny || z >= grid.nz) return 0;
            return cellSlot[z * grid.nxy + y * grid.nx + x]!;
        };
    }

    // Counting pass, so every column is allocated exactly once at its final size.
    let culled = 0;
    const quadsPerMaterial = new Array<number>(materialCount).fill(0);
    for (let i = 0; i < g.count; i++) {
        const owner = g.bone[i]!;
        const m = leafMaterial(i);
        for (let f = 0; f < 6; f++) {
            if (isHiddenFace(grid, g, i, f, owner)) culled++; else quadsPerMaterial[m]!++;
        }
    }
    if (fillers) {
        for (let i = 0; i < fillers.count; i++) quadsPerMaterial[fillerMaterial(i)]! += 6;
    }
    const totalQuads = quadsPerMaterial.reduce((a, b) => a + b, 0);

    const w: ColumnWriter = {
        position: new Float32Array(totalQuads * 12),
        normal: new Float32Array(totalQuads * 12),
        color: new Float32Array(totalQuads * 12),
        joint: new Uint8Array(totalQuads * 4),
        index: new Uint32Array(totalQuads * 6),
        v: 0, i: 0,
    };

    // Inset so the rest pose does not z-fight the surface voxel the filler sits
    // inside; the two copies fan apart and fill the wedge once the joint bends.
    const inset = g.size * FILLER_INSET;
    const insetPad = (g.size - inset) / 2;

    const groups: Array<{ start: number; count: number }> = [];
    for (let m = 0; m < materialCount; m++) {
        const start = w.i;
        for (let i = 0; i < g.count; i++) {
            if (leafMaterial(i) !== m) continue;
            const owner = g.bone[i]!;
            const rgb = unpackRgb444(g.color[i]!);
            const x = g.gx[i]! * g.size + g.baseX;
            const y = g.gy[i]! * g.size + g.baseY;
            const z = g.gz[i]! * g.size + g.baseZ;
            for (let f = 0; f < 6; f++) {
                if (isHiddenFace(grid, g, i, f, owner)) continue;
                emitFace(w, f, x, y, z, g.size, owner, rgb);
            }
        }
        if (fillers) {
            for (let i = 0; i < fillers.count; i++) {
                if (fillerMaterial(i) !== m) continue;
                const owner = fillers.bone[i]!;
                const rgb = unpackRgb444(fillers.color[i]!);
                const x = fillers.gx[i]! * g.size + g.baseX + insetPad;
                const y = fillers.gy[i]! * g.size + g.baseY + insetPad;
                const z = fillers.gz[i]! * g.size + g.baseZ + insetPad;
                // All six faces: a filler has no neighbour in its own group, by construction.
                for (let f = 0; f < 6; f++) emitFace(w, f, x, y, z, inset, owner, rgb);
            }
        }
        groups.push({ start, count: w.i - start });
    }

    return {
        position: w.position, normal: w.normal, color: w.color, index: w.index, joint: w.joint,
        groups, quads: totalQuads, culled, didCull: grid !== null,
    };
}

/**
 * The same-owner rule: a face is hidden only when the cell across it belongs to
 * the SAME joint. Without an occupancy grid nothing is hidden — more geometry,
 * never a hole.
 */
function isHiddenFace(grid: Occupancy | null, g: SourceGrid, i: number, f: number, owner: number): boolean {
    return grid !== null && neighbourOwner(grid, g, i, f) === owner + 1;
}

/** `joint + 1` of the cell across face `f`, or 0 when that cell is empty/outside. */
function neighbourOwner(grid: Occupancy, g: SourceGrid, i: number, f: number): number {
    const d = FACE_DIRS[f]!;
    const x = g.gx[i]! + d[0], y = g.gy[i]! + d[1], z = g.gz[i]! + d[2];
    if (x < 0 || y < 0 || z < 0 || x >= grid.nx || y >= grid.ny || z >= grid.nz) return 0;
    return grid.occ[z * grid.nxy + y * grid.nx + x]!;
}

/** The columns being filled, plus the next vertex and index slot to write. */
interface ColumnWriter {
    position: Float32Array;
    normal: Float32Array;
    color: Float32Array;
    joint: Uint8Array;
    index: Uint32Array;
    v: number;
    i: number;
}

/** `x,y,z` is the cube's MIN corner in model space; `s` its edge length. */
function emitFace(
    w: ColumnWriter, f: number,
    x: number, y: number, z: number, s: number,
    owner: number, rgb: { r: number; g: number; b: number },
): void {
    const base = w.v;
    const cx = x + s / 2, cy = y + s / 2, cz = z + s / 2;
    const n = FACE_DIRS[f]!;
    for (let k = 0; k < 4; k++) {
        const t = FACE_TEMPLATES[f * 4 + k]!;
        const p = w.v * 3;
        w.position[p] = cx + t[0]! * s;
        w.position[p + 1] = cy + t[1]! * s;
        w.position[p + 2] = cz + t[2]! * s;
        w.normal[p] = n[0]; w.normal[p + 1] = n[1]; w.normal[p + 2] = n[2];
        w.color[p] = rgb.r; w.color[p + 1] = rgb.g; w.color[p + 2] = rgb.b;
        w.joint[w.v] = owner;
        w.v++;
    }
    writeQuadIndices(w.index, w.i, base);
    w.i += 6;
}

/**
 * Two triangles for the quad whose first vertex is `base`, written at `at`.
 * Same winding as FACE_INDICES: clockwise for three's FrontSide.
 */
function writeQuadIndices(index: Uint32Array, at: number, base: number): void {
    index[at] = base; index[at + 1] = base + 2; index[at + 2] = base + 1;
    index[at + 3] = base; index[at + 4] = base + 3; index[at + 5] = base + 2;
}

// ─── Skeleton ──────────────────────────────────────────────────────────────

export interface VxlBindSkeleton {
    /** One bone per joint in the ref's order — the order the bone column indexes. */
    bones: THREE.Bone[];
    /** Holds the root bone(s); this is what becomes the character's `scene`. */
    root: THREE.Group;
    ref: VoxelSkeletonRef;
}

/**
 * Build the bind skeleton: names, hierarchy and bind ROTATIONS from the shared
 * reference, bind TRANSLATIONS from the file.
 *
 * Both halves are copied verbatim, and that is the whole animation contract.
 * The engine applies a clip's WORLD rotations with no bind-pose compensation
 * (`CharacterLoader.applyPoseRotations`, and see `game/docs/character-animation.md`),
 * so these values must stay bit-identical to what the clips were authored
 * against. Normalising a quaternion, round-tripping through Euler angles, or
 * "correcting" an armature rotation here all produce the same symptom: a body
 * that animates with a leaning torso and offset limbs, with nothing obviously
 * wrong in the code that did it.
 *
 * Only the translations are per-body — they are what proportions changed, and
 * taking them from the file rather than from a default rig is what lets one clip
 * drive a lanky body and a stocky one alike.
 */
export function createVxlBindSkeleton(rig: VxlV3Rig): VxlBindSkeleton {
    const ref = resolveSkeletonRef(rig.skeletonRef);
    if (!ref) throw new Error(`vxl character: unknown skeletonRef "${rig.skeletonRef}"`);
    const jointCount = ref.joints.length;
    if (rig.bindPositions.length < jointCount * 3) {
        throw new Error(`vxl character: rig has ${rig.bindPositions.length / 3} bind positions, ref needs ${jointCount}`);
    }

    const bones: THREE.Bone[] = [];
    for (let i = 0; i < jointCount; i++) {
        const bone = new THREE.Bone();
        bone.name = ref.joints[i]!;
        bone.position.set(rig.bindPositions[i * 3]!, rig.bindPositions[i * 3 + 1]!, rig.bindPositions[i * 3 + 2]!);
        bone.quaternion.set(
            ref.rotations[i * 4]!, ref.rotations[i * 4 + 1]!,
            ref.rotations[i * 4 + 2]!, ref.rotations[i * 4 + 3]!,
        );
        bones.push(bone);
    }
    const root = new THREE.Group();
    root.name = 'vxlCharacter';
    for (let i = 0; i < jointCount; i++) {
        const parent = ref.parents[i]!;
        (parent === -1 ? root : bones[parent]!).add(bones[i]!);
    }
    // The bind pose has to be resolved before a Skeleton is built from these
    // bones: THREE.Skeleton derives its inverse binds from the world matrices as
    // they stand at construction.
    root.updateMatrixWorld(true);
    return { bones, root, ref };
}

// ─── Assembly ──────────────────────────────────────────────────────────────

/** The attribute set every form of this geometry shares — vertex colours, no maps. */
function makeGeometry(
    position: Float32Array, normal: Float32Array, color: Float32Array, index: Uint32Array,
): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(color, 3));
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    return geometry;
}

/**
 * The shipping form: one `THREE.SkinnedMesh` for the whole body.
 *
 * Every vertex carries exactly one influence at weight 1.0, which is the same
 * rigid binding the per-joint meshes express — but as ONE draw call instead of
 * one per joint, drivable by the engine's existing skinned-character path, and
 * clonable by `SkeletonUtils.clone` for NPC crowds.
 *
 * It also keeps `BoneVoxelShatter` working: that effect reads `skinIndex` /
 * `skinWeight` off cube-sized triangles, which is exactly this geometry.
 *
 * A material ARRAY renders the columns' material groups (v11 classed slots) —
 * one extra draw call per non-empty group, mirroring
 * `VoxelOctreeRenderer.assembleVoxelMesh`; a single material takes exactly the
 * pre-slot path with no groups at all.
 */
export function assembleVxlSkinnedMesh(
    columns: VxlCharacterColumns,
    skeleton: VxlBindSkeleton,
    material: THREE.Material | THREE.Material[],
): THREE.SkinnedMesh {
    const geometry = makeGeometry(columns.position, columns.normal, columns.color, columns.index);
    if (Array.isArray(material)) {
        for (let m = 0; m < columns.groups.length; m++) {
            const group = columns.groups[m]!;
            if (group.count > 0) geometry.addGroup(group.start, group.count, m);
        }
    }
    const vertexCount = columns.joint.length;
    const skinIndex = new Uint16Array(vertexCount * 4);
    const skinWeight = new Float32Array(vertexCount * 4);
    for (let v = 0; v < vertexCount; v++) {
        skinIndex[v * 4] = columns.joint[v]!;
        skinWeight[v * 4] = 1;
    }
    geometry.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
    geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));

    const mesh = new THREE.SkinnedMesh(geometry, material);
    mesh.name = 'vxlCharacterBody';
    // Bones are posed directly every frame rather than by an animation on this
    // object, so the cached bounding sphere goes stale the moment the character
    // moves a limb and frustum culling would blink it out.
    mesh.frustumCulled = false;
    mesh.bind(new THREE.Skeleton(skeleton.bones));
    return mesh;
}

/**
 * The reference form: one rigid mesh per joint, parented to its bone.
 *
 * This is what `vxl-v10-character-demo.html` proved out, and it is kept for two
 * reasons — it is the fallback if skinning ever misbehaves on a backend, and it
 * is the ORACLE the skinned path is tested against. Both come from the same
 * columns, so asserting that the bind-pose vertices agree pins the two together
 * permanently.
 *
 * Here the inverse bind IS baked into the vertices, and every corner of every
 * quad goes through it individually. Transforming only the min corner and adding
 * axis-aligned offsets would build each cube in its bone's frame instead — barely
 * visible on the torso, ~120 degrees out on the arms, where the cubes stop tiling
 * and the limb becomes a lattice of sheared plates.
 */
export function assembleVxlJointMeshes(
    columns: VxlCharacterColumns,
    skeleton: VxlBindSkeleton,
    material: THREE.Material,
): THREE.Mesh[] {
    const byJoint = new Map<number, number[]>();
    for (let q = 0; q < columns.quads; q++) {
        const owner = columns.joint[q * 4]!;
        const quads = byJoint.get(owner);
        if (quads) quads.push(q); else byJoint.set(owner, [q]);
    }

    const meshes: THREE.Mesh[] = [];
    const vertex = new THREE.Vector3();
    const normalVec = new THREE.Vector3();
    for (const [jointIndex, quads] of byJoint) {
        const bone = skeleton.bones[jointIndex];
        if (!bone) continue;
        const invBind = bone.matrixWorld.clone().invert();
        const invBindNormal = new THREE.Matrix3().setFromMatrix4(invBind);
        const position = new Float32Array(quads.length * 12);
        const normal = new Float32Array(quads.length * 12);
        const color = new Float32Array(quads.length * 12);
        const index = new Uint32Array(quads.length * 6);
        for (let n = 0; n < quads.length; n++) {
            const q = quads[n]!;
            for (let k = 0; k < 4; k++) {
                const src = (q * 4 + k) * 3, dst = (n * 4 + k) * 3;
                vertex.set(columns.position[src]!, columns.position[src + 1]!, columns.position[src + 2]!)
                    .applyMatrix4(invBind);
                position[dst] = vertex.x; position[dst + 1] = vertex.y; position[dst + 2] = vertex.z;
                normalVec.set(columns.normal[src]!, columns.normal[src + 1]!, columns.normal[src + 2]!)
                    .applyMatrix3(invBindNormal).normalize();
                normal[dst] = normalVec.x; normal[dst + 1] = normalVec.y; normal[dst + 2] = normalVec.z;
                color[dst] = columns.color[src]!;
                color[dst + 1] = columns.color[src + 1]!;
                color[dst + 2] = columns.color[src + 2]!;
            }
            writeQuadIndices(index, n * 6, n * 4);
        }
        const mesh = new THREE.Mesh(makeGeometry(position, normal, color, index), material);
        mesh.name = `vxlJoint:${skeleton.ref.joints[jointIndex]}`;
        mesh.frustumCulled = false;
        bone.add(mesh);
        meshes.push(mesh);
    }
    return meshes;
}
