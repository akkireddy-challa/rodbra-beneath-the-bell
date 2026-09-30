import * as THREE from 'three';
import type { VoxelObject } from 'engine/VoxelObject.js';
import type { OctreeLeaf } from 'engine/VoxelOctreeRenderer.js';
import { VoxelCarveSystem, DEFAULT_VOXEL_CARVE_CONFIG } from 'engine/voxelcarve/VoxelCarveSystem.js';

/**
 * The property that matters most here is a REFUSAL: a plain batched
 * environment prop resolves to the shared template that every instance of its
 * type renders from, so carving it would punch the same hole in every copy in
 * the level. Carving is therefore opt-in, and this pins that it stays that way.
 *
 * The other property is batching: one rebuild per object per frame however many
 * rounds land, because a rebuild is O(all leaves in the object).
 */

const MIN = 0.0625;

/** A stand-in exposing only what VoxelCarveSystem actually touches. */
function makeObject(options: {
    carveable?: boolean;
    octree?: boolean;
    leaves?: OctreeLeaf[];
} = {}) {
    const leaves = options.leaves ?? [{ x: 0, y: 0, z: 0, size: 1, r: 1, g: 2, b: 3 }];
    const stub = {
        isOctreeV2: options.octree ?? true,
        isCarveable: () => options.carveable ?? true,
        getMaterializedOctreeLeaves: () => leaves,
        getOctreeLeaves: () => leaves,
        getVoxelSize: () => MIN,
        getPivot: () => new THREE.Vector3(0, 0, 0),
        getWorldPosition: (t: THREE.Vector3) => t.set(0, 0, 0),
        getWorldQuaternion: (q: THREE.Quaternion) => q.identity(),
        setOctreeLeavesForEdit: jest.fn(),
        refreshAfterLeafEdit: jest.fn(),
    };
    return stub as unknown as VoxelObject & typeof stub;
}

describe('what may be carved', () => {
    it('REFUSES an object that has not opted in', () => {
        // The shared-template case. Silently carving this is the worst possible
        // outcome: every instance of the type gets the same hole.
        const system = new VoxelCarveSystem();
        const template = makeObject({ carveable: false });
        expect(system.queueHit(template, new THREE.Vector3(0.5, 0.5, 0.5))).toBe(false);
        system.processPendingCarves();
        expect(template.setOctreeLeavesForEdit).not.toHaveBeenCalled();
    });

    it('refuses non-octree objects', () => {
        const system = new VoxelCarveSystem();
        expect(system.queueHit(makeObject({ octree: false }), new THREE.Vector3())).toBe(false);
    });

    it('refuses null', () => {
        expect(new VoxelCarveSystem().queueHit(null, new THREE.Vector3())).toBe(false);
    });

    it('refuses objects too large to rebuild cheaply', () => {
        // Rebuild cost is O(all leaves), so a landmark keeps decals instead.
        const many: OctreeLeaf[] = [];
        for (let i = 0; i < 12; i++) many.push({ x: i, y: 0, z: 0, size: 1, r: 0, g: 0, b: 0 });
        const system = new VoxelCarveSystem({ ...DEFAULT_VOXEL_CARVE_CONFIG, maxLeavesPerObject: 10 });
        expect(system.queueHit(makeObject({ leaves: many }), new THREE.Vector3(0.5, 0.5, 0.5))).toBe(false);
    });

    it('accepts an object that owns its geometry', () => {
        const system = new VoxelCarveSystem();
        expect(system.queueHit(makeObject(), new THREE.Vector3(0.5, 0.5, 0.5))).toBe(true);
    });
});

