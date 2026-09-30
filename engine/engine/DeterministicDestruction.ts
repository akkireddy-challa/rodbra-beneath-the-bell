/**
 * Deterministic voxel destruction for networked multiplayer.
 *
 * The server detects a collision, converts the hit position to 16.16 fixed-point,
 * and broadcasts an explosion event with fixed-point parameters to all clients.
 * Every client runs the same deterministic logic to decide which voxels are
 * destroyed and what initial impulse each debris piece receives.
 *
 * Debris physics after the initial impulse is NOT synchronized — each client
 * simulates its own debris locally. Only the explosion parameters travel
 * over the network.
 *
 * Usage from template code:
 *
 *   // On the server / authority:
 *   const params = DeterministicDestruction.createExplosionParams(hitPos, radius, strength, upImpulse);
 *   networkManager.sendEvent('voxelExplosion', params as unknown as Record<string, unknown>);
 *
 *   // On every client (including server if it renders):
 *   DeterministicDestruction.explodeTerrainSphere(params, voxelWorld, physicsWorld, parentGroup);
 *   DeterministicDestruction.explodeVoxelObject(params, voxelObject, parentGroup, voxelWorld);
 */

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import {
    type Fixed16,
    type FpVec3,
    fpFromFloat,
    fpToFloat,
    fpAdd,
    fpSub,
    fpMul,
    fpDiv,
    fpSqrt,
    fpDistSq3,
    fpHorizDistSq,
    fpSin,
    fpCos,
    FP_ONE,
    FP_SCALE,
    FixedPointRng,
    explosionSeed,
} from 'engine/FixedPointMath.js';
import type { VoxelWorld } from 'engine/VoxelWorld.js';
import type { VoxelObject } from 'engine/VoxelObject.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';
import { CollisionGroup, CollisionMask, makeCollisionGroups } from 'engine/CollisionLayers.js';
import { VoxelDebrisManager, type VoxelDebris } from 'engine/VoxelDebrisManager.js';
import { voxelObjectDebris } from 'engine/VoxelObjectDebris.js';
import { getVoxelTextureAtlas } from 'engine/VoxelTextureAtlas.js';
import { getMaterialRegistry } from 'engine/MaterialRegistry.js';

// ─────────────────────────────────────────────────────────────────────────
// Network-serializable explosion parameters (all values are Q16.16 ints).
// ─────────────────────────────────────────────────────────────────────────

/**
 * Parameters that fully describe a deterministic explosion.
 * Serialize this over the network — all fields are plain numbers (integers).
 */
export interface DeterministicExplosionParams {
    /** Fixed-point center X */
    cx: Fixed16;
    /** Fixed-point center Y */
    cy: Fixed16;
    /** Fixed-point center Z */
    cz: Fixed16;
    /** Fixed-point blast radius */
    radius: Fixed16;
    /** Fixed-point outward impulse strength */
    impulseStrength: Fixed16;
    /** Fixed-point upward impulse component */
    impulseUp: Fixed16;
    /**
     * Monotonically increasing sequence number set by `createExplosionParams`.
     * Ensures debris IDs are unique even for repeated explosions at the
     * same position.  Included in network messages alongside the other fields.
     * Defaults to 0 when not provided (e.g. manually constructed params).
     */
    seq?: number;
}

// ─────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────

let explosionSeqCounter = 0;

const FP_POINT_ZERO_ONE = fpFromFloat(0.01);
const FP_POINT_SIX = fpFromFloat(0.6);
const FP_POINT_THREE = fpFromFloat(0.3);
const FP_POINT_FIVE = fpFromFloat(0.5);
const FP_EIGHT = fpFromFloat(8.0);
const FP_HALF = fpFromFloat(0.5);

const DEBRIS_COLLISION_GROUPS = makeCollisionGroups(CollisionGroup.DEBRIS, CollisionMask.DEBRIS);

/**
 * Compute a deterministic radial impulse for a debris piece.
 *
 * dx, dy, dz are the fixed-point offset from the explosion center.
 * When the piece is directly at the center (horizDist ≈ 0) we use the RNG
 * to pick a deterministic random angle instead of Math.random().
 */
