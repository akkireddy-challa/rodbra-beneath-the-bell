/**
 * CrowdRenderer — draws a whole character variant in one instanced call, posed
 * on the GPU.
 *
 * The pieces it joins: CrowdMeshBake collapses a block character's ~19 part
 * meshes into one geometry with a single `boneIndex` per vertex;
 * CrowdAnimationBake samples the clips into a bone table; CrowdSkinnedMaterial
 * fetches `bone[frameRow][boneIndex]` in the vertex shader. What this class adds
 * is the per-instance data and the slot bookkeeping — so N NPCs of one variant
 * cost ONE draw call and zero CPU posing, against 19 draws and ~1.8 ms of
 * `updateMatrixWorld` each today.
 *
 * ## Slots
 *
 * An NPC holds a slot for as long as it renders through the crowd. Release is a
 * swap-with-last so the live instances stay a dense prefix and `count` alone
 * decides what draws — no holes to skip, no per-frame compaction. The moved
 * instance's owner is told its new index, which is why callers hold a handle
 * rather than an integer.
 *
 * ## Leaving the crowd
 *
 * A member that stops being interchangeable — it dies and needs voxel-shatter
 * debris, takes per-part damage, or is promoted to hero — releases its slot and
 * goes back to an articulated character. Same shape as
 * PristineDynamicVoxelObject: batched until an event forces individuality, and
 * the batch never pays for what has not happened.
 */
import * as THREE from 'three';
import {
    CROWD_INSTANCE_FRAME_ATTRIBUTE,
    CROWD_INSTANCE_XFM_ATTRIBUTE,
    CROWD_INSTANCE_YAW_ATTRIBUTE,
} from 'engine/npc/crowd/CrowdSkinnedMaterial.js';

/** Live state the renderer reads for one instance each frame. */
export interface CrowdRenderMember {
    /** World position of the character root. */
    getCrowdX(): number;
    getCrowdY(): number;
    getCrowdZ(): number;
    /** Facing, radians. Crowd characters are upright, so yaw is the whole rotation. */
    getCrowdYaw(): number;
    /** Row into the baked bone table — see resolveFrameRow. */
    getCrowdFrameRow(): number;
    /** Per-instance tint; palette variation rides on instanceColor. */
    getCrowdColor(): THREE.Color;
    /**
     * Uniform scale of the character root, default 1. A `.vxl` townsperson a
     * game shrank to human height must shrink in the batch too, or it grows
     * back to giant size the moment it crosses the ring boundary.
     */
    getCrowdScale?(): number;
}

/** Handle to one instance. Opaque: the index moves when other slots are released. */
export interface CrowdSlot {
    readonly variant: string;
    /** @internal Current index; maintained by the renderer on compaction. */
    index: number;
    released: boolean;
}

interface VariantBatch {
    name: string;
    mesh: THREE.InstancedMesh;
    frameAttr: THREE.InstancedBufferAttribute;
    /** xyz position + w scale, and yaw — the WebGPU shader's placement (see CrowdSkinnedMaterial). */
    xfmAttr: THREE.InstancedBufferAttribute;
    yawAttr: THREE.InstancedBufferAttribute;
    members: (CrowdRenderMember | null)[];
    slots: (CrowdSlot | null)[];
    count: number;
    capacity: number;
}

/** Starting capacity per variant; grows by doubling. */
const INITIAL_CAPACITY = 64;

export class CrowdRenderer {
    private batches = new Map<string, VariantBatch>();
    private readonly scratchMatrix = new THREE.Matrix4();
    private readonly scratchQuat = new THREE.Quaternion();
    private readonly scratchPos = new THREE.Vector3();
    private readonly scratchScale = new THREE.Vector3(1, 1, 1);
    private readonly up = new THREE.Vector3(0, 1, 0);

    /**
     * Register a baked variant. `geometry` and `material` come from the bakes;
     * the renderer owns neither and disposes neither, because both are shared
     * per-type templates that outlive any single level's crowd.
     */
    registerVariant(name: string, geometry: THREE.BufferGeometry, material: THREE.Material, parent: THREE.Object3D): void {
        if (this.batches.has(name)) return;
        this.batches.set(name, this.createBatch(name, geometry, material, parent, INITIAL_CAPACITY));
    }

