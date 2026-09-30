import RAPIER2D from '@dimforge/rapier2d-compat';
import * as THREE from 'three';
import { getRapier2D } from 'engine/physics/RapierPhysics2D.js';
import type { PhysicsWorld2D } from 'engine/physics/PhysicsWorld2D.js';
import type { VoxelObject, PhysicsBox } from 'engine/VoxelObject.js';
import { octreeLeafIntersectsSpherePivotLocal } from 'engine/VoxelOctreeRenderer.js';
import { CollisionGroup, CollisionMask, makeCollisionGroups } from 'engine/CollisionLayers.js';

export interface ZSlice {
    min: number;
    max: number;
}

const DEFAULT_Z_SLICE: ZSlice = { min: -0.5, max: 0.5 };

/** Leaf / voxel center in object local space (same convention as VoxelObject.explodeAtOctreeV2) */
const _leafCenterLocal = new THREE.Vector3();
const _blastWorld = new THREE.Vector3();
const _blastLocal = new THREE.Vector3();
const _invWorldMat = new THREE.Matrix4();
const _voxelWorld = new THREE.Vector3();

/** World-space explosion center for 2D gameplay (z defaults to gameplay plane). */
export type ExplosionWorldCenter2D = { x: number; y: number; z?: number };

export interface VoxelBody2D {
    body: RAPIER2D.RigidBody;
    colliders: RAPIER2D.Collider[];
    voxelObject: VoxelObject;
}

export interface Debris2D {
    body: RAPIER2D.RigidBody;
    mesh: THREE.Mesh;
    spawnTime: number;
    /** Random 0–1 offset that staggers when this piece starts shrinking. Assigned at spawn. */
    fadeOffset?: number;
}

/**
 * Project 3D greedy-merged physics boxes to 2D cuboid colliders on the X/Y plane.
 * Only boxes whose world-space Z extent overlaps the zSlice are included.
 * This allows gates/archways to be walked through and background objects to be non-collidable.
 *
 * @param zSlice World-space Z range to include (default [-0.5, +0.5])
 */
export function createVoxelColliders2D(
    voxelObj: VoxelObject,
    physicsWorld: PhysicsWorld2D,
    position: { x: number; y: number },
    collisionGroups?: number,
    zSlice?: ZSlice,
): VoxelBody2D {
    const R = getRapier2D();
    const groups = collisionGroups ?? makeCollisionGroups(CollisionGroup.ENVIRONMENT, CollisionMask.ENVIRONMENT);

    const bodyDesc = R.RigidBodyDesc.fixed().setTranslation(position.x, position.y);
    const body = physicsWorld.createRigidBody(bodyDesc);
    physicsWorld.setUserData(body, { voxelObject: voxelObj });

    const colliders = attachVoxelColliders(voxelObj, physicsWorld, body, groups, zSlice);

    return { body, colliders, voxelObject: voxelObj };
}

/**
 * Remove all colliders from a body and re-create them from the VoxelObject's
 * current voxel data. Call after removing voxels (e.g. after an explosion).
 * Returns the new collider set, or null if the object has no voxels left.
 */
export function rebuildVoxelColliders2D(
    voxelBody: VoxelBody2D,
    physicsWorld: PhysicsWorld2D,
    collisionGroups?: number,
    zSlice?: ZSlice,
): RAPIER2D.Collider[] | null {
    for (const c of voxelBody.colliders) {
        if (c.isValid()) physicsWorld.removeColliderImmediate(c);
    }
    voxelBody.colliders = [];

    if (voxelBody.voxelObject.getVoxelCount() === 0) {
        if (voxelBody.body.isValid()) {
            physicsWorld.removeRigidBodyImmediate(voxelBody.body);
        }
        return null;
    }

    const groups = collisionGroups ?? makeCollisionGroups(CollisionGroup.ENVIRONMENT, CollisionMask.ENVIRONMENT);
    voxelBody.colliders = attachVoxelColliders(voxelBody.voxelObject, physicsWorld, voxelBody.body, groups, zSlice);
    return voxelBody.colliders;
}

/**
 * Explode a VoxelObject in 2D: remove voxels within a **3D** sphere (radius in world units),
 * rebuild mesh and 2D colliders, spawn debris bodies. Z is included so a hit on the Z=0
 * slice does not carve the entire depth of the model.
 *
 * @returns Array of debris pieces for the caller to track and sync each frame.
 */