function computeImpulse(
    dx: Fixed16, dy: Fixed16, dz: Fixed16,
    impulseStrength: Fixed16, impulseUp: Fixed16,
    rng: FixedPointRng,
): FpVec3 {
    const horizDistSq = fpHorizDistSq(dx, dz);
    let ix: Fixed16, iz: Fixed16;

    if (horizDistSq > fpMul(FP_POINT_ZERO_ONE, FP_POINT_ZERO_ONE)) {
        const horizDist = fpSqrt(horizDistSq);
        ix = fpDiv(fpMul(dx, impulseStrength), horizDist);
        iz = fpDiv(fpMul(dz, impulseStrength), horizDist);
    } else {
        const angle = rng.nextAngle();
        ix = fpMul(fpCos(angle), impulseStrength);
        iz = fpMul(fpSin(angle), impulseStrength);
    }

    const iy = fpAdd(impulseStrength, impulseUp);
    return { x: ix, y: iy, z: iz };
}

/**
 * Compute a deterministic offset position so debris doesn't spawn inside
 * the voxel's bounding box.  Returns a float position ready for Rapier.
 */
function offsetPosition(
    basePosX: Fixed16, basePosY: Fixed16, basePosZ: Fixed16,
    dx: Fixed16, dy: Fixed16, dz: Fixed16,
    voxelSizeFp: Fixed16,
): { x: number; y: number; z: number } {
    const offsetDist = fpMul(voxelSizeFp, FP_POINT_SIX);
    const dist = fpSqrt(fpDistSq3(dx, dy, dz));

    let px: Fixed16, py: Fixed16, pz: Fixed16;
    if (dist > FP_POINT_ZERO_ONE) {
        px = fpAdd(basePosX, fpDiv(fpMul(dx, offsetDist), dist));
        py = fpAdd(fpAdd(basePosY, fpDiv(fpMul(dy, offsetDist), dist)), fpMul(voxelSizeFp, FP_POINT_THREE));
        pz = fpAdd(basePosZ, fpDiv(fpMul(dz, offsetDist), dist));
    } else {
        px = basePosX;
        py = fpAdd(basePosY, offsetDist);
        pz = basePosZ;
    }

    return { x: fpToFloat(px), y: fpToFloat(py), z: fpToFloat(pz) };
}

interface DebrisColor { r: number; g: number; b: number }

/**
 * Derive a deterministic debris ID from an explosion seed, sequence number,
 * and per-piece index.  The `seq` field distinguishes repeated explosions at
 * the same position so that IDs never collide across explosions.
 */
function deterministicDebrisId(seed: number, seq: number, index: number): number {
    return ((seed + Math.imul(seq, 0x517CC1B7) + Math.imul(index, 0x9E3779B9)) >>> 0);
}

/**
 * Spawn a single debris rigid body with deterministic initial velocity.
 * The angular velocity is randomized from the seeded PRNG so it looks
 * good but is still reproducible.
 *
 * When `color` is provided (octree V2 leaves), uses per-instance colored
 * debris instead of atlas-textured debris.
 */
function spawnDebrisBody(
    pos: { x: number; y: number; z: number },
    impulse: FpVec3,
    halfSize: number,
    density: number,
    rng: FixedPointRng,
    physicsWorld: PhysicsWorld,
    blockType: number,
    voxelSize: number,
    parentGroup: THREE.Object3D,
    color?: DebrisColor,
    voxelWorld?: VoxelWorld,
    debrisId?: number,
): VoxelDebris {
    const angX = fpToFloat(fpMul(rng.nextFixed(), FP_EIGHT));
    const angY = fpToFloat(fpMul(rng.nextFixed(), FP_EIGHT));
    const angZ = fpToFloat(fpMul(rng.nextFixed(), FP_EIGHT));

    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(pos.x, pos.y, pos.z)
        .setLinvel(fpToFloat(impulse.x), fpToFloat(impulse.y), fpToFloat(impulse.z))
        .setAngvel({ x: angX, y: angY, z: angZ })
        .setLinearDamping(0.5)
        .setAngularDamping(0.8)
        .setCcdEnabled(true);

    const body = physicsWorld.createRigidBody(bodyDesc);
    const colDesc = RAPIER.ColliderDesc.cuboid(halfSize, halfSize, halfSize)
        .setCollisionGroups(DEBRIS_COLLISION_GROUPS)
        .setFriction(0.5)
        .setRestitution(0.6)
        .setDensity(density);
    const collider = physicsWorld.createCollider(colDesc, body);

    const userData: Record<string, unknown> = {
        createdAt: performance.now(),
        blockType,
        isVoxelDebris: true,
        density,
        debrisSize: voxelSize,
    };
    if (voxelWorld) userData.voxelWorld = voxelWorld;
    if (color) userData.color = color;
    physicsWorld.setUserData(body, userData);

    const id = debrisId ?? 0;

    if (color) {
        // Voxel-object debris (per-leaf RGB) lives in the unified
        // voxelObjectDebris registry — same path as
        // VoxelObject.explodeAt's non-deterministic spawns. The
        // deterministic `id` is preserved for network-sync freeze events
        // that the registry's authority will emit on settle.
        voxelObjectDebris.spawnVoxel(body, collider, physicsWorld, color.r, color.g, color.b, voxelSize, parentGroup, id);
    } else {
        // Terrain debris (atlas-textured by block type) stays in
        // VoxelDebrisManager — atlas pools are terrain-specific.
        VoxelDebrisManager.spawnDebris(body, collider, physicsWorld, blockType, voxelSize, parentGroup, id);
    }

    return { body, collider, id };
}

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