    /** Whether a variant has been registered (callers fall back to articulated rendering if not). */
    hasVariant(name: string): boolean {
        return this.batches.has(name);
    }

    /**
     * Claim an instance for `member`. Returns null when the variant is unknown —
     * the caller must keep rendering that NPC the old way rather than have it
     * silently vanish.
     */
    acquire(variant: string, member: CrowdRenderMember): CrowdSlot | null {
        const batch = this.batches.get(variant);
        if (!batch) return null;
        if (batch.count === batch.capacity) this.grow(batch);
        const index = batch.count++;
        const slot: CrowdSlot = { variant, index, released: false };
        batch.members[index] = member;
        batch.slots[index] = slot;
        batch.mesh.count = batch.count;
        return slot;
    }

    /**
     * Give up an instance. The last live instance is swapped into the hole so the
     * prefix stays dense; its slot handle is updated in place, which is why a
     * caller must never cache `slot.index` across a release.
     */
    release(slot: CrowdSlot): void {
        if (slot.released) return;
        const batch = this.batches.get(slot.variant);
        if (!batch) return;
        slot.released = true;
        const last = batch.count - 1;
        const hole = slot.index;
        if (hole !== last) {
            const movedMember = batch.members[last]!;
            const movedSlot = batch.slots[last]!;
            batch.members[hole] = movedMember;
            batch.slots[hole] = movedSlot;
            movedSlot.index = hole;
        }
        batch.members[last] = null;
        batch.slots[last] = null;
        batch.count = last;
        batch.mesh.count = last;
    }

    /**
     * Push every live instance's transform, animation frame and tint to the GPU.
     * Call once per frame, after the crowd solver has settled positions.
     *
     * Yaw-only rotation is built directly rather than via Euler->Quaternion on a
     * scratch Object3D: this runs for every visible crowd member every frame, and
     * the difference is a sin/cos versus a full matrix compose.
     */
    update(): void {
        for (const batch of this.batches.values()) {
            if (batch.count === 0) continue;
            for (let i = 0; i < batch.count; i++) {
                const member = batch.members[i];
                if (!member) continue;
                this.scratchPos.set(member.getCrowdX(), member.getCrowdY(), member.getCrowdZ());
                const yaw = member.getCrowdYaw();
                const scale = member.getCrowdScale?.() ?? 1;
                this.scratchQuat.setFromAxisAngle(this.up, yaw);
                this.scratchScale.setScalar(scale);
                this.scratchMatrix.compose(this.scratchPos, this.scratchQuat, this.scratchScale);
                batch.mesh.setMatrixAt(i, this.scratchMatrix);
                batch.mesh.setColorAt(i, member.getCrowdColor());
                batch.frameAttr.setX(i, member.getCrowdFrameRow());
                batch.xfmAttr.setXYZW(i, this.scratchPos.x, this.scratchPos.y, this.scratchPos.z, scale);
                batch.yawAttr.setX(i, yaw);
            }
            batch.mesh.instanceMatrix.needsUpdate = true;
            if (batch.mesh.instanceColor) batch.mesh.instanceColor.needsUpdate = true;
            batch.frameAttr.needsUpdate = true;
            batch.xfmAttr.needsUpdate = true;
            batch.yawAttr.needsUpdate = true;
            // InstancedMesh caches a bounding sphere on first use and never
            // invalidates it; with instances moving every frame a stale sphere
            // frustum-culls the whole crowd once the player walks away from
            // where it first stood.
            batch.mesh.boundingSphere = null;
        }
    }

    /** Live instance count per variant, for the debug HUD and tests. */
    getStats(): Array<{ variant: string; count: number; capacity: number }> {
        return [...this.batches.values()].map((b) => ({ variant: b.name, count: b.count, capacity: b.capacity }));
    }

    /** Drop every batch. Level switch / engine dispose. */
    dispose(): void {
        for (const batch of this.batches.values()) {
            batch.mesh.removeFromParent();
            batch.mesh.dispose();
        }
        this.batches.clear();
    }

    private createBatch(
        name: string,
        geometry: THREE.BufferGeometry,
        material: THREE.Material,
        parent: THREE.Object3D,
        capacity: number,
    ): VariantBatch {
        const mesh = CrowdRenderer.createMesh(`Crowd_${name}`, geometry, material, capacity);
        const attrs = CrowdRenderer.createInstanceAttributes(geometry, capacity);
        parent.add(mesh);
        return {
            name, mesh, ...attrs,
            members: new Array<CrowdRenderMember | null>(capacity).fill(null),
            slots: new Array<CrowdSlot | null>(capacity).fill(null),
            count: 0, capacity,
        };
    }