export function explodeVoxelObject2D(
    voxelBody: VoxelBody2D,
    worldCenter: ExplosionWorldCenter2D,
    radius: number,
    physicsWorld: PhysicsWorld2D,
    scene: THREE.Scene,
    impulseStrength: number = 5,
    collisionGroups?: number,
    zSlice?: ZSlice,
): Debris2D[] {
    const voxelObj = voxelBody.voxelObject;
    if (voxelObj.isDestroyed()) return [];

    const groups = collisionGroups ?? makeCollisionGroups(CollisionGroup.ENVIRONMENT, CollisionMask.ENVIRONMENT);

    const radiusSq = radius * radius;

    voxelObj.updateMatrixWorld(true);
    _blastWorld.set(worldCenter.x, worldCenter.y, worldCenter.z ?? 0);
    _invWorldMat.copy(voxelObj.matrixWorld).invert();
    _blastLocal.copy(_blastWorld).applyMatrix4(_invWorldMat);

    // Octree V2 .vxl assets keep voxels in octreeLeaves only — getVoxelData() is empty.
    if (voxelObj.isOctreeV2 && voxelObj.getOctreeLeaves()?.length) {
        return explodeVoxelObject2DOctree(
            voxelBody,
            worldCenter,
            physicsWorld,
            scene,
            impulseStrength,
            groups,
            zSlice,
            radiusSq,
        );
    }

    const allVoxels = voxelObj.getVoxelData();
    const toRemove: Array<{ localX: number; localY: number; localZ: number }> = [];
    const hitVoxels: Array<{ x: number; y: number; z: number }> = [];

    for (const v of allVoxels) {
        const dx = v.x - _blastLocal.x;
        const dy = v.y - _blastLocal.y;
        const dz = v.z - _blastLocal.z;
        if (dx * dx + dy * dy + dz * dz > radiusSq) continue;

        toRemove.push({ localX: v.x, localY: v.y, localZ: v.z });

        _voxelWorld.set(v.x, v.y, v.z);
        voxelObj.localToWorld(_voxelWorld);
        hitVoxels.push({ x: _voxelWorld.x, y: _voxelWorld.y, z: _voxelWorld.z });
    }

    if (toRemove.length === 0) return [];

    const debris = spawnDebris2D(hitVoxels, worldCenter, physicsWorld, scene, impulseStrength, voxelObj.getVoxelSize());

    voxelObj.removeVoxelsBatch(toRemove);

    rebuildVoxelColliders2D(voxelBody, physicsWorld, groups, zSlice);

    return debris;
}

/**
 * 2D explosion for Octree V2 VoxelObjects (catalog .vxl). Voxel data lives in octree leaves, not chunks.
 */
function explodeVoxelObject2DOctree(
    voxelBody: VoxelBody2D,
    worldCenter: ExplosionWorldCenter2D,
    physicsWorld: PhysicsWorld2D,
    scene: THREE.Scene,
    impulseStrength: number,
    groups: number,
    zSlice: ZSlice | undefined,
    radiusSq: number,
): Debris2D[] {
    const voxelObj = voxelBody.voxelObject;
    const leaves = voxelObj.getOctreeLeaves();
    if (!leaves?.length) return [];

    const pivot = voxelObj.getPivot();
    const pivotX = pivot?.x ?? 0;
    const pivotY = pivot?.y ?? 0;
    const pivotZ = pivot?.z ?? 0;

    const toRemove = new Set<number>();
    const hitVoxels: Array<{ x: number; y: number; z: number }> = [];

    for (let i = 0; i < leaves.length; i++) {
        const leaf = leaves[i]!;
        if (
            !octreeLeafIntersectsSpherePivotLocal(
                leaf,
                pivotX,
                pivotY,
                pivotZ,
                _blastLocal.x,
                _blastLocal.y,
                _blastLocal.z,
                radiusSq,
            )
        ) {
            continue;
        }

        const lcx = leaf.x + leaf.size * 0.5 - pivotX;
        const lcy = leaf.y + leaf.size * 0.5 - pivotY;
        const lcz = leaf.z + leaf.size * 0.5 - pivotZ;

        toRemove.add(i);

        _leafCenterLocal.set(lcx, lcy, lcz);
        voxelObj.localToWorld(_leafCenterLocal);
        hitVoxels.push({
            x: _leafCenterLocal.x,
            y: _leafCenterLocal.y,
            z: _leafCenterLocal.z,
        });
    }

    if (toRemove.size === 0) return [];

    const debris = spawnDebris2D(
        hitVoxels,
        worldCenter,
        physicsWorld,
        scene,
        impulseStrength,
        voxelObj.getVoxelSize(),
    );

    voxelObj.removeOctreeLeavesByIndex(toRemove);
    rebuildVoxelColliders2D(voxelBody, physicsWorld, groups, zSlice);

    return debris;
}

