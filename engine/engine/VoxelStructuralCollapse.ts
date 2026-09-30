import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { VoxelObject } from 'engine/VoxelObject.js';
import type { OctreeLeaf } from 'engine/VoxelOctreeRenderer.js';
import type { PhysicsWorld, ContactInfo } from 'engine/physics/PhysicsWorld.js';

/**
 * VoxelStructuralCollapse — detects and handles structural disconnection in voxel objects.
 *
 * After voxels are destroyed, flood-fills from the bottom layer to find connected voxels.
 * Any disconnected cluster becomes a clone of the original that falls as a solid piece
 * and shatters into debris on first ground impact (no explosion graphics).
 */

/**
 * Enable structural collapse on a VoxelObject.
 * Sets the post-explosion callback to check connectivity after each explosion.
 */
export function enableStructuralCollapse(
    obj: VoxelObject,
    physicsWorld: PhysicsWorld,
    parentGroup: THREE.Object3D
): void {
    obj.setOnPostExplosion((target) => {
        checkAndCollapseDisconnected(target, physicsWorld, parentGroup);
    });
}

function checkAndCollapseDisconnected(
    obj: VoxelObject,
    physicsWorld: PhysicsWorld,
    parentGroup: THREE.Object3D
): void {
    if (obj.isDestroyed()) return;

    if (obj.isOctreeV2) {
        checkOctreeV2Connectivity(obj, physicsWorld, parentGroup);
    } else {
        checkChunkConnectivity(obj, physicsWorld, parentGroup);
    }
}

// ─── Octree V2 path ────────────────────────────────────────────────────────────

function checkOctreeV2Connectivity(
    obj: VoxelObject,
    physicsWorld: PhysicsWorld,
    parentGroup: THREE.Object3D
): void {
    const leaves = obj.getOctreeLeaves();
    if (!leaves || leaves.length === 0) return;

    // Find the minimum Y (bottom layer)
    let minY = Infinity;
    for (const leaf of leaves) {
        if (leaf.y < minY) minY = leaf.y;
    }

    // Ground leaves: any leaf whose bottom face is at minY
    const groundIndices: number[] = [];
    for (let i = 0; i < leaves.length; i++) {
        if (leaves[i]!.y <= minY) {
            groundIndices.push(i);
        }
    }

    if (groundIndices.length === 0) return;

    // Flood-fill from ground leaves through spatial adjacency
    const connected = new Set<number>();
    const queue = [...groundIndices];
    for (const idx of queue) connected.add(idx);

    while (queue.length > 0) {
        const current = queue.pop()!;
        const leaf = leaves[current]!;

        for (let i = 0; i < leaves.length; i++) {
            if (connected.has(i)) continue;
            if (areLeavesAdjacent(leaf, leaves[i]!)) {
                connected.add(i);
                queue.push(i);
            }
        }
    }

    // Check if anything is disconnected
    if (connected.size === leaves.length) return;

    // Build index sets for connected (bottom) and disconnected (top)
    const disconnected = new Set<number>();
    for (let i = 0; i < leaves.length; i++) {
        if (!connected.has(i)) {
            disconnected.add(i);
        }
    }

    // 1) Clone the FULL object (before any removal) to become the falling top part
    const voxelSize = obj.getVoxelSize();
    const fragment = new VoxelObject({ voxelSize, shadows: true });
    obj.cloneDataTo(fragment);

    // 2) Remove connected (bottom) leaves from the clone → clone = top part only
    fragment.removeOctreeLeavesByIndex(connected);

    // 3) Remove disconnected (top) leaves from the original → original = bottom stump
    obj.removeOctreeLeavesByIndex(disconnected);

    // 4) Position the clone at the exact same world transform — no visual change
    const worldPos = new THREE.Vector3();
    obj.getWorldPosition(worldPos);
    const worldQuat = new THREE.Quaternion();
    obj.getWorldQuaternion(worldQuat);

    fragment.position.copy(worldPos);
    fragment.quaternion.copy(worldQuat);
    parentGroup.add(fragment);

    // 5) Start falling — NO physics body yet, gravity is applied manually
    startFallingFragment(fragment, physicsWorld, parentGroup);
}

