import RAPIER from '@dimforge/rapier3d-compat';
import { VoxelObject } from 'engine/VoxelObject.js';
import type { ChunkManagedObject } from 'engine/ChunkPhysicsManager.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import { isPlaneLockedPhysics, type PlaneLockedBody } from 'engine/physics/PlaneLockedPhysics.js';
import { CollisionGroup, CollisionMask, makeCollisionGroups } from 'engine/CollisionLayers.js';
import { createOctreeColliders, type OctreeVoxelCells, type PhysicsBox } from 'engine/VoxelOctreeRenderer.js';
import { parseChunkKey, CHUNK_SIZE } from 'engine/VoxelGeometry.js';
import { voxelsDesc, cellsFromIntBoxes, type IntBoxRun } from 'engine/physics/VoxelColliders.js';

/**
 * VoxelObjectColliderOps — how a VoxelObject turns its voxels into Rapier
 * colliders.
 *
 * A FRIEND MODULE, for the same reason VoxelObjectPristineOps is one:
 * VoxelObject.ts sits at the repo's 2000-line ESLint cap, so operations that
 * belong to the class conceptually live here and reach its private state
 * through TypeScript's sanctioned element-access escape hatch (`vox['chunks']`
 * — typed, not `any`). Keep collider (and static-body) CONSTRUCTION here; the
 * public `createPhysicsBody*` entry points stay on the class, because published
 * games call them and their signatures are frozen.
 *
 * Import-cycle note: VoxelObject.ts imports from this module. The cycle is
 * safe because the VoxelObject binding is only used in type position and
 * inside function bodies (call time), never at module evaluation — do NOT add
 * module-level or class-extends usage of VoxelObject here.
 */

/**
 * Which batched environment instance a physics body belongs to.
 *
 * Batched scenery shares ONE VoxelObject — the type's template — across every
 * placed copy, so `fromRigidBody` alone cannot tell them apart, and anything
 * that mutates the resolved object would change every copy in the level at
 * once. This is the missing identity: with it, a hit on one wall can be traced
 * back to that specific instance and promoted out of the batch.
 */
export interface EnvInstanceRef {
    typeName: string;
    index: number;
}

/** The instance a body belongs to, or null for anything not batched. */
export function envInstanceFromRigidBody(
    body: RAPIER.RigidBody, pw: PhysicsWorld,
): EnvInstanceRef | null {
    const userData = pw.getUserDataFromHandle(body.handle) as { envInstance?: EnvInstanceRef } | null;
    return userData?.envInstance ?? null;
}

/**
 * Create a fixed (static) rigid body at a world transform and tag it with its
 * owning VoxelObject, so raycast and projectile hits resolve back through
 * `VoxelObject.fromRigidBody()`. Every static voxel body is built here, which
 * is what keeps that lookup working no matter which entry point placed it
 * (mining, for one, relies on it).
 */
export function createStaticVoxelBody(
    vox: VoxelObject,
    pw: PhysicsWorld,
    translation: { x: number; y: number; z: number },
    rotation: { x: number; y: number; z: number; w: number },
    envInstance?: EnvInstanceRef,
): RAPIER.RigidBody {
    const desc = RAPIER.RigidBodyDesc.fixed()
        .setTranslation(translation.x, translation.y, translation.z)
        .setRotation({ x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w });
    const body = pw.createRigidBody(desc);
    pw.setUserData(body, envInstance ? { voxelObject: vox, envInstance } : { voxelObject: vox });
    return body;
}

/**
 * Drop `vox`'s colliders from the physics world and empty its collider list;
 * the rigid body itself is left in place. Colliders that Rapier has already
 * invalidated (e.g. because their body was removed) are skipped.
 */
export function clearColliders(vox: VoxelObject): void {
    const pw = vox['physicsWorld'];
    if (pw) {
        for (const collider of vox['colliders']) {
            if (collider.isValid()) pw.removeCollider(collider);
        }
    }
    vox['colliders'] = [];
}

/**
 * Collect all greedy-meshed collision boxes from v1 chunks into a unified
 * PhysicsBox array (center + half-extents in local space).
 */
