import * as THREE from 'three';
import type { VoxelObject } from 'engine/VoxelObject.js';
import { LeafCarver, type CarvedCube } from 'engine/voxelcarve/LeafCarver.js';
import { envInstanceFromRigidBody } from 'engine/VoxelObjectColliderOps.js';
import { getFragmentCount } from 'engine/VoxelObjectPristineOps.js';
import { getDecalSystem } from 'engine/VoxelDecalSystem.js';
import { voxelObjectDebris } from 'engine/VoxelObjectDebris.js';
import { debrisRigidBodyDesc } from 'engine/VoxelExplosionHelpers.js';
import { CollisionGroup, CollisionMask, makeCollisionGroups } from 'engine/CollisionLayers.js';
import RAPIER from '@dimforge/rapier3d-compat';
import { getActiveEnvironmentObjectSystem } from 'engine/EnvironmentObjectSystem.js';
import { promoteEnvInstanceForCarving } from 'engine/EnvironmentObjectCarve.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';

/**
 * Bullet holes carved out of voxel objects, instead of decals pasted onto them.
 *
 * A hit is QUEUED, never applied immediately, for two reasons. Physics contact
 * callbacks are not a safe place to rebuild geometry, and — more importantly —
 * one carve costs the struck object a full mesh rebuild plus a full collider
 * rebuild, O(all leaves). An automatic weapon landing six rounds in one wall in
 * one frame must pay that once, not six times. So hits accumulate, group by
 * object, and each object is rebuilt exactly once per frame.
 *
 * The carve itself is pure data (see LeafCarver): subdivide the struck leaf down
 * to hole size and drop the one child that contains the impact.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO:
 *  - Terrain. Forged levels free their decoded voxel columns after load and
 *    their only mutation hook rebuilds every batch in the world; carving them
 *    needs an incremental per-chunk rebuild that does not exist yet. Terrain
 *    hits fall back to decals.
 *
 * WHAT A CARVE LOOKS LIKE: the removed voxel itself DETACHES — a physical cube
 * of the carved cube's own size and colour, launched along the bullet's travel
 * and tumbling away through the shared voxel-debris pool (the same machinery
 * explosions use). No extra particle effects: the flying voxel IS the feedback.
 */

/** Default hole edge length, metres. Floored per-object at its minVoxelSize. */
export const DEFAULT_BULLET_HOLE_SIZE = 0.05;

export interface VoxelCarveConfig {
    /** Hole edge length in metres. Each object floors this at its own minVoxelSize. */
    holeSize: number;
    /**
     * Objects rebuilt per frame at most.
     *
     * A rebuild is O(all leaves in the object), so this is the lever that stops
     * a crowd of shot props from stalling a frame. Hits beyond the budget are
     * dropped rather than deferred: a bullet hole that appears a second late
     * reads worse than one that never appears.
     */
    maxObjectsPerFrame: number;
    /**
     * Largest object that may be carved, in leaves.
     *
     * Rebuild cost scales with the whole object, so a 180k-leaf landmark would
     * cost far more per hole than any hole is worth. Bigger objects keep decals.
     */
    maxLeavesPerObject: number;
}

export const DEFAULT_VOXEL_CARVE_CONFIG: VoxelCarveConfig = {
    holeSize: DEFAULT_BULLET_HOLE_SIZE,
    maxObjectsPerFrame: 4,
    maxLeavesPerObject: 60000,
};

interface PendingHit {
    object: VoxelObject;
    point: THREE.Vector3;
    /** For spawning the detached voxel. Null in physics-less tests. */
    physicsWorld: PhysicsWorld | null;
    /**
     * Direction to march INTO the matter, unit length, or null when the hit
     * carries no usable direction at all.
     *
     * Preferred source is the bullet's TRAVEL direction: the contact normal
     * from a physics manifold is unreliable (Rapier sometimes reports zero) and
     * at grazing angles -normal walks along the surface instead of into it. A
     * bullet's own path always points at the matter it struck.
     */
    inward: THREE.Vector3 | null;
    holeSize: number;
}



const _localPoint = new THREE.Vector3();
const _localNormal = new THREE.Vector3();
const _debrisPos = new THREE.Vector3();
const _worldPos = new THREE.Vector3();
const _worldQuat = new THREE.Quaternion();
const _invQuat = new THREE.Quaternion();

