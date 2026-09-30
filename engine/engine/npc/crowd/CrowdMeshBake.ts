/**
 * CrowdMeshBake — collapse a block character's many part meshes into ONE
 * geometry that a vertex shader can pose from a bone table.
 *
 * A block character is built as ~19 separate box meshes, each parented to a part
 * group that `BlockCharacterRenderer` re-derives every frame from the skeleton. That
 * costs 19 draw calls and a CPU pose pass PER NPC, which is what puts a ceiling
 * on crowd size: 200 visible NPCs is 3,800 draw calls and 200 skeleton
 * evaluations, while the triangles involved (~228 each) are trivial.
 *
 * The merge is LOSSLESS, which is the property that makes this worth doing.
 * Every box belongs to exactly one part group, so one influence per vertex
 * reproduces the articulation exactly — there is no weight blending to
 * approximate and no visual compromise at any distance. That is specific to
 * block characters; a real skinned GLB has blended weights and cannot be merged
 * this way (see the design spec).
 *
 * Vertices are baked into PART-LOCAL space (the bind-pose inverse is applied
 * here, once, rather than being carried as a per-part matrix multiply at
 * runtime), so posing a vertex is a single matrix fetch and multiply:
 *
 *     worldPosition = partWorldMatrix[boneIndex] * bakedPosition
 *
 * The bake captures whatever pose the character is in when it runs, so callers
 * must bake from the REST/BIND pose — baking mid-animation freezes that frame
 * into the geometry.
 */
import * as THREE from 'three';

/** One merged, GPU-poseable character variant. */
export interface MergedCharacterGeometry {
    /**
     * Position/normal/uv/color plus a `boneIndex` attribute. Not a
     * THREE.SkinnedMesh geometry: there are no skinWeight/skinIndex attributes,
     * because a single influence needs neither.
     */
    geometry: THREE.BufferGeometry;
    /** Bone name per index, so a caller can map a skeleton onto the table. */
    boneNames: string[];
    /** Bind-pose world matrix per bone index, for callers that need to rebuild the table. */
    bindMatrices: THREE.Matrix4[];
    triangleCount: number;
    /** Source meshes collapsed, for diagnostics and tests. */
    sourceMeshCount: number;
}

/**
 * One posed part of a block character — a body-part GROUP, not a skeleton bone.
 *
 * The group is deliberately the unit of articulation here. `BlockCharacterRenderer`
 * does not simply copy a bone's matrix onto a part: limbs are placed from JOINT
 * PAIRS, the torso from a shoulder-line basis (with a 180° flip under pose v2),
 * the head from the cached torso rotation rather than the head bone, and hands
 * get a width offset. Sampling bones would reproduce none of that — measured
 * against the CPU rig it agrees at bind pose and then drifts apart as soon as
 * anything rotates, so a crowd member would visibly change animation at the LOD
 * swap. Sampling the group captures whatever the rig computed, without this
 * module having to know any of it.
 */
export interface PartBinding {
    /**
     * The part group whose descendant meshes are baked. Its CURRENT world matrix
     * is taken as the bind pose, and the animation table must sample this SAME
     * object (see CrowdAnimationBake) or the indices will not correspond.
     */
    group: THREE.Object3D;
}

const _mat = new THREE.Matrix4();
const _normalMat = new THREE.Matrix3();
const _v = new THREE.Vector3();

/**
 * Merge every mesh under `bindings` into one geometry.
 *
 * Meshes whose part group has no binding are DROPPED rather than baked
 * unskinned: an unbound part would sit frozen at the origin of every animated
 * NPC, which is far more visible than its absence. BlockCharacterRenderer warns
 * about unbound groups at build time, so this mirrors what already renders.
 */