export const DeterministicDestruction = {

    // ── Parameter creation ──────────────────────────────────────────────

    /**
     * Convert floating-point hit coordinates into a deterministic explosion
     * parameter object suitable for network transmission.
     *
     * Call this on the server/authority when a projectile collision is detected.
     */
    createExplosionParams(
        center: { x: number; y: number; z: number },
        radius: number,
        impulseStrength: number = 5,
        impulseUp: number = 2,
    ): DeterministicExplosionParams {
        return {
            cx: fpFromFloat(center.x),
            cy: fpFromFloat(center.y),
            cz: fpFromFloat(center.z),
            radius: fpFromFloat(radius),
            impulseStrength: fpFromFloat(impulseStrength),
            impulseUp: fpFromFloat(impulseUp),
            seq: explosionSeqCounter++,
        };
    },

    // ── Terrain (VoxelWorld) destruction ─────────────────────────────────

    /**
     * Deterministically destroy terrain blocks within a sphere.
     *
     * The sphere test and impulse computation use fixed-point math so that
     * all clients produce the same set of removed blocks and the same
     * initial debris velocities.
     *
     * @returns Array of debris { body, collider } for the caller to track.
     */
    explodeTerrainSphere(
        params: DeterministicExplosionParams,
        voxelWorld: VoxelWorld,
        physicsWorld: PhysicsWorld,
        parentGroup: THREE.Object3D,
    ): VoxelDebris[] {
        const { cx, cy, cz, radius, impulseStrength, impulseUp } = params;
        const rng = new FixedPointRng(explosionSeed(cx, cy, cz, radius));

        const radiusSq = fpMul(radius, radius);

        // Convert fixed-point center/radius to float for the voxel grid scan.
        // The grid iteration itself uses the world's voxelSize stepping which
        // is identical on all clients, so we only need FP for the sphere test
        // and impulse calculation.
        const centerXf = fpToFloat(cx);
        const centerYf = fpToFloat(cy);
        const centerZf = fpToFloat(cz);
        const radiusF = fpToFloat(radius);

        const voxelSize = voxelWorld.getVoxelSize();
        const voxelSizeFp = fpFromFloat(voxelSize);
        const halfSizeFp = fpMul(voxelSizeFp, FP_HALF);
        const halfSize = voxelSize / 2;

        const atlas = getVoxelTextureAtlas();

        // Snap scan bounds to voxel grid
        const minX = Math.floor((centerXf - radiusF) / voxelSize) * voxelSize;
        const maxX = Math.ceil((centerXf + radiusF) / voxelSize) * voxelSize;
        const minY = Math.floor((centerYf - radiusF) / voxelSize) * voxelSize;
        const maxY = Math.ceil((centerYf + radiusF) / voxelSize) * voxelSize;
        const minZ = Math.floor((centerZf - radiusF) / voxelSize) * voxelSize;
        const maxZ = Math.ceil((centerZf + radiusF) / voxelSize) * voxelSize;

        // Phase 1: Collect blocks to destroy using fixed-point sphere test.
        // We iterate in a deterministic order (X → Y → Z, ascending) and
        // convert each voxel center to fixed-point for the distance check.
        interface BlockHit {
            x: number; y: number; z: number;
            blockType: number;
            fpCenterX: Fixed16; fpCenterY: Fixed16; fpCenterZ: Fixed16;
        }
        const hits: BlockHit[] = [];

        for (let x = minX; x <= maxX; x += voxelSize) {
            for (let y = minY; y <= maxY; y += voxelSize) {
                for (let z = minZ; z <= maxZ; z += voxelSize) {
                    const blockType = voxelWorld.getBlock(x, y, z);
                    if (blockType === 0 || atlas.isFluidBlock(blockType)) continue;

                    const vcx = fpFromFloat(x) + halfSizeFp;
                    const vcy = fpFromFloat(y) + halfSizeFp;
                    const vcz = fpFromFloat(z) + halfSizeFp;

                    const dx = fpSub(vcx, cx);
                    const dy = fpSub(vcy, cy);
                    const dz = fpSub(vcz, cz);
                    const dSq = fpDistSq3(dx, dy, dz);

                    if (dSq <= radiusSq) {
                        hits.push({ x, y, z, blockType, fpCenterX: vcx, fpCenterY: vcy, fpCenterZ: vcz });
                    }
                }
            }
        }

        // Always re-blast existing debris (active or settled) in the radius,
        // even when no terrain blocks are hit (e.g. floating debris above
        // ground). VoxelDebrisManager.explodeDebrisInRadius fans out to
        // voxelObjectDebris.pushInRadius internally, so this one call
        // covers both terrain and voxel-object debris.
        const center = new THREE.Vector3(centerXf, centerYf, centerZf);
        VoxelDebrisManager.explodeDebrisInRadius(
            center, radiusF,
            fpToFloat(impulseStrength), fpToFloat(impulseUp),
        );

        if (hits.length === 0) return [];

        // Phase 2: Remove blocks from the world.
        voxelWorld.beginBatchUpdate();
        for (const hit of hits) {
            voxelWorld.setBlock(hit.x, hit.y, hit.z, 0);
        }
        voxelWorld.endBatchUpdate();

        // Phase 3: Spawn debris with deterministic impulses and IDs.
        const seed = explosionSeed(cx, cy, cz, radius);
        const debris: VoxelDebris[] = [];
        for (let i = 0; i < hits.length; i++) {
            const hit = hits[i]!;
            const dx = fpSub(hit.fpCenterX, cx);
            const dy = fpSub(hit.fpCenterY, cy);
            const dz = fpSub(hit.fpCenterZ, cz);

            const impulse = computeImpulse(dx, dy, dz, impulseStrength, impulseUp, rng);
            const pos = offsetPosition(hit.fpCenterX, hit.fpCenterY, hit.fpCenterZ, dx, dy, dz, voxelSizeFp);

            const materialId = atlas.getBlockMaterial(hit.blockType);
            const density = materialId !== undefined ? getMaterialRegistry().getDensity(materialId) : 2000;

            debris.push(spawnDebrisBody(
                pos, impulse, halfSize, density, rng, physicsWorld,
                hit.blockType, voxelSize, parentGroup,
                undefined, voxelWorld,
                deterministicDebrisId(seed, params.seq ?? 0, i),
            ));
        }

        return debris;
    },

    // ── Voxel object destruction ────────────────────────────────────────

    /**
     * Deterministically destroy voxels within a sphere on a VoxelObject.
     *
     * Handles all VoxelObject types transparently — chunk-based objects
     * (from VoxelObjectBuilder.create), octree V2 objects (loaded from .vxl
     * files), or any future format. Template code never needs to check the
     * internal representation; this single call does the right thing.
     *
     * @param voxelWorld Optional terrain VoxelWorld for debris consolidation.
     *   When provided, settled debris merges into terrain as real blocks with
     *   colliders, and can be re-destroyed by future explosions.
     * @param mergeBlockType Block type used when merging colored debris into
     *   terrain (default 1). Ignored for chunk-based objects which use their
     *   original block types.
     * @returns Array of debris { body, collider }.
     */
    explodeVoxelObject(
        params: DeterministicExplosionParams,
        voxelObject: VoxelObject,
        parentGroup?: THREE.Object3D,
        voxelWorld?: VoxelWorld,
        mergeBlockType?: number,
    ): VoxelDebris[] {
        const pw = voxelObject.getPhysicsWorld();
        if (!pw) {
            console.warn('DeterministicDestruction.explodeVoxelObject: no physics world');
            return [];
        }

        // Push any already-detached voxel-object fragments inside the blast.
        // World-space center comes straight from `params`; the impulse only
        // wakes / shoves the body, no further destruction happens.
        voxelObjectDebris.pushInRadius(
            new THREE.Vector3(fpToFloat(params.cx), fpToFloat(params.cy), fpToFloat(params.cz)),
            fpToFloat(params.radius),
            fpToFloat(params.impulseStrength),
            fpToFloat(params.impulseUp),
        );

        if (voxelObject.isOctreeV2 && voxelObject.getOctreeLeaves()) {
            return explodeOctreeV2(params, voxelObject, pw, parentGroup, voxelWorld, mergeBlockType);
        }

        return explodeChunks(params, voxelObject, pw, parentGroup, voxelWorld);
    },
};