    private static createMesh(
        name: string,
        geometry: THREE.BufferGeometry,
        material: THREE.Material,
        capacity: number,
    ): THREE.InstancedMesh {
        const mesh = new THREE.InstancedMesh(geometry, material, capacity);
        mesh.name = name;
        mesh.count = 0;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        // Instances move every frame; a static draw-usage hint makes drivers
        // choose the wrong memory for a buffer rewritten each frame.
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        return mesh;
    }

    /**
     * The per-instance attributes the crowd shaders read: the animation frame
     * row (both backends) and the placement the WebGPU shader uses instead of
     * the instance matrix (see CrowdSkinnedMaterial). When `previous` is given
     * — a batch being grown — each attribute keeps the data written so far.
     */
    private static createInstanceAttributes(
        geometry: THREE.BufferGeometry,
        capacity: number,
        previous?: VariantBatch,
    ): Pick<VariantBatch, 'frameAttr' | 'xfmAttr' | 'yawAttr'> {
        const make = (attributeName: string, itemSize: number, old?: THREE.InstancedBufferAttribute) => {
            const attr = new THREE.InstancedBufferAttribute(new Float32Array(capacity * itemSize), itemSize);
            attr.setUsage(THREE.DynamicDrawUsage);
            if (old && previous) attr.array.set(old.array.subarray(0, previous.capacity * itemSize));
            geometry.setAttribute(attributeName, attr);
            return attr;
        };
        return {
            frameAttr: make(CROWD_INSTANCE_FRAME_ATTRIBUTE, 1, previous?.frameAttr),
            xfmAttr: make(CROWD_INSTANCE_XFM_ATTRIBUTE, 4, previous?.xfmAttr),
            yawAttr: make(CROWD_INSTANCE_YAW_ATTRIBUTE, 1, previous?.yawAttr),
        };
    }

    /**
     * Double a full batch. InstancedMesh capacity is fixed at construction, so
     * this rebuilds the mesh and re-adds it — acceptable because it happens
     * log(n) times over a level's life, not per frame.
     */
    private grow(batch: VariantBatch): void {
        const capacity = batch.capacity * 2;
        const parent = batch.mesh.parent;
        const geometry = batch.mesh.geometry;
        const oldMesh = batch.mesh;

        const mesh = CrowdRenderer.createMesh(oldMesh.name, geometry, oldMesh.material as THREE.Material, capacity);
        mesh.count = batch.count;
        mesh.castShadow = oldMesh.castShadow;
        mesh.receiveShadow = oldMesh.receiveShadow;
        const attrs = CrowdRenderer.createInstanceAttributes(geometry, capacity, batch);

        oldMesh.removeFromParent();
        // Dispose the MESH only: geometry and material are shared per-variant
        // templates, and disposing them here would blank every other batch that
        // references them.
        oldMesh.dispose();
        parent?.add(mesh);

        batch.mesh = mesh;
        batch.frameAttr = attrs.frameAttr;
        batch.xfmAttr = attrs.xfmAttr;
        batch.yawAttr = attrs.yawAttr;
        batch.capacity = capacity;
        batch.members.length = capacity;
        batch.slots.length = capacity;
        batch.members.fill(null, batch.count);
        batch.slots.fill(null, batch.count);
    }
}

/**
 * Module-global renderer, reached the way the crowd registry and the navmesh
 * are (`getGlobalCrowd`, `getGlobalNavMesh`): one crowd draw set per running
 * game. GameEngine ticks its `update()` once per frame after the crowd solver.
 */
let _globalCrowdRenderer: CrowdRenderer | null = null;

export function getGlobalCrowdRenderer(): CrowdRenderer {
    if (!_globalCrowdRenderer) _globalCrowdRenderer = new CrowdRenderer();
    return _globalCrowdRenderer;
}

/** Test seam — drop the global instance so a test starts from an empty renderer. */
export function resetGlobalCrowdRenderer(): void {
    _globalCrowdRenderer?.dispose();
    _globalCrowdRenderer = null;
}