describe('promotion on hit', () => {
    it('promotes a batched destructible instance so it can hold a hole', () => {
        // Instances authored destructible sit in the InstancedMesh until
        // something damages them. A bullet is now enough.
        let promoted = false;
        const object = makeObject({ carveable: false });
        (object as unknown as { isCarveable: () => boolean }).isCarveable = () => promoted;
        (object as unknown as { prepareForCarving: () => boolean }).prepareForCarving = () => {
            promoted = true;
            return true;
        };

        const system = new VoxelCarveSystem();
        expect(system.queueHit(object, new THREE.Vector3(0.5, 0.5, 0.5))).toBe(true);
        expect(promoted).toBe(true);
    });

    it('refuses an oversized template BEFORE promoting it — the size rule is checked first', () => {
        // Promotion clones the whole template geometry, inside the collision callback.
        // Checking the leaf budget only afterwards meant a bullet into a 150k-leaf
        // building cloned it (300–1400 ms, +60 MB) and then fell back to a decal anyway.
        const many = Array.from({ length: DEFAULT_VOXEL_CARVE_CONFIG.maxLeavesPerObject + 1 }, () => ({ x: 0, y: 0, z: 0, size: 1, r: 1, g: 2, b: 3 }));
        const object = makeObject({ carveable: false, leaves: many });
        const prepareForCarving = jest.fn(() => true);
        (object as unknown as { prepareForCarving: () => boolean }).prepareForCarving = prepareForCarving;
        const system = new VoxelCarveSystem();
        expect(system.queueHit(object, new THREE.Vector3(0.5, 0.5, 0.5))).toBe(false);
        expect(prepareForCarving).not.toHaveBeenCalled();
    });

    it('configure({ maxLeavesPerObject: 0 }) switches scenery carving off without touching the defaults', () => {
        const object = makeObject({ carveable: false });
        const prepareForCarving = jest.fn(() => true);
        (object as unknown as { prepareForCarving: () => boolean }).prepareForCarving = prepareForCarving;
        const system = new VoxelCarveSystem();
        system.configure({ maxLeavesPerObject: 0 });
        expect(system.queueHit(object, new THREE.Vector3(0.5, 0.5, 0.5))).toBe(false);
        expect(prepareForCarving).not.toHaveBeenCalled();
        expect(DEFAULT_VOXEL_CARVE_CONFIG.maxLeavesPerObject).toBe(60000);
    });

    it('refuses when promotion reports the instance still cannot be carved', () => {
        // Multi-fragment assets render from a shared per-type fragment pool, so
        // promoting them does NOT make their geometry private.
        const object = makeObject({ carveable: false });
        (object as unknown as { prepareForCarving: () => boolean }).prepareForCarving = () => false;
        const system = new VoxelCarveSystem();
        expect(system.queueHit(object, new THREE.Vector3(0.5, 0.5, 0.5))).toBe(false);
    });

    it('does not mistake a non-callable property for a promotion hook', () => {
        // `x?.()` would throw here; the check is an explicit typeof.
        const object = makeObject({ carveable: false });
        (object as unknown as { prepareForCarving: unknown }).prepareForCarving = true;
        const system = new VoxelCarveSystem();
        expect(() => system.queueHit(object, new THREE.Vector3(0.5, 0.5, 0.5))).not.toThrow();
        expect(system.queueHit(object, new THREE.Vector3(0.5, 0.5, 0.5))).toBe(false);
    });
});

describe('batched scenery promotion', () => {
    it('never carves the template a batched instance resolves to', () => {
        // The whole hazard: a plain batched prop's body reports the TYPE
        // TEMPLATE that every copy in the level renders from. If promotion is
        // unavailable, the hit must be refused, not applied to the template.
        const template = makeObject({ carveable: false });
        const system = new VoxelCarveSystem();
        // A body carrying NO instance ref — i.e. one the batch never tagged,
        // so there is no specific copy to promote.
        const accepted = system.queueHit(template, new THREE.Vector3(0.5, 0.5, 0.5), undefined, {
            body: { handle: 1 } as never,
            physicsWorld: { getUserDataFromHandle: () => ({ voxelObject: template }) } as never,
        });
        expect(accepted).toBe(false);
        system.processPendingCarves();
        expect(template.setOctreeLeavesForEdit).not.toHaveBeenCalled();
    });
});

