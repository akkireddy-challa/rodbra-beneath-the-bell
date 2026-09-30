/**
 * The scene-graph shape of a smart object: one mesh per part, each under a
 * pivot group, nested by the parts' hierarchy.
 *
 *   view (at the VoxelObject's origin)
 *   ├── body mesh                       joint 0, never moves
 *   └── pivot[1] @ bind offset          e.g. the wheel
 *       ├── wheel mesh @ −pivotWorld
 *       └── pivot[2] @ bind offset      e.g. a cabin, parented to the wheel
 *           └── cabin mesh @ −pivotWorld
 *
 * Every mesh is built in the VoxelObject's own vertex space (object-local,
 * relative to its voxel pivot — the space `getMesh()` uses), so placing one
 * under a pivot group is a translation by minus the pivot's position in that
 * space; rotating the group then turns the part about its pivot. Pivot groups
 * carry the rig's bind offsets, which are LOCAL to the parent joint exactly as a
 * character rig's are, so the hierarchy composes with no per-part maths here.
 *
 * Pure three.js on purpose: `VoxelObject.buildSmartPartMeshes()` supplies the
 * meshes and the decoded rig supplies the offsets, and this class knows about
 * neither voxels nor files. That is what makes it testable on node with plain
 * `THREE.Mesh`es, and what keeps `SmartObjectSystem` a motion problem only.
 */

import * as THREE from 'three';
import type { VxlV3Part } from 'engine/VxlV3Parts.js';

export interface SmartObjectViewInput {
    /** In joint order: `parts[i]` is joint i + 1. */
    parts: readonly VxlV3Part[];
    /** `(parts.length + 1) * 3` bind LOCAL translations, joint 0 = body at the origin. */
    bindPositions: Float32Array;
    /** The meshes by joint; a joint that owns no leaves is simply absent. */
    meshes: ReadonlyArray<{ joint: number; mesh: THREE.Object3D }>;
    /**
     * The VoxelObject's voxel pivot in its own frame. Mesh vertices are relative
     * to it; bind positions are in the asset frame. The difference is what this
     * subtracts, and for a compiled asset it is the origin.
     */
    pivot?: { x: number; y: number; z: number };
}

export class SmartObjectView extends THREE.Group {
    /** Pivot group per joint; index 0 is this view itself (the body never moves). */
    readonly pivots: THREE.Object3D[];
    /** Each joint's pivot in the asset frame (bind offsets accumulated down the hierarchy). */
    readonly pivotAssetPositions: readonly THREE.Vector3[];
    readonly parts: readonly VxlV3Part[];

    constructor(input: SmartObjectViewInput) {
        super();
        this.name = 'smartObjectView';
        this.parts = input.parts;
        const jointCount = input.parts.length + 1;
        if (input.bindPositions.length !== jointCount * 3) {
            throw new Error(`SmartObjectView: ${jointCount} joints but ${input.bindPositions.length / 3} bind positions`);
        }
        const pivotOffset = input.pivot ?? { x: 0, y: 0, z: 0 };

        // Pivot groups, parents first (the parts table is validated parents-first
        // on encode), accumulating each joint's position in the asset frame.
        this.pivots = new Array<THREE.Object3D>(jointCount);
        this.pivots[0] = this;
        const assetPosition = new Array<THREE.Vector3>(jointCount);
        assetPosition[0] = new THREE.Vector3(0, 0, 0);
        for (let joint = 1; joint < jointCount; joint++) {
            const part = input.parts[joint - 1]!;
            const local = new THREE.Vector3(
                input.bindPositions[joint * 3 + 0]!,
                input.bindPositions[joint * 3 + 1]!,
                input.bindPositions[joint * 3 + 2]!,
            );
            const group = new THREE.Group();
            group.name = `smartPart:${part.name}`;
            group.position.copy(local);
            this.pivots[part.parentJoint]!.add(group);
            this.pivots[joint] = group;
            assetPosition[joint] = assetPosition[part.parentJoint]!.clone().add(local);
        }

        // Meshes: the body at the origin, each part translated back by its own
        // pivot so its voxels stay where they were voxelized.
        for (const { joint, mesh } of input.meshes) {
            const group = this.pivots[joint];
            if (!group) continue;
            if (joint > 0) {
                const p = assetPosition[joint]!;
                mesh.position.set(
                    -(p.x - pivotOffset.x),
                    -(p.y - pivotOffset.y),
                    -(p.z - pivotOffset.z),
                );
            }
            group.add(mesh);
        }
        this.pivotAssetPositions = assetPosition;
    }

    /** The joint a part animates — `parts[i]` is joint i + 1 — or -1 for an unknown name. */
    private jointOf(name: string): number {
        const index = this.parts.findIndex((part) => part.name === name);
        return index < 0 ? -1 : index + 1;
    }

    /** The pivot group of a part by name, or null. */
    pivotOf(name: string): THREE.Object3D | null {
        const joint = this.jointOf(name);
        return joint < 0 ? null : this.pivots[joint] ?? null;
    }

    /**
     * Where a point given in the asset frame is NOW, in world space, when it
     * rides `name`. Asset-frame points are what the record stores (a light's
     * `offset`, a fitment pivot); under the part's pivot group they are that
     * point minus the pivot, which is the same re-basing every part mesh gets.
     */
    assetPointOnPartToWorld(name: string, point: { x: number; y: number; z: number }, out: THREE.Vector3): boolean {
        const joint = this.jointOf(name);
        if (joint < 0) return false;
        const group = this.pivots[joint];
        const pivot = this.pivotAssetPositions[joint];
        if (!group || !pivot) return false;
        out.set(point.x - pivot.x, point.y - pivot.y, point.z - pivot.z);
        // The pose was written this frame; the matrices are refreshed at render,
        // which is after the caller needs this.
        group.updateWorldMatrix(true, false);
        group.localToWorld(out);
        return true;
    }

    /** Release every mesh's geometry and material. */
    disposeMeshes(): void {
        this.traverse((node) => {
            const mesh = node as THREE.Mesh;
            if (!mesh.isMesh) return;
            mesh.geometry?.dispose();
            const material = mesh.material;
            if (Array.isArray(material)) material.forEach((m) => m.dispose());
            else material?.dispose();
        });
    }
}
