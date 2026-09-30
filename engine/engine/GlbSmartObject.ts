/**
 * Smart objects drawn as GLB meshes: a low-poly prop whose file declares moving parts
 * (`scene.extras.bmSmartObject` + one `BM_part_<name>` node per part — the same contract the
 * World-Forger's archetypes and a voxel bake read) animates through `SmartObjectSystem` without
 * being voxelized.
 *
 * The voxel lane bakes the declaration into the `.vxl` (a part channel, a rig, `smartObject` on
 * the record). A placed GLB has none of that, so it is derived here when the asset loads, with the
 * voxel lane's own maths (`smartPropBake`): one box per part from its node's geometry, pivots
 * defaulted from those boxes, the rig's bind offsets. Each placed instance then hands its part
 * nodes to a `SmartObjectView` through the host interface `SmartObjectSystem.attach()` takes; the
 * rest of the model stays where it is and draws as the body.
 *
 * Frames. The ASSET frame is the placed object's own: bottom-centre origin, metres, after the
 * asset's fit-to-targetHeight scale — what `SmartObjectView` calls the host's vertex space. The
 * declaration is authored in the GLB's native frame (Y up, as bmedit exports), mapped into the
 * asset frame by the same re-centre and scale the loader gives the model.
 */

import * as THREE from 'three';
import type { SmartObjectHost } from 'engine/SmartObjectSystem.js';
import type { VxlV3Part } from 'engine/VxlV3Parts.js';
import {
    BM_PART_NODE_PREFIX,
    BM_SMART_OBJECT_EXTRAS_KEY,
    isBmPartNodeName,
    readSmartPropSpec,
    smartPropBake,
    type AssetBox,
    type SmartPropBake,
} from 'engine/import/SmartPropParts.js';
import type { Vector3Like } from 'types/game.js';

/** The native→asset mapping the GLB loader applies to a model. */
export interface GlbAssetFrame {
    /** Native point that lands on the asset origin: bbox centre X/Z, bbox bottom Y. */
    origin: Vector3Like;
    /** The fit-to-targetHeight scale. */
    scale: number;
    /** The small lift the loader puts under every GLB (z-fighting). */
    lift: number;
}

export interface GlbSmartDerivation {
    bake: SmartPropBake;
    warnings: string[];
}

/**
 * The smart declaration of a loaded GLB scene, or null when it declares none. `scene` is the
 * loader's raw scene (native frame, untransformed): three's GLTFLoader puts scene extras on its
 * `userData`.
 */
export function deriveGlbSmartObject(scene: THREE.Object3D, frame: GlbAssetFrame): GlbSmartDerivation | null {
    const warnings: string[] = [];
    const spec = readSmartPropSpec(scene.userData?.[BM_SMART_OBJECT_EXTRAS_KEY], warnings);
    if (!spec) return null;

    const toAsset = (p: Vector3Like): Vector3Like => ({
        x: (p.x - frame.origin.x) * frame.scale,
        y: (p.y - frame.origin.y) * frame.scale + frame.lift,
        z: (p.z - frame.origin.z) * frame.scale,
    });

    // One asset-frame box per part node, from its geometry (children included).
    scene.updateMatrixWorld(true);
    const boxes = new Map<string, AssetBox>();
    const native = new THREE.Box3();
    scene.traverse((node) => {
        if (!isBmPartNodeName(node.name)) return;
        native.setFromObject(node, true);
        if (native.isEmpty()) return;
        const min = toAsset(native.min);
        const max = toAsset(native.max);
        boxes.set(node.name.slice(BM_PART_NODE_PREFIX.length), { min, max });
    });

    const bake = smartPropBake(spec, boxes, toAsset, warnings);
    return bake && bake.table.length > 0 ? { bake, warnings } : null;
}

/** Node name prefix of a named point on a part (bmedit's `anchor()`): a seat, a cabin floor. */
export const BM_ANCHOR_NODE_PREFIX = 'BM_anchor_';

/**
 * bmedit writes an anchor as `BM_anchor_<owner>__<name>` (Blender names are global, and every cabin
 * has a `floor`); in the placed model it becomes `BM_anchor_<name>`, so game code asks each part
 * the same question — `smart.pivotOf(id, 'cabin_3')?.getObjectByName('BM_anchor_floor')` — and finds
 * a fixed one on the placed object: `getObjectIdService().getObjectById(id)?.getObjectByName('BM_anchor_door')`.
 */
