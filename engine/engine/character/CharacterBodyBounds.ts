import * as THREE from 'three';

// Character geometry is immutable and shared by cloned NPCs. Cache the vertices
// influenced by each bone as boxes, so a swing transforms bones, not every vertex.
const skinBounds = new WeakMap<THREE.BufferGeometry, Map<number, THREE.Box3>>();
const _vertex = new THREE.Vector3();
const _box = new THREE.Box3();
const _skinToWorld = new THREE.Matrix4();
const _boneTransform = new THREE.Matrix4();

function getSkinBounds(geometry: THREE.BufferGeometry): Map<number, THREE.Box3> {
    const cached = skinBounds.get(geometry);
    if (cached) return cached;
    const boxes = new Map<number, THREE.Box3>();
    const positions = geometry.getAttribute('position');
    const indices = geometry.getAttribute('skinIndex');
    const weights = geometry.getAttribute('skinWeight');
    for (let i = 0; i < positions.count; i++) {
        _vertex.fromBufferAttribute(positions, i);
        for (let j = 0; j < 4; j++) {
            if (weights.getComponent(i, j) <= 0) continue;
            const index = indices.getComponent(i, j);
            let box = boxes.get(index);
            if (!box) {
                box = new THREE.Box3();
                boxes.set(index, box);
            }
            box.expandByPoint(_vertex);
        }
    }
    skinBounds.set(geometry, boxes);
    return boxes;
}

/**
 * Bounds of the posed body in world space, pruning entire held-object subtrees.
 * Geometry bounds alone describe a skinned GLB's undeformed vertices, which can
 * be far from its rendered body. Each bone's transformed influence box encloses
 * its vertices; their union also encloses normalized, blended skin weights.
 * After the first query this costs O(bones), including across NPC clones.
 */
export function computeCharacterBodyBox(root: THREE.Object3D, out: THREE.Box3): THREE.Box3 {
    out.makeEmpty();
    // Refresh parents BEFORE descendants, including SkinnedMesh.updateMatrixWorld
    // (which updates bindMatrixInverse). Combat can run before the renderer does.
    root.parent?.updateWorldMatrix(true, false);
    root.updateMatrixWorld(true);
    const visit = (node: THREE.Object3D): void => {
        const ud = node.userData;
        if (ud.isUserAttached || ud.isMeleeWeapon || ud.isVisualOnly || ud.noPhysics) return;
        if (node instanceof THREE.SkinnedMesh) {
            if (node.morphTargetInfluences?.some(weight => weight !== 0)) {
                // Morphs change vertices before skinning, so the cached base boxes
                // cannot describe them. Three's posed bounds include active morphs.
                node.computeBoundingBox();
                out.union(_box.copy(node.boundingBox!).applyMatrix4(node.matrixWorld));
            } else {
                // Three's skinning chain; its mesh-constant head is hoisted out
                // of the per-bone loop.
                _skinToWorld.copy(node.matrixWorld).multiply(node.bindMatrixInverse);
                for (const [index, box] of getSkinBounds(node.geometry)) {
                    _boneTransform.copy(_skinToWorld)
                        .multiply(node.skeleton.bones[index]!.matrixWorld)
                        .multiply(node.skeleton.boneInverses[index]!)
                        .multiply(node.bindMatrix);
                    out.union(_box.copy(box).applyMatrix4(_boneTransform));
                }
            }
        } else if (node instanceof THREE.Mesh) {
            if (!node.geometry.boundingBox) node.geometry.computeBoundingBox();
            out.union(_box.copy(node.geometry.boundingBox!).applyMatrix4(node.matrixWorld));
        }
        for (const child of node.children) visit(child);
    };
    visit(root);
    return out;
}