/**
 * Apply blast impulse to **existing** 2D debris already in `debris` (not newly spawned this frame).
 * Mirrors VoxelDebrisManager.explodeDebrisInRadius for voxel explosions. Call before appending
 * debris from `explodeVoxelObject2D` so new shards only get spawn impulses.
 */
export function applyExplosionImpulseToDebris2D(
    debris: Debris2D[],
    centerX: number,
    centerY: number,
    radius: number,
    impulseStrength: number,
): void {
    const r2 = radius * radius;
    for (const d of debris) {
        if (!d.body.isValid()) continue;
        const p = d.body.translation();
        const dx = p.x - centerX;
        const dy = p.y - centerY;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2 || d2 < 1e-10) continue;
        const dist = Math.sqrt(d2);
        const nx = dx / dist;
        const ny = dy / dist;
        const falloff = 1 - d2 / r2;
        const mag = impulseStrength * falloff * 0.065;
        d.body.applyImpulse(
            { x: nx * mag, y: ny * mag + impulseStrength * falloff * 0.012 },
            true,
        );
    }
}

const FOOT_DEBRIS_RADIUS = 0.55;
const FOOT_DEBRIS_SPEED_THRESH = 0.12;
const FOOT_DEBRIS_PUSH = 0.055;

/**
 * Nudge nearby Physics2D debris while moving (used when debris does not collide with the player).
 */
export function applyFootKickDebris2D(
    debris: Debris2D[],
    feetX: number,
    feetY: number,
    velocityX: number,
    deltaTime: number,
): void {
    const speed = Math.abs(velocityX);
    if (speed < FOOT_DEBRIS_SPEED_THRESH) return;

    const rsq = FOOT_DEBRIS_RADIUS * FOOT_DEBRIS_RADIUS;
    const dirX = Math.sign(velocityX);
    const dtScale = Math.min(2.5, deltaTime * 60);
    const base = FOOT_DEBRIS_PUSH * (speed / 6.5) * dtScale;

    for (const d of debris) {
        if (!d.body.isValid()) continue;
        const p = d.body.translation();
        const dx = p.x - feetX;
        const dy = p.y - feetY;
        const d2 = dx * dx + dy * dy;
        if (d2 > rsq || d2 < 1e-8) continue;
        const falloff = 1 - d2 / rsq;
        const dist = Math.sqrt(d2);
        const nx = dx / dist;
        const ny = dy / dist;
        const ix = (dirX * 0.62 + nx * 0.38) * base * falloff;
        const iy = (ny * 0.45 + 0.12) * base * falloff;
        d.body.applyImpulse({ x: ix, y: iy }, true);
    }
}

/**
 * Sync all debris meshes with their physics bodies. Call every frame.
 * Automatically removes debris that have lived past maxLifetime or fallen below minY.
 * Returns the filtered array (still-alive debris).
 */
export function updateDebris2D(
    debris: Debris2D[],
    physicsWorld: PhysicsWorld2D,
    scene: THREE.Scene,
    maxLifetime: number = 4000,
    minY: number = -50,
): Debris2D[] {
    const now = performance.now();
    const alive: Debris2D[] = [];

    // Staggered shrink: pieces start shrinking at different times across
    // the last SHRINK_WINDOW_RATIO of their lifetime, spread by fadeOffset.
    const SHRINK_WINDOW_RATIO = 0.5;
    const shrinkWindow = maxLifetime * SHRINK_WINDOW_RATIO;
    const staggerSpread = shrinkWindow * 0.6;

    for (const d of debris) {
        if (!d.body.isValid()) {
            scene.remove(d.mesh);
            d.mesh.geometry.dispose();
            (d.mesh.material as THREE.Material).dispose();
            continue;
        }

        if (d.fadeOffset === undefined) d.fadeOffset = Math.random();

        const age = now - d.spawnTime;
        const pos = d.body.translation();

        const pieceShrinkStart = (maxLifetime - shrinkWindow) + d.fadeOffset * staggerSpread;
        const pieceShrinkEnd = pieceShrinkStart + (shrinkWindow - d.fadeOffset * staggerSpread);
        const isDone = age > pieceShrinkEnd || pos.y < minY;

        if (isDone) {
            scene.remove(d.mesh);
            d.mesh.geometry.dispose();
            (d.mesh.material as THREE.Material).dispose();
            physicsWorld.removeRigidBodyImmediate(d.body);
            continue;
        }

        const rot = d.body.rotation();
        d.mesh.position.set(pos.x, pos.y, 0);
        d.mesh.rotation.z = rot;

        if (age > pieceShrinkStart) {
            const t = (age - pieceShrinkStart) / (pieceShrinkEnd - pieceShrinkStart);
            const scale = 1 - t;
            d.mesh.scale.setScalar(scale);
            (d.mesh.material as THREE.MeshLambertMaterial).opacity = scale;
        }

        alive.push(d);
    }

    return alive;
}