export function canonicalAnchorNames(part: THREE.Object3D): void {
    part.traverse((node) => {
        if (!node.name.startsWith(BM_ANCHOR_NODE_PREFIX)) return;
        const rest = node.name.slice(BM_ANCHOR_NODE_PREFIX.length);
        const split = rest.indexOf('__');
        if (split >= 0) node.name = `${BM_ANCHOR_NODE_PREFIX}${rest.slice(split + 2)}`;
    });
}

/**
 * A placed GLB instance that is also its own `SmartObjectSystem` host: the loader builds a smart
 * asset's instances as this group instead of a plain one (same transform, same body child), then
 * `liftParts()` moves its part nodes into wrappers that carry each node's rest transform relative
 * to the instance, so the view can hang them under pivot groups. The body is everything left
 * behind and keeps drawing as it was (there is no single mesh to hide, so `getMesh()` is null).
 */
export class GlbSmartObjectHost extends THREE.Group implements SmartObjectHost {
    private readonly partMeshes: Array<{ joint: number; mesh: THREE.Object3D }> = [];

    constructor(private readonly bake: SmartPropBake) {
        super();
    }

    /**
     * Take the declared part nodes out of this instance's body (already built and placed).
     * False when none of them has a node here — then there is nothing to animate.
     */
    liftParts(): boolean {
        const jointByNode = new Map(this.bake.table.map((part, index) => [`${BM_PART_NODE_PREFIX}${part.name}`, index + 1]));
        this.updateMatrixWorld(true);
        const toInstance = this.matrixWorld.clone().invert();
        const found: Array<{ node: THREE.Object3D; joint: number; rest: THREE.Matrix4 }> = [];
        this.traverse((node) => {
            const joint = jointByNode.get(node.name);
            if (joint !== undefined) found.push({ node, joint, rest: toInstance.clone().multiply(node.matrixWorld) });
        });

        // Rest matrices first, then detach: a part nested in another part must not carry its
        // parent's motion as well as its own.
        for (const { node, joint, rest } of found) {
            node.removeFromParent();
            canonicalAnchorNames(node);
            // Own copies: the clone shares geometry and materials with the asset's other
            // instances, and the view disposes its meshes when the instance goes.
            node.traverse((child) => {
                const mesh = child as THREE.Mesh;
                if (!mesh.isMesh) return;
                mesh.geometry = mesh.geometry.clone();
                mesh.material = Array.isArray(mesh.material) ? mesh.material.map((m) => m.clone()) : mesh.material.clone();
            });
            node.position.set(0, 0, 0);
            node.quaternion.identity();
            node.scale.set(1, 1, 1);
            const holder = new THREE.Group();
            rest.decompose(holder.position, holder.quaternion, holder.scale);
            holder.add(node);
            // The view sets the wrapper's position (minus the part's pivot); the holder keeps the
            // node where it was in the instance frame.
            const wrapper = new THREE.Group();
            wrapper.name = `glbSmartPart:${node.name}`;
            wrapper.add(holder);
            this.partMeshes.push({ joint, mesh: wrapper });
        }
        return this.partMeshes.length > 0;
    }

    /**
     * Put the lifted parts back into the instance, still, at their rest pose — for when no
     * `SmartObjectSystem` took them, so the model is never left missing its wheel.
     */
    restoreParts(): void {
        for (const { mesh } of this.partMeshes) this.add(mesh);
    }

    // ---- SmartObjectHost -------------------------------------------------------------------

    getDecodedVxlV3(): { parts: VxlV3Part[]; rig: { bindPositions: Float32Array } } {
        return { parts: this.bake.table, rig: { bindPositions: this.bake.rig.bindPositions } };
    }

    buildSmartPartMeshes(): Array<{ joint: number; mesh: THREE.Mesh }> {
        // The view only positions and parents these; a wrapper group serves as well as a mesh.
        return this.partMeshes as unknown as Array<{ joint: number; mesh: THREE.Mesh }>;
    }

    getMesh(): THREE.Mesh | null {
        return null;
    }

    getPivot(): null {
        return null;
    }
}
