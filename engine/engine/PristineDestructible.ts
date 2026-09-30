import * as THREE from 'three';
import { VoxelObject, type VoxelObjectDebris, type VoxelDestructionMode } from 'engine/VoxelObject.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import type { VoxelWorld } from 'engine/VoxelWorld.js';
import type { FragmentSlot, FragmentInstancePool } from 'engine/FragmentInstancePool.js';
import { isBuildingSized } from 'engine/EnvLodPolicy.js';
import { envObjectCollides } from 'engine/template/EnvObjectCollision.js';
import { enableStructuralCollapse } from 'engine/VoxelStructuralCollapse.js';
import {
    adoptPristineTemplate,
    getFragmentCount,
    getFragmentVisualSources,
    initPristineUnionBody,
    materializePromotedFragments,
    templateBlastWouldAffect,
} from 'engine/VoxelObjectPristineOps.js';

/**
 * PristineDestructibleVoxelObject — a destructible env-object instance that
 * costs the same as a plain batched prop until the moment it breaks.
 *
 * While pristine:
 *   - Rendering: the environment InstancedMesh batch (LODs, culling, shadow
 *     mesh) — this object carries NO mesh, NO fragments, NO geometry.
 *   - Physics: one static union trimesh (template-cached greedy boxes).
 *   - Game code: `VoxelObject.fromRigidBody()` resolves collisions to this
 *     object; `name`, `getPosition()`, `isDestroyed()`, `explodeAt()` all
 *     behave normally, so existing destruction code works unchanged.
 *
 * On the first explodeAt() that would actually hit a fragment, the instance
 * is PROMOTED: the batch stops drawing it (hideBatchInstance) and live
 * fragment children take over. For pre-fragmented assets the children render
 * through shared per-fragment InstancedMesh pools (FragmentInstancePool) —
 * geometry stays one-per-type no matter how many instances break. For
 * single-fragment assets promotion falls back to a full per-instance clone
 * (the leaf-mutation explosion path needs private geometry), which is the
 * pre-batching behaviour paid only by instances that actually break.
 */

export interface PristineDestructibleHooks {
    /**
     * Remove this instance from the batched InstancedMesh rendering.
     * Called exactly once, at promotion.
     */
    hideBatchInstance: () => void;
    /**
     * Rent a slot in the type's fragment pool (created lazily on first use).
     * Return null when pooled rendering is unavailable.
     */
    acquireFragmentSlot: (fragIndex: number, matrix: THREE.Matrix4) => FragmentSlot | null;
}

export class PristineDestructibleVoxelObject extends VoxelObject {
    private promoted = false;

    constructor(
        private readonly template: VoxelObject,
        private readonly hooks: PristineDestructibleHooks,
        options: { voxelSize: number; useAtlas: boolean; shadows: boolean },
    ) {
        super(options);
        adoptPristineTemplate(this, template);
    }

    /** Create the pristine static body (one union trimesh). Call after the transform is set. */
    initPristinePhysics(physicsWorld: PhysicsWorld): void {
        initPristineUnionBody(this, physicsWorld, this.template);
    }

    /** True once this instance has left the batch and carries live fragments. */
    isPromoted(): boolean {
        return this.promoted;
    }

    /**
     * Leave the batch so this instance can take bullet holes.
     *
     * Promotion already happens on the first explosion; this is the same step
     * triggered by a much smaller event. It is what lets a rifle round mark a
     * crate that has not been blown up, instead of the crate staying pristine
     * until something explodes near it.
     *
     * @returns whether the instance can actually be carved afterwards. False
     *          for multi-fragment assets: those render from the shared per-type
     *          fragment pool, so mutating their geometry would affect every
     *          promoted instance of the type.
     */
    prepareForCarving(): boolean {
        if (this.isDestroyed()) return false;
        this.ensurePromoted();
        return this.isCarveable();
    }

