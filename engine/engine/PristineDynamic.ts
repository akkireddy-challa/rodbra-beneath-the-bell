import * as THREE from 'three';
import { VoxelObject, type VoxelObjectDebris } from 'engine/VoxelObject.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import type { VoxelWorld } from 'engine/VoxelWorld.js';
import { envObjectCollides } from 'engine/template/EnvObjectCollision.js';
import { adoptPristineTemplate, initPristineDynamicBody, attachPromotedDynamicColliders } from 'engine/VoxelObjectPristineOps.js';

/**
 * PristineDynamicVoxelObject — a `dynamic: true` env-object instance that costs
 * the same as a plain batched prop until something actually moves it.
 *
 * This is the `dynamic` counterpart of PristineDestructibleVoxelObject, and it
 * exists for the same reason: an instance needing its own PHYSICS body does not
 * need its own RENDER node. Before this, `dynamic` forced the instance out of
 * the per-type InstancedMesh batch, which is the only thing that applies LOD and
 * distance culling — so a hundred parked wrecks each drew their full LOD-0
 * geometry from anywhere on the map, and the LOD distances baked into their
 * asset were never read.
 *
 * While pristine:
 *   - Rendering: the environment InstancedMesh batch (LODs, culling, shadow
 *     mesh) — this object carries NO mesh, NO chunks, NO geometry.
 *   - Physics: one sleeping dynamic body over the template's cached union boxes.
 *   - Game code: `VoxelObject.fromRigidBody()` resolves contacts to this object,
 *     and `name` / `getPosition()` behave normally.
 *
 * A sleeping body is never visited by `World.forEachActiveRigidBody`, so a
 * resting prop costs literally nothing per step. The frame Rapier wakes it —
 * a push, a vehicle, an explosion — the owner calls `promote()`: the batch stops
 * drawing this slot and a live clone takes over, syncing to the body from then
 * on. Promotion is one-way; a prop that has been moved stays individual.
 */

export interface PristineDynamicHooks {
    /**
     * Remove this instance from the batched InstancedMesh rendering.
     * Called exactly once, at promotion.
     */
    hideBatchInstance: () => void;
    /**
     * Wire the now-moving object into the per-step physics→visual sync and the
     * chunk manager. Called exactly once, at promotion, AFTER the clone exists.
     */
    onPromoted: (obj: PristineDynamicVoxelObject) => void;
}

export class PristineDynamicVoxelObject extends VoxelObject {
    private promoted = false;
    /** Retained so promotion can rebuild colliders without re-plumbing them in. */
    private physicsWorldRef: PhysicsWorld | null = null;
    private mass = 0;
    /** Artifact wakes settled so far (diagnostics). */
    private spuriousWakes = 0;
    /** Where the prop was placed — a wake that leaves it within `maxDrift` of here is an artifact. */
    private restPosition = { x: 0, y: 0, z: 0 };

    constructor(
        private readonly template: VoxelObject,
        private readonly hooks: PristineDynamicHooks,
        options: { voxelSize: number; useAtlas: boolean; shadows: boolean },
    ) {
        super(options);
        adoptPristineTemplate(this, template);
    }

    /** Create the sleeping dynamic body. Call after the transform is set. */
    initPristinePhysics(physicsWorld: PhysicsWorld, mass: number): void {
        this.physicsWorldRef = physicsWorld;
        this.mass = mass;
        initPristineDynamicBody(this, physicsWorld, this.template, mass);
        this.restPosition = { x: this.position.x, y: this.position.y, z: this.position.z };
    }

    /** True once this instance has left the batch and carries live geometry. */
    isPromoted(): boolean {
        return this.promoted;
    }

    /** While pristine this object holds no leaves; the hole would be carved into the template's. */
    override carveLeafCount(): number {
        return this.promoted ? super.carveLeafCount() : this.template.carveLeafCount();
    }

    /**
     * The wake sweep saw this body awake. Decide whether it should promote. A wake that
     * is a penetration artifact — the prop sits inside the voxel-rounded surface, or a
     * lazily-enabled static collider appeared over it — is settled and slept in place
     * (see VoxelObject.settleSpuriousWake), and the prop stays batched and free. Only a
     * genuine event — pushed fast, displaced from where it was placed, or left hanging
     * over a drop — leaves the batch.
     */
    shouldPromoteOnWake(): boolean {
        if (!this.physicsWorldRef) return true;
        if (this.settleSpuriousWake(this.physicsWorldRef, this.restPosition) === 'moving') return true;
        this.spuriousWakes++;
        return false;
    }

    /**
     * Leave the batch so this instance can take bullet holes.
     *
     * A dynamic prop already promotes on the first push, blast or vehicle
     * shove; a bullet is simply another reason. Without this, shooting a
     * dynamic object does nothing visible until something else disturbs it.
     */
    prepareForCarving(): boolean {
        if (this.isDestroyed()) return false;
        this.promote();
        return this.isCarveable();
    }

