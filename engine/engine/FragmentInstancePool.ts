import * as THREE from 'three';

/**
 * FragmentInstancePool — shared instanced rendering for the fragments of
 * broken pre-fragmented voxel assets.
 *
 * A pre-fragmented asset (cactus, tower, …) has N fragment geometries baked
 * once at voxelization. While an instance is pristine it renders through the
 * normal environment-object InstancedMesh batch and this pool is not even
 * created. When an instance breaks, its fragments — the still-attached stump
 * pieces AND the detached flying pieces — render as *slots* here: one
 * InstancedMesh per fragment index whose geometry/material are **referenced
 * from the template's fragment meshes, never cloned**. However many instances
 * of a type are broken at once, the draw-call ceiling is the type's fragment
 * count, and the geometry exists exactly once.
 *
 * WebGPU notes (see the InstancedMesh gotchas): instanceMatrix usage is set
 * once at construction, hiding is done by compacting `count` (swap-remove),
 * never by zero-scale matrices.
 *
 * Ownership: the pool owns its InstancedMeshes and their instance attributes;
 * it does NOT own the geometries/materials (the template does). `dispose()`
 * therefore removes and disposes the meshes but leaves geometry alone.
 */

/** Geometry/material source for one fragment index. */
export interface FragmentVisualSource {
    geometry: THREE.BufferGeometry;
    material: THREE.Material | THREE.Material[];
}

const INITIAL_CAPACITY = 8;

/** Scratch matrix for instance-attribute reads/writes (never allocated per call). */
const _tmpMat = new THREE.Matrix4();

/**
 * Handle to one rented slot. Stable across pool growth and other slots'
 * release (the pool rewrites `slot` on swap-remove). `release()` is
 * idempotent.
 */
export class FragmentSlot {
    /** @internal — pool bookkeeping. */
    slot: number;

    constructor(
        private readonly pool: FragmentInstancePool,
        /** @internal */ readonly fragIndex: number,
        slot: number,
    ) {
        this.slot = slot;
    }

    setMatrix(matrix: THREE.Matrix4): void {
        this.pool._writeMatrix(this.fragIndex, this.slot, matrix);
    }

    release(): void {
        if (this.slot < 0) return;
        this.pool._release(this.fragIndex, this.slot);
        this.slot = -1;
    }

    get released(): boolean {
        return this.slot < 0;
    }
}

interface FragmentLane {
    mesh: THREE.InstancedMesh;
    /** Dense: entries[i] owns instance slot i; length === mesh.count. */
    entries: FragmentSlot[];
    capacity: number;
}

export class FragmentInstancePool {
    /** Lazily-created lane per fragment index. */
    private readonly lanes: (FragmentLane | null)[];
    private disposed = false;

    constructor(
        /** Scene parent the lane meshes are added to (the env-object world group). */
        private readonly parent: THREE.Object3D,
        /** Per-fragment geometry/material, referenced from the template. */
        private readonly sources: ReadonlyArray<FragmentVisualSource>,
        /** Name prefix for the lane meshes (debuggability in scene dumps). */
        private readonly namePrefix: string,
        private readonly shadows: boolean = true,
    ) {
        this.lanes = new Array(sources.length).fill(null);
    }

    get fragmentCount(): number {
        return this.sources.length;
    }

    /** Currently-rented slots for `fragIndex` (test/diagnostics). */
    activeCount(fragIndex: number): number {
        return this.lanes[fragIndex]?.mesh.count ?? 0;
    }