export function mergeBlockCharacter(bindings: ReadonlyArray<PartBinding>): MergedCharacterGeometry {
    // World matrices must be current: the bake reads them to derive bind-pose
    // inverses, and a stale matrix bakes the wrong offset silently.
    for (const b of bindings) {
        b.group.updateWorldMatrix(true, true);
    }

    const boneNames: string[] = [];
    const bindMatrices: THREE.Matrix4[] = [];
    const boneIndexOf = new Map<THREE.Object3D, number>();

    // Pass 1: collect the meshes and their bone assignment, and total the sizes
    // so the output arrays are allocated once.
    const entries: Array<{ mesh: THREE.Mesh; boneIndex: number }> = [];
    let vertexTotal = 0;
    let indexTotal = 0;
    for (const binding of bindings) {
        let boneIndex = boneIndexOf.get(binding.group);
        if (boneIndex === undefined) {
            boneIndex = boneNames.length;
            boneIndexOf.set(binding.group, boneIndex);
            boneNames.push(binding.group.name);
            bindMatrices.push(binding.group.matrixWorld.clone());
        }
        binding.group.traverse((child) => {
            const mesh = child as THREE.Mesh;
            if (!mesh.isMesh || !mesh.geometry) return;
            const pos = mesh.geometry.getAttribute('position');
            if (!pos) return;
            entries.push({ mesh, boneIndex: boneIndex! });
            vertexTotal += pos.count;
            indexTotal += mesh.geometry.getIndex()?.count ?? pos.count;
        });
    }

    const positions = new Float32Array(vertexTotal * 3);
    const normals = new Float32Array(vertexTotal * 3);
    const colors = new Float32Array(vertexTotal * 3);
    // uint8 caps a character at 256 bones. A block character has ~19; even a
    // Mixamo rig is ~65. Widening later is a one-line attribute change.
    const boneIndices = new Uint8Array(vertexTotal);
    // Index width follows the vertex count: a merged block character is a few
    // hundred vertices, so Uint16 is the norm and halves the buffer.
    const indices: Uint16Array | Uint32Array =
        vertexTotal > 65535 ? new Uint32Array(indexTotal) : new Uint16Array(indexTotal);

    let vHead = 0;
    let iHead = 0;
    for (const { mesh, boneIndex } of entries) {
        const geo = mesh.geometry;
        const pos = geo.getAttribute('position');
        const nrm = geo.getAttribute('normal');
        const col = geo.getAttribute('color');

        // Bake into the bone's space: bindInverse * meshWorld. Applying the
        // bind inverse HERE means the runtime pose is one matrix multiply.
        _mat.copy(bindMatrices[boneIndex]!).invert().multiply(mesh.matrixWorld);
        _normalMat.getNormalMatrix(_mat);

        // Per-mesh colour when the geometry carries none: block characters get
        // their palette from the MATERIAL, and a merged mesh has only one, so
        // the colour has to move into the vertices or every part turns the same
        // shade.
        const matColor = resolveMeshColor(mesh);

        const base = vHead;
        for (let i = 0; i < pos.count; i++) {
            _v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(_mat);
            positions[vHead * 3] = _v.x;
            positions[vHead * 3 + 1] = _v.y;
            positions[vHead * 3 + 2] = _v.z;
            if (nrm) {
                _v.set(nrm.getX(i), nrm.getY(i), nrm.getZ(i)).applyMatrix3(_normalMat).normalize();
                normals[vHead * 3] = _v.x;
                normals[vHead * 3 + 1] = _v.y;
                normals[vHead * 3 + 2] = _v.z;
            }
            if (col) {
                colors[vHead * 3] = col.getX(i);
                colors[vHead * 3 + 1] = col.getY(i);
                colors[vHead * 3 + 2] = col.getZ(i);
            } else {
                colors[vHead * 3] = matColor.r;
                colors[vHead * 3 + 1] = matColor.g;
                colors[vHead * 3 + 2] = matColor.b;
            }
            boneIndices[vHead] = boneIndex;
            vHead++;
        }

        const srcIndex = geo.getIndex();
        if (srcIndex) {
            for (let i = 0; i < srcIndex.count; i++) indices[iHead++] = base + srcIndex.getX(i);
        } else {
            for (let i = 0; i < pos.count; i++) indices[iHead++] = base + i;
        }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    // Not normalized: the shader indexes the bone table with it directly.
    geometry.setAttribute('boneIndex', new THREE.BufferAttribute(boneIndices, 1));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeBoundingSphere();

    return {
        geometry,
        boneNames,
        bindMatrices,
        triangleCount: iHead / 3,
        sourceMeshCount: entries.length,
    };
}

/** Flat colour of a mesh's material, defaulting to white when it has none. */
function resolveMeshColor(mesh: THREE.Mesh): THREE.Color {
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const c = (material as THREE.MeshStandardMaterial | undefined)?.color;
    return c ? c : new THREE.Color(1, 1, 1);
}