describe('carving', () => {
    it('rebuilds the object once and leaves a hole', () => {
        const system = new VoxelCarveSystem();
        const object = makeObject();
        system.queueHit(object, new THREE.Vector3(0.5, 0.5, 0.5));
        system.processPendingCarves();

        expect(object.setOctreeLeavesForEdit).toHaveBeenCalledTimes(1);
        expect(object.refreshAfterLeafEdit).toHaveBeenCalledTimes(1);
        const carved = (object.setOctreeLeavesForEdit as jest.Mock).mock.calls[0]![0] as OctreeLeaf[];
        // One 1.0 leaf became its subdivided survivors, minus the hole.
        expect(carved.length).toBeGreaterThan(1);
        expect(system.getLastRemoved().length).toBe(1);
    });

    it('batches a burst into ONE rebuild', () => {
        // The whole reason hits are queued: a rebuild is O(all leaves), so six
        // rounds into one wall in one frame must cost one rebuild, not six.
        const system = new VoxelCarveSystem();
        const object = makeObject();
        for (const p of [0.1, 0.3, 0.5, 0.7, 0.9, 0.2]) {
            system.queueHit(object, new THREE.Vector3(p, p, p));
        }
        system.processPendingCarves();

        expect(object.setOctreeLeavesForEdit).toHaveBeenCalledTimes(1);
        expect(object.refreshAfterLeafEdit).toHaveBeenCalledTimes(1);
        expect(system.getLastRemoved().length).toBe(6);
    });

    it('caps how many objects rebuild in one frame', () => {
        const system = new VoxelCarveSystem({ ...DEFAULT_VOXEL_CARVE_CONFIG, maxObjectsPerFrame: 2 });
        const objects = [makeObject(), makeObject(), makeObject(), makeObject()];
        for (const o of objects) system.queueHit(o, new THREE.Vector3(0.5, 0.5, 0.5));
        system.processPendingCarves();

        const rebuilt = objects.filter((o) => (o.setOctreeLeavesForEdit as jest.Mock).mock.calls.length > 0);
        expect(rebuilt.length).toBe(2);
    });

    it('does not rebuild when nothing was actually hit', () => {
        const system = new VoxelCarveSystem();
        const object = makeObject();
        system.queueHit(object, new THREE.Vector3(50, 50, 50)); // miss
        system.processPendingCarves();
        expect(object.setOctreeLeavesForEdit).not.toHaveBeenCalled();
    });

    it('does not rebuild an object carved away to nothing', () => {
        // Removing the last leaf is destruction, not a bullet hole; leave that
        // to the destruction path rather than rebuilding an empty object.
        const system = new VoxelCarveSystem();
        const object = makeObject({ leaves: [{ x: 0, y: 0, z: 0, size: MIN, r: 0, g: 0, b: 0 }] });
        system.queueHit(object, new THREE.Vector3(0.01, 0.01, 0.01));
        system.processPendingCarves();
        expect(object.setOctreeLeavesForEdit).not.toHaveBeenCalled();
    });

    it('reports each carve through the hook', () => {
        const system = new VoxelCarveSystem();
        const seen: number[] = [];
        system.onObjectCarved = (_object, removed) => seen.push(removed.length);
        const object = makeObject();
        system.queueHit(object, new THREE.Vector3(0.5, 0.5, 0.5));
        system.processPendingCarves();
        expect(seen).toEqual([1]);
    });

    it('clears its queue, so a flush with no hits does nothing', () => {
        const system = new VoxelCarveSystem();
        const object = makeObject();
        system.queueHit(object, new THREE.Vector3(0.5, 0.5, 0.5));
        system.processPendingCarves();
        system.processPendingCarves();
        expect(object.setOctreeLeavesForEdit).toHaveBeenCalledTimes(1);
    });
});

describe('object transform', () => {
    it('carves at the right place on a moved and rotated object', () => {
        // The hit arrives in world space; leaves live in bounds space. Get the
        // conversion wrong and holes appear somewhere else on the model.
        const leaves: OctreeLeaf[] = [{ x: 0, y: 0, z: 0, size: 1, r: 0, g: 0, b: 0 }];
        const object = makeObject({ leaves });
        object.getWorldPosition = (t: THREE.Vector3) => t.set(10, 5, -3);
        object.getWorldQuaternion = (q: THREE.Quaternion) =>
            q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
        object.getPivot = () => new THREE.Vector3(0.5, 0.5, 0.5);

        // Bounds-space (0.5,0.5,0.5) is local (0,0,0), which is the object origin.
        const system = new VoxelCarveSystem();
        system.queueHit(object, new THREE.Vector3(10, 5, -3));
        system.processPendingCarves();

        expect(system.getLastRemoved().length).toBe(1);
        const hole = system.getLastRemoved()[0]!;
        // The removed cube must contain bounds-space (0.5, 0.5, 0.5).
        expect(0.5).toBeGreaterThanOrEqual(hole.x);
        expect(0.5).toBeLessThanOrEqual(hole.x + hole.size);
        expect(0.5).toBeGreaterThanOrEqual(hole.y);
        expect(0.5).toBeLessThanOrEqual(hole.y + hole.size);
    });
});
