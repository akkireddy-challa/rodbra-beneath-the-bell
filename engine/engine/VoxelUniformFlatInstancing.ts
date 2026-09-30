import * as THREE from 'three';
import { CHUNK_SIZE, type ChunkKey, makeChunkKey, type BlockID } from 'engine/VoxelGeometry.js';
import { getVoxelTextureAtlas } from 'engine/VoxelTextureAtlas.js';
import { VoxelColumnTopIndex } from 'engine/VoxelColumnTopIndex.js';

/** Zero-scale matrix used to hide an instance slot after eviction. */
const ZERO_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);

/**
 * Builds and manages the per-block-type InstancedMesh registry for uniformly-flat
 * (unedited `fillFlat`-stamped, non-fluid surface) chunks.
 *
 * The visual mesh for every voxel-column in such a chunk is identical apart from
 * world position, so we batch them into one InstancedMesh per surface block —
 * one source BufferGeometry (a 16×16 grid of textured top quads), one material,
 * one draw call, one set of per-instance translation matrices. Per-chunk visual
 * mesh creation is suppressed for chunks tracked in `chunksCoveredByInstance`.
 *
 * On invalidation (any `setBlock` / `setBlockFast` / placement that breaks the
 * uniform-flat property), the chunk's instance slot is zeroed and the chunk is
 * promoted back to a normal per-chunk Mesh via the usual dirty-chunks pipeline.
 */
export interface UniformFlatInstancingDeps {
    columnTopIndex: VoxelColumnTopIndex;
    bounds: { minX: number; minY: number; minZ: number } | null;
    voxelSize: number;
    parentGroup: THREE.Object3D;
    material: THREE.Material;
}

export interface UniformFlatInstancingState {
    /** Chunks fully represented by an InstancedMesh slot. `updateCollisionVisualization` must skip these. */
    chunksCoveredByInstance: Set<ChunkKey>;
    /** Reverse lookup for eviction-on-edit. */
    chunkInstanceSlot: Map<ChunkKey, { mesh: THREE.InstancedMesh; index: number }>;
    /** One InstancedMesh per surface block id. */
    instanceMeshesByBlock: Map<BlockID, THREE.InstancedMesh>;
    /** Number of instance slots populated across all meshes. */
    totalInstances: number;
}

export function createEmptyInstancingState(): UniformFlatInstancingState {
    return { chunksCoveredByInstance: new Set(), chunkInstanceSlot: new Map(), instanceMeshesByBlock: new Map(), totalInstances: 0 };
}