    /**
     * Swap this instance out of the batch and into live fragment objects.
     * Idempotent.
     */
    private ensurePromoted(): void {
        if (this.promoted || this.isDestroyed()) return;
        this.promoted = true;
        this.hooks.hideBatchInstance();
        // Pooled fragment rendering needs the template's built fragment
        // meshes; when they're unavailable (or the asset isn't fragmented),
        // fall back to the full clone so the broken object is still visible.
        if (getFragmentCount(this.template) > 1 && getFragmentVisualSources(this.template) !== null) {
            materializePromotedFragments(this, this.template, this.hooks.acquireFragmentSlot);
        } else {
            this.template.cloneDataTo(this);
            // The clone is this instance's alone, so bullet holes are safe from
            // here on. Not set in the fragment branch: those render from the
            // shared per-type fragment pool, which every promoted instance of
            // the type draws from — see task "pre-fragmented objects".
            this.setCarveable(true);
        }
    }

    override explodeAt(
        worldCenter: THREE.Vector3,
        radius: number,
        impulseStrength: number = 5,
        impulseUp: number = 2,
        parentGroup?: THREE.Object3D,
        voxelWorld?: VoxelWorld,
        mergeBlockType?: number,
    ): VoxelObjectDebris[] {
        // Without a physics world there is nothing to break INTO — do not
        // promote (that would blank the batch visual with no replacement).
        if (!this.getPhysicsWorld()) return [];
        // Cheap reject while pristine: a blast that cannot touch any fragment
        // must not promote — near misses and weak contacts stay free.
        if (!this.promoted && !templateBlastWouldAffect(this, this.template, worldCenter, radius)) {
            return [];
        }
        this.ensurePromoted();
        return super.explodeAt(worldCenter, radius, impulseStrength, impulseUp, parentGroup, voxelWorld, mergeBlockType);
    }
}

/** Per-instance placement data as stored by the env-object batch build. */
export interface PristineDestructibleInstance {
    x: number; y: number; z: number;
    rotation?: number;
    rotationXYZ?: { x: number; y: number; z: number };
    scale?: { width: number; height: number; depth: number };
    objDef?: {
        id?: string; name?: string; obstacle?: boolean; collision?: boolean;
        destructionMode?: string;
        [key: string]: unknown;
    };
}

/**
 * How a placed destructible comes apart, resolved from (in priority order)
 * the instance's explicit world.json `destructionMode`, then its physical
 * size: small props `'shatter'` whole, buildings/landmarks break `'partial'`.
 *
 * The size split reuses the LOD policy's building threshold (`isBuildingSized`,
 * 12 m largest dimension) — the same line the engine already draws between
 * "prop" and "building" everywhere else, so one asset is never a prop for LOD
 * purposes and a building for destruction.
 *
 * An unrecognised authored value falls back to the size default rather than
 * failing the placement — a typo must never cost you a destructible object.
 */
export function resolveDestructionMode(
    objDef: { destructionMode?: string } | null | undefined,
    boundingBox: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } | null | undefined,
    scale?: { width: number; height: number; depth: number },
): VoxelDestructionMode {
    const authored = objDef?.destructionMode;
    if (authored === 'shatter' || authored === 'partial') return authored;
    if (authored !== undefined) {
        console.warn(`[PristineDestructible] Unknown destructionMode "${authored}" — using the size-based default ('shatter' for props, 'partial' for buildings).`);
    }
    if (!boundingBox) return 'shatter';
    const maxDim = Math.max(
        (boundingBox.maxX - boundingBox.minX) * (scale?.width ?? 1),
        (boundingBox.maxY - boundingBox.minY) * (scale?.height ?? 1),
        (boundingBox.maxZ - boundingBox.minZ) * (scale?.depth ?? 1),
    );
    return isBuildingSized(maxDim) ? 'partial' : 'shatter';
}