// ─────────────────────────────────────────────────────────────────────────
// Internal: chunk-based VoxelObject explosion (programmatically built)
// ─────────────────────────────────────────────────────────────────────────

function explodeChunks(
    params: DeterministicExplosionParams,
    voxelObject: VoxelObject,
    pw: PhysicsWorld,
    parentGroup?: THREE.Object3D,
    voxelWorld?: VoxelWorld,
): VoxelDebris[] {
    const { cx, cy, cz, radius, impulseStrength, impulseUp } = params;
    const rng = new FixedPointRng(explosionSeed(cx, cy, cz, radius));
    const radiusSq = fpMul(radius, radius);

    const objectWorldPos = new THREE.Vector3();
    voxelObject.getWorldPosition(objectWorldPos);
    const objectWorldQuat = new THREE.Quaternion();
    voxelObject.getWorldQuaternion(objectWorldQuat);
    const inverseQuat = objectWorldQuat.clone().invert();

    const localCenterFloat = new THREE.Vector3(
        fpToFloat(cx), fpToFloat(cy), fpToFloat(cz),
    ).sub(objectWorldPos).applyQuaternion(inverseQuat);

    const lcx = fpFromFloat(localCenterFloat.x);
    const lcy = fpFromFloat(localCenterFloat.y);
    const lcz = fpFromFloat(localCenterFloat.z);

    const voxelSize = voxelObject.getVoxelSize();
    const voxelSizeFp = fpFromFloat(voxelSize);
    const halfSize = voxelSize / 2;
    const atlas = getVoxelTextureAtlas();

    const allVoxels = voxelObject.getVoxelData();

    interface VoxelHit {
        localX: number; localY: number; localZ: number;
        blockType: number;
        fpX: Fixed16; fpY: Fixed16; fpZ: Fixed16;
    }
    const hits: VoxelHit[] = [];

    for (const voxel of allVoxels) {
        const fpX = fpFromFloat(voxel.x);
        const fpY = fpFromFloat(voxel.y);
        const fpZ = fpFromFloat(voxel.z);

        const dx = fpSub(fpX, lcx);
        const dy = fpSub(fpY, lcy);
        const dz = fpSub(fpZ, lcz);

        if (fpDistSq3(dx, dy, dz) <= radiusSq) {
            hits.push({ localX: voxel.x, localY: voxel.y, localZ: voxel.z,
                blockType: voxel.blockType, fpX, fpY, fpZ });
        }
    }

    if (hits.length === 0) return [];

    const seed = explosionSeed(cx, cy, cz, radius);
    const resolvedParent = parentGroup ?? voxelObject.parent ?? undefined;
    const debris: VoxelDebris[] = [];

    for (let i = 0; i < hits.length; i++) {
        const hit = hits[i]!;
        const dx = fpSub(hit.fpX, lcx);
        const dy = fpSub(hit.fpY, lcy);
        const dz = fpSub(hit.fpZ, lcz);

        const impulse = computeImpulse(dx, dy, dz, impulseStrength, impulseUp, rng);
        const localPos = offsetPosition(hit.fpX, hit.fpY, hit.fpZ, dx, dy, dz, voxelSizeFp);

        const worldPos = new THREE.Vector3(localPos.x, localPos.y, localPos.z)
            .applyQuaternion(objectWorldQuat).add(objectWorldPos);
        const impulseWorld = new THREE.Vector3(
            fpToFloat(impulse.x), fpToFloat(impulse.y), fpToFloat(impulse.z),
        ).applyQuaternion(objectWorldQuat);
        const impulseWorldFp: FpVec3 = {
            x: fpFromFloat(impulseWorld.x),
            y: fpFromFloat(impulseWorld.y),
            z: fpFromFloat(impulseWorld.z),
        };

        const materialId = atlas.getBlockMaterial(hit.blockType);
        const density = materialId !== undefined ? getMaterialRegistry().getDensity(materialId) : 600;

        if (resolvedParent) {
            debris.push(spawnDebrisBody(
                worldPos, impulseWorldFp, halfSize, density, rng, pw,
                hit.blockType, voxelSize, resolvedParent,
                undefined, voxelWorld,
                deterministicDebrisId(seed, params.seq ?? 0, i),
            ));
        }
    }

    voxelObject.removeVoxelsBatch(hits.map(h => ({
        localX: h.localX, localY: h.localY, localZ: h.localZ,
    })));

    return debris;
}