/** Build the source geometry for one surface-block InstancedMesh: a 16×16 grid of textured top quads at local Y=0. */
function buildSourceGeometry(surfaceBlock: BlockID, voxelSize: number): THREE.BufferGeometry | null {
    const atlas = getVoxelTextureAtlas();
    if (!atlas.hasBlockType(surfaceBlock)) return null;
    const uv = atlas.getBlockUV(surfaceBlock, 'top');
    const vs = voxelSize;
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    let vIdx = 0;
    for (let z = 0; z < CHUNK_SIZE; z++) {
        for (let x = 0; x < CHUNK_SIZE; x++) {
            // Top face vertex order matches FACE_TEMPLATES +Y: v0=(x,0,z), v1=(x+1,0,z), v2=(x+1,0,z+1), v3=(x,0,z+1)
            positions.push(
                x * vs, 0, z * vs,
                (x + 1) * vs, 0, z * vs,
                (x + 1) * vs, 0, (z + 1) * vs,
                x * vs, 0, (z + 1) * vs,
            );
            for (let i = 0; i < 4; i++) normals.push(0, 1, 0);
            // UVs match faceUVMaps[5] = [[0,0],[1,0],[1,1],[0,1]] for +Y face
            uvs.push(uv.u0, uv.v0, uv.u1, uv.v0, uv.u1, uv.v1, uv.u0, uv.v1);
            // Triangles follow FACE_INDICES for +Y: (0,2,1, 0,3,2) offset by vIdx
            indices.push(vIdx, vIdx + 2, vIdx + 1, vIdx, vIdx + 3, vIdx + 2);
            vIdx += 4;
        }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    return geo;
}

/**
 * Iterate every uniform entry in `columnTopIndex`, group by surface block, build
 * one InstancedMesh per group, populate the lookup maps, and add to the scene.
 *
 * Returns a fresh `UniformFlatInstancingState`. Caller is responsible for
 * disposing any previous state (geometries, removing meshes from scene) before
 * calling this on rebuild.
 */
export function buildUniformFlatInstancedMeshes(deps: UniformFlatInstancingDeps): UniformFlatInstancingState {
    const state = createEmptyInstancingState();
    // Group entries by surface block first so each block gets one sized InstancedMesh.
    const byBlock = new Map<BlockID, Array<{ cx: number; cz: number; vy: number }>>();
    deps.columnTopIndex.forEachUniform((cx, cz, vy, block) => {
        let arr = byBlock.get(block);
        if (!arr) { arr = []; byBlock.set(block, arr); }
        arr.push({ cx, cz, vy });
    });

    const vs = deps.voxelSize;
    const bX = deps.bounds?.minX ?? 0, bY = deps.bounds?.minY ?? 0, bZ = deps.bounds?.minZ ?? 0;
    const matrix = new THREE.Matrix4();

    for (const [block, entries] of byBlock) {
        const geo = buildSourceGeometry(block, vs);
        if (!geo) continue; // no atlas UV for this block — fall back to per-chunk
        const mesh = new THREE.InstancedMesh(geo, deps.material, entries.length);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        // Single AABB covers all instances; skip frustum culling so distant chunks still render.
        mesh.frustumCulled = false;
        mesh.name = `VoxelUniformFlatInstanced_${block}`;
        Object.assign(mesh.userData, { isUniformFlatInstanced: true, surfaceBlock: block, isTerrainChunk: true, isVoxelWorld: true });
        for (const [i, e] of entries.entries()) {
            const worldX = bX + e.cx * CHUNK_SIZE * vs;
            // Top surface world Y of voxel at vy = bY + (vy + 1) * voxelSize.
            const worldY = bY + (e.vy + 1) * vs;
            const worldZ = bZ + e.cz * CHUNK_SIZE * vs;
            matrix.makeTranslation(worldX, worldY, worldZ);
            mesh.setMatrixAt(i, matrix);
            // Map the chunk (using the cy that contains the surface vy) to its instance slot.
            const cy = Math.floor(e.vy / CHUNK_SIZE);
            const ckey = makeChunkKey(e.cx, cy, e.cz);
            state.chunksCoveredByInstance.add(ckey);
            state.chunkInstanceSlot.set(ckey, { mesh, index: i });
        }
        mesh.instanceMatrix.needsUpdate = true;
        deps.parentGroup.add(mesh);
        state.instanceMeshesByBlock.set(block, mesh);
        state.totalInstances += entries.length;
    }
    return state;
}

/**
 * Evict one chunk from its InstancedMesh slot. Zeros the matrix and removes the
 * lookup entries. The chunk should already be in `dirtyChunks` (the path that
 * triggered eviction is the same one that marks dirty), so the next
 * `updateCollisionVisualization` will build a normal per-chunk Mesh for it.
 *
 * Returns true if the chunk was actually in an instance slot (so callers can
 * skip work for already-evicted or never-instanced chunks).
 */
export function evictChunkFromInstance(state: UniformFlatInstancingState, chunkKey: ChunkKey): boolean {
    const slot = state.chunkInstanceSlot.get(chunkKey);
    if (!slot) return false;
    slot.mesh.setMatrixAt(slot.index, ZERO_MATRIX);
    slot.mesh.instanceMatrix.needsUpdate = true;
    state.chunkInstanceSlot.delete(chunkKey);
    state.chunksCoveredByInstance.delete(chunkKey);
    return true;
}

/** Dispose all instanced meshes (geometries + scene removal). Call when terrain is being rebuilt. */
export function disposeInstancingState(state: UniformFlatInstancingState, parentGroup: THREE.Object3D): void {
    for (const mesh of state.instanceMeshesByBlock.values()) {
        parentGroup.remove(mesh);
        mesh.geometry.dispose();
        // material is shared with regular chunk meshes — owned by VoxelWorld, not disposed here.
    }
    state.chunkInstanceSlot.clear();
    state.chunksCoveredByInstance.clear();
    state.instanceMeshesByBlock.clear();
    state.totalInstances = 0;
}