    /**
     * Swap this instance out of the batch and into a live clone that follows its
     * body. Idempotent — the wake sweep may see the same body on several
     * consecutive steps before it settles again.
     */
    promote(): void {
        if (this.promoted) return;
        this.promoted = true;
        this.hooks.hideBatchInstance();
        // KEEP the dynamic body. cloneDataTo otherwise rebuilds a STATIC body for
        // the copied geometry, and this prop would leave the batch fixed in place
        // — a ball that can never be kicked or rolled again, frozen wherever the
        // push that woke it happened to leave it. The exact colliders are attached
        // to the surviving body below.
        this.template.cloneDataTo(this, { keepPhysicsBody: true });
        // The clone is this instance's alone, so per-hit geometry mutation
        // (bullet holes) is safe from here on.
        this.setCarveable(true);
        // Swap the coarse pristine box for the exact cuboid set. Something is
        // pushing this prop now, so its shape has to be right — and this runs in
        // the same step as the contact that woke it, before the difference can
        // be observed.
        if (this.physicsWorldRef) {
            attachPromotedDynamicColliders(this, this.physicsWorldRef, this.template, this.mass);
        }
        this.hooks.onPromoted(this);
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
        // A blast normally wakes the body and the sweep promotes us a step later,
        // but game code can call explodeAt() directly. While pristine this object
        // holds no leaves, so the blast would silently do nothing — promote first
        // so a dynamic prop still comes apart on demand, exactly as it did when
        // every dynamic instance was an individual object.
        this.promote();
        return super.explodeAt(worldCenter, radius, impulseStrength, impulseUp, parentGroup, voxelWorld, mergeBlockType);
    }
}

/** Per-instance placement data as stored by the env-object batch build. */
export interface PristineDynamicInstance {
    x: number; y: number; z: number;
    rotation?: number;
    rotationXYZ?: { x: number; y: number; z: number };
    scale?: { width: number; height: number; depth: number };
    objDef?: {
        id?: string; name?: string; obstacle?: boolean; collision?: boolean;
        mass?: number;
        [key: string]: unknown;
    };
}

/**
 * Resting mass for a placed dynamic prop. An AUTHORED per-instance mass wins
 * (the level designer knows a traffic cone is ~4 kg); otherwise estimate from
 * the asset's bounds volume at loose-prop density (~120 kg/m3), so a car-sized
 * wreck lands near a tonne and a crate near 20 kg. Both paths are clamped so
 * extreme values can't destabilize the solver. Kept identical to the
 * pre-batching individual path so re-routing an instance never changes how it
 * behaves once pushed.
 */
export function resolveDynamicPropMass(
    objDef: { mass?: number } | null | undefined,
    boundingBox: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } | null | undefined,
    scale?: { width: number; height: number; depth: number },
): number {
    const authored = objDef?.mass;
    if (typeof authored === 'number' && Number.isFinite(authored) && authored > 0) {
        return Math.min(3000, Math.max(0.1, authored));
    }
    const volume = boundingBox
        ? Math.max(0.01,
            (boundingBox.maxX - boundingBox.minX) * (scale?.width ?? 1)
            * (boundingBox.maxY - boundingBox.minY) * (scale?.height ?? 1)
            * (boundingBox.maxZ - boundingBox.minZ) * (scale?.depth ?? 1))
        : 0;
    return volume > 0 ? Math.min(3000, Math.max(5, volume * 120)) : 10;
}

/**
 * Build the companion proxy for one dynamic batched instance: transform, name,
 * sleeping dynamic body and a live-tracked navmesh obstacle (it follows the
 * body, so a wreck shoved aside stops blocking where it used to stand). The
 * caller adds the returned proxy to its registries; rendering stays on the
 * batch until the proxy promotes itself.
 */
export function spawnPristineDynamicProxy(opts: {
    typeName: string;
    instance: PristineDynamicInstance;
    template: VoxelObject;
    assetDefinition: { collision?: boolean; boundingBox?: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } } | null | undefined;
    /** Scene group the proxy (and later its clone) lives under. */
    world: THREE.Object3D;
    physicsWorld: PhysicsWorld | null;
    /** The type's batch culling spheres; slot nulled on promotion. */
    spheres: (THREE.Sphere | null)[] | null;
    instanceIndex: number;
    /** Wire the promoted object into per-step sync + the chunk manager. */
    onPromoted: (obj: PristineDynamicVoxelObject) => void;
}): PristineDynamicVoxelObject {
    const { typeName, instance, template, assetDefinition, world, physicsWorld, spheres, instanceIndex, onPromoted } = opts;
    const objDef = instance.objDef ?? {};
    const proxy = new PristineDynamicVoxelObject(
        template,
        {
            hideBatchInstance: () => {
                // updateInstanceCulling skips null spheres, so every LOD and
                // the shadow-only mesh stop drawing this slot on the next
                // culling pass.
                if (spheres) spheres[instanceIndex] = null;
            },
            onPromoted,
        },
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
    world.add(proxy);

    const collides = envObjectCollides(objDef, assetDefinition);
    if (physicsWorld && collides) {
        proxy.initPristinePhysics(physicsWorld, resolveDynamicPropMass(objDef, assetDefinition?.boundingBox, instance.scale));
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