const _boxCenter = new THREE.Vector3();

/**
 * Projects 3D physics boxes to 2D cuboid colliders, filtering by a world-space
 * Z-slice. For each box, the center is transformed through the voxel object's
 * world rotation to compute the world-space Z range. Only boxes whose Z range
 * overlaps the slice are included as 2D colliders.
 */
function attachVoxelColliders(
    voxelObj: VoxelObject,
    physicsWorld: PhysicsWorld2D,
    body: RAPIER2D.RigidBody,
    groups: number,
    zSlice?: ZSlice,
): RAPIER2D.Collider[] {
    const R = getRapier2D();
    const boxes: PhysicsBox[] = voxelObj.getPhysicsBoxes();
    const colliders: RAPIER2D.Collider[] = [];
    const slice = zSlice ?? DEFAULT_Z_SLICE;

    voxelObj.updateMatrixWorld(true);
    const bodyOrigin = body.translation();

    for (const box of boxes) {
        _boxCenter.set(box.cx, box.cy, box.cz);
        voxelObj.localToWorld(_boxCenter);

        const worldZ = _boxCenter.z;
        const zMin = worldZ - box.hz;
        const zMax = worldZ + box.hz;

        if (zMax < slice.min || zMin > slice.max) continue;

        // Collider translation is body-local; body sits at bodyOrigin in world space.
        const offsetX = _boxCenter.x - bodyOrigin.x;
        const offsetY = _boxCenter.y - bodyOrigin.y;

        const desc = R.ColliderDesc.cuboid(box.hx, box.hy)
            .setTranslation(offsetX, offsetY)
            .setFriction(0.7)
            .setRestitution(0.0)
            .setCollisionGroups(groups);
        colliders.push(physicsWorld.createCollider(desc, body));
    }

    return colliders;
}

function spawnDebris2D(
    positions: Array<{ x: number; y: number; z: number }>,
    blastCenter: { x: number; y: number },
    physicsWorld: PhysicsWorld2D,
    scene: THREE.Scene,
    impulseStrength: number,
    voxelSize: number,
): Debris2D[] {
    const R = getRapier2D();
    const debris: Debris2D[] = [];
    const now = performance.now();

    const maxDebris = 40;
    const step = Math.max(1, Math.ceil(positions.length / maxDebris));
    const debrisSize = Math.max(0.08, voxelSize * 0.4);
    const groups = makeCollisionGroups(CollisionGroup.DEBRIS, CollisionMask.DEBRIS_FILTER_PHYSICS2D);

    for (let i = 0; i < positions.length; i += step) {
        const p = positions[i]!;

        const dx = p.x - blastCenter.x;
        const dy = p.y - blastCenter.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.1;
        const nx = dx / dist;
        const ny = dy / dist;

        const bodyDesc = R.RigidBodyDesc.dynamic()
            .setTranslation(p.x, p.y)
            .setLinearDamping(2.8)
            .setAngularDamping(3.5);
        const body = physicsWorld.createRigidBody(bodyDesc);

        const colliderDesc = R.ColliderDesc.ball(debrisSize)
            .setMass(0.12)
            .setRestitution(0.15)
            .setFriction(0.55)
            .setCollisionGroups(groups)
            .setSolverGroups(groups);
        physicsWorld.createCollider(colliderDesc, body);

        const jitter = () => (Math.random() - 0.5) * 0.035;
        const impScale = 0.11;
        body.applyImpulse(
            {
                x: nx * impulseStrength * impScale + jitter(),
                y: ny * impulseStrength * impScale + Math.random() * impulseStrength * 0.045,
            },
            true,
        );
        body.setAngvel((Math.random() - 0.5) * 2.2, true);

        const shade = 0.3 + Math.random() * 0.4;
        const color = new THREE.Color(shade, shade * 0.85, shade * 0.6);
        const geometry = new THREE.BoxGeometry(debrisSize * 2, debrisSize * 2, debrisSize * 2);
        const material = new THREE.MeshLambertMaterial({ color, transparent: true, opacity: 1.0 });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(p.x, p.y, 0);
        mesh.castShadow = true;
        scene.add(mesh);

        debris.push({ body, mesh, spawnTime: now });
    }

    return debris;
}