// ─────────────────────────────────────────────────────────────────────────
// Internal: octree V2 VoxelObject explosion (file-loaded .vxl assets)
// ─────────────────────────────────────────────────────────────────────────

function explodeOctreeV2(
    params: DeterministicExplosionParams,
    voxelObject: VoxelObject,
    pw: PhysicsWorld,
    parentGroup?: THREE.Object3D,
    voxelWorld?: VoxelWorld,
    mergeBlockType?: number,
): VoxelDebris[] {
    const { cx, cy, cz, radius, impulseStrength, impulseUp } = params;
    const rng = new FixedPointRng(explosionSeed(cx, cy, cz, radius));
    const radiusSq = fpMul(radius, radius);

    const objectWorldPos = new THREE.Vector3();
    voxelObject.getWorldPosition(objectWorldPos);
    const objectWorldQuat = new THREE.Quaternion();
    voxelObject.getWorldQuaternion(objectWorldQuat);
    const inverseQuat = objectWorldQuat.clone().invert();

    const localCenterFloat = new THREE.Vector3(
        fpToFloat(cx), fpToFloat(cy), fpToFloat(cz),
    ).sub(objectWorldPos).applyQuaternion(inverseQuat);

    const lcx = fpFromFloat(localCenterFloat.x);
    const lcy = fpFromFloat(localCenterFloat.y);
    const lcz = fpFromFloat(localCenterFloat.z);

    const pivot = voxelObject.getPivot();
    const pivotX = pivot?.x ?? 0;
    const pivotY = pivot?.y ?? 0;
    const pivotZ = pivot?.z ?? 0;

    const seed = explosionSeed(cx, cy, cz, radius);
    const leaves = voxelObject.getOctreeLeaves()!;
    const toRemove = new Set<number>();
    const resolvedParent = parentGroup ?? voxelObject.parent ?? undefined;
    const debris: VoxelDebris[] = [];
    let debrisIndex = 0;

    for (let i = 0; i < leaves.length; i++) {
        const leaf = leaves[i]!;
        const lcxLeaf = leaf.x + leaf.size * 0.5 - pivotX;
        const lcyLeaf = leaf.y + leaf.size * 0.5 - pivotY;
        const lczLeaf = leaf.z + leaf.size * 0.5 - pivotZ;

        const fpX = fpFromFloat(lcxLeaf);
        const fpY = fpFromFloat(lcyLeaf);
        const fpZ = fpFromFloat(lczLeaf);

        const dx = fpSub(fpX, lcx);
        const dy = fpSub(fpY, lcy);
        const dz = fpSub(fpZ, lcz);

        if (fpDistSq3(dx, dy, dz) > radiusSq) continue;

        toRemove.add(i);

        const leafSizeFp = fpFromFloat(leaf.size);
        const impulse = computeImpulse(dx, dy, dz, impulseStrength, impulseUp, rng);
        const localPos = offsetPosition(fpX, fpY, fpZ, dx, dy, dz, leafSizeFp);

        const worldPos = new THREE.Vector3(localPos.x, localPos.y, localPos.z)
            .applyQuaternion(objectWorldQuat).add(objectWorldPos);
        const impulseWorld = new THREE.Vector3(
            fpToFloat(impulse.x), fpToFloat(impulse.y), fpToFloat(impulse.z),
        ).applyQuaternion(objectWorldQuat);
        const impulseWorldFp: FpVec3 = {
            x: fpFromFloat(impulseWorld.x),
            y: fpFromFloat(impulseWorld.y),
            z: fpFromFloat(impulseWorld.z),
        };

        const halfSize = leaf.size / 2;

        if (resolvedParent) {
            debris.push(spawnDebrisBody(
                worldPos, impulseWorldFp, halfSize, 600, rng, pw,
                mergeBlockType ?? 1, leaf.size, resolvedParent,
                { r: leaf.r, g: leaf.g, b: leaf.b },
                voxelWorld,
                deterministicDebrisId(seed, params.seq ?? 0, debrisIndex),
            ));
            debrisIndex++;
        }
    }

    if (toRemove.size === 0) return [];

    voxelObject.removeOctreeLeavesByIndex(toRemove);

    return debris;
}