export function collectChunkPhysicsBoxes(
    vox: VoxelObject,
    bOffX: number, bOffY: number, bOffZ: number,
    pivotX: number, pivotY: number, pivotZ: number,
): PhysicsBox[] {
    const voxelSize = vox['voxelSize'];
    const out: PhysicsBox[] = [];
    for (const [key, chunk] of vox['chunks']) {
        if (!chunk.collisionBoxes || chunk.collisionBoxes.length === 0) continue;
        const parsed = parseChunkKey(key);
        if (!parsed) continue;
        // Chunk origin in voxel units; box coords are chunk-local.
        const cvx = parsed.cx * CHUNK_SIZE;
        const cvy = parsed.cy * CHUNK_SIZE;
        const cvz = parsed.cz * CHUNK_SIZE;
        for (const box of chunk.collisionBoxes) {
            out.push({
                cx: bOffX + (cvx + box.x + box.w * 0.5) * voxelSize - pivotX,
                cy: bOffY + (cvy + box.y + box.h * 0.5) * voxelSize - pivotY,
                cz: bOffZ + (cvz + box.z + box.d * 0.5) * voxelSize - pivotZ,
                hx: box.w * voxelSize * 0.5,
                hy: box.h * voxelSize * 0.5,
                hz: box.d * voxelSize * 0.5,
            });
        }
    }
    return out;
}

/**
 * Attach one voxels collider from a cell set, composing the instance's parent
 * scale through voxelSize and origin. Every static voxel-object collider —
 * octree union, v1 chunks, pristine stand-in — is created here, so this is the
 * single definition of the friction / restitution policy they share.
 */
export function attachUnionVoxelCollider(
    vc: OctreeVoxelCells,
    pw: PhysicsWorld,
    body: RAPIER.RigidBody,
    groups: number,
    sx: number = 1, sy: number = 1, sz: number = 1,
): RAPIER.Collider {
    const desc = voxelsDesc(
        vc.cells,
        vc.gs * sx, vc.gs * sy, vc.gs * sz,
        vc.gMinX * sx, vc.gMinY * sy, vc.gMinZ * sz,
    )
        .setCollisionGroups(groups)
        .setFriction(0.5)
        .setRestitution(0.0);
    return pw.createCollider(desc, body);
}

/**
 * The cell set of a v1 (chunked) object's greedy collision boxes, in the same
 * shape the octree path produces so attachUnionVoxelCollider serves both.
 * Cells stay in absolute voxel-grid units on a `voxelSize` lattice; the local
 * placement (bounds offset minus pivot) is the grid origin, so parent scale
 * composes exactly as it does for an octree union. Null when the object has
 * no collision boxes.
 */
export function chunkVoxelCells(
    vox: VoxelObject,
    bOffX: number, bOffY: number, bOffZ: number,
    pivotX: number, pivotY: number, pivotZ: number,
): OctreeVoxelCells | null {
    const voxelSize = vox['voxelSize'];
    const runs: IntBoxRun[] = [];
    for (const [key, chunk] of vox['chunks']) {
        if (!chunk.collisionBoxes || chunk.collisionBoxes.length === 0) continue;
        const parsed = parseChunkKey(key);
        if (!parsed) continue;
        const cvx = parsed.cx * CHUNK_SIZE;
        const cvy = parsed.cy * CHUNK_SIZE;
        const cvz = parsed.cz * CHUNK_SIZE;
        for (const box of chunk.collisionBoxes) {
            runs.push({ x: cvx + box.x, y: cvy + box.y, z: cvz + box.z, w: box.w, h: box.h, d: box.d });
        }
    }
    if (runs.length === 0) return null;
    return {
        cells: cellsFromIntBoxes(runs),
        gs: voxelSize,
        gMinX: bOffX - pivotX, gMinY: bOffY - pivotY, gMinZ: bOffZ - pivotZ,
    };
}

/** One voxels collider straight from a v1 object's chunks, or none when it has no collision boxes. */
export function voxelCellCollidersFromChunks(
    vox: VoxelObject,
    bOffX: number, bOffY: number, bOffZ: number,
    pivotX: number, pivotY: number, pivotZ: number,
    pw: PhysicsWorld,
    body: RAPIER.RigidBody,
    groups: number,
    sx: number = 1, sy: number = 1, sz: number = 1,
): RAPIER.Collider[] {
    const vc = chunkVoxelCells(vox, bOffX, bOffY, bOffZ, pivotX, pivotY, pivotZ);
    return vc ? [attachUnionVoxelCollider(vc, pw, body, groups, sx, sy, sz)] : [];
}