export class VoxelCarveSystem {
    private config: VoxelCarveConfig;
    private pending: PendingHit[] = [];
    /** Cubes removed by the most recent flush, for callers that want debris. */
    private lastRemoved: CarvedCube[] = [];

    /** Fired once per carved object, after its geometry has been rebuilt. */
    onObjectCarved: ((object: VoxelObject, removed: readonly CarvedCube[]) => void) | null = null;

    constructor(config: VoxelCarveConfig = DEFAULT_VOXEL_CARVE_CONFIG) {
        this.config = { ...config };
    }

    /**
     * Change carve limits at runtime — typically from a game's load, on the engine-owned
     * singleton (`getVoxelCarveSystem()`). The knob that matters is `maxLeavesPerObject`:
     * carving a batched prop or building first PROMOTES it, which clones its whole geometry
     * inside the projectile hit callback (30–370 ms measured on forged-city assets, and not
     * predictable from leaf count). A game that would rather keep its frame than punch holes
     * in scenery sets it to 0 — decals still mark every impact and monsters are unaffected.
     */
    configure(overrides: Partial<VoxelCarveConfig>): void {
        Object.assign(this.config, overrides);
    }

    /**
     * Can this object have holes punched in it at all?
     *
     * Only VXL v3 octree objects that own their own geometry qualify. A shared
     * template does not: its geometry backs every instance of that type, so
     * carving it would punch the same hole in all of them.
     */
    canCarve(object: VoxelObject | null): object is VoxelObject {
        if (!object || !object.isOctreeV2) return false;
        // Pre-fragmented objects (wrecks, buildings) hold their geometry in
        // child fragments, and leaf editing on the parent is a NO-OP — an
        // accepted carve would change nothing on screen while still suppressing
        // the decal. Refuse them so they keep decals until per-fragment carving
        // exists.
        if (getFragmentCount(object) > 1) return false;

        // A destructible instance still sitting in the batch has to leave it
        // before it can hold a hole of its own. Promotion is the same step the
        // explosion path already takes, just triggered by a smaller event.
        //
        // Probed with an explicit function check rather than an optional call:
        // `x?.()` only guards null and undefined, so a property that exists and
        // is not callable throws — which is exactly how this went wrong once in
        // the weapon rig.
        if (!object.isCarveable()) {
            const promotable = object as Partial<{ prepareForCarving: () => boolean }>;
            if (typeof promotable.prepareForCarving !== 'function') return false;
            if (!promotable.prepareForCarving()) return false;
        }
        return this.withinLeafBudget(object);
    }

    /** Small enough to rebuild per hit — the one size rule, shared by the pre-promotion gate. */
    private withinLeafBudget(object: VoxelObject): boolean {
        // `carveLeafCount` lets a pristine proxy answer for its template; objects built
        // before it existed (and test doubles) fall back to their own leaves.
        const counter = (object as Partial<{ carveLeafCount: () => number }>).carveLeafCount;
        const count = typeof counter === 'function'
            ? counter.call(object)
            : (object.getMaterializedOctreeLeaves() ?? object.getOctreeLeaves())?.length ?? 0;
        return count > 0 && count <= this.config.maxLeavesPerObject;
    }