/** Check if two octree leaves are spatially adjacent (faces touching) */
function areLeavesAdjacent(a: OctreeLeaf, b: OctreeLeaf): boolean {
    const aMinX = a.x, aMaxX = a.x + a.size;
    const aMinY = a.y, aMaxY = a.y + a.size;
    const aMinZ = a.z, aMaxZ = a.z + a.size;
    const bMinX = b.x, bMaxX = b.x + b.size;
    const bMinY = b.y, bMaxY = b.y + b.size;
    const bMinZ = b.z, bMaxZ = b.z + b.size;

    const eps = 0.001;

    const overlapX = aMinX < bMaxX - eps && bMinX < aMaxX - eps;
    const overlapY = aMinY < bMaxY - eps && bMinY < aMaxY - eps;
    const overlapZ = aMinZ < bMaxZ - eps && bMinZ < aMaxZ - eps;

    const touchX = Math.abs(aMaxX - bMinX) < eps || Math.abs(bMaxX - aMinX) < eps;
    const touchY = Math.abs(aMaxY - bMinY) < eps || Math.abs(bMaxY - aMinY) < eps;
    const touchZ = Math.abs(aMaxZ - bMinZ) < eps || Math.abs(bMaxZ - aMinZ) < eps;

    if (touchX && overlapY && overlapZ) return true;
    if (touchY && overlapX && overlapZ) return true;
    if (touchZ && overlapX && overlapY) return true;

    return false;
}

// ─── Shared falling-fragment logic ─────────────────────────────────────────────

/** How far (meters) the fragment must fall before we create a physics body. */
const MIN_FALL_CLEARANCE = 1.0;
const GRAVITY = 9.81;

/**
 * Make a fragment fall WITHOUT physics initially (pure position update).
 * After it has fallen MIN_FALL_CLEARANCE meters, create a dynamic physics body
 * with the accumulated velocity so it interacts with the world normally.
 * First real collision after that → shatter into debris.
 */
function startFallingFragment(
    fragment: VoxelObject,
    physicsWorld: PhysicsWorld,
    parentGroup: THREE.Object3D
): void {
    const startY = fragment.position.y;
    let velocityY = 0;

    const onPhysicsStep = () => {
        // Fragment was disposed
        if (!fragment.parent) {
            physicsWorld.unregisterPostStepCallback(onPhysicsStep);
            return;
        }

        // Apply gravity manually (physics step is ~1/60s)
        const dt = 1 / 60;
        velocityY -= GRAVITY * dt;
        fragment.position.y += velocityY * dt;

        const fallDistance = startY - fragment.position.y;

        if (fallDistance >= MIN_FALL_CLEARANCE) {
            physicsWorld.unregisterPostStepCallback(onPhysicsStep);

            // NOW create physics body — fragment is clear of the stump
            fragment.createDynamicPhysicsBody(physicsWorld, 5);
            const body = fragment.getRigidBody();
            if (!body) return;

            // Transfer accumulated velocity to the physics body
            body.setLinvel({ x: 0, y: velocityY, z: 0 }, true);

            // Enable collision events on all colliders
            const colliders = fragment.getColliders();
            for (const c of colliders) {
                c.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
            }

            // Register shatter callback — first collision shatters the fragment
            registerShatterCallback(fragment, body, physicsWorld, parentGroup);
        }
    };

    physicsWorld.registerPostStepCallback(onPhysicsStep);
}

function registerShatterCallback(
    fragment: VoxelObject,
    body: RAPIER.RigidBody,
    physicsWorld: PhysicsWorld,
    parentGroup: THREE.Object3D
): void {
    let shattered = false;

    const onCollision = (contact: ContactInfo) => {
        if (shattered) return;
        shattered = true;

        const vel = body.linvel();
        const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);
        const impulseStrength = Math.max(2, speed * 0.8);

        // Use the contact point for the shatter center
        const shatterCenter = contact.contactPoint.lengthSq() > 0
            ? contact.contactPoint.clone()
            : new THREE.Vector3().setFromMatrixPosition(fragment.matrixWorld);

        // Compute bounding radius to cover the whole object
        const bounds = fragment.getBounds();
        let radius = 10;
        if (bounds) {
            const dx = bounds.maxX - bounds.minX;
            const dy = bounds.maxY - bounds.minY;
            const dz = bounds.maxZ - bounds.minZ;
            radius = Math.sqrt(dx * dx + dy * dy + dz * dz) * 0.6;
        }

        // Shatter into debris — no explosion graphics, just pieces scattering
        fragment.explodeAt(shatterCenter, radius, impulseStrength, impulseStrength * 0.3, parentGroup);

        // Clean up
        physicsWorld.unregisterCollisionCallback(body, onCollision);
        if (!fragment.isDestroyed()) {
            fragment.dispose();
            parentGroup.remove(fragment);
        }
    };

    physicsWorld.registerCollisionCallback(body, onCollision);
}