/** Rebuild physics colliders after voxels have been removed. */
export function rebuildPhysicsColliders(vox: VoxelObject): void {
    const rigidBody = vox['rigidBody'];
    const physicsWorld = vox['physicsWorld'];
    if (!rigidBody || !physicsWorld) return;

    clearColliders(vox);

    const { boundsOffsetX, boundsOffsetY, boundsOffsetZ, pivotX, pivotY, pivotZ } = vox['getBoundsAndPivot']();
    const collisionGroups = makeCollisionGroups(CollisionGroup.ENVIRONMENT, CollisionMask.ENVIRONMENT);

    // 2D-physics lane: re-slice the surviving boxes onto the plane (EnvObject2D.ts).
    if (isPlaneLockedPhysics(physicsWorld)) {
        const { pos, quat, scale } = vox['decomposeWorld']();
        vox['colliders'] = physicsWorld.attachEnvironmentColliders(rigidBody as unknown as PlaneLockedBody, {
            boxes: vox.getPhysicsBoxes(), transform: { translation: pos, rotation: quat, scale },
            collisionGroups, friction: 0.7, restitution: vox['_isDynamic'] ? 0.3 : 0,
        }) as unknown as RAPIER.Collider[];
        return;
    }

    // Resident storage only (`octreeLeafSource`, not the `octreeLeaves` getter):
    // reading the getter would expand a still-compact LeafBuffer into one JS
    // object per voxel and pin that expansion for the object's whole life.
    const leafSource = vox['_isOctreeV2'] ? vox['octreeLeafSource'] : null;
    if (leafSource) {
        vox['colliders'] = createOctreeColliders(
            leafSource, pivotX, pivotY, pivotZ, vox['getPhysicsGridStep'](),
            physicsWorld, rigidBody, collisionGroups,
            { dynamic: vox['_isDynamic'] },
        );
        return;
    }

    vox['generateAllCollisionBoxes']();

    if (!vox['_isDynamic']) {
        vox['colliders'] = voxelCellCollidersFromChunks(
            vox, boundsOffsetX, boundsOffsetY, boundsOffsetZ, pivotX, pivotY, pivotZ,
            physicsWorld, rigidBody, collisionGroups,
        );
        return;
    }

    // Dynamic bodies need real cuboids: Rapier derives their mass from collider
    // volume, which neither a voxels shape nor a trimesh carries.
    const allBoxes = collectChunkPhysicsBoxes(vox, boundsOffsetX, boundsOffsetY, boundsOffsetZ, pivotX, pivotY, pivotZ);
    vox['colliders'] = allBoxes.map(box => physicsWorld.createCollider(
        RAPIER.ColliderDesc.cuboid(box.hx, box.hy, box.hz)
            .setTranslation(box.cx, box.cy, box.cz)
            .setCollisionGroups(collisionGroups),
        rigidBody));
}

/**
 * Bookkeeping shared by both physics lanes once a dynamic body and its colliders
 * exist: the collider bottom for the embedded-in-terrain safety net, inspector
 * userData, DynamicObjectManager registration and the optional start-asleep.
 * Lives here (with bracket access to the privates, like the rest of this file)
 * only because VoxelObject.ts is at its size cap.
 */
export function finishDynamicVoxelBody(
    vox: VoxelObject,
    mass: number,
    isSphere: boolean,
    startAsleep: boolean,
    engine: { getDynamicObjectManager?: () => { register(obj: ChunkManagedObject, type: string, radius?: number): void } } | null | undefined,
): void {
    const rigidBody = vox['rigidBody'];
    if (!rigidBody) return;

        // Lowest collider point relative to the body origin (the pivot is an
        // arbitrary authoring point, NOT the physical base) — used by the
        // embedded-in-terrain safety net in syncWithPhysics().
        let bottom = Infinity;
        for (const c of vox['colliders']) {
            const shape = c.shape as { halfExtents?: { y: number }; radius?: number };
            const hy = shape.halfExtents?.y ?? shape.radius ?? 0;
            bottom = Math.min(bottom, c.translation().y - hy - vox.position.y);
        }
        vox['_colliderBottomOffsetY'] = Number.isFinite(bottom) ? bottom : 0;

        // Store collision info in userData for Object Inspector
        vox.userData.collisionGroup = CollisionGroup.DYNAMIC_PROP;
        vox.userData.collisionMask = CollisionMask.DYNAMIC_PROP;
        vox.userData.rigidBody = rigidBody;
        vox.userData.isDynamic = true;
        vox.userData.mass = isSphere ? rigidBody.mass() : mass;

        // Auto-register with DynamicObjectManager for chunk-based hibernation.
        // This ensures the object hibernates when its terrain chunk is disabled
        // and gravity is held if terrain colliders aren't ready yet.
        const dynamicObjMgr = engine?.getDynamicObjectManager?.();
        if (dynamicObjMgr) {
            dynamicObjMgr.register(vox, 'dynamic_prop', 1.0);
        }
        vox['_lastChunkRegPos'].copy(vox.position);

        // Load-time props rest where they were authored: start them asleep so a
        // level full of knockables doesn't pay a settle wave on spawn. Contacts
        // (a vehicle, a push) wake them normally.
        if (startAsleep) {
            rigidBody.sleep();
        }
}