    /**
     * Record a hit to be carved at the end of the frame.
     *
     * @returns true if the hit was accepted — the caller should then NOT also
     *          spawn a decal, because a real hole is coming.
     */
    queueHit(
        object: VoxelObject | null,
        worldPoint: THREE.Vector3,
        holeSize?: number,
        hit?: {
            body: RAPIER.RigidBody;
            physicsWorld: PhysicsWorld;
            normal?: THREE.Vector3;
            /** The bullet's flight direction — the preferred march axis. */
            travelDirection?: THREE.Vector3;
        },
    ): boolean {
        // Plain batched scenery resolves to the type TEMPLATE, which is shared
        // by every copy in the level. If the body knows which instance it is,
        // that copy can be lifted out of the batch and given geometry of its
        // own; carving the template itself is never an option.
        let target = object;
        // Size-gate BEFORE promoting. Promotion clones the whole template geometry
        // (and runs inside the collision callback), and canCarve() below rejects an
        // object over `maxLeavesPerObject` anyway — so a bullet into a 150k-leaf
        // building used to clone it (300–1400 ms, +60 MB) only to fall back to a
        // decal. The template has the same leaves the clone would, so ask it first.
        if (target && !target.isCarveable() && !this.withinLeafBudget(target)) return false;
        if (hit && target && !target.isCarveable()) {
            const ref = envInstanceFromRigidBody(hit.body, hit.physicsWorld);
            if (ref) {
                const envSystem = getActiveEnvironmentObjectSystem();
                if (envSystem) {
                    target = promoteEnvInstanceForCarving(envSystem, ref.typeName, ref.index, target) ?? target;
                }
            }
        }

        const target2 = target;
        if (!this.canCarve(target2)) return false;
        object = target2;
        // Travel direction first; fall back to the inverted normal; reject
        // degenerate vectors outright rather than marching nowhere.
        let inward: THREE.Vector3 | null = null;
        const travel = hit?.travelDirection;
        const normal = hit?.normal;
        if (travel && travel.lengthSq() > 1e-8) {
            inward = travel.clone().normalize();
        } else if (normal && normal.lengthSq() > 1e-8) {
            inward = normal.clone().negate().normalize();
        }

        this.pending.push({
            object,
            point: worldPoint.clone(),
            physicsWorld: hit?.physicsWorld ?? null,
            inward,
            holeSize: holeSize ?? this.config.holeSize,
        });
        return true;
    }

    /**
     * Apply every queued hit. Call once per frame, after the physics step —
     * never from inside a collision callback.
     */
    processPendingCarves(): void {
        if (this.pending.length === 0) return;

        // Group by object so each one rebuilds once however many rounds hit it.
        const byObject = new Map<VoxelObject, PendingHit[]>();
        for (const hit of this.pending) {
            const existing = byObject.get(hit.object);
            if (existing) existing.push(hit);
            else byObject.set(hit.object, [hit]);
        }
        this.pending = [];
        this.lastRemoved = [];

        let budget = this.config.maxObjectsPerFrame;
        for (const [object, hits] of byObject) {
            if (budget <= 0) break;
            if (this.carveObject(object, hits)) budget--;
        }
    }

    /** @returns true if the object was actually rebuilt. */
    private carveObject(object: VoxelObject, hits: PendingHit[]): boolean {
        const leaves = object.getMaterializedOctreeLeaves() ?? object.getOctreeLeaves();
        if (!leaves || leaves.length === 0) return false;

        const minVoxelSize = object.getVoxelSize();
        const carver = new LeafCarver(leaves, minVoxelSize);

        // World space to LEAF space. Leaf coordinates are bounds-space: the
        // object-local point plus the pivot, which is exactly the offset the
        // octree mesh is rendered with.
        object.getWorldPosition(_worldPos);
        object.getWorldQuaternion(_worldQuat);
        _invQuat.copy(_worldQuat).invert();
        const pivot = object.getPivot();
        const px = pivot?.x ?? 0;
        const py = pivot?.y ?? 0;
        const pz = pivot?.z ?? 0;

        // A bullet's reported contact sits on the COARSE physics surface —
        // prop colliders are greedy-meshed at physicsGridStep (typically 4x
        // the voxel size), so the contact can be a full grid step outside any
        // real leaf. March inward along the hit normal until actual matter.
        const marchDistance = (object.getPhysicsGridStepValue?.() ?? minVoxelSize * 4)
            + minVoxelSize;

        for (const hit of hits) {
            // Start the march slightly BEHIND the reported contact, along the
            // inward axis: the contact sits on the coarse physics surface,
            // which can be either side of the true voxel surface.
            _localPoint.copy(hit.point);
            if (hit.inward) _localPoint.addScaledVector(hit.inward, -minVoxelSize);
            _localPoint.sub(_worldPos).applyQuaternion(_invQuat);

            let cube: ReturnType<LeafCarver['carve']> = null;
            if (hit.inward) {
                // Rotation-only for the direction: directions ignore translation
                // and pivot, and the object's scale is uniform-in-practice.
                _localNormal.copy(hit.inward).applyQuaternion(_invQuat);
                cube = carver.carveAlong(
                    _localPoint.x + px, _localPoint.y + py, _localPoint.z + pz,
                    _localNormal.x, _localNormal.y, _localNormal.z,
                    hit.holeSize, marchDistance + minVoxelSize * 2,
                );
            } else {
                cube = carver.carve(
                    _localPoint.x + px, _localPoint.y + py, _localPoint.z + pz, hit.holeSize,
                );
            }
            if (cube) {
                this.detachCarvedVoxel(object, cube, hit, px, py, pz);
            } else if (hit.inward) {
                // A carve that removed nothing must not remove the FEEDBACK
                // too: queueing suppressed the decal on the promise of a hole,
                // so a graze or an interior miss falls back to the decal now.
                _localNormal.copy(hit.inward).negate();
                getDecalSystem()?.spawnFromHit(hit.point, _localNormal);
            }
        }

        if (!carver.hasChanges()) return false;

        const outcome = carver.result();
        if (outcome.leaves.length === 0) {
            // Carved away entirely — leave that to the destruction path rather
            // than rebuilding an empty object here.
            return false;
        }

        // Mesh first, then physics ONCE. The split exists for exactly this: a
        // batch of holes should cost one collider rebuild, not one per hole.
        object.setOctreeLeavesForEdit(outcome.leaves);
        object.refreshAfterLeafEdit();

        this.lastRemoved.push(...outcome.removed);
        this.onObjectCarved?.(object, outcome.removed);
        return true;
    }