/**
 * Build the companion proxy for one destructible-only batched instance:
 * transform, name, pristine union body, structural-collapse wiring and a
 * live-tracked navmesh obstacle (auto-dropped when the object is destroyed —
 * unlike the fixed provider plain batched instances get). The caller adds
 * the returned proxy to its registries; rendering stays on the batch until
 * the proxy promotes itself.
 */
export function spawnPristineDestructibleProxy(opts: {
    typeName: string;
    instance: PristineDestructibleInstance;
    template: VoxelObject;
    assetDefinition: { collision?: boolean } | null | undefined;
    /** Scene group the proxy (and later its fragments) live under. */
    world: THREE.Object3D;
    physicsWorld: PhysicsWorld | null;
    /** How the object comes apart — see `resolveDestructionMode`. */
    destructionMode: VoxelDestructionMode;
    /** The type's batch culling spheres; slot nulled on promotion. */
    spheres: (THREE.Sphere | null)[] | null;
    instanceIndex: number;
    /** Lazy per-type fragment pool (null → clone fallback on promotion). */
    getPool: () => FragmentInstancePool | null;
}): PristineDestructibleVoxelObject {
    const { typeName, instance, template, assetDefinition, world, physicsWorld, destructionMode, spheres, instanceIndex, getPool } = opts;
    const objDef = instance.objDef ?? {};
    const proxy = new PristineDestructibleVoxelObject(
        template,
        {
            hideBatchInstance: () => {
                // updateInstanceCulling skips null spheres, so every LOD and
                // the shadow-only mesh stop drawing this slot on the next
                // culling pass.
                if (spheres) spheres[instanceIndex] = null;
            },
            acquireFragmentSlot: (fragIndex, matrix) => getPool()?.acquire(fragIndex, matrix) ?? null,
        },
        // Private template state is only reached inside the friend module
        // (VoxelObjectPristineOps); everything here goes through public API.
        { voxelSize: template.getVoxelSize(), useAtlas: true, shadows: true },
    );
    proxy.position.set(instance.x, instance.y, instance.z);
    if (instance.rotationXYZ) {
        proxy.rotation.set(instance.rotationXYZ.x, instance.rotationXYZ.y, instance.rotationXYZ.z);
    } else if (instance.rotation !== undefined) {
        proxy.rotation.y = instance.rotation;
    }
    if (instance.scale) {
        proxy.scale.set(instance.scale.width, instance.scale.height, instance.scale.depth);
    }
    proxy.name = objDef.name || typeName;
    proxy.setDestructionMode(destructionMode);
    world.add(proxy);

    const collides = envObjectCollides(objDef, assetDefinition);
    if (physicsWorld && collides) {
        proxy.initPristinePhysics(physicsWorld);
        // Leaf-level structural collapse for single-fragment assets once
        // promoted; fragmented assets collapse at fragment level inside
        // detachAffectedFragments.
        enableStructuralCollapse(proxy, physicsWorld, world);
    }

    // Live-tracked navmesh obstacle bounds from the template's rendered
    // geometry (metadata bounds are unreliable — see createInteractableObjects).
    const templateMesh = template.getMesh();
    if (objDef.obstacle !== false && collides && templateMesh?.geometry) {
        if (!templateMesh.geometry.boundingBox) templateMesh.geometry.computeBoundingBox();
        const gb = templateMesh.geometry.boundingBox;
        if (gb) {
            const sx = instance.scale?.width ?? 1;
            const sz = instance.scale?.depth ?? 1;
            const halfW = ((gb.max.x - gb.min.x) / 2) * sx;
            const halfD = ((gb.max.z - gb.min.z) / 2) * sz;
            const offsetX = ((gb.min.x + gb.max.x) / 2 + templateMesh.position.x) * sx;
            const offsetZ = ((gb.min.z + gb.max.z) / 2 + templateMesh.position.z) * sz;
            if (halfW > 0 && halfD > 0) {
                proxy.setNavmeshObstacleEnabled(true, halfW, halfD, offsetX, offsetZ);
            }
        }
    }
    return proxy;
}