// ─── Chunk-based path ──────────────────────────────────────────────────────────

function checkChunkConnectivity(
    obj: VoxelObject,
    physicsWorld: PhysicsWorld,
    parentGroup: THREE.Object3D
): void {
    const voxels = obj.getVoxelData();
    if (voxels.length === 0) return;

    // Find minimum Y (ground level of the object)
    let minY = Infinity;
    const voxelSize = obj.getVoxelSize();
    for (const v of voxels) {
        if (v.y < minY) minY = v.y;
    }

    // Build a lookup set for fast neighbor checks
    const step = voxelSize;
    const keyOf = (x: number, y: number, z: number) =>
        `${Math.round(x / step)},${Math.round(y / step)},${Math.round(z / step)}`;

    const voxelMap = new Map<string, number>();
    for (let i = 0; i < voxels.length; i++) {
        voxelMap.set(keyOf(voxels[i]!.x, voxels[i]!.y, voxels[i]!.z), i);
    }

    // Flood-fill from ground voxels
    const connected = new Set<number>();
    const queue: number[] = [];
    const groundThreshold = minY + step * 0.5;

    for (let i = 0; i < voxels.length; i++) {
        if (voxels[i]!.y <= groundThreshold) {
            connected.add(i);
            queue.push(i);
        }
    }

    if (queue.length === 0) return;

    const dirs = [
        [step, 0, 0], [-step, 0, 0],
        [0, step, 0], [0, -step, 0],
        [0, 0, step], [0, 0, -step],
    ] as const;

    while (queue.length > 0) {
        const idx = queue.pop()!;
        const v = voxels[idx]!;

        for (const [dx, dy, dz] of dirs) {
            const neighborKey = keyOf(v.x + dx, v.y + dy, v.z + dz);
            const neighborIdx = voxelMap.get(neighborKey);
            if (neighborIdx !== undefined && !connected.has(neighborIdx)) {
                connected.add(neighborIdx);
                queue.push(neighborIdx);
            }
        }
    }

    if (connected.size === voxels.length) return;

    // Collect connected and disconnected voxel positions
    const connectedVoxels: typeof voxels = [];
    const disconnectedVoxels: typeof voxels = [];
    for (let i = 0; i < voxels.length; i++) {
        if (connected.has(i)) {
            connectedVoxels.push(voxels[i]!);
        } else {
            disconnectedVoxels.push(voxels[i]!);
        }
    }

    if (disconnectedVoxels.length === 0) return;

    // 1) Clone the FULL object to become the falling top part
    const fragment = new VoxelObject({ voxelSize, useAtlas: true, shadows: true });
    obj.cloneDataTo(fragment);

    // 2) Remove connected (bottom) voxels from clone → clone = top part only
    fragment.removeVoxelsAndRebuild(connectedVoxels);

    // 3) Remove disconnected (top) voxels from original → original = bottom stump
    obj.removeVoxelsAndRebuild(disconnectedVoxels);

    // 4) Position the clone at the exact same world transform
    const worldPos = new THREE.Vector3();
    obj.getWorldPosition(worldPos);
    const worldQuat = new THREE.Quaternion();
    obj.getWorldQuaternion(worldQuat);

    fragment.position.copy(worldPos);
    fragment.quaternion.copy(worldQuat);
    parentGroup.add(fragment);

    // 5) Start falling — NO physics body yet, gravity is applied manually
    startFallingFragment(fragment, physicsWorld, parentGroup);
}