    /**
     * Send the carved voxel flying: a physical cube of the removed cube's own
     * size and colour, launched along the bullet's travel direction.
     *
     * This IS the feedback for a hit — mirrors explodeAtOctreeV2's per-leaf
     * debris (same body recipe, same pooled instanced rendering, same TTL
     * reaper), so a bullet knocking one voxel out reads exactly like a small
     * piece of the explosion it is.
     */
    private detachCarvedVoxel(
        object: VoxelObject,
        cube: CarvedCube,
        hit: PendingHit,
        pivotX: number, pivotY: number, pivotZ: number,
    ): void {
        const physicsWorld = hit.physicsWorld;
        const parent = object.parent;
        if (!physicsWorld || !parent) return;

        // Cube centre, leaf space -> world (same transform the mesh renders with).
        _debrisPos.set(
            cube.x + cube.size * 0.5 - pivotX,
            cube.y + cube.size * 0.5 - pivotY,
            cube.z + cube.size * 0.5 - pivotZ,
        ).applyQuaternion(_worldQuat).add(_worldPos);

        // Launched mostly along the shot, with a touch of lift and scatter so a
        // burst reads as matter breaking loose rather than cubes on rails.
        const impulse = {
            x: (hit.inward?.x ?? 0) * 2.5 + (Math.random() - 0.5) * 0.8,
            y: (hit.inward?.y ?? 0) * 2.5 + 1.4 + Math.random() * 0.6,
            z: (hit.inward?.z ?? 0) * 2.5 + (Math.random() - 0.5) * 0.8,
        };

        const body = physicsWorld.createRigidBody(
            debrisRigidBodyDesc(_debrisPos.x, _debrisPos.y, _debrisPos.z, impulse));
        const half = cube.size / 2;
        const colliderDesc = RAPIER.ColliderDesc.cuboid(half, half, half)
            .setCollisionGroups(makeCollisionGroups(CollisionGroup.DEBRIS, CollisionMask.DEBRIS))
            .setFriction(0.5).setRestitution(0.6).setDensity(2000);
        const collider = physicsWorld.createCollider(colliderDesc, body);
        physicsWorld.setUserData(body, {
            createdAt: performance.now(),
            isVoxelDebris: true,
            density: 2000,
            debrisSize: cube.size,
            color: { r: cube.r, g: cube.g, b: cube.b },
        });

        voxelObjectDebris.spawnVoxel(
            body, collider, physicsWorld, cube.r, cube.g, cube.b, cube.size, parent);
    }

    /** Cubes removed by the last flush. */
    getLastRemoved(): readonly CarvedCube[] {
        return this.lastRemoved;
    }

    dispose(): void {
        this.pending = [];
        this.lastRemoved = [];
        this.onObjectCarved = null;
    }
}

let globalCarveSystem: VoxelCarveSystem | null = null;

export function initVoxelCarveSystem(config?: VoxelCarveConfig): VoxelCarveSystem {
    globalCarveSystem?.dispose();
    globalCarveSystem = new VoxelCarveSystem(config);
    return globalCarveSystem;
}

export function getVoxelCarveSystem(): VoxelCarveSystem | null {
    return globalCarveSystem;
}
