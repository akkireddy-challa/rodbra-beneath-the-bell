/**
 * GlbInstancing — draw many placed copies of one GLB environment asset with ONE draw call per
 * sub-mesh instead of one per copy.
 *
 * A forged low-poly world places hundreds of the same tree, rock or bush (a ski slope measured
 * 966 objects → 1,022 visible meshes, 1,262 draw calls a frame). Each copy stays a real,
 * registered Object3D — the ObjectIdService entry, the editor's picking, the physics colliders
 * sized from its meshes and any code that moves, hides or deletes it all keep working — but its
 * meshes are made invisible (`visible = false` skips rendering and shadow passes; Raycaster
 * ignores visibility, so picking and bounds still see them). One InstancedMesh per template
 * sub-mesh draws every copy from the copies' own world matrices, synced before each render.
 *
 * A copy that leaves the scene (deleted) or sits under a hidden ancestor (culled, hidden in the
 * editor) is drawn at zero scale, so the batch always shows exactly what the copies would.
 */

import * as THREE from 'three';

/** Fewer placements than this render as plain clones — instancing buys nothing for a handful. */
export const GLB_INSTANCING_MIN_COPIES = 8;

/** Can this GLB scene be drawn instanced? Skinned or morphing meshes animate per copy, so they cannot. */
export function isInstanceableGlb(scene: THREE.Object3D): boolean {
    let ok = true;
    scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if ((o as THREE.SkinnedMesh).isSkinnedMesh) ok = false;
        else if (mesh.isMesh && mesh.morphTargetInfluences && mesh.morphTargetInfluences.length > 0) ok = false;
    });
    return ok;
}

function meshesOf(root: THREE.Object3D): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    root.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh);
    });
    return out;
}

/** Whether `object` is attached under `root` with every ancestor visible. */
function shownUnder(object: THREE.Object3D, root: THREE.Object3D): boolean {
    let node: THREE.Object3D | null = object;
    while (node) {
        if (!node.visible) return false;
        if (node === root) return true;
        node = node.parent;
    }
    return false;
}

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

/** userData flag on a copy's mesh the batch draws in its place (hidden, but on screen). */
const DRAWN_BY_BATCH = 'drawnByInstanceBatch';
/** userData flag on the batch's own InstancedMeshes (on screen, but not an object anyone picks). */
const BATCH_DRAW = 'instanceBatchDraw';

/**
 * Whether a mesh is on screen for picking purposes: visible, or hidden only because an instance
 * batch draws it. The batch's own InstancedMeshes are never picked — the copy they draw is. Every
 * editor raycast that skips invisible meshes should ask this instead of `mesh.visible`, or
 * instanced objects cannot be clicked.
 */
export function isPickableOnScreen(mesh: THREE.Object3D): boolean {
    if (mesh.userData[BATCH_DRAW] === true) return false;
    return mesh.visible || mesh.userData[DRAWN_BY_BATCH] === true;
}

export class GlbInstanceBatch {
    /** Holds the InstancedMeshes; added to the world, torn down like any placed object. */
    readonly root = new THREE.Group();
    private readonly instanced: THREE.InstancedMesh[];
    /** Per copy: its meshes, in the template's traversal order. */
    private readonly copies: Array<{ owner: THREE.Object3D; meshes: THREE.Mesh[] }> = [];
    private readonly parentInverse = new THREE.Matrix4();
    private readonly scratch = new THREE.Matrix4();

    /**
     * @param template The asset's centred scene — its meshes' geometry and materials are shared.
     * @param world    The group the copies are placed in (the batch's root joins it).
     * @param capacity How many copies will be added.
     */
    constructor(template: THREE.Object3D, private readonly world: THREE.Object3D, capacity: number) {
        this.root.name = `GlbInstanceBatch(${template.name || 'glb'})`;
        this.instanced = meshesOf(template).map((mesh) => {
            const inst = new THREE.InstancedMesh(mesh.geometry, mesh.material, capacity);
            inst.name = `${this.root.name}/${mesh.name}`;
            inst.castShadow = true;
            inst.receiveShadow = true;
            // Copies spread over the whole level: one bounding sphere per batch would be culled
            // wrongly as instances move, and there is one draw call either way.
            inst.frustumCulled = false;
            inst.count = 0;
            inst.userData[BATCH_DRAW] = true;
            this.root.add(inst);
            return inst;
        });
        world.add(this.root);
    }

    /** Take over drawing `owner` (a clone of the template): its meshes go invisible, the batch draws them. */
    add(owner: THREE.Object3D): void {
        const meshes = meshesOf(owner);
        for (const mesh of meshes) {
            mesh.visible = false;
            mesh.userData[DRAWN_BY_BATCH] = true;
        }
        this.copies.push({ owner, meshes });
        for (const inst of this.instanced) inst.count = this.copies.length;
    }

    /** Sync every copy's current world transform into the batch. Cheap: a matrix multiply per copy and sub-mesh. */
    update(): void {
        this.world.updateMatrixWorld();
        this.parentInverse.copy(this.root.matrixWorld).invert();
        for (let i = 0; i < this.copies.length; i++) {
            const copy = this.copies[i]!;
            const shown = shownUnder(copy.owner, this.world);
            for (let k = 0; k < this.instanced.length; k++) {
                const mesh = copy.meshes[k];
                if (!shown || !mesh) {
                    this.instanced[k]!.setMatrixAt(i, ZERO);
                    continue;
                }
                this.scratch.multiplyMatrices(this.parentInverse, mesh.matrixWorld);
                this.instanced[k]!.setMatrixAt(i, this.scratch);
            }
        }
        for (const inst of this.instanced) inst.instanceMatrix.needsUpdate = true;
    }

    /** Detach the batch. Geometry and materials stay: they belong to the loaded GLB, shared with the copies. */
    dispose(): void {
        this.root.removeFromParent();
        for (const inst of this.instanced) inst.dispose();
        this.copies.length = 0;
    }
}