    /**
     * Rent a slot for fragment `fragIndex` and write its initial matrix.
     * Returns null after dispose() or for an out-of-range index.
     */
    acquire(fragIndex: number, matrix: THREE.Matrix4): FragmentSlot | null {
        if (this.disposed || fragIndex < 0 || fragIndex >= this.sources.length) return null;
        let lane = this.lanes[fragIndex] ?? this.createLane(fragIndex, INITIAL_CAPACITY);
        if (lane.mesh.count >= lane.capacity) {
            lane = this.growLane(fragIndex, lane);
        }
        const slot = lane.mesh.count;
        lane.mesh.count = slot + 1;
        const handle = new FragmentSlot(this, fragIndex, slot);
        lane.entries[slot] = handle;
        lane.mesh.setMatrixAt(slot, matrix);
        lane.mesh.instanceMatrix.needsUpdate = true;
        return handle;
    }

    /** @internal */
    _writeMatrix(fragIndex: number, slot: number, matrix: THREE.Matrix4): void {
        const lane = this.lanes[fragIndex];
        if (!lane || slot < 0 || slot >= lane.mesh.count) return;
        lane.mesh.setMatrixAt(slot, matrix);
        lane.mesh.instanceMatrix.needsUpdate = true;
    }

    /** @internal — swap-remove compaction; keeps [0, count) dense. */
    _release(fragIndex: number, slot: number): void {
        const lane = this.lanes[fragIndex];
        if (!lane || slot < 0 || slot >= lane.mesh.count) return;
        const last = lane.mesh.count - 1;
        if (slot !== last) {
            // Move the last entry's matrix + handle into the freed slot.
            const moved = lane.entries[last]!;
            _tmpMat.fromArray(lane.mesh.instanceMatrix.array, last * 16);
            lane.mesh.setMatrixAt(slot, _tmpMat);
            lane.entries[slot] = moved;
            moved.slot = slot;
        }
        lane.entries.length = last;
        lane.mesh.count = last;
        lane.mesh.instanceMatrix.needsUpdate = true;
    }

    /** Build a lane mesh, add it to the scene and install it as the current lane. */
    private createLane(fragIndex: number, capacity: number): FragmentLane {
        const src = this.sources[fragIndex]!;
        const mesh = new THREE.InstancedMesh(src.geometry, src.material, capacity);
        mesh.name = `${this.namePrefix}_frag${fragIndex}`;
        mesh.count = 0;
        mesh.castShadow = this.shadows;
        mesh.receiveShadow = true;
        // Slots scatter across the level as pieces fly; per-instance culling
        // isn't worth it at these counts, so skip whole-mesh culling like the
        // env batch meshes do.
        mesh.frustumCulled = false;
        // Set once here — never per frame (WebGPU drops the draw otherwise).
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.parent.add(mesh);
        const lane: FragmentLane = { mesh, entries: [], capacity };
        this.lanes[fragIndex] = lane;
        return lane;
    }

    /** Double capacity: new mesh, copy live matrices, swap in scene. */
    private growLane(fragIndex: number, lane: FragmentLane): FragmentLane {
        // createLane already installed `grown` as the current lane.
        const grown = this.createLane(fragIndex, lane.capacity * 2);
        grown.mesh.count = lane.mesh.count;
        grown.entries = lane.entries;
        for (let i = 0; i < lane.mesh.count; i++) {
            _tmpMat.fromArray(lane.mesh.instanceMatrix.array, i * 16);
            grown.mesh.setMatrixAt(i, _tmpMat);
        }
        grown.mesh.instanceMatrix.needsUpdate = true;
        this.parent.remove(lane.mesh);
        lane.mesh.dispose(); // instance attributes only — geometry is the template's
        return grown;
    }

    /**
     * Tear down every lane mesh. Outstanding FragmentSlot handles become
     * no-ops (level switch disposes pools before/independently of the debris
     * entries that still hold handles).
     */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (let i = 0; i < this.lanes.length; i++) {
            const lane = this.lanes[i];
            if (!lane) continue;
            for (const entry of lane.entries) entry.slot = -1;
            lane.entries.length = 0;
            lane.mesh.count = 0;
            this.parent.remove(lane.mesh);
            lane.mesh.dispose();
            this.lanes[i] = null;
        }
    }
}
